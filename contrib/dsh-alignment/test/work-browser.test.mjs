// 真浏览器回归(2026-10-24):对齐页不再显示「等子 agent / 等后台任务」,改成显示正在执行的子 agent 和后台任务(/data 的 work)。
// 会话小卡第三行:1 个写名字,2 个以上写「n 个子 agent 执行中…」,后台任务同样(终端图标);两种都有时并排;悬停列出全部。
// 详情标题下:1 个一行(名字 + 已运行),2 个以上折叠,展开列出每一个;展开状态在 4 秒刷新后保留。
// 名字取不到:子 agent 写「子 agent <会话 id 前 8 位>」,后台任务写「后台任务 <job id>」;开始时间取不到不写已运行。
// 0 个(或旧服务端没有 work):没有这一行;回合结束只剩子 agent / 后台任务在跑时状态是蓝色「进行中」。
// 窄屏 420(卡宽 ≤136px):每段只留图标 + 数字,不撑破卡片,悬停看名字;读屏从卡片里的隐藏文字读完整清单。页面由 align.mjs render() 生成,依赖本机 playwright-core(同 page-browser.test.mjs)。
// 2026-10-26:详情里这一行挪到数字卡下面(两栏时在左栏,左右两栏顶端对齐;单栏 / 窄屏同样在数字卡下面);已运行不到 1 分钟写秒;
// 后台任务名字是可读的(服务端给,见 work.test / job-title.test),命令原文在悬停里,终端图标处「复制命令」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "align-work-browser-"));
process.env.ALIGN_STORE = dir;
process.env.ALIGN_WORKSPACES = path.join(dir, "workspace.json");
const A = await import("../cli/align.mjs");
const { chromium } = createRequire((process.env.DSH_ALIGN_PW_DIR ? path.join(process.env.DSH_ALIGN_PW_DIR, "package.json") : import.meta.url))("playwright-core");
// 一个文件只起一个 Chromium,各用例自己开 context(隔离不变)
let browserP;
const getBrowser = () => (browserP ??= chromium.launch({ headless: true }));
test.after(async () => { if (browserP) await (await browserP.catch(() => null))?.close(); });

const T = Date.parse("2026-10-24T10:00:00Z"), MIN = 60_000, ago = (m) => T - m * MIN, iso = (ms) => new Date(ms).toISOString();
const round = (id, sid, title) => ({ id, sid, title, status: "doing", started: iso(ago(30)), state: "在做" });
const data = {
  version: 3, name: "wb", title: "对齐", owner: "session-fm", updated: iso(T), projects: [],
  rounds: [round("r0", "session-zero0000", "没有子 agent"), round("r1", "session-one11111", "一个子 agent"), round("r3", "session-three333", "三个子 agent"), round("rj", "session-jobs4444", "子 agent 和后台任务"), round("rn", "session-noname55", "名字取不到"), round("rv", "session-verify66", "后台跑完整检查")],
  decisions: [], notes: [],
};
const live = { "session-zero0000": "running", "session-one11111": "subagent", "session-three333": "subagent", "session-jobs4444": "job", "session-noname55": "subagent", "session-verify66": "job" };
// 截图里那一轮:后台跑 dsh-verify,开始 20 秒
const VERIFY = 'pwsh -NoProfile -File .\\dsh-verify.ps1 *> C:\\Users\\me\\.dsh\\tmp\\probe\\task-eta-fm\\verify-dec.log; "verify exit $LASTEXITCODE"; exit $LASTEXITCODE';
const work = {
  "session-one11111": { subagents: [{ id: "session-kid00001", name: "调研上游 session-activity 的子 agent 标签字段", since: ago(9) }], jobs: [] },
  "session-three333": { subagents: [{ id: "session-kid000a1", name: "方向 A", since: ago(31) }, { id: "session-kid000b2", name: "方向 B", since: ago(30) }, { id: "session-kid000c3", name: "方向 C", since: ago(29) }], jobs: [] },
  "session-jobs4444": { subagents: [{ id: "session-kid000x9", name: "写测试", since: ago(4) }], jobs: [{ id: "pwsh-1a2b3c4d", name: "Run full dsh-verify", since: ago(6) }, { id: "pwsh-5e6f7a8b", name: "Watch tests", since: ago(2) }] },
  "session-noname55": { subagents: [{ id: "session-9f8e7d6c5b", name: null, since: null }], jobs: [{ id: "pwsh-0c0c0c0c", name: null, since: ago(3) }] },
  "session-verify66": { subagents: [], jobs: [{ id: "pwsh-93a6464b7ea749d0", name: "完整检查 dsh-verify", since: T - 20_000, cmd: VERIFY }] },
};
// 有待办的轮次(两栏:右栏是待办)
const todos = { "session-verify66": { rev: "r1", updatedAt: iso(ago(2)), turn: 1, latestTurn: 1, running: false, done: 1, total: 3, items: [
  { text: "改代码", status: "completed", eta: null, startedAt: iso(ago(20)), completedAt: iso(ago(5)), elapsedMs: 15 * MIN, spans: [[ago(20), ago(5)]], approx: false, agent: null },
  { text: "完整 dsh-verify", status: "in_progress", eta: null, startedAt: iso(ago(1)), completedAt: null, elapsedMs: MIN, spans: [[ago(1), null]], approx: false, agent: null },
  { text: "合入 master", status: "pending", eta: null, startedAt: null, completedAt: null, elapsedMs: null, spans: [], approx: false, agent: null },
] } };

