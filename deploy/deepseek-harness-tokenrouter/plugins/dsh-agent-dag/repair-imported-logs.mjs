#!/usr/bin/env node
// Repair DSH v4 session logs written by an early native-session importer (sessions.js → native.bundle.js).
//
// Those logs fail DSH's history load with either
//   "seed assistant/message at index N has invalid settlement fields"   (no `data.stream`), or
//   "session/title messageSeqs must be empty exactly for a user title"  (fallback title citing nothing),
// or load but cannot be continued: with no `request/header` DSH has no "last used model", and the ACP
// adapter answers every prompt with "New session required". An importer-shaped ACP log with no header gets
// one inside its last step that repeats its latest `model/selection` (later rows move up one seq).
// The current importer writes all three correctly; this tool fixes logs that already exist, in place, so
// events a user appended after the import (continued turns) are kept.
//
//   node repair-imported-logs.mjs [--apply] [--backup-dir DIR] [--dsh-home ~/.dsh] [session-id ...]
//
// Without --apply it only reports. With --apply it copies each original into --backup-dir first, takes the
// session's flock (skips sessions a running Host has open), and atomically replaces the log.
import { execFileSync, spawn } from "node:child_process";
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return undefined; const [, value] = args.splice(i, 2); return value; };
const apply = args.includes("--apply") && args.splice(args.indexOf("--apply"), 1).length > 0;
const backupDir = flag("--backup-dir");
const dshHome = flag("--dsh-home") ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
const only = new Set(args);
if (apply && !backupDir) throw new Error("--apply requires --backup-dir");

/**
 * One checksummed zstd frame holding `text`; DSH writes one frame per log batch and reads them concatenated.
 * Goes through a file: execFileSync with a multi-MB `input` stalls on macOS (child blocked on its stdin).
 */
function zstdFrame(text, scratch) {
  writeFileSync(scratch, text, { mode: 0o600 });
  try { return execFileSync("zstd", ["-c", "-q", "--check", "--", scratch], { maxBuffer: 1 << 30 }); }
  finally { rmSync(scratch, { force: true }); }
}

/** The stream DSH stores beside a settled ACP assistant message: one delta per block, then the finish chunk. */
function streamFor(message, time) {
  const content = Array.isArray(message.content) ? message.content : [];
  const stream = content.map((part, index) => {
    if (part.type === "tool-call") return { type: "tool-call-chunks", time0: time, index, dt: [], id: part.id, name: part.name, args: [part.arguments ?? "{}"] };
    if (part.type === "reasoning") return { type: "reasoning-chunks", time0: time, index, dt: [], texts: [part.text ?? ""] };
    return { type: "text-chunks", time0: time, index, dt: [], texts: [part.text ?? ""] };
  });
  const replayState = message.source?.replayState;
  const hasTools = content.some((part) => part.type === "tool-call");
  stream.push({ type: "chunk", time, chunk: { type: "finish", reason: { kind: hasTools ? "tool-calls" : "stop" }, ...(replayState ? { replayState } : {}) } });
  return stream;
}

/** Event types the native-session importer writes (plus DSH's own seed marker); nothing else refers to a seq. */
const IMPORTER_EVENT_TYPES = new Set(["permission/preset", "sandbox/mode", "approval/policy", "model/selection", "turn/start", "turn/end", "step/start", "step/end", "user/message", "assistant/message", "tool/call", "tool/result", "session/title", "session/end-seed"]);

