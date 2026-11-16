// 真浏览器（2026-10-30）：对齐页「须知」显示在「决定」页签的「待决定」里，另成一组（和顺便问的回答、今日推荐同一套卡）：
// 标题、正文、截图和链接都显示；按钮只有「了解」；不计入决定数、没有风险标和截止。点「了解」只写 acked、不发消息，卡消失；
// 已了解的在「已处理」最后折叠成一组（默认收起），展开后「恢复」去掉 acked，卡回到「待决定」。今日推荐（rec-*）照旧单独一组，不进须知组。
// 宽 640（DSH 右侧栏）和 1440 各截一张（ALIGN_NOTE_SHOTS=<目录> 时存下来）。依赖插件 devDependencies 里的 playwright-core（DSH_ALIGN_PW_DIR 覆盖），缺失即失败。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "align-note-"));
process.env.ALIGN_STORE = dir;
process.env.ALIGN_WORKSPACES = path.join(dir, "workspace.json");
fs.writeFileSync(process.env.ALIGN_WORKSPACES, JSON.stringify({ workspaces: [] }));
const A = await import("../cli/align.mjs");
const { chromium } = createRequire((process.env.DSH_ALIGN_PW_DIR ? path.join(process.env.DSH_ALIGN_PW_DIR, "package.json") : import.meta.url))("playwright-core");
// 一个文件只起一个 Chromium,各用例自己开 context(隔离不变)
let browserP;
const getBrowser = () => (browserP ??= chromium.launch({ headless: true }));
test.after(async () => { if (browserP) await (await browserP.catch(() => null))?.close(); });

