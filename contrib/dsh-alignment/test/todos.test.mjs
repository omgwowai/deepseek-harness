import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTodoIndex, matchTexts, MAX_SIDS, mergeSpans, minusSpans, parseSids, TODOS_API, todosHandler, TodosRequestError } from "../todos.js";

const T0 = 1_700_000_000_000;
const ev = (seq, type, data, time = T0 + seq) => ({ seq, type, data, time });
const iso = (seq) => new Date(T0 + seq).toISOString();
const write = (seq, todos) => ev(seq, "todo/write", { todos: todos.map(([content, status]) => ({ content, status })) });
// the host lists nothing running (workspace/session-activity): every unclosed subagent turn / job in the logs is dead
const idle = async () => ({ subagent: new Set(), job: new Set() });

test("lastTurn (api 5): how the last turn ended, null while a turn runs, before any turn, or when a restart cut it", async () => {
  const log = { s: [ev(1, "turn/start", { turn: 1 }), ev(2, "turn/end", { turn: 1, reason: { kind: "completed" } }, T0 + 50)] };
  const index = createTodoIndex({ readSessionState: async (sid) => ({ inheritedEventCount: 0, events: log[sid] ?? [] }), isRunning: () => false, running: idle });
  assert.deepEqual(await index.lastTurn("s"), { at: T0 + 50, kind: "completed" });
  index.observe("s", ev(3, "turn/start", { turn: 2 }));
  assert.equal(await index.lastTurn("s"), null, "a turn runs");
  index.observe("s", ev(4, "turn/end", { turn: 2, reason: { kind: "error" } }, T0 + 90));
  assert.deepEqual(await index.lastTurn("s"), { at: T0 + 90, kind: "error" });
  assert.equal(await index.lastTurn("empty"), null, "no turn yet");
  log.cut = [ev(1, "turn/start", { turn: 1 })];
  assert.equal(await index.lastTurn("cut"), null, "a turn without its turn/end (cut by a restart)");
  const res = { code: 0, body: null, writeHead(c) { this.code = c; }, end(b) { this.body = JSON.parse(b); } };
  await todosHandler({ index, guard: () => null })({ method: "GET", url: "/alignment/todos?sids=s,empty" }, res);
  assert.deepEqual([res.code, res.body.api, res.body.ended], [200, 5, { s: { at: T0 + 90, kind: "error" }, empty: null }]);
});

test("parseSids: trims, drops empty and duplicate ids, caps the count", () => {
  assert.deepEqual(parseSids(" a,,b , a,"), ["a", "b"]);
  assert.deepEqual(parseSids(null), []);
  assert.throws(() => parseSids(Array.from({ length: MAX_SIDS + 1 }, (_, i) => "s" + i).join(",")), TodosRequestError);
});

test("view: scan once, then live events; an event seen during the first scan is not lost", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const reads = [];
  const index = createTodoIndex({
    readSessionState: async (sid) => { reads.push(sid); await gate; return { inheritedEventCount: 0, events: [ev(1, "turn/start", { turn: 1 }), write(2, [["a [ETA 8m/20m]", "in_progress"]])] }; },
    isRunning: () => true, running: idle,
  });
  const pending = index.view("s1");
  index.observe("s1", ev(3, "turn/start", { turn: 2 }));
  index.observe("s1", write(4, [["a [ETA 8m/20m]", "completed"], ["b", "pending"]]));
  release();
  const v = await pending;
  assert.deepEqual(v.items.map(({ text, status, eta }) => ({ text, status, eta })), [{ text: "a", status: "completed", eta: { p50: 480, p75: 1200 } }, { text: "b", status: "pending", eta: null }]);
  assert.deepEqual([v.items[0].startedAt, v.items[0].completedAt], [iso(2), iso(4)], "buffered live event replayed after the scan");
  assert.deepEqual([v.turn, v.latestTurn, v.done, v.total, v.running], [2, 2, 1, 2, true]);
  index.observe("s1", write(5, [["a [ETA 8m/20m]", "completed"], ["b", "completed"]]));
  const v2 = await index.view("s1");
  assert.equal(v2.done, 2);
  assert.notEqual(v2.rev, v.rev);
  assert.deepEqual(reads, ["s1"], "scanned once");
});

test("view: a fork's inherited events are not its todolist", async () => {
  const index = createTodoIndex({ readSessionState: async () => ({ inheritedEventCount: 3, events: [ev(1, "turn/start", { turn: 1 }), write(2, [["parent", "in_progress"]]), ev(3, "turn/start", { turn: 2 })] }), isRunning: () => false, running: idle });
  const v = await index.view("fork");
  assert.equal(v, null);
});

test("view: null without a todolist; malformed host shapes throw", async () => {
  const index = createTodoIndex({ readSessionState: async () => ({ inheritedEventCount: 0, events: [ev(1, "turn/start", { turn: 1 })] }), isRunning: () => false, running: idle });
  assert.equal(await index.view("s"), null);
  index.observe("other", write(9, [["x", "pending"]]));
  index.observe("s", { seq: 2, type: "todo/write", data: {} });
  await assert.rejects(index.view("s"), /todo\/write without todos/, "a bad live event surfaces on the next read");
  const bad = createTodoIndex({ readSessionState: async () => ({}), isRunning: () => false, running: idle });
  await assert.rejects(bad.view("s"), /no events/);
});

const MIN = 60_000;
const at = (m) => T0 + m * MIN;
const w = (seq, minute, todos) => ({ ...write(seq, todos), time: at(minute) });
const turn = (seq, minute, kind, n) => ({ seq, type: kind === "start" ? "turn/start" : "turn/end", data: kind === "start" ? { turn: n } : { turn: n, reason: { kind: "completed" } }, time: at(minute) });
const pick = (v) => Object.fromEntries(v.items.map((i) => [i.text, i]));

test("item timing: status changes between writes become in_progress spans; actual time counts only inside turns", async () => {
  let now = at(30);
  const index = createTodoIndex({
    readSessionState: async () => ({ inheritedEventCount: 0, events: [
      turn(1, 0, "start", 1),
      w(2, 0, [["a [ETA 5m/10m]", "in_progress"], ["b", "pending"], ["c", "pending"], ["d", "pending"], ["e", "pending"]]),
      w(3, 4, [["a [ETA 5m/10m]", "completed"], ["b", "in_progress"], ["c", "pending"], ["d", "pending"], ["e", "pending"]]),
      turn(4, 6, "end", 1), // waiting for the user from minute 6 to 16: b is in_progress but the session is not running
      turn(5, 16, "start", 2),
      w(6, 18, [["a [ETA 5m/10m]", "completed"], ["b", "completed"], ["c", "pending"], ["d", "completed"], ["e", "completed"]]),
      w(7, 20, [["a [ETA 5m/10m]", "completed"], ["b", "completed"], ["c", "in_progress"], ["d", "completed"], ["e", "completed"]]),
      w(8, 22, [["a [ETA 5m/10m]", "completed"], ["b", "completed"], ["c", "pending"], ["d", "completed"], ["e", "completed"]]),
      w(9, 25, [["a [ETA 5m/10m]", "completed"], ["b", "completed"], ["c", "in_progress"], ["d", "completed"], ["e", "completed"]]),
    ] }),
    isRunning: () => true, running: idle, now: () => now,
  });
  const v = await index.view("s"), by = pick(v);
  assert.deepEqual([by.a.startedAt, by.a.completedAt, by.a.elapsedMs, by.a.spans, by.a.approx], [new Date(at(0)).toISOString(), new Date(at(4)).toISOString(), 4 * MIN, [[at(0), at(4)]], false], "in_progress -> completed");
  assert.deepEqual([by.b.spans, by.b.elapsedMs], [[[at(4), at(18)]], 4 * MIN], "the 10 minutes outside a turn don't count (2 before the wait + 2 after)");
  assert.deepEqual([by.d.spans, by.e.spans, by.d.approx, by.e.approx], [[[at(4), at(11)]], [[at(11), at(18)]], true, true], "two items pending -> completed in one write share the stretch since the previous write");
  assert.equal(by.d.elapsedMs, 2 * MIN, "…and only its in-turn part counts");
  assert.deepEqual([by.c.spans, by.c.status, by.c.completedAt, by.c.elapsedMs], [[[at(20), at(22)], [at(25), null]], "in_progress", null, 7 * MIN], "paused back to pending closes the span; resuming opens a new one; open span runs to now");
  now = at(31);
  const v2 = await index.view("s");
  assert.equal(pick(v2).c.elapsedMs, 8 * MIN);
  assert.equal(v2.rev, v.rev, "elapsedMs ticking does not change rev");
  now = at(33);
  index.observe("s", w(10, 32, [["a [ETA 5m/10m]", "completed"], ["b", "completed"], ["c", "completed"], ["d", "completed"], ["e", "completed"]]));
  const v3 = await index.view("s");
  assert.notEqual(v3.rev, v.rev);
  assert.deepEqual([pick(v3).c.elapsedMs, pick(v3).c.completedAt], [9 * MIN, new Date(at(32)).toISOString()]);
});

