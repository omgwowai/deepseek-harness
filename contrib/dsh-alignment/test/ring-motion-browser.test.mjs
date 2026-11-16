// 真浏览器回归(2026-10-24):会话小卡用时圆环的动效(DESIGN.md「用时圆环」)。
// 1. 刚打开、还没拿到回合时间:圆环淡着(40%)、只画空轨道(不先按「开始到现在」画几圈再跳回去);拿到后淡回来,本圈从起点长到实际位置,不提示跨圈。
// 2. 数据更新:从原来的位置减速走到新位置(240–600ms,走得越远越慢),逐帧只改 stroke-dashoffset(有中间帧,不是 CSS 动画);往前跨过整圈时
//    一圈新颜色的细环散开、圈心点弹一下,只动 transform / opacity,只提示一次;差一圈以上直接画到位(跨圈照样提示);往回走不提示;静止时没有任何动画。
// 3. 刷新页面:先画在本机记着的位置(align-ring:<页>,不变淡),拿到数据后接着走,跨圈也不提示;差一圈以上直接画到位。
// 4. 减少动态效果:直接画到新位置,没有中间帧、没有动画,颜色和圈心点照换。
// 页面由 align.mjs render() 生成,本地 http 服务给页面、/data、/alignment/todos(回合时间可改、可扣住);page.clock 接管 rAF,逐帧推进、逐帧取样。
// 依赖本机 playwright-core(同 page-browser.test.mjs)。ALIGN_SHOTS=<目录> 时另存泳道截图。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "align-ring-motion-"));
process.env.ALIGN_STORE = dir;
process.env.ALIGN_WORKSPACES = path.join(dir, "workspace.json");
const A = await import("../cli/align.mjs");
const { chromium } = createRequire((process.env.DSH_ALIGN_PW_DIR ? path.join(process.env.DSH_ALIGN_PW_DIR, "package.json") : import.meta.url))("playwright-core");
// 一个文件只起一个 Chromium,各用例自己开 context(隔离不变)
let browserP;
const getBrowser = () => (browserP ??= chromium.launch({ headless: true }));
test.after(async () => { if (browserP) await (await browserP.catch(() => null))?.close(); });
const SHOTS = process.env.ALIGN_SHOTS || "";

const T = Date.parse("2026-10-24T10:00:00Z"), MIN = 60_000, iso = (ms) => new Date(ms).toISOString();
const BLUE = "rgb(47, 98, 214)", YELLOW = "rgb(165, 129, 12)", RED = "rgb(97, 22, 22)", TRACK = "rgb(227, 230, 235)", INK3 = "rgb(100, 106, 115)";
// r1 在跑(预计 1h);r2 在跑、已超时进第 2 圈(预计 40m);r3 停了(阻塞栏,预计 30m);r4 没登记预计(不画圆环)。都是 5 小时前开工:按墙钟算早就满 4 圈
const seed = () => ({
  version: 3, name: "rm", title: "圆环动效", owner: "session-fm", updated: iso(T), projects: [{ id: "pa", title: "dsh-core", cwd: "C:/p/pa" }],
  rounds: [["r1", "w1", "改对齐页圆环", "1h"], ["r2", "w2", "升级依赖", "40m"], ["r3", "w3", "整理日志", "30m"], ["r4", "w4", "没登记预计", null]].map(([id, w, title, eta]) => ({ id, sid: "session-" + w, title, status: "doing", proj: "pa", started: iso(T - 300 * MIN), next: "继续", ...(eta ? { eta } : {}) })),
  decisions: [], notes: [],
});
const live = { "session-w1": "running", "session-w2": "running", "session-w3": "idle", "session-w4": "running" };

