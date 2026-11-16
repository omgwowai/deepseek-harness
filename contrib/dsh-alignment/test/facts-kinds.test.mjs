// facts-kinds.test.mjs：对齐页详情「下文」的类型和字体分工（cli/text-split.mjs 的 rowKinds、idf / step / quote token、事实行的引用格式），
// 规则见 cli/text-split.mjs rowKinds。手机接口（textOf）不出新 token，冻结的 11 种不变。
// node --test plugins/dsh-alignment/test/facts-kinds.test.mjs（经 dsh-verify 8pl 收集）
import { test } from "node:test";
import assert from "node:assert/strict";
const S = await import("../cli/text-split.mjs");

const kind = (...texts) => S.rowKinds(texts.map((t) => S.segs(t)[0])).map((k) => k.k + (k.dir ? ":" + k.dir : "") + (k.n ? ":" + k.n : ""));
const toks = (s) => S.tokens(s).filter((t) => t.t !== "text").map((t) => t.t + ":" + t.v);

test("下文类型：真实正文里的句子各落到对的类型，先中先用", () => {
  assert.deepEqual(kind(
    "①先做补缺",
    "+ 不花大钱",
    "代价是估长 5 倍以上 2.1% → 6.3%",
    "两种做法都能回退，要看你在意不在意这处不一致，所以来问",
    "First Mate 不对外发消息，要你去找管理员",
    "你回一句什么时候能恢复，我好安排装机时间",
    "家里电脑 03:31 起连不上，装机没开始",
    "影响：Hindsight 的记忆入库和知识页刷新在报错",
    "3080 从 19:24 起对齐页地址全部 404，要重启 3080 后才在 3080 上看到，核对 check-20261024-193430",
    "要 3080 重启生效，核对 check-20261024-212306",
    "NT 侧全量约 ¥90，不占显卡",
    "最慢的是记忆入库去重测试，137 秒 → 35 秒",
    "设计稿那一轮 29 分钟 → 2 小时 34 分钟",
    "首条消息的自动 reflect 中位 46.7 秒 → 5.9 秒，盲评 3.33 → 4.20",
    "派活回合不进参照库",
  ), ["no:1", "pro", "con", "ask", "you", "you", "warn", "warn", "warn", "wait", "cost", "trend:down", "trend:up", "trend:flat", "dot"]);
});

test("下文类型：容易判错的句子（审查员找出的误判）", () => {
  assert.deepEqual(kind(
    "手机设置里现有三个开关：需要你决定、agent 完成、等你回应", // 「需要你决定」是开关名，不是要你做
    "现在测试里的「现在」固定在一个日期，另外补了一个跨午夜的用例，在旧代码上会失败", // 先红后绿，不是风险
    "已合入 4eee12ce，不用重启", // 合入、不用重启都不单列
    "3080 已重启，服务端改动生效", // 已重启不是等生效
    "全部 450 个文件都在", // 450 个不是 HTTP 状态码
    "保留你指定的「执行中…」", // 「」里的不算
  ), ["dot", "dot", "dot", "dot", "dot", "dot"]);
});

test("对比的方向：同一量纲换算后再比，单位对不上不比", () => {
  const dir = (s) => S.cmpDir(S.tokens(s).filter((t) => t.t === "cmp"));
  assert.equal(dir("29 分钟 → 2 小时"), "up");
  assert.equal(dir("2 小时 → 29 分钟"), "down");
  assert.equal(dir("66.7% → 16.7%"), "down");
  assert.equal(dir("12 次 → 3 分钟"), "flat");
});

