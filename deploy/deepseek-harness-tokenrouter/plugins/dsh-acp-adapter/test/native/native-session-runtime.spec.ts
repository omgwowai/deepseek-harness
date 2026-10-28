import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type * as acp from '@agentclientprotocol/sdk'

import type { AcpProfileRuntime } from '../../src/host/composition/profile-adapter.ts'
import type { AcpSessionNotification } from '../../src/protocol/v1/types.ts'
import { nativeLaunchArgv, prepareNativeLaunch } from '../../src/runtime/native/launch.ts'
import {
  NativeSessionRuntime,
  toNativeContent,
  type NativeSessionRuntimeOptions,
} from '../../src/runtime/native/native-session-runtime.ts'
import { NATIVE_MODE_CONTRACTS, codexModeSettings, withNativeModeContract } from '../../src/runtime/native/session-modes.ts'
import type { AcpSubprocessSpawnSpec, SubprocessSeam } from '../../src/runtime/process/subprocess.ts'
import { AcpForkPreDispatchError } from '../../src/runtime/session/session-runtime.ts'
import { staticNativeCommands } from '../../src/runtime/native/native-commands.ts'
import {
  NativeTransportError,
  type NativeCommand,
  type NativeCommandResult,
  type NativeControls,
  type NativePromptResult,
} from '../../src/runtime/native/transports/contract.ts'
import {
  FakeNativeTransport,
  vendorControls,
  type FakePromptContext,
  type FakeTransportInit,
} from './support/fake-transport.ts'

const text = (value: string): acp.ContentBlock[] => [{ type: 'text', text: value }]

const PREVIEW_ID = 'native-claude-b948d6a4-e266-43b4-8504-6952698de42f'

/** One agent process the fake host subprocess service started. */
interface FakeAgentProcess {
  readonly spec: AcpSubprocessSpawnSpec
  terminated: number
  /** The process exits by itself, as a crashed or idle-timed-out agent does. */
  exit(): void
}

interface Harness {
  readonly runtime: NativeSessionRuntime
  readonly transports: FakeNativeTransport[]
  readonly notifications: AcpSessionNotification[]
  readonly spawned: AcpSubprocessSpawnSpec[]
  readonly processes: FakeAgentProcess[]
  readonly prepared: string[]
}

function build(
  init: FakeTransportInit = {},
  overrides: Partial<NativeSessionRuntimeOptions> = {},
  onTransport: (transport: FakeNativeTransport, index: number) => void = () => undefined,
): Harness {
  const transports: FakeNativeTransport[] = []
  const notifications: AcpSessionNotification[] = []
  const spawned: AcpSubprocessSpawnSpec[] = []
  const processes: FakeAgentProcess[] = []
  const prepared: string[] = []
  const subprocess: SubprocessSeam = {
    spawn: (spec) => {
      spawned.push(spec)
      const done = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>()
      const agent: FakeAgentProcess = {
        spec,
        terminated: 0,
        exit: () => done.resolve({ exitCode: 0, signal: null }),
      }
      processes.push(agent)
      return {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        done: done.promise,
        terminate: () => {
          agent.terminated += 1
        },
        waitForExit: async () => true,
      }
    },
    resolveExecutable: async (command) => command,
  }
  const runtime = new NativeSessionRuntime({
    config: {
      command: '/Users/test/.bun/bin/omp',
      args: ['acp', '-e', '/Users/test/dsh-agent-dag/omp-link-headers.js'],
      env: { PI_CODING_AGENT_DIR: '/Users/test/.omp/agent' },
    },
    cwd: '/work/project',
    subprocess,
    prepareLaunch: async (config, cwd) => {
      prepared.push(cwd)
      const argv = [config.command, ...config.args]
      const env = { ...config.env, DSH_ACP_LINK_HEADERS: '{"x-link":"1"}' }
      return { argv, env, spawnPlan: { argv, env } }
    },
    createTransport: () => {
      const transport = new FakeNativeTransport({ kind: 'omp', ...init })
      onTransport(transport, transports.length)
      transports.push(transport)
      return transport
    },
    onSessionUpdate: (notification) => {
      notifications.push(notification)
    },
    ...overrides,
  })
  return { runtime, transports, notifications, spawned, processes, prepared }
}

function first(harness: Harness): FakeNativeTransport {
  const transport = harness.transports[0]
  if (transport === undefined) throw new Error('no transport was created')
  return transport
}

/** A turn that stays open until the test finishes it. */
function openTurn(transport: FakeNativeTransport): {
  readonly started: Promise<FakePromptContext>
  finish(result?: NativePromptResult): void
} {
  const started = Promise.withResolvers<FakePromptContext>()
  const finished = Promise.withResolvers<NativePromptResult>()
  transport.promptScript = async (context) => {
    started.resolve(context)
    return await finished.promise
  }
  return { started: started.promise, finish: (result = { stopReason: 'end_turn' }) => finished.resolve(result) }
}

/** Run `work` against the transport while a turn is open, then let the turn end. */
async function duringTurn<T>(harness: Harness, work: (transport: FakeNativeTransport) => Promise<T>): Promise<T> {
  await harness.runtime.start()
  const transport = first(harness)
  const turn = openTurn(transport)
  const prompting = harness.runtime.prompt(text('work'), () => undefined)
  await turn.started
  try {
    return await work(transport)
  } finally {
    turn.finish()
    await prompting
  }
}

const updateKinds = (notifications: readonly AcpSessionNotification[]): string[] =>
  notifications.map((notification) => notification.update.sessionUpdate)

const messageChunk = (value: string): acp.SessionUpdate => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text: value },
})

describe('NativeSessionRuntime lifecycle', () => {
  it('is an AcpProfileRuntime and declares its controls before a session exists', async () => {
    const harness = build()
    const adapterRuntime: AcpProfileRuntime = harness.runtime
    expect(adapterRuntime.initialize).toBeTypeOf('function')
    expect('configOptions' in harness.runtime).toBe(true)
    expect(harness.runtime.configOptions).toBeUndefined()
    expect(harness.runtime.modes).toBeUndefined()
    expect(harness.runtime.currentModeId).toBeUndefined()
    expect(harness.runtime.contextUsage).toBeUndefined()
    expect(harness.runtime.acpSessionId).toBeUndefined()
    expect(harness.runtime.agentInfo).toBeUndefined()
    expect(harness.runtime.inputImageSupported).toBeUndefined()
    expect(harness.runtime.protocolVersion).toBe(1)
    expect(harness.runtime.agentCapabilities).toEqual({
      loadSession: true,
      promptCapabilities: { image: true, embeddedContext: true },
      sessionCapabilities: { resume: {}, fork: {} },
    })
    await harness.runtime.initialize()
    expect(first(harness).calls).toEqual([])
    expect(harness.runtime.isBusy).toBe(false)
    expect(harness.runtime.canSteer).toBe(false)
    expect(harness.runtime.hasPendingHostCalls()).toBe(false)
    expect(harness.runtime.hasUncommittedHostFeedback()).toBe(false)
    expect(harness.runtime.hasRetainedHostFeedback()).toBe(false)
  })

  it('starts through the host launch preparation, the derived launcher argv and the host spawner', async () => {
    const harness = build({ agentInfo: { name: 'omp', version: '18.12.6' } })
    await harness.runtime.start()
    const transport = first(harness)
    expect(transport.calls).toEqual(['start:new'])
    expect(harness.prepared).toEqual(['/work/project'])
    expect(transport.startOptions).toMatchObject({
      argv: ['/Users/test/.bun/bin/omp', '-e', '/Users/test/dsh-agent-dag/omp-link-headers.js'],
      cwd: '/work/project',
      session: { kind: 'new' },
    })
    expect(transport.startOptions?.env).toEqual({
      PI_CODING_AGENT_DIR: '/Users/test/.omp/agent',
      DSH_ACP_LINK_HEADERS: '{"x-link":"1"}',
    })
    transport.startOptions?.spawn({ argv: ['agent'], cwd: '/work/project', env: { A: '1' } })
    expect(harness.spawned).toEqual([{ argv: ['agent'], cwd: '/work/project', env: { A: '1' }, graceMs: 2000 }])
    expect(harness.runtime.acpSessionId).toBe('omp-session-new')
    expect(harness.runtime.agentInfo).toEqual({ name: 'omp', version: '18.12.6' })
    expect(harness.runtime.inputImageSupported).toBe(true)
  })

  it('derives its capabilities from the transport: fork support and the current model image input', async () => {
    const harness = build({ canFork: false, controls: vendorControls('omp', { imageInput: false }) })
    await harness.runtime.start()
    expect(harness.runtime.agentCapabilities).toEqual({
      loadSession: true,
      promptCapabilities: { image: false, embeddedContext: true },
      sessionCapabilities: { resume: {} },
    })
    expect(harness.runtime.inputImageSupported).toBe(false)
  })

  it('is idempotent and single-flight', async () => {
    const harness = build()
    await Promise.all([harness.runtime.start(), harness.runtime.start()])
    await harness.runtime.start()
    expect(first(harness).calls).toEqual(['start:new'])
    expect(harness.transports).toHaveLength(1)
  })

  it('closes a transport whose start failed and starts the next attempt on a fresh one', async () => {
    const harness = build({}, {}, (transport, index) => {
      if (index === 0) transport.startError = new NativeTransportError('could not launch omp', 'spawn-failed')
    })
    await expect(harness.runtime.start()).rejects.toMatchObject({ code: 'spawn-failed' })
    expect(first(harness).closeCount).toBe(1)
    expect(harness.runtime.acpSessionId).toBeUndefined()
    await harness.runtime.start()
    expect(harness.transports).toHaveLength(2)
    expect(harness.runtime.acpSessionId).toBe('omp-session-new')
  })

  it('does not start when the caller already aborted', async () => {
    const harness = build()
    await expect(harness.runtime.start(AbortSignal.abort(new Error('stopped')))).rejects.toThrow('stopped')
    expect(first(harness).calls).toEqual([])
  })

  it('closes idempotently, clears its session and starts later work on a fresh transport', async () => {
    const harness = build()
    await harness.runtime.start()
    await Promise.all([harness.runtime.close(), harness.runtime.close()])
    expect(first(harness).closeCount).toBe(1)
    expect(harness.runtime.acpSessionId).toBeUndefined()
    expect(harness.runtime.configOptions).toBeUndefined()
    await harness.runtime.start()
    expect(harness.transports).toHaveLength(2)
    expect(harness.transports[1]?.calls).toEqual(['start:new'])
  })

  it('has nothing to close before a session was started', async () => {
    const harness = build()
    await harness.runtime.close()
    expect(first(harness).closeCount).toBe(0)
  })
})

