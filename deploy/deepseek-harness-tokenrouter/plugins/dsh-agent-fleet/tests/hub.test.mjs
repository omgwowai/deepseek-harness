// Hub tests: collectors (fake, over in-memory channels, TCP ingest and a real child process), link resolution,
// snapshot / changes / SSE, journal reset, auth, file proxy, host offline handling, upstream merge, pods, and the
// in-process collector (a stand-in for wiring, the real collector end to end).
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createChannel, tcpTransport } from "../lib/channel.mjs";
import { LIMITS, PROTOCOL_VERSION, agentKey, podHostId } from "../lib/protocol.mjs";
import { startHub, parseHubArgs } from "../lib/hub/index.mjs";
import { createAuth } from "../lib/hub/auth.mjs";
import { createState } from "../lib/hub/state.mjs";
import { createCollectorLinks } from "../lib/hub/sources/collector-link.mjs";
import { startLocalCollector } from "../lib/hub/sources/local.mjs";
import { createHttpPool, createSseParser, createUpstream, httpGet } from "../lib/hub/sources/upstream.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_COLLECTOR = join(here, "fixtures", "hub", "fake-collector.mjs");
mkdirSync(join(here, "..", ".scratch"), { recursive: true });
const tmp = mkdtempSync(join(here, "..", ".scratch", "hub-test-"));
after(() => { rmSync(tmp, { recursive: true, force: true }); try { rmdirSync(join(here, "..", ".scratch")); } catch { /* shared with other work */ } });

const panelDir = join(tmp, "panel");
mkdirSync(join(panelDir, "fixtures"), { recursive: true });
writeFileSync(join(panelDir, "index.html"), "<!doctype html><title>fleet</title>");
writeFileSync(join(panelDir, "app.js"), "console.log('panel');");
writeFileSync(join(panelDir, "app.css"), "body{}");
writeFileSync(join(panelDir, "fixtures", "demo.json"), "{}");
writeFileSync(join(panelDir, ".hidden.js"), "secret");
writeFileSync(join(panelDir, "notes.exe"), "binary");

// ------------------------------------------------------------------------------------------------ helpers

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, { timeoutMs = 4000, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try { value = await check(); } catch (error) { value = undefined; if (Date.now() > deadline) throw error; }
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}

/**
 * A clock whose timers run only when the test says so: `freeze` moves time without running anything (an event-loop
 * stall or a frozen process), `advance` moves time and runs the timers that fall due, in deadline order.
 */
function fakeClock(start = 0) {
  let now = start, nextId = 1;
  const timeouts = new Map(), intervals = new Map();
  const advance = milliseconds => {
    const target = now + milliseconds;
    for (let guard = 0; guard < 10_000; guard += 1) {
      let due = null;
      for (const [id, timer] of timeouts) if (timer.at <= target && (due === null || timer.at < due.at)) due = { kind: "timeout", id, at: timer.at };
      for (const [id, timer] of intervals) if (timer.at <= target && (due === null || timer.at < due.at)) due = { kind: "interval", id, at: timer.at };
      if (due === null) break;
      now = Math.max(now, due.at);
      const fn = due.kind === "timeout" ? timeouts.get(due.id)?.fn : intervals.get(due.id)?.fn;
      if (due.kind === "timeout") timeouts.delete(due.id);
      else { const timer = intervals.get(due.id); if (timer !== undefined) timer.at = now + timer.every; }
      fn?.();
    }
    now = Math.max(now, target);
  };
  return {
    now: () => now,
    setTimeout(fn, ms) { const id = nextId++; timeouts.set(id, { fn, at: now + Math.max(0, ms) }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval(fn, ms) { const id = nextId++; intervals.set(id, { fn, every: ms, at: now + ms }); return id; },
    clearInterval(id) { intervals.delete(id); },
    freeze(ms) { now += ms; },
    advance,
  };
}

/** Hub side of an in-memory link for `links.attach`; the peer side is a channel like a real collector's. */
function inMemoryLink(links) {
  const toHub = new PassThrough(), toCollector = new PassThrough();
  const destroy = () => { toHub.destroy(); toCollector.destroy(); };
  const channel = links.attach({ readable: toHub, writable: toCollector, close: destroy }, { via: "socket", label: "test collector" });
  const peer = createChannel({ readable: toCollector, writable: toHub, label: "test collector (peer side)", close: destroy });
  return { channel, peer, hello: (info, at = 0) => peer.send({ t: "hello", proto: PROTOCOL_VERSION, at, host: hostInfo(info) }) };
}

let hubCounter = 0;
/** A hub with HTTP (ephemeral port) and TCP ingest, torn down with the test. */
async function startTestHub(t, { http = {}, ingest = {}, ...rest } = {}) {
  const tokenFile = http.tokenFile ?? join(tmp, `hub-${++hubCounter}.token`);
  const hub = await startHub({
    hostId: "server-bochao-01", version: "9.9.9", log: () => {},
    http: { host: "127.0.0.1", port: 0, tokenFile, panelDir, ...http },
    ingest: ingest === false ? undefined : { host: "127.0.0.1", port: 0, ...ingest },
    ...rest,
  });
  t.after(() => hub.stop());
  const token = readFileSync(tokenFile, "utf8").trim();
  const url = `http://127.0.0.1:${hub.http.port}`;
  async function get(path, { auth = token, headers = {} } = {}) {
    const response = await fetch(url + path, { headers: { ...(auth ? { "x-agent-fleet-token": auth } : {}), ...headers }, redirect: "manual" });
    const text = await response.text();
    let json; try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: response.status, headers: response.headers, text, json };
  }
  return { hub, token, url, tokenFile, get, state: hub.state };
}

const hostInfo = info => ({
  kind: "server", label: info.id, hostname: info.id, platform: "linux", roots: { dsh: [], claude: [], codex: [], omp: [] }, ...info,
});

/** A collector on the other end of an in-memory channel pair. */
function connectCollector(hub, info, { clock = Date.now, onRequest, via, hello = true } = {}) {
  const toHub = new PassThrough(), toCollector = new PassThrough();
  const stop = () => { toHub.end(); toCollector.end(); };
  hub.addCollectorChannel({ readable: toHub, writable: toCollector, close: stop }, { via });
  const requests = [];
  const channel = createChannel({
    readable: toCollector, writable: toHub, label: `fake ${info.id}`,
    onRequest: (method, params) => { requests.push({ method, params }); return onRequest ? onRequest(method, params) : null; },
    close: stop,
  });
  if (hello) channel.send({ t: "hello", proto: PROTOCOL_VERSION, at: clock(), host: hostInfo(info) });
  return {
    channel, requests,
    agent: record => channel.send({ t: "agent", agent: record }),
    events: (agent, events) => channel.send({ t: "events", agent, events }),
    procs: procs => channel.send({ t: "procs", procs }),
    gone: agent => channel.send({ t: "gone", agent }),
    heartbeat: (stats, at = clock()) => channel.send({ t: "heartbeat", at, stats }),
    close: () => channel.close("test closed"),
  };
}

const T0 = Date.now();
function agentRecord(host, kind, id, over = {}) {
  const startedAt = over.startedAt ?? T0;
  return {
    key: agentKey(host, kind, id), host, site: host.startsWith("k8s/") ? host.split("/")[1] : host, kind, id, file: `/sessions/${id}.jsonl`, cwd: "/work",
    title: id, model: "m", role: "main", parent: null, startedAt, updatedAt: startedAt, endedAt: null, status: "running",
    live: { alive: true, state: "model", since: startedAt, doing: "", turnOpen: true },
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, counts: { turns: 1, tools: 0, errors: 0, subagents: 0, events: 0 },
    ...over,
  };
}
const toolEvent = (id, t, over = {}) => ({ id, type: "tool", t, name: "bash", category: "shell", status: "ok", preview: "ls", targets: [], ...over });

const links = hub => hub.state.snapshot().links;
const linkTo = (hub, key) => links(hub).find(link => link.to === key);
const agentOf = (hub, key) => hub.state.snapshot().agents.find(agent => agent.key === key);

async function openStream(url, token, since) {
  const controller = new AbortController();
  const response = await fetch(`${url}/api/stream${since === undefined ? "" : `?since=${since}`}`, { headers: { "x-agent-fleet-token": token }, signal: controller.signal });
  const frames = [];
  (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.*)$/m.exec(frame)?.[1], data = /^data: (.*)$/m.exec(frame)?.[1];
          frames.push({ at: performance.now(), event, comment: frame.startsWith(":"), delta: event === "delta" && data ? JSON.parse(data) : undefined });
        }
      }
    } catch { /* aborted */ }
  })();
  return { response, frames, deltas: () => frames.filter(frame => frame.delta), close: () => controller.abort() };
}

// ------------------------------------------------------------------------------------------- link resolution

