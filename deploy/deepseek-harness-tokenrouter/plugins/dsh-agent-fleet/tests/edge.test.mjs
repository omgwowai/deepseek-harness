// Edge router behaviour: prefix routing, fallback, streaming, WebSocket passthrough, header rewrites, failures, logging.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import { startEdge } from "../lib/edge.mjs";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); });

function encodeFrame(text, mask) {
  const payload = Buffer.from(text);
  if (payload.length >= 126) throw new Error("test frames are short");
  if (!mask) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const key = randomBytes(4);
  const masked = Buffer.from(payload.map((byte, index) => byte ^ key[index % 4]));
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), key, masked]);
}

function decodeFrame(buffer) {
  const masked = (buffer[1] & 0x80) !== 0, length = buffer[1] & 0x7f, offset = masked ? 6 : 2;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) for (let index = 0; index < payload.length; index += 1) payload[index] ^= buffer[2 + (index % 4)];
  return { opcode: buffer[0] & 0x0f, text: payload.toString("utf8") };
}

const seen = { fleet: [], dsh: [], fallback: [], upgrades: [] };
const upgraded = new Set();
const logs = [];
let sseSecondWriteAt = 0;
let fleet, dsh, fallback, edge, edgePort;

before(async () => {
  fleet = http.createServer((request, response) => {
    seen.fleet.push({ url: request.url, headers: request.headers });
    if (request.url === "/redir") { response.writeHead(302, { location: "/login" }); response.end(); return; }
    if (request.url === "/cookie") { response.writeHead(200, { "set-cookie": ["a=1; Path=/; HttpOnly", "b=2"] }); response.end("ok"); return; }
    if (request.url === "/sse") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      response.write("data: one\n\n");
      setTimeout(() => { sseSecondWriteAt = performance.now(); response.write("data: two\n\n"); }, 300);
      return;
    }
    response.end(JSON.stringify({ url: request.url }));
  });
  dsh = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      seen.dsh.push({ url: request.url, method: request.method, body });
      response.end(JSON.stringify({ url: request.url, method: request.method, body }));
    });
  });
  dsh.on("upgrade", (request, socket) => {
    seen.upgrades.push({ url: request.url, host: request.headers.host });
    upgraded.add(socket);
    const accept = createHash("sha1").update(request.headers["sec-websocket-key"] + GUID).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const frame = buffer.length >= 2 ? decodeFrame(buffer) : null;
      if (frame) { buffer = Buffer.alloc(0); socket.write(encodeFrame(frame.text, false)); }
    });
    socket.on("end", () => socket.end());
    socket.on("error", () => {});
  });
  fallback = http.createServer((request, response) => {
    seen.fallback.push({ url: request.url });
    response.end(JSON.stringify({ url: request.url }));
  });
  const dead = http.createServer();
  const [fleetPort, dshPort, fallbackPort, deadPort] = await Promise.all([listen(fleet), listen(dsh), listen(fallback), listen(dead)]);
  await close(dead);
  edge = await startEdge({
    listen: { host: "127.0.0.1", port: 0 },
    routes: [
      { prefix: "/fleet", target: `http://127.0.0.1:${fleetPort}`, strip: true },
      { prefix: "/dsh", target: `http://127.0.0.1:${dshPort}`, strip: true },
      { prefix: "/dead", target: `http://127.0.0.1:${deadPort}`, strip: true },
    ],
    fallback: `http://127.0.0.1:${fallbackPort}`,
    log: line => logs.push(line),
  });
  edgePort = edge.address.port;
});

after(async () => {
  for (const socket of upgraded) socket.destroy();
  await edge.stop();
  await Promise.all([close(fleet), close(dsh), close(fallback)]);
});

function send(path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port: edgePort, path, method, headers, agent: false }, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: text }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

test("prefix routes strip the prefix and pass the browser's Host through", async () => {
  const response = await send("/fleet/api/snapshot?token=secret123", { headers: { host: "10.0.60.98:443" } });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { url: "/api/snapshot?token=secret123" });
  const forwarded = seen.fleet.at(-1).headers;
  assert.equal(forwarded.host, "10.0.60.98:443");
  assert.equal(forwarded["x-forwarded-host"], "10.0.60.98:443");
  assert.equal(forwarded["x-forwarded-prefix"], "/fleet");
  assert.equal(forwarded["x-forwarded-proto"], "http");
});

test("request bodies reach the prefixed upstream", async () => {
  const body = JSON.stringify({ type: "client-request", method: "agent-fleet/snapshot", rpcId: "r1" });
  const response = await send("/dsh/api/agent-fleet/snapshot", { method: "POST", headers: { "content-type": "application/json" }, body });
  assert.deepEqual(JSON.parse(response.body), { url: "/api/agent-fleet/snapshot", method: "POST", body });
});

