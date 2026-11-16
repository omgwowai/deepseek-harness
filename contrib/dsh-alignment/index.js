/**
 * dsh-alignment: serves alignment pages (align CLI and page templates in cli/, moved here from the First Mate project 2026-10-23) on the DSH web server, so the sidebar and the remote
 * entry (through whatever reverse proxy front-ends port 3080) open them behind the existing DSH login.
 *
 *   GET  /alignment/health            {ok, app, api, pid, watchError, timeoutError}; no auth (lets the align CLI probe whether this route is live);
 *                                     watchError = null, or [{page, message, at}] for files the change watcher cannot read;
 *                                     timeoutError = null, or [{item, message, at}] for deadlines that could not be handled
 *   GET  /alignment/pages             [{name, title, updated, open, decisions}] of every registered page (open = cards waiting
 *                                     for the user, api 7; decisions = open decisions)
 *   GET  /alignment/p/<name>          the page (registered with `align init`)
 *   GET  /alignment/p/<name>/data     its data block as JSON (the page polls it); version-3 pages add a top-level
 *                                     live = {sid: "running" | "idle"} for every round's session (api 7, liveStates below)
 *                                     and work = {sid: {subagents, jobs}} for the ones with something running (sessionWork)
 *   GET  /alignment/todos?sids=a,b   latest todolist of each session (todos.js; the page shows it on in-progress rounds),
 *                                     the session's turns (activity) and, api 3, the time its subagents / jobs ran (background);
 *                                     api 4: why a session has no todolist (notodo) and each item's subagents / jobs (agent)
 *   GET  /alignment/curio             the resident personal session (Curio): Goal, subagents running, models (curio.js);
 *                                     {curio: null} when the profile has no dsh-personal-agent or no resident session
 *   GET  /alignment/tools/runs?sid=&ids=  what each run_code did, step by step (tool-stats.js runSteps; asked when a row opens)
 *   GET  /alignment/tools?sid=&from=&to=  tool-call anomalies of a session against per-tool P90 (tool-stats.js; the page
 *                                     asks once when a 待验收 round's detail opens)
 *   POST /alignment/p/<name>/answer   {id, choice, note} or {answers:[...]}: forwards the decision(s) to the session,
 *                                     then marks them "sent"
 *   POST /alignment/p/<name>/order    {order:[project id]} (api 10): saves the project order (page field projOrder) set by
 *                                     dragging project bars in the page's 「已完成」 column; every column follows it
 *   POST /alignment/p/<name>/image    raw image bytes (api 14): an image pasted / dropped into the message box, stored as
 *                                     ALIGN_STORE/memo-images/<YYYY-MM-DD>/<sha256 16>.<ext> (PNG/JPG/WebP/GIF by signature,
 *                                     <= 20 MB) -> {path, type, bytes}; the message item {kind:'message', images:[path]} lists
 *                                     those absolute host paths in the text the session gets (First Mate reads them with
 *                                     read_image); GET .../file?path=<memo image> serves them back for the thumbnails;
 *                                     after replying, each upload deletes memo-images/<day>/ folders older than 30 days
 *
 * Delivery: agent.steer with a plugin source (same mechanism as dsh-fm's turn-end notices), not the threads CLI, so the
 * DSH chat draws the message as a card (dsh-thread-message renders source.kind "plugin:dsh-alignment") instead of a
 * user bubble. The model-facing text is align.mjs messageFor / batchMessageFor verbatim; the card shows only
 * source.page + source.decisions ({title, choice, note}), which align.mjs passes as send's third argument
 * (decisionCard). An idle session starts a turn, a busy one picks the message up at its next step. Archived targets are
 * refused like send_message_to_thread does (an archived session never runs, the decision would vanish).
 * The phone app only draws source "user" as a message bubble; the mobile-gateway patch reports this kind as "user"
 * (phoneSourceKind), so the phone keeps showing the full text. The 3390 standalone server still sends through the
 * threads CLI (it runs outside the DSH process).
 *
 * Auth: every route except /health goes through ctx.connection.requestRejection(req) - the same fence the DSH page
 * uses: Host/Origin must be trusted (cross-site requests are refused) and the DSH browser cookie must be valid (401
 * otherwise). Through the 4080 gateway the request arrives with the gateway's own 3080 cookie and
 * Origin http://127.0.0.1:3080, so remote browsers pass after the gateway's mTLS + account login.
 * Request handling, page storage and validation live in cli/align.mjs (shared with the 3390
 * standalone server and the CLI); this file only mounts it.
 * Only the web profile has webServer / connection; on headless the plugin is linked but never applied.
 *
 * Change watcher (watch.js, 2026-10-22): polls the registry and every page file; a decision becoming open or a round
 * becoming waiting is emitted as the Cordis event "dsh-alignment/changed" {pages, alerts} (the mobile-gateway patch turns
 * it into phone alerts). The apply-time scan is the baseline and never alerts, so a 3080 restart does not re-alert.
 *
 * Decision deadlines (timeouts.js, page api 7): every TIMEOUT_TICK_MS (and once right after apply, which catches up on
 * deadlines that passed while 3080 was down) the plugin answers due decisions with their recommendation or reminds the
 * page owner once (align.mjs timeoutCheck / answerTimeout / remindOverdue, delivered through the same send), and ticks the
 * watcher so "decision-due-soon" alerts fire an hour before a deadline.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { decisionSource } from "./source.js";
import { createTodoIndex, todosHandler } from "./todos.js";
import { createBaseline, toolsHandler, runsHandler, runStatsWorker, TOOLS_API, WINDOW_DAYS } from "./tool-stats.js";
import { createAlignmentWatcher } from "./watch.js";
import { TIMEOUT_TICK_MS, createTimeoutRunner } from "./timeouts.js";
import { createStuckRunner, noticeSource } from "./stuck.js";
import { mountFmRoutes } from "./fm-mount.js";
import { backgroundOf, itemsOf, runningOf } from "./lib/session-background.mjs";
import { canInspectSessions, sessionInspector } from "./session-inspect.mjs";
import { jobName } from "./job-title.js";
import { curioHandler, curioReader } from "./curio.js";

export { SOURCE_KIND, decisionSource } from "./source.js";

// The align CLI ships with this plugin (cli/; until 2026-10-23 it was First Mate's project skill, which drew work sessions
// into its directory). ALIGN_SKILL_DIR overrides the directory (tests). Missing = fail loud at load.
export const ALIGN_SKILL_DIR = process.env.ALIGN_SKILL_DIR ?? fileURLToPath(new URL("./cli", import.meta.url));
const ALIGN_MJS = join(ALIGN_SKILL_DIR, "align.mjs");
if (!existsSync(ALIGN_MJS)) throw new Error("dsh-alignment: " + ALIGN_MJS + " not found");
const { ROUTE_PREFIX, API_VERSION, createHandler, listPages, pageData, answerDecision, answerBatch, legacyView, decisionCard, readRegistry, parsePage,
  timeoutCheck, answerTimeout, remindOverdue, recordUsage, textOf, checkWork, attachmentFile, PageError, stuckReminders, stuckReminderText, stuckSummary } = await import(pathToFileURL(ALIGN_MJS).href);
for (const [k, f] of Object.entries({ stuckReminders, stuckReminderText, stuckSummary })) if (typeof f !== "function") throw new Error("dsh-alignment: " + ALIGN_MJS + " exports no " + k + " (alignment-page skill older than the stuck-round reminders)");
if (typeof checkWork !== "function") throw new Error("dsh-alignment: " + ALIGN_MJS + " exports no checkWork (alignment-page skill older than the running subagents / jobs list)");
if (typeof attachmentFile !== "function" || typeof PageError !== "function") throw new Error("dsh-alignment: " + ALIGN_MJS + " exports no attachmentFile / PageError (alignment-page skill older than attachments, phone contract 7)");
if (typeof recordUsage !== "function") throw new Error("dsh-alignment: " + ALIGN_MJS + " exports no recordUsage (alignment-page skill older than usage logs, api 11)");
if (typeof textOf !== "function") throw new Error("dsh-alignment: " + ALIGN_MJS + " exports no textOf (alignment-page skill older than server-side text, phone contract 6)");
if (typeof legacyView !== "function") throw new Error("dsh-alignment: " + ALIGN_MJS + " exports no legacyView (alignment-page skill older than data version 3)");
if (typeof decisionCard !== "function") throw new Error("dsh-alignment: " + ALIGN_MJS + " exports no decisionCard (alignment-page skill older than the decision card)");
if (typeof answerBatch !== "function") throw new Error("dsh-alignment: " + ALIGN_MJS + " exports no answerBatch (alignment-page skill older than batch answers)");
if (typeof readRegistry !== "function" || typeof parsePage !== "function") throw new Error("dsh-alignment: " + ALIGN_MJS + " exports no readRegistry / parsePage (the change watcher needs them)");
// api 7: createHandler requires live(sids); an older skill would silently drop it and the page could never tell a stopped session.
if (!(API_VERSION >= 7)) throw new Error("dsh-alignment: " + ALIGN_MJS + " reports api " + API_VERSION + ", needs >= 7 (live session state)");
for (const [k, f] of Object.entries({ timeoutCheck, answerTimeout, remindOverdue })) if (typeof f !== "function") throw new Error("dsh-alignment: " + ALIGN_MJS + " exports no " + k + " (alignment-page skill older than decision deadlines)");
/** The page registry align.mjs reads (same ALIGN_STORE / DSH_HOME rule as align.mjs STORE). */
export const REGISTRY_FILE = join(process.env.ALIGN_STORE || join(process.env.DSH_HOME || join(homedir(), ".dsh"), "storages", "alignment-page"), "pages.json");