describe("link resolution", () => {
  test("file hints resolve in either arrival order, with exact and cross-flag fields", async t => {
    const { hub } = await startTestHub(t);
    const mac = connectCollector(hub, { id: "mac", site: "mac" });
    const parent = agentRecord("mac", "omp", "p1", { startedAt: T0 - 5000 });
    const child = agentRecord("mac", "omp", "c1", { role: "subagent", parent: { key: parent.key, via: "file", exact: true, toolCallId: "call-7" } });
    mac.agent(child);
    await waitFor(() => agentOf(hub, child.key), { what: "child to arrive" });
    assert.equal(linkTo(hub, child.key), undefined, "no link while the parent is unknown");
    mac.agent(parent);
    const link = await waitFor(() => linkTo(hub, child.key), { what: "pending link to resolve" });
    assert.deepEqual(link, { from: parent.key, to: child.key, via: "file", exact: true, toolCallId: "call-7", crossHost: false, crossSite: false });
  });

  test("a global kind:id hint finds the parent on another host (AGENT_FLEET_PARENT, env)", async t => {
    const { hub } = await startTestHub(t);
    const mac = connectCollector(hub, { id: "mac", site: "mac" });
    const pod = connectCollector(hub, { id: "k8s/os/pod-x", site: "os", kind: "pod", pod: "pod-x" });
    const parent = agentRecord("mac", "omp", "m-1", { startedAt: T0 - 60_000 });
    const child = agentRecord("k8s/os/pod-x", "claude", "k-1", { parent: { kind: "omp", id: "m-1", via: "env", exact: true } });
    pod.agent(child);
    mac.agent(parent);
    const link = await waitFor(() => linkTo(hub, child.key), { what: "cross-host env link" });
    assert.deepEqual({ from: link.from, via: link.via, exact: link.exact, crossHost: link.crossHost, crossSite: link.crossSite }, { from: parent.key, via: "env", exact: true, crossHost: true, crossSite: true });
  });

  test("a process env (AGENT_FLEET_PARENT on the matched proc) links a session that has no hint", async t => {
    const { hub } = await startTestHub(t);
    const mac = connectCollector(hub, { id: "mac", site: "mac" });
    const pod = connectCollector(hub, { id: "k8s/os/pod-x", site: "os", kind: "pod", pod: "pod-x" });
    const parent = agentRecord("mac", "omp", "m-1", { startedAt: T0 - 60_000 });
    const child = agentRecord("k8s/os/pod-x", "claude", "k-1");
    mac.agent(parent);
    pod.agent(child);
    pod.procs([{ pid: 40, ppid: 1, kind: "claude", startedAt: T0, cmd: "claude -p", agent: child.key, parent: "omp:m-1" }]);
    const link = await waitFor(() => linkTo(hub, child.key), { what: "env link from procs" });
    assert.equal(link.from, parent.key);
    assert.equal(link.via, "env");
    assert.equal(link.exact, true);
  });

  test("kubectl exec launcher + start-time window links the nearest session of the launched kind", async t => {
    const { hub } = await startTestHub(t);
    const mac = connectCollector(hub, { id: "mac", site: "mac" });
    const pod = connectCollector(hub, { id: "k8s/os/pod-y", site: "os", kind: "pod", pod: "pod-y" });
    const owner = agentRecord("mac", "omp", "owner", { startedAt: T0 - 60_000 });
    const rightKind = agentRecord("k8s/os/pod-y", "omp", "s-omp", { startedAt: T0 + 7000 });
    const closerWrongKind = agentRecord("k8s/os/pod-y", "claude", "s-claude", { startedAt: T0 + 5500 });
    const tooLate = agentRecord("k8s/os/pod-y", "omp", "s-late", { startedAt: T0 + 600_000 });
    mac.agent(owner);
    for (const record of [rightKind, closerWrongKind, tooLate]) pod.agent(record);
    mac.procs([
      { pid: 10, ppid: 1, kind: "omp", startedAt: T0 - 60_000, cmd: "omp", agent: owner.key },
      { pid: 12, ppid: 10, kind: "kubectl", startedAt: T0 + 5000, cmd: "kubectl exec pod-y -- omp -p hi", remote: { site: "os", pod: "pod-y" }, launches: "omp" },
    ]);
    const link = await waitFor(() => linkTo(hub, rightKind.key), { what: "process link" });
    assert.deepEqual({ from: link.from, via: link.via, exact: link.exact, crossHost: link.crossHost }, { from: owner.key, via: "process", exact: false, crossHost: true });
    assert.equal(linkTo(hub, closerWrongKind.key), undefined, "one launcher claims one session; the other kind is not it");
    assert.equal(linkTo(hub, tooLate.key), undefined, "outside the ±60 s window");
  });

  test("a launcher whose own process chain is broken links through its environment's parent call", async t => {
    const { hub } = await startTestHub(t);
    const server = connectCollector(hub, { id: "server-bochao-01", site: "server-bochao-01" });
    const pod = connectCollector(hub, { id: "k8s/iron/agent-fleet-test-0", site: "iron", kind: "pod", pod: "agent-fleet-test-0" });
    const owner = agentRecord("server-bochao-01", "dsh", "s-owner", { startedAt: T0 - 60_000 });
    const child = agentRecord("k8s/iron/agent-fleet-test-0", "omp", "o-child", { startedAt: T0 + 4000 });
    server.agent(owner);
    pod.agent(child);
    // A DSH one-shot run's own pid often never binds to its session, so the launcher's ppid chain stops short;
    // DSH_AGENT_FLEET_PARENT(_CALL) in the launcher's environment still names the session and the exact tool call.
    server.procs([{
      pid: 30, ppid: 1, kind: "kubectl", startedAt: T0 + 1000,
      cmd: "kubectl --context ulanqab-iron exec agent-fleet-test-0 -- omp -p hi",
      remote: { site: "iron", pod: "agent-fleet-test-0" }, launches: "omp", parent: "dsh:s-owner", parentCall: "call-42",
    }]);
    const link = await waitFor(() => linkTo(hub, child.key), { what: "process link through the env parent" });
    assert.deepEqual({ from: link.from, via: link.via, exact: link.exact, toolCallId: link.toolCallId, crossHost: link.crossHost, crossSite: link.crossSite },
      { from: owner.key, via: "process", exact: false, toolCallId: "call-42", crossHost: true, crossSite: true });
  });

  test("a launch tool call links the session that starts on the target within [t-5 s, t+120 s]", async t => {
    const { hub } = await startTestHub(t);
    const mac = connectCollector(hub, { id: "mac", site: "mac" });
    const server = connectCollector(hub, { id: "server-bochao-01", site: "server-bochao-01" });
    const owner = agentRecord("mac", "omp", "owner", { startedAt: T0 - 60_000 });
    const hit = agentRecord("server-bochao-01", "codex", "x-hit", { startedAt: T0 + 2000 });
    const late = agentRecord("server-bochao-01", "codex", "x-late", { startedAt: T0 + 600_000 });
    const wrongKind = agentRecord("server-bochao-01", "omp", "o-near", { startedAt: T0 + 1000 });
    server.agent(hit); server.agent(late); server.agent(wrongKind);
    mac.agent(owner);
    mac.events(owner.key, [toolEvent("call-1", T0, { category: "remote", targets: [{ type: "agent", op: "launch", kind: "codex", site: "server-bochao-01", transport: "cli" }] })]);
    const link = await waitFor(() => linkTo(hub, hit.key), { what: "command link" });
    assert.deepEqual({ from: link.from, via: link.via, exact: link.exact, toolCallId: link.toolCallId }, { from: owner.key, via: "command", exact: false, toolCallId: "call-1" });
    assert.equal(linkTo(hub, late.key), undefined);
    assert.equal(linkTo(hub, wrongKind.key), undefined);
  });

  test("a probe session is never claimed by a launch that lands in its window", async t => {
    const { hub } = await startTestHub(t);
    const mac = connectCollector(hub, { id: "mac", site: "mac" });
    const pod = connectCollector(hub, { id: "k8s/os/pod-p", site: "os", kind: "pod", pod: "pod-p" });
    const owner = agentRecord("mac", "omp", "owner", { startedAt: T0 - 60_000 });
    const probe = agentRecord("k8s/os/pod-p", "omp", "probe-1", { role: "probe", startedAt: T0 + 1000 });
    const real = agentRecord("k8s/os/pod-p", "omp", "real-1", { startedAt: T0 + 4000 });
    mac.agent(owner);
    pod.agent(probe);
    pod.agent(real);
    mac.events(owner.key, [toolEvent("call-p", T0, { targets: [{ type: "agent", op: "launch", kind: "omp", site: "os", pod: "pod-p" }] })]);
    const link = await waitFor(() => linkTo(hub, real.key), { what: "command link to the real session" });
    assert.equal(link.from, owner.key, "the probe's closer start must not take the only link");
    assert.equal(linkTo(hub, probe.key), undefined);
  });

  test("an OMP --restore fork keeps its copied subagent records linked although they predate the fork", async t => {
    const { hub } = await startTestHub(t);
    const mac = connectCollector(hub, { id: "mac", site: "mac" });
    const fork = agentRecord("mac", "omp", "fork-1", { role: "fork", startedAt: T0 });
    const copied = agentRecord("mac", "omp", "fork-1/Worker", {
      role: "subagent", startedAt: T0 - 120_000, parent: { key: fork.key, via: "file", exact: true, toolCallId: "call-9" },
    });
    mac.agent(fork);
    mac.agent(copied);
    const link = await waitFor(() => linkTo(hub, copied.key), { what: "copied fork subagent link" });
    assert.deepEqual({ from: link.from, via: link.via, exact: link.exact, toolCallId: link.toolCallId, crossHost: link.crossHost },
      { from: fork.key, via: "file", exact: true, toolCallId: "call-9", crossHost: false });

    const inferred = agentRecord("mac", "omp", "fork-1/Late", {
      role: "subagent", startedAt: T0 - 120_000, parent: { key: fork.key, via: "file", exact: false },
    });
    mac.agent(inferred);
    await waitFor(() => agentOf(hub, inferred.key), { what: "inferred record to arrive" });
    assert.equal(linkTo(hub, inferred.key), undefined, "inferred links keep the start-time rule");
  });

  test("a launch aimed at a pod resolves to that pod's host", async t => {
    const { hub } = await startTestHub(t);
    const mac = connectCollector(hub, { id: "mac", site: "mac" });
    const pod = connectCollector(hub, { id: "k8s/os/pod-x", site: "os", kind: "pod", pod: "pod-x" });
    const other = connectCollector(hub, { id: "k8s/os/pod-z", site: "os", kind: "pod", pod: "pod-z" });
    const owner = agentRecord("mac", "omp", "owner", { startedAt: T0 - 60_000 });
    const hit = agentRecord("k8s/os/pod-x", "claude", "c-hit", { startedAt: T0 + 3000 });
    const elsewhere = agentRecord("k8s/os/pod-z", "claude", "c-else", { startedAt: T0 + 3000 });
    pod.agent(hit); other.agent(elsewhere); mac.agent(owner);
    mac.events(owner.key, [toolEvent("call-2", T0, { targets: [{ type: "agent", op: "launch", kind: "claude", site: "os", pod: "pod-x" }] })]);
    const link = await waitFor(() => linkTo(hub, hit.key), { what: "pod launch link" });
    assert.equal(link.from, owner.key);
    assert.equal(linkTo(hub, elsewhere.key), undefined);
  });

  test("ACP: a DSH record's acp binding parents the native session in either order, and beats an env hint", async t => {
    const { hub } = await startTestHub(t);
    const mac = connectCollector(hub, { id: "mac", site: "mac" });
    const dsh = agentRecord("mac", "dsh", "d-1", { startedAt: T0 - 1000, acp: { provider: "acp-codex", kind: "codex", id: "x1" } });
    const native = agentRecord("mac", "codex", "x1", { startedAt: T0 });
    mac.agent(native);                                            // native first: nothing to link to yet
    await waitFor(() => agentOf(hub, native.key));
    assert.equal(linkTo(hub, native.key), undefined);
    mac.agent(dsh);
    const link = await waitFor(() => linkTo(hub, native.key), { what: "acp link" });
    assert.deepEqual({ from: link.from, via: link.via, exact: link.exact }, { from: dsh.key, via: "acp", exact: true });

    const sub = agentRecord("mac", "codex", "x1-sub", { role: "subagent", startedAt: T0 + 500, parent: { key: native.key, via: "file", exact: true } });
    mac.agent(sub);                                               // the ACP child's own subagent chains below it
    const chained = await waitFor(() => linkTo(hub, sub.key), { what: "subagent of acp child" });
    assert.equal(chained.from, native.key);

    const envNative = agentRecord("mac", "codex", "x2", { startedAt: T0 + 1000, parent: { kind: "dsh", id: "d-2", via: "env", exact: true } });
    const dsh2 = agentRecord("mac", "dsh", "d-2", { startedAt: T0, acp: { provider: "acp-codex", kind: "codex", id: "x2" } });
    mac.agent(envNative); mac.agent(dsh2);
    const both = await waitFor(() => linkTo(hub, envNative.key), { what: "acp vs env" });
    assert.equal(both.via, "acp", "acp is more specific than the env hint that names the same DSH session");

    const resumed = agentRecord("mac", "claude", "resumed", { startedAt: T0 - 500_000 });      // a native session DSH adopted later
    const adopter = agentRecord("mac", "dsh", "d-3", { startedAt: T0, acp: { provider: "acp-claude", kind: "claude", id: "resumed" } });
    mac.agent(resumed); mac.agent(adopter);
    const adopted = await waitFor(() => linkTo(hub, resumed.key), { what: "acp link of a session that predates its DSH session" });
    assert.deepEqual({ from: adopted.from, via: adopted.via }, { from: adopter.key, via: "acp" }, "a recorded binding is not subject to the start-time rule");
  });

  test("preference: file > acp > env > process > command, and an outer env hint never overrides a file link", async t => {
    const { hub } = await startTestHub(t);
    const mac = connectCollector(hub, { id: "mac", site: "mac" });
    const outer = agentRecord("mac", "dsh", "q1", { startedAt: T0 - 9000 });
    const inner = agentRecord("mac", "codex", "p1", { startedAt: T0 - 5000 });
    const child = agentRecord("mac", "omp", "c1", { startedAt: T0, parent: { key: inner.key, via: "file", exact: true } });
    mac.agent(outer); mac.agent(inner); mac.agent(child);
    mac.procs([{ pid: 5, ppid: 1, kind: "omp", startedAt: T0, cmd: "omp", agent: child.key, parentSession: { kind: "dsh", id: "q1", via: "env", exact: true } }]);
    const link = await waitFor(() => linkTo(hub, child.key), { what: "link" });
    assert.deepEqual({ from: link.from, via: link.via }, { from: inner.key, via: "file" });

    // two env candidates: the innermost (latest started) parent wins
    const leaf = agentRecord("mac", "claude", "leaf", { startedAt: T0 + 100 });
    mac.agent(leaf);
    mac.procs([
      { pid: 5, ppid: 1, kind: "omp", startedAt: T0, cmd: "omp", agent: child.key, parentSession: { kind: "dsh", id: "q1", via: "env", exact: true } },
      { pid: 6, ppid: 5, kind: "claude", startedAt: T0 + 100, cmd: "claude", agent: leaf.key, parent: "dsh:q1", parentSession: { kind: "omp", id: "c1", via: "env", exact: true } },
    ]);
    const nearest = await waitFor(() => linkTo(hub, leaf.key), { what: "env link" });
    assert.equal(nearest.from, child.key);
  });

  test("a child is never parented to an agent that started after it, and cycles are not closed", async t => {
    const { hub } = await startTestHub(t);
    const mac = connectCollector(hub, { id: "mac", site: "mac" });
    const late = agentRecord("mac", "omp", "late", { startedAt: T0 + 5000 });
    const early = agentRecord("mac", "omp", "early", { startedAt: T0, parent: { key: late.key, via: "file", exact: true } });
    mac.agent(early); mac.agent(late);
    await waitFor(() => agentOf(hub, late.key));
    assert.equal(linkTo(hub, early.key), undefined, "the named parent started later");

    const a = agentRecord("mac", "omp", "a", { startedAt: T0 + 9000, parent: { key: agentKey("mac", "omp", "b"), via: "file", exact: true } });
    const b = agentRecord("mac", "omp", "b", { startedAt: T0 + 9000, parent: { key: a.key, via: "file", exact: true } });
    mac.agent(a); mac.agent(b);
    await waitFor(() => agentOf(hub, b.key));
    await sleep(50);
    assert.equal(links(hub).filter(link => link.to === a.key || link.to === b.key).length, 1, "exactly one direction of an a↔b hint cycle becomes a link");
  });

  test("removing an agent drops its links, and a re-sent parent restores them", async t => {
    const { hub } = await startTestHub(t);
    const mac = connectCollector(hub, { id: "mac", site: "mac" });
    const parent = agentRecord("mac", "omp", "p", { startedAt: T0 - 1000 });
    const child = agentRecord("mac", "omp", "c", { parent: { key: parent.key, via: "file", exact: true } });
    mac.agent(parent); mac.agent(child);
    await waitFor(() => linkTo(hub, child.key));
    mac.gone(parent.key);
    await waitFor(() => !agentOf(hub, parent.key));
    assert.equal(linkTo(hub, child.key), undefined);
    mac.agent(parent);
    assert.equal((await waitFor(() => linkTo(hub, child.key))).from, parent.key);
  });

  test("a launch aimed at a whole kube site (no pod named) matches a session on any pod of that site, never of another site", async t => {
    const { hub } = await startTestHub(t);
    const mac = connectCollector(hub, { id: "mac", site: "mac" });
    const podA = connectCollector(hub, { id: "k8s/os/pod-a", site: "os", kind: "pod", pod: "pod-a" });
    const podB = connectCollector(hub, { id: "k8s/chengdu/pod-b", site: "chengdu", kind: "pod", pod: "pod-b" });
    const owner = agentRecord("mac", "omp", "owner", { startedAt: T0 - 60_000 });
    const inSite = agentRecord("k8s/os/pod-a", "claude", "c-os", { startedAt: T0 + 4000 });
    const otherSite = agentRecord("k8s/chengdu/pod-b", "claude", "c-cd", { startedAt: T0 + 1000 });
    podA.agent(inSite); podB.agent(otherSite); mac.agent(owner);
    mac.events(owner.key, [toolEvent("call-3", T0, { targets: [{ type: "agent", op: "launch", kind: "claude", site: "os" }] })]);
    const link = await waitFor(() => linkTo(hub, inSite.key), { what: "site-wide launch link" });
    assert.deepEqual({ from: link.from, via: link.via, toolCallId: link.toolCallId }, { from: owner.key, via: "command", toolCallId: "call-3" });
    assert.equal(linkTo(hub, otherSite.key), undefined);
  });
});

// ------------------------------------------------------------------------- state, events, clock, queries

