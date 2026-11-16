// 真浏览器回归(2026-10-24):对齐页「已完成」栏项目条拖动排序,其他栏跟随。
// 1. 鼠标按住「已完成」栏第三个项目条往上拖:拖动中原位置是虚影(.pcard.ph),跟手的是副本(.pcard.pdrag),经过的项目条用 transform 让开;
//    放下后 POST /order 恰好一次(拖动中不发),带着新顺序;「进行中」「待验收」栏和决定列表的项目顺序跟着变。
// 2. Alt+↑ 键盘排序:连按两次只存一次。3. 420 宽 + 触屏(hasTouch)从把手拖也能排。4. 保存失败:换回原顺序并提示。
// 页面由 align.mjs render() 生成,本地 http 服务给 /alignment/p/<页>、/data、/order(按 align.mjs setProjOrder 写真文件)。
// 依赖插件 devDependencies 里的 playwright-core（DSH_ALIGN_PW_DIR 覆盖）,缺失即失败。ALIGN_SHOTS=<目录> 时另存拖动中 / 放下后截图。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "align-order-"));
process.env.ALIGN_STORE = dir;
process.env.ALIGN_WORKSPACES = path.join(dir, "workspace.json");
const A = await import("../cli/align.mjs");
const { chromium } = createRequire((process.env.DSH_ALIGN_PW_DIR ? path.join(process.env.DSH_ALIGN_PW_DIR, "package.json") : import.meta.url))("playwright-core");
// 一个文件只起一个 Chromium,各用例自己开 context(隔离不变)
let browserP;
const getBrowser = () => (browserP ??= chromium.launch({ headless: true }));
test.after(async () => { if (browserP) await (await browserP.catch(() => null))?.close(); });

const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
const P = [["pa", "dsh-core"], ["pb", "first-mate"], ["pc", "sims-overlay"], ["pd", "notes-app"]];
function seed(name) {
  const rounds = [], decisions = [];
  // 已完成:每个项目 4-k 个(默认顺序 = 会话多的在前:pa pb pc pd);进行中、待验收每个项目各一个
  P.forEach(([id], k) => {
    for (let i = 0; i < 4 - k; i++) rounds.push({ id: id + "-e" + i, sid: "session-" + id + "e" + i, title: id + " 已结束 " + i, status: "accepted", proj: id, started: ago(300), ended: ago(200 + i) });
    rounds.push({ id: id + "-d", sid: "session-" + id + "d", title: id + " 在跑", status: "doing", proj: id, started: ago(20), next: "继续" });
    rounds.push({ id: id + "-v", sid: "session-" + id + "v", title: id + " 等验收", status: "done", proj: id, started: ago(90), ended: ago(30 + k), result: "交了" });
    decisions.push({ id: id + "-q", title: id + " 要不要做", why: "原因", status: "open", round: id + "-d", proj: id, risk: "中", cat: "方向取舍", opt: [{ label: "做", effect: "a" }, { label: "不做", effect: "b" }], opened: ago(10) });
  });
  const f = path.join(dir, name + ".html");
  fs.writeFileSync(f, A.render({ version: 3, name, title: "排序测试", owner: "session-fm", updated: ago(1), projects: P.map(([id, title]) => ({ id, title, cwd: "C:/p/" + id })), rounds, decisions, notes: [] }));
  fs.writeFileSync(path.join(dir, "pages.json"), JSON.stringify({ ...A.readRegistry(), [name]: f }));
}

