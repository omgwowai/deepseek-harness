// Core tests for the First Mate refresh (fm-refresh.js): the dsh-fm rule for the new session, waiting for idle
// (turn, subagent, subagent job, inbox, 5 s quiet), the four steps in order and every step's failure, cancel, a page
// reload (a second runner on the same record file) keeping the state and running the steps once, a restart mid-step.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootPrompt, busyOf, createRefresher, createRequestFor, moveReminders, recordStore, scheduleShape, QUIET_MS } from "../fm-refresh.js";
import { createFmResolver } from "../fm/current.js";

const OLD = "session-old";
const NEW = "session-new";

/** Manual clock + timers: advance(ms) fires due timers in order and lets their promises settle. */
function clock() {
  let t = Date.parse("2026-10-23T12:00:00Z");
  const timers = new Map();
  let seq = 0;
  const settle = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        await settle();
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
      }
      t = end;
      await settle();
    },
    settle,
  };
}

function harness({ busy = () => [], fail = {}, file } = {}) {
  const dir = file ? null : mkdtempSync(join(tmpdir(), "fm-refresh-"));
  const store = recordStore(file ?? join(dir, "fm-refresh.json"));
  const c = clock();
  const calls = [];
  const step = (name, value) => async (...args) => { calls.push(name + (args.length ? ":" + args.join(",") : "")); if (fail[name]) throw new Error(fail[name]); return value; };
  const deps = {
    store, page: "first-mate", now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, pollMs: 1000, quietMs: QUIET_MS,
    currentFm: async () => ({ sid: OLD, title: "first mate" }),
    busy: async (sid) => busy(sid),
    prompt: (old) => "boot " + old,
    createFm: step("create", NEW),
    waitFm: step("waitFm"),
    setOwner: step("owner"),
    moveReminders: step("schedules", [{ from: "r1", to: "r2" }]),
    archive: step("archive"),
  };
  return { deps, store, c, calls, dir, make: () => createRefresher(deps), cleanup: () => dir && rmSync(dir, { recursive: true, force: true }) };
}

test("idle First Mate: the four steps run in order after 5 s of quiet, record ends done", async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const r = h.make();
  const req = await r.request();
  assert.equal(req.created, true);
  assert.equal(req.record.state, "waiting");
  await h.c.advance(QUIET_MS - 1500);
  assert.deepEqual(h.calls, [], "not before the quiet window");
  await h.c.advance(3000);
  assert.deepEqual(h.calls, ["create:boot " + OLD, "waitFm:" + NEW, "owner:" + NEW, "schedules:" + OLD + "," + NEW, "schedules:" + OLD + "," + NEW, "archive:" + OLD], "reminders are moved again right before the archive");
  const rec = h.store.read();
  assert.equal(rec.state, "done");
  assert.equal(rec.newSid, NEW);
  assert.deepEqual(rec.moved, [{ from: "r1", to: "r2" }, { from: "r1", to: "r2" }], "the stub answers the same both times; moves of the second run are appended");
  r.dispose();
});

test("First Mate running a turn: waits, then refreshes on its own once the turn ends (no timeout)", async (t) => {
  let running = true;
  const h = harness({ busy: () => (running ? [{ kind: "turn" }] : []) });
  t.after(h.cleanup);
  const r = h.make();
  await r.request();
  await h.c.advance(60 * 60 * 1000);
  assert.deepEqual(h.calls, [], "still waiting after an hour");
  assert.equal(r.get().state, "waiting");
  assert.deepEqual(r.get().busy, [{ kind: "turn" }], "the page can show why");
  running = false;
  r.touch(OLD);
  await h.c.advance(QUIET_MS + 2000);
  assert.equal(h.calls[0], "create:boot " + OLD);
  assert.equal(r.get().state, "done");
  r.dispose();
});

test("a subagent still running (or its job), or a queued message: keeps waiting; between two turns it runs in the idle gap", async (t) => {
  let state = "subagent";
  const h = harness({ busy: () => (state === "subagent" ? [{ kind: "subagent", items: [{ id: "c1" }] }] : state === "job" ? [{ kind: "subagent-job", items: [{ id: "j1" }] }] : state === "inbox" ? [{ kind: "inbox", items: [{ count: 1 }] }] : []) });
  t.after(h.cleanup);
  const r = h.make();
  await r.request();
  await h.c.advance(20_000);
  state = "job";
  await h.c.advance(20_000);
  state = "inbox";
  await h.c.advance(20_000);
  assert.deepEqual(h.calls, []);
  // idle for 3 s, then a new turn starts (an [fm] notice): the clock restarts, nothing runs
  state = "idle";
  await h.c.advance(3000);
  state = "subagent";
  r.touch(OLD);
  await h.c.advance(20_000);
  assert.deepEqual(h.calls, []);
  state = "idle";
  r.touch(OLD);
  await h.c.advance(QUIET_MS + 2000);
  assert.equal(r.get().state, "done");
  r.dispose();
});

