// Repository discovery (Contract B): the collector resolver (walk-up, worktrees, submodules, URL sanitising, bounds)
// and the hub side (batched repo.resolve over a collector link, caches, branch refresh, unsupported backoff, the
// repos map in snapshot / deltas, upstream merge, and Contract A line counts in clampEvent).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative as relativePath } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { REPO_LIMITS, createRepoResolver, sanitizeRemoteUrl } from "../lib/collector/repos.mjs";
import { createRepoRegistry } from "../lib/hub/repos.mjs";
import { createState } from "../lib/hub/state.mjs";
import { agentKey } from "../lib/protocol.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const scratchRoot = join(here, "..", ".scratch");
mkdirSync(scratchRoot, { recursive: true });
const workDir = mkdtempSync(join(scratchRoot, "repos-test-"));
after(() => rmSync(workDir, { recursive: true, force: true }));

let counter = 0;
const newDir = name => { const dir = join(workDir, `${name}-${counter++}`); mkdirSync(dir, { recursive: true }); return dir; };
/** The resolver's "home" for most tests: a path that exists nowhere, so nothing is excluded by the home rule. */
const noHome = join(workDir, "no-home");

const configText = url => `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;

/** A work tree whose `.git` is a directory holding HEAD (and, when given, a config). */
function makeRepo(dir, { head = "ref: refs/heads/main\n", config = configText("https://github.com/o/r.git") } = {}) {
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), head);
  if (config !== null) writeFileSync(join(dir, ".git", "config"), config);
  return dir;
}

/** A `.git` *file* pointing at a git dir, as a linked worktree or a submodule writes it. */
function linkGitFile(workTree, gitdir, { relative = false } = {}) {
  mkdirSync(workTree, { recursive: true });
  writeFileSync(join(workTree, ".git"), `gitdir: ${relative ? relativePath(workTree, gitdir) : gitdir}\n`);
  return workTree;
}

/** `depth` nested `a/` components under `base`. */
function deepDir(base, depth) {
  let dir = base;
  for (let i = 0; i < depth; i += 1) dir = join(dir, "a");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// -------------------------------------------------------------------------------------------- collector resolver

describe("collector repo.resolve", () => {
  test("a directory in a repository maps to its work tree; the nearest repository wins", async () => {
    const base = newDir("nested");
    const outer = makeRepo(join(base, "outer"), { config: configText("https://github.com/o/outer.git") });
    const inner = makeRepo(join(outer, "vendor", "inner"), { config: configText("git@github.com:o/inner.git") });
    const src = join(outer, "src", "deep");
    const lib = join(inner, "lib");
    mkdirSync(src, { recursive: true });
    mkdirSync(lib, { recursive: true });

    const { dirs, repos } = await createRepoResolver({ home: noHome }).resolve({ dirs: [src, lib, outer, inner] });
    assert.equal(dirs[src], outer);
    assert.equal(dirs[lib], inner, "a nested repository wins over the one around it");
    assert.equal(dirs[outer], outer);
    assert.equal(dirs[inner], inner);
    assert.deepEqual(repos.map(repo => repo.root), [outer, inner], "repositories are sorted by root");
    assert.equal(repos.find(repo => repo.root === outer).remote, "github.com/o/outer");
    assert.equal(repos.find(repo => repo.root === inner).remote, "github.com/o/inner");
  });

  test("a linked worktree: `.git` file, gitdir HEAD, commondir config, worktree: true", async () => {
    const base = newDir("worktree");
    const main = makeRepo(join(base, "main"), { config: configText("https://user:secret-token@github.com/o/main.git") });
    const gitdir = join(main, ".git", "worktrees", "graph");
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, "HEAD"), "ref: refs/heads/feat/graph\n");
    writeFileSync(join(gitdir, "commondir"), "../..\n");
    const worktree = linkGitFile(join(base, "wt"), gitdir);
    mkdirSync(join(worktree, "packages", "app"), { recursive: true });

    const { dirs, repos } = await createRepoResolver({ home: noHome }).resolve({ dirs: [join(worktree, "packages", "app")] });
    assert.equal(dirs[join(worktree, "packages", "app")], worktree);
    assert.deepEqual(repos, [{ root: worktree, remote: "github.com/o/main", branch: "feat/graph", worktree: true }]);
  });

  test("a submodule-style gitdir: relative pointer, HEAD and config in .git/modules", async () => {
    const base = newDir("submodule");
    const superRepo = makeRepo(join(base, "super"), { config: configText("https://github.com/o/super.git") });
    const moduleGit = join(superRepo, ".git", "modules", "sub");
    mkdirSync(moduleGit, { recursive: true });
    writeFileSync(join(moduleGit, "HEAD"), "ref: refs/heads/sub-main\n");
    writeFileSync(join(moduleGit, "config"), configText("https://github.com/o/sub.git"));
    const sub = linkGitFile(join(superRepo, "sub"), moduleGit, { relative: true });
    mkdirSync(join(sub, "src"), { recursive: true });

    const { dirs, repos } = await createRepoResolver({ home: noHome }).resolve({ dirs: [join(sub, "src")] });
    assert.equal(dirs[join(sub, "src")], sub, "the submodule is its own work tree, not the superproject");
    assert.deepEqual(repos, [{ root: sub, remote: "github.com/o/sub", branch: "sub-main", worktree: true }]);
  });

  test("detached HEAD gives 12 hex chars; a config without a remote leaves remote out", async () => {
    const base = newDir("detached");
    const detached = makeRepo(join(base, "detached"), {
      head: "0123456789abcdef0123456789abcdef01234567\n",
      config: "[core]\n\trepositoryformatversion = 0\n",
    });
    const { repos } = await createRepoResolver({ home: noHome }).resolve({ dirs: [detached] });
    assert.deepEqual(repos, [{ root: detached, head: "0123456789ab" }]);
    assert.equal("branch" in repos[0], false);
    assert.equal("remote" in repos[0], false);
  });

  test("the origin remote wins over the first remote; without origin the first remote is used", async () => {
    const base = newDir("remotes");
    const both = makeRepo(join(base, "both"), {
      config: '[remote "alpha"]\n\turl = https://github.com/o/alpha.git\n[remote "origin"]\n\turl = https://github.com/o/origin.git\n',
    });
    const firstOnly = makeRepo(join(base, "first"), {
      config: '[remote "upstream"]\n\turl = ssh://git@git.example.com:2222/team/proj.git\n',
    });
    const { repos } = await createRepoResolver({ home: noHome }).resolve({ dirs: [both, firstOnly] });
    assert.equal(repos.find(repo => repo.root === both).remote, "github.com/o/origin");
    assert.equal(repos.find(repo => repo.root === firstOnly).remote, "git.example.com/team/proj");
  });

  test("remote URLs become host/path without scheme, userinfo, port or .git", () => {
    const cases = [
      ["https://user:token@github.com/o/r.git", "github.com/o/r"],
      ["https://token@github.com/o/r.git/", "github.com/o/r"],
      ["git@github.com:o/r.git", "github.com/o/r"],
      ["git@github.com:o/r", "github.com/o/r"],
      ["ssh://git@github.com:22/o/r.git", "github.com/o/r"],
      ["git+ssh://git@github.com/o/r.git", "github.com/o/r"],
      ["https://github.com/o/r", "github.com/o/r"],
      ["file:///srv/git/r.git", null],
      ["/srv/git/r.git", null],
      ["", null],
    ];
    for (const [input, expected] of cases) assert.equal(sanitizeRemoteUrl(input), expected, input);
    const redacted = sanitizeRemoteUrl("https://user:supersecret@github.com/o/r.git");
    assert.equal(redacted.includes("supersecret"), false, "credentials never survive");
    assert.match(sanitizeRemoteUrl("https://github.com/o/r?token=supersecret"), /‹redacted›/);
  });

  test("a directory outside a repository is null; the home directory itself is never a root", async () => {
    const home = join(workDir, `home-${counter++}`);
    makeRepo(home, { config: null });                              // $HOME/.git must not turn $HOME into a root
    const notes = join(home, "notes");
    const plain = join(workDir, `plain-${counter++}`, "a", "b");
    mkdirSync(notes, { recursive: true });
    mkdirSync(plain, { recursive: true });

    // This test workspace lives inside a git work tree of its own, so a bounded walk stands in for "nothing is above":
    // three steps see `notes`, `home` (excluded) and the scratch directory, and two steps see `plain/a/b`, none of
    // which carries a marker.
    const { dirs, repos } = await createRepoResolver({ home, walk: 3 }).resolve({ dirs: [home, notes, plain] });
    assert.equal(dirs[home], null, "home with a .git is not a root");
    assert.equal(dirs[notes], null, "walking up from a directory in home skips home");
    assert.equal(dirs[plain], null);
    assert.deepEqual(repos, []);
  });

  test("caps: 200 dirs, 200 roots, 64 walk-up steps, 1 KiB HEAD and 64 KiB config", async () => {
    const base = newDir("caps");
    const dirs = [];
    for (let i = 0; i < 205; i += 1) {
      const dir = join(base, "d", String(i).padStart(3, "0"));
      mkdirSync(dir, { recursive: true });
      dirs.push(dir);
    }
    const dirPage = await createRepoResolver({ home: noHome, walk: 1 }).resolve({ dirs });
    assert.equal(Object.keys(dirPage.dirs).length, 200, "at most 200 directories per request");
    assert.equal(dirPage.dirs[dirs[0]], null);
    assert.equal(dirPage.dirs[dirs[204]], undefined, "the 205th directory is not processed");

    const roots = [];
    for (let i = 0; i < 205; i += 1) roots.push(makeRepo(join(base, "r", String(i).padStart(3, "0")), { config: null }));
    const rootPage = await createRepoResolver({ home: noHome }).resolve({ roots });
    assert.equal(rootPage.repos.length, 200, "at most 200 roots per request");
    assert.ok(!rootPage.repos.some(repo => repo.root === roots[204]));

    const repo = makeRepo(join(base, "walk", "repo"), { config: null });
    const deep = deepDir(repo, REPO_LIMITS.walk + 6);              // the root is 70 steps above
    const near = join(repo, "src");
    mkdirSync(near, { recursive: true });
    const walkPage = await createRepoResolver({ home: noHome }).resolve({ dirs: [deep, near] });
    assert.equal(walkPage.dirs[deep], null, "70 steps above the root is beyond the 64-step walk");
    assert.equal(walkPage.dirs[near], repo);

    const bigHead = join(base, "big-head");
    mkdirSync(join(bigHead, ".git"), { recursive: true });
    writeFileSync(join(bigHead, ".git", "HEAD"), " ".repeat(1100) + "ref: refs/heads/zzz\n");
    writeFileSync(join(bigHead, ".git", "config"), configText("https://github.com/o/big.git"));
    const headPage = await createRepoResolver({ home: noHome }).resolve({ dirs: [bigHead] });
    assert.equal(headPage.repos[0].branch, undefined, "a ref beyond the 1 KiB HEAD read is not parsed");
    assert.equal(headPage.repos[0].remote, "github.com/o/big");

    const bigConfig = makeRepo(join(base, "big-config"), {
      config: `#${"x".repeat(REPO_LIMITS.configBytes)}\n[remote "origin"]\n\turl = https://github.com/o/cap.git\n`,
    });
    const configPage = await createRepoResolver({ home: noHome }).resolve({ dirs: [bigConfig] });
    assert.equal(configPage.repos[0].remote, undefined, "a remote beyond the 64 KiB config read is not parsed");
  });

  test("the dir cache reuses mappings, re-reads HEAD and honours its TTLs", async () => {
    const base = newDir("cache");
    const repo = makeRepo(join(base, "repo"), { config: null });
    let clock = 10_000;
    // Two steps keep the walk inside this test's directory tree (the workspace itself lives in a git work tree).
    const resolver = createRepoResolver({ home: noHome, now: () => clock, ttlMs: 100, negativeTtlMs: 40, walk: 2 });
    const plain = join(base, "plain");
    mkdirSync(plain, { recursive: true });

    assert.equal((await resolver.resolve({ dirs: [repo, plain] })).dirs[repo], repo);
    assert.equal(resolver.stats().cached, 2);

    // the mapping comes from the cache but HEAD is read again, so a branch switch is visible immediately
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/dev\n");
    const switched = await resolver.resolve({ dirs: [repo] });
    assert.equal(switched.dirs[repo], repo);
    assert.equal(switched.repos[0].branch, "dev");

    // a cached root that disappeared is re-checked and becomes a negative answer
    rmSync(repo, { recursive: true, force: true });
    assert.equal((await resolver.resolve({ dirs: [repo] })).dirs[repo], null);

    // a negative answer is reused until its (shorter) TTL expires, so a fresh checkout is not visible at once
    mkdirSync(join(plain, ".git"), { recursive: true });
    writeFileSync(join(plain, ".git", "HEAD"), "ref: refs/heads/main\n");
    assert.equal((await resolver.resolve({ dirs: [plain] })).dirs[plain], null);
    clock += 41;
    assert.equal((await resolver.resolve({ dirs: [plain] })).dirs[plain], plain);
  });
});

