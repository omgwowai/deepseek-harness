// 真浏览器回归(2026-10-26):对齐页详情的待办分两种情况。
// - 没有待办(会话从没写过 todolist):事实行最后一行写原因——会话写的「不列待办：…」原样,页面推断的带「推断」,都没有时「这个会话没有列待办」;
// - 有待办:🤖 项画机器人图标,连续几项 🤖 收进「并行 N 项」一组,组的预计按组里最长的一项、已用按各项区间的并集;
//   🤖 项下面一行是它的子 agent:在跑的以 /data 的 work 为准(和会话卡同一份),失败红色,推断的带「推断」,点开看会话 ID 和开始时间;
//   轮次没登记预计时,用时卡的预计 = 待办合计,并行组只算最长的一项。
// 旧服务端(api 3,没有 notodo / agent):不显示原因;🤖 只看文字,照样成组。
// 页面由 align.mjs render() 生成,本地 http 服务给页面、/data、/alignment/todos;依赖本机 playwright-core(同 todo-timing-browser.test.mjs)。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "align-todo-dag-"));
process.env.ALIGN_STORE = dir;
process.env.ALIGN_WORKSPACES = path.join(dir, "workspace.json");
const A = await import("../cli/align.mjs");
const { chromium } = createRequire((process.env.DSH_ALIGN_PW_DIR ? path.join(process.env.DSH_ALIGN_PW_DIR, "package.json") : import.meta.url))("playwright-core");

const T = Date.parse("2026-10-26T10:00:00+08:00"), MIN = 60_000, ago = (m) => T - m * MIN, iso = (ms) => new Date(ms).toISOString();
const round = (id, sid, title, status, extra = {}) => ({ id, sid, title, status, mode: "new", started: iso(ago(40)), updated: iso(ago(1)), ...extra });
const data = {
  version: 3, name: "dag", title: "待办 DAG", owner: "session-fm", updated: iso(T), projects: [],
  rounds: [
    round("r-dag", "session-dag", "待办按简化 DAG 显示", "doing", { state: "三个子 agent 并行" }),
    round("r-nr1", "session-nr1", "改一行配置", "done", { result: "改好了" }),
    round("r-nr2", "session-nr2", "查一个数", "done", { result: "9 段" }),
    round("r-nr3", "session-nr3", "整理交接文件", "doing", { state: "在合并" }),
  ],
  decisions: [], notes: [],
};
const e = (p50, p75) => ({ p50: p50 * 60, p75: p75 * 60 });
const item = (text, status, eta, spans, agent) => ({ text, status, eta, startedAt: spans.length ? iso(spans[0][0]) : null, completedAt: null, elapsedMs: null, spans, approx: false, ...(agent === undefined ? {} : { agent }) });
const run = (id, kind, name, state, m) => ({ id, kind, name, state, since: ago(m) });
const VR = "9a1b2c3d-aaaa-4bbb-8ccc-000000000002";
const items = [
  item("勘探现状", "completed", e(1, 3), [[ago(40), ago(37)]], null),
  item("调研同类产品", "completed", e(6, 12), [[ago(37), ago(30)]], { by: "inferred", runs: [run("7f3c2a10-aaaa-4bbb-8ccc-000000000001", "subagent", "Research parallel UIs", "done", 36)] }),
  item("设计数据方案", "completed", e(13, 22), [[ago(30), ago(18)]], null),
  // 服务端说已停,但 /data 的 work 里它还在跑:以 work 为准(会话卡同一份)
  item("🤖 视觉审查", "in_progress", e(5, 9), [[ago(18), null]], { by: "session", runs: [run(VR, "subagent", "Visual review", "stopped", 17)] }),
  item("🤖 文案盲审", "completed", e(4, 8), [[ago(18), ago(11)]], { by: "session", runs: [run("5e6f7a8b-aaaa-4bbb-8ccc-000000000003", "subagent", "Blind copy review", "done", 17)] }),
  item("🤖 写浏览器测试", "in_progress", e(9, 20), [[ago(18), null]], { by: "session", runs: [run("1c2d3e4f-aaaa-4bbb-8ccc-000000000004", "subagent", "Write browser test", "failed", 17)] }),
  item("跑完整 dsh-verify", "pending", e(6, 12), [], null),
  item("合入 master", "pending", e(2, 3), [], null),
];
const todo = (list) => ({ rev: "aaaaaaaaaaaa", updatedAt: iso(ago(2)), turn: 1, latestTurn: 1, running: true, done: list.filter((x) => x.status === "completed").length, total: list.length, items: list });
const sessions4 = { "session-dag": todo(items), "session-nr1": null, "session-nr2": null, "session-nr3": null };
// 旧服务端:没有 agent(🤖 只在文字里)、没有 notodo
const sessions3 = { ...sessions4, "session-dag": todo(items.map(({ agent, ...x }) => x)) };
const notodo = {
  "session-nr1": { by: "session", text: "只改一行配置，一步完成", why: null, steps: 2 },
  "session-nr2": { by: "inferred", text: null, why: "few-steps", steps: 2 },
  "session-nr3": { by: "none", text: null, why: null, steps: 12 },
};
const activity = Object.fromEntries(data.rounds.map((r) => [r.sid, [[ago(40), null]]]));
const background = Object.fromEntries(data.rounds.map((r) => [r.sid, { subagent: [], job: [] }]));
const work = { "session-dag": { subagents: [{ id: VR, name: "Visual review", since: ago(17) }], jobs: [] } };

