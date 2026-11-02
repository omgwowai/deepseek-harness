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
| `src/client/index.ts`, `AcpAuditHeaderAction.ts` (deleted), `acp-support-export.ts` (deleted), locales, docs | **The ACP Diagnostics conversation tab is gone.** The `conversation.view` (`dsh-acp-audit`), its visibility gate and the client audit view/export UI are removed, along with the locale keys only they used; the host side's diagnostics API (`auditTimeline`/`activityPage`, sidecar audit rows) is unchanged, and the recovery dock's own diagnostics remain. |
| `src/client/index.ts`, `cordis.patch.yml`, `tsconfig.json`, docs, tests | Package renamed to `@local/dsh-acp-adapter` (bundle patch row name, client `plugins.bundle.config` key, tests/scripts/docs). Plugin id stays `dsh-acp-adapter`, so route ids (`acp-claude`/`acp-codex`/`acp-omp`), sidecar bindings and profile patches keep working. |
| `src/domain/policy/elicitation.ts`, `permissions.ts`, `src/runtime/native/transports/{omp,claude,codex}.ts`, tests | **Native agent questions use DSH question cards rather than generic approvals.** OMP `ask`/`select`/`confirm`/`input`/`editor`, Claude `AskUserQuestion`, and Codex `requestUserInput`/MCP elicitation preserve the original choices, recommended labels, companion free text, supported multi-selects, and skip/cancel semantics. Plan reviews retain every native option; non-plan tool permissions still use the approval service, and delegated plan reviews fall back to that service only when question cards are unavailable for the caller. Secret-flagged forms fail closed. |
| `src/host/composition/profile-adapter.ts`, `src/persistence/sidecar.ts`, `src/contract/remote.ts`, `src/client/ui/AcpAgentControl.ts`, `agent-session-controls.ts`, locales, docs, tests | **Agent session controls can be changed while a turn runs** (native OMP/Claude/Codex and ACP-route agents alike — one host path). `setAgentSessionOption` no longer throws `ACP_SESSION_OPTIONS_READ_ONLY` for a busy runtime or an in-flight handoff/native prompt: it validates the write exactly like an idle one (`planSessionWrite`) and saves it instead of touching the Agent — a mode in the existing `mode_intents` row, any other non-model option in the new `option_intents` table (`(session, option id)` → string/boolean value, last write wins, scoped to the binding key like a mode intent, migration-safe `CREATE TABLE IF NOT EXISTS`). Choosing the value the Agent already has clears the pending choice; an idle write supersedes it. The pre-prompt seam applies them after `convergeConfig` and `applyMemberMode`: options in option-id order, serialized with dock writes, each confirmed from `runtime.configOptions` and only then cleared (exact match, so a newer choice survives). An option/value the Agent no longer offers, or a replaced binding, is dropped and logged and never fails the turn; a rejected or unconfirmed write fails the prompt with `ACP_CONFIG_SYNC_FAILED` before dispatch, keeps the choice pending and keeps the live runtime so the user can change or cancel it. A context-preserving directory fork carries pending mode/option choices to the replacement binding in the same transaction. Model/reasoning stay on the DSH picker (`ACP_CONFIG_UNSUPPORTED`, unchanged). The snapshot gains `pendingOptions` (id → value); the dock stays enabled for a live session while running, shows pending values as selected and replaces the read-only footer with `agentChangesApplyNext`. Stale/draft and tool-approval-policy behavior are unchanged. |
| `src/host/composition/profile-adapter.ts`, tests | **Turn fence for pending controls.** The turn begins when DSH accepts the prompt, not when this adapter registers its stream: agent-loop `wakeDriver` turns the Agent `running` (the Stop button) and appends `turn/start` synchronously, ahead of `preStep`, `step/start`, `agent/request` and the request that reaches `stream()`, so `sessionOf(id).facts.turnOpen` is already true. A choice made from then on — with a stream registered, or while its prompt is still being accepted and prepared and nothing is registered yet — is recorded in that turn's `TurnControlFence` and waits for the **next** turn: the prompt being prepared never sends what the dock showed as pending, and choosing the Agent's current value before the step reads the intents really cancels a choice made earlier. Until the stream registers the fence lives in `acceptedTurns` (created by the first write); `streamWithGeneration` adopts it instead of creating a new one, and `watchTurnEnd`, `disposeSession` and `close` drop one that no stream adopted (a cancelled turn, or one another route served). `setAgentSessionOption`, `setDraftMode` and `setTeamMemberMode` therefore treat an open turn like a registered handoff (a member whose prompt was accepted is running). A choice made before DSH accepted the prompt is still an idle write (applied immediately, reported as effective). The pre-prompt step (mode + option intents) runs inside the session control-write lock, so a dock write lands entirely before it or entirely after it and is judged against what it left the Agent with. |
| `src/host/composition/profile-adapter.ts`, `src/persistence/sidecar.ts`, `src/remote/service.ts`, `src/domain/policy/permissions.ts`, `src/client/ui/AcpAgentControl.ts`, docs, tests | **Pre-first-prompt modes are route-scoped, need the right grants, and stay available through the first turn; plan reviews keep their approval fallback.** The mode chosen before a session's first prompt (draft menu, `setDraftAgentMode`) is saved in `mode_intents` under `initialModeIntentBindingKey(route)` (`["initial","acp-<profile>"]`); a bare `initial` key is honoured by nobody and the next prompt drops it. Another route's draft shows no choice, and its first prompt neither applies nor fails on it. The binding of the route a choice belongs to carries it out, and `readAgentSessionSnapshotView` reports it as `pendingModeId` as soon as that binding exists, so the trigger label does not fall back to the Agent's default between its start and the choice being applied. Once DSH has accepted the first prompt (`facts.turnOpen`, see the turn fence row), a draft write (under the session control-write lock) marks the turn's `TurnControlFence` and holds the mode chosen before the prompt in `fence.initialMode`: the first turn still starts with it, a later choice waits for turn two and is reported as pending by `draftSessionSnapshot` (before the binding) or by the bound snapshot. The live path does the same when it replaces a route-initial row between the binding and the first pre-prompt step (`queueSessionWrite` captures it, and compares a later choice with the mode the turn will run under rather than the Agent's not-yet-updated one; `applyMemberMode` lets go of it once applied). A draft write that reaches a bound session whose turn is open is queued like `setAgentSessionOption`; one that reaches a bound session without a connected Agent is refused (`Member started running`) instead of being saved where the open turn would apply it. The dock keeps the draft menu enabled while the session runs without a reported snapshot (the first turn's window); a reported stale snapshot stays read-only while a turn runs. Saving a mode needs the caller's own `dshAcp/setAgentSessionOption` and `dshAcp/setDraftAgentMode` grants: the dock disables the choices without both and re-checks the live access source at dispatch, and `AcpRemoteService.setDraftAgentMode` asks `remoteAccess.decide` for both on the session itself (owner and in-process callers are trusted; a Remote call without `remoteAccess` fails closed) before the read gate. `createAcpNativePermissionHandler` asks a plan review (`switch_mode`) as a question with every option and falls back to the Host's binary approval (its allow-once / reject-once options only) when the question service is absent or rejects with `DELEGATED_CALLER` before any card exists; no other question failure, abort or answered card becomes an approval. |
| `src/runtime/native/transports/{contract,claude,claude-commands,claude-interactions,claude-projection,codex,codex-commands,codex-side,codex-immediate,codex-reports,codex-prompts,codex-approvals,codex-projection,omp,omp-commands}.ts`, `src/runtime/native/{native-session-runtime,native-commands}.ts`, `src/host/composition/{native-commands,native-agent-access,installed-profile-registry,profile-adapter}.ts`, `src/domain/session/prompt-content.ts`, `src/client/ui/{AcpCommandRow,command-rows}.ts`, locales, docs, tests | **Vendor slash commands and side questions.** DSH's composer only claims registered host commands, so `/btw` and every other vendor command reached the Agent as plain text (Claude: "`/btw` isn't available in this environment"; Codex/OMP: a model turn on the literal text, or steering into the running turn). Each native route now registers its vendor catalog as agent-scoped DSH commands (`native-commands.ts` replaces the `/compact` shadow): `side` commands (`/btw`; Codex `/side`) answer from the Agent's context through a new `NativeTransport.sideQuestion` (Claude `side_question` control request; Codex ephemeral `thread/fork` + boundary prompt + side turn + unsubscribe; OMP rpc `btw`), concurrently with a running turn, as a command row that never enters the Agent's conversation; `immediate` commands go through `runCommand` without a turn (Claude `get_status`/`get_context_usage`/`get_usage`/`mcp_*`/task ledger + `stop_task`/`rewind_files`…, Codex `status`/`skills`/`mcp`/`ps`/`stop`/`hooks`/`diff`/`new`/`clear`, OMP `new`/`clear`); `prompt` commands, skills and custom commands are forwarded as the next prompt. Host-level `help`, `effort`, `fast`, and `plan` (Claude/Codex native plan mode). Terminal-only commands fail closed with an explanation; a lone `!cmd` runs as the vendor's user shell (`bash_command`, `thread/shellCommand`, rpc `bash`), and the bare-command rule accepts `:`-named vendor commands; vendor retry/fallback/notice frames become in-turn thoughts; `/clear`/`/new` emit `session_changed` and move the binding by a blank rebind (a never-prompted new vendor session that is gone after a restart is replaced by a fresh one); Codex routes notifications/server requests by thread; OMP holds a turn until `session_settled` so wake runs land in it. File attachments need no adapter change: DSH's `dsh-llm` hands every adapter a file as its stored-copy handle text, which the Agent reads with its own tools. |
| `src/runtime/native/transports/{checkpoint-label,claude,claude-interactions,codex,codex-rewind,codex-goal,omp,omp-rewind,omp-goal,omp-overlay}.ts`, `src/host/composition/{native-commands,profile-adapter}.ts`, `src/runtime/native/native-session-runtime.ts`, docs, tests | **`/rewind` and `/goal` on all three native Agents.** `/rewind` lists the user's messages (one shared label rule, `checkpoint-label.ts`, that drops DSH-generated context also from Oh My Pi's joined prompts), previews, and on `confirm` restores files and rolls the conversation back (`code`/`chat` restrict it): Claude `rewind_files` (file checkpointing enabled at launch) + `rewind_conversation`; Codex reverses its recorded `fileChange` items (conflicts left alone) + `thread/revert`; Oh My Pi reverses recorded `edit` changes and branches the session (`branch`; a `write` has no prior content and is reported as not restorable). A rollback emits `session_changed` (reason `rewind`), which the host turns into a blank rebind even when the vendor session id is unchanged, so DSH never assumes the Agent still holds rewound messages. `/goal` shadows DSH's own `/goal` on these routes and uses the Agent's native goal: Claude's CLI command (its `active_goal`/Stop-hook checks as notes); Codex `thread/goal/*` and Oh My Pi rpc `goal`, both inside a DSH turn that stays open while the server continues the goal and pauses it on Stop (Codex releases continuation turns it starts outside a prompt; Oh My Pi gets `goal.continuationModes: [interactive, rpc]` from a private `--config` overlay the transport writes at start and deletes on exit). |
| `src/host/composition/agent-launch.ts`, `profile-adapter.ts`, `test/unit/host/agent-launch.spec.ts` | **Agent Fleet launch attribution.** `prepareAgentLaunch` takes the launching DSH session id (`sessionId`, passed from the turn path in `profile-adapter.ts`) and adds `AGENT_FLEET_VIA=dsh:<id>` to the agent process environment. Deliberately not `AGENT_FLEET_PARENT`: the agent's own tool children inherit that variable, and their parent is the agent's native session (its own session-id variable), not the DSH session two levels up. A launch without a DSH session id leaves the environment untouched. |

