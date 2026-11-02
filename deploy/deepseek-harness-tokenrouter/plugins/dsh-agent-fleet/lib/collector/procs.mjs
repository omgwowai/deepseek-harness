// Processes: the agent processes of this machine (omp, claude, codex, dsh, ACP bridges, and the kubectl / ssh
// processes that launch an agent somewhere else), matched to the sessions the collector tracks.
//
//   createProcs(...).scan()        one pass over the process table (+ cwd / open transcripts / env of the interesting ones)
//   bindProcs(views, scan)         Proc[] to report, process → session bindings, transcripts to adopt
//
// Data sources. macOS: `ps -axww -o pid=,ppid=,lstart=,command=` every scan; `lsof -nP -a -p <pids> -d cwd,3-2000`
// for cwd and open transcripts (new pids at once, then every 10 s); `ps -E` for the environment, once per new pid.
// Linux: /proc/<pid>/{stat,cmdline} (cached per pid), cwd and fd links, environ (once per pid) and /proc/locks.
//
// Reported `Proc.ppid` is the pid of the nearest reported ancestor (an agent, bridge or launcher) when there is one:
// shells and node wrappers between a parent agent and its `kubectl exec` / child agent are skipped.
import { execFile } from "node:child_process";
import { readFile, readdir, readlink, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { ENV_PARENT, ENV_PARENT_CALL, LIMITS } from "../protocol.mjs";
import { redactText } from "../redact.mjs";
import { parseCommand } from "../targets.mjs";
import { mapLimit } from "./util.mjs";

const SESSION_KINDS = ["omp", "claude", "codex", "dsh"];
/** Env var each agent exports its own session id in, for the shell commands it runs. */
export const SESSION_VAR = Object.freeze({ omp: "PI_SESSION_ID", claude: "CLAUDE_CODE_SESSION_ID", codex: "CODEX_THREAD_ID", dsh: "DSH_SESSION_ID" });
const ENV_VIA = "AGENT_FLEET_VIA";
const ENV_TOOL_CALL = "CODEX_TOOL_CALL_ID";
/** DSH only passes `DSH_`-prefixed variables into the shells its model runs (the fleet plugin registers these two). */
const ENV_DSH_PARENT = "DSH_AGENT_FLEET_PARENT";
const ENV_DSH_PARENT_CALL = "DSH_AGENT_FLEET_PARENT_CALL";
const WANTED_ENV = [...Object.values(SESSION_VAR), ENV_TOOL_CALL, ENV_PARENT, `LC_${ENV_PARENT}`, ENV_PARENT_CALL, ENV_DSH_PARENT, ENV_DSH_PARENT_CALL, ENV_VIA];

const INTERPRETERS = new Set(["node", "nodejs", "bun", "deno", "tsx"]);
const NOT_A_SESSION = new Set(["help", "version", "config", "login", "logout", "update", "upgrade", "install", "setup", "doctor", "mcp", "plugin", "plugins", "completion", "features", "auth", "gc", "stats", "migrate-installer", "setup-token"]);
const BRIDGES = /(?:^|\/)(?:claude-agent-acp|claude-code-acp|codex-acp)(?:\/|$)/;
const TRANSCRIPT_FILE = /(?:\.jsonl|\.jsonl\.zstd|\/session\.lock)$/;
const STALE_QUIET_MS = 5 * 60_000;
const FALLBACK_WINDOW_MS = 10 * 60_000;
const MAX_ANCESTORS = 64;
const EXEC_OPTIONS = { maxBuffer: 128 * 1024 * 1024, timeout: 15_000, env: { ...process.env, LC_ALL: "C", LANG: "C" } };

// ----------------------------------------------------------------------------------------------- classification

/**
 * macOS `ps` joins argv with spaces: recover [argv0, script?, ...args]. The command is cut at the first ` -flag`;
 * what precedes it is `<interpreter> <script>`, or one path (possibly containing spaces: "Application Support")
 * followed by plain words. A space inside a directory name is only recognised before the last `/`.
 */
export function splitCommand(cmd) {
  const dash = cmd.search(/ -/);
  const head = dash < 0 ? cmd : cmd.slice(0, dash);
  const tail = dash < 0 ? [] : cmd.slice(dash + 1).split(/\s+/).filter(Boolean);
  const interpreter = head.includes(" ") ? /^(\S*\/)?(node|nodejs|bun|deno|tsx)\s+(.+)$/.exec(head) : null;
  if (interpreter) {
    const words = interpreter[3].split(/\s+/);
    let end = words.findIndex(word => /\.(?:m?js|cjs|ts)$/.test(word));
    if (end < 0 || end > 8) end = 0; // a script without extension (…/bin/omp) is the first word
    return [`${interpreter[1] ?? ""}${interpreter[2]}`, words.slice(0, end + 1).join(" "), ...words.slice(end + 1), ...tail];
  }
  const space = head.indexOf(" ", head.lastIndexOf("/") + 1);
  if (space > 0) return [head.slice(0, space), ...head.slice(space + 1).split(/\s+/).filter(Boolean), ...tail];
  return [head, ...tail];
}

/**
 * What an argv is: `{kind, server?}` for an agent (omp | claude | codex | dsh) or an ACP bridge ("acp-bridge"),
 * `{kind: "kubectl"|"ssh", launches, remote}` for a launcher of a remote agent, null for anything else.
 * @param {string[]} argv
 * @param {{cmd?: string, host?: string, site?: string}} [context]
 */
export function classifyCommand(argv, { cmd = argv.join(" "), host, site } = {}) {
  if (argv.length === 0 || !argv[0]) return null;
  const exe = basename(argv[0]);
  let script = null, rest = argv.slice(1);
  if (INTERPRETERS.has(exe)) {
    let index = rest.findIndex(arg => !arg.startsWith("-"));
    if (index >= 0 && exe === "bun" && (rest[index] === "run" || rest[index] === "x")) index = rest.findIndex((arg, i) => i > index && !arg.startsWith("-"));
    if (index >= 0) { script = rest[index]; rest = rest.slice(index + 1); }
  }
  const target = script ?? argv[0];
  const name = basename(target).replace(/\.(?:m?js|cjs|ts)$/, "");
  const firstWord = rest.find(arg => !arg.startsWith("-"));
  const sessionless = rest.some(arg => arg === "--version" || arg === "-V" || arg === "--help" || arg === "-h") || (firstWord !== undefined && NOT_A_SESSION.has(firstWord));

  if (argv.some(arg => arg.startsWith("--type="))) return null; // Electron helper processes
  if (/(?:^|\/)dsh\/lib\/bin\.js$/.test(target) || /dsh-desktop-host\/lib\/index\.js/.test(cmd) || name === "dsh") return sessionless ? null : { kind: "dsh" };
  if (BRIDGES.test(target) || BRIDGES.test(exe)) return { kind: "acp-bridge" };
  if (rest.some(arg => arg.startsWith("__omp_"))) return null; // omp's own worker processes
  if (name === "omp" || /\/pi-coding-agent\/(?:dist|src)\/cli\.(?:js|ts)$/.test(target)) return sessionless ? null : { kind: "omp" };
  if (name === "claude" || /@anthropic-ai\/claude-(?:code|agent-sdk)\//.test(target) || /\/claude\/versions\/\d/.test(target)) return sessionless ? null : { kind: "claude" };
  if (name === "codex" || /^codex-(?:aarch64|arm64|x86_64)-/.test(exe)) return sessionless ? null : { kind: "codex", ...(rest.includes("app-server") && { server: true }) };
  if (exe === "kubectl" || exe === "oc" || exe === "ssh") return classifyLauncher(argv, exe === "ssh" ? "ssh" : "kubectl", { host, site });
  return null;
}

function classifyLauncher(argv, kind, { host, site }) {
  // `ps` flattens quoting on macOS (`bash -lc 'cd /x && omp'` arrives as separate words): when the argv form shows no
  // agent, parse the joined text, which splits the script back into statements.
  let parsed = parseCommand(argv, { host, site });
  let launch = parsed.targets.find(target => target.type === "agent" && target.op === "launch");
  if (!launch) {
    parsed = parseCommand(argv.join(" "), { host, site });
    launch = parsed.targets.find(target => target.type === "agent" && target.op === "launch");
  }
  if (!launch) return null;
  const pod = parsed.targets.find(target => target.type === "pod"), remoteHost = parsed.targets.find(target => target.type === "host");
  if (kind === "kubectl" ? !pod : !remoteHost) return null;
  const remote = {};
  const siteName = pod?.site ?? remoteHost?.site ?? launch.site;
  if (siteName) remote.site = siteName;
  if (pod) remote.pod = pod.name ?? launch.pod;
  if (remoteHost?.host) remote.host = remoteHost.host;
  return { kind, launches: launch.kind, remote };
}

/** Process env text (NUL separated pairs, or `NAME=value` words) → the variables the fleet reads. */
export function envFacts(read) {
  const facts = {};
  for (const name of WANTED_ENV) {
    const value = read(name);
    if (typeof value === "string" && value !== "") facts[name] = value;
  }
  return facts;
}
const envFromNul = text => { const map = new Map(); for (const pair of text.split("\0")) { const eq = pair.indexOf("="); if (eq > 0) map.set(pair.slice(0, eq), pair.slice(eq + 1)); } return envFacts(name => map.get(name)); };
const envFromWords = text => envFacts(name => new RegExp(`(?:^|\\s)${name}=(\\S+)`).exec(text)?.[1]);

/** AGENT_FLEET_VIA=dsh:<id> */
export function parseVia(value) {
  const match = /^dsh:(.+)$/.exec(value ?? "");
  return match ? { kind: "dsh", id: match[1] } : null;
}

/** AGENT_FLEET_PARENT: `<kind>:<id>` or a full agent key `<host>#<kind>:<id>`. */
export function parseParentRef(value) {
  if (typeof value !== "string") return null;
  const hash = value.indexOf("#");
  const body = hash > 0 ? value.slice(hash + 1) : value;
  const colon = body.indexOf(":");
  const kind = colon > 0 ? body.slice(0, colon) : "", id = colon > 0 ? body.slice(colon + 1) : "";
  if (!SESSION_KINDS.includes(kind) || id === "") return null;
  return { kind, id, ...(hash > 0 && { key: value }) };
}

// ------------------------------------------------------------------------------------------------ system access

const run = (command, args) => new Promise(resolve => {
  execFile(command, args, EXEC_OPTIONS, (error, stdout) => resolve({ ok: !error, code: error?.code, stdout: stdout ?? "" }));
});

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;

/** `ps -axww -o pid=,ppid=,lstart=,command=` output → [{pid, ppid, startedAt, cmd}] */
export function parsePsOutput(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const match = PS_LINE.exec(line);
    if (!match) continue;
    const startedAt = Date.parse(match[3]);
    if (Number.isNaN(startedAt)) continue;
    out.push({ pid: Number(match[1]), ppid: Number(match[2]), startedAt, cmd: match[4].trimEnd() });
  }
  return out;
}

/** `lsof -Fpftn` output → Map pid → {cwd?, files: string[]} (only transcripts and session locks are kept). */
export function parseLsof(text) {
  const out = new Map();
  let current = null, fd = "", type = "";
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const tag = line[0], value = line.slice(1);
    if (tag === "p") { current = { files: [] }; out.set(Number(value), current); fd = ""; type = ""; }
    else if (current === null) continue;
    else if (tag === "f") { fd = value; type = ""; }
    else if (tag === "t") type = value;
    else if (tag === "n") {
      if (fd === "cwd") current.cwd = value;
      else if (type === "REG" && TRANSCRIPT_FILE.test(value)) current.files.push(value);
    }
  }
  return out;
}

