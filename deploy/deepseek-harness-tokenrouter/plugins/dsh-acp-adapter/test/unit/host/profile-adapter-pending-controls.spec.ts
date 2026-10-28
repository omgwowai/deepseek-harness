/**
 * A mode or option changed while a turn runs stays pending in the sidecar and is applied before the next prompt.
 *
 * The Agent fake refuses every control write while a prompt is in flight, as the real ACP and native runtimes do
 * (`ACP_CONFIG_CHANGE_DURING_PROMPT`), so a change that reached it mid-turn would fail these specs.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type * as acp from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import { AcpProfileAdapter, type AcpProfileRuntime } from '../../../src/host/composition/profile-adapter.ts'
import type { AcpAgentConfig } from '../../../src/domain/session/agent-config.ts'
import { createAcpSidecar, modeIntentBindingKey, type AcpSidecar } from '../../../src/persistence/sidecar.ts'
import { withSessionFacts } from '../../support/session-facts.ts'

const SESSION = 'pending-controls'
const profile = (): AcpAgentConfig => ({
  name: 'Pending controls fixture',
  command: 'unused-fixture-agent',
  args: [],
  env: {},
})

const roots: string[] = []
const sidecars: AcpSidecar[] = []
const adapters: AcpProfileAdapter[] = []
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.close().catch(() => undefined)
  for (const sidecar of sidecars.splice(0)) await sidecar.dispose().catch(() => undefined)
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

const select = (
  id: string,
  name: string,
  category: string,
  currentValue: string,
  values: readonly string[],
): acp.SessionConfigOption => ({
  id,
  name,
  category,
  type: 'select',
  currentValue,
  options: values.map((value) => ({ value, name: value })),
})

const MODES = [
  { id: 'code', name: 'Code' },
  { id: 'plan', name: 'Plan' },
  { id: 'review', name: 'Review' },
]

/** `legacy` advertises its modes through `session/set_mode`, `config` through a `mode` config option. */
type ModeStyle = 'legacy' | 'config'

/** An Agent with a mode, Codex's collaboration mode, Claude's fast mode, a toggle, a model and an effort. */
class FakeAgent {
  readonly calls: string[] = []
  busy = false
  modeId = 'code'
  options: acp.SessionConfigOption[]
  /** `id=value` writes the Agent refuses. */
  readonly refused = new Set<string>()
  /** `id=value` writes the Agent accepts without applying them. */
  readonly ignored = new Set<string>()
  /** Runs before a control write is applied; lets a spec hold a write open. */
  beforeSet: ((id: string, value: string | boolean) => Promise<void>) | undefined
  private setupGate: PromiseWithResolvers<void> | undefined
  private setupEntered: PromiseWithResolvers<void> | undefined
  /** Whether the Agent takes input while it works, and what it answers when asked to. */
  steerable = false
  steerOutcome: 'injected' | 'promptRequired' = 'promptRequired'
  private gate: PromiseWithResolvers<void> | undefined
  private entered: PromiseWithResolvers<void> | undefined

  constructor(readonly style: ModeStyle) {
    const modeOption = select(
      'mode',
      'Mode',
      'mode',
      'code',
      MODES.map((mode) => mode.id),
    )
    this.options = [
      ...(style === 'config' ? [modeOption] : []),
      select('collaboration_mode', 'Collaboration mode', 'collaboration_mode', 'default', ['default', 'plan']),
      select('fast-mode', 'Fast mode', 'model_config', 'off', ['off', 'on']),
      select('verbosity', 'Verbosity', 'behavior', 'normal', ['quiet', 'normal', 'verbose']),
      { id: 'auto_compact', name: 'Auto compact', type: 'boolean', category: 'behavior', currentValue: true },
      select('model', 'Model', 'model', 'model-a', ['model-a', 'model-b']),
      select('effort', 'Effort', 'thought_level', 'low', ['low', 'high']),
    ]
  }

  /** Keep the next prompt in flight until `release`. */
  hold(): { readonly entered: Promise<void>; release(): void } {
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    this.gate = gate
    this.entered = entered
    return { entered: entered.promise, release: () => gate.resolve() }
  }

  /** Hold the next `start`/`restore` open: the turn's stream is registered, its prompt is not prepared yet. */
  holdSetup(): { readonly entered: Promise<void>; release(): void } {
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    this.setupGate = gate
    this.setupEntered = entered
    return { entered: entered.promise, release: () => gate.resolve() }
  }

  private async setup(): Promise<void> {
    const gate = this.setupGate
    this.setupGate = undefined
    if (gate === undefined) return
    this.setupEntered?.resolve()
    await gate.promise
  }

  /** The Agent drops an option, or narrows its values, as a model switch can. */
  offer(id: string, values: readonly string[] | undefined): void {
    this.options = this.options.flatMap((option) => {
      if (option.id !== id) return [option]
      if (values === undefined || option.type !== 'select') return []
      return [{ ...option, options: values.map((value) => ({ value, name: value })) }]
    })
  }

