// DSH plugin slice: index.js (host), client.js (browser), configure.mjs, the pack's install.mjs entry.
// The host plugin runs against a fake ctx and a stub hub HTTP server; the tool's schema and registration are also
// checked against DSH's real tool registry / shell-env / cordis when a DSH install is found next to this node binary
// (or via DSH_TOOLS_ENTRY / DSH_PACKAGES); those tests are skipped, loudly, when it is not.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { apply } from "../index.js";
import { createFleetTool, ACTIONS, OUTPUT_CAP_BYTES } from "../lib/plugin/tool.mjs";
import { resolveConfig } from "../lib/plugin/config.mjs";
import { startEmbedded } from "../lib/plugin/embedded.mjs";
import { upsertFleetRow } from "../lib/plugin/patch-file.mjs";

const F = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACK = resolve(F, "..", "..");
const NODE = process.execPath;
const SCRATCH = join(F, ".scratch", `plugin-test-${process.pid}`);
mkdirSync(SCRATCH, { recursive: true });
after(() => rmSync(SCRATCH, { recursive: true, force: true }));
const scratch = name => mkdtempSync(join(SCRATCH, `${name}-`));

/* ───────────── DSH install (optional): real defineTool, tool registry, shell-env, cordis, yaml ───────────── */

const DSH_PACKAGES = [process.env.DSH_PACKAGES, join(dirname(NODE), "..", "..", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai")].find(path => path && existsSync(path));
const dshModule = async rel => import(pathToFileURL(join(DSH_PACKAGES, rel)).href);
const dshToolsEntry = process.env.DSH_TOOLS_ENTRY ?? (DSH_PACKAGES && join(DSH_PACKAGES, "dsh-tools", "lib", "index.js"));
const realTools = dshToolsEntry && existsSync(dshToolsEntry) ? await import(pathToFileURL(dshToolsEntry).href) : null;
const realYaml = DSH_PACKAGES && existsSync(join(DSH_PACKAGES, "..", "yaml")) ? (await import(pathToFileURL(join(DSH_PACKAGES, "..", "yaml", "dist", "index.js")).href).catch(() => null)) : null;
const needsDsh = { skip: realTools === null ? "no DSH install found (set DSH_PACKAGES or DSH_TOOLS_ENTRY)" : false };

/** `defineTool` with the real one's contract where the DSH install is missing: validation is not exercised then. */
const passthroughDefineTool = options => ({ ...options, execute: (args, exec) => options.execute(args, exec) });
const defineTool = realTools?.defineTool ?? passthroughDefineTool;

/* ───────────── fixtures ───────────── */

const NOW = Date.parse("2026-10-30T08:00:00Z");
const TOKEN = "a1".repeat(32);
const DSH_ID = "session-aaaa1111-0000-4000-8000-000000000001";
const OMP_ID = "01a18adc-49ee-7345-8b51-9e75b06a2614";
const DSH_KEY = `mac#dsh:${DSH_ID}`, OMP_KEY = `mac#omp:${OMP_ID}`, SUB_KEY = `mac#omp:${OMP_ID}-sub1`, POD_HOST = "k8s/os/pod-x", CLAUDE_KEY = `${POD_HOST}#claude:c1`;
const POD_KEY = "os/mc-bochao-li/pod-x";

function agent(over) {
  const record = {
    file: `/x/${over.id}.jsonl`, cwd: "/work/demo", title: "", model: "model-1", role: "main", parent: null,
    startedAt: NOW - 3_600_000, updatedAt: NOW - 5000, endedAt: null, status: "running",
    live: { alive: true, state: "tool", since: NOW - 4000, doing: "bash ls", turnOpen: true },
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    counts: { turns: 1, tools: 2, errors: 0, subagents: 0, events: 3 },
    site: over.host.startsWith("k8s/") ? over.host.split("/")[1] : over.host, ...over,
  };
  return { key: `${record.host}#${record.kind}:${record.id}`, ...record };
}

function toolEvent(n, over = {}) {
  return {
    id: `call-${n}`, type: "tool", t: NOW - n * 1000, name: "bash", category: "shell", status: "ok", duration: 120,
    preview: `${"echo hello ".repeat(30)}#${n}`,
    targets: [{ type: "file", op: "read", host: "mac", path: `/work/demo/f${n % 7}.txt` }, { type: "pod", op: "exec", site: "os", cluster: "ulanqab-osmium", namespace: "mc-bochao-li", name: "pod-x" }],
    ...over,
  };
}

function makeFleet({ filler = 0 } = {}) {
  const dsh = agent({ host: "mac", kind: "dsh", id: DSH_ID, title: "Fix the build", acp: { provider: "acp-omp", kind: "omp", id: OMP_ID } });
  const omp = agent({ host: "mac", kind: "omp", id: OMP_ID, title: "ACP omp child", parent: { kind: "dsh", id: DSH_ID, key: DSH_KEY, via: "acp", exact: true } });
  const sub = agent({ host: "mac", kind: "omp", id: `${OMP_ID}-sub1`, role: "subagent", name: "Task1", title: "", startedAt: NOW - 3_000_000, updatedAt: NOW - 20_000, parent: { key: OMP_KEY, via: "file", exact: true }, status: "done", endedAt: NOW - 20_000 });
  const remote = agent({ host: POD_HOST, kind: "claude", id: "c1", title: "claude in the pod", startedAt: NOW - 2_000_000, parent: { key: OMP_KEY, via: "command", exact: false }, live: { alive: true, state: "model", since: NOW - 1000, doing: "thinking", turnOpen: true } });
  const projection = agent({ host: "mac", kind: "dsh", id: "session-dsh-acp-abc", role: "projection", title: "mirror" });
  const many = Array.from({ length: filler }, (_, n) => agent({ host: "server-bochao-01", kind: ["omp", "claude", "codex"][n % 3], id: `filler-${n}`, title: `filler agent ${n} ${"long title ".repeat(12)}`, status: ["running", "idle", "done"][n % 3], updatedAt: NOW - n * 1000, cwd: `/data/run-${n}/work/some/very/deep/directory/path` }));
  const hosts = [
    { id: "mac", site: "mac", kind: "workstation", label: "Mac", status: "online", via: "socket", lagMs: 400, counts: { agents: 5, running: 3 } },
    { id: "server-bochao-01", site: "server-bochao-01", kind: "server", label: "server", status: "online", via: "local", counts: { agents: filler, running: 0 } },
    { id: POD_HOST, site: "os", kind: "pod", label: "pod-x", status: "offline", via: "pod-exec", error: "kubectl exec: connection refused", counts: { agents: 1, running: 1 } },
  ];
  const pods = [
    { key: POD_KEY, site: "os", cluster: "ulanqab-osmium", namespace: "mc-bochao-li", name: "pod-x", phase: "Running", ready: "1/1", restarts: 0, node: "n1", createdAt: NOW - 7_200_000, containers: [{ name: "main", image: "img:1", ready: true, state: "running", restarts: 0 }], requests: { gpu: 8 }, labels: {}, collect: true, hostId: POD_HOST },
    { key: "chengdu/mc-bochao-li/pod-x", site: "chengdu", cluster: "chengdu", namespace: "mc-bochao-li", name: "pod-x", phase: "Pending", ready: "0/1", restarts: 2, containers: [{ name: "main", image: "img:2", ready: false, state: "waiting: ImagePullBackOff", restarts: 2 }], requests: {}, labels: {}, collect: false },
  ];
  const links = [
    { from: DSH_KEY, to: OMP_KEY, via: "acp", exact: true, crossHost: false, crossSite: false },
    { from: OMP_KEY, to: SUB_KEY, via: "file", exact: true, crossHost: false, crossSite: false },
    { from: OMP_KEY, to: CLAUDE_KEY, via: "command", exact: false, crossHost: true, crossSite: true },
  ];
  return { hosts, pods, links, agents: [dsh, omp, sub, remote, projection, ...many], family: [dsh, omp, sub, remote] };
}

function hubHandlers(fleet, over = {}) {
  const events = { [DSH_KEY]: [toolEvent(1)], [OMP_KEY]: [toolEvent(2), toolEvent(3)], [SUB_KEY]: [toolEvent(4)], [CLAUDE_KEY]: [toolEvent(5)] };
  return {
    snapshot: () => ({ cursor: 42, now: NOW, hub: { version: "0.1.0", startedAt: NOW - 1_000_000, hostId: "server-bochao-01" }, hosts: fleet.hosts, agents: fleet.agents, links: fleet.links, pods: fleet.pods, feed: [] }),
    changes: ({ since }) => ({ cursor: 43, now: NOW, since: Number(since) }),
    family: ({ key }) => ({ root: key, agents: fleet.family, links: fleet.links, events }),
    agent: ({ key, limit }) => ({ key, events: (events[key] ?? []).slice(-Number(limit ?? 50)), hasMore: false }),
    pod: ({ key }) => ({ pod: fleet.pods.find(pod => pod.key === key) ?? null, touches: [{ agent: OMP_KEY, event: "call-2", t: NOW - 2000, op: "exec", category: "k8s", name: "bash", preview: "kubectl exec pod-x" }], events: [{ type: "Warning", reason: "BackOff", message: "Back-off restarting", count: 3, lastSeen: NOW - 5000 }] }),
    file: ({ host, path }) => ({ host, path, exists: true, size: 11, mtime: NOW - 60_000, content: "hello world", redactions: 0 }),
    query: () => ({ items: [{ agent: OMP_KEY, event: toolEvent(2) }], total: 1 }),
    hosts: () => ({ hosts: fleet.hosts }),
    health: () => ({ ok: true }),
    ...over,
  };
}

/** A hub in memory: `request(method, params)` like hub.api.request; records the calls. */
function memoryHub(handlers) {
  const calls = [];
  return { calls, handlers, async request(method, params) { calls.push([method, params]); if (!handlers[method]) throw new Error(`no handler ${method}`); return structuredClone(await handlers[method](params ?? {})); } };
}

async function startStubHub(handlers, { token = TOKEN } = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://hub.test");
    const method = url.pathname.replace(/^\/api\//, "");
    const query = Object.fromEntries(url.searchParams);
    calls.push({ method, query, token: req.headers["x-agent-fleet-token"] });
    const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.headers["x-agent-fleet-token"] !== token) return send(401, { error: "unauthorized" });
    const handler = handlers[method];
    if (!handler) return send(404, { error: `no route ${method}` });
    Promise.resolve(handler(query)).then(body => send(200, body), error => send(500, { error: error.message }));
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => { server.closeAllConnections(); return new Promise(done => server.close(done)); } };
}

/* ───────────── fake DSH host ctx ───────────── */

function fakeCtx({ home, tools = true, shellEnv = true } = {}) {
  const routes = new Map(), disposers = [], logs = [], registeredTools = [], contributors = [];
  const services = { ...(tools ? { tools: { register: definition => { registeredTools.push(definition); return () => {}; } } } : {}), ...(shellEnv ? { shellEnv: { register: contributor => { contributors.push(contributor); return () => {}; } } } : {}) };
  const ctx = {
    routes, logs, registeredTools, contributors, disposers,
    logger: { warn: message => logs.push(["warn", message]), info: message => logs.push(["info", message]), error: message => logs.push(["error", message]) },
    effect(execute) {
      const result = execute();
      if (typeof result === "function") disposers.push(result);
      else if (result && typeof result[Symbol.iterator] === "function") for (const dispose of result) disposers.push(dispose);
      return result;
    },
    get: name => (name === "dshHomePath" ? () => home : undefined),
    connection: { fetch: { register(route) { routes.set(route.path, route); return async () => { routes.delete(route.path); }; } } },
    inject(deps, callback) { if (deps.every(name => name in services)) callback({ ...ctx, ...services }); },
    async dispose() { for (const dispose of disposers.splice(0).reverse()) await dispose(); },
  };
  return ctx;
}

async function rpc(ctx, method, payload = {}, rpcId = "rpc-1") {
  const route = ctx.routes.get(`/api/${method}`);
  assert.ok(route, `route /api/${method} registered`);
  const response = await route.fetch(new Request(`http://dsh.test/api/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "client-request", rpcId, method, payload }) }));
  return { status: response.status, body: await response.json().catch(() => null), response };
}

const writeToken = dir => { const file = join(dir, "token"); writeFileSync(file, `${TOKEN}\n`, { mode: 0o600 }); return file; };

async function loadPlugin(config, options = {}) {
  const ctx = fakeCtx(options);
  await apply(ctx, config, { loadDefineTool: async () => defineTool, ...options.deps });
  return ctx;
}

/** Runs a tool call like the registry does and returns what the model sees. */
async function callTool(tool, args) {
  const value = await tool.execute(args, { signal: new AbortController().signal });
  const text = tool.output.render(args, value)[0].text;
  return { value, text, data: JSON.parse(text.slice(text.indexOf("\n") + 1)) };
}

/* ───────────── host plugin: routes, auth, envelope ───────────── */

describe("host plugin in remote mode", () => {
  test("registers the seven RPC routes, the agent_fleet tool and the shell variables", async () => {
    const dir = scratch("remote"), ctx = await loadPlugin({ mode: "remote", hubUrl: "http://127.0.0.1:1", tokenFile: writeToken(dir) }, { home: dir });
    assert.deepEqual([...ctx.routes.keys()].sort(), ["snapshot", "changes", "family", "file", "pod", "query", "panel-url"].map(name => `/api/agent-fleet/${name}`).sort());
    for (const route of ctx.routes.values()) assert.deepEqual([route.methods, route.requestBody], [["POST"], "buffered"]);
    assert.equal(ctx.registeredTools.length, 1);
    assert.equal(ctx.registeredTools[0].name, "agent_fleet");
    assert.equal(ctx.registeredTools[0].isConcurrencySafe({ action: "list" }), true);
    const [contributor] = ctx.contributors;
    assert.equal(contributor.name, "agent-fleet");
    assert.deepEqual(Object.keys(contributor.variables), ["DSH_AGENT_FLEET_PARENT", "DSH_AGENT_FLEET_PARENT_CALL"]);
    for (const [key, variable] of Object.entries(contributor.variables)) { assert.match(key, /^DSH_[A-Z][A-Z0-9_]*$/); assert.ok(variable.description.trim() !== ""); }
    assert.deepEqual(contributor.resolve({ agent: { session: { header: { id: "session-x" } } }, callId: "call-1" }), { DSH_AGENT_FLEET_PARENT: "dsh:session-x", DSH_AGENT_FLEET_PARENT_CALL: "call-1" });
    assert.deepEqual(contributor.resolve({ callId: "call-1" }), {}, "no agent: no variables");
  });

  test("RPC envelope round-trip against a stub hub: token header, query strings, error envelope", async () => {
    const dir = scratch("rpc"), fleet = makeFleet(), hub = await startStubHub(hubHandlers(fleet));
    try {
      const ctx = await loadPlugin({ mode: "remote", hubUrl: hub.url, tokenFile: writeToken(dir) }, { home: dir });
      const snap = await rpc(ctx, "agent-fleet/snapshot", {}, "id-7");
      assert.equal(snap.status, 200);
      assert.equal(snap.response.headers.get("cache-control"), "no-store");
      assert.equal(snap.body.type, "server-response");
      assert.equal(snap.body.rpcId, "id-7");
      assert.equal(snap.body.result.ok, true);
      assert.equal(snap.body.result.value.agents.length, fleet.agents.length);
      assert.equal(hub.calls.at(-1).token, TOKEN, "the hub token travels in x-agent-fleet-token");

      assert.equal((await rpc(ctx, "agent-fleet/changes", { since: 41.9 })).body.result.value.since, 41, "since is truncated to an integer");
      assert.equal((await rpc(ctx, "agent-fleet/changes", { since: "junk" })).body.result.value.since, 0);
      const file = await rpc(ctx, "agent-fleet/file", { host: "mac", path: "/work/demo/a b&c.txt" });
      assert.deepEqual(file.body.result.value.path, "/work/demo/a b&c.txt", "paths survive query-string encoding");
      assert.equal((await rpc(ctx, "agent-fleet/pod", { key: POD_KEY })).body.result.value.pod.key, POD_KEY);
      await rpc(ctx, "agent-fleet/query", { kind: "omp", target: "pod", limit: 5, unknown: "dropped" });
      const query = hub.calls.findLast(call => call.method === "query").query;
      assert.deepEqual(query, { kind: "omp", target: "pod", limit: "5" }, "only the documented filters are forwarded");

      const missing = await rpc(ctx, "agent-fleet/file", { host: "mac" });
      assert.equal(missing.body.result.ok, false);
      assert.equal(missing.body.result.error.code, "agent-fleet/unavailable");
      assert.match(missing.body.result.error.message, /path must be a non-empty string/);
      assert.deepEqual(missing.body.result.error.details, {}, "DSH requires a details object on failures");

      const route = ctx.routes.get("/api/agent-fleet/snapshot");
      const bad = body => route.fetch(new Request("http://dsh.test/api/agent-fleet/snapshot", { method: "POST", body }));
      assert.equal((await bad("not json")).status, 400);
      assert.equal((await bad(JSON.stringify({ type: "client-request", rpcId: "r", method: "agent-fleet/changes", payload: {} }))).status, 400, "method must match the route");
      assert.equal((await bad(JSON.stringify({ type: "client-request", method: "agent-fleet/snapshot" }))).status, 400, "rpcId is required");
      assert.equal((await bad(JSON.stringify({ type: "server-response", rpcId: "r", method: "agent-fleet/snapshot" }))).status, 400);
    } finally { await hub.close(); }
  });

  test("agent-fleet/family resolves a DSH session id, or the native session bound to it, to its family", async () => {
    const dir = scratch("family"), fleet = makeFleet(), hub = await startStubHub(hubHandlers(fleet));
    try {
      const ctx = await loadPlugin({ mode: "remote", hubUrl: hub.url, tokenFile: writeToken(dir) }, { home: dir });
      const byDsh = await rpc(ctx, "agent-fleet/family", { dshSessionId: DSH_ID });
      assert.equal(byDsh.body.result.value.resolved, DSH_KEY);
      assert.equal(hub.calls.findLast(call => call.method === "family").query.key, DSH_KEY);
      assert.equal((await rpc(ctx, "agent-fleet/family", { key: OMP_KEY })).body.result.value.root, OMP_KEY, "an explicit key is passed through");
      assert.match((await rpc(ctx, "agent-fleet/family", { dshSessionId: "session-nope" })).body.result.error.message, /no agent matches DSH session session-nope/);
      assert.match((await rpc(ctx, "agent-fleet/family", {})).body.result.error.message, /dshSessionId/);

      // only the native record is known (the DSH record is not in the snapshot yet): the ACP-bound agent answers for the session
      const nativeOnly = { ...fleet, agents: fleet.agents.filter(item => item.key !== DSH_KEY) };
      const hub2 = await startStubHub(hubHandlers(nativeOnly));
      try {
        const ctx2 = await loadPlugin({ mode: "remote", hubUrl: hub2.url, tokenFile: writeToken(dir) }, { home: dir });
        assert.equal((await rpc(ctx2, "agent-fleet/family", { dshSessionId: DSH_ID })).body.result.value.resolved, OMP_KEY);
      } finally { await hub2.close(); }
    } finally { await hub.close(); }
  });

  test("an unreachable hub, a wrong token and a missing token file are RPC errors, never crashes", async () => {
    const dir = scratch("down"), hub = await startStubHub(hubHandlers(makeFleet()), { token: "b2".repeat(32) });
    try {
      const wrong = await loadPlugin({ mode: "remote", hubUrl: hub.url, tokenFile: writeToken(dir) }, { home: dir });
      assert.match((await rpc(wrong, "agent-fleet/snapshot")).body.result.error.message, /rejected the token \(401\).*tokenFile/);
      const none = await loadPlugin({ mode: "remote", hubUrl: hub.url, tokenFile: join(dir, "absent") }, { home: dir });
      assert.match((await rpc(none, "agent-fleet/snapshot")).body.result.error.message, /rejected the token/, "no token file: the request goes out without one and is refused");
    } finally { await hub.close(); }
    const closed = await loadPlugin({ mode: "remote", hubUrl: hub.url, tokenFile: writeToken(dir) }, { home: dir });
    const down = (await rpc(closed, "agent-fleet/snapshot")).body.result;
    assert.equal(down.ok, false);
    assert.match(down.error.message, /unreachable at http:\/\/127\.0\.0\.1:\d+.*is the hub running/);
  });

  test("panel-url: same-origin /fleet/ and loopback hubs get a one-time nonce in the fragment, other hosts never, validation", async () => {
    const dir = scratch("panel"), tokenFile = writeToken(dir);
    const hub = await startStubHub({ "session-nonce": () => ({ nonce: "n1", expiresAt: NOW + 60_000 }) });
    try {
      const remote = await loadPlugin({ mode: "remote", hubUrl: hub.url, tokenFile }, { home: dir });
      assert.equal((await rpc(remote, "agent-fleet/panel-url", {})).body.result.value.url, "/fleet/#nonce=n1");
      assert.equal((await rpc(remote, "agent-fleet/panel-url", { sessionId: DSH_ID })).body.result.value.url, `/fleet/#nonce=n1&focus=${DSH_ID}`, "a root-relative panel is on the DSH page's own origin");
      assert.equal(hub.calls.filter(call => call.method === "session-nonce").length, 2, "each panel URL mints its own single-use nonce");
      assert.equal(hub.calls.find(call => call.method === "session-nonce").token, TOKEN, "the nonce is minted with the hub token in a header, never in a URL");
      const direct = await loadPlugin({ mode: "remote", hubUrl: hub.url, tokenFile, panelUrl: "http://127.0.0.1:7840/" }, { home: dir });
      assert.equal((await rpc(direct, "agent-fleet/panel-url", { sessionId: "session-a b" })).body.result.error.message, "invalid DSH session id");
      const loopback = (await rpc(direct, "agent-fleet/panel-url", { sessionId: DSH_ID })).body.result.value.url;
      assert.equal(loopback, `http://127.0.0.1:7840/#nonce=n1&focus=${DSH_ID}`);
      assert.ok(!loopback.includes(TOKEN), "the hub token appears nowhere in the URL");
      const external = await loadPlugin({ mode: "remote", hubUrl: hub.url, tokenFile, panelUrl: "https://fleet.example.test/panel/" }, { home: dir });
      const url = (await rpc(external, "agent-fleet/panel-url", {})).body.result.value.url;
      assert.equal(url, "https://fleet.example.test/panel/", "no credential is ever put into a non-loopback URL");
      assert.equal(hub.calls.filter(call => call.method === "session-nonce").length, 3, "a foreign base mints nothing");
      assert.throws(() => resolveConfig({ panelUrl: "http://127.0.0.1:7840/?token=abc" }), /must not contain \? or #/);
    } finally { await hub.close(); }
    const oldHub = await startStubHub({});                          // a hub from before the nonce endpoint: no fallback to the token
    try {
      const stale = await loadPlugin({ mode: "remote", hubUrl: oldHub.url, tokenFile }, { home: dir });
      const failure = (await rpc(stale, "agent-fleet/panel-url", {})).body.result;
      assert.equal(failure.ok, false);
      assert.match(failure.error.message, /refused a panel session nonce: HTTP 404/);
    } finally { await oldHub.close(); }
  });

  test("tool calls and RPCs within a second share one snapshot request", async () => {
    const dir = scratch("cache"), hub = await startStubHub(hubHandlers(makeFleet()));
    try {
      const ctx = await loadPlugin({ mode: "remote", hubUrl: hub.url, tokenFile: writeToken(dir) }, { home: dir });
      const [tool] = ctx.registeredTools;
      await Promise.all([callTool(tool, { action: "overview" }), callTool(tool, { action: "list" }), rpc(ctx, "agent-fleet/snapshot")]);
      assert.equal(hub.calls.filter(call => call.method === "snapshot").length, 1);
    } finally { await hub.close(); }
  });

  test("without @deepseek-ai/dsh-tools the routes still work and the missing tool is logged once", async () => {
    const dir = scratch("notools"), ctx = await loadPlugin({ mode: "remote", tokenFile: writeToken(dir) }, { home: dir, deps: { loadDefineTool: async () => { throw new Error("Cannot find package '@deepseek-ai/dsh-tools'"); } } });
    assert.equal(ctx.registeredTools.length, 0);
    assert.equal(ctx.logs.filter(([, message]) => message.includes("model tool agent_fleet not registered")).length, 1);
    assert.equal(ctx.routes.size, 7);
    assert.equal(ctx.contributors.length, 1, "the shell variables do not depend on the tool");
  });

  test("a DSH build without the tools registry or shell-env still loads the plugin", async () => {
    const dir = scratch("bare"), ctx = await loadPlugin({ mode: "remote", tokenFile: writeToken(dir) }, { home: dir, tools: false, shellEnv: false });
    assert.equal(ctx.routes.size, 7);
    assert.deepEqual([ctx.registeredTools.length, ctx.contributors.length], [0, 0]);
    // a registry that refuses the registration (e.g. a duplicate name) is logged, not thrown
    const refusing = fakeCtx({ home: dir });
    const original = refusing.inject;
    refusing.inject = (deps, callback) => original(deps, serviceCtx => callback({ ...serviceCtx, tools: { register() { throw new Error("tool name is already registered"); } }, shellEnv: { register() { throw new Error("key already owned"); } } }));
    await apply(refusing, { mode: "remote", tokenFile: writeToken(dir) }, { loadDefineTool: async () => defineTool });
    assert.equal(refusing.logs.filter(([level]) => level === "warn").length, 2);
  });

  test("a config the plugin cannot use fails loudly at load", () => {
    assert.throws(() => apply(fakeCtx({ home: "/x" }), { mode: "sideways" }), /mode must be "remote" or "embedded"/);
    assert.throws(() => apply(fakeCtx({ home: "/x" }), { hubUrl: "ftp://hub" }), /hubUrl must be http\(s\)/);
    assert.throws(() => apply(fakeCtx({ home: "/x" }), { modee: "remote" }), /unknown key "modee"/);
    assert.throws(() => apply(fakeCtx({ home: "/x" }), { upstream: { sshTarget: "-oProxyCommand=evil" } }), /plain ssh login/);
  });
});

