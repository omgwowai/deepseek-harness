#!/usr/bin/env node
// Native-aware rebuild of imported DSH v4 session logs (sessions.js → native.bundle.js imports).
//
// An imported log has two parts: the imported prefix (what the importer wrote from the native
// transcript) and, when DSH resumed the session afterwards, everything from the first `session/end-seed`
// marker on (the ACP adapter's continued turns). This tool regenerates the prefix from the native
// transcript with the *current* importer — same DSH id and header — and re-sequences the continued rows
// after it, remapping every seq reference they carry (title/title-llm-request messageSeqs,
// developer/message headerSeq). The session's ACP binding in the adapter sidecar is kept consistent
// ratchet-only: `dshCommittedSeq` may only move forward, by the number of rows the prefix grew.
//
//   node rebuild-imported-logs.mjs [--apply] [--backup-dir DIR] [--dsh-home ~/.dsh] [--sessions-root DIR]
//        [--state FILE] [--sidecar FILE] [--home claude=DIR] [--home codex=DIR] [--home omp=DIR]
//        [--kind KIND] [--limit N] [--no-sidecar] [--no-state] [session-id ...]
//
// Without --apply it only reports (and still runs the importer, so "would rebuild" is exact). With
// --apply it copies each original into --backup-dir first, takes the session's flock (skips sessions a
// running Host has open), atomically replaces the log, then ratchets the sidecar binding and the import
// state file. Sessions whose native transcript is gone, whose prefix is not an import, or whose
// references cannot be mapped safely are skipped and reported; nothing is guessed.
import { execFileSync, spawn } from "node:child_process";
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { acpFor, transcriptFor } from "./native.bundle.js";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return undefined; const [, value] = args.splice(i, 2); return value; };
const list = (name) => { const values = []; for (;;) { const v = flag(name); if (v === undefined) break; values.push(v); } return values; };
const apply = args.includes("--apply") && args.splice(args.indexOf("--apply"), 1).length > 0;
const backupDir = flag("--backup-dir");
const dshHome = flag("--dsh-home") ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
const sessionsRoot = flag("--sessions-root") ?? join(dshHome, "sessions");
const stateFile = flag("--state") ?? join(dshHome, "dsh-agent-dag", "native-import.json");
const sidecarFile = flag("--sidecar") ?? join(dshHome, "dsh-acp", "sidecar.sqlite");
const noSidecar = args.includes("--no-sidecar") && args.splice(args.indexOf("--no-sidecar"), 1).length > 0;
const noState = args.includes("--no-state") && args.splice(args.indexOf("--no-state"), 1).length > 0;
const limit = Number(flag("--limit") ?? 0);
const kinds = new Set(list("--kind"));
// Native homes per kind, tried in order: the importer scans the user's own homes and the Paseo omp home,
// so a session imported from either must be rebuildable. `--home kind=DIR` (repeatable) replaces the list.
const homeList = {
  claude: [process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")],
  codex: [process.env.CODEX_HOME ?? join(homedir(), ".codex")],
  omp: process.env.PI_CODING_AGENT_DIR ? [process.env.PI_CODING_AGENT_DIR] : [join(homedir(), ".omp/agent"), join(homedir(), ".paseo/agents/omp")],
};
const overridden = new Set();
for (const entry of list("--home")) {
  const i = entry.indexOf("=");
  if (i <= 0) continue;
  const kind = entry.slice(0, i);
  if (!overridden.has(kind)) { homeList[kind] = []; overridden.add(kind); }
  homeList[kind].push(entry.slice(i + 1));
}
const homes = Object.fromEntries(Object.entries(homeList).map(([kind, dirs]) => [kind, dirs[0]]));
// Positional ids are whatever the flags did not consume; capture them only after every flag is spliced.
const only = new Set(args);
if (apply && !backupDir) throw new Error("--apply requires --backup-dir");

/** Event types the native-session importer writes; a prefix with anything else is not an import. */
const IMPORTER_EVENT_TYPES = new Set(["permission/preset", "sandbox/mode", "approval/policy", "model/selection", "turn/start", "turn/end", "step/start", "step/end", "user/message", "assistant/message", "tool/call", "tool/result", "session/title", "system/message", "compaction/start", "compaction/summary", "compaction/end", "request/header"]);

/** The conversation surface's event types; the loader lets a system/message open it only as its first node. */
const SURFACE_EVENT_TYPES = new Set(["system/message", "user/message", "developer/message", "assistant/message", "tool/result"]);

/**
 * One checksummed zstd frame holding `text`; DSH writes one frame per log batch and reads them concatenated.
 * Goes through a file: execFileSync with a multi-MB `input` stalls on macOS (child blocked on its stdin).
 */
function zstdFrame(text, scratch) {
  writeFileSync(scratch, text, { mode: 0o600 });
  try { return execFileSync("zstd", ["-c", "-q", "--check", "--", scratch], { maxBuffer: 1 << 30 }); }
  finally { rmSync(scratch, { force: true }); }
}

/** Non-blocking exclusive flock on the session's lease file, held by a child for the duration of `fn`. */
function withLease(dir, fn) {
  // macOS has no flock(1); python's fcntl takes the same flock(2) the Host holds on `session.lock`.
  const probe = "import fcntl,sys\nf=open(sys.argv[1],'a')\ntry:\n fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept OSError:\n sys.exit(75)\nsys.stdout.write('locked\\n');sys.stdout.flush();sys.stdin.read()";
  const holder = spawn("python3", ["-c", probe, join(dir, "session.lock")], { stdio: ["pipe", "pipe", "inherit"] });
  const locked = new Promise((resolve) => {
    holder.stdout.on("data", (chunk) => { if (String(chunk).includes("locked")) resolve(true); });
    holder.on("exit", () => resolve(false));
  });
  return locked.then((held) => {
    if (!held) return "busy";
    try { return fn(); } finally { holder.stdin.end(); }
  });
}

function decodeLog(path) {
  const text = execFileSync("zstd", ["-dc", "--", path], { maxBuffer: 1 << 30 }).toString("utf8");
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** The replay envelopes an imported prefix carries: the ACP identity its messages were bound to. */
function replayIdentity(prefix) {
  const found = new Map();
  for (const event of prefix) {
    if (event.type !== "assistant/message") continue;
    const response = event.data?.message?.source?.replayState?.response;
    if (response === undefined || response === null) continue;
    found.set(`${response.profileId}\u0000${response.agentSessionId}\u0000${response.ownerDshSessionId}`, { kind: response.profileId, nativeSessionId: response.agentSessionId, ownerDshSessionId: response.ownerDshSessionId });
  }
  return found.size <= 1 ? { identity: found.values().next().value ?? null, conflict: null } : { identity: null, conflict: [...found.values()] };
}

/** Whether these rows are exactly what the importer writes for a native session (the rebuild's precondition). */
function classifyPrefix(prefix) {
  if (prefix.length < 4) return "prefix too short";
  const prelude = ["permission/preset", "sandbox/mode", "approval/policy", "model/selection"];
  for (let i = 0; i < prelude.length; i++) if (prefix[i].type !== prelude[i]) return `prefix[${i}] is ${prefix[i].type}, not ${prelude[i]}`;
  if (!String(prefix[3].data?.provider ?? "").startsWith("acp-")) return `model/selection provider ${prefix[3].data?.provider} is not an ACP route`;
  let turns = 0;
  for (let i = 0; i < prefix.length; i++) {
    const event = prefix[i];
    if (!IMPORTER_EVENT_TYPES.has(event.type)) return `prefix has non-importer event ${event.type} at seq ${event.seq} (live session)`;
    if (event.seq !== i) return `prefix seq gap at index ${i} (seq ${event.seq})`;
    if (event.type === "turn/start") turns += 1;
    if (event.type === "user/message" && event.data?.source?.kind !== "user") return `prefix has injected user message source ${event.data?.source?.kind} at seq ${event.seq}`;
  }
  if (turns === 0) return "prefix has no turn (not an import)";
  return null;
}

const userSeqs = (events) => events.filter((event) => event.type === "user/message" && event.data?.source?.kind === "user").map((event) => event.seq);
const headerSeqs = (events) => events.filter((event) => event.type === "request/header").map((event) => event.seq);

/** Cheap fingerprint deciding whether the stored prefix already is this importer's output (ignoring random message ids). */
function fingerprint(events) {
  return JSON.stringify(events.map((event) => [event.type,
    event.type === "tool/call" ? [event.data?.name, (event.data?.arguments ?? "").length] : null,
    event.type === "assistant/message" ? [event.data?.usage !== undefined, event.data?.message?.content?.map((part) => part.type), event.data?.message?.source?.replayState?.response?.committedPromptOrdinal ?? null] : null,
    event.type === "session/title" ? [event.data?.title, event.data?.messageSeqs, event.data?.source?.kind] : null,
    event.type === "compaction/summary" ? [Array.isArray(event.data?.shadowedSeqs), (event.data?.shadowedSeqs ?? []).length, JSON.stringify(event.data?.shadowedRange ?? null)] : null,
    event.type === "system/message" ? (event.data?.message?.content?.[0]?.text ?? "").slice(0, 64) : null,
    event.type === "user/message" ? (event.data?.content?.[0]?.text ?? "").slice(0, 64) : null,
  ]));
}

/** Rewrite one continued row's seq references; `remap` maps an old seq into the new log's seq space. */
function shiftTailRow(row, delta, remap) {
  const next = { ...row, seq: row.seq + delta };
  if (typeof row.surfaceOp === "object" && row.surfaceOp !== null) throw new Error(`seq ${row.seq}: tail carries a replace surfaceOp; cannot remap safely`);
  if (row.sourceEventSeqs !== undefined) throw new Error(`seq ${row.seq}: tail carries sourceEventSeqs; cannot remap safely`);
  if (row.type === "session/title" || row.type === "session/title-llm-request") {
    const seqs = row.data?.messageSeqs;
    if (Array.isArray(seqs)) next.data = { ...row.data, messageSeqs: seqs.map((seq) => remap(seq)) };
  }
  if (row.type === "developer/message" && typeof row.data?.headerSeq === "number") {
    next.data = { ...row.data, headerSeq: remap(row.data.headerSeq) };
  }
  // Everything else about a continued row is DSH's own record and must survive verbatim.
  if (next.data !== row.data) {
    const stripped = (data) => JSON.stringify({ ...data, messageSeqs: undefined, headerSeq: undefined });
    if (stripped(row.data) !== stripped(next.data)) throw new Error(`seq ${row.seq}: unexpected data change while shifting`);
  }
  return next;
}

/** Compose the rebuilt rows: regenerated prefix + shifted tail. Throws when a reference cannot be mapped. */
function composeLog(prefix, tail, fresh) {
  const newPrefix = fresh.events;
  const delta = newPrefix.length - prefix.length;
  const boundary = prefix.length;
  const oldUsers = userSeqs(prefix), newUsers = userSeqs(newPrefix);
  const oldHeaders = headerSeqs(prefix), newHeaders = headerSeqs(newPrefix);
  // Continued rows cite prefix seqs by ordinal; that mapping needs the same anchors on both sides.
  // Without a tail nothing cites the prefix, and a native transcript that grew since the import
  // legitimately carries more turns than the old prefix (they are folded into the new prefix).
  if (tail.length > 0 && (oldUsers.length !== newUsers.length || oldHeaders.length !== newHeaders.length))
    throw new Error(`prefix shape moved: users ${oldUsers.length}→${newUsers.length}, headers ${oldHeaders.length}→${newHeaders.length}`);
  // A cited seq before the boundary is a user-message or request/header reference; keep its ordinal so
  // it lands on the same logical event of the regenerated prefix. Later rows just move with the shift.
  const remap = (seq) => {
    if (seq >= boundary) return seq + delta;
    const table = oldUsers.includes(seq) ? [oldUsers, newUsers] : oldHeaders.includes(seq) ? [oldHeaders, newHeaders] : null;
    if (table === null) throw new Error(`seq ${seq} points into the old prefix but is neither a user message nor a request/header there`);
    return table[1][table[0].indexOf(seq)];
  };
  const events = [...newPrefix, ...tail.map((row) => shiftTailRow(row, delta, remap))];
  for (let i = 0; i < events.length; i++) {
    if (events[i].seq !== i) throw new Error(`composed seq gap at index ${i}`);
    if (i > 0 && events[i].time < events[i - 1].time) throw new Error(`composed time inversion at seq ${i} (${events[i - 1].time} → ${events[i].time})`);
  }
  // Titles must cite earlier distinct human user messages; continued rows may carry regenerated titles
  // citing seqs of the old prefix.
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.type !== "session/title" && event.type !== "session/title-llm-request") continue;
    const seqs = event.data?.messageSeqs;
    if (!Array.isArray(seqs)) continue;
    const seen = new Set();
    for (const seq of seqs) {
      if (!Number.isSafeInteger(seq) || seq < 0 || seq >= i) throw new Error(`title at seq ${i} cites seq ${seq} (not an earlier event)`);
      if (seen.has(seq)) throw new Error(`title at seq ${i} cites seq ${seq} twice`);
      seen.add(seq);
      const cited = events[seq];
      if (cited.type !== "user/message" || cited.data?.source?.kind !== "user") throw new Error(`title at seq ${i} cites seq ${seq} which is not a human user message`);
    }
  }
  // The loader accepts a `system/message` only as the surface's opening node (or after an earlier
  // one opened it), so a composed log with any system prompt must open its surface with one.
  const firstSurface = events.find((event) => SURFACE_EVENT_TYPES.has(event.type));
  if (events.some((event) => event.type === "system/message") && firstSurface?.type !== "system/message") throw new Error("system/message is not the first surface node");
  return { events, delta };
}

