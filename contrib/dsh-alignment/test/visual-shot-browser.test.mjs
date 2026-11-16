// 真浏览器回归(2026-10-24):视觉类交付(visual)的待验收轮次,截图在详情正文最上面。
// - visual="true" 且 done:第一张大图在正文最上面(不用往下翻就能看到),其余缩略图第一屏也看得到(宽时在大图右边、窄时在下面,都在悬浮按钮上方),
//   底部附件只留链接;点大图看全图;横图整张缩进大图框,竖图(高 > 宽)按原宽显示、从下面裁掉,裁掉时底边渐隐;
// - 非视觉类(没有 visual)不变:没有截图块;单栏时缩略图在数字卡后面(见 wide-any-browser.test.mjs);
// - 截图读不出来:大图位置写服务端给的原因(同附件缩略图的「图片打不开」),不再是一张破图;
// - 不带标题的链接附件照常显示(2026-10-24 留言框改动删掉了 tail(),详情会抛 ReferenceError);
// - 页面时钟钉在夹具那天(open 的 now),第二天、长标题另有用例:标签行时间不是今天就带日期,575 宽下折两行,截图区不能因此压到按钮底下。
// 页面由 align.mjs render() 生成,本地 http 服务给页面、/data、/health、/file;依赖插件 devDependencies 里的 playwright-core（DSH_ALIGN_PW_DIR 覆盖）。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "align-visual-"));
process.env.ALIGN_STORE = dir;
process.env.ALIGN_WORKSPACES = path.join(dir, "workspace.json");
const A = await import("../cli/align.mjs");
const { chromium } = createRequire((process.env.DSH_ALIGN_PW_DIR ? path.join(process.env.DSH_ALIGN_PW_DIR, "package.json") : import.meta.url))("playwright-core");

/** 最小 PNG(RGB,无滤波):paint(x, y) → [r, g, b]。 */
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
const ui = (x, y) => (y < 46 ? [255, 255, 255] : x < 300 ? [246, 247, 249] : (x - 330) % 300 < 270 && (y - 80) % 220 < 190 ? [255, 255, 255] : [244, 245, 247]);
const wide = path.join(dir, "wide.png"), side = path.join(dir, "side.png"), mild = path.join(dir, "mild.png"), gone = path.join(dir, "gone.png");
fs.writeFileSync(wide, png(1280, 800, ui));
fs.writeFileSync(side, png(420, 900, ui));
fs.writeFileSync(mild, png(500, 650, ui)); // 高宽比 1.3:竖图,不该按高度缩成一条
const phone = path.join(dir, "phone.png"); fs.writeFileSync(phone, png(400, 860, ui)); // 竖图首张(手机截图)
const more = [1, 2, 3, 4].map((i) => { const f = path.join(dir, "more" + i + ".png"); fs.writeFileSync(f, png(420, 300, ui)); return f; });
const doc = path.join(dir, "notes", "report.md");

const T = Date.parse("2026-10-24T10:00:00Z"), iso = (ms) => new Date(ms).toISOString();
const done = (id, extra) => ({ id, sid: "session-" + id, status: "done", started: iso(T - 3600e3), ended: iso(T - 60e3), updated: iso(T - 60e3), ...extra });
const data = {
  version: 3, name: "vs", title: "视觉验收", owner: "session-fm", updated: iso(T), projects: [],
  rounds: [
    done("v1", { title: "改详情页", visual: "true", result: "两种宽度都截了图", img: [{ src: wide, cap: "宽屏" }, { src: side, cap: "侧栏" }], link: [{ href: doc }] }),
    done("n1", { title: "查数据", result: "查完了", img: [{ src: wide, cap: "图表" }], link: [{ href: doc }] }),
    done("b1", { title: "截图丢了", visual: "true", result: "改好了", img: [{ src: gone }] }),
    done("t1", { title: "长截图", visual: "true", result: "整页", img: [{ src: side, cap: "整页" }] }),
    done("m1", { title: "不太长的竖图", visual: "true", result: "手机页", img: [{ src: mild, cap: "手机" }] }),
    done("f1", { title: "五张截图", visual: "true", result: "各个页面都截了", img: [{ src: wide, cap: "首页" }, ...more.map((src, i) => ({ src, cap: "第 " + (i + 2) + " 张" }))] }),
    done("f3", { title: "手机端设置页", visual: "true", result: "各个页面都截了", img: [{ src: phone, cap: "首页" }, ...more.map((src, i) => ({ src, cap: "第 " + (i + 2) + " 张" }))] }),
    done("f2", { title: "对齐页：交付进待验收要说明是不是视觉类", visual: "true", result: "各个页面都截了", img: [{ src: wide, cap: "首页" }, ...more.map((src, i) => ({ src, cap: "第 " + (i + 2) + " 张" }))] }),
  ],
  decisions: [], notes: [],
};

