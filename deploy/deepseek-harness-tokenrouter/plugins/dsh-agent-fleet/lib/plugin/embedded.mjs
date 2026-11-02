// Embedded mode (the Mac desktop app): the hub runs inside the DSH process, fed by a local collector, follows the server
// hub (upstream, over `ssh -W` to its loopback port 7840) and pushes this machine's collector to the server hub's ingest
// (`ssh -W` to 7841). `startHub`, `startCollector`, `keepConnected` and `sshForwardTransport` arrive as `deps`.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { SITE_LABELS } from "../protocol.mjs";
import { HUB_URL, INGEST_PORT } from "./config.mjs";

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
/** Same default as `upstream.ingestTokenFile` in config.mjs; kept here so an older config row still authenticates. */
const UPSTREAM_INGEST_TOKEN_FILE = join(homedir(), ".config", "agent-fleet", "upstream-ingest-token");

/**
 * Add the ingest credential to the collector's hello; the server hub compares it in constant time and refuses
 * anonymous channels on its ingest port. Every other message passes through untouched.
 */
export function helloToken(send, token) {
  if (typeof token !== "string" || token === "") return send;
  return message => send(message?.t === "hello" ? { ...message, token } : message);
}

/** `6h` / `90m` / milliseconds → milliseconds. */
export function sinceMs(value) {
  if (Number.isFinite(value)) return value;
  const match = /^(\d+(?:\.\d+)?)\s*([smhd])$/i.exec(String(value).trim());
  if (match === null) throw new Error(`dsh-agent-fleet config: collector.since must look like "6h", "90m" or be milliseconds, got ${JSON.stringify(value)}`);
  return Number(match[1]) * UNIT_MS[match[2].toLowerCase()];
}

/** Session roots of this machine: the CONTRACT defaults plus `collector.roots` (extra directories per kind). */
export function sessionRoots(settings, { dshHome, home = homedir(), exists = existsSync } = {}) {
  const paseo = join(home, ".paseo/agents/omp/sessions");
  const defaults = {
    dsh: [join(dshHome, "sessions")],
    claude: [join(home, ".claude/projects")],
    codex: [join(home, ".codex/sessions"), join(home, ".codex/archived_sessions")],
    omp: [join(home, ".omp/agent/sessions"), ...(exists(paseo) ? [paseo] : [])],
  };
  return Object.fromEntries(Object.entries(defaults).map(([kind, dirs]) => [kind, [...new Set([...dirs, ...(settings.collector.roots?.[kind] ?? [])])]]));
}

export function hostInfoFor(settings, roots) {
  return {
    id: settings.hostId,
    site: settings.site,
    kind: "workstation",
    label: SITE_LABELS[settings.site] ?? settings.hostId,
    hostname: hostname(),
    platform: process.platform,
    roots,
  };
}

async function readSecret(file) {
  try { return (await readFile(file, "utf8")).trim(); } catch { return ""; }
}

/** The followed hub, or null when this machine has no way to reach one (no ssh target, no URL) or no token for it. */
async function upstreamOptions(settings, log) {
  const { sshTarget, url, tokenFile } = settings.upstream;
  const direct = url ?? settings.hubUrl;
  if (sshTarget === undefined && direct === undefined) return null;
  const token = await readSecret(tokenFile);
  if (token === "") {
    log("warn", `the desktop hub shows this machine only: ${tokenFile} has no token for the server hub (copy the server's ~/.config/agent-fleet/token there)`);
    return null;
  }
  return { url: direct ?? HUB_URL, token, ...(sshTarget === undefined ? {} : { sshTarget }) };
}

/** Collector pushed to the server hub's ingest through ssh; a new collector (hello + initial load) per connection. */
function startUplink({ settings, collectorOptions, deps, log }) {
  let collector = null, last = "", token = "", tokenWarned = false;
  const tokenFile = settings.upstream.ingestTokenFile ?? UPSTREAM_INGEST_TOKEN_FILE;
  const stopCollector = () => {
    const stopping = collector;
    collector = null;
    try { stopping?.stop(); } catch (error) { log("warn", `collector stop failed: ${error.message}`); }
  };
  const link = deps.keepConnected({
    label: "agent-fleet uplink",
    connect: async () => {
      token = await readSecret(tokenFile);          // re-read every connect: a token file copied after startup works on the next retry
      if (token === "" && !tokenWarned) {
        tokenWarned = true;
        log("warn", `no ingest token at ${tokenFile}: the server hub will refuse this collector (copy its ~/.config/agent-fleet/ingest-token there)`);
      }
      return deps.sshForwardTransport({ target: settings.upstream.sshTarget, port: INGEST_PORT });
    },
    channelOptions: {
      onRequest: (method, params) => {
        if (collector === null) throw new Error("collector is not running");
        return collector.handleRequest(method, params);
      },
      onClose: stopCollector,
    },
    onChannel: channel => {
      stopCollector();
      collector = deps.startCollector({ ...collectorOptions, send: helloToken(channel.send, token) });
    },
    onState: (state, detail) => {
      if (state === "connecting" || state === last) return;
      last = state;
      log(state === "online" ? "info" : "warn", state === "online" ? `connected to the server hub ingest via ssh ${settings.upstream.sshTarget}` : `server hub unreachable via ssh ${settings.upstream.sshTarget}${detail ? `: ${detail}` : ""}; retrying`);
    },
  });
  return { stop() { link.stop(); stopCollector(); } };
}

/**
 * @returns {Promise<{api: {request(method: string, params?: object): Promise<any>}, stop(): Promise<void>}>}
 */
export async function startEmbedded({ settings, dshHome, panelDir, version, deps, log }) {
  const roots = sessionRoots(settings, { dshHome });
  const hostInfo = hostInfoFor(settings, roots);
  const collectorOptions = { hostInfo, roots, ...(settings.collector.since === undefined ? {} : { since: sinceMs(settings.collector.since) }) };
  const upstream = await upstreamOptions(settings, log);
  const hub = await deps.startHub({
    hostId: settings.hostId,
    version,
    http: { host: "127.0.0.1", port: settings.httpPort, tokenFile: settings.tokenFile, panelDir },
    local: { collectorOptions },
    ...(upstream === null ? {} : { upstream }),
  });
  let uplink = null;
  try {
    if (settings.upstream.sshTarget !== undefined) uplink = startUplink({ settings, collectorOptions, deps, log });
    else log("info", "no upstream.sshTarget configured: this machine is not pushed to the server hub");
  } catch (error) {
    await hub.stop();
    throw error;
  }
  return { api: hub.api, async stop() { uplink?.stop(); await hub.stop(); } };
}