/* ───────────── embedded mode ───────────── */

describe("embedded mode (desktop)", () => {
  function embeddedDeps({ failStart = false } = {}) {
    const record = { startHub: [], collectors: [], stopped: [], links: [], hubStopped: 0, requests: [] };
    return {
      record,
      deps: {
        startHub: async options => {
          if (failStart) throw new Error("EADDRINUSE 127.0.0.1:7846");
          record.startHub.push(options);
          return { api: { request: async (method, params) => { record.requests.push([method, params]); return { cursor: 1, via: "embedded" }; } }, stop: async () => { record.hubStopped += 1; } };
        },
        startCollector: options => { const collector = { options, handleRequest: (method, params) => ({ method, params }), stop: () => record.stopped.push(options) }; record.collectors.push(collector); return collector; },
        sshForwardTransport: options => ({ ...options, kind: "ssh" }),
        keepConnected: options => { const link = { options, stopped: false, stop() { this.stopped = true; } }; record.links.push(link); return link; },
      },
    };
  }

  test("starts the local hub with a local collector, follows the server hub and pushes to its ingest over ssh", async () => {
    const dir = scratch("embedded"), tokenFile = join(dir, "token"), upstreamToken = join(dir, "up-token"), ingestToken = join(dir, "ingest-token");
    writeFileSync(upstreamToken, `${TOKEN}\n`);
    writeFileSync(ingestToken, `${TOKEN}-ingest\n`);
    const { deps, record } = embeddedDeps();
    const ctx = await loadPlugin({ mode: "embedded", tokenFile, upstream: { sshTarget: "bochao_li@10.0.60.98", tokenFile: upstreamToken, ingestTokenFile: ingestToken }, collector: { since: "6h", roots: { omp: ["/extra/omp"] } } }, { home: dir, deps: { loadEmbedded: async () => deps } });
    const snap = await rpc(ctx, "agent-fleet/snapshot");
    assert.deepEqual(snap.body.result.value, { cursor: 1, via: "embedded" }, "RPCs go through hub.api.request in-process");
    assert.deepEqual(record.requests[0], ["snapshot", {}]);

    const [hub] = record.startHub;
    assert.equal(hub.hostId, "mac");
    assert.deepEqual([hub.http.host, hub.http.port, hub.http.tokenFile], ["127.0.0.1", 7846, tokenFile]);
    assert.ok(hub.http.panelDir.endsWith(join("dsh-agent-fleet", "panel") + "/") || hub.http.panelDir.endsWith(join("dsh-agent-fleet", "panel")));
    assert.deepEqual(hub.upstream, { url: "http://127.0.0.1:7840", token: TOKEN, sshTarget: "bochao_li@10.0.60.98" });
    assert.equal(hub.local.collectorOptions.hostInfo.id, "mac");
    assert.equal(hub.local.collectorOptions.hostInfo.kind, "workstation");
    assert.equal(hub.local.collectorOptions.since, 6 * 3_600_000);
    assert.deepEqual(hub.local.collectorOptions.roots.dsh, [join(dir, "sessions")], "the DSH home of this process is the DSH root");
    assert.ok(hub.local.collectorOptions.roots.omp.includes("/extra/omp") && hub.local.collectorOptions.roots.omp.some(root => root.endsWith(".omp/agent/sessions")));

    const [link] = record.links;
    assert.deepEqual(await link.options.connect(), { target: "bochao_li@10.0.60.98", port: 7841, kind: "ssh" }, "the ingest credential is read before each ssh connect, then dialled");
    const sent = [];
    link.options.onChannel({ send: message => sent.push(message) });
    assert.equal(record.collectors.length, 1);
    record.collectors[0].options.send({ t: "hello" });
    record.collectors[0].options.send({ t: "agent", agent: { key: "k" } });
    assert.deepEqual(sent, [{ t: "hello", token: `${TOKEN}-ingest` }, { t: "agent", agent: { key: "k" } }], "only the hello carries the ingest token; the collector sends through the ssh channel");
    assert.deepEqual(await link.options.channelOptions.onRequest("file.read", { path: "/x" }), { method: "file.read", params: { path: "/x" } });
    link.options.channelOptions.onClose("peer closed");
    assert.equal(record.stopped.length, 1, "a closed channel stops its collector");
    link.options.onChannel({ send() {} });
    assert.equal(record.collectors.length, 2, "a reconnect starts a fresh collector (new hello + initial load)");

    await ctx.dispose();
    assert.equal(link.stopped, true);
    assert.equal(record.hubStopped, 1);
    assert.equal(record.stopped.length, 2);
  });

  test("without a server token or ssh target the desktop hub runs alone; a hub that cannot start is reported to the caller", async () => {
    const dir = scratch("embedded-alone"), { deps, record } = embeddedDeps();
    const ctx = await loadPlugin({ mode: "embedded", tokenFile: join(dir, "token"), upstream: { sshTarget: "bochao_li@10.0.60.98", tokenFile: join(dir, "missing") } }, { home: dir, deps: { loadEmbedded: async () => deps } });
    await rpc(ctx, "agent-fleet/snapshot");
    assert.equal(record.startHub[0].upstream, undefined);
    assert.ok(ctx.logs.some(([level, message]) => level === "warn" && message.includes("has no token for the server hub")));
    const noSsh = await loadPlugin({ mode: "embedded", tokenFile: join(dir, "token") }, { home: dir, deps: { loadEmbedded: async () => embeddedDeps().deps } });
    await rpc(noSsh, "agent-fleet/snapshot");
    assert.ok(noSsh.logs.some(([, message]) => message.includes("not pushed to the server hub")));

    const failing = await loadPlugin({ mode: "embedded", tokenFile: join(dir, "token") }, { home: dir, deps: { loadEmbedded: async () => embeddedDeps({ failStart: true }).deps } });
    const failure = (await rpc(failing, "agent-fleet/snapshot")).body.result;
    assert.equal(failure.ok, false);
    assert.match(failure.error.message, /embedded hub did not start: EADDRINUSE/);
    assert.equal((await rpc(failing, "agent-fleet/panel-url", {})).body.result.ok, false, "panel-url waits for the hub and reports why it is down");
    await failing.dispose();
  });

  test("panel-url points at the local hub with a one-time nonce in the fragment", async () => {
    const dir = scratch("embedded-panel"), tokenFile = join(dir, "token");
    writeFileSync(tokenFile, `${TOKEN}\n`);
    const stub = await startStubHub({ "session-nonce": () => ({ nonce: "n2", expiresAt: NOW + 60_000 }) });
    const port = Number(new URL(stub.url).port);
    try {
      const ctx = await loadPlugin({ mode: "embedded", tokenFile, httpPort: port }, { home: dir, deps: { loadEmbedded: async () => embeddedDeps().deps } });
      const url = (await rpc(ctx, "agent-fleet/panel-url", { sessionId: DSH_ID })).body.result.value.url;
      assert.equal(url, `http://127.0.0.1:${port}/#nonce=n2&focus=${DSH_ID}`, "the nonce is minted from this process's own hub port, not the panel base");
      assert.ok(!url.includes(TOKEN));
      await ctx.dispose();
    } finally { await stub.close(); }
  });

  test("upstream.ingestTokenFile: the push credential is a path the config normalizes, never a secret", () => {
    const defaults = resolveConfig({ mode: "embedded", upstream: { sshTarget: "u@h" } });
    assert.equal(defaults.upstream.ingestTokenFile, join(homedir(), ".config", "agent-fleet", "upstream-ingest-token"));
    assert.equal(defaults.upstream.tokenFile, join(homedir(), ".config", "agent-fleet", "upstream-token"), "the read token keeps its own default");
    const explicit = resolveConfig({ mode: "embedded", upstream: { sshTarget: "u@h", ingestTokenFile: "~/secrets/ingest" } });
    assert.equal(explicit.upstream.ingestTokenFile, join(homedir(), "secrets", "ingest"));
    assert.throws(() => resolveConfig({ mode: "embedded", upstream: { sshTarget: "u@h", ingestTokenFile: "relative/ingest" } }), /upstream\.ingestTokenFile must be an absolute path/);
  });

  test("startEmbedded stops the hub when the ssh uplink cannot be set up", async () => {
    const { deps, record } = embeddedDeps();
    deps.keepConnected = () => { throw new Error("spawn ssh ENOENT"); };
    await assert.rejects(startEmbedded({ settings: resolveConfig({ mode: "embedded", tokenFile: "/x/token", upstream: { sshTarget: "u@h" } }), dshHome: "/dsh", panelDir: "/p", version: "1", deps, log() {} }), /spawn ssh ENOENT/);
    assert.equal(record.hubStopped, 1);
  });
});

