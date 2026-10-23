#!/usr/bin/env node
import { spawn } from "node:child_process";
const command = JSON.parse(process.env.DSH_CODEX_COMMAND);
if (!Array.isArray(command) || !command.length || !command.every(value => typeof value === "string")) throw new Error("DSH_CODEX_COMMAND must be a command array");
// Codex ships with `update_plan` off; turn it on for Codex launched by DSH so its plan updates reach the
// Agent DAG plans tab. Only this launch is affected, never ~/.codex/config.toml.
const planTool = ["-c", "tools.update_plan.enabled=true"];
// A DSH branch of an ACP-bound session hands its lineage over as DSH_ACP_LINK_HEADERS (JSON); Codex sends
// them on its own model requests by adding them to the inline provider's `http_headers` table.
const links = process.env.DSH_ACP_LINK_HEADERS ? JSON.parse(process.env.DSH_ACP_LINK_HEADERS) : {};
const entries = Object.entries(links).map(([name, value]) => `${JSON.stringify(name)} = ${JSON.stringify(String(value))}`).join(", ");
const args = entries === "" ? command.slice(1) : command.slice(1).map(arg => {
  if (!/^model_providers\.[^=]+=\{/.test(arg)) return arg;
  return /http_headers = \{/.test(arg) ? arg.replace(/http_headers = \{ ?/, `http_headers = { ${entries}, `) : arg.replace(/\}\s*$/, `, http_headers = { ${entries} } }`);
});
const child = spawn(command[0], [...args, ...planTool, ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1; });