function serve() {
  const html = A.render(data), files = new Map([wide, side, mild, phone, ...more].map((f) => [f, fs.readFileSync(f)]));
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://x"), p = u.pathname;
    const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (p === "/alignment/p/vs") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(html); }
    if (p === "/alignment/p/vs/data") return json(200, { ...data, live: {} });
    if (p === "/alignment/p/vs/file") {
      const f = files.get(u.searchParams.get("path"));
      if (!f) return json(404, { ok: false, code: "file-missing", message: "文件不在了，可能被移走或删掉了", hint: "让负责的会话重新挂一次附件。" });
      res.writeHead(200, { "content-type": "image/png" }); return res.end(f);
    }
    if (p === "/alignment/health") return json(200, { ok: true, api: A.API_VERSION });
    if (p === "/alignment/todos") return json(200, { ok: true, api: 2, sessions: {}, activity: {} });
    if (p === "/alignment/fm") return json(200, { ok: true, page: "vs", fm: null, refresh: null });
    if (p === "/alignment/p/vs/log") { res.writeHead(204); return res.end(); }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, base: "http://127.0.0.1:" + server.address().port })));
}

/** now:页面里的「现在」(默认夹具那天)。标签行的时间按「是不是今天」决定带不带日期,不钉住的话测试结果随跑的日子变(2026-10-25 第二天起 575x700 变红)。 */
// 一个文件只起一个浏览器(2026-11-02 提速:原来 18 个用例各起一次 Chromium);每个用例仍是自己的 context(newPage 自带)。
let browserP = null;
after(async () => { if (browserP) await (await browserP).close(); });
async function open(t, viewport, hash, now = T) {
  const s = await serve();
  t.after(() => { s.server.closeAllConnections(); s.server.close(); });
  browserP ??= chromium.launch({ headless: true });
  const page = await (await browserP).newPage({ viewport, timezoneId: "Asia/Shanghai" });
  t.after(() => page.context().close());
  await page.clock.setFixedTime(new Date(now));
  page.setDefaultTimeout(5000);
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(s.base + "/alignment/p/vs#" + hash);
  return { page, errors };
}

/** 等布局落定:两帧(ResizeObserver 回调已跑)+ 有限次的动画 / 过渡都结束(进场动画;脉冲、转圈这类无限循环的不算),再两帧。代替固定的 450 / 150 ms。 */
const settle = (page) => page.evaluate(async () => {
  const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  await frames();
  await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
  await frames();
});

/** 大图在详情区里露出来的高度(不滚动)、详情区是否没滚过、大图在正文里的位置。 */
const heroBox = (page) => page.evaluate(() => {
  const rb = document.querySelector(".rbody").getBoundingClientRect(), im = document.querySelector(".shots .shot img").getBoundingClientRect();
  const bx = document.querySelector(".bodyx");
  return { shown: Math.min(im.bottom, rb.bottom) - Math.max(im.top, rb.top), top: im.top - rb.top, scrolled: document.querySelector(".rbody").scrollTop, first: bx.firstElementChild.className, w: im.width, rbw: rb.width };
});

