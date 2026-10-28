/// <reference types="node" />
/**
 * Native agent session runtime.
 *
 * Drives one vendor-native transport (OMP rpc-ui, Codex app-server, Claude Code stream-json)
 * behind the same runtime surface `AcpProfileAdapter` consumes from `AcpSessionRuntime`, so
 * bindings, saved mode intents, the model picker, projections, approvals and statistics keep
 * working while steering, per-turn usage and context occupancy flow. The transports already
 * report what the vendor's own ACP agent would (session ids, controls, tool calls); this
 * class owns the lifecycle the adapter expects around them:
 *
 * - `start` / `restore` / `fork` attach a transport to a new, an existing or a forked vendor
 *   session; a closed or failed transport is never restarted, a fresh one is created;
 * - controls are read live from the transport (never cached across writes), kept inside the
 *   mode contract of `session-modes.ts`, and every change is announced as the ACP
 *   `config_option_update` / `current_mode_update` notification;
 * - one prompt at a time; transport updates are fanned out to the prompt listener and the
 *   runtime's own `onSessionUpdate` hook exactly like the ACP connection fans out
 *   `session/update`;
 * - permission requests are bridged to the host approval service in ACP shape, and forms the
 *   agent puts to the user (questions, dialogs, MCP elicitations) to the host's form
 *   elicitation bridge, both only while a turn runs;
 *
 * Launch environment, working directory and process ownership come from the host
 * (`prepareLaunch`, the subprocess seam); this module never reads the host environment.
 */
import type * as acp from '@agentclientprotocol/sdk'

import { acpConfigOptionsSnapshot } from '../../protocol/v1/config-options.ts'
import type { AcpSessionNotification } from '../../protocol/v1/types.ts'
import {
  AcpForkPreDispatchError,
  type AcpRuntimeBindingRef,
  type AcpRuntimeContextUsage,
  type AcpSessionRuntimeOptions,
} from '../session/session-runtime.ts'
import { prepareNativeLaunch, type NativeLaunch } from './launch.ts'
import { staticNativeCommands } from './native-commands.ts'
import { nativeSpawnFromSeam } from './native-spawn.ts'
import { isModeOption, withNativeModeContract } from './session-modes.ts'
import {
  NativeTransportError,
  type NativeCommand,
  type NativeCommandResult,
  type NativeContentBlock,
  type NativeContextUsage,
  type NativeControls,
  type NativeElicitationRequest,
  type NativePermissionDecision,
  type NativePermissionRequest,
  type NativeProcess,
  type NativeSessionTarget,
  type NativeSpawn,
  type NativeTransport,
  type NativeTransportEvent,
  type NativeTransportKind,
  type NativeTurnUsage,
} from './transports/contract.ts'

/** What the host hears about the vendor conversation besides its turn updates. */
export interface NativeSessionRuntimeHooks {
  /** The vendor's command catalog changed; `commands` is the full new list. */
  readonly onCommandsChanged?: ((commands: readonly NativeCommand[]) => void) | undefined
  /**
   * The vendor replaced the conversation (`/clear`, a new thread or session) or rolled it back where it stood
   * (`rewind`): `acpSessionId` already answers with `sessionId`. After a replacement resuming the old id would bring
   * back the context the user cleared; after a rewind `sessionId` is the id the conversation had before, and the
   * messages the user rewound must not be taken for messages the agent still holds.
   */
  readonly onSessionChanged?: ((sessionId: string, reason: string) => void) | undefined
}

/** What a native runtime needs from the host; structurally the relevant part of `AcpSessionRuntimeOptions`. */
export interface NativeSessionRuntimeOptions
  extends NativeSessionRuntimeHooks,
    Pick<
      AcpSessionRuntimeOptions,
      | 'config'
      | 'cwd'
      | 'subprocess'
      | 'prepareLaunch'
      | 'onSessionUpdate'
      | 'onPermissionRequest'
      | 'onPermissionCheck'
      | 'onElicitationRequest'
      | 'cancelGraceMs'
    > {
  /** Creates one fresh, unstarted transport. A transport that was started is never started again. */
  readonly createTransport: () => NativeTransport
  /** Host log sink for transport notices. */
  readonly log?: ((message: string) => void) | undefined
  /** Upper bound of one side question or immediate command; the transport call is aborted when it passes. */
  readonly sideCallTimeoutMs?: number | undefined
}

/** After a Stop the transport owns the interrupt ladder; the runtime only bounds a transport that never settles. */
const CANCEL_BACKSTOP_MS = 60_000

/** The longest a side question or an immediate command may take before the runtime aborts the transport call. */
const SIDE_CALL_TIMEOUT_MS = 120_000

/** The longest the runtime waits for a transport to end its process before the host terminates the tree. */
const CLOSE_BACKSTOP_MS = 15_000

/**
 * Session ids minted by the first native preview (`native-<kind>-<uuid>`). They never named a
 * vendor session, so no vendor can resume them.
 */
const PREVIEW_SESSION_ID = /^native-(?:omp|codex|claude)-[0-9a-f-]{36}$/i

