// Hub repo tracker: which git work tree do the file targets of each host live in?
//
// The tracker learns the paths of the `file` targets the state indexes, batches them per host and asks that host's
// collector (`repo.resolve`, Contract B) over the same collector link the file previews use, so the in-process,
// socket / ssh-relay and kubectl-exec collectors all take one path. It caches dir → root (positive and negative),
// re-reads the branch/remote of every known root every few minutes, and backs off per host on errors — and for a
// long time on a collector that answers "unknown collector method" (an old build that will not learn it until it is
// updated).
//
// Ingest never waits: `observe` only queues path names; requests run afterwards, off the ingest call stack, and every
// failure stays inside this module. Hosts an upstream hub owns are not resolved here — their repo lists arrive with
// that hub's snapshot and deltas.
import { LOCAL, sanitizeRepo } from "./state.mjs";

/** Tunables, exported so tests and the report can name the numbers instead of rediscovering them. */
export const REPO_TRACKER_LIMITS = Object.freeze({
  batchMs: 200,                 // coalesce a burst of tool calls into one request
  dirTtlMs: 5 * 60_000,         // a dir → root answer is reused this long (a new repo below it shows up within 5 min)
  negativeTtlMs: 60_000,        // "not in a repository" is re-asked sooner (a checkout may be created)
  refreshMs: 3 * 60_000,        // known roots are re-read this often (branch/HEAD move)
  retryMs: 30_000,              // first delay after a failed request
  maxRetryMs: 5 * 60_000,       // cap of the exponential error backoff
  unsupportedMs: 30 * 60_000,   // a collector without repo.resolve is not asked again for this long
  requestTimeoutMs: 20_000,
  maxDirsPerRequest: 200,       // collector cap: ≤ 200 dirs per request
  maxRootsPerRequest: 200,      // collector cap: ≤ 200 roots per request
  maxRootsPerHost: 500,         // bound of the cached root set of one host
  maxPendingPerHost: 2000,      // bound of not-yet-asked dirs of one host
  maxCachedDirsPerHost: 4000,   // bound of the dir cache of one host
});

/**
 * @param {object} options
 * @param {ReturnType<import("./state.mjs").createState>} options.state
 * @param {{has(id: string): boolean, request(id: string, method: string, params: object, options?: object): Promise<any>}} options.links
 * @param {() => number} [options.now]
 * @param {(level: string, message: string) => void} [options.log]
 * @param {{setTimeout: Function, clearTimeout: Function}} [options.timers]
 * @returns {{
 *   observe(agentKey: string, event: object): void,
 *   flush(): Promise<void>,
 *   tick(): void,
 *   stop(): void,
 *   stats(): object,
 * }}
 */
