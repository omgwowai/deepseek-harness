// repo.resolve: which git work tree holds a directory, without the git binary.
//
// Discovery walks up from a directory looking for `<ancestor>/.git`. A `.git` directory counts only when it holds a
// HEAD file (a stray `objects/` directory is not a repository); a `.git` file counts as a linked worktree or a
// submodule and is followed through its `gitdir:` pointer, with `commondir` giving the shared config. The walk never
// treats `/` or the home directory itself as a root: `~/.dotfiles` with a `.git` in `$HOME` must not make every path
// under the home directory a repository checkout.
//
// Everything is read-only and bounded: ≤ 64 ancestors per directory, ≤ 200 dirs and 200 roots per request, HEAD
// ≤ 1 KiB, config ≤ 64 KiB. The remote URL is reduced to `host/path` (no scheme, user, password/token or `.git`
// suffix) and then runs through `redactText`, so a credential pasted into `.git/config` never leaves the machine.
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { LIMITS } from "../protocol.mjs";
import { redactText } from "../redact.mjs";

/** Bounds of one repo.resolve request and of the reads behind it. */
export const REPO_LIMITS = Object.freeze({
  dirs: 200,
  roots: 200,
  walk: 64,
  headBytes: 1024,
  pointerBytes: 4096,
  commondirBytes: 4096,
  configBytes: 64 * 1024,
});

const REF_PREFIX = "refs/heads/";
const HEX = /^[0-9a-f]{7,40}$/i;
const SCHEME_URL = /^[a-z][a-z0-9+.-]*:\/\//i;
const GITDIR_POINTER = /^\s*gitdir:\s*(.+?)\s*$/m;

const firstLine = text => String(text ?? "").split(/\r?\n/, 1)[0].trim();

/**
 * Read at most `maxBytes` of a regular file; null when it is missing, not a regular file or unreadable.
 * @param {string} path
 * @param {number} maxBytes
 * @returns {Promise<string|null>}
 */
async function readCapped(path, maxBytes) {
  let handle;
  try { handle = await open(path, "r"); } catch { return null; }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    const size = Math.min(Math.max(0, maxBytes), info.size);
    if (size === 0) return "";
    const buffer = Buffer.allocUnsafe(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** `stat` that answers null instead of throwing (missing `.git`, a broken symlink, a permission error). */
async function statSafe(path) {
  try { return await stat(path); } catch { return null; }
}

/**
 * The repository marker at `ancestor`, or null. A directory `.git` must hold HEAD; a file `.git` must carry a
 * `gitdir:` pointer whose target holds HEAD. HEAD is read here because it is the cheap proof that the marker is a
 * real work tree, and its first line is what `repoDetails` needs anyway.
 * @param {string} ancestor
 * @returns {Promise<{root:string, gitdir:string, head:string, worktree:boolean}|null>}
 */
async function inspectMarker(ancestor) {
  const dotGit = join(ancestor, ".git");
  const info = await statSafe(dotGit);
  if (info === null) return null;
  let gitdir, worktree = false;
  if (info.isDirectory()) {
    gitdir = dotGit;
  } else if (info.isFile()) {
    const pointer = await readCapped(dotGit, REPO_LIMITS.pointerBytes);
    const match = pointer === null ? null : GITDIR_POINTER.exec(pointer);
    if (match === null) return null;
    gitdir = resolvePath(ancestor, match[1]);                       // git writes the pointer relative to the work tree
    worktree = true;
  } else {
    return null;
  }
  const head = await readCapped(join(gitdir, "HEAD"), REPO_LIMITS.headBytes);
  if (head === null) return null;
  return { root: ancestor, gitdir, head, worktree };
}

/** `refs/heads/x` → `x`; a detached commit → its first 12 hex chars. */
function headFields(headText) {
  const line = firstLine(headText);
  if (line.startsWith("ref:")) {
    const name = line.slice(4).trim();
    return name.startsWith(REF_PREFIX) && name.length > REF_PREFIX.length ? { branch: name.slice(REF_PREFIX.length) } : {};
  }
  return HEX.test(line) ? { head: line.slice(0, 12).toLowerCase() } : {};
}

/**
 * The `url` of the `origin` section, else of the first `[remote "…"]` section, of a git config. Values of later
 * duplicate `url` keys are ignored (git uses the first one for a push/pull pair's primary URL).
 * @param {string} text
 * @returns {string|null}
 */
export function parseConfigRemote(text) {
  let section = null;
  const urls = new Map();
  const order = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header !== null) {
      const remote = /^remote\s+"([^"]*)"$/i.exec(header[1].trim());
      section = remote === null ? null : remote[1];
      if (section !== null && !urls.has(section)) { urls.set(section, null); order.push(section); }
      continue;
    }
    if (section === null) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    if (line.slice(0, eq).trim().toLowerCase() !== "url" || urls.get(section) !== null) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    urls.set(section, value === "" ? null : value);
  }
  if (urls.get("origin")) return urls.get("origin");
  for (const name of order) if (urls.get(name)) return urls.get(name);
  return null;
}

