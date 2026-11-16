// 真浏览器回归(2026-10-24):对齐页详情宽屏(右栏 ≥ 960)分两栏不再要求有待办或选项。
// 原规则 .rbody:has(>.after>:is(.todos,.opts)):没有待办的待验收轮次、已发送决定、开放问题在宽屏下仍单栏、内容只占左边 780,
// 附件缩略图排在正文最下面,首屏常被悬浮的「确认 / 修改」压住;结果一句一行。
// 现在:正文后面那一块里有回执 / 修改意见框以外的东西(待办、选项、回复框、附件、工具调用)就两栏;轮次没有待办、决定已发送时
// 附件在右栏最上面放大成预览(长条图占满一行);只有回执的仍单栏;已处理决定只有回复时回执开头不带「·」;
// 单栏(右栏 < 960,2026-10-24 First Mate 定):附件挪到数字卡后面、事实行前面,首屏看得到、不在悬浮按钮底下;缩略图只排一行(放不下横向滚),
// 拖宽过 960 回到两栏的位置,拖窄回来再挪回数字卡后面;窄栏数字卡排成好几行时附件排在第一行卡后面;重画不丢缩略图那一行的横向位置;
// 缩略图的键盘焦点框画在缩略图里面(不被滚动容器裁掉),那一行的右边和数字卡对齐;右栏变大小时数字卡分法没变就不挪(不重放进场动画);右栏变大小(没跨 960)时附件不重新插入:焦点、横向位置都不丢;结果第一句以后收成首行下面的紧凑列表;窄屏(420)仍单栏。
// 页面由 align.mjs render() 生成,本地 http 服务给页面、/data、/health、/file;依赖插件 devDependencies 里的 playwright-core（DSH_ALIGN_PW_DIR 覆盖）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "align-wide-any-"));
process.env.ALIGN_STORE = dir;
process.env.ALIGN_WORKSPACES = path.join(dir, "workspace.json");
const A = await import("../cli/align.mjs");
const { chromium } = createRequire((process.env.DSH_ALIGN_PW_DIR ? path.join(process.env.DSH_ALIGN_PW_DIR, "package.json") : import.meta.url))("playwright-core");
// 一个文件只起一个 Chromium,各用例自己开 context(隔离不变)
let browserP;
const getBrowser = () => (browserP ??= chromium.launch({ headless: true }));
test.after(async () => { if (browserP) await (await browserP.catch(() => null))?.close(); });

/** 最小 PNG(RGB,无滤波)。 */
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
const paint = (x, y) => ((x >> 5) + (y >> 5)) % 2 ? [255, 255, 255] : [228, 232, 240];
const wide = path.join(dir, "wide.png"), strip = path.join(dir, "strip.png");
fs.writeFileSync(wide, png(1280, 800, paint));
fs.writeFileSync(strip, png(1400, 300, paint)); // 宽高比 4.7:长条

const T = Date.parse("2026-10-24T10:00:00Z"), iso = (ms) => new Date(ms).toISOString();
const done = (id, extra) => ({ id, sid: "session-" + id, status: "done", started: iso(T - 3600e3), ended: iso(T - 60e3), updated: iso(T - 60e3), ...extra });
const data = {
  version: 3, name: "wa", title: "宽屏两栏", owner: "session-fm", updated: iso(T), projects: [],
  rounds: [
    done("s1", { title: "盖章重做", why: "用户留言", result: "已合入 cb29037c。主要对标 IP, Please。现在能看见：从右上落下 90 毫秒、压住 60 毫秒。墨迹慢慢变干。声音默认关",
      img: [{ src: wide, cap: "单盖对比" }, { src: strip, cap: "连续六个" }], link: [{ href: "https://example.com/v", title: "对比视频" }] }),
    done("m1", { title: "四张卡七张图", result: "做完了。落下 90 毫秒。压住 60 毫秒。对比度 5.1", kpi: [{ label: "落下", value: "90 毫秒" }, { label: "压住", value: "60 毫秒" }, { label: "对比度", value: "5.1" }],
      img: Array.from({ length: 7 }, (_, i) => ({ src: wide, cap: "图 " + (i + 1) })) }),
    done("e1", { title: "只有正文", result: "查完了" }),
    done("k1", { title: "只有回执", result: "做完了", ask: "accept", asked: iso(T - 30e3) }),
  ],
  decisions: [
    { id: "x1", title: "选哪个", why: "原因一。原因二", status: "sent", choice: "A", answered: iso(T - 30e3), opened: iso(T - 7200e3), updated: iso(T - 30e3), opt: [{ label: "A" }, { label: "B" }], img: [{ src: wide, cap: "截图" }] },
    { id: "q1", title: "这个怎么改", why: "说说你的想法", status: "open", opened: iso(T - 600e3), updated: iso(T - 600e3) },
    { id: "y1", title: "是这个按钮吗", why: "截图里那个", status: "done", choice: "", reply: "不是的，是发送按钮", answered: iso(T - 30e3), opened: iso(T - 7200e3), updated: iso(T - 30e3), img: [{ src: strip, cap: "输入框" }] },
  ],
  notes: [],
};

