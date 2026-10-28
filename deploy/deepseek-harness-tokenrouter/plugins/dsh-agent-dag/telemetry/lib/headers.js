// Request headers and the OpenAI prompt cache key on DSH's own model requests
// to TokenRouter.
//
// DSH has no per-request header hook (GenerateOptions has no `headers`, and
// pi-ai's session-affinity headers are withheld on custom routes). So the
// plugin wraps each `llm/stream` call in an AsyncLocalStorage holding that
// call's session, and Node's built-in fetch (undici) publishes every new
// request on the `undici:request:create` diagnostics channel, where the
// subscriber adds the headers. Only requests to the TokenRouter origin get
// them; the telemetry export itself is left alone.
//
// A model call DSH makes without a session id (Auto review's reviewer call,
// a web search inside a tool) inherits the session of the tool call it runs
// in: the plugin runs each `tools/pre-execute` and `tools/execute` in that
// agent's session too.
//
// The diagnostics channel cannot change a request body, so the plugin also
// wraps `globalThis.fetch`: pi-ai builds a new OpenAI SDK client per request,
// and the SDK reads the global `fetch` then. An OpenAI Chat / Responses body
// to TokenRouter without `prompt_cache_key` gets the request's x-session-id.

import { AsyncLocalStorage } from 'node:async_hooks';
import diagnosticsChannel from 'node:diagnostics_channel';

export const MARKER_HEADER = 'x-tokenrouter-dsh-telemetry';
export const SESSION_HEADER = 'x-session-id';
export const PARENT_SESSION_HEADER = 'x-tokenrouter-parent-session-id';
export const FORKED_FROM_HEADER = 'x-tokenrouter-forked-from-session-id';
export const FORK_POINT_HEADER = 'x-tokenrouter-fork-point';
export const FORK_KIND_HEADER = 'x-tokenrouter-fork-kind';
export const ORIGIN_HEADER = 'x-tokenrouter-session-origin';
export const SPAWN_CALL_HEADER = 'x-tokenrouter-spawn-tool-call-id';
export const UNDICI_CHANNEL = 'undici:request:create';
export const PROMPT_CACHE_KEY = 'prompt_cache_key';
// OpenAI rejects a longer prompt_cache_key; such a session keeps only the header.
export const PROMPT_CACHE_KEY_MAX = 64;
const OPENAI_PATH = /\/(responses|chat\/completions)$/;

// Requests that are not a turn of the session itself: DSH's own `purpose`.
const PURPOSE_ORIGIN = { 'session-title': 'title', compaction: 'compaction' };

const SAFE = /^[\x21-\x7e]{1,256}$/;

// undici keeps request.headers as a flat [name, value, …] array (Node 20/22),
// older builds as a "name: value\r\n" string.
function hasHeader(headers, name) {
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 2) if (String(headers[i]).toLowerCase() === name) return true;
    return false;
  }
  if (typeof headers === 'string') return headers.toLowerCase().split('\r\n').some(line => line.startsWith(name + ':'));
  return false;
}

// A fetch() `init.headers` value (Headers, [[name, value]…] or a record) → the value of `name`.
function initHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined;
  const pairs = Array.isArray(headers) ? headers : Object.entries(headers);
  for (const [key, value] of pairs) if (String(key).toLowerCase() === name && value !== undefined) return String(value);
  return undefined;
}

// The JSON object a fetch() body carries, or undefined (not text, not a JSON object).
function jsonBody(body) {
  let text;
  if (typeof body === 'string') text = body;
  else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { return undefined; }
  } else return undefined;
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  } catch { return undefined; }
}

// The TokenRouter Key DSH itself sends on a model request (x-api-key or Authorization: Bearer).
function routeKey(headers) {
  const pairs = Array.isArray(headers) ? Array.from({ length: headers.length >> 1 }, (_, i) => [String(headers[2 * i]), String(headers[2 * i + 1])])
    : typeof headers === 'string' ? headers.split('\r\n').map(line => { const i = line.indexOf(':'); return i > 0 ? [line.slice(0, i), line.slice(i + 1).trim()] : null; }).filter(Boolean) : [];
  for (const [name, value] of pairs) {
    const n = name.toLowerCase();
    const key = n === 'x-api-key' ? value.trim() : n === 'authorization' ? /^Bearer\s+(\S+)$/i.exec(value.trim())?.[1] : undefined;
    if (key && SAFE.test(key)) return key;
  }
  return undefined;
}

/**
 * @param {{ origins: string[], skipPath?: string, version: string, lookupLinks?: (sessionId: string) => ({ parent?: string, forkedFrom?: string, forkPoint?: string, forkKind?: string, origin?: string, spawnToolCallId?: string }|undefined), onKey?: (key: string) => void, logger?: {warn(m: string): void} }} options
 *   skipPath: the telemetry endpoint's own path on the same origin, left unmarked.
 *   lookupLinks: the calling session's links from its own header (mapper.js sessionLinks).
 *   onKey: receives the Key of each model request to the TokenRouter origin.
 */