/**
 * A git remote URL as `host/path`: no scheme, no user or token, no port, no `.git` suffix.
 * `git@github.com:o/r.git` and `https://u:token@github.com/o/r.git` both become `github.com/o/r`. A remote without a
 * host (`file:///srv/git/x.git`, a plain local path) has no `host/path` form and yields null. The result is passed
 * through `redactText` as a second guard against a credential that survived the userinfo strip.
 * @param {unknown} raw
 * @returns {string|null}
 */
export function sanitizeRemoteUrl(raw) {
  if (typeof raw !== "string") return null;
  let text = raw.trim();
  if (text === "") return null;
  text = text.split(/\s+/)[0];                                   // a config value cannot carry unencoded whitespace
  text = text.replace(/\/+$/, "");
  if (SCHEME_URL.test(text)) {
    text = text.slice(text.indexOf("://") + 3);
    const slash = text.indexOf("/");
    let authority = slash < 0 ? text : text.slice(0, slash);
    const path = slash < 0 ? "" : text.slice(slash);
    authority = authority.slice(authority.lastIndexOf("@") + 1);  // user[:password|token]@
    authority = authority.replace(/:\d+$/, "");                  // ssh://host:22/…
    if (authority === "") return null;                            // file:///… and other host-less URLs
    text = authority + path;
  } else {
    const colon = text.indexOf(":");
    const slash = text.indexOf("/");
    if (colon <= 0 || (slash >= 0 && slash < colon)) return null; // a local path, not scp-like
    let host = text.slice(0, colon);
    const path = text.slice(colon + 1);
    host = host.slice(host.lastIndexOf("@") + 1);
    if (host === "" || host.includes("/")) return null;
    text = `${host}/${path.replace(/^\/+/, "")}`;
  }
  text = text.replace(/\/{2,}/g, "/").replace(/\.git$/i, "").replace(/\/+$/, "");
  if (text === "" || /[\u0000-\u001f\u007f]/.test(text)) return null;
  const safe = redactText(text, LIMITS.textChars).trim();
  return safe === "" ? null : safe;
}

/**
 * Full info for one repository marker: branch/head from HEAD, remote from the (common) config.
 * @param {{root:string, gitdir:string, head:string, worktree:boolean}} found
 * @returns {Promise<import("../protocol.mjs").Repo>}
 */
async function repoDetails(found) {
  /** @type {import("../protocol.mjs").Repo} */
  const repo = { root: found.root };
  Object.assign(repo, headFields(found.head));

  let configDir = found.gitdir;
  const common = await readCapped(join(found.gitdir, "commondir"), REPO_LIMITS.commondirBytes);
  if (common !== null) {
    const target = firstLine(common);
    if (target !== "") configDir = resolvePath(found.gitdir, target);
  }
  const config = await readCapped(join(configDir, "config"), REPO_LIMITS.configBytes);
  const remote = config === null ? null : sanitizeRemoteUrl(parseConfigRemote(config));
  if (remote !== null) repo.remote = remote;
  if (found.worktree) repo.worktree = true;
  return repo;
}