// ------------------------------------------------------------------------------------------------- hub tracker

const now = 1_000_000;
const hostInfo = { id: "mac", site: "mac", kind: "workstation", label: "mac" };

function agentRecord() {
  return {
    key: agentKey("mac", "omp", "a1"), host: "mac", site: "mac", kind: "omp", id: "a1", file: "/sessions/a1.jsonl", cwd: "/work",
    title: "a1", model: "m", role: "main", parent: null, startedAt: now, updatedAt: now, endedAt: null, status: "running",
    live: { alive: true, state: "model", since: now, doing: "", turnOpen: true },
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    counts: { turns: 1, tools: 0, errors: 0, subagents: 0, events: 0 },
  };
}

/** A hub state with `mac` online and one agent; the tracker only needs `agent(host)` for host-less targets. */
function trackerState(clock = () => now) {
  const state = createState({ now: clock, hostId: "hub" });
  state.hostConnected(hostInfo, { at: clock() });
  state.applyCollectorMessage("mac", { t: "agent", agent: agentRecord() });
  return state;
}

const fileEvent = (id, paths) => ({ id, type: "tool", t: now, name: "bash", category: "shell", status: "ok", targets: paths.map(path => ({ type: "file", op: "read", path })) });
const KEY = agentKey("mac", "omp", "a1");
const repoOf = (over = {}) => ({ root: "/work/proj", remote: "github.com/o/proj", branch: "main", ...over });

