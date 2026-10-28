import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createAcpLogger } from '../../../src/domain/observability/logging.ts'
import type { AcpAgentSessionSnapshotView } from '../../../src/contract/remote.ts'
import { installNativeCommands, type NativeCommandAdapter } from '../../../src/host/composition/native-commands.ts'
import { staticNativeCommands } from '../../../src/runtime/native/native-commands.ts'
import type {
  NativeCommand,
  NativeCommandResult,
  NativeTransportKind,
} from '../../../src/runtime/native/transports/contract.ts'

interface Definition {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string }
  readonly handler: (invocation: { agent: unknown; rawInput: string; signal: AbortSignal }) => unknown
}

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** A command registry that refuses what `dsh-commands` refuses, and counts what it accepted. */
function strictRegistry() {
  const registered = new Map<string, Definition>()
  const registry = {
    registered,
    registrations: 0,
    register(definition: Definition): () => void {
      if (!/^[a-z][a-z0-9_-]*$/u.test(definition.name))
        throw new TypeError(`command name "${definition.name}" is invalid`)
      if (definition.description.trim() === '') throw new TypeError(`command "${definition.name}" has no description`)
      if (definition.input !== undefined && definition.input.hint.trim() === '')
        throw new TypeError(`command "${definition.name}" has an empty input hint`)
      if (registered.has(definition.name)) throw new Error(`command "${definition.name}" is already registered`)
      registered.set(definition.name, definition)
      registry.registrations += 1
      return () => {
        if (registered.get(definition.name) === definition) registered.delete(definition.name)
      }
    },
  }
  return registry
}

const ok = (text: string): NativeCommandResult => ({ kind: 'success', text })

const view = (patch: Partial<AcpAgentSessionSnapshotView> = {}): AcpAgentSessionSnapshotView => ({
  sessionId: 'session-1',
  profileId: 'test',
  freshness: 'live',
  editable: true,
  configOptions: null,
  modes: null,
  currentModeId: null,
  contextUsage: null,
  note: null,
  ...patch,
})

const catalog: NativeCommand[] = [
  { name: 'btw', description: 'Ask a side question', hint: '<question>', dispatch: 'side' },
  { name: 'status', description: 'Show the status', dispatch: 'immediate' },
  { name: 'review', description: 'Review the changes', hint: '[scope]', dispatch: 'prompt' },
  { name: 'compact', description: 'Compact the conversation', dispatch: 'prompt' },
  { name: 'new', description: 'Start a new conversation', aliases: ['reset', 'Clear'], dispatch: 'immediate' },
  { name: 'mcp:docs:search', description: 'Search the docs', dispatch: 'prompt' },
  { name: 'Deploy', description: 'Deploy it', dispatch: 'prompt' },
  ...['model', 'file', 'goal', 'export', 'feedback', 'permission', 'help', 'plan', 'effort', 'fast'].map(
    (name): NativeCommand => ({ name, description: `the vendor's ${name}`, dispatch: 'immediate' }),
  ),
]

interface HarnessOptions {
  /** `undefined` = an ACP agent that is not a native one. */
  readonly kind?: NativeTransportKind | undefined
  readonly catalog?: NativeCommand[]
  /** No request header yet: the route is the pending pick (a draft session). */
  readonly draft?: boolean
  readonly status?: 'idle' | 'running'
}