function serve(body) {
  const html = A.render(data);
  const server = createServer((req, res) => {
    const p = req.url.split("?")[0];
    const json = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    if (p === "/alignment/p/wb") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(html); }
    if (p === "/alignment/p/wb/data") return json(200, { ...data, ...body() });
    if (p === "/alignment/health") return json(200, { ok: true, api: A.API_VERSION });
    if (p === "/alignment/todos") return json(200, { ok: true, api: 3, sessions: todos, activity: { "session-verify66": [[ago(30), null]] }, background: {} });
    if (p === "/alignment/fm") return json(200, { ok: true, page: "wb", fm: { sid: "session-fm", title: "first mate" }, refresh: null });
    if (p.endsWith("/log")) return json(200, { ok: true });
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, base: "http://127.0.0.1:" + server.address().port })));
}

async function open(t, { body = () => ({ live, work }), width = 1280, hash = "" } = {}) {
  const { server, base } = await serve(body);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await getBrowser();
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  page.setDefaultTimeout(5000);
  await page.clock.install({ time: T });
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base + "/alignment/p/wb?theme=light" + hash);
  await page.waitForSelector(".sc");
  const card = (title) => page.locator(".sc", { has: page.locator(".sc-tx", { hasText: new RegExp("^" + title + "$") }) });
  // 先滚到视野里、等滚动事件过去（页面滚动时收起浮层），再悬停
  const tip = async (loc) => {
    await loc.scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    await loc.hover();
    await page.waitForSelector("#tip:not([hidden])");
    const r = await page.evaluate(() => { const t = document.querySelector("#tip"); return { head: t.querySelector("b")?.textContent ?? null, body: t.querySelector("span")?.textContent ?? null }; });
    // 浮层贴着这一行(上下 ≤ 8px),不压到别的卡上
    const gap = await page.evaluate(() => { const t = document.querySelector("#tip").getBoundingClientRect(), a = document.querySelector(".sc-w .wk:hover")?.closest(".sc-w")?.getBoundingClientRect(); return a ? Math.min(Math.abs(t.top - a.bottom), Math.abs(a.top - t.bottom)) : null; });
    if (gap !== null) assert.ok(gap <= 8, "浮层离这一行 " + gap + "px");
    await page.mouse.move(1, 1);
    return r;
  };
  return { page, card, tip, errors };
}
const rowText = (loc) => loc.evaluate((e) => e.textContent);