/* ───────────── model tool ───────────── */

describe("agent_fleet tool", () => {
  const tool = (handlers, extra = {}) => createFleetTool({ defineTool, hub: memoryHub(handlers), now: () => NOW, ...extra });

  test("registered schema is valid for DSH's tool registry", needsDsh, () => {
    const t = tool(hubHandlers(makeFleet()));
    assert.deepEqual(t.parameters.required, ["action"]);
    assert.deepEqual(t.parameters.properties.action.enum, ACTIONS);
    for (const name of ["key", "pod", "site", "host", "kind", "status", "role", "category", "target", "text", "since", "before", "path", "offset", "limit"]) assert.ok(t.parameters.properties[name], `parameter ${name}`);
    assert.equal(t.parameters.properties.kind.enum.join(), "dsh,claude,codex,omp");
    assert.match(t.description, /<host>#<kind>:<id>/);
    assert.match(t.description, /server-bochao-01#omp:/);
    assert.ok(JSON.stringify([t.description, t.parameters]).length < 8000, "the schema stays small: it is sent with every request");
    assert.equal(t.isConcurrencySafe({ action: "list" }), true);
    assert.equal(t.isConcurrencySafe({ action: "nonsense" }), false, "invalid arguments are never parallel-safe");
    assert.deepEqual(t.presentCall({ action: "list", kind: "omp", status: "running" }), { card: "generic", title: "Agent fleet · list kind=omp status=running", kind: "search" });
    assert.equal(t.presentCall({ action: "bogus" }), undefined);
  });

  test("invalid arguments are rejected by the schema, unknown agents and bad times by the actions", needsDsh, async () => {
    const t = tool(hubHandlers(makeFleet()));
    await assert.rejects(callTool(t, { action: "bogus" }), /invalid arguments/);
    await assert.rejects(callTool(t, { action: "list", kind: "gemini" }), /invalid arguments/);
    await assert.rejects(callTool(t, { action: "family" }), /needs key/);
    await assert.rejects(callTool(t, { action: "family", key: "mac#omp:nope" }), /no agent matches "mac#omp:nope".*action "list"/);
    await assert.rejects(callTool(t, { action: "list", since: "yesterday-ish" }), /cannot parse time/);
    await assert.rejects(callTool(t, { action: "pod" }), /needs pod/);
    await assert.rejects(callTool(t, { action: "pod", pod: "pod-x" }), /exists on several clusters \(os, chengdu\)/);
    await assert.rejects(callTool(t, { action: "pod", pod: "nope" }), /not tracked/);
    await assert.rejects(callTool(t, { action: "file", host: "mac" }), /needs path/);
  });

  test("overview, list and family answer from the snapshot", async () => {
    const t = tool(hubHandlers(makeFleet()));
    const overview = await callTool(t, { action: "overview" });
    assert.match(overview.value.summary, /3 running of 4 agents on 3 hosts \(1 not online\), 2 pods tracked/, "projection mirrors are not counted");
    assert.deepEqual(overview.data.hosts[0].id, POD_HOST, "hosts needing attention come first");
    assert.equal(overview.data.hosts[0].error, "kubectl exec: connection refused");
    assert.equal(overview.data.kinds.omp.running, 1);
    assert.deepEqual(overview.data.links, { total: 3, crossHost: 1, crossSite: 1 });
    assert.deepEqual(overview.data.sites.find(site => site.site === "mac"), { site: "mac", hosts: 1, agents: 3, running: 2 });

    const list = await callTool(t, { action: "list", host: "mac" });
    assert.deepEqual(list.data.agents.map(row => row.key), [DSH_KEY, OMP_KEY, SUB_KEY], "running first, newest first; the projection is hidden");
    assert.match(list.value.summary, /1 projection mirrors hidden/);
    assert.equal(list.data.agents[1].parent, DSH_KEY);
    assert.equal(list.data.agents[1].via, "acp");
    assert.equal(list.data.agents[2].via, undefined, "file links are the default and not repeated");
    assert.deepEqual((await callTool(t, { action: "list", role: "projection" })).data.agents.map(row => row.key), ["mac#dsh:session-dsh-acp-abc"]);
    assert.deepEqual((await callTool(t, { action: "list", status: "done" })).data.agents.map(row => row.key), [SUB_KEY]);
    assert.deepEqual((await callTool(t, { action: "list", text: "IN THE POD" })).data.agents.map(row => row.key), [CLAUDE_KEY]);
    assert.deepEqual((await callTool(t, { action: "list", since: "10s" })).data.agents.map(row => row.key), [DSH_KEY, OMP_KEY, CLAUDE_KEY], "only agents active within the last 10 s (the finished subagent drops out)");

    for (const ref of [DSH_ID, OMP_ID, OMP_KEY, `omp:${OMP_ID}`]) {
      const family = await callTool(t, { action: "family", key: ref });
      assert.deepEqual(family.data.agents.map(row => row.key), [DSH_KEY, OMP_KEY, SUB_KEY, CLAUDE_KEY], `family of ${ref} in tree order`);
      assert.deepEqual(family.data.agents.map(row => row.up), [undefined, 1, 2, 2]);
      assert.deepEqual(family.data.agents.map(row => row.cross), [undefined, undefined, undefined, "site"]);
      assert.equal(family.data.agents.find(row => row.focus).key, ref === DSH_ID ? DSH_KEY : OMP_KEY, "focus marks the agent the reference names");
      assert.equal(family.data.root, DSH_KEY);
      assert.equal(family.data.agents[3].events.length, 1);
    }
  });

  test("agent pages its events, pod merges touches and kube events, files aggregates file targets", async () => {
    const fleet = makeFleet();
    const events = Array.from({ length: 60 }, (_, n) => toolEvent(60 - n));          // oldest first
    const handlers = hubHandlers(fleet, { agent: ({ key, limit, before }) => ({ key, events: events.filter(event => before === undefined || event.t < Number(before)).slice(-Number(limit)), hasMore: true }) });
    const hub = memoryHub(handlers), t = createFleetTool({ defineTool, hub, now: () => NOW });
    const first = await callTool(t, { action: "agent", key: OMP_KEY, limit: 20 });
    assert.equal(first.data.events.length, 20);
    assert.equal(first.data.hasMore, true);
    assert.equal(first.data.agent.parent.key, DSH_KEY);
    assert.deepEqual(first.data.agent.children, [SUB_KEY, CLAUDE_KEY]);
    assert.equal(first.data.agent.acp, undefined);
    assert.equal(first.data.events.at(-1).at, "2026-10-30T07:59:59Z", "newest last");
    const second = await callTool(t, { action: "agent", key: OMP_KEY, limit: 20, before: first.data.pageBefore });
    assert.equal(second.data.events.at(-1).at < first.data.events[0].at, true, "the next page ends before the previous one began");
    assert.equal(hub.calls.findLast(([method]) => method === "agent")[1].before, Date.parse(first.data.pageBefore));

    const pod = await callTool(t, { action: "pod", pod: "os/mc-bochao-li/pod-x" });
    assert.equal(pod.data.pod.collector, "attached");
    assert.deepEqual(pod.data.touches[0], { at: "2026-10-30T07:59:58Z", agent: OMP_KEY, op: "exec", cat: "k8s", name: "bash", preview: "kubectl exec pod-x" });
    assert.equal(pod.data.kubeEvents[0].reason, "BackOff");
    assert.equal((await callTool(t, { action: "pod", pod: "pod-x", site: "chengdu" })).data.pod.phase, "Pending");
    assert.deepEqual((await callTool(t, { action: "pods", site: "chengdu" })).data.pods.map(row => [row.key, row.bad]), [["chengdu/mc-bochao-li/pod-x", ["main: waiting: ImagePullBackOff"]]]);

    const files = await callTool(t, { action: "files" });
    assert.ok(files.data.files.length > 0);
    const queryCall = hub.calls.findLast(([method]) => method === "query")[1];
    assert.equal(queryCall.target, "file");
    const forAgent = await callTool(t, { action: "files", key: OMP_KEY, text: "f2" });
    assert.deepEqual(forAgent.data.files.map(file => file.path), ["/work/demo/f2.txt"]);
    assert.deepEqual(forAgent.data.files[0].ops, { read: 9 }, "9 of the 60 events (n % 7 === 2) read f2.txt");
  });

  test("file previews page through long content and report refusals", async () => {
    const fleet = makeFleet(), big = '"'.repeat(100_000);
    const t = tool(hubHandlers(fleet, { file: ({ host, path }) => path.includes("secret") ? { host, path, exists: false, denied: "secret path" } : { host, path, exists: true, size: big.length, content: big, truncated: false, redactions: 2 } }));
    const first = await callTool(t, { action: "file", host: "mac", path: "/w/big.txt" });
    assert.ok(Buffer.byteLength(first.text) <= OUTPUT_CAP_BYTES);
    assert.ok(first.data.nextOffset > 0 && first.data.content.length === first.data.nextOffset);
    const second = await callTool(t, { action: "file", host: "mac", path: "/w/big.txt", offset: first.data.nextOffset });
    assert.equal(second.data.offset, first.data.nextOffset);
    assert.match((await callTool(t, { action: "file", host: "mac", path: "/home/u/.ssh/id_secret" })).value.summary, /refused: secret path/);
  });

  test("every action keeps its output within the cap on large fleets and says how much was left out", async () => {
    const fleet = makeFleet({ filler: 700 });
    fleet.hosts.push(...Array.from({ length: 80 }, (_, n) => ({ id: `k8s/os/p${n}`, site: "os", kind: "pod", label: `p${n}`, status: "online", via: "pod-exec", counts: { agents: 0, running: 0 } })));
    fleet.pods.push(...Array.from({ length: 400 }, (_, n) => ({ key: `os/mc-bochao-li/pod-${n}`, site: "os", cluster: "c", namespace: "mc-bochao-li", name: `pod-${n}`, phase: "Failed", ready: "0/1", restarts: 9, node: `node-${n}`, containers: [{ name: "a", image: "i", ready: false, state: `waiting: ${"CrashLoopBackOff ".repeat(5)}`, restarts: 9 }], requests: {}, labels: {}, collect: false })));
    const chain = Array.from({ length: 150 }, (_, n) => agent({ host: "mac", kind: "omp", id: `chain-${n}`, parent: { key: n === 0 ? DSH_KEY : `mac#omp:chain-${n - 1}`, via: "file", exact: true }, title: "chain ".repeat(30) }));
    fleet.agents.push(...chain);
    fleet.family = [fleet.agents[0], ...chain];
    fleet.links = [...fleet.links, ...chain.map((member, n) => ({ from: n === 0 ? DSH_KEY : `mac#omp:chain-${n - 1}`, to: member.key, via: "file", exact: true, crossHost: false, crossSite: false }))];
    const many = Array.from({ length: 3000 }, (_, n) => ({ agent: OMP_KEY, event: toolEvent(n, { targets: [{ type: "file", op: n % 2 ? "write" : "read", host: "mac", path: `/data/run/${"deep/".repeat(12)}file-${n}.txt` }] }) }));
    const handlers = hubHandlers(fleet, {
      family: ({ key }) => ({ root: key, agents: fleet.family, links: fleet.links, events: Object.fromEntries(fleet.family.map(member => [member.key, [toolEvent(1), toolEvent(2), toolEvent(3), toolEvent(4)]])) }),
      agent: ({ key }) => ({ key, events: Array.from({ length: 100 }, (_, n) => toolEvent(100 - n, { targets: Array.from({ length: 12 }, (_, i) => ({ type: "file", op: "read", host: "mac", path: `/a/b/c/${"x".repeat(100)}-${i}` })) })), hasMore: true }),
      pod: ({ key }) => ({ pod: fleet.pods[0], touches: Array.from({ length: 500 }, (_, n) => ({ agent: `mac#omp:filler-${n}`, event: `e${n}`, t: NOW - n, op: "exec", category: "k8s", name: "bash", preview: "kubectl exec ".repeat(20) })), events: Array.from({ length: 60 }, (_, n) => ({ type: "Warning", reason: `R${n}`, message: "m".repeat(400), count: n + 1, lastSeen: NOW - n })) }),
      query: ({ target }) => ({ items: target === "file" ? many : many.slice(0, 500), total: target === "file" ? 3000 : 5000 }),
    });
    const t = tool(handlers);
    const cases = [
      { action: "overview" }, { action: "list", limit: 200 }, { action: "list" }, { action: "family", key: DSH_ID, limit: 200 }, { action: "agent", key: OMP_KEY, limit: 200 },
      { action: "pods", limit: 200 }, { action: "pod", pod: "os/mc-bochao-li/pod-x" }, { action: "files", limit: 200 }, { action: "files", key: OMP_KEY, limit: 200 }, { action: "query", limit: 200 },
    ];
    assert.deepEqual([...new Set(cases.map(args => args.action))].sort(), [...ACTIONS].filter(action => action !== "file").sort(), "every action but file (covered above) is exercised");
    for (const args of cases) {
      const { value, text, data } = await callTool(t, args);
      assert.ok(Buffer.byteLength(text) <= OUTPUT_CAP_BYTES, `${JSON.stringify(args)} is ${Buffer.byteLength(text)} bytes`);
      assert.deepEqual(data, value.data, "the text carries exactly the returned data");
      assert.ok(value.summary.length > 10);
    }
    const big = await callTool(t, { action: "list", limit: 200 });
    assert.ok(big.data.more > 0 && big.data.agents.length < 200 && big.data.agents.length > 0);
    assert.match(big.value.summary, new RegExp(`\\(${big.data.agents.length} shown, ${big.data.more} more\\)`));
    assert.ok(big.data.agents.every((row, n, rows) => n === 0 || (rows[n - 1].status === "running" || row.status !== "running")), "running agents stay first after truncation");
    const family = await callTool(t, { action: "family", key: DSH_ID, limit: 200 });
    assert.ok(family.data.more > 0, "a 150-member chain is cut with a count");
    assert.equal(family.data.agents[0].key, DSH_KEY);
    assert.ok(family.data.agents.every(row => row.up === undefined || row.up < row.n), "parents come before children even after the cut");
    assert.equal((await callTool(t, { action: "files", limit: 200 })).data.more > 0, true);
  });

  test("a call that is aborted while the hub is slow settles promptly", needsDsh, async () => {
    const never = new Promise(() => {});
    const t = tool(hubHandlers(makeFleet(), { snapshot: () => never }));
    const controller = new AbortController();
    const pending = t.execute({ action: "overview" }, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("turn cancelled")), 20);
    await assert.rejects(pending, /turn cancelled/);
  });
});

/* ───────────── against DSH's real registry, shell-env and cordis ───────────── */

describe("real DSH services", needsDsh, () => {
  test("plugin loads in a real cordis context; the registry validates the tool and shell-env exports the variables", async () => {
    const { Context } = await dshModule("cordis/lib/index.js");
    const shellEnvModule = await dshModule("dsh-shell-env/lib/index.js");
    const toolsModule = realTools, dir = scratch("cordis"), fleet = makeFleet(), hub = await startStubHub(hubHandlers(fleet));
    try {
      const root = new Context();
      root.plugin(shellEnvModule, {});
      root.provide("systemPrompt", new Proxy({}, { get: (_target, prop) => (prop === "then" ? undefined : () => () => {}) }));
      root.plugin(toolsModule.default, {});
      const routes = new Map();
      root.provide("connection", { fetch: { register: route => { routes.set(route.path, route); return async () => { routes.delete(route.path); }; } } });
      root.provide("dshHomePath", () => dir);
      await new Promise(done => setTimeout(done, 30));
      const fiber = root.plugin({ name: "dsh-agent-fleet", inject: ["connection"], apply: (ctx, config) => apply(ctx, config, { loadDefineTool: async () => toolsModule.defineTool }) }, { mode: "remote", hubUrl: hub.url, tokenFile: writeToken(dir) });
      await fiber;
      assert.equal(routes.size, 7);

      const tools = root.get("tools");
      const controller = new AbortController();
      const run = (args) => tools.execute({ callId: "call-1", name: "agent_fleet", arguments: args, signal: controller.signal });
      const ok = await run({ action: "list", kind: "omp", limit: 5 });
      assert.equal(ok.isError, false, JSON.stringify(ok.error ?? ok.content));
      assert.equal(ok.value.data.agents.every(row => row.kind === "omp"), true);
      assert.ok(ok.content[0].text.startsWith("2 agents match"));
      assert.equal((await run({ action: "list", kind: "gemini" })).isError, true, "the registry rejects arguments outside the schema");
      assert.equal((await run({ action: "overview" })).isError, false);

      const env = root.get("shellEnv").collect({ agent: { session: { header: { id: "session-zz" } } }, callId: "call-9" });
      assert.equal(env.DSH_AGENT_FLEET_PARENT, "dsh:session-zz");
      assert.equal(env.DSH_AGENT_FLEET_PARENT_CALL, "call-9");
      assert.equal(root.get("shellEnv").collect({ callId: "x" }).DSH_AGENT_FLEET_PARENT, undefined, "a call without an agent exports nothing");
      assert.ok(root.get("shellEnv").list().some(info => info.contributor === "agent-fleet" && info.key === "DSH_AGENT_FLEET_PARENT"));

      await fiber.dispose();
      assert.equal(tools.get("agent_fleet"), undefined, "the tool leaves with the plugin");
      assert.equal(root.get("shellEnv").collect({ callId: "x" }).DSH_AGENT_FLEET_PARENT, undefined);
      assert.equal(routes.size, 0, "RPC routes are unregistered on disposal");
    } finally { await hub.close(); }
  });
});

/* ───────────── browser half ───────────── */

describe("client.js", () => {
  const source = readFileSync(join(F, "client.js"), "utf8");

  /** Minimal React: elements are plain objects; hooks run in a tiny synchronous renderer per mounted component. */
  function createRuntime() {
    let current = null;
    const react = {
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
      useState(initial) { const c = current, i = c.hook++; if (!(i in c.state)) c.state[i] = initial; return [c.state[i], value => { c.state[i] = value; c.render(); }]; },
      useRef(initial) { const c = current, i = c.hook++; return c.state[i] ??= { current: initial }; },
      useEffect(run, deps) { current.pending.push({ i: current.hook++, run, deps }); },
      useLayoutEffect(run, deps) { current.pending.push({ i: current.hook++, run, deps }); },
    };
    function mount(Component, props) {
      const c = { state: {}, hook: 0, pending: [], slots: {}, tree: null, rendering: false, dirty: false, props };
      c.render = () => {
        if (c.rendering) { c.dirty = true; return; }            // a state update inside an effect re-renders once this pass ends
        c.rendering = true;
        const previous = current;
        try {
          do {
            c.dirty = false;
            current = c; c.hook = 0; c.pending = [];
            c.tree = Component(c.props);
            for (const { i, run, deps } of c.pending) {
              const old = c.slots[i];
              if (old && deps && old.deps && deps.length === old.deps.length && deps.every((dep, k) => Object.is(dep, old.deps[k]))) continue;
              old?.cleanup?.();
              c.slots[i] = { deps, cleanup: run() };
            }
          } while (c.dirty);
        } finally { current = previous; c.rendering = false; }
      };
      c.update = next => { c.props = next; c.render(); };
      c.unmount = () => { for (const slot of Object.values(c.slots)) slot.cleanup?.(); };
      c.render();
      return c;
    }
    return { react, mount };
  }

  const find = (node, predicate) => {
    if (node === null || typeof node !== "object") return null;
    if (predicate(node)) return node;
    for (const child of node.children ?? []) { const hit = find(child, predicate); if (hit) return hit; }
    return null;
  };

  function loadClient() {
    const runtime = createRuntime(), listeners = [], opened = [];
    const window = {
      location: { href: "http://dsh.test:3080/app/" },
      addEventListener: (type, listener) => listeners.push([type, listener]),
      removeEventListener: (type, listener) => { const at = listeners.findIndex(entry => entry[0] === type && entry[1] === listener); if (at >= 0) listeners.splice(at, 1); },
      open: (...args) => opened.push(args),
    };
    let spec;
    window.__ModuleLoader__ = { load: value => { spec = value; } };
    new Function("window", source)(window);
    const exports = spec.factory(name => { assert.equal(name, "react"); return runtime.react; });
    const slots = [], effects = [], rpcCalls = [];
    const ctx = {
      effect: run => { effects.push(run()); },
      slots: { inject: (key, callback) => { const dispose = callback(); slots.push({ key, dispose }); return dispose; }, register: (options, component) => { const entry = { options, component, disposed: false }; slots.registrations = [...(slots.registrations ?? []), entry]; return () => { entry.disposed = true; }; } },
      connection: { rpc: { call: async (channel, method, payload, signal) => { rpcCalls.push({ channel, method, payload, signal }); return { ok: true, value: { url: `http://127.0.0.1:7846/#focus=${payload.sessionId ?? ""}` } }; } } },
    };
    return { spec, exports, window, listeners, opened, runtime, ctx, slots, rpcCalls };
  }

  const settle = () => new Promise(done => setTimeout(done, 5));

  test("registers the session tab, the page and the sidebar entry under one id", () => {
    const client = loadClient();
    assert.equal(client.spec.id, "@local/dsh-agent-fleet");
    assert.deepEqual(client.exports.inject, ["connection", "slots"]);
    client.exports.apply(client.ctx);
    const byName = Object.fromEntries(client.slots.registrations.map(entry => [entry.options.name, entry.options]));
    assert.deepEqual(Object.keys(byName).sort(), ["conversation.view", "main", "sidebar.panellist"]);
    assert.equal(byName["conversation.view"].id, "agent-fleet");
    assert.equal(byName["conversation.view"].order, 35);
    assert.equal(byName["conversation.view"].label(), "Agent Fleet");
    assert.equal(byName.main.key, byName["sidebar.panellist"].id, "the page key is the sidebar entry id");
    assert.equal(byName["sidebar.panellist"].label(), "Agent Fleet");
    const icon = client.slots.registrations.find(entry => entry.options.name === "sidebar.panellist").component({ size: 18 });
    assert.equal(icon.type, "svg");
    assert.equal(icon.props.width, 18);
    assert.equal(client.slots.registrations.length, 3);
  });

  test("the tab and the page ask the host for the panel URL of their session", async () => {
    const client = loadClient();
    client.exports.apply(client.ctx);
    const view = client.slots.registrations.find(entry => entry.options.name === "conversation.view");
    const page = client.slots.registrations.find(entry => entry.options.name === "main");
    const signal = new AbortController().signal;
    assert.equal((await view.options.inject("session-1").loadPanel(signal)).url, "http://127.0.0.1:7846/#focus=session-1");
    assert.deepEqual(client.rpcCalls[0], { channel: "/api", method: "agent-fleet/panel-url", payload: { sessionId: "session-1" }, signal });
    await page.options.inject().loadPanel(signal);
    assert.deepEqual(client.rpcCalls[1].payload, {}, "the page is not bound to a session");
    client.ctx.connection.rpc.call = async () => ({ ok: false, error: { code: "agent-fleet/unavailable", message: "hub unreachable", details: {} } });
    await assert.rejects(view.options.inject("s").loadPanel(signal), /hub unreachable/);
  });

  test("the tab hides the composer for its own session only, and gives it back on unmount", () => {
    const client = loadClient();
    client.exports.apply(client.ctx);
    const view = client.slots.registrations.find(entry => entry.options.name === "conversation.view");
    const mounted = client.runtime.mount(view.component, { sessionId: "session-1", loadPanel: () => new Promise(() => {}) });
    const gate = client.slots.registrations.find(entry => entry.options.name === "conversation.composer");
    assert.ok(gate, "a composer takeover is registered while the tab is mounted");
    assert.equal(gate.options.priority, -1001);
    assert.notEqual(gate.options.select({ sessionId: "session-1", pendingInteraction: undefined }), null);
    assert.equal(gate.options.select({ sessionId: "session-1", pendingInteraction: { kind: "approval" } }), null, "approvals and questions keep the composer seat");
    assert.equal(gate.options.select({ sessionId: "session-2", pendingInteraction: undefined }), null);
    assert.equal(gate.disposed, false);
    mounted.unmount();
    assert.equal(gate.disposed, true);
    assert.equal(find(mounted.tree, node => node.type === "iframe"), null, "no panel before the URL arrives");
  });

  test("the panel iframe loads the URL; open-in-browser messages are honoured only from that iframe and origin", async () => {
    const client = loadClient();
    client.exports.apply(client.ctx);
    const page = client.slots.registrations.find(entry => entry.options.name === "main");
    const loads = [];
    const loadPanel = signal => { loads.push(signal); return Promise.resolve({ url: "http://127.0.0.1:7846/#nonce=n&focus=s" }); };
    const mounted = client.runtime.mount(page.component, {});
    const body = client.runtime.mount(mounted.tree.type, { ...mounted.tree.props, loadPanel });
    await settle();
    const iframe = find(body.tree, node => node.type === "iframe");
    assert.ok(iframe, "iframe rendered once the URL is known");
    assert.equal(iframe.props.src, "http://127.0.0.1:7846/#nonce=n&focus=s");
    assert.equal(iframe.props.sandbox, "allow-scripts allow-same-origin allow-forms");
    assert.equal(iframe.props.referrerPolicy, "no-referrer");
    const panelWindow = { name: "panel" };
    iframe.props.ref.current = { contentWindow: panelWindow };
    const [[, onMessage]] = client.listeners.filter(([type]) => type === "message");
    const send = (event, data) => onMessage({ origin: "http://127.0.0.1:7846", source: panelWindow, data, ...event });
    const open = { type: "agent-fleet/open-in-browser", url: "http://127.0.0.1:7846/#view=files" };

    send({}, open);
    send({}, { ...open, url: "/relative#view=pods" });
    assert.deepEqual(client.opened.map(args => args[0]), ["http://127.0.0.1:7846/#view=files", "http://127.0.0.1:7846/relative#view=pods"], "a relative URL resolves against the panel");
    assert.deepEqual(client.opened[0].slice(1), ["_blank", "noopener,noreferrer"]);
    const before = client.opened.length;
    send({ origin: "http://evil.test" }, open);                                   // another origin
    send({ source: { name: "other frame" } }, open);                              // same origin, not this iframe
    send({}, { ...open, type: "agent-dag/open-in-browser" });                     // another plugin's message
    send({}, { ...open, url: "http://evil.test/" });                              // URL off the panel's origin
    send({}, { ...open, url: "javascript:alert(1)" });
    send({}, { ...open, url: 7 });
    send({}, null);
    assert.equal(client.opened.length, before, "nothing else is opened");
    body.unmount();
    assert.equal(client.listeners.filter(([type]) => type === "message").length, 0, "the listener goes away with the component");
  });

  test("a failed lookup is shown, and a session switch aborts the previous lookup and loads again", async () => {
    const client = loadClient();
    client.exports.apply(client.ctx);
    const view = client.slots.registrations.find(entry => entry.options.name === "conversation.view");
    const signals = [];
    const fail = signal => { signals.push(signal); return Promise.reject(new Error("hub unreachable at http://127.0.0.1:7840")); };
    const tab = client.runtime.mount(view.component, { sessionId: "s1", loadPanel: fail });
    const body = client.runtime.mount(tab.tree.type, tab.tree.props);
    await settle();
    assert.match(find(body.tree, node => node.props.role === "alert").children[0], /hub unreachable/);
    const pending = [];
    const slow = signal => { pending.push(signal); return new Promise(() => {}); };
    body.update({ sessionId: "s2", loadPanel: slow });
    assert.equal(signals[0].aborted, true, "the previous lookup is aborted");
    assert.equal(pending.length, 1, "the new session triggers a new lookup");
    assert.equal(find(body.tree, node => node.props.role === "alert"), null, "the old error is cleared");
    body.unmount();
    assert.equal(pending[0].aborted, true);
  });
});

/* ───────────── configure.mjs ───────────── */

describe("configure.mjs", () => {
  const SECRET = "SECRET-TOKEN-VALUE-123";
  const WEB = `${JSON.stringify([
    { id: "dsh-acp-adapter", disabled: false, config: { agents: { omp: { env: { TOKENROUTER_API_KEY: SECRET } } }, toolApprovalDefault: "ask" } },
    { id: "dsh-agent-dag", disabled: false, config: { tokenFile: "/x/web/token", liveTools: false } },
    { id: "ui-settings-general", name: "@deepseek-ai/dsh-client-ui-settings-general", config: { welcomeNoticeVersion: "2026-09-28.1" } },
  ], null, 2)}\n`;
  const DESKTOP = `- {
    "id": "ui-chat",
    "name": "@deepseek-ai/dsh-client-ui-chat",
    "config": { "transcriptView": "standard" }
  }
# rows below were written by hand
- {
    "id": "dsh-acp-adapter",
    "disabled": false,
    "config":
      {
        "agents": { "omp": { "env": { "TOKENROUTER_API_KEY": "${SECRET}" } } }
      }
  }

- id: skill-filesystem-agent-homes
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    providerName: agent-homes
    customSkillDirs:
      - !!js process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:os').homedir(), '.claude', 'skills')
- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: dark # keep
`;

  function profile(name, text, mode = 0o600) {
    const home = scratch("home"), dir = join(home, "profiles", name);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "cordis.patch.yml");
    if (text !== null) { writeFileSync(file, text, { mode }); chmodSync(file, mode); }   // a restrictive umask must not weaken the fixture
    return { home, dir, file };
  }
  const configure = (home, ...args) => spawnSync(NODE, [join(F, "configure.mjs"), ...args], { env: { ...process.env, DSH_HOME: home }, encoding: "utf8" });
  const backups = dir => readdirSync(dir).filter(name => name.startsWith("cordis.patch.yml.bak-"));
  const rowsOf = text => (realYaml ? realYaml.parseDocument(text, { logLevel: "silent" }).toJS() : JSON.parse(text));

  test("adds the row to a JSON patch, keeps every other row, backs up, keeps 0600, and is idempotent", () => {
    const p = profile("web", WEB);
    const run = configure(p.home, "--profile", "web", "--mode", "remote");
    assert.equal(run.status, 0, run.stderr);
    assert.ok(!(run.stdout + run.stderr).includes(SECRET), "the file's secrets are never printed");
    const after = readFileSync(p.file, "utf8");
    const rows = JSON.parse(after);
    assert.deepEqual(rows.slice(0, 3), JSON.parse(WEB), "the other rows are untouched");
    assert.deepEqual(rows[3], { id: "dsh-agent-fleet", disabled: false, config: { mode: "remote" } });
    assert.equal(statSync(p.file).mode & 0o777, 0o600);
    assert.deepEqual(backups(p.dir).map(name => readFileSync(join(p.dir, name), "utf8")), [WEB], "one backup holding the old bytes");
    assert.equal(statSync(join(p.dir, backups(p.dir)[0])).mode & 0o777, 0o600);

    const again = configure(p.home, "--profile", "web", "--mode", "remote");
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /already up to date/);
    assert.equal(readFileSync(p.file, "utf8"), after, "a second run changes nothing");
    assert.equal(backups(p.dir).length, 1, "and makes no new backup");

    const edit = configure(p.home, "--profile", "web", "--mode", "embedded", "--ssh-target", "bochao_li@10.0.60.98", "--token-file", "~/.config/agent-fleet/local-token");
    assert.equal(edit.status, 0, edit.stderr);
    const edited = JSON.parse(readFileSync(p.file, "utf8"));
    assert.deepEqual(edited.slice(0, 3), JSON.parse(WEB));
    assert.deepEqual(edited[3].config, { mode: "embedded", tokenFile: "~/.config/agent-fleet/local-token", upstream: { sshTarget: "bochao_li@10.0.60.98" } });
    assert.equal(edited.length, 4, "the row is updated in place, never duplicated");
    assert.equal(configure(p.home, "--profile", "web", "--hub-url", "http://127.0.0.1:7840").status, 0);
    assert.deepEqual(JSON.parse(readFileSync(p.file, "utf8"))[3].config, { mode: "embedded", tokenFile: "~/.config/agent-fleet/local-token", upstream: { sshTarget: "bochao_li@10.0.60.98" }, hubUrl: "http://127.0.0.1:7840" }, "flags set only the keys they name");
  });

  test("a block-YAML patch with comments and !!js tags keeps every byte outside the new row", () => {
    const p = profile("desktop", DESKTOP, 0o640);
    const run = configure(p.home, "--profile", "desktop", "--ssh-target", "bochao_li@10.0.60.98");
    assert.equal(run.status, 0, run.stderr);
    assert.ok(!(run.stdout + run.stderr).includes(SECRET));
    const after = readFileSync(p.file, "utf8");
    assert.ok(after.startsWith(DESKTOP), "everything that was there is still there, byte for byte");
    assert.equal(statSync(p.file).mode & 0o777, 0o640, "the file's permissions are preserved");
    const rows = rowsOf(after);
    assert.deepEqual(rows.at(-1), { id: "dsh-agent-fleet", disabled: false, config: { mode: "embedded", upstream: { sshTarget: "bochao_li@10.0.60.98" } } }, "the desktop profile defaults to embedded");
    if (realYaml) assert.deepEqual(rows.slice(0, -1), rowsOf(DESKTOP), "a real YAML parser sees the same other rows");
    const again = configure(p.home, "--profile", "desktop", "--ssh-target", "bochao_li@10.0.60.98");
    assert.match(again.stdout, /already up to date/);
    assert.equal(readFileSync(p.file, "utf8"), after);
    const update = configure(p.home, "--profile", "desktop", "--mode", "remote");
    assert.equal(update.status, 0, update.stderr);
    const updated = readFileSync(p.file, "utf8");
    assert.ok(updated.startsWith(DESKTOP));
    assert.deepEqual(rowsOf(updated).at(-1).config, { mode: "remote", upstream: { sshTarget: "bochao_li@10.0.60.98" } });
    assert.equal(rowsOf(updated).filter(row => row.id === "dsh-agent-fleet").length, 1);
    if (realYaml) assert.deepEqual(rowsOf(updated).slice(0, -1), rowsOf(DESKTOP));
  });

  test("dry run, invalid values, unknown profiles and unsafe rows write nothing", () => {
    const p = profile("web", WEB);
    const dry = configure(p.home, "--profile", "web", "--dry-run", "--mode", "remote");
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /dry run: would add/);
    assert.ok(!dry.stdout.includes(SECRET));
    assert.equal(readFileSync(p.file, "utf8"), WEB);
    assert.deepEqual(backups(p.dir), []);

    for (const [args, message] of [
      [["--hub-url", "ftp://x"], /hubUrl must be http\(s\)/],
      [["--ssh-target", "-oProxyCommand=x"], /plain ssh login/],
      [["--panel-url", "http://127.0.0.1:1/?token=abc"], /must not contain \? or #/],
      [["--mode", "sideways"], /mode must be/],
      [["--token-file", "relative/token"], /absolute path/],
      [["--bogus", "1"], /unknown argument --bogus/],
      [["--mode"], /--mode needs a value/],
    ]) {
      const run = configure(p.home, "--profile", "web", ...args);
      assert.equal(run.status, 1, `${args.join(" ")}: ${run.stdout}`);
      assert.match(run.stderr, message);
      assert.equal(readFileSync(p.file, "utf8"), WEB);
    }
    assert.equal(configure(p.home, "--profile", "elsewhere").status, 1);
    assert.equal(configure(p.home).status, 1);
    assert.equal(configure(scratch("empty"), "--profile", "web").status, 1, "no profile directory: start DSH once first");

    const hand = profile("web", `${WEB.slice(0, -2)},\n  { "id": "dsh-agent-fleet", "config": {mode: remote, hubUrl: 'http://x'} }\n]\n`);
    const refused = configure(hand.home, "--profile", "web", "--mode", "embedded");
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /not JSON-flow YAML/);
    const twice = profile("web", `${JSON.stringify([{ id: "dsh-agent-fleet", config: {} }, { id: "dsh-agent-fleet", config: {} }])}\n`);
    assert.match(configure(twice.home, "--profile", "web").stderr, /2 rows have id dsh-agent-fleet/);
    const notAList = profile("web", "key: value\n");
    assert.match(configure(notAList.home, "--profile", "web").stderr, /top level must be a YAML list/);
  });

  test("creates the patch file (0600) when the profile has none, and handles CRLF and an empty list", () => {
    const fresh = profile("web", null);
    assert.equal(configure(fresh.home, "--profile", "web", "--mode", "remote").status, 0);
    assert.deepEqual(JSON.parse(readFileSync(fresh.file, "utf8")), [{ id: "dsh-agent-fleet", disabled: false, config: { mode: "remote" } }]);
    assert.equal(statSync(fresh.file).mode & 0o777, 0o600);
    assert.deepEqual(backups(fresh.dir), []);

    const empty = upsertFleetRow("[]\n", { change: {}, defaultMode: "remote" });
    assert.deepEqual(JSON.parse(empty.text), [empty.row]);
    const crlf = DESKTOP.replace(/\n/g, "\r\n");
    const result = upsertFleetRow(crlf, { change: { mode: "remote" }, defaultMode: "embedded" });
    assert.ok(result.text.startsWith(crlf) && result.text.slice(crlf.length).includes("\r\n") && !/[^\r]\n/.test(result.text.slice(crlf.length)), "CRLF files stay CRLF");
    const bom = upsertFleetRow(`\uFEFF${WEB}`, { change: { mode: "remote" }, defaultMode: "remote" });
    assert.ok(bom.text.startsWith("\uFEFF[") && JSON.parse(bom.text.slice(1)).length === 4);
  });
});

