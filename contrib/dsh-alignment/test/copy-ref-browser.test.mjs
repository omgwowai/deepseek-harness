// 真浏览器回归(2026-10-24):对齐页详情区条目前面的图标悬停换成复制图标,点了复制这一条的引用;留言框认出引用,就地显示成短标签。
// - 时间线的轮次、决定行、会话链、待办、工具调用(每一次)、附件都有复制按钮;平时透明,悬停 / 键盘聚焦时出现;
// - 点击(或聚焦后回车)把引用写进剪贴板,图标换成勾、浮层第一行「已复制」,1.5 秒后恢复「复制引用」;读屏名「复制引用:<条目>」;
// - 引用格式见 cli/text-split.mjs refText(格式单测在 text-split.test.mjs);留言框粘贴一条引用 → 就地变成标签(蓝字,点了跳到那一条),发出去的是原文;
// - 别的页面的引用(登记名不同)是灰字标签,点了复制原文。
// 页面由 align.mjs render() 生成,本地 http 服务给页面、/data、/health、/alignment/todos、/alignment/tools;依赖本机 playwright-core(同 page-browser.test.mjs)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "align-copy-ref-"));
process.env.ALIGN_STORE = dir;
process.env.ALIGN_WORKSPACES = path.join(dir, "workspace.json");
const A = await import("../cli/align.mjs");
const S = await import("../cli/text-split.mjs");
const { chromium } = createRequire((process.env.DSH_ALIGN_PW_DIR ? path.join(process.env.DSH_ALIGN_PW_DIR, "package.json") : import.meta.url))("playwright-core");
// 一个文件只起一个 Chromium,各用例自己开 context(隔离不变)
let browserP;
const getBrowser = () => (browserP ??= chromium.launch({ headless: true }));
test.after(async () => { if (browserP) await (await browserP.catch(() => null))?.close(); });

const T = Date.parse("2026-10-24T10:00:00Z"), MIN = 60_000, iso = (ms) => new Date(ms).toISOString();
const SID1 = "session-1a2b3c4d-1111-2222-3333-444455556666", SID0 = "session-0f0e0d0c-1111-2222-3333-444455556666";
const doc = path.join(dir, "交接.md");
fs.writeFileSync(doc, "# 交接\n");
const data = {
  version: 3, name: "cref", title: "复制引用", owner: "session-fm", updated: iso(T), projects: [],
  rounds: [
    { id: "r0", sid: SID0, title: "上一个会话", stitle: "上一个会话", status: "accepted", started: iso(T - 300 * MIN), ended: iso(T - 200 * MIN), result: "好了" },
    { id: "r1", sid: SID1, title: "交了结果的一轮", stitle: "这个会话", status: "done", mode: "new", prev: "r0", handoff: doc, started: iso(T - 60 * MIN), ended: iso(T - MIN), result: "做完了", link: [{ href: doc, title: "交接文件" }] },
  ],
  decisions: [{ id: "d1", title: "要不要合入", why: "合入前要你定。", status: "open", opened: iso(T - 30 * MIN), round: "r1", risk: "低", cat: "其他", opt: [{ label: "合", effect: "上线" }, { label: "不合", effect: "等" }] }],
  notes: [],
};
const item = (text, status) => ({ text, status, eta: null, startedAt: null, completedAt: null, elapsedMs: null, spans: [], approx: false });
const todos = { rev: "aaaaaaaaaaaa", updatedAt: iso(T - MIN), turn: 1, latestTurn: 1, running: false, done: 1, total: 2, items: [item("写接口", "completed"), item("补测试", "pending")] };
const occ = { id: "toolu_1", at: iso(T - 20 * MIN), tool: "read", inner: true, args: "读 a.md", params: "{}", ms: 1200, chars: null, text: "Error: not found", agent: null };
const groups = { error: [{ key: "read|nf", tool: "read", label: "Error: not found", count: 1, worst: 0, more: 0, items: [occ] }], timeout: [], slow: [], big: [] };

function serve() {
  const html = A.render(data);
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://x"), p = u.pathname;
    const json = (body) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (p === "/alignment/p/cref") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(html); }
    if (p === "/alignment/p/cref/data") return json({ ...data, live: {} });
    if (p.endsWith("/log")) return json({ ok: true });
    if (p === "/alignment/health") return json({ ok: true, api: A.API_VERSION, tools: 3 });
    if (p === "/alignment/todos") return json({ ok: true, api: 3, sessions: { [SID1]: todos }, activity: {} });
    if (p === "/alignment/tools/runs") return json({ ok: true, api: 3, sid: u.searchParams.get("sid"), runs: {} });
    if (p === "/alignment/tools") return json({ ok: true, api: 2, sid: u.searchParams.get("sid"), calls: 10, subCalls: 0, subagents: 0, agents: [], ms: 1, baseline: { builtAt: iso(T), from: iso(T - 7 * 864e5), windowDays: 30, tools: 3 }, baselineError: null, groups });
    if (p === "/alignment/fm") return json({ ok: true, page: "cref", fm: null, refresh: null });
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, base: "http://127.0.0.1:" + server.address().port })));
}