test("re-check before archiving: the old one woke up after the new one took over -> archive-waiting, archived at its next idle moment", async (t) => {
  let wake = false;
  const h = harness({ busy: () => (wake ? [{ kind: "turn" }] : []) });
  h.deps.moveReminders = async (...a) => { h.calls.push("schedules"); wake = true; return []; };
  t.after(h.cleanup);
  const r = h.make();
  await r.request();
  await h.c.advance(QUIET_MS + 2000);
  assert.equal(r.get().state, "archive-waiting");
  assert.ok(!h.calls.some((c) => c.startsWith("archive")));
  assert.equal(r.cancel(r.get().id).ok, false, "no cancel once the new one exists");
  wake = false;
  await h.c.advance(QUIET_MS + 2000);
  assert.equal(h.calls.filter((c) => c.startsWith("create")).length, 1, "create ran once");
  assert.equal(h.calls.at(-1), "archive:" + OLD);
  assert.equal(r.get().state, "done");
  r.dispose();
});

for (const [name, at] of [["create", 0], ["waitFm", 1], ["owner", 2], ["schedules", 3], ["archive", 5]]) {
  test("step " + name + " fails: stops there with the raw error, later steps never run", async (t) => {
    const h = harness({ fail: { [name]: "原始错误 " + name } });
    t.after(h.cleanup);
    const r = h.make();
    await r.request();
    await h.c.advance(QUIET_MS + 2000);
    const rec = h.store.read();
    assert.equal(rec.state, "failed");
    assert.equal(rec.step, name === "waitFm" ? "create" : name);
    assert.equal(rec.error, "原始错误 " + name);
    assert.equal(h.calls.length, at + 1, h.calls.join(" | "));
    if (name === "schedules") assert.ok(!h.calls.some((c) => c.startsWith("archive")), "a failed reminder move never archives");
    await h.c.advance(60_000);
    assert.equal(h.calls.length, at + 1, "no retry");
    r.dispose();
  });
}

test("cancel while waiting: nothing runs; one request at a time, a repeated click returns the active record", async (t) => {
  const h = harness({ busy: () => [{ kind: "turn" }] });
  t.after(h.cleanup);
  const r = h.make();
  const first = await r.request();
  const again = await r.request();
  assert.equal(again.created, false);
  assert.equal(again.record.id, first.record.id);
  assert.equal(r.cancel("other-id").ok, false);
  const c = r.cancel(first.record.id);
  assert.equal(c.ok, true);
  assert.equal(c.record.state, "cancelled");
  await h.c.advance(60_000);
  assert.deepEqual(h.calls, []);
  const next = await r.request();
  assert.equal(next.created, true, "a new request after cancel");
  assert.notEqual(next.record.id, first.record.id);
  r.dispose();
});

test("a failed record (e.g. read back at startup) can be dismissed; failed or dismissed never blocks the next refresh", async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const failed = { id: "rec-0241", oldSid: OLD, oldTitle: "first mate", page: "first-mate", state: "failed", step: "schedules", newSid: NEW, error: "迁移后核对不一致", createdAt: "2026-10-25T18:41:43.945Z", updatedAt: "2026-10-25T18:41:53.175Z" };
  h.store.write(failed);
  const r = h.make();
  assert.equal(r.get().state, "failed");
  assert.equal(r.dismiss("other-id").ok, false, "wrong id");
  const d = r.dismiss(failed.id);
  assert.equal(d.ok, true);
  assert.equal(d.record.state, "dismissed");
  assert.equal(d.record.error, failed.error, "keeps the raw error");
  assert.equal(h.store.read().state, "dismissed", "written to the record file");
  assert.equal(r.dismiss(failed.id).ok, false, "only a failed record");
  r.dispose();
  // A restart reads it back as dismissed (the page shows nothing), and the next refresh starts as usual.
  const again = h.make();
  assert.equal(again.get().state, "dismissed");
  const next = await again.request();
  assert.equal(next.created, true, "a dismissed record does not block a refresh");
  assert.equal(next.record.state, "waiting");
  assert.equal(again.dismiss(next.record.id).ok, false, "a waiting record cannot be dismissed");
  again.dispose();
  // A failed record (not dismissed) does not block one either.
  h.store.write(failed);
  const third = h.make();
  const asked = await third.request();
  assert.equal(asked.created, true, "a failed record does not block a refresh");
  assert.notEqual(asked.record.id, failed.id);
  third.dispose();
});

