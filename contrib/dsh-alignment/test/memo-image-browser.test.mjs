// 真浏览器回归(2026-10-24):对齐页留言框粘贴 / 拖入图片(api 14)。
// 粘贴图片 → 立刻传到 POST /image(存进 ALIGN_STORE/memo-images/<日期>/)→ 留言框最上面一排 64px 缩略图;删除键;
// 超限(不是图片、超过 20 MB、超过 5 张)给一句话;上传失败标红、点图重试、发送条拦住;点缩略图看大图,Esc 只关大图;
// 发送条列表的留言行写「N 张图」;刷新后缩略图还在(草稿存本机路径,从 /file 取回);发送后消息里逐行是本机路径。
// 服务端用真实的 align.mjs createHandler(临时 ALIGN_STORE),页面是 align init 出来的版本 3 页面。
// 依赖插件 devDependencies 里的 playwright-core（DSH_ALIGN_PW_DIR 覆盖）,缺失即失败。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "align-memo-img-"));
process.env.ALIGN_STORE = dir;
process.env.ALIGN_WORKSPACES = path.join(dir, "workspace.json");
fs.writeFileSync(process.env.ALIGN_WORKSPACES, JSON.stringify({ workspaces: [] }));
const A = await import("../cli/align.mjs");
const { chromium } = createRequire((process.env.DSH_ALIGN_PW_DIR ? path.join(process.env.DSH_ALIGN_PW_DIR, "package.json") : import.meta.url))("playwright-core");

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==";
const png = (i) => ({ name: "p" + i + ".png", type: "image/png", b64: PNG, tail: i }); // 末尾多一个字节:内容不同,不会按内容合并

async function open(t) {
  await A.main(["init", path.join(dir, "bt.html"), "--name", "bt", "--title", "留言图片测试页", "--owner", "session-fm", "--version", "3"]);
  const sent = [];
  const handler = A.createHandler({ prefix: "/alignment", send: async (sid, prompt, card) => { sent.push({ sid, prompt, card }); }, guard: () => null, live: async (sids) => Object.fromEntries(sids.map((s) => [s, "idle"])) });
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.setDefaultTimeout(5000);
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  const url = "http://127.0.0.1:" + server.address().port + "/alignment/p/bt";
  await page.goto(url);
  await page.waitForSelector("#mbtn");
  return { page, sent, errors, url };
}
/** 往留言框里粘贴文件(剪贴板里没有文字) */
const paste = (page, specs) => page.evaluate((specs) => {
  const dt = new DataTransfer();
  for (const s of specs) {
    const head = s.b64 ? Uint8Array.from(atob(s.b64), (c) => c.charCodeAt(0)) : new Uint8Array(s.size || 4);
    const bin = s.tail === undefined ? head : new Uint8Array([...head, s.tail]);
    dt.items.add(new File([s.size > 1000 ? new Uint8Array(s.size) : bin], s.name, { type: s.type }));
  }
  const el = document.getElementById("memo-in"); el.focus();
  el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
}, specs);
const shots = (page) => page.$$eval("#mims .mim", (els) => els.map((e) => ({ cls: e.className, w: e.querySelector("img").naturalWidth })));
const note = (page) => page.$eval("#mnote", (e) => e.textContent);
/** 打开留言框（开没开是存在本机的，刷新后可能已经开着） */
const openMemo = async (page) => { if (await page.$eval("#mwrap", (e) => e.hidden)) await page.click("#mbtn"); };
const waitUploaded = (page, n) => page.waitForFunction((n) => { const m = document.querySelectorAll("#mims .mim"); return m.length === n && [...m].every((e) => !e.classList.contains("up") && e.querySelector("img").naturalWidth > 0); }, n);