/** Whether an ACP binding names a session of the first native preview, whose ids no vendor ever issued. */
export function isNativePreviewSessionId(sessionId: string): boolean {
  return PREVIEW_SESSION_ID.test(sessionId)
}

/**
 * Whether a `session_changed` of this reason changes the conversation without changing its id: the vendor rolled the
 * conversation back where it stood (`/rewind` in Claude Code and Codex). Every other replacement starts a session with
 * an id of its own, so the id the runtime already holds is a repeat of an event it has heard, not a change.
 */
export function replacesSessionInPlace(reason: string): boolean {
  return reason === 'rewind'
}

/** The `/mcp:<server>:<command> <args>` prompt form claude-agent-acp rewrites for Claude Code. */
const CLAUDE_MCP_COMMAND = /^\/mcp:([^:\s]+):(\S+)(?:\s(.*))?$/

function fileLink(uri: string, name: string | null | undefined): string {
  if (name != null && name !== '') return `[@${name}](${uri})`
  if (!uri.startsWith('file://')) return uri
  const path = uri.slice('file://'.length)
  return `[@${path.split('/').pop() || path}](${uri})`
}

/**
 * ACP prompt blocks → native content. Text and images map one to one; resources are rendered
 * as text the way the vendors' ACP agents present them, so no text is ever dropped.
 */
export function toNativeContent(content: readonly acp.ContentBlock[], kind: NativeTransportKind): NativeContentBlock[] {
  const blocks: NativeContentBlock[] = []
  const text = (value: string): void => {
    blocks.push({ type: 'text', text: value })
  }
  for (const block of content) {
    switch (block.type) {
      case 'text': {
        const mcp = kind === 'claude' ? CLAUDE_MCP_COMMAND.exec(block.text) : null
        text(mcp === null ? block.text : `/${mcp[1]}:${mcp[2]} (MCP)${mcp[3] ? ` ${mcp[3]}` : ''}`)
        break
      }
      case 'image':
        if (block.data !== '') blocks.push({ type: 'image', data: block.data, mimeType: block.mimeType })
        else if (block.uri != null && block.uri !== '') text(block.uri)
        break
      case 'resource_link':
        text(fileLink(block.uri, block.name))
        break
      case 'resource': {
        const resource = block.resource
        if ('text' in resource)
          text(`${fileLink(resource.uri, null)}\n<context ref="${resource.uri}">\n${resource.text}\n</context>`)
        else if (resource.mimeType?.startsWith('image/') === true)
          blocks.push({ type: 'image', data: resource.blob, mimeType: resource.mimeType })
        else text(`[embedded resource: ${resource.uri}]`)
        break
      }
      case 'audio':
        text('[audio omitted]')
        break
    }
  }
  return blocks
}

const count = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined

/** Whole-turn native usage → ACP `Usage` (`totalTokens` is the sum of the four token counts, as DSH folds it). */
function acpUsageOf(usage: NativeTurnUsage | undefined): acp.Usage | undefined {
  if (usage === undefined) return undefined
  const inputTokens = count(usage.inputTokens)
  const outputTokens = count(usage.outputTokens)
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  const cachedReadTokens = count(usage.cachedReadTokens) ?? 0
  const cachedWriteTokens = count(usage.cachedWriteTokens) ?? 0
  const thoughtTokens = count(usage.thoughtTokens)
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens + cachedReadTokens + cachedWriteTokens,
    cachedReadTokens,
    cachedWriteTokens,
    ...(thoughtTokens === undefined ? {} : { thoughtTokens }),
  }
}

/** ACP tool updates are top-level patches; keep the fields that make a later permission request understandable. */
function mergeToolCall(previous: acp.ToolCallUpdate | undefined, patch: acp.ToolCallUpdate): acp.ToolCallUpdate {
  const next: acp.ToolCallUpdate = { ...previous, toolCallId: patch.toolCallId }
  if (patch.kind !== undefined) next.kind = patch.kind
  if (patch.status !== undefined) next.status = patch.status
  if (patch.title != null) next.title = patch.title
  if (patch.name != null) next.name = patch.name
  if (patch.content !== undefined) next.content = patch.content
  if (patch.locations !== undefined) next.locations = patch.locations
  if (patch.rawInput !== undefined) next.rawInput = patch.rawInput
  if (patch.rawOutput !== undefined) next.rawOutput = patch.rawOutput
  if (patch._meta !== undefined) next._meta = patch._meta
  return next
}

/** ACP adapter packages and vendor CLIs name the same agent differently (`@agentclientprotocol/codex-acp` / `codex`). */
function vendorOf(name: string): string {
  return (name.split('/').pop() ?? name)
    .toLowerCase()
    .replace(/-acp$/, '')
    .replace(/-agent$/, '')
}

/**
 * Whether the agent now behind this runtime is the one a parent binding recorded. Names are
 * compared by vendor; versions only within one product (an ACP adapter's package version says
 * nothing about the CLI it drives), and parts the transport cannot know yet are skipped.
 */
