// Oh My Pi (OMP) transcripts.
//
//   <sessions>/[<cwd-slug>/]<ts>_<uuid>.jsonl                    main session (the slug directory is optional)
//   <sessions>/[<cwd-slug>/]<ts>_<uuid>/<Task>.jsonl             its subagents (job ids are free-form task names)
//   <sessions>/[<cwd-slug>/]<ts>_<uuid>/<Task>/<Task.Sub>.jsonl  nested subagents: every level is <parent>.<name>
//
// Line 1 is a padded `title` row that OMP rewrites in place (the collector re-feeds it); line 2 the `session`
// header. Record ids: the uuid for a main session, `<uuid>/<job id>` for a subagent. A subagent's parent comes from
// its path: forks copy the whole artifact directory, so the header's `parentSession` can name the original instead.
import { Session, makeReader, partsText, splitModel, toMs, clip, isAcpProbe, withinCountLimit } from "./base.mjs";

export const kind = "omp";

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const FORK_SLACK_MS = 1000;
const NOTIFY_TURNS = new Set(["irc:incoming", "async-result", "goal-continuation"]); // injected messages that wake the model

/** @returns {{kind: "omp", id: string, role: "main"|"subagent", parentFile?: string} | null} */
export function match(path) {
  if (typeof path !== "string" || !path.endsWith(".jsonl")) return null;
  const parts = path.split("/");
  const stem = parts.at(-1).slice(0, -".jsonl".length);
  if (stem === "" || stem.startsWith(".")) return null;
  const own = STAMP.exec(stem);
  if (own) return { kind, id: own[1], role: "main" };
  for (let i = parts.length - 2; i >= 0; i--) {
    const session = STAMP.exec(parts[i]);
    if (!session) continue;
    const chain = parts.slice(i + 1, -1);
    if (!nested(chain, stem)) return null;
    const parentStem = chain.at(-1);
    const parentFile = parentStem === undefined
      ? `${parts.slice(0, i + 1).join("/")}.jsonl`
      : [...parts.slice(0, i + 1), ...chain.slice(0, -1), `${parentStem}.jsonl`].join("/");
    return { kind, id: `${session[1]}/${stem}`, role: "subagent", parentFile };
  }
  return null;
}

/** Every directory level is named after the subagent that owns it: `A/A.B/A.B.C.jsonl`. */
function nested(chain, stem) {
  let parent = null;
  for (const name of [...chain, stem]) {
    if (parent !== null && !name.startsWith(`${parent}.`)) return false;
    parent = name;
  }
  return true;
}

// Result-derived line counts (Contract A): OMP writes the rows it returned and the +/- rows of an edit into
// `details`, which is exact; a write result carries no count (the argument's content is already exact).
const DIFF_ADDED = /^\+\d+\|/;
const DIFF_REMOVED = /^-\d+\|/;

/** `{path?, added, removed}` of one edit diff, or undefined when the result shows no rows (nothing to replace with). */
function diffFileLines(path, diff) {
  if (typeof diff !== "string" || diff === "" || !withinCountLimit(diff)) return undefined;
  let added = 0, removed = 0;
  for (const row of diff.split("\n")) {
    if (DIFF_ADDED.test(row)) added++;
    else if (DIFF_REMOVED.test(row)) removed++;
  }
  return { ...(typeof path === "string" && path ? { path } : {}), added, removed };
}

/**
 * Line counts of an OMP tool result: a read counts the numbered rows in `displayContent.lineNumbers` (null marks an
 * elided gap; a directory has none), a multi-file edit carries one diff per file, a single-file edit one path + diff.
 */
function ompFileLines(details) {
  if (!details || typeof details !== "object" || details.isDirectory === true) return undefined;
  if (Array.isArray(details.displayContent?.lineNumbers)) {
    return [{ read: details.displayContent.lineNumbers.filter(Number.isInteger).length }];
  }
  if (Array.isArray(details.perFileResults)) {
    const entries = details.perFileResults.map(result => diffFileLines(result?.path, result?.diff)).filter(Boolean);
    return entries.length > 0 ? entries : undefined;
  }
  const single = diffFileLines(details.path, details.diff);
  return single ? [single] : undefined;
}