test("item timing: the first write has no earlier one, so an item already completed there has no actual time", async () => {
  const index = createTodoIndex({ readSessionState: async () => ({ inheritedEventCount: 0, events: [turn(1, 0, "start", 1), w(2, 1, [["x", "completed"], ["y", "pending"]])] }), isRunning: () => true, running: idle, now: () => at(5) });
  const by = pick(await index.view("s"));
  assert.deepEqual([by.x.startedAt, by.x.completedAt, by.x.elapsedMs, by.x.spans], [null, new Date(at(1)).toISOString(), null, []]);
  assert.deepEqual([by.y.startedAt, by.y.elapsedMs], [null, null], "not started: no actual time");
});

test("item timing: a slightly edited text is still the same item; a different one is new", async () => {
  const index = createTodoIndex({
    readSessionState: async () => ({ inheritedEventCount: 0, events: [
      turn(1, 0, "start", 1),
      w(2, 0, [["改插件核心逻辑 [ETA 8m/20m]", "in_progress"], ["跑门禁 [ETA 3m/9m]", "pending"], ["写文档", "pending"]]),
      w(3, 5, [["改插件核心逻辑（todos.js） [ETA 10m/25m]", "completed"], ["跑 dsh-verify 门禁 [ETA 3m/9m]", "in_progress"], ["写测试", "pending"]]),
      w(4, 7, [["改插件核心逻辑（todos.js） [ETA 10m/25m]", "completed"], ["跑 DSH-Verify 门禁。", "in_progress"], ["写测试", "pending"]]),
    ] }),
    isRunning: () => true, running: idle, now: () => at(9),
  });
  const by = pick(await index.view("s"));
  assert.deepEqual([by["改插件核心逻辑（todos.js）"].elapsedMs, by["改插件核心逻辑（todos.js）"].eta], [5 * MIN, { p50: 600, p75: 1500 }], "words added, ETA changed: same item, newest ETA");
  assert.deepEqual([by["跑 DSH-Verify 门禁。"].startedAt, by["跑 DSH-Verify 门禁。"].elapsedMs], [new Date(at(5)).toISOString(), 4 * MIN], "words inserted, then case / punctuation changed: still the same item");
  assert.deepEqual([by["写测试"].startedAt, by["写测试"].spans], [null, []], "写文档 -> 写测试 is a different item");
});

test("matchTexts: exact first, then ignoring case / punctuation, then most similar; unrelated texts stay unmatched", () => {
  assert.deepEqual(matchTexts(["a", "b", "a"], ["a", "a"]), [0, 2], "duplicates pair by position");
  assert.deepEqual(matchTexts(["改插件核心逻辑", "跑门禁", "写测试", "写文档", "改 index.js"], ["跑 dsh-verify 门禁", "改插件核心逻辑（todos.js）", "写测试用例", "新项", "改 todos.js", "写文挡"]), [1, 0, 2, -1, -1, 3]);
});

test("restart: a fresh index rescanning the persisted log gives the same times as the one that watched live", async () => {
  const log = [
    turn(1, 0, "start", 1), w(2, 0, [["a [ETA 5m/10m]", "in_progress"], ["b", "pending"], ["c", "pending"]]),
    w(3, 3, [["a [ETA 5m/10m]", "completed"], ["b2", "in_progress"], ["c", "pending"]]), turn(4, 5, "end", 1),
    turn(5, 9, "start", 2), w(6, 12, [["a [ETA 5m/10m]", "completed"], ["b2", "completed"], ["c", "completed"]]), turn(7, 13, "end", 2),
  ];
  const clock = () => at(40);
  const watched = createTodoIndex({ readSessionState: async () => ({ inheritedEventCount: 0, events: log.slice(0, 2) }), isRunning: () => false, running: idle, now: clock });
  await watched.view("s");
  for (const e of log.slice(2)) watched.observe("s", e);
  const rescanned = createTodoIndex({ readSessionState: async () => ({ inheritedEventCount: 0, events: log }), isRunning: () => false, running: idle, now: clock });
  const [x, y] = [await watched.view("s"), await rescanned.view("s")];
  assert.deepEqual(y, x);
  assert.deepEqual(y.items.map((i) => i.elapsedMs), [3 * MIN, 5 * MIN, 5 * MIN], "c jumped to completed: the stretch since the previous write, minus the wait");
});

test("activity (api 2): turns from turn/start → turn/end, live events extend it, short gaps merge, a running turn ends null", async () => {
  const index = createTodoIndex({
    readSessionState: async () => ({ inheritedEventCount: 1, events: [ev(0, "turn/start", { turn: 9 }, T0 - 1e6), ev(1, "turn/start", { turn: 1 }, T0), ev(2, "turn/end", { turn: 1, reason: { kind: "completed" } }, T0 + 60_000), ev(3, "turn/start", { turn: 2 }, T0 + 62_000), ev(4, "turn/end", { turn: 2, reason: { kind: "completed" } }, T0 + 120_000)] }),
    isRunning: () => false, running: idle,
  });
  assert.deepEqual(await index.activity("s"), [[T0, T0 + 120_000]], "fork-inherited events skipped; a 2 s gap merges");
  index.observe("s", ev(5, "turn/start", { turn: 3 }, T0 + 600_000));
  assert.deepEqual(await index.activity("s"), [[T0, T0 + 120_000], [T0 + 600_000, null]], "running turn: end null");
  index.observe("s", ev(6, "turn/end", { turn: 3, reason: { kind: "completed" } }, T0 + 660_000));
  assert.deepEqual((await index.activity("s"))[1], [T0 + 600_000, T0 + 660_000]);
  assert.equal(await index.view("s"), null, "no todolist still null");
});

test("activity: a turn event without numeric time fails loud for that session", async () => {
  const index = createTodoIndex({ readSessionState: async () => ({ inheritedEventCount: 0, events: [{ seq: 1, type: "turn/start", data: { turn: 1 } }] }), isRunning: () => false, running: idle });
  await assert.rejects(index.activity("s"), /turn\/start without numeric time/);
});

