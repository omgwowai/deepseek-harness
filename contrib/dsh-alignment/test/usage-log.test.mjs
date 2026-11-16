// 对齐页使用日志（api 11，cli/usage.mjs）：落盘、字段白名单（不记输入内容）、轮转、POST /p/<页>/log、align log / align usage 输出、手机 App 的服务端记录。
// 浏览器里的攒批、sendBeacon 见 usage-browser.test.mjs。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { runScript } from "./fixtures/run-script-in-worker.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "align-usage-"));
process.env.ALIGN_STORE = dir;
process.env.ALIGN_WORKSPACES = path.join(dir, "workspace.json");
const A = await import("../cli/align.mjs");
const U = await import("../cli/usage.mjs");
const { appUsageRecorder, createPhoneBridge } = await import("../index.js");

// 钉住的「现在」：本机时间（不带时区）的中午，离午夜远。按天分文件、按天汇总的断言不随跑测试的日期变；CLI 子进程经 ALIGN_NOW 用同一时刻。
const NOW_ISO = "2026-10-24T12:00:00", NOW = Date.parse(NOW_ISO);
const usageDir = A.USAGE_DIR;
fs.writeFileSync(path.join(dir, "p1.html"), A.render({ version: 3, name: "p1", title: "t", owner: "session-fm", updated: new Date(NOW).toISOString(), projects: [], rounds: [], decisions: [], notes: [] }));
fs.writeFileSync(path.join(dir, "pages.json"), JSON.stringify({ p1: path.join(dir, "p1.html") }));
const rawAll = (d = usageDir) => fs.readdirSync(d).map((n) => { const b = fs.readFileSync(path.join(d, n)); return n.endsWith(".gz") ? zlib.gunzipSync(b).toString() : b.toString(); }).join("");

test("cleanBatch：白名单外的字段（text / note / value / cookie）丢掉，输入只留长度", () => {
  const r = U.cleanBatch({ pid: "abc", dev: "desktop", cookie: "sid=1", events: [
    { t: NOW, type: "input.write", field: "note", id: "d1", len: 12, text: "秘密内容", value: "秘密内容", note: "秘密" },
    { t: NOW, type: "Bad Type" }, { type: "page.open", t: NOW + 10 * 86400000 },
  ] }, NOW);
  assert.deepEqual(r.meta, { pid: "abc", dev: "desktop" });
  assert.equal(r.events.length, 2);
  assert.deepEqual(r.events[0], { t: NOW, type: "input.write", field: "note", id: "d1", len: 12 });
  assert.equal(r.events[1].t, NOW, "时钟偏太多：用收到的时间");
  for (const k of ["cookie", "text", "value", "note", "(bad event)"]) assert.ok(r.dropped.includes(k), k);
  assert.throws(() => U.cleanBatch({ events: new Array(U.MAX_EVENTS + 1).fill({ type: "a", t: NOW }) }, NOW), RangeError);
  assert.throws(() => U.cleanBatch({}, NOW), TypeError);
});

test("appendUsage：按事件日期落到 YYYY-MM-DD.jsonl，只追加，每行带 page / src / meta", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "align-usage-a-"));
  U.appendUsage(d, { page: "p1", src: "local", body: { pid: "x1", events: [{ t: NOW, type: "page.open" }] }, now: NOW });
  U.appendUsage(d, { page: "p1", src: "remote", body: { pid: "x2", events: [{ t: NOW + 1, type: "view.tab", v: "dec" }] }, now: NOW });
  const f = path.join(d, U.dayOf(NOW) + ".jsonl");
  const lines = fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.deepEqual([lines[0].src, lines[0].pid, lines[0].type, lines[1].src, lines[1].v], ["local", "x1", "page.open", "remote", "dec"]);
  assert.deepEqual(U.readUsage(d, { page: "p1" }).map((e) => e.type), ["page.open", "view.tab"]);
  assert.deepEqual(U.readUsage(d, { page: "other" }), []);
});

