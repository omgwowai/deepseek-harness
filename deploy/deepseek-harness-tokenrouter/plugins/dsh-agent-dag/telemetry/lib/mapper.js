// DeepSeek Harness session events → TokenRouter telemetry records.
//
// One mapper per Session. It reads only identifiers, names, models, providers,
// token counts, timestamps, durations and status/error codes; message content,
// tool arguments and results, file paths, commands, prompts, labels and error
// messages are never read into a record.
//
// A record is { name, time (ms), severity: 'info'|'warn'|'error', attributes }.
// Attribute names are the ones TokenRouter's receiver maps to columns
// (src/telemetry/records.mjs ALIASES). Records are a pure function of the
// session header and its events, so a replayed session yields identical
// records and the receiver's record hash dedupes them.

export const EVENTS = Object.freeze({
  session: 'tokenrouter.session.start',
  subagentStart: 'tokenrouter.subagent.start',
  resume: 'tokenrouter.resume',
  chat: 'dsh.chat',
  tool: 'dsh.tool_result',
  spawn: 'dsh.subagent.spawn',
  descriptor: 'dsh.subagent.descriptor',
  compactionChat: 'dsh.compaction.chat',
  compaction: 'dsh.compaction',
  prune: 'dsh.compaction.prune',
  retry: 'dsh.llm.retry',
  turn: 'dsh.turn',
  agentError: 'dsh.agent.error',
});

// Session event types a mapper reads. Others are skipped before any copy or redaction.
export const MAPPED_TYPES = new Set(['turn/start', 'turn/end', 'step/start', 'request/context', 'assistant/message', 'assistant/attempt',
  'tool/call', 'tool/result', 'subagent/catalog', 'subagent/descriptor', 'compaction/start', 'compaction/summary', 'compaction/end', 'compaction/prune',
  'llm/retry', 'llm/retry-started', 'session/end-seed']);

// The delegation tools of dsh-tool-subagent (`subagent`, `subagent_fork`, preset variants).
export const SUBAGENT_TOOL = /^subagent(?:_|$)/;
const MCP_TOOL = /^mcp__(.+?)__(.+)$/;
const MAX_TEXT = 256;

const text = v => typeof v === 'string' && v.length > 0 && v.length <= MAX_TEXT ? v : undefined;
const count = v => Number.isSafeInteger(v) && v >= 0 ? v : undefined;
const duration = (end, start) => Number.isFinite(end) && Number.isFinite(start) && end >= start ? end - start : undefined;

function put(attrs, key, value) {
  if (value !== undefined && value !== null) attrs[key] = value;
  return attrs;
}

function usageAttributes(attrs, usage) {
  if (!usage || typeof usage !== 'object') return attrs;
  put(attrs, 'gen_ai.usage.input_tokens', count(usage.inputTokens));
  put(attrs, 'gen_ai.usage.output_tokens', count(usage.outputTokens));
  put(attrs, 'gen_ai.usage.cache_read.input_tokens', count(usage.cacheReadTokens));
  put(attrs, 'gen_ai.usage.cache_creation.input_tokens', count(usage.cacheWriteTokens));
  put(attrs, 'gen_ai.usage.reasoning.output_tokens', count(usage.reasoningTokens));
  return attrs;
}

function failureAttributes(attrs, failure) {
  if (!failure || typeof failure !== 'object') return attrs;
  put(attrs, 'error.type', text(failure.code) ?? 'error');
  put(attrs, 'http.response.status_code', count(failure.status));
  return attrs;
}

// Last raw chunk of one type in a compact assistant stream.
function lastChunk(stream, type) {
  if (!Array.isArray(stream)) return undefined;
  for (let i = stream.length - 1; i >= 0; i--) {
    const r = stream[i];
    if (r?.type === 'chunk' && r.chunk?.type === type) return r.chunk;
  }
  return undefined;
}

// Time of the first streamed delta (text, reasoning or tool call).
function firstTokenTime(stream) {
  if (!Array.isArray(stream)) return undefined;
  let first;
  for (const r of stream) {
    const t = r?.type === 'chunk' ? (/-delta$/.test(r.chunk?.type ?? '') ? r.time : undefined) : r?.time0;
    if (Number.isFinite(t) && (first === undefined || t < first)) first = t;
  }
  return first;
}

export function mcpParts(toolName) {
  const m = typeof toolName === 'string' ? MCP_TOOL.exec(toolName) : null;
  return m ? { server: m[1], tool: m[2] } : null;
}