describe("hub repo tracker", () => {
  test("batches the dirs of file targets into one request, publishes the repos and caches the answer", async () => {
    const state = trackerState();
    const requests = [];
    const links = {
      has: () => true,
      request: async (host, method, params) => {
        requests.push({ host, method, params });
        return { dirs: Object.fromEntries(params.dirs.map(dir => [dir, "/work/proj"])), repos: [repoOf()] };
      },
    };
    const registry = createRepoRegistry({ state, links, now: () => now, batchMs: 1 });
    const since = state.cursor;
    registry.observe(KEY, fileEvent("e1", ["/work/proj/src/a.ts", "/work/proj/src/b.ts"]));
    await registry.flush();

    assert.equal(requests.length, 1, "one batched request for both directories");
    assert.deepEqual(requests[0], { host: "mac", method: "repo.resolve", params: { dirs: ["/work/proj/src/a.ts", "/work/proj/src/b.ts"], roots: [] } });
    assert.deepEqual(state.snapshot().repos.mac, [repoOf()]);
    const delta = state.changesSince(since);
    assert.deepEqual(delta.repos.mac, [repoOf()], "the delta carries the full list of the changed host");
    assert.equal(registry.stats().hosts.mac.pending, 0);

    registry.observe(KEY, fileEvent("e2", ["/work/proj/src/a.ts"]));
    await registry.flush();
    assert.equal(requests.length, 1, "a cached dir is not asked again");
  });

  test("a host with no repository publishes [] and caches the negative answer", async () => {
    const state = trackerState();
    const requests = [];
    const links = {
      has: () => true,
      request: async (host, method, params) => {
        requests.push(params);
        return { dirs: Object.fromEntries(params.dirs.map(dir => [dir, null])), repos: [] };
      },
    };
    const registry = createRepoRegistry({ state, links, now: () => now, batchMs: 1 });
    registry.observe(KEY, fileEvent("e1", ["/nowhere/notes.md"]));
    await registry.flush();
    assert.deepEqual(state.snapshot().repos.mac, [], "[] means resolved, no repository");
    registry.observe(KEY, fileEvent("e2", ["/nowhere/notes.md"]));
    await registry.flush();
    assert.equal(requests.length, 1);
  });

  test("an unsupported method backs the host off; the queued dirs wait for the window", async () => {
    let clock = now;
    const state = trackerState(() => clock);
    let asked = 0;
    const links = {
      has: () => true,
      request: async () => {
        asked += 1;
        throw Object.assign(new Error("unknown collector method repo.resolve"), { code: "unsupported" });
      },
    };
    const registry = createRepoRegistry({ state, links, now: () => clock, batchMs: 1, unsupportedMs: 60_000 });
    registry.observe(KEY, fileEvent("e1", ["/work/a.ts"]));
    await registry.flush();
    assert.equal(asked, 1);
    assert.equal(registry.stats().hosts.mac.pending, 1, "the dir stays queued for a collector that may be updated");
    assert.equal(registry.stats().hosts.mac.unsupportedUntil, now + 60_000);

    clock += 30_000;
    registry.observe(KEY, fileEvent("e2", ["/work/b.ts"]));
    await registry.flush();
    assert.equal(asked, 1, "not re-asked inside the unsupported window");

    clock += 30_001;
    await registry.flush();
    assert.equal(asked, 2, "asked again once the window passed");
    assert.equal(state.snapshot().repos.mac, undefined, "a collector that cannot answer publishes nothing");
  });

  test("error backoff doubles up to its cap and success resets it", async () => {
    let clock = now;
    const state = trackerState(() => clock);
    let calls = 0;
    const links = {
      has: () => true,
      request: async (host, method, params) => {
        calls += 1;
        if (calls <= 2) throw new Error("collector exploded");
        return { dirs: Object.fromEntries(params.dirs.map(dir => [dir, "/work/proj"])), repos: [repoOf()] };
      },
    };
    const registry = createRepoRegistry({ state, links, now: () => clock, batchMs: 1, retryMs: 1_000, maxRetryMs: 10_000 });
    registry.observe(KEY, fileEvent("e1", ["/work/a.ts"]));
    await registry.flush();
    assert.equal(calls, 1);
    assert.equal(registry.stats().hosts.mac.retryAt, now + 1_000);

    clock += 500;
    await registry.flush();
    assert.equal(calls, 1, "still inside the first backoff");
    clock += 500;
    await registry.flush();
    assert.equal(calls, 2);
    assert.equal(registry.stats().hosts.mac.retryAt, clock + 2_000, "the second failure waits twice as long");

    clock += 1_999;
    await registry.flush();
    assert.equal(calls, 2);
    clock += 1;
    await registry.flush();
    assert.equal(calls, 3);
    assert.equal(registry.stats().hosts.mac.retryAt, 0, "success clears the backoff");
    assert.deepEqual(state.snapshot().repos.mac, [repoOf()]);
  });

  test("known roots are refreshed after the refresh window (branch changes) and dropped when they vanish", async () => {
    let clock = now;
    const state = trackerState(() => clock);
    const requests = [];
    let branch = "main";
    let rooted = true;
    const links = {
      has: () => true,
      request: async (host, method, params) => {
        requests.push(params);
        return {
          dirs: Object.fromEntries((params.dirs ?? []).map(dir => [dir, rooted ? "/work/proj" : null])),
          repos: rooted ? [repoOf({ branch })] : [],
        };
      },
    };
    const registry = createRepoRegistry({ state, links, now: () => clock, batchMs: 1, refreshMs: 60_000, dirTtlMs: 300_000 });
    registry.observe(KEY, fileEvent("e1", ["/work/proj/src/a.ts"]));
    await registry.flush();
    assert.deepEqual(requests[0], { dirs: ["/work/proj/src/a.ts"], roots: [] });

    clock += 30_000;
    await registry.flush();
    assert.equal(requests.length, 1, "no refresh before the window");

    branch = "dev";
    clock += 30_000;
    await registry.flush();
    assert.deepEqual(requests[1], { dirs: [], roots: ["/work/proj"] }, "roots are re-read by path");
    assert.equal(state.snapshot().repos.mac[0].branch, "dev");

    rooted = false;
    clock += 60_000;
    await registry.flush();
    assert.deepEqual(requests[2], { dirs: [], roots: ["/work/proj"] });
    assert.deepEqual(state.snapshot().repos.mac, [], "a root that is gone is removed from the list");
  });
});

