// Discovery: finds transcript files under the session roots and reports additions and removals.
//
// * A scan walks the directory tree of every root (globs re-expanded each time, depth capped per kind). A directory is
//   only listed again when its mtime changed; quiet directories are re-checked less often (every scan while recently
//   modified, 3 s after 10 min, 10 s after 2 h) and shallow "structure" directories (project / date folders) on every
//   scan, so a big, mostly idle tree costs a few stats per second.
// * `fs.watch` is a fast path only (recursive on macOS, one watcher per directory elsewhere): an event re-checks one
//   path at once. Polling stays on, so a platform where watching does nothing (NFS) still works.
// * Files older than `since` are not tracked when first seen. They stay on a slow stat lane and are admitted when they
//   are written again (or when a live process names them: `adopt`).
import { watch as fsWatch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { READERS, matchSession } from "./readers/index.mjs";
import { createRootResolver } from "./roots.mjs";
import { isMissing, mapLimit } from "./util.mjs";

/** Depth of a transcript file below its root (a file directly in the root has depth 1). */
export const MAX_FILE_DEPTH = Object.freeze({ claude: 4, codex: 4, omp: 6, dsh: 3 });
/** Directories this deep (root = 0) or shallower are checked on every scan whatever their age. */
const STRUCTURE_DEPTH = Object.freeze({ claude: 1, codex: 3, omp: 1, dsh: 1 });

const FRESH_DIR_MS = 2500;       // a directory modified this recently is re-listed even if its mtime looks unchanged
const HOT_DIR_MS = 10 * 60_000;
const WARM_DIR_MS = 2 * 3_600_000;
const COLD_FILE_MS = 10_000;     // untracked (old) transcripts: re-stat period
const ANCIENT_FILE_MS = 60_000;  // …when they have not changed for a week
const WEEK_MS = 7 * 86_400_000;
const WATCH_LIMIT = 2048;
const PATH_BATCH = 400;
const MIN_SCAN_GAP_MS = 150;     // a watch event may ask for a scan; scans never start back to back faster than this
const isTranscriptName = name => name.endsWith(".jsonl") || name.endsWith(".jsonl.zstd");

/**
 * @param {object} options
 * @param {import("./roots.mjs").RootSpec[]} options.specs
 * @param {number} options.since   ms; older files are not tracked when first seen
 * @param {(file: {path: string, match: object, root: import("./roots.mjs").ResolvedRoot, stat: object}) => void} options.onAdd
 * @param {(path: string) => void} [options.onRemove]  a tracked transcript is gone
 * @param {(path: string) => void} [options.onTouch]   a watch event named a tracked transcript
 */
export function createDiscovery({ specs, since, onAdd, onRemove = () => {}, onTouch = () => {}, now = Date.now, scanMs = 1000, platform = process.platform, watch = true, concurrency = 16, log = () => {} }) {
  const resolver = createRootResolver({ now });
  const dirs = new Map();      // path → {path, root, depth, mtimeMs, files, subdirs, nextCheckAt, fastUntil, scanned}
  const known = new Map();     // tracked transcript path → root
  const seen = new Map();      // untracked (too old) transcript path → {root, nextAt}
  const admitting = new Set(); // paths being admitted right now
  const pathQueue = new Map(); // path → "rename" (created / removed / renamed) | "change" (modified)
  const stats = { scans: 0, lastScanMs: 0, lastScanAt: 0, dirsChecked: 0, listings: 0, admitted: 0, removed: 0, watchEvents: 0 };
  let roots = [], stopped = false, wake = null, timer = null, pathTimer = null, scanSeq = 0, started = false, lastScanEnd = 0;
  let resolveInitial;
  const initial = new Promise(resolve => { resolveInitial = resolve; });

  // ------------------------------------------------------------------------------------------------- watchers
  const recursive = platform === "darwin" || platform === "win32";
  const watchers = new Map();
  const closeWatcher = path => { try { watchers.get(path)?.close(); } catch { /* already closed */ } watchers.delete(path); };

  function addWatcher(path) {
    if (!watch || stopped || watchers.has(path) || watchers.size >= WATCH_LIMIT) return;
    try {
      const watcher = fsWatch(path, { persistent: false, recursive }, (event, name) => onPath(name ? join(path, String(name)) : path, event));
      watcher.on("error", () => closeWatcher(path));
      watchers.set(path, watcher);
    } catch { /* ENOSPC / EMFILE / ENOENT: polling still covers this directory */ }
  }

  function onPath(path, event) {
    if (stopped) return;
    stats.watchEvents += 1;
    if (event === "rename" || !pathQueue.has(path)) pathQueue.set(path, event);
    pathTimer ??= setTimeout(drainPaths, 30);
  }

  async function drainPaths() {
    pathTimer = null;
    const batch = [...pathQueue].slice(0, PATH_BATCH);
    const overflow = pathQueue.size > PATH_BATCH;
    pathQueue.clear();
    let rescan = overflow;
    for (const [path, event] of batch) {
      if (stopped) return;
      if (known.has(path)) { onTouch(path); continue; }
      if (event === "rename") {
        const parent = dirs.get(dirname(path));
        if (parent) { parent.nextCheckAt = 0; rescan = true; }
      }
      if (isTranscriptName(path)) { const root = rootFor(path); if (root) await admit(path, root, false); }
    }
    if (rescan) requestScan();
  }

  // ----------------------------------------------------------------------------------------------- directories
  const rootKey = root => `${root.kind}\0${root.real}`;

  function addDir(path, root, depth) {
    if (dirs.has(path)) return;
    dirs.set(path, { path, root, depth, mtimeMs: -1, files: new Set(), subdirs: new Set(), nextCheckAt: 0, fastUntil: 0, scanned: -1 });
    if (!recursive || depth === 0) addWatcher(path);
  }

  function removeTree(path) {
    const prefix = `${path}/`;
    for (const key of [...dirs.keys()]) if (key === path || key.startsWith(prefix)) { dirs.delete(key); closeWatcher(key); }
    for (const file of [...known.keys()]) if (file.startsWith(prefix)) dropFile(file);
    for (const file of [...seen.keys()]) if (file.startsWith(prefix)) seen.delete(file);
  }

  function dropFile(path) {
    seen.delete(path);
    if (!known.delete(path)) return;
    stats.removed += 1;
    onRemove(path);
  }

  async function syncRoots() {
    const next = await resolver.resolve(specs);
    const keep = new Set(next.map(rootKey));
    for (const old of roots) if (!keep.has(rootKey(old))) removeTree(old.dir);
    for (const root of next) addDir(root.dir, root, 0);
    roots = next;
  }

  const rootFor = path => {
    let best = null;
    for (const root of roots) if (path.startsWith(`${root.dir}/`) && (best === null || root.dir.length > best.dir.length)) best = root;
    return best;
  };

  /** Track `path` when it is a transcript of `root`'s kind that is recent enough (or `force`). */
  async function admit(path, root, force) {
    if (known.has(path) || admitting.has(path)) return known.has(path);
    const match = (root.kind && READERS[root.kind]?.match(path)) || null;
    if (!match) return false;
    admitting.add(path);
    try {
      let info;
      try { info = await stat(path); } catch { seen.delete(path); return false; }
      if (!info.isFile()) return false;
      const age = now() - info.mtimeMs;
      if (!force && age > since) {
        seen.set(path, { root, nextAt: now() + (age > WEEK_MS ? ANCIENT_FILE_MS : COLD_FILE_MS) });
        return false;
      }
      if (stopped || known.has(path)) return known.has(path);
      seen.delete(path);
      known.set(path, root);
      stats.admitted += 1;
      onAdd({ path, match, root, stat: { mtimeMs: info.mtimeMs, size: info.size, ino: info.ino, dev: info.dev } });
      return true;
    } finally { admitting.delete(path); }
  }

  async function checkDir(dir) {
    dir.scanned = scanSeq;
    stats.dirsChecked += 1;
    let info;
    try { info = await stat(dir.path); } catch (error) {
      if (isMissing(error)) removeTree(dir.path);
      else dir.nextCheckAt = now() + 5000;
      return;
    }
    const t = now(), age = t - info.mtimeMs;
    const fast = dir.depth <= (STRUCTURE_DEPTH[dir.root.kind] ?? 1) || t < dir.fastUntil || age < HOT_DIR_MS;
    dir.nextCheckAt = t + (fast ? scanMs : age < WARM_DIR_MS ? 3 * scanMs : 10 * scanMs);
    // On network file systems the cached directory mtime can be seconds old: structure directories and directories
    // that are still empty (a session being created) are listed on every scan instead.
    const forced = dir.root.network === true && (dir.depth <= (STRUCTURE_DEPTH[dir.root.kind] ?? 1) || (dir.files.size === 0 && dir.subdirs.size === 0 && age < HOT_DIR_MS));
    if (!forced && info.mtimeMs === dir.mtimeMs && age >= FRESH_DIR_MS) return;
    dir.mtimeMs = info.mtimeMs;
    let entries;
    try { entries = await readdir(dir.path, { withFileTypes: true }); } catch (error) {
      if (isMissing(error)) removeTree(dir.path); else dir.nextCheckAt = t + 5000;
      return;
    }
    stats.listings += 1;
    const maxDepth = MAX_FILE_DEPTH[dir.root.kind] ?? 3;
    const files = new Set(), subdirs = new Set(), candidates = [];
    for (const entry of entries) {
      let isDir = entry.isDirectory(), isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try { const target = await stat(join(dir.path, entry.name)); isDir = target.isDirectory(); isFile = target.isFile(); } catch { continue; }
      }
      if (isDir) { if (!entry.name.startsWith(".") && dir.depth + 1 <= maxDepth - 1) subdirs.add(entry.name); }
      else if (isFile && dir.depth + 1 <= maxDepth && isTranscriptName(entry.name) && !entry.name.startsWith(".")) {
        files.add(entry.name);
        if (!dir.files.has(entry.name)) candidates.push(join(dir.path, entry.name));
      }
    }
    for (const name of dir.files) if (!files.has(name)) dropFile(join(dir.path, name));
    for (const name of dir.subdirs) if (!subdirs.has(name)) removeTree(join(dir.path, name));
    for (const name of subdirs) if (!dir.subdirs.has(name)) addDir(join(dir.path, name), dir.root, dir.depth + 1);
    dir.files = files;
    dir.subdirs = subdirs;
    if (candidates.length > 0) await mapLimit(candidates, 8, path => admit(path, dir.root, false));
  }

  async function recheckOld() {
    const t = now(), due = [];
    for (const [path, entry] of seen) if (entry.nextAt <= t) due.push([path, entry.root]);
    if (due.length > 0) await mapLimit(due, concurrency, ([path, root]) => admit(path, root, false));
  }

  async function scanOnce() {
    const began = now();
    scanSeq += 1;
    await syncRoots();
    for (;;) { // waves: directories discovered by one wave are checked by the next, in the same scan
      const t = now();
      const due = [];
      for (const dir of dirs.values()) if (dir.scanned !== scanSeq && dir.nextCheckAt <= t) due.push(dir);
      if (due.length === 0) break;
      await mapLimit(due, concurrency, checkDir);
      if (stopped) return;
    }
    await recheckOld();
    stats.scans += 1;
    stats.lastScanAt = now();
    stats.lastScanMs = stats.lastScanAt - began;
  }

  async function loop() {
    while (!stopped) {
      try { await scanOnce(); } catch (error) { log(`discovery scan failed: ${error?.message ?? error}`); }
      lastScanEnd = now();
      resolveInitial();
      if (stopped) break;
      await new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, scanMs); });
      clearTimeout(timer);
      wake = null;
      const gap = MIN_SCAN_GAP_MS - (now() - lastScanEnd);
      if (gap > 0 && !stopped) await new Promise(resolve => setTimeout(resolve, gap));
    }
  }

  const requestScan = () => wake?.();

  return {
    /** Resolves when the first scan finished. */
    initial,
    start() { if (!started) { started = true; loop(); } },
    stop() {
      stopped = true;
      clearTimeout(timer); clearTimeout(pathTimer);
      for (const path of [...watchers.keys()]) closeWatcher(path);
      wake?.();
      resolveInitial();
    },
    /** Scan as soon as possible. */
    scanNow: requestScan,
    /** Track a transcript regardless of its age (a live process holds it). Resolves true when it is tracked. */
    async adopt(path) {
      const match = matchSession(path);
      if (!match) return false;
      const root = rootFor(path) ?? { kind: match.kind, dir: dirname(path), real: dirname(path), spec: "(adopted)" };
      return admit(path, root, true);
    },
    /** A transcript is active: keep its directory and its artifact directory (`<name>/`) under close watch. */
    expedite(path) {
      const until = now() + HOT_DIR_MS;
      for (const candidate of [dirname(path), path.replace(/\.jsonl(?:\.zstd)?$/, "")]) {
        const dir = dirs.get(candidate);
        if (dir) { dir.fastUntil = until; if (dir.nextCheckAt > now() + scanMs) dir.nextCheckAt = 0; }
      }
    },
    /** The tracker found `path` gone: forget it so a recreated file is admitted again. */
    forget(path) {
      known.delete(path); seen.delete(path);
      const dir = dirs.get(dirname(path));
      if (dir) { dir.files.delete(basename(path)); dir.nextCheckAt = 0; dir.mtimeMs = -1; }
    },
    /** Look for a Claude transcript by session id in the known project directories. */
    async findById(kind, id) {
      if (kind !== "claude") return null;
      for (const dir of dirs.values()) {
        if (dir.root.kind !== "claude" || dir.depth !== 1) continue;
        const path = join(dir.path, `${id}.jsonl`);
        try { if ((await stat(path)).isFile()) return path; } catch { /* not in this project */ }
      }
      return null;
    },
    isTracked: path => known.has(path),
    roots: () => roots,
    stats: () => ({ ...stats, dirs: dirs.size, tracked: known.size, old: seen.size, watchers: watchers.size, roots: roots.length }),
  };
}
