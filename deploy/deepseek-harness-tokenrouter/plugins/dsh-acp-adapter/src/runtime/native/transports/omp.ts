/// <reference types="node" />
/**
 * Oh My Pi (`omp`) native transport.
 *
 * Drives `omp --mode rpc-ui` (JSONL over stdio) and reports everything exactly as OMP's own ACP
 * agent (`omp acp`: src/modes/acp/acp-agent.ts + acp-event-mapper.ts) would, so state DSH saved
 * under the ACP route stays valid:
 *
 * - Identity. The ACP session id is the OMP session id. `new` runs rpc `new_session` (which, like
 *   ACP `session/new`, writes the session file immediately, so the id is resumable before its first
 *   prompt). `resume` resolves the id to a session FILE the way `AcpAgent#findStoredSession` does
 *   (the cwd's session directory first, then every session directory) and attaches it with rpc
 *   `switch_session` on the freshly booted session — the same `createSession(cwd)` +
 *   `switchSession(path)` sequence ACP runs, including OMP's refusal to switch to a session that was
 *   recorded for another cwd. `fork` is `switch_session(parent)` + rpc `fork`
 *   (`AcpAgent#forkManagedSession`). The process cwd is always the session cwd the host passes.
 * - Controls. `mode` / `model` / `thinking` follow `AcpAgent#buildConfigOptions`: ids, categories,
 *   names, descriptions and value strings (`provider/id` models; `off`, `auto` and the model's levels
 *   as thinking values). Models come from rpc `get_available_models`, levels from
 *   `get_available_thinking_levels`.
 *   Plan mode CANNOT be switched on over `--mode rpc-ui` (OMP has no rpc command for it; `/plan` is
 *   a TUI-only handler; extensions have no plan API). ACP lists `plan` next to `default` when
 *   `plan.enabled`; the native mode list is `default` only, so the UI never offers a mode that cannot
 *   be applied, and `setConfigOption('mode', 'plan')` still rejects with `plan-mode-unsupported`. ACP
 *   does not restore plan state on session load either: the current mode is always `default`.
 *   `fast` (and `slow`, for models that support it) are boolean extras driven by `set_fast_mode` / `set_slow_mode`.
 * - Projection. Frames map onto ACP updates with the logic of `acp-event-mapper.ts`:
 *   `tool_call` / `tool_call_update` (kind, title, rawInput/rawOutput, locations, text + diff
 *   content, the vendor tool `name`), `agent_message_chunk` / `agent_thought_chunk` with a per-message
 *   `messageId`, `plan` from the todo tool, `session_info_update`. Like ACP, turn content is only forwarded
 *   while a `prompt()` owns the turn. Slash-command output loses its terminal escapes, and retry, fallback,
 *   compaction, extension and warning notices become one-line thoughts inside the turn.
 * - Usage. Each assistant `message_end.message.usage` is summed over the whole prompt; context
 *   occupancy and cumulative cost come from `get_session_stats`.
 * - Steering. `steer()` never starts a turn (idle → `promptRequired`, like ACP's `_session/steering`);
 *   inside a running turn it returns `injected` only after OMP's three-stage proof: `queue_update`
 *   admits the text, a later `queue_update` drops it, and a `role:"user"` message flagged
 *   `steering`/`liveSteered` lands in the transcript.
 * - Approvals and questions. DSH runs unattended, so the process starts with `--auto-approve` unless the
 *   launcher already carries an approval flag. A tool-approval `extension_ui_request {method:"select"}`
 *   (title `Allow tool: <name>`) that still arrives is forwarded through `onPermission` in ACP shape and
 *   answered with the chosen label. Every other dialog is a question for the user: when the host passes
 *   `onElicitation` the transport opts in to OMP's rich `ask` dialog (rpc `set_ask_dialog`) and puts `ask`,
 *   non-approval `select`, `confirm`, `input` and `editor` to it as the same form omp acp's extension UI
 *   context sends (`q<i>` / `q<i>__other` for `ask`, a required `value` for the rest), then answers the OMP
 *   dialog from the response; decline, cancel or a failure dismisses it. Without `onElicitation` the dialogs
 *   are dismissed, as omp acp does for a client without form elicitation. OMP's own `cancel` frame withdraws
 *   the pending prompt or form.
 * - Commands. omp's catalog (`available_commands_update`) reaches the host as a `commands` event instead of an
 *   ACP update. Every omp command runs through `prompt` ("/name args"); the transport adds the builtins omp keeps
 *   terminal-only and serves itself: `btw` (side question), `new` and `clear` (a fresh session, idle only, reported
 *   with `session_changed`), `rewind` (below) and `goal` (below). omp hands the other terminal-only builtins
 *   (`/settings`, `/tree`, `/plan`, …) to the model as plain text, so `prompt()` answers them locally, unless the
 *   live catalog gives the name to an extension, custom or file command. A lone `!cmd` is omp's user shell
 *   (rpc `bash`): one `execute` tool call, no model call.
 * - Side questions. `sideQuestion()` is rpc `btw`. The running record, the deltas and the final record are
 *   frames, not responses, so the waiter exists before the command is written; none of those frames ever
 *   reaches the turn, and the question runs beside a streaming prompt.
 * - Wake turns. When the agent yields while background work can still wake it (`prompt_result` with
 *   `sessionSettled:false`), the turn stays open until `session_settled`, so the wake run's output reaches
 *   the same host turn. The hold ends when the user acts or nothing happens for `WAKE_SETTLE_MS`. A prompt
 *   sent while a run the transport did not start is streaming is queued behind it (`followUp`).
 * - Goals. `/goal` is rpc `goal` (get, create, pause, resume, drop). omp continues an active goal by itself only in the
 *   run modes of `goal.continuationModes` (default: `interactive` alone), so `start()` writes a private config overlay
 *   that adds `rpc` and launches omp with `--config <overlay>` (`omp-overlay.ts`; it goes once the process is gone).
 *   `/goal` is a `prompt` command, not an immediate one, because an active goal makes omp start runs of its own: when
 *   omp reports it is not settled after the command, the turn is held like a wake turn so those runs reach it and the
 *   user can stop them. `goal_updated` frames become one-line notes.
 * - Rewind. `/rewind` goes back to just before one of the user's messages: the conversation with rpc `branch` (a new
 *   session, announced with `session_changed`), the files from what the agent's file tools recorded in the session
 *   entries (`get_entries`, see `omp-rewind.ts`). It refuses to change anything while a turn runs.
 *
 * The process is spawned only through `options.spawn` (the host subprocess seam owns env merging and
 * process-tree teardown); nothing here reads the host environment, cwd or PATH.
 */
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextDecoder } from 'node:util'
import type * as acp from '@agentclientprotocol/sdk'

import { NativeTransportError } from './contract.ts'
import { OMP_NATIVE_COMMANDS, OMP_SERVED_COMMAND_NAMES, OMP_TERMINAL_ONLY_COMMANDS } from './omp-commands.ts'
import {
  GOAL_USAGE,
  GOAL_WAITS,
  formatGoal,
  goalFailure,
  goalNote,
  parseGoalArgs,
  parseOmpGoal,
  type GoalRequest,
  type OmpGoal,
} from './omp-goal.ts'
import { createOmpConfigOverlay, type OmpConfigOverlay } from './omp-overlay.ts'
import {
  applyRestore,
  findCheckpoint,
  nodeRestoreIo,
  parseRewindArgs,
  planRestore,
  readRewindModel,
  renderCheckpoints,
  renderRewindPreview,
  renderRewindResult,
  shownPath,
  type OmpFileChange,
  type OmpRewindModel,
  type RestoreIo,
  type RewindPoint,
} from './omp-rewind.ts'
import type {
  NativeCommand,
  NativeCommandResult,
  NativeElicitationHandler,
  NativeElicitationRequest,
  NativeContentBlock,
  NativeContextUsage,
  NativeControls,
  NativePermissionDecision,
  NativePermissionHandler,
  NativePermissionRequest,
  NativeProcess,
  NativePromptResult,
  NativeSessionTarget,
  NativeTransport,
  NativeTransportEvent,
  NativeTransportStartOptions,
  NativeTurnUsage,
} from './contract.ts'

/**
 * `start()` waits this long for the first `{"type":"ready"}` frame. OMP loads its extensions and provider
 * catalog before it is ready: about 5 s on an idle machine, 27 s measured at load average 80. A dead
 * process fails fast through its exit; this bound only catches one that lives but never becomes ready.
 */
const READY_TIMEOUT_MS = 90_000
/** Default wall-clock timeout for control-plane RPCs. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
/** `get_available_models` awaits OMP's background provider discovery and may touch the network. */
const MODEL_LIST_TIMEOUT_MS = 30_000
/** Session switches load (and may migrate) a whole transcript. */
const SESSION_COMMAND_TIMEOUT_MS = 60_000
/** Context occupancy is re-read at this cadence while a turn is running. */
const CONTEXT_POLL_INTERVAL_MS = 3_000
/** How long `steer()` waits for the three-stage injection proof before rolling back. */
const DEFAULT_STEER_TIMEOUT_MS = 10_000
/** After a rejected prompt acknowledgement, wait this long for a late `prompt_result`. */
const PROMPT_ADMISSION_GRACE_MS = 1_500
/** Wait this long after the run's terminal frame before settling a prompt without `prompt_result`. */
const PROMPT_RESULT_FALLBACK_MS = 1_500
/** After a cancellation (abort signal, `abort_bash`, `btw_cancel`), wait this long for the vendor to confirm it. */
const ABORT_SETTLE_GRACE_MS = 10_000
/** A side question is one full-context model call; the watchdog cancels one the model never finishes. */
const BTW_TIMEOUT_MS = 180_000
/**
 * A prompt whose agent yielded while background work remains stays open this long without any activity, waiting
 * for the wake run; a run that is streaming keeps it open.
 */
const WAKE_SETTLE_MS = 120_000
/** Context-usage read used when a turn settles. */
const TURN_END_CONTEXT_TIMEOUT_MS = 3_000
/** `stdin.end()` → wait → host terminate (spec §1.4). */
const STDIN_CLOSE_GRACE_MS = 3_000
const TERMINATE_WAIT_MS = 5_000
const VERSION_PROBE_TIMEOUT_MS = 10_000
/** `start()` waits at most this long for the (usually long finished) version probe. */
const VERSION_WAIT_MS = 2_000
/** stderr is diagnostics only; keep its tail for error reports. */
const STDERR_BUFFER_LIMIT = 8_192
/** RPC v2 framing limits (spec §2.3). */
const MAX_FRAME_BYTES = 1_048_576
const MAX_REASSEMBLED_BYTES = 67_108_864
const MAX_CHUNK_BYTES = 262_144
const MAX_CHUNK_DECODED_CHARS = Math.ceil(MAX_CHUNK_BYTES / 3) * 4
const MAX_CHUNK_COUNT = Math.ceil(MAX_REASSEMBLED_BYTES / MAX_CHUNK_BYTES)
/** Failed `get_available_models` retries: delays before attempt 1..n. */
const MODEL_LIST_RETRY_DELAYS_MS: readonly number[] = [5_000, 20_000, 60_000]

const ACP_MODE_ID_DEFAULT = 'default'
const ACP_MODE_ID_PLAN = 'plan'
const THINKING_OFF = 'off'
const THINKING_AUTO = 'auto'
/** Selectors `AcpAgent#setThinkingLevelById` accepts (`parseConfiguredThinkingLevel`), minus `inherit`. */
const THINKING_SELECTORS: Readonly<Record<string, true>> = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
  auto: true,
}

type JsonObject = Record<string, unknown>

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type Deferred<T> = PromiseWithResolvers<T>

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

function readStringArray(value: unknown): string[] {
  const array = readArray(value)
  if (array === undefined) return []
  const result: string[] = []
  for (const item of array) {
    const text = readString(item)
    if (text !== undefined) result.push(text)
  }
  return result
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** What omp said when it refused a command; any other failure is described by its own message. */
function refusalText(error: unknown): string {
  return error instanceof NativeTransportError && error.code === 'request-failed' ? (error.detail ?? error.message) : errorText(error)
}

/** The first line of an OMP tool-approval `select` (`tools/approval.ts`): the dialog is a permission request, not a question. */
const OMP_APPROVAL_TITLE = /^Allow tool:\s*\S+/
/** The free-text companion option omp acp appends to every `ask` question. */
const OMP_ASK_OTHER_TITLE = 'Other (type your own)'

/** The single-field form omp acp builds for `select` / `confirm` / `input` / `editor`: property `value`, required. */
function valueForm(property: acp.ElicitationPropertySchema): acp.ElicitationSchema {
  return { type: 'object', properties: { value: property }, required: ['value'] }
}

/** `typeof value === 'string'` answers `{ value }`; anything else dismisses the dialog (acp returns `undefined`). */
function decodeStringValue(content: JsonObject): JsonObject | undefined {
  return typeof content.value === 'string' ? { value: content.value } : undefined
}

interface OmpAskQuestion {
  readonly id: string
  readonly question: string
  readonly header: string | undefined
  readonly options: ReadonlyArray<{ readonly label: string; readonly description: string | undefined }>
  readonly multi: boolean
  readonly recommended: number | undefined
}

/** The questions of an `ask` frame (`RpcAskDialogQuestion[]`); `undefined` when the frame is malformed or empty. */
function parseOmpAskQuestions(value: unknown): OmpAskQuestion[] | undefined {
  const raw = readArray(value)
  if (raw === undefined || raw.length === 0) return undefined
  const questions: OmpAskQuestion[] = []
  for (const entry of raw) {
    const item = asObject(entry)
    const id = readString(item?.id)
    const question = readString(item?.question)
    const rawOptions = readArray(item?.options)
    if (item === undefined || id === undefined || question === undefined || rawOptions === undefined) return undefined
    const options: Array<{ label: string; description: string | undefined }> = []
    for (const rawOption of rawOptions) {
      const option = asObject(rawOption)
      const label = readString(option?.label)
      if (label === undefined) return undefined
      options.push({ label, description: readString(option?.description) })
    }
    questions.push({
      id,
      question,
      header: readString(item.header),
      options,
      multi: item.multi === true,
      recommended: readNumber(item.recommended),
    })
  }
  return questions
}

/** The form omp acp's `askDialog` sends: `q<i>` options field plus a `q<i>__other` free-text companion, no `required`. */
function buildOmpAskForm(questions: readonly OmpAskQuestion[]): NativeElicitationRequest {
  const properties: Record<string, acp.ElicitationPropertySchema> = {}
  for (const [index, question] of questions.entries()) {
    const key = `q${index}`
    const entries = question.options.map((option) => {
      const description = option.description?.trim()
      return {
        const: option.label,
        title: option.label,
        ...(description !== undefined && description.length > 0 ? { description } : {}),
      }
    })
    const description = question.header?.trim()
    if (entries.length > 0) {
      if (question.multi) {
        properties[key] = {
          type: 'array',
          title: question.question,
          ...(description ? { description } : {}),
          items: { anyOf: entries },
        }
      } else {
        const recommended = question.recommended
        const recommendedOption =
          recommended !== undefined && recommended >= 0 && recommended < question.options.length
            ? question.options[recommended]
            : undefined
        properties[key] = {
          type: 'string',
          title: question.question,
          ...(description ? { description } : {}),
          oneOf: entries,
          ...(recommendedOption !== undefined ? { default: recommendedOption.label } : {}),
        }
      }
    }
    properties[`${key}__other`] = { type: 'string', title: OMP_ASK_OTHER_TITLE }
  }
  return {
    message: questions.length === 1 ? (questions[0]?.question ?? '') : `Answer ${questions.length} questions`,
    requestedSchema: { type: 'object', properties },
  }
}

/**
 * The `answers` of an `extension_ui_response` for an accepted `ask` form, one per question in order, decoded as
 * omp acp does. A single-select with typed text keeps the text and drops the pick, and labels are offered and
 * unique, so OMP's `parseAskDialogResponse` accepts the answer.
 */
function decodeOmpAskAnswers(
  questions: readonly OmpAskQuestion[],
  content: JsonObject,
): Array<{ id: string; selectedOptions: string[]; customInput?: string }> {
  return questions.map((question, index) => {
    const key = `q${index}`
    const labels = question.options.map((option) => option.label)
    const otherValue = content[`${key}__other`]
    const customInput = typeof otherValue === 'string' && otherValue.trim().length > 0 ? otherValue.trim() : undefined
    const value = content[key]
    let selectedOptions: string[] = []
    if (question.multi) {
      if (Array.isArray(value)) {
        selectedOptions = [...new Set(value.filter((candidate): candidate is string => typeof candidate === 'string' && labels.includes(candidate)))]
      }
    } else if (customInput === undefined && typeof value === 'string' && labels.includes(value)) {
      selectedOptions = [value]
    }
    return { id: question.id, selectedOptions, ...(customInput === undefined ? {} : { customInput }) }
  })
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new Error(reason === undefined ? 'Aborted' : String(reason))
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const result = Promise.withResolvers<T>()
  const timer = setTimeout(() => {
    result.reject(new NativeTransportError(`${label} timed out`, 'timeout', `${label} timeoutMs=${timeoutMs}`))
  }, timeoutMs)
  promise.then(
    (value) => {
      clearTimeout(timer)
      result.resolve(value)
    },
    (error: unknown) => {
      clearTimeout(timer)
      result.reject(error instanceof Error ? error : new Error(String(error)))
    },
  )
  return result.promise
}

/** `promise`'s value, or `undefined` when it does not settle within `timeoutMs`; leaves no timer behind. */
async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  const timeout = Promise.withResolvers<undefined>()
  const timer = setTimeout(timeout.resolve, timeoutMs)
  try {
    return await Promise.race([promise, timeout.promise])
  } finally {
    clearTimeout(timer)
  }
}

/** Reject with the abort reason as soon as `signal` fires; the work itself keeps running. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(abortReason(signal))
  const result = Promise.withResolvers<T>()
  const onAbort = (): void => result.reject(abortReason(signal))
  signal.addEventListener('abort', onAbort, { once: true })
  promise.then(
    (value) => {
      signal.removeEventListener('abort', onAbort)
      result.resolve(value)
    },
    (error: unknown) => {
      signal.removeEventListener('abort', onAbort)
      result.reject(error instanceof Error ? error : new Error(String(error)))
    },
  )
  return result.promise
}

/** Join host content into OMP's `message` + `images` payload (`AcpAgent#convertPromptBlocks`). */
function splitContent(content: readonly NativeContentBlock[]): {
  readonly message: string
  readonly images: Array<{ readonly type: 'image'; readonly data: string; readonly mimeType: string }>
} {
  const parts: string[] = []
  const images: Array<{ type: 'image'; data: string; mimeType: string }> = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
    else images.push({ type: 'image', data: block.data, mimeType: block.mimeType })
  }
  return { message: parts.join('\n\n').trim(), images }
}

// ---------------------------------------------------------------------------
// Slash commands and shell escapes
// ---------------------------------------------------------------------------

/** CSI and OSC sequences (colors, cursor moves, hyperlinks): the host gets plain text, not terminal output. */
const ANSI_SEQUENCE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-Z\\-_])/g

/** The command name of a `/name args` message as omp parses it (`parseSlashCommand`): up to the first space or `:`. */
function slashCommandName(message: string): string | undefined {
  if (!message.startsWith('/')) return undefined
  const body = message.slice(1)
  const end = body.search(/[\s:]/)
  const name = end === -1 ? body : body.slice(0, end)
  return name.length === 0 ? undefined : name
}

/** What follows the command name, as omp parses it: everything after the first space or `:`, trimmed. */
function slashCommandArgs(message: string): string {
  const body = message.slice(1)
  const end = body.search(/[\s:]/)
  return end === -1 ? '' : body.slice(end + 1).trim()
}

const TERMINAL_ONLY_COMMANDS: Readonly<Record<string, true>> = Object.fromEntries(
  OMP_TERMINAL_ONLY_COMMANDS.map((name) => [name, true] as const),
)
/** The terminal-only builtins the transport serves itself (`btw`, `new`, `clear`, `rewind`, `goal`). */
const SERVED_COMMANDS: Readonly<Record<string, true>> = Object.fromEntries(
  OMP_SERVED_COMMAND_NAMES.map((name) => [name, true] as const),
)

/** The user's `!cmd` shell escape: the host sends it bare, as the only content block. */
function userShellLine(content: readonly NativeContentBlock[]): string | undefined {
  const [only] = content
  if (content.length !== 1 || only?.type !== 'text') return undefined
  const line = only.text.trim()
  return line.startsWith('!') ? line : undefined
}