// --------------------------------------------------------------------------------------- hub state: repos + lines

describe("hub state: repos", () => {
  test("setRepos sanitises roots, remotes, heads and duplicates", () => {
    const state = createState({ now: () => now, hostId: "hub" });
    state.setRepos("mac", [
      { root: "relative/path" },
      { root: "/srv/app", remote: "https://u:supersecret@github.com/o/r.git", head: "ABCDEF0123456789", worktree: true },
      { root: "/srv/app", branch: "duplicate" },
      { root: "/srv/other", branch: "x".repeat(500) },
    ]);
    const list = state.reposOf("mac");
    assert.equal(list.length, 2, "the non-absolute root is dropped and the duplicate keeps the first record");
    assert.equal(JSON.stringify(list).includes("supersecret"), false, "the remote is redacted");
    assert.equal(list[0].head, "abcdef012345");
    assert.equal(list[0].worktree, true);
    assert.equal(list[1].branch.length, 240);
    // [] is a real answer ("no repository"), undefined is "never resolved"
    assert.equal(state.setRepos("sg-compute", []), true);
    assert.deepEqual(state.snapshot().repos, { mac: list, "sg-compute": [] });
    assert.equal(state.setRepos("sg-compute", []), false, "an unchanged list journals nothing");
  });

  test("an upstream snapshot replaces repos of the hosts it owns only; deltas replace per host", () => {
    let clock = now;
    const state = createState({ now: () => clock, hostId: "mac" });
    const sink = state.upstream("up");
    const sample = { root: "/srv/app", remote: "github.com/o/app", branch: "main" };
    const snapshot = over => ({
      now: clock, hosts: [{ id: "sg-compute", site: "sg-compute", kind: "server", label: "sg" }],
      agents: [], pods: [], links: [], feed: [], ...over,
    });
    sink.snapshot(snapshot({ repos: { "sg-compute": [sample] } }));
    assert.deepEqual(state.snapshot().repos["sg-compute"], [sample]);

    // a local collector owns `mac`; an upstream list for it is ignored
    state.hostConnected({ id: "mac", site: "mac", kind: "workstation", label: "mac" }, { at: clock });
    sink.snapshot(snapshot({
      hosts: [{ id: "sg-compute", site: "sg-compute", kind: "server", label: "sg" }, { id: "mac", site: "mac", kind: "workstation", label: "mac" }],
      repos: { "sg-compute": [], mac: [{ root: "/Users/u/work" }] },
    }));
    assert.deepEqual(state.snapshot().repos["sg-compute"], [], "the upstream snapshot replaces the list ([] = none)");
    assert.equal(state.snapshot().repos.mac, undefined, "a locally owned host keeps its own repos");

    sink.delta({ now: clock, repos: { "sg-compute": [{ root: "/srv/next", branch: "dev" }], mac: [{ root: "/Users/u/other" }] } });
    assert.deepEqual(state.snapshot().repos["sg-compute"], [{ root: "/srv/next", branch: "dev" }]);
    assert.equal(state.snapshot().repos.mac, undefined);

    const cursor = state.cursor;
    sink.delta({ now: clock, repos: { "sg-compute": [] } });
    assert.deepEqual(state.changesSince(cursor).repos, { "sg-compute": [] });

    // an upstream that predates Contract B (no repos field) does not wipe what is known
    sink.snapshot(snapshot({ repos: { "sg-compute": [{ root: "/srv/app", branch: "main" }] } }));
    sink.snapshot(snapshot({}));
    assert.deepEqual(state.snapshot().repos["sg-compute"], [{ root: "/srv/app", branch: "main" }]);

    sink.snapshot(snapshot({ repos: { "sg-compute": [{ root: "/srv/app", remote: "https://u:supersecret@github.com/o/app.git" }] } }));
    assert.equal(JSON.stringify(state.snapshot().repos).includes("supersecret"), false, "upstream remotes are redacted too");
  });
});