// ---- ETA kept across rewrites (2026-10-24, session caed7732) ----
const etaOf = async (lists) => {
  const events = lists.map((l, k) => write(k + 1, l));
  const index = createTodoIndex({ readSessionState: async () => ({ inheritedEventCount: 0, events }), isRunning: () => false, running: idle });
  return (await index.view("s")).items.map((i) => i.eta);
};
const E = (p50, p75) => ({ p50, p75 });

test("eta: a rewrite without the suffix keeps the ETA of the same item; an own suffix wins; new items stay empty", async () => {
  const etas = await etaOf([
    [["改插件核心逻辑 [ETA 8m/20m]", "in_progress"], ["跑 dsh-verify 门禁 [ETA 3m/9m]", "pending"], ["写测试 [ETA 2m/4m]", "pending"]],
    [["改插件核心逻辑（todos.js）", "completed"], ["跑 dsh-verify 门禁 [ETA 5m/12m]", "in_progress"], ["写测试", "pending"], ["全新的一项", "pending"]],
  ]);
  assert.deepEqual(etas, [E(480, 1200), E(300, 720), E(120, 240), null]);
});

test("eta: items merged into one add up (median + median, P75 + P75); a source without ETA adds nothing", async () => {
  const etas = await etaOf([
    [["改插件 [ETA 5m/10m]", "completed"], ["写测试 [ETA 3m/5m]", "completed"], ["顺手清理", "completed"], ["合入 [ETA 2m/3m]", "pending"]],
    [["改插件、写测试、顺手清理", "completed"], ["合入", "in_progress"]],
  ]);
  assert.deepEqual(etas, [E(480, 900), E(120, 180)]);
});

test("eta: a deleted item adds nothing to the items that stay", async () => {
  const etas = await etaOf([
    [["改插件核心逻辑 [ETA 8m/20m]", "completed"], ["清理临时目录 [ETA 9m/9m]", "completed"], ["跑门禁 [ETA 3m/9m]", "in_progress"]],
    [["改插件核心逻辑", "completed"], ["跑门禁", "in_progress"]],
  ]);
  assert.deepEqual(etas, [E(480, 1200), E(180, 540)], "a shorter list alone is not a merge");
});

test("eta: one item split into parts: the estimate is shared evenly, the total is kept", async () => {
  const etas = await etaOf([
    [["写测试并跑门禁 [ETA 10m/20m]", "in_progress"]],
    [["写测试", "in_progress"], ["跑门禁", "pending"]],
  ]);
  assert.deepEqual(etas, [E(300, 600), E(300, 600)]);
});

test("eta: replay of the real caed7732 todo_write sequence - ETAs survive the two rewrites that dropped the suffixes", async () => {
  const writes = JSON.parse(readFileSync(new URL("./fixtures/todo-writes.json", import.meta.url), "utf8"));
  const lists = writes.map((w) => w.todos.map((t) => [t.content, t.status]));
  const view = async (n) => (await etaOf(lists.slice(0, n)));
  assert.deepEqual(await view(1), [null, E(180, 300), E(600, 1080), E(300, 540), E(1440, 2520)]);
  // write 4: 截图 (completed) and fresh-context 审查 (completed) were rewritten without the suffix
  assert.deepEqual(await view(4), [null, null, E(180, 300), E(300, 540), null, E(1440, 2520)]);
  // write 5: three merged items; the first one never had an estimate in any version of the list
  assert.deepEqual(await view(5), [null, E(180, 300), E(1740, 3060)]);
});

// ---- background (api 3, 2026-10-24): subagents (any depth) and the session's own jobs count as work time ----
const e = (seq, minute, type, data = {}) => ({ seq, type, data, time: at(minute) });
const start = (seq, minute, n = 1) => e(seq, minute, "turn/start", { turn: n });
const end = (seq, minute, n = 1) => e(seq, minute, "turn/end", { turn: n, reason: { kind: "completed" } });
const kid = (seq, minute, childId, mode = "continuable") => e(seq, minute, "subagent/catalog", { version: 0, childId, childCreatedAt: at(minute), mode, label: childId });
const reg = (seq, minute, jobId) => e(seq, minute, "job/registered", { jobId, owner: "root", kind: "pwsh", label: jobId, startedAt: at(minute) });
// cause "producer": the job ended by itself (a test, verify, build); "kill": stopped from outside (a preview server)
const settle = (seq, minute, jobId, from, cause = "producer") => e(seq, minute, "job/settled", { jobId, owner: "root", kind: "pwsh", label: jobId, startedAt: at(from), finishedAt: at(minute), status: cause === "producer" ? "completed" : "killed", cause });
const logs = (map) => async (sid) => { if (!(sid in map)) throw new Error("no session " + sid); return { inheritedEventCount: 0, events: map[sid] }; };
const runs = (subagent = [], job = []) => async () => ({ subagent: new Set(subagent), job: new Set(job) });
const total = (spans, now = at(1000)) => spans.reduce((s, [a, b]) => s + (b ?? now) - a, 0) / MIN;
const busy = (act, bg) => mergeSpans(act.concat(bg.subagent, bg.job));

test("background: a subagent running while the main turn also runs counts once; the waiting stretch counts too", async () => {
  // main turn 0–10 dispatches kid at 1 and ends; kid runs 1–32; its report wakes the parent 30–40 (overlap 30–32)
  const index = createTodoIndex({ readSessionState: logs({ root: [start(1, 0), kid(2, 1, "kid"), end(3, 10), start(4, 30, 2), end(5, 40, 2)], kid: [start(1, 1), end(2, 32)] }), isRunning: () => false, running: idle });
  const [act, bg] = [await index.activity("root"), await index.background("root")];
  assert.deepEqual(act, [[at(0), at(10)], [at(30), at(40)]]);
  assert.deepEqual(bg, { subagent: [[at(1), at(32)]], job: [] });
  assert.deepEqual(busy(act, bg), [[at(0), at(40)]], "overlap counted once");
  assert.deepEqual([total(act), total(busy(act, bg)) - total(act)], [20, 20], "主回合 20m + 等子 agent 20m = 已用 40m");
});

test("background: only a subagent (any depth) running - open while the host lists it, else ends at its last logged event", async () => {
  const map = {
    root: [start(1, 0), kid(2, 1, "kid"), kid(3, 1, "remote", "external"), end(4, 2)],
    kid: [start(1, 1), kid(2, 3, "grand"), e(3, 7, "tool/call", { name: "pwsh", callId: "c" })],
    grand: [start(1, 3), end(2, 20)],
  };
  const read = [];
  const readSessionState = async (sid) => { read.push(sid); return logs(map)(sid); };
  const live = createTodoIndex({ readSessionState, isRunning: () => false, running: runs(["kid"]) });
  assert.deepEqual((await live.background("root")).subagent, [[at(1), null]], "the host lists kid: still running");
  assert.deepEqual(read, ["root", "kid", "grand"], "an external execution has no session log to read");
  const gone = createTodoIndex({ readSessionState, isRunning: () => false, running: idle });
  assert.deepEqual((await gone.background("root")).subagent, [[at(1), at(20)]], "kid cut at its last event (7), its own subagent ran to 20");
  assert.deepEqual(await gone.activity("root"), [[at(0), at(2)]], "the main turn alone");
});

