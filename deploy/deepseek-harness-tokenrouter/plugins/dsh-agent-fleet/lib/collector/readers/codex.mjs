// Codex transcripts: <codex>/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl (also archived_sessions/).
//
// Rows are `{timestamp, ordinal, type, payload}`. Record id = thread id. A child thread's rollout opens with its own
// `session_meta` (parent_thread_id, thread_source "subagent", source.subagent.thread_spawn{agent_path, ...}), then a
// SECOND `session_meta` repeating the parent's, then a copy of the parent's history: every row with
// `ordinal < subagent_history_start_ordinal`. Only the first meta and the rows after the copy describe this thread.
//
// Usage: `token_count.info.total_token_usage` is cumulative and counts cached/cache-write tokens inside
// `input_tokens`; each model event carries the growth since the previous token_count, split into
// input (uncached) / cacheRead / cacheWrite / output / reasoning like the other kinds.
import { Session, makeReader, parseJson, partsText, toMs, clip, isAcpProbe } from "./base.mjs";

export const kind = "codex";

const ROLLOUT = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const INJECTED_USER = /^\s*(?:<environment_context>|<user_instructions>|<INSTRUCTIONS>|<turn_aborted>|<user_action>|# AGENTS\.md)/;
const USAGE_KEYS = ["input", "output", "cacheRead", "cacheWrite", "reasoning"];
const DUPLICATE_PROMPT_MS = 5000;

/** @returns {{kind: "codex", id: string, role: "main"} | null}  the role is refined from the rollout's own header */
export function match(path) {
  if (typeof path !== "string") return null;
  const found = ROLLOUT.exec(path.split("/").pop());
  return found ? { kind, id: found[1], role: "main" } : null;
}

function normalizeUsage(u) {
  const cached = u.cached_input_tokens ?? 0, written = u.cache_write_input_tokens ?? 0;
  return {
    input: Math.max(0, (u.input_tokens ?? 0) - cached - written), output: u.output_tokens ?? 0,
    cacheRead: cached, cacheWrite: written, reasoning: u.reasoning_output_tokens ?? 0,
  };
}

export function createReader({ file, host, site, now }) {
  const m = match(file) ?? { id: file.split("/").pop().replace(/\.jsonl$/, ""), role: "main" };
  const s = new Session({ kind, file, host, site, id: m.id, role: m.role, now });
  let metaSeen = false;
  let replayUntil = null;   // ordinals below this are the parent's history
  let selfPath = "/root";   // this agent's path: agent_message rows addressed to it are incoming messages
  let previous = {};        // cumulative usage at the previous token_count
  let pendingText = "";     // latest assistant text, attached to the next model event
  let lastPrompt = null;    // {head, t}: the same prompt arrives as a response item and as an item_completed
  let inputAt = null;       // when the model last received input

  const meta = (p, t) => {
    if (metaSeen) return;
    metaSeen = true;
    s.setStart(toMs(p.timestamp) ?? t);
    s.set({ cwd: p.cwd, version: p.cli_version, provider: p.model_provider });
    if (isAcpProbe(p.cwd)) { s.setRole("probe"); return; } // the adapter's model-catalogue probe: no parent, no work
    if (Number.isFinite(p.subagent_history_start_ordinal)) replayUntil = p.subagent_history_start_ordinal;
    const spawn = p.source?.subagent?.thread_spawn;
    const subagent = p.thread_source === "subagent" || (p.source && typeof p.source === "object" && "subagent" in p.source);
    const parentId = spawn?.parent_thread_id ?? p.parent_thread_id;
    if (subagent) {
      const agentPath = spawn?.agent_path ?? p.agent_path;
      if (typeof agentPath === "string") selfPath = agentPath;
      s.setRole("subagent");
      s.set({
        name: typeof agentPath === "string" ? agentPath.split("/").pop() : p.agent_nickname ?? (typeof p.source?.subagent === "string" ? p.source.subagent : undefined),
        description: [p.agent_nickname, agentPath].filter(Boolean).join(" · "),
      });
      if (parentId) s.setParent({ kind, id: parentId, via: "file", exact: true });
    } else if (p.forked_from_id) {
      s.setRole("fork");
      s.setParent({ kind, id: p.forked_from_id, via: "file", exact: true });
    }
  };

  const prompt = (t, text) => {
    const head = clip(text);
    if (!head || INJECTED_USER.test(text)) return;
    if (lastPrompt && lastPrompt.head === head && Math.abs(t - lastPrompt.t) < DUPLICATE_PROMPT_MS) return;
    lastPrompt = { head, t };
    inputAt = t;
    s.turnStart(t);
    s.user(t, text);
  };

  const tokenCount = (p, t) => {
    const total = p.info?.total_token_usage;
    if (!total) return;
    const now = normalizeUsage(total);
    const reset = USAGE_KEYS.some(key => now[key] < (previous[key] ?? 0)); // a restarted counter is fresh usage
    const delta = {};
    let grew = false;
    for (const key of USAGE_KEYS) {
      const d = now[key] - (reset ? 0 : previous[key] ?? 0);
      if (d > 0) { delta[key] = d; grew = true; }
    }
    previous = now;
    if (grew) {
      // the request started when its last input (prompt, tool output, incoming message) arrived
      const start = inputAt !== null && inputAt <= t ? inputAt : t;
      s.model(start, { duration: t - start, usage: delta, model: s.info.model, text: pendingText });
      pendingText = ""; inputAt = t;
    }
    s.setContext(p.info.last_token_usage?.input_tokens, p.info.model_context_window);
  };

  const item = (it, t) => {
    if (it?.type === "UserMessage") prompt(t, partsText(it.content));
    // Only the spawn call's own activity row names its child; rows about siblings or the parent share the item type.
    else if (it?.type === "SubAgentActivity" && it.agent_thread_id && s.spawns.has(it.id)) s.setChildren(it.id, [it.agent_thread_id]);
  };

  const eventMsg = (p, t) => {
    switch (p.type) {
      case "task_started": s.turnStart(t); s.setContext(undefined, p.model_context_window); break;
      case "task_complete":
        if (p.error) { s.error(t, p.error.message ?? "turn failed"); s.turnEnd(t, "error"); } else s.turnEnd(t, "done");
        break;
      case "turn_aborted": s.turnEnd(t, "interrupted"); break;
      case "token_count": tokenCount(p, t); break;
      case "item_completed": item(p.item, t); break;
      case "user_message": prompt(t, p.message); break;
      case "exec_command_end": s.toolEnd(t, p.call_id, { exitCode: p.exit_code }); break;
      case "thread_settings_applied": s.set({ model: p.thread_settings?.model, effort: p.thread_settings?.reasoning_effort }); break;
      default: break;
    }
  };

  const toolOutput = (p, t) => {
    const text = typeof p.output === "string" ? p.output : partsText(p.output);
    const head = text.slice(0, 600);
    const code = /Process exited with code (-?\d+)/.exec(head)?.[1] ?? parseJson(text)?.metadata?.exit_code;
    let childIds;
    if (s.spawns.has(p.call_id)) {
      const spawned = parseJson(text);
      const id = spawned?.agent_thread_id ?? spawned?.thread_id ?? spawned?.agent_id;
      if (typeof id === "string") childIds = [id];
    }
    inputAt = t;
    s.toolEnd(t, p.call_id, { exitCode: code === undefined ? undefined : Number(code), text: head, childIds });
  };

  const message = (p, t) => {
    if (p.role === "assistant") {
      const text = partsText(p.content);
      if (text) pendingText = text;
    } else if (p.role === "user") {
      const kinds = p.internal_chat_message_metadata_passthrough?.content_item_kinds;
      if (!Array.isArray(kinds)) { prompt(t, partsText(p.content)); return; }
      const parts = Array.isArray(p.content) && p.content.length === kinds.length ? p.content.filter((_, i) => kinds[i] === "user.text") : [];
      if (parts.length > 0) prompt(t, partsText(parts));
    }
  };

  const responseItem = (p, t) => {
    switch (p.type) {
      case "function_call": s.toolStart(t, { id: p.call_id, name: p.name, input: parseJson(p.arguments) ?? p.arguments }); break;
      case "custom_tool_call": s.toolStart(t, { id: p.call_id, name: p.name, input: p.input }); break;
      case "function_call_output": case "custom_tool_call_output": case "tool_search_output": toolOutput(p, t); break;
      case "tool_search_call": s.toolStart(t, { id: p.call_id, name: "tool_search", input: p.arguments }); break;
      case "web_search_call": {
        const id = p.id ?? s.nextId("tool");
        const query = p.action?.query ?? p.action?.queries?.join("; ");
        s.toolStart(t, { id, name: "web_search", input: { query } });
        s.toolEnd(t, id, { isError: p.status === "failed" });
        break;
      }
      case "message": message(p, t); break;
      case "agent_message":
        if (p.recipient === undefined || p.recipient === selfPath) {
          inputAt = t;
          s.turnStart(t); // a message from another agent wakes this one
          s.message(t, { peer: p.author, text: partsText(p.content) });
        }
        break;
      default: break; // reasoning, additional_tools, ...
    }
  };

  const handle = o => {
    const p = o.payload ?? {};
    const t = toMs(o.timestamp);
    s.replay = replayUntil !== null && Number.isFinite(o.ordinal) && o.ordinal < replayUntil;
    s.touch(t);
    switch (o.type) {
      case "session_meta": meta(p, t); break;
      case "turn_context": s.set({ model: p.model, effort: p.effort }); break;
      case "event_msg": eventMsg(p, t); break;
      case "response_item": responseItem(p, t); break;
      case "compacted": s.compaction(t, { text: p.message }); break;
      default: break; // world_state, token_usage_record, inter_agent_communication_metadata, ...
    }
  };

  return makeReader(s, handle, o => toMs(o.timestamp));
}
