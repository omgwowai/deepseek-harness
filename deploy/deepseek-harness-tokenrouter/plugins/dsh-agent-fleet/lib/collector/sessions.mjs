// Sessions: one tracked entry per admitted transcript. Each has a tail (appended bytes only), a reader (turns native
// rows into an AgentRecord + AgentEvents), the latest record and the most recent events. Entries are polled on a
// cadence by activity: 500 ms while modified within 10 min, 1 s while bound to a live process, 5 s warm, 30 s cold.
// A new entry is read from byte 0 in chunks (large files a few at a time, newest first) and only reported once it
// has caught up. Transcripts on network file systems are opened before each hot poll: the open revalidates the
// client's cached attributes, a bare stat could report a size that is seconds old.
import { open, realpath, stat } from "node:fs/promises";
import { createTail, readFirstLine } from "../jsonl.mjs";
import { LIMITS, agentKey } from "../protocol.mjs";
import { READERS } from "./readers/index.mjs";
import { EventRing, isMissing, yieldToLoop } from "./util.mjs";

const HOT_MS = 10 * 60_000;
const SLACK_MS = 60;              // a poll may run this early: tick jitter must not push a 500 ms cadence to 1 s
const CHUNK_BYTES = 8 * 1024 * 1024;
const CHUNKS_PER_VISIT = 4;       // then yield to the other entries and continue on the next pass
const HEAVY_BYTES = 4 * 1024 * 1024; // initial loads of files above this size are limited to `maxLoads` at a time
const PENDING_CAP = 2000;
const TITLE_RECHECK_MS = 2000;
const MAX_WARNINGS = 3;

/**
 * Entry fields owned by this module are created in `add`; the collector index additionally keeps `bound`, `match`
 * (the live process holding the transcript), `sent`, `lastJson`, `dirty`, `lockKey` and `staleMark` on the entry.
 * @param {object} options
 * @param {(entry: object, why: "read"|"link"|"settle") => void} options.onUpdate  record / events changed
 * @param {(entry: object) => void} options.onRemove  a tracked entry disappeared
 * @param {(path: string) => void} [options.onActive]  a tracked transcript changed on disk
 * @param {(path: string) => void} [options.onMissing]  a tracked transcript vanished (tell discovery to forget it)
 */
