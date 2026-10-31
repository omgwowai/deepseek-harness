// Panel logic: the pure helpers of panel/app.js (loaded without a DOM), drift against lib/protocol.mjs, and
// the integrity of panel/fixtures/demo.json that ?demo=1 serves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import * as protocol from "../lib/protocol.mjs";

const panelDir = fileURLToPath(new URL("../panel/", import.meta.url));
const ctx = vm.createContext({ console, URLSearchParams });
vm.runInContext(readFileSync(panelDir + "app.js", "utf8"), ctx, { filename: "panel/app.js" });
const P = ctx.__fleetPure;
/** Values built inside the vm realm have foreign prototypes; round-trip through JSON before deep comparisons. */
const plain = (x) => JSON.parse(JSON.stringify(x));

const agent = (key, over = {}) => {
  const [host, rest] = key.split("#");
  const [kind, id] = [rest.slice(0, rest.indexOf(":")), rest.slice(rest.indexOf(":") + 1)];
  return { key, host, site: "mac", kind, id, startedAt: 1000, updatedAt: 2000, status: "done", role: "main", title: key, parent: null, ...over };
};
const agentMap = (list) => new Map(list.map((a) => [a.key, a]));

test("panel constants stay in step with lib/protocol.mjs", () => {
  assert.deepEqual([...P.KINDS], [...protocol.AGENT_KINDS]);
  assert.deepEqual([...P.SITES], [...protocol.SITES]);
  assert.deepEqual([...P.CATS], [...protocol.TOOL_CATEGORIES]);
  assert.deepEqual({ ...P.SITE_LABEL }, { ...protocol.SITE_LABELS });
  assert.deepEqual(Object.keys(P.STATUS_LABEL).sort(), [...protocol.STATUSES].sort());
  assert.deepEqual(Object.keys(P.ROLE_LABEL).sort(), [...protocol.ROLES].sort());
  assert.deepEqual(Object.keys(P.CAT_LABEL).sort(), [...protocol.TOOL_CATEGORIES].sort());
  assert.equal(P.NAMESPACE, protocol.NAMESPACE);
  for (const name of ["chengdu", "weihai", "ulanqab-iron", "iron", "jiaqi-b300", "ulanqab-osmium", "os", "mixed-cloud-bochao-li-weihai-h100-mc-bochao-li", "nope", "", null]) {
    assert.equal(P.siteOfCluster(name), protocol.siteOfCluster(name), String(name));
  }
});

test("pod and file targets map to the same keys the hub indexes", () => {
  assert.equal(P.podKeyOfTarget({ type: "pod", site: "os", namespace: "mc-bochao-li", name: "p-0" }), protocol.podKey("os", "mc-bochao-li", "p-0"));
  assert.equal(P.podKeyOfTarget({ type: "pod", cluster: "ulanqab-osmium", name: "p-0" }), "os/mc-bochao-li/p-0", "site from kube context, default namespace");
  assert.equal(P.podKeyOfTarget({ type: "pod", cluster: "unknown-ctx", name: "p-0" }), null);
  assert.equal(P.podKeyOfTarget({ type: "file", path: "/a" }), null);
  assert.equal(P.fileKeyOfTarget({ type: "file", host: "k8s/os/p-0", path: "/w/a:b.txt" }), "k8s/os/p-0:/w/a:b.txt");
  assert.deepEqual({ ...P.splitFileKey("k8s/os/p-0:/w/a:b.txt") }, { host: "k8s/os/p-0", path: "/w/a:b.txt" }, "only the first colon separates host from path");
  assert.deepEqual(["read", "list", "search", "exec", "write", "edit", "delete", undefined].map(P.fileOpClass), ["r", "r", "r", "r", "w", "e", "e", "r"]);
});

