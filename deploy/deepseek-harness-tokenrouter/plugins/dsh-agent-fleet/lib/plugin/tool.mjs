// The `agent_fleet` model tool: read-only questions about the fleet, answered from the hub (see hub-client.mjs).
// Every action returns {action, summary, data}: `data` is compact JSON capped near OUTPUT_CAP_BYTES (lists end with a
// `more` count; the builders shrink their row counts until it fits) and the model sees `summary` + data as text.
import { AGENT_KINDS, ROLES, SITES, STATUSES, TARGET_TYPES, TOOL_CATEGORIES, parseAgentKey } from "../protocol.mjs";
import { abortable } from "./hub-client.mjs";
import { buildChildren, buildParents, findAgent, resolveFamily, subtree } from "./graph.mjs";

export const TOOL_NAME = "agent_fleet";
export const ACTIONS = Object.freeze(["overview", "list", "family", "agent", "pods", "pod", "files", "file", "query"]);
export const OUTPUT_CAP_BYTES = 12_000;

const SCALES = [1, 0.6, 0.35, 0.2, 0.1, 0.05];
const MAX_ROWS = 200;
const UNIT_MS = { s: 1000, sec: 1000, m: 60_000, min: 60_000, h: 3_600_000, hr: 3_600_000, d: 86_400_000, w: 604_800_000 };
const STATUS_RANK = Object.fromEntries(["running", "waiting", "idle", "stale", "error", "interrupted", "done", "unknown"].map((status, index) => [status, index]));

const DESCRIPTION = `Look up the live state of the coding agents running on the user's machines and Kubernetes clusters: DeepSeek Harness ("dsh"), Claude Code ("claude"), Codex ("codex") and Oh My Pi ("omp") sessions, their subagents, the agents they started on other hosts or pods, and the pods and files those agents touched. Read-only; data is a few seconds old. Use it to answer what is running where, which agent spawned or owns something, what an agent is doing or did, and who touched a pod or file. Start with action "overview" or "list", then drill down with "family", "agent", "pod", "files", "file" or "query".
Agent keys look like \`<host>#<kind>:<id>\`, e.g. \`server-bochao-01#omp:01a18adc-49ee-7345-8b51-9e75b06a2614\` (host: mac, server-bochao-01, sg-compute, or k8s/<site>/<pod>). Copy keys verbatim from earlier results; wherever a key is expected, a bare session id or \`<kind>:<id>\` also works. Pod keys look like \`chengdu/mc-bochao-li/<pod name>\`. Sites: ${SITES.join(", ")}. Times are UTC.
Results are one summary line followed by compact JSON, capped near 12 KB; lists end with a \`more\` count, so narrow the filters (site, kind, status, text, since) instead of asking for more rows. Event fields: at, name (tool), cat (category), status (omitted when ok), ms, preview, targets ("file:read:<host>:<path>", "pod:exec:<site>/<ns>/<pod>", ...).`;

const ACTION_HELP = `What to do. overview: hosts × agent kinds with running counts, host connection state, pods, cross-host links (no other arguments). list: agents, running first then newest activity; filters site, host, kind, status, role, text, since. family: the whole tree an agent belongs to (root, subagents, ACP children, agents it started on other hosts/pods) with each member's latest events; needs key. agent: one agent's record and recent events; needs key, optional limit and before to page back. pods: pods agents touched or that host a collector; filters site, text. pod: one pod's containers, the agent calls that touched it and its kube events; needs pod. files: files read/written/edited per file, for one agent (key) or all agents; filters host, text, since. file: preview of one file on a host (redacted; secrets refused); needs host and path, offset pages long files. query: search tool calls fleet-wide; filters kind, site, host, category, target, text, since.`;

