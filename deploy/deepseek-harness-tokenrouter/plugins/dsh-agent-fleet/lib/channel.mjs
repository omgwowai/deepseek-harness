// NDJSON duplex channel with request/reply, shared by collectors, hubs and the DSH plugin.
// Transports: a TCP socket, a child process's stdio (ssh -W, kubectl exec -i, ssh <cmd>), or this process's stdio.
// One JSON object per line. Requests: {t:"request", id, method, params}; replies: {t:"reply", id, ok, value|error}.
import { spawn } from "node:child_process";
import { connect as netConnect } from "node:net";
import { LIMITS, checkMessage } from "./protocol.mjs";

const MAX_QUEUED_BYTES = 64 * 1024 * 1024;

export class ChannelError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * @param {object} options
 * @param {import("node:stream").Readable} options.readable
 * @param {import("node:stream").Writable} options.writable
 * @param {(message: object) => void} [options.onMessage]  every message that is not a request/reply
 * @param {(method: string, params: any, message: object) => any} [options.onRequest]  value or promise; throw to fail
 * @param {(reason: string) => void} [options.onClose]
 * @param {() => void} [options.close]  transport teardown (kill child, destroy socket)
 * @param {string} [options.label]
 * @param {number} [options.maxLine]
 */
export function createChannel({ readable, writable, onMessage, onRequest, onClose, close: closeTransport, label = "channel", maxLine = LIMITS.lineBytes }) {
  let closed = false, closeReason = "", nextId = 1, carry = "", queuedBytes = 0, draining = false;
  const queue = [];
  const pending = new Map();

  const finish = reason => {
    if (closed) return;
    closed = true; closeReason = reason;
    for (const [, entry] of pending) { clearTimeout(entry.timer); entry.reject(new ChannelError("closed", `${label}: channel closed (${reason})`)); }
    pending.clear();
    queue.length = 0;
    try { closeTransport?.(); } catch { /* transport already gone */ }
    try { onClose?.(reason); } catch { /* listener errors must not mask the close */ }
  };

  const flush = () => {
    while (queue.length > 0 && !closed) {
      const chunk = queue.shift();
      queuedBytes -= chunk.length;
      if (!writable.write(chunk)) { draining = true; writable.once("drain", () => { draining = false; flush(); }); return; }
    }
  };

  const send = message => {
    if (closed) return false;
    let line;
    try { line = JSON.stringify(message) + "\n"; } catch (error) { throw new ChannelError("encode", `${label}: cannot encode message: ${error.message}`); }
    if (draining || queue.length > 0) {
      queuedBytes += line.length;
      if (queuedBytes > MAX_QUEUED_BYTES) { finish("peer too slow: send queue over 64 MiB"); return false; }
      queue.push(line);
      return true;
    }
    if (!writable.write(line)) { draining = true; writable.once("drain", () => { draining = false; flush(); }); }
    return true;
  };

  const reply = (id, ok, payload) => send(ok ? { t: "reply", id, ok: true, value: payload } : { t: "reply", id, ok: false, error: payload });

  const handleLine = line => {
    if (line.length === 0) return;
    let message;
    try { message = JSON.parse(line); } catch { finish("peer sent invalid JSON"); return; }
    const problem = checkMessage(message);
    if (problem !== null) { finish(`peer sent a malformed message: ${problem}`); return; }
    if (message.t === "reply") {
      const entry = pending.get(message.id);
      if (entry === undefined) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message.value);
      else entry.reject(new ChannelError(message.error?.code ?? "remote", message.error?.message ?? "remote error"));
      return;
    }
    if (message.t === "request") {
      if (typeof onRequest !== "function") { reply(message.id, false, { code: "unsupported", message: `${label}: requests not accepted` }); return; }
      Promise.resolve().then(() => onRequest(message.method, message.params, message)).then(
        value => reply(message.id, true, value ?? null),
        error => reply(message.id, false, { code: error?.code ?? "failed", message: String(error?.message ?? error) }));
      return;
    }
    try { onMessage?.(message); } catch (error) { finish(`message handler failed: ${error.message}`); }
  };

  readable.setEncoding?.("utf8");
  readable.on("data", chunk => {
    if (closed) return;
    const text = carry + chunk;
    let start = 0;
    for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", start)) {
      handleLine(text.slice(start, index));
      if (closed) return;
      start = index + 1;
    }
    carry = text.slice(start);
    if (carry.length > maxLine) finish(`peer line over ${maxLine} bytes`);
  });
  readable.on("end", () => finish("peer closed the stream"));
  readable.on("error", error => finish(`read error: ${error.message}`));
  writable.on("error", error => finish(`write error: ${error.message}`));

  return {
    label,
    send,
    /** Send a request and wait for its reply. */
    request(method, params, { timeoutMs = 30_000, signal } = {}) {
      if (closed) return Promise.reject(new ChannelError("closed", `${label}: channel closed (${closeReason})`));
      const id = `r${nextId++}`;
      return new Promise((resolve, reject) => {
        const entry = { resolve, reject, timer: null };
        entry.timer = setTimeout(() => { pending.delete(id); reject(new ChannelError("timeout", `${label}: ${method} timed out after ${timeoutMs} ms`)); }, timeoutMs);
        entry.timer.unref?.();
        if (signal) {
          if (signal.aborted) { clearTimeout(entry.timer); reject(new ChannelError("aborted", `${label}: ${method} aborted`)); return; }
          signal.addEventListener("abort", () => { if (pending.delete(id)) { clearTimeout(entry.timer); reject(new ChannelError("aborted", `${label}: ${method} aborted`)); } }, { once: true });
        }
        pending.set(id, entry);
        if (!send({ t: "request", id, method, params: params ?? null })) { pending.delete(id); clearTimeout(entry.timer); reject(new ChannelError("closed", `${label}: channel closed`)); }
      });
    },
    close(reason = "closed locally") { finish(reason); },
    get closed() { return closed; },
    get closeReason() { return closeReason; },
    get pendingRequests() { return pending.size; },
  };
}