test("SSE parser reassembles frames split at arbitrary byte boundaries", () => {
  const out = [];
  const feed = P.createSseParser((m) => out.push({ ...m }));
  const wire = ": keep-alive\n\nevent: delta\ndata: {\"cursor\":1,\n" + "data: \"now\":2}\n\n" + "data: plain\r\n\r\nevent: delta\r\ndata: {\"cursor\":3}\r\n\r\n" + "event: partial\ndata: never-finished";
  for (let i = 0; i < wire.length; i += 5) feed(wire.slice(i, i + 5));
  assert.deepEqual(out.map((m) => [m.event, m.data]), [["delta", "{\"cursor\":1,\n\"now\":2}"], ["message", "plain"], ["delta", "{\"cursor\":3}"]]);
  assert.deepEqual(JSON.parse(out[0].data), { cursor: 1, now: 2 });
});

test("URL hash round-trips agent keys and ignores junk", () => {
  const key = "k8s/os/osmium-dev-0#claude:abc/def-1";
  const hash = P.buildHash({ view: "timeline", key, site: "os", kinds: ["claude", "omp"], q: "foo bar", focus: "ses-1" });
  assert.match(hash, /^#view=timeline&key=k8s\/os\/osmium-dev-0%23claude:abc\/def-1&/);
  const back = P.parseHash(hash);
  assert.equal(back.view, "timeline");
  assert.equal(back.key, key);
  assert.equal(back.site, "os");
  assert.deepEqual([...back.kinds], ["claude", "omp"]);
  assert.equal(back.q, "foo bar");
  assert.equal(back.focus, "ses-1");
  const junk = P.parseHash("#view=nonsense&kind=dsh,martian,codex&token=t0k");
  assert.equal(junk.view, null);
  assert.deepEqual([...junk.kinds], ["dsh", "codex"]);
  assert.equal(junk.token, "t0k");
  assert.equal(P.parseHash("").view, null);
});

test("agent graph: hub links win over parent hints, cycles are cut, children keep start order", () => {
  const A = agent("h#omp:a"), B = agent("h#omp:b", { startedAt: 3000, parent: { key: "h#omp:a", via: "file", exact: true } });
  const C = agent("h#omp:c", { startedAt: 2000 });
  const D = agent("x#claude:d", { host: "x", startedAt: 4000, parent: { key: "h#omp:a", via: "command", exact: false } });
  const E = agent("h#omp:e", { startedAt: 5000, parent: { key: "h#omp:gone", via: "file", exact: true } });
  const agents = agentMap([A, B, C, D, E]);
  const links = [
    { from: "h#omp:a", to: "h#omp:c", via: "file", exact: true, crossHost: false, crossSite: false },
    { from: "h#omp:c", to: "h#omp:a", via: "file", exact: true, crossHost: false, crossSite: false },   // would form a cycle
    { from: "h#omp:zzz", to: "h#omp:b", via: "file", exact: true, crossHost: false, crossSite: false },   // unknown parent
  ];
  const g = P.buildGraph(agents, links);
  assert.equal(g.parent.get("h#omp:c").from, "h#omp:a");
  assert.equal(g.parent.get("h#omp:b").from, "h#omp:a", "falls back to the parent.key hint when the hub link is unusable");
  assert.equal(g.parent.get("x#claude:d").link.crossHost, true, "hint-derived cross-host edge is flagged");
  assert.ok(!g.parent.has("h#omp:a"), "the cycle edge into the root was cut");
  assert.ok(!g.parent.has("h#omp:e"), "unresolved parent leaves a root");
  assert.deepEqual(plain(g.kids.get("h#omp:a")), ["h#omp:c", "h#omp:b", "x#claude:d"], "children ordered by startedAt");
  assert.deepEqual(plain(P.subtree(g, "h#omp:a")), ["h#omp:a", "h#omp:c", "h#omp:b", "x#claude:d"]);
  assert.equal(P.rootOf(g, "x#claude:d"), "h#omp:a");
});

test("#focus selects the DSH session, else its ACP child, and reports the family root", () => {
  const dsh = agent("mac#dsh:ses-1", { kind: "dsh", id: "ses-1", acp: { provider: "codex-acp", kind: "codex", id: "thread-9" } });
  const proj = agent("mac#dsh:ses-1-proj", { kind: "dsh", id: "ses-1", role: "projection" });
  const codex = agent("mac#codex:thread-9", { parent: { key: "mac#dsh:ses-1", kind: "dsh", id: "ses-1", via: "acp", exact: true } });
  const sub = agent("mac#codex:thread-9-sub", { role: "subagent", parent: { key: "mac#codex:thread-9", via: "file", exact: true } });
  const other = agent("sg#claude:zzz", { host: "sg" });
  let agents = agentMap([dsh, proj, codex, sub, other]);
  let g = P.buildGraph(agents, []);
  assert.deepEqual({ ...P.resolveFocus(agents, g, "ses-1") }, { key: "mac#dsh:ses-1", root: "mac#dsh:ses-1" });
  assert.equal(P.resolveFocus(agents, g, "thread-9").key, "mac#dsh:ses-1", "native id resolves through the DSH record bound to it");
  assert.equal(P.resolveFocus(agents, g, "nobody"), null);
  assert.equal(P.resolveFocus(agents, g, ""), null);
  agents = agentMap([codex, sub, other]);                        // DSH record not collected: the ACP child answers
  g = P.buildGraph(agents, []);
  assert.equal(P.resolveFocus(agents, g, "ses-1").key, "mac#codex:thread-9");
});

test("lane packing: no overlap in a lane, children below parents, siblings reuse freed lanes", () => {
  const nodes = [
    { key: "root", parent: null, host: "h", start: 0, end: Infinity },
    { key: "c1", parent: "root", host: "h", start: 10, end: 20 },
    { key: "c1a", parent: "c1", host: "h", start: 12, end: 18 },
    { key: "c2", parent: "root", host: "h", start: 25, end: 40 },          // c1's lane is free again
    { key: "c3", parent: "root", host: "h", start: 30, end: 60 },          // overlaps c2 → needs another lane
    { key: "x1", parent: "root", host: "other", start: 70, end: 80 },      // other host never shares a lane
    { key: "r2", parent: null, host: "h", start: 100, end: 110 },          // a second root opens its own lane even though lanes are free
  ];
  const { lane, count, hosts } = P.packLanes(nodes);
  assert.equal(lane.get("root"), 0);
  for (const n of nodes) if (n.parent) assert.ok(lane.get(n.key) > lane.get(n.parent), `${n.key} below ${n.parent}`);
  const byLane = new Map();
  for (const n of nodes) { const l = lane.get(n.key); if (!byLane.has(l)) byLane.set(l, []); byLane.get(l).push(n); }
  for (const [l, list] of byLane) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].end <= list[i].start, `lane ${l}: ${list[i - 1].key} overlaps ${list[i].key}`);
    assert.equal(new Set(list.map((n) => n.host)).size, 1, `lane ${l} mixes hosts`);
    assert.equal(hosts[l], list[0].host);
  }
  assert.equal(lane.get("c2"), lane.get("c1"), "sequential sibling reuses the finished sibling's lane");
  assert.notEqual(lane.get("c3"), lane.get("c2"));
  assert.ok(lane.get("c1a") > lane.get("c1"), "grandchild sits below its parent");
  assert.equal(lane.get("c3"), lane.get("c1a"), "a later overlapping sibling reuses the lane the finished grandchild vacated");
  assert.ok(!nodes.filter((n) => n.key !== "r2").some((n) => lane.get(n.key) === lane.get("r2")), "second root has a lane of its own");
  assert.equal(count, 5, "root, two shared sibling lanes, the other-host lane and the second root");
});