describe('NativeSessionRuntime restore', () => {
  it('resumes a cold runtime with the binding id the ACP route saved, then reuses it', async () => {
    const harness = build()
    expect(await harness.runtime.restore({ agentSessionId: 'f5d6c0de-1111-4222-8333-944455556666' })).toBe('resumed')
    const transport = first(harness)
    expect(transport.calls).toEqual(['start:resume'])
    expect(transport.startOptions?.session).toEqual({
      kind: 'resume',
      sessionId: 'f5d6c0de-1111-4222-8333-944455556666',
    })
    expect(harness.runtime.acpSessionId).toBe('f5d6c0de-1111-4222-8333-944455556666')
    expect(await harness.runtime.restore({ agentSessionId: 'f5d6c0de-1111-4222-8333-944455556666' })).toBe('reused')
    expect(transport.calls).toEqual(['start:resume'])
  })

  it('reuses the session a start created', async () => {
    const harness = build()
    await harness.runtime.start()
    expect(await harness.runtime.restore({ agentSessionId: 'omp-session-new' })).toBe('reused')
    expect(first(harness).calls).toEqual(['start:new'])
  })

  it('rejects a binding that names another session than the one it holds', async () => {
    const harness = build()
    await harness.runtime.start()
    await expect(harness.runtime.restore({ agentSessionId: 'another-session' })).rejects.toThrow(
      'ACP binding session id does not match the active runtime',
    )
  })

  it('re-attaches through a fresh transport when the process behind the session is gone', async () => {
    const harness = build()
    await harness.runtime.restore({ agentSessionId: 'vendor-1' })
    first(harness).closed = true
    expect(await harness.runtime.restore({ agentSessionId: 'vendor-1' })).toBe('resumed')
    expect(first(harness).closeCount).toBe(1)
    expect(harness.transports).toHaveLength(2)
    expect(harness.transports[1]?.startOptions?.session).toEqual({ kind: 'resume', sessionId: 'vendor-1' })
    expect(harness.runtime.acpSessionId).toBe('vendor-1')
  })

  it('passes a vendor that does not know the session through unchanged', async () => {
    const harness = build({}, {}, (transport) => {
      transport.startError = new NativeTransportError('OMP session not found: vendor-gone', 'session-not-found')
    })
    await expect(harness.runtime.restore({ agentSessionId: 'vendor-gone' })).rejects.toMatchObject({
      code: 'session-not-found',
      message: expect.stringMatching(/session not found/i),
    })
    expect(harness.runtime.acpSessionId).toBeUndefined()
  })

  it('refuses a vendor that resumed another session than the binding names', async () => {
    const harness = build({}, {}, (transport) => {
      const start = transport.start.bind(transport)
      transport.start = async (options) => {
        await start(options)
        transport.sessionId = 'some-other-session'
      }
    })
    await expect(harness.runtime.restore({ agentSessionId: 'vendor-1' })).rejects.toMatchObject({
      code: 'protocol-error',
    })
    expect(harness.runtime.acpSessionId).toBeUndefined()
    expect(first(harness).closeCount).toBe(1)
  })

  it('refuses to restore while a prompt runs', async () => {
    const harness = build()
    await harness.runtime.start()
    const turn = openTurn(first(harness))
    const prompting = harness.runtime.prompt(text('work'), () => undefined)
    await turn.started
    await expect(harness.runtime.restore({ agentSessionId: 'omp-session-new' })).rejects.toThrow(
      'ACP_PROMPT_ALREADY_ACTIVE',
    )
    turn.finish()
    await prompting
  })

  it('reports a binding the first native preview recorded as a session no vendor knows, without launching anything', async () => {
    const harness = build()
    for (const binding of [
      { agentSessionId: PREVIEW_ID },
      { agentSessionId: PREVIEW_ID, committedPromptOrdinal: 0 },
      { agentSessionId: 'native-codex-3c392f16-a6ed-4955-9815-ae3b83b599e4', committedPromptOrdinal: 3 },
    ]) {
      await expect(harness.runtime.restore(binding)).rejects.toMatchObject({
        code: 'session-not-found',
        message: expect.stringMatching(/session not found/i),
      })
    }
    expect(first(harness).calls).toEqual([])
    expect(harness.spawned).toEqual([])
    expect(harness.runtime.acpSessionId).toBeUndefined()
  })
})

