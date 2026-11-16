// 真浏览器（2026-11-08）：对齐页看板最上面的 Curio 区（常驻 personal 会话）。数据来自 GET /alignment/curio（curio.js）和页面自己的轮次 / 决定：
// - 左边：名字 + 状态（在跑 / 暂停 / 阻塞 / 已停 / 目标已完成）、Goal 目标第一行、第 N / M 轮、开始时间、主会话模型；暂停时原因和预计继续时间；
//   子 agent n / 上限（一格一个）、子 agent 用的模型、冷却中的模型；挂在它轮次上的 open 决定个数，点了切到「决定」页签选中最急的一条。
// - 右边：最近完成的轮次（待验收 / 已完成，新的在上，最多 4 个）：标题去掉开头的「Curio」「personal Agent：」、结果第一句、证据文件链接；点标题选中那一轮。
// - Curio 的会话不再进四个状态列（别的会话照旧）；取不到 / 旧服务端 404 / curio:null 时没有 Curio 区，它的卡回到看板；
//   服务端报错时 Curio 区写出原因。窄屏（≤ 1100）上下排。
// 页面由 align.mjs render() 生成，依赖本机 playwright-core（同 work-browser.test.mjs）。CURIO_SHOTS=<目录> 另存截图。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "align-curio-browser-"));
process.env.ALIGN_STORE = dir;
process.env.ALIGN_WORKSPACES = path.join(dir, "workspace.json");
const A = await import("../cli/align.mjs");
const { chromium } = createRequire((process.env.DSH_ALIGN_PW_DIR ? path.join(process.env.DSH_ALIGN_PW_DIR, "package.json") : import.meta.url))("playwright-core");

const T = Date.parse("2026-11-08T02:00:00+08:00"), MIN = 60_000, ago = (m) => T - m * MIN, iso = (ms) => new Date(ms).toISOString();
const CUR = "session-curio0000-0000", OTHER = "session-other1111";
const PA = "proj-pa", DSH = "proj-dsh";
const done = (id, title, result, at, link, status = "done") => ({ id, sid: CUR, title, stitle: "Curio（personal Agent）", status, mode: "continue", proj: PA, started: iso(at - 20 * MIN), updated: iso(at), ended: iso(at), result, link });
const data = {
  version: 3, name: "cb", title: "对齐", owner: "session-fm", updated: iso(T),
  projects: [{ id: PA, title: "personal-agent", cwd: "D:\\personal-agent" }, { id: DSH, title: ".dsh", cwd: "C:\\x\\.dsh" }],
  rounds: [
    done("pa-1", "personal Agent：复现 20 Newsgroups", "复现了：准确率 0.7724，上游 0.772。特征维数一致。", ago(400), [{ href: "D:\\personal-agent\\memory\\goal-evidence\\20news.json", title: "证据文件" }], "accepted"),
    done("pa-2", "Curio：在自己的规则里写下名字、性格和兴趣", "AGENTS.md 开头已加「我是谁」，证据脚本通过：名字 Curio。", ago(80), [{ href: "D:\\personal-agent\\AGENTS.md", title: "规则文件" }, { href: "D:\\personal-agent\\memory\\goal-evidence\\identity.json", title: "证据文件" }]),
    done("pa-3", "Curio 递归自我改进，第 1 步：搭好评测和接受规则", "第 1 步完成：评测脚本和基线都已提交；自查发现评分器两个漏洞。", ago(30), [{ href: "D:\\personal-agent\\memory\\goal-evidence\\rsi-m1.json", title: "证据 JSON" }]),
    { id: "pa-4", sid: CUR, title: "Curio 多 agent 研究第 1 步", stitle: "Curio（personal Agent）", status: "doing", mode: "continue", proj: PA, started: iso(ago(20)), updated: iso(ago(20)) },
    { id: "o-1", sid: OTHER, title: "别的活", status: "doing", proj: DSH, started: iso(ago(10)), updated: iso(ago(10)) },
  ],
  decisions: [
    { id: "d-lo", title: "留出集要不要改成按样本划分", status: "open", risk: "低", round: "pa-4", proj: PA, opened: iso(ago(5)), updated: iso(ago(5)), opt: [{ label: "改" }, { label: "不改" }] },
    { id: "d-hi", title: "评分器的两个漏洞要不要直接修", status: "open", risk: "高", round: "pa-4", proj: PA, opened: iso(ago(6)), updated: iso(ago(6)), opt: [{ label: "修" }, { label: "先不修" }] },
  ],
  notes: [],
};
const live = { [CUR]: "subagent", [OTHER]: "running" };
const running = {
  sid: CUR, state: "running", private: false, live: "subagent", subagents: 5, cap: 32,
  goal: { objective: "multiagent：多 agent 研究第 1 步——做出尺子并测出基线\n\n要做到：\n1. 调研", phase: "active", round: 3, max: 20, since: ago(20), evidence: "memory/goal-evidence/m.json" },
  pause: null,
  models: { main: { model: "crouton-alpha-free", paid: false, at: iso(ago(1)) }, children: [{ model: "crouton-alpha-free", n: 40 }] },
  cooling: [{ model: "beam-free", until: Date.parse("2026-11-08T08:00:00+08:00") }, { model: "iceman-contributor-free", until: Date.parse("2026-11-08T08:00:00+08:00") }],
};

