// watch.test.mjs: dsh-alignment page change watcher (watch.js, 2026-10-22 multi-type phone alerts).
// Pages are written by the REAL align CLI (spawned, temp ALIGN_STORE / ALIGN_WORKSPACES), the watcher reads them with
// align.mjs readRegistry / parsePage exactly like the plugin does. F->P: on the old plugin watch.js does not exist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SKILL = process.env.ALIGN_SKILL_DIR ?? path.join(PLUGIN, "cli");
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-align-watch-"));
process.env.ALIGN_STORE = STORE;
process.env.ALIGN_WORKSPACES = path.join(STORE, "workspace.json");
process.env.ALIGN_THREADS_CLI = path.join(PLUGIN, "test", "fixtures", "fake-threads.mjs"); // round add 的 sid 存在性检查走替身，不连 3080
fs.writeFileSync(process.env.ALIGN_WORKSPACES, JSON.stringify({ tables: { workspaces: { "ws-a": { path: "C:/proj/a", title: "Alpha", sessionIds: ["session-814c103b-0000-4000-8000-100000000000", "session-824c11ce-0000-4000-8000-200000000000"] } } } }));
const A = await import(pathToFileURL(path.join(SKILL, "align.mjs")).href);
const watchJs = path.join(PLUGIN, "watch.js");
assert.ok(fs.existsSync(watchJs), "watch.js missing (change watcher not implemented): " + watchJs);
const { createAlignmentWatcher, snapshotOf, pageAlerts } = await import(pathToFileURL(watchJs).href);

let clock = Date.parse("2026-10-22T17:40:00+08:00");
// 真 CLI 进程只在 init 这一步走一次(参数解析 / 入口 / 退出码);其余写页面进程内调同一个 main()(与 CLI 入口调的是同一函数),不为每次写入起一个 node
const alignCli = (...args) => {
  clock += 60_000; // every write gets a later "updated" (ALIGN_NOW fixes "now" for the CLI)
  const r = spawnSync(process.execPath, [path.join(SKILL, "align.mjs"), ...args], { env: { ...process.env, ALIGN_NOW: new Date(clock).toISOString() }, encoding: "utf8" });
  assert.equal(r.status, 0, args.join(" ") + "\n" + r.stderr);
  return r.stdout;
};
const align = async (...args) => {
  clock += 60_000; // every write gets a later "updated"
  process.env.ALIGN_NOW = new Date(clock).toISOString();
  try { return await A.main(args); } finally { delete process.env.ALIGN_NOW; }
};
const E = ["eta=40m", "eta75=1h", "etaconf=中"];
const page = path.join(STORE, "fm.html");
alignCli("init", page, "--name", "fm", "--title", "First Mate 对齐页", "--owner", "session-8387cb55-0000-4000-8000-e00000000000", "--version", "3");
await align("project", "add", "fm", "--ws", "ws-a");
await align("decide", "add", "fm", "old", "title=已有的决定", "why=之前就在", "opt=甲::a", "opt=乙::b", "risk=中", "cat=其他");
await align("round", "add", "fm", "r1", "--mode", "new", ...E, "title=第一轮", "sid=session-814c103b-0000-4000-8000-100000000000", "why=新任务");

function start() {
  const emitted = [];
  const logs = [];
  const w = createAlignmentWatcher({ readRegistry: A.readRegistry, parsePage: A.parsePage, emit: (p) => emitted.push(structuredClone(p)), log: (l) => logs.push(l) });
  return { w, emitted, logs };
}
const kinds = (p) => p.alerts.map((a) => a.kind + " " + a.itemId);
const updatedOf = (id) => A.parsePage(fs.readFileSync(page, "utf8")).decisions.find((d) => d.id === id).updated;

const { w, emitted, logs } = start();

test("baseline: the first scan only snapshots, never alerts or emits", async () => {
  assert.equal(w.scan(), null);
  assert.equal(emitted.length, 0);
  assert.deepEqual(w.openState(), [{ name: "fm", title: "First Mate 对齐页", open: 1, openIds: ["old"] }]);
  assert.equal(w.errors(), null);
  assert.equal(w.scan(), null, "rereading unchanged files emits nothing");
});

