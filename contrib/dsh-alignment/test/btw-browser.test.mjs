// 真浏览器（2026-10-27）：对齐页「顺便问」。轮次详情里一节（问答 + 「顺便问一句」）→ 进发送队列 → 发给 First Mate（消息末尾是 btw forward 命令）；
// 会话写回答案（btw answer）后决定栏出一张答案卡：不计入「决定」数字、没有风险标和截止；「了解」只写文件、卡消掉；「继续追问」写一句再发。
// 小卡和时间线上的气泡：有新回答时蓝、不带数字。宽 640（DSH 右侧栏）和 390（手机）各截一张（ALIGN_BTW_SHOTS=<目录> 时存下来）。
// 页面由 align.mjs render() 生成，本地 http 服务给页面和 /data；依赖插件 devDependencies 里的 playwright-core（DSH_ALIGN_PW_DIR 覆盖），缺失即失败。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "align-btw-"));
process.env.ALIGN_STORE = dir;
process.env.ALIGN_WORKSPACES = path.join(dir, "workspace.json");
const A = await import("../cli/align.mjs");
const { chromium } = createRequire((process.env.DSH_ALIGN_PW_DIR ? path.join(process.env.DSH_ALIGN_PW_DIR, "package.json") : import.meta.url))("playwright-core");
// 一个文件只起一个 Chromium,各用例自己开 context(隔离不变)
let browserP;
const getBrowser = () => (browserP ??= chromium.launch({ headless: true }));
test.after(async () => { if (browserP) await (await browserP.catch(() => null))?.close(); });

const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
const name = "bw";
const file = path.join(dir, name + ".html");
const SID = (n) => "session-0000000" + n + "-0000-4000-8000-000000000000";
fs.writeFileSync(file, A.render({ version: 3, name, title: "顺便问测试", owner: SID(9), updated: ago(1), projects: [{ id: "pa", title: "highschool", cwd: "C:/p/pa" }],
  rounds: [
    { id: "r1", sid: SID(1), title: "旁白按游戏上下文说话", stitle: "highschool 旁白：按游戏上下文说话", status: "doing", proj: "pa", started: ago(60), eta: "1h", eta75: "2h", etaconf: "中",
      state: "A/B 两组在跑；A 组跑完 6/10。", why: "用户提的优化。" },
    { id: "r2", sid: SID(2), title: "手机 App 跟上上游", status: "doing", proj: "pa", started: ago(30), eta: "40m", eta75: "1h", etaconf: "中" }],
  decisions: [{ id: "d1", title: "换不换语音模型", why: "两个模型延迟差一倍。所以来问。", status: "open", round: "r2", proj: "pa", risk: "中", cat: "方向取舍", opened: ago(10), due: new Date(Date.now() + 7 * 36e5).toISOString(),
    opt: [{ label: "换", effect: "快一倍" }, { label: "不换", effect: "不动" }] }],
  notes: [],
  btw: [
    { id: "b-old", round: "r1", src: "web", q: "这一轮还用 27B LoRA 吗？", asked: ago(50), status: "answered", a: "还用。这一轮只改上下文，不换模型。", answered: ago(45), seen: ago(40) },
    { id: "b-wait", round: "r1", src: "chat", q: "A/B 两组的首句延迟差多少？", asked: ago(20), status: "open", when: "等 A/B 跑完", fwd: ago(19) }] }));
fs.writeFileSync(path.join(dir, "pages.json"), JSON.stringify({ [name]: file }));