const bump = { n: 0 }; // 测试里加一,下一次 /data 就和上一次不同,页面按轮询重画
function serve() {
  const html = A.render(data), files = new Map([wide, strip].map((f) => [f, fs.readFileSync(f)]));
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://x"), p = u.pathname;
    const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (p === "/alignment/p/wa") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(html); }
    if (p === "/alignment/p/wa/data") return json(200, { ...data, updated: iso(T + bump.n * 1000), live: {} });
    if (p === "/alignment/p/wa/file") { const f = files.get(u.searchParams.get("path")); if (!f) return json(404, { ok: false, message: "没有" }); res.writeHead(200, { "content-type": "image/png" }); return res.end(f); }
    if (p === "/alignment/health") return json(200, { ok: true, api: A.API_VERSION });
    if (p === "/alignment/todos") return json(200, { ok: true, api: 2, sessions: {}, activity: {} });
    if (p === "/alignment/fm") return json(200, { ok: true, page: "wa", fm: null, refresh: null });
    if (p === "/alignment/p/wa/log") { res.writeHead(204); return res.end(); }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, base: "http://127.0.0.1:" + server.address().port })));
}

async function open(t, viewport, hash) {
  const s = await serve();
  t.after(() => { s.server.closeAllConnections(); s.server.close(); });
  const browser = await getBrowser();
  const ctx = await browser.newContext({ viewport });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  page.setDefaultTimeout(5000);
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(s.base + "/alignment/p/wa#" + hash);
  await page.waitForSelector(".rbody>.dh");
  return { page, errors };
}
const go = async (page, hash, title) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForFunction((t) => document.querySelector(".rbody>.dh h1")?.textContent === t, title); };

/** 右栏布局:是否两栏、附件在哪一块、附件和正文 / 悬浮按钮的相对位置、预览宽度、结果的行数。 */
const lay = (page) => page.evaluate(() => {
  const q = (s) => document.querySelector(s), rb = q(".rbody"), att = q(".att"), facts = q(".facts");
  const bt = [...document.querySelectorAll(".rfoot .btn")].map((b) => b.getBoundingClientRect());
  const hit = (r) => bt.some((b) => r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top);
  return {
    grid: getComputedStyle(rb).display, attIn: att ? att.parentElement.className : null,
    beside: !!(att && facts) && att.getBoundingClientRect().left >= facts.getBoundingClientRect().right,
    // 首屏(没滚动)时有没有哪张图、哪个链接和悬浮按钮重叠
    covered: [...document.querySelectorAll(".att .thumb, .att .alink")].filter((e) => hit(e.getBoundingClientRect())).map((e) => e.textContent.trim()),
    thumbs: [...document.querySelectorAll(".att .thumb")].map((x) => ({ w: Math.round(x.getBoundingClientRect().width), strip: x.classList.contains("strip") })),
    facts: document.querySelectorAll(".facts .fact").length, sub: [...document.querySelectorAll(".facts .fsub li")].map((x) => x.textContent),
    overflowX: rb.scrollWidth > rb.clientWidth + 1,
  };
});

