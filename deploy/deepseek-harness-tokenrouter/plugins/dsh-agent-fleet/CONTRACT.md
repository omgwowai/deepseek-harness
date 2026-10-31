# Agent Fleet — implementation contract

Internal design contract for the `dsh-agent-fleet` plugin. Every module follows it; `lib/protocol.mjs` holds the
typedefs and constants named here, `lib/channel.mjs` the transport, `lib/redact.mjs` redaction. Change those three
files only through the integration owner.

## Goal

One live view (≤ 2–3 s end-to-end latency) of every DeepSeek Harness (DSH), Claude Code, Codex and Oh My Pi (OMP)
session the user runs, on every site:

| Site | Machine | Collector transport to the hub |
|---|---|---|
| `mac` | user's Mac (DSH desktop app) | Mac collector dials the server hub over `ssh -W 127.0.0.1:7841 bochao_li@10.0.60.98` (outbound only) |
| `server-bochao-01` | 10.0.60.98, hosts the hub, DSH Web, the edge router | in-process collector inside the hub |
| `sg-compute` | 10.0.1.138 | sg-compute collector dials `ssh -W 127.0.0.1:7841 bochao_li@10.0.60.98` (sg-compute has a key that the server accepts) |
| `chengdu`, `weihai`, `iron`, `os` | K8s pods in namespace `mc-bochao-li`, contexts `chengdu`, `weihai`, `ulanqab-iron`, `ulanqab-osmium` | hub runs `kubectl exec -i <pod> -- node /tmp/agent-fleet-collector.mjs --stdio` (pod egress to 10.0.60.98 is blocked on chengdu/weihai, so the hub always initiates) |

The hub also keeps the Mac usable on its own: a second hub runs embedded in the Mac DSH desktop plugin, fed by
the local collector in-process, and it subscribes upstream to the server hub so the desktop app shows the whole
fleet. The server hub is the primary egress.

Covered relations (all four kinds × all sites): main agent → subagent (native subagents of each kind), DSH → ACP
child (DSH session bound to a Claude/Codex/OMP native session), ACP child → its own subagents, agent → agent on
another host or pod (an agent that runs `kubectl exec <pod> -- omp …` or `ssh host claude …`; linked through the
`AGENT_FLEET_PARENT` env var when present, otherwise through the launching tool call's command line + time
window).

## Layout

```
plugins/dsh-agent-fleet/
  package.json  cordis.patch.yml  index.js (DSH host plugin)  client.js (DSH browser plugin)
  CONTRACT.md  README.md
  bin/agent-fleet.mjs            CLI: collector | hub | edge | bundle | status
  lib/protocol.mjs  lib/channel.mjs  lib/redact.mjs        shared (integration owner)
  lib/jsonl.mjs                  incremental JSONL / zstd-frame tail reader (readers slice)
  lib/targets.mjs                tool call → Target[] + category (targets slice)
  lib/collector/readers/{claude,codex,omp,dsh}.mjs  lib/collector/readers/index.mjs  (readers slice)
  lib/collector/{index,discovery,procs,files,acp}.mjs       (collector slice)
  lib/hub/{index,state,http,auth}.mjs  lib/hub/sources/{collector-link,local,upstream}.mjs  (hub slice)
  lib/hub/sources/kube.mjs        (kube slice)
  lib/edge.mjs                    (edge slice)
  panel/{index.html,app.js,app.css} (panel slice; no build step, no framework, no external network)
  tools/build-collector.mjs       → dist/agent-fleet-collector.mjs (single file, node:* imports only)
  deploy/systemd/*.service  deploy/k8s/*.yaml  deploy/*.sh
  tests/*.test.mjs  tests/fixtures/**
```

Runtime: Node ≥ 22.15 (`zlib.createZstdDecompress`, `node:sqlite` with ≥ 22.5). No npm dependencies in `lib/`,
`panel/`, `bin/`. Everything must run from a copied directory with `node`.

## Collector (one per machine or pod)

* `startCollector({hostInfo, roots, send, now})` from `lib/collector/index.mjs` returns `{handleRequest(method, params), stop()}`.
  `send(message)` is a channel `send`. Collector never opens network sockets itself; the CLI wires a transport.
