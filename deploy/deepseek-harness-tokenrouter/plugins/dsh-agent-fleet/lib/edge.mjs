// Edge router: the single network listener on server-bochao-01 (10.0.60.98:443, plain HTTP — the port the
// intranet firewall admits). Prefix routes go to loopback services, everything else to a fallback upstream:
//   /fleet/* → Agent Fleet hub   (prefix stripped)
//   /dsh/*   → DSH Web           (prefix stripped)
//   /*       → telemetry panel   (unchanged path)
// Bodies stream in both directions (SSE flushes immediately), WebSocket upgrades are piped as raw sockets,
// the browser's Host header is passed through unchanged (DSH Web compares Origin with Host), and the access
// log never contains query strings or cookies.
import http from "node:http";
import net from "node:net";

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "proxy-connection"]);

/** @typedef {{prefix: string, target: string, strip: boolean}} Route */

function parseTarget(target) {
  const url = new URL(target);
  if (url.protocol !== "http:") throw new Error(`edge: only http upstreams are supported (${target})`);
  return { host: url.hostname, port: Number(url.port || 80), base: url.pathname.replace(/\/+$/, "") };
}

function pathOnly(rawUrl) {
  const index = rawUrl.indexOf("?");
  return index < 0 ? rawUrl : rawUrl.slice(0, index);
}

/** Pick the route for a request path; returns {route, upstreamPath} or {redirect}. */
export function resolveRoute(routes, fallback, rawUrl) {
  const path = pathOnly(rawUrl), query = rawUrl.slice(path.length);
  for (const route of routes) {
    if (path === route.prefix) return { redirect: `${route.prefix}/${query}` };
    if (path.startsWith(`${route.prefix}/`)) {
      const rest = route.strip ? path.slice(route.prefix.length) : path;
      return { route, upstreamPath: `${route.upstream.base}${rest}${query}` };
    }
  }
  return { route: fallback, upstreamPath: `${fallback.upstream.base}${rawUrl}` };
}

function forwardHeaders(request, route, { upgrade = false } = {}) {
  const headers = {};
  const connectionTokens = new Set(String(request.headers.connection ?? "").toLowerCase().split(",").map(token => token.trim()).filter(Boolean));
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || connectionTokens.has(lower)) continue;
    headers[lower] = value;
  }
  const remote = request.socket.remoteAddress ?? "";
  headers["x-forwarded-for"] = headers["x-forwarded-for"] ? `${headers["x-forwarded-for"]}, ${remote}` : remote;
  headers["x-forwarded-proto"] = "http";
  if (request.headers.host) headers["x-forwarded-host"] = request.headers.host;
  if (route.prefix && route.strip) headers["x-forwarded-prefix"] = route.prefix;
  if (upgrade) { headers.connection = "Upgrade"; headers.upgrade = request.headers.upgrade; }
  return headers;
}

/** Rewrite upstream Location / Set-Cookie for a stripped prefix. */
export function rewriteResponseHeaders(headers, route) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    out[lower] = value;
  }
  if (!route.strip || !route.prefix) return out;
  if (typeof out.location === "string" && out.location.startsWith("/") && !out.location.startsWith("//") && !out.location.startsWith(`${route.prefix}/`)) {
    out.location = `${route.prefix}${out.location}`;
  }
  if (out["set-cookie"] !== undefined) {
    const cookies = Array.isArray(out["set-cookie"]) ? out["set-cookie"] : [out["set-cookie"]];
    // An upstream cookie scoped to "/" (or any path) lives under the prefix once routed: Path=/x → Path=/fleet/x.
    out["set-cookie"] = cookies.map(cookie => {
      if (!/;\s*path=/i.test(cookie)) return `${cookie}; Path=${route.prefix}/`;
      return cookie.replace(/(;\s*path=)(\/[^;]*)/i, (match, key, path) => path === route.prefix || path.startsWith(`${route.prefix}/`) ? match : `${key}${route.prefix}${path}`);
    });
  }
  return out;
}

/**
 * @param {object} options
 * @param {{host: string, port: number}} options.listen
 * @param {{prefix: string, target: string, strip?: boolean}[]} options.routes
 * @param {string} options.fallback
 * @param {(line: string) => void} [options.log]
 */