test("a bare prefix redirects with 302 (not 301) and forbids caching and referrers", async () => {
  for (const prefix of ["/fleet", "/dsh"]) {
    const response = await send(`${prefix}?x=1&token=secret123`);
    assert.equal(response.status, 302, `${prefix} must not be a permanent redirect`);
    assert.equal(response.headers.location, `${prefix}/?x=1&token=secret123`, "the query is kept; the credential stays in this one URL");
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["referrer-policy"], "no-referrer");
    assert.equal(response.headers["content-length"], "0");
    assert.equal(response.headers["set-cookie"], undefined);
    assert.equal(response.body, "");
  }
});

test("unmatched paths reach the fallback unchanged, including look-alike prefixes", async () => {
  assert.deepEqual(JSON.parse((await send("/reports/abc/report.html?v=2")).body), { url: "/reports/abc/report.html?v=2" });
  assert.deepEqual(JSON.parse((await send("/fleetish/x")).body), { url: "/fleetish/x" });
  assert.deepEqual(JSON.parse((await send("/")).body), { url: "/" });
});

test("redirects and cookies from a prefixed upstream are rewritten under the prefix", async () => {
  const redirect = await send("/fleet/redir");
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.location, "/fleet/login");
  const cookie = await send("/fleet/cookie");
  assert.deepEqual(cookie.headers["set-cookie"], ["a=1; Path=/fleet/; HttpOnly", "b=2; Path=/fleet/"]);
});

test("server-sent events pass through without buffering", async () => {
  const chunks = [];
  await new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port: edgePort, path: "/fleet/sse", agent: false }, response => {
      assert.equal(response.headers["content-type"], "text/event-stream");
      response.setEncoding("utf8");
      response.on("data", chunk => {
        chunks.push({ chunk, at: performance.now() });
        if (chunk.includes("two")) { request.destroy(); resolve(); }
      });
    });
    request.on("error", error => { if (chunks.length === 0) reject(error); });
  });
  assert.ok(chunks[0].chunk.includes("one"), "first event delivered on its own");
  assert.ok(chunks[0].at < sseSecondWriteAt, "first event arrived before the upstream wrote the second");
  const second = chunks.find(item => item.chunk.includes("two"));
  assert.ok(second.at - sseSecondWriteAt < 100, `second event took ${(second.at - sseSecondWriteAt).toFixed(1)} ms through the edge`);
});

test("websocket upgrades are piped both ways under the stripped path", async () => {
  const key = randomBytes(16).toString("base64");
  const socket = net.connect(edgePort, "127.0.0.1");
  await once(socket, "connect");
  let buffer = Buffer.alloc(0);
  const readUntil = predicate => new Promise((resolve, reject) => {
    const check = () => { const result = predicate(buffer); if (result) { socket.off("data", onData); resolve(result); } };
    const onData = chunk => { buffer = Buffer.concat([buffer, chunk]); check(); };
    socket.on("data", onData);
    socket.once("error", reject);
    check();
  });
  socket.write(`GET /dsh/ws?token=abc HTTP/1.1\r\nHost: 10.0.60.98:443\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  const head = await readUntil(data => { const end = data.indexOf("\r\n\r\n"); return end >= 0 ? { text: data.subarray(0, end).toString(), rest: end + 4 } : null; });
  assert.match(head.text, /^HTTP\/1\.1 101/);
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  assert.match(head.text, new RegExp(`sec-websocket-accept: ${escapeRe(accept)}`, "i"));
  buffer = buffer.subarray(head.rest);
  socket.write(encodeFrame("hello fleet", true));
  const frame = await readUntil(data => data.length >= 2 ? decodeFrame(data) : null);
  assert.equal(frame.text, "hello fleet");
  assert.deepEqual(seen.upgrades.at(-1), { url: "/ws?token=abc", host: "10.0.60.98:443" });
  socket.destroy();
});

test("a dead upstream answers 502 with a short message", async () => {
  const response = await send("/dead/anything");
  assert.equal(response.status, 502);
  assert.match(response.body, /upstream \/dead unavailable/);
});

test("the access log never records query strings", async () => {
  await send("/fleet/api/x?token=supersecret");
  assert.ok(logs.some(line => line.includes("/fleet/api/x")));
  for (const line of logs) {
    assert.doesNotMatch(line, /\?/);
    assert.doesNotMatch(line, /secret|token=/);
  }
});
