// Minimal OTLP/HTTP JSON log exporter over fetch: bounded queue, batching,
// gzip, Bearer auth, retries with backoff on 408/429/5xx and network errors
// (honoring Retry-After), one request in flight, a deadline on shutdown.
// It never throws into its caller; each failure kind is logged once.

import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);
const SEVERITY = { info: [9, 'INFO'], warn: [13, 'WARN'], error: [17, 'ERROR'] };

export const EXPORTER_DEFAULTS = Object.freeze({
  maxQueue: 8192,        // records waiting; newer records are dropped beyond it
  maxBatch: 512,         // records per request
  delayMs: 2000,         // batching delay after the first queued record
  maxAttempts: 6,        // per batch, including the first
  baseBackoffMs: 500,
  maxBackoffMs: 30_000,
  maxRetryAfterMs: 60_000,
  timeoutMs: 10_000,     // per request
  shutdownMs: 3000,      // total budget of the final flush
});

function anyValue(v) {
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  return { stringValue: String(v) };
}
const keyValues = attrs => Object.entries(attrs).filter(([, v]) => v !== undefined && v !== null).map(([key, v]) => ({ key, value: anyValue(v) }));
const nanos = ms => (BigInt(Math.trunc(ms)) * 1000000n).toString();

export function logRecord(r) {
  const [severityNumber, severityText] = SEVERITY[r.severity] ?? SEVERITY.info;
  return { timeUnixNano: nanos(r.time), severityNumber, severityText, eventName: r.name, body: { stringValue: r.name }, attributes: keyValues(r.attributes) };
}

export function exportRequest(records, { resource, scope }) {
  return { resourceLogs: [{ resource: { attributes: keyValues(resource) }, scopeLogs: [{ scope, logRecords: records.map(logRecord) }] }] };
}

// Retry-After: delay seconds or an HTTP date → ms, capped; undefined when absent or invalid.
export function retryAfterMs(value, cap, now = Date.now()) {
  if (value === null || value === undefined || value === '') return undefined;
  const s = String(value).trim();
  const ms = /^\d+$/.test(s) ? Number(s) * 1000 : Date.parse(s) - now;
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), cap) : undefined;
}

const RETRYABLE = status => status === 408 || status === 429 || status >= 500;

/**
 * @param {object} o
 * @param {string} o.endpoint full OTLP logs URL (…/v1/logs)
 * @param {string|(() => string|undefined)} o.apiKey TokenRouter API Key, sent as Authorization: Bearer; a function
 *   when the Key becomes known later (records wait in the queue until it returns one)
 * @param {object} o.resource resource attributes
 * @param {{name: string, version: string}} o.scope
 * @param {{warn: Function}} [o.logger]
 */
