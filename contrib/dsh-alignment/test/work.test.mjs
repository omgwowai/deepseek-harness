// 对齐页「正在执行的子 agent / 后台任务」（2026-10-24）：服务端 sessionWork、/data 的 work、手机 data:3 的 data.work。
// 0 个、1 个、多个子 agent；子 agent 和后台任务同时有；名字取不到；开始时间取不到；宿主形状变了就报错。
// 页面上的显示见 work-browser.test.mjs。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "align-work-"));
process.env.ALIGN_STORE = dir;
process.env.ALIGN_WORKSPACES = path.join(dir, "workspace.json");
const A = await import("../cli/align.mjs");
const { sessionWork, createPhoneBridge, liveStates } = await import("../index.js");

// 假宿主：workspace/session-activity 的清单（按会话），子 agent 会话的 subagentTiming 投影，jobs.get(id, caller) 的 startedAt / kind，
// jobInfo(sid, jobId) = 会话日志里启动这个后台任务的那次调用的 description（todo 索引给）
function host({ activity = {}, timing = {}, started = {}, owner = {}, kinds = {}, info = {} } = {}) {
  const asked = [];
  const waterfall = async (name, payload, base) => {
    assert.equal(name, "workspace/session-activity");
    asked.push(payload.sessionId);
    return [...(activity[payload.sessionId] ?? []), ...(await base())];
  };
  const agents = { get: (id) => (Object.hasOwn(timing, id) ? { status: "running", session: { id } } : undefined) };
  const projections = { stateOf: (session, key) => { assert.equal(key, "subagentTiming"); return timing[session.id]; } };
  const jobs = {
    get: (id, caller) => {
      if (!Object.hasOwn(started, id)) throw new Error("unknown job " + id);
      if (owner[id] !== undefined && owner[id] !== caller) throw new Error("job " + id + " belongs to another session");
      return { id, kind: kinds[id] ?? "pwsh", startedAt: started[id] };
    },
  };
  const jobInfo = async (sid, id) => info[sid + "/" + id] ?? null;
  return { work: sessionWork(agents, jobs, projections, waterfall, jobInfo), asked, agents, jobs, projections, waterfall, jobInfo };
}

const T = 1_792_000_000_000;

test("sessionWork: 0 / 1 / 多个子 agent，和后台任务同时有；只列有东西在跑的会话", async () => {
  const h = host({
    activity: {
      "s-one": [{ kind: "turn" }, { kind: "subagent", items: [{ id: "kid-1", label: "调研上游 jobs API" }] }],
      "s-many": [{ kind: "subagent", items: [{ id: "kid-a", label: "方向 A" }, { id: "kid-b", label: "方向 B" }, { id: "kid-c", label: "方向 C" }] }],
      "s-both": [{ kind: "subagent", items: [{ id: "kid-x", label: "写测试" }] }, { kind: "job", items: [{ id: "pwsh-1", label: "Run full dsh-verify" }] }, { kind: "schedule", items: [{ id: "r1", label: "提醒" }] }],
      "s-idle": [{ kind: "schedule", items: [{ id: "r2" }] }],
    },
    timing: { "kid-1": { settledMs: 0, active: { since: T - 60_000, through: T } }, "kid-a": { settledMs: 5, active: { since: T - 3_000, through: T } }, "kid-b": { settledMs: 0, active: { since: T - 2_000, through: T } }, "kid-c": { settledMs: 0, active: { since: T - 1_000, through: T } }, "kid-x": { settledMs: 0, active: { since: T - 9_000, through: T } } },
    started: { "pwsh-1": T - 120_000 },
    owner: { "pwsh-1": "s-both" },
  });
  const got = await h.work(["s-none", "s-one", "s-many", "s-both", "s-idle"]);
  assert.deepEqual(got, {
    "s-one": { subagents: [{ id: "kid-1", name: "调研上游 jobs API", since: T - 60_000 }], jobs: [] },
    "s-many": { subagents: [{ id: "kid-a", name: "方向 A", since: T - 3_000 }, { id: "kid-b", name: "方向 B", since: T - 2_000 }, { id: "kid-c", name: "方向 C", since: T - 1_000 }], jobs: [] },
    "s-both": { subagents: [{ id: "kid-x", name: "写测试", since: T - 9_000 }], jobs: [{ id: "pwsh-1", name: "Run full dsh-verify", since: T - 120_000, cmd: "Run full dsh-verify" }] },
  }, "0 个（s-none）和只有定时提醒的（s-idle）不列；后台任务按它的主人会话去取开始时间");
  assert.deepEqual(h.asked, ["s-none", "s-one", "s-many", "s-both", "s-idle"], "每个会话问一次宿主");
  assert.deepEqual(A.checkWork(got, ["s-none", "s-one", "s-many", "s-both", "s-idle"]), got, "形状过 checkWork");
});

