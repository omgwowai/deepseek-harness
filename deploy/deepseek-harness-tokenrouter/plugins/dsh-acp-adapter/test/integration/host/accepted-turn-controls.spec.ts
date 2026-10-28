/**
 * A mode chosen right after Enter, through the published native AgentLoop.
 *
 * DSH accepts a prompt, and the turn opens, the moment the Agent turns running: `wakeDriver` commits `turn/start` in
 * the same call as the status flip, long before the loop assembles the system prompt, runs its pre-step, starts the
 * step and prepares the request that finally reaches the adapter's stream. That is the window in which the Stop button
 * is showing and the adapter has been asked for nothing. Holding the loop inside one of those phases lets a spec choose
 * a mode in the window without a timer. Persistence, the Agent registry, the loop and the adapter are real; only the
 * vendor process is a fake.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import type { AcpAgentConfig } from '../../../src/domain/session/agent-config.ts'
import { AcpProfileAdapter } from '../../../src/host/composition/profile-adapter.ts'
import {
  acpExecutionProjection,
  acpSessionView,
  readSessionFacts,
} from '../../../src/host/composition/session-facts.ts'
import {
  createAcpSidecar,
  initialModeIntentBindingKey,
  modeIntentBindingKey,
} from '../../../src/persistence/sidecar.ts'
import { NativeSessionRuntime } from '../../../src/runtime/native/native-session-runtime.ts'
import { selectNativeTransportKind } from '../../../src/runtime/native/transports/contract.ts'
import { FakeNativeTransport } from '../../native/support/fake-transport.ts'

const cleanup: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

const SESSION = SessionId('accepted-turn-controls')
const ROUTE = 'acp-claude'
const CLAUDE = {
  name: 'Claude Code (TokenRouter)',
  command: '/Users/test/.local/dsh/lib/node_modules/node/bin/node',
  args: ['/Users/test/dsh-agent-dag/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js'],
  env: {
    CLAUDE_CODE_EXECUTABLE: '/Users/test/dsh-agent-dag/claude-launch.mjs',
    DSH_CLAUDE_EXECUTABLE: '/Users/test/.local/bin/claude',
    PATH: '/usr/bin:/bin',
  },
  runtime: 'claude',
} satisfies AcpAgentConfig

const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

/** The loop phases a turn passes through between DSH accepting the prompt and the request reaching the adapter. */
type LoopPhase = 'agent/pre-step' | 'agent/request'

async function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-accepted-turn-'))
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const sidecar = createAcpSidecar({ root })
  cleanup.push(() => sidecar.dispose())
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(WorkingDirectory, { defaultDirectory: root })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.sessionProjections.register(acpExecutionProjection)

  const transports: FakeNativeTransport[] = []
  const adapter = new AcpProfileAdapter(
    'claude',
    () => CLAUDE,
    { ok: true, seam: undefined as never },
    (id) => {
      const view = acpSessionView(ctx, ctx.sessions.get(id as never))
      // No permission operation is exercised here.
      return view === undefined
        ? undefined
        : Object.defineProperty(view, 'permissions', {
            value: { preset: null, sandbox: null, approval: null, seeded: false },
          })
    },
    {
      begin: (record) => sidecar.beginDispatch(record),
      settle: (id, key) => sidecar.settleDispatch(id as never, key),
      read: (id, key) => sidecar.readDispatch(id as never, key),
    },
    () => ({ listModels: async () => [{ id: 'default', name: 'default', provider: ROUTE }] }),
    (options) =>
      new NativeSessionRuntime({
        ...options,
        createTransport: () => {
          const transport = new FakeNativeTransport({ kind: 'claude' })
          transports.push(transport)
          return transport
        },
      }),
    sidecar,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    selectNativeTransportKind,
  )
  ctx.llm.registerAdapter([ROUTE], adapter)
  const agent = await ctx.agentLoop.create(SESSION, { provider: ROUTE, model: 'default' }, { cwd: root })
  const session = agent.session
  cleanup.push(() => adapter.disposeSession({ id: session.id, identity: session }))
  cleanup.push(() => adapter.close())

  /** Keep the next turn inside `phase` until `release`: the loop has accepted the prompt and gone no further. */
  const hold = (phase: LoopPhase) => {
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    let armed = true
    const off = ctx.on(phase, (async (_payload: unknown, next: () => Promise<unknown>) => {
      if (armed) {
        armed = false
        entered.resolve()
        await gate.promise
      }
      return await next()
    }) as never)
    cleanup.push(() => off())
    // A failed assertion must not leave the loop held through teardown.
    cleanup.push(() => gate.resolve())
    return { entered: entered.promise, release: () => gate.resolve() }
  }

  const bindingKey = async (): Promise<string> => {
    const lookup = await sidecar.readLatestBinding(SESSION as never)
    if (lookup?.status !== 'ok') throw new Error('the session has no binding')
    return modeIntentBindingKey(lookup.binding)
  }

  return { ctx, agent, session, adapter, sidecar, transports, hold, bindingKey }
}