/**
 * In-process bridge for the phone gateway (dsh-plugin-mobile-gateway local patch, lib/alignment-bridge.mjs): the gateway
 * runs in this same 3080 process and answers the phone's alignment-data / alignment-answer WebSocket frames through
 * this object, so pages and the answer path have one implementation. Cleared when this plugin is disposed.
 * The phone app still renders data version 2 (flat items), so pageData goes through legacyView (v3 -> v2 projection; the
 * answer path is unchanged because decision ids survive the projection). The bridge announces api = the negotiated phone
 * contract (PHONE_API, or the previous one next to an older gateway: phoneApiFor) - the gateway patch checks that number
 * as its phone-contract version, which is not the page data version (/alignment/health api).
 * openState() (api 4) returns the watcher's [{name, title, open, openIds}]; the gateway sends it as alignment-open on connect.
 * api 5: pageData3 / answerBatch3 return the version-3 page data as stored plus live (the same liveStates the web /data
 * uses), for phone requests carrying data:3; pageData / answerBatch keep the version-2 projection for older apps.
 * api 6: pageData3 / answerBatch3 data also carries text = textOf(data) (cli/text-split.mjs, the same split the web page
 * runs; reply only, never written or validated), and answerBatch3 passes {kind:'message', text} items through to align.mjs.
 */
