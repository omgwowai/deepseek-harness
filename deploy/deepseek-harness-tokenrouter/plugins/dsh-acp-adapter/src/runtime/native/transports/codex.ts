/// <reference types="node" />
/**
 * Codex native transport: `codex app-server` over newline-delimited JSON-RPC.
 *
 * Reports exactly what `@agentclientprotocol/codex-acp` reports for the same
 * Codex session, so everything DSH saved while the profile ran Codex over ACP
 * keeps working:
 *
 *   - the session id is the Codex thread id (a thread created by codex-acp
 *     resumes here and vice versa);
 *   - `controls()` is codex-acp's `session/new` result (mode, collaboration
 *     mode, model, reasoning effort, fast mode; see `codex-controls.ts`) and the
 *     chosen values are applied through the same `turn/start` overrides and
 *     `thread/settings/update` calls;
 *   - tool calls, plans, reasoning and messages are projected with codex-acp's
 *     renderers (see `codex-projection.ts`);
 *   - approvals reach the host as ACP permission requests with codex-acp's
 *     options and are answered with its decision table (`codex-approvals.ts`);
 *     questions (`item/tool/requestUserInput`, MCP forms) reach it as the form
 *     elicitation codex-acp sends, through `onElicitation`;
 *   - the app-server has no slash-command layer, so the commands of the Codex
 *     TUI that DSH carries are implemented here (`codex-commands.ts` lists them):
 *     prompt commands run as turns, immediate ones (`runCommand`, `/status`,
 *     `/mcp`, `/diff`, `/new`, …) answer without one, and `/side` = `/btw`
 *     (`sideQuestion`) asks an ephemeral fork of the thread while the main turn
 *     keeps running. Notifications and requests are routed by `threadId`: the
 *     main thread projects, a side fork is collected, anything else is declined.
 *
 * Launch: `start()` receives the launcher argv (`CODEX_PATH`: the profile's
 * `codex-launch.mjs`, which adds the TokenRouter provider and the plan tool, or
 * a codex binary); `app-server` is appended and the process is spawned through
 * the host's subprocess seam only, so the profile environment (PATH for the
 * launcher's `env node` shebang, the API key, `MODEL_PROVIDER`) is merged by the
 * host and teardown stays host-owned.
 *
 * Wire protocol: verified against codex-cli 0.162.1 (schema probe bundle in
 * `.scratch/dsh-native-agents-20261026/codex-claude-protocol/probe`).
 */
import { randomUUID } from 'node:crypto'
import { isAbsolute, relative } from 'node:path'
import { createInterface, type Interface } from 'node:readline'
import type * as acp from '@agentclientprotocol/sdk'

import {
  answerCodexServerRequest,
  declinedCodexServerAnswer,
  describeCodexServerRequest,
  fallbackCodexServerAnswer,
  type CodexApprovalHost,
  type CodexServerRequestAnswer,
} from './codex-approvals.ts'
import {
  CODEX_NATIVE_COMMANDS,
  canonicalCodexCommand,
  isUnsupportedCodexCommand,
  unsupportedCodexCommandMessage,
} from './codex-commands.ts'
import {
  CODEX_COLLABORATION_CONFIG_ID,
  CODEX_EFFORT_CONFIG_ID,
  CODEX_FAST_MODE_CONFIG_ID,
  CODEX_MODEL_CONFIG_ID,
  CODEX_MODE_CONFIG_ID,
  CodexControlsState,
  initialCodexMode,
  parseCodexCollaborationMode,
  parseCodexModelPage,
  resolveCodexModelSelection,
  type CodexCollaborationMode,
  type CodexModelInfo,
} from './codex-controls.ts'
import {
  GOAL_USAGE,
  formatGoal,
  formatGoalChange,
  goalFailure,
  goalLineArgs,
  goalNote,
  goalStatusLabel,
  parseGoal,
  parseGoalArgs,
  type CodexGoal,
  type GoalRequest,
} from './codex-goal.ts'
import {
  diffCommand,
  fetchSkills,
  hooksCommand,
  mcpCommand,
  psCommand,
  stopCommand,
  type CodexRequest,
} from './codex-immediate.ts'
import { asRecord, messageOf, readNumber, readString, readStringArray, truncate, type JsonRecord } from './codex-json.ts'
import {
  CodexProjection,
  CodexTokenAccounting,
  codexNoticeText,
  planReviewToolCall,
  readableServiceErrorMessage,
  renderToolCall,
  thoughtNote,
  type CodexProjectionSink,
} from './codex-projection.ts'
import { INIT_PROMPT, SIDE_BOUNDARY_PROMPT, SIDE_DEVELOPER_INSTRUCTIONS } from './codex-prompts.ts'
import { formatRateLimits, formatSkills, formatThreadUsage, type CodexSkill } from './codex-reports.ts'
import {
  applyRestore,
  checkpointsOf,
  fileChangesOf,
  findCheckpoint,
  nodeRestoreIo,
  parseRewindArgs,
  parseTurnPage,
  planRestore,
  renderCheckpoints,
  renderRewindPreview,
  renderRewindResult,
  type CodexCheckpoint,
  type CodexTurn,
  type RestorePlan,
} from './codex-rewind.ts'
import {
  CodexSideRun,
  SIDE_ALREADY_RUNNING_MESSAGE,
  SIDE_REVIEW_RUNNING_MESSAGE,
  SIDE_USAGE_MESSAGE,
  sideCommandResult,
  sideStartFailure,
} from './codex-side.ts'
import {
  NativeTransportError,
  type NativeCommand,
  type NativeCommandResult,
  type NativeContentBlock,
  type NativeContextUsage,
  type NativeControls,
  type NativeProcess,
  type NativePromptResult,
  type NativeTransport,
  type NativeTransportEvent,
  type NativeTransportKind,
  type NativeTransportStartOptions,
} from './contract.ts'

/** The identity the ACP route presented to Codex; kept so gateway-side attribution does not change. */
const CLIENT_INFO = { name: '@local/dsh-acp-adapter', title: 'Codex ACP', version: '0.0.0' } as const

const HANDSHAKE_TIMEOUT_MS = 30_000
/** Thread/turn requests answer immediately; the long wait is the turn itself. */
const REQUEST_TIMEOUT_MS = 60_000
const SESSION_REQUEST_TIMEOUT_MS = 120_000
const INTERRUPT_TIMEOUT_MS = 15_000
/** How long `steer()` waits for the turn id of a turn that is still being started. */
const TURN_ID_WAIT_MS = 2_000
/** Fallback if a turn never settles after an interrupt; keeps the host from hanging. */
const ABORT_SETTLE_FALLBACK_MS = 30_000
/** A compaction that starts no turn is over after this long. */
const COMPACTION_START_GRACE_MS = 5_000
/** `account/rateLimits/read` and the other optional lookups of `/status` never hold the card up for long. */
const STATUS_LOOKUP_TIMEOUT_MS = 10_000
const SKILLS_WRITE_TIMEOUT_MS = 10_000
/** A side question that has not been answered by now is abandoned. */
const SIDE_RUN_TIMEOUT_MS = 10 * 60_000
/** Interrupting and closing a side thread are courtesies to the server; they never hold the answer up for long. */
const SIDE_CLEANUP_TIMEOUT_MS = 5_000
const CLOSE_GRACE_MS = 2_000
const CLOSE_TERMINATE_MS = 1_000
const STDERR_LIMIT = 8_192
/** How long a process exit waits for the last stderr bytes before it is reported. */
const STDERR_SETTLE_MS = 250
const DETAIL_LIMIT = 2_000
/** codex-acp retries a cancel that raced the turn becoming interruptible. */
const NO_ACTIVE_TURN_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const
/**
 * An active goal makes the app-server start the next turn by itself, within milliseconds of the end of the last one. A prompt that waits for
 * it gives up after this long.
 */
const GOAL_CONTINUATION_GRACE_MS = 3_000
/** A turn the app-server started for a goal while no prompt is open to show it is stopped (and the goal paused) after this long. */
const UNATTENDED_TURN_GRACE_MS = 1_500
/** A prompt follows a goal for this long at most; then the goal is paused. */
const GOAL_HOLD_CAP_MS = 12 * 60 * 60_000
/** Ends of turns nobody followed yet that are remembered for a prompt to pick up. */
const ORPHAN_COMPLETIONS_KEPT = 16
/** `thread/turns/list` page sizes: the cheap summary view, and the full view whose pages carry every tool output. */
const TURN_PAGE_LIMIT = 100
const FULL_TURN_PAGE_LIMIT = 20
const MAX_TURN_PAGES = 200

// ---------------------------------------------------------------------------
// JSON-RPC errors and their classification
// ---------------------------------------------------------------------------

/** A JSON-RPC error object returned by the app-server (as opposed to a transport failure). */
export class CodexRpcError extends Error {
  constructor(
    message: string,
    readonly code: number | string | undefined,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = 'CodexRpcError'
  }
}

/**
 * `true` only for errors that definitively mean the input was not accepted: the
 * method does not exist (-32601) or the invalid-request message is one of the
 * known steer preconditions. Timeouts, disconnects and unknown -32600 errors are
 * ambiguous and must be rethrown: treating them as "steer refused" would send
 * the user's input twice.
 */
export function isDefinitiveSteerRejection(error: unknown): boolean {
  if (!(error instanceof CodexRpcError)) return false
  if (error.code === -32601) return true
  if (error.code !== -32600) return false
  const info = asRecord(asRecord(error.data)?.['codexErrorInfo'])
  if (info !== undefined && asRecord(info['activeTurnNotSteerable']) !== undefined) return true
  return (
    error.message === 'no active turn to steer' ||
    /^expected active turn id .+ but found .+$/.test(error.message) ||
    error.message === 'active turn uses a different output schema'
  )
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : '')
const isMissingRolloutError = (error: unknown): boolean => errorText(error).includes('no rollout found for thread id')
const isMissingArchivedRolloutError = (error: unknown): boolean =>
  errorText(error).includes('no archived rollout found for thread id')
const isThreadActiveWriterError = (error: unknown): boolean =>
  /\bthread \S+ already has an active writer\b/.test(errorText(error))
const isNoActiveTurnError = (error: unknown): boolean => errorText(error).includes('no active turn to interrupt')

function isUnknownThreadError(error: unknown): boolean {
  const text = errorText(error)
  return (
    isMissingRolloutError(error) ||
    text.includes('thread not loaded:') ||
    text.includes('thread not found:') ||
    text.includes('invalid thread id:') ||
    text.includes('invalid session id:')
  )
}

function isArchivedThreadError(error: unknown): boolean {
  return error instanceof CodexRpcError && error.code === -32600 && /archived/i.test(error.message)
}

function sessionNotFound(sessionId: string, cause: unknown): NativeTransportError {
  return new NativeTransportError(`Codex session not found: ${sessionId}`, 'session-not-found', messageOf(cause))
}

// ---------------------------------------------------------------------------
// Launch configuration (codex-acp `CODEX_CONFIG`, `MODEL_PROVIDER`)
// ---------------------------------------------------------------------------

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value
}

