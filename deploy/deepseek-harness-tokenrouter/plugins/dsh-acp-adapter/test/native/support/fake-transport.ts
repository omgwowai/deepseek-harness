/// <reference types="node" />
/**
 * Scriptable vendor transport for the NativeSessionRuntime specs: it implements the
 * NativeTransport contract in memory (no process), validates control writes like a vendor
 * would, and records every call in order.
 */
import type * as acp from '@agentclientprotocol/sdk'

import { NATIVE_MODE_CONTRACTS } from '../../../src/runtime/native/session-modes.ts'
import {
  NativeTransportError,
  type NativeContentBlock,
  type NativeContextUsage,
  type NativeControls,
  type NativePermissionDecision,
  type NativePermissionRequest,
  type NativePromptResult,
  type NativeTransport,
  type NativeTransportEvent,
  type NativeTransportKind,
  type NativeTransportStartOptions,
} from '../../../src/runtime/native/transports/contract.ts'

function select(
  id: string,
  name: string,
  category: string,
  currentValue: string,
  values: readonly string[],
): acp.SessionConfigOption {
  return {
    id,
    name,
    category,
    type: 'select',
    currentValue,
    options: values.map((value) => ({ value, name: value })),
  }
}

/** Controls shaped like the last persisted ACP snapshots of each vendor (mode contract included). */
export function vendorControls(
  kind: NativeTransportKind,
  current: { readonly mode?: string; readonly model?: string; readonly imageInput?: boolean } = {},
): NativeControls {
  const contract = NATIVE_MODE_CONTRACTS[kind]
  const modes = contract.modes.filter((mode) => !contract.unavailable.includes(mode.id))
  const mode = current.mode ?? contract.defaultModeId
  const modeOption: acp.SessionConfigOption = {
    id: 'mode',
    name: contract.option.name,
    ...(contract.option.description === undefined ? {} : { description: contract.option.description }),
    category: 'mode',
    type: 'select',
    currentValue: mode,
    options: modes.map(({ id, name, description }) => ({ value: id, name, description })),
  }
  const rest: Record<NativeTransportKind, acp.SessionConfigOption[]> = {
    claude: [
      select('model', 'Model', 'model', current.model ?? 'default', [
        'default',
        'opus',
        'fable',
        'sonnet',
        'haiku',
        'claude-sonnet-5.5',
      ]),
      select('effort', 'Effort', 'thought_level', 'default', ['default', 'low', 'medium', 'high', 'xhigh', 'max']),
    ],
    codex: [
      select('collaboration_mode', 'Collaboration mode', 'collaboration_mode', 'default', ['default', 'plan']),
      select('model', 'Model', 'model', current.model ?? 'gpt-6-astra', [
        'gpt-6-astra',
        'gpt-5.6-sol',
        'gpt-5.6-terra',
        'gpt-5.6-luna',
        'gpt-5.5',
        'glm-5.3',
        'gpt-5.2',
      ]),
      select('reasoning_effort', 'Reasoning effort', 'thought_level', 'medium', [
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
      ]),
    ],
    omp: [
      select('model', 'Model', 'model', current.model ?? 'tokenrouter/claude-opus-5.5', [
        'tokenrouter/claude-opus-5.5',
        'tokenrouter/gpt-5.5',
      ]),
      select('thinking', 'Thinking', 'thought_level', 'auto', ['off', 'auto', 'low', 'high', 'max']),
    ],
  }
  return {
    configOptions: [modeOption, ...rest[kind]],
    modes: {
      currentModeId: mode,
      availableModes: modes.map(({ id, name, description }) => ({ id, name, description })),
    },
    imageInput: current.imageInput ?? true,
  }
}

export interface FakePromptContext {
  readonly content: readonly NativeContentBlock[]
  readonly signal: AbortSignal
  emit(event: NativeTransportEvent): void
  update(update: acp.SessionUpdate): void
  /** Settles `cancelled` once the signal aborts, as a conforming transport does after the vendor confirmed the interrupt. */
  cancelled(): Promise<NativePromptResult>
}

export type FakePromptScript = (context: FakePromptContext) => Promise<NativePromptResult>

export interface FakeTransportInit {
  readonly kind?: NativeTransportKind
  readonly canFork?: boolean
  readonly agentInfo?: { readonly name: string; readonly version: string }
  readonly controls?: NativeControls
  /** Session id a `new` start reports. */
  readonly sessionId?: string
  /** Session id a `fork` start reports. */
  readonly forkSessionId?: string
}