/** What a `bash` result shows next to its output: the facts the output alone does not state. */
function shellResultText(result: JsonObject): string {
  const lines: string[] = []
  const output = (readString(result.output) ?? '').replace(ANSI_SEQUENCE, '').trimEnd()
  if (output.length > 0) lines.push(output)
  if (readBoolean(result.truncated) === true) {
    lines.push(
      `[output truncated: ${readNumber(result.outputLines) ?? '?'} of ${readNumber(result.totalLines) ?? '?'} lines shown]`,
    )
  }
  if (readBoolean(result.timedOut) === true) lines.push('[timed out]')
  const exitCode = readNumber(result.exitCode)
  if (exitCode !== undefined && exitCode !== 0) lines.push(`[exit code ${exitCode}]`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Launch arguments
// ---------------------------------------------------------------------------

/** Flags that select the protocol or the session: the transport owns them, so launcher copies are dropped. */
const OWNED_VALUE_FLAGS: Readonly<Record<string, true>> = {
  '--mode': true,
  '--session': true,
  '--resume': true,
  '-r': true,
  '--fork': true,
  '--restore': true,
}
const OWNED_BOOLEAN_FLAGS: Readonly<Record<string, true>> = {
  '--no-session': true,
  '--continue': true,
  '-c': true,
  '--print': true,
  '-p': true,
}

export interface OmpLaunchPlan {
  /** Executable first, then the arguments to spawn. */
  readonly argv: readonly string[]
  /** Same executable and launcher arguments with `--version`: prints the OMP version and exits. */
  readonly versionArgv: readonly string[]
  /** Launcher arguments the transport owns and therefore dropped (for the host log). */
  readonly dropped: readonly string[]
}

/**
 * Turn the launcher argv (`[omp, ...configured args]`) into the rpc-ui argv. The ACP subcommand `acp`
 * and every protocol/session-selecting flag are removed (sessions stay persisted: `--no-session` would
 * make ids unresumable); `--mode rpc-ui` is appended, plus `--auto-approve` unless the launcher
 * already chose an approval mode. Extension flags (`-e <file>`) pass through untouched. `overlayFile` (see
 * `omp-overlay.ts`) is appended as the last `--config`: omp merges `--config` files in the order given, later over
 * earlier, so it also wins over a `--config` of the launcher. The version probe never gets it.
 */
export function buildOmpLaunchArgv(argv: readonly string[], overlayFile?: string): OmpLaunchPlan {
  const [executable, ...rest] = argv
  if (executable === undefined || executable.length === 0) {
    throw new NativeTransportError('OMP launch argv is empty', 'spawn-failed')
  }
  const kept: string[] = []
  const dropped: string[] = []
  let approvalChosen = false
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    if (arg === undefined) continue
    if (index === 0 && arg === 'acp') {
      dropped.push(arg)
      continue
    }
    if (Object.hasOwn(OWNED_VALUE_FLAGS, arg)) {
      dropped.push(arg)
      const next = rest[index + 1]
      if (next !== undefined && !next.startsWith('-')) {
        dropped.push(next)
        index += 1
      }
      continue
    }
    const equals = arg.indexOf('=')
    if (arg.startsWith('--') && equals > 0 && Object.hasOwn(OWNED_VALUE_FLAGS, arg.slice(0, equals))) {
      dropped.push(arg)
      continue
    }
    if (Object.hasOwn(OWNED_BOOLEAN_FLAGS, arg)) {
      dropped.push(arg)
      continue
    }
    if (
      arg === '--auto-approve' ||
      arg === '--yolo' ||
      arg === '--approval-mode' ||
      arg.startsWith('--approval-mode=')
    ) {
      approvalChosen = true
    }
    kept.push(arg)
  }
  return {
    argv: [
      executable,
      ...kept,
      '--mode',
      'rpc-ui',
      ...(approvalChosen ? [] : ['--auto-approve']),
      ...(overlayFile === undefined ? [] : ['--config', overlayFile]),
    ],
    versionArgv: [executable, ...kept, '--version'],
    dropped,
  }
}

/** argv for the host log: values that follow credential-looking flags are masked. */
function redactArgv(argv: readonly string[]): string {
  const out: string[] = []
  let mask = false
  for (const arg of argv) {
    if (mask) {
      out.push('***')
      mask = false
      continue
    }
    if (/^--?[\w-]*(key|token|secret|password)[\w-]*$/i.test(arg)) mask = true
    out.push(/^--?[\w-]*(key|token|secret|password)[\w-]*=/i.test(arg) ? `${arg.split('=')[0]}=***` : arg)
  }
  return out.join(' ')
}

// ---------------------------------------------------------------------------
// Session files
// ---------------------------------------------------------------------------

const SESSION_HEADER_READ_BYTES = 16_384
const SESSION_TAIL_BLOCK_BYTES = 65_536
const SESSION_TAIL_MAX_BYTES = 8 * 1024 * 1024
const SESSION_HEADER_SCAN_LIMIT = 5_000
const SESSION_HEADER_SCAN_CONCURRENCY = 8

export interface OmpSessionHeader {
  readonly id: string
  readonly cwd: string | undefined
}

/** The `{"type":"session"}` record near the top of an OMP session file. */
export async function readOmpSessionHeader(file: string): Promise<OmpSessionHeader | undefined> {
  let handle: FileHandle
  try {
    handle = await open(file, 'r')
  } catch {
    return undefined
  }
  try {
    const buffer = Buffer.allocUnsafe(SESSION_HEADER_READ_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, SESSION_HEADER_READ_BYTES, 0)
    for (const line of buffer.toString('utf8', 0, bytesRead).split('\n')) {
      if (!line.startsWith('{')) continue
      let record: unknown
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      const object = asObject(record)
      if (object === undefined || object.type !== 'session') continue
      const id = readString(object.id)
      if (id !== undefined) return { id, cwd: readString(object.cwd) }
    }
    return undefined
  } catch {
    return undefined
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function listDirectory(dir: string): Promise<Array<{ readonly name: string; readonly directory: boolean }>> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.map((entry) => ({ name: entry.name, directory: entry.isDirectory() }))
  } catch {
    return []
  }
}

/**
 * Resolve a stored OMP session id to its session file, the way `AcpAgent#findStoredSession` does: the
 * directory the process would store a session of this cwd in comes first, then every sibling session
 * directory (the global by-id fallback). `referenceFile` is the (not necessarily persisted) session
 * file the freshly booted process reported; its directory and the directory above are the search roots,
 * so no OMP directory convention (profiles, XDG, `PI_CODING_AGENT_DIR`) is re-implemented here.
 * Files are matched by their `<timestamp>_<id>.jsonl` name and confirmed against the header id; a header
 * scan covers files that do not carry the id in their name.
 */
export async function findOmpSessionFile(input: {
  readonly sessionId: string
  readonly referenceFile: string
  /** Further `sessions` roots to search (e.g. `<PI_CODING_AGENT_DIR>/sessions`), when the layout is not the standard one. */
  readonly extraRoots?: readonly string[]
  readonly headerScanLimit?: number
}): Promise<string | undefined> {
  const id = input.sessionId
  if (id.length === 0) return undefined
  const localDir = dirname(input.referenceFile)
  const parentDir = dirname(localDir)
  const dirs = [localDir]
  const roots = [...(basename(parentDir) === 'sessions' ? [parentDir] : []), ...(input.extraRoots ?? [])]
  for (const root of roots) {
    for (const entry of await listDirectory(root)) {
      const dir = join(root, entry.name)
      if (entry.directory && !dirs.includes(dir)) dirs.push(dir)
    }
  }
  const listings = new Map<string, string[]>()
  for (const dir of dirs) {
    const names = (await listDirectory(dir))
      .filter((entry) => !entry.directory && entry.name.endsWith('.jsonl') && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
    listings.set(dir, names)
  }
  for (const dir of dirs) {
    for (const name of listings.get(dir) ?? []) {
      if (name !== `${id}.jsonl` && !name.endsWith(`_${id}.jsonl`)) continue
      const file = join(dir, name)
      const header = await readOmpSessionHeader(file)
      if (header === undefined || header.id === id) return file
    }
  }
  // Files named `<timestamp>_<id>.jsonl` state their id; only legacy names need their header read.
  const candidates: string[] = []
  const limit = input.headerScanLimit ?? SESSION_HEADER_SCAN_LIMIT
  scan: for (const dir of dirs) {
    for (const name of listings.get(dir) ?? []) {
      if (/_[\w-]+\.jsonl$/.test(name)) continue
      if (candidates.length >= limit) break scan
      candidates.push(join(dir, name))
    }
  }
  let cursor = 0
  let found: string | undefined
  const worker = async (): Promise<void> => {
    while (found === undefined) {
      const file = candidates[cursor]
      cursor += 1
      if (file === undefined) return
      const header = await readOmpSessionHeader(file)
      if (header?.id === id) found = file
    }
  }
  await Promise.all(Array.from({ length: SESSION_HEADER_SCAN_CONCURRENCY }, () => worker()))
  return found
}

export interface OmpSessionThinking {
  /** The configured selector (`auto` or a level), when the entry carries one. */
  readonly configured: string | undefined
  /** The concrete level the entry recorded. */
  readonly level: string | undefined
}

/**
 * The newest `thinking_level_change` entry of a session file. `get_state.thinkingLevel` only reports
 * the resolved level, so this is how `auto` (which OMP persists as `configured: "auto"` and restores on
 * resume) is told apart from a pinned level.
 */
export async function readOmpSessionThinking(
  file: string,
  maxBytes: number = SESSION_TAIL_MAX_BYTES,
): Promise<OmpSessionThinking | undefined> {
  let handle: FileHandle
  try {
    handle = await open(file, 'r')
  } catch {
    return undefined
  }
  try {
    const { size } = await handle.stat()
    let position = size
    let scanned = 0
    let carry: Buffer = Buffer.alloc(0)
    while (position > 0 && scanned < maxBytes) {
      const length = Math.min(SESSION_TAIL_BLOCK_BYTES, position)
      position -= length
      const block = Buffer.allocUnsafe(length)
      const { bytesRead } = await handle.read(block, 0, length, position)
      scanned += bytesRead
      const chunk = Buffer.concat([block.subarray(0, bytesRead), carry])
      let complete: Buffer
      if (position === 0) {
        complete = chunk
        carry = Buffer.alloc(0)
      } else {
        const firstNewline = chunk.indexOf(0x0a)
        if (firstNewline === -1) {
          carry = chunk
          continue
        }
        carry = chunk.subarray(0, firstNewline)
        complete = chunk.subarray(firstNewline + 1)
      }
      const lines = complete.toString('utf8').split('\n')
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]
        if (line === undefined || !line.includes('"thinking_level_change"')) continue
        let record: unknown
        try {
          record = JSON.parse(line)
        } catch {
          continue
        }
        const entry = asObject(record)
        if (entry === undefined || entry.type !== 'thinking_level_change') continue
        return { configured: readString(entry.configured), level: readString(entry.thinkingLevel) }
      }
    }
    return undefined
  } catch {
    return undefined
  } finally {
    await handle.close().catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// Models and controls (`AcpAgent#buildConfigOptions` / `#getAvailableModes`)
// ---------------------------------------------------------------------------

export interface OmpModelInfo {
  readonly provider: string
  readonly id: string
  readonly name: string
  readonly reasoning: boolean
  /** Input modalities the model accepts (`text`, `image`). */
  readonly input: readonly string[]
}

export function parseOmpModel(raw: unknown): OmpModelInfo | undefined {
  const record = asObject(raw)
  if (record === undefined) return undefined
  const provider = readString(record.provider)
  const id = readString(record.id)
  if (provider === undefined || provider.length === 0 || id === undefined || id.length === 0) return undefined
  return {
    provider,
    id,
    name: readString(record.name) ?? id,
    reasoning: readBoolean(record.reasoning) === true,
    input: readStringArray(record.input),
  }
}

/** ACP model value: `AcpAgent#toModelId`. */
export function ompModelValue(model: Pick<OmpModelInfo, 'provider' | 'id'>): string {
  return `${model.provider}/${model.id}`
}

export interface OmpControlsInput {
  readonly models: readonly OmpModelInfo[]
  readonly model: OmpModelInfo | undefined
  /** `get_available_thinking_levels` (leading `off` included). */
  readonly thinkingLevels: readonly string[]
  /** Concrete effective level the session reports. */
  readonly thinkingLevel: string | undefined
  /** Whether the configured selector is `auto`. */
  readonly thinkingAuto: boolean
  /** `get_state.fastModeEnabled`; `undefined` when omp does not report it (the `fast` control is then not offered). */
  readonly fastMode?: boolean | undefined
  /** `get_state.slowModeEnabled` of a model that supports `/slow`; `undefined` otherwise (no `slow` control). */
  readonly slowMode?: boolean | undefined
}

/**
 * The ACP `session/new` controls of an OMP session, rebuilt from rpc facts. The mode list is `default`
 * only: ACP adds `plan` when `plan.enabled`, but plan mode cannot be applied over rpc-ui.
 */
export function deriveOmpControls(input: OmpControlsInput): NativeControls {
  const availableModes: acp.SessionMode[] = [
    { id: ACP_MODE_ID_DEFAULT, name: 'Default', description: 'Standard ACP headless mode' },
  ]
  const modes: acp.SessionModeState = { availableModes, currentModeId: ACP_MODE_ID_DEFAULT }

  const configOptions: acp.SessionConfigOption[] = [
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: modes.currentModeId,
      options: availableModes.map((mode) => ({
        value: mode.id,
        name: mode.name,
        ...(mode.description === undefined || mode.description === null ? {} : { description: mode.description }),
      })),
    },
  ]
  const first = input.models[0]
  if (first !== undefined) {
    configOptions.push({
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: ompModelValue(input.model ?? first),
      options: input.models.map((model) => ({
        value: ompModelValue(model),
        name: model.name,
        description: `${model.provider}/${model.id}`,
      })),
    })
  }
  const efforts = input.thinkingLevels.filter((level) => level !== THINKING_OFF)
  const configured = input.model?.reasoning === true ? (input.thinkingAuto ? THINKING_AUTO : input.thinkingLevel) : undefined
  configOptions.push({
    id: 'thinking',
    name: 'Thinking',
    category: 'thought_level',
    type: 'select',
    currentValue: configured !== undefined && configured !== 'inherit' && configured.length > 0 ? configured : THINKING_OFF,
    options: [
      { value: THINKING_OFF, name: 'Off' },
      { value: THINKING_AUTO, name: 'Auto', description: 'Auto-detect per prompt' },
      ...efforts.map((level) => ({ value: level, name: level })),
    ],
  })
  if (input.fastMode !== undefined) {
    configOptions.push({
      id: 'fast',
      name: 'Fast mode',
      description: 'Priority service tier for the current model (/fast)',
      type: 'boolean',
      currentValue: input.fastMode,
    })
  }
  if (input.slowMode !== undefined) {
    configOptions.push({
      id: 'slow',
      name: 'Slow mode',
      description: 'Flex tier or low-priority lane for the current model (/slow)',
      type: 'boolean',
      currentValue: input.slowMode,
    })
  }
  return { configOptions, modes, imageInput: input.model?.input.includes('image') === true }
}

function controlsSignature(controls: NativeControls): string {
  return JSON.stringify([controls.configOptions, controls.modes, controls.imageInput])
}

// ---------------------------------------------------------------------------
// Permission dialogs
// ---------------------------------------------------------------------------

function permissionOptionKind(label: string): acp.PermissionOptionKind {
  const normalized = label.trim().toLowerCase()
  if (
    normalized === 'deny' ||
    normalized === 'no' ||
    normalized === 'cancel' ||
    normalized.startsWith('deny ') ||
    normalized.startsWith('deny:') ||
    normalized.startsWith('reject') ||
    normalized.startsWith('decline') ||
    normalized.startsWith('abort')
  ) {
    return 'reject_once'
  }
  // Grants remember the answer (a folder/file for the session, or across sessions): never `allow_once`,
  // so a policy that wants the narrowest approval picks `Approve` / `Approve Once`.
  if (
    normalized.startsWith('always') ||
    normalized.includes('for this session') ||
    normalized.startsWith('approve directory') ||
    normalized.startsWith('approve file')
  ) {
    return 'allow_always'
  }
  return 'allow_once'
}

/**
 * Map the vendor's `select` labels to ACP permission options. Labels are kept verbatim as `optionId`
 * because OMP matches the echoed `value` against them; `always-ask-cached` adds directory/file grant
 * labels, so nothing here assumes exactly two options.
 */
export function mapOmpPermissionOptions(options: readonly string[]): acp.PermissionOption[] {
  return options.map((label) => ({ optionId: label, name: label, kind: permissionOptionKind(label) }))
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/** Sums `message_end.message.usage` over one prompt turn (OMP reports usage per model call). */
export class OmpUsageAccumulator {
  private input = 0
  private output = 0
  private cacheRead = 0
  private cacheWrite = 0
  private reasoning = 0
  private cost = 0
  private sawUsage = false
  private sawReasoning = false
  private sawCost = false
  private readonly counted = new Set<string>()

  /** Add one message's usage; returns false when the payload carries no token accounting. */
  add(usage: unknown, messageId?: string): boolean {
    const record = asObject(usage)
    if (record === undefined) return false
    const input = readNumber(record.input)
    const output = readNumber(record.output)
    const cacheRead = readNumber(record.cacheRead)
    const cacheWrite = readNumber(record.cacheWrite)
    if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) {
      return false
    }
    if (messageId !== undefined) {
      if (this.counted.has(messageId)) return false
      this.counted.add(messageId)
    }
    this.sawUsage = true
    this.input += input ?? 0
    this.output += output ?? 0
    this.cacheRead += cacheRead ?? 0
    this.cacheWrite += cacheWrite ?? 0
    const reasoning = readNumber(record.reasoningTokens)
    if (reasoning !== undefined) {
      this.sawReasoning = true
      this.reasoning += reasoning
    }
    const cost = readNumber(asObject(record.cost)?.total)
    if (cost !== undefined) {
      this.sawCost = true
      this.cost += cost
    }
    return true
  }

  /** The turn total, or `undefined` when no tokens were accounted (ACP omits an all-zero usage). */
  snapshot(): NativeTurnUsage | undefined {
    if (!this.sawUsage || this.input + this.output + this.cacheRead + this.cacheWrite === 0) return undefined
    return {
      inputTokens: this.input,
      outputTokens: this.output,
      cachedReadTokens: this.cacheRead,
      cachedWriteTokens: this.cacheWrite,
      ...(this.sawReasoning ? { thoughtTokens: this.reasoning } : {}),
      ...(this.sawCost ? { costUsd: this.cost } : {}),
    }
  }
}

/** Sum a list of OMP usage payloads (one per model call) into a turn usage. */
export function sumOmpUsage(usages: readonly unknown[]): NativeTurnUsage | undefined {
  const accumulator = new OmpUsageAccumulator()
  for (const usage of usages) accumulator.add(usage)
  return accumulator.snapshot()
}

// ---------------------------------------------------------------------------
// Event projection (`acp-event-mapper.ts`)
// ---------------------------------------------------------------------------

type SessionUpdateOf<K extends acp.SessionUpdate['sessionUpdate']> = Extract<acp.SessionUpdate, { sessionUpdate: K }>

const ACP_TEXT_LIMIT = 4_000
/** `scheme://…` subjects name internal resources, never local files. */
const INTERNAL_URL_SUBJECT = /^[a-z][a-z0-9+.-]*:\/\//i
const UNICODE_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g
/** `AssistantMessage.errorMessage` of an expected internal abort that must not surface. */
const SILENT_ABORT_MARKER = '__omp.silent_abort__'

function limitText(text: string): string {
  return text.length > ACP_TEXT_LIMIT ? `${text.slice(0, ACP_TEXT_LIMIT - 1)}…` : text
}

/** `canonicalizeMessage` of @oh-my-pi/pi-tui: text that is only dots/ellipses/whitespace is empty. */
function canonicalizeMessage(text: string | null | undefined): string {
  if (!text) return ''
  const trimmed = text.trim()
  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index)
    if (code !== 0x2e && code !== 0x2026 && code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      return trimmed
    }
  }
  return ''
}

function normalizeText(text: string | undefined): string | undefined {
  if (!text) return undefined
  const normalized = text.trim()
  return normalized.length > 0 ? limitText(normalized) : undefined
}

function stringProp(value: unknown, key: string): string | undefined {
  const record = asObject(value)
  const property = record?.[key]
  return typeof property === 'string' && property.length > 0 ? property : undefined
}

function safeJsonStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

function textToolContent(text: string): acp.ToolCallContent {
  return { type: 'content', content: { type: 'text', text } }
}

function hasEquivalentText(content: readonly acp.ToolCallContent[], text: string): boolean {
  return content.some((item) => item.type === 'content' && item.content.type === 'text' && item.content.text === text)
}

function writeTargetScheme(toolName: string, args: unknown): string | undefined {
  if (toolName !== 'write') return undefined
  const path = stringProp(args, 'path')
  if (path === undefined) return undefined
  return /^([a-z][a-z0-9+.-]*):\/\//i.exec(path)?.[1]?.toLowerCase()
}

/** Peer-to-peer messages (OMP `scope: "coordination"` writes to `agent://`) stay off the external ACP stream. */
function isInternalAgentMessageTool(toolName: string, args: unknown): boolean {
  return writeTargetScheme(toolName, args) === 'agent'
}

/** `mapToolKind` of acp-event-mapper.ts. */
export function mapOmpToolKind(toolName: string, args?: unknown): acp.ToolKind {
  // A device write (xd:// tool dispatch, proc:// control) executes something: "edit" would make clients
  // render a file modification to a nonexistent path.
  const scheme = writeTargetScheme(toolName, args)
  if (scheme === 'xd' || scheme === 'proc') return 'execute'
  switch (toolName) {
    case 'read':
      return 'read'
    case 'write':
    case 'edit':
      return 'edit'
    case 'delete':
      return 'delete'
    case 'move':
      return 'move'
    case 'bash':
    case 'shell':
    case 'exec':
    case 'eval':
      return 'execute'
    case 'grep':
    case 'glob':
    case 'ast_grep':
      return 'search'
    case 'web_search':
      return 'fetch'
    case 'todo':
      return 'think'
    default:
      return 'other'
  }
}

function buildEvalStartText(args: unknown): string | undefined {
  const record = asObject(args)
  if (record === undefined) return undefined
  const cells = Array.isArray(record.cells) ? record.cells : typeof record.code === 'string' ? [record] : []
  if (cells.length === 0) return undefined
  const lines: string[] = []
  for (const cell of cells) {
    if (asObject(cell) === undefined) continue
    const language = stringProp(cell, 'language') ?? '?'
    const title = stringProp(cell, 'title')
    const code = stringProp(cell, 'code')
    if (!code) continue
    lines.push(title ? `[${language}] ${title}` : `[${language}]`, code)
  }
  return lines.length > 0 ? limitText(lines.join('\n')) : undefined
}

function buildToolStartText(toolName: string, args: unknown): string | undefined {
  if (toolName === 'bash' || toolName === 'shell' || toolName === 'exec') {
    const command = stringProp(args, 'command')
    return command ? limitText(`$ ${command}`) : undefined
  }
  if (toolName === 'eval') return buildEvalStartText(args)
  return undefined
}

function buildToolStartContent(toolName: string, args: unknown): acp.ToolCallContent[] {
  const text = buildToolStartText(toolName, args)
  return text ? [textToolContent(text)] : []
}

/** `buildToolTitle` of acp-event-mapper.ts. */
export function buildOmpToolTitle(toolName: string, args: unknown, intent?: string): string {
  // Command tools show the command line, eval shows its cells; both double as the start content.
  const startText = buildToolStartText(toolName, args)
  if (startText) return startText
  const trimmedIntent = intent?.trim()
  if (trimmedIntent) return trimmedIntent
  const subject =
    stringProp(args, 'path') ?? stringProp(args, 'command') ?? stringProp(args, 'pattern') ?? stringProp(args, 'query')
  if (subject) {
    // Internal URLs (xd://github, skill://react, …) name their target fully.
    if (INTERNAL_URL_SUBJECT.test(subject)) return subject
    return `${toolName}: ${subject}`
  }
  return toolName
}