test("decide add -> one decision alert with alertId decision:<page>:<id>:<updated>, sessionId = owner when no sid", async () => {
  await align("decide", "add", "fm", "baolian-key", "title=重置百炼 API key", "why=key 泄露在日志里", "opt=现在去重置::停 5 分钟", "opt=以后再说::有风险", "rec=现在去重置", "risk=中", "cat=其他");
  const p = w.scan();
  assert.deepEqual(kinds(p), ["decision baolian-key"]);
  assert.deepEqual(p.alerts[0], {
    kind: "decision", alertId: "decision:fm:baolian-key:" + updatedOf("baolian-key"), page: "fm", pageTitle: "First Mate 对齐页",
    itemId: "baolian-key", title: "重置百炼 API key", sessionId: "session-8387cb55-0000-4000-8000-e00000000000", text: "推荐：现在去重置。key 泄露在日志里", open: 2,
  });
  assert.deepEqual(p.pages, [{ name: "fm", title: "First Mate 对齐页", open: 2, openIds: ["old", "baolian-key"] }]);
  assert.equal(w.scan(), null, "same file again: no new alert");
});

test("editing an already-open decision does not alert (but nothing else changes either)", async () => {
  await align("decide", "set", "fm", "baolian-key", "why=改了说明");
  assert.equal(w.scan(), null);
});

test("leaving open (sent) only updates the page summary; sent -> open alerts again with a new id", async () => {
  const before = emitted.length;
  const firstId = emitted.at(-1).alerts[0].alertId;
  await align("decide", "set", "fm", "baolian-key", "status=sent");
  const left = w.scan();
  assert.deepEqual(left.alerts, []);
  assert.deepEqual(left.pages[0].openIds, ["old"]);
  await align("decide", "set", "fm", "baolian-key", "status=open");
  const back = w.scan();
  assert.deepEqual(kinds(back), ["decision baolian-key"]);
  assert.notEqual(back.alerts[0].alertId, firstId, "put back to open = a new alert");
  assert.equal(back.alerts[0].alertId, "decision:fm:baolian-key:" + updatedOf("baolian-key"));
  assert.equal(emitted.length, before + 2);
});

test("pending -> open alerts; a pending decision itself does not (and is not in openIds)", async () => {
  await align("decide", "add", "fm", "wait-info", "--pending", "--round", "r1", "title=等信息", "why=还缺数据");
  const p = w.scan();
  assert.equal(p, null, "pending: nothing visible changed");
  await align("decide", "set", "fm", "wait-info", "why=数据到了", "opt=A::a", "opt=B::b", "status=open", "risk=中", "cat=其他");
  const q = w.scan();
  assert.deepEqual(kinds(q), ["decision wait-info"]);
  assert.equal(q.alerts[0].sessionId, "session-8387cb55-0000-4000-8000-e00000000000");
  assert.deepEqual(q.pages[0].openIds, ["old", "baolian-key", "wait-info"]);
});

test("decision sid wins over the page owner", async () => {
  await align("decide", "add", "fm", "with-sid", "title=有 sid", "why=w", "opt=A::a", "opt=B::b", "sid=session-62045a24-0000-4000-8000-e00000000000", "risk=中", "cat=其他");
  assert.equal(w.scan().alerts[0].sessionId, "session-62045a24-0000-4000-8000-e00000000000");
});

