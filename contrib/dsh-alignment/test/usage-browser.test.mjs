// 真浏览器：对齐页使用日志的前端（template.html 的 usageLog）——攒批（不是每个动作发一次）、空闲时发、页面关闭前 sendBeacon、
// 不记输入框文字，和服务端 /p/<页>/log 落盘接起来。页面、/data、/answer、/log 走真的 align.mjs createHandler；
// 依赖插件 devDependencies 里的 playwright-core（DSH_ALIGN_PW_DIR 覆盖），缺失即失败。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "align-usage-b-"));
process.env.ALIGN_STORE = dir;
process.env.ALIGN_WORKSPACES = path.join(dir, "workspace.json");
const A = await import("../cli/align.mjs");
const U = await import("../cli/usage.mjs");
const { chromium } = createRequire((process.env.DSH_ALIGN_PW_DIR ? path.join(process.env.DSH_ALIGN_PW_DIR, "package.json") : import.meta.url))("playwright-core");

const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
const name = "ub";
const file = path.join(dir, name + ".html");
fs.writeFileSync(file, A.render({ version: 3, name, title: "日志测试", owner: "session-fm", updated: ago(1), projects: [{ id: "pa", title: "dsh-core", cwd: "C:/p/pa" }],
  rounds: [{ id: "r1", sid: "session-w1", title: "等验收的一轮", status: "done", proj: "pa", started: ago(90), ended: ago(30), result: "交了" }],
  decisions: [{ id: "d1", title: "要不要做 X", why: "原因", status: "open", round: "r1", proj: "pa", risk: "中", cat: "方向取舍", rec: "做", opt: [{ label: "做", effect: "a" }, { label: "不做", effect: "b" }], opened: ago(10) }],
  notes: [] }));
fs.writeFileSync(path.join(dir, "pages.json"), JSON.stringify({ [name]: file }));
// 打开时的页面和数据(第一条用例会把 d1 发出去、改掉页面文件;只看页面发了什么的用例用这份,互不影响)
const html0 = fs.readFileSync(file), data0 = A.pageData(name);

