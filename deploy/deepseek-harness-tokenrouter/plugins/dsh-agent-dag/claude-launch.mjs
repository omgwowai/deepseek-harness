#!/usr/bin/env node
// Claude Code executable for the DSH ACP route (CLAUDE_CODE_EXECUTABLE, see configure.mjs); runs the real
// CLI named by DSH_CLAUDE_EXECUTABLE.
// A DSH branch of an ACP-bound session hands its lineage over as DSH_ACP_LINK_HEADERS (JSON). Claude Code
// applies settings-file env after its process env, and the user's settings.json may set its own
// ANTHROPIC_CUSTOM_HEADERS (the TokenRouter plugin marker), so the headers go into the flag settings tier
// (`--settings`), which outranks user settings, appended to the headers the user's settings already send.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const executable = process.env.DSH_CLAUDE_EXECUTABLE;
if (!executable) throw new Error("DSH_CLAUDE_EXECUTABLE is not set");
let args = process.argv.slice(2);
const links = process.env.DSH_ACP_LINK_HEADERS ? JSON.parse(process.env.DSH_ACP_LINK_HEADERS) : {};
if (Object.keys(links).length) {
  const readJson = path => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return {}; } };
  const user = readJson(join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json"));
  const index = args.indexOf("--settings");
  const given = index >= 0 ? (args[index + 1].trim().startsWith("{") ? JSON.parse(args[index + 1]) : readJson(args[index + 1])) : {};
  const base = given.env?.ANTHROPIC_CUSTOM_HEADERS ?? user.env?.ANTHROPIC_CUSTOM_HEADERS ?? process.env.ANTHROPIC_CUSTOM_HEADERS;
  const headers = [base, ...Object.entries(links).map(([name, value]) => `${name}: ${value}`)].filter(Boolean).join("\n");
  const settings = JSON.stringify({ ...given, env: { ...given.env, ANTHROPIC_CUSTOM_HEADERS: headers } });
  args = index >= 0 ? args.toSpliced(index, 2, "--settings", settings) : ["--settings", settings, ...args];
}
const child = spawn(executable, args, { stdio: "inherit", env: process.env });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1; });