test("宽屏 1600:没有待办的待验收轮次分两栏,附件在右栏最上面放大成预览、不在悬浮按钮底下;长条图占满一行;结果收成紧凑列表", { timeout: 60_000 }, async (t) => {
  const { page, errors } = await open(t, { width: 1600, height: 900 }, "r=s1");
  await page.waitForSelector(".att .thumb.strip");
  const l = await lay(page);
  assert.equal(l.grid, "grid", "分两栏: " + JSON.stringify(l));
  assert.equal(l.attIn, "after", "附件在正文后面那一块(右栏)");
  assert.ok(l.beside, "附件在正文右边: " + JSON.stringify(l));
  assert.deepEqual(l.covered, [], "首屏没有图或链接压在悬浮按钮底下");
  assert.deepEqual(l.thumbs.map((x) => x.strip), [false, true]);
  // 长条图占满一行(右栏 443 宽);只有一张普通截图时保持 16:10、按详情区高度限高,仍比原来的缩略图(132)大
  assert.ok(l.thumbs[1].w >= 440 && l.thumbs[0].w >= 200, "截图放大成预览、长条图占满一行: " + JSON.stringify(l.thumbs));
  assert.equal(l.facts, 2, "结果和起因各一行");
  assert.deepEqual(l.sub, ["主要对标 IP, Please", "现在能看见：从右上落下 90 毫秒、压住 60 毫秒", "墨迹慢慢变干", "声音默认关"], "结果第一句以后是紧凑列表");
  assert.equal(await page.textContent(".facts .fsub .fk"), "现在能看见：");
  assert.equal(errors.length, 0, errors.join("\n"));
});

test("宽屏 1600:已发送 / 已处理的决定、开放问题分两栏(只有回复的回执开头不带「·」);正文后面只有回执或什么都没有的仍单栏", { timeout: 60_000 }, async (t) => {
  const { page, errors } = await open(t, { width: 1600, height: 900 }, "d=x1");
  let l = await lay(page);
  assert.deepEqual([l.grid, l.attIn, l.beside], ["grid", "after", true], "已发送决定: " + JSON.stringify(l));
  await go(page, "d=y1", "是这个按钮吗");
  l = await lay(page);
  assert.deepEqual([l.grid, l.attIn, l.beside], ["grid", "after", true], "已处理决定: " + JSON.stringify(l));
  assert.match(await page.textContent(".rcpt.done"), /^不是的，是发送按钮/, "只有回复时回执开头没有「·」");
  assert.deepEqual(await page.$$eval(".rbody>.after>*", (x) => x.map((e) => e.className)), ["rcpt done", "att"], "回执在前、附件在后");
  await go(page, "d=q1", "这个怎么改");
  assert.equal((await lay(page)).grid, "grid", "开放问题:回复框在右栏");
  await go(page, "r=k1", "只有回执");
  assert.equal((await lay(page)).grid, "block", "只有回执:单栏");
  await go(page, "r=e1", "只有正文");
  l = await lay(page);
  assert.equal(l.grid, "block", "正文后面没东西:单栏");
  assert.equal(await page.$eval(".rbody>.bodyx", (b) => getComputedStyle(b).maxWidth), "780px");
  assert.equal(errors.length, 0, errors.join("\n"));
});

test("窄屏 420:仍单栏,附件在数字卡后面,不横向溢出", { timeout: 60_000 }, async (t) => {
  const { page, errors } = await open(t, { width: 420, height: 900 }, "r=s1");
  await page.waitForSelector(".att .thumb img");
  const l = await lay(page);
  assert.deepEqual([l.grid, l.attIn, l.beside, l.overflowX], ["block", "bB", false, false], JSON.stringify(l));
  assert.equal(l.sub.length, 4);
  assert.equal(errors.length, 0, errors.join("\n"));
});

