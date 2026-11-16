// 真浏览器回归(2026-10-24):对齐页附件文档在详情区里看。
// - 点 .md 附件不开新标签页,右栏换成排版好的文档:标题、列表、表格、代码块、图片、链接;返回(按钮 / Esc)回到原详情和原滚动位置;
// - 小节 >= 2 个时有目录:宽屏右侧常驻,420 宽收进「目录」按钮;点目录跳到小节;
// - 安全:文档里的 <script>、事件属性、javascript: 链接都不执行,原始 HTML 按文字显示;外链新标签页打开;
// - 打不开时(服务端回 {message, hint})在详情区写原因、下一步和路径,不跳 JSON;txt / json 按等宽显示。
// 页面由 align.mjs render() 生成,本地 http 服务给页面、/data、/health、/file、/lib;依赖本机 playwright-core。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "align-doc-view-"));
process.env.ALIGN_STORE = dir;
process.env.ALIGN_WORKSPACES = path.join(dir, "workspace.json");
const A = await import("../cli/align.mjs");
const { chromium } = createRequire((process.env.DSH_ALIGN_PW_DIR ? path.join(process.env.DSH_ALIGN_PW_DIR, "package.json") : import.meta.url))("playwright-core");
// 一个文件只起一个 Chromium,各用例自己开 context(隔离不变)
let browserP;
const getBrowser = () => (browserP ??= chromium.launch({ headless: true }));
test.after(async () => { if (browserP) await (await browserP.catch(() => null))?.close(); });

const DOC = "D:\\repo\\docs\\report.md", TXT = "D:\\repo\\run.log", JSN = "D:\\repo\\out.json", BAD = "D:\\other\\secret-ish.md";
const BT = "\x60";
const md = [
  "# 报告标题", "", "开头一段,含 **粗体** 和 " + BT + "代码" + BT + "。", "",
  "## 结论", "", "- 第一条", "- 第二条", "", "1. 有序一", "2. 有序二", "",
  "| 指标 | 值 |", "|---|--:|", "| 召回 | 0.89 |", "",
  BT + BT + BT + "js", "const x = 1;", BT + BT + BT, "",
  "![示意图](img/fig.png)", "",
  "[外链](https://example.com/x) · [跳到附录](#附录) · [坏链接](javascript:window.__pwned=1) · [本地文件](../notes.md)", "",
  "<script>window.__pwned = 2</script>", "",
  '<img src="x" onerror="window.__pwned=3">', "",
  "## 附录", "", "### 细节", "", ...Array.from({ length: 60 }, (_, i) => "第 " + i + " 行填充文字,让文档足够长。"),
  "", ...Array.from({ length: 40 }, (_, i) => ["### 小节 " + i, "", "这一节的文字。".repeat(12), ""]).flat(),
].join("\n");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const T = "2026-10-24T10:00:00+08:00";
const facts = Array.from({ length: 40 }, (_, i) => "第 " + i + " 句现状。").join("");
const data = {
  version: 3, name: "dv", title: "文档", owner: "session-fm", updated: T, projects: [],
  rounds: [{ id: "r1", sid: "session-w1", title: "写了一份分析", status: "doing", mode: "new", started: T, updated: T, state: facts,
    link: [{ href: DOC, title: "分析文档" }, { href: TXT, title: "运行日志" }, { href: JSN, title: "结果" }, { href: BAD, title: "别处的文档" }, { href: "https://example.com/page", title: "网页" }] }],
  decisions: [], notes: [],
};

function serve() {
  const html = A.render(data), hits = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://x"), p = u.pathname;
    const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (p === "/alignment/p/dv") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(html); }
    if (p === "/alignment/p/dv/data") return json(200, { ...data, live: {} });
    if (p === "/alignment/health") return json(200, { ok: true, api: A.API_VERSION });
    if (p.startsWith("/alignment/lib/")) { hits.push("lib " + p.slice(15)); res.writeHead(200, { "content-type": "text/javascript" }); return res.end(A.vendorFile(p.slice(15, -3))); }
    if (p === "/alignment/p/dv/file") {
      const f = u.searchParams.get("path"), via = u.searchParams.get("doc");
      hits.push("file " + f + (via ? " via " + via : ""));
      const text = (b) => { res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }); res.end(b); };
      if (via === DOC && f === "D:\\repo\\docs\\img\\fig.png") { res.writeHead(200, { "content-type": "image/png" }); return res.end(PNG); }
      if (f === DOC) return text(md);
      if (f === TXT) return text("第一行\n    缩进的第二行");
      if (f === JSN) return text('{"a":1,"b":[1,2]}');
      if (f === BAD) return json(403, { ok: false, code: "outside-roots", message: "这个文件在 other 仓库里,负责的会话没用过这个仓库,对齐页没权限读", hint: "复制路径后在本机打开。" });
      return json(404, { ok: false, message: "没有" });
    }
    if (p === "/alignment/todos") return json(200, { ok: true, api: 2, sessions: {}, activity: {} });
    if (p === "/alignment/fm") return json(200, { ok: true, page: "dv", fm: null, refresh: null });
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, hits, base: "http://127.0.0.1:" + server.address().port })));
}
async function open(t, width) {
  const s = await serve();
  t.after(() => { s.server.closeAllConnections(); s.server.close(); });
  const browser = await getBrowser();
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  const errors = [], popups = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  ctx.on("page", (p) => popups.push(p.url()));
  page.on("dialog", (d) => { errors.push("dialog " + d.message()); d.dismiss(); });
  await page.goto(s.base + "/alignment/p/dv#r=r1");
  await page.waitForSelector(".alink[data-act=doc]");
  return { page, hits: s.hits, errors, popups };
}