for (const [label, viewport] of [["宽屏 1280", { width: 1280, height: 900 }], ["侧栏 575", { width: 575, height: 860 }]]) {
  test("视觉类待验收(" + label + "):截图在正文最上面、不用翻就能看到;其余缩略图第一屏也看得到,底部只留链接;点开看全图", { timeout: 60_000 }, async (t) => {
    const { page, errors } = await open(t, viewport, "r=v1");
    await page.waitForSelector(".shots .shot.ok");
    const b = await heroBox(page);
    assert.equal(b.first, "shots", "截图块是正文第一块");
    assert.equal(b.scrolled, 0);
    assert.ok(b.top < 160, "截图紧跟标题: " + JSON.stringify(b));
    assert.ok(b.shown >= 150, "不滚动就露出至少 150px: " + JSON.stringify(b));
    assert.ok(b.w <= b.rbw, "不超出详情栏");
    assert.equal(await page.textContent(".shots .shot figcaption"), "宽屏");
    assert.equal(await page.getAttribute(".shots .shot button.sf", "aria-label"), "看大图：宽屏");
    assert.deepEqual(await page.$$eval(".shots .srest .thumb img", (l) => l.map((x) => x.alt)), ["侧栏"]);
    // 其余截图第一屏就看得到:整张缩略图在悬浮按钮行上方、不用滚动
    const rest = await page.evaluate(() => { const th = document.querySelector(".shots .srest .thumb").getBoundingClientRect(), bt = document.querySelector(".rfoot .btn").getBoundingClientRect(), im = document.querySelector(".shots .shot .sf").getBoundingClientRect(); return { above: th.bottom <= bt.top, beside: th.left >= im.right, below: th.top >= im.bottom }; });
    assert.ok(rest.above, "缩略图整张露在按钮上方: " + JSON.stringify(rest));
    assert.ok(viewport.width >= 1000 ? rest.beside : rest.below, "宽屏放在大图右边、侧栏放在下面: " + JSON.stringify(rest));
    assert.equal(await page.$$eval(".att .thumb", (l) => l.length), 0, "图不在附件里重复");
    assert.equal(await page.textContent(".att .alink"), "…/notes/report.md", "不带标题的链接显示路径末两段");
    await page.click(".shots .shot button.sf");
    assert.ok((await page.getAttribute("#lbx img", "src")).endsWith(encodeURIComponent(wide)));
    await page.keyboard.press("Escape");
    assert.equal(errors.length, 0, errors.join("\n"));
  });
}

test("横图整张缩进大图框;竖图(高 > 宽)按原宽显示、从下面裁掉,裁掉时底边渐隐", { timeout: 60_000 }, async (t) => {
  const { page, errors } = await open(t, { width: 1280, height: 900 }, "r=v1");
  await page.waitForSelector(".shots .shot.ok");
  const fit = await page.$eval(".shots .shot", (b) => { const im = b.querySelector("img").getBoundingClientRect(), sf = b.querySelector(".sf").getBoundingClientRect(); return { tall: b.classList.contains("tall"), cut: b.classList.contains("cut"), ratio: im.width / im.height, inFrame: im.height <= sf.height + 0.5, hug: Math.abs(sf.width - im.width) <= 1 }; });
  assert.deepEqual([fit.tall, fit.cut, fit.inFrame, fit.hug], [false, false, true, true], JSON.stringify(fit));
  assert.ok(Math.abs(fit.ratio - 1.6) < 0.02, "整张、不变形: " + fit.ratio);
  await page.evaluate(() => { location.hash = "r=t1"; });
  await page.waitForSelector(".shots .shot.ok.tall");
  const crop = (sel) => page.$eval(sel, (b) => { const im = b.querySelector("img").getBoundingClientRect(), sf = b.querySelector(".sf").getBoundingClientRect(); return { w: Math.round(im.width), cropped: im.height > sf.height + 1, top: Math.abs(im.top - sf.top) < 1, fade: b.classList.contains("cut") && getComputedStyle(b.querySelector(".sf"), "::after").content !== "none" }; });
  assert.deepEqual(await crop(".shots .shot"), { w: 420, cropped: true, top: true, fade: true }, "裁掉了:底边渐隐");
  await page.evaluate(() => { location.hash = "r=m1"; });
  await page.waitForSelector(".shots .shot.ok.tall");
  assert.deepEqual(await crop(".shots .shot"), { w: 500, cropped: true, top: true, fade: true }, "高宽比 1.3 也按原宽显示,不按高度缩小");
  assert.equal(errors.length, 0, errors.join("\n"));
});