  runtime(): AcpProfileRuntime {
    const agent = this
    return {
      acpSessionId: 'agent-session-1',
      agentInfo: { name: 'fake-agent', version: '1' },
      protocolVersion: 1,
      agentCapabilities: { sessionCapabilities: { resume: {} } },
      get configOptions() {
        return agent.options
      },
      get modes() {
        return agent.style === 'legacy' ? { currentModeId: agent.modeId, availableModes: MODES } : undefined
      },
      get currentModeId() {
        return agent.style === 'legacy' ? agent.modeId : undefined
      },
      get isBusy() {
        return agent.busy
      },
      get canSteer() {
        return agent.steerable
      },
      steer: async (_content, onDispatch) => {
        onDispatch?.()
        agent.calls.push('steer')
        return agent.steerOutcome
      },
      start: async () => {
        agent.calls.push('start')
        await agent.setup()
      },
      restore: async () => {
        agent.calls.push('restore')
        await agent.setup()
        return 'resumed'
      },
      setMode: async (modeId) => {
        if (agent.busy) throw new Error('ACP_CONFIG_CHANGE_DURING_PROMPT')
        agent.calls.push(`mode:${modeId}`)
        agent.modeId = modeId
      },
      setConfigOption: async (id, value) => {
        if (agent.busy) throw new Error('ACP_CONFIG_CHANGE_DURING_PROMPT')
        agent.calls.push(`set:${id}=${String(value)}`)
        await agent.beforeSet?.(id, value)
        const write = `${id}=${String(value)}`
        if (agent.refused.has(write)) throw new Error('the Agent refused the change')
        if (agent.ignored.has(write)) return
        agent.options = agent.options.map((option) =>
          option.id === id ? ({ ...option, currentValue: value } as acp.SessionConfigOption) : option,
        )
        if (id === 'mode') agent.modeId = String(value)
      },
      prompt: async (_content, onUpdate, signal) => {
        agent.calls.push('prompt')
        agent.busy = true
        try {
          onUpdate({
            sessionId: 'agent-session-1',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
          } as never)
          const gate = agent.gate
          agent.gate = undefined
          agent.entered?.resolve()
          if (gate === undefined) return { stopReason: 'end_turn' } as acp.PromptResponse
          const cancelled = Promise.withResolvers<'cancelled'>()
          signal?.addEventListener('abort', () => cancelled.resolve('cancelled'), { once: true })
          const outcome = await Promise.race([gate.promise.then(() => 'end_turn' as const), cancelled.promise])
          return { stopReason: outcome } as acp.PromptResponse
        } finally {
          agent.busy = false
        }
      },
      close: async () => {
        agent.calls.push('close')
      },
    }
  }
}

type SessionEvent = { type: string; seq: number; data: unknown }

/**
 * One DSH session whose event log grows by a user step per message. `say` leaves the turn out of it; `acceptTurn`,
 * `claim` and `endTurn` follow DSH instead: it accepts a prompt (the Agent turns running and the turn opens), the loop
 * then claims the input, the request reaches the adapter's stream, and the turn ends.
 */
class Conversation {
  readonly events: SessionEvent[] = []
  readonly view
  steerInput: () => void = () => undefined
  private turns = 0
  private readonly turnEndListeners = new Set<() => void>()

  constructor() {
    this.view = Object.assign(
      withSessionFacts({
        id: SESSION,
        header: { cwd: os.tmpdir() },
        inheritedEventCount: 0,
        events: this.events,
        snapshotEvents: () => [...this.events],
      }),
      {
        watchSteering: (listener: () => void) => {
          this.steerInput = listener
          return () => undefined
        },
        watchTurnEnd: (listener: () => void) => {
          this.turnEndListeners.add(listener)
          return () => void this.turnEndListeners.delete(listener)
        },
        watchRouteChange: () => () => undefined,
      },
    )
  }

  say(text: string): UserMessage {
    this.turns += 1
    const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    const base = this.events.length
    this.events.push(
      { type: 'step/start', seq: base + 1, data: { turn: this.turns, step: 0 } },
      { type: 'user/message', seq: base + 2, data: message },
    )
    return message
  }

  /** DSH accepts a prompt: `turn/start` is committed ahead of any step, message or request. */
  acceptTurn(): void {
    this.turns += 1
    this.events.push({ type: 'turn/start', seq: this.events.length + 1, data: { turn: this.turns } })
  }

  /** The loop claims the input of the open turn: its step starts and the message is committed. */
  claim(text: string): UserMessage {
    const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    const base = this.events.length
    this.events.push(
      { type: 'step/start', seq: base + 1, data: { turn: this.turns, step: 0 } },
      { type: 'user/message', seq: base + 2, data: message },
    )
    return message
  }

  /** The turn ends, whatever became of it. */
  endTurn(): void {
    this.events.push({
      type: 'turn/end',
      seq: this.events.length + 1,
      data: { turn: this.turns, reason: { kind: 'completed' } },
    })
    for (const listener of [...this.turnEndListeners]) listener()
  }

  /** Close the step that was running and open the next one with a message sent meanwhile. */
  sayDuringTurn(text: string): UserMessage {
    const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    const base = this.events.length
    this.events.push(
      { type: 'step/end', seq: base + 1, data: { turn: this.turns, step: 0 } },
      { type: 'step/start', seq: base + 2, data: { turn: this.turns, step: 1 } },
      { type: 'user/message', seq: base + 3, data: message },
    )
    return message
  }
}

const request = (message: UserMessage, extra: readonly UserMessage[] = []) =>
  markAgentLoopRequest({
    provider: 'acp-test',
    model: 'model-a',
    sessionId: SESSION as never,
    messages: [...extra, message],
  })

async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

class World {
  readonly agent: FakeAgent
  readonly conversation = new Conversation()
  readonly logs: string[] = []
  sidecar: AcpSidecar
  readonly root: string

  constructor(style: ModeStyle) {
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-acp-pending-controls-'))
    roots.push(this.root)
    this.sidecar = this.open()
    this.agent = new FakeAgent(style)
  }

  open(): AcpSidecar {
    const sidecar = createAcpSidecar({ root: this.root })
    sidecars.push(sidecar)
    return sidecar
  }

  /** An adapter over the current sidecar; a second one models a restart of the plugin host. */
  adapter(): AcpProfileAdapter {
    const sidecar = this.sidecar
    const adapter = new AcpProfileAdapter(
      'test',
      profile,
      { ok: true, seam: undefined as never },
      () => this.conversation.view,
      {
        begin: (record) => sidecar.beginDispatch(record as never),
        settle: (id, key) => sidecar.settleDispatch(id as never, key),
        read: (id, key) => sidecar.readDispatch(id as never, key),
      },
      undefined,
      () => this.agent.runtime(),
      sidecar,
      undefined,
      undefined,
      undefined,
      (message) => this.logs.push(message),
    )
    adapters.push(adapter)
    return adapter
  }