test("page reload / 3080 restart while waiting: a fresh runner on the same file keeps the state and runs the steps once", async (t) => {
  let running = true;
  const h = harness({ busy: () => (running ? [{ kind: "turn" }] : []) });
  t.after(h.cleanup);
  const r1 = h.make();
  const { record } = await r1.request();
  await h.c.advance(5000);
  r1.dispose();
  const r2 = h.make();
  assert.equal(r2.get().id, record.id);
  assert.equal(r2.get().state, "waiting");
  r2.start();
  running = false;
  await h.c.advance(QUIET_MS + 2000);
  // a third runner (another reload) after it finished: nothing reruns
  const r3 = h.make();
  r3.start();
  await h.c.advance(30_000);
  assert.equal(h.calls.filter((c) => c.startsWith("create")).length, 1);
  assert.equal(r3.get().state, "done");
  r2.dispose(); r3.dispose();
});

test("restart in the middle of a step: the record turns failed instead of repeating it", async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.store.write({ id: "x", oldSid: OLD, page: "first-mate", state: "running", step: "owner", newSid: NEW, createdAt: "t", updatedAt: "t" });
  const r = h.make();
  assert.equal(r.get().state, "failed");
  assert.match(r.get().error, /服务重启时刷新停在「改对齐页负责人」这一步/);
  r.start();
  await h.c.advance(30_000);
  assert.deepEqual(h.calls, []);
});

test("busyOf: drops schedule, adds running jobs of subagent descendants and a queued inbox; fails loud on missing services", async () => {
  const header = (parent) => ({ session: { header: parent ? { parentSession: parent, origin: "subagent" } : {} } });
  const agents = new Map([[OLD, { id: OLD, ...header(), inbox: { nextTurn: [], nextStep: [] } }], ["c1", { id: "c1", ...header(OLD) }], ["c2", { id: "c2", ...header("c1") }], ["fork", { id: "fork", session: { header: { parentSession: OLD } } }]]);
  const jobs = { list: (sid) => (sid === "c2" ? [{ id: "j1", owner: "c2", status: "running", label: "build" }, { id: "j0", owner: "c2", status: "completed" }] : sid === "fork" ? [{ id: "jf", owner: "fork", status: "running" }] : []) };
  const host = { waterfall: async (name, payload, base) => { assert.equal(name, "workspace/session-activity"); assert.equal(payload.sessionId, OLD); return [{ kind: "schedule" }, ...(await base())]; }, agents: { get: (id) => agents.get(id), list: () => [...agents.values()] }, jobs };
  assert.deepEqual(await busyOf(host, OLD), [{ kind: "subagent-job", items: [{ id: "j1", label: "build", session: "c2" }] }]);
  agents.get(OLD).inbox.nextStep = [{}];
  assert.deepEqual((await busyOf(host, OLD)).map((b) => b.kind), ["subagent-job", "inbox"]);
  await assert.rejects(busyOf({ ...host, jobs: {} }, OLD), /ctx\.jobs\.list is missing/);
  await assert.rejects(busyOf({ ...host, agents: { get: () => ({ inbox: {} }), list: () => [] } }, OLD), /inbox/);
});