// 2026-11-03：10-27 断电后真实日志的形状：一段 NUL 接着重启后的完整一行；之前整个 align usage 报错退出
test("readUsage 坏行：开头是 NUL 的行去掉 NUL 照常读，读不出的跳过，都记进 bad；align usage 跑得通、stderr 说明", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "align-usage-bad-"));
  const ev = (t, type) => JSON.stringify({ t, page: "p1", type });
  const body = [ev(NOW - 3, "a"), "\0".repeat(89) + ev(NOW - 2, "b"), "{\"t\":1,\"page\":\"p1\"", "[]", ev(NOW - 1, "c")].join("\n") + "\n";
  fs.writeFileSync(path.join(d, U.dayOf(NOW) + ".jsonl.gz"), zlib.gzipSync(body));
  const bad = [];
  assert.deepEqual(U.readUsage(d, { page: "p1", bad }).map((e) => e.type), ["a", "b", "c"]);
  assert.deepEqual(bad.map((b) => [b.line, b.nul, !!b.why]), [[2, 89, false], [3, 0, true], [4, 0, true]]);
  const txt = U.badLinesText(bad);
  assert.match(txt, /跳过 2 行/);
  assert.match(txt, /1 行开头有 NUL，去掉后照常读.*第 2 行（89 个 NUL）/);
  assert.doesNotThrow(() => U.readUsage(d, {}), "不带 bad 也不抛");
  // CLI：同一份坏日志放进页面的 usage 目录，align usage 退出 0，stderr 报坏行，stdout 是摘要
  const { spawnSync } = await import("node:child_process");
  const f = path.join(usageDir, U.dayOf(NOW) + ".jsonl.1-bad.gz");
  fs.mkdirSync(usageDir, { recursive: true });
  fs.writeFileSync(f, zlib.gzipSync(body));
  try {
    const r = spawnSync(process.execPath, [path.join(import.meta.dirname, "..", "cli", "align.mjs"), "usage", "p1", "--since", "1d"], { encoding: "utf8", env: { ...process.env, ALIGN_NOW: NOW_ISO } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /使用日志有坏行：跳过 2 行/);
    assert.match(r.stdout, /p1 使用摘要/);
  } finally { fs.rmSync(f); }
});

test("maintainUsage：今天、昨天明文；更早压成 .gz（已有 .gz 另起一个）；90 天前删掉；readUsage 照样读 .gz", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "align-usage-m-"));
  const day = (n) => U.dayOf(NOW - n * 86400000);
  const line = (n, type) => JSON.stringify({ t: NOW - n * 86400000, page: "p1", type }) + "\n";
  for (const n of [0, 1, 2, 5, 90, 120]) fs.writeFileSync(path.join(d, day(n) + ".jsonl"), line(n, "a" + n));
  fs.writeFileSync(path.join(d, day(5) + ".jsonl.gz"), zlib.gzipSync(JSON.stringify({ t: NOW - 5 * 86400000 - 1, page: "p1", type: "old5" }) + "\n"));
  fs.writeFileSync(path.join(d, "notes.txt"), "keep");
  const r = await U.maintainUsage(d, NOW);
  assert.deepEqual(r.gzipped.sort(), [day(2) + ".jsonl", day(5) + ".jsonl"].sort());
  assert.deepEqual(r.removed.sort(), [day(90) + ".jsonl", day(120) + ".jsonl"].sort());
  const left = fs.readdirSync(d).sort();
  assert.deepEqual(left.filter((n) => !n.startsWith(day(5))), [day(0) + ".jsonl", day(1) + ".jsonl", day(2) + ".jsonl.gz", "notes.txt"].sort());
  assert.equal(left.filter((n) => n.startsWith(day(5))).length, 2, "已有的 .gz 不改，另起一个");
  assert.ok(left.filter((n) => n.startsWith(day(5))).every((n) => /\.gz$/.test(n)));
  assert.deepEqual(U.readUsage(d, { since: NOW - 10 * 86400000 }).map((e) => e.type), ["old5", "a5", "a2", "a1", "a0"]);
  assert.deepEqual(await U.maintainUsage(d, NOW), { gzipped: [], removed: [] }, "再跑一次不动");
});

