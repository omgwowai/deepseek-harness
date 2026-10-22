// Tool rows for live ACP turns, appended to the DSH session log once the turn settles.
//
// An ACP session is accounted by DSH's own agent loop: the log records turn/start, step/start, the
// adapter's outer assistant message and turn/end, while the external agent's tool calls stay in the
// native transcript — and, for display, in the adapter's sidecar activity journal
// (`dsh-acp/sidecar.sqlite`), which is what renders the Chat tab's tool cards. The Trajectory tab
// reads the session log, so a live ACP turn shows no tool rows at all.
//
// This module closes that gap host-side: when a turn of an ACP-bound session settles (`turn/end`), it
// re-reads the bound native transcript through the importer's own reader (`transcriptFor`), takes
// that turn's `tool/call` + `tool/result` rows — already carrying the importer's presentation (wire
// tool names, renamed arguments, exit markers, truncation) — and appends them to the session log as a
// new synthetic tool turn: `turn/start → step/start → one assistant message advertising the calls →
// the tool rows → step/end → turn/end`. A settled turn cannot be reopened and its own assistant
// message cannot be rewritten, and the stored-log format admits `tool/call` only inside an open turn
// and step against an advertised call, so a new turn is the only valid append-only shape. Rows carry
// a `derived-` call id; a row whose native call id is already in the log (imported, or from an
// earlier pass) is skipped, so passes are idempotent.
//
// The append must be deferred: `session/event` fires inside the commit that added `turn/end`, and an
// append that reenters that publication boundary is refused. Already-settled turns from before this
// plugin was loaded are repaired by a best-effort scan (live sessions through their own object,
// stored sessions through a write handle). Every failure is a logged skip, never an exception into
// DSH; sessions without an ACP binding are ignored.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { acpFor, transcriptFor } from "./native.bundle.js";

/** Call id prefix of the rows this module writes; the importer's rows carry `imported-`. */
const DERIVED_PREFIX = "derived-";
/** Our own call id markings, stripped to compare a row against the native transcript's call id. */
const FOREIGN_PREFIX = /^(?:imported|derived)-/u;
/** Prompt texts shorter than this must be equal; longer ones may be truncations of each other. */
const PROMPT_MATCH_MIN = 24;
/** The append retry only absorbs the "another append is being published" refusal. */
const REENTRY = /reenter/u;
const RETRY_DELAY_MS = 100;
const RETRY_LIMIT = 50;
/** First scan of already-settled turns after startup, and the interval of the later best-effort passes. */
const BOOT_DELAY_MS = 4_000;
const SCAN_INTERVAL_MS = 300_000;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** Collapsed text of one message-bearing payload, for prompt comparison. */
function promptText(event) {
  const content = event?.data?.content ?? event?.data?.message?.content;
  if (!Array.isArray(content)) return "";
  return content.filter(block => block?.type === "text").map(block => String(block.text ?? "")).join(" ").replace(/\s+/gu, " ").trim();
}

/** Native call id behind a log call id: `imported-`/`derived-` are our markings, not the agent's. */
const nativeCallId = callId => typeof callId === "string" ? callId.replace(FOREIGN_PREFIX, "") : "";

/** One ACP binding row of the adapter sidecar, or null when this DSH session is DSH's own. */
function bindingOf(home, dshSessionId) {
  const file = join(home, "dsh-acp", "sidecar.sqlite");
  if (!existsSync(file)) return null;
  let database;
  try { database = new DatabaseSync(file, { readOnly: true }); } catch { return null; }
  try {
    const row = database.prepare("SELECT acp_provider_id, acp_session_id, payload FROM bindings WHERE dsh_session_id = ?").get(dshSessionId);
    if (!row?.acp_session_id) return null;
    let payload = null;
    try { payload = JSON.parse(row.payload); } catch { payload = null; }
    return { provider: String(row.acp_provider_id ?? ""), sessionId: String(row.acp_session_id), payload };
  } catch { return null; } finally { try { database.close(); } catch { /* read-only close cannot fail meaningfully */ } }
}