  /** Send a message and let its turn finish. */
  async say(adapter: AcpProfileAdapter, text: string): Promise<StreamChunk[]> {
    return await collect(adapter.stream(request(this.conversation.say(text))))
  }

  /** Send a message and return once the Agent is working on it; the turn ends at `release`. */
  async startTurn(adapter: AcpProfileAdapter, text: string) {
    const hold = this.agent.hold()
    const done = collect(adapter.stream(request(this.conversation.say(text))))
    await hold.entered
    return { done, release: hold.release }
  }

  /**
   * Send a message and return once its stream is registered with the adapter but its prompt is not prepared: DSH
   * shows the turn as running, yet the pre-prompt step has not read the pending choices. `release` goes on.
   */
  async startPreparing(adapter: AcpProfileAdapter, text: string) {
    const hold = this.agent.holdSetup()
    const done = collect(adapter.stream(request(this.conversation.say(text))))
    await hold.entered
    return { done, release: hold.release }
  }

  async bindingKey(): Promise<string> {
    const lookup = await this.sidecar.readLatestBinding(SESSION as never)
    if (lookup?.status !== 'ok') throw new Error('the session has no binding')
    return modeIntentBindingKey(lookup.binding)
  }

  async pendingOptions(): Promise<Record<string, string | boolean>> {
    return Object.fromEntries(
      (await this.sidecar.listOptionIntents(SESSION as never)).map((intent) => [intent.optionId, intent.value]),
    )
  }
}

const finish = (chunks: readonly StreamChunk[]) => chunks.at(-1)

const modeWrite = (style: ModeStyle, id: string) =>
  style === 'legacy' ? ({ kind: 'mode', id } as const) : ({ kind: 'config', id: 'mode', value: id } as const)
const modeCall = (style: ModeStyle, id: string) => (style === 'legacy' ? `mode:${id}` : `set:mode=${id}`)