function serve(name, { failOrder = false } = {}) {
  const st = { orders: [] };
  const live = () => Object.fromEntries(A.pageData(name).rounds.map((r) => [r.sid, r.status === "doing" ? "running" : "idle"]));
  const server = createServer(async (req, res) => {
    const p = req.url.split("?")[0];
    const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (p === "/alignment/p/" + name) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(A.render(A.pageData(name))); }
    if (p === "/alignment/p/" + name + "/data") return json(200, { ...A.pageData(name), live: live() });
    if (p === "/alignment/p/" + name + "/order" && req.method === "POST") {
      let raw = ""; for await (const c of req) raw += c;
      st.orders.push(JSON.parse(raw).order);
      if (failOrder) return json(500, { ok: false, message: "disk full" });
      return json(200, { ok: true, data: { ...A.setProjOrder(name, JSON.parse(raw)).data, live: live() } });
    }
    if (p === "/alignment/health") return json(200, { ok: true, api: A.API_VERSION });
    if (p === "/alignment/todos") return json(200, { ok: true, api: 2, sessions: {}, activity: {} });
    if (p === "/alignment/fm") return json(200, { ok: true, page: name, fm: { sid: "session-fm", title: "first mate" }, refresh: null });
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, st, base: "http://127.0.0.1:" + server.address().port })));
}

async function open(t, name, opts = {}) {
  seed(name);
  const { server, st, base } = await serve(name, opts);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await getBrowser();
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1440, height: 900 }, hasTouch: !!opts.touch, isMobile: !!opts.touch, reducedMotion: opts.reduce ? "reduce" : "no-preference" });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base + "/alignment/p/" + name);
  await page.waitForSelector(".col.end h3.mv");
  return { page, st, errors };
}
const until = async (f, what) => { const end = Date.now() + 10_000; while (!f()) { if (Date.now() > end) assert.fail("等不到:" + what); await new Promise((r) => setTimeout(r, 20)); } };
const order = (page, col) => page.$$eval(".col." + col + " > .pcard[data-pid]", (els) => els.map((e) => e.dataset.pid));
const decOrder = (page) => page.$$eval(".lscroll .dg", (els) => els.map((e) => e.dataset.flip.split("|")[1]));

