// `agent-fleet collector`: command line → startCollector + one transport to a hub:
//   --stdio              this process's stdin/stdout (started by `kubectl exec -i … node collector.mjs --stdio`, or ssh)
//   --connect HOST:PORT  a TCP connection to the hub's collector ingest, redialed with backoff
//   --ssh TARGET         `ssh -W 127.0.0.1:<--ssh-port> TARGET`, redialed with backoff
// stdout is the protocol channel in --stdio mode: everything that is not protocol goes to stderr.
import { readFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { createChannel, keepConnected, sshForwardTransport, stdioTransport, tcpTransport } from "../channel.mjs";
import { KUBE_CONTEXTS, parsePodHostId, siteOfSshTarget } from "../protocol.mjs";
import { startCollector } from "./index.mjs";
import { parseRootFlag } from "./roots.mjs";
import { parseDuration } from "./util.mjs";

export const COLLECTOR_USAGE = `usage: agent-fleet collector (--stdio | --connect HOST:PORT | --ssh TARGET [--ssh-port 7841]) [options]
  --host-id ID        host id in the fleet (default: this machine's hostname; pods: k8s/<site>/<pod>)
  --site SITE         mac | server-bochao-01 | sg-compute | chengdu | weihai | iron | os (default: derived)
  --label TEXT        human label (default: the host id)
  --kind KIND         workstation | server | pod (default: derived)
  --root KIND=PATH    extra session root, repeatable; KIND is dsh|claude|codex|omp, PATH may contain * and ? segments
  --no-default-roots  do not watch the default roots (~/.claude/projects, ~/.codex/sessions, ~/.omp/agent/sessions, ~/.dsh/sessions…)
  --sidecar PATH      DSH ACP sidecar.sqlite, repeatable (default: <dsh root>/../dsh-acp/sidecar.sqlite)
  --since DURATION    load sessions modified within this window at start (default 24h)
  --token-file FILE   ingest credential for --connect and --ssh, sent in hello (read on every reconnect;
                      the hub creates ~/.config/agent-fleet/ingest-token 0600). Not needed for --stdio.
  --cluster, --namespace, --pod, --node   pod identity (default: from the pod environment)
Roots are also read from AGENT_FLEET_ROOTS (kind=path:kind=path).
`;

/** @returns {object} parsed options; throws an Error with a user-facing message on bad input */
export function parseCollectorArgs(argv, { env = process.env, platform = process.platform, hostname = osHostname() } = {}) {
  const options = { roots: [], sidecars: [], defaults: true, sshPort: 7841, since: "24h" };
  for (let i = 0; i < argv.length; i += 1) {
    let flag = argv[i], inline;
    const eq = flag.startsWith("--") ? flag.indexOf("=") : -1;
    if (eq > 0) { inline = flag.slice(eq + 1); flag = flag.slice(0, eq); }
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[i += 1];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return next;
    };
    switch (flag) {
      case "--host-id": options.hostId = value(); break;
      case "--site": options.site = value(); break;
      case "--label": options.label = value(); break;
      case "--kind": options.kind = value(); break;
      case "--root": options.roots.push(parseRootFlag(value())); break;
      case "--sidecar": options.sidecars.push(value()); break;
      case "--since": options.since = value(); break;
      case "--token-file": options.tokenFile = value(); break;
      case "--cluster": options.cluster = value(); break;
      case "--namespace": options.namespace = value(); break;
      case "--pod": options.pod = value(); break;
      case "--node": options.node = value(); break;
      case "--no-default-roots": options.defaults = false; break;
      case "--stdio": options.stdio = true; break;
      case "--connect": options.connect = value(); break;
      case "--ssh": options.ssh = value(); break;
      case "--ssh-port": options.sshPort = Number(value()); break;
      case "--help": case "-h": options.help = true; break;
      default: throw new Error(`unknown option ${flag}`);
    }
  }
  if (options.help) return options;
  if ([options.stdio, options.connect, options.ssh].filter(Boolean).length !== 1) throw new Error("choose exactly one transport: --stdio, --connect HOST:PORT or --ssh TARGET");
  if (!Number.isInteger(options.sshPort) || options.sshPort <= 0) throw new Error("--ssh-port must be a port number");
  if (options.kind !== undefined && !["workstation", "server", "pod"].includes(options.kind)) throw new Error("--kind must be workstation, server or pod");
  options.sinceMs = parseDuration(options.since);
  if (options.connect !== undefined) {
    const at = options.connect.lastIndexOf(":");
    const port = Number(options.connect.slice(at + 1));
    if (at <= 0 || !Number.isInteger(port) || port <= 0) throw new Error("--connect expects HOST:PORT");
    options.connectTo = { host: options.connect.slice(0, at), port };
  }

  const hostId = options.hostId ?? hostname;
  const pod = parsePodHostId(hostId);
  const site = options.site ?? pod?.site ?? siteOfSshTarget(hostname) ?? (platform === "darwin" ? "mac" : hostname);
  const kind = options.kind ?? (pod ? "pod" : platform === "darwin" ? "workstation" : "server");
  const hostInfo = { id: hostId, site, kind, label: options.label ?? pod?.pod ?? hostId, hostname, platform };
  if (kind === "pod") {
    const cluster = options.cluster ?? KUBE_CONTEXTS[site];
    const namespace = options.namespace ?? env.POD_NAMESPACE ?? readText("/var/run/secrets/kubernetes.io/serviceaccount/namespace");
    const podName = options.pod ?? pod?.pod ?? env.POD_NAME ?? env.HOSTNAME;
    const node = options.node ?? env.NODE_NAME;
    Object.assign(hostInfo, { ...(cluster && { cluster }), ...(namespace && { namespace }), ...(podName && { pod: podName }), ...(node && { node }) });
  }
  options.hostInfo = hostInfo;
  return options;
}