test("active axis collapses quiet gaps and maps time both ways", () => {
  const MIN = 60000, GAP = P.GAP_MS;
  const spans = [[0, 10 * MIN], [12 * MIN, 20 * MIN], [200 * MIN, 210 * MIN], [211 * MIN, 215 * MIN], [600 * MIN, 601 * MIN]];
  const ax = P.makeAxis(spans, GAP);
  assert.equal(ax.gaps.length, 2, "only gaps longer than 15 min collapse (the 2 min and 1 min gaps stay)");
  assert.deepEqual(plain(ax.gaps.map((g) => [g.s, g.e])), [[20 * MIN, 200 * MIN], [215 * MIN, 600 * MIN]]);
  assert.equal(ax.D(20 * MIN), 20 * MIN, "before the first gap time is unchanged");
  assert.equal(ax.D(200 * MIN) - ax.D(20 * MIN), P.GAP_VIRT, "a collapsed gap occupies GAP_VIRT on the axis");
  assert.equal(ax.D(210 * MIN) - ax.D(200 * MIN), 10 * MIN, "after the gap the scale is 1:1 again");
  let prev = -Infinity;
  for (let t = -5 * MIN; t <= 700 * MIN; t += 3.7 * MIN) {
    const d = ax.D(t);
    assert.ok(d > prev, "D is strictly increasing");
    prev = d;
    assert.ok(Math.abs(ax.T(d) - t) < 1e-6, `T(D(${t})) round-trips`);
  }
  const unbounded = P.makeAxis(spans, Infinity);
  assert.equal(unbounded.gaps.length, 0);
  assert.equal(unbounded.D(123456), 123456);
  assert.equal(unbounded.T(123456), 123456);
  assert.deepEqual(plain(P.visibleSegments(ax.gaps, 0, 700 * MIN)), [[0, 20 * MIN], [200 * MIN, 215 * MIN], [600 * MIN, 700 * MIN]]);
  assert.deepEqual(plain(P.visibleSegments(ax.gaps, 30 * MIN, 100 * MIN)), [], "a window entirely inside a gap has nothing to label");
  assert.deepEqual(plain(P.bucketSpans(new Set([1, 2, 3, 7, 8, 20]), MIN)), [[1 * MIN, 4 * MIN], [7 * MIN, 9 * MIN], [20 * MIN, 21 * MIN]]);
});

