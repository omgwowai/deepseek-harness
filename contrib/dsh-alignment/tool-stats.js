// Tool-call anomalies of one session, for the alignment page's 待验收 round detail (2026-10-24):
//   GET /alignment/tools?sid=<sid>[&from=<ISO>&to=<ISO>]
//   200 {ok, api, sid, calls, ms, subagents, baseline: {builtAt, from, windowDays, tools} | null, baselineError: string | null,
//        groups: {error, timeout, slow, big}}; with sub=1 also {subCalls, agents: [{sid, label, depth, calls | error}]} and
//        the groups count the subagents' calls too (group.sub = how many of count, item.agent = {sid, label} | null).
//   The page asks without sub first (fast) and with sub=1 only when the user opens 含子 agent 的调用.
// Four kinds, each folded into groups of the same thing:
//   error   — the result is an error (isError), folded by tool + the error's first line with paths / quoted text /
//             numbers blanked. A run_code that only failed because a tool inside it threw (ToolCallError) is
//             dropped: the inner call is listed instead.
//   timeout — pwsh moved to a background job after its timeout ("[still running after …ms; moved to background
//             job …]"), run_code past its deadline ("code run failed (timeout)"), or another error whose text says
//             timed out / timeout / ETIMEDOUT / 超时; folded by tool + kind. Timeouts are not listed under error.
//   slow    — duration (result time − call time) above the tool's P90, at least FLOOR_MS; folded by tool. Tools that
//             wait on a person or a job (NO_DURATION) and timeouts are left out.
//   big     — characters of the result's text (what enters the model context) above the tool's P90, at least
//             FLOOR_CHARS; folded by tool. Only top-level calls: a call inside run_code returns to the program,
//             not to the context (run_code's own result is what the context gets).
// Calls inside run_code (tool/ptc-dispatch-start → tool/ptc-dispatch) count under their own tool name, in the same
// P90 sample as top-level calls of that tool (pwsh is pwsh either way).
// P90 (nearest rank) per tool over every dsh session log modified in the last WINDOW_DAYS days (30 since 2026-10-24, was
// 7), calls started inside the window; a tool with fewer than MIN_SAMPLES samples has no baseline. The table is built in a worker thread
// (tool-stats-worker.js) from a per-file cache keyed by mtime + size (CACHE_FILE), rebuilt at most every REFRESH_MS,
// in the background: a request never waits for it (baseline null until the first build is done).
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { Worker } from "node:worker_threads";

export const TOOLS_API = 3; // 3: GET /alignment/tools/runs (what one run_code did, step by step); items carry root
// 2: sub=1 adds the session's subagents (agents, subCalls, group.sub, item.agent); subagents count
export const WINDOW_DAYS = 30;
export const MIN_SAMPLES = 20;
export const FLOOR_MS = 2000;
export const FLOOR_CHARS = 4000;
export const REFRESH_MS = 30 * 60e3;
export const CACHE_VERSION = 1;
export const NO_DURATION = new Set(["ask_user_question", "job_output"]);
export const LOG_NAMES = ["session.v4.jsonl.zstd", "session.v3.jsonl.zstd"];
const ITEMS_PER_GROUP = 50;
const TEXT_MAX = 4000;

const textOf = (content) => (Array.isArray(content) ? content.map((b) => (b && b.type === "text" ? String(b.text ?? "") : "")).join("") : typeof content === "string" ? content : "");
const parseArgs = (a) => { if (typeof a !== "string") return a; try { return JSON.parse(a); } catch { return a; } };

/** The result block of a tool/result event: v4 {role:"tool", toolCallId, content, isError}; v3 wraps a tool-result block. */
function resultOf(data) {
  const m = data?.message;
  if (!m) return null;
  if (Array.isArray(m.content) && m.content[0]?.type === "tool-result") {
    const b = m.content[0];
    return { id: b.toolCallId ?? data.callId, content: b.content, isError: b.isError === true };
  }
  return { id: m.toolCallId ?? m.source?.callId ?? data.callId, content: m.content, isError: m.isError === true };
}

/**
 * Tool calls of a session's events, in order of completion: {id, root, name, start, end, ms, chars, error, text, args}.
 * root = the run_code callId for a call inside run_code (else null); start / ms null when the call event is missing;
 * chars = result text length (null for calls inside run_code); text = the result text when it is an error or a
 * timeout (else null); args = the arguments object (or string).
 */
