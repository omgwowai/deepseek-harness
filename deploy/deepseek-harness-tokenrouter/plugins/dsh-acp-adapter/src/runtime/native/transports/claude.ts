/// <reference types="node" />
/**
 * Claude Code native transport: the `claude` CLI speaking stream-json, reporting what
 * `@agentclientprotocol/claude-agent-acp` reports for the same session (ids, controls, tool calls,
 * usage), so state DSH saved under the ACP route stays valid.
 *
 * Verified against Claude Code 2.1.296. Wire facts this file relies on (all measured):
 *
 *  - `-p --input-format stream-json --output-format stream-json` keeps the process alive across
 *    turns; one `result` frame settles one turn (prompt plus any steers folded into it).
 *  - A control `initialize` request is answered before any user message, with the model catalog,
 *    slash commands, agents and fast-mode state. `system/init` only appears with the first message.
 *  - `--session-id <uuid>` names a new session up front; `--resume <id>` continues one;
 *    `--resume <id> --fork-session --session-id <uuid>` forks. The CLI restores neither the
 *    permission mode nor the model on resume, so both are re-established here the way
 *    claude-agent-acp does (transcript tail, then `set_permission_mode` / `set_model`).
 *  - An unknown resume id makes the CLI print `No conversation found with session ID` and exit 1.
 *  - `priority:"next"` on a user message folds it into the running turn at the next tool boundary;
 *    `interrupt` answers with `{still_queued, cancelled}` (see `interrupt()`).
 *  - `result.modelUsage` is cumulative per model (continuing from the transcript's `cost-state`
 *    after a resume); turn usage is the difference between two readings.
 */
import { randomUUID } from 'node:crypto'
import { access, open, readdir, type FileHandle } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createInterface, type Interface } from 'node:readline'
import type { Readable } from 'node:stream'
import type * as acp from '@agentclientprotocol/sdk'

import {
  AGENT_CONFIG_ID,
  AUTO_MODE_FALLBACK,
  DEFAULT_AGENT_ID,
  DEFAULT_MODEL_ID,
  EFFORT_CONFIG_ID,
  FAST_MODE_CONFIG_ID,
  MODEL_CONFIG_ID,
  MODE_CONFIG_ID,
  applyAvailableModelsAllowlist,
  buildClaudeAvailableModes,
  buildClaudeConfigOptions,
  chooseInitialModel,
  discoverCustomAgents,
  effortFlagSettings,
  fastModeStateEnabled,
  isPreModelSwitchHookBlock,
  isRecord,
  matchResumedModel,
  normalizeFastModeDisabledReason,
  parseClaudeModelInfos,
  parseSelectableMode,
  resolveFastModeEnabled,
  resolveInitialPermissionMode,
  resolveModelPreference,
  selectValues,
  settingsEffortForModel,
  withCurrentValue,
  withLiveModelInfo,
  type ClaudeAgentInfo,
  type ClaudeModelInfo,
  type ClaudeModelState,
  type ClaudePermissionMode,
  type ClaudeSettingsView,
} from './claude-controls.ts'
import { prepareClaudePermission } from './claude-permissions.ts'
import {
  ClaudeFrameMapper,
  modelUsageIncrement,
  normalizeModelUsage,
  updateEvent,
  type ModelUsageRow,
} from './claude-projection.ts'
import {
  NativeTransportError,
  type NativeContentBlock,
  type NativeContextUsage,
  type NativeControls,
  type NativePermissionDecision,
  type NativePermissionRequest,
  type NativeProcess,
  type NativePromptResult,
  type NativeTransport,
  type NativeTransportEvent,
  type NativeTransportKind,
  type NativeTransportStartOptions,
  type NativeTurnUsage,
} from './contract.ts'

type Json = Record<string, unknown>

const INITIALIZE_TIMEOUT_MS = 60_000
const CONTROL_TIMEOUT_MS = 15_000
const SETTINGS_TIMEOUT_MS = 10_000
const INTERRUPT_TIMEOUT_MS = 15_000
/** If the CLI drops the interrupted turn's `result`, keep the host from hanging. */
const INTERRUPT_SETTLE_FALLBACK_MS = 10_000
const CLOSE_STDIN_GRACE_MS = 1_500
const CLOSE_TERMINATE_GRACE_MS = 4_000
const STDERR_LIMIT = 8_192
const DETAIL_LIMIT = 2_000
const TAIL_CHUNK_BYTES = 64 * 1024
const ESCALATING_MODES: Readonly<Record<string, true>> = { bypassPermissions: true, auto: true, acceptEdits: true }
const NOT_FOUND_PATTERN = /No conversation found with session ID/i

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const truncate = (value: string, limit: number): string => (value.length <= limit ? value : `${value.slice(0, limit)}…`)

/**
 * Sessions this host process created and has not prompted yet, with the conversation a fork was
 * made from. Claude Code writes a conversation at its first prompt, so such a session cannot be
 * resumed; like claude-agent-acp's `recreateLiveSession`, it restarts under the same id instead
 * of becoming "not found" (a fork is forked from its parent again, a new session starts empty).
 */
const unpromptedSessions = new Map<string, { readonly parentSessionId: string | undefined }>()

/** Context windows the CLI reported, by resolved model id, so a later switch starts from the truth. */
const learnedContextWindows = new Map<string, number>()

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
}

function deferred<T>(): Deferred<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  const { promise: timedOut, resolve } = Promise.withResolvers<T>()
  const timer = setTimeout(() => resolve(fallback), timeoutMs)
  timer.unref()
  try {
    return await Promise.race([promise, timedOut])
  } finally {
    clearTimeout(timer)
  }
}

/** Wait until a stream delivered its last data (or `timeoutMs` passed): a dying process's final words arrive after its exit. */
async function streamEnded(stream: Readable, timeoutMs: number): Promise<void> {
  if (stream.readableEnded || stream.destroyed) return
  const { promise, resolve } = Promise.withResolvers<void>()
  stream.once('end', resolve)
  stream.once('close', resolve)
  await withTimeout(promise, timeoutMs, undefined)
}

// ---------------------------------------------------------------------------
// Pure protocol helpers (exported for the test suite)
// ---------------------------------------------------------------------------

export type ClaudeLaunchKind = 'new' | 'resume' | 'fork' | 'fresh'

export interface ClaudeArgvInput {
  /** Launcher argv: the executable first, then any launcher arguments. */
  readonly launcher: readonly string[]
  readonly kind: ClaudeLaunchKind
  /** The session id this process runs under (the new id for `new`/`fork`/`fresh`). */
  readonly sessionId: string
  /** The parent conversation of a `fork`. */
  readonly parentSessionId?: string | undefined
  readonly permissionMode: ClaudePermissionMode
  readonly allowBypass: boolean
}

/**
 * The CLI argv: the launcher, then the stream-json protocol flags and the flags
 * claude-agent-acp's SDK passes (setting sources, permission routing, partial messages).
 * AskUserQuestion is disabled because this transport has no form to put it in.
 */
export function buildClaudeArgv(input: ClaudeArgvInput): string[] {
  const argv = [
    ...input.launcher,
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-prompt-tool=stdio',
    '--setting-sources',
    'user,project,local',
    '--permission-mode',
    input.permissionMode,
    '--disallowedTools=AskUserQuestion',
  ]
  if (input.allowBypass) argv.push('--allow-dangerously-skip-permissions')
  switch (input.kind) {
    case 'resume':
      argv.push('--resume', input.sessionId)
      break
    case 'fork':
      argv.push('--resume', input.parentSessionId ?? '', '--fork-session', '--session-id', input.sessionId)
      break
    case 'new':
    case 'fresh':
      argv.push('--session-id', input.sessionId)
      break
  }
  return argv
}

/** One stdin line: the CLI's stream-json user message, stamped as the user's own input. */
export function claudeUserMessageFrame(input: {
  readonly blocks: readonly NativeContentBlock[]
  readonly sessionId: string
  readonly priority?: 'now' | 'next' | 'later' | undefined
  readonly uuid?: string | undefined
}): Json {
  const content = input.blocks.map((block) =>
    block.type === 'text'
      ? { type: 'text', text: block.text }
      : { type: 'image', source: { type: 'base64', media_type: block.mimeType, data: block.data } },
  )
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    session_id: input.sessionId,
    uuid: input.uuid ?? randomUUID(),
    origin: { kind: 'human' },
    ...(input.priority === undefined ? {} : { priority: input.priority }),
  }
}