test("单栏 1280:附件在数字卡后面、事实行前面,首屏看得到、不在悬浮按钮底下;缩略图一行;拖宽过 960 回到右栏,拖窄回来再挪回", { timeout: 60_000 }, async (t) => {
  const { page, errors } = await open(t, { width: 1280, height: 900 }, "r=s1");
  await page.waitForSelector(".bB > .att .thumb img");
  const at = () => page.evaluate(() => {
    const a = document.querySelector(".att"), rb = document.querySelector(".rbody"), ths = [...a.querySelectorAll(".thumb")].map((x) => Math.round(x.getBoundingClientRect().top));
    const bt = Math.min(...[...document.querySelectorAll(".rfoot .btn")].map((b) => b.getBoundingClientRect().top));
    return { grid: getComputedStyle(rb).display, parent: a.parentElement.className, prev: a.previousElementSibling?.className ?? null, next: a.nextElementSibling?.className ?? null,
      oneRow: new Set(ths).size === 1, aboveBtns: a.getBoundingClientRect().bottom <= bt, inView: a.getBoundingClientRect().bottom <= rb.getBoundingClientRect().bottom };
  });
  let l = await at();
  assert.deepEqual([l.grid, l.parent, l.prev, l.next], ["block", "bB", "kpis", "facts"], "单栏:附件在数字卡后面: " + JSON.stringify(l));
  assert.ok(l.oneRow && l.aboveBtns && l.inView, "缩略图一行、首屏、在按钮上方: " + JSON.stringify(l));
  // 拖宽:右栏过 960 分两栏,附件回到右栏最上面
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.waitForFunction(() => document.querySelector(".att")?.parentElement.className === "after");
  assert.equal(await page.$eval(".rbody", (b) => getComputedStyle(b).display), "grid");
  assert.equal(await page.$eval(".rbody > .after", (b) => b.firstElementChild.className), "att", "两栏:附件在右栏最上面");
  // 拖窄回来:再挪回数字卡后面,不留第二份
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForFunction(() => document.querySelector(".att")?.parentElement.className === "bB");
  assert.equal(await page.$$eval(".att", (l) => l.length), 1, "只有一份附件");
  assert.equal(errors.length, 0, errors.join("\n"));
});

test("单栏 1280:没有数字卡的决定,附件紧跟标题、在事实行前面", { timeout: 60_000 }, async (t) => {
  const { page, errors } = await open(t, { width: 1280, height: 900 }, "d=y1");
  await page.waitForSelector(".bB > .att .thumb");
  const l = await page.$eval(".bB > .att", (a) => [a.previousElementSibling?.className ?? null, a.nextElementSibling?.className ?? null]);
  assert.deepEqual(l, [null, "facts"], "没有数字卡时附件是正文第一块");
  assert.equal(errors.length, 0, errors.join("\n"));
});

test("窄屏 420:4 张数字卡排成好几行时附件排在第一行卡后面、首屏看得到;重画不丢缩略图那一行的横向位置;焦点框不被裁掉", { timeout: 60_000 }, async (t) => {
  const { page, errors } = await open(t, { width: 420, height: 900 }, "r=m1");
  await page.waitForSelector(".bB > .att .thumb img");
  const l = await page.evaluate(() => {
    const a = document.querySelector(".bB > .att"), rb = document.querySelector(".rbody");
    const bt = Math.min(...[...document.querySelectorAll(".rfoot .btn")].map((b) => b.getBoundingClientRect().top));
    return { prev: a.previousElementSibling?.className, next: a.nextElementSibling?.className, cardsBefore: a.previousElementSibling?.children.length,
      cardsAfter: a.nextElementSibling?.classList.contains("more") ? a.nextElementSibling.children.length : 0, thumbTop: a.querySelector(".thumb").getBoundingClientRect().bottom <= bt };
  });
  assert.deepEqual([l.prev, l.next], ["kpis", "kpis more"], "附件前面是第一行卡、后面是其余的卡: " + JSON.stringify(l));
  assert.equal(l.cardsBefore + l.cardsAfter, 4, "卡一张不少");
  assert.ok(l.thumbTop, "第一张缩略图整张在悬浮按钮上方: " + JSON.stringify(l));
  // 横向滚到一半,重画(和轮询、定时重画同一个入口)后位置不变
  await page.$eval(".ths", (x) => { x.scrollLeft = 120; });
  const before = await page.$eval(".ths", (x) => x.scrollLeft);
  assert.ok(before > 0, "缩略图那一行能横向滚");
  // 数据变了:4 秒轮询取到新数据后整块重画详情
  const mark = await page.$eval(".rbody > .dh", (h) => { h.dataset.old = "1"; return 1; });
  bump.n++;
  await page.waitForFunction(() => !document.querySelector(".rbody > .dh")?.dataset.old, null, { timeout: 12000 });
  assert.equal(mark, 1);
  assert.equal(await page.$eval(".ths", (x) => x.scrollLeft), before, "重画后横向位置不丢");
  // 焦点框画在缩略图里面(滚动容器裁不掉);滚动容器的右边和数字卡右边对齐
  await page.keyboard.press("Tab"); // 让 :focus-visible 生效
  await page.focus(".ths .thumb");
  const fr = await page.evaluate(() => { const th = document.querySelector(".ths .thumb"), s = getComputedStyle(th), x = document.querySelector(".ths").getBoundingClientRect(), k = document.querySelector(".bB > .kpis").getBoundingClientRect(); return { off: parseFloat(s.outlineOffset), w: parseFloat(s.outlineWidth), edge: Math.round(x.right - k.right) }; });
  assert.ok(fr.off + fr.w <= 0, "焦点框画在缩略图里面: " + JSON.stringify(fr));
  assert.equal(fr.edge, 0, "缩略图那一行的右边和数字卡对齐: " + JSON.stringify(fr));
  assert.equal(errors.length, 0, errors.join("\n"));
});