async function harness(options: HarnessOptions = {}) {
  const kind = 'kind' in options ? options.kind : 'claude'
  const ctx = new Context()
  const agentCtx = new Context()
  contexts.push(ctx, agentCtx)
  const registry = strictRegistry()
  agentCtx.provide('commands', registry as never)

  const adapter = {
    catalog: options.catalog ?? [...catalog],
    listeners: new Set<(sessionId: string) => void>(),
    nativeCommands: vi.fn(() => adapter.catalog),
    watchNativeCommands: vi.fn((listener: (sessionId: string) => void) => {
      adapter.listeners.add(listener)
      return () => adapter.listeners.delete(listener)
    }),
    runNativeCommand: vi.fn(async (): Promise<NativeCommandResult> => ok('ran')),
    sideQuestion: vi.fn(async (): Promise<NativeCommandResult> => ok('answer')),
    draftSessionSnapshot: vi.fn(async (): Promise<AcpAgentSessionSnapshotView | null> => null),
    setDraftMode: vi.fn(async (): Promise<AcpAgentSessionSnapshotView | null> => null),
    setNativeSessionOption: vi.fn(async () => view()),
    resolveModel: vi.fn(async () => ({
      reasoning: {
        efforts: [
          { id: 'low', name: 'Low' },
          { id: 'high', name: 'High' },
        ],
        defaultEffort: 'low',
      },
    })),
    announce: (sessionId: string) => adapter.listeners.forEach((listener) => listener(sessionId)),
  }
  let routeAlive = true
  const routes = {
    resolve: (provider: string | undefined) =>
      provider === 'acp-test' && routeAlive ? { adapter: adapter as unknown as NativeCommandAdapter, kind } : undefined,
  }

  const followups: string[] = []
  let pending: { provider: string; model: string } | null =
    options.draft === true ? { provider: 'deepseek', model: 'm' } : null
  const feed = new Set<(session: unknown, key: string) => void>()
  const agent = {
    id: 'session-1',
    status: options.status ?? 'idle',
    options: {},
    ctx: agentCtx,
    session: {
      id: 'session-1',
      header: {},
      requestHeader: () =>
        options.draft === true
          ? undefined
          : { config: { provider: 'acp-test', model: 'opus', reasoningEffort: 'low' } },
    },
    followup: vi.fn((message: { content: { text: string }[] }) => followups.push(message.content[0]!.text)),
  }
  ctx.provide('agents', { get: () => agent, list: () => [] } as never)
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'deepseek', model: 'm' }) } as never)
  ctx.provide('sessionProjections', {
    stateOf: () => ({ lastUsed: null, pending }),
    onChanged: (listener: (session: unknown, key: string) => void) => {
      feed.add(listener)
      return () => feed.delete(listener)
    },
  } as never)
  const selectModel = vi.fn(async () => ({ selected: {} }))
  ctx.provide('sessionController', { selectModel } as never)

  const logged: string[] = []
  const bridge = installNativeCommands(
    ctx,
    routes,
    createAcpLogger({ info: () => undefined, warn: (message) => logged.push(message), error: () => undefined }),
  )
  ctx.emit('agent/created', { agent, source: 'startup' } as never)
  await bridge.idle()

  const run = async (name: string, rawInput = '') => {
    const definition = registry.registered.get(name)
    if (definition === undefined) throw new Error(`/${name} is not registered`)
    return (await definition.handler({ agent, rawInput, signal: new AbortController().signal })) as {
      kind: string
      text?: string
    }
  }
  const names = () => [...registry.registered.keys()].sort()
  return {
    ctx,
    registry,
    adapter,
    agent,
    bridge,
    followups,
    selectModel,
    logged,
    run,
    names,
    killRoute: () => {
      routeAlive = false
    },
    pick: (provider: string) => {
      pending = { provider, model: 'opus' }
      for (const listener of feed) listener(agent.session, 'modelSelection')
    },
  }
}

