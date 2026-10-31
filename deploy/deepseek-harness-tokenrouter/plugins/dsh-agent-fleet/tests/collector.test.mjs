// Collector behaviour: discovery → sessions → messages on an in-memory channel, ACP links in any order, live
// appends, file.read safety, deletion, process matching/liveness, globbed roots, and the single-file bundle.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";
import { createChannel } from "../lib/channel.mjs";
import { readFilePreview } from "../lib/collector/files.mjs";
import { startCollector } from "../lib/collector/index.mjs";
import { parseCollectorArgs } from "../lib/collector/main.mjs";
import { applyLiveness, bindProcs, classifyCommand, parseLsof, parsePsEnv, parsePsOutput, parseProcLocks, splitCommand } from "../lib/collector/procs.mjs";
import { buildCollector, transformModule } from "../tools/build-collector.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const scratchRoot = join(here, "..", ".scratch");
mkdirSync(scratchRoot, { recursive: true });
const workDir = mkdtempSync(join(scratchRoot, "collector-test-"));
after(() => rmSync(workDir, { recursive: true, force: true }));

let counter = 0;
const newDir = name => { const dir = join(workDir, `${name}-${counter++}`); mkdirSync(dir, { recursive: true }); return dir; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const uuid = n => `0000000${n}-0000-4000-8000-00000000000${n}`;
const iso = ms => new Date(ms).toISOString();
const jsonl = rows => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
const FAST = { flushMs: 40, pollMs: 100, scanMs: 150, procsMs: 100, acpMs: 100, heartbeatMs: 500, derivedMs: 100 };

// ----------------------------------------------------------------------------------------------- fixtures

/** OMP's line 1: a title padded to a fixed width so it can be rewritten in place. */
const titleRow = title => ({ type: "title", title, pad: " ".repeat(60 - title.length) });
const T0 = Date.now() - 60_000;
const ompMain = { id: uuid(1), stem: `${iso(T0).replace(/[:.]/g, "-")}_${uuid(1)}` };

function writeOmp(root, { id = ompMain.id, stem = ompMain.stem, slug = "-work-proj", withResult = false } = {}) {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${stem}.jsonl`);
  const rows = [
    titleRow("Fix the build"),
    { type: "session", version: 3, id, timestamp: iso(T0), cwd: "/work/proj" },
    { type: "message", timestamp: iso(T0 + 1000), message: { role: "user", content: [{ type: "text", text: "please fix the build" }] } },
    { type: "message", timestamp: iso(T0 + 2000), message: { role: "assistant", model: "claude-x", provider: "anthropic", stopReason: "toolUse", usage: { input: 10, output: 5 }, content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls /work/proj" } }] } },
  ];
  if (withResult) rows.push(omptoolResult());
  writeFileSync(file, jsonl(rows));
  return file;
}
const omptoolResult = () => ({ type: "message", timestamp: iso(T0 + 3000), message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", isError: false, content: [{ type: "text", text: "ok" }] } });
const ompFinal = () => ({ type: "message", timestamp: iso(T0 + 4000), message: { role: "assistant", model: "claude-x", provider: "anthropic", stopReason: "stop", usage: { input: 11, output: 6 }, content: [{ type: "text", text: "done" }] } });

function writeOmpSubagent(mainFile, name = "Builder") {
  const dir = mainFile.slice(0, -".jsonl".length);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.jsonl`);
  writeFileSync(file, jsonl([
    { type: "title", title: name, pad: "" },
    { type: "session", version: 3, id: `${ompMain.id}-${name}`, timestamp: iso(T0 + 2500), cwd: "/work/proj", parentSession: mainFile },
    { type: "message", timestamp: iso(T0 + 2600), message: { role: "user", content: [{ type: "text", text: "build it" }] } },
  ]));
  return file;
}

function writeClaude(root, sid = uuid(2)) {
  const dir = join(root, "-work-claude");
  mkdirSync(join(dir, sid, "subagents"), { recursive: true });
  const main = join(dir, `${sid}.jsonl`);
  writeFileSync(main, jsonl([
    { type: "user", uuid: "u1", timestamp: iso(T0), sessionId: sid, cwd: "/work/claude", version: "2.1.0", message: { role: "user", content: "hello claude" } },
    { type: "assistant", uuid: "a1", timestamp: iso(T0 + 1000), sessionId: sid, message: { id: "m1", model: "claude-opus", stop_reason: "tool_use", usage: { input_tokens: 3, output_tokens: 4 }, content: [{ type: "tool_use", id: "toolu_1", name: "Agent", input: { description: "research", subagent_type: "general" } }] } },
  ]));
  const sub = join(dir, sid, "subagents", "agent-abc123.jsonl");
  writeFileSync(sub, jsonl([
    { type: "user", uuid: "s1", timestamp: iso(T0 + 1500), sessionId: sid, isSidechain: true, cwd: "/work/claude", message: { role: "user", content: "research the thing" } },
  ]));
  writeFileSync(join(dir, sid, "subagents", "agent-abc123.meta.json"), JSON.stringify({ agentType: "general", description: "research", toolUseId: "toolu_1" }));
  return { main, sub, sid };
}

function writeCodex(root, parentId = uuid(3), childId = uuid(4)) {
  const dir = join(root, "2026", "10", "30");
  mkdirSync(dir, { recursive: true });
  const rollout = id => join(dir, `rollout-2026-10-30T01-00-00-${id}.jsonl`);
  writeFileSync(rollout(parentId), jsonl([
    { timestamp: iso(T0), ordinal: 0, type: "session_meta", payload: { id: parentId, timestamp: iso(T0), cwd: "/work/codex", cli_version: "0.162.0", source: "cli" } },
    { timestamp: iso(T0 + 500), ordinal: 1, type: "event_msg", payload: { type: "task_started", model_context_window: 200000 } },
    { timestamp: iso(T0 + 600), ordinal: 2, type: "event_msg", payload: { type: "user_message", message: "codex task" } },
    { timestamp: iso(T0 + 900), ordinal: 3, type: "event_msg", payload: { type: "task_complete" } },
  ]));
  writeFileSync(rollout(childId), jsonl([
    { timestamp: iso(T0 + 700), ordinal: 0, type: "session_meta", payload: { id: childId, timestamp: iso(T0 + 700), cwd: "/work/codex", cli_version: "0.162.0", thread_source: "subagent", source: { subagent: { thread_spawn: { parent_thread_id: parentId, agent_path: "/root/worker" } } } } },
    { timestamp: iso(T0 + 800), ordinal: 1, type: "event_msg", payload: { type: "task_started" } },
  ]));
  return { parent: rollout(parentId), child: rollout(childId), parentId, childId };
}

const dshRow = (type, seq, time, data = {}) => ({ type, seq, time, data });
function dshFrames(rows) { return Buffer.concat(rows.map(row => zstdCompressSync(Buffer.from(JSON.stringify(row) + "\n")))); }

