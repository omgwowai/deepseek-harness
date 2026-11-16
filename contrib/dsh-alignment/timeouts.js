/**
 * Decision deadlines (alignment page api 7, 2026-10-22): the 3080 side of "超时按推荐".
 *
 * Why here: dsh-alignment is already resident in 3080, already polls the pages and already owns send(sid, prompt, card)
 * into a session; a scheduled task would need its own process, the threads CLI and its auth - one more failure path.
 *
 * run() reads every registered page and asks align.mjs timeoutCheck(data, now) what is due:
 *   {action:'auto'}   -> answerTimeout(page, id, send, now): message to the page owner, then status=sent choice=rec auto=timeout
 *   {action:'remind'} -> remindOverdue(page, id, send, now): one reminder to the owner, then overdue=<now>
 * Both re-check the page before writing, so one decision is handled once even if two runs overlap; runs are also
 * serialized here. A failure (unreadable page, a send that fails, a write race) is not swallowed: it goes to console.error
 * once per distinct message and stays in errors() (/alignment/health timeoutError) until that item succeeds; the item is
 * retried on the next run.
 */
export const TIMEOUT_TICK_MS = 30_000;

export function createTimeoutRunner({ readRegistry, pageData, timeoutCheck, answerTimeout, remindOverdue, send, now = Date.now, log = (line) => console.error(line) }) {
  for (const [k, f] of Object.entries({ readRegistry, pageData, timeoutCheck, answerTimeout, remindOverdue, send })) {
    if (typeof f !== "function") throw new TypeError("dsh-alignment timeouts: " + k + " must be a function");
  }
  const failures = new Map(); // "<page>" | "<page>/<id>" -> {item, message, at}
  const fail = (item, error) => {
    const message = error && error.message ? error.message : String(error);
    const prev = failures.get(item);
    failures.set(item, { item, message, at: prev?.message === message ? prev.at : new Date().toISOString() });
    if (prev?.message !== message) log("[dsh-alignment] timeouts: " + item + ": " + message);
  };
  let running = null;

  async function once() {
    const done = [];
    let reg;
    try { reg = readRegistry(); failures.delete("(registry)"); } catch (e) { fail("(registry)", e); return done; }
    for (const name of Object.keys(reg)) {
      let data;
      try { data = pageData(name); failures.delete(name); } catch (e) { fail(name, e); continue; }
      if (data.version !== 3) continue;
      const at = now();
      let due;
      try { due = timeoutCheck(data, at); } catch (e) { fail(name, e); continue; }
      for (const c of due) {
        const item = name + "/" + c.id;
        try {
          await (c.action === "auto" ? answerTimeout : remindOverdue)(name, c.id, send, at);
          failures.delete(item);
          done.push({ page: name, id: c.id, action: c.action, ...(c.why ? { why: c.why } : {}) });
        } catch (e) { fail(item, e); }
      }
    }
    for (const item of [...failures.keys()]) if (item !== "(registry)" && !(item.split("/")[0] in reg)) failures.delete(item);
    return done;
  }

  return {
    /** One pass over every page; resolves to [{page, id, action, why?}] handled in this pass. Overlapping calls share a pass. */
    run() {
      if (running === null) running = once().finally(() => { running = null; });
      return running;
    },
    /** null, or [{item, message, at}] for pages / decisions that could not be handled. */
    errors: () => (failures.size ? [...failures.values()] : null),
  };
}
