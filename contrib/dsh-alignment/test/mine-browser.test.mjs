// 真浏览器（2026-11-02，personal-ops 搬到对齐页第 2 轮）：详情区「我的」页签和今日推荐的「我来做」。
// 没有待办和目标的页面也有这个页签，只有「记一条」（本机文件打开时没有）；待办分今天 / 以后 / 已派出，卡上有优先级、精力、用时、已过几天、目标、几个会话在等；目标详情有关键结果、待办、会话、进度记录。
// 操作和决定一样先选、再从发送条发出：记一条、勾完成、放进 / 移出今天、记进度、派出去做（发给 First Mate）、推荐「我来做」。
// ALIGN_MINE_SHOTS=<目录> 时存下宽屏和窄屏截图。依赖插件 devDependencies 里的 playwright-core（DSH_ALIGN_PW_DIR 覆盖），缺失即失败。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { minePage, SID } from "./fixtures/mine-page.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "align-mine-web-"));
process.env.ALIGN_STORE = dir;
process.env.ALIGN_WORKSPACES = path.join(dir, "workspace.json");
fs.writeFileSync(process.env.ALIGN_WORKSPACES, JSON.stringify({ workspaces: [] }));
const A = await import("../cli/align.mjs");
const { chromium } = createRequire((process.env.DSH_ALIGN_PW_DIR ? path.join(process.env.DSH_ALIGN_PW_DIR, "package.json") : import.meta.url))("playwright-core");

const p2 = (n) => String(n).padStart(2, "0");
const d0 = new Date(), TODAY = d0.getFullYear() + "-" + p2(d0.getMonth() + 1) + "-" + p2(d0.getDate());
const name = "mine", plain = "plain";
const file = path.join(dir, name + ".html"), plainFile = path.join(dir, plain + ".html");
fs.writeFileSync(file, A.render(minePage(name, TODAY)));
// 没有待办和目标的旧页面
const old = minePage(plain, TODAY);
delete old.todos; delete old.goals; for (const r of old.rounds) { delete r.goal; delete r.wait; }
fs.writeFileSync(plainFile, A.render(old));
fs.writeFileSync(path.join(dir, "pages.json"), JSON.stringify({ [name]: file, [plain]: plainFile }));
const shots = process.env.ALIGN_MINE_SHOTS;

let api = A.API_VERSION;
const sent = [];
const handler = A.createHandler({ prefix: A.ROUTE_PREFIX, send: async (sid, text, card) => { sent.push({ sid, text, card }); }, guard: () => null,
  live: async (sids) => Object.fromEntries(sids.map((s) => [s, s === SID(2) || s === SID(4) ? "running" : "idle"])) });
