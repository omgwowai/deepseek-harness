// DSH host plugin of Agent Fleet (design: CONTRACT.md §DSH plugin). Two modes, picked by the row's config.mode:
//   remote   (default) this process is the server's DSH Web: every call is an HTTP request to the hub on 127.0.0.1:7840.
//   embedded the Mac desktop app: the hub runs inside this process (lib/plugin/embedded.mjs) and follows the server hub.
// It registers the browser half's RPC routes (agent-fleet/*), the model tool `agent_fleet`, and the
// DSH_AGENT_FLEET_PARENT* variables of model shell calls. A hub that is down or misconfigured surfaces as an RPC or
// tool error and a log line; it never stops the plugin from loading, and a DSH without `tools` / `shellEnv` loses only that part.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HUB_URL, panelBase, panelLocation, panelNonceLocation, resolveConfig, tokenGoesInUrl } from "./lib/plugin/config.mjs";
import { startEmbedded } from "./lib/plugin/embedded.mjs";
import { resolveFamily } from "./lib/plugin/graph.mjs";
import { createEmbeddedHub, createHttpHub, tokenReader, withSnapshotCache } from "./lib/plugin/hub-client.mjs";
import { createFleetTool } from "./lib/plugin/tool.mjs";

export const name = "dsh-agent-fleet";
export const inject = ["connection"];

const ERROR_CODE = "agent-fleet/unavailable";
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const QUERY_FIELDS = ["kind", "site", "host", "category", "target", "text", "since", "limit"];
const PANEL_DIR = fileURLToPath(new URL("./panel/", import.meta.url));

const VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version; } catch { return "0.0.0"; }
})();

/** Late-bound modules. `@deepseek-ai/dsh-tools` resolves from the profile (the package.json peer dependency routes it to DSH's own copy). */
const defaultDeps = {
  loadDefineTool: async () => (await import("@deepseek-ai/dsh-tools")).defineTool,
  loadEmbedded: async () => {
    const [hub, collector, channel] = await Promise.all([import("./lib/hub/index.mjs"), import("./lib/collector/index.mjs"), import("./lib/channel.mjs")]);
    return { startHub: hub.startHub, startCollector: collector.startCollector, keepConnected: channel.keepConnected, sshForwardTransport: channel.sshForwardTransport };
  },
};

/** `POST api/<method>` with DSH's `client-request` envelope; same shape as dsh-agent-dag's routes. */
function rpc(ctx, method, handler) {
  ctx.effect(() => ctx.connection.fetch.register({ path: `/api/${method}`, methods: ["POST"], requestBody: "buffered", fetch: async request => {
    let envelope;
    try { envelope = await request.json(); } catch { return new Response("invalid RPC request", { status: 400 }); }
    if (envelope?.type !== "client-request" || envelope.method !== method || typeof envelope.rpcId !== "string") return new Response("invalid RPC request", { status: 400 });
    let result;
    try { result = { ok: true, value: await handler(envelope.payload ?? {}, request.signal) }; }
    catch (error) { result = { ok: false, error: { code: ERROR_CODE, message: String(error?.message ?? error), details: {} } }; }
    return Response.json({ type: "server-response", rpcId: envelope.rpcId, result }, { headers: { "Cache-Control": "no-store" } });
  } }));
}

function requireString(payload, field) {
  const value = payload?.[field];
  if (typeof value !== "string" || value.trim() === "" || value.length > 4096) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function sessionIdOf(payload) {
  const value = payload?.sessionId;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !SESSION_ID.test(value)) throw new Error("invalid DSH session id");
  return value;
}

const TOKEN_HEADER = "x-agent-fleet-token";

/**
 * Mints the panel's one-time URL credential: POST /api/session-nonce with the hub token. The browser that loads
 * `<panelBase>?nonce=…` gets the HttpOnly cookie and a 302 to the bare panel, so the raw token never enters a URL, a
 * fragment or page storage. Remote mode talks to hubUrl (default 127.0.0.1:7840); embedded mode to the local hub
 * port this process listens on (startEmbedded passes settings.httpPort to startHub).
 */
