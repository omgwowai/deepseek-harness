// Synthetic, deterministic demo fleet for the panel's ?demo=1 mode (fixed clock, seeded PRNG, no I/O besides the output).
//   node make-demo.mjs > demo.json          write the fixture to stdout
//   node make-demo.mjs --out <path>         write it to <path>   (default: demo.json next to this file)
// A summary goes to stderr. Everything here is invented: hosts, pods, sessions, paths, prompts and file contents.
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentKey, podKey, podHostId, siteOfSshTarget, SITES, TOOL_CATEGORIES, STATUSES, LIMITS } from "../../lib/protocol.mjs";

export const NOW = Date.UTC(2026, 9, 30, 7, 0, 0);
const S = 1000, M = 60 * S, H = 60 * M, NS = "mc-bochao-li";
const ago = (ms) => Math.round(NOW - ms);

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const B62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** One independent PRNG stream per label, so editing one agent never reshuffles another. */
function makeRng(label) {
  const f = mulberry32(hash32("agent-fleet-demo/" + label));
  const r = {
    f,
    rnd: (lo, hi) => lo + f() * (hi - lo),
    int: (lo, hi) => lo + Math.floor(f() * (hi - lo + 1)),
    pick: (list) => list[Math.floor(f() * list.length)],
    chance: (p) => f() < p,
    hex: (n) => { let s = ""; while (s.length < n) s += Math.floor(f() * 16).toString(16); return s; },
    b62: (n) => { let s = ""; while (s.length < n) s += B62[Math.floor(f() * 62)]; return s; },
    weighted: (pairs) => {
      let total = 0;
      for (const [w] of pairs) total += w;
      let x = f() * total;
      for (const [w, item] of pairs) { x -= w; if (x < 0) return item; }
      return pairs[pairs.length - 1][1];
    },
  };
  r.uuid = () => `${r.hex(8)}-${r.hex(4)}-4${r.hex(3)}-${r.pick("89ab")}${r.hex(3)}-${r.hex(12)}`;
  return r;
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const rd = Math.round;
const isoStamp = (ms) => new Date(ms).toISOString().replace(/:/g, "-").replace(".", "-");   // 2026-10-30T06-13-00-000Z

const VERSION = { claude: "2.1.4", codex: "0.58.0", omp: "13.2.1", dsh: "1.9.0" };
const PROVIDER = { claude: "anthropic", codex: "openai", omp: "tokenrouter-v2", dsh: "deepseek" };
const WINDOW = { "claude-opus-4-1": 200000, "claude-sonnet-4-5": 200000, "gpt-5-codex": 400000, "tokenrouter-v2/claude-sonnet-5.5": 200000, "deepseek-v4-pro": 256000 };
/** $/Mtok: input, output, cacheRead, cacheWrite. */
const PRICE = { "claude-opus-4-1": [15, 75, 1.5, 18.75], "claude-sonnet-4-5": [3, 15, 0.3, 3.75], "gpt-5-codex": [1.25, 10, 0.125, 0], "tokenrouter-v2/claude-sonnet-5.5": [3, 15, 0.3, 3.75], "deepseek-v4-pro": [0.5, 2, 0.05, 0] };

// ───────────────────────────────────────────── world: hosts, pods, kube events ─────────────────────────────────────────────
const MAC = "mac", SRV = "server-bochao-01", SG = "sg-compute";
const OSDEV = podHostId("os", "osmium-dev-0"), CDM = podHostId("chengdu", "cd-train-master-0");
const WHD = podHostId("weihai", "wh-dev-0"), IRD = podHostId("iron", "iron-dev-0");
const CTX = { os: "ulanqab-osmium", chengdu: "chengdu", weihai: "weihai", iron: "ulanqab-iron" };
const HOME = { [MAC]: "/Users/lbc", [SRV]: "/home/bochao_li", [SG]: "/home/bochao_li", [OSDEV]: "/root", [CDM]: "/root", [WHD]: "/root", [IRD]: "/root" };
const MAC_ROOT = "/Users/lbc/Desktop/work/agent-fleet", SRV_ROOT = "/home/bochao_li/agent-fleet";

const HOST_ROWS = [
  { id: MAC, site: "mac", kind: "workstation", label: "Mac · lbc-mbp", hostname: "lbc-mbp.local", platform: "darwin", via: "ssh-relay", lagMs: 140, skewMs: -420, up: 5.7 * H },
  { id: SRV, site: SRV, kind: "server", label: "server-bochao-01", hostname: "server-bochao-01", platform: "linux", via: "local", lagMs: 12, skewMs: 0, up: 6 * H },
  { id: SG, site: SG, kind: "server", label: "sg-compute", hostname: "oracle-sg-cpu-compute00001", platform: "linux", via: "ssh-relay", lagMs: 180, skewMs: 1260, up: 5.9 * H },
  { id: OSDEV, site: "os", kind: "pod", label: "osmium-dev-0 · os", hostname: "osmium-dev-0", platform: "linux", via: "pod-exec", lagMs: 240, skewMs: 90, up: 5.8 * H, cluster: CTX.os, namespace: NS, pod: "osmium-dev-0", node: "osm-gpu-17" },
  { id: CDM, site: "chengdu", kind: "pod", label: "cd-train-master-0 · chengdu", hostname: "cd-train-master-0", platform: "linux", via: "pod-exec", lagMs: 410, skewMs: -180, up: 5.5 * H, cluster: CTX.chengdu, namespace: NS, pod: "cd-train-master-0", node: "cd-h100-04" },
  { id: WHD, site: "weihai", kind: "pod", label: "wh-dev-0 · weihai", hostname: "wh-dev-0", platform: "linux", via: "pod-exec", status: "error", error: "kubectl exec: unable to upgrade connection: container not found", lastSeenAgo: 9 * M, up: 5.4 * H, cluster: CTX.weihai, namespace: NS, pod: "wh-dev-0", node: "wh-h100-02" },
  { id: IRD, site: "iron", kind: "pod", label: "iron-dev-0 · iron", hostname: "iron-dev-0", platform: "linux", via: "pod-exec", lagMs: 95, skewMs: 30, up: 5.6 * H, cluster: CTX.iron, namespace: NS, pod: "iron-dev-0", node: "ulq-b300-02" },
];
const hostSite = Object.fromEntries(HOST_ROWS.map((h) => [h.id, h.site]));
const siteHost = (id) => hostSite[id];

function buildHosts(agents) {
  return HOST_ROWS.map((r) => {
    const mine = agents.filter((a) => a.host === r.id);
    const h = {
      id: r.id, site: r.site, kind: r.kind, label: r.label, hostname: r.hostname, platform: r.platform,
      ...(r.cluster && { cluster: r.cluster, namespace: r.namespace, pod: r.pod, node: r.node }),
      roots: {
        dsh: [`${HOME[r.id]}/.dsh/sessions`], claude: [`${HOME[r.id]}/.claude/projects`],
        codex: [`${HOME[r.id]}/.codex/sessions`], omp: [`${HOME[r.id]}/.omp/agent/sessions`],
      },
      status: r.status ?? "online", via: r.via,
      connectedAt: ago(r.up), lastSeen: r.lastSeenAgo ? ago(r.lastSeenAgo) : NOW - 700,
      ...(r.lagMs !== undefined && { lagMs: r.lagMs }),
      ...(r.skewMs !== undefined && { skewMs: r.skewMs }),
      ...(r.error && { error: r.error }),
      counts: { agents: mine.length, running: mine.filter((a) => a.status === "running").length },
    };
    return h;
  });
}

const IMG = {
  dev: "registry.omgwow.ai/mc/dev-cuda12:2026.10.2",
  train: "registry.omgwow.ai/mc/megatron-train:0.14.1-cu126",
  infer: "registry.omgwow.ai/mc/vllm-serve:0.11.2-cu126",
  side: "registry.omgwow.ai/mc/log-shipper:1.4.0",
  eval: "registry.omgwow.ai/mc/lm-eval:0.4.9",
  b300: "registry.omgwow.ai/mc/b300-train:2026.10.0",
};
const COLLECT = { "agent-fleet.omgwow.ai/collect": "true" };

function mkPod(site, name, o) {
  const cluster = CTX[site];
  const created = ago(o.age);
  const containers = o.containers ?? [{ name: "main", image: o.image, ready: o.ready !== false, state: o.state ?? "running", restarts: o.restarts ?? 0 }];
  const readyN = containers.filter((c) => c.ready).length;
  return {
    key: podKey(site, NS, name), site, cluster, namespace: NS, name,
    phase: o.phase ?? "Running", ready: `${readyN}/${containers.length}`, restarts: containers.reduce((n, c) => n + c.restarts, 0),
    ...(o.node && { node: o.node }), ...(o.ip && { podIP: o.ip }),
    createdAt: created, ...(o.startedAt !== false && o.phase !== "Pending" && { startedAt: created + 24 * S }),
    containers,
    requests: { cpu: o.cpu, memory: o.mem, ...(o.gpu && { gpu: o.gpu }) },
    ...(o.owner && { owner: o.owner }),
    labels: { ...(o.labels ?? {}), ...(o.collect ? COLLECT : {}) },
    collect: Boolean(o.collect),
    ...(o.collect && { hostId: podHostId(site, name) }),
  };
}

function buildPods() {
  const owner = "bochao-li";
  return [
    mkPod("os", "osmium-dev-0", { age: 3 * DAY + 4 * H, node: "osm-gpu-17", ip: "10.62.14.37", image: IMG.dev, cpu: "16", mem: "128Gi", gpu: 1, collect: true, owner: { kind: "StatefulSet", name: "osmium-dev" }, labels: { app: "osmium-dev", owner, "statefulset.kubernetes.io/pod-name": "osmium-dev-0" } }),
    mkPod("os", "osmium-train-0", { age: 26 * H, node: "osm-gpu-21", ip: "10.62.21.8", image: IMG.train, cpu: "96", mem: "1000Gi", gpu: 8, owner: { kind: "StatefulSet", name: "osmium-train" }, labels: { app: "osmium-train", owner, "volcano.sh/queue-name": "train-p0" } }),
    mkPod("os", "osmium-eval-job-x2k9p", { age: 95 * M, phase: "Succeeded", ready: false, node: "osm-gpu-19", ip: "10.62.19.71", image: IMG.eval, cpu: "8", mem: "64Gi", gpu: 1, state: "terminated: Completed (0)", owner: { kind: "Job", name: "osmium-eval-job" }, labels: { "job-name": "osmium-eval-job", owner } }),
    mkPod("os", "osmium-infer-6d9f7-qwz2p", { age: 2 * DAY + 9 * H, node: "osm-gpu-23", ip: "10.62.23.14", cpu: "32", mem: "256Gi", gpu: 4, owner: { kind: "ReplicaSet", name: "osmium-infer-6d9f7" }, labels: { app: "osmium-infer", owner, "pod-template-hash": "6d9f7" },
      containers: [{ name: "vllm", image: IMG.infer, ready: true, state: "running", restarts: 0 }, { name: "log-shipper", image: IMG.side, ready: true, state: "running", restarts: 0 }] }),
    mkPod("chengdu", "cd-train-master-0", { age: 2 * DAY + 2 * H, node: "cd-h100-04", ip: "10.31.4.12", image: IMG.train, cpu: "96", mem: "1000Gi", gpu: 8, restarts: 2, collect: true, owner: { kind: "StatefulSet", name: "cd-train-master" }, labels: { app: "cd-train", role: "master", owner } }),
    mkPod("chengdu", "cd-train-worker-1", { age: 2 * DAY + 2 * H, node: "cd-h100-05", ip: "10.31.5.9", image: IMG.train, cpu: "96", mem: "1000Gi", gpu: 8, owner: { kind: "StatefulSet", name: "cd-train-worker" }, labels: { app: "cd-train", role: "worker", owner } }),
    mkPod("chengdu", "cd-infer-5d7c9-zz4kd", { age: 7 * H, ready: false, node: "cd-h100-07", ip: "10.31.7.40", image: IMG.infer, cpu: "32", mem: "256Gi", gpu: 4, restarts: 14, state: "waiting: CrashLoopBackOff", owner: { kind: "ReplicaSet", name: "cd-infer-5d7c9" }, labels: { app: "cd-infer", owner, "pod-template-hash": "5d7c9" } }),
    mkPod("weihai", "wh-dev-0", { age: 5 * DAY, node: "wh-h100-02", ip: "10.44.2.21", image: IMG.dev, cpu: "16", mem: "128Gi", gpu: 1, collect: true, owner: { kind: "StatefulSet", name: "wh-dev" }, labels: { app: "wh-dev", owner, "statefulset.kubernetes.io/pod-name": "wh-dev-0" } }),
    mkPod("weihai", "wh-prefill-3", { age: 38 * M, phase: "Pending", ready: false, image: IMG.infer, cpu: "32", mem: "256Gi", gpu: 4, state: "waiting: ContainerCreating", owner: { kind: "StatefulSet", name: "wh-prefill" }, labels: { app: "wh-prefill", owner } }),
    mkPod("iron", "iron-dev-0", { age: 4 * DAY + 5 * H, node: "ulq-b300-02", ip: "10.72.2.15", image: IMG.dev, cpu: "16", mem: "128Gi", gpu: 1, collect: true, owner: { kind: "StatefulSet", name: "iron-dev" }, labels: { app: "iron-dev", owner, "statefulset.kubernetes.io/pod-name": "iron-dev-0" } }),
    mkPod("iron", "iron-b300-job-0", { age: 3 * H + 40 * M, node: "ulq-b300-03", ip: "10.72.3.6", image: IMG.b300, cpu: "112", mem: "1500Gi", gpu: 8, owner: { kind: "Job", name: "iron-b300-job" }, labels: { "job-name": "iron-b300-job", owner } }),
  ];
}

const ev = (type, reason, message, count, first, last) => ({ type, reason, message, count, firstSeen: first, lastSeen: last });
function buildPodEvents() {
  const k = (site, name) => podKey(site, NS, name);
  return {
    [k("weihai", "wh-prefill-3")]: [
      ev("Warning", "FailedScheduling", "0/18 nodes are available: 6 Insufficient nvidia.com/gpu, 9 node(s) didn't match Pod's node affinity/selector, 3 node(s) had untolerated taint {dedicated: infer}. preemption: 0/18 nodes are available: 18 Preemption is not helpful for scheduling.", 41, ago(37 * M), ago(40 * S)),
    ],
    [k("chengdu", "cd-infer-5d7c9-zz4kd")]: [
      ev("Normal", "Scheduled", "Successfully assigned mc-bochao-li/cd-infer-5d7c9-zz4kd to cd-h100-07", 1, ago(7 * H), ago(7 * H)),
      ev("Normal", "Pulled", "Container image \"registry.omgwow.ai/mc/vllm-serve:0.11.2-cu126\" already present on machine", 15, ago(7 * H), ago(3 * M)),
      ev("Normal", "Created", "Created container vllm", 15, ago(7 * H), ago(3 * M)),
      ev("Normal", "Started", "Started container vllm", 15, ago(7 * H), ago(3 * M)),
      ev("Warning", "Unhealthy", "Readiness probe failed: Get \"http://10.31.7.40:8000/health\": dial tcp 10.31.7.40:8000: connect: connection refused", 58, ago(6 * H + 50 * M), ago(3 * M + 20 * S)),
      ev("Warning", "BackOff", "Back-off restarting failed container vllm in pod cd-infer-5d7c9-zz4kd_mc-bochao-li(7c1e9a52-3b0f-4d7e-9a1c-0f8e4d2b6a11)", 312, ago(6 * H + 45 * M), ago(55 * S)),
    ],
    [k("os", "osmium-dev-0")]: [
      ev("Normal", "Scheduled", "Successfully assigned mc-bochao-li/osmium-dev-0 to osm-gpu-17", 1, ago(3 * DAY + 4 * H), ago(3 * DAY + 4 * H)),
      ev("Normal", "Pulled", "Container image \"registry.omgwow.ai/mc/dev-cuda12:2026.10.2\" already present on machine", 1, ago(3 * DAY + 4 * H), ago(3 * DAY + 4 * H)),
      ev("Normal", "Created", "Created container main", 1, ago(3 * DAY + 4 * H), ago(3 * DAY + 4 * H)),
      ev("Normal", "Started", "Started container main", 1, ago(3 * DAY + 4 * H), ago(3 * DAY + 4 * H)),
    ],
    [k("os", "osmium-train-0")]: [
      ev("Normal", "Scheduled", "Successfully assigned mc-bochao-li/osmium-train-0 to osm-gpu-21", 1, ago(26 * H), ago(26 * H)),
      ev("Normal", "Pulling", "Pulling image \"registry.omgwow.ai/mc/megatron-train:0.14.1-cu126\"", 1, ago(26 * H), ago(26 * H)),
      ev("Normal", "Pulled", "Successfully pulled image \"registry.omgwow.ai/mc/megatron-train:0.14.1-cu126\" in 4m12.3s (4m12.3s including waiting)", 1, ago(26 * H - 4 * M), ago(26 * H - 4 * M)),
      ev("Normal", "Started", "Started container main", 1, ago(26 * H - 5 * M), ago(26 * H - 5 * M)),
    ],
    [k("chengdu", "cd-train-master-0")]: [
      ev("Normal", "Scheduled", "Successfully assigned mc-bochao-li/cd-train-master-0 to cd-h100-04", 1, ago(2 * DAY + 2 * H), ago(2 * DAY + 2 * H)),
      ev("Warning", "Unhealthy", "Liveness probe failed: command timed out: \"/bin/sh -c nvidia-smi -L\" timed out after 10s", 2, ago(9 * H), ago(9 * H - 30 * S)),
      ev("Normal", "Killing", "Container main failed liveness probe, will be restarted", 2, ago(9 * H), ago(9 * H - 30 * S)),
      ev("Normal", "Started", "Started container main", 3, ago(2 * DAY + 2 * H), ago(8 * H + 55 * M)),
    ],
    [k("iron", "iron-b300-job-0")]: [
      ev("Normal", "Scheduled", "Successfully assigned mc-bochao-li/iron-b300-job-0 to ulq-b300-03", 1, ago(3 * H + 40 * M), ago(3 * H + 40 * M)),
      ev("Normal", "Pulled", "Container image \"registry.omgwow.ai/mc/b300-train:2026.10.0\" already present on machine", 1, ago(3 * H + 40 * M), ago(3 * H + 40 * M)),
      ev("Normal", "Started", "Started container main", 1, ago(3 * H + 39 * M), ago(3 * H + 39 * M)),
    ],
    [k("os", "osmium-eval-job-x2k9p")]: [
      ev("Normal", "Scheduled", "Successfully assigned mc-bochao-li/osmium-eval-job-x2k9p to osm-gpu-19", 1, ago(95 * M), ago(95 * M)),
      ev("Normal", "Started", "Started container main", 1, ago(94 * M), ago(94 * M)),
      ev("Normal", "Completed", "Job completed", 1, ago(41 * M), ago(41 * M)),
    ],
  };
}

// ───────────────────────────────────────────── file previews ─────────────────────────────────────────────
const L = (...lines) => lines.join("\n") + "\n";

const APP_JS = L(
  "'use strict';",
  "// Fleet view: sites → hosts → agent trees. Pure render helpers; the store lives in section 3.",
  "const KINDS = ['dsh', 'claude', 'codex', 'omp'];",
  "const STATUS_ORDER = { running: 0, waiting: 1, idle: 2, stale: 3, error: 4, interrupted: 5, done: 6, unknown: 7 };",
  "",
  "function buildTree(agents, links) {",
  "  const kids = new Map(), parent = new Map();",
  "  for (const l of links) {",
  "    if (!agents.has(l.from) || !agents.has(l.to) || parent.has(l.to)) continue;",
  "    parent.set(l.to, l);",
  "    if (!kids.has(l.from)) kids.set(l.from, []);",
  "    kids.get(l.from).push(l.to);",
  "  }",
  "  for (const list of kids.values()) list.sort((a, b) => agents.get(a).startedAt - agents.get(b).startedAt);",
  "  return { kids, parent };",
  "}",
  "",
  "function rootsOf(agents, tree) {",
  "  const roots = [];",
  "  for (const a of agents.values()) if (!tree.parent.has(a.key)) roots.push(a);",
  "  roots.sort((a, b) => (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) || (b.updatedAt - a.updatedAt));",
  "  return roots;",
  "}",
  "",
  "function agentRow(a, depth, tree) {",
  "  const kids = tree.kids.get(a.key) || [];",
  "  const live = a.live && a.live.doing ? a.live.doing : '';",
  "  return {",
  "    key: a.key, depth, kids: kids.length,",
  "    title: a.title || a.name || a.id.slice(0, 8),",
  "    cross: tree.parent.has(a.key) && tree.parent.get(a.key).crossHost,",
  "    sig: [a.status, a.updatedAt, live, kids.length].join('|'),",
  "  };",
  "}",
  "",
  "function flatten(roots, agents, tree, open) {",
  "  const rows = [];",
  "  const walk = (a, depth) => {",
  "    rows.push(agentRow(a, depth, tree));",
  "    if (!open.has(a.key)) return;",
  "    for (const k of tree.kids.get(a.key) || []) walk(agents.get(k), depth + 1);",
  "  };",
  "  for (const r of roots) walk(r, 0);",
  "  return rows;",
  "}",
  "",
  "function fmtAge(ms) {",
  "  const s = Math.max(0, Math.floor(ms / 1000));",
  "  if (s < 60) return s + 's';",
  "  if (s < 3600) return Math.floor(s / 60) + 'm';",
  "  return Math.floor(s / 3600) + 'h';",
  "}",
  "",
  "function applyDelta(state, d) {",
  "  if (d.reset) return false;",
  "  state.cursor = d.cursor;",
  "  for (const a of d.agents || []) state.agents.set(a.key, a);",
  "  for (const k of d.removed || []) state.agents.delete(k);",
  "  if (d.links) state.links = d.links;",
  "  for (const f of d.feed || []) state.feed.push(f);",
  "  if (state.feed.length > 300) state.feed.splice(0, state.feed.length - 300);",
  "  return true;",
  "}",
);

const APP_CSS = L(
  ":root {",
  "  --bg: #0f1216; --fg: #d7dde5; --fg2: #8b96a5; --line: #232a33;",
  "  --good: #3fb68b; --warn: #e0a93b; --bad: #e5534b; --accent: #5aa2ff;",
  "  --c-read: #6aa9ff; --c-edit: #e0a93b; --c-write: #e58a3b; --c-shell: #9aa5b1;",
  "  --c-k8s: #5ac8c0; --c-remote: #c084fc; --c-spawn: #3fb68b; --c-web: #f472b6;",
  "}",
  "@media (prefers-color-scheme: light) {",
  "  :root { --bg: #fbfbfa; --fg: #1d242c; --fg2: #5d6875; --line: #dfe3e8; }",
  "}",
  "html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); font: 13px/1.45 system-ui, sans-serif; }",
  ".mono { font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 12px; }",
  ".row { display: flex; align-items: center; gap: 6px; padding: 3px 10px; border-bottom: 1px solid var(--line); }",
  ".row.hdr { position: sticky; top: 0; background: var(--bg); font-weight: 600; }",
  ".row.sel { background: color-mix(in srgb, var(--accent) 14%, transparent); }",
  ".dot { width: 8px; height: 8px; border-radius: 50%; background: var(--fg2); flex: none; }",
  ".dot.running { background: var(--good); box-shadow: 0 0 0 0 var(--good); animation: pulse 1.6s infinite; }",
  ".dot.error, .dot.stale { background: var(--bad); }",
  ".chip { padding: 0 6px; border: 1px solid var(--line); border-radius: 9px; font-size: 11px; }",
  ".cat-k8s { color: var(--c-k8s); } .cat-remote { color: var(--c-remote); } .cat-spawn { color: var(--c-spawn); }",
  "@keyframes pulse { 70% { box-shadow: 0 0 0 6px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }",
);

const CONTRACT_MD = L(
  "## Hub",
  "",
  "* `startHub({hostId, collectors, upstream, kube, http, now})` in `lib/hub/index.mjs`.",
  "* State (`state.mjs`): hosts, agents (by key), events per agent (ring of `LIMITS.hubEventsPerAgent`), procs, pods,",
  "  links, feed. Monotonic `cursor` bumped on every change; changes kept in a journal (last 10 000) so a client",
  "  can ask `changes?since=<cursor>` and get a `Delta` (or `reset:true`).",
  "* Link resolution: for each agent with a `parent` hint, resolve to a key (same host by `key`/`file`, global by",
  "  `kind:id`); unresolved hints stay pending and are retried when new agents arrive.",
  "* Touches: index `Target`s of type `pod` (key `podKey(site, ns, name)`) and `file` (key `<host>:<path>`) → which",
  "  agents/events touched them. Pods referenced by any target are pulled into `pods` even if not watched by label.",
  "* Clock skew: `skewMs = hubNow − hello.at` (smoothed with heartbeats); every collector timestamp is shifted by skew.",
  "",
  "### HTTP",
  "",
  "| Route | What |",
  "|---|---|",
  "| `GET /api/snapshot` | hosts, agents, links, pods, feed |",
  "| `GET /api/changes?since=N` | `Delta` or `reset:true` |",
  "| `GET /api/stream?since=N` | SSE, keep-alive comment every 15 s |",
  "| `GET /api/file?host=H&path=P` | proxied to that host's collector |",
);

const PODS_YAML = L(
  "apiVersion: apps/v1",
  "kind: StatefulSet",
  "metadata:",
  "  name: agent-fleet-test",
  "  namespace: mc-bochao-li",
  "  labels:",
  "    app: agent-fleet-test",
  "    agent-fleet.omgwow.ai/collect: \"true\"",
  "spec:",
  "  serviceName: agent-fleet-test",
  "  replicas: 1",
  "  selector:",
  "    matchLabels:",
  "      app: agent-fleet-test",
  "  template:",
  "    metadata:",
  "      labels:",
  "        app: agent-fleet-test",
  "        agent-fleet.omgwow.ai/collect: \"true\"",
  "    spec:",
  "      containers:",
  "        - name: main",
  "          image: registry.omgwow.ai/mc/dev-cuda12:2026.10.2",
  "          command: [\"sleep\", \"infinity\"]",
  "          resources:",
  "            requests:",
  "              cpu: \"2\"",
  "              memory: 8Gi",
  "            limits:",
  "              cpu: \"4\"",
  "              memory: 16Gi",
  "          volumeMounts:",
  "            - name: workspace",
  "              mountPath: /workspace",
  "  volumeClaimTemplates:",
  "    - metadata:",
  "        name: workspace",
  "      spec:",
  "        accessModes: [\"ReadWriteOnce\"]",
  "        resources:",
  "          requests:",
  "            storage: 50Gi",
);

const RUN_BENCH_SH = L(
  "#!/usr/bin/env bash",
  "# Run one benchmark suite and append a row to results/results.json",
  "set -euo pipefail",
  "",
  "SUITE=\"${1:-mmlu-pro}\"",
  "LIMIT=\"${LIMIT:-200}\"",
  "OUT=\"/data/bench/results/${SUITE}-$(date +%Y%m%dT%H%M%S)\"",
  "mkdir -p \"$OUT\"",
  "",
  "echo \"[bench] suite=$SUITE limit=$LIMIT out=$OUT\"",
  "python3 /data/bench/eval/score.py \\",
  "  --suite \"$SUITE\" \\",
  "  --endpoint \"${ENDPOINT:-http://10.0.60.98:8000/v1}\" \\",
  "  --limit \"$LIMIT\" \\",
  "  --workers 16 \\",
  "  --out \"$OUT/raw.jsonl\" 2>&1 | tee \"$OUT/run.log\"",
  "",
  "python3 /data/bench/eval/score.py --summarize \"$OUT/raw.jsonl\" >> /data/bench/results/results.json",
  "echo \"[bench] done: $(wc -l < \"$OUT/raw.jsonl\") rows\"",
);

const HUB_SERVICE = L(
  "[Unit]",
  "Description=Agent Fleet hub (collector ingest + HTTP API)",
  "After=network-online.target",
  "Wants=network-online.target",
  "",
  "[Service]",
  "Type=simple",
  "User=bochao_li",
  "WorkingDirectory=/home/bochao_li/agent-fleet",
  "Environment=NODE_ENV=production",
  "Environment=AGENT_FLEET_BASE=/fleet",
  "ExecStart=/usr/local/bin/node bin/agent-fleet.mjs hub --http 127.0.0.1:7840 --ingest 127.0.0.1:7841 --kube",
  "Restart=on-failure",
  "RestartSec=3",
  "NoNewPrivileges=true",
  "ProtectSystem=strict",
  "ReadWritePaths=/home/bochao_li/.config/agent-fleet /home/bochao_li/.cache/agent-fleet",
  "",
  "[Install]",
  "WantedBy=multi-user.target",
);

const EVAL_PY = L(
  "#!/usr/bin/env python3",
  "\"\"\"Evaluate one checkpoint on the held-out prompt set and print a JSON line.\"\"\"",
  "import argparse, json, time",
  "from pathlib import Path",
  "",
  "import torch",
  "from transformers import AutoModelForCausalLM, AutoTokenizer",
  "",
  "PROMPTS = Path(\"/workspace/ckpt-eval/data/heldout.jsonl\")",
  "",
  "",
  "def load(ckpt: str):",
  "    tok = AutoTokenizer.from_pretrained(ckpt, trust_remote_code=True)",
  "    model = AutoModelForCausalLM.from_pretrained(ckpt, torch_dtype=torch.bfloat16, device_map=\"auto\")",
  "    model.eval()",
  "    return tok, model",
  "",
  "",
  "@torch.no_grad()",
  "def nll(tok, model, text: str) -> float:",
  "    ids = tok(text, return_tensors=\"pt\").input_ids.to(model.device)",
  "    out = model(ids, labels=ids)",
  "    return out.loss.item()",
  "",
  "",
  "def main():",
  "    ap = argparse.ArgumentParser()",
  "    ap.add_argument(\"--ckpt\", required=True)",
  "    ap.add_argument(\"--limit\", type=int, default=64)",
  "    args = ap.parse_args()",
  "",
  "    t0 = time.time()",
  "    tok, model = load(args.ckpt)",
  "    rows = [json.loads(x) for x in PROMPTS.read_text().splitlines()[: args.limit]]",
  "    losses = [nll(tok, model, r[\"text\"]) for r in rows]",
  "    print(json.dumps({",
  "        \"ckpt\": args.ckpt,",
  "        \"n\": len(losses),",
  "        \"loss\": sum(losses) / max(1, len(losses)),",
  "        \"seconds\": round(time.time() - t0, 1),",
  "    }))",
  "",
  "",
  "if __name__ == \"__main__\":",
  "    main()",
);

const RESULTS_JSON = (() => {
  const rows = [];
  const names = ["mmlu-pro", "gpqa-diamond", "ifeval", "livecodebench", "math-500", "arena-hard"];
  for (let i = 0; i < 14; i++) {
    const n = names[i % names.length];
    rows.push(`  {"suite": "${n}", "ckpt": "step_${8000 + i * 500}", "n": ${200 + (i % 3) * 100}, "score": ${(0.41 + ((i * 37) % 23) / 100).toFixed(4)}, "seconds": ${312 + i * 17}, "ts": "2026-10-29T${String(10 + (i % 12)).padStart(2, "0")}:12:08Z"}`);
  }
  return "[\n" + rows.join(",\n") + ",\n";
})();

const HUB_ENV = L(
  "# Agent Fleet hub environment (synthetic demo)",
  "AGENT_FLEET_BASE=/fleet",
  "AGENT_FLEET_TOKEN=‹redacted›",
  "AGENT_FLEET_HTTP=127.0.0.1:7840",
  "AGENT_FLEET_INGEST=127.0.0.1:7841",
  "KUBECONFIG=/home/bochao_li/.config/agent-fleet/kubeconfig.yaml",
  "KUBECONFIG_B64=‹redacted›",
  "NODE_OPTIONS=--max-old-space-size=512",
);

function buildFiles() {
  const out = {};
  const put = (host, path, f) => { out[`${host}:${path}`] = { host, path, ...f }; };
  const text = (content, age, extra = {}) => ({ exists: true, size: Buffer.byteLength(content), mtime: ago(age), content, ...extra });
  put(MAC, `${MAC_ROOT}/panel/app.js`, text(APP_JS, 4 * M));
  put(MAC, `${MAC_ROOT}/panel/app.css`, text(APP_CSS, 31 * M));
  put(MAC, `${MAC_ROOT}/CONTRACT.md`, text(CONTRACT_MD, 2 * H));
  put(MAC, `${MAC_ROOT}/deploy/agent-fleet.env`, text(HUB_ENV, 3 * H, { redactions: 2 }));
  put(SRV, `${SRV_ROOT}/deploy/k8s/agent-fleet-test.yaml`, text(PODS_YAML, 52 * M));
  put(SRV, `${SRV_ROOT}/deploy/systemd/agent-fleet-hub.service`, text(HUB_SERVICE, 17 * M));
  put(SRV, "/home/bochao_li/.config/agent-fleet/token", { exists: true, denied: "secret path" });
  put(SRV, `${SRV_ROOT}/tmp/old-run.log`, { exists: false });
  put(SG, "/data/bench/run_bench.sh", text(RUN_BENCH_SH, 6 * H));
  put(SG, "/data/bench/results/results.json", { exists: true, size: 262144, mtime: ago(2 * M), truncated: true, content: RESULTS_JSON });
  put(OSDEV, "/workspace/ckpt-eval/eval_ckpt.py", text(EVAL_PY, 74 * M));
  put(OSDEV, "/workspace/ckpt-eval/ckpt/step_12000/model-00001-of-00004.safetensors", { exists: true, size: 4983210496, mtime: ago(3 * H), binary: true });
  return out;
}

// ───────────────────────────────────────────── agents: who ran where, when, and under whom ─────────────────────────────────────────────
// start/last/end are "ms before NOW". status running → last defaults to 2 s; n = rough event count before DENSITY scaling.
// parent.call: "spawn" (the parent has a spawn event named after the child), "launch" (a bash event launches it),
//              a literal id (acp turn), or null (fork/projection: no tool call).
const OPUS = "claude-opus-4-1", SONNET = "claude-sonnet-4-5", CODEX = "gpt-5-codex", OMPM = "tokenrouter-v2/claude-sonnet-5.5", DSHM = "deepseek-v4-pro";
const DAY = 24 * H;
const AGENT_ROWS = [
  // ── mac
  { tag: "A1", kind: "dsh", host: MAC, role: "main", title: "重构 agent fleet 面板", start: 47 * M, status: "running", model: DSHM, effort: "high", n: 105, pace: "slow", prof: "macui", pend: "acp", turns: 1, quiet: true, steer: [0.35, 0.72], acp: { provider: "codex-acp", kind: "codex", tag: "A1a" } },
  { tag: "A1a", kind: "codex", host: MAC, role: "main", title: "Implement Fleet view refactor (ACP)", start: 46 * M, status: "running", model: CODEX, effort: "high", n: 130, pace: "slow", prof: "macui", pend: "tool", turns: 7, parent: { tag: "A1", via: "acp", exact: true, call: "acp-turn-3" }, ctxGrowth: 4200, compact: 0.55 },
  { tag: "A1a-1", kind: "codex", host: MAC, role: "subagent", name: "explorer", title: "explorer", desc: "explorer · /root/explorer", start: 21 * M, end: 17 * M, status: "done", model: CODEX, effort: "medium", n: 46, pace: "fast", prof: "macui", turns: 1, parent: { tag: "A1a", via: "file", exact: true, call: "spawn" } },
  { tag: "A1a-2", kind: "codex", host: MAC, role: "subagent", name: "worker", title: "worker", desc: "worker · /root/worker", start: 6 * M, status: "running", model: CODEX, effort: "medium", n: 40, pace: "fast", prof: "macui", pend: "model", turns: 1, parent: { tag: "A1a", via: "file", exact: true, call: "spawn" } },
  { tag: "P1", kind: "dsh", host: MAC, role: "projection", name: "explorer", title: "explorer", desc: "DSH mirror of the ACP subagent explorer", start: 21 * M - 1800, end: 17 * M - 1800, noUsage: true, status: "done", model: DSHM, effort: "medium", n: 26, pace: "fast", prof: "macui", turns: 1, parent: { tag: "A1", via: "acp", exact: true, call: null } },
  { tag: "A2", kind: "claude", host: MAC, role: "main", title: "修复 cordis 插件加载失败", start: 3.2 * H, last: 9 * M, status: "idle", model: OPUS, effort: "high", n: 66, pace: "slow", prof: "maccordis", turns: 5, wins: [[192 * M, 160 * M], [112 * M, 101 * M], [63 * M, 49 * M], [47 * M, 41 * M], [28 * M, 9 * M]], live: { alive: true, pid: 4121 } },
  { tag: "A2a", kind: "claude", host: MAC, role: "subagent", name: "Explore", title: "Explore cordis plugin resolution", desc: "Explore how cordis resolves plugin entry points", start: 2.82 * H, end: 2.75 * H, status: "done", model: SONNET, effort: "medium", n: 30, pace: "fast", prof: "maccordis", turns: 1, parent: { tag: "A2", via: "file", exact: true, call: "spawn" } },
  { tag: "A2b", kind: "claude", host: MAC, role: "subagent", name: "code-reviewer", title: "Review package.json + cordis.patch.yml", desc: "Review the plugin manifest diff", start: 62 * M, end: 56 * M, status: "done", model: SONNET, effort: "medium", n: 34, pace: "fast", prof: "maccordis", turns: 1, parent: { tag: "A2", via: "file", exact: true, call: "spawn" } },
  { tag: "A2c", kind: "claude", host: MAC, role: "fork", title: "exports-map variant (fork)", start: 26 * M, end: 17 * M, status: "done", model: OPUS, effort: "high", n: 42, pace: "normal", prof: "maccordis", turns: 2, parent: { tag: "A2", via: "file", exact: true, call: null } },
  { tag: "A3", kind: "omp", host: MAC, role: "main", title: "编写 collector 单元测试", start: 95 * M, last: 4 * M, status: "waiting", model: OMPM, effort: "high", n: 62, pace: "slow", prof: "maccollect", turns: 5, wait: true, waitText: "fork 会话的用例我准备放进 tests/jsonl.test.mjs 里复用现有夹具；如果你更想单独建 tests/fork.test.mjs，请告诉我。继续之前需要你确认。" },
  { tag: "A3a", kind: "omp", host: MAC, role: "subagent", name: "Readers", title: "Readers", desc: "Summarise the reader contracts", start: 62 * M, end: 55 * M, status: "done", model: OMPM, effort: "medium", n: 40, pace: "fast", prof: "maccollect", turns: 1, parent: { tag: "A3", via: "file", exact: true, call: "spawn" } },
  { tag: "A4", kind: "dsh", host: MAC, role: "main", title: "整理 Obsidian 笔记", cwd: "/Users/lbc/Documents/Obsidian/notes", start: 28 * H, end: 26 * H, status: "done", model: DSHM, effort: "medium", n: 48, pace: "normal", prof: "macobs", turns: 4, wins: [[28 * H, 27.55 * H], [27.35 * H, 26.95 * H], [26.7 * H, 26.4 * H], [26.25 * H, 26 * H]] },
  { tag: "A5", kind: "claude", host: MAC, role: "main", title: "清理 worktree", cwd: "/Users/lbc/Desktop/work/TokenRouterNew", start: 80 * M, last: 25 * M, status: "stale", model: SONNET, effort: "medium", n: 32, pace: "normal", prof: "macwt", turns: 3, live: { alive: false } },
  // ── server-bochao-01
  { tag: "B1", kind: "omp", host: SRV, role: "main", title: "部署 agent-fleet hub 到 server", start: 38 * M, status: "running", model: OMPM, effort: "high", n: 125, ctxGrowth: 3600, pace: "slow", prof: "srvops", pend: "spawn:B1b", turns: 6 },
  { tag: "B1a", kind: "omp", host: SRV, role: "subagent", name: "explore-kube", title: "explore-kube", desc: "Survey the kubectl surface of the kube source", start: 35 * M, end: 31 * M, status: "done", model: OMPM, effort: "medium", n: 36, pace: "fast", prof: "srvops", turns: 1, parent: { tag: "B1", via: "file", exact: true, call: "spawn" } },
  { tag: "B1b", kind: "omp", host: SRV, role: "subagent", name: "write-edge-tests", title: "write-edge-tests", desc: "Write tests/edge.test.mjs", start: 24 * M, status: "running", model: OMPM, effort: "medium", n: 56, pace: "normal", prof: "srvops", pend: "tool", turns: 1, parent: { tag: "B1", via: "file", exact: true, call: "spawn" } },
  { tag: "B1b1", kind: "omp", host: SRV, role: "subagent", name: "fixtures", title: "fixtures", desc: "Fake backend fixture for the edge tests", start: 17 * M, end: 12 * M, status: "done", model: OMPM, effort: "low", n: 26, pace: "fast", prof: "srvops", turns: 1, parent: { tag: "B1b", via: "file", exact: true, call: "spawn" } },
  { tag: "B2", kind: "claude", host: SRV, role: "main", title: "审阅 PR #482", start: 2.1 * H, last: 33 * M, status: "idle", model: OPUS, effort: "high", n: 44, pace: "slow", prof: "srvops", turns: 4, live: { alive: true, pid: 20817 } },
  { tag: "B3", kind: "dsh", host: SRV, role: "main", title: "训练监控", start: 52 * M, status: "running", model: DSHM, effort: "high", n: 82, pace: "slow", prof: "srvtrain", pend: "acp", turns: 1, quiet: true, steer: [0.5], acp: { provider: "omp-acp", kind: "omp", tag: "B3a" } },
  { tag: "B3a", kind: "omp", host: SRV, role: "main", title: "Tail iron-b300-job-0 logs (ACP)", start: 51 * M, status: "running", model: OMPM, effort: "medium", n: 150, pace: "slow", prof: "srvtrain", pend: "spawn:B3a1", turns: 4, parent: { tag: "B3", via: "acp", exact: true, call: "acp-turn-1" } },
  { tag: "B3a1", kind: "omp", host: SRV, role: "subagent", name: "gpu-util-probe", title: "gpu-util-probe", desc: "Probe GPU utilisation with nvidia-smi dmon", start: 9 * M, status: "running", model: OMPM, effort: "low", n: 36, pace: "fast", prof: "srvtrain", pend: "tool", turns: 1, parent: { tag: "B3a", via: "file", exact: true, call: "spawn" } },
  { tag: "B4", kind: "codex", host: SRV, role: "main", title: "编写 k8s manifest", start: 95 * M, end: 70 * M, status: "error", model: CODEX, effort: "high", n: 38, pace: "normal", prof: "srvops", turns: 3, errorEnd: true, live: { alive: false } },
  // ── sg-compute
  { tag: "S1", kind: "claude", host: SG, role: "main", title: "Run smoke benchmark on sg-compute", cwd: "/data/bench", start: 27 * M, status: "running", model: SONNET, effort: "medium", n: 70, pace: "normal", prof: "sgbench", pend: "spawn:S1a", turns: 2, parent: { tag: "B1", via: "command", exact: false, call: "launch", hint: false } },
  { tag: "S1a", kind: "claude", host: SG, role: "subagent", name: "benchmark-runner", title: "benchmark-runner", desc: "Run run_bench.sh for mmlu-pro and ifeval", cwd: "/data/bench", start: 14 * M, status: "running", model: SONNET, effort: "low", n: 42, pace: "fast", prof: "sgbench", pend: "tool", turns: 1, parent: { tag: "S1", via: "file", exact: true, call: "spawn" } },
  { tag: "S2", kind: "omp", host: SG, role: "main", title: "数据清洗脚本", cwd: "/data/bench", start: 2.83 * H, end: 2 * H, status: "done", model: OMPM, effort: "medium", n: 32, pace: "normal", prof: "sgbench", turns: 3 },
  { tag: "S3", kind: "codex", host: SG, role: "main", title: "整理评测脚本", cwd: "/data/bench", start: 72 * M, last: 14 * M, status: "idle", model: CODEX, effort: "medium", n: 34, pace: "normal", prof: "sgbench", turns: 3, live: { alive: true, pid: 33190 } },
  // ── chengdu / weihai / iron / os pods
  { tag: "D1", kind: "omp", host: CDM, role: "main", title: "监控训练 loss", cwd: "/workspace", start: 2.08 * H, status: "running", model: OMPM, effort: "medium", n: 96, pace: "slow", prof: "podtrain", pend: "spawn:D1a", turns: 8 },
  { tag: "D1a", kind: "omp", host: CDM, role: "subagent", name: "tail-logs", title: "tail-logs", desc: "Tail train.log and report loss spikes", cwd: "/workspace", start: 11 * M, status: "running", model: OMPM, effort: "low", n: 42, pace: "fast", prof: "podtrain", pend: "model", turns: 1, parent: { tag: "D1", via: "file", exact: true, call: "spawn" } },
  { tag: "D2", kind: "claude", host: CDM, role: "main", title: "排查 NCCL 超时", cwd: "/workspace", start: 3.3 * H, last: 47 * M, status: "idle", model: SONNET, effort: "medium", n: 32, pace: "normal", prof: "podtrain", turns: 3, live: { alive: true, pid: 2284 } },
  { tag: "W1", kind: "claude", host: WHD, role: "main", title: "调试 vLLM 启动", cwd: "/workspace", start: 100 * M, last: 10 * M, status: "stale", model: SONNET, effort: "medium", n: 44, pace: "normal", prof: "podvllm", turns: 3, live: { alive: null } },
  { tag: "E1", kind: "codex", host: IRD, role: "main", title: "修复数据管线", cwd: "/workspace", start: 85 * M, last: 22 * M, status: "idle", model: CODEX, effort: "medium", n: 42, pace: "normal", prof: "podiron", turns: 3, live: { alive: true, pid: 7712 } },
  { tag: "E1a", kind: "codex", host: IRD, role: "subagent", name: "cursor-hunter", title: "cursor-hunter", desc: "cursor-hunter · /root/cursor-hunter", cwd: "/workspace", start: 50 * M, end: 44 * M, status: "done", model: CODEX, effort: "low", n: 26, pace: "fast", prof: "podiron", turns: 1, parent: { tag: "E1", via: "file", exact: true, call: "spawn" } },
  { tag: "C1", kind: "claude", host: OSDEV, role: "main", title: "GPU health + eval step_12000", cwd: "/workspace", start: 22 * M, status: "running", model: SONNET, effort: "medium", n: 72, pace: "normal", prof: "podeval", pend: "spawn:C1b", turns: 2, parent: { tag: "B1", via: "env", exact: true, call: "launch", hint: true } },
  { tag: "C1a", kind: "claude", host: OSDEV, role: "subagent", name: "ckpt-lister", title: "ckpt-lister", desc: "List checkpoints under /workspace/ckpt-eval/ckpt", cwd: "/workspace", start: 17 * M, end: 11 * M, status: "done", model: SONNET, effort: "low", n: 30, pace: "fast", prof: "podeval", turns: 1, parent: { tag: "C1", via: "file", exact: true, call: "spawn" } },
  { tag: "C1b", kind: "claude", host: OSDEV, role: "subagent", name: "eval-runner", title: "eval-runner", desc: "Run eval_ckpt.py on step_12000", cwd: "/workspace", start: 8 * M, status: "running", model: SONNET, effort: "low", n: 36, pace: "fast", prof: "podeval", pend: "tool", turns: 1, parent: { tag: "C1", via: "file", exact: true, call: "spawn" } },
  { tag: "F1", kind: "omp", host: OSDEV, role: "main", title: "评估 checkpoint", cwd: "/workspace", start: 41 * M, status: "running", model: OMPM, effort: "high", n: 82, pace: "slow", prof: "podeval", pend: "tool", turns: 5 },
];

const U = (...u) => u, TXT = {
  A1: { u: ["重构 agent fleet 面板：把 Fleet 视图的树形渲染拆成纯函数，并补上 Timeline 的 GAP 折叠，具体实现交给 codex 去做。"], s: ["跨主机的 spawn 连接线在 Gantt 里要用紫色虚线，帮我改一下。", "把 demo 数据接到 ?demo=1，跑一遍面板测试。"], a: [] },
  A1a: { u: ["Implement the Fleet view refactor from the DSH session: split buildTree/flatten into pure helpers, keep render signatures stable.", "Run the panel tests and fix whatever breaks."], a: ["Refactor landed in panel/app.js; panel tests pass (23/23).", "Fixed the sig mismatch in agentRow; rendering no longer thrashes."] },
  "A1a-1": { u: ["Explore panel/app.js and lib/protocol.mjs: list every place that derives a parent/child relation from links or parent hints. Report file:line pairs, do not edit."], a: ["Found 4 call sites (buildGraph, rootOf, subtree, resolveFocus); all prefer hub links over parent hints."] },
  "A1a-2": { u: ["Update tests/panel.test.mjs for the new buildTree signature and add a cycle-guard case."], a: [] },
  P1: { u: ["Explore panel/app.js and lib/protocol.mjs: list every place that derives a parent/child relation (projected from the ACP agent)."], a: ["explorer finished: 4 call sites found."] },
  A2: { u: ["cordis 插件加载失败：dsh-agent-fleet 的 client.js 报 'Cannot find module'，帮我定位。", "再看看 cordis.patch.yml 里的配置是不是写错了。"], a: ["原因是 package.json 的 exports 缺少 ./client，已补上并验证插件可加载。", "cordis.patch.yml 没问题，问题在 inject 声明。"] },
  A2a: { u: ["Explore how cordis resolves plugin entry points (index.js vs client.js) and where 'Cannot find module' can originate."], a: ["Entry resolution happens in loader.ts; the client bundle is looked up through package.json exports."] },
  A2b: { u: ["Review the diff of package.json and cordis.patch.yml for plugin-loading regressions."], a: ["No blocking issues; consider a smoke test for client.js resolution."] },
  A2c: { u: ["Try the alternative: register the browser entry through the exports map instead of a files glob."], a: ["Exports-map variant works; kept as the final fix."] },
  A3: { u: ["编写 collector 单元测试：覆盖 jsonl tail reader 和 readers/omp.mjs 的 subagent 路径解析。", "补一个 fork 会话的用例。"], a: ["jsonl.mjs 的 6 个用例已写好并通过。"] },
  A3a: { u: ["Read lib/collector/readers/*.mjs and summarise each reader's match() contract and parent-hint rules so tests can be written against them."], a: ["Summary written: omp nested ids use <uuid>/<parent>.<name>; claude uses <sid>/<agentId>."] },
  A4: { u: ["整理 Obsidian 笔记：把 inbox 里的零散想法按主题归档到 projects/ 和 areas/。"], a: ["已归档 23 条笔记，更新了 MOC 索引。"] },
  A5: { u: ["清理 worktree：列出 TokenRouterNew/worktrees 下超过 7 天未更新且已合并的分支并删除。"], a: ["已列出 9 个候选 worktree。"] },
  B1: { u: ["部署 agent-fleet hub 到 server：写 systemd unit，配置 edge 反代 /fleet，并验证 kube 采集。", "再把 collector 分发到 sg-compute 和 osmium-dev-0 试跑。"], a: ["hub 已在 127.0.0.1:7840 启动，/api/health 返回 ok。", "systemd unit 已安装并 enable。"] },
  B1a: { u: ["Survey the kubectl surface lib/hub/sources/kube.mjs needs: which commands run per site and what do they print on failure?"], a: ["Catalogued 6 kubectl invocations: list, watch, exec, cp, events, get-pod-json."] },
  B1b: { u: ["Write tests/edge.test.mjs covering path stripping (/fleet, /dsh), WebSocket upgrade and streaming bodies."], a: [] },
  B1b1: { u: ["Create a fake backend fixture (HTTP + WS echo) for the edge tests under tests/fixtures/edge/."], a: ["Fixture server ready: tests/fixtures/edge/echo-backend.mjs."] },
  S1: { u: ["Run the smoke benchmark suite on sg-compute against the staging endpoint and collect results/results.json."], a: [] },
  S1a: { u: ["Run run_bench.sh for mmlu-pro and ifeval with LIMIT=200 and keep the logs under results/."], a: [] },
  C1: { u: ["Check GPU health on this pod and run the checkpoint eval at step_12000; report loss and any NCCL warnings."], a: [] },
  C1a: { u: ["List the checkpoints under /workspace/ckpt-eval/ckpt and report sizes and mtime."], a: ["3 checkpoints: step_8000, step_10000, step_12000 (4 shards each)."] },
  C1b: { u: ["Run eval_ckpt.py on step_12000 with --limit 64 and print the JSON result."], a: [] },
  B2: { u: ["审阅 PR #482：agent-fleet hub 的 kube 源重连逻辑，重点看 watch 退出后的 backoff 和 collector 重新注入。", "再确认一下测试覆盖。"], a: ["PR #482 整体可合并，建议补一个 watch 断流的测试。"] },
  B3: { u: ["训练监控：盯住 iron-b300-job-0 的 loss 曲线和 GPU 利用率，异常时告诉我。"], s: ["如果 grad-norm 超过 2.0 马上叫我。"], a: ["loss 平稳下降，GPU 利用率 91%。"] },
  B3a: { u: ["Tail iron-b300-job-0 logs every minute and summarise loss, grad-norm and throughput; flag NaNs."], a: ["Step 3400: loss 2.131, grad-norm 0.84, 412k tok/s."] },
  B3a1: { u: ["Probe GPU utilisation on iron-b300-job-0 with nvidia-smi dmon and report the 3-minute average."], a: [] },
  B4: { u: ["编写 k8s manifest：给 agent-fleet collector 做一个带 collect 标签的 StatefulSet 版本。"], a: [] },
  S2: { u: ["数据清洗脚本：把 /data/bench/raw 下的 jsonl 去重、过滤长度异常的样本，输出到 clean/。"], a: ["clean_data.py 完成，保留 118,402 / 131,070 条。"] },
  S3: { u: ["整理评测脚本：把 run_eval.sh 和 score.py 的参数统一，支持 --suite 和 --limit。"], a: ["参数已统一，README 增加了用法。"] },
  D1: { u: ["监控训练 loss：盯 cd-train-master-0 上的 train.log，loss 突增或 NaN 就报警。", "顺便看看 cd-infer 为什么一直 CrashLoopBackOff。"], a: ["loss 在 step 5200 附近有一次尖峰，随后恢复。"] },
  D1a: { u: ["Tail /workspace/logs/train.log and report any loss spike over 3σ in the last 500 steps."], a: [] },
  D2: { u: ["排查 NCCL 超时：master 和 worker-1 之间 allreduce 偶发 timeout。"], a: ["怀疑是 NCCL_IB_HCA 配置，建议固定网卡并设置 NCCL_DEBUG=INFO 复现。"] },
  W1: { u: ["调试 vLLM 启动：wh-prefill-3 一直 Pending，看是不是 GPU 资源不足，并在 wh-dev-0 上试跑 serve.sh。"], a: [] },
  E1: { u: ["修复数据管线：pipeline.py 在 shard 边界处丢样本，补上 off-by-one 并加回归测试。"], a: ["off-by-one 已修复，回归测试通过。"] },
  E1a: { u: ["Find where pipeline.py advances the shard cursor and report the exact line."], a: ["Cursor advance is at pipeline.py:142; it uses < instead of <=."] },
  F1: { u: ["评估 checkpoint：对 step_12000 跑 held-out 集 loss，并和 step_10000 对比。", "把结果写进 runs/ckpt-12000/metrics.json。"], a: ["step_12000 的 held-out loss 为 1.874，比 step_10000 低 0.041。"] },
};
const FOLLOW = ["继续", "好的，接着做。", "run the tests again", "再检查一遍边界情况", "看下为什么挂了", "ok, go on", "把结果贴给我", "先别改，解释一下原因"];
const SAY = [
  "先看一下现有实现再动手。", "I'll check the surrounding code before editing.", "这里需要同时更新测试。", "Let me run the tests to confirm.",
  "找到了，问题出在边界条件。", "Looks fine so far; continuing with the next file.", "先确认一下集群状态。", "The error is coming from the retry path.",
  "改动很小，直接应用。", "Verifying the result against the contract.", "输出符合预期，继续下一步。", "Need one more read to be sure.",
];

// ───────────────────────────────────────────── tool vocabulary + pools ─────────────────────────────────────────────
const NAMES = {
  claude: { read: "Read", edit: "Edit", write: "Write", grep: "Grep", glob: "Glob", bash: "Bash", web: "WebFetch", spawn: "Task", msg: "SendMessage" },
  codex: { read: "read_file", edit: "apply_patch", write: "apply_patch", bash: "shell", spawn: "spawn_agent", msg: "send_input" },
  omp: { read: "read", edit: "edit", write: "write", grep: "grep", glob: "find", bash: "bash", web: "fetch", spawn: "task", msg: "send_message" },
  dsh: { read: "Read", edit: "Edit", write: "Edit", bash: "Bash", spawn: "acp.prompt", msg: "agent_message" },
};
/** What a model of each kind reaches for (codex/dsh have no grep/glob tools: those go through shell). */
const CLASS_W = {
  claude: [[30, "read"], [17, "edit"], [3, "write"], [12, "grep"], [5, "glob"], [30, "bash"], [3, "web"]],
  omp: [[30, "read"], [17, "edit"], [3, "write"], [12, "grep"], [5, "glob"], [30, "bash"], [3, "web"]],
  codex: [[14, "read"], [20, "edit"], [66, "bash"]],
  dsh: [[28, "read"], [20, "edit"], [52, "bash"]],
};
const PACE = {
  slow: { model: [5000, 14000], gap: [200, 1400] },
  normal: { model: [3000, 9500], gap: [150, 900] },
  fast: { model: [2000, 6500], gap: [100, 500] },
};

// kubectl / ssh command builders (shapes follow lib/targets.mjs output)
const kb = (site, ctx = CTX[site]) => `kubectl --context ${ctx} -n ${NS}`;
const podT = (site, op, name, ctx, container) => ({ type: "pod", op, site, cluster: ctx, namespace: NS, name, ...(container && { container }) });
function kget(site, o = {}) {
  const ctx = o.ctx ?? CTX[site];
  return { act: "bash", cat: "k8s", cmd: `${kb(site, ctx)} get pods${o.sel ? ` -l ${o.sel}` : ""}${o.wide ? " -o wide" : ""}`,
    targets: [{ type: "k8s", op: "get", site, cluster: ctx, namespace: NS, resource: "pod" }], dur: [520, 1900] };
}
function kpod(site, verb, name, o = {}) {
  const ctx = o.ctx ?? CTX[site], base = kb(site, ctx);
  const cmd = verb === "logs" ? `${base} logs ${name}${o.c ? ` -c ${o.c}` : ""} --tail=${o.tail ?? 100}${o.since ? ` --since=${o.since}` : ""}`
    : verb === "exec" ? `${base} exec ${name} -- ${o.inner}`
    : verb === "get" ? `${base} get pod ${name}${o.wide ? " -o wide" : ""}${o.json ? " -o json" : ""}`
    : `${base} describe pod ${name}`;
  const dur = o.dur ?? (verb === "logs" ? [900, 4200] : verb === "exec" ? [800, 5200] : verb === "describe" ? [700, 2300] : [450, 1600]);
  const { err, errText, fail, exit } = o;
  return { act: "bash", cat: "k8s", cmd, targets: [podT(site, verb, name, ctx, o.c), ...(o.more ?? [])], dur, err, errText, fail, exit };
}
function kssh(host, inner, o = {}) {
  const { err, errText, fail, exit } = o;
  return { act: "bash", cat: "remote", cmd: `ssh ${host} '${inner}'`, targets: [{ type: "host", op: "ssh", host, site: siteOfSshTarget(host) }, ...(o.more ?? [])], dur: o.dur ?? [900, 4200], err, errText, fail, exit };
}

const R = MAC_ROOT, V = SRV_ROOT, BN = "/data/bench", WS = "/workspace";
const OBS = "/Users/lbc/Documents/Obsidian/notes", WT = "/Users/lbc/Desktop/work/TokenRouterNew";

/** Per-profile pools. files/edits/writes: [weight, path]; greps: [pattern, path]; globs: [pattern, dir]; cmds: [weight, text, opts]. */
const POOLS = {
  macui: {
    cwd: R,
    files: [[10, `${R}/panel/app.js`], [5, `${R}/panel/app.css`], [3, `${R}/panel/index.html`], [5, `${R}/lib/protocol.mjs`], [3, `${R}/lib/targets.mjs`], [2, `${R}/lib/hub/sources/kube.mjs`],
      [4, `${R}/tests/panel.test.mjs`], [2, `${R}/CONTRACT.md`], [1, `${R}/package.json`], [2, `${R}/lib/collector/readers/omp.mjs`], [1, `${R}/lib/collector/readers/base.mjs`]],
    edits: [[10, `${R}/panel/app.js`], [5, `${R}/panel/app.css`], [2, `${R}/panel/index.html`], [3, `${R}/tests/panel.test.mjs`], [1, `${R}/lib/protocol.mjs`]],
    writes: [[1, `${R}/tests/fixtures/panel/snapshot-min.json`], [1, `${R}/panel/fixtures/README.md`]],
    greps: [["buildGraph", `${R}/panel/app.js`], ["crossHost", `${R}/lib`], ["podKeyOfTarget", `${R}/panel`], ["toolCallId", `${R}/lib`], ["pending", `${R}/panel/app.js`], ["--c-spawn", `${R}/panel/app.css`], ["TOOL_CATEGORIES", `${R}/lib/protocol.mjs`]],
    globs: [["**/*.mjs", `${R}/lib`], ["*.test.mjs", `${R}/tests`], ["**/*.css", `${R}/panel`]],
    web: ["https://developer.mozilla.org/en-US/docs/Web/API/EventSource", "https://developer.mozilla.org/en-US/docs/Web/SVG/Element/path"],
    cmds: [
      [5, "node --test tests/panel.test.mjs", { x: `${R}/tests/panel.test.mjs`, dur: [5000, 22000], err: 0.14, errText: "✖ demo fixture: every record is well-formed and cross-referenced (1 failed)" }],
      [2, "node --test tests/", { x: `${R}/tests`, dur: [22000, 64000], err: 0.1, errText: "# tests 41 · # fail 2" }],
      [2, "node --check panel/app.js", { x: `${R}/panel/app.js`, dur: [220, 700] }],
      [3, "git status --short", { dur: [60, 320] }],
      [2, "git diff --stat", { dur: [70, 380] }],
      [1, "git log --oneline -8", { dur: [50, 200] }],
      [2, 'rg -n "buildGraph|rootOf" panel/app.js', { s: `${R}/panel/app.js`, dur: [40, 260] }],
      [2, "sed -n '120,210p' panel/app.js", { r: `${R}/panel/app.js`, dur: [20, 120] }],
      [1, "wc -l panel/app.js panel/app.css lib/*.mjs", { dur: [30, 140] }],
      [1, "npm run build:collector", { dur: [8000, 20000], err: 0.12, errText: 'esbuild: Could not resolve "./redact.mjs"' }],
      [1, "curl -s http://127.0.0.1:7846/api/health", { dur: [90, 600] }],
    ],
  },
  maccordis: {
    cwd: R,
    files: [[8, `${R}/package.json`], [6, `${R}/cordis.patch.yml`], [3, `${R}/panel/app.js`], [6, `${R}/lib/plugin/config.mjs`], [4, `${R}/lib/plugin/embedded.mjs`], [4, `${R}/lib/plugin/hub-client.mjs`], [3, `${R}/lib/plugin/patch-file.mjs`], [2, `${R}/CONTRACT.md`]],
    edits: [[8, `${R}/package.json`], [4, `${R}/cordis.patch.yml`], [3, `${R}/lib/plugin/config.mjs`], [2, `${R}/lib/plugin/embedded.mjs`]],
    writes: [[1, `${R}/tests/plugin-load.test.mjs`]],
    greps: [["exports", `${R}/package.json`], ["inject", `${R}/lib/plugin`], ["client.js", `${R}`], ["dsh-agent-fleet", `${R}/cordis.patch.yml`]],
    globs: [["**/*.mjs", `${R}/lib/plugin`], ["*.js", `${R}`]],
    web: ["https://cordis.io/guide/plugin.html"],
    cmds: [
      [3, "node -e \"import('./index.js').then((m) => console.log(Object.keys(m)))\"", { dur: [300, 900], err: 0.2, errText: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module './client.js'" }],
      [2, "grep -n '\"exports\"' -A8 package.json", { s: `${R}/package.json`, dur: [30, 120] }],
      [2, "cat cordis.patch.yml", { r: `${R}/cordis.patch.yml`, dur: [20, 90] }],
      [2, "tail -n 60 ~/.dsh/logs/plugin-load.log", { r: "/Users/lbc/.dsh/logs/plugin-load.log", dur: [25, 110] }],
      [1, "git diff -- package.json cordis.patch.yml", { dur: [60, 260] }],
      [2, "node --test tests/panel.test.mjs", { x: `${R}/tests/panel.test.mjs`, dur: [5000, 18000], err: 0.1, errText: "✖ panel constants stay in step with lib/protocol.mjs" }],
    ],
  },
  maccollect: {
    cwd: R,
    files: [[7, `${R}/lib/jsonl.mjs`], [6, `${R}/lib/collector/readers/omp.mjs`], [5, `${R}/lib/collector/readers/base.mjs`], [4, `${R}/lib/collector/readers/claude.mjs`], [4, `${R}/tests/jsonl.test.mjs`], [3, `${R}/lib/collector/files.mjs`], [2, `${R}/lib/redact.mjs`], [2, `${R}/CONTRACT.md`]],
    edits: [[7, `${R}/tests/jsonl.test.mjs`], [4, `${R}/tests/readers-omp.test.mjs`], [3, `${R}/lib/jsonl.mjs`], [1, `${R}/lib/collector/readers/omp.mjs`]],
    writes: [[2, `${R}/tests/readers-omp.test.mjs`], [1, `${R}/tests/fixtures/omp/nested-subagent.jsonl`]],
    greps: [["createReader", `${R}/lib/collector/readers`], ["parentSession", `${R}/lib/collector/readers/omp.mjs`], ["zstd", `${R}/lib/jsonl.mjs`], ["takeEvents", `${R}/lib`]],
    globs: [["*.test.mjs", `${R}/tests`], ["*.mjs", `${R}/lib/collector/readers`]],
    web: ["https://nodejs.org/api/test.html"],
    cmds: [
      [5, "node --test tests/jsonl.test.mjs", { x: `${R}/tests/jsonl.test.mjs`, dur: [3500, 14000], err: 0.12, errText: "✖ jsonl: tail reader keeps a partial last line (1 failed)" }],
      [3, "node --test tests/readers-omp.test.mjs", { x: `${R}/tests/readers-omp.test.mjs`, dur: [3500, 16000], err: 0.1, errText: "✖ omp: nested subagent id is <uuid>/<parent>.<name>" }],
      [2, "git status --short", { dur: [60, 300] }],
      [2, 'rg -n "FORK_SLACK_MS|replay" lib/collector/readers/omp.mjs', { s: `${R}/lib/collector/readers/omp.mjs`, dur: [40, 240] }],
      [1, "sed -n '40,110p' lib/collector/readers/omp.mjs", { r: `${R}/lib/collector/readers/omp.mjs`, dur: [20, 110] }],
      [1, "wc -l lib/collector/readers/*.mjs", { dur: [30, 130] }],
    ],
  },
  macobs: {
    cwd: OBS,
    files: [[6, `${OBS}/MOC.md`], [5, `${OBS}/inbox/2026-10-27-fleet-ideas.md`], [4, `${OBS}/inbox/2026-10-28-kube-notes.md`], [4, `${OBS}/projects/agent-fleet.md`], [3, `${OBS}/areas/ml-infra.md`]],
    edits: [[6, `${OBS}/MOC.md`], [4, `${OBS}/projects/agent-fleet.md`], [3, `${OBS}/areas/ml-infra.md`]],
    writes: [[1, `${OBS}/projects/archive/2026-10.md`]],
    greps: [["TODO", `${OBS}/inbox`], ["#fleet", `${OBS}`]],
    globs: [["*.md", `${OBS}/inbox`], ["*.md", `${OBS}/projects`]],
    cmds: [
      [3, "ls inbox | wc -l", { l: `${OBS}/inbox`, dur: [20, 90] }],
      [2, 'rg -l "TODO" inbox', { s: `${OBS}/inbox`, dur: [30, 160] }],
      [2, "git status --short", { dur: [50, 200] }],
      [1, "git add -A && git commit -qm 'notes: archive october inbox'", { dur: [90, 400] }],
    ],
  },
  macwt: {
    cwd: WT,
    files: [[3, `${WT}/worktrees/.gitignore`]],
    edits: [[1, `${WT}/worktrees/.gitignore`]],
    writes: [],
    greps: [["worktree", `${WT}/.git/config`]],
    globs: [["*", `${WT}/worktrees`]],
    cmds: [
      [4, "git worktree list", { dur: [50, 220] }],
      [3, "git branch --merged main | head -20", { dur: [60, 260] }],
      [2, "du -sh worktrees/*", { l: `${WT}/worktrees`, dur: [400, 2600] }],
      [2, "git worktree prune -v", { dur: [60, 300] }],
    ],
  },
  srvops: {
    cwd: V,
    files: [[7, `${V}/lib/hub/sources/kube.mjs`], [4, `${V}/lib/edge.mjs`], [6, `${V}/deploy/systemd/agent-fleet-hub.service`], [3, `${V}/deploy/systemd/agent-fleet-edge.service`], [5, `${V}/deploy/k8s/agent-fleet-test.yaml`],
      [4, `${V}/tests/edge.test.mjs`], [2, `${V}/lib/channel.mjs`], [2, `${V}/CONTRACT.md`]],
    edits: [[6, `${V}/deploy/systemd/agent-fleet-hub.service`], [4, `${V}/deploy/k8s/agent-fleet-test.yaml`], [4, `${V}/tests/edge.test.mjs`], [3, `${V}/lib/edge.mjs`], [2, `${V}/lib/hub/sources/kube.mjs`]],
    writes: [[1, `${V}/tests/fixtures/edge/echo-backend.mjs`], [1, `${V}/deploy/apply.sh`]],
    greps: [["kubectl", `${V}/lib/hub/sources/kube.mjs`], ["Restart=", `${V}/deploy/systemd`], ["x-forwarded", `${V}/lib/edge.mjs`], ["collect", `${V}/deploy/k8s`]],
    globs: [["*.service", `${V}/deploy/systemd`], ["**/*.test.mjs", `${V}/tests`]],
    web: ["https://kubernetes.io/docs/reference/kubectl/generated/kubectl_exec/"],
    cmds: [
      [3, "systemctl --user status agent-fleet-hub --no-pager", { dur: [90, 420], err: 0.1, errText: "Unit agent-fleet-hub.service could not be found." }],
      [2, "journalctl -u agent-fleet-hub -n 60 --no-pager", { dur: [140, 700] }],
      [3, "curl -s http://127.0.0.1:7840/api/health", { dur: [60, 320] }],
      [3, "node --test tests/edge.test.mjs", { x: `${V}/tests/edge.test.mjs`, dur: [4000, 21000], err: 0.12, errText: "✖ edge: websocket upgrade is proxied (EADDRINUSE 127.0.0.1:18443)" }],
      [2, "node bin/agent-fleet.mjs status", { x: `${V}/bin/agent-fleet.mjs`, dur: [300, 1500] }],
      [2, "ss -ltnp | grep -E ':784[01]|:3080'", { dur: [30, 150] }],
      [1, "bash deploy/apply.sh", { x: `${V}/deploy/apply.sh`, dur: [2500, 9000], err: 0.1, errText: "apply.sh: line 14: kubectl: command not found" }],
      [2, "git -C /home/bochao_li/agent-fleet status --short", { dur: [50, 210] }],
      [1, "ls /home/bochao_li/agent-fleet/tmp", { l: `${V}/tmp`, dur: [20, 80] }],
    ],
  },
  srvtrain: {
    cwd: "/home/bochao_li/monitor",
    files: [[6, "/home/bochao_li/monitor/loss_watch.py"], [3, "/home/bochao_li/monitor/alerts.yaml"], [3, "/home/bochao_li/monitor/notes.md"]],
    edits: [[4, "/home/bochao_li/monitor/loss_watch.py"], [2, "/home/bochao_li/monitor/alerts.yaml"]],
    writes: [[1, "/home/bochao_li/monitor/gpu_probe.sh"]],
    greps: [["grad_norm", "/home/bochao_li/monitor"], ["NaN", "/home/bochao_li/monitor/loss_watch.py"]],
    globs: [["*.py", "/home/bochao_li/monitor"]],
    cmds: [
      [3, "python3 loss_watch.py --since 10m --job iron-b300-job-0", { x: "/home/bochao_li/monitor/loss_watch.py", dur: [800, 4200] }],
      [2, "date -u +%FT%TZ", { dur: [10, 40] }],
      [1, "curl -s http://127.0.0.1:9090/api/v1/query?query=dcgm_gpu_utilization | jq '.data.result | length'", { dur: [120, 640] }],
    ],
  },
  sgbench: {
    cwd: BN,
    files: [[7, `${BN}/run_bench.sh`], [5, `${BN}/eval/score.py`], [5, `${BN}/results/results.json`], [3, `${BN}/clean_data.py`], [2, `${BN}/README.md`]],
    edits: [[6, `${BN}/run_bench.sh`], [5, `${BN}/eval/score.py`], [3, `${BN}/clean_data.py`], [1, `${BN}/README.md`]],
    writes: [[1, `${BN}/eval/suites.yaml`], [1, `${BN}/clean/dedup_report.txt`]],
    greps: [["--limit", `${BN}/run_bench.sh`], ["def summarize", `${BN}/eval/score.py`], ["jsonl", `${BN}`]],
    globs: [["*.jsonl", `${BN}/raw`], ["*", `${BN}/results`]],
    cmds: [
      [3, "bash run_bench.sh mmlu-pro", { x: `${BN}/run_bench.sh`, dur: [24000, 78000], err: 0.1, errText: "[bench] endpoint http://10.0.60.98:8000/v1 returned 503" }],
      [2, "python3 eval/score.py --summarize results/mmlu-pro-20261030/raw.jsonl", { x: `${BN}/eval/score.py`, dur: [900, 4200] }],
      [2, "tail -n 30 results/mmlu-pro-20261030/run.log", { r: `${BN}/results/mmlu-pro-20261030/run.log`, dur: [20, 100] }],
      [1, "df -h /data", { dur: [20, 90] }],
      [2, "jq '.[-3:]' results/results.json", { r: `${BN}/results/results.json`, dur: [40, 220] }],
      [2, "python3 clean_data.py raw/pile-0007.jsonl", { x: `${BN}/clean_data.py`, dur: [3000, 16000], err: 0.08, errText: "KeyError: 'text'" }],
    ],
  },
  podtrain: {
    cwd: WS,
    files: [[8, `${WS}/logs/train.log`], [4, `${WS}/configs/train_70b.yaml`], [3, `${WS}/scripts/launch.sh`], [2, `${WS}/scripts/plot_loss.py`]],
    edits: [[3, `${WS}/configs/train_70b.yaml`], [2, `${WS}/scripts/launch.sh`], [2, `${WS}/scripts/plot_loss.py`]],
    writes: [[1, `${WS}/scripts/nccl_env.sh`]],
    greps: [["loss", `${WS}/logs/train.log`], ["NCCL WARN", `${WS}/logs`], ["grad_norm", `${WS}/logs/train.log`]],
    globs: [["*.log", `${WS}/logs`], ["*.yaml", `${WS}/configs`]],
    cmds: [
      [4, "tail -n 200 /workspace/logs/train.log", { r: `${WS}/logs/train.log`, dur: [30, 160] }],
      [3, 'grep -E "loss|grad_norm" /workspace/logs/train.log | tail -n 40', { s: `${WS}/logs/train.log`, dur: [60, 380] }],
      [3, "nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv", { dur: [180, 900] }],
      [2, "python3 scripts/plot_loss.py logs/train.log", { x: `${WS}/scripts/plot_loss.py`, dur: [900, 4800] }],
      [1, "ls -la /workspace/ckpt", { l: `${WS}/ckpt`, dur: [20, 90] }],
    ],
  },
  podvllm: {
    cwd: WS,
    files: [[5, `${WS}/serve.sh`], [4, `${WS}/vllm_args.json`], [5, `${WS}/logs/vllm.log`]],
    edits: [[4, `${WS}/serve.sh`], [3, `${WS}/vllm_args.json`]],
    writes: [],
    greps: [["tensor-parallel", `${WS}/serve.sh`], ["CUDA out of memory", `${WS}/logs/vllm.log`]],
    globs: [["*.json", `${WS}`]],
    cmds: [
      [3, "nvidia-smi", { dur: [200, 900] }],
      [3, "bash serve.sh", { x: `${WS}/serve.sh`, dur: [9000, 38000], err: 0.35, errText: "torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.34 GiB" }],
      [2, "tail -n 80 logs/vllm.log", { r: `${WS}/logs/vllm.log`, dur: [20, 110] }],
      [1, "python3 -c \"import vllm; print(vllm.__version__)\"", { dur: [1800, 4200] }],
    ],
  },
  podiron: {
    cwd: WS,
    files: [[8, `${WS}/pipeline/pipeline.py`], [4, `${WS}/pipeline/shards.py`], [4, `${WS}/tests/test_pipeline.py`], [2, `${WS}/pipeline/README.md`]],
    edits: [[8, `${WS}/pipeline/pipeline.py`], [3, `${WS}/pipeline/shards.py`], [3, `${WS}/tests/test_pipeline.py`]],
    writes: [[1, `${WS}/tests/test_boundary.py`]],
    greps: [["cursor", `${WS}/pipeline`], ["shard_size", `${WS}/pipeline/pipeline.py`]],
    globs: [["*.py", `${WS}/pipeline`]],
    cmds: [
      [4, "pytest -q tests/test_pipeline.py", { x: `${WS}/tests/test_pipeline.py`, dur: [2500, 16000], err: 0.12, errText: "FAILED tests/test_pipeline.py::test_shard_boundary - assert 1023 == 1024" }],
      [2, "python3 -m pipeline.pipeline --shards 4 --dry-run", { dur: [900, 6000] }],
      [2, "git diff --stat", { dur: [50, 200] }],
      [1, "ls -la /workspace/data/shards", { l: `${WS}/data/shards`, dur: [20, 90] }],
    ],
  },
  podeval: {
    cwd: WS,
    files: [[8, `${WS}/ckpt-eval/eval_ckpt.py`], [3, `${WS}/ckpt-eval/ckpt/step_12000/config.json`], [3, `${WS}/ckpt-eval/data/heldout.jsonl`], [3, `${WS}/runs/ckpt-12000/metrics.json`]],
    edits: [[6, `${WS}/ckpt-eval/eval_ckpt.py`], [2, `${WS}/runs/ckpt-12000/metrics.json`]],
    writes: [[1, `${WS}/runs/ckpt-12000/metrics.json`]],
    greps: [["torch_dtype", `${WS}/ckpt-eval`], ["loss", `${WS}/runs`]],
    globs: [["*.safetensors", `${WS}/ckpt-eval/ckpt/step_12000`], ["step_*", `${WS}/ckpt-eval/ckpt`]],
    cmds: [
      [3, "python3 ckpt-eval/eval_ckpt.py --ckpt ckpt-eval/ckpt/step_12000 --limit 64", { x: `${WS}/ckpt-eval/eval_ckpt.py`, dur: [30000, 88000], err: 0.1, errText: "torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB" }],
      [3, "nvidia-smi --query-gpu=utilization.gpu,memory.used,temperature.gpu --format=csv", { dur: [180, 800] }],
      [2, "ls -la ckpt-eval/ckpt", { l: `${WS}/ckpt-eval/ckpt`, dur: [20, 90] }],
      [2, "du -sh ckpt-eval/ckpt/*", { l: `${WS}/ckpt-eval/ckpt`, dur: [200, 1800] }],
      [1, "cat runs/ckpt-12000/metrics.json", { r: `${WS}/runs/ckpt-12000/metrics.json`, dur: [20, 80] }],
    ],
  },
};

// ───────────────────────────────────────────── instantiate agents: ids, transcript paths, pins ─────────────────────────────────────────────
const DENSITY = 0.82;
const slugClaude = (cwd) => cwd.replace(/[/.]/g, "-");
const slugOmp = (cwd) => `--${cwd.replace(/^\//, "").replace(/[/.]/g, "-")}--`;
const toolId = (kind, r) => (kind === "claude" || kind === "omp" ? "toolu_01" + r.b62(22) : "call_" + r.b62(24));
const pad2 = (n) => String(n).padStart(2, "0");

function instantiate() {
  const byTag = new Map(), list = [];
  for (const row of AGENT_ROWS) {
    const a = { ...row, children: [], pins: [] };
    a.rng = makeRng("id/" + row.tag);
    a.site = siteHost(row.host);
    a.home = HOME[row.host];
    a.pool = POOLS[row.prof];
    a.cwd = row.cwd ?? a.pool.cwd;
    a.startAbs = rd(NOW - row.start);
    a.endAbs = row.end !== undefined ? rd(NOW - row.end) : null;
    a.lastAbs = row.last !== undefined ? rd(NOW - row.last) : null;
    a.version = VERSION[row.kind];
    a.provider = PROVIDER[row.kind];
    byTag.set(row.tag, a); list.push(a);
  }
  for (const a of list) {
    const r = a.rng, p = a.parent ? byTag.get(a.parent.tag) : null, d = new Date(a.startAbs);
    a.par = p;
    if (a.kind === "dsh") a.id = a.role === "projection" ? `session-dsh-acp-${r.hex(12)}` : `session-${r.uuid()}`;
    else if (a.kind === "claude") {
      if (a.role === "subagent") { a.agentId = r.hex(8); a.id = `${p.id}/${a.agentId}`; } else a.id = r.uuid();
    } else if (a.kind === "codex") a.id = r.uuid();
    else if (a.role === "subagent") { // omp
      a.rootUuid = p.rootUuid ?? p.id;
      a.stem = p.stem ? `${p.stem}.${a.name}` : a.name;
      a.id = `${a.rootUuid}/${a.stem}`;
    } else { a.id = r.uuid(); a.rootUuid = a.id; }
    a.key = agentKey(a.host, a.kind, a.id);

    const stamp = isoStamp(a.startAbs);
    if (a.kind === "claude") {
      const dir = `${a.home}/.claude/projects/${slugClaude(a.cwd)}`;
      a.file = a.role === "subagent" ? `${dir}/${p.id}/subagents/agent-${a.agentId}.jsonl` : `${dir}/${a.id}.jsonl`;
    } else if (a.kind === "codex") {
      a.file = `${a.home}/.codex/sessions/${d.getUTCFullYear()}/${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())}/rollout-${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}-${pad2(d.getUTCMinutes())}-${pad2(d.getUTCSeconds())}-${a.id}.jsonl`;
    } else if (a.kind === "omp") {
      if (a.role === "subagent") {
        a.sessDir = p.stem ? `${p.sessDir}/${p.stem}` : p.sessDir;
        a.file = `${a.sessDir}/${a.stem}.jsonl`;
      } else {
        a.sessDir = `${a.home}/.omp/agent/sessions/${slugOmp(a.cwd)}/${stamp}_${a.id}`;
        a.file = `${a.sessDir}.jsonl`;
      }
    } else a.file = `${a.home}/.dsh/sessions/${slugOmp(a.cwd)}/${a.id}/session.v4.jsonl.zstd`;
    a.live0 = a.live ?? {};
  }
  // pins: spawn / launch / acp events the parents must contain, at fixed times
  for (const c of list) {
    if (!c.parent) continue;
    const p = byTag.get(c.parent.tag), r = makeRng("pin/" + c.tag), call = c.parent.call;
    p.children.push(c);
    if (call === null) continue;
    const lead = r.int(1100, 3900), t = c.startAbs - lead;
    const acp = typeof call === "string" && call.startsWith("acp-");
    const pin = { kind: acp ? "acp" : call, child: c, t, lead, id: acp ? call : toolId(p.kind, r) };
    if (c.endAbs !== null) pin.dur = c.endAbs - t + r.int(300, 1400);
    p.pins.push(pin);
    c.toolCallId = pin.id;
  }
  for (const a of list) a.pins.sort((x, y) => x.t - y.t);
  return { list, byTag };
}

// ───────────────────────────────────────────── tools: generic draws, scheduled specials, finishing ─────────────────────────────────────────────
const fT = (op, host, path) => ({ type: "file", op, host, path });
const sh = (cmd, o = {}) => ({ act: "bash", cat: o.cat ?? "shell", cmd, targets: o.targets ?? [], dur: o.dur ?? [200, 1500], err: o.err, errText: o.errText, fail: o.fail, exit: o.exit });
const relTo = (cwd, p) => (p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : p);
const LOGN = (r, lo, hi) => Math.round(lo * Math.pow(hi / lo, r.f()));

function genericTool(A, r) {
  const P = A.pool, host = A.host, N = NAMES[A.kind], codex = A.kind === "codex";
  let cls = r.weighted(CLASS_W[A.kind]);
  if (cls === "write" && !P.writes.length) cls = "edit";
  if (cls === "web" && !(P.web && P.web.length)) cls = "read";
  if (cls === "grep" && !P.greps.length) cls = "read";
  if (cls === "glob" && !P.globs.length) cls = "read";
  switch (cls) {
    case "read": {
      const path = r.weighted(P.files);
      return { name: N.read, cat: "read", preview: codex ? relTo(A.cwd, path) : path, targets: [fT("read", host, path)], dur: [14, 240] };
    }
    case "edit": {
      const path = r.weighted(P.edits.length ? P.edits : P.files), add = r.int(2, 41), del = r.int(0, 14);
      return { name: N.edit, cat: "edit", preview: codex ? `apply_patch: update ${relTo(A.cwd, path)} (+${add} −${del})` : `edit ${path} (+${add} −${del})`, targets: [fT("edit", host, path)], dur: [12, 160] };
    }
    case "write": {
      const path = r.weighted(P.writes);
      return { name: N.write, cat: "write", preview: codex ? `apply_patch: add ${relTo(A.cwd, path)}` : path, targets: [fT("write", host, path)], dur: [14, 150] };
    }
    case "grep": {
      const [pat, path] = r.pick(P.greps);
      return { name: N.grep, cat: "search", preview: `${pat} in ${path}`, targets: [fT("search", host, path)], dur: [25, 520] };
    }
    case "glob": {
      const [pat, dir] = r.pick(P.globs);
      return { name: N.glob, cat: "search", preview: `${pat} in ${dir}`, targets: [fT("list", host, dir)], dur: [18, 240] };
    }
    case "web": {
      const url = r.pick(P.web);
      return { name: N.web, cat: "web", preview: url, targets: [{ type: "url", url }], dur: [420, 2900], err: 0.06, errText: "fetch failed: ETIMEDOUT" };
    }
    default: {
      const [, text, o] = r.weighted(P.cmds.map((c) => [c[0], c]));
      const targets = [];
      if (o.x) targets.push(fT("exec", host, o.x));
      if (o.r) targets.push(fT("read", host, o.r));
      if (o.s) targets.push(fT("search", host, o.s));
      if (o.l) targets.push(fT("list", host, o.l));
      return { name: N.bash, cat: "shell", preview: text, targets, dur: o.dur ?? [90, 900], err: o.err, errText: o.errText };
    }
  }
}

/** Descriptor → tool event (or outbound message event). Status/exit code are decided here, once. */
function finishTool(A, d, t, r) {
  const N = NAMES[A.kind];
  if (d.act === "msg") {
    return { id: toolId(A.kind, r), type: "message", t, duration: r.int(40, 260), status: "ok", name: N.msg, category: "coordination", preview: clip(`→ ${d.peer}: ${d.text}`, 160), peer: d.peer, text: clip(d.text, 200) };
  }
  const dur = typeof d.dur === "number" ? d.dur : LOGN(r, d.dur[0], d.dur[1]);
  const failed = Boolean(d.fail) || (d.err ? r.chance(d.err) : false);
  const e = { id: toolId(A.kind, r), type: "tool", t, duration: dur, status: failed ? "error" : "ok", name: d.name ?? N.bash, category: d.cat, preview: clip(d.preview ?? d.cmd, 200) };
  if (d.targets && d.targets.length) e.targets = d.targets.slice(0, LIMITS.maxTargetsPerEvent);
  const shellish = d.cat === "shell" || d.cat === "k8s" || d.cat === "remote";
  if (failed) {
    if (shellish) e.exitCode = d.exit ?? r.pick([1, 1, 1, 2, 127]);
    e.text = clip(d.errText ?? "command failed", 220);
  } else if (shellish && A.kind === "codex") e.exitCode = 0;
  return e;
}

// ───────────────────────────────────────────── scheduled specials (fraction of the agent's span → one tool) ─────────────────────────────────────────────
const POD = (site, name) => podHostId(site, name);
const MSG = (peer, text) => ({ act: "msg", peer, text });
const NOTFOUND = (pod) => `Error from server (NotFound): pods "${pod}" not found`;
const kcp = (site, pod, local, remote) => ({
  act: "bash", cat: "k8s", cmd: `${kb(site)} cp ${local} ${pod}:${remote}`, dur: [900, 3400],
  targets: [podT(site, "cp", pod, CTX[site]), fT("write", POD(site, pod), remote), fT("read", SRV, `${SRV_ROOT}/${local}`)],
});

const SPECIALS = {
  A1a: [
    [0.58, MSG("explorer", "Report only file:line pairs for every parent/child derivation; do not edit anything.")],
    [0.74, sh("git diff --stat", { dur: [60, 300] })],
    [0.93, MSG("worker", "Also cover the cycle-guard case in tests/panel.test.mjs before you run the suite.")],
  ],
  "A1a-1": [[0.4, sh('rg -n "parent\\.key|links" panel/app.js', { targets: [fT("search", MAC, `${MAC_ROOT}/panel/app.js`)], dur: [40, 260] })]],
  A2: [
    [0.30, sh("tail -n 60 ~/.dsh/logs/plugin-load.log", { targets: [fT("read", MAC, "/Users/lbc/.dsh/logs/plugin-load.log")], dur: [25, 110] })],
    [0.52, sh("cat deploy/agent-fleet.env | sed 's/=.*/=…/'", { targets: [fT("read", MAC, `${MAC_ROOT}/deploy/agent-fleet.env`)], dur: [20, 90] })],
  ],
  A3: [[0.5, sh("node --test tests/jsonl.test.mjs", { targets: [fT("exec", MAC, `${MAC_ROOT}/tests/jsonl.test.mjs`)], dur: [3200, 9800], err: 0.5, errText: "✖ jsonl: zstd frame split across reads (1 failed)" })]],
  A5: [
    [0.45, sh("rm -rf /Users/lbc/Desktop/work/TokenRouterNew/worktrees/fleet-spike-2026-10-12", { targets: [fT("delete", MAC, `${WT}/worktrees/fleet-spike-2026-10-12`)], dur: [300, 2400] })],
    [0.70, sh("git worktree remove --force worktrees/old-edge-poc", { targets: [fT("delete", MAC, `${WT}/worktrees/old-edge-poc`)], dur: [300, 1800], err: 0.5, errText: "fatal: 'worktrees/old-edge-poc' is not a working tree" })],
  ],
  B1: [
    [0.10, kget("os")],
    [0.16, kpod("os", "logs", "osmium-train-0", { tail: 50 })],
    [0.21, kpod("os", "exec", "osmium-dev-0", { inner: "ls -la /tmp/agent-fleet", more: [fT("list", POD("os", "osmium-dev-0"), "/tmp/agent-fleet")] })],
    [0.26, kcp("os", "osmium-dev-0", "dist/agent-fleet-collector.mjs", "/tmp/agent-fleet/collector.mjs")],
    [0.31, kget("chengdu", { wide: true })],
    [0.36, kssh("sg-compute", "ls /data/bench", { more: [fT("list", SG, "/data/bench")] })],
    [0.42, kget("iron")],
    [0.50, kpod("os", "get", "osmium-train-0", { wide: true })],
    [0.58, sh("export API_TOKEN=‹redacted› && curl -s -H \"Authorization: Bearer $API_TOKEN\" http://127.0.0.1:7840/api/snapshot | jq '.hosts | length'", { dur: [120, 640] })],
    [0.63, sh("rm -f /home/bochao_li/agent-fleet/tmp/old-run.log", { targets: [fT("delete", SRV, `${SRV_ROOT}/tmp/old-run.log`)], dur: [20, 90] })],
    [0.68, sh("test -s ~/.config/agent-fleet/token && echo token-ok", { targets: [fT("read", SRV, "/home/bochao_li/.config/agent-fleet/token")], dur: [15, 60] })],
    [0.74, kpod("os", "exec", "osmium-train-0", { inner: "nvidia-smi -L" })],
    [0.80, kssh("sg-compute", "tail -n 20 /data/bench/results/results.json", { more: [fT("read", SG, "/data/bench/results/results.json")] })],
    [0.90, MSG("write-edge-tests", "Add a case for the /fleet prefix with a trailing slash; keep the fake backend on 18443.")],
  ],
  B1a: [
    [0.25, kget("os")],
    [0.55, kpod("os", "get", "osmium-dev-0", { json: true })],
    [0.70, kpod("os", "get", "osmium-train-0", { json: true })],
  ],
  B2: [
    [0.20, sh("gh pr view 482 --json title,files,additions,deletions", { dur: [700, 2100] })],
    [0.30, sh("gh pr diff 482 --name-only", { dur: [600, 1800] })],
    [0.55, sh("git diff main...pr-482 -- lib/hub/sources/kube.mjs", { targets: [fT("read", SRV, `${SRV_ROOT}/lib/hub/sources/kube.mjs`)], dur: [60, 360] })],
  ],
  B3a: [
    [0.10, kpod("iron", "logs", "iron-b300-job-0", { tail: 60 })],
    [0.28, kpod("iron", "logs", "iron-b300-job-0", { tail: 60, since: "2m" })],
    [0.46, kpod("iron", "logs", "iron-b300-job-0", { tail: 60, since: "2m", dur: [22000, 38000] })],
    [0.64, kpod("iron", "logs", "iron-b300-job-0", { tail: 60, since: "2m" })],
    [0.78, kget("iron", { wide: true })],
  ],
  B4: [
    [0.55, sh("kubectl --context ulanqab-osmium -n mc-bochao-li apply --dry-run=server -f deploy/k8s/agent-fleet-collector-sts.yaml", { cat: "k8s", dur: [900, 2600], fail: true, errText: "error: error validating \"deploy/k8s/agent-fleet-collector-sts.yaml\": unknown field \"spec.template.spec.containers[0].collect\"", targets: [fT("read", SRV, `${SRV_ROOT}/deploy/k8s/agent-fleet-collector-sts.yaml`), { type: "k8s", op: "apply", site: "os", cluster: "ulanqab-osmium", namespace: NS }] })],
  ],
  S1: [[0.22, sh("df -h /data", { dur: [20, 90] })]],
  D1: [
    [0.08, kget("chengdu")],
    [0.18, kpod("chengdu", "logs", "cd-infer-5d7c9-zz4kd", { tail: 80, dur: [21000, 44000] })],
    [0.30, kpod("chengdu", "exec", "cd-train-worker-1", { inner: "nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv" })],
    [0.44, kpod("chengdu", "logs", "cd-preprocess-8xk2q", { tail: 40, fail: true, errText: NOTFOUND("cd-preprocess-8xk2q"), exit: 1 })],
    [0.58, kpod("chengdu", "logs", "cd-infer-5d7c9-zz4kd", { tail: 80, c: "vllm" })],
    [0.76, kpod("chengdu", "logs", "cd-infer-5d7c9-zz4kd", { tail: 40, since: "5m" })],
  ],
  D1a: [
    [0.20, kpod("chengdu", "describe", "cd-infer-5d7c9-zz4kd")],
    [0.55, kpod("chengdu", "logs", "cd-infer-5d7c9-zz4kd", { tail: 50, c: "vllm" })],
  ],
  D2: [[0.45, kpod("chengdu", "exec", "cd-train-worker-1", { inner: "env | grep NCCL", dur: [500, 1600] })]],
  W1: [
    [0.20, kget("weihai")],
    [0.34, kpod("weihai", "get", "wh-prefill-3", { wide: true })],
    [0.52, kpod("weihai", "describe", "wh-prefill-3")],
    [0.72, kpod("weihai", "get", "wh-prefill-3", { wide: true })],
  ],
  E1: [
    [0.30, kpod("iron", "logs", "iron-b300-job-0", { tail: 200 })],
    [0.62, kpod("iron", "logs", "iron-b300-job-0", { tail: 120, since: "15m" })],
  ],
  C1: [
    [0.12, kpod("os", "get", "osmium-train-0", { wide: true })],
    [0.28, kpod("os", "describe", "osmium-dev-0")],
    [0.40, kpod("os", "logs", "osmium-train-0", { tail: 40 })],
    [0.76, MSG("eval-runner", "Use --limit 64 and print the JSON line only; I will read it from the log.")],
    [0.62, kpod("os", "exec", "osmium-train-0", { inner: "nvidia-smi --query-gpu=utilization.gpu --format=csv" })],
    [0.80, kpod("os", "get", "osmium-dev-0", { wide: true })],
  ],
  C1a: [
    [0.35, sh("file ckpt-eval/ckpt/step_12000/model-00001-of-00004.safetensors", { targets: [fT("read", OSDEV, `${WS}/ckpt-eval/ckpt/step_12000/model-00001-of-00004.safetensors`)], dur: [20, 80] })],
    [0.60, sh("sha256sum ckpt-eval/ckpt/step_12000/model-00001-of-00004.safetensors", { targets: [fT("read", OSDEV, `${WS}/ckpt-eval/ckpt/step_12000/model-00001-of-00004.safetensors`)], dur: [4200, 11000] })],
  ],
  F1: [
    [0.10, kget("os")],
    [0.20, kpod("os", "logs", "osmium-train-0", { tail: 200, since: "10m" })],
    [0.38, kpod("os", "describe", "osmium-debug-0", { fail: true, errText: NOTFOUND("osmium-debug-0"), exit: 1 })],
    [0.55, kpod("os", "logs", "osmium-train-0", { tail: 200, since: "10m", dur: [30000, 76000] })],
    [0.78, kpod("os", "logs", "osmium-train-0", { tail: 100, since: "5m" })],
  ],
};

/** The tool a running agent is in the middle of right now (pend: "tool"). */
const PEND = {
  A1a: sh("node --test tests/panel.test.mjs", { targets: [fT("exec", MAC, `${MAC_ROOT}/tests/panel.test.mjs`)] }),
  B1b: sh("node --test tests/edge.test.mjs", { targets: [fT("exec", SRV, `${SRV_ROOT}/tests/edge.test.mjs`)] }),
  B3a1: kpod("iron", "exec", "iron-b300-job-0", { inner: "nvidia-smi dmon -c 30 -s u" }),
  S1a: sh("bash run_bench.sh ifeval", { targets: [fT("exec", SG, `${BN}/run_bench.sh`)] }),
  C1b: sh("python3 ckpt-eval/eval_ckpt.py --ckpt ckpt-eval/ckpt/step_12000 --limit 64", { targets: [fT("exec", OSDEV, `${WS}/ckpt-eval/eval_ckpt.py`)] }),
  F1: kpod("os", "logs", "osmium-train-0", { tail: 300, since: "10m" }),
};

/** The launching bash event of a cross-host child (pinned at child.start − lead). */
const LAUNCH = {
  S1: { act: "bash", cat: "remote", cmd: "ssh sg-compute 'cd /data/bench && claude -p \"Run the smoke benchmark suite against the staging endpoint and collect results/results.json\" --output-format stream-json' > logs/s1.out 2>&1 &",
    targets: [{ type: "host", op: "ssh", host: "sg-compute", site: "sg-compute" }, { type: "agent", op: "launch", kind: "claude", site: "sg-compute", transport: "cli" }], dur: [900, 1900] },
  C1: { act: "bash", cat: "k8s", cmd: "kubectl --context ulanqab-osmium -n mc-bochao-li exec osmium-dev-0 -- claude -p \"Check GPU health on this pod and run the checkpoint eval at step_12000\" > logs/c1.out 2>&1 &",
    targets: [podT("os", "exec", "osmium-dev-0", CTX.os), { type: "agent", op: "launch", kind: "claude", site: "os", pod: "osmium-dev-0", transport: "cli" }], dur: [900, 1900] },
};

/** Inbound coordination messages: progress notes the child sends while it is alive. */
const CHATTER = {
  A1a: { peer: "worker", n: 3, from: "child", texts: ["Added the cycle-guard case; running the suite now.", "tests/panel.test.mjs: 24 passed, 0 failed.", "Need the new buildTree signature in the helper export list."] },
  B1: { peer: "write-edge-tests", n: 3, from: "child", texts: ["Plan: 5 cases (strip /fleet, strip /dsh, ws upgrade, streaming body, x-forwarded).", "3/5 cases written, fake backend starting on 18443.", "Waiting for the test run to finish."] },
  B3a: { peer: "gpu-util-probe", n: 3, from: "child", texts: ["nvidia-smi dmon attached to iron-b300-job-0.", "avg util 90.6% over 12 samples.", "no thermal throttling reported."] },
  S1: { peer: "benchmark-runner", n: 3, from: "child", texts: ["mmlu-pro 120/200 done.", "mmlu-pro finished, score 0.5612.", "ifeval started, 541 prompts."] },
  C1: { peer: "eval-runner", n: 3, from: "child", texts: ["Loaded step_12000 in 41 s.", "32/64 prompts evaluated.", "Evaluation running; loss so far 1.88."] },
  D1: { peer: "tail-logs", n: 3, from: "child", texts: ["Watching /workspace/logs/train.log.", "Spike at step 5200: loss 3.41 (3.2σ), recovered by 5230.", "No new spikes in the last 200 steps."] },
};

// ───────────────────────────────────────────── timelines ─────────────────────────────────────────────
const TOOLS_PER_STEP = [[45, 1], [30, 2], [15, 3], [7, 4], [3, 5]];
const OPEN = new Set(["running", "waiting", "stale"]);

function mergeIv(list, gap) {
  const out = [];
  for (const iv of list.slice().sort((x, y) => x[0] - y[0])) {
    const last = out.at(-1);
    if (last && iv[0] <= last[1] + gap) last[1] = Math.max(last[1], iv[1]); else out.push([iv[0], iv[1]]);
  }
  return out;
}

/** Turn windows: dense agents get K windows with short user pauses; sparse ones get short bursts separated by long idle gaps. */
function planWindows(A, T0, T1, r, need) {
  if (A.wins) return A.wins.map(([a, b]) => [rd(NOW - a), b === 0 ? T1 : rd(NOW - b)]);
  const K = A.turns, span = T1 - T0;
  if (K <= 1 || span < 4 * M || A.role !== "main") return [[T0, T1]];
  const zones = A.pins.map((p) => [p.t - 25000, (p.dur !== undefined ? p.t + p.dur : T1) + 8000]);
  if (need >= span * 0.75) {
    const prot = zones.map(([a, b]) => [a + 10000, b]);
    const gapMax = Math.min(150000, span / (K * 6));
    const cuts = [];
    let from = T0;
    for (let i = 1; i < K; i++) {
      const centre = T0 + (span * (i + r.rnd(-0.28, 0.28))) / K, gap = r.rnd(gapMax * 0.3, gapMax);
      let e = Math.max(from + 60000, centre - gap / 2), s = e + gap;
      for (let guard = 0; guard < 6; guard++) {
        const hit = prot.find(([za, zb]) => e <= zb && s >= za);
        if (!hit) break;
        e = hit[1] + r.int(500, 2500); s = e + gap;
      }
      if (s > T1 - 90000) break;
      cuts.push([rd(e), rd(s)]); from = s;
    }
    const wins = []; let s = T0;
    for (const [e, ns] of cuts) { wins.push([s, e]); s = ns; }
    wins.push([s, T1]);
    return wins;
  }
  const head = clamp(need / (K + 1), 90000, 20 * M);
  let iv = mergeIv([[T0, T0 + head], [T1 - head, T1], ...zones.map(([a, b]) => [Math.max(T0, a), Math.min(T1, b)])], 90000);
  let total = iv.reduce((n, [a, b]) => n + (b - a), 0);
  const extra = Math.max(0, K - iv.length), per = Math.max(60000, (need - total) / Math.max(1, extra));
  for (let i = 0; i < extra && total < need; i++) {
    for (let tries = 0; tries < 60; tries++) {
      const len = per * r.rnd(0.6, 1.4), a = r.rnd(T0 + head + 90000, T1 - head - 90000 - len), b = a + len;
      if (iv.some(([x, y]) => a <= y + 120000 && b >= x - 120000)) continue;
      iv.push([a, b]); total += len; break;
    }
  }
  return mergeIv(iv, 90000).map(([a, b]) => [rd(a), rd(b)]);
}

/** The pool's longest-running command: what an agent is plausibly waiting on when its timeline ends in a tool. */
function longestCmd(A) {
  const [, text, o] = A.pool.cmds.reduce((best, c) => ((c[2].dur?.[1] ?? 0) > (best[2].dur?.[1] ?? 0) ? c : best));
  const targets = [];
  if (o.x) targets.push(fT("exec", A.host, o.x));
  return { name: NAMES[A.kind].bash, cat: "shell", preview: text, targets, dur: o.dur ?? [1000, 5000] };
}

/** Raw events of one agent (ids of non-tool events are numbered later, usage is added later). */
function genTimeline(A) {
  const r = makeRng("tl/" + A.tag), N = NAMES[A.kind], pace = PACE[A.pace], texts = TXT[A.tag] ?? { u: [], a: [] };
  const open = OPEN.has(A.status);
  const T1 = A.status === "running" ? NOW - r.int(1000, 3000) : A.endAbs ?? A.lastAbs;
  const T0 = A.startAbs;
  const ev = [];
  const stallTarget = A.pace === "slow" ? 14000 : A.pace === "normal" ? 9000 : 5000;
  const nSteps = Math.max(2, (A.n * DENSITY) / 2.9);
  const stepNat = A.pace === "slow" ? 13500 : A.pace === "normal" ? 10000 : 7000;
  const wins = planWindows(A, T0, T1, r, nSteps * (stepNat + stallTarget));
  A.wins2 = wins;
  const pins = A.pins.map((p) => ({ ...p, fired: false }));
  if (A.pend === "tool") pins.push({ kind: "pendtool", t: T1, fired: false });
  pins.sort((x, y) => x.t - y.t);
  const specials = (SPECIALS[A.tag] ?? []).map(([f, d]) => ({ at: T0 + f * (T1 - T0), d, fired: false })).sort((x, y) => x.at - y.at);

  const activeSpan = wins.reduce((n, [a, b]) => n + (b - a), 0);
  const stallMean = Math.max(0, activeSpan / nSteps - stepNat);
  const stall = () => (stallMean > 0 ? Math.min(160000, -Math.log(1 - r.f()) * stallMean) : 0);

  const model = (t, dur, o = {}) => {
    const d = Math.max(300, Math.round(dur));
    const e = { id: "", type: "model", t: Math.round(t), duration: d, ttft: Math.max(220, Math.round(d * r.rnd(0.06, 0.3))), model: A.model };
    if (o.text) e.text = clip(o.text, LIMITS.textChars);
    ev.push(e);
    return e;
  };
  const sayMaybe = () => (r.chance(0.1) ? r.pick(SAY) : undefined);

  /** One model call followed by 1–5 tools, ending at or before `limit`. Returns the time the step ended. */
  function step(cur, limit, o = {}) {
    const room = limit - cur;
    let md = r.rnd(pace.model[0], pace.model[1]);
    let k = r.weighted(TOOLS_PER_STEP);
    if (room < md + 5000) { md = Math.max(900, room * 0.4); k = 1; }
    const m = model(cur, md, { text: sayMaybe() });
    const t0 = m.t + m.duration;
    if (o.fit) {                                    // closing step of an open timeline: one long tool that runs up to `limit`
      const e = finishTool(A, longestCmd(A), t0 + r.int(60, 180), r);
      e.duration = Math.max(40, limit - 150 - e.t);
      ev.push(e);
      return e.t + e.duration;
    }
    const due = specials.find((s) => !s.fired && s.at <= cur);
    const descs = [];
    if (due) { due.fired = true; descs.push(due.d); }
    while (descs.length < k) descs.push(genericTool(A, r));
    const parallel = descs.length > 1 && r.chance(0.5);
    let t = t0 + r.int(40, 180), end = t0;
    const made = [];
    for (const d of descs) {
      const e = finishTool(A, d, t, r);
      made.push(e);
      end = Math.max(end, t + e.duration);
      t = d.act === "msg" ? t + r.int(60, 220) : parallel ? t + r.int(20, 110) : t + e.duration + r.int(60, 380);
    }
    const target = limit - 150;
    if (end > target) {                              // squeeze into [t0, limit − 150]
      const f = Math.max(0.02, (target - t0 - 60) / (end - t0));
      for (const e of made) {
        e.t = Math.round(t0 + (e.t - t0) * f);
        e.duration = Math.max(8, Math.round(e.duration * f));
      }
      end = Math.max(...made.map((e) => e.t + e.duration));
    }
    ev.push(...made);
    return end;
  }

  /** Model call ending exactly at the pin, then the pinned event. Returns the time the step ended. */
  function pinStep(cur, pin) {
    const avail = pin.t - cur;
    const md = Math.max(300, Math.min(r.rnd(pace.model[0], pace.model[1]), avail - 40));
    model(pin.t - md, md, { text: sayMaybe() });
    if (pin.kind === "pendtool") {
      const e = finishTool(A, PEND[A.tag] ?? genericTool(A, r), pin.t, r);
      e.status = "pending"; delete e.duration; delete e.exitCode; delete e.text;
      ev.push(e);
      return pin.t;
    }
    const c = pin.child, child = { kind: c.kind, id: c.id, name: c.name ?? (c.kind === "codex" ? "codex-acp" : "omp-acp"), key: c.key };
    if (pin.kind === "launch") {
      const e = finishTool(A, LAUNCH[c.tag], pin.t, r);
      e.id = pin.id;
      ev.push(e);
      return pin.t + e.duration;
    }
    const e = { id: pin.id, type: "spawn", t: pin.t, name: pin.kind === "acp" ? "acp.prompt" : N.spawn, category: "spawn", child };
    e.preview = pin.kind === "acp" ? `acp.prompt ${child.name}: ${clip(c.title, 90)}` : `${c.name}: ${clip(c.desc ?? c.title, 120)}`;
    if (pin.dur !== undefined) { e.status = "ok"; e.duration = pin.dur; }
    else if (A.kind === "codex") e.status = "ok";                  // spawn_agent returns at once; the child keeps running
    else e.status = "pending";
    ev.push(e);
    return pin.t + 200;
  }

  wins.forEach(([s, e], wi) => {
    const closed = wi < wins.length - 1 || !open;
    ev.push({ id: "", type: "user", t: s, text: clip(texts.u[wi] ?? (wi === 0 ? A.title : r.pick(FOLLOW)), LIMITS.textChars) });
    const turn = { id: "", type: "turn", t: s };
    ev.push(turn);
    const errorEnd = closed && A.errorEnd && wi === wins.length - 1;
    const finalDur = closed && !errorEnd ? r.int(2200, 7500) : 0;
    const loopEnd = closed ? e - finalDur - 200 : A.wait ? e - 5600 : e;
    let cur = s + r.int(400, 1500), guard = 0;
    while (cur < loopEnd - 2500 && guard++ < 2000) {
      const pin = pins.find((p) => !p.fired && p.t >= cur - 1500 && p.t < loopEnd + 1);
      if (pin && pin.t - cur < 15000) {
        pin.fired = true;
        cur = pinStep(cur, pin) + r.int(60, 400);
        if (pin.kind === "pendtool" || (A.quiet && pin.kind === "acp")) break;
        continue;
      }
      const limit = pin ? pin.t - 11000 : loopEnd;
      const fit = !pin && open && !A.wait && wi === wins.length - 1 && loopEnd - cur < 42000;
      const end = step(cur, limit, fit ? { fit: true } : {});
      if (fit) { cur = end; break; }
      cur = Math.min(end + r.int(pace.gap[0], pace.gap[1]) + stall(), pin ? pin.t - 10500 : loopEnd - 2400);
    }
    if (errorEnd) { turn.status = "error"; turn.duration = e - s; }
    else if (closed) {
      const start = Math.min(e - 600, Math.max(cur, e - finalDur));
      model(start, e - start, { text: texts.a[wi] ?? (r.chance(0.5) ? "完成，结果已写入上面的文件。" : "Done — details are in the files above.") });
      turn.status = "ok"; turn.duration = e - s;
    } else if (A.wait) {                              // blocked on the user: the model asked a question, nothing is running
      const start = e - r.int(3200, 5200);
      model(start, e - start, { text: A.waitText });
    }
  });
  for (const p of pins) if (!p.fired) throw new Error(`pin ${p.kind} of ${A.tag} did not fire (t = NOW − ${((NOW - p.t) / M).toFixed(1)} min)`);
  (A.steer ?? []).forEach((f, i) => ev.push({ id: "", type: "user", t: rd(T0 + f * (T1 - T0)), text: clip(texts.s?.[i] ?? r.pick(FOLLOW), LIMITS.textChars) }));
  A.leftover = specials.filter((s) => !s.fired).map((s) => s.d.cmd ?? s.d.text);
  A.T1 = T1;
  return ev;
}

// ───────────────────────────────────────────── post-processing: errors, messages, mirror, ids, usage ─────────────────────────────────────────────
const ERRORS = {
  A1a: [[0.40, "429 rate_limit_exceeded: retrying in 8s (attempt 2/5)"]],
  S1a: [[0.65, "stream disconnected before completion: ECONNRESET (retrying)"]],
  D1: [[0.50, "request timed out after 60000 ms; retrying (1/3)"]],
  W1: [[0.60, "ECONNRESET while streaming the response"]],
  C1b: [[0.45, "API error 529 overloaded_error: retrying in 4s"]],
  F1: [[0.35, "request timed out after 60000 ms; retrying (1/3)"]],
  B4: [[1.0, "stream error: unexpected status 429 Too Many Requests: retries exhausted (5/5)"]],
};

function insertErrors(A, ev) {
  for (const [f, text] of ERRORS[A.tag] ?? []) {
    let t;
    if (A.errorEnd && f >= 1) t = A.T1 - 400;
    else {
      const at = A.startAbs + f * (A.T1 - A.startAbs);
      const m = ev.find((e) => e.type === "model" && e.t >= at);
      t = (m ? m.t : at) - 30;
    }
    ev.push({ id: "", type: "error", t: Math.round(t), text: clip(text, LIMITS.textChars) });
  }
}

/** An inbound message only lands while the agent has a turn open: snap it into the nearest window. */
function snapIn(A, t) {
  let best = A.wins2[0][0] + 500;
  for (const [a, b] of A.wins2) {
    if (t >= a && t <= b) return t;
    if (b <= t) best = b - 500;
  }
  return best;
}

function addChatter(A, ev) {
  const spec = CHATTER[A.tag];
  if (!spec) return;
  const r = makeRng("chat/" + A.tag);
  const child = A.children.find((c) => c.name === spec.peer) ?? A.children[0];
  const a = child.startAbs + 3000, b = Math.min(NOW - 1500, (child.endAbs ?? A.T1) - 1500);
  const ts = Array.from({ length: spec.n }, () => r.rnd(a, b)).sort((x, y) => x - y);
  ts.forEach((t, i) => ev.push({ id: "", type: "message", t: Math.round(snapIn(A, t)), peer: spec.peer, text: clip(spec.texts[i % spec.texts.length], LIMITS.textChars) }));
}

/** DSH relays the ACP agent's activity as messages: one per finished tool call (about nine in ten). */
const RELAY = { A1: "A1a", B3: "B3a" };
const relayText = (e) => (e.category === "edit" || e.category === "write" ? `edited: ${e.preview}` : e.category === "read" ? `read: ${e.preview}` : e.category === "spawn" ? `spawned: ${e.preview}` : `ran: ${e.preview}`);
function addRelay(A, ev, child, childEv) {
  const r = makeRng("relay/" + A.tag), peer = child.kind === "codex" ? "codex-acp" : "omp-acp";
  const cand = childEv.filter((e) => (e.type === "tool" || e.type === "spawn") && e.t > child.startAbs + 4000);
  cand.forEach((e, i) => {
    if (i < cand.length - 1 && !r.chance(0.62)) return;
    const pend = e.status === "pending";
    const t = Math.min(NOW - 300, pend ? e.t + r.int(300, 900) : e.t + (e.duration ?? 0) + r.int(250, 1200));
    ev.push({ id: "", type: "message", t, peer, text: clip(pend ? `running: ${e.preview}` : relayText(e), 200) });
  });
}

/** P1: DSH's mirror of the explorer subagent, same shape shifted by the start offset, with DSH tool names. */
function mirrorOf(P, src, srcEv) {
  const r = makeRng("mirror/" + P.tag), shift = P.startAbs - src.startAbs, names = { read_file: "Read", shell: "Bash", apply_patch: "Edit" };
  return srcEv.filter((e) => e.type !== "spawn" && e.type !== "message" && e.type !== "error").map((e) => {
    const c = JSON.parse(JSON.stringify(e));
    c.t += shift;
    if (c.type === "tool") { c.id = toolId("dsh", r); c.name = names[c.name] ?? c.name; }
    else c.id = "";
    if (c.type === "model") { c.model = P.model; delete c.usage; }
    return c;
  });
}

const fmtK = (n) => (n >= 1000 ? Math.round(n / 1000) + "k" : String(n));
function finalize(A, ev) {
  if (A.compact) {
    const models = ev.filter((e) => e.type === "model"), at = models[Math.floor(models.length * A.compact)];
    ev.push({ id: "", type: "compaction", t: at.t - 1, text: "" });
  }
  ev.sort((x, y) => x.t - y.t);
  const seq = { user: 0, model: 0, message: 0, compaction: 0, error: 0, turn: 0 };
  for (const e of ev) if (e.id === "") e.id = `${e.type}:${++seq[e.type]}`;
  const r = makeRng("use/" + A.tag), win = WINDOW[A.model] ?? 200000, like = A.kind === "claude" || A.kind === "omp";
  const tot = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  let ctx = 0, prevOut = 0, calls = 0, lastCtx = 0, fresh = true;
  for (const e of ev) {
    if (e.type === "tool" || e.type === "spawn" || (e.type === "message" && e.name)) calls++;
    if (e.type === "compaction") { e.text = `Context compacted: ${fmtK(ctx)} → ~22k tokens (auto)`; ctx = 0; fresh = true; continue; }
    if (e.type !== "model") continue;
    const growth = A.ctxGrowth ?? (like ? 1500 : 1900);
    const delta = fresh ? (ctx === 0 && lastCtx === 0 ? r.int(11000, 15500) : 22000) : Math.round(prevOut + calls * r.rnd(0.25, 1.0) * growth);
    const outTok = Math.max(14, Math.round((e.duration / 1000) * r.rnd(34, 66)));
    const u = like ? { input: r.int(2, 48), output: outTok, cacheRead: ctx, cacheWrite: delta } : { input: delta, output: outTok, cacheRead: ctx };
    if (A.kind === "codex") u.reasoning = Math.round(outTok * r.rnd(0.15, 0.55));
    for (const k of Object.keys(u)) { if (u[k] === 0) delete u[k]; else tot[k] += u[k]; }
    if (!A.noUsage) e.usage = u;
    lastCtx = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
    ctx += delta; prevOut = outTok; calls = 0; fresh = false;
  }
  const p = PRICE[A.model] ?? [3, 15, 0.3, 3.75];
  A.usage = A.noUsage
    ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
    : {
      input: tot.input, output: tot.output, cacheRead: tot.cacheRead, cacheWrite: tot.cacheWrite, reasoning: tot.reasoning,
      cost: Math.round(((tot.input * p[0] + tot.output * p[1] + tot.cacheRead * p[2] + tot.cacheWrite * p[3]) / 1e6) * 10000) / 10000,
      contextTokens: lastCtx, contextWindow: win,
    };
  return ev;
}

// ───────────────────────────────────────────── assembly ─────────────────────────────────────────────
const EVENT_ORDER = ["id", "type", "t", "duration", "status", "name", "category", "preview", "targets", "exitCode", "model", "usage", "ttft", "child", "peer", "text"];
function ordered(e) {
  const o = {};
  for (const k of EVENT_ORDER) if (e[k] !== undefined) o[k] = e[k];
  for (const k of Object.keys(e)) if (!(k in o) && e[k] !== undefined) throw new Error(`unknown event field ${k} on ${e.id}`);
  return o;
}

function pidOf(A) {
  if (A.live0.pid !== undefined) return A.live0.pid;
  if (A.role === "main" || !A.par || A.par.host !== A.host || A.kind !== A.par.kind) return makeRng("pid/" + A.tag).int(1800, A.host.startsWith("k8s/") ? 9000 : 61000);
  return pidOf(A.par);                               // in-process subagents share the parent's process
}

function parentHint(A) {
  const spec = A.parent;
  if (!spec || spec.hint === false) return null;     // S1: the hub linked it from the launching command alone
  const P = A.par, same = P.host === A.host;
  return {
    ...(same && { key: P.key }), kind: P.kind, id: P.id, ...(same && spec.via === "file" && { file: P.file }),
    via: spec.via, exact: spec.exact, ...(A.toolCallId && { toolCallId: A.toolCallId }),
  };
}

function statusLive(A, events, updatedAt) {
  const pend = events.find((e) => e.status === "pending");
  const lastEnd = events.reduce((m, e) => Math.max(m, e.t + (e.duration ?? 0)), 0);
  switch (A.status) {
    case "running": {
      const alive = { alive: true, pid: pidOf(A) };
      return pend
        ? { ...alive, state: "tool", since: pend.t, doing: pend.preview, turnOpen: true }
        : { ...alive, state: "model", since: Math.min(NOW - 500, lastEnd), doing: "thinking", turnOpen: true };
    }
    case "waiting": {
      const q = events.filter((e) => e.type === "model").at(-1);
      return { alive: true, pid: pidOf(A), state: "waiting", since: q.t, doing: "waiting for user", turnOpen: true };
    }
    case "idle": return { alive: true, pid: pidOf(A), state: "idle", since: updatedAt, doing: "", turnOpen: false };
    case "stale": return { alive: A.live0.alive ?? false, state: "model", since: updatedAt, doing: "thinking", turnOpen: true };
    default: return { alive: false, state: "ended", since: A.endAbs ?? updatedAt, doing: "", turnOpen: false };
  }
}

function buildRecord(A, byTag) {
  const events = A.events;
  const lastEnd = Math.min(NOW, events.reduce((m, e) => Math.max(m, e.t + (e.duration ?? 0)), 0));
  const updatedAt = A.endAbs !== null ? Math.min(lastEnd, A.endAbs) : lastEnd;
  const isTool = (e) => e.type === "tool" || e.type === "spawn" || (e.type === "message" && e.name);
  const counts = {
    turns: events.filter((e) => e.type === "turn").length,
    tools: events.filter(isTool).length,
    errors: events.filter((e) => e.type === "error" || (isTool(e) && e.status === "error")).length,
    subagents: A.children.length,
    events: events.length,
  };
  const acpChild = A.acp ? byTag.get(A.acp.tag) : null;
  return {
    key: A.key, host: A.host, site: A.site, kind: A.kind, id: A.id, file: A.file, cwd: A.cwd, title: A.title,
    model: A.model, provider: A.provider, effort: A.effort, role: A.role,
    ...(A.name && { name: A.name }), ...(A.desc && { description: A.desc }),
    parent: parentHint(A),
    startedAt: A.startAbs, updatedAt, endedAt: A.endAbs !== null && A.status !== "stale" ? A.endAbs : null, status: A.status,
    live: statusLive(A, events, updatedAt),
    usage: A.usage, counts,
    ...(acpChild && { acp: { provider: A.acp.provider, kind: acpChild.kind, id: acpChild.id } }),
    version: A.version,
  };
}

export function buildDemo() {
  const { list, byTag } = instantiate();
  for (const A of list) if (A.tag !== "P1") A.ev = genTimeline(A);
  for (const A of list) if (A.tag !== "P1") insertErrors(A, A.ev);
  for (const A of list) if (A.tag !== "P1") addChatter(A, A.ev);
  for (const [tag, childTag] of Object.entries(RELAY)) addRelay(byTag.get(tag), byTag.get(tag).ev, byTag.get(childTag), byTag.get(childTag).ev);
  const P1 = byTag.get("P1");
  P1.ev = mirrorOf(P1, byTag.get("A1a-1"), byTag.get("A1a-1").ev);
  P1.T1 = P1.endAbs;
  for (const A of list) A.events = finalize(A, A.ev).map(ordered);

  const agents = list.map((A) => buildRecord(A, byTag));
  const links = list.filter((A) => A.parent).map((A) => {
    const P = A.par;
    return { from: P.key, to: A.key, via: A.parent.via, exact: A.parent.exact, ...(A.toolCallId && { toolCallId: A.toolCallId }), crossHost: P.host !== A.host, crossSite: P.site !== A.site };
  });

  const feedAll = [];
  list.forEach((A) => A.events.forEach((event, i) => { if (event.type === "tool" || event.type === "spawn" || event.type === "error") feedAll.push({ agent: A.key, event, i }); }));
  feedAll.sort((x, y) => x.event.t - y.event.t);
  const feed = feedAll.slice(-LIMITS.feedItems).map(({ agent, event }) => ({ agent, event }));

  const events = Object.fromEntries(list.map((A) => [A.key, A.events]));
  const snapshot = {
    cursor: 4182, now: NOW,
    hub: { version: "0.1.0", startedAt: NOW - 6 * H, hostId: SRV },
    hosts: buildHosts(agents), agents, links, pods: buildPods(), feed,
  };
  return { meta: { now: NOW, note: "synthetic" }, snapshot, events, files: buildFiles(), podEvents: buildPodEvents(), _list: list };
}

function serialize(demo) {
  const j = (v) => JSON.stringify(v);
  const keys = Object.keys(demo.events);
  const lines = ["{", `"meta":${j(demo.meta)},`, `"snapshot":${j(demo.snapshot)},`, '"events":{'];
  keys.forEach((k, i) => lines.push(`${j(k)}:${j(demo.events[k])}${i < keys.length - 1 ? "," : ""}`));
  lines.push("},", `"files":${j(demo.files)},`, `"podEvents":${j(demo.podEvents)}`, "}");
  return lines.join("\n") + "\n";
}

function summary(demo, bytes) {
  const { agents, hosts, pods, links, feed } = demo.snapshot;
  const tally = (f) => { const m = {}; for (const a of agents) m[f(a)] = (m[f(a)] ?? 0) + 1; return Object.entries(m).map(([k, v]) => `${k}=${v}`).join(" "); };
  const evs = Object.values(demo.events), total = evs.reduce((n, l) => n + l.length, 0);
  const tools = evs.flat().filter((e) => e.type === "tool" || e.type === "spawn");
  const failed = tools.filter((e) => e.status === "error").length;
  return [
    `agents ${agents.length} | kind: ${tally((a) => a.kind)}`,
    `site: ${tally((a) => a.site)}`,
    `status: ${tally((a) => a.status)} | role: ${tally((a) => a.role)}`,
    `hosts ${hosts.length} | pods ${pods.length} | links ${links.length} | feed ${feed.length} | files ${Object.keys(demo.files).length} | podEvents ${Object.keys(demo.podEvents).length}`,
    `events ${total} (tools+spawns ${tools.length}, failed ${failed}) | demo.json ${bytes} bytes (${(bytes / 1024).toFixed(1)} KiB)`,
  ].join("\n");
}

function main() {
  const args = process.argv.slice(2), at = args.indexOf("--out");
  const demo = buildDemo(), listing = demo._list;
  delete demo._list;
  const text = serialize(demo), bytes = Buffer.byteLength(text);
  const toFile = at >= 0 ? resolve(args[at + 1]) : process.stdout.isTTY ? resolve(dirname(fileURLToPath(import.meta.url)), "demo.json") : null;
  if (toFile) { writeFileSync(toFile, text); process.stderr.write(`wrote ${toFile}\n`); } else process.stdout.write(text);
  process.stderr.write(summary(demo, bytes) + "\n");
  if (args.includes("--debug")) for (const A of listing) if (A.leftover?.length) process.stderr.write(`unfired specials ${A.tag}: ${A.leftover.join(" | ")}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