test("留言图片:粘贴即上传成缩略图、超限提示、删除、失败重试、看大图、列表写 N 张图、刷新还在、发出去带本机路径", { timeout: 90_000 }, async (t) => {
  const { page, sent, errors, url } = await open(t);
  await page.click("#mbtn");
  await page.keyboard.type("看看这几张");
  // 粘贴一张:缩略图在留言框最上面(输入区前面),64 见方
  await paste(page, [png(1)]);
  await waitUploaded(page, 1);
  const box = await page.evaluate(() => { const m = document.getElementById("memo"), s = document.getElementById("mims"), r = s.querySelector(".mim"); return { first: m.firstElementChild.id, before: !!(s.compareDocumentPosition(document.getElementById("memo-in")) & Node.DOCUMENT_POSITION_FOLLOWING), w: r.offsetWidth, h: r.offsetHeight }; }); // 布局尺寸（进场动画的 scale 不算）
  assert.deepEqual(box, { first: "mims", before: true, w: 64, h: 64 });
  const day = A.nowIso().slice(0, 10);
  assert.equal(fs.readdirSync(path.join(dir, "memo-images", day)).length, 1, "传到了 memo-images/<日期>/");
  // 超限:太大、不是图片,各给一句话,不加进来
  await paste(page, [{ name: "big.png", type: "image/png", size: A.MEMO_IMAGE_BYTES + 1 }]);
  assert.equal(await note(page), "图片超过 20 MB，没加上");
  await paste(page, [{ name: "a.pdf", type: "application/pdf", size: 10 }]);
  assert.equal(await note(page), "仅支持 PNG、JPG、WebP、GIF 格式的图片");
  // 声明是 png、内容不是图片：服务端按文件头拒(400),页面直接拿掉这张、说原因(不标红让重试)
  await page.evaluate(() => { const dt = new DataTransfer(); dt.items.add(new File([new TextEncoder().encode("not a png")], "fake.png", { type: "image/png" })); document.getElementById("memo-in").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); });
  await page.waitForFunction(() => document.getElementById("mnote").textContent === "仅支持 PNG、JPG、WebP、GIF 格式的图片" && document.querySelectorAll("#mims .mim").length === 1);
  assert.equal(await page.$("#mims .mim.bad"), null);
  // 一次粘 6 张:只收到 5 张为止
  await paste(page, [2, 3, 4, 5, 6, 7].map(png));
  assert.equal(await note(page), "一条留言最多 5 张图片，多出的 2 张没加上");
  await waitUploaded(page, 5);
  // 删除:点第一张的删除键
  await page.hover("#mims .mim:nth-child(1)");
  await page.click("#mims .mim:nth-child(1) .mdel");
  await waitUploaded(page, 4);
  // 上传失败:标红、发送条拦住;点图片重试成功
  await page.click("#mims .mim:nth-child(1) .mdel");
  await waitUploaded(page, 3);
  await page.route("**/alignment/p/bt/image", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, message: "磁盘满了" }) }));
  await paste(page, [png(8)]);
  await page.waitForSelector("#mims .mim.bad");
  assert.equal(await note(page), "图片上传失败：磁盘满了，点图片重试");
  assert.equal(await page.$eval(".sendbar .blockmsg", (e) => e.textContent), "有图片没传上，重试或移除");
  assert.equal(await page.$eval(".send", (e) => e.disabled), true);
  await page.unroute("**/alignment/p/bt/image");
  await page.click("#mims .mim.bad .mimg");
  await waitUploaded(page, 4);
  assert.equal(await page.$(".sendbar .blockmsg"), null);
  // 看大图:点缩略图开灯箱,焦点在关闭键;Esc 只关灯箱,留言框还开着,焦点回到缩略图
  await page.click("#mims .mim:nth-child(2) .mimg");
  await page.waitForSelector("#lbx img");
  assert.match(await page.$eval("#lbx img", (e) => e.getAttribute("src")), /^blob:/);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.act), "lbclose");
  await page.keyboard.press("Escape");
  assert.equal(await page.$("#lbx"), null);
  assert.equal(await page.$eval("#mwrap", (e) => e.hidden), false, "留言框没被 Esc 收起");
  assert.equal(await page.evaluate(() => document.activeElement.closest(".mim") === document.querySelector("#mims .mim:nth-child(2)")), true);
  // 发送条列表:留言行写「4 张图」
  await page.click(".sendbar .tog");
  assert.equal(await page.$eval("#queue .memo-row .qt", (e) => e.textContent), "看看这几张");
  assert.equal(await page.$eval("#queue .memo-row .qv", (e) => e.textContent), "4 张图");
  // 刷新:缩略图从 /file 取回,还是 4 张
  await page.reload();
  await openMemo(page);
  await waitUploaded(page, 4);
  assert.ok((await shots(page)).every((s) => s.w === 1 && !/bad/.test(s.cls)));
  assert.match(await page.$eval("#mims .mim img", (e) => e.getAttribute("src")), /\/alignment\/p\/bt\/file\?path=/);
  // 刷新后取不回来（文件被删了）：那张标红、发送条拦住；移除它就照常
  const draft = await page.evaluate(() => JSON.parse(localStorage.getItem("align-picks:bt"))["m:"].images);
  fs.unlinkSync(draft[0]);
  await page.reload();
  await openMemo(page);
  await page.waitForSelector("#mims .mim.bad");
  assert.equal(await page.$eval("#mims .mim.bad .mimg", (e) => e.getAttribute("aria-label")), "图片 1 取不回来，点图片重试");
  assert.equal(await page.$eval(".sendbar .blockmsg", (e) => e.textContent), "有图片没传上，重试或移除");
  await page.hover("#mims .mim.bad");
  await page.click("#mims .mim.bad .mdel");
  await waitUploaded(page, 3);
  assert.equal(await page.$(".sendbar .blockmsg"), null);
  // 拖文件:框开着时拖到框上,框描 DSH 蓝 2px(不是拖进窗口时的浅蓝);框没开时拖到留言按钮上同样,松手收进来并打开留言框
  const drag = (sel, types) => page.evaluate(({ sel, types, b64 }) => {
    const dt = new DataTransfer(); dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), new Uint8Array([99])], "d.png", { type: "image/png" }));
    const el = document.querySelector(sel);
    for (const type of types) el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, { sel, types, b64: PNG });
  const ring = (sel) => page.$eval(sel, (e) => { const s = getComputedStyle(e); return s.outlineColor + " " + s.outlineWidth; });
  await drag("#memo", ["dragenter", "dragover"]);
  assert.equal(await ring("#memo"), "rgb(47, 98, 214) 2px", "拖到留言框上:DSH 蓝");
  await drag("#memo", ["dragleave"]);
  assert.equal(await page.$eval("#dock", (e) => e.classList.contains("fdrag")), false);
  await page.click("#mbtn");
  assert.equal(await page.$eval("#mwrap", (e) => e.hidden), true);
  await drag("#mbtn", ["dragenter"]);
  assert.match(await ring("#mbtn"), /^rgb\(197, 212, 245\) 1(\.5)?px$/, "拖进窗口:留言按钮描浅蓝(1x 屏上 1.5px 取整成 1px)");
  await drag("#mbtn", ["dragover"]);
  assert.equal(await ring("#mbtn"), "rgb(47, 98, 214) 2px", "拖到留言按钮上:DSH 蓝");
  await drag("#mbtn", ["drop"]);
  assert.equal(await page.$eval("#mwrap", (e) => e.hidden), false, "松手后打开留言框");
  await waitUploaded(page, 4);
  // 发送:消息里逐行是本机路径,发完缩略图和草稿都清掉
  const paths = await page.evaluate((url) => JSON.parse(localStorage.getItem("align-picks:bt"))["m:"].images, url);
  assert.equal(paths.length, 4);
  for (const p of paths) assert.ok(fs.existsSync(p) && path.basename(path.dirname(p)) === day, p);
  await page.click(".send");
  await page.waitForSelector(".toast.ok");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sid, "session-fm");
  assert.ok(sent[0].prompt.includes("1. 用户留言：看看这几张\n   附图 4 张（本机路径，用 read_image 看）：\n" + paths.map((p) => "   " + p).join("\n")), sent[0].prompt);
  assert.equal((await shots(page)).length, 0);
  assert.equal(await page.evaluate(() => (JSON.parse(localStorage.getItem("align-picks:bt")) || {})["m:"]), undefined);
  assert.deepEqual(errors, []);
});