test("jobs: one that ends by itself (test / verify / build) counts in full, also while nothing else runs", async () => {
  // main turn 0–5 starts a 15-minute verify (3–18) and ends waiting for it; the verify's notice wakes it 18–20
  const index = createTodoIndex({ readSessionState: logs({ root: [start(1, 0), reg(2, 3, "verify"), end(3, 5), settle(4, 18, "verify", 3), start(5, 18, 2), end(6, 20, 2)] }), isRunning: () => false, running: idle });
  const [act, bg] = [await index.activity("root"), await index.background("root")];
  assert.deepEqual(bg, { subagent: [], job: [[at(3), at(18)]] });
  assert.equal(total(busy(act, bg)), 20, "0–20: the 13 minutes only the verify ran count");
});

test("jobs: an always-on one (preview server) counts only while the main turn or a subagent runs; alone it does not", async () => {
  // main turn 0–10 starts a preview server at 2 and a subagent at 4 (runs 4–40); a test job runs 12–20 by itself;
  // the server keeps running until the agent kills it at 100 (a second server is still running, a third was cut by a restart)
  const map = {
    root: [start(1, 0), reg(2, 2, "server"), kid(3, 4, "kid"), end(4, 10), reg(5, 12, "test"), settle(6, 20, "test", 12), start(7, 40, 2), reg(8, 41, "server2"), end(9, 45, 2),
      settle(10, 100, "server", 2, "kill"), e(11, 101, "session/end-seed"), start(12, 101, 3), reg(13, 102, "server3"), end(14, 103, 3)],
    kid: [start(1, 4), end(2, 40)],
  };
  const index = createTodoIndex({ readSessionState: logs(map), isRunning: () => false, running: runs([], ["server2", "server3"]) });
  const [act, bg] = [await index.activity("root"), await index.background("root")];
  assert.deepEqual(bg.job, [[at(12), at(20)]], "only the job that ended by itself; killed / still running servers are left out");
  assert.deepEqual(busy(act, bg), [[at(0), at(45)], [at(101), at(103)]], "server time outside the main turn and the subagent adds nothing");
  assert.equal(total(busy(act, bg)), 47, "not 0–100 + 101–now as when the servers counted");
});

test("waiting for the user does not count: ask_user_question time inside a turn and the gap until the next turn; jobs during an ask neither", async () => {
  const ask = (seq, minute, id) => e(seq, minute, "tool/call", { turn: 1, step: 1, callId: id, name: "ask_user_question", arguments: "{}" });
  const answer = (seq, minute, id) => e(seq, minute, "tool/result", { turn: 1, step: 1, message: { role: "tool", toolCallId: id, content: [] } });
  const ptcAsk = (seq, minute, id) => e(seq, minute, "tool/ptc-dispatch-start", { rootCallId: "r", subCallId: id, name: "ask_user_question", arguments: {} });
  const ptcAnswer = (seq, minute, id) => e(seq, minute, "tool/ptc-dispatch", { rootCallId: "r", subCallId: id, name: "ask_user_question" });
  const map = {
    root: [start(1, 0), reg(2, 1, "build"), ask(3, 5, "c1"), answer(4, 25, "c1"), ptcAsk(5, 27, "r:ptc:1"), ptcAnswer(6, 28, "r:ptc:1"), kid(7, 29, "kid"), end(8, 30), settle(9, 30, "build", 1), start(10, 60, 2), end(11, 70, 2)],
    kid: [start(1, 29), ptcAsk(2, 31, "k:ptc:1"), ptcAnswer(3, 41, "k:ptc:1"), end(4, 45)],
  };
  const index = createTodoIndex({ readSessionState: logs(map), isRunning: () => false, running: idle });
  assert.deepEqual(await index.activity("root"), [[at(0), at(5)], [at(25), at(27)], [at(28), at(30)], [at(60), at(70)]], "5–25 and 27–28 waited for answers; 30–60 the session was idle");
  assert.deepEqual(await index.background("root"), { subagent: [[at(29), at(31)], [at(41), at(45)]], job: [[at(1), at(5)], [at(25), at(27)], [at(28), at(30)]] }, "a subagent waiting for the user does not count; the build's time during the asks does not either");
  const waiting = createTodoIndex({ readSessionState: logs({ root: [start(1, 0), ask(2, 5, "c1")] }), isRunning: () => true, running: idle });
  assert.deepEqual(await waiting.activity("root"), [[at(0), at(5)]], "still waiting for the answer: the running turn stops counting at the question");
});

test("background across a restart: a fresh index over the persisted log gives the same as the one that watched live", async () => {
  const log = [start(1, 0), reg(2, 2, "j1"), reg(3, 3, "j2"), kid(4, 3, "kid"), end(5, 5), settle(6, 12, "j2", 3), e(7, 50, "session/end-seed"), start(8, 50, 2), end(9, 52, 2)];
  const kidLog = [start(1, 3), e(2, 15, "tool/call", { name: "pwsh", callId: "c" })]; // cut by the restart: no turn/end
  const live = createTodoIndex({ readSessionState: logs({ root: log.slice(0, 6), kid: kidLog }), isRunning: () => false, running: idle });
  await live.background("root");
  for (const x of log.slice(6)) live.observe("root", x);
  const rescanned = createTodoIndex({ readSessionState: logs({ root: log, kid: kidLog }), isRunning: () => false, running: idle });
  const want = { subagent: [[at(3), at(15)]], job: [[at(3), at(12)]] };
  assert.deepEqual(await live.background("root"), want, "j1 (cut by the restart) left out; j2 counts; the subagent ends at its last event, not at the reload (50)");
  assert.deepEqual(await rescanned.background("root"), want);
});

test("view: an item's 已用 counts the background too (same rule as the round's)", async () => {
  const map = { root: [start(1, 0), w(2, 0, [["a", "in_progress"]]), kid(3, 1, "kid"), end(4, 10), start(5, 30, 2), w(6, 40, [["a", "completed"]]), end(7, 40, 2)], kid: [start(1, 1), end(2, 32)] };
  const index = createTodoIndex({ readSessionState: logs(map), isRunning: () => false, running: idle });
  assert.equal((await index.view("root")).items[0].elapsedMs, 20 * MIN, "turns only");
  assert.equal((await index.view("root", await index.background("root"))).items[0].elapsedMs, 40 * MIN, "turns ∪ background");
});

test("background: malformed job / catalog events and a malformed running() answer fail loud", async () => {
  const bad = (events) => createTodoIndex({ readSessionState: async () => ({ inheritedEventCount: 0, events }), isRunning: () => false, running: idle });
  await assert.rejects(bad([e(1, 0, "job/registered", { startedAt: at(0) })]).background("s"), /job\/registered without jobId/);
  await assert.rejects(bad([e(1, 0, "job/settled", { jobId: "j", startedAt: at(0) })]).background("s"), /job\/settled without jobId \/ startedAt \/ finishedAt/);
  await assert.rejects(bad([e(1, 0, "job/settled", { jobId: "j", startedAt: at(0), finishedAt: at(1) })]).background("s"), /job\/settled without cause/);
  await assert.rejects(bad([e(1, 0, "subagent/catalog", { version: 0 })]).background("s"), /subagent\/catalog without childId/);
  const shape = createTodoIndex({ readSessionState: logs({ s: [kid(1, 0, "k")], k: [start(1, 0)] }), isRunning: () => false, running: async () => ({ job: new Set() }) });
  await assert.rejects(shape.background("s"), /gave no \{subagent\} set/);
  assert.throws(() => createTodoIndex({ readSessionState: logs({}), isRunning: () => false }), /needs running\(sid\)/);
});