export const BRIDGE_KEY = Symbol.for("dsh-alignment/bridge");
/**
 * Phone contract version the gateway patch (lib/alignment-bridge.mjs ALIGNMENT_API) expects; data in it is version-2
 * shaped. 3 (2026-10-22) = 2 + answerBatch (the phone's alignment-answer-batch frame).
 * 4 (2026-10-22) = 3 + openState() and the "dsh-alignment/changed" event (phone decision / round-waiting alerts).
 * 5 (2026-10-23) = 4 + listPages().cards (cards to handle, the web badge count) and pageData3 / answerBatch3 (version-3
 * data + live, every batch item kind align.mjs answerBatch accepts). Contract: docs/alignment-page-mobile-api.md section 9.
 * 6 (2026-10-24) = 5 + data.text on data:3 replies (server-side text split, align.mjs textOf) and the user message batch
 * item {kind:'message', text} (page api 9 semantics). Contract: docs/alignment-page-mobile-api.md section 12.
 * 7 (2026-10-24) = 6 + file(page, path) for the phone's alignment-file frame: the web /file rules (align.mjs attachmentFile,
 * no via), then only PHONE_FILE_TYPES and at most PHONE_FILE_MAX raw bytes; returns {type, size, data (base64)}, throws
 * PageError (code kept as is, the gateway reports alignment/<code>). Contract: docs/alignment-page-mobile-api.md section 14.
 * 8 (2026-10-25) = 7 + "round-done" alerts in the "dsh-alignment/changed" event (a version-3 round entering done; watch.js),
 * which the gateway forwards together with decision-due-soon as agent-alert v3. Contract:
 * docs/specs/2026-10-25-mobile-agent-alert-v3.md.
 * 9 (2026-11-03) = 8 + the Mine batch items (todo-add / todo / goal, page api 19) and rec-take (page api 17) on the phone's
 * data:3 batches; answerBatch3 already passes every align.mjs kind through, only the gateway whitelist moves.
 * Contract: docs/alignment-page-mobile-api.md section 19.
 * 10 (2026-11-08) = 9 + data.curio on data:3 replies (pageData3 / answerBatch3): what the resident personal session
 * (Curio) is doing now, read per reply by the same curioReader as GET /alignment/curio; null without a resident session,
 * {error} when it cannot be read (the rest of the reply is unaffected). Contract: docs/alignment-page-mobile-api.md section 22.
 */
export const PHONE_API = 10;
/** The phone contract that added data.curio; a bridge speaking an older one sends no curio key. */
export const PHONE_CURIO_API = 10;
/**
 * Version negotiation (2026-11-03): the oldest phone contract this plugin still speaks, always at least the previous one.
 * The plugin can be hot-reloaded on its own (dsh-hmr replaces linked-plugin modules changed on disk whenever a profile
 * patch changes, e.g. a settings change in the GUI), while the gateway patch in node_modules only changes on a 3080
 * restart. On 2026-11-03 a 17:05 settings change reloaded this plugin at contract 9 next to the contract-8 gateway, and
 * the phone's alignment page was unavailable as a whole until the 18:46 restart. So apply() reads the contract of the
 * installed gateway (gatewayPhoneApi) and publishes the bridge at that number when it is the older one (phoneApiFor);
 * what a later contract added is refused with a clear error (PHONE_KINDS_SINCE). Gateways from this change on also
 * accept a plugin one contract older (ALIGNMENT_API_MIN). Raising PHONE_API: list what the new contract adds in
 * PHONE_KINDS_SINCE (or guard it some other way) so the previous contract keeps working, and add the same to the gateway.
 */
export const PHONE_API_MIN = PHONE_API - 1;
/** data:3 batch item kinds by the phone contract that added them; a bridge speaking an older contract refuses them. */
export const PHONE_KINDS_SINCE = { "todo-add": 9, todo: 9, goal: 9, "rec-take": 9 };
const KIND_LABEL = { "todo-add": "记一条", todo: "待办操作", goal: "目标操作", "rec-take": "推荐「我来做」" };
/** The gateway patch's bridge module in a web profile (pnpm hoisted layout: the copy 3080 loads). */
export const GATEWAY_BRIDGE_FILE = join("node_modules", "dsh-plugin-mobile-gateway", "lib", "alignment-bridge.mjs");

/**
 * The phone contract (ALIGNMENT_API) of the mobile gateway installed in profile directory profileDir, or null when there
 * is none: no profile (tests), a profile without the gateway (headless) or a gateway without the alignment patch. Then no
 * phone reaches this bridge and the plugin keeps PHONE_API (fail-open on purpose: the gateway is an optional peer).
 * Reads the installed file, which is what the running gateway loaded: the boot guard installs the patch with 3080 stopped
 * (pnpm install on main while 3080 runs is not done, dsh-safe-change). A bridge module without exactly one literal
 * "export const ALIGNMENT_API = <n>" line is a changed shape: throws.
 */
export function gatewayPhoneApi(profileDir) {
  if (profileDir === undefined) return null;
  if (typeof profileDir !== "string" || !profileDir) throw new TypeError("dsh-alignment: gatewayPhoneApi(profileDir) needs a directory, got " + JSON.stringify(profileDir));
  const file = join(profileDir, GATEWAY_BRIDGE_FILE);
  let src;
  try { src = readFileSync(file, "utf8"); } catch (e) { if (e?.code === "ENOENT") return null; throw e; }
  const found = [...src.matchAll(/^export const ALIGNMENT_API = (\d+)\s*$/gm)];
  if (found.length !== 1) throw new Error("dsh-alignment: " + file + " has " + found.length + " 'export const ALIGNMENT_API = <n>' lines, need exactly 1 (mobile-gateway patch changed shape)");
  return Number(found[0][1]);
}

