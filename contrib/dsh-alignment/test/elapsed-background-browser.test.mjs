// 真浏览器回归(2026-10-24):对齐页的「已用」算上子 agent 和后台任务在跑的时间。
// /alignment/todos api 3 多给 background = {subagent: 子 agent(任意深度)在跑的区间, job: 会话自己的、跑完就结束的后台任务在跑的区间};
// 已用 = activity ∪ subagent ∪ (job − 会话等你决定的时间段),重叠只算一次。
// 会话小卡的已用 / 用时圆环 / 详情用时卡 / 待办单项都换成新口径;悬停时页面浮层第一行「已用 X / 预计 Y」,下面「主回合 A、子 agent 和后台任务 B」。
// 旧服务端(没有 background)只算主回合、不拆分;某个会话的 background 算不出来时只算主回合并标「约」。
// 页面由 align.mjs render() 生成,本地 http 服务给页面、/data、/alignment/todos;依赖本机 playwright-core(同 page-browser.test.mjs)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "align-elapsed-bg-"));
process.env.ALIGN_STORE = dir;
process.env.ALIGN_WORKSPACES = path.join(dir, "workspace.json");
const A = await import("../cli/align.mjs");
const { chromium } = createRequire((process.env.DSH_ALIGN_PW_DIR ? path.join(process.env.DSH_ALIGN_PW_DIR, "package.json") : import.meta.url))("playwright-core");
// 一个文件只起一个 Chromium,各用例自己开 context(隔离不变)
let browserP;
const getBrowser = () => (browserP ??= chromium.launch({ headless: true }));
test.after(async () => { if (browserP) await (await browserP.catch(() => null))?.close(); });

const T = Date.parse("2026-10-24T10:00:00Z"), MIN = 60_000, ago = (m) => T - m * MIN, iso = (ms) => new Date(ms).toISOString();
const data = {
  version: 3, name: "eb", title: "已用口径", owner: "session-fm", updated: iso(T), projects: [],
  rounds: [{ id: "r1", sid: "session-w1", title: "派了子 agent 的会话", status: "doing", started: iso(ago(60)), eta: "1h", next: "继续" }],
  decisions: [], notes: [],
};
// 主回合 60–50、20–10 分钟前(20m);子 agent 55–15 分钟前在跑:合起来 60–10 分钟前 = 50m,其中只有子 agent 在跑的 30m
const activity = [[ago(60), ago(50)], [ago(20), ago(10)]];
const background = { subagent: [[ago(55), ago(15)]], job: [] };
const todos = {
  rev: "bbbbbbbbbbbb", updatedAt: iso(ago(58)), turn: 1, latestTurn: 1, running: false, done: 0, total: 1,
  items: [{ text: "等三个方向的设计稿", status: "in_progress", eta: { p50: 900, p75: 1200 }, startedAt: iso(ago(58)), completedAt: null, elapsedMs: null, spans: [[ago(58), null]], approx: false }],
};

function serve(body, page = data) {
  const html = A.render(page);
  const server = createServer((req, res) => {
    const p = req.url.split("?")[0];
    const json = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    if (p === "/alignment/p/eb") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(html); }
    if (p === "/alignment/p/eb/data") return json(200, { ...page, live: { "session-w1": "subagent" } });
    if (p === "/alignment/health") return json(200, { ok: true, api: A.API_VERSION });
    if (p === "/alignment/todos") return json(200, body);
    if (p === "/alignment/fm") return json(200, { ok: true, page: "eb", fm: { sid: "session-fm", title: "first mate" }, refresh: null });
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, base: "http://127.0.0.1:" + server.address().port })));
}

async function open(t, body, pageData) {
  const { server, base } = await serve(body, pageData);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await getBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  await page.clock.install({ time: T });
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base + "/alignment/p/eb?theme=light#r=r1");
  await page.waitForSelector(".todos li .ac");
  const tipOf = async (sel) => {
    await page.hover(sel);
    await page.waitForSelector("#tip:not([hidden])");
    const r = await page.evaluate((s) => {
      const tip = document.querySelector("#tip"), a = document.querySelector(s).getBoundingClientRect(), t = tip.getBoundingClientRect();
      return { head: tip.querySelector("b")?.textContent ?? null, body: tip.querySelector("span")?.textContent ?? null, note: tip.querySelector("small")?.textContent ?? null, below: t.top >= a.bottom, right: Math.round(t.right - a.right) || 0 };
    }, sel);
    await page.mouse.move(1, 1);
    return r;
  };
  const text = (sel) => page.evaluate((s) => document.querySelector(s).textContent, sel);
  return { page, tipOf, text, errors };
}

