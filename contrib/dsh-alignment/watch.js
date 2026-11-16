/**
 * Alignment page change watcher (2026-10-22, multi-type phone alerts; plan tmp/probe/alignment-entry-v2/c-decision-alert-plan.md).
 *
 * Every writer of an alignment page (the align CLI in First Mate's own process, 3080's /answer, the 3390 server) writes
 * "temp file + atomic rename", so fs.watch on the file dies after the first rename and directory watching on Windows
 * double-fires and misses. fs.watchFile polls stat() by path (2 s), which survives renames; there are only a handful of
 * files (the registry + one per page).
 *
 * The plugin calls scan() once at apply time as the BASELINE: snapshots only, no alerts (a 3080 restart never re-alerts
 * decisions that appeared while it was down). After that every stat change rescans all pages and compares with the
 * snapshot:
 *   decision -> open (added open, pending -> open, sent -> open)     alert kind "decision"
 *   round -> waiting (added waiting, doing / paused -> waiting)      alert kind "round-waiting"
 *   round -> done (added done, anything else -> done), version-3 pages only           alert kind "round-done"
 *     (v3 2026-10-25, "needs your review"): not for the previous round that `round add --prev` closes itself (a round
 *     added in the same scan has prev pointing at it), not for accepted / dropped; text = result ?? state.
 *     Revise and redeliver (done -> doing -> done) gets a new updated, so it is a new alert.
 *   decision leaves open, text edits on an open decision, other round endings: no alert (only the page summary changes)
 * A page that shows up in the registry after the baseline counts as new: its open decisions / waiting rounds alert.
 * Deadlines (page api 7): an open decision whose due is less than an hour away alerts once as "decision-due-soon"
 * (alertId decision-due-soon:<page>:<id>:<due>; a new due is a new alert). This is time-based, so the plugin also calls
 * tick() on a timer; deadlines already inside the hour at the baseline are marked seen without an alert, like the rest.
 * alertId = <kind>:<page>:<item id>:<item updated>. align.mjs refreshes "updated" on decide add / decide set / round set,
 * so a decision put back to open is a new alert, while rereading an unchanged file never yields a new id.
 *
 * Output: emit({pages, alerts}) only when there are alerts or the page summary (open decision ids) changed;
 * pages = [{name, title, open, openIds}] is also what openState() returns (the gateway's connect baseline).
 * A page or registry that fails to parse keeps its old snapshot, emits nothing and is reported through errors()
 * (/alignment/health watchError) and console.error; it is never skipped silently.
 */
import fs from "node:fs";

export const WATCH_INTERVAL_MS = 2000;
/** "decision-due-soon" fires once when the deadline is this close (spec: phone reminder 1 hour before). */
export const DUE_SOON_MS = 60 * 60 * 1000;
const REGISTRY = "(registry)";

const str = (v) => (typeof v === "string" && v !== "" ? v : null);

/** One page's data (version 2 or 3) -> {version, title, owner, decisions: Map, rounds: Map}. */
export function snapshotOf(data) {
  const decisions = new Map();
  const rounds = new Map();
  if (data.version === 3) {
    for (const d of data.decisions) decisions.set(d.id, { status: d.status, updated: d.updated, title: d.title, sid: d.sid, why: d.why, rec: d.rec, due: d.due });
    for (const r of data.rounds) rounds.set(r.id, { status: r.status, updated: r.updated, title: r.title, sid: r.sid, next: r.next, state: r.state, result: r.result, prev: r.prev });
  } else if (data.version === 2) {
    for (const it of data.items) {
      if (it.sec === "decide") decisions.set(it.id, { status: it.status, updated: it.updated, title: it.title, sid: it.sid, why: it.why, rec: it.rec });
      // version 2 has no round status: doing + who=you is "waiting" (the phone's "waiting for you" list), done is ended
      else if (it.sec === "doing") rounds.set(it.id, { status: it.who === "you" ? "waiting" : "doing", updated: it.updated, title: it.title, sid: it.sid, next: it.next, state: it.state });
      else if (it.sec === "done") rounds.set(it.id, { status: "done", updated: it.updated, title: it.title });
    }
  } else {
    throw new Error("dsh-alignment watch: unknown page data version " + data.version);
  }
  return { version: data.version, title: data.title, owner: data.owner, decisions, rounds };
}

