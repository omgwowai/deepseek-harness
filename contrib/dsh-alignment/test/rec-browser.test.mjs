// 真浏览器（2026-10-29）：对齐页「今日推荐」。早报用 align rec set 写入（须知 rec-YYYYMMDD-N），页面在「决定」页签的「待决定」里另成一组：
// 不计入决定数；每条选「派出去做」（可补一句）或「不做」，和决定一起发送。发出后两种都把须知标成已了解（卡消失）；
// 派出去做的派活说明作为留言发给 First Mate（自包含、末尾 note del 命令），只选了不做时不发消息。和用户自己的留言并成一条（服务端一次只收一条留言）。
// 宽 640（DSH 右侧栏）各截一张（ALIGN_REC_SHOTS=<目录> 时存下来）。依赖插件 devDependencies 里的 playwright-core（DSH_ALIGN_PW_DIR 覆盖），缺失即失败。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "align-rec-"));
process.env.ALIGN_STORE = dir;
process.env.ALIGN_WORKSPACES = path.join(dir, "workspace.json");
fs.writeFileSync(process.env.ALIGN_WORKSPACES, JSON.stringify({ workspaces: [] }));
const A = await import("../cli/align.mjs");
const { chromium } = createRequire((process.env.DSH_ALIGN_PW_DIR ? path.join(process.env.DSH_ALIGN_PW_DIR, "package.json") : import.meta.url))("playwright-core");
// 一个文件只起一个 Chromium,各用例自己开 context(隔离不变)
let browserP;
const getBrowser = () => (browserP ??= chromium.launch({ headless: true }));
test.after(async () => { if (browserP) await (await browserP.catch(() => null))?.close(); });

const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
const p2 = (n) => String(n).padStart(2, "0");
const d0 = new Date(), TODAY = d0.getFullYear() + "-" + p2(d0.getMonth() + 1) + "-" + p2(d0.getDate());
const name = "rc";
const file = path.join(dir, name + ".html");
const SID = (n) => "session-0000000" + n + "-0000-4000-8000-000000000000";
fs.writeFileSync(file, A.render({ version: 3, name, title: "推荐测试", owner: SID(9), updated: ago(1), projects: [{ id: "pa", title: "highschool", cwd: "C:/p/pa" }],
  rounds: [{ id: "r1", sid: SID(1), title: "旁白按游戏上下文说话", status: "doing", proj: "pa", started: ago(60), eta: "1h", eta75: "2h", etaconf: "中" }],
  decisions: [{ id: "d1", title: "换不换语音模型", why: "两个模型延迟差一倍。所以来问。", status: "open", round: "r1", proj: "pa", risk: "中", cat: "方向取舍", opened: ago(10), due: new Date(Date.now() + 7 * 36e5).toISOString(),
    opt: [{ label: "换", effect: "快一倍" }, { label: "不换", effect: "不动" }] }],
  notes: [{ id: "n-keep", title: "别的须知", updated: ago(30) }] }));
fs.writeFileSync(path.join(dir, "pages.json"), JSON.stringify({ [name]: file }));

