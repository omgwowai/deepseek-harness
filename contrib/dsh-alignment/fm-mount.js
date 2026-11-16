/**
 * Mounts the First Mate controls of fm-refresh.js on the real host: the First Mate resolver (one rule for "the current
 * First Mate", fm/current.js), host adapters for the four steps, activity events that restart the quiet
 * clock, and the /alignment/fm routes. config: fmRoot (required: the First Mate working
 * directory; index.js passes the plugin config firstMate.root), fmPage (default "first-mate"), quietMs.
 * The reasoning effort of the sessions First Mate dispatches (2026-11-03, set next to 「刷新 First Mate」) is owned by
 * dsh-workspace-effort (ctx.workspaceEffort): GET /alignment/fm carries its view as `effort`, POST /alignment/fm/effort
 * {reasoningEffort} sets it.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createFmResolver } from "./fm/current.js";
import { FM_TITLE, bootPrompt, busyOf, createRefresher, moveReminders, recordStore, scheduleShape } from "./fm-refresh.js";

const run = promisify(execFile);
export const BOOT_PROMPT_FILE = fileURLToPath(new URL("./fm-boot-prompt.md", import.meta.url));
export const RECORD_FILE = () => join(process.env.ALIGN_STORE || join(process.env.DSH_HOME || join(homedir(), ".dsh"), "storages", "alignment-page"), "fm-refresh.json");
const WAIT_FM_MS = 60_000;
const FM_FRESH_MS = 10_000;
const EFFORT_WAIT_MS = 3_000;

/** The top-level session sid belongs to: itself, or the root of its subagent lineage. */
function rootOf(agents, sid) {
  let id = sid;
  for (let i = 0; i < 32; i += 1) {
    const header = agents.get(id)?.session?.header;
    if (header?.origin !== "subagent" || header.parentSession === undefined) return id;
    id = header.parentSession;
  }
  return id;
}

