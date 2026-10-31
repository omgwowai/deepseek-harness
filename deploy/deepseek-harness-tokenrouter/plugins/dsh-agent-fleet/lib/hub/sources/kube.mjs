// Kube source (runs in the server hub). Keeps a compact, live list of the *active* pods of one namespace on every fleet
// cluster by driving kubectl: per site a `get pods` list, then a long-lived `get pods --watch --output-watch-events`,
// both limited by a field selector to non-terminal pods (weihai holds thousands of finished pods). Pods that already
// completed are resolved on demand by `getPod` (60 s LRU cache). Pods labelled agent-fleet.omgwow.ai/collect=true get
// the collector bundle pushed in and a `kubectl exec -i … node collector` spawn spec handed to the hub through
// `attachCollector`. Also on demand: pod file previews (`readPodFile`) and kube events (`podEvents`).
// Every kubectl call names --kubeconfig, --context and -n explicitly; the kubeconfig is never read, logged or sent.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { signalChild } from "../../channel.mjs";
import { COLLECT_LABEL, KUBE_CONTEXTS, LIMITS, NAMESPACE, podHostId, podKey } from "../../protocol.mjs";
import { isSecretPath, loadKnownSecrets, redact, redactText, secretContentDenial } from "../../redact.mjs";

const ACTIVE_ONLY = "--field-selector=status.phase!=Succeeded,status.phase!=Failed";
const REQUEST_TIMEOUT = "--request-timeout=15s";
const CONTAINER_LABEL = "agent-fleet.omgwow.ai/container";
const GPU = "nvidia.com/gpu";
const REMOTE_DIR = "/tmp/agent-fleet";
const REMOTE_BUNDLE = `${REMOTE_DIR}/collector.mjs`;
const MIN_NODE_MAJOR = 22;
const MAX_ATTACHES = 4;
const STDERR_TAIL = 4096;
const ONESHOT_BYTES = 4 * 1024 * 1024;
const MAX_EVENTS = 100;
const MAX_LABELS = 32;
const REPLAY_MAX_MS = 10_000; // a watch's initial replay is over for sure this long after it started
// Remote scripts are constants; the only variable input (a file path) travels as a positional parameter.
const PROBE_SCRIPT = `command -v node && node -v; echo ---; sha256sum ${REMOTE_BUNDLE} 2>/dev/null; true`;
const PUSH_SCRIPT = `mkdir -p ${REMOTE_DIR} && cat > ${REMOTE_BUNDLE}.part && mv ${REMOTE_BUNDLE}.part ${REMOTE_BUNDLE} && echo PUSHED; sha256sum ${REMOTE_BUNDLE} 2>/dev/null; true`;
// Constant script; the path is $1 and the byte cap $2 (positional parameters, never interpolated). Exit 3 + a marker word when
// there is nothing to read. `stat -L`, `readlink -f` and `head` follow symlinks (/etc/os-release is one); the first output line
// is "<size> <mtime> <resolved path>", so the hub can refuse a harmless-looking link to a credentials file. The hub checks the
// resolved path case-insensitively (APFS is case-insensitive), re-checks it after the read and refuses fleet-token content.
const FILE_SCRIPT = `f=$1; [ -f "$f" ] || { if [ -d "$f" ]; then echo ISDIR; elif [ -e "$f" ]; then echo NOTFILE; else echo NOFILE; fi; exit 3; }; printf '%s %s\\n' "$(stat -L -c "%s %Y" "$f")" "$(readlink -f -- "$f" 2>/dev/null)"; head -c "$2" "$f"`;
const PSEUDO_FS = /^\/(?:proc|sys|dev)(?:\/|$)/;
const POD_NAME = /^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/;
const CONTAINER_NAME = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const SECRET_DENIED = "secret path: credentials are never previewed";

// ── Streaming JSON splitter ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Splits a stream of JSON text into the objects nested exactly `depth` levels deep, without ever holding more than the
 * object being captured.
 * depth 1: top-level objects, glued or pretty-printed over many lines (a `--watch -o json` stream).
 * depth 3: the elements of `items` in a kubectl List (`{"items": [{…}, …]}`), delivered one by one.
 * Braces, brackets and quotes inside strings (escaped or not) are ignored; chunks may end anywhere, even inside an
 * escape or a multi-byte character. Objects of any size up to `maxBytes` (default LIMITS.lineBytes) are delivered whole.
 * @param {(json: string) => void} onValue
 * @param {{depth?: number, maxBytes?: number}} [options]
 * @returns {{write(chunk: string | Buffer): void, end(): {complete: boolean, values: number, closed: number}}}
 */
export function createJsonSplitter(onValue, { depth = 1, maxBytes = LIMITS.lineBytes } = {}) {
  const decoder = new StringDecoder("utf8");
  let level = 0, inString = false, escaped = false, capturing = false;
  let parts = [], held = 0, values = 0, closed = 0;

  const scan = text => {
    let from = capturing ? 0 : -1;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (inString) {
        if (escaped) escaped = false;
        else if (c === 92) escaped = true; // \
        else if (c === 34) inString = false; // "
        continue;
      }
      if (c === 34) inString = true;
      else if (c === 123) { if (++level === depth) { capturing = true; from = i; } } // {
      else if (c === 91) level++; // [
      else if (c === 125 || c === 93) { // } ]
        if (level === 0) continue;
        if (c === 125 && capturing && level === depth) {
          const piece = text.slice(from, i + 1);
          const value = parts.length > 0 ? parts.join("") + piece : piece;
          parts = []; held = 0; capturing = false; values++;
          onValue(value);
        }
        if (--level === 0) closed++;
      }
    }
    if (capturing) {
      held += text.length - from;
      if (held > maxBytes) throw new Error(`JSON object larger than ${maxBytes} bytes`);
      parts.push(from === 0 ? text : text.slice(from));
    }
  };

  return {
    write(chunk) { scan(typeof chunk === "string" ? chunk : decoder.write(chunk)); },
    /** `complete` is false when the input stopped inside a value; `closed` counts finished top-level values. */
    end() {
      const rest = decoder.end();
      if (rest) scan(rest);
      return { complete: level === 0 && !inString && !capturing, values, closed };
    },
  };
}