/** How a `result` frame ends the turn: a stop reason, or the vendor error text the turn failed with. */
export type ClaudeTurnOutcome =
  | { readonly stopReason: NativePromptResult['stopReason'] }
  | { readonly error: string }

/** Port of claude-agent-acp's result switch. */
export function claudeTurnOutcome(frame: Json, interrupted: boolean): ClaudeTurnOutcome {
  if (interrupted) return { stopReason: 'cancelled' }
  const errors = Array.isArray(frame['errors']) ? frame['errors'].filter((entry): entry is string => typeof entry === 'string') : []
  const subtype = text(frame['subtype'])
  const isError = frame['is_error'] === true
  const failure = (): ClaudeTurnOutcome => ({
    error: (subtype === 'success' ? text(frame['result']) : undefined) || errors.join(', ') || subtype || 'Claude Code turn failed',
  })
  if (frame['stop_reason'] === 'refusal') return { stopReason: 'refusal' }
  switch (subtype) {
    case 'success':
      if (frame['stop_reason'] === 'max_tokens') return { stopReason: 'max_tokens' }
      return isError ? failure() : { stopReason: 'end_turn' }
    case 'error_during_execution':
      if (frame['stop_reason'] === 'max_tokens') return { stopReason: 'max_tokens' }
      return isError ? failure() : { stopReason: 'end_turn' }
    case 'error_max_budget_usd':
    case 'error_max_turns':
    case 'error_max_structured_output_retries':
      return isError ? failure() : { stopReason: 'max_turn_requests' }
    default:
      return failure()
  }
}

/** Absolute path of the Claude configuration directory. */
export function claudeConfigDir(env: Readonly<Record<string, string | undefined>>): string {
  return env['CLAUDE_CONFIG_DIR'] ?? process.env['CLAUDE_CONFIG_DIR'] ?? path.join(os.homedir(), '.claude')
}

// ---------------------------------------------------------------------------
// Resumed transcript tail (resumed-session.js)
// ---------------------------------------------------------------------------

/** What a resume needs from the end of a transcript. */
export interface ResumedTail {
  /** Model of the last real assistant response. */
  readonly model?: string | undefined
  /** Permission mode the last human prompt ran in. */
  readonly permissionMode?: string | undefined
  /** Cumulative cost and per-model usage at the end of the transcript. */
  readonly costState?: { readonly totalCostUsd: number; readonly modelUsage: Record<string, ModelUsageRow> } | undefined
}

const concreteModel = (model: unknown): string | undefined => {
  if (typeof model !== 'string') return undefined
  const name = model.trim()
  return name.length > 0 && !/^<[^>]+>$/.test(name) ? name : undefined
}

/** Reads transcript lines from the end and keeps what a resume needs. */
class TailScan {
  readonly tail: { model?: string | undefined; permissionMode?: string | undefined; costState?: ResumedTail['costState'] } = {}
  private modeDone = false
  private planExited = false
  private humanSeen = false

  /** Visit the previous line; true when the scan has all it needs. */
  visit(line: Buffer): boolean {
    let parsed: Json | null | undefined
    const record = (marker: string): Json | undefined => {
      if (!line.includes(marker)) return undefined
      if (parsed === undefined) {
        try {
          const value: unknown = JSON.parse(line.toString('utf8'))
          parsed = isRecord(value) && value['isSidechain'] !== true ? value : null
        } catch {
          parsed = null
        }
      }
      return parsed ?? undefined
    }
    if (this.tail.model === undefined) {
      const entry = record('"assistant"')
      if (entry?.['type'] === 'assistant' && entry['parent_tool_use_id'] == null && entry['parent_agent_id'] == null && isRecord(entry['message'])) {
        const model = concreteModel(entry['message']['model'])
        if (model) this.tail.model = model
      }
    }
    if (this.tail.costState === undefined) {
      const entry = record('"cost-state"')
      if (entry?.['type'] === 'cost-state' && num(entry['totalCostUSD']) !== undefined) {
        this.tail.costState = { totalCostUsd: num(entry['totalCostUSD']) ?? 0, modelUsage: normalizeModelUsage(entry['modelUsage']) }
      }
    }
    if (!this.modeDone) this.visitForMode(record)
    return this.tail.model !== undefined && this.modeDone && (this.tail.costState !== undefined || this.humanSeen)
  }

  private visitForMode(record: (marker: string) => Json | undefined): void {
    const modeEntry = record('"permissionMode"')
    if (modeEntry?.['type'] === 'user' && typeof modeEntry['permissionMode'] === 'string' && modeEntry['permissionMode'].trim() !== '') {
      const mode = modeEntry['permissionMode'].trim()
      this.modeDone = true
      if (!(this.planExited && mode === 'plan')) this.tail.permissionMode = mode
      return
    }
    const exit = record('"plan_mode_exit"')
    if (exit && isRecord(exit['attachment']) && exit['attachment']['type'] === 'plan_mode_exit') {
      this.planExited = true
      return
    }
    const human = record('"human"')
    if (human?.['type'] === 'user' && isRecord(human['origin']) && human['origin']['kind'] === 'human') {
      this.modeDone = true
      this.humanSeen = true
    }
  }

  /** The end of the file was reached: whatever is missing does not exist. */
  finish(): void {
    this.modeDone = true
  }
}

/** The local transcript of a session, in whichever project directory Claude Code stored it. */
async function findTranscript(sessionId: string, configDir: string): Promise<string | undefined> {
  const projects = path.join(configDir, 'projects')
  let directories: string[]
  try {
    directories = await readdir(projects)
  } catch {
    return undefined
  }
  for (const directory of directories) {
    const candidate = path.join(projects, directory, `${sessionId}.jsonl`)
    try {
      await access(candidate)
      return candidate
    } catch {
      // Not in this project directory.
    }
  }
  return undefined
}