/** `ps -E -ww -o pid=,command= -p …` output → Map pid → env facts. A record starts at a line beginning with a requested pid. */
export function parsePsEnv(text, pids) {
  const wanted = new Set(pids), records = new Map();
  let current = null;
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+) (.*)$/.exec(line);
    if (match && wanted.has(Number(match[1])) && !records.has(Number(match[1]))) { current = { text: match[2] }; records.set(Number(match[1]), current); }
    else if (current) current.text += `\n${line}`;
  }
  return new Map([...records].map(([pid, record]) => [pid, envFromWords(record.text)]));
}

function macSys() {
  return {
    async list() {
      const result = await run("ps", ["-axww", "-o", "pid=,ppid=,lstart=,command="]);
      if (!result.ok && result.stdout === "") throw new Error(`ps failed (${result.code})`);
      return parsePsOutput(result.stdout).map(proc => ({ ...proc, argv: splitCommand(proc.cmd) }));
    },
    async details(pids) {
      const result = await run("lsof", ["-nP", "-a", "-p", pids.join(","), "-d", "cwd,3-2000", "-Fpftn"]);
      return parseLsof(result.stdout); // lsof exits 1 when some pid vanished; the rest is still valid
    },
    async env(pids) {
      const result = await run("ps", ["-E", "-ww", "-o", "pid=,command=", "-p", pids.join(",")]);
      return parsePsEnv(result.stdout, pids);
    },
    locks: null,
  };
}

