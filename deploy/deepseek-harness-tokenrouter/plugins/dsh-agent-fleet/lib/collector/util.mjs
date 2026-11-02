// Small shared helpers for the collector modules: bounded concurrency, loop yielding, durations.

/** Run `fn(item, index)` over `items` with at most `limit` in flight; resolves with the results in order. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Let pending I/O callbacks and timers run. */
export const yieldToLoop = () => new Promise(resolve => setImmediate(resolve));

const UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** "24h", "90m", "1d", "1500" (ms) → milliseconds. Throws on anything else. */
export function parseDuration(text) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?\s*$/i.exec(String(text));
  if (!match) throw new Error(`invalid duration "${text}" (use e.g. 90m, 6h, 24h, 2d)`);
  return Math.round(Number(match[1]) * UNITS[(match[2] ?? "ms").toLowerCase()]);
}

/** True for the error codes that mean "the path is gone". */
export const isMissing = error => error?.code === "ENOENT" || error?.code === "ENOTDIR";

/**
 * Most recent events of one agent, keyed by event id: pushing an id again replaces the event in place (a tool call
 * going pending → ok keeps its position). The oldest events fall off once `cap` is exceeded.
 */
export class EventRing {
  constructor(cap) { this.cap = cap; this.map = new Map(); this.evicted = false; }
  get size() { return this.map.size; }
  push(event) {
    this.map.set(event.id, event);
    if (this.map.size > this.cap) { this.map.delete(this.map.keys().next().value); this.evicted = true; }
  }
  all() { return [...this.map.values()]; }
  last(count) { const all = this.all(); return count >= all.length ? all : all.slice(all.length - count); }
  clear() { this.map.clear(); this.evicted = false; }
}