test("maintainUsage 并发（3080 和 3390 同时轮转）：不重复、不报错；崩溃留下的旧锁会清掉重做，新锁（别人正在做）不碰", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "align-usage-p-"));
  const day = (n) => U.dayOf(NOW - n * 86400000);
  const lines = (n, k) => Array.from({ length: k }, (_, i) => JSON.stringify({ t: NOW - n * 86400000 + i, page: "p1", type: "x" + i }) + "\n").join("");
  for (const n of [3, 4, 5, 6]) fs.writeFileSync(path.join(d, day(n) + ".jsonl"), lines(n, 50));
  const rs = await Promise.all([U.maintainUsage(d, NOW), U.maintainUsage(d, NOW), U.maintainUsage(d, NOW)]);
  assert.deepEqual(rs.flatMap((r) => r.gzipped).sort(), [3, 4, 5, 6].map((n) => day(n) + ".jsonl").sort(), "每个文件只被一个调用认领");
  const gzLines = (n) => fs.readdirSync(d).filter((x) => x.startsWith(day(n)) && x.endsWith(".gz")).reduce((s, x) => s + zlib.gunzipSync(fs.readFileSync(path.join(d, x))).toString().split("\n").filter(Boolean).length, 0);
  for (const n of [3, 4, 5, 6]) assert.equal(gzLines(n), 50, day(n) + " 没有重复行");
  assert.ok(!fs.readdirSync(d).some((n) => /\.(lock|tmp)$/.test(n)), "锁和临时文件都清掉了");
  // 又有两天的明文：一天带着崩溃留下的旧锁（2 小时前），一天的锁是新的（别的进程正在做）
  fs.writeFileSync(path.join(d, day(3) + ".jsonl"), lines(3, 2)); fs.writeFileSync(path.join(d, day(4) + ".jsonl"), lines(4, 3));
  const stale = path.join(d, day(3) + ".jsonl.lock"), fresh = path.join(d, day(4) + ".jsonl.lock");
  fs.writeFileSync(stale, ""); fs.writeFileSync(fresh, "");
  const old = new Date(NOW - 2 * 3600000); fs.utimesSync(stale, old, old);
  const r = await U.maintainUsage(d, NOW);
  assert.deepEqual(r.gzipped, [day(3) + ".jsonl"]);
  assert.ok(!fs.existsSync(stale) && fs.existsSync(fresh) && fs.existsSync(path.join(d, day(4) + ".jsonl")));
  assert.equal(gzLines(3), 52, "同一天已有 .gz：另起一个");
  assert.equal(U.readUsage(d, { since: 0 }).length, 205, "全都读得到、没有重复");
});

test("scrubMsg：报错文字里引号括起来的片段（可能带用户文本）换成 \"…\"", () => {
  assert.equal(U.scrubMsg('Unexpected token \'秘\', "秘密内容" is not valid JSON'), 'Unexpected token "…", "…" is not valid JSON');
  assert.equal(U.cleanBatch({ events: [{ t: NOW, type: "error.js", msg: 'x "我的输入" y' }] }, NOW).events[0].msg, 'x "…" y');
});

test("appendUsage 每小时顺带轮转一次（回复之后异步做）", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "align-usage-r-"));
  const old = U.dayOf(NOW - 3 * 86400000);
  fs.writeFileSync(path.join(d, old + ".jsonl"), JSON.stringify({ t: NOW - 3 * 86400000, page: "p1", type: "x" }) + "\n");
  U.resetMaintainClock();
  U.appendUsage(d, { page: "p1", src: "local", body: { events: [{ t: NOW, type: "page.open" }] }, now: NOW });
  assert.ok(fs.existsSync(path.join(d, old + ".jsonl")), "写入当场不轮转");
  // 轮转做完 = .gz 在、明文和锁都删了（.gz 先于明文删除出现，只等 .gz 会和后面重写明文抢）
  const done = () => fs.existsSync(path.join(d, old + ".jsonl.gz")) && !fs.existsSync(path.join(d, old + ".jsonl")) && !fs.existsSync(path.join(d, old + ".jsonl.lock"));
  // 等条件,60 s 只防挂死(原来数 250 次约 5 s,门禁满载时轮转的子进程起得慢就假红)
  for (const end = Date.now() + 60_000; !done() && Date.now() < end;) await new Promise((r) => setTimeout(r, 20));
  assert.ok(done(), "轮转做完");
  U.appendUsage(d, { page: "p1", src: "local", body: { events: [{ t: NOW, type: "page.open" }] }, now: NOW + 60000 });
  fs.writeFileSync(path.join(d, old + ".jsonl"), "{}\n");
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(fs.existsSync(path.join(d, old + ".jsonl")), "一小时内不再轮转");
});

async function serve(handler) {
  const http = await import("node:http");
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: "http://127.0.0.1:" + server.address().port };
}

