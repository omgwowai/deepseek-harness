// Event storage of the hub: one ring per agent (events upserted by id, kept sorted by time), the pod/file touch
// indexes built from event targets, the fleet-wide feed (latest tool / spawn / error events) and tool-call search.
// Pure data structures: no timers, no I/O. The state module owns journaling and broadcasting.
import { LIMITS, NAMESPACE, TARGET_TYPES, parseAgentKey, podKey, siteOfCluster } from "../protocol.mjs";

export const FEED_TYPES = new Set(["tool", "spawn", "error"]);
const TOUCH_CAP = Object.freeze({ pod: 500, file: 300 });
const SAME_T_MS = 1000;           // a re-sent event whose time moved less than this (skew re-estimation) is unchanged
const MAX_QUERY_MATCHES = 100_000;

/** Pod key an event target refers to, or null when site or name are unknown. */
export function podKeyOfTarget(target) {
  if (target?.type !== "pod" || typeof target.name !== "string" || target.name === "") return null;
  const site = target.site || siteOfCluster(target.cluster);
  return site ? podKey(site, target.namespace || NAMESPACE, target.name) : null;
}

/** `<host>:<path>` key of a file target; `defaultHost` is the host of the agent that made the call. */
export function fileKeyOfTarget(target, defaultHost) {
  if (target?.type !== "file" || typeof target.path !== "string" || target.path === "") return null;
  return `${target.host || defaultHost}:${target.path}`;
}

function insertByTime(list, item, timeOf) {
  let index = list.length;
  while (index > 0 && timeOf(list[index - 1]) > timeOf(item)) index -= 1;   // arrival is almost always in order
  list.splice(index, 0, item);
}

/** First index whose event time is >= t. */
function lowerBound(list, t) {
  let low = 0, high = list.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (list[mid].t < t) low = mid + 1; else high = mid;
  }
  return low;
}

function sameEvent(a, b) {
  if (Math.abs(a.t - b.t) > SAME_T_MS) return false;
  const { t: _a, ...restA } = a, { t: _b, ...restB } = b;
  return JSON.stringify(restA) === JSON.stringify(restB);
}

const csv = value => {
  if (value === undefined || value === null || value === "") return null;
  const items = String(value).split(",").map(item => item.trim()).filter(Boolean);
  return items.length === 0 ? null : new Set(items);
};

function targetText(target) {
  return [target.path, target.name, target.url, target.host, target.pod, target.namespace, target.container, target.resource, target.cluster, target.site].filter(Boolean).join(" ");
}

