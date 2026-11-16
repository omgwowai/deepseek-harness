// 真浏览器回归(2026-10-24):待验收轮次详情里的工具调用异常。
// - 只在待验收(done)轮次、服务端 health.tools >= 1 时出现;打开详情只取一次 /alignment/tools(之后重画不再取);
// - 四组(出错 / 超时 / 耗时超过 P90 / 返回内容超过 P90),组标题带次数,同类一行「× N」,展开看每一次;
// - 展开状态在重画后保留;耗时、体积行带倍数;没有异常时一行「没有异常」;基线还没算好时说明耗时、体积暂缺;
// - 耗时、体积两组的悬停说明写明基线窗口天数,取服务端 baseline.windowDays(2026-10-24 起 30 天,旧服务端 7 天)。
// 页面由 align.mjs render() 生成,本地 http 服务给页面、/data、/health、/alignment/tools;依赖本机 playwright-core。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "align-tool-anom-"));
process.env.ALIGN_STORE = dir;
process.env.ALIGN_WORKSPACES = path.join(dir, "workspace.json");
const A = await import("../cli/align.mjs");
const { chromium } = createRequire((process.env.DSH_ALIGN_PW_DIR ? path.join(process.env.DSH_ALIGN_PW_DIR, "package.json") : import.meta.url))("playwright-core");
// 一个文件只起一个 Chromium,各用例自己开 context(隔离不变)
let browserP;
const getBrowser = () => (browserP ??= chromium.launch({ headless: true }));
test.after(async () => { if (browserP) await (await browserP.catch(() => null))?.close(); });

const T = Date.parse("2026-10-24T10:00:00Z"), iso = (ms) => new Date(ms).toISOString();
const data = {
  version: 3, name: "ta", title: "工具异常", owner: "session-fm", updated: iso(T), projects: [],
  rounds: [
    { id: "r1", sid: "session-w1", title: "交了结果的会话", status: "done", started: iso(T - 3600e3), ended: iso(T - 60e3), result: "做完了" },
    { id: "r2", sid: "session-w2", title: "还在跑的会话", status: "doing", started: iso(T - 600e3), state: "进行中" },
    { id: "r3", sid: "session-w3", title: "没有异常的会话", status: "done", started: iso(T - 3600e3), ended: iso(T - 60e3), result: "好了" },
  ],
  decisions: [], notes: [],
};
const occ = (k, extra = {}) => ({ id: "c" + k, at: iso(T - 1800e3 + k * 1000), tool: "pwsh", inner: true, args: "跑测试 " + k, params: "{}", ms: 1200, chars: null, ...extra });
const groups = {
  error: [{ key: "read|cannot read …: not found", tool: "read", label: 'Error: cannot read "C:\\a.md": not found', count: 2, worst: 0, more: 0, items: [occ(1, { tool: "read", text: 'Error: cannot read "C:\\a.md": not found' }), occ(2, { tool: "read", text: 'Error: cannot read "C:\\b.md": not found' })] }],
  timeout: [{ key: "pwsh|background", tool: "pwsh", label: "background", count: 1, worst: 0, more: 0, items: [occ(3, { ms: 45000, text: "[still running after 45000ms; moved to background job pwsh-1]" })] }],
  slow: [{ key: "run_code", tool: "run_code", p90: 20000, n: 500, count: 3, worst: 27, more: 0, items: [occ(4, { tool: "run_code", inner: false, ms: 540000, ratio: 27, p90: 20000 }), occ(5, { tool: "run_code", inner: false, ms: 60000, ratio: 3, p90: 20000 }), occ(6, { tool: "run_code", inner: false, ms: 30000, ratio: 1.5, p90: 20000 })] }],
  big: [{ key: "read", tool: "read", p90: 5000, n: 300, count: 1, worst: 1.6, more: 0, items: [occ(7, { tool: "read", inner: false, chars: 8000, ratio: 1.6, p90: 5000 })] }],
};
// what the runs route returns: c4 = commit then a 9-minute wait (slowest marked); c6 = a fold of 3 reads, one call with no
// start event (no time shown) and the program's own 2 s; c5 is not in the log
const step = (tool, label, ms, extra = {}) => ({ tool, label, texts: [label], distinct: 1, n: 1, ids: [tool + label], hint: null, ms, chars: 10, errors: 0, errorText: null, timeout: null, open: false, ...extra });
const RUNS = {
  c4: { id: "c4", description: "Commit probe and wait for verify", code: "const r = await tools.pwsh({ command: \"git commit\" }); // commit\nawait tools.job_output({ job_id: 'pwsh-1', wait: true });", codeChars: 99, ms: 541520, gap: 273, calls: 2,
    steps: [step("pwsh", "Commit live probe", 1129, { hint: "git add x; git commit -q" }), step("job_output", "等后台任务「Run full dsh-verify」结束", 540118)] },
  c6: { id: "c6", description: "read three", code: "x", codeChars: 1, ms: 30000, gap: 2500, calls: 4,
    steps: [step("read", "读 ~/a.md、~/b.md", null, { n: 3 }), step("grep", "搜 x，范围 D:/w", 900, { errors: 1, errorText: "Error: rg failed" })] },
};
const empty = { error: [], timeout: [], slow: [], big: [] };

