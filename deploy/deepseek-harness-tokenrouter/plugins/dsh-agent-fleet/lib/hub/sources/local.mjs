// The hub's own machine: run a collector inside this process and connect it to the hub over an in-memory channel
// pair, so it takes exactly the path of a remote collector (JSON round trip included, which also means the collector
// may reuse the objects it sent). A link the hub closed (silence watchdog, stream error, a superseding channel) is
// re-opened with a fresh pair and the collector re-syncs over it, so this host never stays offline until a restart.
import { PassThrough } from "node:stream";
import { createChannel } from "../../channel.mjs";

/** Collector options for the hub's own machine: the host's id is the hub's, its site defaults to the id. */
export function localCollectorOptions(hostId, options = {}) {
  return { ...options, hostInfo: { site: hostId, ...options.hostInfo, id: hostId } };
}

const MIN_RETRY_MS = 100;
const MAX_RETRY_MS = 5_000;
const HEALTHY_MS = 30_000;      // a link that lived this long resets the backoff of the next reconnect

/**
 * @param {object} options
 * @param {string} options.hostId
 * @param {object} [options.collectorOptions]  forwarded to startCollector (hostInfo, roots, since, intervals, …)
 * @param {{attach(transport: object, options: object): object}} options.links
 * @param {() => number} [options.now]
 * @param {() => Promise<{startCollector: Function}>} [options.load]  collector module loader (tests inject a fake)
 * @param {(level: string, message: string) => void} [options.log]
 * @param {number} [options.minRetryMs]  first reconnect delay after the link closed
 * @param {number} [options.maxRetryMs]  cap of the exponential reconnect delay
 */
export async function startLocalCollector({
  hostId, collectorOptions, links, now = Date.now, load = () => import("../../collector/index.mjs"),
  log = () => {}, minRetryMs = MIN_RETRY_MS, maxRetryMs = MAX_RETRY_MS,
}) {
  const { startCollector } = await load();
  let collector = null, stopping = false, retryTimer = null, retryDelay = minRetryMs, current = null;

  /**
   * One in-memory pair with the hub side attached. Whichever side closes first reports through `onGone` once, closes
   * the other side and destroys the streams, so no handle outlives a dead link.
   * @returns {{toHub: PassThrough, toCollector: PassThrough, hubSide: object, collectorSide: object, openedAt: number}}
   */
  function openPair(onGone) {
    const opened = { toHub: new PassThrough(), toCollector: new PassThrough(), hubSide: null, collectorSide: null, openedAt: now(), gone: false };
    const destroy = () => { opened.toHub.destroy(); opened.toCollector.destroy(); };
    const gone = reason => {
      if (opened.gone) return;
      opened.gone = true;
      try { opened.hubSide?.close(reason); } catch { /* already closed */ }
      try { opened.collectorSide?.close(reason); } catch { /* already closed */ }
      destroy();
      onGone(reason);
    };
    opened.hubSide = links.attach({ readable: opened.toHub, writable: opened.toCollector, close: () => gone("hub side closed") }, { via: "local", label: "local collector" });
    if (opened.gone) return opened;              // the hub refused the channel synchronously (stopping): no collector side
    opened.collectorSide = createChannel({
      readable: opened.toCollector, writable: opened.toHub, label: "local collector (collector side)",
      onRequest: (method, params) => {
        if (collector === null) throw new Error("local collector is not running");
        return collector.handleRequest(method, params);
      },
      close: () => gone("collector side closed"),
    });
    return opened;
  }

  /** A close that is not ours: wait a little (backoff), then attach a fresh pair and let the collector re-say hello. */
  function scheduleReconnect(reason) {
    if (stopping || collector === null) return;          // stop() and the failed-start path own the channels now
    const openedAt = current?.openedAt;
    current = null;
    if (openedAt !== undefined && now() - openedAt >= HEALTHY_MS) retryDelay = minRetryMs;
    const wait = retryDelay;
    retryDelay = Math.min(maxRetryMs, retryDelay * 2);
    log("warn", `local collector link closed (${reason}); reconnecting in ${wait} ms`);
    retryTimer = setTimeout(() => { retryTimer = null; reconnect(); }, wait);
    retryTimer.unref?.();
  }

  function reconnect() {
    if (stopping || collector === null) return;
    const opened = current = openPair(scheduleReconnect);
    if (opened.collectorSide === null) return;            // the hub refused it synchronously; scheduleReconnect covers it
    try {
      collector.resync(opened.collectorSide.send);       // hello again + every record, its recent events and the procs
      log("info", "local collector re-attached to the hub");
    } catch (error) {
      log("error", `local collector resync failed: ${error.message}`);
      opened.collectorSide.close(`resync failed: ${error.message}`);
    }
  }

  current = openPair(scheduleReconnect);
  const initial = current;
  try {
    collector = await startCollector({ ...localCollectorOptions(hostId, collectorOptions), send: initial.collectorSide.send, now });
  } catch (error) {
    stopping = true;
    clearTimeout(retryTimer); retryTimer = null;
    initial.hubSide.close("local collector failed to start");
    initial.collectorSide.close("local collector failed to start");
    throw error;
  }
  return {
    collector,
    async stop() {
      stopping = true;
      clearTimeout(retryTimer); retryTimer = null;
      const stoppedCollector = collector;
      collector = null;
      const opened = current; current = null;
      try { await stoppedCollector?.stop(); }
      finally {
        opened?.hubSide.close("hub stopped");
        opened?.collectorSide.close("hub stopped");
      }
    },
  };
}
