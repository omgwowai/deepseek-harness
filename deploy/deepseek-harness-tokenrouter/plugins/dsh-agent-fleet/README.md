# @local/dsh-agent-fleet

Live view of every coding agent the user runs — DeepSeek Harness (DSH), Claude Code, Codex and Oh My Pi —
on every machine and cluster: main sessions, native subagents, ACP children and their own subagents, agents a
session started on another host or pod, the K8s pods they touch and the files they read or write.

[`CONTRACT.md`](CONTRACT.md) is the design contract: wire protocol, collector discovery and readers, hub link
resolution, HTTP API, panel data contract, security rules, ports. Read it before changing anything under
`lib/`. This file is the developer map: layout, tests, the collector bundle, a hub on this machine.

## Requirements

| | |
|---|---|
| Node | ≥ 22.15 (package `engines`). `node:sqlite` needs ≥ 22.5 and the DSH transcript reader needs `zlib.createZstdDecompress`. If `node` on your `PATH` is older (v20 is common), point at a 22.x binary, e.g. the one DSH ships: `~/.local/dsh/lib/node_modules/node/bin/node`. |
| Dependencies | none. `lib/`, `panel/` and `bin/` import only `node:*` modules, so a copied directory runs with `node` alone. `@deepseek-ai/dsh-tools` is an optional peer, resolved from the DSH profile. |
| Optional tools | `kubectl` (K8s source), `ssh` (remote collectors). |

## Layout

| Path | Role |
|---|---|
| `index.js` | DSH host plugin: the `agent-fleet/*` RPC routes, the `agent_fleet` model tool, the `DSH_AGENT_FLEET_PARENT*` shell variables, and `embedded` mode (hub inside the DSH process). |
| `client.js` | DSH browser plugin: sidebar entry, "Agent Fleet" main page, and the session tab that iframes the panel. |
| `cordis.patch.yml` | The default row (`mode: remote`); `configure.mjs` writes the per-profile override. |
| `configure.mjs` | Writes/updates the `dsh-agent-fleet` row in a profile's `cordis.patch.yml` (backup, atomic replace, `--dry-run`). |
| `bin/agent-fleet.mjs` | CLI entry: `collector` · `hub` · `edge` · `status` · `bundle`. Each subcommand module is imported only when it runs. |
| `lib/protocol.mjs` | Wire contract: constants (`AGENT_KINDS`, `SITES`, `ROLES`, `STATUSES`, `TOOL_CATEGORIES`, `TARGET_TYPES`, `HUB_METHODS`, `LIMITS`) and the typedefs. Shared — change it through the integration owner. |
| `lib/channel.mjs` | Framed transport over stdio / TCP / `ssh -W`, with redial and backoff. Shared. |
| `lib/redact.mjs` | Secret-path refusal and value redaction for previews, command lines and file content. Shared. |
| `lib/jsonl.mjs` | Incremental JSONL reader (plain and zstd-framed) that only reads appended bytes. |
| `lib/targets.mjs` | Tool call → `Target[]` (file / pod / k8s / host / url / agent) and its category. |
| `lib/collector/` | One collector: `index.mjs` (request handling), `discovery.mjs` (roots, mtime watch), `readers/{claude,codex,omp,dsh}.mjs`, `procs.mjs` (processes, `AGENT_FLEET_PARENT`), `acp.mjs` (DSH ACP sidecar), `files.mjs`, `sessions.mjs`, `roots.mjs`, `main.mjs` (CLI). |
| `lib/hub/` | The hub: `index.mjs` (CLI, wiring), `state.mjs` (agents, events, journal, cursor), `links.mjs` (parent resolution, cross-host links), `api.mjs`, `http.mjs`, `auth.mjs`, `events.mjs`, `sources/{collector-link,local,upstream,kube}.mjs`. |
| `lib/edge.mjs` | Plain-HTTP reverse proxy: `/fleet` → hub, `/dsh` → DSH Web, fallback → the telemetry panel. |
| `lib/status.mjs` | `agent-fleet status`: `/api/health` plus the host table. |
| `lib/plugin/` | What the DSH plugin uses: `config.mjs` (validated row config), `patch-file.mjs`, `embedded.mjs` (in-process hub), `hub-client.mjs`, `graph.mjs` (family tree), `tool.mjs` (the model tool). |
| `panel/` | Vanilla JS + SVG panel, no build step, served by the hub. See [`panel/README.md`](panel/README.md). |
| `tools/build-collector.mjs` | Bundles the collector into `dist/agent-fleet-collector.mjs`. |
| `deploy/` | `deploy-server.sh`, `systemd/*.service`, `k8s/` test pods, and `k8s/provision-acp.sh` (ACP adapter + bridges and the `headless` profile inside a test pod). |
| `tests/` | `node --test` suites and fixtures. |

`lib/` is source, not build output: the pack `.gitignore` re-includes it under the repository rule that ignores
every `lib/`. `dist/` and `.scratch/` are ignored.

## Tests

```bash
cd plugins/dsh-agent-fleet
node --test tests/*.test.mjs        # 324 tests; loopback sockets and temp dirs only, no cluster
```

Use a Node 22 binary for the command above (see Requirements). `npm test` runs the same script, but with the
`node` on `PATH`: on a machine where that is v20 the suite fails (readers and the collector suite cannot even
load), so run the binary explicitly.

