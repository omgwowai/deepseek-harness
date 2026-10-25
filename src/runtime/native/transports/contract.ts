/**
 * Contract between a vendor-native agent transport and the DSH session runtime.
 *
 * A transport owns one agent subprocess and speaks that vendor's native protocol
 * (`omp --mode rpc-ui` JSONL, `codex app-server` JSON-RPC, Claude stream-json).
 * It reports normalized events; the session runtime projects them onto the ACP
 * notification surface DSH already renders, so the user-facing interface does not
 * change while steering / usage / approvals start working.
 *
 * Deliberately dependency-free (node builtins only) so each transport can be
 * unit-tested in isolation before it is wired into the adapter.
 */

export type NativeTransportKind = 'omp' | 'codex' | 'claude'

/** One content block a host sends to the agent. */
export type NativeContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string }

/** Token accounting as reported by the vendor (integers, cost in the vendor's currency). */
export interface NativeUsage {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly total: number
  readonly reasoning: number
  readonly cost?: { readonly amount: number; readonly currency: string } | undefined
}

/** Context-window occupancy for the session stats surface. */
export interface NativeContextUsage {
  readonly used: number
  readonly size: number
}

export type NativeToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'

/** Normalized event emitted by a transport while a prompt runs. */
export type NativeTransportEvent =
  | { readonly kind: 'status'; readonly busy: boolean }
  /** Assistant answer text delta. */
  | { readonly kind: 'text'; readonly text: string }
  /** Assistant reasoning/thinking delta. */
  | { readonly kind: 'thought'; readonly text: string }
  | {
      readonly kind: 'tool_call'
      readonly toolCallId: string
      readonly title: string
      readonly status: NativeToolCallStatus
      /** Raw vendor arguments, retained for display only. */
      readonly rawInput?: unknown
    }
  | {
      readonly kind: 'tool_call_update'
      readonly toolCallId: string
      readonly status: NativeToolCallStatus
      readonly contentText?: string
    }
  | { readonly kind: 'usage'; readonly usage: NativeUsage }
  | { readonly kind: 'context_usage'; readonly contextUsage: NativeContextUsage }
  /** Human-readable diagnostic the host may surface as a notice. */
  | { readonly kind: 'notice'; readonly text: string }

/** A permission prompt the agent raised; the host answers with one option id. */
export interface NativePermissionRequest {
  readonly requestId: string
  readonly title: string
  readonly detail?: string | undefined
  readonly options: readonly {
    readonly optionId: string
    readonly name: string
    readonly kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
  }[]
}

export type NativePermissionDecision = { readonly optionId: string } | { readonly cancelled: true }

export type NativePermissionHandler = (
  request: NativePermissionRequest,
  signal?: AbortSignal,
) => Promise<NativePermissionDecision>

/** Everything a transport needs to own one agent subprocess. */
export interface NativeTransportStartOptions {
  /** Absolute executable path or bare command resolved through `env.PATH`. */
  readonly command: string
  /** Native argv (the transport adds nothing protocol-specific that it does not own). */
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
  /** Resume an existing vendor session/thread when the vendor supports it. */
  readonly resumeSessionId?: string | undefined
  readonly onEvent: (event: NativeTransportEvent) => void
  readonly onPermission: NativePermissionHandler
  /** Diagnostics sink; never contains credentials. */
  readonly log?: ((message: string) => void) | undefined
}

/** Terminal outcome of one prompt turn. */
export interface NativePromptResult {
  readonly stopReason: 'end_turn' | 'max_tokens' | 'cancelled' | 'refusal'
  readonly usage?: NativeUsage | undefined
}

/** One vendor-native agent conversation. */
export interface NativeTransport {
  readonly kind: NativeTransportKind
  /** Vendor session/thread identity, once the transport learns it. */
  readonly sessionId: string | undefined
  /** Spawn, handshake and reach the vendor's ready point. Idempotent per instance. */
  start(options: NativeTransportStartOptions): Promise<void>
  /** Deliver one user message and resolve when that turn settles. */
  prompt(content: readonly NativeContentBlock[], signal: AbortSignal): Promise<NativePromptResult>
  /**
   * Inject a message into the RUNNING turn. `injected` means the vendor accepted
   * an in-turn injection; `promptRequired` means the caller must send a prompt.
   */
  steer(content: readonly NativeContentBlock[], signal?: AbortSignal): Promise<'injected' | 'promptRequired'>
  /** Interrupt the running turn without ending the session. */
  interrupt(): Promise<void>
  /** Latest context occupancy, when the vendor reports it. */
  contextUsage(): NativeContextUsage | undefined
  /** Terminate the subprocess and release resources. Idempotent. */
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
  readonly idle?: string | undefined
  readonly command: string
  readonly args: readonly string[]
}): NativeTransportKind | undefined {
  if (input.idle === 'none') return undefined
  const command = input.command.toLowerCase()
  const args = input.args.join(' ').toLowerCase()
  if (/(^|\/)omp(\s|$)|oh-my-pi/.test(command) || args.includes('oh-my-pi')) return 'omp'
  if (/(^|\/)codex(\s|$)/.test(command) || args.includes('codex-acp')) return 'codex'
  if (/(^|\/)claude(\s|$)/.test(command) || args.includes('claude-agent-acp') || args.includes('claude-launch'))
    return 'claude'
  return undefined
}