/** 最小 PNG（RGB，无滤波）：paint(x, y) → [r, g, b]。 */
function png(w, h, paint) {
  const row = w * 3 + 1, raw = Buffer.alloc(row * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(paint(x, y), y * row + 1 + x * 3);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4), crc = Buffer.alloc(4), td = Buffer.concat([Buffer.from(type), data]);
    len.writeUInt32BE(data.length); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const shotPng = path.join(dir, "group-chat.png");
fs.writeFileSync(shotPng, png(640, 400, (x, y) => (y < 40 ? [255, 255, 255] : x < 180 ? [246, 247, 249] : (y - 60) % 70 < 48 ? [237, 242, 253] : [255, 255, 255])));

const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
const p2 = (n) => String(n).padStart(2, "0");
const d0 = new Date(), DAY = d0.getFullYear() + p2(d0.getMonth() + 1) + p2(d0.getDate());
const name = "nt";
const file = path.join(dir, name + ".html");
const SID = (n) => "session-0000000" + n + "-0000-4000-8000-000000000000";
fs.writeFileSync(file, A.render({ version: 3, name, title: "须知测试", owner: SID(9), updated: ago(1), projects: [{ id: "pa", title: "highschool", cwd: "C:/p/pa" }],
  rounds: [{ id: "r1", sid: SID(1), title: "旁白按游戏上下文说话", status: "doing", proj: "pa", started: ago(60), eta: "1h", eta75: "2h", etaconf: "中" }],
  decisions: [{ id: "d1", title: "换不换语音模型", why: "两个模型延迟差一倍。所以来问。", status: "open", round: "r1", proj: "pa", risk: "中", cat: "方向取舍", opened: ago(10), due: new Date(Date.now() + 7 * 36e5).toISOString(),
    opt: [{ label: "换", effect: "快一倍" }, { label: "不换", effect: "不动" }] }],
  notes: [
    { id: "n-info", title: "Bochao 推荐对比 Qwen-MM-Plugins", body: "Bochao 私聊推荐 https://github.com/QwenLM/Qwen-MM-Plugins ，他试配过，里面工具很多；要不要派会话调研由你定。", proj: "pa", updated: ago(5) },
    { id: "n-warn", title: "Zixuan 在群里要最新的旁白 system prompt", body: "最新版在 D:\\work\\narrator-prompt-1029.md；我没回复。", level: "warn", proj: "pa", updated: ago(30),
      href: "https://example.com/thread", img: [{ src: shotPng, cap: "群聊截图" }], link: [{ href: "https://example.com/runs", title: "实验记录" }] },
    { id: "n-old", title: "早报改成新会话发出", updated: ago(600), acked: ago(300) },
    { id: "rec-" + DAY + "-1", title: "回对齐页 3 个待决定", body: "15 分钟。", updated: ago(60) }] }));
fs.writeFileSync(path.join(dir, "pages.json"), JSON.stringify({ [name]: file }));

test("须知：决定栏里一组卡 → 了解（不发消息、卡消失）→ 已处理里折叠 → 恢复（640 / 1440）", { timeout: 120_000 }, async (t) => {
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
  await page.goto(url);
  await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
  await page.waitForSelector(".nwg .ncard");
  const shots = process.env.ALIGN_NOTE_SHOTS;
  const shot = (n) => shots && page.screenshot({ path: path.join(shots, n), type: "webp", quality: 75 });

  // 决定数仍是 1（须知不计入），页面角标口径不变；页签上另有须知条数
  assert.equal(await page.textContent('[data-act="tab"][data-v="dec"] .cnt-b'), "1");
  assert.equal(A.cardCount(A.pageData(name)), 1, "须知不计入角标");
  assert.match(await page.getAttribute('[data-act="tab"][data-v="dec"] .rcn:last-child', "title"), /^须知 2 条$/);
  // 须知组：提醒级在前；推荐不进这一组、已了解的不显示
  assert.equal(await page.textContent(".nwg h3 .tt"), "须知");
  assert.deepEqual(await page.$$eval(".nwg .ncard", (xs) => xs.map((x) => x.dataset.id)), ["n-warn", "n-info"]);
  assert.equal(await page.$$eval(".rwg .rcard", (x) => x.length), 1, "今日推荐照旧单独一组");
  // 卡上：标题、正文、截图、链接（href + link），只有「了解」一个按钮；没有风险标、截止
  const w = '.ncard[data-id="n-warn"]';
  const card = await page.$eval(w, (e) => ({ t: e.querySelector(".nt").textContent, b: e.querySelector(".nb").textContent, warn: !!e.querySelector(".nt svg"),
    img: e.querySelector(".thumb img").getAttribute("src"), links: [...e.querySelectorAll(".alink")].map((a) => [a.textContent, a.getAttribute("href")]),
    btns: [...e.querySelectorAll("button.bbtn")].map((b) => b.textContent), risk: e.querySelectorAll(".rk,.due,.chip").length }));
  assert.equal(card.t, "Zixuan 在群里要最新的旁白 system prompt");
  assert.match(card.b, /我没回复/);
  assert.ok(card.warn, "提醒级标题前有三角");
  assert.match(card.img, /\/file\?path=/);
  assert.deepEqual(card.links, [["…/example.com/thread", "https://example.com/thread"], ["实验记录", "https://example.com/runs"]]);
  assert.deepEqual(card.btns, ["了解"]);
  assert.equal(card.risk, 0);
  // 截图读得出来（附件白名单认须知）
  await page.waitForFunction((s) => { const i = document.querySelector(s + " .thumb img"); return i && i.complete && i.naturalWidth > 0; }, w);
  // 卡和按钮不溢出；链接名、正文里的网址太长时在框里截断（省略号），框不出卡
  const overflow = () => page.$$eval(".ncard", (cs) => cs.flatMap((c) => { const r = c.getBoundingClientRect(); return [c, ...c.querySelectorAll(".bbtn")].filter((x) => x.scrollWidth > x.clientWidth + 1)
    .concat([...c.querySelectorAll(".alink,.thumb,.tk")].filter((x) => { const b = x.getBoundingClientRect(); return b.left < r.left - 1 || b.right > r.right + 1; })).map((x) => x.className); }));
  assert.deepEqual(await overflow(), [], "640 宽下须知卡不溢出");
  await page.$eval(".nwg", (e) => e.scrollIntoView({ block: "start" }));
  await shot("note-cards-640.webp");

  // 了解：不发消息、不进发送队列，写 acked，卡消失，焦点落到下一张的「了解」
  await page.click(w + ' [data-act="nack"]');
  await page.waitForFunction(() => document.querySelectorAll(".ncard").length === 1);
  assert.equal(sent.length, 0, "了解不发消息");
  assert.ok(A.pageData(name).notes.find((n) => n.id === "n-warn").acked);
  assert.equal(await page.$$eval(".sendbar .send", (x) => x.filter((b) => b.offsetParent).length), 0, "没有东西进发送队列");
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.closest(".ncard")?.dataset.id), "n-info");
  await page.waitForFunction(() => /已了解：Zixuan/.test(document.getElementById("live-msg").textContent));

  // 已处理：最后一组「已了解的须知」，默认收起，新了解的在前；恢复后卡回到待决定
  await page.click('[data-act="df"][data-v="done"]');
  assert.equal(await page.getAttribute(".nkh", "aria-expanded"), "false");
  assert.equal(await page.textContent(".nkh .c"), "2");
  assert.equal(await page.$$eval(".nkl", (x) => x.length), 0);
  await page.click(".nkh");
  assert.deepEqual(await page.$$eval(".nk", (xs) => xs.map((x) => x.dataset.id)), ["n-warn", "n-old"]);
  await page.click('.nk[data-id="n-warn"] [data-act="nunack"]');
  await page.waitForFunction(() => document.querySelectorAll(".nk").length === 1);
  assert.ok(!A.pageData(name).notes.find((n) => n.id === "n-warn").acked, "恢复去掉 acked");
  assert.equal(sent.length, 0, "恢复也不发消息");
  await page.click('[data-act="df"][data-v="open"]');
  assert.deepEqual(await page.$$eval(".nwg .ncard", (xs) => xs.map((x) => x.dataset.id)), ["n-warn", "n-info"]);

  // 宽屏（1440）：同一组卡，截一张
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForSelector(".nwg .ncard");
  assert.deepEqual(await overflow(), [], "1440 宽下须知卡不溢出");
  await page.$eval(".nwg", (e) => e.scrollIntoView({ block: "start" }));
  await shot("note-cards-1440.webp");
  if (shots) {
    await page.setViewportSize({ width: 640, height: 900 });
    await page.click('[data-act="df"][data-v="done"]');
    await page.$eval(".nkg", (e) => e.scrollIntoView({ block: "start" }));
    await shot("note-acked-640.webp");
  }
  assert.deepEqual(errors, []);
});

test("只有须知、没有待决定时打开页面默认在「决定」页签", { timeout: 60_000 }, async (t) => {
  const f2 = path.join(dir, "nt2.html");
  fs.writeFileSync(f2, A.render({ version: 3, name: "nt2", title: "只有须知", owner: SID(9), updated: ago(1), projects: [],
    rounds: [{ id: "r1", sid: SID(1), title: "一轮", status: "doing", started: ago(60), eta: "1h", eta75: "2h", etaconf: "中" }], decisions: [],
    notes: [{ id: "n1", title: "一条须知", updated: ago(5) }] }));
  const browser = await getBrowser();
  const ctx = await browser.newContext({ viewport: { width: 640, height: 900 } });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  page.setDefaultTimeout(5000);
  await page.goto("file:///" + f2.replace(/\\/g, "/"));
  await page.waitForSelector(".nwg .ncard");
  assert.equal(await page.getAttribute('[data-act="tab"][data-v="dec"]', "aria-selected"), "true");
  assert.equal(await page.$$eval(".ncard .bbtn", (x) => x.length), 0, "离线打开的页面没有「了解」按钮");
});
