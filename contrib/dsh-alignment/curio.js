/**
 * GET /alignment/curio (2026-11-08): what the resident personal session (Curio, plugins/dsh-personal-agent) is doing now,
 * for the Curio band above the alignment board. Read only, per request:
 * - which session is Curio, its hold / stop, cooling models: dsh-personal-agent's state.json (its storageDir; state.active
 *   is the resident session when its role is still "resident");
 * - the Goal (objective, phase, round / cap, blocked reason): the host's goals service for that session's agent;
 * - subagents running now: the same work(sids) the board uses (workspace/session-activity, any depth);
 * - models in use: the tail of today's request log (the main session's last request; its children's last 10 minutes);
 * - the subagent target: dsh-personal-agent's childCap from its loader entry (the config the running plugin has).
 * Milestones and decisions are not here: the page takes them from its own rounds / decisions (First Mate writes them).
 * No personal plugin in this profile, no state file yet, or no resident session: {curio: null} (the page shows no band).
 * A missing / changed host service throws (500 with the message): never a silent empty band.
 */
import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CURIO_API = 1;
export const PERSONAL_PLUGIN = "dsh-personal-agent";
/** How far back "models the subagents use now" looks. */
export const CHILD_WINDOW_MS = 10 * 60_000;
/** Bytes read from the end of today's log (a busy day is a few MB; the last requests are all we need). */
const TAIL_BYTES = 512 * 1024;

const pad = (n) => String(n).padStart(2, "0");
/** Local calendar day, the personal plugin's log file name (lib/money.js localDayKey). */
export const dayKey = (t) => { const d = new Date(t); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
const modelName = (key) => (typeof key === "string" ? key.split("/").pop() : null);

/** dsh-personal-agent's loader entry config, or null when the profile does not load it. Throws on a changed loader. */
export function personalConfig(loader) {
  if (loader === undefined || loader === null || typeof loader.entries !== "function") throw new Error("dsh-alignment: the loader service has no entries() (cordis-plugin-loader changed shape)");
  for (const entry of loader.entries()) {
    if (entry?.options?.name !== PERSONAL_PLUGIN || entry.options.disabled) continue;
    const c = entry.options.config ?? {};
    if (typeof c !== "object") throw new Error("dsh-alignment: " + PERSONAL_PLUGIN + " entry config is " + typeof c);
    return c;
  }
  return null;
}

/** The last `bytes` of a JSONL file as parsed rows (the first, cut line dropped; bad lines skipped); [] when missing. */
export function tailRows(file, bytes = TAIL_BYTES) {
  let fd;
  try { fd = openSync(file, "r"); } catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  try {
    const size = fstatSync(fd).size, start = Math.max(0, size - bytes), buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    const out = [];
    for (const l of lines) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { /* a line being written */ } }
    return out;
  } finally { closeSync(fd); }
}

/**
 * The band's view, from already-read inputs (pure; unit-tested).
 * state = the personal plugin's state.json; goal = goals.get(agent) or null; live = live(sids)[sid]; work = work(sids)[sid];
 * rows = today's log rows; cap = childCap. Returns null when there is no resident session.
 * state values: running (goal active, or no goal and the session runs) | paused (plugin hold / goal paused) | blocked |
 * complete (goal done, waiting for the next one) | stopped (First Mate / user stopped it, breaker, key) | idle (no goal) |
 * unloaded (the host has not loaded the session since a restart, so its Goal cannot be read without resuming it).
 */