test("交了结果的轮次还有没答的顺便问：小卡、时间线、详情页头都写出来；在做的和都答完的不写", { timeout: 60_000 }, async (t) => {
  const page2 = "bw2", file2 = path.join(dir, page2 + ".html");
  // 结束时间写成「今天」的某个时刻:时间线只对今天写 HH:MM,跨天写 M/D HH:MM;午夜后两小时内跑,ago(120) 落到昨天,
  // 更长的时间文字把窄卡上的「2 条没答」挤掉(2026-11-16 01:3x 门禁实例)。取今天 00:00 之后、此刻之前的中点,不早于午夜。
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  const sameDayAgo = (m) => new Date(Math.max(Date.now() - m * 60000, (today0.getTime() + Date.now()) / 2)).toISOString();
  const round = (id, title, status, extra = {}) => ({ id, sid: SID(id.slice(1)), title, status, proj: "pa", started: sameDayAgo(300), ended: sameDayAgo(120), result: "已合入。", ...extra });
  fs.writeFileSync(file2, A.render({ version: 3, name: page2, title: "顺便问测试", owner: SID(9), updated: ago(1), projects: [{ id: "pa", title: "highschool", cwd: "C:/p/pa" }],
    rounds: [
      round("r1", "对照截图核对镜头内上下文，把画面描述改成从中心往边缘详略递减", "done"),
      round("r2", "交了结果、都答完了", "done"),
      round("r3", "还在做", "doing", { ended: undefined, result: undefined, state: "在跑" }),
      round("r4", "已通过，后面还有一轮", "accepted"), round("r5", "接着做", "doing", { prev: "r4", ended: undefined, result: undefined, state: "在跑" })],
    decisions: [], notes: [],
    btw: [
      { id: "b-1", round: "r1", src: "web", q: "剩下的 5.8 和 12.8 是什么原因？", asked: ago(10), status: "open", fwd: ago(8) },
      { id: "b-2", round: "r1", src: "web", q: "有处理方案吗？", asked: ago(9), status: "open" },
      { id: "b-3", round: "r1", src: "web", q: "已经答的", asked: ago(50), status: "answered", a: "答了。", answered: ago(45), seen: ago(40) },
      { id: "b-4", round: "r2", src: "web", q: "已经答的", asked: ago(50), status: "answered", a: "答了。", answered: ago(45), seen: ago(40) },
      { id: "b-5", round: "r3", src: "web", q: "在做的那一轮等答", asked: ago(5), status: "open" },
      { id: "b-6", round: "r4", src: "web", q: "通过了还没答", asked: ago(5), status: "open" }] }));
  fs.writeFileSync(path.join(dir, "pages.json"), JSON.stringify({ [name]: file, [page2]: file2 }));
  const handler = A.createHandler({ prefix: A.ROUTE_PREFIX, send: async () => {}, guard: () => null, live: async (sids) => Object.fromEntries(sids.map((s) => [s, "idle"])) });
  const server = createServer((req, res) => {
    const p = req.url.split("?")[0], json = (body) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (p.endsWith("/log")) return json({ ok: true });
    if (p === "/alignment/health") return json({ ok: true, api: A.API_VERSION });
    if (p === "/alignment/todos") return json({ ok: true, api: 2, sessions: {}, activity: {} });
    if (p === "/alignment/fm") return json({ ok: true, page: page2, fm: { sid: SID(9), title: "first mate" }, refresh: null });
    if (p === "/alignment/tools") return json({ ok: true, api: 1, rounds: {} });
    return handler(req, res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await getBrowser();
  const ctx = await browser.newContext({ viewport: { width: 640, height: 900 }, deviceScaleFactor: 2 });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  page.setDefaultTimeout(5000);
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  const url = "http://127.0.0.1:" + server.address().port + "/alignment/p/" + page2;
  const open = async (hash) => {
    await page.goto("about:blank");
    await page.goto(url + hash);
    await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
    await page.waitForSelector(".dh h1");
  };
  await open("#r=r1");
  const mark = (rid) => page.$eval('.sc[data-rid="' + rid + '"] .sc-t', (e) => { const b = e.querySelector(".bw"), n = e.closest(".sc").querySelector(".bwn"); return b ? { wait: b.classList.contains("wait"), bub: b.offsetWidth > 0, txt: n && n.offsetWidth > 1 ? n.innerText : "", title: b.title } : null; });
  // 小卡：待验收的轮次有没答的 → 写「没答」；都答完的还是灰气泡；进行中的不写
  assert.deepEqual(await mark("r1"), { wait: true, bub: true, txt: "2 条没答", title: "顺便问 3 条，2 条没答" });
  assert.deepEqual({ ...(await mark("r2")), bub: undefined }, { wait: false, bub: undefined, txt: "", title: "顺便问 1 条" }, "都答完的不写条数（气泡在窄卡上照旧收起）");
  assert.equal((await mark("r3")).wait, false);
  // 详情：页头一个标记（不用往下翻），时间线上这一轮写条数
  assert.match(await page.textContent(".dh .chips"), /2 条顺便问没答/);
  assert.equal(await page.$eval('.rr[data-k="r:r1"] .bw .bt', (e) => e.innerText), "2 条没答");
  assert.deepEqual(await page.$$eval(".btw .bq", (xs) => xs.map((x) => x.className.replace("bq ", ""))), ["wait", "wait", "read"]);
  if (process.env.ALIGN_BTW_SHOTS) await page.screenshot({ path: path.join(process.env.ALIGN_BTW_SHOTS, "btw-done-640.webp"), type: "webp", quality: 75 });
  await open("#r=r2");
  assert.doesNotMatch(await page.textContent(".dh .chips"), /没答/);
  await open("#r=r3");
  assert.doesNotMatch(await page.textContent(".dh .chips"), /没答/);
  // 已通过、后面还有一轮时没被自动结束的：同样写出来
  await open("#r=r4");
  assert.match(await page.textContent(".dh .chips"), /1 条顺便问没答/);
  // 手机宽和窄卡：标记不溢出、不把标题挤没
  await open("#r=r1");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector(".dh .chips"));
  // 改宽后窄卡的让位(fitMeta)在 ResizeObserver 回调里做,可能晚几帧;先等它让完(上限只防挂死),下面照旧断言不溢出。
  // 2026-11-03 之前紧接着量,抢在让位前偶发量到 4 个溢出(门禁和单跑都先红后绿)。
  await page.waitForFunction(() => [...document.querySelectorAll(".sc-t, .sc-m, .chips, .rr .k")].every((x) => !x.offsetParent || x.scrollWidth <= x.clientWidth + 1), null, { polling: "raf", timeout: 5000 }).catch(() => {});
  assert.equal((await mark("r1")).bub, true, "窄卡上写不下条数时气泡还在");
  const over = await page.$$eval(".sc-t, .sc-m, .chips, .rr .k", (xs) => xs.filter((x) => x.offsetParent && x.scrollWidth > x.clientWidth + 1).length);
  assert.equal(over, 0, "390 宽不溢出");
  if (process.env.ALIGN_BTW_SHOTS) await page.screenshot({ path: path.join(process.env.ALIGN_BTW_SHOTS, "btw-done-390.webp"), type: "webp", quality: 75 });
  assert.deepEqual(errors, []);
});

test("顺便问：提问 → 发给 First Mate → 会话写回答案 → 决定栏答案卡 → 了解 / 追问（640 / 390）", { timeout: 120_000 }, async (t) => {
  const sent = [];
  const handler = A.createHandler({ prefix: A.ROUTE_PREFIX, send: async (sid, text, card) => { sent.push({ sid, text, card }); }, guard: () => null, live: async (sids) => Object.fromEntries(sids.map((s) => [s, "running"])) });
  const server = createServer((req, res) => {
    const p = req.url.split("?")[0];
    const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (p.endsWith("/log")) return json(200, { ok: true });
    if (p === "/alignment/health") return json(200, { ok: true, api: A.API_VERSION });
    if (p === "/alignment/todos") return json(200, { ok: true, api: 2, sessions: {}, activity: {} });
    if (p === "/alignment/fm") return json(200, { ok: true, page: name, fm: { sid: SID(9), title: "first mate" }, refresh: null });
    if (p === "/alignment/tools") return json(200, { ok: true, api: 1, rounds: {} });
    return handler(req, res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await getBrowser();
  const ctx = await browser.newContext({ viewport: { width: 640, height: 900 }, deviceScaleFactor: 2 });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  page.setDefaultTimeout(5000);
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  const url = "http://127.0.0.1:" + server.address().port + "/alignment/p/" + name;
  await page.goto(url + "#r=r1");
  await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
  await page.waitForSelector(".btw");

  // 详情里一节：两条，按「新回答 → 等回答 → 已看过」排；等答的显示会话给的时机；已看过的是实心灰点
  assert.deepEqual(await page.$$eval(".btw .bq", (xs) => xs.map((x) => x.className.replace("bq ", ""))), ["wait", "read"]);
  assert.match(await page.textContent(".btw .bq.wait"), /等 A\/B 跑完/);
  // 小卡气泡：没有新回答 → 灰，不带数字
  const bub = await page.$eval('.sc[data-rid="r1"] .sc-t .bw', (e) => ({ cls: e.className, txt: e.childNodes.length, color: getComputedStyle(e.querySelector(".i")).color }));
  assert.equal(bub.cls, "bw");
  assert.equal(bub.color, "rgb(100, 106, 115)", "没有新回答时气泡 ink3");
  assert.equal(await page.$eval('.sc[data-rid="r1"] .sc-t .bw', (e) => [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("")), "", "小卡气泡不带数字");

  // 提问：点「顺便问一句」→ 输入 → 进发送队列（标「顺便问」，会话卡不亮「已选待发送」的勾）
  await page.click('[data-act="bask"][data-id="r1"]');
  await page.fill('[data-in="bask"][data-id="r1"]', "A 组显存峰值多少？");
  await page.waitForSelector(".sendbar .send:not([disabled])");
  assert.equal(await page.$$eval('.sc[data-rid="r1"] .pk', (x) => x.length), 0);
  await page.click('[data-act="queue"]');
  assert.equal(await page.textContent("#queue .qk"), "顺便问");
  await page.click('[data-act="queue"]');
  if (process.env.ALIGN_BTW_SHOTS) await page.screenshot({ path: path.join(process.env.ALIGN_BTW_SHOTS, "btw-ask-640.png") });
  await page.click(".sendbar .send");
  await page.waitForSelector(".toast.ok");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sid, SID(9), "经 First Mate 转发");
  const m = sent[0].text.match(/align btw forward bw (b-[a-z0-9-]+)/);
  assert.ok(m, "消息末尾给出 First Mate 要跑的命令：" + sent[0].text);
  assert.match(sent[0].text, /顺便问，挂在轮次「旁白按游戏上下文说话」（r1）：A 组显存峰值多少？/);
  assert.deepEqual(sent[0].card.decisions, [{ title: "顺便问：旁白按游戏上下文说话", choice: "", note: "A 组显存峰值多少？" }]);
  const id = m[1];
  assert.equal(await page.$$eval(".btw .bq", (xs) => xs.length), 3, "新问题出现在列表里（等答）");

  // 会话写回答案（CLI）→ 页面轮询到：决定栏出答案卡
  A.mutate(file, (d, now) => A.btwOps.answer(d, now, [id], [["a", "峰值 15.2 GB，在 16.3 GB 以内。"]], {}));
  await page.reload();
  await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
  await page.waitForSelector('.sc[data-rid="r1"] .sc-t .bw.new');
  assert.equal(await page.$eval('.sc[data-rid="r1"] .sc-t .bw.new .i', (e) => getComputedStyle(e).color), "rgb(47, 98, 214)", "有新回答气泡变蓝");
  await page.click('[data-act="tab"][data-v="dec"]');
  await page.waitForSelector(".bwg .bcard");
  // 决定数只数决定：页签上的蓝色数字和「待决定」筛选都是 1
  assert.equal(await page.textContent(".seg .cnt-b"), "1");
  assert.match(await page.textContent('.fc[data-v="open"]'), /待决定 1/);
  const card = await page.$eval(".bwg", (e) => ({ txt: e.innerText, risk: e.querySelectorAll(".rk,.due,.rec").length }));
  assert.match(card.txt, /峰值 15\.2 GB/);
  // 跳到那一轮：点答案卡的正文，右栏这一条排在最前（有新回答）
  await page.click(".bwg .bgo");
  await page.waitForSelector(".btw .bq.new:first-child");
  await page.click('[data-act="tab"][data-v="dec"]');
  await page.waitForSelector(".bwg .bcard");
  assert.equal(card.risk, 0, "答案卡没有风险标、截止和推荐");
  if (process.env.ALIGN_BTW_SHOTS) await page.screenshot({ path: path.join(process.env.ALIGN_BTW_SHOTS, "btw-side-640.png") });

  // 继续追问：写一句 → 发送 → 消息里是追问 + 之前的答案 + forward 命令；卡消掉（等新答案）
  await page.click('[data-act="bmore"][data-id="' + id + '"]');
  await page.fill('[data-in="bmore"][data-id="' + id + '"]', "B 组呢？");
  await page.click(".sendbar .send");
  await page.waitForSelector(".toast.ok");
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, new RegExp("继续追问顺便问 " + id + "：B 组呢？"));
  assert.match(sent[1].text, /之前的答案：峰值 15\.2 GB/);
  assert.match(sent[1].text, new RegExp("align btw forward bw " + id));
  assert.equal(await page.$$eval(".bwg", (x) => x.length), 0, "追问发出后答案卡消掉");
  let b = A.pageData(name).btw.find((x) => x.id === id);
  assert.equal(b.status, "open");
  assert.equal(b.more.length, 1);

  // 答了追问 → 又出卡 → 了解：只写文件（不发消息），卡消掉，小卡气泡回到灰
  A.mutate(file, (d, now) => A.btwOps.answer(d, now, [id], [["a", "B 组 13.8 GB。"]], {}));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
  await page.click('[data-act="tab"][data-v="dec"]');
  await page.waitForSelector(".bwg .bcard");
  assert.match(await page.textContent(".bwg .bcard"), /B 组呢？[\s\S]*13\.8 GB/);
  const over = await page.$$eval(".bcard, .bbtn", (xs) => xs.filter((x) => x.scrollWidth > x.clientWidth + 1).length);
  assert.equal(over, 0, "390 宽答案卡不溢出");
  if (process.env.ALIGN_BTW_SHOTS) await page.screenshot({ path: path.join(process.env.ALIGN_BTW_SHOTS, "btw-phone-390.png") });
  await page.click('[data-act="back"][data-id="' + id + '"]');
  await page.waitForSelector(".bwg", { state: "detached" });
  assert.equal(sent.length, 2, "「了解」不发消息");
  b = A.pageData(name).btw.find((x) => x.id === id);
  assert.ok(b.seen && !A.btwUnseen(b));
  assert.equal(await page.$$eval('.sc[data-rid="r1"] .sc-t .bw.new', (x) => x.length), 0);
  // 详情里追问挂在同一条下面
  await page.click('.bwg, [data-act="tab"][data-v="sess"]');
  await page.click('.sc[data-rid="r1"]');
  await page.waitForSelector(".btw .bq .fu");
  assert.match(await page.textContent(".btw .bq:has(.fu)"), /A 组显存峰值[\s\S]*B 组呢？[\s\S]*13\.8 GB/);
  // 写了追问还没发，会话链结束了：这条追问从待发送里去掉，和它同批的留言照常发出（不被整批拒收）
  await A.answerBatch(name, { answers: [{ kind: "btw-more", id, q: "C 组呢？" }] }, async () => {});
  A.mutate(file, (d, now) => A.btwOps.answer(d, now, [id], [["a", "三答。"]], {}));
  await page.reload();
  await page.click('[data-act="tab"][data-v="dec"]');
  await page.click('[data-act="bmore"][data-id="' + id + '"]');
  await page.fill('[data-in="bmore"][data-id="' + id + '"]', "还想问");
  A.mutate(file, (d, now) => { const r = d.rounds.find((x) => x.id === "r1"); r.status = "dropped"; r.ended = now; return ""; });
  await page.evaluate(() => { const k = Object.keys(localStorage).find((x) => x.startsWith("align-picks:")); const p = JSON.parse(localStorage.getItem(k)); p["m:"] = { text: "顺手留一句" }; localStorage.setItem(k, JSON.stringify(p)); });
  await page.reload();
  await page.waitForSelector(".sendbar .send:not([disabled])");
  assert.equal(await page.$$eval('[data-act="bmore"]', (x) => x.length), 0, "链结束后没有「继续追问」");
  await page.click(".sendbar .send");
  await page.waitForSelector(".toast.ok");
  const last = sent[sent.length - 1];
  assert.match(last.text, /用户留言：顺手留一句/);
  assert.doesNotMatch(last.text, /还想问/);
  assert.deepEqual(errors, []);
});