const PARAMETERS = {
  action: { type: "string", required: true, enum: [...ACTIONS], description: ACTION_HELP },
  key: { type: "string", description: "Agent for family/agent/files: full key `<host>#<kind>:<id>`, `<kind>:<id>`, or a bare session id (a DSH session id or the native Claude/Codex/OMP session id)." },
  pod: { type: "string", description: "Pod for action pod: key `<site>/mc-bochao-li/<name>`, or just the pod name (add site when several clusters have it)." },
  site: { type: "string", description: `Site filter: ${SITES.join(", ")}.` },
  host: { type: "string", description: "Host id: mac, server-bochao-01, sg-compute or k8s/<site>/<pod>. Filter for list/files/query; the machine holding the file for action file." },
  kind: { type: "string", enum: [...AGENT_KINDS], description: "Agent kind filter." },
  status: { type: "string", enum: [...STATUSES], description: "Agent status filter (running = a turn is open; waiting = blocked on the user)." },
  role: { type: "string", enum: [...ROLES], description: "Agent role filter. projection (DSH's mirror of an ACP agent's subagent) is hidden from list unless asked for." },
  category: { type: "string", enum: [...TOOL_CATEGORIES], description: "Tool-call category filter for query." },
  target: { type: "string", enum: [...TARGET_TYPES], description: "For query: only calls that touched this kind of target." },
  text: { type: "string", description: "Case-insensitive substring: titles, models, cwd, activity for list; paths for files; previews for query; names for pods." },
  since: { type: "string", description: "Only activity at or after this time: a relative age like 15m, 2h, 1d, or an ISO-8601 timestamp." },
  before: { type: "string", description: "For agent: only events before this time (use `pageBefore` of the previous result to page back)." },
  path: { type: "string", description: "Absolute file path for action file." },
  offset: { type: "integer", description: "For file: character offset into the content to start at (default 0)." },
  limit: { type: "integer", description: "Maximum rows to list (default depends on the action, at most 200); the output is still capped near 12 KB." },
};

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", required: true },
    summary: { type: "string", required: true },
    data: { type: "json", required: true },
  },
};

/* ───────────────────────────── small helpers ───────────────────────────── */

const bytes = value => Buffer.byteLength(JSON.stringify(value));
const isRunning = agent => agent.status === "running";

export function clip(value, max) {
  if (typeof value !== "string") return undefined;
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat === "") return undefined;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const tailOf = (value, max) => typeof value === "string" && value.length > max ? `…${value.slice(-(max - 1))}` : value;
export const iso = time => Number.isFinite(time) ? new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z") : undefined;

export function ago(time, now) {
  if (!Number.isFinite(time)) return undefined;
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/** "15m" / "2h ago" / ISO-8601 / epoch seconds or milliseconds → epoch ms. */
export function parseWhen(value, now) {
  if (value === undefined || value === null || value === "") return undefined;
  const text = String(value).trim();
  const relative = /^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr|d|w)(?:\s+ago)?$/i.exec(text);
  if (relative !== null) return now - Number(relative[1]) * UNIT_MS[relative[2].toLowerCase()];
  if (/^\d{13}$/.test(text)) return Number(text);
  if (/^\d{10}$/.test(text)) return Number(text) * 1000;
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) return parsed;
  throw new Error(`cannot parse time ${JSON.stringify(text)}; use a relative age like 15m, 2h, 1d or an ISO-8601 timestamp`);
}

const count = (value, fallback) => Math.min(MAX_ROWS, Math.max(1, Number.isFinite(value) ? Math.trunc(value) : fallback));
const rows = (base, scale) => Math.max(1, Math.floor(base * scale));
const countBy = (items, by) => { const out = {}; for (const item of items) { const key = by(item) ?? "unknown"; out[key] = (out[key] ?? 0) + 1; } return out; };
const groupBy = (items, by) => { const out = new Map(); for (const item of items) { const key = by(item); (out.get(key) ?? out.set(key, []).get(key)).push(item); } return out; };

function need(args, name, action) {
  const value = args[name];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`action ${action} needs ${name}`);
  return value.trim();
}

function notFound(ref) {
  return new Error(`no agent matches ${JSON.stringify(ref)}; use action "list" (filter with text) to find agent keys`);
}

/** One hub request bound to the call's cancellation. */
const ask = (env, method, params) => abortable(env.hub.request(method, params, { signal: env.signal }), env.signal);

