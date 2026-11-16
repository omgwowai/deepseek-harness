// 真浏览器回归(2026-10-26):会话小卡的用时圆环和右边那行字改成「当前这一项」(用户 10-26:「圆环进度条显示的内容错了……我当时是让显示当前任务的」)。
// - 圆环:本回合待办里进行中的那一项有估时 → 一圈 = 这一项的中位数,已用 = 这一项自己的(和详情待办同一口径);悬停「当前一项：已用 X / 预计 P50–P75」,
//   下一行是原文,暗一档写整轮的已用 / 预计;
//   超出后每多一倍多一圈(颜色、圈心点数照旧);阻塞里也按这一项画。
// - 兜底:这一项没估时、没有进行中的项、没有待办、待办是上一回合的 → 整轮(一圈 = 轮次的 etaadj / eta),悬停「整轮：…」;
//   卡上有当前一项(没估时)时浮层下一行写它的原文、暗一档「当前一项没有估时」;整轮也没登记预计 → 不画。
// - 那一行:圆环画这一项时先写它的「已用 / 预计」(紧挨圆环),再写「· 原文」(单行省略);圆环退回整轮时只写原文,悬停说明「当前一项没有估时」;
//   右边的时长、进度条照旧是整轮的。
// - 变窄时:原文先缩(前面写着时间时至少露 6 个字)→ 这一项的「/ 预计」→ 整轮的「/ 预计」→ 当前步骤整段(不单留原文);
//   露出来的时间不被裁成一条缝;整行不撑出卡片;放不下当前步骤时圆环照旧留着(和改之前一样)。
// - 窄卡放不下当前步骤(整段让位)时,圆环改画整轮、悬停「整轮：…」,和卡上剩下的整轮已用对上(First Mate 2026-10-26 定);窗口变宽放得下时回到这一项。
// - 第 2 圈黄色 2026-10-26 加深到 #a5810c:圆环的弧对卡底(#f6f7f9 / 悬停 #eef0f3 / 选中 #fff)都在 3:1 以上。
// - 第 3、4 圈跟着压暗(橙 #823507、红 #611616):四圈对三种卡底都 ≥ 3:1,第 2 圈起一圈比一圈暗,第 2↔3 圈亮度对比 ≥ 2.3:1、其余相邻两圈 ≥ 1.45:1。
// RED = 改之前的模板:圆环画整轮(悬停「已用 40m / 预计 1h」,没有「当前一项」),那一行只有原文。
// 页面由 align.mjs render() 生成,本地 http 服务给页面、/data、/alignment/todos;依赖本机 playwright-core(同 card-bar-browser.test.mjs)。
// 一个浏览器跑完所有场景。ALIGN_SHOTS=<目录> 时另存截图。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "align-ring-item-"));
process.env.ALIGN_STORE = dir;
process.env.ALIGN_WORKSPACES = path.join(dir, "workspace.json");
const A = await import("../cli/align.mjs");
const { chromium } = createRequire((process.env.DSH_ALIGN_PW_DIR ? path.join(process.env.DSH_ALIGN_PW_DIR, "package.json") : import.meta.url))("playwright-core");
const SHOTS = process.env.ALIGN_SHOTS || "";

