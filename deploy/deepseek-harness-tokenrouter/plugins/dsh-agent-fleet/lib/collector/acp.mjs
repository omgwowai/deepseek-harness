// ACP bindings: which DSH session drives which Claude / Codex / OMP session over ACP. DSH records the pairs in
// `<dsh home>/dsh-acp/sidecar.sqlite` (`bindings` table). Every sidecar is opened read-only with `node:sqlite` and
// polled incrementally (`time >= last seen`); a missing file, a locked database or a missing `node:sqlite` is not an
// error, it just means no bindings yet.
import { stat } from "node:fs/promises";
import { isMissing } from "./util.mjs";

const PROVIDER_KIND = { "acp-claude": "claude", "acp-codex": "codex", "acp-omp": "omp" };
const MAX_SIDECARS = 256;
const QUERY = "SELECT dsh_session_id, acp_provider_id, acp_session_id, json_extract(payload, '$.canonicalCwd') AS cwd, time FROM bindings WHERE time >= ? ORDER BY time";

/** @typedef {{dsh: string, provider: string, kind: "claude"|"codex"|"omp", id: string, cwd: string|null, time: number}} Binding */

export const kindOfProvider = provider => PROVIDER_KIND[provider] ?? null;

/** DSH session ids appear with and without the "session-" prefix (directory name vs. header id). */
export const dshIdForm = id => (typeof id === "string" && id.startsWith("session-") ? id.slice("session-".length) : id);

let sqliteModule; // undefined: not tried; null: unavailable
async function loadSqlite() {
  if (sqliteModule !== undefined) return sqliteModule;
  const emit = process.emitWarning;
  // node:sqlite prints an ExperimentalWarning on first import; stderr noise would end up in hub transport errors.
  process.emitWarning = (warning, ...rest) => {
    if (String(warning?.message ?? warning).includes("SQLite")) return;
    return emit.call(process, warning, ...rest);
  };
  try { sqliteModule = await import("node:sqlite"); } catch { sqliteModule = null; } finally { process.emitWarning = emit; }
  return sqliteModule;
}

const isBusy = error => /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(String(error?.message ?? "")) || error?.errcode === 5 || error?.errcode === 6;

/**
 * @param {object} options
 * @param {string[] | (() => string[])} options.paths  sidecar files (a function is re-evaluated on every poll)
 * @param {(bindings: Binding[]) => void} options.onBindings  new or changed bindings (may repeat the newest one)
 * @param {number} [options.intervalMs]
 * @param {(message: string) => void} [options.log]
 */
export function createAcp({ paths, onBindings, intervalMs = 2000, log = () => {} }) {
  const sidecars = new Map(); // path → {db, statement, lastTime, signature, failure}
  let timer = null, polling = false, stopped = false;

  const pathsNow = () => [...new Set(typeof paths === "function" ? paths() : paths)].slice(0, MAX_SIDECARS);

  function close(state) {
    try { state.db?.close(); } catch { /* already closed */ }
    state.db = null; state.statement = null; state.signature = "";
  }

  async function signatureOf(path) {
    let main;
    try { main = await stat(path); } catch (error) { if (isMissing(error)) return null; throw error; }
    let wal = null;
    try { wal = await stat(`${path}-wal`); } catch { /* no WAL file */ }
    return `${main.mtimeMs}:${main.size}:${wal ? `${wal.mtimeMs}:${wal.size}` : ""}`;
  }

  async function pollOne(path, sqlite) {
    let state = sidecars.get(path);
    if (!state) { state = { db: null, statement: null, lastTime: 0, signature: "", failure: "" }; sidecars.set(path, state); }
    let signature;
    try { signature = await signatureOf(path); } catch (error) { return report(state, path, `stat: ${error.code ?? error.message}`); }
    if (signature === null) { close(state); state.failure = ""; return; }
    if (signature === state.signature) return;
    try {
      if (!state.db) {
        state.db = new sqlite.DatabaseSync(path, { readOnly: true });
        try { state.db.exec("PRAGMA busy_timeout = 250"); } catch { /* not fatal */ }
        state.statement = state.db.prepare(QUERY);
      }
      const rows = state.statement.all(state.lastTime);
      state.signature = signature;
      state.failure = "";
      const bindings = [];
      for (const row of rows) {
        const kind = kindOfProvider(row.acp_provider_id);
        if (!kind || typeof row.dsh_session_id !== "string" || typeof row.acp_session_id !== "string" || row.acp_session_id === "") continue;
        const time = Number(row.time);
        if (time > state.lastTime) state.lastTime = time;
        bindings.push({ dsh: row.dsh_session_id, provider: row.acp_provider_id, kind, id: row.acp_session_id, cwd: typeof row.cwd === "string" ? row.cwd : null, time });
      }
      if (bindings.length > 0) onBindings(bindings);
    } catch (error) {
      if (isBusy(error)) return; // try again at the next poll, keep the connection
      close(state);
      report(state, path, `sqlite: ${error.message}`);
    }
  }

  function report(state, path, message) {
    if (state.failure === message) return;
    state.failure = message;
    log(`acp sidecar ${path}: ${message}`);
  }

  async function poll() {
    if (polling || stopped) return;
    polling = true;
    try {
      const list = pathsNow();
      for (const path of [...sidecars.keys()]) if (!list.includes(path)) { close(sidecars.get(path)); sidecars.delete(path); }
      if (list.length === 0) return;
      const sqlite = await loadSqlite();
      if (!sqlite) { if (!sidecars.has("")) { sidecars.set("", {}); log("node:sqlite is not available: ACP bindings are disabled"); } return; }
      for (const path of list) { if (stopped) return; await pollOne(path, sqlite); }
    } finally { polling = false; }
  }

  return {
    poll,
    start() { if (!timer && !stopped) { timer = setInterval(() => { poll().catch(error => log(`acp poll failed: ${error.message}`)); }, intervalMs); timer.unref?.(); poll().catch(() => {}); } },
    stop() { stopped = true; clearInterval(timer); timer = null; for (const state of sidecars.values()) close(state); sidecars.clear(); },
    /** Forget what was reported so the next poll delivers every binding again (new hub connection). */
    replay() { for (const state of sidecars.values()) { state.lastTime = 0; state.signature = ""; } },
  };
}
