// 真浏览器回归(2026-10-24):对齐页「发送」成功后的盖章(stamp-fx v2)。
// 1. 列表行和详情标题盖上印迹;不减少动态时有一只看得见的章头落下,盖完自己移除。
// 2. 系统「减少动态」时没有章头、没有位移,印迹照样出现。
// 3. 顶栏喇叭按钮开关盖章声音,默认关,存本机,刷新后保持。
// 4. 别处(手机、别的浏览器)发出的决定:本机没有发送记录,按服务端 status / answered 直接显示盖好的章,不放动效、不出声,回执不重复章上的内容。
// 页面由 align.mjs render() 生成,本地 http 服务按 /alignment/p/<页> 的形状给页面、/data、/answer,页面放在同源 iframe 里。
// 依赖插件 devDependencies 里的 playwright-core（DSH_ALIGN_PW_DIR 覆盖）,缺失即失败。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "align-stamp-"));
process.env.ALIGN_STORE = dir;
process.env.ALIGN_WORKSPACES = path.join(dir, "workspace.json");
const A = await import("../cli/align.mjs");
const { chromium } = createRequire((process.env.DSH_ALIGN_PW_DIR ? path.join(process.env.DSH_ALIGN_PW_DIR, "package.json") : import.meta.url))("playwright-core");
// 一个文件只起一个 Chromium,各用例自己开 context(隔离不变)
let browserP;
const getBrowser = () => (browserP ??= chromium.launch({ headless: true }));
test.after(async () => { if (browserP) await (await browserP.catch(() => null))?.close(); });

const NOW = new Date().toISOString();
const dec = { id: "d1", title: "要不要做 X", why: "原因", status: "open", opt: [{ label: "做", effect: "a" }, { label: "不做", effect: "b" }], asked: NOW };
const data = { version: 3, name: "st", title: "盖章测试页", owner: "session-fm", updated: NOW, projects: [], rounds: [], decisions: [dec], notes: [] };
const html = A.render(data);

function serve(init = data) {
  const st = { answers: [] };
  let cur = init;
  const html = A.render(init);
  const server = createServer((req, res) => {
    const p = req.url.split("?")[0];
    const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (p === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<!doctype html><body style=margin:0><iframe id=f src='/alignment/p/st?embed=1&theme=light' style='width:1100px;height:760px;border:0'></iframe></body>"); }
    if (p === "/alignment/p/st") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(html); }
    if (p === "/alignment/p/st/data") return json(200, { ...cur, live: {} });
    if (p === "/alignment/p/st/answer") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        st.answers.push(JSON.parse(body));
        cur = { ...data, updated: new Date().toISOString(), decisions: [{ ...dec, status: "sent", choice: "做", answered: new Date().toISOString() }] };
        json(200, { ok: true, data: cur });
      });
      return;
    }
    if (p === "/alignment/health") return json(200, { ok: true, api: A.API_VERSION });
    if (p === "/alignment/todos") return json(200, { ok: true, api: 2, todos: {}, activity: {} });
    if (p === "/alignment/fm") return json(200, { ok: true, page: "st", fm: { sid: "session-fm", title: "first mate" }, refresh: null });
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, st, base: "http://127.0.0.1:" + server.address().port })));
}

async function open(t, reducedMotion, init, hash = "", ready = '.opt[data-v="做"]') {
  const { server, st, base } = await serve(init);
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await getBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 }, reducedMotion: reducedMotion ? "reduce" : "no-preference", timezoneId: "Asia/Shanghai" });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base + "/");
  const fr = page.frames().find((f) => f.url().includes("/alignment/p/st"));
  assert.ok(fr, "alignment frame");
  if (hash) await fr.evaluate((h) => { location.hash = h; }, hash);
  await fr.waitForSelector(ready);
  return { page, fr, st, errors };
}