/**
 * Repository discovery with a per-directory result cache.
 *
 * @param {object} [options]
 * @param {string} [options.home]            the collector host's home directory; never a root itself
 * @param {() => number} [options.now]
 * @param {number} [options.ttlMs]           how long a positive dir → root answer is reused (0 disables the cache)
 * @param {number} [options.negativeTtlMs]   how long a "not in a repository" answer is reused
 * @param {number} [options.maxCache]        bound of the per-directory cache
 * @param {number} [options.walk]            ancestors checked per directory (default REPO_LIMITS.walk)
 * @returns {{resolve(params: {dirs?: unknown, roots?: unknown}): Promise<{dirs: Record<string, string|null>, repos: import("../protocol.mjs").Repo[]}>, clear(): void, stats(): {cached: number}}}
 */
export function createRepoResolver({ home = homedir(), now = Date.now, ttlMs = 60_000, negativeTtlMs = 30_000, maxCache = 4000, walk = REPO_LIMITS.walk } = {}) {
  const homeDir = resolvePath(home);
  const cache = new Map();                                       // absolute dir → {root: string|null, until: number}

  function cacheGet(dir) {
    const entry = cache.get(dir);
    if (entry === undefined) return undefined;
    if (now() < entry.until) return entry.root;
    cache.delete(dir);
    return undefined;
  }

  function cacheSet(dir, root) {
    if (ttlMs <= 0 && negativeTtlMs <= 0) return;
    cache.delete(dir);
    cache.set(dir, { root, until: now() + (root === null ? negativeTtlMs : ttlMs) });
    while (cache.size > maxCache) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  /** Nearest marker above `dir` (the directory itself included), respecting the walk and root exclusions. */
  async function walkUp(dir) {
    let current = dir;
    for (let steps = 0; steps < walk; steps += 1) {
      if (current !== "/" && current !== homeDir) {
        const found = await inspectMarker(current);
        if (found !== null) return found;
      }
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
    return null;
  }

  async function resolve(params = {}) {
    const requestedDirs = (Array.isArray(params?.dirs) ? params.dirs : [])
      .filter(dir => typeof dir === "string" && dir !== "").slice(0, REPO_LIMITS.dirs);
    const requestedRoots = (Array.isArray(params?.roots) ? params.roots : [])
      .filter(root => typeof root === "string" && root !== "").slice(0, REPO_LIMITS.roots);

    /** @type {Record<string, string|null>} */
    const dirs = {};
    /** @type {Map<string, {root:string, gitdir:string, head:string, worktree:boolean}>} */
    const hits = new Map();

    for (const dir of requestedDirs) {
      if (!isAbsolute(dir)) { dirs[dir] = null; continue; }
      const abs = resolvePath(dir);
      const cached = cacheGet(abs);
      if (cached !== undefined) {
        dirs[dir] = cached;
        if (cached !== null && !hits.has(cached)) {
          const found = await inspectMarker(cached);              // still a repo? HEAD also gives us the branch
          if (found !== null) hits.set(cached, found);
          else { dirs[dir] = null; cacheSet(abs, null); }
        }
        continue;
      }
      const found = await walkUp(abs);
      dirs[dir] = found?.root ?? null;
      cacheSet(abs, dirs[dir]);
      if (found !== null) hits.set(found.root, found);
    }

    // Metadata is re-read on every request (HEAD changes with the branch), but once per root.
    for (const raw of requestedRoots) {
      if (!isAbsolute(raw)) continue;
      const abs = resolvePath(raw);
      const found = await inspectMarker(abs);                     // "still a repo": the marker must be at the root itself
      if (found === null) {
        hits.delete(abs);
        for (const [dir, root] of Object.entries(dirs)) if (root === abs) dirs[dir] = null;
      } else {
        hits.set(found.root, found);
      }
    }

    const repos = [];
    for (const found of hits.values()) repos.push(await repoDetails(found));
    repos.sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
    return { dirs, repos };
  }

  return {
    resolve,
    clear() { cache.clear(); },
    stats() { return { cached: cache.size }; },
  };
}