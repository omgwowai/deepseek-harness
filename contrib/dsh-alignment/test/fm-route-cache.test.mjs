// GET /alignment/fm under load (2026-10-24): on main the First Mate lookup (then resolver.current() -> sessionController.list
// over ~1k sessions; now one observeSession of the registered session) took 27-107 s, every open alignment page asked every 4 s, nothing was shared, so the page's
// "First Mate" / "刷新 First Mate" buttons waited forever. mountFmRoutes on a fake host whose session list is slow:
//   - concurrent GETs share one lookup; after the first answer a GET replies at once from the last answer
//   - an old answer (> fmFreshMs) is still served at once while one new lookup runs
//   - a lookup error is passed through as fmError (not cached as a sid, not hidden)
//   - a refresh changing state makes the next GET wait for a fresh lookup.
//   - (2026-11-03) the dispatch effort (optional service workspaceEffort): a stuck model lookup does not hold the GET back
//     (effortWaitMs), a missing service is reported as effort.error, POST /fm/effort maps the service's errors to 400 / 503.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "fm-route-cache-"));
process.env.ALIGN_STORE = dir;
const { mountFmRoutes } = await import("../fm-mount.js");
test.after(() => rmSync(dir, { recursive: true, force: true }));

const ROOT = "C:\\fm-root";
const FM = "session-fm";

const page = { owner: FM };
function fakeHost(effortService) {
  const st = { lists: 0, gate: null, fail: null };
  const fn = async () => ({});
  const ctx = {
    sessionController: {
      create: fn, rename: fn, prompt: fn,
      inspect: async (sid) => ({ meta: { cwd: ROOT }, events: [] }),
      list: async () => ({ items: [{ sessionId: FM, cwd: ROOT, updatedAt: 1, projections: { values: { title: "first mate" } } }] }),
    },
    // The lookup = dsh-fm current.js reading the registered session (sessionQuery.observeSession); st.lists counts lookups.
    get: (name) => (name === "workspaceEffort" ? effortService : name === "sessionQuery" ? { async observeSession(sid) {
      st.lists += 1;
      if (st.gate) await st.gate.promise;
      if (st.fail) throw new Error(st.fail);
      if (sid !== FM) throw Object.assign(new Error("session " + sid + " not found"), { code: "SESSION_QUERY_SESSION_NOT_FOUND" });
      return { header: { id: sid, cwd: ROOT }, projections: { values: { title: "first mate" } }, [Symbol.dispose]() {} };
    } } : undefined),
    workspaceRegistry: { archiveSession: fn, resolveByPath: fn, archivedSessionIds: [] },
    // fm-mount 启动时用 scheduleShape 认 ctx.schedule:要么 alpha.2 全套(create/list/catalog/update/delete),要么 alpha.3(create/catalog/edit)
    schedule: { catalog: async () => [], list: async () => [], create: fn, update: fn, delete: fn },
    jobs: { list: () => [] }, agents: { list: () => [], get: () => undefined },
    on: () => {}, effect: () => {}, waterfall: async (_n, v) => v,
  };
  return { ctx, st };
}
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
/** One GET through the route; a reply that takes longer than 1 s is a failure (the old route waited for the full list). */
async function get(fm) {
  let code, body, timer;
  const res = { writeHead: (c) => { code = c; }, end: (b) => { body = JSON.parse(b); } };
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("GET /alignment/fm did not answer within 1 s")), 1000); });
  try { await Promise.race([fm.handle({ method: "GET", headers: {} }, res, "/fm"), late]); } finally { clearTimeout(timer); }
  return { code, body };
}
/** One POST through the route with a JSON body (or raw headers to test the fence). */
async function post(fm, sub, body, headers = { "content-type": "application/json" }) {
  let code, out;
  const res = { writeHead: (c) => { code = c; }, end: (b) => { out = JSON.parse(b); } };
  const req = { method: "POST", headers, async *[Symbol.asyncIterator]() { yield JSON.stringify(body); } };
  await fm.handle(req, res, sub);
  return { code, body: out };
}
const tick = () => new Promise((r) => setImmediate(r));
// the old route never answers while the list is gated: open gates after each test so the process can exit
const gates = [];
test.afterEach(() => { for (const g of gates.splice(0)) g.resolve(); });

test("GET /alignment/fm: one lookup at a time, later GETs answer from the last result at once", async () => {
  const { ctx, st } = fakeHost();
  const fm = mountFmRoutes(ctx, { guard: () => null, alignMjs: "align.mjs", pageData: () => page, config: { fmRoot: ROOT, fmFreshMs: 60_000 } });
  st.gate = deferred(); gates.push(st.gate);
  const first = [get(fm), get(fm), get(fm)];
  await tick();
  const perLookup = st.lists;
  assert.ok(perLookup >= 1 && perLookup <= 2, "three concurrent GETs share one lookup: " + perLookup);
  st.gate.resolve(); st.gate = null;
  for (const r of await Promise.all(first)) { assert.equal(r.code, 200); assert.equal(r.body.fm.sid, FM); }
  // the slow list again: a GET must not wait for it
  st.gate = deferred(); gates.push(st.gate);
  const t0 = Date.now();
  const again = await get(fm);
  assert.ok(Date.now() - t0 < 200, "answered from the last result");
  assert.equal(again.body.fm.sid, FM);
  assert.equal(st.lists, perLookup, "fresh enough: no new lookup");
  st.gate.resolve();
});