// The agent name shown in the tree: the preset when DSH records one, else the
// session's role. A delegated child is named by its subagent/descriptor
// (`fork` when its provider seeds it with the parent conversation).
function agentName(header) {
  const preset = text(header.agentPreset);
  if (preset) return preset;
  if (header.isSeeded) return 'fork';
  return header.origin === 'subagent' ? undefined : 'main';
}

// A session's links from its own header: the direct parent (sub-agent or fork
// source), the fork source and point when DSH seeded the session with the
// parent's events (subagent_fork, web/desktop "branch from here"), and its
// origin. The fork point is the seed length n: the parent's events 0…n−1 were
// copied (web session/fork atSeq = n − 1; the seed's end-seed is the child's seq n).
export function sessionLinks(header = {}, inheritedEventCount) {
  const parent = text(header.parentSession === undefined || header.parentSession === null ? undefined : String(header.parentSession));
  const seeded = header.isSeeded === true && parent !== undefined;
  const point = count(inheritedEventCount);
  return {
    parent,
    forkedFrom: seeded ? parent : undefined,
    forkPoint: seeded && point !== undefined ? String(point) : undefined,
    forkKind: seeded ? 'fork' : undefined,
    origin: header.origin === 'subagent' ? 'subagent' : seeded ? 'fork' : 'main',
  };
}

/**
 * @param {{ id: string, header?: object, inheritedEventCount?: number }} session
 */
