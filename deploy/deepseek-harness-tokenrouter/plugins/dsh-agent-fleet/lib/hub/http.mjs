// Hub HTTP server (loopback only): the panel's static files, the JSON API (`GET /api/<method>`), the SSE delta
// stream (`GET /api/stream`), the cookie exchanges (`GET /?token=…`, `GET /?nonce=…` → Set-Cookie + 302) and the
// one-time nonce mint behind the panel's URL (`POST /api/session-nonce`).
//
// Public: /api/health (liveness only: `{ok, version}`) and the panel shell (index.html / app.js / app.css hold no
// fleet data, and the cookie exchange has to be able to load them before it has any credentials). Everything else
// needs the token; `panel/fixtures/**` is never served at all (see serveStatic). With a base prefix (`--base /fleet`)
// every route also answers under that prefix. No CORS, no framing headers (DSH embeds the panel in an iframe), never
// a query string or credential in logs.
import { createServer } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { HUB_METHODS } from "../protocol.mjs";
import { ApiError } from "./api.mjs";
import { isLoopbackAddress } from "./auth.mjs";

const LOOPBACK_BIND = new Set(["127.0.0.1", "::1", "localhost"]);
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2", ".map": "application/json; charset=utf-8",
};
const SSE_BACKLOG_BYTES = 16 * 1024 * 1024;

const baseHeaders = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };

/** "/fleet/" → "/fleet"; "" and "/" → "". */
export function normalizeBase(base) {
  const trimmed = String(base ?? "").trim().replace(/\/+$/, "");
  if (trimmed === "") return "";
  if (!/^\/[A-Za-z0-9._~/-]*$/.test(trimmed) || trimmed.includes("//") || trimmed.split("/").includes("..")) throw new Error(`invalid --base ${JSON.stringify(base)}`);
  return trimmed;
}

function statusOf(error) {
  if (error instanceof ApiError) return error.status;
  switch (error?.code) {
    case "offline": case "closed": return 502;
    case "timeout": return 504;
    default: return 500;
  }
}

/**
 * @param {object} options
 * @param {number} options.port  0 picks a free port
 * @param {ReturnType<import("./auth.mjs").createAuth>} options.auth
 * @param {{request(method: string, params?: object): Promise<any>}} options.api
 * @param {ReturnType<import("./state.mjs").createState>} options.state  for the SSE stream
 * @param {string} [options.panelDir]
 * @returns {Promise<{server: import("node:http").Server, port: number, base: string, close(): Promise<void>}>}
 */