async function sendAndWatch(fr, reduced = false) {
  await fr.evaluate(() => {
    window.__hand = 0;
    new MutationObserver(() => { if (document.querySelector(".stampfx-hand")) window.__hand += 1; }).observe(document.body, { childList: true, subtree: true });
  });
  await fr.click('.opt[data-v="做"]');
  await fr.click(".send");
  await fr.waitForSelector('.dr[data-k="d:d1"] .stp .stampfx-mark', { state: "attached", timeout: 10_000 });
  await fr.waitForSelector(".dstp .stampfx-mark", { state: "attached", timeout: 10_000 });
  // 等章盖完:两处墨迹都干了、章头已撤(有动效时还要先见过章头)
  await fr.waitForFunction((reduced) => (reduced || window.__hand > 0) && !document.querySelector(".stampfx-hand") && ['.dr[data-k="d:d1"] .stp .stampfx-mark', ".dstp .stampfx-mark"].every((s) => (m => m._stampfx.dryness > 0.97 && getComputedStyle(m).opacity === "1")(document.querySelector(s))), reduced, { timeout: 15_000 });
  return fr.evaluate(() => ({
    hand: window.__hand,
    handLeft: document.querySelectorAll(".stampfx-hand").length,
    row: document.querySelector('.dr[data-k="d:d1"] .stp .stampfx-mark').getAttribute("aria-label"),
    rowOpacity: getComputedStyle(document.querySelector('.dr[data-k="d:d1"] .stp .stampfx-mark')).opacity,
    title: document.querySelector(".dstp .stampfx-mark").getAttribute("aria-label"),
    stored: JSON.parse(localStorage.getItem("align-stamps:st")),
  }));
}

test("发送成功:列表行盖「已发送」、详情标题盖选项名;章头落下后自己移除", { timeout: 60_000 }, async (t) => {
  const { fr, st, errors } = await open(t, false);
  const r = await sendAndWatch(fr);
  assert.equal(st.answers.length, 1);
  assert.equal(r.row, "已发送");
  assert.match(r.title, /^做 \d\d\.\d\d \d\d:\d\d$/, "选项名 + 盖章时间");
  assert.equal(r.rowOpacity, "1");
  assert.ok(r.hand > 0, "盖章时出现过章头");
  assert.equal(r.handLeft, 0, "章头盖完移除");
  assert.equal(r.stored, null, "章按服务端状态画,本机不再存章");
  assert.deepEqual(errors, []);
});

test("减少动态:没有章头,印迹照样出现", { timeout: 60_000 }, async (t) => {
  const { fr, errors } = await open(t, true);
  const r = await sendAndWatch(fr, true);
  assert.equal(r.hand, 0, "减少动态时不出现章头");
  assert.equal(r.row, "已发送");
  assert.equal(r.rowOpacity, "1");
  assert.deepEqual(errors, []);
});

test("盖章声音:默认关,顶栏按钮打开后存本机,刷新后仍是开", { timeout: 60_000 }, async (t) => {
  const { page, fr, errors } = await open(t, false);
  const btn = '[data-act="stamp-sound"]';
  assert.equal(await fr.getAttribute(btn, "aria-pressed"), "false");
  await fr.click(btn);
  assert.equal(await fr.getAttribute(btn, "aria-pressed"), "true");
  assert.equal(await fr.evaluate(() => localStorage.getItem("align-stamp-sound")), "true");
  await page.reload();
  const fr2 = page.frames().find((f) => f.url().includes("/alignment/p/st"));
  await fr2.waitForSelector(btn);
  assert.equal(await fr2.getAttribute(btn, "aria-pressed"), "true");
  assert.match(await fr2.getAttribute(btn, "title"), /开/);
  assert.deepEqual(errors, []);
});

