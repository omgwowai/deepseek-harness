// Claude Code transcripts.
//
//   <projects>/<cwd-slug>/<sessionId>.jsonl                               main session
//   <projects>/<cwd-slug>/<sessionId>/subagents/agent-<agentId>.jsonl     subagent (+ agent-<agentId>.meta.json)
//
// Record ids: the session id, or `<sessionId>/<agentId>` for a subagent. Nested subagents (spawnDepth ≥ 2) sit flat
// in the same `subagents/` directory; the meta file's `parentAgentId` says which subagent owns them. Older builds
// write no `toolUseId` into the meta file: the parent's `Agent` tool result (`toolUseResult.agentId`) names the child.
// A forked session starts with copies of the parent's rows (marked `forkedFrom`): history, not activity.
// Subagent files write `stop_reason: null` on most rows, so a text-only response without a stop reason only ends the
// turn provisionally (see Session.provisionalEnd).
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Session, makeReader, partsText, sampleText, exitCodeFromText, toMs, clip } from "./base.mjs";

export const kind = "claude";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INJECTED = /^\s*<(?:system-reminder|local-command-|command-name|command-message|command-args|bash-input|bash-stdout|bash-stderr)/;
const META_TRIES = 5;

/** @returns {{kind: "claude", id: string, role: "main"|"subagent", parentFile?: string} | null} */
export function match(path) {
  if (typeof path !== "string" || !path.endsWith(".jsonl")) return null;
  const parts = path.split("/");
  const stem = parts.at(-1).slice(0, -".jsonl".length);
  if (UUID.test(stem)) return parts.at(-2) === "subagents" ? null : { kind, id: stem, role: "main" };
  const agent = /^agent-([0-9a-z]+)$/i.exec(stem);
  const sid = parts.at(-3);
  if (agent && parts.at(-2) === "subagents" && sid !== undefined && UUID.test(sid)) {
    return { kind, id: `${sid}/${agent[1]}`, role: "subagent", parentFile: [...parts.slice(0, -3), `${sid}.jsonl`].join("/") };
  }
  return null;
}

/** The human's words in a user row: injected reminders, slash-command echoes and the like are not prompts. */
function promptText(content) {
  if (typeof content === "string") return INJECTED.test(content) ? "" : content;
  if (!Array.isArray(content)) return "";
  return content.filter(b => b?.type === "text" && typeof b.text === "string" && !INJECTED.test(b.text)).map(b => b.text).join("\n");
}

const tag = (text, name) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(text)?.[1]?.trim();