Nothing is registered in the DSH tool registry and no `tools/execute` interception exists, so DSH
never executes an ACP tool call; the loop only sees the adapter's outer stream as before.

## Agent Fleet launch attribution

The `dsh-agent-fleet` plugin (a sibling in this pack) links an ACP child to the DSH session that
opened it. Its usual source is the ACP sidecar (`bindings.dsh_session_id` → `acp_session_id`), which
yields a `via: "acp"`, exact link. `AGENT_FLEET_VIA=dsh:<id>` carries the same relation on the
process itself, which is what the fleet collector reads: `/proc/<pid>/environ` once per pid on
Linux, `ps -E` once per new pid on macOS.

```ts
// src/host/composition/agent-launch.ts
/** The DSH session that launches this agent process, for Agent Fleet's process view. */
function fleetEnvironment(env: Record<string, string>, dshSessionId: string): Record<string, string> {
  return { ...env, AGENT_FLEET_VIA: `dsh:${dshSessionId}` }
}
```

- The adapter sets it on the agent process it launches; descendants inherit it, so it is not a
  parent pointer. A tool child of the agent is attached to the agent's native session through that
  agent's own session-id variable (`PI_SESSION_ID`, `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`,
  `DSH_SESSION_ID`), or to `AGENT_FLEET_PARENT` when its launcher sets that. The collector therefore
  uses `AGENT_FLEET_VIA` only when the process's nearest agent ancestor is the DSH host itself (or
  there is none), and otherwise prefers that ancestor's session-id variable.