function writeDsh(root, id = "session-dsh0001", { slug = "--work-dsh--", extra = [] } = {}) {
  const dir = join(root, slug, id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "session.v4.jsonl.zstd");
  writeFileSync(file, dshFrames([
    { type: "session", id, version: 4, createdAt: T0, cwd: "/work/dsh" },
    dshRow("turn/start", 1, T0 + 100, { turn: 1 }),
    dshRow("user/message", 2, T0 + 200, { content: [{ type: "text", text: "dsh prompt" }], source: { kind: "user" } }),
    dshRow("turn/end", 3, T0 + 900, { turn: 1, reason: { kind: "completed" } }),
    ...extra,
  ]));
  writeFileSync(join(dir, "session.lock"), "");
  return { file, dir, id };
}

async function createSidecar(path, bindings) {
  const { DatabaseSync } = await import("node:sqlite");
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE IF NOT EXISTS bindings (dsh_session_id TEXT PRIMARY KEY, time INTEGER NOT NULL, acp_provider_id TEXT, acp_session_id TEXT, payload TEXT NOT NULL) STRICT");
  const add = (b) => db.prepare("INSERT OR REPLACE INTO bindings VALUES (?, ?, ?, ?, ?)").run(b.dsh, b.time ?? Date.now(), b.provider, b.acp, JSON.stringify({ canonicalCwd: b.cwd ?? "/work/dsh" }));
  for (const binding of bindings) add(binding);
  return { add, close: () => db.close() };
}

// ------------------------------------------------------------------------------------------------- harness

function startHarness(options = {}) {
  const messages = [];
  const waiters = [];
  const send = message => {
    messages.push(message);
    for (const waiter of [...waiters]) if (waiter.predicate(message)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message); }
    return true;
  };
  const collector = startCollector({
    hostInfo: { id: "test-host", site: "mac", kind: "workstation", label: "test" },
    send, intervals: FAST, defaults: false, env: {}, home: workDir, procs: false, since: 24 * 3_600_000, ...options,
  });
  const find = predicate => messages.find(predicate);
  const waitFor = (predicate, timeoutMs = 4000, what = "message") => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve: value => { clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error(`timed out after ${timeoutMs} ms waiting for ${what}; got ${messages.map(m => m.t + (m.agent?.key ? `:${m.agent.key}` : typeof m.agent === "string" ? `:${m.agent}` : "")).slice(-12).join(", ")}`)); }, timeoutMs);
      waiters.push(waiter);
    });
  };
  const agent = key => [...messages].reverse().find(m => m.t === "agent" && m.agent.key === key)?.agent;
  const waitAgent = (key, predicate = () => true, timeoutMs) => waitFor(m => m.t === "agent" && m.agent.key === key && predicate(m.agent), timeoutMs, `agent ${key}`).then(m => m.agent);
  const events = key => { const byId = new Map(); for (const m of messages) if (m.t === "events" && m.agent === key) for (const e of m.events) byId.set(e.id, e); return [...byId.values()]; };
  return { collector, messages, find, waitFor, agent, waitAgent, events, stop: () => collector.stop() };
}

const key = (kind, id) => `test-host#${kind}:${id}`;

// ----------------------------------------------------------------------------------------------------- tests

test("hello, then agents of all four kinds with their parents; appends and tool updates arrive within 1.5 s", async () => {
  const roots = { omp: newDir("omp"), claude: newDir("claude"), codex: newDir("codex"), dsh: newDir("dsh") };
  const ompFile = writeOmp(roots.omp);
  const ompSub = writeOmpSubagent(ompFile);
  const claude = writeClaude(roots.claude);
  const codex = writeCodex(roots.codex);
  writeDsh(roots.dsh);

  const h = startHarness({ roots: { omp: [roots.omp], claude: [roots.claude], codex: [roots.codex], dsh: [roots.dsh] } });
  try {
    assert.equal(h.messages[0].t, "hello");
    assert.equal(h.messages[0].proto, 1);
    assert.equal(h.messages[0].host.id, "test-host");
    assert.deepEqual(h.messages[0].host.roots.omp, [roots.omp]);

    const omp = await h.waitAgent(key("omp", ompMain.id), a => a.live && a.status === "running");
    assert.equal(omp.kind, "omp");
    assert.equal(omp.title, "Fix the build");
    assert.equal(omp.cwd, "/work/proj");
    assert.equal(omp.role, "main");
    assert.equal(omp.parent, null);
    assert.equal(omp.live.alive, null, "no process scan: liveness unknown");

    const sub = await h.waitAgent(key("omp", `${ompMain.id}/Builder`));
    assert.equal(sub.role, "subagent");
    assert.equal(sub.parent.kind, "omp");
    assert.equal(sub.parent.id, ompMain.id);
    assert.equal(sub.parent.key, key("omp", ompMain.id), "same-host parent carries its key");
    assert.equal(sub.parent.via, "file");

    const claudeSub = await h.waitAgent(key("claude", `${claude.sid}/abc123`));
    assert.equal(claudeSub.role, "subagent");
    assert.equal(claudeSub.parent.id, claude.sid);
    assert.equal(claudeSub.parent.toolCallId, "toolu_1");

    const codexChild = await h.waitAgent(key("codex", codex.childId));
    assert.equal(codexChild.role, "subagent");
    assert.equal(codexChild.parent.id, codex.parentId);
    assert.equal(codexChild.parent.key, key("codex", codex.parentId));

    const dsh = await h.waitAgent(key("dsh", "session-dsh0001"));
    assert.equal(dsh.kind, "dsh");
    assert.equal(dsh.cwd, "/work/dsh");

    // initial load carried the events
    const initial = h.events(key("omp", ompMain.id));
    const pendingTool = initial.find(event => event.id === "call-1");
    assert.equal(pendingTool?.status, "pending");
    assert.equal(pendingTool?.category, "shell");

    // an append (the tool result) is visible quickly, as an upsert of the same event id
    const sentAt = Date.now();
    appendFileSync(ompFile, jsonl([omptoolResult(), ompFinal()]));
    const updated = await h.waitFor(m => m.t === "events" && m.agent === key("omp", ompMain.id) && m.events.some(e => e.id === "call-1" && e.status === "ok"), 1500, "tool result upsert");
    assert.ok(Date.now() - sentAt < 1500);
    assert.equal(updated.events.filter(e => e.id === "call-1").length, 1);
    const done = await h.waitAgent(key("omp", ompMain.id), a => a.status === "done", 1500);
    assert.equal(done.counts.tools, 1);
    // later messages only carry what changed: the old pending user event is not resent
    assert.ok(!updated.events.some(e => e.type === "user"));

    // OMP rewrites its padded title line in place (same byte length): the new title shows up without a re-read of line 1
    // by the tail, which only sees appended bytes
    const { openSync, writeSync, closeSync } = await import("node:fs");
    const rewritten = JSON.stringify(titleRow("Renamed title"));
    assert.equal(rewritten.length, JSON.stringify(titleRow("Fix the build")).length);
    const fd = openSync(ompFile, "r+");
    writeSync(fd, rewritten, 0);
    closeSync(fd);
    appendFileSync(ompFile, jsonl([{ type: "custom", timestamp: iso(T0 + 5000), customType: "noop" }]));
    await h.waitAgent(key("omp", ompMain.id), a => a.title === "Renamed title", 2500);
  } finally { h.stop(); }
});

