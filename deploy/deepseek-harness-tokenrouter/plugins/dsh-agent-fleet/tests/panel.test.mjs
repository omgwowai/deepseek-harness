// Panel logic: the pure helpers of panel/app.js (loaded without a DOM), drift against lib/protocol.mjs, the panel's
// credential redemption against a real hub, and the integrity of panel/fixtures/demo.json that ?demo=1 serves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import vm from "node:vm";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as protocol from "../lib/protocol.mjs";
import { startHub } from "../lib/hub/index.mjs";

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
  const junk = P.parseHash("#view=nonsense&kind=dsh,martian,codex&token=t0k&nonce=n0");
  assert.equal(junk.view, null);
  assert.deepEqual([...junk.kinds], ["dsh", "codex"]);
  assert.equal(junk.token, "t0k");
  assert.equal(junk.nonce, "n0");
  assert.doesNotMatch(P.buildHash(junk), /t0k|n0|token|nonce/, "rewriting the hash drops the credentials from the address bar");
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

// Regression: the desktop app embeds the loopback hub in an iframe of its dsh-app:// page, where the browser never
// sends the hub's SameSite cookie. The plugin's `#nonce=` has to turn into a credential the panel sends as a header.
test("panel credentials: the plugin's #nonce becomes a session key that reads the hub by header alone", async (t) => {
  const scratch = fileURLToPath(new URL("../.scratch/", import.meta.url));
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "panel-auth-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const hub = await startHub({ hostId: "mac", log: () => {}, http: { host: "127.0.0.1", port: 0, tokenFile: join(dir, "token") } });
  t.after(() => hub.stop());
  const root = `http://127.0.0.1:${hub.http.port}/`, token = readFileSync(join(dir, "token"), "utf8").trim();
  const mint = async () => (await (await fetch(`${root}api/session-nonce`, { method: "POST", headers: { "x-agent-fleet-token": token } })).json()).nonce;
  const cookieless = (url, init) => fetch(url, { ...init, credentials: "omit" });   // what the browser does in a third-party frame
  const reads = (key) => fetch(`${root}api/snapshot`, { headers: { "x-agent-fleet-token": key } }).then((res) => res.status);

  const nonce = await mint();
  const session = await P.redeemCredential(P.parseHash(`#nonce=${nonce}&focus=s-1`), cookieless, root);
  assert.match(session, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(session, token, "the page never holds the hub token");
  assert.equal(await reads(session), 200, "the session key alone reads the snapshot");
  assert.equal(await P.redeemCredential(P.parseHash(`#nonce=${nonce}`), cookieless, root), "", "a spent nonce buys nothing");
  assert.equal(await P.redeemCredential(P.parseHash("#view=fleet"), cookieless, root), "", "no credential, no request");
  assert.equal(await P.redeemCredential(P.parseHash(`#token=${token}`), cookieless, root), token, "a manual token is used as is");
  await hub.stop();
  assert.equal(await P.redeemCredential(P.parseHash("#nonce=n"), cookieless, root), "", "an unreachable hub is not an exception");
});

/* ───────────── interaction graphs (?view=graph) ───────────── */

const gEv = (id, t, over = {}) => ({ id, type: "tool", t, status: "ok", category: "read", ...over });
const gTouch = (agent, event) => ({ agent, event });
const gHosts = (list = [["mac", "mac"]]) => new Map(list.map(([id, site]) => [id, { id, site, status: "online" }]));
const gModel = (over) => P.graphModel({ mode: "env", winStart: 0, now: 60_000, hosts: gHosts(), ...over });
const gLabels = (nodes) => plain(nodes.map((n) => n.label));

test("graph: a collapsed root sums its subtree, an expanded root keeps only its own calls", () => {
  const A = agent("h#omp:a", { status: "running", startedAt: 1000 });
  const B = agent("h#omp:b", { startedAt: 2000, parent: { key: "h#omp:a", via: "file", exact: true } });
  const agents = agentMap([A, B]);
  const links = [{ from: "h#omp:a", to: "h#omp:b", via: "file", exact: true, toolCallId: "s1", crossHost: false, crossSite: false }];
  const host = { type: "host", host: "mac", op: "ssh" };
  const events = [
    gTouch("h#omp:a", gEv("a1", 10_000, { category: "remote", targets: [host] })),
    gTouch("h#omp:b", gEv("b1", 11_000, { category: "remote", targets: [host] })),
    gTouch("h#omp:b", gEv("b2", 12_000, { category: "remote", targets: [host] })),
  ];
  const m = gModel({ agents, links, events });
  assert.equal(m.left.roots.length, 1);
  assert.equal(m.left.roots[0].agg.calls, 3);
  assert.equal(m.left.roots[0].own.calls, 1, "the root's own tool call");
  assert.equal(m.left.roots[0].desc, 1);

  const collapsed = P.graphVisible(m, new Set(), new Set());
  assert.equal(collapsed.edges.length, 1, "one edge between the root and the collapsed site");
  assert.equal(collapsed.edges[0].calls, 3);
  assert.equal(collapsed.edges[0].agents, 2);
  assert.equal(collapsed.edges[0].rightNode.kind, "site");
  assert.equal(collapsed.edges[0].dominantClass, "remote", "host targets are the remote colour");

  const expanded = P.graphVisible(m, new Set(["h#omp:a"]), new Set());
  const byLeft = new Map(expanded.edges.map((e) => [e.left, e]));
  assert.equal(expanded.edges.length, 2);
  assert.equal(byLeft.get("h#omp:a").calls, 1, "the expanded parent carries only its own call");
  assert.equal(byLeft.get("h#omp:b").calls, 2);
});

test("graph: ACP mirrors and projection records are skipped", () => {
  const dsh = agent("h#dsh:s1", { kind: "dsh", id: "s1", acp: { provider: "codex-acp", kind: "codex", id: "c1" }, startedAt: 1000 });
  const codex = agent("h#codex:c1", { kind: "codex", id: "c1", startedAt: 2000, parent: { key: "h#dsh:s1", kind: "dsh", id: "s1", via: "acp", exact: true } });
  const proj = agent("h#dsh:s1-proj", { kind: "dsh", id: "s1", role: "projection", startedAt: 1000 });
  const agents = agentMap([dsh, codex, proj]);
  const file = (path) => ({ type: "file", host: "h", path, op: "read", lines: { read: 5 } });
  const events = [
    gTouch(dsh.key, gEv("mirror-1", 10_000, { targets: [file("/w/a/x.mjs")] })),   // same id as the child's call
    gTouch(codex.key, gEv("mirror-1", 10_000, { targets: [file("/w/a/x.mjs")] })),
    gTouch(dsh.key, gEv("own-1", 10_500, { targets: [file("/w/a/y.mjs")] })),      // a native DSH tool, still skipped
    gTouch(codex.key, gEv("child-2", 11_000, { targets: [file("/w/a/y.mjs")] })),
    gTouch(proj.key, gEv("proj-1", 11_500, { targets: [file("/w/a/x.mjs")] })),
  ];
  const m = gModel({ mode: "files", agents, links: [{ from: dsh.key, to: codex.key, via: "acp", exact: true, crossHost: false, crossSite: false }], events });
  assert.equal(m.left.byKey.has(proj.key), false, "projection agents have no node");
  assert.equal(m.left.byKey.get(dsh.key).own.calls, 0, "the DSH session's tool events are mirrors, not interactions");
  assert.equal(m.left.byKey.get(codex.key).own.calls, 2);
  assert.equal(m.records.length, 2, "the projection event and the DSH mirrors are dropped");
  assert.ok(m.left.byKey.get(codex.key).kids.length === 0);
});

test("graph env: pod nodes meet an agent inside the pod and an agent exec-ing into it", () => {
  const hostPod = "k8s/os/osmium-dev-0";
  const inside = agent(`${hostPod}#omp:in`, { host: hostPod, site: "os", status: "running", startedAt: 1000 });
  const outside = agent("mac#claude:out", { host: "mac", site: "mac", startedAt: 2000 });
  const agents = agentMap([inside, outside]);
  const pods = new Map([["os/mc-bochao-li/osmium-dev-0", { key: "os/mc-bochao-li/osmium-dev-0", site: "os", namespace: "mc-bochao-li", name: "osmium-dev-0", phase: "Running" }]]);
  const events = [
    gTouch(inside.key, gEv("in1", 10_000, { category: "shell", targets: [] })),                       // local exec inside the pod
    gTouch(outside.key, gEv("out1", 11_000, { category: "k8s", targets: [{ type: "pod", site: "os", namespace: "mc-bochao-li", name: "osmium-dev-0", op: "exec" }] })),
  ];
  const m = gModel({ agents, events, pods, now: 20_000 });
  const site = m.right.roots.find((n) => n.meta.site === "os");
  const pod = site.kids.find((n) => n.kind === "pod");
  assert.equal(pod.label, "os/mc-bochao-li/osmium-dev-0");
  assert.equal(pod.podAgents, 2, "both agents meet at one pod node");
  assert.equal(pod.podActive, 2);
  assert.equal(m.records.filter((r) => r.resKey === pod.key).length, 2);

  const off = gModel({ agents, events, pods, now: 20_000, localExec: false });
  const podOff = off.right.roots.find((n) => n.meta.site === "os").kids.find((n) => n.kind === "pod");
  assert.equal(podOff.podAgents, 1, "the local-exec toggle removes the in-pod interaction");
  assert.equal(off.records.length, 1);
});

test("graph env: local exec maps to the agent's own host or container", () => {
  const ssh = agent("sg-compute#omp:a", { host: "sg-compute", site: "sg-compute" });
  const box = agent("mac#omp:b", { host: "mac", site: "mac", container: "harness-home" });
  const events = [
    gTouch(ssh.key, gEv("s1", 10_000, { category: "shell", targets: [{ type: "file", host: "sg-compute", path: "/data/bench/x", op: "read" }] })),
    gTouch(box.key, gEv("b1", 11_000, { category: "shell", targets: [] })),
    gTouch(ssh.key, gEv("s2", 12_000, { category: "shell", targets: [{ type: "host", host: "sg-compute", op: "ssh" }] })),
  ];
  const m = gModel({ agents: agentMap([ssh, box]), events, hosts: gHosts([["mac", "mac"], ["sg-compute", "sg-compute"]]) });
  const sg = m.right.roots.find((n) => n.meta.site === "sg-compute");
  assert.deepEqual(gLabels(sg.kids), ["sg-compute"], "a local shell counts on the host node");
  const mac = m.right.roots.find((n) => n.meta.site === "mac");
  assert.equal(mac.kids[0].kind, "container");
  assert.equal(mac.kids[0].label, "容器 harness-home");
  assert.equal(m.records.length, 3, "the remote ssh call is a real host interaction, not local exec");
  const off = gModel({ agents: agentMap([ssh, box]), events, localExec: false });
  assert.equal(off.records.length, 1, "switching off local exec keeps only the explicit host target");
});

test("graph env: k8s, host and external leaves", () => {
  const a = agent("mac#omp:a", { host: "mac", site: "mac" });
  const events = [
    gTouch(a.key, gEv("k1", 10_000, { category: "k8s", targets: [{ type: "k8s", site: "chengdu", resource: "pod", selector: "app=cd-train", op: "get" }] })),
    gTouch(a.key, gEv("k2", 11_000, { category: "k8s", targets: [{ type: "k8s", site: "os", resource: "deployment", name: "x", op: "get" }] })),
    gTouch(a.key, gEv("h1", 12_000, { category: "remote", targets: [{ type: "host", host: "sg-compute", op: "ssh" }] })),
    gTouch(a.key, gEv("h2", 13_000, { category: "remote", targets: [{ type: "host", host: "ci-runner-02", op: "scp" }] })),
    gTouch(a.key, gEv("h3", 14_000, { category: "remote", targets: [{ type: "agent", op: "launch", kind: "claude", site: "os", pod: "osmium-dev-0" }] })),
    gTouch(a.key, gEv("k3", 14_500, { category: "k8s", targets: [{ type: "k8s", site: "os", resource: "pod", op: "get" }] })),
  ];
  const pods = new Map([["os/mc-bochao-li/osmium-dev-0", { key: "os/mc-bochao-li/osmium-dev-0", site: "os", namespace: "mc-bochao-li", name: "osmium-dev-0" }]]);
  const m = gModel({ agents: agentMap([a]), events, pods });
  const bySite = new Map(m.right.roots.map((n) => [n.meta.site, n]));
  assert.deepEqual(gLabels(bySite.get("chengdu").kids), ["pods -l app=cd-train"]);
  assert.deepEqual(gLabels(bySite.get("os").kids), ["os/mc-bochao-li/osmium-dev-0", "deployment/x", "pods（未指名）"], "the launch target is the pod node; an unnamed get is still visible");
  assert.deepEqual(gLabels(bySite.get("sg-compute").kids), ["sg-compute"]);
  const ext = m.right.roots[m.right.roots.length - 1];
  assert.equal(ext.meta.site, "external");
  assert.equal(ext.label, "外部 external");
  assert.deepEqual(gLabels(ext.kids), ["ci-runner-02"]);
  const order = m.right.roots.map((n) => n.meta.site);
  assert.deepEqual(plain(order.slice(0, 3)), ["sg-compute", "chengdu", "os"], "fleet SITES order first, external last");
  assert.equal(order[order.length - 1], "external");
});

test("graph files: deepest repo root, same-remote checkouts, anchors and path compression", () => {
  const a = agent("mac#omp:a", { host: "mac", site: "mac", cwd: "/Users/lbc/Desktop/work/agent-fleet" });
  const b = agent("server-bochao-01#omp:b", { host: "server-bochao-01", site: "server-bochao-01" });
  const c = agent("k8s/iron/iron-dev-0#codex:c", { host: "k8s/iron/iron-dev-0", site: "iron" });
  const agents = agentMap([a, b, c]);
  const repoMap = {
    mac: [{ root: "/w" }, { root: "/w/a", remote: "github.com/o/deep", branch: "dev" }],
    "server-bochao-01": [{ root: "/s/a", remote: "github.com/o/deep", branch: "main" }],
    "k8s/iron/iron-dev-0": [{ root: "/workspace", head: "abcdef123456" }],
  };
  const f = (host, path, over = {}) => ({ type: "file", host, path, op: "read", ...over });
  const events = [
    gTouch(a.key, gEv("f1", 10_000, { targets: [f("mac", "/w/a/lib/hub/index.mjs", { lines: { read: 40 } })] })),
    gTouch(a.key, gEv("f2", 11_000, { targets: [f("mac", "/w/a/lib/hub/a.mjs", { op: "edit", lines: { added: 3, removed: 1 } })] })),
    gTouch(b.key, gEv("f3", 12_000, { targets: [f("server-bochao-01", "/s/a/x.txt", { lines: { added: 5 } })] })),
    gTouch(c.key, gEv("f4", 13_000, { targets: [f("k8s/iron/iron-dev-0", "/workspace/train.py")] })),
    gTouch(a.key, gEv("f5", 14_000, { targets: [f("mac", "/Users/lbc/Desktop/work/agent-fleet/panel/app.js")] })),
    gTouch(a.key, gEv("f8", 14_500, { targets: [f("mac", "/Users/lbc/Desktop/work/agent-fleet/tests/x.mjs")] })),
    gTouch(a.key, gEv("f6", 15_000, { targets: [f("mac", "/Users/lbc/Documents/Obsidian/notes/n.md")] })),
    gTouch(a.key, gEv("f7", 16_000, { targets: [f("mac", "/tmp/agent-fleet/x.log")] })),
  ];
  const m = gModel({ mode: "files", agents, events, repoMap });
  const repo = m.right.roots.find((n) => n.kind === "repo" && n.label.includes("deep"));
  assert.equal(repo.label, "o/deep @ 2 branches", "same remote, two branches");
  assert.equal(repo.kids.length, 2, "one checkout per root");
  const macCo = repo.kids.find((k) => k.meta.host === "mac");
  assert.match(macCo.label, /^dev · mac · w\/a$/);
  assert.deepEqual(gLabels(macCo.kids), ["lib/hub"], "the single-child lib/ directory compresses with hub");
  assert.deepEqual(gLabels(macCo.kids[0].kids), ["a.mjs", "index.mjs"]);
  const serverCo = repo.kids.find((k) => k.meta.host === "server-bochao-01");
  assert.match(serverCo.label, /^main · server-bochao-01 · s\/a$/);
  const iron = m.right.roots.find((n) => n.kind === "repo" && n.meta.host === undefined && n.label.startsWith("workspace"));
  assert.equal(iron.label, "workspace @ abcdef1", "a detached repo shows the head prefix");
  const anchors = m.right.roots.filter((n) => n.kind === "anchor");
  const anchorLabels = anchors.map((n) => n.label);
  assert.ok(anchorLabels.includes("/Users/lbc/Desktop/work/agent-fleet"), "the deepest agent cwd anchors its files");
  assert.ok(anchorLabels.includes("/Users/lbc/Documents/Obsidian"), "home + two segments");
  assert.ok(anchorLabels.includes("/tmp/agent-fleet"), "first two segments outside home");
  const home = anchors.find((n) => n.label === "/Users/lbc/Documents/Obsidian");
  assert.deepEqual(gLabels(home.kids), ["notes"]);
  assert.deepEqual(gLabels(home.kids[0].kids), ["n.md"]);
  const cwdAnchor = anchors.find((n) => n.label === "/Users/lbc/Desktop/work/agent-fleet");
  assert.deepEqual(gLabels(cwdAnchor.kids), ["panel", "tests"], "two subtrees keep the cwd anchor uncompressed");
});

test("graph files: a directory with its own touches breaks path compression", () => {
  const a = agent("mac#omp:a", { host: "mac" });
  const repoMap = { mac: [{ root: "/w/a", remote: "github.com/o/r", branch: "main" }] };
  const events = [
    gTouch(a.key, gEv("d1", 10_000, { targets: [{ type: "file", host: "mac", path: "/w/a/lib/hub/index.mjs", op: "read" }] })),
    gTouch(a.key, gEv("d2", 11_000, { targets: [{ type: "file", host: "mac", path: "/w/a/lib/hub", op: "list" }] })),
  ];
  const m = gModel({ mode: "files", agents: agentMap([a]), events, repoMap });
  const lib = m.right.roots[0].kids[0];                    // one checkout → no checkout level; the group's child is lib
  assert.equal(lib.label, "lib");
  assert.equal(lib.kids[0].label, "hub");
  assert.equal(lib.kids[0].own.calls, 1, "the list target counts on the directory itself");
  assert.deepEqual(gLabels(lib.kids[0].kids), ["index.mjs"]);
});

test("graph: window filter, line totals per edge and the op fallback label", () => {
  const a = agent("mac#omp:a", { host: "mac" });
  const file = (path, lines) => ({ type: "file", host: "mac", path, op: lines && lines.added ? "edit" : "read", ...(lines ? { lines } : {}) });
  const events = [
    gTouch(a.key, gEv("old", 9_000, { targets: [file("/w/a/old.mjs", { read: 99 })] })),
    gTouch(a.key, gEv("r1", 10_000, { targets: [file("/w/a/x.mjs", { read: 10 })] })),
    gTouch(a.key, gEv("e1", 11_000, { targets: [file("/w/a/x.mjs", { added: 2, removed: 1 })] })),
    gTouch(a.key, gEv("g1", 12_000, { category: "search", targets: [file("/w/a/dir", null)] })),
  ];
  const m = gModel({ mode: "files", agents: agentMap([a]), events, winStart: 10_000, repoMap: { mac: [{ root: "/w/a", remote: "github.com/o/r", branch: "main" }] } });
  assert.equal(m.records.length, 3, "the event before the window is dropped");
  const v = P.graphVisible(m, new Set(), new Set(m.right.roots.map((n) => n.key)));
  const edge = v.edges.find((e) => e.right === "F:mac:/w/a/x.mjs");
  assert.deepEqual(plain(edge.lines), { read: 10, added: 2, removed: 1 });
  assert.equal(P.graphEdgeLabel("files", edge), "2× r10 +2 −1");
  assert.equal(edge.dominantClass, "edit", "a read/edit tie is coloured by the edit class (e > w > r)");
  const dirEdge = v.edges.find((e) => e.rightNode.label === "dir");
  assert.equal(P.graphEdgeLabel("files", dirEdge), "1× 1r", "no lines → op classes");
  assert.equal(dirEdge.dominantClass, "read", "file edges use the CSS class names, not the raw op class");
  const wm = gModel({ mode: "files", agents: agentMap([a]), events: [gTouch(a.key, gEv("w1", 12_500, { targets: [{ type: "file", host: "mac", path: "/w/a/w.mjs", op: "write", lines: { added: 4 } }] }))], repoMap: { mac: [{ root: "/w/a", remote: "github.com/o/r", branch: "main" }] } });
  const wv = P.graphVisible(wm, new Set(), new Set(wm.right.roots.map((n) => n.key)));
  assert.equal(wv.edges[0].dominantClass, "write");
  assert.equal(P.graphEdgeLabel("files", wv.edges[0]), "1× +4");
  assert.equal(P.edgeLinesText({ read: 820 }), "r820");
  assert.equal(P.edgeLinesText({ added: 12, removed: 3 }), "+12 −3");
  assert.equal(P.edgeLinesText(null), "");
});

test("graph: text and running filters", () => {
  const run = agent("mac#omp:run", { host: "mac", status: "running", title: "fleet panel" });
  const done = agent("mac#omp:done", { host: "mac", status: "done", title: "checkpoint eval", startedAt: 500 });
  const kids = agent("mac#omp:kid", { host: "mac", status: "done", title: "lint sweep", startedAt: 600, parent: { key: "mac#omp:run", via: "file", exact: true } });
  const agents = agentMap([run, done, kids]);
  const links = [{ from: "mac#omp:run", to: "mac#omp:kid", via: "file", exact: true, crossHost: false, crossSite: false }];
  const host = { type: "host", host: "mac", op: "ssh" };
  const events = [gTouch(run.key, gEv("r1", 10_000, { targets: [host] })), gTouch(done.key, gEv("d1", 11_000, { targets: [host] })), gTouch(kids.key, gEv("k1", 12_000, { targets: [host] }))];
  const all = gModel({ agents, links, events });
  assert.equal(all.left.roots.length, 2);
  const onlyRun = gModel({ agents, links, events, runningOnly: true });
  assert.deepEqual(plain(gLabels(onlyRun.left.roots)), ["fleet panel"], "the running family keeps its done child");
  assert.equal(onlyRun.left.byKey.has(kids.key), true);
  const q = gModel({ agents, links, events, q: "lint" });
  assert.deepEqual(plain(gLabels(q.left.roots)), ["fleet panel"], "a matching child keeps its ancestor");
  assert.equal(q.left.byKey.has(done.key), false);
});

test("graph: label placement rides each curve, keeps labels apart and hides what does not fit", () => {
  const mk = (key, y0, y1, rank, w = 40) => ({ key, text: key, w, x0: 100, y0, x1: 900, y1, dx: 300, rank, calls: 1 });
  const items = [mk("a", 100, 100, 3), mk("b", 100, 100, 2), mk("c", 100, 160, 1)];
  const p = P.placeCurveLabels(items, { minX: 90, maxX: 910, minY: 0, maxY: 400, lineH: 12, gap: 3 });
  const placed = items.map((i) => p.get(i.key)).filter((x) => !x.hidden);
  assert.equal(placed.length, 3);
  for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
    const a = placed[i], b = placed[j];
    assert.ok(a.bx1 + 3 < b.bx0 || b.bx1 + 3 < a.bx0 || a.by1 + 3 < b.by0 || b.by1 + 3 < a.by0, "label boxes never overlap");
  }
  assert.equal(p.get("c").t, 0.5, "the highest-ranked label gets the curve midpoint");
  assert.ok(Math.abs(p.get("a").y - 100) < 1e-9, "a horizontal curve keeps its labels on the line");
  assert.ok(p.get("c").y > 100 && p.get("c").y < 160, "a slanted curve puts the label on the edge");
  assert.equal(p.get("a").t, 0.38, "the loser of the midpoint slides along its own curve");

  const many = Array.from({ length: 10 }, (_, i) => mk("k" + i, 100, 100, i));
  const q = P.placeCurveLabels(many, { minX: 90, maxX: 910, minY: 0, maxY: 400, lineH: 12, gap: 3 });
  const shown = many.map((i) => q.get(i.key)).filter((x) => !x.hidden);
  assert.ok(shown.length >= 3 && shown.length < 10, "only the free spots are used");
  for (const s of shown) assert.ok(s.bx0 >= 90 && s.bx1 <= 910 && s.by0 >= 0 && s.by1 <= 400, "labels stay inside the column");
  assert.ok(many.some((i) => q.get(i.key).hidden), "no room → hidden (hover still shows it)");
});