test("axis ticks are aligned, bounded and the step grows with the zoom level", () => {
  const t0 = Date.UTC(2026, 9, 30, 7, 3, 21), t1 = t0 + 3 * 3600e3;
  const step = P.pickStep((t1 - t0) / 1000, 80);
  assert.ok(step >= ((t1 - t0) / 1000) * 80);
  const ticks = P.tickTimes(t0, t1, step);
  assert.ok(ticks.length >= 1 && ticks.length < 40);
  for (const t of ticks) { assert.ok(t >= t0 && t <= t1); assert.equal((t - ticks[0]) % step, 0); }
  assert.ok(P.pickStep(1, 80) < P.pickStep(600, 80));
  assert.ok(P.tickTimes(0, 1e12, 1000).length <= 400, "never explodes");
});

test("touch summaries count ops per class and remember the last toucher", () => {
  const m = new Map([
    ["a|1", { agent: "A", t: 100, op: "read" }], ["a|2", { agent: "A", t: 300, op: "edit" }],
    ["b|1", { agent: "B", t: 200, op: "write" }], ["b|2", { agent: "B", t: 150, op: "search" }],
  ]);
  const s = P.summarizeTouches(m);
  assert.deepEqual([s.n, s.r, s.w, s.e, s.last], [4, 2, 1, 1, 300]);
  assert.equal(s.lastTouch.agent, "A");
  assert.equal(s.agents.get("A").n, 2);
  assert.equal(s.agents.get("B").last, 200);
  assert.equal(s.ops.get("read"), 1);
});

