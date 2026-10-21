# Fork notes: native ACP trajectory recording

Fork of `@zaimokuza/dsh-acp-adapter` (MIT), base tag `v0.2.1-rc.2.3` (upstream commit `ee20509`).
Ships as **`@local/dsh-acp-adapter`** (`0.2.1-rc.2.3-fork.3`), installed into DSH profiles as a
`link:` dependency so a `pnpm build` here is what the host loads.
Purpose: record Claude Code / Codex / Oh My Pi ACP turns natively complete in the DSH session log —
tool rows with real timing and results, token usage — live, by the adapter itself, so the Trajectory
tab needs no after-the-fact backfill (the paseo plugin's live-tools supplement is retired).

## Build

```bash
pnpm install --frozen-lockfile   # Node ^22.19 || >=24 (engines); 22.23.3 used
pnpm build                       # tsc + tsdown + verify-bundle (asserts the client bundle id == package name)
```

`lib/**` of an unmodified checkout is byte-identical to the published `0.2.1-rc.2.3` package except
build-machine paths embedded in region comments.

## Changes vs upstream

| File | Change |
|---|---|
| `src/host/composition/native-tool-rows.ts` (new) | `AcpNativeToolRows`: per-prompt recorder that appends `assistant/message{tool-call}` + `tool/call` on a call's first observation and `tool/result` on its terminal status, inside the loop's currently open turn+step (`facts.openSteps.at(-1)`). Real times come from `Session.append`'s `Date.now()`. A call is only advertised once the snapshot carries `rawInput` (or on its terminal update): Claude announces a call with a title first and attaches its input one update later, and the stored row is immutable. Also `nativeToolPresentation` (ACP `name`/`title`/`kind` + `rawInput` → DSH wire tool, ported from the panel importer's `TOOL_PRESENTATIONS`, with an ACP-kind fallback `execute → bash`) and `dshUsageFromAcp` (ACP `PromptResponse.usage` → the durable usage `dsh-token-meter` folds). |
| `src/host/composition/profile-adapter.ts` | Import + instantiate the recorder next to `AcpToolCallReducer`; `nativeToolRows.observe(toolCall)` on every merged ACP tool snapshot; `settleOpen` at response settlement, on `handoff.cancel`, on steering suspension, and right before the terminal `finish` chunk; emit `{type:"usage", usage}` before that finish chunk. |
| `src/host/composition/session-facts.ts` | `acpSessionView.append` forwards the third (surface) options argument — it previously dropped `surfaceOp`, which made every adapter append of a surface-eligible event fail. |
| `src/domain/session/session-facts.ts` | `SessionLike.append` accepts `options?: { surfaceOp?: 'append' }`. |
| `src/runtime/client-capabilities/terminal.ts`, `src/runtime/session/session-runtime.ts` | `AcpTerminalHost.peekOutput` + `SessionRuntime.readTerminalOutput`: an adapter-internal read of a client-side terminal this connection still holds, so a tool result whose ACP content is a `terminal` item records the same bytes the Agent saw. Result bodies prefer accumulated `_meta` output (`terminal_output_delta`/`terminal_exit`), then this peek, then the result's own text; a body is tail-bounded to 64 000 bytes (`[output truncated]`), a non-zero exit is marked `[exit code: N]`, and an exit without bytes is `(no output)` — all like DSH bash. |
| `src/host/composition/config.ts`, `installed-profile-registry.ts` | **Team bridge is opt-in**: config `teamBridge` (default `false`) now owns the DSH `dshteam_*` MCP bridge. With it off the registry passes no lease factory / bridge key, so `session/new` advertises no MCP servers and Claude/Codex/Oh My Pi see only their own tools — the paseo plugin's `startNativeTools` registry patch is gone. `teamBridge: true` restores upstream behaviour. |
| `src/client/ui/acp-chat-normalization.ts`, `AcpActivityNode.ts` | **Chat shows each tool once.** When the stored session log already holds a native tool row for an ACP call (`assistant/message{tool-call}` blocks + `tool-call` nodes are matched by ACP call id), the sidecar activity rows for that call are dropped from the Chat projection instead of rendering a second card. The activity journal/sidecar keeps every row for diagnostics, and logs recorded before this change (no native rows) still render their cards. |
| `src/client/index.ts`, `cordis.patch.yml`, `tsconfig.json`, docs, tests | Package renamed to `@local/dsh-acp-adapter` (bundle patch row name, client `plugins.bundle.config` key, tests/scripts/docs). Plugin id stays `dsh-acp-adapter`, so route ids (`acp-claude`/`acp-codex`/`acp-omp`), sidecar bindings and profile patches keep working. |

Nothing is registered in the DSH tool registry and no `tools/execute` interception exists, so DSH
never executes an ACP tool call; the loop only sees the adapter's outer stream as before.

## Textless `end_turn` classification (fork decision)