// ── Pod compaction ─────────────────────────────────────────────────────────────────────────────────────────────────

const ms = value => { const t = typeof value === "string" ? Date.parse(value) : NaN; return Number.isFinite(t) ? t : undefined; };
const UNITS = { n: 1e-9, u: 1e-6, m: 1e-3, "": 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18, Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 };

/** Kubernetes quantity ("500m", "4Gi", "1e3") → number, NaN when unparsable. */
function quantity(text) {
  const match = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))(?:[eE]([+-]?\d+)|(Ki|Mi|Gi|Ti|Pi|Ei|[numkMGTPE])?)$/.exec(String(text).trim());
  if (!match) return NaN;
  const base = Number(match[1]);
  return match[2] !== undefined ? base * 10 ** Number(match[2]) : base * UNITS[match[3] ?? ""];
}
const cpuText = cores => Number.isInteger(cores) ? String(cores) : `${Math.round(cores * 1000)}m`;
const memoryText = bytes => {
  const whole = Math.round(bytes);
  for (const [unit, size] of [["Gi", 2 ** 30], ["Mi", 2 ** 20], ["Ki", 2 ** 10]]) if (whole >= size && whole % size === 0) return `${whole / size}${unit}`;
  return String(whole);
};
/** One value stays verbatim ("500m", "128Mi"); several are summed. */
function sumQuantities(values, format) {
  const present = values.filter(v => v !== undefined && v !== null && v !== "");
  if (present.length === 0) return undefined;
  if (present.length === 1) return String(present[0]);
  const total = present.reduce((sum, v) => sum + quantity(v), 0);
  return Number.isFinite(total) ? format(total) : String(present[0]);
}
function podRequests(spec) {
  const containers = spec?.containers ?? [];
  const requests = {};
  const cpu = sumQuantities(containers.map(c => c.resources?.requests?.cpu), cpuText);
  const memory = sumQuantities(containers.map(c => c.resources?.requests?.memory), memoryText);
  const gpu = containers.reduce((sum, c) => sum + (Number(c.resources?.requests?.[GPU] ?? c.resources?.limits?.[GPU]) || 0), 0);
  if (cpu !== undefined) requests.cpu = cpu;
  if (memory !== undefined) requests.memory = memory;
  if (gpu > 0) requests.gpu = gpu;
  return requests;
}

/** "Running", or the waiting/terminated reason: CrashLoopBackOff, ContainerCreating, Completed, Error, OOMKilled … */
function containerState(state) {
  if (state?.running) return "Running";
  if (state?.waiting) return state.waiting.reason || "Waiting";
  if (state?.terminated) return state.terminated.reason || (state.terminated.exitCode === 0 ? "Completed" : "Error");
  return "Unknown";
}

/** Why a pod is not simply Running/Completed: Evicted (status.reason), Terminating, Init:Error, Init:0/2, Unschedulable … */
function podReason(raw, phase) {
  const status = raw.status ?? {};
  if (status.reason) return String(status.reason);
  if (raw.metadata?.deletionTimestamp && phase !== "Succeeded" && phase !== "Failed") return "Terminating";
  const inits = status.initContainerStatuses ?? [];
  for (let i = 0; i < inits.length; i++) {
    const state = inits[i].state ?? {};
    if (state.terminated?.exitCode === 0) continue;
    if (state.terminated) return `Init:${state.terminated.reason || `ExitCode:${state.terminated.exitCode}`}`;
    if (state.waiting?.reason && state.waiting.reason !== "PodInitializing") return `Init:${state.waiting.reason}`;
    return `Init:${i}/${inits.length}`;
  }
  return phase === "Pending" ? (status.conditions ?? []).find(c => c.type === "PodScheduled" && c.status === "False")?.reason || undefined : undefined;
}

/** When a finished pod finished: its last container exit, else its last condition change. */
function finishedAt(status) {
  const latest = times => times.reduce((best, t) => t !== undefined && (best === undefined || t > best) ? t : best, undefined);
  return latest((status.containerStatuses ?? []).map(s => ms(s.state?.terminated?.finishedAt)))
    ?? latest((status.conditions ?? []).map(c => ms(c.lastTransitionTime)));
}

/** The container a collector would run in: label agent-fleet.omgwow.ai/container, else the first one. */
function collectorTarget(raw) {
  const names = (raw.spec?.containers ?? []).map(c => c.name);
  const name = raw.metadata?.labels?.[CONTAINER_LABEL] || names[0];
  if (!name || !names.includes(name)) return { name: name ?? "", id: "", running: false, error: `container "${name ?? ""}" not found` };
  const status = (raw.status?.containerStatuses ?? []).find(s => s.name === name);
  return { name, id: status?.containerID ?? "", running: Boolean(status?.state?.running) };
}

/**
 * Raw v1 Pod → protocol `Pod` (see lib/protocol.mjs), plus optional `reason` (Evicted, Terminating, Init:Error …) and
 * `finishedAt` (finished pods only).
 * @param {object} raw
 * @param {{site: string, cluster: string, namespace?: string}} where
 */