const CLK_TCK = 100;
const LOCK_LINE = /^\d+:\s+(?:FLOCK|POSIX|OFDLCK)\s+\S+\s+\S+\s+(-?\d+)\s+([0-9a-f]+):([0-9a-f]+):(\d+)\s/;

/** /proc/locks → Map "<major>:<minor>:<inode>" → holder pid (host pid namespace of the reader). */
export function parseProcLocks(text) {
  const out = new Map();
  for (const line of text.split("\n")) {
    if (line.includes("->")) continue; // a waiter, not a holder
    const match = LOCK_LINE.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid > 0) out.set(`${parseInt(match[2], 16)}:${parseInt(match[3], 16)}:${match[4]}`, pid);
  }
  return out;
}

/** `<major>:<minor>:<inode>` of a file as /proc/locks prints it (Linux dev_t encoding). */
export function lockKeyOfStat(info) {
  const dev = BigInt(info.dev);
  const major = Number(((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n));
  const minor = Number((dev & 0xffn) | ((dev >> 12n) & 0xffffff00n));
  return `${major}:${minor}:${info.ino}`;
}

function linuxSys({ procRoot = "/proc", now = Date.now } = {}) {
  const cache = new Map(); // pid → {startTicks, ppid, argv, checkedAt}
  let bootMs = null;
  const ttlMs = 10_000;

  async function boot() {
    if (bootMs === null) bootMs = Number(/^btime\s+(\d+)/m.exec(await readFile(`${procRoot}/stat`, "utf8"))?.[1] ?? 0) * 1000;
    return bootMs;
  }

  async function readOne(pid, previous) {
    let stat;
    try { stat = await readFile(`${procRoot}/${pid}/stat`, "utf8"); } catch { return null; }
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const fields = stat.slice(close + 2).split(" ");
    const ppid = Number(fields[1]), startTicks = Number(fields[19]);
    if (!Number.isFinite(ppid) || !Number.isFinite(startTicks)) return null;
    let argv = previous && previous.startTicks === startTicks ? previous.argv : null;
    if (argv === null) {
      try { argv = (await readFile(`${procRoot}/${pid}/cmdline`, "utf8")).split("\0").filter((part, index, all) => part !== "" || index < all.length - 1); } catch { return null; }
      if (argv.length > 0 && argv.at(-1) === "") argv.pop();
    }
    return { startTicks, ppid, argv, checkedAt: now() };
  }

  return {
    async list() {
      const base = await boot();
      const names = (await readdir(procRoot)).filter(name => /^\d+$/.test(name));
      const t = now(), alive = new Set();
      await mapLimit(names, 32, async name => {
        const pid = Number(name), previous = cache.get(pid);
        alive.add(pid);
        if (previous && t - previous.checkedAt < ttlMs) return;
        const fresh = await readOne(pid, previous);
        if (fresh) cache.set(pid, fresh); else { cache.delete(pid); alive.delete(pid); }
      });
      for (const pid of [...cache.keys()]) if (!alive.has(pid)) cache.delete(pid);
      return [...alive].map(pid => {
        const entry = cache.get(pid);
        return { pid, ppid: entry.ppid, startedAt: base + Math.round((entry.startTicks * 1000) / CLK_TCK), argv: entry.argv, cmd: entry.argv.join(" ") };
      });
    },
    async details(pids) {
      const out = new Map();
      await mapLimit(pids, 8, async pid => {
        const detail = { files: [] };
        try { detail.cwd = await readlink(`${procRoot}/${pid}/cwd`); } catch { /* not ours / gone */ }
        try {
          const fds = await readdir(`${procRoot}/${pid}/fd`);
          await mapLimit(fds.slice(0, 8192), 32, async fd => {
            let target;
            try { target = await readlink(`${procRoot}/${pid}/fd/${fd}`); } catch { return; }
            if (target.endsWith(" (deleted)")) return;
            if (TRANSCRIPT_FILE.test(target)) detail.files.push(target);
          });
        } catch { /* fd directory unreadable: another user's process */ }
        out.set(pid, detail);
      });
      return out;
    },
    async env(pids) {
      const out = new Map();
      await mapLimit(pids, 8, async pid => {
        try { out.set(pid, envFromNul(await readFile(`${procRoot}/${pid}/environ`, "utf8"))); } catch { out.set(pid, {}); }
      });
      return out;
    },
    async locks() {
      try { return parseProcLocks(await readFile(`${procRoot}/locks`, "utf8")); } catch { return new Map(); }
    },
  };
}

// ----------------------------------------------------------------------------------------------------- scanning

/**
 * @param {object} [options]
 * @param {"darwin"|"linux"|string} [options.platform]
 * @param {object} [options.sys]  {list, details, env, locks?}: replaceable for tests
 * @param {{detailMs?: number}} [options.intervals]
 */
export function createProcs({ platform = process.platform, sys, now = Date.now, intervals = {}, host, site, log = () => {} } = {}) {
  const backend = sys ?? (platform === "darwin" ? macSys() : platform === "linux" ? linuxSys({ now }) : null);
  const supported = backend !== null;
  const detailMs = intervals.detailMs ?? (platform === "darwin" ? 10_000 : 4_000);
  const known = new Map(); // "pid:startedAt" → classification + detail + env state
  const lockKeys = new Map(); // directory → {key, at}
  let scanning = false, failure = "";

  const infoOf = raw => {
    const id = `${raw.pid}:${raw.startedAt}`;
    let info = known.get(id);
    if (info === undefined) {
      let kind = null, extra = {};
      try {
        const found = classifyCommand(raw.argv, { cmd: raw.cmd, host, site });
        if (found) { kind = found.kind; extra = found; }
      } catch (error) { log(`cannot classify pid ${raw.pid}: ${error.message}`); }
      info = { id, pid: raw.pid, startedAt: raw.startedAt, cmd: raw.cmd, argv: raw.argv, kind, server: extra.server === true, launches: extra.launches, remote: extra.remote, cwd: undefined, files: [], detailAt: 0, env: null };
      known.set(id, info);
    }
    info.ppid = raw.ppid;
    return info;
  };

  async function scan() {
    if (!supported || backend === null) return { ok: false, at: now(), procs: [], table: new Map(), locks: null };
    if (scanning) return null;
    scanning = true;
    try {
      const t = now();
      let listing;
      try { listing = await backend.list(); } catch (error) {
        if (failure !== error.message) { failure = error.message; log(`process listing failed: ${error.message}`); }
        return { ok: false, at: t, procs: [], table: new Map(), locks: null };
      }
      failure = "";
      const table = new Map(), live = new Set(), interesting = [];
      for (const raw of listing) {
        const info = infoOf(raw);
        table.set(info.pid, info);
        live.add(info.id);
        if (info.kind !== null) interesting.push(info);
      }
      for (const id of [...known.keys()]) if (!live.has(id)) known.delete(id);

      const needDetail = interesting.filter(info => info.kind !== "kubectl" && info.kind !== "ssh" && t - info.detailAt >= detailMs);
      if (needDetail.length > 0) {
        try {
          const details = await backend.details(needDetail.map(info => info.pid));
          for (const info of needDetail) {
            info.detailAt = t;
            const detail = details.get(info.pid);
            if (detail) { if (detail.cwd !== undefined) info.cwd = detail.cwd; info.files = detail.files ?? []; }
          }
        } catch (error) { log(`process details failed: ${error.message}`); for (const info of needDetail) info.detailAt = t; }
      }
      const needEnv = interesting.filter(info => info.env === null);
      if (needEnv.length > 0) {
        try {
          const envs = await backend.env(needEnv.map(info => info.pid));
          for (const info of needEnv) info.env = envs.get(info.pid) ?? {};
        } catch (error) { log(`process environment failed: ${error.message}`); for (const info of needEnv) info.env = {}; }
      }
      let locks = null;
      if (backend.locks) { try { locks = await backend.locks(); } catch (error) { log(`/proc/locks failed: ${error.message}`); } }
      return { ok: true, at: t, procs: interesting, table, locks };
    } finally { scanning = false; }
  }

  /** `<major>:<minor>:<inode>` of `<dir>/session.lock` (cached; null when the file does not exist). */
  async function lockKeyOf(dir) {
    const hit = lockKeys.get(dir), t = now();
    if (hit && (hit.key !== null || t - hit.at < 10_000)) return hit.key;
    let key = null;
    try { key = lockKeyOfStat(await stat(`${dir}/session.lock`, { bigint: true })); } catch { /* no lock file */ }
    lockKeys.set(dir, { key, at: t });
    return key;
  }

  return { scan, lockKeyOf, supported };
}

// -------------------------------------------------------------------------------------------------------- binding

function flagValue(argv, names) {
  for (let i = 0; i < argv.length; i += 1) {
    for (const name of names) {
      if (argv[i] === name) { const value = argv[i + 1]; return value && !value.startsWith("-") ? value : null; }
      if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1) || null;
    }
  }
  return null;
}

