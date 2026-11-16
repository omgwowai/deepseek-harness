// timeouts.test.mjs: decision deadlines (timeouts.js, page api 7, 2026-10-22). Real align.mjs (ALIGN_SKILL_DIR), temp
// ALIGN_STORE: the runner answers a due decision with its recommendation once, reminds once when it must not (high risk,
// no recommendation), leaves not-yet-due ones alone, and a failing send is reported in errors() and retried, never
// swallowed. F->P: on the old plugin timeouts.js does not exist.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SKILL = process.env.ALIGN_SKILL_DIR ?? path.join(PLUGIN, "cli");
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-align-timeouts-"));
process.env.ALIGN_STORE = STORE;
process.env.ALIGN_WORKSPACES = path.join(STORE, "workspace.json");
fs.writeFileSync(process.env.ALIGN_WORKSPACES, JSON.stringify({ tables: { workspaces: {} } }));
const A = await import(pathToFileURL(path.join(SKILL, "align.mjs")).href);
const timeoutsJs = path.join(PLUGIN, "timeouts.js");
assert.ok(fs.existsSync(timeoutsJs), "timeouts.js missing (decision deadlines not implemented): " + timeoutsJs);
const { createTimeoutRunner } = await import(pathToFileURL(timeoutsJs).href);

const T = (h) => "2026-10-23T" + h + ":00:00+08:00";
const opt = [{ label: "甲", effect: "a" }, { label: "乙", effect: "b" }];
const dec = (id, extra) => ({ id, title: "决定 " + id, why: "w", opt, status: "open", risk: "中", cat: "其他", rec: "甲", opened: T("01"), due: T("09"), updated: T("01"), ...extra });
function page(name, decisions) {
  const file = path.join(STORE, name + ".html");
  fs.writeFileSync(file, A.render({ version: 3, name, title: "页 " + name, owner: "sess-owner", updated: T("01"), projects: [], rounds: [], notes: [], decisions }));
  const regFile = path.join(STORE, "pages.json");
  const reg = fs.existsSync(regFile) ? JSON.parse(fs.readFileSync(regFile, "utf8")) : {};
  fs.writeFileSync(regFile, JSON.stringify({ ...reg, [name]: file }));
  return file;
}
const runner = (send, clock, logs = []) => createTimeoutRunner({
  readRegistry: A.readRegistry, pageData: A.pageData, timeoutCheck: A.timeoutCheck, answerTimeout: A.answerTimeout, remindOverdue: A.remindOverdue,
  send, now: () => clock.t, log: (l) => logs.push(l),
});
const D = (name, id) => A.pageData(name).decisions.find((x) => x.id === id);

test("due decisions: recommendation answered once, high risk / no recommendation reminded once, later ones left alone", async () => {
  const { rec: _r, ...norec } = dec("norec");
  page("tm", [dec("auto"), dec("high", { risk: "高" }), norec, dec("later", { due: T("12") })]);
  const sent = [];
  const clock = { t: Date.parse(T("10")) };
  const r = runner(async (sid, prompt, card) => { sent.push({ sid, prompt, card }); }, clock);
  assert.deepEqual(await r.run(), [{ page: "tm", id: "auto", action: "auto" }, { page: "tm", id: "high", action: "remind", why: "high" }, { page: "tm", id: "norec", action: "remind", why: "no-rec" }]);
  assert.deepEqual(sent.map((s) => [s.sid, s.prompt.split("\n")[0]]), [
    ["sess-owner", "对齐页「页 tm」上一条决定超时，已按推荐处理：决定 auto（auto）"],
    ["sess-owner", "对齐页「页 tm」上一条决定已超时，没有自动处理：决定 high（high）"],
    ["sess-owner", "对齐页「页 tm」上一条决定已超时，没有自动处理：决定 norec（norec）"],
  ]);
  assert.deepEqual(sent[0].card.decisions, [{ title: "决定 auto", choice: "甲（超时按推荐）", note: "" }]);
  assert.deepEqual([D("tm", "auto").status, D("tm", "auto").auto, D("tm", "auto").autoAt], ["sent", "timeout", T("10")]);
  assert.deepEqual([D("tm", "high").status, D("tm", "high").overdue, D("tm", "norec").overdue], ["open", T("10"), T("10")]);
  assert.equal(r.errors(), null);
  assert.deepEqual(await r.run(), [], "nothing twice");
  assert.equal(sent.length, 3);
  clock.t = Date.parse(T("13"));
  assert.deepEqual(await r.run(), [{ page: "tm", id: "later", action: "auto" }]);
});

test("a failing send leaves the page unchanged, is reported once and retried until it works", async () => {
  page("tf", [dec("x")]);
  const before = fs.readFileSync(path.join(STORE, "tf.html"), "utf8");
  const logs = [];
  let broken = true;
  const sent = [];
  const r = runner(async (sid, prompt) => { if (broken) throw new Error("会话 sess-owner 已归档"); sent.push(prompt); }, { t: Date.parse(T("10")) }, logs);
  assert.deepEqual(await r.run(), []);
  assert.deepEqual(r.errors().map((e) => [e.item, e.message]), [["tf/x", "会话 sess-owner 已归档"]]);
  assert.equal(fs.readFileSync(path.join(STORE, "tf.html"), "utf8"), before);
  await r.run();
  assert.equal(logs.filter((l) => l.includes("tf/x")).length, 1, "the same failure is logged once");
  broken = false;
  assert.deepEqual(await r.run(), [{ page: "tf", id: "x", action: "auto" }]);
  assert.equal(r.errors(), null);
  assert.equal(sent.length, 1);
});

test("an unreadable page is reported and does not stop the others; factory fails loud", async () => {
  page("ok2", [dec("y")]);
  const bad = path.join(STORE, "bad.html");
  fs.writeFileSync(bad, "<html>没有数据块</html>");
  fs.writeFileSync(path.join(STORE, "pages.json"), JSON.stringify({ ...A.readRegistry(), bad }));
  const r = runner(async () => {}, { t: Date.parse(T("10")) });
  assert.deepEqual(await r.run(), [{ page: "ok2", id: "y", action: "auto" }]);
  assert.match(r.errors().find((e) => e.item === "bad").message, /align-data/);
  assert.throws(() => createTimeoutRunner({ readRegistry: A.readRegistry }), /must be a function/);
});