test("sessionWork: 名字取不到是 null（空白的也算取不到）；开始时间取不到是 null", async () => {
  const h = host({
    activity: { s: [{ kind: "subagent", items: [{ id: "kid-noname" }, { id: "kid-blank", label: "  " }, { id: "kid-unloaded", label: "已卸载" }, { id: "kid-idle", label: "这一轮刚结束" }] }, { kind: "job", items: [{ id: "pwsh-gone", label: "刚结束" }, { id: "pwsh-2" }] }] },
    timing: { "kid-noname": { settledMs: 0, active: { since: T, through: T } }, "kid-blank": { settledMs: 0, active: { since: T, through: T } }, "kid-idle": { settledMs: 10 } },
    started: { "pwsh-2": T - 5 },
  });
  assert.deepEqual(await h.work(["s"]), {
    s: {
      subagents: [{ id: "kid-noname", name: null, since: T }, { id: "kid-blank", name: null, since: T }, { id: "kid-unloaded", name: "已卸载", since: null }, { id: "kid-idle", name: "这一轮刚结束", since: null }],
      jobs: [{ id: "pwsh-gone", name: "刚结束", since: null, cmd: null }, { id: "pwsh-2", name: null, since: T - 5, cmd: null }],
    },
  }, "子 agent 没加载 / 这一轮已结束、后台任务两次读之间被移除：since null");
});

// 2026-10-26：截图里那一行写的是命令原文（pwsh 任务的 label 就是命令），「已运行」也不对（开始时间是对的，见 work-browser 的秒数）
const VERIFY = 'pwsh -NoProfile -File .\\dsh-verify.ps1 *> C:\\Users\\me\\verify-dec.log; "verify exit $LASTEXITCODE"; exit $LASTEXITCODE';
test("sessionWork: 后台任务的名字先用启动它的调用的 description，没有就从命令认；带命令原文 cmd", async () => {
  const h = host({
    activity: { s: [{ kind: "job", items: [{ id: "pwsh-desc", label: VERIFY }, { id: "pwsh-bare", label: VERIFY }, { id: "wf-1", label: "align-review" }, { id: "pwsh-left", label: "node probe.mjs *> p.log" }] }] },
    started: { "pwsh-desc": T - 20_000, "pwsh-bare": T - 90_000, "wf-1": T - 1_000 },
    kinds: { "wf-1": "workflow" },
    info: { "s/pwsh-desc": { kind: "pwsh", desc: "dsh-verify、提交合入 master" }, "s/pwsh-left": { kind: "pwsh", desc: null } },
  });
  assert.deepEqual((await h.work(["s"])).s.jobs, [
    { id: "pwsh-desc", name: "dsh-verify、提交合入 master", since: T - 20_000, cmd: VERIFY },
    { id: "pwsh-bare", name: "完整检查 dsh-verify", since: T - 90_000, cmd: VERIFY },
    { id: "wf-1", name: "align-review", since: T - 1_000, cmd: null },
    { id: "pwsh-left", name: "node probe.mjs", since: null, cmd: "node probe.mjs *> p.log" },
  ], "workflow 没有命令；两次读之间结束的（宿主里没了）按日志里的种类认");
  assert.throws(() => sessionWork(h.agents, h.jobs, h.projections, h.waterfall), /needs jobInfo/);
});