describe("state", () => {
  test("collector timestamps are shifted by the host's clock skew", async t => {
    const { hub } = await startTestHub(t);
    const behind = 5000;                                        // the collector's clock runs 5 s behind the hub's
    const col = connectCollector(hub, { id: "sg-compute", site: "sg-compute" }, { clock: () => Date.now() - behind });
    const sent = agentRecord("sg-compute", "omp", "s1", { startedAt: T0 - behind, updatedAt: T0 - behind });
    col.agent(sent);
    col.events(sent.key, [toolEvent("e1", T0 - behind)]);
    await waitFor(() => hub.state.agentEvents(sent.key).events.length === 1);
    const shift = agentOf(hub, sent.key).startedAt - sent.startedAt;
    assert.ok(shift > behind - 200 && shift < behind + 800, `agent time shifted by ${shift} ms`);
    const eventShift = hub.state.agentEvents(sent.key).events[0].t - (T0 - behind);
    assert.ok(Math.abs(eventShift - shift) < 5, "events use the same shift");
    const host = hub.state.host("sg-compute");
    assert.ok(Math.abs(host.skewMs - shift) < 5);
  });

  test("events upsert by id (pending → ok), feed carries only tool/spawn/error, paging uses an exclusive `before`", async t => {
    const { hub, get } = await startTestHub(t);
    const mac = connectCollector(hub, { id: "mac", site: "mac" });
    const record = agentRecord("mac", "omp", "e1", { counts: { turns: 1, tools: 10, errors: 0, subagents: 0, events: 10 } });
    mac.agent(record);
    const events = Array.from({ length: 10 }, (_, i) => toolEvent(`t${i}`, T0 + (i + 1) * 1000, { status: i === 9 ? "pending" : "ok" }));
    mac.events(record.key, [...events, { id: "user:1", type: "user", t: T0 + 500, text: "hello" }]);
    await waitFor(() => hub.state.agentEvents(record.key).events.length === 11);
    mac.events(record.key, [toolEvent("t9", T0 + 10_000, { status: "ok", duration: 1234 })]);
    await waitFor(() => hub.state.agentEvents(record.key).events.find(event => event.id === "t9")?.status === "ok");

    const snapshot = (await get("/api/snapshot")).json;
    assert.deepEqual(snapshot.feed.map(item => item.event.id), events.map(event => event.id), "feed: tools only, oldest first, upserted event not duplicated");
    assert.equal(snapshot.feed.at(-1).event.duration, 1234);

    const page = (await get(`/api/agent?key=${encodeURIComponent(record.key)}&limit=4`)).json;
    assert.deepEqual(page.events.map(event => event.id), ["t6", "t7", "t8", "t9"]);
    assert.equal(page.hasMore, true);
    const older = (await get(`/api/agent?key=${encodeURIComponent(record.key)}&limit=4&before=${T0 + 7000}`)).json;
    assert.deepEqual(older.events.map(event => event.id), ["t2", "t3", "t4", "t5"], "`before` is exclusive");
    const oldest = (await get(`/api/agent?key=${encodeURIComponent(record.key)}&limit=50&before=${T0 + 3000}`)).json;
    assert.deepEqual(oldest.events.map(event => event.id), ["user:1", "t0", "t1"]);
    assert.equal(oldest.hasMore, false);
  });

  test("history older than the hub's ring is fetched from the collector", async t => {
    const { hub, get } = await startTestHub(t);
    const mac = connectCollector(hub, { id: "mac", site: "mac" }, {
      onRequest: (method, params) => {
        assert.equal(method, "agent.events");
        return { key: params.key, events: [toolEvent("old1", 100), toolEvent("old2", 200)], hasMore: false };
      },
    });
    const record = agentRecord("mac", "omp", "h1", { counts: { turns: 1, tools: 5, errors: 0, subagents: 0, events: 5 } });
    mac.agent(record);
    mac.events(record.key, [toolEvent("n1", T0), toolEvent("n2", T0 + 1000), toolEvent("n3", T0 + 2000)]);
    await waitFor(() => hub.state.agentEvents(record.key).events.length === 3);
    const reply = (await get(`/api/agent?key=${encodeURIComponent(record.key)}&limit=10&before=${T0}`)).json;
    assert.deepEqual(reply.events.map(event => event.id), ["old1", "old2"]);
    assert.equal(reply.hasMore, false);
    assert.ok(Math.abs(mac.requests[0].params.before - T0) < 100, "the collector is asked for events before the oldest one the hub has (in its own clock)");
  });

  test("family returns root first with descendants, their links and events", async t => {
    const { hub, get } = await startTestHub(t);
    const mac = connectCollector(hub, { id: "mac", site: "mac" });
    const pod = connectCollector(hub, { id: "k8s/os/pod-x", site: "os", kind: "pod", pod: "pod-x" });
    const root = agentRecord("mac", "dsh", "root", { startedAt: T0 - 9000 });
    const mid = agentRecord("mac", "codex", "mid", { startedAt: T0 - 5000, parent: { key: root.key, via: "acp", exact: true } });
    const leaf = agentRecord("k8s/os/pod-x", "claude", "leaf", { startedAt: T0, parent: { kind: "codex", id: "mid", via: "env", exact: true } });
    const stranger = agentRecord("mac", "omp", "stranger", { startedAt: T0 });
    mac.agent(root); mac.agent(mid); mac.agent(stranger); pod.agent(leaf);
    mac.events(root.key, [toolEvent("r1", T0)]); pod.events(leaf.key, [toolEvent("l1", T0 + 1), toolEvent("l2", T0 + 2)]);
    await waitFor(() => linkTo(hub, leaf.key) && hub.state.agentEvents(leaf.key).events.length === 2);
    const family = (await get(`/api/family?key=${encodeURIComponent(leaf.key)}`)).json;
    assert.equal(family.root, root.key);
    assert.deepEqual(family.agents.map(agent => agent.key), [root.key, mid.key, leaf.key]);
    assert.deepEqual(family.links.map(link => `${link.from}>${link.to}`), [`${root.key}>${mid.key}`, `${mid.key}>${leaf.key}`]);
    assert.deepEqual(family.events[leaf.key].map(event => event.id), ["l1", "l2"]);
    assert.equal((await get("/api/family?key=nope")).status, 404);
  });

  test("query filters by kind, category, target type, text and time", async t => {
    const { hub, get } = await startTestHub(t);
    const mac = connectCollector(hub, { id: "mac", site: "mac" });
    const server = connectCollector(hub, { id: "server-bochao-01", site: "server-bochao-01" });
    const a = agentRecord("mac", "omp", "qa"), b = agentRecord("server-bochao-01", "claude", "qb");
    mac.agent(a); server.agent(b);
    mac.events(a.key, [
      toolEvent("a1", T0 + 1000, { name: "read", category: "read", preview: "src/main.ts", targets: [{ type: "file", op: "read", host: "mac", path: "/w/src/main.ts" }] }),
      toolEvent("a2", T0 + 2000, { name: "bash", category: "shell", preview: "kubectl logs pod-1", targets: [{ type: "pod", op: "logs", site: "os", name: "pod-1" }] }),
    ]);
    server.events(b.key, [toolEvent("b1", T0 + 3000, { name: "edit", category: "edit", preview: "patch", targets: [{ type: "file", op: "edit", host: "server-bochao-01", path: "/srv/app.py" }] })]);
    await waitFor(() => hub.state.query({ limit: 10 }).items.length === 3);
    const ids = reply => reply.json.items.map(item => item.event.id);
    assert.deepEqual(ids(await get("/api/query?target=file")), ["b1", "a1"], "newest first");
    assert.deepEqual(ids(await get("/api/query?kind=omp")), ["a2", "a1"]);
    assert.deepEqual(ids(await get("/api/query?category=read,edit")), ["b1", "a1"]);
    assert.deepEqual(ids(await get("/api/query?text=kubectl")), ["a2"]);
    assert.deepEqual(ids(await get("/api/query?target=pod&site=mac")), ["a2"]);
    assert.deepEqual(ids(await get(`/api/query?since=${T0 + 2500}`)), ["b1"]);
    const limited = (await get("/api/query?limit=1")).json;
    assert.equal(limited.items.length, 1);
    assert.equal(limited.total, 3);
    assert.equal(limited.items[0].agent, b.key);
  });

  test("a collector cannot write another host's agents", async t => {
    const { hub } = await startTestHub(t);
    const mac = connectCollector(hub, { id: "mac", site: "mac" });
    mac.agent(agentRecord("server-bochao-01", "omp", "forged"));
    mac.agent(agentRecord("mac", "omp", "real"));
    await waitFor(() => agentOf(hub, agentKey("mac", "omp", "real")));
    assert.equal(agentOf(hub, agentKey("server-bochao-01", "omp", "forged")), undefined);
  });

  test("hosts report agent and running counts", async t => {
    const { hub, get } = await startTestHub(t);
    const mac = connectCollector(hub, { id: "mac", site: "mac" });
    mac.agent(agentRecord("mac", "omp", "r1")); mac.agent(agentRecord("mac", "omp", "d1", { status: "done" }));
    await waitFor(() => (hub.state.host("mac")?.counts.agents ?? 0) === 2);
    const hosts = (await get("/api/hosts")).json.hosts;
    assert.deepEqual(hosts.map(host => ({ id: host.id, status: host.status, counts: host.counts })), [{ id: "mac", status: "online", counts: { agents: 2, running: 1 } }]);
  });

  test("setPods replaces the site's set by default and upserts with {replace:false}; other sites are untouched", () => {
    const state = createState({ hostId: "h" });
    const pod = (site, name) => ({ key: `${site}/mc-bochao-li/${name}`, site, cluster: site, namespace: "mc-bochao-li", name, phase: "Running", ready: "1/1", restarts: 0, containers: [], requests: {}, labels: {}, collect: false });
    const has = (site, name) => state.podRecord(`${site}/mc-bochao-li/${name}`) !== undefined;
    state.setPods("os", [pod("os", "a"), pod("os", "b")]);
    state.setPods("chengdu", [pod("chengdu", "c")]);
    assert.ok(has("os", "a") && has("os", "b") && has("chengdu", "c"));
    state.setPods("os", [pod("os", "d")], { replace: false });
    assert.ok(has("os", "a") && has("os", "b") && has("os", "d"), "an upsert keeps what was there");
    state.setPods("os", [pod("os", "d")]);
    assert.ok(!has("os", "a") && !has("os", "b"), "a complete list drops the site's other pods");
    assert.ok(has("os", "d") && has("chengdu", "c"), "…and leaves other sites alone");
    state.close();
  });
});

// ----------------------------------------------------------------------------- snapshot, changes, stream

describe("snapshot, changes and stream", () => {
  test("snapshot shape, changes since a cursor, and a delta stream within 500 ms", async t => {
    const { hub, get, url, token } = await startTestHub(t);
    const mac = connectCollector(hub, { id: "mac", site: "mac" });
    const first = agentRecord("mac", "omp", "s1");
    mac.agent(first);
    await waitFor(() => agentOf(hub, first.key));

    const snapshot = (await get("/api/snapshot")).json;
    assert.equal(snapshot.hub.hostId, "server-bochao-01");
    assert.equal(snapshot.hub.version, "9.9.9");
    for (const field of ["cursor", "now", "hosts", "agents", "links", "pods", "feed", "sources"]) assert.ok(field in snapshot, `snapshot.${field}`);
    assert.deepEqual(snapshot.agents.map(agent => agent.key), [first.key]);

    const stream = await openStream(url, token, snapshot.cursor);
    t.after(() => stream.close());
    assert.equal(stream.response.headers.get("content-type"), "text/event-stream; charset=utf-8");
    await waitFor(() => stream.deltas().length >= 1, { what: "initial delta" });
    assert.equal(stream.deltas()[0].delta.cursor, snapshot.cursor);
    assert.equal(stream.deltas()[0].delta.agents, undefined, "nothing changed since the snapshot");

    const second = agentRecord("mac", "codex", "s2");
    const sentAt = performance.now();
    mac.agent(second);
    const frame = await waitFor(() => stream.deltas().find(item => item.delta.agents?.some(agent => agent.key === second.key)), { timeoutMs: 1500, what: "streamed delta" });
    assert.ok(frame.at - sentAt < 500, `delta arrived after ${(frame.at - sentAt).toFixed(0)} ms`);
    assert.ok(frame.delta.cursor > snapshot.cursor);

    const changes = (await get(`/api/changes?since=${snapshot.cursor}`)).json;
    assert.deepEqual(changes.agents.map(agent => agent.key), [second.key]);
    assert.equal(changes.cursor, frame.delta.cursor);
    const quiet = (await get(`/api/changes?since=${changes.cursor}`)).json;
    assert.equal(quiet.cursor, changes.cursor);
    assert.equal(quiet.agents, undefined);
    assert.ok(Number.isFinite(quiet.now));
  });

  test("a burst is coalesced: deltas are at least ~200 ms apart and the last one carries the final state", async t => {
    const { hub, url, token } = await startTestHub(t);
    const mac = connectCollector(hub, { id: "mac", site: "mac" });
    const record = agentRecord("mac", "omp", "burst");
    mac.agent(record);
    await waitFor(() => agentOf(hub, record.key));
    const stream = await openStream(url, token);
    t.after(() => stream.close());
    await waitFor(() => stream.deltas().length >= 1);
    await sleep(300);
    const before = stream.deltas().length;
    for (let i = 1; i <= 80; i += 1) mac.agent({ ...record, updatedAt: T0 + i, counts: { ...record.counts, tools: i } });
    await waitFor(() => stream.deltas().slice(before).some(item => item.delta.agents?.[0]?.counts.tools === 80), { timeoutMs: 2500, what: "final state" });
    const fresh = stream.deltas().slice(before);
    assert.ok(fresh.length <= 3, `${fresh.length} deltas for one burst`);
    for (let i = 1; i < fresh.length; i += 1) assert.ok(fresh[i].at - fresh[i - 1].at >= 150, "coalesced to ≤ 1 per ~200 ms");
  });

  test("a stale or foreign cursor gets reset:true; the journal keeps exactly the last N changes", () => {
    const state = createState({ journalSize: 50, coalesceMs: 5, hostId: "h" });
    state.hostConnected({ id: "mac", site: "mac" }, { at: Date.now() });
    const mine = agentRecord("mac", "omp", "x");
    const start = state.cursor;
    for (let i = 0; i < 120; i += 1) state.applyCollectorMessage("mac", { t: "agent", agent: { ...mine, updatedAt: T0 + i } });
    assert.ok(state.cursor - start >= 120, "every update is one journal entry");
    assert.equal(state.changesSince(start).reset, true, "older than the journal");
    assert.equal(state.changesSince(0).reset, true);
    assert.equal(state.changesSince(state.cursor + 1).reset, true, "from the future: another hub run");
    assert.equal(state.changesSince("nonsense").reset, true);
    const edge = state.changesSince(state.cursor - 50);
    assert.equal(edge.reset, undefined, "exactly journalSize changes back is still servable");
    assert.equal(edge.agents.length, 1);
    assert.equal(state.changesSince(state.cursor - 51).reset, true);
    const quiet = state.changesSince(state.cursor);
    assert.equal(quiet.reset, undefined);
    assert.equal(quiet.agents, undefined);
    state.close();
  });

  test("over HTTP: an old cursor resets, the stream announces the reset instead of failing", async t => {
    const { get, url, token } = await startTestHub(t);
    assert.equal((await get("/api/changes?since=1")).json.reset, true);
    assert.equal((await get("/api/changes")).status, 400);
    const stream = await openStream(url, token, 1);
    t.after(() => stream.close());
    const frame = await waitFor(() => stream.deltas()[0], { what: "reset frame" });
    assert.equal(frame.delta.reset, true);
  });

  test("SSE sends keep-alive comments", async t => {
    const { url, token } = await startTestHub(t, { http: { keepAliveMs: 60 } });
    const stream = await openStream(url, token);
    t.after(() => stream.close());
    await waitFor(() => stream.frames.some(frame => frame.comment), { what: "keep-alive comment" });
  });

  test("hosts, removal and pods travel in deltas; a removed agent is listed in `removed`", async t => {
    const { hub, get } = await startTestHub(t);
    const mac = connectCollector(hub, { id: "mac", site: "mac" });
    const record = agentRecord("mac", "omp", "gone-soon");
    mac.agent(record);
    await waitFor(() => agentOf(hub, record.key));
    const cursor = (await get("/api/snapshot")).json.cursor;
    mac.gone(record.key);
    await waitFor(() => !agentOf(hub, record.key));
    const delta = (await get(`/api/changes?since=${cursor}`)).json;
    assert.deepEqual(delta.removed, [record.key]);
    assert.ok(delta.hosts.some(host => host.id === "mac" && host.counts.agents === 0));
  });

  test("a restarted hub never accepts a cursor of the previous run, even when the numbers would overlap", () => {
    const startFirst = 1_900_000_000_000;
    const mine = agentRecord("mac", "omp", "x");
    const first = createState({ now: () => startFirst, hostId: "h" });
    first.hostConnected({ id: "mac", site: "mac" }, { at: startFirst });
    for (let i = 0; i < 5000; i += 1) first.applyCollectorMessage("mac", { t: "agent", agent: { ...mine, updatedAt: T0 + i } });
    const oldCursor = first.cursor;
    first.close();
    const second = createState({ now: () => startFirst + 2000, hostId: "h" });       // a crash loop restarts two seconds later
    second.hostConnected({ id: "mac", site: "mac" }, { at: startFirst + 2000 });
    for (let i = 0; i < 4000; i += 1) second.applyCollectorMessage("mac", { t: "agent", agent: { ...mine, updatedAt: T0 + i } });
    assert.equal(second.changesSince(oldCursor).reset, true, "the old client must reload instead of receiving a delta that misses the first run");
    assert.equal(second.changesSince(second.cursor - 10).reset, undefined, "this run's own cursors work");
    second.close();
  });
});

// ---------------------------------------------------------------------------------------------------- auth