* Discovery (`discovery.mjs`): scan roots every 1 s by mtime (`fs.watch` where it works, mtime poll as backstop).
  A session is "hot" if modified within 10 min or bound to a live process; hot files are tailed every 500 ms
  (stat → read appended bytes only). On start, also load sessions modified within `--since` (default 24 h) once.
  Default roots: `~/.claude/projects`, `~/.codex/sessions` (+ `archived_sessions`), `~/.omp/agent/sessions`
  (+ `~/.paseo/agents/omp/sessions` when present), `~/.dsh/sessions`; extra roots via `--root kind=path` and
  `AGENT_FLEET_ROOTS` (`kind=path:kind=path`). Container runs: any `harness-home/sessions` directory listed in
  `--root dsh=…` is treated as another DSH home (container label = path segment before `/work/harness-home`).
* Readers (`readers/*.mjs`): each exports `createReader({file, host, site, root})` → `{feed(lines, spans), snapshot(): AgentRecord, takeEvents(): AgentEvent[], children(): string[]}`
  and a static `match(path)` → `{kind, id, role} | null`. Readers turn native records into `AgentRecord` and
  `AgentEvent` (see protocol). Upserts are idempotent: an event id is stable for its transcript position; a tool event is first
  sent `pending` and re-sent with `status`/`duration` when its result arrives.
* Parent links (`ParentHint`), per kind:
  * OMP: header `parentSession` (abs path or id); nested dir `<parent-name>/<Task>.jsonl` → subagent; `task` tool
    result `details.results[].id` ↔ child task id gives `toolCallId`.
  * Claude: `<sid>/subagents/agent-<id>.jsonl` + `.meta.json` (`toolUseId`); sidechain lines `isSidechain`;
    fork `forkedFrom.sessionId`.
  * Codex: `session_meta.payload.source.subagent.thread_spawn.parent_thread_id`, `parent_thread_id`, `forked_from_id`,
    `thread_source` (`subagent`).
  * DSH: header `parentSession` + `origin:"subagent"` + `delegationDepth`; parent `subagent/catalog{childId}`;
    `isSeeded` → fork; `session-dsh-acp-*` → role `projection`.
  * ACP: `~/.dsh/dsh-acp/sidecar.sqlite` `bindings(dsh_session_id, acp_provider_id, acp_session_id, payload)`
    (open read-only, `node:sqlite`, poll `max(time)` every 2 s). Native session gets `parent = {kind:"dsh", id, via:"acp", exact:true}`,
    DSH record gets `acp = {provider, kind, id}`.
* Processes (`procs.mjs`): every 2 s, `ps -axo pid=,ppid=,lstart=,command=` (Linux: `/proc/*/cmdline`, `/proc/*/environ`
  for `AGENT_FLEET_PARENT`, `/proc/*/cwd`). Recognize omp (`bun …/omp`, `pi-coding-agent/dist/cli.js`), claude
  (`claude`, `@anthropic-ai/claude-code`, `claude-agent-acp`), codex (`codex`, `codex app-server`, `codex-acp`), dsh
  (`dsh/lib/bin.js`, `DeepSeek Harness`), plus `kubectl exec … -- <agent>` and `ssh <host> <agent>` launchers.
  Match process → session: OMP `--session <file>`; Claude `--session-id/--resume <id>`; open-file check on Linux
  (`/proc/<pid>/fd` → transcript path); otherwise cwd + start time. Matched sessions get `live.alive=true, pid`.
  A process gone → `alive=false`; a session whose turn is open but whose process is gone and that has not
  written for 5 min → status `stale`.
* `handleRequest`: `file.read {path, maxBytes}` → `FilePreview` (refuse `isSecretPath`, cap 256 KiB, binary check,
  redact); `agent.events {key, before?, limit}` → older events for paging; `ping` → `{at}`.
* Messages sent: `hello` once (`{t:"hello", proto:1, host:HostInfo, at, token?}`), then `agent` (full record, on change,
  coalesced 250 ms), `events` (`{t:"events", agent, events:[…]}`), `gone` (`{t:"gone", agent}` when a file is deleted),
  `procs` (`{t:"procs", procs:Proc[]}` on change), `heartbeat` (`{t:"heartbeat", at, stats}` every 5 s).
  Initial load: per agent, the last `LIMITS.initialEventsPerAgent` events.

