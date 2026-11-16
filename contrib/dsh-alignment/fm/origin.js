// Session-origin helpers for the First Mate resolver (fm/current.js), copied from the dsh-fm plugin's notify.js.
// originDispatcher: the caller id of a session's first user message when it is a dsh-threads delegation envelope.

const DELEGATION = /^<dsh_delegation>\s*<source_thread_id>([A-Za-z0-9_-]{1,128})<\/source_thread_id>/;

function textOf(content) {
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text").map((block) => block.text).join("");
}

function normalize(path) {
  return String(path).replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();
}

export function isInside(root, cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) return false;
  const base = normalize(root);
  const path = normalize(cwd);
  return path === base || path.startsWith(base + "/");
}

export function originDispatcher(events) {
  const first = events.find((event) => event?.type === "user/message");
  return first === undefined ? null : DELEGATION.exec(textOf(first.data?.content).trimStart())?.[1] ?? null;
}