const SPLIT = "其中主回合 20m，子 agent 和后台任务 30m";
// 浮层放在锚点下面(不盖住卡片标题);小卡的用时、圆环和待办的已用右边对齐锚点
const at = (x, right = true) => ({ note: null, below: true, ...(right ? { right: 0 } : {}), ...x });
const pick = ({ right, ...x }, keepRight) => (keepRight ? { ...x, right } : x);

test("已用 = 主回合 ∪ 子 agent / 后台任务:小卡、圆环、详情用时卡、待办都按新口径,悬停分开显示", { timeout: 90_000 }, async (t) => {
  const { tipOf, text, page, errors } = await open(t, { ok: true, api: 3, sessions: { "session-w1": todos }, activity: { "session-w1": activity }, background: { "session-w1": background } });
  assert.equal(await text(".sc .tm"), "50m / 1h", "小卡:50m(不是只算主回合的 20m)");
  assert.deepEqual(await tipOf(".sc .tm"), at({ head: "已用 50m / 预计 1h", body: SPLIT }));
  // 用时圆环画当前这一项(2026-10-26 起),这一项的已用和待办同一口径:主回合 18m + 子 agent 30m(圆环在行中间,左对齐)
  const ITEM_SPLIT = "其中主回合 18m，子 agent 和后台任务 30m";
  assert.deepEqual(pick(await tipOf(".sc .rg")), pick(at({ head: "当前一项：已用 48m / 预计 15m–20m", body: "等三个方向的设计稿\n" + ITEM_SPLIT, note: "整轮：已用 50m / 预计 1h" }, false)), "用时圆环:当前这一项,算上子 agent;暗一档写整轮");
  assert.equal(await page.getAttribute(".sc .rg svg", "aria-label"), "当前一项：已用 48m / 预计 15m–20m，等三个方向的设计稿，" + ITEM_SPLIT + "，整轮：已用 50m / 预计 1h");
  assert.match(await text(".kpis .kpi .kv"), /^50m/, "详情用时卡");
  assert.deepEqual(pick(await tipOf(".kpis .kpi")), pick(at({ head: null, body: SPLIT, below: false }, false)), "详情用时卡:浮层在卡片右侧,不压住下面那行");
  assert.equal(await text(".todos li .ac"), "已用48m，超出预计范围", "待办:58 分钟前开始,其中 48m 会话在干活(主回合 18m + 子 agent 30m),超出 P75 20m");
  assert.deepEqual(await tipOf(".todos li .ac"), at({ head: "已用 48m，比 P75（20m）多 28m", body: "其中主回合 18m，子 agent 和后台任务 30m" }), "「其中」接在已用后面,不会被读成多出的 28m 的拆分");
  assert.deepEqual(errors, []);
});

test("旧服务端(没有 background):只算主回合,悬停不拆分", { timeout: 60_000 }, async (t) => {
  const { tipOf, text, page, errors } = await open(t, { ok: true, api: 2, sessions: { "session-w1": todos }, activity: { "session-w1": activity } });
  assert.equal(await text(".sc .tm"), "20m / 1h");
  assert.deepEqual(await tipOf(".sc .tm"), at({ head: "已用 20m / 预计 1h", body: null }));
  assert.equal(await text(".todos li .ac"), "已用18m");
  assert.equal(await page.$eval(".todos li .ac", (e) => e.hasAttribute("data-tip")), false, "没超 P75、没有拆分、没有说明:不挂浮层");
  assert.deepEqual(errors, []);
});

