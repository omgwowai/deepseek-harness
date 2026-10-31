// Link resolution: the effective parent → child edges of the fleet's agent graph.
//
// A child can have candidate parents from five sources; all are resolved lazily so arrival order never matters
// (a hint whose parent has not been seen yet is retried when that agent arrives):
//   file     the child's own ParentHint (collector-resolved key, parent transcript file, or global kind:id)
//   acp      a DSH record whose `acp` binding names this native session
//   env      AGENT_FLEET_PARENT / native session-id variables of the child's process (Proc.parent / parentSession)
//   process  a kubectl/ssh launcher process owned by agent A + a session starting on the remote host within ±60 s
//   command  a tool call of agent A with an `agent` launch target + a session starting in [t−5 s, t+120 s]
// plus links computed by an upstream hub. The best candidate wins: file > acp > env > process > command; ties go
// to the innermost parent, then exact, same-host, latest-started. A child is never parented to an agent that
// started after it, and a candidate that would close a cycle is rejected.
import { KUBE_CONTEXTS, LINK_VIA, parseAgentKey, parsePodHostId, siteOfSshTarget } from "../protocol.mjs";

const RANK = { file: 0, acp: 1, env: 2, process: 3, command: 4 };
const PROCESS_WINDOW_MS = 60_000;
const COMMAND_BEFORE_MS = 5_000;
const COMMAND_AFTER_MS = 120_000;
const LAUNCH_TTL_MS = 6 * 3_600_000;
const MAX_LAUNCHES = 2_000;
const CROSS_HOST_START_SLACK_MS = 2_000;   // clock-skew estimation error between two hosts
const KIND_MISMATCH_PENALTY_MS = 1_000_000;
const MAX_HOPS = 64;

const GLOBAL_REF = /^(dsh|claude|codex|omp):(.+)$/;
const AGENT_WORD = /\b(omp|claude|codex|dsh)\b/g;

const fileId = agent => `${agent.host}\u0000${agent.file}`;
const tokenOfKey = key => `k:${key}`;
const tokenOfFile = (host, file) => `f:${host}\u0000${file}`;
const tokenOfGlobal = (kind, id) => `g:${kind}:${id}`;
const num = value => (Number.isFinite(value) ? value : 0);
const viaOf = via => (LINK_VIA.includes(via) ? via : "file");

/** "dsh:abc" (global) or "host#kind:id" (full key) → a ParentHint-shaped reference, else null. */
function parseRef(text) {
  if (typeof text !== "string" || text === "") return null;
  if (text.includes("#")) return parseAgentKey(text) ? { key: text } : null;
  const match = GLOBAL_REF.exec(text);
  return match ? { kind: match[1], id: match[2] } : null;
}

/** Hints a process's environment gives about the session it runs. */
function hintsOfProc(proc) {
  const hints = [];
  const call = typeof proc.parentCall === "string" && proc.parentCall !== "" ? proc.parentCall : undefined;
  const ref = parseRef(proc.parent);
  if (ref) hints.push({ ...ref, via: "env", exact: true, toolCallId: call });
  if (typeof proc.parentSession?.id === "string") hints.push({ kind: proc.parentSession.kind, id: proc.parentSession.id, via: "env", exact: true, toolCallId: call });
  if (typeof proc.via?.id === "string") hints.push({ kind: proc.via.kind ?? "dsh", id: proc.via.id, via: "acp", exact: true });
  return hints;
}

/** Agent kind a launcher command line most likely starts (the last agent word), or null. */
function kindOfCommand(cmd) {
  let kind = null;
  for (const match of String(cmd ?? "").matchAll(AGENT_WORD)) kind = match[1];
  return kind;
}

const sameLink = (a, b) => a.from === b.from && a.via === b.via && a.exact === b.exact && a.toolCallId === b.toolCallId
  && a.crossHost === b.crossHost && a.crossSite === b.crossSite;

/**
 * @param {object} shared  state-owned views the resolver reads
 * @param {Map<string, object>} shared.agents  agent key → AgentRecord
 * @param {Map<string, Set<string>>} shared.hostAgents  host id → agent keys
 * @param {Map<string, object[]>} shared.procs  host id → Proc[]
 */
