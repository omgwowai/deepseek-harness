// 真浏览器回归(2026-10-24):对齐页的 First Mate 按钮和左上角「会话 / 决定」滑块。
// 1. 在非 First Mate 会话的侧栏里打开对齐页,按钮一直没有:/alignment/fm 在 3080 上要 27-107 s,页面在拿到结果前什么都不画,
//    出错(非 200)也静默 return,每 4 s 还叠发一次。现在:还没回来时先画置灰的按钮,失败写出原因,上一次没回来不再发。
// 2. 滑块每次 render() 都被 innerHTML 重建,新元素 --x/--w 默认 3px/0,设目标值后从 0 宽动画过去,定时重画时闪一下。
//    现在:定时重画、数据更新时滑块逐帧都在选中按钮下面;用户点另一个页签时仍有动画(中间帧不在终点)。
// 3. (2026-11-03)「刷新 First Mate」旁的派出强度:显示当前值,弹层列出模型支持的强度,选一档 POST /alignment/fm/effort 后按钮换成新值。
// 页面由 align.mjs render() 生成,本地 http 服务按 /alignment/p/<页> 的形状给页面、/data、/fm(可控快慢/失败),
// 页面放在同源 iframe 里(embedded,和 DSH 侧栏一样)。依赖插件 devDependencies 里的 playwright-core（DSH_ALIGN_PW_DIR 覆盖）,缺失即失败。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "align-browser-"));
process.env.ALIGN_STORE = dir;
process.env.ALIGN_WORKSPACES = path.join(dir, "workspace.json");
const A = await import("../cli/align.mjs");
const { chromium } = createRequire((process.env.DSH_ALIGN_PW_DIR ? path.join(process.env.DSH_ALIGN_PW_DIR, "package.json") : import.meta.url))("playwright-core");

const NOW = new Date().toISOString();
const data = {
  version: 3, name: "bt", title: "浏览器测试页", owner: "session-fm", updated: NOW, projects: [],
  rounds: [{ id: "r1", sid: "session-w1", title: "某会话", status: "running", started: NOW, next: "继续" }],
  decisions: [{ id: "d1", title: "要不要做 X", why: "原因", status: "open", options: [{ label: "做", effect: "a" }, { label: "不做", effect: "b" }], asked: NOW }],
  notes: [],
};
const html = A.render(data);

function serve(fmMode) {
  const EFFORTS = ["off", "low", "medium", "high", "xhigh", "max"].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1) }));
  const route = { provider: "anthropic", model: "claude-opus-5.5", name: "Claude Opus 5.5 (TokenRouter)" };
  const effort = fmMode === "off-route" ? { reasoningEffort: "max", effective: "xhigh", route, efforts: EFFORTS.filter((e) => e.id !== "max") } : { reasoningEffort: "xhigh", effective: "xhigh", route, efforts: EFFORTS };
  const st = { fmCalls: 0, dataN: 0, dismissed: [], effortPosts: [], effort, refresh: fmMode === "failed" ? { id: "rec-0241", oldSid: "session-old", page: "bt", state: "failed", step: "schedules", newSid: "session-fm", error: "迁移后核对不一致", createdAt: NOW, updatedAt: NOW } : null };
  const server = createServer((req, res) => {
    const p = req.url.split("?")[0];
    const json = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (p === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<!doctype html><body style=margin:0><iframe id=f src='/alignment/p/bt?embed=1&theme=light' style='width:575px;height:860px;border:0'></iframe></body>"); }
    if (p === "/alignment/p/bt") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(html); }
    if (p === "/alignment/p/bt/data") { st.dataN += 1; return json(200, { ...data, updated: new Date(Date.parse(NOW) + st.dataN * 1000).toISOString(), live: { "session-w1": "running" } }); }
    if (p === "/alignment/health") return json(200, { ok: true, api: A.API_VERSION });
    if (p === "/alignment/todos") return json(200, { ok: true, api: 2, todos: {}, activity: {} });
    if (p === "/alignment/fm/refresh/dismiss" && req.method === "POST") {
      let raw = ""; req.on("data", (c) => { raw += c; });
      return req.on("end", () => { const { id } = JSON.parse(raw); st.dismissed.push(id); st.refresh = { ...st.refresh, state: "dismissed" }; json(200, { ok: true, refresh: st.refresh }); });
    }
    if (p === "/alignment/fm/effort" && req.method === "POST") {
      let raw = ""; req.on("data", (c) => { raw += c; });
      return req.on("end", () => {
        const { reasoningEffort } = JSON.parse(raw);
        st.effortPosts.push(reasoningEffort);
        if (!st.effort.efforts.some((e) => e.id === reasoningEffort)) return json(400, { ok: false, message: "不支持 " + reasoningEffort });
        st.effort = { ...st.effort, reasoningEffort, effective: reasoningEffort };
        json(200, { ok: true, effort: st.effort });
      });
    }
    if (p === "/alignment/fm") {
      st.fmCalls += 1;
      if (fmMode === "hang") return; // 一直不回(3080 上 27-107 s)
      if (fmMode === "fail") return json(500, { ok: false, message: "session list exploded" });
      return json(200, { ok: true, page: "bt", fm: { sid: "session-fm", title: "first mate" }, refresh: st.refresh, effort: fmMode === "no-effort" ? { error: "dsh-workspace-effort 没有加载" } : st.effort });
    }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, st, base: "http://127.0.0.1:" + server.address().port })));
}

