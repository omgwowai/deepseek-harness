// Agent lookup and family roots over a hub Snapshot (agents + links); shared by the RPC routes and the model tool.
// A reference is a full key `<host>#<kind>:<id>`, a global key `<kind>:<id>`, or a bare session id (a DSH session id,
// the native id of an ACP-bound session, a Claude subagent's agent id, or an unambiguous prefix of one).
import { AGENT_KINDS } from "../protocol.mjs";

const GLOBAL_KEY = new RegExp(`^(${AGENT_KINDS.join("|")}):(.+)$`);
const MAX_HOPS = 200;

/** child key → {from, link}: hub `links` first, then the `parent.key` hint of agents the hub has not linked. */
export function buildParents(agents, links = []) {
  const byKey = new Map(agents.map(agent => [agent.key, agent]));
  const parents = new Map();
  const add = (from, to, link) => { if (from !== to && !parents.has(to) && byKey.has(from) && byKey.has(to)) parents.set(to, { from, link }); };
  for (const link of links) add(link.from, link.to, link);
  for (const agent of agents) {
    const hint = agent.parent;
    if (hint?.key) add(hint.key, agent.key, { from: hint.key, to: agent.key, via: hint.via, exact: Boolean(hint.exact) });
  }
  for (const key of [...parents.keys()]) {            // a cycle would hang every walk: cut it where it closes
    let current = key;
    for (let hops = 0; hops < MAX_HOPS && parents.has(current); hops += 1) {
      current = parents.get(current).from;
      if (current === key) { parents.delete(key); break; }
    }
  }
  return parents;
}

export function rootOf(parents, key) {
  let current = key;
  for (let hops = 0; hops < MAX_HOPS && parents.has(current); hops += 1) current = parents.get(current).from;
  return current;
}

/** parent key → child keys, in start order. */
export function buildChildren(agents, parents) {
  const byKey = new Map(agents.map(agent => [agent.key, agent]));
  const children = new Map();
  for (const [to, { from }] of parents) {
    const list = children.get(from) ?? [];
    list.push(to);
    children.set(from, list);
  }
  for (const list of children.values()) list.sort((a, b) => (byKey.get(a).startedAt - byKey.get(b).startedAt) || (a < b ? -1 : 1));
  return children;
}

/** Keys of `key` and all its descendants, parents before children. */
export function subtree(children, key) {
  const out = [], seen = new Set(), queue = [key];
  while (queue.length > 0) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    out.push(current);
    queue.push(...(children.get(current) ?? []));
  }
  return out;
}

function score(agent, ref, global) {
  if (agent.key === ref) return 100;
  if (global !== null && agent.kind === global[1] && agent.id === global[2]) return 90;
  if (agent.id === ref) return 80;                                                                         // a session id names that session itself
  if (agent.parent?.via === "acp" && agent.parent.kind === "dsh" && agent.parent.id === ref) return 70;   // a DSH session id, DSH record absent: its ACP-bound agent
  if (agent.acp?.id === ref) return 60;                                                                    // a native id, native record absent: the DSH session bound to it
  if (agent.kind === "claude" && agent.id.endsWith(`/${ref}`)) return 45;                                  // a Claude subagent's own agent id
  return 0;
}

/**
 * The agent a reference names, or null. Ties go to the most recently updated one. A prefix of at least 8
 * characters is accepted only when exactly one agent id starts with it.
 */
export function findAgent(agents, ref) {
  if (typeof ref !== "string" || ref.trim() === "") return null;
  const wanted = ref.trim();
  const global = GLOBAL_KEY.exec(wanted);
  let best = null, bestScore = 0;
  for (const agent of agents) {
    const points = score(agent, wanted, global);
    if (points > bestScore || (points === bestScore && points > 0 && (agent.updatedAt ?? 0) > (best.updatedAt ?? 0))) { best = agent; bestScore = points; }
  }
  if (best !== null) return best;
  if (wanted.length < 8) return null;
  const matches = agents.filter(agent => agent.id.startsWith(wanted) || (agent.acp?.id ?? "").startsWith(wanted));
  return matches.length === 1 ? matches[0] : null;
}

/** Family of a reference: the matched agent, its root, and the parents map. Null when nothing matches. */
export function resolveFamily(snapshot, ref) {
  const agents = snapshot.agents ?? [];
  const agent = findAgent(agents, ref);
  if (agent === null) return null;
  const parents = buildParents(agents, snapshot.links);
  return { agent, rootKey: rootOf(parents, agent.key), parents };
}
