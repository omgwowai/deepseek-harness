/// <reference types="node" />
/**
 * Contract between a vendor-native agent transport and the DSH session runtime.
 *
 * A transport owns one agent process and speaks that vendor's native protocol
 * (`omp --mode rpc-ui` JSONL, `codex app-server` JSON-RPC, Claude Code
 * stream-json). Everything it reports is already in the shape the vendor's own
 * ACP agent (OMP's `omp acp`, `@agentclientprotocol/codex-acp`,
 * `@agentclientprotocol/claude-agent-acp`) would have produced: the same session
 * ids, the same session config option ids/values, the same tool-call fields.
 * The adapter, its sidecar bindings, saved mode intents and the probe-driven
 * model picker therefore keep working unchanged when a profile moves from ACP to
 * the native transport, while steering, usage and context occupancy flow.
 */
import type { Readable, Writable } from 'node:stream'
import type * as acp from '@agentclientprotocol/sdk'

export type NativeTransportKind = 'omp' | 'codex' | 'claude'

/** One content block a host sends to the agent. */
export type NativeContentBlock =
  | { readonly type: 'text'; readonly text: string }
  /** Base64 image data. */
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string }

/** A process the transport drives; the host owns spawning, environment scrubbing and tree teardown. */
export interface NativeProcess {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  /** Resolves once the process exited; rejects when it could not be launched. */
  readonly exited: Promise<{ readonly exitCode: number | null; readonly signal: string | null }>
  /** Ask the host to terminate the process tree. Idempotent. */
  terminate(): void
}

/**
 * Host spawner. `env` holds explicit entries only; the host merges them onto its
 * scrubbed parent environment (the same discipline the ACP route uses).
 */
export type NativeSpawn = (spec: {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}) => NativeProcess

/** Which vendor conversation `start()` attaches to. */
export type NativeSessionTarget =
  | { readonly kind: 'new' }
  /** Continue an existing vendor session (an id an earlier native or ACP run reported). */
  | { readonly kind: 'resume'; readonly sessionId: string }
  /** Create a new vendor session that inherits the parent's conversation. */
  | { readonly kind: 'fork'; readonly parentSessionId: string }

/**
 * Session controls, identical in option ids, categories, value strings, names and
 * descriptions to what the vendor's ACP agent returns from `session/new`.
 */
export interface NativeControls {
  /** ACP session config options: `mode`, `model`, the thought level, plus vendor extras. */
  readonly configOptions: readonly acp.SessionConfigOption[]
  /** Legacy ACP session modes, when the vendor's ACP agent advertised them. */
  readonly modes: acp.SessionModeState | undefined
  /** Whether the current model accepts image input. */
  readonly imageInput: boolean
}

/** Context-window occupancy (ACP `usage_update` semantics). */
export interface NativeContextUsage {
  readonly used: number
  readonly size: number
  /** Cumulative session cost when the vendor reports it. */
  readonly cost?: { readonly amount: number; readonly currency: string } | undefined
}

/** Token accounting for one whole prompt turn: the sum over every model call the turn made. */
export interface NativeTurnUsage {
  /** Input tokens that were not served from the prompt cache. */
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedReadTokens: number
  readonly cachedWriteTokens: number
  /** Reasoning tokens, already included in `outputTokens`, when reported. */
  readonly thoughtTokens?: number | undefined
  /** Cost of this turn in USD, when reported. */
  readonly costUsd?: number | undefined
}

/** Event a transport emits while it runs. */
export type NativeTransportEvent =
  /**
   * One ACP session update without `sessionId`, shaped exactly like the vendor's ACP
   * agent: `agent_message_chunk`, `agent_thought_chunk`, `tool_call`,
   * `tool_call_update`, `plan`, `available_commands_update`, `session_info_update`.
   */
  | { readonly kind: 'update'; readonly update: acp.SessionUpdate }
  | { readonly kind: 'context_usage'; readonly contextUsage: NativeContextUsage }
  /** The vendor changed a control on its own (plan exit, model fallback, …); full new state. */
  | { readonly kind: 'controls'; readonly controls: NativeControls }
  /** Diagnostic text for the host log; never contains credentials. */
  | { readonly kind: 'notice'; readonly text: string }