export function createEventStore({ perAgent = LIMITS.hubEventsPerAgent, feedItems = LIMITS.feedItems } = {}) {
  const rings = new Map();                        // agent key → {list, byId, evicted, exhausted}
  const touches = { pod: new Map(), file: new Map() };   // entity key → Map<"agent\0event", Touch>
  const feed = [];                                // {agent, event}, event time ascending
  const feedIndex = new Map();                    // "agent\0event id" → entry

  const ringOf = key => {
    let ring = rings.get(key);
    if (ring === undefined) rings.set(key, ring = { list: [], byId: new Map(), evicted: 0, exhausted: false });
    return ring;
  };

  function entitiesOf(event, hostId) {
    const found = [], seen = new Set();
    for (const target of event.targets ?? []) {
      let type = null, key = null;
      if (target?.type === "pod") { type = "pod"; key = podKeyOfTarget(target); }
      else if (target?.type === "file") { type = "file"; key = fileKeyOfTarget(target, hostId); }
      if (key === null || seen.has(`${type}\u0000${key}`)) continue;
      seen.add(`${type}\u0000${key}`);
      found.push({ type, key, target });
    }
    return found;
  }

  /** Adds the event's touches; returns the pod keys that had no touch before. */
  function index(agentKey, event, hostId) {
    const fresh = [];
    for (const { type, key, target } of entitiesOf(event, hostId)) {
      let map = touches[type].get(key);
      if (map === undefined) { touches[type].set(key, map = new Map()); if (type === "pod") fresh.push(key); }
      map.set(`${agentKey}\u0000${event.id}`, { agent: agentKey, event: event.id, t: event.t, op: target.op, category: event.category, name: event.name, preview: event.preview });
      if (map.size > TOUCH_CAP[type]) map.delete(map.keys().next().value);
    }
    return fresh;
  }

  function unindex(agentKey, event, hostId) {
    for (const { type, key } of entitiesOf(event, hostId)) {
      const map = touches[type].get(key);
      if (map === undefined) continue;
      map.delete(`${agentKey}\u0000${event.id}`);
      if (map.size === 0) touches[type].delete(key);
    }
  }

  const feedId = (agentKey, eventId) => `${agentKey}\u0000${eventId}`;

  function feedUpsert(agentKey, event) {
    const id = feedId(agentKey, event.id);
    const existing = feedIndex.get(id);
    if (existing !== undefined) {
      if (existing.event.t !== event.t) { feed.splice(feed.indexOf(existing), 1); existing.event = event; insertByTime(feed, existing, entry => entry.event.t); }
      else existing.event = event;
      return existing;
    }
    if (feed.length >= feedItems && event.t < feed[0].event.t) return null;   // older than everything a full feed holds
    const entry = { agent: agentKey, event };
    insertByTime(feed, entry, item => item.event.t);
    feedIndex.set(id, entry);
    while (feed.length > feedItems) {
      const dropped = feed.shift();
      feedIndex.delete(feedId(dropped.agent, dropped.event.id));
    }
    return feedIndex.get(id) ?? null;
  }

  function evict(agentKey, ring, hostId) {
    while (ring.list.length > perAgent) {
      const old = ring.list.shift();
      ring.byId.delete(old.id);
      ring.evicted += 1;
      unindex(agentKey, old, hostId);
    }
  }

  return {
    /**
     * Insert or update one event (by id). Returns {changed:false} when nothing differs, else
     * {changed:true, event, newPods, feedEntry}: pod keys touched for the first time and the feed entry to journal.
     */
    upsert(agentKey, event, hostId = parseAgentKey(agentKey)?.hostId) {
      const ring = ringOf(agentKey);
      const prev = ring.byId.get(event.id);
      if (prev !== undefined) {
        if (sameEvent(prev, event)) return { changed: false };
        unindex(agentKey, prev, hostId);
        const at = ring.list.lastIndexOf(prev);                     // updates (pending → ok) hit the newest events
        if (prev.t === event.t) ring.list[at] = event;
        else { ring.list.splice(at, 1); insertByTime(ring.list, event, item => item.t); }
        ring.byId.set(event.id, event);
      } else {
        insertByTime(ring.list, event, item => item.t);
        ring.byId.set(event.id, event);
        evict(agentKey, ring, hostId);
        if (ring.byId.get(event.id) !== event) return { changed: false };       // older than a full ring
      }
      const newPods = index(agentKey, event, hostId);
      const feedEntry = FEED_TYPES.has(event.type) ? feedUpsert(agentKey, event) : null;
      return { changed: true, event, newPods, feedEntry };
    },

    /** Forget an agent: its ring, its touches and its feed entries. */
    removeAgent(agentKey) {
      const ring = rings.get(agentKey);
      if (ring === undefined) return;
      const hostId = parseAgentKey(agentKey)?.hostId;
      for (const event of ring.list) unindex(agentKey, event, hostId);
      rings.delete(agentKey);
      for (let i = feed.length - 1; i >= 0; i -= 1) {
        if (feed[i].agent !== agentKey) continue;
        feedIndex.delete(feedId(agentKey, feed[i].event.id));
        feed.splice(i, 1);
      }
    },

    /** Events older than `before` (exclusive), the last `limit` of them, oldest first. */
    slice(agentKey, { before, limit = 200 } = {}) {
      const ring = rings.get(agentKey);
      if (ring === undefined) return { events: [], more: false };
      const end = Number.isFinite(before) ? lowerBound(ring.list, before) : ring.list.length;
      const start = Math.max(0, end - Math.max(1, limit));
      return { events: ring.list.slice(start, end), more: start > 0 };
    },

    tail(agentKey, count) {
      const ring = rings.get(agentKey);
      return ring === undefined ? [] : ring.list.slice(-count);
    },

    ringInfo(agentKey) {
      const ring = rings.get(agentKey);
      return ring === undefined ? { size: 0, evicted: 0, exhausted: false } : { size: ring.list.length, evicted: ring.evicted, exhausted: ring.exhausted };
    },

    /** The collector holds nothing older than this ring's oldest event: stop asking it. */
    markExhausted(agentKey) { const ring = rings.get(agentKey); if (ring !== undefined) ring.exhausted = true; },

    /** Touches of a pod or file key, newest first. */
    touchesOf(type, key, limit = 200) {
      const map = touches[type]?.get(key);
      if (map === undefined) return [];
      return [...map.values()].sort((a, b) => b.t - a.t).slice(0, limit);
    },

    isTouched: (type, key) => touches[type]?.has(key) === true,
    touchedPodKeys: () => [...touches.pod.keys()],

    feedItems: () => feed.map(({ agent, event }) => ({ agent, event })),

    /**
     * Tool-call search over every ring. Filters: kind, site, host, category (comma lists), target (a TARGET_TYPES
     * value, or free text matched against target fields), text, since (ms), limit.
     * @param {(agentKey: string) => {kind: string, site: string, host: string} | undefined} agentOf
     */
    query(filters, agentOf) {
      const kinds = csv(filters.kind), sites = csv(filters.site), hosts = csv(filters.host), categories = csv(filters.category);
      const since = Number.isFinite(filters.since) ? filters.since : undefined;
      const limit = Math.min(3000, Math.max(1, Number.isFinite(filters.limit) ? Math.floor(filters.limit) : 200));
      const targetType = TARGET_TYPES.includes(filters.target) ? filters.target : null;
      const targetText_ = !targetType && typeof filters.target === "string" && filters.target !== "" ? filters.target.toLowerCase() : null;
      const text = typeof filters.text === "string" && filters.text !== "" ? filters.text.toLowerCase() : null;
      const matches = [];
      let total = 0;
      for (const [key, ring] of rings) {
        const agent = agentOf(key);
        if (agent === undefined) continue;
        if ((kinds && !kinds.has(agent.kind)) || (sites && !sites.has(agent.site)) || (hosts && !hosts.has(agent.host))) continue;
        for (let i = ring.list.length - 1; i >= 0; i -= 1) {
          const event = ring.list[i];
          if (since !== undefined && event.t < since) break;
          if (event.type !== "tool" && event.type !== "spawn") continue;
          if (categories && !categories.has(event.category)) continue;
          if (targetType && !(event.targets ?? []).some(target => target.type === targetType)) continue;
          if (targetText_ && !(event.targets ?? []).some(target => targetText(target).toLowerCase().includes(targetText_))) continue;
          if (text) {
            const haystack = [event.name, event.preview, event.text, ...(event.targets ?? []).map(targetText)].filter(Boolean).join("\n").toLowerCase();
            if (!haystack.includes(text)) continue;
          }
          total += 1;
          if (matches.length < MAX_QUERY_MATCHES) matches.push({ agent: key, event });
        }
      }
      matches.sort((a, b) => b.event.t - a.event.t);
      return { items: matches.slice(0, limit), total };
    },
  };
}