/** The session a process names on its command line: a transcript path or an id (prefix). */
export function explicitSession(kind, argv) {
  if (kind === "omp") return flagValue(argv, ["--session", "--resume", "-r", "--restore"]);
  if (kind === "claude") return flagValue(argv, ["--session-id", "--resume", "-r"]);
  if (kind === "codex") {
    const index = argv.findIndex(arg => arg === "resume" || arg === "fork");
    const value = index >= 0 ? argv[index + 1] : null;
    return value && !value.startsWith("-") ? value : null;
  }
  return null;
}

/**
 * @typedef {object} SessionView  What binding needs to know about a tracked transcript.
 * @property {string} key  @property {string} kind  @property {string} id  @property {string} role
 * @property {string} file  @property {string} [realFile]  @property {string} [cwd]
 * @property {number} startedAt  @property {number} updatedAt  @property {string|null} [parentKey]
 * @property {string|null} [lockKey]  DSH: "<major>:<minor>:<inode>" of the session's session.lock
 * @property {boolean} [turnOpen]
 */

const samePath = (a, b) => typeof a === "string" && typeof b === "string" && a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

/**
 * Link of a process to the session that launched it, from its environment and its ancestors.
 * @returns {{parentSession?: object, parent?: string, via?: object, parentCall?: string}}
 */