test("宽屏：在详情区排版文档、目录常驻、脚本不执行、返回回到原处", { timeout: 60_000 }, async (t) => {
  const { page, hits, errors, popups } = await open(t, 1280);
  // 先把详情往下滚一段（附件单栏时在数字卡后面，链接仍露在上面）：点击时的位置就是返回后要回到的位置
  await page.$eval(".rbody", (b) => { b.scrollTop = 120; });
  await page.waitForFunction(() => document.querySelector(".rbody").scrollTop > 0);
  const before = await page.$eval(".rbody", (b) => b.scrollTop);
  assert.ok(before > 0, "原详情滚动过");
  await page.click(".alink[data-act=doc] >> text=分析文档");
  await page.waitForSelector(".md h1");
  assert.deepEqual(popups, [], "不开新标签页");
  assert.equal(await page.textContent(".md h1"), "报告标题");
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), "H1", "打开后焦点在文档标题");
  assert.equal(await page.textContent(".dvt b"), "分析文档");
  assert.equal(await page.$$eval(".md ul li", (l) => l.length), 2);
  assert.equal(await page.$$eval(".md ol li", (l) => l.length), 2);
  assert.deepEqual(await page.$$eval(".md table td", (c) => c.map((x) => x.textContent)), ["召回", "0.89"]);
  assert.equal(await page.textContent(".md pre code"), "const x = 1;\n");
  await page.waitForFunction(() => { const im = document.querySelector(".md img"); return im && im.complete && im.naturalWidth > 0; });
  const ext = await page.$eval('.md a[href^="https://example.com"]', (a) => [a.target, a.rel]);
  assert.deepEqual(ext, ["_blank", "noopener noreferrer"]);
  assert.equal(await page.$('.md a[href^="javascript"]'), null, "javascript: 链接被去掉");
  assert.equal(await page.getAttribute(".md .tk[data-act=copy]", "data-copy"), "D:\\repo\\notes.md", "本地文件链接改成复制路径");
  assert.match(await page.textContent(".md"), /<script>window.__pwned = 2<\/script>/, "原始 HTML 按文字显示");
  assert.equal(await page.$$eval(".md script, .md [onerror]", (x) => x.length), 0);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__pwned), undefined, "文档里的脚本没执行");
  // 目录：宽屏右侧常驻，「目录」按钮隐藏；点目录跳到小节，正文里的站内锚点也能跳
  assert.deepEqual(await page.$$eval(".dvrail a", (a) => a.slice(0, 3).map((x) => x.textContent)), ["结论", "附录", "细节"]);
  assert.ok(await page.$eval(".dvrail", (r) => r.scrollHeight > r.clientHeight), "目录比目录栏高（要跟着滚）");
  assert.equal(await page.$eval(".dvtg", (b) => getComputedStyle(b).display), "none");
  await page.click(".dvrail a >> text=附录");
  await page.waitForFunction(() => { const h = [...document.querySelectorAll(".md h2")].find((x) => x.textContent === "附录"); const b = document.querySelector(".rbody").getBoundingClientRect(); return h && Math.abs(h.getBoundingClientRect().top - b.top - 60) < 30; });
  await page.waitForFunction(() => document.querySelector(".dvrail a.on")?.textContent === "附录");
  await page.$eval(".rbody", (b) => { b.scrollTop = 0; });
  await page.click(".md a[data-act=docgo]");
  await page.waitForFunction(() => document.querySelector(".dvrail a.on")?.textContent === "附录");
  // 只取一次：库各一次、文档一次（轮询重画不再取）
  await page.waitForResponse((r) => r.url().endsWith("/alignment/p/dv/data"), { timeout: 15_000 }); // 等一次 4 s 轮询取过数据
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); // 重画完
  assert.deepEqual(hits.filter((h) => h === "file " + DOC || h.startsWith("lib ")).sort(), ["file " + DOC, "lib marked.js", "lib purify.js"]);
  assert.ok(await page.$(".md h2"), "轮询之后文档还在");
  // 跳过小节后焦点在那个小节标题；能横向滚的表格才可聚焦（这张不用滚）；复制路径有反馈
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "附录");
  assert.equal(await page.getAttribute(".dvtbl", "tabindex"), null);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.click(".dvcp");
  await page.waitForFunction(() => document.querySelector(".dvcp .lbl")?.textContent === "已复制");
  // 目录栏跟着高亮滚：滚到底时高亮项在目录栏可视区里
  await page.$eval(".rbody", (b) => { b.scrollTop = b.scrollHeight; });
  await page.waitForFunction(() => { const r = document.querySelector(".dvrail"), a = r.querySelector("a.on"); if (!a || a.textContent !== "小节 39" || r.scrollTop === 0) return false; const x = a.getBoundingClientRect(), y = r.getBoundingClientRect(); return x.top >= y.top && x.bottom <= y.bottom; });
  // 中途也可见
  await page.$eval(".rbody", (b) => { const h = [...document.querySelectorAll(".md h3")].find((x) => x.textContent === "小节 20"); b.scrollTop = h.offsetTop - 10; });
  await page.waitForFunction(() => { const r = document.querySelector(".dvrail"), a = r.querySelector("a.on"); if (!a || !/小节 (19|20)/.test(a.textContent)) return false; const x = a.getBoundingClientRect(), y = r.getBoundingClientRect(); return x.top >= y.top && x.bottom <= y.bottom; });
  // 返回：Esc 回到原详情、原滚动位置，焦点回到附件
  await page.keyboard.press("Escape");
  await page.waitForSelector(".md", { state: "detached" });
  assert.equal(await page.$eval(".rbody", (b) => b.scrollTop), before);
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "分析文档");
  assert.deepEqual(errors, []);
});