- Without a DSH session id (a direct runtime launch, unit tests) no variable is added and
  `launch.env` equals the profile environment byte for byte.
- Agents never read it; it only marks the process for the monitor.

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

Local bench (isolated DSH home and agent homes, `liveTools: false`),
fresh sessions per agent, prompt `sleep 2 && printf '<mark>' >> acp-row-check-<agent>.txt` then `DONE`:

- **Oh My Pi** — one turn, continuing an existing session: `assistant{tool-call}` → `tool/call` → `tool/result` → usage `{…, totalTokens 34940}`; Trajectory TOOL row; footer `62.5K tok · Cache hit 76%`; reload clean; scratch file 3 turns = 3 lines. (Recorded with the pre-dedup build; the dedup hides its card on reload — verified.)
- **Claude Code** (`claude-sonnet-5.5`) — `bash` row with the real `{command, description}` (the rawInput-wait fix), `tool/result` with Claude's call id, usage `{totalTokens 99230}`, footer `99.2K tok · Cache hit 50%`, one Chat row, one approval round-trip, scratch file +1 line, log re-folds cleanly.
- **Codex** (`6 Astra`) — `exec_command → bash` with `cmd → command` rename and real `{command, cwd}`, `tool/result` (`exec-…` call id), usage `{totalTokens 29948}`, footer `29.9K tok · Cache hit 50%`, one Chat row after reload, scratch file +1 line.
  **Shell results carry the real bytes** (rebuilt adapter, bench session-01ca4249): `printf 'FORK6-out\n' && exit 7` records content `FORK6-out\n` + `[exit code: 7]` (`isError: true`, rows 33/34); a 70 001-byte `print('x'*70000)` records exactly 64 000 bytes + `[output truncated]` (row 45). Re-checked on the final build: `printf 'FORK6-FINAL\n' && exit 5` → `FORK6-FINAL\n` + `[exit code: 5]`. Trajectory shows both rows with real arguments; Chat shows one Bash card per call.