/**
 * The contract to publish next to gateway contract `gateway` (gatewayPhoneApi): {api, gateway, error}. No gateway, or one
 * at least as new as PHONE_API: PHONE_API (a newer gateway accepts its previous contract). PHONE_API_MIN..PHONE_API: the
 * gateway's number. Older: PHONE_API with error set - the gateway refuses the bridge and logs it, /alignment/health
 * reports it as phone.error.
 */
export function phoneApiFor(gateway) {
  if (gateway === null) return { api: PHONE_API, gateway: null, error: null };
  if (!Number.isInteger(gateway)) throw new TypeError("dsh-alignment: phoneApiFor(gateway) needs an integer or null, got " + JSON.stringify(gateway));
  if (gateway >= PHONE_API) return { api: PHONE_API, gateway, error: null };
  if (gateway >= PHONE_API_MIN) return { api: gateway, gateway, error: null };
  return { api: PHONE_API, gateway, error: "手机网关只认手机接口版本 " + gateway + "，本插件能说 " + PHONE_API_MIN + ".." + PHONE_API + "：手机对齐页不可用，重启 DSH 换新网关后恢复" };
}
/**
 * Largest attachment the phone gets (raw bytes). base64 makes the reply about 4/3 of it (8 MiB -> about 11.2 MB), under the
 * App's 16 MiB incoming WebSocket message cap (dsh-mobile OkHttpGatewayTransport MAXIMUM_INCOMING_MESSAGE_SIZE); the
 * gateway's maxPayload (144 MiB) only limits frames it receives.
 */
export const PHONE_FILE_MAX = 8 * 1024 * 1024;
/** Image types the phone channel serves (svg and text types are refused: type-not-served). */
export const PHONE_FILE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** live values the phone gets (contract 5 apps read any string; only "running" / "idle" change their columns). */
export const PHONE_LIVE = ["running", "subagent", "job", "idle"];
/** Cordis event the watcher emits: {pages: [{name, title, open, openIds}], alerts: [...]} (watch.js). */
export const CHANGED_EVENT = "dsh-alignment/changed";

export const name = "dsh-alignment";
export const inject = ["webServer", "connection", "sessionController", "workspaceRegistry", "agents", "jobs", "schedule", "sessionProjections"];

/**
 * send(sid, prompt, card) for createHandler / the phone bridge: steers the decision text into the session under
 * sourceOf(card) (default decisionSource; the stuck-round reminders pass noticeSource and a summary as the card). Throws (the caller turns it into PageError send-failed, page unchanged) when the session is
 * archived, unknown or not resolvable, or when a host service changed shape.
 */
export function steerSender({ sessionController, workspaceRegistry, createUserMessage, registeredFm, sourceOf = decisionSource }) {
  if (typeof sessionController?.resolveAgent !== "function") throw new Error("dsh-alignment needs sessionController.resolveAgent (DSH session controller API changed)");
  if (typeof registeredFm !== "function") throw new TypeError("dsh-alignment: steerSender needs registeredFm() (the First Mate page owner)");
  if (typeof sourceOf !== "function") throw new TypeError("dsh-alignment: steerSender sourceOf must be a function");
  return async (sid, prompt, card) => {
    const source = sourceOf(card);
    const archived = workspaceRegistry.archivedSessionIds;
    if (!Array.isArray(archived)) throw new Error("dsh-alignment: workspaceRegistry.archivedSessionIds is missing (DSH workspace registry API changed)");
    // The registered First Mate archived (2026-10-24): no guessing a successor; the refresh switches the registration
    // and the page owner in one step. Any other archived session: unarchive it.
    if (archived.includes(sid)) {
      if (registeredFm() === sid) throw new Error("登记的 First Mate 会话 " + sid + " 已归档：在对齐页右上角点「刷新 First Mate」换新会话（同时改登记和负责人），再重试发送");
      throw new Error("会话 " + sid + " 已归档，取消归档后再发送");
    }
    const resolved = await sessionController.resolveAgent(sid);
    if (resolved !== null && typeof resolved === "object" && "error" in resolved) throw resolved.error;
    if (typeof resolved?.agent?.steer !== "function") throw new Error("dsh-alignment: sessionController.resolveAgent returned no agent with steer() (DSH agent API changed)");
    resolved.agent.steer(createUserMessage({ content: [{ type: "text", text: prompt }], source }));
  };
}

/**
 * The host's own @deepseek-ai/dsh-llm (resolved from the DSH entry, process.argv[1] = dsh/lib/bin.js; a linked plugin
 * cannot import it by name). Same copy the agent loop uses, so createUserMessage follows DSH upgrades.
 */
export async function loadHostLlm(entry = process.argv[1]) {
  if (typeof entry !== "string" || entry.length === 0) throw new Error("dsh-alignment: process.argv[1] (the DSH entry) is missing, cannot load @deepseek-ai/dsh-llm");
  const mod = await import(pathToFileURL(createRequire(realpathSync(entry)).resolve("@deepseek-ai/dsh-llm")).href);
  if (typeof mod.createUserMessage !== "function") throw new Error("dsh-alignment: @deepseek-ai/dsh-llm has no createUserMessage() (DSH changed shape)");
  return mod;
}