function readText(path) {
  try { return readFileSync(path, "utf8").trim() || undefined; } catch { return undefined; }
}

const stderrLog = message => process.stderr.write(`[agent-fleet collector] ${message}\n`);

/**
 * Add the ingest credential to the hello the collector sends; every other message passes through untouched.
 * `startCollector` emits hello (and re-emits it on resync) through this same `send`.
 */
export function helloToken(send, token) {
  if (typeof token !== "string" || token === "") return send;
  return message => send(message?.t === "hello" ? { ...message, token } : message);
}

/**
 * Run a collector until the transport ends or a signal arrives. Resolves once wired; the process stays alive on its own.
 * @param {string[]} argv  arguments after the `collector` subcommand
 */
export async function collectorMain(argv = process.argv.slice(2)) {
  let options;
  try { options = parseCollectorArgs(argv); } catch (error) {
    process.stderr.write(`agent-fleet collector: ${error.message}\n${COLLECTOR_USAGE}`);
    process.exitCode = 2;
    return null;
  }
  if (options.help) { process.stdout.write(COLLECTOR_USAGE); return null; }

  if (options.stdio) for (const name of ["log", "info", "debug"]) console[name] = (...args) => console.error(...args);
  const collectorOptions = {
    hostInfo: options.hostInfo, roots: options.roots, defaults: options.defaults, since: options.sinceMs,
    ...(options.sidecars.length > 0 && { sidecars: options.sidecars }), log: stderrLog,
  };

  let collector = null, link = null, stopping = false;
  const keepAlive = setInterval(() => {}, 1 << 30); // the collector's own timers are unref'd
  const shutdown = (code, why) => {
    if (stopping) return;
    stopping = true;
    stderrLog(`stopping: ${why}`);
    clearInterval(keepAlive);
    link?.stop();
    collector?.stop();
    const done = () => process.exit(code);
    if (options.stdio && !process.stdout.destroyed) { process.stdout.end(); process.stdout.once("finish", done); setTimeout(done, 500).unref(); } else setTimeout(done, 20);
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => shutdown(0, signal));
  process.on("uncaughtException", error => { stderrLog(`fatal: ${error.stack ?? error.message}`); shutdown(1, "uncaught exception"); });

  if (options.stdio) {
    const transport = stdioTransport();
    const channel = createChannel({
      ...transport, label: "stdio",
      onRequest: (method, params) => collector.handleRequest(method, params),
      onClose: reason => shutdown(0, reason),
    });
    process.stdout.on("error", () => shutdown(0, "stdout closed"));
    collector = startCollector({ ...collectorOptions, send: channel.send, congested: () => transport.writable.writableNeedDrain });
    return collector;
  }

  let transport = null, token;
  const connect = async () => {
    token = options.tokenFile === undefined ? undefined : readText(options.tokenFile);
    if (options.tokenFile !== undefined && token === undefined) stderrLog(`no token in ${options.tokenFile} yet; the hub will refuse this collector until it exists`);
    transport = options.connectTo ? await tcpTransport(options.connectTo) : sshForwardTransport({ target: options.ssh, port: options.sshPort });
    return transport;
  };
  link = keepConnected({
    connect, label: options.connectTo ? `tcp ${options.connect}` : `ssh ${options.ssh}`,
    channelOptions: { onRequest: (method, params) => collector.handleRequest(method, params) },
    onState: (state, detail) => stderrLog(detail ? `${state}: ${detail}` : state),
    onChannel: channel => {
      const congested = () => transport?.writable?.writableNeedDrain === true;
      const send = helloToken(channel.send, token);   // the collector's first message is the hello; the credential rides there
      if (collector === null) collector = startCollector({ ...collectorOptions, send, congested });
      else collector.resync(send);
    },
  });
  return { stop: () => shutdown(0, "stop") };
}
