// stuck.test.mjs (2026-11-02): reminders for rounds that stopped with no next step (stuck.js + align.mjs stuckReminders).
// Real align.mjs (ALIGN_SKILL_DIR), temp ALIGN_STORE: a round whose session ended its turn 10+ minutes ago and still says
// doing gets one notice to the page owner, under the dsh-fm notice source (summary 轮次待登记 / 轮次已停); sessions that
// run, wait for subagents / jobs, or were touched by First Mate since are left alone; a reminder is not repeated for the
// same turn end, but is for a new owner; the page is never changed; failures are reported and retried, never swallowed.
// F->P: on the old plugin stuck.js does not exist.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SKILL = process.env.ALIGN_SKILL_DIR ?? path.join(PLUGIN, "cli");
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-align-stuck-"));
process.env.ALIGN_STORE = STORE;
process.env.ALIGN_WORKSPACES = path.join(STORE, "workspace.json");
fs.writeFileSync(process.env.ALIGN_WORKSPACES, JSON.stringify({ tables: { workspaces: {} } }));
const A = await import(pathToFileURL(path.join(SKILL, "align.mjs")).href);
const stuckJs = path.join(PLUGIN, "stuck.js");
assert.ok(fs.existsSync(stuckJs), "stuck.js missing (stuck-round reminders not implemented): " + stuckJs);
const { createStuckRunner, noticeSource } = await import(pathToFileURL(stuckJs).href);

const T = (hm) => "2026-11-02T" + hm + ":00+08:00";
const ms = (hm) => Date.parse(T(hm));
const SID = (n) => "session-57c" + n + "0000-0000-4000-8000-000000000000";
function page(name, rounds, extra = {}) {
  const file = path.join(STORE, name + ".html");
  fs.writeFileSync(file, A.render({ version: 3, name, title: "页 " + name, owner: "session-fm", updated: T("01:00"), projects: [], rounds, decisions: [], notes: [], ...extra }));
  // only this page is registered: each test sees its own page
  fs.writeFileSync(path.join(STORE, "pages.json"), JSON.stringify({ [name]: file }));
  return file;
}
const round = (id, n, extra) => ({ id, title: "轮 " + id, status: "doing", sid: SID(n), updated: T("01:00"), ...extra });
function runner({ live, turns, clock, send, logs = [], graceMs = 0 }) {
  return createStuckRunner({
    readRegistry: A.readRegistry, pageData: A.pageData, stuckReminders: A.stuckReminders, stuckReminderText: A.stuckReminderText, stuckSummary: A.stuckSummary,
    live: async (sids) => Object.fromEntries(sids.map((s) => [s, live[s] ?? "idle"])),
    lastTurn: async (sid) => { const t = turns[sid]; if (t instanceof Error) throw t; return t ?? null; },
    send, now: () => clock.t, graceMs, log: (l) => logs.push(l),
  });
}

test("a delivered round stopped for 10 minutes: one notice to the owner, under the dsh-fm source; running / waiting / touched rounds left alone", async () => {
  const file = page("sa", [round("a", 1), round("b", 2), round("c", 3), round("d", 4, { updated: T("02:05") }), round("e", 5, { status: "paused" })]);
  const before = fs.readFileSync(file, "utf8");
  const sent = [];
  const clock = { t: ms("02:09") };
  const turns = { [SID(1)]: { at: ms("02:00"), kind: "completed" }, [SID(4)]: { at: ms("02:00"), kind: "completed" }, [SID(5)]: { at: ms("01:00"), kind: "completed" } };
  const r = runner({ live: { [SID(2)]: "running", [SID(3)]: "subagent" }, turns, clock, send: async (sid, text, summary) => { sent.push({ sid, text, summary }); } });
  assert.deepEqual(await r.run(), [], "9 minutes: not yet");
  clock.t = ms("02:11");
  assert.deepEqual(await r.run(), [{ page: "sa", id: "a", sid: SID(1), to: "session-fm" }]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sid, "session-fm");
  assert.equal(sent[0].summary, "轮次待登记");
  assert.deepEqual(sent[0].text.split("\n").slice(0, 2), ["[fm] 轮次待登记", "sid: " + SID(1)]);
  assert.deepEqual(noticeSource(sent[0].summary), { kind: "plugin:dsh-fm", form: "notice", summary: "轮次待登记" }, "drawn like a dsh-fm notice");
  assert.deepEqual(await r.run(), [], "same turn end: not twice");
  clock.t = ms("02:16");
  assert.deepEqual((await r.run()).map((x) => x.id), ["d"], "First Mate touched d at 02:05: counted from there");
  assert.equal(fs.readFileSync(file, "utf8"), before, "the page is never changed");
  assert.equal(r.errors(), null);
  turns[SID(1)] = { at: ms("02:20"), kind: "interrupted" };
  clock.t = ms("02:31");
  const again = await r.run();
  assert.deepEqual(again.map((x) => x.id), ["a"], "the session ran another turn and stopped again: remind again");
  assert.equal(sent.at(-1).summary, "轮次已停");
  assert.match(sent.at(-1).text, /回合被打断/);
  assert.throws(() => noticeSource(""), /summary/);
});

test("a new First Mate (page owner) gets its own reminder; a failing send or unreadable log is reported once and retried", async () => {
  const file = page("sb", [round("a", 6)]);
  const sent = [], logs = [];
  let broken = true;
  const clock = { t: ms("03:00") };
  const turns = { [SID(6)]: new Error("session log unreadable") };
  const r = runner({ live: {}, turns, clock, logs, send: async (sid, text, summary) => { if (broken) throw new Error("会话 " + sid + " 已归档"); sent.push(sid); } });
  assert.deepEqual(await r.run(), [], "unknown turn: no guess");
  assert.deepEqual(r.errors().map((e) => [e.item, e.message]), [["sb/" + SID(6), "session log unreadable"]]);
  turns[SID(6)] = { at: ms("02:00"), kind: "completed" };
  assert.deepEqual(await r.run(), []);
  assert.deepEqual(r.errors().map((e) => e.item), ["sb/a"]);
  await r.run();
  assert.equal(logs.filter((l) => l.includes("sb/a")).length, 1, "the same failure is logged once");
  broken = false;
  assert.deepEqual((await r.run()).map((x) => x.to), ["session-fm"]);
  assert.equal(r.errors(), null);
  fs.writeFileSync(file, A.render({ ...A.pageData("sb"), owner: "session-fm2" }));
  assert.deepEqual((await r.run()).map((x) => x.to), ["session-fm2"], "handed over: the new First Mate hears it too");
  assert.deepEqual(await r.run(), []);
  assert.deepEqual(sent, ["session-fm", "session-fm2"]);
});

test("nothing during the boot grace (sessions cut by a restart are still waking up); factory fails loud", async () => {
  page("sc", [round("a", 7)]);
  const clock = { t: ms("04:00") };
  const sent = [];
  const r = runner({ live: {}, turns: { [SID(7)]: null }, clock, graceMs: 5 * 60_000, send: async (sid) => { sent.push(sid); } });
  assert.deepEqual(await r.run(), []);
  clock.t = ms("04:06");
  assert.deepEqual((await r.run()).filter((x) => x.page === "sc").map((x) => x.id), ["a"]);
  assert.throws(() => createStuckRunner({ readRegistry: A.readRegistry }), /must be a function/);
});
