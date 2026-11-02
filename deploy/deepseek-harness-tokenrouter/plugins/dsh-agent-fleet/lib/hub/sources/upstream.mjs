// Upstream hub subscription: mirror another hub (the Mac's embedded hub follows the server hub) by loading its
// /api/snapshot, then following /api/stream (SSE) and merging into the local state through `state.upstream(name)`.
// Two ways to reach it: `fetch` against `url`, or — with `sshTarget` — raw HTTP/1.1 spoken over
// `ssh -W 127.0.0.1:<port> <target>` (no listener has to be exposed on the server): one dedicated connection for the
// stream and a small keep-alive pool for the proxied reads (`request("file", …)` etc.) of data the mirror does not
// hold, such as the full event history of remote agents.
import { sshForwardTransport } from "../../channel.mjs";

const MAX_HEAD_BYTES = 64 * 1024;
const MAX_JSON_BYTES = 128 * 1024 * 1024;
const decoder = () => new TextDecoder("utf-8");

// ------------------------------------------------------------------------------------------------ SSE

/** Incremental `text/event-stream` parser: calls `onEvent(eventName, data)` for every frame that carries data. */
export function createSseParser(onEvent) {
  let buffer = "";
  return {
    write(text) {
      buffer = (buffer + text).replace(/\r\n/g, "\n");            // a CR LF split across two chunks is joined before it is normalized
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = "message";
        const data = [];
        for (const line of frame.split("\n")) {
          if (line === "" || line.startsWith(":")) continue;
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? "" : line.slice(colon + (line[colon + 1] === " " ? 2 : 1));
          if (field === "event") event = value;
          else if (field === "data") data.push(value);
        }
        if (data.length > 0) onEvent(event, data.join("\n"));
      }
      if (buffer.length > MAX_JSON_BYTES) throw new Error("SSE frame too large");
    },
  };
}

// ----------------------------------------------------------------------------------- HTTP/1.1 over a duplex

