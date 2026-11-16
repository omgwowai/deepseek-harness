// Worker thread for tool-stats.js: one scanSessions() run off the 3080 event loop (a cold build over 30 days of session
// logs, ~2000 logs / ~900 MB compressed, takes ~12–20 s by machine load; with the per-log cache ~1 s). workerData = {root, cacheFile, windowDays}; posts {table, stats}; a throw ends the worker
// with an error event.
import { parentPort, workerData } from "node:worker_threads";
import { scanSessions } from "./tool-stats.js";

const { table, stats } = scanSessions(workerData);
parentPort.postMessage({ table, stats });