function launchLinks(info, table) {
  const env = info.env ?? {};
  const out = {};
  let ancestor = null, pid = info.ppid;
  for (let hops = 0; hops < MAX_ANCESTORS && pid > 1; hops += 1) {
    const candidate = table.get(pid);
    if (!candidate) break;
    if (SESSION_KINDS.includes(candidate.kind)) { ancestor = candidate; break; }
    pid = candidate.ppid;
  }
  // DSH only lets DSH_-prefixed variables reach the shells its model runs. They stay in the environment of agents
  // started from such a shell, where they name an outer call; trust them only while the nearest agent above the
  // process is itself a DSH session (or the chain left the table, e.g. a detached one-shot run).
  const dshOwned = ancestor === null || ancestor.kind === "dsh";
  const raw = env[ENV_PARENT] ?? env[`LC_${ENV_PARENT}`] ?? (dshOwned ? env[ENV_DSH_PARENT] : undefined);
  if (raw) out.parent = raw;
  const call = env[ENV_TOOL_CALL] ?? env[ENV_PARENT_CALL] ?? (dshOwned ? env[ENV_DSH_PARENT_CALL] : undefined);
  if (call) out.parentCall = call;
  const via = parseVia(env[ENV_VIA]);
  if (via && (ancestor === null || ancestor.kind === "dsh")) { out.via = via; return out; }
  if (ancestor !== null) {
    const id = env[SESSION_VAR[ancestor.kind]];
    if (id) out.parentSession = { kind: ancestor.kind, id, via: "env", exact: true };
  }
  return out;
}

