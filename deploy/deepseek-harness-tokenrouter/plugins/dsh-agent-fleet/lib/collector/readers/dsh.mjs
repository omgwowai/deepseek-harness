// DeepSeek Harness (DSH) transcripts: <dsh>/sessions/--<cwd-slug>--/<id>/session.v4.jsonl.zstd (older sessions:
// session.jsonl.zstd). The directory name is the record id: `session-<uuid>` for top-level sessions, a bare `<uuid>`
// for subagents, `session-dsh-acp-<hash>` for the projection of an ACP agent's subagent. The same layout appears under
// `harness-home/sessions` of container runs (slug `--work--`, bare ids), so nothing here depends on the root.
//
// Rows are `{type, seq, time, data}`. A header row `{type:"session", id, createdAt, cwd, parentSession?, origin?,
// isSeeded?}` comes first; a seeded session (a fork) carries a copy of its parent's rows up to `session/end-seed`.
// `parentSession` names the parent by directory name (with its `session-` prefix when it has one).
import { existsSync } from "node:fs";
import { Session, makeReader, parseJson, partsText, sampleText, exitCodeFromText, clip, withinCountLimit } from "./base.mjs";

export const kind = "dsh";

const CURRENT = "session.v4.jsonl.zstd";
const LEGACY = "session.jsonl.zstd";
const SPAWNED_ID = /started subagent ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const AGENT_NOTICES = new Set(["agent-message", "subagent-settled", "subagent-report"]);

// Result-derived line counts (Contract A). DSH 0.2.x writes the structured result next to the text: a read's
// `meta.lines` holds the rows it returned and an edit's `meta.diffs` the replaced text of each file, which is exact.
// Results without `meta` fall back to the text: a read that returns a `[path#TAG]` header (the tag is a content hash,
// not file content) followed by the rows as `N:`, where an elided gap is a line holding only `…`. That header path is
// often relative or a URL, so its count is carried without a path and lands on the call's single file target.
const READ_HEADER = /^\[[^\]\n]+#[0-9A-Fa-f]{2,8}\]$/;
const READ_ROW = /^\d+:/;

/** `[{read}]` when `text` is a read listing (numbered rows after the header), else undefined. */
function dshFileLines(text) {
  if (!withinCountLimit(text)) return undefined;
  let header = false, read = 0;
  for (const row of text.split("\n")) {
    if (!header) {
      if (row.trim() === "") continue;
      if (!READ_HEADER.test(row.trim())) return undefined;
      header = true;
    } else if (READ_ROW.test(row)) read++;
  }
  return read > 0 ? [{ read }] : undefined;
}