// v8: the CLI refuses status=waiting (questions are decisions without options now); old pages can still hold waiting
// rounds, so they are written straight into the page here and keep alerting.
const setRound = (id, fields) => {
  clock += 60_000;
  const d = A.parsePage(fs.readFileSync(page, "utf8"));
  Object.assign(d.rounds.find((r) => r.id === id), fields, { updated: new Date(clock).toISOString() });
  fs.writeFileSync(page, A.render(d));
};
test("round -> waiting alerts round-waiting with the round's sid; done / dropped never alert", async () => {
  setRound("r1", { status: "waiting", next: "等你确认部署窗口" });
  const p = w.scan();
  assert.deepEqual(kinds(p), ["round-waiting r1"]);
  const r1 = A.parsePage(fs.readFileSync(page, "utf8")).rounds.find((r) => r.id === "r1");
  assert.deepEqual(p.alerts[0], {
    kind: "round-waiting", alertId: "round-waiting:fm:r1:" + r1.updated, page: "fm", pageTitle: "First Mate 对齐页",
    itemId: "r1", title: "第一轮", sessionId: "session-814c103b-0000-4000-8000-100000000000", text: "等你确认部署窗口",
  });
  await align("round", "set", "fm", "r1", "next=还在等");
  assert.equal(w.scan(), null, "still waiting: no new alert");
  await align("round", "add", "fm", "r2", "--mode", "continue", "--prev", "r1", ...E, "title=第二轮", "why=继续");
  setRound("r2", { status: "waiting" });
  const q = w.scan();
  assert.deepEqual(kinds(q), ["round-waiting r2"], "added as waiting alerts; r1 auto-done does not");
  assert.equal(q.alerts[0].sessionId, "session-814c103b-0000-4000-8000-100000000000", "inherited sid");
  await align("round", "set", "fm", "r2", "status=dropped", "result=不做了");
  assert.equal(w.scan(), null);
  // v8: a question is a decision without options; it alerts as a decision
  await align("decide", "add", "fm", "q1", "--round", "r2", "title=手机插好了吗", "why=要装 local.10", "risk=低", "cat=其他");
  assert.deepEqual(kinds(w.scan()), ["decision q1"]);
});

test("a page registered after the baseline: its open decisions and waiting rounds alert once", async () => {
  const p2 = path.join(STORE, "other.html");
  await align("init", p2, "--name", "other", "--title", "第二页", "--version", "3");
  const empty = w.scan();
  assert.deepEqual(empty.alerts, [], "align init makes an empty page");
  assert.deepEqual(empty.pages.map((x) => x.name), ["fm", "other"]);
  // a page that already has content when it first shows up (registry edited by hand)
  const p3 = path.join(STORE, "late.html");
  const data = { version: 3, name: "late", title: "后来的页", updated: "2026-10-22T18:00:00+08:00", projects: [], rounds: [], decisions: [{ id: "d1", title: "后来的决定", status: "open", why: "w", opt: [{ label: "A", effect: "a" }, { label: "B", effect: "b" }], updated: "2026-10-22T18:00:00+08:00" }], notes: [] };
  fs.writeFileSync(p3, A.render(data));
  const reg = A.readRegistry();
  reg.late = p3;
  fs.writeFileSync(path.join(STORE, "pages.json"), JSON.stringify(reg, null, 2));
  const late = w.scan();
  assert.deepEqual(kinds(late), ["decision d1"]);
  assert.equal(late.alerts[0].alertId, "decision:late:d1:2026-10-22T18:00:00+08:00");
  assert.equal(late.alerts[0].sessionId, null, "no sid and no owner -> null");
  assert.equal(late.alerts[0].text, "w");
});

test("restart (new watcher instance) never re-alerts what is already open", async () => {
  const second = start();
  assert.equal(second.w.scan(), null);
  assert.equal(second.emitted.length, 0);
  assert.deepEqual(second.w.openState(), w.openState());
  await align("decide", "add", "fm", "after-restart", "title=重启后新增", "why=w", "opt=A::a", "opt=B::b", "risk=中", "cat=其他");
  assert.deepEqual(kinds(second.w.scan()), ["decision after-restart"]);
  w.scan();
});