/** Page summary for the phone: open decision ids in page order. */
export function pageSummary(name, snap) {
  const openIds = [...snap.decisions].filter(([, d]) => d.status === "open").map(([id]) => id);
  return { name, title: snap.title, open: openIds.length, openIds };
}

/** Alerts for one page going from prev (null = never seen) to next. */
export function pageAlerts(name, prev, next) {
  const alerts = [];
  const summary = pageSummary(name, next);
  for (const [id, d] of next.decisions) {
    if (d.status !== "open" || prev?.decisions.get(id)?.status === "open") continue;
    const why = str(d.why);
    const rec = str(d.rec);
    alerts.push({
      kind: "decision", alertId: "decision:" + name + ":" + id + ":" + d.updated,
      page: name, pageTitle: next.title, itemId: id, title: d.title,
      sessionId: str(d.sid) ?? str(next.owner),
      text: rec ? "推荐：" + rec + "。" + (why ?? "") : why,
      open: summary.open,
    });
  }
  for (const [id, r] of next.rounds) {
    if (r.status !== "waiting" || prev?.rounds.get(id)?.status === "waiting") continue;
    alerts.push({
      kind: "round-waiting", alertId: "round-waiting:" + name + ":" + id + ":" + r.updated,
      page: name, pageTitle: next.title, itemId: id, title: r.title,
      sessionId: str(r.sid), // the round's own session (the app merges it with that session's question alert); null if unknown
      text: str(r.next) ?? str(r.state),
    });
  }
  if (next.version !== 3) return alerts; // version 2 has no review state of its own (done = ended)
  // `round add --prev` closes the previous round itself (align.mjs): a round new in this scan whose prev points at it
  const autoClosed = new Set();
  for (const [id, r] of next.rounds) if (!prev?.rounds.has(id) && str(r.prev)) autoClosed.add(r.prev);
  for (const [id, r] of next.rounds) {
    if (r.status !== "done" || prev?.rounds.get(id)?.status === "done" || autoClosed.has(id)) continue;
    alerts.push({
      kind: "round-done", alertId: "round-done:" + name + ":" + id + ":" + r.updated,
      page: name, pageTitle: next.title, itemId: id, title: r.title,
      sessionId: str(r.sid),
      text: str(r.result) ?? str(r.state),
    });
  }
  return alerts;
}

/**
 * readRegistry(): {name: file} (align.mjs readRegistry); parsePage(text): data (align.mjs parsePage, throws on bad pages);
 * emit({pages, alerts}); log(line) for errors. interval: watchFile polling interval.
 */
/** "decision-due-soon" alerts of one page at time now (ms); seen = Set of "<page>:<id>:<due>" already alerted (mutated). */
export function dueSoonAlerts(name, snap, now, seen, quiet = false) {
  const alerts = [];
  for (const [id, d] of snap.decisions) {
    if (d.status !== "open" || !str(d.due)) continue;
    const due = Date.parse(d.due);
    if (Number.isNaN(due)) throw new Error("dsh-alignment watch: decision " + name + "/" + id + " has an unreadable due " + JSON.stringify(d.due));
    const key = name + ":" + id + ":" + d.due;
    if (due <= now || due - now > DUE_SOON_MS || seen.has(key)) continue;
    seen.add(key);
    if (quiet) continue;
    const minutes = Math.max(1, Math.round((due - now) / 60000));
    alerts.push({
      kind: "decision-due-soon", alertId: "decision-due-soon:" + key,
      page: name, pageTitle: snap.title, itemId: id, title: d.title, sessionId: str(d.sid) ?? str(snap.owner), due: d.due,
      text: "还有 " + minutes + " 分钟到截止，" + (str(d.rec) ? "到点没人答就按推荐「" + d.rec + "」处理" : "到点没有推荐可用，会再提醒"),
    });
  }
  return alerts;
}