test("graph: hash round-trips mode and window, touch summaries sum line counts", () => {
  const h = P.buildHash({ view: "graph", g: "files", win: "2h" });
  assert.match(h, /^#view=graph&g=files&win=2h/);
  assert.deepEqual([P.parseHash(h).g, P.parseHash(h).win], ["files", "2h"]);
  assert.deepEqual([P.parseHash("#view=graph").g, P.parseHash("#view=graph").win], ["env", "30m"], "defaults");
  assert.equal(P.parseHash("#view=graph&g=nope&win=9h").g, "env");
  assert.equal(P.parseHash("#view=graph&g=nope&win=9h").win, "30m");
  assert.doesNotMatch(P.buildHash({ view: "timeline", g: "files", win: "24h" }), /g=files|win=24h/);

  const m = new Map([
    ["a|1", { agent: "A", t: 100, op: "read", lines: { read: 40 } }],
    ["a|2", { agent: "A", t: 300, op: "edit", lines: { added: 3, removed: 1 } }],
    ["b|1", { agent: "B", t: 200, op: "search" }],
  ]);
  const s = P.summarizeTouches(m);
  assert.deepEqual(plain(s.lines), { read: 40, added: 3, removed: 1 });
  assert.equal(P.targetLinesText({ op: "edit", lines: { added: 12, removed: 3 } }), "+12 −3");
  assert.equal(P.targetLinesText({ op: "read", lines: { read: 120 } }), "r120");
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