test("a corrupted page keeps its old snapshot, emits nothing, reports watchError; repairing it clears the error", async () => {
  const good = fs.readFileSync(page, "utf8");
  const stateBefore = w.openState();
  fs.writeFileSync(page, good.replace('id="align-data"', 'id="broken"'));
  assert.equal(w.scan(), null);
  const errs = w.errors();
  assert.equal(errs.length, 1);
  assert.equal(errs[0].page, "fm");
  assert.match(errs[0].message, /align-data/);
  assert.match(logs.join("\n"), /page fm unreadable/);
  assert.deepEqual(w.openState(), stateBefore, "old snapshot kept");
  const nLogs = logs.length;
  w.scan();
  assert.equal(logs.length, nLogs, "the same error is logged once, not every poll");
  fs.writeFileSync(page, good);
  assert.equal(w.scan(), null, "back to the same content: no alert");
  assert.equal(w.errors(), null);
});

test("unreadable registry is reported (fail loud), pages keep their last good state", async () => {
  const regFile = path.join(STORE, "pages.json");
  const reg = fs.readFileSync(regFile, "utf8");
  fs.writeFileSync(regFile, "{not json");
  w.scan();
  assert.equal(w.errors()[0].page, "(registry)");
  assert.ok(w.openState().length >= 2);
  fs.writeFileSync(regFile, reg);
  w.scan();
  assert.equal(w.errors(), null);
});

test("a page removed from the registry (align forget) drops out of openState and the summary", async () => {
  assert.ok(w.openState().some((p) => p.name === "late"));
  await align("forget", "late");
  const p = w.scan();
  assert.ok(p, "the page summary changed, so it is emitted");
  assert.deepEqual(p.alerts, []);
  assert.equal(p.pages.some((x) => x.name === "late"), false);
  assert.equal(w.openState().some((x) => x.name === "late"), false, "the badge only counts registered pages");
  assert.ok(w.openState().some((x) => x.name === "fm"));
});

test("version-2 pages: decide items and doing items with who=you map to decisions / waiting rounds", async () => {
  const snap = snapshotOf({ version: 2, name: "v2", title: "旧页", items: [
    { id: "d", sec: "decide", status: "open", title: "t", updated: "u1" },
    { id: "r", sec: "doing", who: "you", title: "等你", updated: "u2", sid: "s" },
    { id: "x", sec: "doing", who: "agent", title: "进行中", updated: "u3" },
  ] });
  assert.deepEqual([...snap.decisions.keys()], ["d"]);
  assert.deepEqual([...snap.rounds].map(([id, r]) => [id, r.status]), [["r", "waiting"], ["x", "doing"]]);
  assert.throws(() => snapshotOf({ version: 9 }), /unknown page data version 9/);
});