function mergeToolUpdateContent(
  startContent: readonly acp.ToolCallContent[],
  resultContent: readonly acp.ToolCallContent[],
): acp.ToolCallContent[] {
  if (startContent.length === 0) return [...resultContent]
  const merged = [...startContent]
  for (const item of resultContent) {
    if (item.type === 'content' && item.content.type === 'text' && hasEquivalentText(merged, item.content.text)) continue
    merged.push(item)
  }
  return merged
}

interface ProjectionContext {
  readonly cwd: string
  readonly home: string
  readonly isFile: (path: string) => boolean
}

function toLocationPath(raw: string, ctx: ProjectionContext): string {
  let value = raw.replace(UNICODE_SPACES, ' ')
  if (value.startsWith('@')) {
    const rest = value.slice(1)
    if (rest.startsWith('/') || rest === '~' || rest.startsWith('~/')) value = rest
  }
  if (value.toLowerCase().startsWith('file://')) {
    try {
      value = fileURLToPath(value)
    } catch {
      // Keep the raw value.
    }
  }
  if (value === '~') value = ctx.home
  else if (value.startsWith('~/')) value = ctx.home + value.slice(1)
  if (/^\/+$/.test(value)) return ctx.cwd
  return isAbsolute(value) ? value : resolvePath(ctx.cwd, value)
}

function existingFileLocationPath(raw: string | undefined, ctx: ProjectionContext): string | undefined {
  if (!raw || INTERNAL_URL_SUBJECT.test(raw)) return undefined
  const resolved = toLocationPath(raw, ctx)
  return ctx.isFile(resolved) ? resolved : undefined
}

/**
 * The single existing file a `read` argument names: read inputs may carry selectors (`file:20-40`),
 * globs, directories or internal resources, and only a regular file is safe to publish as a location.
 */
function readLocationBasePath(raw: string | undefined, ctx: ProjectionContext, toolName: string | undefined): string | undefined {
  if (raw === undefined || toolName !== 'read') return raw
  if (INTERNAL_URL_SUBJECT.test(raw)) return undefined
  if (ctx.isFile(toLocationPath(raw, ctx))) return existingFileLocationPath(raw, ctx)
  const match = /^(.*[^:]):([A-Za-z0-9_,+.-]+(?::[A-Za-z]+)?)$/.exec(raw)
  return existingFileLocationPath(match?.[1] ?? raw, ctx)
}

function extractToolLocations(args: unknown, ctx: ProjectionContext, toolName?: string): acp.ToolCallLocation[] {
  const locations: acp.ToolCallLocation[] = []
  const seen = new Set<string>()
  const push = (raw: string | undefined): void => {
    if (!raw || INTERNAL_URL_SUBJECT.test(raw)) return
    const path = toLocationPath(raw, ctx)
    if (seen.has(path)) return
    seen.add(path)
    locations.push({ path })
  }
  push(readLocationBasePath(stringProp(args, 'path'), ctx, toolName))
  push(stringProp(args, 'oldPath'))
  push(stringProp(args, 'newPath'))
  return locations
}

/** Locations from a result's details (e.g. `EditToolDetails.perFileResults[].path`). */
function extractToolLocationsFromResult(result: unknown, ctx: ProjectionContext): acp.ToolCallLocation[] {
  const details = asObject(asObject(result)?.details)
  if (details === undefined) return []
  const direct = extractToolLocations(details, ctx)
  const resolvedFile = existingFileLocationPath(stringProp(details, 'resolvedPath'), ctx)
  if (resolvedFile && !direct.some((location) => location.path === resolvedFile)) direct.push({ path: resolvedFile })
  const perFile = readArray(details.perFileResults)
  if (perFile === undefined) return direct
  const seen = new Set(direct.map((location) => location.path))
  const locations = [...direct]
  for (const entry of perFile) {
    const raw = stringProp(entry, 'path')
    if (!raw) continue
    const path = toLocationPath(raw, ctx)
    if (seen.has(path)) continue
    seen.add(path)
    locations.push({ path })
  }
  return locations
}

function buildDiffContent(entry: unknown): acp.ToolCallContent | undefined {
  const record = asObject(entry)
  if (record === undefined || record.isError === true) return undefined
  const path = stringProp(record, 'path')
  if (!path) return undefined
  const oldText = readString(record.oldText)
  const newText = readString(record.newText)
  if (oldText === undefined && newText === undefined) return undefined
  return { type: 'diff', path, oldText: oldText ?? null, newText: newText ?? '' }
}

/** A `diff` content block for each per-file edit result that carries oldText/newText. */
function extractDiffToolCallContent(result: unknown): acp.ToolCallContent[] {
  const details = asObject(asObject(result)?.details)
  if (details === undefined) return []
  const perFile = readArray(details.perFileResults)
  const entries: unknown[] = perFile ?? [details]
  const blocks: acp.ToolCallContent[] = []
  for (const entry of entries) {
    const block = buildDiffContent(entry)
    if (block) blocks.push(block)
  }
  return blocks
}

function extractTerminalId(value: unknown): string | undefined {
  return stringProp(value, 'terminalId') ?? stringProp(asObject(value)?.details, 'terminalId')
}

/** `tool_execution_update` status: only a settled background-job frame settles the call. */
function toolUpdateStatus(partialResult: unknown): 'in_progress' | 'completed' | 'failed' {
  const details = asObject(asObject(partialResult)?.details)
  if (details === undefined) return 'in_progress'
  const state = stringProp(details.async, 'state')
  if (state === 'completed') return 'completed'
  return state === 'failed' || state === 'cancelled' ? 'failed' : 'in_progress'
}

function getContentBlocks(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value
  const record = asObject(value)
  const content = record?.content
  return Array.isArray(content) ? content : undefined
}

function extractStructuredText(value: unknown): string | undefined {
  const text = stringProp(value, 'text')
  return text ? limitText(text) : undefined
}

function binaryToolContent(type: 'image' | 'audio', value: unknown): acp.ToolCallContent | undefined {
  const data = stringProp(value, 'data')
  const mimeType = stringProp(value, 'mimeType')
  if (!data || !mimeType) return undefined
  return { type: 'content', content: { type, data, mimeType } }
}

function toToolCallContent(value: unknown): acp.ToolCallContent | undefined {
  const type = readString(asObject(value)?.type)
  switch (type) {
    case 'text': {
      const text = extractStructuredText(value)
      return text ? textToolContent(text) : undefined
    }
    case 'image':
    case 'audio':
      return binaryToolContent(type, value)
    case 'resource_link': {
      const uri = stringProp(value, 'uri')
      const name = stringProp(value, 'name')
      if (!uri || !name) return undefined
      const title = stringProp(value, 'title')
      const description = stringProp(value, 'description')
      const mimeType = stringProp(value, 'mimeType')
      const size = readNumber(asObject(value)?.size)
      return {
        type: 'content',
        content: {
          type: 'resource_link',
          uri,
          name,
          ...(title ? { title } : {}),
          ...(description ? { description } : {}),
          ...(mimeType ? { mimeType } : {}),
          ...(size !== undefined ? { size } : {}),
        },
      }
    }
    case 'resource': {
      const resource = asObject(asObject(value)?.resource)
      const uri = stringProp(resource, 'uri')
      if (!uri) return undefined
      const mimeType = stringProp(resource, 'mimeType')
      const text = stringProp(resource, 'text')
      if (text) return { type: 'content', content: { type: 'resource', resource: { uri, text, ...(mimeType ? { mimeType } : {}) } } }
      const blob = stringProp(resource, 'blob')
      if (!blob) return undefined
      return { type: 'content', content: { type: 'resource', resource: { uri, blob, ...(mimeType ? { mimeType } : {}) } } }
    }
    default:
      return undefined
  }
}

function imageContentKey(value: acp.ToolCallContent): string | undefined {
  if (value.type !== 'content' || value.content.type !== 'image') return undefined
  return `${value.content.mimeType}\u0000${value.content.data}`
}

function extractDetailsImages(value: unknown): unknown[] | undefined {
  const images = readArray(asObject(asObject(value)?.details)?.images)
  return images !== undefined && images.length > 0 ? images : undefined
}

function isTerminalOnlyDetails(value: unknown): boolean {
  if (extractTerminalId(value) === undefined) return false
  const content = asObject(value)?.content
  return content === undefined || (Array.isArray(content) && content.length === 0)
}

function extractReadableText(value: unknown): string | undefined {
  if (typeof value === 'string') return normalizeText(value)
  if (value instanceof Error) return normalizeText(value.message)
  if (typeof value !== 'object' || value === null) return undefined
  const directText = stringProp(value, 'text') ?? stringProp(value, 'errorMessage') ?? stringProp(value, 'message')
  if (directText) return normalizeText(directText)
  const blocks = getContentBlocks(value)
  if (blocks) {
    const text = blocks
      .map((block) => extractStructuredText(block))
      .filter((chunk): chunk is string => typeof chunk === 'string' && chunk.length > 0)
      .join('\n')
    if (text.length > 0) return normalizeText(text)
    // A structured envelope whose blocks carry no text has nothing readable; its data rides as rawOutput.
    return undefined
  }
  if (extractDetailsImages(value)) return undefined
  if (isTerminalOnlyDetails(value)) return undefined
  return normalizeText(safeJsonStringify(value))
}

/** `extractToolCallContent` of acp-event-mapper.ts. */
function extractToolCallContent(value: unknown): acp.ToolCallContent[] {
  const rich: acp.ToolCallContent[] = []
  for (const block of getContentBlocks(value) ?? []) {
    const content = toToolCallContent(block)
    if (content) rich.push(content)
  }
  const seen = new Set(rich.map(imageContentKey).filter((key): key is string => key !== undefined))
  const imageContent: acp.ToolCallContent[] = []
  for (const image of extractDetailsImages(value) ?? []) {
    const content = binaryToolContent('image', image)
    const key = content === undefined ? undefined : imageContentKey(content)
    if (!content || !key || seen.has(key)) continue
    seen.add(key)
    imageContent.push(content)
  }
  const combined = [...rich, ...imageContent]
  const terminalId = extractTerminalId(value)
  const content: acp.ToolCallContent[] =
    terminalId && !combined.some((item) => item.type === 'terminal' && item.terminalId === terminalId)
      ? [...combined, { type: 'terminal', terminalId }]
      : combined
  const fallbackText = extractReadableText(value)
  if (!fallbackText || hasEquivalentText(content, fallbackText)) return content
  return [...content, textToolContent(fallbackText)]
}

/** Extract the visible text of an assistant message (`extractAssistantMessageText`). */
export function extractOmpAssistantText(message: unknown): string {
  const content = asObject(message)?.content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => extractStructuredText(block))
    .filter((chunk): chunk is string => typeof chunk === 'string' && chunk.length > 0)
    .join('\n')
}

type PlanStatus = 'pending' | 'in_progress' | 'completed'
const TODO_STATUS: Readonly<Record<string, PlanStatus>> = {
  pending: 'pending',
  in_progress: 'in_progress',
  completed: 'completed',
  abandoned: 'completed',
  blocked: 'pending',
}

function planEntry(content: string, status: unknown): acp.PlanEntry {
  return { content, priority: 'medium', status: (typeof status === 'string' ? TODO_STATUS[status] : undefined) ?? 'pending' }
}

function todoResultToPlan(toolName: string, isError: boolean, result: unknown): SessionUpdateOf<'plan'> | undefined {
  if (toolName !== 'todo' || isError) return undefined
  const phases = asObject(asObject(result)?.details)?.phases
  if (!Array.isArray(phases)) return undefined
  const entries: acp.PlanEntry[] = []
  for (const phase of phases) {
    const tasks = asObject(phase)?.tasks
    if (!Array.isArray(tasks)) continue
    for (const task of tasks) {
      const content = stringProp(task, 'content')
      if (content) entries.push(planEntry(content, asObject(task)?.status))
    }
  }
  return { sessionUpdate: 'plan', entries }
}

/**
 * The one-line, user-facing text of a vendor notification frame (retry, model fallback, compaction, extension error,
 * `notice`, extension `notify` / `open_url`); `undefined` for frames and levels that stay in the host log.
 */
function describeOmpNotice(frame: JsonObject): string | undefined {
  switch (readString(frame.type)) {
    case 'auto_retry_start':
      return `OMP retry ${readNumber(frame.attempt) ?? '?'}/${readNumber(frame.maxAttempts) ?? '?'} in ${readNumber(frame.delayMs) ?? '?'}ms: ${readString(frame.errorMessage) ?? 'request failed'}`
    case 'auto_retry_end':
      return readBoolean(frame.success) === true
        ? undefined
        : `OMP retry failed: ${readString(frame.finalError) ?? 'unknown error'}`
    case 'retry_fallback_applied': {
      const reason = readString(frame.reason)
      return `OMP switched model ${readString(frame.from) ?? '?'} → ${readString(frame.to) ?? '?'}${reason === undefined ? '' : ` (${reason})`}`
    }
    case 'retry_fallback_succeeded':
      return `OMP continued on the fallback model ${readString(frame.model) ?? '?'}`
    case 'auto_compaction_start':
      return 'OMP is compacting the context window'
    case 'auto_compaction_end': {
      const errorMessage = readString(frame.errorMessage)
      if (errorMessage !== undefined) return `OMP context compaction failed: ${errorMessage}`
      if (readBoolean(frame.aborted) === true) return 'OMP context compaction was cancelled'
      return readBoolean(frame.skipped) === true ? undefined : 'OMP finished compacting the context window'
    }
    case 'extension_error':
      return `OMP extension error (${readString(frame.extensionPath) ?? 'unknown'} / ${readString(frame.event) ?? 'unknown'}): ${readString(frame.error) ?? 'failed'}`
    case 'notice': {
      const level = readString(frame.level)
      const message = readString(frame.message)
      // Side-question persistence failures belong to the question, not to the turn that happens to be open.
      if (
        message === undefined ||
        (level !== 'warning' && level !== 'error') ||
        readString(frame.source) === 'btw-history'
      ) {
        return undefined
      }
      return `${level}: ${message}`
    }
    case 'extension_ui_request': {
      switch (readString(frame.method)) {
        case 'notify': {
          const message = readString(frame.message)
          if (message === undefined || message.trim().length === 0) return undefined
          const level = readString(frame.notifyType)
          return level === 'warning' || level === 'error' ? `${level}: ${message}` : message
        }
        case 'open_url': {
          const url = readString(frame.launchUrl) ?? readString(frame.url)
          if (url === undefined) return undefined
          const instructions = readString(frame.instructions)
          return `OMP asks you to open ${url}${instructions === undefined ? '' : `: ${instructions}`}`
        }
        default:
          return undefined
      }
    }
    default:
      return undefined
  }
}

/** A tool call the vendor started and has not finished (for matching approval dialogs). */
export interface OmpOpenToolCall {
  readonly toolCallId: string
  readonly toolName: string
  readonly title: string
  readonly kind: acp.ToolKind
  readonly rawInput: unknown
  readonly content: readonly acp.ToolCallContent[]
  readonly locations: readonly acp.ToolCallLocation[]
}

export interface OmpProjectorOptions {
  /** Session cwd: relative tool paths resolve against it. */
  readonly cwd: string
  /** Existence probe used to publish `read` locations (default: `fs.statSync(path).isFile()`). */
  readonly isFile?: (path: string) => boolean
  readonly homeDir?: string | undefined
  /** Message id factory (default `crypto.randomUUID`). */
  readonly newMessageId?: () => string
}

interface LiveMessage {
  readonly id: string
  textEmitted: boolean
  /** Thinking text accumulated per content index (deltas stream without the partial message). */
  readonly thinking: Map<number, string>
}

/**
 * Pure projection of OMP session frames onto ACP session updates, following `acp-event-mapper.ts`
 * and the live-message bookkeeping of `AcpAgent`. Frames arrive in `messageUpdates: "delta"` form, so
 * thinking blocks are accumulated here instead of read from the partial message.
 */
export class OmpEventProjector {
  private readonly ctx: ProjectionContext
  private readonly newId: () => string
  private live: LiveMessage | undefined
  private errorTextEmitted = false
  private readonly toolArgs = new Map<string, unknown>()
  private readonly open = new Map<string, OmpOpenToolCall>()

  constructor(options: OmpProjectorOptions) {
    this.ctx = {
      cwd: options.cwd,
      home: options.homeDir ?? homedir(),
      isFile:
        options.isFile ??
        ((path: string): boolean => {
          try {
            return statSync(path).isFile()
          } catch {
            return false
          }
        }),
    }
    this.newId = options.newMessageId ?? randomUUID
  }

  /** Forget every per-turn fact (a session switch or a new prompt). */
  reset(): void {
    this.live = undefined
    this.errorTextEmitted = false
    this.toolArgs.clear()
    this.open.clear()
  }

  /** The newest unfinished call, preferring one of `toolName`. */
  findOpenToolCall(toolName?: string): OmpOpenToolCall | undefined {
    const calls = [...this.open.values()]
    if (toolName !== undefined) {
      for (let index = calls.length - 1; index >= 0; index -= 1) {
        const call = calls[index]
        if (call?.toolName === toolName) return call
      }
    }
    return calls[calls.length - 1]
  }

  /** Project one session frame; frames that carry no ACP-visible change return `[]`. */
  project(frame: JsonObject): acp.SessionUpdate[] {
    switch (readString(frame.type)) {
      case 'message_start':
      case 'message_update':
      case 'message_end':
        return this.projectMessage(frame)
      case 'tool_execution_start':
        return this.toolStart(frame)
      case 'tool_execution_update':
        return this.toolUpdate(frame)
      case 'tool_execution_end':
        return this.toolEnd(frame)
      case 'todo_reminder': {
        const entries: acp.PlanEntry[] = []
        for (const todo of readArray(frame.todos) ?? []) {
          const content = readString(asObject(todo)?.content)
          if (content !== undefined) entries.push(planEntry(content, asObject(todo)?.status))
        }
        return [{ sessionUpdate: 'plan', entries }]
      }
      case 'todo_auto_clear':
        return [{ sessionUpdate: 'plan', entries: [] }]
      case 'command_output': {
        const text = (readString(frame.text) ?? '').replace(ANSI_SEQUENCE, '')
        return text ? [this.messageChunk('agent_message_chunk', { type: 'text', text }, this.newId())] : []
      }
      case 'auto_retry_start':
      case 'auto_retry_end':
      case 'retry_fallback_applied':
      case 'retry_fallback_succeeded':
      case 'auto_compaction_start':
      case 'auto_compaction_end':
      case 'extension_error':
      case 'notice':
      case 'extension_ui_request': {
        const note = describeOmpNotice(frame)
        return note === undefined
          ? []
          : [this.messageChunk('agent_thought_chunk', { type: 'text', text: note }, this.newId())]
      }
      default:
        return []
    }
  }

  /**
   * End-of-turn fallback (`#flushUnreportedTurnError`): a provider failure that never streamed a
   * message (e.g. `HTTP 410 model_sunset` before any token) still has to reach the client as text.
   */
  flushTurnError(input: { readonly assistantError?: string | undefined; readonly promptError?: string | undefined }): acp.SessionUpdate[] {
    if (this.errorTextEmitted) return []
    const message = input.assistantError ?? input.promptError
    if (message === undefined || message.length === 0) return []
    this.errorTextEmitted = true
    return [this.messageChunk('agent_message_chunk', { type: 'text', text: message }, this.live?.id ?? this.newId())]
  }

  /** One line the transport itself says (a refused command, a usage hint): an assistant message with its own id. */
  reply(text: string): acp.SessionUpdate {
    return this.messageChunk('agent_message_chunk', { type: 'text', text }, this.newId())
  }

  /** One line the transport adds as a thought of the turn (a goal that changed state). */
  note(text: string): acp.SessionUpdate {
    return this.messageChunk('agent_thought_chunk', { type: 'text', text }, this.newId())
  }

  private messageChunk(
    kind: 'agent_message_chunk' | 'agent_thought_chunk',
    content: acp.ContentBlock,
    messageId: string | undefined,
  ): SessionUpdateOf<'agent_message_chunk'> | SessionUpdateOf<'agent_thought_chunk'> {
    return { sessionUpdate: kind, content, ...(messageId === undefined ? {} : { messageId }) }
  }

  private prepareLive(type: string, role: string | undefined): LiveMessage | undefined {
    if (role !== 'assistant') return this.live
    if (type === 'message_start' || this.live === undefined) {
      this.live = { id: this.newId(), textEmitted: false, thinking: new Map() }
    }
    return this.live
  }

  private projectMessage(frame: JsonObject): acp.SessionUpdate[] {
    const type = readString(frame.type) ?? ''
    const message = asObject(frame.message)
    const role = readString(message?.role)
    const live = this.prepareLive(type, role)
    if (role !== 'assistant' || live === undefined) return []
    if (type === 'message_start') return []
    if (type === 'message_update') return this.assistantUpdate(frame, live)
    const updates = this.assistantEnd(message, live)
    // The assistant `message_end` closes the live message (`#clearLiveAssistantMessageAfterEvent`).
    this.live = undefined
    return updates
  }

  private assistantUpdate(frame: JsonObject, live: LiveMessage): acp.SessionUpdate[] {
    const event = asObject(frame.assistantMessageEvent)
    if (event === undefined) return []
    let kind: 'agent_message_chunk' | 'agent_thought_chunk'
    let text: string
    switch (readString(event.type)) {
      case 'image_end': {
        const content = asObject(event.content)
        return content === undefined ? [] : [this.messageChunk('agent_message_chunk', content as unknown as acp.ContentBlock, live.id)]
      }
      case 'text_delta':
        kind = 'agent_message_chunk'
        text = readString(event.delta) ?? ''
        if (text.length > 0) live.textEmitted = true
        break
      case 'thinking_start':
        live.thinking.set(readNumber(event.contentIndex) ?? 0, '')
        return []
      case 'thinking_delta': {
        const index = readNumber(event.contentIndex) ?? 0
        text = readString(event.delta) ?? ''
        const accumulated = (live.thinking.get(index) ?? '') + text
        live.thinking.set(index, accumulated)
        // The ACP mapper drops deltas while the block so far canonicalizes to nothing.
        if (!canonicalizeMessage(accumulated)) return []
        kind = 'agent_thought_chunk'
        break
      }
      case 'done':
        if (live.textEmitted) return []
        kind = 'agent_message_chunk'
        text = extractOmpAssistantText(event.message)
        if (text.length > 0) live.textEmitted = true
        break
      case 'error': {
        kind = 'agent_message_chunk'
        text = readString(asObject(event.error)?.errorMessage) ?? 'Unknown error'
        if (text.length > 0) live.textEmitted = true
        this.errorTextEmitted = true
        break
      }
      default:
        return []
    }
    return text.length === 0 ? [] : [this.messageChunk(kind, { type: 'text', text }, live.id)]
  }

