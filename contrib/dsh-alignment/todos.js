// GET /alignment/todos?sids=<sid>,<sid>… — the latest todolist of each session, for the alignment page's in-progress
// rounds (contract agreed with the alignment-page template, 2026-10-22):
//   200 {ok, api: 4, sessions: {<sid>: Todo | null | {error}}, activity: {<sid>: [[startMs, endMs | null], …] | {error}},
//        background: {<sid>: {subagent: [[startMs, endMs | null], …], job: [[startMs, endMs], …]} | {error}},
//        notodo: {<sid>: NoTodo | {error}}, ended: {<sid>: {at, kind} | null | {error}}}
//   ended (api 5, 2026-11-02): how the session's last turn ended (lastTurn below), so the page can tell a session that
//   finished its turn normally (the round waits for First Mate to register the result) from one that stopped on an error,
//   a user stop or a restart; null while a turn runs or before any turn ended.
//   null = never wrote a todolist. activity (api 2, 2026-10-23 v8 page): the session's turns (turn/start → turn/end), so the
//   page counts a round's 已用 as the time the session actually ran - blocked / idle stretches don't count; endMs null =
//   the turn is still running. Gaps under ACTIVITY_MERGE_MS are merged.
//   background (api 3, 2026-10-24): while the session's own turn is over, its subagents (any depth) or its own jobs may
//   still run; that is work time too. The page's 已用 = activity ∪ subagent ∪ job (overlap once), the job part minus the
//   stretches the session waited for the user's decision (page decisions opened → answered; ask_user_question is already
//   taken out here). Only jobs that ended by themselves count (First Mate 2026-10-24): an always-on job (a preview
//   server: killed, cut by a restart, or still running) only counts while the main turn or a subagent runs, which those
//   already cover, so it adds nothing. Built from the session logs (see background() below), so a 3080 restart rescans
//   to the same history; whether an unclosed subagent turn still runs comes from the host's workspace/session-activity.
//   Each list sorted, disjoint; endMs null = still running.
//   Todo = {rev, updatedAt, turn, latestTurn, running, done, total,
//           items: [{text, status, eta: {p50, p75} | null, startedAt, completedAt, elapsedMs, spans, approx, agent}]}
//   (2026-10-22: timing fields; 2026-10-24: spans = the item's in_progress stretches [[startMs, endMs | null], …],
//   elapsedMs = the part of them inside the session's turns, approx = a stretch was inferred, texts matched across
//   small edits — see nextTiming below)
// eta comes from the "[ETA <median>/<P75>]" content suffix (~/.dsh/lib/todo-eta.mjs); text has it stripped. An item
// written without the suffix keeps the ETA of the item it continues from the previous list (merged items add up, split
// items share it; 2026-10-24, see carryEta in lib/todo-match.mjs).
// notodo (api 4, 2026-10-26): only for a sid whose sessions entry is null (it never wrote a todolist). NoTodo = {by, text,
//   why, steps}; steps = tool steps (step/start … a tool/call … step/end: dsh-todo-reminder's toolSteps) since the latest
//   task message (user/message, source.kind "user"; from the start when there is none). by "session": after that message
//   the session wrote 「不列待办：<reason>」 in an assistant text block (reasoning is not read); text = the last non-empty
//   reason, trimmed, one trailing 。．. dropped, past 80 characters cut to 79 + "…"; why null. Else by "inferred", text
//   null, why "starting" (the session runs, steps < 3) / "no-tools" (idle, steps 0) / "few-steps" (idle, steps 1–2);
//   anything else by "none" (text and why null).
// item.agent (api 4): null | {by: "session" | "inferred", runs: [{id, kind: "subagent" | "job", name, state, since, mode, gone}]}
//   (mode = the subagent's catalog mode, continuable / one-shot / …, null for a job; gone = the subagent's session no
//   longer exists - deleted from disk - so the page cannot open it; its state is then "stopped". 2026-10-26)
//   (runs by since). by "session" = the item's content starts with 🤖 (the mark stays in text); by "inferred" = no 🤖
//   but runs hang on it. A run is a subagent from the session's own subagent/catalog (not external; id = childId, name =
//   the trimmed label or null, since = the event's time) or a background job: a job/registered with toolCall.callId whose
//   tool result (tool/result toolCallId or tool/ptc-dispatch subCallId) arrived before its job/settled (a foreground
//   call returns after; id = jobId, name = the trimmed label or null, since = startedAt). Where a run hangs is decided in
//   fold, so a rescan after a restart gives the same: when it appears it remembers the items then in progress (S, kept
//   with the items across rewrites); the next todo/write settles it on the first non-empty of: the items that write
//   starts (were not in_progress before, or are new) marked 🤖, S marked 🤖, S, the items that write starts - several:
//   the most similar to the run's name (similarity >= MATCH_MIN, ties: the earlier item), else the one with the fewest
//   runs (ties: the earlier); none = it hangs nowhere. Until that write it shows on S (🤖 ones first, same choice)
//   without being stored; a new task message drops the waiting runs. Settled runs follow their item across rewrites
//   (the matchTexts pairing, like spans). state, per view (the host's running sets asked at most once, only when needed):
//   subagent - from its own log: last turn closed: reason completed -> "done", error / max-tokens -> "failed", else
//   "stopped"; last turn open or no turn yet: "running" if the host lists it (ids compared without "session-"), else
//   "stopped" (cut by a restart). job - settled: status completed -> "done", failed -> "failed", else "stopped"; not
//   settled: "running" if the host lists it, else "stopped". rev covers agent (state included).
// Empty and duplicate sids are ignored (the page collects one sid per round). The page polls this together with /data
// every 4 s, so reads are served from memory: a session is scanned once (sessionController.inspect: live snapshot or
// the persisted log, no agent activation), then kept current by every session/event (turn/start,
// todo/write). Events that arrive during the first scan are merged by seq, so none is lost.
import { createHash } from "node:crypto";
import { splitTodo } from "./lib/todo-eta.mjs";
import { carryEta, MATCH_MIN, matchTexts, normText, similarity } from "./lib/todo-match.mjs";
import { jobName } from "./job-title.js";