test("fs.watchFile polling: a CLI write is picked up within a few seconds; start / stop manage the watches", async () => {
  const fast = createAlignmentWatcher({ readRegistry: A.readRegistry, parsePage: A.parsePage, emit: (p) => got.push(p), interval: 200 });
  const got = [];
  fast.scan();
  assert.throws(() => fast.start(), /registry path/);
  fast.start(path.join(STORE, "pages.json"));
  try {
    assert.ok(fast.watchedFiles().includes(page));
    assert.ok(fast.watchedFiles().includes(path.join(STORE, "pages.json")));
    await align("decide", "add", "fm", "polled", "title=轮询发现", "why=w", "opt=A::a", "opt=B::b", "risk=中", "cat=其他");
    const end = Date.now() + 5000;
    while (!got.some((p) => p.alerts.some((a) => a.itemId === "polled")) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    assert.ok(got.some((p) => p.alerts.some((a) => a.itemId === "polled")), "watchFile did not pick up the rename-written page");
  } finally { fast.stop(); }
  assert.deepEqual(fast.watchedFiles(), []);
});

test("emit listener errors never escape the poll callback; they show up in errors()", async () => {
  const bad = createAlignmentWatcher({ readRegistry: A.readRegistry, parsePage: A.parsePage, emit: () => { throw new Error("listener boom"); }, interval: 200, log: () => {} });
  bad.scan();
  bad.start(path.join(STORE, "pages.json"));
  try {
    await align("decide", "add", "fm", "boom", "title=监听器出错", "why=w", "opt=A::a", "opt=B::b", "risk=中", "cat=其他");
    const end = Date.now() + 5000;
    while (!bad.errors() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(bad.errors()?.map((e) => [e.page, e.message]), [["(emit)", "listener boom"]]);
  } finally { bad.stop(); }
});

test("factory fails loud on missing functions", async () => {
  assert.throws(() => createAlignmentWatcher({ readRegistry: A.readRegistry, parsePage: A.parsePage }), /emit must be a function/);
});

test("decision-due-soon: one alert when a deadline is under an hour away, again only for a new deadline", async () => {
  let t = clock;
  const emitted = [];
  const w2 = createAlignmentWatcher({ readRegistry: A.readRegistry, parsePage: A.parsePage, emit: (p) => emitted.push(structuredClone(p)), log: () => {}, now: () => t });
  assert.equal(w2.scan(), null, "baseline");
  await align("decide", "add", "fm", "deadline", "title=有截止", "why=w", "opt=A::a", "opt=B::b", "rec=A", "timeout=2h", "risk=中", "cat=其他");
  const dueOf = () => A.parsePage(fs.readFileSync(page, "utf8")).decisions.find((d) => d.id === "deadline").due;
  const due = dueOf();
  t = Date.parse(due) - 2 * 3600_000;
  assert.deepEqual(kinds(w2.scan()), ["decision deadline"], "two hours left: only the new-decision alert");
  t = Date.parse(due) - 30 * 60_000;
  const p = w2.scan();
  assert.deepEqual(kinds(p), ["decision-due-soon deadline"]);
  assert.deepEqual(p.alerts[0], {
    kind: "decision-due-soon", alertId: "decision-due-soon:fm:deadline:" + due, page: "fm", pageTitle: "First Mate 对齐页", itemId: "deadline",
    title: "有截止", sessionId: "session-8387cb55-0000-4000-8000-e00000000000", due, text: "还有 30 分钟到截止，到点没人答就按推荐「A」处理",
  });
  t += 60_000;
  assert.equal(w2.scan(), null, "once per deadline");
  await align("decide", "set", "fm", "deadline", "timeout=3h");
  const due2 = dueOf();
  assert.notEqual(due2, due);
  t = Date.parse(due2) - 10 * 60_000;
  assert.deepEqual(kinds(w2.scan()), ["decision-due-soon deadline"], "a new deadline alerts again");
  t = Date.parse(due2) + 60_000;
  assert.equal(w2.scan(), null, "past the deadline: the timeout runner takes over, no due-soon");
  assert.equal(typeof w2.tick, "function");
});

// v3 (2026-10-25, agent-alert-v3): a round entering done ("waiting for your review") alerts round-done.
// (set up inside the first test: top-level code runs before every earlier test and would change their page lists)
const rdPage = path.join(STORE, "rd.html");
const roundOf = (file, id) => A.parsePage(fs.readFileSync(file, "utf8")).rounds.find((r) => r.id === id);
const doneKinds = (p) => (p ? p.alerts.filter((a) => a.kind === "round-done").map((a) => a.itemId) : []);
let rd;

test("round-done: the baseline never alerts a round that was already done", async () => {
  await align("init", rdPage, "--name", "rd", "--title", "验收页", "--owner", "session-8387cb55-0000-4000-8000-e00000000000", "--version", "3");
  await align("project", "add", "rd", "--ws", "ws-a");
  await align("round", "add", "rd", "base-done", "--mode", "new", ...E, "title=基线前就完成", "sid=session-814c103b-0000-4000-8000-100000000000", "why=w");
  await align("round", "done", "rd", "base-done", "visual=false", "result=早就交了");
  rd = start();
  assert.equal(rd.w.scan(), null);
  assert.equal(rd.w.scan(), null);
  assert.equal(start().w.scan(), null, "a restart neither");
});

test("round-done: round done -> one review alert (exact shape, text = result); rereading the file does not alert", async () => {
  await align("round", "add", "rd", "a1", "--mode", "new", ...E, "title=第一轮交付", "sid=session-824c11ce-0000-4000-8000-200000000000", "why=w", "state=在写");
  assert.equal(rd.w.scan(), null, "a new doing round alerts nothing");
  await align("round", "done", "rd", "a1", "visual=false", "result=做完了，等你看");
  const p = rd.w.scan();
  assert.ok(p, "round done must emit");
  assert.deepEqual(p.alerts, [{
    kind: "round-done", alertId: "round-done:rd:a1:" + roundOf(rdPage, "a1").updated, page: "rd", pageTitle: "验收页",
    itemId: "a1", title: "第一轮交付", sessionId: "session-824c11ce-0000-4000-8000-200000000000", text: "做完了，等你看",
  }]);
  assert.equal(rd.w.scan(), null, "same file again: no new alert");
});

test("round-done: revise and redeliver (done -> doing -> done) is a new alert; no result -> text = state", async () => {
  const first = rd.emitted.at(-1).alerts[0].alertId;
  await align("round", "set", "rd", "a1", "status=doing", "state=按意见返工", "result=");
  assert.deepEqual(doneKinds(rd.w.scan()), []);
  await align("round", "done", "rd", "a1", "visual=false");
  const p = rd.w.scan();
  assert.deepEqual(doneKinds(p), ["a1"]);
  assert.notEqual(p.alerts[0].alertId, first);
  assert.equal(p.alerts[0].alertId, "round-done:rd:a1:" + roundOf(rdPage, "a1").updated);
  assert.equal(p.alerts[0].text, "按意见返工");
});

test("round-done: the previous round closed by round add --prev does not alert", async () => {
  await align("round", "add", "rd", "a2", "--mode", "continue", "--prev", "a1", ...E, "title=第二轮", "why=继续");
  await align("round", "add", "rd", "a3", "--mode", "continue", ...E, "title=第三轮", "sid=session-814c103b-0000-4000-8000-100000000000", "why=w");
  assert.equal(rd.w.scan(), null);
  await align("round", "add", "rd", "a4", "--mode", "continue", "--prev", "a3", ...E, "title=第四轮", "why=继续");
  assert.equal(roundOf(rdPage, "a3").status, "done", "align closed a3 itself");
  assert.deepEqual(doneKinds(rd.w.scan()), [], "auto-closed by --prev: no review alert");
});

test("round-done: accepted / dropped never alert", async () => {
  await align("round", "done", "rd", "a4", "visual=false", "result=r");
  assert.deepEqual(doneKinds(rd.w.scan()), ["a4"]);
  await align("round", "accept", "rd", "a4");
  assert.deepEqual(doneKinds(rd.w.scan()), []);
  await align("round", "set", "rd", "a2", "status=dropped", "result=不做了");
  assert.deepEqual(doneKinds(rd.w.scan()), []);
});

test("round-done: version-2 pages never alert round-done", async () => {
  const v2 = (sec) => snapshotOf({ version: 2, name: "v2", title: "旧页", items: [{ id: "r", sec, who: "agent", title: "t", updated: sec }] });
  assert.deepEqual(pageAlerts("v2", v2("doing"), v2("done")), []);
  assert.deepEqual(pageAlerts("v2", null, v2("done")), []);
});

test("round-done: a page registered after the baseline alerts its done rounds, except one auto-closed by --prev", async () => {
  const data = A.parsePage(fs.readFileSync(rdPage, "utf8"));
  data.name = "rd-late";
  const file = path.join(STORE, "rd-late.html");
  fs.writeFileSync(file, A.render(data));
  const reg = A.readRegistry();
  reg["rd-late"] = file;
  fs.writeFileSync(path.join(STORE, "pages.json"), JSON.stringify(reg, null, 2));
  const p = rd.w.scan();
  // done there: base-done, a1 (a2 points at it: auto-closed rule), a3 (a4 points at it); a4 accepted, a2 dropped
  assert.deepEqual(doneKinds(p), ["base-done"]);
  assert.equal(p.alerts.find((a) => a.kind === "round-done").page, "rd-late");
  await align("forget", "rd-late");
  rd.w.scan();
});