Upstream settles a `stop`-kind response with no visible text as `ACP_NO_VISIBLE_RESPONSE` (error)
unless host-side evidence confirms work: a completed teammate report, a turn-concluding tool, or a
successful **host** tool result. On this fork `teamBridge` is off by default, the three agents run
their own native tools, and no host-tool callback ever fires — so a silent tool-only turn failed for
every agent no matter what it had actually done. (Codex `5.6 Sol` ended with
`task_complete.last_agent_message: null` but had emitted text mid-turn, so it showed Completed;
omp's tool turn — bash ran, then omp's own empty-stop retry cap — showed Failed. Same class, two
outcomes.)

Decision: the **recorded `tool/result` row of a successful native ACP call** is the fork's evidence
for this class, exactly parallel to upstream's successful-host-tool-result evidence:

- `AcpNativeToolRows.observe` reports whether it appended a successful result; the adapter mirrors
  upstream's eligibility boundary for it (`applyProjectionAtDispatch` kills and `restoreProjection`
  restores it with the host flags, so evidence never crosses a steering dispatch).
- Classification is now uniform across Claude/Codex/omp: `end_turn` + no visible text is Completed
  when a native call's successful result (or any host-side evidence) existed, and stays a clear
  `ACP_NO_VISIBLE_RESPONSE` failure when nothing succeeded or nothing was recorded (a call whose row
  was refused proves nothing; a failed/cancelled-only call is not evidence). Genuine failure stop
  reasons (`refusal`, `max_turn_requests`, …) are untouched and still surface as errors.

Also in this change: Codex reports a read-shaped command (its parser classified, e.g.,
`sed -n '1,240p' …/SKILL.md`, as a file read) as an `exec_command` call whose only argument material
is the single `locations` entry — it never attaches `rawInput`, so the old recorder froze `{}` there.
Such a call now presents as the DSH `read` tool with its real `file_path` from the first update.

## Verified

Bench `.paseo-demo/fork` (hub `dsh-acp-fork-bench` @6798, isolated agent homes, `liveTools: false`),
fresh sessions per agent, prompt `sleep 2 && printf '<mark>' >> acp-row-check-<agent>.txt` then `DONE`:

- **Oh My Pi** — one turn, continuing an existing session: `assistant{tool-call}` → `tool/call` → `tool/result` → usage `{…, totalTokens 34940}`; Trajectory TOOL row; footer `62.5K tok · Cache hit 76%`; reload clean; scratch file 3 turns = 3 lines. (Recorded with the pre-dedup build; the dedup hides its card on reload — verified.)
- **Claude Code** (`claude-sonnet-5.5`) — `bash` row with the real `{command, description}` (the rawInput-wait fix), `tool/result` with Claude's call id, usage `{totalTokens 99230}`, footer `99.2K tok · Cache hit 50%`, one Chat row, one approval round-trip, scratch file +1 line, log re-folds cleanly.
- **Codex** (`6 Astra`) — `exec_command → bash` with `cmd → command` rename and real `{command, cwd}`, `tool/result` (`exec-…` call id), usage `{totalTokens 29948}`, footer `29.9K tok · Cache hit 50%`, one Chat row after reload, scratch file +1 line.
  **Shell results carry the real bytes** (rebuilt adapter, bench session-01ca4249): `printf 'FORK6-out\n' && exit 7` records content `FORK6-out\n` + `[exit code: 7]` (`isError: true`, rows 33/34); a 70 001-byte `print('x'*70000)` records exactly 64 000 bytes + `[output truncated]` (row 45). Re-checked on the final build: `printf 'FORK6-FINAL\n' && exit 5` → `FORK6-FINAL\n` + `[exit code: 5]`. Trajectory shows both rows with real arguments; Chat shows one Bash card per call.