const server = createServer((req, res) => {
  const p = req.url.split("?")[0];
  const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (p.endsWith("/log")) return json(200, { ok: true });
  if (p === "/alignment/health") return json(200, { ok: true, api });
  if (p === "/alignment/todos") return json(200, { ok: true, api: 2, sessions: {}, activity: {} });
  if (p === "/alignment/fm") return json(200, { ok: true, page: name, fm: { sid: SID(9), title: "first mate" }, refresh: null });
  if (p === "/alignment/tools") return json(200, { ok: true, api: 1, rounds: {} });
  return handler(req, res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + server.address().port + "/alignment/p/";
const browser = await chromium.launch({ headless: true });
test.after(async () => { await browser.close(); server.closeAllConnections(); server.close(); });

async function open(page, w, h, k = name, hash = "", opt = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, ...opt });
  const pg = await ctx.newPage();
  pg.setDefaultTimeout(5000);
  const errors = [];
  pg.on("pageerror", (e) => errors.push(String(e)));
  await pg.goto(base + k + hash);
  await pg.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
  // 网址带 #t= / #g= 在窄屏打开时是详情那一层，左栏（页签在里面）隐藏：只等它挂上
  await pg.waitForSelector('[data-act="tab"]', { state: "attached" });
  return { pg, ctx, errors };
}
const send = async (pg, n) => { await pg.click(".sendbar .send"); await pg.waitForSelector(".toast.ok"); assert.match(await pg.textContent(".toast.ok"), new RegExp("已发送 " + n + " 项")); };

// 2026-11-03（mine-tab-empty，用户 11-02 定）：没有待办和目标也总有「我的」，空时只有「记一条」；本机文件打开（不能发送）时没有这个页签
test("没有待办和目标：「我的」页签照样有，空时只有「记一条」；本机文件打开时没有", { timeout: 60_000 }, async () => {
  const { pg, ctx, errors } = await open(null, 1280, 900, plain);
  assert.deepEqual(await pg.$$eval('[data-seg="tab"] [role="tab"]', (xs) => xs.map((x) => x.dataset.v)), ["sess", "dec", "mine"]);
  assert.equal(await pg.$$eval('[data-act="tab"][data-v="mine"] .mc', (x) => x.length), 0, "没有待办时不带数");
  await pg.click('[data-act="tab"][data-v="mine"]');
  await pg.waitForSelector('.mn-fr.bare [data-act="madd"]');
  assert.equal(await pg.$$eval('.mn-fr .fchips, .mn-l .lempty, .mn-c, .mn-gc, .mn-g', (x) => x.length), 0, "没有筛选胶囊、空列表提示和分组");
  assert.equal((await pg.innerText('.mn-fr')).trim(), "记一条");
  if (shots) await pg.screenshot({ path: path.join(shots, "mine-empty-1280.png") });
  // 记一条：加上后出现待发送的卡和筛选胶囊
  await pg.click('[data-act="madd"]');
  await pg.fill('[data-in="madd"]', "给家里电脑装驱动");
  await pg.keyboard.press("Enter");
  await pg.waitForSelector(".mn-fr .fchips");
  assert.match(await pg.innerText(".mn-l"), /给家里电脑装驱动/);
  await pg.click('.mn-c.picked .mn-x');
  await pg.waitForSelector('.mn-fr.bare');
  await ctx.close();
  // 窄屏 420：「记一条」的字照样显示（有筛选胶囊时才缩成图标）
  const n = await open(null, 420, 900, plain);
  await n.pg.click('[data-act="tab"][data-v="mine"]');
  await n.pg.waitForSelector('.mn-fr.bare [data-act="madd"]');
  assert.ok(await n.pg.$eval('.mn-fr.bare .mn-al', (e) => e.getBoundingClientRect().width > 20), "窄屏也显示「记一条」三个字");
  if (shots) await n.pg.screenshot({ path: path.join(shots, "mine-empty-420.png") });
  await n.ctx.close();
  // 本机文件打开：没法发送，不出「我的」
  const f = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const fp = await f.newPage();
  fp.setDefaultTimeout(5000);
  await fp.goto("file:///" + plainFile.replace(/\\/g, "/"));
  await fp.waitForSelector('[data-act="tab"]');
  assert.deepEqual(await fp.$$eval('[data-seg="tab"] [role="tab"]', (xs) => xs.map((x) => x.dataset.v)), ["sess", "dec"]);
  await f.close();
  assert.deepEqual([...errors, ...n.errors], []);
});

test("「我的」：待办分组和卡上的信息、目标详情、已完成；宽屏 1280 / 窄屏 420", { timeout: 120_000 }, async () => {
  // 减少动态：大数字不从 0 数上去，截图里是最终值
  const { pg, ctx, errors } = await open(null, 1280, 1000, name, "", { reducedMotion: "reduce" });
  // 页签：第三个是「我的」，数字 = 待办 / 在做的条数
  assert.deepEqual(await pg.$$eval('[data-seg="tab"] [role="tab"]', (xs) => xs.map((x) => x.dataset.v)), ["sess", "dec", "mine"]);
  assert.equal(await pg.textContent('[data-act="tab"][data-v="mine"] .mc'), "6");
  await pg.click('[data-act="tab"][data-v="mine"]');
  assert.deepEqual(await pg.$$eval(".fchips .fc[data-act=mf]", (xs) => xs.map((x) => x.textContent.trim())), ["待办 6", "目标 3", "已完成 2"]);
  assert.deepEqual(await pg.$$eval(".mn-g>h3 .tt", (xs) => xs.map((x) => x.textContent)), ["今天", "以后", "已派出"]);
  // 今天：在做的在前；卡上优先级 · 紧急度、精力、用时、已过 N 天、目标、N 个会话在等
  const today = await pg.$$eval('.mn-g[aria-label="今天"] .mn-c', (xs) => xs.map((x) => x.innerText.replace(/\s+/g, " ")));
  assert.equal(today.length, 2);
  assert.match(today[0], /^寅子的数据集.*在做 P0 · 正常 中能量 2h 已过 6 天 寅子数据集/);
  assert.match(today[1], /^找 Tianyi.*P0 · 紧急 低能量 10m 已过 5 天 旁白 11 月上线.* 1 个会话在等/);
  assert.equal(await pg.$$eval('.mn-g[aria-label="以后"] .mn-c', (x) => x.length), 4);
  assert.match(await pg.textContent('.mn-g[aria-label="已派出"] .mn-c'), /镜头内上下文.*旁白：镜头内上下文对照截图/);
  // 点待办：右栏详情（说明、目标、在等它的会话、记录）和操作按钮；面包屑「我的 › 待办 › 标题」
  await pg.click('.mn-c[data-id="t-tianyi"] .mn-go');
  assert.match(await pg.textContent(".rbody .dh h1"), /^找 Tianyi/);
  assert.match(await pg.textContent(".rbody .dh .chips"), /今天 · 从 .* 起.*P0 · 紧急.*低能量.*10m.*截止 .* · 已过 5 天/);
  const facts = await pg.$$eval(".rbody .fact .fl", (xs) => xs.map((x) => x.textContent));
  assert.deepEqual(facts, ["说明", "目标", "在等它", "记录"]);
  assert.match(await pg.textContent(".rbody .fact:nth-child(3)"), /阻塞从禁用词里去掉/);
  assert.deepEqual(await pg.$$eval(".rfoot .btn", (xs) => xs.map((x) => x.textContent)), ["完成", "移出今天", "派出去做", "放弃"]);
  assert.match(await pg.textContent(".crumb .bc"), /我的.*待办.*找 Tianyi/);
  // 点目标链接 → 目标详情：数字卡、关键结果、进度记录、待办、会话
  await pg.click('.rbody .mn-gl [data-k="g:g-narr"]');
  assert.match(await pg.textContent(".rbody .dh h1"), /^旁白 11 月上线/);
  assert.match(await pg.textContent(".rbody .dh .chips"), /季度.*截止 .* · 剩 28 天.*highschool.*进行中/);
  // 大数字从 0 数上去（700ms），等数完
  await pg.waitForFunction(() => document.querySelector(".rbody .kpi [data-count]").textContent === "2");
  assert.deepEqual(await pg.$$eval(".rbody .kpi", (xs) => xs.map((x) => x.innerText.replace(/\s+/g, " ").trim())), ["连续跑通 2/ 10 局", "关键结果已达成 0/ 3"]);
  assert.deepEqual(await pg.$$eval(".rbody .mn-krs li", (xs) => xs.map((x) => x.innerText.replace(/\s+/g, " ").trim())), ["27B 接口稳定、并发 2 0 / 2", "离线测试集四项问题修完 3 / 4", "05 和 01 同时各跑一局 未开始"]);
  assert.match(await pg.textContent(".rbody .mn-pl"), /3离线测试集四项问题修完：句尾重复修好.*2 局01 团播跑通.*1 局01 跑通第一局/);
  const blk = await pg.$$eval(".rbody .mn-blk", (xs) => xs.map((x) => x.innerText.replace(/\s+/g, " ")));
  assert.match(blk[0], /^待办 2 找 Tianyi.* 镜头内上下文.* 已完成 1$/);
  assert.match(blk[1], /^会话 3 阻塞 从禁用词.* 进行中 旁白：镜头.* 待验收 旁白团播模式/);
  assert.deepEqual(await pg.$$eval(".rfoot .btn", (xs) => xs.map((x) => x.textContent)), ["记进度", "达成", "放弃"]);
  // 右栏单栏时正文最宽 780（DESIGN 第 4 节）
  assert.ok(await pg.$eval(".rbody>.bodyx", (e) => e.getBoundingClientRect().width) <= 780.5);
  // 会话行点了切到会话页签
  if (shots) await pg.screenshot({ path: path.join(shots, "mine-goal-1280.png") });
  await pg.click('.rbody .mn-s[data-k="r:r-duo"]');
  assert.equal(await pg.getAttribute('[data-act="tab"][data-v="sess"]', "aria-selected"), "true");
  // 目标筛选和已完成筛选
  await pg.click('[data-act="tab"][data-v="mine"]');
  await pg.click('.fc[data-act="mf"][data-v="goal"]');
  assert.deepEqual(await pg.$$eval(".mn-gc .mn-t", (xs) => xs.map((x) => x.textContent.slice(0, 6))), ["旁白 11 ", "寅子数据集：", "pcua 接"]);
  assert.match(await pg.textContent(".mn-gc:nth-child(2)"), /340 \/ 900 题/);
  await pg.click('.fc[data-act="mf"][data-v="done"]');
  assert.deepEqual(await pg.$$eval(".mn-g>h3 .tt", (xs) => xs.map((x) => x.textContent)), ["待办", "已放弃", "目标"]);
  assert.match(await pg.textContent('.mn-g[aria-label="待办"] .mn-c'), /^点头或否决/, "新完成的在前");
  // 窄屏 420（侧栏）：待办列表和待办详情
  await pg.click('.fc[data-act="mf"][data-v="todo"]');
  await pg.click('.mn-c[data-id="t-tianyi"] .mn-go');
  if (shots) await pg.screenshot({ path: path.join(shots, "mine-todo-1280.png") });
  await pg.setViewportSize({ width: 420, height: 860 });
  await pg.waitForTimeout(100);
  // 窄屏是两层（第 4 轮）：只量看得见的那一层。现在是详情那一层，回到列表再量列表
  const over = (sel) => pg.evaluate((sel) => [...document.querySelectorAll(sel)].filter((e) => e.checkVisibility({ visibilityProperty: true }) && e.scrollWidth > e.clientWidth + 1).map((e) => e.className + " " + e.scrollWidth + "/" + e.clientWidth + " " + e.textContent.slice(0, 30)), sel);
  assert.deepEqual(await over(".rbody .fact,.rfoot .btn"), [], "420 宽详情不横向溢出");
  if (shots) await pg.screenshot({ path: path.join(shots, "mine-todo-420.png") });
  await pg.click('[data-act="mback"]');
  assert.deepEqual(await over(".mn-c,.mn-gc"), [], "420 宽列表不横向溢出");
  await pg.click('[data-act="tab"][data-v="mine"]');
  await pg.click('.fc[data-act="mf"][data-v="goal"]');
  await pg.click('.mn-gc[data-k="g:g-narr"]');
  await pg.waitForFunction(() => document.querySelector(".rbody .kpi [data-count]").textContent === "2");
  if (shots) await pg.screenshot({ path: path.join(shots, "mine-goal-420.png") });
  assert.deepEqual(await over(".rbody .fact,.rbody .chip"), [], "目标详情 420 宽不横向溢出");
  // 面包屑不压住右边的工具按钮
  const [bc, tl] = await pg.evaluate(() => [document.querySelector(".crumb .bc").getBoundingClientRect().right, document.querySelector(".crumb .tools").getBoundingClientRect().left]);
  assert.ok(bc <= tl + 0.5, "面包屑 " + bc + " 不越过工具 " + tl);
  assert.equal(await pg.$eval(".crumb .bc", (e) => e.innerText.trim()), "旁白 11 月上线测试机：01、05 都用 Bellwether 连续跑通 10 局", "窄屏面包屑只留标题");
  // 回到列表那一层：目标卡不溢出；选中的筛选胶囊在视野里（窄屏一行横滚）
  await pg.click('[data-act="mback"]');
  assert.deepEqual(await over(".mn-gc,.mn-pb"), [], "目标列表 420 宽不横向溢出");
  assert.ok(await pg.$eval(".fchips .fc.on", (c) => { const r = c.getBoundingClientRect(), p = c.parentElement.getBoundingClientRect(), add = c.closest(".mn-fr").querySelector(".mn-add").getBoundingClientRect(); return r.left >= p.left - 0.5 && r.right <= p.right + 0.5 && (add.right <= r.left || add.left >= r.right); }), "选中的「目标」胶囊没被裁掉、没被「记一条」盖住");
  assert.ok(await pg.$eval(".fc.mn-add", (b) => { const r = b.getBoundingClientRect(), p = b.parentElement.getBoundingClientRect(); return r.left >= p.left - 0.5 && r.right <= p.right + 0.5; }), "窄屏「记一条」在视野里");
  assert.deepEqual(errors, []);
  await ctx.close();
});

test("「我的」的操作：记一条、勾完成、放进 / 移出今天、记进度、派出去做、推荐「我来做」；只有派出去做发消息", { timeout: 120_000 }, async () => {
  const { pg, ctx, errors } = await open(null, 1280, 1000, name, "#t=t-codex");
  assert.equal(await pg.getAttribute('[data-act="tab"][data-v="mine"]', "aria-selected"), "true", "#t= 直达待办");
  // 记一条（Enter）、再记一条放进今天；发送前先出现在对应的组里
  await pg.click('[data-act="madd"]');
  await pg.fill('[data-in="madd"]', "给家里电脑换电源");
  await pg.press('[data-in="madd"]', "Enter");
  await pg.click('[data-act="maddt"]');
  await pg.fill('[data-in="madd"]', "回张三邮件");
  await pg.click('[data-act="maddgo"]');
  assert.match(await pg.textContent('.mn-g[aria-label="今天"]'), /回张三邮件.*待发送：记一条/);
  assert.match(await pg.textContent('.mn-g[aria-label="以后"]'), /给家里电脑换电源/);
  // 勾完成（卡上的圆圈）、放进今天 / 移出今天（详情按钮）
  await pg.click('.mn-c[data-id="t-mac"] .mn-ck');
  assert.equal(await pg.getAttribute('.mn-c[data-id="t-mac"] .mn-ck', "aria-pressed"), "true");
  await pg.click('.mn-c[data-id="t-harness"] .mn-go');
  await pg.click('.rfoot [data-act="tact"][data-v="today"]');
  await pg.click('.mn-c[data-id="t-yinzi"] .mn-go');
  await pg.click('.rfoot [data-act="tact"][data-v="untoday"]');
  // 派出去做 + 补一句
  await pg.click('.mn-c[data-id="t-pair"] .mn-go');
  await pg.click('.rfoot [data-act="tact"][data-v="send"]');
  await pg.fill('[data-in="tnote"]', "先看上周的实测数据");
  // 记进度：目标本身；另一个目标记关键结果
  await pg.click('.fc[data-act="mf"][data-v="goal"]');
  await pg.click('.mn-gc[data-k="g:g-yinzi"]');
  await pg.click('.rfoot [data-act="gact"][data-v="progress"]');
  await pg.fill('[data-in="gcur"]', "420");
  await pg.fill('[data-in="gnote"]', "第二批标完");
  await pg.click('.mn-gc[data-k="g:g-narr"]');
  await pg.click('.rfoot [data-act="gact"][data-v="progress"]');
  await pg.selectOption('[data-in="gkr"]', "k1");
  await pg.fill('[data-in="gcur"]', "1");
  if (shots) await pg.screenshot({ path: path.join(shots, "mine-progress-1280.png") });
  // 推荐「我来做」
  await pg.click('[data-act="tab"][data-v="dec"]');
  await pg.click('.rcard [data-act="rec"][data-v="take"]');
  // 发送队列：8 项
  await pg.click('[data-act="queue"]');
  assert.deepEqual(await pg.$$eval("#queue .qk", (xs) => xs.map((x) => x.textContent)).then((x) => x.sort()), ["待办", "待办", "待办", "待办", "待办", "待办", "推荐", "目标", "目标"].sort());
  await pg.click('[data-act="queue"]');
  await send(pg, 9);

  // First Mate 只收到派出去做那一条（自包含：标题、目标、补充、派活命令）
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sid, SID(9));
  const msg = sent[0].text;
  assert.match(msg, /待办 · 用户选了「派出去做」：和 cua-pick-speed 会话 pair-thinking/);
  assert.match(msg, /所属目标：「pcua 接管日常 GUI 操作/);
  assert.match(msg, /用户补充：先看上周的实测数据/);
  assert.match(msg, /align todo dispatch mine t-pair <轮次 id>/);
  // 文件：各项都写上了
  const d = A.pageData(name);
  const t = (id) => d.todos.find((x) => x.id === id);
  assert.equal(t("t-mac").status, "done");
  assert.equal(t("t-harness").today, TODAY);
  assert.equal(t("t-yinzi").today, undefined);
  assert.equal(t("t-pair").status, "open", "派出去做：等 First Mate 跑 todo dispatch 才变已派出");
  assert.deepEqual(t("t-pair").log.at(-1).ev, "send");
  const added = d.todos.filter((x) => x.src === "手记" && /给家里电脑|回张三/.test(x.title));
  assert.deepEqual(added.map((x) => [x.title, !!x.today]).sort(), [["回张三邮件", true], ["给家里电脑换电源", false]]);
  const rec = d.todos.find((x) => x.src === "推荐");
  assert.equal(rec.title, "试一次 pcua 接管早报截图");
  assert.equal(rec.today, TODAY);
  const g = (id) => d.goals.find((x) => x.id === id);
  assert.equal(g("g-yinzi").cur, 420);
  assert.equal(g("g-yinzi").log.at(-1).note, "第二批标完");
  assert.equal(g("g-narr").kr[0].cur, 1);
  assert.equal(g("g-narr").cur, 2, "记的是关键结果，目标本身不动");
  // 页面：发送条清空；派出去做的待办挂「等 First Mate 派出」，详情里没有「派出去做」按钮
  await pg.waitForFunction(() => !document.querySelector(".sendbar"));
  await pg.click('[data-act="tab"][data-v="mine"]');
  await pg.click('.fc[data-act="mf"][data-v="todo"]');
  assert.match(await pg.textContent('.mn-c[data-id="t-pair"]'), /等 First Mate 派出/);
  await pg.click('.mn-c[data-id="t-pair"] .mn-go');
  assert.equal(await pg.$$eval('.rfoot [data-v="send"]', (x) => x.length), 0);
  assert.equal(await pg.$$eval('.mn-c[data-id="t-mac"]', (x) => x.length), 0, "勾掉的不在待办里了");

  // 放弃一条再在「已完成」里恢复
  await pg.click('.mn-c[data-id="t-codex"] .mn-go');
  await pg.click('.rfoot [data-act="tact"][data-v="drop"]');
  await send(pg, 1);
  assert.equal(A.pageData(name).todos.find((x) => x.id === "t-codex").status, "dropped");
  await pg.click('.fc[data-act="mf"][data-v="done"]');
  await pg.click('.mn-c[data-id="t-codex"] .mn-go');
  await pg.click('.rfoot [data-act="tact"][data-v="open"]');
  await send(pg, 1);
  assert.equal(A.pageData(name).todos.find((x) => x.id === "t-codex").status, "open");
  assert.equal(sent.length, 1, "只有派出去做发消息");
  assert.deepEqual(errors, []);
  await ctx.close();
});