/** Atomically replace the log with a header frame + one events frame, after backing it up. */
function writeLog(dir, path, workspace, headerLine, events) {
  const serialized = events.map((event) => JSON.stringify(event));
  const scratch = `${path}.rebuild-src`;
  const headerFrame = zstdFrame(`${headerLine}\n`, scratch);
  const bodyFrame = zstdFrame(`${serialized.join("\n")}\n`, scratch);
  const tmp = `${path}.rebuild-tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try { writeSync(fd, headerFrame); writeSync(fd, bodyFrame); fsyncSync(fd); } finally { closeSync(fd); }
  const roundTrip = decodeLog(tmp);
  const expected = [headerLine, ...serialized];
  if (roundTrip.length !== expected.length || roundTrip.some((line, i) => line !== expected[i])) {
    rmSync(tmp, { force: true });
    throw new Error("round-trip mismatch");
  }
  mkdirSync(join(backupDir, workspace, path.split("/").at(-2)), { recursive: true });
  copyFileSync(path, join(backupDir, workspace, path.split("/").at(-2), "session.v4.jsonl.zstd"));
  renameSync(tmp, path);
  const dirFd = openSync(dir, "r");
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
}

/** Ratchet the adapter binding forward by the rows the prefix grew; never move it backwards. */
function ratchetSidecar(dshSessionId, nativeSessionId, delta) {
  if (noSidecar || !existsSync(sidecarFile)) return "skipped";
  if (delta <= 0) return "kept";
  const database = new DatabaseSync(sidecarFile);
  try {
    const row = database.prepare("SELECT payload FROM bindings WHERE dsh_session_id = ?").get(dshSessionId);
    if (!row?.payload) return "no-binding";
    let payload;
    try { payload = JSON.parse(row.payload); } catch { return "unreadable"; }
    if (payload.agentSessionId !== nativeSessionId) return "identity-mismatch";
    const committed = payload.dshCommittedSeq ?? 0;
    const next = Math.max(committed, committed + delta);
    if (next === committed) return "kept";
    payload.dshCommittedSeq = next;
    database.prepare("UPDATE bindings SET payload = ? WHERE dsh_session_id = ?").run(JSON.stringify(payload), dshSessionId);
    return "ratcheted";
  } finally { database.close(); }
}

const report = { scanned: 0, candidates: 0, rebuilt: 0, wouldRebuild: 0, unchanged: 0, skipped: [], failed: [], byKind: {}, changes: [], sidecar: { ratcheted: 0, kept: 0, skipped: 0, other: {} } };
const state = noState ? null : (() => { try { return JSON.parse(readFileSync(stateFile, "utf8")); } catch { return null; } })();
const stateByDsh = new Map();
if (state?.sessions) for (const [key, entry] of Object.entries(state.sessions)) if (entry?.dshSessionId) stateByDsh.set(entry.dshSessionId, { key, entry });
const sidecarLookup = new Map();
if (!noSidecar && existsSync(sidecarFile)) {
  const database = new DatabaseSync(sidecarFile, { readOnly: true });
  try { for (const row of database.prepare("SELECT dsh_session_id, acp_provider_id, acp_session_id, payload FROM bindings").all()) sidecarLookup.set(row.dsh_session_id, row); }
  finally { database.close(); }
}

const started = Date.now();
const skip = (entry, reason, detail) => { report.skipped.push({ ...entry, reason, detail }); if (entry.kind && report.byKind[entry.kind]) report.byKind[entry.kind].skipped += 1; };
outer:
for (const workspace of readdirSync(sessionsRoot)) {
  const workspaceDir = join(sessionsRoot, workspace);
  let children;
  try { children = readdirSync(workspaceDir); } catch { continue; }
  for (const id of children) {
    if (only.size > 0 && !only.has(id)) continue;
    const dir = join(workspaceDir, id);
    const path = join(dir, "session.v4.jsonl.zstd");
    if (!existsSync(path)) continue;
    report.scanned += 1;
    let lines;
    try { lines = decodeLog(path); } catch (error) { report.failed.push({ id, error: `decode: ${error.message}` }); continue; }
    let header, events;
    try { header = JSON.parse(lines[0]); events = lines.slice(1).map((line) => JSON.parse(line)); }
    catch (error) { report.failed.push({ id, error: `parse: ${error.message}` }); continue; }
    if (header?.type !== "session" || !Array.isArray(events)) { report.failed.push({ id, error: "header is not a session header" }); continue; }
    const boundaryIndex = events.findIndex((event) => event.type === "session/end-seed");
    const prefix = boundaryIndex < 0 ? events : events.slice(0, boundaryIndex);
    const tail = boundaryIndex < 0 ? [] : events.slice(boundaryIndex);
    const shape = classifyPrefix(prefix);
    if (shape !== null) { skip({ id }, "not-an-import", shape); continue; }
    const { identity, conflict } = replayIdentity(prefix);
    if (conflict !== null) { skip({ id }, "replay-conflict", JSON.stringify(conflict)); continue; }
    if (identity && identity.ownerDshSessionId !== id) { skip({ id }, "owner-mismatch", `${identity.ownerDshSessionId} ≠ ${id}`); continue; }
    let kind = identity?.kind ?? null, nativeSessionId = identity?.nativeSessionId ?? null;
    const stateEntry = stateByDsh.get(id);
    if (kind === null && stateEntry) { kind = stateEntry.entry.kind; nativeSessionId = stateEntry.key.slice(stateEntry.key.indexOf(":") + 1); }
    const sidecarRow = sidecarLookup.get(id);
    if (kind === null && sidecarRow) { kind = String(sidecarRow.acp_provider_id ?? "").replace(/^acp-/, ""); nativeSessionId = sidecarRow.acp_session_id; }
    if (kind === null || !homes[kind]) { skip({ id }, "unidentified", "no replay envelope, no sidecar binding, no state entry"); continue; }
    if (kinds.size > 0 && !kinds.has(kind)) continue;
    report.byKind[kind] ??= { rebuilt: 0, wouldRebuild: 0, unchanged: 0, skipped: 0, failed: 0 };
    const entry = { id, kind, nativeSessionId };
    // When several identity sources speak, they must agree; the rebuild must not pick a side silently.
    if (identity && stateEntry && stateEntry.entry.kind !== identity.kind) { skip(entry, "identity-conflict", `state ${stateEntry.entry.kind} ≠ replay ${identity.kind}`); continue; }
    if (identity && sidecarRow && sidecarRow.acp_session_id && sidecarRow.acp_session_id !== identity.nativeSessionId) { skip(entry, "identity-conflict", `sidecar ${sidecarRow.acp_session_id} ≠ replay ${identity.nativeSessionId}`); continue; }
    if (identity && stateEntry && stateEntry.key.slice(stateEntry.key.indexOf(":") + 1) !== identity.nativeSessionId) { skip(entry, "identity-conflict", `state ${stateEntry.key} ≠ replay ${identity.nativeSessionId}`); continue; }
    if (limit > 0 && report.candidates >= limit) break outer;
    report.candidates += 1;
    const oldPrompts = userSeqs(prefix).length;
    let fresh;
    try {
      // A continued log keeps its own rows for whatever happened after the import; the regenerated
      // prefix must stop at the turns the import owned, or the adapter's appended turns would repeat.
      for (const home of homeList[kind]) {
        try {
          fresh = await transcriptFor({
            kind, home, sessionId: nativeSessionId, cwd: header.cwd, dshId: id,
            acp: acpFor(kind), bound: { agentSessionId: nativeSessionId },
            ...(tail.length === 0 ? {} : { maxPrompts: oldPrompts }),
          });
          break;
        } catch (error) { if (home === homeList[kind].at(-1)) throw error; }
      }
    } catch (error) {
      skip(entry, "native-missing", String(error?.message ?? error));
      continue;
    }
    if (tail.length > 0 && fresh.prompts !== oldPrompts) { skip(entry, "prompt-mismatch", `prefix has ${oldPrompts} prompts, native yields ${fresh.prompts}`); continue; }
    let composed;
    try { composed = composeLog(prefix, tail, fresh); }
    catch (error) { report.failed.push({ ...entry, error: `compose: ${error.message}` }); report.byKind[kind].failed += 1; continue; }
    if (composed.delta === 0 && fingerprint(fresh.events) === fingerprint(prefix)) {
      report.unchanged += 1;
      report.byKind[kind].unchanged += 1;
      continue;
    }
    const what = `${composed.delta >= 0 ? "+" : ""}${composed.delta} rows, prefix ${prefix.length}→${fresh.events.length}, tail ${tail.length} kept`;
    if (!apply) {
      console.log(`would rebuild ${workspace}/${id} [${kind}] ${what}`);
      report.wouldRebuild += 1;
      report.byKind[kind].wouldRebuild += 1;
      report.changes.push({ id, kind, oldPrefix: prefix.length, newPrefix: fresh.events.length, tail: tail.length, delta: composed.delta });
      continue;
    }
    const outcome = await withLease(dir, () => {
      // Re-read under the lease: the log may have grown since the scan, and a Host may own it now.
      const currentLines = decodeLog(path);
      const currentEvents = currentLines.slice(1).map((line) => JSON.parse(line));
      const currentBoundary = currentEvents.findIndex((event) => event.type === "session/end-seed");
      const currentPrefix = currentBoundary < 0 ? currentEvents : currentEvents.slice(0, currentBoundary);
      const currentTail = currentBoundary < 0 ? [] : currentEvents.slice(currentBoundary);
      if (classifyPrefix(currentPrefix) !== null) return { skipped: "log changed since scan and no longer looks like an import" };
      if (currentPrefix.length !== prefix.length || currentTail.length !== tail.length) return { skipped: "log grew since scan; re-run to rebuild the current content" };
      const rebuilt = composeLog(currentPrefix, currentTail, fresh);
      writeLog(dir, path, workspace, currentLines[0], rebuilt.events);
      return { events: rebuilt.events.length, prefix: rebuilt.events.length - currentTail.length, delta: rebuilt.delta };
    }).catch((error) => ({ failed: error.message }));
    if (outcome === "busy") { skip(entry, "busy", "session lock is held by a running Host"); continue; }
    if (outcome?.skipped) { skip(entry, "scan-stale", outcome.skipped); continue; }
    if (outcome?.failed !== undefined || outcome?.events === undefined) { report.failed.push({ ...entry, error: outcome?.failed ?? "unknown" }); report.byKind[kind].failed += 1; continue; }
    const sidecarOutcome = ratchetSidecar(id, nativeSessionId, outcome.delta);
    if (sidecarOutcome === "ratcheted") report.sidecar.ratcheted += 1;
    else if (report.sidecar[sidecarOutcome] !== undefined) report.sidecar[sidecarOutcome] += 1;
    else report.sidecar.other[sidecarOutcome] = (report.sidecar.other[sidecarOutcome] ?? 0) + 1;
    if (stateEntry) {
      const record = state.sessions[stateEntry.key];
      const oldLastSeq = record.lastSeq;
      record.events = outcome.events;
      record.prompts = fresh.prompts;
      record.lastSeq = outcome.events - 1;
      record.lastTime = fresh.lastTime;
      if (record.pending && record.pending.lastSeq === oldLastSeq) record.pending.lastSeq = outcome.events - 1;
      report.stateUpdates = (report.stateUpdates ?? 0) + 1;
    }
    report.rebuilt += 1;
    report.byKind[kind].rebuilt += 1;
    report.changes.push({ id, kind, oldPrefix: prefix.length, newPrefix: outcome.prefix, tail: tail.length, delta: outcome.delta, sidecar: sidecarOutcome });
    console.log(`rebuilt ${workspace}/${id} [${kind}] ${what} sidecar=${sidecarOutcome}`);
  }
}

if (apply && state !== null && (report.stateUpdates ?? 0) > 0) {
  const tmp = `${stateFile}.rebuild-tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 1)}\n`);
  renameSync(tmp, stateFile);
  console.log(`state file updated: ${stateFile}`);
}

report.durationMs = Date.now() - started;
report.backupDir = backupDir ?? null;
report.sessionsRoot = sessionsRoot;
console.log(JSON.stringify(report, null, 1));