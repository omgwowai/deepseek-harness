import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { AcpAgentSessionSnapshotView } from '../../../src/contract/remote.ts'
import type { AgentControlChoice } from '../../../src/client/ui/agent-session-controls.ts'

const runtime = vi.hoisted(() => ({
  cursor: 0,
  cells: [] as unknown[],
  effects: [] as (() => void)[],
  cleanups: new Map<number, () => void>(),
  agent: undefined as unknown,
  policy: undefined as unknown,
}))

// Run the component's actual handlers and effects. The browser scenario owns native React rendering.
vi.mock('react', () => ({
  createElement: (type: unknown, props: Record<string, unknown> | null) => ({ type, props }),
  useState: (initial: unknown) => {
    const index = runtime.cursor++
    if (!(index in runtime.cells)) runtime.cells[index] = typeof initial === 'function' ? initial() : initial
    return [
      runtime.cells[index],
      (value: unknown) => {
        runtime.cells[index] = typeof value === 'function' ? value(runtime.cells[index]) : value
      },
    ]
  },
  useRef: (initial: unknown) => {
    const index = runtime.cursor++
    if (!(index in runtime.cells)) runtime.cells[index] = { current: initial }
    return runtime.cells[index]
  },
  useEffect: (effect: () => (() => void) | undefined, dependencies: readonly unknown[]) => {
    const index = runtime.cursor++
    const previous = runtime.cells[index] as readonly unknown[] | undefined
    if (previous !== undefined && dependencies.every((value, position) => Object.is(value, previous[position]))) return
    runtime.cells[index] = dependencies
    runtime.effects.push(() => {
      runtime.cleanups.get(index)?.()
      const cleanup = effect()
      if (cleanup === undefined) runtime.cleanups.delete(index)
      else runtime.cleanups.set(index, cleanup)
    })
  },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}))

vi.mock('../../../src/client/data/agent-session-stream.ts', () => ({
  agentSessionStream: (_remote: unknown, _factory: unknown, _sessionId: string, changed: (value: unknown) => void) => ({
    // Before an Agent session exists the host reports nothing to follow.
    start: () => {
      if (runtime.agent !== undefined) changed(runtime.agent)
    },
    dispose: async () => {},
  }),
}))
vi.mock('../../../src/client/data/tool-approval-policy-stream.ts', () => ({
  toolApprovalPolicyStream: (
    _remote: unknown,
    _factory: unknown,
    _sessionId: string,
    changed: (value: unknown) => void,
  ) => ({
    start: () => changed(runtime.policy),
    dispose: async () => {},
  }),
}))

import { AcpAgentControl } from '../../../src/client/ui/AcpAgentControl.ts'
import { en, zh } from '../../../src/client/ui/locales.ts'

const SESSION = 'session-source'

type Props = ComponentProps<typeof AcpAgentControl>
type Menu = {
  props: {
    label: string
    disabled: boolean
    footer: readonly { id: string; text: string }[]
    groups: readonly { id: string; kind: string; choices: readonly AgentControlChoice[] }[]
    onSelect(choice: AgentControlChoice): void
  }
}

function translate(dictionary: typeof en): Props['t'] {
  const hasKey = (key: string): key is keyof typeof dictionary => Object.hasOwn(dictionary, key)
  return (key, params) => {
    if (!hasKey(key)) throw new Error(`Missing ACP translation: ${key}`)
    let text = dictionary[key]
    for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value))
    return text
  }
}

function render(props: Props): Menu {
  let menu: Menu
  // One pass commits changed effects; the second observes their stream baselines.
  for (let pass = 0; pass < 2; pass++) {
    runtime.cursor = 0
    menu = AcpAgentControl(props) as Menu
    for (const effect of runtime.effects.splice(0)) effect()
  }
  return menu!
}

/** The draft menu arrives from the host after the first pass: let it settle, then render what the dock shows. */
async function renderSettled(props: Props): Promise<Menu> {
  render(props)
  const settled = Promise.withResolvers<void>()
  setTimeout(settled.resolve, 0)
  await settled.promise
  return render(props)
}

