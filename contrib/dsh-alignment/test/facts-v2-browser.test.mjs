// 真浏览器回归(2026-10-26):对齐页详情的事实行和下文。
// - 对齐:下文的符号竖直对齐在第一句图标块的中线上(同一条符号线),文字和第一句文字左边缘对齐;宽屏、窄屏(420)都一样;第一句仍比下文大、粗;
// - 符号:按类型(text-split.mjs rowKinds,规则见 rowKinds),默认灰点,结果的勾、起因的分支不变;决定的说明同一套(首句 + 下文);
// - 字体:标识符和命令等宽,引用原话楷体,「第 N/M 步」照文字写、不画比例条;
// - 复制引用:每个事实行(现状 / 结果、下一步、起因、待办原因、决定说明)和下文的每一句都能复制,按钮盖在符号上、不多占一列;引用带「· 结果 第 2 句」。
// - 全角括号包着短标签:括号紧贴标签(不留整个括号的空白),括号不单独留在行尾或行首;
// - 右栏窄(≤ 400px:窗口 575、侧栏约 420 宽)时底部「暂缓 / 放弃」是实底条,正文不从按钮之间和旁边透出来;宽屏仍是悬浮按钮、没有底色。
// 页面由 align.mjs render() 生成,本地 http 服务给页面和 /data;依赖插件 devDependencies 里的 playwright-core（DSH_ALIGN_PW_DIR 覆盖）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "align-facts-v2-"));
process.env.ALIGN_STORE = dir;
process.env.ALIGN_WORKSPACES = path.join(dir, "workspace.json");
const A = await import("../cli/align.mjs");
const S = await import("../cli/text-split.mjs");
const { chromium } = createRequire((process.env.DSH_ALIGN_PW_DIR ? path.join(process.env.DSH_ALIGN_PW_DIR, "package.json") : import.meta.url))("playwright-core");

const T = Date.parse("2026-10-26T10:00:00Z"), iso = (ms) => new Date(ms).toISOString();
const SID = "session-1a2b3c4d-1111-2222-3333-444455556666";
const RESULT = "已合入 c612200d。五个初判原因都成立。回测：大任务被估短 66.7% → 16.7%。代价是估长 2.1% → 6.3%。家里电脑 03:31 起连不上，装机没开始。要 3080 重启生效，核对 check-20261024-212306。你说的「余量」两种都说得通。跑 dsh-verify 全过";
const data = {
  version: 3, name: "facts", title: "事实行", owner: "session-fm", updated: iso(T), projects: [],
  rounds: [
    { id: "r1", sid: SID, title: "一轮结果", status: "done", started: iso(T - 3600e3), ended: iso(T - 60e3), updated: iso(T - 60e3), why: "用户留言", next: "你确认后合入", result: RESULT },
    { id: "r2", sid: "session-2b3c4d5e-1111-2222-3333-444455556666", title: "进行中的一轮", status: "doing", started: iso(T - 600e3), updated: iso(T - 60e3), state: "第 7/8 步：1.7.8-local.14 已合入 App 本地 main（d5316c2），APK 已打好。只剩真机检查" },
  ],
  decisions: [{ id: "d1", title: "要不要合入", why: "本机这把 key 是好的。影响：记忆入库在报错。First Mate 不对外发消息，要你去找管理员。修好后回一句", status: "open", opened: iso(T - 1800e3), updated: iso(T - 1800e3), risk: "低", cat: "其他", opt: [{ label: "合", effect: "+ 上线。- 要重启" }, { label: "不合", effect: "等" }] },
    { id: "d2", title: "先合哪边", why: "两边都改好了，所以来问你先合哪边。网页已过门禁。App 还在打包", status: "open", opened: iso(T - 900e3), updated: iso(T - 900e3), risk: "低", cat: "其他", opt: [{ label: "网页", effect: "今天上线" }, { label: "App", effect: "等打包" }] }],
  notes: [],
};