function serve(curioBody) {
  const html = A.render(data);
  const server = createServer((req, res) => {
    const p = req.url.split("?")[0];
    const json = (code, b) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    if (p === "/alignment/p/cb") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(html); }
    if (p === "/alignment/p/cb/data") return json(200, { ...data, live, work: {} });
    if (p === "/alignment/health") return json(200, { ok: true, api: A.API_VERSION });
    if (p === "/alignment/curio") { const [code, b] = curioBody(); return json(code, b); }
    if (p === "/alignment/todos") return json(200, { ok: true, api: 5, sessions: {}, activity: {}, background: {}, notodo: {}, ended: {} });
    if (p === "/alignment/fm") return json(200, { ok: true, page: "cb", fm: { sid: "session-fm", title: "first mate" }, refresh: null });
    if (p.endsWith("/log")) return json(200, { ok: true });
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, base: "http://127.0.0.1:" + server.address().port })));
}

let browser;
async function open(t, { curio = () => [200, { ok: true, api: 1, curio: running }], width = 1440 } = {}) {
  const { server, base } = await serve(curio);
  t.after(() => { server.closeAllConnections(); server.close(); });
  browser ??= await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  t.after(() => page.close());
  page.setDefaultTimeout(5000);
  await page.clock.install({ time: T });
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base + "/alignment/p/cb");
  await page.waitForSelector(".cols");
  return { page, errors };
}
test.after(() => browser?.close());
const shot = async (page, name) => { if (process.env.CURIO_SHOTS) await page.screenshot({ path: path.join(process.env.CURIO_SHOTS, name + ".webp"), type: "webp", quality: 75 }); };
const texts = (loc) => loc.evaluateAll((es) => es.map((e) => e.textContent.replace(/\s+/g, " ").trim()));

test("Curio 区：在跑的 Goal、子 agent 5/32、模型、冷却、待决定、最近完成；它的会话不进看板", { timeout: 60_000 }, async (t) => {
  const { page, errors } = await open(t);
  const band = page.locator("section.cio");
  await band.waitFor();
  assert.equal(await band.locator(".cio-h .chip").first().textContent(), "在跑");
  assert.equal(await band.locator(".cio-g").textContent(), "multiagent：多 agent 研究第 1 步——做出尺子并测出基线", "目标只取第一行");
  assert.deepEqual(await texts(band.locator(".cio-l > .cio-m > span")), ["第 3 / 20 轮", "开始 01:40", "模型 crouton-alpha-free"]);
  assert.equal((await band.locator(".cio-sn").textContent()).replace(/\s+/g, " "), "5/ 32 个子 agent 在跑");
  assert.equal(await band.locator(".cio-bar i").count(), 32);
  assert.equal(await band.locator(".cio-bar i.on").count(), 5);
  assert.deepEqual(await texts(band.locator(".cio-s .cio-m > span")), ["近 10 分钟子 agent 用 crouton-alpha-free", "beam-free、iceman-contributor-free 冷却到 08:00"]);
  assert.equal(await band.locator(".cio-p").count(), 0, "在跑时没有暂停行");
  assert.equal(await band.locator(".cio-d").textContent(), "2 件待你决定");
  // 最近完成：新的在上，去掉「Curio：」「personal Agent：」前缀，结果第一句，证据链接（有「证据」的那一条）
  assert.deepEqual(await texts(band.locator(".cio-ms .cio-tt")), ["递归自我改进，第 1 步：搭好评测和接受规则待验收", "在自己的规则里写下名字、性格和兴趣待验收", "复现 20 Newsgroups"]);
  assert.deepEqual(await texts(band.locator(".cio-ms .cio-rs")), ["第 1 步完成：评测脚本和基线都已提交", "AGENTS.md 开头已加「我是谁」，证据脚本通过：名字 Curio。", "复现了：准确率 0.7724，上游 0.772。"]);
  assert.deepEqual(await texts(band.locator(".cio-ms .cio-e .alink")), ["证据", "证据", "证据"], "证据链接统一叫「证据」,路径在悬停里");
  assert.deepEqual(await band.locator(".cio-ms .cio-e .alink").evaluateAll((es) => es.map((e) => e.getAttribute("data-ref"))), ["D:\\personal-agent\\memory\\goal-evidence\\rsi-m1.json", "D:\\personal-agent\\memory\\goal-evidence\\identity.json", "D:\\personal-agent\\memory\\goal-evidence\\20news.json"]);
  // 看板：Curio 的会话不在四个列里，别的会话还在
  assert.equal(await page.locator(".cols .sc", { hasText: "Curio" }).count(), 0, "Curio 的卡不在看板上");
  assert.equal(await page.locator(".cols .sc", { hasText: "别的活" }).count(), 1);
  assert.equal(await page.locator(".col.doing .colh .c").textContent(), "1", "进行中的计数不含 Curio");
  await shot(page, "impl-band-1440");
  // 点「2 件待你决定」：切到决定页签，选中风险高的那条
  await band.locator(".cio-d").click();
  await page.waitForFunction(() => location.hash === "#d=d-hi" || document.querySelector('.dr.sel[data-k="d:d-hi"]'));
  assert.equal(await page.locator('#left [data-v="dec"]').getAttribute("aria-selected"), "true");
  // 点一个里程碑标题：选中那一轮
  await band.locator(".cio-ms .cio-t").nth(1).click();
  await page.waitForFunction(() => document.querySelector("#rbody h1, #rbody h2, #rbody .dt")?.textContent.includes("名字、性格和兴趣"));
  assert.deepEqual(errors, []);
});

