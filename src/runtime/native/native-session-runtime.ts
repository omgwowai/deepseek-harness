/**
 * Native agent session runtime.
 *
 * Presents a vendor-native transport (OMP rpc-ui / Codex app-server / Claude
 * stream-json) behind the SAME `AcpProfileRuntime` surface the adapter already
 * consumes, so sessions, projections, approvals and statistics keep working
 * while steering, per-message usage and context occupancy start flowing.
 */
import { randomUUID } from 'node:crypto'
import type * as acp from '@agentclientprotocol/sdk'

import type { AcpRuntimeContextUsage, AcpSessionRuntimeOptions } from '../session/session-runtime.ts'
import type {
  NativeContextUsage,
  NativeContentBlock,
  NativePermissionDecision,
  NativePermissionRequest,
  NativeTransport,
  NativeTransportEvent,
  NativeTransportKind,
  NativeUsage,
} from './transports/contract.ts'

/** Options a native runtime receives; structurally compatible with AcpSessionRuntimeOptions. */
export interface NativeSessionRuntimeOptions extends AcpSessionRuntimeOptions {
  readonly kind: NativeTransportKind
  readonly createTransport: () => NativeTransport
  readonly log?: ((message: string) => void) | undefined
}

/** ACP session id minted for a native conversation. */

/** Convert ACP content blocks into native content blocks. */
function toNativeContent(content: readonly acp.ContentBlock[]): NativeContentBlock[] {
  const blocks: NativeContentBlock[] = []
  for (const block of content) {
    if (block.type === 'text') {
      blocks.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type === 'image') {
      blocks.push({ type: 'image', data: String(block.data), mimeType: block.mimeType })
    }
  }
  return blocks
}

function nativeSessionId(kind: NativeTransportKind): string {
  return `native-${kind}-${randomUUID()}`
}

/**
 * One native agent conversation projected onto the ACP runtime contract.
 * Only the members the adapter actually needs are implemented; absent optional
 * members make the adapter degrade (no fork, no modes) rather than fail.
 */
export class NativeSessionRuntime {
  readonly acpSessionId: string
  readonly agentInfo: { readonly name: string; readonly version: string }
  readonly agentCapabilities: acp.AgentCapabilities = {}
  readonly protocolVersion = 1
  readonly canSteer = true

  private readonly transport: NativeTransport
  private started = false
  private busy = false
  private lastUsage: NativeUsage | undefined
  private lastContextUsage: NativeContextUsage | undefined
  private activeUpdate: ((notification: acp.SessionNotification) => void) | undefined
  private closing = false

  constructor(private readonly options: NativeSessionRuntimeOptions) {
    this.acpSessionId = nativeSessionId(options.kind)
    this.agentInfo = { name: options.kind, version: '0.0.0-native' }
    this.transport = options.createTransport()
  }

  private emit(notification: acp.SessionNotification): void {
    ;(this.activeUpdate ?? this.options.onSessionUpdate)?.(notification)
  }