function serve({ tools = 2, baseline = true, days = 30 } = {}) {
  const html = A.render(data), hits = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://x"), p = u.pathname;
    const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (p === "/alignment/p/ta") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(html); }
    if (p === "/alignment/p/ta/data") return json(200, { ...data, live: {} });
    if (p === "/alignment/health") return json(200, { ok: true, api: A.API_VERSION, ...(tools ? { tools } : {}) });
    if (p === "/alignment/tools" && u.searchParams.get("sub") === "1") {
      hits.push(Object.fromEntries(u.searchParams));
      const kidErr = occ(8, { tool: "read", text: 'Error: cannot read "C:\\c.md": not found', agent: { sid: "kid", label: "查资料" } });
      const sg = { ...groups, error: [{ ...groups.error[0], count: 3, sub: 1, items: [...groups.error[0].items, kidErr] }] };
      return json(200, { ok: true, api: 2, sid: "session-w1", calls: 120, subCalls: 30, subagents: 1, agents: [{ sid: "kid", label: "查资料", depth: 1, calls: 30 }], ms: 5, baseline: { builtAt: iso(T), from: iso(T - days * 864e5), windowDays: days, tools: 30 }, baselineError: null, groups: sg });
    }
    if (p === "/alignment/tools/runs") {
      hits.push({ runs: u.searchParams.get("ids"), sid: u.searchParams.get("sid") });
      return json(200, { ok: true, api: 3, sid: u.searchParams.get("sid"), runs: Object.fromEntries(u.searchParams.get("ids").split(",").map((id) => [id, RUNS[id] ?? null])) });
    }
    if (p === "/alignment/todos") return json(200, { ok: true, api: 2, sessions: {}, activity: {} });
    if (p === "/alignment/fm") return json(200, { ok: true, page: "ta", fm: null, refresh: null });
    if (p === "/alignment/tools") {
      hits.push(Object.fromEntries(u.searchParams));
      const sid = u.searchParams.get("sid");
      return json(200, { ok: true, api: 2, sid, subagents: sid === "session-w1" ? 1 : 0, calls: sid === "session-w1" ? 120 : 40, ms: 5, baseline: baseline ? { builtAt: iso(T), from: iso(T - days * 864e5), windowDays: days, tools: 30 } : null, baselineError: null, groups: sid === "session-w1" ? (baseline ? groups : { ...groups, slow: [], big: [] }) : empty });
    }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, hits, base: "http://127.0.0.1:" + server.address().port })));
}

async function open(t, opts, width, hash) {
  const s = await serve(opts);
  t.after(() => { s.server.closeAllConnections(); s.server.close(); });
  const browser = await getBrowser();
  const ctx = await browser.newContext({ viewport: { width, height: 1000 } });
  t.after(() => ctx.close());
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(s.base + "/alignment/p/ta#" + hash);
  return { page, hits: s.hits, errors };
}