describe("hub state: Contract A line counts", () => {
  test("clampEvent keeps only read/added/removed as finite non-negative integers and drops empty ones", () => {
    const state = createState({ now: () => now, hostId: "hub" });
    state.hostConnected(hostInfo, { at: now });
    state.applyCollectorMessage("mac", { t: "agent", agent: agentRecord() });
    state.applyCollectorMessage("mac", {
      t: "events",
      agent: KEY,
      events: [{
        id: "e1", type: "tool", t: now, name: "bash", category: "shell", status: "ok",
        targets: [
          { type: "file", op: "edit", path: "/a", lines: { read: 10, added: 2.9, removed: -1, other: 5 } },
          { type: "file", op: "read", path: "/b", lines: {} },
          { type: "file", op: "read", path: "/c", lines: { read: "5" } },
          { type: "file", op: "read", path: "/d", lines: { read: 20_000_000 } },
          { type: "file", op: "read", path: "/e", lines: [1] },
          { type: "file", op: "read", path: "/f", lines: 7 },
          { type: "file", op: "read", path: "/g", lines: { read: 1, added: 2, removed: 3 } },
          { type: "file", op: "read", path: "/h" },
        ],
      }],
    });
    const event = state.agentEvents(KEY).events.find(entry => entry.id === "e1");
    const byPath = Object.fromEntries(event.targets.map(target => [target.path, target]));
    assert.deepEqual(byPath["/a"].lines, { read: 10, added: 2 }, "fractional counts floor, negative and unknown keys go");
    for (const path of ["/b", "/c", "/e", "/f", "/h"]) assert.equal("lines" in byPath[path], false, path);
    assert.deepEqual(byPath["/d"].lines, { read: 10_000_000 }, "counts are capped");
    assert.deepEqual(byPath["/g"].lines, { read: 1, added: 2, removed: 3 });
  });
});