test("Curio 区：暂停写原因和预计继续；阻塞写原因；完成、已停、没有目标各有状态", { timeout: 60_000 }, async (t) => {
  let body = { ...running, state: "paused", live: "idle", subagents: 0, pause: { reason: "免费模型都在冷却", until: Date.parse("2026-11-08T08:00:00+08:00") } };
  const { page, errors } = await open(t, { curio: () => [200, { ok: true, api: 1, curio: body }] });
  const band = page.locator("section.cio");
  await band.waitFor();
  assert.equal(await band.locator(".cio-h .chip").first().textContent(), "暂停");
  assert.equal(await band.locator(".cio-p").textContent(), "暂停：免费模型都在冷却 · 预计 08:00 继续");
  assert.equal(await band.locator(".cio-bar i.on").count(), 0);
  await shot(page, "impl-band-paused-1440");
  const next = async (b, chip, line) => {
    body = b;
    await page.clock.runFor(5000);
    await page.waitForFunction((c) => document.querySelector("section.cio .cio-h .chip")?.textContent === c, chip);
    assert.equal(await band.locator(".cio-p").count() ? await band.locator(".cio-p").textContent() : null, line, chip);
  };
  await next({ ...running, state: "blocked", pause: { reason: "同一个障碍连续 3 轮", until: null } }, "阻塞", "阻塞：同一个障碍连续 3 轮");
  await next({ ...running, state: "complete", goal: { ...running.goal, phase: "complete" } }, "目标已完成", null);
  await next({ ...running, state: "stopped", pause: { reason: "收到「[暂停]」消息", until: null } }, "已停", "已停：收到「[暂停]」消息");
  await next({ ...running, state: "idle", goal: null, subagents: 0 }, "没有目标", null);
  assert.equal(await band.locator(".cio-g").count(), 0, "没有目标时不写目标行");
  assert.deepEqual(errors, []);
});

test("Curio 区：旧服务端 404、curio:null 时没有这一块，它的卡回到看板；服务端报错写出原因", { timeout: 60_000 }, async (t) => {
  for (const [label, body] of [["404", () => [404, { ok: false }]], ["null", () => [200, { ok: true, api: 1, curio: null }]]]) {
    const { page, errors } = await open(t, { curio: body });
    await page.clock.runFor(5000);
    await page.waitForTimeout(200);
    assert.equal(await page.locator("section.cio").count(), 0, label + "：没有 Curio 区");
    assert.equal(await page.locator(".cols .sc", { hasText: "Curio" }).count(), 1, label + "：Curio 的卡在看板上");
    assert.deepEqual(errors, []);
  }
  const { page, errors } = await open(t, { curio: () => [500, { ok: false, message: "读不到 Curio 的状态：boom" }] });
  await page.waitForSelector("section.cio .cio-p.red");
  assert.equal(await page.locator("section.cio .cio-p.red").textContent(), "读不到 Curio 的状态：boom");
  assert.deepEqual(errors, []);
});

test("Curio 区：窄屏上下排，不撑破", { timeout: 60_000 }, async (t) => {
  const { page, errors } = await open(t, { width: 760 });
  const band = page.locator("section.cio");
  await band.waitFor();
  const [l, r] = await Promise.all([band.locator(".cio-l").boundingBox(), band.locator(".cio-r").boundingBox()]);
  assert.ok(r.y >= l.y + l.height - 1, "右块在左块下面");
  const over = await page.evaluate(() => { const b = document.querySelector("section.cio"); return b.scrollWidth - b.clientWidth; });
  assert.ok(over <= 1, "没有横向溢出 " + over);
  await shot(page, "impl-band-760");
  assert.deepEqual(errors, []);
});
