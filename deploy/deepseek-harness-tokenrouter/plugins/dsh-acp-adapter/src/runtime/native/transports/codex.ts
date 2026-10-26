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
 *     options and are answered with its decision table (`codex-approvals.ts`).
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
import { createInterface, type Interface } from 'node:readline'
import type * as acp from '@agentclientprotocol/sdk'

import {
  answerCodexServerRequest,
  fallbackCodexServerAnswer,
  type CodexApprovalHost,
  type CodexServerRequestAnswer,
} from './codex-approvals.ts'
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
import { asRecord, messageOf, readArray, readString, truncate, type JsonRecord } from './codex-json.ts'
import {
  CodexProjection,
  CodexTokenAccounting,
  planReviewToolCall,
  readableServiceErrorMessage,
  renderToolCall,
  type CodexProjectionSink,
} from './codex-projection.ts'
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
const SKILLS_TIMEOUT_MS = 10_000
const CLOSE_GRACE_MS = 2_000
const CLOSE_TERMINATE_MS = 1_000
const STDERR_LIMIT = 8_192
/** How long a process exit waits for the last stderr bytes before it is reported. */
const STDERR_SETTLE_MS = 250
const DETAIL_LIMIT = 2_000
/** codex-acp retries a cancel that raced the turn becoming interruptible. */
const NO_ACTIVE_TURN_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const

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
  }
}

// ---------------------------------------------------------------------------
// Turn bookkeeping
// ---------------------------------------------------------------------------

interface TurnRun {
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
  abortTimer: NodeJS.Timeout | undefined
}

interface TurnOutcome {
  readonly stopReason: NativePromptResult['stopReason']
  readonly turn: JsonRecord | undefined
  readonly failure: NativeTransportError | undefined
  /** An error message already reached the transcript. */
  readonly errorShown: boolean
}