test("formatters stay readable at their boundaries", () => {
  assert.deepEqual([999, 1000, 9990, 59000, 61000, 3600e3 + 5 * 60e3, 50 * 3600e3].map(P.fmtDur), ["999ms", "1.0s", "10s", "59s", "1m01s", "1h05m", "2d02h"]);
  assert.deepEqual([0, 59e3, 61e3, 3600e3, 5 * 3600e3 + 120e3, 3 * 86400e3, NaN].map(P.fmtAge), ["0s", "59s", "1m", "1h", "5h2m", "3d", "–"]);
  assert.deepEqual([12, 999, 1000, 12345, 1.5e6, 2.4e9, NaN].map(P.fmtNum), ["12", "999", "1k", "12k", "1.5M", "2.4B", "–"]);
  assert.deepEqual([12, 2048, 3 * 1048576, NaN].map(P.fmtBytes), ["12 B", "2.0 KiB", "3.0 MiB", "–"]);
  assert.equal(P.esc(`<a href="x">&'</a>`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  assert.equal(P.clip("abcdef", 4), "abc…");
  assert.equal(P.agentTitle({ title: "", name: "", description: "", cwd: "/w/proj", id: "0123456789" }), "proj · 01234567");
  assert.deepEqual(["running", "waiting: CrashLoopBackOff", "waiting: ContainerCreating", "terminated: Completed (0)", "terminated: Error (1)", "weird"].map(P.containerClass), ["running", "bad", "waiting", "terminated", "bad", "terminated"]);
});

// Regression: the fleet tree rebuilt every row once a second because the age / "since" strings were part of the row
// signature, which stalled scrolling at a few thousand agents. The signature must ignore the clock; the time itself
// lives in [data-live] cells that refreshTimes() rewrites in place.
test("fleet rows: the signature ignores the clock, the time cells are refreshed in place", () => {
  const a = agent("mac#omp:run-1", {
    status: "running", startedAt: 1_000_000, updatedAt: 2_000_000,
    live: { alive: true, state: "tool", since: 1_500_000, doing: "bash node --test" },
  });
  const row = { depth: 0, ghost: false, kids: 0, open: false, sel: false, tab: "0", xhost: "", link: null, rowKey: "H:mac/mac#omp:run-1" };
  const sig = P.agentRowSig(a, { ...row, now: 2_000_000 });
  assert.equal(P.agentRowSig(a, { ...row, now: 5_600_000 }), sig, "an hour later the row element must still be reused");
  assert.notEqual(P.agentRowSig({ ...a, status: "idle" }, { ...row, now: 2_000_000 }), sig, "a real change still invalidates the row");
  assert.notEqual(P.agentRowSig(a, { ...row, now: 2_000_000, open: true }), sig, "expanding a row invalidates it");

  const html = P.agentRowHtml(a, { ...row, now: 2_000_000 });
  assert.match(html, /<div class="c-age" data-live="age" data-t="2000000"[^>]*>0s<\/div>/, "age cell carries its base time");
  assert.match(html, /<span class="muted" data-live="since" data-t="1500000">8m20s<\/span>/, "live counter carries its start time");
  assert.notEqual(P.agentRowHtml(a, { ...row, now: 5_600_000 }), html, "the rendered time advances without a rebuild");
  assert.doesNotMatch(P.agentRowHtml({ ...a, status: "waiting", live: { ...a.live, since: null } }, { ...row, now: 2_000_000 }), /data-live="since"/, "no counter without a live start");
});

// Regression (F7): the fragment token used to be persisted in sessionStorage, where any same-origin script can read it.
// It must stay in memory and be exchanged once for the hub's HttpOnly cookie instead.
test("panel: the fragment token is exchanged for the HttpOnly cookie and never stored", async () => {
  const calls = [];
  const stub = (url, init) => { calls.push({ url, init }); return Promise.resolve({ ok: true }); };
  await P.sessionNonceRequest("deadbeef", stub, "/fleet/");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/fleet/api/session-nonce");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(plain(calls[0].init.headers), { "x-agent-fleet-token": "deadbeef" });
  assert.equal(calls[0].init.credentials, "same-origin", "the browser only stores Set-Cookie for a same-origin request");
  assert.equal(calls[0].init.cache, "no-store");
  const src = readFileSync(panelDir + "app.js", "utf8");
  assert.doesNotMatch(src, /(sessionStorage|localStorage)\s*\.\s*(set|get)Item/, "the token must never be persisted");
  assert.doesNotMatch(src, /(sessionStorage|localStorage)\s*\[/, "the token must never be persisted");
  assert.match(src, /S\.token = '';\s+\/\/ memory only/, "boot starts with no token and relies on the cookie");
});

/* ───────────── demo fixture ───────────── */

const demo = JSON.parse(readFileSync(panelDir + "fixtures/demo.json", "utf8"));
const snap = demo.snapshot;
const byKey = new Map(snap.agents.map((a) => [a.key, a]));

test("demo fixture: every record is well-formed and cross-referenced", () => {
  assert.equal(snap.now, demo.meta.now);
  const hostIds = new Set(snap.hosts.map((h) => h.id));
  assert.equal(hostIds.size, snap.hosts.length);
  for (const a of snap.agents) {
    const k = protocol.parseAgentKey(a.key);
    assert.ok(k, `bad key ${a.key}`);
    assert.equal(k.hostId, a.host);
    assert.equal(k.kind, a.kind);
    assert.ok(hostIds.has(a.host), `${a.key}: unknown host`);
    assert.equal(snap.hosts.find((h) => h.id === a.host).site, a.site);
    assert.ok(protocol.STATUSES.includes(a.status) && protocol.ROLES.includes(a.role), a.key);
    assert.ok(a.live && protocol.LIVE_STATES.includes(a.live.state), a.key);
    assert.ok(a.startedAt <= a.updatedAt && a.updatedAt <= snap.now, a.key);
  }
  for (const h of snap.hosts) {
    const mine = snap.agents.filter((a) => a.host === h.id);
    assert.deepEqual({ ...h.counts }, { agents: mine.length, running: mine.filter((a) => a.status === "running").length }, `${h.id} counts`);
  }
  for (const l of snap.links) {
    const from = byKey.get(l.from), to = byKey.get(l.to);
    assert.ok(from && to, `dangling link ${l.from} → ${l.to}`);
    assert.equal(l.crossHost, from.host !== to.host);
    assert.equal(l.crossSite, from.site !== to.site);
    if (to.parent && to.parent.key) assert.equal(to.parent.key, l.from, `${to.key}: parent hint disagrees with link`);
    if (l.toolCallId) assert.ok((demo.events[l.from] || []).some((e) => e.id === l.toolCallId), `${l.from} has no event ${l.toolCallId}`);
  }
  const parent = new Map(snap.links.map((l) => [l.to, l.from]));
  for (const key of parent.keys()) { const seen = new Set([key]); for (let c = parent.get(key); c; c = parent.get(c)) { assert.ok(!seen.has(c), `cycle at ${key}`); seen.add(c); } }
});

test("demo fixture: events are ordered, unique and consistent with live state", () => {
  for (const [key, list] of Object.entries(demo.events)) {
    const a = byKey.get(key);
    assert.ok(a, `events for unknown agent ${key}`);
    const ids = new Set();
    let prev = -Infinity, pending = 0;
    for (const e of list) {
      assert.ok(!ids.has(e.id), `${key}: duplicate event id ${e.id}`); ids.add(e.id);
      assert.ok(protocol.EVENT_TYPES.includes(e.type), `${key}: type ${e.type}`);
      assert.ok(e.t >= prev, `${key}: events out of order at ${e.id}`); prev = e.t;
      assert.ok(e.t <= snap.now + 1000, `${key}: ${e.id} is in the future`);
      if (e.category) assert.ok(protocol.TOOL_CATEGORIES.includes(e.category), `${key}: category ${e.category}`);
      if (e.status === "pending") { pending++; assert.equal(e.duration, undefined, `${key}: pending ${e.id} has a duration`); }
      for (const t of e.targets || []) assert.ok(protocol.TARGET_TYPES.includes(t.type));
    }
    assert.ok(pending <= 1, `${key}: ${pending} pending tools`);
    if (pending) assert.equal(a.status, "running", `${key}: pending tool on a non-running agent`);
  }
  assert.ok(snap.feed.length > 0 && snap.feed.length <= protocol.LIMITS.feedItems);
  for (let i = 1; i < snap.feed.length; i++) assert.ok(snap.feed[i - 1].event.t <= snap.feed[i].event.t, "feed is oldest → newest");
  for (const f of snap.feed) assert.ok((demo.events[f.agent] || []).some((e) => e.id === f.event.id), `feed item ${f.agent}/${f.event.id} missing from events`);
});

test("demo fixture covers the scenarios the review needs", () => {
  const hostSites = new Set(snap.hosts.map((h) => h.site));
  for (const s of protocol.SITES) assert.ok(hostSites.has(s), `no host on site ${s}`);
  for (const kind of protocol.AGENT_KINDS) assert.ok(snap.agents.some((a) => a.kind === kind && a.status === "running"), `no running ${kind}`);
  for (const st of ["running", "waiting", "idle", "done", "error", "stale"]) assert.ok(snap.agents.some((a) => a.status === st), `no ${st} agent`);
  assert.ok(snap.hosts.some((h) => h.status !== "online"), "an unhealthy host for the offline/lag display");
  const parent = new Map(snap.links.map((l) => [l.to, l]));
  const depth = (k) => { let n = 0; for (let c = k; parent.has(c); c = parent.get(c).from) n++; return n; };
  assert.ok(snap.agents.some((a) => depth(a.key) >= 2), "nested subagents (depth ≥ 2)");
  const chain = snap.links.find((l) => l.via === "acp" && byKey.get(l.from).kind === "dsh" && byKey.get(l.to).kind === "codex" && snap.links.some((x) => x.from === l.to && byKey.get(x.to).kind === "codex"));
  assert.ok(chain, "ACP chain DSH → Codex → Codex subagent");
  assert.ok(byKey.get(chain.from).acp && byKey.get(chain.from).acp.kind === "codex", "DSH record carries its acp binding");
  const cross = snap.links.find((l) => l.crossSite && l.crossHost && byKey.get(l.from).kind === "omp" && byKey.get(l.from).host === "server-bochao-01" && byKey.get(l.to).kind === "claude" && byKey.get(l.to).host.startsWith("k8s/os/"));
  assert.ok(cross, "omp on the server → claude in an os pod");
  const launch = (demo.events[cross.from] || []).find((e) => e.id === cross.toolCallId);
  assert.ok(launch && launch.targets.some((t) => t.type === "pod" && t.op === "exec") && launch.targets.some((t) => t.type === "agent"), "the launching tool call carries pod-exec and agent-launch targets");
  assert.ok(snap.agents.some((a) => a.role === "projection"), "a DSH projection record");
  assert.ok(snap.agents.some((a) => a.role === "fork"), "a fork");

  const podKeys = new Set(snap.pods.map((p) => p.key));
  const touched = new Set(), unknown = new Set(), ops = new Set(), files = new Map();
  for (const [agent, list] of Object.entries(demo.events)) for (const e of list) for (const t of e.targets || []) {
    if (t.type === "pod") { const k = P.podKeyOfTarget(t); (podKeys.has(k) ? touched : unknown).add(k); }
    if (t.type === "file") { ops.add(t.op); const fk = P.fileKeyOfTarget(t); if (!files.has(fk)) files.set(fk, new Set()); files.get(fk).add(agent); }
  }
  assert.ok(touched.size >= 4, `only ${touched.size} tracked pods are touched`);
  assert.ok(unknown.size >= 1, "an untracked pod reference");
  for (const op of ["read", "write", "edit", "list", "search", "delete", "exec"]) assert.ok(ops.has(op), `no file op ${op}`);
  assert.ok([...files.values()].filter((s) => s.size >= 2).length >= 6, "files shared by several agents");
  const previews = Object.keys(demo.files);
  assert.ok(previews.some((k) => files.has(k)), "previewable files are among the touched ones");
  assert.ok(Object.values(demo.files).some((f) => f.denied) && Object.values(demo.files).some((f) => f.truncated) && Object.values(demo.files).some((f) => f.binary) && Object.values(demo.files).some((f) => f.exists === false) && Object.values(demo.files).some((f) => f.redactions), "every preview banner state is represented");
  for (const [k, f] of Object.entries(demo.files)) assert.equal(`${f.host}:${f.path}`, k);
  for (const p of snap.pods) assert.equal(p.key, protocol.podKey(p.site, p.namespace, p.name));
  assert.ok(Object.keys(demo.podEvents).length >= 4);
});
