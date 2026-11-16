// The current First Mate for the alignment page's First Mate controls (fm-mount.js): which session is the
// "First Mate" (the long-running session that owns an alignment page and dispatches work to other sessions).
// Copied from the dsh-fm plugin (current.js), which uses the same rule to route turn-end notices.
// createFmResolver(host, {root, page, registered}) -> {isFmSession, fmByLog, fmByOrigin, currentFm, current, isCurrentFm,
// registeredFm, archivedIds, sessionRows, sessionRow}; host is the plugin ctx.
//
// Two questions, two rules:
//   - "was this dispatcher a First Mate" (isFmSession / fmByLog): its cwd is under root and it was not started by
//     another session under root (the origin rule below).
//   - "which session is THE First Mate now" (current / registeredFm): the REGISTERED session only = the owner of the
//     First Mate alignment page (align meta <page> owner=<sid>). The refresh's "owner" step is the registration.
//     Not registered, the registered session missing, archived, or outside root -> throws; never guesses by cwd
//     (a blank session opened later in the same directory must not become "current").
import { isInside, originDispatcher } from "./origin.js";
import { sessionInspector } from "../session-inspect.mjs";

export const FM_PAGE = "first-mate";

/** registered() -> sid | undefined (sync or async), read on every call: the owner of alignment page `page`. */
export function createFmResolver(host, { root, page = FM_PAGE, registered } = {}) {
  if (typeof root !== "string" || root.length === 0) throw new Error("createFmResolver needs root (the First Mate working directory, plugin config firstMate.root)");
  if (typeof registered !== "function") throw new Error("createFmResolver needs registered() (the owner of the First Mate alignment page)");
  const ctx = host;
  // 0.2.2 dropped sessionController.inspect: ./session-inspect.mjs (copy of ~/.dsh/lib/session-inspect.mjs) reads through sessionQuery.observeSession there
  const inspect = sessionInspector(() => ({ sessionController: ctx.sessionController, sessionQuery: typeof ctx.get === "function" ? ctx.get("sessionQuery") : ctx.sessionQuery }));
  const controller = { inspect: (sid) => inspect(sid), list: (q) => ctx.sessionController.list(q) };
  // sid -> Promise<{cwd, origin}>: one inspect per session (cwd and first message never change). Only the two
  // facts are kept: First Mate logs run to 15k+ events.
  const inspected = new Map();
  // sid -> Promise<boolean>.
  const fmCache = new Map();

  function inspectOnce(sid) {
    if (!inspected.has(sid)) {
      const pending = controller.inspect(sid).then((inspection) => {
        if (!Array.isArray(inspection?.events)) throw new Error("sessionController.inspect returned no events; dsh session controller API changed");
        return { cwd: inspection.meta?.cwd ?? null, origin: originDispatcher(inspection.events) };
      });
      pending.catch(() => inspected.delete(sid));
      inspected.set(sid, pending);
    }
    return inspected.get(sid);
  }

  // Was a First Mate = under root, and not started by another session under root (a worker that First Mate opened in
  // its own directory is not First Mate). A session that a session outside root started still counts. A dispatcher
  // that cannot be inspected throws.
  async function fmByOrigin(cwd, origin) {
    if (!isInside(root, cwd)) return false;
    if (origin === null) return true;
    return !isInside(root, (await inspectOnce(origin)).cwd);
  }

  function fmByLog(cwd, events) {
    return fmByOrigin(cwd, originDispatcher(events));
  }

  function isFmSession(sid) {
    if (!fmCache.has(sid)) {
      const pending = inspectOnce(sid).then(({ cwd, origin }) => fmByOrigin(cwd, origin));
      pending.catch(() => fmCache.delete(sid));
      fmCache.set(sid, pending);
    }
    return fmCache.get(sid);
  }

  // The live archive set. Required: without it an archived First Mate cannot be told apart.
  function archivedIds() {
    const ids = ctx.workspaceRegistry.archivedSessionIds;
    if (!Array.isArray(ids)) throw new Error("workspaceRegistry.archivedSessionIds is missing; dsh workspace registry API changed");
    return new Set(ids);
  }

  async function sessionRows() {
    const listing = await controller.list({});
    const rows = Array.isArray(listing) ? listing : listing?.items;
    if (!Array.isArray(rows)) throw new Error("sessionController.list returned no rows; dsh session controller API changed");
    return rows;
  }

  // One session by id -> {sessionId, cwd, title} | undefined (does not exist). The alignment page asks GET /alignment/fm
  // on a timer; sessionController.list({}) builds every row (about 1 s on 3080; 2026-10-24 the stalled requests filled
  // the remote HTTP/2 connection), so current() / registeredFm() read only the registered session (live: in-memory
  // projections; cold: one log read, which sessionQuery caches per revision).
  async function sessionRow(sid) {
    const query = typeof ctx.get === "function" ? ctx.get("sessionQuery") : ctx.sessionQuery;
    if (typeof query?.observeSession !== "function") throw new Error("sessionQuery.observeSession is missing; dsh session query API changed");
    let observation;
    try {
      observation = await query.observeSession(sid);
    } catch (error) {
      if (error?.code === "SESSION_QUERY_SESSION_NOT_FOUND") return undefined;
      throw error;
    }
    try {
      if (observation?.header === undefined) throw new Error("sessionQuery.observeSession returned no header; dsh session query API changed");
      // No cwd = not a listed session (sessionController.inspect / list treat it as not found the same way).
      if (observation.header.cwd === undefined) return undefined;
      return { sessionId: sid, cwd: observation.header.cwd, title: observation.projections?.values?.title ?? null };
    } finally {
      observation?.[Symbol.dispose]?.();
    }
  }

  async function registeredSid() {
    try {
      return await registered();
    } catch (error) {
      throw new Error("no current First Mate: reading the registration (alignment page " + page + " owner) failed: " + (error?.message ?? String(error)), { cause: error });
    }
  }

  // The checks once the registration is read; row = that session's row, undefined when it does not exist.
  function checkCurrent(sid, row, archived, workerSid) {
    const fix = " (refresh First Mate on the alignment page, or align meta " + page + " owner=<sid>)";
    if (typeof sid !== "string" || sid.length === 0) throw new Error("no current First Mate: none registered" + fix);
    if (archived.has(sid)) throw new Error("no current First Mate: the registered " + sid + " is archived" + fix);
    if (row === undefined) throw new Error("no current First Mate: the registered " + sid + " does not exist" + fix);
    if (!isInside(root, row.cwd)) throw new Error("no current First Mate: the registered " + sid + " runs in " + row.cwd + ", not under " + root + fix);
    if (sid === workerSid) throw new Error("no current First Mate: the registered " + sid + " is the reporting session itself" + fix);
    return sid;
  }

  // The current First Mate: the registered session. Registration unreadable or empty, the session not listed,
  // archived, outside root, or the reporting session itself -> throws; never falls back to some other session.
  async function currentFm(workerSid, rows, archived) {
    const sid = await registeredSid();
    return checkCurrent(sid, rows.find((r) => r.sessionId === sid), archived, workerSid);
  }

  // The current First Mate as of now (the registered session + archive set); same rule dsh-fm reroutes by.
  async function current() {
    const sid = await registeredSid();
    const archived = archivedIds();
    const row = typeof sid === "string" && sid.length > 0 && !archived.has(sid) ? await sessionRow(sid) : undefined;
    checkCurrent(sid, row, archived, null);
    return { sid, title: row.title };
  }

  /**
   * The registration as it stands, archived or not: {sid, title, archived}. Throws when nothing is registered or the
   * session does not exist. For the refresh only: an archived registered First Mate is what the refresh replaces.
   */
  async function registeredFm() {
    const sid = await registered();
    if (typeof sid !== "string" || sid.length === 0) throw new Error("no First Mate registered (align meta " + page + " owner=<sid>)");
    const row = await sessionRow(sid);
    if (row === undefined) throw new Error("the registered First Mate " + sid + " does not exist");
    return { sid, title: row.title, archived: archivedIds().has(sid) };
  }

  /** sid is the current (registered, unarchived) First Mate; throws when there is none. */
  async function isCurrentFm(sid) {
    return (await current()).sid === sid;
  }

  return { root, page, isFmSession, fmByLog, fmByOrigin, currentFm, current, isCurrentFm, registeredFm, archivedIds, sessionRows, sessionRow };
}
