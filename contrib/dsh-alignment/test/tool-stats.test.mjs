// tool-stats.js: the four kinds, folding, P90 + per-log cache, the background baseline, the route.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { constants as bufferConstants } from "node:buffer";
import {
  extractCalls, timeoutKind, errorKey, anomalies, percentile, buildTable, samplesOf, scanSessions, createBaseline, toolsHandler,
  runStatsWorker, argSummary, childrenOf, subagentCalls, MIN_SAMPLES, FLOOR_MS, FLOOR_CHARS, WINDOW_DAYS, toolEventsOfFile, samplesOfLog,
  runSteps, runsHandler, stepText, stepLabel, covered,
} from "../tool-stats.js";

let seq = 0;
const call = (id, name, time, args = {}) => ({ type: "tool/call", seq: seq++, time, data: { turn: 1, step: 1, callId: id, name, arguments: JSON.stringify(args) } });
const result = (id, time, text, isError = false) => ({ type: "tool/result", seq: seq++, time, data: { turn: 1, step: 1, message: { role: "tool", source: { kind: "tool", callId: id }, toolCallId: id, content: [{ type: "text", text }], isError } } });
const innerStart = (root, sub, name, time, args = {}) => ({ type: "tool/ptc-dispatch-start", seq: seq++, time, data: { rootCallId: root, parentCallId: root, subCallId: sub, name, arguments: args } });
const innerEnd = (root, sub, name, time, text, isError = false) => ({ type: "tool/ptc-dispatch", seq: seq++, time, data: { rootCallId: root, parentCallId: root, subCallId: sub, name, isError, content: [{ type: "text", text }] } });

/** A baseline where every tool has P90 1000 ms / 1000 chars. */
function flatTable(names) {
  const files = [{ names, rows: [] }];
  names.forEach((_, i) => { for (let k = 0; k < MIN_SAMPLES; k++) files[0].rows.push([i, 1000 + k, 1000, 1000]); });
  return buildTable(files, 10_000, 7);
}

test("extractCalls pairs top-level calls and calls inside run_code; v3 tool-result blocks too", () => {
  const ev = [
    call("a", "run_code", 100, { description: "probe", code: "x".repeat(500) }),
    innerStart("a", "a:ptc:1", "pwsh", 110, { description: "ls", command: "ls" }),
    innerEnd("a", "a:ptc:1", "pwsh", 2110, "out"),
    result("a", 3000, "printed"),
    call("b", "read", 4000, { file_path: "C:/x.md" }),
    { type: "tool/result", seq: seq++, time: 4005, data: { callId: "b", message: { role: "tool", content: [{ type: "tool-result", toolCallId: "b", isError: true, content: [{ type: "text", text: "Error: nope" }] }] } } },
  ];
  const c = extractCalls(ev);
  assert.deepEqual(c.map((x) => [x.name, x.root, x.ms, x.chars, x.error]), [["pwsh", "a", 2000, null, false], ["run_code", null, 2900, 7, false], ["read", null, 5, 11, true]]);
  assert.equal(c[2].text, "Error: nope");
  assert.equal(argSummary(c[1].args), "probe");
});

test("timeoutKind: pwsh moved to background, run_code deadline, other errors that say timeout; never a plain success", () => {
  assert.equal(timeoutKind("[still running after 44957ms; moved to background job pwsh-c65a]\nThe command keeps running", false), "background");
  assert.equal(timeoutKind("Error: code run failed (timeout): execution exceeded 120000 ms", true), "deadline");
  assert.equal(timeoutKind("Error: fetch failed: ETIMEDOUT 1.2.3.4:443", true), "timeout");
  assert.equal(timeoutKind("Error: request timed out after 30s", true), "timeout");
  assert.equal(timeoutKind("the word timeout in a normal output", false), null);
  assert.equal(timeoutKind("Error: spawn pwsh.exe ENOENT", true), null);
});

test("errorKey folds the same error with other paths / quoted text / numbers", () => {
  assert.equal(errorKey('Error: cannot read "C:\\a\\b.md": not found'), errorKey('Error: cannot read "D:\\c\\d\\e.js": not found'));
  assert.equal(errorKey("Error: grep search failed (exit 2): rg: C:/Users/x/lib: IO error"), errorKey("Error: grep search failed (exit 2): rg: C:/Users/y/z/lib: IO error"));
  assert.equal(errorKey("Error: unknown job pwsh-635"), errorKey("Error: unknown job pwsh-99"));
  assert.notEqual(errorKey("Error: subagent depth 3 exceeds maxDepth 2"), errorKey("Error: unknown tool \"write\""));
});