test("heartbeat stats, ping and unknown requests", async () => {
  const root = newDir("omp");
  writeOmp(root);
  const h = startHarness({ roots: { omp: [root] } });
  try {
    const beat = await h.waitFor(m => m.t === "heartbeat" && m.stats.agents >= 1, 3000, "heartbeat with one agent");
    assert.equal(typeof beat.at, "number");
    assert.ok(beat.stats.files >= 1 && beat.stats.rssMb > 0);
    assert.equal(typeof (await h.collector.handleRequest("ping")).at, "number");
    await assert.rejects(h.collector.handleRequest("nope"), /unknown collector method/);
  } finally { h.stop(); }
});

test("ACP: the DSH session gets acp, the native session gets parent dsh — whichever side appears first", async () => {
  const dshRoot = newDir("dsh"), ompRoot = newDir("omp");
  const sidecarPath = join(dshRoot, "..", `dsh-acp-${counter++}`, "sidecar.sqlite");
  const sidecar = await createSidecar(sidecarPath, [{ dsh: "session-acp-a", provider: "acp-omp", acp: uuid(5) }]);
  // order 1: the binding exists before either session
  const codexRoot = newDir("codex"), claudeRoot = newDir("claude");
  const h = startHarness({ roots: { omp: [ompRoot], dsh: [dshRoot], codex: [codexRoot], claude: [claudeRoot] }, sidecars: [sidecarPath] });
  try {
    await sleep(300);
    writeDsh(dshRoot, "session-acp-a");
    writeOmp(ompRoot, { id: uuid(5), stem: `${iso(T0 + 10).replace(/[:.]/g, "-")}_${uuid(5)}` });
    const dsh = await h.waitAgent(key("dsh", "session-acp-a"), a => a.acp);
    assert.deepEqual(dsh.acp, { provider: "acp-omp", kind: "omp", id: uuid(5) });
    const native = await h.waitAgent(key("omp", uuid(5)), a => a.parent?.via === "acp");
    assert.deepEqual({ kind: native.parent.kind, id: native.parent.id, via: native.parent.via, exact: native.parent.exact }, { kind: "dsh", id: "session-acp-a", via: "acp", exact: true });
    assert.equal(native.parent.key, key("dsh", "session-acp-a"));

    // order 2: both sessions are known first, the binding arrives later
    writeDsh(dshRoot, "session-acp-b");
    writeOmp(ompRoot, { id: uuid(6), stem: `${iso(T0 + 20).replace(/[:.]/g, "-")}_${uuid(6)}` });
    await h.waitAgent(key("omp", uuid(6)));
    await h.waitAgent(key("dsh", "session-acp-b"));
    assert.equal(h.agent(key("omp", uuid(6))).parent, null);
    sidecar.add({ dsh: "session-acp-b", provider: "acp-omp", acp: uuid(6), time: Date.now() });
    await h.waitAgent(key("omp", uuid(6)), a => a.parent?.via === "acp", 3000);
    await h.waitAgent(key("dsh", "session-acp-b"), a => a.acp?.id === uuid(6), 3000);

    // the codex and claude providers map to their kinds
    const codex = writeCodex(codexRoot, uuid(3), uuid(4));
    const claude = writeClaude(claudeRoot, uuid(2));
    writeDsh(dshRoot, "session-acp-c");
    writeDsh(dshRoot, "session-acp-d");
    sidecar.add({ dsh: "session-acp-c", provider: "acp-codex", acp: codex.parentId, time: Date.now() });
    sidecar.add({ dsh: "session-acp-d", provider: "acp-claude", acp: claude.sid, time: Date.now() });
    const viaCodex = await h.waitAgent(key("codex", codex.parentId), a => a.parent?.via === "acp", 3000);
    assert.equal(viaCodex.parent.id, "session-acp-c");
    const viaClaude = await h.waitAgent(key("claude", claude.sid), a => a.parent?.via === "acp", 3000);
    assert.equal(viaClaude.parent.id, "session-acp-d");
    assert.deepEqual((await h.waitAgent(key("dsh", "session-acp-c"), a => a.acp)).acp, { provider: "acp-codex", kind: "codex", id: codex.parentId });
    // a transcript parent (exact) is never replaced by a binding: the codex child keeps its parent thread
    assert.equal(h.agent(key("codex", codex.childId)).parent.via, "file");
  } finally { h.stop(); sidecar.close(); }
});

test("ACP: a missing or locked sidecar is not an error", async () => {
  const root = newDir("omp");
  writeOmp(root);
  const warnings = [];
  const h = startHarness({ roots: { omp: [root] }, sidecars: [join(workDir, "does-not-exist", "sidecar.sqlite")], log: m => warnings.push(m) });
  try {
    await h.waitAgent(key("omp", ompMain.id));
    await sleep(350);
    assert.deepEqual(warnings, []);
  } finally { h.stop(); }
});

