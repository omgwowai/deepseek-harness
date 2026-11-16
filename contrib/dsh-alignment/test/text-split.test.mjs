// text-split.test.mjs：对齐页正文拆分（cli/text-split.mjs，2026-10-24 从 template.html 的 @text 段搬出）+ 服务端 data.text（手机接口版本 6）。
// node --test plugins/dsh-alignment/test/text-split.test.mjs（经 dsh-verify 8pl 收集）
// 覆盖：每种 token（含 m 里 undefined 组写 null）、segs 的标签 / 序号 / 好处代价 / ask、kpi 的 rank（rank < 4-n 与 kpis(list, 4-n) 一致）
// 和 fixed、轮次 mainFrom 口径；一致性：网页 /data 回的 text 与手机 pageData3 回的 text 深度相等、render() 注入页面的代码就是模块源码。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(PLUGIN, "cli");
process.env.ALIGN_STORE = fs.mkdtempSync(path.join(os.tmpdir(), "align-text-split-"));
process.env.ALIGN_WORKSPACES = path.join(process.env.ALIGN_STORE, "workspace.json");
const S = await import(pathToFileURL(path.join(CLI, "text-split.mjs")).href);
const A = await import(pathToFileURL(path.join(CLI, "align.mjs")).href);
const { SAMPLE_PAGE } = await import(pathToFileURL(path.join(CLI, "text-fixtures.mjs")).href);
const { createPhoneBridge, PHONE_API } = await import(pathToFileURL(path.join(PLUGIN, "index.js")).href);

const tok1 = (s) => { const ts = S.textOf({ version: 3, decisions: [{ id: "x", result: s }], rounds: [] }).d.x.result; return ts; };

test("tokens：每种 token 的 t / v / m（undefined 组写 null）", () => {
  const cases = [
    ["见 https://a.b/c?d=1 吧", { t: "url", v: "https://a.b/c?d=1", m: ["https://a.b/c?d=1"] }],
    ["在 C:\\x\\y.json 里", { t: "path", v: "C:\\x\\y.json", m: ["C:\\x\\y.json"] }],
    ["跑 \x60npm test\x60 看", { t: "code", v: "\x60npm test\x60", m: ["\x60npm test\x60", "npm test"] }],
    ["提交 3f9a2c1d 之后", { t: "hash", v: "3f9a2c1d", m: ["3f9a2c1d"] }],
    ["战绩 12 胜 3 负", { t: "wlt", v: "12 胜 3 负", m: ["12 胜 3 负", "12", "3", null] }],
    ["战绩 12 胜 3 负 1 平", { t: "wlt", v: "12 胜 3 负 1 平", m: ["12 胜 3 负 1 平", "12", "3", "1"] }],
    ["错字率从 47.6% 降到 9.2%", { t: "cmp", v: "从 47.6% 降到 9.2%", m: ["从 47.6% 降到 9.2%", "47.6%", "9.2%"] }],
    ["用时 120 秒 → 45 秒", { t: "cmp", v: "120 秒 → 45 秒", m: ["120 秒 → 45 秒", "120 秒", "45 秒"] }],
    ["显存 15.2/16.3 GB 了", { t: "ratio", v: "15.2/16.3 GB", m: ["15.2/16.3 GB", "15.2", "16.3", " GB"] }],
    ["完成 3/5", { t: "ratio", v: "3/5", m: ["3/5", "3", "5", null] }],
    ["花了 ¥300", { t: "num", v: "¥300", m: ["¥300"] }],
    ["叫「发布窗口」的", { t: "term", v: "「发布窗口」", m: ["「发布窗口」", "发布窗口"] }],
  ];
  for (const [s, want] of cases) {
    const ts = tok1(s);
    assert.deepEqual(ts.find((x) => x.t !== "text"), want, s);
    assert.equal(ts.map((x) => x.v).join(""), s, "拼回原文: " + s);
    for (const x of ts) if (x.t === "text") assert.deepEqual(Object.keys(x), ["t", "v"]);
  }
  const aside = tok1("峰值（约 1.5 秒）");
  assert.deepEqual(aside, [{ t: "text", v: "峰值" }, { t: "aside", v: [{ t: "text", v: "约 " }, { t: "num", v: "1.5 秒", m: ["1.5 秒"] }] }]);
  // 会话 ID（网页留言框短标签用的 sid token）不在冻结接口的类型里：折成 text，和相邻 text 合并
  assert.equal(S.tokens("问 session-1a2b3c4d 吧").some((x) => x.t === "sid"), true, "网页仍认 sid");
  assert.deepEqual(tok1("问 session-1a2b3c4d 吧"), [{ t: "text", v: "问 session-1a2b3c4d 吧" }]);
  assert.deepEqual(tok1("（问 session-1a2b3c4d）"), [{ t: "aside", v: [{ t: "text", v: "问 session-1a2b3c4d" }] }]);
  // 线上形状是纯 JSON：序列化往返不丢东西（没有 undefined）
  const t = S.textOf(SAMPLE_PAGE);
  assert.deepEqual(JSON.parse(JSON.stringify(t)), t);
});