test("anomalies: four kinds, folded, severity as ratio to P90, run_code failing only because of an inner tool is not listed twice", () => {
  const ev = [
    // two reads of different missing files -> one error group x2
    call("r1", "read", 1000, { file_path: "C:/a/b.md" }), result("r1", 1005, 'Error: cannot read "C:\\a\\b.md": not found', true),
    call("r2", "read", 2000, { file_path: "C:/c/d.md" }), result("r2", 2003, 'Error: cannot read "C:\\c\\d.md": not found', true),
    // run_code whose inner pwsh threw: only the inner error is listed
    call("rc", "run_code", 3000, { description: "x" }),
    innerStart("rc", "rc:ptc:1", "pwsh", 3010), innerEnd("rc", "rc:ptc:1", "pwsh", 3020, "Error: spawn pwsh.exe ENOENT", true),
    result("rc", 3100, "Error: code run failed (exception): ToolCallError: spawn pwsh.exe ENOENT", true),
    // run_code that failed by itself stays an error
    call("rc2", "run_code", 3200), result("rc2", 3300, "Error: code run failed (exception): TypeError: x is undefined", true),
    // pwsh moved to the background after 45 s: timeout, not slow, not error
    call("rc3", "run_code", 4000), innerStart("rc3", "rc3:ptc:1", "pwsh", 4010), innerEnd("rc3", "rc3:ptc:1", "pwsh", 49010, "[still running after 45000ms; moved to background job pwsh-1]"), result("rc3", 49100, "ok"),
    // slow: 5 s vs P90 1 s (5x); 1.5 s is above P90 but under the floor
    call("g1", "grep", 50000), result("g1", 55000, "x"),
    call("g2", "grep", 56000), result("g2", 57500, "x"),
    // big: a top-level read of 9000 chars (9x); an inner read of the same size does not count
    call("b1", "read", 60000), result("b1", 60010, "y".repeat(9000)),
    call("rc4", "run_code", 61000), innerStart("rc4", "rc4:ptc:1", "read", 61010), innerEnd("rc4", "rc4:ptc:1", "read", 61020, "y".repeat(9000)), result("rc4", 61100, "short"),
  ];
  const a = anomalies(extractCalls(ev), flatTable(["read", "run_code", "pwsh", "grep"]));
  const sum = (k) => a.groups[k].map((g) => g.tool + "x" + g.count);
  assert.deepEqual(sum("error"), ["read" + "x2", "pwshx1", "run_codex1"]);
  assert.match(a.groups.error[2].label, /TypeError/);
  assert.deepEqual(sum("timeout"), ["pwshx1"]);
  assert.equal(a.groups.timeout[0].label, "background");
  // the run_code that waited 45 s for the background pwsh is slow itself; grep 1.5 s is under FLOOR_MS
  assert.deepEqual(sum("slow"), ["run_codex1", "grepx1"]);
  assert.ok(FLOOR_MS > 1500);
  const grep = a.groups.slow.find((g) => g.tool === "grep");
  assert.equal(grep.count, 1);
  assert.equal(grep.worst, 5);
  assert.ok(!a.groups.slow.some((g) => g.tool === "pwsh"), "the background pwsh is a timeout, not slow");
  assert.deepEqual(sum("big"), ["readx1"]);
  assert.equal(a.groups.big[0].worst, 9);
  assert.equal(a.groups.big[0].items[0].p90, 1000);
  // range: only calls started inside [from, to]
  const r = anomalies(extractCalls(ev), flatTable(["read", "run_code", "pwsh", "grep"]), { from: 50000, to: 70000 });
  assert.deepEqual(r.groups.error, []);
  assert.equal(r.calls, 5);
});

test("no baseline -> errors and timeouts only; a tool under MIN_SAMPLES has no P90", () => {
  const ev = [call("g", "grep", 0), result("g", 60000, "x"), call("e", "edit", 1), result("e", 2, "Error: file has not been read", true)];
  const a = anomalies(extractCalls(ev), null);
  assert.equal(a.groups.error.length, 1);
  assert.deepEqual(a.groups.slow, []);
  const t = buildTable([{ names: ["grep"], rows: Array.from({ length: MIN_SAMPLES - 1 }, (_, k) => [0, 5000 + k, 10, 10]) }], 10_000, 7);
  assert.equal(t.tools.grep.ms, null);
});