test("四组、组内折叠、倍数、展开看每一次", { timeout: 60_000 }, async (t) => {
  const { page, hits, errors } = await open(t, {}, 1280, "r=r1");
  await page.waitForSelector(".an .ag");
  assert.deepEqual(hits, [{ sid: "session-w1", from: data.rounds[0].started, to: data.rounds[0].ended }]);
  const heads = await page.$$eval(".an .agh", (h) => h.map((x) => x.textContent));
  assert.deepEqual(heads, ["出错2", "超时1", "耗时超过 P903", "返回内容超过 P901"]);
  assert.match(await page.textContent(".an .sec-h"), /工具调用120 次/);
  const rows = await page.$$eval(".an summary", (s) => s.map((x) => [x.querySelector(".tn").textContent, x.querySelector(".lb").textContent, x.querySelector(".ct").textContent, x.querySelector(".sv")?.textContent ?? ""]));
  assert.deepEqual(rows, [
    ["read", 'cannot read "C:\\a.md": not found', "× 2", ""],
    ["pwsh", "转到后台继续", "× 1", ""],
    ["run_code", "最长 9 分 · P90 20 秒", "× 3", "27 倍"],
    ["read", "最多 8,000 字符 · P90 5,000 字符", "× 1", "1.6 倍"],
  ]);
  assert.ok(await page.$eval(".an .ag.slow .sv", (e) => e.classList.contains("hot")), "27 倍 is marked (>= 3)");
  assert.ok(!(await page.$eval(".an .ag.big .sv", (e) => e.classList.contains("hot"))), "1.6 倍 is not");
  // 悬停说明写明基线窗口（服务端 windowDays，2026-10-24 起 30 天）;出错、超时两组没有说明
  assert.equal(await page.getAttribute(".an .ag.slow .agh", "title"), "比同一工具最近 30 天所有会话里 90% 的调用都慢，且超过 2 秒");
  assert.equal(await page.getAttribute(".an .ag.big .agh", "title"), "进上下文的字符数比同一工具最近 30 天所有会话里 90% 的调用都多，且超过 4000 字符");
  assert.equal(await page.getAttribute(".an .ag.error .agh", "title"), null);
  await page.click(".an .ag.error summary");
  const occ = await page.$$eval(".an .ag.error .occ li", (l) => l.map((x) => [x.querySelector(".oa").textContent, x.querySelector("pre").textContent]));
  assert.deepEqual(occ, [["run_code 内跑测试 1", 'Error: cannot read "C:\\a.md": not found'], ["run_code 内跑测试 2", 'Error: cannot read "C:\\b.md": not found']]);
  assert.equal(errors.length, 0, errors.join("\n"));
});

test("展开状态在重画后保留,不重复请求", { timeout: 60_000 }, async (t) => {
  const { page, hits } = await open(t, {}, 1280, "r=r1");
  await page.waitForSelector(".an .ag");
  await page.click(".an .ag.slow summary");
  await page.waitForSelector(".an .ag.slow details[open] .occ .ov");
  // re-render: select another round and come back (both full renders of the detail)
  await page.evaluate(() => { location.hash = "#r=r3"; });
  await page.waitForFunction(() => document.querySelector(".dh h1")?.textContent === "没有异常的会话");
  await page.evaluate(() => { location.hash = "#r=r1"; });
  await page.waitForFunction(() => document.querySelector(".dh h1")?.textContent === "交了结果的会话");
  assert.ok(await page.$(".an .ag.slow details[open]"), "the opened row is still open");
  assert.equal(await page.$(".an .ag.error details[open]"), null);
  const occ = await page.$$eval(".an .ag.slow .occ .ov", (o) => o.map((x) => x.textContent));
  assert.deepEqual(occ, ["9 分 · 27 倍", "1 分 · 3.0 倍", "30 秒 · 1.5 倍"], "same rounding as the row's ratio");
  assert.deepEqual(hits.map((h) => h.sid), ["session-w1", "session-w3"], "one request per round");
});

