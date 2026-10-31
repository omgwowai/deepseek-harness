#!/usr/bin/env node
// Writes the Agent Fleet row into a DSH profile's cordis.patch.yml.
//
//   node configure.mjs --profile desktop|web [--mode embedded|remote] [--hub-url URL] [--token-file PATH]
//                      [--ssh-target USER@HOST] [--panel-url URL] [--dry-run]
//
//   web      (server, DSH Web)   node configure.mjs --profile web --mode remote
//   desktop  (Mac, DSH desktop)  node configure.mjs --profile desktop --mode embedded --ssh-target bochao_li@10.0.60.98
//
// Only the `dsh-agent-fleet` row is touched (flags set just the keys they name; other keys of an existing row and every
// other row stay byte for byte as they were). The previous file is copied to cordis.patch.yml.bak-<time> first, the new
// one is written atomically with the old file's permissions (0600 for a new file), and nothing is written when nothing
// changed. Honours DSH_HOME. The file holds secrets of other rows: its contents are never printed.
import { chmodSync, copyFileSync, existsSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { resolveConfig } from "./lib/plugin/config.mjs";
import { PatchError, ROW_ID, upsertFleetRow } from "./lib/plugin/patch-file.mjs";

const FLAGS = { "--profile": "profile", "--mode": "mode", "--hub-url": "hubUrl", "--token-file": "tokenFile", "--ssh-target": "sshTarget", "--panel-url": "panelUrl" };
const USAGE = "usage: node configure.mjs --profile desktop|web [--mode embedded|remote] [--hub-url URL] [--token-file PATH] [--ssh-target USER@HOST] [--panel-url URL] [--dry-run]";

function parse(argv) {
  const options = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const [name, inline] = argv[i].split(/=(.*)/s, 2);
    if (name === "--dry-run") { options.dryRun = true; continue; }
    if (name === "--help" || name === "-h") { options.help = true; continue; }
    const key = FLAGS[name];
    if (key === undefined) throw new Error(`unknown argument ${argv[i]}\n${USAGE}`);
    const value = inline ?? argv[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value\n${USAGE}`);
    options[key] = value.trim();
  }
  return options;
}

function backupPath(target) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let path = `${target}.bak-${stamp}`;
  for (let n = 1; existsSync(path); n += 1) path = `${target}.bak-${stamp}-${n}`;
  return path;
}

function main(argv) {
  const options = parse(argv);
  if (options.help) { console.log(USAGE); return; }
  if (!["desktop", "web"].includes(options.profile)) throw new Error(`--profile desktop|web is required\n${USAGE}`);
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  const profileDir = join(home, "profiles", options.profile);
  if (!existsSync(profileDir)) throw new Error(`${profileDir} not found: start DSH once with this profile first (or set DSH_HOME)`);
  const file = join(profileDir, "cordis.patch.yml");
  const exists = existsSync(file);
  const target = exists ? realpathSync(file) : file;
  const text = exists ? readFileSync(target, "utf8") : "";
  const change = Object.fromEntries(["mode", "hubUrl", "tokenFile", "sshTarget", "panelUrl"].filter(key => options[key] !== undefined).map(key => [key, options[key]]));

  const result = upsertFleetRow(text, { change, defaultMode: options.profile === "desktop" ? "embedded" : "remote" });
  resolveConfig(result.row.config);   // refuse values the plugin itself would refuse at load, before anything is written
  const { mode, upstream } = result.row.config;
  const sshTarget = upstream?.sshTarget;
  const summary = `${options.profile} profile, mode ${mode ?? "remote"}${result.row.disabled ? ", row is disabled" : ""}`;

  if (options.dryRun) {
    console.log(`dry run: would ${result.action === "unchanged" ? "leave unchanged" : result.action === "added" ? "add" : "update"} the ${ROW_ID} row in ${file} (${summary})`);
    console.log(JSON.stringify(result.row, null, 2));
    return;
  }
  if (result.action === "unchanged") { console.log(`${ROW_ID} row in ${file} is already up to date (${summary}); nothing written`); return; }

  const mode0 = exists ? statSync(target).mode & 0o777 : 0o600;
  let backup = null;
  if (exists) { backup = backupPath(target); copyFileSync(target, backup); chmodSync(backup, mode0); }
  const temp = join(dirname(target), `.${basename(target)}.tmp-${process.pid}`);
  try {
    writeFileSync(temp, result.text, { mode: mode0 });
    chmodSync(temp, mode0);
    renameSync(temp, target);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* never created */ }
    throw error;
  }
  console.log(`${result.action === "added" ? "added" : "updated"} the ${ROW_ID} row in ${file} (${summary})${backup ? `; previous file saved as ${backup}` : ""}`);
  console.log(`row config: ${JSON.stringify(result.row.config)}`);
  if ((mode ?? "remote") === "embedded") {
    if (sshTarget === undefined) console.log("note: no --ssh-target, so the desktop hub shows only this machine and does not follow or push to the server hub");
    else console.log(`note: the desktop hub reaches ${sshTarget} with ssh (BatchMode: the key must work without a prompt); put the server hub's token (its ~/.config/agent-fleet/token) in ${upstream.tokenFile ?? "~/.config/agent-fleet/upstream-token"}`);
  }
  console.log(`restart DSH (${options.profile} profile) to load the change; the profile's HMR may pick it up without a restart`);
}

try { main(process.argv.slice(2)); }
catch (error) {
  console.error(error instanceof PatchError ? `cannot edit the profile patch: ${error.message}` : `error: ${error.message}`);
  process.exitCode = 1;
}