describe('controls changed while a turn runs', () => {
  describe.each(['legacy', 'config'] as const)('mode (%s)', (style) => {
    it('stays pending, reaches the Agent before the next prompt, and is cleared', async () => {
      const world = new World(style)
      const adapter = world.adapter()
      const turn = await world.startTurn(adapter, 'first')
      expect(world.agent.busy).toBe(true)

      const pending = await adapter.setAgentSessionOption(SESSION, modeWrite(style, 'plan'))
      expect(pending).toMatchObject({ freshness: 'live', editable: false, pendingModeId: 'plan', pendingOptions: {} })
      // The Agent still reports the mode it has; nothing was written to it during the turn.
      expect(pending.configOptions?.find((option) => option.id === 'mode')?.currentValue ?? pending.currentModeId).toBe(
        'code',
      )
      expect(world.agent.calls).toEqual(['start', 'prompt'])
      expect(await world.sidecar.readModeIntent(SESSION as never)).toEqual({
        bindingKey: await world.bindingKey(),
        modeId: 'plan',
      })

      turn.release()
      expect(finish(await turn.done)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      // The turn is over, yet the choice is still waiting for the next one.
      expect(await adapter.agentSessionSnapshot(SESSION)).toMatchObject({ editable: true, pendingModeId: 'plan' })
      expect(world.agent.calls).toEqual(['start', 'prompt'])

      expect(finish(await world.say(adapter, 'second'))).toMatchObject({ reason: { kind: 'stop' } })
      expect(world.agent.calls).toEqual(['start', 'prompt', 'restore', modeCall(style, 'plan'), 'prompt'])
      expect(await world.sidecar.readModeIntent(SESSION as never)).toBeUndefined()
      expect(await adapter.agentSessionSnapshot(SESSION)).toMatchObject({ pendingModeId: null, pendingOptions: {} })
    })

    it('is cancelled by choosing the mode the Agent has', async () => {
      const world = new World(style)
      const adapter = world.adapter()
      const turn = await world.startTurn(adapter, 'first')
      await adapter.setAgentSessionOption(SESSION, modeWrite(style, 'plan'))
      expect(await world.sidecar.readModeIntent(SESSION as never)).toMatchObject({ modeId: 'plan' })

      const cancelled = await adapter.setAgentSessionOption(SESSION, modeWrite(style, 'code'))
      expect(cancelled.pendingModeId).toBeNull()
      expect(await world.sidecar.readModeIntent(SESSION as never)).toBeUndefined()
      // Choosing the current mode with nothing pending writes nothing and saves nothing.
      expect((await adapter.setAgentSessionOption(SESSION, modeWrite(style, 'code'))).pendingModeId).toBeNull()

      turn.release()
      await turn.done
      await world.say(adapter, 'second')
      expect(world.agent.calls).toEqual(['start', 'prompt', 'restore', 'prompt'])
    })

    it('keeps the last choice when the user changes their mind', async () => {
      const world = new World(style)
      const adapter = world.adapter()
      const turn = await world.startTurn(adapter, 'first')
      await adapter.setAgentSessionOption(SESSION, modeWrite(style, 'plan'))
      expect((await adapter.setAgentSessionOption(SESSION, modeWrite(style, 'review'))).pendingModeId).toBe('review')
      turn.release()
      await turn.done
      await world.say(adapter, 'second')
      expect(world.agent.calls.slice(-3)).toEqual(['restore', modeCall(style, 'review'), 'prompt'])
    })

    it('is superseded by an immediate change once the turn is over', async () => {
      const world = new World(style)
      const adapter = world.adapter()
      const turn = await world.startTurn(adapter, 'first')
      await adapter.setAgentSessionOption(SESSION, modeWrite(style, 'plan'))
      turn.release()
      await turn.done

      await adapter.setAgentSessionOption(SESSION, modeWrite(style, 'review'))
      expect(world.agent.calls.slice(-1)).toEqual([modeCall(style, 'review')])
      expect(await world.sidecar.readModeIntent(SESSION as never)).toBeUndefined()
      await world.say(adapter, 'second')
      expect(world.agent.calls.slice(-2)).toEqual(['restore', 'prompt'])
    })
  })

  describe('other options', () => {
    it('stay pending, reach the Agent in a fixed order before the next prompt, and are cleared', async () => {
      const world = new World('config')
      const adapter = world.adapter()
      const turn = await world.startTurn(adapter, 'first')

      // Written in an order that differs from the order they are applied in.
      await adapter.setAgentSessionOption(SESSION, { kind: 'config', id: 'fast-mode', value: 'on' })
      await adapter.setAgentSessionOption(SESSION, { kind: 'config', id: 'collaboration_mode', value: 'plan' })
      const pending = await adapter.setAgentSessionOption(SESSION, { kind: 'config', id: 'auto_compact', value: false })
      expect(pending).toMatchObject({
        pendingModeId: null,
        pendingOptions: { 'fast-mode': 'on', collaboration_mode: 'plan', auto_compact: false },
      })
      expect(world.agent.calls).toEqual(['start', 'prompt'])
      expect(await world.pendingOptions()).toEqual({
        'fast-mode': 'on',
        collaboration_mode: 'plan',
        auto_compact: false,
      })

      turn.release()
      await turn.done
      expect(world.agent.calls).toEqual(['start', 'prompt'])
      await world.say(adapter, 'second')
      expect(world.agent.calls.slice(2)).toEqual([
        'restore',
        'set:auto_compact=false',
        'set:collaboration_mode=plan',
        'set:fast-mode=on',
        'prompt',
      ])
      expect(await world.pendingOptions()).toEqual({})
      const settled = await adapter.agentSessionSnapshot(SESSION)
      expect(settled.pendingOptions).toEqual({})
      expect(settled.configOptions?.find((option) => option.id === 'collaboration_mode')?.currentValue).toBe('plan')
    })

    it('apply after the mode', async () => {
      const world = new World('config')
      const adapter = world.adapter()
      const turn = await world.startTurn(adapter, 'first')
      await adapter.setAgentSessionOption(SESSION, { kind: 'config', id: 'auto_compact', value: false })
      await adapter.setAgentSessionOption(SESSION, { kind: 'config', id: 'mode', value: 'plan' })
      turn.release()
      await turn.done
      await world.say(adapter, 'second')
      expect(world.agent.calls.slice(-4)).toEqual(['restore', 'set:mode=plan', 'set:auto_compact=false', 'prompt'])
    })

    it('are cancelled by choosing the value the Agent has, and keep the last choice otherwise', async () => {
      const world = new World('config')
      const adapter = world.adapter()
      const turn = await world.startTurn(adapter, 'first')
      await adapter.setAgentSessionOption(SESSION, { kind: 'config', id: 'fast-mode', value: 'on' })
      await adapter.setAgentSessionOption(SESSION, { kind: 'config', id: 'collaboration_mode', value: 'plan' })
      await adapter.setAgentSessionOption(SESSION, { kind: 'config', id: 'auto_compact', value: false })
      // The user changes their mind: fast mode back to what the Agent has, the toggle back on, the plan stays.
      await adapter.setAgentSessionOption(SESSION, { kind: 'config', id: 'fast-mode', value: 'off' })
      const cancelled = await adapter.setAgentSessionOption(SESSION, {
        kind: 'config',
        id: 'auto_compact',
        value: true,
      })
      expect(cancelled.pendingOptions).toEqual({ collaboration_mode: 'plan' })
      expect(await world.pendingOptions()).toEqual({ collaboration_mode: 'plan' })
      // Choosing the current value with nothing pending writes nothing.
      await adapter.setAgentSessionOption(SESSION, { kind: 'config', id: 'fast-mode', value: 'off' })
      expect(await world.pendingOptions()).toEqual({ collaboration_mode: 'plan' })

      turn.release()
      await turn.done
      await world.say(adapter, 'second')
      expect(world.agent.calls.slice(-3)).toEqual(['restore', 'set:collaboration_mode=plan', 'prompt'])
    })

    it('make a dock write that arrives while they are being applied wait, and then see their result', async () => {
      const world = new World('config')
      const adapter = world.adapter()
      const turn = await world.startTurn(adapter, 'first')
      await adapter.setAgentSessionOption(SESSION, { kind: 'config', id: 'collaboration_mode', value: 'plan' })
      turn.release()
      await turn.done

      const applying = Promise.withResolvers<void>()
      const proceed = Promise.withResolvers<void>()
      world.agent.beforeSet = async () => {
        applying.resolve()
        await proceed.promise
      }
      const hold = world.agent.hold()
      const second = collect(adapter.stream(request(world.conversation.say('second'))))
      await applying.promise
      // The user changes their mind while the Agent is still being given the choice made earlier.
      let answered = false
      const change = adapter
        .setAgentSessionOption(SESSION, { kind: 'config', id: 'collaboration_mode', value: 'default' })
        .finally(() => {
          answered = true
        })
      await sleep(20)
      expect(answered).toBe(false)

      proceed.resolve()
      await hold.entered
      // The write saw `plan` as what the Agent has, so `default` is a new choice for the next turn, not a cancel.
      expect((await change).pendingOptions).toEqual({ collaboration_mode: 'default' })
      hold.release()
      await second
      world.agent.beforeSet = undefined
      await world.say(adapter, 'third')
      expect(world.agent.calls.slice(2)).toEqual([
        'restore',
        'set:collaboration_mode=plan',
        'prompt',
        'restore',
        'set:collaboration_mode=default',
        'prompt',
      ])
    })

    it('are superseded by an immediate change of the same option once the turn is over', async () => {
      const world = new World('config')
      const adapter = world.adapter()
      const turn = await world.startTurn(adapter, 'first')
      await adapter.setAgentSessionOption(SESSION, { kind: 'config', id: 'fast-mode', value: 'on' })
      await adapter.setAgentSessionOption(SESSION, { kind: 'config', id: 'collaboration_mode', value: 'plan' })
      turn.release()
      await turn.done

      const idle = await adapter.setAgentSessionOption(SESSION, {
        kind: 'config',
        id: 'collaboration_mode',
        value: 'plan',
      })
      expect(world.agent.calls.slice(-1)).toEqual(['set:collaboration_mode=plan'])
      expect(await world.pendingOptions()).toEqual({ 'fast-mode': 'on' })
      expect(idle).toMatchObject({ editable: true })
      await world.say(adapter, 'second')
      expect(world.agent.calls.slice(-3)).toEqual(['restore', 'set:fast-mode=on', 'prompt'])
    })

    it('are dropped, logged and never fail the turn when the Agent no longer offers them', async () => {
      const world = new World('config')
      const adapter = world.adapter()
      const turn = await world.startTurn(adapter, 'first')
      await adapter.setAgentSessionOption(SESSION, { kind: 'config', id: 'fast-mode', value: 'on' })
      await adapter.setAgentSessionOption(SESSION, { kind: 'config', id: 'collaboration_mode', value: 'plan' })
      await adapter.setAgentSessionOption(SESSION, { kind: 'config', id: 'auto_compact', value: false })
      turn.release()
      await turn.done
      // A model switch removed fast mode and narrowed the collaboration modes; the toggle survives.
      world.agent.offer('fast-mode', undefined)
      world.agent.offer('collaboration_mode', ['default'])
      expect((await adapter.agentSessionSnapshot(SESSION)).pendingOptions).toEqual({ auto_compact: false })

      const second = await world.say(adapter, 'second')
      expect(finish(second)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      expect(world.agent.calls.slice(2)).toEqual(['restore', 'set:auto_compact=false', 'prompt'])
      expect(await world.pendingOptions()).toEqual({})
      expect(world.logs.filter((line) => line.includes('dropped the pending option'))).toEqual([
        'ACP dropped the pending option "collaboration_mode": the Agent no longer offers the value',
        'ACP dropped the pending option "fast-mode": the Agent no longer offers the option',
      ])
    })

    it('are dropped when their session binding is gone', async () => {
      const world = new World('config')
      const adapter = world.adapter()
      await world.say(adapter, 'first')
      await world.sidecar.writeOptionIntent(SESSION as never, {
        bindingKey: 'a-binding-that-was-replaced',
        optionId: 'fast-mode',
        value: 'on',
      })
      expect((await adapter.agentSessionSnapshot(SESSION)).pendingOptions).toEqual({})
      await world.say(adapter, 'second')
      expect(world.agent.calls.slice(-2)).toEqual(['restore', 'prompt'])
      expect(await world.pendingOptions()).toEqual({})
      expect(world.logs).toContain('ACP dropped the pending option "fast-mode": its session binding changed')
    })

    it.each([
      ['rejects', 'refused', 'could not be applied'],
      ['does not confirm', 'ignored', 'did not confirm'],
    ] as const)('fail the next prompt before dispatch when the Agent %s the write', async (_name, mode, message) => {
      const world = new World('config')
      const adapter = world.adapter()
      const turn = await world.startTurn(adapter, 'first')
      await adapter.setAgentSessionOption(SESSION, { kind: 'config', id: 'auto_compact', value: false })
      await adapter.setAgentSessionOption(SESSION, { kind: 'config', id: 'collaboration_mode', value: 'plan' })
      await adapter.setAgentSessionOption(SESSION, { kind: 'config', id: 'fast-mode', value: 'on' })
      turn.release()
      await turn.done
      world.agent[mode].add('collaboration_mode=plan')

      const attempt = world.say(adapter, 'second')
      await expect(attempt).rejects.toMatchObject({ code: 'ACP_CONFIG_SYNC_FAILED' })
      await expect(attempt).rejects.toThrow(message)
      // The choices before the failing one were confirmed and cleared; the failing one and the rest still wait.
      expect(world.agent.calls.slice(2)).toEqual(['restore', 'set:auto_compact=false', 'set:collaboration_mode=plan'])
      expect(await world.pendingOptions()).toEqual({ collaboration_mode: 'plan', 'fast-mode': 'on' })
      // Nothing was dispatched: the session is healthy and the next turn is not blocked by an unknown outcome.
      expect(await world.sidecar.readRecoveryState(SESSION as never)).toMatchObject({ kind: 'healthy' })

      // The controls stay live, so the user can undo the change that cannot be applied and carry on.
      const live = await adapter.agentSessionSnapshot(SESSION)
      expect(live).toMatchObject({ freshness: 'live', editable: true, pendingOptions: { collaboration_mode: 'plan' } })
      await adapter.setAgentSessionOption(SESSION, { kind: 'config', id: 'collaboration_mode', value: 'default' })
      expect(await world.pendingOptions()).toEqual({ 'fast-mode': 'on' })
      await world.say(adapter, 'third')
      expect(world.agent.calls.slice(-3)).toEqual(['restore', 'set:fast-mode=on', 'prompt'])
    })
  })

  it('keeps a pending choice across a restart of the plugin host', async () => {
    const world = new World('config')
    const first = world.adapter()
    const turn = await world.startTurn(first, 'first')
    await first.setAgentSessionOption(SESSION, { kind: 'config', id: 'mode', value: 'plan' })
    await first.setAgentSessionOption(SESSION, { kind: 'config', id: 'fast-mode', value: 'on' })
    turn.release()
    await turn.done

    await first.close()
    await world.sidecar.dispose()
    world.sidecar = world.open()
    const restarted = world.adapter()
    // Without a live Agent the last reported controls are shown, still with the choices that wait.
    expect(await restarted.agentSessionSnapshot(SESSION)).toMatchObject({
      freshness: 'stale',
      pendingModeId: 'plan',
      pendingOptions: { 'fast-mode': 'on' },
    })

    world.agent.calls.length = 0
    await world.say(restarted, 'after the restart')
    expect(world.agent.calls).toEqual(['restore', 'set:mode=plan', 'set:fast-mode=on', 'prompt'])
    expect(await world.sidecar.readModeIntent(SESSION as never)).toBeUndefined()
    expect(await world.pendingOptions()).toEqual({})
  })

  describe('a change made while the turn is being prepared', () => {
    describe.each(['legacy', 'config'] as const)('mode (%s)', (style) => {
      it('is pending for the next turn and is not sent with the prompt being prepared', async () => {
        const world = new World(style)
        const adapter = world.adapter()
        await world.say(adapter, 'first')
        world.agent.calls.length = 0

        const turn = await world.startPreparing(adapter, 'second')
        expect(world.agent.calls).toEqual(['restore'])
        const pending = await adapter.setAgentSessionOption(SESSION, modeWrite(style, 'plan'))
        expect(pending.pendingModeId).toBe('plan')

        turn.release()
        expect(finish(await turn.done)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
        // The prompt went out under the mode the user was told the Agent still had, and the choice still waits.
        expect(world.agent.calls).toEqual(['restore', 'prompt'])
        expect(world.agent.modeId).toBe('code')
        expect(await adapter.agentSessionSnapshot(SESSION)).toMatchObject({ pendingModeId: 'plan' })

        await world.say(adapter, 'third')
        expect(world.agent.calls.slice(2)).toEqual(['restore', modeCall(style, 'plan'), 'prompt'])
        expect(await world.sidecar.readModeIntent(SESSION as never)).toBeUndefined()
      })

      it('is cancelled for good by choosing the mode the Agent has', async () => {
        const world = new World(style)
        const adapter = world.adapter()
        await world.say(adapter, 'first')
        world.agent.calls.length = 0

        const turn = await world.startPreparing(adapter, 'second')
        await adapter.setAgentSessionOption(SESSION, modeWrite(style, 'plan'))
        const cancelled = await adapter.setAgentSessionOption(SESSION, modeWrite(style, 'code'))
        expect(cancelled.pendingModeId).toBeNull()
        expect(await world.sidecar.readModeIntent(SESSION as never)).toBeUndefined()

        turn.release()
        await turn.done
        await world.say(adapter, 'third')
        expect(world.agent.calls).toEqual(['restore', 'prompt', 'restore', 'prompt'])
        expect(world.agent.modeId).toBe('code')
      })

      it('after the prompt was prepared: changed, reverted, and the turn ran under the mode it started with', async () => {
        const world = new World(style)
        const adapter = world.adapter()
        await world.say(adapter, 'first')
        world.agent.calls.length = 0

        const turn = await world.startTurn(adapter, 'second')
        expect((await adapter.setAgentSessionOption(SESSION, modeWrite(style, 'plan'))).pendingModeId).toBe('plan')
        expect((await adapter.setAgentSessionOption(SESSION, modeWrite(style, 'code'))).pendingModeId).toBeNull()

        turn.release()
        await turn.done
        await world.say(adapter, 'third')
        expect(world.agent.calls).toEqual(['restore', 'prompt', 'restore', 'prompt'])
        expect(world.agent.modeId).toBe('code')
      })
    })

    describe('other options', () => {
      it('send the choices made before the turn began and keep the ones made after it', async () => {
        const world = new World('config')
        const adapter = world.adapter()
        const running = await world.startTurn(adapter, 'first')
        await adapter.setAgentSessionOption(SESSION, { kind: 'config', id: 'fast-mode', value: 'on' })
        running.release()
        await running.done
        world.agent.calls.length = 0

        const turn = await world.startPreparing(adapter, 'second')
        const pending = await adapter.setAgentSessionOption(SESSION, {
          kind: 'config',
          id: 'collaboration_mode',
          value: 'plan',
        })
        expect(pending.pendingOptions).toEqual({ 'fast-mode': 'on', collaboration_mode: 'plan' })

        turn.release()
        await turn.done
        // Fast mode was pending when the turn began and goes with it; the collaboration mode waits.
        expect(world.agent.calls).toEqual(['restore', 'set:fast-mode=on', 'prompt'])
        expect(await world.pendingOptions()).toEqual({ collaboration_mode: 'plan' })
        expect((await adapter.agentSessionSnapshot(SESSION)).pendingOptions).toEqual({ collaboration_mode: 'plan' })

        await world.say(adapter, 'third')
        expect(world.agent.calls.slice(3)).toEqual(['restore', 'set:collaboration_mode=plan', 'prompt'])
      })

      it('cancel a choice made before the turn began, for good, when they are cancelled before its prompt is prepared', async () => {
        const world = new World('config')
        const adapter = world.adapter()
        const running = await world.startTurn(adapter, 'first')
        await adapter.setAgentSessionOption(SESSION, { kind: 'config', id: 'fast-mode', value: 'on' })
        running.release()
        await running.done
        world.agent.calls.length = 0

        const turn = await world.startPreparing(adapter, 'second')
        const cancelled = await adapter.setAgentSessionOption(SESSION, {
          kind: 'config',
          id: 'fast-mode',
          value: 'off',
        })
        expect(cancelled.pendingOptions).toEqual({})

        turn.release()
        await turn.done
        expect(world.agent.calls).toEqual(['restore', 'prompt'])
        expect(world.agent.options.find((option) => option.id === 'fast-mode')?.currentValue).toBe('off')
        expect(await world.pendingOptions()).toEqual({})
      })

      it('never send a choice the user replaced after the turn began: the replacement waits for the next turn', async () => {
        const world = new World('config')
        const adapter = world.adapter()
        const running = await world.startTurn(adapter, 'first')
        await adapter.setAgentSessionOption(SESSION, { kind: 'config', id: 'verbosity', value: 'verbose' })
        running.release()
        await running.done
        world.agent.calls.length = 0

        const turn = await world.startPreparing(adapter, 'second')
        const replaced = await adapter.setAgentSessionOption(SESSION, {
          kind: 'config',
          id: 'verbosity',
          value: 'quiet',
        })
        expect(replaced.pendingOptions).toEqual({ verbosity: 'quiet' })

        turn.release()
        await turn.done
        expect(world.agent.calls).toEqual(['restore', 'prompt'])
        expect(await world.pendingOptions()).toEqual({ verbosity: 'quiet' })

        await world.say(adapter, 'third')
        expect(world.agent.calls.slice(2)).toEqual(['restore', 'set:verbosity=quiet', 'prompt'])
      })
    })
  })

  describe('a change made after DSH accepted the prompt, before its stream registers', () => {
    // The Agent is running and the turn is open, so the Stop button shows; the adapter has registered no stream yet.
    describe.each(['legacy', 'config'] as const)('mode (%s)', (style) => {
      it('waits for the next turn and is not written to the Agent before this one', async () => {
        const world = new World(style)
        const adapter = world.adapter()
        await world.say(adapter, 'first')
        world.agent.calls.length = 0

        world.conversation.acceptTurn()
        const pending = await adapter.setAgentSessionOption(SESSION, modeWrite(style, 'plan'))
        expect(pending).toMatchObject({ freshness: 'live', pendingModeId: 'plan' })
        expect(world.agent.calls).toEqual([])
        expect(await world.sidecar.readModeIntent(SESSION as never)).toEqual({
          bindingKey: await world.bindingKey(),
          modeId: 'plan',
        })

        const turn = await collect(adapter.stream(request(world.conversation.claim('second'))))
        world.conversation.endTurn()
        expect(finish(turn)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
        // The prompt went out under the mode the user was told the Agent still had, and the choice still waits.
        expect(world.agent.calls).toEqual(['restore', 'prompt'])
        expect(world.agent.modeId).toBe('code')
        expect(await adapter.agentSessionSnapshot(SESSION)).toMatchObject({ pendingModeId: 'plan' })

        await world.say(adapter, 'third')
        expect(world.agent.calls.slice(2)).toEqual(['restore', modeCall(style, 'plan'), 'prompt'])
        expect(await world.sidecar.readModeIntent(SESSION as never)).toBeUndefined()
      })

      it('is cancelled for good by choosing the mode the Agent has', async () => {
        const world = new World(style)
        const adapter = world.adapter()
        await world.say(adapter, 'first')
        world.agent.calls.length = 0

        world.conversation.acceptTurn()
        await adapter.setAgentSessionOption(SESSION, modeWrite(style, 'plan'))
        const cancelled = await adapter.setAgentSessionOption(SESSION, modeWrite(style, 'code'))
        expect(cancelled.pendingModeId).toBeNull()
        expect(await world.sidecar.readModeIntent(SESSION as never)).toBeUndefined()

        await collect(adapter.stream(request(world.conversation.claim('second'))))
        world.conversation.endTurn()
        await world.say(adapter, 'third')
        expect(world.agent.calls).toEqual(['restore', 'prompt', 'restore', 'prompt'])
        expect(world.agent.modeId).toBe('code')
      })

      it('is queued too when it comes through the draft menu of a session that has an Agent', async () => {
        const world = new World(style)
        const adapter = world.adapter()
        await world.say(adapter, 'first')
        world.agent.calls.length = 0

        world.conversation.acceptTurn()
        const pending = await adapter.setDraftMode(SESSION, 'plan')
        expect(pending).toMatchObject({ freshness: 'live', pendingModeId: 'plan' })
        expect(world.agent.calls).toEqual([])

        await collect(adapter.stream(request(world.conversation.claim('second'))))
        world.conversation.endTurn()
        expect(world.agent.calls).toEqual(['restore', 'prompt'])
        expect(world.agent.modeId).toBe('code')
      })
    })

    describe('other options', () => {
      it('send the choices made before the prompt was accepted and keep the ones made after it', async () => {
        const world = new World('config')
        const adapter = world.adapter()
        const running = await world.startTurn(adapter, 'first')
        await adapter.setAgentSessionOption(SESSION, { kind: 'config', id: 'fast-mode', value: 'on' })
        running.release()
        await running.done
        world.agent.calls.length = 0

        world.conversation.acceptTurn()
        const pending = await adapter.setAgentSessionOption(SESSION, {
          kind: 'config',
          id: 'collaboration_mode',
          value: 'plan',
        })
        expect(pending.pendingOptions).toEqual({ 'fast-mode': 'on', collaboration_mode: 'plan' })
        expect(world.agent.calls).toEqual([])

        await collect(adapter.stream(request(world.conversation.claim('second'))))
        world.conversation.endTurn()
        // Fast mode was pending when the prompt was accepted and goes with it; the collaboration mode waits.
        expect(world.agent.calls).toEqual(['restore', 'set:fast-mode=on', 'prompt'])
        expect(await world.pendingOptions()).toEqual({ collaboration_mode: 'plan' })

        await world.say(adapter, 'third')
        expect(world.agent.calls.slice(3)).toEqual(['restore', 'set:collaboration_mode=plan', 'prompt'])
      })

      it('cancel a choice made before the prompt was accepted, for good, when they are cancelled in that window', async () => {
        const world = new World('config')
        const adapter = world.adapter()
        const running = await world.startTurn(adapter, 'first')
        await adapter.setAgentSessionOption(SESSION, { kind: 'config', id: 'fast-mode', value: 'on' })
        running.release()
        await running.done
        world.agent.calls.length = 0

        world.conversation.acceptTurn()
        const cancelled = await adapter.setAgentSessionOption(SESSION, {
          kind: 'config',
          id: 'fast-mode',
          value: 'off',
        })
        expect(cancelled.pendingOptions).toEqual({})

        await collect(adapter.stream(request(world.conversation.claim('second'))))
        world.conversation.endTurn()
        expect(world.agent.calls).toEqual(['restore', 'prompt'])
        expect(world.agent.options.find((option) => option.id === 'fast-mode')?.currentValue).toBe('off')
        expect(await world.pendingOptions()).toEqual({})
      })
    })

    it('takes its fence along when the turn ends without a stream: the next prompt sends what was chosen', async () => {
      const world = new World('config')
      const adapter = world.adapter()
      await world.say(adapter, 'first')
      world.agent.calls.length = 0

      world.conversation.acceptTurn()
      await adapter.setAgentSessionOption(SESSION, modeWrite('config', 'plan'))
      await adapter.setAgentSessionOption(SESSION, { kind: 'config', id: 'fast-mode', value: 'on' })
      // Stopped before any request reached the adapter, or served by another provider.
      world.conversation.endTurn()
      expect(world.agent.calls).toEqual([])

      await world.say(adapter, 'third')
      expect(world.agent.calls).toEqual(['restore', 'set:mode=plan', 'set:fast-mode=on', 'prompt'])
      expect(await world.sidecar.readModeIntent(SESSION as never)).toBeUndefined()
      expect(await world.pendingOptions()).toEqual({})
    })

    it('is adopted by the stream it was held for only: the next prompt of the same turn is not fenced by it', async () => {
      const world = new World('legacy')
      const adapter = world.adapter()
      world.conversation.acceptTurn()
      const hold = world.agent.hold()
      const turn = collect(adapter.stream(request(world.conversation.claim('first'))))
      await hold.entered
      await adapter.setAgentSessionOption(SESSION, { kind: 'mode', id: 'plan' })

      // The agent cannot take steering, so the new input ends the prompt and starts the next one, in the same turn.
      world.conversation.steerInput()
      expect(finish(await turn)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      const queued = world.conversation.sayDuringTurn('queued while it ran')
      await collect(adapter.stream(request(queued)))
      world.conversation.endTurn()
      expect(world.agent.calls).toEqual(['start', 'prompt', 'restore', 'mode:plan', 'prompt'])
    })
  })

  describe('model and reasoning', () => {
    it.each(['mid-turn', 'idle'] as const)('stay on the DSH picker (%s)', async (when) => {
      const world = new World('config')
      const adapter = world.adapter()
      const turn = await world.startTurn(adapter, 'first')
      if (when === 'idle') {
        turn.release()
        await turn.done
      }
      for (const write of [
        { kind: 'config', id: 'model', value: 'model-b' },
        { kind: 'config', id: 'effort', value: 'high' },
        { kind: 'config', id: 'no-such-option', value: 'x' },
      ] as const)
        await expect(adapter.setAgentSessionOption(SESSION, write)).rejects.toMatchObject({
          code: 'ACP_CONFIG_UNSUPPORTED',
        })
      expect(await world.pendingOptions()).toEqual({})
      expect(world.agent.calls.filter((call) => call.startsWith('set:'))).toEqual([])
      if (when === 'mid-turn') {
        turn.release()
        await turn.done
      }
    })

    it('are the only options a queued write refuses', async () => {
      const world = new World('config')
      const adapter = world.adapter()
      const turn = await world.startTurn(adapter, 'first')
      // The same checks as an immediate write: a value the option does not offer, or a type it does not take.
      await expect(
        adapter.setAgentSessionOption(SESSION, { kind: 'config', id: 'fast-mode', value: 'turbo' }),
      ).rejects.toMatchObject({ code: 'ACP_CONFIG_UNSUPPORTED' })
      await expect(
        adapter.setAgentSessionOption(SESSION, { kind: 'config', id: 'auto_compact', value: 'off' }),
      ).rejects.toMatchObject({ code: 'ACP_CONFIG_UNSUPPORTED' })
      await expect(
        adapter.setAgentSessionOption(SESSION, { kind: 'config', id: 'mode', value: 'nonsense' }),
      ).rejects.toMatchObject({ code: 'ACP_CONFIG_UNSUPPORTED' })
      await expect(adapter.setAgentSessionOption(SESSION, { kind: 'mode', id: 'nonsense' })).rejects.toMatchObject({
        code: 'ACP_CONFIG_UNSUPPORTED',
      })
      expect(await world.pendingOptions()).toEqual({})
      expect(await world.sidecar.readModeIntent(SESSION as never)).toBeUndefined()
      turn.release()
      await turn.done
    })
  })

  describe('a message that becomes the next turn', () => {
    it('sees the change when Stop-free input interrupts the running prompt', async () => {
      const world = new World('legacy')
      const adapter = world.adapter()
      const turn = await world.startTurn(adapter, 'first')
      await adapter.setAgentSessionOption(SESSION, { kind: 'mode', id: 'plan' })
      await adapter.setAgentSessionOption(SESSION, { kind: 'config', id: 'fast-mode', value: 'on' })

      // The agent cannot take steering, so the new input ends the prompt and starts the next one.
      world.conversation.steerInput()
      expect(finish(await turn.done)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      const queued = world.conversation.sayDuringTurn('queued while it ran')
      await collect(adapter.stream(request(queued)))
      expect(world.agent.calls).toEqual(['start', 'prompt', 'restore', 'mode:plan', 'set:fast-mode=on', 'prompt'])
    })

    it('sees the change when steering needs a new prompt', async () => {
      const world = new World('legacy')
      world.agent.steerable = true
      const adapter = world.adapter()
      const turn = await world.startTurn(adapter, 'first')
      await adapter.setAgentSessionOption(SESSION, { kind: 'mode', id: 'plan' })
      await adapter.setAgentSessionOption(SESSION, { kind: 'config', id: 'fast-mode', value: 'on' })

      // Steering suspends the stream; the Agent answers `promptRequired`, so the message starts a new prompt.
      world.conversation.steerInput()
      expect(finish(await turn.done)).toMatchObject({ type: 'finish' })
      const steered = world.conversation.sayDuringTurn('steered while it ran')
      expect(finish(await collect(adapter.stream(request(steered))))).toMatchObject({ reason: { kind: 'stop' } })
      expect(world.agent.calls).toEqual([
        'start',
        'prompt',
        'steer',
        'restore',
        'mode:plan',
        'set:fast-mode=on',
        'prompt',
      ])
    })
  })
})