describe('native commands as DSH host commands', () => {
  describe('registration', () => {
    it.each(['claude', 'codex', 'omp'] as const)(
      'registers /btw, /compact and the host commands for %s',
      async (kind) => {
        const { names, registry } = await harness({ kind, catalog: [...staticNativeCommands(kind)] })
        expect(names()).toEqual(expect.arrayContaining(['btw', 'compact', 'help', 'effort', 'fast']))
        // Claude Code and Codex have a native plan mode; Oh My Pi keeps DSH's own /plan.
        expect(names().includes('plan')).toBe(kind !== 'omp')
        // The client's own names are never taken.
        expect(names()).not.toContain('model')
        expect(names()).not.toContain('file')
        for (const definition of registry.registered.values()) expect(definition.input?.hint.trim()).not.toBe('')
      },
    )

    it('registers what DSH can register, once, under the name policy', async () => {
      const { names, registry } = await harness()
      // The vendor's own help/plan/effort/fast and DSH's export/feedback/permission, model and file are not taken from the
      // catalog; names DSH cannot spell stay typed text. Aliases are extra names. A vendor goal is the agent's own goal.
      expect(names()).toEqual([
        'btw',
        'compact',
        'effort',
        'fast',
        'goal',
        'help',
        'new',
        'plan',
        'reset',
        'review',
        'status',
      ])
      expect(registry.registered.get('btw')?.input).toEqual({ hint: '<question>' })
      expect(registry.registered.get('status')?.input?.hint).toBe('[arguments]')
      expect(registry.registered.get('reset')?.description).toContain('/new')
      const help = await (await harness()).run('help')
      expect(help.text).toContain('/mcp:docs:search')
    })

    it('keeps only the /compact shadow, without an argument claim, for an ACP agent that is not a native one', async () => {
      const { names, registry, run, followups } = await harness({ kind: undefined })
      expect(names()).toEqual(['compact'])
      expect(registry.registered.get('compact')?.input).toBeUndefined()
      expect(await run('compact')).toEqual({
        kind: 'success',
        text: 'Sent /compact to the Agent; it compacts its own context.',
      })
      expect(followups).toEqual(['/compact'])
    })

    it('registers nothing for a session whose route is not an ACP route', async () => {
      const { names, registry } = await harness({ draft: true })
      expect(names()).toEqual([])
      expect(registry.registrations).toBe(0)
    })
  })

  describe('dispatch', () => {
    it('answers a side question without a turn, and says what is missing instead of calling the agent', async () => {
      const { run, adapter, followups } = await harness()
      adapter.sideQuestion.mockResolvedValueOnce(ok('4'))
      expect(await run('btw', ' what is 2+2? ')).toEqual({ kind: 'success', text: '4' })
      expect(adapter.sideQuestion).toHaveBeenCalledWith('session-1', 'what is 2+2?', expect.any(AbortSignal))
      expect(await run('btw', '  ')).toMatchObject({ kind: 'error', text: expect.stringContaining('/btw <question>') })
      expect(adapter.sideQuestion).toHaveBeenCalledTimes(1)
      expect(followups).toEqual([])
    })

    it('runs an immediate command by its vendor name, aliases included, and reports every outcome as text', async () => {
      const { run, adapter, followups } = await harness()
      expect(await run('status', ' verbose')).toEqual(ok('ran'))
      expect(adapter.runNativeCommand).toHaveBeenLastCalledWith(
        'session-1',
        'status',
        'verbose',
        expect.any(AbortSignal),
      )
      await run('reset')
      expect(adapter.runNativeCommand).toHaveBeenLastCalledWith('session-1', 'new', '', expect.any(AbortSignal))
      adapter.runNativeCommand.mockResolvedValueOnce({ kind: 'error', text: 'refused while a turn runs' })
      expect(await run('new')).toEqual({ kind: 'error', text: 'refused while a turn runs' })
      adapter.runNativeCommand.mockResolvedValueOnce(ok('  '))
      expect(await run('status')).toMatchObject({ kind: 'success', text: expect.stringMatching(/\S/) })
      adapter.runNativeCommand.mockResolvedValueOnce({ kind: 'error', text: '' })
      expect(await run('status')).toMatchObject({ kind: 'error', text: expect.stringMatching(/\S/) })
      expect(followups).toEqual([])
    })

    it('queues a prompt command as the next prompt of the session, args as typed', async () => {
      const { run, followups, adapter } = await harness()
      expect(await run('review', ' src/a.ts')).toMatchObject({ kind: 'success' })
      expect(followups).toEqual(['/review src/a.ts'])
      expect(await run('compact')).toEqual({
        kind: 'success',
        text: 'Sent /compact to the Agent; it compacts its own context.',
      })
      expect(followups).toEqual(['/review src/a.ts', '/compact'])
      expect(adapter.runNativeCommand).not.toHaveBeenCalled()
    })

    it('answers instead of acting when the route went away', async () => {
      const { run, adapter, killRoute } = await harness()
      killRoute()
      expect(await run('btw', ' q')).toMatchObject({ kind: 'error' })
      expect(await run('status')).toMatchObject({ kind: 'error' })
      expect(adapter.sideQuestion).not.toHaveBeenCalled()
      expect(adapter.runNativeCommand).not.toHaveBeenCalled()
    })
  })

  describe('following the agent', () => {
    it('re-registers when the catalog changes, and only then', async () => {
      const { names, adapter, bridge, registry, run } = await harness()
      const registrations = registry.registrations
      adapter.announce('session-1')
      await bridge.idle()
      expect(registry.registrations).toBe(registrations)

      adapter.catalog = [...adapter.catalog, { name: 'deploy', description: 'Deploy it', dispatch: 'immediate' }]
      adapter.announce('session-1')
      await bridge.idle()
      expect(names()).toContain('deploy')
      expect(names()).toContain('btw')
      await run('deploy')
      expect(adapter.runNativeCommand).toHaveBeenLastCalledWith('session-1', 'deploy', '', expect.any(AbortSignal))
    })

    it('routes a command by the class its catalog entry has now', async () => {
      const { adapter, bridge, run, followups } = await harness()
      adapter.catalog = adapter.catalog.map((command) =>
        command.name === 'review' ? { ...command, dispatch: 'immediate' as const } : command,
      )
      adapter.announce('session-1')
      await bridge.idle()
      await run('review', ' src')
      expect(adapter.runNativeCommand).toHaveBeenLastCalledWith('session-1', 'review', 'src', expect.any(AbortSignal))
      expect(followups).toEqual([])
    })

    it('follows a draft session to an ACP model and away from it', async () => {
      const { names, pick } = await harness({ draft: true })
      expect(names()).toEqual([])
      pick('acp-test')
      await vi.waitFor(() => expect(names()).toContain('btw'))
      pick('deepseek')
      await vi.waitFor(() => expect(names()).toEqual([]))
    })

    it('unregisters everything when the plugin goes away', async () => {
      const { ctx, names, adapter } = await harness()
      expect(names()).toContain('btw')
      await ctx.fiber.dispose()
      await vi.waitFor(() => expect(names()).toEqual([]))
      expect(adapter.listeners.size).toBe(0)
    })
  })

  describe('/help', () => {
    it('lists the commands, describes one, and refuses an unknown one', async () => {
      const { run } = await harness()
      const all = await run('help')
      expect(all.text).toContain('/btw <question>')
      expect(all.text).toContain('/plan')
      expect(all.text).not.toContain('/model` ')
      expect(await run('help', ' btw')).toMatchObject({
        kind: 'success',
        text: expect.stringContaining('Ask a side question'),
      })
      expect(await run('help', ' nonesuch')).toMatchObject({ kind: 'error' })
    })
  })

  describe('/goal', () => {
    const goal = (dispatch: NativeCommand['dispatch']): NativeCommand => ({
      name: 'goal',
      description: "Show or set the agent's goal",
      hint: '[<objective>|clear|pause|resume]',
      dispatch,
    })
    const btw = catalog[0]!
    /** The commands `/help` still lists as DSH's own. */
    const dshOwn = (help: { text?: string }): string[] | undefined =>
      /DSH's own commands \(([^)]*)\)/.exec(help.text ?? '')?.[1]?.match(/\/[\w-]+/g) ?? undefined

    it.each([
      ['claude', 'prompt'],
      ['codex', 'immediate'],
      ['omp', 'immediate'],
    ] as const)(
      "is the agent's own goal on a %s route, run the way its catalog entry says: %s",
      async (kind, dispatch) => {
        const { names, registry, run, adapter, followups } = await harness({ kind, catalog: [goal(dispatch)] })
        expect(names()).toContain('goal')
        expect(registry.registered.get('goal')?.input).toEqual({ hint: '[<objective>|clear|pause|resume]' })

        await run('goal', ' ship the release')
        await run('goal')
        if (dispatch === 'prompt') {
          expect(followups).toEqual(['/goal ship the release', '/goal'])
          expect(adapter.runNativeCommand).not.toHaveBeenCalled()
        } else {
          expect(adapter.runNativeCommand).toHaveBeenNthCalledWith(
            1,
            'session-1',
            'goal',
            'ship the release',
            expect.any(AbortSignal),
          )
          expect(adapter.runNativeCommand).toHaveBeenNthCalledWith(2, 'session-1', 'goal', '', expect.any(AbortSignal))
          expect(followups).toEqual([])
        }
      },
    )

    it("leaves DSH's goal alone for an agent whose catalog has none, and /help still lists it as DSH's", async () => {
      const { names, run } = await harness({ kind: 'codex', catalog: [btw] })
      expect(names()).not.toContain('goal')
      expect(dshOwn(await run('help'))).toEqual(['/goal', '/export', '/feedback', '/permission', '/model'])
    })

    it("lists the agent's goal as the agent's and no longer as DSH's", async () => {
      const { run } = await harness({ kind: 'codex', catalog: [btw, goal('immediate')] })
      const help = await run('help')
      expect(help.text).toContain('/goal [<objective>')
      expect(dshOwn(help)).toEqual(['/export', '/feedback', '/permission', '/model'])
    })

    it("takes DSH's goal when the catalog gains one and gives it back when the catalog loses it", async () => {
      const { names, adapter, bridge } = await harness({ kind: 'codex', catalog: [btw] })
      expect(names()).not.toContain('goal')

      adapter.catalog = [btw, goal('immediate')]
      adapter.announce('session-1')
      await bridge.idle()
      expect(names()).toContain('goal')

      adapter.catalog = [btw]
      adapter.announce('session-1')
      await bridge.idle()
      expect(names()).not.toContain('goal')
    })
  })

  describe('/plan', () => {
    it('switches Claude Code to plan mode, gives the earlier mode back, and sends a message after the switch', async () => {
      const { run, adapter, followups } = await harness()
      adapter.draftSessionSnapshot.mockResolvedValueOnce(view({ currentModeId: 'acceptEdits' }))
      expect(await run('plan')).toMatchObject({ kind: 'success' })
      expect(adapter.setDraftMode).toHaveBeenLastCalledWith('session-1', 'plan')

      adapter.draftSessionSnapshot.mockResolvedValueOnce(view({ currentModeId: 'plan' }))
      expect(await run('plan', ' off')).toMatchObject({ kind: 'success' })
      expect(adapter.setDraftMode).toHaveBeenLastCalledWith('session-1', 'acceptEdits')

      adapter.draftSessionSnapshot.mockResolvedValueOnce(view({ currentModeId: 'default' }))
      expect(await run('plan', ' fix the bug')).toMatchObject({ kind: 'success' })
      expect(adapter.setDraftMode).toHaveBeenLastCalledWith('session-1', 'plan')
      expect(followups).toEqual(['fix the bug'])

      // Off when it is already off does nothing; a refused switch sends no message.
      const writes = adapter.setDraftMode.mock.calls.length
      adapter.draftSessionSnapshot.mockResolvedValueOnce(view({ currentModeId: 'default' }))
      expect(await run('plan', ' off')).toMatchObject({ kind: 'success' })
      expect(adapter.setDraftMode).toHaveBeenCalledTimes(writes)
      adapter.draftSessionSnapshot.mockResolvedValueOnce(view({ currentModeId: 'default' }))
      adapter.setDraftMode.mockRejectedValueOnce(new Error('Agent mode "plan" is not available'))
      expect(await run('plan', ' go on')).toMatchObject({
        kind: 'error',
        text: expect.stringContaining('not available'),
      })
      expect(followups).toEqual(['fix the bug'])
    })

    it('switches Codex through its collaboration mode, and needs the session to exist first', async () => {
      const { run, adapter } = await harness({ kind: 'codex', catalog: [...staticNativeCommands('codex')] })
      adapter.draftSessionSnapshot.mockResolvedValueOnce(view())
      expect(await run('plan')).toMatchObject({ kind: 'error', text: expect.stringMatching(/send a message first/i) })
      expect(adapter.setNativeSessionOption).not.toHaveBeenCalled()

      adapter.draftSessionSnapshot.mockResolvedValueOnce(
        view({
          configOptions: [
            {
              type: 'select',
              id: 'collaboration_mode',
              name: 'Collaboration mode',
              currentValue: 'default',
              options: [
                { value: 'default', name: 'Default' },
                { value: 'plan', name: 'Plan' },
              ],
            },
          ],
        }),
      )
      expect(await run('plan')).toMatchObject({ kind: 'success' })
      expect(adapter.setNativeSessionOption).toHaveBeenCalledWith(
        'session-1',
        { kind: 'config', id: 'collaboration_mode', value: 'plan' },
        expect.any(AbortSignal),
      )
    })
  })

  describe('/fast', () => {
    const select = (currentValue: string) =>
      view({
        configOptions: [
          {
            type: 'select',
            id: 'fast-mode',
            name: 'Fast mode',
            currentValue,
            options: [
              { value: 'off', name: 'Off' },
              { value: 'on', name: 'On' },
            ],
          },
        ],
      })

    it('writes the switch the option has: select values or a boolean', async () => {
      const { run, adapter } = await harness()
      adapter.draftSessionSnapshot.mockResolvedValueOnce(select('off'))
      expect(await run('fast', ' on')).toMatchObject({ kind: 'success' })
      expect(adapter.setNativeSessionOption).toHaveBeenLastCalledWith(
        'session-1',
        { kind: 'config', id: 'fast-mode', value: 'on' },
        expect.any(AbortSignal),
      )
      adapter.draftSessionSnapshot.mockResolvedValueOnce(
        view({ configOptions: [{ type: 'boolean', id: 'fast', name: 'Fast', currentValue: true }] }),
      )
      expect(await run('fast', ' off')).toMatchObject({ kind: 'success' })
      expect(adapter.setNativeSessionOption).toHaveBeenLastCalledWith(
        'session-1',
        { kind: 'config', id: 'fast', value: false },
        expect.any(AbortSignal),
      )
    })

    it('shows the current value with no argument, and refuses what cannot be done', async () => {
      const { run, adapter } = await harness()
      adapter.draftSessionSnapshot.mockResolvedValueOnce(select('on'))
      expect(await run('fast')).toMatchObject({ kind: 'success', text: expect.stringContaining('**on**') })
      adapter.draftSessionSnapshot.mockResolvedValueOnce(select('on'))
      expect(await run('fast', ' maybe')).toMatchObject({ kind: 'error' })
      adapter.draftSessionSnapshot.mockResolvedValueOnce(view({ configOptions: [] }))
      expect(await run('fast', ' on')).toMatchObject({ kind: 'error', text: expect.stringMatching(/not available/i) })
      adapter.draftSessionSnapshot.mockResolvedValueOnce(null)
      expect(await run('fast', ' on')).toMatchObject({
        kind: 'error',
        text: expect.stringMatching(/send a message first/i),
      })
      adapter.draftSessionSnapshot.mockResolvedValueOnce(select('off'))
      adapter.setNativeSessionOption.mockRejectedValueOnce(new Error('Fast mode is unavailable for the current model.'))
      expect(await run('fast', ' on')).toEqual({
        kind: 'error',
        text: 'Fast mode is unavailable for the current model.',
      })
    })
  })

  describe('/effort', () => {
    it('changes the effort where the model menu does, and lists the levels with no argument', async () => {
      const { run, selectModel, adapter } = await harness()
      expect(await run('effort')).toMatchObject({ kind: 'success', text: expect.stringContaining('**Low** (current)') })
      expect(adapter.resolveModel).toHaveBeenCalledWith('acp-test', 'opus', expect.any(AbortSignal))

      expect(await run('effort', ' HIGH')).toMatchObject({ kind: 'success' })
      expect(selectModel).toHaveBeenCalledWith({
        sessionId: 'session-1',
        provider: 'acp-test',
        model: 'opus',
        reasoningEffort: 'high',
      })
      expect(await run('effort', ' extreme')).toMatchObject({
        kind: 'error',
        text: expect.stringContaining('low, high'),
      })
      expect(selectModel).toHaveBeenCalledTimes(1)
    })

    it('reports a model without levels and a selection the host refuses', async () => {
      const { run, selectModel, adapter } = await harness()
      adapter.resolveModel.mockResolvedValueOnce({ reasoning: undefined } as never)
      expect(await run('effort')).toMatchObject({ kind: 'error' })
      selectModel.mockRejectedValueOnce(new Error('model unavailable'))
      expect(await run('effort', ' high')).toEqual({ kind: 'error', text: 'model unavailable' })
    })
  })
})