export function startEdge({ listen, routes, fallback, log = line => process.stderr.write(line + "\n") }) {
  const compiled = routes.map(route => {
    const prefix = route.prefix.replace(/\/+$/, "");
    if (!/^\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/.test(prefix)) throw new Error(`edge: bad route prefix ${route.prefix}`);
    return { prefix, strip: route.strip !== false, target: route.target, upstream: parseTarget(route.target), agent: new http.Agent({ keepAlive: true, maxSockets: 256 }) };
  }).sort((a, b) => b.prefix.length - a.prefix.length);
  const fallbackRoute = { prefix: "", strip: false, target: fallback, upstream: parseTarget(fallback), agent: new http.Agent({ keepAlive: true, maxSockets: 256 }) };

  const server = http.createServer((request, response) => {
    const started = Date.now();
    const done = status => log(`${new Date().toISOString()} ${request.method} ${pathOnly(request.url)} ${status} ${Date.now() - started}ms`);
    const resolved = resolveRoute(compiled, fallbackRoute, request.url ?? "/");
    if (resolved.redirect) {
      // 302, not 301: the bare prefix may carry a credential the browser must not cache a permanent redirect for.
      response.writeHead(302, { location: resolved.redirect, "content-length": "0", "cache-control": "no-store", "referrer-policy": "no-referrer" });
      response.end();
      done(302);
      return;
    }
    const { route, upstreamPath } = resolved;
    const upstreamRequest = http.request({
      host: route.upstream.host, port: route.upstream.port, method: request.method, path: upstreamPath,
      headers: forwardHeaders(request, route), agent: route.agent,
    }, upstreamResponse => {
      const headers = rewriteResponseHeaders(upstreamResponse.headers, route);
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, headers);
      if (typeof response.flushHeaders === "function") response.flushHeaders();
      upstreamResponse.pipe(response);
      upstreamResponse.on("end", () => done(upstreamResponse.statusCode));
      upstreamResponse.on("error", () => { response.destroy(); done("upstream-reset"); });
    });
    upstreamRequest.on("socket", socket => socket.setNoDelay(true));
    upstreamRequest.on("error", error => {
      if (!response.headersSent) {
        const body = `edge: upstream ${route.prefix || "/"} unavailable (${error.code ?? error.message})\n`;
        response.writeHead(502, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(body) });
        response.end(body);
      } else response.destroy();
      done(502);
    });
    response.on("close", () => { if (!response.writableFinished) upstreamRequest.destroy(); });
    request.pipe(upstreamRequest);
  });

  server.on("connection", socket => socket.setNoDelay(true));
  server.on("upgrade", (request, clientSocket, head) => {
    const started = Date.now();
    const resolved = resolveRoute(compiled, fallbackRoute, request.url ?? "/");
    const route = resolved.route ?? fallbackRoute;
    const upstreamPath = resolved.upstreamPath ?? request.url;
    const upstreamSocket = net.connect({ host: route.upstream.host, port: route.upstream.port });
    const fail = reason => {
      if (clientSocket.writable) clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      upstreamSocket.destroy();
      log(`${new Date().toISOString()} UPGRADE ${pathOnly(request.url)} 502 ${Date.now() - started}ms ${reason}`);
    };
    upstreamSocket.once("error", error => fail(error.code ?? error.message));
    upstreamSocket.once("connect", () => {
      upstreamSocket.setNoDelay(true);
      clientSocket.setNoDelay(true);
      const headers = forwardHeaders(request, route, { upgrade: true });
      let head1 = `${request.method} ${upstreamPath} HTTP/1.1\r\n`;
      for (const [name, value] of Object.entries(headers)) {
        for (const item of Array.isArray(value) ? value : [value]) head1 += `${name}: ${item}\r\n`;
      }
      upstreamSocket.write(head1 + "\r\n");
      if (head?.length) upstreamSocket.write(head);
      upstreamSocket.removeAllListeners("error");
      upstreamSocket.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => upstreamSocket.destroy());
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
      log(`${new Date().toISOString()} UPGRADE ${pathOnly(request.url)} piped ${Date.now() - started}ms`);
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listen.port, listen.host, () => {
      server.off("error", reject);
      resolve({
        server,
        address: server.address(),
        stop: () => new Promise(done => {
          for (const route of [...compiled, fallbackRoute]) route.agent.destroy();
          server.close(() => done());
          server.closeAllConnections?.();
        }),
      });
    });
  });
}

/** CLI: agent-fleet edge --listen HOST:PORT --route /prefix=http://… [--route …] --fallback http://… */
export async function edgeMain(argv) {
  const routes = [];
  let listen = null, fallback = null;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index], value = argv[index + 1];
    if (flag === "--listen") { const at = value.lastIndexOf(":"); listen = { host: value.slice(0, at), port: Number(value.slice(at + 1)) }; index += 1; }
    else if (flag === "--route") { const eq = value.indexOf("="); routes.push({ prefix: value.slice(0, eq), target: value.slice(eq + 1), strip: true }); index += 1; }
    else if (flag === "--fallback") { fallback = value; index += 1; }
    else throw new Error(`edge: unknown flag ${flag}`);
  }
  if (!listen || !Number.isInteger(listen.port) || !fallback) throw new Error("usage: agent-fleet edge --listen HOST:PORT --route /p=http://h:port … --fallback http://h:port");
  const edge = await startEdge({ listen, routes, fallback });
  process.stderr.write(`agent-fleet edge listening on ${listen.host}:${listen.port} routes=${routes.map(route => route.prefix).join(",")} fallback=${fallback}\n`);
  const stop = () => edge.stop().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return edge;
}