/**
 * The object published on BRIDGE_KEY; send(sid, prompt, card) forwards an answer to a session. Exported for the gateway test.
 * answerBatch(page, items: [{id, choice, note}]) is the web page's batch send (align.mjs answerBatch: same merged message
 * batchMessageFor and decision card, to the page owner): all items are validated first, any invalid item rejects the
 * whole batch, and a send failure leaves the page unchanged; on success every item turns "sent". Returns {data, sid, items}.
 * live(sids) (api 5) is liveStates(ctx.agents); pageData3 / answerBatch3 add its result as data.live on version-3 pages.
 * work(sids) (2026-10-24, contract unchanged) is sessionWork: pageData3 / answerBatch3 add it as data.work the same way
 * (apps that do not read it ignore the key); without work the bridge sends no data.work.
 * curio() (contract 10) is the /alignment/curio reader: speaking 10 or newer, pageData3 / answerBatch3 add its result as
 * data.curio (null = no resident session); a read failure becomes {error} and is logged once per distinct message.
 * Without curio, or speaking 9, the bridge sends no data.curio.
 */
export function createPhoneBridge(send, openState, live, record = appUsageRecorder(), work = null, api = PHONE_API, curio = null, log = (line) => console.error("[dsh-alignment] " + line)) {
  // api (version negotiation): the contract to speak, PHONE_API_MIN..PHONE_API (phoneApiFor next to the loaded gateway)
  if (!Number.isInteger(api) || api < PHONE_API_MIN || api > PHONE_API) throw new TypeError("dsh-alignment: createPhoneBridge api " + api + " is outside the phone contracts this plugin speaks (" + PHONE_API_MIN + ".." + PHONE_API + ")");
  // Speaking an older contract: refuse the batch kinds a later one added, before anything is validated, sent or written.
  const refuseNewer = (answers) => {
    if (!Array.isArray(answers)) return;
    for (const [i, it] of answers.entries()) {
      const since = PHONE_KINDS_SINCE[it?.kind];
      if (since > api) throw new PageError(400, "bad-request", "items[" + i + "]「" + KIND_LABEL[it.kind] + "」要手机接口版本 " + since + "，电脑上的手机网关是旧版（手机接口版本 " + api + "）：重启 DSH 后可用");
    }
  };
  if (typeof openState !== "function") throw new TypeError("dsh-alignment: createPhoneBridge(send, openState, live) needs openState (the change watcher's page summary)");
  if (typeof live !== "function") throw new TypeError("dsh-alignment: createPhoneBridge(send, openState, live) needs live(sids) (liveStates(ctx.agents), phone contract 5)");
  if (curio !== null && typeof curio !== "function") throw new TypeError("dsh-alignment: createPhoneBridge curio must be the /alignment/curio reader or null");
  let curioFailed = null;
  const readCurio = async () => {
    try { const c = await curio(); curioFailed = null; return c; }
    catch (error) {
      const message = "读不到 Curio 的状态：" + (error?.message ?? String(error));
      if (message !== curioFailed) log("phone curio " + (error?.stack ?? error));
      curioFailed = message;
      return { error: message };
    }
  };
  // Same rule as align.mjs createHandler withLive: version-3 pages get live for every round sid (deduplicated) and text
  // (textOf, api 6), version 2 as is.
  const withLive = async (data) => {
    if (data.version !== 3) return data;
    const sids = [...new Set(data.rounds.map((r) => r.sid).filter(Boolean))];
    const got = await live(sids);
    for (const sid of sids) if (!PHONE_LIVE.includes(got[sid])) throw new Error("dsh-alignment: live(sids) gave " + JSON.stringify(got[sid]) + " for " + sid + " (expected " + PHONE_LIVE.join(" | ") + ")");
    const out = { ...data, live: Object.fromEntries(sids.map((sid) => [sid, got[sid]])), text: textOf(data) };
    if (work !== null) out.work = checkWork(await work(sids), sids);
    if (curio !== null && api >= PHONE_CURIO_API) out.curio = await readCurio();
    return out;
  };
  return {
    api, openState,
    // open = open decisions (what contract-4 apps read); cards = cards to handle (listPages().open since page api 7, the
    // web badge), which contract-5 apps sum for their badge (docs/alignment-page-mobile-api.md section 9).
    listPages: () => listPages().map(({ name, title, updated, open, decisions }) => ({ name, title, updated, open: decisions, cards: open })),
    pageData: (name) => { record.open(name); return legacyView(pageData(name)); },
    pageData3: (name) => { record.open(name); return withLive(pageData(name)); },
    answer: (page, body) => record.answer(page, 1, async () => { const r = await answerDecision(page, body, send); return { ...r, data: legacyView(r.data) }; }),
    answerBatch: (page, items) => record.answer(page, items?.length, async () => { const r = await answerBatch(page, { answers: items }, send); return { ...r, data: legacyView(r.data) }; }),
    answerBatch3: (page, answers) => record.answer(page, answers?.length, async () => { refuseNewer(answers); const r = await answerBatch(page, { answers }, send); return { ...r, data: await withLive(r.data) }; }),
    // api 7: one attached image for the phone (same readable rules as the web /file, then image types and size only)
    file: (page, ref) => {
      if (typeof page !== "string" || !page || typeof ref !== "string" || !ref) throw new PageError(400, "bad-request", "page 和 path 要是非空字符串");
      const { type, body } = attachmentFile(page, ref);
      if (!PHONE_FILE_TYPES.has(type)) throw new PageError(403, "type-not-served", "手机上只显示 png / jpeg / gif / webp 图片，这个文件请在电脑上看");
      if (body.length > PHONE_FILE_MAX) throw new PageError(413, "too-large", "图片有 " + (body.length / 1048576).toFixed(1) + " MB，超过手机上限 " + PHONE_FILE_MAX / 1048576 + " MB，请在电脑上看");
      return { type, size: body.length, data: body.toString("base64") };
    },
  };
}

/**
 * Usage log for the phone App (align.mjs api 11, src = app): app.open at most once per page per 10 minutes (the App
 * re-reads data on every refresh), app.answer per send with n and ok. A failed log write is reported, never blocks the App.
 */
