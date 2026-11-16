// 真浏览器回归(2026-10-24):对齐页会话小卡在「进行中」「阻塞」两栏画回 4px 用时进度条(8936ea13 去掉过,用户要回来)。
// - 填充 = 已用 / max(已用, 预计);超出预计时满条,预计处画刻度;进行中、阻塞超出预计变琥珀,待验收保持灰色;
// - 在跑的进度条蓝色,阻塞(停住不计时)深灰;
// - 预计只认轮次登记的 eta / etaadj:没登记的只写已用,不画进度条、不变琥珀(8936ea13 定的,保留);
// - 用时圆环、「已用 / 预计」文字不变。
// - 窄屏放不下时阻塞卡的暂停图标不让位(First Mate 2026-10-24 定:它是分辨「阻塞」的信号),圆环先让;
//   别的都让完了还放不下,才截断时长文字,悬停看全文。RED = 让位清单里暂停图标排在圆环前面,420 宽下被挤掉。
// RED = 8936ea13 之后的模板(进行中 / 阻塞没有 .pbar);8936ea13 之前 .pbar.blk>i 排在 .pbar.hot>i 后面,阻塞超出预计画成深灰。
// 页面由 align.mjs render() 生成,本地 http 服务给页面、/data、/alignment/todos;依赖本机 playwright-core(同 page-browser.test.mjs)。
// ALIGN_SHOTS=<目录> 时另存宽屏 / 420 宽的泳道截图。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "align-card-bar-"));
process.env.ALIGN_STORE = dir;
process.env.ALIGN_WORKSPACES = path.join(dir, "workspace.json");
const A = await import("../cli/align.mjs");
const { chromium } = createRequire((process.env.DSH_ALIGN_PW_DIR ? path.join(process.env.DSH_ALIGN_PW_DIR, "package.json") : import.meta.url))("playwright-core");
// 一个文件只起一个 Chromium,各用例自己开 context(隔离不变)
let browserP;
const getBrowser = () => (browserP ??= chromium.launch({ headless: true }));
test.after(async () => { if (browserP) await (await browserP.catch(() => null))?.close(); });

const T = Date.parse("2026-10-24T10:00:00Z"), MIN = 60_000, ago = (m) => T - m * MIN, iso = (ms) => new Date(ms).toISOString();
// [id, 标题, status, eta, 开始于几分钟前, live, 回合区间]
const SPEC = [
  ["under", "在跑没超时", "doing", "20m", 6, "running", [[ago(6), null]]],
  ["over", "在跑超时", "doing", "20m", 26, "running", [[ago(26), null]]],
  ["noeta", "没登记预计", "doing", null, 12, "running", [[ago(12), null]]],
  ["bover", "停了超时", "doing", "20m", 40, "idle", [[ago(40), ago(10)]]],
  ["bunder", "停了没超时", "doing", "1h", 40, "idle", [[ago(40), ago(30)]]],
  ["bapprox", "停了拿不到回合", "doing", "1h", 599, "idle", null], // 没有回合数据:已用按墙钟算,写「约 9h59」
  ["bfault", "出错停了", "doing", "20m", 40, "idle", [[ago(40), ago(15)]], { fault: "boom" }], // 出错图标 + 暂停图标 + 时长,420 宽下最挤
  ["vdone", "交了结果", "done", "20m", 60, "idle", [[ago(60), ago(5)]]],
];
const data = {
  version: 3, name: "cb", title: "进度条", owner: "session-fm", updated: iso(T), projects: [{ id: "p1", title: "dsh-core", cwd: "C:/p/p1" }],
  rounds: SPEC.map(([id, title, status, eta, m, , , x]) => ({
    id, sid: "session-" + id, title, status, proj: "p1", started: iso(ago(m)), next: "继续", ...x,
    ...(eta ? { eta } : {}), ...(status === "done" ? { ended: iso(ago(5)), result: "交了" } : {}),
  })),
  decisions: [], notes: [],
};
const live = Object.fromEntries(SPEC.map(([id, , , , , l]) => ["session-" + id, l]));
const activity = Object.fromEntries(SPEC.filter((s) => s[6]).map(([id, , , , , , a]) => ["session-" + id, a]));

function serve() {
  const html = A.render(data);
  const server = createServer((req, res) => {
    const p = req.url.split("?")[0];
    const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (p === "/alignment/p/cb") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(html); }
    if (p === "/alignment/p/cb/data") return json(200, { ...data, live });
    if (p === "/alignment/health") return json(200, { ok: true, api: A.API_VERSION });
    if (p === "/alignment/todos") return json(200, { ok: true, api: 2, sessions: {}, activity });
    if (p === "/alignment/fm") return json(200, { ok: true, page: "cb", fm: { sid: "session-fm", title: "first mate" }, refresh: null });
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, base: "http://127.0.0.1:" + server.address().port })));
}