// 2026-11-03（第 4 轮，mine-narrow-layout）：窄屏（≤ 760）「我的」是两层——列表占满详情区，点开待办 / 目标后详情占满、顶上「返回」；返回按钮、浏览器后退、Esc 都回到列表，刚才那张卡拿到焦点。宽屏不变
// （左栏列表 + 右栏详情，没有返回条）。
test("「我的」窄屏两层：420 列表 → 点进详情 → 返回 / 后退 / Esc 回到列表；1280 仍是两栏", { timeout: 60_000 }, async () => {
  const { pg, ctx, errors } = await open(null, 420, 860, name, "", { reducedMotion: "reduce" });
  const shown = (sel) => pg.$eval(sel, (e) => getComputedStyle(e).visibility !== "hidden" && e.getBoundingClientRect().width > 1);
  const layer = async () => [await shown(".left"), await shown(".right")];
  // 会话页签不受影响：仍是左右两栏
  assert.deepEqual(await layer(), [true, true], "会话 / 决定页签仍是两栏");
  await pg.click('[data-act="tab"][data-v="mine"]');
  assert.deepEqual(await layer(), [true, false], "列表那一层：左栏占满，详情不显示");
  assert.equal((await pg.innerText(".crumb .bc")).replace(/\s+/g, " ").trim(), "我的 待办", "列表那一层的面包屑不写还选着的会话");
  assert.ok(await pg.$eval(".left", (e) => e.getBoundingClientRect().width) > 400, "列表占满 420");
  if (shots) await pg.screenshot({ path: path.join(shots, "mine-list-420.png") });
  // 点待办 → 详情那一层
  await pg.click('.mn-c[data-id="t-tianyi"] .mn-go');
  assert.deepEqual(await layer(), [false, true], "详情那一层：列表不显示");
  assert.match(await pg.textContent(".rbody .dh h1"), /^找 Tianyi/);
  assert.equal((await pg.innerText(".rbody .mn-bk")).replace(/\s+/g, " ").trim(), "返回 我的 · 待办");
  assert.deepEqual(await pg.$$eval(".rfoot .btn", (xs) => xs.map((x) => x.textContent)), ["完成", "移出今天", "派出去做", "放弃"]);
  if (shots) await pg.screenshot({ path: path.join(shots, "mine-todo-detail-420.png") });
  // 浏览器后退（手机系统返回）回到列表，地址不离开本页
  const url = pg.url().split("#")[0];
  await pg.goBack();
  await pg.waitForFunction(() => !document.getElementById("app").classList.contains("mdet"));
  assert.deepEqual(await layer(), [true, false]);
  assert.equal(pg.url().split("#")[0], url, "后退只回到列表，不离开页面");
  assert.equal(await pg.evaluate(() => document.activeElement.closest(".mn-c")?.dataset.id), "t-tianyi", "刚才那张卡拿到焦点");
  // 目标：点进详情，顶上「返回」按钮回到列表
  await pg.click('.fc[data-act="mf"][data-v="goal"]');
  await pg.click('.mn-gc[data-k="g:g-narr"]');
  assert.deepEqual(await layer(), [false, true]);
  assert.match(await pg.innerText(".rbody .mn-bk"), /我的 · 目标/);
  if (shots) await pg.screenshot({ path: path.join(shots, "mine-goal-detail-420.png") });
  // 按钮行是贴底的实底条（第 9.3 节）：不透明、按钮不带悬浮落影
  assert.notEqual(await pg.$eval(".rfoot", (e) => getComputedStyle(e).backgroundColor), "rgba(0, 0, 0, 0)", "详情那一层按钮行有实底");
  // 关键结果：小条 72px，和「a / b」在同一行
  assert.deepEqual(await pg.$$eval(".rbody .mn-krs li", (xs) => xs.map((li) => { const b = li.querySelector(".mn-bar").getBoundingClientRect(), v = li.querySelector(".mn-v").getBoundingClientRect(); return [Math.round(b.width), Math.abs((b.top + b.bottom) / 2 - (v.top + v.bottom) / 2) < 8]; })), [[72, true], [72, true], [72, true]]);
  await pg.click('[data-act="mback"]');
  assert.deepEqual(await layer(), [true, false]);
  assert.equal(await pg.evaluate(() => document.activeElement.dataset.k), "g:g-narr");
  // 返回按钮已退掉进来时加的历史：再次点进、用 Esc 回来
  await pg.click('.mn-gc[data-k="g:g-narr"]');
  await pg.keyboard.press("Escape");
  assert.deepEqual(await layer(), [true, false], "Esc 回到列表");
  // 详情那一层里点下方泳道的会话卡：切到会话页签（两栏），再回「我的」是列表那一层
  await pg.click('.mn-gc[data-k="g:g-narr"]');
  await pg.click('[data-act="sess"]');
  assert.equal(await pg.getAttribute('[data-act="tab"][data-v="sess"]', "aria-selected"), "true");
  assert.deepEqual(await layer(), [true, true]);
  await pg.click('[data-act="tab"][data-v="mine"]');
  assert.deepEqual(await layer(), [true, false]);
  // 网址里直接带待办（#t=）打开：进的是详情那一层
  const d = await open(null, 420, 860, name, "#t=t-tianyi");
  assert.deepEqual([await d.pg.$eval(".app", (e) => e.classList.contains("mdet")), await d.pg.textContent(".rbody .dh h1").then((t) => /^找 Tianyi/.test(t))], [true, true]);
  await d.ctx.close();
  // 宽屏 1280：仍是左栏列表 + 右栏详情，没有返回条
  await pg.setViewportSize({ width: 1280, height: 900 });
  await pg.click('.mn-gc[data-k="g:g-narr"]');
  assert.deepEqual(await layer(), [true, true], "宽屏两栏都在");
  assert.equal(await pg.$eval(".rbody .mn-bk", (e) => getComputedStyle(e).display), "none");
  assert.deepEqual([...errors, ...d.errors], []);
  await ctx.close();
});

test("旧服务端：api 18 时待办和目标的改动不发，发送条说明要更新；api 16 时推荐卡没有「我来做」", { timeout: 60_000 }, async () => {
  api = 18;
  try {
    const { pg, ctx, errors } = await open(null, 1280, 900, name, "#t=t-codex");
    await pg.waitForFunction(() => document.querySelector('.rfoot [data-act="tact"]'));
    await pg.click('.rfoot [data-act="tact"][data-v="done"]');
    await pg.waitForSelector(".sendbar .blockmsg");
    assert.match(await pg.textContent(".sendbar .blockmsg"), /需要先更新 DSH 才能发送待办和目标的改动/);
    assert.ok(await pg.$eval(".sendbar .send", (b) => b.disabled));
    await ctx.close();
    api = 16;
    const o = await open(null, 1280, 900, name);
    await o.pg.click('[data-act="tab"][data-v="dec"]');
    await o.pg.waitForTimeout(200);
    assert.equal(await o.pg.$$eval('[data-act="rec"][data-v="take"]', (x) => x.length), 0);
    assert.deepEqual([...errors, ...o.errors], []);
    await o.ctx.close();
  } finally { api = A.API_VERSION; }
});