test("字体分工的 token：标识符和命令等宽、「第 N/M 步」是步骤进度、引用原话", () => {
  assert.deepEqual(toks("核对 check-20261024-155801，跑 dsh-verify 和 install.ps1，--refine none，visual=true，/alignment/todos，ECONNRESET，claude-sonnet-5.5"),
    ["idf:check-20261024-155801", "idf:dsh-verify", "idf:install.ps1", "idf:--refine none", "idf:visual=true", "idf:/alignment/todos", "idf:ECONNRESET", "idf:claude-sonnet-5.5"]);
  assert.deepEqual(toks("第 7/8 步：1.7.8-local.14 已合入，装 local.16"), ["step:第 7/8 步", "idf:1.7.8-local.14", "idf:local.16"]);
  assert.deepEqual(toks("显存 15.2/16.3 GB"), ["ratio:15.2/16.3 GB"], "真比例照旧");
  assert.deepEqual(toks("你说的「余量」两种都说得通"), ["quote:你说的「余量」"]);
  assert.deepEqual(toks("中文词、Playwright 和 agent 不算"), [], "普通英文单词、中文词不等宽");
  // 路径、提交号、会话 ID 仍是短标签（先认）
  assert.deepEqual(toks("见 C:\\a\\b.md 和 d5316c2").map((x) => x.split(":")[0]), ["path", "hash"]);
});

test("带 × 的倍数对比「×0.27 → ×0.78」：网页认成对比（画对比胶囊，下文按方向判）；手机接口照旧是两个 num", () => {
  const s = "中位偏差 ×0.27 → ×0.78，代价是 ×1.5→×1.2";
  const c = S.tokens(s).filter((t) => t.t === "cmp");
  assert.deepEqual(c.map((t) => [t.v, t.m[1], t.m[2]]), [["×0.27 → ×0.78", "×0.27", "×0.78"], ["×1.5→×1.2", "×1.5", "×1.2"]]);
  assert.equal(S.cmpDir(c.slice(0, 1)), "up");
  assert.equal(S.cmpDir(c.slice(1)), "down");
  assert.deepEqual(kind("回测：中位偏差 ×0.27 → ×0.78"), ["trend:up"]);
  // 手机接口（legacy）：和改之前逐字相同
  assert.deepEqual(S.tokens(s, false, true), [
    { t: "text", v: "中位偏差 ×" }, { t: "num", v: "0.27", m: ["0.27"] }, { t: "text", v: " → ×" }, { t: "num", v: "0.78", m: ["0.78"] },
    { t: "text", v: "，代价是 ×" }, { t: "num", v: "1.5", m: ["1.5"] }, { t: "text", v: "→×" }, { t: "num", v: "1.2", m: ["1.2"] },
  ]);
  const page = { version: 3, decisions: [], rounds: [{ id: "r", status: "done", result: "回测：中位偏差 ×0.27 → ×0.78" }] };
  assert.deepEqual(S.textOf(page).r.r.main[0].toks.map((t) => t.t), ["text", "num", "text", "num"]);
});

test("手机接口不变：textOf 不出 idf / step / quote，「第 7/8 步」仍是 ratio", () => {
  const legacy = S.tokens("第 7/8 步：跑 dsh-verify，你说的「余量」", false, true).map((t) => t.t);
  assert.deepEqual(legacy, ["text", "ratio", "text", "term"]);
  const page = { version: 3, decisions: [], rounds: [{ id: "r", status: "doing", state: "第 7/8 步：跑 dsh-verify" }] };
  const kinds = new Set(), walk = (ts) => { for (const x of ts || []) { kinds.add(x.t); if (x.t === "aside") walk(x.v); } };
  for (const g of S.textOf(page).r.r.main) walk(g.toks);
  assert.deepEqual([...kinds].sort(), ["ratio", "text"]);
});

test("事实行的引用：现状 / 结果 / 下一步 / 起因 / 待办原因 / 说明，下文一句写「第 N 句」，往返不变", () => {
  for (const [sub, at] of [["现状", ""], ["结果", "第 2 句"], ["下一步", ""], ["起因", ""], ["待办原因", ""], ["说明", "第 3 句"]]) {
    const ref = S.refText("first-mate", sub === "说明" ? "d" : "r", "eta-fix", sub, at, "五个初判原因都成立");
    const p = S.refParse(ref);
    assert.deepEqual([p.sub, p.at, p.title], [sub, at, "五个初判原因都成立"], ref);
    assert.deepEqual(S.tokens("见 " + ref).map((t) => t.t), ["text", "ref"], "正文和留言框认成一个引用标签");
  }
  assert.equal(S.refText("first-mate", "r", "eta-fix", "结果", "第 2 句", "五个"), "〔对齐页 first-mate · 轮次 eta-fix · 结果 第 2 句「五个」〕");
});