/** This process's stdin/stdout as a transport (collectors launched by ssh/kubectl exec). */
export function stdioTransport() {
  return { readable: process.stdin, writable: process.stdout, close: () => { process.stdout.end(); } };
}

/** A TCP connection as a transport. Resolves once connected. */
export function tcpTransport({ host = "127.0.0.1", port, timeoutMs = 10_000 }) {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port });
    const timer = setTimeout(() => { socket.destroy(); reject(new ChannelError("timeout", `connect ${host}:${port} timed out`)); }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 15_000);
      resolve({ readable: socket, writable: socket, close: () => socket.destroy(), socket });
    });
    socket.once("error", error => { clearTimeout(timer); reject(new ChannelError("connect", `connect ${host}:${port}: ${error.message}`)); });
  });
}

/**
 * Signal a child that is still running. A child whose command could not start (ENOENT, EACCES) has no pid until Node
 * reports the error on a later tick, and `child.kill()` in that window signals pid 0: the caller's whole process group.
 */
export function signalChild(child, signal = "SIGTERM") {
  if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill(signal);
}

/**
 * A child process's stdio as a transport: ssh, kubectl exec -i, or any relay command.
 * stderr is kept (last 4 KiB) so failures can be reported verbatim.
 */
export function spawnTransport(command, args, { env, cwd, label = command } = {}) {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: env ?? process.env, cwd });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4096); });
  child.stdin.on("error", () => { /* surfaced through the channel's read side */ });
  return {
    readable: child.stdout,
    writable: child.stdin,
    child,
    label,
    stderr: () => stderr.trim(),
    close: () => signalChild(child),
  };
}

/** `ssh -W 127.0.0.1:<port> <target>`: a TCP port on the remote host, carried over SSH stdio. */
export function sshForwardTransport({ target, port, host = "127.0.0.1", sshArgs = [] }) {
  return spawnTransport("ssh", [
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
    "-o", "ExitOnForwardFailure=yes", ...sshArgs, "-W", `${host}:${port}`, target,
  ], { label: `ssh ${target} → ${host}:${port}` });
}

/**
 * Keep a channel connected: `connect()` returns a transport (or a promise of one); after a close it is retried
 * with exponential backoff. `onChannel(channel)` receives every new channel; `onState(state, detail)` reports
 * "connecting" | "online" | "offline".
 */
export function keepConnected({ connect, channelOptions, onChannel, onState, minDelayMs = 1000, maxDelayMs = 30_000, label = "link" }) {
  let stopped = false, delay = minDelayMs, timer = null, current = null;
  const attempt = async () => {
    if (stopped) return;
    onState?.("connecting", "");
    let transport;
    try { transport = await connect(); }
    catch (error) { schedule(error.message); return; }
    if (stopped) { transport.close?.(); return; }
    const opened = Date.now();
    current = createChannel({
      ...channelOptions, ...transport, label,
      onClose: reason => {
        current = null;
        channelOptions?.onClose?.(reason);
        const detail = transport.stderr?.() ? `${reason}: ${transport.stderr()}` : reason;
        if (Date.now() - opened > 60_000) delay = minDelayMs;
        schedule(detail);
      },
    });
    onState?.("online", "");
    try { onChannel?.(current); } catch (error) { current?.close(`onChannel failed: ${error.message}`); }
  };
  const schedule = detail => {
    if (stopped) return;
    onState?.("offline", detail);
    timer = setTimeout(attempt, delay);
    timer.unref?.();
    delay = Math.min(maxDelayMs, delay * 2);
  };
  attempt();
  return {
    get channel() { return current; },
    stop() { stopped = true; clearTimeout(timer); current?.close("stopped"); },
  };
}
