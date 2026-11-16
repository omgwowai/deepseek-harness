// 真浏览器回归(2026-11-02):阻塞栏里「会话交了结果、等 First Mate 登记」和「真的停了」「暂缓」一眼分开。
// - 已停(doing、会话空闲、没挂决定)按会话最后一个回合怎么结束分两种(/alignment/todos api 5 的 ended):正常结束 = 「待登记」(沙漏图标、ink2);
//   出错 / 被停止 / 被打断 / 回合没收尾 / 旧服务端没有 ended = 「已停」(方块图标、ink)。悬停写回合几点怎么结束的;详情的状态标签同一套。
// - 暂缓悬停写从什么时候起。
// - 宽屏下「已停」「暂缓」这种两个字的原因也写出来:之前 fitMeta 要求原因文字至少 36px,两个字(24px)永远判成放不下、只剩图标,
//   已停和暂缓只靠 12px 的图标分。RED = 旧模板:宽屏下 .rs.stopped / .rs.paused 的文字被 fit-x 藏掉,也没有「待登记」。
// 页面由 align.mjs render() 生成,本地 http 服务给页面、/data、/alignment/todos;依赖本机 playwright-core(同 page-browser.test.mjs)。
// ALIGN_SHOTS=<目录> 时另存宽屏的阻塞栏截图。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "align-blocked-reason-"));
process.env.ALIGN_STORE = dir;
process.env.ALIGN_WORKSPACES = path.join(dir, "workspace.json");
const A = await import("../cli/align.mjs");
const { chromium } = createRequire((process.env.DSH_ALIGN_PW_DIR ? path.join(process.env.DSH_ALIGN_PW_DIR, "package.json") : import.meta.url))("playwright-core");

const T = Date.parse("2026-11-02T02:30:00+08:00"), MIN = 60_000, ago = (m) => T - m * MIN, iso = (ms) => new Date(ms).toISOString();
const round = (id, title, x = {}) => ({ id, sid: "session-" + id, title, status: "doing", mode: "new", proj: "p1", started: iso(ago(120)), updated: iso(ago(40)), state: "在做", eta: "1h", ...x });
const data = {
  version: 3, name: "br", title: "对齐", owner: "session-fm", updated: iso(T), projects: [{ id: "p1", title: "highschool", cwd: "C:/p/p1" }],
  rounds: [
    round("handed", "交了等登记"),
    round("cut", "被打断"),
    round("errd", "出错结束"),
    round("noend", "旧服务端"),
    round("pz", "暂缓的", { status: "paused", pauses: [{ from: "2026-11-01T21:30:00+08:00" }] }),
  ],
  decisions: [], notes: [],
};
const live = Object.fromEntries(data.rounds.map((r) => [r.sid, "idle"]));
const activity = Object.fromEntries(data.rounds.map((r) => [r.sid, [[ago(90), ago(46)]]]));
const ended = { "session-handed": { at: ago(46), kind: "completed" }, "session-cut": { at: ago(46), kind: "interrupted" }, "session-errd": { at: ago(46), kind: "error" }, "session-pz": { at: ago(301), kind: "completed" } };

async function open(t, width) {
  const html = A.render(data);
  const server = createServer((req, res) => {
    const p = req.url.split("?")[0];
    const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (p === "/alignment/p/br") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(html); }
    if (p === "/alignment/p/br/data") return json(200, { ...data, live, work: {} });
    if (p === "/alignment/health") return json(200, { ok: true, api: A.API_VERSION });
    if (p === "/alignment/todos") return json(200, { ok: true, api: 5, sessions: {}, activity, background: {}, notodo: {}, ended });
    if (p === "/alignment/fm") return json(200, { ok: true, page: "br", fm: { sid: "session-fm", title: "first mate" }, refresh: null });
    if (p.endsWith("/log")) return json(200, { ok: true });
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(5000);
  await page.clock.setFixedTime(T);
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("http://127.0.0.1:" + server.address().port + "/alignment/p/br?theme=light");
  // 等待办 / 回合取到(待登记只在拿到 ended 后出现)
  await page.waitForSelector(".col.blk .rs.handed");
  return { page, errors };
}

const reasons = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll(".col.blk .sc")].map((e) => {
  const rs = e.querySelector(".rs"), rt = rs.querySelector(".rt");
  return [e.querySelector(".sc-tx").textContent, { k: rs.className.replace(/^rs /, "").replace(/ fit-x$/, ""), text: rt.textContent, shown: !rt.classList.contains("fit-x") && rt.getBoundingClientRect().width >= 20 && rt.scrollWidth <= rt.clientWidth, tip: rs.getAttribute("title"), color: getComputedStyle(rs).color }];
})));

test("宽屏:待登记 / 已停 / 暂缓各自写出来,悬停说回合怎么结束、暂缓自何时;详情标签同一套", { timeout: 60_000 }, async (t) => {
  const { page, errors } = await open(t, 1440);
  const g = await reasons(page);
  const ink = "rgb(21, 23, 27)", ink2 = "rgb(68, 73, 81)", ink3 = "rgb(100, 106, 115)";
  assert.deepEqual(g["交了等登记"], { k: "handed", text: "待登记", shown: true, tip: "01:44 回合正常结束，等 First Mate 登记", color: ink2 });
  assert.deepEqual(g["被打断"], { k: "stopped", text: "已停", shown: true, tip: "01:44 回合被打断", color: ink });
  assert.deepEqual(g["出错结束"], { k: "stopped", text: "已停", shown: true, tip: "01:44 回合出错结束", color: ink });
  assert.deepEqual(g["旧服务端"], { k: "stopped", text: "已停", shown: true, tip: "已停", color: ink }, "没有 ended(旧服务端 / 读不出来):照旧写已停");
  assert.deepEqual(g["暂缓的"], { k: "paused", text: "暂缓", shown: true, tip: "暂缓自 11/1 21:30", color: ink3 });
  assert.equal(await page.locator(".col.blk .sc .rs.handed .i").count(), 1, "待登记有自己的图标");
  assert.notEqual(await page.locator(".col.blk .sc .rs.handed svg").innerHTML(), await page.locator(".col.blk .sc .rs.stopped svg").first().innerHTML(), "和已停不是同一个图标");
  if (process.env.ALIGN_SHOTS) await page.locator(".cols .col.blk").screenshot({ path: path.join(process.env.ALIGN_SHOTS, "blocked-reason-1440.webp"), type: "webp", quality: 75 });
  await page.locator(".col.blk .sc", { hasText: "交了等登记" }).click();
  await page.waitForSelector(".dh .chips");
  assert.equal(await page.locator(".dh .chips .chip").first().textContent(), "待登记", "详情的状态标签");
  assert.equal(await page.locator(".dh .chips .chip").first().getAttribute("class"), "chip hand", "描边标签:和「新开」「时间」这些灰底元信息分开");
  assert.equal(await page.locator(".dh .chips .chip").first().getAttribute("title"), "01:44 回合正常结束，等 First Mate 登记");
  await page.locator(".col.blk .sc", { hasText: "被打断" }).click();
  assert.equal(await page.locator(".dh .chips .chip").first().textContent(), "已停");
  await page.locator(".col.blk .sc", { hasText: "旧服务端" }).click();
  assert.equal(await page.locator(".dh .chips .chip").first().getAttribute("title"), null, "没有标签以外的信息:详情标签不挂悬停");
  const body = await page.evaluate(() => document.body.innerText);
  assert.doesNotMatch(body, /undefined|null/, "没有漏出空值");
  assert.deepEqual(errors, []);
});