test("一次发送一个决定:只响一声;列表行和详情标题两处章同一帧落下、同一帧撤开、墨迹同进度变干", { timeout: 60_000 }, async (t) => {
  const { page, fr, errors } = await open(t, false);
  page.setDefaultTimeout(5000);
  await fr.evaluate(() => { localStorage.setItem("align-stamp-sound", "true"); });
  await page.reload();
  const f = page.frames().find((x) => x.url().includes("/alignment/p/st"));
  await f.waitForSelector('.opt[data-v="做"]');
  await f.evaluate(() => {
    // 数真正排进 Web Audio 的声音(不经组件的接口,绕不过去);逐帧记两处章的可见和墨色
    window.__snd = 0;
    const st = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...a) { window.__snd += 1; return st.apply(this, a); };
    window.__log = [];
    const mean = (m) => m._stampfx.dryness;
    const tick = (ts) => {
      const row = document.querySelector('.dr .stp .stampfx-mark'), dt = document.querySelector(".dstp .stampfx-mark");
      const see = (m) => !!m && +getComputedStyle(m).opacity > 0;
      window.__log.push({ ts, row: see(row), dt: see(dt), rowInk: see(row) ? mean(row) : null, dtInk: see(dt) ? mean(dt) : null, hands: document.querySelectorAll(".stampfx-hand").length });
      if (window.__log.length < 240) requestAnimationFrame(tick);
    };
    window.__go = () => requestAnimationFrame(tick);
  });
  await f.click('.opt[data-v="做"]');
  await f.evaluate(() => __go());
  await f.click(".send");
  await f.waitForFunction(() => window.__log.length >= 240, null, { timeout: 15_000 });
  const r = await f.evaluate(() => ({ snd: window.__snd, log: window.__log }));
  assert.equal(r.snd, 1, "一次发送只响一声");
  const firstRow = r.log.findIndex((x) => x.row), firstDt = r.log.findIndex((x) => x.dt);
  assert.ok(firstRow > 0 && firstDt > 0, "两处都盖上了");
  assert.ok(Math.abs(firstRow - firstDt) <= 1, "两处落下相差一帧以内(行 " + firstRow + " / 标题 " + firstDt + ")");
  assert.ok(r.log.some((x) => x.hands === 2), "两处各有一只章头,同时在场");
  const lastHand = (k) => r.log.map((x) => x.hands).lastIndexOf(k);
  assert.ok(lastHand(2) >= 0 && lastHand(1) - lastHand(2) <= 1, "两只章头同时撤开");
  // 墨迹变干:两处每一帧画出来的干燥度(0 湿 .. 1 干)一致,而且是连续变化的
  let worst = 0, steps = 0;
  for (const x of r.log) if (x.rowInk !== null && x.dtInk !== null) { worst = Math.max(worst, Math.abs(x.rowInk - x.dtInk)); }
  const dv = r.log.map((x) => x.rowInk).filter((x) => x !== null);
  for (let i = 1; i < dv.length; i++) if (dv[i] !== dv[i - 1]) steps += 1;
  assert.ok(worst < 0.03, "两处墨迹变干进度一致(最大差 " + worst.toFixed(3) + ")");
  assert.ok(dv[0] < 0.05 && dv[dv.length - 1] > 0.97, "从湿到干");
  assert.ok(steps > 60, "逐帧连续变干,不是几档(变化帧数 " + steps + ")");
  assert.deepEqual(errors, []);
});

test("连续盖到一半又盖一轮:上一轮的章头立刻收掉、排好的声音停掉,同一时刻只有一轮在动", { timeout: 60_000 }, async (t) => {
  const { page, fr, errors } = await open(t, false);
  page.setDefaultTimeout(5000);
  const r = await fr.evaluate(async () => {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:0;top:0;width:400px";
    document.body.appendChild(host);
    const slots = [];
    for (let i = 0; i < 6; i++) { const d = document.createElement("div"); d.style.cssText = "position:relative;height:40px"; host.appendChild(d); slots.push(d); }
    const stopped = [], started = [];
    const st = AudioBufferSourceNode.prototype.start, sp = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.start = function (...a) { started.push(this); return st.apply(this, a); };
    AudioBufferSourceNode.prototype.stop = function (...a) { stopped.push(this); return sp.apply(this, a); };
    const items = () => slots.map((s) => ({ target: s }));
    StampFx.sequence(items(), { text: "已发送", size: 17, sound: true });
    await new Promise((res) => setTimeout(res, 400));
    const firstRun = started.slice();
    StampFx.sequence(items(), { text: "已发送", size: 17, sound: true });
    const heads = document.querySelectorAll(".stampfx-hand").length;
    return { heads, firstQueued: firstRun.length, firstStopped: firstRun.filter((x) => stopped.includes(x)).length };
  });
  assert.equal(r.heads, 1, "只剩新一轮的章头");
  assert.equal(r.firstQueued, 6);
  assert.equal(r.firstStopped, 6, "上一轮排好的声音全部停掉");
  assert.deepEqual(errors, []);
});