const T = Date.parse("2026-10-26T02:30:00Z"), MIN = 60_000, ago = (m) => T - m * MIN, iso = (ms) => new Date(ms).toISOString();
const item = (text, status, eta, spans) => ({ text, status, eta, startedAt: spans.length ? iso(spans[0][0]) : null, completedAt: null, elapsedMs: null, spans, approx: false });
const list = (items, turn = 1, latestTurn = 1) => ({ rev: "r" + Math.random().toString(36).slice(2, 10), updatedAt: iso(ago(1)), turn, latestTurn, running: true, done: items.filter((x) => x.status === "completed").length, total: items.length, items });
const CUR = "阶段2：其余段迁成清单条目并对账";
// [id, 标题, 轮次预计, 开始于几分钟前, live, 回合区间, 待办]
const SPEC = [
  ["cur", "当前一项有估时", "1h", 40, "running", [[ago(40), null]], list([item("读代码", "completed", { p50: 300, p75: 600 }, [[ago(40), ago(5)]]), item(CUR, "in_progress", { p50: 180, p75: 360 }, [[ago(5), null]]), item("截图", "pending", { p50: 120, p75: 300 }, [])])],
  ["over", "这一项超时", "1h", 30, "running", [[ago(30), null]], list([item("跑完整门禁", "in_progress", { p50: 180, p75: 300 }, [[ago(8), null]])])],
  ["noeta", "这一项没估时", "1h", 20, "running", [[ago(20), null]], list([item("写汇报", "in_progress", null, [[ago(4), null]])])],
  ["noetaover", "没估时且整轮超时", "20m", 47, "running", [[ago(47), null]], list([item("等真机装包结果", "in_progress", null, [[ago(6), null]])])],
  ["long", "长原文还续发过", "30m", 47, "running", [[ago(47), null]], list([item("更新 certificates.md(Mac、撤回、Edge 和 accept-new 的决定)、commit、门禁、合入 master", "in_progress", { p50: 1020, p75: 1920 }, [[ago(10), null]])])],
  ["notodo", "没有待办", "30m", 12, "running", [[ago(12), null]], null],
  ["none", "没有待办也没登记预计", null, 10, "running", [[ago(10), null]], null],
  ["old", "待办是上一回合的", "1h", 15, "running", [[ago(15), null]], list([item("上一回合的项", "in_progress", { p50: 60, p75: 120 }, [[ago(15), null]])], 1, 2)],
  ["blk", "停了等你定", "1h", 40, "idle", [[ago(40), ago(10)]], list([item("等你定换包", "in_progress", { p50: 600, p75: 900 }, [[ago(20), null]])])],
];
const data = {
  version: 3, name: "ri", title: "当前一项", owner: "session-fm", updated: iso(T), projects: [{ id: "p1", title: "dsh-core", cwd: "C:/p/p1" }],
  rounds: SPEC.flatMap(([id, title, eta, m]) => [
    // 「长原文还续发过」续发过一次:同一个会话前面多一轮已结束的(卡上多一个「⇄ 1」)
    ...(id === "long" ? [{ id: id + "-0", sid: "session-" + id, title, status: "accepted", proj: "p1", started: iso(ago(m + 60)), ended: iso(ago(m + 1)), next: "继续", result: "交了" }] : []),
    { id, sid: "session-" + id, title, status: "doing", proj: "p1", started: iso(ago(m)), next: "继续", ...(eta ? { eta } : {}) },
  ]),
  decisions: [], notes: [],
};
const live = Object.fromEntries(SPEC.map(([id, , , , l]) => ["session-" + id, l]));
const activity = Object.fromEntries(SPEC.map(([id, , , , , a]) => ["session-" + id, a]));
const sessions = Object.fromEntries(SPEC.filter((s) => s[6]).map(([id, , , , , , t]) => ["session-" + id, t]));

function serve() {
  const html = A.render(data);
  const server = createServer((req, res) => {
    const p = req.url.split("?")[0];
    const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (p === "/alignment/p/ri") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(html); }
    if (p === "/alignment/p/ri/data") return json(200, { ...data, live });
    if (p === "/alignment/health") return json(200, { ok: true, api: A.API_VERSION });
    if (p === "/alignment/todos") return json(200, { ok: true, api: 2, sessions, activity });
    if (p === "/alignment/fm") return json(200, { ok: true, page: "ri", fm: { sid: "session-fm", title: "first mate" }, refresh: null });
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, base: "http://127.0.0.1:" + server.address().port })));
}