export function createExporter({ endpoint, apiKey, resource = {}, scope, logger, fetch: fetchImpl = globalThis.fetch, random = Math.random,
  setTimer = setTimeout, clearTimer = clearTimeout, ...options }) {
  const o = { ...EXPORTER_DEFAULTS, ...options };
  const keyOf = () => typeof apiKey === 'function' ? apiKey() : apiKey;
  const queue = [];
  const warned = new Set();
  const abort = new AbortController();
  const stats = { queued: 0, sent: 0, dropped: 0, rejected: 0, requests: 0, retries: 0 };
  let timer = null, draining = null, closed = false;

  const warnOnce = (kind, message) => {
    if (warned.has(kind)) return;
    warned.add(kind);
    try { logger?.warn?.('tokenrouter-dsh-telemetry: ' + message); } catch { /* a logger failure stays here */ }
  };
  const sleep = ms => new Promise(resolve => {
    if (abort.signal.aborted) return resolve();
    const t = setTimer(done, ms);
    t?.unref?.();
    function done() { abort.signal.removeEventListener('abort', done); clearTimer(t); resolve(); }
    abort.signal.addEventListener('abort', done, { once: true });
  });
  const backoff = attempt => Math.min(o.maxBackoffMs, o.baseBackoffMs * 2 ** (attempt - 1)) * (0.75 + random() * 0.5);

  // → true when the batch is settled (accepted or dropped), false only when aborted.
  async function send(batch) {
    let body;
    try { body = await gzipAsync(JSON.stringify(exportRequest(batch, { resource, scope }))); } catch (error) {
      warnOnce('encode', 'could not encode a batch: ' + String(error?.message ?? error)); stats.dropped += batch.length; return true;
    }
    for (let attempt = 1; ; attempt++) {
      if (abort.signal.aborted) return false;
      let wait;
      try {
        stats.requests++;
        const res = await fetchImpl(endpoint, {
          method: 'POST', body,
          headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', authorization: 'Bearer ' + keyOf() },
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(o.timeoutMs)]),
        });
        const reply = await res.text().catch(() => '');
        if (res.ok) {
          stats.sent += batch.length;
          let rejected = 0, message = '';
          try { const p = JSON.parse(reply)?.partialSuccess; rejected = Number(p?.rejectedLogRecords ?? 0); message = String(p?.errorMessage ?? ''); } catch { /* empty body */ }
          if (rejected > 0) { stats.rejected += rejected; warnOnce('partial', `the receiver rejected ${rejected} record(s): ${message.slice(0, 200)}`); }
          return true;
        }
        if (!RETRYABLE(res.status)) {
          stats.dropped += batch.length;
          warnOnce('http-' + res.status, res.status === 401 || res.status === 403
            ? `the receiver refused the API Key (HTTP ${res.status}); check TOKENROUTER_API_KEY`
            : `the receiver answered HTTP ${res.status}; records dropped`);
          return true;
        }
        wait = retryAfterMs(res.headers?.get?.('retry-after'), o.maxRetryAfterMs) ?? backoff(attempt);
        if (attempt >= o.maxAttempts) warnOnce('retry-' + res.status, `the receiver kept answering HTTP ${res.status}; records dropped after ${attempt} attempts`);
      } catch (error) {
        if (abort.signal.aborted) return false;
        wait = backoff(attempt);
        if (attempt >= o.maxAttempts) warnOnce('network', `could not reach ${endpoint}: ${String(error?.cause?.code ?? error?.name ?? error)}; records dropped`);
      }
      if (attempt >= o.maxAttempts) { stats.dropped += batch.length; return true; }
      stats.retries++;
      await sleep(wait);
    }
  }

  async function drain() {
    try {
      while (queue.length && !abort.signal.aborted) {
        const batch = queue.splice(0, o.maxBatch);
        if (!(await send(batch))) { stats.dropped += batch.length; break; }
      }
    } catch (error) {
      warnOnce('drain', 'export failed: ' + String(error?.message ?? error));
    } finally {
      draining = null;
    }
  }

  function flush() {
    if (timer) { clearTimer(timer); timer = null; }
    if (!draining && queue.length && keyOf()) draining = drain();
    return draining ?? Promise.resolve();
  }

  return {
    stats,
    enqueue(records) {
      if (closed) { stats.dropped += records.length; return; }
      for (const r of records) {
        if (queue.length >= o.maxQueue) { stats.dropped++; warnOnce('queue-full', `queue full (${o.maxQueue} records); newer records dropped`); continue; }
        queue.push(r); stats.queued++;
      }
      if (!timer && !draining && queue.length) {
        timer = setTimer(() => { timer = null; flush(); }, o.delayMs);
        timer?.unref?.();
      }
    },
    flush,
    /** Final flush bounded by `shutdownMs`; what is still queued or in flight then is abandoned. */
    async shutdown(deadlineMs = o.shutdownMs) {
      closed = true;
      let t;
      const deadline = new Promise(resolve => { t = setTimer(resolve, deadlineMs); t?.unref?.(); });
      try {
        // Records queued while a drain was settling are picked up by a second pass.
        await Promise.race([flush().then(() => flush()), deadline]);
      } finally {
        clearTimer(t);
        if (queue.length || draining) { stats.dropped += queue.length; queue.length = 0; abort.abort(); await draining; }
      }
    },
  };
}