// 第二天打开(标签行的时间带日期,575 宽下折成两行)、标题折两行:截图区整块下移,大图框按实际位置压低,窄栏压到最低还放不下就把其余截图竖排到右边
const NEXT_DAY = T + 864e5;
const CROWD = [
  [{ width: 575, height: 860 }, T, "f1"], [{ width: 575, height: 700 }, T, "f1"], [{ width: 1280, height: 900 }, T, "f1"], [{ width: 1280, height: 640 }, T, "f1"],
  [{ width: 575, height: 860 }, NEXT_DAY, "f1"], [{ width: 575, height: 700 }, NEXT_DAY, "f1"], [{ width: 575, height: 640 }, NEXT_DAY, "f1"],
  [{ width: 575, height: 860 }, NEXT_DAY, "f2"], [{ width: 575, height: 700 }, NEXT_DAY, "f2"], [{ width: 1280, height: 640 }, NEXT_DAY, "f2"],
];
for (const [viewport, now, id] of CROWD) {
  const label = viewport.width + "x" + viewport.height + (now === T ? "" : ",第二天") + (id === "f2" ? ",长标题" : "");
  test("其余截图多了不排到按钮底下(" + label + "):大图仍在最上面;一行横向滚动或一列纵向滚动,不比大图框高", { timeout: 60_000 }, async (t) => {
    const { page, errors } = await open(t, viewport, "r=" + id, now);
    await page.waitForSelector(".shots .shot.ok");
    await settle(page); // 进场动画结束
    const g = await page.evaluate(() => {
      const sh = document.querySelector(".shots"), s = sh.querySelector(".srest"), r = s.getBoundingClientRect(), sf = sh.querySelector(".shot .sf").getBoundingClientRect();
      const btnTop = Math.min(...[...document.querySelectorAll(".rfoot .btn")].map((b) => b.getBoundingClientRect().top));
      const tops = [...s.querySelectorAll(".thumb")].map((x) => x.offsetTop);
      return { n: tops.length, oneRow: new Set(tops).size === 1, scrollsX: s.scrollWidth > s.clientWidth, scrollsY: s.scrollHeight > s.clientHeight, bottom: Math.max(r.bottom, sh.querySelector(".shot").getBoundingClientRect().bottom), btnTop, beside: r.left >= sf.right,
        line: btnTop - 12, full: [...s.querySelectorAll(".thumb")].filter((x) => { const b = x.getBoundingClientRect(); return b.top >= r.top - 0.5 && b.bottom <= r.bottom + 0.5; }).length,
        room: [...s.querySelectorAll(".thumb")].filter((x) => x.getBoundingClientRect().bottom <= btnTop - 12 + 0.5).length,
        first: document.querySelector(".bodyx").firstElementChild === sh, side: sh.classList.contains("side"), frameH: sf.height, scrolled: document.querySelector(".rbody").scrollTop, taller: s.getBoundingClientRect().height > sf.height + 8.5 };
    });
    assert.equal(g.n, 4);
    assert.ok(g.first, "截图块仍是正文第一块");
    assert.equal(g.scrolled, 0);
    assert.ok(g.frameH >= 95.5, "大图框不小于 96: " + JSON.stringify(g));
    assert.ok(g.bottom <= g.btnTop + 0.5, "截图区在按钮行上方: " + JSON.stringify(g));
    if (g.side) assert.ok(!g.scrollsX && g.room >= 1 && g.full >= g.room, "窄栏竖排:一列放到按钮线,按钮线以上放得下的缩略图都整张露出: " + JSON.stringify(g));
    else if (g.beside) assert.ok(g.scrollsY && !g.scrollsX && !g.taller, "宽栏:一列在大图右边、纵向滚动、不比大图框高: " + JSON.stringify(g));
    else assert.ok(g.oneRow && g.scrollsX, "在大图下面:一行、横向滚动: " + JSON.stringify(g));
    if (viewport.width >= 1000) assert.ok(g.beside, "宽栏:在大图右边: " + JSON.stringify(g));
    assert.equal(errors.length, 0, errors.join("\n"));
  });
}