export function createAlignmentWatcher({ readRegistry, parsePage, emit, log = (line) => console.error(line), interval = WATCH_INTERVAL_MS, now: clock = Date.now }) {
  for (const [k, f] of Object.entries({ readRegistry, parsePage, emit })) if (typeof f !== "function") throw new TypeError("dsh-alignment watch: " + k + " must be a function");
  let files = new Map(); // name -> file (last good registry)
  const snaps = new Map(); // name -> snapshot (last good parse)
  const failures = new Map(); // name | REGISTRY -> {page, message, at}
  let lastPages = "[]";
  let baselineDone = false;
  const watched = new Set();
  let registryPath = null; // set by start(); null = not polling
  const dueSeen = new Set(); // "<page>:<id>:<due>" already alerted as due-soon

  const fail = (page, error) => {
    const message = error && error.message ? error.message : String(error);
    const prev = failures.get(page);
    failures.set(page, { page, message, at: prev?.message === message ? prev.at : new Date().toISOString() });
    if (prev?.message !== message) log("[dsh-alignment] watch: " + (page === REGISTRY ? "registry" : "page " + page) + " unreadable, keeping the last good state: " + message);
  };
  const pages = () => [...files.keys()].filter((n) => snaps.has(n)).map((n) => pageSummary(n, snaps.get(n)));

  /** Rescan everything; returns the emitted payload or null. The first call is the baseline (never alerts). */
  function scan() {
    const baseline = !baselineDone;
    baselineDone = true;
    let reg;
    try {
      reg = readRegistry();
      if (!reg || typeof reg !== "object" || Array.isArray(reg)) throw new Error("registry is not a {name: file} object");
      failures.delete(REGISTRY);
      files = new Map(Object.entries(reg));
    } catch (e) { fail(REGISTRY, e); }
    for (const name of [...snaps.keys()]) if (!files.has(name)) snaps.delete(name);
    for (const name of [...failures.keys()]) if (name !== REGISTRY && !files.has(name)) failures.delete(name);
    const alerts = [];
    for (const [name, file] of files) {
      let next;
      try { next = snapshotOf(parsePage(fs.readFileSync(file, "utf8"))); } catch (e) { fail(name, e); continue; }
      failures.delete(name);
      const prev = snaps.get(name) ?? null;
      snaps.set(name, next);
      if (!baseline) alerts.push(...pageAlerts(name, prev, next));
      try { alerts.push(...dueSoonAlerts(name, next, clock(), dueSeen, baseline)); } catch (e) { fail(name, e); }
    }
    if (registryPath) syncWatches();
    const now = pages();
    const json = JSON.stringify(now);
    const changed = json !== lastPages;
    lastPages = json;
    if (baseline || (!changed && alerts.length === 0)) return null;
    const payload = { pages: now, alerts };
    emit(payload);
    return payload;
  }

  // A rescan from a stat callback must never throw into the timer (that would take the 3080 process down):
  // parse failures are already in errors(); anything else (an emit listener throwing) is recorded the same way.
  const onChange = () => {
    try { scan(); failures.delete("(emit)"); } catch (e) { fail("(emit)", e); }
  };
  // Poll the registry and every registered page file; files of unregistered pages are dropped.
  function syncWatches() {
    const want = new Set([registryPath, ...files.values()]);
    for (const f of watched) if (!want.has(f)) { fs.unwatchFile(f, onChange); watched.delete(f); }
    for (const f of want) if (!watched.has(f)) { fs.watchFile(f, { interval, persistent: false }, onChange); watched.add(f); }
  }

  return {
    scan,
    /** Rescan from a timer (deadlines move with the clock, not with file changes); never throws, like the stat callback. */
    tick: () => onChange(),
    /** Start polling the registry file and every page file (call after the baseline scan). */
    start(registryFile) {
      if (typeof registryFile !== "string" || !registryFile) throw new TypeError("dsh-alignment watch: start(registryFile) needs the registry path");
      registryPath = registryFile;
      syncWatches();
    },
    stop() {
      registryPath = null;
      for (const f of watched) fs.unwatchFile(f, onChange);
      watched.clear();
    },
    /** [{name, title, open, openIds}] of every readable registered page (last good state). */
    openState: () => pages(),
    /** null when every file parsed, else [{page, message, at}] ("(registry)" for the registry, "(emit)" for a listener error). */
    errors: () => (failures.size ? [...failures.values()] : null),
    watchedFiles: () => [...watched],
  };
}