export function appUsageRecorder(write = recordUsage, now = Date.now, log = (e) => console.error("[dsh-alignment] usage log failed", e)) {
  const lastOpen = new Map();
  const safe = (page, ev) => { try { write(page, "app", ev); } catch (e) { log(e); } };
  return {
    open(page) { const t = now(); if (!(t - (lastOpen.get(page) ?? -Infinity) < 600_000)) { lastOpen.set(page, t); safe(page, { type: "app.open" }); } },
    async answer(page, n, run) {
      const t0 = now();
      try { const r = await run(); safe(page, { type: "app.answer", n: Number(n) || 0, ok: true, ms: now() - t0 }); return r; }
      catch (e) { safe(page, { type: "app.answer", n: Number(n) || 0, ok: false, ms: now() - t0 }); throw e; }
    },
  };
}

/**
 * live(sids) for align.mjs createHandler (api 7): "running" while the session's agent runs (ctx.agents.get(sid).status,
 * the same test todos.js isRunning uses); otherwise "subagent" / "job" while its turn is over but subagents or its own
 * background jobs still run (lib/session-background.mjs, 2026-10-24: a session waiting for its subagents is not
 * stopped), else "idle" - a session the host has not loaded is not running, so it is "idle", never "unknown".
 * The activity waterfall is only asked for sessions that are not running. Fails loud on a changed agents / waterfall shape.
 */
export function liveStates(agents, waterfall) {
  if (typeof agents?.get !== "function") throw new Error("dsh-alignment needs ctx.agents.get (DSH agents service missing or changed shape)");
  if (typeof waterfall !== "function") throw new Error("dsh-alignment needs ctx.waterfall (workspace/session-activity, DSH API changed)");
  return async (sids) => Object.fromEntries(await Promise.all(sids.map(async (sid) => {
    const agent = agents.get(sid);
    if (agent !== undefined && agent !== null) {
      if (typeof agent.status !== "string") throw new Error("dsh-alignment: ctx.agents.get(" + sid + ").status is " + typeof agent.status + ", not a string (DSH agent API changed)");
      if (agent.status === "running") return [sid, "running"];
    }
    return [sid, (await backgroundOf(waterfall, sid)) ?? "idle"];
  })));
}

/**
 * work(sids) for createHandler / the phone bridge (2026-10-24, the page shows what runs instead of 等子 agent):
 * {sid: {subagents: [{id, name, since}], jobs: [{id, name, since, cmd}]}} for the sessions that have something running,
 * whether or not their own turn runs. Same list as live (workspace/session-activity: subagent descendants at any depth,
 * the session's own running / stopping jobs; reminders are not work). name = the subagent's creation label (the
 * subagent tool's description, a workflow agent's label), null when the host gives none. A job's name (2026-10-26) is
 * jobName (job-title.js): the description of the call that started it (jobInfo(sid, id) from the session log - a pwsh /
 * bash job's label is the raw command), else a readable name made from the command, else its label; cmd = the raw
 * command of a pwsh / bash job (shown on hover, copied by the page), null for other kinds.
 * since (epoch ms) = when the subagent's current turn started (its subagentTiming projection) or the job started
 * (jobs.get(id, sid).startedAt); null when the host no longer knows (the item settled between the two reads).
 * Fails loud on a changed agents / jobs / projection / waterfall shape.
 */
export function sessionWork(agents, jobs, projections, waterfall, jobInfo) {
  if (typeof agents?.get !== "function") throw new Error("dsh-alignment needs ctx.agents.get (DSH agents service missing or changed shape)");
  if (typeof jobs?.get !== "function") throw new Error("dsh-alignment needs ctx.jobs.get (DSH jobs service missing or changed shape)");
  if (typeof projections?.stateOf !== "function") throw new Error("dsh-alignment needs ctx.sessionProjections.stateOf (DSH session projection service missing or changed shape)");
  if (typeof waterfall !== "function") throw new Error("dsh-alignment needs ctx.waterfall (workspace/session-activity, DSH API changed)");
  if (typeof jobInfo !== "function") throw new TypeError("dsh-alignment sessionWork needs jobInfo(sid, jobId) (the todo index's job descriptions)");
  const name = (label) => (typeof label === "string" && label.trim() ? label.trim() : null);
  const kidSince = (id) => {
    const session = agents.get(id)?.session;
    if (session === undefined) return null;
    const timing = projections.stateOf(session, "subagentTiming");
    if (timing === undefined) return null;
    if (typeof timing !== "object" || (timing.active !== undefined && typeof timing.active?.since !== "number")) throw new Error("dsh-alignment: subagentTiming of " + id + " has no numeric active.since (DSH subagent projection changed shape)");
    return timing.active?.since ?? null;
  };
  // jobs.get(id, caller) only shows an owned job to its owner, so ask as the session; a job removed between the two
  // reads ("unknown job") has no start time any more, every other error is real
  const jobView = (id, sid) => {
    let view;
    try { view = jobs.get(id, sid); } catch (error) { if (/^unknown job /.test(error?.message ?? "")) return null; throw error; }
    if (typeof view?.startedAt !== "number") throw new Error("dsh-alignment: ctx.jobs.get(" + id + ").startedAt is " + typeof view?.startedAt + " (DSH jobs API changed)");
    if (typeof view.kind !== "string") throw new Error("dsh-alignment: ctx.jobs.get(" + id + ").kind is " + typeof view.kind + " (DSH jobs API changed)");
    return view;
  };
  const job = async (x, sid) => {
    const view = jobView(x.id, sid), info = await jobInfo(sid, x.id);
    const { name: n, cmd } = jobName(view === null ? info?.kind ?? null : view.kind, x.label, info?.desc ?? null);
    return { id: x.id, name: n, since: view === null ? null : view.startedAt, cmd };
  };
  return async (sids) => {
    const out = {};
    for (const [sid, it] of await Promise.all(sids.map(async (sid) => [sid, await itemsOf(waterfall, sid)]))) {
      if (!it.subagent.length && !it.job.length) continue;
      out[sid] = {
        subagents: it.subagent.map((x) => ({ id: x.id, name: name(x.label), since: kidSince(x.id) })),
        jobs: await Promise.all(it.job.map((x) => job(x, sid))),
      };
    }
    return out;
  };
}

