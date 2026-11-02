#!/usr/bin/env node
// Install the plugins of this directory into one DeepSeek Harness profile.
//
//   node install.mjs [--profile desktop|web] [--plugins mermaid,acp,agent-dag,fleet] [--no-telemetry] [--skill] [--dry-run]
//
// Without `--plugins` the set is mermaid,acp,agent-dag. `fleet` (Agent Fleet: live view of every DSH / Claude Code / Codex /
// Oh My Pi session, no build step) is opt-in: `--plugins fleet`, or `--plugins mermaid,acp,agent-dag,fleet` for everything.
// Its row is written by plugins/dsh-agent-fleet/configure.mjs.
//
// Each plugin is linked into the profile (`"<package>": "link:<absolute dir>"`), so editing or rebuilding
// it here is what DSH loads after a restart. The profile manifest is backed up next to itself first.
// agent-dag brings its sub-plugin along: TokenRouter session telemetry (plugins/dsh-agent-dag/telemetry,
// @tokenrouter/dsh-telemetry), which replaces a tarball install of the same package; `--no-telemetry` skips it.
// `--skill` also copies skills/mermaid-diagrams to ~/.agents/skills (never overwrites an existing copy).
// Agent routes and Agent DAG settings are written separately by plugins/dsh-agent-dag/configure.mjs.
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const flag = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const dryRun = process.argv.includes("--dry-run");
const profileName = flag("--profile") ?? "desktop";
if (!["desktop", "web"].includes(profileName)) throw new Error(`unknown profile ${profileName} (desktop | web)`);
const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
const profile = join(dshHome, "profiles", profileName);
const manifestFile = join(profile, "package.json");
if (!existsSync(manifestFile)) throw new Error(`${manifestFile} not found: start DSH once with this profile first`);

const PLUGINS = {
  mermaid: { name: "@local/dsh-mermaid-pele", dir: join(here, "plugins/dsh-mermaid-pele") },
  acp: {
    name: "@local/dsh-acp-adapter", dir: join(here, "plugins/dsh-acp-adapter"), replaces: "@zaimokuza/dsh-acp-adapter",
    ready: dir => existsSync(join(dir, "lib/index.js")),
    prepare: dir => { run("pnpm", ["install", "--frozen-lockfile"], dir); run("pnpm", ["build"], dir); },
  },
  "agent-dag": {
    name: "@local/dsh-agent-dag", dir: join(here, "plugins/dsh-agent-dag"),
    ready: dir => existsSync(join(dir, "node_modules/yaml")),
    prepare: dir => run("npm", ["ci", "--omit=dev"], dir),
    subPlugins: process.argv.includes("--no-telemetry") ? [] : [{ name: "@tokenrouter/dsh-telemetry", dir: join(here, "plugins/dsh-agent-dag/telemetry") }],
  },
  fleet: { name: "@local/dsh-agent-fleet", dir: join(here, "plugins/dsh-agent-fleet") },
};
const selected = (flag("--plugins") ?? "mermaid,acp,agent-dag").split(",").map(key => key.trim()).filter(Boolean);
for (const key of selected) if (!PLUGINS[key]) throw new Error(`unknown plugin ${key} (${Object.keys(PLUGINS).join(", ")})`);

function run(command, args, cwd) {
  console.log(`$ (cd ${cwd} && ${command} ${args.join(" ")})`);
  if (!dryRun) execFileSync(command, args, { cwd, stdio: "inherit" });
}

for (const key of selected) {
  const plugin = PLUGINS[key];
  if (plugin.prepare && !plugin.ready(plugin.dir)) plugin.prepare(plugin.dir);
}

const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
manifest.dependencies ??= {};
manifest.dsh ??= {};
manifest.dsh.profile ??= {};
const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : (manifest.dsh.profile.bundles = []);
for (const key of selected) {
  const plugin = PLUGINS[key];
  for (const unit of [plugin, ...(plugin.subPlugins ?? [])]) {
    manifest.dependencies[unit.name] = `link:${unit.dir}`;
    if (!bundles.includes(unit.name)) bundles.push(unit.name);
  }
  if (plugin.replaces) {
    const index = bundles.indexOf(plugin.replaces);
    if (index >= 0) bundles.splice(index, 1);
    delete manifest.dependencies[plugin.replaces];
  }
}
const next = JSON.stringify(manifest, null, 2) + "\n";
if (dryRun) console.log(next);
else {
  const backup = `${manifestFile}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(manifestFile, backup);
  writeFileSync(manifestFile, next);
  console.log(`profile manifest updated (backup ${backup})`);
}
run("pnpm", ["install"], profile);

if (process.argv.includes("--skill")) {
  const target = join(homedir(), ".agents/skills/mermaid-diagrams");
  if (existsSync(target)) console.log(`skill already present: ${target} (left unchanged)`);
  else if (dryRun) console.log(`would copy skills/mermaid-diagrams -> ${target}`);
  else { cpSync(join(here, "skills/mermaid-diagrams"), target, { recursive: true }); console.log(`skill installed: ${target}`); }
}
console.log(`Done. Restart DeepSeek Harness (profile ${profileName}) and reload the Web GUI once.`);