function newRun(): TurnRun {
  const completion = Promise.withResolvers<JsonRecord | undefined>()
  // A run can fail before anything awaits it (the process exits while `turn/start` is pending).
  completion.promise.catch(() => undefined)
  return {
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

/** Commands the transport implements itself (codex-acp built-ins that map onto one app-server call). */
const COMMANDS: readonly acp.AvailableCommand[] = [
  { name: 'plan', description: 'Turn plan mode on.', input: null },
  { name: 'skills', description: 'List available skills.', input: null },
  { name: 'status', description: 'Display session configuration and token usage.', input: null },
  {
    name: 'review',
    description: 'Review uncommitted changes, or review with custom instructions.',
    input: { hint: 'optional review instructions' },
  },
  { name: 'review-branch', description: 'Review changes relative to a base branch.', input: { hint: 'branch name' } },
  { name: 'review-commit', description: 'Review a specific commit.', input: { hint: 'commit sha' } },
  { name: 'compact', description: 'Summarize conversation to avoid hitting the context limit.', input: null },
  { name: 'rename', description: 'Rename the current session.', input: { hint: 'new name' } },
]

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

function codexUserInput(content: readonly NativeContentBlock[]): JsonRecord[] {
  return content.map((block) =>
    block.type === 'text'
      ? { type: 'text', text: block.text, text_elements: [] }
      : { type: 'image', url: `data:${block.mimeType};base64,${block.data}` },
  )
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

  private run: TurnRun | undefined
  private busy = false
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

  private readonly approvalHost: CodexApprovalHost = {
    context: {
      commandStarted: (itemId) => this.projection?.commandStarted(itemId) ?? false,
      commandName: (itemId) => this.projection?.commandName(itemId),
      fileChange: (itemId) => this.projection?.fileChange(itemId),
      popPendingMcpApproval: (serverName) => this.projection?.popPendingMcpApproval(serverName),
    },
    ask: (request, signal) => this.askPermission(request, signal),
    update: (update) => {
      this.sink.update(update)
    },
    nextStandaloneMcpToolCallId: (threadId, serverName) =>
      this.projection?.nextStandaloneMcpToolCallId(threadId, serverName) ?? `elicitation:${threadId}:${serverName}`,
    log: (message) => {
      this.log(message)
    },
  }

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
    const controller = new AbortController()
    this.pendingServerRequests.set(id, { method, controller })
    try {
      this.sendAnswer(id, await answerCodexServerRequest(method, params, this.approvalHost, controller.signal))
    } catch (error: unknown) {
      this.log(`codex: failed to answer server request ${method}: ${messageOf(error)}`)
      this.sendAnswer(id, fallbackCodexServerAnswer(method))
    } finally {
      this.pendingServerRequests.delete(id)
    }
  }

  private askPermission(request: NativePermissionRequest, signal: AbortSignal): Promise<NativePermissionDecision> {
    const handler = this.options?.onPermission
    if (handler === undefined || signal.aborted) return Promise.resolve({ cancelled: true })
    const { promise, resolve } = Promise.withResolvers<NativePermissionDecision>()
    let settled = false
    const finish = (decision: NativePermissionDecision): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve(decision)
    }
    const onAbort = (): void => {
      finish({ cancelled: true })
    }
    const onFailure = (error: unknown): void => {
      this.log(`codex: onPermission handler failed: ${messageOf(error)}`)
      finish({ cancelled: true })
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
    if (method === 'thread/started') return
    const threadId = readString(params, 'threadId') ?? readString(params, 'conversationId')
    // Until the session id is known only a resumed thread can be told apart; everything else waits.
    const scope = this.threadId ?? this.resumeTarget
    if (scope === undefined) return
    // Sub-agent threads share the connection; only this conversation maps to the host surface.
    if (threadId !== undefined && threadId !== scope) return
    switch (method) {
      case 'turn/started': {
        const turnId = readString(asRecord(params['turn']), 'id')
        const run = this.run
        if (turnId !== undefined && run !== undefined && run.turnId === undefined) this.identifyRun(run, turnId)
        return
      }
      case 'turn/completed': {
        this.projection?.endTurn()
        this.openToolCalls.clear()
        const turn = asRecord(params['turn'])
        const turnId = readString(turn, 'id')
        const run = this.run
        if (run !== undefined && turn !== undefined && turnId !== undefined) this.completeRun(run, turnId, turn)
        return
      }
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
      default:
        this.projection?.handle(method, params)
    }
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
  private async runTurn(start: () => Promise<unknown>, signal: AbortSignal): Promise<TurnOutcome> {
    const run = newRun()
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
      }
    } catch (error: unknown) {
      if (signal.aborted && this.exitError === undefined) {
        return { stopReason: 'cancelled', turn: undefined, failure: undefined, errorShown: false }
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
    if (this.closing) throw new NativeTransportError('Codex transport is closed', 'closed')
    if (this.exitError !== undefined) throw this.exitError
    if (this.threadId === undefined || this.controlsState === undefined) {
      throw new NativeTransportError('Codex transport was not started', 'not-started')
    }
    if (this.busy) throw new NativeTransportError('A Codex prompt is already in progress', 'busy')
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
    const command = parseSlashCommand(content)
    if (command !== undefined) {
      const handled = await this.tryCommand(command, signal)
      if (handled !== undefined) return handled
    }
    if (!state.imageInput && content.some((block) => block.type === 'image')) {
      throw new NativeTransportError('The current model does not support image input', 'image-unsupported')
    }
    const input = codexUserInput(content)
    tokens.beginPrompt()
    let outcome = await this.runTurn(() => this.startTurn(input), signal)
    this.throwOnFailure(outcome)
    if (outcome.stopReason === 'end_turn' && readString(outcome.turn, 'status') === 'completed') {
      outcome = (await this.implementApprovedPlan(signal)) ?? outcome
      this.throwOnFailure(outcome)
    }
    return this.promptResult(outcome)
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

  private startTurn(input: readonly JsonRecord[]): Promise<unknown> {
    const state = this.requireState()
    const threadId = this.threadId
    if (threadId === undefined) throw new NativeTransportError('Codex transport was not started', 'not-started')
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
    const decision = await this.askPermission(
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
      () => this.startTurn(codexUserInput([{ type: 'text', text: 'Implement the approved plan.' }])),
      signal,
    )
    return next
  }

  // -- slash commands ---------------------------------------------------------------

  private async tryCommand(
    command: { readonly name: string; readonly rest: string },
    signal: AbortSignal,
  ): Promise<NativePromptResult | undefined> {
    const state = this.requireState()
    const threadId = this.threadId
    if (threadId === undefined) return undefined
    switch (command.name) {
      case 'plan': {
        if (command.rest.length > 0) return this.commandMessage('Command "/plan" requires no arguments.')
        await this.applyCollaborationMode(state.collaborationMode === 'plan' ? 'default' : 'plan')
        this.emit({ kind: 'controls', controls: state.snapshot() })
        return { stopReason: 'end_turn' }
      }
      case 'status':
        return this.commandMessage(this.statusMessage(threadId))
      case 'skills': {
        const lines = (await this.listSkills()).map((skill) =>
          skill.description === '' ? `- ${skill.name}` : `- ${skill.name}: ${skill.description}`,
        )
        return this.commandMessage(lines.length > 0 ? ['Available skills:', ...lines].join('\n') : 'No skills configured.')
      }
      case 'compact':
        return await this.commandTurn(
          async () => {
            await this.request('thread/compact/start', { threadId }, REQUEST_TIMEOUT_MS)
            return undefined
          },
          signal,
          true,
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
      case 'rename':
        if (command.rest.length === 0) return this.commandMessage('Command "/rename" requires new name.')
        await this.request('thread/name/set', { threadId, name: command.rest }, REQUEST_TIMEOUT_MS)
        return { stopReason: 'end_turn' }
      default:
        return undefined
    }
  }

  /** codex-acp `buildStatusMessage`; rate limits are not queried, which the gateway setups do not report anyway. */
  private statusMessage(threadId: string): string {
    const state = this.requireState()
    const [tokenUsage, contextWindow] = this.requireTokens().statusLines()
    return [
      `**Model:** ${state.modelId}[${state.effort}]`,
      `**Directory:** ${this.options?.cwd ?? ''}`,
      `**Approval:** ${state.mode.settings.approvalPolicy}`,
      `**Sandbox:** ${state.mode.settings.sandboxMode}`,
      `**Account:** ${this.accountText}`,
      `**Session:** \`${threadId}\``,
      '',
      `**Token usage:** ${tokenUsage}`,
      `**Context window:** ${contextWindow}`,
      '**Limits:** data not available yet',
    ].join('  \n')
  }

  private commandMessage(text: string): NativePromptResult {
    this.sink.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
    return { stopReason: 'end_turn' }
  }

  private reviewCommand(target: JsonRecord, signal: AbortSignal): Promise<NativePromptResult> {
    const threadId = this.threadId
    if (threadId === undefined) throw new NativeTransportError('Codex transport was not started', 'not-started')
    return this.commandTurn(() => this.request('review/start', { threadId, target, delivery: 'inline' }, REQUEST_TIMEOUT_MS), signal, false)
  }

  /** A command that runs as its own turn (review, compaction); usage is counted like a prompt's. */
  private async commandTurn(
    start: () => Promise<unknown>,
    signal: AbortSignal,
    mayStartNoTurn: boolean,
  ): Promise<NativePromptResult> {
    this.requireTokens().beginPrompt()
    const outcome = await this.runTurn(async () => {
      const response = await start()
      if (mayStartNoTurn) {
        const run = this.run
        if (run !== undefined) {
          // A compaction answers before its turn exists; if none ever starts there is nothing to wait for.
          const timer = setTimeout(() => {
            if (run.turnId === undefined && !run.finished) run.completion.resolve({ status: 'completed' })
          }, COMPACTION_START_GRACE_MS)
          timer.unref()
        }
      }
      return response
    }, signal)
    this.throwOnFailure(outcome)
    return this.promptResult(outcome)
  }

  // -- steering ---------------------------------------------------------------------

  async steer(content: readonly NativeContentBlock[], signal?: AbortSignal): Promise<'injected' | 'promptRequired'> {
    if (this.closing || this.exitError !== undefined || signal?.aborted === true) return 'promptRequired'
    const state = this.controlsState
    const threadId = this.threadId
    const run = this.run
    if (state === undefined || threadId === undefined || run === undefined || content.length === 0) return 'promptRequired'
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

  // -- commands advertised to the host ----------------------------------------------------

  private publishCommands(): void {
    if (this.closed) return
    this.emitCommands(COMMANDS)
    void this.publishSkills()
  }

  private emitCommands(commands: readonly acp.AvailableCommand[]): void {
    this.emit({ kind: 'update', update: { sessionUpdate: 'available_commands_update', availableCommands: [...commands] } })
  }

  /** The skills Codex offers for the session directory (`skills/list`, as codex-acp asks for its cwd). */
  private async listSkills(): Promise<Array<{ readonly name: string; readonly description: string }>> {
    const cwd = this.options?.cwd
    if (cwd === undefined) return []
    const response = await this.request('skills/list', { cwds: [cwd] }, SKILLS_TIMEOUT_MS)
    const skills: Array<{ readonly name: string; readonly description: string }> = []
    for (const entry of readArray(asRecord(response), 'data') ?? []) {
      for (const skill of readArray(asRecord(entry), 'skills') ?? []) {
        const record = asRecord(skill)
        const name = readString(record, 'name')
        if (name === undefined) continue
        skills.push({
          name,
          description: readString(record, 'shortDescription') ?? readString(record, 'description') ?? '',
        })
      }
    }
    return skills
  }

  /** Skills are `$name` commands; listing them is best-effort. */
  private async publishSkills(): Promise<void> {
    try {
      const commands: acp.AvailableCommand[] = [...COMMANDS]
      for (const skill of await this.listSkills()) {
        const name = `$${skill.name}`
        if (commands.some((candidate) => candidate.name === name)) continue
        commands.push({ name, description: skill.description === '' ? skill.name : skill.description, input: null })
      }
      if (commands.length > COMMANDS.length && !this.closed) this.emitCommands(commands)
    } catch (error: unknown) {
      this.log(`codex: skills/list failed: ${messageOf(error)}`)
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
