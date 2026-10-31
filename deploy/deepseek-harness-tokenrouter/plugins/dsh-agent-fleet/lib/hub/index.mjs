// Hub entry points. `startHub` wires the state, the HTTP server, the collector ingest, the in-process collector,
// the kube source and upstream subscriptions into one object; `hubMain` is the `agent-fleet hub` command.
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { KUBE_CONTEXTS, siteOfSshTarget } from "../protocol.mjs";
import { createApi } from "./api.mjs";
import { createAuth, defaultTokenFile, loadToken } from "./auth.mjs";
import { startHttpServer } from "./http.mjs";
import { createState } from "./state.mjs";
import { createCollectorLinks, dialCollector, startIngestServer } from "./sources/collector-link.mjs";
import { createKubeSource } from "./sources/kube.mjs";
import { startLocalCollector } from "./sources/local.mjs";
import { createUpstream } from "./sources/upstream.mjs";

export const HTTP_PORT = 7840;
export const INGEST_PORT = 7841;
const PANEL_DIR = fileURLToPath(new URL("../../panel/", import.meta.url));
const BUNDLE_FILE = fileURLToPath(new URL("../../dist/agent-fleet-collector.mjs", import.meta.url));

/**
 * @param {object} [options]
 * @param {string} [options.hostId]      this machine's host id (the in-process collector reports as this host)
 * @param {string} [options.version]
 * @param {() => number} [options.now]
 * @param {{host?: string, port: number, base?: string, tokenFile: string, panelDir?: string, publicHosts?: string[]}} [options.http]
 *        omit for an API-only hub (in-process callers)
 * @param {{host?: string, port: number, token?: string, tokenFile?: string, helloTimeoutMs?: number}} [options.ingest]
 *        collector ingest (loopback); `tokenFile` is read or created (0600) like the HTTP token
 * @param {{command: string, args?: string[], label?: string, hostId?: string}[]} [options.collectors]  collectors the hub starts and dials
 * @param {object | object[]} [options.upstream]  {url, token, sshTarget?, name?}: follow other hubs
 * @param {object} [options.kube]         createKubeSource options ({kubeconfig, kubectl, sites, collectorBundle, …}); `create` swaps the factory
 * @param {{collectorOptions?: object, load?: Function}} [options.local]  run a collector in this process
 * @param {(level: string, message: string) => void} [options.log]
 * @returns {Promise<{state: object, api: {request(method: string, params?: object): Promise<any>}, http: object | null, ingest: object | null,
 *   addCollectorChannel(transport: {readable: any, writable: any, close?: Function}, options?: {via?: string, label?: string}): object, stop(): Promise<void>}>}
 */
export async function startHub({ hostId = "hub", version = "0.0.0", now = Date.now, http, ingest, collectors = [], upstream, kube, local, log = () => {}, staleAfterMs, coalesceMs, tickMs = 1000 } = {}) {
  const state = createState({ now, hostId, version, staleAfterMs, coalesceMs });
  // The ingest credential is its own secret: a collector host must not learn the panel/file-read token. `tokenFile`
  // is created on first use exactly like the HTTP token; an explicit `token` (tests, embedded callers) wins.
  const ingestToken = ingest === undefined ? null
    : (typeof ingest.token === "string" && ingest.token !== "" ? ingest.token : (ingest.tokenFile === undefined ? null : loadToken(ingest.tokenFile)));
  const links = createCollectorLinks({ state, log, token: ingestToken, ...(ingest?.helloTimeoutMs === undefined ? {} : { helloTimeoutMs: ingest.helloTimeoutMs }) });
  const upstreams = new Map();
  const dials = [];
  const where = {};
  let api = null, kubeSource = null, localCollector = null, httpServer = null, ingestServer = null, tickTimer = null, stopped = false;

  async function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(tickTimer);
    await Promise.allSettled([...upstreams.values()].map(source => source.stop()));
    await Promise.allSettled([kubeSource?.stop(), localCollector?.stop()]);
    for (const dial of dials) dial.stop();
    links.closeAll();
    await Promise.allSettled([ingestServer?.close(), httpServer?.close()]);
    state.close();
  }

  try {
    if (kube) {
      const { create = createKubeSource, ...kubeOptions } = kube;
      kubeSource = create({
        ...kubeOptions, now,
        onPods: (site, pods, mode) => state.setPods(site, pods, { replace: mode === "list" }),
        onPodGone: (_site, key) => state.removePod(key),
        onSourceState: (site, sourceState) => state.setSource(site, sourceState),
        attachCollector: (_site, _pod, spec) => {
          const dial = dialCollector({ links, via: "pod-exec", ...spec, log });
          return { stop() { dial.stop(); state.forgetHost(spec.hostId); } };   // a pod that never produced data leaves no host behind
        },
      });
      state.setPodLookup(ref => kubeSource.getPod(ref));
    }

    const upstreamList = [].concat(upstream ?? []);
    upstreamList.forEach((options, index) => {
      const name = options.name ?? (upstreamList.length === 1 ? "upstream" : `upstream-${index + 1}`);
      upstreams.set(name, createUpstream({ ...options, name, sink: state.upstream(name), log }));
    });

    api = createApi({ state, links, kube: kubeSource, upstreams, listeners: () => where, log });

    if (http) {
      const auth = createAuth({ token: loadToken(http.tokenFile ?? defaultTokenFile()), publicHosts: http.publicHosts });
      httpServer = await startHttpServer({ host: http.host, port: http.port, base: http.base, auth, api, state, panelDir: http.panelDir, keepAliveMs: http.keepAliveMs, log });
      where.http = { host: http.host ?? "127.0.0.1", port: httpServer.port, base: httpServer.base };
    }
    if (ingest) {
      ingestServer = await startIngestServer({ host: ingest.host, port: ingest.port, links, log });
      where.ingest = { host: ingest.host ?? "127.0.0.1", port: ingestServer.port };
    }

    if (local) {
      try {
        localCollector = await startLocalCollector({ hostId, collectorOptions: local.collectorOptions, links, now, log, ...(local.load ? { load: local.load } : {}) });
      } catch (error) {                        // the hub still serves what it can; the failure shows as this host's state
        log("error", `local collector failed to start: ${error.message}`);
        state.hostState(hostId, { status: "error", error: `local collector failed to start: ${error.message}`, via: "local", info: { id: hostId, site: hostId, kind: "server", label: hostId } });
      }
    }
    for (const spec of collectors) dials.push(dialCollector({ links, ...spec, log }));
    kubeSource?.start();
    for (const source of upstreams.values()) source.start();
    tickTimer = setInterval(() => state.tick(), tickMs);
    tickTimer.unref();
  } catch (error) {
    await stop();
    throw error;
  }

  return {
    state, api, upstreams,
    http: where.http ?? null,
    ingest: where.ingest ?? null,
    /** Serve a collector over an existing duplex ({readable, writable, close?}); the hub answers its hello. */
    addCollectorChannel: (transport, { via = "socket", label = "collector" } = {}) => links.attach(transport, { via, label }),
    stop,
  };
}

