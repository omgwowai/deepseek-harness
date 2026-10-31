// Text-level upsert of the `dsh-agent-fleet` row in a DSH profile's cordis.patch.yml, for configure.mjs.
// The file belongs to DSH and the user: rows DSH writes are JSON-flow YAML, others are block YAML with comments and `!!js`
// tags, and this package has no YAML parser. So the top-level entries are located by scanning, only our own entry's bytes
// are replaced (or one entry is appended), and the result is scanned again: every other entry must come out byte for byte
// the same, or nothing is written.
export const ROW_ID = "dsh-agent-fleet";
const CONFIG_KEYS = ["mode", "hubUrl", "tokenFile", "panelUrl"];
const BLOCK_START = /^-(?:[ \t]|$)/;
const NEUTRAL = /^\s*(?:#.*)?$/;
const MENTIONS_ROW = new RegExp(`(?:^|[\\s{,])["']?id["']?\\s*:\\s*["']?${ROW_ID}["']?(?=[\\s,}\\]#]|$)`, "m");

export class PatchError extends Error {
  constructor(message) { super(message); this.name = "PatchError"; }
}

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

/** Index of the closing quote of the string literal that opens at `at`. */
function skipQuoted(text, at) {
  const quote = text[at];
  for (let i = at + 1; i < text.length; i += 1) {
    if (quote === '"' && text[i] === "\\") { i += 1; continue; }
    if (text[i] !== quote) continue;
    if (quote === "'" && text[i + 1] === "'") { i += 1; continue; }
    return i;
  }
  throw new PatchError("unterminated quoted string");
}

/** Index of the first character that is neither whitespace nor part of a comment; -1 when there is none. */
function firstContent(text) {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "#" && (i === 0 || /\s/.test(text[i - 1]))) { const nl = text.indexOf("\n", i); if (nl < 0) return -1; i = nl; continue; }
    if (!/\s/.test(text[i])) return i;
  }
  return -1;
}

/** Entries of a top-level block sequence: from a `-` at column 0 to the last non-blank, non-comment line before the next one. */
function scanBlock(text) {
  const items = [];
  let current = null;
  for (let start = 0; start < text.length;) {
    const newline = text.indexOf("\n", start);
    const line = text.slice(start, newline < 0 ? text.length : newline).replace(/\r$/, "");
    if (BLOCK_START.test(line)) { current = { start, end: start + line.length }; items.push(current); }
    else if (!NEUTRAL.test(line)) {
      if (!/^[ \t]/.test(line)) throw new PatchError(`unexpected top-level line ${JSON.stringify(line.slice(0, 40))}`);
      if (current === null) throw new PatchError("indented text before the first list entry");
      current.end = start + line.length;
    }
    start = newline < 0 ? text.length : newline + 1;
  }
  return { items };
}