for (const id of ["f1", "f3"]) test("窄栏、第二天(" + (id === "f3" ? "首张竖图" : "首张横图") + "):窗口一点点变高时大图不会变小(一行要压低时和竖排比,取大图显示得更大的),截图区一直在按钮上方", { timeout: 60_000 }, async (t) => {
  const { page, errors } = await open(t, { width: 575, height: 640 }, "r=" + id, NEXT_DAY);
  await page.waitForSelector(".shots .shot.ok");
  await settle(page);
  const seen = [];
  for (const h of [640, 680, 700, 720, 740, 760, 800, 860]) {
    await page.setViewportSize({ width: 575, height: h });
    await settle(page);
    seen.push(await page.evaluate((h) => { const sh = document.querySelector(".shots"), sf = sh.querySelector(".shot .sf").getBoundingClientRect(), im = sh.querySelector(".shot img"); return { h, frame: Math.round(sf.height), scale: +(im.getBoundingClientRect().width / im.naturalWidth).toFixed(3), side: sh.classList.contains("side"), bottom: Math.max(...[sh, ...sh.children].map((e) => e.getBoundingClientRect().bottom)), btn: Math.min(...[...document.querySelectorAll(".rfoot .btn")].map((b) => b.getBoundingClientRect().top)) }; }, h));
  }
  // 横图:框高不变小;竖图:显示倍数不变小(竖图的框高按裁切走,不代表图多大)
  for (let i = 1; i < seen.length; i++) assert.ok(id === "f3" ? seen[i].scale >= seen[i - 1].scale - 0.005 : seen[i].frame >= seen[i - 1].frame, "大图不变小: " + JSON.stringify(seen));
  for (const x of seen) assert.ok(x.bottom <= x.btn + 0.5, "在按钮上方: " + JSON.stringify(x));
  assert.equal(errors.length, 0, errors.join("\n"));
});

test("窄栏、第二天、首张是竖图:一行和竖排按图显示的大小比,不按框高(竖排的窄框能更高,图却缩到一半以下)", { timeout: 60_000 }, async (t) => {
  const { page, errors } = await open(t, { width: 575, height: 900 }, "r=f3", NEXT_DAY);
  await page.waitForSelector(".shots .shot.ok.tall");
  await settle(page);
  const g = await page.evaluate(() => { const sh = document.querySelector(".shots"), im = sh.querySelector(".shot img"), b = im.getBoundingClientRect(); return { side: sh.classList.contains("side"), scale: b.width / im.naturalWidth, bottom: Math.max(...[sh, ...sh.children].map((e) => e.getBoundingClientRect().bottom)), btn: Math.min(...[...document.querySelectorAll(".rfoot .btn")].map((x) => x.getBoundingClientRect().top)) }; });
  // 一行时图按原宽(400)显示;竖排时框只有约 180 宽,图缩到 0.45
  assert.ok(!g.side && g.scale > 0.8, "竖图首张:一行、按接近原宽显示: " + JSON.stringify(g));
  assert.ok(g.bottom <= g.btn + 0.5, "在按钮上方: " + JSON.stringify(g));
  assert.equal(errors.length, 0, errors.join("\n"));
});