function serve() {
  // used = 各会话已用分钟数,回合时间给成一段 [T - used, T)(时间固定,结果可精确断言);hold = 扣住 /alignment/todos
  const st = { data: seed(), used: { w1: 15, w2: 50, w3: 10, w4: 5 }, hold: null };
  const server = createServer(async (req, res) => {
    const p = req.url.split("?")[0];
    const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (p === "/alignment/p/rm") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(A.render(st.data)); }
    if (p === "/alignment/p/rm/data") return json(200, { ...st.data, live });
    if (p === "/alignment/health") return json(200, { ok: true, api: A.API_VERSION });
    if (p === "/alignment/todos") {
      if (st.hold) await st.hold;
      return json(200, { ok: true, api: 2, sessions: {}, activity: Object.fromEntries(Object.entries(st.used).map(([k, m]) => ["session-" + k, [[T - m * MIN, T]]])) });
    }
    if (p === "/alignment/fm") return json(200, { ok: true, page: "rm", fm: { sid: "session-fm", title: "first mate" }, refresh: null });
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, st, base: "http://127.0.0.1:" + server.address().port })));
}

async function open(t, { reduce = false } = {}) {
  const { server, st, base } = await serve();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await getBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, reducedMotion: reduce ? "reduce" : "no-preference" });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000); // dsh-verify 并行满载时页面加载会慢;只在失败时才等满
  // 时间停在 T:只有 runFor 才往前走(rAF、performance.now 一起),逐帧可控
  await page.clock.install({ time: T - 60_000 });
  await page.clock.pauseAt(T);
  // 记下圆环上每次 element.animate(改了哪些属性)和每个新出现的光环(当时是哪个圆环、几个圈心点、弧画到哪、什么颜色):不依赖取样时动画还在
  await page.addInitScript(() => {
    window.__anims = []; window.__halos = [];
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (kf, opt) {
      if (this.closest && this.closest(".ring")) window.__anims.push(this.getAttribute("class") + ":" + [...new Set([].concat(kf).flatMap((k) => Object.keys(k)))].filter((k) => k !== "offset" && k !== "easing").sort().join("+"));
      return animate.call(this, kf, opt);
    };
    new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && n.classList.contains("halo")) { const v = n.closest("svg"); window.__halos.push({ r: v.dataset.r, dots: v.querySelectorAll(".dt").length, off: Math.round(parseFloat(getComputedStyle(v.querySelector(".ra")).strokeDashoffset) * 100) / 100, stroke: getComputedStyle(n).stroke }); } }).observe(document, { childList: true, subtree: true });
  });
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  return { page, st, url: base + "/alignment/p/rm?theme=light", errors };
}
const hold = (st) => { let release; st.hold = new Promise((r) => { release = r; }); return () => { st.hold = null; release(); }; };
const landed = (page) => page.waitForFunction(() => document.querySelector("svg.ring[data-r]") && !document.querySelector("svg.ring[data-pend]"));
// 一帧:每个圆环 {off: stroke-dashoffset, dots: 圈心点数, halo: 光环数, arc / under: 弧和底圈的颜色};anims = 圆环上正在跑的动画「类型:改的属性」
const frame = (page) => page.evaluate(() => {
  const r = {};
  for (const s of document.querySelectorAll("svg.ring[data-r]")) {
    const cs = getComputedStyle(s.querySelector(".ra"));
    r[s.dataset.r] = { off: Math.round(parseFloat(cs.strokeDashoffset) * 100) / 100, dots: s.querySelectorAll(".dt").length, halo: s.querySelectorAll(".halo").length, arc: cs.stroke, under: getComputedStyle(s.querySelector(".rb")).stroke, pend: s.hasAttribute("data-pend"), op: +getComputedStyle(s).opacity };
  }
  const anims = document.getAnimations().filter((a) => a.effect && a.effect.target && a.effect.target.closest && a.effect.target.closest(".ring"))
    .map((a) => a.constructor.name + ":" + [...new Set(a.effect.getKeyframes().flatMap((k) => Object.keys(k)))].filter((k) => !["offset", "easing", "composite", "computedOffset"].includes(k)).sort().join("+"));
  return { r, anims };
});
// 逐帧推进(page.clock 接管了 rAF,每 16 ms 一帧),每帧取样
async function frames(page, n = 45) { const out = []; for (let i = 0; i < n; i++) { await page.clock.runFor(16); out.push(await frame(page)); } return out; }
const offs = (fs, id) => fs.map((f) => f.r[id].off);
const between = (v, a, b) => v > Math.min(a, b) + 0.01 && v < Math.max(a, b) - 0.01;
const nextPoll = async (page, ok) => { await page.clock.runFor(4100); await page.waitForFunction(ok); };
const cues = (page) => page.evaluate(() => ({ halos: window.__halos, anims: window.__anims }));
// 拿到回合时间时每个圆环淡回来一次(ring:opacity),除此之外没有别的动画
const onlyFadeIn = (c, n) => { assert.deepEqual(c.halos, [], "不提示跨圈"); assert.deepEqual(c.anims, Array(n).fill("ring:opacity"), "只有淡回来:" + c.anims.join(" ")); };
// Web Animations(淡回来、提示)按真实时间跑,不受 page.clock 管:看「静止」之前等它们跑完
const idle = (page) => page.waitForFunction(() => !document.getAnimations().some((a) => a.effect && a.effect.target && a.effect.target.closest && a.effect.target.closest(".ring")));
const settledAt = (fs, id) => fs.findIndex((f, i) => fs.slice(i).every((g) => g.r[id].off === fs.at(-1).r[id].off));

