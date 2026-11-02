// The hub API: one function per HUB_METHODS entry, shared by the HTTP server (query-string params) and in-process
// callers (`hub.api.request(method, params)`, plain objects). Parameters are coerced the way a query string would
// arrive, so both paths behave the same.
//
// Reads that need another machine: file previews go to the host's collector (or `kubectl exec` for pods without one,
// or the upstream hub for hosts it owns); history pages go to the collector when the hub's event ring has evicted or
// never held them; data of hosts an upstream hub owns (events, kube events) is fetched from that hub on demand.
import { HUB_METHODS, KUBE_CONTEXTS, LIMITS, NAMESPACE, parsePodHostId } from "../protocol.mjs";
import { isSecretPath } from "../redact.mjs";
import { LOCAL } from "./state.mjs";

export class ApiError extends Error {
  constructor(status, message) { super(message); this.name = "ApiError"; this.status = status; }
}

const SECRET_DENIED = "secret path: credentials are never previewed";
const COLLECTOR_TIMEOUT_MS = 20_000;
const UPSTREAM_QUERY_TIMEOUT_MS = 8_000;
const MAX_PAGE = 3000;
const bad = message => new ApiError(400, message);

function text(params, name, { required = false } = {}) {
  const value = params?.[name];
  if (value === undefined || value === null || value === "") {
    if (required) throw bad(`${name} is required`);
    return undefined;
  }
  return String(value);
}

function number(params, name, { min = -Infinity, max = Infinity } = {}) {
  const raw = params?.[name];
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) throw bad(`${name} must be a number`);
  return Math.min(max, Math.max(min, value));
}

/** Epoch milliseconds from a number, a numeric string or an ISO date. */
function time(params, name) {
  const raw = params?.[name];
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = typeof raw === "number" ? raw : /^-?\d+(\.\d+)?$/.test(String(raw).trim()) ? Number(raw) : Date.parse(String(raw));
  if (!Number.isFinite(value)) throw bad(`${name} must be epoch milliseconds or an ISO date`);
  return value;
}

const byTime = (a, b) => a.t - b.t;

/** Events from two sources merged by id (later list wins), oldest first. */
function mergeEvents(...lists) {
  const byId = new Map();
  for (const list of lists) for (const event of list) byId.set(event.id, event);
  return [...byId.values()].sort(byTime);
}

/**
 * @param {object} options
 * @param {ReturnType<import("./state.mjs").createState>} options.state
 * @param {ReturnType<import("./sources/collector-link.mjs").createCollectorLinks>} options.links
 * @param {object | null} [options.kube]                  kube source (readPodFile, podEvents)
 * @param {Map<string, ReturnType<import("./sources/upstream.mjs").createUpstream>>} [options.upstreams]
 * @param {() => object} [options.listeners]              {http: {port}, ingest: {port}} for health
 */