/** Entries of a flow sequence `[ a, b ]` that opens at `open`; only quotes, nesting and comments are tracked. */
function scanFlow(text, open) {
  const items = [];
  let depth = 1, itemStart = -1, lastSignificant = -1;
  for (let i = open + 1; i < text.length; i += 1) {
    const char = text[i];
    if (char === "#" && /\s/.test(text[i - 1])) { const nl = text.indexOf("\n", i); i = nl < 0 ? text.length : nl; continue; }
    if (/\s/.test(char)) continue;
    if (depth === 1 && (char === "," || char === "]")) {
      if (itemStart >= 0) items.push({ start: itemStart, end: lastSignificant + 1 });
      itemStart = -1;
      if (char === "]") return { items, open, close: i };
      continue;
    }
    if (itemStart < 0) itemStart = i;
    if ((char === '"' || char === "'") && /[\s[{,:]/.test(text[i - 1])) { i = skipQuoted(text, i); lastSignificant = i; continue; }
    if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") { depth -= 1; if (depth < 1) throw new PatchError("unbalanced brackets in the flow list"); }
    lastSignificant = i;
  }
  throw new PatchError("the flow list is not closed");
}

/** JSON-style entries are parsed (we can edit them); anything else only has to tell whether it is our row. */
function describe(body, root) {
  let value;
  try { value = JSON.parse(root === "block" ? body.replace(/^-[ \t]*/, "") : body); } catch { /* not JSON: classified below */ }
  if (isObject(value)) return { style: "json", value, id: typeof value.id === "string" ? value.id : null };
  return { style: "other", value: undefined, id: MENTIONS_ROW.test(body) ? ROW_ID : null };
}

/** @returns {{root: "empty"|"block"|"flow", open?: number, close?: number, items: {start: number, end: number, body: string, style: "json"|"other", value: any, id: string|null}[]}} */
export function inspectPatch(text) {
  const first = firstContent(text);
  if (first < 0) return { root: "empty", items: [] };
  let root, scanned;
  if (text[first] === "[") { root = "flow"; scanned = scanFlow(text, first); }
  else if (/^-(?:[ \t\r\n]|$)/.test(text.slice(first, first + 2)) && (first === 0 || text[first - 1] === "\n")) { root = "block"; scanned = scanBlock(text); }
  else throw new PatchError("the file's top level must be a YAML list of rows");
  if (root === "flow" && firstContent(text.slice(scanned.close + 1)) >= 0) throw new PatchError("text after the closing ] of the list");
  const items = scanned.items.map(({ start, end }) => {
    const body = text.slice(start, end);
    return { start, end, body, ...describe(body, root) };
  });
  return { root, open: scanned.open, close: scanned.close, items };
}

/** `{ "a": 1, "b": [ "x" ] }`: one-line JSON-flow YAML. */
function inline(value) {
  if (Array.isArray(value)) return value.length === 0 ? "[]" : `[ ${value.map(inline).join(", ")} ]`;
  if (isObject(value)) {
    const entries = Object.entries(value);
    return entries.length === 0 ? "{}" : `{ ${entries.map(([key, item]) => `${JSON.stringify(key)}: ${inline(item)}`).join(", ")} }`;
  }
  return JSON.stringify(value);
}

/** The row as DSH writes JSON-flow rows into a block list: `- {`, one line per key, `  }`. */
function blockRow(row, eol) {
  const keys = Object.keys(row);
  return ["- {", ...keys.map((key, n) => `    ${JSON.stringify(key)}: ${inline(row[key])}${n < keys.length - 1 ? "," : ""}`), "  }"].join(eol);
}

/** The row as it is written into a `[ ... ]` list: indented JSON (first line unindented, the caller places it). */
function flowRow(row, indent, eol) {
  return JSON.stringify(row, null, 2).split("\n").map((line, n) => (n === 0 ? "" : indent) + line).join(eol);
}

function leadingIndent(text, at) {
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  const before = text.slice(lineStart, at);
  return /^[ \t]*$/.test(before) ? before : "  ";
}

function mergeRow(old, change, defaultMode) {
  const oldConfig = old === undefined ? {} : old.config ?? {};
  if (!isObject(oldConfig)) throw new PatchError(`the existing ${ROW_ID} row has a config that is not a mapping`);
  const config = { ...oldConfig };
  if (old === undefined && change.mode === undefined) config.mode = defaultMode;
  for (const key of CONFIG_KEYS) if (change[key] !== undefined) config[key] = change[key];
  if (change.sshTarget !== undefined) {
    if (config.upstream !== undefined && !isObject(config.upstream)) throw new PatchError(`the existing ${ROW_ID} row has an upstream that is not a mapping`);
    config.upstream = { ...config.upstream, sshTarget: change.sshTarget };
  }
  return old === undefined ? { id: ROW_ID, disabled: false, config } : { ...old, config };
}

function appended(text, doc, row, eol) {
  if (doc.root === "block") return `${text}${text.endsWith("\n") ? "" : eol}${blockRow(row, eol)}${eol}`;
  if (doc.root === "empty") return `${text}${text === "" || text.endsWith("\n") ? "" : eol}[${eol}  ${flowRow(row, "  ", eol)}${eol}]${eol}`;
  const last = doc.items.at(-1);
  const indent = last === undefined ? "  " : leadingIndent(text, last.start);
  const rendered = flowRow(row, indent, eol);
  if (last === undefined) return `${text.slice(0, doc.open + 1)}${eol}${indent}${rendered}${eol}${text.slice(doc.close)}`;
  const comma = /^\s*,/.exec(text.slice(last.end));
  const at = last.end + (comma === null ? 0 : comma[0].length);
  return `${text.slice(0, at)}${comma === null ? "," : ""}${eol}${indent}${rendered}${text.slice(at)}`;
}

function verify(before, after, wasUpdate, row) {
  const old = inspectPatch(before), next = inspectPatch(after);
  const others = items => JSON.stringify(items.filter(item => item.id !== ROW_ID).map(item => item.body));
  const mine = next.items.filter(item => item.id === ROW_ID);
  const intact = mine.length === 1 && mine[0].style === "json" && JSON.stringify(mine[0].value) === JSON.stringify(row)
    && next.items.length === old.items.length + (wasUpdate ? 0 : 1) && others(old.items) === others(next.items);
  if (!intact) throw new PatchError("internal check failed: the edited list does not match the intended result; nothing was written");
  let plain;
  try { plain = JSON.parse(before); } catch { return; }       // a YAML-style file: the scan above is the check
  const parsed = JSON.parse(after);                           // a pure-JSON file must stay pure JSON
  const rest = list => JSON.stringify(list.filter(item => item?.id !== ROW_ID));
  if (!Array.isArray(plain) || rest(plain) !== rest(parsed) || JSON.stringify(parsed.find(item => item?.id === ROW_ID)) !== JSON.stringify(row)) {
    throw new PatchError("internal check failed: the JSON rows changed; nothing was written");
  }
}

/**
 * @param {string} input   current file contents ("" for a missing file)
 * @param {{change: object, defaultMode: string}} options  config keys to set: mode, hubUrl, tokenFile, panelUrl, sshTarget
 *        (sshTarget lands in config.upstream.sshTarget); `defaultMode` applies to a new row without `change.mode`
 * @returns {{text: string, action: "added"|"updated"|"unchanged", row: object}}
 */
export function upsertFleetRow(input, { change, defaultMode }) {
  const bom = input.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = input.slice(bom.length);
  const doc = inspectPatch(text);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const mine = doc.items.filter(item => item.id === ROW_ID);
  if (mine.length > 1) throw new PatchError(`${mine.length} rows have id ${ROW_ID}; remove the duplicates first`);
  if (mine.length === 0) {
    const row = mergeRow(undefined, change, defaultMode);
    const next = appended(text, doc, row, eol);
    verify(text, next, false, row);
    return { text: bom + next, action: "added", row };
  }
  const [item] = mine;
  if (item.style !== "json") {
    throw new PatchError(`the existing ${ROW_ID} row is not JSON-flow YAML, so it cannot be updated safely; delete that row (or rewrite it as {"id": "${ROW_ID}", "config": {...}}) and run again`);
  }
  const row = mergeRow(item.value, change, defaultMode);
  if (JSON.stringify(row) === JSON.stringify(item.value)) return { text: input, action: "unchanged", row };
  const rendered = doc.root === "block" ? blockRow(row, eol) : flowRow(row, leadingIndent(text, item.start), eol);
  const next = text.slice(0, item.start) + rendered + text.slice(item.end);
  verify(text, next, true, row);
  return { text: bom + next, action: "updated", row };
}