  private project(event: NativeTransportEvent): void {
    switch (event.kind) {
      case 'text':
        this.emit({
          sessionId: this.acpSessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: event.text } },
        } as unknown as acp.SessionNotification)
        return
      case 'thought':
        this.emit({
          sessionId: this.acpSessionId,
          update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: event.text } },
        } as unknown as acp.SessionNotification)
        return
      case 'tool_call':
        this.emit({
          sessionId: this.acpSessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: event.toolCallId,
            title: event.title,
            status: event.status,
            rawInput: event.rawInput,
          },
        } as unknown as acp.SessionNotification)
        return
      case 'tool_call_update':
        this.emit({
          sessionId: this.acpSessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: event.toolCallId,
            status: event.status,
            ...(event.contentText === undefined ? {} : { content: [{ type: 'content', content: { type: 'text', text: event.contentText } }] }),
          },
        } as unknown as acp.SessionNotification)
        return
      case 'usage':
        this.lastUsage = event.usage
        this.lastContextUsage = this.transport.contextUsage()
        this.emitUsage()
        return
      case 'context_usage':
        this.lastContextUsage = event.contextUsage
        this.emitUsage()
        return
      case 'status':
        this.busy = event.busy
        return
      case 'notice':
        this.options.log?.(event.text)
        return
      default:
        return
    }
  }

  private emitUsage(): void {
    const context = this.lastContextUsage
    const usage = this.lastUsage
    if (context === undefined && usage === undefined) return
    this.emit({
      sessionId: this.acpSessionId,
      update: {
        sessionUpdate: 'usage_update',
        used: context?.used ?? usage?.total ?? 0,
        size: context?.size ?? 0,
        ...(usage?.cost === undefined ? {} : { cost: usage.cost }),
      },
    } as unknown as acp.SessionNotification)
  }

  async initialize(): Promise<void> {}

  async start(_signal?: AbortSignal): Promise<void> {
    if (this.started) return
    const { kind, config, cwd } = this.options
    const env = { ...process.env, ...config.env } as Record<string, string>
    const launch = nativeLaunch(kind, config.command, config, env)
    await this.transport.start({
      command: launch.command,
      args: launch.args,
      env,
      cwd,
      onEvent: (event) => this.project(event),
      onPermission: (request) => this.answerPermission(request),
      log: (message) => this.options.log?.(message),
    })
    this.started = true
  }

  private async answerPermission(request: NativePermissionRequest): Promise<NativePermissionDecision> {
    const handler = this.options.onPermissionRequest
    if (handler === undefined) return { cancelled: true }
    const params = {
      sessionId: this.acpSessionId,
      toolCall: { toolCallId: request.requestId, title: request.title },
      options: request.options.map((option) => ({
        optionId: option.optionId,
        name: option.name,
        kind: option.kind,
      })),
    } as unknown as acp.RequestPermissionRequest
    const response = await handler(params, undefined)
    const optionId = (response as { outcome?: { optionId?: string } }).outcome?.optionId
    return optionId === undefined ? { cancelled: true } : { optionId }
  }

  async prompt(
    content: acp.ContentBlock[],
    onUpdate: (notification: acp.SessionNotification) => void,
    signal?: AbortSignal,
  ): Promise<acp.PromptResponse> {
    this.activeUpdate = onUpdate
    try {
      this.busy = true
      const blocks = toNativeContent(content)
      const result = await this.transport.prompt(blocks, signal ?? new AbortController().signal)
      if (result.usage !== undefined) {
        this.lastUsage = result.usage
        this.emitUsage()
      }
      return { stopReason: result.stopReason } as acp.PromptResponse
    } finally {
      this.busy = false
      this.activeUpdate = undefined
    }
  }

  async steer(
    content: acp.ContentBlock[],
    onDispatch?: () => void,
  ): Promise<'injected' | 'promptRequired'> {
    const blocks = toNativeContent(content).filter(
      (block): block is Extract<NativeContentBlock, { type: 'text' }> => block.type === 'text',
    )
    if (blocks.length === 0) return 'promptRequired'
    onDispatch?.()
    return await this.transport.steer(blocks)
  }

  /** Session-scoped ACP config (model/effort) stays advisory for native v1. */
  async setConfigOption(_configId: string, _value: string | boolean): Promise<void> {}

  async setMode(_modeId: string): Promise<void> {}

  get contextUsage(): AcpRuntimeContextUsage | undefined {
    const context = this.transport.contextUsage() ?? this.lastContextUsage
    if (context !== undefined && context.size > 0) return { used: context.used, size: context.size }
    const usage = this.lastUsage
    return usage === undefined ? undefined : { used: usage.total, size: 0 }
  }

  get isBusy(): boolean {
    return this.busy
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

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    await this.transport.close().catch(() => undefined)
  }
}

/** Resolve the native argv for one configured agent. */
export function nativeLaunch(
  kind: NativeTransportKind,
  configuredCommand: string,
  config: { readonly args: readonly string[] },
  env: Readonly<Record<string, string>>,
): { command: string; args: string[] } {
  const argsText = config.args.join(' ')
  switch (kind) {
    case 'omp': {
      const command = configuredCommand.includes('/') ? configuredCommand : (env.OMP_COMMAND ?? configuredCommand)
      const resume = ompResumeFlag(config.args)
      return {
        command,
        args: ['--mode', 'rpc-ui', ...(resume === undefined ? ['--no-session'] : ['--session', resume])],
      }
    }
    case 'codex': {
      const command =
        env.DSH_CODEX_BINARY ?? (argsText.includes('codex-acp') ? 'codex' : configuredCommand)
      return { command: command === '' ? 'codex' : command, args: ['app-server'] }
    }
    case 'claude': {
      const command = env.DSH_CLAUDE_EXECUTABLE ?? env.CLAUDE_CODE_EXECUTABLE ?? 'claude'
      return {
        command,
        args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
      }
    }
  }
}

function ompResumeFlag(args: readonly string[]): string | undefined {
  const index = args.findIndex((arg) => arg === '--session' || arg === '--resume')
  return index >= 0 ? args[index + 1] : undefined
}