export function createApi({ state, links, kube = null, upstreams = new Map(), listeners = () => ({}), log = () => {} }) {
  const upstreamOf = hostId => {
    const origin = state.originOf(hostId);
    return origin !== undefined && origin !== LOCAL ? upstreams.get(origin) : undefined;
  };
  const warn = (what, error) => log("warn", `${what}: ${error?.message ?? error}`);

  // ------------------------------------------------------------------------------------------------ family
  async function family(params) {
    const key = text(params, "key", { required: true });
    const result = state.family(key);
    if (result === null) throw new ApiError(404, `unknown agent ${key}`);
    const groups = new Map();
    for (const member of result.agents) {
      const up = upstreamOf(member.host);
      if (up === undefined) continue;
      groups.set(up.name, [...(groups.get(up.name) ?? []), member]);
    }
    await Promise.all([...groups].map(async ([name, members]) => {
      try {
        const reply = await upstreams.get(name).request("family", { key: members[0].key });
        for (const member of members) {
          const events = reply?.events?.[member.key];
          if (Array.isArray(events)) result.events[member.key] = state.upstream(name).shiftEvents(events);
        }
      } catch (error) { warn(`upstream ${name} family`, error); }          // the mirrored ring (feed events) stays
    }));
    return result;
  }

  // -------------------------------------------------------------------------------------------------- agent
  async function agent(params) {
    const ref = text(params, "key", { required: true });
    const record = state.agent(ref) ?? state.resolveAgent(ref);
    if (record === undefined) throw new ApiError(404, `unknown agent ${ref}`);
    const limit = number(params, "limit", { min: 1, max: MAX_PAGE }) ?? 200;
    const before = time(params, "before");

    const up = upstreamOf(record.host);
    if (up !== undefined) {
      try {
        const sink = state.upstream(up.name);
        const reply = await up.request("agent", { key: record.key, limit, before: before === undefined ? undefined : before - sink.skewMs });
        return { key: record.key, events: sink.shiftEvents(reply.events ?? []), hasMore: Boolean(reply.hasMore) };
      } catch (error) { warn(`upstream ${up.name} agent`, error); }
    }

    const page = state.agentEvents(record.key, { before, limit });
    if (page.events.length < limit && page.olderAtSource && links.has(record.host)) {
      const oldest = page.events[0]?.t ?? before;
      const skew = state.skewOf(record.host);
      try {
        const reply = await links.request(record.host, "agent.events", {
          key: record.key, limit: limit - page.events.length, ...(oldest === undefined ? {} : { before: oldest - skew }),
        }, { timeoutMs: COLLECTOR_TIMEOUT_MS });
        const older = state.shiftEventsOf(record.host, Array.isArray(reply?.events) ? reply.events : []);
        // Nothing older than the oldest event the hub holds: the transcript's event count was only an upper bound, so
        // later requests need not ask again (older events fetched here are served, not stored: the ring keeps the newest).
        if (page.events.length > 0 && older.length === 0) state.markEventsExhausted(record.key);
        const events = mergeEvents(older, page.events);
        return { key: record.key, events: events.slice(-limit), hasMore: reply?.hasMore !== false };
      } catch (error) { warn(`collector ${record.host} agent.events`, error); }   // offline or slow: serve the ring
    }
    return { key: record.key, events: page.events, hasMore: page.hasMore };
  }

  // ----------------------------------------------------------------------------------------------------- pod
  const kubeEvent = event => ({ type: event.type, reason: event.reason, message: event.message, count: event.count, firstSeen: event.firstAt, lastSeen: event.lastAt });

  async function pod(params) {
    const key = text(params, "key", { required: true });
    const [site, namespace, ...rest] = key.split("/");
    const name = rest.join("/");
    if (!site || !namespace || name === "") throw bad("key must be <site>/<namespace>/<pod>");
    const known = state.pod(key);
    let record = known.pod, merged = known.touches, events = [], eventsError;
    if (kube !== null && site in KUBE_CONTEXTS) {
      try { events = (await kube.podEvents({ site, namespace, pod: name })).map(kubeEvent); }
      catch (error) { eventsError = error.message; warn(`kube events ${key}`, error); }
      if (record === null) {                                    // never touched or listed: ask the cluster (cached by the source)
        try { record = await kube.getPod({ site, namespace, name }); } catch (error) { warn(`kube pod ${key}`, error); }
      }
    } else {
      for (const up of upstreams.values()) {
        try {
          const reply = await up.request("pod", { key });
          const sink = state.upstream(up.name);
          record ??= reply.pod ?? null;
          if (events.length === 0 && Array.isArray(reply.events)) events = reply.events.map(event => ({ ...event, firstSeen: sink.shiftTime(event.firstSeen), lastSeen: sink.shiftTime(event.lastSeen) }));
          const seen = new Set(merged.map(touch => `${touch.agent}\u0000${touch.event}`));
          for (const touch of reply.touches ?? []) if (!seen.has(`${touch.agent}\u0000${touch.event}`)) merged.push({ ...touch, t: sink.shiftTime(touch.t) });
        } catch (error) { warn(`upstream ${up.name} pod`, error); }
      }
      merged = [...merged].sort((a, b) => b.t - a.t).slice(0, 200);
    }
    return { pod: record, touches: merged, events, ...(eventsError === undefined ? {} : { eventsError }) };
  }

  // ----------------------------------------------------------------------------------------------------- file
  async function file(params) {
    const host = text(params, "host", { required: true });
    const path = text(params, "path", { required: true });
    const maxBytes = number(params, "maxBytes", { min: 1, max: LIMITS.fileReadBytes });
    const refuse = (denied, exists = false) => ({ host, path, exists, denied });
    if (isSecretPath(path)) return refuse(SECRET_DENIED);

    const up = upstreamOf(host);
    if (up !== undefined) return up.request("file", { host, path, maxBytes });
    if (links.has(host)) {
      const reply = await links.request(host, "file.read", { path, ...(maxBytes === undefined ? {} : { maxBytes }) }, { timeoutMs: COLLECTOR_TIMEOUT_MS });
      return { host, path, ...reply };
    }
    const podHost = parsePodHostId(host);
    if (podHost !== null && kube !== null && podHost.site in KUBE_CONTEXTS) {
      try { return await kube.readPodFile({ site: podHost.site, namespace: NAMESPACE, pod: podHost.pod, path, ...(maxBytes === undefined ? {} : { maxBytes }) }); }
      catch (error) { throw new ApiError(502, `cannot read ${path} in pod ${podHost.pod}: ${error.message}`); }   // not running, no shell, cluster unreachable
    }
    if (podHost !== null && kube === null) {                        // this hub watches no cluster: a hub that does can exec into the pod
      for (const up of upstreams.values()) {
        try { return await up.request("file", { host, path, maxBytes }); } catch (error) { warn(`upstream ${up.name} file`, error); }
      }
    }
    if (state.host(host) !== undefined) throw new ApiError(502, `host ${host} is ${state.host(host).status}: no collector connection`);
    throw new ApiError(404, `unknown host ${host}`);
  }

  // ---------------------------------------------------------------------------------------------------- query
  async function query(params) {
    const filters = {
      kind: text(params, "kind"), site: text(params, "site"), host: text(params, "host"), category: text(params, "category"),
      target: text(params, "target"), text: text(params, "text"), since: time(params, "since"), limit: number(params, "limit", { min: 1, max: MAX_PAGE }),
    };
    const local = state.query(filters);
    if (upstreams.size === 0) return local;
    const remote = await Promise.all([...upstreams.values()].map(async up => {
      try {
        const sink = state.upstream(up.name);
        const reply = await up.request("query", { ...filters, since: filters.since === undefined ? undefined : filters.since - sink.skewMs }, { signal: AbortSignal.timeout(UPSTREAM_QUERY_TIMEOUT_MS) });
        for (const item of reply.items ?? []) sink.shiftEvents([item.event]);
        return reply;
      } catch (error) { warn(`upstream ${up.name} query`, error); return null; }
    }));
    const seen = new Map();
    for (const item of local.items) seen.set(`${item.agent}\u0000${item.event.id}`, item);
    let total = local.total;
    for (const reply of remote) {
      if (reply === null) continue;
      total += Math.max(0, (reply.total ?? reply.items?.length ?? 0) - (reply.items?.length ?? 0));
      for (const item of reply.items ?? []) {
        const id = `${item.agent}\u0000${item.event.id}`;
        if (!seen.has(id)) { seen.set(id, item); total += 1; }
      }
    }
    const limit = filters.limit ?? 200;
    return { items: [...seen.values()].sort((a, b) => b.event.t - a.event.t).slice(0, limit), total };
  }

  // ---------------------------------------------------------------------------------------------------- health
  /**
   * `full: false` (no credentials) answers liveness only: ports, upstreams, kube states and counts are internal
   * topology. The HTTP layer decides; in-process callers (the plugin, the CLI) get the full body.
   */
  function health(params = {}) {
    const summary = { ok: true, version: state.version };
    if (params.full === false) return summary;
    const stats = state.stats(), where = listeners();
    return {
      ...summary, hostId: state.hostId, now: Date.now(), startedAt: state.startedAt, uptimeMs: Date.now() - state.startedAt,
      cursor: stats.cursor, hosts: stats.hosts, agents: stats.agents, running: stats.running, pods: stats.pods,
      ...(where.http ? { http: { port: where.http.port } } : {}), ...(where.ingest ? { ingest: { port: where.ingest.port } } : {}),
      upstream: [...upstreams.values()].map(up => { const { name, mode, status } = up.status(); return { name, mode, status }; }),
      kube: Object.fromEntries(Object.entries(state.sources()).map(([site, source]) => [site, source.status])),
    };
  }

  const methods = {
    snapshot: () => state.snapshot(),
    changes: params => {
      const since = number(params, "since");
      if (since === undefined) throw bad("since is required");
      return state.changesSince(since);
    },
    hosts: () => ({ hosts: state.hosts() }),
    pods: () => ({ pods: state.pods() }),
    health,
    family, agent, pod, file, query,
  };

  return {
    /** @param {string} method one of HUB_METHODS @param {object} [params] */
    async request(method, params = {}) {
      if (!HUB_METHODS.includes(method) || typeof methods[method] !== "function") throw new ApiError(404, `unknown method ${JSON.stringify(method)}`);
      return methods[method](params ?? {});
    },
  };
}