export function extractCalls(events) {
  const open = new Map(), out = [];
  for (const e of events) {
    const t = e?.type;
    if (typeof t !== "string" || !t.startsWith("tool/")) continue;
    const d = e.data ?? {};
    if (t === "tool/call") open.set(d.callId, { name: d.name, time: e.time, args: d.arguments });
    else if (t === "tool/ptc-dispatch-start") open.set(d.subCallId, { name: d.name, time: e.time, args: d.arguments });
    else if (t === "tool/result" || t === "tool/ptc-dispatch") {
      const inner = t === "tool/ptc-dispatch";
      const r = inner ? { id: d.subCallId, content: d.content, isError: d.isError === true } : resultOf(d);
      if (r === null || typeof e.time !== "number") throw new Error("dsh-alignment tools: " + t + " without message / time — session event shape changed");
      const c = open.get(r.id);
      open.delete(r.id);
      const text = textOf(r.content);
      const name = c?.name ?? d.name ?? "?";
      const start = typeof c?.time === "number" ? c.time : null;
      const kind = timeoutKind(text, r.isError);
      out.push({
        id: r.id, root: inner ? d.rootCallId ?? null : null, name, start, end: e.time, ms: start === null ? null : e.time - start,
        chars: inner ? null : text.length, error: r.isError, timeout: kind, text: r.isError || kind ? text.slice(0, TEXT_MAX) : null,
        args: parseArgs(c?.args ?? d.arguments ?? null),
      });
    }
  }
  return out;
}

/** "background" | "deadline" | "timeout" | null (see the header). */
export function timeoutKind(text, isError) {
  if (/^\[still running after \d+ms; moved to background job/.test(text)) return "background";
  if (!isError) return null;
  if (/^Error: code run failed \(timeout\)/.test(text)) return "deadline";
  if (/\btimed out\b|\btimeout\b|ETIMEDOUT|超时/i.test(text.slice(0, 400))) return "timeout";
  return null;
}

/** The fold key of an error text: first line, quoted text / paths / numbers blanked, 100 chars. */
export function errorKey(text) {
  const first = String(text).split(/\r?\n/).find((l) => l.trim()) ?? "";
  return first
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "…")
    .replace(/(?:[A-Za-z]:)?(?:[\\/][^\s\\/:;,)]+){2,}[\\/]?/g, "…")
    .replace(/\b[0-9a-f]{8,}\b/gi, "…")
    .replace(/\d+(\.\d+)?/g, "N")
    .replace(/\s+/g, " ").trim().slice(0, 100);
}

const LONG = new Set(["code", "content", "new_string", "old_string", "prompt", "message", "spec", "plan", "questions"]);
/** One line naming what the call was about: description, else command / path / pattern / … */
export function argSummary(args) {
  if (args === null || args === undefined) return "";
  if (typeof args !== "object") return oneLine(String(args)).slice(0, 160);
  const v = args.description ?? args.command ?? args.file_path ?? args.pattern ?? args.path ?? args.job_id ?? args.query ?? args.name ?? args.agent_id
    ?? Object.entries(args).find(([k, x]) => typeof x === "string" && !LONG.has(k))?.[1] ?? "";
  return oneLine(String(v)).slice(0, 160);
}
/** The arguments as compact JSON, long text fields replaced by their length, 400 chars. */
export function argText(args) {
  if (args === null || args === undefined) return "";
  if (typeof args !== "object") return String(args).slice(0, 400);
  const o = {};
  for (const [k, v] of Object.entries(args)) o[k] = LONG.has(k) && typeof v === "string" && v.length > 80 ? "<" + v.length + " 字符>" : v;
  const s = JSON.stringify(o);
  return s.length > 400 ? s.slice(0, 399) + "…" : s;
}
const oneLine = (s) => s.replace(/\s+/g, " ").trim();