test("segs：标签、①② 序号、+ 好处 / - 代价、• 不算代价、ask", () => {
  const why = S.textOf(SAMPLE_PAGE).d["d-open"].why;
  assert.deepEqual(why.map(({ toks, k, dir, w, ...g }) => g), [
    { label: "背景", no: 1 }, { label: "代价", no: 2 }, { label: "好处", pc: "pro" }, { label: "风险", pc: "con", ask: true }, {},
  ]);
  assert.equal(why[0].toks.map((x) => x.v).join(""), "现在每次构建要 90 秒", "标签和句末标点不进 toks");
  const opt = S.textOf(SAMPLE_PAGE).d["d-open"].opt;
  assert.equal(opt.length, 2, "与 d.opt 下标一一对应");
  assert.deepEqual(opt[0].map((g) => g.pc), ["pro", "con"]);
  assert.deepEqual(opt[1].map((g) => g.toks.map((x) => x.v).join("")), ["维持现状"]);
  const d = S.textOf(SAMPLE_PAGE).d;
  assert.deepEqual([d["d-pending"].why, d["d-pending"].opt, d["d-pending"].result, d["d-pending"].kpi], [[], [], null, []], "没有 why / opt / result");
  assert.ok(Array.isArray(d["d-done"].result) && d["d-done"].result.some((x) => x.t === "hash"));
});

// 2026-10-26：手机接口给每句带上类型（k / dir，rowKinds 判，和网页下文符号同一份）和网页那一份 token（w / nextW / whyW / resultW，多 step / quote / idf），
// 都是可选字段：旧 App 只读原来的键，原来的键和值不变
test("类型：决定说明、轮次现状 / 结果每句带 k（trend 带 dir），和 rowKinds 逐句相同；决定第一句按 ASK_WEB 记 ask；选项后果不带", () => {
  const t = S.textOf(SAMPLE_PAGE);
  const main = t.r["r-kinds"].main;
  assert.deepEqual(main.map((g) => g.k + (g.dir ? ":" + g.dir : "")), ["dot", "no", "pro", "con", "ask", "you", "warn", "wait", "cost", "trend:down", "trend:up", "trend:flat", "dot", "dot"]);
  for (const r of SAMPLE_PAGE.rounds) {
    const from = t.r[r.id].mainFrom, list = S.segs(from ? r[from] : "");
    assert.deepEqual(t.r[r.id].main.map((g) => ({ k: g.k, ...(g.k === "no" ? { n: g.no } : {}), ...(g.dir ? { dir: g.dir } : {}) })), S.rowKinds(list), r.id);
  }
  const d = SAMPLE_PAGE.decisions[0], why = t.d[d.id].why, ks = S.rowKinds(S.segs(d.why));
  assert.deepEqual(why.slice(1).map((g) => g.k), ks.slice(1).map((k) => k.k), "下文同 rowKinds");
  const first = (s) => S.textOf({ version: 3, rounds: [], decisions: [{ id: "x", why: s }] }).d.x.why[0].k;
  assert.equal(first("所以来问你选哪个。背景是这样"), "ask", "第一句是问你");
  assert.equal(first("页面上写着「要你定」这个词。背景"), "dot", "「」里的不算（同网页 unq）");
  assert.ok(t.d[d.id].opt.flat().every((g) => !("k" in g)), "选项后果不带类型");
});