## Hub

* `startHub({hostId, collectors, upstream, kube, http, now})` in `lib/hub/index.mjs`.
* State (`state.mjs`): hosts, agents (by key), events per agent (ring of `LIMITS.hubEventsPerAgent`), procs, pods,
  links, feed. Monotonic `cursor` bumped on every change; changes kept in a journal (last 10 000) so a client
  can ask `changes?since=<cursor>` and get a `Delta` (or `reset:true`).
* Link resolution: for each agent with a `parent` hint, resolve to a key (same host by `key`/`file`, global by
  `kind:id`); unresolved hints stay pending and are retried when new agents arrive. Process-based links: a `Proc`
  with `remote` (kubectl exec / ssh) whose parent pid belongs to agent A, and a session that starts on the remote
  host/pod within ±60 s → link A → child (`via:"process"`, `exact:false`). Env links: `AGENT_FLEET_PARENT` → exact.
  Tool-call links: an event with an `agent` launch target `{site, pod, kind}` → nearest session of that kind
  that starts on that pod/site within [t−5 s, t+120 s] → link (`via:"command"`, `exact:false`).
* Touches: index `Target`s of type `pod` (key `podKey(site, ns, name)`) and `file` (key `<host>:<path>`) → which
  agents/events touched them. Pods referenced by any target are pulled into `pods` even if not watched by label.