async function open(t, width) {
  const { server, base } = await serve();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await getBrowser();
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  page.setDefaultTimeout(5000);
  await page.clock.setFixedTime(T); // Date.now 固定在 T,定时器照常走(轮询照发)
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base + "/alignment/p/cb?theme=light");
  // 等 /alignment/todos 的回合区间到了、按回合算出已用(「约」消失)再读
  await page.waitForFunction(() => { const c = [...document.querySelectorAll(".cols .sc")].find((e) => e.querySelector(".sc-tx")?.textContent === "在跑超时"); return !!c && !/约/.test(c.querySelector(".tm")?.textContent || "约"); }, null, { timeout: 15000 });
  return { page, errors };
}

// 每张小卡:所在栏、进度条 class、填充宽度、刻度位置、填充颜色(和页面里 --blue / --amber2 / --ink3 / --ink4 的实际颜色比)
const cards = (page) => page.evaluate(() => {
  const host = document.querySelector(".cols");
  const color = (v) => { const s = document.createElement("span"); s.style.background = "var(" + v + ")"; host.appendChild(s); const c = getComputedStyle(s).backgroundColor; s.remove(); return c; };
  const ref = { blue: color("--blue"), amber: color("--amber2"), ink3: color("--ink3"), ink4: color("--ink4") };
  const name = (c) => Object.keys(ref).find((k) => ref[k] === c) || c;
  return Object.fromEntries([...host.querySelectorAll(".sc")].map((e) => {
    const bar = e.querySelector(".pbar"), i = bar?.querySelector("i"), b = bar?.querySelector("b"), tm = e.querySelector(".tm");
    const card = e.getBoundingClientRect(), br = bar?.getBoundingClientRect();
    return [e.querySelector(".sc-tx").textContent, {
      col: [...e.closest(".col").classList].find((k) => k !== "col"),
      bar: bar ? [...bar.classList].filter((k) => k !== "pbar").sort().join(" ") : null,
      fill: i ? +parseFloat(i.style.width).toFixed(1) : null, tick: b ? +parseFloat(b.style.left).toFixed(1) : null,
      color: i ? name(getComputedStyle(i).backgroundColor) : null,
      h: br ? Math.round(br.height) : null,
      inside: br ? br.left >= card.left && br.right <= card.right && br.bottom <= card.bottom && br.width > card.width / 2 : null,
      ring: !!e.querySelector(".ring"), tm: tm?.textContent ?? null, ps: !!e.querySelector(".ps:not(.fit-x)"),
      tmAmber: !!tm && getComputedStyle(tm).color === ref.amber,
    }];
  }));
});
const pick = (c, k, keys) => Object.fromEntries(keys.map((x) => [x, c[k]?.[x]]));
// 截图:视口加高(宽度不变,让位结果不变)、泳道滚回顶部,按元素位置裁整页截图(元素截图会被泳道区的内部滚动裁掉)
async function shoot(page, sel, name) {
  const vw = page.viewportSize().width;
  await page.setViewportSize({ width: vw, height: 2000 });
  await page.evaluate(() => { for (let el = document.querySelector(".cols"); el; el = el.parentElement) el.scrollTop = 0; });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const box = await page.locator(sel).boundingBox();
  await page.screenshot({ path: path.join(process.env.ALIGN_SHOTS, name), clip: { x: box.x - 4, y: box.y - 4, width: box.width + 8, height: box.height + 8 } });
}
const K = ["col", "bar", "fill", "tick", "color", "h"];