const SECRET = "秘密内容XYZ";
const events = () => U.readUsage(A.USAGE_DIR, { page: name });
const raw = () => { try { return fs.readdirSync(A.USAGE_DIR).map((n) => fs.readFileSync(path.join(A.USAGE_DIR, n), "utf8")).join(""); } catch { return ""; } };
// 一个文件只起一个浏览器(2026-11-02 提速),每个用例自己的 context。页面装假时钟(时间照常走):
// 攒批的 10 秒、侧栏收起的 1.2 秒用 fastForward 跳过去,不真等。
let browserP = null;
after(async () => { if (browserP) await (await browserP).close(); });
async function newPage(viewport) {
  browserP ??= chromium.launch({ headless: true });
  const context = await (await browserP).newContext({ viewport });
  const page = await context.newPage();
  await page.clock.install();
  return { context, page };
}
async function until(f, ms, what) { const end = Date.now() + ms; while (Date.now() < end) { const v = f(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } assert.fail("等不到：" + what); }

test("攒批 + 空闲时发 + 关闭前 sendBeacon；记选项 / 改选 / 输入长度 / 分隔条 / 轮次按钮，不记输入文字", { timeout: 90_000 }, async (t) => {
  const st = { logs: [] };
  const handler = A.createHandler({ prefix: A.ROUTE_PREFIX, send: async () => {}, guard: () => null, live: async (sids) => Object.fromEntries(sids.map((s) => [s, "idle"])) });
  const server = createServer((req, res) => {
    const p = req.url.split("?")[0];
    const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (p.endsWith("/log")) st.logs.push({ at: Date.now(), type: req.headers["content-type"] });
    if (p === "/alignment/health") return json(200, { ok: true, api: A.API_VERSION });
    if (p === "/alignment/todos") return json(200, { ok: true, api: 2, sessions: {}, activity: {} });
    if (p === "/alignment/fm") return json(200, { ok: true, page: name, fm: { sid: "session-fm", title: "first mate" }, refresh: null });
    if (p === "/alignment/tools") return json(200, { ok: true, api: 1, rounds: {} });
    return handler(req, res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = "http://127.0.0.1:" + server.address().port;
  const { context, page } = await newPage({ width: 1440, height: 900 });
  t.after(() => context.close());
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  const t0 = Date.now();
  await page.goto(base + "/alignment/p/" + name);
  await page.waitForSelector(".sc[data-key]");
  // 轮次：泳道会话卡 → 「确认」→ 再点一次（取消）
  await page.click(".sc[data-key]");
  await page.click('[data-act="ract"][data-v="accept"]');
  await page.click('[data-act="ract"][data-v="accept"]');
  // 决定：切到「决定」页签 → 打开 d1 → 选「做」→ 改选「不做」→ 写补充（失焦）
  await page.click('[data-act="tab"][data-v="dec"]');
  await page.click('.dr[data-k="d:d1"]');
  await page.click('.opt[data-v="做"]');
  await page.click('.opt[data-v="不做"]');
  await page.click('[data-act="note"][data-id="d1"]');
  await page.fill('[data-in="note"][data-id="d1"]', SECRET);
  await page.click("#crumb", { position: { x: 5, y: 5 } });
  // 拖上下分隔条
  const hb = await page.locator("#hsplit").boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 - 40, { steps: 5 });
  await page.mouse.up();
  assert.ok(Date.now() - t0 < 9000, "动作要在第一次发送之前做完（10 秒攒批）");
  assert.equal(st.logs.length, 0, "攒着，没有每个动作发一次");
  // 有事件后约 10 秒趁空闲发一批:差一点到 10 秒还没发,到了就发。页面时钟跟着真实时间走,上面的动作在满载门禁里要好几秒:
  // 只跳到「从 t0 算起 9 秒」(第一个事件在 t0 之后,这是上界),仍不到 10 秒才断言没发(2026-11-03 满载门禁里动作超过 1 秒时误红)。
  // 精确的 10 秒边界由下面「攒批时长」用例用停住的时钟测
  const ff = Math.max(0, 9000 - (Date.now() - t0));
  await page.clock.fastForward(ff);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  if (Date.now() - t0 + ff < 9800) assert.equal(st.logs.length, 0, "不到 10 秒不发");
  await page.clock.fastForward(1000);
  await until(() => st.logs.length >= 1, 20000, "空闲时发的第一批");
  assert.equal(st.logs.length, 1, "一批发完");
  const first = events();
  const types = first.map((e) => e.type);
  for (const x of ["page.open", "board.pick", "detail.open", "round.act", "view.tab", "decide.pick", "decide.note", "input.write", "split.drag", "detail.leave"]) assert.ok(types.includes(x), x + " 在：" + types.join(","));
  assert.deepEqual(first.filter((e) => e.type === "round.act").map((e) => [e.id, e.v, e.change]), [["r1", "accept", "on"], ["r1", "accept", "off"]]);
  assert.deepEqual(first.filter((e) => e.type === "decide.pick").map((e) => [e.id, e.opt, e.rec, e.change]), [["d1", 1, true, "new"], ["d1", 2, false, "change"]]);
  const opens = first.filter((e) => e.type === "detail.open").map((e) => [e.k, e.id, e.from, e.proj, e.st]);
  assert.deepEqual(opens, [["r", "r1", "board", "pa", "done"], ["d", "d1", "click", "pa", "open"]]);
  assert.deepEqual(first.filter((e) => e.type === "input.write").map((e) => [e.field, e.id, e.len]), [["note", "d1", SECRET.length]]);
  assert.ok(first.every((e) => e.src === "local" && e.dev === "desktop" && e.w === "wide" && e.pid === first[0].pid));
  // 发送（经 fetch 包装）：发送照常成功，send.done 带每项的选项序号、是否推荐、补充长度（不带文字）
  await page.click('[data-act="send"]');
  await until(() => A.pageData(name).decisions.find((d) => d.id === "d1").status === "sent", 10000, "决定发出去了（页面数据 d1 变 sent）");
  // 切到后台（visibilitychange → hidden）：sendBeacon 发剩下的
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
  await until(() => events().some((e) => e.type === "page.hide"), 10000, "切到后台时 sendBeacon 发的 page.hide");
  assert.equal(st.logs.length, 2);
  assert.ok(events().some((e) => e.type === "send.click" && e.n === 1));
  await page.evaluate(() => { delete document.hidden; delete document.visibilityState; document.dispatchEvent(new Event("visibilitychange")); });
  // 关页面（换到 about:blank）：pagehide → sendBeacon 发剩下的
  await page.click('[data-act="tab"][data-v="sess"]');
  await page.goto("about:blank");
  await until(() => events().some((e) => e.type === "page.close"), 10000, "sendBeacon 发的 page.close");
  assert.equal(st.logs.length, 3);
  assert.equal(st.logs[2].type, "application/json");
  const all = events();
  assert.ok(all.some((e) => e.type === "page.show"));
  // send.done 在页面收到回复后才记（可能晚于上面切到后台那次 sendBeacon），关页面时一起发出
  const sd = all.find((e) => e.type === "send.done");
  assert.ok(sd && sd.ok && sd.status === 200 && sd.ms >= 0, JSON.stringify(sd));
  assert.deepEqual(sd.items, [{ k: "d", id: "d1", choice: true, opt: 2, rec: false, len: SECRET.length }]);
  assert.ok(all.find((e) => e.type === "page.close").dur > 0);
  assert.ok(all.some((e) => e.type === "view.tab" && e.v === "sess"));
  assert.doesNotMatch(raw(), /秘密|XYZ/, "输入框的文字不落盘");
  assert.deepEqual(errors, []);
});

/** 只记 /log 请求体的假服务端(页面、/data 用打开时的那份):看的是页面发了什么,不是服务端 cleanBatch 筛完落盘的。 */
async function logServer(t) {
  const st = { bodies: [] };
  const server = createServer((req, res) => {
    const p = req.url.split("?")[0];
    const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (p === "/alignment/p/" + name) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(html0); }
    if (p === "/alignment/p/" + name + "/data") return json(200, { ...data0, live: { "session-w1": "idle" } });
    if (p === "/alignment/p/" + name + "/log") { let raw = ""; req.on("data", (c) => { raw += c; }); return req.on("end", () => { st.bodies.push(raw); res.writeHead(204); res.end(); }); }
    if (p === "/alignment/health") return json(200, { ok: true, api: A.API_VERSION });
    if (p === "/alignment/todos") return json(200, { ok: true, api: 2, sessions: {}, activity: {} });
    if (p === "/alignment/fm") return json(200, { ok: true, page: name, fm: null, refresh: null });
    if (p === "/alignment/tools") return json(200, { ok: true, api: 1, rounds: {} });
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { st, base: "http://127.0.0.1:" + server.address().port };
}

test("攒批时长:有事件后 10 秒内不发(页面里一次 /log 都没调),到 10 秒后趁空闲发出一批", { timeout: 60_000 }, async (t) => {
  // 上一条用 fastForward 跳过攒批后只立刻看服务端,/log 还在路上也算「没发」,IDLE_MS 改短仍绿。
  // 这里在页面脚本之前包一层 fetch(usageLog 的 rawFetch 就是它),发 /log 的那一刻同步计数;时钟停住后用 runFor 精确推进。
  const { base } = await logServer(t);
  const { context, page } = await newPage({ width: 1440, height: 900 });
  t.after(() => context.close());
  await page.addInitScript(() => { window.__logN = 0; const f = window.fetch; window.fetch = function (u, init) { if (init && init.method === "POST" && /\/log$/.test(String(u))) window.__logN++; return f.apply(this, arguments); }; });
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base + "/alignment/p/" + name);
  await page.waitForSelector(".sc[data-key]");
  // 先把打开页面时的事件发掉(队列空了、没有攒批计时器)
  await page.clock.fastForward(11_000);
  await page.waitForFunction(() => window.__logN === 1, null, { timeout: 20_000 });
  // 时钟停住,一个点击(view.tab)开始新的一批
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000);
  await page.evaluate(() => document.querySelector('[data-act="tab"][data-v="dec"]').click());
  await page.clock.runFor(9_900);
  assert.equal(await page.evaluate(() => window.__logN), 1, "事件后 9.9 秒还在攒,没发 /log");
  await page.clock.runFor(200); // 10 秒到了 + requestIdleCallback(假时钟下≤ 50 ms)
  assert.equal(await page.evaluate(() => window.__logN), 2, "到 10 秒后发出一批");
  assert.deepEqual(errors, []);
});

test("日志里不写输入框里的文字:所有发往 /log 的请求体都不含打进去的字,只有字数", { timeout: 60_000 }, async (t) => {
  // 上一条只查落盘文件;服务端 cleanBatch 会丢掉不认识的字段,页面把原文放进新字段发出去也绿。这里查页面发出的请求体。
  const { st, base } = await logServer(t);
  const { context, page } = await newPage({ width: 1440, height: 900 });
  t.after(() => context.close());
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  const secret = "zq" + Math.random().toString(36).slice(2, 12) + "密文";
  await page.goto(base + "/alignment/p/" + name);
  await page.waitForSelector(".sc[data-key]");
  await page.click('[data-act="tab"][data-v="dec"]');
  await page.click('.dr[data-k="d:d1"]');
  await page.click('[data-act="note"][data-id="d1"]');
  await page.fill('[data-in="note"][data-id="d1"]', secret);
  await page.click("#crumb", { position: { x: 5, y: 5 } }); // 失焦 → change → input.write
  await page.clock.fastForward(11_000);
  await until(() => st.bodies.length >= 1, 20000, "空闲时发的一批");
  await page.goto("about:blank"); // 关页面:sendBeacon 发剩下的
  await until(() => st.bodies.some((b) => b.includes('"page.close"')), 10000, "sendBeacon 发的 page.close");
  const evs = st.bodies.flatMap((b) => JSON.parse(b).events);
  assert.deepEqual(evs.filter((e) => e.type === "input.write").map((e) => [e.field, e.id, e.len]), [["note", "d1", secret.length]], "这次输入记了 input.write(否则测不到)");
  for (const b of st.bodies) assert.ok(!b.includes(secret) && !b.includes(secret.slice(2, 12)), "/log 请求体里有输入框的文字: " + b.slice(0, 300));
  assert.deepEqual(errors, []);
});

test("旧服务端没有 /log（404）：第一次发送失败后这一页不再记、不再发", { timeout: 60_000 }, async (t) => {
  const st = { logs: 0 };
  const server = createServer((req, res) => {
    const p = req.url.split("?")[0];
    const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (p === "/alignment/p/" + name) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(fs.readFileSync(file)); }
    if (p === "/alignment/p/" + name + "/data") return json(200, { ...A.pageData(name), live: { "session-w1": "idle" } });
    if (p === "/alignment/health") return json(200, { ok: true, api: 10 });
    if (p === "/alignment/todos") return json(200, { ok: true, api: 2, sessions: {}, activity: {} });
    if (p === "/alignment/fm") return json(200, { ok: true, page: name, fm: null, refresh: null });
    if (p.endsWith("/log")) st.logs++;
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { context, page } = await newPage({ width: 1440, height: 900 });
  t.after(() => context.close());
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("http://127.0.0.1:" + server.address().port + "/alignment/p/" + name);
  await page.waitForSelector(".sc[data-key]");
  await page.click('[data-act="tab"][data-v="dec"]');
  await page.clock.fastForward(10_000);
  await until(() => st.logs >= 1, 20000, "第一次发送");
  await page.waitForTimeout(300);
  await page.click('[data-act="tab"][data-v="sess"]');
  await page.goto("about:blank");
  await page.waitForTimeout(1500);
  assert.equal(st.logs, 1, "404 之后不再发（关页面也不 sendBeacon）");
  assert.deepEqual(errors, []);
});

test("在 DSH 侧栏里：侧栏插件发 visible:false / true，页面记 page.hide / page.show（kind=sidebar），收起期间不算可见；别的来源的消息不认", { timeout: 60_000 }, async (t) => {
  const handler = A.createHandler({ prefix: A.ROUTE_PREFIX, send: async () => {}, guard: () => null, live: async (sids) => Object.fromEntries(sids.map((s) => [s, "idle"])) });
  const server = createServer((req, res) => {
    const p = req.url.split("?")[0];
    const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (p === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<!doctype html><body style=margin:0><iframe id=f src='/alignment/p/" + name + "?embed=1' style='width:1200px;height:860px;border:0'></iframe></body>"); }
    if (p === "/alignment/health") return json(200, { ok: true, api: A.API_VERSION });
    if (p === "/alignment/todos") return json(200, { ok: true, api: 2, sessions: {}, activity: {} });
    if (p === "/alignment/fm") return json(200, { ok: true, page: name, fm: null, refresh: null });
    if (p === "/alignment/tools") return json(200, { ok: true, api: 1, rounds: {} });
    return handler(req, res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { context, page } = await newPage({ width: 1240, height: 900 });
  t.after(() => context.close());
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("http://127.0.0.1:" + server.address().port + "/");
  const fr = await (await page.waitForSelector("#f")).contentFrame();
  await fr.waitForSelector(".sc[data-key]");
  const mine = (x) => x.pid === pid;
  let pid;
  await page.waitForTimeout(500);
  // 不是父页面发的（iframe 自己发给自己）：不认
  await fr.evaluate(() => window.postMessage({ type: "dsh-alignment/visible", visible: false }, location.origin));
  await page.waitForTimeout(300);
  // 侧栏收起 → 1.2 秒后展开
  await page.evaluate(() => document.getElementById("f").contentWindow.postMessage({ type: "dsh-alignment/visible", visible: false }, location.origin));
  await until(() => { const e = events().find((x) => x.type === "page.hide" && x.kind === "sidebar"); if (e) pid = e.pid; return e; }, 10000, "侧栏收起时 sendBeacon 发的 page.hide");
  await page.clock.fastForward(1200);
  await page.evaluate(() => document.getElementById("f").contentWindow.postMessage({ type: "dsh-alignment/visible", visible: true }, location.origin));
  await page.waitForTimeout(300);
  await page.goto("about:blank");
  await until(() => events().some((e) => mine(e) && e.type === "page.close"), 10000, "page.close");
  const ev = events().filter(mine);
  const types = ev.map((e) => e.type + (e.kind ? ":" + e.kind : ""));
  assert.deepEqual(types.filter((x) => /^page\./.test(x)), ["page.open", "page.hide:sidebar", "page.show:sidebar", "page.close"], types.join(","));
  assert.equal(ev.filter((e) => e.type === "page.hide").length, 1, "自己发给自己的消息没算");
  const close = ev.find((e) => e.type === "page.close"), show = ev.find((e) => e.type === "page.show");
  assert.ok(close.dur < close.t - show.t + 200, "关闭时的可见时长从展开那一刻算，不含收起的 1.2 秒");
  assert.ok(ev.every((e) => e.embed === 1));
  assert.deepEqual(errors, []);
});