test("sessionWork: 宿主服务缺了或形状变了就报错，不猜", async () => {
  const h = host();
  assert.throws(() => sessionWork(undefined, h.jobs, h.projections, h.waterfall, h.jobInfo), /ctx\.agents\.get/);
  assert.throws(() => sessionWork(h.agents, {}, h.projections, h.waterfall, h.jobInfo), /ctx\.jobs\.get/);
  assert.throws(() => sessionWork(h.agents, h.jobs, {}, h.waterfall, h.jobInfo), /sessionProjections\.stateOf/);
  assert.throws(() => sessionWork(h.agents, h.jobs, h.projections, undefined, h.jobInfo), /ctx\.waterfall/);
  const badTiming = host({ activity: { s: [{ kind: "subagent", items: [{ id: "k" }] }] }, timing: { k: { active: { since: "x" } } } });
  await assert.rejects(badTiming.work(["s"]), /subagentTiming of k has no numeric active\.since/);
  const badJob = host({ activity: { s: [{ kind: "job", items: [{ id: "j" }] }] } });
  badJob.jobs.get = () => ({ id: "j" });
  await assert.rejects(sessionWork(badJob.agents, badJob.jobs, badJob.projections, badJob.waterfall, badJob.jobInfo)(["s"]), /startedAt is undefined/);
  badJob.jobs.get = () => ({ id: "j", startedAt: T });
  await assert.rejects(sessionWork(badJob.agents, badJob.jobs, badJob.projections, badJob.waterfall, badJob.jobInfo)(["s"]), /kind is undefined/);
  const otherOwner = host({ activity: { s: [{ kind: "job", items: [{ id: "j" }] }] }, started: { j: T }, owner: { j: "s-other" } });
  await assert.rejects(otherOwner.work(["s"]), /belongs to another session/, "只吞「unknown job」，别的错误照抛");
  await assert.rejects(host({ activity: { s: [{ kind: "subagent", items: [{ id: 1 }] }] } }).work(["s"]), /item without a string id/);
});

test("checkWork: 只能是问到的会话、每项 {id, name, since}", () => {
  assert.throws(() => A.checkWork(null, ["s"]), /没有返回对象/);
  assert.throws(() => A.checkWork({ x: { subagents: [], jobs: [] } }, ["s"]), /没问到的会话 x/);
  assert.throws(() => A.checkWork({ s: { subagents: [] } }, ["s"]), /subagents\[\] \/ jobs\[\]/);
  assert.throws(() => A.checkWork({ s: { subagents: [{ id: "k", name: 3, since: null }], jobs: [] } }, ["s"]), /子 agent 形状不对/);
  assert.throws(() => A.checkWork({ s: { subagents: [], jobs: [{ id: "j", name: null, since: "1" }] } }, ["s"]), /s 的后台任务 形状不对/);
  assert.throws(() => A.checkWork({ s: { subagents: [], jobs: [{ id: "j", name: null, since: null, cmd: 3 }] } }, ["s"]), /后台任务 形状不对/);
  assert.deepEqual(A.checkWork({ s: { subagents: [], jobs: [{ id: "j", name: "完整检查 dsh-verify", since: T, cmd: "pwsh x" }] } }, ["s"]).s.jobs[0].cmd, "pwsh x", "后台任务可带 cmd");
  assert.deepEqual(A.checkWork({}, ["s"]), {});
});