/** Every ACP binding the adapter holds, as `dshSessionId → binding`. */
function bindingsOf(home) {
  const all = new Map();
  const file = join(home, "dsh-acp", "sidecar.sqlite");
  if (!existsSync(file)) return all;
  let database;
  try { database = new DatabaseSync(file, { readOnly: true }); } catch { return all; }
  try {
    for (const row of database.prepare("SELECT dsh_session_id, acp_provider_id, acp_session_id, payload FROM bindings").all()) {
      if (!row?.acp_session_id) continue;
      let payload = null;
      try { payload = JSON.parse(row.payload); } catch { payload = null; }
      all.set(String(row.dsh_session_id), { provider: String(row.acp_provider_id ?? ""), sessionId: String(row.acp_session_id), payload });
    }
  } catch { /* a sidecar mid-migration has no readable bindings yet */ } finally { try { database.close(); } catch { /* read-only close cannot fail meaningfully */ } }
  return all;
}

/**
 * What one DSH log already knows, per turn: the prompt text, whether the turn settled, and the
 * highest step number. A tool row belongs to the turn its own payload names — the supplement appends
 * rows in a synthetic turn of their own, so the walking position would misattribute them to the
 * next real turn.
 */
function dshTurns(events) {
  const turns = new Map();
  let current;
  for (const event of events) {
    if (event.type === "turn/start") {
      current = { turn: event.data.turn, text: "", step: 0, settled: false };
      turns.set(current.turn, current);
      continue;
    }
    if (event.type === "turn/end") { if (Number.isInteger(event.data?.turn)) turns.get(event.data.turn)?.settled !== undefined && (turns.get(event.data.turn).settled = true); else if (current !== undefined) current.settled = true; continue; }
    if (current === undefined) continue;
    if (event.type === "step/start" || event.type === "step/end") { if (Number.isInteger(event.data?.step)) current.step = Math.max(current.step, event.data.step); }
    else if (event.type === "user/message") { if (current.text === "" && event.data?.source?.kind === "user") current.text = promptText(event); }
  }
  return turns;
}

/**
 * Every native call id the log already holds as a tool row — whatever turn they sit in and whatever
 * pass wrote them (`imported-`, `derived-`, or plain). The supplement writes its rows into a
 * synthetic turn of their own, so a per-turn comparison would miss exactly the rows an earlier pass
 * appended; the whole log is the only correct scope for "already there".
 */
function heldNativeIds(events) {
  const held = new Set();
  for (const event of events) {
    const callId = event.type === "tool/call" ? event.data?.callId : event.type === "tool/result" ? event.data?.message?.source?.callId : undefined;
    const native = nativeCallId(callId);
    if (native !== "") held.add(native);
  }
  return held;
}

/** The native transcript's turns, as `turn → { text, rows }` holding only its tool rows. */
function nativeTurns(events) {
  const turns = new Map();
  let current;
  for (const event of events) {
    if (event.type === "turn/start") { current = { text: "", rows: [] }; turns.set(event.data.turn, current); continue; }
    if (current === undefined) continue;
    if (event.type === "user/message") { if (current.text === "") current.text = promptText(event); }
    else if (event.type === "tool/call" || event.type === "tool/result") current.rows.push(event);
  }
  return turns;
}

/** Whether two prompts are the same text; long texts may be truncations of each other. */
function samePrompt(left, right) {
  if (left === "" || right === "") return false;
  if (left === right) return true;
  return left.length >= PROMPT_MATCH_MIN && right.length >= PROMPT_MATCH_MIN && (left.startsWith(right) || right.startsWith(left));
}

/**
 * The native turn one DSH turn belongs to. The ACP binding's prompt ordinal is the anchor (the
 * adapter counts prompts it committed to the native agent), and the prompt text confirms it — text
 * also covers a session whose ordinals drifted (a prompt the native agent never received) and a
 * session continued into a native transcript that already had earlier prompts.
 */
function chooseTurn(turns, { turn, ordinal, text }) {
  const anchor = Number.isInteger(ordinal) && ordinal >= 1 ? ordinal : turn;
  const matches = [...turns.keys()].filter(candidate => samePrompt(turns.get(candidate).text, text)).sort((left, right) => left - right);
  if (matches.includes(anchor)) return { turn: anchor, source: "ordinal+prompt" };
  const before = matches.filter(candidate => candidate <= anchor);
  if (before.length > 0) return { turn: before.at(-1), source: "prompt" };
  if (matches.length > 0) return { turn: matches.at(-1), source: "prompt" };
  if (turns.has(anchor)) return { turn: anchor, source: "ordinal" };
  if (turns.has(turn)) return { turn, source: "turn" };
  return null;
}