// the text pairing lives in lib/todo-match.mjs (shared with dsh-todo-reminder); re-exported for callers and tests
export { MATCH_MIN, matchTexts, normText, similarity } from "./lib/todo-match.mjs";

export const TODOS_API = 5;
export const ACTIVITY_MERGE_MS = 5000;
export const MAX_SIDS = 20;

export class TodosRequestError extends Error {}

/** "a, b,,a" -> ["a", "b"]; more than MAX_SIDS distinct ids throws TodosRequestError. */
export function parseSids(param) {
  const sids = [...new Set(String(param ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
  if (sids.length > MAX_SIDS) throw new TodosRequestError("一次最多 " + MAX_SIDS + " 个会话");
  return sids;
}

const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());

// Every own event is folded: its time is the latest moment the session's current incarnation (the stretch between two
// session/end-seed events, i.e. one load of the session in one 3080 process) is known to have been alive.
function fold(state, event) {
  if (typeof event.seq !== "number") throw new Error("dsh-alignment todos: session event without numeric seq — session event shape changed");
  if (event.seq <= state.lastSeq) return;
  // (a session/end-seed starts the next incarnation: its time is the reload, after any downtime)
  if (typeof event.time === "number" && event.time > state.incLast[state.inc] && event.type !== "session/end-seed") state.incLast[state.inc] = event.time;
  // tool steps for notodo: a step that made at least one tool call (dsh-todo-reminder's toolSteps)
  if (event.type === "step/start") state.stepTool = false;
  else if (event.type === "tool/call") state.stepTool = true;
  else if (event.type === "step/end" && state.stepTool) { state.steps += 1; state.stepTool = false; }
  if (event.type === "job/registered" || event.type === "job/settled") {
    const d = event.data;
    if (typeof d?.jobId !== "string" || typeof d.startedAt !== "number" || (event.type === "job/settled" && typeof d.finishedAt !== "number")) {
      throw new Error("dsh-alignment todos: " + event.type + " without jobId / startedAt / finishedAt — session event shape changed");
    }
    if (event.type === "job/settled" && typeof d.cause !== "string") throw new Error("dsh-alignment todos: job/settled without cause — session event shape changed");
    if (event.type === "job/settled" && typeof d.status !== "string") throw new Error("dsh-alignment todos: job/settled without status — session event shape changed");
    const job = state.jobs.get(d.jobId) ?? { start: d.startedAt, end: null, self: false, status: null, label: null, call: null, kind: null, desc: null };
    if (event.type === "job/settled") {
      // cause "producer" = the job's process ended by itself (done or failed); "kill" / "teardown" = stopped from outside
      job.end = Math.max(job.start, d.finishedAt); job.self = d.cause === "producer"; job.status = d.status;
      if (job.call !== null) state.jobCalls.delete(job.call); // its call returns after this: a foreground job
    } else {
      job.label = d.label ?? null;
      job.kind = typeof d.kind === "string" ? d.kind : null;
      // the description of the call that started it (pwsh / bash / workflow; its label is the raw command or meta.name)
      if (typeof d.toolCall?.callId === "string") { job.desc = state.callDesc.get(d.toolCall.callId) ?? null; state.callDesc.delete(d.toolCall.callId); }
      // every pwsh call registers a job; it is a background one when the call's result arrives before the job settles
      if (typeof d.toolCall?.callId === "string" && job.end === null) { job.call = d.toolCall.callId; state.jobCalls.set(job.call, d.jobId); }
    }
    state.jobs.set(d.jobId, job);
  } else if (event.type === "subagent/catalog") {
    if (typeof event.data?.childId !== "string" || typeof event.time !== "number") throw new Error("dsh-alignment todos: subagent/catalog without childId / time — session event shape changed");
    // an external execution has no local session (no log to read, never in session-activity)
    if (event.data.mode !== "external" && !state.children.includes(event.data.childId)) {
      state.children.push(event.data.childId);
      appear(state, { id: event.data.childId, kind: "subagent", name: nameOf(event.data.label), since: event.time, mode: typeof event.data.mode === "string" ? event.data.mode : null });
    }
  } else if (event.type === "session/end-seed") {
    if (typeof event.time !== "number") throw new Error("dsh-alignment todos: session/end-seed without numeric time — session event shape changed");
    state.inc += 1;
    state.incLast[state.inc] = event.time;
  } else if ((event.type === "tool/call" || event.type === "tool/ptc-dispatch-start") && DESC_TOOLS.has(event.data?.name)) {
    const id = event.data.subCallId ?? event.data.callId;
    if (typeof id !== "string") throw new Error("dsh-alignment todos: " + event.type + " " + event.data.name + " without callId — session event shape changed");
    const desc = descOf(event.data.name, event.data.arguments);
    if (desc !== null) state.callDesc.set(id, desc);
  } else if ((event.type === "tool/call" || event.type === "tool/ptc-dispatch-start") && ASK_TOOLS.has(event.data?.name)) {
    // waiting inside ask_user_question is waiting for the user, not work (same rule as task-eta's active time)
    const id = event.data.subCallId ?? event.data.callId;
    if (typeof id !== "string" || typeof event.time !== "number") throw new Error("dsh-alignment todos: " + event.type + " " + event.data.name + " without callId / time — session event shape changed");
    state.asks.push([event.time, null]);
    state.askOpen.set(id, state.asks.length - 1);
  } else if (event.type === "tool/result" || event.type === "tool/ptc-dispatch") {
    const id = event.type === "tool/ptc-dispatch" ? event.data?.subCallId : event.data?.message?.toolCallId;
    state.callDesc.delete(id);
    const k = state.askOpen.get(id);
    if (k !== undefined) {
      if (typeof event.time !== "number") throw new Error("dsh-alignment todos: " + event.type + " without numeric time — session event shape changed");
      state.asks[k][1] = Math.max(state.asks[k][0], event.time);
      state.askOpen.delete(id);
    }
    const jobId = state.jobCalls.get(id);
    if (jobId !== undefined) {
      state.jobCalls.delete(id);
      const job = state.jobs.get(jobId);
      appear(state, { id: jobId, kind: "job", name: jobName(job.kind, job.label, job.desc).name, since: job.start, mode: null });
    }
  } else if (event.type === "turn/start" || event.type === "turn/end") {
    if (typeof event.time !== "number") throw new Error("dsh-alignment todos: " + event.type + " without numeric time — session event shape changed");
    if (event.type === "turn/end" && typeof event.data?.reason?.kind !== "string") throw new Error("dsh-alignment todos: turn/end without reason.kind — session event shape changed");
    const last = state.turns[state.turns.length - 1];
    if (event.type === "turn/start") {
      if (typeof event.data?.turn !== "number") throw new Error("dsh-alignment todos: turn/start without numeric turn — session event shape changed");
      state.latestTurn = Math.max(state.latestTurn, event.data.turn);
      state.lastEnd = null;
      state.lastEndAt = null;
      if (last && last[1] === null) last[1] = event.time; // a start without the previous end: close it here
      const prev = state.turns[state.turns.length - 1];
      if (prev && event.time - prev[1] < ACTIVITY_MERGE_MS) prev[1] = null; else state.turns.push([event.time, null]);
    } else {
      if (last && last[1] === null) last[1] = Math.max(last[0], event.time);
      state.lastEnd = event.data.reason.kind;
      state.lastEndAt = event.time;
    }
  } else if (event.type === "todo/write") {
    if (!Array.isArray(event.data?.todos) || typeof event.time !== "number") throw new Error("dsh-alignment todos: todo/write without todos[] / time — session event shape changed");
    const prevTime = state.todo === null ? null : state.todo.time;
    const before = new Map(state.items.map((r) => [r.key, r.status]));
    state.todo = { time: event.time, turn: state.latestTurn, todos: event.data.todos };
    state.items = nextTiming(state.items, event.data.todos, event.time, prevTime);
    if (state.waiting.length > 0) {
      // the runs that appeared since the previous write hang on: the items this write starts marked 🤖, else the 🤖
      // ones in progress when the run appeared, else those, else the items this write starts; else nowhere
      const started = state.items.filter((r) => r.status === "in_progress" && before.get(r.key) !== "in_progress");
      for (const { run, snap } of state.waiting) {
        const then = state.items.filter((r) => snap.has(r.key));
        const cands = [started.filter(isBot), then.filter(isBot), then, started].find((c) => c.length > 0);
        if (cands !== undefined) pickItem(cands, run, (r) => r.runs.length).runs.push(run);
      }
      state.waiting = [];
    }
  } else if (event.type === "user/message") {
    // a task message (threads' delegation envelope too) starts over: the steps, the 不列待办 reason, the waiting runs
    if (event.data?.source?.kind === "user") { state.taskSteps = state.steps; state.reason = null; state.waiting = []; }
  } else if (event.type === "assistant/message") {
    const content = event.data?.message?.content;
    if (!Array.isArray(content)) throw new Error("dsh-alignment todos: assistant/message without message.content[] — session event shape changed");
    for (const block of content) {
      if (block?.type !== "text" || typeof block.text !== "string") continue;
      for (const m of block.text.matchAll(NO_TODO_RE)) { const reason = reasonOf(m[1]); if (reason !== null) state.reason = reason; }
    }
  }
  state.lastSeq = event.seq;
}

// jobs: jobId -> {start, end | null, self (ended by itself), status, label, call, kind, desc}; jobCalls: tool call id -> jobId of an
// unsettled job; children: subagent session ids in catalog order; inc / incLast: see fold; asks: [start, end | null] of
// ask_user_question calls (askOpen: call id -> index of the one still waiting); steps / stepTool / taskSteps / reason:
// notodo; lastEnd / lastEndAt: the last turn's reason.kind and turn/end time (null while a turn runs or before the first); waiting: runs not yet hung
// on an item, each {run, snap: keys of the items in progress when it appeared}
const freshState = () => ({
  todo: null, latestTurn: 0, items: [], turns: [], lastSeq: -1, jobs: new Map(), jobCalls: new Map(), children: [], inc: 0, incLast: [-Infinity], asks: [], askOpen: new Map(),
  steps: 0, stepTool: false, taskSteps: 0, reason: null, lastEnd: null, lastEndAt: null, waiting: [], callDesc: new Map(),
});
const ASK_TOOLS = new Set(["ask_user_question"]);
// calls that start jobs whose label is not a name (pwsh / bash: the raw command; workflow: meta.name); callDesc: call id ->
// its description, kept until the job registers or the call returns
const DESC_TOOLS = new Set(["pwsh", "bash", "workflow"]);
function descOf(tool, raw) {
  let a = raw;
  if (typeof raw === "string") { try { a = JSON.parse(raw); } catch { return null; } } // arguments the model wrote as broken JSON: no description
  const v = tool === "workflow" ? a?.meta?.description : a?.description;
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

// ---- notodo and item.agent (api 4, 2026-10-26; contract at the top) ----
const NO_TODO_RE = /不列待办\s*[:：]\s*([^\n]+)/g;
const REASON_MAX = 80;
/** The reason captured after 「不列待办：」: trimmed, one trailing full stop dropped, cut past REASON_MAX; null when empty. */
function reasonOf(raw) {
  const text = raw.trim().replace(/[。．.]$/u, "").trim();
  if (text === "") return null;
  const chars = [...text];
  return chars.length > REASON_MAX ? chars.slice(0, REASON_MAX - 1).join("") + "…" : text;
}
const BOT_RE = /^\s*🤖/u;
const isBot = (r) => BOT_RE.test(r.text);
const nameOf = (label) => (typeof label === "string" && label.trim() !== "" ? label.trim() : null);
const bareId = (id) => String(id).replace(/^session-/, "");
/**
 * sessionController.inspect's answer for a session that no longer exists (dsh-api-session-controller ApiSessionNotFound:
 * 'session "<id>" not found'; the class is not exported). A subagent session deleted from disk is not a shape change:
 * its run says gone instead of failing the parent's whole todolist (2026-10-26, the page's jump to a subagent session).
 */
const GONE_RE = /^session ".+" not found$/;
export const isSessionGone = (error) => error instanceof Error && GONE_RE.test(error.message);
/** A run appears: it waits for the next todo/write, remembering the items in progress now. */
function appear(state, run) {
  state.waiting.push({ run, snap: new Set(state.items.filter((r) => r.status === "in_progress").map((r) => r.key)) });
}
/** One of several candidate items for run: the most similar to its name (>= MATCH_MIN), else the fewest runs; ties: the earlier. */
function pickItem(cands, run, count) {
  if (cands.length === 1) return cands[0];
  const name = run.name === null ? "" : normText(run.name);
  if (name !== "") {
    let best = null, top = -1;
    for (const r of cands) { const sc = similarity(name, normText(r.text)); if (sc >= MATCH_MIN && sc > top) { best = r; top = sc; } }
    if (best !== null) return best;
  }
  return cands.reduce((a, r) => (count(r) < count(a) ? r : a));
}
/** Where the waiting runs show until the next write settles them: item key -> runs (on the items in progress when each appeared). */
function provisional(st) {
  const extra = new Map();
  const count = (r) => r.runs.length + (extra.get(r.key)?.length ?? 0);
  for (const { run, snap } of st.waiting) {
    const then = st.items.filter((r) => snap.has(r.key));
    const cands = [then.filter(isBot), then].find((c) => c.length > 0);
    if (cands === undefined) continue;
    const r = pickItem(cands, run, count);
    extra.set(r.key, [...(extra.get(r.key) ?? []), run]);
  }
  return extra;
}

/** A session's working time: its turns ([start, end | null], merged) minus the stretches spent in ask_user_question. */
const working = (st, turns = st.turns) => (st.asks.length ? minusSpans(turns, mergeSpans(st.asks)) : turns.map(([a, b]) => [a, b]));

// ---- per-item timing (2026-10-24) ----
// An item's actual time is the sum of its in_progress spans, counted only while the session was in a turn (the same
// rule as a round's 已用). Spans come from comparing consecutive todo_write lists; the persisted session log is the
// store, so a restart rescans to the same result. An item that goes from pending straight to completed gets the
// stretch since the previous write (split evenly when several do so in one write) and approx: true. The first write
// has no previous one: an item already completed there has no time.

// key: the item's identity across rewrites (S of a waiting run); runs: the runs hung on it (api 4)
let keySeq = 0;
const blank = () => ({ key: ++keySeq, text: null, eta: null, status: "pending", spans: [], startedAt: null, completedAt: null, approx: false, runs: [] });

/**
 * The timing records for the list written at time (aligned with todos), carried over from the previous records.
 * record.eta = the item's "[ETA ..]" suffix, or when the rewrite dropped it the previous list's ETA for the same item
 * (carryEta: continued items keep theirs, merged items add up, split items share; an own suffix always wins).
 */
export function nextTiming(prevItems, todos, time, prevTime) {
  const parts = todos.map((t) => splitTodo(t.content));
  const map = matchTexts(prevItems.map((r) => r.text), parts.map((p) => p.text));
  const etas = carryEta(prevItems, parts, map);
  const jumped = [];
  const items = todos.map((t, j) => {
    const old = map[j] === -1 ? null : prevItems[map[j]];
    const r = old ? { ...old, spans: old.spans.map(([a, b]) => [a, b]), runs: old.runs.slice() } : blank();
    r.text = parts[j].text;
    r.eta = etas[j].eta;
    const open = r.spans.length > 0 && r.spans[r.spans.length - 1][1] === null;
    if (t.status === "in_progress") {
      if (!open) r.spans.push([time, null]);
      r.startedAt ??= time;
      r.completedAt = null;
    } else if (t.status === "completed") {
      if (open) r.spans[r.spans.length - 1][1] = time;
      else if (r.status !== "completed" && old !== null && prevTime !== null) jumped.push(r);
      if (r.status !== "completed" || r.completedAt === null) r.completedAt = time;
    } else {
      if (open) r.spans[r.spans.length - 1][1] = time;
      r.completedAt = null;
    }
    r.status = t.status;
    return r;
  });
  const step = jumped.length ? (time - prevTime) / jumped.length : 0;
  jumped.forEach((r, k) => {
    const a = Math.round(prevTime + k * step), b = Math.round(prevTime + (k + 1) * step);
    r.spans.push([a, b]);
    r.startedAt ??= a;
    r.approx = true;
  });
  return items;
}

/** [start, end | null] intervals as a sorted, disjoint list (overlapping or touching ones merged; null = still running). */
export function mergeSpans(spans) {
  const out = [];
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last === undefined || (last[1] !== null && a > last[1])) out.push([a, b]);
    else if (last[1] !== null && (b === null || b > last[1])) last[1] = b;
  }
  return out;
}

/** spans minus holes (both sorted and disjoint, [start, end | null]; null = open, runs to now). */
export function minusSpans(spans, holes) {
  const out = [];
  for (const [a, b] of spans) {
    let cur = a, rest = true;
    for (const [x, y] of holes) {
      if (y !== null && y <= cur) continue;
      if (b !== null && x >= b) break;
      if (x > cur) out.push([cur, x]);
      if (y === null || (b !== null && y >= b)) { rest = false; break; }
      cur = Math.max(cur, y);
    }
    if (rest && (b === null || b > cur)) out.push([cur, b]);
  }
  return out;
}

/** Milliseconds of spans ([start, end | null]) that fall inside turns ([start, end | null], disjoint); open ends are now. */
export function activeIn(spans, turns, now) {
  let sum = 0;
  for (const [a, b] of spans) for (const [x, y] of turns) {
    const lo = Math.max(a, x), hi = Math.min(b ?? now, y ?? now);
    if (hi > lo) sum += hi - lo;
  }
  return sum;
}

/**
 * In-memory index. readSessionState(sid) -> {events, inheritedEventCount}; isRunning(sid) -> boolean; now() -> ms;
 * running(sid) -> {subagent: Set<sid>, job: Set<jobId>} = what the host says runs right now (workspace/session-activity,
 * lib/session-background.mjs runningOf), asked only while the logs leave a subagent turn or a job unclosed.
 * observe(sid, event) is fed from session/event; view(sid, background) resolves to Todo | null.
 * Item fields: {text, status, eta, startedAt, completedAt, elapsedMs, spans, approx} (ISO / ms or null; elapsedMs =
 * activeIn(spans, turns ∪ background, now), null for an item that never ran). rev leaves elapsedMs out, so a running
 * item does not change rev on every poll; the page ticks a running item itself from spans + activity + background.
 */
export function createTodoIndex({ readSessionState, isRunning, running, now = Date.now }) {
  if (typeof running !== "function") throw new TypeError("dsh-alignment todos: createTodoIndex needs running(sid) (workspace/session-activity)");
  // Only sessions the page asked for are tracked. Events that arrive while the first scan awaits are buffered and
  // replayed after it (seq-ordered, duplicates dropped). A shape error from the host's session/event path (which only
  // logs listener errors) is kept on the entry and reported for that sid.
  const live = new Map();
  async function ensure(sid) {
    let s = live.get(sid);
    if (s === undefined) { s = { state: null, pending: [], error: null, scan: null, gone: null }; live.set(sid, s); }
    if (s.error !== null) throw s.error;
    if (s.gone !== null) throw s.gone; // deleted sessions do not come back: no re-read on every poll
    if (s.state === null) {
      s.scan ??= (async () => {
        let snapshot;
        try { snapshot = await readSessionState(sid); } catch (error) { if (isSessionGone(error)) s.gone = error; throw error; }
        if (!Array.isArray(snapshot?.events) || typeof snapshot.inheritedEventCount !== "number") {
          throw new Error("dsh-alignment todos: sessionController.inspect returned no events[] / inheritedEventCount — session controller changed shape");
        }
        const state = freshState();
        // a fork starts with its parent's events; its todolist, jobs and subagents are its own
        for (const event of snapshot.events) if (event.seq >= snapshot.inheritedEventCount) fold(state, event);
        for (const event of s.pending.sort((x, y) => x.seq - y.seq)) fold(state, event);
        s.pending = [];
        s.state = state;
      })().finally(() => { s.scan = null; });
      await s.scan;
      if (s.error !== null) throw s.error;
    }
    return s.state;
  }
  /**
   * run -> "running" | "done" | "failed" | "stopped" for the runs shown on sid's items. A subagent's state comes from its
   * own log (its last turn's reason), a job's from its job/settled; only an unclosed one needs the host's running sets,
   * asked at most once here.
   */
  async function runStates(sid, st, runs, gone) {
    const out = new Map(), open = [];
    for (const run of runs) {
      if (run.kind === "subagent") {
        let cs;
        try { cs = await ensure(run.id); } catch (error) { if (!isSessionGone(error)) throw error; gone.add(run); out.set(run, "stopped"); continue; }
        // lastEnd: the last turn's reason.kind; null = no turn yet or the last one has no turn/end (running, or cut by a restart)
        if (cs.lastEnd !== null) out.set(run, cs.lastEnd === "completed" ? "done" : cs.lastEnd === "error" || cs.lastEnd === "max-tokens" ? "failed" : "stopped");
        else open.push(run);
      } else {
        const job = st.jobs.get(run.id);
        if (job.end !== null) out.set(run, job.status === "completed" ? "done" : job.status === "failed" ? "failed" : "stopped");
        else open.push(run);
      }
    }
    if (open.length > 0) {
      const now = await running(sid);
      if (!(now?.subagent instanceof Set) || !(now.job instanceof Set)) throw new Error("dsh-alignment todos: running(" + sid + ") gave no {subagent, job} sets");
      const kids = new Set([...now.subagent].map(bareId));
      for (const run of open) out.set(run, (run.kind === "subagent" ? kids.has(bareId(run.id)) : now.job.has(run.id)) ? "running" : "stopped");
    }
    return out;
  }
  return {
    /**
     * Whether sid's session still exists, asked by the page right before it opens a subagent's session (2026-10-26): a
     * deleted one opens to an empty main area with only 'subagent is unavailable'. Reads the log once more (the cached
     * state may predate the deletion); not found -> false and the session is remembered as gone, so the next poll shows
     * its run as gone. Other errors throw.
     */
    async exists(sid) {
      try { await readSessionState(sid); return true; } catch (error) {
        if (!isSessionGone(error)) throw error;
        const s = live.get(sid);
        if (s === undefined) live.set(sid, { state: null, pending: [], error: null, scan: null, gone: error });
        else { s.gone = error; s.state = null; }
        return false;
      }
    },
    /**
     * How the session's last turn ended (api 5, 2026-11-02): {at: turn/end time (ms), kind: its reason.kind}, or null while a
     * turn runs, before the first turn, or when the last one has no turn/end yet (cut by a restart, not closed so far).
     */
    async lastTurn(sid) {
      const st = await ensure(sid);
      return st.lastEnd === null ? null : { at: st.lastEndAt, kind: st.lastEnd };
    },
    /** The session's turns as [[startMs, endMs | null], …] (copies), minus the time spent waiting in ask_user_question. */
    async activity(sid) {
      return working(await ensure(sid));
    },
    /** {kind, desc} of job jobId from sid's log (desc = the description of the call that started it, or null); null when the log has no such job. */
    async jobInfo(sid, jobId) {
      const job = (await ensure(sid)).jobs.get(jobId);
      return job === undefined ? null : { kind: job.kind, desc: job.desc };
    },
    /**
     * {subagent, job}: when the session's subagents (any depth: their own turns minus their ask_user_question waits, from
     * their logs) ran, and when its own jobs that ended by themselves ran (minus the session's ask_user_question waits),
     * each a sorted disjoint list. Read from the logs, so it survives a 3080 restart. A subagent turn the logs leave
     * unclosed is running (end null) only if the host lists it now; otherwise it died with its process (a restart cuts
     * turns) and ends at the last event its session wrote in that incarnation - the same rule as the host's
     * interrupted-turn closer, so neither the downtime nor anything after it counts. A job that has not ended by itself
     * (still running, killed, cut by a restart) is left out: an always-on job counts only while the main turn or a
     * subagent runs, which activity / subagent already cover; a finite one counts once it is done.
     */
    async background(sid) {
      const st = await ensure(sid);
      const kids = [], seen = new Set([sid]);
      for (const queue = [...st.children]; queue.length > 0;) {
        const id = queue.shift();
        if (seen.has(id)) continue;
        seen.add(id);
        let cs;
        try { cs = await ensure(id); } catch (error) { if (isSessionGone(error)) continue; throw error; } // a deleted subagent session has no time left to count
        kids.push([id, cs]);
        queue.push(...cs.children);
      }
      const open = kids.some(([, cs]) => cs.turns.some(([, b]) => b === null));
      const run = open ? await running(sid) : null;
      if (open && !(run?.subagent instanceof Set)) throw new Error("dsh-alignment todos: running(" + sid + ") gave no {subagent} set");
      const subagent = [];
      for (const [id, cs] of kids) subagent.push(...working(cs, cs.turns.map(([a, b]) => [a, b ?? (run.subagent.has(id) ? null : Math.max(a, cs.incLast[cs.inc]))])));
      const done = mergeSpans([...st.jobs.values()].filter((j) => j.self).map((j) => [j.start, j.end]));
      return { subagent: mergeSpans(subagent), job: st.asks.length ? minusSpans(done, mergeSpans(st.asks)) : done };
    },
    /** Why the session has no todolist (api 4, NoTodo; see the top). Meant for a session whose view is null. */
    async notodo(sid) {
      const st = await ensure(sid);
      const steps = st.steps - st.taskSteps;
      if (st.reason !== null) return { by: "session", text: st.reason, why: null, steps };
      const why = isRunning(sid) ? (steps < 3 ? "starting" : null) : steps === 0 ? "no-tools" : steps < 3 ? "few-steps" : null;
      return why === null ? { by: "none", text: null, why: null, steps } : { by: "inferred", text: null, why, steps };
    },
    observe(sid, event) {
      const s = live.get(sid);
      if (s === undefined || s.error !== null) return;
      if (s.state === null) { s.pending.push(event); return; }
      try { fold(s.state, event); } catch (error) { s.error = error; }
    },
    /** background = background(sid) when the caller has it (an item's time then counts it too), else the turns only. */
    async view(sid, background = { subagent: [], job: [] }) {
      const st = await ensure(sid);
      if (st.todo === null) return null;
      const at = now(), busy = mergeSpans(working(st).concat(background.subagent, background.job));
      const extra = provisional(st);
      const runsOf = st.items.map((r) => [...r.runs, ...(extra.get(r.key) ?? [])].sort((a, b) => a.since - b.since));
      const gone = new Set(), states = await runStates(sid, st, runsOf.flat(), gone);
      const items = st.todo.todos.map((t, k) => {
        const { text } = splitTodo(t.content);
        const r = st.items[k], eta = r.eta;
        const elapsedMs = r.spans.length === 0 ? null : activeIn(r.spans, busy, at);
        const runs = runsOf[k].map((run) => ({ id: run.id, kind: run.kind, name: run.name, state: states.get(run), since: run.since, mode: run.mode ?? null, gone: gone.has(run) }));
        const agent = BOT_RE.test(t.content) ? { by: "session", runs } : runs.length > 0 ? { by: "inferred", runs } : null;
        return { text, status: t.status, eta, startedAt: iso(r.startedAt), completedAt: iso(r.completedAt), elapsedMs, spans: r.spans.map(([a, b]) => [a, b]), approx: r.approx, agent };
      });
      const view = {
        updatedAt: new Date(st.todo.time).toISOString(), turn: st.todo.turn, latestTurn: st.latestTurn, running: isRunning(sid),
        done: items.filter((i) => i.status === "completed").length, total: items.length, items,
      };
      const stable = { ...view, items: items.map(({ elapsedMs, ...rest }) => rest) };
      return { rev: createHash("sha1").update(JSON.stringify(stable)).digest("hex").slice(0, 12), ...view };
    },
  };
}

/** The route: (req, res) for GET /alignment/todos; guard is the same fence as /data. */
export function todosHandler({ index, guard }) {
  const reply = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(body));
  };
  return async (req, res) => {
    try {
      const denied = guard(req);
      if (denied) return reply(res, denied.code, { ok: false, message: denied.message });
      if (req.method !== "GET") return reply(res, 405, { ok: false, message: "不支持的请求" });
      // ?exists=<sid> (2026-10-26): {ok, exists} for one session, asked when the page opens a subagent's session
      const one = new URL(req.url, "http://127.0.0.1").searchParams.get("exists");
      if (one !== null) {
        if (!/^(session-)?[A-Za-z0-9-]{1,128}$/.test(one)) throw new TodosRequestError("会话 ID 不对");
        return reply(res, 200, { ok: true, api: TODOS_API, exists: await index.exists(one) });
      }
      const sids = parseSids(new URL(req.url, "http://127.0.0.1").searchParams.get("sids"));
      const sessions = {}, activity = {}, background = {}, notodo = {}, ended = {};
      for (const sid of sids) {
        let bg;
        try { background[sid] = bg = await index.background(sid); } catch (error) { background[sid] = { error: error.message }; bg = undefined; }
        try { sessions[sid] = await index.view(sid, bg); } catch (error) { sessions[sid] = { error: error.message }; }
        try { activity[sid] = await index.activity(sid); } catch (error) { activity[sid] = { error: error.message }; }
        // api 4: only for a session that never wrote a todolist
        if (sessions[sid] === null) try { notodo[sid] = await index.notodo(sid); } catch (error) { notodo[sid] = { error: error.message }; }
        try { ended[sid] = await index.lastTurn(sid); } catch (error) { ended[sid] = { error: error.message }; }
      }
      return reply(res, 200, { ok: true, api: TODOS_API, sessions, activity, background, notodo, ended });
    } catch (error) {
      if (!(error instanceof TodosRequestError)) console.error("[dsh-alignment] todos " + (error.stack ?? error.message));
      return reply(res, error instanceof TodosRequestError ? 400 : 500, { ok: false, message: error.message });
    }
  };
}