test("非视觉类待验收不变:没有截图块,单栏时缩略图在数字卡后面;不带标题的链接照常显示", { timeout: 60_000 }, async (t) => {
  const { page, errors } = await open(t, { width: 1280, height: 900 }, "r=n1");
  await page.waitForSelector(".bB > .att .thumb");
  assert.equal(await page.$$eval(".shots", (l) => l.length), 0);
  assert.equal(await page.$eval(".bB > .att", (a) => a.previousElementSibling?.className + " | " + a.nextElementSibling?.className), "kpis | facts", "单栏:附件在数字卡后面、事实行前面");
  assert.equal(await page.textContent(".att .alink"), "…/notes/report.md");
  assert.equal(errors.length, 0, errors.join("\n"));
});

test("视觉类截图读不出来:大图位置写服务端给的原因(读屏读得到),重画不再请求", { timeout: 60_000 }, async (t) => {
  const { page, errors } = await open(t, { width: 1280, height: 900 }, "r=b1");
  await page.waitForSelector(".shots .shot.bad .imerr");
  assert.equal(await page.textContent(".shots .shot .imerr"), "文件不在了，可能被移走或删掉了让负责的会话重新挂一次附件。");
  assert.ok(await page.$eval(".shots .shot", (b) => !b.querySelector("img, button")), "没有破图,也没有点了没反应的按钮");
  assert.match(await page.locator(".shots").ariaSnapshot(), /文件不在了，可能被移走或删掉了/, "读屏读得到原因");
  // 重画(切走再切回)直接画原因,不再请求那张图
  await page.evaluate(() => { location.hash = "r=n1"; });
  await page.waitForSelector(".att .thumb");
  await page.evaluate(() => { location.hash = "r=b1"; });
  await page.waitForSelector(".shots .shot.bad .imerr");
  assert.equal(await page.$$eval(".shots img", (l) => l.length), 0);
  assert.equal(errors.length, 0, errors.join("\n"));
});

test("视觉类截图读不出来:出错的那一刻大图框就标为 .bad(不靠之后的重画),原因块不像可点的图框", { timeout: 60_000 }, async (t) => {
  // 上一条等的是 .shot.bad .imerr,之后的重画(shotsHtml 按 SHOT_BAD 画 bad)会补上 class,出错处理里不加 .bad 也绿。
  // 这里在 .imerr 插进大图框的那一刻(MutationObserver,出错处理同步代码刚跑完、还没有重画)记下 class 和计算样式。
  const { page, errors } = await open(t, { width: 1280, height: 900 }, "r=n1");
  await page.waitForSelector(".att .thumb");
  await page.evaluate(() => {
    window.__at = null;
    new MutationObserver((ms, ob) => {
      const e = document.querySelector(".shots .shot .imerr");
      if (!e || window.__at) return;
      const f = e.closest(".shot"), sf = e.closest(".sf"), cs = getComputedStyle(sf);
      window.__at = { cls: f.className, cursor: cs.cursor, bg: cs.backgroundColor };
      ob.disconnect();
    }).observe(document.body, { childList: true, subtree: true });
    location.hash = "r=b1";
  });
  await page.waitForFunction(() => window.__at);
  const at = await page.evaluate(() => window.__at);
  assert.match(at.cls, /\bbad\b/, "出错时大图框就有 .bad: " + JSON.stringify(at));
  assert.equal(at.cursor, "default", "原因块不显示放大镜光标(不是可点的图框): " + JSON.stringify(at));
  assert.equal(at.bg, "rgba(0, 0, 0, 0)", "原因块不带图框底色: " + JSON.stringify(at));
  assert.equal(errors.length, 0, errors.join("\n"));
});
