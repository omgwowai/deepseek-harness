/**
 * Todo ETA suffix: every todo_write item ends with "[ETA <median>/<P75>]" (task-eta numbers), e.g.
 * "改插件核心逻辑 [ETA 8m/20m]". todo_write's item schema is closed (additionalProperties:false in
 * @deepseek-ai/dsh-tool-todo), so the estimate travels in content. Durations: 45s, 8m, 1h, 1.5h, 1h20m.
 * Shared by plugins/dsh-todo-reminder (missing-ETA notice) and plugins/dsh-alignment (/alignment/todos).
 */

const DURATION_RE = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?:in)?)?(?:(\d+)s)?$/i;
const SUFFIX_RE = /\s*\[ETA\s+([^\]/\s]+)\s*\/\s*([^\]\s]+)\s*\]\s*$/i;

/** "1h20m" -> 4800 seconds; null when the text is not a duration this format accepts. */
export function parseDuration(text) {
  const m = DURATION_RE.exec(String(text).trim());
  if (m === null || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) return null;
  return Math.round(Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0));
}

/** 4800 -> "1h20m", 480 -> "8m", 45 -> "45s" (the suffix format, minute precision above one minute). */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("todo-eta: bad duration " + seconds);
  if (seconds < 60) return Math.max(1, Math.round(seconds)) + "s";
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return h === 0 ? m + "m" : m === 0 ? h + "h" : h + "h" + m + "m";
}

/** The suffix for one item: etaSuffix(480, 1200) -> "[ETA 8m/20m]". */
export function etaSuffix(p50, p75) {
  return "[ETA " + formatDuration(p50) + "/" + formatDuration(p75) + "]";
}

/**
 * Split one todo content into {text, eta}. eta is {p50, p75} in seconds, or null when the item carries no
 * well-formed suffix (then text is the content unchanged).
 */
export function splitTodo(content) {
  const m = SUFFIX_RE.exec(content);
  if (m === null) return { text: content, eta: null };
  const p50 = parseDuration(m[1]), p75 = parseDuration(m[2]);
  if (p50 === null || p75 === null) return { text: content, eta: null };
  return { text: content.slice(0, m.index), eta: { p50, p75 } };
}