function sameAgent(
  expected: { readonly name?: string; readonly version?: string } | undefined,
  actual: { readonly name: string; readonly version: string },
): boolean {
  if (expected === undefined) return true
  if (expected.name !== undefined && actual.name !== '' && vendorOf(expected.name) !== vendorOf(actual.name))
    return false
  return !(
    expected.version !== undefined &&
    expected.name === actual.name &&
    actual.version !== '' &&
    expected.version !== actual.version
  )
}

interface ControlsState {
  readonly configOptions: acp.SessionConfigOption[]
  readonly modes: acp.SessionModeState | undefined
  readonly currentModeId: string | undefined
  readonly imageInput: boolean
}

/** Bounded, detached controls inside the mode contract; throws when the vendor's options are unusable. */
function deriveControls(kind: NativeTransportKind, source: NativeControls): ControlsState {
  const controls = withNativeModeContract(kind, source)
  const configOptions = acpConfigOptionsSnapshot(controls.configOptions) ?? []
  const modeOption = configOptions.find(isModeOption)
  return {
    configOptions,
    modes:
      controls.modes === undefined
        ? undefined
        : { ...controls.modes, availableModes: controls.modes.availableModes.map((mode) => ({ ...mode })) },
    currentModeId: modeOption?.type === 'select' ? modeOption.currentValue : controls.modes?.currentModeId,
    imageInput: controls.imageInput,
  }
}

/** A call instead of a property read: `signal.aborted` is narrowed away by earlier checks although it can flip across awaits. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

async function raceAbort<T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return await pending
  signal.throwIfAborted()
  const { promise: aborted, reject } = Promise.withResolvers<never>()
  const onAbort = (): void => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([pending, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

const sideFailure = (text: string): NativeCommandResult => ({ kind: 'error', text })

/** A transport's answer to a side call, checked at the boundary: whatever else it returned is a failure, not text. */
function sideResult(value: unknown): NativeCommandResult {
  if (typeof value === 'object' && value !== null && 'kind' in value && 'text' in value) {
    const { kind, text } = value
    if ((kind === 'success' || kind === 'error') && typeof text === 'string') return { kind, text }
  }
  return sideFailure('The agent answered in a form the host cannot read.')
}

/** The host-owned processes one transport spawned, and how many of them still run. */
interface ProcessTracker {
  readonly agents: NativeProcess[]
  running: number
}

/** End a transport, giving up waiting (not on the close itself) after `ms`. */
async function closeWithin(transport: NativeTransport, ms: number): Promise<void> {
  const { promise: expired, resolve } = Promise.withResolvers<void>()
  const timer = setTimeout(resolve, ms)
  timer.unref()
  try {
    await Promise.race([transport.close(), expired])
  } finally {
    clearTimeout(timer)
  }
}

/** One native agent conversation projected onto the ACP runtime contract. */
export class NativeSessionRuntime {
  readonly protocolVersion = 1

  private transport: NativeTransport
  /** `transport.start()` ran on the current instance, so it must not be started again. */
  private transportUsed = false
  private attachedSessionId: string | undefined
  /** Session id events can already be addressed to while a resume is still attaching. */
  private startupSessionId: string | undefined
  /** Processes the current transport spawned through the host: the runtime's own view of whether its agent is alive. */
  private tracker: ProcessTracker | undefined
  private startup: Promise<void> | undefined
  private closing: Promise<void> | undefined
  /** Bumped by `close()`; work started under an older epoch must not publish its result. */
  private epoch = 0
  private promptClaimed = false
  private promptActive = false
  private promptAbort: AbortController | undefined
  /** Permission requests and forms the user has not answered yet; steering waits for them like ACP does. */
  private pendingQuestions = 0
  private promptSignal: AbortSignal | undefined
  private promptListener: ((notification: AcpSessionNotification) => void) | undefined
  private readonly toolSnapshots = new Map<string, acp.ToolCallUpdate>()
  private configWrite: Promise<void> = Promise.resolve()
  private lastControls: ControlsState | undefined
  private announcedOptions: string | undefined
  private announcedMode: string | undefined
  private contextEvent: NativeContextUsage | undefined
  private listenerFailureLogged = false
  /** The catalog the vendor announced last; only a transport without its own `commands()` needs it. */
  private announcedCommands: readonly NativeCommand[] | undefined
  /** Side questions and immediate commands in flight: they end with the transport, not with a turn. */
  private readonly sideCalls = new Set<AbortController>()

  constructor(private readonly options: NativeSessionRuntimeOptions) {
    this.transport = options.createTransport()
  }

  get acpSessionId(): string | undefined {
    return this.attachedSessionId
  }

  get agentInfo(): acp.Implementation | undefined {
    if (this.attachedSessionId === undefined) return undefined
    const { name, version } = this.transport.agentInfo
    return { name, version }
  }

