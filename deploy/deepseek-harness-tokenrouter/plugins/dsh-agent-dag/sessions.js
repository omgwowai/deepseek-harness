// Every agent's sessions of a workspace, inside DeepSeek Harness.
//
// DSH lists a workspace's sessions from the workspace registry, and the registry only accounts a session
// whose stored log it can read (`sessions/<slug>/<id>/session.v4.jsonl.zstd`, first zstd frame = the
// Native Claude Code / Codex / Oh My Pi sessions are not DSH logs, so this module
// imports each family root as a real DSH v4 session through the host's own services — the session
// persistence backend writes the log, the workspace registry owns membership, the projection cache owns
// titles — and records the ACP binding that makes continuing the session resume the native transcript.
//
// An agent kind can list several roots (`externalRoots[kind]`): every root is scanned, the same native
// session found in more than one root is imported once (the copy in the root the ACP profile reads —
// `nativeHomes[kind]` — wins), and only sessions of that resumable root can carry an ACP binding.
// Sessions already bound to the ACP route whose own file lives only in another root (the Paseo omp home)
// are hard-linked into the ACP home under the same relative path, so continuing them still resumes the
// same native transcript (see `ensureBoundVisible`).
//
// It runs in the plugin host (never a separate process): the app owns workspace.json and the session
// store, so the same in-process services must do the writing, and the plugin's own state file keeps the
// import idempotent (one DSH session per native session, per agent kind).
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { link, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdDecompressSync } from "node:zlib";
import { acpFor, nativeSessions, transcriptFor } from "./native.bundle.js";
import { sessionIdentity } from "./identity.js";

/** Native agents the sidebar can import, and the reader home each one keeps its sessions in. */
const NATIVE_AGENTS = ["claude", "codex", "omp"];
/** Native sessions examined per workspace and agent in one scan. */
const SCAN_LIMIT = 200;
const SCAN_INTERVAL_MS = 60_000;
/** How long a newly started native session waits before import (the adapter binds its own sessions within it). */
const FRESH_NATIVE_MS = 2 * 60_000;
const STATE_DIR = "dsh-agent-dag";
const ZSTD_MAGIC = 0xfd2fb528;
/** Binding outcomes a later scan retries: the sidecar, or a template row for the route, may not exist yet. */
const RETRYABLE_BINDING = new Set(["no-sidecar", "unavailable", "no-template"]);