/** The prompt ordinal the adapter marked on one DSH turn's answer, from its `dsh-acp` replay payload. */
function ordinalOf(events, turn) {
  for (const event of events) {
    if (event.type !== "assistant/message" || event.data?.turn !== turn) continue;
    const response = event.data?.message?.source?.replayState?.response;
    if (response?.kind === "dsh-acp" && Number.isInteger(response.committedPromptOrdinal)) return response.committedPromptOrdinal;
  }
  return undefined;
}

/**
 * The append for one native turn, as a complete synthetic tool turn.
 *
 * A stored log only admits `tool/call` inside an open turn and step, against a call an
 * `assistant/message` of that step advertised (`dsh-session-format`'s relationship validation), and
 * turn/step numbers must stay strictly sequential — a settled turn cannot be reopened, and its own
 * `assistant/message` cannot be rewritten (append-only log). So the rows go into a new turn of their
 * own: `turn/start` → `step/start` → one assistant message advertising the calls → the tool rows →
 * `step/end` → `turn/end`. The Trajectory and Chat clients place the rows by `data.turn`/`data.step`,
 * so they land in this turn's process group; a call the log already holds anywhere (`held`, see
 * `heldNativeIds`) is skipped by native id, which keeps repeated passes idempotent even though the
 * earlier rows live in a different turn.
 */
function planTurn(nativeTurn, { turn, held, acp }) {
  const calls = [];
  for (const event of nativeTurn.rows) {
    if (event.type !== "tool/call") continue;
    const data = structuredClone(event.data);
    const native = nativeCallId(data?.callId);
    if (native === "" || held.has(native)) continue;
    calls.push({ native, id: `${DERIVED_PREFIX}${native}`, name: String(data.name ?? ""), arguments: String(data.arguments ?? "{}") });
  }
  if (calls.length === 0) return [];
  const appended = new Set(calls.map(call => call.native));
  const results = [];
  for (const event of nativeTurn.rows) {
    if (event.type !== "tool/result") continue;
    const data = structuredClone(event.data);
    const native = nativeCallId(data?.message?.source?.callId);
    if (!appended.has(native)) continue;
    const derived = `${DERIVED_PREFIX}${native}`;
    data.message = { ...data.message, toolCallId: derived, source: { ...data.message.source, callId: derived } };
    results.push({ type: "tool/result", data, ...(event.surfaceOp === undefined ? {} : { surfaceOp: event.surfaceOp }) });
  }
  const blocks = calls.map(call => ({ type: "tool-call", id: call.id, name: call.name, arguments: call.arguments }));
  const stream = [
    ...blocks.map((block, index) => ({ type: "tool-call-chunks", time0: 0, index, dt: [], id: block.id, name: block.name, args: [block.arguments] })),
    { type: "chunk", time: 0, chunk: { type: "finish", reason: { kind: "tool-calls" } } },
  ];
  const assistant = {
    type: "assistant/message",
    data: {
      turn, step: 1,
      message: { role: "assistant", content: blocks, source: { kind: "model", provider: acp.provider, model: acp.model }, id: `derived-tool-step-${turn}` },
      stream,
    },
    surfaceOp: "append",
  };
  return [
    { type: "turn/start", data: { turn } },
    { type: "step/start", data: { turn, step: 1 } },
    assistant,
    ...calls.map(call => ({ type: "tool/call", data: { turn, step: 1, callId: call.id, name: call.name, arguments: call.arguments } })),
    ...results.map(row => ({ ...row, data: { ...row.data, turn, step: 1 } })),
    { type: "step/end", data: { turn, step: 1 } },
    { type: "turn/end", data: { turn, reason: { kind: "completed" } } },
  ];
}

/** The next turn number a log admits: the format requires turn/start to open `last turn + 1`. */
function nextTurn(events) {
  let last = 0;
  for (const event of events) if (event.type === "turn/start" && Number.isInteger(event.data?.turn)) last = Math.max(last, event.data.turn);
  return last + 1;
}

/**
 * Start the live-turn supplement for one plugin host. Scans at startup and on an interval, and
 * supplements each settled ACP turn as it lands. Never throws: every failure lands in the status.
 */
