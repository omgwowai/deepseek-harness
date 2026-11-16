// /alignment/curio (curio.js, 2026-11-08): the Curio band's view from dsh-personal-agent's state file, the session's Goal,
// live / work and today's request log; the loader entry lookup; reading the tail of a JSONL log; the reader end to end
// with a temp storage dir (no resident session / no state file / no plugin -> null; a changed loader or goals service throws).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { curioView, curioReader, curioHandler, personalConfig, tailRows, dayKey, CHILD_WINDOW_MS } from "../curio.js";

const SID = "session-c", NOW = Date.parse("2026-11-08T02:00:00+08:00");
const base = () => ({ version: 1, active: SID, cooldowns: { "opencode-go/beam-free": { until: NOW + 6 * 3600e3 }, "opencode-go/old": { until: NOW - 1 } }, sessions: { [SID]: { role: "resident", hold: null, stopped: null, private: false, goal: { id: "g1", at: NOW - 600e3, evidence: "memory/e.json" } } } });
const goal = (o = {}) => ({ id: "g1", objective: "[目标] 第一行\n第二行", phase: "active", roundsStarted: 3, maxGoalRounds: 20, ...o });
const rows = [
  { kind: "request", sid: SID, served: "opencode-go/beam-free", paid: false, at: new Date(NOW - 900e3).toISOString() },
  { kind: "request", sid: SID, served: "opencode-crouton/crouton-alpha-free", paid: false, at: new Date(NOW - 60e3).toISOString() },
  { kind: "request", sid: "kid1", source: "child", parent: SID, served: "opencode-crouton/crouton-alpha-free", at: new Date(NOW - 30e3).toISOString() },
  { kind: "request", sid: "kid2", source: "child", parent: SID, served: "opencode-crouton/crouton-alpha-free", at: new Date(NOW - 20e3).toISOString() },
  { kind: "request", sid: "kid3", source: "child", parent: SID, served: "opencode-go/iceman-contributor-free", at: new Date(NOW - CHILD_WINDOW_MS - 1).toISOString() },
  { kind: "request", sid: "x", source: "script", served: "opencode-go/beam-free", at: new Date(NOW).toISOString() },
  { kind: "schedule", action: "child", sid: SID },
];
const view = (o = {}) => curioView({ state: base(), goal: goal(), live: "subagent", work: { subagents: [{}, {}, {}], jobs: [] }, rows, cap: 32, now: NOW, ...o });

test("curioView: running goal, subagents, main / child models, cooling", () => {
  assert.deepEqual(view(), {
    sid: SID, state: "running", live: "subagent", private: false, pause: null, subagents: 3, cap: 32,
    goal: { objective: "第一行\n第二行", phase: "active", round: 3, max: 20, since: NOW - 600e3, evidence: "memory/e.json" },
    models: { main: { model: "crouton-alpha-free", paid: false, at: new Date(NOW - 60e3).toISOString() }, children: [{ model: "crouton-alpha-free", n: 2 }] },
    cooling: [{ model: "beam-free", until: NOW + 6 * 3600e3 }],
  });
});

test("curioView: paused / blocked / complete / stopped / idle / unloaded / private / not resident", () => {
  const s = base(); s.sessions[SID].hold = { reason: "免费模型都在冷却", until: NOW + 3600e3 };
  assert.deepEqual([view({ state: s }).state, view({ state: s }).pause], ["paused", { reason: "免费模型都在冷却", until: NOW + 3600e3 }]);
  assert.deepEqual([view({ goal: goal({ phase: "paused" }) }).state, view({ goal: goal({ phase: "paused" }) }).pause], ["paused", { reason: null, until: null }]);
  const b = view({ goal: goal({ phase: "blocked", blockedReason: { code: "x", message: "同一个障碍连续 3 轮" } }) });
  assert.deepEqual([b.state, b.pause], ["blocked", { reason: "同一个障碍连续 3 轮", until: null }]);
  assert.equal(view({ goal: goal({ phase: "complete" }) }).state, "complete");
  const st = base(); st.sessions[SID].stopped = { why: "pause-msg", reason: "收到「[暂停]」消息" };
  assert.deepEqual([view({ state: st }).state, view({ state: st }).pause.reason], ["stopped", "收到「[暂停]」消息"]);
  assert.deepEqual([view({ goal: null, live: "idle" }).state, view({ goal: null, live: "idle" }).goal], ["idle", null]);
  assert.equal(view({ goal: null, live: "running" }).state, "running");
  assert.equal(view({ goal: null, live: "idle", loaded: false }).state, "unloaded", "not loaded since a restart: the goal is unknown");
  const p = base(); p.sessions[SID].private = true;
  assert.deepEqual([view({ state: p }).private, view({ state: p }).goal.objective, view({ state: p }).goal.evidence], [true, null, null], "private: no goal text");
  const other = base(); other.sessions[SID].goal.id = "g0";
  assert.equal(view({ state: other }).goal.since, null, "the plugin's record is for another goal");
  const r = base(); r.sessions[SID].role = "retired";
  assert.equal(view({ state: r }), null);
  assert.equal(view({ state: { ...base(), active: null } }), null);
});