test("会话小卡:0 / 1 / 多个子 agent,和后台任务同时有,名字取不到;悬停列出全部", { timeout: 90_000 }, async (t) => {
  const { page, card, tip, errors } = await open(t);
  assert.equal(await card("没有子 agent").locator(".sc-w").count(), 0, "0 个:没有这一行");
  assert.equal(await rowText(card("一个子 agent").locator(".sc-w .wt")), "调研上游 session-activity 的子 agent 标签字段", "1 个:写名字");
  assert.equal(await card("一个子 agent").locator(".sc-w .wn").evaluate((e) => getComputedStyle(e).display), "none", "宽卡不显示数字");
  assert.equal(await card("一个子 agent").locator(".sc-w .wk.sub .i").count(), 1, "机器人图标");
  assert.deepEqual(await tip(card("一个子 agent").locator(".wk.sub")), { head: null, body: "调研上游 session-activity 的子 agent 标签字段 · 已运行 9m" });
  assert.equal(await rowText(card("三个子 agent").locator(".sc-w .wt")), "3 个子 agent 执行中…", "多个:写个数");
  assert.deepEqual(await tip(card("三个子 agent").locator(".wk.sub")), { head: "3 个子 agent 执行中…", body: "方向 A · 已运行 31m\n方向 B · 已运行 30m\n方向 C · 已运行 29m" }, "悬停列出每一个");
  const mixed = card("子 agent 和后台任务");
  assert.deepEqual(await mixed.locator(".sc-w .wk").evaluateAll((es) => es.map((e) => [e.className, e.querySelector(".wt").textContent])), [["wk sub", "写测试"], ["wk job m", "2 个后台任务执行中…"]], "子 agent 和后台任务并排,后台任务用自己的图标");
  assert.deepEqual(await tip(mixed.locator(".wk.job")), { head: "2 个后台任务执行中…", body: "Run full dsh-verify · 已运行 6m\nWatch tests · 已运行 2m" });
  assert.deepEqual(await card("名字取不到").locator(".sc-w .wt").evaluateAll((es) => es.map((e) => e.textContent)), ["子 agent 9f8e7d6c", "后台任务 pwsh-0c0c0c0c"], "名字取不到:写 id");
  assert.deepEqual(await tip(card("名字取不到").locator(".wk.sub")), { head: null, body: "子 agent 9f8e7d6c" }, "开始时间取不到:不写已运行");
  assert.match(await card("名字取不到").locator(".sc-w .wid").first().evaluate((e) => getComputedStyle(e).fontFamily), /Cascadia|Consolas|mono/i, "id 用等宽字");
  assert.equal(await card("三个子 agent").locator(".sc-w .sr").textContent(), "正在执行的子 agent：方向 A · 已运行 31m、方向 B · 已运行 30m、方向 C · 已运行 29m", "读屏:卡片按钮里有完整清单");
  assert.equal(await card("子 agent 和后台任务").locator(".sc-w .sr").textContent(), "正在执行的子 agent：写测试 · 已运行 4m。正在执行的后台任务：Run full dsh-verify · 已运行 6m、Watch tests · 已运行 2m", "读屏:按类型分段");
  assert.equal(await card("三个子 agent").locator(".sc-w .wk").getAttribute("aria-hidden"), "true", "看得见的那段不重复读");
  const all = await page.evaluate(() => document.body.innerText + [...document.querySelectorAll("[title],[aria-label],[data-tip]")].map((e) => (e.getAttribute("title") || "") + (e.getAttribute("aria-label") || "") + (e.getAttribute("data-tip") || "")).join(""));
  assert.doesNotMatch(all, /等子 agent|等后台任务/, "不再显示「等子 agent / 等后台任务」");
  assert.deepEqual(errors, []);
});

test("详情:1 个一行;多个折叠,展开列出每一个(刷新后保持展开);回合结束只剩子 agent 时状态是蓝色「进行中」", { timeout: 90_000 }, async (t) => {
  const { page, errors } = await open(t, { hash: "#r=r3" });
  await page.waitForSelector(".bB>.dw");
  assert.equal(await page.locator(".dh .dw").count(), 0, "不在标题区里(在数字卡下面)");
  assert.equal(await page.textContent(".dh .chips .chip"), "进行中", "状态标签");
  assert.equal(await page.locator(".dh .chips .chip.blue .dotp").count(), 1, "蓝色呼吸点");
  assert.equal(await page.textContent(".dw summary"), "3 个子 agent 执行中…");
  assert.equal(await page.locator(".dw details").evaluate((d) => d.open), false, "默认收起");
  await page.click(".dw summary");
  assert.deepEqual(await page.locator(".dw details li").evaluateAll((es) => es.map((e) => [e.querySelector(".wt").textContent, e.querySelector(".wr")?.textContent ?? null])), [["方向 A", "已运行 31m"], ["方向 B", "已运行 30m"], ["方向 C", "已运行 29m"]]);
  await page.clock.runFor(4_500); // 一次 /data 轮询 + 重画
  await page.waitForTimeout(100);
  assert.equal(await page.locator(".dw details").evaluate((d) => d.open), true, "重画后仍展开");
  await page.click(".sc:has(.sc-tx:text-is('一个子 agent'))");
  await page.waitForSelector(".dw .dw-one");
  assert.equal(await page.locator(".dw details").count(), 0, "1 个不折叠");
  assert.deepEqual(await page.locator(".dw li").evaluateAll((es) => es.map((e) => e.textContent)), ["调研上游 session-activity 的子 agent 标签字段已运行 9m"]);
  await page.click(".sc:has(.sc-tx:text-is('子 agent 和后台任务'))");
  await page.waitForSelector(".dw .dw-one");
  assert.deepEqual(await page.locator(".dw > *").evaluateAll((es) => es.map((e) => e.tagName + ":" + (e.querySelector("summary")?.textContent ?? e.textContent))), ["UL:写测试已运行 4m", "DETAILS:2 个后台任务执行中…"], "子 agent 一行 + 后台任务折叠");
  await page.click(".sc:has(.sc-tx:text-is('没有子 agent'))");
  await page.waitForSelector(".dh .chips");
  assert.equal(await page.locator(".dw").count(), 0, "0 个:没有这一块");
  assert.deepEqual(errors, []);
});

