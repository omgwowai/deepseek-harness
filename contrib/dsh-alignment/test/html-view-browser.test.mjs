// 真浏览器回归（2026-11-02）：对齐页附件是本机 .html 时，详情区按网页显示（之前只显示源码）；看文档时详情区和泳道之间的分界能拖（之前高度被钉在 100vh - 168px）。
// - 网页放进不给脚本、不给同源的沙箱 iframe：脚本不跑、碰不到对齐页；相对路径的图片 / 样式表 / 样式表里的图片经 /file?doc= 取回内嵌，没引用的不去取；
//   #锚点在框里跳、不动对齐页的地址；取不回来的文件在网页上方写一句原因。
// - 分界：看文档时拖动（指针滑过 iframe 也跟手）、刷新后重开仍是那个高度；平时的详情区高度不受影响；双击恢复默认。
// 页面由 align.mjs render() 生成，本地 http 服务给页面、/data、/health、/file；依赖本机 playwright-core。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "align-html-view-"));
process.env.ALIGN_STORE = dir;
process.env.ALIGN_WORKSPACES = path.join(dir, "workspace.json");
const A = await import("../cli/align.mjs");
const { chromium } = createRequire((process.env.DSH_ALIGN_PW_DIR ? path.join(process.env.DSH_ALIGN_PW_DIR, "package.json") : import.meta.url))("playwright-core");
// 一个文件只起一个 Chromium,各用例自己开 context(隔离不变)
let browserP;
const getBrowser = () => (browserP ??= chromium.launch({ headless: true }));
test.after(async () => { if (browserP) await (await browserP.catch(() => null))?.close(); });

const HTML = "D:\\repo\\docs\\cmp\\compare.html", MD = "D:\\repo\\docs\\report.md";
const IMG = "D:\\repo\\docs\\cmp\\img\\a.png", CSS = "D:\\repo\\docs\\cmp\\css\\s.css", BG = "D:\\repo\\docs\\cmp\\img\\bg.png", GONE = "D:\\repo\\docs\\cmp\\img\\gone.png";
const page = [
  "<!doctype html><html><head><title>对照</title><link rel=stylesheet href='css/s.css'>",
  "<style>h1{color:rgb(1, 2, 3)}</style></head><body>",
  "<h1 id=top>此刻画面</h1><img id=a src='img/a.png' alt=a><img id=g src='img/gone.png' alt=g>",
  "<a id=jump href='#end'>跳到末尾</a> <a id=ext href='https://example.com/'>外链</a> <a id=loc href='other.html'>本机</a> <a id=lh href='http://127.0.0.1:3080/alignment/p/x'>本机服务</a>",
  "<img id=far src='https://example.invalid/leak.png'><svg><a id=sv xlink:href='http://127.0.0.1:3080/x'><text y=12>s</text></a><animate xlink:href='#sv' attributeName=href to='http://127.0.0.1:3080/y'/></svg>",
  "<div style='height:3000px'></div><h2 id=end>末尾</h2>",
  "<script>parent.__pwned = 1; document.title = 'ran'</script><img src='data:image/png;base64,AA' onerror='parent.__pwned=2'>",
  "</body></html>",
].join("");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const T = "2026-11-02T10:00:00+08:00";
const data = {
  version: 3, name: "hv", title: "网页", owner: "session-fm", updated: T, projects: [],
  rounds: [{ id: "r1", sid: "session-w1", title: "对照页", status: "doing", mode: "new", started: T, updated: T, state: "写了一个对照页。",
    link: [{ href: HTML, title: "对照页" }, { href: MD, title: "分析文档" }] }],
  decisions: [], notes: [],
};