test("personalConfig: the dsh-personal-agent entry's config; none / disabled -> null; changed loader throws", () => {
  const loader = (es) => ({ entries: function* () { yield* es; } });
  assert.deepEqual(personalConfig(loader([{ options: { name: "dsh-alignment" } }, { options: { name: "dsh-personal-agent", config: { childCap: 32 } } }])), { childCap: 32 });
  assert.equal(personalConfig(loader([{ options: { name: "dsh-personal-agent", disabled: true, config: {} } }])), null);
  assert.equal(personalConfig(loader([])), null);
  assert.throws(() => personalConfig(undefined), /loader service has no entries/);
});

test("tailRows: last bytes only, cut first line dropped, bad lines skipped, missing file -> []", () => {
  const d = mkdtempSync(join(tmpdir(), "curio-tail-"));
  const f = join(d, "x.jsonl");
  writeFileSync(f, [JSON.stringify({ a: "x".repeat(100) }), JSON.stringify({ n: 1 }), "{bad", JSON.stringify({ n: 2 }), ""].join("\n"));
  assert.deepEqual(tailRows(f, 40), [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(tailRows(join(d, "none.jsonl")), []);
});

test("curioReader + handler: temp storage dir end to end; no state / no plugin -> null; goals of a changed shape throw -> 500", async () => {
  const d = mkdtempSync(join(tmpdir(), "curio-read-"));
  const loader = (cfg) => () => ({ entries: function* () { if (cfg) yield { options: { name: "dsh-personal-agent", config: cfg } }; } });
  const agents = { get: (sid) => (sid === SID ? { id: "agent" } : undefined) };
  const deps = { agents, live: async (s) => ({ [s[0]]: "running" }), work: async () => ({}), now: () => NOW };
  const read = (o) => curioReader({ loader: loader({ storageDir: d, childCap: 32 }), goals: () => ({ get: () => goal() }), ...deps, ...o });
  assert.equal(await read()(), null, "no state file yet");
  writeFileSync(join(d, "state.json"), JSON.stringify(base()));
  writeFileSync(join(d, dayKey(NOW) + ".jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const v = await read()();
  assert.deepEqual([v.state, v.cap, v.subagents, v.goal.round, v.models.main.model], ["running", 32, 0, 3, "crouton-alpha-free"]);
  assert.equal(await read({ loader: loader(null) })(), null, "profile without the personal plugin");
  assert.equal((await read({ goals: () => undefined })()).goal, null, "no goals service: no goal");
  await assert.rejects(read({ goals: () => ({}) })(), /goals\.get is not a function/);
  assert.throws(() => curioReader({ loader: () => null, goals: () => undefined, agents: {}, live: deps.live, work: deps.work }), /ctx\.agents\.get/);
  // handler: fence first, then 200 / 500 with the message
  const res = () => { const r = { code: 0, body: null, writeHead(c) { r.code = c; }, end(b) { r.body = JSON.parse(b); } }; return r; };
  const denied = res();
  await curioHandler({ guard: () => ({ code: 401, message: "需要先登录 DSH" }), read: read() })({ method: "GET" }, denied);
  assert.deepEqual([denied.code, denied.body.ok], [401, false]);
  const ok = res();
  await curioHandler({ guard: () => null, read: read() })({ method: "GET" }, ok);
  assert.deepEqual([ok.code, ok.body.api, ok.body.curio.sid], [200, 1, SID]);
  const bad = res();
  const err = console.error; console.error = () => {};
  try { await curioHandler({ guard: () => null, read: read({ goals: () => ({}) }) })({ method: "GET" }, bad); } finally { console.error = err; }
  assert.equal(bad.code, 500);
  assert.match(bad.body.message, /^读不到 Curio 的状态：.*goals\.get/);
});