const requestText = (path, host, headers, { keepAlive }) => [
  `GET ${path} HTTP/1.1`, `Host: ${host}`, "Accept: application/json, text/event-stream", "Accept-Encoding: identity",
  `Connection: ${keepAlive ? "keep-alive" : "close"}`, ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`), "", "",
].join("\r\n");

/** Status and lower-cased headers of a response head (the bytes before the blank line). */
function parseHead(bytes) {
  const [statusLine, ...lines] = bytes.toString("latin1").split("\r\n");
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(statusLine)?.[1]);
  if (!Number.isFinite(status)) throw new Error(`bad HTTP status line: ${statusLine.slice(0, 80)}`);
  const headers = {};
  for (const line of lines) { const colon = line.indexOf(":"); if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim(); }
  return { status, headers };
}

/** Streams the payload of a chunked body (the connection is not reused afterwards). */
async function* chunkedBody(iterator, first) {
  let buffer = first;
  const more = async () => {
    const { value, done } = await iterator.next();
    if (done) return false;
    buffer = buffer.length === 0 ? Buffer.from(value) : Buffer.concat([buffer, value]);
    return true;
  };
  for (;;) {
    let eol;
    while ((eol = buffer.indexOf("\r\n")) < 0) if (!(await more())) return;
    const size = Number.parseInt(buffer.subarray(0, eol).toString("latin1").split(";")[0].trim(), 16);
    if (!Number.isFinite(size) || size < 0) throw new Error("bad chunk size in HTTP response");
    buffer = buffer.subarray(eol + 2);
    if (size === 0) return;
    while (buffer.length < size + 2) if (!(await more())) throw new Error("HTTP response ended inside a chunk");
    yield buffer.subarray(0, size);
    buffer = buffer.subarray(size + 2);
  }
}

async function* lengthBody(iterator, first, length) {
  let remaining = length;
  if (first.length > 0 && remaining > 0) { const part = first.subarray(0, remaining); remaining -= part.length; yield part; }
  while (remaining > 0) {
    const { value, done } = await iterator.next();
    if (done) throw new Error("HTTP response ended before content-length");
    const part = Buffer.from(value).subarray(0, remaining);
    remaining -= part.length;
    yield part;
  }
}

async function* closeBody(iterator, first) {
  if (first.length > 0) yield first;
  for (;;) { const { value, done } = await iterator.next(); if (done) return; yield Buffer.from(value); }
}

async function* closing(body, close) {
  try { yield* body; } finally { close(); }
}

/**
 * Issue `GET path` over an already opened duplex transport, `Connection: close`, and stream the body (the SSE stream
 * of a hub uses this; buffered reads go through `createHttpPool`).
 * @param {{readable: import("node:stream").Readable, writable: import("node:stream").Writable, close?: () => void, stderr?: () => string}} transport
 * @returns {Promise<{status: number, headers: Record<string, string>, body: AsyncIterable<Buffer>, close(): void}>}
 */
export async function httpGet(transport, { path, headers = {}, host = "127.0.0.1", signal } = {}) {
  const close = () => { try { transport.close?.(); } catch { /* already gone */ } };
  if (signal) { if (signal.aborted) { close(); throw signal.reason ?? new Error("aborted"); } signal.addEventListener("abort", close, { once: true }); }
  transport.writable.on?.("error", () => { /* surfaces through the read side */ });
  transport.writable.write(requestText(path, host, headers, { keepAlive: false }));
  const iterator = transport.readable[Symbol.asyncIterator]();
  let buffer = Buffer.alloc(0), split;
  try {
    while ((split = buffer.indexOf("\r\n\r\n")) < 0) {
      const { value, done } = await iterator.next();
      if (done) { const detail = transport.stderr?.(); throw new Error(`connection closed before the HTTP response${detail ? `: ${detail}` : ""}`); }
      buffer = buffer.length === 0 ? Buffer.from(value) : Buffer.concat([buffer, value]);
      if (buffer.length > MAX_HEAD_BYTES) throw new Error("HTTP response head too large");
    }
  } catch (error) {
    close();
    throw signal?.aborted ? (signal.reason ?? error) : error;
  }
  let head;
  try { head = parseHead(buffer.subarray(0, split)); } catch (error) { close(); throw error; }
  const rest = buffer.subarray(split + 4);
  const { status, headers: responseHeaders } = head;
  const body = /chunked/i.test(responseHeaders["transfer-encoding"] ?? "") ? chunkedBody(iterator, rest)
    : responseHeaders["content-length"] !== undefined ? lengthBody(iterator, rest, Number(responseHeaders["content-length"]))
      : closeBody(iterator, rest);
  return { status, headers: responseHeaders, body: closing(body, close), close };
}

async function readText(body, limit = MAX_JSON_BYTES) {
  const parts = [];
  let size = 0;
  for await (const chunk of body) { size += chunk.length; if (size > limit) throw new Error("response too large"); parts.push(Buffer.from(chunk)); }
  return Buffer.concat(parts).toString("utf8");
}

// ------------------------------------------------------------------------------ keep-alive connection pool

/**
 * Buffered GETs over a few keep-alive connections that `open()` provides (one duplex transport each, e.g. `ssh -W`):
 * the handshake of a fresh ssh costs far more than the request, and a panel issues several reads at once. A reused
 * connection the server closed meanwhile shows up as a connection that ends before any reply byte; the request is
 * then retried once on a fresh connection.
 * @param {object} options
 * @param {() => object | Promise<object>} options.open  returns {readable, writable, close?, stderr?}
 */
export function createHttpPool({ open, host = "127.0.0.1", headers = {}, maxConnections = 3, idleMs = 30_000, maxBytes = MAX_JSON_BYTES }) {
  const idle = [], waiters = [], all = new Set();
  let live = 0, closed = false;
  const wake = () => waiters.shift()?.();

  function discard(connection) {
    if (connection.dead) return;
    connection.dead = true;
    clearTimeout(connection.timer);
    all.delete(connection);
    const at = idle.indexOf(connection);
    if (at >= 0) idle.splice(at, 1);
    live -= 1;
    try { connection.transport.close?.(); } catch { /* already gone */ }
    wake();
  }

  function release(connection) {
    connection.timer = setTimeout(() => discard(connection), idleMs);
    connection.timer.unref?.();
    idle.push(connection);
    wake();
  }

  async function acquire(signal) {
    for (;;) {
      signal?.throwIfAborted();
      if (closed) throw new Error("connection pool closed");
      const connection = idle.pop();
      if (connection !== undefined) { clearTimeout(connection.timer); return { connection, reused: true }; }
      if (live < maxConnections) {
        live += 1;
        let transport;
        try { transport = await open(); } catch (error) { live -= 1; wake(); throw error; }
        if (closed) { live -= 1; try { transport.close?.(); } catch { /* gone */ } throw new Error("connection pool closed"); }
        transport.writable.on?.("error", () => { /* surfaces through the read side */ });
        const connection = { transport, iterator: transport.readable[Symbol.asyncIterator](), rest: Buffer.alloc(0), dead: false, timer: null, received: false };
        all.add(connection);
        return { connection, reused: false };
      }
      await new Promise((resolve, reject) => {
        const waiter = () => { signal?.removeEventListener("abort", onAbort); resolve(); };
        const onAbort = () => { const at = waiters.indexOf(waiter); if (at >= 0) waiters.splice(at, 1); reject(signal.reason); };
        waiters.push(waiter);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }

  /** Next bytes of the connection, appended to `buffer`; throws when it ends. */
  async function more(connection, buffer, what) {
    const { value, done } = await connection.iterator.next();
    if (done) {
      const detail = connection.transport.stderr?.();
      throw new Error(`connection closed ${what}${detail ? `: ${detail}` : ""}`);
    }
    connection.received = true;
    const chunk = Buffer.from(value);
    return buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
  }

  async function exchange(connection, path) {
    connection.received = false;
    connection.transport.writable.write(requestText(path, host, headers, { keepAlive: true }));
    let buffer = connection.rest, split;
    connection.rest = Buffer.alloc(0);
    while ((split = buffer.indexOf("\r\n\r\n")) < 0) {
      buffer = await more(connection, buffer, "before the HTTP response");
      if (buffer.length > MAX_HEAD_BYTES) throw new Error("HTTP response head too large");
    }
    const { status, headers: responseHeaders } = parseHead(buffer.subarray(0, split));
    buffer = buffer.subarray(split + 4);
    let reusable = !/\bclose\b/i.test(responseHeaders.connection ?? "");
    const parts = [];
    let size = 0;
    const take = part => { size += part.length; if (size > maxBytes) throw new Error("response too large"); parts.push(part); };
    if (status === 204 || status === 304) {                             // no body by definition
      // nothing to read
    } else if (/chunked/i.test(responseHeaders["transfer-encoding"] ?? "")) {
      for (;;) {
        let eol;
        while ((eol = buffer.indexOf("\r\n")) < 0) buffer = await more(connection, buffer, "inside a chunked body");
        const chunkSize = Number.parseInt(buffer.subarray(0, eol).toString("latin1").split(";")[0].trim(), 16);
        if (!Number.isFinite(chunkSize) || chunkSize < 0) throw new Error("bad chunk size in HTTP response");
        buffer = buffer.subarray(eol + 2);
        if (chunkSize === 0) {                                          // trailers (normally none) end with an empty line
          for (;;) {
            let line;
            while ((line = buffer.indexOf("\r\n")) < 0) buffer = await more(connection, buffer, "inside the chunked trailer");
            buffer = buffer.subarray(line + 2);
            if (line === 0) break;
          }
          break;
        }
        while (buffer.length < chunkSize + 2) buffer = await more(connection, buffer, "inside a chunk");
        take(buffer.subarray(0, chunkSize));
        buffer = buffer.subarray(chunkSize + 2);
      }
    } else if (responseHeaders["content-length"] !== undefined) {
      const length = Number(responseHeaders["content-length"]);
      if (!Number.isFinite(length) || length < 0) throw new Error("bad content-length in HTTP response");
      while (buffer.length < length) buffer = await more(connection, buffer, "before content-length");
      take(buffer.subarray(0, length));
      buffer = buffer.subarray(length);
    } else {                                                            // no framing: the body runs until the server closes
      reusable = false;
      for (;;) {
        take(buffer);
        buffer = Buffer.alloc(0);
        const next = await connection.iterator.next();
        if (next.done) break;
        buffer = Buffer.from(next.value);
      }
    }
    connection.rest = buffer;
    return { status, headers: responseHeaders, body: Buffer.concat(parts), reusable: reusable && buffer.length === 0 };
  }

  return {
    /** @returns {Promise<{status: number, headers: Record<string, string>, body: Buffer}>} */
    async get(path, { signal } = {}) {
      for (let attempt = 0; ; attempt += 1) {
        const { connection, reused } = await acquire(signal);
        const onAbort = () => discard(connection);
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          const reply = await exchange(connection, path);
          signal?.removeEventListener("abort", onAbort);
          if (reply.reusable && !closed) release(connection); else discard(connection);
          return { status: reply.status, headers: reply.headers, body: reply.body };
        } catch (error) {
          signal?.removeEventListener("abort", onAbort);
          const stale = reused && !connection.received && attempt === 0;
          discard(connection);
          if (signal?.aborted) throw signal.reason ?? error;
          if (!stale) throw error;
        }
      }
    },
    close() {
      closed = true;
      for (const connection of [...all]) discard(connection);           // in-flight reads fail now instead of at their timeout
      while (waiters.length > 0) waiters.shift()();
    },
    get size() { return live; },
  };
}

// ----------------------------------------------------------------------------------------- the subscription

const sleep = (ms, signal) => new Promise(resolve => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
  signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

/**
 * @param {object} options
 * @param {string} options.name                 namespace of the merged data
 * @param {string} options.url                  base URL of the upstream hub (also gives its base path and, with sshTarget, its port)
 * @param {string} options.token
 * @param {string} [options.sshTarget]          reach the hub through `ssh -W 127.0.0.1:<port> <target>`
 * @param {ReturnType<import("../state.mjs").createState>["upstream"] extends (n: string) => infer S ? S : never} options.sink
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => object | Promise<object>} [options.transportFor]  test hook replacing the ssh transport ({readable, writable, close})
 * @param {() => number} [options.now]          clock of the silence watchdog (tests inject a fake one)
 */
export function createUpstream({ name, url, token, sshTarget, sink, log = () => {}, fetchImpl = globalThis.fetch, transportFor, minDelayMs = 1000, maxDelayMs = 30_000, silenceMs = 45_000, requestTimeoutMs = 20_000, poolSize = 3, now = Date.now }) {
  const base = new URL(url.endsWith("/") ? url : `${url}/`);
  const port = Number(base.port) || (base.protocol === "https:" ? 443 : 80);
  const headers = { "x-agent-fleet-token": token };
  const mode = sshTarget ? "ssh" : "http";
  const openTransport = () => (transportFor ?? (() => sshForwardTransport({ target: sshTarget, port })))();
  const pool = mode === "ssh" ? createHttpPool({ open: openTransport, host: `127.0.0.1:${port}`, headers, maxConnections: poolSize }) : null;
  let stopped = false, started = false, loop = null;
  const aborter = new AbortController();
  let state = { status: "connecting", error: "", since: Date.now(), cursor: 0, hubHostId: undefined };

  const setState = (status, error = "") => { if (state.status !== status || state.error !== error) state = { ...state, status, error, since: Date.now() }; };

  /** The SSE stream: its own connection, body streamed. */
  async function openStream(path, signal) {
    if (mode === "ssh") return httpGet(await openTransport(), { path: `${base.pathname}${path}`, headers, host: `127.0.0.1:${port}`, signal });
    const response = await fetchImpl(new URL(path, base), { headers, signal });
    return { status: response.status, body: response.body ?? [], close: () => response.body?.cancel?.().catch(() => {}) };
  }

  async function getJson(path, signal = AbortSignal.timeout(requestTimeoutMs)) {
    let status, text;
    if (pool !== null) {
      const reply = await pool.get(`${base.pathname}${path}`, { signal });
      status = reply.status;
      text = reply.body.toString("utf8");
    } else {
      const response = await fetchImpl(new URL(path, base), { headers, signal });
      status = response.status;
      text = await readText(response.body ?? []);
    }
    let value;
    try { value = JSON.parse(text); } catch { value = undefined; }
    if (status !== 200) throw Object.assign(new Error(`upstream ${path}: HTTP ${status}${value?.error ? ` ${value.error}` : ""}`), { status });
    if (value === undefined) throw new Error(`upstream ${path}: reply is not JSON`);
    return value;
  }

  async function follow(signal) {
    const local = new AbortController();               // the silence watchdog cancels only this stream
    const response = await openStream(`api/stream?since=${state.cursor}`, AbortSignal.any([signal, local.signal]));
    if (response.status !== 200) { response.close(); throw new Error(`upstream stream: HTTP ${response.status}`); }
    const text = decoder();
    let watchdog = null;
    const arm = () => {
      clearTimeout(watchdog);
      const armedAt = now();
      watchdog = setTimeout(() => {
        const late = now() - armedAt - silenceMs;
        if (late > silenceMs) {      // fired much later than scheduled: this process was stalled, the peer may have sent data
          log("warn", `upstream ${name}: silence watchdog fired ${late} ms late (process stalled); waiting again`);
          arm();
          return;
        }
        local.abort(new Error(`no data from the upstream hub for ${Math.round(silenceMs / 1000)} s`));
      }, silenceMs);
      watchdog.unref?.();
    };
    const parser = createSseParser((event, data) => {
      if (event !== "delta") return;
      const delta = JSON.parse(data);
      if (sink.delta(delta) === "reset") throw Object.assign(new Error("a fresh snapshot is needed"), { reset: true });
      if (Number.isFinite(delta.cursor)) state.cursor = delta.cursor;
    });
    arm();
    try {
      for await (const chunk of response.body) { arm(); parser.write(text.decode(chunk, { stream: true })); }
    } finally { clearTimeout(watchdog); response.close(); }
    throw new Error("upstream stream closed");
  }

  async function run() {
    let delay = minDelayMs;
    while (!stopped) {
      const signal = aborter.signal;
      let onlineAt = 0;
      try {
        setState("connecting");
        const snapshot = await getJson("api/snapshot", AbortSignal.any([signal, AbortSignal.timeout(60_000)]));
        sink.snapshot(snapshot);
        state = { ...state, cursor: snapshot.cursor, hubHostId: snapshot.hub?.hostId };
        setState("online");
        onlineAt = Date.now();
        await follow(signal);
      } catch (error) {
        if (stopped) break;
        if (error.reset) { await sleep(minDelayMs, signal); continue; }
        const reason = error?.cause?.message ?? error?.message ?? String(error);
        if (state.status !== "offline" || state.error !== reason) log("warn", `upstream ${name} (${mode} ${sshTarget ?? url}): ${reason}`);
        setState("offline", reason);
        sink.disconnected(reason);
        if (onlineAt !== 0 && Date.now() - onlineAt > 60_000) delay = minDelayMs;
        await sleep(delay, signal);
        delay = Math.min(maxDelayMs, delay * 2);
      }
    }
  }

  return {
    name, mode,
    start() { if (!started) { started = true; loop = run(); } },
    async stop() { stopped = true; aborter.abort(); pool?.close(); await loop?.catch(() => {}); },
    status: () => ({ name, mode, target: sshTarget ?? url, ...state }),
    /** GET a hub API method on the upstream hub: `request("file", {host, path})`. */
    request(method, params = {}, { signal } = {}) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
      const suffix = query.size === 0 ? "" : `?${query}`;
      return getJson(`api/${method}${suffix}`, signal ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]) : undefined);
    },
  };
}