/** Zstandard frame boundaries in one log: DSH's reader never merges frames, and requires the first to be the header alone. */
function zstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid zstd frame magic at byte ${offset}`);
    offset += 4;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    for (;;) {
      if (buffer.length - offset < 3) return frames;
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      if (blockType === 3) throw new Error(`reserved zstd block type at byte ${offset - 3}`);
      offset += blockType === 1 ? 1 : blockHeader >>> 3;
      if (lastBlock) break;
    }
    if (checksum) offset += 4;
    frames.push({ start, end: offset });
  }
  return frames;
}

/**
 * What one stored log looks like to DSH's reader: `ok` (listable), `legacy` (one frame holding the whole
 * log — the shape an older importer wrote, invisible to DSH), or `broken` (unreadable, left untouched).
 */
function logState(path) {
  let buffer;
  try { buffer = readFileSync(path); } catch { return "missing"; }
  let frames;
  try { frames = zstdFrames(buffer); } catch { return "broken"; }
  if (frames.length === 0) return "broken";
  try {
    const header = zstdDecompressSync(buffer.subarray(frames[0].start, frames[0].end)).toString("utf8");
    if (header.endsWith("\n") && header.indexOf("\n") === header.length - 1) return "ok";
  } catch { return "broken"; }
  return frames.length === 1 ? "legacy" : "broken";
}

/** The agent behind one ACP route id ("acp-omp" → "omp"; anything else is DSH's own agent). */
function kindOfRoute(provider) {
  const kind = String(provider ?? "").replace(/^acp-/, "");
  return NATIVE_AGENTS.includes(kind) ? kind : "dsh";
}

/** The newest binding payload for one ACP route: the template an imported session's binding is cloned from. */
function bindingTemplate(database, provider) {
  const row = database.prepare("SELECT payload FROM bindings WHERE acp_provider_id = ? ORDER BY time DESC LIMIT 1").get(provider);
  if (!row?.payload) return null;
  try { return JSON.parse(row.payload); } catch { return null; }
}

/**
 * Point one ACP route at an existing native session, so the session's next prompt resumes that transcript.
 * Returns `written`/`kept` on success and, when the binding cannot be established, a reason the caller
 * reports. A missing or unreadable sidecar is `no-sidecar`/`unavailable` — retryable, never fatal: DSH
 * starts without the adapter's sidecar, and a session imported then must still be remembered.
 */
function writeBinding(home, record) {
  const file = join(home, "dsh-acp", "sidecar.sqlite");
  if (!existsSync(file)) return "no-sidecar";
  let database;
  try { database = new DatabaseSync(file); }
  catch { return "unavailable"; }
  try {
    const existing = database.prepare("SELECT acp_session_id FROM bindings WHERE dsh_session_id = ?").get(record.dshSessionId);
    if (existing) return existing.acp_session_id === record.nativeSessionId ? "kept" : "conflict";
    const template = bindingTemplate(database, record.provider);
    if (!template) return "no-template";
    const payload = {
      ...template,
      provider: record.provider,
      profileId: record.profile,
      agentSessionId: record.nativeSessionId,
      canonicalCwd: record.cwd,
      establishedAt: record.lastTime,
      dshCommittedSeq: record.lastSeq,
      historyBaseSeq: record.lastSeq,
      committedPromptOrdinal: record.prompts,
      generation: 1,
      bindingEpoch: 1,
    };
    database.prepare("INSERT OR REPLACE INTO bindings (dsh_session_id, time, acp_provider_id, acp_session_id, payload) VALUES (?, ?, ?, ?, ?)")
      .run(record.dshSessionId, record.lastTime, record.provider, record.nativeSessionId, JSON.stringify(payload));
    return "written";
  } finally { database.close(); }
}

/** Every binding the ACP adapter holds, as `<kind>:<native session>` → its DSH session. */
function bindingIndex(home) {
  const index = new Map();
  try {
    const database = new DatabaseSync(join(home, "dsh-acp", "sidecar.sqlite"), { readOnly: true });
    try {
      // Oldest first, so when two bindings name one native session the latest (the adapter's own) wins.
      for (const row of database.prepare("SELECT dsh_session_id, acp_provider_id, acp_session_id FROM bindings ORDER BY time").all()) {
        const kind = kindOfRoute(row.acp_provider_id);
        if (kind !== "dsh" && row.acp_session_id) index.set(`${kind}:${row.acp_session_id}`, { dshSessionId: row.dsh_session_id, acpProviderId: row.acp_provider_id, nativeSessionId: row.acp_session_id, source: "binding" });
      }
    } finally { database.close(); }
  } catch { /* no sidecar yet: nothing was ever bound */ }
  return index;
}

/** Live ACP bindings as `<DSH session id>` → the kind and native session the session resumes. */
function bindingIdentities(home) {
  const identities = {};
  for (const entry of bindingIndex(home).values()) identities[entry.dshSessionId] = { kind: kindOfRoute(entry.acpProviderId), nativeSessionId: entry.nativeSessionId };
  return identities;
}

/** One native session's own file under `root`, by filename: Claude/omp name it `<stamp>_<id>.jsonl`, Codex `<rollout>-<id>.jsonl`. */
async function sessionFilesIn(root, sessionId) {
  const found = [];
  async function walk(dir, depth) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (depth < 3) await walk(path, depth + 1); continue; }
      if (entry.name === `${sessionId}.jsonl` || entry.name.endsWith(`_${sessionId}.jsonl`) || entry.name.endsWith(`-${sessionId}.jsonl`)) found.push(path);
    }
  }
  await walk(root, 0);
  return found;
}

/**
 * A bound session can only resume where its ACP agent reads the session home; one whose file lives only
 * in another root (the Paseo omp home) would fail to resume with "ACP session not found". Hard-link each
 * such file into the ACP home under the same relative path — the same per-cwd directory the agent lists —
 * so both homes share one file and an append through either grows the same transcript. A symlink is not
 * usable: the agent lists sessions with Bun.Glob, which skips symlinked files (verified), so a symlinked
 * session would never be found. Idempotent; a file already readable in the ACP home is left alone.
 */
async function ensureBoundVisible(home, roots, report) {
  for (const key of bindingIndex(home).keys()) {
    const colon = key.indexOf(":");
    const kind = key.slice(0, colon), sessionId = key.slice(colon + 1);
    const kindRoots = roots[kind];
    if (!kindRoots || kindRoots.length < 2) continue;
    const target = kindRoots.find(root => root.resumable);
    const sources = kindRoots.filter(root => !root.resumable);
    if (!target || sources.length === 0) continue;
    if ((await sessionFilesIn(target.root, sessionId)).length > 0) continue;
    for (const source of sources) {
      const files = await sessionFilesIn(source.root, sessionId);
      if (files.length === 0) continue;
      const from = files[0], to = join(target.root, relative(source.root, from));
      try {
        await mkdir(dirname(to), { recursive: true });
        await link(from, to);
        report.linked += 1;
      } catch (error) {
        if (error?.code !== "EEXIST") report.failed.push({ key, message: `已绑定会话在 ACP home 无法就位（继续时会找不到原生会话）：${String(error?.message ?? error)}` });
      }
      break;
    }
  }
}

/**
 * The model a route can restore right now, for one native session's own model: DSH only resumes a session
 * whose recorded `model/selection` still exists in the route's catalog, and the ACP routes carry whatever
 * their agent CLI listed (ids move between versions).
 */
async function routeModel(ctx, provider, nativeModel) {
  const llm = ctx.get("llm");
  if (!llm || typeof llm.listModels !== "function" || typeof nativeModel !== "string" || nativeModel === "") return null;
  let models;
  try { models = await llm.listModels(provider); } catch { return null; }
  if (!Array.isArray(models) || models.length === 0) return null;
  const ids = models.map(model => String(model.id));
  const bare = nativeModel.replace(/^tokenrouter\//, "");
  // Claude's ACP catalog names models by alias ("opus" = "Opus 5.5 via proxy"), so a native id such as
  // claude-opus-5.5 is matched by its family + version words in the display name when no id matches.
  const words = bare.toLowerCase().split(/[-_\s]+/).filter(word => word !== "" && word !== "claude");
  const byName = models.find(model => { const name = ` ${String(model.name ?? "").toLowerCase()} `; return words.length > 0 && words.every(word => name.includes(` ${word} `)); });
  const matched = ids.includes(nativeModel) ? nativeModel : ids.includes(bare) ? bare : ids.find(id => id.endsWith(`/${bare}`)) ?? (byName ? String(byName.id) : undefined);
  const chosen = matched ?? ids[0];
  const efforts = models.find(model => String(model.id) === chosen)?.reasoning?.efforts?.map(effort => String(effort.id)) ?? [];
  let effort = models.find(model => String(model.id) === chosen)?.reasoning?.defaultEffort ?? efforts[0];
  // The gateway rejects Codex `max`; keep that route inside low/medium.
  if (provider === "acp-codex" && effort === "max") effort = efforts.includes("low") ? "low" : efforts.includes("medium") ? "medium" : effort;
  return { model: chosen, effort, source: matched !== undefined ? "mapped" : "first-model" };
}

/**
 * Every session root per agent kind, in config order: `root` is the directory to read, `home` the native
 * home that root belongs to, and `resumable` whether the ACP profile reads that same home — only then can
 * a binding written for a session from that root resume it. Exported so tooling (and the acceptance
 * dry-run) reads the same roots the importer does.
 */
export function nativeRoots(config) {
  const result = {};
  for (const kind of NATIVE_AGENTS) {
    const roots = Array.isArray(config.externalRoots?.[kind]) ? config.externalRoots[kind].filter(root => typeof root === "string" && root.length > 0) : [];
    if (roots.length === 0) continue;
    const profileHome = config.nativeHomes?.[kind];
    result[kind] = roots.map(root => ({ root, home: dirname(root), resumable: profileHome === undefined || resolve(profileHome) === resolve(dirname(root)) }));
  }
  return result;
}

/**
 * Start the native-session import for every workspace of this host. Scans at startup, on an interval, and
 * on demand (`sync()`); never throws for one session: every failure lands in the returned status.
 */
export function startSessions(ctx, config) {
  const homePath = ctx.get("dshHomePath");
  const home = typeof homePath === "function" ? homePath() : String(homePath ?? "");
  const stateFile = join(home, STATE_DIR, "native-import.json");
  const status = { version: 0, at: null, running: false, workspaces: 0, native: 0, imported: 0, repaired: 0, bound: 0, linked: 0, failed: [], error: null, lastError: null, kinds: {}, nativeIds: {}, stateFile };
  let tail = Promise.resolve();

  const agents = () => nativeRoots(config);

  async function importOne(persistence, entity, state, session, agent, report) {
    const key = `${session.kind}:${session.sessionId}`;
    const known = state.sessions[key];
    const dshId = known?.dshSessionId ?? `session-${randomUUID()}`;
    if (known) await rm(dirname(persistence.locate({ id: dshId, cwd: entity.path }).path), { recursive: true, force: true });
    const base = acpFor(session.kind, config.acpModels?.[session.kind]);
    if (!base) throw new Error(`${session.kind} 不在 ACP 适配器支持范围内`);
    const route = config.acpModels?.[session.kind] ? null : await routeModel(ctx, base.provider, session.model ?? "");
    const acp = route ? { ...base, model: route.model, ...(route.effort ? { effort: route.effort } : {}) } : base;
    const bound = agent.resumable ? { agentSessionId: session.sessionId } : null;
    const transcript = await transcriptFor({ kind: session.kind, home: agent.home, sessionId: session.sessionId, cwd: entity.path, dshId, acp, bound });
    const handle = await persistence.create(transcript.header);
    try {
      await handle.append(transcript.events);
      await handle.flush();
    } finally { await handle.close(); }
    state.sessions[key] = { dshSessionId: dshId, cwd: entity.path, kind: session.kind, at: new Date().toISOString(), events: transcript.events.length, prompts: transcript.prompts, nativeModel: session.model ?? null, model: route ? route.model : acp.model, modelSource: route ? route.source : "config" };
    try { ctx.get("sessionProjectionCache")?.coldSnapshot(transcript.header, 0, transcript.events); }
    catch (error) { ctx.logger?.warn?.(`agent-dag: 会话 ${dshId} 的投影写入失败，标题由 DSH 稍后生成：${String(error?.message ?? error)}`); }
    try { await entity.attachSession(dshId); }
    catch (error) { report.failed.push({ key, message: `加入工作区失败，下次扫描重试：${String(error?.message ?? error)}` }); }
    // Attach and binding are side effects of a completed import, never part of its success: an import
    // that is not recorded in the state file is re-imported 60 s later as a duplicate native session.
    // Only a root the ACP profile itself reads can be bound; a session from another root stays a
    // visibility-only import, and continuing it starts a new native session rather than a broken resume.
    if (agent.resumable) bind(home, acp, { dshSessionId: dshId, nativeSessionId: session.sessionId, cwd: entity.path, lastSeq: transcript.lastSeq, prompts: transcript.prompts, lastTime: transcript.lastTime }, state.sessions[key], report, key);
    else state.sessions[key].binding = "not-resumable";
    report.imported += 1;
    if (known) report.repaired += 1;
  }

  /**
   * Point one imported session at its native transcript, keeping the retry payload when the binding
   * cannot be written yet (no sidecar / no template row). Never throws.
   */
  function bind(home, acp, record, entry, report, key) {
    let result;
    try { result = writeBinding(home, { ...acp, ...record }); }
    catch (error) { result = "unavailable"; report.failed.push({ key, message: `绑定写入失败，稍后重试：${String(error?.message ?? error)}` }); }
    entry.binding = result;
    if (RETRYABLE_BINDING.has(result)) entry.pending = { lastSeq: record.lastSeq, prompts: record.prompts, lastTime: record.lastTime };
    else delete entry.pending;
    if (result === "written") report.bound += 1;
    // A retryable outcome is not a failure the user must act on: it self-heals once the sidecar (or the
    // route's template row) exists, and reporting it every scan would only flood the plugin log.
    if (result === "conflict") report.failed.push({ key, message: `绑定未建立（${result}）：继续会话会新建原生会话` });
    return result;
  }

  async function scan(report) {
    const persistence = ctx.get("sessionPersistence");
    const registry = ctx.get("workspaceRegistry");
    if (!persistence || !registry) throw new Error("会话持久化或工作区服务不可用");
    const roots = agents();
    const state = await readState(stateFile);
    for (const [key, entry] of bindingIndex(home)) if (!state.sessions[key]) state.sessions[key] = { dshSessionId: entry.dshSessionId, cwd: null, kind: key.slice(0, key.indexOf(":")), at: new Date().toISOString(), source: entry.source };
    const listed = new Set((await persistence.list()).map(snapshot => snapshot.header.id));
    let changed = false;
    // Bound sessions must stay resumable through the home switch: link them into the ACP home before
    // the workspace scan so the links are part of this pass.
    await ensureBoundVisible(home, roots, report);
    for (const entity of registry.list()) {
      report.workspaces += 1;
      for (const kind of Object.keys(roots)) {
        // Read every root, then keep one copy per native session: the root the ACP profile reads wins,
        // and a session only its home's list can see (the other home's copy) is imported once.
        const chosen = new Map();
        for (const agent of roots[kind]) {
          let found;
          try { found = await nativeSessions(kind, agent.home, entity.path, SCAN_LIMIT); }
          catch (error) { report.failed.push({ key: `${kind}:${entity.path}`, message: `读取 ${agent.home} 失败：${String(error?.message ?? error)}` }); continue; }
          for (const session of found) {
            const key = `${kind}:${session.sessionId}`;
            const prior = chosen.get(key);
            if (!prior || (!prior.agent.resumable && agent.resumable)) chosen.set(key, { session, agent });
          }
        }
        for (const { session, agent } of chosen.values()) {
          report.native += 1;
          const key = `${kind}:${session.sessionId}`;
          const known = state.sessions[key];
          if (known?.dshSessionId && listed.has(known.dshSessionId)) {
            try { await entity.attachSession(known.dshSessionId); } catch (error) { report.failed.push({ key, message: `加入工作区失败：${String(error?.message ?? error)}` }); }
            continue;
          }
          // A native session that just started may be one the ACP adapter is creating right now (a new or
          // branched ACP session): its binding lands a moment after the transcript appears. Importing it then
          // duplicates the session and leaves two bindings for one native session. Leave it to a later pass;
          // by then a binding exists (merged into state above) if the adapter owns it.
          if (!known && Date.now() - Date.parse(session.start ?? "") < FRESH_NATIVE_MS) continue;
          if (known) {
            const shape = logState(persistence.locate({ id: known.dshSessionId, cwd: entity.path }).path);
            if (shape === "broken") { report.failed.push({ key, message: "已导入的日志不可读且不是本插件的旧格式，保持原样（请人工检查）" }); continue; }
          }
          try {
            await importOne(persistence, entity, state, { ...session, kind }, agent, report);
            changed = true;
          } catch (error) { report.failed.push({ key, message: String(error?.message ?? error) }); }
        }
      }
    }
    // Bindings that could not be written at import time (sidecar or template missing) are filled in
    // as soon as the sidecar exists; the session keeps its DSH id, so this never re-imports anything.
    for (const [key, entry] of Object.entries(state.sessions)) {
      if (!entry.pending || !entry.cwd || entry.binding === "written" || entry.binding === "kept") continue;
      const colon = key.indexOf(":");
      const base = acpFor(key.slice(0, colon), config.acpModels?.[key.slice(0, colon)]);
      if (!base) continue;
      const result = bind(home, base, { dshSessionId: entry.dshSessionId, nativeSessionId: key.slice(colon + 1), cwd: entry.cwd, ...entry.pending }, entry, report, key);
      if (!RETRYABLE_BINDING.has(result)) changed = true;
    }
    if (changed) await writeState(stateFile, state);
    status.kinds = Object.fromEntries(Object.values(state.sessions).filter(entry => entry.dshSessionId).map(entry => [entry.dshSessionId, entry.kind]));
    status.nativeIds = Object.fromEntries(Object.entries(state.sessions).filter(([, entry]) => entry.dshSessionId).map(([key, entry]) => [entry.dshSessionId, { kind: entry.kind, nativeSessionId: key.slice(key.indexOf(":") + 1) }]));
    status.at = new Date().toISOString();
    if (changed) status.version += 1;
  }

  /** One serialized pass: concurrent callers share the running scan. */
  const sync = () => tail = tail.then(async () => {
    const report = { workspaces: 0, native: 0, imported: 0, repaired: 0, bound: 0, linked: 0, failed: [], error: null };
    status.running = true;
    try { await scan(report); status.error = null; }
    catch (error) { status.error = String(error?.message ?? error); status.lastError = status.error; }
    finally {
      status.running = false;
      status.workspaces = report.workspaces;
      status.native = report.native;
      status.imported = report.imported;
      status.repaired = report.repaired;
      status.bound = report.bound;
      status.linked = report.linked;
      status.failed = report.failed;
      if (report.failed.length > 0) warn(new Error(`${report.failed.length} 个会话未导入：${report.failed[0].key} — ${report.failed[0].message}`));
    }
    return status;
  });

  const warn = (error) => ctx.logger?.warn?.(`agent-dag: 原生会话同步失败：${String(error?.message ?? error)}`);
  /**
   * Which agent each requested DSH session belongs to: an imported native session keeps its kind, a session
   * the ACP adapter bound at runtime is that route's kind, everything else is DSH's own agent.
   */
  const kinds = (ids) => {
    const live = bindingIndex(home);
    const byId = new Map();
    for (const entry of live.values()) byId.set(entry.dshSessionId, kindOfRoute(entry.acpProviderId));
    const result = {};
    for (const id of ids) result[id] = status.kinds[id] ?? byId.get(id) ?? "dsh";
    return result;
  };
  /** The identifiers of one session: its kind and, for an ACP-bound session, the native agent session id. */
  const identity = (id) => sessionIdentity(status.nativeIds, bindingIdentities(home), id);
  const fiber = ctx.inject(["sessionPersistence", "workspaceRegistry", "sessionProjectionCache"], () => {
    sync().catch(warn);
    const timer = setInterval(() => { sync().catch(warn); }, SCAN_INTERVAL_MS);
    ctx.effect(() => () => clearInterval(timer), "agent-dag:native-refresh");
  });
  ctx.effect(() => () => fiber.dispose?.(), "agent-dag:native-sessions");
  return { sync, kinds, identity, status, stateFile };
}

/**
 * Panel RPC: the agent behind each session the sidebar is showing, plus the sync version the panel polls
 * to know that a new session was imported and its session list should reload.
 */
export function marksOf(handle, payload) {
  const requested = Array.isArray(payload?.sessionIds) ? payload.sessionIds : [];
  const ids = requested.filter(id => typeof id === "string" && id.length <= 256).slice(0, 4000);
  return {
    kinds: handle.kinds(ids),
    version: handle.status.version,
    imported: handle.status.imported,
    repaired: handle.status.repaired,
    bound: handle.status.bound,
    running: handle.status.running,
    error: handle.status.error,
    lastError: handle.status.lastError,
    failed: handle.status.failed.slice(0, 5),
  };
}

/**
 * Panel RPC: the identifiers of one session — its kind, and the native agent session id when it is
 * ACP-bound. The header's copy chips ask per session; an unknown id stays DSH's own agent with no
 * native id rather than failing the click.
 */
export function identityOf(handle, payload) {
  const id = typeof payload?.sessionId === "string" ? payload.sessionId : "";
  return handle.identity(id);
}

/** Panel RPC: run one import pass now and report how it went. */
export async function syncNow(handle) {
  await handle.sync();
  const status = handle.status;
  return {
    version: handle.status.version,
    workspaces: status.workspaces,
    native: status.native,
    imported: status.imported,
    repaired: status.repaired,
    bound: status.bound,
    linked: status.linked,
    failed: status.failed.slice(0, 5),
    error: status.error,
    lastError: status.lastError,
    stateFile: status.stateFile,
  };
}

async function readState(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return { version: 1, sessions: {} }; }
}

async function writeState(file, state) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 1));
  await rename(tmp, file);
}