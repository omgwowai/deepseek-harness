// Hub state: hosts, agents, events, procs, pods, links and the change journal behind snapshot / changes / stream.
//
// Everything a collector (or an upstream hub) reports lands here through a handful of entry points; every visible
// change bumps a monotonic cursor and is appended to a journal, so `changesSince(cursor)` can answer with a Delta
// (or `reset: true` when the cursor is unknown). Listeners get one coalesced Delta per `coalesceMs`.
//
// Time: collector timestamps are shifted into hub time by a per-host skew (hub clock − collector clock, the minimum
// of the last samples so network delay does not leak in). Upstream hubs get the same treatment.
// Ownership: a host belongs to `local` (a collector connected to this hub) or to the upstream hub that reported it;
// local always wins, so the Mac's embedded hub never lets the server's copy of the Mac override its own.
import { KUBE_CONTEXTS, LIMITS, NAMESPACE, SITES, AGENT_KINDS, parseAgentKey, parsePodHostId } from "../protocol.mjs";
import { createEventStore } from "./events.mjs";
import { createLinks } from "./links.mjs";

export const LOCAL = "local";

const SKEW_WINDOW = 12;
const SKEW_HYSTERESIS_MS = 50;
const FAMILY_EVENTS_PER_AGENT = 2000;
const FAMILY_EVENTS_TOTAL = 20_000;
const MAX_HOPS = 64;
const LOOKUP_CONCURRENCY = 3;
const LOOKUP_QUEUE_MAX = 200;
const LOOKUP_RETRY_MS = 30_000;
// Collector data is untrusted even with a token (a compromised host or pod can produce it). These bounds keep one
// channel from growing the hub past its cgroup: 5000 keys × a ~1 KiB key, one ring per key, and 2000 procs per host.
const MAX_AGENTS_PER_HOST = 5000;
const MAX_PROCS_PER_HOST = 2000;
const MAX_AGENT_KEY_CHARS = 1024;
const MAX_EVENT_ID_CHARS = 512;
const MAX_EVENT_TYPE_CHARS = 32;

const clip = (value, max) => (typeof value === "string" && value.length > max ? value.slice(0, max) : value);

/** Bound the agent fields the panel and the link index read; paths get LIMITS.pathChars, not the text width. */
function clampAgent(record) {
  record.title = clip(record.title, LIMITS.textChars);
  record.description = clip(record.description, LIMITS.textChars);
  record.model = clip(record.model, LIMITS.textChars);
  record.name = clip(record.name, LIMITS.textChars);
  record.cwd = clip(record.cwd, LIMITS.pathChars);
  record.file = clip(record.file, LIMITS.pathChars);
  if (record.live !== null && typeof record.live === "object") record.live.doing = clip(record.live.doing, LIMITS.textChars);
  if (record.parent !== null && typeof record.parent === "object") {
    record.parent.file = clip(record.parent.file, LIMITS.pathChars);
    record.parent.id = clip(record.parent.id, LIMITS.textChars);
    record.parent.key = clip(record.parent.key, MAX_AGENT_KEY_CHARS);
  }
  return record;
}

/** Bound one event in place: the fields the feed, the timeline and the touch index keep for the ring's whole life. */
function clampEvent(event) {
  event.type = clip(event.type, MAX_EVENT_TYPE_CHARS);
  event.status = clip(event.status, MAX_EVENT_TYPE_CHARS);
  event.category = clip(event.category, MAX_EVENT_TYPE_CHARS);
  event.name = clip(event.name, LIMITS.textChars);
  event.model = clip(event.model, LIMITS.textChars);
  event.preview = clip(event.preview, LIMITS.previewChars);
  event.text = clip(event.text, LIMITS.textChars);
  event.peer = clip(event.peer, LIMITS.textChars);
  if (event.child !== null && typeof event.child === "object") {
    event.child.id = clip(event.child.id, LIMITS.textChars);
    event.child.name = clip(event.child.name, LIMITS.textChars);
    event.child.key = clip(event.child.key, MAX_AGENT_KEY_CHARS);
  }
  if (!Array.isArray(event.targets)) { delete event.targets; return event; }
  if (event.targets.length > LIMITS.maxTargetsPerEvent) event.targets.length = LIMITS.maxTargetsPerEvent;
  for (const target of event.targets) {
    if (target === null || typeof target !== "object") continue;
    target.path = clip(target.path, LIMITS.pathChars);
    target.url = clip(target.url, LIMITS.textChars);
    for (const field of ["name", "host", "pod", "namespace", "container", "resource", "cluster", "site"]) target[field] = clip(target[field], LIMITS.textChars);
  }
  return event;
}

const emptyRoots = () => ({ dsh: [], claude: [], codex: [], omp: [] });
const json = value => JSON.stringify(value);
const siteRank = site => { const index = SITES.indexOf(site); return index < 0 ? SITES.length : index; };