test("percentile is nearest rank; buildTable keeps calls started in the window and skips -1 samples", () => {
  assert.equal(percentile([5, 1, 4, 2, 3, 10, 9, 8, 7, 6], 0.9), 9);
  assert.equal(percentile([1], 0.9), 1);
  assert.equal(percentile([], 0.9), null);
  const now = 100 * 864e5;
  const rows = [];
  for (let k = 1; k <= 30; k++) rows.push([0, now - 864e5, k * 100, -1]);
  rows.push([0, now - 8 * 864e5, 999999, 5]); // outside 7 days
  const t = buildTable([{ names: ["pwsh"], rows }], now, 7);
  assert.deepEqual(t.tools.pwsh.ms, { p90: 2700, n: 30 });
  assert.equal(t.tools.pwsh.chars, null);
  // samplesOf: timeouts and waiting tools have no duration sample, inner calls no size sample
  const s = samplesOf(extractCalls([call("j", "job_output", 0), result("j", 90000, "done"), innerStart("x", "x:1", "pwsh", 0), innerEnd("x", "x:1", "pwsh", 45000, "[still running after 45000ms; moved to background job p]")]));
  assert.deepEqual(s.rows, [[0, 0, -1, 4], [1, 0, -1, -1]]);
});

// ---- logs on disk ----
const frames = (lines) => Buffer.concat(lines.map((l) => zstdCompressSync(Buffer.from(l + "\n"))));
function writeLog(root, sid, events, mtime) {
  const dir = join(root, "--proj--", sid);
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "session.v4.jsonl.zstd");
  writeFileSync(f, frames([JSON.stringify({ type: "session", id: sid }), ...events.map((e) => JSON.stringify(e))]));
  if (mtime) utimesSync(f, mtime / 1000, mtime / 1000);
  return f;
}
const grepCalls = (n, ms, t0) => Array.from({ length: n }, (_, k) => [call("c" + t0 + k, "grep", t0 + k * 10), result("c" + t0 + k, t0 + k * 10 + ms, "z")]).flat();