export function startLiveTools(ctx, config) {
  const homePath = ctx.get("dshHomePath");
  const home = typeof homePath === "function" ? homePath() : String(homePath ?? "");
  const status = { at: null, scheduled: 0, appended: 0, backfilled: 0, turns: 0, skipped: 0, scanned: 0, failed: [], error: null };
  /** Per-session append chains: two supplements of one session never interleave. */
  const tails = new Map();
  /** Turns this process already verified (nothing to append or appended), keyed `<session>#<turn>`. */
  const verified = new Set();
  const log = (level, message) => ctx.logger?.[level]?.(`agent-dag: ${message}`);
  const warn = error => { const message = String(error?.message ?? error); status.failed.push(message); if (status.failed.length > 8) status.failed.shift(); log("warn", `实时工具行补写跳过：${message}`); };

  /** Roots of the configured native agents, as `kind → home` (the ACP profile's own home when set). */
  const homes = () => {
    const result = {};
    for (const [kind, roots] of Object.entries(config.externalRoots ?? {})) {
      const root = roots?.[0];
      if (typeof root === "string" && root !== "") result[kind] = config.nativeHomes?.[kind] ?? dirname(root);
    }
    return result;
  };

  /** One append through a live session; only the reentry refusal is retried. */
  async function appendLive(session, row) {
    for (let attempt = 0; ; attempt++) {
      try { session.append(row.type, row.data, row.surfaceOp === undefined ? undefined : { surfaceOp: row.surfaceOp }); return; }
      catch (error) {
        if (!REENTRY.test(String(error?.message ?? error)) || attempt >= RETRY_LIMIT) throw error;
        await delay(RETRY_DELAY_MS);
      }
    }
  }

  /** One batch append to a stored log through its own write handle; zero rows open nothing. */
  async function appendStored(sessionId, rows, header) {
    if (rows.length === 0) return;
    const persistence = ctx.get("sessionPersistence");
    if (persistence === undefined || typeof persistence.open !== "function") throw new Error("会话持久化服务不可用");
    const handle = await persistence.open(sessionId, "write");
    try {
      const read = await handle.read(0);
      const cursor = read.events.length;
      const now = Date.now();
      await handle.append(rows.map((row, index) => ({ type: row.type, seq: cursor + index, time: now + index, data: row.data, ...(row.surfaceOp === undefined ? {} : { surfaceOp: row.surfaceOp }) })));
    } finally { await handle.close(); }
  }

  /**
   * One session as this module sees it: its committed events read once, and the append route (the
   * live session object, or the stored log) plus its header for the transcript request.
   */
  async function openView(sessionId) {
    const live = ctx.get("sessions")?.get?.(sessionId);
    if (live !== undefined) return { live, header: live.header, events: live.snapshotEvents(), append: rows => (async () => { for (const row of rows) await appendLive(live, row); })() };
    const query = ctx.get("sessionQuery");
    if (query === undefined || typeof query.observeSession !== "function") return null;
    const lease = await query.observeSession(sessionId, { projectionMode: "none" });
    try {
      if (lease.source === "live") {
        const current = ctx.get("sessions")?.get?.(sessionId);
        if (current !== undefined) return { live: current, header: current.header, events: current.snapshotEvents(), append: rows => (async () => { for (const row of rows) await appendLive(current, row); })() };
      }
      return { live: undefined, header: lease.header, events: lease.events, append: rows => appendStored(sessionId, rows, lease.header) };
    } finally { try { lease[Symbol.dispose]?.(); } catch { /* lease release is best-effort */ } }
  }

  /**
   * Supplement the settled turns of one ACP-bound session: re-read its native transcript once, match
   * each turn, and append the rows the log does not hold yet.
   */
  async function supplement(sessionId, binding, only) {
    const kind = binding.provider.replace(/^acp-/u, "");
    const nativeHome = homes()[kind];
    if (nativeHome === undefined || acpFor(kind, undefined) === null) return;   // kind not configured in this profile
    const view = await openView(sessionId);
    if (view === null) { status.skipped += 1; return; }
    // A running agent loop holds its own turn counter and appends `lastTurn + 1` on its next prompt;
    // an append into a live session therefore lands before the loop's next turn and the format refuses
    // the duplicate number. Live sessions are supplemented once they are stored (next pass, after the
    // session closes), never while the loop can still write to them.
    if (view.live !== undefined) { status.skipped += 1; return; }
    const known = dshTurns(view.events);
    const held = heldNativeIds(view.events);
    const settled = [...known.values()].filter(entry => entry.settled && (only === undefined || entry.turn === only));
    if (settled.length === 0) return;
    const transcript = await transcriptFor({
      kind, home: nativeHome, sessionId: binding.sessionId, cwd: view.header?.cwd ?? binding.payload?.canonicalCwd ?? "",
      dshId: sessionId, acp: acpFor(kind, config.acpModels?.[kind]), bound: { agentSessionId: binding.sessionId },
    });
    const native = nativeTurns(transcript.events);
    const acp = acpFor(kind, config.acpModels?.[kind]);
    let turn = nextTurn(view.events);
    for (const state of settled) {
      const key = `${sessionId}#${state.turn}`;
      if (verified.has(key) || state.text === "") continue;   // a rowless/synthetic turn owns no prompt to match
      status.turns += 1;
      const bound = Number.isInteger(binding.payload?.committedPromptOrdinal) && binding.payload.committedPromptOrdinal >= state.turn ? binding.payload.committedPromptOrdinal : undefined;
      const ordinal = ordinalOf(view.events, state.turn) ?? bound;
      const chosen = chooseTurn(native, { turn: state.turn, ordinal, text: state.text });
      if (chosen === null) { status.skipped += 1; verified.add(key); continue; }
      const rows = planTurn(native.get(chosen.turn), { turn, held, acp });
      if (rows.length === 0) { verified.add(key); continue; }
      await view.append(rows);
      for (const row of rows) if (row.type === "tool/call") { const native = nativeCallId(row.data?.callId); if (native !== "") held.add(native); }
      status.appended += rows.length;
      if (view.live === undefined) status.backfilled += rows.length;
      verified.add(key);
      turn += 1;
      log("info", `实时工具补写：${sessionId} 原 turn ${state.turn} → 原生 turn ${chosen.turn}（${chosen.source}）作为新 turn ${rows[0].data.turn} 追加 ${rows.length} 行`);
    }
    status.at = new Date().toISOString();
  }

  /** One deferred supplement, serialized behind every earlier pass for the same session. */
  const schedule = (sessionId, binding, only) => {
    status.scheduled += 1;
    const previous = tails.get(sessionId) ?? Promise.resolve();
    const next = previous.then(() => supplement(sessionId, binding, only)).catch(warn);
    tails.set(sessionId, next);
    return next;
  };

  /**
   * Trigger of the live path: a settled turn of an ACP-bound session. The append is deferred out of
   * the commit that published `turn/end`, and a session without an ACP binding is left alone.
   */
  const onEvent = (session, event) => {
    try {
      if (event?.type !== "turn/end" || !Number.isInteger(event.data?.turn)) return;
      if (typeof session?.id !== "string") return;
      const binding = bindingOf(home, session.id);
      if (binding === null) return;
      schedule(session.id, binding, event.data.turn).catch(() => { /* warn() already recorded it */ });
    } catch (error) { warn(error); }
  };

  /** Best-effort repair of turns that settled before this plugin was loaded. */
  async function backfill() {
    const report = { at: null, scanned: 0, appended: 0, error: null };
    try {
      for (const [sessionId, binding] of bindingsOf(home)) {
        report.scanned += 1;
        status.scanned += 1;
        await schedule(sessionId, binding, undefined);
      }
      report.appended = status.appended;
    } catch (error) { report.error = String(error?.message ?? error); warn(error); }
    report.at = new Date().toISOString();
    return report;
  }

  const fiber = ctx.inject(["sessions"], () => {
    ctx.on("session/event", onEvent);
    const boot = setTimeout(() => { backfill().catch(warn); }, BOOT_DELAY_MS);
    const timer = setInterval(() => { backfill().catch(warn); }, SCAN_INTERVAL_MS);
    timer.unref?.();
    ctx.effect(() => () => { clearTimeout(boot); clearInterval(timer); }, "agent-dag:live-tools-timers");
  });
  ctx.effect(() => () => fiber.dispose?.(), "agent-dag:live-tools");
  // The hook reports what the last passes did; `{backfill: true}` runs one scan now.
  return {
    report: async payload => {
      if (payload?.backfill === true) await backfill();
      return { ...status, failed: status.failed.slice(0, 8) };
    },
    backfill,
    status,
  };
}