/** 0.2.2-alpha.2 schedule service fake: session-bound reminders, unconditional delete. hooks.afterCreate(n, store) runs after the n-th copy. */
function sessionService({ mutate = (r) => r, failAt = -1, afterCreate = () => {}, afterDelete = () => {} } = {}) {
  const at = { id: "a1", kind: "at", title: "晚上核对", prompt: "跑核对", scheduledAt: "2026-10-24T13:00:00.000Z" };
  const daily = { id: "a2", kind: "daily", title: "早报", prompt: "写早报", time: "09:00:00.000", timeZone: "Asia/Shanghai", scheduledAt: "2026-10-24T01:00:00.000Z" };
  const every = { id: "a3", kind: "every", title: "巡检", prompt: "看一眼", everySeconds: 3600, scheduledAt: "2026-10-23T13:00:00.000Z" };
  const bySession = new Map([[OLD, [at, daily, every]], [NEW, []]]);
  const deletes = [];
  let n = 0;
  const svc = {
    bySession, deletes,
    list: async ({ sessionId }) => [...(bySession.get(sessionId) ?? [])],
    catalog: async () => [...bySession.entries()].flatMap(([sessionId, rs]) => rs.map((r) => ({ ...r, sessionId, status: "active" }))),
    update: async () => { throw new Error("not used"); },
    delete: async ({ sessionId, id }) => {
      deletes.push(id);
      const rs = bySession.get(sessionId) ?? [];
      const i = rs.findIndex((r) => r.id === id);
      if (i < 0) return { id, deleted: false, code: "schedule_not_found" };
      rs.splice(i, 1);
      afterDelete(id, bySession);
      return { id, deleted: true };
    },
    create: async (sid, req) => {
      if (n === failAt) throw new Error("invalid_rule: boom");
      const src = [at, daily, every][n++];
      const made = mutate({ ...src, id: "n" + n, scheduledAt: req.every_seconds ? "2026-10-23T14:00:00.000Z" : src.scheduledAt });
      bySession.get(sid).push(made);
      afterCreate(n, bySession);
      return made;
    },
  };
  return svc;
}

/** 0.2.2-alpha.3 schedule service fake: Host tasks with a target; edit(delete) compares expectedUpdatedAt like the real one. */
function taskService({ afterCreate = () => {} } = {}) {
  const at = { id: "a1", kind: "after", title: "检查重启", prompt: "看", afterSeconds: 60, scheduledAt: "2026-11-05T01:00:00.000Z", status: "active", updatedAt: "2026-11-05T00:00:00.000Z", target: { kind: "session", sessionId: OLD } };
  const daily = { id: "a2", kind: "daily", title: "早报", prompt: "写早报", time: "09:00:00.000", timeZone: "Asia/Shanghai", scheduledAt: "2026-11-06T01:00:00.000Z", status: "active", updatedAt: "2026-11-05T00:00:01.000Z", target: { kind: "session", sessionId: OLD } };
  const paused = { ...daily, id: "a3", status: "paused" };
  const elsewhere = { ...daily, id: "a4", target: { kind: "new", create: {} } };
  const tasks = [at, daily, paused, elsewhere];
  const calls = [];
  let n = 0;
  const svc = {
    tasks, calls,
    catalog: async () => tasks.map((t) => ({ ...t })),
    edit: async (req, actor) => {
      calls.push(["edit", req, actor]);
      const i = tasks.findIndex((t) => t.id === req.id);
      if (i < 0) return { id: req.id, code: "schedule_not_found" };
      if (req.expectedUpdatedAt !== undefined && req.expectedUpdatedAt !== (tasks[i].updatedAt ?? null)) return { id: req.id, code: "schedule_conflict" };
      if (req.action !== "delete") throw new Error("not used");
      tasks.splice(i, 1);
      return { id: req.id, deleted: true };
    },
    create: async (req, actor) => {
      calls.push(["create", req, actor]);
      const src = req.timing.kind === "at" ? at : daily;
      const made = { ...src, id: "n" + ++n, kind: req.timing.kind, title: req.title, prompt: req.prompt, target: req.target, updatedAt: "2026-11-05T00:01:00.000Z" };
      tasks.push(made);
      afterCreate(n, tasks);
      return made;
    },
  };
  return svc;
}
const active = async (svc, sid) => (await svc.catalog()).filter((t) => t.status === "active" && t.target?.kind === "session" && t.target.sessionId === sid);