test("网页 token：w 只在和 toks 不同时给（第 N/M 步是 step 不是 ratio、引用原话 quote、等宽 idf）；next / why / result 另给 *W；原来的键不变", () => {
  const t = S.textOf(SAMPLE_PAGE), r = t.r["r-kinds"];
  const ts = (list) => list.map((x) => x.t);
  assert.deepEqual(r.main[0].toks.filter((x) => x.t !== "text").map((x) => x.t), ["ratio"], "旧 App 照旧拿到比例");
  assert.deepEqual(r.main[0].w.filter((x) => x.t !== "text"), [
    { t: "step", v: "第 2/5 步", m: ["第 2/5 步", "2", "5"] }, { t: "idf", v: "text-split.mjs", m: ["text-split.mjs"] }]);
  assert.equal(r.main[0].w.map((x) => x.v).join(""), r.main[0].toks.map((x) => x.v).join(""), "w 拼回同一句原文");
  assert.ok(ts(r.main[12].w).includes("quote") && ts(r.main[7].w).includes("idf") && ts(r.main[13].w).includes("idf"));
  assert.ok(!("w" in r.main[1]), "没有网页专有 token 的句子不带 w");
  assert.ok(ts(r.nextW).includes("step") && ts(r.next).includes("ratio"));
  assert.ok(ts(r.whyW).includes("quote") && !ts(r.why).includes("quote"));
  assert.ok(!("nextW" in t.r["r-doing"]) && !("resultW" in t.d["d-done"]));
  const OLD = { seg: ["toks", "label", "no", "pc", "ask"], round: ["main", "mainFrom", "next", "why", "kpi"], dec: ["why", "kpi", "opt", "result"] };
  for (const x of Object.values(t.r)) {
    assert.deepEqual(Object.keys(x).filter((k) => OLD.round.includes(k)), OLD.round);
    assert.ok(Object.keys(x).every((k) => OLD.round.includes(k) || /^(next|why)W$/.test(k)));
    for (const g of x.main) assert.ok(Object.keys(g).every((k) => OLD.seg.includes(k) || ["k", "dir", "w"].includes(k)), JSON.stringify(Object.keys(g)));
  }
  for (const x of Object.values(t.d)) assert.ok(Object.keys(x).every((k) => OLD.dec.includes(k) || k === "resultW"));
});

test("kpi：自动挑的 rank = 分数名次、按原文位置排、ask 要点不参与；rank < 4-n 与网页 kpis(list, 4-n) 相同", () => {
  const t = S.textOf(SAMPLE_PAGE);
  const k = t.d["d-open"].kpi;
  assert.deepEqual(k.map((x) => [x.label, x.tk.v, x.rank, "fixed" in x]), [["现在每次构建要", "90 秒", 1, false], ["换方案要花", "¥300", 0, false], ["构建降", "20 秒", 2, false]]);
  const cands = { "d-open": S.segs(SAMPLE_PAGE.decisions[0].why).filter((g) => !g.ask) };
  for (const r of SAMPLE_PAGE.rounds) if (!r.kpi) cands[r.id] = S.segs(t.r[r.id].mainFrom ? r[t.r[r.id].mainFrom] : "");
  for (const [id, list] of Object.entries(cands)) {
    const tiles = (t.d[id] || t.r[id]).kpi;
    for (let n = 0; n <= 4; n++) {
      const web = S.kpis(list, 4 - n).map((x) => [x.label, x.tk.v]);
      assert.deepEqual(tiles.filter((x) => x.rank < 4 - n).map((x) => [x.label, x.tk.v]), web, id + " n=" + n);
    }
  }
  assert.ok(t.r["r-doing"].kpi.length === 4, "最多 4 个");
});