test("rec set：删掉旧推荐再加；格式不对不写、不删", async () => {
  const recs = path.join(dir, "r.json");
  fs.writeFileSync(recs, JSON.stringify([{ title: "x", why: "y" }, { title: "多了字段", why: "y", eta: "1h" }]));
  await assert.rejects(A.main(["rec", "set", name, "--file", recs]), /第 2 条推荐只能有 title、why、src/);
  fs.writeFileSync(recs, JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ title: "t" + i, why: "w" }))));
  await assert.rejects(A.main(["rec", "set", name, "--file", recs]), /1–5 条/);
  fs.writeFileSync(recs, JSON.stringify([{ title: "昨天的", why: "没处理" }]));
  await A.main(["rec", "set", name, "--file", recs, "--date", "2026-01-01"]);
  fs.writeFileSync(recs, JSON.stringify([
    { title: "找 Tianyi 续期 27B 旁白接口", why: "接口 10-28 16:20 已过期；镜头 mod 对比和台词回放都在等。", src: "First Mate 台账 10-27" },
    { title: "回对齐页 3 个待决定", why: "旁白台词线和 cua-api 第 3 层在等你定；15 分钟。" },
    { title: "和 cua-pick-speed 会话 pair-thinking 定方案", why: "这条线停在等你参与；需要 45 分钟整块。" }]));
  const out = await A.main(["rec", "set", name, "--file", recs, "--date", TODAY]);
  assert.match(out, /删了旧推荐 1 条（已处理 0、没处理 1），加了 3 条推荐/);
  const d = A.pageData(name);
  assert.deepEqual(d.notes.map((n) => n.id), ["n-keep", ...[1, 2, 3].map((i) => "rec-" + TODAY.replace(/-/g, "") + "-" + i)], "别的须知不动");
  assert.match(A.recLines(d), /\[没处理\] 找 Tianyi/);
  assert.equal(A.cardCount(d), 1, "推荐不计入角标");
});