test("POST /alignment/p/<页>/log：落盘，src 按 x-forwarded-proto 分本机 / 远程；没登记 404，非 JSON 415，坏 body 400", async (t) => {
  const handler = A.createHandler({ prefix: A.ROUTE_PREFIX, send: async () => {}, guard: () => null, live: null });
  const { server, base } = await serve(handler);
  t.after(() => server.close());
  const post = (p, body, headers = {}) => fetch(base + "/alignment/p/" + p + "/log", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const r1 = await post("p1", { pid: "h1", events: [{ t: Date.now(), type: "page.open", text: "不该存" }] });
  assert.equal(r1.status, 200);
  assert.deepEqual(await r1.json(), { ok: true, n: 1, dropped: ["text"] });
  assert.equal((await post("p1", { pid: "h2", events: [{ t: Date.now(), type: "page.open" }] }, { "x-forwarded-proto": "https" })).status, 200);
  assert.equal((await post("nope", { events: [] })).status, 404);
  assert.equal((await fetch(base + "/alignment/p/p1/log", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status, 415);
  assert.equal((await post("p1", { nope: 1 })).status, 400);
  assert.equal((await post("p1", "{bad")).status, 400);
  const evs = U.readUsage(usageDir, { page: "p1" });
  assert.deepEqual(evs.filter((e) => e.pid === "h1" || e.pid === "h2").map((e) => e.src), ["local", "remote"]);
  assert.doesNotMatch(rawAll(), /不该存/);
});

test("3390 本机服务的 /p/<页>/log：src = local-3390（Origin 要是本服务）", async (t) => {
  const server = A.createServer({ port: 0, send: async () => {} });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const port = server.address().port;
  // createServer 按 port 参数校验 Host/Origin：用真实端口重建
  server.close();
  const s2 = A.createServer({ port, send: async () => {} });
  await new Promise((r) => s2.listen(port, "127.0.0.1", r));
  t.after(() => s2.close());
  const origin = "http://127.0.0.1:" + port;
  const r = await fetch(origin + "/p/p1/log", { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ pid: "s3390", events: [{ t: Date.now(), type: "page.open" }] }) });
  assert.equal(r.status, 200);
  assert.equal(U.readUsage(usageDir, { page: "p1" }).find((e) => e.pid === "s3390").src, "local-3390");
});

// align log / usage 在 worker 线程里跑 align.mjs(同一份 argv / env / 退出码 / stdout 契约,见 run-script-in-worker.mjs;
// worker 里模块重新求值,ALIGN_STORE 按这次的 env 取)。门禁满载时每起一个 node 要 150 ms+,这里 14 次;
// 真起进程只留「坏行」那一处(退出码 + stderr)。非 0 退出时抛错,错误信息带 stderr,同 execFileSync。
const ALIGN_CLI = path.join(import.meta.dirname, "..", "cli", "align.mjs");
async function alignCli(args, env) {
  const r = await runScript(ALIGN_CLI, args, { env });
  if (r.status !== 0) throw new Error("align " + args.join(" ") + " exit " + r.status + "\n" + r.stderr);
  return r.stdout.trim();
}

function seedEvents() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "align-usage-c-"));
  const t0 = NOW - 3600000, ev = [];
  const add = (dt, type, f = {}) => ev.push({ t: t0 + dt, page: "p1", src: "local", pid: "pA", dev: "desktop", w: "wide", type, ...f });
  add(0, "page.open", { vw: 1440, vh: 900 });
  add(1000, "view.tab", { v: "dec" });
  add(2000, "detail.open", { k: "d", id: "d1", from: "click" });
  add(5000, "decide.pick", { id: "d1", opt: 1, rec: true, change: "new" });
  add(7000, "decide.pick", { id: "d1", opt: 2, rec: false, change: "change" });
  add(9000, "decide.pick", { id: "d1", opt: 1, rec: true, change: "change" });
  add(10000, "input.write", { field: "note", id: "d1", len: 8 });
  add(12000, "send.click", { n: 1 });
  add(12800, "send.done", { ok: true, status: 200, ms: 800, n: 1, items: [{ k: "d", id: "d1", choice: true, opt: 1, rec: true, len: 8 }] });
  add(13000, "api.slow", { path: "/p/data", ms: 3200 });
  add(14000, "error.js", { msg: "boom", at: "x:1:2" });
  add(60000, "page.close", { dur: 60000 });
  ev.push({ t: t0 + 70000, page: "p1", src: "remote", pid: "pB", dev: "phone", w: "narrow", type: "page.open" });
  ev.push({ t: t0 + 71000, page: "p1", src: "remote", pid: "pB", dev: "phone", w: "narrow", type: "detail.open", k: "d", id: "d2", from: "click" });
  ev.push({ t: t0 + 80000, page: "p1", src: "app", type: "app.open" });
  ev.push({ t: t0 + 80500, page: "p1", src: "app", type: "app.answer", n: 1, ok: true, ms: 300 });
  ev.push({ t: t0 + 90000, page: "p1", src: "local", pid: "pC", dev: "desktop", w: "wide", type: "page.open" });
  ev.push({ t: t0 + 95000, page: "p1", src: "local", pid: "pC", dev: "desktop", w: "wide", type: "decide.pick", id: "d2", opt: 1, rec: true, change: "new" });
  ev.push({ t: t0 + 900000, page: "p1", src: "app", type: "app.open" });
  ev.push({ t: t0 + 900200, page: "p1", src: "local", pid: "pC", dev: "desktop", w: "wide", type: "error.api", path: "/p/data", status: 0, kind: "timeout", ms: 20000, n: 3 });
  fs.writeFileSync(path.join(d, U.dayOf(t0) + ".jsonl"), ev.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return d;
}