- **Desktop** (`~/.dsh/profiles/desktop`) — `@local/dsh-acp-adapter` (link to this repo) loaded, routes `acp-claude`/`acp-codex`/`acp-omp` registered, adapter config has no `teamBridge` (default off), plugin `dsh-agent-dag` `liveTools: false`. With the rebuilt adapter and the app restarted, one new session per agent in `/Users/lbc/Desktop/work/pele-diagram-test`, each running `sleep 2 && printf 'FORK6-<AGENT>\n' >> fork6-scratch.txt`:
  | agent (model) | log rows | usage (footer) | Chat | native transcript | scratch |
  |---|---|---|---|---|---|
  | Claude Code `claude-sonnet-5.5` | `bash {command, description}` + result (call `toolu_01Fmkhsb…`), one approval round-trip | 115K tok · 50% | one Bash node | `~/.claude/projects/-Users-lbc-Desktop-work-pele-diagram-test/18cc1a5f…jsonl` created | +1 line |
  | Codex `5.6 Sol` | `bash {command, cwd}` rows: empty output → `(no output)`, `printf 'FORK6-CODEX-OUT\n'` → `FORK6-CODEX-OUT` | 199K tok · 81% | one Bash node per call | `~/.codex/sessions/2026/10/21/rollout-…01a15e1b…jsonl` created | +1 line |
  | Oh My Pi `GPT-5.5` | skill-read row + `bash {command, workdir}` with real output, one approval | 39.9K tok · 65% | one node per call | `~/.omp/agent/sessions/-Desktop-work-pele-diagram-test/…01a15e25…jsonl` created | +1 line |
  (`6 Astra` in the same Codex session was refused by the TokenRouter gateway — `model gpt-6-astra is not available for the requested protocol` — unrelated to the adapter; `5.6 Sol` ran.)
  One existing **imported** session per agent continued in place with a no-tool question (no `New session required` anywhere): Claude `KIWI-19` recalled (native jsonl 388 160 → 413 397 B), Codex `PINEAPPLE` (rollout 269 853 → 322 469 B), Oh My Pi `LYCHEE-23` recalled (jsonl 51 692 → 73 388 B). Trajectory screenshots: `../paseo-agent-dag/.paseo-demo/fork/evidence/desktop-{claude,codex,omp}-new-trajectory.png`.
- **Web profile** (`~/.dsh/profiles/web`) — switched to the fork exactly like the desktop: dep `"@local/dsh-acp-adapter": "link:…/dsh-acp-adapter-fork"`, bundle list swapped, `node_modules/@local/dsh-acp-adapter` symlinked, the `@zaimokuza/dsh-acp-adapter` copy removed, `liveTools: false`. A web-profile host booted against an isolated `DSH_HOME` reports the plugin card `data-plugin-package="@local/dsh-acp-adapter" data-plugin-status="running"` and lists Claude Code / Codex / Oh My Pi in the model picker; resolved version `0.2.1-rc.2.3-fork.3`.
- Known limits: a call with no bytes *and* no exit fact records the omission marker — that is a
  `terminal` content item this connection can no longer read (e.g. a released client terminal on a
  runtime that streams no `_meta` output). A call whose runtime reported its exit without bytes is
  recorded as `(no output)`, like DSH bash.

- **Textless-turn bench round** (rebuilt adapter, bench restarted; prompt `请在当前目录运行这条命令一次（只运行一次，不要做其他事）：sleep 2 && printf '<MARK>\n' >> <file>，然后只回复命令输出。`):
  - Pre-fix build, omp `GPT-5.5` (bench `session-5a5ac684`): reproduced the desktop failure exactly — native row `bash {command, workdir}` + `tool/result` recorded, scratch file +1 line, then omp's native transcript ends in 4× `branch_summary(discarded-entry-branch)` with no final message and the turn settled `{kind:'error', ACP_NO_VISIBLE_RESPONSE}` (desktop `session-1743f9ec` had the same signature). Same prompt with omp `Claude Opus 5.5` completed with text (`session-2a5a91db`), so the empty stops are omp/provider behavior, not the native-rows change.
  - Fixed build, omp `GPT-5.5` + same prompt (bench `session-bf3d883f`): `turn/end {kind:'completed'}`, tool row + result recorded, scratch file +1 line; Chat shows `已完成，用时 29秒`.
  - Pre-fix build, Codex `5.6 Sol` read-shaped command (`cat README.md` via Codex's `exec`, rollout line shows `parsed_cmd [read]`): row `exec_command {}` (bench `session-16955c8b`) — the desktop `session-8876b30e` defect. Fixed build, same prompt (bench `session-05f6b73b`): row `read {"file_path": "…/work/codex/README.md"}`.
  - Unit: `test/unit/host/native-tool-rows.spec.ts`, `test/unit/host/profile-adapter-activity.spec.ts`, `test/unit/host/native-presentation.spec.ts` — 78 tests green; `pnpm build` (tsc + tsdown + verify-bundle) green.

## Rebase procedure

```bash
git remote add upstream git@github.com:zaimokuza-yoshiteru/dsh-acp-adapter.git
git fetch upstream --tags
git checkout -b rebase/<tag> v0.2.1-rc.2.3      # or the tag we ship against
git rebase <tag>
```

Conflicts cluster in the files above; keep the upstream shape and re-apply (a) the recorder
instantiation + `observe` call in `onUpdate`, (b) the `settleOpen` + usage emission before the finish
chunk, (c) the append-options forwarding in `session-facts.ts`, (d) the `teamBridge` gate around the
lease factory, (e) the native-row filter in `acp-chat-normalization.ts`. After rebasing: `pnpm build`,
then `node ../paseo-agent-dag/.paseo-demo/fork/bench-setup.mjs --install` and restart the bench service;
the stored-log format invariants to preserve are in `../paseo-agent-dag/.paseo-demo/fork/RUNBOOK.md`.