/** Remote-send → local-receive offsets; the estimate is the minimum of the recent samples (delay only adds). */
function createSkewTracker() {
  const samples = [];
  let skew = null;
  return {
    get value() { return skew ?? 0; },
    /** @param {number} raw  local receive time − remote send time. Returns the delay of this sample above the estimate. */
    observe(raw) {
      samples.push(raw);
      if (samples.length > SKEW_WINDOW) samples.shift();
      const estimate = Math.min(...samples);
      if (skew === null || Math.abs(estimate - skew) > SKEW_HYSTERESIS_MS) skew = estimate;
      return Math.max(0, raw - skew);
    },
  };
}

function shiftAgentTimes(record, skew) {
  if (skew === 0) return;
  if (Number.isFinite(record.startedAt)) record.startedAt += skew;
  if (Number.isFinite(record.updatedAt)) record.updatedAt += skew;
  if (Number.isFinite(record.endedAt)) record.endedAt += skew;
  if (record.live && Number.isFinite(record.live.since)) record.live.since += skew;
}

const shiftEventTime = (event, skew) => { if (skew !== 0 && Number.isFinite(event.t)) event.t += skew; };

/** Fill the fields consumers read unconditionally, so one sloppy record cannot break a view. */
function normalizeAgent(record) {
  record.parent ??= null;
  record.endedAt ??= null;
  record.live = { alive: null, state: "idle", since: record.startedAt ?? 0, doing: "", turnOpen: false, ...record.live };
  record.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, ...record.usage };
  record.counts = { turns: 0, tools: 0, errors: 0, subagents: 0, events: 0, ...record.counts };
  return record;
}

function normalizeInfo(id, info = {}) {
  const pod = parsePodHostId(id);
  const out = {
    id,
    site: info.site ?? pod?.site ?? (SITES.includes(id) ? id : "unknown"),
    kind: info.kind ?? (pod ? "pod" : "server"),
    label: info.label ?? id,
    hostname: info.hostname ?? "",
    platform: info.platform ?? "",
    roots: info.roots ?? emptyRoots(),
  };
  for (const name of ["cluster", "namespace", "pod", "node"]) if (info[name] !== undefined) out[name] = info[name];
  return out;
}

/**
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @param {string} [options.hostId]       this hub's own host id (snapshot.hub.hostId)
 * @param {string} [options.version]
 * @param {number} [options.staleAfterMs] offline this long and running agents become `stale`
 * @param {number} [options.coalesceMs]   minimum gap between two Deltas handed to listeners
 * @param {number} [options.journalSize]
 */
