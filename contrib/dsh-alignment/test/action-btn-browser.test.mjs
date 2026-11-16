// 真浏览器（2026-10-26）：详情底部的操作按钮（确认 / 恢复、修改 / 改主意、暂缓、放弃）同一套选中写法——
// 默认白底 + 功能色字和图标；点一下选中（aria-pressed=true）变实心功能色底 + 白字 + 白勾，白字对底色 ≥ 4.5:1、底色对面板白 ≥ 3:1；再点一下回到默认。
// 宽 1280（悬浮按钮）和 420（贴底底条）各走一遍。用计算后的样式断言；页面加一条去掉过渡动画的样式，读到的是终值。
// 页面由 align.mjs render() 生成，本地 http 服务给页面和 /data；依赖插件 devDependencies 里的 playwright-core（DSH_ALIGN_PW_DIR 覆盖），缺失即失败。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "align-actbtn-"));
process.env.ALIGN_STORE = dir;
process.env.ALIGN_WORKSPACES = path.join(dir, "workspace.json");
const A = await import("../cli/align.mjs");
const { chromium } = createRequire((process.env.DSH_ALIGN_PW_DIR ? path.join(process.env.DSH_ALIGN_PW_DIR, "package.json") : import.meta.url))("playwright-core");

const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
const name = "ab";
const file = path.join(dir, name + ".html");
fs.writeFileSync(file, A.render({ version: 3, name, title: "按钮测试", owner: "session-fm", updated: ago(1), projects: [{ id: "pa", title: "dsh-core", cwd: "C:/p/pa" }],
  rounds: [
    { id: "r1", sid: "session-w1", title: "等验收的一轮", status: "done", proj: "pa", started: ago(90), ended: ago(30), result: "交了" },
    { id: "r2", sid: "session-w2", title: "进行中的一轮", status: "doing", proj: "pa", started: ago(20) },
    { id: "r3", sid: "session-w3", title: "暂缓的一轮", status: "paused", proj: "pa", started: ago(200), ended: ago(100) }],
  decisions: [{ id: "d2", title: "已发送的决定", why: "原因", status: "sent", round: "r1", proj: "pa", risk: "低", cat: "方向取舍", rec: "做", opt: [{ label: "做", effect: "a" }, { label: "不做", effect: "b" }], opened: ago(60), answer: { choice: "做", at: ago(5) } }],
  notes: [] }));
fs.writeFileSync(path.join(dir, "pages.json"), JSON.stringify({ [name]: file }));