export function createRepoRegistry({ state, links, now = Date.now, log = () => {}, timers = globalThis, ...options } = {}) {
  const limits = { ...REPO_TRACKER_LIMITS, ...options };
  const hostStates = new Map();      // host id → per-host queues, caches and backoff
  let timer = null;
  let stopped = false;

  function hostState(host) {
    let h = hostStates.get(host);
    if (h === undefined) {
      h = {
        dirs: new Map(),             // dir → {root: string|null, until: number}
        roots: new Map(),            // root → {info: Repo, at: number}   (at = last successful read)
        pending: new Set(),          // dirs the collector has not answered for yet
        retryAt: 0,
        failures: 0,
        unsupportedUntil: 0,
        connectedAt: undefined,
        inflight: false,
        requests: 0,
        errors: 0,
      };
      hostStates.set(host, h);
    }
    return h;
  }

  /** A fresh hello from the host's collector clears the backoff: the new process may well know the method. */
  function refreshConnection(h, host) {
    const connectedAt = state.host(host)?.connectedAt;
    if (connectedAt === h.connectedAt) return;
    h.connectedAt = connectedAt;
    h.failures = 0;
    h.retryAt = 0;
    h.unsupportedUntil = 0;
  }

  function askable(host, h, t) {
    if (stopped || !links.has(host) || state.originOf(host) !== LOCAL) return false;
    refreshConnection(h, host);
    return t >= h.retryAt && t >= h.unsupportedUntil;
  }

  function clearTimer() {
    if (timer === null) return;
    timers.clearTimeout(timer);
    timer = null;
  }

  function schedule() {
    if (stopped || timer !== null) return;
    timer = timers.setTimeout(() => {
      timer = null;
      flush().catch(error => log("warn", `repo tracker flush failed: ${error?.message ?? error}`));
    }, limits.batchMs);
    timer?.unref?.();
  }

  /**
   * Queue the directories of an event's file targets. Called from the state for every stored event, so it must stay
   * synchronous and must never throw into ingest.
   * @param {string} agentKey
   * @param {{targets?: Array<{type?: string, host?: string, path?: string}>}} event
   */
  function observe(agentKey, event) {
    if (stopped) return;
    const targets = event?.targets;
    if (!Array.isArray(targets) || targets.length === 0) return;
    const agentHost = state.agent(agentKey)?.host;
    let queued = false;
    for (const target of targets) {
      if (target === null || typeof target !== "object" || target.type !== "file") continue;
      const path = target.path;
      if (typeof path !== "string" || !path.startsWith("/")) continue;
      const host = typeof target.host === "string" && target.host !== "" ? target.host : agentHost;
      if (typeof host !== "string" || host === "") continue;
      if (state.originOf(host) !== LOCAL) continue;          // mirrored host: its repos come from the upstream hub
      if (!links.has(host)) continue;                        // no collector to ask (a pod without one)
      const h = hostState(host);
      const cached = h.dirs.get(path);
      if (cached !== undefined && now() < cached.until) continue;
      if (h.pending.size >= limits.maxPendingPerHost && !h.pending.has(path)) continue;
      if (!h.pending.has(path)) { h.pending.add(path); queued = true; }
    }
    if (queued) schedule();
  }

  /** Dirs to ask for and roots that are due for a branch refresh, each bounded by the collector caps. */
  function collectWork(h, t) {
    const dirs = [];
    for (const dir of h.pending) {
      if (dirs.length >= limits.maxDirsPerRequest) break;
      const cached = h.dirs.get(dir);
      if (cached !== undefined && t < cached.until) { h.pending.delete(dir); continue; }
      dirs.push(dir);
    }
    const roots = [];
    for (const [root, entry] of h.roots) {
      if (roots.length >= limits.maxRootsPerRequest) break;
      if (t - entry.at >= limits.refreshMs) roots.push(root);
    }
    return { dirs, roots };
  }

  function pruneHost(h, refreshed) {
    while (h.dirs.size > limits.maxCachedDirsPerHost) {
      const oldest = h.dirs.keys().next().value;
      if (oldest === undefined) break;
      h.dirs.delete(oldest);
    }
    const used = new Set();
    for (const entry of h.dirs.values()) if (entry.root !== null) used.add(entry.root);
    for (const root of h.roots.keys()) if (!used.has(root) && !refreshed.has(root)) h.roots.delete(root);
    while (h.roots.size > limits.maxRootsPerHost) {
      const oldest = h.roots.keys().next().value;
      if (oldest === undefined) break;
      h.roots.delete(oldest);
    }
  }

  /** Store one collector answer: dir → root cache, root metadata, and the full list of the host. */
  function applyReply(host, h, dirs, requestedRoots, reply) {
    const t = now();
    const reported = new Map();
    for (const entry of Array.isArray(reply?.repos) ? reply.repos : []) {
      const repo = sanitizeRepo(entry);
      if (repo !== null) reported.set(repo.root, repo);
    }
    for (const root of requestedRoots) if (!reported.has(root)) h.roots.delete(root);   // no longer a repository

    const dirsReply = reply?.dirs !== null && typeof reply?.dirs === "object" && !Array.isArray(reply?.dirs) ? reply.dirs : {};
    for (const dir of dirs) {
      const raw = Object.prototype.hasOwnProperty.call(dirsReply, dir) ? dirsReply[dir] : null;
      const root = typeof raw === "string" && raw.startsWith("/") ? raw : null;
      h.pending.delete(dir);
      h.dirs.set(dir, { root, until: t + (root === null ? limits.negativeTtlMs : limits.dirTtlMs) });
      if (root !== null && !reported.has(root)) {
        const known = h.roots.get(root);
        if (known !== undefined) reported.set(root, known.info);        // metadata from an earlier batch; refresh queued
        else h.roots.set(root, { info: { root }, at: 0 });              // branch/remote on the next batch
      }
    }
    for (const [root, info] of reported) h.roots.set(root, { info, at: t });
    pruneHost(h, new Set(reported.keys()));

    const list = [...h.roots.values()].map(entry => entry.info)
      .sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
    state.setRepos(host, list);
    if (h.pending.size > 0) schedule();
  }

  async function flushHost(host, h) {
    if (stopped || h.inflight) return;
    const t = now();
    if (!askable(host, h, t)) return;
    const { dirs, roots } = collectWork(h, t);
    if (dirs.length === 0 && roots.length === 0) return;
    h.inflight = true;
    h.requests += 1;
    try {
      const reply = await links.request(host, "repo.resolve", { dirs, roots }, { timeoutMs: limits.requestTimeoutMs });
      if (!stopped) applyReply(host, h, dirs, roots, reply);
      h.failures = 0;
      h.retryAt = 0;
      h.unsupportedUntil = 0;
    } catch (error) {
      if (stopped) return;
      h.errors += 1;
      const code = error?.code;
      if (code === "unsupported" || /unknown collector method|unsupported method/i.test(String(error?.message ?? ""))) {
        h.unsupportedUntil = now() + limits.unsupportedMs;
        log("info", `collector ${host} has no repo.resolve (old build); asking again in ${Math.round(limits.unsupportedMs / 60_000)} min`);
      } else if (code === "offline") {
        h.retryAt = now() + limits.retryMs;                  // the channel is gone; pending work waits for it
      } else {
        h.failures += 1;
        h.retryAt = now() + Math.min(limits.maxRetryMs, limits.retryMs * 2 ** (h.failures - 1));
        log("warn", `repo.resolve on ${host} failed: ${error?.message ?? error}`);
      }
    } finally {
      h.inflight = false;
    }
  }

  const dueRoots = (h, t) => { for (const entry of h.roots.values()) if (t - entry.at >= limits.refreshMs) return true; return false; };

  /** Send everything queued, one request per host; resolves when every request settled. */
  async function flush() {
    clearTimer();
    if (stopped) return;
    const t = now();
    const tasks = [];
    for (const [host, h] of hostStates) {
      if (h.pending.size === 0 && !dueRoots(h, t)) continue;
      tasks.push(flushHost(host, h));
    }
    await Promise.allSettled(tasks);
  }

  /** Periodic nudge: starts a batch when fresh work exists (also after a backoff expired). */
  function tick() {
    if (stopped) return;
    const t = now();
    for (const [host, h] of hostStates) {
      if (h.pending.size === 0 && !dueRoots(h, t)) continue;
      if (askable(host, h, t)) { schedule(); return; }
    }
  }

  function stats() {
    const hosts = {};
    let requests = 0, errors = 0;
    for (const [host, h] of hostStates) {
      requests += h.requests;
      errors += h.errors;
      hosts[host] = {
        dirs: h.dirs.size, roots: h.roots.size, pending: h.pending.size,
        requests: h.requests, errors: h.errors, retryAt: h.retryAt,
        unsupportedUntil: h.unsupportedUntil, inflight: h.inflight,
      };
    }
    return { requests, errors, hosts };
  }

  function stop() {
    stopped = true;
    clearTimer();
  }

  return { observe, flush, tick, stop, stats };
}