test("420 宽：目录收进按钮、点了跳小节；按钮返回", { timeout: 60_000 }, async (t) => {
  const { page, errors } = await open(t, 420);
  await page.click(".alink[data-act=doc] >> text=分析文档");
  await page.waitForSelector(".md h1");
  assert.equal(await page.$eval(".dvrail", (n) => getComputedStyle(n).display), "none");
  const overflow = await page.$eval(".rbody", (b) => b.scrollWidth - b.clientWidth);
  assert.ok(overflow <= 1, "正文不横向溢出: " + overflow);
  await page.click(".dvtg");
  assert.equal(await page.getAttribute(".dvtg", "aria-expanded"), "true");
  await page.click(".dvmenu a >> text=细节");
  assert.equal(await page.isHidden(".dvmenu"), true);
  await page.waitForFunction(() => { const h = document.querySelector(".md h3"); const b = document.querySelector(".rbody").getBoundingClientRect(); return h && Math.abs(h.getBoundingClientRect().top - b.top - 60) < 30; });
  await page.click(".dvback");
  await page.waitForSelector(".alink[data-act=doc]");
  // 浏览器后退关掉文档，不离开对齐页
  await page.click(".alink[data-act=doc] >> text=分析文档");
  await page.waitForSelector(".md h1");
  await page.goBack();
  await page.waitForSelector(".md", { state: "detached" });
  assert.match(page.url(), /\/alignment\/p\/dv/);
  // 连点两下「返回」也不离开对齐页
  await page.click(".alink[data-act=doc] >> text=分析文档");
  await page.waitForSelector(".md h1");
  await page.dblclick(".dvback");
  await page.waitForTimeout(400);
  assert.match(page.url(), /\/alignment\/p\/dv/);
  assert.ok(await page.$(".alink[data-act=doc]"));
  assert.deepEqual(errors, []);
});

test("打不开时写原因和下一步；txt / json 等宽显示；网页链接照旧新标签页", { timeout: 60_000 }, async (t) => {
  const { page, errors } = await open(t, 1280);
  await page.click(".alink[data-act=doc] >> text=别处的文档");
  await page.waitForSelector(".dverr");
  assert.equal(await page.textContent(".dverr .h"), "这个文件在 other 仓库里,负责的会话没用过这个仓库,对齐页没权限读");
  assert.equal(await page.textContent(".dverr p"), "复制路径后在本机打开。");
  assert.equal(await page.textContent(".dverr code"), BAD);
  assert.equal(await page.getAttribute(".dverr .cp", "data-copy"), BAD);
  assert.doesNotMatch(await page.textContent(".rbody"), /"ok"|\{/, "不显示 JSON");
  await page.click(".dvback");
  await page.click(".alink[data-act=doc] >> text=运行日志");
  await page.waitForSelector(".dvtext");
  assert.equal(await page.textContent(".dvtext"), "第一行\n    缩进的第二行");
  assert.match(await page.$eval(".dvtext", (e) => getComputedStyle(e).fontFamily), /Cascadia Mono|Consolas|monospace/);
  await page.click(".dvback");
  await page.click(".alink[data-act=doc] >> text=结果");
  await page.waitForSelector(".dvtext");
  assert.equal(await page.textContent(".dvtext"), '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
  await page.click(".dvback");
  assert.deepEqual(await page.$eval('a.alink[href="https://example.com/page"]', (a) => [a.target, a.rel]), ["_blank", "noopener"]);
  assert.deepEqual(errors, []);
});