test("moveReminders (0.2.2-alpha.2): copies checked, then the source reminders are deleted; a create failure or a mismatch throws with what was made", async () => {
  const daily = { time: "09:00:00.000", timeZone: "Asia/Shanghai", kind: "daily", title: "早报", prompt: "写早报" };
  assert.deepEqual(createRequestFor(daily), { title: "早报", prompt: "写早报", daily: { time: "09:00:00.000", time_zone: "Asia/Shanghai" } });
  const ok = sessionService();
  assert.deepEqual(await moveReminders(ok, OLD, NEW), [{ from: "a1", to: "n1" }, { from: "a2", to: "n2" }, { from: "a3", to: "n3" }]);
  assert.deepEqual(ok.bySession.get(OLD), [], "no active reminder left on the old session");
  assert.deepEqual(ok.deletes, ["a1", "a2", "a3"]);
  const bad = sessionService({ mutate: (r) => (r.id === "n2" ? { ...r, prompt: "别的" } : r) });
  await assert.rejects(moveReminders(bad, OLD, NEW), /核对不一致：「早报」内容或下次时间不一致（新会话上已建 n1, n2, n3）/);
  assert.equal(bad.bySession.get(OLD).length, 3, "a failed check deletes nothing");
  await assert.rejects(moveReminders(sessionService({ mutate: (r) => (r.id === "n2" ? { ...r, timeZone: "UTC" } : r) }), OLD, NEW), /「早报」内容或下次时间不一致/, "the rule itself is compared, not only the next run");
  await assert.rejects(moveReminders(sessionService({ failAt: 1 }), OLD, NEW), /迁移提醒失败：invalid_rule: boom（新会话上已建 n1）/);
});

test("moveReminders (0.2.2-alpha.2): a source reminder edited or removed during the copy -> throws, the source keeps the edit, nothing deleted", async () => {
  const edited = sessionService({ afterCreate: (n, s) => { if (n === 2) s.get(OLD)[1] = { ...s.get(OLD)[1], prompt: "改过的" }; } });
  await assert.rejects(moveReminders(edited, OLD, NEW), /「早报」（a2）在迁移期间被改动.*（新会话上已建 n1, n2, n3）/);
  assert.equal(edited.bySession.get(OLD).find((r) => r.id === "a2").prompt, "改过的");
  assert.equal(edited.bySession.get(OLD).length, 2, "a1 deleted before a2 was found edited; a2 and a3 stay");
  const gone = sessionService({ afterCreate: (n, s) => { if (n === 3) s.get(OLD).splice(2, 1); } });
  await assert.rejects(moveReminders(gone, OLD, NEW), /「巡检」（a3）在迁移期间已不在/);
});

test("moveReminders (0.2.2-alpha.2): a later source reminder edited while an earlier one is being deleted -> throws, the edit stays (2026-11-05 recheck)", async () => {
  const svc = sessionService({ afterDelete: (id, s) => { if (id === "a1") { const rs = s.get(OLD); const i = rs.findIndex((r) => r.id === "a2"); rs[i] = { ...rs[i], prompt: "删 a1 时改的" }; } } });
  await assert.rejects(moveReminders(svc, OLD, NEW), /「早报」（a2）在迁移期间被改动/);
  assert.equal(svc.bySession.get(OLD).find((r) => r.id === "a2")?.prompt, "删 a1 时改的", "a2 not deleted: its edit survives");
  assert.deepEqual(svc.deletes, ["a1"]);
});

test("moveReminders (0.2.2-alpha.2): a reminder created on the old session during the move -> throws, not archived by the caller", async () => {
  const extra = { id: "x9", kind: "at", title: "新加的", prompt: "p", scheduledAt: "2026-10-25T00:00:00.000Z" };
  const svc = sessionService({ afterCreate: (n, s) => { if (n === 3) s.get(OLD).push(extra); } });
  await assert.rejects(moveReminders(svc, OLD, NEW), /旧会话又有了提醒 「新加的」（x9）/);
  assert.deepEqual(svc.bySession.get(OLD), [extra]);
});

test("moveReminders (0.2.2-alpha.3): copies with timing + session target, then conditional deletes; the old session has no active task left", async () => {
  const svc = taskService();
  assert.deepEqual(await moveReminders(svc, OLD, NEW), [{ from: "a1", to: "n1" }, { from: "a2", to: "n2" }]);
  assert.deepEqual(svc.calls.filter((c) => c[0] === "create").map(([, req, actor]) => [req.timing, req.target, actor]), [
    [{ kind: "at", at: "2026-11-05T01:00:00.000Z" }, { kind: "session", sessionId: NEW }, NEW],
    [{ kind: "daily", daily: { time: "09:00:00.000", time_zone: "Asia/Shanghai" } }, { kind: "session", sessionId: NEW }, NEW],
  ]);
  assert.deepEqual(svc.calls.filter((c) => c[0] === "edit").map(([, req, actor]) => [req, actor]), [
    [{ id: "a1", action: "delete", expectedUpdatedAt: "2026-11-05T00:00:00.000Z" }, OLD],
    [{ id: "a2", action: "delete", expectedUpdatedAt: "2026-11-05T00:00:01.000Z" }, OLD],
  ]);
  assert.deepEqual(await active(svc, OLD), []);
  assert.deepEqual(svc.tasks.filter((t) => t.status === "paused" || t.target.kind === "new").map((t) => t.id), ["a3", "a4"], "paused and other-target tasks untouched");
});

