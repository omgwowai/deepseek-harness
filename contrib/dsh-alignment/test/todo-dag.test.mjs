// 对齐页待办的并行组（模板 @par 段，2026-10-26）：连续两项以上标了 🤖 的是同时进行的一组，推断出来的不成组；
// 组的预计按组里最长的一项算（中位数、P75 各取最大），不相加；页面上 🤖 画成图标，文字里只去掉开头那个。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../cli/template.html", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const body = src.slice(src.indexOf("// @par-begin"), src.indexOf("// @par-end"));
const { parGroups, groupEta, botBy, todoText } = new Function(body + "; return { parGroups, groupEta, botBy, todoText };")();

const it = (text, agent) => ({ text, status: "pending", eta: null, ...(agent === undefined ? {} : { agent }) });
const S = { by: "session", runs: [] }, I = { by: "inferred", runs: [{ id: "a", kind: "subagent", name: null, state: "done", since: 1 }] };

test("模板里有 @par 段", () => assert.ok(body.length > 200));

test("并行组：连续两项以上 🤖（会话写的）成组，单独一项、推断的、中间隔开的不成组", () => {
  assert.deepEqual(parGroups([it("a"), it("🤖 b", S), it("🤖 c", S), it("d")]), [[1, 2]]);
  assert.deepEqual(parGroups([it("🤖 a", S), it("b"), it("🤖 c", S)]), [], "单独一项 🤖 不是组");
  assert.deepEqual(parGroups([it("a", I), it("b", I), it("c", I)]), [], "推断出来的不成组");
  assert.deepEqual(parGroups([it("🤖 a", S), it("b", I), it("🤖 c", S), it("🤖 d", S)]), [[2, 3]], "推断的一项把组隔开");
  assert.deepEqual(parGroups([it("🤖 a", S), it("🤖 b", S), it("c"), it("🤖 d", S), it("🤖 e", S), it("🤖 f", S)]), [[0, 1], [3, 5]]);
  assert.deepEqual(parGroups([]), []);
});

test("旧服务端（没有 agent 字段）：只看文字开头的 🤖", () => {
  assert.deepEqual(parGroups([it("🤖 a"), it(" 🤖b"), it("c 🤖")]), [[0, 1]]);
  assert.equal(botBy(it("🤖 a")), "session");
  assert.equal(botBy(it("a 🤖")), null, "不在开头的不算");
  assert.equal(botBy(it("a", I)), "inferred");
  assert.equal(botBy(it("a", null)), null);
});

test("组的预计：中位数、P75 各取组里最大，不相加；都没估时就没有", () => {
  const e = (p50, p75) => ({ text: "x", status: "pending", eta: { p50, p75 } });
  assert.deepEqual(groupEta([e(300, 540), e(240, 480), e(540, 1200)]), { p50: 540, p75: 1200 });
  assert.deepEqual(groupEta([e(600, 600), { text: "y", status: "pending", eta: null }]), { p50: 600, p75: 600 });
  assert.deepEqual(groupEta([e(900, 300)]), { p50: 900, p75: 900 }, "P75 不会小于中位数");
  assert.equal(groupEta([{ text: "y", eta: null }, { text: "z", eta: null }]), null);
});

test("文字里只去掉开头的 🤖（显示成图标），中间的照留", () => {
  assert.equal(todoText({ text: "🤖 视觉审查" }), "视觉审查");
  assert.equal(todoText({ text: "  🤖视觉审查" }), "视觉审查");
  assert.equal(todoText({ text: "原因来源与 🤖 判定" }), "原因来源与 🤖 判定");
});
