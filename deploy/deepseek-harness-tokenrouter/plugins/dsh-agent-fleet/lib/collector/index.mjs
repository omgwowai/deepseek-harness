// The collector: one per machine or pod. It finds session transcripts (discovery), follows them (sessions), watches
// the agent processes (procs) and the DSH ACP sidecar (acp), and reports to a hub through `send`:
//   hello (once) · agent (full record, on change) · events (new or changed events) · gone · procs · heartbeat
// Updates are coalesced for 250 ms. Requests from the hub: file.read, agent.events, ping.
import { hostname as osHostname, homedir } from "node:os";
import { dirname, join } from "node:path";
import { LIMITS, PROTOCOL_VERSION, agentKey } from "../protocol.mjs";
import { dshIdForm, createAcp } from "./acp.mjs";
import { createDiscovery } from "./discovery.mjs";
import { readFilePreview } from "./files.mjs";
import { applyLiveness, bindProcs, createProcs } from "./procs.mjs";
import { normalizeRoots } from "./roots.mjs";
import { createSessions } from "./sessions.mjs";
import { parseDuration } from "./util.mjs";

const DEFAULT_SINCE_MS = 24 * 3_600_000;
const STALE_MS = 5 * 60_000;
const EVENTS_PER_MESSAGE = 200;
const DEFAULT_INTERVALS = { flushMs: 250, pollMs: 500, scanMs: 1000, procsMs: 2000, acpMs: 2000, heartbeatMs: 5000, derivedMs: 1000 };

const coded = (code, message) => Object.assign(new Error(message), { code });

/**
 * @param {object} options
 * @param {Partial<import("../protocol.mjs").HostInfo> & {id: string, site: string}} options.hostInfo
 * @param {object|string[]} [options.roots]  extra session roots: `{dsh|claude|codex|omp: string[]}` or `["kind=path", …]` (globs allowed)
 * @param {(message: object) => unknown} options.send  channel send
 * @param {number|string} [options.since]  only sessions modified within this window are loaded at start (ms, default 24 h)
 * @param {boolean} [options.defaults]  also watch the default roots and AGENT_FLEET_ROOTS (default true)
 * @param {string[]} [options.sidecars]  ACP sidecar.sqlite files (default: `<dsh root>/../dsh-acp/sidecar.sqlite`)
 * @param {() => boolean} [options.congested]  true while the transport cannot take more data: updates wait
 * @param {boolean} [options.procs]  false disables the process scan
 */