// ---------------------------------------------------------------------------------------------------- CLI

const USAGE = `agent-fleet hub [options]
  --listen HOST:PORT         HTTP API + panel (default 127.0.0.1:${HTTP_PORT}); loopback only
  --ingest HOST:PORT|off     collector ingest for ssh -W relays (default 127.0.0.1:${INGEST_PORT})
  --base /prefix             also answer under this path prefix (edge router: /fleet)
  --public-host NAME         extra Host header name to accept (repeatable)
  --token-file FILE          API token (created 0600 when missing; default ~/.config/agent-fleet/token)
  --ingest-token-file FILE   collector ingest token (created 0600 when missing); collectors send it in hello,
                             hub-dialed collectors (kubectl exec, --dial-ssh, in-process) do not need it
  --panel-dir DIR            panel files (default: the plugin's panel/)
  --host-id ID --site SITE   identity of this machine for the in-process collector
  --label TEXT --kind workstation|server|pod
  --since DURATION           load sessions modified within this window (collector default 24h)
  --root KIND=PATH           extra session root (repeatable)   --sidecar FILE   ACP sidecar.sqlite (repeatable)
  --no-local                 do not run a collector in this process
  --kubeconfig FILE          watch the fleet clusters (kubectl must be on PATH or --kubectl)
  --kubectl BIN  --kube-sites a,b  --collector-bundle FILE
  --dial-ssh TARGET=HOSTID   start a collector over ssh and keep it connected (repeatable); --dial-command CMD (default agent-fleet)
  --upstream URL --upstream-token-file FILE [--upstream-ssh TARGET] [--upstream-name NAME]
`;

const FLAGS = {
  listen: { type: "string" }, ingest: { type: "string" }, base: { type: "string" }, "public-host": { type: "string", multiple: true },
  "token-file": { type: "string" }, "ingest-token-file": { type: "string" }, "panel-dir": { type: "string" }, "host-id": { type: "string" }, site: { type: "string" }, label: { type: "string" },
  kind: { type: "string" }, since: { type: "string" }, root: { type: "string", multiple: true }, sidecar: { type: "string", multiple: true },
  "no-local": { type: "boolean" }, kubeconfig: { type: "string" }, kubectl: { type: "string" }, "kube-sites": { type: "string" }, "collector-bundle": { type: "string" },
  "dial-ssh": { type: "string", multiple: true }, "dial-command": { type: "string" },
  upstream: { type: "string" }, "upstream-token-file": { type: "string" }, "upstream-ssh": { type: "string" }, "upstream-name": { type: "string" },
  help: { type: "boolean", short: "h" },
};

/** "6h", "90m", "2d", "1500" (ms) → milliseconds, for `--since`. */
function durationMs(text) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?\s*$/i.exec(text);
  if (!match) throw new Error(`invalid duration ${JSON.stringify(text)} (use e.g. 90m, 6h, 24h, 2d)`);
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[(match[2] ?? "ms").toLowerCase()];
  return Math.round(Number(match[1]) * unit);
}