/** What the host reports for a Codex session: a mode, a collaboration mode and a model; pending choices as given. */
const agentSnapshot = (overrides: Partial<AcpAgentSessionSnapshotView> = {}): AcpAgentSessionSnapshotView => ({
  sessionId: SESSION,
  profileId: 'codex',
  freshness: 'live',
  // The host is busy with the turn, so it reports the Agent as not writable right now.
  editable: false,
  modes: null,
  currentModeId: null,
  contextUsage: null,
  note: null,
  configOptions: [
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'agent',
      options: [
        { value: 'agent', name: 'Agent' },
        { value: 'read-only', name: 'Read only' },
      ],
    },
    {
      id: 'collaboration_mode',
      name: 'Collaboration mode',
      category: 'collaboration_mode',
      type: 'select',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'plan', name: 'Plan' },
      ],
    },
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'gpt-6',
      options: [{ value: 'gpt-6', name: 'GPT-6' }],
    },
  ],
  pendingModeId: 'read-only',
  pendingOptions: { collaboration_mode: 'plan' },
  ...overrides,
})

function setup(init: {
  readonly running: boolean
  readonly snapshot?: AcpAgentSessionSnapshotView
  /** The draft menu of a session that has no Agent session yet; the host then reports no snapshot to follow. */
  readonly draft?: AcpAgentSessionSnapshotView
  readonly writable?: boolean
  readonly t?: Props['t']
}) {
  runtime.agent = init.draft === undefined ? (init.snapshot ?? agentSnapshot()) : undefined
  // The DSH tool approval policy has its own idle-only rule, which must not change.
  runtime.policy = { sessionId: SESSION, policy: 'auto', source: 'session', editable: !init.running }
  const writable = init.writable ?? true
  const remote = {
    draftAgentSession: vi.fn(async () => ({ ok: true, value: init.draft ?? null })),
    setDraftAgentMode: vi.fn(async () => ({ ok: true, value: init.draft ?? null })),
    setAgentSessionOption: vi.fn(async () => ({ ok: true, value: runtime.agent })),
    setToolApprovalPolicy: vi.fn(async () => ({ ok: true, value: null })),
  }
  const props = {
    sessionId: SESSION,
    useProjection: (key: string) =>
      key === 'title'
        ? 'Source conversation'
        : { lastUsed: { provider: 'acp-codex' }, next: { provider: 'acp-codex' } },
    useSession: (selector: (state: { running: boolean }) => unknown) => selector({ running: init.running }),
    useAccess: () => writable,
    sessionAccessSource: () => ({ getSnapshot: () => writable }),
    t: init.t ?? translate(en),
    remote,
    streamFactory: {},
    ownsRoute: (provider: string | undefined) => provider === 'acp-codex',
    getDefaultProvider: async () => 'acp-codex',
    watchDefaultProvider: () => () => {},
    feedback: { report: vi.fn() },
  } as unknown as Props
  return { props, remote }
}

const choicesOf = (menu: Menu, group: string) => menu.props.groups.find((candidate) => candidate.id === group)!.choices
const agentChoices = (menu: Menu) =>
  menu.props.groups.filter((group) => group.kind !== 'policy').flatMap((group) => group.choices)

beforeEach(() => {
  runtime.cursor = 0
  runtime.cells = []
  runtime.effects = []
  runtime.cleanups.clear()
})
afterEach(() => {
  for (const cleanup of runtime.cleanups.values()) cleanup()
})