// 2026-10-24 标签规则：比较类取完整「X 对 Y」；只在词边界（标点 / 空格，数字和单位之间的空格不算）取，取不到完整的词就不给（不上卡）
const labels = (s) => S.kpis(S.segs(s), 8).map((k) => [k.label, k.tk.v]);
test("kpi 标签：数字前紧挨着「X 对 / vs / 比 Y」时取完整的「X 对 Y」（真实句子：S4v9 对 S4v7）", () => {
  const a = labels("五维字典 Elo 第 9 轮：S4v9 对 S4v7 22 胜 2 负 8 平，优势全来自致歉 / 复读前一句(29 题 21-0-6)");
  assert.deepEqual(a.find((x) => x[1] === "22 胜 2 负 8 平"), ["S4v9 对 S4v7", "22 胜 2 负 8 平"]);
  const b = labels("第 9 轮你标的 50 对里,S4v9 对 S4v7 是 22 胜 2 负 8 平(得分 0.81,区间 0.70–0.91)。");
  assert.deepEqual(b.slice(0, 2), [["第 9 轮你标", "50 对"], ["S4v9 对 S4v7", "22 胜 2 负 8 平"]]);
  assert.deepEqual(labels("新版本 vs 旧版本 3 胜 1 负"), [["新版本 vs 旧版本", "3 胜 1 负"]], "vs 原样保留");
  assert.deepEqual(labels("同一批题上 v2.1 比 v1.9 从 40 秒降到 12 秒"), [["v2.1 比 v1.9", "从 40 秒降到 12 秒"]], "比，cmp");
  assert.deepEqual(labels("新版比旧版快 30%"), [["新版比旧版快", "30%"]], "10 字以内照旧取整句");
});
test("kpi 标签：只在词边界取，不切在词中间；labelAfter 不加「…」", () => {
  assert.deepEqual(labels("另一处改动说明校准只影响到 1 题且被跳过，没有人工证据，遵循度上语气维还从 0.957 降到 0.923"),
    [["被跳过", "1 题"], ["遵循度上语气维", "从 0.957 降到 0.923"]], "句末的「还从」是虚词；前面一句超过 10 字没有边界，改取后面的「被跳过」（去掉「且」）");
  assert.equal(S.labelBefore("原来真机检查要手机连续亮屏"), "", "超过 10 字又没有空格：不给（原来切成「机检查要手机连续亮屏」）");
  assert.equal(S.labelBefore("我们统计了所有的寅子模拟人生 4 "), "", "空格后只剩「4」：不给，也不再退回末尾 10 个字");
  assert.equal(S.labelBefore("这一轮总共统计下来的请求 Playwright 超时"), "超时", "空格后、10 字以内最长的那段");
  assert.equal(S.labelBefore("Elo 排名里面第 9 轮的你标的"), "", "「9 轮」之间的空格不是词边界");
  assert.equal(S.labelAfter("的请求全部打到了另一台机器上"), "", "后半句超过 10 字又没有空格：不给");
  assert.equal(S.labelAfter("的 480p 约 78 GiB 的素材"), "480p", "在 10 字以内最后一个词边界断开，不加省略号，不把 78 和 GiB 拆开");
  assert.equal(S.labelAfter("个请求全部正常"), "个请求全部正常");
  assert.deepEqual(labels("原来真机检查要手机连续亮屏 10 分钟"), [], "没有标签的数字不上卡");
});

test("kpi：带 kpi 的条目全部 fixed、按原顺序、rank = 下标，cmp / 单 token / 兜底 num 三种", () => {
  const t = S.textOf(SAMPLE_PAGE);
  assert.deepEqual(t.r["r-fixed"].kpi, [
    { label: "准确率", tk: { t: "cmp", v: "88% → 93%", m: ["88% → 93%", "88%", "93%"] }, rank: 0, fixed: true },
    { label: "进度", tk: { t: "ratio", v: "3/5 项", m: ["3/5 项", "3", "5", " 项"] }, rank: 1, fixed: true },
    { label: "说明", tk: { t: "num", v: "待定", m: ["待定"] }, rank: 2, fixed: true },
  ]);
  assert.deepEqual(t.d["d-fixed"].kpi.map((x) => [x.tk.t, x.rank, x.fixed]), [["wlt", 0, true], ["num", 1, true]], "填了 kpi 就不再自动挑（正文里的 75% 不上卡）");
});

test("轮次 main / mainFrom：已结束先 result、否则先 state，都没有时 [] + null；next / why 是 token 或 null", () => {
  const r = S.textOf(SAMPLE_PAGE).r;
  assert.deepEqual(Object.fromEntries(Object.entries(r).map(([id, x]) => [id, x.mainFrom])),
    { "r-doing": "state", "r-done": "result", "r-state-only": "state", "r-result-only": "result", "r-empty": null, "r-kinds": "state", "r-fixed": "state" });
  assert.deepEqual([r["r-empty"].main, r["r-empty"].next, r["r-empty"].why, r["r-empty"].kpi], [[], null, null, []]);
  assert.equal(r["r-doing"].main[0].label, "现状");
  assert.ok(r["r-doing"].next.some((x) => x.t === "term"));
  assert.ok(r["r-doing"].why.some((x) => x.t === "code") && r["r-doing"].why.some((x) => x.t === "hash"));
});