// 功能色（template.html :root）：绿 --green、蓝 --blue、琥珀 --amber、红 --red
const C = { green: "rgb(42, 110, 53)", blue: "rgb(47, 98, 214)", amber: "rgb(163, 95, 0)", red: "rgb(191, 44, 44)" };
const WHITE = "rgb(255, 255, 255)";
const lum = (rgb) => { const [r, g, b] = rgb.match(/\d+/g).slice(0, 3).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test("操作按钮：默认白底功能色字，选中实心功能色底白字（1280 / 420）", { timeout: 90_000 }, async (t) => {
  const handler = A.createHandler({ prefix: A.ROUTE_PREFIX, send: async () => {}, guard: () => null, live: async (sids) => Object.fromEntries(sids.map((s) => [s, "idle"])) });
  const server = createServer((req, res) => {
    const p = req.url.split("?")[0];
    const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (p.endsWith("/log")) return json(200, { ok: true });
    if (p === "/alignment/health") return json(200, { ok: true, api: A.API_VERSION });
    if (p === "/alignment/todos") return json(200, { ok: true, api: 2, sessions: {}, activity: {} });
    if (p === "/alignment/fm") return json(200, { ok: true, page: name, fm: { sid: "session-fm", title: "first mate" }, refresh: null });
    if (p === "/alignment/tools") return json(200, { ok: true, api: 1, rounds: {} });
    return handler(req, res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  page.setDefaultTimeout(5000);
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("http://127.0.0.1:" + server.address().port + "/alignment/p/" + name);
  await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
  await page.waitForSelector(".sc[data-key]");

  const look = (sel) => page.$eval(sel, (b) => { const s = getComputedStyle(b), i = b.querySelector(".i"); return { bg: s.backgroundColor, img: s.backgroundImage, color: s.color, border: s.borderTopColor, icon: i ? getComputedStyle(i).color : "", pressed: b.getAttribute("aria-pressed"), iconHtml: i ? i.innerHTML : "" }; });
  // 勾的图形：「确认」默认的图标就是勾（ACT_ICON.accept = check）
  let CHECK = "";
  const isDefault = (s, c, what) => {
    assert.equal(s.color, c, what + " 默认字色");
    assert.equal(s.icon, c, what + " 默认图标色 = 字色");
    assert.equal(s.bg, "rgba(0, 0, 0, 0)", what + " 默认不铺底色");
    assert.match(s.img, /^linear-gradient\(rgb\(255, 255, 255\)/, what + " 默认白底（白到 #f8f9fa 轻渐变）");
    assert.notEqual(s.border, "rgb(228, 230, 234)", what + " 默认描边是功能色的浅色，不是灰线");
    assert.equal(s.pressed ?? "false", "false");
  };
  const isOn = (s, c, what) => {
    assert.equal(s.pressed, "true", what + " aria-pressed");
    assert.equal(s.bg, c, what + " 选中实心功能色底");
    assert.equal(s.img, "none", what + " 选中没有白渐变盖住底色");
    assert.equal(s.border, c, what + " 选中描边同底色");
    assert.equal(s.color, WHITE, what + " 选中白字");
    assert.equal(s.icon, WHITE, what + " 选中白图标");
    assert.ok(CHECK && s.iconHtml === CHECK, what + " 选中图标换成勾");
    assert.ok(ratio(s.color, s.bg) >= 4.5, what + " 白字对底色 " + ratio(s.color, s.bg).toFixed(2));
    assert.ok(ratio(s.bg, WHITE) >= 3, what + " 底色对面板白 " + ratio(s.bg, WHITE).toFixed(2));
  };
  const btn = (rid, v) => '[data-act="ract"][data-id="' + rid + '"][data-v="' + v + '"]';
  const cases = [["r1", "accept", C.green, "确认"], ["r1", "revise", C.blue, "修改"], ["r1", "dropped", C.red, "放弃"], ["r2", "paused", C.amber, "暂缓"], ["r3", "resume", C.green, "恢复"]];

  await page.click('.sc[data-rid="r1"]');
  CHECK = (await look(btn("r1", "accept"))).iconHtml;
  assert.notEqual(CHECK, (await look(btn("r1", "revise"))).iconHtml, "修改默认不是勾");
  for (const width of [1280, 420]) {
    await page.setViewportSize({ width, height: 800 });
    for (const [rid, v, c, label] of cases) {
      const what = width + " " + label;
      await page.click('.sc[data-rid="' + rid + '"]');
      await page.waitForSelector(btn(rid, v));
      await page.mouse.move(1, 1);
      isDefault(await look(btn(rid, v)), c, what);
      await page.click(btn(rid, v));
      await page.mouse.move(1, 1);
      isOn(await look(btn(rid, v)), c, what);
      // 同一行其它按钮仍是默认（一行只有一个实心）
      const solid = await page.$$eval('[data-act="ract"][data-id="' + rid + '"]', (bs) => bs.filter((b) => getComputedStyle(b).color === "rgb(255, 255, 255)").length);
      assert.equal(solid, 1, what + " 一行只有选中的那个是实心");
      await page.click(btn(rid, v));
      await page.mouse.move(1, 1);
      isDefault(await look(btn(rid, v)), c, what + "（取消后）");
    }
    // 悬停：浅功能色底、功能色描边，字色不变
    await page.click('.sc[data-rid="r1"]');
    await page.hover(btn("r1", "accept"));
    const h = await look(btn("r1", "accept"));
    assert.equal(h.bg, "rgb(228, 243, 231)", width + " 确认悬停 gsoft 底");
    assert.equal(h.img, "none");
    assert.equal(h.border, C.green);
    assert.equal(h.color, C.green);
  }
  // 已发送的决定：「改主意」同一套默认写法（蓝）
  await page.click('[data-act="tab"][data-v="dec"]');
  await page.click('[data-act="df"][data-v="sent"]');
  await page.click('.dr[data-k="d:d2"]');
  await page.mouse.move(1, 1);
  isDefault(await look('[data-act="redo"][data-id="d2"]'), C.blue, "改主意");
  assert.deepEqual(errors, []);
});