test("进行中 / 阻塞小卡画用时进度条:已用 / 预计,超出变琥珀;没登记预计的不画;圆环和「已用 / 预计」照旧", { timeout: 60_000 }, async (t) => {
  const { page, errors } = await open(t, 1440);
  const c = await cards(page);
  assert.deepEqual(pick(c, "在跑没超时", K), { col: "doing", bar: "run", fill: 30, tick: null, color: "blue", h: 4 }, "在跑:蓝色,填充 6 / 20");
  assert.deepEqual(pick(c, "在跑超时", K), { col: "doing", bar: "hot run", fill: 100, tick: 76.9, color: "amber", h: 4 }, "超出预计:满条琥珀,刻度在 20 / 26");
  assert.deepEqual(pick(c, "停了超时", K), { col: "blk", bar: "blk hot", fill: 100, tick: 66.7, color: "amber", h: 4 }, "阻塞里超出预计也变琥珀,刻度在 20 / 30");
  assert.deepEqual(pick(c, "停了没超时", K), { col: "blk", bar: "blk", fill: 16.7, tick: null, color: "ink3", h: 4 }, "阻塞没超出:深灰,停在 10 / 60");
  assert.deepEqual(pick(c, "交了结果", K), { col: "done", bar: "", fill: 100, tick: 36.4, color: "ink4", h: 4 }, "待验收:满条灰色,超出不变琥珀,刻度在 20 / 55");
  assert.deepEqual(pick(c, "没登记预计", ["col", "bar", "ring", "tm", "tmAmber"]), { col: "doing", bar: null, ring: false, tm: "12m", tmAmber: false }, "没登记预计:只写已用,不画进度条、不变琥珀");
  for (const k of ["在跑没超时", "在跑超时", "停了超时", "停了没超时"]) assert.equal(c[k].ring, true, k + ":用时圆环还在");
  assert.deepEqual([c["在跑没超时"].tm, c["在跑超时"].tm, c["停了超时"].tm], ["6m / 20m", "26m / 20m", "30m / 20m"], "「已用 / 预计」文字照旧");
  assert.deepEqual([c["停了超时"].ps, c["停了没超时"].ps], [true, true], "阻塞卡有暂停图标");
  assert.equal(await page.locator(".sc-m.cut").count(), 0, "宽屏不截断时长");
  if (process.env.ALIGN_SHOTS) await shoot(page, ".cols", "card-bar-1440.png");
  assert.deepEqual(errors, []);
});

test("窄屏(约 420 宽的侧栏):进行中 / 阻塞小卡的进度条照样画出,不撑出卡片", { timeout: 60_000 }, async (t) => {
  const { page, errors } = await open(t, 420);
  const c = await cards(page);
  for (const k of ["在跑没超时", "在跑超时", "停了超时", "停了没超时"]) assert.deepEqual(pick(c, k, ["h", "inside"]), { h: 4, inside: true }, k);
  assert.deepEqual(pick(c, "在跑超时", ["bar", "color"]), { bar: "hot run", color: "amber" });
  assert.equal(c["没登记预计"].bar, null);
  if (process.env.ALIGN_SHOTS) await shoot(page, ".cols", "card-bar-420.png");
  assert.deepEqual(errors, []);
});

test("窄屏(420):阻塞卡的暂停图标不让位,圆环先让;时长放不下全部时才截断,悬停看全文", { timeout: 60_000 }, async (t) => {
  const { page, errors } = await open(t, 420);
  const g = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll(".cols .col.blk .sc")].map((e) => {
    const m = e.querySelector(".sc-m"), ps = m.querySelector(".ps"), tm = m.querySelector(".tm"), tv = tm.querySelector(".tv");
    const shown = (x) => !!x && !x.classList.contains("fit-x") && x.getBoundingClientRect().width >= 10;
    const card = e.getBoundingClientRect(), pr = ps?.getBoundingClientRect();
    return [e.querySelector(".sc-tx").textContent, {
      ps: shown(ps) && pr.left >= card.left && pr.right <= card.right,
      fault: shown(m.querySelector(".rs.fault")),
      ring: shown(m.querySelector(".rg")),
      full: !!tv && tv.scrollWidth <= tv.clientWidth,
      fits: m.scrollWidth <= m.clientWidth,
      tip: tm.getAttribute("data-tip-h"),
      psW: ps ? Math.round(ps.getBoundingClientRect().width) : null,
    }];
  })));
  assert.equal(new Set(Object.values(g).map((x) => x.psW)).size, 1, "同一栏的暂停图标一样宽: " + JSON.stringify(Object.values(g).map((x) => x.psW)));
  for (const x of Object.values(g)) delete x.psW;
  assert.deepEqual(g["停了超时"], { ps: true, fault: false, ring: false, full: true, fits: true, tip: "已用 30m / 预计 20m" }, "暂停图标留着,圆环让出,时长完整");
  assert.deepEqual(g["停了没超时"], { ps: true, fault: false, ring: false, full: true, fits: true, tip: "已用 10m / 预计 1h" });
  assert.deepEqual(g["停了拿不到回合"], { ps: true, fault: false, ring: false, full: false, fits: true, tip: "已用 约 9h59 / 预计 1h" }, "「约 9h59」和暂停图标放不下:截断时长,暂停图标留着,悬停看全文");
  assert.deepEqual(g["出错停了"], { ps: true, fault: true, ring: false, full: true, fits: true, tip: "已用 25m / 预计 20m" }, "出错图标、暂停图标、时长都完整(先收紧间距再截断)");
  if (process.env.ALIGN_SHOTS) await shoot(page, ".cols .col.blk", "blk-420.png");
  assert.deepEqual(errors, []);
});