function serve(api = A.API_VERSION) {
  const html = A.render(data), hits = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://x"), p = u.pathname;
    const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (p === "/alignment/p/hv") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(html); }
    if (p === "/alignment/p/hv/data") return json(200, { ...data, live: {} });
    if (p === "/alignment/health") return json(200, { ok: true, api });
    if (p.startsWith("/alignment/lib/")) { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(A.vendorFile(p.slice(15, -3))); }
    if (p === "/alignment/p/hv/file") {
      const f = u.searchParams.get("path"), via = u.searchParams.get("doc");
      hits.push(f + (via ? " via " + via : ""));
      if (f === HTML && !via) { res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }); return res.end(page); }
      if (f === MD && !via) { res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }); return res.end("# 报告\n\n正文。\n"); }
      if (via === HTML && (f === IMG || f === BG)) { res.writeHead(200, { "content-type": "image/png" }); return res.end(PNG); }
      if (via === HTML && f === CSS) { res.writeHead(200, { "content-type": "text/css" }); return res.end("body{margin:0;background:url('../img/bg.png') repeat-x} p{color:red}"); }
      if (via === HTML && f === GONE) return json(404, { ok: false, code: "file-missing", message: "图片文件不在了，可能被移走或删掉了", hint: "x" });
      return json(403, { ok: false, code: "not-attached", message: "不提供", hint: "x" });
    }
    if (p === "/alignment/todos") return json(200, { ok: true, api: 2, sessions: {}, activity: {} });
    if (p === "/alignment/fm") return json(200, { ok: true, page: "hv", fm: null, refresh: null });
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, hits, base: "http://127.0.0.1:" + server.address().port })));
}
async function open(t, api) {
  const s = await serve(api);
  t.after(() => { s.server.closeAllConnections(); s.server.close(); });
  const browser = await getBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  t.after(() => ctx.close());
  ctx.setDefaultTimeout(5000);
  const page = await ctx.newPage();
  const errors = [], popups = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  ctx.on("page", (p) => popups.push(p));
  await page.goto(s.base + "/alignment/p/hv#r=r1");
  await page.waitForSelector(".alink[data-act=doc]");
  return { page, hits: s.hits, errors, popups, url: s.base + "/alignment/p/hv#r=r1" };
}
const frameOf = async (page) => { const h = await page.waitForSelector("iframe.dvframe"); return h.contentFrame(); };
const detailH = (page) => page.$eval("#detail", (d) => Math.round(d.getBoundingClientRect().height));
// 高度过渡走完:连续 4 帧高度不变(不用固定等待)
const settle = async (page) => { let prev = -1, same = 0; while (same < 4) { const h = await detailH(page); same = h === prev ? same + 1 : 0; prev = h; await page.evaluate(() => new Promise((r) => requestAnimationFrame(r))); } };

test("网页附件：沙箱 iframe 里按网页显示，引用的图片和样式表加载出来，脚本不跑", { timeout: 60_000 }, async (t) => {
  const { page, hits, errors, popups } = await open(t);
  const outbound = [];
  // 外网请求被 CSP 当场取消（requestfailed 的原因是 csp）；只要有一个真的发出去拿到回应就算漏
  page.on("requestfinished", (r) => { if (!r.url().startsWith("http://127.0.0.1:") && !r.url().startsWith("data:")) outbound.push(r.url()); });
  const blocked = [];
  page.on("requestfailed", (r) => { if (r.failure()?.errorText === "csp") blocked.push(r.url()); });
  await page.click(".alink[data-act=doc] >> text=对照页");
  const f = await frameOf(page);
  await f.waitForSelector("h1");
  assert.equal(await page.getAttribute("iframe.dvframe", "sandbox"), "", "不给脚本、不给同源、不开新窗口");
  assert.equal(await f.textContent("h1"), "此刻画面");
  assert.equal(await f.$eval("h1", (h) => getComputedStyle(h).color), "rgb(1, 2, 3)", "内嵌样式生效");
  await f.waitForFunction(() => { const im = document.getElementById("a"); return im.complete && im.naturalWidth > 0; });
  assert.match(await f.getAttribute("#a", "src"), /^data:image\/png;base64,/, "相对路径的图片内嵌");
  assert.match(await f.$eval("body", (b) => getComputedStyle(b).backgroundImage), /data:image\/png/, "样式表里 url() 引用的图片也内嵌");
  assert.equal(await f.$$eval("script, link", (x) => x.length), 0, "脚本去掉、样式表换成内嵌");
  assert.deepEqual(hits.filter((h) => h.includes(" via ")).map((h) => h.split(" via ")[0]).sort(), [BG, CSS, GONE, IMG].sort(), "只取网页引用了的文件，每个一次");
  assert.ok(hits.filter((h) => h.includes(" via ")).every((h) => h.endsWith(" via " + HTML)), "都带 doc=那份网页");
  // 取不回来的文件：网页上方一句原因
  assert.match(await page.textContent(".dvmiss"), /1 个引用的文件没加载出来：图片文件不在了/);
  // 脚本、事件属性都不跑，对齐页不受影响
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__pwned), undefined);
  assert.notEqual(await page.title(), "ran");
  assert.equal(await page.evaluate(() => { try { return document.querySelector("iframe.dvframe").contentDocument; } catch (e) { return "blocked"; } }), null, "不同源：对齐页读不到框里的文档，框里也碰不到对齐页");
  // 锚点在框里跳，对齐页地址不变；本机链接不跳转、悬停看路径；外链新标签页
  const before = page.url();
  await f.click("#jump");
  await f.waitForFunction(() => scrollY > 1000);
  assert.equal(page.url(), before);
  assert.equal(await f.getAttribute("#loc", "href"), null);
  assert.equal(await f.getAttribute("#loc", "title"), "D:\\repo\\docs\\cmp\\other.html");
  assert.deepEqual(await f.$eval("#ext", (a) => [a.getAttribute("href"), a.title]), [null, "https://example.com/"], "外网链接也不跳转，悬停看地址");
  assert.deepEqual(await f.$eval("#lh", (a) => [a.getAttribute("href"), a.title]), [null, "http://127.0.0.1:3080/alignment/p/x"], "指向本机服务的链接去掉跳转");
  assert.deepEqual(await f.$eval("#sv", (a) => [a.getAttribute("href"), a.getAttributeNS("http://www.w3.org/1999/xlink", "href")]), [null, null], "SVG 链接同样去掉");
  assert.equal(await f.$$eval("animate", (x) => x.length), 0, "能改链接的 SVG 动画去掉");
  assert.deepEqual(outbound, [], "框里不向外网发请求");
  assert.deepEqual(blocked, ["https://example.invalid/leak.png"], "外网图片被 CSP 拦下");
  assert.deepEqual(popups, []);
  // 网页铺满右栏余下的高度，右栏自己不滚
  const fit = await page.evaluate(() => { const b = document.querySelector(".rbody"), fr = b.querySelector(".dvframe"); return { over: b.scrollHeight - b.clientHeight, bottom: Math.round(b.getBoundingClientRect().bottom - fr.getBoundingClientRect().bottom) }; });
  assert.ok(fit.over <= 1 && Math.abs(fit.bottom) <= 1, JSON.stringify(fit));
  // 返回：Esc（焦点在对齐页上时）回到原详情
  await page.focus(".dvback");
  await page.keyboard.press("Escape");
  await page.waitForSelector("iframe.dvframe", { state: "detached" });
  // Markdown 附件照旧排版，不进 iframe
  await page.click(".alink[data-act=doc] >> text=分析文档");
  await page.waitForSelector(".md h1");
  assert.equal(await page.$("iframe.dvframe"), null);
  assert.deepEqual(errors, []);
});