export function startCollector({ hostInfo, roots, send, now = Date.now, since = DEFAULT_SINCE_MS, intervals = {}, env = process.env, home = homedir(), defaults = true, sidecars, congested, procs: procsEnabled = true, platform = process.platform, sys, watch = true, log = () => {} }) {
  if (!hostInfo?.id || !hostInfo?.site) throw new Error("startCollector: hostInfo.id and hostInfo.site are required");
  if (typeof send !== "function") throw new Error("startCollector: send is required");
  const tick = { ...DEFAULT_INTERVALS, ...intervals };
  const sinceMs = typeof since === "number" ? since : parseDuration(since);
  const specs = normalizeRoots({ roots, env, home, defaults });
  const rootList = { dsh: [], claude: [], codex: [], omp: [] };
  for (const spec of specs) rootList[spec.kind].push(spec.path);
  const host = {
    kind: "server", label: hostInfo.id, hostname: osHostname(), platform, ...hostInfo,
    roots: rootList,
  };
  const startedAt = now();

  let out = send, stopped = false;
  const timers = [];
  const dirty = new Set(), goneKeys = new Set();
  const bindingsByDsh = new Map(), bindingsByNative = new Map();
  let procState = { ok: false, bindings: new Map(), scan: null };
  let lastProcsJson = null, procsRunning = false, rebindTimer = null;
  const sent = { agent: 0, events: 0, eventItems: 0, gone: 0, procs: 0, heartbeat: 0 };

  const emit = message => {
    if (stopped) return false;
    try {
      const ok = out(message) !== false;
      if (ok && message.t in sent) sent[message.t] += 1;
      return ok;
    } catch (error) { log(`send failed: ${error.message}`); return false; }
  };

  // ------------------------------------------------------------------------------------------------ components
  const sessions = createSessions({
    host: host.id, site: host.site, now, since: sinceMs, pollMs: tick.pollMs, log,
    onUpdate: (entry, why) => { markDirty(entry); if (why === "read" && entry.match === null) rebindSoon(); },
    onRemove: entry => { dirty.delete(entry); if (entry.sent) goneKeys.add(entry.key); rebindSoon(); },
    onActive: path => discovery.expedite(path),
    onMissing: path => discovery.forget(path),
  });

  const discovery = createDiscovery({
    specs, since: sinceMs, now, scanMs: tick.scanMs, platform, watch, log,
    onAdd: file => { sessions.add(file); },
    onRemove: path => sessions.remove(path),
    onTouch: path => sessions.touch(path),
  });

  const acp = createAcp({
    intervalMs: tick.acpMs, log,
    paths: () => sidecars ?? discovery.roots().filter(root => root.kind === "dsh").map(root => join(dirname(root.dir), "dsh-acp", "sidecar.sqlite")),
    onBindings: bindings => {
      for (const binding of bindings) {
        bindingsByDsh.set(dshIdForm(binding.dsh), binding);
        bindingsByNative.set(`${binding.kind}:${binding.id}`, binding);
        for (const entry of [sessions.byKey(agentKey(host.id, binding.kind, binding.id)), sessions.byKey(agentKey(host.id, "dsh", binding.dsh)), sessions.byKey(agentKey(host.id, "dsh", dshIdForm(binding.dsh)))]) {
          if (entry) markDirty(entry);
        }
      }
    },
  });

  const procsScanner = procsEnabled ? createProcs({ platform, sys, now, host: host.id, site: host.site, log }) : null;

  // ------------------------------------------------------------------------------------------- record assembly
  function markDirty(entry) {
    if (entry.removed) return;
    entry.dirty = true;
    dirty.add(entry);
  }

  const aliveOf = entry => (procState.ok ? entry.match !== null : null);

  /** Parent hint for the record: transcript > ACP binding > launching process > unconfirmed transcript hint. */
  function resolveParent(entry, hint) {
    let parent = hint ?? null;
    if (!parent?.exact) {
      const binding = entry.kind === "dsh" ? null : bindingsByNative.get(`${entry.kind}:${entry.id}`);
      if (binding) parent = { kind: "dsh", id: binding.dsh, via: "acp", exact: true };
      else if (entry.match?.hint) parent = { ...entry.match.hint };
    }
    if (!parent) return null;
    parent = { ...parent };
    const local = parent.kind && parent.id ? sessions.byKey(agentKey(host.id, parent.kind, parent.id)) : null;
    if (!parent.key && (parent.via === "file" || local)) parent.key = agentKey(host.id, parent.kind, parent.id);
    if (!parent.toolCallId && local) {
      const eventId = local.spawnIds.get(entry.id);
      if (eventId) parent.toolCallId = eventId;
    }
    return parent;
  }

  function build(entry) {
    if (!entry.record) return null;
    const record = { ...entry.record, host: host.id, site: host.site };
    if (entry.container) record.container = entry.container;
    record.parent = resolveParent(entry, entry.record.parent);
    if (entry.kind === "dsh") {
      const binding = bindingsByDsh.get(dshIdForm(entry.id));
      if (binding) record.acp = { provider: binding.provider, kind: binding.kind, id: binding.id };
    }
    const alive = aliveOf(entry);
    entry.liveKey = `${alive}:${entry.match?.pid ?? ""}`;
    return applyLiveness(record, { alive, pid: entry.match?.pid }, { now: now(), mtimeMs: entry.mtimeMs });
  }

  // ------------------------------------------------------------------------------------------------- reporting
  function sendEvents(key, events) {
    if (events.length === 0) return;
    const latest = new Map();
    for (const event of events) latest.set(event.id, event);
    const list = [...latest.values()];
    for (let at = 0; at < list.length; at += EVENTS_PER_MESSAGE) {
      emit({ t: "events", agent: key, events: list.slice(at, at + EVENTS_PER_MESSAGE) });
      sent.eventItems += Math.min(EVENTS_PER_MESSAGE, list.length - at);
    }
  }

  function report(entry) {
    const record = build(entry);
    if (!record) return;
    goneKeys.delete(entry.key);
    const json = JSON.stringify(record);
    if (json !== entry.lastJson) { emit({ t: "agent", agent: record }); entry.lastJson = json; }
    const events = entry.sent ? entry.pending : entry.ring.last(LIMITS.initialEventsPerAgent);
    entry.pending = [];
    entry.sent = true;
    sendEvents(record.key, events);
  }

  function flush() {
    if (stopped) return;
    for (const key of goneKeys) { emit({ t: "gone", agent: key }); goneKeys.delete(key); }
    if (dirty.size === 0) return;
    const list = [...dirty].sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const entry of list) {
      if (congested?.()) return; // the rest stays dirty and goes out when the transport drains
      dirty.delete(entry);
      entry.dirty = false;
      if (entry.removed || !entry.loaded) continue;
      report(entry);
    }
  }

  function statsNow() {
    const s = sessions.stats(), d = discovery.stats();
    return {
      agents: s.loaded, hot: s.hot, warm: s.entries - s.hot, files: d.tracked, old: d.old, dirs: d.dirs, roots: d.roots,
      procs: procState.scan?.procs.length ?? 0, scans: d.scans, scanMs: d.lastScanMs, polls: s.polls, reads: s.reads,
      rssMb: Math.round(process.memoryUsage().rss / 1048576), uptimeMs: now() - startedAt, pendingAgents: dirty.size,
      sent: { ...sent }, errors: s.errors,
    };
  }

  // ---------------------------------------------------------------------------------------------------- procs
  function sessionViews() {
    const views = [];
    for (const entry of sessions.all()) {
      const record = entry.record;
      if (!entry.loaded || !record) continue;
      const parent = record.parent;
      views.push({
        key: entry.key, kind: entry.kind, id: entry.id, role: record.role ?? entry.role, file: entry.file, realFile: entry.realFile,
        cwd: record.cwd, startedAt: record.startedAt, updatedAt: record.updatedAt, turnOpen: record.live?.turnOpen === true,
        parentKey: parent?.key ?? (parent?.via === "file" ? agentKey(host.id, parent.kind, parent.id) : null),
        lockKey: entry.lockKey ?? null,
      });
    }
    return views;
  }

  /** Bind the latest process scan to the sessions known now; no I/O. */
  function rebind() {
    const scan = procState.scan;
    if (!scan || !scan.ok) return;
    const result = bindProcs(sessionViews(), scan);
    procState.bindings = result.bindings;
    for (const entry of sessions.all()) {
      const binding = result.bindings.get(entry.key) ?? null;
      const before = `${entry.match?.pid ?? ""}:${entry.match?.how ?? ""}:${JSON.stringify(entry.match?.hint ?? null)}`;
      const after = `${binding?.pid ?? ""}:${binding?.how ?? ""}:${JSON.stringify(binding?.hint ?? null)}`;
      entry.match = binding;
      const wasBound = entry.bound;
      entry.bound = binding !== null;
      if (before !== after || entry.liveKey !== `${aliveOf(entry)}:${binding?.pid ?? ""}`) markDirty(entry);
      if (entry.bound && !wasBound) sessions.wake(entry);
    }
    const json = JSON.stringify(result.procs);
    if (json !== lastProcsJson) { lastProcsJson = json; emit({ t: "procs", procs: result.procs }); }
    for (const path of result.adopt.paths) discovery.adopt(path).catch(() => {});
    for (const { kind, id } of result.adopt.ids) discovery.findById(kind, id).then(path => path && discovery.adopt(path)).catch(() => {});
  }

  function rebindSoon() {
    if (rebindTimer || stopped) return;
    rebindTimer = setTimeout(() => { rebindTimer = null; try { rebind(); } catch (error) { log(`rebind failed: ${error.message}`); } }, 250);
    rebindTimer.unref?.();
  }

  async function procTick() {
    if (procsRunning || stopped || !procsScanner) return;
    procsRunning = true;
    try {
      const scan = await procsScanner.scan();
      if (!scan || stopped) return;
      const wasOk = procState.ok;
      procState = { ...procState, ok: scan.ok, scan };
      if (scan.ok && scan.locks) {
        for (const entry of sessions.all()) if (entry.kind === "dsh" && entry.loaded) entry.lockKey = await procsScanner.lockKeyOf(dirname(entry.realFile ?? entry.file));
      }
      if (scan.ok) rebind();
      if (wasOk !== scan.ok) for (const entry of sessions.all()) markDirty(entry);
    } catch (error) { log(`process scan failed: ${error.message}`); } finally { procsRunning = false; }
  }

  /** Time-driven status changes: an open turn whose process is gone becomes stale after 5 quiet minutes. */
  function derivedTick() {
    if (!procState.ok) return;
    const t = now();
    for (const entry of sessions.all()) {
      const record = entry.record;
      if (!entry.loaded || !record || entry.match !== null) continue;
      const lastActivity = Math.max(record.updatedAt ?? 0, entry.mtimeMs);
      if ((record.status === "running" || record.status === "waiting") && t - lastActivity >= STALE_MS && entry.staleMark !== lastActivity) { entry.staleMark = lastActivity; markDirty(entry); }
    }
  }

  // ------------------------------------------------------------------------------------------------- requests
  async function agentEvents({ key, before, limit } = {}) {
    const entry = typeof key === "string" ? sessions.byKey(key) : null;
    if (!entry) throw coded("not_found", `unknown agent ${key}`);
    const cap = Math.max(1, Math.min(Number.isFinite(Number(limit)) ? Number(limit) : 200, 1000));
    const bound = Number.isFinite(Number(before)) && before !== null && before !== undefined ? Number(before) : Infinity;
    const pick = list => list.filter(event => event.t < bound);
    let candidates = pick(entry.ring.all());
    if (entry.ring.evicted && candidates.length <= cap) candidates = pick(await sessions.readEvents(entry));
    return { key, events: candidates.slice(-cap), hasMore: candidates.length > cap || (entry.ring.evicted && candidates.length === cap) };
  }

  async function handleRequest(method, params) {
    switch (method) {
      case "ping": return { at: now() };
      case "file.read": return readFilePreview({ path: params?.path, maxBytes: params?.maxBytes, host: host.id, home });
      case "agent.events": return agentEvents(params ?? {});
      default: throw coded("unsupported", `unknown collector method ${method}`);
    }
  }

  // ----------------------------------------------------------------------------------------------- lifecycle
  const every = (fn, ms) => { const timer = setInterval(() => { try { const result = fn(); result?.catch?.(error => log(`${fn.name || "timer"} failed: ${error.message}`)); } catch (error) { log(`${fn.name || "timer"} failed: ${error.message}`); } }, ms); timer.unref?.(); timers.push(timer); };

  emit({ t: "hello", proto: PROTOCOL_VERSION, host, at: now() });
  sessions.start();
  discovery.start();
  acp.start();
  every(flush, tick.flushMs);
  every(function heartbeat() { emit({ t: "heartbeat", at: now(), stats: statsNow() }); }, tick.heartbeatMs);
  every(derivedTick, tick.derivedMs);
  if (procsScanner) { every(procTick, tick.procsMs); procTick(); }

  return {
    handleRequest,
    stats: statsNow,
    /** Stop everything; nothing is sent afterwards. */
    stop() {
      if (stopped) return;
      stopped = true;
      for (const timer of timers) clearInterval(timer);
      clearTimeout(rebindTimer);
      discovery.stop(); sessions.stop(); acp.stop();
    },
    /** A new hub connection: say hello again and resend every record, its recent events and the process list. */
    resync(newSend) {
      if (stopped) return;
      out = newSend;
      lastProcsJson = null;
      goneKeys.clear();
      acp.replay();
      emit({ t: "hello", proto: PROTOCOL_VERSION, host, at: now() });
      for (const entry of sessions.all()) { entry.sent = false; entry.lastJson = ""; entry.pending = []; if (entry.loaded) markDirty(entry); }
      if (procState.scan?.ok) rebind();
    },
  };
}