export function createSessions({ host, site, now = Date.now, since, pollMs = 500, onUpdate, onRemove, onActive = () => {}, onMissing = () => {}, log = () => {}, maxLoads = 3, concurrency = 24, ringSize = LIMITS.initialEventsPerAgent }) {
  const entries = new Map(); // transcript path → entry
  const byKey = new Map();   // agent key → entry (last tracked wins when two paths claim one id)
  let inflight = 0, heavyLoading = 0, timer = null, passQueued = false, backlog = false, stopped = false;
  const counters = { polls: 0, reads: 0, linesFed: 0, resets: 0, errors: 0 };

  const readerOptions = entry => ({ file: entry.file, host, site, root: entry.root, now });
  const formatOf = path => (path.endsWith(".zstd") ? "zstd" : "jsonl");

  function warn(entry, message) {
    counters.errors += 1;
    entry.warnings = (entry.warnings ?? 0) + 1;
    if (entry.warnings <= MAX_WARNINGS) log(`${entry.file}: ${message}`);
  }

  /** @param {{path: string, match: object, root: object, stat: object}} file */
  function add({ path, match, root, stat: info }) {
    if (stopped || entries.has(path)) return entries.get(path) ?? null;
    let tail, reader;
    try {
      tail = createTail(path, { format: formatOf(path) });
      reader = READERS[match.kind].createReader({ file: path, host, site, root: root.dir, now });
    } catch (error) { log(`${path}: cannot read as ${match.kind}: ${error.message}`); return null; }
    const entry = {
      file: path, realFile: path, kind: match.kind, id: match.id, role: match.role, parentFile: match.parentFile,
      key: agentKey(host, match.kind, match.id), root: root.dir, container: root.container, network: root.network === true,
      tail, reader, ring: new EventRing(ringSize), pending: [], spawnIds: new Map(),
      record: null, loaded: false, removed: false, busy: false, settleAt: null,
      mtimeMs: info?.mtimeMs ?? 0, size: -1, sizeHint: info?.size ?? 0, ino: info?.ino ?? 0, nextPollAt: 0, titleAt: 0, titleSig: "",
      // owned by the collector index
      bound: false, match: null, sent: false, lastJson: "", dirty: false, lockKey: null, staleMark: 0,
    };
    entries.set(path, entry);
    byKey.set(entry.key, entry);
    realpath(path).then(real => { entry.realFile = real; }, () => {});
    requestPass();
    return entry;
  }

  function removeEntry(entry) {
    if (entry.removed) return;
    entry.removed = true;
    entries.delete(entry.file);
    if (byKey.get(entry.key) === entry) { byKey.delete(entry.key); onRemove(entry); }
  }

  const missing = entry => { onMissing(entry.file); removeEntry(entry); };

  function restart(entry) {
    counters.resets += 1;
    entry.reader = READERS[entry.kind].createReader(readerOptions(entry));
    entry.ring.clear();
    entry.pending = [];
    entry.spawnIds.clear();
    entry.loaded = false;
  }

  function drain(entry) {
    let events;
    try { events = entry.reader.takeEvents(); } catch (error) { warn(entry, `takeEvents failed: ${error.message}`); return; }
    for (const event of events) {
      entry.ring.push(event);
      entry.pending.push(event);
      if (event.type === "spawn" && event.child?.id && entry.spawnIds.get(event.child.id) !== event.id) {
        entry.spawnIds.set(event.child.id, event.id);
        const child = byKey.get(agentKey(host, event.child.kind ?? entry.kind, event.child.id));
        if (child && child !== entry && child.loaded) onUpdate(child, "link");
      }
    }
    if (entry.pending.length > PENDING_CAP) entry.pending.splice(0, entry.pending.length - PENDING_CAP);
  }

  function feed(entry, lines) {
    counters.linesFed += lines.length;
    try { entry.reader.feed(lines); } catch (error) { warn(entry, `reader failed: ${error.message}`); return; }
    drain(entry);
  }

  function snapshot(entry) {
    try {
      entry.record = entry.reader.snapshot();
      entry.settleAt = entry.reader.settleAt?.() ?? null;
    } catch (error) { warn(entry, `snapshot failed: ${error.message}`); }
  }

  async function refreshTitle(entry) {
    entry.titleAt = now();
    const first = await readFirstLine(entry.file);
    if (!first || first.type !== "title") return;
    const signature = JSON.stringify(first.title ?? null);
    if (signature === entry.titleSig) return;
    entry.titleSig = signature;
    feed(entry, [first]);
  }

  /** Read what was appended, a few chunks per visit. Leaves the entry due again when it is not caught up. */
  async function readNew(entry, mtimeChanged) {
    counters.reads += 1;
    let complete = false;
    for (let visit = 0; visit < CHUNKS_PER_VISIT; visit += 1) {
      let result;
      try { result = await entry.tail.read({ maxBytes: CHUNK_BYTES }); } catch (error) {
        warn(entry, `read failed: ${error.message}`);
        entry.nextPollAt = now() + 5000;
        return;
      }
      if (entry.removed) return;
      if (result.missing) { missing(entry); return; }
      if (result.reset) restart(entry);
      if (result.lines.length > 0) feed(entry, result.lines);
      if (!result.more) { complete = true; break; }
      await yieldToLoop();
    }
    if (!complete) { entry.nextPollAt = 0; return; }
    if (entry.kind === "omp" && entry.loaded && (mtimeChanged || entry.titleDue)) { // OMP rewrites line 1 in place
      entry.titleDue = now() - entry.titleAt <= TITLE_RECHECK_MS; // too soon after the last read: look again later
      if (!entry.titleDue) await refreshTitle(entry);
    }
    if (entry.removed) return;
    snapshot(entry);
    entry.loaded = true;
    onUpdate(entry, "read");
  }

  const periodFor = (entry, t) => {
    const age = t - entry.mtimeMs;
    if (age < HOT_MS) return pollMs;
    if (entry.bound) return Math.max(pollMs, 1000);
    return age < since ? 5000 : 30_000;
  };

  async function poll(entry) {
    counters.polls += 1;
    entry.busy = true;
    try {
      if (entry.network && now() - entry.mtimeMs < HOT_MS) { // refresh the cached attributes before stat
        try { await (await open(entry.file, "r")).close(); } catch { /* the stat below reports what is wrong */ }
      }
      let info;
      try { info = await stat(entry.file); } catch (error) {
        if (isMissing(error)) missing(entry); else entry.nextPollAt = now() + 5000;
        return;
      }
      const first = entry.size < 0;
      const mtimeChanged = info.mtimeMs !== entry.mtimeMs;
      const changed = first || mtimeChanged || info.size !== entry.size || info.ino !== entry.ino;
      entry.mtimeMs = info.mtimeMs; entry.size = info.size; entry.ino = info.ino;
      entry.nextPollAt = now() + periodFor(entry, now()) - SLACK_MS;
      if (changed && !first) onActive(entry.file);
      if (!changed && entry.loaded && !entry.titleDue) return;
      await readNew(entry, mtimeChanged);
    } finally { entry.busy = false; }
  }

  function launch(entry) {
    const heavy = !entry.loaded && entry.sizeHint > HEAVY_BYTES;
    inflight += 1;
    if (heavy) heavyLoading += 1;
    poll(entry).catch(error => warn(entry, `poll failed: ${error?.message ?? error}`)).finally(() => {
      inflight -= 1;
      if (heavy) heavyLoading -= 1;
      if (backlog) requestPass();
    });
  }

  /** Start polls for every entry that is due; never waits for them. */
  function pass() {
    passQueued = false;
    if (stopped) return;
    const t = now();
    const due = [];
    for (const entry of entries.values()) {
      if (entry.settleAt !== null && entry.loaded && t >= entry.settleAt) { snapshot(entry); onUpdate(entry, "settle"); }
      if (!entry.busy && entry.nextPollAt <= t) due.push(entry);
    }
    backlog = false;
    if (due.length === 0) return;
    // live polls first (most overdue first), then initial loads, newest transcripts first
    due.sort((a, b) => (a.loaded === b.loaded ? (a.loaded ? a.nextPollAt - b.nextPollAt : b.mtimeMs - a.mtimeMs) : a.loaded ? -1 : 1));
    for (const entry of due) {
      if (inflight >= concurrency) { backlog = true; return; }
      if (!entry.loaded && entry.sizeHint > HEAVY_BYTES && heavyLoading >= maxLoads) { backlog = true; continue; }
      launch(entry);
    }
  }

  function requestPass() {
    if (passQueued || stopped) return;
    passQueued = true;
    setImmediate(pass);
  }

  /** Re-read the whole transcript with a throwaway reader: its events (the newest hubEventsPerAgent), oldest first. */
  async function readEvents(entry) {
    const tail = createTail(entry.file, { format: formatOf(entry.file) });
    const reader = READERS[entry.kind].createReader(readerOptions(entry));
    for (;;) {
      const result = await tail.read({ maxBytes: CHUNK_BYTES });
      if (result.missing) break;
      reader.feed(result.lines);
      if (!result.more) break;
      await yieldToLoop();
    }
    return reader.takeEvents();
  }

  return {
    add,
    remove(path) { const entry = entries.get(path); if (entry) removeEntry(entry); },
    /** A watch event named this transcript: poll it now. */
    touch(path) { const entry = entries.get(path); if (entry) { entry.nextPollAt = 0; requestPass(); } },
    wake(entry) { entry.nextPollAt = 0; requestPass(); },
    start() { if (!timer && !stopped) { timer = setInterval(pass, pollMs); timer.unref?.(); requestPass(); } },
    stop() { stopped = true; clearInterval(timer); timer = null; },
    get: path => entries.get(path),
    byKey: key => byKey.get(key),
    all: () => entries.values(),
    readEvents,
    stats() {
      const t = now();
      let hot = 0, loaded = 0;
      for (const entry of entries.values()) { if (t - entry.mtimeMs < HOT_MS) hot += 1; if (entry.loaded) loaded += 1; }
      return { entries: entries.size, loaded, hot, inflight, heavyLoading, ...counters };
    },
  };
}