test("mergeSpans / minusSpans: sorted disjoint results, open ends", () => {
  assert.deepEqual(mergeSpans([[5, 9], [1, 3], [2, 4], [9, 10], [12, null], [13, 14]]), [[1, 4], [5, 10], [12, null]]);
  assert.deepEqual(minusSpans([[0, 10], [20, null]], [[2, 3], [8, 22], [25, null]]), [[0, 2], [3, 8], [22, 25]]);
  assert.deepEqual(minusSpans([[0, 10]], []), [[0, 10]]);
  assert.deepEqual(minusSpans([[0, 10]], [[0, 10]]), []);
});

// ---- api 4 (2026-10-26): why a session has no todolist (notodo); the subagents / background jobs on each item (agent) ----
const x = (minute, type, data = {}) => ({ seq: 0, type, data, time: at(minute) });
const L = (...events) => events.flat(2).map((v, i) => ({ ...v, seq: i + 1 }));
const task = (minute, text = "做件事") => x(minute, "user/message", { content: [{ type: "text", text }], source: { kind: "user" } });
const notice = (minute) => x(minute, "user/message", { content: [{ type: "text", text: "子 agent 完成" }], source: { kind: "subagent-settled", senderSessionId: "k" } });
const say = (minute, text, reasoning) => x(minute, "assistant/message", { turn: 1, step: 1, message: { role: "assistant", content: [...(reasoning === undefined ? [] : [{ type: "reasoning", text: reasoning }]), { type: "text", text }] } });
let callN = 0;
const toolStep = (minute) => {
  const id = "call-" + ++callN;
  return [x(minute, "step/start", { turn: 1, step: 1 }), x(minute, "tool/call", { turn: 1, step: 1, callId: id, name: "pwsh", arguments: "{}" }), x(minute, "tool/result", { turn: 1, step: 1, message: { role: "tool", toolCallId: id, content: [] } }), x(minute, "step/end", { turn: 1, step: 1 })];
};
const talkStep = (minute) => [x(minute, "step/start", { turn: 1, step: 1 }), say(minute, "想一想"), x(minute, "step/end", { turn: 1, step: 1 })];
const tStart = (minute, n = 1) => x(minute, "turn/start", { turn: n });
const tEnd = (minute, kind = "completed", n = 1) => x(minute, "turn/end", { turn: n, reason: { kind } });
const list = (minute, todos) => x(minute, "todo/write", { todos: todos.map(([content, status]) => ({ content, status })) });
const child = (minute, childId, label = childId, mode = "continuable") => x(minute, "subagent/catalog", { version: 0, childId, childCreatedAt: at(minute), mode, label });
const bgJob = (minute, jobId, callId, label = jobId) => x(minute, "job/registered", { jobId, owner: "root", kind: "pwsh", label, startedAt: at(minute), toolCall: { callId, rootCallId: "root-call" } });
const ptcDone = (minute, callId, text) => x(minute, "tool/ptc-dispatch", { rootCallId: "root-call", subCallId: callId, name: "pwsh", isError: false, content: [{ type: "text", text }] });
const topDone = (minute, callId, text) => x(minute, "tool/result", { turn: 1, step: 1, message: { role: "tool", toolCallId: callId, content: [{ type: "text", text }] } });
const jobEnd = (minute, jobId, from, status = "completed", cause = status === "killed" ? "kill" : "producer") => x(minute, "job/settled", { jobId, owner: "root", kind: "pwsh", label: jobId, startedAt: at(from), finishedAt: at(minute), status, cause });
const indexOf = (map, opts = {}) => createTodoIndex({ readSessionState: logs(map), isRunning: () => false, running: idle, now: () => at(500), ...opts });
const agents = (v) => v.items.map((i) => i.agent);
const run = (id, minute, state, name = id, kind = "subagent", mode = kind === "subagent" ? "continuable" : null, gone = false) => ({ id, kind, name, state, since: at(minute), mode, gone });
const inf = (why, steps) => ({ by: "inferred", text: null, why, steps });
const none = (steps) => ({ by: "none", text: null, why: null, steps });

test("notodo (api 4): the reason the session wrote after the latest task message - the last one, text blocks only", async () => {
  const index = indexOf({
    s: L(
      task(0, "第一个任务"), tStart(0), say(0, "不列待办：上一个任务的原因"), tEnd(1),
      task(2, "第二个任务"), tStart(2), toolStep(2),
      say(3, "先看看", "不列待办：只写在 reasoning 里"),
      say(3, "不列待办: 两步就完。\n后面的话"),
      say(4, "结论如下\n不列待办：  一次读完就答复．  "),
      say(4, "不列待办：  。"),
      tEnd(5),
    ),
    busy: L(task(0), tStart(0), say(0, "不列待办：等子 agent 回来")),
  }, { isRunning: (sid) => sid === "busy" });
  assert.equal(await index.view("s"), null);
  assert.deepEqual(await index.notodo("s"), { by: "session", text: "一次读完就答复", why: null, steps: 1 }, "the last non-empty one; its trailing full stop goes");
  assert.deepEqual(await index.notodo("busy"), { by: "session", text: "等子 agent 回来", why: null, steps: 0 }, "a written reason wins while running too");
  index.observe("s", { ...task(6, "第三个任务"), seq: 100 });
  assert.deepEqual(await index.notodo("s"), inf("no-tools", 0), "a new task message: the earlier reason no longer counts");
  index.observe("s", { ...say(7, "不列待办：只是回答一个问题"), seq: 101 });
  index.observe("s", { ...notice(8), seq: 102 });
  assert.deepEqual(await index.notodo("s"), { by: "session", text: "只是回答一个问题", why: null, steps: 0 }, "a subagent-settled notice is not a task message");
});

test("notodo: inferred from the tool steps since the latest task message - starting / no-tools / few-steps, else none", async () => {
  const sessions = {
    talk: L(task(0), tStart(0), talkStep(0), talkStep(1), tEnd(2)),
    two: L(task(0), tStart(0), toolStep(0), talkStep(1), toolStep(1), tEnd(2)),
    three: L(task(0), tStart(0), toolStep(0), toolStep(1), toolStep(2), tEnd(3)),
    again: L(task(0), tStart(0), toolStep(0), toolStep(0), toolStep(0), toolStep(0), tEnd(1), task(2), tStart(2, 2), toolStep(2), tEnd(3, "completed", 2)),
    untasked: L(tStart(0), toolStep(0), toolStep(1), tEnd(2)),
    busy: L(task(0), tStart(0), toolStep(0), toolStep(1)),
    busyNew: L(task(0), tStart(0)),
    busier: L(task(0), tStart(0), toolStep(0), toolStep(1), toolStep(2)),
  };
  const index = indexOf(sessions, { isRunning: (sid) => sid.startsWith("busy") });
  const got = {};
  for (const sid of Object.keys(sessions)) got[sid] = await index.notodo(sid);
  assert.deepEqual(got, {
    talk: inf("no-tools", 0), two: inf("few-steps", 2), three: none(3), again: inf("few-steps", 1), untasked: inf("few-steps", 2),
    busy: inf("starting", 2), busyNew: inf("starting", 0), busier: none(3),
  });
});

test("notodo: a long reason is cut to 79 characters + …; 80 stay as they are", async () => {
  const index = indexOf({ a: L(task(0), say(0, "不列待办：" + "很".repeat(100) + "。")), b: L(task(0), say(0, "不列待办：" + "长".repeat(80) + "。")) });
  const [a, b] = [await index.notodo("a"), await index.notodo("b")];
  assert.equal(a.text, "很".repeat(79) + "…");
  assert.equal(b.text, "长".repeat(80));
});