test("旧服务端(没有 work):不显示这一行;只剩子 agent 在跑仍是进行中", { timeout: 60_000 }, async (t) => {
  const { page, card, errors } = await open(t, { body: () => ({ live }), hash: "#r=r3" });
  await page.waitForSelector(".dh .chips");
  assert.equal(await page.locator(".sc-w, .dw").count(), 0);
  assert.equal(await page.textContent(".dh .chips .chip"), "进行中");
  assert.equal(await card("三个子 agent").evaluate((e) => e.closest(".col")?.dataset.col ?? e.closest("[data-col]")?.dataset.col ?? null) !== "blk", true);
  assert.deepEqual(errors, []);
});

test("960 宽(小卡约 218px):两段并排时「n 个后台任务执行中…」写全,名字那段省略", { timeout: 60_000 }, async (t) => {
  const { card, errors } = await open(t, { width: 960 });
  const segs = await card("子 agent 和后台任务").locator(".sc-w .wk .wt").evaluateAll((es) => es.map((e) => ({ t: e.textContent, cut: e.scrollWidth > e.clientWidth + 1 })));
  assert.deepEqual(segs, [{ t: "写测试", cut: false }, { t: "2 个后台任务执行中…", cut: false }]);
  const noname = await card("名字取不到").locator(".sc-w .wk").evaluateAll((es) => es.map((e) => Math.round(e.getBoundingClientRect().width)));
  assert.ok(noname.every((w) => w >= 60), "两段都是名字时各自至少留 4 个字宽: " + noname);
  assert.deepEqual(errors, []);
});

test("窄屏 420:每段只留图标 + 数字、不撑破卡片;悬停照样列出全部", { timeout: 60_000 }, async (t) => {
  const { page, card, tip, errors } = await open(t, { width: 420 });
  const fits = await page.locator(".sc").evaluateAll((cs) => cs.map((c) => ({ t: c.querySelector(".sc-tx").textContent, over: c.scrollWidth > c.clientWidth || [...c.querySelectorAll(".sc-w")].some((w) => w.scrollWidth > w.clientWidth + 1) })));
  assert.deepEqual(fits.filter((f) => f.over), [], "没有卡片被这一行撑破");
  const one = card("一个子 agent").locator(".sc-w .wk");
  assert.deepEqual(await one.evaluate((e) => [getComputedStyle(e.querySelector(".wn")).display !== "none" && e.querySelector(".wn").textContent, e.querySelector(".wt").getBoundingClientRect().width <= 1]), ["1", true], "1 个也只留图标 + 1(两个字的省略没有信息量)");
  assert.equal((await tip(one)).body, "调研上游 session-activity 的子 agent 标签字段 · 已运行 9m", "悬停看名字");
  const many = card("三个子 agent").locator(".sc-w .wk");
  assert.equal(await many.locator(".wn").evaluate((e) => getComputedStyle(e).display !== "none" && e.textContent), "3", "多个:只留数字");
  assert.equal(await many.locator(".wt").evaluate((e) => e.getBoundingClientRect().width <= 1), true, "「n 个…」文字视觉隐藏(读屏仍读得到)");
  assert.equal((await tip(many)).head, "3 个子 agent 执行中…");
  const both = card("子 agent 和后台任务").locator(".sc-w .wk");
  assert.deepEqual(await both.evaluateAll((es) => es.map((e) => [e.querySelector(".wn").textContent, e.querySelector(".wt").getBoundingClientRect().width <= 1])), [["1", true], ["2", true]], "两段并排:每段都只留图标 + 数字");
  assert.deepEqual(errors, []);
});