// ---- What one run_code did (GET /alignment/tools/runs, 2026-10-24) ----
// The program's own calls (tool/ptc-dispatch-start → tool/ptc-dispatch with parentCallId = the run_code callId), in
// start order; adjacent calls of the same tool fold into one step (n), except a call that stands out (error, timeout,
// never returned, the slowest if ≥ 1 s, the one returning the most text if ≥ FLOOR_CHARS), which keeps a step of its own. A step's ms /
// chars is given only when every call in it has both its start and its result event; otherwise null (not guessed).
const RUN_CODE_MAX = 100_000, MAX_RUN_IDS = 50, STEP_TEXTS = 3;
const pathText = (p) => {
  const s = String(p).replace(/\\/g, "/").replace(/^[A-Za-z]:\/Users\/[^/]+\//i, "~/");
  return s.length > 90 ? "…" + s.slice(-89) : s;
};
const cut = (s, n) => { const t = oneLine(String(s)); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
/** What one call did, in a few words (the page shows the tool name next to it); job = the label of a job id (the
 * description / command of the call that started that background job) | null. */
export function stepText(name, args, job = () => null) {
  const a = args && typeof args === "object" ? args : {};
  const has = (k) => typeof a[k] === "string" && a[k] !== "";
  const where = has("path") ? "，范围 " + pathText(a.path) : "";
  switch (name) {
    case "grep": return "搜 " + cut(a.pattern ?? "", 80) + where + (has("include") ? "，只看 " + a.include : "");
    case "glob": return "找 " + cut(a.pattern ?? "", 80) + where;
    case "read": case "read_image": {
      const from = Number.isInteger(a.offset) ? a.offset : null, n = Number.isInteger(a.limit) ? a.limit : null;
      const lines = n !== null ? " 第 " + (from ?? 1) + "–" + ((from ?? 1) + n - 1) + " 行" : from !== null ? " 从第 " + from + " 行起" : "";
      return "读 " + pathText(a.file_path ?? "") + lines;
    }
    case "edit": return "改 " + pathText(a.file_path ?? "");
    case "write": return "写 " + pathText(a.file_path ?? "");
    // a short command reads best as is; a long one by the description the agent gave it (the command is the hint)
    case "pwsh": return has("command") && (oneLine(a.command).length <= 60 || !has("description")) ? cut(a.command, 140) : cut(a.description ?? "", 140);
    case "job_output": case "job_kill": {
      const l = job(a.job_id), what = l ? "「" + cut(l, 80) + "」" : " " + (a.job_id ?? "") + " ";
      return (name === "job_kill" ? "停后台任务" + what : a.wait === true ? "等后台任务" + what + "结束" : "取后台任务" + what + "的输出").trim();
    }
    case "skill": return "读 skill " + (a.name ?? "");
    case "subagent": case "subagent_fork": return "派子 agent：" + cut(a.description ?? a.prompt ?? "", 100);
    case "send_message": return "发消息给 " + (a.agent_id ?? "");
    case "workflow": return "跑 workflow " + (a.meta?.name ?? "");
    case "todo_write": return "更新待办";
    case "ask_user_question": return "问用户：" + cut(a.questions?.[0]?.question ?? "", 80);
    default: return argSummary(args);
  }
}

/** One line for a step of n calls: same pattern over several paths, several files, else the first two texts; more than
 * shown ends in 等 (the count is the step's × n, the full list its tooltip). */
export function stepLabel(tool, argsList, texts) {
  if (argsList.length === 1 || texts.length === 1) return texts[0];
  const list = (xs) => { const u = [...new Set(xs)]; return u.slice(0, 3).join("、") + (u.length > 3 ? " 等" : ""); };
  const a = argsList.map((x) => (x && typeof x === "object" ? x : {}));
  if ((tool === "grep" || tool === "glob") && a.every((x) => x.pattern === a[0].pattern && typeof x.path === "string" && x.include === a[0].include)) {
    return (tool === "grep" ? "搜 " : "找 ") + cut(a[0].pattern ?? "", 80) + "，范围 " + list(a.map((x) => pathText(x.path))) + (typeof a[0].include === "string" ? "，只看 " + a[0].include : "");
  }
  const verb = { read: "读 ", read_image: "读 ", edit: "改 ", write: "写 " }[tool];
  if (verb && a.every((x) => typeof x.file_path === "string")) return verb + list(a.map((x) => pathText(x.file_path)));
  return texts.slice(0, 2).join("；") + (texts.length > 2 ? " 等" : "");
}

/** Total length of the union of [start, end] intervals (ms). */
export function covered(spans) {
  const s = spans.slice().sort((x, y) => x[0] - y[0]);
  let total = 0, a = 0, b = -Infinity;
  for (const [x, y] of s) {
    if (x > b) { if (b > a) total += b - a; a = x; b = y; } else if (y > b) b = y;
  }
  if (b > a) total += b - a;
  return total;
}

/** jobId -> what started that background job (job/registered → the call's description, else the job's label). The
 * step then reads 等后台任务「…」结束 instead of the bare id; a job without that event keeps its id. */
export function jobLabels(events) {
  const args = new Map(), labels = new Map();
  for (const e of events) {
    const t = e?.type, d = e?.data;
    if (t === "tool/call") args.set(d.callId, d.arguments);
    else if (t === "tool/ptc-dispatch-start") args.set(d.subCallId, d.arguments);
    else if (t === "job/registered" && typeof d?.jobId === "string") {
      const a = parseArgs(args.get(d.toolCall?.callId) ?? null);
      const l = (a && typeof a === "object" && typeof a.description === "string" && a.description) || d.label;
      if (typeof l === "string" && l) labels.set(d.jobId, l);
    }
  }
  return (id) => labels.get(id) ?? null;
}

/**
 * One run_code among a session's events, or null when there is no run_code call with that id:
 * {id, description, code (≤ RUN_CODE_MAX), codeChars, start, ms, error, timeout, calls, gap, steps}.
 * steps: [{tool, label (one line for the step), texts (≤ STEP_TEXTS distinct, for the tooltip), distinct, n, ids, hint (a one-call pwsh shown by its description: the command), ms | null, chars | null, errors, errorText | null,
 * timeout, open}]; open = a call with no result (the program ended first). gap = run time not covered by any call
 * (the program's own work) | null when any time is missing.
 */
export function runSteps(events, id) {
  let call = null, result = null;
  const calls = new Map();
  for (const e of events) {
    const t = e?.type, d = e?.data;
    if (t === "tool/call" && d?.callId === id) call = e;
    else if (t === "tool/result" && resultOf(d)?.id === id) result = e;
    else if ((t === "tool/ptc-dispatch-start" || t === "tool/ptc-dispatch") && d?.rootCallId === id && d.parentCallId === id) {
      if (typeof d.subCallId !== "string" || typeof e.time !== "number") throw new Error("dsh-alignment tools: " + t + " without subCallId / time — session event shape changed");
      let c = calls.get(d.subCallId);
      if (c === undefined) { c = { id: d.subCallId, name: d.name, args: parseArgs(d.arguments ?? null), start: null, end: null, error: false, chars: null, timeout: null, errorText: null }; calls.set(d.subCallId, c); }
      if (t === "tool/ptc-dispatch-start") c.start = e.time;
      else {
        const text = textOf(d.content);
        c.end = e.time; c.error = d.isError === true; c.chars = text.length; c.timeout = timeoutKind(text, c.error);
        c.errorText = c.error || c.timeout ? (text.split(/\r?\n/).find((l) => l.trim()) ?? "").trim().slice(0, 300) : null;
      }
    }
  }
  if (call === null || call.data.name !== "run_code") return null;
  const args = parseArgs(call.data.arguments) ?? {};
  const code = typeof args.code === "string" ? args.code : "";
  const list = [...calls.values()].map((c) => ({ ...c, ms: c.start !== null && c.end !== null ? c.end - c.start : null }))
    .sort((a, b) => (a.start ?? a.end) - (b.start ?? b.end));
  // the slowest (≥ 1 s) and the one returning the most text (≥ FLOOR_CHARS) are where a reader looks first
  const top = (k, floor) => { let m = null; for (const c of list) if (c[k] !== null && c[k] >= floor && (m === null || c[k] > m[k])) m = c; return list.length > 1 ? m : null; };
  const slowest = top("ms", 1000), biggest = top("chars", FLOOR_CHARS);
  const job = list.some((c) => c.name === "job_output" || c.name === "job_kill") ? jobLabels(events) : () => null;
  const alone = (c) => c.error || c.timeout !== null || c.end === null || c === slowest || c === biggest;
  const steps = [];
  for (const c of list) {
    const text = stepText(c.name, c.args, job), last = steps.at(-1);
    if (last && !last.alone && !alone(c) && last.tool === c.name) { last.members.push(c); if (!last.texts.includes(text)) last.texts.push(text); continue; }
    steps.push({ tool: c.name, texts: [text], members: [c], alone: alone(c), hint: c.name === "pwsh" && typeof c.args?.command === "string" && !text.startsWith(cut(c.args.command, 140).slice(0, 20)) ? cut(c.args.command, 400) : null });
  }
  const r = result ? resultOf(result.data) : null;
  const runMs = result && typeof call.time === "number" ? result.time - call.time : null;
  const known = list.every((c) => c.start !== null && c.end !== null);
  return {
    id, description: typeof args.description === "string" ? args.description : "", code: code.slice(0, RUN_CODE_MAX), codeChars: code.length,
    start: typeof call.time === "number" ? new Date(call.time).toISOString() : null, ms: runMs,
    error: r ? r.isError : null, timeout: r ? timeoutKind(textOf(r.content), r.isError) : null, calls: list.length,
    gap: runMs !== null && known ? Math.max(0, runMs - covered(list.map((c) => [c.start, c.end]))) : null,
    steps: steps.map((s) => {
      const m = s.members, errs = m.filter((c) => c.error);
      return {
        tool: s.tool, label: stepLabel(s.tool, m.map((c) => c.args), s.texts), texts: s.texts.slice(0, STEP_TEXTS), distinct: s.texts.length, n: m.length, ids: m.map((c) => c.id), hint: m.length === 1 ? s.hint : null,
        ms: m.every((c) => c.ms !== null) ? covered(m.map((c) => [c.start, c.end])) : null,
        chars: m.every((c) => c.chars !== null) ? m.reduce((x, c) => x + c.chars, 0) : null,
        errors: errs.length, errorText: (errs[0] ?? m.find((c) => c.timeout !== null))?.errorText ?? null,
        timeout: m.find((c) => c.timeout !== null)?.timeout ?? null, open: m.some((c) => c.end === null),
      };
    }),
  };
}

/** The route: (req, res) for GET /alignment/tools/runs?sid=<sid>&ids=<run_code callId>,… → {ok, api, sid, runs: {id: run | null}}. */
export function runsHandler({ readSessionState, guard }) {
  const reply = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(body));
  };
  return async (req, res) => {
    try {
      const denied = guard(req);
      if (denied) return reply(res, denied.code, { ok: false, message: denied.message });
      if (req.method !== "GET") return reply(res, 405, { ok: false, message: "不支持的请求" });
      const q = new URL(req.url, "http://127.0.0.1").searchParams;
      const sid = q.get("sid") ?? "";
      if (!/^[\w-]{1,120}$/.test(sid)) return reply(res, 400, { ok: false, message: "缺少会话 ID" });
      const ids = (q.get("ids") ?? "").split(",").filter(Boolean);
      if (!ids.length || ids.length > MAX_RUN_IDS || ids.some((x) => !/^[\w:.-]{1,200}$/.test(x))) return reply(res, 400, { ok: false, message: "调用 ID 不对" });
      const snap = await readSessionState(sid);
      if (!Array.isArray(snap?.events) || typeof snap.inheritedEventCount !== "number") throw new Error("dsh-alignment tools: sessionController.inspect returned no events[] / inheritedEventCount — session controller changed shape");
      const own = snap.events.filter((e) => e.seq >= snap.inheritedEventCount);
      const runs = {};
      for (const id of ids) runs[id] = runSteps(own, id);
      return reply(res, 200, { ok: true, api: TOOLS_API, sid, runs });
    } catch (error) {
      const code = error.status ?? 500;
      if (code === 500) console.error("[dsh-alignment] tools/runs " + (error.stack ?? error.message));
      return reply(res, code, { ok: false, message: error.message });
    }
  };
}

