// Pairing the items of two todo lists (a todo_write rewrite): text similarity, shared by plugins/dsh-alignment
// (per-item timing, ETA carry-over) and plugins/dsh-todo-reminder (spotting an ETA lost by a rewrite). One algorithm,
// so the alignment page and the reminder agree on which new item is which old one.

/** Lowercased text without whitespace, punctuation and symbols. */
export const normText = (text) => String(text).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");

function bigrams(text) {
  const m = new Map();
  for (let i = 0; i < text.length - 1; i++) { const g = text.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); }
  return m;
}

/**
 * 0..1: the higher of the bigram Dice coefficient and 2·LCS / (|a| + |b|); when the longest common subsequence covers
 * 80 % of a text of 3+ characters (words inserted into it, a typo), at least 0.7.
 */
export function similarity(a, b) {
  if (a === b) return 1;
  const l = lcs(a, b), score = Math.max(diceOf(a, b), (2 * l) / (a.length + b.length));
  const short = Math.min(a.length, b.length);
  return short >= 3 && l >= 0.8 * short ? Math.max(0.7, score) : score;
}
function lcs(a, b) {
  let row = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = [0];
    for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? row[j - 1] + 1 : Math.max(row[j], cur[j - 1]);
    row = cur;
  }
  return row[b.length];
}
function diceOf(a, b) {
  const A = bigrams(a), B = bigrams(b);
  let n = 0, total = 0;
  for (const v of A.values()) total += v;
  for (const v of B.values()) total += v;
  if (total === 0) return 0;
  for (const [g, v] of A) n += Math.min(v, B.get(g) ?? 0);
  return (2 * n) / total;
}

export const MATCH_MIN = 0.6;

/**
 * Pair the previous list's texts with the next list's: exact text, then the same text ignoring case / spaces /
 * punctuation, then the most similar remaining pairs (similarity >= MATCH_MIN; ties go to the nearer position).
 * Returns next index -> previous index | -1.
 */
export function matchTexts(prev, next) {
  const out = next.map(() => -1), used = new Set();
  const pass = (eq) => next.forEach((t, j) => {
    if (out[j] !== -1) return;
    let best = -1;
    prev.forEach((p, i) => { if (!used.has(i) && eq(p, t) && (best === -1 || Math.abs(i - j) < Math.abs(best - j))) best = i; });
    if (best !== -1) { out[j] = best; used.add(best); }
  });
  pass((p, t) => p === t);
  pass((p, t) => normText(p) === normText(t));
  const pairs = [];
  next.forEach((t, j) => { if (out[j] === -1) prev.forEach((p, i) => { if (!used.has(i)) { const sc = similarity(normText(p), normText(t)); if (sc >= MATCH_MIN) pairs.push([sc, Math.abs(i - j), i, j]); } }); });
  pairs.sort((x, y) => y[0] - x[0] || x[1] - y[1]);
  for (const [, , i, j] of pairs) if (out[j] === -1 && !used.has(i)) { out[j] = i; used.add(i); }
  return out;
}

// ---- ETA carry-over (2026-10-24, caed7732: the agent rewrote its list without the "[ETA ..]" suffixes) ----
export const CONTAINED = 0.8;
export const MERGE_MIN = 0.1;

/** Whether most of text a (>= 3 chars) is found, in order, inside the longer text b. */
const containedIn = (a, b) => a.length >= 3 && b.length > a.length && lcs(a, b) >= CONTAINED * a.length;

/**
 * Which ETA each item of a rewritten list gets. prev = [{text, eta}] (the previous list, eta = its effective ETA or
 * null), next = [{text, eta}] (the new list, eta = its own suffix or null; texts without the suffix), map =
 * matchTexts(prev texts, next texts). Returns [{eta, inherited}] aligned with next; inherited = the ETA came from the
 * previous list. An item's own ETA always wins. The rest, per previous item that has an ETA:
 * - continued (map pairs it with a new item): that item gets it.
 * - merged (no pair; the previous item is left over): it is added to the new item that contains its text (>= CONTAINED
 *   of it, in order, inside a longer text); when the list got shorter and nothing contains it, to the most similar
 *   new item that continues nothing (similarity >= MERGE_MIN). Several previous items landing on one new item add up:
 *   median + median, P75 + P75. A previous item without an ETA adds nothing. A leftover that matches no new item is
 *   a deletion and contributes nothing.
 * - split (a new item that continues nothing is contained in the previous item's text): the previous ETA is shared
 *   evenly between the continuing item and the split-off parts, so the total stays what was estimated.
 */
export function carryEta(prev, next, map) {
  const P = prev.map((p) => normText(p.text)), N = next.map((n) => normText(n.text));
  const shares = next.map(() => []);
  const collapsed = next.length < prev.length;
  prev.forEach((p, i) => {
    if (p.eta === null) return;
    const to = [];
    const kept = map.indexOf(i);
    if (kept !== -1) to.push(kept);
    else {
      let best = -1, bestScore = 0;
      N.forEach((n, j) => { if (containedIn(P[i], n)) { const sc = similarity(P[i], n); if (sc > bestScore) { best = j; bestScore = sc; } } });
      if (best === -1 && collapsed) N.forEach((n, j) => { if (map[j] === -1) { const sc = similarity(P[i], n); if (sc >= MERGE_MIN && sc > bestScore) { best = j; bestScore = sc; } } });
      if (best !== -1) to.push(best);
    }
    N.forEach((n, j) => { if (map[j] === -1 && !to.includes(j) && containedIn(n, P[i])) to.push(j); });
    const need = to.filter((j) => next[j].eta === null);
    for (const j of need) shares[j].push({ p50: p.eta.p50 / need.length, p75: p.eta.p75 / need.length });
  });
  return next.map((n, j) => {
    if (n.eta !== null) return { eta: n.eta, inherited: false };
    if (shares[j].length === 0) return { eta: null, inherited: false };
    return { eta: { p50: Math.round(shares[j].reduce((s, e) => s + e.p50, 0)), p75: Math.round(shares[j].reduce((s, e) => s + e.p75, 0)) }, inherited: true };
  });
}