test("file.read: refuses secret paths, redacts, caps, flags binary, refuses non-files", async () => {
  const dir = newDir("files");
  writeFileSync(join(dir, ".env"), "API_KEY=sk-live-abcdefghijklmnopqrstuvwx\n");
  writeFileSync(join(dir, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n");
  writeFileSync(join(dir, "notes.txt"), "hello\nAuthorization: Bearer abcdefghijklmnopqrstuv0123\nGITHUB token=ghp_abcdefghijklmnopqrstuvwxyz0123456789\nend\n");
  writeFileSync(join(dir, "blob.bin"), Buffer.from([1, 2, 0, 3, 4]));
  writeFileSync(join(dir, "big.log"), "x".repeat(300 * 1024));
  writeFileSync(join(dir, "multi.txt"), "é".repeat(10));
  symlinkSync(join(dir, ".env"), join(dir, "innocent.txt"));
  mkdirSync(join(dir, "sub"));
  const h = startHarness({ roots: { omp: [newDir("omp")] } });
  const read = (path, maxBytes) => h.collector.handleRequest("file.read", { path, maxBytes });
  try {
    const secret = await read(join(dir, ".env"));
    assert.equal(secret.exists, false);
    assert.match(secret.denied, /secret/);
    assert.equal(secret.content, undefined);
    assert.match((await read(join(dir, "id_rsa"))).denied, /secret/);
    const viaLink = await read(join(dir, "innocent.txt"));
    assert.match(viaLink.denied ?? "", /secret/, "a symlink to a secret file is refused too");
    assert.equal(viaLink.content, undefined);

    const notes = await read(join(dir, "notes.txt"));
    assert.equal(notes.exists, true);
    assert.equal(notes.host, "test-host");
    assert.equal(notes.binary, false);
    assert.ok(notes.redactions >= 2, `redactions ${notes.redactions}`);
    assert.ok(!notes.content.includes("abcdefghijklmnopqrstuv0123"));
    assert.ok(!notes.content.includes("ghp_abcdef"));
    assert.ok(notes.content.includes("hello") && notes.content.includes("end"));
    assert.equal(notes.truncated, false);
    assert.equal(notes.size, (await import("node:fs")).statSync(join(dir, "notes.txt")).size);

    const blob = await read(join(dir, "blob.bin"));
    assert.equal(blob.binary, true);
    assert.equal(blob.content, undefined);

    const big = await read(join(dir, "big.log"), 10_000_000);
    assert.equal(big.truncated, true);
    assert.equal(big.content.length, 256 * 1024);
    const small = await read(join(dir, "big.log"), 100);
    assert.equal(small.content.length, 100);
    assert.equal(small.size, 300 * 1024);

    const cut = await read(join(dir, "multi.txt"), 5); // 5 bytes cut a two-byte character
    assert.ok(!cut.content.includes("\uFFFD"));

    assert.equal((await read(join(dir, "missing.txt"))).exists, false);
    assert.match((await read(join(dir, "sub"))).denied, /directory/);
    assert.match((await read("relative/path.txt")).denied, /absolute/);
    assert.match((await read("/proc/self/environ")).denied, /pseudo/);
    assert.match((await read("")).denied, /required/);
  } finally { h.stop(); }
});

test("file.read: secret paths are case-insensitive; fleet tokens and bare credentials in the content are refused", async () => {
  const dir = newDir("files-content");
  mkdirSync(join(dir, ".SSH"));
  writeFileSync(join(dir, ".SSH", "ID_RSA"), "SSH-PRIVATE-MARKER\n");
  writeFileSync(join(dir, "ID_RSA"), "SSH-PRIVATE-MARKER\n");
  const home = newDir("home");
  const token = "0123456789abcdef".repeat(4);          // 64 hex, the shape of ~/.config/agent-fleet/token
  const upstream = "fedcba9876543210".repeat(4);
  mkdirSync(join(home, ".config", "agent-fleet"), { recursive: true });
  writeFileSync(join(home, ".config", "agent-fleet", "token"), `${token}\n`);
  writeFileSync(join(home, ".config", "agent-fleet", "upstream-token"), `${upstream}\n`);
  const source = join(dir, "server.mjs"), config = join(dir, "fleet.json"), log = join(dir, "hub.log");
  writeFileSync(source, "export function add(a, b) {\n  return a + b;\n}\n");
  writeFileSync(config, '{"name":"fleet","port":8080,"tags":["a","b"]}\n');
  writeFileSync(log, "2026-10-31T08:00:00Z starting hub\n2026-10-31T08:00:01Z listening on 127.0.0.1:7840\n");
  const copy = join(dir, "notes.txt"), inline = join(dir, "agent.log"), bare = join(dir, "key64.txt"), blob = join(dir, "blob64.txt");
  writeFileSync(copy, `${token}\n`);                    // `cp ~/.config/agent-fleet/token /tmp/notes.txt`
  writeFileSync(inline, `2026-10-31T08:00:02Z reading config\nx-agent-fleet-token: ${upstream}\n`);
  writeFileSync(bare, `${token}\n`);
  writeFileSync(blob, `${"QUJD".repeat(40)}==\n`);      // 162 base64 characters
  const h = startHarness({ roots: { omp: [newDir("omp")] }, home });
  const read = (path, maxBytes) => h.collector.handleRequest("file.read", { path, maxBytes });
  try {
    const upper = await read(join(dir, ".SSH", "ID_RSA"));
    assert.match(upper.denied ?? "", /secret/, "APFS is case-insensitive: .SSH is .ssh");
    assert.equal(upper.content, undefined);
    assert.match((await read(join(dir, "ID_RSA"))).denied ?? "", /secret/, "ID_RSA is id_rsa");

    const copied = await read(copy);
    assert.match(copied.denied ?? "", /secret content/, "a copy of the token is a secret with a harmless path");
    assert.equal(copied.content, undefined);
    assert.ok(!JSON.stringify(copied).includes(token), "the refusal does not echo the token");

    const embedded = await read(inline);
    assert.match(embedded.denied ?? "", /secret content/, "the upstream token inside a log line is refused");
    assert.equal(embedded.content, undefined);

    // the bare-credential rule alone (no token file on this host): a lone 64-hex line, a long base64 line
    const emptyHome = newDir("empty-home");
    assert.match((await readFilePreview({ path: bare, host: "h", home: emptyHome })).denied ?? "", /secret content/);
    assert.match((await readFilePreview({ path: blob, host: "h", home: emptyHome })).denied ?? "", /secret content/);

    // ordinary files stay previewable: a source file, a JSON config without secrets, a log
    for (const [file, needle] of [[source, "export function add"], [config, '"port":8080'], [log, "listening on 127.0.0.1:7840"]]) {
      const preview = await read(file);
      assert.equal(preview.exists, true, `${file} ${preview.denied ?? ""}`);
      assert.equal(preview.binary, false);
      assert.ok(preview.content.includes(needle), preview.content);
    }
    const oneLine = join(dir, "build.txt");
    writeFileSync(oneLine, "0123456789".repeat(30) + "\n");   // a long single line that is not a credential
    assert.equal((await read(oneLine)).exists, true);
  } finally { h.stop(); }
});

test("file.read: a directory swapped for a symlink between the path check and the open is refused", async () => {
  const dir = newDir("race");
  mkdirSync(join(dir, ".ssh"));
  writeFileSync(join(dir, ".ssh", "notes.txt"), "SSH-PRIVATE-MARKER\n");
  mkdirSync(join(dir, "safe"));
  writeFileSync(join(dir, "safe", "notes.txt"), "harmless\n");
  let swapped = false;
  const preview = await readFilePreview({
    path: join(dir, "safe", "notes.txt"), host: "race-host", home: newDir("race-home"), knownSecrets: [],
    hooks: {
      beforeOpen: () => {
        renameSync(join(dir, "safe"), join(dir, "safe-real"));
        symlinkSync(".ssh", join(dir, "safe"));
        swapped = true;
      },
    },
  });
  assert.equal(swapped, true, "the hook ran between the check and the open");
  assert.equal(preview.content, undefined, "the opened handle was a secret, not the checked path");
  assert.match(preview.denied ?? "", /secret/);
});

test("deleting a transcript sends gone once; recreating it brings the agent back", async () => {
  const root = newDir("omp");
  const file = writeOmp(root);
  const h = startHarness({ roots: { omp: [root] } });
  try {
    await h.waitAgent(key("omp", ompMain.id));
    rmSync(file);
    await h.waitFor(m => m.t === "gone" && m.agent === key("omp", ompMain.id), 2500, "gone");
    await sleep(500);
    assert.equal(h.messages.filter(m => m.t === "gone").length, 1);
    const before = h.messages.filter(m => m.t === "agent" && m.agent.key === key("omp", ompMain.id)).length;
    writeOmp(root);
    await h.waitFor(m => m.t === "agent" && m.agent.key === key("omp", ompMain.id) && h.messages.filter(x => x.t === "agent" && x.agent.key === m.agent.key).length > before, 3000, "agent again");
  } finally { h.stop(); }
});

test("sessions older than --since are ignored until written again", async () => {
  const root = newDir("omp");
  const file = writeOmp(root);
  const old = new Date(Date.now() - 3 * 3_600_000);
  (await import("node:fs")).utimesSync(file, old, old);
  const h = startHarness({ roots: { omp: [root] }, since: 3_600_000 });
  try {
    await sleep(700);
    assert.equal(h.find(m => m.t === "agent"), undefined, "an old transcript is not loaded");
    appendFileSync(file, jsonl([omptoolResult(), ompFinal()]));
    const agent = await h.waitAgent(key("omp", ompMain.id), a => a.status === "done", 5000);
    assert.equal(agent.counts.tools, 1);
    assert.ok(h.events(key("omp", ompMain.id)).some(e => e.id === "call-1" && e.status === "ok"), "its history is loaded from byte 0");
  } finally { h.stop(); }
});

test("agent.events pages older events by an exclusive time bound", async () => {
  const root = newDir("omp");
  const file = writeOmp(root, { withResult: true });
  const rows = [];
  for (let i = 0; i < 30; i += 1) rows.push({ type: "message", timestamp: iso(T0 + 10_000 + i * 1000), message: { role: "user", content: [{ type: "text", text: `follow-up ${i}` }] } });
  appendFileSync(file, jsonl(rows));
  const h = startHarness({ roots: { omp: [root] } });
  try {
    await h.waitAgent(key("omp", ompMain.id), a => a.counts.events >= 30);
    const page = await h.collector.handleRequest("agent.events", { key: key("omp", ompMain.id), limit: 10 });
    assert.equal(page.events.length, 10);
    assert.equal(page.hasMore, true);
    assert.ok(page.events.every((e, i, all) => i === 0 || all[i - 1].t <= e.t), "oldest first");
    const older = await h.collector.handleRequest("agent.events", { key: key("omp", ompMain.id), before: page.events[0].t, limit: 10 });
    assert.ok(older.events.every(e => e.t < page.events[0].t));
    assert.ok(!older.events.some(e => page.events.some(p => p.id === e.id)));
    const all = await h.collector.handleRequest("agent.events", { key: key("omp", ompMain.id), limit: 1000 });
    assert.equal(all.hasMore, false);
    await assert.rejects(h.collector.handleRequest("agent.events", { key: "test-host#omp:nope" }), /unknown agent/);
  } finally { h.stop(); }
});

test("globbed roots: runs appearing later are picked up and labelled with their run", async () => {
  const runs = newDir("runs");
  const pattern = join(runs, "*", "work", "harness-home", "sessions");
  const first = join(runs, "main1-p27-analyst", "work", "harness-home", "sessions");
  writeDsh(first, "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { slug: "--work--" });
  const h = startHarness({ roots: [`dsh=${pattern}`] });
  try {
    assert.deepEqual(h.messages[0].host.roots.dsh, [pattern]);
    const a = await h.waitAgent(key("dsh", "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));
    assert.equal(a.container, "main1-p27-analyst");
    assert.equal(a.cwd, "/work/dsh", "the container path is kept as written");
    assert.equal(a.file.startsWith(first), true);
    // a run directory created after start
    writeDsh(join(runs, "main2-p28-writer", "work", "harness-home", "sessions"), "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { slug: "--work--" });
    const b = await h.waitAgent(key("dsh", "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), () => true, 4000);
    assert.equal(b.container, "main2-p28-writer");
  } finally { h.stop(); }
});

test("explicit roots add to the defaults (deduplicated), AGENT_FLEET_ROOTS is honoured, missing roots are tolerated", async () => {
  const home = newDir("home");
  const defaultOmp = join(home, ".omp", "agent", "sessions");
  const extra = newDir("extra-omp"), envRoot = newDir("env-omp");
  writeOmp(defaultOmp);
  writeOmp(extra, { id: uuid(9), stem: `${iso(T0 + 5).replace(/[:.]/g, "-")}_${uuid(9)}` });
  writeOmp(envRoot, { id: uuid(8), stem: `${iso(T0 + 6).replace(/[:.]/g, "-")}_${uuid(8)}` });
  const h = startHarness({ defaults: true, home, env: { AGENT_FLEET_ROOTS: `omp=${envRoot}` }, roots: [`omp=${extra}`, `omp=${defaultOmp}`, `omp=${join(home, "nowhere")}`] });
  try {
    for (const id of [ompMain.id, uuid(9), uuid(8)]) await h.waitAgent(key("omp", id));
    const roots = h.messages[0].host.roots.omp;
    assert.equal(roots.filter(path => path === defaultOmp).length, 1, "the default root is listed once");
    assert.ok(roots.includes(extra) && roots.includes(envRoot));
  } finally { h.stop(); }
});

// ---------------------------------------------------------------------------------------- process matching

const proc = (pid, ppid, cmd, startedAt = T0, extra = {}) => ({ pid, ppid, startedAt, cmd, argv: splitCommand(cmd), ...extra });

function fakeSys(listing, extras = {}) {
  const state = { listing, details: new Map(), env: new Map(), locks: null, ...extras };
  return {
    state,
    list: async () => state.listing,
    details: async pids => new Map(pids.map(pid => [pid, state.details.get(pid) ?? { files: [] }])),
    env: async pids => new Map(pids.map(pid => [pid, state.env.get(pid) ?? {}])),
    locks: extras.withLocks ? async () => state.locks ?? new Map() : null,
  };
}

test("processes: an OMP session named by --session is alive with its pid; when the process ends a quiet open turn goes stale", async () => {
  const root = newDir("omp");
  const file = writeOmp(root); // ends with an open tool call: running
  let skew = 0;
  const sys = fakeSys([proc(4242, 1, `bun /home/u/.bun/bin/omp --session ${file}`, T0, {})]);
  sys.state.details.set(4242, { cwd: "/work/proj", files: [file] });
  const h = startHarness({ roots: { omp: [root] }, procs: true, sys, platform: "linux", now: () => Date.now() + skew });
  try {
    const live = await h.waitAgent(key("omp", ompMain.id), a => a.live.alive === true);
    assert.equal(live.live.pid, 4242);
    assert.equal(live.status, "running");
    const procs = await h.waitFor(m => m.t === "procs" && m.procs.some(p => p.pid === 4242 && p.agent === key("omp", ompMain.id)), 3000, "procs message");
    const entry = procs.procs.find(p => p.pid === 4242);
    assert.equal(entry.kind, "omp");
    assert.ok(entry.cmd.includes("omp --session"));

    sys.state.listing = [];
    const gone = await h.waitAgent(key("omp", ompMain.id), a => a.live.alive === false, 3000);
    assert.equal(gone.status, "running", "recently active: not stale yet");
    skew = 6 * 60_000;
    const stale = await h.waitAgent(key("omp", ompMain.id), a => a.status === "stale", 3000);
    assert.equal(stale.live.alive, false);
    assert.equal(stale.live.state, "ended");
  } finally { h.stop(); }
});

test("processes: a launched ACP child gets parent dsh from AGENT_FLEET_VIA, a plain nested agent from its parent's session id", async () => {
  const root = newDir("omp");
  const file = writeOmp(root);
  const childId = uuid(7);
  const childFile = writeOmp(root, { id: childId, stem: `${iso(T0 + 100).replace(/[:.]/g, "-")}_${childId}`, slug: "-work-child" });
  const sys = fakeSys([
    proc(100, 1, `bun /x/.bun/bin/omp --session ${file}`, T0),
    proc(101, 100, "/bin/bash -c something", T0 + 10),
    proc(102, 101, `bun /x/.bun/bin/omp --session ${childFile}`, T0 + 20),
  ]);
  sys.state.details.set(100, { cwd: "/work/proj", files: [file] });
  sys.state.details.set(102, { cwd: "/work/child", files: [childFile] });
  sys.state.env.set(100, { AGENT_FLEET_VIA: "dsh:session-abc" });
  sys.state.env.set(102, { PI_SESSION_ID: ompMain.id, CODEX_TOOL_CALL_ID: "call-9", AGENT_FLEET_VIA: "dsh:session-abc" });
  const h = startHarness({ roots: { omp: [root] }, procs: true, sys, platform: "linux" });
  try {
    const top = await h.waitAgent(key("omp", ompMain.id), a => a.parent?.via === "acp");
    assert.equal(top.parent.id, "session-abc");
    assert.equal(top.parent.exact, true);
    const child = await h.waitAgent(key("omp", childId), a => a.live.alive === true);
    // the nearest agent ancestor is the OMP above: AGENT_FLEET_VIA (inherited) must not claim the child for DSH
    assert.equal(child.parent?.via, "env");
    assert.equal(child.parent.kind, "omp");
    assert.equal(child.parent.id, ompMain.id);
    assert.equal(child.parent.toolCallId, "call-9");
    const procs = h.messages.findLast(m => m.t === "procs").procs;
    const childProc = procs.find(p => p.pid === 102);
    assert.equal(childProc.ppid, 100, "reported ppid skips the shell between the agents");
    assert.deepEqual(childProc.parentSession, { kind: "omp", id: ompMain.id, via: "env", exact: true });
    assert.equal(childProc.via, undefined);
    assert.deepEqual(procs.find(p => p.pid === 100).via, { kind: "dsh", id: "session-abc" });
  } finally { h.stop(); }
});

test("processes: a DSH session whose session.lock is flocked by a pid is alive with that pid (Linux /proc/locks)", async () => {
  const root = newDir("dsh");
  const { dir } = writeDsh(root, "session-locked");
  writeDsh(root, "session-unlocked");
  const { statSync } = await import("node:fs");
  const { lockKeyOfStat } = await import("../lib/collector/procs.mjs");
  const key1 = lockKeyOfStat(statSync(join(dir, "session.lock"), { bigint: true }));
  const sys = fakeSys([proc(777, 1, "node /runtime/node_modules/@deepseek-ai/dsh/lib/bin.js --profile sdk", T0)], { withLocks: true });
  sys.state.locks = new Map([[key1, 777]]);
  const h = startHarness({ roots: { dsh: [root] }, procs: true, sys, platform: "linux" });
  try {
    const locked = await h.waitAgent(key("dsh", "session-locked"), a => a.live.alive === true);
    assert.equal(locked.live.pid, 777);
    assert.equal(locked.status, "idle", "a resident session that finished its turn is idle, not done");
    const other = await h.waitAgent(key("dsh", "session-unlocked"));
    assert.equal(other.live.alive, false);
    assert.equal(other.status, "done");
  } finally { h.stop(); }
});

test("process parsing helpers", () => {
  // ps output with single- and double-digit days
  const rows = parsePsOutput([
    "  101     1 Wed Oct 28 15:22:09 2026 bun /Users/u/.bun/bin/omp --session /s/a.jsonl",
    "  102   101 Fri Oct  3 01:02:03 2026 /usr/bin/ssh -N host",
    "garbage line",
  ].join("\n"));
  assert.equal(rows.length, 2);
  assert.equal(rows[1].startedAt, new Date("Fri Oct  3 01:02:03 2026").getTime());

  assert.deepEqual(splitCommand("/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex -c a=b app-server"), ["/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex", "-c", "a=b", "app-server"]);
  assert.deepEqual(splitCommand("/Users/lbc/Library/Application Support/Codex/runtime/bin/node /Users/lbc/Library/Application Support/Codex/host-daemon.mjs").slice(0, 1), ["/Users/lbc/Library/Application Support/Codex/runtime/bin/node /Users/lbc/Library/Application Support/Codex/host-daemon.mjs"]);

  const kinds = cmd => classifyCommand(splitCommand(cmd), { cmd, host: "mac", site: "mac" });
  assert.equal(kinds("bun /Users/u/.bun/bin/omp --session /x.jsonl")?.kind, "omp");
  assert.equal(kinds("bun /Users/u/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js __omp_worker_daemon_broker"), null);
  assert.equal(kinds("/opt/homebrew/bin/bun /Users/u/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js --resume abc")?.kind, "omp");
  assert.equal(kinds("node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js --session-id 123")?.kind, "claude");
  assert.equal(kinds("claude --version"), null);
  assert.equal(kinds("/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex app-server")?.server, true);
  assert.equal(kinds("node /usr/lib/node_modules/@zed-industries/claude-agent-acp/dist/index.js")?.kind, "acp-bridge");
  assert.equal(kinds("node /runtime/node_modules/@deepseek-ai/dsh/lib/bin.js --profile sdk")?.kind, "dsh");
  assert.equal(kinds("/Applications/DeepSeek Harness.app/Contents/Frameworks/DeepSeek Harness Helper.app/Contents/MacOS/DeepSeek Harness Helper --type=gpu-process"), null);
  assert.equal(kinds("/usr/bin/vim notes.md"), null);

  const launcher = kinds("/usr/local/bin/kubectl --context chengdu -n mc-bochao-li exec -i pod-a -- omp -p hi");
  assert.equal(launcher.kind, "kubectl");
  assert.equal(launcher.launches, "omp");
  assert.equal(launcher.remote.pod, "pod-a");
  assert.equal(launcher.remote.site, "chengdu");
  assert.equal(kinds("kubectl --context chengdu get pods"), null);
  const viaSsh = kinds("/usr/bin/ssh -o BatchMode=yes bochao_li@10.0.60.98 claude -p hello");
  assert.equal(viaSsh.kind, "ssh");
  assert.equal(viaSsh.launches, "claude");
  assert.equal(viaSsh.remote.site, "server-bochao-01");
  assert.equal(kinds("/usr/bin/ssh -N -o BatchMode=yes -L 7840:127.0.0.1:7840 bochao_li@10.0.60.98"), null, "a port forward launches no agent");

  const lsof = parseLsof(["p10", "fcwd", "tDIR", "n/work/a", "f3", "tREG", "n/home/u/.omp/agent/sessions/s/x.jsonl", "f4", "tREG", "n/etc/passwd", "p11", "fcwd", "n/work/b", "f9", "tREG", "n/data/runs/r/session.lock"].join("\n"));
  assert.deepEqual(lsof.get(10), { cwd: "/work/a", files: ["/home/u/.omp/agent/sessions/s/x.jsonl"] });
  assert.deepEqual(lsof.get(11).files, ["/data/runs/r/session.lock"]);

  const locks = parseProcLocks([
    "1: FLOCK  ADVISORY  WRITE 4242 08:01:131077 0 EOF",
    "2: POSIX  ADVISORY  READ  77 fd:00:99 0 EOF",
    "2: -> POSIX  ADVISORY  READ  78 fd:00:99 0 EOF",
  ].join("\n"));
  assert.equal(locks.get("8:1:131077"), 4242);
  assert.equal(locks.get("253:0:99"), 77);
  assert.equal(locks.size, 2);

  const env = parsePsEnv("  55 /bin/sleep 1 PI_SESSION_ID=abc-123 HOME=/x AGENT_FLEET_VIA=dsh:s1\n  56 other CODEX_THREAD_ID=zzz", [55, 56]);
  assert.equal(env.get(55).PI_SESSION_ID, "abc-123");
  assert.equal(env.get(55).AGENT_FLEET_VIA, "dsh:s1");
  assert.equal(env.get(56).CODEX_THREAD_ID, "zzz");
});

test("bindProcs: DSH_AGENT_FLEET_PARENT(_CALL) names the parent call while the nearest agent is a DSH session; inherited copies on an agent started from that shell are ignored", () => {
  const views = [{ key: "h#dsh:s1", kind: "dsh", id: "s1", role: "main", file: "/s/s1/session.v4.jsonl.zstd", cwd: "/work", startedAt: T0 - 2000, updatedAt: T0 + 5, turnOpen: false }];
  const proc = (pid, ppid, cmd, startedAt, env) => ({ pid, ppid, kind: classifyCommand(splitCommand(cmd)).kind, startedAt, cmd, argv: splitCommand(cmd), cwd: "/work", files: [], env });
  const dsh = proc(10, 1, "dsh --profile headless 'do it'", T0 - 2000, {});
  const launcher = proc(11, 10, "kubectl --context ulanqab-iron exec agent-fleet-test-0 -- omp -p hi", T0 + 1000,
    { DSH_AGENT_FLEET_PARENT: "dsh:s1", DSH_AGENT_FLEET_PARENT_CALL: "call-77" });
  const claude = proc(12, 11, "claude -p hi", T0 + 2000, { DSH_AGENT_FLEET_PARENT: "dsh:s1", DSH_AGENT_FLEET_PARENT_CALL: "call-77", CLAUDE_CODE_SESSION_ID: "c1" });
  const inner = proc(13, 12, "ssh sg-compute 'omp -p hi'", T0 + 3000,
    { DSH_AGENT_FLEET_PARENT: "dsh:s1", DSH_AGENT_FLEET_PARENT_CALL: "call-77", CLAUDE_CODE_SESSION_ID: "c1" });
  const procs = [dsh, launcher, claude, inner];
  const table = new Map(procs.map(p => [p.pid, p]));
  const { procs: reported } = bindProcs(views, { ok: true, procs, table, locks: null });
  const byPid = pid => reported.find(p => p.pid === pid);
  assert.equal(byPid(11).parent, "dsh:s1", "the launcher belongs to the DSH session that ran the shell");
  assert.equal(byPid(11).parentCall, "call-77", "and to the exact tool call");
  assert.equal(byPid(13).parent, undefined, "a shell of the claude started from that shell keeps the stale DSH copy");
  assert.equal(byPid(13).parentCall, undefined);
  assert.deepEqual(byPid(13).parentSession, { kind: "claude", id: "c1", via: "env", exact: true });
});

test("bindProcs: explicit session beats the cwd heuristic; the heuristic only pairs within ±10 min, nearest first", () => {
  const views = [
    { key: "h#omp:a", kind: "omp", id: "a", role: "main", file: "/s/a.jsonl", cwd: "/work", startedAt: T0, updatedAt: T0 + 5, turnOpen: false },
    { key: "h#omp:b", kind: "omp", id: "b", role: "main", file: "/s/b.jsonl", cwd: "/work", startedAt: T0 + 60_000, updatedAt: T0 + 70_000, turnOpen: false },
    { key: "h#omp:far", kind: "omp", id: "far", role: "main", file: "/s/far.jsonl", cwd: "/work", startedAt: T0 - 3_600_000, updatedAt: T0, turnOpen: false },
  ];
  const mk = (pid, cmd, startedAt, cwd, files = []) => ({ pid, ppid: 1, kind: classifyCommand(splitCommand(cmd)).kind, startedAt, cmd, argv: splitCommand(cmd), cwd, files, env: {} });
  const named = mk(1, "bun /x/.bun/bin/omp --session /s/a.jsonl", T0 + 59_000, "/work");
  const guess = mk(2, "bun /x/.bun/bin/omp", T0 + 61_000, "/work");
  const table = new Map([[1, named], [2, guess]]);
  const { bindings } = bindProcs(views, { ok: true, procs: [named, guess], table, locks: null });
  assert.equal(bindings.get("h#omp:a").pid, 1);
  assert.equal(bindings.get("h#omp:a").how, "arg");
  assert.equal(bindings.get("h#omp:b").pid, 2);
  assert.equal(bindings.get("h#omp:b").how, "cwd");
  assert.equal(bindings.has("h#omp:far"), false);
});

test("applyLiveness: stale needs a gone process AND five quiet minutes; a resident finished session is idle", () => {
  const record = { status: "running", role: "main", updatedAt: 1000, live: { alive: null, state: "tool", since: 1, doing: "bash ls", turnOpen: true } };
  const now = 1000 + 5 * 60_000;
  assert.equal(applyLiveness(record, { alive: false }, { now: now - 1 }).status, "running");
  const stale = applyLiveness(record, { alive: false }, { now });
  assert.equal(stale.status, "stale");
  assert.equal(stale.live.doing, "");
  assert.equal(applyLiveness(record, { alive: true, pid: 5 }, { now }).status, "running");
  assert.equal(applyLiveness(record, { alive: null }, { now }).status, "running", "unknown liveness never goes stale");
  assert.equal(applyLiveness({ ...record, status: "done" }, { alive: true, pid: 5 }, { now }).status, "idle");
  assert.equal(applyLiveness({ ...record, status: "done", role: "subagent" }, { alive: true, pid: 5 }, { now }).status, "done");
  assert.equal(applyLiveness({ ...record }, { alive: true, pid: 5 }, { now }).live.pid, 5);
  assert.ok(!("pid" in applyLiveness(record, { alive: false }, { now }).live));
});

// ------------------------------------------------------------------------------------------------ CLI + bundle

test("collector CLI arguments", () => {
  const parsed = parseCollectorArgs(["--stdio", "--host-id", "k8s/os/botato-1", "--site", "os", "--root", "omp=/data/*/sessions", "--root=dsh=/x", "--sidecar", "/s.sqlite", "--since", "6h", "--kind", "pod", "--pod", "botato-1"], { env: {}, platform: "linux", hostname: "box" });
  assert.equal(parsed.stdio, true);
  assert.deepEqual(parsed.roots, [{ kind: "omp", path: "/data/*/sessions" }, { kind: "dsh", path: "/x" }]);
  assert.deepEqual(parsed.sidecars, ["/s.sqlite"]);
  assert.equal(parsed.sinceMs, 6 * 3_600_000);
  assert.equal(parsed.hostInfo.kind, "pod");
  assert.equal(parsed.hostInfo.id, "k8s/os/botato-1");
  assert.equal(parsed.hostInfo.cluster, "ulanqab-osmium");
  assert.equal(parsed.hostInfo.pod, "botato-1");

  const ssh = parseCollectorArgs(["--ssh", "bochao_li@10.0.60.98", "--ssh-port", "7841", "--host-id", "sg-compute", "--site", "sg-compute", "--kind", "server"], { env: {}, platform: "linux", hostname: "box" });
  assert.equal(ssh.ssh, "bochao_li@10.0.60.98");
  assert.equal(ssh.sshPort, 7841);
  assert.equal(parseCollectorArgs(["--connect", "127.0.0.1:7841"], { env: {}, platform: "darwin", hostname: "mbp" }).connectTo.port, 7841);
  const authed = parseCollectorArgs(["--connect", "127.0.0.1:7841", "--token-file", "/keys/ingest.token"], { env: {}, platform: "linux", hostname: "box" });
  assert.equal(authed.tokenFile, "/keys/ingest.token");
  assert.equal(parseCollectorArgs(["--ssh", "h", "--token-file=/k"], { env: {}, platform: "linux" }).tokenFile, "/k");
  assert.equal(parseCollectorArgs(["--stdio"], { env: {}, platform: "darwin" }).tokenFile, undefined, "stdio (hub-dialed) needs no credential");
  const mac = parseCollectorArgs(["--stdio"], { env: {}, platform: "darwin", hostname: "mbp.local" });
  assert.equal(mac.hostInfo.id, "mbp.local");
  assert.equal(mac.hostInfo.site, "mac");
  assert.equal(mac.hostInfo.kind, "workstation");

  assert.throws(() => parseCollectorArgs([], { env: {} }), /exactly one transport/);
  assert.throws(() => parseCollectorArgs(["--stdio", "--connect", "h:1"], { env: {} }), /exactly one transport/);
  assert.throws(() => parseCollectorArgs(["--stdio", "--root", "bogus"], { env: {} }), /invalid root/);
  assert.throws(() => parseCollectorArgs(["--stdio", "--root", "cursor=/x"], { env: {} }), /invalid root/);
  assert.throws(() => parseCollectorArgs(["--stdio", "--since", "soon"], { env: {} }), /invalid duration/);
  assert.throws(() => parseCollectorArgs(["--stdio", "--nope"], { env: {} }), /unknown option/);
});

test("bundler: rewrites import/export forms and rejects what it cannot bundle", () => {
  const resolveSpec = spec => (spec.startsWith("node:") ? spec : `lib/${spec.replace(/^\.\//, "")}`);
  const out = transformModule("lib/a.mjs", [
    "import { readFile as rf, stat } from \"node:fs/promises\";",
    "import def, { x as y } from \"./b.mjs\";",
    "import * as ns from \"./c.mjs\";",
    "const text = 'import { notReal } from \"nope\"; export const fake = 1'; // import { alsoNot } from \"nope\"",
    "export const a = 1;",
    "export function f() { return import(\"./d.mjs\"); }",
    "export async function g() {}",
    "export class K {}",
    "export { a as b, f };",
    "export * from \"./e.mjs\";",
    "export default function main() {}",
  ].join("\n"), resolveSpec);
  assert.deepEqual(out.deps.sort(), ["lib/b.mjs", "lib/c.mjs", "lib/e.mjs", "node:fs/promises"].sort());
  assert.deepEqual(out.dynamic, ["lib/d.mjs"]);
  assert.ok(out.body.includes("const { readFile: rf, stat } = __req(\"node:fs/promises\");"));
  assert.ok(out.body.includes("const def = __req(\"lib/b.mjs\").default; const { x: y } = __req(\"lib/b.mjs\");"));
  assert.ok(out.body.includes("__dyn(\"lib/d.mjs\")"));
  assert.ok(out.body.includes("'import { notReal } from \"nope\"; export const fake = 1'"), "string contents are untouched");
  assert.ok(!/^export /m.test(out.body));
  assert.deepEqual(out.exportNames.sort(), ["K", "a", "b=a", "default=main", "f", "f", "g"].sort());
  assert.throws(() => transformModule("lib/x.mjs", "export let counter = 0;", resolveSpec), /mutable/);
  assert.throws(() => transformModule("lib/x.mjs", "const u = import.meta.url;", resolveSpec), /import\.meta/);
  assert.throws(() => transformModule("lib/x.mjs", "const m = await import(name);", resolveSpec), /non-literal/);
  assert.throws(() => transformModule("lib/x.mjs", "export const a = 1, b = 2;", resolveSpec), /several names/);
});

test("the single-file bundle (copied elsewhere, node:* imports only) speaks the protocol over --stdio", async () => {
  const out = join(newDir("bundle"), "agent-fleet-collector.mjs");
  const built = buildCollector({ out });
  assert.ok(built.externals.every(spec => spec.startsWith("node:")), built.externals.join());
  assert.ok(built.modules.includes("lib/collector/index.mjs") && built.modules.includes("lib/collector/readers/omp.mjs"));
  assert.ok(!built.modules.some(path => path.startsWith("lib/hub") || path === "lib/edge.mjs"), "hub and edge are not part of the pod bundle");

  const root = newDir("omp");
  const file = writeOmp(root);
  const child = spawn(process.execPath, [out, "collector", "--stdio", "--host-id", "t", "--site", "mac", "--no-default-roots", "--root", `omp=${root}`], { stdio: ["pipe", "pipe", "pipe"], cwd: newDir("elsewhere") });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const seen = [];
  const replies = [];
  const channel = createChannel({ readable: child.stdout, writable: child.stdin, label: "bundle", onMessage: message => seen.push(message), onClose: () => {} });
  try {
    const deadline = Date.now() + 8000;
    while (!(seen.some(m => m.t === "hello") && seen.some(m => m.t === "agent" && m.agent.key === `t#omp:${ompMain.id}`)) && Date.now() < deadline) await sleep(50);
    assert.ok(seen.some(m => m.t === "hello"), `no hello; stderr: ${stderr}`);
    const hello = seen.find(m => m.t === "hello");
    assert.equal(hello.host.id, "t");
    assert.equal(hello.host.site, "mac");
    const agent = seen.find(m => m.t === "agent" && m.agent.key === `t#omp:${ompMain.id}`);
    assert.ok(agent, `no agent message; stderr: ${stderr}`);
    assert.equal(agent.agent.title, "Fix the build");
    assert.ok(seen.some(m => m.t === "events" && m.events.some(e => e.id === "call-1")));
    // requests travel over the same channel
    assert.equal(typeof (await channel.request("ping", {})).at, "number");
    replies.push(await channel.request("file.read", { path: file }));
    assert.equal(replies[0].exists, true);
    assert.match(replies[0].content, /please fix the build/);
    assert.equal((await channel.request("file.read", { path: join(root, ".env") })).denied !== undefined, true);
    // only protocol on stdout: every line the child printed parsed as a message (the channel would have closed otherwise)
    assert.equal(channel.closed, false);
  } finally {
    child.kill("SIGTERM");
    await new Promise(resolve => child.once("exit", resolve));
  }
});

test("the bundle exits cleanly on stdin end and refuses other subcommands", async () => {
  const out = join(newDir("bundle"), "c.mjs");
  buildCollector({ out });
  const bad = spawn(process.execPath, [out, "hub"], { stdio: ["ignore", "ignore", "pipe"] });
  let message = "";
  bad.stderr.on("data", chunk => { message += chunk; });
  assert.equal(await new Promise(resolve => bad.once("exit", resolve)), 2);
  assert.match(message, /only runs the collector/);

  const child = spawn(process.execPath, [out, "--stdio", "--host-id", "t", "--site", "mac", "--no-default-roots", "--root", `omp=${newDir("omp")}`], { stdio: ["pipe", "pipe", "pipe"] });
  await sleep(400);
  child.stdin.end();
  const code = await Promise.race([new Promise(resolve => child.once("exit", resolve)), sleep(4000).then(() => "timeout")]);
  if (code === "timeout") child.kill("SIGKILL");
  assert.equal(code, 0);
});
