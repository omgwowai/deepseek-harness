// 真浏览器（2026-11-08）：对齐页整页打开（不在 DSH 侧栏里，由服务端给的 /alignment/p/<页>）。
// - 「打开会话」「First Mate」在整页里也有：点了在名为 dsh-alignment-main 的标签页打开 /#align-open=<会话>（DSH 里的 client.js 切主区），
//   再点复用同一个标签页；那个标签页发回的失败写进页面；别的窗口发来的不认。
// - 宽屏（≥ 1280）：Curio 在会话区左边成一栏，四个状态列在右边、顶端对齐；窄于 1280 仍是上下排。
// - 浏览器标签上的名字带待决定数。
// 页面由 align.mjs render() 生成，依赖本机 playwright-core（同 curio-browser.test.mjs）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "align-fullpage-browser-"));
process.env.ALIGN_STORE = dir;
process.env.ALIGN_WORKSPACES = path.join(dir, "workspace.json");
const A = await import("../cli/align.mjs");
const { chromium } = createRequire((process.env.DSH_ALIGN_PW_DIR ? path.join(process.env.DSH_ALIGN_PW_DIR, "package.json") : import.meta.url))("playwright-core");

const T = Date.parse("2026-11-08T22:00:00+08:00"), MIN = 60_000, iso = (ms) => new Date(ms).toISOString();
const CUR = "session-curio0000-0000", W1 = "session-w1";
const data = {
  version: 3, name: "fp", title: "对齐", owner: "session-fm", updated: iso(T),
  projects: [{ id: "p", title: ".dsh", cwd: "C:\\x\\.dsh" }],
  rounds: [
    { id: "r-c", sid: CUR, title: "Curio 研究", status: "doing", mode: "continue", proj: "p", started: iso(T - 20 * MIN), updated: iso(T - 20 * MIN) },
    { id: "r-1", sid: W1, title: "整页打开按钮", status: "doing", mode: "new", proj: "p", started: iso(T - 10 * MIN), updated: iso(T - 10 * MIN) },
  ],
  decisions: [
    { id: "d-1", title: "按钮放哪", status: "open", risk: "低", round: "r-1", proj: "p", opened: iso(T - 5 * MIN), updated: iso(T - 5 * MIN), opt: [{ label: "顶栏" }, { label: "菜单" }] },
    { id: "d-2", title: "要不要带上选中项", status: "open", risk: "中", round: "r-1", proj: "p", opened: iso(T - 6 * MIN), updated: iso(T - 6 * MIN), opt: [{ label: "带" }, { label: "不带" }] },
  ],
  notes: [],
};
const curio = { sid: CUR, state: "running", private: false, live: "running", subagents: 2, cap: 8, goal: { objective: "多 agent 研究", phase: "active", round: 3, max: 20, since: T - 20 * MIN }, pause: null, models: null, cooling: [] };

function serve() {
  const html = A.render(data);
  const server = createServer((req, res) => {
    const p = req.url.split("?")[0];
    const json = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    if (p === "/alignment/p/fp") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(html); }
    if (p === "/alignment/p/fp/data") return json(200, { ...data, live: { [CUR]: "running", [W1]: "running" }, work: {} });
    if (p === "/alignment/health") return json(200, { ok: true, api: A.API_VERSION });
    if (p === "/alignment/curio") return json(200, { ok: true, api: 1, curio });
    if (p === "/alignment/todos") return json(200, { ok: true, api: 5, sessions: {}, activity: {}, background: {}, notodo: {}, ended: {} });
    if (p === "/alignment/fm") return json(200, { ok: true, page: "fp", fm: { sid: "session-fm", title: "first mate" }, refresh: null });
    if (p.endsWith("/log")) return json(200, { ok: true });
    // 当作 DSH 首页：只给打开它的对齐页回一条失败（真的切主区在 client.test.mjs 的 createDeepLink 里测）
    if (p === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end("<!doctype html><title>DSH</title><script>opener && opener.postMessage({ type: 'dsh-alignment/open-session-result', ok: false, error: 'DSH 里找不到这个会话' }, location.origin)</script>"); }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, base: "http://127.0.0.1:" + server.address().port })));
}