test("handler (api 4): notodo only for sessions that never wrote a todolist; an error there stays with that sid", async () => {
  const map = { planned: L(task(0), tStart(0), list(0, [["a", "in_progress"]])), quiet: L(task(0), tStart(0), toolStep(0), tEnd(1)), boom: L(task(0)) };
  const index = indexOf(map, { isRunning: (sid) => { if (sid === "boom") throw new Error("agents.get failed"); return false; } });
  const res = { code: 0, body: null, writeHead(code) { this.code = code; }, end(text) { this.body = JSON.parse(text); } };
  await todosHandler({ index, guard: () => null })({ method: "GET", url: "/alignment/todos?sids=planned,quiet,boom,nope" }, res);
  assert.deepEqual([res.code, res.body.api, TODOS_API], [200, 5, 5]);
  assert.deepEqual(res.body.notodo, { quiet: inf("few-steps", 1), boom: { error: "agents.get failed" } }, "planned has a todolist; nope has an error in sessions");
  assert.deepEqual([res.body.sessions.quiet, res.body.sessions.boom], [null, null]);
  assert.match(res.body.sessions.nope.error, /no session nope/);
  assert.equal(res.body.sessions.planned.items[0].agent, null);
});

test("agent (api 4): an item marked 🤖 is delegated by the session itself, runs or not; the mark stays in text", async () => {
  const index = indexOf({ s: L(task(0), tStart(0), list(0, [["🤖 派子 agent 写页面 [ETA 5m/9m]", "pending"], ["  🤖 再派一个", "completed"], ["自己改服务端", "in_progress"], ["机器人🤖在中间", "pending"]])) });
  const v = await index.view("s");
  assert.deepEqual(v.items.map((i) => i.text), ["🤖 派子 agent 写页面", "  🤖 再派一个", "自己改服务端", "机器人🤖在中间"]);
  assert.deepEqual(agents(v), [{ by: "session", runs: [] }, { by: "session", runs: [] }, null, null]);
});

test("agent: a subagent started while an item is in progress shows on that item (inferred); external runs and other items don't", async () => {
  const index = indexOf({
    s: L(task(0), tStart(0), list(0, [["读代码", "completed"], ["写页面", "in_progress"], ["跑门禁", "pending"]]), child(1, "kid", "  写页面的子 agent "), child(2, "remote", "远程", "external"), child(3, "nameless", "  "), tEnd(3)),
    kid: L(tStart(1), tEnd(9)), nameless: L(tStart(3), tEnd(4)),
  });
  assert.deepEqual(agents(await index.view("s")), [null, { by: "inferred", runs: [run("kid", 1, "done", "写页面的子 agent"), run("nameless", 3, "done", null)] }, null]);
});

test("agent: several candidates - the most similar to the run's name, else the one with the fewest runs; 🤖 items first", async () => {
  const map = {
    s: L(task(0), tStart(0), list(0, [["改服务端 todos.js", "in_progress"], ["写页面 template", "in_progress"], ["跑门禁", "in_progress"]]),
      child(1, "k1", "写页面 template 改版"), child(2, "k2", "reviewer"), child(3, "k3", "reviewer two"), child(4, "k4", "")),
    r: L(task(0), tStart(0), list(0, [["🤖 写页面", "in_progress"], ["改服务端", "in_progress"], ["🤖 写文档", "in_progress"], ["🤖 收尾", "pending"]]),
      child(1, "r1", "改服务端"), child(2, "r2", "写文档的子 agent")),
    v: L(task(0), tStart(0), list(0, [["🤖 文案审查（ui-copy-boundary） [ETA 3m/6m]", "in_progress"], ["🤖 视觉审查（impeccable）", "in_progress"]]),
      child(1, "v1", "视觉审查"), child(2, "v2", "文案审查")),
  };
  for (const id of ["k1", "k2", "k3", "k4", "r1", "r2", "v1", "v2"]) map[id] = L(tStart(1), tEnd(9));
  const index = indexOf(map);
  assert.deepEqual(agents(await index.view("s")), [
    { by: "inferred", runs: [run("k2", 2, "done", "reviewer"), run("k4", 4, "done", null)] },
    { by: "inferred", runs: [run("k1", 1, "done", "写页面 template 改版")] },
    { by: "inferred", runs: [run("k3", 3, "done", "reviewer two")] },
  ], "k1 by name; k2, k3, k4 to the item with the fewest runs (ties: the earlier item)");
  assert.deepEqual(agents(await index.view("r")), [
    { by: "session", runs: [run("r1", 1, "done", "改服务端")] }, null, { by: "session", runs: [run("r2", 2, "done", "写文档的子 agent")] }, { by: "session", runs: [] },
  ], "only the 🤖 items in progress are candidates, even when the name fits another item");
  assert.deepEqual(agents(await index.view("v")), [{ by: "session", runs: [run("v2", 2, "done", "文案审查")] }, { by: "session", runs: [run("v1", 1, "done", "视觉审查")] }],
    "a short Chinese description matches the item it was named after (视觉审查 -> 视觉审查（impeccable）)");
});

test("agent: dispatched before the 🤖 item is marked in progress - the next write puts it on the 🤖 item; until then it shows on the item in progress", async () => {
  const log = L(task(0), tStart(0), list(0, [["勘探现状", "in_progress"], ["🤖 服务端 todos.js 加字段", "pending"], ["收尾", "pending"]]), child(1, "kid", "Server todos api 4"),
    list(2, [["勘探现状", "completed"], ["🤖 服务端 todos.js 加字段", "in_progress"], ["收尾", "pending"]]), list(3, [["勘探现状", "completed"], ["🤖 服务端 todos.js 加字段", "in_progress"], ["收尾", "in_progress"]]));
  const index = indexOf({ s: log.slice(0, 4), kid: L(tStart(1)) }, { running: runs(["kid"]) });
  const kidRun = run("kid", 1, "running", "Server todos api 4");
  assert.deepEqual(agents(await index.view("s")), [{ by: "inferred", runs: [kidRun] }, { by: "session", runs: [] }, null], "not settled yet: shown on the item in progress at dispatch");
  index.observe("s", log[4]);
  assert.deepEqual(agents(await index.view("s")), [null, { by: "session", runs: [kidRun] }, null]);
  index.observe("s", log[5]);
  assert.deepEqual(agents(await index.view("s")), [null, { by: "session", runs: [kidRun] }, null], "settled once: a later write does not move it");
});

test("agent: dispatched while a 🤖 item runs, then a plain item on the main line is marked in progress - it stays on the 🤖 item", async () => {
  const index = indexOf({
    s: L(task(0), tStart(0), list(0, [["🤖 视觉审查（impeccable）", "in_progress"], ["改服务端", "pending"]]), child(1, "kid", "页面截图"),
      list(2, [["🤖 视觉审查（impeccable）", "in_progress"], ["改服务端", "in_progress"]])),
    kid: L(tStart(1), tEnd(5)),
  });
  assert.deepEqual(agents(await index.view("s")), [{ by: "session", runs: [run("kid", 1, "done", "页面截图")] }, null]);
});