test("服务端还是旧版（api 17，重启前的 3080）：照样显示网页，不去取引用的文件，提示一句", { timeout: 60_000 }, async (t) => {
  const { page, hits, errors } = await open(t, 17);
  await page.waitForTimeout(300); // 等 /health 回来
  await page.click(".alink[data-act=doc] >> text=对照页");
  const f = await frameOf(page);
  assert.equal(await f.textContent("h1"), "此刻画面");
  assert.equal(hits.filter((h) => h.includes(" via ")).length, 0, "不发注定 400 的请求");
  assert.equal(await page.textContent(".dvmiss"), "网页里引用的图片和样式要等 DSH 重启后才显示");
  assert.deepEqual(errors, []);
});

test("看文档时分界能拖（指针滑过网页也跟手），刷新后保持；平时的高度不变；双击恢复", { timeout: 60_000 }, async (t) => {
  const { page, errors, url } = await open(t);
  const normal = await detailH(page);
  await page.click(".alink[data-act=doc] >> text=对照页");
  await (await frameOf(page)).waitForSelector("h1");
  await settle(page); // 详情区加高的过渡
  const tall = await detailH(page);
  assert.ok(tall > normal + 100, "看文档时加高：" + normal + " → " + tall);
  // 分界上是分隔条自己（没被别的层挡住）
  const s = await page.$eval("#hsplit", (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 3 }; });
  assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y).id, s), "hsplit");
  // 往上拖 300：中途指针一直在 iframe 上方
  await page.mouse.move(s.x, s.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(s.x, s.y - 30 * i);
  await page.mouse.up();
  await settle(page);
  const dragged = await detailH(page);
  assert.ok(Math.abs(dragged - (tall - 300)) <= 2, "拖动跟手：" + tall + " → " + dragged);
  assert.equal(await page.getAttribute("#hsplit", "aria-valuenow"), String(Math.round((dragged / (860 - 46)) * 100)));
  // 刷新后重开：还是那个高度；平时的详情区高度不变
  await page.goto(url);
  await page.reload();
  await page.waitForSelector(".alink[data-act=doc]");
  assert.equal(await detailH(page), normal, "平时的高度不受看文档时拖动的影响");
  await page.click(".alink[data-act=doc] >> text=对照页");
  await (await frameOf(page)).waitForSelector("h1");
  await settle(page);
  assert.ok(Math.abs((await detailH(page)) - dragged) <= 1, "刷新后保持");
  // 键盘：↓ 加高 16
  await page.focus("#hsplit");
  await page.keyboard.press("ArrowDown");
  assert.ok(Math.abs((await detailH(page)) - (dragged + 16)) <= 1);
  // 双击恢复看文档时的默认高度，平时的不动
  await page.mouse.dblclick(s.x, (await page.$eval("#hsplit", (e) => e.getBoundingClientRect().top)) + 3); // 0 高的网格轨道，按坐标点
  await settle(page);
  assert.ok(Math.abs((await detailH(page)) - tall) <= 1, "双击恢复默认");
  assert.equal(await page.evaluate(() => localStorage.getItem("align-split:hv")), null);
  assert.deepEqual(errors, []);
});