test("刚打开:拿到回合时间前只画空轨道;拿到后本圈从起点长到位,不提示跨圈", { timeout: 60_000 }, async (t) => {
  const { page, st, url, errors } = await open(t);
  const release = hold(st);
  await page.goto(url);
  await page.waitForSelector("svg.ring[data-r]");
  const f0 = await frame(page);
  assert.deepEqual(Object.keys(f0.r).sort(), ["r1", "r2", "r3"], "没登记预计的不画圆环");
  for (const id of ["r1", "r2", "r3"]) assert.deepEqual([f0.r[id].pend, f0.r[id].op, f0.r[id].off, f0.r[id].dots, f0.r[id].under], [true, 0.4, 100, 0, TRACK], id + ":等数据时淡着、空轨道(不按开始到现在画)");
  if (SHOTS) await page.locator(".col.doing").screenshot({ path: path.join(SHOTS, "ring-pending.png") });
  release();
  await landed(page);
  const fs1 = await frames(page), last = fs1.at(-1).r;
  // r1 15m / 1h、r2 50m / 40m(第 2 圈 1/4)、r3 10m / 30m:都从本圈起点(dashoffset 100)长到位,只往前
  for (const [id, to, dots] of [["r1", 75, 0], ["r2", 75, 1], ["r3", 66.67, 0]]) {
    const o = offs(fs1, id);
    assert.ok(o.filter((v) => between(v, 100, to)).length >= 5, id + " 有中间帧:" + o.join(","));
    assert.ok(o.every((v, i) => i === 0 || v <= o[i - 1] + 0.01), id + " 只往前长:" + o.join(","));
    assert.ok(fs1.every((f) => f.r[id].dots === dots), id + " 圈心点数不变");
    assert.equal(last[id].off, to, id + " 停在实际位置");
  }
  assert.deepEqual([last.r1.arc, last.r2.arc, last.r2.under, last.r3.arc], [BLUE, YELLOW, BLUE, INK3], "在跑第 1 圈蓝;第 2 圈满圈蓝 + 黄弧;停了的第 1 圈灰");
  await idle(page);
  assert.ok(Object.values((await frame(page)).r).every((x) => x.op === 1 && !x.pend), "拿到数据后不再淡着");
  onlyFadeIn(await cues(page), 3);
  assert.deepEqual(errors, []);
});