// 两栏(右栏 ≥ 960)时这一行在左栏数字卡下面:左栏数字卡和右栏待办顶端对齐,不被它顶下去;单栏 / 窄屏同样在数字卡下面、事实行上面
const place = (page) => page.evaluate(() => {
  const r = (s) => document.querySelector(s)?.getBoundingClientRect() ?? null, dw = r(".dw"), k = r(".bB>.kpis:not(.more)"), facts = r(".facts"), right = r(".rbody>.after>:first-child"), chips = r(".dh .chips");
  return { inHeader: !!document.querySelector(".dh .dw"), twocol: getComputedStyle(document.querySelector(".rbody")).getPropertyValue("--twocol").trim() === "1", underCards: !!(dw && k && dw.top >= k.bottom - 1), aboveFacts: !!(dw && facts && dw.bottom <= facts.top + 1), topGap: right && k ? Math.round(Math.abs(right.top - k.top)) : null, cardsBelowChips: k && chips ? Math.round(k.top - chips.bottom) : null };
});
test("详情:这一行在数字卡下面;两栏时左右顶端对齐;单栏 575、窄屏 420 也在数字卡下面", { timeout: 90_000 }, async (t) => {
  const { page, errors } = await open(t, { width: 1600, hash: "#r=rv" });
  await page.waitForSelector(".bB>.dw");
  const wide = await place(page);
  assert.deepEqual({ ...wide, cardsBelowChips: undefined }, { inHeader: false, twocol: true, underCards: true, aboveFacts: true, topGap: 0, cardsBelowChips: undefined }, "两栏:左栏数字卡和右栏待办同一高度开始 " + JSON.stringify(wide));
  const noRow = await (async () => { await page.click(".sc:has(.sc-tx:text-is('没有子 agent'))"); await page.waitForSelector(".dh .chips"); return page.evaluate(() => document.querySelectorAll(".dw").length); })();
  assert.equal(noRow, 0, "没有在跑的:没有这一块");
  for (const width of [575, 420]) {
    await page.setViewportSize({ width, height: 900 });
    await page.click(".sc:has(.sc-tx:text-is('后台跑完整检查'))");
    await page.waitForSelector(".bB>.dw");
    await page.waitForTimeout(50);
    const p = await place(page);
    assert.deepEqual([p.inHeader, p.underCards, p.aboveFacts], [false, true, true], width + ": " + JSON.stringify(p));
  }
  assert.deepEqual(errors, []);
});

test("后台任务:名字可读,已运行不到 1 分钟写秒;悬停名字看命令原文,终端图标处复制命令", { timeout: 90_000 }, async (t) => {
  const { page, errors } = await open(t, { hash: "#r=rv" });
  await page.waitForSelector(".bB>.dw");
  assert.deepEqual(await page.locator(".dw li").evaluate((e) => [e.querySelector(".wt").textContent, e.querySelector(".wr").textContent]), ["完整检查 dsh-verify", "已运行 20s"]);
  await page.clock.runFor(60_000); // 页面每 30 秒重画一次走时:20s → 80s
  await page.waitForFunction(() => document.querySelector(".dw .wr")?.textContent === "已运行 1m");
  const name = page.locator(".dw li .wt");
  await name.hover();
  await page.waitForSelector("#tip:not([hidden])");
  assert.equal(await page.locator("#tip code").textContent(), VERIFY, "悬停名字:命令原文");
  const cp = page.locator(".dw li .cref");
  assert.equal(await cp.getAttribute("aria-label"), "复制命令：" + VERIFY);
  await cp.hover();
  await cp.click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), VERIFY, "复制的是命令原文");
  await page.waitForFunction(() => document.querySelector("#tip b")?.textContent === "已复制");
  await page.clock.runFor(1_600);
  await page.waitForFunction(() => document.querySelector(".dw li .cref")?.dataset.tipH === "复制命令", null, { timeout: 5000 });
  assert.deepEqual(errors, []);
});
