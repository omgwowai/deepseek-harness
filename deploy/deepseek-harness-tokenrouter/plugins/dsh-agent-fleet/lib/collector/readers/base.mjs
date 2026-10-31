// Shared transcript model for the four readers (omp, claude, codex, dsh).
//
// A reader translates its native rows into calls on a `Session` (user / model / toolStart / toolEnd / turnStart /
// turnEnd / ...). Everything that is not format specific lives here: stable event ids, open tool calls and their
// pending → ok/error upgrade, turn and status logic, usage totals, redaction, `AgentRecord` / `AgentEvent` shapes.
//
// One event per tool call, id = the call id, type "tool" ("spawn" for subagent-spawning calls, "message" for
// inter-agent messages). A call that starts several subagents (`task` with `tasks[]`) yields one spawn event per child:
// `<callId>`, `<callId>#1`, ... Every other event is `<type>:<n>` with n counting that type's events in transcript
// order, so feeding the same rows from byte 0 into a fresh Session yields identical ids.
//
// While `session.replay` is true (history copied from a parent: OMP/Claude/Codex forks, seeded DSH sessions) rows
// only update metadata: no events, usage, counts or turn state.
import { LIMITS, agentKey } from "../../protocol.mjs";
import { redactText } from "../../redact.mjs";
import { classifyTool } from "../../targets.mjs";

const USAGE_KEYS = ["input", "output", "cacheRead", "cacheWrite", "reasoning"];
const MAX_READER_ERRORS = 3;
const EFFORTS = new Set(["off", "none", "minimal", "low", "medium", "high", "xhigh", "max"]);
/** A response without a stop reason that looks final ends its turn once nothing followed for this long. */
export const QUIET_END_MS = 15_000;
/** A catalog row names the spawn call that is still open or finished at most this long ago. */
const LINK_WINDOW_MS = 30_000;

const SPAWN_TOOLS = new Set(["task", "agent", "spawn_agent", "subagent", "subagent_fork", "collaboration.spawn_agent"]);
const MESSAGE_TOOLS = new Set([
  "send_message", "sendmessage", "send_input", "followup_task", "peer_send_message", "agent_teams_send_message",
  "collaboration.send_message", "collaboration.followup_task",
]);
const WAIT_TOOLS = new Set(["ask", "askuserquestion", "ask_user_question", "request_user_input", "exitplanmode"]);

// ---------------------------------------------------------------------------------------------- text helpers

/** Whitespace-collapsed, redacted text cut to `max` characters. */
export function clip(value, max = LIMITS.textChars) {
  if (value === null || value === undefined) return "";
  const raw = typeof value === "string" ? value : String(value);
  return redactText(raw.slice(0, Math.max(64, max * 8)).replace(/\s+/g, " ").trim(), max);
}

/** Text of a message `content` (string, or parts with `text`; reasoning/thinking/image parts are skipped). */
export function partsText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    const text = typeof part === "string" ? part
      : part && typeof part.text === "string" && (part.type === undefined || /(^|_)text$/i.test(part.type)) ? part.text : "";
    if (text) out += (out ? "\n" : "") + text;
  }
  return out;
}

/** Head and tail of a tool result's text: exit codes sit at either end of shell output. */
export function sampleText(content, edge = 600) {
  const text = partsText(content);
  return text.length <= edge * 2 ? text : `${text.slice(0, edge)}\n${text.slice(-edge)}`;
}