export function createSessionMapper(session) {
  const id = String(session.id);
  const header = session.header ?? {};
  const steps = new Map();          // "turn/step" → start time of the current model attempt
  const turns = new Map();          // turn → start time
  const calls = new Map();          // tool call id → { name, time }
  const children = new Set();
  const compactions = new Map();    // compaction id → start time
  let route = { provider: undefined, model: undefined };
  let lastSeq = -1;

  const base = (event, extra = {}) => {
    const attrs = { 'session.id': id, 'agent.id': id, 'dsh.event.seq': event.seq };
    const d = event.data ?? {};
    put(attrs, 'dsh.turn', count(d.turn));
    put(attrs, 'dsh.step', count(d.step));
    return Object.assign(attrs, extra);
  };
  const record = (name, event, attributes, severity = 'info', time = event.time) => ({ name, time, severity, attributes });
  const stepKey = d => d.turn + '/' + d.step;

  function sessionRecord() {
    const attrs = { 'session.id': id, 'agent.id': id };
    put(attrs, 'agent.name', agentName(header));
    const links = sessionLinks(header, session.inheritedEventCount);
    attrs['session.origin'] = links.origin;
    attrs['dsh.session.origin'] = text(header.origin) ?? 'root';
    put(attrs, 'dsh.session.format_version', count(header.version));
    if (links.parent) attrs['parent.session.id'] = links.parent;
    if (links.forkedFrom) {
      attrs['forked_from_session_id'] = links.forkedFrom;
      attrs['fork.kind'] = 'fork';
      put(attrs, 'fork.point', links.forkPoint);
    }
    // Live headers omit a zero depth that restored headers carry: only a real
    // delegation depth is sent, so a resumed session yields the same record.
    if (count(header.delegationDepth) > 0) attrs['dsh.delegation_depth'] = header.delegationDepth;
    const time = Number.isFinite(header.createdAt) ? header.createdAt : Date.now();
    return { name: EVENTS.session, time, severity: 'info', attributes: attrs };
  }

  function chatAttributes(start, end) {
    const attrs = { 'gen_ai.operation.name': 'chat' };
    put(attrs, 'duration_ms', duration(end, start));
    return attrs;
  }

  const handlers = {
    'turn/start'(e, d) { if (count(d.turn) !== undefined) turns.set(d.turn, e.time); return []; },
    'turn/end'(e, d) {
      const reason = d.reason ?? {};
      const attrs = base(e, { 'dsh.turn.end_reason': text(reason.kind) ?? 'unknown' });
      put(attrs, 'duration_ms', duration(e.time, turns.get(d.turn)));
      turns.delete(d.turn);
      if (reason.kind === 'error') failureAttributes(attrs, reason.error);
      return [record(EVENTS.turn, e, attrs, reason.kind === 'error' ? 'error' : 'info')];
    },
    'step/start'(e, d) { steps.set(stepKey(d), e.time); return []; },
    'llm/retry-started'(e, d) { steps.set(stepKey(d), e.time); return []; },
    'request/context'(e, d) { route = { provider: text(d.provider), model: text(d.model) }; return []; },
    'assistant/message'(e, d) {
      const source = d.message?.source ?? {};
      const response = source.replayState?.response ?? {};
      const start = steps.get(stepKey(d)) ?? e.time;
      const attrs = base(e, chatAttributes(start, e.time));
      put(attrs, 'gen_ai.provider.name', text(source.provider) ?? route.provider);
      put(attrs, 'gen_ai.request.model', text(source.model) ?? route.model);
      put(attrs, 'gen_ai.response.model', text(response.responseModel));
      put(attrs, 'gen_ai.response.id', text(response.responseId));
      put(attrs, 'dsh.stop_reason', text(response.stopReason) ?? text(lastChunk(d.stream, 'finish')?.reason?.kind));
      put(attrs, 'dsh.api', text(response.api));
      put(attrs, 'dsh.time_to_first_token_ms', duration(firstTokenTime(d.stream), start));
      if (d.interrupted === true) attrs['dsh.interrupted'] = true;
      usageAttributes(attrs, d.usage ?? lastChunk(d.stream, 'usage')?.usage);
      return [record(EVENTS.chat, e, attrs)];
    },
    // A model attempt that committed no message (failed, retried, cancelled):
    // a model call that the Router also saw, reported with its error code.
    'assistant/attempt'(e, d) {
      const key = stepKey(d);
      const start = steps.get(key) ?? e.time;
      steps.set(key, e.time);
      const attrs = base(e, chatAttributes(start, e.time));
      put(attrs, 'gen_ai.provider.name', route.provider);
      put(attrs, 'gen_ai.request.model', route.model);
      const reason = lastChunk(d.stream, 'finish')?.reason;
      if (reason?.failure) failureAttributes(attrs, reason.failure);
      else attrs['error.type'] = text(reason?.kind) ?? 'incomplete';
      usageAttributes(attrs, lastChunk(d.stream, 'usage')?.usage);
      return [record(EVENTS.chat, e, attrs, reason?.kind === 'aborted' ? 'warn' : 'error')];
    },
    'tool/call'(e, d) {
      const callId = text(d.callId), name = text(d.name);
      if (!callId) return [];
      calls.set(callId, { name, time: e.time });
      return [];
    },
    'tool/result'(e, d) {
      const callId = text(d.message?.toolCallId);
      const call = callId ? calls.get(callId) : undefined;
      // Results without a call in this session are fork closers for calls of the parent.
      if (!call) return [];
      calls.delete(callId);
      const failed = d.message?.isError === true;
      const attrs = base(e, { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.call.id': callId, 'dsh.tool.success': !failed });
      put(attrs, 'gen_ai.tool.name', call.name);
      put(attrs, 'duration_ms', duration(e.time, call.time));
      const mcp = mcpParts(call.name);
      attrs['gen_ai.tool.type'] = mcp ? 'mcp' : 'function';
      if (mcp) { put(attrs, 'mcp.server.name', text(mcp.server)); put(attrs, 'mcp.tool.name', text(mcp.tool)); }
      if (failed) attrs['error.type'] = text(d.error?.code) ?? text(d.error?.name) ?? 'tool_error';
      return [record(EVENTS.tool, e, attrs, failed ? 'error' : 'info')];
    },
    // The parent's own record of a direct child. Which tool call started it is
    // not in the session log; the live spawn record carries that
    // (subagentStartRecord).
    'subagent/catalog'(e, d) {
      const child = text(d.childId === undefined ? undefined : String(d.childId));
      if (!child || children.has(child)) return [];
      children.add(child);
      const attrs = base(e, { 'child.session.id': child });
      put(attrs, 'dsh.subagent.mode', text(d.mode));
      return [record(EVENTS.spawn, e, attrs)];
    },
    // A restore (dsh --session-id, a reattached web/desktop session) appends an
    // unmarked end-seed; the fork seed's own end-seed is marked inherited.
    'session/end-seed'(e, d) {
      if (d.inherited === true) return [];
      return [record(EVENTS.resume, e, base(e, { 'fork.kind': 'resume', 'fork.point': String(e.seq), 'session.origin': sessionLinks(header, session.inheritedEventCount).origin }))];
    },
    // The child's own description of how it was started; never its label.
    'subagent/descriptor'(e, d) {
      const provider = text(d.provider);
      const attrs = base(e);
      put(attrs, 'agent.name', text(header.agentPreset) ?? (provider === 'fork' ? 'fork' : 'subagent'));
      put(attrs, 'dsh.subagent.provider', provider);
      put(attrs, 'dsh.subagent.mode', text(d.mode));
      return [record(EVENTS.descriptor, e, attrs)];
    },
    'compaction/start'(e, d) { if (text(d.compactionId)) compactions.set(d.compactionId, e.time); return []; },
    // The summarization request: a model call of its own.
    'compaction/summary'(e, d) {
      const attrs = base(e, chatAttributes(compactions.get(d.compactionId) ?? e.time, e.time));
      put(attrs, 'gen_ai.provider.name', text(d.provider));
      put(attrs, 'gen_ai.request.model', text(d.model));
      put(attrs, 'gen_ai.request.max_tokens', count(d.maxTokens));
      put(attrs, 'dsh.compaction.id', text(d.compactionId));
      put(attrs, 'dsh.compaction.shadowed_tokens', count(d.shadowedTokenCount));
      usageAttributes(attrs, d.usage);
      return [record(EVENTS.compactionChat, e, attrs)];
    },
    'compaction/end'(e, d) {
      const attrs = base(e);
      put(attrs, 'dsh.compaction.id', text(d.compactionId));
      put(attrs, 'duration_ms', duration(e.time, compactions.get(d.compactionId)));
      compactions.delete(d.compactionId);
      const failed = d.error !== undefined && d.error !== null;
      if (failed) attrs['error.type'] = 'compaction_failed';
      return [record(EVENTS.compaction, e, attrs, failed ? 'error' : 'info')];
    },
    'compaction/prune'(e, d) {
      return [record(EVENTS.prune, e, put(base(e), 'dsh.compaction.shadowed_tokens', count(d.shadowedTokenCount)))];
    },
    'llm/retry'(e, d) {
      const attrs = base(e);
      put(attrs, 'gen_ai.provider.name', text(d.provider));
      put(attrs, 'dsh.retry.number', count(d.retry));
      put(attrs, 'dsh.retry.delay_ms', count(d.delayMs));
      failureAttributes(attrs, d.failure);
      return [record(EVENTS.retry, e, attrs, 'warn')];
    },
  };

  return {
    sessionRecord,
    /** Map one canonical event { type, seq, time, data }; events at or before the last mapped seq are skipped. */
    map(event) {
      if (!event || !Number.isSafeInteger(event.seq) || event.seq <= lastSeq) return [];
      lastSeq = event.seq;
      const handler = handlers[event.type];
      return handler ? handler(event, event.data ?? {}) : [];
    },
    get lastSeq() { return lastSeq; },
  };
}

// `agent/error` on the live bus: the error class name only, never its message.
export function agentErrorRecord({ sessionId, turn, step, error, time = Date.now() }) {
  const attrs = { 'session.id': String(sessionId), 'agent.id': String(sessionId) };
  put(attrs, 'dsh.turn', count(turn));
  put(attrs, 'dsh.step', count(step));
  attrs['error.type'] = text(error instanceof Error ? error.name : undefined) ?? 'Error';
  return { name: EVENTS.agentError, time, severity: 'error', attributes: attrs };
}

// A child session announced while its parent was running a delegation tool
// call (lib/index.js runs each subagent tool execution in its own async
// context): the exact tool call that started the child. Live only — the
// session log never records it.
export function subagentStartRecord({ child, header = {}, inheritedEventCount, callId, toolName }) {
  const id = String(child);
  const links = sessionLinks(header, inheritedEventCount);
  const attrs = { 'session.id': id, 'agent.id': id, 'session.origin': links.origin };
  put(attrs, 'parent.session.id', links.parent);
  put(attrs, 'parent.agent.id', links.parent);
  put(attrs, 'spawn.tool_call.id', text(callId));
  put(attrs, 'dsh.subagent.tool', text(toolName));
  if (links.forkedFrom) { attrs['forked_from_session_id'] = links.forkedFrom; attrs['fork.kind'] = 'fork'; put(attrs, 'fork.point', links.forkPoint); }
  const time = Number.isFinite(header.createdAt) ? header.createdAt : Date.now();
  return { name: EVENTS.subagentStart, time, severity: 'info', attributes: attrs };
}
