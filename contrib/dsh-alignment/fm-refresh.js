/**
 * dsh-alignment: the alignment page's First Mate controls (2026-10-23).
 *
 *   GET  /alignment/fm                    {ok, fm: {sid, title} | null, fmError?, refresh: <record> | null}
 *   POST /alignment/fm/refresh            {confirm: true}: 202 + a new "waiting" record, or 200 + the record already in progress
 *   POST /alignment/fm/refresh/cancel     {id}: a "waiting" record turns "cancelled"; any other state 409 + the record
 *   POST /alignment/fm/refresh/dismiss    {id}: a "failed" record turns "dismissed" (the page stops showing it); any other state 409 + the record
 *
 * Refresh = hand First Mate over to a fresh session: once the current one is idle, (1) create a session under the
 * First Mate directory titled "first mate" and send it the boot prompt (fm-boot-prompt.md), (2) point the page owner at
 * it (align meta <page> owner=<new>; the owner is the First Mate registration, so dsh-fm delivers there from now on), (3) move the old one's active reminders to it and check them, (4) archive the old
 * one. Any step failing stops there with its raw error; nothing is rolled back (the record says where it stopped).
 * Steps 1-3 never run twice for one record.
 *
 * Idle (busyOf): the workspace/session-activity answer without "schedule" is empty (the archive admission's own list:
 * the turn, the session's jobs, running subagents at any depth), no subagent descendant owns a running job (those are
 * not in that list and wake it when they settle), and the agent inbox has nothing queued. It must hold for QUIET_MS
 * without interruption: a subagent settling wakes its parent asynchronously (dsh-subagent notifySettlement), so there
 * is a moment where everything looks idle right before the parent gets the result. Checked again before archiving.
 *
 * Record (one at a time, storages/alignment-page/fm-refresh.json, replaced through a temp file + rename):
 *   {id, oldSid, oldTitle, page, state, step?, newSid?, moved?, error?, createdAt, updatedAt}
 *   state: waiting -> running (step create | owner | schedules) -> [archive-waiting ->] running (archive) -> done
 *          | failed (step, error) [-> dismissed] | cancelled (only from waiting)
 * "dismissed": the user read the failure and dealt with it (2026-10-26: a 02:41 failure stayed on the page for hours after
 * First Mate had finished the steps by hand; a failed record read back at startup had no other way out). It keeps step
 * and error. Neither failed nor dismissed blocks the next refresh (only ACTIVE states do).
 * "archive-waiting": steps 1-3 are done and the old First Mate woke up in between; it is archived at its next idle
 * moment instead of being cut off mid-turn. After a 3080 restart a waiting / archive-waiting record keeps waiting, a
 * running one turns failed (step 1 cannot be repeated safely).
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";

export const QUIET_MS = 5_000;
export const POLL_MS = 1_000;
export const FM_TITLE = "first mate";
export const ACTIVE = new Set(["waiting", "running", "archive-waiting"]);
/** Step names as the page shows them (template popHtml uses the same words). */
export const STEP_NAMES = { wait: "等待", create: "新建会话", owner: "改对齐页负责人", schedules: "迁移定时提醒", archive: "归档旧会话" };

/** Fail-loud host lookups: a missing service or method is a DSH shape change, never "nothing to wait for". */
function need(value, what) {
  if (typeof value !== "function") throw new Error("dsh-alignment fm refresh: " + what + " is missing (DSH API changed)");
  return value;
}

/** File-backed single record; read() -> record | null, write(record). */
export function recordStore(file) {
  return {
    file,
    read() {
      if (!existsSync(file)) return null;
      const value = JSON.parse(readFileSync(file, "utf8"));
      if (value === null || typeof value !== "object" || typeof value.state !== "string") throw new Error(file + " does not hold a refresh record");
      return value;
    },
    write(record) {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = file + "." + process.pid + ".tmp";
      writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n");
      renameSync(tmp, file);
    },
  };
}

/**
 * Why sid is busy right now: [] when idle, else [{kind, items?}] (kinds: turn | job | subagent | subagent-job | inbox).
 * host: {waterfall(name, payload, base), agents: {get, list}, jobs: {list}}.
 */