function serve() {
  const html = A.render(data);
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://x"), p = u.pathname;
    const json = (body) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (p === "/alignment/p/facts") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(html); }
    if (p === "/alignment/p/facts/data") return json({ ...data, live: {} });
    if (p.endsWith("/log")) return json({ ok: true });
    if (p === "/alignment/health") return json({ ok: true, api: A.API_VERSION });
    if (p === "/alignment/todos") return json({ ok: true, api: 4, sessions: { [SID]: null }, activity: {}, background: {}, notodo: { [SID]: { by: "session", text: "只改一行配置" } } });
    if (p === "/alignment/fm") return json({ ok: true, page: "facts", fm: null, refresh: null });
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, base: "http://127.0.0.1:" + server.address().port })));
}

let s, browser;
test.before(async () => { s = await serve(); browser = await chromium.launch({ headless: true }); });
test.after(async () => { await browser.close(); s.server.closeAllConnections(); s.server.close(); });
async function open(hash, width = 1440) {
  const ctx = await browser.newContext({ viewport: { width, height: 1000 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  page.setDefaultTimeout(5000);
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(s.base + "/alignment/p/facts#" + hash);
  await page.waitForSelector(".rbody .facts .fact");
  return { page, errors, ctx };
}
/** 第一个事实行：图标块中线、第一句文字左边缘、每句下文的符号中线 / 文字左边缘 / 类型 / 字号字重 */
const geo = (page) => page.evaluate(() => {
  const f = document.querySelector(".rbody .facts .fact"), R = (e) => e.getBoundingClientRect(), mid = (e) => Math.round((R(e).left + R(e).right) / 2);
  const ft = f.querySelector(".ft"), lis = [...f.querySelectorAll(".fsub>li")];
  return {
    icon: mid(f.querySelector(".fi")), text: Math.round(R(ft).left), lead: [getComputedStyle(ft).fontSize, getComputedStyle(ft).fontWeight],
    subs: lis.map((li) => { const sy = li.querySelector(".fsy"), mk = sy.firstElementChild; return { sym: mid(mk), text: Math.round(R(li.querySelector(".fst")).left), k: li.className, size: getComputedStyle(li).fontSize, weight: getComputedStyle(li).fontWeight }; }),
  };
});

test("对齐:下文符号落在第一句图标块的中线上,文字和第一句左边缘对齐;第一句更大更粗;宽屏和 420 窄屏都一样", { timeout: 60_000 }, async () => {
  for (const w of [1440, 420]) {
    const { page, errors, ctx } = await open("r=r1", w);
    const g = await geo(page);
    assert.ok(g.subs.length === 7, w + ":结果第一句以后 7 句下文 " + JSON.stringify(g));
    for (const x of g.subs) {
      assert.ok(Math.abs(x.sym - g.icon) <= 1, w + ":符号中线 " + x.sym + " 对齐图标中线 " + g.icon + " " + x.k);
      assert.ok(Math.abs(x.text - g.text) <= 1, w + ":下文文字 " + x.text + " 对齐第一句 " + g.text + " " + x.k);
      assert.ok(parseFloat(x.size) < parseFloat(g.lead[0]) && +x.weight < +g.lead[1], w + ":第一句更大更粗");
    }
    assert.equal(errors.length, 0, errors.join("\n"));
    await ctx.close();
  }
});

test("符号:按类型;结果的勾、起因的分支、默认灰点不变;决定的说明同一套", { timeout: 60_000 }, async () => {
  const { page, errors, ctx } = await open("r=r1");
  const g = await geo(page);
  assert.deepEqual(g.subs.map((x) => x.k), ["fk-dot", "fk-trend", "fk-con", "fk-warn", "fk-wait", "fk-dot", "fk-dot"]);
  const icons = await page.$$eval(".rbody .facts .fact>.fi>svg path", (ps) => ps.map((p) => p.getAttribute("d")));
  assert.ok(icons.some((d) => d.startsWith("M3.5 8.5 6.5 11.5")) && icons.some((d) => d.startsWith("M4.5 5.25v5.5")), "结果的勾、起因的分支");
  assert.equal(await page.$eval(".fsub li.fk-dot .mk", (e) => getComputedStyle(e).width + " " + getComputedStyle(e).borderRadius), "5px 50%", "默认圆点");
  assert.equal(await page.$eval(".fsub li.fk-warn .fsy", (e) => getComputedStyle(e).color), "rgb(163, 95, 0)", "风险琥珀");
  // 决定:第一句是事实行,后面三句是下文:风险、要你做、默认
  await page.evaluate(() => { location.hash = "d=d1"; });
  await page.waitForFunction(() => document.querySelector(".rbody>.dh h1")?.textContent === "要不要合入");
  assert.equal(await page.locator(".rbody .facts .fact").count(), 1, "决定说明只画一个事实行");
  assert.deepEqual(await page.$$eval(".rbody .facts .fsub>li", (x) => x.map((e) => e.className)), ["fk-warn", "fk-you", "fk-dot"]);
  assert.equal(await page.$eval(".fsub li.fk-you .fsy", (e) => getComputedStyle(e).color), "rgb(47, 98, 214)", "要你做蓝");
  assert.equal(await page.$eval(".fsub li.fk-you .fst", (e) => getComputedStyle(e).color), "rgb(68, 73, 81)", "下文文字 ink2,只有符号上色");
  assert.equal(errors.length, 0, errors.join("\n"));
  await ctx.close();
});

test("决定说明的第一句是「问你」句:问号浅蓝底,文字和其他第一句一样 15 / 500 墨色(DESIGN.md 第 5 节),不是下文的 14 / 400 灰", { timeout: 60_000 }, async () => {
  const lead = (page) => page.$eval(".rbody .facts .fact>.ft", (e) => { const s = getComputedStyle(e); return [s.fontSize, s.fontWeight, s.color]; });
  const { page, errors, ctx } = await open("d=d1");
  const want = await lead(page);
  assert.deepEqual(want, ["15px", "500", "rgb(21, 23, 27)"], "普通第一句 15 / 500 墨色");
  await page.evaluate(() => { location.hash = "d=d2"; });
  await page.waitForFunction(() => document.querySelector(".rbody>.dh h1")?.textContent === "先合哪边");
  const f = await page.$eval(".rbody .facts .fact", (e) => { const fi = getComputedStyle(e.querySelector(".fi")), p = document.createElement("i"); p.style.background = "var(--bsoft)"; e.append(p); const bsoft = getComputedStyle(p).backgroundColor; p.remove(); return { cls: e.className, label: e.querySelector(".fl")?.textContent, bg: fi.backgroundColor, bsoft, fg: fi.color, text: e.querySelector(".ft").textContent }; });
  assert.match(f.cls, /\bask\b/, "第一句认成「问你」 " + f.cls);
  assert.equal(f.text, "两边都改好了，所以来问你先合哪边");
  assert.deepEqual([f.label, f.bg, f.fg], ["问你", f.bsoft, "rgb(47, 98, 214)"], "问号图标块浅蓝底、蓝问号不变");
  assert.deepEqual(await lead(page), want, "「问你」第一句和普通第一句同字号、字重、颜色");
  assert.equal(errors.length, 0, errors.join("\n"));
  await ctx.close();
});

test("字体:标识符等宽、引用原话楷体;「第 7/8 步」照文字写,不画比例条", { timeout: 60_000 }, async () => {
  const { page, errors, ctx } = await open("r=r1");
  const fam = (sel) => page.$eval(sel, (e) => getComputedStyle(e).fontFamily);
  assert.match(await fam(".fsub .idf"), /Cascadia Mono|Consolas/);
  assert.deepEqual(await page.$$eval(".fsub .idf", (x) => x.map((e) => e.textContent)), ["check-20261024-212306", "dsh-verify"]);
  assert.match(await fam(".fsub .quo"), /KaiTi/);
  assert.equal(await page.textContent(".fsub .quo"), "「余量」");
  await page.evaluate(() => { location.hash = "r=r2"; });
  await page.waitForFunction(() => document.querySelector(".rbody>.dh h1")?.textContent === "进行中的一轮");
  const lead = page.locator(".rbody .facts .fact.lead>.ft");
  assert.match(await lead.textContent(), /^第 7\/8 步：1\.7\.8-local\.14 已合入/);
  assert.equal(await lead.locator(".mt, .rt").count(), 0, "没有比例条");
  assert.equal(await lead.locator(".stpn b.n").textContent(), "7");
  assert.equal(errors.length, 0, errors.join("\n"));
  await ctx.close();
});

test("复制引用:每个事实行和每句下文都有按钮,盖在符号上;点了复制「· 结果 第 2 句」这类引用", { timeout: 60_000 }, async () => {
  const { page, errors, ctx } = await open("r=r1");
  await page.waitForSelector(".rbody .fact.nt");
  const refs = await page.$$eval(".rbody .facts .cref", (x) => x.map((b) => b.dataset.ref));
  const want = (sub, at, title) => S.refText("facts", "r", "r1", sub, at, title);
  assert.equal(refs[0], want("结果", "", "已合入 c612200d"));
  assert.equal(refs[1], want("结果", "第 2 句", "五个初判原因都成立"));
  assert.deepEqual(refs.slice(-3), [want("下一步", "", "你确认后合入"), want("起因", "", "用户留言"), want("待办原因", "", "没有列：只改一行配置")]);
  // 按钮在符号那一列里(以符号为中心),不多占一列:文字左边缘不变
  const pos = await page.$eval(".fsub>li:nth-child(1)", (li) => { const b = li.querySelector(".cref").getBoundingClientRect(), m = li.querySelector(".mk").getBoundingClientRect(); return [Math.round(b.left + b.width / 2), Math.round(m.left + m.width / 2), Math.round(b.right) <= Math.round(li.querySelector(".fst").getBoundingClientRect().left)]; });
  assert.ok(Math.abs(pos[0] - pos[1]) <= 1 && pos[2], "复制按钮以符号为中心、不压到文字 " + JSON.stringify(pos));
  const b = page.locator(".fsub>li:nth-child(1) .cref");
  await b.hover();
  await b.click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), want("结果", "第 2 句", "五个初判原因都成立"));
  await page.waitForFunction(() => document.querySelector(".fsub>li:nth-child(1) .cref").classList.contains("ok"));
  assert.equal(await b.getAttribute("aria-label"), "复制引用：结果 第 2 句：五个初判原因都成立");
  // 留言框里贴进去显示成短标签「结果 第 2 句：…」
  assert.equal(S.refParse(want("结果", "第 2 句", "五个")).at, "第 2 句");
  assert.equal(errors.length, 0, errors.join("\n"));
  await ctx.close();
});


test("全角括号包着短标签:括号贴着标签和前后的字(只留 1–4px 左右,不留全角括号自带的半个字空白),括号不单独留在行尾或行首", { timeout: 60_000 }, async () => {
  const { page, errors, ctx } = await open("r=r2");
  const r = await page.evaluate(() => {
    const ft = document.querySelector(".rbody .facts .fact.lead>.ft"), as = ft.querySelector(".aside"), tk = as.querySelector(".tk");
    // 某个字符的 Range;字形墨迹的左右边 = Range 的左边 + 当前字体里这个字形的实际左右边(canvas 量)
    const at = (root, c) => { const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); for (let n = w.nextNode(); n; n = w.nextNode()) { const i = c === "$" ? n.data.length - 1 : c === "^" ? 0 : n.data.indexOf(c); if (i >= 0 && n.data.length) { const g = document.createRange(); g.setStart(n, i); g.setEnd(n, i + 1); if (c !== "$" || !as.contains(n)) return { g, el: n.parentElement }; } } return null; };
    const ink = ({ g, el }) => { const cs = getComputedStyle(el), x = document.createElement("canvas").getContext("2d"); x.font = cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily; const m = x.measureText(g.toString()), b = g.getBoundingClientRect(); return [b.left - m.actualBoundingBoxLeft, b.left + m.actualBoundingBoxRight]; };
    const o = at(as, "（"), c = at(as, "）"), mid = (b) => (b.top + b.bottom) / 2;
    // 括号前一个字(「main」的 n)、后一个字(「，」)
    const before = document.createRange(), pn = as.previousSibling; before.setStart(pn, pn.data.length - 1); before.setEnd(pn, pn.data.length);
    const after = document.createRange(), nn = as.nextSibling; after.setStart(nn, 0); after.setEnd(nn, 1);
    const t = tk.getBoundingClientRect();
    const gaps = { 前字到左括号: ink(o)[0] - before.getBoundingClientRect().right, 左括号到标签: t.left - ink(o)[1], 标签到右括号: ink(c)[0] - t.right, 右括号到后字: after.getBoundingClientRect().left - ink(c)[1] };
    // 把句子从宽到窄一个像素一个像素地收,括号和标签始终在同一行
    const split = [];
    for (let w = 420; w >= 150; w--) {
      ft.style.width = w + "px";
      const k = mid(tk.getBoundingClientRect());
      if (Math.abs(mid(o.g.getBoundingClientRect()) - k) > 8 || Math.abs(mid(c.g.getBoundingClientRect()) - k) > 8) split.push(w);
    }
    ft.style.width = "";
    for (const k in gaps) gaps[k] = Math.round(gaps[k] * 10) / 10;
    return { gaps, split: split.length > 6 ? split.slice(0, 3).concat("… 共 " + split.length + " 个宽度") : split, label: tk.textContent, text: ft.textContent };
  });
  assert.equal(r.label, "d5316c2");
  assert.match(r.text, /main（d5316c2），APK/, "括号和逗号原样留在文字里");
  for (const [k, g] of Object.entries(r.gaps)) assert.ok(g >= 0.5 && g <= 4.5, k + " " + g + "px,要 0.5–4.5px:" + JSON.stringify(r.gaps));
  assert.deepEqual(r.split, [], "这些宽度下括号和标签分到了两行");
  assert.equal(errors.length, 0, errors.join("\n"));
  await ctx.close();
});