- **Desktop** (`~/.dsh/profiles/desktop`) — `@local/dsh-acp-adapter` (link to this repo) loaded, routes `acp-claude`/`acp-codex`/`acp-omp` registered, adapter config has no `teamBridge` (default off), plugin `dsh-agent-dag` `liveTools: false`. With the rebuilt adapter and the app restarted, one new session per agent in a scratch workspace, each running `sleep 2 && printf 'FORK6-<AGENT>\n' >> fork6-scratch.txt`:
  | agent (model) | log rows | usage (footer) | Chat | native transcript | scratch |
  |---|---|---|---|---|---|
  | Claude Code `claude-sonnet-5.5` | `bash {command, description}` + result, one approval round-trip | 115K tok · 50% | one Bash node | `~/.claude/projects/<workspace-slug>/<id>.jsonl` created | +1 line |
  | Codex `5.6 Sol` | `bash {command, cwd}` rows: empty output → `(no output)`, `printf 'FORK6-CODEX-OUT\n'` → `FORK6-CODEX-OUT` | 199K tok · 81% | one Bash node per call | `~/.codex/sessions/2026/10/21/rollout-…01a15e1b…jsonl` created | +1 line |
  | Oh My Pi `GPT-5.5` | skill-read row + `bash {command, workdir}` with real output, one approval | 39.9K tok · 65% | one node per call | `~/.omp/agent/sessions/<workspace-slug>/…jsonl` created | +1 line |
  (`6 Astra` in the same Codex session was refused by the TokenRouter gateway — `model gpt-6-astra is not available for the requested protocol` — unrelated to the adapter; `5.6 Sol` ran.)
  One existing **imported** session per agent continued in place with a no-tool question (no `New session required` anywhere): Claude, Codex and Oh My Pi each recalled an earlier marker word and appended to their own native transcript.
