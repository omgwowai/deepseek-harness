// The source of an alignment decision message (dsh-alignment steers it into the session). Kept free of host and
// align.mjs imports so dsh-thread-message's client test and the mobile-gateway test can build the real shape.
/** Producer-owned source kind of a decision message (session v4); dsh-thread-message and the gateway patch key on it. */
export const SOURCE_KIND = "plugin:dsh-alignment";
/** CONTEXT_SUMMARY_MAX_CHARS of @deepseek-ai/dsh-llm: a notice summary is one line of at most this many characters. */
const SUMMARY_MAX = 120;

/**
 * The message source for one send: {kind, form:"notice", summary, page, decisions:[{title, choice, note}]}.
 * card is align.mjs decisionCard(); anything else (an older skill passing no card) throws.
 */
export function decisionSource(card) {
  const ok = card !== null && typeof card === "object" && typeof card.page === "string" && Array.isArray(card.decisions) && card.decisions.length > 0
    && card.decisions.every((d) => d !== null && typeof d === "object" && typeof d.title === "string" && typeof d.choice === "string" && typeof d.note === "string");
  if (!ok) throw new Error("dsh-alignment: send got no decision card {page, decisions:[{title, choice, note}]} (alignment-page skill align.mjs older than this plugin)");
  const decisions = card.decisions.map(({ title, choice, note }) => ({ title, choice, note }));
  const one = decisions[0];
  const line = decisions.length === 1
    ? "对齐页决定：" + one.title + (one.choice ? " → " + one.choice : "")
    : "对齐页决定 " + decisions.length + " 条：" + decisions.map((d) => d.title).join("、");
  const summary = line.length <= SUMMARY_MAX ? line : line.slice(0, SUMMARY_MAX - 1) + "…";
  return { kind: SOURCE_KIND, form: "notice", summary, page: card.page, decisions };
}