| File | Covers |
|---|---|
| `tests/channel.test.mjs` | Framing, redial, child signalling. |
| `tests/readers.test.mjs` | The four transcript readers, parent hints, incremental reads, zstd frames. |
| `tests/collector.test.mjs` | Discovery, hot/cold tails, processes, `AGENT_FLEET_PARENT`, ACP sidecar, request handling. |
| `tests/targets.test.mjs` | Tool-call classification and targets. |
| `tests/hub.test.mjs` | State, journal/cursor, deltas, links, upstream merge, watchdogs, health. |
| `tests/kube.test.mjs` | Pod list/watch, collector attach, pod file reads, terminal pods. |
| `tests/edge.test.mjs` | Routes, prefix stripping, redirects, streaming, upgrades. |
| `tests/panel.test.mjs` | Panel helpers against `lib/protocol.mjs`, demo fixture shape. |
| `tests/plugin.test.mjs` | Row config, patch writes, RPC routes, model tool actions, embedded mode. |

A test is added only as a regression for a consumer-visible bug: it must fail on the old code and pass on the fix.

## Build the collector bundle

```bash
node tools/build-collector.mjs
# dist/agent-fleet-collector.mjs  294278 bytes  sha256 5da59dbf98145956  20 modules  externals: node:child_process node:fs …
```

`node bin/agent-fleet.mjs bundle [--out FILE]` runs the same build with a custom output path and prints the same
line.

The output is one ES module whose only imports are `node:*` built-ins; it is what the hub pushes into a pod at
`/tmp/agent-fleet/collector.mjs` and starts with `node … collector --stdio`. The bundler has no npm dependency and
a deliberately small syntax budget: relative imports and `node:*` only, `export const|function|class`, re-exports
and `import("literal")`; import cycles, `export let|var` and `import.meta` fail the build. It runs `node --check`
on the result and rejects any non-`node:` import.

Do not edit or commit `dist/`; it is generated and git-ignored.

## Run a hub locally

```bash
node bin/agent-fleet.mjs hub --listen 127.0.0.1:7899 --ingest off --no-local --token-file .scratch/token
curl -s http://127.0.0.1:7899/api/health
```

- `--no-local` skips the in-process collector, so the hub starts with no hosts.
- The token file is created with mode `0600` when missing; `/api/health` is public as liveness only (`{ok, version}`,
  still 200) and the panel shell is public, every other `api/*` route needs the token (`x-agent-fleet-token`,
  `Authorization: Bearer`, or the cookie set by `GET /?token=…`) or a panel session key: the plugin's panel URL carries
  a one-time `#nonce=…` that the panel redeems (`POST /api/session`) for a key it keeps in memory and sends as
  `x-agent-fleet-token`. The full health body needs the token as well.
- The Host header is checked: loopback names and the `--public-host` names only; anything else answers 403. Behind the
  edge the browser's Host is the edge's, so the deployed hub passes `--public-host 10.0.60.98`.
- Open `http://127.0.0.1:7899/` for the panel; the first visit takes the token in the fragment
  (`http://127.0.0.1:7899/#token=<token>`), which the panel exchanges for the cookie and keeps in memory only.
  Without a hub, the panel also runs on its fixtures: `index.html?demo=1` (see [`panel/README.md`](panel/README.md)).

To feed it from this machine, give the hub an ingest listener and start a collector:

```bash
node bin/agent-fleet.mjs hub --listen 127.0.0.1:7899 --ingest 127.0.0.1:7901 --no-local --token-file .scratch/token
node bin/agent-fleet.mjs collector --connect 127.0.0.1:7901 --host-id dev --site mac --since 2m
node bin/agent-fleet.mjs status --url http://127.0.0.1:7899 --token-file .scratch/token
```

`status` prints the health fields and a host table (`ID SITE STATUS VIA AGENTS RUNNING LAG SEEN ERROR`); the
collector shows up as `online` with `via socket`. `status` sends the token to `/api/health`; without one the hub
answers liveness only.

A hub started with `--ingest-token-file FILE` closes the ingest socket unless the collector presents the same token:
add `--token-file FILE` to the collector. The `--stdio` transport (pod collectors) is dialed by the hub and needs no
token, and `--connect`/`--ssh` re-read the file on every reconnect.

## Command line

| Command | Purpose |
|---|---|
| `agent-fleet collector (--stdio \| --connect HOST:PORT \| --ssh TARGET [--ssh-port 7841]) [--token-file FILE]` | Report one machine's sessions to a hub. `--token-file` is the ingest credential for `--connect`/`--ssh` (sent in `hello`, re-read on every reconnect); not needed for `--stdio`. Extra roots `--root KIND=PATH` (repeatable) or `AGENT_FLEET_ROOTS=kind=path:…`. |
| `agent-fleet hub` | Hub: state, HTTP API + panel, collector ingest, optional K8s watch, optional upstream. `--token-file` is the API token; `--ingest-token-file` gates the collector ingest socket. |
| `agent-fleet edge --listen HOST:PORT --route /p=http://h:port … --fallback http://h:port` | Reverse proxy for `/fleet` and `/dsh`. |
| `agent-fleet status [--url URL] [--token-file FILE] [--json]` | Hub health and host list. |
| `agent-fleet bundle [--out FILE]` | Build the single-file collector. |

`agent-fleet <command> --help` prints the full flag list for `collector`, `hub` and `status`. `edge` has no
`--help`: it rejects unknown flags and reports its usage line when `--listen` or `--fallback` is missing.

## Conventions

- `lib/protocol.mjs`, `lib/channel.mjs` and `lib/redact.mjs` are shared by collectors, hub, panel and plugin; change
  them only through the integration owner (CONTRACT.md).
- Collectors never open network sockets themselves: the CLI wires stdio, TCP or `ssh -W`.
- Times on the wire are epoch milliseconds; the hub shifts each collector's clock to its own (`skewMs`).
- `panel/` has no build step and no framework; CSP is `default-src 'none'`, and all URLs are relative to the
  page's own path so the same files serve `/` and `/fleet/`.
- Deployment (server units, edge cutover, pod test pods) is described in the pack README and
  `deploy/deploy-server.sh`.