test("moveReminders (0.2.2-alpha.3): a source task edited during the copy -> schedule_conflict throws, the task keeps its edit", async () => {
  const svc = taskService({ afterCreate: (n, tasks) => { if (n === 2) { const t = tasks.find((x) => x.id === "a2"); t.title = "早报（改）"; t.updatedAt = "2026-11-05T00:05:00.000Z"; } } });
  await assert.rejects(moveReminders(svc, OLD, NEW), /「早报」（a2）在迁移期间被改动.*（新会话上已建 n1, n2）/);
  assert.equal(svc.tasks.find((t) => t.id === "a2").title, "早报（改）");
  const gone = taskService({ afterCreate: (n, tasks) => { if (n === 2) tasks.splice(tasks.findIndex((x) => x.id === "a2"), 1); } });
  await assert.rejects(moveReminders(gone, OLD, NEW), /「早报」（a2）在迁移期间已不在/);
});

test("moveReminders (0.2.2-alpha.3): a task created for the old session during the move -> throws", async () => {
  const svc = taskService({ afterCreate: (n, tasks) => { if (n === 2) tasks.push({ ...tasks[0], id: "x9", title: "新加的", kind: "at", updatedAt: "z", target: { kind: "session", sessionId: OLD } }); } });
  await assert.rejects(moveReminders(svc, OLD, NEW), /旧会话又有了提醒 「新加的」（x9）/);
  assert.deepEqual((await active(svc, OLD)).map((t) => t.id), ["x9"]);
});

test("scheduleShape: the two known method sets; unknown or mixed sets throw (moveReminders and the mount check both use it)", async () => {
  assert.equal(scheduleShape(sessionService()), "session");
  assert.equal(scheduleShape(taskService()), "task");
  class Real { create() {} catalog() {} edit() {} list() {} view() {} }
  assert.equal(scheduleShape(new Real()), "task", "methods on the prototype count (the real service is a class)");
  const unknown = { create() { throw new Error("unused"); }, list: async () => [], catalog: async () => [] };
  assert.throws(() => scheduleShape(unknown), /unknown ctx\.schedule shape \(methods: create, list, catalog\)/);
  await assert.rejects(moveReminders(unknown, OLD, NEW), /unknown ctx\.schedule shape/);
  const mixed = { ...taskService(), update: async () => {} };
  assert.throws(() => scheduleShape(mixed), /unknown ctx\.schedule shape/);
  await assert.rejects(moveReminders(mixed, OLD, NEW), /unknown ctx\.schedule shape/);
  assert.throws(() => scheduleShape(undefined), /unknown ctx\.schedule shape \(methods: none\)/);
});

test("archive step moves reminders again first: ones the old session got while archive-waiting go to the new one; a failure there never archives", async (t) => {
  let wake = false;
  const h = harness({ busy: () => (wake ? [{ kind: "turn" }] : []) });
  let round = 0;
  h.deps.moveReminders = async (from, to) => { round += 1; h.calls.push("schedules:" + from + "," + to); if (round === 1) { wake = true; return [{ from: "r1", to: "r2" }]; } return [{ from: "r3", to: "r4" }]; };
  t.after(h.cleanup);
  const r = h.make();
  await r.request();
  await h.c.advance(QUIET_MS + 2000);
  assert.equal(r.get().state, "archive-waiting");
  wake = false;
  await h.c.advance(QUIET_MS + 2000);
  assert.deepEqual(h.calls.slice(-2), ["schedules:" + OLD + "," + NEW, "archive:" + OLD]);
  assert.equal(r.get().state, "done");
  assert.deepEqual(r.get().moved, [{ from: "r1", to: "r2" }, { from: "r3", to: "r4" }]);
  r.dispose();

  const h2 = harness();
  t.after(h2.cleanup);
  let n = 0;
  h2.deps.moveReminders = async () => { n += 1; h2.calls.push("schedules"); if (n === 2) throw new Error("旧会话的提醒「x」在迁移期间被改动"); return []; };
  const r2 = h2.make();
  await r2.request();
  await h2.c.advance(QUIET_MS + 2000);
  assert.equal(r2.get().state, "failed");
  assert.equal(r2.get().step, "schedules");
  assert.match(r2.get().error, /被改动/);
  assert.ok(!h2.calls.some((c) => c.startsWith("archive")), "never archived");
  r2.dispose();
});