describe('a mode chosen after DSH accepted the prompt, through the published AgentLoop', () => {
  it.each(['agent/pre-step', 'agent/request'] as const)(
    'keeps the first turn on the mode chosen before the send, held in %s',
    async (phase) => {
      const h = await harness()
      // Chosen before Enter: the first turn's own mode.
      await h.adapter.setDraftMode(SESSION, 'bypassPermissions')
      const held = h.hold(phase)

      h.agent.followup(user('first'))
      await held.entered
      // The Stop button is showing, the loop has not asked the adapter for anything.
      expect(h.agent.status).toBe('running')
      const facts = readSessionFacts(h.ctx, h.session)
      expect(facts.turnOpen).toBe(true)
      expect(facts.openSteps).toHaveLength(phase === 'agent/request' ? 1 : 0)
      expect(h.transports).toEqual([])

      // Chosen right after Enter.
      const during = await h.adapter.setDraftMode(SESSION, 'default')
      expect(during).toMatchObject({ freshness: 'stale', currentModeId: 'bypassPermissions', pendingModeId: 'default' })
      expect(await h.sidecar.readModeIntent(SESSION as never)).toEqual({
        bindingKey: initialModeIntentBindingKey(ROUTE),
        modeId: 'default',
      })

      held.release()
      await h.agent.whenIdle()
      const transport = h.transports[0]!
      expect(transport.calls).toEqual(['start:new', 'set:mode=bypassPermissions', 'prompt'])
      expect(await h.adapter.agentSessionSnapshot(SESSION)).toMatchObject({
        freshness: 'live',
        currentModeId: 'bypassPermissions',
        pendingModeId: 'default',
      })
      expect(await h.sidecar.readModeIntent(SESSION as never)).toEqual({
        bindingKey: initialModeIntentBindingKey(ROUTE),
        modeId: 'default',
      })

      h.agent.followup(user('second'))
      await h.agent.whenIdle()
      expect(transport.calls.slice(3)).toEqual(['set:mode=default', 'prompt'])
      expect(await h.sidecar.readModeIntent(SESSION as never)).toBeUndefined()
      expect(await h.adapter.agentSessionSnapshot(SESSION)).toMatchObject({
        currentModeId: 'default',
        pendingModeId: null,
      })
    },
  )

  it('keeps the first turn on the Agent default when nothing was chosen before the send', async () => {
    const h = await harness()
    const held = h.hold('agent/pre-step')
    h.agent.followup(user('first'))
    await held.entered

    expect(await h.adapter.setDraftMode(SESSION, 'plan')).toMatchObject({ currentModeId: null, pendingModeId: 'plan' })
    held.release()
    await h.agent.whenIdle()
    const transport = h.transports[0]!
    expect(transport.calls).toEqual(['start:new', 'prompt'])
    expect(await h.sidecar.readModeIntent(SESSION as never)).toEqual({
      bindingKey: initialModeIntentBindingKey(ROUTE),
      modeId: 'plan',
    })

    h.agent.followup(user('second'))
    await h.agent.whenIdle()
    expect(transport.calls.slice(2)).toEqual(['set:mode=plan', 'prompt'])
  })

  it('still starts the first turn with a mode chosen before the send', async () => {
    const h = await harness()
    await h.adapter.setDraftMode(SESSION, 'acceptEdits')
    h.agent.followup(user('first'))
    await h.agent.whenIdle()

    expect(h.transports[0]!.calls).toEqual(['start:new', 'set:mode=acceptEdits', 'prompt'])
    expect(await h.sidecar.readModeIntent(SESSION as never)).toBeUndefined()
  })

  it('queues a control of a warm session chosen after Enter instead of writing it to the Agent', async () => {
    const h = await harness()
    h.agent.followup(user('first'))
    await h.agent.whenIdle()
    const transport = h.transports[0]!
    expect(transport.calls).toEqual(['start:new', 'prompt'])

    const held = h.hold('agent/pre-step')
    h.agent.followup(user('second'))
    await held.entered
    const pending = await h.adapter.setAgentSessionOption(SESSION, { kind: 'config', id: 'mode', value: 'plan' })
    expect(pending).toMatchObject({ freshness: 'live', currentModeId: 'default', pendingModeId: 'plan' })
    expect(transport.calls).toEqual(['start:new', 'prompt'])
    expect(await h.sidecar.readModeIntent(SESSION as never)).toEqual({
      bindingKey: await h.bindingKey(),
      modeId: 'plan',
    })

    held.release()
    await h.agent.whenIdle()
    expect(transport.calls).toEqual(['start:new', 'prompt', 'prompt'])

    h.agent.followup(user('third'))
    await h.agent.whenIdle()
    expect(transport.calls.slice(3)).toEqual(['set:mode=plan', 'prompt'])
  })

  it('lets the next turn start with the choice when Stop ends the accepted turn before any request', async () => {
    const h = await harness()
    const held = h.hold('agent/pre-step')
    h.agent.followup(user('first'))
    await held.entered
    await h.adapter.setDraftMode(SESSION, 'plan')

    h.agent.cancel({ kind: 'user' })
    held.release()
    await h.agent.whenIdle()
    expect(h.transports).toEqual([])
    expect(readSessionFacts(h.ctx, h.session).turnOpen).toBe(false)
    // The turn is over and took its fence with it: the choice is the next turn's own again.
    expect(await h.adapter.draftSessionSnapshot(SESSION)).toMatchObject({ currentModeId: 'plan', pendingModeId: null })

    h.agent.followup(user('again'))
    await h.agent.whenIdle()
    expect(h.transports[0]!.calls).toEqual(['start:new', 'set:mode=plan', 'prompt'])
  })
})