/** /alignment/fm when firstMate is not configured: GET says the controls are off, everything else is 404. */
export function fmDisabledRoutes(guard) {
  const reply = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(body));
  };
  return {
    handle(req, res, sub) {
      const denied = guard(req);
      if (denied) return reply(res, denied.code, { ok: false, message: denied.message });
      if (sub === "/fm" && req.method === "GET") return reply(res, 200, { ok: true, enabled: false });
      return reply(res, 404, { ok: false, message: "First Mate 功能没有开启（插件配置 firstMate）" });
    },
  };
}

export function guardFor(connection) {
  return (req) => {
    const rejection = connection.requestRejection(req);
    if (rejection === undefined) return null;
    if (rejection === 401) return { code: 401, message: "需要先登录 DSH" };
    if (rejection === 403) return { code: 403, message: "请求来源不受信任" };
    throw new Error("dsh-alignment: unexpected requestRejection result " + JSON.stringify(rejection) + " (DSH connection service changed shape)");
  };
}

/**
 * Plugin config (cordis.patch.yml row `config:`), all optional:
 *   firstMate: {root, page?, quietMs?}  turns on the First Mate controls (fm-mount.js): root = the working directory of
 *     the First Mate sessions, page = the alignment page it owns (default "first-mate"). Without it the controls are off:
 *     GET /alignment/fm answers {enabled: false} and the page draws no First Mate buttons.
 *   sessionsRoot  where the session logs are (default $DSH_HOME/sessions), for the tool-call anomaly baseline.
 *   toolsWarmMs   delay before the first baseline build (default 60 s).
 */
export function firstMateConfig(config) {
  const fm = config?.firstMate;
  if (fm === undefined || fm === null) return null;
  if (typeof fm !== "object" || typeof fm.root !== "string" || fm.root.length === 0) throw new Error("dsh-alignment config firstMate needs root (the First Mate working directory), got " + JSON.stringify(fm));
  if (fm.page !== undefined && (typeof fm.page !== "string" || !/^[a-z0-9-]+$/.test(fm.page))) throw new Error("dsh-alignment config firstMate.page must be a page name (a-z 0-9 -), got " + JSON.stringify(fm.page));
  return { fmRoot: fm.root, fmPage: fm.page ?? "first-mate", quietMs: fm.quietMs };
}