test("bootPrompt: fills placeholders; a leftover placeholder throws", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fm-boot-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shipped = readFileSync(new URL("../fm-boot-prompt.md", import.meta.url), "utf8");
  const text = bootPrompt(new URL("../fm-boot-prompt.md", import.meta.url), { oldSid: OLD, page: "first-mate", root: "D:\\fm-home" });
  assert.match(text, /`align ls first-mate`/);
  assert.match(text, /上一任是 session-old/);
  assert.match(text, /`btw\/` 开头的行是没答完的顺便问/);
  assert.match(text, /已接手，N 条进行中、M 条待决定、Q 条没答的顺便问、K 条计划/);
  assert.doesNotMatch(text, /\{\{/);
  assert.ok(shipped.includes("{{oldSid}}"));
  writeFileSync(join(dir, "p.md"), "hi {{nope}}");
  assert.throws(() => bootPrompt(join(dir, "p.md"), {}), /unknown placeholder \{\{nope\}\}/);
});

test("the refreshed session is a First Mate by origin, and becomes current only once registered (the owner step)", async () => {
  const root = "D:\\fm-home";
  const text = (s) => [{ type: "user/message", data: { content: [{ type: "text", text: s }] } }];
  const sessions = {
    [OLD]: { cwd: root, events: text("hi"), updatedAt: 10 },
    // a worker First Mate opened in its own directory: never the current First Mate
    "session-worker": { cwd: root, events: text("<dsh_delegation>\n  <source_thread_id>" + OLD + "</source_thread_id>\n  <input>x</input></dsh_delegation>"), updatedAt: 30 },
    [NEW]: { cwd: root, events: text(bootPrompt(new URL("../fm-boot-prompt.md", import.meta.url), { oldSid: OLD, page: "first-mate", root })), updatedAt: 20 },
  };
  const archived = [];
  let owner = OLD; // the page owner = the registration
  const host = {
    sessionController: {
      inspect: async (sid) => ({ meta: { cwd: sessions[sid].cwd }, events: sessions[sid].events }),
      list: async () => Object.entries(sessions).map(([sessionId, s]) => ({ sessionId, cwd: s.cwd, updatedAt: s.updatedAt, blank: false, title: sessionId === NEW ? "first mate" : "x" })),
    },
    workspaceRegistry: { get archivedSessionIds() { return archived; } },
    // current() / registeredFm() read the registered session alone; the title comes from its projections.
    get: (name) => (name === "sessionQuery" ? { observeSession: async (sid) => {
      if (!(sid in sessions)) throw Object.assign(new Error("not found " + sid), { code: "SESSION_QUERY_SESSION_NOT_FOUND" });
      return { header: { id: sid, cwd: sessions[sid].cwd }, projections: { values: { title: sid === NEW ? "first mate" : "x" } }, [Symbol.dispose]() {} };
    } } : undefined),
  };
  const fm = createFmResolver(host, { root, registered: () => owner });
  assert.equal(await fm.isFmSession(NEW), true);
  assert.equal(await fm.isFmSession("session-worker"), false);
  // Created but not registered yet: still the old one, although NEW is a First Mate by origin.
  assert.equal((await fm.current()).sid, OLD);
  owner = NEW; // refresh step "owner"
  assert.deepEqual(await fm.current(), { sid: NEW, title: "first mate" });
  assert.equal(await fm.isCurrentFm(OLD), false);
  // The registered one archived: an error, never a fallback to OLD (unarchived, under root).
  archived.push(NEW);
  await assert.rejects(fm.current(), /no current First Mate: the registered session-new is archived/);
  // ...but the refresh still finds what to replace: the registration, flagged archived.
  assert.deepEqual(await fm.registeredFm(), { sid: NEW, title: "first mate", archived: true });
  owner = undefined;
  await assert.rejects(fm.registeredFm(), /no First Mate registered/);
});
