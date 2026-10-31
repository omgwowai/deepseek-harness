// Collector links: how collector channels reach the hub state.
//
//   createCollectorLinks   per-channel lifecycle (hello within 10 s, optional token, silence watchdog, supersede
//                          an older channel of the same host) plus request routing to a host's collector
//   startIngestServer      TCP listener on loopback; remote collectors arrive through `ssh -W 127.0.0.1:<port>`
//   dialCollector          spawn a collector over a child's stdio (kubectl exec -i, ssh host agent-fleet collector
//                          --stdio) and keep it connected with backoff
import { createServer } from "node:net";
import { createChannel, keepConnected, spawnTransport } from "../../channel.mjs";
import { KUBE_CONTEXTS, LIMITS, NAMESPACE, parsePodHostId } from "../../protocol.mjs";
import { isLoopbackAddress, safeEqual } from "../auth.mjs";

const HOST_ID = /^[^#\u0000-\u001f\u007f]{1,200}$/;          // anything printable except "#", which separates host and session in agent keys
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
// Ingest is reachable by every process that may open `ssh -W` to the hub (the token is the gate; this line is the
// second one). The largest real collector message measured on the Mac is 85 KiB (200 events); 2 MiB keeps ~24x
// headroom while a single 16 MiB line from an unauthenticated peer can no longer pin the hub's memory.
const INGEST_MAX_LINE = 2 * 1024 * 1024;

/**
 * @param {object} options
 * @param {ReturnType<import("../state.mjs").createState>} options.state
 * @param {(level: string, message: string) => void} [options.log]
 * @param {number} [options.helloTimeoutMs]  a channel that does not say hello in time is closed
 * @param {number} [options.silenceMs]       a channel that sends nothing (heartbeats included) this long is closed
 * @param {number} [options.watchdogMs]
 * @param {string} [options.token]           when set, `hello.token` must match on channels opened with `checkToken`
 * @param {() => number} [options.now]       clock of the watchdogs (tests inject a fake one)
 * @param {{setTimeout: Function, clearTimeout: Function, setInterval: Function, clearInterval: Function}} [options.timers]
 *        timer primitives of the watchdogs (tests inject a fake clock)
 */
export function createCollectorLinks({ state, log = () => {}, helloTimeoutMs = 10_000, silenceMs = 30_000, watchdogMs = 5_000, token = null, now = Date.now, timers = globalThis }) {
  const { setTimeout: setTimer, clearTimeout: clearTimer, setInterval: repeatTimer, clearInterval: stopTimer } = timers;
  const channels = new Map();        // host id → {channel, connection}
  const open = new Set();            // every bound connection
  let stopped = false;
  // A watchdog tick this much later than the previous one means this process stopped running (event-loop stall, freeze),
  // so the time it measured says nothing about the peer: reset the silence clock instead of closing every channel.
  const stallMs = Math.min(silenceMs, 2 * watchdogMs);

  /** Handlers for one channel; call `bind(channel)` once the channel exists. */
  function newConnection({ via = "socket", label = "collector", expectHostId, checkToken = false } = {}) {
    let channel = null, hostId = null, connection = null, helloTimer = null, watchdog = null, lastRx = now();
    const conn = {
      bind(created) {
        channel = created;
        open.add(conn);
        const armHello = () => {
          const armedAt = now();
          helloTimer = setTimer(() => {
            const late = now() - armedAt - helloTimeoutMs;
            if (late > helloTimeoutMs) {     // the timer fired much later than scheduled: the peer had no chance to be read
              log("warn", `${label}: hello timeout fired ${late} ms late (process stalled); waiting again`);
              armHello();
              return;
            }
            channel.close(`no hello within ${helloTimeoutMs} ms`);
          }, helloTimeoutMs);
          helloTimer.unref?.();
        };
        armHello();
        let lastTick = now();
        watchdog = repeatTimer(() => {
          const at = now(), gap = at - lastTick;
          lastTick = at;
          if (gap > stallMs) {
            lastRx = at;
            log("warn", `${label}: silence watchdog fired ${gap} ms late (process stalled); silence clock reset`);
            return;
          }
          if (at - lastRx > silenceMs) channel.close(`no data for ${Math.round(silenceMs / 1000)} s`);
        }, watchdogMs);
        watchdog.unref?.();
        if (stopped) channel.close("hub stopped");
      },

      onMessage(message) {
        lastRx = now();
        if (hostId !== null) { state.applyCollectorMessage(hostId, message, connection); return; }
        if (message.t !== "hello") { channel.close("first message must be hello"); return; }
        if (checkToken && token !== null && !safeEqual(typeof message.token === "string" ? message.token : "", token)) { channel.close("bad token"); return; }
        const id = message.host.id;
        if (!HOST_ID.test(id)) { channel.close("invalid host id"); return; }
        if (expectHostId !== undefined && id !== expectHostId) { channel.close(`host id mismatch: expected ${expectHostId}, collector says ${id}`); return; }
        const previous = channels.get(id);
        // A live host id belongs to the transport it connected over: a channel that arrives another way (a raw socket
        // hello for a pod the hub dials over kubectl exec, or for the hub's own in-process collector) must not replace
        // it. The token already gates sockets; this keeps a second, differently-trusted path from stealing a host.
        if (previous !== undefined && previous.via !== via && state.host(id)?.status === "online") {
          log("warn", `collector ${id} over ${via} refused: the host is already online over ${previous.via}`);
          channel.close(`host ${id} is already online over ${previous.via}`);
          return;
        }
        clearTimeout(helloTimer);
        hostId = id;
        connection = state.hostConnected(message.host, { at: message.at, via });
        channels.set(id, { channel, connection, via });
        previous?.channel.close("superseded by a newer connection");
        log("info", `collector ${id} connected via ${via}`);
      },

      onClose(reason) {
        clearTimer(helloTimer);
        stopTimer(watchdog);
        open.delete(conn);
        if (hostId === null) return;
        if (channels.get(hostId)?.channel === channel) channels.delete(hostId);
        if (state.hostDisconnected(hostId, { connection, reason })) log("warn", `collector ${hostId} disconnected: ${reason}`);
      },
    };
    return conn;
  }

  return {
    newConnection,

    /** Wrap a transport ({readable, writable, close?}) in a hub-owned channel. */
    attach(transport, options = {}) {
      const conn = newConnection(options);
      const channel = createChannel({
        ...transport, label: options.label ?? "collector", maxLine: options.maxLine ?? LIMITS.lineBytes,
        onMessage: conn.onMessage, onClose: conn.onClose,
      });
      conn.bind(channel);
      return channel;
    },

    has: id => channels.has(id),
    /** True when a collector of this host has said hello at least once (as opposed to only being dialed). */
    everConnected: id => state.host(id)?.connectedAt !== undefined,
    hostKnown: id => state.host(id) !== undefined,
    hostState: (id, patch) => state.hostState(id, patch),

    /** Send a request to a host's collector; rejects with code "offline" when it has no channel. */
    request(id, method, params, options) {
      const entry = channels.get(id);
      if (entry === undefined) return Promise.reject(Object.assign(new Error(`host ${id} has no collector connection`), { code: "offline" }));
      return entry.channel.request(method, params, options);
    },

    closeAll(reason = "hub stopped") {
      stopped = true;
      for (const conn of [...open]) conn.onClose(reason);
      for (const { channel } of [...channels.values()]) channel.close(reason);
      channels.clear();
    },
    get tokenRequired() { return token !== null; },
  };
}

/**
 * Accept collector channels on a loopback TCP port, one channel per connection.
 * @returns {Promise<{server: import("node:net").Server, port: number, close(): Promise<void>}>}
 */
export function startIngestServer({ host = "127.0.0.1", port, links, log = () => {} }) {
  if (!LOOPBACK_HOSTS.has(host)) throw new Error(`ingest must listen on loopback, not ${host}: remote collectors come in through ssh -W`);
  const sockets = new Set();
  const server = createServer(socket => {
    if (!isLoopbackAddress(socket.remoteAddress)) { socket.destroy(); return; }
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 15_000);
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    links.attach({ readable: socket, writable: socket, close: () => socket.destroy() }, { via: "socket", label: `ingest :${socket.remotePort}`, checkToken: links.tokenRequired, maxLine: INGEST_MAX_LINE });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port }, () => {
      server.off("error", reject);
      server.on("error", error => log("error", `ingest server: ${error.message}`));
      resolve({
        server,
        port: server.address().port,
        close() {
          return new Promise(done => {
            server.close(() => done());
            for (const socket of sockets) socket.destroy();
          });
        },
      });
    });
  });
}