test("align log：按 --type（可写前缀）/ --id / --src 过滤，一行一条；--json 给 agent", async (t) => {
  const d = seedEvents();
  // 只看这批事件：单独的 ALIGN_STORE，worker 里跑 CLI，「现在」钉在 NOW（ALIGN_NOW）
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "align-usage-cli-"));
  fs.mkdirSync(path.join(store, "usage"));
  for (const n of fs.readdirSync(d)) fs.copyFileSync(path.join(d, n), path.join(store, "usage", n));
  fs.writeFileSync(path.join(store, "pages.json"), JSON.stringify({ p1: path.join(dir, "p1.html") }));
  const cli = (...args) => alignCli(args, { ...process.env, ALIGN_STORE: store, ALIGN_NOW: NOW_ISO });
  const picks = (await cli("log", "p1", "--since", "2d", "--type", "decide.pick")).split("\n");
  assert.equal(picks.length, 4);
  assert.match(picks[0], /^\d\d-\d\d \d\d:\d\d:\d\d decide\.pick id=d1 opt=1 rec=true change=new · local desktop wide #pA$/);
  assert.equal((await cli("log", "p1", "--since", "2d", "--type", "decide")).split("\n").length, 4, "前缀");
  assert.equal((await cli("log", "p1", "--since", "2d", "--type", "decide.*,send")).split("\n").length, 6);
  assert.match(await cli("log", "p1", "--since", "2d", "--type", "send.done"), /items=\[k:d id:d1 choice:true opt:1 rec:true len:8\]/);
  assert.equal((await cli("log", "p1", "--since", "2d", "--src", "remote")).split("\n").length, 2);
  const limited = (await cli("log", "p1", "--since", "2d", "--limit", "2")).split("\n");
  assert.equal(limited.length, 3);
  assert.match(limited[0], /^共 20 条，显示最后 2 条/);
  assert.match(limited[2], /error\.api path=\/p\/data status=0 kind=timeout ms=20000 n=3 · local desktop wide #pC$/);
  const js = JSON.parse(await cli("log", "p1", "--since", "2d", "--id", "d1", "--json"));
  assert.equal(js.length, 6);
  assert.ok(js.every((e) => e.id === "d1" || e.items));
  assert.match(await cli("log", "p1", "--since", "2d", "--type", "nothing"), /^没有符合条件的事件/);
  await assert.rejects(cli("log", "nope"), /没有登记名为 nope/);
  await assert.rejects(cli("log", "p1", "--since", "yesterday"), /时间写成/);
});