test("scanSessions: P90 from the logs, then only changed logs are parsed again; logs older than the window drop out", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "tool-stats-")));
  try {
    const now = Date.now();
    const cacheFile = join(root, "cache", "c.json");
    const sessions = join(root, "sessions");
    writeLog(sessions, "session-a", grepCalls(20, 100, now - 3600e3));
    const fb = writeLog(sessions, "session-b", grepCalls(10, 900, now - 3000e3));
    writeLog(sessions, "session-old", grepCalls(30, 99999, now - 31 * 864e5), now - 31 * 864e5);
    const a = scanSessions({ root: sessions, cacheFile, now });
    assert.deepEqual(a.stats.logs, 2);
    assert.equal(a.stats.parsed, 2);
    assert.deepEqual(a.table.tools.grep.ms, { p90: 900, n: 30 });
    const b = scanSessions({ root: sessions, cacheFile, now });
    assert.deepEqual([b.stats.parsed, b.stats.reused], [0, 2]);
    writeFileSync(fb, frames(grepCalls(10, 50, now - 3000e3).map((e) => JSON.stringify(e))));
    const c = scanSessions({ root: sessions, cacheFile, now });
    assert.deepEqual([c.stats.parsed, c.stats.reused], [1, 1]);
    assert.equal(c.table.tools.grep.ms.p90, 100);
    assert.equal(Object.keys(JSON.parse(readFileSync(cacheFile, "utf8")).files).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the baseline window is the last 30 days: a log from 20 days ago counts, one from 31 days ago does not (2026-10-24, was 7)", () => {
  assert.equal(WINDOW_DAYS, 30);
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "tool-stats-")));
  try {
    const now = Date.now();
    // 20 calls of 100 ms today; 20 days ago (inside 30 days, outside the old 7): 20 calls of 5 s; 31 days ago: 20 of 60 s
    writeLog(root, "session-now", grepCalls(20, 100, now - 3600e3));
    writeLog(root, "session-20d", grepCalls(20, 5000, now - 20 * 864e5), now - 20 * 864e5 + 3600e3);
    writeLog(root, "session-31d", grepCalls(20, 60000, now - 31 * 864e5), now - 31 * 864e5 + 3600e3);
    const a = scanSessions({ root, now });
    assert.equal(a.table.windowDays, 30);
    assert.equal(a.table.from, now - 30 * 864e5);
    assert.equal(a.stats.logs, 2, "the 31-day-old log is not read");
    assert.deepEqual(a.table.tools.grep.ms, { p90: 5000, n: 40 });
    // a call started before the window in a log written inside it is left out too
    const t = buildTable([{ names: ["grep"], rows: [...Array.from({ length: 20 }, (_, k) => [0, now - 29 * 864e5 + k, 300, -1]), [0, now - 30 * 864e5 - 1, 999999, -1]] }], now);
    assert.deepEqual(t.tools.grep.ms, { p90: 300, n: 20 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("logs are read as a stream: every frame of a multi-frame log, frame magic bytes inside the data, an empty file, a line across frames; a cut-off or damaged frame throws with the file", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "tool-stats-")));
  try {
    const file = join(root, "log.jsonl.zstd");
    const evs = Array.from({ length: 300 }, (_, k) => ({ type: "tool/call", seq: k, data: { note: k % 7 ? "x" : "\u0028\u00b5\u002f\u00fd" + k } }));
    const buf = frames(evs.map((e) => JSON.stringify(e)));
    writeFileSync(file, buf);
    assert.deepEqual(toolEventsOfFile(file), evs);
    assert.deepEqual(toolEventsOfFile(file, { chunkBytes: 7, outBytes: 1 }), evs, "small read chunks and decode batches");
    // raw magic bytes stored in a frame (incompressible payload) do not split it; a line cut by a flush joins up again
    const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
    const line = '{"type":"tool/call","m":"a' + magic.toString("latin1") + 'b"}\n';
    const raw = Buffer.from(line, "latin1");
    writeFileSync(file, Buffer.concat([zstdCompressSync(raw.subarray(0, 20), { params: { 100: 1 } }), zstdCompressSync(raw.subarray(20))]));
    const one = toolEventsOfFile(file);
    assert.equal(one.length, 1, "one line, not split at the magic bytes or the frame cut");
    assert.equal(Buffer.from(one[0].m, "utf8").length, Buffer.from("a" + magic.toString("utf8") + "b", "utf8").length);
    writeFileSync(file, Buffer.alloc(0));
    assert.deepEqual(toolEventsOfFile(file), []);
    // cut-off last frame, damaged middle: the scan names the log
    const sessions = join(root, "sessions");
    const cut = writeLog(sessions, "session-cut", grepCalls(20, 100, Date.now() - 3600e3));
    const good = readFileSync(cut);
    writeFileSync(cut, good.subarray(0, -3));
    assert.throws(() => scanSessions({ root: sessions }), (e) => e.message.includes("session-cut") && /last zstd frame incomplete/.test(e.message));
    writeFileSync(cut, Buffer.concat([good.subarray(0, 40), Buffer.from("garbage!"), good.subarray(40)]));
    assert.throws(() => scanSessions({ root: sessions }), (e) => e.message.includes("session-cut"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a log with more text than one string can hold is scanned (2026-11-16: the Curio log, 608 MB of jsonl, ERR_STRING_TOO_LONG)", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "tool-stats-")));
  try {
    const now = Date.now(), t0 = now - 3600e3;
    // 20 grep calls of 300 ms, then one 4 MB tool result line repeated past the longest possible string (~60 KB on disk),
    // then 20 more calls: the calls after the bulk count too
    const f = writeLog(root, "session-big", grepCalls(20, 300, t0));
    const bulkLine = Buffer.from(JSON.stringify({ type: "user/message", seq: 0, time: t0, data: { text: "x".repeat(4 << 20) } }) + "\n");
    const copies = Math.ceil((bufferConstants.MAX_STRING_LENGTH + 1) / bulkLine.length);
    const bulk = zstdCompressSync(bulkLine);
    const tail = Buffer.concat(grepCalls(20, 300, t0 + 1e6).map((e) => zstdCompressSync(Buffer.from(JSON.stringify(e) + "\n"))));
    writeFileSync(f, Buffer.concat([readFileSync(f), ...Array(copies).fill(bulk), tail]));
    assert.ok(copies * bulkLine.length > bufferConstants.MAX_STRING_LENGTH);
    assert.equal(samplesOfLog(f).rows.length, 40);
    const a = scanSessions({ root, now });
    assert.deepEqual([a.stats.parsed, a.table.tools.grep.ms], [1, { p90: 300, n: 40 }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("scanSessions fails loud when many logs carry no tool events (log line shape changed)", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "tool-stats-")));
  try {
    for (let k = 0; k < 20; k++) writeLog(root, "session-" + k, [{ type: "turn/start", seq: 1, time: 1, data: { turn: 1 } }]);
    assert.throws(() => scanSessions({ root }), /no tool events/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runStatsWorker builds the same table off the main thread", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "tool-stats-")));
  try {
    writeLog(root, "session-w", grepCalls(25, 300, Date.now() - 1000e3));
    const r = await runStatsWorker({ root, cacheFile: join(root, "c.json"), windowDays: WINDOW_DAYS });
    assert.equal(r.table.tools.grep.ms.p90, 300);
    await assert.rejects(runStatsWorker({ root: join(root, "missing") }), /ENOENT/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("createBaseline: one build at a time, rebuilt after refreshMs, a failed build is reported and retried", async () => {
  let clock = 0, builds = 0, fail = false;
  const b = createBaseline({ now: () => clock, refreshMs: 1000, build: async () => { builds++; if (fail) throw new Error("boom"); return { table: { builtAt: clock, tools: {} }, stats: {} }; } });
  assert.equal(b.table(), null);
  const p = b.refresh();
  assert.equal(b.refresh(), p, "a second refresh joins the running build");
  await p;
  assert.equal(builds, 1);
  assert.equal(b.refresh(), null, "fresh table: no build");
  clock = 1500;
  fail = true;
  await b.refresh();
  assert.equal(b.error(), "boom");
  assert.equal(b.table().builtAt, 0, "the old table stays");
  fail = false;
  await b.refresh();
  assert.equal(b.error(), null);
  assert.equal(builds, 3);
});

test("toolsHandler: guard, bad sid / time, fork events filtered, baseline refreshed but not awaited", async () => {
  const ev = [call("x", "edit", 0), result("x", 1, "Error: parent's error", true), call("y", "edit", 10), result("y", 11, "Error: cannot modify: file has not been read", true)].map((e, i) => ({ ...e, seq: i }));
  let refreshed = 0;
  const baseline = { refresh: () => { refreshed++; return new Promise(() => {}); }, table: () => null, error: () => null };
  const h = toolsHandler({ readSessionState: async () => ({ events: ev, inheritedEventCount: 2 }), baseline, guard: (req) => (req.headers.cookie ? null : { code: 401, message: "登录" }) });
  const run = async (url, cookie = "c") => {
    let code, body;
    await h({ url, method: "GET", headers: cookie ? { cookie } : {} }, { writeHead: (c) => { code = c; }, end: (b) => { body = JSON.parse(b); } });
    return { code, body };
  };
  assert.equal((await run("/alignment/tools?sid=session-1", null)).code, 401);
  assert.equal((await run("/alignment/tools?sid=")).code, 400);
  assert.equal((await run("/alignment/tools?sid=session-1&from=nope")).code, 400);
  const ok = await run("/alignment/tools?sid=session-1");
  assert.equal(ok.code, 200);
  assert.equal(ok.body.calls, 1);
  assert.equal(ok.body.baseline, null);
  assert.deepEqual(ok.body.groups.error.map((g) => g.count), [1]);
  assert.match(ok.body.groups.error[0].label, /has not been read/);
  assert.ok(refreshed >= 1);
});


// ---- subagents (api 2) ----
const catalog = (childId, label) => ({ type: "subagent/catalog", seq: seq++, time: 1, data: { version: 0, childId, childCreatedAt: 1, mode: "continuable", label } });

test("childrenOf: one entry per child from subagent/catalog, latest label", () => {
  assert.deepEqual(childrenOf([catalog("k1", "甲"), call("x", "read", 1), catalog("k2", "乙"), catalog("k1", "甲二")]), [{ sid: "k1", label: "甲二" }, { sid: "k2", label: "乙" }]);
  assert.throws(() => childrenOf([{ type: "subagent/catalog", seq: 1, time: 1, data: {} }]), /childId/);
});

test("subagentCalls walks children and grandchildren, tags each call, reports an unreadable child", async () => {
  const logs = {
    k1: [catalog("g1", "孙"), call("a", "edit", 10), result("a", 11, "Error: file has not been read", true)],
    g1: [call("b", "grep", 20), result("b", 9000, "x")],
    k2: null, // unreadable
  };
  const read = async (sid) => { if (!logs[sid]) throw new Error("unknown session " + sid); return { events: logs[sid], inheritedEventCount: 0 }; };
  const s = await subagentCalls([catalog("k1", "子一"), catalog("k2", "子二")], read);
  assert.deepEqual(s.agents.map((a) => [a.sid, a.label, a.depth, a.calls ?? a.error]), [["k1", "子一", 1, 1], ["k2", "子二", 1, "unknown session k2"], ["g1", "孙", 2, 1]]);
  assert.deepEqual(s.calls.map((c) => [c.name, c.agent.sid]), [["edit", "k1"], ["grep", "g1"]]);
});

test("anomalies count subagent calls per group (sub) and order slow / big groups by their worst ratio", () => {
  const own = extractCalls([call("o1", "edit", 1), result("o1", 2, "Error: file has not been read", true), call("g", "grep", 10), result("g", 3010, "x"), call("r", "read", 20), result("r", 5020, "x")]);
  const kid = extractCalls([call("k1", "edit", 30), result("k1", 31, "Error: file has not been read", true), call("k2", "read", 40), result("k2", 2540, "x"), call("k3", "read", 50), result("k3", 2550, "x")]).map((c) => ({ ...c, agent: { sid: "kid", label: "子" } }));
  const a = anomalies([...own, ...kid], flatTable(["edit", "grep", "read"]));
  assert.deepEqual(a.groups.error.map((g) => [g.tool, g.count, g.sub]), [["edit", 2, 1]]);
  assert.deepEqual(a.groups.error[0].items.map((x) => x.agent && x.agent.label), [null, "子"]);
  // read: 3 calls, worst 5x; grep: 1 call, worst 3x -> read first by ratio; within read the 5x item first
  assert.deepEqual(a.groups.slow.map((g) => [g.tool, g.count, g.sub, g.worst]), [["read", 3, 2, 5], ["grep", 1, 0, 3]]);
  assert.equal(a.groups.slow[0].items[0].ratio, 5);
  assert.equal(a.subCalls, 3);
  // one grep at 9x beats three reads with worst 5x
  const b = anomalies([...own, ...kid, ...extractCalls([call("g2", "grep", 60), result("g2", 9060, "x")])], flatTable(["edit", "grep", "read"]));
  assert.deepEqual(b.groups.slow.map((g) => g.tool), ["grep", "read"]);
});

test("toolsHandler: without sub only the session's own calls (and how many subagents it has); sub=1 adds them", async () => {
  const own = [catalog("kid", "子任务"), call("x", "edit", 10), result("x", 11, "Error: file has not been read", true)].map((e, i) => ({ ...e, seq: i }));
  const kid = [call("y", "edit", 20), result("y", 21, "Error: file has not been read", true), call("z", "read", 22), result("z", 23, "ok")].map((e, i) => ({ ...e, seq: i }));
  const reads = [];
  const h = toolsHandler({ readSessionState: async (sid) => { reads.push(sid); return { events: sid === "session-p" ? own : kid, inheritedEventCount: 0 }; }, baseline: { refresh: () => null, table: () => null, error: () => null }, guard: () => null });
  const run = async (url) => { let body; await h({ url, method: "GET", headers: {} }, { writeHead: () => {}, end: (b) => { body = JSON.parse(b); } }); return body; };
  const a = await run("/alignment/tools?sid=session-p");
  assert.deepEqual([a.calls, a.subagents, a.subCalls, a.agents, reads], [1, 1, undefined, undefined, ["session-p"]]);
  assert.deepEqual(a.groups.error.map((g) => [g.count, g.sub]), [[1, 0]]);
  const b = await run("/alignment/tools?sid=session-p&sub=1");
  assert.deepEqual([b.calls, b.subCalls, b.agents.map((x) => [x.sid, x.label, x.calls])], [1, 2, [["kid", "子任务", 2]]]);
  assert.deepEqual(b.groups.error.map((g) => [g.count, g.sub]), [[2, 1]]);
});

// ---- run_code steps (GET /alignment/tools/runs) ----
const fixture = readFileSync(new URL("./fixtures/run-steps.jsonl", import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("runSteps on real logs: each inner call in order, what it did, its time; the slow / failing one stands alone", () => {
  // recorded log of one run_code call — four greps, the one over ~/.claude took 15 s and failed
  const a = runSteps(fixture, "toolu_bdrk_01FHe1Zc4UC4g5M6akxT1ATc");
  assert.equal(a.description, "Show code-level tv references");
  assert.equal(a.ms, 16062);
  assert.equal(a.calls, 4);
  assert.deepEqual(a.steps.map((s) => [s.tool, s.texts, s.n, s.ms, s.errors]), [
    ["grep", ["搜 tv\\.py|transcript-viewer|transcript_viewer，范围 ~/.dsh-wt/threads-search"], 1, 410, 0],
    ["grep", ["搜 tv\\.py|transcript-viewer，范围 ~/.claude"], 1, 14725, 1],
    ["grep", ["搜 tv\\.py|transcript-viewer，范围 ~/.codex/AGENTS.md", "搜 tv\\.py|transcript-viewer，范围 D:/fm-home"], 2, 547, 0],
  ]);
  assert.equal(a.steps[2].label, "搜 tv\\.py|transcript-viewer，范围 ~/.codex/AGENTS.md、D:/fm-home", "one pattern over two paths reads as one line");
  assert.match(a.steps[1].errorText, /^Error: grep produced more raw output/);
  assert.equal(a.steps[0].chars, 41587, "the most returned text keeps its own step");
  assert.equal(a.gap, 380);
  assert.equal(a.code.length, a.codeChars);
  // a second recorded run: a 1 s commit, then 9 min waiting for the verify job (named by what started it)
  const b = runSteps(fixture, "toolu_01T7KTC9nqaxrcCvherBLiQ8");
  assert.equal(b.description, "Commit probe and wait for verify");
  assert.deepEqual(b.steps.map((s) => [s.tool, s.texts[0], s.ms]), [
    ["pwsh", "Commit live probe", 1129],
    ["job_output", "等后台任务「Run full dsh-verify in worktree」结束", 540118],
  ]);
  assert.match(b.steps[0].hint, /^git add scripts\/tests\/probe-workflow-ptc-live\.mjs; git commit/);
  assert.equal(runSteps(fixture, "no-such-call"), null);
});

test("runSteps folds adjacent calls of one tool (× n, covered time), never across another tool", () => {
  const ev = [
    call("q", "run_code", 0, { description: "read three, grep, read two", code: "…" }),
    innerStart("q", "q:1", "read", 10, { file_path: "C:/Users/me/a.md" }), innerStart("q", "q:2", "read", 10, { file_path: "C:/Users/me/b.md", offset: 5, limit: 10 }), innerStart("q", "q:3", "read", 10, { file_path: "C:/Users/me/a.md" }),
    innerEnd("q", "q:1", "read", 110, "aa"), innerEnd("q", "q:2", "read", 210, "bbb"), innerEnd("q", "q:3", "read", 160, "c"),
    innerStart("q", "q:4", "grep", 300, { pattern: "x", path: "D:/w" }), innerEnd("q", "q:4", "grep", 5300, "hit"),
    innerStart("q", "q:5", "read", 5400, { file_path: "C:/Users/me/c.md" }), innerEnd("q", "q:5", "read", 5500, "1"),
    innerStart("q", "q:6", "read", 5600, { file_path: "C:/Users/me/c.md" }), innerEnd("q", "q:6", "read", 5700, "2"),
    result("q", 6000, "done"),
  ];
  const r = runSteps(ev, "q");
  assert.deepEqual(r.steps.map((s) => [s.tool, s.texts, s.distinct, s.n, s.ms, s.chars]), [
    ["read", ["读 ~/a.md", "读 ~/b.md 第 5–14 行"], 2, 3, 200, 6],
    ["grep", ["搜 x，范围 D:/w"], 1, 1, 5000, 3],
    ["read", ["读 ~/c.md"], 1, 2, 200, 2],
  ]);
  assert.equal(r.gap, 6000 - 200 - 5000 - 200);
  assert.deepEqual(r.steps.map((x) => x.label), ["读 ~/a.md、~/b.md", "搜 x，范围 D:/w", "读 ~/c.md"]);
  assert.equal(covered([[0, 10], [5, 20], [30, 40]]), 30);
});

test("runSteps shows no time it cannot read from the log; a call without a result is open", () => {
  const ev = [
    call("q", "run_code", 0, { description: "lost start", code: "…" }),
    { type: "tool/ptc-dispatch", seq: seq++, time: 500, data: { rootCallId: "q", parentCallId: "q:0", subCallId: "q:0:1", name: "read", arguments: {}, isError: false, content: [] } }, // someone else's
    { type: "tool/ptc-dispatch", seq: seq++, time: 500, data: { rootCallId: "q", parentCallId: "q", subCallId: "q:1", name: "read", arguments: { file_path: "D:/a.md" }, isError: false, content: [{ type: "text", text: "x" }] } }, // start event missing
    innerStart("q", "q:2", "pwsh", 600, { command: "ls" }), innerEnd("q", "q:2", "pwsh", 700, "ok"),
    innerStart("q", "q:3", "pwsh", 800, { command: "sleep 600" }),        // never returned: the run hit its deadline
    result("q", 120_000, "Error: code run failed (timeout): execution exceeded 120000 ms", true),
  ];
  const r = runSteps(ev, "q");
  assert.deepEqual(r.steps.map((s) => [s.texts[0], s.ms, s.open]), [["读 D:/a.md", null, false], ["ls", 100, false], ["sleep 600", null, true]]);
  assert.equal(r.timeout, "deadline");
  assert.equal(r.gap, null, "unknown when a call's time is missing");
  // a nested call (made inside a tool the program called) is not one of the program's steps
  const nested = [...ev, { type: "tool/ptc-dispatch-start", seq: seq++, time: 900, data: { rootCallId: "q", parentCallId: "q:3", subCallId: "q:3:1", name: "read", arguments: {} } }];
  assert.equal(runSteps(nested, "q").steps.length, 3);
});

test("stepText: tool-specific wording, home folded to ~, long pwsh commands by their description", () => {
  assert.equal(stepText("grep", { pattern: "a|b", path: "C:\\Users\\me\\.dsh", include: "*.js" }), "搜 a|b，范围 ~/.dsh，只看 *.js");
  assert.equal(stepText("read", { file_path: "C:/Users/me/x.md", offset: 1, limit: 80 }), "读 ~/x.md 第 1–80 行");
  assert.equal(stepText("pwsh", { command: "git rebase master", description: "Rebase" }), "git rebase master");
  assert.equal(stepText("pwsh", { command: "x".repeat(61), description: "Long one" }), "Long one");
  assert.equal(stepText("job_output", { job_id: "pwsh-1", wait: true }), "等后台任务 pwsh-1 结束");
  assert.equal(stepText("job_output", { job_id: "pwsh-1" }, () => "Run tests"), "取后台任务「Run tests」的输出");
  assert.equal(stepText("hindsight_reflect", { query: "why" }), "why");
  assert.equal(stepLabel("read", ["a", "b", "c", "d", "a"].map((f) => ({ file_path: "D:/" + f })), ["x", "y"]), "读 D:/a、D:/b、D:/c 等");
});

test("runsHandler: guard, bad ids, fork events filtered, unknown id -> null", async () => {
  const ev = fixture.map((e, i) => ({ ...e, seq: i + 1 }));
  const h = runsHandler({ readSessionState: async (sid) => ({ events: [{ type: "tool/call", seq: 0, time: 0, data: { callId: "inherited", name: "run_code", arguments: "{}" } }, ...ev], inheritedEventCount: 1 }), guard: (req) => (req.headers.bad ? { code: 403, message: "no" } : null) });
  const hit = async (url, headers = {}) => { let code, body; await h({ method: "GET", url, headers }, { writeHead: (c) => { code = c; }, end: (b) => { body = JSON.parse(b); } }); return { code, body }; };
  assert.equal((await hit("/alignment/tools/runs?sid=s&ids=a", { bad: 1 })).code, 403);
  assert.equal((await hit("/alignment/tools/runs?sid=s")).code, 400);
  assert.equal((await hit("/alignment/tools/runs?sid=s&ids=a%20b")).code, 400);
  const ok = await hit("/alignment/tools/runs?sid=s&ids=toolu_01T7KTC9nqaxrcCvherBLiQ8,inherited");
  assert.equal(ok.code, 200);
  assert.equal(ok.body.runs.toolu_01T7KTC9nqaxrcCvherBLiQ8.steps.length, 2);
  assert.equal(ok.body.runs.inherited, null, "a forked session's inherited calls are not its own");
});