function hostPort(text, flag) {
  const match = /^(?:(\[[^\]]+\]|[^:]+):)?(\d+)$/.exec(text ?? "");
  if (!match) throw new Error(`${flag} expects HOST:PORT, got ${JSON.stringify(text)}`);
  return { host: (match[1] ?? "127.0.0.1").replace(/^\[|\]$/g, ""), port: Number(match[2]) };
}

/** CLI arguments → startHub options (`options.upstream.tokenFile` is read by `hubMain`). Exported for tests. */
export function parseHubArgs(argv) {
  const { values } = parseArgs({ args: argv, options: FLAGS, allowPositionals: false });
  if (values.help) return { help: true };
  const hostId = values["host-id"] ?? hostname();
  const site = values.site ?? hostId;
  const listen = hostPort(values.listen ?? `127.0.0.1:${HTTP_PORT}`, "--listen");
  const options = {
    hostId,
    http: { ...listen, base: values.base, tokenFile: values["token-file"] ?? defaultTokenFile(), panelDir: values["panel-dir"] ?? PANEL_DIR, publicHosts: values["public-host"] ?? [] },
    collectors: [],
  };
  if (values.ingest !== "off") {
    options.ingest = hostPort(values.ingest ?? `127.0.0.1:${INGEST_PORT}`, "--ingest");
    if (values["ingest-token-file"] !== undefined) options.ingest.tokenFile = values["ingest-token-file"];
  }
  if (!values["no-local"]) {
    const collectorOptions = { hostInfo: { site, label: values.label ?? hostId, kind: values.kind ?? "server" } };
    if (values.since) collectorOptions.since = durationMs(values.since);
    if (values.root?.length) collectorOptions.roots = values.root;
    if (values.sidecar?.length) collectorOptions.sidecars = values.sidecar;
    options.local = { collectorOptions };
  }
  if (values.kubeconfig) {
    const names = values["kube-sites"] ? values["kube-sites"].split(",").map(name => name.trim()).filter(Boolean) : Object.keys(KUBE_CONTEXTS);
    const unknown = names.filter(name => !(name in KUBE_CONTEXTS));
    if (unknown.length > 0) throw new Error(`--kube-sites: unknown site ${unknown.join(", ")} (known: ${Object.keys(KUBE_CONTEXTS).join(", ")})`);
    const bundle = values["collector-bundle"] ?? (existsSync(BUNDLE_FILE) ? BUNDLE_FILE : undefined);
    options.kube = {
      kubeconfig: values.kubeconfig, ...(values.kubectl ? { kubectl: values.kubectl } : {}),
      sites: Object.fromEntries(names.map(name => [name, KUBE_CONTEXTS[name]])), ...(bundle ? { collectorBundle: bundle } : {}),
    };
  }
  for (const entry of values["dial-ssh"] ?? []) {
    const [target, id] = entry.split("=");
    if (!target || !id) throw new Error(`--dial-ssh expects TARGET=HOSTID, got ${JSON.stringify(entry)}`);
    const remote = values["dial-command"] ?? "agent-fleet";
    options.collectors.push({
      command: "ssh", via: "ssh-relay", label: `ssh ${target}`, hostId: id,
      args: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", target,
        `${remote} collector --stdio --host-id ${id} --site ${siteOfSshTarget(target) ?? id}`],
    });
  }
  if (values.upstream) {
    if (!values["upstream-token-file"]) throw new Error("--upstream needs --upstream-token-file");
    options.upstream = { url: values.upstream, tokenFile: values["upstream-token-file"], sshTarget: values["upstream-ssh"], name: values["upstream-name"] };
  }
  return options;
}

const stderrLog = (level, message) => process.stderr.write(`${new Date().toISOString()} ${level} ${message}\n`);

/** `agent-fleet hub …`: run until SIGINT / SIGTERM. */
export async function hubMain(argv = process.argv.slice(2)) {
  let options;
  try { options = parseHubArgs(argv); } catch (error) { process.stderr.write(`agent-fleet hub: ${error.message}\n${USAGE}`); process.exitCode = 2; return; }
  if (options.help) { process.stdout.write(USAGE); return; }
  if (options.upstream) {
    const { readFileSync } = await import("node:fs");
    const { tokenFile, ...rest } = options.upstream;
    options.upstream = { ...rest, token: readFileSync(tokenFile, "utf8").trim() };
  }
  const version = JSON.parse((await import("node:fs")).readFileSync(join(fileURLToPath(new URL("../../", import.meta.url)), "package.json"), "utf8")).version;
  const hub = await startHub({ ...options, version, log: stderrLog });
  stderrLog("info", `hub ${options.hostId} up: http ${hub.http ? `${hub.http.host}:${hub.http.port}${hub.http.base}` : "off"}, ingest ${hub.ingest ? `${hub.ingest.host}:${hub.ingest.port}` : "off"}`);
  await new Promise(resolve => { for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, resolve); });
  await hub.stop();
}