// 一个文件只起一个浏览器(2026-11-02 提速),每次 open 一个新 context。页面装假时钟(时间照常走),
// 等 4 s 轮询时用 fastForward 跳过去,不真等:poll() 是 setTimeout(poll, 4000) 链,跳一次触发一轮。
let browserP = null;
after(async () => { if (browserP) await (await browserP).close(); });
async function open(t, fmMode) {
  const { server, st, base } = await serve(fmMode);
  t.after(() => { server.closeAllConnections(); server.close(); });
  browserP ??= chromium.launch({ headless: true });
  const page = await (await browserP).newPage({ viewport: { width: 575, height: 860 } });
  t.after(() => page.context().close());
  await page.clock.install();
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base + "/");
  const fr = page.frames().find((f) => f.url().includes("/alignment/p/bt"));
  assert.ok(fr, "alignment frame");
  await fr.waitForSelector('.seg[data-seg="tab"] .th');
  /** 跳过一次 4 s 轮询,等这一轮的 /data 到了服务端。 */
  const pollOnce = async () => {
    const n = st.dataN;
    await page.clock.fastForward(4000);
    for (const end = Date.now() + 10_000; st.dataN === n;) { assert.ok(Date.now() < end, "4 s 轮询没有取 /data"); await new Promise((r) => setTimeout(r, 20)); }
  };
  return { page, fr, st, errors, pollOnce };
}
/** 两帧(ResizeObserver 回调已跑)+ 有限次的动画 / 过渡结束,再两帧。代替固定等待。 */
const settle = (fr) => fr.evaluate(async () => {
  const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  await frames();
  await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {})));
  await frames();
});