test("鼠标拖动:虚影 + 让开 + 放下存一次,其他栏和决定列表跟随,刷新后保持", { timeout: 90_000 }, async (t) => {
  const { page, st, errors } = await open(t, "od1");
  await page.click('[data-act="tab"][data-v="dec"]');
  assert.deepEqual(await order(page, "end"), ["pa", "pb", "pc", "pd"]);
  const before = { doing: await order(page, "doing"), done: await order(page, "done") };
  const h = await page.$('.col.end > .pcard[data-pid="pc"] h3.mv');
  await h.scrollIntoViewIfNeeded();
  const b = await h.boundingBox(), top = await (await page.$('.col.end > .pcard[data-pid="pa"] h3')).boundingBox();
  await page.mouse.move(b.x + 40, b.y + b.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(b.x + 40, b.y + b.height / 2 + ((top.y - b.y - 6) * i) / 12);
  await page.waitForFunction(() => [...document.querySelectorAll(".col.end > .pcard[data-pid]")].filter((c) => !c.classList.contains("ph") && /translateY\(\d/.test(c.style.transform)).length >= 2);
  const mid = await page.evaluate(() => ({
    ph: document.querySelectorAll(".col.end .pcard.ph").length,
    ghost: document.querySelectorAll(".pcard.pdrag").length,
    shifted: [...document.querySelectorAll(".col.end > .pcard[data-pid]")].filter((c) => !c.classList.contains("ph") && /translateY\(\d/.test(c.style.transform)).map((c) => c.dataset.pid),
  }));
  if (process.env.ALIGN_SHOTS) await page.screenshot({ path: path.join(process.env.ALIGN_SHOTS, "dragging.png") });
  assert.deepEqual([mid.ph, mid.ghost], [1, 1], "原位置一个虚影、一份跟手的副本");
  assert.deepEqual(mid.shifted, ["pa", "pb"], "经过的项目条往下让开");
  assert.equal(st.orders.length, 0, "拖动中不保存");
  await page.mouse.up();
  await until(() => st.orders.length === 1, "放下后保存");
  assert.deepEqual(st.orders, [["pc", "pa", "pb", "pd"]], "放下时保存一次");
  assert.deepEqual(await order(page, "end"), ["pc", "pa", "pb", "pd"]);
  assert.deepEqual(await order(page, "doing"), ["pc", "pa", "pb", "pd"], "进行中跟随");
  assert.deepEqual(await order(page, "done"), ["pc", "pa", "pb", "pd"], "待验收跟随");
  assert.deepEqual(await decOrder(page), ["pc", "pa", "pb", "pd"], "决定列表跟随");
  assert.notDeepEqual(before.doing, ["pc", "pa", "pb", "pd"], "进行中原来不是这个顺序(否则没测到跟随)");
  assert.equal(await page.$$eval(".pcard.ph, .pcard.pdrag", (x) => x.length), 0, "放下后虚影和副本都没了");
  if (process.env.ALIGN_SHOTS) await page.screenshot({ path: path.join(process.env.ALIGN_SHOTS, "dropped.png") });
  assert.deepEqual(A.pageData("od1").projOrder, ["pc", "pa", "pb", "pd"], "写进页面数据");
  await page.reload(); await page.waitForSelector(".col.end h3.mv");
  assert.deepEqual(await order(page, "end"), ["pc", "pa", "pb", "pd"], "刷新后保持");
  // Esc 取消:顺序不变,不保存
  const h2 = await (await page.$('.col.end > .pcard[data-pid="pd"] h3.mv')).boundingBox();
  await page.mouse.move(h2.x + 40, h2.y + 8); await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(h2.x + 40, h2.y + 8 - i * 40);
  await page.keyboard.press("Escape"); await page.mouse.up(); await page.waitForFunction(() => !document.querySelector(".pcard.pdrag"));
  assert.deepEqual(await order(page, "end"), ["pc", "pa", "pb", "pd"]);
  assert.equal(st.orders.length, 1, "取消不保存");
  assert.deepEqual(errors, []);
});

test("键盘 Alt+↑↓:焦点留在项目条上,连按只存一次;读屏播报位置", { timeout: 60_000 }, async (t) => {
  const { page, st, errors } = await open(t, "od2");
  await page.focus('.col.end > .pcard[data-pid="pd"] h3.mv');
  await page.keyboard.press("Alt+ArrowUp");
  await page.keyboard.press("Alt+ArrowUp");
  assert.equal(await page.evaluate(() => document.activeElement.closest(".pcard").dataset.pid), "pd", "焦点跟着项目条");
  await page.waitForTimeout(900);
  assert.deepEqual(st.orders, [["pa", "pd", "pb", "pc"]], "连按合成一次保存");
  assert.match(await page.textContent("#live-msg"), /notes-app 移到第 2 个/);
  assert.deepEqual(await order(page, "doing"), ["pa", "pd", "pb", "pc"]);
  // 轮询拿到新数据整块重画后,焦点还在同一个项目条上
  await A.main(["round", "set", "od2", "pa-d", "state=有新进展"]);
  await page.waitForResponse((r) => r.url().endsWith("/od2/data") && r.request().method() === "GET", { timeout: 15_000 }); // 等一次 4 s 轮询取到新数据
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); // 重画完
  assert.equal(await page.evaluate(() => document.activeElement.closest(".pcard")?.dataset.pid), "pd", "重画后焦点还在 notes-app 项目条上");
  assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement.querySelector(".kh")).display !== "none"), true, "聚焦时显示快捷键提示");
  await page.focus('.col.end > .pcard[data-pid="pa"] h3.mv');
  await page.keyboard.press("Alt+ArrowUp");
  await page.waitForTimeout(800);
  assert.match(await page.textContent("#live-msg"), /已经在最前/);
  assert.equal(st.orders.length, 1);
  assert.deepEqual(errors, []);
});