/** Model, permission mode and cost baseline of a stored conversation; empty when it cannot be read. */
export async function readClaudeResumedTail(sessionId: string, configDir: string): Promise<ResumedTail> {
  const filePath = await findTranscript(sessionId, configDir)
  if (filePath === undefined) return {}
  let handle: FileHandle | undefined
  try {
    handle = await open(filePath, 'r')
    const scan = new TailScan()
    let end = (await handle.stat()).size
    let pending: Buffer[] = []
    while (end > 0) {
      const start = Math.max(0, end - TAIL_CHUNK_BYTES)
      let chunk = Buffer.alloc(end - start)
      await handle.read(chunk, 0, chunk.length, start)
      for (let at = chunk.lastIndexOf(0x0a); at >= 0; at = chunk.lastIndexOf(0x0a)) {
        if (scan.visit(Buffer.concat([chunk.subarray(at + 1), ...pending]))) return scan.tail
        pending = []
        chunk = chunk.subarray(0, at)
      }
      pending.unshift(chunk)
      end = start
    }
    scan.visit(Buffer.concat(pending))
    scan.finish()
    return scan.tail
  } catch {
    return {}
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// Settings and slash commands
// ---------------------------------------------------------------------------

/** `permissions.defaultMode`, unless a repository-controlled settings file tried to escalate it. */
function trustedDefaultMode(effective: Json, sources: readonly unknown[]): unknown {
  const permissions = isRecord(effective['permissions']) ? effective['permissions'] : undefined
  const mode = permissions?.['defaultMode']
  if (typeof mode !== 'string' || !Object.hasOwn(ESCALATING_MODES, mode)) return mode
  for (let index = sources.length - 1; index >= 0; index -= 1) {
    const source = sources[index]
    if (!isRecord(source) || !isRecord(source['settings'])) continue
    const sourcePermissions = isRecord(source['settings']['permissions']) ? source['settings']['permissions'] : undefined
    if (sourcePermissions?.['defaultMode'] === undefined) continue
    const name = String(source['source'])
    const untrusted = /project/i.test(name) || (mode !== 'acceptEdits' && /local/i.test(name))
    return untrusted ? undefined : mode
  }
  return mode
}

/** The settings the controls depend on, from the CLI's `get_settings` answer. */
export function parseClaudeSettings(raw: Json | undefined): ClaudeSettingsView {
  const effective = isRecord(raw?.['effective']) ? raw['effective'] : {}
  const sources = Array.isArray(raw?.['sources']) ? raw['sources'] : []
  const permissions = isRecord(effective['permissions']) ? effective['permissions'] : undefined
  const denied = sources
    .filter((source): source is Json => isRecord(source) && /managed|policy/i.test(String(source['source'])))
    .flatMap((source) => (isRecord(source['settings']) && Array.isArray(source['settings']['deniedModels']) ? source['settings']['deniedModels'] : []))
    .filter((entry): entry is string => typeof entry === 'string')
  const overrides = isRecord(effective['modelOverrides'])
    ? Object.fromEntries(Object.entries(effective['modelOverrides']).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : undefined
  return {
    model: effective['model'],
    availableModels: effective['availableModels'],
    modelOverrides: overrides,
    deniedModels: denied,
    effortLevel: effective['effortLevel'],
    modelSettings: isRecord(effective['modelSettings']) ? (effective['modelSettings'] as ClaudeSettingsView['modelSettings']) : undefined,
    ultracode: effective['ultracode'],
    permissions: { defaultMode: trustedDefaultMode(effective, sources), disableBypassPermissionsMode: permissions?.['disableBypassPermissionsMode'] },
  }
}

const UNSUPPORTED_COMMANDS: Readonly<Record<string, true>> = {
  clear: true,
  cost: true,
  'keybindings-help': true,
  login: true,
  logout: true,
  'output-style:new': true,
  'release-notes': true,
  todos: true,
}

const MCP_AVAILABLE_COMMAND: acp.AvailableCommand = {
  name: 'mcp',
  description: 'Show the MCP servers and their status, or reconnect, enable, or disable a server',
  input: { hint: '[reconnect|enable|disable [<server>|all]]' },
}

/** The slash commands claude-agent-acp advertises: terminal-bound and unsupported ones are left out. */
export function claudeAvailableCommands(commands: unknown, terminalCommands: readonly string[]): acp.AvailableCommand[] {
  const advertised: acp.AvailableCommand[] = []
  for (const command of Array.isArray(commands) ? commands : []) {
    if (!isRecord(command) || typeof command['name'] !== 'string') continue
    if (command['name'] === 'mcp' || terminalCommands.includes(command['name'])) continue
    const hint = Array.isArray(command['argumentHint']) ? command['argumentHint'].join(' ') : text(command['argumentHint'])
    const name = command['name'].endsWith(' (MCP)') ? `mcp:${command['name'].replace(' (MCP)', '')}` : command['name']
    if (Object.hasOwn(UNSUPPORTED_COMMANDS, name)) continue
    advertised.push({ name, description: text(command['description']) ?? '', input: hint ? { hint } : null })
  }
  return [...advertised, MCP_AVAILABLE_COMMAND]
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

interface SessionState {
  modes: acp.SessionModeState
  models: ClaudeModelState
  modelInfos: ClaudeModelInfo[]
  readonly sdkModels: ClaudeModelInfo[]
  readonly agents: ClaudeAgentInfo[]
  currentAgent: string
  fastEnabled: boolean
  fastReason: string | undefined
  /** The effort shown as current: a pick, or what settings resolve to. */
  effortSeed: string | undefined
  /** The effort the user pinned this session (cleared by "default" or an unsupporting model). */
  effortPinned: string | undefined
  readonly settings: ClaudeSettingsView
  readonly allowBypass: boolean
  prePlanMode: string | undefined
  autoFallbackWarned: boolean
  options: acp.SessionConfigOption[]
}

interface PendingControl {
  readonly deferred: Deferred<Json>
}

interface PromptSettlement {
  readonly resolve: (result: NativePromptResult) => void
  readonly reject: (error: Error) => void
}

/** One `claude` CLI process speaking stream-json. Not reusable after `close()`. */
export class ClaudeCliTransport implements NativeTransport {
  readonly kind: NativeTransportKind = 'claude'
  readonly canFork = true

  private options: NativeTransportStartOptions | undefined
  private proc: NativeProcess | undefined
  private lines: Interface | undefined
  private stderr = ''
  private startupResultErrors = ''
  private exitError: NativeTransportError | undefined
  private exited = false
  private closeRequested = false

  private sessionIdValue: string | undefined
  private claudeVersion: string | undefined
  private state: SessionState | undefined
  private terminalCommands: string[] = []
  private commands: unknown
  private mapper: ClaudeFrameMapper | undefined
  private readonly capabilities = new Set<string>()

  private promptSettlement: PromptSettlement | undefined
  private activeTurnUuid: string | undefined
  private interruptRequested = false
  private interruptInFlight: Promise<void> | undefined
  private interruptFallbackTimer: NodeJS.Timeout | undefined
  /** uuids of messages this transport injected into the running turn. */
  private readonly injectedTurnUuids = new Set<string>()
  private readonly pendingControls = new Map<string, PendingControl>()
  private readonly permissionControllers = new Map<string, AbortController>()
  private exitPlanInterrupted = false

  /** Cumulative per-model usage at the last `result`, the baseline of the next turn. */
  private usageBaseline: Record<string, ModelUsageRow> | undefined
  private baselineCost: number | undefined
  /** Usage of results that arrived with no prompt in flight; charged to the next turn. */
  private carry: ModelUsageRow = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0, costUsd: 0 }
  private refusalExplanation: string | undefined

  private startPromise: Promise<void> | undefined
  private closePromise: Promise<void> | undefined

  get sessionId(): string | undefined {
    return this.sessionIdValue
  }

  get agentInfo(): { readonly name: string; readonly version: string } {
    return { name: 'claude', version: this.claudeVersion ?? '' }
  }

  /** True once the process exited or `close()` ran; such a transport cannot take another turn. */
  get closed(): boolean {
    return this.closeRequested || this.exited
  }

  // -- logging / events ----------------------------------------------------

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
      this.log(`claude: onEvent handler threw: ${messageOf(error)}`)
    }
  }

  private emitAll(events: readonly NativeTransportEvent[]): void {
    for (const event of events) this.emit(event)
  }

  private notice(message: string): void {
    this.emit({ kind: 'notice', text: truncate(message, DETAIL_LIMIT) })
  }

  // -- lifecycle -----------------------------------------------------------

  start(options: NativeTransportStartOptions): Promise<void> {
    if (this.startPromise !== undefined) return this.startPromise
    this.startPromise = this.startInternal(options).catch(async (error: unknown) => {
      await this.close().catch(() => undefined)
      throw error instanceof NativeTransportError
        ? error
        : new NativeTransportError(`Failed to start Claude Code: ${messageOf(error)}`, 'claude_start_failed', this.stderrTail())
    })
    return this.startPromise
  }

  private async startInternal(options: NativeTransportStartOptions): Promise<void> {
    if (this.closeRequested) throw new NativeTransportError('Claude transport is closed', 'closed')
    this.options = options
    if (options.argv.length === 0 || !options.argv[0]) {
      throw new NativeTransportError('no Claude Code launcher was configured', 'spawn-failed')
    }
    const target = options.session
    const configDir = claudeConfigDir(options.env)
    const sessionId = target.kind === 'resume' ? target.sessionId : randomUUID()
    const allowBypass = this.allowBypassFor(options.env)
    // The conversation a resume continues or a fork inherits; its transcript tail restores mode and model.
    let kind: ClaudeLaunchKind = target.kind
    let parentSessionId = target.kind === 'fork' ? target.parentSessionId : undefined
    const sourceOf = (): string | undefined => parentSessionId ?? (kind === 'resume' ? sessionId : undefined)
    let tail = await this.readTail(sourceOf(), configDir)
    const launchWith = async (): Promise<{ readonly init: Json; readonly mode: ClaudePermissionMode }> => {
      const mode = resolveInitialPermissionMode({ resumed: tail?.permissionMode }, allowBypass, (message) => this.log(message))
      const argv = buildClaudeArgv({ launcher: options.argv, kind, sessionId, parentSessionId, permissionMode: mode, allowBypass })
      return { init: await this.launch(argv, sessionId), mode }
    }
    let launched: { readonly init: Json; readonly mode: ClaudePermissionMode }
    try {
      launched = await launchWith()
    } catch (error: unknown) {
      const unprompted = target.kind === 'resume' ? unpromptedSessions.get(sessionId) : undefined
      if (!(error instanceof NativeTransportError && error.code === 'session-not-found' && unprompted !== undefined)) throw error
      // Never prompted in this process, so nothing was stored: start again under the same id (a fork from its parent again).
      this.log(`claude: session ${sessionId} was never persisted; starting it again under the same id`)
      await this.discardProcess()
      parentSessionId = unprompted.parentSessionId
      kind = parentSessionId === undefined ? 'fresh' : 'fork'
      tail = await this.readTail(parentSessionId, configDir)
      launched = await launchWith()
    }
    this.sessionIdValue = sessionId
    await this.assemble(launched.init, tail, launched.mode, kind === 'resume' || kind === 'fork')
    // A new conversation has no cost history; a resumed or forked one continues from its transcript.
    if (kind === 'new' || kind === 'fresh') {
      this.usageBaseline = {}
      this.baselineCost = 0
    } else if (tail?.costState !== undefined) {
      this.usageBaseline = tail.costState.modelUsage
      this.baselineCost = tail.costState.totalCostUsd
    }
    if (kind === 'resume') unpromptedSessions.delete(sessionId)
    else unpromptedSessions.set(sessionId, { parentSessionId: kind === 'fork' ? parentSessionId : undefined })
    this.scheduleCommandsUpdate()
    void this.refreshContextWindow()
  }

  private async readTail(sessionId: string | undefined, configDir: string): Promise<ResumedTail | undefined> {
    return sessionId === undefined ? undefined : await readClaudeResumedTail(sessionId, configDir)
  }

  /** Root cannot use bypass unless sandboxed; the CLI refuses it too. */
  private allowBypassFor(env: Readonly<Record<string, string>>): boolean {
    const isRoot = (process.geteuid?.() ?? process.getuid?.()) === 0
    return !isRoot || !!(env['IS_SANDBOX'] ?? process.env['IS_SANDBOX'])
  }

  /** Spawn the CLI and complete the control handshake; resolves with the `initialize` answer. */
  private async launch(argv: readonly string[], sessionId: string): Promise<Json> {
    const options = this.requireOptions()
    this.stderr = ''
    this.startupResultErrors = ''
    this.exitError = undefined
    this.exited = false
    const env: Record<string, string> = { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', ...options.env }
    let proc: NativeProcess
    try {
      proc = options.spawn({ argv, cwd: options.cwd, env })
    } catch (error: unknown) {
      if (error instanceof NativeTransportError) throw error
      throw new NativeTransportError(`could not launch ${argv[0] ?? 'claude'}: ${messageOf(error)}`, 'spawn-failed')
    }
    this.proc = proc
    this.mapper = new ClaudeFrameMapper({ cwd: options.cwd })
    proc.stderr.on('data', (chunk: Buffer | string) => {
      this.stderr += chunk.toString()
      if (this.stderr.length > STDERR_LIMIT) this.stderr = this.stderr.slice(-STDERR_LIMIT)
    })
    proc.stdin.on('error', (error: Error) => this.log(`claude: stdin error: ${error.message}`))
    this.lines = createInterface({ input: proc.stdout })
    this.lines.on('line', (line: string) => this.handleLine(line))
    proc.exited.then(
      (outcome) => this.handleExit(proc, outcome.exitCode, outcome.signal),
      (error: unknown) => this.handleLaunchFailure(proc, error),
    )
    try {
      return await this.controlRequest('initialize', {}, INITIALIZE_TIMEOUT_MS)
    } catch (error: unknown) {
      // The CLI's last words (stderr, an error `result`) may still be in flight when it exits.
      await Promise.all([streamEnded(proc.stderr, 500), streamEnded(proc.stdout, 500)])
      if (NOT_FOUND_PATTERN.test(`${this.stderr}\n${this.startupResultErrors}`)) {
        throw new NativeTransportError(`Claude Code session not found: ${sessionId}`, 'session-not-found', this.stderrTail())
      }
      if (error instanceof NativeTransportError) throw error
      throw new NativeTransportError(`Claude Code did not initialize: ${messageOf(error)}`, 'claude_start_failed', this.stderrTail())
    }
  }

  /** Stop the process of a failed start attempt without closing the transport. */
  private async discardProcess(): Promise<void> {
    const proc = this.proc
    this.proc = undefined
    this.lines?.close()
    this.lines = undefined
    this.rejectPendingControls(new NativeTransportError('Claude process discarded', 'closed'))
    if (proc !== undefined && !this.exited) {
      proc.terminate()
      await withTimeout(proc.exited.catch(() => undefined), CLOSE_TERMINATE_GRACE_MS, undefined)
    }
  }

  private requireOptions(): NativeTransportStartOptions {
    if (this.options === undefined) throw new NativeTransportError('Claude transport was not started', 'not_started')
    return this.options
  }

  private requireState(): SessionState {
    if (this.state === undefined) throw new NativeTransportError('Claude transport was not started', 'not_started')
    return this.state
  }

  private stderrTail(): string | undefined {
    const trimmed = this.stderr.replace(/⚠[^\n]*\n?/g, '').trim()
    return trimmed === '' ? undefined : truncate(trimmed, DETAIL_LIMIT)
  }

  private handleExit(proc: NativeProcess, exitCode: number | null, signal: string | null): void {
    if (proc !== this.proc) return
    this.exited = true
    if (this.closeRequested) return
    const description =
      exitCode === 0 && signal === null ? 'claude CLI exited' : `claude CLI exited with code ${String(exitCode)} signal ${String(signal)}`
    this.failProcess(new NativeTransportError(description, 'process_exit', this.stderrTail()))
  }

  private handleLaunchFailure(proc: NativeProcess, error: unknown): void {
    if (proc !== this.proc) return
    this.exited = true
    if (this.closeRequested) return
    this.failProcess(new NativeTransportError(`could not launch claude: ${messageOf(error)}`, 'spawn-failed'))
  }

  private failProcess(error: NativeTransportError): void {
    this.exitError ??= error
    this.log(`claude: ${error.message}${error.detail === undefined ? '' : ` (${error.detail})`}`)
    this.settlePromptReject(error)
    this.rejectPendingControls(error)
    this.notice(error.message)
  }

  // -- stdin / stdout --------------------------------------------------------

  private writeFrame(payload: Json): void {
    const proc = this.proc
    if (proc === undefined || this.closeRequested) return
    if (proc.stdin.destroyed || !proc.stdin.writable) throw new NativeTransportError('claude CLI stdin is not writable', 'stdin_closed')
    proc.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  private handleLine(line: string): void {
    if (this.closeRequested) return
    const trimmed = line.trim()
    if (trimmed === '') return
    let raw: unknown
    try {
      raw = JSON.parse(trimmed)
    } catch {
      this.log(`claude: ignoring non-JSON stdout line: ${truncate(trimmed, 200)}`)
      return
    }
    if (!isRecord(raw)) return
    switch (raw['type']) {
      case 'control_request':
        void this.handleControlRequest(raw)
        return
      case 'control_response':
        this.handleControlResponse(raw)
        return
      case 'control_cancel_request': {
        const requestId = text(raw['request_id'])
        if (requestId !== undefined) this.permissionControllers.get(requestId)?.abort()
        return
      }
      case 'result':
        this.handleResult(raw)
        return
      case 'system':
        this.handleSystemFrame(raw)
        return
      case 'stream_event':
      case 'assistant':
      case 'user':
      case 'tool_progress':
      case 'rate_limit_event':
        this.mapFrame(raw)
        return
      default:
        // keep_alive, command_lifecycle, prompt_suggestion, … are additive.
        return
    }
  }

  private mapFrame(frame: Json): void {
    const mapper = this.mapper
    if (mapper === undefined) return
    if (frame['type'] === 'assistant') this.noteRefusal(frame)
    this.emitAll(mapper.map(frame))
  }

  private noteRefusal(frame: Json): void {
    const message = isRecord(frame['message']) ? frame['message'] : undefined
    if (message?.['stop_reason'] === 'refusal' && isRecord(message['stop_details'])) {
      this.refusalExplanation = text(message['stop_details']['explanation']) ?? this.refusalExplanation
    }
  }

  private handleSystemFrame(frame: Json): void {
    const subtype = text(frame['subtype'])
    if (subtype === 'init') {
      this.handleInit(frame)
      return
    }
    if (subtype === 'status') {
      this.syncPermissionMode(frame['permissionMode'])
    }
    this.mapFrame(frame)
  }

  private handleInit(frame: Json): void {
    const sessionId = text(frame['session_id'])
    if (sessionId !== undefined && sessionId !== '' && sessionId !== this.sessionIdValue) {
      this.log(`claude: the CLI reports session ${sessionId} for requested ${this.sessionIdValue ?? 'unknown'}`)
    }
    if (Array.isArray(frame['capabilities'])) {
      this.capabilities.clear()
      for (const entry of frame['capabilities']) if (typeof entry === 'string') this.capabilities.add(entry)
    }
    this.syncPermissionMode(frame['permissionMode'])
    this.syncFastMode(frame['fast_mode_state'], frame['fast_mode_disabled_reason'])
    this.syncModelFromInit(text(frame['model']))
    const terminal = Array.isArray(frame['terminal_slash_commands'])
      ? frame['terminal_slash_commands'].filter((entry): entry is string => typeof entry === 'string')
      : []
    if (JSON.stringify(terminal) !== JSON.stringify(this.terminalCommands)) {
      this.terminalCommands = terminal
      this.scheduleCommandsUpdate()
    }
  }

  private scheduleCommandsUpdate(): void {
    // Delivered after start() resolves, so the runtime has attached the session id by then.
    const timer = setTimeout(() => {
      if (this.closeRequested) return
      this.emit(updateEvent({ sessionUpdate: 'available_commands_update', availableCommands: claudeAvailableCommands(this.commands, this.terminalCommands) }))
    }, 0)
    timer.unref()
  }

  // -- control channel -------------------------------------------------------

  /** Send a control request and resolve with its `response` object; rejects on an error answer or timeout. */
  private async controlRequest(subtype: string, extra: Json, timeoutMs: number = CONTROL_TIMEOUT_MS): Promise<Json> {
    if (this.exitError !== undefined) throw this.exitError
    const requestId = `dsh-${subtype}-${randomUUID()}`
    const pending = deferred<Json>()
    this.pendingControls.set(requestId, { deferred: pending })
    try {
      this.writeFrame({ type: 'control_request', request_id: requestId, request: { subtype, ...extra } })
      const timeout = Symbol('timeout')
      const answer = await withTimeout<Json | typeof timeout>(pending.promise, timeoutMs, timeout)
      if (answer === timeout) throw new NativeTransportError(`Claude Code did not answer ${subtype} in time`, 'control-timeout', this.stderrTail())
      return answer
    } finally {
      this.pendingControls.delete(requestId)
    }
  }

  /** A control request whose failure only needs logging. */
  private async controlRequestSoft(subtype: string, extra: Json, timeoutMs: number = CONTROL_TIMEOUT_MS): Promise<Json | undefined> {
    try {
      return await this.controlRequest(subtype, extra, timeoutMs)
    } catch (error: unknown) {
      // A request the host's own shutdown cut short is not worth a diagnostic.
      if (!this.closeRequested) this.log(`claude: ${subtype} failed: ${messageOf(error)}`)
      return undefined
    }
  }

  private handleControlResponse(frame: Json): void {
    const response = isRecord(frame['response']) ? frame['response'] : undefined
    const requestId = text(response?.['request_id'])
    if (response === undefined || requestId === undefined) return
    const pending = this.pendingControls.get(requestId)
    if (pending === undefined) {
      this.log(`claude: control response for unknown request ${requestId}`)
      return
    }
    this.pendingControls.delete(requestId)
    if (response['subtype'] === 'error') {
      pending.deferred.reject(new NativeTransportError(text(response['error']) ?? 'Claude Code rejected the request', 'control-error'))
      return
    }
    pending.deferred.resolve(isRecord(response['response']) ? response['response'] : {})
  }

  private replyControl(requestId: string, response: Json): void {
    try {
      this.writeFrame({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
    } catch (error: unknown) {
      this.log(`claude: failed to answer control request ${requestId}: ${messageOf(error)}`)
    }
  }

  private replyControlError(requestId: string, message: string): void {
    try {
      this.writeFrame({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: message } })
    } catch (error: unknown) {
      this.log(`claude: failed to answer control request ${requestId}: ${messageOf(error)}`)
    }
  }

  private rejectPendingControls(error: Error): void {
    for (const pending of this.pendingControls.values()) pending.deferred.reject(error)
    this.pendingControls.clear()
    for (const controller of this.permissionControllers.values()) controller.abort()
    this.permissionControllers.clear()
  }

  private async handleControlRequest(frame: Json): Promise<void> {
    const requestId = text(frame['request_id'])
    const request = isRecord(frame['request']) ? frame['request'] : undefined
    if (requestId === undefined || request === undefined) {
      this.log('claude: ignoring malformed control_request')
      return
    }
    const subtype = text(request['subtype'])
    try {
      switch (subtype) {
        case 'can_use_tool':
          await this.handleCanUseTool(requestId, request)
          return
        case 'elicitation':
          // No form is available to present an MCP elicitation.
          this.replyControl(requestId, { action: 'decline' })
          return
        case 'request_user_dialog':
          this.replyControl(requestId, { behavior: 'cancelled' })
          return
        case 'hook_callback':
          this.replyControl(requestId, { continue: true })
          return
        default:
          // The CLI waits for an answer: an unknown host callback must be refused or the turn hangs.
          this.log(`claude: unsupported control request ${subtype ?? 'unknown'} (${requestId})`)
          this.replyControlError(requestId, `DSH native transport does not support ${subtype ?? 'this'} request`)
      }
    } catch (error: unknown) {
      this.log(`claude: failed to answer ${subtype ?? 'control'} request: ${messageOf(error)}`)
      this.replyControlError(requestId, messageOf(error))
    }
  }

  private async handleCanUseTool(requestId: string, request: Json): Promise<void> {
    const state = this.state
    const mapper = this.mapper
    const prepared = prepareClaudePermission(request, {
      cwd: this.requireOptions().cwd,
      availableModes: state?.modes.availableModes.map((mode) => mode.id) ?? [],
      prePlanMode: state?.prePlanMode,
      autoUnavailable: state !== undefined && this.isAutoUnavailable(state),
    })
    this.log(`claude: permission request ${requestId} (${prepared.toolUse.name})`)
    // The request names a tool call the host must already know.
    if (mapper !== undefined) this.emitAll(mapper.ensureToolCall(prepared.toolUse))
    const controller = new AbortController()
    this.permissionControllers.set(requestId, controller)
    try {
      const decision = await this.askPermission(prepared.request, controller.signal)
      const result = prepared.decide(decision)
      if (result === undefined || controller.signal.aborted) {
        this.replyControlError(requestId, 'Tool use aborted')
        return
      }
      if (prepared.toolUse.name === 'ExitPlanMode' && result['behavior'] === 'deny' && result['interrupt'] === true) {
        this.exitPlanInterrupted = true
      }
      this.replyControl(requestId, result)
    } finally {
      this.permissionControllers.delete(requestId)
    }
  }

  private async askPermission(request: NativePermissionRequest, signal: AbortSignal): Promise<NativePermissionDecision> {
    const handler = this.options?.onPermission
    if (handler === undefined || signal.aborted) return { cancelled: true }
    const { promise, resolve } = Promise.withResolvers<NativePermissionDecision>()
    const onAbort = (): void => finish({ cancelled: true })
    const finish = (decision: NativePermissionDecision): void => {
      signal.removeEventListener('abort', onAbort)
      resolve(decision)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve()
      .then(() => handler(request, signal))
      .then(finish, (error: unknown) => {
        this.log(`claude: onPermission handler failed: ${messageOf(error)}`)
        finish({ cancelled: true })
      })
    return await promise
  }

  // -- session assembly --------------------------------------------------------

  /** Build the session state from the CLI's `initialize` answer, applying the model and mode a vendor session would. */
  private async assemble(init: Json, tail: ResumedTail | undefined, spawnMode: ClaudePermissionMode, resumed: boolean): Promise<void> {
    const options = this.requireOptions()
    this.claudeVersion = text(init['claude_code_version']) ?? this.claudeVersion
    this.commands = init['commands']
    const sdkModels = parseClaudeModelInfos(init['models'])
    const agents = discoverCustomAgents(init['agents'])
    const settings = parseClaudeSettings(await this.controlRequestSoft('get_settings', {}, SETTINGS_TIMEOUT_MS))
    const allowBypass = this.allowBypassFor(options.env) && settings.permissions?.disableBypassPermissionsMode !== 'disable'
    const allowlist = Array.isArray(settings.availableModels) ? settings.availableModels.filter((entry): entry is string => typeof entry === 'string') : undefined
    const allowed =
      allowlist === undefined
        ? sdkModels
        : applyAvailableModelsAllowlist(sdkModels, allowlist, settings.modelOverrides, settings.deniedModels ?? [], options.env['ANTHROPIC_CUSTOM_MODEL_OPTION'])
    const choice = chooseInitialModel({
      models: allowed,
      sdkModels,
      settingsModel: settings.model,
      envModel: options.env['ANTHROPIC_MODEL'],
      resumed,
      resumedModelHint: tail?.model,
      log: (message) => this.log(message),
    })
    let currentModelId = choice.state.currentModelId
    if (choice.setModel !== undefined) {
      try {
        await this.controlRequest('set_model', { model: choice.setModel })
      } catch (error: unknown) {
        if (!resumed && !choice.switchToListed && !isPreModelSwitchHookBlock(error)) throw error
        this.log(`claude: model switch to "${choice.setModel}" failed or was vetoed; keeping the running model: ${messageOf(error)}`)
        currentModelId = resumed && tail?.model ? matchResumedModel(allowed, tail.model).value : choice.modelBeforeSwitch
      }
    }
    const models: ClaudeModelState = { ...choice.state, currentModelId }
    const { modelInfos, currentModelInfo } = withLiveModelInfo(allowed, sdkModels, currentModelId)

    // Initial permission mode: the resumed transcript's, else the trusted settings default; Auto needs model support.
    const wanted = resolveInitialPermissionMode(
      { resumed: tail?.permissionMode, defaultMode: settings.permissions?.defaultMode },
      allowBypass,
      (message) => this.log(message),
    )
    const availableModes = buildClaudeAvailableModes(allowBypass)
    let mode: ClaudePermissionMode = wanted
    if (wanted === 'auto' && currentModelInfo !== undefined && currentModelInfo.supportsAutoMode !== true) {
      this.log(`permissions.defaultMode "auto" is not available for model "${currentModelId}"; falling back to "${AUTO_MODE_FALLBACK}".`)
      mode = AUTO_MODE_FALLBACK
    } else if (!availableModes.some((entry) => entry.id === wanted)) {
      this.log(`permissions.defaultMode "${wanted}" is not available in this session; falling back to "default".`)
      mode = 'default'
    }
    if (mode !== spawnMode) {
      try {
        await this.controlRequest('set_permission_mode', { mode })
      } catch (error: unknown) {
        this.log(`claude: failed to sync the initial permission mode: ${messageOf(error)}`)
      }
    }

    const fastEnabled = init['fast_mode_state'] !== undefined && fastModeStateEnabled(init['fast_mode_state'])
    const state: SessionState = {
      modes: { currentModeId: mode, availableModes },
      models,
      modelInfos,
      sdkModels,
      agents,
      currentAgent: DEFAULT_AGENT_ID,
      fastEnabled,
      fastReason: fastEnabled ? undefined : normalizeFastModeDisabledReason(init['fast_mode_disabled_reason']),
      effortSeed: settingsEffortForModel(settings, currentModelInfo),
      effortPinned: undefined,
      settings,
      allowBypass,
      prePlanMode: undefined,
      autoFallbackWarned: false,
      options: [],
    }
    this.state = state
    this.rebuildOptions()
    this.mapper?.seedContextWindow(currentModelId, currentModelInfo?.resolvedModel, currentModelInfo?.displayName, currentModelInfo?.description)
    this.applyLearnedWindow(currentModelInfo, currentModelId)
  }

  private applyLearnedWindow(info: ClaudeModelInfo | undefined, modelId: string): void {
    const learned = learnedContextWindows.get(info?.resolvedModel ?? modelId)
    if (learned !== undefined) this.mapper?.setContextWindow(learned, true)
  }

  /** The CLI's own answer for the window of the running model; refines the text heuristic. */
  private async refreshContextWindow(): Promise<void> {
    const mapper = this.mapper
    const modelId = this.state?.models.currentModelId
    const usage = await this.controlRequestSoft('get_context_usage', { detail: 'summary' }, 5_000)
    const raw = num(usage?.['rawMaxTokens'])
    if (raw !== undefined && raw > 0 && mapper === this.mapper && modelId === this.state?.models.currentModelId) mapper?.setContextWindow(raw, true)
  }

  private currentModelInfo(state: SessionState): ClaudeModelInfo | undefined {
    return state.modelInfos.find((model) => model.value === state.models.currentModelId)
  }

  private isAutoUnavailable(state: SessionState, modelId: string = state.models.currentModelId): boolean {
    const info = state.modelInfos.find((model) => model.value === modelId)
    return info !== undefined && info.supportsAutoMode !== true
  }

  private rebuildOptions(): void {
    const state = this.requireState()
    state.options = buildClaudeConfigOptions({
      modes: state.modes,
      models: state.models,
      modelInfos: state.modelInfos,
      effortLevel: state.effortSeed,
      agents: state.agents,
      currentAgent: state.currentAgent,
      fast: { supported: this.currentModelInfo(state)?.supportsFastMode ?? false, enabled: state.fastEnabled, disabledReason: state.fastReason },
    })
  }

  controls(): NativeControls {
    const state = this.requireState()
    return { configOptions: state.options, modes: state.modes, imageInput: true }
  }

  // -- vendor-driven control changes -----------------------------------------------

  private announceControls(): void {
    if (this.state !== undefined) this.emit({ kind: 'controls', controls: this.controls() })
  }

  /** The CLI changed the permission mode itself (plan exit, shift-tab, …); mirror it. */
  private syncPermissionMode(raw: unknown): void {
    const state = this.state
    if (state === undefined || typeof raw !== 'string' || raw === state.modes.currentModeId) return
    if (!state.modes.availableModes.some((mode) => mode.id === raw)) return
    this.applyModeState(raw)
    this.announceControls()
  }

  private syncFastMode(fastState: unknown, reason: unknown): void {
    const state = this.state
    if (state === undefined || fastState === undefined || !state.options.some((option) => option.id === FAST_MODE_CONFIG_ID)) return
    if (fastState === 'cooldown') return
    const enabled = fastState === 'on'
    const nextReason = enabled ? undefined : normalizeFastModeDisabledReason(reason)
    if (enabled === state.fastEnabled && nextReason === state.fastReason) return
    state.fastEnabled = enabled
    state.fastReason = nextReason
    this.rebuildOptions()
    this.announceControls()
  }

  /** The running model changed under us (`/model`, a refusal fallback); follow it. */
  private syncModelFromInit(model: string | undefined): void {
    const state = this.state
    if (state === undefined || model === undefined) return
    const current = this.currentModelInfo(state)
    const canonical = (value: string): string => value.trim().toLowerCase()
    if (current !== undefined && [current.resolvedModel, current.value].some((candidate) => candidate !== undefined && canonical(candidate) === canonical(model))) return
    const resolved = resolveModelPreference(state.modelInfos, model)
    const value = resolved?.value ?? model
    if (value === state.models.currentModelId) return
    this.applyModelState(value)
    this.announceControls()
  }

  // -- caller-driven control changes -----------------------------------------------

  async setConfigOption(configId: string, value: string | boolean, signal?: AbortSignal): Promise<void> {
    const state = this.requireState()
    if (this.closed) throw new NativeTransportError('Claude transport is closed', 'closed')
    if (this.promptSettlement !== undefined) throw new NativeTransportError('Cannot change a setting while a prompt runs', 'busy')
    signal?.throwIfAborted()
    const option = state.options.find((entry) => entry.id === configId)
    if (option === undefined) throw new NativeTransportError(`Unknown config option: ${configId}`, 'invalid-config')
    if (configId === FAST_MODE_CONFIG_ID) {
      await this.applyFastMode(state, resolveFastModeEnabled(value))
      return
    }
    if (typeof value !== 'string') throw new NativeTransportError(`Invalid value for config option ${configId}: ${String(value)}`, 'invalid-config')
    const values = selectValues(option)
    // The option's own current value is always a valid target, even when it has no entry (an out-of-picker live model).
    let resolved = values.includes(value) || (option.type === 'select' && option.currentValue === value) ? value : undefined
    if (resolved === undefined && configId === MODEL_CONFIG_ID) {
      // Human-friendly spellings ("opus", a full model id) resolve onto a picker row.
      const match = resolveModelPreference(state.modelInfos, value)
      resolved = match !== null && values.includes(match.value) ? match.value : undefined
    }
    if (resolved === undefined) throw new NativeTransportError(`Invalid value for config option ${configId}: ${value}`, 'invalid-config')
    switch (configId) {
      case MODE_CONFIG_ID:
        await this.selectMode(state, resolved)
        return
      case MODEL_CONFIG_ID:
        await this.selectModel(state, resolved)
        return
      case EFFORT_CONFIG_ID:
        await this.controlRequest('apply_flag_settings', { settings: effortFlagSettings(resolved, state.settings) })
        state.effortSeed = resolved
        state.effortPinned = resolved === DEFAULT_MODEL_ID ? undefined : resolved
        this.rebuildOptions()
        return
      case AGENT_CONFIG_ID:
        await this.controlRequest('apply_flag_settings', { settings: { agent: resolved === DEFAULT_AGENT_ID ? null : resolved } })
        state.currentAgent = resolved
        this.rebuildOptions()
        return
      default:
        state.options = withCurrentValue(state.options, configId, resolved)
    }
  }

  private async applyFastMode(state: SessionState, enabled: boolean): Promise<void> {
    // The flag goes first so a rejected request leaves the displayed state alone.
    await this.controlRequest('apply_flag_settings', { settings: { fastMode: enabled } })
    state.fastEnabled = enabled
    this.rebuildOptions()
  }

  private applyModeState(mode: string): void {
    const state = this.requireState()
    const previous = state.modes.currentModeId
    if (mode !== 'plan') state.prePlanMode = undefined
    else if (previous !== 'plan') state.prePlanMode = previous
    state.modes = { ...state.modes, currentModeId: mode }
    this.rebuildOptions()
  }

  private async selectMode(state: SessionState, modeId: string): Promise<void> {
    let requested: ClaudePermissionMode
    try {
      requested = parseSelectableMode(modeId)
    } catch {
      throw new NativeTransportError('Invalid Mode', 'invalid-config')
    }
    if (!state.modes.availableModes.some((mode) => mode.id === requested)) {
      throw new NativeTransportError(`Mode ${modeId} is not available in this session`, 'invalid-config')
    }
    const effective: ClaudePermissionMode = requested === 'auto' && this.isAutoUnavailable(state) ? AUTO_MODE_FALLBACK : requested
    await this.controlRequest('set_permission_mode', { mode: effective })
    this.applyModeState(effective)
    if (effective !== requested) this.warnAutoFallback(state)
  }

  private warnAutoFallback(state: SessionState): void {
    if (state.autoFallbackWarned) return
    state.autoFallbackWarned = true
    this.emit(
      updateEvent({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '**Auto mode unavailable:** the selected model does not support Auto mode; using Accept edits instead.' },
      }),
    )
  }

  private async selectModel(state: SessionState, value: string): Promise<void> {
    await this.controlRequest('set_model', { model: value })
    const previousMode = state.modes.currentModeId
    const info = this.applyModelState(value)
    // A mode the new model cannot run (Auto) falls back; the CLI must follow.
    if (previousMode === 'auto' && state.modes.currentModeId !== 'auto') {
      try {
        await this.controlRequest('set_permission_mode', { mode: AUTO_MODE_FALLBACK })
      } catch (error: unknown) {
        this.log(`claude: failed to sync permission mode after model switch: ${messageOf(error)}`)
      }
      this.warnAutoFallback(state)
    }
    // A pinned effort the new model does not support must be cleared from the flag layer too.
    if (state.effortPinned === undefined && state.effortSeed !== undefined && !this.supportsEffort(info, state.effortSeed)) {
      state.effortSeed = settingsEffortForModel(state.settings, info, value)
    }
    void this.refreshContextWindow()
  }

  /** Move the session's bookkeeping onto model `value`; returns the model's catalog row. */
  private applyModelState(value: string): ClaudeModelInfo | undefined {
    const state = this.requireState()
    const info = state.modelInfos.find((model) => model.value === value)
    if (state.models.currentModelId !== value) {
      this.mapper?.seedContextWindow(value, info?.resolvedModel, info?.displayName, info?.description)
      this.applyLearnedWindow(info, value)
    }
    state.models = { ...state.models, currentModelId: value }
    if (state.fastReason === 'model_not_allowed') state.fastReason = undefined
    if (state.modes.currentModeId === 'auto' && info !== undefined && info.supportsAutoMode !== true) {
      state.modes = { ...state.modes, currentModeId: AUTO_MODE_FALLBACK }
    }
    const pinned = state.effortPinned
    const pinnedForNew = pinned !== undefined && this.supportsEffort(info, pinned)
    state.effortSeed = pinnedForNew ? pinned : settingsEffortForModel(state.settings, info, value)
    if (pinned !== undefined && !pinnedForNew) {
      state.effortPinned = undefined
      void this.controlRequestSoft('apply_flag_settings', { settings: effortFlagSettings(undefined, state.settings) })
    }
    this.rebuildOptions()
    return info
  }

  private supportsEffort(info: ClaudeModelInfo | undefined, level: string): boolean {
    return level === DEFAULT_MODEL_ID || (info?.supportsEffort === true && info.supportedEffortLevels?.includes(level) === true)
  }

  // -- turns -----------------------------------------------------------------------

  async prompt(content: readonly NativeContentBlock[], signal: AbortSignal): Promise<NativePromptResult> {
    if (this.closeRequested) throw new NativeTransportError('Claude transport is closed', 'closed')
    if (this.exitError !== undefined) throw this.exitError
    if (this.state === undefined || this.sessionIdValue === undefined) throw new NativeTransportError('Claude transport was not started', 'not_started')
    if (this.promptSettlement !== undefined) throw new NativeTransportError('A Claude prompt is already in progress', 'busy')
    if (signal.aborted) return { stopReason: 'cancelled' }
    if (content.length === 0) throw new NativeTransportError('Claude prompt is empty', 'empty_prompt')

    const uuid = randomUUID()
    const settled = deferred<NativePromptResult>()
    void settled.promise.catch(() => undefined)
    this.promptSettlement = { resolve: settled.resolve, reject: settled.reject }
    this.activeTurnUuid = uuid
    this.interruptRequested = false
    this.interruptInFlight = undefined
    this.refusalExplanation = undefined
    this.exitPlanInterrupted = false

    const onAbort = (): void => {
      void this.interrupt()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      this.writeFrame(claudeUserMessageFrame({ blocks: content, sessionId: this.sessionIdValue, uuid }))
      // From the first message on, the conversation exists on disk and can be resumed.
      unpromptedSessions.delete(this.sessionIdValue)
      return await settled.promise
    } catch (error: unknown) {
      this.settlePromptReject(error instanceof Error ? error : new Error(String(error)))
      if (signal.aborted) return { stopReason: 'cancelled' }
      throw error instanceof NativeTransportError ? error : new NativeTransportError(`Claude prompt failed: ${messageOf(error)}`, 'prompt_failed', this.stderrTail())
    } finally {
      signal.removeEventListener('abort', onAbort)
      if (this.activeTurnUuid === uuid) this.activeTurnUuid = undefined
    }
  }

  /**
   * Inject a message into the running turn (`priority:"next"`: the CLI folds it in at the next
   * tool boundary). `promptRequired` means no turn can take it and the caller must use `prompt()`.
   */
  async steer(content: readonly NativeContentBlock[], signal?: AbortSignal): Promise<'injected' | 'promptRequired'> {
    if (this.closed || this.exitError !== undefined || this.sessionIdValue === undefined) return 'promptRequired'
    if (signal?.aborted === true || content.length === 0) return 'promptRequired'
    if (this.promptSettlement === undefined || this.activeTurnUuid === undefined || this.interruptRequested) return 'promptRequired'
    const frame = claudeUserMessageFrame({ blocks: content, sessionId: this.sessionIdValue, priority: 'next' })
    const uuid = text(frame['uuid'])
    try {
      if (uuid !== undefined) this.injectedTurnUuids.add(uuid)
      this.writeFrame(frame)
      this.log(`claude: injected steer ${uuid ?? '(no uuid)'} into the running turn`)
      return 'injected'
    } catch (error: unknown) {
      if (uuid !== undefined) this.injectedTurnUuids.delete(uuid)
      this.log(`claude: steer failed: ${messageOf(error)}`)
      return 'promptRequired'
    }
  }

  /** Stop the running turn. Resolves once the interrupt was acknowledged; the turn settles on its `result`. */
  async interrupt(): Promise<void> {
    if (this.closed || this.activeTurnUuid === undefined || this.promptSettlement === undefined) return
    if (this.interruptInFlight !== undefined) return await this.interruptInFlight
    this.interruptInFlight = this.interruptInternal()
    try {
      await this.interruptInFlight
    } finally {
      this.interruptInFlight = undefined
    }
    this.armInterruptFallback()
  }

  private armInterruptFallback(): void {
    if (this.promptSettlement === undefined) return
    clearTimeout(this.interruptFallbackTimer)
    const timer = setTimeout(() => {
      this.interruptFallbackTimer = undefined
      if (this.promptSettlement === undefined) return
      this.log('claude: interrupted turn produced no result; settling as cancelled')
      this.emitAll(this.mapper?.settleTurn(true) ?? [])
      this.finishTurn({ stopReason: 'cancelled' })
    }, INTERRUPT_SETTLE_FALLBACK_MS)
    timer.unref()
    this.interruptFallbackTimer = timer
  }

  private async interruptInternal(): Promise<void> {
    this.interruptRequested = true
    for (const controller of this.permissionControllers.values()) controller.abort()
    // Snapshot before the round trip: the interrupted turn's own `result` can be processed while we wait.
    const injectedBeforeInterrupt = new Set(this.injectedTurnUuids)
    const cancelQueued = this.capabilities.has('interrupt_cancel_queued_v1')
    const receipt = await this.controlRequestSoft('interrupt', cancelQueued ? { cancel_queued: true } : {}, INTERRUPT_TIMEOUT_MS)
    const uuids = (key: string): string[] => (Array.isArray(receipt?.[key]) ? receipt[key].filter((entry): entry is string => typeof entry === 'string') : [])
    if (cancelQueued) {
      // The receipt already lists the withdrawn messages.
      for (const uuid of uuids('cancelled')) this.injectedTurnUuids.delete(uuid)
      return
    }
    // Older CLIs leave injected messages queued: withdraw each one we sent, or a stopped turn is silently resumed.
    for (const uuid of uuids('still_queued')) {
      if (!injectedBeforeInterrupt.has(uuid)) continue
      this.injectedTurnUuids.delete(uuid)
      try {
        this.writeFrame({ type: 'control_request', request_id: `dsh-cancel-${uuid}`, request: { subtype: 'cancel_async_message', message_uuid: uuid } })
        this.log(`claude: withdrew queued steer ${uuid} after interrupt`)
      } catch (error: unknown) {
        this.log(`claude: failed to withdraw queued steer ${uuid}: ${messageOf(error)}`)
      }
    }
  }

  contextUsage(): NativeContextUsage | undefined {
    return this.mapper?.contextUsage
  }

  // -- results -----------------------------------------------------------------------

  /** Token and cost accounting of one `result`: the increase over the previous reading. */
  private accountUsage(frame: Json): ModelUsageRow {
    const reading = normalizeModelUsage(frame['modelUsage'])
    const totalCost = num(frame['total_cost_usd'])
    let delta: ModelUsageRow
    if (this.usageBaseline !== undefined) {
      delta = modelUsageIncrement(reading, this.usageBaseline)
      if (totalCost !== undefined && this.baselineCost !== undefined) {
        delta = { ...delta, costUsd: totalCost >= this.baselineCost ? totalCost - this.baselineCost : totalCost }
      }
    } else {
      // A resumed conversation without a saved baseline: only the main-loop usage of this turn is attributable.
      const usage = isRecord(frame['usage']) ? frame['usage'] : {}
      const details = isRecord(usage['output_tokens_details']) ? usage['output_tokens_details'] : {}
      delta = {
        input: num(usage['input_tokens']) ?? 0,
        output: num(usage['output_tokens']) ?? 0,
        cacheRead: num(usage['cache_read_input_tokens']) ?? 0,
        cacheWrite: num(usage['cache_creation_input_tokens']) ?? 0,
        thinking: num(details['thinking_tokens']) ?? 0,
        costUsd: 0,
      }
    }
    this.usageBaseline = reading
    if (totalCost !== undefined) this.baselineCost = totalCost
    return delta
  }

  private turnUsage(delta: ModelUsageRow): NativeTurnUsage {
    return {
      inputTokens: delta.input,
      outputTokens: delta.output,
      cachedReadTokens: delta.cacheRead,
      cachedWriteTokens: delta.cacheWrite,
      ...(delta.thinking > 0 ? { thoughtTokens: delta.thinking } : {}),
      ...(delta.costUsd > 0 ? { costUsd: Number(delta.costUsd.toFixed(6)) } : {}),
    }
  }

  private handleResult(frame: Json): void {
    const mapper = this.mapper
    if (this.state === undefined) {
      // The CLI's verdict on a launch that never completed its handshake (an unknown resume id).
      const errors = Array.isArray(frame['errors']) ? frame['errors'].filter((entry): entry is string => typeof entry === 'string') : []
      this.startupResultErrors += `${errors.join('\n')}\n`
    }
    if (mapper === undefined || this.state === undefined) return
    const delta = this.accountUsage(frame)
    this.syncFastMode(frame['fast_mode_state'], frame['fast_mode_disabled_reason'])
    const modelUsage = isRecord(frame['modelUsage']) ? frame['modelUsage'] : {}
    this.emitAll(mapper.resultUsage(frame))
    for (const key of Object.keys(modelUsage)) {
      const usage = modelUsage[key]
      const window = isRecord(usage) ? num(usage['contextWindow']) : undefined
      if (window !== undefined && window > 0) learnedContextWindows.set(key, window)
    }
    const settlement = this.promptSettlement
    if (settlement === undefined) {
      // Work the CLI started on its own (a background task finishing): real spend, charged to the next turn.
      this.carry = {
        input: this.carry.input + delta.input,
        output: this.carry.output + delta.output,
        cacheRead: this.carry.cacheRead + delta.cacheRead,
        cacheWrite: this.carry.cacheWrite + delta.cacheWrite,
        thinking: this.carry.thinking + delta.thinking,
        costUsd: this.carry.costUsd + delta.costUsd,
      }
      this.log('claude: result frame without an active prompt')
      return
    }
    const turn: ModelUsageRow = {
      input: delta.input + this.carry.input,
      output: delta.output + this.carry.output,
      cacheRead: delta.cacheRead + this.carry.cacheRead,
      cacheWrite: delta.cacheWrite + this.carry.cacheWrite,
      thinking: delta.thinking + this.carry.thinking,
      costUsd: delta.costUsd + this.carry.costUsd,
    }
    this.carry = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0, costUsd: 0 }
    const interrupted = this.interruptRequested
    // "No, keep planning" ends the turn with a CLI diagnostic; that is a cancel, not a failure.
    const planStop = this.exitPlanInterrupted && frame['is_error'] === true && /\[ede_diagnostic\]/.test(JSON.stringify(frame['errors'] ?? frame['result'] ?? ''))
    this.exitPlanInterrupted = false
    const outcome = interrupted || planStop ? claudeTurnOutcome(frame, true) : claudeTurnOutcome(frame, false)
    this.emitAll(mapper.settleTurn(interrupted || planStop))
    if ('error' in outcome) {
      this.log(`claude: turn failed: ${truncate(outcome.error, DETAIL_LIMIT)}`)
      this.settlePromptReject(new NativeTransportError(truncate(outcome.error, DETAIL_LIMIT), 'prompt_failed', this.stderrTail()))
      return
    }
    if (outcome.stopReason === 'refusal' && this.refusalExplanation) {
      this.emit(updateEvent({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: this.refusalExplanation } }))
    }
    this.finishTurn({ stopReason: outcome.stopReason, usage: this.turnUsage(turn) })
  }

  private clearTurnState(): void {
    clearTimeout(this.interruptFallbackTimer)
    this.interruptFallbackTimer = undefined
    this.promptSettlement = undefined
    this.activeTurnUuid = undefined
    this.interruptRequested = false
    this.interruptInFlight = undefined
    this.injectedTurnUuids.clear()
  }

  private finishTurn(result: NativePromptResult): void {
    const settlement = this.promptSettlement
    this.clearTurnState()
    settlement?.resolve(result)
  }

  private settlePromptReject(error: Error): void {
    const settlement = this.promptSettlement
    this.clearTurnState()
    settlement?.reject(error)
  }

  // -- shutdown ------------------------------------------------------------------------

  close(): Promise<void> {
    this.closePromise ??= this.closeInternal()
    return this.closePromise
  }

  private async closeInternal(): Promise<void> {
    this.closeRequested = true
    this.settlePromptReject(new NativeTransportError('Claude transport closed', 'closed'))
    this.rejectPendingControls(new NativeTransportError('Claude transport closed', 'closed'))
    const proc = this.proc
    if (proc !== undefined) {
      const exited = proc.exited.then(
        () => true,
        () => true,
      )
      // A graceful end is stdin EOF; a process that does not leave is terminated by the host.
      try {
        proc.stdin.end()
      } catch {
        // The pipe may already be gone.
      }
      if (!(await withTimeout(exited, CLOSE_STDIN_GRACE_MS, false))) {
        this.log('claude: CLI did not exit after stdin closed; terminating')
        proc.terminate()
        await withTimeout(exited, CLOSE_TERMINATE_GRACE_MS, false)
      }
    }
    this.lines?.close()
    this.lines = undefined
    this.proc = undefined
  }
}

export function createClaudeTransport(): NativeTransport {
  return new ClaudeCliTransport()
}