test("agent: a run with nothing in progress waits for the next write and goes to an item that starts there; a new task drops it", async () => {
  const map = {
    s: L(task(0), tStart(0), child(1, "early", "先派的"), list(2, [["a", "in_progress"], ["b", "pending"]]),
      list(3, [["a", "completed"], ["b", "pending"], ["c", "pending"]]), child(4, "gap", "间隙里派的"), bgJob(4, "job-gap", "cj"), ptcDone(4, "cj", "started background job job-gap"),
      list(5, [["a", "completed"], ["b", "in_progress"], ["c", "in_progress"]]), child(6, "late", "后来的 b"), list(7, [["a", "completed"], ["b", "completed"], ["c", "in_progress"]])),
    t: L(task(0), tStart(0), list(0, [["a", "completed"]]), child(1, "lost", "丢掉的"), task(2, "新任务"), list(3, [["x", "in_progress"]]),
      list(4, [["x", "completed"]]), child(5, "dropped", "没地方挂"), list(6, [["x", "completed"], ["y", "pending"]]), list(7, [["x", "completed"], ["y", "in_progress"]])),
    u: L(task(0), tStart(0), list(0, [["a", "in_progress"]]), child(1, "shown", "先显示")),
  };
  for (const id of ["early", "gap", "late", "lost", "dropped", "shown"]) map[id] = L(tStart(1), tEnd(9));
  const index = indexOf(map);
  assert.deepEqual(agents(await index.view("s")), [
    { by: "inferred", runs: [run("early", 1, "done", "先派的")] },
    { by: "inferred", runs: [run("gap", 4, "done", "间隙里派的"), run("late", 6, "done", "后来的 b")] },
    { by: "inferred", runs: [run("job-gap", 4, "stopped", "job-gap", "job")] },
  ], "early and gap / job-gap waited for a write that started something; late was in progress-time on b and c, fewest runs (tie: b)");
  assert.deepEqual(agents(await index.view("t")), [null, null], "lost dropped by the new task message; dropped found no item starting in the next write");
  assert.deepEqual(agents(await index.view("u")), [{ by: "inferred", runs: [run("shown", 1, "done", "先显示")] }]);
  index.observe("u", { ...task(2, "下一个任务"), seq: 50 });
  assert.deepEqual(agents(await index.view("u")), [null], "a new task drops a waiting run, also the one shown provisionally");
});

test("agent: on a rewrite the runs follow their item (same pairing as spans); a rescan after a restart gives the same", async () => {
  const log = L(task(0), tStart(0), list(0, [["写页面", "in_progress"], ["b", "pending"]]), child(1, "kid", "页面"),
    list(2, [["b", "in_progress"], ["写页面（template.html）", "in_progress"]]), list(3, [["写页面（template.html）", "completed"], ["b", "completed"], ["新的一项", "pending"]]), tEnd(4));
  const kid = L(tStart(1), tEnd(3));
  const watched = indexOf({ s: log.slice(0, 4), kid });
  assert.deepEqual(agents(await watched.view("s")), [{ by: "inferred", runs: [run("kid", 1, "done", "页面")] }, null]);
  for (const v of log.slice(4)) watched.observe("s", v);
  const rescanned = indexOf({ s: log, kid });
  const [a, b] = [await watched.view("s"), await rescanned.view("s")];
  assert.deepEqual(b, a);
  assert.deepEqual(agents(a), [{ by: "inferred", runs: [run("kid", 1, "done", "页面")] }, null, null]);
});

test("agent: a job is a run once its tool call returned before it settled (background); foreground jobs never are", async () => {
  const index = indexOf({
    s: L(task(0), tStart(0), list(0, [["跑门禁", "in_progress"]]),
      bgJob(1, "pwsh-fg", "c1"), jobEnd(2, "pwsh-fg", 1), ptcDone(2, "c1", "ok"),
      bgJob(3, "pwsh-bg", "c2", "  pwsh -File dsh-verify.ps1  "), ptcDone(3, "c2", "started background job pwsh-bg"),
      bgJob(4, "pwsh-slow", "c3"), topDone(6, "c3", "[still running after 120000ms; moved to background job pwsh-slow]"), jobEnd(9, "pwsh-slow", 4),
      bgJob(5, "pwsh-server", "c4"), ptcDone(5, "c4", "started background job pwsh-server"), jobEnd(20, "pwsh-server", 5, "killed"),
      bgJob(6, "pwsh-broken", "c5"), ptcDone(6, "c5", "started background job pwsh-broken"), jobEnd(7, "pwsh-broken", 6, "failed"),
      bgJob(7, "pwsh-cut", "c6"), ptcDone(7, "c6", "started background job pwsh-cut"),
      x(8, "job/registered", { jobId: "loose", owner: "root", kind: "pwsh", label: "loose", startedAt: at(8) }),
      tEnd(30)),
  }, { running: runs([], ["pwsh-bg"]) });
  assert.deepEqual(agents(await index.view("s")), [{ by: "inferred", runs: [
    run("pwsh-bg", 3, "running", "完整检查 dsh-verify", "job"), run("pwsh-slow", 4, "done", "pwsh-slow", "job"), run("pwsh-server", 5, "stopped", "pwsh-server", "job"),
    run("pwsh-broken", 6, "failed", "pwsh-broken", "job"), run("pwsh-cut", 7, "stopped", "pwsh-cut", "job"),
  ] }]);
});

// 2026-10-26: a pwsh job's label is the raw command; its name is the description of the call that started it
// (top-level tool/call arguments are a JSON string, a run_code call's are an object), else read from the command
test("agent / jobInfo: a job's name is its starting call's description, else one read from the command; the call returning drops what it held", async () => {
  const verify = 'pwsh -NoProfile -File .\\dsh-verify.ps1 *> v.log; exit $LASTEXITCODE';
  const top = (minute, callId, args) => x(minute, "tool/call", { turn: 1, step: 1, callId, name: "pwsh", arguments: JSON.stringify(args) });
  const ptc = (minute, callId, name, args) => x(minute, "tool/ptc-dispatch-start", { rootCallId: "root-call", subCallId: callId, name, arguments: args });
  const index = indexOf({
    s: L(task(0), tStart(0), list(0, [["🤖 跑门禁", "in_progress"]]),
      ptc(1, "c1", "pwsh", { description: "  dsh-verify、提交合入 master ", command: verify, run_in_background: true }), bgJob(1, "pwsh-a", "c1", verify), ptcDone(1, "c1", "started background job pwsh-a"),
      top(2, "c2", { command: verify, run_in_background: true }), bgJob(2, "pwsh-b", "c2", verify), topDone(2, "c2", "started background job pwsh-b"),
      ptc(3, "c3", "workflow", { meta: { name: "align-review", description: "审一轮对齐页" }, script: "return 1", run_in_background: true }),
      x(3, "job/registered", { jobId: "wf-1", owner: "root", kind: "workflow", label: "align-review", startedAt: at(3), toolCall: { callId: "c3", rootCallId: "root-call" } }), ptcDone(3, "c3", "started"),
      ptc(4, "c4", "pwsh", { description: "没起任务的调用", command: "git status" }), ptcDone(4, "c4", "ok"),
      top(5, "c5", "{not json"), bgJob(5, "pwsh-c", "c5", "node probe.mjs *> p.log"), topDone(5, "c5", "started background job pwsh-c")),
  }, { running: runs([], ["pwsh-a", "pwsh-b", "wf-1", "pwsh-c"]) });
  const [agent] = agents(await index.view("s"));
  assert.deepEqual(agent.runs.map((r) => [r.id, r.name]), [["pwsh-a", "dsh-verify、提交合入 master"], ["pwsh-b", "完整检查 dsh-verify"], ["wf-1", "审一轮对齐页"], ["pwsh-c", "node probe.mjs"]]);
  assert.deepEqual(await index.jobInfo("s", "pwsh-a"), { kind: "pwsh", desc: "dsh-verify、提交合入 master" });
  assert.deepEqual(await index.jobInfo("s", "pwsh-b"), { kind: "pwsh", desc: null }, "no description: null (the name is made from the command)");
  assert.deepEqual(await index.jobInfo("s", "pwsh-c"), { kind: "pwsh", desc: null }, "arguments that are not JSON: no description");
  assert.equal(await index.jobInfo("s", "pwsh-nope"), null, "no such job in the log");
});