let browser;
const servers = [];
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); for (const s of servers) { s.closeAllConnections(); s.close(); } fs.rmSync(dir, { recursive: true, force: true }); });

function serve(api) {
  const html = A.render(data);
  const server = createServer((req, res) => {
    const p = req.url.split("?")[0];
    const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (p === "/alignment/p/dag") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(html); }
    if (p === "/alignment/p/dag/data") return json(200, { ...data, live: { "session-dag": "subagent", "session-nr1": "idle", "session-nr2": "idle", "session-nr3": "running" }, work });
    if (p === "/alignment/health") return json(200, { ok: true, api: A.API_VERSION });
    if (p === "/alignment/todos") return json(200, api === 4 ? { ok: true, api: 4, sessions: sessions4, activity, background, notodo } : { ok: true, api: 3, sessions: sessions3, activity, background });
    if (p === "/alignment/fm") return json(200, { ok: true, page: "dag", fm: { sid: "session-fm", title: "first mate" }, refresh: null });
    res.writeHead(404); res.end();
  });
  servers.push(server);
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r("http://127.0.0.1:" + server.address().port)));
}

async function open(api, width) {
  const base = await serve(api);
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.setDefaultTimeout(5000);
  await page.clock.install({ time: T });
  const errors = []; page.on("pageerror", (x) => errors.push(String(x)));
  await page.goto(base + "/alignment/p/dag?theme=light#r=r-dag");
  await page.waitForSelector(".todos li");
  const go = async (rid, title) => { await page.evaluate((h) => { location.hash = h; }, "#r=" + rid); await page.waitForFunction((t) => document.querySelector(".rbody .dh h1")?.textContent === t, title); };
  return { page, errors, go };
}

const ntText = (page) => page.evaluate(() => [...document.querySelectorAll(".rbody .fact.nt .ft")].map((x) => x.textContent));

test("没有待办:事实行最后一行写原因(会话写的 / 推断 / 都没有)", { timeout: 60_000 }, async () => {
  const { page, errors, go } = await open(4, 1280);
  await go("r-nr1", "改一行配置");
  await page.waitForSelector(".rbody .fact.nt");
  assert.deepEqual(await ntText(page), ["没有列：只改一行配置，一步完成"]);
  assert.equal(await page.locator(".rbody .fact.nt .fl").textContent(), "待办", "标签列写「待办」,句子和上面的事实行对齐");
  assert.equal(await page.evaluate(() => document.querySelector(".rbody .facts").lastElementChild.classList.contains("nt")), true, "在事实行最后");
  assert.equal(await page.locator(".rbody .fact.nt .inf").count(), 0, "会话自己写的不带「推断」");
  await go("r-nr2", "查一个数");
  assert.deepEqual(await ntText(page), ["推断没有列：只用了 2 步"], "「推断」在句子前面(同子 agent 行)");
  assert.equal(await page.locator(".rbody .fact.nt .inf").textContent(), "推断");
  await go("r-nr3", "整理交接文件");
  assert.deepEqual(await ntText(page), ["这个会话没有列待办"]);
  await go("r-dag", "待办按简化 DAG 显示");
  assert.equal(await page.locator(".rbody .fact.nt").count(), 0, "有待办的不写原因");
  assert.deepEqual(errors, []);
  await page.close();
});