test("单栏 1280:右栏变大小(没跨 960)时附件不重新插入,焦点和缩略图那一行的横向位置都不丢", { timeout: 60_000 }, async (t) => {
  const { page, errors } = await open(t, { width: 1280, height: 900 }, "r=m1");
  await page.waitForSelector(".bB > .att .thumb img");
  await page.$eval(".ths", (x) => { x.scrollLeft = 100; });
  await page.focus(".ths .thumb:nth-child(2)");
  const before = await page.$eval(".ths", (x) => x.scrollLeft);
  assert.ok(before > 0);
  await page.evaluate(() => { window.__moved = 0; new MutationObserver((ms) => { for (const m of ms) if ([...m.addedNodes].some((n) => n.classList?.contains("kpi"))) window.__moved++; }).observe(document.querySelector(".bB"), { childList: true, subtree: true }); });
  await page.setViewportSize({ width: 1240, height: 860 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 100)))));
  const l = await page.evaluate(() => ({ grid: getComputedStyle(document.querySelector(".rbody")).display, focus: document.activeElement?.querySelector("img")?.alt ?? document.activeElement?.tagName, left: document.querySelector(".ths").scrollLeft }));
  assert.equal(l.grid, "block");
  assert.equal(l.focus, "图 2", "焦点还在第二张缩略图上: " + JSON.stringify(l));
  assert.equal(l.left, before, "横向位置不变: " + JSON.stringify(l));
  assert.equal(await page.evaluate(() => window.__moved), 0, "数字卡分法没变,卡不挪(不重放进场动画)");
  assert.equal(errors.length, 0, errors.join("\n"));
});

test("窄屏 420:右栏变大小时数字卡分法没变就不挪(不重放进场动画)", { timeout: 60_000 }, async (t) => {
  const { page, errors } = await open(t, { width: 420, height: 900 }, "r=m1");
  await page.waitForSelector(".bB > .kpis.more");
  const n0 = await page.$eval(".bB .kpi", (l) => l.length);
  await page.evaluate(() => { window.__moved = 0; new MutationObserver((ms) => { for (const m of ms) if ([...m.addedNodes].some((n) => n.classList?.contains("kpi"))) window.__moved++; }).observe(document.querySelector(".bB"), { childList: true, subtree: true }); });
  await page.setViewportSize({ width: 420, height: 820 });
  await page.setViewportSize({ width: 424, height: 860 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 100)))));
  assert.equal(await page.evaluate(() => window.__moved), 0, "卡不挪");
  assert.equal(await page.$eval(".bB .kpi", (l) => l.length), n0, "卡一张不少");
  assert.equal(errors.length, 0, errors.join("\n"));
});