  private assistantEnd(message: JsonObject | undefined, live: LiveMessage): acp.SessionUpdate[] {
    const updates: acp.SessionUpdate[] = []
    // Narration streams as thinking; once its block closes as narration, ACP surfaces it as the reply.
    // Delta frames carry no block flags, so the closed message is where narration is recognized.
    for (const block of readArray(message?.content) ?? []) {
      const record = asObject(block)
      if (record?.type !== 'thinking' || record.narration !== true) continue
      const text = canonicalizeMessage(readString(record.thinking))
      if (text.length === 0) continue
      live.textEmitted = true
      updates.push(this.messageChunk('agent_message_chunk', { type: 'text', text }, live.id))
    }
    if (live.textEmitted) return updates
    const text = extractOmpAssistantText(message)
    if (text.length === 0) return updates
    live.textEmitted = true
    updates.push(this.messageChunk('agent_message_chunk', { type: 'text', text }, live.id))
    return updates
  }

  private toolStart(frame: JsonObject): acp.SessionUpdate[] {
    const toolCallId = readString(frame.toolCallId)
    if (toolCallId === undefined) return []
    const toolName = readString(frame.toolName) ?? 'tool'
    const args = frame.args
    if (isInternalAgentMessageTool(toolName, args)) return []
    this.toolArgs.set(toolCallId, args)
    const content = buildToolStartContent(toolName, args)
    const locations = extractToolLocations(args, this.ctx, toolName)
    const title = buildOmpToolTitle(toolName, args, readString(frame.intent))
    const kind = mapOmpToolKind(toolName, args)
    this.open.set(toolCallId, { toolCallId, toolName, title, kind, rawInput: args, content, locations })
    return [
      {
        sessionUpdate: 'tool_call',
        toolCallId,
        title,
        name: toolName,
        kind,
        status: 'pending',
        rawInput: args,
        ...(content.length > 0 ? { content } : {}),
        ...(locations.length > 0 ? { locations } : {}),
      },
    ]
  }

  private toolUpdate(frame: JsonObject): acp.SessionUpdate[] {
    const toolCallId = readString(frame.toolCallId)
    if (toolCallId === undefined) return []
    const toolName = readString(frame.toolName) ?? 'tool'
    const args = frame.args
    if (args !== undefined) this.toolArgs.set(toolCallId, args)
    if (isInternalAgentMessageTool(toolName, args)) return []
    const partialResult = frame.partialResult
    const content = mergeToolUpdateContent(buildToolStartContent(toolName, args), extractToolCallContent(partialResult))
    const locations = extractToolLocations(args, this.ctx, toolName)
    return [
      {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        name: toolName,
        status: toolUpdateStatus(partialResult),
        rawOutput: partialResult,
        ...(content.length > 0 ? { content } : {}),
        ...(locations.length > 0 ? { locations } : {}),
      },
    ]
  }

  private toolEnd(frame: JsonObject): acp.SessionUpdate[] {
    const toolCallId = readString(frame.toolCallId)
    if (toolCallId === undefined) return []
    const toolName = readString(frame.toolName) ?? 'tool'
    const args = 'args' in frame ? frame.args : this.toolArgs.get(toolCallId)
    this.toolArgs.delete(toolCallId)
    this.open.delete(toolCallId)
    if (isInternalAgentMessageTool(toolName, args)) return []
    const result = frame.result
    const isError = frame.isError === true
    const content = mergeToolUpdateContent(buildToolStartContent(toolName, args), [
      ...extractDiffToolCallContent(result),
      ...extractToolCallContent(result),
    ])
    const locations = extractToolLocationsFromResult(result, this.ctx)
    const updates: acp.SessionUpdate[] = [
      {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        name: toolName,
        status: isError ? 'failed' : 'completed',
        rawOutput: result,
        ...(content.length > 0 ? { content } : {}),
        ...(locations.length > 0 ? { locations } : {}),
      },
    ]
    const plan = todoResultToPlan(toolName, isError, result)
    if (plan) updates.push(plan)
    return updates
  }
}

export interface OmpCommandCatalog {
  readonly commands: readonly NativeCommand[]
  /**
   * Names and aliases omp runs itself although they sit on the terminal-only list: user commands (extension, custom,
   * file, skill, MCP prompt) that take such a name, and builtins that gained a handler in a later omp.
   */
  readonly overrides: ReadonlySet<string>
}

/**
 * The host's command list for omp's `available_commands_update.commands`. Everything omp advertises runs through
 * `prompt`. `btw`, `new` and `clear` are terminal-only in omp, hence never advertised: the transport serves them
 * (the `side` / `immediate` entries of the static table) unless an extension, custom or file command already owns
 * the name, which omp runs before it looks at builtins.
 */
