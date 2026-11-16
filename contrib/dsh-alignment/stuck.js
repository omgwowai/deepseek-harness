/**
 * Stuck-round reminders (2026-11-02): the 3080 side of "a session handed in its result, the round still sits in 阻塞".
 *
 * Why: dsh-fm lists "已停没有下一步" rounds in the turn-end notice, once, at the moment the turn ends. A 2026-10-30 ..
 * 11-02 count over the First Mate page found 8 stretches (38.6 h) where the session had delivered and the round stayed
 * 已停 / 暂缓 for 10 min or more; every notice had arrived (158/158), but First Mate answered with state/next only (or
 * paused), and 6 of the 8 then crossed a First Mate handover: nothing ever asked again. This runner asks again, once.
 *
 * run() reads every registered version-3 page that has an owner, and for the rounds that are doing with a session asks
 * live(sids) (liveStates: running | subagent | job | idle) and, for idle sessions, lastTurn(sid) (the todo index:
 * {at, kind} of the last turn/end, or null). align.mjs stuckReminders(data, now, live, turns, seen) says which rounds have
 * been stopped for STUCK_REMIND_MS; each gets one notice to the page owner (stuckReminderText, summary stuckSummary).
 * One reminder per round, per turn end and per owner (a new First Mate gets its own); kept in memory, so a 3080 restart
 * may remind once more. Nothing is sent during the first STUCK_GRACE_MS after the plugin starts: right after a restart the
 * sessions it cut are still idle until resume-interrupted wakes them. Never changes the page: whether the session really
 * delivered is First Mate's call.
 * A failure (unreadable page, a session log that cannot be read, a send that fails) is not swallowed: console.error once
 * per distinct message and kept in errors() (/alignment/health stuckError) until that item succeeds; retried next run.
 */

/** The message source of a reminder: drawn by dsh-thread-message like dsh-fm's notices (a card linked to the sid line). */
export function noticeSource(summary) {
  if (typeof summary !== "string" || summary === "") throw new Error("dsh-alignment: a stuck-round reminder needs a one-line summary");
  return { kind: "plugin:dsh-fm", form: "notice", summary };
}

export const STUCK_GRACE_MS = 5 * 60 * 1000;

export function createStuckRunner({ readRegistry, pageData, stuckReminders, stuckReminderText, stuckSummary, live, lastTurn, send, now = Date.now, graceMs = STUCK_GRACE_MS, log = (line) => console.error(line) }) {
  for (const [k, f] of Object.entries({ readRegistry, pageData, stuckReminders, stuckReminderText, stuckSummary, live, lastTurn, send })) {
    if (typeof f !== "function") throw new TypeError("dsh-alignment stuck: " + k + " must be a function");
  }
  const sent = new Set(); // "<page>|<owner>|<round>@<turn end>"
  const failures = new Map(); // "<page>" | "<page>/<sid or round>" -> {item, message, at}
  const fail = (item, error) => {
    const message = error && error.message ? error.message : String(error);
    const prev = failures.get(item);
    failures.set(item, { item, message, at: prev?.message === message ? prev.at : new Date().toISOString() });
    if (prev?.message !== message) log("[dsh-alignment] stuck: " + item + ": " + message);
  };
  let running = null;
  const startedAt = now();

  async function once() {
    const done = [];
    if (now() - startedAt < graceMs) return done;
    let reg;
    try { reg = readRegistry(); failures.delete("(registry)"); } catch (e) { fail("(registry)", e); return done; }
    for (const name of Object.keys(reg)) {
      let data;
      try { data = pageData(name); failures.delete(name); } catch (e) { fail(name, e); continue; }
      if (data.version !== 3 || !data.owner) continue;
      const sids = [...new Set(data.rounds.filter((r) => r.status === "doing" && r.sid).map((r) => r.sid))];
      if (sids.length === 0) continue;
      let states;
      try { states = await live(sids); failures.delete(name + "/live"); } catch (e) { fail(name + "/live", e); continue; }
      const turns = {}, known = {};
      for (const sid of sids) {
        known[sid] = states[sid];
        if (states[sid] !== "idle") continue;
        // a session whose log cannot be read is left out (unknown: never reminded on a guess)
        try { turns[sid] = await lastTurn(sid); failures.delete(name + "/" + sid); } catch (e) { fail(name + "/" + sid, e); known[sid] = "unknown"; }
      }
      const prefix = name + "|" + data.owner + "|";
      const seen = new Set([...sent].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)));
      const at = now();
      let due;
      try { due = stuckReminders(data, at, known, turns, seen); } catch (e) { fail(name, e); continue; }
      for (const it of due) {
        const item = name + "/" + it.id;
        try {
          await send(data.owner, stuckReminderText(data, name, it, at), stuckSummary(it));
          sent.add(prefix + it.key);
          failures.delete(item);
          done.push({ page: name, id: it.id, sid: it.sid, to: data.owner });
        } catch (e) { fail(item, e); }
      }
    }
    for (const item of [...failures.keys()]) if (item !== "(registry)" && !(item.split("/")[0] in reg)) failures.delete(item);
    return done;
  }

  return {
    /** One pass over every page; resolves to [{page, id, sid, to}] reminded in this pass. Overlapping calls share a pass. */
    run() {
      if (running === null) running = once().finally(() => { running = null; });
      return running;
    },
    /** null, or [{item, message, at}] for pages / sessions / rounds that could not be handled. */
    errors: () => (failures.size ? [...failures.values()] : null),
  };
}