- **Web profile** (`~/.dsh/profiles/web`) — switched to the fork exactly like the desktop: dep `"@local/dsh-acp-adapter": "link:<this directory>"`, bundle list swapped, the `@zaimokuza/dsh-acp-adapter` bundle removed, `liveTools: false`. A web-profile host booted against an isolated `DSH_HOME` reports the plugin card `data-plugin-package="@local/dsh-acp-adapter" data-plugin-status="running"` and lists Claude Code / Codex / Oh My Pi in the model picker; resolved version `0.2.1-rc.2.3-fork.3`.
- Known limits: a call with no bytes *and* no exit fact records the omission marker — that is a
  `terminal` content item this connection can no longer read (e.g. a released client terminal on a
  runtime that streams no `_meta` output). A call whose runtime reported its exit without bytes is
  recorded as `(no output)`, like DSH bash.

- **Textless-turn bench round** (rebuilt adapter, bench restarted; prompt `请在当前目录运行这条命令一次（只运行一次，不要做其他事）：sleep 2 && printf '<MARK>\n' >> <file>，然后只回复命令输出。`):
  - Pre-fix build, omp `GPT-5.5` (bench `session-5a5ac684`): reproduced the desktop failure exactly — native row `bash {command, workdir}` + `tool/result` recorded, scratch file +1 line, then omp's native transcript ends in 4× `branch_summary(discarded-entry-branch)` with no final message and the turn settled `{kind:'error', ACP_NO_VISIBLE_RESPONSE}` (desktop `session-1743f9ec` had the same signature). Same prompt with omp `Claude Opus 5.5` completed with text (`session-2a5a91db`), so the empty stops are omp/provider behavior, not the native-rows change.
  - Fixed build, omp `GPT-5.5` + same prompt (bench `session-bf3d883f`): `turn/end {kind:'completed'}`, tool row + result recorded, scratch file +1 line; Chat shows `已完成，用时 29秒`.
  - Pre-fix build, Codex `5.6 Sol` read-shaped command (`cat README.md` via Codex's `exec`, rollout line shows `parsed_cmd [read]`): row `exec_command {}` (bench `session-16955c8b`) — the desktop `session-8876b30e` defect. Fixed build, same prompt (bench `session-05f6b73b`): row `read {"file_path": "…/work/codex/README.md"}`.
  - Unit: `test/unit/host/native-tool-rows.spec.ts`, `test/unit/host/profile-adapter-activity.spec.ts`, `test/unit/host/native-presentation.spec.ts` — 78 tests green; `pnpm build` (tsc + tsdown + verify-bundle) green.

## ACP interaction verification (2026-10-28)

- Actual DSH **web and desktop**: OMP, Claude Code and Codex question cards preserved their original options and returned custom text, skip, and supported multi-select answers. Claude and Codex plan cards completed their approval/implementation paths. Codex Default mode still cannot use `requestUserInput`, and OMP `rpc-ui` exposes no Plan mode; these are client limitations, not adapter fallbacks.
- Pending mode/option changes survived reload, reverted cleanly, stayed out of the accepted turn, and applied before the next turn. After the `turnOpen` fence fix, approximately 26 in-page early picks (26–187 ms after Enter, plus the nominal 200–550 ms matrix) produced **zero first-turn leaks** across web/desktop Claude and Codex; pre-send choices still initialized turn 1, and warm-session early picks behaved the same way. Route-scoped draft choices survived same-route return without crossing to the other agent.
- Claude native transcripts kept `effort: high` throughout turn 1 and recorded `low` on turn 2; OMP wrote `thinking_level_change: low` after turn 1 and before turn 2. The reported wrong-mode label flash did not reproduce; only a <=25 ms trigger remount with no text was observed.
- Final checks on Node 22.23.3: typecheck passed; **169 test files / 2396 tests passed** (1 file / 13 tests skipped); build and `verify-bundle` passed. The toolchain warned that `.nvmrc` pins 24.19.0, so this is not a pinned-toolchain release check.

The verification records (notes, result JSON and screenshots) are kept with the local test runs, outside this repository; they retain the old-lib failures for comparison.

## Native agent commands verification (2026-10-28)

- Reproduced first on the unchanged build in a real DSH web host: Claude `/btw what is 2+2?` became a DSH turn answered `/btw isn't available in this environment.`
- Isolated DSH 0.2.1-rc.2 web host (own `DSH_HOME`, isolated agent homes, the same claude-agent-acp / codex-acp / Paseo launcher wiring as the `web` profile), Claude Code 2.1.296, Codex 0.162.1, Oh My Pi 18.12.6 on the TokenRouter gateway: the `/` palette lists each vendor's commands; `/btw` (Codex also `/side`) answered from context while idle and while a `sleep` tool turn ran (3–13 s, main turn unaffected, nothing written to the vendor transcript or main rollout); Claude `/status /context /usage /help /mcp /tasks /diff /memory /skills /hooks /permissions` and Codex `/status /diff /mcp /skills /hooks /ps /help` answered in about 1 s without a turn; `!cmd` ran as a 0-token shell row on all three; Codex `/theme` and OMP `/settings` failed closed; `/plan`/`/plan off` switched Claude's mode; `/effort low` reached the model picker; Claude `/clear` and Codex/OMP `/new` reset the context and stayed reset across a host restart, including a new Codex thread that was never prompted (fresh session, no recovery gate); Claude `/rewind` previewed and restored a file.
- Desktop (`~/.dsh/profiles/desktop`, bili lanes active), relaunched through the app's own quit path on this build: the `/` menu lists the vendor commands; `/btw` (Codex `/side`) answered from context while idle and while a foreground shell command ran — Claude 3 s, Codex 3–4 s, Oh My Pi 2–7 s, main turns unaffected; `/status` answered without a turn. While a tool-approval card is open DSH replaces the composer, so a side question is asked before or after answering the card.
- `/rewind` and `/goal` for all three, in the same web host: after two turns (the second wrote a file and gave a second codeword), `/rewind` listed both messages by the user's own text, `/rewind 2` previewed, `/rewind 2 confirm` restored the file (Claude from its checkpoints, Codex by reversing its recorded change) and rolled the conversation back — the next answer knew only the first codeword on all three; Oh My Pi continued in a branched session and reported the file written with `write` as not restorable. `/goal <objective>` ran each Agent's native goal to completion inside one DSH turn (the file was created; Codex and Oh My Pi marked the goal complete); `/goal clear` dropped it.
- Typecheck passed; **172 test files / 2753 tests passed** (22 skipped: live-vendor suites and `OMP_NATIVE_E2E=0`); build and `verify-bundle` passed (Node 22.23.3, not the pinned 24.19.0).

Per-command support table: [`docs/native-commands.en.md`](docs/native-commands.en.md) ([中文](docs/native-commands.md)). The audits, design notes and E2E records are kept with the local test runs, outside this repository.

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
lease factory, (e) the native-row filter in `acp-chat-normalization.ts`. After rebasing: `pnpm build`
and re-run the adapter's unit suite; then reinstall into a scratch DSH profile (see the parent README) and
check that a tool turn of each agent still records one `tool/call` + `tool/result` pair in the stored log.