function toToml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toToml).join(', ')}]`
  const record = asRecord(value)
  if (record !== undefined) {
    return `{ ${Object.entries(record)
      .map(([key, item]) => `${JSON.stringify(key)} = ${toToml(item)}`)
      .join(', ')} }`
  }
  return JSON.stringify(value)
}

interface CodexLaunch {
  readonly argv: string[]
  /** `CODEX_CONFIG` without the hooks, which travel as a startup flag. */
  readonly baseConfig: JsonRecord
  readonly modelProvider: string | undefined
}

/** codex-acp `startAcpServer` + `prepareCodexHookConfig`, driven by the explicit agent environment. */
function codexLaunch(options: NativeTransportStartOptions): CodexLaunch {
  const argv = [...options.argv]
  if (argv.length === 0) throw new NativeTransportError('the Codex launcher argv is empty', 'spawn-failed')
  if (!argv.includes('app-server')) argv.push('app-server')
  let baseConfig: JsonRecord = {}
  const configText = nonEmpty(options.env['CODEX_CONFIG'])
  if (configText !== undefined) {
    let parsed: unknown
    try {
      parsed = JSON.parse(configText)
    } catch (error: unknown) {
      throw new NativeTransportError(`CODEX_CONFIG is not valid JSON: ${messageOf(error)}`, 'invalid-config')
    }
    const record = asRecord(parsed)
    if (record === undefined) throw new NativeTransportError('CODEX_CONFIG must be a JSON object', 'invalid-config')
    const { hooks, ...rest } = record
    baseConfig = rest
    if (hooks !== undefined) argv.push('-c', `hooks=${toToml(hooks)}`)
  }
  return { argv, baseConfig, modelProvider: nonEmpty(options.env['MODEL_PROVIDER']) }
}

/** codex-acp `createSessionConfig` without MCP servers: trusted project, git-root turn diffs. */
function threadSessionConfig(base: JsonRecord, cwd: string): JsonRecord {
  const features = asRecord(base['features']) ?? {}
  return {
    ...base,
    features: { ...features, cwd_relative_turn_diffs: false },
    projects: { [cwd]: { trust_level: 'trusted' } },
  }
}

// ---------------------------------------------------------------------------
// Small async helpers
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  const { promise: result, resolve } = Promise.withResolvers<T>()
  const timer = setTimeout(() => {
    resolve(fallback)
  }, timeoutMs)
  timer.unref()
  promise.then(
    (value) => {
      clearTimeout(timer)
      resolve(value)
    },
    () => {
      clearTimeout(timer)
      resolve(fallback)
    },
  )
  return result
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms).unref()
  return promise
}

// ---------------------------------------------------------------------------
// Thread attachment
// ---------------------------------------------------------------------------

interface ThreadAttachment {
  readonly threadId: string
  readonly model: string | undefined
  readonly reasoningEffort: string | undefined
  readonly serviceTier: string | undefined
  readonly modelProvider: string | undefined
  readonly collaborationMode: CodexCollaborationMode | undefined
  /** What `/status` shows about the thread. */
  readonly threadName: string | undefined
  readonly forkedFromId: string | undefined
  /** The instruction files (AGENTS.md, …) the thread loaded. */
  readonly instructionSources: readonly string[]
  /** The directories the thread works in besides its own: the places `/rewind` may restore files in. */
  readonly runtimeWorkspaceRoots: readonly string[]
}

function parseThreadAttachment(response: unknown, expectedId?: string): ThreadAttachment {
  const record = asRecord(response)
  const thread = asRecord(record?.['thread'])
  const threadId = readString(thread, 'id') ?? expectedId
  if (threadId === undefined) {
    throw new NativeTransportError(
      'codex app-server did not return a thread id',
      'protocol-error',
      truncate(JSON.stringify(response) ?? '', DETAIL_LIMIT),
    )
  }
  return {
    threadId,
    model: readString(record, 'model') ?? readString(thread, 'model'),
    reasoningEffort: readString(record, 'reasoningEffort') ?? readString(thread, 'reasoningEffort'),
    serviceTier: readString(record, 'serviceTier'),
    modelProvider: readString(record, 'modelProvider') ?? readString(thread, 'modelProvider'),
    collaborationMode: parseCodexCollaborationMode(asRecord(record?.['collaborationMode'])?.['mode']),
    threadName: readString(thread, 'name'),
    forkedFromId: readString(thread, 'forkedFromId'),
    instructionSources: readStringArray(record, 'instructionSources'),
    runtimeWorkspaceRoots: readStringArray(record, 'runtimeWorkspaceRoots'),
  }
}

// ---------------------------------------------------------------------------
// Turn bookkeeping
// ---------------------------------------------------------------------------

/** What a run is: a user turn, or the turn one of the commands starts. */
type TurnKind = 'turn' | 'review' | 'compact' | 'shell' | 'goal'

/** How the user's `!cmd` ended, as the `userShell` item of its turn reported it. */
interface ShellOutcome {
  exitCode: number | undefined
  status: string | undefined
}

interface TurnRun {
  readonly kind: TurnKind
  turnId: string | undefined
  /** The user's abort signal fired. */
  aborted: boolean
  interruptRequested: boolean
  finished: boolean
  /** A terminal condition codex-acp turns into a prompt failure. */
  failure: NativeTransportError | undefined
  /** An error message already reached the transcript. */
  errorShown: boolean
  /** Errors that arrived before the turn id was known. */
  readonly pendingErrors: JsonRecord[]
  readonly completions: Map<string, JsonRecord>
  readonly identified: PromiseWithResolvers<string | undefined>
  readonly completion: PromiseWithResolvers<JsonRecord | undefined>
  /** Filled while the turn of a `!cmd` runs. */
  readonly shell: ShellOutcome | undefined
  abortTimer: NodeJS.Timeout | undefined
}

interface TurnOutcome {
  readonly stopReason: NativePromptResult['stopReason']
  readonly turn: JsonRecord | undefined
  readonly failure: NativeTransportError | undefined
  /** An error message already reached the transcript. */
  readonly errorShown: boolean
  readonly shell: ShellOutcome | undefined
}

function newRun(kind: TurnKind): TurnRun {
  const completion = Promise.withResolvers<JsonRecord | undefined>()
  // A run can fail before anything awaits it (the process exits while `turn/start` is pending).
  completion.promise.catch(() => undefined)
  return {
    kind,
    turnId: undefined,
    aborted: false,
    interruptRequested: false,
    finished: false,
    failure: undefined,
    errorShown: false,
    pendingErrors: [],
    completions: new Map(),
    identified: Promise.withResolvers<string | undefined>(),
    completion,
    shell: kind === 'shell' ? { exitCode: undefined, status: undefined } : undefined,
    abortTimer: undefined,
  }
}

interface PendingRequest {
  readonly method: string
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
}

interface PendingServerRequest {
  readonly method: string
  readonly controller: AbortController
}

function parseSlashCommand(content: readonly NativeContentBlock[]): { readonly name: string; readonly rest: string } | undefined {
  const first = content[0]
  if (first === undefined || first.type !== 'text') return undefined
  const text = first.text.trim()
  if (!text.startsWith('/')) return undefined
  const commandText = text.slice(1).trim()
  if (commandText.length === 0) return undefined
  const name = commandText.split(/\s+/)[0]
  if (name === undefined || name === '') return undefined
  return { name: name.toLowerCase(), rest: commandText.slice(name.length).trim() }
}

/**
 * `!cmd`, the shell escape: the host sends a lone user text that starts with `!` bare, and the rest is a command for
 * the user's shell (`''` for a bare `!`). `undefined` for any other prompt.
 */
function parseShellEscape(content: readonly NativeContentBlock[]): string | undefined {
  const [first] = content
  if (content.length !== 1 || first?.type !== 'text' || !first.text.startsWith('!')) return undefined
  return first.text.slice(1).trim()
}

function codexUserInput(content: readonly NativeContentBlock[]): JsonRecord[] {
  return content.map((block) =>
    block.type === 'text'
      ? { type: 'text', text: block.text, text_elements: [] }
      : { type: 'image', url: `data:${block.mimeType};base64,${block.data}` },
  )
}

/** The user input of a command that replaces its own text (`/init`, a skill): `text` instead of the first block, the rest as sent. */
function inputReplacingCommand(content: readonly NativeContentBlock[], text: string): JsonRecord[] {
  return codexUserInput([{ type: 'text', text }, ...content.slice(1)])
}

/** What a slash command made of a prompt: an answer, or the user input the turn is started with instead of the typed line. */
type CommandOutcome = NativePromptResult | { readonly input: JsonRecord[] }

/** The hidden message that opens a side fork, as `thread/inject_items` takes it (a Responses API message item). */
const SIDE_BOUNDARY_ITEM = {
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text: SIDE_BOUNDARY_PROMPT }],
} as const

const SIDE_CANCELLED: NativeCommandResult = { kind: 'error', text: 'The side question was cancelled.' }

/** How a `!cmd` that did not succeed ended; a success needs no words, its command row says it. */
function shellEndNote(shell: ShellOutcome | undefined): string | undefined {
  if (shell === undefined) return undefined
  if (shell.exitCode !== undefined) return shell.exitCode === 0 ? undefined : `Exit code ${String(shell.exitCode)}`
  if (shell.status === 'failed') return 'The command failed.'
  if (shell.status === 'declined') return 'The command was not run.'
  return undefined
}

/** A path as `/status` shows it: relative to the session directory when inside it. */
function shownPath(cwd: string, path: string): string {
  const shown = relative(cwd, path)
  return shown === '' || shown.startsWith('..') || isAbsolute(shown) ? path : shown
}

/** The outcome of a held prompt that followed no turn at all (a goal that was set and never ran). */
function noTurn(signal: AbortSignal): TurnOutcome {
  return { stopReason: signal.aborted ? 'cancelled' : 'end_turn', turn: undefined, failure: undefined, errorShown: false, shell: undefined }
}

/** Whether the answer to a server request cancels the turn that asked (a refusal that lets the turn go on does not). */
function cancelsTurn(answer: CodexServerRequestAnswer): boolean {
  if (!('result' in answer)) return false
  const decision = asRecord(answer.result)?.['decision']
  return decision === 'cancel' || decision === 'abort'
}

function sourceDescription(code: number | null, signal: string | null): string {
  return code === 0 && signal === null
    ? 'codex app-server exited'
    : `codex app-server exited with code ${String(code)} signal ${String(signal)}`
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** One `codex app-server` process attached to one Codex thread. Not reusable after `close()`. */
class CodexAppServerTransport implements NativeTransport {
  readonly kind: NativeTransportKind = 'codex'
  readonly canFork = true

  private options: NativeTransportStartOptions | undefined
  private child: NativeProcess | undefined
  private lines: Interface | undefined
  private stderr = ''
  private exitError: NativeTransportError | undefined
  private startPromise: Promise<void> | undefined
  private closePromise: Promise<void> | undefined
  private closing = false

  private nextRequestId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly pendingServerRequests = new Map<string | number, PendingServerRequest>()

  private threadId: string | undefined
  private version = ''
  private controlsState: CodexControlsState | undefined
  private projection: CodexProjection | undefined
  private tokens: CodexTokenAccounting | undefined
  private lastContextUsage: NativeContextUsage | undefined
  private summaryDisabled = false
  /** The thread id a resume asked for: the only one notifications can be attributed to before the response. */
  private resumeTarget: string | undefined
  private accountText = 'not logged in'
  private chatgptAccount = false
  private launch: CodexLaunch | undefined
  /** The thread response of the attached thread: what `/status` and a side fork need to know about it. */
  private attached: ThreadAttachment | undefined
  private threadName: string | undefined
  /** Threads the app-server runs for this conversation's sub-agents: their requests are the user's to answer. */
  private readonly subAgentThreads = new Set<string>()
  private skills: readonly CodexSkill[] | undefined
  private commandList: readonly NativeCommand[] = CODEX_NATIVE_COMMANDS
  private announcedCommands = ''
  /** The goal of the thread as the app-server last reported it; `undefined`: none, or none reported yet. */
  private goal: CodexGoal | undefined
  /** A `/goal` command is changing the goal and says so itself, so the notification that follows needs no note. */
  private goalCommandRunning = false
  /** Turns the app-server started by itself (it continues an active goal), each with the timer that stops it if no prompt takes it over. */
  private readonly serverTurns = new Map<string, NodeJS.Timeout>()
  /** How the turns nobody followed yet ended, until a prompt takes them over. */
  private readonly orphanCompletions = new Map<string, JsonRecord>()
  /** Ends the wait of a held prompt for the next turn of its goal. */
  private serverTurnWaiter: (() => void) | undefined

  private run: TurnRun | undefined
  private busy = false
  private sideRun: CodexSideRun | undefined
  /** A `/new` or `/clear` is replacing the thread. */
  private switching = false
  private readonly openToolCalls = new Set<string>()

  private readonly sink: CodexProjectionSink = {
    update: (update) => {
      this.trackToolCall(update)
      this.emit({ kind: 'update', update })
    },
    contextUsage: (usage) => {
      this.lastContextUsage = usage
      this.emit({ kind: 'context_usage', contextUsage: usage })
    },
  }

  /** What answering a server request needs; `start()` adds `elicit` when the host has a question surface. */
  private approvalHost: CodexApprovalHost = {
    context: {
      commandStarted: (itemId) => this.projection?.commandStarted(itemId) ?? false,
      commandName: (itemId) => this.projection?.commandName(itemId),
      fileChange: (itemId) => this.projection?.fileChange(itemId),
      popPendingMcpApproval: (serverName) => this.projection?.popPendingMcpApproval(serverName),
    },
    ask: (request, signal) =>
      this.askHost('onPermission', this.options?.onPermission, request, signal, { cancelled: true }),
    update: (update) => {
      this.sink.update(update)
    },
    nextStandaloneMcpToolCallId: (threadId, serverName) =>
      this.projection?.nextStandaloneMcpToolCallId(threadId, serverName) ?? `elicitation:${threadId}:${serverName}`,
    log: (message) => {
      this.log(message)
    },
  }

  /** `request`, as the helpers of `codex-immediate.ts` take it. */
  private readonly rpc: CodexRequest = (method, params, timeoutMs) => this.request(method, params, timeoutMs)

  get sessionId(): string | undefined {
    return this.threadId
  }

  get agentInfo(): { readonly name: string; readonly version: string } {
    return { name: 'codex', version: this.version }
  }

  /** `true` once the process exited or `close()` ran; the runtime then re-attaches with a resume. */
  get closed(): boolean {
    return this.closing || this.exitError !== undefined
  }

  // -- logging / events -------------------------------------------------------

  private log(message: string): void {
    try {
      this.options?.log?.(message)
    } catch {
      // A diagnostic sink must never break the protocol loop.
    }
  }

  private emit(event: NativeTransportEvent): void {
    try {
      this.options?.onEvent(event)
    } catch (error: unknown) {
      this.log(`codex: onEvent handler threw: ${messageOf(error)}`)
    }
  }

  private trackToolCall(update: acp.SessionUpdate): void {
    if (update.sessionUpdate === 'tool_call') {
      if (update.status === 'completed' || update.status === 'failed') this.openToolCalls.delete(update.toolCallId)
      else this.openToolCalls.add(update.toolCallId)
    } else if (update.sessionUpdate === 'tool_call_update') {
      if (update.status === 'completed' || update.status === 'failed') this.openToolCalls.delete(update.toolCallId)
    }
  }

  // -- lifecycle --------------------------------------------------------------

  start(options: NativeTransportStartOptions): Promise<void> {
    if (this.startPromise === undefined) this.startPromise = this.startInternal(options)
    return this.startPromise
  }

  private async startInternal(options: NativeTransportStartOptions): Promise<void> {
    if (this.closing) throw new NativeTransportError('Codex transport is closed', 'closed')
    this.options = options
    const onElicitation = options.onElicitation
    if (onElicitation !== undefined) {
      this.approvalHost = {
        ...this.approvalHost,
        elicit: (request, signal) =>
          this.askHost('onElicitation', onElicitation, request, signal, { action: 'cancel' }),
      }
    }
    try {
      const launch = codexLaunch(options)
      this.spawnProcess(options, launch.argv)
      await this.initialize()
      await this.attachSession(options, launch)
    } catch (error: unknown) {
      await this.close().catch(() => undefined)
      throw this.startFailure(error)
    }
    setTimeout(() => {
      this.publishCommands()
    }, 0).unref()
  }

  private startFailure(error: unknown): NativeTransportError {
    if (error instanceof NativeTransportError) return error
    return new NativeTransportError(`Failed to start codex app-server: ${messageOf(error)}`, 'start-failed', this.stderrTail())
  }

  private spawnProcess(options: NativeTransportStartOptions, argv: readonly string[]): void {
    const child = options.spawn({ argv, cwd: options.cwd, env: options.env })
    this.child = child
    child.stdin.on('error', (error: Error) => {
      this.log(`codex: stdin error: ${error.message}`)
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      this.stderr += chunk.toString()
      if (this.stderr.length > STDERR_LIMIT) this.stderr = this.stderr.slice(-STDERR_LIMIT)
    })
    child.stdout.on('error', (error: Error) => {
      this.log(`codex: stdout error: ${error.message}`)
    })
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    this.lines.on('line', (line: string) => {
      this.handleLine(line)
    })
    child.exited.then(
      async (outcome) => {
        await this.settleStderr(child)
        this.handleProcessEnd(
          new NativeTransportError(sourceDescription(outcome.exitCode, outcome.signal), 'process-exit', this.stderrTail()),
        )
      },
      async (error: unknown) => {
        await this.settleStderr(child)
        this.handleProcessEnd(
          new NativeTransportError(`codex app-server failed: ${messageOf(error)}`, 'process-error', this.stderrTail()),
        )
      },
    )
  }

  private stderrTail(): string {
    return this.stderr.trim().slice(-DETAIL_LIMIT)
  }

  /** Give the stderr pipe a moment to deliver what the process wrote right before it exited. */
  private async settleStderr(child: NativeProcess): Promise<void> {
    const stream = child.stderr
    if (stream.readableEnded || stream.destroyed) return
    const { promise, resolve } = Promise.withResolvers<void>()
    stream.once('close', resolve)
    stream.once('end', resolve)
    await withTimeout(promise, STDERR_SETTLE_MS, undefined)
    stream.off('close', resolve)
    stream.off('end', resolve)
  }

  private handleProcessEnd(error: NativeTransportError): void {
    if (this.exitError !== undefined) return
    this.exitError = error
    this.rejectPending(error)
    this.abortServerRequests()
    for (const toolCallId of this.openToolCalls) {
      this.emit({ kind: 'update', update: { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed' } })
    }
    this.openToolCalls.clear()
    const run = this.run
    if (run !== undefined) this.failRun(run, error)
    this.sideRun?.fail(error)
    if (!this.closing) this.log(`${error.message}${error.detail === undefined ? '' : `\n${error.detail}`}`)
  }

  private async initialize(): Promise<void> {
    const result = await this.request(
      'initialize',
      { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true, requestAttestation: false } },
      HANDSHAKE_TIMEOUT_MS,
    )
    const userAgent = readString(asRecord(result), 'userAgent')
    // `<originator>/<codex version> (<os>; <arch>) ...`: the originator itself may contain a slash.
    this.version = userAgent?.match(/\/(\d+(?:\.\d+)+(?:[-+][\w.-]+)?)(?=\s|$)/)?.[1] ?? ''
    this.log(`codex: initialized${userAgent === undefined ? '' : ` (${truncate(userAgent, 200)})`}`)
    this.notify('initialized', {})
  }

  // -- session attachment -----------------------------------------------------

  /** codex-acp `getResumeModelProvider`: the launch provider, else the configured one, else `openai`. */
  private async resumeModelProvider(launch: CodexLaunch): Promise<string> {
    if (launch.modelProvider !== undefined) return launch.modelProvider
    try {
      const response = await this.request('config/read', { includeLayers: false }, REQUEST_TIMEOUT_MS)
      return readString(asRecord(asRecord(response)?.['config']), 'model_provider') ?? 'openai'
    } catch (error: unknown) {
      this.log(`codex: config/read failed (${messageOf(error)}); resuming with the openai provider`)
      return 'openai'
    }
  }

  private async attachSession(options: NativeTransportStartOptions, launch: CodexLaunch): Promise<void> {
    const config = threadSessionConfig(launch.baseConfig, options.cwd)
    const target = options.session
    // Created before the first thread request so that nothing the app-server pushes right behind a
    // response (the usage replay of a resumed thread) is lost.
    this.tokens = new CodexTokenAccounting(target.kind !== 'new')
    this.projection = new CodexProjection(this.sink, this.tokens)
    if (target.kind === 'resume') this.resumeTarget = target.sessionId
    let attachment: ThreadAttachment
    switch (target.kind) {
      case 'new':
        attachment = parseThreadAttachment(
          await this.request(
            'thread/start',
            { config, modelProvider: launch.modelProvider ?? null, cwd: options.cwd },
            SESSION_REQUEST_TIMEOUT_MS,
          ),
        )
        break
      case 'resume':
        attachment = await this.resumeThread(target.sessionId, config, options.cwd, launch)
        break
      case 'fork':
        attachment = await this.forkThread(target.parentSessionId, config, options.cwd, launch)
        break
    }
    this.threadId = attachment.threadId
    this.launch = launch
    this.attached = attachment
    this.threadName = attachment.threadName
    const models = await this.fetchModels()
    if (target.kind === 'new' && models.length === 0) {
      throw new NativeTransportError('Codex did not return any models', 'no-models')
    }
    const selection = resolveCodexModelSelection(models, attachment.model, attachment.reasoningEffort)
    this.controlsState = new CodexControlsState({
      mode: initialCodexMode(options.env),
      collaborationMode: attachment.collaborationMode ?? 'default',
      models,
      modelId: selection.model,
      effort: selection.effort,
      fastModeEnabled: attachment.serviceTier === 'fast',
    })
    const provider = attachment.modelProvider ?? launch.modelProvider
    await this.readAccount(provider)
    // A thread that was resumed may carry a goal the app-server pursues; a prompt has to know it to follow the turns the goal starts.
    if (target.kind !== 'new') await this.loadGoal(attachment.threadId)
    this.log(
      `codex: thread ${attachment.threadId} ready (model ${selection.model}, effort ${selection.effort}, provider ${provider ?? 'default'})`,
    )
  }

  /**
   * codex-acp reads the OpenAI account only for the OpenAI provider; an API-key account turns
   * reasoning summaries off. Any other provider (a gateway) has no account.
   */
  private async readAccount(provider: string | undefined): Promise<void> {
    if (provider !== undefined && provider !== 'openai') return
    try {
      const response = await this.request('account/read', { refreshToken: false }, REQUEST_TIMEOUT_MS)
      const account = asRecord(asRecord(response)?.['account'])
      const type = readString(account, 'type')
      this.summaryDisabled = type === 'apiKey'
      this.chatgptAccount = type === 'chatgpt'
      switch (type) {
        case undefined:
          this.accountText = 'not logged in'
          break
        case 'apiKey':
          this.accountText = 'API key configured'
          break
        case 'chatgpt':
          this.accountText = `ChatGPT ${readString(account, 'planType') ?? ''} (${readString(account, 'email') ?? ''})`
          break
        case 'amazonBedrock':
          this.accountText = 'Amazon Bedrock'
          break
        default:
          this.accountText = 'unknown'
      }
    } catch (error: unknown) {
      this.log(`codex: account/read failed (${messageOf(error)}); keeping reasoning summaries on`)
    }
  }

  private async resumeThread(
    sessionId: string,
    config: JsonRecord,
    cwd: string,
    launch: CodexLaunch,
  ): Promise<ThreadAttachment> {
    const params = {
      excludeTurns: true,
      config,
      cwd,
      modelProvider: await this.resumeModelProvider(launch),
      threadId: sessionId,
    }
    try {
      return parseThreadAttachment(await this.request('thread/resume', params, SESSION_REQUEST_TIMEOUT_MS), sessionId)
    } catch (error: unknown) {
      return await this.recoverResume(sessionId, params, error)
    }
  }

  /**
   * The fallbacks of a failed `thread/resume`: a thread another client holds is reported as in use,
   * an archived thread is restored and resumed once more, an unknown one is "session not found".
   */
  private async recoverResume(sessionId: string, params: JsonRecord, error: unknown): Promise<ThreadAttachment> {
    if (isThreadActiveWriterError(error)) {
      throw new NativeTransportError(
        'This Codex session is in use by another Codex client (the Codex app, the CLI or an IDE extension). Close the session there or quit that client, then try again.',
        'session-in-use',
        messageOf(error),
      )
    }
    if (!isMissingRolloutError(error) && !isArchivedThreadError(error)) {
      if (isUnknownThreadError(error)) throw sessionNotFound(sessionId, error)
      throw error
    }
    try {
      this.log(`codex: thread ${sessionId} is not an active session (${messageOf(error)}); trying to unarchive it`)
      await this.request('thread/unarchive', { threadId: sessionId }, REQUEST_TIMEOUT_MS)
      return parseThreadAttachment(await this.request('thread/resume', params, SESSION_REQUEST_TIMEOUT_MS), sessionId)
    } catch (retry: unknown) {
      if (isMissingArchivedRolloutError(retry) || isUnknownThreadError(retry)) throw sessionNotFound(sessionId, error)
      throw retry
    }
  }

  private async forkThread(
    parentId: string,
    config: JsonRecord,
    cwd: string,
    launch: CodexLaunch,
  ): Promise<ThreadAttachment> {
    try {
      return parseThreadAttachment(
        await this.request(
          'thread/fork',
          {
            excludeTurns: true,
            config,
            cwd,
            modelProvider: await this.resumeModelProvider(launch),
            threadId: parentId,
          },
          SESSION_REQUEST_TIMEOUT_MS,
        ),
      )
    } catch (error: unknown) {
      if (isThreadActiveWriterError(error)) {
        throw new NativeTransportError(
          'The Codex session to fork is in use by another Codex client.',
          'session-in-use',
          messageOf(error),
        )
      }
      if (isUnknownThreadError(error)) throw sessionNotFound(parentId, error)
      throw error
    }
  }

  /** codex-acp `fetchAvailableModels`: every page of `model/list`. */
  private async fetchModels(): Promise<CodexModelInfo[]> {
    const models: CodexModelInfo[] = []
    const seen = new Set<string>()
    let cursor: string | null = null
    do {
      const page = parseCodexModelPage(await this.request('model/list', { cursor, limit: null }, REQUEST_TIMEOUT_MS))
      models.push(...page.models)
      cursor = page.nextCursor
      if (cursor !== null) {
        if (seen.has(cursor)) break
        seen.add(cursor)
      }
    } while (cursor !== null)
    return models
  }

  // -- JSON-RPC plumbing --------------------------------------------------------

  private writeFrame(payload: JsonRecord): void {
    const child = this.child
    if (child === undefined) throw new NativeTransportError('codex app-server is not running', 'not-running')
    if (child.stdin.destroyed || !child.stdin.writable) {
      throw this.exitError ?? new NativeTransportError('codex app-server stdin is closed', 'not-running')
    }
    try {
      child.stdin.write(`${JSON.stringify(payload)}\n`)
    } catch (error: unknown) {
      throw new NativeTransportError(`failed to write to codex app-server: ${messageOf(error)}`, 'write-failed')
    }
  }

  private request(method: string, params: unknown, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.closing) return Promise.reject(new NativeTransportError('Codex transport is closed', 'closed'))
    if (this.exitError !== undefined) return Promise.reject(this.exitError)
    const id = this.nextRequestId
    this.nextRequestId += 1
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    const timer = setTimeout(() => {
      if (!this.pending.delete(id)) return
      reject(new NativeTransportError(`codex app-server request timed out: ${method}`, 'timeout'))
    }, timeoutMs)
    timer.unref()
    this.pending.set(id, { method, resolve, reject, timer })
    try {
      this.writeFrame({ id, method, params })
    } catch (error: unknown) {
      clearTimeout(timer)
      this.pending.delete(id)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    return promise
  }

  private notify(method: string, params: unknown): void {
    try {
      this.writeFrame({ method, params })
    } catch (error: unknown) {
      this.log(`codex: failed to send ${method}: ${messageOf(error)}`)
    }
  }

  private sendAnswer(id: string | number, answer: CodexServerRequestAnswer): void {
    try {
      this.writeFrame('result' in answer ? { id, result: answer.result } : { id, error: answer.error })
    } catch (error: unknown) {
      this.log(`codex: failed to reply to server request ${String(id)}: ${messageOf(error)}`)
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (trimmed === '') return
    let raw: unknown
    try {
      raw = JSON.parse(trimmed)
    } catch {
      this.log(`codex: ignoring non-JSON stdout line: ${truncate(trimmed, 200)}`)
      return
    }
    const frame = asRecord(raw)
    if (frame === undefined) {
      this.log(`codex: ignoring non-object stdout frame: ${truncate(trimmed, 200)}`)
      return
    }
    const id = frame['id']
    const method = frame['method']
    if ((typeof id === 'number' || typeof id === 'string') && typeof method === 'string') {
      // A server -> client request carries both `id` and `method`.
      void this.handleServerRequest(id, method, frame['params'])
    } else if (typeof id === 'number' && ('result' in frame || 'error' in frame)) {
      this.handleResponse(id, frame)
    } else if (typeof method === 'string') {
      this.handleNotification(method, frame['params'])
    } else {
      this.log(`codex: ignoring unrecognized stdout frame: ${truncate(trimmed, 200)}`)
    }
  }

  private handleResponse(id: number, frame: JsonRecord): void {
    const pending = this.pending.get(id)
    if (pending === undefined) {
      this.log(`codex: response for unknown request id ${String(id)}`)
      return
    }
    clearTimeout(pending.timer)
    this.pending.delete(id)
    if (!('error' in frame) || frame['error'] === undefined) {
      pending.resolve(frame['result'])
      return
    }
    const error = asRecord(frame['error'])
    if (error === undefined) {
      pending.reject(new CodexRpcError('malformed JSON-RPC error', undefined, frame['error']))
      return
    }
    const code = typeof error['code'] === 'number' || typeof error['code'] === 'string' ? error['code'] : undefined
    pending.reject(new CodexRpcError(readString(error, 'message') ?? 'codex app-server error', code, error['data']))
  }

  // -- server -> client requests ---------------------------------------------------

  private async handleServerRequest(id: string | number, method: string, params: unknown): Promise<void> {
    if (this.closing) return
    if (this.refuseForeignRequest(id, method, params)) return
    const controller = new AbortController()
    this.pendingServerRequests.set(id, { method, controller })
    try {
      const answer = await answerCodexServerRequest(method, params, this.approvalHost, controller.signal)
      // Cancelling the turn from an approval stops a goal too, as in the TUI: the app-server would carry on with it otherwise.
      if (cancelsTurn(answer)) await this.pauseGoal('an approval was cancelled')
      this.sendAnswer(id, answer)
    } catch (error: unknown) {
      this.log(`codex: failed to answer server request ${method}: ${messageOf(error)}`)
      this.sendAnswer(id, fallbackCodexServerAnswer(method))
    } finally {
      this.pendingServerRequests.delete(id)
    }
  }

  /**
   * A request is the user's to answer only when its thread is this conversation or one of its sub-agents. The fork of a
   * side question has nobody to ask (a side question cannot approve anything) and any other thread is not known: both
   * are declined on the spot, which refuses the action without ending the turn that asked. Returns whether it did.
   */
  private refuseForeignRequest(id: string | number, method: string, params: unknown): boolean {
    const record = asRecord(params)
    const target = readString(record, 'threadId') ?? readString(record, 'conversationId')
    const scope = this.threadId ?? this.resumeTarget
    if (target === undefined || scope === undefined || target === scope || this.subAgentThreads.has(target)) return false
    const side = this.sideRun
    if (side !== undefined && target === side.threadId) {
      side.decline(describeCodexServerRequest(method, params))
    } else {
      this.log(`codex: declining ${method} of the unknown thread ${target}`)
    }
    this.sendAnswer(id, declinedCodexServerAnswer(method))
    return true
  }

  /**
   * Put one request to a host handler. The answer is `cancelled` when there is no handler, when `signal` aborts
   * first and when the handler throws or rejects, so the app-server is never left waiting.
   */
  private askHost<Req, Answer>(
    name: string,
    handler: ((request: Req, signal: AbortSignal) => Promise<Answer>) | undefined,
    request: Req,
    signal: AbortSignal,
    cancelled: NoInfer<Answer>,
  ): Promise<Answer> {
    const { promise, resolve } = Promise.withResolvers<Answer>()
    if (handler === undefined || signal.aborted) {
      resolve(cancelled)
      return promise
    }
    let settled = false
    const finish = (answer: Answer): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve(answer)
    }
    const onAbort = (): void => {
      finish(cancelled)
    }
    const onFailure = (error: unknown): void => {
      this.log(`codex: ${name} handler failed: ${messageOf(error)}`)
      finish(cancelled)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      handler(request, signal).then(finish, onFailure)
    } catch (error: unknown) {
      onFailure(error)
    }
    return promise
  }

  private abortServerRequests(): void {
    for (const pending of this.pendingServerRequests.values()) pending.controller.abort()
  }

  // -- notifications ---------------------------------------------------------------

  private handleNotification(method: string, rawParams: unknown): void {
    if (this.closing) return
    const params = asRecord(rawParams) ?? {}
    if (method === 'thread/started') {
      this.noteStartedThread(params)
      return
    }
    const threadId = readString(params, 'threadId') ?? readString(params, 'conversationId')
    // Until the session id is known only a resumed thread can be told apart; everything else waits.
    const scope = this.threadId ?? this.resumeTarget
    if (scope === undefined) return
    if (threadId !== undefined && threadId !== scope) {
      // The fork of a side question is collected for its answer. Sub-agent threads share the connection, but only
      // this conversation maps to the host surface.
      const side = this.sideRun
      if (side !== undefined && threadId === side.threadId) side.handle(method, params)
      return
    }
    switch (method) {
      case 'turn/started': {
        const turnId = readString(asRecord(params['turn']), 'id')
        const run = this.run
        if (turnId === undefined) return
        if (run !== undefined && run.turnId === undefined) this.identifyRun(run, turnId)
        // Any other turn was started by the app-server itself: it continues an active goal.
        else if (run?.turnId !== turnId) this.serverTurnStarted(turnId)
        return
      }
      case 'turn/completed': {
        this.projection?.endTurn()
        this.openToolCalls.clear()
        const turn = asRecord(params['turn'])
        const turnId = readString(turn, 'id')
        const run = this.run
        if (turn === undefined || turnId === undefined) return
        if (run !== undefined) this.completeRun(run, turnId, turn)
        // The end of a turn nobody follows yet waits for whoever takes it over.
        if (run?.turnId !== turnId) this.keepCompletion(turnId, turn)
        return
      }
      case 'thread/goal/updated':
        this.applyGoal(parseGoal(params['goal']))
        return
      case 'thread/goal/cleared':
        this.applyGoal(undefined)
        return
      case 'error':
        this.handleErrorNotification(params)
        return
      case 'serverRequest/resolved': {
        const requestId = params['requestId']
        if (typeof requestId !== 'number' && typeof requestId !== 'string') return
        const pending = this.pendingServerRequests.get(requestId)
        if (pending === undefined) return
        this.log(`codex: ${pending.method} was resolved elsewhere`)
        pending.controller.abort()
        return
      }
      case 'item/completed':
        this.noteShellItem(params)
        this.projection?.handle(method, params)
        return
      case 'thread/name/updated':
        this.threadName = readString(params, 'threadName')?.trim() || undefined
        this.projection?.handle(method, params)
        return
      case 'skills/changed':
        this.refreshSkills(true)
        return
      case 'hook/completed':
      case 'deprecationNotice':
      case 'guardianWarning':
      case 'mcpServer/startupStatus/updated':
      case 'mcpServer/oauthLogin/completed': {
        const text = codexNoticeText(method, params)
        if (text !== undefined) this.note(text)
        return
      }
      default:
        this.projection?.handle(method, params)
    }
  }

  /** The threads of this conversation's sub-agents (`parentThreadId` set) are the user's to answer for. */
  private noteStartedThread(params: JsonRecord): void {
    const thread = asRecord(params['thread'])
    const id = readString(thread, 'id')
    const parent = readString(thread, 'parentThreadId')
    const scope = this.threadId ?? this.resumeTarget
    if (id === undefined || parent === undefined || scope === undefined) return
    if (parent === scope || this.subAgentThreads.has(parent)) this.subAgentThreads.add(id)
  }

  /** The outcome of the user's `!cmd`, from the `userShell` item of its turn. */
  private noteShellItem(params: JsonRecord): void {
    const shell = this.run?.shell
    const item = asRecord(params['item'])
    if (shell === undefined || readString(item, 'type') !== 'commandExecution' || readString(item, 'source') !== 'userShell') return
    shell.exitCode = readNumber(item, 'exitCode')
    shell.status = readString(item, 'status')
  }

  /** A quiet notice of the app-server: a thought note inside the running turn, else a line for the host log. */
  private note(text: string): void {
    if (this.busy) this.sink.update(thoughtNote(text))
    else this.emit({ kind: 'notice', text })
  }

  private handleErrorNotification(params: JsonRecord): void {
    const error = asRecord(params['error'])
    const message = readString(error, 'message') ?? 'unknown error'
    const details = readString(error, 'additionalDetails')
    const turnId = readString(params, 'turnId')
    const willRetry = params['willRetry'] === true
    const run = this.run
    if (willRetry || run === undefined || (turnId !== undefined && run.turnId !== undefined && turnId !== run.turnId)) {
      // A retry notice or the error of another turn: diagnostics only.
      this.emit({
        kind: 'notice',
        text: truncate(
          `Codex error${willRetry ? ' (will retry)' : ''}: ${message}${details === undefined ? '' : ` — ${details}`}`,
          DETAIL_LIMIT,
        ),
      })
      return
    }
    if (run.turnId === undefined) {
      // codex-acp holds an error back until the turn it belongs to is known.
      run.pendingErrors.push(params)
      return
    }
    const info = error?.['codexErrorInfo']
    const httpStatus = asRecord(info !== null && typeof info === 'object' ? Object.values(info)[0] : undefined)?.[
      'httpStatusCode'
    ]
    if (info === 'unauthorized' || httpStatus === 401) {
      run.failure ??= new NativeTransportError('Codex requires authentication', 'auth-required', message)
      return
    }
    if (info === 'usageLimitExceeded') run.failure ??= new NativeTransportError(message, 'usage-limit', details)
    run.errorShown = true
    this.sink.update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `${readableServiceErrorMessage(message)}\n\n` },
    })
  }

  // -- turn runs ----------------------------------------------------------------------

  private identifyRun(run: TurnRun, turnId: string): void {
    if (run.turnId !== undefined) return
    run.turnId = turnId
    run.identified.resolve(turnId)
    for (const pending of run.pendingErrors.splice(0)) this.handleErrorNotification(pending)
    const early = run.completions.get(turnId)
    if (early !== undefined) run.completion.resolve(early)
    if (run.interruptRequested) void this.sendInterrupt(run)
  }

  private completeRun(run: TurnRun, turnId: string, turn: JsonRecord): void {
    run.completions.set(turnId, turn)
    if (run.turnId === turnId) run.completion.resolve(turn)
  }

  private failRun(run: TurnRun, error: Error): void {
    run.identified.resolve(undefined)
    run.completion.reject(error)
  }

  private requestInterrupt(run: TurnRun): void {
    run.aborted = true
    this.abortServerRequests()
    if (run.interruptRequested) return
    void this.pauseGoal('the prompt was stopped')
    run.interruptRequested = true
    run.abortTimer = setTimeout(() => {
      this.log('codex: the turn did not settle after the interrupt; reporting it cancelled')
      run.completion.resolve({ status: 'interrupted' })
    }, ABORT_SETTLE_FALLBACK_MS)
    run.abortTimer.unref()
    if (run.turnId !== undefined) void this.sendInterrupt(run)
  }

  /** `turn/interrupt`, retried while Codex reports the freshly started turn is not interruptible yet. */
  private async sendInterrupt(run: TurnRun): Promise<void> {
    const threadId = this.threadId
    const turnId = run.turnId
    if (threadId === undefined || turnId === undefined) return
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.request('turn/interrupt', { threadId, turnId }, INTERRUPT_TIMEOUT_MS)
        return
      } catch (error: unknown) {
        const delay = NO_ACTIVE_TURN_RETRY_DELAYS_MS[attempt]
        if (!isNoActiveTurnError(error) || run.finished || delay === undefined) {
          if (!isNoActiveTurnError(error)) this.log(`codex: turn/interrupt failed: ${messageOf(error)}`)
          return
        }
        await sleep(delay)
      }
    }
  }

  /**
   * Run one turn: `start` issues the request that begins it (its response may
   * carry the turn id; otherwise `turn/started` does), and the run settles with
   * the matching `turn/completed`.
   */
  private async runTurn(start: () => Promise<unknown>, signal: AbortSignal, kind: TurnKind = 'turn'): Promise<TurnOutcome> {
    const run = newRun(kind)
    this.run = run
    const onAbort = (): void => {
      this.requestInterrupt(run)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await start()
      const turnId = readString(asRecord(asRecord(response)?.['turn']), 'id')
      if (turnId !== undefined) this.identifyRun(run, turnId)
      const turn = await run.completion.promise
      return {
        stopReason: this.stopReasonOf(run, turn),
        turn,
        failure: run.failure,
        errorShown: run.errorShown,
        shell: run.shell,
      }
    } catch (error: unknown) {
      if (signal.aborted && this.exitError === undefined) {
        return { stopReason: 'cancelled', turn: undefined, failure: undefined, errorShown: false, shell: run.shell }
      }
      throw error
    } finally {
      signal.removeEventListener('abort', onAbort)
      run.finished = true
      clearTimeout(run.abortTimer)
      run.identified.resolve(undefined)
      if (this.run === run) this.run = undefined
    }
  }

  private stopReasonOf(run: TurnRun, turn: JsonRecord | undefined): NativePromptResult['stopReason'] {
    const status = readString(turn, 'status')
    if (status === 'interrupted') return 'cancelled'
    if (status === 'failed' && run.aborted) return 'cancelled'
    return 'end_turn'
  }

  // -- NativeTransport surface -----------------------------------------------------------

  controls(): NativeControls {
    return this.requireState().snapshot()
  }

  contextUsage(): NativeContextUsage | undefined {
    return this.lastContextUsage
  }

  private requireState(): CodexControlsState {
    if (this.controlsState === undefined) throw new NativeTransportError('Codex transport was not started', 'not-started')
    return this.controlsState
  }

  async setConfigOption(configId: string, value: string | boolean, signal?: AbortSignal): Promise<void> {
    const state = this.requireState()
    if (signal?.aborted === true) throw new NativeTransportError('the session option change was aborted', 'aborted')
    switch (configId) {
      case CODEX_MODE_CONFIG_ID: {
        const mode = state.setMode(value)
        // The next turn carries the mode; pushing it to the thread keeps turn-less flows (/review) consistent.
        await this.updateThread({
          approvalPolicy: mode.settings.approvalPolicy,
          approvalsReviewer: mode.settings.approvalsReviewer,
          sandboxPolicy: mode.settings.sandboxPolicy,
        }).catch((error: unknown) => {
          this.log(`codex: thread/settings/update for the mode failed: ${messageOf(error)}`)
        })
        return
      }
      case CODEX_COLLABORATION_CONFIG_ID: {
        const mode = state.parseCollaborationMode(value)
        await this.applyCollaborationMode(mode)
        return
      }
      case CODEX_MODEL_CONFIG_ID:
        state.setModel(value)
        return
      case CODEX_EFFORT_CONFIG_ID:
        state.setEffort(value)
        return
      case CODEX_FAST_MODE_CONFIG_ID:
        state.setFastMode(value)
        return
      default:
        throw new NativeTransportError(`Codex has no session option ${configId}`, 'invalid-config-option')
    }
  }

  private async updateThread(settings: JsonRecord): Promise<void> {
    const threadId = this.threadId
    if (threadId === undefined) throw new NativeTransportError('Codex transport was not started', 'not-started')
    await this.request('thread/settings/update', { threadId, ...settings }, REQUEST_TIMEOUT_MS)
  }

  /** codex-acp `setCollaborationMode`: the mode travels with the current model and effort. */
  private async applyCollaborationMode(mode: CodexCollaborationMode): Promise<void> {
    const state = this.requireState()
    await this.updateThread({
      collaborationMode: {
        mode,
        settings: { model: state.modelId, reasoning_effort: state.effort, developer_instructions: null },
      },
    })
    state.collaborationMode = mode
  }

  async prompt(content: readonly NativeContentBlock[], signal: AbortSignal): Promise<NativePromptResult> {
    this.requireUsable()
    if (this.busy) throw new NativeTransportError('A Codex prompt is already in progress', 'busy')
    if (this.switching) throw new NativeTransportError('The Codex conversation is being changed', 'busy')
    if (content.length === 0) throw new NativeTransportError('prompt content must not be empty', 'empty-prompt')
    if (signal.aborted) return { stopReason: 'cancelled' }
    this.busy = true
    try {
      return await this.promptInternal(content, signal)
    } finally {
      this.busy = false
    }
  }

  private async promptInternal(content: readonly NativeContentBlock[], signal: AbortSignal): Promise<NativePromptResult> {
    const state = this.requireState()
    const tokens = this.requireTokens()
    const shell = parseShellEscape(content)
    if (shell !== undefined) return await this.shellEscape(shell, signal)
    let commandInput: JsonRecord[] | undefined
    const command = parseSlashCommand(content)
    if (command !== undefined) {
      const handled = await this.tryCommand(command, content, signal)
      if (handled !== undefined && !('input' in handled)) return handled
      commandInput = handled?.input
    }
    if (!state.imageInput && content.some((block) => block.type === 'image')) {
      throw new NativeTransportError('The current model does not support image input', 'image-unsupported')
    }
    const input = commandInput ?? codexUserInput(content)
    tokens.beginPrompt()
    let outcome = await this.runTurn(() => this.startTurn(this.requireThreadId(), input), signal)
    this.throwOnFailure(outcome)
    if (outcome.stopReason === 'end_turn' && readString(outcome.turn, 'status') === 'completed') {
      outcome = (await this.implementApprovedPlan(signal)) ?? outcome
      this.throwOnFailure(outcome)
    }
    return this.promptResult(await this.followGoal(outcome, signal))
  }

  private requireTokens(): CodexTokenAccounting {
    if (this.tokens === undefined) throw new NativeTransportError('Codex transport was not started', 'not-started')
    return this.tokens
  }

  private throwOnFailure(outcome: TurnOutcome): void {
    if (outcome.failure !== undefined) throw outcome.failure
    if (readString(outcome.turn, 'status') === 'failed' && outcome.stopReason !== 'cancelled') {
      // A failed turn whose error never reached the transcript still has to tell the user why.
      const error = asRecord(outcome.turn?.['error'])
      const message = readString(error, 'message')
      if (message !== undefined && !outcome.errorShown) {
        this.sink.update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `${readableServiceErrorMessage(message)}\n\n` },
        })
      }
    }
  }

  private promptResult(outcome: TurnOutcome): NativePromptResult {
    const usage = this.requireTokens().promptUsage()
    return usage === undefined ? { stopReason: outcome.stopReason } : { stopReason: outcome.stopReason, usage }
  }

  /** `turn/start` on `threadId` with the settings of the controls; `extra` adds request fields. */
  private startTurn(threadId: string, input: readonly JsonRecord[], extra: JsonRecord = {}): Promise<unknown> {
    const state = this.requireState()
    return this.request(
      'turn/start',
      {
        threadId,
        input,
        approvalPolicy: state.mode.settings.approvalPolicy,
        approvalsReviewer: state.mode.settings.approvalsReviewer,
        sandboxPolicy: state.mode.settings.sandboxPolicy,
        summary: this.summaryDisabled || state.modelLacksReasoning ? 'none' : 'auto',
        effort: state.effort,
        model: state.modelId,
        serviceTier: state.serviceTier,
        ...extra,
      },
      REQUEST_TIMEOUT_MS,
    ).catch((error: unknown) => {
      throw error instanceof NativeTransportError
        ? error
        : new NativeTransportError(
            `Codex turn/start failed: ${messageOf(error)}`,
            'turn-start-failed',
            error instanceof CodexRpcError ? truncate(JSON.stringify(error.data) ?? '', DETAIL_LIMIT) : undefined,
          )
    })
  }

  // -- plan review ------------------------------------------------------------------

  /**
   * codex-acp asks to implement a plan the model finished in plan mode and, when
   * approved, leaves plan mode and runs the implementation as part of the same
   * prompt. Returns the implementation outcome, or `undefined` when nothing ran.
   */
  private async implementApprovedPlan(signal: AbortSignal): Promise<TurnOutcome | undefined> {
    const state = this.requireState()
    const plan = this.projection?.takeCompletedPlan() ?? null
    if (plan === null || state.collaborationMode !== 'plan' || signal.aborted) return undefined
    const toolCall = planReviewToolCall(plan.itemId, plan.text)
    this.sink.update({
      sessionUpdate: 'tool_call',
      toolCallId: toolCall.toolCallId,
      title: 'Implement this plan?',
      kind: 'switch_mode',
      status: 'pending',
      rawInput: { plan: plan.text },
    })
    const decision = await this.approvalHost.ask(
      {
        toolCall,
        options: [
          { optionId: 'implement_plan', name: 'Yes, implement this plan', kind: 'allow_once' },
          { optionId: 'revise_plan', name: 'No, and tell Codex what to do differently', kind: 'reject_once' },
        ],
      },
      signal,
    )
    const approved = !('cancelled' in decision) && decision.optionId === 'implement_plan'
    this.sink.update(
      renderToolCall({
        toolCallId: toolCall.toolCallId,
        report: 'update',
        status: 'completed',
        opaqueResult: approved ? 'User approved the plan.' : 'User kept the session in plan mode.',
      }),
    )
    if (signal.aborted || !approved) return undefined
    await this.applyCollaborationMode('default')
    this.emit({ kind: 'controls', controls: state.snapshot() })
    const next = await this.runTurn(
      () => this.startTurn(this.requireThreadId(), codexUserInput([{ type: 'text', text: 'Implement the approved plan.' }])),
      signal,
    )
    return next
  }

  // -- slash commands ---------------------------------------------------------------

  /** The built-in commands plus the enabled skills Codex offers (a `commands` event announces every change). */
  commands(): readonly NativeCommand[] {
    return this.commandList
  }

  /**
   * A slash command typed as a prompt: a turn of its own, an answer without a model, or (`/init`, a skill) the text
   * the model receives instead of the command line. A name nothing owns goes to the model as typed.
   */
  private async tryCommand(
    command: { readonly name: string; readonly rest: string },
    content: readonly NativeContentBlock[],
    signal: AbortSignal,
  ): Promise<CommandOutcome | undefined> {
    const state = this.requireState()
    const threadId = this.threadId
    if (threadId === undefined) return undefined
    const name = canonicalCodexCommand(command.name)
    switch (name) {
      case 'plan': {
        if (command.rest.length > 0) return this.commandMessage('Command "/plan" requires no arguments.')
        const next = state.collaborationMode === 'plan' ? 'default' : 'plan'
        await this.applyCollaborationMode(next)
        this.emit({ kind: 'controls', controls: state.snapshot() })
        return this.commandMessage(
          next === 'plan' ? 'Plan mode is on: Codex plans before it changes anything. `/plan` turns it off again.' : 'Plan mode is off.',
        )
      }
      case 'status':
      case 'skills':
      case 'mcp':
      case 'ps':
      case 'stop':
      case 'hooks':
      case 'diff':
        return this.commandMessage((await this.runCommand(name, command.rest, signal)).text)
      case 'rewind':
        // Rolling the conversation back cannot happen inside a prompt (it is the prompt that is running); DSH runs it as a command.
        if (parseRewindArgs(command.rest).action === 'apply') {
          return this.commandMessage('`/rewind … confirm` rolls the conversation back, so it runs as a command rather than as a message.')
        }
        return this.commandMessage((await this.runCommand(name, command.rest, signal)).text)
      case 'new':
      case 'clear':
        // They replace the conversation, which a running prompt must not see; DSH runs them as commands (`runCommand`).
        return this.commandMessage(`\`/${name}\` starts a new Codex conversation, so it runs as a command rather than as a message.`)
      case 'side':
        return this.commandMessage((await this.sideQuestion(command.rest, signal)).text)
      case 'goal':
        return await this.goalCommand(command.rest, signal)
      case 'compact':
        return this.promptResult(
          await this.followGoal(
            await this.commandTurn(
              async () => {
                await this.request('thread/compact/start', { threadId }, REQUEST_TIMEOUT_MS)
                return undefined
              },
              signal,
              'compact',
            ),
            signal,
          ),
        )
      case 'review':
        return await this.reviewCommand(
          command.rest.length === 0 ? { type: 'uncommittedChanges' } : { type: 'custom', instructions: command.rest },
          signal,
        )
      case 'review-branch':
        if (command.rest.length === 0) return this.commandMessage('Command "/review-branch" requires branch name.')
        return await this.reviewCommand({ type: 'baseBranch', branch: command.rest }, signal)
      case 'review-commit':
        if (command.rest.length === 0) return this.commandMessage('Command "/review-commit" requires commit sha.')
        return await this.reviewCommand({ type: 'commit', sha: command.rest, title: null }, signal)
      case 'rename': {
        if (command.rest.length === 0) return this.commandMessage('Command "/rename" requires new name.')
        await this.request('thread/name/set', { threadId, name: command.rest }, REQUEST_TIMEOUT_MS)
        this.threadName = command.rest
        return this.commandMessage(`Renamed the Codex thread to "${command.rest}".`)
      }
      case 'init':
        if (command.rest.length > 0) return this.commandMessage('Command "/init" requires no arguments.')
        // The TUI submits the shipped prompt as an ordinary user message.
        return { input: inputReplacingCommand(content, INIT_PROMPT) }
      default:
        break
    }
    // The rest of the TUI's commands have no meaning here; typing one must not cost a model turn.
    if (isUnsupportedCodexCommand(command.name)) return this.commandMessage(unsupportedCodexCommandMessage(command.name))
    const skill = await this.skillNamed(command.name)
    if (skill === undefined) return undefined
    // A skill is invoked by `$name` in the text plus the structured item that names its file.
    const text = command.rest === '' ? `$${skill.name}` : `$${skill.name} ${command.rest}`
    return { input: [...inputReplacingCommand(content, text), { type: 'skill', name: skill.name, path: skill.path }] }
  }

  private commandMessage(text: string): NativePromptResult {
    this.sink.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
    return { stopReason: 'end_turn' }
  }

  private async reviewCommand(target: JsonRecord, signal: AbortSignal): Promise<NativePromptResult> {
    const threadId = this.requireThreadId()
    return this.promptResult(
      await this.followGoal(
        await this.commandTurn(() => this.request('review/start', { threadId, target, delivery: 'inline' }, REQUEST_TIMEOUT_MS), signal, 'review'),
        signal,
      ),
    )
  }

  /** A command that runs as its own turn (review, compaction, `!cmd`); usage is counted like a prompt's. */
  private async commandTurn(
    start: () => Promise<unknown>,
    signal: AbortSignal,
    kind: 'review' | 'compact' | 'shell',
  ): Promise<TurnOutcome> {
    this.requireTokens().beginPrompt()
    const outcome = await this.runTurn(
      async () => {
        const response = await start()
        const run = this.run
        if (run !== undefined && (kind === 'compact' || kind === 'shell')) {
          // A compaction answers before its turn exists, and a shell command that joins a running turn starts none:
          // if no turn ever starts there is nothing to wait for.
          const timer = setTimeout(() => {
            if (run.turnId === undefined && !run.finished) run.completion.resolve({ status: 'completed' })
          }, COMPACTION_START_GRACE_MS)
          timer.unref()
        }
        return response
      },
      signal,
      kind,
    )
    this.throwOnFailure(outcome)
    return outcome
  }

  /**
   * `!cmd`: Codex runs the user's shell command as a turn of its own, without a model call and outside the sandbox (as
   * in the TUI, where the user typed it). The output is projected like any command's.
   */
  private async shellEscape(command: string, signal: AbortSignal): Promise<NativePromptResult> {
    if (command === '') return this.commandMessage('Prefix a command with ! to run it locally. Example: !ls')
    const threadId = this.requireThreadId()
    const outcome = await this.commandTurn(
      () => this.request('thread/shellCommand', { threadId, command }, REQUEST_TIMEOUT_MS),
      signal,
      'shell',
    )
    // A command that failed has no successful tool result to show: say how it ended.
    const note = outcome.stopReason === 'end_turn' ? shellEndNote(outcome.shell) : undefined
    if (note !== undefined) this.sink.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: note } })
    return this.promptResult(await this.followGoal(outcome, signal))
  }

  // -- goals --------------------------------------------------------------------------

  /** Whether the thread has a goal the app-server pursues: it starts the next turn by itself as soon as one ends. */
  private goalActive(): boolean {
    return this.goal?.status === 'active'
  }

  /**
   * The goal as the app-server reports it. A new objective or status is told in one line (inside the turn that runs), unless a `/goal`
   * command is making the change and says so itself; a goal that is no longer pursued ends the wait of a held prompt.
   */
  private applyGoal(goal: CodexGoal | undefined): void {
    const text = goalNote(this.goal, goal)
    this.goal = goal
    if (text !== undefined && !this.goalCommandRunning) this.note(text)
    if (!this.goalActive()) this.wakeServerTurnWaiter()
  }

  private async fetchGoal(threadId: string): Promise<CodexGoal | undefined> {
    return parseGoal(asRecord(await this.request('thread/goal/get', { threadId }, REQUEST_TIMEOUT_MS))?.['goal'])
  }

  private async readGoal(threadId: string): Promise<CodexGoal | undefined> {
    const goal = await this.fetchGoal(threadId)
    this.applyGoal(goal)
    return goal
  }

  /** The goal the thread already has when this transport meets it (no note: it is not news); a failure leaves it unknown. */
  private async loadGoal(threadId: string): Promise<void> {
    try {
      this.goal = await this.fetchGoal(threadId)
    } catch (error: unknown) {
      if (this.closed) throw error
      this.log(`codex: thread/goal/get failed: ${messageOf(error)}`)
    }
  }

  private async writeGoal(threadId: string, fields: { readonly objective?: string; readonly status: 'active' | 'paused' }): Promise<CodexGoal> {
    const response = await this.request('thread/goal/set', { threadId, origin: 'user', ...fields }, REQUEST_TIMEOUT_MS)
    const goal = parseGoal(asRecord(response)?.['goal'])
    if (goal === undefined) throw new NativeTransportError('Codex did not return the goal', 'protocol-error')
    this.applyGoal(goal)
    return goal
  }

  /** What a `/goal` request did, in words, and whether it set the app-server pursuing the goal (which then runs turns by itself). */
  private async goalRequest(
    request: Exclude<GoalRequest, { readonly action: 'usage' }>,
    threadId: string,
  ): Promise<{ readonly text: string; readonly starts: boolean }> {
    switch (request.action) {
      case 'show': {
        const goal = await this.readGoal(threadId)
        return { text: goal === undefined ? `No goal is currently set.\n\n${GOAL_USAGE}` : formatGoal(goal), starts: false }
      }
      case 'clear': {
        const response = asRecord(await this.request('thread/goal/clear', { threadId, origin: 'user' }, REQUEST_TIMEOUT_MS))
        this.applyGoal(undefined)
        return { text: response?.['cleared'] === true ? 'Goal cleared.' : 'No goal to clear: this thread does not have one.', starts: false }
      }
      case 'pause':
      case 'resume': {
        if ((await this.readGoal(threadId)) === undefined) {
          return { text: `No goal to ${request.action}: this thread does not have one.\n\n${GOAL_USAGE}`, starts: false }
        }
        const goal = await this.writeGoal(threadId, { status: request.action === 'pause' ? 'paused' : 'active' })
        return { text: formatGoalChange(request.action === 'pause' ? 'Goal paused' : 'Goal resumed', goal), starts: goal.status === 'active' }
      }
      case 'set': {
        const existing = await this.readGoal(threadId)
        // The TUI asks before it replaces a goal that is not finished; a command cannot ask, so it says what to do.
        if (existing !== undefined && existing.status !== 'complete') {
          return {
            text: `${formatGoal(existing)}\n\nThis goal is not finished. Run \`/goal clear\` to replace it, or \`/goal resume\` or \`/goal pause\` to carry on or stop.`,
            starts: false,
          }
        }
        if (existing !== undefined) await this.request('thread/goal/clear', { threadId, origin: 'user' }, REQUEST_TIMEOUT_MS)
        const goal = await this.writeGoal(threadId, { objective: request.objective, status: 'active' })
        return { text: formatGoalChange('Goal set', goal), starts: goal.status === 'active' }
      }
    }
  }

  /** `goalRequest` with a failure turned into the answer; the notifications of the change need no note of their own while it runs. */
  private async answerGoal(
    request: Exclude<GoalRequest, { readonly action: 'usage' }>,
    threadId: string,
  ): Promise<{ readonly text: string; readonly starts: boolean }> {
    this.goalCommandRunning = true
    try {
      return await this.goalRequest(request, threadId)
    } catch (error: unknown) {
      // A lost process is the runtime's to handle; anything else is an answer for the user.
      if (this.closed) throw error
      return { text: goalFailure(error), starts: false }
    } finally {
      this.goalCommandRunning = false
    }
  }

  /**
   * `/goal …`, run as a prompt: setting or resuming a goal makes the app-server run turns by itself, and only an open prompt can show
   * them (and be stopped). So DSH forwards the line like a message, and the prompt stays open until the goal is no longer pursued.
   */
  private async goalCommand(args: string, signal: AbortSignal): Promise<NativePromptResult> {
    const request = parseGoalArgs(args)
    if (request.action === 'usage') return this.commandMessage(`${request.problem}\n\n${GOAL_USAGE}`)
    this.requireTokens().beginPrompt()
    const reply = await this.answerGoal(request, this.requireThreadId())
    this.commandMessage(reply.text)
    return reply.starts ? this.promptResult(await this.followGoal(undefined, signal)) : { stopReason: 'end_turn' }
  }

  /**
   * A `/goal …` line steered into a running turn is the user's control of the goal, not a message for the model: it runs now and its
   * answer shows inside the turn. A pause lets the turn in flight finish and keeps the next one from starting; the prompt that
   * follows the goal ends with the turn.
   */
  private async steerGoal(args: string, threadId: string): Promise<'injected'> {
    const request = parseGoalArgs(args)
    this.commandMessage(request.action === 'usage' ? `${request.problem}\n\n${GOAL_USAGE}` : (await this.answerGoal(request, threadId)).text)
    return 'injected'
  }

  /**
   * While a goal is active the app-server starts the next turn by itself as soon as one ends. Those turns belong to the prompt that is
   * open, so it stays open: each one is followed to its end and streams like the first, until the goal is no longer pursued (complete,
   * paused, stalled, out of budget), the prompt is cancelled (which pauses the goal, as the TUI does) or the hold reaches its cap.
   */
  private async followGoal(first: TurnOutcome | undefined, signal: AbortSignal): Promise<TurnOutcome> {
    let last = first ?? noTurn(signal)
    const deadline = Date.now() + GOAL_HOLD_CAP_MS
    for (;;) {
      if (signal.aborted || last.stopReason === 'cancelled') {
        await this.pauseGoal('the prompt was stopped')
        return { ...last, stopReason: 'cancelled' }
      }
      if (!this.goalActive()) return last
      if (Date.now() >= deadline) {
        await this.pauseGoal('the prompt followed it for too long')
        return last
      }
      const turnId = await this.nextServerTurn(signal)
      if (turnId === undefined) {
        if (signal.aborted) continue
        return last
      }
      last = await this.runTurn(() => this.adoptServerTurn(turnId), signal, 'goal')
      this.throwOnFailure(last)
    }
  }

  /** The next turn the app-server starts for the goal: `undefined` when the goal stops being pursued, the prompt is cancelled or none comes in time. */
  private nextServerTurn(signal: AbortSignal): Promise<string | undefined> {
    const waiting = this.claimServerTurn()
    if (waiting !== undefined) return Promise.resolve(waiting)
    if (signal.aborted || !this.goalActive()) return Promise.resolve(undefined)
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        if (this.serverTurnWaiter === done) this.serverTurnWaiter = undefined
        resolve(signal.aborted ? undefined : this.claimServerTurn())
      }
      const timer = setTimeout(done, GOAL_CONTINUATION_GRACE_MS)
      timer.unref()
      signal.addEventListener('abort', done, { once: true })
      this.serverTurnWaiter = done
    })
  }

  private wakeServerTurnWaiter(): void {
    const wake = this.serverTurnWaiter
    this.serverTurnWaiter = undefined
    wake?.()
  }

  /** Takes the oldest turn the app-server started by itself over from the timer that would stop it. */
  private claimServerTurn(): string | undefined {
    const [turnId, timer] = this.serverTurns.entries().next().value ?? []
    if (turnId === undefined) return undefined
    clearTimeout(timer)
    this.serverTurns.delete(turnId)
    return turnId
  }

  /** The app-server started a turn that none of our requests asked for. A prompt that holds the goal takes it over; otherwise it is stopped. */
  private serverTurnStarted(turnId: string): void {
    if (this.serverTurns.has(turnId)) return
    const timer = setTimeout(() => {
      void this.releaseUnattended(turnId)
    }, UNATTENDED_TURN_GRACE_MS)
    timer.unref()
    this.serverTurns.set(turnId, timer)
    this.wakeServerTurnWaiter()
  }

  private keepCompletion(turnId: string, turn: JsonRecord): void {
    this.orphanCompletions.set(turnId, turn)
    const oldest = this.orphanCompletions.keys().next()
    if (this.orphanCompletions.size > ORPHAN_COMPLETIONS_KEPT && !oldest.done) this.orphanCompletions.delete(oldest.value)
  }

  /**
   * A turn of the goal that no prompt is open to show (the thread was resumed with an active goal, say) would run unseen and could not
   * be stopped from DSH. It is interrupted and the goal paused, so that nothing runs where the user cannot see it.
   */
  private async releaseUnattended(turnId: string): Promise<void> {
    if (!this.serverTurns.delete(turnId) || this.closed || !this.goalActive()) return
    const threadId = this.threadId
    if (threadId === undefined) return
    this.log(`codex: stopping the turn ${turnId} that the app-server started for the goal while no prompt was open`)
    await this.pauseGoal('no prompt was open to show its work')
    await this.request('turn/interrupt', { threadId, turnId }, SIDE_CLEANUP_TIMEOUT_MS).catch((error: unknown) => {
      if (!isNoActiveTurnError(error)) this.log(`codex: turn/interrupt failed: ${messageOf(error)}`)
    })
    this.emit({
      kind: 'notice',
      text: 'Codex continued a goal on its own while DSH was not following the session, so the goal was paused. Run /goal resume to continue it here.',
    })
  }

  /** The `start` of a run that follows a turn the app-server already started: its id is the whole response. */
  private adoptServerTurn(turnId: string): Promise<unknown> {
    const run = this.run
    const early = this.orphanCompletions.get(turnId)
    this.orphanCompletions.delete(turnId)
    if (run !== undefined && early !== undefined) run.completions.set(turnId, early)
    return Promise.resolve({ turn: { id: turnId } })
  }

  /** Pauses an active goal (the TUI does when the user interrupts), so that the app-server does not start the next turn of it. */
  private async pauseGoal(reason: string): Promise<void> {
    const threadId = this.threadId
    if (threadId === undefined || !this.goalActive() || this.closed) return
    try {
      const response = await this.request('thread/goal/set', { threadId, status: 'paused', origin: 'user' }, SIDE_CLEANUP_TIMEOUT_MS)
      this.applyGoal(parseGoal(asRecord(response)?.['goal']) ?? this.goal)
      this.log(`codex: paused the goal (${reason})`)
    } catch (error: unknown) {
      this.log(`codex: could not pause the goal (${reason}): ${messageOf(error)}`)
    }
  }

  // -- rewind -------------------------------------------------------------------------

  /** Whether Codex is working, or this transport is replacing the conversation: a `thread/revert` would cut a running turn off. */
  private conversationBusy(): boolean {
    return this.busy || this.run !== undefined || this.switching || this.serverTurns.size > 0
  }

  /** The directories of the session: the only places a restore of files may touch. */
  private sessionRoots(): string[] {
    return [this.requireCwd(), ...(this.attached?.runtimeWorkspaceRoots ?? [])]
  }

  /** The turns of the thread, page by page: all of them oldest first, or (`until`) newest first down to that turn. */
  private async readTurns(threadId: string, view: 'summary' | 'full', direction: 'asc' | 'desc', until?: string): Promise<CodexTurn[]> {
    const turns: CodexTurn[] = []
    const seen = new Set<string>()
    let cursor: string | null = null
    for (let page = 0; page < MAX_TURN_PAGES; page += 1) {
      const response: unknown = await this.request(
        'thread/turns/list',
        { threadId, cursor, limit: view === 'full' ? FULL_TURN_PAGE_LIMIT : TURN_PAGE_LIMIT, sortDirection: direction, itemsView: view },
        REQUEST_TIMEOUT_MS,
      )
      const parsed = parseTurnPage(response)
      for (const turn of parsed.turns) {
        turns.push(turn)
        if (turn.id === until) return turns
      }
      if (parsed.nextCursor === undefined || seen.has(parsed.nextCursor)) break
      seen.add(parsed.nextCursor)
      cursor = parsed.nextCursor
    }
    return turns
  }

  /** What undoing the file changes the agent made since `checkpoint` would do to the files on disk. */
  private async restorePlan(threadId: string, checkpoint: CodexCheckpoint): Promise<RestorePlan> {
    const newestFirst = await this.readTurns(threadId, 'full', 'desc', checkpoint.turnId)
    if (newestFirst.at(-1)?.id !== checkpoint.turnId) throw new NativeTransportError('that message is no longer in the conversation', 'not-found')
    const { changes, unsupported } = fileChangesOf(newestFirst.toReversed())
    return await planRestore(changes, nodeRestoreIo(this.sessionRoots()), unsupported)
  }

  /**
   * `/rewind`: list the user's messages, preview going back to just before one (the conversation Codex would forget, the files that
   * would be restored and those that cannot be), or do it. The conversation goes back with `thread/revert`; the files, which Codex does
   * not checkpoint, are restored first from the file changes the agent recorded. Nothing is cached: the turns are read from the app-server
   * each time, so the list is the same after a restart.
   */
  private async rewindCommand(args: string, signal: AbortSignal): Promise<NativeCommandResult> {
    const request = parseRewindArgs(args)
    if (request.action === 'usage') return { kind: 'error', text: `${request.problem}\n\nUsage: /rewind [<n> [code|chat] [confirm]]` }
    const threadId = this.requireThreadId()
    const checkpoints = checkpointsOf(await this.readTurns(threadId, 'summary', 'asc'))
    if (request.action === 'list') return { kind: 'success', text: renderCheckpoints(checkpoints) }
    const found = findCheckpoint(checkpoints, request.reference)
    if ('error' in found) return { kind: 'error', text: found.error }
    const cwd = this.requireCwd()
    const point = {
      checkpoint: found.checkpoint,
      position: found.position,
      total: checkpoints.length,
      mode: request.mode,
      display: (path: string): string => shownPath(cwd, path),
    }
    if (request.action === 'preview') {
      const plan = request.mode === 'chat' ? undefined : await this.restorePlan(threadId, found.checkpoint)
      return { kind: 'success', text: renderRewindPreview({ ...point, plan }) }
    }
    if (this.conversationBusy()) return { kind: 'error', text: 'Wait for the current turn to finish before rewinding: Codex is working right now.' }
    signal.throwIfAborted()
    // No prompt may start while the files and the conversation are going back.
    this.switching = true
    try {
      const plan = request.mode === 'chat' ? undefined : await this.restorePlan(threadId, found.checkpoint)
      const restore = plan === undefined ? undefined : await applyRestore(plan, nodeRestoreIo(this.sessionRoots()))
      let rolledBack = false
      let rollbackError: string | undefined
      if (request.mode !== 'code') {
        try {
          await this.request('thread/revert', { threadId, beforeTurnId: found.checkpoint.turnId }, SESSION_REQUEST_TIMEOUT_MS)
          rolledBack = true
          // The thread keeps its id, but what the vendor holds is no longer what DSH logged.
          this.emit({ kind: 'session_changed', sessionId: threadId, reason: 'rewind' })
        } catch (error: unknown) {
          if (this.closed) throw error
          rollbackError = messageOf(error)
        }
      }
      return {
        kind: rollbackError === undefined ? 'success' : 'error',
        text: renderRewindResult({ ...point, plan, restore, rolledBack, rollbackError }),
      }
    } finally {
      this.switching = false
    }
  }

  // -- immediate commands -------------------------------------------------------------

  /** `NativeTransport.runCommand`: an immediate command; it may run while a prompt runs and emits no turn updates. */
  async runCommand(name: string, args: string, signal: AbortSignal): Promise<NativeCommandResult> {
    this.requireUsable()
    const command = canonicalCodexCommand(name) ?? name.toLowerCase()
    try {
      signal.throwIfAborted()
      switch (command) {
        case 'status':
          return await this.statusCommand()
        case 'skills':
          return await this.skillsCommand(args)
        case 'mcp':
          return await mcpCommand(this.rpc, this.requireThreadId(), args)
        case 'ps':
          return await psCommand(this.rpc, this.requireThreadId())
        case 'stop':
          return await stopCommand(this.rpc, this.requireThreadId(), args)
        case 'hooks':
          return await hooksCommand(this.rpc, this.requireCwd())
        case 'diff':
          return await diffCommand(this.rpc, this.requireCwd(), signal)
        case 'rewind':
          return await this.rewindCommand(args, signal)
        case 'new':
        case 'clear':
          return await this.startFreshThread(command, args.trim())
        default:
          return { kind: 'error', text: `\`/${name}\` is not an immediate Codex command.` }
      }
    } catch (error: unknown) {
      // A lost process is the runtime's to handle; anything else is an answer for the user.
      if (this.closed) throw error
      if (signal.aborted) return { kind: 'error', text: 'The command was cancelled.' }
      return { kind: 'error', text: `\`/${command}\` failed: ${messageOf(error)}` }
    }
  }

  /** `/status`: the TUI's card where the data exists (limits and thread usage only for a ChatGPT account). */
  private async statusCommand(): Promise<NativeCommandResult> {
    const state = this.requireState()
    const threadId = this.requireThreadId()
    const cwd = this.requireCwd()
    const [tokenUsage, contextWindow] = this.requireTokens().statusLines()
    const [limits, threadUsage] = this.chatgptAccount ? await Promise.all([this.rateLimitLines(), this.threadUsageLine(threadId)]) : [[], undefined]
    const sources = (this.attached?.instructionSources ?? []).map((path) => shownPath(cwd, path))
    const provider = this.attached?.modelProvider ?? this.launch?.modelProvider
    const forkedFrom = this.attached?.forkedFromId
    const settings = state.mode.settings
    const lines = [
      `**Model:** ${state.modelId} (reasoning ${state.effort}, summaries ${this.summaryDisabled || state.modelLacksReasoning ? 'off' : 'auto'})`,
      ...(provider === undefined ? [] : [`**Model provider:** ${provider}`]),
      `**Directory:** ${cwd}`,
      `**Permissions:** ${state.mode.name} (approval ${settings.approvalPolicy}, sandbox ${settings.sandboxMode})`,
      `**Agents.md:** ${sources.length === 0 ? '<none>' : sources.join(', ')}`,
      `**Account:** ${this.accountText}`,
      ...(this.threadName === undefined ? [] : [`**Thread name:** ${this.threadName}`]),
      `**Collaboration mode:** ${state.collaborationMode}`,
      ...(this.goal === undefined ? [] : [`**Goal:** ${goalStatusLabel(this.goal.status)} — ${truncate(this.goal.objective.replace(/\s+/g, ' ').trim(), 120)}`]),
      `**Session:** \`${threadId}\``,
      ...(forkedFrom === undefined ? [] : [`**Forked from:** \`${forkedFrom}\``]),
      '',
      `**Token usage:** ${tokenUsage}`,
      `**Context window:** ${contextWindow}`,
      `**Limits:** ${limits.length === 0 ? 'data not available yet' : limits.join(' · ')}`,
      ...(threadUsage === undefined ? [] : [`**Thread usage:** ${threadUsage}`]),
    ]
    return { kind: 'success', text: lines.join('  \n') }
  }

  /** The optional lookups of `/status` never fail the card: what cannot be read is left out. */
  private async rateLimitLines(): Promise<string[]> {
    try {
      const response = await this.request(
        'account/rateLimits/read',
        { supportsLunaReserve: true, excludeResetCreditDetails: false },
        STATUS_LOOKUP_TIMEOUT_MS,
      )
      return formatRateLimits(response)
    } catch (error: unknown) {
      if (this.closed) throw error
      this.log(`codex: account/rateLimits/read failed: ${messageOf(error)}`)
      return []
    }
  }

  private async threadUsageLine(threadId: string): Promise<string | undefined> {
    try {
      return formatThreadUsage(await this.request('account/usage/read', { threadId }, STATUS_LOOKUP_TIMEOUT_MS))
    } catch (error: unknown) {
      if (this.closed) throw error
      this.log(`codex: account/usage/read failed: ${messageOf(error)}`)
      return undefined
    }
  }

  /** `/skills` lists them (re-reading the disk, as the TUI does); `/skills enable|disable <name>` toggles one. */
  private async skillsCommand(args: string): Promise<NativeCommandResult> {
    const [verb, ...nameWords] = args.split(/\s+/).filter((word) => word !== '')
    if (verb === undefined) {
      const { skills, errors } = await this.loadSkills(true)
      return { kind: 'success', text: formatSkills(skills, errors) }
    }
    const name = nameWords.join(' ')
    if ((verb !== 'enable' && verb !== 'disable') || name === '') {
      return { kind: 'error', text: 'Usage: /skills [enable|disable <name>]' }
    }
    const { skills } = await this.loadSkills(true)
    const exact = skills.filter((skill) => skill.name === name)
    const named = exact.length > 0 ? exact : skills.filter((skill) => skill.name.toLowerCase() === name.toLowerCase())
    const [skill] = named
    if (skill === undefined) return { kind: 'error', text: `No skill is named \`${name}\`. \`/skills\` lists them.` }
    if (named.length > 1) {
      return { kind: 'error', text: `More than one skill is named \`${name}\`; toggle it in the Codex terminal (\`/skills\`).` }
    }
    const enabled = verb === 'enable'
    const response = await this.request('skills/config/write', { path: skill.path, enabled }, SKILLS_WRITE_TIMEOUT_MS)
    const reported = asRecord(response)?.['effectiveEnabled']
    const effective = typeof reported === 'boolean' ? reported : enabled
    // The catalog follows the toggle.
    await this.loadSkills(true)
    if (effective !== enabled) {
      return {
        kind: 'error',
        text: `Skill \`${skill.name}\` stays ${effective ? 'enabled' : 'disabled'}: the Codex configuration overrides the request.`,
      }
    }
    return { kind: 'success', text: `Skill \`${skill.name}\` ${enabled ? 'enabled' : 'disabled'}.` }
  }

  /**
   * `/new` and `/clear`: a fresh thread with this conversation's settings replaces the current one (which stays in the
   * Codex history). Only between turns: a running turn, a side question or an earlier switch refuses it.
   */
  private async startFreshThread(reason: 'new' | 'clear', name: string): Promise<NativeCommandResult> {
    if (this.conversationBusy() || this.sideRun !== undefined) {
      return { kind: 'error', text: `'/${reason}' is disabled while a task is in progress.` }
    }
    const launch = this.launch
    const state = this.requireState()
    const cwd = this.requireCwd()
    const previous = this.requireThreadId()
    if (launch === undefined) throw new NativeTransportError('Codex transport was not started', 'not-started')
    this.switching = true
    try {
      const attachment = parseThreadAttachment(
        await this.request(
          'thread/start',
          {
            config: threadSessionConfig(launch.baseConfig, cwd),
            modelProvider: launch.modelProvider ?? null,
            cwd,
            ...(reason === 'clear' ? { sessionStartSource: 'clear' } : {}),
          },
          SESSION_REQUEST_TIMEOUT_MS,
        ),
      )
      this.adoptThread(attachment)
      await this.carryOverSettings(state)
      if (name !== '') {
        try {
          await this.request('thread/name/set', { threadId: attachment.threadId, name }, REQUEST_TIMEOUT_MS)
          this.threadName = name
        } catch (error: unknown) {
          this.log(`codex: thread/name/set failed: ${messageOf(error)}`)
        }
      }
      this.emit({ kind: 'session_changed', sessionId: attachment.threadId, reason })
      // The old thread stays in the Codex history; the app-server just stops keeping it loaded.
      void this.request('thread/unsubscribe', { threadId: previous }, SIDE_CLEANUP_TIMEOUT_MS).catch((error: unknown) => {
        this.log(`codex: thread/unsubscribe of the previous thread failed: ${messageOf(error)}`)
      })
      return {
        kind: 'success',
        text: `Started a new Codex conversation (\`${attachment.threadId}\`). The previous one stays in the Codex history.`,
      }
    } finally {
      this.switching = false
    }
  }

  /** The new thread is the session from now on: its projection, accounting, goal and sub-agents start over. */
  private adoptThread(attachment: ThreadAttachment): void {
    this.threadId = attachment.threadId
    this.attached = attachment
    this.threadName = attachment.threadName
    this.goal = undefined
    this.orphanCompletions.clear()
    this.subAgentThreads.clear()
    this.openToolCalls.clear()
    this.tokens = new CodexTokenAccounting(false)
    this.projection = new CodexProjection(this.sink, this.tokens)
    // The context of a fresh thread is empty; the meter must not keep showing the old one.
    const size = this.lastContextUsage?.size
    this.lastContextUsage = undefined
    if (size !== undefined) this.sink.contextUsage({ used: 0, size })
  }

  /**
   * A fresh thread starts with the server's defaults. The turns of this conversation carry their own model, effort and
   * mode, but `/review` and `/compact` do not, so the new thread gets the controls' values and the collaboration mode too.
   */
  private async carryOverSettings(state: CodexControlsState): Promise<void> {
    const settings = state.mode.settings
    await this.updateThread({
      approvalPolicy: settings.approvalPolicy,
      approvalsReviewer: settings.approvalsReviewer,
      sandboxPolicy: settings.sandboxPolicy,
      model: state.modelId,
      effort: state.effort,
      serviceTier: state.serviceTier,
    }).catch((error: unknown) => {
      if (this.closed) throw error
      this.log(`codex: thread/settings/update for the new thread failed: ${messageOf(error)}`)
    })
    if (state.collaborationMode === 'default') return
    try {
      await this.applyCollaborationMode(state.collaborationMode)
    } catch (error: unknown) {
      if (this.closed) throw error
      // The control must not claim a mode the thread does not have.
      this.log(`codex: the new thread did not take the ${state.collaborationMode} collaboration mode: ${messageOf(error)}`)
      state.collaborationMode = 'default'
      this.emit({ kind: 'controls', controls: state.snapshot() })
    }
  }

  // -- side questions -----------------------------------------------------------------

  /**
   * `NativeTransport.sideQuestion` (`/side` = `/btw`), as the TUI asks it: an ephemeral fork of the thread
   * (`thread/fork`), a hidden boundary message (`thread/inject_items`), the question as a turn of the fork, and
   * `thread/unsubscribe` once it answered. It runs beside the main turn, never touches the main thread, and
   * declines whatever the fork asks approval for.
   */
  async sideQuestion(question: string, signal: AbortSignal): Promise<NativeCommandResult> {
    this.requireUsable()
    const text = question.trim()
    if (text === '') return { kind: 'error', text: SIDE_USAGE_MESSAGE }
    if (this.sideRun !== undefined) return { kind: 'error', text: SIDE_ALREADY_RUNNING_MESSAGE }
    if (this.run?.kind === 'review') return { kind: 'error', text: SIDE_REVIEW_RUNNING_MESSAGE }
    if (this.switching) return { kind: 'error', text: 'The Codex conversation is being changed. Ask again in a moment.' }
    if (signal.aborted) return SIDE_CANCELLED
    const run = new CodexSideRun()
    this.sideRun = run
    try {
      return await this.askSide(run, text, signal)
    } catch (error: unknown) {
      // A lost process is the runtime's to handle; anything else is an answer for the user.
      if (this.closed) throw error
      return { kind: 'error', text: `The side question failed: ${messageOf(error)}` }
    } finally {
      await this.endSide(run)
    }
  }

  private async askSide(run: CodexSideRun, question: string, signal: AbortSignal): Promise<NativeCommandResult> {
    let forked: unknown
    try {
      forked = await this.request('thread/fork', await this.sideForkParams(), SESSION_REQUEST_TIMEOUT_MS)
    } catch (error: unknown) {
      if (this.closed) throw error
      return { kind: 'error', text: sideStartFailure(error) }
    }
    const threadId = readString(asRecord(asRecord(forked)?.['thread']), 'id')
    if (threadId === undefined) return { kind: 'error', text: 'Failed to start side conversation: Codex did not return a thread.' }
    // From here on every notification and request of that thread belongs to the run.
    run.threadId = threadId
    try {
      await this.request('thread/inject_items', { threadId, items: [SIDE_BOUNDARY_ITEM] }, REQUEST_TIMEOUT_MS)
    } catch (error: unknown) {
      if (this.closed) throw error
      return { kind: 'error', text: `Failed to prepare side conversation ${threadId}: ${messageOf(error)}` }
    }
    if (signal.aborted) return SIDE_CANCELLED
    try {
      const started = await this.startTurn(threadId, codexUserInput([{ type: 'text', text: question }]), {
        clientUserMessageId: `dsh-side-${randomUUID()}`,
      })
      const turnId = readString(asRecord(asRecord(started)?.['turn']), 'id')
      if (turnId !== undefined) run.identify(turnId)
    } catch (error: unknown) {
      if (this.closed) throw error
      return { kind: 'error', text: `The side question could not be started: ${messageOf(error)}` }
    }
    switch (await this.waitForSide(run, signal)) {
      case 'completed':
        return sideCommandResult(run.outcome())
      case 'aborted':
        return SIDE_CANCELLED
      case 'timeout':
        return { kind: 'error', text: 'The side question took too long and was stopped.' }
    }
  }

  private async waitForSide(run: CodexSideRun, signal: AbortSignal): Promise<'completed' | 'aborted' | 'timeout'> {
    const { promise: interrupted, resolve } = Promise.withResolvers<'aborted' | 'timeout'>()
    const onAbort = (): void => {
      resolve('aborted')
    }
    signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      resolve('timeout')
    }, SIDE_RUN_TIMEOUT_MS)
    timer.unref()
    try {
      return await Promise.race([run.done.then(() => 'completed' as const), interrupted])
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }

  /** The fork is closed the way the TUI closes one: interrupt what still runs, then unsubscribe. */
  private async endSide(run: CodexSideRun): Promise<void> {
    try {
      const threadId = run.threadId
      if (threadId === undefined || this.closed) return
      if (!run.completed) {
        await this.request('turn/interrupt', { threadId, turnId: run.turnId ?? '' }, SIDE_CLEANUP_TIMEOUT_MS).catch((error: unknown) => {
          this.log(`codex: turn/interrupt of the side conversation failed: ${messageOf(error)}`)
        })
      }
      await this.request('thread/unsubscribe', { threadId }, SIDE_CLEANUP_TIMEOUT_MS).catch((error: unknown) => {
        this.log(`codex: thread/unsubscribe of the side conversation failed: ${messageOf(error)}`)
      })
    } finally {
      if (this.sideRun === run) this.sideRun = undefined
    }
  }

  /**
   * `thread/fork` of a side question (the TUI's `side_fork_config`): ephemeral, the parent's model, tier, permissions
   * and directory, and the thread's own developer instructions followed by the side conversation's.
   */
  private async sideForkParams(): Promise<JsonRecord> {
    const state = this.requireState()
    const launch = this.launch
    const cwd = this.requireCwd()
    const existing = await this.existingInstructions()
    const provider = this.attached?.modelProvider ?? launch?.modelProvider
    return {
      threadId: this.requireThreadId(),
      ephemeral: true,
      excludeTurns: true,
      model: state.modelId,
      ...(provider === undefined ? {} : { modelProvider: provider }),
      ...(state.serviceTier === null ? {} : { serviceTier: state.serviceTier }),
      cwd,
      approvalPolicy: state.mode.settings.approvalPolicy,
      approvalsReviewer: state.mode.settings.approvalsReviewer,
      sandbox: state.mode.settings.sandboxMode,
      config: threadSessionConfig(launch?.baseConfig ?? {}, cwd),
      developerInstructions: existing === null ? SIDE_DEVELOPER_INSTRUCTIONS : `${existing}\n\n${SIDE_DEVELOPER_INSTRUCTIONS}`,
      threadSource: 'user',
    }
  }

  /** The `developer_instructions` of the Codex configuration (`CODEX_CONFIG`, else `config/read`), or `null`. */
  private async existingInstructions(): Promise<string | null> {
    const configured = this.launch?.baseConfig['developer_instructions']
    if (typeof configured === 'string' && configured.trim() !== '') return configured
    try {
      const response = await this.request('config/read', { includeLayers: false, cwd: this.requireCwd() }, REQUEST_TIMEOUT_MS)
      const text = readString(asRecord(asRecord(response)?.['config']), 'developer_instructions')
      return text === undefined || text.trim() === '' ? null : text
    } catch (error: unknown) {
      if (this.closed) throw error
      this.log(`codex: config/read failed (${messageOf(error)}); the side conversation starts without the configured instructions`)
      return null
    }
  }

  // -- catalog ------------------------------------------------------------------------

  private publishCommands(): void {
    if (this.closed) return
    // The built-ins are known at once; the skills follow when `skills/list` answered.
    this.announceCommands()
    void this.refreshSkills(false)
  }

  /** Tell the host about the catalog when it differs from what it was told last. */
  private announceCommands(): void {
    const key = JSON.stringify(this.commandList)
    if (this.closed || key === this.announcedCommands) return
    this.announcedCommands = key
    this.emit({ kind: 'commands', commands: this.commandList })
  }

  /** `skills/list`, remembered; the catalog follows. Throws when the request fails. */
  private async loadSkills(forceReload: boolean): Promise<{ readonly skills: CodexSkill[]; readonly errors: string[] }> {
    const loaded = await fetchSkills(this.rpc, this.requireCwd(), forceReload)
    this.skills = loaded.skills
    this.rebuildCommands()
    return loaded
  }

  /** `loadSkills` for the places that can do without: a failure is logged and leaves the catalog as it was. */
  private async refreshSkills(forceReload: boolean): Promise<void> {
    try {
      await this.loadSkills(forceReload)
    } catch (error: unknown) {
      this.log(`codex: skills/list failed: ${messageOf(error)}`)
      this.skills ??= []
    }
  }

  /** The enabled skills whose name can be typed as `/name` join the built-ins as prompt commands. */
  private rebuildCommands(): void {
    const seen = new Set<string>()
    const skillCommands: NativeCommand[] = []
    for (const skill of this.skills ?? []) {
      const key = skill.name.toLowerCase()
      // A skill named like a built-in or a TUI command cannot be typed as `/name` (`$name` still reaches it).
      const typeable = /^\S+$/.test(skill.name) && canonicalCodexCommand(key) === undefined && !isUnsupportedCodexCommand(key)
      if (!skill.enabled || !typeable || seen.has(key)) continue
      seen.add(key)
      skillCommands.push({
        name: skill.name,
        description: skill.description === '' ? `Run the ${skill.name} skill` : truncate(skill.description, 200),
        hint: '[request]',
        dispatch: 'prompt',
      })
    }
    this.commandList = [...CODEX_NATIVE_COMMANDS, ...skillCommands]
    this.announceCommands()
  }

  /** The enabled skill a slash command line names; the skills are read once if nobody did yet. */
  private async skillNamed(name: string): Promise<CodexSkill | undefined> {
    if (this.skills === undefined) await this.refreshSkills(false)
    const lower = name.toLowerCase()
    return this.skills?.find((skill) => skill.enabled && skill.name.toLowerCase() === lower)
  }

  // -- guards ---------------------------------------------------------------------------

  /** Commands, prompts and side questions need a running app-server with an attached thread. */
  private requireUsable(): void {
    if (this.closing) throw new NativeTransportError('Codex transport is closed', 'closed')
    if (this.exitError !== undefined) throw this.exitError
    if (this.threadId === undefined || this.controlsState === undefined) {
      throw new NativeTransportError('Codex transport was not started', 'not-started')
    }
  }

  private requireThreadId(): string {
    if (this.threadId === undefined) throw new NativeTransportError('Codex transport was not started', 'not-started')
    return this.threadId
  }

  private requireCwd(): string {
    const cwd = this.options?.cwd
    if (cwd === undefined) throw new NativeTransportError('Codex transport was not started', 'not-started')
    return cwd
  }

  // -- steering ---------------------------------------------------------------------

  /**
   * Text steered into the running turn is injected as typed, a slash line or a `!cmd` included: the commands DSH
   * registers that run as an immediate command or a side question never reach this path, and answering `promptRequired`
   * would make the host interrupt the user's running turn to prompt the line again. The one exception is `/goal`, which
   * DSH forwards like a message: typed into a running turn it controls the goal right away.
   */
  async steer(content: readonly NativeContentBlock[], signal?: AbortSignal): Promise<'injected' | 'promptRequired'> {
    if (this.closing || this.exitError !== undefined || signal?.aborted === true) return 'promptRequired'
    const state = this.controlsState
    const threadId = this.threadId
    const run = this.run
    if (state === undefined || threadId === undefined || run === undefined || content.length === 0) return 'promptRequired'
    const goalArgs = goalLineArgs(content)
    if (goalArgs !== undefined) return await this.steerGoal(goalArgs, threadId)
    if (!state.imageInput && content.some((block) => block.type === 'image')) return 'promptRequired'
    // The steer target must be the turn that is running; a turn still being started reveals its id shortly.
    const initialTurnId = run.turnId ?? (await withTimeout(run.identified.promise, TURN_ID_WAIT_MS, undefined))
    if (initialTurnId === undefined) return 'promptRequired'
    const input = codexUserInput(content)
    const steerWith = (turnId: string): Promise<unknown> =>
      this.request(
        'turn/steer',
        { threadId, expectedTurnId: turnId, input, clientUserMessageId: `dsh-steer-${randomUUID()}` },
        REQUEST_TIMEOUT_MS,
      )
    try {
      const response = await steerWith(initialTurnId)
      const acknowledged = readString(asRecord(response), 'turnId')
      if (acknowledged !== undefined && acknowledged !== initialTurnId) {
        throw new NativeTransportError('codex app-server acknowledged turn/steer for a different turn', 'protocol-error')
      }
      return 'injected'
    } catch (error: unknown) {
      if (!isDefinitiveSteerRejection(error)) throw error
      // A newer turn may have started while the request was in flight: retry once against it.
      const refreshed = this.run?.turnId
      if (refreshed === undefined || refreshed === initialTurnId) return 'promptRequired'
      try {
        await steerWith(refreshed)
        return 'injected'
      } catch (retryError: unknown) {
        if (isDefinitiveSteerRejection(retryError)) return 'promptRequired'
        throw retryError
      }
    }
  }

  // -- shutdown ---------------------------------------------------------------------

  close(): Promise<void> {
    if (this.closePromise === undefined) this.closePromise = this.closeInternal()
    return this.closePromise
  }

  private async closeInternal(): Promise<void> {
    this.closing = true
    const closed = new NativeTransportError('Codex transport closed', 'closed')
    this.rejectPending(closed)
    this.abortServerRequests()
    const run = this.run
    if (run !== undefined) this.failRun(run, closed)
    this.sideRun?.fail(closed)
    for (const timer of this.serverTurns.values()) clearTimeout(timer)
    this.serverTurns.clear()
    this.wakeServerTurnWaiter()
    const child = this.child
    if (child === undefined) return
    const exited = child.exited.then(
      () => true,
      () => true,
    )
    try {
      child.stdin.end()
    } catch {
      // The pipe may already be gone.
    }
    // Graceful first: the app-server exits when its stdin ends. The terminate that follows is
    // idempotent and also reaps what the app-server left behind (shell children, MCP servers).
    if (!(await withTimeout(exited, CLOSE_GRACE_MS, false))) {
      this.log('codex: app-server did not exit after stdin closed; terminating it')
    }
    child.terminate()
    await withTimeout(exited, CLOSE_TERMINATE_MS, false)
    this.lines?.close()
    this.lines = undefined
  }
}

/** Create one Codex transport. See the module comment for the protocol surface. */
export function createCodexTransport(): NativeTransport {
  return new CodexAppServerTransport()
}