test("并行组:连续的 🤖 项收进一组,组的预计按最长的一项、已用按并集;用时卡预计 = 待办合计(组只算最长)", { timeout: 60_000 }, async () => {
  const { page, errors } = await open(4, 1280);
  const g = await page.evaluate(() => {
    const pg = [...document.querySelectorAll(".rbody .todos li.pg")];
    const t = (el, s) => el.querySelector(s)?.textContent ?? null;
    return {
      groups: pg.length,
      head: pg.map((x) => [t(x, ".pgh .tx"), t(x, ".pgh .ac"), t(x, ".pgh .pd")]),
      members: pg.map((x) => [...x.querySelectorAll(":scope>ol>li .tx")].map((y) => y.textContent)),
      bots: [...document.querySelectorAll(".rbody .todos ol>li:not(.pg)")].map((li) => !!li.querySelector(":scope>.tx .bt")),
      kpi: document.querySelector(".rbody .kpi .kl")?.textContent ?? null,
    };
  });
  assert.equal(g.groups, 1);
  assert.deepEqual(g.head, [["并行 3 项·1 个失败", "已用18m", "预计9m–20m"]], "组头带上失败个数");
  assert.deepEqual(g.members, [["交给子 agent：视觉审查", "交给子 agent：文案盲审", "交给子 agent：写浏览器测试"]], "文字去掉开头的 🤖,换成图标(读屏念「交给子 agent」)");
  assert.deepEqual(g.bots, [false, true, false, true, true, true, false, false], "推断的那一项也画机器人(浅色)");
  assert.equal(await page.locator(".rbody .todos li .tx .bt.bt-inf").count(), 1);
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll(".rbody .todos li.fail .tx")].map((x) => x.textContent)), ["交给子 agent：写浏览器测试"], "最近派出的子 agent 失败的项加红色描边");
  // 1 + 6 + 13 + max(5, 4, 9) + 6 + 2 = 37 分钟(相加是 46)
  assert.equal(g.kpi, "用时 · 预计 37m");
  assert.deepEqual(errors, []);
  await page.close();
});

