import { chmod, cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

// Writes the ACP agent routes (@local/dsh-acp-adapter) and this plugin's config into a DSH profile patch.
//   node configure.mjs [--desktop] [--scratch] [--panel-token-file <path>] [--panel-url <url>]
// The agents' launch commands and TokenRouter env come from the Paseo providers claude-tr / codex-tr / omp-tr
// (~/.paseo/config.json, read only). The Agent DAG tab embeds the Paseo `agent-dag` panel; its token file is
// `<paseo-agent-dag>/plugins/agent-dag/.cache/web/token` (or $AGENT_DAG_TOKEN_FILE).
const plugin = dirname(fileURLToPath(import.meta.url));
const flag = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const scratch = process.argv.includes("--scratch");
if (scratch && !process.env.DSH_HOME) throw new Error("--scratch 需要显式设置 DSH_HOME（隔离的 DSH home）");
const home = process.env.DSH_HOME || join(homedir(), ".dsh");
const profileName = process.argv.includes("--desktop") ? "desktop" : "web";
const profile = join(home, "profiles", profileName), file = join(profile, "cordis.patch.yml");
const providers = JSON.parse(await readFile(join(homedir(), ".paseo/config.json"), "utf8")).agents.providers;
for (const id of ["claude-tr", "codex-tr", "omp-tr"]) if (!providers[id]) throw new Error(`Paseo provider ${id} 不存在`);
// Everything is validated before the first write: a missing input must leave the profile untouched.
const patch = parse(await readFile(file, "utf8"));
if (!Array.isArray(patch)) throw new Error("profile patch 必须为 YAML 数组");
const previous = patch.find(entry => entry.id === "dsh-agent-dag")?.config ?? {};
const tokenFile = flag("--panel-token-file") ?? process.env.AGENT_DAG_TOKEN_FILE ?? previous.tokenFile;
if (!tokenFile) throw new Error("缺少 Agent DAG 面板 token 文件：传 --panel-token-file 或设置 AGENT_DAG_TOKEN_FILE");
const panelUrl = flag("--panel-url") ?? process.env.AGENT_DAG_URL ?? previous.panelUrl ?? "http://127.0.0.1:6795/";
const backup = join(home, "backups", `${profileName}-${scratch ? "scratch" : "real"}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
await mkdir(dirname(backup), { recursive: true });
await cp(profile, backup, { recursive: true });
const manifestFile = join(profile, "package.json"), manifest = JSON.parse(await readFile(manifestFile, "utf8"));
const bundles = manifest.dsh?.profile?.bundles;
if (!Array.isArray(bundles)) throw new Error("DSH profile bundle 列表不存在");
let changed = false;
// The fork ships as @local/dsh-acp-adapter and replaces the published @zaimokuza/dsh-acp-adapter bundle.
for (const bundle of ["@local/dsh-acp-adapter", "@local/dsh-agent-dag"]) if (!bundles.includes(bundle)) { bundles.push(bundle); changed = true; }
const upstreamAdapter = bundles.indexOf("@zaimokuza/dsh-acp-adapter");
if (upstreamAdapter >= 0) { bundles.splice(upstreamAdapter, 1); changed = true; }
if (changed) await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
// The ACP omp agent runs on the user's own Oh My Pi home (`~/.omp/agent`): the DSH omp sessions and the
// user's `omp` CLI continue the same transcripts. The Paseo home (`~/.paseo/agents/omp`) stays a second,
// root so the sessions already recorded there stay visible in DSH; a session bound to the ACP route is
// hard-linked into the real home by the importer, so continuing it still resumes that native transcript.
// Paseo's own config (`~/.paseo/config.json`) is read, never written.
const realOmpHome = join(homedir(), ".omp/agent");
const paseoOmpHome = providers["omp-tr"].env.PI_CODING_AGENT_DIR;
if (!paseoOmpHome) throw new Error("Paseo provider omp-tr 缺少 PI_CODING_AGENT_DIR");
/** Config layer copied into an isolated omp home: everything the agent needs to run, never the sessions. */
const OMP_CONFIG_LAYER = ["config.yml", "models.yml", "mcp.json", "RULES.md", "agent.db", "history.db", "models.db", "extensions", "rules", "skills", "predict"];
const isolated = join(home, "external-agents");
if (scratch) {
  await mkdir(join(isolated, "claude"), { recursive: true });
  await mkdir(join(isolated, "codex"), { recursive: true });
  // The isolated ACP home mirrors the real home's config layer; the isolated Paseo home mirrors the
  // sessions the user's Paseo omp recorded. Bench fixtures add the session files to import.
  try { await stat(join(isolated, "omp")); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(join(isolated, "omp/sessions"), { recursive: true });
    for (const item of OMP_CONFIG_LAYER) {
      try { await cp(join(realOmpHome, item), join(isolated, "omp", item), { recursive: true }); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  try { await stat(join(isolated, "omp-paseo")); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(join(isolated, "omp-paseo"), { recursive: true });
    for (const item of ["sessions", "agent-dag"]) {
      try { await cp(join(paseoOmpHome, item), join(isolated, "omp-paseo", item), { recursive: true }); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  try { await writeFile(join(isolated, "claude/settings.json"), JSON.stringify({ model: "claude-sonnet-5.5", env: providers["claude-tr"].env }, null, 2), { mode: 0o600, flag: "wx" }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  try { await writeFile(join(isolated, "codex/config.toml"), 'model = "gpt-6-astra"\nmodel_reasoning_effort = "low"\n', { mode: 0o600, flag: "wx" }); } catch (error) { if (error.code !== "EEXIST") throw error; }
}
const ompHome = scratch ? join(isolated, "omp") : realOmpHome;
const ompOtherHome = scratch ? join(isolated, "omp-paseo") : paseoOmpHome;
// The agents' PATH is part of the ACP launch fingerprint stored with every binding, so it must not depend on
// the shell that ran this script: per-shell temp dirs (TMPDIR, /var/folders, /tmp) are dropped and entries are
// deduplicated, so desktop and web profiles configured from different shells get the same value.
const temporary = entry => [process.env.TMPDIR, "/var/folders/", "/private/var/folders/", "/tmp/", "/private/tmp/"].some(prefix => prefix && entry.startsWith(prefix));
const path = [...new Set([dirname(process.execPath), dirname(providers["claude-tr"].command[0]), dirname(providers["codex-tr"].command[0]), dirname(providers["omp-tr"].command[0]), ...(process.env.PATH ?? "").split(":")])]
  .filter(entry => entry && !temporary(entry)).join(":");
const claudeEnv = { ...providers["claude-tr"].env, PATH: path, CLAUDE_CODE_EXECUTABLE: join(plugin, "claude-launch.mjs"), DSH_CLAUDE_EXECUTABLE: providers["claude-tr"].command[0], ...(scratch ? { CLAUDE_CONFIG_DIR: join(isolated, "claude"), XDG_CACHE_HOME: join(isolated, "cache") } : {}) };
const codexEnv = { ...providers["codex-tr"].env, PATH: path, CODEX_PATH: join(plugin, "codex-launch.mjs"), DSH_CODEX_COMMAND: JSON.stringify(providers["codex-tr"].command), MODEL_PROVIDER: "codex-tr", ...(scratch ? { CODEX_HOME: join(isolated, "codex"), XDG_CACHE_HOME: join(isolated, "cache"), APP_SERVER_LOGS: join(isolated, "codex/logs") } : {}) };
const ompEnv = { ...providers["omp-tr"].env, PI_CODING_AGENT_DIR: ompHome, PATH: path, ...(scratch ? { XDG_CACHE_HOME: join(isolated, "cache") } : {}) };
const agents = {
  claude: { name: "Claude Code (TokenRouter)", runtime: "claude", command: process.execPath, args: [join(plugin, "node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js")], env: claudeEnv },
  codex: { name: "Codex (TokenRouter)", runtime: "codex", command: process.execPath, args: [join(plugin, "node_modules/@agentclientprotocol/codex-acp/dist/index.js")], env: codexEnv },
  // omp-link-headers.js puts a DSH branch's lineage (DSH_ACP_LINK_HEADERS, set by the adapter) on omp's requests.
  omp: { name: "Oh My Pi (TokenRouter)", command: providers["omp-tr"].command[0], args: ["acp", "-e", join(plugin, "omp-link-headers.js")], env: ompEnv }
};
const codexHome = codexEnv.CODEX_HOME || join(homedir(), ".codex");
const externalRoots = { claude: [join(claudeEnv.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects")], codex: [join(codexHome, "sessions"), join(codexHome, "archived_sessions")], omp: [join(ompHome, "sessions"), join(ompOtherHome, "sessions")] };
// The native homes the ACP agents above actually read: a session imported from another home can only carry its history.
const nativeHomes = { claude: claudeEnv.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), codex: codexHome, omp: ompHome };
function upsert(id, config) { const entry = patch.find(entry => entry.id === id); if (entry) { entry.disabled = false; entry.config = { ...entry.config, ...config }; } else patch.push({ id, disabled: false, config }); }
upsert("dsh-acp-adapter", { agents, toolApprovalDefault: "ask" });
upsert("dsh-agent-dag", { tokenFile: resolve(tokenFile), panelUrl, externalRoots, nativeHomes });
await writeFile(file, JSON.stringify(patch, null, 2) + "\n", { mode: 0o600 });
await chmod(file, 0o600);
console.log(`Configured ${profile}; backup ${backup}; omp home ${ompHome} (second root ${join(ompOtherHome, "sessions")}); restart DSH to load plugins (running desktop untouched).`);