test("某个会话的 background 算不出来:只算主回合,标「约」", { timeout: 60_000 }, async (t) => {
  const { tipOf, text, errors } = await open(t, { ok: true, api: 3, sessions: { "session-w1": todos }, activity: { "session-w1": activity }, background: { "session-w1": { error: "dsh-alignment todos: job/registered without jobId" } } });
  assert.equal(await text(".sc .tm"), "约 20m / 1h");
  assert.deepEqual(await tipOf(".sc .tm"), at({ head: "已用 约 20m / 预计 1h", body: null, note: "不含子 agent 和后台任务" }), "浮层说明缺了哪部分");
  assert.equal(await text(".todos li .ac"), "已用约 18m");
  assert.deepEqual(await tipOf(".todos li .ac"), at({ head: null, body: null, note: "不含子 agent 和后台任务" }));
  assert.deepEqual(errors, []);
});

test("后台任务:等你决定的时间段里不算(子 agent 照算);跑完的后台任务其余时间照算", { timeout: 60_000 }, async (t) => {
  // 主回合 60–50 分钟前;一个跑完就结束的测试任务 50–20 分钟前在跑;会话 40–30 分钟前在等你决定(决定 opened → answered)
  const page = { ...data, decisions: [{ id: "d1", title: "要不要换方案", status: "sent", round: "r1", proj: "pa", risk: "中", cat: "方向取舍", rec: "换", opt: [{ label: "换", effect: "a" }, { label: "不换", effect: "b" }], opened: iso(ago(40)), answered: iso(ago(30)), choice: "换" }] };
  const body = { ok: true, api: 3, sessions: { "session-w1": todos }, activity: { "session-w1": [[ago(60), ago(50)]] }, background: { "session-w1": { subagent: [], job: [[ago(50), ago(20)]] } } };
  const { tipOf, text, errors } = await open(t, body, page);
  assert.equal(await text(".sc .tm"), "30m / 1h", "主回合 10m + 测试任务 30m − 等你决定的 10m");
  assert.deepEqual(await tipOf(".sc .tm"), at({ head: "已用 30m / 预计 1h", body: "其中主回合 10m，子 agent 和后台任务 20m" }));
  // 还开着的决定:从 opened 算到现在,这段时间后台任务一直不算
  const open2 = { ...page, decisions: [{ ...page.decisions[0], status: "open", answered: undefined, choice: undefined, opened: iso(ago(35)) }] };
  const r2 = await open(t, body, open2);
  assert.equal(await r2.text(".sc .tm"), "25m / 1h", "主回合 10m + 测试任务 50–35 分钟前的 15m");
  assert.deepEqual([...errors, ...r2.errors], []);
});

test("暂缓时段(api 15 pauses)不计时;暂缓过但时刻不明(untimed)标「约」并说明", { timeout: 90_000 }, async (t) => {
  const body = { ok: true, api: 4, sessions: { "session-w1": todos }, activity: { "session-w1": activity }, background: { "session-w1": background } };
  // 干活 60–10 分钟前(50m);40–15 分钟前暂缓:去掉 25m → 25m,其中主回合 60–50 和 15–10 共 15m
  const paused = { ...data, rounds: [{ ...data.rounds[0], pauses: [{ from: iso(ago(40)), to: iso(ago(15)) }] }] };
  const { tipOf, text, errors } = await open(t, body, paused);
  assert.equal(await text(".sc .tm"), "25m / 1h", "暂缓期间子 agent 和主回合跑的都不算这一轮");
  assert.deepEqual(await tipOf(".sc .tm"), at({ head: "已用 25m / 预计 1h", body: "其中主回合 15m，子 agent 和后台任务 10m" }));
  assert.match(await text(".kpis .kpi .kv"), /^25m/, "详情用时卡同一口径");
  // 老数据:暂缓过但没记下时刻,照算但标「约」,浮层说明可能多算
  const untimed = { ...data, rounds: [{ ...data.rounds[0], untimed: "true" }] };
  const r2 = await open(t, body, untimed);
  assert.equal(await r2.text(".sc .tm"), "约 50m / 1h");
  assert.deepEqual(await r2.tipOf(".sc .tm"), at({ head: "已用 约 50m / 预计 1h", body: SPLIT, note: "暂缓过，暂缓的时刻没有记录，可能多算了暂缓期间" }));
  assert.deepEqual([...errors, ...r2.errors], []);
});