export function createState({ now = Date.now, hostId = "hub", version = "0.0.0", staleAfterMs = 60_000, coalesceMs = 200, journalSize = 10_000, eventsPerAgent, feedItems } = {}) {
  const startedAt = now();
  const hosts = new Map();           // id → host entry
  const agents = new Map();          // key → effective AgentRecord (never mutated in place)
  const agentJson = new Map();       // key → JSON of the stored record (change detection)
  const hostAgents = new Map();      // host id → Set<agent key>
  const procs = new Map();           // host id → Proc[]
  const store = createEventStore({ perAgent: eventsPerAgent, feedItems });
  const links = createLinks({ agents, hostAgents, procs });
  const kubePods = new Map();        // pod key → Pod (this hub's kube source; the whole active set)
  const upstreamPods = new Map();    // pod key → {pod, origin}
  const gonePods = new Map();        // exposed pods that left the active set
  const lookedUp = new Map();        // exposed pods resolved on demand (completed, deleted, or never seen)
  const sources = new Map();         // site → {origin, status, error?, at}
  const lookups = new Map();         // pod key → {state, at}
  const lookupQueue = [];
  const listeners = new Set();
  const sinks = new Map();
  let podLookup = null;
  let lookupActive = 0;
  let connectionSeq = 0;

  // ------------------------------------------------------------------------------------------ journal + broadcast
  // Each run owns the cursor range [startedAt × 1000, …): a restarted hub (even a crash loop that restarts within
  // seconds) never hands out a cursor that falls inside an earlier run's range, so a client holding an old cursor
  // always gets `reset: true` instead of a delta that silently misses everything that happened before.
  let cursor = startedAt * 1000;
  let lastFlushed = cursor;
  let lastFlushAt = -Infinity;
  let timer = null;
  let inFlush = false;
  const journal = [];

  function bump(kind, key, extra) {
    cursor += 1;
    journal.push({ c: cursor, k: kind, key, ...extra });
    if (journal.length > journalSize * 2) journal.splice(0, journal.length - journalSize);
    schedule();
  }

  // Every bump appends exactly one entry, so entries are contiguous. A client at cursor `c` is servable when the
  // journal still holds change c+1 and `c` is at most `journalSize` changes old; anything else gets `reset: true`.
  const journalFloor = () => Math.max(journal.length > 0 ? journal[0].c - 1 : cursor, cursor - journalSize);

  function schedule() {
    if (timer !== null || inFlush || listeners.size === 0) return;
    const wait = Math.max(0, lastFlushAt + coalesceMs - performance.now());
    timer = setTimeout(() => { timer = null; flush(); }, wait);
    timer.unref?.();
  }

  function flush() {
    if (listeners.size === 0) return;
    inFlush = true;
    try { settle(); } finally { inFlush = false; }
    if (cursor === lastFlushed) return;
    const delta = buildDelta(lastFlushed);
    lastFlushed = cursor;
    lastFlushAt = performance.now();
    for (const listener of [...listeners]) {
      try { listener(delta); } catch { /* a broken listener must not stop the others */ }
    }
  }

  function settle() {
    links.fuzzy(now());
    if (links.flush()) bump("links");
  }

  function firstIndexAfter(since) {
    let low = 0, high = journal.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (journal[mid].c <= since) low = mid + 1; else high = mid;
    }
    return low;
  }

  function buildDelta(since) {
    const delta = { cursor, now: now() };
    const hostIds = new Set(), agentKeys = new Set(), podKeys = new Set(), siteNames = new Set(), feedEntries = new Set();
    let linksChanged = false;
    for (let i = firstIndexAfter(since); i < journal.length; i += 1) {
      const entry = journal[i];
      switch (entry.k) {
        case "host": hostIds.add(entry.key); break;
        case "agent": case "removed": agentKeys.add(entry.key); break;
        case "pod": podKeys.add(entry.key); break;
        case "source": siteNames.add(entry.key); break;
        case "links": linksChanged = true; break;
        case "feed": for (const item of entry.entries) feedEntries.add(item); break;
        default: break;
      }
    }
    const hostList = [...hostIds].map(id => hosts.get(id)).filter(Boolean).map(hostView);
    if (hostList.length > 0) delta.hosts = hostList;
    const agentList = [], removed = [];
    for (const key of agentKeys) { const record = agents.get(key); if (record !== undefined) agentList.push(record); else removed.push(key); }
    if (agentList.length > 0) delta.agents = agentList;
    if (removed.length > 0) delta.removed = removed;
    if (linksChanged) delta.links = links.all();
    const podList = [], podsRemoved = [];
    for (const key of podKeys) { const pod = exposedPod(key); if (pod !== undefined) podList.push(pod); else podsRemoved.push(key); }
    if (podList.length > 0) delta.pods = podList;
    if (podsRemoved.length > 0) delta.podsRemoved = podsRemoved;
    if (siteNames.size > 0) {
      const view = sourcesView();
      delta.sources = Object.fromEntries([...siteNames].filter(site => view[site] !== undefined).map(site => [site, view[site]]));
    }
    if (feedEntries.size > 0) delta.feed = [...feedEntries].sort((a, b) => a.event.t - b.event.t).map(({ agent, event }) => ({ agent, event }));
    return delta;
  }

  // ------------------------------------------------------------------------------------------------- hosts
  function hostView(h) {
    const view = { ...h.info, status: h.status, via: h.via };
    if (h.connectedAt !== undefined) view.connectedAt = h.connectedAt;
    if (h.lastSeen !== undefined) view.lastSeen = h.lastSeen;
    if (h.lagMs !== undefined) view.lagMs = h.lagMs;
    if (h.skewMs !== undefined) view.skewMs = h.skewMs;
    if (h.error) view.error = h.error;
    view.counts = { agents: h.counts.agents, running: h.counts.running };
    if (h.stats !== undefined) view.stats = h.stats;
    if (h.rejected > 0) { view.rejected = h.rejected; view.lastRejected = h.lastRejected; }   // messages dropped for naming another host's agents
    return view;
  }

  function ensureHost(id, info, origin) {
    let h = hosts.get(id);
    if (h === undefined) {
      h = {
        id, info: normalizeInfo(id, info), status: "connecting", via: "socket", origin, connection: null,
        connectedAt: undefined, lastSeen: undefined, lagMs: undefined, skewMs: undefined, error: "",
        skew: createSkewTracker(), offlineSince: null, staleApplied: false, stats: undefined, counts: { agents: 0, running: 0 },
      };
      hosts.set(id, h);
      hostAgents.set(id, new Set());
    }
    return h;
  }

  function adjustCounts(id, prev, next) {
    const h = hosts.get(id);
    if (h === undefined) return;
    const before = `${h.counts.agents}/${h.counts.running}`;
    if (prev === null || prev === undefined) h.counts.agents += 1;
    else if (prev.status === "running") h.counts.running -= 1;
    if (next === null) h.counts.agents -= 1;
    else if (next.status === "running") h.counts.running += 1;
    if (before !== `${h.counts.agents}/${h.counts.running}`) bump("host", id);
  }

  function markHostAgentsOffline(h) {
    for (const key of [...(hostAgents.get(h.id) ?? [])]) {
      const record = agents.get(key);
      if (record !== undefined && record.live.alive !== null) upsertAgent({ ...record, live: { ...record.live, alive: null } });
    }
  }

  /** A local collector said hello: register or refresh the host and return its connection id. */
  function hostConnected(info, { at, via = "socket" } = {}) {
    if (typeof info?.id !== "string" || info.id === "") throw new TypeError("hostConnected: info.id is required");
    let h = hosts.get(info.id);
    if (h !== undefined && h.origin !== LOCAL) {            // the machine now reports to us directly: its upstream copy goes
      for (const key of [...(hostAgents.get(h.id) ?? [])]) removeAgent(key);
      h.origin = LOCAL;
    }
    h ??= ensureHost(info.id, info, LOCAL);
    const t = now();
    h.info = normalizeInfo(info.id, info);
    h.origin = LOCAL; h.via = via; h.status = "online"; h.error = "";
    h.connection = ++connectionSeq;
    h.connectedAt = t; h.lastSeen = t; h.offlineSince = null; h.staleApplied = false;
    h.skew = createSkewTracker();                           // a new hello is a fresh measurement: the machine's clock may have been fixed
    h.lagMs = Number.isFinite(at) ? h.skew.observe(t - at) : 0;
    h.skewMs = Math.round(h.skew.value);
    bump("host", h.id);
    return h.connection;
  }

  /** The channel of connection `connection` closed. Stale closes (a newer connection exists) are ignored. */
  function hostDisconnected(id, { connection, reason = "" } = {}) {
    const h = hosts.get(id);
    if (h === undefined || h.origin !== LOCAL) return false;
    if (connection !== undefined && h.connection !== connection) return false;
    h.connection = null; h.status = "offline"; h.error = reason; h.offlineSince = now(); h.staleApplied = false;
    markHostAgentsOffline(h);
    bump("host", id);
    return true;
  }

  /** Connection progress of a host that has no channel (dial attempts). Creates a placeholder when `info` is given. */
  function hostState(id, { status, error = "", info, via } = {}) {
    let h = hosts.get(id);
    if (h === undefined) { if (info === undefined) return false; h = ensureHost(id, info, LOCAL); }
    if (h.origin !== LOCAL || h.connection !== null) return false;
    if (h.status === status && h.error === error && (via === undefined || h.via === via)) return false;
    h.status = status; h.error = error;
    if (via !== undefined) h.via = via;
    if (status !== "connecting" && h.offlineSince === null) h.offlineSince = now();
    bump("host", id);
    return true;
  }

  /** Forget a host that never produced data (the dial placeholder of a pod that is gone). Returns true when removed. */
  function forgetHost(id) {
    const h = hosts.get(id);
    if (h === undefined || h.origin !== LOCAL || h.connection !== null || h.connectedAt !== undefined || (hostAgents.get(id)?.size ?? 0) > 0) return false;
    hosts.delete(id); hostAgents.delete(id); procs.delete(id);
    bump("host", id);
    return true;
  }

  // ------------------------------------------------------------------------------------------------ agents
  function upsertAgent(record) {
    const text = json(record);
    if (agentJson.get(record.key) === text) return false;
    const prev = agents.get(record.key);
    agents.set(record.key, record);
    agentJson.set(record.key, text);
    let set = hostAgents.get(record.host);
    if (set === undefined) hostAgents.set(record.host, set = new Set());
    set.add(record.key);
    adjustCounts(record.host, prev, record);
    links.agentUpserted(prev, record);
    bump("agent", record.key);
    return true;
  }

  function removeAgent(key) {
    const prev = agents.get(key);
    store.removeAgent(key);
    if (prev === undefined) return false;
    agents.delete(key);
    agentJson.delete(key);
    hostAgents.get(prev.host)?.delete(key);
    adjustCounts(prev.host, prev, null);
    links.agentRemoved(prev);
    bump("removed", key);
    return true;
  }

  function applyEvents(agentKey, events) {
    const entries = [];
    let changed = false;
    for (const event of events) {
      if (event === null || typeof event !== "object" || typeof event.id !== "string" || !Number.isFinite(event.t)) continue;
      const result = store.upsert(agentKey, event);
      if (!result.changed) continue;
      changed = true;
      links.eventSeen(agentKey, result.event);
      for (const key of result.newPods) podFirstTouched(key);
      if (result.feedEntry) entries.push(result.feedEntry);
    }
    if (entries.length > 0) bump("feed", agentKey, { entries });
    return changed;
  }

  // ----------------------------------------------------------------------------------- collector messages
  function reject(h, what) { h.rejected = (h.rejected ?? 0) + 1; h.lastRejected = what; return false; }

  function ingestAgent(h, record) {
    if (typeof record?.key === "string" && record.key.length > MAX_AGENT_KEY_CHARS) return reject(h, `agent key over ${MAX_AGENT_KEY_CHARS} chars`);
    const parsed = typeof record?.key === "string" ? parseAgentKey(record.key) : null;
    if (parsed === null || parsed.hostId !== h.id || !AGENT_KINDS.includes(record.kind)) return reject(h, "agent record with a foreign or malformed key");
    if (!agents.has(record.key) && (hostAgents.get(h.id)?.size ?? 0) >= MAX_AGENTS_PER_HOST) return reject(h, `agent cap ${MAX_AGENTS_PER_HOST} reached on this host`);
    shiftAgentTimes(record, h.skew.value);
    clampAgent(record);
    normalizeAgent(record);
    record.host = h.id;
    record.site ??= h.info.site;
    return upsertAgent(record);
  }

  function ingestEvents(h, agentKey, events) {
    const parsed = typeof agentKey === "string" ? parseAgentKey(agentKey) : null;
    if (parsed === null || parsed.hostId !== h.id || !Array.isArray(events)) return reject(h, "events for a foreign or malformed agent key");
    // An event without its agent would still allocate a ring keyed by the message's string; only known agents may grow.
    if (!agents.has(agentKey)) return reject(h, "events for an unknown agent key");
    const skew = h.skew.value, kept = [];
    for (const event of events) {
      if (event === null || typeof event !== "object") continue;
      if (typeof event.id === "string" && event.id.length > MAX_EVENT_ID_CHARS) { reject(h, `event id over ${MAX_EVENT_ID_CHARS} chars`); continue; }
      if (skew !== 0) shiftEventTime(event, skew);
      kept.push(clampEvent(event));
    }
    return applyEvents(agentKey, kept);
  }

  /** Apply one collector → hub message (everything but `hello`, which is `hostConnected`). */
  function applyCollectorMessage(id, message, connection) {
    const h = hosts.get(id);
    if (h === undefined || h.origin !== LOCAL || (connection !== undefined && h.connection !== connection)) return false;
    h.lastSeen = now();
    switch (message?.t) {
      case "agent": return ingestAgent(h, message.agent);
      case "events": return ingestEvents(h, message.agent, message.events);
      case "gone": {
        const parsed = typeof message.agent === "string" ? parseAgentKey(message.agent) : null;
        return parsed !== null && parsed.hostId === h.id ? removeAgent(message.agent) : reject(h, "gone for a foreign agent key");
      }
      case "procs": {
        if (!Array.isArray(message.procs)) return reject(h, "procs is not a list");
        const list = message.procs.slice(0, MAX_PROCS_PER_HOST);
        const skew = h.skew.value;
        for (const proc of list) if (skew !== 0 && Number.isFinite(proc?.startedAt)) proc.startedAt += skew;
        procs.set(h.id, list);
        links.procsChanged(h.id);
        schedule();
        return true;
      }
      case "heartbeat": {
        if (Number.isFinite(message.at)) h.lagMs = h.skew.observe(h.lastSeen - message.at);
        h.skewMs = Math.round(h.skew.value);
        if (message.stats !== undefined) h.stats = message.stats;
        bump("host", h.id);
        return true;
      }
      default: return false;
    }
  }

  /** Time shift (ms) to apply to timestamps a host's collector sends. */
  const skewOf = id => hosts.get(id)?.skew.value ?? 0;

  /** Periodic upkeep: stale marking of long-offline hosts, pod lookup retries, link settling. */
  function tick() {
    const t = now();
    for (const h of hosts.values()) {
      if (h.status === "online" || h.offlineSince === null || h.staleApplied || t - h.offlineSince < staleAfterMs) continue;
      h.staleApplied = true;
      for (const key of [...(hostAgents.get(h.id) ?? [])]) {
        const record = agents.get(key);
        if (record?.status === "running") upsertAgent({ ...record, status: "stale" });
      }
    }
    for (const [key, entry] of lookups) {
      if (entry.state === "failed" && t - entry.at >= LOOKUP_RETRY_MS && store.isTouched("pod", key) && podRecord(key) === undefined) requestLookup(key);
    }
    settle();
  }

  // --------------------------------------------------------------------------------------------------- pods
  const podRecord = key => kubePods.get(key) ?? upstreamPods.get(key)?.pod ?? gonePods.get(key) ?? lookedUp.get(key);

  /** The pod as clients see it: a kube pod only when touched by an agent, labelled for collection or hosting a collector. */
  function exposedPod(key) {
    const kube = kubePods.get(key);
    if (kube !== undefined) return kube.hostId || kube.collect || store.isTouched("pod", key) ? kube : undefined;
    return upstreamPods.get(key)?.pod ?? gonePods.get(key) ?? lookedUp.get(key);
  }

  function podFirstTouched(key) {
    if (podRecord(key) !== undefined) bump("pod", key);   // known pod becomes visible
    else requestLookup(key);
  }

  /** A touched pod the cluster has no record of (deleted long ago) or this hub does not watch (another namespace). */
  const stubPod = ({ site, namespace, name }) => ({
    key: `${site}/${namespace}/${name}`, site, cluster: KUBE_CONTEXTS[site] ?? site, namespace, name,
    phase: namespace === NAMESPACE ? "NotFound" : "Unwatched", ready: "0/0", restarts: 0, containers: [], requests: {}, labels: {}, collect: false,
  });

  function requestLookup(key) {
    if (podLookup === null) return;
    const known = lookups.get(key);
    if (known !== undefined && (known.state !== "failed" || now() - known.at < LOOKUP_RETRY_MS)) return;
    if (lookupQueue.length >= LOOKUP_QUEUE_MAX) return;
    lookups.set(key, { state: "queued", at: now() });
    lookupQueue.push(key);
    pumpLookups();
  }

  function pumpLookups() {
    while (lookupActive < LOOKUP_CONCURRENCY && lookupQueue.length > 0) {
      const key = lookupQueue.shift();
      const [site, namespace, ...rest] = key.split("/");
      const ref = { site, namespace, name: rest.join("/") };
      lookupActive += 1;
      lookups.set(key, { state: "running", at: now() });
      Promise.resolve().then(() => podLookup(ref)).then(
        pod => { lookups.set(key, { state: "done", at: now() }); absorbLookup(key, pod, ref); },
        () => { lookups.set(key, { state: "failed", at: now() }); },
      ).finally(() => { lookupActive -= 1; pumpLookups(); });
    }
  }

  function absorbLookup(key, pod, ref) {
    if (kubePods.has(key) || upstreamPods.has(key)) return;
    if (pod) {
      const gone = gonePods.get(key);
      if (gone !== undefined) gonePods.set(key, { ...pod, deletedAt: pod.deletedAt ?? gone.deletedAt });
      else lookedUp.set(key, pod);
      bump("pod", key);
    } else if (!gonePods.has(key) && !lookedUp.has(key)) {
      lookedUp.set(key, stubPod(ref));
      bump("pod", key);
    }
  }

  function podLeft(key) {
    const pod = kubePods.get(key);
    if (pod === undefined) return;
    const wasExposed = exposedPod(key) !== undefined;
    kubePods.delete(key);
    if (!wasExposed) return;
    gonePods.set(key, { ...pod, deletedAt: now() });     // touched pods stay visible after they finish or vanish
    bump("pod", key);
    lookups.delete(key);
    requestLookup(key);                                 // a completed pod still exists: fetch its final phase
  }

  /** Pods of one kube site. By default `list` is the complete active set (pods of the site not in it have left); `{replace: false}` only upserts. */
  function setPods(site, list, { replace = true } = {}) {
    const keep = new Set();
    for (const pod of list ?? []) {
      if (typeof pod?.key !== "string") continue;
      keep.add(pod.key);
      const prev = kubePods.get(pod.key);
      if (prev !== undefined && json(prev) === json(pod)) continue;
      const before = exposedPod(pod.key) !== undefined;
      kubePods.set(pod.key, pod);
      gonePods.delete(pod.key);
      lookedUp.delete(pod.key);
      if (before || exposedPod(pod.key) !== undefined) bump("pod", pod.key);
    }
    if (replace) for (const [key, pod] of [...kubePods]) if (pod.site === site && !keep.has(key)) podLeft(key);
  }

  function removePod(key) { podLeft(key); }

  function setSource(site, source, origin = LOCAL) {
    const prev = sources.get(site);
    if (origin !== LOCAL && prev?.origin === LOCAL) return;
    const error = source.error ? String(source.error) : undefined;
    const next = { origin, status: source.status, at: source.at ?? source.since ?? now(), ...(error === undefined ? {} : { error }) };
    if (prev !== undefined && prev.origin === origin && prev.status === next.status && prev.error === next.error) return;
    sources.set(site, next);
    bump("source", site);
  }

  function sourcesView() {
    return Object.fromEntries([...sources].map(([site, s]) => [site, { status: s.status, ...(s.error === undefined ? {} : { error: s.error }), at: s.at }]));
  }

  // -------------------------------------------------------------------------------------------- upstream hubs
  /**
   * Merge target for another hub's data. The sink shifts that hub's timestamps into our clock, keeps its hosts under
   * its own name and never overrides anything this hub's collectors report.
   */
  function upstreamSink(name) {
    const existing = sinks.get(name);
    if (existing !== undefined) return existing;
    const skew = createSkewTracker();
    const observe = remoteNow => { if (Number.isFinite(remoteNow)) skew.observe(now() - remoteNow); };
    const shifted = value => (Number.isFinite(value) ? value + skew.value : value);
    const owns = id => hosts.get(id)?.origin === name;

    function mergeHost(host) {
      if (typeof host?.id !== "string") return false;
      const current = hosts.get(host.id);
      if (current !== undefined && current.origin !== name) return false;       // local (or another upstream) wins
      const h = current ?? ensureHost(host.id, host, name);
      const before = json(hostView(h));
      h.info = normalizeInfo(host.id, host);
      h.status = host.status ?? "online"; h.via = host.via ?? "socket"; h.error = host.error ?? "";
      h.connection = null; h.unreported = false;
      h.connectedAt = shifted(host.connectedAt); h.lastSeen = shifted(host.lastSeen);
      h.lagMs = host.lagMs; h.skewMs = host.skewMs; h.stats = host.stats;
      if (h.status === "online") { h.offlineSince = null; h.staleApplied = false; }
      else if (h.offlineSince === null) h.offlineSince = now();
      if (before !== json(hostView(h))) bump("host", h.id);
      return true;
    }

    function mergeAgent(record) {
      const parsed = typeof record?.key === "string" ? parseAgentKey(record.key) : null;
      if (parsed === null || !AGENT_KINDS.includes(record.kind)) return false;
      const id = parsed.hostId;
      const current = hosts.get(id);
      if (current !== undefined && current.origin !== name) return false;
      if (current === undefined) mergeHost({ id, site: record.site, status: "online" });
      shiftAgentTimes(record, skew.value);
      normalizeAgent(record);
      record.host = id;
      upsertAgent(record);
      return true;
    }

    function mergePod(pod) {
      if (typeof pod?.key !== "string" || kubePods.has(pod.key)) return;
      const prev = upstreamPods.get(pod.key);
      if (prev !== undefined && json(prev.pod) === json(pod)) return;
      upstreamPods.set(pod.key, { pod, origin: name });
      bump("pod", pod.key);
    }

    function mergeFeed(items) {
      const byAgent = new Map();
      for (const item of items ?? []) {
        const parsed = typeof item?.agent === "string" ? parseAgentKey(item.agent) : null;
        if (parsed === null || typeof item.event !== "object" || item.event === null || (hosts.get(parsed.hostId)?.origin ?? name) !== name) continue;
        shiftEventTime(item.event, skew.value);
        const list = byAgent.get(item.agent) ?? [];
        list.push(item.event);
        byAgent.set(item.agent, list);
      }
      for (const [agentKey, events] of byAgent) applyEvents(agentKey, events);
    }

    function mergeSources(map) {
      for (const [site, source] of Object.entries(map ?? {})) setSource(site, { ...source, at: shifted(source.at) }, name);
    }

    const sink = {
      name,
      get skewMs() { return skew.value; },
      /** Shift event times of a proxied reply into our clock (in place). */
      shiftEvents(events) { for (const event of events ?? []) shiftEventTime(event, skew.value); return events; },
      shiftTime: shifted,

      /** Replace everything this upstream owns with `snapshot`. */
      snapshot(snapshot) {
        observe(snapshot.now);
        const seenHosts = new Set(), seenAgents = new Set(), seenPods = new Set();
        for (const host of snapshot.hosts ?? []) if (mergeHost(host)) seenHosts.add(host.id);
        for (const record of snapshot.agents ?? []) { const key = record?.key; if (mergeAgent(record)) seenAgents.add(key); }
        for (const pod of snapshot.pods ?? []) { mergePod(pod); if (typeof pod?.key === "string") seenPods.add(pod.key); }
        mergeSources(snapshot.sources);
        for (const h of hosts.values()) {
          if (h.origin !== name) continue;
          if (!seenHosts.has(h.id)) {                      // not reported (yet): keep its agents, show it offline until it comes back
            h.unreported = true;
            if (h.status !== "offline") { h.status = "offline"; h.error = "not reported by the upstream hub"; h.offlineSince = now(); h.staleApplied = false; markHostAgentsOffline(h); bump("host", h.id); }
            continue;
          }
          for (const key of [...(hostAgents.get(h.id) ?? [])]) if (!seenAgents.has(key)) removeAgent(key);
        }
        for (const [key, entry] of [...upstreamPods]) if (entry.origin === name && !seenPods.has(key)) { upstreamPods.delete(key); bump("pod", key); }
        links.setExternal(name, snapshot.links ?? []);
        mergeFeed(snapshot.feed);
      },

      /** Apply one Delta; returns "reset" when a fresh snapshot is needed (the upstream asked, or a host we had dropped is back). */
      delta(delta) {
        observe(delta.now);
        if (delta.reset) return "reset";
        const returned = (delta.hosts ?? []).some(host => hosts.get(host.id)?.origin === name && hosts.get(host.id).unreported);
        for (const host of delta.hosts ?? []) mergeHost(host);
        for (const record of delta.agents ?? []) mergeAgent(record);
        for (const key of delta.removed ?? []) { const parsed = parseAgentKey(key); if (parsed !== null && owns(parsed.hostId)) removeAgent(key); }
        for (const pod of delta.pods ?? []) mergePod(pod);
        for (const key of delta.podsRemoved ?? []) if (upstreamPods.get(key)?.origin === name) { upstreamPods.delete(key); bump("pod", key); }
        mergeSources(delta.sources);
        if (delta.links) links.setExternal(name, delta.links);
        mergeFeed(delta.feed);
        return returned ? "reset" : "ok";
      },

      /** The subscription dropped: everything it owns is offline until the next snapshot. */
      disconnected(reason) {
        for (const h of hosts.values()) {
          if (h.origin !== name || h.status === "offline") continue;
          h.status = "offline"; h.error = `upstream hub unreachable: ${reason}`; h.offlineSince = now(); h.staleApplied = false;
          markHostAgentsOffline(h);
          bump("host", h.id);
        }
      },
    };
    sinks.set(name, sink);
    return sink;
  }

  // ------------------------------------------------------------------------------------------------ queries
  function hostList() {
    return [...hosts.values()].map(hostView).sort((a, b) => siteRank(a.site) - siteRank(b.site) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  function podList() {
    const out = new Map();
    for (const key of kubePods.keys()) { const pod = exposedPod(key); if (pod !== undefined) out.set(key, pod); }
    for (const [key, entry] of upstreamPods) out.set(key, entry.pod);
    for (const [key, pod] of gonePods) out.set(key, pod);
    for (const [key, pod] of lookedUp) out.set(key, pod);
    return [...out.values()].sort((a, b) => siteRank(a.site) - siteRank(b.site) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  function snapshot() {
    settle();
    return {
      cursor, now: now(),
      hub: { version, startedAt, hostId },
      hosts: hostList(),
      agents: [...agents.values()],
      links: links.all(),
      pods: podList(),
      feed: store.feedItems(),
      sources: sourcesView(),
    };
  }

  /** Delta of everything after `since`; `{reset: true}` when the cursor is unknown (future, too old, other run). */
  function changesSince(since) {
    settle();
    const from = Number(since);
    if (!Number.isFinite(from) || from > cursor || from < journalFloor()) return { cursor, now: now(), reset: true };
    return buildDelta(from);
  }

  /** An agent by full key, or by global `kind:id` (the most recently updated one). */
  function resolveAgent(ref) {
    if (typeof ref !== "string" || ref === "") return undefined;
    const exact = agents.get(ref);
    if (exact !== undefined) return exact;
    const match = /^(dsh|claude|codex|omp):(.+)$/.exec(ref);
    if (match === null) return undefined;
    let best;
    for (const record of agents.values()) if (record.kind === match[1] && record.id === match[2] && (best === undefined || record.updatedAt > best.updatedAt)) best = record;
    return best;
  }

  function rootOf(record) {
    let current = record;
    for (let hops = 0; hops < MAX_HOPS; hops += 1) {
      const parent = agents.get(links.linkOf(current.key)?.from);
      if (parent === undefined) break;
      current = parent;
    }
    return current;
  }

  /** Root, descendants (breadth first), the links between them and their events (oldest first). */
  function family(ref, { eventsPerAgent: perAgentCap = FAMILY_EVENTS_PER_AGENT } = {}) {
    settle();
    const start = resolveAgent(ref);
    if (start === undefined) return null;
    const root = rootOf(start);
    const members = [], seen = new Set(), queue = [root.key];
    while (queue.length > 0) {
      const key = queue.shift();
      if (seen.has(key)) continue;
      seen.add(key);
      const record = agents.get(key);
      if (record === undefined) continue;
      members.push(record);
      const kids = [...links.childrenOf(key)].map(child => agents.get(child)).filter(Boolean)
        .sort((a, b) => a.startedAt - b.startedAt || (a.key < b.key ? -1 : 1));
      for (const kid of kids) queue.push(kid.key);
    }
    const cap = Math.max(100, Math.min(perAgentCap, Math.floor(FAMILY_EVENTS_TOTAL / Math.max(1, members.length))));
    const events = {};
    for (const member of members) events[member.key] = store.tail(member.key, cap);
    return {
      root: root.key,
      agents: members,
      links: members.map(member => links.linkOf(member.key)).filter(link => link !== null && seen.has(link.from)),
      events,
    };
  }

  /** Local page of an agent's events: older than `before` (exclusive), at most `limit`, oldest first. */
  function agentEvents(key, { before, limit = 200 } = {}) {
    const record = agents.get(key);
    const { events, more } = store.slice(key, { before: Number.isFinite(before) ? before : undefined, limit: Math.min(3000, Math.max(1, limit)) });
    const info = store.ringInfo(key);
    // Older events exist at the collector when the ring evicted some, or the transcript holds more than the hub ever
    // received (unless the collector already said there is nothing older than what the ring starts with).
    const olderAtSource = info.evicted > 0 || (!info.exhausted && (record?.counts?.events ?? 0) > info.size);
    return { key, events, hasMore: more || olderAtSource, olderAtSource };
  }

  const pod = key => {
    const record = podRecord(key);
    return { pod: record ?? null, touches: store.touchesOf("pod", key) };
  };

  return {
    hostId, version, startedAt,
    get cursor() { return cursor; },
    // inputs
    hostConnected, hostDisconnected, hostState, forgetHost, applyCollectorMessage, setPods, removePod, setSource, upstream: upstreamSink,
    setPodLookup(fn) { podLookup = fn; },
    tick,
    // outputs
    snapshot, changesSince, family, agentEvents, pod, resolveAgent, skewOf,
    hosts: hostList,
    host: id => (hosts.has(id) ? hostView(hosts.get(id)) : undefined),
    originOf: id => hosts.get(id)?.origin,
    agent: key => agents.get(key),
    procs: id => procs.get(id),
    agents: () => [...agents.values()],
    pods: podList,
    podRecord,
    sources: sourcesView,
    fileTouches: (host, path, limit) => store.touchesOf("file", `${host}:${path}`, limit),
    query: filters => store.query(filters, key => agents.get(key)),
    markEventsExhausted: key => store.markExhausted(key),
    /** Events fetched out of band (collector history pages) are only shifted, never stored. */
    shiftEventsOf(id, events) { const skew = skewOf(id); if (skew !== 0) for (const event of events ?? []) shiftEventTime(event, skew); return events; },
    stats() {
      let online = 0, running = 0;
      for (const h of hosts.values()) { if (h.status === "online") online += 1; running += h.counts.running; }
      return { hosts: { total: hosts.size, online }, agents: agents.size, running, pods: podList().length, cursor };
    },
    subscribe(listener) {
      if (listeners.size === 0) lastFlushed = cursor;      // nobody was following: start from now, not from the journal's past
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    close() { clearTimeout(timer); timer = null; listeners.clear(); },
  };
}