/** Rows of a text with the line semantics of `countLines`: one final "\n" ends the last row, it adds no row. */
const rowsOf = text => (text === "" ? [] : (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n"));

/** Lines that differ between two texts once their common leading and trailing lines are set aside. */
function changedLines(before, after) {
  const a = rowsOf(before), b = rowsOf(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return { added: b.length - head - tail, removed: a.length - head - tail };
}

/** `fileLines` entries from a result's `meta`: `{path?, read}` for a read, `{path?, added, removed}` per edited file. */
function metaFileLines(meta) {
  if (meta === null || typeof meta !== "object") return undefined;
  const own = typeof meta.path === "string" && meta.path !== "" ? meta.path : undefined;
  const out = [];
  if (Array.isArray(meta.lines)) out.push({ ...(own && { path: own }), read: meta.lines.length });
  if (Array.isArray(meta.diffs)) {
    const byPath = new Map();
    for (const diff of meta.diffs) {
      if (diff === null || typeof diff !== "object" || typeof diff.oldText !== "string" || typeof diff.newText !== "string") continue;
      if (!withinCountLimit(diff.oldText) || !withinCountLimit(diff.newText)) continue;
      const path = typeof diff.path === "string" && diff.path !== "" ? diff.path : own;
      const { added, removed } = changedLines(diff.oldText, diff.newText);
      const sum = byPath.get(path) ?? { added: 0, removed: 0 };
      sum.added += added;
      sum.removed += removed;
      byPath.set(path, sum);
    }
    for (const [path, sum] of byPath) out.push({ ...(path && { path }), ...sum });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * @returns {{kind: "dsh", id: string, role: "main"|"projection"} | null}
 * A legacy `session.jsonl.zstd` next to a `session.v4.jsonl.zstd` is the pre-migration copy of the same session: null.
 */
export function match(path) {
  if (typeof path !== "string") return null;
  const parts = path.split("/");
  const name = parts.at(-1), id = parts.at(-2);
  if ((name !== CURRENT && name !== LEGACY) || !id) return null;
  if (name === LEGACY && existsSync([...parts.slice(0, -1), CURRENT].join("/"))) return null;
  return { kind, id, role: id.startsWith("session-dsh-acp-") ? "projection" : "main" };
}

export function createReader({ file, host, site, now }) {
  const m = match(file) ?? { id: file.split("/").at(-2) ?? file, role: "main" };
  const s = new Session({ kind, file, host, site, id: m.id, role: m.role, now });
  let seeded = false, seedDone = false;
  let stepStart = null, stepNumber = null, lastPromptT = null;
  let modelFromReply = false; // the model named by a response beats the one named by request headers

  const header = row => {
    s.setStart(row.createdAt);
    s.touch(row.createdAt);
    s.set({ cwd: row.cwd });
    seeded = row.isSeeded === true;
    if (m.role === "main") {
      if (row.origin === "subagent") s.setRole("subagent");
      else if (seeded && row.parentSession) s.setRole("fork");
    }
    if (typeof row.parentSession === "string" && row.parentSession) s.setParent({ kind, id: row.parentSession, via: "file", exact: true });
  };

  const modelHint = (provider, model, effort) => {
    s.set({ provider, effort, ...(!modelFromReply && { model }) });
  };

  const assistant = (d, t) => {
    const msg = d.message ?? {}, src = msg.source ?? {}, u = d.usage ?? {};
    let text = "";
    for (const block of msg.content ?? []) if (block?.type === "text" && block.text) text += (text ? "\n" : "") + block.text;
    // step/start is logged before the prompt of the first step: the request starts when both exist
    const start = stepStart !== null && d.step === stepNumber ? Math.max(stepStart, lastPromptT ?? 0) : t;
    const first = Math.min(...(d.stream ?? []).map(chunk => chunk?.time0).filter(Number.isFinite));
    if (src.model) modelFromReply = true;
    s.model(start, {
      duration: t - start, ttft: Number.isFinite(first) && first >= start ? first - start : undefined,
      model: src.model, provider: src.provider, text,
      usage: { input: u.inputTokens, output: u.outputTokens, cacheRead: u.cacheReadTokens, cacheWrite: u.cacheWriteTokens, reasoning: u.reasoningTokens },
    });
  };

  const userMessage = (d, t) => {
    const source = d.source ?? {}, text = partsText(d.content);
    if (source.kind === "user") { lastPromptT = t; s.user(t, text); }
    else if (AGENT_NOTICES.has(source.kind)) { lastPromptT = t; s.message(t, { peer: source.senderSessionId, text: source.summary ?? text }); }
  };

  const toolResult = (d, t) => {
    const msg = d.message ?? {};
    const full = partsText(msg.content);
    const text = sampleText(full);
    const spawned = SPAWNED_ID.exec(text.slice(0, 200))?.[1];
    s.toolEnd(t, msg.toolCallId, {
      isError: msg.isError === true, exitCode: exitCodeFromText(text.slice(0, 600)), text,
      resultText: full, fileLines: metaFileLines(d.meta) ?? dshFileLines(full),
      childIds: spawned ? [spawned] : undefined,
    });
  };

  const turnEnd = (d, t) => {
    const reason = d.reason ?? {};
    if (reason.kind === "error") { s.error(t, reason.error?.message ?? "turn failed"); s.turnEnd(t, "error"); }
    else if (reason.kind === "aborted" || reason.kind === "interrupted") s.turnEnd(t, "interrupted");
    else s.turnEnd(t, "done");
  };

  const handle = row => {
    if (row.type === "session") { header(row); return; }
    const d = row.data ?? {}, t = Number.isFinite(row.time) ? row.time : null;
    s.replay = seeded && !seedDone;
    s.touch(t);
    switch (row.type) {
      case "session/end-seed": seedDone = true; break;
      case "turn/start": s.turnStart(t); break;
      case "turn/end": turnEnd(d, t); break;
      case "step/start": stepStart = t; stepNumber = d.step; break;
      case "user/message": userMessage(d, t); break;
      case "assistant/message": assistant(d, t); break;
      case "tool/call": s.toolStart(t, { id: d.callId, name: d.name, input: parseJson(d.arguments) ?? d.arguments }); break;
      case "tool/result": toolResult(d, t); break;
      case "approval/asked": s.approvalAsked(d.id, d.toolName); break;
      case "approval/decided": s.approvalDecided(d.id); break;
      case "subagent/catalog": s.adoptChild(t, { id: d.childId, name: d.label, preview: d.label }); break;
      case "tool-workflow/agent-start": s.adoptChild(t, { id: d.childId, name: d.label, preview: d.label }); break;
      case "subagent/descriptor": s.set({ name: d.label, provider: d.agentProvider, model: d.agentModel, effort: d.agentReasoningEffort }); break;
      case "model/selection": modelHint(d.provider, d.model); break;
      case "request/header": modelHint(d.header?.config?.provider, d.header?.config?.model, d.header?.config?.reasoningEffort); break;
      case "request/context": s.setContext(undefined, d.contextWindow); break;
      case "session/title": s.set({ title: d.title }); break;
      case "compaction/summary": s.compaction(t, { text: partsText(d.summary) }); break;
      case "llm/retry": s.error(t, `retry ${d.retry}/${d.maxRetries} ${d.failure?.code ?? ""} ${clip(d.failure?.message, 160)}`.trim()); break;
      default: break; // step/end, chunks, permissions, sandbox, jobs, todos, goals, teams, plugins, ...
    }
  };

  return makeReader(s, handle, row => row.time);
}