export function buildOmpCommandCatalog(raw: unknown): OmpCommandCatalog {
  const overrides = new Set<string>()
  const advertised: NativeCommand[] = []
  for (const entry of readArray(raw) ?? []) {
    const record = asObject(entry)
    const name = readString(record?.name)
    if (record === undefined || name === undefined || name.length === 0) continue
    const aliases = readStringArray(record.aliases).filter((alias) => alias.length > 0 && alias !== name)
    const userCommand = (readString(record.source) ?? 'builtin') !== 'builtin'
    for (const claimed of [name, ...aliases]) {
      // A name the transport serves yields only to a user command; any other terminal-only name is runnable once advertised.
      if (userCommand || (Object.hasOwn(TERMINAL_ONLY_COMMANDS, claimed) && !Object.hasOwn(SERVED_COMMANDS, claimed))) overrides.add(claimed)
    }
    const hint = readString(asObject(record.input)?.hint)
    advertised.push({
      name,
      description: readString(record.description) ?? '',
      ...(hint === undefined || hint.length === 0 ? {} : { hint }),
      ...(aliases.length === 0 ? {} : { aliases }),
      dispatch: 'prompt',
    })
  }
  const served = OMP_NATIVE_COMMANDS.filter((command) => Object.hasOwn(SERVED_COMMANDS, command.name) && !overrides.has(command.name))
  const taken = new Set(served.map((command) => command.name))
  const commands: NativeCommand[] = [...served]
  for (const command of advertised) {
    if (taken.has(command.name)) continue
    taken.add(command.name)
    commands.push(command)
  }
  return { commands, overrides }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

interface ActivePromptState {
  readonly id: string
  readonly deferred: Deferred<NativePromptResult>
  readonly usage: OmpUsageAccumulator
  /** The message is a `/name` command, which omp may finish locally without running the agent. */
  readonly slash: boolean
  lastStopReason: string | undefined
  /** `errorMessage` of the run's final assistant message when it failed (from `agent_end`). */
  lastAssistantError: string | undefined
  admissionError: Error | undefined
  aborted: boolean
  /** An agent run started while the prompt was open. */
  agentRan: boolean
  /** The terminal `prompt_result` arrived: the `agent_end` fallback has nothing left to settle. */
  resultSeen: boolean
  /** Set when the agent yielded while background work remains: how the turn ends once the session settles. */
  heldStop: NativePromptResult['stopReason'] | undefined
  /** Last sign of life of a held turn (frames of the wake run); the hold timer measures from it. */
  lastActivityAt: number
  admissionTimer: NodeJS.Timeout | undefined
  abortTimer: NodeJS.Timeout | undefined
  fallbackTimer: NodeJS.Timeout | undefined
  holdTimer: NodeJS.Timeout | undefined
  removeAbortListener: (() => void) | undefined
}

/** A user shell command (`!cmd`) in flight; like a turn it owns the prompt slot. */
interface ActiveShellState {
  aborted: boolean
}

/** The side question in flight: omp runs one at a time per session. */
interface ActiveBtwState {
  readonly question: string
  /** Topic id: learned from the running record that precedes the response, confirmed by the response. */
  recordId: string | undefined
  /** The `btw_delta` text so far. */
  streamed: string
  /** The longest answer any `btw_record` carried. */
  answer: string
  /** Why the transport itself cancelled the question. */
  stop: 'aborted' | 'timeout' | undefined
  cancelRequested: boolean
  /** The last `btw_cancel` named the topic: one sent before the id was known can miss a question still queued. */
  cancelTargeted: boolean
  readonly deferred: Deferred<NativeCommandResult>
  watchdog: NodeJS.Timeout | undefined
  graceTimer: NodeJS.Timeout | undefined
  removeAbortListener: (() => void) | undefined
}

interface ActiveSteerState {
  readonly text: string
  admitted: boolean
  consumed: boolean
  injected: boolean
  readonly deferred: Deferred<'injected' | 'promptRequired'>
}

interface PendingRequest {
  readonly command: string
  readonly resolve: (data: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout | undefined
}

interface ChunkAssembly {
  readonly id: string
  readonly count: number
  readonly byteLength: number
  readonly parts: Buffer[]
  bytes: number
}

interface SessionStats {
  readonly sessionId: string
  readonly sessionFile: string | undefined
  readonly data: JsonObject
}

/** Knobs that tests or the host may override; production defaults follow the protocol spec. */
export interface OmpNativeTransportOptions {
  readonly readyTimeoutMs?: number
  readonly requestTimeoutMs?: number
  readonly modelListTimeoutMs?: number
  readonly contextPollIntervalMs?: number
  readonly steerTimeoutMs?: number
  readonly stdinCloseGraceMs?: number
  /** Delays between background `get_available_models` retries after a failed first attempt. */
  readonly modelListRetryDelaysMs?: readonly number[]
  /** Inactivity bound of a turn held open for background work (default 120 s). */
  readonly wakeSettleMs?: number
  /** How long a side question may run before it is cancelled (default 180 s). */
  readonly btwTimeoutMs?: number
  /** How long to wait for the vendor to confirm a cancellation (default 10 s). */
  readonly abortGraceMs?: number
  /** How long after a terminal run frame to wait for `prompt_result` before settling without it (default 1.5 s). */
  readonly promptResultFallbackMs?: number
  /** Directory the transport creates the private directory of its config overlay in (default: the system temp directory). */
  readonly overlayRoot?: string
}

/** OMP native transport: one `omp --mode rpc-ui` subprocess per instance. */
export class OmpNativeTransport implements NativeTransport {
  readonly kind = 'omp' as const

  private readonly readyTimeoutMs: number
  private readonly requestTimeoutMs: number
  private readonly modelListTimeoutMs: number
  private readonly contextPollIntervalMs: number
  private readonly steerTimeoutMs: number
  private readonly stdinCloseGraceMs: number
  private readonly modelListRetryDelaysMs: readonly number[]
  private readonly wakeSettleMs: number
  private readonly btwTimeoutMs: number
  private readonly abortGraceMs: number
  private readonly promptResultFallbackMs: number
  private readonly overlayRoot: string

  private proc: NativeProcess | undefined
  private agentEnv: Readonly<Record<string, string>> = {}
  private eventSink: NativeTransportStartOptions['onEvent'] | undefined
  private permissionHandler: NativePermissionHandler | undefined
  private elicitationHandler: NativeElicitationHandler | undefined
  private logSink: ((message: string) => void) | undefined
  private projector: OmpEventProjector | undefined
  private startPromise: Promise<void> | undefined
  private closePromise: Promise<void> | undefined
  private started = false
  private closing = false
  private sessionFile: string | undefined
  private exited = false
  private exitError: Error | undefined
  private readonly exitDeferred = Promise.withResolvers<void>()
  private nextRequestId = 1
  private readonly pending = new Map<string, PendingRequest>()
  private stderrBuffer = ''
  private lineBuffer = ''
  private malformedFrames = 0
  private chunkAssembly: ChunkAssembly | undefined
  private readyFrame: JsonObject | undefined
  private readyWaiter:
    | {
        readonly resolve: (frame: JsonObject) => void
        readonly reject: (error: Error) => void
      }
    | undefined

  private sessionIdValue: string | undefined
  private agentInfoValue: { readonly name: string; readonly version: string } = { name: 'omp', version: '' }
  private model: OmpModelInfo | undefined
  private models: readonly OmpModelInfo[] = []
  private thinkingLevels: readonly string[] = [THINKING_OFF]
  private thinkingLevel: string | undefined
  private thinkingAuto = false
  private controlsValue: NativeControls = deriveOmpControls({
    models: [],
    model: undefined,
    thinkingLevels: [THINKING_OFF],
    thinkingLevel: undefined,
    thinkingAuto: false,
  })
  /** `get_state.fastModeEnabled` when omp reports it; without it there is no `fast` control. */
  private fastMode: boolean | undefined
  /** `/slow` state of a model that supports it; without support there is no `slow` control. */
  private slowMode: boolean | undefined
  private emittedSignature = ''
  private selfChange = 0
  private configTail: Promise<void> = Promise.resolve()
  private modelRefresh: Promise<void> | undefined
  private modelRefreshDirty = false
  private modelListRetryTimer: NodeJS.Timeout | undefined

  private contextUsageValue: NativeContextUsage | undefined
  private busy = false
  private contextPollTimer: NodeJS.Timeout | undefined
  private contextPollInFlight = false
  /** Agent runs in progress (`agent_start` minus `agent_end`); nested runs count. */
  private agentRuns = 0

  private activePrompt: ActivePromptState | undefined
  private activeSteer: ActiveSteerState | undefined
  private steerTail: Promise<void> = Promise.resolve()
  private readonly dialogs = new Map<string, AbortController>()
  private activeShell: ActiveShellState | undefined
  private activeBtw: ActiveBtwState | undefined
  /** The session cwd the host passed: tool paths in the session entries resolve against it, and a restore of files stays inside it. */
  private cwd: string | undefined
  /** The goal as omp last reported it (`get_state`, `goal`, `goal_updated`): the next frame is compared with it. */
  private goal: OmpGoal | undefined
  /** A `/goal` command is waiting for omp: its own reply says what it did, so the frames it causes add no note. */
  private goalCommandOpen = false
  /** `session_settled` frames seen: a goal command that sees one while it decides holds nothing. */
  private settledFrames = 0
  /** A `/rewind` is changing the conversation: no prompt may start meanwhile. */
  private rewinding = false
  /** The `--config` overlay of this process (see `omp-overlay.ts`); deleted once, after the process is gone. */
  private overlay: OmpConfigOverlay | undefined
  private overlayRemoval: Promise<void> | undefined
  /** omp was launched with the overlay that lets goals continue over rpc. */
  private overlayApplied = false
  /** The command list built from omp's last `available_commands_update`; the static table until one arrived. */
  private liveCatalog: readonly NativeCommand[] | undefined
  private catalogSignature = ''
  /** Names the live catalog gives to extension, custom and file commands: omp runs those before its builtins. */
  private catalogOverrides: ReadonlySet<string> = new Set()

  constructor(options: OmpNativeTransportOptions = {}) {
    this.readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.modelListTimeoutMs = options.modelListTimeoutMs ?? MODEL_LIST_TIMEOUT_MS
    this.contextPollIntervalMs = options.contextPollIntervalMs ?? CONTEXT_POLL_INTERVAL_MS
    this.steerTimeoutMs = options.steerTimeoutMs ?? DEFAULT_STEER_TIMEOUT_MS
    this.stdinCloseGraceMs = options.stdinCloseGraceMs ?? STDIN_CLOSE_GRACE_MS
    this.modelListRetryDelaysMs = options.modelListRetryDelaysMs ?? MODEL_LIST_RETRY_DELAYS_MS
    this.wakeSettleMs = options.wakeSettleMs ?? WAKE_SETTLE_MS
    this.btwTimeoutMs = options.btwTimeoutMs ?? BTW_TIMEOUT_MS
    this.abortGraceMs = options.abortGraceMs ?? ABORT_SETTLE_GRACE_MS
    this.promptResultFallbackMs = options.promptResultFallbackMs ?? PROMPT_RESULT_FALLBACK_MS
    this.overlayRoot = options.overlayRoot ?? tmpdir()
  }

  get sessionId(): string | undefined {
    return this.sessionIdValue
  }

  get agentInfo(): { readonly name: string; readonly version: string } {
    return this.agentInfoValue
  }

  /** `switch_session` + `fork` over rpc replicate `AcpAgent#forkManagedSession`. */
  get canFork(): boolean {
    return true
  }

  /** True once the process exited or `close()` ran: the runtime then re-attaches before the next turn. */
  get closed(): boolean {
    return this.closing || this.exited
  }

  /** Path of the persisted OMP session file this transport is attached to (diagnostics and test cleanup). */
  get sessionFilePath(): string | undefined {
    return this.sessionFile
  }

  controls(): NativeControls {
    return this.controlsValue
  }

  contextUsage(): NativeContextUsage | undefined {
    return this.contextUsageValue
  }

  /** omp's own list once it reported one (plus the commands the transport serves), else the static table. */
  commands(): readonly NativeCommand[] {
    return this.liveCatalog ?? OMP_NATIVE_COMMANDS
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  start(options: NativeTransportStartOptions): Promise<void> {
    if (this.startPromise !== undefined) return this.startPromise
    this.startPromise = this.doStart(options)
    return this.startPromise
  }

  private async doStart(options: NativeTransportStartOptions): Promise<void> {
    if (this.closing) throw new NativeTransportError('OMP transport is closed', 'closed')
    this.eventSink = options.onEvent
    this.permissionHandler = options.onPermission
    this.elicitationHandler = options.onElicitation
    this.logSink = options.log
    this.agentEnv = options.env
    this.cwd = options.cwd
    this.projector = new OmpEventProjector({ cwd: options.cwd, homeDir: options.env['HOME'] })

    // omp continues a goal over rpc only when its settings say so, and by default they do not: the overlay does. Without it the
    // transport still runs; `/goal` then says that the goal waits for the next message.
    await this.createOverlay()
    let plan: OmpLaunchPlan
    let proc: NativeProcess
    try {
      if (this.closing) throw new NativeTransportError('OMP transport is closed', 'closed')
      plan = buildOmpLaunchArgv(options.argv, this.overlay?.file)
      if (plan.dropped.length > 0) this.log(`ignoring launcher args the transport owns: ${redactArgv(plan.dropped)}`)
      this.log(`spawning ${redactArgv(plan.argv)} (cwd=${options.cwd})`)
      proc = options.spawn({ argv: plan.argv, cwd: options.cwd, env: options.env })
    } catch (error) {
      await this.removeOverlay()
      throw error instanceof NativeTransportError
        ? error
        : new NativeTransportError('failed to spawn omp', 'spawn-failed', errorText(error))
    }
    this.proc = proc
    this.attachProcess(proc)
    // The rpc handshake does not carry the OMP version: ask the same launcher while the session boots.
    const versionProbe = this.probeVersion(options, plan.versionArgv)

    try {
      const ready = await this.waitForReady()
      await this.handshake(ready)
      await this.attachSession(options.session)
      await this.loadControlState()
      const version = await settleWithin(versionProbe, VERSION_WAIT_MS)
      if (version !== undefined) this.agentInfoValue = { name: 'omp', version }
      if (this.exitError !== undefined) throw this.exitError
      this.started = true
    } catch (error) {
      await this.close().catch(() => undefined)
      throw error
    }
  }

  /** The `--config` overlay that lets goals continue over rpc. The transport runs without it, so a failure is only logged. */
  private async createOverlay(): Promise<void> {
    try {
      this.overlay = await createOmpConfigOverlay(this.overlayRoot)
      this.overlayApplied = true
    } catch (error) {
      this.log(`could not write the omp config overlay that lets goals continue over rpc: ${errorText(error)}`)
    }
  }

  /** Deletes the overlay, once; every caller may await the deletion. Only called when the process is gone or never started. */
  private removeOverlay(): Promise<void> {
    const overlay = this.overlay
    if (overlay !== undefined) {
      this.overlay = undefined
      this.overlayRemoval = overlay.remove().catch((error: unknown) => {
        this.log(`could not remove the omp config overlay: ${errorText(error)}`)
      })
    }
    return this.overlayRemoval ?? Promise.resolve()
  }

  /** `omp --version` → `18.12.6`; `undefined` when the launcher does not answer in time. Never throws. */
  private async probeVersion(options: NativeTransportStartOptions, argv: readonly string[]): Promise<string | undefined> {
    let proc: NativeProcess
    try {
      proc = options.spawn({ argv, cwd: options.cwd, env: options.env })
    } catch {
      return undefined
    }
    proc.stdin.on('error', () => undefined)
    proc.stderr.on('data', () => undefined)
    proc.stderr.on('error', () => undefined)
    try {
      proc.stdin.end()
    } catch {
      // The probe needs no input.
    }
    let output = ''
    const streamEnded = Promise.withResolvers<void>()
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      if (output.length < 4_096) output += chunk
    })
    proc.stdout.on('end', streamEnded.resolve)
    proc.stdout.on('close', streamEnded.resolve)
    proc.stdout.on('error', () => streamEnded.resolve())
    const exited = proc.exited.then(
      () => undefined,
      () => undefined,
    )
    const finished = Promise.all([streamEnded.promise, exited]).then(() => true)
    if ((await settleWithin(finished, VERSION_PROBE_TIMEOUT_MS)) !== true) {
      proc.terminate()
      return undefined
    }
    return /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(output)?.[1]
  }

  private attachProcess(proc: NativeProcess): void {
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      this.handleStdoutChunk(chunk)
    })
    proc.stdout.on('error', (error: Error) => {
      this.log(`stdout error: ${errorText(error)}`)
    })
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      this.stderrBuffer += chunk
      if (this.stderrBuffer.length > STDERR_BUFFER_LIMIT) {
        this.stderrBuffer = this.stderrBuffer.slice(-STDERR_BUFFER_LIMIT)
      }
    })
    proc.stderr.on('error', (error: Error) => {
      this.log(`stderr error: ${errorText(error)}`)
    })
    proc.stdin.on('error', (error: Error) => {
      this.log(`stdin error: ${errorText(error)}`)
    })
    proc.exited.then(
      (outcome) => {
        this.handleProcessExit(`code=${outcome.exitCode === null ? 'null' : String(outcome.exitCode)} signal=${outcome.signal ?? 'null'}`, outcome.exitCode)
      },
      (error: unknown) => {
        this.handleProcessExit(`launch failed: ${errorText(error)}`, null)
      },
    )
  }

  private handleProcessExit(detail: string, exitCode: number | null): void {
    this.exited = true
    const tail = this.stderrTail()
    const launcherHint =
      exitCode === 127 || /command not found|No such file or directory/i.test(tail)
        ? ' (the omp launcher could not find an executable it needs on PATH; omp is `#!/usr/bin/env bun`, so the agent env PATH must include bun)'
        : ''
    this.failProcess(
      new NativeTransportError(
        `OMP process exited${launcherHint}`,
        'process-exit',
        tail.length === 0 ? detail : `${detail}\n${tail.slice(-1_000)}`,
      ),
    )
    this.exitDeferred.resolve()
    void this.removeOverlay()
  }

  private async handshake(ready: JsonObject): Promise<void> {
    const supported = readArray(ready.supportedProtocolVersions)?.filter(
      (version): version is number => typeof version === 'number',
    )
    const supportsV2 =
      supported !== undefined &&
      supported.includes(2) &&
      ready.maxFrameBytes === MAX_FRAME_BYTES &&
      ready.maxReassembledFrameBytes === MAX_REASSEMBLED_BYTES
    if (supportsV2) {
      try {
        const data = asObject(
          await this.request({ type: 'negotiate_protocol', protocolVersion: 2 }, this.requestTimeoutMs).response,
        )
        if (data === undefined || readNumber(data.protocolVersion) !== 2) {
          this.log('OMP did not accept RPC protocol v2; staying on line framing')
        }
      } catch (error) {
        this.log(`OMP protocol v2 negotiation failed: ${errorText(error)}`)
      }
    }
    // Every session event, but drop the accumulating message snapshot from streaming updates: deltas
    // remain, which is all this transport projects. Best effort on older builds.
    try {
      await this.request({ type: 'set_event_filter', events: null, messageUpdates: 'delta' }, 5_000).response
    } catch (error) {
      this.log(`OMP set_event_filter was rejected: ${errorText(error)}`)
    }

    // Opt in to OMP's rich `ask` dialog only when the host can put a form to the user (omp acp does the same
    // for clients with form elicitation). Without it `ask` degrades to a plain `select`, which is dismissed.
    if (this.elicitationHandler !== undefined) {
      try {
        await this.request({ type: 'set_ask_dialog', enabled: true }, this.requestTimeoutMs).response
      } catch (error) {
        this.log(`OMP set_ask_dialog was rejected: ${errorText(error)}`)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Attaching to a session
  // ---------------------------------------------------------------------------

  private async statsRequest(timeoutMs: number): Promise<SessionStats> {
    const data = asObject(await this.request({ type: 'get_session_stats' }, timeoutMs).response)
    const sessionId = readString(data?.sessionId)
    if (data === undefined || sessionId === undefined || sessionId.length === 0) {
      throw new NativeTransportError('OMP did not report a session id', 'protocol-error')
    }
    return { sessionId, sessionFile: readString(data.sessionFile), data }
  }

  private async attachSession(target: NativeSessionTarget): Promise<void> {
    // The process booted a fresh in-memory session for this cwd; ACP does the same before it loads one.
    const boot = await this.statsRequest(this.requestTimeoutMs)
    this.projector?.reset()
    switch (target.kind) {
      case 'new':
        await this.sessionChange(
          { type: 'new_session' },
          'start a new session',
          'new-session-failed',
          'an extension vetoed the new session',
        )
        break
      case 'resume': {
        const file = await this.locateSession(target.sessionId, boot)
        await this.sessionChange(
          { type: 'switch_session', sessionPath: file },
          `resume session ${target.sessionId}`,
          'resume-failed',
          'the session was recorded for another working directory (OMP refuses to switch across directories) or an extension vetoed the switch',
        )
        break
      }
      case 'fork': {
        const file = await this.locateSession(target.parentSessionId, boot)
        await this.sessionChange(
          { type: 'switch_session', sessionPath: file },
          `open session ${target.parentSessionId} to fork it`,
          'fork-failed',
          'the session was recorded for another working directory or an extension vetoed the switch',
        )
        await this.sessionChange(
          { type: 'fork' },
          `fork session ${target.parentSessionId}`,
          'fork-failed',
          'the session is busy or an extension vetoed the fork',
        )
        break
      }
    }
    const stats = await this.statsRequest(this.requestTimeoutMs)
    if (target.kind === 'resume' && stats.sessionId !== target.sessionId) {
      throw new NativeTransportError(
        `OMP attached session ${stats.sessionId} instead of ${target.sessionId}`,
        'resume-failed',
      )
    }
    if (target.kind === 'fork' && stats.sessionId === target.parentSessionId) {
      throw new NativeTransportError(`OMP did not fork session ${target.parentSessionId}`, 'fork-failed')
    }
    this.sessionIdValue = stats.sessionId
    this.sessionFile = stats.sessionFile
    this.applyStats(stats.data)
  }

  private async locateSession(sessionId: string, boot: SessionStats): Promise<string> {
    if (boot.sessionFile === undefined) {
      throw new NativeTransportError(
        'OMP runs without session persistence, so stored sessions cannot be opened',
        'persistence-disabled',
      )
    }
    const agentDir = this.agentEnv['PI_CODING_AGENT_DIR']
    const file = await findOmpSessionFile({
      sessionId,
      referenceFile: boot.sessionFile,
      ...(agentDir === undefined || agentDir.length === 0 ? {} : { extraRoots: [join(agentDir, 'sessions')] }),
    })
    if (file === undefined) {
      throw new NativeTransportError(
        `OMP session not found: ${sessionId}`,
        'session-not-found',
        `searched ${dirname(boot.sessionFile)} and the sibling session directories`,
      )
    }
    return file
  }

  private async sessionChange(command: JsonObject, action: string, failureCode: string, cancelledWhy: string): Promise<void> {
    let data: JsonObject | undefined
    try {
      data = asObject(await this.request(command, SESSION_COMMAND_TIMEOUT_MS).response)
    } catch (error) {
      if (error instanceof NativeTransportError && error.code === 'request-failed') {
        throw new NativeTransportError(`OMP could not ${action}`, failureCode, error.detail)
      }
      throw error
    }
    if (readBoolean(data?.cancelled) === true) {
      throw new NativeTransportError(`OMP did not ${action}`, failureCode, `the vendor reported cancelled:true: ${cancelledWhy}`)
    }
  }

  // ---------------------------------------------------------------------------
  // Controls state
  // ---------------------------------------------------------------------------

  private async loadControlState(): Promise<void> {
    await this.refreshState()
    await this.loadThinkingLevels()
    await this.loadModels()
    await this.refreshThinkingSelector()
    this.rebuildControls()
    this.emittedSignature = controlsSignature(this.controlsValue)
  }

  /** `auto` is only visible in the transcript (the state reports the level it resolved to). */
  private async refreshThinkingSelector(): Promise<void> {
    if (this.sessionFile === undefined) return
    const recorded = await readOmpSessionThinking(this.sessionFile)
    if (recorded?.configured === THINKING_AUTO) this.thinkingAuto = true
  }

  /** `get_state`: the current model, the effective thinking level and the `/fast` and `/slow` switches. */
  private async refreshState(): Promise<void> {
    const state = asObject(await this.request({ type: 'get_state' }, SESSION_COMMAND_TIMEOUT_MS).response)
    if (state === undefined) return
    this.goal = parseOmpGoal(asObject(state.goal)?.goal)
    const model = parseOmpModel(state.model)
    if (model !== undefined) this.model = model
    this.thinkingLevel = readString(state.thinkingLevel)
    this.fastMode = readBoolean(state.fastModeEnabled)
    this.slowMode =
      readBoolean(state.slowModeSupported) === true ? (readBoolean(state.slowModeEnabled) ?? false) : undefined
  }

  private async loadThinkingLevels(): Promise<void> {
    try {
      const data = asObject(await this.request({ type: 'get_available_thinking_levels' }, this.requestTimeoutMs).response)
      const levels = readStringArray(data?.levels)
      this.thinkingLevels = levels.includes(THINKING_OFF) ? levels : [THINKING_OFF, ...levels]
    } catch (error) {
      if (this.exitError !== undefined) throw this.exitError
      this.log(`OMP get_available_thinking_levels failed: ${errorText(error)}`)
    }
  }

  private async loadModels(): Promise<void> {
    try {
      const data = asObject(await this.request({ type: 'get_available_models' }, this.modelListTimeoutMs).response)
      const models: OmpModelInfo[] = []
      for (const raw of readArray(data?.models) ?? []) {
        const model = parseOmpModel(raw)
        if (model !== undefined) models.push(model)
      }
      this.models = models
    } catch (error) {
      if (this.exitError !== undefined || this.closing) throw this.exitError ?? error
      // Discovery can be slow or offline; the picker degrades to the current model and the full list
      // follows with a `controls` event once a retry succeeds.
      this.log(`OMP get_available_models failed: ${errorText(error)}`)
      this.scheduleModelListRetry(0)
    }
  }

  private scheduleModelListRetry(attempt: number): void {
    const delay = this.modelListRetryDelaysMs[attempt]
    if (delay === undefined || this.closing) return
    this.modelListRetryTimer = setTimeout(() => {
      this.modelListRetryTimer = undefined
      if (this.closing) return
      this.request({ type: 'get_available_models' }, this.modelListTimeoutMs).response.then(
        (raw) => {
          const models: OmpModelInfo[] = []
          for (const entry of readArray(asObject(raw)?.models) ?? []) {
            const model = parseOmpModel(entry)
            if (model !== undefined) models.push(model)
          }
          this.models = models
          this.onControlInputsChanged()
        },
        (error: unknown) => {
          this.log(`OMP get_available_models retry ${attempt + 1} failed: ${errorText(error)}`)
          this.scheduleModelListRetry(attempt + 1)
        },
      )
    }, delay)
  }

  private rebuildControls(): void {
    const models = this.models.length > 0 ? this.models : this.model === undefined ? [] : [this.model]
    this.controlsValue = deriveOmpControls({
      models,
      model: this.model,
      thinkingLevels: this.thinkingLevels,
      thinkingLevel: this.thinkingLevel,
      thinkingAuto: this.thinkingAuto,
      fastMode: this.fastMode,
      slowMode: this.slowMode,
    })
  }

  /** Rebuild after a vendor-side change and tell the host when the visible controls differ. */
  private onControlInputsChanged(): void {
    this.rebuildControls()
    if (this.selfChange > 0 || !this.started) return
    const signature = controlsSignature(this.controlsValue)
    if (signature === this.emittedSignature) return
    this.emittedSignature = signature
    this.emit({ kind: 'controls', controls: this.controlsValue })
  }

  /** `model_changed` carries no payload: re-read the model, its thinking levels and the effective level. */
  private scheduleModelRefresh(): void {
    if (this.modelRefresh !== undefined) {
      this.modelRefreshDirty = true
      return
    }
    this.modelRefresh = (async () => {
      do {
        this.modelRefreshDirty = false
        try {
          await this.refreshState()
          await this.loadThinkingLevels()
          this.onControlInputsChanged()
        } catch (error) {
          this.log(`OMP control refresh failed: ${errorText(error)}`)
        }
      } while (this.modelRefreshDirty && !this.closing)
    })().finally(() => {
      this.modelRefresh = undefined
    })
  }

  async setConfigOption(configId: string, value: string | boolean, signal?: AbortSignal): Promise<void> {
    this.assertUsable()
    if (configId === 'fast' || configId === 'slow') {
      if (typeof value !== 'boolean') {
        throw new NativeTransportError(`Config option ${configId} takes a boolean`, 'unsupported-config-value')
      }
      const enabled = value
      return this.writeConfig(signal, () =>
        raceAbort(configId === 'fast' ? this.applyFast(enabled) : this.applySlow(enabled), signal),
      )
    }
    if (typeof value === 'boolean') {
      throw new NativeTransportError(`Unsupported boolean config option: ${configId}`, 'unsupported-config-value')
    }
    return this.writeConfig(signal, async () => {
      switch (configId) {
        case 'mode':
          this.applyMode(value)
          break
        case 'model':
          await raceAbort(this.applyModel(value), signal)
          break
        case 'thinking':
          await raceAbort(this.applyThinking(value), signal)
          break
        default:
          throw new NativeTransportError(`Unknown config option: ${configId}`, 'unknown-config-option')
      }
    })
  }

  /** One serialized control write: the vendor change, then a rebuild the caller reads back through `controls()`. */
  private writeConfig(signal: AbortSignal | undefined, apply: () => Promise<void>): Promise<void> {
    const run = this.configTail.then(async () => {
      if (signal?.aborted === true) throw abortReason(signal)
      this.selfChange += 1
      try {
        await apply()
      } finally {
        this.selfChange -= 1
      }
      this.rebuildControls()
      // The caller reads `controls()` after this resolves; only later vendor-side changes are events.
      this.emittedSignature = controlsSignature(this.controlsValue)
    })
    this.configTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private applyMode(modeId: string): void {
    if (modeId === ACP_MODE_ID_DEFAULT) return
    if (modeId === ACP_MODE_ID_PLAN) {
      throw new NativeTransportError(
        'OMP plan mode is not available over the native rpc-ui protocol',
        'plan-mode-unsupported',
        'rpc-ui has no plan-mode command: `/plan` is a terminal-only handler and extensions have no plan API. ' +
          'Plan with this member through the ACP route (`omp acp`), or stay in the default mode.',
      )
    }
    throw new NativeTransportError(`Unsupported mode: ${modeId}`, 'unknown-mode')
  }

  private async applyModel(modelValue: string): Promise<void> {
    // ACP re-applies the model unconditionally; re-selecting the current one only resets provider state.
    if (this.model !== undefined && ompModelValue(this.model) === modelValue) return
    let target = this.models.find((candidate) => ompModelValue(candidate) === modelValue)
    if (target === undefined) {
      await this.loadModels()
      target = this.models.find((candidate) => ompModelValue(candidate) === modelValue)
    }
    if (target === undefined) throw new NativeTransportError(`Unknown model: ${modelValue}`, 'unknown-model')
    const data = await this.request(
      { type: 'set_model', provider: target.provider, modelId: target.id },
      SESSION_COMMAND_TIMEOUT_MS,
    ).response
    this.model = parseOmpModel(data) ?? target
    // The thinking level is re-clamped to the new model: `thinking_level_changed` already updated it.
    await this.loadThinkingLevels()
  }

  private async applyThinking(selector: string): Promise<void> {
    if (!Object.hasOwn(THINKING_SELECTORS, selector)) {
      throw new NativeTransportError(`Unknown thinking level: ${selector}`, 'unknown-thinking-level')
    }
    await this.request({ type: 'set_thinking_level', level: selector }, this.requestTimeoutMs).response
    this.thinkingAuto = selector === THINKING_AUTO
  }

  private async applyFast(enabled: boolean): Promise<void> {
    if (this.fastMode === undefined) {
      throw new NativeTransportError('Unknown config option: fast', 'unknown-config-option')
    }
    const data = asObject(await this.request({ type: 'set_fast_mode', enabled }, this.requestTimeoutMs).response)
    this.fastMode = readBoolean(data?.enabled) ?? enabled
  }

  private async applySlow(enabled: boolean): Promise<void> {
    if (this.slowMode === undefined) {
      throw new NativeTransportError('Unknown config option: slow', 'unknown-config-option')
    }
    const data = asObject(await this.request({ type: 'set_slow_mode', enabled }, this.requestTimeoutMs).response)
    this.slowMode = readBoolean(data?.enabled) ?? enabled
  }

  private assertUsable(): void {
    if (this.closing) throw new NativeTransportError('OMP transport is closed', 'closed')
    if (this.exitError !== undefined) throw this.exitError
    if (!this.started) throw new NativeTransportError('OMP transport is not started', 'not-started')
  }

  // ---------------------------------------------------------------------------
  // Close
  // ---------------------------------------------------------------------------

  async close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    this.closing = true
    this.closePromise = this.shutdown()
    return this.closePromise
  }

  private async shutdown(): Promise<void> {
    this.closing = true
    this.stopContextPolling()
    this.busy = false
    this.agentRuns = 0
    if (this.modelListRetryTimer !== undefined) {
      clearTimeout(this.modelListRetryTimer)
      this.modelListRetryTimer = undefined
    }
    const closeError = this.exitError ?? new NativeTransportError('OMP transport is closed', 'closed')
    if (this.readyWaiter !== undefined) {
      this.readyWaiter.reject(closeError)
      this.readyWaiter = undefined
    }
    this.failPending(closeError)
    for (const dialog of this.dialogs.values()) dialog.abort()
    this.dialogs.clear()
    if (this.activePrompt !== undefined) this.failPrompt(this.activePrompt, closeError)
    if (this.activeSteer !== undefined) this.failSteer(this.activeSteer, closeError)
    if (this.activeBtw !== undefined) this.endBtw(this.activeBtw, closeError)

    const proc = this.proc
    if (proc !== undefined) {
      try {
        proc.stdin.end()
      } catch {
        // Cleanup race: the pipe may already be gone.
      }
      if (!(await this.waitForExit(this.stdinCloseGraceMs))) {
        proc.terminate()
        await this.waitForExit(TERMINATE_WAIT_MS)
      }
    }
    // omp watches the overlay's directory and reloads on change: it goes only after the process.
    await this.removeOverlay()
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return true
    return (await settleWithin(this.exitDeferred.promise.then(() => true), timeoutMs)) === true
  }

  private failProcess(error: Error): void {
    if (this.exitError !== undefined) return
    this.exitError = error
    this.failPending(error)
    if (this.readyWaiter !== undefined) {
      this.readyWaiter.reject(error)
      this.readyWaiter = undefined
    }
    for (const dialog of this.dialogs.values()) dialog.abort()
    this.dialogs.clear()
    if (this.activePrompt !== undefined) {
      const prompt = this.activePrompt
      // A turn the user already got its answer for (held for background work) ends normally; the notice below
      // reports the lost process, and the next prompt re-attaches.
      if (prompt.aborted) void this.finishPrompt(prompt, { stopReason: 'cancelled' })
      else if (prompt.heldStop !== undefined) void this.finishPrompt(prompt, { stopReason: prompt.heldStop })
      else this.failPrompt(prompt, error)
    }
    if (this.activeSteer !== undefined) this.failSteer(this.activeSteer, error)
    if (this.activeBtw !== undefined) this.endBtw(this.activeBtw, error)
    this.stopContextPolling()
    this.busy = false
    this.agentRuns = 0
    if (!this.closing) {
      const detail = this.stderrTail()
      this.emitNotice(`${error.message}${detail.length === 0 ? '' : `: ${detail.slice(-500)}`}`)
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  // ---------------------------------------------------------------------------
  // stdio + frame decoding
  // ---------------------------------------------------------------------------

  private handleStdoutChunk(chunk: string): void {
    this.lineBuffer += chunk
    let newline = this.lineBuffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.lineBuffer.slice(0, newline).replace(/\r$/, '')
      this.lineBuffer = this.lineBuffer.slice(newline + 1)
      this.consumeLine(line)
      newline = this.lineBuffer.indexOf('\n')
    }
    if (this.lineBuffer.length > MAX_REASSEMBLED_BYTES * 2) {
      this.lineBuffer = ''
      this.reportMalformedFrame('stdout line exceeded the reassembly limit')
    }
  }

  private consumeLine(line: string): void {
    if (line.trim().length === 0) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.reportMalformedFrame('invalid JSON from OMP stdout')
      return
    }
    const frame = asObject(parsed)
    if (frame === undefined) return
    if (readString(frame.type) === 'rpc_chunk') {
      this.consumeChunk(frame)
      return
    }
    this.dispatchFrame(frame)
  }

  private consumeChunk(frame: JsonObject): void {
    const chunkId = readString(frame.chunkId)
    const index = readNumber(frame.index)
    const count = readNumber(frame.count)
    const byteLength = readNumber(frame.byteLength)
    const data = readString(frame.data)
    if (
      chunkId === undefined ||
      chunkId.length === 0 ||
      chunkId.length > 128 ||
      index === undefined ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      count === undefined ||
      !Number.isSafeInteger(count) ||
      count < 2 ||
      count > MAX_CHUNK_COUNT ||
      index >= count ||
      byteLength === undefined ||
      !Number.isSafeInteger(byteLength) ||
      byteLength < MAX_FRAME_BYTES ||
      byteLength > MAX_REASSEMBLED_BYTES ||
      data === undefined ||
      data.length === 0
    ) {
      this.dropChunkAssembly('invalid rpc_chunk header')
      return
    }
    if (data.length > MAX_CHUNK_DECODED_CHARS) {
      this.dropChunkAssembly('rpc_chunk payload too large')
      return
    }
    const bytes = Buffer.from(data, 'base64')
    if (bytes.byteLength > MAX_CHUNK_BYTES || bytes.toString('base64') !== data) {
      this.dropChunkAssembly('rpc_chunk payload is not canonical base64')
      return
    }
    let assembly = this.chunkAssembly
    if (assembly === undefined) {
      if (index !== 0) {
        this.dropChunkAssembly('rpc_chunk assembly started out of order')
        return
      }
      assembly = { id: chunkId, count, byteLength, parts: [], bytes: 0 }
      this.chunkAssembly = assembly
    }
    if (
      assembly.id !== chunkId ||
      assembly.count !== count ||
      assembly.byteLength !== byteLength ||
      assembly.parts.length !== index
    ) {
      this.dropChunkAssembly('rpc_chunk out of order')
      return
    }
    assembly.parts.push(bytes)
    assembly.bytes += bytes.byteLength
    if (assembly.bytes > assembly.byteLength) {
      this.dropChunkAssembly('rpc_chunk byte length mismatch')
      return
    }
    if (assembly.parts.length < assembly.count) return
    this.chunkAssembly = undefined
    if (assembly.bytes !== assembly.byteLength) {
      this.reportMalformedFrame('rpc_chunk reassembly length mismatch')
      return
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(assembly.parts))
      const reassembled = asObject(JSON.parse(text))
      if (reassembled === undefined) {
        this.reportMalformedFrame('reassembled rpc_chunk is not a JSON object')
        return
      }
      this.dispatchFrame(reassembled)
    } catch {
      this.reportMalformedFrame('reassembled rpc_chunk is not valid UTF-8 JSON')
    }
  }

  private dropChunkAssembly(reason: string): void {
    this.chunkAssembly = undefined
    this.reportMalformedFrame(reason)
  }

  private reportMalformedFrame(reason: string): void {
    this.malformedFrames += 1
    if (this.malformedFrames <= 5) this.log(`ignoring malformed OMP frame: ${reason}`)
  }

  private dispatchFrame(frame: JsonObject): void {
    const type = readString(frame.type)
    if (type === 'ready') {
      this.resolveReady(frame)
      return
    }
    if (type === 'response') {
      this.handleResponse(frame)
      return
    }
    try {
      this.handleEvent(frame, type)
    } catch (error) {
      this.log(`OMP ${type ?? 'unknown'} frame handler failed: ${errorText(error)}`)
    }
  }

  private writeFrame(frame: JsonObject): boolean {
    const proc = this.proc
    if (proc === undefined || this.closing) return false
    if (proc.stdin.destroyed || !proc.stdin.writable) return false
    try {
      proc.stdin.write(`${JSON.stringify(frame)}\n`)
      return true
    } catch (error) {
      this.log(`writing to OMP stdin failed: ${errorText(error)}`)
      return false
    }
  }

  private mintRequestId(): string {
    const id = `req_${this.nextRequestId}`
    this.nextRequestId += 1
    return id
  }

  private request(
    command: JsonObject,
    timeoutMs: number = this.requestTimeoutMs,
    id: string = this.mintRequestId(),
  ): { id: string; response: Promise<unknown> } {
    const { promise: response, resolve, reject } = Promise.withResolvers<unknown>()
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            const pending = this.pending.get(id)
            if (pending === undefined) return
            this.pending.delete(id)
            pending.reject(
              new NativeTransportError(
                `OMP ${pending.command} request timed out`,
                'request-timeout',
                `phase=${pending.command} timeoutMs=${timeoutMs}\n${this.stderrTail()}`,
              ),
            )
          }, timeoutMs)
        : undefined
    this.pending.set(id, { command: readString(command.type) ?? 'command', resolve, reject, timer })
    if (!this.writeFrame({ ...command, id })) {
      const pending = this.pending.get(id)
      if (pending !== undefined) {
        this.pending.delete(id)
        clearTimeout(pending.timer)
      }
      reject(
        this.exitError ?? new NativeTransportError('OMP stdin is not writable', 'transport-closed', this.stderrTail()),
      )
    }
    return { id, response }
  }

  private handleResponse(frame: JsonObject): void {
    const id = readString(frame.id)
    const pending = id === undefined ? undefined : this.pending.get(id)
    if (pending !== undefined && id !== undefined) {
      this.pending.delete(id)
      clearTimeout(pending.timer)
      if (readBoolean(frame.success) === true) {
        pending.resolve(frame.data)
      } else {
        pending.reject(
          new NativeTransportError(
            `OMP ${pending.command} failed`,
            'request-failed',
            readString(frame.error) ?? `OMP ${pending.command} failed`,
          ),
        )
      }
      return
    }
    // A late duplicate response (OMP answers a streaming prompt with error first, success second, same
    // id) is a diagnostic, not a turn outcome: `prompt_result` owns terminal state.
    if (readString(frame.command) === 'prompt' && readBoolean(frame.success) === false) {
      const prompt = this.activePrompt
      if (prompt !== undefined && (id === undefined || prompt.id === id)) {
        prompt.admissionError ??= new NativeTransportError(
          'OMP rejected the prompt',
          'prompt-rejected',
          readString(frame.error) ?? 'OMP rejected the prompt',
        )
      }
      return
    }
    const command = readString(frame.command)
    // Context polls legitimately race turn settlement/close; a late answer is expected there.
    if (command !== 'get_session_stats' && command !== 'get_state') {
      this.log(`ignoring unsolicited OMP response id=${id ?? 'none'} command=${command ?? 'unknown'}`)
    }
  }

  private resolveReady(frame: JsonObject): void {
    this.readyFrame = frame
    const waiter = this.readyWaiter
    if (waiter === undefined) return
    this.readyWaiter = undefined
    waiter.resolve(frame)
  }

  private waitForReady(): Promise<JsonObject> {
    if (this.readyFrame !== undefined) return Promise.resolve(this.readyFrame)
    if (this.exitError !== undefined) return Promise.reject(this.exitError)
    const ready = Promise.withResolvers<JsonObject>()
    const timer = setTimeout(() => {
      if (this.readyWaiter === undefined) return
      this.readyWaiter = undefined
      ready.reject(
        new NativeTransportError(
          'OMP did not become ready',
          'ready-timeout',
          `waited ${this.readyTimeoutMs}ms\n${this.stderrTail()}`,
        ),
      )
    }, this.readyTimeoutMs)
    this.readyWaiter = {
      resolve: (frame) => {
        clearTimeout(timer)
        ready.resolve(frame)
      },
      reject: (error) => {
        clearTimeout(timer)
        ready.reject(error)
      },
    }
    return ready.promise
  }

  // ---------------------------------------------------------------------------
  // Event projection
  // ---------------------------------------------------------------------------

  private handleEvent(frame: JsonObject, type: string | undefined): void {
    switch (type) {
      case 'agent_start':
        this.agentRuns += 1
        this.setBusy(true)
        this.noteAgentStart()
        return
      case 'agent_end':
        this.agentRuns = Math.max(0, this.agentRuns - 1)
        this.handleAgentEnd(frame)
        return
      case 'session_settled':
        this.settledFrames += 1
        this.agentRuns = 0
        this.setBusy(false)
        this.handleSessionSettled()
        return
      case 'prompt_result':
        this.handlePromptResult(frame)
        return
      case 'message_start':
      case 'message_end':
        this.handleMessageBoundary(frame, type)
        this.projectTurnFrame(frame)
        return
      case 'message_update':
      case 'tool_execution_start':
      case 'tool_execution_update':
      case 'tool_execution_end':
      case 'todo_reminder':
      case 'todo_auto_clear':
      case 'command_output':
        this.projectTurnFrame(frame)
        return
      case 'turn_end':
        this.handleTurnEnd(frame)
        return
      case 'queue_update':
        this.handleQueueUpdate(frame)
        return
      case 'extension_ui_request':
        void this.handleExtensionUiRequest(frame)
        return
      case 'available_commands_update':
        this.handleCommandsUpdate(frame)
        return
      case 'goal_updated':
        this.handleGoalUpdated(frame)
        return
      // Side-question frames belong to the waiter of `sideQuestion()`, never to the turn.
      case 'btw_record': {
        const record = asObject(frame.record)
        if (this.activeBtw !== undefined && record !== undefined) this.noteBtwRecord(this.activeBtw, record)
        return
      }
      case 'btw_delta': {
        const btw = this.activeBtw
        if (btw?.recordId !== undefined && readString(frame.recordId) === btw.recordId) {
          btw.streamed += readString(frame.delta) ?? ''
          if (btw.streamed.length > btw.answer.length) btw.answer = btw.streamed
        }
        return
      }
      case 'session_info_update': {
        const title = readString(frame.title)
        this.emit({
          kind: 'update',
          update: {
            sessionUpdate: 'session_info_update',
            ...(title === undefined ? {} : { title }),
            updatedAt: new Date().toISOString(),
          },
        })
        return
      }
      case 'model_changed':
        if (this.started && this.selfChange === 0) this.scheduleModelRefresh()
        return
      case 'thinking_level_changed':
        this.handleThinkingLevelChanged(frame)
        return
      case 'config_update':
        this.handleConfigUpdate(frame)
        return
      case 'notice':
        this.emitNoticeFrame(frame)
        this.projectTurnFrame(frame)
        return
      case 'retry_fallback_applied':
      case 'retry_fallback_succeeded':
      case 'auto_retry_start':
      case 'auto_retry_end':
      case 'auto_compaction_start':
      case 'auto_compaction_end':
      case 'extension_error': {
        const note = describeOmpNotice(frame)
        if (note !== undefined) this.emitNotice(note)
        this.projectTurnFrame(frame)
        return
      }
      case 'rpc_frame_error':
        this.emitNotice(
          `OMP dropped an oversized frame (${readString(frame.originalType) ?? 'unknown'}): ${readString(frame.error) ?? 'transport limit'}`,
        )
        return
      default:
        // subagent_* / host_* / live_* and the remaining telemetry frames need no projection.
        return
    }
  }

  /** Turn content is only forwarded while a `prompt()` owns the turn, exactly like `#handlePromptEvent`. */
  private projectTurnFrame(frame: JsonObject): void {
    const prompt = this.activePrompt
    if (prompt === undefined || prompt.aborted) return
    prompt.lastActivityAt = Date.now()
    for (const update of this.projector?.project(frame) ?? []) this.emit({ kind: 'update', update })
  }

  private handleMessageBoundary(frame: JsonObject, type: 'message_start' | 'message_end'): void {
    const message = asObject(frame.message)
    if (message === undefined) return
    const role = readString(message.role)
    if (role === 'user') {
      this.noteSteeringMessage(message)
      return
    }
    if (type !== 'message_end' || role !== 'assistant') return
    const prompt = this.activePrompt
    if (prompt === undefined) return
    prompt.usage.add(message.usage, readString(frame.messageId))
    const stopReason = readString(message.stopReason)
    if (stopReason !== undefined) prompt.lastStopReason = stopReason
  }

  private handleTurnEnd(frame: JsonObject): void {
    const message = asObject(frame.message)
    if (message === undefined || readString(message.role) !== 'assistant') return
    const prompt = this.activePrompt
    if (prompt === undefined) return
    const stopReason = readString(message.stopReason)
    if (stopReason !== undefined) prompt.lastStopReason = stopReason
  }

  private handleAgentEnd(frame: JsonObject): void {
    const prompt = this.activePrompt
    if (prompt !== undefined) {
      prompt.lastActivityAt = Date.now()
      const messages = readArray(frame.messages) ?? []
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = asObject(messages[index])
        if (message === undefined || readString(message.role) !== 'assistant') continue
        const stopReason = readString(message.stopReason)
        if (stopReason !== undefined) prompt.lastStopReason = stopReason
        const errorMessage = readString(message.errorMessage)
        prompt.lastAssistantError =
          stopReason === 'error' && errorMessage !== undefined && errorMessage.length > 0 && errorMessage !== SILENT_ABORT_MARKER
            ? errorMessage
            : undefined
        break
      }
    }
    // `yielded:false` is the agent going on with its own work (retry, compaction, a stop-time reminder): no result yet.
    if (readBoolean(frame.yielded) !== false) this.schedulePromptResultFallback()
  }

  private handleThinkingLevelChanged(frame: JsonObject): void {
    this.thinkingLevel = readString(frame.thinkingLevel)
    // `configured` is present exactly when the selector differs from the effective level (auto).
    this.thinkingAuto = readString(frame.configured) === THINKING_AUTO
    this.onControlInputsChanged()
  }

  /** `config_update` follows `/model` and `/thinking` slash commands. */
  private handleConfigUpdate(frame: JsonObject): void {
    const model = parseOmpModel(frame.model)
    if (model !== undefined) this.model = model
    const level = readString(frame.thinkingLevel)
    if (level !== undefined) this.thinkingLevel = level
    if (this.started && this.selfChange === 0) this.scheduleModelRefresh()
    else this.onControlInputsChanged()
  }

  private handleQueueUpdate(frame: JsonObject): void {
    const steer = this.activeSteer
    if (steer === undefined) return
    const steering = readStringArray(frame.steering)
    const queued = steer.text.length === 0 ? steering.length > 0 : steering.some((entry) => entry === steer.text)
    if (queued) {
      steer.admitted = true
      return
    }
    // Admission was observed and the text is gone again: OMP consumed it.
    if (steer.admitted) steer.consumed = true
  }

  private noteSteeringMessage(message: JsonObject): void {
    const steer = this.activeSteer
    if (steer === undefined) return
    if (readBoolean(message.steering) !== true && readBoolean(message.liveSteered) !== true) return
    steer.consumed = true
    steer.injected = true
    // The transcript now contains our injected message; every other signal is inference.
    this.settleSteer(steer, 'injected')
  }

  private handlePromptResult(frame: JsonObject): void {
    const prompt = this.activePrompt
    if (prompt === undefined) return
    const id = readString(frame.id)
    if (id !== undefined && id !== prompt.id) return
    clearPromptTimers(prompt)
    prompt.resultSeen = true
    const sessionSettled = readBoolean(frame.sessionSettled)
    if (sessionSettled === true) {
      // Settled means nothing is running and nothing can wake the agent: no run is live, whatever frames were lost.
      this.agentRuns = 0
      this.setBusy(false)
    }
    const status = readString(frame.status) ?? 'completed'
    const errorMessage = readString(asObject(frame.error)?.message)
    if (status === 'error' && readBoolean(frame.agentInvoked) === false) {
      // Rejected before the agent ran (e.g. a prompt into a running turn): nothing was answered.
      const message = errorMessage ?? 'OMP prompt failed'
      this.emitNotice(`OMP prompt failed: ${message}`)
      this.failPrompt(prompt, new NativeTransportError('OMP prompt failed', 'prompt-failed', message))
      return
    }
    // A provider failure ends the turn like ACP does: the error text is the visible reply.
    const failure = status === 'error' ? (prompt.lastAssistantError ?? errorMessage) : undefined
    if (!prompt.aborted) {
      for (const update of this.projector?.flushTurnError({
        assistantError: prompt.lastAssistantError,
        promptError: status === 'error' ? errorMessage : undefined,
      }) ?? []) {
        this.emit({ kind: 'update', update })
      }
    }
    // omp ends a local command such as `/fresh` with an aborted result nobody asked for: no agent run, no output.
    const unrequestedAbort = status === 'aborted' && !prompt.aborted && prompt.slash && !prompt.agentRan
    const stopReason: NativePromptResult['stopReason'] =
      prompt.aborted || (status === 'aborted' && !unrequestedAbort)
        ? 'cancelled'
        : prompt.lastStopReason === 'length'
          ? 'max_tokens'
          : failure !== undefined && /content[_ ]?filter|refus(al|ed)/i.test(failure)
            ? 'refusal'
            : 'end_turn'
    if (status === 'completed' && sessionSettled === false && !prompt.aborted) {
      // The agent yielded, but background work can still wake it: the wake run's output belongs to this turn.
      prompt.heldStop = stopReason
      prompt.lastActivityAt = Date.now()
      this.armHoldTimer(prompt, this.wakeSettleMs)
      return
    }
    const usage = prompt.usage.snapshot()
    void this.finishPrompt(prompt, { stopReason, ...(usage === undefined ? {} : { usage }) })
  }

  /** A new run supersedes a terminal frame that was waiting for its `prompt_result`. */
  private noteAgentStart(): void {
    const prompt = this.activePrompt
    if (prompt === undefined) return
    prompt.agentRan = true
    prompt.lastActivityAt = Date.now()
    if (prompt.fallbackTimer !== undefined) {
      clearTimeout(prompt.fallbackTimer)
      prompt.fallbackTimer = undefined
    }
  }

  /** The session went quiet: that ends a turn held for background work, and settles one that never got a result. */
  private handleSessionSettled(): void {
    const prompt = this.activePrompt
    if (prompt?.heldStop !== undefined) {
      void this.finishPrompt(prompt, { stopReason: prompt.heldStop })
      return
    }
    if (prompt === undefined) void this.refreshContextUsage(TURN_END_CONTEXT_TIMEOUT_MS).catch(() => undefined)
    this.schedulePromptResultFallback()
  }

  /**
   * Ends a held turn that saw no activity for `wakeSettleMs`. The bound is on silence, not on the turn: a run that keeps
   * producing frames postpones it, and so does a run that is live but quiet (a long tool call of a goal run). It only
   * waits out a session that went quiet without saying so.
   */
  private armHoldTimer(prompt: ActivePromptState, delayMs: number): void {
    prompt.holdTimer = setTimeout(() => {
      prompt.holdTimer = undefined
      if (this.activePrompt !== prompt || prompt.heldStop === undefined) return
      const remaining = this.wakeSettleMs - (Date.now() - prompt.lastActivityAt)
      if (remaining > 0 || this.agentRuns > 0) {
        this.armHoldTimer(prompt, remaining > 0 ? remaining : this.wakeSettleMs)
        return
      }
      this.log('OMP did not settle after the agent yielded; ending the turn')
      void this.finishPrompt(prompt, { stopReason: prompt.heldStop })
    }, delayMs)
  }

  private schedulePromptResultFallback(): void {
    const prompt = this.activePrompt
    if (prompt === undefined || prompt.resultSeen || prompt.fallbackTimer !== undefined) return
    prompt.fallbackTimer = setTimeout(() => {
      prompt.fallbackTimer = undefined
      if (this.activePrompt !== prompt) return
      // COMPAT(ompPromptResultFallback): older OMP releases only end the run with agent_end.
      this.log('OMP did not report prompt_result; settling from the terminal run frame')
      if (!prompt.aborted) {
        for (const update of this.projector?.flushTurnError({ assistantError: prompt.lastAssistantError }) ?? []) {
          this.emit({ kind: 'update', update })
        }
      }
      const usage = prompt.usage.snapshot()
      void this.finishPrompt(prompt, {
        stopReason: prompt.aborted ? 'cancelled' : prompt.lastStopReason === 'length' ? 'max_tokens' : 'end_turn',
        ...(usage === undefined ? {} : { usage }),
      })
    }, this.promptResultFallbackMs)
  }

  /**
   * The goal changed: a command, the agent's own `goal` tool, or the counters that move with every turn. Only a new goal or a new status
   * is worth a line; a `/goal` command's reply already says what that command did. Outside a turn the line is only logged.
   */
  private handleGoalUpdated(frame: JsonObject): void {
    const next = parseOmpGoal(frame.goal)
    const note = this.goalCommandOpen ? undefined : goalNote(this.goal, next)
    // A dropped goal is gone: omp reports it once, with that status, and clears its state without another frame.
    this.goal = next === undefined || next.status === 'dropped' ? undefined : next
    if (note === undefined) return
    this.emitNotice(note)
    const prompt = this.activePrompt
    if (prompt === undefined || prompt.aborted || this.projector === undefined) return
    prompt.lastActivityAt = Date.now()
    this.emit({ kind: 'update', update: this.projector.note(note) })
  }

  /** The catalog reaches the host as a `commands` event: the first one always, later ones when they differ. */
  private handleCommandsUpdate(frame: JsonObject): void {
    if (!Array.isArray(frame.commands)) return
    const catalog = buildOmpCommandCatalog(frame.commands)
    this.catalogOverrides = catalog.overrides
    const signature = JSON.stringify(catalog.commands)
    const reported = this.liveCatalog !== undefined
    this.liveCatalog = catalog.commands
    if (reported && signature === this.catalogSignature) return
    this.catalogSignature = signature
    this.emit({ kind: 'commands', commands: catalog.commands })
  }

  // ---------------------------------------------------------------------------
  // Context + busy tracking
  // ---------------------------------------------------------------------------

  /** `usage_update` semantics: window occupancy plus cumulative session cost. */
  private applyStats(data: JsonObject): void {
    const context = asObject(data.contextUsage)
    const size = readNumber(context?.contextWindow)
    if (context === undefined || size === undefined || size <= 0) return
    const used = readNumber(context.tokens) ?? 0
    const cost = readNumber(data.cost)
    const next: NativeContextUsage = {
      used,
      size,
      ...(cost !== undefined && cost > 0 ? { cost: { amount: cost, currency: 'USD' } } : {}),
    }
    const previous = this.contextUsageValue
    if (previous?.used === next.used && previous.size === next.size && previous.cost?.amount === next.cost?.amount) return
    this.contextUsageValue = next
    this.emit({ kind: 'context_usage', contextUsage: next })
  }

  private async refreshContextUsage(timeoutMs: number = this.requestTimeoutMs): Promise<void> {
    if (this.closing || this.exitError !== undefined) return
    const data = asObject(await this.request({ type: 'get_session_stats' }, timeoutMs).response)
    if (data === undefined) return
    this.applyStats(data)
  }

  private setBusy(busy: boolean): void {
    if (this.busy === busy) return
    this.busy = busy
    if (busy) this.startContextPolling()
    else this.stopContextPolling()
  }

  private startContextPolling(): void {
    this.stopContextPolling()
    const tick = (): void => {
      if (this.closing || !this.busy) return
      if (!this.contextPollInFlight) {
        this.contextPollInFlight = true
        void this.refreshContextUsage()
          .catch((error: unknown) => {
            this.log(`OMP context usage poll failed: ${errorText(error)}`)
          })
          .finally(() => {
            this.contextPollInFlight = false
          })
      }
      this.contextPollTimer = setTimeout(tick, this.contextPollIntervalMs)
    }
    tick()
  }

  private stopContextPolling(): void {
    if (this.contextPollTimer !== undefined) {
      clearTimeout(this.contextPollTimer)
      this.contextPollTimer = undefined
    }
  }

  // ---------------------------------------------------------------------------
  // Prompting
  // ---------------------------------------------------------------------------

  async prompt(content: readonly NativeContentBlock[], signal: AbortSignal): Promise<NativePromptResult> {
    this.assertUsable()
    if (this.activePrompt !== undefined || this.activeShell !== undefined) {
      throw new NativeTransportError('OMP prompt is already in flight', 'prompt-in-flight')
    }
    if (this.rewinding) throw new NativeTransportError('The OMP conversation is being changed', 'busy')
    if (signal.aborted) throw abortReason(signal)
    const { message, images } = splitContent(content)
    if (message.length === 0 && images.length === 0) {
      throw new NativeTransportError('OMP prompt needs text or image content', 'empty-prompt')
    }
    const shellLine = userShellLine(content)
    if (shellLine !== undefined) return await this.runUserShell(shellLine, signal)
    const goalArgs = this.goalCommandArgs(message)
    if (goalArgs !== undefined) return await this.runGoalCommand(goalArgs, signal)
    const refusal = this.terminalOnlyReply(message)
    if (refusal !== undefined) return this.answerLocally(refusal)

    const prompt = this.openPrompt(message.startsWith('/'))
    const request = this.request(
      {
        type: 'prompt',
        message,
        ...(images.length > 0 ? { images } : {}),
        // omp refuses a plain prompt while a run it started itself is streaming (the wake run after background
        // work); queued behind that run, the prompt is processed at its next yield.
        ...(this.busy ? { streamingBehavior: 'followUp' } : {}),
      },
      this.requestTimeoutMs,
      prompt.id,
    )

    // The acknowledgement means "admitted", never "turn finished"; local-only slash commands report
    // `agentInvoked:false` and never emit prompt_result.
    request.response.then(
      (data) => {
        if (this.activePrompt !== prompt) return
        const record = asObject(data)
        if (record !== undefined && readBoolean(record.agentInvoked) === false) {
          void this.finishPrompt(prompt, { stopReason: 'end_turn' })
        }
      },
      (error: unknown) => {
        if (this.activePrompt !== prompt) return
        prompt.admissionError =
          error instanceof Error
            ? error
            : new NativeTransportError('OMP rejected the prompt', 'prompt-rejected', String(error))
        // Newer OMP reports rejection through prompt_result only; older builds emit a bare failed
        // response, so give the terminal frame a short grace before giving up.
        prompt.admissionTimer = setTimeout(() => {
          prompt.admissionTimer = undefined
          if (this.activePrompt !== prompt) return
          this.failPrompt(
            prompt,
            prompt.admissionError ?? new NativeTransportError('OMP rejected the prompt', 'prompt-rejected'),
          )
        }, PROMPT_ADMISSION_GRACE_MS)
      },
    )

    this.watchAbort(prompt, signal)
    return prompt.deferred.promise
  }

  /** A turn owns the frames from the moment its command is written: register it before sending anything. */
  private openPrompt(slash: boolean): ActivePromptState {
    const prompt: ActivePromptState = {
      id: this.mintRequestId(),
      deferred: Promise.withResolvers<NativePromptResult>(),
      usage: new OmpUsageAccumulator(),
      slash,
      lastStopReason: undefined,
      lastAssistantError: undefined,
      admissionError: undefined,
      aborted: false,
      agentRan: false,
      resultSeen: false,
      heldStop: undefined,
      lastActivityAt: Date.now(),
      admissionTimer: undefined,
      abortTimer: undefined,
      fallbackTimer: undefined,
      holdTimer: undefined,
      removeAbortListener: undefined,
    }
    this.activePrompt = prompt
    this.projector?.reset()
    return prompt
  }

  /** The host's stop: interrupt omp, and end the turn even when omp never confirms. */
  private watchAbort(prompt: ActivePromptState, signal: AbortSignal): void {
    const onAbort = (): void => {
      if (this.activePrompt !== prompt || prompt.aborted) return
      prompt.aborted = true
      void this.interrupt().catch((error: unknown) => {
        this.log(`OMP abort request failed: ${errorText(error)}`)
      })
      // A turn held for background work has no run of its own to confirm the abort, unless a wake run is streaming.
      if (prompt.heldStop !== undefined) {
        prompt.heldStop = 'cancelled'
        if (this.agentRuns === 0) {
          void this.finishPrompt(prompt, { stopReason: 'cancelled' })
          return
        }
      }
      prompt.abortTimer = setTimeout(() => {
        prompt.abortTimer = undefined
        if (this.activePrompt !== prompt) return
        void this.finishPrompt(prompt, { stopReason: 'cancelled' })
      }, this.abortGraceMs)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    prompt.removeAbortListener = () => {
      signal.removeEventListener('abort', onAbort)
    }
  }

  /** The refusal for a `/name` omp keeps terminal-only, unless an extension, custom or file command owns the name. */
  private terminalOnlyReply(message: string): string | undefined {
    const name = slashCommandName(message)
    if (name === undefined || !Object.hasOwn(TERMINAL_ONLY_COMMANDS, name) || this.catalogOverrides.has(name)) return undefined
    return Object.hasOwn(SERVED_COMMANDS, name)
      ? `/${name} runs as a command of its own, not as part of a message. Nothing was sent to the model.`
      : `/${name} is a terminal-only Oh My Pi command and has no effect in this session. Nothing was sent to the model.`
  }

  /** One assistant line the transport itself says, inside the turn that is open. */
  private say(text: string): void {
    const update = this.projector?.reply(text)
    if (update !== undefined) this.emit({ kind: 'update', update })
  }

  /** Answer a prompt on the transport's own authority: one assistant line, no round trip to omp, no model turn. */
  private answerLocally(text: string): NativePromptResult {
    this.say(text)
    return { stopReason: 'end_turn' }
  }

  // ---------------------------------------------------------------------------
  // Goals
  // ---------------------------------------------------------------------------

  /** The arguments of `/goal …` when the transport runs it (rpc `goal`); an extension, custom or file command named `goal` keeps the line. */
  private goalCommandArgs(message: string): string | undefined {
    if (slashCommandName(message) !== 'goal' || this.catalogOverrides.has('goal')) return undefined
    return slashCommandArgs(message)
  }

  /**
   * `/goal`: rpc `goal`. Its reply is the whole turn unless omp goes on working by itself (an active goal under a configuration that
   * lets rpc hosts continue goals): then the turn stays open, like a wake turn, until omp settles, so the runs omp starts reach the
   * host and the user's stop reaches them.
   */
  private runGoalCommand(args: string, signal: AbortSignal): Promise<NativePromptResult> {
    const prompt = this.openPrompt(true)
    // No `prompt_result` is coming: a goal command is answered by the response to its own rpc.
    prompt.resultSeen = true
    this.watchAbort(prompt, signal)
    void this.answerGoalCommand(prompt, parseGoalArgs(args))
    return prompt.deferred.promise
  }

  private async answerGoalCommand(prompt: ActivePromptState, request: GoalRequest): Promise<void> {
    try {
      const outcome = await this.goalOutcome(request)
      if (this.activePrompt !== prompt) return
      if (prompt.aborted) {
        await this.finishPrompt(prompt, { stopReason: 'cancelled' })
        return
      }
      this.say(outcome.text)
      if (outcome.working) {
        const continues = await this.goalContinues()
        if (this.activePrompt !== prompt) return
        if (continues && !prompt.aborted) {
          // Held like a wake turn: it ends when omp settles, when the user acts, or after `wakeSettleMs` of silence.
          prompt.heldStop = 'end_turn'
          prompt.lastActivityAt = Date.now()
          this.armHoldTimer(prompt, this.wakeSettleMs)
          return
        }
        // Only a launch without the overlay (`createOverlay`) makes "waits for your next message" the answer: with it, a goal that
        // stays put is omp's own decision (plan mode, nothing actionable left). A run that already happened (it settled while
        // this was asked) is an answer too.
        if (!continues && !prompt.aborted && !prompt.agentRan && !this.overlayApplied) this.say(GOAL_WAITS)
      }
      await this.finishPrompt(prompt, { stopReason: prompt.aborted ? 'cancelled' : 'end_turn' })
    } catch (error: unknown) {
      if (this.activePrompt !== prompt) return
      if (error instanceof NativeTransportError && error.code === 'request-failed') {
        // omp's own refusal ("Goal mode is disabled (goal.enabled).", "A goal is already active. …"): an answer for the user.
        if (!prompt.aborted) this.say(goalFailure(error.detail ?? error.message))
        await this.finishPrompt(prompt, { stopReason: prompt.aborted ? 'cancelled' : 'end_turn' })
      } else {
        this.failPrompt(prompt, error instanceof Error ? error : new Error(String(error)))
      }
    }
  }

  /** Runs the goal command; `working` says that it left an active goal, which omp may go on with by itself. */
  private async goalOutcome(request: GoalRequest): Promise<{ readonly text: string; readonly working: boolean }> {
    this.goalCommandOpen = true
    try {
      switch (request.action) {
        case 'usage':
          return { text: `${request.problem}\n\n${GOAL_USAGE}`, working: false }
        case 'show': {
          const goal = await this.goalRpc('get')
          return { text: goal === undefined ? `There is no goal in this session. ${GOAL_USAGE}` : formatGoal(goal), working: false }
        }
        case 'clear': {
          const goal = await this.goalRpc('get')
          if (goal === undefined) return { text: 'There is no goal to clear.', working: false }
          await this.goalRpc('drop')
          return { text: formatGoal({ ...goal, status: 'dropped' }), working: false }
        }
        case 'pause': {
          const goal = await this.goalRpc('pause')
          return { text: goal === undefined ? 'There is no goal to pause.' : formatGoal(goal), working: false }
        }
        case 'resume': {
          const goal = await this.goalRpc('resume')
          return goal === undefined
            ? { text: 'Oh My Pi did not report the goal it resumed.', working: false }
            : { text: formatGoal(goal), working: goal.status === 'active' }
        }
        case 'set': {
          const goal = await this.goalRpc('create', request.objective)
          return goal === undefined
            ? { text: 'Oh My Pi did not report the goal it created.', working: false }
            : { text: formatGoal(goal, 'Goal set'), working: goal.status === 'active' }
        }
      }
    } finally {
      this.goalCommandOpen = false
    }
  }

  /** rpc `goal`: the goal after the operation (`undefined` when there is none). */
  private async goalRpc(op: 'get' | 'create' | 'resume' | 'pause' | 'drop', objective?: string): Promise<OmpGoal | undefined> {
    const data = asObject(
      await this.request({ type: 'goal', op, ...(objective === undefined ? {} : { objective }) }, SESSION_COMMAND_TIMEOUT_MS).response,
    )
    this.goal = parseOmpGoal(data?.goal)
    return this.goal
  }

  /**
   * Whether omp goes on with the goal by itself: it reports the session not settled once the command is answered (a continuation is
   * scheduled or running). A `session_settled` seen while this is asked means it already stopped. A failed read holds nothing.
   */
  private async goalContinues(): Promise<boolean> {
    const settledBefore = this.settledFrames
    try {
      const state = asObject(await this.request({ type: 'get_state' }, this.requestTimeoutMs).response)
      return readBoolean(state?.isSettled) === false && this.settledFrames === settledBefore
    } catch (error) {
      if (this.exitError !== undefined) throw this.exitError
      this.log(`OMP get_state after a goal command failed: ${errorText(error)}`)
      return false
    }
  }

  private async finishPrompt(prompt: ActivePromptState, result: NativePromptResult): Promise<void> {
    if (this.activePrompt !== prompt) return
    this.activePrompt = undefined
    clearPromptTimers(prompt)
    prompt.removeAbortListener?.()
    prompt.removeAbortListener = undefined
    // The turn's usage includes everything accounted until now, even after a cancel.
    const usage = result.usage ?? prompt.usage.snapshot()
    await this.refreshContextAfterTurn()
    prompt.deferred.resolve({ stopReason: result.stopReason, ...(usage === undefined ? {} : { usage }) })
    // A slash command may have changed what omp reports as controls (`/fast`, `/slow`, `/effort`): read it back.
    if (prompt.slash && this.started && !this.closed && this.selfChange === 0) this.scheduleModelRefresh()
  }

  /** Read the window occupancy once a turn ended; a failed read only costs freshness. */
  private async refreshContextAfterTurn(): Promise<void> {
    try {
      await this.refreshContextUsage(TURN_END_CONTEXT_TIMEOUT_MS)
    } catch (error) {
      this.log(`OMP context usage refresh after turn failed: ${errorText(error)}`)
    }
  }

  private failPrompt(prompt: ActivePromptState, error: Error): void {
    if (this.activePrompt !== prompt) return
    this.activePrompt = undefined
    clearPromptTimers(prompt)
    prompt.removeAbortListener?.()
    prompt.removeAbortListener = undefined
    prompt.deferred.reject(error)
  }

  private async interrupt(): Promise<void> {
    if (this.closing || this.exitError !== undefined) return
    try {
      await this.request({ type: 'abort' }, this.requestTimeoutMs).response
    } catch (error) {
      // Stopping work an already-dead process is no longer running is not a failure.
      if (this.exitError === undefined) this.log(`OMP abort failed: ${errorText(error)}`)
    }
  }

  // ---------------------------------------------------------------------------
  // Steering
  // ---------------------------------------------------------------------------

  steer(content: readonly NativeContentBlock[], signal?: AbortSignal): Promise<'injected' | 'promptRequired'> {
    const run = this.steerTail.then(() => this.steerOnce(content, signal))
    this.steerTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async steerOnce(
    content: readonly NativeContentBlock[],
    signal?: AbortSignal,
  ): Promise<'injected' | 'promptRequired'> {
    if (this.closing) throw new NativeTransportError('OMP transport is closed', 'closed')
    if (this.exitError !== undefined) throw this.exitError
    if (signal?.aborted === true) throw abortReason(signal)
    const { message, images } = splitContent(content)
    // On a native runtime `promptRequired` makes the host interrupt the running vendor turn and prompt the line again.
    // The early answers below are therefore given only where no model turn can take the text, never because of what
    // the text says: slash lines and `!cmd` are injected like any other steering text (a line the host claims as a
    // command never reaches this method).
    // Nothing to inject (whitespace only); `NativeSessionRuntime.steer` answers the same for content without blocks.
    if (message.length === 0 && images.length === 0) return 'promptRequired'
    // Safe: with no model turn in flight there is nothing to interrupt. An idle or just finished session needs a
    // prompt (a steer never starts a turn, like ACP's `_session/steering`), an aborting turn is already being stopped
    // by the host, and a user shell run (`!cmd`) cannot take text: the user's send-now then ends the command
    // (`abort_bash`) and runs the line, as for any input the vendor cannot take mid-turn.
    const prompt = this.activePrompt
    if (prompt === undefined || prompt.aborted) return 'promptRequired'
    if (prompt.heldStop !== undefined && this.agentRuns === 0) {
      // Safe: the agent already yielded its answer and only background work is pending, so no answer is in flight. The
      // finished turn has dropped its abort listener, so the host's interrupt sends no `abort` and the background
      // jobs keep running. An rpc `steer` would only park the text for a wake run that may never come, and the
      // host would wait out the steer proof for it.
      void this.finishPrompt(prompt, { stopReason: prompt.heldStop })
      return 'promptRequired'
    }

    const confirmation = Promise.withResolvers<'injected' | 'promptRequired'>()
    const steer: ActiveSteerState = {
      text: message,
      admitted: false,
      consumed: false,
      injected: false,
      deferred: confirmation,
    }
    this.activeSteer = steer
    const request = this.request(
      {
        type: 'steer',
        message,
        ...(images.length > 0 ? { images } : {}),
      },
      this.requestTimeoutMs,
    )
    try {
      await request.response
    } catch (error) {
      this.clearSteer(steer)
      if (this.exitError !== undefined) throw this.exitError
      // A definitive rejection means nothing was queued; a timeout might have been queued.
      const timedOut = error instanceof NativeTransportError && error.code === 'request-timeout'
      if (timedOut && (await this.rollbackSteer(steer.text))) return 'promptRequired'
      this.log(`OMP steer was not accepted: ${errorText(error)}`)
      if (timedOut) {
        throw new NativeTransportError(
          'OMP steering outcome could not be confirmed',
          'steer-unconfirmed',
          errorText(error),
        )
      }
      return 'promptRequired'
    }

    try {
      return await withTimeout(confirmation.promise, this.steerTimeoutMs, 'OMP steer confirmation')
    } catch (error) {
      // Timed out waiting for the transcript proof: withdraw the queued message when possible, so the
      // caller can fall back to a prompt without duplicating the user's text.
      const removed = await this.rollbackSteer(steer.text)
      const injected = steer.injected
      this.clearSteer(steer)
      // Injection may land while the rollback request is in flight.
      if (injected) return 'injected'
      if (removed) return 'promptRequired'
      if (this.exitError !== undefined) throw this.exitError
      throw new NativeTransportError(
        'OMP steering outcome could not be confirmed',
        'steer-unconfirmed',
        errorText(error),
      )
    }
  }

  private settleSteer(steer: ActiveSteerState, result: 'injected' | 'promptRequired'): void {
    if (this.activeSteer !== steer) return
    this.activeSteer = undefined
    steer.deferred.resolve(result)
  }

  private failSteer(steer: ActiveSteerState, error: Error): void {
    if (this.activeSteer !== steer) return
    this.activeSteer = undefined
    steer.deferred.reject(error)
  }

  private clearSteer(steer: ActiveSteerState): void {
    if (this.activeSteer === steer) this.activeSteer = undefined
  }

  /** Withdraw a still-queued steering message; `true` means nothing can be injected any more. */
  private async rollbackSteer(text: string): Promise<boolean> {
    if (this.closing || this.exitError !== undefined) return false
    try {
      const data = asObject(
        await this.request({ type: 'remove_queued_message', message: text, queue: 'steering' }, 5_000).response,
      )
      return data !== undefined && readBoolean(data.removed) === true
    } catch (error) {
      this.log(`OMP steering rollback failed: ${errorText(error)}`)
      return false
    }
  }

  // ---------------------------------------------------------------------------
  // Side questions, immediate commands and the user shell
  // ---------------------------------------------------------------------------

  /**
   * `/btw`: a separate model call beside the main agent (rpc `btw`). The running record precedes the response and
   * the deltas follow it, none of them responses, so the waiter exists before the command is written. omp runs one
   * side question at a time and cancels it itself on a session change.
   */
  async sideQuestion(question: string, signal: AbortSignal): Promise<NativeCommandResult> {
    this.assertUsable()
    const text = question.trim()
    if (text.length === 0) return { kind: 'error', text: 'Usage: /btw <question>' }
    if (signal.aborted) return { kind: 'error', text: 'The side question was cancelled before it started.' }
    if (this.activeBtw !== undefined) {
      return { kind: 'error', text: 'A side question is still running; wait for it to finish or cancel it first.' }
    }
    const btw: ActiveBtwState = {
      question: text,
      recordId: undefined,
      streamed: '',
      answer: '',
      stop: undefined,
      cancelRequested: false,
      cancelTargeted: false,
      deferred: Promise.withResolvers<NativeCommandResult>(),
      watchdog: undefined,
      graceTimer: undefined,
      removeAbortListener: undefined,
    }
    this.activeBtw = btw
    btw.watchdog = setTimeout(() => {
      btw.watchdog = undefined
      btw.stop ??= 'timeout'
      this.cancelBtw(btw)
    }, this.btwTimeoutMs)
    const onAbort = (): void => {
      btw.stop ??= 'aborted'
      this.cancelBtw(btw)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    btw.removeAbortListener = () => {
      signal.removeEventListener('abort', onAbort)
    }
    // No request timer: the command waits behind the serial queue, and the watchdog bounds the whole question.
    this.request({ type: 'btw', question: text }, 0).response.then(
      (data) => {
        if (this.activeBtw !== btw) return
        const record = asObject(asObject(data)?.record)
        if (record === undefined) return
        btw.recordId ??= readString(record.id)
        this.noteBtwRecord(btw, record)
        // A cancel sent before the topic id was known can have missed a question that was still queued.
        if (this.activeBtw === btw && btw.cancelRequested && !btw.cancelTargeted) this.sendBtwCancel(btw)
      },
      (error: unknown) => {
        if (this.activeBtw !== btw) return
        if (error instanceof NativeTransportError && error.code === 'request-failed') {
          // The vendor's own refusal ("A /btw question is still running", "No active model available for /btw.").
          this.endBtw(btw, { kind: 'error', text: error.detail ?? error.message })
        } else {
          // The process is gone or closing: nothing can answer any more.
          this.endBtw(btw, error instanceof Error ? error : new Error(String(error)))
        }
      },
    )
    return await btw.deferred.promise
  }

  /**
   * Apply one record of the question in flight: a `btw_record` frame or the record of the `btw` response. The
   * top-level fields of a topic describe its first turn; the turn that decides whether the question ended is the last
   * of `followUps` (after a follow-up the top-level status stays `complete` while the follow-up still runs).
   */
  private noteBtwRecord(btw: ActiveBtwState, record: JsonObject): void {
    const latest = asObject(readArray(record.followUps)?.at(-1)) ?? record
    const status = readString(latest.status)
    const id = readString(record.id)
    if (btw.recordId === undefined) {
      // omp announces the question as `running` before it answers the command.
      if (id === undefined || status !== 'running' || readString(latest.question)?.trim() !== btw.question) return
      btw.recordId = id
    } else if (id !== btw.recordId) {
      return
    }
    const answer = readString(latest.answer) ?? ''
    if (answer.length > btw.answer.length) btw.answer = answer
    switch (status) {
      case 'complete': {
        const text = answer.trim().length > 0 ? answer : btw.answer
        this.endBtw(
          btw,
          text.trim().length > 0
            ? { kind: 'success', text }
            : { kind: 'error', text: 'Oh My Pi returned an empty answer.' },
        )
        return
      }
      case 'cancelled':
        this.endBtw(btw, this.btwCancelled(btw))
        return
      case 'error':
        this.endBtw(btw, this.btwFailure(btw, readString(latest.error) ?? 'The side question failed.'))
        return
      case 'interrupted':
        this.endBtw(btw, this.btwFailure(btw, 'The side question was interrupted.'))
        return
      default:
        // `running`: the deltas keep coming.
        return
    }
  }

  /** An error result that keeps whatever was streamed before the question ended. */
  private btwFailure(btw: ActiveBtwState, headline: string): NativeCommandResult {
    const partial = btw.answer.trim()
    return { kind: 'error', text: partial.length > 0 ? `${headline}\n\nPartial answer:\n\n${partial}` : headline }
  }

  /** The result of a cancelled question, worded after who cancelled it. */
  private btwCancelled(btw: ActiveBtwState): NativeCommandResult {
    const headline =
      btw.stop === 'timeout'
        ? 'The side question ran too long and was cancelled.'
        : btw.stop === 'aborted'
          ? 'The side question was cancelled.'
          : 'Oh My Pi cancelled the side question.'
    return this.btwFailure(btw, headline)
  }

  /** Cancel the question in flight (abort signal, watchdog); it ends even when omp never confirms. */
  private cancelBtw(btw: ActiveBtwState): void {
    if (this.activeBtw !== btw) return
    btw.cancelRequested = true
    this.sendBtwCancel(btw)
    btw.graceTimer ??= setTimeout(() => {
      btw.graceTimer = undefined
      this.endBtw(btw, this.btwCancelled(btw))
    }, this.abortGraceMs)
  }

  /** `btw_cancel` bypasses the command queue; the cancelled record arrives before its response. */
  private sendBtwCancel(btw: ActiveBtwState): void {
    btw.cancelTargeted = btw.recordId !== undefined
    const command = { type: 'btw_cancel', ...(btw.recordId === undefined ? {} : { recordId: btw.recordId }) }
    this.request(command, 5_000).response.catch((error: unknown) => {
      if (this.exitError === undefined) this.log(`OMP btw_cancel failed: ${errorText(error)}`)
    })
  }

  /** End the question in flight: drop its timers and listener, then answer or fail its waiter. */
  private endBtw(btw: ActiveBtwState, outcome: NativeCommandResult | Error): void {
    if (this.activeBtw !== btw) return
    this.activeBtw = undefined
    clearTimeout(btw.watchdog)
    clearTimeout(btw.graceTimer)
    btw.removeAbortListener?.()
    if (outcome instanceof Error) btw.deferred.reject(outcome)
    else btw.deferred.resolve(outcome)
  }

  /**
   * The immediate commands. `new` and `clear` both start a fresh omp session: rpc has no in-place clear, and the
   * session id changes either way, which the host learns from `session_changed`. `rewind` goes back to an earlier message.
   */
  async runCommand(name: string, args: string, signal: AbortSignal): Promise<NativeCommandResult> {
    this.assertUsable()
    if (name !== 'new' && name !== 'clear' && name !== 'rewind') {
      return { kind: 'error', text: `/${name} is not a command Oh My Pi runs without a turn.` }
    }
    if (signal.aborted) return { kind: 'error', text: `/${name} was cancelled before it started.` }
    if (name === 'rewind') return await this.rewindCommand(args, signal)
    // Serialized with the control writes: both change the session the controls describe.
    const run = this.configTail.then(() => this.startNewSession(name))
    this.configTail = run.then(
      () => undefined,
      () => undefined,
    )
    return await run
  }

  private async startNewSession(command: 'new' | 'clear'): Promise<NativeCommandResult> {
    // The new session detaches whatever run is live and would orphan a turn of ours: idle only.
    if (this.activePrompt !== undefined || this.activeShell !== undefined || this.agentRuns > 0) {
      return { kind: 'error', text: `/${command} needs an idle session; stop the running turn first.` }
    }
    let data: JsonObject | undefined
    try {
      data = asObject(await this.request({ type: 'new_session' }, SESSION_COMMAND_TIMEOUT_MS).response)
    } catch (error) {
      if (error instanceof NativeTransportError && error.code === 'request-failed') {
        return { kind: 'error', text: error.detail ?? error.message }
      }
      throw error
    }
    if (readBoolean(data?.cancelled) === true) {
      return { kind: 'error', text: `An extension vetoed /${command}; the conversation is unchanged.` }
    }
    const stats = await this.statsRequest(this.requestTimeoutMs)
    this.sessionIdValue = stats.sessionId
    this.sessionFile = stats.sessionFile
    this.projector?.reset()
    this.applyStats(stats.data)
    // A new session starts from omp's defaults, not from what the previous one had selected.
    await this.refreshState()
    await this.loadThinkingLevels()
    this.thinkingAuto = false
    await this.refreshThinkingSelector()
    this.onControlInputsChanged()
    this.emit({ kind: 'session_changed', sessionId: stats.sessionId, reason: command })
    return {
      kind: 'success',
      text:
        command === 'new'
          ? `Started a new Oh My Pi session (\`${stats.sessionId}\`).`
          : `Cleared the conversation. Oh My Pi continues in a new session (\`${stats.sessionId}\`); the previous one is no longer in context.`,
    }
  }

  // ---------------------------------------------------------------------------
  // Rewind
  // ---------------------------------------------------------------------------

  /** Whether omp is working, a turn of ours is open, or the conversation is being changed: a branch would cut the work off. */
  private conversationBusy(): boolean {
    return this.activePrompt !== undefined || this.activeShell !== undefined || this.agentRuns > 0 || this.busy || this.rewinding
  }

  /** `get_entries`: the session as omp recorded it. Nothing is cached, so the list is the same after a restart. */
  private async sessionModel(cwd: string): Promise<OmpRewindModel> {
    const data = asObject(await this.request({ type: 'get_entries' }, SESSION_COMMAND_TIMEOUT_MS).response)
    const leaf = data?.leafId
    return readRewindModel({
      entries: readArray(data?.entries) ?? [],
      leafId: typeof leaf === 'string' || leaf === null ? leaf : undefined,
      cwd,
    })
  }

  /**
   * `/rewind`: list the user's messages, preview going back to just before one (the conversation omp would forget, the files that would
   * be restored and those that cannot be), or do it. Listing and previews may run at any time; changing anything needs an idle session.
   */
  private async rewindCommand(args: string, signal: AbortSignal): Promise<NativeCommandResult> {
    const request = parseRewindArgs(args)
    if (request.action === 'usage') return { kind: 'error', text: `${request.problem}\n\nUsage: /rewind [<n> [code|chat] [confirm]]` }
    const cwd = this.cwd
    if (cwd === undefined) throw new NativeTransportError('OMP transport is not started', 'not-started')
    try {
      const model = await this.sessionModel(cwd)
      if (request.action === 'list') return { kind: 'success', text: renderCheckpoints(model.checkpoints) }
      const found = findCheckpoint(model.checkpoints, request.reference)
      if ('error' in found) return { kind: 'error', text: found.error }
      const { checkpoint, position } = found
      const point: RewindPoint = {
        checkpoint,
        position,
        total: model.checkpoints.length,
        mode: request.mode,
        display: (path: string): string => shownPath(cwd, path),
        unrecorded: model.unrecorded.filter((call) => call.index > checkpoint.index).length,
      }
      const changes = model.changes.filter((change) => change.index > checkpoint.index)
      // Only the session's own directory is ever read or written, however a recorded path leads out of it.
      const io = nodeRestoreIo([cwd])
      if (request.action === 'preview') {
        const plan = request.mode === 'chat' ? undefined : await planRestore(changes, io)
        return { kind: 'success', text: renderRewindPreview({ ...point, plan }) }
      }
      // Serialized with the control writes and `new`/`clear`: all of them change the session the controls describe.
      const run = this.configTail.then(() => this.applyRewind(point, changes, io, signal))
      this.configTail = run.then(
        () => undefined,
        () => undefined,
      )
      return await run
    } catch (error: unknown) {
      // A lost process is the runtime's to handle; anything else is an answer for the user.
      if (this.closed) throw error
      if (signal.aborted) return { kind: 'error', text: 'The command was cancelled.' }
      return { kind: 'error', text: `\`/rewind\` failed: ${refusalText(error)}` }
    }
  }

  /** The files go back first (what the agent's file tools recorded), then the conversation moves to a branch that ends before the message. */
  private async applyRewind(
    point: RewindPoint,
    changes: readonly OmpFileChange[],
    io: RestoreIo,
    signal: AbortSignal,
  ): Promise<NativeCommandResult> {
    if (this.conversationBusy()) {
      return { kind: 'error', text: 'Wait for the current turn to finish before rewinding: Oh My Pi is working right now.' }
    }
    if (signal.aborted) return { kind: 'error', text: 'The command was cancelled.' }
    // No prompt may start while the files and the conversation are going back.
    this.rewinding = true
    try {
      const plan = point.mode === 'chat' ? undefined : await planRestore(changes, io)
      const restore = plan === undefined ? undefined : await applyRestore(plan, io)
      let rolledBack = false
      let rollbackError: string | undefined
      if (point.mode !== 'code') {
        try {
          await this.branchBefore(point.checkpoint.entryId)
          rolledBack = true
        } catch (error: unknown) {
          if (this.closed) throw error
          rollbackError = refusalText(error)
        }
        if (rolledBack) await this.adoptBranchedSession()
      }
      return {
        kind: rollbackError === undefined ? 'success' : 'error',
        text: renderRewindResult({ ...point, plan, restore, rolledBack, rollbackError }),
      }
    } finally {
      this.rewinding = false
    }
  }

  /** rpc `branch`: the conversation moves to a new session that holds everything before the message. */
  private async branchBefore(entryId: string): Promise<void> {
    const data = asObject(await this.request({ type: 'branch', entryId }, SESSION_COMMAND_TIMEOUT_MS).response)
    if (readBoolean(data?.cancelled) === true) throw new Error('an extension vetoed the branch; the conversation is unchanged')
  }

  /** The branch is a session with an id of its own; the host learns it from `session_changed`. */
  private async adoptBranchedSession(): Promise<void> {
    const stats = await this.statsRequest(this.requestTimeoutMs)
    this.sessionIdValue = stats.sessionId
    this.sessionFile = stats.sessionFile
    this.projector?.reset()
    this.applyStats(stats.data)
    // The goal of the branch is whatever the branch journaled; omp reattaches it before it answers.
    await this.refreshState()
    this.onControlInputsChanged()
    this.emit({ kind: 'session_changed', sessionId: stats.sessionId, reason: 'rewind' })
  }

  /** `!cmd`: omp's user shell (rpc `bash`) as one `execute` tool call, with no model call. */
  private async runUserShell(line: string, signal: AbortSignal): Promise<NativePromptResult> {
    if (line.startsWith('!!')) {
      return this.answerLocally(
        "`!!` runs a command without adding its output to the conversation, which Oh My Pi's rpc protocol cannot do. Use `!` to run it and keep the output in the conversation.",
      )
    }
    const command = line.slice(1).trim()
    if (command.length === 0) return this.answerLocally('Type a shell command after `!`.')
    const shell: ActiveShellState = { aborted: false }
    this.activeShell = shell
    const toolCallId = `omp-shell:${randomUUID()}`
    const rawInput = { command }
    const startContent = buildToolStartContent('bash', rawInput)
    this.emit({
      kind: 'update',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: buildOmpToolTitle('bash', rawInput),
        name: 'bash',
        kind: 'execute',
        status: 'in_progress',
        rawInput,
        ...(startContent.length > 0 ? { content: startContent } : {}),
      },
    })
    const finishCall = (ok: boolean, rawOutput: unknown, text: string): void => {
      const content = mergeToolUpdateContent(startContent, text.length > 0 ? [textToolContent(limitText(text))] : [])
      this.emit({
        kind: 'update',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          name: 'bash',
          status: ok ? 'completed' : 'failed',
          ...(rawOutput === undefined ? {} : { rawOutput }),
          ...(content.length > 0 ? { content } : {}),
        },
      })
    }
    // `bash` answers once, when the command is over; `abort_bash` is answered first, then `bash` reports the kill.
    const request = this.request({ type: 'bash', command }, 0)
    const unconfirmed = Promise.withResolvers<undefined>()
    let confirmationExpired = false
    let graceTimer: NodeJS.Timeout | undefined
    const onAbort = (): void => {
      shell.aborted = true
      this.request({ type: 'abort_bash' }, 5_000).response.catch((error: unknown) => {
        if (this.exitError === undefined) this.log(`OMP abort_bash failed: ${errorText(error)}`)
      })
      graceTimer = setTimeout(() => {
        confirmationExpired = true
        unconfirmed.resolve(undefined)
      }, this.abortGraceMs)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await Promise.race([request.response, unconfirmed.promise])
      if (confirmationExpired) {
        // omp never confirmed the kill: the turn ends anyway, and a late answer is only logged.
        this.pending.delete(request.id)
        finishCall(false, undefined, '[cancelled]')
        return { stopReason: 'cancelled' }
      }
      const result = asObject(response) ?? {}
      const succeeded =
        readBoolean(result.cancelled) !== true &&
        readBoolean(result.timedOut) !== true &&
        (readNumber(result.exitCode) ?? 0) === 0
      finishCall(succeeded, result, shellResultText(result))
      await this.refreshContextAfterTurn()
      return { stopReason: shell.aborted ? 'cancelled' : 'end_turn' }
    } catch (error) {
      if (error instanceof NativeTransportError && error.code === 'request-failed') {
        finishCall(false, undefined, error.detail ?? error.message)
        return { stopReason: shell.aborted ? 'cancelled' : 'end_turn' }
      }
      finishCall(false, undefined, errorText(error))
      throw error
    } finally {
      clearTimeout(graceTimer)
      signal.removeEventListener('abort', onAbort)
      this.activeShell = undefined
    }
  }

  // ---------------------------------------------------------------------------
  // Permission dialogs
  // ---------------------------------------------------------------------------

  private async handleExtensionUiRequest(frame: JsonObject): Promise<void> {
    const id = readString(frame.id)
    const method = readString(frame.method)
    if (id === undefined || method === undefined) return
    switch (method) {
      case 'select': {
        const title = readString(frame.title) ?? readString(frame.message) ?? ''
        if (OMP_APPROVAL_TITLE.test(title.split('\n')[0] ?? '')) {
          await this.answerSelectDialog(id, frame)
          return
        }
        await this.answerSelectQuestion(id, frame, title)
        return
      }
      case 'ask':
        await this.answerAskQuestion(id, frame)
        return
      case 'confirm': {
        const title = readString(frame.title) ?? ''
        const message = readString(frame.message) ?? ''
        await this.answerWithForm(
          id,
          { message: message.trim().length > 0 ? `${title}\n\n${message}` : title, requestedSchema: valueForm({ type: 'boolean' }) },
          (content) => ({ confirmed: typeof content.value === 'boolean' ? content.value : false }),
        )
        return
      }
      case 'input': {
        const placeholder = readString(frame.placeholder)
        await this.answerWithForm(
          id,
          {
            message: readString(frame.title) ?? '',
            requestedSchema: valueForm({
              type: 'string',
              ...(placeholder !== undefined && placeholder.trim().length > 0 ? { description: placeholder } : {}),
            }),
          },
          decodeStringValue,
        )
        return
      }
      case 'editor': {
        const prefill = readString(frame.prefill)
        await this.answerWithForm(
          id,
          {
            message: readString(frame.title) ?? '',
            requestedSchema: valueForm({
              type: 'string',
              ...(prefill !== undefined && prefill.length > 0 ? { default: prefill } : {}),
            }),
          },
          decodeStringValue,
        )
        return
      }
      case 'cancel': {
        // OMP settled the dialog itself (abort, timeout, supersede): withdraw the host prompt.
        const target = readString(frame.targetId)
        if (target !== undefined) this.dialogs.get(target)?.abort()
        return
      }
      case 'notify':
      case 'open_url':
        // Fire-and-forget extension output: a thought line while a turn is open.
        this.projectTurnFrame(frame)
        return
      default:
      // setStatus / setWidget / setTitle / set_editor_text need no reply and have no surface here.
    }
  }

  /**
   * A non-approval `select` is a question: the form omp acp's `select` sends (`value`, required, the labels as
   * `enum`), answered with the chosen label.
   */
  private async answerSelectQuestion(requestId: string, frame: JsonObject, title: string): Promise<void> {
    const labels = readStringArray(frame.options)
    if (labels.length === 0) {
      this.writeFrame({ type: 'extension_ui_response', id: requestId, cancelled: true })
      return
    }
    await this.answerWithForm(
      requestId,
      { message: title, requestedSchema: valueForm({ type: 'string', enum: labels }) },
      decodeStringValue,
    )
  }

  /** An `ask` dialog: the form omp acp's `askDialog` sends, decoded the way it decodes the answer. */
  private async answerAskQuestion(requestId: string, frame: JsonObject): Promise<void> {
    const questions = parseOmpAskQuestions(frame.questions)
    if (questions === undefined) {
      this.log('OMP ask dialog carried no usable questions; dismissing')
      this.writeFrame({ type: 'extension_ui_response', id: requestId, cancelled: true })
      return
    }
    const call = this.projector?.findOpenToolCall('ask')
    await this.answerWithForm(
      requestId,
      {
        ...buildOmpAskForm(questions),
        ...(call !== undefined && call.toolName === 'ask' ? { toolCallId: call.toolCallId } : {}),
      },
      (content) => ({ answers: decodeOmpAskAnswers(questions, content) }),
    )
  }

  /**
   * Put one form to the host and answer the OMP dialog from the response. `decode` turns the accepted form
   * content into the response fields; anything but an accepted form (decline, cancel, a throw, no surface)
   * answers `cancelled`. Nothing is written once OMP withdrew the dialog or the transport is closing.
   */
  private async answerWithForm(
    requestId: string,
    request: NativeElicitationRequest,
    decode: (content: JsonObject) => JsonObject | undefined,
  ): Promise<void> {
    const handler = this.elicitationHandler
    if (handler === undefined) {
      this.writeFrame({ type: 'extension_ui_response', id: requestId, cancelled: true })
      return
    }
    const controller = new AbortController()
    this.dialogs.set(requestId, controller)
    let answer: JsonObject | undefined
    try {
      const response: unknown = await handler(request, controller.signal)
      const accepted = asObject(response)
      const content = accepted?.action === 'accept' ? asObject(accepted.content) : undefined
      answer = content === undefined ? undefined : decode(content)
    } catch (error) {
      this.log(`OMP question handler failed: ${errorText(error)}`)
    }
    if (this.dialogs.get(requestId) === controller) this.dialogs.delete(requestId)
    // OMP withdrew the dialog (or the transport is going down): there is nothing left to answer.
    if (controller.signal.aborted || this.closing) return
    this.writeFrame({ type: 'extension_ui_response', id: requestId, ...(answer ?? { cancelled: true }) })
  }

  private async answerSelectDialog(requestId: string, frame: JsonObject): Promise<void> {
    const labels = readStringArray(frame.options)
    if (labels.length === 0) {
      this.writeFrame({ type: 'extension_ui_response', id: requestId, cancelled: true })
      return
    }
    const options = mapOmpPermissionOptions(labels)
    const rawTitle = readString(frame.title) ?? readString(frame.message) ?? 'OMP permission request'
    const request: NativePermissionRequest = { toolCall: this.permissionToolCall(requestId, rawTitle), options }
    const controller = new AbortController()
    this.dialogs.set(requestId, controller)
    let decision: NativePermissionDecision
    const handler = this.permissionHandler
    if (handler === undefined) {
      decision = { cancelled: true }
    } else {
      try {
        decision = await handler(request, controller.signal)
      } catch (error) {
        this.log(`OMP permission handler failed: ${errorText(error)}`)
        decision = { cancelled: true }
      }
    }
    this.dialogs.delete(requestId)
    // OMP withdrew the dialog (or the transport is going down): there is nothing left to answer.
    if (controller.signal.aborted || this.closing) return
    if ('cancelled' in decision) {
      this.writeFrame({ type: 'extension_ui_response', id: requestId, cancelled: true })
      return
    }
    const value = decision.optionId
    if (!options.some((option) => option.optionId === value)) {
      this.log(`OMP permission answer "${value}" is not one of the offered options; dismissing`)
      this.writeFrame({ type: 'extension_ui_response', id: requestId, cancelled: true })
      return
    }
    this.writeFrame({ type: 'extension_ui_response', id: requestId, value })
  }

  /**
   * The ACP `toolCall` of an approval dialog: the in-flight tool the dialog is about (`Allow tool: <name>`
   * names it), else a call synthesized from the dialog text.
   */
  private permissionToolCall(requestId: string, dialogTitle: string): acp.ToolCallUpdate {
    const toolName = /^Allow tool:\s*(\S+)/m.exec(dialogTitle)?.[1]
    const call = this.projector?.findOpenToolCall(toolName)
    if (call !== undefined) {
      return {
        toolCallId: call.toolCallId,
        title: call.title,
        name: call.toolName,
        kind: call.kind,
        status: 'pending',
        rawInput: call.rawInput,
        content: [...call.content, textToolContent(dialogTitle)],
        ...(call.locations.length > 0 ? { locations: [...call.locations] } : {}),
      }
    }
    const firstLine = dialogTitle.split('\n')[0]?.trim() ?? ''
    return {
      toolCallId: `omp-dialog:${requestId}`,
      title: firstLine.length === 0 ? 'OMP permission request' : firstLine,
      status: 'pending',
      content: [textToolContent(dialogTitle)],
    }
  }

  // ---------------------------------------------------------------------------
  // Diagnostics
  // ---------------------------------------------------------------------------

  private emit(event: NativeTransportEvent): void {
    const sink = this.eventSink
    if (sink === undefined) return
    try {
      sink(event)
    } catch (error) {
      this.log(`native event sink failed: ${errorText(error)}`)
    }
  }

  private emitNotice(text: string): void {
    this.emit({ kind: 'notice', text })
  }

  private emitNoticeFrame(frame: JsonObject): void {
    const message = readString(frame.message)
    if (message === undefined) return
    const level = readString(frame.level)
    this.emitNotice(level === 'warning' || level === 'error' ? `${level}: ${message}` : message)
  }

  private log(message: string): void {
    try {
      this.logSink?.(message)
    } catch {
      // A throwing diagnostic sink must never break frame handling.
    }
  }

  private stderrTail(): string {
    return this.stderrBuffer.trim()
  }
}

function clearPromptTimers(prompt: ActivePromptState): void {
  if (prompt.admissionTimer !== undefined) {
    clearTimeout(prompt.admissionTimer)
    prompt.admissionTimer = undefined
  }
  if (prompt.abortTimer !== undefined) {
    clearTimeout(prompt.abortTimer)
    prompt.abortTimer = undefined
  }
  if (prompt.fallbackTimer !== undefined) {
    clearTimeout(prompt.fallbackTimer)
    prompt.fallbackTimer = undefined
  }
  if (prompt.holdTimer !== undefined) {
    clearTimeout(prompt.holdTimer)
    prompt.holdTimer = undefined
  }
}

/** Create the OMP transport selected by the shared native-transport factory. */
export function createOmpTransport(options: OmpNativeTransportOptions = {}): NativeTransport {
  return new OmpNativeTransport(options)
}