async function open(t, hash) {
  const { server, base } = await serve();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await getBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ["clipboard-read", "clipboard-write"] });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  page.setDefaultTimeout(5000);
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base + "/alignment/p/cref" + hash);
  await page.waitForSelector("#rbody .dh");
  return { page, errors, clip: () => page.evaluate(() => navigator.clipboard.readText()), tip: () => page.evaluate(() => { const el = document.getElementById("tip"); return el.hidden ? null : el.innerText; }) };
}

test("详情区各类条目都有复制按钮;引用就是 refText 的写法", { timeout: 60_000 }, async (t) => {
  const { page, errors } = await open(t, "#r=r1");
  await page.waitForSelector(".todos li .cref");
  await page.waitForSelector(".an .occ>li .cref", { state: "attached" });
  const refs = await page.evaluate(() => ({
    round: [...document.querySelectorAll(".tl>li>.cref")].map((b) => b.dataset.ref),
    dec: [...document.querySelectorAll(".tl .crw>.cref")].map((b) => b.dataset.ref),
    chain: [...document.querySelectorAll(".chain li>.cref")].map((b) => b.dataset.ref),
    todo: [...document.querySelectorAll(".todos li>.cref")].map((b) => b.dataset.ref),
    tool: [...document.querySelectorAll(".an .occ>li>.cref")].map((b) => b.dataset.ref),
    att: [...document.querySelectorAll(".aw>.cref")].map((b) => b.dataset.ref),
    aria: document.querySelector(".todos li>.cref").getAttribute("aria-label"),
  }));
  assert.deepEqual(refs.round, [S.refText("cref", "r", "r1", "", "", "交了结果的一轮")]);
  assert.deepEqual(refs.dec, [S.refText("cref", "d", "d1", "", "", "要不要合入")]);
  assert.deepEqual(refs.chain, [S.refText("cref", "r", "r0", "会话", SID0, "上一个会话"), S.refText("cref", "r", "r1", "会话", SID1, "这个会话")]);
  assert.deepEqual(refs.todo, [S.refText("cref", "r", "r1", "待办", "1", "写接口"), S.refText("cref", "r", "r1", "待办", "2", "补测试")]);
  const d = new Date(occ.at), at = (d.getMonth() + 1) + "/" + d.getDate() + " " + d.toTimeString().slice(0, 8);
  assert.deepEqual(refs.tool, [S.refText("cref", "r", "r1", "工具调用", "read " + at + " toolu_1", "读 a.md")]);
  assert.deepEqual(refs.att, [S.refText("cref", "r", "r1", "附件", doc, "交接文件")]);
  assert.equal(refs.aria, "复制引用：待办 1：写接口");
  // 决定详情的附件:换到决定页签,决定行也有按钮
  await page.click('[data-act="tab"][data-v="dec"]');
  await page.waitForSelector(".ds .crw>.cref");
  assert.equal(await page.$eval(".ds .crw>.cref", (b) => b.dataset.ref), S.refText("cref", "d", "d1", "", "", "要不要合入"));
  assert.deepEqual(errors, []);
});