function nearestReported(info, table) {
  let pid = info.ppid;
  for (let hops = 0; hops < MAX_ANCESTORS && pid > 1; hops += 1) {
    const candidate = table.get(pid);
    if (!candidate) return info.ppid;
    if (candidate.kind !== null) return candidate.pid;
    pid = candidate.ppid;
  }
  return info.ppid;
}

/**
 * Parent hint a process gives the session it runs: the DSH session that launched it over ACP, the agent session
 * whose shell started it, or AGENT_FLEET_PARENT.
 */
export function hintFromLinks(links) {
  if (links.via) return { kind: "dsh", id: links.via.id, via: "acp", exact: true };
  if (links.parentSession) return { ...links.parentSession, ...(links.parentCall && { toolCallId: links.parentCall }) };
  const ref = parseParentRef(links.parent);
  return ref ? { ...ref, via: "env", exact: true, ...(links.parentCall && { toolCallId: links.parentCall }) } : null;
}

/**
 * Match processes to sessions.
 * @param {SessionView[]} views
 * @param {{ok: boolean, procs: object[], table: Map<number, object>, locks: Map<string, number>|null}} scan
 * @returns {{procs: object[], bindings: Map<string, {pid: number, how: string, hint: object|null}>, adopt: {paths: string[], ids: {kind: string, id: string}[]}}}
 */