/** A permission prompt the agent raised, in ACP `session/request_permission` shape. */
export interface NativePermissionRequest {
  readonly toolCall: acp.ToolCallUpdate
  readonly options: readonly acp.PermissionOption[]
}

export type NativePermissionDecision = { readonly optionId: string } | { readonly cancelled: true }

export type NativePermissionHandler = (
  request: NativePermissionRequest,
  signal?: AbortSignal,
) => Promise<NativePermissionDecision>

/** Everything a transport needs to own one agent process. */
export interface NativeTransportStartOptions {
  /** Launcher argv (executable first); the transport appends the protocol and session flags it owns. */
  readonly argv: readonly string[]
  /** Explicit environment entries for the agent process. */
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
  readonly spawn: NativeSpawn
  readonly session: NativeSessionTarget
  readonly onEvent: (event: NativeTransportEvent) => void
  readonly onPermission: NativePermissionHandler
  readonly log?: ((message: string) => void) | undefined
}

/** Terminal outcome of one prompt turn. */
export interface NativePromptResult {
  readonly stopReason: 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'cancelled' | 'refusal'
  readonly usage?: NativeTurnUsage | undefined
}

/** One vendor-native agent conversation. */
export interface NativeTransport {
  readonly kind: NativeTransportKind
  /**
   * Vendor session id once `start()` resolved: the OMP session id, the Codex thread id,
   * the Claude Code session id. For `resume` it equals the target; for `new`/`fork` it is
   * the id the vendor created.
   */
  readonly sessionId: string | undefined
  /** Vendor identity, e.g. `{ name: 'omp', version: '18.12.6' }`. */
  readonly agentInfo: { readonly name: string; readonly version: string }
  /** Whether `start({ session: { kind: 'fork' } })` is supported. */
  readonly canFork: boolean
  /**
   * Spawn, handshake and attach to the target session. Resolves only when `sessionId`
   * and `controls()` are valid. A resume target the vendor does not know rejects with
   * `NativeTransportError` code `session-not-found` and a message containing
   * "session not found".
   */
  start(options: NativeTransportStartOptions): Promise<void>
  /** Current controls; valid after `start()`. */
  controls(): NativeControls
  /**
   * Change one control by its ACP option id. Never called while a prompt runs. Resolves
   * after the vendor confirmed the change; `controls()` reflects it immediately after.
   * Rejects for an unknown id or value.
   */
  setConfigOption(configId: string, value: string | boolean, signal?: AbortSignal): Promise<void>
  /**
   * Deliver one user message and resolve when that turn settles. When `signal` aborts the
   * transport interrupts the vendor turn and resolves `{ stopReason: 'cancelled' }` once the
   * vendor confirmed it; it rejects only when the outcome cannot be known (process lost).
   */
  prompt(content: readonly NativeContentBlock[], signal: AbortSignal): Promise<NativePromptResult>
  /**
   * Inject a message into the running turn. `injected`: the vendor accepted it into that
   * turn. `promptRequired`: definitively not accepted (no running turn, vendor refusal).
   * Throws only when acceptance is unknown.
   */
  steer(content: readonly NativeContentBlock[], signal?: AbortSignal): Promise<'injected' | 'promptRequired'>
  /** Latest context occupancy, when known. */
  contextUsage(): NativeContextUsage | undefined
  /** End the process gracefully, then terminate it. Idempotent. */
  close(): Promise<void>
}

/** Raised when a transport cannot start or the vendor violates its protocol. */
export class NativeTransportError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly detail?: string | undefined,
  ) {
    super(message)
    this.name = 'NativeTransportError'
  }
}

/** Pick the native transport for one configured ACP agent, or `undefined` to stay on ACP. */
export function selectNativeTransportKind(input: {
  readonly command: string
  readonly args: readonly string[]
}): NativeTransportKind | undefined {
  const command = input.command.toLowerCase()
  const args = input.args.join(' ').toLowerCase()
  if (/(^|\/)omp(\s|$)|oh-my-pi/.test(command) || args.includes('oh-my-pi')) return 'omp'
  if (/(^|\/)codex(\s|$)/.test(command) || args.includes('codex-acp')) return 'codex'
  if (/(^|\/)claude(\s|$)/.test(command) || args.includes('claude-agent-acp') || args.includes('claude-launch'))
    return 'claude'
  return undefined
}
