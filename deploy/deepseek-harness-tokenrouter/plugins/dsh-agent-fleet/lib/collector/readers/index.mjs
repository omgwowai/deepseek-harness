// The four transcript readers behind one lookup. Each reader module exports `kind`, `match(path)` and
// `createReader({file, host, site, root})` → `{feed(rows), snapshot(), takeEvents(), children()}`.
import * as claude from "./claude.mjs";
import * as codex from "./codex.mjs";
import * as dsh from "./dsh.mjs";
import * as omp from "./omp.mjs";

export const READERS = Object.freeze({ dsh, claude, codex, omp });

// Most specific file name patterns first; the path shapes of the kinds do not overlap.
const ORDER = [dsh, codex, claude, omp];

/**
 * Which reader owns this transcript path, from the path alone: `{kind, id, role, parentFile?}`, or null for any
 * other file (logs, lock files, artifacts, memory notes).
 */
export function matchSession(path) {
  for (const reader of ORDER) {
    const found = reader.match(path);
    if (found) return found;
  }
  return null;
}