async function mintPanelNonce(settings, token) {
  const root = settings.mode === "embedded" ? `http://127.0.0.1:${settings.httpPort}` : (settings.hubUrl ?? HUB_URL);
  const response = await fetch(`${root}/api/session-nonce`, { method: "POST", headers: { [TOKEN_HEADER]: token }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`the hub refused a panel session nonce: HTTP ${response.status}`);
  const minted = await response.json();
  if (typeof minted?.nonce !== "string" || minted.nonce === "") throw new Error("the hub returned no panel session nonce");
  return minted.nonce;
}

/** `{hub, ready, stop}`: how this process reaches a hub. `ready` rejects with why embedded mode could not start. */
function connectHub(ctx, settings, deps, log) {
  if (settings.mode === "remote") {
    const lifetime = new AbortController();
    const hub = createHttpHub({ url: settings.hubUrl ?? HUB_URL, tokenFile: settings.tokenFile, lifetime: lifetime.signal });
    return { hub, ready: Promise.resolve(), stop: async () => lifetime.abort() };
  }
  const dshHome = ctx.get("dshHomePath")?.() ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
  const started = Promise.resolve().then(() => deps.loadEmbedded()).then(embedded => startEmbedded({ settings, dshHome, panelDir: PANEL_DIR, version: VERSION, deps: embedded, log }));
  const ready = started.then(() => undefined, error => { throw new Error(`embedded hub did not start: ${error?.message ?? error}`); });
  ready.catch(error => log("warn", error.message));
  return {
    hub: createEmbeddedHub(() => started.then(handle => handle.api, () => ready)),
    ready,
    stop: async () => { const handle = await started.catch(() => null); await handle?.stop(); },
  };
}

/** Resolves once the tool is registered or skipped; never rejects (the page and tab work without it). */
async function registerTool(ctx, hub, deps, log) {
  let defineTool;
  try {
    defineTool = await deps.loadDefineTool();
    if (typeof defineTool !== "function") throw new Error("@deepseek-ai/dsh-tools exports no defineTool");
  } catch (error) {
    log("warn", `model tool agent_fleet not registered: ${error?.message ?? error}`);
    return;
  }
  try {
    ctx.inject(["tools"], toolsCtx => {
      try { toolsCtx.tools.register(createFleetTool({ defineTool, hub })); }
      catch (error) { log("warn", `model tool agent_fleet not registered: ${error?.message ?? error}`); }
    });
  } catch (error) { log("warn", `model tool agent_fleet not registered: ${error?.message ?? error}`); }
}

/** Model shell calls get DSH_AGENT_FLEET_PARENT(_CALL): which agent and tool call a command (and the agents it launches) belongs to. */
function registerShellEnv(ctx, log) {
  try {
    ctx.inject(["shellEnv"], envCtx => {
      try {
        envCtx.shellEnv.register({
          name: "agent-fleet",
          variables: {
            DSH_AGENT_FLEET_PARENT: { description: "Agent Fleet: dsh:<session id> of the agent running this shell" },
            DSH_AGENT_FLEET_PARENT_CALL: { description: "Agent Fleet: tool call id of this shell command" },
          },
          resolve: execution => {
            const id = execution?.agent?.session?.header?.id;
            if (typeof id !== "string") return {};
            return { DSH_AGENT_FLEET_PARENT: `dsh:${id}`, ...(typeof execution.callId === "string" ? { DSH_AGENT_FLEET_PARENT_CALL: execution.callId } : {}) };
          },
        });
      } catch (error) { log("warn", `shell variables DSH_AGENT_FLEET_PARENT* not registered: ${error?.message ?? error}`); }
    });
  } catch (error) { log("warn", `shell variables DSH_AGENT_FLEET_PARENT* not registered: ${error?.message ?? error}`); }
}

/** @returns a promise that settles when the optional model tool is registered or skipped (DSH treats it as part of loading). */
export function apply(ctx, config, deps = {}) {
  const settings = resolveConfig(config);
  const wiring = { ...defaultDeps, ...deps };
  const log = (level, message) => ctx.logger?.[level]?.(`agent-fleet: ${message}`);
  const link = connectHub(ctx, settings, wiring, log), { ready, stop } = link;
  const hub = withSnapshotCache(link.hub);
  ctx.effect(() => stop, "agent-fleet: hub link");

  const localToken = tokenReader(settings.tokenFile);
  rpc(ctx, "agent-fleet/snapshot", (_payload, signal) => hub.request("snapshot", {}, { signal }));
  rpc(ctx, "agent-fleet/changes", (payload, signal) => {
    const since = Number(payload.since);
    return hub.request("changes", { since: Number.isFinite(since) ? Math.max(0, Math.trunc(since)) : 0 }, { signal });
  });
  rpc(ctx, "agent-fleet/family", async (payload, signal) => {
    if (typeof payload.key === "string" && payload.key.trim() !== "") return hub.request("family", { key: payload.key.trim() }, { signal });
    const session = requireString(payload, "dshSessionId");
    const found = resolveFamily(await hub.request("snapshot", {}, { signal }), session);
    if (found === null) throw new Error(`no agent matches DSH session ${session}`);
    return { ...(await hub.request("family", { key: found.rootKey }, { signal })), resolved: found.agent.key };
  });
  rpc(ctx, "agent-fleet/file", (payload, signal) => hub.request("file", { host: requireString(payload, "host"), path: requireString(payload, "path") }, { signal }));
  rpc(ctx, "agent-fleet/pod", (payload, signal) => hub.request("pod", { key: requireString(payload, "key") }, { signal }));
  rpc(ctx, "agent-fleet/query", (payload, signal) => hub.request("query", Object.fromEntries(QUERY_FIELDS.filter(field => payload[field] !== undefined).map(field => [field, payload[field]])), { signal }));
  rpc(ctx, "agent-fleet/panel-url", async payload => {
    const sessionId = sessionIdOf(payload);
    await ready;
    const base = panelBase(settings);
    if (!tokenGoesInUrl(base)) return { url: panelLocation(base, { sessionId }), mode: settings.mode };
    const nonce = await mintPanelNonce(settings, await localToken());
    return { url: panelNonceLocation(base, { nonce, sessionId }), mode: settings.mode };
  });

  registerShellEnv(ctx, log);
  return registerTool(ctx, hub, wiring, log);
}