test("textOf fail-fast：非版本 3、缺 id、字段类型不对都抛错", () => {
  assert.throws(() => S.textOf({ version: 2, items: [] }), /版本 3/);
  assert.throws(() => S.textOf({ version: 3, rounds: [] }), /decisions/);
  assert.throws(() => S.textOf({ version: 3, rounds: [{ title: "x" }], decisions: [] }), /缺 id/);
  assert.throws(() => S.textOf({ version: 3, rounds: [{ id: "r", state: 3 }], decisions: [] }), /round\/r\.state/);
  assert.throws(() => S.textOf({ version: 3, rounds: [], decisions: [{ id: "d", kpi: [{ label: "a" }] }] }), /kpi\[0\]/);
  assert.throws(() => S.textOf({ version: 3, rounds: [], decisions: [{ id: "d", opt: "x" }] }), /opt/);
});

test("样例页过 align.mjs validate，并且覆盖冻结接口的全部 11 种 token（没有 sid）", () => {
  A.validate(structuredClone(SAMPLE_PAGE));
  const kinds = new Set(), walk = (ts) => { for (const x of ts || []) { kinds.add(x.t); if (x.t === "aside") walk(x.v); } };
  const t = S.textOf(SAMPLE_PAGE);
  for (const x of [...Object.values(t.d), ...Object.values(t.r)]) {
    for (const g of [...(x.why && x.why.toks ? [] : x.why || []), ...(x.main || []), ...(x.opt || []).flat()]) walk(g.toks);
    walk(x.result); walk(x.next); if (x.main) walk(x.why); x.kpi.forEach((k) => walk([k.tk]));
  }
  assert.deepEqual([...kinds].sort(), ["aside", "cmp", "code", "hash", "num", "path", "ratio", "term", "text", "url", "wlt"]);
});