export function createRequestHeaders({ origins, skipPath, version, lookupLinks = () => undefined, onKey, logger }) {
  const als = new AsyncLocalStorage();
  const allowed = new Set(origins.map(o => new URL(o).origin));
  const warned = new Set();
  const warnOnce = (what, error) => {
    if (warned.has(what)) return;
    warned.add(what);
    logger?.warn(`tokenrouter-dsh-telemetry: ${what} skipped: ${String(error?.message ?? error)}`);
  };

  const onCreate = (message) => {
    const request = message?.request;
    try {
      if (!request || !allowed.has(request.origin === undefined ? '' : new URL(String(request.origin)).origin)) return;
      if (skipPath && String(request.path ?? '').split('?', 1)[0] === skipPath) return;
      const add = (name, value) => { if (typeof value === 'string' && SAFE.test(value) && !hasHeader(request.headers, name)) request.addHeader(name, value); };
      add(MARKER_HEADER, version);
      if (onKey) { const key = routeKey(request.headers); if (key) onKey(key); }
      const store = als.getStore();
      const sessionId = store?.sessionId;
      if (sessionId === undefined) return;
      add(SESSION_HEADER, sessionId);
      const links = lookupLinks(sessionId) ?? {};
      add(PARENT_SESSION_HEADER, links.parent);
      add(FORKED_FROM_HEADER, links.forkedFrom);
      add(FORK_POINT_HEADER, links.forkPoint);
      add(FORK_KIND_HEADER, links.forkKind);
      add(ORIGIN_HEADER, PURPOSE_ORIGIN[store.purpose] ?? links.origin);
      add(SPAWN_CALL_HEADER, links.spawnToolCallId);
    } catch (error) {
      warnOnce('request headers', error);
    }
  };

  // An OpenAI Chat / Responses POST to the TokenRouter origin whose JSON body has
  // no prompt_cache_key (absent, null or ''): the init with prompt_cache_key =
  // the x-session-id this request goes out with (a caller-set one, else the
  // call's session, which onCreate adds). Anything else: undefined, unchanged.
  function withCacheKey(input, init) {
    if (stopped || !init || init.body === undefined || init.body === null) return undefined;
    const request = typeof input === 'object' && input !== null && !(input instanceof URL) ? input : undefined;
    if (String(init.method ?? request?.method ?? 'GET').toUpperCase() !== 'POST') return undefined;
    const url = new URL(request ? String(request.url) : String(input));
    if (!allowed.has(url.origin) || (skipPath && url.pathname === skipPath) || !OPENAI_PATH.test(url.pathname)) return undefined;
    const sessionId = initHeader(init.headers ?? request?.headers, SESSION_HEADER) ?? als.getStore()?.sessionId;
    if (sessionId === undefined || !SAFE.test(sessionId) || sessionId.length > PROMPT_CACHE_KEY_MAX) return undefined;
    const body = jsonBody(init.body);
    if (!body || (body[PROMPT_CACHE_KEY] !== undefined && body[PROMPT_CACHE_KEY] !== null && body[PROMPT_CACHE_KEY] !== '')) return undefined;
    body[PROMPT_CACHE_KEY] = sessionId;
    const text = JSON.stringify(body);
    const next = { ...init, body: text };
    if (initHeader(init.headers, 'content-length') !== undefined) {
      const headers = new Headers(init.headers);
      headers.set('content-length', String(Buffer.byteLength(text)));
      next.headers = headers;
    }
    return next;
  }

  /** A fetch that adds prompt_cache_key (withCacheKey) and otherwise calls `original` unchanged. */
  function wrapFetch(original) {
    return function fetch(input, init) {
      let next;
      try { next = withCacheKey(input, init); } catch (error) { warnOnce('prompt_cache_key', error); }
      return original(input, next ?? init);
    };
  }

  // Each pull of the chunk stream runs inside the call's store, so the fetch
  // that the adapter issues on the first pull (and any retry) sees it.
  function wrapStream(stream, store) {
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') return stream;
    let iterator;
    const it = () => (iterator ??= als.run(store, () => stream[Symbol.asyncIterator]()));
    return {
      [Symbol.asyncIterator]() { return this; },
      next: (...args) => als.run(store, () => it().next(...args)),
      return: (...args) => als.run(store, () => (it().return ? it().return(...args) : Promise.resolve({ done: true, value: args[0] }))),
      throw: (...args) => als.run(store, () => (it().throw ? it().throw(...args) : Promise.reject(args[0]))),
    };
  }

  /** cordis `llm/stream` waterfall listener. A call without a sessionId keeps the session it runs in (inSession). */
  const onStream = (options, next) => {
    const ambient = als.getStore();
    const own = options?.sessionId === undefined ? undefined : String(options.sessionId);
    const purpose = typeof options?.purpose === 'string' ? options.purpose : undefined;
    const store = own !== undefined ? { sessionId: own, purpose } : { sessionId: ambient?.sessionId, purpose: purpose ?? ambient?.purpose };
    return wrapStream(als.run(store, next), store);
  };

  /** Run `next` (a tools/pre-execute or tools/execute step) in the calling agent's session. */
  const inSession = (sessionId, next) => (sessionId === undefined || sessionId === null ? next() : als.run({ sessionId: String(sessionId) }, next));

  let installed, original, stopped = false;
  return {
    onStream,
    onCreate,
    inSession,
    wrapFetch,
    /** @returns {boolean} whether the channel was subscribed (and the global fetch wrapped) */
    start() {
      if (typeof diagnosticsChannel.subscribe !== 'function') return false;
      diagnosticsChannel.subscribe(UNDICI_CHANNEL, onCreate);
      if (typeof globalThis.fetch === 'function' && !installed) {
        original = globalThis.fetch;
        installed = wrapFetch(original);
        globalThis.fetch = installed;
      }
      return true;
    },
    stop() {
      diagnosticsChannel.unsubscribe?.(UNDICI_CHANNEL, onCreate);
      // Restore only our own wrapper; one installed over it keeps calling ours, which then passes requests through.
      stopped = true;
      if (installed && globalThis.fetch === installed) globalThis.fetch = original;
      installed = undefined;
    },
  };
}