export function bindProcs(views, scan) {
  const bindings = new Map(), adoptPaths = new Set(), adoptIds = new Map();
  const claimed = new Map(); // pid → views bound to it
  const byFile = new Map(), byDir = new Map(), byId = new Map(), byLock = new Map();
  for (const view of views) {
    byFile.set(view.file, view);
    if (view.realFile) byFile.set(view.realFile, view);
    byId.set(`${view.kind}:${view.id}`, view);
    if (view.kind === "dsh") {
      byDir.set(dirname(view.file), view);
      if (view.realFile) byDir.set(dirname(view.realFile), view);
      if (view.lockKey) byLock.set(view.lockKey, view);
    }
  }
  const links = new Map(scan.procs.map(info => [info.pid, launchLinks(info, scan.table)]));

  const claim = (view, pid, how) => {
    if (!view || bindings.has(view.key)) return false;
    bindings.set(view.key, { pid, how, hint: null });
    if (!claimed.has(pid)) claimed.set(pid, []);
    claimed.get(pid).push(view);
    return true;
  };

  const sessionProcs = scan.procs.filter(info => info.kind !== null && info.kind !== "kubectl" && info.kind !== "ssh");

  // 1. what the command line names
  for (const info of sessionProcs) {
    if (info.kind === "acp-bridge" || info.kind === "dsh") continue;
    const value = explicitSession(info.kind, info.argv);
    if (!value) continue;
    let view = value.includes("/") ? byFile.get(value) : byId.get(`${info.kind}:${value}`);
    if (!view && !value.includes("/") && value.length >= 8 && /^[0-9a-f-]+$/i.test(value)) view = views.find(candidate => candidate.kind === info.kind && candidate.id.startsWith(value));
    if (view) claim(view, info.pid, "arg");
    else if (value.includes("/")) adoptPaths.add(value);
    else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) adoptIds.set(`${info.kind}:${value}`, { kind: info.kind, id: value });
  }

  // 2. transcripts and session locks a process holds open. Servers (codex app-server, the DSH host) keep many old
  //    sessions resident: those match when tracked but are not pulled in just because they are open.
  for (const info of sessionProcs) {
    const resident = info.server === true || info.kind === "dsh";
    for (const file of info.files) {
      const isLock = file.endsWith("/session.lock");
      const view = isLock ? byDir.get(dirname(file)) : byFile.get(file);
      if (view) claim(view, info.pid, "fd");
      else if (!resident) adoptPaths.add(isLock ? `${dirname(file)}/session.v4.jsonl.zstd` : file);
    }
  }

  // 3. Linux: a DSH session whose session.lock is flocked by a live process
  if (scan.locks) for (const [key, view] of byLock) { const pid = scan.locks.get(key); if (pid) claim(view, pid, "lock"); }

  // 4. cwd + start time, nearest first, for processes that still own nothing
  const pairs = [];
  for (const info of sessionProcs) {
    if (!["omp", "claude", "codex"].includes(info.kind) || info.server || claimed.has(info.pid) || !info.cwd) continue;
    for (const view of views) {
      if (view.kind !== info.kind || bindings.has(view.key) || view.role === "subagent" || view.role === "projection" || !samePath(view.cwd, info.cwd)) continue;
      const gap = Math.abs(view.startedAt - info.startedAt);
      if (gap <= FALLBACK_WINDOW_MS) pairs.push({ gap, info, view });
    }
  }
  pairs.sort((a, b) => a.gap - b.gap || b.view.updatedAt - a.view.updatedAt);
  for (const { info, view } of pairs) if (!claimed.has(info.pid) && !bindings.has(view.key)) claim(view, info.pid, "cwd");

  // 5. subagents and projections live in their parent's process while they work
  const byKey = new Map(views.map(view => [view.key, view]));
  for (const view of views) {
    if (bindings.has(view.key) || !view.parentKey || !view.turnOpen) continue;
    let parent = byKey.get(view.parentKey);
    for (let hops = 0; parent && hops < 8; hops += 1) {
      const binding = bindings.get(parent.key);
      if (binding) { bindings.set(view.key, { pid: binding.pid, how: "parent", hint: null }); break; }
      parent = parent.parentKey ? byKey.get(parent.parentKey) : null;
    }
  }

  // process-level parent hints go to the session a process runs alone (not to subagents or hosted threads)
  for (const [pid, owned] of claimed) {
    const tops = owned.filter(view => view.role === "main" || view.role === "fork" || view.role === "side");
    if (tops.length !== 1) continue;
    const hint = hintFromLinks(links.get(pid) ?? {});
    if (hint) bindings.get(tops[0].key).hint = hint;
  }

  // reported processes
  const procs = [];
  for (const info of scan.procs) {
    const owned = claimed.get(info.pid) ?? [];
    const tops = owned.filter(view => view.role === "main" || view.role === "fork" || view.role === "side");
    const primary = tops.length === 1 ? tops[0] : owned.length === 1 ? owned[0] : undefined; // a server has no single agent
    const link = links.get(info.pid) ?? {};
    procs.push({
      pid: info.pid, ppid: nearestReported(info, scan.table), kind: info.kind, startedAt: info.startedAt,
      ...(info.cwd && { cwd: info.cwd }),
      cmd: redactText(info.cmd, LIMITS.cmdChars),
      ...(primary && { agent: primary.key }),
      ...(link.parent && { parent: redactText(link.parent, 200) }),
      ...(link.parentSession && { parentSession: link.parentSession }),
      ...(link.parentCall && { parentCall: redactText(link.parentCall, 120) }),
      ...(link.via && { via: link.via }),
      ...(info.remote && { remote: info.remote }),
      ...(info.launches && { launches: info.launches }),
    });
  }
  procs.sort((a, b) => a.pid - b.pid);
  return { procs, bindings, adopt: { paths: [...adoptPaths], ids: [...adoptIds.values()] } };
}

/**
 * Liveness overlay on a reader's record: `live.alive` / `live.pid`, `done` → `idle` for a resident session, and
 * `stale` for an open turn whose process is gone and that has been quiet for 5 minutes.
 * @param {object} record  AgentRecord from the reader (not modified)
 * @param {{alive: boolean|null, pid?: number}} state
 * @param {{now: number, mtimeMs?: number}} clock
 */
export function applyLiveness(record, state, { now, mtimeMs = 0 }) {
  const live = { ...record.live, alive: state.alive, ...(state.pid && { pid: state.pid }) };
  if (!state.pid) delete live.pid;
  let status = record.status;
  const open = status === "running" || status === "waiting";
  if (state.alive === true && status === "done" && record.role !== "subagent" && record.role !== "projection") status = "idle";
  if (state.alive === false && open && now - Math.max(record.updatedAt ?? 0, mtimeMs) >= STALE_QUIET_MS) {
    status = "stale";
    live.state = "ended";
    live.doing = "";
  }
  return { ...record, status, live };
}