test("别处发出的决定:本机没有发送记录,也按服务端状态盖好章(行「已发送」、标题选项名 + 答复时间、会话卡按 ask);不放动效、不出声;回执不重复章", { timeout: 60_000 }, async (t) => {
  const at = "2026-10-26T03:04:00+08:00";
  const remote = {
    ...data,
    rounds: [{ id: "k1", sid: "session-k1", title: "做完了等验收", status: "done", started: NOW, ended: NOW, updated: NOW, result: "做完了", ask: "accept", asked: at }],
    decisions: [
      { ...dec, status: "sent", choice: "做", answered: at, updated: at, sid: "session-k1", round: "k1" },
      { ...dec, id: "d2", title: "只回了一句", opt: [], status: "sent", choice: "", reply: "先放着", answered: at, updated: at },
      { ...dec, id: "d3", title: "超时按推荐", status: "sent", choice: "做", auto: "timeout", autoAt: at, answered: at, updated: at },
    ],
  };
  const { page, fr } = await open(t, false, remote, "d=d1", ".dstp .stampfx-mark");
  page.setDefaultTimeout(5000);
  // 打开声音再刷新:刷新后才看到的章不放动效、不出声
  await fr.evaluate(() => { localStorage.setItem("align-stamp-sound", "true"); });
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    if (!location.pathname.includes("/alignment/p/st")) return;
    window.__snd = 0; window.__hand = 0;
    const st = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...a) { window.__snd += 1; return st.apply(this, a); };
    new MutationObserver(() => { if (document.querySelector(".stampfx-hand")) window.__hand += 1; }).observe(document, { childList: true, subtree: true });
  });
  await page.reload();
  const f = page.frames().find((x) => x.url().includes("/alignment/p/st"));
  await f.evaluate(() => { location.hash = "d=d1"; });
  await f.click('[data-act="df"][data-v="sent"]');
  await f.waitForSelector('.dr[data-k="d:d1"] .stp .stampfx-mark', { state: "attached" });
  await f.waitForSelector(".dstp .stampfx-mark", { state: "attached" });
  const r1 = await f.evaluate(() => ({
    row: document.querySelector('.dr[data-k="d:d1"] .stp .stampfx-mark').getAttribute("aria-label"),
    title: document.querySelector(".dstp .stampfx-mark").getAttribute("aria-label"),
    autoRow: !!document.querySelector('.dr[data-k="d:d3"] .stp'),
    rcpt: [...document.querySelectorAll(".rcpt")].map((e) => e.textContent),
    stored: localStorage.getItem("align-stamps:st"),
  }));
  assert.equal(r1.row, "已发送");
  assert.equal(r1.title, "做 10.26 03:04", "选项名 + 服务端答复时间");
  assert.equal(r1.autoRow, false, "超时按推荐处理的不是人答的,不盖章");
  assert.deepEqual(r1.rcpt, [], "只选了选项:章已写明,不再出回执");
  assert.equal(r1.stored, null, "本机不存章");
  // 只回了文字的:标题盖「已回复」,回执只留原文
  await f.evaluate(() => { location.hash = "d=d2"; });
  await f.waitForFunction(() => document.querySelector(".rbody>.dh h1")?.textContent === "只回了一句");
  await f.waitForSelector(".dstp .stampfx-mark", { state: "attached" });
  const r2 = await f.evaluate(() => ({ title: document.querySelector(".dstp .stampfx-mark").getAttribute("aria-label"), rcpt: [...document.querySelectorAll(".rcpt")].map((e) => e.textContent) }));
  assert.equal(r2.title, "已回复 10.26 03:04");
  assert.deepEqual(r2.rcpt, ["你回复了：先放着"]);
  // 会话卡:按 ask 盖「已确认」
  await f.waitForSelector(".sc .stampfx-mark", { state: "attached" });
  assert.equal(await f.getAttribute(".sc .stampfx-mark", "aria-label"), "已确认", "会话卡的章不带日期(卡上已有时间)");
  const r3 = await f.evaluate(() => ({ snd: window.__snd, hand: window.__hand }));
  assert.equal(r3.hand, 0, "别处发出的不放章头动效");
  assert.equal(r3.snd, 0, "别处发出的不出声");
  assert.deepEqual(errors, []);
});