export function startHttpServer({ host = "127.0.0.1", port, base = "", auth, api, state, panelDir, log = () => {}, keepAliveMs = 15_000 }) {
  if (!LOOPBACK_BIND.has(host)) throw new Error(`the hub HTTP server must listen on loopback, not ${host}: the edge router is the only network listener`);
  const prefix = normalizeBase(base);
  const clients = new Set();
  const panelRoot = panelDir ? resolve(panelDir) : null;
  let panelReal = null;

  // ---------------------------------------------------------------------------------------------- responses
  const respond = (request, response, status, body, headers = {}) => {
    response.writeHead(status, { ...baseHeaders, "content-length": Buffer.byteLength(body), ...headers });
    response.end(request.method === "HEAD" ? undefined : body);
  };
  const sendJson = (request, response, status, value, headers = {}) =>
    respond(request, response, status, JSON.stringify(value), { "content-type": "application/json; charset=utf-8", ...headers });
  const sendError = (request, response, error) => {
    if (response.headersSent) { response.destroy(); return; }
    const status = statusOf(error);
    if (status >= 500) log("warn", `${request.method} ${request.url?.split("?")[0]}: ${error?.message ?? error}`);
    sendJson(request, response, status, { error: String(error?.message ?? error) });
  };

  // ------------------------------------------------------------------------------------------------- static
  async function serveStatic(request, response, path) {
    if (panelRoot === null) return sendJson(request, response, 404, { error: "panel not installed" });
    const name = path === "/" ? "index.html" : path.slice(1);
    const segments = name.split("/");
    // panel/fixtures (the synthetic `?demo=1` snapshot and its generator) is dev material for a plain static server
    // (panel/README.md). The hub answers unauthenticated under /fleet behind the edge, so it never serves the directory.
    // Case-insensitive: APFS resolves `Fixtures/…` to the same files.
    if (segments[0].toLowerCase() === "fixtures") return sendJson(request, response, 404, { error: "not found" });
    if (segments.some(part => part === "" || part === ".." || part.startsWith(".") || part.includes("\\") || part.includes("\0")) || MIME[extname(name).toLowerCase()] === undefined) {
      return sendJson(request, response, 404, { error: "not found" });
    }
    const file = resolve(panelRoot, name);
    if (!file.startsWith(panelRoot + sep)) return sendJson(request, response, 404, { error: "not found" });
    let body;
    try {
      panelReal ??= await realpath(panelRoot);
      const real = await realpath(file);
      if (!real.startsWith(panelReal + sep)) return sendJson(request, response, 404, { error: "not found" });
      body = await readFile(real);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EISDIR") return sendJson(request, response, 404, { error: "not found" });
      throw error;
    }
    respond(request, response, 200, body, { "content-type": MIME[extname(name).toLowerCase()] });
  }

  // ----------------------------------------------------------------------------------------------------- SSE
  function openStream(request, response, url) {
    const rawSince = url.searchParams.get("since"), lastId = request.headers["last-event-id"];
    const given = [rawSince, lastId].filter(value => value !== null && value !== undefined && value !== "").map(Number);
    if (given.some(value => !Number.isFinite(value))) throw new ApiError(400, "since must be a number");
    request.socket.setNoDelay(true);
    request.socket.setTimeout(0);
    response.writeHead(200, { ...baseHeaders, "content-type": "text/event-stream; charset=utf-8", "x-accel-buffering": "no" });
    const client = {
      sent: -1,
      write(text) {
        if (response.writableLength > SSE_BACKLOG_BYTES) { response.destroy(); return; }   // the client reconnects and catches up
        response.write(text);
      },
      /** Deltas are idempotent upserts, so overlap with the initial catch-up is harmless; never go backwards. */
      pushDelta(delta, text) {
        if (delta.cursor <= client.sent) return;
        client.sent = delta.cursor;
        client.write(text);
      },
    };
    clients.add(client);
    subscribe();
    response.on("close", () => { clients.delete(client); if (clients.size === 0) unsubscribe(); });
    response.write("retry: 2000\n\n");
    const initial = state.changesSince(given.length > 0 ? Math.max(...given) : state.cursor);
    client.sent = initial.cursor;
    client.write(deltaFrame(initial));                              // a reset delta keeps the stream open: the panel reloads and reconnects
  }

  const deltaFrame = delta => `event: delta\nid: ${delta.cursor}\ndata: ${JSON.stringify(delta)}\n\n`;
  // The state only builds deltas while someone listens: subscribe with the first stream, drop with the last.
  let unsubscribeState = null;
  const subscribe = () => {
    unsubscribeState ??= state.subscribe(delta => {
      const text = deltaFrame(delta);
      for (const client of [...clients]) client.pushDelta(delta, text);
    });
  };
  const unsubscribe = () => { unsubscribeState?.(); unsubscribeState = null; };
  const keepAlive = setInterval(() => { for (const client of [...clients]) client.write(": keep-alive\n\n"); }, keepAliveMs);
  keepAlive.unref();

  // ------------------------------------------------------------------------------------------------- routing
  async function route(request, response) {
    if (!auth.hostAllowed(request)) return sendJson(request, response, 403, { error: "host not allowed" });
    const url = new URL(request.url, "http://hub.invalid");
    let path;
    try { path = decodeURIComponent(url.pathname); } catch { return sendJson(request, response, 400, { error: "bad path" }); }
    if (prefix !== "") {
      if (path === prefix) return respond(request, response, 302, "", { location: `${prefix}/${url.search}` });
      if (path.startsWith(`${prefix}/`)) path = path.slice(prefix.length);
    }

    // Every route is a read except this mint: it hands out a one-time URL credential and also sets the cookie, so a
    // panel that received its token in the fragment can exchange it and survive a reload without storing it.
    const minting = request.method === "POST" && path === "/api/session-nonce";
    if (!minting && request.method !== "GET" && request.method !== "HEAD") return sendJson(request, response, 405, { error: "method not allowed" }, { allow: "GET, HEAD" });
    if (minting) {
      request.resume();
      if (!auth.authenticate(request)) {
        return sendJson(request, response, 401, { error: "unauthorized: send the token as Authorization: Bearer, x-agent-fleet-token or the agent_fleet cookie" }, { "www-authenticate": 'Bearer realm="agent-fleet"' });
      }
      return sendJson(request, response, 200, auth.mintNonce(), { "set-cookie": auth.cookie() });
    }

    if (path === "/" && url.searchParams.has("nonce")) {                    // one-time exchange (the plugin's panel-url)
      const nonce = url.searchParams.get("nonce");
      if (!auth.consumeNonce(nonce)) return sendJson(request, response, 401, { error: "invalid or expired nonce" });
      url.searchParams.delete("nonce");
      const rest = url.searchParams.size === 0 ? "" : `?${url.searchParams}`;
      return respond(request, response, 302, "", { location: `./${rest}`, "set-cookie": auth.cookie() });
    }
    if (path === "/" && url.searchParams.has("token")) {                    // cookie exchange (manual entry)
      if (!auth.accepts(url.searchParams.get("token"))) return sendJson(request, response, 401, { error: "invalid token" });
      url.searchParams.delete("token");
      const rest = url.searchParams.size === 0 ? "" : `?${url.searchParams}`;
      return respond(request, response, 302, "", { location: `./${rest}`, "set-cookie": auth.cookie() });
    }
    if (!path.startsWith("/api/")) return serveStatic(request, response, path);

    const method = path.slice("/api/".length);
    // The full health body names ports, upstreams and kube states: the token buys it, everyone else gets liveness.
    if (method === "health") return sendJson(request, response, 200, await api.request("health", { full: auth.authenticate(request) }));
    if (!auth.authenticate(request)) {
      return sendJson(request, response, 401, { error: "unauthorized: send the token as Authorization: Bearer, x-agent-fleet-token or the agent_fleet cookie" }, { "www-authenticate": 'Bearer realm="agent-fleet"' });
    }
    if (method === "stream") {
      if (request.method !== "GET") return sendJson(request, response, 405, { error: "method not allowed" }, { allow: "GET" });
      return openStream(request, response, url);
    }
    if (!HUB_METHODS.includes(method)) return sendJson(request, response, 404, { error: `unknown API method ${JSON.stringify(method)}` });
    const params = Object.fromEntries(url.searchParams);
    return sendJson(request, response, 200, await api.request(method, params));
  }

  const server = createServer((request, response) => {
    route(request, response).catch(error => sendError(request, response, error));
  });
  // Keep-alive reads over `ssh -W` (upstream pool, idle after 30 s) must not race node's default 5 s idle close.
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 65_000;
  server.on("clientError", (_error, socket) => { if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n"); else socket.destroy(); });
  server.on("connection", socket => { if (!isLoopbackAddress(socket.remoteAddress)) socket.destroy(); });

  return new Promise((resolveStart, rejectStart) => {
    server.once("error", rejectStart);
    server.listen({ host, port }, () => {
      server.off("error", rejectStart);
      server.on("error", error => log("error", `http server: ${error.message}`));
      resolveStart({
        server, base: prefix, port: server.address().port,
        close() {
          clearInterval(keepAlive);
          unsubscribe();
          return new Promise(done => {
            server.close(() => done());
            server.closeAllConnections();           // ends open SSE streams too
          });
        },
      });
    });
  });
}