export function mountFmRoutes(ctx, { guard, alignMjs, pageData, config = {}, log = () => {} }) {
  const root = config.fmRoot;
  if (typeof root !== "string" || root.length === 0) throw new Error("dsh-alignment First Mate controls need config fmRoot (plugin config firstMate.root)");
  const page = config.fmPage ?? "first-mate";
  for (const [k, v] of Object.entries({ "sessionController.create": ctx.sessionController?.create, "sessionController.rename": ctx.sessionController?.rename, "sessionController.prompt": ctx.sessionController?.prompt, "workspaceRegistry.archiveSession": ctx.workspaceRegistry?.archiveSession, "workspaceRegistry.resolveByPath": ctx.workspaceRegistry?.resolveByPath, "jobs.list": ctx.jobs?.list, "agents.list": ctx.agents?.list })) {
    if (typeof v !== "function") throw new Error("dsh-alignment First Mate refresh needs ctx." + k + " (DSH service missing or changed shape)");
  }
  // ctx.schedule: one of the two known method sets (0.2.2-alpha.2 session reminders / alpha.3 Host tasks), else throws here.
  scheduleShape(ctx.schedule);
  // The registration is this page's owner (fm/current.js): read through the same align module the routes use.
  const resolver = createFmResolver(ctx, { root, page, registered: () => pageData(page).owner });
  const abort = new AbortController();
  const host = { waterfall: (...a) => ctx.waterfall(...a), agents: ctx.agents, jobs: ctx.jobs };

  const refresher = createRefresher({
    store: recordStore(RECORD_FILE()),
    page,
    quietMs: config.quietMs,
    log,
    // The session the refresh replaces: the registered one, also when it is archived (2026-10-24: an archived
    // registered First Mate is an error everywhere else, and the refresh is the way out).
    currentFm: () => resolver.registeredFm(),
    busy: (sid) => busyOf(host, sid),
    prompt: (oldSid) => bootPrompt(BOOT_PROMPT_FILE, { oldSid, page, root }),
    async createFm(text) {
      const registry = ctx.workspaceRegistry;
      const workspace = (await registry.resolveByPath(root)) ?? (await registry.create(root));
      const { sessionId } = await ctx.sessionController.create({ workspaceId: workspace.id });
      await ctx.sessionController.rename({ sessionId, title: FM_TITLE });
      // A plain prompt (source "user"), not a threads envelope: the resolver counts the session as First Mate (origin null).
      await ctx.sessionController.prompt({ sessionId, requestId: "fm-refresh-" + randomUUID(), mode: "queue", content: [{ type: "text", text }] }, abort.signal);
      return sessionId;
    },
    // Before it is registered: the new session is listed, no longer blank, and a First Mate by origin (not a worker).
    async waitFm(sid) {
      const end = Date.now() + WAIT_FM_MS;
      let last;
      for (;;) {
        const row = (await resolver.sessionRows()).find((r) => r.sessionId === sid);
        last = row === undefined ? "不在会话列表里" : row.blank === true ? "还是空白会话" : (await resolver.isFmSession(sid)) ? null : "不符合 First Mate 规则";
        if (last === null) return;
        if (Date.now() > end) throw new Error("新会话 " + sid + " 建好了，但 " + WAIT_FM_MS / 1000 + " 秒内没有准备好（" + last + "）");
        await new Promise((r) => setTimeout(r, 300));
      }
    },
    // The owner step IS the registration: the new session is the current First Mate from this write on.
    async setOwner(sid) {
      try {
        await run(process.execPath, [alignMjs, "meta", page, "owner=" + sid], { env: process.env, windowsHide: true });
      } catch (e) {
        throw new Error("align meta " + page + " owner=" + sid + " 失败：" + ((e.stderr || "").trim() || e.message));
      }
      const owner = pageData(page).owner;
      if (owner !== sid) throw new Error("align meta 之后对齐页 owner 是 " + owner + "，不是 " + sid);
      const fm = await resolver.current();
      if (fm.sid !== sid) throw new Error("登记改成 " + sid + " 之后，当前 First Mate 仍是 " + fm.sid);
    },
    moveReminders: (from, to) => moveReminders(ctx.schedule, from, to, abort.signal),
    archive: async (sid) => { if (!resolver.archivedIds().has(sid)) await ctx.workspaceRegistry.archiveSession(sid, { stopActivity: true }); },
  });

  const touch = (sid) => { if (typeof sid === "string") refresher.touch(rootOf(ctx.agents, sid)); };
  ctx.on("session/event", (session, event) => { if (/^(turn|job|subagent)\//.test(event?.type ?? "")) touch(session?.id); });
  ctx.on("agent/status", (payload) => touch(payload?.agent?.id));
  ctx.on("subagent/end", (info) => touch(info?.id));
  ctx.effect(() => { refresher.start(); return () => { refresher.dispose(); abort.abort(); }; }, "dsh-alignment: First Mate refresh");

  const reply = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(body));
  };
  async function readJson(req) {
    let raw = "";
    for await (const c of req) { raw += c; if (raw.length > 4096) return undefined; }
    try { return JSON.parse(raw); } catch { return undefined; }
  }

  // GET /alignment/fm for the page buttons. resolver.current() listed every session (27-107 s on main with
  // ~1k sessions, 2026-10-24; it now reads only the registered session) and every open page polled every 4 s, so uncached calls piled up and the buttons never
  // appeared. One lookup at a time; once there is an answer, reply with it at once and start a new lookup when it is
  // older than FM_FRESH_MS. The answer (sid or the error) is never invented. waitFm keeps calling current() itself.
  // A refresh changing state (e.g. done: the new session took over) or a new registration (page owner, align meta) makes
  // the cached answer stale: wait for a new one.
  let fmLast = null, fmAt = 0, fmPending = null, fmRefreshKey = null;
  const refreshKey = () => { const r = refresher.get(); return (r ? r.id + ":" + r.state : "") + "|" + pageData(page).owner; };
  function lookupFm() {
    if (!fmPending) {
      const key = refreshKey(), t0 = Date.now();
      // registered: the registration even when archived (the page keeps 「刷新 First Mate」 usable then); null when none.
      fmPending = Promise.all([
        resolver.current().then((v) => ({ fm: v }), (e) => ({ fm: null, fmError: e.message })),
        resolver.registeredFm().catch(() => null),
      ]).then(([fm, registered]) => { const v = { ...fm, registered, lookupMs: Date.now() - t0 }; fmLast = v; fmAt = Date.now(); fmRefreshKey = key; return v; })
        .finally(() => { fmPending = null; });
    }
    return fmPending;
  }
  async function currentFmView() {
    if (fmLast === null || fmRefreshKey !== refreshKey()) return lookupFm();
    if (Date.now() - fmAt > (config.fmFreshMs ?? FM_FRESH_MS)) lookupFm();
    return fmLast;
  }

  // Optional service: the page's First Mate buttons work without dsh-workspace-effort; the effort control then shows
  // why it is unavailable (effort.error) instead of the page failing. The view is looked up alongside the First Mate
  // lookup and bounded by EFFORT_WAIT_MS, so a slow model lookup never holds the First Mate buttons back.
  async function effortView() {
    const service = ctx.get("workspaceEffort");
    if (service === undefined) return { error: "dsh-workspace-effort 没有加载" };
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve({ error: "读取超时（" + (config.effortWaitMs ?? EFFORT_WAIT_MS) / 1000 + " 秒）" }), config.effortWaitMs ?? EFFORT_WAIT_MS); });
    try {
      // Promise.resolve().then: a dispatchView that throws synchronously (service changed shape) is reported, not a 500
      return await Promise.race([Promise.resolve().then(() => service.dispatchView()).catch((e) => ({ error: e.message })), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function handle(req, res, sub) {
    try {
      const denied = guard(req);
      if (denied) return reply(res, denied.code, { ok: false, message: denied.message });
      if (sub === "/fm" && req.method === "GET") {
        const [fm, effort] = await Promise.all([currentFmView(), effortView()]);
        return reply(res, 200, { ok: true, page, ...fm, refresh: refresher.get(), effort });
      }
      if (req.method !== "POST" || (sub !== "/fm/refresh" && sub !== "/fm/refresh/cancel" && sub !== "/fm/refresh/dismiss" && sub !== "/fm/effort")) return reply(res, 404, { ok: false, message: "没有这个地址" });
      if (!/^application\/json\b/.test(req.headers["content-type"] || "")) return reply(res, 415, { ok: false, message: "只接受 JSON" });
      const body = await readJson(req);
      if (body === undefined || body === null || typeof body !== "object") return reply(res, 400, { ok: false, message: "请求内容不是 JSON 对象" });
      if (sub === "/fm/effort") {
        const service = ctx.get("workspaceEffort");
        if (service === undefined) return reply(res, 503, { ok: false, message: "dsh-workspace-effort 没有加载" });
        try {
          const effort = await service.setDispatchEffort(body.reasoningEffort);
          log("fm dispatch effort set to " + effort.reasoningEffort);
          return reply(res, 200, { ok: true, effort });
        } catch (e) {
          if (e?.code === "bad-effort") return reply(res, 400, { ok: false, message: e.message });
          if (e?.code === "not-configured") return reply(res, 503, { ok: false, message: e.message });
          throw e;
        }
      }
      if (sub === "/fm/refresh") {
        if (body.confirm !== true) return reply(res, 400, { ok: false, message: "缺少确认" });
        const r = await refresher.request();
        log("fm refresh " + (r.created ? "requested" : "already active") + " " + r.record.id + " old=" + r.record.oldSid);
        return reply(res, r.created ? 202 : 200, { ok: true, refresh: r.record });
      }
      if (sub === "/fm/refresh/dismiss") {
        const r = refresher.dismiss(body.id);
        if (r.ok) log("fm refresh dismissed " + body.id);
        return reply(res, r.ok ? 200 : 409, { ok: r.ok, refresh: r.record, ...(r.ok ? {} : { message: "只有失败的刷新记录可以清掉" }) });
      }
      const r = refresher.cancel(body.id);
      return reply(res, r.ok ? 200 : 409, { ok: r.ok, refresh: r.record, ...(r.ok ? {} : { message: "只有还在等待的刷新可以取消" }) });
    } catch (e) {
      log("error fm route " + (e.stack || e.message));
      return reply(res, 500, { ok: false, message: e.message });
    }
  }

  return { handle, refresher, resolver, currentFmView };
}