let browser;
async function open(t, width) {
  const { server, base } = await serve();
  t.after(() => { server.closeAllConnections(); server.close(); });
  browser ??= await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  t.after(() => ctx.close());
  ctx.setDefaultTimeout(5000);
  const page = await ctx.newPage();
  await page.clock.install({ time: T });
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base + "/alignment/p/fp");
  await page.waitForSelector(".cols");
  return { page, ctx, base, errors };
}
test.after(() => browser?.close());

test("整页：First Mate 和「打开会话」在 DSH 标签页里打开，再点复用同一个；失败写进页面", { timeout: 60_000 }, async (t) => {
  const { page, ctx, base, errors } = await open(t, 1440);
  assert.equal(await page.title(), "(2) 对齐", "标签名带待决定数");
  const fmBtn = page.locator('.fmtools [data-act="open-sess"]');
  await fmBtn.waitFor();
  await page.waitForFunction(() => document.querySelector('.fmtools [data-act="open-sess"]')?.dataset.sid === "session-fm");
  const [tab] = await Promise.all([ctx.waitForEvent("page"), fmBtn.click()]);
  await tab.waitForLoadState();
  assert.equal(tab.url(), base + "/#align-open=session-fm");
  assert.equal(await tab.evaluate(() => window.name), "dsh-alignment-main", "按窗口名复用");
  await page.waitForFunction(() => document.getElementById("live-msg").textContent === "打开会话失败：DSH 里找不到这个会话");
  // 会话详情里的「打开会话」：同一个标签页换地址，不再多开
  await page.evaluate(() => { location.hash = "r=r-1"; });
  const chip = page.locator('.sh [data-act="open-sess"]');
  await chip.waitFor();
  assert.equal(await chip.textContent(), "打开会话");
  await chip.click();
  await tab.waitForURL(base + "/#align-open=" + W1);
  assert.equal(ctx.pages().length, 2, "还是那一个 DSH 标签页");
  // Curio 区的「打开会话」同样有
  assert.equal(await page.locator('section.cio [data-act="open-sess"]').getAttribute("data-sid"), CUR);
  // 别的窗口发来的结果不认
  await page.evaluate(() => { document.getElementById("live-msg").textContent = ""; window.postMessage({ type: "dsh-alignment/open-session-result", ok: false, error: "假的" }, location.origin); });
  await page.waitForTimeout(150);
  assert.equal(await page.locator("#live-msg").textContent(), "");
  assert.deepEqual(errors, []);
});

test("整页宽屏：Curio 在会话区左边成一栏，状态列在右边顶端对齐；窄于 1280 上下排", { timeout: 60_000 }, async (t) => {
  for (const [w, side] of [[1440, true], [1920, true], [1100, false]]) {
    const { page, errors } = await open(t, w);
    await page.locator("section.cio").waitFor();
    const [c, k] = await Promise.all([page.locator("section.cio").boundingBox(), page.locator(".cols").boundingBox()]);
    if (side) {
      assert.ok(c.x + c.width <= k.x, w + "：Curio 在状态列左边 " + JSON.stringify([c, k]));
      assert.ok(Math.abs(c.y - k.y) <= 1, w + "：顶端对齐");
      assert.ok(c.width >= 280 && c.width <= w * 0.25, w + "：Curio 栏宽 " + c.width);
    } else assert.ok(k.y >= c.y + c.height - 1, w + "：窄屏仍是上下排");
    const over = await page.evaluate(() => { const b = document.getElementById("board"); return b.scrollWidth - b.clientWidth; });
    assert.ok(over <= 1, w + "：会话区没有横向溢出 " + over);
    assert.deepEqual(errors, []);
  }
});