describe('NativeSessionRuntime agent liveness', () => {
  it('knows from the host spawner that the agent process is gone, whatever the transport reports', async () => {
    const harness = build({}, {}, (transport) => {
      transport.spawnAtStart = true
      transport.reportsClosed = false
    })
    await harness.runtime.start()
    expect(harness.processes).toHaveLength(1)
    expect(harness.runtime.inputImageSupported).toBe(true)
    harness.processes[0]!.exit()
    await vi.waitFor(() => expect(harness.runtime.inputImageSupported).toBeUndefined())
    expect(first(harness).closeCount).toBe(0)

    expect(await harness.runtime.restore({ agentSessionId: 'omp-session-new' })).toBe('resumed')
    expect(first(harness).closeCount).toBe(1)
    expect(harness.processes[0]!.terminated).toBe(1)
    expect(harness.transports).toHaveLength(2)
    expect(harness.transports[1]?.startOptions?.session).toEqual({ kind: 'resume', sessionId: 'omp-session-new' })
    expect(harness.runtime.inputImageSupported).toBe(true)
    expect(harness.processes).toHaveLength(2)
  })

  it('does not mistake one of two agent processes exiting for the agent being gone', async () => {
    const harness = build({}, {}, (transport) => {
      transport.reportsClosed = false
    })
    await harness.runtime.start()
    const spawn = first(harness).startOptions!.spawn
    spawn({ argv: ['helper'], cwd: '/work/project', env: {} })
    spawn({ argv: ['agent'], cwd: '/work/project', env: {} })
    harness.processes[0]!.exit()
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    expect(harness.runtime.inputImageSupported).toBe(true)
    harness.processes[1]!.exit()
    await vi.waitFor(() => expect(harness.runtime.inputImageSupported).toBeUndefined())
  })

  it('brings the same session back when a turn finds its process gone, never a blank one', async () => {
    const harness = build({}, {}, (transport) => {
      transport.spawnAtStart = true
      transport.reportsClosed = false
    })
    await harness.runtime.start()
    harness.processes[0]!.exit()
    await vi.waitFor(() => expect(harness.runtime.inputImageSupported).toBeUndefined())
    await harness.runtime.prompt(text('after the crash'), () => undefined)
    expect(harness.transports).toHaveLength(2)
    expect(harness.transports[1]?.calls).toEqual(['start:resume', 'prompt'])
    expect(harness.transports[1]?.startOptions?.session).toEqual({ kind: 'resume', sessionId: 'omp-session-new' })
    expect(harness.runtime.acpSessionId).toBe('omp-session-new')
  })

  it('terminates the host-owned process even when the transport leaves it running', async () => {
    const harness = build({}, {}, (transport) => {
      transport.spawnAtStart = true
    })
    await harness.runtime.start()
    await harness.runtime.close()
    expect(first(harness).closeCount).toBe(1)
    expect(harness.processes[0]!.terminated).toBe(1)
  })

  it('terminates the process of an attach that failed after the agent was launched', async () => {
    const harness = build({}, {}, (transport) => {
      transport.spawnAtStart = true
      transport.startError = new NativeTransportError('OMP did not answer', 'timeout')
    })
    await expect(harness.runtime.start()).rejects.toMatchObject({ code: 'timeout' })
    expect(first(harness).closeCount).toBe(1)
    expect(harness.processes[0]!.terminated).toBe(1)
  })

  it('stops waiting for a transport that never finishes closing, and terminates its process', async () => {
    vi.useFakeTimers()
    try {
      const harness = build({}, {}, (transport) => {
        transport.spawnAtStart = true
        transport.hangOnClose = true
      })
      await harness.runtime.start()
      const closing = harness.runtime.close()
      await vi.advanceTimersByTimeAsync(14_000)
      expect(harness.processes[0]!.terminated).toBe(0)
      await vi.advanceTimersByTimeAsync(2_000)
      await closing
      expect(harness.processes[0]!.terminated).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('NativeSessionRuntime fork', () => {
  const parent = '11111111-2222-4333-8444-555555555555'

  it('forks the parent session and reports the child with its controls', async () => {
    const order: string[] = []
    const harness = build({ forkSessionId: 'child-session' })
    const response = await harness.runtime.fork(parent, undefined, { agent: { name: 'omp' }, protocolVersion: 1 }, async () => {
      order.push(`before-dispatch:${first(harness).calls.join(',') || 'nothing sent'}`)
    })
    expect(order).toEqual(['before-dispatch:nothing sent'])
    expect(first(harness).calls).toEqual(['start:fork'])
    expect(first(harness).startOptions?.session).toEqual({ kind: 'fork', parentSessionId: parent })
    expect(response.sessionId).toBe('child-session')
    expect(response.configOptions?.map((option) => option.id)).toEqual(['mode', 'model', 'thinking'])
    expect(response.modes?.currentModeId).toBe('default')
    expect(harness.runtime.acpSessionId).toBe('child-session')
  })

  it('proves nothing was dispatched when the agent cannot fork', async () => {
    const beforeDispatch = vi.fn(async () => undefined)
    const harness = build({ canFork: false })
    const failure = await harness.runtime.fork(parent, undefined, undefined, beforeDispatch).catch((error) => error)
    expect(failure).toBeInstanceOf(AcpForkPreDispatchError)
    expect(failure.code).toBe('ACP_FORK_UNSUPPORTED')
    expect(beforeDispatch).not.toHaveBeenCalled()
    expect(first(harness).calls).toEqual([])
  })

  it('proves nothing was dispatched when the agent no longer matches the parent binding', async () => {
    const beforeDispatch = vi.fn(async () => undefined)
    for (const expected of [
      { agent: { name: 'codex' } },
      { agent: { name: 'omp', version: '17.0.0' } },
      { protocolVersion: 2 },
    ]) {
      const harness = build({ agentInfo: { name: 'omp', version: '18.12.6' } })
      const failure = await harness.runtime.fork(parent, undefined, expected, beforeDispatch).catch((error) => error)
      expect(failure).toBeInstanceOf(AcpForkPreDispatchError)
      expect(failure.code).toBe('ACP_FORK_PRECONDITION_FAILED')
      expect(first(harness).calls).toEqual([])
    }
    expect(beforeDispatch).not.toHaveBeenCalled()
  })

  it('accepts a parent binding recorded by the ACP adapter of the same vendor', async () => {
    const harness = build({ kind: 'codex', agentInfo: { name: 'codex', version: '0.162.1' } })
    await harness.runtime.fork(parent, undefined, {
      agent: { name: '@agentclientprotocol/codex-acp', version: '2.2.2' },
      protocolVersion: 1,
    })
    expect(first(harness).calls).toEqual(['start:fork'])
  })

  it('does not compare a version the transport cannot know before it started', async () => {
    const harness = build({ agentInfo: { name: 'omp', version: '' } })
    await harness.runtime.fork(parent, undefined, { agent: { name: 'omp', version: '18.10.4' } })
    expect(first(harness).calls).toEqual(['start:fork'])
  })

  it('fails before the fork intent is recorded when the launch cannot be prepared, and prepares it once otherwise', async () => {
    const beforeDispatch = vi.fn(async () => undefined)
    const rejected = build(
      {},
      {
        prepareLaunch: async () => {
          throw new Error('launch policy rejected the agent')
        },
      },
    )
    const failure = await rejected.runtime.fork(parent, undefined, undefined, beforeDispatch).catch((error) => error)
    expect(failure).toBeInstanceOf(AcpForkPreDispatchError)
    expect(failure.code).toBe('ACP_FORK_PRECONDITION_FAILED')
    expect(failure.cause).toMatchObject({ message: 'launch policy rejected the agent' })
    expect(beforeDispatch).not.toHaveBeenCalled()
    expect(first(rejected).calls).toEqual([])

    const accepted = build()
    await accepted.runtime.fork(parent, undefined, undefined, beforeDispatch)
    expect(beforeDispatch).toHaveBeenCalledTimes(1)
    expect(accepted.prepared).toEqual(['/work/project'])
  })

  it('marks a failed intent write as not dispatched and keeps its cause', async () => {
    const cause = new Error('sidecar unavailable')
    const harness = build()
    const failure = await harness.runtime
      .fork(parent, undefined, undefined, async () => {
        throw cause
      })
      .catch((error) => error)
    expect(failure).toBeInstanceOf(AcpForkPreDispatchError)
    expect(failure.code).toBe('ACP_FORK_INTENT_FAILED')
    expect(failure.cause).toBe(cause)
    expect(first(harness).calls).toEqual([])
  })

  it('leaves the outcome unknown once the vendor was asked and failed', async () => {
    const harness = build({}, {}, (transport) => {
      transport.startError = new NativeTransportError('OMP process exited', 'process-exit')
    })
    const failure = await harness.runtime.fork(parent).catch((error) => error)
    expect(failure).not.toBeInstanceOf(AcpForkPreDispatchError)
    expect(failure).toMatchObject({ code: 'process-exit' })
    expect(harness.runtime.acpSessionId).toBeUndefined()
  })

  it('rejects a vendor that hands back the parent as the child', async () => {
    const harness = build({ forkSessionId: parent })
    await expect(harness.runtime.fork(parent)).rejects.toThrow('ACP_FORK_INVALID_RESPONSE')
    expect(harness.runtime.acpSessionId).toBeUndefined()
    expect(first(harness).closeCount).toBe(1)
  })

  it('cannot fork a binding the first native preview recorded, and never forks twice', async () => {
    const harness = build()
    const failure = await harness.runtime.fork(PREVIEW_ID).catch((error) => error)
    expect(failure).toBeInstanceOf(AcpForkPreDispatchError)
    expect(failure.code).toBe('ACP_FORK_UNSUPPORTED')
    await harness.runtime.start()
    await expect(harness.runtime.fork(parent)).rejects.toThrow('ACP runtime already owns a session')
  })
})

describe('NativeSessionRuntime controls', () => {
  it('exposes the transport controls as detached ACP snapshots', async () => {
    const harness = build()
    await harness.runtime.start()
    expect(harness.runtime.configOptions?.map((option) => option.id)).toEqual(['mode', 'model', 'thinking'])
    expect(harness.runtime.modes).toEqual({
      currentModeId: 'default',
      availableModes: [{ id: 'default', name: 'Default', description: 'Standard ACP headless mode' }],
    })
    expect(harness.runtime.currentModeId).toBe('default')
    const model = harness.runtime.configOptions?.find((option) => option.id === 'model')
    expect(model).toMatchObject({ type: 'select', currentValue: 'tokenrouter/claude-opus-5.5', category: 'model' })
    expect(harness.runtime.configOptions).not.toBe(harness.runtime.configOptions)
  })

  it('applies a control write through the transport and reflects it when the promise resolves', async () => {
    const harness = build()
    await harness.runtime.start()
    await harness.runtime.setConfigOption('model', 'tokenrouter/gpt-5.5')
    expect(first(harness).calls).toEqual(['start:new', 'set:model=tokenrouter/gpt-5.5'])
    expect(harness.runtime.configOptions?.find((option) => option.id === 'model')?.currentValue).toBe(
      'tokenrouter/gpt-5.5',
    )
    expect(harness.notifications.map((notification) => notification.update.sessionUpdate)).toEqual([
      'config_option_update',
    ])
    expect(harness.notifications[0]).toMatchObject({ sessionId: 'omp-session-new' })
  })

  it('does not announce a write the vendor also reported on its own', async () => {
    const harness = build({ kind: 'claude' })
    await harness.runtime.start()
    const transport = first(harness)
    const planned = vendorControls('claude', { mode: 'plan' })
    transport.beforeSet = async () => transport.emit({ kind: 'controls', controls: planned })
    await harness.runtime.setConfigOption('mode', 'plan')
    expect(updateKinds(harness.notifications)).toEqual(['config_option_update', 'current_mode_update'])
  })

  it('writes the legacy mode through the vendor mode option and announces the new mode', async () => {
    const harness = build({ kind: 'claude' })
    await harness.runtime.start()
    await harness.runtime.setMode('bypassPermissions')
    expect(first(harness).calls).toEqual(['start:new', 'set:mode=bypassPermissions'])
    expect(harness.runtime.currentModeId).toBe('bypassPermissions')
    expect(harness.runtime.modes?.currentModeId).toBe('bypassPermissions')
    expect(harness.notifications.map((notification) => notification.update)).toEqual([
      expect.objectContaining({ sessionUpdate: 'config_option_update' }),
      { sessionUpdate: 'current_mode_update', currentModeId: 'bypassPermissions' },
    ])
  })

  it('rejects a value the vendor does not allow and keeps the snapshot', async () => {
    const harness = build({ kind: 'claude' })
    await harness.runtime.start()
    await expect(harness.runtime.setConfigOption('model', 'gpt-9')).rejects.toMatchObject({ code: 'invalid-config' })
    await expect(harness.runtime.setMode('dontAsk')).rejects.toMatchObject({ code: 'invalid-config' })
    expect(harness.runtime.currentModeId).toBe('default')
    expect(harness.notifications).toEqual([])
  })

  it('serializes writes in the order they were issued', async () => {
    const harness = build({ kind: 'claude' })
    await harness.runtime.start()
    const transport = first(harness)
    const gate = Promise.withResolvers<void>()
    let held = true
    transport.beforeSet = async () => {
      if (held) {
        held = false
        await gate.promise
      }
    }
    const firstWrite = harness.runtime.setConfigOption('model', 'opus')
    const secondWrite = harness.runtime.setConfigOption('effort', 'high')
    await vi.waitFor(() => expect(transport.calls).toContain('set:model=opus'))
    expect(transport.calls).not.toContain('set:effort=high')
    gate.resolve()
    await Promise.all([firstWrite, secondWrite])
    expect(transport.calls).toEqual(['start:new', 'set:model=opus', 'set:effort=high'])
  })

  it('keeps later writes alive after an earlier one failed', async () => {
    const harness = build({ kind: 'claude' })
    await harness.runtime.start()
    const failing = harness.runtime.setConfigOption('model', 'nope')
    const working = harness.runtime.setConfigOption('model', 'sonnet')
    await expect(failing).rejects.toMatchObject({ code: 'invalid-config' })
    await working
    expect(harness.runtime.configOptions?.find((option) => option.id === 'model')?.currentValue).toBe('sonnet')
  })

  it('rejects control writes while a prompt runs and before a session exists', async () => {
    const harness = build({ kind: 'claude' })
    await expect(harness.runtime.setConfigOption('model', 'opus')).rejects.toThrow('ACP session is not started')
    await expect(harness.runtime.setMode('plan')).rejects.toThrow('ACP session is not started')
    await harness.runtime.start()
    const turn = openTurn(first(harness))
    const prompting = harness.runtime.prompt(text('work'), () => undefined)
    await turn.started
    await expect(harness.runtime.setConfigOption('model', 'opus')).rejects.toThrow('ACP_CONFIG_CHANGE_DURING_PROMPT')
    await expect(harness.runtime.setMode('plan')).rejects.toThrow('ACP_CONFIG_CHANGE_DURING_PROMPT')
    expect(first(harness).calls).toEqual(['start:new', 'prompt'])
    turn.finish()
    await prompting
    await harness.runtime.setMode('plan')
    expect(harness.runtime.currentModeId).toBe('plan')
  })

  it('announces a change the vendor made on its own', async () => {
    const harness = build({ kind: 'claude' })
    await harness.runtime.start()
    first(harness).changeControls(vendorControls('claude', { mode: 'plan' }))
    expect(updateKinds(harness.notifications)).toEqual(['config_option_update', 'current_mode_update'])
    expect(harness.notifications[1]?.update).toEqual({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' })
    first(harness).changeControls(vendorControls('claude', { mode: 'plan' }))
    expect(harness.notifications).toHaveLength(2)
    expect(harness.runtime.currentModeId).toBe('plan')
  })

  it('announces a change made during a turn to the running prompt as well', async () => {
    const harness = build({ kind: 'claude' })
    await harness.runtime.start()
    const heard: AcpSessionNotification[] = []
    first(harness).promptScript = async () => {
      first(harness).changeControls(vendorControls('claude', { mode: 'acceptEdits' }))
      return { stopReason: 'end_turn' }
    }
    await harness.runtime.prompt(text('work'), (notification) => heard.push(notification))
    expect(updateKinds(heard)).toEqual(['config_option_update', 'current_mode_update'])
    expect(updateKinds(harness.notifications)).toEqual(['config_option_update', 'current_mode_update'])
  })

  it('announces a change the vendor made without telling when the turn ends', async () => {
    const harness = build({ kind: 'claude' })
    await harness.runtime.start()
    const transport = first(harness)
    const heard: AcpSessionNotification[] = []
    transport.promptScript = async () => {
      await transport.setConfigOption('mode', 'plan')
      return { stopReason: 'end_turn' }
    }
    await harness.runtime.prompt(text('work'), (notification) => heard.push(notification))
    expect(updateKinds(heard)).toEqual(['config_option_update', 'current_mode_update'])
  })

  describe('mode contract', () => {
    const modelOnly: NativeControls = {
      configOptions: vendorControls('claude').configOptions.filter((option) => option.id === 'model'),
      modes: undefined,
      imageInput: true,
    }

    it('offers the exact ACP modes even when the transport reports none', async () => {
      for (const [kind, expected] of [
        ['claude', ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']],
        ['codex', ['read-only', 'workspace-write', 'agent', 'agent-full-access']],
        ['omp', ['default']],
      ] as const) {
        const harness = build({ kind, controls: modelOnly })
        await harness.runtime.start()
        const mode = harness.runtime.configOptions?.[0]
        expect(mode).toMatchObject({ id: 'mode', category: 'mode', type: 'select' })
        expect(
          mode?.type === 'select' ? mode.options.map((entry) => ('value' in entry ? entry.value : entry.group)) : [],
        ).toEqual(expected)
        expect(harness.runtime.modes?.availableModes.map((entry) => entry.id)).toEqual(expected)
        expect(harness.runtime.currentModeId).toBe(NATIVE_MODE_CONTRACTS[kind].defaultModeId)
      }
    })

    it('applies the saved intents of the desktop sessions', async () => {
      const claude = build({ kind: 'claude' })
      await claude.runtime.start()
      await claude.runtime.setMode('bypassPermissions')
      expect(claude.runtime.currentModeId).toBe('bypassPermissions')
      const codex = build({ kind: 'codex' })
      await codex.runtime.start()
      expect(codex.runtime.currentModeId).toBe('agent')
      expect(codex.runtime.modes?.availableModes.find((mode) => mode.id === 'agent-full-access')).toEqual({
        id: 'agent-full-access',
        name: 'Full access',
        description: 'Unrestricted access to the internet and any file on your computer',
      })
      await codex.runtime.setConfigOption('mode', 'agent-full-access')
      expect(codex.runtime.currentModeId).toBe('agent-full-access')
      expect(codex.transports[0]?.calls).toEqual(['start:new', 'set:mode=agent-full-access'])
    })

    it('never offers a plan mode OMP cannot apply natively', async () => {
      const reported: NativeControls = {
        ...vendorControls('omp'),
        modes: {
          currentModeId: 'plan',
          availableModes: [
            { id: 'default', name: 'Default' },
            { id: 'plan', name: 'Plan' },
          ],
        },
        configOptions: vendorControls('omp').configOptions.map((option) =>
          option.id === 'mode' && option.type === 'select'
            ? {
                ...option,
                currentValue: 'plan',
                options: [
                  { value: 'default', name: 'Default' },
                  { value: 'plan', name: 'Plan' },
                ],
              }
            : option,
        ),
      }
      const harness = build({ kind: 'omp', controls: reported })
      await harness.runtime.start()
      expect(harness.runtime.modes?.availableModes.map((mode) => mode.id)).toEqual(['default'])
      expect(harness.runtime.currentModeId).toBe('default')
    })

    it('keeps vendor-only modes and renames the contract ones exactly', () => {
      const reported = vendorControls('claude')
      const controls = withNativeModeContract('claude', {
        ...reported,
        configOptions: reported.configOptions.map((option) =>
          option.id === 'mode' && option.type === 'select'
            ? {
                ...option,
                options: [
                  { value: 'default', name: 'Default permissions' },
                  { value: 'dontAsk', name: "Don't ask" },
                ],
              }
            : option,
        ),
      })
      const mode = controls.configOptions[0]
      expect(mode?.type === 'select' ? mode.options : []).toEqual([
        { value: 'default', name: 'Manual', description: 'Always ask before making changes' },
        { value: 'acceptEdits', name: 'Accept edits', description: 'Automatically accept all file edits' },
        { value: 'plan', name: 'Plan', description: 'Create a plan before making changes' },
        { value: 'auto', name: 'Auto', description: 'Claude handles permission decisions' },
        { value: 'bypassPermissions', name: 'Bypass permissions', description: 'Accepts all permissions' },
        { value: 'dontAsk', name: "Don't ask" },
      ])
    })

    it('leaves conforming controls unchanged', () => {
      for (const kind of ['claude', 'codex', 'omp'] as const) {
        const controls = vendorControls(kind, { mode: NATIVE_MODE_CONTRACTS[kind].modes[0]!.id })
        expect(withNativeModeContract(kind, controls)).toEqual(controls)
      }
    })

    it('maps every Codex mode onto its approval policy and sandbox', () => {
      expect(codexModeSettings('agent')).toMatchObject({
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review',
        sandboxMode: 'workspace-write',
      })
      expect(codexModeSettings('agent-full-access')).toEqual({
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandboxMode: 'danger-full-access',
        sandboxPolicy: { type: 'dangerFullAccess' },
      })
      expect(NATIVE_MODE_CONTRACTS.codex.modes.map((mode) => codexModeSettings(mode.id) !== undefined)).toEqual([
        true,
        true,
        true,
        true,
      ])
      expect(codexModeSettings('full-access')).toBeUndefined()
    })
  })
})

describe('NativeSessionRuntime prompt', () => {
  it('starts the session lazily and returns the whole-turn usage in ACP shape', async () => {
    const harness = build({}, {}, (transport) => {
      transport.promptScript = async () => ({
        stopReason: 'end_turn',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cachedReadTokens: 3,
          cachedWriteTokens: 2,
          thoughtTokens: 4,
          costUsd: 0.2,
        },
      })
    })
    const response = await harness.runtime.prompt(text('hello'), () => undefined)
    expect(first(harness).calls).toEqual(['start:new', 'prompt'])
    expect(response).toEqual({
      stopReason: 'end_turn',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 20,
        cachedReadTokens: 3,
        cachedWriteTokens: 2,
        thoughtTokens: 4,
      },
    })
  })

  it('omits what the vendor did not report', async () => {
    const harness = build()
    await harness.runtime.start()
    const transport = first(harness)
    transport.promptScript = async () => ({
      stopReason: 'max_tokens',
      usage: { inputTokens: 7, outputTokens: 1, cachedReadTokens: 0, cachedWriteTokens: 0 },
    })
    expect(await harness.runtime.prompt(text('a'), () => undefined)).toEqual({
      stopReason: 'max_tokens',
      usage: { inputTokens: 7, outputTokens: 1, totalTokens: 8, cachedReadTokens: 0, cachedWriteTokens: 0 },
    })
    transport.promptScript = async () => ({ stopReason: 'refusal' })
    expect(await harness.runtime.prompt(text('b'), () => undefined)).toEqual({ stopReason: 'refusal' })
    transport.promptScript = async () => ({
      stopReason: 'end_turn',
      usage: { inputTokens: Number.NaN, outputTokens: 1, cachedReadTokens: 0, cachedWriteTokens: 0 },
    })
    expect(await harness.runtime.prompt(text('c'), () => undefined)).toEqual({ stopReason: 'end_turn' })
  })

  it('fans transport updates out to the running prompt and to the runtime hook, outside a turn only to the hook', async () => {
    const harness = build()
    await harness.runtime.start()
    const transport = first(harness)
    const heard: AcpSessionNotification[] = []
    transport.emit({ kind: 'update', update: messageChunk('idle') })
    transport.promptScript = async (context) => {
      context.update(messageChunk('turn'))
      return { stopReason: 'end_turn' }
    }
    await harness.runtime.prompt(text('work'), (notification) => heard.push(notification))
    transport.emit({ kind: 'update', update: messageChunk('after') })
    const chunks = (notifications: readonly AcpSessionNotification[]): string[] =>
      notifications.flatMap(({ update }) =>
        update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? [update.content.text] : [],
      )
    expect(chunks(heard)).toEqual(['turn'])
    expect(chunks(harness.notifications)).toEqual(['idle', 'turn', 'after'])
    expect(heard[0]).toEqual({ sessionId: 'omp-session-new', update: messageChunk('turn') })
  })

  it('keeps a failing listener from breaking the others', async () => {
    const log = vi.fn()
    const harness = build({}, { log })
    await harness.runtime.start()
    first(harness).promptScript = async (context) => {
      context.update(messageChunk('one'))
      context.update(messageChunk('two'))
      return { stopReason: 'end_turn' }
    }
    const heard: AcpSessionNotification[] = []
    await harness.runtime.prompt(text('work'), (notification) => {
      heard.push(notification)
      throw new Error('listener failed')
    })
    expect(heard).toHaveLength(2)
    expect(harness.notifications).toHaveLength(2)
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('reports context occupancy as ACP usage updates and as the runtime context usage', async () => {
    const harness = build()
    expect(harness.runtime.contextUsage).toBeUndefined()
    await harness.runtime.start()
    const transport = first(harness)
    transport.emit({
      kind: 'context_usage',
      contextUsage: { used: 42_000, size: 200_000, cost: { amount: 0.5, currency: 'USD' } },
    })
    transport.emit({ kind: 'context_usage', contextUsage: { used: 50_000, size: 200_000 } })
    expect(harness.notifications.map((notification) => notification.update)).toEqual([
      { sessionUpdate: 'usage_update', used: 42_000, size: 200_000, cost: { amount: 0.5, currency: 'USD' } },
      { sessionUpdate: 'usage_update', used: 50_000, size: 200_000 },
    ])
    expect(harness.runtime.contextUsage).toEqual({ used: 50_000, size: 200_000 })
    transport.context = { used: 60_000, size: 200_000, cost: { amount: 0.75, currency: 'USD' } }
    expect(harness.runtime.contextUsage).toEqual({
      used: 60_000,
      size: 200_000,
      cost: { amount: 0.75, currency: 'USD' },
    })
  })

  it('is busy for exactly one turn at a time', async () => {
    const harness = build()
    await harness.runtime.start()
    const turn = openTurn(first(harness))
    const prompting = harness.runtime.prompt(text('first'), () => undefined)
    expect(harness.runtime.isBusy).toBe(true)
    await turn.started
    await expect(harness.runtime.prompt(text('second'), () => undefined)).rejects.toThrow('ACP_PROMPT_ALREADY_ACTIVE')
    turn.finish()
    await prompting
    expect(harness.runtime.isBusy).toBe(false)
    expect(first(harness).calls.filter((call) => call === 'prompt')).toHaveLength(1)
  })

  it('releases the turn when the vendor loses it and passes the failure through', async () => {
    const harness = build()
    await harness.runtime.start()
    const transport = first(harness)
    transport.promptScript = async () => {
      throw new NativeTransportError('OMP process exited', 'process-exit')
    }
    await expect(harness.runtime.prompt(text('work'), () => undefined)).rejects.toMatchObject({ code: 'process-exit' })
    expect(harness.runtime.isBusy).toBe(false)
    expect(harness.runtime.canSteer).toBe(false)
    transport.promptScript = async () => ({ stopReason: 'end_turn' })
    await harness.runtime.prompt(text('again'), () => undefined)
  })

  it('does not dispatch a turn that was stopped before it started', async () => {
    const harness = build()
    await harness.runtime.start()
    const response = await harness.runtime.prompt(text('work'), () => undefined, AbortSignal.abort())
    expect(response).toEqual({ stopReason: 'cancelled' })
    expect(first(harness).calls).toEqual(['start:new'])
    expect(harness.runtime.isBusy).toBe(false)
  })

  it('hands the stop signal to the vendor and resolves what the vendor confirmed', async () => {
    const harness = build()
    await harness.runtime.start()
    const transport = first(harness)
    const seen = Promise.withResolvers<AbortSignal>()
    transport.promptScript = async (context) => {
      seen.resolve(context.signal)
      return await context.cancelled()
    }
    const stop = new AbortController()
    const prompting = harness.runtime.prompt(text('work'), () => undefined, stop.signal)
    const signal = await seen.promise
    expect(signal.aborted).toBe(false)
    stop.abort()
    expect(signal.aborted).toBe(true)
    expect(await prompting).toEqual({ stopReason: 'cancelled' })
    expect(transport.closeCount).toBe(0)
  })

  it('closes a vendor that never settles a stopped turn after the backstop', async () => {
    const harness = build({}, { cancelGraceMs: 20 })
    await harness.runtime.start()
    const transport = first(harness)
    transport.promptScript = async () => await new Promise<never>(() => undefined)
    const stop = new AbortController()
    void harness.runtime.prompt(text('work'), () => undefined, stop.signal).catch(() => undefined)
    await vi.waitFor(() => expect(transport.calls).toContain('prompt'))
    stop.abort()
    await vi.waitFor(() => expect(transport.closeCount).toBe(1))
    expect(harness.runtime.acpSessionId).toBeUndefined()
  })

  it('aborts the running turn when the runtime is closed', async () => {
    const harness = build()
    await harness.runtime.start()
    const transport = first(harness)
    transport.promptScript = async (context) => await context.cancelled()
    const prompting = harness.runtime.prompt(text('work'), () => undefined)
    await vi.waitFor(() => expect(transport.calls).toContain('prompt'))
    await harness.runtime.close()
    expect(await prompting).toEqual({ stopReason: 'cancelled' })
    expect(transport.closeCount).toBe(1)
  })

  it('refuses a prompt that carries nothing the vendor can receive', async () => {
    const harness = build()
    await harness.runtime.start()
    await expect(harness.runtime.prompt([], () => undefined)).rejects.toThrow('carries no content')
    expect(harness.runtime.isBusy).toBe(false)
  })

  it('sends text, images and resources to the vendor in order', async () => {
    const harness = build()
    await harness.runtime.start()
    await harness.runtime.prompt(
      [
        { type: 'text', text: 'host context' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        { type: 'resource_link', name: 'notes', uri: 'file:///work/project/notes.md' },
        { type: 'resource', resource: { uri: 'file:///work/project/a.ts', text: 'export const a = 1' } },
        { type: 'text', text: 'question' },
      ],
      () => undefined,
    )
    expect(first(harness).prompts).toEqual([
      [
        { type: 'text', text: 'host context' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        { type: 'text', text: '[@notes](file:///work/project/notes.md)' },
        {
          type: 'text',
          text: '[@a.ts](file:///work/project/a.ts)\n<context ref="file:///work/project/a.ts">\nexport const a = 1\n</context>',
        },
        { type: 'text', text: 'question' },
      ],
    ])
  })
})

describe('toNativeContent', () => {
  it('keeps every text and image block verbatim', () => {
    expect(
      toNativeContent(
        [
          { type: 'text', text: '  spaced \n text ' },
          { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
        ],
        'codex',
      ),
    ).toEqual([
      { type: 'text', text: '  spaced \n text ' },
      { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' },
    ])
  })

  it('presents resources as text so nothing is dropped', () => {
    expect(
      toNativeContent(
        [
          { type: 'resource_link', name: 'docs', uri: 'https://example.test/docs' },
          { type: 'resource_link', name: '', uri: 'https://example.test/bare' },
          { type: 'resource_link', name: '', uri: 'file:///tmp/dir/file.txt' },
          { type: 'resource', resource: { uri: 'file:///tmp/blob.bin', blob: 'AAAA', mimeType: 'application/pdf' } },
          { type: 'resource', resource: { uri: 'file:///tmp/pic.png', blob: 'QUJD', mimeType: 'image/png' } },
          { type: 'image', data: '', mimeType: 'image/png', uri: 'https://example.test/pic.png' },
          { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
        ],
        'omp',
      ),
    ).toEqual([
      { type: 'text', text: '[@docs](https://example.test/docs)' },
      { type: 'text', text: 'https://example.test/bare' },
      { type: 'text', text: '[@file.txt](file:///tmp/dir/file.txt)' },
      { type: 'text', text: '[embedded resource: file:///tmp/blob.bin]' },
      { type: 'image', data: 'QUJD', mimeType: 'image/png' },
      { type: 'text', text: 'https://example.test/pic.png' },
      { type: 'text', text: '[audio omitted]' },
    ])
  })

  it('rewrites the MCP slash-command form for Claude Code only', () => {
    const command: acp.ContentBlock[] = [{ type: 'text', text: '/mcp:github:review fix the tests' }]
    expect(toNativeContent(command, 'claude')).toEqual([{ type: 'text', text: '/github:review (MCP) fix the tests' }])
    expect(toNativeContent([{ type: 'text', text: '/mcp:github:review' }], 'claude')).toEqual([
      { type: 'text', text: '/github:review (MCP)' },
    ])
    expect(toNativeContent(command, 'codex')).toEqual([{ type: 'text', text: '/mcp:github:review fix the tests' }])
  })
})

describe('NativeSessionRuntime steering', () => {
  it('can steer only while a turn runs', async () => {
    const harness = build()
    await harness.runtime.start()
    const transport = first(harness)
    const onDispatch = vi.fn()
    expect(harness.runtime.canSteer).toBe(false)
    expect(await harness.runtime.steer(text('too early'), onDispatch)).toBe('promptRequired')
    expect(onDispatch).not.toHaveBeenCalled()
    expect(transport.steers).toEqual([])
    const turn = openTurn(transport)
    const prompting = harness.runtime.prompt(text('work'), () => undefined)
    await turn.started
    expect(harness.runtime.canSteer).toBe(true)
    turn.finish()
    await prompting
    expect(harness.runtime.canSteer).toBe(false)
    expect(await harness.runtime.steer(text('too late'), onDispatch)).toBe('promptRequired')
    expect(transport.steers).toEqual([])
  })

  it('hands the dispatch boundary over immediately before the vendor sees the message', async () => {
    const harness = build()
    await harness.runtime.start()
    const transport = first(harness)
    const turn = openTurn(transport)
    const prompting = harness.runtime.prompt(text('work'), () => undefined)
    await turn.started
    const result = await harness.runtime.steer(
      [
        { type: 'text', text: 'also check the tests' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ],
      () => transport.calls.push('dispatch'),
    )
    expect(result).toBe('injected')
    expect(transport.calls).toEqual(['start:new', 'prompt', 'dispatch', 'steer'])
    expect(transport.steers).toEqual([
      [
        { type: 'text', text: 'also check the tests' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ],
    ])
    turn.finish()
    await prompting
  })

  it('returns a refusal and passes an unknown acceptance through', async () => {
    const harness = build()
    await harness.runtime.start()
    const transport = first(harness)
    const turn = openTurn(transport)
    const prompting = harness.runtime.prompt(text('work'), () => undefined)
    await turn.started
    const onDispatch = vi.fn()
    transport.steerResult = 'promptRequired'
    expect(await harness.runtime.steer(text('no'), onDispatch)).toBe('promptRequired')
    expect(onDispatch).toHaveBeenCalledTimes(1)
    transport.steerError = new NativeTransportError('steer outcome unknown', 'timeout')
    await expect(harness.runtime.steer(text('maybe'), onDispatch)).rejects.toMatchObject({ code: 'timeout' })
    expect(onDispatch).toHaveBeenCalledTimes(2)
    expect(await harness.runtime.steer([], onDispatch)).toBe('promptRequired')
    expect(onDispatch).toHaveBeenCalledTimes(2)
    turn.finish()
    await prompting
  })
})

describe('NativeSessionRuntime permissions', () => {
  const options: acp.PermissionOption[] = [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
  ]
  const request = {
    toolCall: { toolCallId: 'call-1', title: 'Run command', kind: 'execute', rawInput: { command: 'ls' } },
    options,
  } as const

  function approving(response: acp.RequestPermissionResponse | Error | 'hang') {
    return vi.fn(async (_params: acp.RequestPermissionRequest, _signal?: AbortSignal) => {
      if (response === 'hang') return await new Promise<never>(() => undefined)
      if (response instanceof Error) throw response
      return response
    })
  }

  it('forwards the request in ACP shape and answers exactly what the user chose', async () => {
    const onPermissionRequest = approving({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
    const onPermissionCheck = vi.fn(async () => undefined)
    const harness = build({}, { onPermissionRequest, onPermissionCheck })
    const decision = await duringTurn(harness, (transport) => transport.requestPermission(request))
    expect(decision).toEqual({ optionId: 'allow-once' })
    expect(onPermissionRequest).toHaveBeenCalledTimes(1)
    expect(onPermissionRequest.mock.calls[0]?.[0]).toEqual({
      sessionId: 'omp-session-new',
      toolCall: request.toolCall,
      options,
    })
    expect(onPermissionRequest.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal)
    expect(onPermissionCheck).toHaveBeenCalledWith({ reason: 'bridge-unavailable' }, expect.objectContaining({ sessionId: 'omp-session-new' }))
  })

  it('answers a refusal, a cancellation, an option it never offered and a failing bridge safely', async () => {
    const cases: [acp.RequestPermissionResponse | Error, unknown][] = [
      [{ outcome: { outcome: 'selected', optionId: 'reject-once' } }, { optionId: 'reject-once' }],
      [{ outcome: { outcome: 'cancelled' } }, { cancelled: true }],
      [{ outcome: { outcome: 'selected', optionId: 'allow-always' } }, { cancelled: true }],
      [new Error('approval service down'), { cancelled: true }],
    ]
    for (const [response, expected] of cases) {
      const harness = build({}, { onPermissionRequest: approving(response) })
      expect(await duringTurn(harness, (transport) => transport.requestPermission(request))).toEqual(expected)
    }
  })

  it('cancels when the audit of the check cannot be written', async () => {
    const onPermissionRequest = approving({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
    const harness = build(
      {},
      {
        onPermissionRequest,
        onPermissionCheck: async () => {
          throw new Error('audit unavailable')
        },
      },
    )
    expect(await duringTurn(harness, (transport) => transport.requestPermission(request))).toEqual({ cancelled: true })
    expect(onPermissionRequest).not.toHaveBeenCalled()
  })

  it('cancels outside a turn and without a host approval service', async () => {
    const onPermissionRequest = approving({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
    const harness = build({}, { onPermissionRequest })
    await harness.runtime.start()
    expect(await first(harness).requestPermission(request)).toEqual({ cancelled: true })
    expect(onPermissionRequest).not.toHaveBeenCalled()
    const bare = build()
    expect(await duringTurn(bare, (transport) => transport.requestPermission(request))).toEqual({ cancelled: true })
  })

  it('completes a request from the tool call the turn already announced', async () => {
    const onPermissionRequest = approving({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
    const harness = build({}, { onPermissionRequest })
    await duringTurn(harness, async (transport) => {
      transport.emit({
        kind: 'update',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-2',
          title: 'Bash',
          name: 'bash',
          kind: 'execute',
          status: 'pending',
          rawInput: { command: 'rm -rf build' },
        },
      })
      await transport.requestPermission({
        toolCall: { toolCallId: 'call-2', title: 'Run command' },
        options,
      })
    })
    expect(onPermissionRequest.mock.calls[0]?.[0].toolCall).toMatchObject({
      toolCallId: 'call-2',
      title: 'Run command',
      name: 'bash',
      kind: 'execute',
      status: 'pending',
      rawInput: { command: 'rm -rf build' },
    })
  })

  it('cancels a pending request when the turn ends', async () => {
    const harness = build({}, { onPermissionRequest: approving('hang') })
    await harness.runtime.start()
    const transport = first(harness)
    transport.promptScript = async (context) => {
      const decision = await transport.requestPermission(request, undefined)
      context.update(messageChunk(JSON.stringify(decision)))
      return { stopReason: 'end_turn' }
    }
    const stop = new AbortController()
    const heard: AcpSessionNotification[] = []
    const prompting = harness.runtime.prompt(text('work'), (notification) => heard.push(notification), stop.signal)
    await vi.waitFor(() => expect(transport.calls).toContain('prompt'))
    stop.abort()
    await prompting
    expect(heard[0]?.update).toEqual(messageChunk('{"cancelled":true}'))
  })

  it('cannot steer while a permission request waits for the user', async () => {
    const answer = Promise.withResolvers<acp.RequestPermissionResponse>()
    const onPermissionRequest = vi.fn(
      async (_params: acp.RequestPermissionRequest, _signal?: AbortSignal) => await answer.promise,
    )
    const harness = build({}, { onPermissionRequest })
    await duringTurn(harness, async (transport) => {
      expect(harness.runtime.canSteer).toBe(true)
      const pending = transport.requestPermission(request)
      await vi.waitFor(() => expect(onPermissionRequest).toHaveBeenCalledTimes(1))
      expect(harness.runtime.canSteer).toBe(false)
      expect(await harness.runtime.steer(text('meanwhile'))).toBe('promptRequired')
      expect(transport.steers).toEqual([])
      answer.resolve({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
      expect(await pending).toEqual({ optionId: 'allow-once' })
      expect(harness.runtime.canSteer).toBe(true)
    })
  })
})

describe('NativeSessionRuntime forms', () => {
  const requestedSchema: acp.ElicitationSchema = {
    type: 'object',
    properties: {
      question_0: {
        type: 'string',
        title: 'Library',
        oneOf: [
          { const: 'React', title: 'React' },
          { const: 'Vue', title: 'Vue' },
        ],
      },
    },
  }
  const form = { message: 'Which library should we use?', requestedSchema }
  const abandoned = { action: 'cancel' }

  function asking(response: acp.CreateElicitationResponse | Error | 'hang') {
    return vi.fn(async (_params: acp.CreateElicitationRequest, _signal?: AbortSignal) => {
      if (response === 'hang') return await new Promise<never>(() => undefined)
      if (response instanceof Error) throw response
      return response
    })
  }

  it('forwards the form with the session and answers exactly what the user filled in', async () => {
    const answer: acp.CreateElicitationResponse = { action: 'accept', content: { question_0: 'Vue' } }
    const onElicitationRequest = asking(answer)
    const harness = build({}, { onElicitationRequest })
    const response = await duringTurn(harness, (transport) =>
      transport.requestElicitation({ ...form, toolCallId: 'call-1', _meta: { codex: { autoResolutionMs: null } } }),
    )
    expect(response).toEqual(answer)
    expect(onElicitationRequest).toHaveBeenCalledTimes(1)
    expect(onElicitationRequest.mock.calls[0]?.[0]).toEqual({
      mode: 'form',
      sessionId: 'omp-session-new',
      message: 'Which library should we use?',
      requestedSchema,
      toolCallId: 'call-1',
      _meta: { codex: { autoResolutionMs: null } },
    })
    expect(onElicitationRequest.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal)
  })

  it('leaves out the tool call and the meta the vendor did not give', async () => {
    const onElicitationRequest = asking({ action: 'decline' })
    const harness = build({}, { onElicitationRequest })
    await duringTurn(harness, (transport) => transport.requestElicitation({ ...form, toolCallId: undefined }))
    expect(Object.keys(onElicitationRequest.mock.calls[0]?.[0] ?? {}).sort()).toEqual([
      'message',
      'mode',
      'requestedSchema',
      'sessionId',
    ])
  })

  it('passes accept, decline and cancel through and cancels anything it cannot trust', async () => {
    const accepted: acp.CreateElicitationResponse = { action: 'accept', content: { question_0: 'Vue' } }
    const cases: [acp.CreateElicitationResponse | Error, unknown][] = [
      [accepted, accepted],
      [{ action: 'decline' }, { action: 'decline' }],
      [{ action: 'cancel' }, abandoned],
      [{ action: '_future' }, abandoned],
      [new Error('question service down'), abandoned],
    ]
    for (const [response, expected] of cases) {
      const harness = build({}, { onElicitationRequest: asking(response) })
      const answer = await duringTurn(harness, async (transport) => {
        const settled = await transport.requestElicitation(form)
        // A settled form releases steering again, whatever it ended with.
        expect(harness.runtime.canSteer).toBe(true)
        return settled
      })
      expect(answer).toEqual(expected)
    }
  })

  it('cancels outside a turn and from a transport that is no longer the current one', async () => {
    const onElicitationRequest = asking({ action: 'accept', content: { question_0: 'Vue' } })
    const harness = build({}, { onElicitationRequest })
    await harness.runtime.start()
    const retired = first(harness)
    expect(await retired.requestElicitation(form)).toEqual(abandoned)
    await harness.runtime.close()
    await harness.runtime.start()
    const turn = openTurn(harness.transports[1]!)
    const prompting = harness.runtime.prompt(text('work'), () => undefined)
    await turn.started
    expect(await retired.requestElicitation(form)).toEqual(abandoned)
    turn.finish()
    await prompting
    expect(onElicitationRequest).not.toHaveBeenCalled()
  })

  it('cancels a pending form with the host call when the turn is stopped', async () => {
    const onElicitationRequest = asking('hang')
    const harness = build({}, { onElicitationRequest })
    await harness.runtime.start()
    const transport = first(harness)
    transport.promptScript = async (context) => {
      const response = await transport.requestElicitation(form)
      context.update(messageChunk(JSON.stringify(response)))
      return { stopReason: 'end_turn' }
    }
    const stop = new AbortController()
    const heard: AcpSessionNotification[] = []
    const prompting = harness.runtime.prompt(text('work'), (notification) => heard.push(notification), stop.signal)
    await vi.waitFor(() => expect(onElicitationRequest).toHaveBeenCalledTimes(1))
    const hostSignal = onElicitationRequest.mock.calls[0]?.[1]
    expect(hostSignal?.aborted).toBe(false)
    stop.abort()
    await prompting
    expect(hostSignal?.aborted).toBe(true)
    expect(heard[0]?.update).toEqual(messageChunk('{"action":"cancel"}'))
    expect(harness.runtime.canSteer).toBe(false)
  })

  it('abandons a pending form when the vendor withdraws it', async () => {
    const onElicitationRequest = asking('hang')
    const harness = build({}, { onElicitationRequest })
    const withdrawn = new AbortController()
    const response = await duringTurn(harness, async (transport) => {
      const pending = transport.requestElicitation(form, withdrawn.signal)
      await vi.waitFor(() => expect(onElicitationRequest).toHaveBeenCalledTimes(1))
      withdrawn.abort()
      return await pending
    })
    expect(response).toEqual(abandoned)
    expect(onElicitationRequest.mock.calls[0]?.[1]?.aborted).toBe(true)
  })

  it('offers the transport a form handler only when the host has a question surface', async () => {
    const bare = build()
    await bare.runtime.start()
    expect(Object.hasOwn(first(bare).startOptions ?? {}, 'onElicitation')).toBe(false)
    expect(first(bare).startOptions?.onElicitation).toBeUndefined()
    const hosted = build({}, { onElicitationRequest: asking({ action: 'cancel' }) })
    await hosted.runtime.start()
    expect(first(hosted).startOptions?.onElicitation).toBeTypeOf('function')
  })

  it('cannot steer while a form waits for the user', async () => {
    const answer = Promise.withResolvers<acp.CreateElicitationResponse>()
    const onElicitationRequest = vi.fn(
      async (_params: acp.CreateElicitationRequest, _signal?: AbortSignal) => await answer.promise,
    )
    const harness = build({}, { onElicitationRequest })
    await duringTurn(harness, async (transport) => {
      expect(harness.runtime.canSteer).toBe(true)
      const pending = transport.requestElicitation(form)
      await vi.waitFor(() => expect(onElicitationRequest).toHaveBeenCalledTimes(1))
      expect(harness.runtime.canSteer).toBe(false)
      expect(await harness.runtime.steer(text('meanwhile'))).toBe('promptRequired')
      expect(transport.steers).toEqual([])
      answer.resolve({ action: 'decline' })
      expect(await pending).toEqual({ action: 'decline' })
      expect(harness.runtime.canSteer).toBe(true)
    })
  })
})

describe('native launch argv', () => {
  const placeholder = {
    node: '/Users/test/.local/dsh/lib/node_modules/node/bin/node',
    plugin: '/Users/test/dsh-agent-dag',
  }

  it('maps the Claude Code profile onto its launcher', () => {
    const source = {
      command: placeholder.node,
      args: [`${placeholder.plugin}/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js`],
      env: {
        ANTHROPIC_BASE_URL: 'https://gateway.example.test',
        ANTHROPIC_AUTH_TOKEN: 'placeholder',
        PATH: '/usr/bin:/bin',
        CLAUDE_CODE_EXECUTABLE: `${placeholder.plugin}/claude-launch.mjs`,
        DSH_CLAUDE_EXECUTABLE: '/Users/test/.local/bin/claude',
        DSH_ACP_LINK_HEADERS: '{"x-link":"1"}',
      },
    }
    expect(nativeLaunchArgv('claude', source)).toEqual([`${placeholder.plugin}/claude-launch.mjs`])
    const { CLAUDE_CODE_EXECUTABLE: _launcher, ...withoutLauncher } = source.env
    expect(nativeLaunchArgv('claude', { ...source, env: withoutLauncher })).toEqual(['/Users/test/.local/bin/claude'])
    const { DSH_CLAUDE_EXECUTABLE: _executable, ...bare } = withoutLauncher
    expect(nativeLaunchArgv('claude', { ...source, env: bare })).toEqual(['claude'])
    expect(nativeLaunchArgv('claude', { command: '/opt/claude/bin/claude', args: [], env: {} })).toEqual([
      '/opt/claude/bin/claude',
    ])
  })

  it('maps the Codex profile onto its launcher or the command the launcher would run', () => {
    const command = JSON.stringify(['codex', '-c', 'model_provider="codex-tr"'])
    const source = {
      command: placeholder.node,
      args: [`${placeholder.plugin}/node_modules/@agentclientprotocol/codex-acp/dist/index.js`],
      env: {
        OPENAI_API_KEY: 'placeholder',
        PATH: '/usr/bin:/bin',
        MODEL_PROVIDER: 'codex-tr',
        CODEX_PATH: `${placeholder.plugin}/codex-launch.mjs`,
        DSH_CODEX_COMMAND: command,
      },
    }
    expect(nativeLaunchArgv('codex', source)).toEqual([`${placeholder.plugin}/codex-launch.mjs`])
    const { CODEX_PATH: _launcher, ...withoutLauncher } = source.env
    expect(nativeLaunchArgv('codex', { ...source, env: withoutLauncher })).toEqual([
      'codex',
      '-c',
      'model_provider="codex-tr"',
    ])
    expect(nativeLaunchArgv('codex', { ...source, env: { DSH_CODEX_COMMAND: '/opt/codex/bin/codex' } })).toEqual([
      '/opt/codex/bin/codex',
    ])
    expect(nativeLaunchArgv('codex', { ...source, env: {} })).toEqual(['codex'])
    expect(nativeLaunchArgv('codex', { command: '/opt/codex/bin/codex', args: [], env: {} })).toEqual([
      '/opt/codex/bin/codex',
    ])
  })

  it('maps the Oh My Pi profile onto its CLI without the ACP subcommand', () => {
    const source = {
      command: '/Users/test/.bun/bin/omp',
      args: ['acp', '-e', `${placeholder.plugin}/omp-link-headers.js`],
      env: { PI_CODING_AGENT_DIR: '/Users/test/.omp/agent', TOKENROUTER_API_KEY: 'placeholder' },
    }
    expect(nativeLaunchArgv('omp', source)).toEqual([
      '/Users/test/.bun/bin/omp',
      '-e',
      `${placeholder.plugin}/omp-link-headers.js`,
    ])
    expect(nativeLaunchArgv('omp', { ...source, args: ['-e', 'ext.js', 'acp'] })).toEqual([
      '/Users/test/.bun/bin/omp',
      '-e',
      'ext.js',
    ])
    expect(nativeLaunchArgv('omp', { ...source, args: ['-e', 'ext.js'] })).toEqual([
      '/Users/test/.bun/bin/omp',
      '-e',
      'ext.js',
    ])
  })

  it('prepares the launch through the host and releases a lease the host prepared anyway', async () => {
    const close = vi.fn(async () => undefined)
    const launch = await prepareNativeLaunch({
      kind: 'omp',
      config: { command: 'omp', args: ['acp'], env: {} },
      cwd: '/work/project',
      prepareLaunch: async () => ({
        argv: ['/Users/test/.bun/bin/omp', 'acp', '-e', 'ext.js'],
        env: { DSH_ACP_LINK_HEADERS: '{}' },
        spawnPlan: { argv: [], env: {} },
        mcpLease: { close } as never,
      }),
    })
    expect(launch).toEqual({ argv: ['/Users/test/.bun/bin/omp', '-e', 'ext.js'], env: { DSH_ACP_LINK_HEADERS: '{}' } })
    expect(close).toHaveBeenCalledTimes(1)
    await expect(
      prepareNativeLaunch({
        kind: 'omp',
        config: { command: 'omp', args: [], env: {} },
        cwd: '/work',
        prepareLaunch: async () => ({ argv: [], env: {}, spawnPlan: { argv: [], env: {} } }),
      }),
    ).rejects.toThrow('has no command')
  })
})

describe('NativeSessionRuntime commands, side channel and session changes', () => {
  const ok = (value: string): NativeCommandResult => ({ kind: 'success', text: value })
  const review: NativeCommand = { name: 'review', description: 'Review the changes', dispatch: 'prompt' }

  async function started(init: FakeTransportInit = {}, overrides: Partial<NativeSessionRuntimeOptions> = {}) {
    const harness = build(init, overrides)
    await harness.runtime.start()
    return { harness, transport: first(harness) }
  }

  /** A transport call that never ends on its own, whatever it is told; `given()` is the signal it was handed. */
  function neverEnds(): { readonly call: (...args: unknown[]) => Promise<never>; given(): AbortSignal | undefined } {
    let given: AbortSignal | undefined
    return {
      call: (...args) => {
        given = args.at(-1) as AbortSignal
        return new Promise<never>(() => undefined)
      },
      given: () => given,
    }
  }

  describe('the command catalog', () => {
    it('lists the built-ins of its kind until the agent runs, then what the transport reports', async () => {
      const { harness, transport } = await started({ kind: 'claude' })
      expect(harness.runtime.commands()).toBe(staticNativeCommands('claude'))
      const catalog = [review]
      transport.commands = () => catalog
      expect(harness.runtime.commands()).toBe(catalog)
    })

    it('tells the host when the vendor announces a catalog, also while the agent is still starting', async () => {
      const changed = vi.fn()
      const harness = build({}, { onCommandsChanged: changed }, (transport) => {
        transport.beforeStart = async () => {
          transport.emit({ kind: 'commands', commands: [review] })
        }
      })
      await harness.runtime.start()
      expect(changed).toHaveBeenCalledExactlyOnceWith([review])
      // A transport without a list of its own is read through what it announced; a closed agent announced nothing.
      expect(harness.runtime.commands()).toEqual([review])
      await harness.runtime.close()
      expect(harness.runtime.commands()).toBe(staticNativeCommands('omp'))
    })
  })

  describe('side questions and immediate commands', () => {
    it('answer while a prompt runs and take nothing from the turn', async () => {
      const { harness, transport } = await started()
      transport.sideQuestion = async (question) => ok(`re: ${question}`)
      const turn = openTurn(transport)
      const updates: string[] = []
      const prompting = harness.runtime.prompt(text('work'), (notification) =>
        updates.push(notification.update.sessionUpdate),
      )
      await turn.started

      expect(await harness.runtime.sideQuestion('why?')).toEqual(ok('re: why?'))

      // The turn still holds the prompt slot and can still be steered; the side call announced nothing to it.
      expect(harness.runtime.isBusy).toBe(true)
      expect(harness.runtime.canSteer).toBe(true)
      await expect(harness.runtime.prompt(text('again'), () => undefined)).rejects.toThrow('ACP_PROMPT_ALREADY_ACTIVE')
      expect(await harness.runtime.steer(text('more'))).toBe('injected')
      turn.finish()
      await expect(prompting).resolves.toMatchObject({ stopReason: 'end_turn' })
      expect(updates).toEqual([])
      expect(harness.notifications).toEqual([])
    })

    it('never claim the prompt slot: a turn can start and end while one is open', async () => {
      const { harness, transport } = await started()
      const held = Promise.withResolvers<NativeCommandResult>()
      transport.runCommand = vi.fn(async () => await held.promise)
      const running = harness.runtime.runCommand('status', 'verbose')
      expect(transport.runCommand).toHaveBeenCalledWith('status', 'verbose', expect.any(AbortSignal))
      expect(harness.runtime.isBusy).toBe(false)

      await expect(harness.runtime.prompt(text('meanwhile'), () => undefined)).resolves.toMatchObject({
        stopReason: 'end_turn',
      })
      held.resolve(ok('status text'))
      await expect(running).resolves.toEqual(ok('status text'))
    })

    it('answer with an error result for every way the call cannot be made', async () => {
      // No agent session yet: the transport is not even started on its behalf.
      const cold = build()
      const asked = await cold.runtime.sideQuestion('anyone there?')
      expect(asked).toMatchObject({ kind: 'error', text: expect.stringMatching(/send a message first/i) })
      expect(first(cold).calls).toEqual([])

      // The transport does not offer the method.
      const plain = await started()
      expect(await plain.harness.runtime.sideQuestion('q')).toMatchObject({
        kind: 'error',
        text: expect.stringContaining('omp'),
      })
      expect(await plain.harness.runtime.runCommand('status', '')).toMatchObject({ kind: 'error' })

      // The process behind the session is gone: the call is not made.
      const gone = await started()
      gone.transport.sideQuestion = vi.fn(async () => ok('too late'))
      gone.transport.closed = true
      expect(await gone.harness.runtime.sideQuestion('q')).toMatchObject({ kind: 'error' })
      expect(gone.transport.sideQuestion).not.toHaveBeenCalled()

      // The transport fails, or answers with something that is no result.
      const failing = await started()
      failing.transport.sideQuestion = async () => {
        throw new Error('the agent process was lost')
      }
      expect(await failing.harness.runtime.sideQuestion('q')).toEqual({
        kind: 'error',
        text: 'the agent process was lost',
      })
      failing.transport.sideQuestion = async () => ({ text: 'no kind' }) as unknown as NativeCommandResult
      expect(await failing.harness.runtime.sideQuestion('q')).toMatchObject({ kind: 'error' })
    })

    it('end with the caller signal even when the transport ignores it', async () => {
      const { harness, transport } = await started()
      const stuck = neverEnds()
      transport.sideQuestion = stuck.call
      const controller = new AbortController()
      const asked = harness.runtime.sideQuestion('q', controller.signal)
      controller.abort()
      await expect(asked).resolves.toMatchObject({ kind: 'error', text: expect.stringMatching(/cancel/i) })
      expect(stuck.given()?.aborted).toBe(true)
    })

    it('end at their time limit and tell the transport to stop', async () => {
      const { harness, transport } = await started({}, { sideCallTimeoutMs: 20 })
      const stuck = neverEnds()
      transport.runCommand = stuck.call
      await expect(harness.runtime.runCommand('mcp', '')).resolves.toMatchObject({
        kind: 'error',
        text: expect.stringContaining('did not answer'),
      })
      expect(stuck.given()?.aborted).toBe(true)
    })

    it('end when the runtime closes', async () => {
      const { harness, transport } = await started()
      const stuck = neverEnds()
      transport.sideQuestion = stuck.call
      const asked = harness.runtime.sideQuestion('q')
      await harness.runtime.close()
      await expect(asked).resolves.toMatchObject({ kind: 'error', text: expect.stringMatching(/ended/i) })
      expect(stuck.given()?.aborted).toBe(true)
    })
  })

  describe('a conversation the vendor replaced', () => {
    it('is followed: the runtime answers to the new session and the host is told', async () => {
      const changed = vi.fn()
      const { harness, transport } = await started({}, { onSessionChanged: changed })
      const attachedBefore = harness.runtime.acpSessionId

      transport.replaceSession('omp-session-2', 'clear')
      expect(attachedBefore).toBe('omp-session-new')
      expect(harness.runtime.acpSessionId).toBe('omp-session-2')
      expect(changed).toHaveBeenCalledExactlyOnceWith('omp-session-2', 'clear')
      // What the agent reports from then on is addressed to the session it is in, and the binding names it.
      transport.emit({ kind: 'update', update: messageChunk('hello') })
      expect(harness.notifications.at(-1)?.sessionId).toBe('omp-session-2')
      expect(await harness.runtime.restore({ agentSessionId: 'omp-session-2' })).toBe('reused')
      // Hearing the id it already holds again is no change.
      transport.replaceSession('omp-session-2', 'clear')
      expect(changed).toHaveBeenCalledTimes(1)
    })

    it('is followed in the middle of a turn without disturbing it', async () => {
      const changed = vi.fn()
      const { harness, transport } = await started({}, { onSessionChanged: changed })
      transport.promptScript = async (context) => {
        context.update(messageChunk('before'))
        transport.replaceSession('omp-session-2', 'clear')
        context.update(messageChunk('after'))
        return { stopReason: 'end_turn' }
      }
      const seen: string[] = []
      await harness.runtime.prompt(text('/clear'), (notification) => seen.push(notification.sessionId))
      expect(seen).toEqual(['omp-session-new', 'omp-session-2'])
      expect(changed).toHaveBeenCalledExactlyOnceWith('omp-session-2', 'clear')
      expect(harness.runtime.acpSessionId).toBe('omp-session-2')
    })

    it('is followed when a rewind rolls it back where it stood, however often it names the session it holds', async () => {
      const changed = vi.fn()
      const { harness, transport } = await started({}, { onSessionChanged: changed })

      transport.replaceSession('omp-session-new', 'rewind')
      transport.replaceSession('omp-session-new', 'rewind')

      // Every rewind is a change of its own: the agent forgot more each time.
      expect(changed.mock.calls).toEqual([
        ['omp-session-new', 'rewind'],
        ['omp-session-new', 'rewind'],
      ])
      // The agent is still in the session it was in: what it reports is addressed to it, and the binding names it.
      expect(harness.runtime.acpSessionId).toBe('omp-session-new')
      transport.emit({ kind: 'update', update: messageChunk('hello') })
      expect(harness.notifications.at(-1)?.sessionId).toBe('omp-session-new')
    })

    it.each(['clear', 'new', 'plan_mode_exit'])(
      'takes the session it holds, named again with the reason %s, for a repeat and not for a change',
      async (reason) => {
        const changed = vi.fn()
        const { transport } = await started({}, { onSessionChanged: changed })
        transport.replaceSession('omp-session-new', reason)
        expect(changed).not.toHaveBeenCalled()
      },
    )

    it('is not announced by a resume that reports its own session while it attaches', async () => {
      const changed = vi.fn()
      const harness = build({}, { onSessionChanged: changed }, (transport) => {
        transport.beforeStart = async () => {
          transport.emit({ kind: 'session_changed', sessionId: 'someone-else', reason: 'startup' })
        }
      })
      await harness.runtime.restore({ agentSessionId: 'vendor-1' })
      expect(harness.runtime.acpSessionId).toBe('vendor-1')
      expect(changed).not.toHaveBeenCalled()
    })
  })
})