/* ───────────── install.mjs ───────────── */

describe("install.mjs fleet entry", () => {
  function web(extra = {}) {
    const home = scratch("install"), dir = join(home, "profiles", "web");
    mkdirSync(dir, { recursive: true });
    const manifest = { name: "dsh-profile-web", private: true, dependencies: { "@local/dsh-agent-dag": "link:/somewhere/else" }, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@local/dsh-agent-dag"] } }, ...extra };
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return { home, dir, manifest };
  }
  const install = (home, ...args) => spawnSync(NODE, [join(PACK, "install.mjs"), "--profile", "web", ...args, "--dry-run"], { env: { ...process.env, DSH_HOME: home }, encoding: "utf8" });
  const printedManifest = out => JSON.parse(out.slice(out.indexOf("{\n"), out.lastIndexOf("\n}\n") + 2));

  test("--plugins fleet prints the manifest with the linked package and its bundle", () => {
    const { home, dir, manifest } = web();
    const run = install(home, "--plugins", "fleet");
    assert.equal(run.status, 0, run.stderr);
    const printed = printedManifest(run.stdout);
    assert.deepEqual(printed.dependencies, { ...manifest.dependencies, "@local/dsh-agent-fleet": `link:${F}` });
    assert.deepEqual(printed.dsh.profile.bundles, [...manifest.dsh.profile.bundles, "@local/dsh-agent-fleet"]);
    assert.match(run.stdout, /pnpm install/, "the profile is reinstalled after the manifest change");
    assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).dependencies["@local/dsh-agent-fleet"], undefined, "dry run writes nothing");
    assert.deepEqual(readdirSync(dir), ["package.json"]);
  });

  test("the default selection is unchanged (fleet is opt-in) and an unknown key lists fleet", () => {
    const { home } = web();
    const run = install(home);
    assert.equal(run.status, 0, run.stderr);
    const printed = printedManifest(run.stdout);
    assert.equal(printed.dependencies["@local/dsh-agent-fleet"], undefined);
    assert.ok(printed.dependencies["@local/dsh-mermaid-pele"] && printed.dependencies["@local/dsh-acp-adapter"] && printed.dependencies["@local/dsh-agent-dag"]);
    const everything = install(home, "--plugins", "mermaid,acp,agent-dag,fleet");
    assert.ok(printedManifest(everything.stdout).dependencies["@local/dsh-agent-fleet"]);
    const bad = install(home, "--plugins", "nonsense");
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /unknown plugin nonsense \(.*fleet.*\)/);
  });
});