// 2026-10-26:两栏时在跑的那一个只写「图标 已运行 X」(名字已经在左栏「正在执行」里,同屏不写两遍),悬停整行看全名,读屏照读名字;
// 单栏照写名字(「正在执行」在数字卡下面,和待办隔着事实行,常常不在同一屏)
test("🤖 项的子 agent:在跑的以 work 为准,失败红色,推断的带「推断」,点开看会话 ID 和开始时间", { timeout: 60_000 }, async () => {
  const { page, errors } = await open(4, 1600);
  const rows = await page.evaluate(() => [...document.querySelectorAll(".rbody .todos .runs")].map((d) => {
    const s = d.querySelector("summary"), hidden = (e) => getComputedStyle(e).clip === "rect(0px, 0px, 0px, 0px)";
    const seen = [...s.querySelectorAll(".inf, .run-n, .sep, .run-s")].filter((e) => !hidden(e)).map((e) => e.textContent).join("");
    return { text: seen, read: s.textContent, on: !!s.querySelector(".i.on"), failed: !!s.querySelector(".run.st-failed"), color: getComputedStyle(s.querySelector(".run-s")).color, inf: !!s.querySelector(".inf") };
  }));
  assert.deepEqual(rows.map((r) => r.text), ["推断Research parallel UIs·完成", "已运行 17m", "Blind copy review·完成", "Write browser test·失败"], "「推断」在名字前面;在跑的只写已运行");
  assert.equal(rows[1].read, "Visual review·已运行 17m", "读屏照读名字");
  assert.equal(await page.locator(".dw li .wt").textContent(), "Visual review", "名字在详情「正在执行」里");
  await page.locator(".rbody .todos .runs summary").nth(1).hover();
  await page.waitForSelector("#tip:not([hidden])");
  assert.equal(await page.locator("#tip").textContent(), "Visual review", "悬停看全名");
  await page.mouse.move(5, 5);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".rbody")).getPropertyValue("--twocol").trim() !== "1");
  assert.equal(await page.locator(".rbody .todos .runs summary").nth(1).evaluate((s) => s.innerText.replace(/\s+/g, "")), "Visualreview·已运行17m", "单栏照写名字");
  await page.locator(".rbody .todos .runs summary").nth(1).hover();
  await page.waitForTimeout(100);
  assert.equal(await page.locator("#tip").isHidden(), true, "单栏名字看得见:不出浮层");
  await page.mouse.move(5, 5);
  assert.deepEqual(rows.map((r) => r.on), [false, true, false, false], "在跑的图标是蓝色(work 里有它)");
  assert.deepEqual(rows.map((r) => r.inf), [true, false, false, false]);
  assert.equal(rows[3].failed, true);
  assert.equal(rows[3].color, "rgb(191, 44, 44)", "失败用红色(--red)");
  await page.locator(".rbody .todos .runs summary").nth(1).click();
  const meta = await page.locator(".rbody .todos .runs[open] .run-m").textContent();
  assert.match(meta, /^9a1b2c3d.*09:43 开始$/);
  // 重画(每 30 秒走时)后保持展开
  await page.clock.fastForward("01:01");
  await page.waitForFunction(() => document.querySelector(".rbody .todos .runs[open] summary .run-s")?.textContent === "已运行 18m");
  assert.equal(await page.locator(".rbody .todos .runs[open]").count(), 1);
  assert.deepEqual(errors, []);
  await page.close();
});

// 左栏同类 2 个以上(折成「2 个子 agent 执行中…」,默认收起):那一行左栏没写名字,右栏照写;展开左栏那一组后右栏才藏
test("两栏:左栏同类折叠时待办项下照写名字,展开后才藏", { timeout: 60_000 }, async () => {
  const base = await serve(4);
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.setDefaultTimeout(5000);
  await page.clock.install({ time: T });
  const errors = []; page.on("pageerror", (x) => errors.push(String(x)));
  await page.route("**/alignment/p/dag/data", async (route) => { const r = await route.fetch(); const j = await r.json(); j.work["session-dag"].subagents.push({ id: "session-other-kid", name: "另一个在跑的", since: ago(3) }); await route.fulfill({ response: r, json: j }); });
  await page.goto(base + "/alignment/p/dag?theme=light#r=r-dag");
  await page.waitForSelector(".dw details.dw-g");
  const vis = () => page.evaluate(() => { const n = document.querySelector(".rbody .todos .runs .run.st-running .run-n"); return !!n && n.getBoundingClientRect().width > 1; });
  assert.equal(await vis(), true, "左栏组收起:右栏照写名字");
  await page.click(".dw details.dw-g summary");
  await page.waitForFunction(() => document.querySelector(".rbody .todos .runs .run.wl .run-n")?.getBoundingClientRect().width <= 1);
  assert.equal(await vis(), false, "左栏组展开后:右栏藏名字");
  await page.click(".dw details.dw-g summary");
  await page.waitForFunction(() => document.querySelector(".rbody .todos .runs .run.st-running .run-n")?.getBoundingClientRect().width > 1);
  assert.deepEqual(errors, []);
  await page.close();
});

test("窄屏 420:并行组和子 agent 行不横向溢出", { timeout: 60_000 }, async () => {
  const { page, errors } = await open(4, 420);
  const g = await page.evaluate(() => { const t = document.querySelector(".rbody .todos"); return { fits: t.scrollWidth <= t.clientWidth, pg: document.querySelectorAll(".rbody .todos li.pg").length }; });
  assert.deepEqual(g, { fits: true, pg: 1 });
  assert.deepEqual(errors, []);
  await page.close();
});

