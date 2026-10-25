import { describe, expect, it } from 'vitest'

import { NativeSessionRuntime } from '../../src/runtime/native/native-session-runtime.ts'
import type {
  NativeContentBlock,
  NativePromptResult,
  NativeTransport,
  NativeTransportEvent,
  NativeTransportStartOptions,
} from '../../src/runtime/native/transports/contract.ts'

/** Transport double: records host input and replays scripted events. */
class FakeTransport implements NativeTransport {
  readonly kind = 'omp' as const
  sessionId: string | undefined = 'fake-session'
  readonly calls: string[] = []
  private options: NativeTransportStartOptions | undefined
  private usage = { used: 42, size: 1000 }
  private pendingSteer: ((value: 'injected' | 'promptRequired') => void) | undefined

  async start(options: NativeTransportStartOptions): Promise<void> {
    this.options = options
    this.calls.push('start')
    options.onEvent({ kind: 'status', busy: false })
  }

  async prompt(content: readonly NativeContentBlock[], _signal: AbortSignal): Promise<NativePromptResult> {
    const text = content.map((block) => (block.type === 'text' ? block.text : '')).join('')
    this.calls.push(`prompt:${text}`)
    const emit = (event: NativeTransportEvent): void => this.options?.onEvent(event)
    emit({ kind: 'thought', text: 'thinking…' })
    emit({ kind: 'text', text: 'hello' })
    emit({ kind: 'tool_call', toolCallId: 't1', title: 'bash', status: 'in_progress' })
    emit({ kind: 'tool_call_update', toolCallId: 't1', status: 'completed', contentText: 'ok' })
    emit({
      kind: 'usage',
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18, reasoning: 3 },
    })
    emit({ kind: 'context_usage', contextUsage: this.usage })
    return { stopReason: 'end_turn' }
  }

  async steer(content: readonly NativeContentBlock[]): Promise<'injected' | 'promptRequired'> {
    this.calls.push(`steer:${content.map((block) => (block.type === 'text' ? block.text : '')).join('')}`)
    return 'injected'
  }

  async interrupt(): Promise<void> {
    this.calls.push('interrupt')
  }

  contextUsage(): { used: number; size: number } | undefined {
    return this.usage
  }

  async close(): Promise<void> {
    this.calls.push('close')
  }
}

function buildRuntime(transport: FakeTransport) {
  const notifications: unknown[] = []
  const runtime = new NativeSessionRuntime({
    kind: 'omp',
    createTransport: () => transport,
    profileId: 'omp-test',
    config: { command: '/bin/true', args: [], env: {} },
    subprocess: {} as never,
    cwd: '/tmp',
    prepareLaunch: async () => ({ argv: [], env: {}, spawnPlan: {} as never }),
    onSessionUpdate: () => undefined,
  } as never)
  return { runtime, notifications }
}

describe('NativeSessionRuntime', () => {
  it('projects native events onto ACP notifications and reports usage', async () => {
    const transport = new FakeTransport()
    const { runtime } = buildRuntime(transport)
    const updates: Array<{ sessionUpdate?: string }> = []
    await runtime.start()
    const response = await runtime.prompt(
      [{ type: 'text', text: 'hi' }],
      (notification) => updates.push(notification.update as { sessionUpdate?: string }),
      new AbortController().signal,
    )
    expect(response).toEqual({ stopReason: 'end_turn' })
    const kinds = updates.map((update) => update.sessionUpdate)
    expect(kinds).toContain('agent_thought_chunk')
    expect(kinds).toContain('agent_message_chunk')
    expect(kinds).toContain('tool_call')
    expect(kinds).toContain('tool_call_update')
    expect(kinds).toContain('usage_update')
    expect(runtime.contextUsage).toEqual({ used: 42, size: 1000 })
    expect(transport.calls).toEqual(['start', 'prompt:hi'])
  })

  it('steers through the native transport and closes idempotently', async () => {
    const transport = new FakeTransport()
    const { runtime } = buildRuntime(transport)
    await runtime.start()
    await expect(runtime.steer([{ type: 'text', text: 'go left' }])).resolves.toBe('injected')
    await runtime.close()
    await runtime.close()
    expect(transport.calls).toEqual(['start', 'steer:go left', 'close'])
  })
})