/** Nearest-rank percentile of numbers (unsorted ok); null for none. */
export function percentile(values, p) {
  if (values.length === 0) return null;
  const s = Float64Array.from(values).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}

/** Samples of one log's calls: {names: [..], rows: [[nameIndex, startMs, ms | -1, chars | -1], …]}. */
export function samplesOf(calls) {
  const names = [], idx = new Map(), rows = [];
  for (const c of calls) {
    if (c.start === null) continue;
    let i = idx.get(c.name);
    if (i === undefined) { i = names.length; names.push(c.name); idx.set(c.name, i); }
    rows.push([i, c.start, c.timeout || NO_DURATION.has(c.name) ? -1 : c.ms, c.chars ?? -1]);
  }
  return { names, rows };
}

/** P90 table from per-file samples: {builtAt, from, windowDays, tools: {name: {ms: {p90, n} | null, chars: …}}}. */
export function buildTable(files, now, windowDays = WINDOW_DAYS) {
  const from = now - windowDays * 864e5, acc = new Map();
  for (const f of files) for (const [i, start, ms, chars] of f.rows) {
    if (start < from) continue;
    const name = f.names[i];
    let a = acc.get(name);
    if (a === undefined) { a = { ms: [], chars: [] }; acc.set(name, a); }
    if (ms >= 0) a.ms.push(ms);
    if (chars >= 0) a.chars.push(chars);
  }
  const tools = {};
  const stat = (v) => (v.length < MIN_SAMPLES ? null : { p90: percentile(v, 0.9), n: v.length });
  for (const [name, a] of acc) tools[name] = { ms: stat(a.ms), chars: stat(a.chars) };
  return { builtAt: now, from, windowDays, tools };
}

