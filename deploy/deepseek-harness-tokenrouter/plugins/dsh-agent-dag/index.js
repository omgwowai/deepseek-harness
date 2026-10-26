import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startLiveTools } from "./live-tools.js";
import { chatMeterForSource } from "./meter.bundle.js";
import { modelSettings, saveModelSetting } from "./models.js";
import { identityOf, marksOf, startSessions, syncNow } from "./sessions.js";
import { startSharedSkills } from "./skills.js";

export const name = "dsh-agent-dag";
export const inject = ["connection"];
const safeId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;
const present = async path => { try { await access(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };

async function nativeSession(home, id) {
  const root = join(home, "sessions");
  for (const slug of await readdir(root, { withFileTypes: true })) {
    if (!slug.isDirectory()) continue;
    for (const folder of [id, `session-${id}`]) {
      const dir = join(root, slug.name, folder);
      if (await present(join(dir, "session.v4.jsonl.zstd"))) return dir;
    }
  }
  throw new Error("当前 DSH 会话尚未写入 session.v4.jsonl.zstd，发送消息后刷新。");
}

async function externalFile(root, id) {
  if (!await present(root)) return null;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name.endsWith(".jsonl") && (entry.name === `${id}.jsonl` || entry.name.endsWith(`-${id}.jsonl`) || entry.name.endsWith(`_${id}.jsonl`))) return path;
    if (entry.isDirectory()) { const found = await externalFile(path, id); if (found) return found; }
  }
  return null;
}

/** The file Agent DAG reads for a DSH session: its own log, or the bound ACP agent's native transcript. */
async function sessionSource(home, config, id) {
  if (typeof id !== "string" || !safeId.test(id)) throw new Error("无效 DSH session id");
  let source = await nativeSession(home, id), notice = "";
  const database = join(home, "dsh-acp", "sidecar.sqlite");
  if (await present(database)) {
    const db = new DatabaseSync(database, { readOnly: true });
    let binding;
    try { binding = db.prepare("SELECT acp_provider_id, acp_session_id FROM bindings WHERE dsh_session_id = ?").get(id); }
    finally { db.close(); }
    if (binding?.acp_session_id) {
      const agent = String(binding.acp_provider_id ?? "").replace(/^acp-/, "");
      if (!safeId.test(binding.acp_session_id)) throw new Error("ACP adapter 保存的原生 session id 无效");
      let file = null;
      for (const root of config.externalRoots?.[agent] ?? []) { file = await externalFile(root, binding.acp_session_id); if (file) break; }
      if (file) source = file;
      else notice = `ACP ${agent} 原生会话文件尚不可定位；当前显示 DSH 保存的会话，外部工具/思考细节可能仅在 ACP 诊断中。`;
    }
  }
  return { source, notice };
}

export async function panelEntry(home, config, id) {
  const { source, notice } = await sessionSource(home, config, id);
  const token = (await readFile(config.tokenFile, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Agent DAG token 文件无效，请重载 Paseo 插件。");
  const url = new URL(config.panelUrl ?? "http://127.0.0.1:6795/");
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("面板只允许本机 127.0.0.1 HTTP 服务");
  url.searchParams.set("source", source);
  url.searchParams.set("embed", "dsh");
  url.hash = `token=${token}`;
  return { url: url.href, notice, source };
}

/** Current gateway channel per agent, from the Paseo agent-dag service (it holds the TokenRouter key). */
async function channelsFor(config, source, running) {
  const token = (await readFile(config.tokenFile, "utf8")).trim();
  const url = new URL("/rpc/dag.channels.source", config.panelUrl ?? "http://127.0.0.1:6795/");
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("面板只允许本机 127.0.0.1 HTTP 服务");
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "x-agent-dag-token": token }, body: JSON.stringify({ source, running }), signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Agent DAG 服务 HTTP ${response.status}`);
  return response.json();
}

/** Footer stats for a session; `running` comes from DSH's projection, not the files. */
export async function meterEntry(home, config, payload) {
  const { source, notice } = await sessionSource(home, config, payload?.sessionId);
  const running = payload?.running === true;
  const { meter, familyAverages } = await chatMeterForSource(source, { running });
  // Sessions on DeepSeek's official API (priced in USD) never touch the gateway.
  const direct = meter.status === "ok" && meter.session.family.currency === "USD";
  let channels = null, channelError = "";
  if (meter.status === "ok" && !direct) {
    try { channels = await channelsFor(config, source, running); } catch (error) { channelError = error.message; }
  }
  return { meter, familyAverages, direct, channels, channelError, notice };
}

function rpc(ctx, config, method, handler) {
  ctx.effect(() => ctx.connection.fetch.register({ path: `/api/${method}`, methods: ["POST"], requestBody: "buffered", fetch: async request => {
    const envelope = await request.json();
    if (envelope?.type !== "client-request" || envelope.method !== method || typeof envelope.rpcId !== "string") return new Response("无效 RPC 请求", { status: 400 });
    let result;
    try {
      const homePath = ctx.get("dshHomePath");
      if (typeof homePath !== "function") throw new Error("DSH home 服务不可用");
      result = { ok: true, value: await handler(homePath(), config, envelope.payload) };
    } catch (error) { result = { ok: false, error: { code: "agent-dag/unavailable", message: error.message, details: {} } }; }
    return Response.json({ type: "server-response", rpcId: envelope.rpcId, result }, { headers: { "Cache-Control": "no-store" } });
  } }));
}

export function apply(ctx, config) {
  // Native Claude Code / Codex / Oh My Pi sessions of every workspace folder, imported as DSH sessions.
  // Native-only ACP tool lists are the adapter's own default now (`teamBridge: false` in the fork's
  // config; opt back in there with `teamBridge: true`) — this plugin no longer patches the llm registry.
  const sessions = startSessions(ctx, config);
  // ~/.agents/skills is shared by every code agent; Claude Code gets each shared skill linked into its own root.
  startSharedSkills(ctx, config);
  // Tool rows for live ACP turns: the adapter hands back only the outer stream, so the log gets them here.
  // `liveTools: false` drops the supplement (a bench proving an adapter that records rows natively
  // must see only that adapter's own rows; the stored-log repair scan is gone with it).
  const live = config.liveTools === false ? undefined : startLiveTools(ctx, config);
  rpc(ctx, config, "agent-dag/url", (home, config, payload) => panelEntry(home, config, payload?.sessionId));
  rpc(ctx, config, "agent-dag/meter", meterEntry);
  rpc(ctx, config, "agent-dag/sessionMarks", (home, config, payload) => marksOf(sessions, payload));
  // The header's copy chips: which native agent session an ACP-bound session resumes.
  rpc(ctx, config, "agent-dag/sessionIdentity", (home, config, payload) => identityOf(sessions, payload));
  rpc(ctx, config, "agent-dag/sessionsSync", () => syncNow(sessions));
  // Live ACP tool-row supplement: report the last passes, or run one repair scan with `{backfill: true}`.
  rpc(ctx, config, "agent-dag/liveTools", (home, config, payload) =>
    live === undefined
      ? { at: null, disabled: true, scheduled: 0, appended: 0, backfilled: 0, turns: 0, skipped: 0, scanned: 0, failed: [], error: null }
      : live.report(payload));
  // Code-agent model defaults: read every agent's main/subagent model, and write one of them.
  rpc(ctx, config, "agent-model/read", (home, config, payload) => modelSettings(ctx, home, payload));
  rpc(ctx, config, "agent-model/save", (home, config, payload) => saveModelSetting(ctx, home, payload));
}