test("render()：版本 3 页面注入的代码就是 text-split.mjs 的 @inline 段，页面里拆出的结果和服务端 textOf 相同", () => {
  const html = A.render(SAMPLE_PAGE);
  const inline = A.textSplitInline();
  assert.ok(!html.includes("/*@text-split*/"), "占位已替换");
  assert.equal(html.split(inline).length, 2, "注入一次，逐字相同");
  const tpl = fs.readFileSync(path.join(CLI, "template.html"), "utf8");
  assert.ok(!/function tokens\(|function segs\(|function kpis\(/.test(tpl), "模板里不再有自己的一份");
  const pageTextOf = new Function(inline + "\nreturn textOf;")();
  assert.deepEqual(pageTextOf(SAMPLE_PAGE), S.textOf(SAMPLE_PAGE));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  for (const s of scripts) assert.doesNotThrow(() => new Function(s), "注入后的页面脚本能解析");
});

test("一致性：同一份页面，网页 /data 回的 text 与手机 pageData3 回的 text 深度相等；手机接口版本 10（text 自 6 起）", async () => {
  assert.equal(PHONE_API, 10);
  const file = path.join(process.env.ALIGN_STORE, "sample.html");
  await A.main(["init", file, "--name", "text-sample", "--title", "正文拆分样例", "--owner", "session-sample", "--version", "3"]);
  fs.writeFileSync(file, A.render(SAMPLE_PAGE));
  const live = async (sids) => Object.fromEntries(sids.map((s) => [s, "idle"]));
  const h = http.createServer(A.createHandler({ prefix: "/alignment", send: async () => {}, guard: () => null, live }));
  await new Promise((r) => h.listen(0, "127.0.0.1", r));
  try {
    const web = await (await fetch("http://127.0.0.1:" + h.address().port + "/alignment/p/text-sample/data")).json();
    const phone = await createPhoneBridge(async () => {}, () => [], live).pageData3("text-sample");
    assert.deepEqual(web.text, S.textOf(SAMPLE_PAGE));
    assert.deepEqual(phone.text, web.text);
    assert.deepEqual(phone.live, web.live);
    assert.ok(!fs.readFileSync(file, "utf8").includes('"text":{"v":1'), "text 不写进页面文件");
    const v2 = createPhoneBridge(async () => {}, () => [], live).pageData("text-sample");
    assert.equal("text" in v2, false, "版本 2 投影不加 text");
  } finally { h.close(); }
});

test("条目引用：refText / refParse 往返（轮次、决定、待办、工具调用、附件、会话）；标题去〔〕和换行、超 40 字截断；定位去〔〕「", () => {
  const cases = [
    [["first-mate", "r", "copy-ref", "", "", "对齐页详情区复制引用"], "〔对齐页 first-mate · 轮次 copy-ref「对齐页详情区复制引用」〕"],
    [["first-mate", "d", "tr-401", "", "", "TokenRouter 上游 401"], "〔对齐页 first-mate · 决定 tr-401「TokenRouter 上游 401」〕"],
    [["first-mate", "r", "copy-ref", "待办", "3", "补测试"], "〔对齐页 first-mate · 轮次 copy-ref · 待办 3「补测试」〕"],
    [["first-mate", "r", "copy-ref", "工具调用", "read 10/24 19:16:08 toolu_x 子 agent session-0a1b2c3d", "跑测试"], "〔对齐页 first-mate · 轮次 copy-ref · 工具调用 read 10/24 19:16:08 toolu_x 子 agent session-0a1b2c3d「跑测试」〕"],
    [["first-mate", "d", "yp-pref", "附件", "C:\\a\\b.md", "报告"], "〔对齐页 first-mate · 决定 yp-pref · 附件 C:\\a\\b.md「报告」〕"],
    [["first-mate", "r", "align-v8-ui-2", "会话", "session-5afe0000-1111-2222-3333-444455556666", "对齐页 v8"], "〔对齐页 first-mate · 轮次 align-v8-ui-2 · 会话 session-5afe0000-1111-2222-3333-444455556666「对齐页 v8」〕"],
  ];
  for (const [args, want] of cases) {
    assert.equal(S.refText(...args), want);
    const p = S.refParse(want);
    assert.deepEqual([p.page, p.k, p.id, p.sub, p.at, p.title], [args[0], args[1], args[2], args[3], args[4], args[5]], want);
  }
  assert.equal(S.refText("p", "r", "x", "", "", "a〔b〕c\n  d"), "〔对齐页 p · 轮次 x「abc d」〕", "标题去〔〕、换行和连续空白并成一个空格");
  const long = "字".repeat(50);
  assert.equal(S.refParse(S.refText("p", "r", "x", "", "", long)).title, "字".repeat(39) + "…", "超 40 字截成 39 字 + …");
  assert.equal(S.refText("p", "r", "x", "待办", "〔2〕「", "t"), "〔对齐页 p · 轮次 x · 待办 2「t」〕", "定位里去〔〕「");
  assert.equal(S.refText("p", "d", "x", "", "", ""), "〔对齐页 p · 决定 x〕", "没有标题就不带「」");
  assert.equal(S.refParse("〔对齐页 P · 轮次 x〕"), null, "页名只认小写登记名");
  assert.equal(S.refParse("〔对齐页 p · 会话 x〕"), null, "只认轮次 / 决定");
});

test("条目引用：tokens 认成 ref（网页画短标签），留言框分段打完就是标签，发送条浮层能列出；手机 textOf 折成 text", () => {
  const ref = S.refText("first-mate", "r", "copy-ref", "待办", "3", "补测试：引用格式、复制");
  const s = "看下 " + ref + "，还有 session-ffa2fee2 和 3f9a2c1d";
  const ts = S.tokens(s, true);
  assert.deepEqual(ts.map((x) => x.t), ["text", "ref", "text", "sid", "text", "hash"]);
  assert.equal(ts.map((x) => x.v).join(""), s, "拼回原文");
  assert.equal(ts[1].v, ref);
  // 标题里的「」和数字不会被拆成 term / num：整段引用先被认走
  assert.equal(S.tokens(ref).length, 1);
  assert.deepEqual(S.marksOf(s).map((x) => x.t), ["ref", "sid", "hash"]);
  // 留言框：光标就停在引用末尾（刚粘贴完）也已经是标签；其余还在打的照旧
  assert.deepEqual(S.memoSegs("x" + ref, ("x" + ref).length).map((g) => g.t), ["text", "mark"]);
  assert.deepEqual(S.memoSegs("x" + ref, ("x" + ref).length).map((g) => (g.t === "mark" ? g.tk.t : g.t)), ["text", "ref"]);
  assert.deepEqual(S.memoSegs(ref.slice(0, -1), ref.length - 1).map((g) => g.t), ["text"], "没打完〕不是引用");
  // 手机接口：ref 不在冻结的 token 类型里，折成 text 并入相邻 text
  assert.deepEqual(tok1("见 " + ref + " 吧"), [{ t: "text", v: "见 " + ref + " 吧" }]);
});