export function compactPod(raw, { site, cluster, namespace = NAMESPACE }) {
  const meta = raw.metadata ?? {}, spec = raw.spec ?? {}, status = raw.status ?? {};
  const ns = meta.namespace ?? namespace, name = String(meta.name ?? "");
  const phase = String(status.phase || "Unknown");
  const statuses = new Map((status.containerStatuses ?? []).map(s => [s.name, s]));
  const containers = (spec.containers ?? []).map(c => {
    const s = statuses.get(c.name);
    return { name: String(c.name), image: String(c.image ?? ""), ready: s?.ready === true, state: s ? containerState(s.state) : phase === "Pending" ? "Pending" : "Unknown", restarts: s?.restartCount ?? 0 };
  });
  const labels = meta.labels ?? {};
  const owner = (meta.ownerReferences ?? []).find(o => o.controller) ?? meta.ownerReferences?.[0];
  const pod = {
    key: podKey(site, ns, name), site, cluster, namespace: ns, name, phase,
    ready: `${containers.filter(c => c.ready).length}/${containers.length}`,
    restarts: containers.reduce((sum, c) => sum + c.restarts, 0),
    containers,
    requests: podRequests(spec),
    labels: Object.fromEntries(Object.entries(labels).slice(0, MAX_LABELS).map(([k, v]) => [k, String(v).slice(0, 128)])),
    collect: labels[COLLECT_LABEL] === "true",
  };
  if (spec.nodeName) pod.node = spec.nodeName;
  if (status.podIP) pod.podIP = status.podIP;
  const createdAt = ms(meta.creationTimestamp), startedAt = ms(status.startTime), deletedAt = ms(meta.deletionTimestamp);
  if (createdAt !== undefined) pod.createdAt = createdAt;
  if (startedAt !== undefined) pod.startedAt = startedAt;
  if (deletedAt !== undefined) pod.deletedAt = deletedAt;
  if (owner) pod.owner = { kind: String(owner.kind), name: String(owner.name) };
  const reason = podReason(raw, phase);
  if (reason) pod.reason = reason;
  if (phase === "Succeeded" || phase === "Failed") {
    const end = finishedAt(status);
    if (end !== undefined) pod.finishedAt = end;
  }
  return pod;
}

// ── kubectl output helpers ─────────────────────────────────────────────────────────────────────────────────────────

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
/** JSON.parse that does not echo a slice of the (possibly sensitive) text into its error. */
function parseJson(text, what) {
  try { return JSON.parse(text); } catch { throw new Error(`${what} returned invalid JSON`); }
}

/** `command -v node && node -v; echo ---; sha256sum bundle` output → node path/version/major and the remote bundle hash. */
function parseProbe(stdout) {
  const lines = stdout.split("\n").map(line => line.trim());
  const sep = lines.indexOf("---");
  if (sep < 0) throw new AttachError(`probe failed: unexpected output`);
  const [path, version] = lines.slice(0, sep).filter(Boolean);
  const major = /^v?(\d+)\./.exec(version ?? "")?.[1];
  return { node: path ?? null, version: version ?? "", major: major === undefined ? null : Number(major), sha: lines.slice(sep + 1).find(l => /^[0-9a-f]{64}(\s|$)/.test(l))?.slice(0, 64) ?? null };
}

function isBinary(bytes) {
  if (bytes.subarray(0, 8192).includes(0)) return true;
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true }); return false; } catch { return true; }
}

function compactEvent(event) {
  const first = ms(event.firstTimestamp) ?? ms(event.eventTime) ?? ms(event.metadata?.creationTimestamp);
  const last = ms(event.lastTimestamp) ?? ms(event.series?.lastObservedTime) ?? ms(event.eventTime) ?? first;
  return { type: String(event.type ?? "Normal"), reason: String(event.reason ?? ""), message: redactText(event.message ?? "", LIMITS.textChars), count: event.count ?? event.series?.count ?? 1, firstAt: first, lastAt: last };
}

class AttachError extends Error {
  constructor(message, permanent = false) { super(message); this.permanent = permanent; }
}
/** The watch stream carried an ERROR event (e.g. 410 Gone): restart the cycle, the cluster itself is fine. */
class WatchRestart extends Error {}

// ── The source ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} options
 * @param {string} options.kubeconfig  path of the kubeconfig (passed to kubectl, never read)
 * @param {string} [options.kubectl]   kubectl binary
 * @param {Record<string, string>} [options.sites]  site → kube context (default KUBE_CONTEXTS)
 * @param {string} [options.namespace]
 * @param {string | Uint8Array} [options.collectorBundle]  path of dist/agent-fleet-collector.mjs, or its bytes
 * @param {(site: string, pods: object[], state: "list" | "watch") => void} [options.onPods]
 *        "list": the complete active pod set of the site after a (re)list; "watch": changed pods only
 * @param {(site: string, key: string) => void} [options.onPodGone]  a pod left the active set (deleted or finished)
 * @param {(site: string, state: {status: "online" | "unreachable", error: string, since: number}) => void} [options.onSourceState]
 * @param {(site: string, pod: object, spec: {command: string, args: string[], label: string, hostId: string}) => any} [options.attachCollector]
 *        open the collector channel described by `spec`; may return a handle (`stop()`/`close()` or a function) that is
 *        released when the pod goes away, stops running or its container restarts
 * @param {() => number} [options.now]
 * Tuning (tests): backoffMs [min, max] for failed cycles; healthyMs a watch must live to count as healthy (resets the backoff,
 * and an earlier failure marks the site unreachable); confirmMs a restarted watch must survive before an unreachable site is
 * called online again; quietMs of silence that end the watch's initial replay; listTimeoutMs; lookupTtlMs / lookupCacheSize
 * for getPod; attachRetryMs delays between quick collector attach retries, reprobeMs the slow cadence after those.
 */