export function apply(ctx, config = {}) {
  if (typeof ctx.connection?.requestRejection !== "function") throw new Error("dsh-alignment needs ctx.connection.requestRejection (DSH service missing or changed shape)");
  const llm = loadHostLlm();
  llm.catch((error) => console.error("[dsh-alignment] " + error.message));
  // The First Mate registration (fm/current.js): the First Mate page's owner; none when the controls are off or that page does not exist.
  const fmConfig = firstMateConfig(config);
  const registeredFm = () => (fmConfig === null || readRegistry()[fmConfig.fmPage] === undefined ? undefined : pageData(fmConfig.fmPage).owner);
  const send = async (sid, prompt, card) => {
    const { createUserMessage } = await llm;
    return steerSender({ sessionController: ctx.sessionController, workspaceRegistry: ctx.workspaceRegistry, createUserMessage, registeredFm })(sid, prompt, card);
  };
  const sendNotice = async (sid, text, summary) => {
    const { createUserMessage } = await llm;
    return steerSender({ sessionController: ctx.sessionController, workspaceRegistry: ctx.workspaceRegistry, createUserMessage, registeredFm, sourceOf: noticeSource })(sid, text, summary);
  };
  // 0.2.2 dropped sessionController.inspect; the same read is sessionQuery.observeSession (./session-inspect.mjs, a copy of ~/.dsh/lib/session-inspect.mjs, picks by shape)
  const inspectSession = sessionInspector(() => ({ sessionController: ctx.sessionController, sessionQuery: ctx.get("sessionQuery") }));
  if (!canInspectSessions({ sessionController: ctx.sessionController, sessionQuery: ctx.get("sessionQuery") }) || typeof ctx.agents?.get !== "function") {
    throw new Error("dsh-alignment needs sessionController.inspect or sessionQuery.observeSession, and agents.get (DSH service changed shape)");
  }
  const todoIndex = createTodoIndex({
    readSessionState: (sid) => inspectSession(sid),
    isRunning: (sid) => ctx.agents.get(sid)?.status === "running",
    running: (sid) => runningOf((...a) => ctx.waterfall(...a), sid),
  });
  const live = liveStates(ctx.agents, (...a) => ctx.waterfall(...a));
  // a job's name: the description of the call that started it, from the session log the todo index already keeps
  const work = sessionWork(ctx.agents, ctx.jobs, ctx.sessionProjections, (...a) => ctx.waterfall(...a), (sid, id) => todoIndex.jobInfo(sid, id));
  const handler = createHandler({
    prefix: ROUTE_PREFIX,
    send,
    guard: guardFor(ctx.connection),
    live,
    work,
    log: (line) => { if (line.startsWith("error ")) console.error("[dsh-alignment] " + line); },
  });
  ctx.on("session/event", (session, event) => todoIndex.observe(session.id, event));
  const todos = todosHandler({ index: todoIndex, guard: guardFor(ctx.connection) });
  // Tool-call anomalies: per-tool P90 over the last WINDOW_DAYS (30) days of session logs, built in a worker (cached per log by mtime + size).
  const statsHome = process.env.DSH_HOME || join(homedir(), ".dsh");
  const baseline = createBaseline({
    build: () => runStatsWorker({ root: config?.sessionsRoot ?? join(statsHome, "sessions"), cacheFile: join(dirname(REGISTRY_FILE), "tool-stats-cache.json"), windowDays: WINDOW_DAYS }),
    log: (line) => { if (line.startsWith("error ")) console.error("[dsh-alignment] tools " + line); },
  });
  ctx.effect(() => { const t = setTimeout(() => baseline.refresh(), config?.toolsWarmMs ?? 60_000); return () => clearTimeout(t); }, "dsh-alignment: tool baseline warm-up");
  const toolsRoute = toolsHandler({ readSessionState: (sid) => inspectSession(sid), baseline, guard: guardFor(ctx.connection) });
  const runsRoute = runsHandler({ readSessionState: (sid) => inspectSession(sid), guard: guardFor(ctx.connection) });
  // Baseline now (snapshots only, never alerts); later changes are emitted for the phone gateway.
  const watcher = createAlignmentWatcher({ readRegistry, parsePage, emit: (payload) => ctx.emit(CHANGED_EVENT, payload) });
  watcher.scan();
  ctx.effect(() => { watcher.start(REGISTRY_FILE); return () => watcher.stop(); }, "dsh-alignment: page change watcher");
  const timeouts = createTimeoutRunner({ readRegistry, pageData, timeoutCheck, answerTimeout, remindOverdue, send });
  // Rounds stopped with no next step for STUCK_REMIND_MS (stuck.js): one reminder to the page owner per stop.
  const stuck = createStuckRunner({ readRegistry, pageData, stuckReminders, stuckReminderText, stuckSummary, live, lastTurn: (sid) => todoIndex.lastTurn(sid), send: sendNotice });
  // run() records its own failures (errors() -> /alignment/health timeoutError / stuckError); the catch only guards the timer.
  const tick = () => {
    watcher.tick();
    timeouts.run().catch((e) => console.error("[dsh-alignment] timeouts run failed", e));
    stuck.run().catch((e) => console.error("[dsh-alignment] stuck reminders run failed", e));
  };
  ctx.effect(() => {
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, TIMEOUT_TICK_MS);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, "dsh-alignment: decision deadlines");
  // Phone contract next to the gateway installed in this profile (version negotiation, phoneApiFor); reported as health.phone.
  const phone = phoneApiFor(gatewayPhoneApi(ctx.get("profileContext")?.dir));
  if (phone.error !== null) console.error("[dsh-alignment] " + phone.error);
  // align.mjs answers /health itself; this one adds watchError (same fields otherwise) and phone.
  const health = (res) => {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify({ ok: true, app: "alignment-page", api: API_VERSION, tools: TOOLS_API, pid: process.pid, phone, watchError: watcher.errors(), timeoutError: timeouts.errors(), stuckError: stuck.errors(), toolsError: baseline.error() }));
  };
  // First Mate button + refresh (fm-mount.js): GET /alignment/fm, POST /alignment/fm/refresh[/cancel|/dismiss];
  // the dispatch effort next to them (dsh-workspace-effort's ctx.workspaceEffort, optional): POST /alignment/fm/effort.
  // Curio band (curio.js, 2026-11-08): the resident personal session's Goal, subagents and models; loader / goals read per request
  // the phone bridge reads the same thing into data.curio (phone contract 10)
  const curioRead = curioReader({ loader: () => ctx.get("loader"), goals: () => ctx.get("goals"), agents: ctx.agents, live, work });
  const curioRoute = curioHandler({ guard: guardFor(ctx.connection), read: curioRead });
  const fm = fmConfig === null ? fmDisabledRoutes(guardFor(ctx.connection)) : mountFmRoutes(ctx, { guard: guardFor(ctx.connection), alignMjs: ALIGN_MJS, pageData, config: { ...config, ...fmConfig }, log: (line) => console.error("[dsh-alignment] " + line) });
  const route = (req, res) => {
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    if (path === ROUTE_PREFIX + "/health") return health(res);
    if (path === ROUTE_PREFIX + "/fm" || path.startsWith(ROUTE_PREFIX + "/fm/")) return fm.handle(req, res, path.slice(ROUTE_PREFIX.length));
    if (path === ROUTE_PREFIX + "/tools") return toolsRoute(req, res);
    if (path === ROUTE_PREFIX + "/tools/runs") return runsRoute(req, res);
    if (path === ROUTE_PREFIX + "/curio") return curioRoute(req, res);
    return path === ROUTE_PREFIX + "/todos" ? todos(req, res) : handler(req, res);
  };
  ctx.effect(() => ctx.webServer.register({ kind: "prefix", path: ROUTE_PREFIX, handler: route }), "dsh-alignment: /alignment route");
  ctx.effect(() => {
    globalThis[BRIDGE_KEY] = createPhoneBridge(send, watcher.openState, live, appUsageRecorder(), work, phone.api, curioRead);
    return () => { delete globalThis[BRIDGE_KEY]; };
  }, "dsh-alignment: phone gateway bridge");
}