describe('Agent controls while a turn runs', () => {
  it('keep every mode and option choice enabled, show what waits, and explain when it applies', () => {
    const { props } = setup({ running: true })
    const menu = render(props)

    expect(menu.props.groups.map((group) => group.id)).toEqual([
      'tool-approval-policy',
      'config:mode',
      'config:collaboration_mode',
    ])
    expect(agentChoices(menu).length).toBe(4)
    expect(agentChoices(menu).every((choice) => !choice.disabled)).toBe(true)
    // The pending selections show as selected; the values the Agent has do not.
    expect(choicesOf(menu, 'config:mode').map((choice) => [choice.id, choice.current])).toEqual([
      ['config:mode:agent', false],
      ['config:mode:read-only', true],
    ])
    expect(choicesOf(menu, 'config:collaboration_mode').map((choice) => [choice.id, choice.current])).toEqual([
      ['config:collaboration_mode:default', false],
      ['config:collaboration_mode:plan', true],
    ])
    expect(menu.props.label).toBe('Codex permissions · Read only')
    const footer = menu.props.footer.map((entry) => entry.text)
    expect(footer).toContain(en.agentChangesApplyNext)
    expect(footer).not.toContain(en.agentControlRunning)
    expect(footer).not.toContain(en.agentControlReadOnly)
  })

  it('explain the delay in both languages', () => {
    for (const dictionary of [en, zh]) {
      const menu = render(setup({ running: true, t: translate(dictionary) }).props)
      expect(menu.props.footer.map((entry) => entry.text)).toContain(dictionary.agentChangesApplyNext)
      runtime.cells = []
      runtime.cleanups.clear()
    }
    expect(zh.agentChangesApplyNext).not.toBe(en.agentChangesApplyNext)
  })

  it('send a change to the host, and the choice that cancels a pending one', () => {
    const { props, remote } = setup({ running: true })
    const menu = render(props)
    const byId = (id: string) => agentChoices(menu).find((choice) => choice.id === id)!

    // The value the Agent has is not marked as selected, yet choosing it must reach the host: it cancels the choice.
    menu.props.onSelect(byId('config:collaboration_mode:default'))
    expect(remote.setAgentSessionOption).toHaveBeenLastCalledWith(SESSION, {
      kind: 'config',
      id: 'collaboration_mode',
      value: 'default',
    })
    menu.props.onSelect(byId('config:mode:agent'))
    expect(remote.setAgentSessionOption).toHaveBeenLastCalledWith(SESSION, {
      kind: 'config',
      id: 'mode',
      value: 'agent',
    })
    expect(remote.setAgentSessionOption).toHaveBeenCalledTimes(2)
  })

  it('leave the DSH tool approval policy as read-only as before', () => {
    const { props, remote } = setup({ running: true })
    const menu = render(props)
    const policy = menu.props.groups.find((group) => group.kind === 'policy')!
    expect(policy.choices.map((choice) => choice.disabled)).toEqual([true, true])
    menu.props.onSelect(policy.choices[0]!)
    expect(remote.setToolApprovalPolicy).not.toHaveBeenCalled()
  })

  it('stay read-only, with the old explanation, for a user who may not change settings', () => {
    const { props, remote } = setup({ running: true, writable: false })
    const menu = render(props)
    expect(agentChoices(menu).every((choice) => choice.disabled)).toBe(true)
    const footer = menu.props.footer.map((entry) => entry.text)
    expect(footer).toContain(en.agentControlRunning)
    expect(footer).not.toContain(en.agentChangesApplyNext)
    menu.props.onSelect(agentChoices(menu)[0]!)
    expect(remote.setAgentSessionOption).not.toHaveBeenCalled()
  })

  it('stay read-only for a stale report, as before', () => {
    const { props, remote } = setup({
      running: true,
      snapshot: agentSnapshot({ freshness: 'stale', modeWritable: true, pendingModeId: null, pendingOptions: {} }),
    })
    const menu = render(props)
    expect(agentChoices(menu).every((choice) => choice.disabled)).toBe(true)
    const footer = menu.props.footer.map((entry) => entry.text)
    expect(footer).toContain(en.agentControlRunning)
    expect(footer).not.toContain(en.agentChangesApplyNext)
    menu.props.onSelect(agentChoices(menu)[0]!)
    expect(remote.setAgentSessionOption).not.toHaveBeenCalled()
    expect(remote.setDraftAgentMode).not.toHaveBeenCalled()
  })
})