export async function busyOf(host, sid) {
  const activity = await need(host.waterfall, "ctx.waterfall").call(host, "workspace/session-activity", { sessionId: sid }, () => Promise.resolve([]));
  if (!Array.isArray(activity)) throw new Error("dsh-alignment fm refresh: workspace/session-activity gave " + typeof activity + ", not an array (DSH API changed)");
  const busy = activity.filter((a) => a?.kind !== "schedule").map((a) => ({ kind: a.kind, ...(a.items ? { items: a.items } : {}) }));
  const agents = need(host.agents?.list, "ctx.agents.list").call(host.agents);
  const children = new Map();
  for (const agent of agents) {
    const header = agent?.session?.header;
    if (header?.parentSession === undefined || header.origin !== "subagent") continue;
    if (!children.has(header.parentSession)) children.set(header.parentSession, []);
    children.get(header.parentSession).push(agent.id);
  }
  const listJobs = need(host.jobs?.list, "ctx.jobs.list");
  const jobItems = [];
  const seen = new Set([sid]);
  const pending = [...(children.get(sid) ?? [])];
  while (pending.length) {
    const id = pending.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const job of listJobs.call(host.jobs, id)) if (job.owner === id && (job.status === "running" || job.status === "stopping")) jobItems.push({ id: job.id, label: job.label, session: id });
    pending.push(...(children.get(id) ?? []));
  }
  if (jobItems.length) busy.push({ kind: "subagent-job", items: jobItems });
  const agent = need(host.agents?.get, "ctx.agents.get").call(host.agents, sid);
  if (agent !== undefined && agent !== null) {
    const inbox = agent.inbox;
    if (!Array.isArray(inbox?.nextTurn) || !Array.isArray(inbox?.nextStep)) throw new Error("dsh-alignment fm refresh: agent.inbox.nextTurn / nextStep missing (DSH agent API changed)");
    const queued = inbox.nextTurn.length + inbox.nextStep.length;
    if (queued > 0) busy.push({ kind: "inbox", items: [{ count: queued }] });
  }
  return busy;
}

/**
 * Which official Schedule service this is; anything else (unknown or mixed method sets) throws.
 * - "session" (up to 0.2.2-alpha.2): reminders bound to a session; create(sessionId, {title, prompt, <selector>}, signal),
 *   list({sessionId}) -> active records, update(...), delete({sessionId, id}) (unconditional).
 * - "task" (0.2.2-alpha.3 on): Host-wide tasks with a delivery target; create({title, prompt, timing: {kind, <selector>}, target},
 *   actorSessionId, signal), catalog() -> every task, edit({id, action: "update" | "delete", patch?, expectedUpdatedAt?}, actorSessionId, signal).
 * Same rule as plugins/dsh-schedule-remote/lib/rpc.js serviceShape() (copied, plugins do not import each other): change both together.
 */
export function scheduleShape(schedule) {
  const fn = (k) => typeof schedule?.[k] === "function";
  if (fn("edit") && fn("catalog") && fn("create") && !fn("update") && !fn("delete")) return "task";
  if (fn("update") && fn("delete") && fn("list") && fn("catalog") && fn("create") && !fn("edit")) return "session";
  const methods = schedule ? [...new Set([...Object.keys(schedule), ...(Object.getPrototypeOf(schedule) === Object.prototype ? [] : Object.getOwnPropertyNames(Object.getPrototypeOf(schedule) ?? {}))])].filter((k) => k !== "constructor" && fn(k)) : [];
  throw new Error("dsh-alignment: unknown ctx.schedule shape (methods: " + (methods.join(", ") || "none") + "); reread @deepseek-ai/dsh-schedule and realign");
}

/** Reminder record -> 0.2.2-alpha.3 timing (same rule; a one-shot keeps its absolute target, like the service's own timingOf). */
export function timingFor(record) {
  switch (record.kind) {
    case "after": case "at": return { kind: "at", at: record.scheduledAt };
    case "every": return { kind: "every", every_seconds: record.everySeconds };
    case "daily": return { kind: "daily", daily: { time: record.time, time_zone: record.timeZone } };
    case "weekly": return { kind: "weekly", weekly: { time: record.time, time_zone: record.timeZone, weekdays: [...record.weekdays] } };
    case "cron": return { kind: "cron", cron: { expression: record.expression, time_zone: record.timeZone } };
    case "rrule": return { kind: "rrule", rrule: record.rrule };
    default: throw new Error("unknown reminder kind " + JSON.stringify(record.kind));
  }
}