  /**
   * What the vendors' ACP agents advertise. Before a session exists the model is unknown, so
   * image input is offered the way the ACP agents offer it; afterwards it follows the model.
   */
  get agentCapabilities(): acp.AgentCapabilities {
    return {
      loadSession: true,
      promptCapabilities: { image: this.controlsState()?.imageInput ?? true, embeddedContext: true },
      sessionCapabilities: { resume: {}, ...(this.transport.canFork ? { fork: {} } : {}) },
    }
  }

  /** Positive image-input proof belongs to a live session only. */
  get inputImageSupported(): boolean | undefined {
    return this.transportClosed() ? undefined : this.controlsState()?.imageInput
  }

  /** Declared even before a session exists: the adapter distinguishes "no controls yet" from "no such member". */
  get configOptions(): readonly acp.SessionConfigOption[] | undefined {
    return this.controlsState()?.configOptions
  }

  get modes(): acp.SessionModeState | undefined {
    return this.controlsState()?.modes
  }

  get currentModeId(): string | undefined {
    return this.controlsState()?.currentModeId
  }

  get contextUsage(): AcpRuntimeContextUsage | undefined {
    if (this.attachedSessionId === undefined) return undefined
    const usage = this.transport.contextUsage() ?? this.contextEvent
    if (usage === undefined) return undefined
    return {
      used: usage.used,
      size: usage.size,
      ...(usage.cost === undefined ? {} : { cost: { amount: usage.cost.amount, currency: usage.cost.currency } }),
    }
  }

  get isBusy(): boolean {
    return this.promptClaimed
  }

  /** Steering is meaningful only inside a running turn. */
  get canSteer(): boolean {
    return this.promptActive && this.attachedSessionId !== undefined && this.pendingQuestions === 0
  }

  hasPendingHostCalls(): boolean {
    return false
  }

  hasUncommittedHostFeedback(): boolean {
    return false
  }

  hasRetainedHostFeedback(): boolean {
    return false
  }

  /** There is no process to negotiate with before a session exists. */
  async initialize(): Promise<void> {}

  async start(signal?: AbortSignal): Promise<void> {
    let lost: string | undefined
    for (;;) {
      await this.quiesce()
      const held = this.attachedSessionId
      if (held !== undefined) {
        if (!this.transportClosed()) return
        // The agent process behind the held session is gone: bring that same session back, never a blank one.
        lost = held
        await this.shutdown(false)
        continue
      }
      // No await between this check and attach() registering its startup.
      if (this.startup === undefined) break
    }
    await this.attach(lost === undefined ? { kind: 'new' } : { kind: 'resume', sessionId: lost }, signal)
  }

  /**
   * Re-attach to the vendor session a binding names. A live session this runtime already holds
   * is reused; a closed transport, or a cold runtime, resumes the session in a fresh process.
   */
  async restore(binding: AcpRuntimeBindingRef, signal?: AbortSignal): Promise<'reused' | 'resumed' | 'loaded'> {
    if (this.promptClaimed) throw new Error('ACP_PROMPT_ALREADY_ACTIVE')
    await this.quiesce()
    if (this.attachedSessionId !== undefined && this.transportClosed()) await this.close()
    if (this.attachedSessionId !== undefined) {
      if (binding.agentSessionId !== this.attachedSessionId)
        throw new Error('ACP binding session id does not match the active runtime')
      return 'reused'
    }
    // The first native preview recorded ids no vendor ever knew: no process can resume them.
    if (isNativePreviewSessionId(binding.agentSessionId))
      throw new NativeTransportError(
        `native session not found: "${binding.agentSessionId}" was recorded by an early native preview and never named a vendor session`,
        'session-not-found',
      )
    await this.attach({ kind: 'resume', sessionId: binding.agentSessionId }, signal)
    return 'resumed'
  }

  /**
   * Create a child vendor session from an already-bound parent. `AcpForkPreDispatchError`
   * proves nothing was dispatched; every other failure leaves the remote outcome unknown.
   */
  async fork(
    parentSessionId: string,
    signal?: AbortSignal,
    expected?: {
      readonly agent?: { readonly name?: string; readonly version?: string }
      readonly protocolVersion?: number
    },
    beforeDispatch?: () => Promise<void>,
  ): Promise<acp.ForkSessionResponse> {
    if (this.attachedSessionId !== undefined) throw new Error('ACP runtime already owns a session')
    await this.quiesce()
    try {
      if (!this.transport.canFork || isNativePreviewSessionId(parentSessionId))
        throw new AcpForkPreDispatchError('ACP_FORK_UNSUPPORTED')
      if (
        (expected?.protocolVersion !== undefined && expected.protocolVersion !== this.protocolVersion) ||
        !sameAgent(expected?.agent, this.transport.agentInfo)
      )
        throw new AcpForkPreDispatchError('ACP_FORK_PRECONDITION_FAILED')
      // Host-side launch failures happen before the fork intent is recorded, like an ACP initialize failure.
      const launch = await this.prepare().catch((error: unknown) => {
        throw new AcpForkPreDispatchError('ACP_FORK_PRECONDITION_FAILED', error)
      })
      try {
        await beforeDispatch?.()
      } catch (error) {
        throw new AcpForkPreDispatchError('ACP_FORK_INTENT_FAILED', error)
      }
      await this.attach({ kind: 'fork', parentSessionId }, signal, launch)
      const sessionId = this.attachedSessionId
      if (sessionId === undefined || sessionId === parentSessionId) throw new Error('ACP_FORK_INVALID_RESPONSE')
      const state = this.controlsState()
      return {
        sessionId,
        ...(state === undefined ? {} : { configOptions: state.configOptions }),
        ...(state?.modes === undefined ? {} : { modes: state.modes }),
      }
    } catch (error) {
      await this.close().catch(() => undefined)
      throw error
    }
  }

