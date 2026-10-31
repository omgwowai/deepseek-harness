// How the plugin reaches a hub: `createHttpHub` (GET <url>/api/<method>, token header) for `remote` mode; embedded mode
// wraps the in-process `hub.api.request`. Both give `request(method, params, {signal}) → value` over HUB_METHODS.
import { readFile } from "node:fs/promises";
import { HUB_METHODS } from "../protocol.mjs";

const TOKEN_TTL_MS = 5000;
const TIMEOUT_MS = 15_000;

export class HubError extends Error {
  constructor(message, status) { super(message); this.name = "HubError"; this.status = status; }
}

/** Contents of a token file (trimmed), or "" when it cannot be read; cached for a few seconds. */
export function tokenReader(file, { ttlMs = TOKEN_TTL_MS, now = Date.now } = {}) {
  let cached = "", at = -Infinity;
  return async () => {
    if (now() - at < ttlMs) return cached;
    try { cached = (await readFile(file, "utf8")).trim(); } catch { cached = ""; }
    at = now();
    return cached;
  };
}

export function queryString(params) {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params ?? {})) if (value !== undefined && value !== null && value !== "") query.set(name, String(value));
  return query.size === 0 ? "" : `?${query}`;
}

function checkMethod(method) {
  if (!HUB_METHODS.includes(method)) throw new Error(`unknown hub method ${JSON.stringify(method)}`);
}

/** `lifetime` aborts every request in flight when the plugin is disposed. */
export function createHttpHub({ url, tokenFile, lifetime, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS }) {
  const token = tokenReader(tokenFile);
  return {
    async request(method, params, { signal } = {}) {
      checkMethod(method);
      const headers = { accept: "application/json" };
      const secret = await token();
      if (secret !== "") headers["x-agent-fleet-token"] = secret;
      const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : []), ...(lifetime ? [lifetime] : [])];
      let response, body;
      try {
        response = await fetchImpl(`${url}/api/${method}${queryString(params)}`, { headers, signal: AbortSignal.any(signals) });
        body = await response.text();
      } catch (error) {
        if (signal?.aborted || lifetime?.aborted) throw error;
        const reason = error?.name === "TimeoutError" ? `no answer within ${timeoutMs / 1000}s` : (error?.cause?.code ?? error?.cause?.message ?? error?.message ?? String(error));
        throw new HubError(`Agent Fleet hub unreachable at ${url} (${reason}); is the hub running?`);
      }
      let json;
      try { json = JSON.parse(body); } catch { /* reported below */ }
      if (response.status === 401) throw new HubError(`Agent Fleet hub rejected the token (401); check tokenFile ${tokenFile}`, 401);
      if (!response.ok) throw new HubError(`Agent Fleet hub ${method} failed: HTTP ${response.status} ${json?.error ?? body.slice(0, 200)}`.trim(), response.status);
      if (json === undefined) throw new HubError(`Agent Fleet hub ${method}: the reply is not JSON`, response.status);
      return json;
    },
  };
}

/** Facade over an in-process hub: `getApi()` resolves the hub's `api` (or rejects with why embedded mode is down). */
export function createEmbeddedHub(getApi) {
  return {
    async request(method, params, { signal } = {}) {
      checkMethod(method);
      const api = await abortable(getApi(), signal);
      return abortable(Promise.resolve(api.request(method, params ?? {})), signal);
    },
  };
}

/** `promise`, or a rejection with the signal's reason as soon as it aborts (the underlying work finishes on its own). */
export function abortable(promise, signal) {
  if (signal === undefined || signal === null) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Callers within `ttlMs` share one `snapshot` request (it is the big payload, and tool calls / RPCs arrive in bursts).
 * Every other method passes through. Each caller can still abort its own wait through `options.signal`.
 */
export function withSnapshotCache(hub, { ttlMs = 1000, now = Date.now } = {}) {
  let cached = null;
  return {
    request(method, params, options) {
      if (method !== "snapshot") return hub.request(method, params, options);
      if (cached === null || now() - cached.at >= ttlMs) {
        const promise = hub.request(method, params);
        cached = { at: now(), promise };
        promise.catch(() => { if (cached?.promise === promise) cached = null; });
      }
      return abortable(cached.promise, options?.signal);
    },
  };
}