// A session log is concatenated zstd frames; one zstdDecompressSync call decodes them all with one decoder (2026-10-24:
// decoding frame by frame was ~14 s of a ~25 s 30-day cold build, ~370k frames; one call per log: ~13 s in all; same
// bytes on all 2471 logs).
// An older note says this call stops after the first frame, so it is checked once here and decodeLog fails loud if so.
const ALL_FRAMES = zstdDecompressSync(Buffer.concat([zstdCompressSync(Buffer.from("a\n")), zstdCompressSync(Buffer.from("b\n"))])).toString() === "a\nb\n";
/** A session log as text; an empty file (just created) is an empty log, a cut-off last frame throws. */
export function decodeLog(buf) {
  if (!ALL_FRAMES) throw new Error("dsh-alignment tools: this Node's zstdDecompressSync stops after the first frame — session logs would be cut short");
  return buf.length === 0 ? "" : zstdDecompressSync(buf).toString("utf8");
}

/** Tool events of a decoded log (lines are written with "type" first). */
export function toolEventsOf(text) {
  const out = [];
  for (const line of text.split("\n")) if (line.startsWith('{"type":"tool/')) out.push(JSON.parse(line));
  return out;
}

/** Session logs under root (<root>/<project>/<session>/session.v4.jsonl.zstd) modified at or after since. */
export function listLogs(root, since) {
  const out = [];
  for (const p of readdirSync(root, { withFileTypes: true })) {
    if (!p.isDirectory()) continue;
    for (const s of readdirSync(join(root, p.name), { withFileTypes: true })) {
      if (!s.isDirectory()) continue;
      for (const n of LOG_NAMES) {
        const file = join(root, p.name, s.name, n);
        let st;
        try { st = statSync(file); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
        if (st.mtimeMs >= since) out.push({ file, mtimeMs: st.mtimeMs, size: st.size });
        break;
      }
    }
  }
  return out;
}

/**
 * Scan: reuse cached samples of logs whose mtime + size did not change, parse the rest, drop logs older than the
 * window. cache = {version, files: {path: {mtimeMs, size, names, rows}}} (read from cacheFile when given).
 * Returns {table, cache, stats: {logs, parsed, reused, ms}}; writes cacheFile atomically.
 */
export function scanSessions({ root, cacheFile, now = Date.now(), windowDays = WINDOW_DAYS }) {
  const t0 = Date.now();
  let old = { version: CACHE_VERSION, files: {} };
  if (cacheFile) {
    try { old = JSON.parse(readFileSync(cacheFile, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (old.version !== CACHE_VERSION) old = { version: CACHE_VERSION, files: {} };
  }
  const logs = listLogs(root, now - windowDays * 864e5);
  const files = {};
  let parsed = 0, reused = 0, calls = 0;
  for (const l of logs) {
    const c = old.files[l.file];
    if (c && c.mtimeMs === l.mtimeMs && c.size === l.size) { files[l.file] = c; reused++; calls += c.rows.length; continue; }
    let s;
    try { s = samplesOf(extractCalls(toolEventsOf(decodeLog(readFileSync(l.file))))); }
    catch (error) { throw new Error("dsh-alignment tools: " + l.file + ": " + error.message, { cause: error }); }
    files[l.file] = { mtimeMs: l.mtimeMs, size: l.size, ...s };
    parsed++;
    calls += s.rows.length;
  }
  if (logs.length >= 20 && calls === 0) throw new Error("dsh-alignment tools: " + logs.length + " session logs but no tool events — log line shape changed");
  const cache = { version: CACHE_VERSION, files };
  if (cacheFile) {
    mkdirSync(dirname(cacheFile), { recursive: true });
    const tmp = cacheFile + "." + process.pid + ".tmp";
    writeFileSync(tmp, JSON.stringify(cache));
    renameSync(tmp, cacheFile);
  }
  const table = buildTable(Object.values(files), now, windowDays);
  return { table, cache, stats: { logs: logs.length, parsed, reused, calls, ms: Date.now() - t0 } };
}

/** scanSessions in a worker thread (tool-stats-worker.js): resolves {table, stats}. */
export function runStatsWorker(workerData) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./tool-stats-worker.js", import.meta.url), { workerData });
    let done = false;
    w.once("message", (m) => { done = true; resolve(m); });
    w.once("error", reject);
    w.once("exit", (code) => { if (!done) reject(new Error("tool stats worker exited with code " + code)); });
  });
}

/** Subagents a session started: [{sid, label}] from its subagent/catalog events (one per child, latest label). */
export function childrenOf(events) {
  const m = new Map();
  for (const e of events) {
    if (e?.type !== "subagent/catalog") continue;
    if (typeof e.data?.childId !== "string") throw new Error("dsh-alignment tools: subagent/catalog without childId — session event shape changed");
    m.set(e.data.childId, { sid: e.data.childId, label: typeof e.data.label === "string" ? e.data.label : "" });
  }
  return [...m.values()];
}

export const MAX_AGENT_DEPTH = 3, MAX_AGENTS = 100;
/**
 * Calls of the session's subagents, their subagents … (depth <= MAX_AGENT_DEPTH, at most MAX_AGENTS sessions), each
 * call tagged agent: {sid, label}. ownEvents = the session's own events. A child whose log cannot be read is
 * reported in agents with its error, not dropped silently.
 */
export async function subagentCalls(ownEvents, readSessionState) {
  const calls = [], agents = [];
  let level = childrenOf(ownEvents), depth = 1;
  const seen = new Set();
  while (level.length && depth <= MAX_AGENT_DEPTH) {
    const next = [];
    for (const a of level) {
      if (seen.has(a.sid) || seen.size >= MAX_AGENTS) continue;
      seen.add(a.sid);
      let ev;
      try {
        const snap = await readSessionState(a.sid);
        if (!Array.isArray(snap?.events) || typeof snap.inheritedEventCount !== "number") throw new Error("sessionController.inspect returned no events[] / inheritedEventCount");
        ev = snap.events.filter((e) => e.seq >= snap.inheritedEventCount);
      } catch (error) { agents.push({ ...a, depth, error: error.message }); continue; }
      const own = extractCalls(ev).map((c) => ({ ...c, agent: { sid: a.sid, label: a.label } }));
      calls.push(...own);
      agents.push({ ...a, depth, calls: own.length });
      next.push(...childrenOf(ev));
    }
    level = next;
    depth++;
  }
  return { calls, agents };
}

/**
 * The four groups of anomalies among calls (started in [from, to] when given), measured against table. A call with
 * agent (a subagent's) is counted in its group's sub as well; items carry agent | null.
 * Order: error / timeout groups by count; slow / big groups by their worst ratio, items by ratio.
 */
export function anomalies(calls, table, { from = -Infinity, to = Infinity } = {}) {
  const inRange = calls.filter((c) => { const t = c.start ?? c.end; return t >= from && t <= to; });
  // a run_code that failed only because a tool inside it threw: the inner call is the one to show
  const innerErr = new Set(inRange.filter((c) => c.root !== null && (c.error || c.timeout)).map((c) => c.root));
  const groups = { error: new Map(), timeout: new Map(), slow: new Map(), big: new Map() };
  const add = (kind, key, base, item) => {
    let g = groups[kind].get(key);
    if (g === undefined) { g = { key, ...base, count: 0, sub: 0, worst: 0, items: [] }; groups[kind].set(key, g); }
    g.count++;
    if (item.agent) g.sub++;
    if ((item.ratio ?? 0) > g.worst) g.worst = item.ratio;
    g.items.push(item);
  };
  for (const c of inRange) {
    const item = { id: c.id, root: c.root, at: new Date(c.start ?? c.end).toISOString(), tool: c.name, inner: c.root !== null, args: argSummary(c.args), params: argText(c.args), ms: c.ms, chars: c.chars, agent: c.agent ?? null };
    if (c.timeout) add("timeout", c.name + "|" + c.timeout, { tool: c.name, label: c.timeout }, { ...item, text: c.text });
    else if (c.error && !(c.root === null && c.name === "run_code" && innerErr.has(c.id) && /ToolCallError/.test(c.text ?? ""))) {
      const k = errorKey(c.text ?? "");
      add("error", c.name + "|" + k, { tool: c.name, label: (c.text ?? "").split(/\r?\n/).find((l) => l.trim())?.trim().slice(0, 200) ?? "" }, { ...item, text: c.text });
    }
    const base = table?.tools[c.name];
    if (!c.timeout && c.ms !== null && !NO_DURATION.has(c.name) && base?.ms && c.ms >= FLOOR_MS && c.ms > base.ms.p90) {
      add("slow", c.name, { tool: c.name, p90: base.ms.p90, n: base.ms.n }, { ...item, p90: base.ms.p90, ratio: c.ms / Math.max(1, base.ms.p90) });
    }
    if (c.chars !== null && base?.chars && c.chars >= FLOOR_CHARS && c.chars > base.chars.p90) {
      add("big", c.name, { tool: c.name, p90: base.chars.p90, n: base.chars.n }, { ...item, p90: base.chars.p90, ratio: c.chars / Math.max(1, base.chars.p90) });
    }
  }
  const out = {};
  for (const [kind, m] of Object.entries(groups)) {
    out[kind] = [...m.values()]
      .map((g) => { g.items.sort((a, b) => (kind === "slow" || kind === "big" ? b.ratio - a.ratio : a.at < b.at ? -1 : 1)); g.more = Math.max(0, g.items.length - ITEMS_PER_GROUP); g.items = g.items.slice(0, ITEMS_PER_GROUP); return g; })
      .sort((a, b) => (kind === "slow" || kind === "big" ? b.worst - a.worst || b.count - a.count : b.count - a.count || b.worst - a.worst));
  }
  return { calls: inRange.length, subCalls: inRange.filter((c) => c.agent).length, groups: out };
}

/**
 * The baseline holder in the server: table() -> the latest table | null; refresh() starts a background build when
 * there is none yet or it is older than refreshMs (never two at once); error() -> the last build's error message.
 * build() -> Promise<{table, stats}> (the worker in production, scanSessions in tests).
 */
export function createBaseline({ build, now = Date.now, refreshMs = REFRESH_MS, log = () => {} }) {
  let table = null, running = null, error = null, lastStats = null;
  return {
    table: () => table,
    error: () => error,
    stats: () => lastStats,
    refresh() {
      if (running !== null || (table !== null && now() - table.builtAt < refreshMs)) return running;
      running = Promise.resolve().then(build).then(
        (r) => { table = r.table; lastStats = r.stats; error = null; log("baseline " + JSON.stringify(r.stats)); },
        (e) => { error = e?.message ?? String(e); log("error baseline " + (e?.stack ?? e)); },
      ).finally(() => { running = null; });
      return running;
    },
  };
}

/** The route: (req, res) for GET /alignment/tools; guard is the same fence as /data. */
export function toolsHandler({ readSessionState, baseline, guard, now = Date.now }) {
  const reply = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(body));
  };
  return async (req, res) => {
    const t0 = now();
    try {
      const denied = guard(req);
      if (denied) return reply(res, denied.code, { ok: false, message: denied.message });
      if (req.method !== "GET") return reply(res, 405, { ok: false, message: "不支持的请求" });
      const q = new URL(req.url, "http://127.0.0.1").searchParams;
      const sid = q.get("sid") ?? "";
      if (!/^[\w-]{1,120}$/.test(sid)) return reply(res, 400, { ok: false, message: "缺少会话 ID" });
      const time = (k) => { const v = q.get(k); if (!v) return undefined; const ms = Date.parse(v); if (Number.isNaN(ms)) throw Object.assign(new Error("时间格式不对：" + k), { status: 400 }); return ms; };
      const from = time("from"), to = time("to");
      baseline.refresh();
      const snap = await readSessionState(sid);
      if (!Array.isArray(snap?.events) || typeof snap.inheritedEventCount !== "number") throw new Error("dsh-alignment tools: sessionController.inspect returned no events[] / inheritedEventCount — session controller changed shape");
      const own = snap.events.filter((e) => e.seq >= snap.inheritedEventCount);
      const table = baseline.table();
      const withSub = q.get("sub") === "1";
      const sub = withSub ? await subagentCalls(own, readSessionState) : null;
      const a = anomalies(sub ? [...extractCalls(own), ...sub.calls] : extractCalls(own), table, { from, to });
      return reply(res, 200, {
        ok: true, api: TOOLS_API, sid, calls: a.calls - a.subCalls, ms: now() - t0, subagents: childrenOf(own).length,
        ...(sub ? { subCalls: a.subCalls, agents: sub.agents } : {}),
        baseline: table && { builtAt: new Date(table.builtAt).toISOString(), from: new Date(table.from).toISOString(), windowDays: table.windowDays, tools: Object.keys(table.tools).length },
        baselineError: baseline.error(), groups: a.groups,
      });
    } catch (error) {
      const code = error.status ?? 500;
      if (code === 500) console.error("[dsh-alignment] tools " + (error.stack ?? error.message));
      return reply(res, code, { ok: false, message: error.message });
    }
  };
}