test("旧服务端(api 3):不显示原因;🤖 只看文字照样成组,没有子 agent 行", { timeout: 60_000 }, async () => {
  const { page, errors, go } = await open(3, 1280);
  assert.equal(await page.locator(".rbody .todos li.pg").count(), 1);
  assert.equal(await page.locator(".rbody .todos .runs").count(), 0);
  await go("r-nr1", "改一行配置");
  assert.equal(await page.locator(".rbody .fact.nt").count(), 0);
  assert.deepEqual(errors, []);
  await page.close();
});

// 服务端真输出 → 页面(契约对拍):用 todos.js 的 createTodoIndex + todosHandler 从假会话事件算出 /alignment/todos 的回复,页面照样画出并行组、子 agent 状态和没有待办的原因
test("todos.js 真输出:🤖 两项成组、子 agent 完成 / 失败,没写待办的会话显示它自己写的「不列待办」", { timeout: 60_000 }, async () => {
  const { createTodoIndex, todosHandler } = await import("../todos.js");
  let seq = 0;
  const ev = (type, data, time) => ({ type, seq: seq++, time, data });
  const userMsg = (text, time) => ev("user/message", { content: [{ type: "text", text }], source: { kind: "user" } }, time);
  const toolStep = (time, k) => [ev("step/start", { turn: 1, step: k }, time), ev("tool/call", { name: "pwsh", callId: "c" + k, arguments: "{}" }, time + 1), ev("tool/result", { message: { toolCallId: "c" + k, content: [] } }, time + 2), ev("step/end", { turn: 1, step: k }, time + 3)];
  const logs = {
    "session-int": [
      ev("turn/start", { turn: 1 }, ago(30)), userMsg("做 X", ago(30)),
      ...toolStep(ago(29), 1),
      ev("todo/write", { todos: [{ content: "勘探 [ETA 1m/2m]", status: "completed" }, { content: "🤖 视觉审查 [ETA 5m/9m]", status: "in_progress" }, { content: "🤖 文案审查 [ETA 4m/8m]", status: "in_progress" }, { content: "合入 [ETA 2m/3m]", status: "pending" }] }, ago(28)),
      ev("subagent/catalog", { version: 0, childId: "11111111-aaaa-4bbb-8ccc-000000000001", childCreatedAt: ago(27), mode: "continuable", label: "视觉审查" }, ago(27)),
      ev("subagent/catalog", { version: 0, childId: "22222222-aaaa-4bbb-8ccc-000000000002", childCreatedAt: ago(27), mode: "continuable", label: "文案审查" }, ago(27)),
      ev("turn/end", { turn: 1, reason: { kind: "completed" } }, ago(26)),
    ],
    "11111111-aaaa-4bbb-8ccc-000000000001": [ev("turn/start", { turn: 1 }, ago(27)), ev("turn/end", { turn: 1, reason: { kind: "completed" } }, ago(20))],
    "22222222-aaaa-4bbb-8ccc-000000000002": [ev("turn/start", { turn: 1 }, ago(27)), ev("turn/end", { turn: 1, reason: { kind: "error" } }, ago(22))],
    "session-nt": [
      ev("turn/start", { turn: 1 }, ago(10)), userMsg("改一行配置", ago(10)), ...toolStep(ago(9), 1),
      ev("assistant/message", { turn: 1, step: 2, message: { role: "assistant", content: [{ type: "text", text: "改好了。\n不列待办：只改一行配置，一步完成。" }] } }, ago(8)),
      ev("turn/end", { turn: 1, reason: { kind: "completed" } }, ago(8)),
    ],
  };
  const index = createTodoIndex({
    readSessionState: async (sid) => ({ events: logs[sid] ?? [], inheritedEventCount: 0 }),
    isRunning: () => false,
    running: async () => ({ subagent: new Set(), job: new Set() }),
    now: () => T,
  });
  const handler = todosHandler({ index, guard: () => null });
  const reply = await new Promise((resolve) => {
    const res = { writeHead() {}, end: (body) => resolve(JSON.parse(body)) };
    handler({ method: "GET", url: "/alignment/todos?sids=session-int,session-nt" }, res);
  });
  assert.equal(reply.api >= 4, true, "api 4");
  const live = { ...data, rounds: [round("r-int", "session-int", "真输出", "doing", { state: "两个子 agent" }), round("r-nt", "session-nt", "真输出没待办", "done", { result: "改好了" })] };
  const html = A.render(live);
  const server = createServer((req, res) => {
    const p = req.url.split("?")[0];
    const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (p === "/alignment/p/dag") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(html); }
    if (p === "/alignment/p/dag/data") return json(200, { ...live, live: { "session-int": "idle", "session-nt": "idle" }, work: {} });
    if (p === "/alignment/health") return json(200, { ok: true, api: A.API_VERSION });
    if (p === "/alignment/todos") return json(200, reply);
    if (p === "/alignment/fm") return json(200, { ok: true, page: "dag", fm: { sid: "session-fm", title: "first mate" }, refresh: null });
    res.writeHead(404); res.end();
  });
  servers.push(server);
  const base = await new Promise((r) => server.listen(0, "127.0.0.1", () => r("http://127.0.0.1:" + server.address().port)));
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(5000);
  await page.clock.install({ time: T });
  const errors = []; page.on("pageerror", (x) => errors.push(String(x)));
  await page.goto(base + "/alignment/p/dag?theme=light#r=r-int");
  await page.waitForSelector(".rbody .todos li.pg");
  const g = await page.evaluate(() => ({
    head: document.querySelector(".rbody .todos .pgh .tx").textContent,
    eta: document.querySelector(".rbody .todos .pgh .pd").textContent,
    runs: [...document.querySelectorAll(".rbody .todos .runs summary")].map((s) => s.textContent),
  }));
  assert.deepEqual(g, { head: "并行 2 项·1 个失败", eta: "预计5m–9m", runs: ["视觉审查·完成", "文案审查·失败"] });
  await page.evaluate(() => { location.hash = "#r=r-nt"; });
  await page.waitForSelector(".rbody .fact.nt");
  assert.equal(await page.locator(".rbody .fact.nt .ft").textContent(), "没有列：只改一行配置，一步完成");
  assert.deepEqual(errors, []);
  await page.close();
});