test("悬停才出现;点了复制、图标换成勾、浮层「已复制」,1.5 秒后恢复;键盘聚焦后回车也能复制", { timeout: 60_000 }, async (t) => {
  const { page, errors, clip, tip } = await open(t, "#r=r1");
  await page.waitForSelector(".todos li .cref");
  const b = page.locator(".tl>li>.cref").first();
  assert.equal(await b.evaluate((x) => getComputedStyle(x).opacity), "0", "平时不显示");
  await b.hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".tl>li>.cref")).opacity === "1");
  assert.equal(await tip(), "复制引用", "浮层只写动作，不回显引用原文");
  assert.equal(await page.$eval("#tip", (x) => x.children.length), 1, "只有一行，没有空的第二行");
  await b.click();
  await page.waitForFunction(() => document.querySelector(".tl>li>.cref").classList.contains("ok"));
  assert.equal(await clip(), S.refText("cref", "r", "r1", "", "", "交了结果的一轮"));
  assert.equal(await tip(), "已复制");
  assert.equal(await b.evaluate((x) => !!x.querySelector("path[d^='M3.5 8.5']")), true, "图标换成勾");
  await page.waitForFunction(() => document.getElementById("live-msg").textContent === "已复制", null, { timeout: 2000 });
  await page.waitForFunction(() => !document.querySelector(".tl>li>.cref").classList.contains("ok"), null, { timeout: 4000 });
  assert.equal(await b.getAttribute("data-tip-h"), "复制引用");
  // 键盘:从待办 1 的按钮按 Tab 到待办 2 的按钮(按键聚焦才算 :focus-visible;鼠标点过之后程序 focus() 不算),聚焦时可见,回车复制
  await page.evaluate(() => navigator.clipboard.writeText(""));
  await page.locator(".todos li").nth(0).locator(">.cref").focus();
  await page.keyboard.press("Tab");
  // 淡入 120ms:等到终态再读
  await page.waitForFunction(() => { const x = document.activeElement; return x === document.querySelectorAll(".todos li>.cref")[1] && x.matches(":focus-visible") && getComputedStyle(x).opacity === "1"; }, null, { timeout: 2000 });
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll(".todos li>.cref")[1].classList.contains("ok"));
  assert.equal(await clip(), S.refText("cref", "r", "r1", "待办", "2", "补测试"));
  // 复制不了(页面没拿到焦点):图标换成警示,浮层写原因,读屏同样播报;4 秒后恢复
  await page.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new DOMException("Document is not focused.", "NotAllowedError")); });
  const f = page.locator(".todos li").nth(0).locator(">.cref");
  await f.hover(); await f.click();
  await page.waitForFunction(() => document.querySelectorAll(".todos li>.cref")[0].classList.contains("bad"));
  assert.equal(await tip(), "复制失败\n页面没有获得焦点，点一下页面后重试");
  await page.waitForFunction(() => document.getElementById("live-msg").textContent === "复制失败：页面没有获得焦点，点一下页面后重试", null, { timeout: 2000 });
  // 工具调用:整行悬停时按钮出现
  const o = page.locator(".an .occ>li").first();
  await page.evaluate(() => { for (const d of document.querySelectorAll(".an details")) d.open = true; });
  await o.hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".an .occ>li>.cref")).opacity === "1");
  assert.deepEqual(errors, []);
});

test("留言框:粘贴的引用就地变成标签(这一页的是蓝字,点了跳过去),发出去的是原文;别的页面的引用灰字、点了复制", { timeout: 60_000 }, async (t) => {
  const { page, errors, clip } = await open(t, "#d=d1");
  await page.click("#mbtn");
  const mine = S.refText("cref", "r", "r1", "待办", "2", "补测试"), other = S.refText("other-page", "d", "x1", "", "", "别处的决定");
  await page.keyboard.type("看下 ");
  await page.evaluate((s) => { const dt = new DataTransfer(); dt.setData("text/plain", s); document.getElementById("memo-in").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); }, mine + " 和 " + other);
  const tags = await page.$$eval("#memo-in .tk", (xs) => xs.map((x) => ({ cls: x.className, label: x.querySelector(".tl").textContent, act: x.dataset.act, raw: x.dataset.raw })));
  assert.deepEqual(tags.map((x) => [x.cls, x.label, x.act]), [["tk go rf", "待办 2：补测试", "go-ref"], ["tk rf", "决定：别处的决定", "copy"]]);
  // 这一页的引用：浮层第一行这一项，第二行小字它所在的轮次
  await page.hover("#memo-in .tk.go");
  await page.waitForFunction(() => !document.getElementById("tip").hidden);
  assert.deepEqual(await page.$eval("#tip", (x) => [...x.children].map((c) => c.tagName + " " + c.textContent)), ["B 待办 2：补测试", "SMALL 交了结果的一轮"]);
  assert.deepEqual(tags.map((x) => x.raw), [mine, other]);
  // 读屏:自然语序、不念括号
  assert.deepEqual(await page.$$eval("#memo-in .tk.rf .sr", (xs) => xs.map((x) => x.textContent)), ["待办 2：补测试，对齐页 cref 轮次 r1", "决定：别处的决定，对齐页 other-page 决定 x1"]);
  const draft = await page.evaluate(() => JSON.parse(localStorage.getItem("align-picks:cref"))["m:"].text);
  assert.equal(draft, "看下 " + mine + " 和 " + other, "草稿 / 发送用原文");
  // 退格一次删掉整个标签
  await page.keyboard.press("Backspace");
  assert.equal(await page.$$eval("#memo-in .tk", (xs) => xs.length), 1);
  // 蓝字标签点了跳到那一轮(会话页签)
  await page.click("#memo-in .tk.go");
  await page.waitForFunction(() => location.hash === "#r=r1");
  assert.equal(await page.$eval('[data-act="tab"][aria-selected="true"]', (x) => x.dataset.v), "sess");
  // 发送条展开列表、正文里同样认:用发送条列表核对 inert 标签
  await page.evaluate(() => { const s = document.querySelector('[data-act="queue"]'); if (s) s.click(); });
  const q = await page.$$eval(".qlist .tk", (xs) => xs.map((x) => x.className));
  assert.ok(q.includes("tk go rf"), "发送条列表里也是标签");
  assert.equal(typeof (await clip()), "string");
  assert.deepEqual(errors, []);
});