test("今日推荐：派出去做 / 不做 → 发给 First Mate → 卡消失（640）", { timeout: 120_000 }, async (t) => {
  const sent = [];
  const handler = A.createHandler({ prefix: A.ROUTE_PREFIX, send: async (sid, text, card) => { sent.push({ sid, text, card }); }, guard: () => null, live: async (sids) => Object.fromEntries(sids.map((s) => [s, "running"])) });
  const server = createServer((req, res) => {
    const p = req.url.split("?")[0];
    const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (p.endsWith("/log")) return json(200, { ok: true });
    if (p === "/alignment/health") return json(200, { ok: true, api: A.API_VERSION });
    if (p === "/alignment/todos") return json(200, { ok: true, api: 2, sessions: {}, activity: {} });
    if (p === "/alignment/fm") return json(200, { ok: true, page: name, fm: { sid: SID(9), title: "first mate" }, refresh: null });
    if (p === "/alignment/tools") return json(200, { ok: true, api: 1, rounds: {} });
    return handler(req, res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await getBrowser();
  const ctx = await browser.newContext({ viewport: { width: 640, height: 900 }, deviceScaleFactor: 2 });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  page.setDefaultTimeout(5000);
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("http://127.0.0.1:" + server.address().port + "/alignment/p/" + name);
  await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
  await page.waitForSelector(".rwg");
  const shot = (n) => process.env.ALIGN_REC_SHOTS && page.screenshot({ path: path.join(process.env.ALIGN_REC_SHOTS, n) });

  // 决定页签：决定数仍是 1（推荐不计入），页签上另有推荐数；组名「今日推荐」、三张卡按序
  assert.equal(await page.textContent('[data-act="tab"][data-v="dec"] .cnt-b'), "1");
  assert.match(await page.textContent('[data-act="tab"][data-v="dec"] .rcn'), /3/);
  assert.equal(await page.textContent(".rwg h3 .tt"), "今日推荐");
  assert.deepEqual(await page.$$eval(".rcard .rec-t", (xs) => xs.map((x) => x.textContent)), ["找 Tianyi 续期 27B 旁白接口", "回对齐页 3 个待决定", "和 cua-pick-speed 会话 pair-thinking 定方案"]);
  await shot("rec-list-640.png");

  const c1 = ".rcard:nth-of-type(1)", c2 = ".rcard:nth-of-type(2)", c3 = ".rcard:nth-of-type(3)";
  // 派出去做：出「补一句」框、卡变白底；不做：不出框；再点一次取消
  await page.click(c1 + ' [data-act="rec"][data-v="go"]');
  await page.fill(c1 + ' [data-in="cnote"]', "先问能不能给个长期地址");
  await page.click(c2 + ' [data-act="rec"][data-v="skip"]');
  assert.equal(await page.$$eval(c2 + ' [data-in="cnote"]', (x) => x.length), 0);
  await page.click(c3 + ' [data-act="rec"][data-v="go"]');
  await page.click(c3 + ' [data-act="rec"][data-v="go"]');
  assert.equal(await page.$$eval(".rcard.picked", (x) => x.length), 2);
  // 发送队列：两项，标「推荐」
  await page.click('[data-act="queue"]');
  assert.deepEqual(await page.$$eval("#queue .qk", (xs) => xs.map((x) => x.textContent)), ["推荐", "推荐"]);
  await shot("rec-picked-640.png");
  await page.click('[data-act="queue"]');
  await page.click(".sendbar .send");
  await page.waitForSelector(".toast.ok");
  assert.match(await page.textContent(".toast.ok"), /已发送 2 项/);

  // First Mate 只收到派出去做的那条：自包含（做什么、为什么、来源、用户补的话、派完跑的命令），不做的不提
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sid, SID(9));
  const id1 = "rec-" + TODAY.replace(/-/g, "") + "-1";
  const msg = sent[0].text;
  assert.match(msg, /今日推荐 · 用户选了「派出去做」：找 Tianyi 续期 27B 旁白接口/);
  assert.match(msg, /推荐理由（推荐原文，「你」指用户）：接口 10-28 16:20 已过期/);
  assert.match(msg, /请用 align dispatch rc 派一个会话去做/);
  assert.match(msg, /来源：First Mate 台账 10-27/);
  assert.match(msg, /用户补充：先问能不能给个长期地址/);
  assert.match(msg, new RegExp("align note del rc " + id1));
  assert.doesNotMatch(msg, /回对齐页 3 个待决定/);
  const d = A.pageData(name);
  assert.ok(d.notes.find((n) => n.id === id1).acked, "派出去做的标成已了解");
  assert.ok(d.notes.find((n) => n.id === id1.replace(/-1$/, "-2")).acked, "不做的标成已了解");
  assert.ok(!d.notes.find((n) => n.id === id1.replace(/-1$/, "-3")).acked, "没选的不动");
  // 页面：只剩没选的一张
  await page.waitForFunction(() => document.querySelectorAll(".rcard").length === 1);
  await shot("rec-after-640.png");

  // 只选了不做：不发消息，卡消失；推荐全处理完组就没了
  await page.click('.rcard [data-act="rec"][data-v="skip"]');
  await page.click(".sendbar .send");
  await page.waitForFunction(() => !document.querySelector(".rwg"));
  assert.equal(sent.length, 1, "只有不做时不发消息");
  assert.deepEqual(errors, []);
});

test("派出去做和用户留言并成一条（服务端一次只收一条留言）", async () => {
  const src = fs.readFileSync(new URL("../cli/template.html", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("// @queue-begin"), src.indexOf("// @queue-end"));
  const { queueOf, withMemo, answersFrom, MEMO_KEY } = new Function("markText", "esc", body + "\nreturn { queueOf, withMemo, answersFrom, MEMO_KEY };")((s) => s, (s) => s);
  const n = { id: "rec-20261029-1", title: "做 X", body: "因为 Y" };
  const look = { dec: () => null, round: () => null, act: () => "", from: () => [], rec: (id) => (id === n.id ? n : null), page: "first-mate" };
  const picks = withMemo({ ["c:" + n.id]: { act: "go", note: "今天内" } }, "顺便看下日志", ["C:/x.png"]);
  const q = queueOf(picks, look);
  assert.deepEqual(q.map((x) => x.key), ["c:" + n.id, MEMO_KEY]);
  const a = answersFrom(q);
  assert.deepEqual(a[0], { kind: "note", id: n.id, ack: true });
  assert.equal(a.filter((x) => x.kind === "message").length, 1);
  assert.match(a[1].text, /^今日推荐 · 用户选了「派出去做」：做 X[\s\S]*用户补充：今天内[\s\S]*align note del first-mate rec-20261029-1\n\n顺便看下日志$/);
  assert.deepEqual(a[1].images, ["C:/x.png"]);
  assert.deepEqual(answersFrom(queueOf({ ["c:" + n.id]: { act: "skip" } }, look)), [{ kind: "note", id: n.id, ack: true }], "不做只有已了解");
});