export function createReader({ file, host, site, now }) {
  const m = match(file) ?? { id: file.split("/").pop().replace(/\.jsonl$/, ""), role: "main" };
  const s = new Session({ kind, file, host, site, id: m.id, role: m.role, now });
  const [sid] = m.id.split("/");
  let meta = null, metaTries = 0;
  let lastUserTs = null;      // when the request for the next response began
  let current = null;         // the model response whose rows are being read: {key, event}
  let customTitle = false;
  let forkParentSet = false;

  const parentHint = () => {
    const nestedIn = meta?.parentAgentId;
    return {
      kind, id: nestedIn ? `${sid}/${nestedIn}` : sid,
      file: nestedIn ? `${dirname(file)}/agent-${nestedIn}.jsonl` : m.parentFile,
      via: "file", exact: true, ...(meta?.toolUseId && { toolCallId: meta.toolUseId }),
    };
  };
  if (m.role === "subagent") s.setParent(parentHint());

  const loadMeta = () => {
    if (m.role !== "subagent" || meta || metaTries >= META_TRIES) return;
    metaTries += 1;
    try { meta = JSON.parse(readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf8")); } catch { return; }
    s.set({ name: meta.agentType, description: meta.description, title: meta.description });
    s.setParent(parentHint());
  };
  loadMeta();

  const toolResult = (block, o, t) => {
    const text = sampleText(block.content);
    const agentId = o.toolUseResult?.agentId;
    s.toolEnd(t, block.tool_use_id, {
      isError: block.is_error === true, exitCode: exitCodeFromText(text.slice(0, 200)), text,
      childIds: typeof agentId === "string" ? [`${sid}/${agentId}`] : undefined,
    });
  };

  const user = (o, t) => {
    if (t !== null) lastUserTs = t;
    if (o.isMeta || o.isCompactSummary) return;
    const content = o.message?.content;
    let isResult = false;
    if (Array.isArray(content)) {
      for (const block of content) if (block?.type === "tool_result") { isResult = true; toolResult(block, o, t); }
    }
    if (isResult) return;
    const raw = typeof content === "string" ? content : partsText(content);
    if (o.origin?.kind === "task-notification" || raw.startsWith("<task-notification>")) {
      s.turnStart(t); // a finished background task wakes the model
      s.message(t, { peer: tag(raw, "task-id") ?? o.origin?.runId, text: tag(raw, "summary") ?? raw });
      return;
    }
    const text = promptText(content);
    if (!text) return;
    if (text.startsWith("[Request interrupted by user")) { s.turnEnd(t, "interrupted"); return; }
    s.turnStart(t);
    s.user(t, text);
  };

  const assistant = (o, t) => {
    const msg = o.message;
    if (!msg) return;
    const key = msg.id ?? o.uuid;
    const sameResponse = current !== null && current.key === key; // another row of the response already read
    if (sameResponse) s.resumeTurn(t); else s.turnStart(t);
    if (msg.model === "<synthetic>") { // locally generated placeholder (API error text, "no response requested")
      if (o.isApiErrorMessage) { s.error(t, partsText(msg.content)); s.turnEnd(t, "error"); } else s.turnEnd(t, "done");
      return;
    }
    let text = "";
    const calls = [];
    for (const block of msg.content ?? []) {
      if (block?.type === "text" && block.text) text += (text ? "\n" : "") + block.text;
      else if (block?.type === "tool_use") calls.push(block);
    }
    const u = msg.usage ?? {};
    const usage = {
      input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens,
      cacheWrite: u.cache_creation_input_tokens, reasoning: u.output_tokens_details?.thinking_tokens,
    };
    if (sameResponse) s.continueModel(current.event, t, { usage, text });
    else {
      const start = Math.min(lastUserTs ?? t, t);
      current = { key, event: s.model(start, { duration: t - start, model: msg.model, usage, text }) };
    }
    for (const call of calls) s.toolStart(t, { id: call.id, name: call.name, input: call.input });
    switch (msg.stop_reason) {
      case "end_turn": case "stop_sequence": case "max_tokens": case "pause_turn": s.turnEnd(t, "done"); break;
      case "refusal": s.error(t, "model refusal"); s.turnEnd(t, "error"); break;
      case "tool_use": break;
      default: if (text && calls.length === 0) s.provisionalEnd(t); // no stop reason on the row: final unless more follows
    }
  };

  const system = (o, t) => {
    switch (o.subtype) {
      case "api_error": {
        const retry = o.retryAttempt === undefined ? "" : ` (retry ${o.retryAttempt}/${o.maxRetries})`;
        s.error(t, `${o.error?.formatted ?? o.error?.message ?? "API error"}${retry}`);
        if (o.maxRetries !== undefined && o.retryAttempt >= o.maxRetries) s.turnEnd(t, "error");
        break;
      }
      case "model_refusal_no_fallback": s.error(t, "model refusal, no fallback"); s.turnEnd(t, "error"); break;
      case "compact_boundary": {
        const c = o.compactMetadata ?? {};
        s.compaction(t, { text: `${c.trigger ?? "auto"}: ${c.preTokens ?? "?"} → ${c.postTokens ?? "?"} tokens` });
        break;
      }
      case "turn_duration": if (s.turn.open) s.turnEnd(t, "done"); break;
      default: break;
    }
  };

  const handle = o => {
    loadMeta();
    const t = toMs(o.timestamp);
    s.replay = Boolean(o.forkedFrom);
    if (s.replay && !forkParentSet && m.role === "main" && o.forkedFrom.sessionId) {
      forkParentSet = true;
      s.setRole("fork");
      s.setParent({ kind, id: o.forkedFrom.sessionId, via: "file", exact: true });
    }
    s.touch(t);
    if (o.cwd) s.set({ cwd: o.cwd });
    if (o.version) s.set({ version: o.version });
    switch (o.type) {
      case "user": user(o, t); break;
      case "assistant": assistant(o, t); break;
      case "system": system(o, t); break;
      case "attachment":
        if (o.attachment?.type === "queued_command" && o.attachment.origin?.kind !== "task-notification") s.user(t, promptText(o.attachment.prompt)); // steering message sent mid-turn
        break;
      case "ai-title": if (!customTitle) s.set({ title: o.aiTitle }); break;
      case "custom-title": customTitle = true; s.set({ title: o.customTitle }); break;
      case "summary": if (!customTitle) s.set({ title: clip(o.summary, 120) }); break; // pre-ai-title builds
      case "cost-state": s.setCost(o.totalCostUSD); break;
      case "continued-in": s.exit(t); break;
      default: break; // queue-operation, file-history, mode, permission-mode, last-prompt, ...
    }
  };

  return makeReader(s, handle, o => toMs(o.timestamp));
}