describe('Agent controls once the turn is over', () => {
  it('keep explaining a choice that is still waiting for the next turn', () => {
    const { props } = setup({ running: false, snapshot: agentSnapshot({ editable: true }) })
    const menu = render(props)
    expect(agentChoices(menu).every((choice) => !choice.disabled)).toBe(true)
    expect(menu.props.footer.map((entry) => entry.text)).toEqual([en.agentChangesApplyNext])
  })

  it('say nothing about the next turn when nothing waits', () => {
    const { props } = setup({
      running: false,
      snapshot: agentSnapshot({ editable: true, pendingModeId: null, pendingOptions: {} }),
    })
    const menu = render(props)
    expect(agentChoices(menu).every((choice) => !choice.disabled)).toBe(true)
    expect(menu.props.footer).toEqual([])
  })
})

const draftSnapshot = (overrides: Partial<AcpAgentSessionSnapshotView> = {}): AcpAgentSessionSnapshotView => ({
  sessionId: SESSION,
  profileId: 'codex',
  freshness: 'stale',
  editable: false,
  modeWritable: true,
  modes: [
    { id: 'read-only', name: 'Read-only' },
    { id: 'agent', name: 'Auto review' },
    { id: 'agent-full-access', name: 'Full access' },
  ],
  currentModeId: null,
  pendingModeId: null,
  configOptions: null,
  contextUsage: null,
  note: null,
  ...overrides,
})

describe('Agent controls before an Agent session exists', () => {
  it('offer the saved modes while the first prompt is still being written', async () => {
    const { props, remote } = setup({ running: false, draft: draftSnapshot() })
    const menu = await renderSettled(props)

    expect(agentChoices(menu).map((choice) => choice.disabled)).toEqual([false, false, false])
    expect(menu.props.footer.map((entry) => entry.text)).toEqual([en.agentModeAppliesNext])
    menu.props.onSelect(agentChoices(menu)[1]!)
    expect(remote.setDraftAgentMode).toHaveBeenCalledExactlyOnceWith(SESSION, 'acp-codex', 'agent')
  })

  it('keep every mode choosable once the first prompt is out, and say the choice waits for the next turn', async () => {
    const { props, remote } = setup({ running: true, draft: draftSnapshot() })
    const menu = await renderSettled(props)

    // The session already runs, yet its Agent session does not exist: nothing to follow, and the host holds the choice.
    expect(agentChoices(menu).map((choice) => choice.disabled)).toEqual([false, false, false])
    const footer = menu.props.footer.map((entry) => entry.text)
    expect(footer).toEqual([en.agentChangesApplyNext])
    menu.props.onSelect(agentChoices(menu)[2]!)
    expect(remote.setDraftAgentMode).toHaveBeenCalledExactlyOnceWith(SESSION, 'acp-codex', 'agent-full-access')
    expect(remote.setAgentSessionOption).not.toHaveBeenCalled()
  })

  it('show the choice made since the prompt went out as pending, beside the mode the first turn runs with', async () => {
    const { props } = setup({
      running: true,
      draft: draftSnapshot({ currentModeId: 'read-only', pendingModeId: 'agent-full-access' }),
    })
    const menu = await renderSettled(props)

    expect(choicesOf(menu, 'mode').map((choice) => [choice.id, choice.current])).toEqual([
      ['mode:read-only', false],
      ['mode:agent', false],
      ['mode:agent-full-access', true],
    ])
    expect(menu.props.label).toBe('Codex permissions · Full access')
  })

  it('ask the host for the draft of the route the composer selects, and drop the previous route at once', async () => {
    const { props, remote } = setup({ running: false, draft: draftSnapshot({ currentModeId: 'agent' }) })
    const first = await renderSettled(props)
    expect(first.props.label).toBe('Codex permissions · Auto review')
    expect(remote.draftAgentSession).toHaveBeenLastCalledWith(SESSION, 'acp-codex')

    const toClaude = {
      ...props,
      useProjection: (key: string) =>
        key === 'title'
          ? 'Source conversation'
          : { lastUsed: { provider: 'acp-claude' }, next: { provider: 'acp-claude' } },
      ownsRoute: (provider: string | undefined) => provider === 'acp-claude',
    } as unknown as Props
    const switched = render(toClaude)
    // The previous route's choice is not shown for the new route while its own draft is on the way.
    expect(agentChoices(switched)).toEqual([])
    expect(remote.draftAgentSession).toHaveBeenLastCalledWith(SESSION, 'acp-claude')
  })
})