// 版本 3 页面：两轮，各自一个会话
const page = (name) => ({ version: 3, name, title: "t", owner: "session-fm", updated: new Date(T).toISOString(), projects: [], rounds: [{ id: "r1", title: "一", status: "doing", sid: "s-a" }, { id: "r2", title: "二", status: "doing", sid: "s-b" }], decisions: [], notes: [] });
fs.writeFileSync(path.join(dir, "wk.html"), A.render(page("wk")));
fs.writeFileSync(path.join(dir, "pages.json"), JSON.stringify({ wk: path.join(dir, "wk.html") }));

test("/data：给了 work 就在 live 旁边带 work；没给不带；work 返回不对 → 500", async () => {
  const none = async () => {};
  let answer = async () => ({ "s-a": { subagents: [{ id: "kid", name: "调研", since: T }], jobs: [] } });
  const asked = [];
  const srv = http.createServer(A.createHandler({ prefix: "", send: none, guard: () => null, live: async (sids) => Object.fromEntries(sids.map((s) => [s, s === "s-a" ? "subagent" : "idle"])), work: async (sids) => { asked.push(sids); return answer(sids); } }));
  const old = http.createServer(A.createHandler({ prefix: "", send: none, guard: () => null, live: async (sids) => Object.fromEntries(sids.map((s) => [s, "idle"])) }));
  await Promise.all([srv, old].map((s) => new Promise((r) => s.listen(0, "127.0.0.1", r))));
  try {
    const url = (s) => "http://127.0.0.1:" + s.address().port + "/p/wk/data";
    const j = await (await fetch(url(srv))).json();
    assert.deepEqual(j.live, { "s-a": "subagent", "s-b": "idle" });
    assert.deepEqual(j.work, { "s-a": { subagents: [{ id: "kid", name: "调研", since: T }], jobs: [] } });
    assert.deepEqual(asked, [["s-a", "s-b"]], "和 live 问同一组会话");
    assert.deepEqual(A.columnOf(j, j.rounds[0], j.live), { col: "doing", open: 0, wait: "subagent" }, "分栏规则不变");
    assert.equal("work" in (await (await fetch(url(old))).json()), false, "没给 work（3390、旧调用）：不带 work");
    answer = async () => ({ "s-zz": { subagents: [], jobs: [] } });
    const bad = await fetch(url(srv));
    assert.equal(bad.status, 500);
    assert.match((await bad.json()).message, /没问到的会话 s-zz/);
    assert.equal("work" in A.parsePage(fs.readFileSync(path.join(dir, "wk.html"), "utf8")), false, "work 不写进页面文件");
  } finally { srv.close(); old.close(); }
  assert.throws(() => A.createHandler({ prefix: "", send: none, guard: () => null, live: null, work: 3 }), /work 要么不给/);
});

test("手机 data:3：pageData3 带 data.work（同一份 sessionWork）；不给 work 的桥不带", async () => {
  const h = host({ activity: { "s-a": [{ kind: "subagent", items: [{ id: "kid", label: "调研" }] }, { kind: "job", items: [{ id: "pwsh-9", label: "构建" }] }] }, timing: { kid: { settledMs: 0, active: { since: T, through: T } } }, started: { "pwsh-9": T - 1 } });
  const live = liveStates({ get: () => undefined }, h.waterfall);
  const rec = { open() {}, answer: (p, n, run) => run() };
  const withWork = createPhoneBridge(async () => {}, () => ({}), live, rec, h.work);
  const d = await withWork.pageData3("wk");
  assert.deepEqual(d.live, { "s-a": "subagent", "s-b": "idle" });
  assert.deepEqual(d.work, { "s-a": { subagents: [{ id: "kid", name: "调研", since: T }], jobs: [{ id: "pwsh-9", name: "构建", since: T - 1, cmd: "构建" }] } });
  const without = createPhoneBridge(async () => {}, () => ({}), live, rec);
  assert.equal("work" in (await without.pageData3("wk")), false);
});