describe("auth and HTTP surface", () => {
  test("token file is created 0600 with 64 hex and reused; no token → 401, health leaks nothing but liveness", async t => {
    const { get, tokenFile, token, hub } = await startTestHub(t);
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
    assert.equal((await get("/api/snapshot", { auth: null })).status, 401);
    assert.equal((await get("/api/snapshot", { auth: "wrong".repeat(10) })).status, 401);
    assert.equal((await get("/api/stream", { auth: null })).status, 401);
    assert.equal((await get("/api/file?host=mac&path=/x", { auth: null })).status, 401);
    const health = await get("/api/health", { auth: null });
    assert.equal(health.status, 200, "liveness stays reachable without credentials");
    assert.deepEqual(health.json, { ok: true, version: "9.9.9" }, "ports, hostId, upstream and kube state are not public");
    assert.equal((await get("/api/health", { auth: "wrong".repeat(10) })).json.hostId, undefined, "a wrong token buys no topology either");
    const full = await get("/api/health");
    assert.equal(full.json.ok, true);
    assert.equal(full.json.hostId, "server-bochao-01");
    assert.equal(full.json.http.port, hub.http.port);
    assert.ok(!full.text.includes(token));
    assert.equal((await get("/api/nonsense")).status, 404);

    const again = await startHub({ hostId: "x", log: () => {}, http: { port: 0, tokenFile, panelDir } });
    t.after(() => again.stop());
    assert.equal(readFileSync(tokenFile, "utf8").trim(), token, "an existing token is kept");
  });

  test("bearer, header and cookie credentials work; `/?token=` exchanges the token for an HttpOnly cookie", async t => {
    const { url, token, get } = await startTestHub(t);
    assert.equal((await get("/api/hosts", { auth: null, headers: { authorization: `Bearer ${token}` } })).status, 200);
    assert.equal((await get("/api/hosts", { auth: token })).status, 200);

    const bad = await fetch(`${url}/?token=nope`, { redirect: "manual" });
    assert.equal(bad.status, 401);
    assert.equal(bad.headers.get("set-cookie"), null);

    const exchange = await fetch(`${url}/?token=${token}&focus=abc`, { redirect: "manual" });
    assert.equal(exchange.status, 302);
    assert.equal(exchange.headers.get("location"), "./?focus=abc", "the token is dropped from the URL, other parameters stay");
    const cookie = exchange.headers.get("set-cookie");
    assert.equal(cookie, `agent_fleet=${token}; HttpOnly; SameSite=Strict; Path=/`);
    const viaCookie = await fetch(`${url}/api/hosts`, { headers: { cookie: cookie.split(";")[0] } });
    assert.equal(viaCookie.status, 200);
    assert.equal((await fetch(`${url}/api/hosts`, { headers: { cookie: "agent_fleet=wrong" } })).status, 401);
  });

  test("panel session: the token mints a one-time nonce, the nonce buys one session key that works as a header", async t => {
    const { url, token } = await startTestHub(t, { http: { base: "/fleet" } });
    const post = (path, headers) => fetch(`${url}${path}`, { method: "POST", headers, redirect: "manual" });
    const mint = headers => post("/api/session-nonce", headers);

    const anonymous = await mint({});
    assert.equal(anonymous.status, 401, "no token, no nonce");
    assert.equal(anonymous.headers.get("set-cookie"), null);
    assert.equal((await mint({ "x-agent-fleet-token": "wrong".repeat(10) })).status, 401);

    const first = await mint({ "x-agent-fleet-token": token });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("cache-control"), "no-store");
    const minted = await first.json();
    assert.match(minted.nonce, /^[A-Za-z0-9_-]{16,}$/);
    assert.ok(minted.expiresAt > Date.now());
    assert.equal(first.headers.get("set-cookie"), `agent_fleet=${token}; HttpOnly; SameSite=Strict; Path=/`, "the mint also stores the cookie, so a fragment token survives a reload");

    const redeemed = await post("/api/session", { "x-agent-fleet-nonce": minted.nonce });
    assert.equal(redeemed.status, 200);
    assert.equal(redeemed.headers.get("cache-control"), "no-store");
    assert.equal(redeemed.headers.get("set-cookie"), `agent_fleet=${token}; HttpOnly; SameSite=Strict; Path=/`, "a same-site page also gets the cookie");
    const { session } = await redeemed.json();
    assert.match(session, /^[A-Za-z0-9_-]{32}$/);
    assert.notEqual(session, token);
    // An iframe of another site (the desktop app's dsh-app:// page) never sends the SameSite cookie: the key alone has to do.
    assert.equal((await fetch(`${url}/api/hosts`, { headers: { "x-agent-fleet-token": session } })).status, 200, "the session key authenticates as a header");
    assert.equal((await fetch(`${url}/api/hosts`, { headers: { authorization: `Bearer ${session}` } })).status, 200);
    const stream = await fetch(`${url}/api/stream`, { headers: { "x-agent-fleet-token": session } });
    assert.equal(stream.status, 200, "and opens the SSE stream");
    await stream.body.cancel();
    assert.equal((await mint({ "x-agent-fleet-token": session })).status, 401, "a session key reads; it cannot mint nonces");

    assert.equal((await post("/api/session", { "x-agent-fleet-nonce": minted.nonce })).status, 401, "single use");
    assert.equal((await post("/api/session", { "x-agent-fleet-nonce": "nope" })).status, 401);
    assert.equal((await post("/api/session", {})).status, 401);
    const underBase = (await (await mint({ "x-agent-fleet-token": token })).json()).nonce;
    assert.equal((await post("/fleet/api/session", { "x-agent-fleet-nonce": underBase })).status, 200, "the edge strips /fleet, so the redemption answers under the base too");
    assert.equal((await fetch(`${url}/api/session-nonce`, { headers: { "x-agent-fleet-token": token } })).status, 404, "GET mints nothing");
  });

  test("nonces expire, are single use and stay bounded; session keys are capped, least recently used first", () => {
    let now = 1000;
    const auth = createAuth({ token: "t".repeat(64), nonceTtlMs: 50, nonceLimit: 2, sessionLimit: 2, now: () => now });
    const as = key => ({ headers: { "x-agent-fleet-token": key } });
    const once = auth.mintNonce();
    const key = auth.openSession(once.nonce);
    assert.match(key, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(auth.authenticate(as(key)), true);
    assert.equal(auth.holdsToken(as(key)), false, "a session key is not the token");
    assert.equal(auth.holdsToken(as("t".repeat(64))), true);
    assert.equal(auth.openSession(once.nonce), null, "single use");
    assert.equal(auth.openSession(""), null);
    assert.equal(auth.openSession(undefined), null);
    const late = auth.mintNonce();
    now += 51;
    assert.equal(auth.openSession(late.nonce), null, "expired");
    const a = auth.mintNonce(), b = auth.mintNonce(), c = auth.mintNonce();
    assert.equal(auth.openSession(a.nonce), null, "the oldest pending nonce was evicted at the limit");
    const older = auth.openSession(b.nonce);
    assert.equal(auth.authenticate(as(key)), true, "a key in use moves to the back");
    const newest = auth.openSession(c.nonce);
    assert.equal(auth.authenticate(as(older)), false, "at the cap the least recently used key goes first");
    assert.equal(auth.authenticate(as(key)), true);
    assert.equal(auth.authenticate(as(newest)), true);
  });

  test("Host header: loopback names and configured public hosts pass; X-Forwarded-Host opens nothing else", async t => {
    const call = (port, headers) => new Promise((resolve, reject) => {
      const request = httpRequest({ host: "127.0.0.1", port, path: "/api/health", headers }, response => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
      request.on("error", reject);
      request.end();
    });
    const { hub } = await startTestHub(t, { http: { publicHosts: ["10.0.60.98"] } });
    const port = hub.http.port;
    assert.equal(await call(port, { host: `localhost:${port}` }), 200);
    assert.equal(await call(port, { host: "10.0.60.98:443" }), 200, "configured public host");
    assert.equal(await call(port, { host: "evil.example", "x-forwarded-host": "evil.example" }), 403, "a forwarded rebinding name opens nothing");
    assert.equal(await call(port, { host: "evil.example", "x-forwarded-host": "10.0.60.98:443" }), 200, "a loopback proxy may forward the configured public name");
    assert.equal(await call(port, { host: "evil.example", "x-forwarded-host": "localhost:7840" }), 200, "a forwarded loopback name");
    assert.equal(await call(port, { host: "evil.example" }), 403, "rebinding name without the edge");

    const bare = await startTestHub(t);                       // no --public-host: only loopback names are served
    assert.equal(await call(bare.hub.http.port, { host: "10.0.60.98:443", "x-forwarded-host": "10.0.60.98:443" }), 403, "the public name has to be configured");
  });

  test("panel files: right content types, no-store, no framing headers, nothing outside the panel dir", async t => {
    const { url, hub } = await startTestHub(t);
    const root = await fetch(`${url}/`);
    assert.equal(root.status, 200);
    assert.equal(root.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(root.headers.get("cache-control"), "no-store");
    assert.equal(root.headers.get("x-frame-options"), null);
    assert.equal(root.headers.get("content-security-policy"), null);
    assert.equal(await root.text(), "<!doctype html><title>fleet</title>");
    assert.equal((await fetch(`${url}/app.js`)).headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal((await fetch(`${url}/app.css`)).headers.get("content-type"), "text/css; charset=utf-8");
    // panel/fixtures is dev material; the hub refuses it (F9), case-insensitively.
    assert.equal((await fetch(`${url}/fixtures/demo.json`)).status, 404);
    assert.equal((await fetch(`${url}/fixtures/make-demo.mjs`)).status, 404);
    assert.equal((await fetch(`${url}/Fixtures/demo.json`)).status, 404);
    assert.equal((await fetch(`${url}/.hidden.js`)).status, 404);
    assert.equal((await fetch(`${url}/notes.exe`)).status, 404);
    assert.equal((await fetch(`${url}/missing.js`)).status, 404);
    const traversal = await new Promise((resolve, reject) => {
      const request = httpRequest({ host: "127.0.0.1", port: hub.http.port, path: "/%2e%2e/%2e%2e/hub.test.mjs" }, response => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
      request.on("error", reject); request.end();
    });
    assert.equal(traversal, 404);
    const post = await fetch(`${url}/api/hosts`, { method: "POST" });
    assert.equal(post.status, 405);
  });

  test("--base: every route also answers under the prefix; the bare prefix redirects without caching or a referrer", async t => {
    const { url, token, get } = await startTestHub(t, { http: { base: "/fleet/" } });
    assert.equal((await get("/fleet/api/health", { auth: null })).status, 200);
    assert.equal((await get("/api/health", { auth: null })).status, 200, "the edge strips the prefix, so the bare routes work too");
    assert.equal((await get("/fleet/api/hosts")).status, 200);
    const bare = await fetch(`${url}/fleet?x=1`, { redirect: "manual" });
    assert.equal(bare.status, 302);
    assert.equal(bare.headers.get("location"), "/fleet/?x=1");
    assert.equal(bare.headers.get("cache-control"), "no-store");
    assert.equal(bare.headers.get("referrer-policy"), "no-referrer");
    const exchange = await fetch(`${url}/fleet/?token=${token}`, { redirect: "manual" });
    assert.equal(exchange.headers.get("location"), "./");
    assert.equal(exchange.headers.get("cache-control"), "no-store");
    assert.equal(exchange.headers.get("referrer-policy"), "no-referrer");
    assert.equal((await fetch(`${url}/fleet/app.js`)).status, 200);
    assert.equal((await fetch(`${url}/fleet/fixtures/demo.json`)).status, 404, "the fixtures directory is refused behind the edge too");
  });

  test("the HTTP and ingest listeners refuse non-loopback binds", async () => {
    const tokenFile = join(tmp, "bind.token");
    await assert.rejects(startHub({ log: () => {}, http: { host: "0.0.0.0", port: 0, tokenFile } }), /loopback/);
    await assert.rejects(startHub({ log: () => {}, ingest: { host: "10.0.60.98", port: 0 } }), /loopback/);
  });
});

// ------------------------------------------------------------------------------------------------ file proxy

describe("file proxy", () => {
  test("api/file goes to the host's collector; secret paths are refused before any request is sent", async t => {
    const { hub, get } = await startTestHub(t);
    const mac = connectCollector(hub, { id: "mac", site: "mac" }, {
      onRequest: (method, params) => {
        assert.equal(method, "file.read");
        return { host: "mac", path: params.path, exists: true, size: 11, content: "hello world", truncated: false, binary: false, redactions: 0 };
      },
    });
    await waitFor(() => hub.state.host("mac"));
    const ok = await get(`/api/file?host=mac&path=${encodeURIComponent("/work/src/a.ts")}&maxBytes=100`);
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { host: "mac", path: "/work/src/a.ts", exists: true, size: 11, content: "hello world", truncated: false, binary: false, redactions: 0 });
    assert.deepEqual(mac.requests.map(request => request.params), [{ path: "/work/src/a.ts", maxBytes: 100 }]);

    const secret = await get(`/api/file?host=mac&path=${encodeURIComponent("/home/u/.ssh/id_rsa")}`);
    assert.equal(secret.status, 200);
    assert.equal(secret.json.exists, false);
    assert.match(secret.json.denied, /secret/);
    assert.equal(mac.requests.length, 1, "the collector was not asked");
    assert.equal((await get("/api/file?host=mac")).status, 400);
  });

  test("an unknown host is 404; an offline host is an error that says so", async t => {
    const { hub, get } = await startTestHub(t);
    const mac = connectCollector(hub, { id: "mac", site: "mac" });
    await waitFor(() => hub.state.host("mac"));
    mac.close();
    await waitFor(() => hub.state.host("mac").status === "offline");
    const offline = await get("/api/file?host=mac&path=/x");
    assert.equal(offline.status, 502);
    assert.match(offline.json.error, /mac is offline/);
    assert.equal((await get("/api/file?host=ghost&path=/x")).status, 404);
  });

  test("a collector error reply surfaces as an error response, not a hang", async t => {
    const { hub, get } = await startTestHub(t);
    connectCollector(hub, { id: "mac", site: "mac" }, { onRequest: () => { throw new Error("disk on fire"); } });
    await waitFor(() => hub.state.host("mac"));
    const reply = await get("/api/file?host=mac&path=/x");
    assert.equal(reply.status, 500);
    assert.match(reply.json.error, /disk on fire/);
  });
});

// --------------------------------------------------------------------------------- host offline handling

describe("host connection lifecycle", () => {
  test("disconnect keeps agents, marks the host offline and alive=null; running becomes stale after 60 s; reconnect restores", async t => {
    let clock = Date.now();
    const { hub } = await startTestHub(t, { now: () => clock });
    const col = connectCollector(hub, { id: "sg-compute", site: "sg-compute" }, { clock: () => clock });
    const running = agentRecord("sg-compute", "omp", "r1", { startedAt: clock });
    const finished = agentRecord("sg-compute", "claude", "d1", { startedAt: clock, status: "done", endedAt: clock, live: { alive: false, state: "ended", since: clock, doing: "", turnOpen: false } });
    col.agent(running); col.agent(finished);
    await waitFor(() => agentOf(hub, running.key) && agentOf(hub, finished.key));
    assert.equal(agentOf(hub, running.key).live.alive, true);

    col.close();
    await waitFor(() => hub.state.host("sg-compute").status === "offline");
    const host = hub.state.host("sg-compute");
    assert.match(host.error, /closed/);
    assert.equal(host.counts.agents, 2);
    assert.equal(agentOf(hub, running.key).live.alive, null);
    assert.equal(agentOf(hub, running.key).status, "running", "status unchanged right after the disconnect");
    assert.equal(agentOf(hub, finished.key).status, "done");

    clock += 59_000; hub.state.tick();
    assert.equal(agentOf(hub, running.key).status, "running");
    clock += 2000; hub.state.tick();
    assert.equal(agentOf(hub, running.key).status, "stale");
    assert.equal(agentOf(hub, finished.key).status, "done");
    assert.equal(hub.state.host("sg-compute").counts.running, 0);

    const again = connectCollector(hub, { id: "sg-compute", site: "sg-compute" }, { clock: () => clock });
    await waitFor(() => hub.state.host("sg-compute").status === "online");
    again.agent({ ...running, updatedAt: clock });
    await waitFor(() => agentOf(hub, running.key).status === "running");
    assert.equal(agentOf(hub, running.key).live.alive, true);
    assert.equal(hub.state.host("sg-compute").error, undefined);
  });

  test("a newer connection supersedes the older one without flapping the host offline", async t => {
    const { hub } = await startTestHub(t);
    const first = connectCollector(hub, { id: "mac", site: "mac" });
    await waitFor(() => hub.state.host("mac")?.status === "online");
    const connectedAt = hub.state.host("mac").connectedAt;
    await sleep(5);
    const second = connectCollector(hub, { id: "mac", site: "mac" });
    await waitFor(() => hub.state.host("mac").connectedAt > connectedAt);
    await waitFor(() => first.channel.closed, { what: "old channel closed by the hub" });
    await sleep(50);
    assert.equal(hub.state.host("mac").status, "online");
    second.agent(agentRecord("mac", "omp", "z"));
    await waitFor(() => agentOf(hub, agentKey("mac", "omp", "z")));
  });

  test("heartbeats update lag and stats; messages before hello are refused", async t => {
    const { hub } = await startTestHub(t);
    const col = connectCollector(hub, { id: "mac", site: "mac" });
    await waitFor(() => hub.state.host("mac"));
    col.heartbeat({ agents: 3, hot: 1, rssMb: 50 });
    const host = await waitFor(() => hub.state.host("mac").stats && hub.state.host("mac"));
    assert.deepEqual(host.stats, { agents: 3, hot: 1, rssMb: 50 });
    assert.ok(host.lagMs >= 0 && host.lagMs < 1000);
    assert.ok(Number.isFinite(host.lastSeen));

    const rude = connectCollector(hub, { id: "rude", site: "mac" }, { hello: false });
    rude.agent(agentRecord("rude", "omp", "x"));
    await waitFor(() => rude.channel.closed, { what: "hub to close a channel that skipped hello" });
    assert.equal(hub.state.host("rude"), undefined);
  });

  test("host ids may hold spaces and non-ASCII text but not '#', which would break agent keys", async t => {
    const { hub } = await startTestHub(t);
    const odd = connectCollector(hub, { id: "Mac mini（办公室）", site: "mac" });
    await waitFor(() => hub.state.host("Mac mini（办公室）")?.status === "online", { what: "odd host id accepted" });
    odd.agent(agentRecord("Mac mini（办公室）", "omp", "o1"));
    await waitFor(() => agentOf(hub, agentKey("Mac mini（办公室）", "omp", "o1")));
    const bad = connectCollector(hub, { id: "evil#omp:x", site: "mac" });
    await waitFor(() => bad.channel.closed, { what: "refused host id" });
    assert.equal(hub.state.host("evil#omp:x"), undefined);
  });
});

// -------------------------------------------------------------------------------------- ingest and dialing

describe("collector ingest (TCP) and dialing", () => {
  test("a collector connects over TCP and requests reach it", async t => {
    const { hub, get } = await startTestHub(t);
    const transport = await tcpTransport({ port: hub.ingest.port });
    const channel = createChannel({ ...transport, onRequest: (method, params) => ({ host: "sg-compute", path: params.path, exists: true, content: "tcp" }) });
    t.after(() => channel.close());
    channel.send({ t: "hello", proto: PROTOCOL_VERSION, at: Date.now(), host: hostInfo({ id: "sg-compute", site: "sg-compute" }) });
    await waitFor(() => hub.state.host("sg-compute")?.status === "online");
    assert.equal(hub.state.host("sg-compute").via, "socket");
    assert.equal((await get("/api/file?host=sg-compute&path=/x")).json.content, "tcp");
  });

  test("silent sockets and non-hello first messages are closed", async t => {
    const { hub } = await startTestHub(t, { ingest: { helloTimeoutMs: 150 } });
    const silent = await tcpTransport({ port: hub.ingest.port });
    const closedSilent = new Promise(resolve => silent.socket.once("close", resolve));
    await Promise.race([closedSilent, sleep(1500).then(() => { throw new Error("silent socket was not closed"); })]);

    const chatty = await tcpTransport({ port: hub.ingest.port });
    const closedChatty = new Promise(resolve => chatty.socket.once("close", resolve));
    chatty.socket.write(`${JSON.stringify({ t: "heartbeat", at: Date.now() })}\n`);
    await Promise.race([closedChatty, sleep(1500).then(() => { throw new Error("socket that skipped hello was not closed"); })]);
    assert.equal(hub.state.hosts().length, 0);
  });

  test("with an ingest token a hello without it is refused and one with it is accepted", async t => {
    const { hub } = await startTestHub(t, { ingest: { token: "s3cret-ingest-token" } });
    const refused = await tcpTransport({ port: hub.ingest.port });
    const closed = new Promise(resolve => refused.socket.once("close", resolve));
    refused.socket.write(`${JSON.stringify({ t: "hello", proto: PROTOCOL_VERSION, at: Date.now(), host: hostInfo({ id: "intruder", site: "mac" }) })}\n`);
    await closed;
    assert.equal(hub.state.host("intruder"), undefined);

    const accepted = await tcpTransport({ port: hub.ingest.port });
    t.after(() => accepted.close());
    accepted.socket.write(`${JSON.stringify({ t: "hello", proto: PROTOCOL_VERSION, at: Date.now(), token: "s3cret-ingest-token", host: hostInfo({ id: "mac", site: "mac" }) })}\n`);
    await waitFor(() => hub.state.host("mac")?.status === "online");
  });

  test("--ingest-token-file is created 0600; a missing or wrong token is refused, the file's token is accepted", async t => {
    const ingestTokenFile = join(tmp, "ingest.token");
    const { hub } = await startTestHub(t, { ingest: { tokenFile: ingestTokenFile } });
    const token = readFileSync(ingestTokenFile, "utf8").trim();
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(statSync(ingestTokenFile).mode & 0o777, 0o600);
    const hello = (id, helloToken) => `${JSON.stringify({ t: "hello", proto: PROTOCOL_VERSION, at: Date.now(), ...(helloToken === undefined ? {} : { token: helloToken }), host: hostInfo({ id, site: "mac" }) })}\n`;

    for (const [id, line] of [["no-token", hello("no-token")], ["wrong-token", hello("wrong-token", "f".repeat(64))]]) {
      const refused = await tcpTransport({ port: hub.ingest.port });
      const closed = new Promise(resolve => refused.socket.once("close", resolve));
      refused.socket.write(line);
      await closed;
      assert.equal(hub.state.host(id), undefined, `${id} must not be admitted`);
    }

    const accepted = await tcpTransport({ port: hub.ingest.port });
    t.after(() => accepted.close());
    accepted.socket.write(hello("authed-host", token));
    await waitFor(() => hub.state.host("authed-host")?.status === "online", { what: "the collector holding the ingest token" });
  });

  test("a hub-dialed collector needs no token even when the ingest port requires one", async t => {
    const { hub } = await startTestHub(t, {
      ingest: { token: "s3cret-ingest-token" },
      collectors: [{
        command: process.execPath, args: [FAKE_COLLECTOR, "--host-id", "k8s/os/pod-noauth", "--site", "os", "--agent-id", "a1"],
        hostId: "k8s/os/pod-noauth", via: "pod-exec", label: "fixture", minDelayMs: 30, maxDelayMs: 60,
      }],
    });
    await waitFor(() => agentOf(hub, agentKey("k8s/os/pod-noauth", "omp", "a1")), { what: "the dialed collector's agent" });
    assert.equal(hub.state.host("k8s/os/pod-noauth").status, "online");
    assert.equal(hub.state.host("k8s/os/pod-noauth").via, "pod-exec");
  });

  test("the collector CLI reads --token-file and its hello is accepted by a token-protected ingest", async t => {
    const { spawn } = await import("node:child_process");
    const ingestTokenFile = join(tmp, "cli-ingest.token");
    const { hub } = await startTestHub(t, { ingest: { tokenFile: ingestTokenFile } });
    const emptyRoot = join(tmp, "cli-empty-omp");
    mkdirSync(emptyRoot, { recursive: true });
    const child = spawn(process.execPath, [
      join(here, "..", "bin", "agent-fleet.mjs"), "collector",
      "--connect", `127.0.0.1:${hub.ingest.port}`, "--token-file", ingestTokenFile,
      "--host-id", "cli-token-host", "--site", "mac", "--kind", "server",
      "--no-default-roots", "--root", `omp=${emptyRoot}`, "--since", "1m",
    ], { stdio: "ignore" });
    t.after(() => child.kill("SIGTERM"));
    await waitFor(() => hub.state.host("cli-token-host")?.status === "online", { timeoutMs: 10_000, what: "the CLI collector's authenticated hello" });
  });

  test("a hello for an online host over a different transport is refused, not superseded", async t => {
    const logs = [];
    const { hub } = await startTestHub(t, { ingest: { token: "s3cret-ingest-token" }, log: (level, message) => logs.push(`${level} ${message}`) });
    connectCollector(hub, { id: "mac", site: "mac" }, { via: "local" });
    await waitFor(() => hub.state.host("mac")?.status === "online", { what: "the local collector" });
    const connectedAt = hub.state.host("mac").connectedAt;

    const intruder = await tcpTransport({ port: hub.ingest.port });
    t.after(() => intruder.close());
    const closed = new Promise(resolve => intruder.socket.once("close", resolve));
    intruder.socket.write(`${JSON.stringify({ t: "hello", proto: PROTOCOL_VERSION, at: Date.now(), token: "s3cret-ingest-token", host: hostInfo({ id: "mac", site: "mac" }) })}\n`);
    await closed;

    const host = hub.state.host("mac");
    assert.equal(host.status, "online", "the existing channel keeps the host online");
    assert.equal(host.via, "local", "the existing transport is kept");
    assert.equal(host.connectedAt, connectedAt, "the newcomer did not replace the connection");
    assert.ok(logs.some(line => /refused.*already online/.test(line) && line.includes("mac")), `refusal logged, got ${JSON.stringify(logs)}`);
  });

  test("oversized agent and event fields are clamped and event targets capped", async t => {
    const { hub } = await startTestHub(t);
    const mac = connectCollector(hub, { id: "mac", site: "mac" });
    const big = "x".repeat(50_000);
    const record = agentRecord("mac", "omp", "big-fields", {
      title: big, description: big, model: big, cwd: big, file: big, name: big,
      live: { alive: true, state: "model", since: T0, doing: big, turnOpen: true },
      parent: { kind: "omp", id: big.slice(0, 500), file: big, via: "file", exact: true },
    });
    mac.agent(record);
    const stored = await waitFor(() => agentOf(hub, record.key), { what: "the clamped agent" });
    assert.equal(stored.title.length, LIMITS.textChars);
    assert.equal(stored.description.length, LIMITS.textChars);
    assert.equal(stored.model.length, LIMITS.textChars);
    assert.equal(stored.name.length, LIMITS.textChars);
    assert.equal(stored.live.doing.length, LIMITS.textChars);
    assert.equal(stored.cwd.length, LIMITS.pathChars);
    assert.equal(stored.file.length, LIMITS.pathChars);
    assert.equal(stored.parent.file.length, LIMITS.pathChars);

    const targets = Array.from({ length: 20 }, (_, index) => ({ type: "file", op: "read", path: `${big}/${index}`, name: big, url: big }));
    mac.events(record.key, [{ id: "big-event", type: "tool", t: T0 + 1, name: big, model: big, preview: big, text: big, category: big, targets }]);
    const event = await waitFor(() => hub.state.agentEvents(record.key, { limit: 10 }).events.find(item => item.id === "big-event"), { what: "the clamped event" });
    assert.equal(event.preview.length, LIMITS.previewChars);
    assert.equal(event.text.length, LIMITS.textChars);
    assert.equal(event.name.length, LIMITS.textChars);
    assert.equal(event.model.length, LIMITS.textChars);
    assert.equal(event.category.length, 32);
    assert.equal(event.targets.length, LIMITS.maxTargetsPerEvent);
    assert.ok(event.targets.every(target => target.path.length === LIMITS.pathChars && target.name.length === LIMITS.textChars && target.url.length === LIMITS.textChars));
  });

  test("agent ingest is capped at 5000 keys per host and the refusal is surfaced", async t => {
    const { hub } = await startTestHub(t);
    const mac = connectCollector(hub, { id: "mac", site: "mac" });
    for (let index = 0; index < 5000; index += 1) mac.agent(agentRecord("mac", "omp", `cap-${index}`));
    await waitFor(() => hub.state.host("mac").counts.agents === 5000, { timeoutMs: 20_000, what: "5000 agents" });

    mac.agent(agentRecord("mac", "omp", "cap-overflow"));
    const host = await waitFor(() => { const current = hub.state.host("mac"); return current.rejected > 0 && current; }, { timeoutMs: 5000, what: "the cap refusal" });
    assert.match(host.lastRejected, /agent cap 5000/);
    assert.equal(host.counts.agents, 5000);
    assert.equal(agentOf(hub, agentKey("mac", "omp", "cap-overflow")), undefined);
  });

  test("procs are capped at 2000 entries per host", async t => {
    const { hub } = await startTestHub(t);
    const mac = connectCollector(hub, { id: "mac", site: "mac" });
    mac.procs(Array.from({ length: 2100 }, (_, index) => ({ pid: index + 1, ppid: 1, kind: "omp", startedAt: T0 + index, cmd: `omp ${index}` })));
    await waitFor(() => hub.state.procs("mac")?.length === 2000, { what: "the proc cap" });
    assert.equal(hub.state.procs("mac").length, 2000);
  });

  test("an ingest line over 2 MiB closes the channel", async t => {
    const { hub } = await startTestHub(t);
    const transport = await tcpTransport({ port: hub.ingest.port });
    const closed = new Promise(resolve => transport.socket.once("close", resolve));
    transport.socket.write("x".repeat(2 * 1024 * 1024 + 1024));   // no newline: the carry itself must be bounded
    await Promise.race([closed, sleep(2500).then(() => { throw new Error("an oversized ingest line was not refused"); })]);
  });

  test("dialCollector runs a collector over a child's stdio, proxies requests and reports a dead command", async t => {
    const { hub, get } = await startTestHub(t, {
      collectors: [
        { command: process.execPath, args: [FAKE_COLLECTOR, "--host-id", "k8s/os/pod-d", "--site", "os", "--agent-id", "dialed"], hostId: "k8s/os/pod-d", label: "fixture", minDelayMs: 30, maxDelayMs: 60 },
        { command: "/nonexistent/agent-fleet", args: [], hostId: "k8s/os/ghost", minDelayMs: 30, maxDelayMs: 60 },
        { command: process.execPath, args: [FAKE_COLLECTOR, "--host-id", "someone-else", "--site", "os"], hostId: "k8s/os/expected", minDelayMs: 30, maxDelayMs: 60 },
      ],
    });
    await waitFor(() => agentOf(hub, agentKey("k8s/os/pod-d", "omp", "dialed")), { what: "dialed collector's agent" });
    assert.equal(hub.state.host("k8s/os/pod-d").via, "ssh-relay", "a dialed collector without an explicit transport is reported as a relay");
    assert.equal(hub.state.host("k8s/os/pod-d").status, "online");
    assert.equal((await get("/api/file?host=k8s%2Fos%2Fpod-d&path=/etc/x")).json.content, "from k8s/os/pod-d:/etc/x");

    const ghost = await waitFor(() => { const host = hub.state.host("k8s/os/ghost"); return host?.status === "error" && host; }, { what: "placeholder host for a dead command" });
    assert.equal(ghost.site, "os");
    assert.equal(ghost.kind, "pod");
    assert.match(ghost.error, /cannot run|ENOENT/);

    const mismatch = await waitFor(() => { const host = hub.state.host("k8s/os/expected"); return host?.error?.includes("host id mismatch") && host; }, { what: "host id mismatch" });
    assert.equal(mismatch.status, "error");
    assert.equal(hub.state.host("someone-else"), undefined, "the wrongly named collector was not admitted");
  });

  test("a dialed collector that exits is retried and comes back online", async t => {
    const { hub } = await startTestHub(t, {
      collectors: [{ command: process.execPath, args: [FAKE_COLLECTOR, "--host-id", "k8s/os/flaky", "--site", "os", "--agent-id", "f1", "--die-after", "400"], hostId: "k8s/os/flaky", minDelayMs: 30, maxDelayMs: 60 }],
    });
    await waitFor(() => hub.state.host("k8s/os/flaky")?.status === "online");
    const first = hub.state.host("k8s/os/flaky").connectedAt;
    await waitFor(() => hub.state.host("k8s/os/flaky").status === "online" && hub.state.host("k8s/os/flaky").connectedAt > first, { timeoutMs: 4000, what: "reconnect after the child exited" });
    assert.ok(agentOf(hub, agentKey("k8s/os/flaky", "omp", "f1")), "agents survive the reconnect");
  });

  test("a watchdog tick that fires after a stall resets the silence clock; real peer silence still closes the channel", async t => {
    const clock = fakeClock();
    const state = createState({ now: clock.now, hostId: "hub" });
    t.after(() => state.close());
    const links = createCollectorLinks({ state, log: () => {}, now: clock.now, timers: clock, silenceMs: 100, watchdogMs: 10 });
    t.after(() => links.closeAll());
    const link = inMemoryLink(links);
    t.after(() => link.peer.close());
    link.hello({ id: "sg-compute", site: "sg-compute" }, clock.now());
    await waitFor(() => state.host("sg-compute")?.status === "online", { what: "the hello over the in-memory link" });

    clock.freeze(1000);                       // 1 s of wall time in which the process did not run (30 s in production)
    clock.advance(0);                         // the loop runs again: the overdue tick fires 1000 ms late
    assert.equal(link.channel.closed, false, "a late tick is this process's stall, not peer silence");
    assert.equal(state.host("sg-compute").status, "online");

    for (let index = 0; index < 10; index += 1) clock.advance(10);   // ticks on time, the peer says nothing
    assert.equal(link.channel.closed, false, "100 ms of on-time silence is not over the window yet");
    clock.advance(10);
    assert.equal(link.channel.closed, true, "real peer silence still closes the channel");
    assert.match(link.channel.closeReason, /no data/);
    assert.equal(state.host("sg-compute").status, "offline");
  });

  test("a hello timeout that fires after a stall waits again instead of closing the channel", async t => {
    const clock = fakeClock();
    const state = createState({ now: clock.now, hostId: "hub" });
    t.after(() => state.close());
    const links = createCollectorLinks({ state, log: () => {}, now: clock.now, timers: clock, helloTimeoutMs: 1000, silenceMs: 60_000, watchdogMs: 5_000 });
    t.after(() => links.closeAll());
    const link = inMemoryLink(links);
    t.after(() => link.peer.close());

    clock.freeze(5000);                       // the channel is bound at t=0; the process freezes before the hello is read
    clock.advance(0);                         // the hello deadline (1000 ms) expired during the stall: the timer fires 4 s late
    assert.equal(link.channel.closed, false, "a late hello timeout does not close the channel");
    link.hello({ id: "weihai-pod", site: "weihai" }, clock.now());
    await waitFor(() => state.host("weihai-pod")?.status === "online", { what: "the hello that waited in the pipe" });
    assert.equal(link.channel.closed, false);
  });
});

// ----------------------------------------------------------------------------------------------- upstream

describe("upstream hub", () => {
  async function pair(t, { sshMode = false, bOptions = {} } = {}) {
    const a = await startTestHub(t, { hostId: "server-bochao-01" });
    const upstream = { url: a.url, token: a.token, minDelayMs: 40, maxDelayMs: 100 };
    if (sshMode) {
      upstream.sshTarget = "fake-target";
      upstream.transportFor = () => tcpTransport({ port: a.hub.http.port });
    }
    const b = await startTestHub(t, { hostId: "mac", upstream, ...bOptions });
    return { a, b };
  }

  const snapshotAgents = hub => hub.state.snapshot().agents.map(agent => agent.key).sort();

  for (const sshMode of [false, true]) {
    test(`merges the upstream snapshot and follows its deltas (${sshMode ? "raw HTTP over a duplex, as through ssh -W" : "fetch"})`, async t => {
      const { a, b } = await pair(t, { sshMode });
      const server = connectCollector(a.hub, { id: "server-bochao-01", site: "server-bochao-01" });
      const s1 = agentRecord("server-bochao-01", "omp", "s1");
      server.agent(s1);
      server.events(s1.key, [toolEvent("up1", T0, { targets: [{ type: "file", op: "read", host: "server-bochao-01", path: "/srv/x" }] })]);
      await waitFor(() => snapshotAgents(b.hub).includes(s1.key), { what: "upstream snapshot merged" });
      assert.equal(b.hub.state.originOf("server-bochao-01"), "upstream");
      assert.equal(b.hub.state.host("server-bochao-01").status, "online");

      const s2 = agentRecord("server-bochao-01", "codex", "s2");
      const sentAt = performance.now();
      server.agent(s2);
      await waitFor(() => snapshotAgents(b.hub).includes(s2.key), { timeoutMs: 2500, what: "delta merged" });
      assert.ok(performance.now() - sentAt < 1500, "upstream delta latency");
      assert.ok(b.hub.state.snapshot().feed.some(item => item.event.id === "up1"), "feed events come along");
    });
  }

  test("local hosts win; links involving upstream agents resolve; proxied reads reach the upstream collector", async t => {
    const { a, b } = await pair(t);
    // the same Mac is known to both hubs (A through the uplink, B directly)
    const macOnA = connectCollector(a.hub, { id: "mac", site: "mac" });
    const macOnB = connectCollector(b.hub, { id: "mac", site: "mac" });
    const server = connectCollector(a.hub, { id: "server-bochao-01", site: "server-bochao-01" }, {
      onRequest: (method, params) => method === "file.read"
        ? { host: "server-bochao-01", path: params.path, exists: true, content: "from the server collector" }
        : { key: params.key, events: [toolEvent("deep", 50)], hasMore: false },
    });
    const owner = agentRecord("mac", "omp", "m1", { startedAt: T0 - 60_000 });
    const onlyOnA = agentRecord("mac", "omp", "only-on-a", { startedAt: T0 });
    const child = agentRecord("server-bochao-01", "claude", "c1", { counts: { turns: 1, tools: 2, errors: 0, subagents: 0, events: 2 }, parent: { kind: "omp", id: "m1", via: "env", exact: true } });
    macOnA.agent(owner); macOnA.agent(onlyOnA); server.agent(child);
    macOnB.agent(owner);
    await waitFor(() => snapshotAgents(b.hub).includes(child.key), { what: "upstream child" });
    assert.equal(b.hub.state.originOf("mac"), "local", "the Mac stays owned by its own collector");
    assert.ok(!snapshotAgents(b.hub).includes(onlyOnA.key), "A's copy of a local host is ignored");
    const link = await waitFor(() => linkTo(b.hub, child.key), { what: "cross-hub link" });
    assert.equal(link.from, owner.key);
    assert.equal(link.crossHost, true);

    const file = await b.get("/api/file?host=server-bochao-01&path=/srv/x.log");
    assert.equal(file.json.content, "from the server collector");
    const secret = await b.get(`/api/file?host=server-bochao-01&path=${encodeURIComponent("/root/.ssh/id_ed25519")}`);
    assert.match(secret.json.denied, /secret/);
    const history = await b.get(`/api/agent?key=${encodeURIComponent(child.key)}&limit=5`);
    assert.deepEqual(history.json.events.map(event => event.id), ["deep"], "history of an upstream agent comes from the upstream hub");
    const local = await b.get("/api/file?host=mac&path=/x");
    assert.equal(local.status, 200, "local host answered by its own collector");
    assert.equal(macOnB.requests.length, 1);
    assert.equal(macOnA.requests.length, 0);
  });

  test("proxied reads over the ssh path reuse one pooled keep-alive connection to the real hub HTTP server", async t => {
    const a = await startTestHub(t, { hostId: "server-bochao-01" });
    let opened = 0;
    const transportFor = () => { opened += 1; return tcpTransport({ port: a.hub.http.port }); };
    const b = await startTestHub(t, { hostId: "mac", upstream: { url: a.url, token: a.token, minDelayMs: 40, maxDelayMs: 100, sshTarget: "fake-target", transportFor } });
    const server = connectCollector(a.hub, { id: "server-bochao-01", site: "server-bochao-01" }, {
      onRequest: (method, params) => method === "file.read"
        ? { host: "server-bochao-01", path: params.path, exists: true, content: `read ${params.path}` }
        : { key: params.key, events: [toolEvent("deep", 50)], hasMore: false },
    });
    const child = agentRecord("server-bochao-01", "claude", "c1", { counts: { turns: 1, tools: 2, errors: 0, subagents: 0, events: 2 } });
    server.agent(child);
    await waitFor(() => snapshotAgents(b.hub).includes(child.key) && opened >= 2, { what: "snapshot merged and the SSE stream connected" });
    const before = opened;
    for (const name of ["a", "b", "c"]) assert.equal((await b.get(`/api/file?host=server-bochao-01&path=/srv/${name}.log`)).json.content, `read /srv/${name}.log`);
    const history = await b.get(`/api/agent?key=${encodeURIComponent(child.key)}&limit=5`);
    assert.deepEqual(history.json.events.map(event => event.id), ["deep"]);
    assert.equal(opened, before, "four proxied reads opened no new ssh connection");
  });

  test("upstream loss marks its hosts offline without losing agents; the subscription recovers by itself", async t => {
    const tokenFile = join(tmp, "upstream-recover.token");
    const a = await startHub({ hostId: "server-bochao-01", log: () => {}, http: { host: "127.0.0.1", port: 0, tokenFile, panelDir } });
    const port = a.http.port, token = readFileSync(tokenFile, "utf8").trim();
    const server = connectCollector(a, { id: "server-bochao-01", site: "server-bochao-01" });
    const s1 = agentRecord("server-bochao-01", "omp", "s1");
    server.agent(s1);
    const b = await startTestHub(t, { hostId: "mac", upstream: { url: `http://127.0.0.1:${port}`, token, minDelayMs: 40, maxDelayMs: 100 } });
    await waitFor(() => snapshotAgents(b.hub).includes(s1.key), { what: "initial merge" });

    await a.stop();
    await waitFor(() => b.hub.state.host("server-bochao-01").status === "offline", { what: "upstream hosts offline" });
    assert.match(b.hub.state.host("server-bochao-01").error, /upstream hub unreachable/);
    assert.ok(snapshotAgents(b.hub).includes(s1.key));
    assert.equal(agentOf(b.hub, s1.key).live.alive, null);

    const a2 = await startHub({ hostId: "server-bochao-01", log: () => {}, http: { host: "127.0.0.1", port, tokenFile, panelDir } });
    t.after(() => a2.stop());
    const server2 = connectCollector(a2, { id: "server-bochao-01", site: "server-bochao-01" });
    const s2 = agentRecord("server-bochao-01", "omp", "s2");
    server2.agent(s2);
    await waitFor(() => snapshotAgents(b.hub).includes(s2.key) && b.hub.state.host("server-bochao-01").status === "online", { timeoutMs: 6000, what: "recovery after the upstream restarted" });
    assert.ok(!snapshotAgents(b.hub).includes(s1.key), "agents the restarted upstream no longer reports are dropped");
  });

  /** A hub HTTP fake (fetch mode): an empty snapshot and a stream body that stays open until its signal aborts. */
  function silentUpstream() {
    const payload = JSON.stringify({ cursor: 0, now: 0, hosts: [], agents: [], links: [], pods: [], feed: [] });
    return async (url, { signal } = {}) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/api/snapshot")) return { status: 200, body: [Buffer.from(payload)] };
      if (!path.endsWith("/api/stream")) throw new Error(`unexpected upstream request ${path}`);
      const body = (async function* () {
        await new Promise((resolve, reject) => {
          if (signal?.aborted) { reject(signal.reason ?? new Error("aborted")); return; }
          signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
        });
      })();
      return { status: 200, body };
    };
  }

  test("a stream watchdog that fires after this process stalled re-arms instead of blaming the upstream", async t => {
    let clock = 0, clockReads = 0;
    const events = [];
    const sink = { snapshot: () => events.push("snapshot"), delta: () => "ok", disconnected: reason => events.push(`disconnected: ${reason}`) };
    const upstream = createUpstream({
      name: "stall", url: "http://127.0.0.1:9/", token: "t", sink, fetchImpl: silentUpstream(),
      now: () => { clockReads += 1; return clock; }, silenceMs: 150, minDelayMs: 20, maxDelayMs: 40,
    });
    t.after(() => upstream.stop());
    upstream.start();
    await waitFor(() => upstream.status().status === "online", { what: "the stream open" });
    const before = clockReads;
    clock += 100_000;                                        // the process was frozen for 100 s
    await waitFor(() => clockReads >= before + 2, { timeoutMs: 3000, what: "the late watchdog fire and its re-arm" });
    assert.deepEqual(events, ["snapshot"], "a late fire does not disconnect the upstream");
    assert.equal(upstream.status().status, "online");
    clock += 100_000;                                        // keep the next fire late too (no race with the 150 ms window)
    await waitFor(() => clockReads >= before + 4, { timeoutMs: 3000, what: "a second late fire" });
    assert.ok(!events.some(event => event.startsWith("disconnected")), "the upstream was never blamed");
    assert.equal(upstream.status().status, "online");
  });

  test("real upstream silence still aborts the stream, and the subscription retries", async t => {
    const events = [];
    const sink = { snapshot: () => events.push("snapshot"), delta: () => "ok", disconnected: reason => events.push(`disconnected: ${reason}`) };
    const upstream = createUpstream({ name: "silence", url: "http://127.0.0.1:9/", token: "t", sink, fetchImpl: silentUpstream(), silenceMs: 60, minDelayMs: 20, maxDelayMs: 40 });
    t.after(() => upstream.stop());
    upstream.start();
    const reason = await waitFor(() => events.find(event => event.startsWith("disconnected")), { timeoutMs: 3000, what: "the silence watchdog" });
    assert.match(reason, /no data from the upstream hub/);
    await waitFor(() => upstream.status().status === "online", { timeoutMs: 2000, what: "a retry after the abort" });
  });

  test("a wrong upstream token is reported as an error and merges nothing", async t => {
    const a = await startTestHub(t, { hostId: "server-bochao-01" });
    const server = connectCollector(a.hub, { id: "server-bochao-01", site: "server-bochao-01" });
    server.agent(agentRecord("server-bochao-01", "omp", "s1"));
    const wrong = await startTestHub(t, { hostId: "mac", upstream: { url: a.url, token: "x".repeat(64), minDelayMs: 40, maxDelayMs: 80 } });
    const status = await waitFor(() => { const current = [...wrong.hub.upstreams.values()][0].status(); return current.status === "offline" && current; }, { what: "upstream reported offline" });
    assert.match(status.error, /401/);
    assert.equal(wrong.hub.state.hosts().length, 0);
    assert.equal((await wrong.get("/api/health")).json.upstream[0].status, "offline");
  });

  test("upstream timestamps are shifted into this hub's clock and an upstream reset asks for a fresh snapshot", () => {
    const hubNow = 1_900_000_000_000, upstreamBehind = 7000;
    const state = createState({ now: () => hubNow, hostId: "mac" });
    const sink = state.upstream("upstream");
    const remoteNow = hubNow - upstreamBehind;
    const record = agentRecord("server-bochao-01", "omp", "s1", { startedAt: remoteNow - 1000, updatedAt: remoteNow - 500 });
    sink.snapshot({
      cursor: 5, now: remoteNow, hosts: [{ id: "server-bochao-01", site: "server-bochao-01", kind: "server", label: "s", status: "online", via: "socket", lastSeen: remoteNow, counts: { agents: 1, running: 1 } }],
      agents: [record], links: [], pods: [], feed: [{ agent: record.key, event: toolEvent("e1", remoteNow - 200) }],
    });
    const merged = state.snapshot();
    assert.equal(merged.agents[0].startedAt, hubNow - 1000);
    assert.equal(merged.agents[0].updatedAt, hubNow - 500);
    assert.equal(merged.hosts[0].lastSeen, hubNow);
    assert.equal(merged.feed[0].event.t, hubNow - 200);
    assert.equal(sink.shiftTime(remoteNow), hubNow);
    assert.equal(sink.delta({ cursor: 6, now: remoteNow, reset: true }), "reset");
    state.close();
  });

  test("a host the upstream stopped reporting goes offline, and its return in a delta forces a snapshot so stale agents are dropped", () => {
    const state = createState({ hostId: "mac" });
    const sink = state.upstream("upstream");
    const host = { id: "server-bochao-01", site: "server-bochao-01", kind: "server", label: "s", status: "online", via: "socket", counts: { agents: 0, running: 0 } };
    const stale = agentRecord("server-bochao-01", "omp", "stale-one");
    sink.snapshot({ cursor: 1, now: Date.now(), hosts: [host], agents: [stale], links: [], pods: [], feed: [] });
    assert.equal(state.agent(stale.key).status, "running");
    sink.snapshot({ cursor: 2, now: Date.now(), hosts: [], agents: [], links: [], pods: [], feed: [] });      // the upstream restarted empty
    assert.equal(state.host("server-bochao-01").status, "offline");
    assert.ok(state.agent(stale.key), "agents are kept while the host is unreported");
    assert.equal(state.agent(stale.key).live.alive, null);
    const fresh = agentRecord("server-bochao-01", "omp", "fresh-one");
    assert.equal(sink.delta({ cursor: 3, now: Date.now(), hosts: [host], agents: [fresh] }), "reset", "the host is back: reload instead of guessing what vanished");
    sink.snapshot({ cursor: 4, now: Date.now(), hosts: [host], agents: [fresh], links: [], pods: [], feed: [] });
    assert.equal(state.agent(stale.key), undefined);
    assert.ok(state.agent(fresh.key));
    assert.equal(state.host("server-bochao-01").status, "online");
    assert.equal(sink.delta({ cursor: 5, now: Date.now(), hosts: [host] }), "ok");
    state.close();
  });
});

describe("httpGet and the SSE parser", () => {
  function duplexReplying(bytes, { step = 1 } = {}) {
    const readable = new PassThrough(), writable = new PassThrough();
    const written = [];
    writable.on("data", chunk => written.push(chunk));
    (async () => {
      for (let i = 0; i < bytes.length; i += step) { readable.write(bytes.subarray(i, i + step)); await sleep(0); }
      readable.end();
    })();
    return { readable, writable, close: () => readable.destroy(), written };
  }

  async function body(response) { const parts = []; for await (const chunk of response.body) parts.push(chunk); return Buffer.concat(parts).toString("utf8"); }

  test("decodes chunked bodies delivered byte by byte, chunk extensions and multi-byte characters included", async () => {
    const payload = ["{\"a\":", "\"héllo → 世界\"}"];
    const encoded = payload.map(part => `${Buffer.byteLength(part).toString(16)};ext=1\r\n${part}\r\n`).join("") + "0\r\n\r\n";
    const duplex = duplexReplying(Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n${encoded}`));
    const response = await httpGet(duplex, { path: "/api/snapshot", headers: { "x-agent-fleet-token": "tok" } });
    assert.equal(response.status, 200);
    assert.equal(await body(response), payload.join(""));
    const request = Buffer.concat(duplex.written).toString();
    assert.match(request, /^GET \/api\/snapshot HTTP\/1\.1\r\n/);
    assert.match(request, /x-agent-fleet-token: tok\r\n/);
    assert.match(request, /Connection: close\r\n/);
  });

  test("handles content-length and close-delimited bodies and non-200 statuses", async () => {
    const withLength = await httpGet(duplexReplying(Buffer.from("HTTP/1.1 401 Unauthorized\r\nContent-Length: 10\r\n\r\n{\"e\":\"no\"}EXTRA"), { step: 7 }), { path: "/x" });
    assert.equal(withLength.status, 401);
    assert.equal(await body(withLength), "{\"e\":\"no\"}", "stops at content-length");
    const closed = await httpGet(duplexReplying(Buffer.from("HTTP/1.1 200 OK\r\n\r\nuntil the end"), { step: 5 }), { path: "/x" });
    assert.equal(await body(closed), "until the end");
    await assert.rejects(httpGet(duplexReplying(Buffer.from("garbage\r\n\r\n")), { path: "/x" }), /bad HTTP status/);
    await assert.rejects(httpGet(duplexReplying(Buffer.alloc(0)), { path: "/x" }), /closed before the HTTP response/);
  });

  test("the SSE parser joins frames split across chunks, ignores comments and handles CRLF", () => {
    const seen = [];
    const parser = createSseParser((event, data) => seen.push([event, data]));
    parser.write(": hello\n\nevent: del");
    parser.write("ta\ndata: {\"a\":1}\r");
    parser.write("\n\r\nid: 5\nevent: delta\ndata: line1\ndata: line2\n\n");
    parser.write("data: bare\n\n");
    assert.deepEqual(seen, [["delta", "{\"a\":1}"], ["delta", "line1\nline2"], ["message", "bare"]]);
  });
});

describe("keep-alive HTTP pool (the ssh -W read path)", () => {
  const ok = body => Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  const chunked = parts => Buffer.from(`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${parts.map(part => `${Buffer.byteLength(part).toString(16)}\r\n${part}\r\n`).join("")}0\r\n\r\n`);

  /** A scripted HTTP server behind `open()`: `onRequest({connection, path, reply, end})` decides what each request gets. */
  function scriptedServer(onRequest) {
    const connections = [];
    const open = async () => {
      const readable = new PassThrough(), writable = new PassThrough();
      const connection = { id: connections.length, requests: [], closed: false };
      let pending = "";
      writable.on("data", chunk => {
        pending += chunk.toString("latin1");
        for (let end = pending.indexOf("\r\n\r\n"); end >= 0; end = pending.indexOf("\r\n\r\n")) {
          const head = pending.slice(0, end);
          pending = pending.slice(end + 4);
          const request = { path: /^GET (\S+) HTTP\/1\.1/.exec(head)?.[1], head };
          connection.requests.push(request);
          onRequest({ connection, path: request.path, reply: bytes => { if (!readable.writableEnded && !readable.destroyed) readable.write(bytes); }, end: () => readable.end() });
        }
      });
      connections.push(connection);
      return { readable, writable, close: () => { connection.closed = true; readable.destroy(); } };
    };
    return { open, connections };
  }

  test("sequential reads share one connection whatever the framing and however the bytes are split, and carry host and token", async () => {
    const server = scriptedServer(({ path, reply }) => {
      const payload = path === "/a" ? ok("{\"a\":1}") : path === "/b" ? chunked(["{\"b\":", "\"héllo → 世界\"}"]) : ok("{\"c\":3}");
      (async () => { for (let i = 0; i < payload.length; i += 3) { reply(payload.subarray(i, i + 3)); await sleep(0); } })();
    });
    const pool = createHttpPool({ open: server.open, host: "127.0.0.1:7840", headers: { "x-agent-fleet-token": "tok" } });
    const bodies = [];
    for (const path of ["/a", "/b", "/c"]) bodies.push((await pool.get(path)).body.toString("utf8"));
    pool.close();
    assert.deepEqual(bodies, ["{\"a\":1}", "{\"b\":\"héllo → 世界\"}", "{\"c\":3}"]);
    assert.equal(server.connections.length, 1, "one ssh handshake for three reads");
    assert.deepEqual(server.connections[0].requests.map(request => request.path), ["/a", "/b", "/c"]);
    const head = server.connections[0].requests[0].head;
    assert.match(head, /Host: 127\.0\.0\.1:7840/);
    assert.match(head, /x-agent-fleet-token: tok/);
    assert.match(head, /Connection: keep-alive/);
  });

  test("a connection the server closed while idle is retried once on a fresh one; a reply cut off midway is an error, not a retry", async () => {
    const server = scriptedServer(({ connection, path, reply, end }) => {
      if (path === "/cut") { reply(Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\npartial")); end(); return; }
      reply(ok(`${path}@${connection.id}`));
      if (connection.id === 0) end();                           // the server drops the first connection right after answering
    });
    const pool = createHttpPool({ open: server.open });
    assert.equal((await pool.get("/one")).body.toString(), "/one@0");
    await sleep(20);
    assert.equal((await pool.get("/two")).body.toString(), "/two@1", "the dead idle connection is replaced transparently");
    assert.equal(server.connections.length, 2);
    await assert.rejects(pool.get("/cut"), /closed before content-length/);
    assert.deepEqual(server.connections[1].requests.map(request => request.path), ["/two", "/cut"], "/cut went out once: no second attempt after reply bytes had arrived");
    assert.equal(server.connections.length, 2);
    pool.close();
  });

  test("Connection: close replies, 204 replies and status codes are handled; a close-delimited body is read to the end", async () => {
    const server = scriptedServer(({ path, reply, end }) => {
      if (path === "/close") reply(Buffer.from("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 2\r\n\r\nok"));
      else if (path === "/empty") reply(Buffer.from("HTTP/1.1 204 No Content\r\n\r\n"));
      else if (path === "/missing") reply(Buffer.from("HTTP/1.1 404 Not Found\r\nContent-Length: 17\r\n\r\n{\"error\":\"nope!\"}"));
      else { reply(Buffer.from("HTTP/1.1 200 OK\r\n\r\nuntil the end")); end(); }
    });
    const pool = createHttpPool({ open: server.open });
    assert.equal((await pool.get("/close")).body.toString(), "ok");
    assert.equal(pool.size, 0, "the connection the server asked to close is not kept");
    const empty = await pool.get("/empty");
    assert.deepEqual([empty.status, empty.body.length], [204, 0]);
    const missing = await pool.get("/missing");
    assert.deepEqual([missing.status, missing.body.toString()], [404, "{\"error\":\"nope!\"}"]);
    assert.equal(server.connections.length, 2, "/empty and /missing shared the connection that /close did not leave behind");
    assert.equal((await pool.get("/eof")).body.toString(), "until the end");
    pool.close();
  });

  test("at most maxConnections run at once and extra reads queue for a free connection", async () => {
    const held = [];
    const server = scriptedServer(({ path, reply }) => held.push({ path, answer: () => reply(ok(path)) }));
    const pool = createHttpPool({ open: server.open, maxConnections: 2 });
    const reads = ["/1", "/2", "/3"].map(path => pool.get(path).then(reply => reply.body.toString()));
    await waitFor(() => held.length === 2, { what: "two requests on the wire" });
    await sleep(30);
    assert.equal(server.connections.length, 2);
    assert.equal(held.length, 2, "the third read waits for a free connection");
    held[0].answer();
    await waitFor(() => held.length === 3, { what: "third request once a connection is free" });
    assert.equal(server.connections.length, 2, "the freed connection is reused, no third one is opened");
    held[1].answer();
    held[2].answer();
    assert.deepEqual((await Promise.all(reads)).sort(), ["/1", "/2", "/3"]);
    pool.close();
  });

  test("close() fails reads in flight and queued at once instead of leaving them to their timeout", async () => {
    const server = scriptedServer(() => {});                    // never answers
    const pool = createHttpPool({ open: server.open, maxConnections: 1 });
    const outcomes = Promise.allSettled([pool.get("/a"), pool.get("/b")]);
    await waitFor(() => server.connections[0]?.requests.length === 1, { what: "request on the wire" });
    pool.close();
    const [inFlight, queued] = await outcomes;
    assert.equal(inFlight.status, "rejected");
    assert.match(queued.reason.message, /pool closed/);
    assert.equal(server.connections[0].closed, true);
    await assert.rejects(pool.get("/c"), /pool closed/);
  });

  test("an aborted read rejects with the abort reason and frees its slot", async () => {
    const server = scriptedServer(({ path, reply }) => { if (path === "/ok") reply(ok("fine")); });
    const pool = createHttpPool({ open: server.open, maxConnections: 1 });
    const controller = new AbortController();
    const hanging = pool.get("/hang", { signal: controller.signal });
    await waitFor(() => server.connections[0]?.requests.length === 1, { what: "request on the wire" });
    controller.abort(new Error("stop it"));
    await assert.rejects(hanging, /stop it/);
    assert.equal(server.connections[0].closed, true, "the connection of an aborted read is dropped");
    assert.equal((await pool.get("/ok")).body.toString(), "fine", "the only slot was freed");
    assert.equal(server.connections.length, 2);
    await assert.rejects(pool.get("/never", { signal: AbortSignal.abort(new Error("already aborted")) }), /already aborted/);
    pool.close();
  });
});

// ------------------------------------------------------------------------------------------------- pods

describe("pods and the kube source wiring", () => {
  const podOf = (name, over = {}) => ({
    key: `os/mc-bochao-li/${name}`, site: "os", cluster: "ulanqab-osmium", namespace: "mc-bochao-li", name, phase: "Running", ready: "1/1", restarts: 0,
    containers: [], requests: {}, labels: {}, collect: false, ...over,
  });

  function fakeKube() {
    const fake = { opts: null, started: false, stopped: false, lookups: [], files: [], pods: new Map() };
    fake.factory = opts => {
      fake.opts = opts;
      return {
        start() { fake.started = true; },
        async stop() { fake.stopped = true; },
        async getPod(ref) { fake.lookups.push(ref); return fake.pods.get(ref.name) ?? null; },
        async podEvents({ pod }) { return pod === "pod-b" ? [{ type: "Warning", reason: "BackOff", message: "back-off restarting", count: 3, firstAt: 1000, lastAt: 2000 }] : []; },
        async readPodFile(request) { fake.files.push(request); return { host: podHostId(request.site, request.pod), path: request.path, exists: true, content: "from kubectl exec" }; },
      };
    };
    return fake;
  }

  test("pods appear when touched, labelled for collection or hosting a collector; lists replace; completed pods stay visible", async t => {
    const kube = fakeKube();
    const a = podOf("pod-a", { collect: true }), b = podOf("pod-b"), c = podOf("pod-c");
    const { hub, get } = await startTestHub(t, { kube: { create: kube.factory, kubeconfig: "/dev/null" } });
    assert.equal(kube.started, true);
    kube.opts.onPods("os", [a, b, c], "list");
    const names = () => hub.state.snapshot().pods.map(pod => pod.name);
    assert.deepEqual(names(), ["pod-a"], "only the collect-labelled pod until an agent touches another");

    const mac = connectCollector(hub, { id: "mac", site: "mac" });
    const agent = agentRecord("mac", "omp", "toucher");
    mac.agent(agent);
    mac.events(agent.key, [toolEvent("k1", T0, { category: "k8s", targets: [{ type: "pod", op: "exec", site: "os", cluster: "ulanqab-osmium", namespace: "mc-bochao-li", name: "pod-b" }] })]);
    await waitFor(() => names().includes("pod-b"));
    assert.deepEqual(names(), ["pod-a", "pod-b"]);

    const detail = (await get(`/api/pod?key=${encodeURIComponent(b.key)}`)).json;
    assert.equal(detail.pod.name, "pod-b");
    assert.deepEqual(detail.touches.map(touch => ({ agent: touch.agent, event: touch.event, op: touch.op })), [{ agent: agent.key, event: "k1", op: "exec" }]);
    assert.deepEqual(detail.events, [{ type: "Warning", reason: "BackOff", message: "back-off restarting", count: 3, firstSeen: 1000, lastSeen: 2000 }]);

    // a new list replaces the site's set: pod-b/pod-c are gone from kube but the touched pod stays visible as finished
    const finished = podOf("pod-b", { phase: "Succeeded" });
    kube.pods.set("pod-b", finished);
    kube.opts.onPods("os", [a], "list");
    kube.opts.onPodGone("os", b.key);
    kube.opts.onPodGone("os", c.key);
    await waitFor(() => hub.state.snapshot().pods.find(pod => pod.name === "pod-b")?.phase === "Succeeded", { what: "completed pod resolved by lookup" });
    assert.ok(!names().includes("pod-c"), "an untouched pod that left is not shown");
    assert.ok(hub.state.snapshot().pods.find(pod => pod.name === "pod-b").deletedAt > 0);

    // a touched pod nobody listed is looked up; "not found" is shown as such
    mac.events(agent.key, [toolEvent("k2", T0 + 10, { targets: [{ type: "pod", op: "get", site: "os", cluster: "ulanqab-osmium", namespace: "mc-bochao-li", name: "ghost-pod" }] })]);
    const ghost = await waitFor(() => hub.state.snapshot().pods.find(pod => pod.name === "ghost-pod"), { what: "stub for a vanished pod" });
    assert.equal(ghost.phase, "NotFound");
    assert.deepEqual(kube.lookups.map(ref => ref.name).filter(name => name === "ghost-pod"), ["ghost-pod"]);
  });

  test("source state flows into snapshot.sources and deltas; the pod file fallback uses the kube source", async t => {
    const kube = fakeKube();
    const { hub, get } = await startTestHub(t, { kube: { create: kube.factory, kubeconfig: "/dev/null" } });
    const cursor = hub.state.snapshot().cursor;
    kube.opts.onSourceState("weihai", { status: "unreachable", error: "dial tcp: i/o timeout", since: 1234 });
    kube.opts.onSourceState("os", { status: "online", error: "", since: 1235 });
    const snapshot = (await get("/api/snapshot")).json;
    assert.deepEqual(snapshot.sources.weihai, { status: "unreachable", error: "dial tcp: i/o timeout", at: 1234 });
    assert.deepEqual(snapshot.sources.os, { status: "online", at: 1235 });
    const delta = (await get(`/api/changes?since=${cursor}`)).json;
    assert.deepEqual(Object.keys(delta.sources).sort(), ["os", "weihai"]);
    assert.equal((await get("/api/health")).json.kube.weihai, "unreachable");

    const file = (await get(`/api/file?host=${encodeURIComponent("k8s/os/pod-nocollector")}&path=/etc/os-release`)).json;
    assert.equal(file.content, "from kubectl exec");
    assert.deepEqual({ site: kube.files[0].site, pod: kube.files[0].pod, path: kube.files[0].path }, { site: "os", pod: "pod-nocollector", path: "/etc/os-release" });
    const secret = (await get(`/api/file?host=${encodeURIComponent("k8s/os/pod-nocollector")}&path=${encodeURIComponent("/root/.kube/config")}`)).json;
    assert.match(secret.denied, /secret/);
    assert.equal(kube.files.length, 1);
  });

  test("attachCollector dials the spec, a detached pod with no data leaves no host behind, stop() releases the source", async t => {
    const kube = fakeKube();
    const { hub } = await startTestHub(t, { kube: { create: kube.factory, kubeconfig: "/dev/null" } });
    const pod = podOf("pod-d", { collect: true, hostId: "k8s/os/pod-d" });
    const spec = { command: process.execPath, args: [FAKE_COLLECTOR, "--host-id", "k8s/os/pod-d", "--site", "os", "--agent-id", "att"], label: "pod-d", hostId: "k8s/os/pod-d" };
    const handle = kube.opts.attachCollector("os", pod, spec);
    await waitFor(() => agentOf(hub, agentKey("k8s/os/pod-d", "omp", "att")), { what: "attached collector's agent" });
    handle.stop();
    await waitFor(() => hub.state.host("k8s/os/pod-d").status === "offline");
    assert.ok(agentOf(hub, agentKey("k8s/os/pod-d", "omp", "att")), "data of a pod that produced some stays");

    const ghostSpec = { command: "/nonexistent/kubectl", args: [], label: "pod-e", hostId: "k8s/os/pod-e", minDelayMs: 20 };
    const ghostHandle = kube.opts.attachCollector("os", podOf("pod-e", { collect: true }), ghostSpec);
    await waitFor(() => hub.state.host("k8s/os/pod-e"));
    ghostHandle.stop();
    await waitFor(() => hub.state.host("k8s/os/pod-e") === undefined, { what: "placeholder removed" });
    await hub.stop();
    assert.equal(kube.stopped, true);
  });
});

// ------------------------------------------------------------------------- in-process collector

describe("in-process (local) collector", () => {
  const stamp = ms => new Date(ms).toISOString();
  const jsonl = rows => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
  const FAST = { flushMs: 40, pollMs: 100, scanMs: 150, procsMs: 100, acpMs: 100, heartbeatMs: 500, derivedMs: 100 };

  test("the collector gets the hub's host id, answers requests over the in-memory channel and is stopped with the hub", async t => {
    let received = null, stopped = false;
    const fake = {
      startCollector(options) {
        received = options;
        options.send({ t: "hello", proto: PROTOCOL_VERSION, at: Date.now(), host: { kind: "server", label: options.hostInfo.id, hostname: "h", platform: "linux", roots: { dsh: [], claude: [], codex: [], omp: [] }, ...options.hostInfo } });
        return { handleRequest: async (method, params) => ({ host: options.hostInfo.id, path: params.path, exists: true, content: `via ${method}` }), stop() { stopped = true; } };
      },
    };
    const { hub, get } = await startTestHub(t, { hostId: "mac", local: { collectorOptions: { hostInfo: { id: "ignored", label: "My Mac" }, since: 1234 }, load: async () => fake } });
    await waitFor(() => hub.state.host("mac")?.status === "online");
    assert.equal(received.hostInfo.id, "mac", "the hub's host id wins");
    assert.equal(received.hostInfo.site, "mac", "the site defaults to the host id");
    assert.equal(received.hostInfo.label, "My Mac");
    assert.equal(received.since, 1234, "other options pass through");
    assert.equal(hub.state.host("mac").via, "local");
    assert.equal((await get("/api/file?host=mac&path=/x")).json.content, "via file.read");
    await hub.stop();
    assert.equal(stopped, true);
  });

  test("a collector that fails to start leaves the hub serving, with the host in error", async t => {
    const { hub } = await startTestHub(t, { hostId: "server-bochao-01", local: { load: async () => ({ startCollector() { throw new Error("no sessions dir"); } }) } });
    const host = hub.state.host("server-bochao-01");
    assert.equal(host.status, "error");
    assert.equal(host.via, "local");
    assert.match(host.error, /no sessions dir/);
    assert.equal((await hub.api.request("health")).ok, true);
  });

  test("the real collector feeds the hub: agents, file links, events, live appends and file previews", async t => {
    const hostId = "server-bochao-01", uuid = "0000000a-0000-4000-8000-00000000000a", started = Date.now() - 30_000;
    const root = join(tmp, "local-omp"), dir = join(root, "-work-proj"), stem = `${stamp(started).replace(/[:.]/g, "-")}_${uuid}`;
    mkdirSync(join(dir, stem), { recursive: true });
    const main = join(dir, `${stem}.jsonl`);
    writeFileSync(main, jsonl([
      { type: "title", title: "Local run", pad: " ".repeat(50) },
      { type: "session", version: 3, id: uuid, timestamp: stamp(started), cwd: "/work/proj" },
      { type: "message", timestamp: stamp(started + 1000), message: { role: "user", content: [{ type: "text", text: "build it" }] } },
      { type: "message", timestamp: stamp(started + 2000), message: { role: "assistant", model: "claude-x", provider: "anthropic", stopReason: "toolUse", usage: { input: 3, output: 4 }, content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls /work/proj" } }] } },
    ]));
    writeFileSync(join(dir, stem, "Builder.jsonl"), jsonl([
      { type: "title", title: "Builder", pad: "" },
      { type: "session", version: 3, id: `${uuid}-Builder`, timestamp: stamp(started + 2500), cwd: "/work/proj", parentSession: main },
      { type: "message", timestamp: stamp(started + 2600), message: { role: "user", content: [{ type: "text", text: "do the build" }] } },
    ]));
    const note = join(tmp, "local-note.txt");
    writeFileSync(note, "hello from the local collector");

    const { hub, get } = await startTestHub(t, {
      hostId,
      local: { collectorOptions: { hostInfo: { site: hostId }, roots: { omp: [root] }, defaults: false, procs: false, sidecars: [], env: {}, home: tmp, intervals: FAST, since: 3_600_000 } },
    });
    const mainKey = agentKey(hostId, "omp", uuid), subKey = agentKey(hostId, "omp", `${uuid}/Builder`);
    await waitFor(() => agentOf(hub, mainKey) && agentOf(hub, subKey), { timeoutMs: 8000, what: "the collector's agents" });
    assert.equal(hub.state.host(hostId).status, "online");
    assert.equal(hub.state.host(hostId).via, "local");
    assert.equal(agentOf(hub, mainKey).title, "Local run");
    const link = await waitFor(() => linkTo(hub, subKey), { what: "subagent link" });
    assert.deepEqual({ from: link.from, via: link.via, exact: link.exact, crossHost: link.crossHost }, { from: mainKey, via: "file", exact: true, crossHost: false });
    const call = await waitFor(() => hub.state.agentEvents(mainKey).events.find(event => event.id === "call-1"), { what: "tool event" });
    assert.deepEqual({ type: call.type, name: call.name, status: call.status }, { type: "tool", name: "bash", status: "pending" });

    appendFileSync(main, jsonl([
      { type: "message", timestamp: stamp(started + 3000), message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", isError: false, content: [{ type: "text", text: "ok" }] } },
    ]));
    await waitFor(() => hub.state.agentEvents(mainKey).events.find(event => event.id === "call-1")?.status === "ok", { timeoutMs: 4000, what: "live append reaching the hub" });

    const preview = (await get(`/api/file?host=${hostId}&path=${encodeURIComponent(note)}`)).json;
    assert.equal(preview.content, "hello from the local collector");
    assert.match((await get(`/api/file?host=${hostId}&path=${encodeURIComponent("/home/u/.ssh/id_rsa")}`)).json.denied, /secret/);
  });

  test("a link the hub closed is re-opened with a fresh channel pair, and the collector re-syncs onto it", async t => {
    const hostId = "server-bochao-01";
    const state = createState({ hostId });
    t.after(() => state.close());
    const realLinks = createCollectorLinks({ state, log: () => {} });
    t.after(() => realLinks.closeAll());
    const attached = [];
    const links = { ...realLinks, attach: (transport, options) => { const channel = realLinks.attach(transport, options); attached.push(channel); return channel; } };

    const reattached = [];
    let currentSend = null;
    const fake = {
      // A stand-in for the real collector: it only proves the wiring (the real collector is covered above).
      startCollector({ send }) {
        currentSend = send;
        send({ t: "hello", proto: PROTOCOL_VERSION, at: Date.now(), host: hostInfo({ id: hostId, site: hostId }) });
        return {
          handleRequest: (method, params) => ({ via: method, params }),
          stop() {},
          resync(newSend) {
            assert.notEqual(newSend, currentSend, "a re-sync must send over the new channel");
            currentSend = newSend;
            reattached.push(newSend);
            newSend({ t: "hello", proto: PROTOCOL_VERSION, at: Date.now(), host: hostInfo({ id: hostId, site: hostId }) });
            newSend({ t: "agent", agent: agentRecord(hostId, "omp", "after-reconnect") });
          },
        };
      },
    };

    const local = await startLocalCollector({ hostId, links, load: async () => fake, minRetryMs: 5, maxRetryMs: 10, log: () => {} });
    await waitFor(() => state.host(hostId)?.status === "online", { what: "the local collector online" });
    assert.equal(attached.length, 1);

    attached[0].close("no data for 30 s");                      // what the collector-links watchdog does after a stall
    await waitFor(() => attached.length === 2, { what: "a fresh in-memory channel pair" });
    assert.equal(attached[0].closed, true);
    assert.equal(state.host(hostId).status, "online", "the host is online again without a restart");
    assert.equal(reattached.length, 1, "the collector re-synced exactly once");
    assert.ok(state.agent(agentKey(hostId, "omp", "after-reconnect")), "records the re-sync re-sent are applied");

    const reply = await realLinks.request(hostId, "ping", { path: "/x" });
    assert.deepEqual(reply, { via: "ping", params: { path: "/x" } }, "requests reach the collector over the new pair");

    await local.stop();
    assert.equal(attached[1].closed, true, "stop() closes the live pair");
    await sleep(40);
    assert.equal(attached.length, 2, "no reconnect is scheduled after stop");
    assert.equal(reattached.length, 1);
  });
});

// ----------------------------------------------------------------------------------------- CLI arguments

describe("hub command line", () => {
  test("parses the systemd unit's arguments into startHub options", () => {
    const options = parseHubArgs([
      "--listen", "127.0.0.1:7840", "--ingest", "127.0.0.1:7841", "--base", "/fleet", "--kubeconfig", "/home/u/.config/agent-fleet/kubeconfig.yaml",
      "--token-file", "/home/u/.config/agent-fleet/token", "--ingest-token-file", "/home/u/.config/agent-fleet/ingest-token", "--host-id", "server-bochao-01", "--site", "server-bochao-01", "--since", "6h",
      "--root", "omp=/data/x/*/sessions", "--root", "dsh=/data/dsh", "--sidecar", "/s/sidecar.sqlite",
    ]);
    assert.equal(options.hostId, "server-bochao-01");
    assert.deepEqual({ host: options.http.host, port: options.http.port, base: options.http.base, tokenFile: options.http.tokenFile }, { host: "127.0.0.1", port: 7840, base: "/fleet", tokenFile: "/home/u/.config/agent-fleet/token" });
    assert.deepEqual(options.ingest, { host: "127.0.0.1", port: 7841, tokenFile: "/home/u/.config/agent-fleet/ingest-token" });
    assert.equal(options.local.collectorOptions.since, 6 * 3_600_000, "the collector takes milliseconds");
    assert.deepEqual(options.local.collectorOptions.roots, ["omp=/data/x/*/sessions", "dsh=/data/dsh"]);
    assert.deepEqual(options.local.collectorOptions.sidecars, ["/s/sidecar.sqlite"]);
    assert.equal(options.local.collectorOptions.hostInfo.site, "server-bochao-01");
    assert.deepEqual(Object.keys(options.kube.sites), ["chengdu", "weihai", "iron", "os"]);
    assert.equal(options.kube.kubeconfig, "/home/u/.config/agent-fleet/kubeconfig.yaml");
  });

  test("rejects malformed flags and supports --ingest off / --no-local / --upstream", () => {
    assert.throws(() => parseHubArgs(["--listen", "nope"]), /HOST:PORT/);
    assert.throws(() => parseHubArgs(["--kube-sites", "mars", "--kubeconfig", "/k"]), /unknown site mars/);
    assert.throws(() => parseHubArgs(["--upstream", "http://127.0.0.1:7840"]), /upstream-token-file/);
    const options = parseHubArgs(["--ingest", "off", "--no-local", "--upstream", "http://127.0.0.1:7840", "--upstream-token-file", "/t", "--upstream-ssh", "bochao_li@10.0.60.98"]);
    assert.equal(options.ingest, undefined);
    assert.equal(options.local, undefined);
    assert.deepEqual(options.upstream, { url: "http://127.0.0.1:7840", tokenFile: "/t", sshTarget: "bochao_li@10.0.60.98", name: undefined });
  });
});