test("align usage：摘要（时长、区块、看到→作答、改主意、常用 / 没用过、来源、报错、慢请求）；--json 是同一份数据", async () => {
  const d = seedEvents();
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "align-usage-cli2-"));
  fs.mkdirSync(path.join(store, "usage"));
  for (const n of fs.readdirSync(d)) fs.copyFileSync(path.join(d, n), path.join(store, "usage", n));
  fs.writeFileSync(path.join(store, "pages.json"), JSON.stringify({ p1: path.join(dir, "p1.html") }));
  const cli = (...args) => alignCli(args, { ...process.env, ALIGN_STORE: store, ALIGN_NOW: NOW_ISO });
  const text = await cli("usage", "p1", "--since", "7d");
  const L = text.split("\n");
  assert.match(L[0], /^p1 使用摘要（.*）：打开 3 次，事件 20 条$/);
  assert.match(L[1], /^每天：10-24 可见 1m \/ 操作 11s（打开 3 次）$/, "操作时长不算 send.done、App");
  assert.match(L[2], /^区块打开：决定详情 2，决定页签 1；没打开过：轮次详情、/);
  assert.match(L[3], /^决定：看过 2 个，选了 2（1 个是下次打开页面才选），发出 1；同一次打开里看到 → 选中位 3\.0s（P75 3\.0s，中位 1 步），看到 → 发出中位 11s$/);
  assert.match(L[5], /^改主意 2 次：改选另一个选项 2；反复改的：d1×2$/);
  assert.match(L[6], /^最常用：decide\.pick 4，/);
  assert.match(L[7], /^没用过：.*round\.act.*split\.drag/);
  assert.match(L[8], /^来源（按打开次数）：本机 3080 40%，手机 App 40%，远程 4080·手机 20%；宽度（按事件）：宽 88%，窄 12%$/, "App 每次打开都算");
  assert.match(L[9], /^发送：成功 1，失败 0，中位 800ms；手机 App 发送 1$/);
  assert.match(L[10], /^报错：boom ×1；接口 \/p\/data timeout ×3$/);
  assert.match(L[11], /^慢请求（≥2s）：\/p\/data ×1 中位 3\.2s 最慢 3\.2s$/);
  const js = JSON.parse(await cli("usage", "p1", "--since", "7d", "--json"));
  assert.equal(js.timing.decision.viewToActMedianMs, 3000, "跨加载的 d2 不计时");
  assert.equal(js.timing.decision.laterLoad, 1);
  assert.equal(js.timing.decision.viewToSendMedianMs, 10800);
  assert.equal(js.changes.total, 2);
  assert.ok(js.features.never.includes("split.drag"));
  await assert.rejects(cli("usage", "p1", "--type", "x"), /usage 不收 --type/);
  assert.match(await cli("usage", "p1", "--since", "1m"), /起没有使用记录$/);
});

test("跑测试时刚过午夜：数据按钉住的 NOW 造，摘要「每天」仍只有数据那一天", (t) => {
  // 原先 seedEvents 按 Date.now() - 1h 造数据、跨 15 分钟：00:45–01:00 跑，最后两条事件过了午夜，「每天」拆成两行（2026-10-26 00:51 在 master 上复现）。这里把墙钟拨到第二天 00:50 重放
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-25T00:50:00") });
  const d = seedEvents(), now = Date.now(), since = U.parseWhen("7d", now);
  const s = U.summarize(U.readUsage(d, { page: "p1", since, until: now + 1 }), { since, until: now + 1 });
  assert.deepEqual(s.days.map((x) => x.day), ["2026-10-24"]);
  assert.equal(U.summaryText(s, "p1").split("\n")[1], "每天：10-24 可见 1m / 操作 11s（打开 3 次）");
});

test("手机 App（服务端记）：app.open 同一页 10 分钟一次；app.answer 带 n / ok；写失败只报告不挡 App", async () => {
  let t = 0; const got = [], errs = [];
  const rec = appUsageRecorder((page, src, ev) => { if (ev.type === "boom") throw new Error("x"); got.push([page, src, ev.type, ev.n, ev.ok]); }, () => t, (e) => errs.push(e));
  rec.open("p1"); t = 300_000; rec.open("p1"); rec.open("p2"); t = 600_001; rec.open("p1");
  assert.deepEqual(got.map((g) => g.slice(0, 3).join(" ")), ["p1 app app.open", "p2 app app.open", "p1 app app.open"]);
  assert.equal(await rec.answer("p1", 2, async () => "r"), "r");
  await assert.rejects(rec.answer("p1", 1, async () => { throw new Error("send failed"); }), /send failed/);
  assert.deepEqual(got.slice(3), [["p1", "app", "app.answer", 2, true], ["p1", "app", "app.answer", 1, false]]);
  // 接线：网关桥的拉数据、发送都经 record
  const calls = [];
  const bridge = createPhoneBridge(async () => {}, () => ({}), async () => ({}), { open: (p) => calls.push("open " + p), answer: (p, n, run) => { calls.push("answer " + p + " " + n); return run(); } });
  bridge.pageData("p1"); await bridge.pageData3("p1");
  await assert.rejects(bridge.answerBatch3("p1", []), /./);
  assert.deepEqual(calls, ["open p1", "open p1", "answer p1 0"]);
  const bad = appUsageRecorder(() => { throw new Error("disk"); }, () => 0, (e) => errs.push(e.message));
  bad.open("p1");
  assert.deepEqual(errs, ["disk"]);
});