test("右栏窄(575、420 宽)时「暂缓 / 放弃」是实底条,正文不从按钮之间和旁边透出来;宽屏仍是悬浮按钮", { timeout: 60_000 }, async () => {
  const foot = (page) => page.evaluate(() => {
    const f = document.querySelector(".rfoot"), bs = [...f.querySelectorAll(".btn")].map((b) => b.getBoundingClientRect()), fr = f.getBoundingClientRect(), y = (bs[0].top + bs[0].bottom) / 2;
    const own = (x) => !!document.elementFromPoint(x, y)?.closest(".rfoot");
    return { n: bs.length, between: own((bs[0].right + bs[1].left) / 2), left: own(fr.left + 16), bg: getComputedStyle(f).backgroundColor, shadow: getComputedStyle(f.querySelector(".btn")).boxShadow };
  });
  for (const [w, solid] of [[420, true], [575, true], [1440, false]]) {
    const { page, errors, ctx } = await open("r=r2", w);
    await page.waitForSelector(".rfoot .btn");
    const f = await foot(page);
    assert.equal(f.n, 2, w + ":暂缓、放弃两个按钮");
    if (solid) {
      assert.deepEqual([f.between, f.left], [true, true], w + ":按钮之间、按钮左边是底条,不是正文 " + JSON.stringify(f));
      assert.match(f.bg, /^rgb\(/, w + ":底条不透明 " + f.bg);
      assert.doesNotMatch(f.shadow, /8px 20px -8px/, w + ":贴在底条上的按钮不带悬浮落影 " + f.shadow);
    } else {
      assert.deepEqual([f.between, f.left, f.bg], [false, false, "rgba(0, 0, 0, 0)"], w + ":宽屏按钮行后面没有底色 " + JSON.stringify(f));
      assert.match(f.shadow, /8px 20px -8px/, w + ":宽屏按钮仍有悬浮落影");
    }
    assert.equal(errors.length, 0, errors.join("\n"));
    await ctx.close();
  }
});