test("First Mate 按钮:接口还没回来时先画出(置灰),叠发被拦住;失败写出原因;回来后可用", { timeout: 60_000 }, async (t) => {
  {
    const { fr, st, errors, pollOnce } = await open(t, "hang");
    await pollOnce(); await pollOnce(); // 两次 4 s 轮询
    await settle(fr);
    const tools = await fr.evaluate(() => { const el = document.querySelector(".fmtools"); return el && { n: el.querySelectorAll("button").length, disabled: [...el.querySelectorAll("button")].map((b) => b.disabled), text: el.textContent, title: el.querySelector('[data-act="fm-ask"]')?.title }; });
    assert.ok(tools, "接口没回来时也有 .fmtools");
    assert.equal(tools.n, 3, "First Mate + 刷新 First Mate + 派出强度 三个按钮(页面在 iframe 里)");
    assert.deepEqual(tools.disabled, [true, true, true], "还没取到时置灰");
    assert.match(tools.title, /正在查找当前 First Mate/);
    assert.equal(st.fmCalls, 1, "上一次没回来,轮询不再叠发");
    assert.deepEqual(errors, []);
  }
  {
    // 上面两次 4 s 轮询本来就不取 /fm(First Mate 状态 30 s 才取一次),测不到防叠发。这里让轮询到期取 /fm 时
    // 打开页面那次 /fm 仍在路上:假时钟也接管 AbortSignal.timeout(20000),fastForward 30 s 会先把它中止(那时再发是对的);
    // 所以用 setSystemTime 只把 Date.now() 拨快 26 s(不触发计时器,20 s 超时不到期),再跳一次 4 s 轮询:
    // Date.now() - fmAt ≥ 30 s,这轮会调 fmFetch,而上一次 /fm 还没回来。
    const { page, st, errors, pollOnce } = await open(t, "hang");
    assert.equal(st.fmCalls, 1, "打开页面时取一次 /fm");
    await page.clock.setSystemTime(await page.evaluate(() => Date.now()) + 26_000);
    await pollOnce();
    // 这轮 /data 到了后还要取待办、再调 fmFetch:等下一轮 /data(说明这轮的 fmFetch 已返回)或 /fm 被叠发
    const n = st.dataN;
    for (const end = Date.now() + 10_000; st.dataN === n && st.fmCalls === 1;) {
      assert.ok(Date.now() < end, "到期的轮询之后没有下一轮");
      await page.clock.fastForward(1000);
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(st.fmCalls, 1, "30 s 到期的轮询:上一次 /fm 没回来,不再叠发");
    assert.deepEqual(errors, []);
  }
  {
    const { fr, errors } = await open(t, "fail");
    await fr.waitForSelector(".fmtools .fmst.err", { timeout: 6000 });
    const err = await fr.evaluate(() => document.querySelector(".fmtools .fmst.err").title);
    assert.match(err, /session list exploded/, "失败原因写出来");
    assert.deepEqual(errors, []);
  }
  {
    const { fr, errors } = await open(t, "ok");
    await fr.waitForFunction(() => document.querySelector('.fmtools [data-act="fm-ask"]')?.disabled === false, null, { timeout: 6000 });
    assert.equal(await fr.evaluate(() => document.querySelector('.fmtools [data-act="open-sess"]').dataset.sid), "session-fm");
    assert.deepEqual(errors, []);
  }
});

test("刷新失败记录:弹层里「标为已处理」发 dismiss,之后不再显示「刷新失败」,刷新按钮照常可用", { timeout: 60_000 }, async (t) => {
  const { fr, st, errors } = await open(t, "failed");
  await fr.click('.fmtools [data-act="fm-fail"]');
  await fr.waitForSelector('#fmpop [data-act="fm-dismiss"]');
  assert.match(await fr.evaluate(() => document.querySelector("#fmpop").textContent), /迁移后核对不一致/);
  await fr.click('#fmpop [data-act="fm-dismiss"]');
  await fr.waitForFunction(() => !document.querySelector("#fmpop .fmpop") && !document.querySelector('.fmtools [data-act="fm-fail"]'), null, { timeout: 6000 });
  assert.deepEqual(st.dismissed, ["rec-0241"], "POST /alignment/fm/refresh/dismiss with the record id");
  // 页面按回复里的 dismissed 记录重画:「刷新失败」没了,刷新按钮照常可用
  assert.equal(await fr.evaluate(() => document.querySelector('.fmtools [data-act="fm-ask"]')?.disabled), false);
  assert.deepEqual(errors, []);
});

test("派出强度:按钮显示当前值,弹层列出模型支持的强度,选一档发 POST 后按钮换成新值;读不到时置灰并写出原因", { timeout: 60_000 }, async (t) => {
  {
    const { page, fr, st, errors } = await open(t, "ok");
    const EFFORTS_ALL = st.effort.efforts;
    await fr.waitForFunction(() => document.querySelector('.fmtools [data-act="fm-effort"]')?.disabled === false, null, { timeout: 6000 });
    const btn = () => fr.evaluate(() => { const b = document.querySelector('.fmtools [data-act="fm-effort"]'); return { v: b.querySelector(".v")?.textContent, label: b.getAttribute("aria-label"), next: b.previousElementSibling?.dataset.act }; });
    assert.deepEqual(await btn(), { v: "Xhigh", label: "First Mate 派出会话的思考强度：Xhigh", next: "fm-ask" }, "紧挨在「刷新 First Mate」后面,显示模型元数据里的名字");
    await fr.click('.fmtools [data-act="fm-effort"]');
    await fr.waitForSelector("#fmpop .effs");
    const opts = await fr.evaluate(() => [...document.querySelectorAll("#fmpop .eff")].map((b) => [b.dataset.v, b.textContent, b.getAttribute("aria-pressed")]));
    assert.deepEqual(opts.map((o) => o[0]), ["off", "low", "medium", "high", "xhigh", "max"], "接口给的强度,原顺序");
    assert.deepEqual(opts.filter((o) => o[2] === "true").map((o) => o[0]), ["xhigh"], "当前值标为选中");
    assert.equal(await fr.evaluate(() => document.activeElement?.dataset.v), "xhigh", "焦点在当前值上");
    await fr.click('#fmpop .eff[data-v="high"]');
    await fr.waitForFunction(() => !document.querySelector("#fmpop .fmpop") && document.querySelector('.fmtools [data-act="fm-effort"] .v')?.textContent === "High", null, { timeout: 6000 });
    assert.deepEqual(st.effortPosts, ["high"], "POST /alignment/fm/effort {reasoningEffort: high}");
    assert.match(await fr.evaluate(() => document.querySelector(".fmtools .fmst.ok")?.textContent ?? ""), /已改为 High/);
    assert.equal(await fr.evaluate(() => document.activeElement?.dataset.act), "fm-effort", "关掉弹层后焦点回到按钮");
    // 选当前值不发请求
    await fr.click('.fmtools [data-act="fm-effort"]');
    await fr.click('#fmpop .eff[data-v="high"]');
    assert.deepEqual(st.effortPosts, ["high"]);
    // 服务端拒绝时弹层留着并写出原因
    st.effort = { ...st.effort, efforts: st.effort.efforts.filter((e) => e.id !== "max") };
    await fr.click('#fmpop .eff[data-v="max"]');
    await fr.waitForSelector("#fmpop pre");
    assert.match(await fr.evaluate(() => document.querySelector("#fmpop pre").textContent), /没改成：不支持 max/);
    assert.deepEqual(await fr.evaluate(() => ({ role: document.querySelector("#fmpop pre").getAttribute("role"), focused: document.activeElement === document.querySelector("#fmpop pre") })), { role: "alert", focused: true }, "失败原因读屏会播报,焦点停在它上面(弹层重画后不掉到 body)");
    // 30 s 一次的 /fm 轮询会调 fmRender:内容没变就不重写(焦点留在报错上,role=alert 不再插一次)
    const pollFm = async () => {
      const calls = st.fmCalls;
      await page.clock.setSystemTime(await page.evaluate(() => Date.now()) + 31_000); // 下一轮 4 s 轮询到期取 /fm
      for (const end = Date.now() + 10_000; st.fmCalls === calls;) { assert.ok(Date.now() < end, "轮询没有取 /fm"); await page.clock.fastForward(4000); await new Promise((r) => setTimeout(r, 20)); }
      await settle(fr);
    };
    const state = (p) => fr.evaluate((pre) => ({ same: pre === document.querySelector("#fmpop pre"), focusedPre: document.activeElement === document.querySelector("#fmpop pre") }), p);
    st.effort = { ...st.effort, efforts: EFFORTS_ALL }; // 服务端的列表和页面手上的一样
    const pre0 = await fr.evaluateHandle(() => document.querySelector("#fmpop pre"));
    await pollFm();
    assert.deepEqual(await state(pre0), { same: true, focusedPre: true }, "内容没变:报错元素没被换掉(不再插一次 role=alert),焦点还在它上面");
    st.effort = { ...st.effort, efforts: EFFORTS_ALL.filter((e) => e.id !== "off") };
    await pollFm();
    assert.deepEqual(await state(pre0), { same: false, focusedPre: true }, "内容变了:重写弹层,焦点放回新的报错上");
    await fr.press("#fmpop pre", "Escape");
    assert.equal(await fr.evaluate(() => !document.querySelector("#fmpop .fmpop") && document.activeElement?.dataset.act), "fm-effort", "Escape 关弹层,焦点回到「派出强度」");
    assert.deepEqual(errors, []);
  }
  {
    // 设好的一档当前模型不支持(换过默认模型):按钮带警示、title 写出实际用的那一档,弹层里也写出来
    const { fr, errors } = await open(t, "off-route");
    await fr.waitForFunction(() => document.querySelector('.fmtools [data-act="fm-effort"]')?.disabled === false, null, { timeout: 6000 });
    const b = await fr.evaluate(() => { const el = document.querySelector('.fmtools [data-act="fm-effort"]'); return { warn: !!el.querySelector(".i.warn"), label: el.getAttribute("aria-label") }; });
    assert.deepEqual(b, { warn: true, label: "First Mate 派出会话的思考强度：max（当前模型不支持，实际用 Xhigh）" });
    await fr.click('.fmtools [data-act="fm-effort"]');
    await fr.waitForSelector("#fmpop .note.warn");
    assert.match(await fr.evaluate(() => document.querySelector("#fmpop .note.warn").textContent), /不支持 max，现在派出的会话用 Xhigh/);
    assert.equal(await fr.evaluate(() => document.querySelectorAll('#fmpop .eff[aria-pressed="true"]').length), 0, "没有一档标成选中(max 不在列表里)");
    assert.equal(await fr.evaluate(() => document.activeElement?.dataset.v), "off", "没有选中的一档时焦点落在第一档");
    assert.deepEqual(errors, []);
  }
  {
    const { fr, errors } = await open(t, "no-effort");
    await fr.waitForFunction(() => document.querySelector('.fmtools [data-act="fm-ask"]')?.disabled === false, null, { timeout: 6000 });
    const b = await fr.evaluate(() => { const el = document.querySelector('.fmtools [data-act="fm-effort"]'); return { disabled: el.disabled, title: el.title }; });
    assert.equal(b.disabled, true, "读不到时置灰");
    assert.match(b.title, /dsh-workspace-effort 没有加载/, "写出原因");
    assert.deepEqual(errors, []);
  }
});

test("会话 / 决定 滑块:定时重画、数据更新时逐帧不离开选中按钮;用户切换仍有动画", { timeout: 60_000 }, async (t) => {
  const { fr, st, errors, pollOnce } = await open(t, "ok");
  await settle(fr); // 首次进入
  await fr.evaluate(() => {
    window.__off = []; window.__news = 0; let last = null;
    const tick = () => {
      const seg = document.querySelector('.seg[data-seg="tab"]'), th = seg && seg.querySelector(".th"), on = seg && seg.querySelector("button.on");
      if (th && on) {
        if (th !== last) { window.__news += 1; last = th; }
        const tr = th.getBoundingClientRect(), o = on.getBoundingClientRect();
        if (Math.abs(tr.left - o.left) > 1 || Math.abs(tr.width - o.width) > 1) window.__off.push(Math.round(tr.left - o.left) + "/" + Math.round(tr.width - o.width));
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  // 页签切到「决定」(用户操作)后等动画结束,再观察:/data 每 4 s 都变(数据更新 → render)+ 直接调几次重画
  await fr.click('.seg[data-seg="tab"] button:not(.on)');
  await fr.waitForTimeout(150);
  const mid = await fr.evaluate(() => window.__off.length);
  assert.ok(mid > 0, "用户切换时滑块有动画(中间帧不在终点)");
  await settle(fr);
  await fr.evaluate(() => { window.__off = []; window.__news = 0; });
  const n0 = st.dataN;
  await pollOnce(); await settle(fr);
  await pollOnce(); await settle(fr);
  const r = await fr.evaluate(() => ({ off: window.__off.slice(0, 10), n: window.__off.length, news: window.__news }));
  assert.ok(st.dataN - n0 >= 2, "期间 /data 至少取了两次");
  assert.ok(r.news >= 2, "期间滑块至少被重建两次(否则没测到重画): " + r.news);
  assert.equal(r.n, 0, "重画时滑块离开了选中按钮(闪): " + JSON.stringify(r.off));
  assert.deepEqual(errors, []);
});