/** Run `build(scale)` with shrinking row counts until summary + data fit OUTPUT_CAP_BYTES. */
function fit(build) {
  let built;
  for (const scale of SCALES) {
    built = build(scale);
    if (Buffer.byteLength(built.summary) + 1 + bytes(built.data) <= OUTPUT_CAP_BYTES) return built;
  }
  return { summary: `${built.summary.slice(0, 400)} The result is still too large to show; narrow the request.`, data: { truncated: true } };
}

export function targetText(target) {
  const where = target.site ?? target.cluster ?? "?";
  switch (target.type) {
    case "file": return clip(`file:${target.op ?? "?"}:${target.host ? `${target.host}:` : ""}${target.path ?? "?"}`, 160);
    case "pod": return clip(`pod:${target.op ?? "?"}:${where}/${target.namespace ?? ""}/${target.name ?? "?"}${target.container ? `#${target.container}` : ""}`, 160);
    case "k8s": return clip(`k8s:${target.op ?? "?"}:${where}:${target.resource ?? ""}/${target.name ?? ""}`, 160);
    case "host": return clip(`host:${target.op ?? "ssh"}:${target.host ?? "?"}${target.site ? `(${target.site})` : ""}`, 160);
    case "url": return clip(`url:${target.url ?? "?"}`, 160);
    case "agent": return clip(`agent:launch:${target.kind ?? "?"}${target.pod ? `@${target.site ?? "?"}/${target.pod}` : target.site ? `@${target.site}` : ""}`, 160);
    default: return clip(`${target.type}:${target.op ?? ""}`, 160);
  }
}

function eventRow(event, { preview = 100, targets = 3 } = {}) {
  const shown = (event.targets ?? []).slice(0, targets).map(targetText);
  return {
    at: iso(event.t),
    type: event.type === "tool" ? undefined : event.type,
    name: event.name,
    cat: event.category,
    status: event.status === "ok" ? undefined : event.status,
    ms: Number.isFinite(event.duration) ? Math.round(event.duration) : undefined,
    preview: clip(event.preview ?? event.text, preview),
    targets: shown.length > 0 ? shown : undefined,
    more: (event.targets ?? []).length > targets ? (event.targets.length - targets) : undefined,
  };
}

function agentRow(agent, env, parents) {
  const up = parents?.get(agent.key);
  return {
    key: agent.key,
    kind: agent.kind,
    role: agent.role,
    status: agent.status,
    title: clip(agent.title || agent.name || agent.description, 70),
    model: agent.model || undefined,
    doing: clip(agent.live?.doing, 70),
    cwd: tailOf(agent.cwd, 40),
    parent: up?.from,
    via: up !== undefined && up.link?.via !== "file" ? up.link?.via : undefined,
    ago: ago(agent.updatedAt, env.now),
  };
}

/* ───────────────────────────── actions ───────────────────────────── */

async function overview(args, env) {
  const snap = await env.snapshot();
  const agents = (snap.agents ?? []).filter(agent => agent.role !== "projection");
  const hosts = snap.hosts ?? [];
  const pods = snap.pods ?? [];
  const byHost = groupBy(agents, agent => agent.host);
  const hostRows = hosts.map(host => {
    const mine = byHost.get(host.id) ?? [];
    const row = { id: host.id, site: host.site, status: host.status, via: host.via, lag: Number.isFinite(host.lagMs) ? `${(host.lagMs / 1000).toFixed(1)}s` : undefined, error: clip(host.error, 80) };
    for (const kind of AGENT_KINDS) {
      const ofKind = mine.filter(agent => agent.kind === kind);
      if (ofKind.length > 0) row[kind] = `${ofKind.filter(isRunning).length}/${ofKind.length}`;
    }
    return { row, attention: host.status !== "online" ? 1 : 0, running: mine.filter(isRunning).length };
  }).sort((a, b) => (b.attention - a.attention) || (b.running - a.running) || (a.row.id < b.row.id ? -1 : 1));
  const siteRows = [...groupBy(hosts, host => host.site ?? "?")].map(([site, list]) => {
    const mine = list.flatMap(host => byHost.get(host.id) ?? []);
    return { site, hosts: list.length, notOnline: list.filter(host => host.status !== "online").length || undefined, agents: mine.length, running: mine.filter(isRunning).length };
  }).sort((a, b) => (b.running - a.running) || (a.site < b.site ? -1 : 1));
  const running = agents.filter(isRunning).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const links = snap.links ?? [];
  const notOnline = hosts.filter(host => host.status !== "online").length;
  return fit(scale => {
    const shownHosts = hostRows.slice(0, rows(30, scale)), shownRunning = running.slice(0, rows(8, scale));
    return {
      summary: `Fleet at ${iso(env.now)}: ${running.length} running of ${agents.length} agents on ${hosts.length} hosts (${notOnline} not online), ${pods.length} pods tracked. Per-host kind counts are running/total.`,
      data: {
        hub: snap.hub === undefined ? undefined : { host: snap.hub.hostId, version: snap.hub.version, up: ago(snap.hub.startedAt, env.now) },
        kinds: Object.fromEntries(AGENT_KINDS.map(kind => [kind, countBy(agents.filter(agent => agent.kind === kind), agent => agent.status)])),
        sites: siteRows,
        hosts: shownHosts.map(item => item.row),
        hostsMore: hostRows.length - shownHosts.length || undefined,
        running: shownRunning.map(agent => agentRow(agent, env)),
        runningMore: running.length - shownRunning.length || undefined,
        pods: { tracked: pods.length, byPhase: countBy(pods, pod => pod.phase), withCollector: pods.filter(pod => pod.hostId).length, bySite: countBy(pods, pod => pod.site) },
        links: { total: links.length, crossHost: links.filter(link => link.crossHost).length, crossSite: links.filter(link => link.crossSite).length },
      },
    };
  });
}

const haystack = agent => [agent.key, agent.title, agent.name, agent.description, agent.cwd, agent.model, agent.live?.doing, agent.container, agent.acp?.id].filter(Boolean).join("\n").toLowerCase();

async function list(args, env) {
  const snap = await env.snapshot();
  const since = parseWhen(args.since, env.now);
  const text = args.text?.toLowerCase();
  let hidden = 0;
  const matched = [];
  for (const agent of snap.agents ?? []) {
    if (agent.role === "projection" && args.role !== "projection") { hidden += 1; continue; }
    if (args.kind && agent.kind !== args.kind) continue;
    if (args.site && agent.site !== args.site) continue;
    if (args.host && agent.host !== args.host) continue;
    if (args.status && agent.status !== args.status) continue;
    if (args.role && agent.role !== args.role) continue;
    if (since !== undefined && (agent.updatedAt ?? 0) < since) continue;
    if (text && !haystack(agent).includes(text)) continue;
    matched.push(agent);
  }
  matched.sort((a, b) => ((STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9)) || ((b.updatedAt ?? 0) - (a.updatedAt ?? 0)));
  const parents = buildParents(snap.agents ?? [], snap.links);
  const want = count(args.limit, 25);
  return fit(scale => {
    const shown = matched.slice(0, rows(want, scale));
    const more = matched.length - shown.length;
    return {
      summary: `${matched.length} agents match${more > 0 ? ` (${shown.length} shown, ${more} more)` : ""}; running first, then newest activity.${hidden > 0 && args.role !== "projection" ? ` ${hidden} projection mirrors hidden (role=projection shows them).` : ""}`,
      data: { agents: shown.map(agent => agentRow(agent, env, parents)), more: more || undefined },
    };
  });
}

async function family(args, env) {
  const ref = need(args, "key", "family");
  const snap = await env.snapshot();
  const found = resolveFamily(snap, ref);
  if (found === null) throw notFound(ref);
  const reply = await ask(env, "family", { key: found.rootKey });
  const members = reply?.agents?.length > 0 ? reply.agents : (snap.agents ?? []).filter(agent => agent.key === found.rootKey);
  const parents = buildParents(members, reply?.links ?? snap.links);
  const root = reply?.root ?? found.rootKey;
  const byKey = new Map(members.map(agent => [agent.key, agent]));
  const order = subtree(buildChildren(members, parents), root).filter(key => byKey.has(key));
  for (const agent of members) if (!order.includes(agent.key)) order.push(agent.key);
  const index = new Map(order.map((key, position) => [key, position + 1]));
  const eventsOf = key => [...(reply?.events?.[key] ?? [])].sort((a, b) => a.t - b.t);
  const hostsUsed = new Set(members.map(agent => agent.host));
  const runningCount = members.filter(isRunning).length;
  const want = count(args.limit, 30);
  return fit(scale => {
    const shown = order.slice(0, rows(want, scale));
    const perAgent = Math.max(0, Math.floor(3 * scale));
    return {
      summary: `Family of ${reply?.root ?? found.rootKey}: ${members.length} agents (${runningCount} running) on ${hostsUsed.size} hosts${order.length > shown.length ? `; ${order.length - shown.length} more not shown` : ""}. Rows are in tree order; up = n of the parent row; focus marks the agent you asked about.`,
      data: {
        root: reply?.root ?? found.rootKey,
        agents: shown.map(key => {
          const agent = byKey.get(key);
          const up = parents.get(key);
          const events = perAgent === 0 ? [] : eventsOf(key).slice(-perAgent);
          return {
            n: index.get(key),
            ...agentRow(agent, env),
            parent: undefined,
            up: up === undefined ? undefined : index.get(up.from),
            via: up !== undefined && up.link?.via !== "file" ? up.link?.via : undefined,
            cross: up?.link?.crossSite ? "site" : up?.link?.crossHost ? "host" : undefined,
            focus: key === found.agent.key ? true : undefined,
            events: events.length > 0 ? events.map(event => eventRow(event, { preview: 80, targets: 2 })) : undefined,
          };
        }),
        more: order.length - shown.length || undefined,
      },
    };
  });
}

async function agent(args, env) {
  const ref = need(args, "key", "agent");
  const snap = await env.snapshot();
  const found = findAgent(snap.agents ?? [], ref);
  if (found === null) throw notFound(ref);
  const before = parseWhen(args.before, env.now);
  const want = count(args.limit, 20);
  const reply = await ask(env, "agent", { key: found.key, limit: Math.min(want, 100), before });
  const events = [...(reply?.events ?? [])].sort((a, b) => a.t - b.t);
  const parents = buildParents(snap.agents ?? [], snap.links);
  const children = (buildChildren(snap.agents ?? [], parents).get(found.key)) ?? [];
  const up = parents.get(found.key);
  const usage = found.usage ?? {};
  return fit(scale => {
    const shown = events.slice(-rows(want, scale));
    const kids = children.slice(0, rows(12, scale));
    return {
      summary: `${found.key} [${found.kind} ${found.role} ${found.status}] ${clip(found.title || found.name, 80) ?? ""} on ${found.host}: ${shown.length} of ${found.counts?.events ?? "?"} events shown${reply?.hasMore ? " (older ones exist: pass before=pageBefore)" : ""}.`.replace(/\s+\./, "."),
      data: {
        agent: {
          key: found.key, kind: found.kind, role: found.role, status: found.status,
          title: clip(found.title, 120), name: found.name, description: clip(found.description, 120),
          model: found.model || undefined, provider: found.provider, effort: found.effort, version: found.version,
          host: found.host, site: found.site, container: found.container, cwd: found.cwd, file: tailOf(found.file, 90),
          parent: up === undefined ? undefined : { key: up.from, via: up.link?.via, exact: up.link?.exact || undefined, crossHost: up.link?.crossHost || undefined },
          children: kids.length > 0 ? kids : undefined, childrenMore: children.length - kids.length || undefined,
          acp: found.acp,
          started: iso(found.startedAt), updated: iso(found.updatedAt), ended: iso(found.endedAt),
          live: found.live === undefined ? undefined : { state: found.live.state, since: ago(found.live.since, env.now), doing: clip(found.live.doing, 100), alive: found.live.alive, pid: found.live.pid },
          usage: { in: usage.input, out: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, reasoning: usage.reasoning, cost: usage.cost, context: usage.contextTokens !== undefined ? `${usage.contextTokens}/${usage.contextWindow ?? "?"}` : undefined },
          counts: found.counts,
        },
        events: shown.map(event => eventRow(event, { preview: 140, targets: 4 })),
        hasMore: reply?.hasMore || undefined,
        pageBefore: reply?.hasMore && shown.length > 0 ? new Date(shown[0].t).toISOString() : undefined,
      },
    };
  });
}

async function pods(args, env) {
  const snap = await env.snapshot();
  const text = args.text?.toLowerCase();
  const matched = (snap.pods ?? []).filter(pod => (!args.site || pod.site === args.site) && (!text || [pod.name, pod.node, pod.owner?.name, pod.phase].filter(Boolean).join("\n").toLowerCase().includes(text)));
  matched.sort((a, b) => ((a.phase === "Running" ? 1 : 0) - (b.phase === "Running" ? 1 : 0)) || (a.site < b.site ? -1 : a.site > b.site ? 1 : a.name < b.name ? -1 : 1));
  const want = count(args.limit, 30);
  return fit(scale => {
    const shown = matched.slice(0, rows(want, scale));
    const more = matched.length - shown.length;
    return {
      summary: `${matched.length} pods tracked${more > 0 ? ` (${shown.length} shown, ${more} more)` : ""}; only pods that agents touched or that host a collector are listed. Not-Running pods first.`,
      data: { pods: shown.map(podRow(env)), more: more || undefined, byPhase: countBy(matched, pod => pod.phase) },
    };
  });
}

const podRow = env => pod => ({
  key: pod.key, phase: pod.phase, ready: pod.ready, restarts: pod.restarts || undefined, node: pod.node,
  age: ago(pod.createdAt, env.now), gpu: pod.requests?.gpu || undefined, collector: pod.collector ?? (pod.hostId ? "attached" : undefined),
  bad: (pod.containers ?? []).filter(container => !container.ready).map(container => clip(`${container.name}: ${container.state}`, 80)).slice(0, 3),
});

function findPod(podsList, ref, site) {
  if (ref.split("/").length >= 3) return podsList.find(pod => pod.key === ref) ?? null;
  const named = podsList.filter(pod => pod.name === ref && (!site || pod.site === site));
  if (named.length > 1) throw new Error(`pod name ${JSON.stringify(ref)} exists on several clusters (${named.map(pod => pod.site).join(", ")}); pass site or the full key`);
  return named[0] ?? null;
}

async function pod(args, env) {
  const ref = need(args, "pod", "pod");
  const snap = await env.snapshot();
  const known = findPod(snap.pods ?? [], ref, args.site);
  const key = known?.key ?? (ref.split("/").length >= 3 ? ref : null);
  if (key === null) throw new Error(`pod ${JSON.stringify(ref)} is not tracked; use action "pods" to see the tracked pods, or pass the full key <site>/mc-bochao-li/<name>`);
  const reply = await ask(env, "pod", { key });
  const detail = reply?.pod ?? known;
  if (!detail) throw new Error(`the hub knows no pod ${JSON.stringify(key)}`);
  const touches = [...(reply?.touches ?? [])].sort((a, b) => b.t - a.t);
  const kube = [...(reply?.events ?? [])].sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
  const touchedBy = Object.entries(countBy(touches, touch => touch.agent)).sort((a, b) => b[1] - a[1]);
  return fit(scale => {
    const shownTouches = touches.slice(0, rows(20, scale)), shownKube = kube.slice(0, rows(8, scale)), shownBy = touchedBy.slice(0, rows(8, scale));
    return {
      summary: `Pod ${detail.key}: ${detail.phase} ${detail.ready ?? ""}, ${touches.length} touches by ${touchedBy.length} agents, ${kube.length} kube events.`,
      data: {
        pod: {
          key: detail.key, phase: detail.phase, ready: detail.ready, restarts: detail.restarts, node: detail.node, ip: detail.podIP,
          created: iso(detail.createdAt), started: iso(detail.startedAt), deleted: iso(detail.deletedAt), owner: detail.owner, requests: detail.requests,
          collector: detail.collector ?? (detail.hostId ? "attached" : undefined),
          containers: (detail.containers ?? []).slice(0, 8).map(container => ({ name: container.name, image: tailOf(container.image, 60), state: clip(container.state, 60), ready: container.ready, restarts: container.restarts || undefined })),
        },
        touches: shownTouches.map(touch => ({ at: iso(touch.t), agent: touch.agent, op: touch.op, cat: touch.category, name: touch.name, preview: clip(touch.preview, 100) })),
        touchesMore: touches.length - shownTouches.length || undefined,
        touchedBy: shownBy.map(([agentKey, n]) => ({ agent: agentKey, n })),
        kubeEvents: shownKube.map(event => ({ type: event.type, reason: event.reason, message: clip(event.message, 140), count: event.count > 1 ? event.count : undefined, last: iso(event.lastSeen) })),
        kubeEventsMore: kube.length - shownKube.length || undefined,
      },
    };
  });
}

function aggregateFiles(entries, filter) {
  const files = new Map();
  for (const { agentKey, event } of entries) {
    const fallbackHost = parseAgentKey(agentKey)?.hostId;
    for (const target of event.targets ?? []) {
      if (target.type !== "file" || typeof target.path !== "string") continue;
      const host = target.host ?? fallbackHost ?? "?";
      if (filter.host && host !== filter.host) continue;
      if (filter.text && !target.path.toLowerCase().includes(filter.text)) continue;
      const id = `${host}\u0000${target.path}`;
      const file = files.get(id) ?? files.set(id, { host, path: target.path, ops: {}, last: 0, agents: new Set() }).get(id);
      const op = target.op ?? "touch";
      file.ops[op] = (file.ops[op] ?? 0) + 1;
      file.last = Math.max(file.last, event.t ?? 0);
      if (agentKey) file.agents.add(agentKey);
    }
  }
  return [...files.values()].sort((a, b) => b.last - a.last);
}

async function files(args, env) {
  const since = parseWhen(args.since, env.now);
  const filter = { host: args.host, text: args.text?.toLowerCase() };
  let entries, source;
  if (args.key !== undefined && args.key.trim() !== "") {
    const snap = await env.snapshot();
    const found = findAgent(snap.agents ?? [], args.key.trim());
    if (found === null) throw notFound(args.key);
    const reply = await ask(env, "agent", { key: found.key, limit: 1000 });
    entries = (reply?.events ?? []).map(event => ({ agentKey: found.key, event }));
    source = `${found.key} (its last ${entries.length} events)`;
  } else {
    const reply = await ask(env, "query", { target: "file", limit: 3000, since });
    entries = (reply?.items ?? []).map(item => ({ agentKey: item.agent, event: item.event }));
    source = `all agents (${entries.length} matching tool calls)`;
  }
  if (since !== undefined) entries = entries.filter(entry => (entry.event.t ?? 0) >= since);
  const aggregated = aggregateFiles(entries, filter);
  const want = count(args.limit, 30);
  return fit(scale => {
    const shown = aggregated.slice(0, rows(want, scale));
    const more = aggregated.length - shown.length;
    return {
      summary: `${aggregated.length} files touched by ${source}${more > 0 ? `; ${shown.length} shown, ${more} more` : ""}; newest touch first. ops count the calls per operation.`,
      data: {
        files: shown.map(file => ({ host: file.host, path: tailOf(file.path, 140), ops: file.ops, last: iso(file.last), agents: [...file.agents].slice(0, 2), agentsMore: file.agents.size > 2 ? file.agents.size - 2 : undefined })),
        more: more || undefined,
      },
    };
  });
}

async function file(args, env) {
  const host = need(args, "host", "file"), path = need(args, "path", "file");
  const offset = Math.max(0, Number.isFinite(args.offset) ? Math.trunc(args.offset) : 0);
  const preview = await ask(env, "file", { host, path });
  const content = typeof preview?.content === "string" ? preview.content : undefined;
  return fit(scale => {
    const room = Math.max(200, Math.floor(8000 * scale));
    const slice = content === undefined ? undefined : content.slice(offset, offset + room);
    const next = content !== undefined && offset + room < content.length ? offset + room : undefined;
    const state = preview?.denied ? `refused: ${preview.denied}` : preview?.exists === false ? "does not exist" : preview?.binary ? "binary file, no content" : `chars ${offset}–${offset + (slice?.length ?? 0)} of ${content?.length ?? 0}${preview?.truncated ? " (the hub cut the file at its preview limit)" : ""}`;
    return {
      summary: `${host}:${path} — ${state}${Number.isFinite(preview?.size) ? `, ${preview.size} bytes` : ""}.`,
      data: {
        host, path, exists: preview?.exists, size: preview?.size, mtime: iso(preview?.mtime), binary: preview?.binary || undefined, truncated: preview?.truncated || undefined,
        denied: preview?.denied, redactions: preview?.redactions || undefined, offset: slice === undefined ? undefined : offset, nextOffset: next, content: slice,
      },
    };
  });
}

async function query(args, env) {
  const since = parseWhen(args.since, env.now);
  const want = count(args.limit, 30);
  const reply = await ask(env, "query", { kind: args.kind, site: args.site, host: args.host, category: args.category, target: args.target, text: args.text, since, limit: Math.max(want, 100) });
  const items = [...(reply?.items ?? [])].sort((a, b) => (b.event?.t ?? 0) - (a.event?.t ?? 0));
  const total = Number.isFinite(reply?.total) ? reply.total : items.length;
  return fit(scale => {
    const shown = items.slice(0, rows(want, scale));
    const more = total - shown.length;
    return {
      summary: `${total} matching tool calls${more > 0 ? ` (${shown.length} shown, ${more} more)` : ""}; newest first.`,
      data: { calls: shown.map(item => ({ agent: item.agent, ...eventRow(item.event, { preview: 100, targets: 3 }) })), more: more || undefined },
    };
  });
}

const HANDLERS = { overview, list, family, agent, pods, pod, files, file, query };

/* ───────────────────────────── tool ───────────────────────────── */

/** One-line card title for a call: `Agent fleet · list kind=omp status=running`. */
export function callTitle(args) {
  const detail = Object.entries(args ?? {}).filter(([name, value]) => name !== "action" && value !== undefined && value !== "").map(([name, value]) => `${name}=${clip(String(value), 40)}`).join(" ");
  return `Agent fleet · ${args?.action ?? "?"}${detail ? ` ${detail}` : ""}`;
}

/**
 * @param {object} options
 * @param {Function} options.defineTool  `defineTool` of `@deepseek-ai/dsh-tools`
 * @param {{request(method: string, params: object, options?: {signal?: AbortSignal}): Promise<any>}} options.hub
 *        (wrap it in `withSnapshotCache` when calls arrive in bursts)
 * @param {() => number} [options.now]  clock for the relative ages in the output
 */
export function createFleetTool({ defineTool, hub, now = Date.now }) {
  return defineTool({
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: "text", text: `${value.summary}\n${JSON.stringify(value.data)}` }],
    },
    isConcurrencySafe: () => true,
    presentCall: args => ({ card: "generic", title: callTitle(args), kind: args.action === "file" ? "read" : "search" }),
    async execute(args, exec) {
      const handler = HANDLERS[args.action];
      if (handler === undefined) throw new Error(`unknown action ${JSON.stringify(args.action)}; use one of ${ACTIONS.join(", ")}`);
      const env = { hub, signal: exec?.signal, now: now(), snapshot: () => ask({ hub, signal: exec?.signal }, "snapshot", {}) };
      const built = await handler(args, env);
      return { action: args.action, summary: built.summary, data: JSON.parse(JSON.stringify(built.data)) };
    },
  });
}