test("数据更新:平滑走到新位置;跨过整圈时光环散开、圈心点弹一下(只动 transform / opacity,一次);往回走不提示;静止时没有动画", { timeout: 60_000 }, async (t) => {
  const { page, st, url, errors } = await open(t);
  await page.goto(url);
  await landed(page);
  await frames(page);
  await idle(page);
  await page.clock.runFor(2000);
  assert.deepEqual((await frame(page)).anims, [], "静止时圆环上没有任何动画");
  onlyFadeIn(await cues(page), 3);
  await page.evaluate(() => { window.__anims.length = 0; window.__halos.length = 0; });
  if (SHOTS) await page.locator(".cols").screenshot({ path: path.join(SHOTS, "ring-lanes.png") });
  // r1 跨过第 1 圈:15m → 70m(预计 1h)
  st.used.w1 = 70;
  await nextPoll(page, () => +document.querySelector('svg.ring[data-r="r1"]').dataset.x > 1);
  const up = await frames(page), o = offs(up, "r1"), d = up.map((f) => f.r.r1.dots);
  assert.ok(up.some((f) => f.r.r1.dots === 0 && between(f.r.r1.off, 75, 0)), "先把第 1 圈走满:" + o.join(","));
  assert.ok(up.some((f) => f.r.r1.dots === 1 && between(f.r.r1.off, 100, 83.33)), "再从 12 点长出第 2 圈:" + o.join(","));
  const c = await cues(page);
  assert.deepEqual(c.halos.map((h) => [h.r, h.dots, h.stroke]), [["r1", 1, YELLOW]], "跨过第 1 圈时提示一次:黄色光环(新一圈的颜色),圈心已是 1 点 " + JSON.stringify(c.halos));
  assert.ok(c.halos[0].off > 83.33 && c.halos[0].off <= 100, "提示在刚进第 2 圈那一帧(黄弧还没长到位):" + c.halos[0].off);
  assert.deepEqual([...new Set(c.anims)].sort(), ["dts:transform", "halo:opacity", "halo:transform"], "细环散开(transform)、淡出(opacity)、圈心点弹一下(transform)");
  assert.ok(settledAt(up, "r1") >= 30, "走了约一圈:600ms(约 37 帧)" + settledAt(up, "r1"));
  assert.ok(d.indexOf(1) > 0, "先走完第 1 圈再进第 2 圈:" + d.join(""));
  for (const id of ["r2", "r3"]) assert.equal(new Set(offs(up, id)).size, 1, id + " 没变就不动");
  // 小步(r3 10m → 11m,1/30 圈)走得快:约 264ms(17 帧)到位,也有中间帧
  st.used.w3 = 11;
  await nextPoll(page, () => +document.querySelector('svg.ring[data-r="r3"]').dataset.x > 0.34);
  const small = await frames(page, 30);
  assert.ok(settledAt(small, "r3") <= 18 && offs(small, "r3").some((v) => between(v, 66.67, 63.33)), "小步 264ms 走完:" + offs(small, "r3").join(","));
  // 差一圈以上(r2 50m → 200m,1.25 → 满 4 圈):直接画到位,跨进新圈照样提示一次(红色,圈心 3 点)
  st.used.w2 = 200;
  await nextPoll(page, () => +document.querySelector('svg.ring[data-r="r2"]').dataset.x >= 4);
  const far = await frames(page, 4);
  assert.deepEqual([...new Set(offs(far, "r2"))], [0], "直接画到满圈,不连扫几圈");
  assert.deepEqual([far[0].r.r2.arc, far[0].r.r2.under, far[0].r.r2.dots], [RED, RED, 3]);
  assert.deepEqual((await cues(page)).halos.map((h) => [h.r, h.dots, h.stroke]), [["r1", 1, YELLOW], ["r2", 3, RED]], "跨圈提示各一次");
  const end = up.at(-1).r.r1;
  assert.deepEqual([end.off, end.arc, end.under, end.dots], [83.33, YELLOW, BLUE, 1], "停在 70m / 1h:满圈蓝 + 黄弧 1/6,圈心 1 点");
  await page.waitForFunction(() => !document.querySelector(".ring .halo"));
  assert.deepEqual((await frame(page)).anims, [], "提示跑完就没了");
  // 预计改大(etaadj = 1h30m):70m / 1h30m 退回第 1 圈,不提示
  st.data.rounds[0].etaadj = "1h30m"; st.data.updated = iso(T + 1000);
  await nextPoll(page, () => +document.querySelector('svg.ring[data-r="r1"]').dataset.x < 1);
  const down = await frames(page), od = offs(down, "r1");
  assert.ok(down.some((f) => f.r.r1.dots === 1 && between(f.r.r1.off, 83.33, 100)) && down.some((f) => f.r.r1.dots === 0 && between(f.r.r1.off, 0, 22.22)), "往回走:黄弧缩回 12 点,再退到蓝圈 7/9:" + od.join(","));
  assert.deepEqual((await cues(page)).halos.length, 2, "往回走不提示");
  const back = down.at(-1).r.r1;
  assert.deepEqual([back.off, back.arc, back.under, back.dots], [22.22, BLUE, TRACK, 0]);
  assert.deepEqual(errors, []);
});