/** Reminder record -> create request (same timing, title, prompt). One-shot reminders keep their absolute target. */
export function createRequestFor(record) {
  const base = { title: record.title, prompt: record.prompt };
  switch (record.kind) {
    case "after": case "at": return { ...base, at: record.scheduledAt };
    case "every": return { ...base, every_seconds: record.everySeconds };
    case "daily": return { ...base, daily: { time: record.time, time_zone: record.timeZone } };
    case "weekly": return { ...base, weekly: { time: record.time, time_zone: record.timeZone, weekdays: [...record.weekdays] } };
    case "cron": return { ...base, cron: { expression: record.expression, time_zone: record.timeZone } };
    default: throw new Error("unknown reminder kind " + JSON.stringify(record.kind));
  }
}

/**
 * Same reminder after a move: kind, title, prompt, its rule and next run. "after" is created as "at" (createRequestFor keeps
 * the absolute target), so it comes back as "at"; "every" re-anchors at creation, so its interval instead of the next run.
 */
function sameReminder(a, b) {
  if (!b || (a.kind === "after" ? "at" : a.kind) !== b.kind || a.title !== b.title || a.prompt !== b.prompt) return false;
  switch (b.kind) {
    case "at": return a.scheduledAt === b.scheduledAt;
    case "every": return a.everySeconds === b.everySeconds;
    case "daily": return a.time === b.time && a.timeZone === b.timeZone && a.scheduledAt === b.scheduledAt;
    case "weekly": return a.time === b.time && a.timeZone === b.timeZone && String(a.weekdays) === String(b.weekdays) && a.scheduledAt === b.scheduledAt;
    case "cron": return a.expression === b.expression && a.timeZone === b.timeZone && a.scheduledAt === b.scheduledAt;
    case "rrule": return a.rrule === b.rrule && a.scheduledAt === b.scheduledAt;
    default: return false;
  }
}

/**
 * The two service shapes behind one interface: list(sid) -> active reminders delivered to sid, make(record) -> the copy on
 * `to`, drop(snapshot) -> removes one source reminder only if it is still the snapshot, else throws (what changed).
 */
function scheduleOps(schedule, from, to, signal) {
  if (scheduleShape(schedule) === "task") {
    const list = async (sid) => (await schedule.catalog()).filter((t) => t.status === "active" && t.target?.kind === "session" && t.target.sessionId === sid);
    return {
      list,
      // The new session acts (it is the involved one), so the service does not send it a change notice for its own copies.
      make: (record) => schedule.create({ title: record.title, prompt: record.prompt, timing: timingFor(record), target: { kind: "session", sessionId: to } }, to, signal),
      // Conditional delete: edit() runs in the service's serial queue and compares expectedUpdatedAt with the stored one, so a
      // task edited after the snapshot comes back schedule_conflict and stays as edited. The old session acts (no notice into it).
      async drop(record) {
        const r = await schedule.edit({ id: record.id, action: "delete", expectedUpdatedAt: record.updatedAt ?? null }, from, signal);
        if (r?.deleted === true) return;
        if (r?.code === "schedule_conflict") throw new Error("旧会话的提醒「" + record.title + "」（" + record.id + "）在迁移期间被改动，没删，请核对新会话上的副本");
        if (r?.code === "schedule_not_found") throw new Error("旧会话的提醒「" + record.title + "」（" + record.id + "）在迁移期间已不在");
        throw new Error("删除旧会话的提醒「" + record.title + "」（" + record.id + "）没有成功：" + JSON.stringify(r));
      },
    };
  }
  const list = (sid) => schedule.list({ sessionId: sid });
  return {
    list,
    make: (record) => schedule.create(to, createRequestFor(record), signal),
    // 0.2.2-alpha.2 records carry no revision and delete() is unconditional: re-read the source right before each delete and
    // require that snapshot unchanged (one list per reminder, so an edit made while an earlier one was being deleted is still
    // seen). The window between that list and its delete cannot be closed with this API.
    async drop(record) {
      const now = (await list(from)).find((r) => r.id === record.id);
      if (now === undefined) throw new Error("旧会话的提醒「" + record.title + "」（" + record.id + "）在迁移期间已不在");
      if (!isDeepStrictEqual(now, record)) throw new Error("旧会话的提醒「" + record.title + "」（" + record.id + "）在迁移期间被改动，没删，请核对新会话上的副本");
      const r = await schedule.delete({ sessionId: from, id: record.id }, signal);
      if (r?.deleted !== true) throw new Error("删除旧会话的提醒「" + record.title + "」（" + record.id + "）没有成功：" + JSON.stringify(r));
    },
  };
}