export function createKubeSource({
  kubeconfig, kubectl = "kubectl", sites = KUBE_CONTEXTS, namespace = NAMESPACE, collectorBundle,
  onPods, onPodGone, onSourceState, attachCollector, now = Date.now,
  backoffMs = [2000, 60_000], healthyMs = 20_000, confirmMs = 3000, quietMs = 1500, listTimeoutMs = 120_000,
  lookupTtlMs = 60_000, lookupCacheSize = 512, attachRetryMs = [5000, 15_000, 45_000, 60_000], reprobeMs = 300_000,
} = {}) {
  if (typeof kubeconfig !== "string" || kubeconfig === "") throw new TypeError("createKubeSource: kubeconfig path is required");
  const canAttach = typeof attachCollector === "function" && collectorBundle !== undefined && collectorBundle !== null;
  const newBatch = () => ({ upserts: new Map(), gone: new Map() });
  const states = new Map(Object.entries(sites).map(([name, context]) => [name, {
    name, context, status: "connecting", error: "", since: now(), active: new Map(), batch: newBatch(),
    children: new Set(), timer: null, wake: null, loop: null, lastWatchError: "", internalError: "", watchGen: 0, replay: null, watchFailed: "",
    stats: { lists: 0, watches: 0, restarts: 0, events: {}, changed: 0, replayed: 0, lastListAt: null, lastEventAt: null },
  }]));
  let started = false, stopped = false, bundleCache = null;
  const lookups = new Map(); // `${site}/${name}` → {at, pod|null}; Map order is the LRU order
  const lookupsInFlight = new Map();

  const baseArgs = s => ["--kubeconfig", kubeconfig, "--context", s.context, "-n", namespace];
  const clean = text => redactText(String(text ?? "").split(kubeconfig).join("<kubeconfig>"), 800);
  const lookupKey = (site, name) => `${site}/${name}`;
  const trap = (s, error) => { s.internalError = clean(error?.message); };
  const notify = (s, fn, ...args) => { try { fn?.(...args); } catch (error) { trap(s, error); } };
  const view = entry => {
    const out = { ...entry.pod }, c = entry.collector;
    if (c.attached) out.hostId = podHostId(entry.pod.site, entry.name);
    if (c.status) out.collector = c.status;
    return out;
  };
  const byName = (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  const knownSite = site => {
    const s = states.get(site);
    if (!s) throw new Error(`unknown kube site: ${site}`);
    return s;
  };

  // kubectl processes ------------------------------------------------------------------------------------------------

  /** Short call with buffered output (stdout capped). Never rejects; `code` is the exit code (-1: could not run). */
  function runKubectl(s, args, { input, timeoutMs = 20_000, maxBytes = ONESHOT_BYTES } = {}) {
    return new Promise(resolve => {
      if (stopped) return resolve({ code: -1, stdout: Buffer.alloc(0), stderr: "source stopped" });
      const child = spawn(kubectl, [...baseArgs(s), REQUEST_TIMEOUT, ...args], { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
      s.children.add(child);
      const out = [];
      let outBytes = 0, stderr = "", timedOut = false;
      const timer = setTimeout(() => { timedOut = true; signalChild(child, "SIGKILL"); }, timeoutMs);
      child.stdout.on("data", chunk => { if (outBytes < maxBytes) { out.push(chunk); outBytes += chunk.length; } });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-STDERR_TAIL); });
      child.on("error", error => { stderr = `spawn ${kubectl}: ${error.message}`; });
      child.on("close", code => {
        clearTimeout(timer);
        s.children.delete(child);
        resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: timedOut ? `kubectl timed out after ${timeoutMs} ms` : stderr.trim() });
      });
      if (input) { child.stdin.on("error", () => { /* the child exited early; its exit code says why */ }); child.stdin.end(input); }
    });
  }

  /**
   * Long call whose stdout is consumed incrementally. Rejects when `onData` throws, on timeout, when kubectl cannot run or
   * when `control.abort(error)` is called (the caller's way to end the process with a reason).
   */
  function streamKubectl(s, args, { onData, timeoutMs = 0, control }) {
    return new Promise((resolve, reject) => {
      if (stopped) return reject(new Error("source stopped"));
      const child = spawn(kubectl, [...baseArgs(s), ...args], { stdio: ["ignore", "pipe", "pipe"] });
      s.children.add(child);
      let stderr = "", failure = null, timer = null;
      const terminate = () => signalChild(child);
      if (control) control.abort = error => { failure ??= error; terminate(); };
      if (timeoutMs > 0) timer = setTimeout(() => { failure ??= new Error(`kubectl timed out after ${timeoutMs} ms`); terminate(); }, timeoutMs);
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-STDERR_TAIL); });
      child.stdout.on("data", chunk => {
        if (failure) return;
        try { onData(chunk); } catch (error) { failure = error; terminate(); }
      });
      child.on("error", error => { failure ??= new Error(`spawn ${kubectl}: ${error.message}`); });
      child.on("close", code => {
        clearTimeout(timer);
        s.children.delete(child);
        if (failure) reject(failure); else resolve({ code, stderr: stderr.trim() });
      });
    });
  }

  const kubectlError = (result, what) => new Error(clean(result.stderr) || `${what}: kubectl exited with code ${result.code}`);

  // active pod set ---------------------------------------------------------------------------------------------------

  /** Raw pod → record {name, uid, rv, pod, sig, target}; {same:true} when it equals the held entry; {terminal:true} for finished pods. */
  function read(s, raw) {
    const meta = raw?.metadata;
    if (!meta?.name) return null;
    const name = meta.name, uid = meta.uid ?? "", rv = meta.resourceVersion ?? "";
    const held = s.active.get(name);
    if (held && held.uid === uid && held.rv === rv) return { name, same: true };
    const pod = compactPod(raw, { site: s.name, cluster: s.context, namespace });
    if (pod.phase === "Succeeded" || pod.phase === "Failed") return { name, terminal: true };
    const target = pod.collect ? collectorTarget(raw) : null;
    return { name, uid, rv, pod, target, sig: JSON.stringify(pod) + JSON.stringify(target) };
  }

  /** Merges a record into the active set. Returns "changed" | "same" | "removed". */
  function apply(s, rec) {
    const held = s.active.get(rec.name);
    if (rec.terminal) return removeEntry(s, rec.name) ? "removed" : "same";
    if (rec.same) return "same";
    if (held && held.uid === rec.uid) {
      held.rv = rec.rv;
      if (held.sig === rec.sig) return "same"; // only metadata churn (managedFields, heartbeats)
      Object.assign(held, { pod: rec.pod, target: rec.target, sig: rec.sig });
      reconcileCollector(s, held);
      return "changed";
    }
    if (held) removeEntry(s, rec.name); // same name, new uid: the old pod is gone
    const entry = { name: rec.name, uid: rec.uid, rv: rec.rv, pod: rec.pod, target: rec.target, sig: rec.sig, collector: { key: null, generation: 0, attached: false, status: undefined, handle: null, timer: null, attempts: 0 } };
    s.active.set(rec.name, entry);
    reconcileCollector(s, entry);
    return "changed";
  }

  function removeEntry(s, name) {
    const entry = s.active.get(name);
    if (!entry) return null;
    s.active.delete(name);
    stopChannel(entry.collector);
    lookups.delete(lookupKey(s.name, name)); // its final state is not what a cached lookup says
    return entry;
  }

  function commitList(s, records) {
    const present = new Set();
    for (const rec of records) {
      if (!rec || rec.terminal) continue;
      present.add(rec.name);
      apply(s, rec);
    }
    const gone = [];
    for (const name of [...s.active.keys()]) if (!present.has(name)) gone.push(removeEntry(s, name).pod.key);
    s.batch = newBatch();
    for (const key of gone) notify(s, onPodGone, s.name, key);
    notify(s, onPods, s.name, [...s.active.values()].map(view).sort(byName), "list");
  }

  function flush(s) {
    const { upserts, gone } = s.batch;
    if (upserts.size === 0 && gone.size === 0) return;
    s.batch = newBatch();
    for (const key of gone.values()) notify(s, onPodGone, s.name, key);
    if (upserts.size > 0) notify(s, onPods, s.name, [...upserts.values()].map(view), "watch");
  }

  /** An entry changed outside a watch event (collector state): tell the hub now. */
  function markDirty(s, entry) {
    if (stopped || s.active.get(entry.name) !== entry) return;
    s.batch.upserts.set(entry.name, entry);
    flush(s);
  }

  /** Removes a pod from the active set and queues its departure for the hub. */
  function dropPod(s, name) {
    const entry = removeEntry(s, name);
    if (!entry) return false;
    s.batch.upserts.delete(name);
    s.batch.gone.set(name, entry.pod.key);
    return true;
  }

  function onWatchObject(s, text) {
    const event = parseJson(text, "kubectl get pods --watch");
    s.stats.events[event.type] = (s.stats.events[event.type] ?? 0) + 1;
    s.stats.lastEventAt = now();
    if (event.type === "ERROR") throw new WatchRestart(`watch error: ${event.object?.message ?? JSON.stringify(event.object).slice(0, 200)}`);
    if (event.type !== "ADDED" && event.type !== "MODIFIED" && event.type !== "DELETED") return; // BOOKMARK
    const raw = event.object, name = raw?.metadata?.name;
    if (!name) return;
    if (event.type === "DELETED") { dropPod(s, name); return; }
    s.replay?.touch(name);
    const rec = read(s, raw);
    const outcome = apply(s, rec);
    if (outcome === "changed") {
      s.stats.changed++;
      s.batch.gone.delete(name);
      s.batch.upserts.set(name, s.active.get(name));
    } else if (outcome === "removed") {
      s.batch.upserts.delete(name);
      s.batch.gone.set(name, podKey(s.name, namespace, name));
    } else s.stats.replayed++;
  }

  // list / watch cycle -----------------------------------------------------------------------------------------------

  async function listPods(s) {
    const records = [];
    const splitter = createJsonSplitter(text => records.push(read(s, parseJson(text, "kubectl get pods"))), { depth: 3 });
    const result = await streamKubectl(s, [REQUEST_TIMEOUT, "get", "pods", "-o", "json", ACTIVE_ONLY], { onData: chunk => splitter.write(chunk), timeoutMs: listTimeoutMs });
    const end = splitter.end();
    if (result.code !== 0) throw kubectlError(result, "kubectl get pods");
    if (!end.complete || end.closed < 1) throw new Error(clean(result.stderr) || "kubectl get pods returned no JSON list");
    return records;
  }

  /**
   * kubectl's watch first replays every active pod as ADDED, then reports changes; our own list was taken a moment earlier.
   * A pod of that list which the replay never mentions finished or was deleted in between and would stay "active" until the
   * next relist. Once the replay has been quiet for quietMs, one more list settles the doubtful pods. Only removals are
   * applied (a pod seen by the stream meanwhile is kept), so the settling list never replaces the set. No doubtful pod, no call.
   */
  async function settleReplay(s, gen, replay, control) {
    if (replay.phase !== "replaying") return;
    replay.phase = "settling";
    try {
      const doubtful = [...s.active.keys()].filter(name => !replay.seen.has(name));
      if (doubtful.length === 0) return;
      const alive = new Set((await listPods(s)).filter(rec => rec && !rec.terminal).map(rec => rec.name));
      if (stopped || s.watchGen !== gen) return;
      for (const name of doubtful) if (!alive.has(name) && !replay.seen.has(name)) dropPod(s, name);
      flush(s);
    } catch (error) {
      if (!stopped && s.watchGen === gen) control.abort?.(error); // the cluster stopped answering: end the watch, the cycle relists
    } finally {
      replay.phase = "done";
      replay.seen.clear();
    }
  }

  /**
   * Runs the watch until kubectl exits. Resolves true when it lived long enough to count as healthy. Rejects when it died young
   * (and remembers why in watchFailed) or could not be read. An ERROR event in the stream (410 Gone …) just ends the watch.
   */
  async function watchPods(s) {
    const gen = ++s.watchGen, control = {}, began = Date.now();
    const replay = { seen: new Set(), timer: null, phase: "replaying", touch: null };
    const arm = () => {
      clearTimeout(replay.timer);
      replay.timer = setTimeout(() => settleReplay(s, gen, replay, control), quietMs);
      replay.timer.unref?.();
    };
    replay.touch = name => {
      if (replay.phase === "done") return;
      replay.seen.add(name);
      if (replay.phase === "replaying" && Date.now() - began < REPLAY_MAX_MS) arm();
    };
    s.replay = replay;
    arm();
    const confirm = setTimeout(() => { s.watchFailed = ""; setStatus(s, "online", ""); }, confirmMs);
    confirm.unref?.();
    const splitter = createJsonSplitter(text => onWatchObject(s, text));
    s.stats.watches++;
    try {
      const result = await streamKubectl(s, ["get", "pods", "--watch", "--output-watch-events", "-o", "json", ACTIVE_ONLY], {
        onData: chunk => { try { splitter.write(chunk); } finally { flush(s); } },
        control,
      });
      if (stopped) return false;
      const lived = Date.now() - began, end = splitter.end();
      const error = result.code !== 0 ? kubectlError(result, "kubectl get pods --watch") : !end.complete ? new Error("kubectl watch ended inside an object") : null;
      if (error && lived < healthyMs) { s.watchFailed = error.message; throw error; }
      if (error) s.lastWatchError = error.message; // a long-lived watch ended (server timeout, proxy, GOAWAY): routine
      return lived >= healthyMs;
    } catch (error) {
      if (!(error instanceof WatchRestart)) throw error;
      s.lastWatchError = error.message;
      return Date.now() - began >= healthyMs;
    } finally {
      clearTimeout(confirm);
      clearTimeout(replay.timer);
      replay.phase = "done";
      if (s.replay === replay) s.replay = null;
    }
  }

  /** One list + watch. Resolves true when the watch lived long enough to count as healthy. */
  async function cycle(s) {
    const records = await listPods(s);
    s.stats.lists++;
    s.stats.lastListAt = now();
    if (s.watchFailed) setStatus(s, "unreachable", s.watchFailed); // pods are fresh, but watching still fails
    else setStatus(s, "online", "");
    commitList(s, records);
    return watchPods(s);
  }

  function setStatus(s, status, error) {
    if (s.status === status && s.error === error) return;
    if (s.status !== status) s.since = now();
    s.status = status;
    s.error = error;
    notify(s, onSourceState, s.name, { status, error, since: s.since });
  }

  async function runSite(s) {
    let delay = backoffMs[0];
    while (!stopped) {
      let healthy = false;
      try { healthy = await cycle(s); }
      catch (error) {
        if (stopped) return;
        setStatus(s, "unreachable", clean(error.message));
      }
      if (stopped) return;
      s.stats.restarts++;
      const wait = healthy ? backoffMs[0] : delay;
      delay = healthy ? backoffMs[0] : Math.min(backoffMs[1], delay * 2);
      await new Promise(resolve => { s.wake = resolve; s.timer = setTimeout(resolve, wait); });
    }
  }

  // collectors -------------------------------------------------------------------------------------------------------

  let attachesRunning = 0;
  const attachQueue = [];
  /** At most MAX_ATTACHES probes/pushes at once, so a cluster full of collect pods cannot spawn a kubectl storm. */
  function withAttachSlot(task) {
    return new Promise((resolve, reject) => {
      const run = () => { attachesRunning++; task().then(resolve, reject).finally(() => { attachesRunning--; attachQueue.shift()?.(); }); };
      if (attachesRunning < MAX_ATTACHES) run(); else attachQueue.push(run);
    });
  }

  async function loadBundle() {
    if (collectorBundle instanceof Uint8Array) return bundleCache ??= { bytes: collectorBundle, sha: sha256(collectorBundle) };
    const info = await stat(collectorBundle);
    if (bundleCache && bundleCache.mtimeMs === info.mtimeMs && bundleCache.size === info.size) return bundleCache;
    const bytes = await readFile(collectorBundle);
    return bundleCache = { bytes, sha: sha256(bytes), mtimeMs: info.mtimeMs, size: info.size };
  }

  function collectorSpec(s, pod, container) {
    const hostId = podHostId(s.name, pod);
    return {
      command: kubectl,
      args: [...baseArgs(s), "exec", "-i", pod, "-c", container, "--", "node", REMOTE_BUNDLE, "collector", "--stdio", "--host-id", hostId, "--site", s.name, "--kind", "pod", "--label", pod],
      label: `kubectl exec ${s.name}/${pod}`,
      hostId,
    };
  }

  async function execIn(s, { pod, container, script, input, stage, timeoutMs }) {
    const result = await runKubectl(s, ["exec", ...(input ? ["-i"] : []), pod, "-c", container, "--", "sh", "-c", script], { input, timeoutMs });
    if (result.code !== 0) throw new AttachError(`${stage} failed: ${clean(result.stderr) || `kubectl exited with code ${result.code}`}`);
    return result.stdout.toString("utf8");
  }

  function release(handle) {
    try { if (typeof handle === "function") handle(); else (handle?.stop ?? handle?.close)?.call(handle); } catch { /* the hub owns the handle */ }
  }

  /** Invalidate in-flight work, cancel retries and release the hub's channel. */
  function stopChannel(c) {
    c.generation++;
    clearTimeout(c.timer);
    c.timer = null;
    const handle = c.handle;
    c.handle = null;
    c.attached = false;
    if (handle) release(handle);
  }

  /** The attach identity of a pod: its uid plus the container instance; null while no collector can run. */
  function attachKey(entry) {
    const { pod, target } = entry;
    return pod.collect && pod.phase === "Running" && target && !target.error && target.running ? `${entry.uid}/${target.id}` : null;
  }
  function waitingStatus(entry) {
    const { pod, target } = entry;
    if (!pod.collect) return undefined;
    if (!canAttach) return "collector not configured";
    if (target?.error) return target.error;
    return pod.phase === "Running" ? "waiting for container" : "waiting for pod to run";
  }

  function reconcileCollector(s, entry) {
    const c = entry.collector, key = canAttach ? attachKey(entry) : null;
    if (key === c.key && (key !== null || c.status === waitingStatus(entry))) return;
    stopChannel(c);
    c.key = key;
    c.attempts = 0;
    if (key === null) { c.status = waitingStatus(entry); return; }
    c.status = "attaching";
    attach(s, entry, c.generation).catch(error => trap(s, error));
  }

  async function attach(s, entry, generation) {
    const c = entry.collector, pod = entry.name, container = entry.target.name;
    const live = () => !stopped && c.generation === generation;
    try {
      await withAttachSlot(async () => {
        if (!live()) return;
        const bundle = await loadBundle().catch(error => { throw new AttachError(`bundle unavailable: ${clean(error.message)}`); });
        const probe = parseProbe(await execIn(s, { pod, container, script: PROBE_SCRIPT, stage: "probe" }));
        if (!live()) return;
        if (!probe.node) throw new AttachError("no node runtime", true);
        if (probe.major === null) throw new AttachError("node not runnable", true);
        if (probe.major < MIN_NODE_MAJOR) throw new AttachError(`node ${probe.version} < ${MIN_NODE_MAJOR}`, true);
        if (probe.sha !== bundle.sha) {
          const out = await execIn(s, { pod, container, script: PUSH_SCRIPT, input: bundle.bytes, stage: "push", timeoutMs: 60_000 });
          const pushed = /^([0-9a-f]{64})(\s|$)/m.exec(out)?.[1];
          if (!/^PUSHED$/m.test(out) || (pushed && pushed !== bundle.sha)) throw new AttachError("push failed: the bundle did not arrive intact");
        }
      });
      if (!live()) return;
      const handle = await attachCollector(s.name, view(entry), collectorSpec(s, pod, container));
      if (!live()) { release(handle); return; }
      c.handle = handle ?? null;
      c.attached = true;
      c.attempts = 0;
      setCollectorStatus(s, entry, "attached");
    } catch (error) {
      if (!live()) return;
      const failed = error instanceof AttachError ? error : new AttachError(`attach failed: ${clean(error?.message)}`);
      setCollectorStatus(s, entry, failed.message);
      // Quick retries for transient failures, then a slow cadence for good: a pod may get its node runtime (or a writable /tmp) later.
      const quick = !failed.permanent && c.attempts < attachRetryMs.length;
      c.timer = setTimeout(() => { c.timer = null; if (live()) attach(s, entry, generation).catch(error => trap(s, error)); }, quick ? attachRetryMs[c.attempts++] : reprobeMs);
      c.timer.unref?.();
    }
  }

  /** Records the collector status of a pod and tells the hub when it changed. */
  function setCollectorStatus(s, entry, status) {
    if (entry.collector.status === status) return;
    entry.collector.status = status;
    markDirty(s, entry);
  }

  // lifecycle --------------------------------------------------------------------------------------------------------

  async function runSiteSafely(s) {
    try { await runSite(s); } catch (error) { setStatus(s, "unreachable", clean(error?.message)); }
  }

  function start() {
    if (started) return;
    started = true;
    for (const s of states.values()) s.loop = runSiteSafely(s);
  }

  async function stop() {
    stopped = true;
    for (const s of states.values()) {
      clearTimeout(s.timer);
      s.wake?.();
      for (const child of s.children) signalChild(child);
      for (const entry of s.active.values()) stopChannel(entry.collector);
    }
    const killers = [...states.values()].flatMap(s => [...s.children]).map(child => setTimeout(() => signalChild(child, "SIGKILL"), 2000));
    await Promise.allSettled([...states.values()].map(s => s.loop));
    for (const killer of killers) clearTimeout(killer);
  }

  // on-demand lookups ------------------------------------------------------------------------------------------------

  function cacheGet(key) {
    const hit = lookups.get(key);
    if (!hit) return undefined;
    if (now() - hit.at >= lookupTtlMs) { lookups.delete(key); return undefined; }
    lookups.delete(key);
    lookups.set(key, hit); // most recently used last
    return hit;
  }
  function cachePut(key, pod) {
    lookups.delete(key);
    lookups.set(key, { at: now(), pod });
    while (lookups.size > lookupCacheSize) lookups.delete(lookups.keys().next().value);
  }

  async function lookupPod(s, name, key) {
    const result = await runKubectl(s, ["get", "pod", name, "-o", "json"]);
    if (result.code !== 0) {
      if (/\bNotFound\b/.test(result.stderr)) { cachePut(key, null); return null; }
      throw kubectlError(result, "kubectl get pod");
    }
    const raw = parseJson(result.stdout.toString("utf8"), "kubectl get pod");
    const pod = compactPod(raw, { site: s.name, cluster: s.context, namespace });
    cachePut(key, pod);
    return pod;
  }

  /**
   * A pod by name: the live (active) one, else a cached lookup ≤ lookupTtlMs old, else `kubectl get pod`.
   * Resolves null when the pod does not exist (also cached); rejects when the cluster cannot answer (not cached).
   * Resolves null for sites and namespaces this source does not watch.
   */
  async function getPod({ site, namespace: ns = namespace, name } = {}) {
    const s = states.get(site);
    if (!s || ns !== namespace || !POD_NAME.test(name ?? "")) return null;
    const live = s.active.get(name);
    if (live) return view(live);
    const key = lookupKey(site, name);
    const hit = cacheGet(key);
    if (hit) return hit.pod;
    let pending = lookupsInFlight.get(key);
    if (!pending) {
      pending = lookupPod(s, name, key).finally(() => lookupsInFlight.delete(key));
      lookupsInFlight.set(key, pending);
    }
    return pending;
  }

  /**
   * Read-only file preview inside a pod, with the semantics of the collector's `file.read`: secret-looking paths
   * (case-insensitive, also after `readlink -f`) and pseudo filesystems are refused, only regular files are read, binary
   * content is not returned, previews holding a fleet token or a bare credential line are refused and the text is redacted.
   * Rejects when the pod cannot be reached (not found, not running, no `sh`); a missing file is `exists:false`.
   * `knownSecrets` replaces the token values read from this hub's `~/.config/agent-fleet` (tests).
   */
  async function readPodFile({ site, namespace: ns = namespace, pod, container, path, maxBytes = LIMITS.fileReadBytes, knownSecrets } = {}) {
    const s = knownSite(site);
    if (!POD_NAME.test(pod ?? "")) throw new Error("invalid pod name");
    if (container !== undefined && !CONTAINER_NAME.test(container)) throw new Error("invalid container name");
    if (typeof path !== "string" || path === "" || path.length > 4096 || /[\0\r\n]/.test(path)) throw new Error("invalid path");
    const host = podHostId(site, pod);
    const refuse = (denied, exists = false) => ({ host, path, exists, denied });
    if (ns !== namespace) return refuse(`namespace ${ns} is not watched`);
    if (!path.startsWith("/")) return refuse("path must be absolute");
    if (isSecretPath(path)) return refuse(SECRET_DENIED);
    if (PSEUDO_FS.test(path)) return refuse("pseudo filesystem");
    const limit = Math.min(LIMITS.fileReadBytes, Math.max(1, Math.floor(Number(maxBytes)) || LIMITS.fileReadBytes));
    const known = s.active.get(pod), inContainer = container ?? known?.pod.labels[CONTAINER_LABEL] ?? known?.pod.containers[0]?.name;
    const args = ["exec", pod, ...(inContainer ? ["-c", inContainer] : []), "--", "sh", "-c", FILE_SCRIPT, "sh", path, String(limit)];
    const result = await runKubectl(s, args, { maxBytes: limit + 4200, timeoutMs: 30_000 });
    const marker = result.code === 3 ? /^(NOFILE|ISDIR|NOTFILE)\n/.exec(result.stdout.toString("latin1", 0, 16))?.[1] : undefined;
    if (marker === "NOFILE") return { host, path, exists: false };
    if (marker === "ISDIR") return refuse("is a directory", true);
    if (marker === "NOTFILE") return refuse("not a regular file", true);
    if (result.code !== 0) {
      if (/Permission denied/i.test(result.stderr)) return refuse("permission denied", true);
      throw kubectlError(result, "kubectl exec");
    }
    const lineEnd = result.stdout.indexOf(10), header = lineEnd < 0 ? null : /^(\d+) (\d+) (.*)$/.exec(result.stdout.toString("utf8", 0, lineEnd));
    if (!header) return refuse("cannot resolve path", true);
    const real = header[3];
    if (real === "") return refuse("cannot resolve path", true);
    // SECRET_PATHS is case-insensitive (APFS): `.SSH/ID_RSA` resolves to the same file as `.ssh/id_rsa` on the Mac.
    if (isSecretPath(real) || PSEUDO_FS.test(real)) return refuse(SECRET_DENIED);
    const size = Number(header[1]), mtime = Number(header[2]) * 1000;
    let body = result.stdout.subarray(lineEnd + 1);
    if (body.length > limit) body = body.subarray(0, limit);
    const out = { host, path, exists: true, size, mtime, truncated: size > body.length };
    if (isBinary(body)) return { ...out, binary: true };
    const text = new TextDecoder("utf-8").decode(body, { stream: true });
    // Same content rules as the collector's file.read: a copy of a fleet token is a valid path with a secret inside.
    const denial = secretContentDenial(text, Array.isArray(knownSecrets) ? knownSecrets : await loadKnownSecrets());
    if (denial !== null) return refuse(denial, true);
    const { text: masked, count } = redact(text);
    return { ...out, binary: false, content: masked, redactions: count };
  }

  /** Kube events of one pod, oldest first (the last MAX_EVENTS): {type, reason, message, count, firstAt, lastAt}. */
  async function podEvents({ site, namespace: ns = namespace, pod } = {}) {
    const s = knownSite(site);
    if (!POD_NAME.test(pod ?? "")) throw new Error("invalid pod name");
    if (ns !== namespace) throw new Error(`namespace ${ns} is not watched`);
    const result = await runKubectl(s, ["get", "events", `--field-selector=involvedObject.kind=Pod,involvedObject.name=${pod}`, "-o", "json"]);
    if (result.code !== 0) throw kubectlError(result, "kubectl get events");
    const doc = parseJson(result.stdout.toString("utf8"), "kubectl get events");
    return (doc.items ?? []).map(compactEvent).sort((a, b) => (a.lastAt ?? 0) - (b.lastAt ?? 0)).slice(-MAX_EVENTS);
  }

  /** Source state of one site (all sites when omitted): status, active pods by phase, collectors, counters. Contains no secrets. */
  function describe(site) {
    if (site === undefined) return Object.fromEntries([...states.keys()].map(name => [name, describe(name)]));
    const s = states.get(site);
    if (!s) return null;
    const phases = {}, collectors = {};
    for (const entry of s.active.values()) {
      phases[entry.pod.phase] = (phases[entry.pod.phase] ?? 0) + 1;
      const status = entry.collector.status;
      if (entry.pod.collect) collectors[status ?? "none"] = (collectors[status ?? "none"] ?? 0) + 1;
    }
    return {
      site, cluster: s.context, namespace, status: s.status, error: s.error, since: s.since,
      pods: s.active.size, phases, collectors, lookups: lookups.size,
      lists: s.stats.lists, watches: s.stats.watches, restarts: s.stats.restarts,
      events: { ...s.stats.events, changed: s.stats.changed, replayed: s.stats.replayed },
      lastListAt: s.stats.lastListAt, lastEventAt: s.stats.lastEventAt, lastWatchError: s.lastWatchError, internalError: s.internalError,
    };
  }

  return { start, stop, getPod, readPodFile, podEvents, describe };
}