// 每张进行中 / 阻塞小卡:圆环(悬停第一行、正文、画到哪、圈心点数)、那一行(原文、时间、哪些让位了)、右边整轮时长、进度条填充、元信息行是否放得下
const cards = (page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll(".cols .col.doing .sc, .cols .col.blk .sc")].map((e) => {
  const m = e.querySelector(".sc-m"), rg = m.querySelector(".rg"), svg = m.querySelector("svg.ring"), cur = m.querySelector(".cur");
  const hid = (x) => !!x && !!x.closest(".fit-x"), own = (x) => !!x && x.classList.contains("fit-x");
  return [e.querySelector(".sc-tx").textContent, {
    col: e.closest(".col").classList.contains("doing") ? "doing" : "blk",
    tip: rg ? rg.getAttribute("data-tip-h") : null, body: rg ? rg.getAttribute("data-tip") : null,
    x: svg ? svg.getAttribute("data-x") : null, dots: svg ? svg.querySelectorAll(".dt").length : null,
    ct: cur ? (cur.querySelector(".ct")?.textContent ?? cur.textContent) : null, ce: cur ? (cur.querySelector(".ce")?.textContent.trim() ?? null) : null, tipN: rg ? rg.getAttribute("data-tip-n") : null,
    ceFirst: !!cur && !!cur.querySelector(".ce") && cur.firstElementChild === cur.querySelector(".ce"),
    tm: m.querySelector(".tm")?.textContent ?? null, fill: e.querySelector(".pbar>i") ? +parseFloat(e.querySelector(".pbar>i").style.width).toFixed(1) : null,
    hide: { tt: own(m.querySelector(".tm .tt")), ee: own(m.querySelector(".cur .ee")), ct: own(m.querySelector(".cur .ct")), cur: own(cur) }, hasCe: !!m.querySelector(".cur .ce"),
    ctW: cur && cur.querySelector(".ct") && !hid(cur.querySelector(".ct")) ? cur.querySelector(".ct").clientWidth : null, ctFull: cur && cur.querySelector(".ct") ? cur.querySelector(".ct").scrollWidth : null,
    arc: svg ? getComputedStyle(svg.querySelector(".ra")).stroke : null,
    fits: m.scrollWidth <= m.clientWidth, ring: !!rg && !hid(rg), curClip: !!cur && !hid(cur) && cur.scrollWidth > cur.clientWidth + 1,
  }];
})));
const pick = (c, keys) => Object.fromEntries(keys.map((k) => [k, c[k]]));
const frames2 = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
async function shoot(page, sel, name) {
  const vw = page.viewportSize().width;
  await page.setViewportSize({ width: vw, height: 2000 });
  await page.evaluate(() => { for (let el = document.querySelector(".cols"); el; el = el.parentElement) el.scrollTop = 0; });
  await frames2(page);
  // 等进场、淡入这类有限时长的动画跑完(在跑的光带是无限循环,不等)
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect.getComputedTiming().iterations === Infinity));
  const box = await page.locator(sel).first().boundingBox();
  await page.screenshot({ path: path.join(SHOTS, name), clip: { x: box.x - 6, y: box.y - 6, width: box.width + 12, height: box.height + 12 } });
}
// 悬停圆环,把小卡和浮层一起截下来
async function shootTip(page, title, name) {
  const card = page.locator(".cols .sc", { hasText: title }).first();
  // 加高到 2000 的视口里整页多出 1px 可滚:hover() 先把元素滚进视野,会让整页滚 1px,页面滚动时收起浮层,刚出来的浮层就没了。
  // 先对同一个元素做 hover() 里那一步滚动、等滚动事件过去,hover() 就不用再滚;等浮层淡入跑完再截
  const rg = card.locator(".rg");
  await rg.scrollIntoViewIfNeeded();
  await frames2(page);
  await rg.hover();
  await page.waitForSelector("#tip:not([hidden])");
  await page.waitForFunction(() => document.getElementById("tip").getAnimations().every((a) => a.playState === "finished"));
  const b = await card.boundingBox(), tb = await page.locator("#tip").boundingBox();
  const x0 = Math.min(b.x, tb.x) - 8, y0 = Math.min(b.y, tb.y) - 8, x1 = Math.max(b.x + b.width, tb.x + tb.width) + 8, y1 = Math.max(b.y + b.height, tb.y + tb.height) + 8;
  await page.screenshot({ path: path.join(SHOTS, name), clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } });
  await page.mouse.move(0, 0);
}