export class FakeNativeTransport implements NativeTransport {
  readonly kind: NativeTransportKind
  readonly canFork: boolean
  readonly agentInfo: { readonly name: string; readonly version: string }
  sessionId: string | undefined
  /** Optional liveness the runtime honors: `close()` ran. A transport that does not track it reports nothing. */
  reportsClosed = true
  private isClosed = false
  /** Spawns one agent process through the host spawner when it starts, as the real transports do. */
  spawnAtStart = false
  /** `close()` records the call and never settles, like a transport that lost its teardown. */
  hangOnClose = false
  get closed(): boolean | undefined {
    return this.reportsClosed ? this.isClosed : undefined
  }
  set closed(value: boolean) {
    this.isClosed = value
  }
  readonly calls: string[] = []
  readonly prompts: NativeContentBlock[][] = []
  readonly steers: NativeContentBlock[][] = []
  startOptions: NativeTransportStartOptions | undefined
  startError: Error | undefined
  closeCount = 0
  promptScript: FakePromptScript = async () => ({ stopReason: 'end_turn' })
  steerResult: 'injected' | 'promptRequired' = 'injected'
  steerError: Error | undefined
  /** Runs before a control write is applied; lets a test hold a write open. */
  beforeSet: ((id: string, value: string | boolean) => Promise<void>) | undefined
  context: NativeContextUsage | undefined
  private controlState: NativeControls
  private readonly newSessionId: string
  private readonly forkSessionId: string

  constructor(init: FakeTransportInit = {}) {
    this.kind = init.kind ?? 'claude'
    this.canFork = init.canFork ?? true
    this.agentInfo = init.agentInfo ?? { name: this.kind, version: '1.0.0' }
    this.controlState = init.controls ?? vendorControls(this.kind)
    this.newSessionId = init.sessionId ?? `${this.kind}-session-new`
    this.forkSessionId = init.forkSessionId ?? `${this.kind}-session-fork`
  }

  async start(options: NativeTransportStartOptions): Promise<void> {
    this.calls.push(`start:${options.session.kind}`)
    this.startOptions = options
    if (this.spawnAtStart) options.spawn({ argv: options.argv, cwd: options.cwd, env: options.env })
    if (this.startError !== undefined) throw this.startError
    this.sessionId =
      options.session.kind === 'resume'
        ? options.session.sessionId
        : options.session.kind === 'fork'
          ? this.forkSessionId
          : this.newSessionId
  }

  controls(): NativeControls {
    return structuredClone(this.controlState)
  }

  async setConfigOption(configId: string, value: string | boolean, _signal?: AbortSignal): Promise<void> {
    this.calls.push(`set:${configId}=${String(value)}`)
    await this.beforeSet?.(configId, value)
    const option = this.controlState.configOptions.find((candidate) => candidate.id === configId)
    if (option === undefined) throw new NativeTransportError(`unknown config option ${configId}`, 'invalid-config')
    if (option.type === 'select') {
      const values = option.options.flatMap((entry) => ('options' in entry ? entry.options : [entry]))
      if (typeof value !== 'string' || !values.some((entry) => entry.value === value))
        throw new NativeTransportError(`${configId} does not allow ${String(value)}`, 'invalid-config')
    }
    const applied = { ...option, currentValue: value } as acp.SessionConfigOption
    this.controlState = {
      ...this.controlState,
      configOptions: this.controlState.configOptions.map((candidate) => (candidate === option ? applied : candidate)),
      modes:
        configId === 'mode' && this.controlState.modes !== undefined && typeof value === 'string'
          ? { ...this.controlState.modes, currentModeId: value }
          : this.controlState.modes,
    }
  }

  async prompt(content: readonly NativeContentBlock[], signal: AbortSignal): Promise<NativePromptResult> {
    this.calls.push('prompt')
    this.prompts.push([...content])
    return await this.promptScript({
      content,
      signal,
      emit: (event) => this.emit(event),
      update: (update) => this.emit({ kind: 'update', update }),
      cancelled: () => {
        const { promise, resolve } = Promise.withResolvers<NativePromptResult>()
        const done = (): void => resolve({ stopReason: 'cancelled' })
        if (signal.aborted) done()
        else signal.addEventListener('abort', done, { once: true })
        return promise
      },
    })
  }

  async steer(content: readonly NativeContentBlock[], _signal?: AbortSignal): Promise<'injected' | 'promptRequired'> {
    this.calls.push('steer')
    this.steers.push([...content])
    if (this.steerError !== undefined) throw this.steerError
    return this.steerResult
  }

  contextUsage(): NativeContextUsage | undefined {
    return this.context
  }

  async close(): Promise<void> {
    this.calls.push('close')
    this.closeCount += 1
    this.isClosed = true
    if (this.hangOnClose) await new Promise<never>(() => undefined)
  }

  /** Replace the vendor-side controls and tell the runtime, as a vendor-initiated change would. */
  changeControls(controls: NativeControls): void {
    this.controlState = controls
    this.emit({ kind: 'controls', controls })
  }

  emit(event: NativeTransportEvent): void {
    this.startOptions?.onEvent(event)
  }

  async requestPermission(request: NativePermissionRequest, signal?: AbortSignal): Promise<NativePermissionDecision> {
    const start = this.startOptions
    if (start === undefined) throw new Error('the transport has not started')
    return await start.onPermission(request, signal)
  }
}