test("GET /alignment/fm: an old answer is served while one new lookup runs; an error comes back as fmError", async () => {
  const { ctx, st } = fakeHost();
  const fm = mountFmRoutes(ctx, { guard: () => null, alignMjs: "align.mjs", pageData: () => page, config: { fmRoot: ROOT, fmFreshMs: 0 } });
  assert.equal((await get(fm)).body.fm.sid, FM);
  const perLookup = st.lists;
  st.gate = deferred(); gates.push(st.gate); st.fail = "list exploded";
  await new Promise((r) => setTimeout(r, 5));
  const a = await get(fm), b = await get(fm);
  assert.equal(a.body.fm.sid, FM, "stale but real answer, at once");
  assert.equal(b.body.fm.sid, FM);
  assert.equal(st.lists, 2 * perLookup, "one background lookup for both GETs");
  st.gate.resolve(); st.gate = null;
  await tick(); await tick();
  const c = await get(fm);
  assert.equal(c.body.fm, null, "the failed lookup is reported, not hidden");
  assert.match(c.body.fmError, /list exploded/);
});

test("GET /alignment/fm: a stuck dispatch-effort lookup does not hold the First Mate answer back; no service = effort.error", async () => {
  const stuck = deferred(); gates.push(stuck);
  const { ctx } = fakeHost({ dispatchView: () => stuck.promise, setDispatchEffort: async () => ({}) });
  const fm = mountFmRoutes(ctx, { guard: () => null, alignMjs: "align.mjs", pageData: () => page, config: { fmRoot: ROOT, fmFreshMs: 60_000, effortWaitMs: 50 } });
  const r = await get(fm);
  assert.equal(r.body.fm.sid, FM, "the First Mate answer comes back");
  assert.match(r.body.effort.error, /读取超时/, "the stuck lookup is reported, not waited for");
  const none = mountFmRoutes(fakeHost(undefined).ctx, { guard: () => null, alignMjs: "align.mjs", pageData: () => page, config: { fmRoot: ROOT } });
  assert.deepEqual((await get(none)).body.effort, { error: "dsh-workspace-effort 没有加载" });
  const failing = mountFmRoutes(fakeHost({ dispatchView: async () => { throw new Error("agentDefaultModel.currentSelection is missing"); } }).ctx, { guard: () => null, alignMjs: "align.mjs", pageData: () => page, config: { fmRoot: ROOT } });
  assert.match((await get(failing)).body.effort.error, /currentSelection is missing/, "a service error is passed through");
});

test("POST /alignment/fm/effort: fenced like the other routes; bad effort 400, not configured / no service 503, other errors 500", async () => {
  const calls = [];
  const service = {
    dispatchView: async () => ({}),
    async setDispatchEffort(value) {
      calls.push(value);
      if (value === "max") throw Object.assign(new Error("does not offer max"), { code: "bad-effort" });
      if (value === "none") throw Object.assign(new Error("dispatchFrom is not configured"), { code: "not-configured" });
      if (value === "boom") throw new Error("disk full");
      return { reasoningEffort: value, effective: value, efforts: [] };
    },
  };
  const mount = (svc, guard = () => null) => mountFmRoutes(fakeHost(svc).ctx, { guard, alignMjs: "align.mjs", pageData: () => page, config: { fmRoot: ROOT } });
  const fm = mount(service);
  const ok = await post(fm, "/fm/effort", { reasoningEffort: "high" });
  assert.deepEqual([ok.code, ok.body.effort.reasoningEffort], [200, "high"]);
  assert.equal((await post(fm, "/fm/effort", { reasoningEffort: "max" })).code, 400);
  assert.equal((await post(fm, "/fm/effort", { reasoningEffort: "none" })).code, 503);
  assert.equal((await post(fm, "/fm/effort", { reasoningEffort: "boom" })).code, 500);
  assert.equal((await post(fm, "/fm/effort", { reasoningEffort: "high" }, { "content-type": "text/plain" })).code, 415, "not JSON");
  assert.equal((await post(mount(undefined), "/fm/effort", { reasoningEffort: "high" })).code, 503, "no service");
  const fenced = mount(service, () => ({ code: 401, message: "未登录" }));
  assert.equal((await post(fenced, "/fm/effort", { reasoningEffort: "high" })).code, 401, "the login fence comes first");
  assert.deepEqual(calls, ["high", "max", "none", "boom"], "415 / 401 never reach the service");
});

test("GET /alignment/fm: a refresh changing state makes the next GET wait for a fresh lookup", async () => {
  const { ctx, st } = fakeHost();
  const fm = mountFmRoutes(ctx, { guard: () => null, alignMjs: "align.mjs", pageData: () => page, config: { fmRoot: ROOT, fmFreshMs: 60_000 } });
  await get(fm);
  let rec = null;
  fm.refresher.get = () => rec;
  const n0 = st.lists;
  rec = { id: "r1", state: "done" };
  await get(fm);
  assert.ok(st.lists > n0, "refresh state changed: looked up again");
  const n1 = st.lists;
  await get(fm);
  assert.equal(st.lists, n1, "same state: cached");
  page.owner = "session-other";
  const moved = await get(fm);
  assert.ok(st.lists > n1, "new registration: looked up again");
  assert.equal(moved.body.fm, null, "the new registration is not listed: reported, not the old cached sid");
  page.owner = FM;
});