/**
 * Move every active reminder of from onto to: copy, check that to holds one matching reminder per source one, then delete
 * each source reminder only if it is unchanged since the copy was taken (task shape: expectedUpdatedAt; session shape: a
 * re-read just before), and require from to hold no active reminder afterwards. The source is not left to the archive:
 * archiving with stopActivity deletes every active task of the session, edited ones included (2026-11-05 review).
 * Returns [{from: id, to: id}]. Throws on any failure, naming the reminders already created on the new session.
 */
export async function moveReminders(schedule, from, to, signal) {
  const ops = scheduleOps(schedule, from, to, signal);
  const list = ({ sessionId }) => ops.list(sessionId);
  const make = ops.make;
  const source = await list({ sessionId: from });
  const before = new Set((await list({ sessionId: to })).map((r) => r.id));
  const moved = [];
  const made = () => (moved.length ? "（新会话上已建 " + moved.map((m) => m.to).join(", ") + "）" : "");
  try {
    for (const record of source) moved.push({ from: record.id, to: (await make(record)).id });
  } catch (error) {
    throw new Error("迁移提醒失败：" + (error?.message ?? String(error)) + made(), { cause: error });
  }
  const after = (await list({ sessionId: to })).filter((r) => !before.has(r.id));
  const mismatch = [];
  if (after.length !== source.length) mismatch.push("条数 " + source.length + " → " + after.length);
  for (const [i, record] of source.entries()) {
    const got = after.find((r) => r.id === moved[i].to);
    if (!sameReminder(record, got)) mismatch.push("「" + record.title + "」" + (got ? "内容或下次时间不一致" : "没建出来"));
  }
  if (mismatch.length) throw new Error("迁移后核对不一致：" + mismatch.join("；") + made());
  try {
    for (const record of source) await ops.drop(record);
  } catch (error) {
    throw new Error("迁移提醒失败：" + (error?.message ?? String(error)) + made(), { cause: error });
  }
  const left = await list({ sessionId: from });
  if (left.length) throw new Error("迁移提醒失败：迁移期间旧会话又有了提醒 " + left.map((r) => "「" + r.title + "」（" + r.id + "）").join("、") + "，没有搬" + made());
  return moved;
}

/** The boot prompt from its template file, placeholders filled; a missing file or a leftover placeholder throws. */
export function bootPrompt(templateFile, vars) {
  const text = readFileSync(templateFile, "utf8").replace(/\{\{(\w+)\}\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : m));
  const left = text.match(/\{\{\w+\}\}/);
  if (left) throw new Error(templateFile + " has an unknown placeholder " + left[0]);
  return text;
}

/**
 * The refresh runner. deps:
 *   store            recordStore(...)
 *   page             the alignment page whose owner moves
 *   currentFm()      -> {sid, title} (dsh-fm's rule); throws when there is none
 *   busy(sid)        -> [] | [{kind, items?}] (busyOf)
 *   createFm(prompt) -> new sid: created under the First Mate directory, titled, prompt sent (not as a threads envelope)
 *   waitFm(sid)      -> resolves once sid is listed, not blank, and a First Mate by origin (not yet registered)
 *   setOwner(sid)    -> align meta <page> owner=<sid>: the First Mate registration (dsh-fm/current.js); currentFm() is sid after it
 *   moveReminders(from, to) -> [{from, to}]
 *   archive(sid)     -> workspaceRegistry.archiveSession(sid, {stopActivity: true})
 *   prompt(oldSid)   -> boot prompt text
 *   now(), setTimer, clearTimer, quietMs, pollMs, log(line)
 */