export function createLinks({ agents, hostAgents, procs }) {
  const byFile = new Map();           // host\0file → agent key
  const byGlobal = new Map();         // kind:id → Set<agent key>
  const hintRefs = new Map();         // lookup token → child keys whose hints name it
  const refTokens = new Map();        // child key → tokens it is registered under
  const acpBound = new Map();         // native kind:id → DSH agent keys bound to it
  const acpOf = new Map();            // DSH agent key → native kind:id
  const procHints = new Map();        // child key → hints from its process
  const procOwners = new Map();       // host id → child keys that have procHints
  const processParents = new Map();   // child key → {from, toolCallId}
  const commandParents = new Map();   // child key → {from, toolCallId}
  const externalBy = new Map();       // upstream name → Map<child key, Link>
  const launches = new Map();         // agent\0call#n → {agent, id, t, target}
  const effective = new Map();        // child key → Link
  const children = new Map();         // parent key → Set<child key>
  const dirty = new Set();
  let fuzzyDirty = false;

  const addTo = (map, key, value) => { let set = map.get(key); if (!set) map.set(key, set = new Set()); set.add(value); };
  const removeFrom = (map, key, value) => { const set = map.get(key); if (set) { set.delete(value); if (set.size === 0) map.delete(key); } };

  function pickGlobal(kind, id, child) {
    const keys = byGlobal.get(`${kind}:${id}`);
    if (!keys) return null;
    let best = null;
    for (const key of keys) {
      if (key === child.key) continue;
      const agent = agents.get(key);
      if (!agent) continue;
      if (best === null) { best = agent; continue; }
      const sameHost = agent.host === child.host, bestSame = best.host === child.host;
      if (sameHost !== bestSame ? sameHost : num(agent.updatedAt) > num(best.updatedAt)) best = agent;
    }
    return best?.key ?? null;
  }

  function resolveHint(child, hint) {
    if (hint.key) {
      if (agents.has(hint.key)) return hint.key;
      const parsed = parseAgentKey(hint.key);
      if (parsed) { const found = pickGlobal(parsed.kind, parsed.id, child); if (found !== null) return found; }
    }
    if (hint.file) { const key = byFile.get(tokenOfFile(child.host, hint.file)); if (key !== undefined && key !== child.key) return key; }
    if (hint.id) { const found = pickGlobal(hint.kind ?? child.kind, hint.id, child); if (found !== null) return found; }
    return null;
  }

  /** Identity of a child that may not have a record yet (procs can arrive before the agent). */
  const identityOf = key => agents.get(key) ?? (() => { const p = parseAgentKey(key); return p ? { key, host: p.hostId, kind: p.kind, id: p.id } : null; })();

  function tokensOfHint(child, hint) {
    const tokens = [];
    if (hint.key) { tokens.push(tokenOfKey(hint.key)); const p = parseAgentKey(hint.key); if (p) tokens.push(tokenOfGlobal(p.kind, p.id)); }
    if (hint.file) tokens.push(tokenOfFile(child.host, hint.file));
    if (hint.id) tokens.push(tokenOfGlobal(hint.kind ?? child.kind, hint.id));
    return tokens;
  }

  function registerRefs(key) {
    const child = identityOf(key);
    const next = new Set();
    if (child) {
      const record = agents.get(key);
      if (record?.parent) for (const token of tokensOfHint(child, record.parent)) next.add(token);
      for (const hint of procHints.get(key) ?? []) for (const token of tokensOfHint(child, hint)) next.add(token);
    }
    const prev = refTokens.get(key);
    if (prev) for (const token of prev) if (!next.has(token)) removeFrom(hintRefs, token, key);
    for (const token of next) addTo(hintRefs, token, key);
    if (next.size > 0) refTokens.set(key, next); else refTokens.delete(key);
  }

  const markDependents = agent => {
    for (const token of [tokenOfKey(agent.key), tokenOfGlobal(agent.kind, agent.id), ...(agent.file ? [tokenOfFile(agent.host, agent.file)] : [])]) {
      for (const child of hintRefs.get(token) ?? []) dirty.add(child);
    }
    for (const child of children.get(agent.key) ?? []) dirty.add(child);
  };

  function setBinding(agent) {
    const bound = agent.acp?.kind && agent.acp?.id ? `${agent.acp.kind}:${agent.acp.id}` : null;
    const prev = acpOf.get(agent.key) ?? null;
    if (bound === prev) return;
    fuzzyDirty = true;
    if (prev !== null) { removeFrom(acpBound, prev, agent.key); acpOf.delete(agent.key); for (const key of byGlobal.get(prev) ?? []) dirty.add(key); }
    if (bound !== null) { addTo(acpBound, bound, agent.key); acpOf.set(agent.key, bound); for (const key of byGlobal.get(bound) ?? []) dirty.add(key); }
  }

  function agentUpserted(prev, next) {
    const key = next.key;
    if (prev?.file && prev.file !== next.file && byFile.get(fileId(prev)) === key) byFile.delete(fileId(prev));
    if (next.file) byFile.set(fileId(next), key);
    const identityChanged = !prev || prev.kind !== next.kind || prev.id !== next.id || prev.file !== next.file;
    if (prev && (prev.kind !== next.kind || prev.id !== next.id)) removeFrom(byGlobal, `${prev.kind}:${prev.id}`, key);
    addTo(byGlobal, `${next.kind}:${next.id}`, key);
    setBinding(next);
    registerRefs(key);
    dirty.add(key);
    if (identityChanged) markDependents(next);
    else if (prev.startedAt !== next.startedAt) for (const child of children.get(key) ?? []) dirty.add(child);
    if (!prev || prev.startedAt !== next.startedAt || Boolean(prev.parent) !== Boolean(next.parent)) fuzzyDirty = true;
  }

  function agentRemoved(prev) {
    const key = prev.key;
    if (prev.file && byFile.get(fileId(prev)) === key) byFile.delete(fileId(prev));
    removeFrom(byGlobal, `${prev.kind}:${prev.id}`, key);
    const bound = acpOf.get(key);
    if (bound !== undefined) { removeFrom(acpBound, bound, key); acpOf.delete(key); for (const native of byGlobal.get(bound) ?? []) dirty.add(native); }
    markDependents(prev);
    const link = effective.get(key);
    if (link) { effective.delete(key); removeFrom(children, link.from, key); }
    procHints.delete(key);
    registerRefs(key);
    processParents.delete(key);
    commandParents.delete(key);
    dirty.delete(key);
    fuzzyDirty = true;
  }

  function procsChanged(hostId) {
    const next = new Map();
    for (const proc of procs.get(hostId) ?? []) {
      if (typeof proc.agent !== "string") continue;
      const hints = hintsOfProc(proc);
      if (hints.length > 0) next.set(proc.agent, [...(next.get(proc.agent) ?? []), ...hints]);
    }
    for (const key of procOwners.get(hostId) ?? []) if (!next.has(key)) { procHints.delete(key); registerRefs(key); dirty.add(key); }
    for (const [key, hints] of next) { procHints.set(key, hints); registerRefs(key); dirty.add(key); }
    if (next.size > 0) procOwners.set(hostId, new Set(next.keys())); else procOwners.delete(hostId);
    fuzzyDirty = true;
  }

  function eventSeen(agentKey, event) {
    const targets = event.targets;
    if (!Array.isArray(targets)) return;
    targets.forEach((target, index) => {
      if (target?.type !== "agent") return;
      const id = `${agentKey}\u0000${event.id}#${index}`;
      const known = launches.get(id);
      if (known && known.t === event.t) return;
      launches.delete(id);
      launches.set(id, { agent: agentKey, id: event.id, t: num(event.t), target });
      if (launches.size > MAX_LAUNCHES) launches.delete(launches.keys().next().value);
      fuzzyDirty = true;
    });
  }

  /** Replace the links an upstream hub reported (`null` drops them). */
  function setExternal(name, list) {
    const prev = externalBy.get(name);
    const next = new Map();
    for (const link of list ?? []) if (typeof link?.from === "string" && typeof link?.to === "string") next.set(link.to, link);
    if (list === null) externalBy.delete(name); else externalBy.set(name, next);
    for (const key of prev?.keys() ?? []) dirty.add(key);
    for (const key of next.keys()) dirty.add(key);
  }

  function candidatesOf(child) {
    const list = [];
    const addHint = hint => {
      const from = resolveHint(child, hint);
      if (from !== null) list.push({ from, via: viaOf(hint.via), exact: hint.exact === true, toolCallId: hint.toolCallId });
    };
    if (child.parent) addHint(child.parent);
    for (const hint of procHints.get(child.key) ?? []) addHint(hint);
    for (const from of acpBound.get(`${child.kind}:${child.id}`) ?? []) list.push({ from, via: "acp", exact: true });
    const proc = processParents.get(child.key);
    if (proc) list.push({ from: proc.from, via: "process", exact: false, toolCallId: proc.toolCallId });
    const command = commandParents.get(child.key);
    if (command) list.push({ from: command.from, via: "command", exact: false, toolCallId: command.toolCallId });
    for (const links of externalBy.values()) {
      const link = links.get(child.key);
      if (link) list.push({ from: link.from, via: viaOf(link.via), exact: link.exact === true, toolCallId: link.toolCallId });
    }
    return list;
  }

  /** True when `ancestor` is `node` or one of its parents. */
  function isAncestor(ancestor, node) {
    let current = node;
    for (let hops = 0; hops < MAX_HOPS && current !== undefined; hops += 1) {
      if (current === ancestor) return true;
      current = effective.get(current)?.from;
    }
    return false;
  }

  /**
   * A candidate parent is usable when it exists, is not the child itself, did not start after the child (hosts get a
   * small slack for clock-skew estimation error) and does not close a cycle. An ACP binding is a recorded fact rather
   * than an inference, and a native session can predate the DSH session that adopts it, so it skips the time rule. An
   * OMP `--restore` fork copies the artifact directory, so its subagent transcripts (`<fork>/<Task>.jsonl`, a `file`
   * hint with `exact`) legitimately predate the fork session itself; inferred links keep the rule.
   */
  function usable(child, candidate) {
    const parent = agents.get(candidate.from);
    if (!parent || parent.key === child.key) return false;
    const copied = candidate.via === "file" && candidate.exact === true && parent.role === "fork";
    if (candidate.via !== "acp" && !copied) {
      const slack = parent.host === child.host ? 0 : CROSS_HOST_START_SLACK_MS;
      if (num(parent.startedAt) > num(child.startedAt) + slack) return false;
    }
    return !isAncestor(child.key, parent.key);
  }

  /** Negative when candidate `a` is the better parent of `child`: rank, then exact, then innermost (latest started). */
  function compare(child, a, b) {
    const byRank = RANK[a.via] - RANK[b.via];
    if (byRank !== 0) return byRank;
    if (a.from === b.from) return (b.exact ? 1 : 0) - (a.exact ? 1 : 0);
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    const parentA = agents.get(a.from), parentB = agents.get(b.from);
    const startA = num(parentA.startedAt), startB = num(parentB.startedAt);
    if (startA !== startB) return startB - startA;
    const sameA = parentA.host === child.host, sameB = parentB.host === child.host;
    if (sameA !== sameB) return sameA ? -1 : 1;
    return a.from < b.from ? -1 : 1;
  }

  function resolve(key) {
    const child = agents.get(key);
    const prev = effective.get(key);
    let pick = null;
    if (child) for (const candidate of candidatesOf(child)) if (usable(child, candidate) && (pick === null || compare(child, candidate, pick) < 0)) pick = candidate;
    if (pick === null) {
      if (!prev) return false;
      effective.delete(key); removeFrom(children, prev.from, key);
      return true;
    }
    const parent = agents.get(pick.from);
    const link = { from: pick.from, to: key, via: pick.via, exact: pick.exact, crossHost: parent.host !== child.host, crossSite: parent.site !== child.site };
    if (pick.toolCallId) link.toolCallId = pick.toolCallId;
    if (prev && sameLink(prev, link)) return false;
    if (prev) removeFrom(children, prev.from, key);
    effective.set(key, link);
    addTo(children, link.from, key);
    return true;
  }

  /** Re-resolve everything marked dirty; true when the effective link set changed. */
  function flush() {
    if (dirty.size === 0) return false;
    const batch = [...dirty];
    dirty.clear();
    let changed = false;
    for (const key of batch) if (resolve(key)) changed = true;
    return changed;
  }

  // ---- fuzzy links (process and command) ----------------------------------------------------------

  /** Host ids of pods (collectors attached) named `pod` — or, without a name, of every pod of `site`. */
  const podHosts = (pod, site) => {
    const hosts = [];
    for (const hostId of hostAgents.keys()) {
      const parsed = parsePodHostId(hostId);
      if (parsed !== null && (pod ? parsed.pod === pod : parsed.site === site) && (!pod || !site || parsed.site === site)) hosts.push(hostId);
    }
    return hosts;
  };

  /** Hosts a destination (kubectl exec pod / ssh host / launch target) can mean. A non-cluster site's id doubles as its host id. */
  function destinationHosts({ pod, site, host }) {
    if (pod) return podHosts(pod, site);
    const named = site ?? (host ? siteOfSshTarget(host) : null);
    if (!named) return [];                                       // a launch without site or pod happened on the agent's own machine: env links cover it
    return named in KUBE_CONTEXTS ? podHosts(null, named) : [named];
  }

  /**
   * Sessions that no hint, process environment or ACP binding already places in a tree, per host sorted by start
   * time; the returned generator yields those of `hostIds` that started in [from, to]. One index per fuzzy pass.
   */
  function freeIndex() {
    const cache = new Map();
    const sessionsOf = hostId => {
      let sorted = cache.get(hostId);
      if (sorted !== undefined) return sorted;
      sorted = [];
      for (const key of hostAgents.get(hostId) ?? []) {
        const agent = agents.get(key);
        // A model-catalog probe (ACP handshake, cwd `…/dsh-acp-probe-<rand>/`) starts and dies at will; it must never
        // take the fuzzy link of a real launch that happens to run on the same pod inside the window.
        if (!agent || agent.parent || agent.role === "projection" || agent.role === "probe") continue;
        if (procHints.has(key) || acpBound.has(`${agent.kind}:${agent.id}`)) continue;
        sorted.push(agent);
      }
      sorted.sort((a, b) => num(a.startedAt) - num(b.startedAt));
      cache.set(hostId, sorted);
      return sorted;
    };
    return function* within(hostIds, from, to) {
      for (const hostId of hostIds) {
        const sorted = sessionsOf(hostId);
        let low = 0, high = sorted.length;
        while (low < high) { const mid = (low + high) >>> 1; if (num(sorted[mid].startedAt) < from) low = mid + 1; else high = mid; }
        for (let i = low; i < sorted.length && num(sorted[i].startedAt) <= to; i += 1) yield sorted[i];
      }
    };
  }

  function ownerOf(hostId, proc, byPid) {
    if (typeof proc.parentSession?.id === "string") {
      const key = pickGlobal(proc.parentSession.kind, proc.parentSession.id, { key: "", host: hostId });
      if (key !== null) return agents.get(key);
    }
    // A launcher's own environment names its parent (`AGENT_FLEET_PARENT` / `DSH_AGENT_FLEET_PARENT`): that survives
    // a broken process chain (a detached or re-parented one-shot agent whose own pid was never reported).
    const ref = typeof proc.parent === "string" ? parseRef(proc.parent) : null;
    if (ref?.key && agents.has(ref.key)) return agents.get(ref.key);
    if (ref?.id) {
      const key = pickGlobal(ref.kind ?? "dsh", ref.id, { key: "", host: hostId });
      if (key !== null) return agents.get(key);
    }
    let current = proc;
    for (let hops = 0; hops < 16; hops += 1) {
      const parent = byPid.get(current.ppid);
      if (!parent) return null;
      if (typeof parent.agent === "string" && agents.has(parent.agent)) return agents.get(parent.agent);
      current = parent;
    }
    return null;
  }

  const startedNotAfter = (owner, child) => num(owner.startedAt) <= num(child.startedAt) + (owner.host === child.host ? 0 : CROSS_HOST_START_SLACK_MS);

  /** Each source (launcher process or launch call) claims its closest session; each session has one source. */
  function assign(pairs, into) {
    pairs.sort((a, b) => a.delta - b.delta || (a.child < b.child ? -1 : 1));
    const sources = new Set(), childrenTaken = new Set();
    for (const pair of pairs) {
      if (sources.has(pair.source) || childrenTaken.has(pair.child)) continue;
      sources.add(pair.source); childrenTaken.add(pair.child);
      into.set(pair.child, { from: pair.from, toolCallId: pair.toolCallId });
    }
  }

  function diffInto(current, next) {
    for (const [key, value] of current) { const other = next.get(key); if (!other || other.from !== value.from || other.toolCallId !== value.toolCallId) dirty.add(key); }
    for (const key of next.keys()) if (!current.has(key)) dirty.add(key);
    current.clear();
    for (const [key, value] of next) current.set(key, value);
  }

  /** Recompute process and command links; launch calls older than LAUNCH_TTL_MS before `nowMs` are forgotten. */
  function fuzzy(nowMs) {
    if (!fuzzyDirty) return;
    fuzzyDirty = false;
    const within = freeIndex();
    const processPairs = [], commandPairs = [];
    for (const [hostId, list] of procs) {
      let byPid = null;
      for (const proc of list) {
        if (!proc.remote) continue;
        byPid ??= new Map(list.map(entry => [entry.pid, entry]));
        const owner = ownerOf(hostId, proc, byPid);
        if (!owner) continue;
        const wanted = proc.launches ?? kindOfCommand(proc.cmd);
        const started = num(proc.startedAt);
        for (const candidate of within(destinationHosts(proc.remote), started - PROCESS_WINDOW_MS, started + PROCESS_WINDOW_MS)) {
          if (candidate.key === owner.key || !startedNotAfter(owner, candidate)) continue;
          const delta = Math.abs(num(candidate.startedAt) - started);
          processPairs.push({ source: `${hostId}\u0000${proc.pid}\u0000${proc.startedAt}`, child: candidate.key, from: owner.key, delta: delta + (wanted && wanted !== candidate.kind ? KIND_MISMATCH_PENALTY_MS : 0), toolCallId: proc.parentCall });
        }
      }
    }
    for (const [id, launch] of launches) {
      const owner = agents.get(launch.agent);
      if (!owner || launch.t < nowMs - LAUNCH_TTL_MS) { launches.delete(id); continue; }
      for (const candidate of within(destinationHosts(launch.target), launch.t - COMMAND_BEFORE_MS, launch.t + COMMAND_AFTER_MS)) {
        if (candidate.key === owner.key || (launch.target.kind && launch.target.kind !== candidate.kind) || !startedNotAfter(owner, candidate)) continue;
        commandPairs.push({ source: id, child: candidate.key, from: owner.key, delta: Math.abs(num(candidate.startedAt) - launch.t), toolCallId: launch.id });
      }
    }
    const nextProcess = new Map(), nextCommand = new Map();
    assign(processPairs, nextProcess);
    assign(commandPairs, nextCommand);
    diffInto(processParents, nextProcess);
    diffInto(commandParents, nextCommand);
  }

  return {
    agentUpserted, agentRemoved, procsChanged, eventSeen, setExternal, flush, fuzzy,
    get fuzzyPending() { return fuzzyDirty; },
    all: () => [...effective.values()],
    linkOf: key => effective.get(key) ?? null,
    childrenOf: key => children.get(key) ?? new Set(),
  };
}