test("刷新页面:先画在本机记着的位置,拿到数据后接着走;跨圈也不提示", { timeout: 60_000 }, async (t) => {
  const { page, st, url, errors } = await open(t);
  await page.goto(url);
  await landed(page);
  await frames(page);
  assert.equal((await frame(page)).r.r1.off, 75);
  st.used.w1 = 70; // 70m / 1h:第 2 圈 1/6
  const release = hold(st);
  await page.reload();
  await page.waitForSelector("svg.ring[data-r]");
  const f0 = (await frame(page)).r;
  assert.deepEqual([f0.r1.pend, f0.r1.op, f0.r1.off, f0.r1.dots, f0.r2.off, f0.r2.dots, f0.r2.under], [true, 1, 75, 0, 75, 1, BLUE], "等数据时画在上次的位置(有记着的位置不变淡)");
  release();
  await landed(page);
  const fs1 = await frames(page);
  assert.ok(fs1.some((f) => f.r.r1.dots === 0 && between(f.r.r1.off, 75, 0)) && fs1.some((f) => f.r.r1.dots === 1 && between(f.r.r1.off, 100, 83.33)), "从 1/4 接着走过 12 点:" + offs(fs1, "r1").join(","));
  onlyFadeIn(await cues(page), 0);
  assert.deepEqual([fs1.at(-1).r.r1.off, fs1.at(-1).r.r1.dots], [83.33, 1]);
  // 隔了很久再打开(差一圈以上:70m → 200m):直接画到位,不连扫几圈,也不提示
  st.used.w1 = 200;
  const release2 = hold(st);
  await page.reload();
  await page.waitForSelector("svg.ring[data-r]");
  release2();
  await landed(page);
  const fs2 = await frames(page, 6);
  assert.deepEqual([...new Set(offs(fs2, "r1"))], [66.67], "直接画到位(200m / 1h = 第 4 圈 1/3),不连扫几圈");
  assert.deepEqual([fs2[0].r.r1.arc, fs2[0].r.r1.dots], [RED, 3]);
  onlyFadeIn(await cues(page), 0);
  assert.deepEqual(errors, []);
});

test("减少动态效果:直接画到新位置,没有中间帧和动画,颜色和圈心点照换", { timeout: 60_000 }, async (t) => {
  const { page, st, url, errors } = await open(t, { reduce: true });
  await page.goto(url);
  await landed(page);
  const f0 = (await frame(page)).r;
  assert.deepEqual([f0.r1.off, f0.r2.off, f0.r2.dots], [75, 75, 1], "拿到数据就画在实际位置,不从起点长");
  st.used.w1 = 70;
  await nextPoll(page, () => +document.querySelector('svg.ring[data-r="r1"]').dataset.x > 1);
  const fs1 = await frames(page, 20);
  assert.deepEqual([...new Set(offs(fs1, "r1"))], [83.33], "没有中间帧");
  assert.deepEqual(await cues(page), { halos: [], anims: [] }, "没有动画、不提示");
  assert.deepEqual([fs1[0].r.r1.arc, fs1[0].r.r1.under, fs1[0].r.r1.dots], [YELLOW, BLUE, 1], "颜色和圈心点照换");
  assert.deepEqual(errors, []);
});