export function createReader({ file, host, site, now }) {
  const m = match(file) ?? { id: file.split("/").pop().replace(/\.jsonl$/, ""), role: "main" };
  const s = new Session({ kind, file, host, site, id: m.id, role: m.role, now });
  const [rootId, stem] = m.id.split("/");
  let forkCutoff = null; // fork: rows older than the header are history copied from the parent

  if (m.role === "subagent") {
    const parentStem = m.parentFile.split("/").pop().slice(0, -".jsonl".length);
    s.set({ name: stem });
    s.setParent({
      kind, id: STAMP.test(parentStem) ? rootId : `${rootId}/${parentStem}`, file: m.parentFile, via: "file", exact: true,
    });
  }

  /** Record ids of the children a `task` call started, in call order (job ids already carry the parent prefix). */
  const taskChildren = details => {
    const list = details?.results?.length ? details.results : details?.progress;
    if (!Array.isArray(list)) return undefined;
    return [...list].sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0)).map(job => (typeof job?.id === "string" ? `${rootId}/${job.id}` : undefined));
  };

  const assistant = (o, t) => {
    const msg = o.message, u = msg.usage ?? {};
    s.turnStart(t);
    let text = "";
    const calls = [];
    for (const block of msg.content ?? []) {
      if (block.type === "text" && block.text) text += (text ? "\n" : "") + block.text;
      else if (block.type === "toolCall") calls.push(block);
    }
    const start = toMs(msg.timestamp) ?? t;
    s.model(start, {
      duration: msg.duration, ttft: msg.ttft, model: msg.model, provider: msg.provider, text,
      usage: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite },
      cost: u.cost?.total,
    });
    for (const call of calls) s.toolStart(t, { id: call.id, name: call.name, input: call.arguments });
    switch (msg.stopReason) {
      case "toolUse": break;
      case "error":
        s.error(t, msg.errorMessage ?? "model error");
        if (!(msg.retryRecovery?.status === "recovered" || msg.retryRecovery?.supersededBy)) s.turnEnd(t, "error"); // an auto-retry continues the turn
        break;
      case "aborted": s.turnEnd(t, "interrupted"); break;
      default: s.turnEnd(t, "done");
    }
  };

  const handle = o => {
    if (o.type === "title") { s.replay = false; s.set({ title: o.title }); return; } // re-fed whenever OMP rewrites line 1
    const t = toMs(o.timestamp);
    s.replay = o.type !== "session" && forkCutoff !== null && t !== null && t < forkCutoff;
    s.touch(t);
    switch (o.type) {
      case "session":
        s.setStart(t);
        s.set({ cwd: o.cwd, title: o.title });
        if (isAcpProbe(o.cwd)) { s.setRole("probe"); break; } // the adapter's model-catalogue probe: no parent, no work
        if (m.role === "main" && o.parentSession) {
          const parent = match(o.parentSession);
          s.setRole("fork");
          s.setParent({ kind, id: parent?.id ?? o.parentSession, ...(o.parentSession.includes("/") && { file: o.parentSession }), via: "file", exact: true });
          if (t !== null) forkCutoff = t - FORK_SLACK_MS;
        }
        break;
      case "model_change": {
        const { provider, model, effort } = splitModel(o.model);
        s.set({ provider, model, effort, version: o.runtime?.version });
        break;
      }
      case "thinking_level_change": s.set({ effort: o.thinkingLevel }); break;
      case "session_init":
        if (typeof o.task === "string") s.set({ description: `${typeof o.agent === "string" ? `${o.agent}: ` : ""}${clip(o.task, 140)}` });
        break;
      case "title_change": s.set({ title: o.title }); break;
      case "message": {
        const msg = o.message;
        if (!msg) break;
        if (msg.role === "user") { s.turnStart(t); s.user(t, partsText(msg.content)); }
        else if (msg.role === "assistant") assistant(o, t);
        else if (msg.role === "toolResult") {
          const full = partsText(msg.content);
          s.toolEnd(Number.isFinite(msg.timestamp) ? msg.timestamp : t, msg.toolCallId, {
            isError: msg.isError, exitCode: msg.details?.exitCode, text: full, resultText: full,
            fileLines: ompFileLines(msg.details),
            childIds: msg.toolName === "task" ? taskChildren(msg.details) : undefined,
          });
        }
        break;
      }
      case "custom_message":
        if (NOTIFY_TURNS.has(o.customType)) s.turnStart(t);
        if (o.customType === "irc:incoming") s.message(t, { peer: o.details?.from, text: o.details?.message ?? o.content });
        break;
      case "custom":
        if (o.customType === "session_exit") s.exit(t);
        break;
      case "model_usage": {
        const u = o.usage ?? {};
        s.addUsage({ input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite }, u.cost?.total);
        break;
      }
      case "compaction": s.compaction(t, { text: o.shortSummary ?? o.summary }); break;
      default: break; // thinking/service-tier/mode changes, digests, todo state, ttsr injections
    }
  };

  return makeReader(s, handle, o => toMs(o.timestamp));
}