// 2026-10-26:嵌在 DSH 里时,点子 agent 那一行请外层打开它的会话(带父会话和 mode);会话已不在的那一行不能点、写「会话已不在」;
// 外层回打开失败时,这一项下面写一句「没打开：…」;复制 ID 的标签照旧
test("嵌在 DSH 里:点子 agent 行请外层按父会话地址打开;会话已不在的不能点;打开失败写一句", { timeout: 60_000 }, async () => {
  const KID = "1c2d3e4f-aaaa-4bbb-8ccc-000000000004", GONE = "5e6f7a8b-aaaa-4bbb-8ccc-000000000003", LATE = "9a1b2c3d-aaaa-4bbb-8ccc-000000000002", asked = [];
  const list = items.map((x) => x.agent ? { ...x, agent: { ...x.agent, runs: x.agent.runs.map((r) => ({ ...r, mode: "continuable", gone: r.id === GONE })) } } : x);
  const html = A.render(data);
  const server = createServer((req, res) => {
    const p = req.url.split("?")[0];
    const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (p === "/host") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end('<!doctype html><body style="margin:0"><iframe id="f" src="/alignment/p/dag?embed=1&theme=light#r=r-dag" style="width:1280px;height:900px;border:0"></iframe><script>window.got=[];addEventListener("message",(e)=>{if(e.data&&e.data.type==="dsh-alignment/open-session"){got.push(e.data);e.source.postMessage({type:"dsh-alignment/open-session-result",ok:false,error:"sessions.retain: unknown session "+e.data.sid},location.origin);}});</script></body>'); }
    if (p === "/alignment/p/dag") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(html); }
    if (p === "/alignment/p/dag/data") return json(200, { ...data, live: { "session-dag": "subagent" }, work });
    if (p === "/alignment/health") return json(200, { ok: true, api: A.API_VERSION });
    if (p === "/alignment/todos" && req.url.includes("exists=")) { const sid = new URL(req.url, "http://x").searchParams.get("exists"); asked.push(sid); return json(200, { ok: true, api: 4, exists: sid !== LATE }); }
    if (p === "/alignment/todos") return json(200, { ok: true, api: 4, sessions: { ...sessions4, "session-dag": todo(list) }, activity, background, notodo });
    if (p === "/alignment/fm") return json(200, { ok: true, page: "dag", fm: { sid: "session-fm", title: "first mate" }, refresh: null });
    res.writeHead(404); res.end();
  });
  servers.push(server);
  const base = await new Promise((r) => server.listen(0, "127.0.0.1", () => r("http://127.0.0.1:" + server.address().port)));
  const page = await browser.newPage({ viewport: { width: 1300, height: 920 } });
  page.setDefaultTimeout(5000);
  await page.clock.install({ time: T });
  const errors = []; page.on("pageerror", (x) => errors.push(String(x)));
  await page.goto(base + "/host");
  const f = page.frameLocator("#f");
  await f.locator(".todos .runs").first().waitFor();
  assert.equal(await f.locator('.todos .runs [data-act="open-run"]').count(), 3, "四个子 agent,会话已不在的那个不能点");
  const goneRow = f.locator(".todos .runs summary", { hasText: "Blind copy review" });
  assert.match(await goneRow.textContent(), /会话已不在/);
  assert.equal(await goneRow.locator('[data-act="open-run"]').count(), 0);
  await goneRow.click();
  assert.equal(await f.locator('.todos .runs[open] .tk[data-act="copy"]').count(), 1, "展开后照样能复制 ID");
  await f.locator(".todos .runs summary", { hasText: "Write browser test" }).locator('[data-act="open-run"]').click();
  await page.waitForFunction(() => window.got.length === 1);
  assert.deepEqual(await page.evaluate(() => window.got[0]), { type: "dsh-alignment/open-session", sid: KID, parent: "session-dag", mode: "continuable" });
  await f.locator(".todos .run-err").waitFor();
  assert.equal(await f.locator(".todos .run-err").textContent(), "没打开：DSH 里找不到这个会话");
  assert.equal(await f.locator('.todos .runs:has([data-sid="' + KID + '"])').evaluate((d) => d.open), false, "点名字不展开");
  // 页面上还显示能点、但服务端查出会话已经删了:不发给外层,这一项下面写一句
  const lateBtn = f.locator('[data-act="open-run"][data-sid="' + LATE + '"]');
  // 在跑、列在「正在执行」里的:按钮不挂 title,用页面浮层写全名和说明(iframe 1280 宽是单栏,名字照写)
  assert.equal(await lateBtn.evaluate((b) => [b.innerText.replace(/\s+/g, ""), b.title, b.dataset.tip, b.dataset.tipN]).then(JSON.stringify), JSON.stringify(["Visualreview·已运行17m", "", "Visual review", "打开这个子 agent 会话"]));
  await lateBtn.click();
  await f.locator(".todos li:not(.pg):has(.runs summary:has-text(\"Visual review\")) .run-err").waitFor();
  assert.equal(await f.locator(".todos li:not(.pg):has(.runs summary:has-text(\"Visual review\")) .run-err").textContent(), "没打开：这个子 agent 的会话已不在");
  assert.equal(await page.evaluate(() => window.got.length), 1, "没有再发给外层");
  assert.equal(await f.locator('[data-act="open-run"][data-sid="' + LATE + '"]').count(), 0, "查出不在后这一行马上改成打不开的写法");
  assert.match(await f.locator(".todos .runs summary", { hasText: "Visual review" }).textContent(), /会话已不在/);
  assert.deepEqual(asked, [KID, LATE]);
  assert.deepEqual(errors, []);
  await page.close();
});