test("420 宽触屏:从把手拖动排序", { timeout: 60_000 }, async (t) => {
  const { page, st, errors } = await open(t, "od3", { viewport: { width: 420, height: 860 }, touch: true });
  const g = await page.$('.col.end > .pcard[data-pid="pb"] .grip');
  await g.scrollIntoViewIfNeeded();
  const b = await g.boundingBox(), cdp = await page.context().newCDPSession(page);
  const tp = (type, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: b.x + b.width / 2, y }] });
  // 拖到下一张卡(丙)的中线稍下:正好越过一格
  const y0 = b.y + b.height / 2, nb = await (await page.$('.col.end > .pcard[data-pid="pc"]')).boundingBox(), pb = await (await page.$('.col.end > .pcard[data-pid="pb"]')).boundingBox();
  const dy = nb.y + nb.height / 2 - (pb.y + pb.height / 2) + 6;
  await tp("touchStart", y0);
  for (let i = 1; i <= 10; i++) { await tp("touchMove", y0 + (dy * i) / 10); await page.waitForTimeout(16); }
  await tp("touchEnd", 0);
  await until(() => st.orders.length === 1, "触屏拖完保存");
  assert.deepEqual(st.orders, [["pa", "pc", "pb", "pd"]], "触屏拖一格");
  // 420 宽:项目名省略、数量完整在栏内
  const fit = await page.$$eval(".col.end h3.mv", (hs) => hs.map((h) => { const c = h.querySelector(".c").getBoundingClientRect(), r = h.closest(".pcard").getBoundingClientRect(); return { pid: h.closest(".pcard").dataset.pid, over: h.scrollWidth > h.clientWidth + 1, cut: c.right > r.right - 2 || c.width < 4 }; }));
  assert.deepEqual(fit.filter((x) => x.over || x.cut), [], "420 宽项目条不溢出、数量不被裁");
  // 项目名完整可见(换行,不省略)、色点在
  const names = await page.$$eval(".col.end h3.mv", (hs) => hs.map((h) => { const n = h.querySelector(".pn"); return { full: n.scrollWidth <= n.clientWidth + 1 && n.scrollHeight <= n.clientHeight + 1, dot: getComputedStyle(h.querySelector(".pdot")).display !== "none", tip: h.title.startsWith(n.textContent) }; }));
  assert.deepEqual(names.filter((x) => !x.full || !x.dot || !x.tip), [], "420 宽项目名完整、色点可见、悬停提示带项目名");
  // 没聚焦时数量靠右(和其他栏的项目条一致)
  const gap = await page.$eval(".col.end h3.mv", (h) => h.getBoundingClientRect().right - h.querySelector(".c").getBoundingClientRect().right);
  assert.ok(gap < 16, "数量靠右: " + gap);
  assert.deepEqual(errors, []);
});

test("保存失败:换回原来的顺序并提示;减少动态效果时也能排", { timeout: 60_000 }, async (t) => {
  const { page, st, errors } = await open(t, "od4", { failOrder: true, reduce: true });
  await page.focus('.col.end > .pcard[data-pid="pb"] h3.mv');
  await page.keyboard.press("Alt+ArrowUp");
  assert.deepEqual(await order(page, "end"), ["pb", "pa", "pc", "pd"], "先在页面上排好");
  await page.waitForSelector(".toast.err", { timeout: 3000 });
  assert.match(await page.textContent(".toast.err"), /项目顺序没存上/);
  assert.match(await page.textContent(".toast.err"), /disk full/);
  assert.deepEqual(await order(page, "end"), ["pa", "pb", "pc", "pd"], "换回原来的顺序");
  assert.equal(st.orders.length, 1);
  assert.equal(A.pageData("od4").projOrder, undefined);
  // 减少动态效果:换位不位移,移动过的项目只做透明度淡入
  await page.keyboard.press("Alt+ArrowDown");
  // 只看脚本发起的动画(CSS 过渡是页面原有的焦点 / 颜色变化,全局规则已压到 .01ms)
  const anims = await page.evaluate(() => document.getAnimations().filter((a) => !(a instanceof CSSTransition) && !(a instanceof CSSAnimation)).map((a) => Object.keys(a.effect.getKeyframes()[0]).filter((k) => !["offset", "easing", "composite", "computedOffset"].includes(k))));
  assert.ok(anims.length > 0, "减少动态效果时仍有淡入,看得出哪些动了");
  assert.ok(anims.every((ks) => ks.length === 1 && ks[0] === "opacity"), "减少动态效果:只有 opacity 动画 " + JSON.stringify(anims));
  assert.deepEqual(errors, []);
});