test("没有异常一行;进行中的轮次不显示;旧服务端(health 没有 tools)不请求", { timeout: 60_000 }, async (t) => {
  const a = await open(t, {}, 1280, "r=r3");
  await a.page.waitForSelector(".an .st");
  assert.equal((await a.page.textContent(".an")).replace(/\s+/g, ""), "工具调用40次没有异常");
  await a.page.goto(a.page.url().replace(/#.*/, "#r=r2"));
  await a.page.waitForSelector(".dh h1");
  assert.equal(await a.page.$(".an"), null);
  const b = await open(t, { tools: 0 }, 1280, "r=r1");
  await b.page.waitForSelector(".dh h1");
  await b.page.waitForTimeout(500);
  assert.equal(await b.page.$(".an"), null);
  assert.deepEqual(b.hits, []);
});

test("还没重启的旧服务端按 7 天算:悬停说明照它的 windowDays 写 7 天", { timeout: 60_000 }, async (t) => {
  const { page, errors } = await open(t, { days: 7 }, 1280, "r=r1");
  await page.waitForSelector(".an .ag.slow");
  assert.equal(await page.getAttribute(".an .ag.slow .agh", "title"), "比同一工具最近 7 天所有会话里 90% 的调用都慢，且超过 2 秒");
  assert.match(await page.getAttribute(".an .ag.big .agh", "title"), /最近 7 天/);
  assert.equal(errors.length, 0, errors.join("\n"));
});

test("基线还没算好:只有出错和超时,说明耗时、体积暂缺;420 宽不横向溢出", { timeout: 60_000 }, async (t) => {
  const { page } = await open(t, { baseline: false }, 420, "r=r1");
  await page.waitForSelector(".an .ag");
  assert.deepEqual(await page.$$eval(".an .ag", (g) => g.map((x) => x.className)), ["ag error", "ag timeout"]);
  assert.match(await page.textContent(".an"), /P90 还在统计/);
  await page.click(".an .ag.error summary");
  const over = await page.$eval("#rbody", (b) => b.scrollWidth - b.clientWidth);
  assert.ok(over <= 1, "rbody overflows by " + over + "px");
});

test("含子 agent 的调用:点开才请求 sub=1,组和行标出子 agent 的次数,再点切回不再请求;旧服务端(tools 1)不显示这一行", { timeout: 60_000 }, async (t) => {
  const { page, hits } = await open(t, {}, 1280, "r=r1");
  await page.waitForSelector(".an .subr .fc");
  assert.equal((await page.textContent(".an .subr .fc")).trim(), "含子 agent 的调用");
  assert.equal(await page.getAttribute(".an .subr .fc", "aria-pressed"), "false");
  assert.deepEqual(hits.map((h) => h.sub ?? null), [null], "nothing for subagents until asked");
  assert.equal(await page.$(".an .sa"), null);
  await page.click(".an .subr .fc");
  await page.waitForSelector(".an .ag.error .agh .sa");
  assert.deepEqual(hits.map((h) => h.sub ?? null), [null, "1"]);
  assert.equal(await page.getAttribute(".an .subr .fc", "aria-pressed"), "true");
  assert.match((await page.textContent(".an .sec-h")).replace(/\s+/g, ""), /工具调用150次30$/, "total includes the subagents, the bot number is the part from them (same as the groups)");
  assert.equal((await page.textContent(".an .ag.error .agh")).replace(/\s+/g, ""), "出错31");
  assert.equal(await page.getAttribute(".an .ag.error .agh .sa", "title"), "其中 1 次来自子 agent");
  assert.equal((await page.textContent(".an .ag.error summary .ct")).replace(/\s+/g, ""), "×31");
  await page.click(".an .ag.error summary");
  assert.deepEqual(await page.$$eval(".an .ag.error .occ .in.ag", (e) => e.map((x) => x.textContent)), ["查资料"]);
  await page.click(".an .subr .fc");
  await page.waitForFunction(() => document.querySelector(".an .subr .fc").getAttribute("aria-pressed") === "false");
  assert.equal((await page.textContent(".an .ag.error .agh")).replace(/\s+/g, ""), "出错2");
  assert.equal(hits.length, 2, "switching back and forth does not ask again");
  const old = await open(t, { tools: 1 }, 1280, "r=r1");
  await old.page.waitForSelector(".an .ag");
  assert.equal(await old.page.$(".an .subr"), null);
});

test("run_code 的每一步:展开一组才取一次;最慢一步标出;拿不到的时间不显示;代码点开才有", { timeout: 60_000 }, async (t) => {
  const { page, hits, errors } = await open(t, { tools: 3 }, 1280, "r=r1");
  await page.waitForSelector(".an .ag");
  await page.waitForTimeout(200);
  assert.equal(hits.filter((h) => h.runs).length, 0, "nothing asked before a group opens");
  await page.click(".an .ag.slow summary");
  await page.waitForSelector(".an .ag.slow .rsteps");
  assert.deepEqual(hits.filter((h) => h.runs), [{ runs: "c4,c5,c6", sid: "session-w1" }], "one request for the group's programs");
  const occs = await page.$$(".an .ag.slow .occ > li");
  const rows = (li) => li.$$eval(".rsteps li", (l) => l.map((x) => [x.querySelector(".tn")?.textContent ?? "", x.querySelector(".tx").textContent, x.querySelector(".xn").textContent, x.querySelector(".sm").textContent, x.classList.contains("mx")]));
  assert.deepEqual(await rows(occs[0]), [["pwsh", "Commit live probe", "", "1.1 秒", false], ["job_output", "等后台任务「Run full dsh-verify」结束", "", "最慢9 分", true]]);
  assert.match(await occs[0].$eval(".rsteps li .tx", (e) => e.title), /git add x; git commit -q/, "the command behind a description is in the tooltip");
  assert.match(await occs[1].textContent(), /会话日志里没有这次 run_code/);
  assert.deepEqual(await rows(occs[2]), [["read", "读 ~/a.md、~/b.md", "× 3", "", false], ["grep", "搜 x，范围 D:/w", "", "0.9 秒", false], ["", "程序本身", "", "最慢2.5 秒", true]]);
  assert.match(await occs[2].$eval(".rsteps .se", (e) => e.textContent), /Error: rg failed/);
  // code: folded, then highlighted, then folded again
  assert.equal(await occs[0].$("pre.code"), null);
  await page.click('.an .ag.slow [data-act="rcode"][data-k="session-w1|c4"]');
  await page.waitForSelector(".an .ag.slow pre.code");
  assert.equal(await page.$eval('[data-act="rcode"][data-k="session-w1|c4"]', (b) => b.getAttribute("aria-expanded")), "true");
  assert.deepEqual(await page.$$eval(".an pre.code .ht", (s) => s.map((x) => x.textContent)), ["pwsh", "job_output"]);
  assert.deepEqual(await page.$$eval(".an pre.code .hc", (s) => s.map((x) => x.textContent)), ["// commit"]);
  assert.ok(await page.$eval(".an pre.code", (e) => getComputedStyle(e).maxHeight !== "none" && getComputedStyle(e).overflowY === "auto"), "long code scrolls inside a capped box");
  await page.click('[data-act="rcode"][data-k="session-w1|c4"]');
  assert.equal(await page.$(".an pre.code"), null);
  // closing and opening the group again asks nothing more
  await page.click(".an .ag.slow summary");
  await page.click(".an .ag.slow summary");
  await page.waitForTimeout(150);
  assert.equal(hits.filter((h) => h.runs).length, 1);
  // inner calls (error group, no root) and other groups have no step block
  await page.click(".an .ag.error summary");
  assert.equal(await page.$(".an .ag.error .rn"), null);
  assert.equal(errors.length, 0, errors.join("\n"));
});