test("圆环和那一行是当前这一项;兜底退回整轮;变窄按序让位", { timeout: 90_000 }, async (t) => {
  const { server, base } = await serve();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(15000); // dsh-verify 并行满载时页面加载会慢;只在失败时才等满
  await page.clock.setFixedTime(T); // Date.now 固定在 T,定时器照常走(轮询照发)
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base + "/alignment/p/ri?theme=light");
  // 等待办和回合时间到了(圆环不再等数据、按回合算出已用)
  await page.waitForFunction(() => document.querySelectorAll(".cols svg.ring").length >= 6 && !document.querySelector(".cols svg.ring[data-pend]") && !/约/.test(document.querySelector(".cols .tm")?.textContent || "约"));
  await frames2(page);
  const c = await cards(page);
  const K = ["col", "tip", "body", "x", "dots", "ct", "ce", "tm", "fill", "tipN"];
  assert.deepEqual(pick(c["当前一项有估时"], K), { col: "doing", tip: "当前一项：已用 5m / 预计 3m–6m", body: CUR, x: "1.6667", dots: 1, ct: CUR, ce: "5m / 3m–6m", tm: "40m / 1h", fill: 66.7, tipN: "整轮：已用 40m / 预计 1h" },
    "圆环 = 这一项(5m / 中位 3m,第 2 圈);那一行先写这一项的已用 / 预计;右边时长和进度条仍是整轮 40m / 1h");
  assert.equal(c["当前一项有估时"].ceFirst, true, "这一项的时间紧挨圆环,在原文前面");
  assert.deepEqual(pick(c["这一项超时"], K), { col: "doing", tip: "当前一项：已用 8m / 预计 3m–5m", body: "跑完整门禁", x: "2.6667", dots: 2, ct: "跑完整门禁", ce: "8m / 3m–5m", tm: "30m / 1h", fill: 50, tipN: "整轮：已用 30m / 预计 1h" },
    "这一项超出:每多一倍多一圈(8m / 3m 进第 3 圈,圈心 2 个点)");
  assert.deepEqual(pick(c["这一项没估时"], K), { col: "doing", tip: "整轮：已用 20m / 预计 1h", body: "当前一项：写汇报", x: "0.3333", dots: 0, ct: "写汇报", ce: null, tm: "20m / 1h", fill: 33.3, tipN: "当前一项没有估时" },
    "这一项没估时:圆环退回整轮,悬停写「整轮」、原文,并说明为什么;那一行只写原文(圆环后面没有数字 = 画的是整轮)");
  assert.deepEqual(pick(c["没估时且整轮超时"], ["tip", "x", "dots", "ce", "tipN", "tm"]), { tip: "整轮：已用 47m / 预计 20m", x: "2.3500", dots: 2, ce: null, tipN: "当前一项没有估时", tm: "47m / 20m" },
    "这一项没估时、整轮已超:圆环按整轮的倍数换色、圈心 2 个点(和琥珀进度条一致)");
  assert.deepEqual(pick(c["没有待办"], K), { col: "doing", tip: "整轮：已用 12m / 预计 30m", body: "", x: "0.4000", dots: 0, ct: null, ce: null, tm: "12m / 30m", fill: 40, tipN: null }, "没有待办:整轮,不用解释");
  assert.deepEqual(pick(c["没有待办也没登记预计"], ["tip", "x", "ct", "tm", "fill"]), { tip: null, x: null, ct: null, tm: "10m", fill: null }, "整轮也没登记预计:不画圆环");
  assert.deepEqual(pick(c["待办是上一回合的"], ["tip", "x", "ct"]), { tip: "整轮：已用 15m / 预计 1h", x: "0.2500", ct: null }, "上一回合留下的待办不算当前这一项");
  assert.deepEqual(pick(c["长原文还续发过"], ["tip", "ce", "tm", "hide"]), { tip: "当前一项：已用 10m / 预计 17m–32m", ce: "10m / 17m–32m", tm: "47m / 30m", hide: { tt: false, ee: true, ct: false, cur: false } },
    "宽屏长原文还续发过:先让这一项的「/ 预计」(悬停圆环能看到),整轮的「/ 预计」留着");
  assert.ok(c["长原文还续发过"].ctW >= 72 && c["长原文还续发过"].ctW < c["长原文还续发过"].ctFull, "长原文缩了、至少留 6 个字宽:" + c["长原文还续发过"].ctW);
  assert.deepEqual(pick(c["停了等你定"], ["col", "tip", "body", "x", "dots", "ct"]), { col: "blk", tip: "当前一项：已用 10m / 预计 10m–15m", body: "等你定换包", x: "1.0000", dots: 1, ct: null },
    "阻塞:圆环也按这一项(只算回合在跑的 10m),不写那一行");
  for (const [k, v] of Object.entries(c)) assert.deepEqual([v.fits, v.col === "doing" ? v.hide : v.hide.cur, v.ring], [true, v.col === "doing" ? { tt: false, ee: k === "长原文还续发过", ct: false, cur: false } : false, v.tip !== null], k + ":1280 宽都放得下,进行中的卡只有长原文那张让出这一项的「/ 预计」");
  assert.ok(c["当前一项有估时"].ctW >= 36, "原文至少留 3 个字宽:" + c["当前一项有估时"].ctW);
  // 圆环的弧对卡底的对比度 ≥ 3:1(WCAG 1.4.11 图形对象);卡底按三种状态都算(平时 / 悬停 / 选中)
  const rgb = (s) => s.match(/\d+/g).slice(0, 3).map(Number), lum = (a) => a.map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => { const x = lum(rgb(a)), y = lum(rgb(b)); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  assert.equal(c["当前一项有估时"].arc, "rgb(165, 129, 12)", "第 2 圈黄 #a5810c");
  for (const k of ["当前一项有估时", "这一项超时", "停了等你定", "没有待办", "长原文还续发过"]) for (const bg of ["rgb(246, 247, 249)", "rgb(238, 240, 243)", "rgb(255, 255, 255)"])
    assert.ok(ratio(c[k].arc, bg) >= 3, k + " 圆环 " + c[k].arc + " 对 " + bg + " 只有 " + ratio(c[k].arc, bg).toFixed(2) + ":1");
  // 四圈的颜色(读 CSS 变量的计算值,在跑 / 没在跑的第 1 圈都算):对三种卡底 ≥ 3:1;第 2 圈起越来越暗,相邻两圈拉得开
  const laps = await page.evaluate(() => { const probe = (cls) => { const e = document.createElement("span"); e.className = cls; document.body.append(e); const cs = getComputedStyle(e.querySelector("svg") || e); const v = [1, 2, 3, 4].map((i) => { const d = document.createElement("i"); d.style.color = "var(--lap" + i + ")"; e.append(d); const c = getComputedStyle(d).color; d.remove(); return c; }); e.remove(); return v; };
    const one = (wrap) => { const s = document.createElement("div"); s.className = wrap; const r = document.createElementNS("http://www.w3.org/2000/svg", "svg"); r.setAttribute("class", "ring"); s.append(r); document.querySelector(".cols").append(s); const v = [1, 2, 3, 4].map((i) => { const d = document.createElementNS("http://www.w3.org/2000/svg", "circle"); d.style.stroke = "var(--lap" + i + ")"; r.append(d); const c = getComputedStyle(d).stroke; d.remove(); return c; }); s.remove(); return v; };
    return { idle: one("sc"), run: one("sc run") }; });
  assert.deepEqual(laps.idle.slice(1), ["rgb(165, 129, 12)", "rgb(130, 53, 7)", "rgb(97, 22, 22)"], "第 2–4 圈 #a5810c / #823507 / #611616");
  for (const set of [laps.idle, laps.run]) {
    for (const col of set) for (const bg of ["rgb(246, 247, 249)", "rgb(238, 240, 243)", "rgb(255, 255, 255)"]) assert.ok(ratio(col, bg) >= 3, col + " 对 " + bg + " 只有 " + ratio(col, bg).toFixed(2) + ":1");
    assert.ok(lum(rgb(set[1])) > lum(rgb(set[2])) && lum(rgb(set[2])) > lum(rgb(set[3])), "第 2 圈起一圈比一圈暗:" + set.join(" / "));
    assert.ok(ratio(set[1], set[2]) >= 2.3, "第 2↔3 圈亮度对比至少 2.3:1(加深黄色前约 2.27:1),现在 " + ratio(set[1], set[2]).toFixed(2));
    for (const [a, b] of [[0, 1], [2, 3]]) assert.ok(ratio(set[a], set[b]) >= 1.45, "第 " + (a + 1) + "↔" + (b + 1) + " 圈亮度对比 " + ratio(set[a], set[b]).toFixed(2));
  }
  if (SHOTS) {
    await shoot(page, ".cols .col.doing", "ring-item-1280.png");
    for (const [title, name] of [["当前一项有估时", "tip-item.png"], ["这一项超时", "tip-over.png"], ["这一项没估时", "tip-noeta.png"], ["没有待办", "tip-notodo.png"], ["长原文还续发过", "tip-long.png"]]) await shootTip(page, title, name);
  }
  // 变窄:元信息行始终放得下;让位顺序 = 原文缩到 6 字 → 这一项「/ 预计」→ 整轮「/ 预计」→ 当前步骤整段;圆环还是同一个
  const seen = new Set();
  for (const w of [1100, 900, 760, 640, 520, 420]) {
    await page.setViewportSize({ width: w, height: 900 });
    await frames2(page);
    const n = await cards(page);
    for (const [k, v] of Object.entries(n)) {
      assert.equal(v.fits, true, k + " @" + w + ":元信息行放得下");
      // 当前步骤整段让位的卡:圆环改画整轮(悬停「整轮：」,和卡上剩下的整轮已用对上);放得下的照旧
      if (v.hide.cur && v.hasCe) { assert.match(v.tip, /^整轮：已用 /, k + " @" + w + ":放不下当前步骤,圆环画整轮"); assert.match(v.body, /(^|\n)当前一项：/, k + " @" + w + ":浮层写「当前一项：原文」"); assert.match(v.tipN, /^已用 \S+ \/ 预计 /, k + " @" + w + ":暗一档写这一项的已用 / 预计(有估时只是放不下)"); seen.add("whole"); }
      else assert.equal(v.tip, c[k].tip, k + " @" + w + ":圆环画的还是同一个");
      if (v.hide.tt && v.hasCe) assert.ok(v.hide.ee, k + " @" + w + ":先让这一项的「/ 预计」,再让整轮的");
      if (v.hide.cur && v.hasCe) assert.ok(v.hide.ee && v.hide.tt, k + " @" + w + ":当前步骤整段让位前,两个「/ 预计」都先让了");
      assert.equal(v.hide.ct, false, k + " @" + w + ":不单让原文、留下一个数字");
      assert.equal(v.curClip, false, k + " @" + w + ":露出来的当前步骤没被裁(时间不剩一条缝)");
      if (v.hasCe && !v.hide.ct && !v.hide.cur) assert.ok(v.ctW >= Math.min(72, v.ctFull), k + " @" + w + ":写着这一项的时间时原文至少 6 个字宽:" + v.ctW);
      if (v.ctW !== null) assert.ok(v.ctW >= Math.min(36, v.ctFull), k + " @" + w + ":露出来的原文至少 3 个字宽:" + v.ctW);
      for (const x of ["ee", "tt", "cur"]) if (v.hide[x] && v.hasCe) seen.add(x);
    }
  }
  assert.deepEqual([...seen].sort(), ["cur", "ee", "tt", "whole"], "变窄过程中这一项的「/ 预计」、整轮的「/ 预计」、当前步骤整段都让过位,放不下当前步骤的卡圆环画过整轮");
  // 420 宽:进行中的卡圆环都还在(放不下的是当前步骤),当前一项那几张卡的圆环画整轮
  const n420 = await cards(page);
  for (const [k, v] of Object.entries(n420)) if (v.col === "doing" && c[k].tip) assert.equal(v.ring, true, k + " @420:圆环还在");
  assert.deepEqual(pick(n420["当前一项有估时"], ["tip", "body", "x", "dots", "tipN"]), { tip: "整轮：已用 40m / 预计 1h", body: "当前一项：" + CUR, x: "0.6667", dots: 0, tipN: "已用 5m / 预计 3m–6m" },
    "420 宽:圆环画整轮 40m / 1h,和卡上剩下的 40m 对上;浮层写「当前一项：原文」,暗一档这一项的已用 / 预计");
  assert.equal(n420["当前一项有估时"].hide.cur, true, "420 宽:这张卡的当前步骤整段让位了");
  // 窗口再变宽:放得下当前步骤了,圆环回到这一项
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForFunction(() => /^当前一项/.test([...document.querySelectorAll(".cols .sc")].find((e) => e.querySelector(".sc-tx").textContent === "当前一项有估时").querySelector(".rg").getAttribute("data-tip-h")));
  await page.setViewportSize({ width: 420, height: 900 });
  await page.waitForFunction(() => /^整轮/.test([...document.querySelectorAll(".cols .sc")].find((e) => e.querySelector(".sc-tx").textContent === "当前一项有估时").querySelector(".rg").getAttribute("data-tip-h")));
  if (SHOTS) await shootTip(page, "当前一项有估时", "tip-420.png");
  if (SHOTS) await shoot(page, ".cols", "ring-item-420.png");
  assert.deepEqual(errors, []);
});
