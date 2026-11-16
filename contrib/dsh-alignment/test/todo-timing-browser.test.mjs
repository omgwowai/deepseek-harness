// 真浏览器回归(2026-10-24):对齐页会话详情的待办,每项显示「已用 X」和「预计 Y」。
// 以前只有进行中的那一项显示用时(还停在拿到数据那一刻),完成的项不显示已用用时。现在:
// - 已用 = 进行中区间(spans)落在会话回合(activity)里的部分;完成项保留,进行中的项随页面重画走时;
// - 预计 = [ETA 中位/P75] 的区间;超出 P75 的已用用时用琥珀色标出;推断出来的区间(approx)和旧服务端的数据前面写「约」;
// - 没开始的只显示预计,没有估时也没开始的什么都不显示。
// 页面由 align.mjs render() 生成,本地 http 服务给页面、/data、/alignment/todos;依赖本机 playwright-core(同 page-browser.test.mjs)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "align-todo-timing-"));
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
  version: 3, name: "tt", title: "待办用时", owner: "session-fm", updated: iso(T), projects: [],
  rounds: [{ id: "r1", sid: "session-w1", title: "某会话", status: "running", started: iso(ago(30)), next: "继续" }],
  decisions: [], notes: [],
};
const item = (text, status, eta, spans, extra = {}) => ({ text, status, eta, startedAt: spans.length ? iso(spans[0][0]) : null, completedAt: null, elapsedMs: null, spans, approx: false, ...extra });
const todosNew = {
  rev: "aaaaaaaaaaaa", updatedAt: iso(ago(2)), turn: 1, latestTurn: 1, running: true, done: 3, total: 6,
  items: [
    item("写接口", "completed", { p50: 300, p75: 600 }, [[ago(20), ago(16)]]),
    item("改页面", "completed", { p50: 60, p75: 120 }, [[ago(16), ago(11)]]),
    item("补测试", "completed", null, [[ago(11), ago(9)]], { approx: true }),
    item("跑门禁", "in_progress", { p50: 300, p75: 600 }, [[ago(2), null]]),
    item("截图", "pending", { p50: 120, p75: 300 }, []),
    item("写汇报", "pending", null, []),
  ],
};
// 旧服务端(重启前的 3080):没有 spans / approx,完成项 elapsedMs 是墙钟时间,进行中的只有 startedAt
const todosOld = { ...todosNew, items: todosNew.items.map(({ spans, approx, ...x }) => ({ ...x, elapsedMs: x.status === "completed" ? spans[0][1] - spans[0][0] : x.status === "in_progress" ? 0 : null })) };

function serve(todos) {
  const html = A.render(data);
  const server = createServer((req, res) => {
    const p = req.url.split("?")[0];
    const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (p === "/alignment/p/tt") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(html); }
    if (p === "/alignment/p/tt/data") return json(200, { ...data, live: { "session-w1": "running" } });
    if (p === "/alignment/health") return json(200, { ok: true, api: A.API_VERSION });
    if (p === "/alignment/todos") return json(200, { ok: true, api: 2, sessions: { "session-w1": todos }, activity: { "session-w1": [[ago(30), null]] } });
    if (p === "/alignment/fm") return json(200, { ok: true, page: "tt", fm: { sid: "session-fm", title: "first mate" }, refresh: null });
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, base: "http://127.0.0.1:" + server.address().port })));
}

async function open(t, todos, width) {
  const { server, base } = await serve(todos);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await getBrowser();
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  await page.clock.install({ time: T });
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base + "/alignment/p/tt?theme=light#r=r1");
  await page.waitForSelector(".todos li .pd");
  const rows = () => page.evaluate(() => [...document.querySelectorAll(".todos li")].map((li) => ({
    text: li.querySelector(".tx").textContent, ac: li.querySelector(".ac")?.textContent ?? null, pd: li.querySelector(".pd")?.textContent ?? null,
    over: !!li.querySelector(".ac.over"), color: li.querySelector(".ac b") ? getComputedStyle(li.querySelector(".ac b")).color : null,
  })));
  return { page, rows, errors };
}

test("待办每项:已用 / 预计;超出 P75 琥珀;进行中的项走时;没开始的只有预计", { timeout: 60_000 }, async (t) => {
  const { page, rows, errors } = await open(t, todosNew, 1280);
  const r = await rows();
  assert.deepEqual(r.map(({ text, ac, pd, over }) => [text, ac, pd, over]), [
    ["写接口", "已用4m", "预计5m–10m", false],
    ["改页面", "已用5m，超出预计范围", "预计1m–2m", true],
    ["补测试", "已用约 2m", null, false],
    ["跑门禁", "已用2m", "预计5m–10m", false],
    ["截图", null, "预计2m–5m", false],
    ["写汇报", null, null, false],
  ]);
  assert.equal(r[1].color, "rgb(163, 95, 0)", "超出 P75 用琥珀色(--amber)");
  assert.notEqual(r[0].color, r[1].color);
  await page.clock.fastForward("09:00"); // 重画每 30 s 一次
  await page.waitForFunction(() => [...document.querySelectorAll(".todos li")][3]?.querySelector(".ac")?.textContent === "已用11m，超出预计范围"); // 等重画
  const r2 = await rows();
  assert.deepEqual([r2[3].ac, r2[3].over], ["已用11m，超出预计范围", true], "进行中的项跟着走时,超出 P75 后变琥珀");
  assert.equal(r2[0].ac, "已用4m", "完成项保留已用用时");
  assert.deepEqual(errors, []);
});

test("窄屏(约 420 宽的侧栏):时间换到文字下一行,已用和预计之间有分隔", { timeout: 60_000 }, async (t) => {
  const { page, errors } = await open(t, todosNew, 420);
  const g = await page.evaluate(() => {
    const li = document.querySelectorAll(".todos li")[0], tx = li.querySelector(".tx").getBoundingClientRect(), ac = li.querySelector(".ac").getBoundingClientRect();
    return { below: ac.top >= tx.bottom - 1, left: Math.abs(ac.left - tx.left) < 1, sl: getComputedStyle(li.querySelector(".sl")).display !== "none", fits: document.querySelector(".todos").scrollWidth <= document.querySelector(".todos").clientWidth };
  });
  assert.deepEqual(g, { below: true, left: true, sl: true, fits: true });
  assert.deepEqual(errors, []);
});

test("旧服务端(没有 spans):完成项按 elapsedMs、进行中按 startedAt 粗算,都标「约」", { timeout: 60_000 }, async (t) => {
  const { rows, errors } = await open(t, todosOld, 1280);
  const r = await rows();
  assert.deepEqual(r.map((x) => x.ac), ["已用约 4m", "已用约 5m，超出预计范围", "已用约 2m", "已用约 2m", null, null]);
  assert.deepEqual(errors, []);
});