/** Repair one log's rows. Returns null when nothing needs changing. */
function repairRows(lines) {
  const rows = lines.map((line) => JSON.parse(line));
  const fixes = { stream: 0, title: 0, header: 0 };
  let firstHumanSeq, selection, hasHeader = false, acpReply = false;
  const out = lines.slice();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.type === "user/message" && row.data?.source?.kind === "user" && firstHumanSeq === undefined) firstHumanSeq = row.seq;
    if (row.type === "model/selection") selection = row.data;
    if (row.type === "request/header") hasHeader = true;
    if (row.type === "assistant/message" && String(row.data?.message?.source?.provider ?? "").startsWith("acp-")) acpReply = true;
    if ((row.type === "assistant/message" || row.type === "assistant/attempt") && !Array.isArray(row.data?.stream)) {
      if (row.type === "assistant/attempt") throw new Error(`seq ${row.seq}: assistant/attempt without stream is not an importer row`);
      row.data.stream = streamFor(row.data.message ?? {}, row.time);
      out[i] = JSON.stringify(row);
      fixes.stream += 1;
    } else if (row.type === "session/title" && row.data?.source?.kind !== "user" && Array.isArray(row.data.messageSeqs) && row.data.messageSeqs.length === 0) {
      // DSH requires a non-user title to cite messages; with no human message to cite, the only valid form
      // of the same title is a user title, whose messageSeqs must be empty.
      if (firstHumanSeq === undefined) row.data.source = { kind: "user" };
      else row.data.messageSeqs = [firstHumanSeq];
      out[i] = JSON.stringify(row);
      fixes.title += 1;
    }
  }
  if (!hasHeader && acpReply && selection?.provider?.startsWith("acp-")) {
    // A request/header must sit inside an open turn, so it goes right after the last step/start, and every
    // later row moves up one seq. Only importer-shaped logs are renumbered: their sole seq reference is the
    // title's messageSeqs, so anything else in the log means it is not safe to shift.
    const foreign = rows.slice(1).find((row) => !IMPORTER_EVENT_TYPES.has(row.type));
    if (foreign !== undefined) throw new Error(`seq ${foreign.seq}: ${foreign.type} is not an importer row; cannot insert request/header`);
    const at = rows.findLastIndex((row) => row.type === "step/start");
    const insertSeq = rows[at].seq + 1;
    const header = { type: "request/header", seq: insertSeq, time: rows[at].time, data: { header: { config: selection }, reason: "initial" } };
    const shifted = rows.slice(at + 1).map((row) => {
      const next = { ...row, seq: row.seq + 1 };
      if (row.type === "session/title" && Array.isArray(row.data?.messageSeqs)) next.data = { ...row.data, messageSeqs: row.data.messageSeqs.map((seq) => seq >= insertSeq ? seq + 1 : seq) };
      return JSON.stringify(next);
    });
    out.splice(at + 1, out.length - at - 1, JSON.stringify(header), ...shifted);
    fixes.header = 1;
  }
  return fixes.stream + fixes.title + fixes.header === 0 ? null : { lines: out, fixes };
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

const sessionsRoot = join(dshHome, "sessions");
const report = { scanned: 0, needsRepair: 0, repaired: 0, busy: [], failed: [] };
for (const workspace of readdirSync(sessionsRoot)) {
  const wsDir = join(sessionsRoot, workspace);
  let children;
  try { children = readdirSync(wsDir); } catch { continue; }
  for (const id of children) {
    if (only.size > 0 && !only.has(id)) continue;
    const dir = join(wsDir, id);
    const path = join(dir, "session.v4.jsonl.zstd");
    if (!existsSync(path)) continue;
    report.scanned += 1;
    let lines;
    try {
      const text = execFileSync("zstd", ["-dc", "--", path], { maxBuffer: 1 << 30 }).toString("utf8");
      lines = text.split("\n");
      if (lines.at(-1) === "") lines.pop();
    } catch (error) { report.failed.push({ id, error: `decode: ${error.message}` }); continue; }
    let result;
    try { result = repairRows(lines); } catch (error) { report.failed.push({ id, error: error.message }); continue; }
    if (result === null) continue;
    report.needsRepair += 1;
    console.log(`${apply ? "repair" : "would repair"} ${workspace}/${id}: stream=${result.fixes.stream} title=${result.fixes.title} header=${result.fixes.header}`);
    if (!apply) continue;
    const outcome = await withLease(dir, () => {
      // Re-read under the lease: the log may have grown since the scan.
      const current = execFileSync("zstd", ["-dc", "--", path], { maxBuffer: 1 << 30 }).toString("utf8").split("\n");
      if (current.at(-1) === "") current.pop();
      const fresh = repairRows(current);
      if (fresh === null) return "clean";
      mkdirSync(join(backupDir, workspace, id), { recursive: true });
      copyFileSync(path, join(backupDir, workspace, id, "session.v4.jsonl.zstd"));
      // Same physical layout DSH writes: a header-only checksummed frame, then the events as one frame.
      // Verified through the CLI: node:zlib's zstdDecompressSync stops after the first frame.
      const scratch = `${path}.repair-src`;
      const header = zstdFrame(`${fresh.lines[0]}\n`, scratch);
      const body = zstdFrame(`${fresh.lines.slice(1).join("\n")}\n`, scratch);
      const tmp = `${path}.repair-tmp`;
      const fd = openSync(tmp, "w", 0o600);
      try { writeSync(fd, header); writeSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
      const roundTrip = execFileSync("zstd", ["-dc", "--", tmp], { maxBuffer: 1 << 30 }).toString("utf8");
      if (roundTrip !== `${fresh.lines.join("\n")}\n`) { rmSync(tmp, { force: true }); throw new Error("round-trip mismatch"); }
      renameSync(tmp, path);
      const dirFd = openSync(dir, "r");
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
      return "repaired";
    }).catch((error) => `failed: ${error.message}`);
    if (outcome === "repaired") report.repaired += 1;
    else if (outcome === "busy") report.busy.push(id);
    else if (outcome !== "clean") report.failed.push({ id, error: outcome });
  }
}
console.log(JSON.stringify(report, null, 1));