export function createRefresher(deps) {
  const quietMs = deps.quietMs ?? QUIET_MS;
  const pollMs = deps.pollMs ?? POLL_MS;
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  const log = deps.log ?? (() => {});
  let record = deps.store.read();
  let quietSince = null; // start of the current idle stretch of the target
  let running = null; // the in-flight evaluation (one at a time)
  let timer = null;
  let lastBusy = null;
  let disposed = false;

  const iso = () => new Date(now()).toISOString();
  const save = (patch) => {
    const next = { ...record, ...patch, updatedAt: iso() };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    deps.store.write(next);
    record = next;
    return record;
  };
  const view = () => (record === null ? null : { ...record, ...(ACTIVE.has(record.state) && lastBusy !== null ? { busy: lastBusy } : {}) });
  const fail = (step, error) => { log("error fm refresh " + step + ": " + (error?.stack ?? error)); return save({ state: "failed", step, error: error?.message ?? String(error) }); };

  // A restart interrupted a step: say so instead of repeating it.
  if (record !== null && record.state === "running") {
    record = { ...record, state: "failed", error: "服务重启时刷新停在「" + (STEP_NAMES[record.step] ?? record.step) + "」这一步，结果需要核对", updatedAt: iso() };
    deps.store.write(record);
  }

  const waiting = () => record !== null && (record.state === "waiting" || record.state === "archive-waiting");
  function reschedule() {
    clearTimer(timer);
    timer = null;
    if (!disposed && waiting()) timer = setTimer(() => { timer = null; kick(); }, pollMs);
  }

  async function steps() {
    const old = record.oldSid;
    if (record.state === "waiting") {
      save({ state: "running", step: "create" });
      let sid;
      try { sid = await deps.createFm(deps.prompt(old)); } catch (e) { return fail("create", e); }
      save({ newSid: sid });
      try { await deps.waitFm(sid); } catch (e) { return fail("create", e); }
      save({ step: "owner" });
      try { await deps.setOwner(sid); } catch (e) { return fail("owner", e); }
      save({ step: "schedules" });
      try { save({ moved: await deps.moveReminders(old, sid) }); } catch (e) { return fail("schedules", e); }
      // The old one may have woken up meanwhile (a notice, a user message): never archive it mid-turn.
      let busy;
      try { busy = await deps.busy(old); } catch (e) { return fail("archive", e); }
      if (busy.length) { lastBusy = busy; quietSince = null; return save({ state: "archive-waiting", step: "archive" }); }
    }
    save({ state: "running", step: "archive" });
    // Reminders the old session got after the move (e.g. while archive-waiting) go too: archiving with stopActivity would
    // delete them. Between this move and the archive only a microsecond window is left (the host has no conditional archive).
    try {
      const more = await deps.moveReminders(old, record.newSid);
      if (more.length) save({ moved: [...(record.moved ?? []), ...more] });
    } catch (e) { return fail("schedules", e); }
    try { await deps.archive(old); } catch (e) { return fail("archive", e); }
    lastBusy = null;
    return save({ state: "done", step: undefined });
  }

  /** One evaluation: starts the steps once the target has been idle for quietMs; reschedules itself while waiting. */
  function kick() {
    if (running !== null) return running;
    if (disposed || !waiting()) return Promise.resolve();
    running = (async () => {
      try {
        let busy;
        try { busy = await deps.busy(record.oldSid); } catch (e) { fail(record.state === "waiting" ? "wait" : "archive", e); return; }
        if (!waiting()) return; // cancelled while busy() was answering
        lastBusy = busy;
        if (busy.length) { quietSince = null; return; }
        if (quietSince === null) { quietSince = now(); return; }
        if (now() - quietSince < quietMs) return;
        quietSince = null;
        await steps();
      } finally {
        running = null;
        reschedule();
      }
    })();
    return running;
  }

  return {
    get: view,
    /** Something happened to the target (turn/end, status change, job settled, subagent end): restart the quiet clock. */
    touch(sid) {
      if (!waiting() || record.oldSid !== sid) return;
      quietSince = null;
      kick();
    },
    kick,
    start() { if (waiting()) kick(); },
    /** POST refresh: an active record is returned as is (created: false); otherwise a new waiting record. */
    async request() {
      if (record !== null && ACTIVE.has(record.state)) return { created: false, record: view() };
      const fm = await deps.currentFm();
      if (record !== null && ACTIVE.has(record.state)) return { created: false, record: view() }; // a concurrent request won
      quietSince = null;
      lastBusy = null;
      record = { id: randomUUID(), oldSid: fm.sid, oldTitle: fm.title ?? null, page: deps.page, state: "waiting", createdAt: iso(), updatedAt: iso() };
      deps.store.write(record);
      kick();
      return { created: true, record: view() };
    },
    /** POST cancel: only a waiting record (no step started) can be cancelled. */
    cancel(id) {
      if (record === null || record.id !== id || record.state !== "waiting") return { ok: false, record: view() };
      clearTimer(timer);
      timer = null;
      quietSince = null;
      lastBusy = null;
      return { ok: true, record: save({ state: "cancelled" }) };
    },
    /** POST dismiss: only a failed record; it keeps its step and error, the page stops showing it. */
    dismiss(id) {
      if (record === null || record.id !== id || record.state !== "failed") return { ok: false, record: view() };
      return { ok: true, record: save({ state: "dismissed" }) };
    },
    dispose() { disposed = true; clearTimer(timer); timer = null; },
  };
}