test("agent: a subagent's state comes from its own log - open: running if the host lists it (with or without session-), else stopped; closed: by reason", async () => {
  const ended = [["k-done", "completed"], ["k-error", "error"], ["k-max", "max-tokens"], ["k-abort", "aborted"], ["k-int", "interrupted"], ["k-block", "blocked"], ["k-future", "some-new-kind"]];
  const map = { s: L(task(0), tStart(0), list(0, [["派子 agent", "in_progress"]]), child(1, "k-run"), child(2, "session-k-pre"), child(3, "k-cut"), child(4, "k-fresh"), ended.map(([id], i) => child(5 + i, id))) };
  map["k-run"] = L(tStart(1));
  map["session-k-pre"] = L(tStart(2));
  map["k-cut"] = L(tStart(3), toolStep(3));
  map["k-fresh"] = [];
  for (const [id, kind] of ended) map[id] = L(tStart(5), tEnd(6, kind));
  let asked = 0;
  const index = indexOf(map, { running: async () => { asked += 1; return { subagent: new Set(["session-k-run", "k-pre", "k-fresh"]), job: new Set() }; } });
  const [agent] = agents(await index.view("s"));
  assert.deepEqual(agent.runs.map((r) => [r.id, r.state]), [["k-run", "running"], ["session-k-pre", "running"], ["k-cut", "stopped"], ["k-fresh", "running"],
    ["k-done", "done"], ["k-error", "failed"], ["k-max", "failed"], ["k-abort", "stopped"], ["k-int", "stopped"], ["k-block", "stopped"], ["k-future", "stopped"]]);
  assert.equal(asked, 1, "the host is asked once per view");
  const settled = indexOf({ s: L(task(0), tStart(0), list(0, [["a", "in_progress"]]), child(1, "k-done")), "k-done": L(tStart(1), tEnd(2)) }, { running: async () => { throw new Error("not needed"); } });
  assert.deepEqual(agents(await settled.view("s")), [{ by: "inferred", runs: [run("k-done", 1, "done")] }], "every run closed in the logs: the host is not asked");
});

test("agent: rev changes when a run's state changes, not otherwise", async () => {
  let listed = ["kid"];
  const index = indexOf({ s: L(task(0), tStart(0), list(0, [["a", "in_progress"]]), child(1, "kid")), kid: L(tStart(1)) }, { running: async () => ({ subagent: new Set(listed), job: new Set() }) });
  const v1 = await index.view("s");
  assert.equal(v1.items[0].agent.runs[0].state, "running");
  assert.equal((await index.view("s")).rev, v1.rev, "same state, same rev");
  listed = [];
  const v2 = await index.view("s");
  assert.equal(v2.items[0].agent.runs[0].state, "stopped");
  assert.notEqual(v2.rev, v1.rev);
  index.observe("kid", { ...tEnd(5), seq: 10 });
  const v3 = await index.view("s");
  assert.equal(v3.items[0].agent.runs[0].state, "done");
  assert.notEqual(v3.rev, v2.rev);
});

test("turn/end without a string reason.kind fails loud (api 4 reads it for a subagent's state)", async () => {
  await assert.rejects(indexOf({ s: L(tStart(0), x(1, "turn/end", { turn: 1 })) }).activity("s"), /turn\/end without reason\.kind/);
});

// ---- 2026-10-26: the page opens a subagent's session from its run row ----
test("agent: a run carries the subagent's catalog mode (null for a job), which the page needs to open the session", async () => {
  const map = { s: L(task(0), tStart(0), list(0, [["派两个", "in_progress"]]), child(1, "k-c"), child(2, "k-o", "k-o", "one-shot")), "k-c": L(tStart(1), tEnd(2)), "k-o": L(tStart(2), tEnd(3)) };
  const [agent] = agents(await indexOf(map).view("s"));
  assert.deepEqual(agent.runs.map((r) => [r.id, r.mode, r.gone]), [["k-c", "continuable", false], ["k-o", "one-shot", false]]);
});

test("agent: a subagent whose session was deleted is gone (state stopped) - the parent's todolist and background still answer", async () => {
  let reads = 0;
  const map = { s: L(task(0), tStart(0), list(0, [["🤖 审查", "in_progress"]]), child(1, "k-gone"), child(2, "k-ok")), "k-ok": L(tStart(2), tEnd(3)) };
  const readSessionState = async (sid) => { if (sid === "k-gone") { reads += 1; throw new Error('session "k-gone" not found'); } return logs(map)(sid); };
  const index = indexOf(map, { readSessionState });
  const v = await index.view("s");
  assert.deepEqual(agents(v), [{ by: "session", runs: [run("k-gone", 1, "stopped", "k-gone", "subagent", "continuable", true), run("k-ok", 2, "done")] }]);
  assert.deepEqual(await index.background("s"), { subagent: [[at(2), at(3)]], job: [] }, "the deleted one has no time left to count");
  await index.view("s");
  assert.equal(reads, 1, "a deleted session is not read again on every poll");
});

test("agent: any other error reading a subagent's log still fails the view loud", async () => {
  const map = { s: L(task(0), tStart(0), list(0, [["a", "in_progress"]]), child(1, "k-bad")) };
  const index = indexOf(map, { readSessionState: async (sid) => { if (sid === "k-bad") throw new Error("disk on fire"); return logs(map)(sid); } });
  await assert.rejects(index.view("s"), /disk on fire/);
});

test("exists (the page asks before opening a subagent): reads the log again; a session deleted after it was cached turns gone for the next view", async () => {
  const map = { s: L(task(0), tStart(0), list(0, [["🤖 审查", "in_progress"]]), child(1, "k-late")), "k-late": L(tStart(1), tEnd(2)) };
  const index = indexOf(map, { readSessionState: async (sid) => { if (sid === "k-late" && map.deleted) throw new Error('session "k-late" not found'); return logs(map)(sid); } });
  assert.equal(agents(await index.view("s"))[0].runs[0].gone, false);
  assert.equal(await index.exists("k-late"), true);
  map.deleted = true;
  const before = (await index.view("s")).rev;
  assert.equal(agents(await index.view("s"))[0].runs[0].gone, false, "the cached state does not notice the deletion by itself");
  assert.equal(await index.exists("k-late"), false);
  const v = await index.view("s");
  assert.deepEqual(agents(v)[0].runs.map((r) => [r.state, r.gone]), [["stopped", true]]);
  assert.notEqual(v.rev, before);
  await assert.rejects(indexOf(map, { readSessionState: async () => { throw new Error("disk on fire"); } }).exists("k-late"), /disk on fire/);
});

test("handler: ?exists=<sid> answers {exists}; a malformed id is a 400", async () => {
  const map = { s: L(task(0)) };
  const handler = todosHandler({ index: indexOf(map), guard: () => null });
  const call = (url) => new Promise((resolve) => handler({ method: "GET", url }, { writeHead(code) { this.code = code; }, end(body) { resolve([this.code, JSON.parse(body)]); } }));
  assert.deepEqual(await call("/alignment/todos?exists=s"), [200, { ok: true, api: 5, exists: true }]);
  const [code] = await call("/alignment/todos?exists=" + encodeURIComponent("../x"));
  assert.equal(code, 400);
});