/** Placeholder host data for a dial target whose id says what it is (pods). */
function placeholderInfo(hostId, label) {
  const pod = parsePodHostId(hostId);
  if (pod === null) return undefined;
  return { id: hostId, site: pod.site, kind: "pod", label: label ?? pod.pod, pod: pod.pod, cluster: KUBE_CONTEXTS[pod.site], namespace: NAMESPACE };
}

/**
 * Spawn `command args…` and speak the collector protocol over its stdio; reconnect with backoff when it exits.
 * While no channel exists the host (when `hostId` is given) shows as connecting / offline with the command's stderr.
 * @returns {{stop(): void, readonly channel: object | null}}
 */
export function dialCollector({ links, command, args = [], label = command, hostId, info, via, env, minDelayMs = 1000, maxDelayMs = 30_000, log = () => {} }) {
  const mode = via ?? "ssh-relay";
  const placeholder = info ?? (hostId === undefined ? undefined : placeholderInfo(hostId, label));
  let conn = null, current = null, spawnError = null;
  const link = keepConnected({
    label, minDelayMs, maxDelayMs,
    connect() {
      const transport = spawnTransport(command, args, { env, label });   // its close() only signals a child that really started
      spawnError = null;
      transport.child.once("error", error => {          // ENOENT and friends: the streams never report it
        spawnError = error;
        current?.close(`cannot run ${command}: ${error.message}`);
      });
      conn = links.newConnection({ via: mode, label, expectHostId: hostId });
      return { ...transport, onMessage: conn.onMessage };
    },
    channelOptions: { onClose: reason => conn?.onClose(reason) },
    onChannel(channel) {
      current = channel;
      conn.bind(channel);
      if (spawnError !== null) channel.close(`cannot run ${command}: ${spawnError.message}`);
    },
    onState(state, detail) {
      if (hostId === undefined) return;
      // Only the first attempt shows "connecting"; a retry keeps the last state (and its error text) until it is online again.
      if (state === "connecting") { if (!links.hostKnown(hostId)) links.hostState(hostId, { status: "connecting", info: placeholder, via: mode }); }
      else if (state === "offline") links.hostState(hostId, { status: links.everConnected(hostId) ? "offline" : "error", error: detail, info: placeholder, via: mode });
    },
  });
  log("info", `dialing collector ${label}`);
  return { stop() { link.stop(); }, get channel() { return link.channel; } };
}
