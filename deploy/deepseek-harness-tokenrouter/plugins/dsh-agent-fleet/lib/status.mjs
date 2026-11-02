// `agent-fleet status --url http://127.0.0.1:7840 [--token-file PATH] [--json]`: the hub's /api/health and its hosts.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const USAGE = `usage: agent-fleet status [--url http://127.0.0.1:7840[/fleet]] [--token-file PATH] [--json]
  the full /api/health body and the host list need the token (default: ~/.config/agent-fleet/token or $AGENT_FLEET_TOKEN);
  without it the hub answers liveness only: {"ok":true,"version":…}
`;

const ago = ms => (ms === undefined || ms === null ? "-" : ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`);

function parseArgs(argv) {
  const options = { url: "http://127.0.0.1:7840", tokenFile: join(homedir(), ".config", "agent-fleet", "token"), json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--url") options.url = argv[i += 1];
    else if (flag === "--token-file") options.tokenFile = argv[i += 1];
    else if (flag === "--json") options.json = true;
    else if (flag === "--help" || flag === "-h") options.help = true;
    else throw new Error(`unknown option ${flag}`);
    if (flag !== "--json" && flag !== "--help" && flag !== "-h" && argv[i] === undefined) throw new Error(`${flag} needs a value`);
  }
  return options;
}

async function getJson(url, token) {
  const response = await fetch(url, { headers: token ? { "x-agent-fleet-token": token } : {}, signal: AbortSignal.timeout(8000) });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body, text };
}

export async function statusMain(argv = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(argv); } catch (error) { process.stderr.write(`agent-fleet status: ${error.message}\n${USAGE}`); process.exitCode = 2; return; }
  if (options.help) { process.stdout.write(USAGE); return; }
  const base = options.url.replace(/\/+$/, "");
  let token = process.env.AGENT_FLEET_TOKEN ?? "";
  if (!token) { try { token = readFileSync(options.tokenFile, "utf8").trim(); } catch { /* liveness answers without it */ } }

  let health;
  try { health = await getJson(`${base}/api/health`, token); } catch (error) {
    process.stderr.write(`hub ${base}: unreachable (${error.cause?.code ?? error.message})\n`);
    process.exitCode = 1;
    return;
  }
  let hosts = null, hostsNote = "";
  if (token) {
    try {
      const reply = await getJson(`${base}/api/hosts`, token);
      if (reply.status === 200) hosts = Array.isArray(reply.body) ? reply.body : reply.body?.hosts ?? [];
      else hostsNote = `hosts: HTTP ${reply.status}${reply.status === 401 ? " (token rejected)" : ""}`;
    } catch (error) { hostsNote = `hosts: ${error.message}`; }
  } else hostsNote = `hosts: no token (looked at ${options.tokenFile}; use --token-file)`;

  if (options.json) { process.stdout.write(`${JSON.stringify({ url: base, health: health.body ?? health.text, hosts })}\n`); process.exitCode = health.status === 200 ? 0 : 1; return; }

  const lines = [`hub ${base}  HTTP ${health.status}`];
  if (health.body && typeof health.body === "object") {
    for (const [key, value] of Object.entries(health.body)) lines.push(`  ${key}: ${value !== null && typeof value === "object" ? JSON.stringify(value) : value}`);
  } else lines.push(`  ${health.text.trim().slice(0, 200)}`);
  if (hosts) {
    lines.push(`hosts (${hosts.length}):`);
    const rows = hosts.map(host => [host.id, host.site ?? "", host.status ?? "", host.via ?? "", String(host.counts?.agents ?? "-"), String(host.counts?.running ?? "-"), ago(host.lagMs), host.lastSeen ? `${ago(Date.now() - host.lastSeen)} ago` : "-", host.error ?? ""]);
    const head = ["ID", "SITE", "STATUS", "VIA", "AGENTS", "RUNNING", "LAG", "SEEN", "ERROR"];
    const widths = head.map((title, column) => Math.max(title.length, ...rows.map(row => row[column].length)));
    for (const row of [head, ...rows]) lines.push(`  ${row.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd()}`);
  } else lines.push(hostsNote);
  process.stdout.write(`${lines.join("\n")}\n`);
  process.exitCode = health.status === 200 ? 0 : 1;
}