export function curioView({ state, goal, live, work, rows, cap, now, loaded = true }) {
  const sid = state?.active;
  const rec = sid ? state.sessions?.[sid] : undefined;
  if (!rec || rec.role !== "resident") return null;
  const runs = live === "running" || live === "subagent" || live === "job";
  const hold = rec.hold ? { reason: rec.hold.reason ?? null, until: rec.hold.until ?? null } : null;
  let st, pause = null;
  if (rec.stopped) { st = "stopped"; pause = { reason: rec.stopped.reason ?? null, until: null }; }
  else if (!goal) st = runs ? "running" : "idle";
  else if (goal.phase === "complete") st = "complete";
  else if (goal.phase === "blocked") { st = "blocked"; pause = { reason: goal.blockedReason?.message ?? null, until: null }; }
  else if (goal.phase === "paused" || hold) { st = "paused"; pause = hold ?? { reason: null, until: null }; }
  else st = "running";
  const mine = rec.goal && goal && rec.goal.id === goal.id ? rec.goal : null;
  const g = goal ? {
    objective: rec.private ? null : String(goal.objective ?? "").replace(/^\s*\[目标\]\s*/, ""),
    phase: goal.phase, round: goal.roundsStarted ?? null, max: goal.maxGoalRounds ?? null,
    since: mine?.at ?? null, evidence: rec.private ? null : mine?.evidence ?? null,
  } : null;
  // models: the main session's last request; its children's requests in the last CHILD_WINDOW_MS
  let main = null;
  const kids = new Map();
  for (const r of rows) {
    if (r?.kind !== "request" || typeof r.served !== "string") continue;
    if (r.sid === sid && (r.source === undefined || r.source === null)) main = { model: modelName(r.served), paid: r.paid === true, at: r.at ?? null };
    else if (r.source === "child" && r.parent === sid && Date.parse(r.at) >= now - CHILD_WINDOW_MS) kids.set(modelName(r.served), (kids.get(modelName(r.served)) ?? 0) + 1);
  }
  const cooling = Object.entries(state.cooldowns ?? {}).filter(([, c]) => typeof c?.until === "number" && c.until > now).map(([k, c]) => ({ model: modelName(k), until: c.until })).sort((a, b) => a.until - b.until);
  return {
    sid, state: loaded || goal ? st : runs ? "running" : "unloaded", goal: g, pause, live: live ?? "idle", private: rec.private === true,
    subagents: work?.subagents?.length ?? 0, cap,
    models: { main, children: [...kids].map(([model, n]) => ({ model, n })).sort((a, b) => b.n - a.n) },
    cooling,
  };
}

/** Reads everything for curioView on each request. deps: loader(), goals(), agents, live, work, home?, now? */
export function curioReader({ loader, goals, agents, live, work, home = process.env.DSH_HOME || join(homedir(), ".dsh"), now = Date.now }) {
  if (typeof agents?.get !== "function") throw new Error("dsh-alignment needs ctx.agents.get for /alignment/curio (DSH API changed)");
  return async () => {
    const cfg = personalConfig(loader());
    if (cfg === null) return null;
    const dir = cfg.storageDir ?? join(home, "storages", "personal-agent");
    let state;
    try { state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")); } catch (error) { if (error?.code === "ENOENT") return null; throw new Error("dsh-alignment: cannot read " + join(dir, "state.json") + ": " + error.message); }
    const sid = state?.active;
    if (!sid || state.sessions?.[sid]?.role !== "resident") return null;
    const svc = goals();
    if (svc !== undefined && typeof svc?.get !== "function") throw new Error("dsh-alignment: ctx.goals.get is not a function (DSH goals service changed shape)");
    const agent = agents.get(sid);
    const goal = svc === undefined || agent === undefined || agent === null ? null : svc.get(agent) ?? null;
    const [lv, wk] = await Promise.all([live([sid]), work([sid])]);
    const t = now();
    const cap = typeof cfg.childCap === "number" ? cfg.childCap : 16; // dsh-personal-agent's own default
    return curioView({ state, goal, live: lv[sid], work: wk[sid], rows: tailRows(join(dir, dayKey(t) + ".jsonl")), cap, now: t, loaded: agent !== undefined && agent !== null });
  };
}

export function curioHandler({ guard, read }) {
  const reply = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(body));
  };
  return async (req, res) => {
    const denied = guard(req);
    if (denied) return reply(res, denied.code, { ok: false, message: denied.message });
    if (req.method !== "GET") return reply(res, 405, { ok: false, message: "不支持的请求" });
    try { return reply(res, 200, { ok: true, api: CURIO_API, curio: await read() }); }
    catch (error) { console.error("[dsh-alignment] curio " + (error?.stack ?? error)); return reply(res, 500, { ok: false, message: "读不到 Curio 的状态：" + (error?.message ?? String(error)) }); }
  };
}