export function parseJson(text) {
  if (typeof text !== "string") return null;
  const first = text.trimStart()[0];
  if (first !== "{" && first !== "[") return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * The DSH ACP adapter opens a native agent in a throwaway `<tmp>/dsh-acp-probe-<rand>` directory to read its model
 * catalogue. Those sessions are the adapter's probe, not a user run: no prompt, no tools, no parent. The directory
 * name is the only discriminator — the adapter stamps `@local/dsh-acp-adapter` on its real sessions too (same
 * originator, cwd = the workspace), so a reader must never key on that alone.
 */
const ACP_PROBE_DIR = /(?:^|\/)dsh-acp-probe-[0-9a-z]+(?:$|\/)/i;
export const isAcpProbe = cwd => typeof cwd === "string" && ACP_PROBE_DIR.test(cwd);

/** ISO string, epoch milliseconds or epoch seconds → epoch milliseconds (null when unusable). */
export function toMs(value) {
  if (typeof value === "number") return Number.isFinite(value) ? (value < 1e11 ? Math.round(value * 1000) : Math.round(value)) : null;
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/** "provider/model:effort" → {provider?, model, effort?}. */
export function splitModel(value) {
  if (typeof value !== "string" || !value) return {};
  let rest = value, effort;
  const colon = rest.lastIndexOf(":");
  if (colon > 0 && EFFORTS.has(rest.slice(colon + 1))) { effort = rest.slice(colon + 1); rest = rest.slice(0, colon); }
  const slash = rest.indexOf("/");
  return slash > 0 ? { provider: rest.slice(0, slash), model: rest.slice(slash + 1), effort } : { model: rest, effort };
}

const finite = value => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** Exit code printed in shell output: "Process exited with code N", "Exit code N", "exit code: N" (first match). */
export function exitCodeFromText(text) {
  const match = /(?:^|\n)\s*Exit code[: ]+(-?\d+)|exited with code (-?\d+)|exit code[: ]+(-?\d+)/i.exec(text);
  return match ? Number(match[1] ?? match[2] ?? match[3]) : undefined;
}

// ------------------------------------------------------------------------------------------ tool taxonomy

const lowerName = name => (typeof name === "string" ? name.toLowerCase() : "");
export const isSpawnTool = name => SPAWN_TOOLS.has(lowerName(name));
export const isWaitTool = name => WAIT_TOOLS.has(lowerName(name));
export function isMessageTool(name, input) {
  const lower = lowerName(name);
  return MESSAGE_TOOLS.has(lower) || (lower === "write" && typeof input?.path === "string" && input.path.startsWith("agent://"));
}

const label = (value, max = 80) => (typeof value === "string" && value ? clip(value, max) : undefined);

/** Children named by a spawn call's arguments: one per `tasks[]` entry, else one. */
function spawnChildren(input) {
  const args = input && typeof input === "object" ? input : {};
  const one = (source, fallback) => ({
    name: label(source.name ?? source.id ?? source.task_name ?? source.description ?? fallback),
    preview: label(source.description ?? source.task ?? source.prompt ?? source.message, 160),
  });
  if (Array.isArray(args.tasks) && args.tasks.length > 0) return args.tasks.map(task => one(task && typeof task === "object" ? task : {}));
  return [one(args, args.subagent_type ?? args.agent)];
}

/** Recipient and text head of a messaging tool call. */
function messageOf(input) {
  const args = input && typeof input === "object" ? input : {};
  let peer = args.target ?? args.to ?? args.recipient ?? args.agent ?? args.agent_id ?? args.id ?? args.name;
  if (typeof args.path === "string" && args.path.startsWith("agent://")) peer = args.path.slice("agent://".length);
  const text = args.message ?? args.content ?? args.text ?? args.summary ?? args.prompt;
  return { peer: label(peer, 120), text: typeof text === "string" && text ? clip(text) : undefined };
}

function cleanUsage(usage) {
  const out = {};
  if (usage) for (const key of USAGE_KEYS) if (finite(usage[key]) !== undefined) out[key] = usage[key];
  return out;
}

// ------------------------------------------------------------------------------------------------ Session

export class Session {
  /** @param {{kind: string, file: string, host: string, site: string, id: string, role?: string, now?: () => number}} init */
  constructor({ kind, file, host, site, id, role = "main", now = Date.now }) {
    this.kind = kind; this.file = file; this.host = host; this.site = site; this.id = id; this.role = role;
    this.now = now;
    this.replay = false;
    this.info = { cwd: "", model: "", provider: undefined, effort: undefined, name: undefined, description: undefined, version: undefined };
    this.nativeTitle = "";
    this.promptHead = "";
    this.parent = null;
    this.explicitStart = null; this.firstReal = null; this.firstSeen = null;
    this.updatedReal = 0; this.updatedSeen = 0;
    this.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
    this.cost = null; this.contextTokens = null; this.contextWindow = null;
    this.counts = { turns: 0, tools: 0, errors: 0, subagents: 0, events: 0 };
    this.turn = { open: false, endedAt: null, endStatus: "done" };
    this.provisionalAt = null;  // time of a response that looks final but carries no stop reason
    this.exitedAt = null;
    this.live = { state: "idle", since: 0 };
    this.pending = new Map();   // call id → the call's events (one, or one per child for a multi-task spawn)
    this.spawns = new Map();    // call id → spawn events (child ids can arrive after the call's result)
    this.approvals = new Map(); // approval id → tool name
    this.dirty = new Map();     // events created or changed since takeEvents()
    this.seq = { user: 0, model: 0, message: 0, compaction: 0, error: 0, tool: 0 };
    this.childSet = new Set();
    this.readerErrors = 0;
  }

  // ----- metadata

  /** Set descriptive fields; empty values are ignored so later rows can only refine, never blank, a field. */
  set(fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value !== "string" || value === "") continue;
      if (key === "title") { if (!this.replay) this.nativeTitle = clip(value, 200); }
      else if (key === "name") this.info.name = clip(value, 120);
      else if (key === "description") this.info.description = clip(value, 160);
      else if (key in this.info) this.info[key] = value;
    }
  }
  setRole(role) { this.role = role; }
  setParent(parent) { this.parent = parent; }
  setStart(t) { if (Number.isFinite(t)) this.explicitStart = t; }

  /** Record row activity at `t` (replayed rows only count when nothing real has been seen). */
  touch(t) {
    if (!Number.isFinite(t)) return;
    if (this.replay) {
      this.firstSeen ??= t;
      this.updatedSeen = Math.max(this.updatedSeen, t);
    } else {
      this.firstReal ??= t;
      this.updatedReal = Math.max(this.updatedReal, t);
    }
  }

  /** Remember a child session id; true when it is new. */
  addChild(id) {
    if (typeof id !== "string" || !id || this.childSet.has(id)) return false;
    this.childSet.add(id);
    return true;
  }
  childIds() { return [...this.childSet]; }

  // ----- usage

  addUsage(usage, cost) {
    if (this.replay) return;
    if (usage) for (const key of USAGE_KEYS) if (finite(usage[key]) !== undefined) this.usage[key] += usage[key];
    if (finite(cost) !== undefined) this.cost = (this.cost ?? 0) + cost;
  }
  /** Cumulative cost reported by the transcript itself: replaces the running total. */
  setCost(cost) { if (!this.replay && finite(cost) !== undefined) this.cost = cost; }
  setContext(tokens, window) {
    if (this.replay) return;
    if (finite(tokens) !== undefined && tokens > 0) this.contextTokens = tokens;
    if (finite(window) !== undefined && window > 0) this.contextWindow = window;
  }

  // ----- turns

  /** A turn began (explicit marker, a prompt, an injected message, or a response arriving while idle). */
  turnStart(t) {
    if (this.replay) return;
    this.exitedAt = null;
    this.provisionalAt = null;
    if (!this.turn.open) {
      this.abandonPending(t); // calls left open by an earlier turn will not get a result any more
      this.turn = { open: true, endedAt: null, endStatus: this.turn.endStatus };
      this.counts.turns += 1;
    }
    this.refreshLive(t);
  }

  /** Another row of a response that already ended its turn arrived (Claude writes one row per content block): reopen it, not a new turn. */
  resumeTurn(t) {
    if (this.replay || this.turn.open) return;
    this.exitedAt = null;
    this.turn = { open: true, endedAt: null, endStatus: this.turn.endStatus };
    this.refreshLive(t);
  }

  /** Close the turn. `status`: done | error | interrupted. Tool calls still open after a failed turn become `unknown`. */
  turnEnd(t, status = "done") {
    if (this.replay) return;
    this.touch(t);
    this.provisionalAt = null;
    this.turn = { open: false, endedAt: t, endStatus: status };
    if (status !== "done") this.abandonPending(t);
    this.refreshLive(t);
  }

  /**
   * The newest response looks final but its row has no stop reason (Claude subagents, older builds): the turn is
   * reported as ended once nothing follows for QUIET_END_MS. Any later turn activity cancels the claim.
   */
  provisionalEnd(t) { if (!this.replay && this.turn.open) this.provisionalAt = t; }

  abandonPending(t) {
    for (const group of this.pending.values()) {
      for (const event of group) {
        if (event.status !== "pending") continue;
        event.status = "unknown";
        event.duration = Math.max(0, t - event.t);
        this.mark(event);
      }
    }
  }

  /** The session process ended cleanly (OMP `session_exit`). */
  exit(t) {
    if (this.replay) return;
    if (this.turn.open) this.turnEnd(t, "interrupted");
    this.exitedAt = t;
    this.refreshLive(t);
  }

  // ----- events

  emit(event) {
    this.counts.events += 1;
    this.mark(event);
    return event;
  }
  mark(event) {
    this.dirty.set(event.id, event);
    if (this.dirty.size > LIMITS.hubEventsPerAgent) this.dirty.delete(this.dirty.keys().next().value);
  }
  patchEvent(event, patch) {
    if (!event) return;
    Object.assign(event, patch);
    this.mark(event);
  }
  nextId(type) { return `${type}:${++this.seq[type]}`; }

  user(t, text) {
    if (this.replay) return null;
    const head = clip(text);
    if (!head) return null;
    if (!this.promptHead) this.promptHead = head;
    return this.emit({ id: this.nextId("user"), type: "user", t, text: head });
  }

  /** A message received from another agent (a subagent's first one is its task, so it titles the session). */
  message(t, { peer, text }) {
    if (this.replay) return null;
    if (!this.promptHead && this.role !== "main" && text) this.promptHead = clip(text);
    return this.emit({
      id: this.nextId("message"), type: "message", t,
      ...(peer && { peer: clip(peer, 120) }), ...(text && { text: clip(text) }),
    });
  }

  /** One model response. Usage joins the session totals; `contextTokens` follows the latest response. */
  model(t, { duration, ttft, usage, cost, model, provider, text } = {}) {
    if (this.replay) return null;
    this.provisionalAt = null;
    this.set({ model, provider });
    this.addUsage(usage, cost);
    const clean = cleanUsage(usage);
    this.setContext((clean.input ?? 0) + (clean.cacheRead ?? 0) + (clean.cacheWrite ?? 0));
    return this.emit({
      id: this.nextId("model"), type: "model", t,
      ...(finite(duration) !== undefined && duration >= 0 && { duration: Math.round(duration) }),
      ...(model && { model }),
      ...(Object.keys(clean).length > 0 && { usage: clean }),
      ...(finite(ttft) !== undefined && { ttft: Math.round(ttft) }),
      ...(text && { text: clip(text) }),
    });
  }

  /** Further rows of a model response already emitted (Claude writes one row per content block). */
  continueModel(event, t, { usage, text } = {}) {
    if (this.replay || !event) return;
    this.provisionalAt = null;
    const next = cleanUsage(usage), prev = event.usage ?? {};
    const delta = {}, merged = { ...prev };
    for (const key of USAGE_KEYS) {
      if (next[key] !== undefined && next[key] > (prev[key] ?? 0)) { delta[key] = next[key] - (prev[key] ?? 0); merged[key] = next[key]; }
    }
    if (Object.keys(delta).length > 0) {
      this.addUsage(delta);
      event.usage = merged;
      this.setContext((merged.input ?? 0) + (merged.cacheRead ?? 0) + (merged.cacheWrite ?? 0));
    }
    event.duration = Math.max(event.duration ?? 0, t - event.t);
    if (text && !event.text) event.text = clip(text);
    this.mark(event);
  }

  compaction(t, { text } = {}) {
    if (this.replay) return null;
    return this.emit({ id: this.nextId("compaction"), type: "compaction", t, ...(text && { text: clip(text) }) });
  }

  error(t, text) {
    if (this.replay) return null;
    this.counts.errors += 1;
    return this.emit({ id: this.nextId("error"), type: "error", t, ...(text && { text: clip(text) }) });
  }

  /** A row could not be interpreted: surface the first few as error events instead of failing the stream. */
  readerError(error, t) {
    this.readerErrors += 1;
    if (this.readerErrors > MAX_READER_ERRORS) return;
    const saved = this.replay;
    this.replay = false;
    this.error(Number.isFinite(t) ? t : this.updatedReal, `reader: ${error?.message ?? error}`);
    this.replay = saved;
  }

  // ----- tool calls

  /** A tool call began: type "tool", "spawn" (subagent-spawning tools) or "message" (inter-agent messages). */
  toolStart(t, { id, name, input }) {
    if (this.replay) return null;
    this.provisionalAt = null;
    const callId = typeof id === "string" && id ? id : this.nextId("tool");
    const toolName = typeof name === "string" && name ? name : "tool";
    const cls = classifyTool({ kind: this.kind, name: toolName, input, cwd: this.info.cwd, host: this.host, site: this.site });
    const common = { t, status: "pending", name: toolName, category: cls.category, targets: cls.targets };
    let group;
    if (isSpawnTool(toolName)) {
      const children = spawnChildren(input);
      group = children.map((child, index) => this.emit({
        id: index === 0 ? callId : `${callId}#${index}`, type: "spawn", ...common,
        preview: children.length > 1 ? `${child.name ?? "task"}${child.preview ? `: ${child.preview}` : ""}` : cls.preview,
        child: { kind: this.kind, ...(child.name && { name: child.name }) },
      }));
      this.spawns.set(callId, group);
      this.counts.subagents += group.length;
    } else if (isMessageTool(toolName, input)) {
      const { peer, text } = messageOf(input);
      group = [this.emit({ id: callId, type: "message", ...common, preview: cls.preview, ...(peer && { peer }), ...(text && { text }) })];
    } else {
      group = [this.emit({ id: callId, type: "tool", ...common, preview: cls.preview })];
    }
    this.counts.tools += 1;
    this.pending.set(callId, group);
    this.touch(t);
    this.refreshLive(t);
    return group[0];
  }

  /** The result of a tool call arrived. `childIds` (spawn calls): record ids of the children, in call order. */
  toolEnd(t, id, { isError = false, exitCode, text, childIds } = {}) {
    if (this.replay) return;
    this.provisionalAt = null;
    if (childIds?.length) this.setChildren(id, childIds);
    const group = this.pending.get(id);
    if (!group) return;
    this.pending.delete(id);
    const code = finite(exitCode);
    const failed = Boolean(isError) || (code !== undefined && code !== 0);
    group.forEach((event, index) => {
      event.status = failed ? "error" : "ok";
      event.duration = Math.max(0, t - event.t);
      if (index === 0) {
        if (code !== undefined) event.exitCode = code;
        if (failed && text) event.text = clip(text);
      }
      this.mark(event);
    });
    if (failed) this.counts.errors += 1;
    this.touch(t);
    this.refreshLive(t);
  }

  /** Name the children of a spawn call, in call order (may arrive after the call's result). */
  setChildren(callId, ids) {
    const events = this.spawns.get(callId);
    ids.forEach((childId, index) => this.linkChild(events?.[index], childId));
  }

  /** Attach a child session id (and a name, when the event has none) to a spawn event. */
  linkChild(event, childId, name) {
    if (!childId) return;
    this.addChild(childId);
    if (event?.child && (event.child.id !== childId || (name && !event.child.name))) {
      this.patchEvent(event, { child: { ...event.child, id: childId, ...(name && !event.child.name && { name: label(name) }) } });
    }
  }

  /**
   * A child announced itself (DSH catalog row) at `t`: attach it to the spawn call it belongs to, else record a
   * standalone spawn event (teammates, workflow agents). Among the calls still waiting for a child, one whose name
   * equals `name` wins, otherwise the oldest.
   */
  adoptChild(t, { id, name, preview }) {
    if (this.replay || !id || this.childSet.has(id)) return null;
    const waiting = [];
    for (const events of this.spawns.values()) {
      for (const event of events) {
        if (event.child?.id || (event.status !== "pending" && t - (event.t + (event.duration ?? 0)) > LINK_WINDOW_MS)) continue;
        waiting.push(event);
      }
    }
    const target = waiting.find(event => name && event.child.name?.toLowerCase() === name.toLowerCase()) ?? waiting[0];
    if (target) { this.linkChild(target, id, name); return target; }
    this.addChild(id);
    this.counts.subagents += 1;
    return this.emit({
      id: `spawn:${id}`, type: "spawn", t, status: "ok", category: "spawn",
      ...(preview && { preview: label(preview, 160) }),
      child: { kind: this.kind, ...(name && { name: label(name) }), id },
    });
  }

  approvalAsked(id, name) { if (!this.replay && id) { this.approvals.set(id, name ?? "tool"); this.refreshLive(this.updatedReal); } }
  approvalDecided(id) { if (this.approvals.delete(id)) this.refreshLive(this.updatedReal); }

  // ----- live state

  openTools() {
    const open = [];
    for (const group of this.pending.values()) if (group[0].status === "pending") open.push(group[0]);
    return open;
  }
  waiting() {
    return this.approvals.size > 0 || this.openTools().some(event => isWaitTool(event.name));
  }
  /** A provisional end that nothing has contradicted for QUIET_END_MS. */
  quiet() {
    return this.turn.open && this.provisionalAt !== null && this.openTools().length === 0 && this.now() - this.provisionalAt >= QUIET_END_MS;
  }
  isOpen() { return this.turn.open && !this.quiet(); }
  /** When a provisional end will mature (the snapshot changes without any new row), or null. */
  settleAt() {
    return this.turn.open && this.provisionalAt !== null && this.openTools().length === 0 && !this.quiet() ? this.provisionalAt + QUIET_END_MS : null;
  }
  state() {
    if (this.isOpen()) return this.waiting() ? "waiting" : this.openTools().length > 0 ? "tool" : "model";
    return this.exitedAt !== null ? "ended" : "idle";
  }
  refreshLive(t) {
    const state = this.state();
    if (state !== this.live.state) {
      this.live.state = state;
      this.live.since = Number.isFinite(t) ? t : this.updatedReal;
    }
  }
  doing() {
    const state = this.state();
    if (state === "waiting") {
      const approval = [...this.approvals.values()].at(-1);
      return approval !== undefined ? clip(`waiting for approval: ${approval}`, 160) : "waiting for user";
    }
    if (state === "tool") {
      const open = this.openTools();
      const event = open.at(-1);
      return clip(`${event.name}${event.preview ? ` ${event.preview}` : ""}${open.length > 1 ? ` (+${open.length - 1})` : ""}`, 160);
    }
    return state === "model" ? "thinking" : "";
  }

  // ----- outputs

  snapshot() {
    const quiet = this.quiet();
    this.refreshLive(quiet ? this.provisionalAt : this.updatedReal);
    const open = this.isOpen();
    const seen = this.firstReal !== null || this.firstSeen !== null || this.explicitStart !== null;
    const status = !seen ? "unknown" : open ? (this.waiting() ? "waiting" : "running") : quiet ? "done" : this.turn.endStatus;
    const startedAt = this.explicitStart ?? this.firstReal ?? this.firstSeen ?? 0;
    const updatedAt = Math.max(this.explicitStart ?? 0, this.updatedReal) || this.updatedSeen;
    const endedAt = this.exitedAt ?? (open ? null : quiet ? this.provisionalAt : this.turn.endedAt);
    const title = this.nativeTitle || clip(this.promptHead, 80);
    const { cwd, model, provider, effort, name, description, version } = this.info;
    return {
      key: agentKey(this.host, this.kind, this.id),
      host: this.host, site: this.site, kind: this.kind, id: this.id, file: this.file,
      cwd, title, model,
      ...(provider && { provider }), ...(effort && { effort }),
      role: this.role,
      ...(name && { name }), ...(description && { description }),
      parent: this.parent ? { ...this.parent } : null,
      startedAt, updatedAt, endedAt, status,
      live: { alive: null, state: this.live.state, since: this.live.since || startedAt, doing: this.doing(), turnOpen: open },
      usage: {
        ...this.usage,
        ...(this.cost !== null && { cost: this.cost }),
        ...(this.contextTokens !== null && { contextTokens: this.contextTokens }),
        ...(this.contextWindow !== null && { contextWindow: this.contextWindow }),
      },
      counts: { ...this.counts },
      ...(version && { version }),
    };
  }

  /** Events created or changed since the previous call (copies; an event comes back when its status changes). */
  takeEvents() {
    const out = [];
    for (const event of this.dirty.values()) out.push({ ...event, ...(event.child && { child: { ...event.child } }) });
    this.dirty.clear();
    return out;
  }
}

/**
 * The reader object the collector drives. `handle(row)` is the format specific part; a row that throws becomes a
 * (capped) error event instead of stopping the stream. `rowTime(row)` only dates that error.
 * `settleAt()`: epoch ms after which `snapshot()` differs from now although no row arrived (a provisional turn end
 * maturing), else null; the collector re-snapshots then.
 */
export function makeReader(session, handle, rowTime = () => undefined) {
  return {
    feed(lines) {
      for (const row of lines) {
        try { handle(row); } catch (error) { session.readerError(error, rowTime(row)); }
      }
    },
    snapshot: () => session.snapshot(),
    takeEvents: () => session.takeEvents(),
    children: () => session.childIds(),
    settleAt: () => session.settleAt(),
  };
}
