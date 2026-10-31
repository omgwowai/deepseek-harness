// Session roots: the default directories per agent kind, `--root kind=path` / AGENT_FLEET_ROOTS parsing,
// `*` / `?` globs per path segment (re-expanded on every scan: new run directories appear over time),
// realpath de-duplication and the container label (the run a session directory belongs to).
import { readdir, realpath, stat, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_KINDS } from "../protocol.mjs";

/** @typedef {{kind: string, path: string}} RootSpec  `path` may contain `*` / `?` segments */
/** @typedef {{kind: string, dir: string, real: string, spec: string, container?: string}} ResolvedRoot */

const GLOB_CHARS = /[*?]/;
const GLOB_TTL_MS = 3000;
// <runs>/<RUN>/work/harness-home/sessions: DSH home of a container run (the run is the label).
const HARNESS_HOME = /\/([^/]+)\/work\/harness-home\/sessions(?:\/|$)/;
const NETWORK_FS = new Set([0x6969, 0x517b, 0xff534d42, 0xfe534d42]); // statfs f_type: NFS, SMB, CIFS, SMB2

export function expandHome(path, home = homedir()) {
  if (path === "~") return home;
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

export const hasGlob = path => GLOB_CHARS.test(path);

/** The roots every collector watches (missing directories are simply skipped until they appear). */
export function defaultRoots(home = homedir()) {
  return [
    { kind: "claude", path: join(home, ".claude", "projects") },
    { kind: "codex", path: join(home, ".codex", "sessions") },
    { kind: "codex", path: join(home, ".codex", "archived_sessions") },
    { kind: "omp", path: join(home, ".omp", "agent", "sessions") },
    { kind: "omp", path: join(home, ".paseo", "agents", "omp", "sessions") },
    { kind: "dsh", path: join(home, ".dsh", "sessions") },
  ];
}

/** "omp=/data/x/*\/work/sessions" → {kind, path}. Throws on a malformed flag. */
export function parseRootFlag(text) {
  const eq = typeof text === "string" ? text.indexOf("=") : -1;
  const kind = eq > 0 ? text.slice(0, eq).trim() : "";
  const path = eq > 0 ? text.slice(eq + 1).trim() : "";
  if (!AGENT_KINDS.includes(kind) || path === "") throw new Error(`invalid root "${text}": expected kind=path with kind one of ${AGENT_KINDS.join("|")}`);
  return { kind, path };
}

/** AGENT_FLEET_ROOTS: `kind=path:kind=path` (paths cannot contain ':'). Malformed entries are skipped. */
export function parseRootsEnv(text) {
  const specs = [];
  for (const piece of String(text ?? "").split(":")) {
    if (piece.trim() === "") continue;
    try { specs.push(parseRootFlag(piece)); } catch { /* ignore a malformed entry rather than refuse to start */ }
  }
  return specs;
}

/**
 * Merge default roots, AGENT_FLEET_ROOTS and explicit roots into one list of absolute specs without duplicates.
 * `roots` is `{kind: string|string[]}`, or an array of `kind=path` strings / `{kind, path}` objects.
 * @returns {RootSpec[]}
 */
export function normalizeRoots({ roots, env = process.env, home = homedir(), defaults = true } = {}) {
  const raw = [];
  if (defaults) raw.push(...defaultRoots(home));
  raw.push(...parseRootsEnv(env?.AGENT_FLEET_ROOTS));
  if (Array.isArray(roots)) {
    for (const item of roots) raw.push(typeof item === "string" ? parseRootFlag(item) : item);
  } else if (roots && typeof roots === "object") {
    for (const kind of AGENT_KINDS) for (const path of [].concat(roots[kind] ?? [])) raw.push({ kind, path });
  }
  const seen = new Set(), specs = [];
  for (const { kind, path } of raw) {
    if (!AGENT_KINDS.includes(kind) || typeof path !== "string" || path === "") continue;
    const abs = resolve(expandHome(path, home));
    const key = `${kind}\0${abs}`;
    if (!seen.has(key)) { seen.add(key); specs.push({ kind, path: abs }); }
  }
  return specs;
}

function segmentRegex(segment) {
  const body = segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${body}$`);
}

/**
 * Expands root specs to the directories that exist right now. Wildcard segments are listed through a cache keyed
 * by the parent's mtime, so a steady state costs one stat per wildcard parent plus one per expanded directory
 * (existence of expanded directories is re-checked at most every few seconds).
 */
export function createRootResolver({ now = Date.now } = {}) {
  const listings = new Map(); // dir → {mtimeMs, names}
  const dirChecks = new Map(); // dir → {at, ok}
  const reals = new Map(); // dir → realpath
  const networks = new Map(); // dir → true when on a network file system

  async function isDir(dir, ttl) {
    const hit = dirChecks.get(dir), t = now();
    if (ttl > 0 && hit && t - hit.at < ttl) return hit.ok;
    let ok = false;
    try { ok = (await stat(dir)).isDirectory(); } catch { /* absent */ }
    dirChecks.set(dir, { at: t, ok });
    return ok;
  }

  async function listDirs(dir) {
    let st;
    try { st = await stat(dir); } catch { listings.delete(dir); return []; }
    const cached = listings.get(dir);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.names;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
    const names = entries.filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => entry.name).sort();
    listings.set(dir, { mtimeMs: st.mtimeMs, names });
    return names;
  }

  async function expand(spec) {
    if (!hasGlob(spec.path)) return (await isDir(spec.path, 0)) ? [{ dir: spec.path, label: undefined }] : [];
    const parts = spec.path.split("/");
    let bases = [{ dir: parts[0] === "" ? "/" : parts[0], label: undefined }];
    for (const part of parts.slice(1)) {
      if (part === "") continue;
      if (!hasGlob(part)) { bases = bases.map(base => ({ ...base, dir: join(base.dir, part) })); continue; }
      const pattern = segmentRegex(part), next = [];
      for (const base of bases) {
        for (const name of await listDirs(base.dir)) {
          if (name.startsWith(".") && !part.startsWith(".")) continue;
          if (pattern.test(name)) next.push({ dir: join(base.dir, name), label: base.label ?? name });
        }
      }
      bases = next;
    }
    const alive = await Promise.all(bases.map(base => isDir(base.dir, GLOB_TTL_MS)));
    return bases.filter((_, index) => alive[index]);
  }

  async function realOf(dir) {
    let real = reals.get(dir);
    if (real === undefined) {
      try { real = await realpath(dir); } catch { return dir; }
      reals.set(dir, real);
    }
    return real;
  }

  /** NFS / SMB / CIFS: no inotify events, and `stat` may serve cached attributes. */
  async function isNetwork(dir) {
    let known = networks.get(dir);
    if (known === undefined) {
      try { known = NETWORK_FS.has((await statfs(dir)).type); } catch { known = false; }
      networks.set(dir, known);
    }
    return known;
  }

  return {
    /** @param {RootSpec[]} specs @returns {Promise<ResolvedRoot[]>} existing directories, de-duplicated by realpath */
    async resolve(specs) {
      const seen = new Set(), out = [];
      for (const spec of specs) {
        const globbed = hasGlob(spec.path);
        for (const { dir, label } of await expand(spec)) {
          const real = await realOf(dir);
          const key = `${spec.kind}\0${real}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const container = globbed ? label : HARNESS_HOME.exec(`${dir}/`)?.[1];
          const network = await isNetwork(real);
          out.push({ kind: spec.kind, dir, real, spec: spec.path, ...(container ? { container } : {}), ...(network ? { network } : {}) });
        }
      }
      return out;
    },
  };
}