* Clock skew: `skewMs = hubNow − hello.at` (smoothed with heartbeats); every collector timestamp is shifted by skew.
* HTTP (`http.mjs`, bound to `127.0.0.1` only): `GET /` + `/app.js` + `/app.css` (panel), `GET /api/snapshot`,
  `GET /api/changes?since=N`, `GET /api/stream?since=N` (SSE: `event: delta`, data = Delta JSON; keep-alive
  comment every 15 s), `GET /api/family?key=K` (root + descendants + all their events), `GET /api/agent?key=K&before=&limit=`,
  `GET /api/pods`, `GET /api/pod?key=K` (pod + touches + recent kube events), `GET /api/file?host=H&path=P`
  (proxied to that host's collector, or `kubectl exec cat` for pods with no collector), `GET /api/query?…`
  (tool search: `kind,site,host,category,target,text,since,limit`), `GET /api/hosts`, `GET /api/health`,
  `POST /api/session-nonce`.
  Auth: token in `~/.config/agent-fleet/token` (0600, 64 hex). Accepted as `Authorization: Bearer`, header
  `x-agent-fleet-token`, or cookie `agent_fleet=…` (set by `GET /?token=…` or by the one-time `GET /?nonce=…`; both
  302 to `/` with `cache-control: no-store` and `referrer-policy: no-referrer`). `/api/health` is open but answers
  liveness only (`{ok, version}`, still 200); the full body (ports, hostId, upstream, kube states) needs the token.
  `POST /api/session-nonce` (token) mints a single-use 60 s nonce for the panel URL, so the raw token never enters a
  URL, a fragment or page storage. Host header policy: loopback names and `--public-host` names only;
  `x-forwarded-host` opens a name only if that name is one of them, and a Host that is neither answers 403 (the
  deployed hub passes `--public-host 10.0.60.98` because the edge forwards that Host).
  When `--base /fleet` is set, every route also answers under that prefix and the panel uses relative URLs.
* Ingest auth: the hub takes `--ingest-token-file FILE` (created 0600 when missing; the deploy unit uses
  `~/.config/agent-fleet/ingest-token`, separate from the API token). Collectors on the TCP ingest port send it as
  `hello.token` (constant-time compare); a channel the hub dials itself (kubectl exec, `--dial-ssh`, the in-process
  local collector) is trusted and keeps the `expectHostId` check. A hello for an already-online host over a different
  transport is refused and logged. Collector CLI: `--token-file FILE` for `--connect`/`--ssh` (re-read on every
  reconnect); the Mac uplink uses `upstream.ingestTokenFile`.
* Ingest caps (`state.mjs`): agent and event strings clamped to `LIMITS` (`textChars`/`previewChars`); paths
  (`file`, `cwd`, `parent.file`, `target.path`) to `LIMITS.pathChars` (1024), while other target fields keep the
  text widths; targets ≤ `LIMITS.maxTargetsPerEvent`, ≤ 5000 agents per host (refused keys are counted in
  `host.rejected`/`host.lastRejected`), ≤ 2000 procs per host. The 2 MiB line cap applies to the hub's ingest
  sockets only; hub-dialed stdio / `kubectl exec` / `ssh`-relay channels keep `LIMITS.lineBytes` (16 MiB).
* Upstream (`sources/upstream.mjs`): a hub can subscribe to another hub (`/api/stream`) and merge its state
  (the Mac embedded hub mirrors the server hub; local entries win for the local host id).

## Kube source (`sources/kube.mjs`, runs in the server hub)

* `createKubeSource({kubeconfig, kubectl, sites, namespace, collectorBundle, onPods(site, pods, "list"|"watch"),
  onPodGone(site, podKey), onSourceState(site, {status, error, since}), attachCollector(site, pod, spec), now})`
  → `{start(), stop(), getPod({site, namespace, name}), readPodFile({site, namespace, pod, container, path, maxBytes}),
  podEvents({site, namespace, pod}), describe(site?)}`.
* Per site: list and watch ACTIVE pods only (`--field-selector=status.phase!=Succeeded,status.phase!=Failed`;
  weihai holds ~7.5k finished pods, 109 MB unfiltered). `onPods(site, pods, "list")` is the complete active set
  (replace); `"watch"` carries upserts. `onPodGone` on deletion or completion. Terminal pods an agent touched are
  resolved on demand with `getPod` (active set → 60 s LRU → `kubectl get pod`).
* Pods with label `agent-fleet.omgwow.ai/collect=true` (container from `agent-fleet.omgwow.ai/container`, else the
  first) get a collector: probe node ≥ 22 + sha256, push `dist/agent-fleet-collector.mjs` to
  `/tmp/agent-fleet/collector.mjs` when the hash differs, then `attachCollector(site, pod, spec)` with
  `spec = {command: "kubectl", args: [... "exec", "-i", pod, "-c", c, "--", "node", "/tmp/agent-fleet/collector.mjs",
  "collector", "--stdio", "--host-id", "k8s/<site>/<pod>", "--site", site, "--kind", "pod", "--label", pod], label, hostId}`;
  the hub passes `spec` to `dialCollector` and returns its handle (`{stop()}`), which the source calls on detach.
  `Pod.collector` holds the attach status or failure reason (`"no node runtime"`, …).
* `readPodFile`: constant script, path as a positional argument, `stat -L` + `readlink -f` (symlinks resolved, secret
  paths refused after resolution, `/proc|/sys|/dev` refused); same `FilePreview` rules as the collector.
* `podEvents`: `get events --field-selector involvedObject.name=<pod>` on demand (`api/pod`), redacted, ≤ 240 chars.

## Edge router (`lib/edge.mjs`, port 443 on 10.0.60.98)

Plain HTTP reverse proxy (HTTP/1.1, WebSocket upgrade, streaming bodies, no buffering):
`/fleet/*` → hub `127.0.0.1:7840` (strip `/fleet`), `/dsh/*` → DSH Web `127.0.0.1:3080` (strip `/dsh`),
everything else → the telemetry panel moved to `127.0.0.1:8464` (unchanged paths). Adds `X-Forwarded-*`.
A bare prefix (`/fleet`, `/dsh`) answers 302 (not 301) to the trailing-slash form with `cache-control: no-store` and
`referrer-policy: no-referrer`. The browser's Host header passes through unchanged (DSH Web compares Origin with it).

## DSH plugin (`index.js` + `client.js`)

* Host: `inject: ["connection"]`; optional `tools` service. Config (`cordis.patch.yml` row `dsh-agent-fleet`):
  `{mode: "embedded"|"remote", hubUrl?, tokenFile?, upstream?: {url, tokenFile, sshTarget?, ingestTokenFile?}, collector?: {roots, since}}`.
  * `embedded` (Mac desktop): start a hub in-process (no HTTP listener of its own except `127.0.0.1:7846`),
    with a local collector; subscribe upstream to the server hub (through `ssh -L`-free `ssh -W` relay to
    `127.0.0.1:7840` on the server) and push the local collector to the server hub (`ssh -W 127.0.0.1:7841`,
    presenting `upstream.ingestTokenFile` in `hello`).
  * `remote` (server DSH Web): talk to the co-located hub over HTTP `127.0.0.1:7840`.
* RPC routes (`ctx.connection.fetch.register`, same envelope as dsh-agent-dag): `agent-fleet/snapshot`,
  `agent-fleet/changes {since}`, `agent-fleet/family {key | dshSessionId}`, `agent-fleet/file {host, path}`,
  `agent-fleet/pod {key}`, `agent-fleet/query {...}`, `agent-fleet/panel-url`.
* Model tool `agent_fleet` (`ctx.tools.register(defineTool(...))`): actions `overview` (hosts × kinds, running
  counts), `list` (filters: site, host, kind, status, role, text, since), `family` (by key or DSH session id),
  `agent` (one agent + recent events), `pods` / `pod`, `files` (files touched by an agent or by everyone),
  `file` (preview one file via collector), `query` (tool-call search). Output: compact JSON + text render.
* Browser: sidebar panel + `main` page "Agent Fleet" (iframe of the panel served by the hub; the URL carries a
  one-time `?nonce=…` — with `#focus=…` when a session is given — that the hub turns into the HttpOnly cookie)
  and session tab `conversation.view` id `agent-fleet` that opens the panel focused on the current session's family.

## Panel (`panel/`)

Vanilla JS + SVG, dark/light from `prefers-color-scheme`, no external fetches. Loads `api/snapshot`, then
`api/stream?since=cursor` (EventSource; fall back to polling `api/changes` every 1 s). Views:
1. **Fleet** — sites → hosts/pods → agent trees (main → subagents → ACP children → their subagents), with kind
   badge (D/C/X/O), status dot, live "doing", model, tokens, age; cross-host edges shown as "↗ k8s/os/pod-x".
2. **Timeline** — Gantt like Agent DAG: one lane per agent of the selected family (or all running), bars from
   startedAt→endedAt|now, tool ticks colored by category, spawn/return connectors, live cursor, 1 s refresh.
3. **Pods** — pods touched by agents, per site; phase, node, containers; which agents/events touched them; kube events.
4. **Files** — files touched (path, host, ops, last touch, agents); click → preview pane (content via `api/file`,
   diff-ish highlighting for edits not required).
5. **Feed** — live stream of tool events across the fleet with targets.
URL hash state: `#view=timeline&key=<agentKey>`, `#focus=<dshSessionId>`.

## Security

* Hub, collectors and DSH Web listen on 127.0.0.1 only; the only network listener is the edge on 10.0.60.98:443
  (iptables already restricts 443 to 10.0.0.0/8 and 192.168.0.0/16).
* Tokens: the API token (`~/.config/agent-fleet/token`), the ingest token (`ingest-token`, sent only in `hello`) and
  the Mac's copies (`upstream-token`, `upstream-ingest-token`), all 0600. A token never rides in a URL that gets
  logged: the plugin's panel URL carries a single-use 60 s `?nonce=…` (`POST /api/session-nonce`) that the hub
  exchanges for the HttpOnly cookie, and a manual `#token=` fragment is exchanged for the same cookie.
* Collector redacts previews, command lines and file content (`lib/redact.mjs`); refuses `isSecretPath`.
* Kubeconfig copy on the server at `~/.config/agent-fleet/kubeconfig.yaml` (0600); never logged, never sent.
* File preview is read-only; no endpoint writes, kills or execs anything user-controlled. Pod file reads pass the
  path as a positional argument (`sh -c '…' sh "$path"`), never interpolated.

## Ports

| Port | Bind | What |
|---|---|---|
| 443 | 10.0.60.98 | edge router (server) |
| 7840 | 127.0.0.1 | hub HTTP (server) |
| 7841 | 127.0.0.1 | hub collector ingest (server; reached via `ssh -W`) |
| 3080 | 127.0.0.1 | DSH Web (server) |
| 8464 | 10.0.60.98→127.0.0.1 | telemetry v3 panel moved behind the edge |
| 7846 | 127.0.0.1 | Mac embedded hub HTTP (panel for the desktop app) |