  async prompt(
    content: acp.ContentBlock[],
    onUpdate: (notification: AcpSessionNotification) => void,
    signal?: AbortSignal,
  ): Promise<acp.PromptResponse> {
    if (this.promptClaimed) throw new Error('ACP_PROMPT_ALREADY_ACTIVE')
    // Claim synchronously: nothing between here and the dispatch may let a second prompt in.
    this.promptClaimed = true
    const lifetime = new AbortController()
    this.promptAbort = lifetime
    try {
      const blocks = toNativeContent(content, this.transport.kind)
      if (blocks.length === 0) throw new Error('dsh-acp: the prompt carries no content the native agent can receive')
      if (isAborted(signal)) return { stopReason: 'cancelled' }
      // Finish already admitted setting changes before this turn is sent.
      await this.configWrite
      const turnSignal = signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal])
      if (isAborted(turnSignal)) return { stopReason: 'cancelled' }
      await this.start(turnSignal)
      if (isAborted(turnSignal)) return { stopReason: 'cancelled' }
      const transport = this.transport
      if (this.attachedSessionId === undefined) throw new Error('ACP session is not started')
      this.toolSnapshots.clear()
      this.promptSignal = turnSignal
      this.promptListener = onUpdate
      this.promptActive = true
      let backstop: NodeJS.Timeout | undefined
      const armBackstop = (): void => {
        if (backstop !== undefined) return
        backstop = setTimeout(() => void this.close(), this.options.cancelGraceMs ?? CANCEL_BACKSTOP_MS)
        backstop.unref()
      }
      signal?.addEventListener('abort', armBackstop, { once: true })
      if (isAborted(signal)) armBackstop()
      try {
        const result = await transport.prompt(blocks, turnSignal)
        this.reconcileControls()
        const usage = acpUsageOf(result.usage)
        return { stopReason: result.stopReason, ...(usage === undefined ? {} : { usage }) }
      } finally {
        signal?.removeEventListener('abort', armBackstop)
        clearTimeout(backstop)
      }
    } finally {
      this.promptActive = false
      this.promptListener = undefined
      this.promptSignal = undefined
      this.toolSnapshots.clear()
      lifetime.abort(new Error('ACP prompt lifetime ended'))
      if (this.promptAbort === lifetime) this.promptAbort = undefined
      this.promptClaimed = false
    }
  }

  /** Inject a message into the running turn; `onDispatch` fires immediately before the transport is handed the request. */
  async steer(content: acp.ContentBlock[], onDispatch?: () => void): Promise<'injected' | 'promptRequired'> {
    if (!this.canSteer) return 'promptRequired'
    const blocks = toNativeContent(content, this.transport.kind)
    if (blocks.length === 0) return 'promptRequired'
    onDispatch?.()
    return await this.transport.steer(blocks, this.promptSignal)
  }

  /**
   * The slash commands of this agent: the transport's own catalog (its built-ins merged with what the vendor
   * reported), else the last catalog the vendor announced, else the built-ins of its kind. A runtime that has not
   * started yet still lists the built-ins, so a session can offer its commands before any agent process exists.
   */
  commands(): readonly NativeCommand[] {
    try {
      const own = this.transport.commands?.()
      if (own !== undefined) return own
    } catch {
      /* a transport that cannot list its commands yet shows the built-ins */
    }
    return this.announcedCommands ?? staticNativeCommands(this.transport.kind)
  }

  /**
   * Run one `immediate` vendor command outside any turn. A side call claims no prompt slot and touches neither the
   * turn's listener, its tool snapshots nor the controls, so it may run while a prompt runs. It always answers with
   * a result: a missing transport method, a session that is not attached and a failing call say so in `text`.
   */
  async runCommand(name: string, args: string, signal?: AbortSignal): Promise<NativeCommandResult> {
    return await this.sideCall('commands that run outside a turn', signal, (transport, callSignal) =>
      transport.runCommand?.(name, args, callSignal),
    )
  }

  /** Answer a side question (`/btw`) from the current conversation without adding to it; see {@link runCommand}. */
  async sideQuestion(question: string, signal?: AbortSignal): Promise<NativeCommandResult> {
    return await this.sideCall('side questions', signal, (transport, callSignal) =>
      transport.sideQuestion?.(question, callSignal),
    )
  }

  /**
   * One call into the transport that is not part of a turn. It ends with the caller's signal, the time limit or the
   * runtime's close, whichever comes first, and a transport that ignores the signal is abandoned rather than awaited.
   */
  private async sideCall(
    what: string,
    signal: AbortSignal | undefined,
    start: (transport: NativeTransport, signal: AbortSignal) => Promise<NativeCommandResult> | undefined,
  ): Promise<NativeCommandResult> {
    const transport = this.transport
    if (this.attachedSessionId === undefined || this.transportClosed())
      return sideFailure('The agent is not running in this session yet; send a message first.')
    const lifetime = new AbortController()
    this.sideCalls.add(lifetime)
    const limit = this.options.sideCallTimeoutMs ?? SIDE_CALL_TIMEOUT_MS
    let expired = false
    const timer = setTimeout(() => {
      expired = true
      lifetime.abort(new Error('the side call timed out'))
    }, limit)
    timer.unref()
    const callSignal = signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal])
    try {
      const pending = start(transport, callSignal)
      if (pending === undefined) return sideFailure(`This agent (${transport.kind}) cannot run ${what}.`)
      return sideResult(await raceAbort(pending, callSignal))
    } catch (error) {
      if (expired) {
        const waited = limit % 1000 === 0 ? `${String(limit / 1000)} s` : `${String(limit)} ms`
        return sideFailure(`The agent did not answer within ${waited}; the request was cancelled.`)
      }
      if (isAborted(signal)) return sideFailure('The request was cancelled.')
      if (isAborted(lifetime.signal)) return sideFailure('The agent session ended before it answered.')
      return sideFailure(error instanceof Error ? error.message : String(error))
    } finally {
      clearTimeout(timer)
      this.sideCalls.delete(lifetime)
    }
  }

  /** Set one session control; writes are serialized and the snapshot reflects the change when the promise resolves. */
  async setConfigOption(configId: string, value: string | boolean, signal?: AbortSignal): Promise<void> {
    if (this.promptClaimed) throw new Error('ACP_CONFIG_CHANGE_DURING_PROMPT')
    if (this.attachedSessionId === undefined) throw new Error('ACP session is not started')
    const transport = this.transport
    const epoch = this.epoch
    const run = this.configWrite.then(async () => {
      signal?.throwIfAborted()
      if (transport !== this.transport || epoch !== this.epoch) throw new Error('ACP configuration connection changed')
      await transport.setConfigOption(configId, value, signal)
      if (transport !== this.transport || epoch !== this.epoch) throw new Error('ACP configuration connection changed')
      this.reconcileControls()
    })
    this.configWrite = run.catch(() => undefined)
    await run
  }

  /** Set the legacy ACP mode: the mode control is the vendor's `mode` option. */
  async setMode(modeId: string, signal?: AbortSignal): Promise<void> {
    if (this.promptClaimed) throw new Error('ACP_CONFIG_CHANGE_DURING_PROMPT')
    if (this.attachedSessionId === undefined) throw new Error('ACP session is not started')
    const option = this.controlsState()?.configOptions.find(isModeOption)
    if (option === undefined) throw new Error('ACP agent does not expose a mode control')
    await this.setConfigOption(option.id, modeId, signal)
  }

  close(): Promise<void> {
    return this.shutdown(true)
  }

  /**
   * End the current transport. A caller that retires a dead agent in the middle of its own turn setup keeps
   * the turn alive (`abortPrompt` false); an explicit close ends whatever turn is running.
   */
  private shutdown(abortPrompt: boolean): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.epoch += 1
    if (abortPrompt) this.promptAbort?.abort(new Error('ACP session runtime closed'))
    // A side call belongs to the agent process that is going away: it ends with it, not after it.
    for (const call of [...this.sideCalls]) call.abort(new Error('ACP session runtime closed'))
    this.announcedCommands = undefined
    const transport = this.transport
    const tracker = this.tracker
    const startup = this.startup
    const used = this.transportUsed
    this.attachedSessionId = undefined
    this.startupSessionId = undefined
    this.tracker = undefined
    this.lastControls = undefined
    this.announcedOptions = undefined
    this.announcedMode = undefined
    this.contextEvent = undefined
    const closing = (async () => {
      if (used) await this.retire(transport, tracker)
      // An attach that was still in flight fails once its transport is closed.
      await startup?.catch(() => undefined)
    })()
    this.closing = closing
    const clear = (): void => {
      if (this.closing === closing) this.closing = undefined
    }
    closing.then(clear, clear)
    return closing
  }

  /**
   * The agent behind the current transport can take no further turn: every process the transport spawned
   * exited (the host spawner reports it, whatever the transport knows), or the transport says it is closed.
   */
  private transportClosed(): boolean {
    const tracker = this.tracker
    if (tracker !== undefined && tracker.agents.length > 0 && tracker.running === 0) return true
    const transport: object = this.transport
    return 'closed' in transport && transport.closed === true
  }

  /** End the transport within a bound; whatever it did, the host-owned process tree must not outlive the session. */
  private async retire(transport: NativeTransport, tracker: ProcessTracker | undefined): Promise<void> {
    try {
      await closeWithin(transport, CLOSE_BACKSTOP_MS)
    } catch (error) {
      this.options.log?.(`native agent did not close cleanly: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      for (const agent of tracker?.agents ?? []) agent.terminate()
    }
  }

  private async quiesce(): Promise<void> {
    while (this.closing !== undefined || this.startup !== undefined)
      await Promise.allSettled([this.closing, this.startup])
  }

  private prepare(): Promise<NativeLaunch> {
    return prepareNativeLaunch({
      kind: this.transport.kind,
      config: this.options.config,
      cwd: this.options.cwd,
      prepareLaunch: this.options.prepareLaunch,
    })
  }

  /** Single-flight attach of the current transport to a vendor session. */
  private attach(target: NativeSessionTarget, signal: AbortSignal | undefined, launch?: NativeLaunch): Promise<void> {
    const run = this.performAttach(target, signal, launch)
    this.startup = run
    const clear = (): void => {
      if (this.startup === run) this.startup = undefined
    }
    run.then(clear, clear)
    return run
  }

  private async performAttach(
    target: NativeSessionTarget,
    signal: AbortSignal | undefined,
    prepared: NativeLaunch | undefined,
  ): Promise<void> {
    signal?.throwIfAborted()
    const epoch = this.epoch
    const current = (): void => {
      if (epoch !== this.epoch) throw new Error('ACP runtime closed during startup')
      signal?.throwIfAborted()
    }
    if (this.transportUsed) this.transport = this.options.createTransport()
    const transport = this.transport
    const tracker: ProcessTracker = { agents: [], running: 0 }
    this.tracker = tracker
    let started: Promise<void> | undefined
    this.startupSessionId = target.kind === 'resume' ? target.sessionId : undefined
    try {
      const launch = prepared ?? (await this.prepare())
      current()
      const hostSpawn = nativeSpawnFromSeam(this.options.subprocess)
      const spawn: NativeSpawn = (spec) => {
        const agent = hostSpawn(spec)
        tracker.agents.push(agent)
        tracker.running += 1
        const gone = (): void => {
          tracker.running -= 1
        }
        agent.exited.then(gone, gone)
        return agent
      }
      this.transportUsed = true
      started = transport.start({
        argv: launch.argv,
        env: launch.env,
        cwd: this.options.cwd,
        spawn,
        session: target,
        onEvent: (event) => this.handleEvent(transport, event),
        onPermission: (request, requestSignal) => this.answerPermission(transport, request, requestSignal),
        ...(this.options.onElicitationRequest === undefined
          ? {}
          : {
              onElicitation: (request: NativeElicitationRequest, requestSignal?: AbortSignal) =>
                this.answerElicitation(transport, request, requestSignal),
            }),
        log: this.options.log,
      })
      await raceAbort(started, signal)
      current()
      const sessionId = transport.sessionId
      if (sessionId === undefined || sessionId === '')
        throw new NativeTransportError('the native agent did not report a session id', 'protocol-error')
      if (target.kind === 'resume' && sessionId !== target.sessionId)
        throw new NativeTransportError(
          `the native agent resumed session ${sessionId} instead of ${target.sessionId}`,
          'protocol-error',
        )
      const state = deriveControls(transport.kind, transport.controls())
      this.lastControls = state
      this.announcedOptions = JSON.stringify(state.configOptions)
      this.announcedMode = state.currentModeId
      this.attachedSessionId = sessionId
    } catch (error) {
      // The transport owns its process: nothing may outlive a failed attach.
      started?.catch(() => undefined)
      if (started !== undefined) await this.retire(transport, tracker)
      throw error
    } finally {
      this.startupSessionId = undefined
    }
  }

  /** Live controls inside the mode contract; the last good snapshot stands in when the transport's options are unusable. */
  private controlsState(): ControlsState | undefined {
    if (this.attachedSessionId === undefined) return undefined
    try {
      this.lastControls = deriveControls(this.transport.kind, this.transport.controls())
    } catch {
      /* keep the last good snapshot */
    }
    return this.lastControls
  }

  /** Announce whatever changed in the controls since the last announcement. */
  private reconcileControls(): void {
    const state = this.controlsState()
    if (state === undefined) return
    const options = JSON.stringify(state.configOptions)
    if (options !== this.announcedOptions) {
      this.announcedOptions = options
      this.deliver({ sessionUpdate: 'config_option_update', configOptions: state.configOptions })
    }
    if (state.currentModeId !== this.announcedMode) {
      this.announcedMode = state.currentModeId
      if (state.currentModeId !== undefined)
        this.deliver({ sessionUpdate: 'current_mode_update', currentModeId: state.currentModeId })
    }
  }

  private handleEvent(transport: NativeTransport, event: NativeTransportEvent): void {
    if (transport !== this.transport) return
    try {
      switch (event.kind) {
        case 'update': {
          const update = event.update
          if (this.promptActive && (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update'))
            this.toolSnapshots.set(update.toolCallId, mergeToolCall(this.toolSnapshots.get(update.toolCallId), update))
          this.deliver(update)
          break
        }
        case 'context_usage': {
          const { used, size, cost } = event.contextUsage
          this.contextEvent = event.contextUsage
          this.deliver({
            sessionUpdate: 'usage_update',
            used,
            size,
            ...(cost === undefined ? {} : { cost: { amount: cost.amount, currency: cost.currency } }),
          })
          break
        }
        case 'controls':
          this.reconcileControls()
          break
        case 'notice':
          this.options.log?.(event.text)
          break
        case 'commands':
          this.announcedCommands = event.commands
          this.options.onCommandsChanged?.(event.commands)
          break
        case 'session_changed':
          // Only an attached session can be replaced; a resume that is still attaching reports its own id.
          if (this.attachedSessionId === undefined || event.sessionId === '') break
          // A replacement has an id of its own, so the held id is a repeat. A rewind rolls the conversation back in place
          // and names the id it already holds: that is the change.
          if (event.sessionId === this.attachedSessionId && !replacesSessionInPlace(event.reason)) break
          this.attachedSessionId = event.sessionId
          this.options.onSessionChanged?.(event.sessionId, event.reason)
          break
      }
    } catch (error) {
      this.options.log?.(`native agent event could not be projected: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Same fan-out as the ACP connection: the runtime hook sees every update, the running prompt too. */
  private deliver(update: acp.SessionUpdate): void {
    const sessionId = this.attachedSessionId ?? this.startupSessionId
    if (sessionId === undefined) return
    const notification: AcpSessionNotification = { sessionId, update }
    for (const listener of [this.options.onSessionUpdate, this.promptListener]) {
      try {
        listener?.(notification)
      } catch {
        if (!this.listenerFailureLogged) {
          this.listenerFailureLogged = true
          this.options.log?.('ACP session/update listener failed; subsequent listeners were still notified')
        }
      }
    }
  }

  /** Bridge a vendor permission request to the host approval service; anything unanswered is cancelled. */
  private async answerPermission(
    transport: NativeTransport,
    request: NativePermissionRequest,
    requestSignal: AbortSignal | undefined,
  ): Promise<NativePermissionDecision> {
    const cancelled: NativePermissionDecision = { cancelled: true }
    const handler = this.options.onPermissionRequest
    const sessionId = this.attachedSessionId
    const turnSignal = this.promptSignal
    if (
      transport !== this.transport ||
      handler === undefined ||
      sessionId === undefined ||
      !this.promptActive ||
      turnSignal === undefined
    )
      return cancelled
    const signal = requestSignal === undefined ? turnSignal : AbortSignal.any([turnSignal, requestSignal])
    if (signal.aborted) return cancelled
    const params: acp.RequestPermissionRequest = {
      sessionId,
      toolCall: mergeToolCall(this.toolSnapshots.get(request.toolCall.toolCallId), request.toolCall),
      options: [...request.options],
    }
    this.pendingQuestions += 1
    try {
      await this.options.onPermissionCheck?.({ reason: 'bridge-unavailable' }, params)
      const { outcome } = await raceAbort(Promise.resolve(handler(params, signal)), signal)
      if (outcome.outcome !== 'selected') return cancelled
      // Only an option the agent offered can be answered.
      return request.options.some((option) => option.optionId === outcome.optionId)
        ? { optionId: outcome.optionId }
        : cancelled
    } catch {
      return cancelled
    } finally {
      this.pendingQuestions -= 1
    }
  }

  /**
   * Bridge a vendor form (question, dialog, MCP elicitation) to the host's form elicitation service. Like a
   * permission request it exists only inside the running turn and ends with it; anything the host does not
   * answer with a known action is cancelled, which every vendor treats as an abandoned form.
   */
  private async answerElicitation(
    transport: NativeTransport,
    request: NativeElicitationRequest,
    requestSignal: AbortSignal | undefined,
  ): Promise<acp.CreateElicitationResponse> {
    const cancelled: acp.CreateElicitationResponse = { action: 'cancel' }
    const handler = this.options.onElicitationRequest
    const sessionId = this.attachedSessionId
    const turnSignal = this.promptSignal
    if (
      transport !== this.transport ||
      handler === undefined ||
      sessionId === undefined ||
      !this.promptActive ||
      turnSignal === undefined
    )
      return cancelled
    const signal = requestSignal === undefined ? turnSignal : AbortSignal.any([turnSignal, requestSignal])
    if (signal.aborted) return cancelled
    const params: acp.CreateElicitationRequest = {
      mode: 'form',
      sessionId,
      message: request.message,
      requestedSchema: request.requestedSchema,
      ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
      ...(request._meta ? { _meta: request._meta } : {}),
    }
    this.pendingQuestions += 1
    try {
      const response = await raceAbort(Promise.resolve(handler(params, signal)), signal)
      return response.action === 'accept' || response.action === 'decline' || response.action === 'cancel'
        ? response
        : cancelled
    } catch {
      return cancelled
    } finally {
      this.pendingQuestions -= 1
    }
  }
}
