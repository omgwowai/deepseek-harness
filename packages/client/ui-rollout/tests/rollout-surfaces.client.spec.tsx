// @vitest-environment jsdom
/**
 * The three rollout React surfaces: the composer button gates on the synced
 * enabled flag and surfaces failures, the settings page commits drafts on
 * blur (an emptied optional field unsets so a deployment value survives), and
 * the stats panel stays absent until a round has run.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createSnapshotStore, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { RolloutStatsProjection } from '@deepseek-ai/dsh-tokenrouter-rollout/types'
import { RolloutButton, type RolloutButtonProps } from '../src/client/RolloutButton.tsx'
import { RolloutSettings, type RolloutSettingsProps } from '../src/client/RolloutSettings.tsx'
import { RolloutStatsPanel, type RolloutStatsPanelProps } from '../src/client/RolloutStatsPanel.tsx'
import { createRolloutSettingsStore, ROLLOUT_DEFAULTS, type RolloutSettingsState } from '../src/client/settings-store.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const SID = 's-rollout' as SessionId

// The framework-injected t seat, stubbed over the zh dictionary (the default locale).
const t = makeTranslate(zh) as RolloutButtonProps['t']

/** Real store instance carrying one mirrored settings snapshot. */
function syncedStore(state: Partial<Omit<RolloutSettingsState, 'revision'>>) {
  const store = createRolloutSettingsStore().create()
  store.actions.sync({ ...ROLLOUT_DEFAULTS, ...state }, 0)
  return store
}

function mountButton(
  enabled: boolean,
  run: RolloutButtonProps['run'] = vi.fn(() => Promise.resolve<string | null>(null)),
) {
  const store = syncedStore({ enabled })
  const props = {
    sessionId: SID,
    useStore: bindSnapshotSelector(store),
    run,
    t,
  } as unknown as RolloutButtonProps
  const view = render(<RolloutButton {...props} />)
  return { run, view }
}

const trigger = () => screen.getByRole<HTMLButtonElement>('button', { name: zh['button.aria'] })

describe('RolloutButton', () => {
  it('disables the trigger while rollout is off', () => {
    const { run } = mountButton(false)
    expect(trigger().disabled).toBe(true)
    fireEvent.click(trigger())
    expect(run).not.toHaveBeenCalled()
  })

  it('executes one round per click and re-enables when it is admitted', async () => {
    let resolve!: (value: string | null) => void
    const run = vi.fn(() => new Promise<string | null>((done) => { resolve = done }))
    mountButton(true, run)
    fireEvent.click(trigger())
    expect(run).toHaveBeenCalledWith(SID)
    expect(trigger().disabled).toBe(true)
    fireEvent.click(trigger())
    expect(run).toHaveBeenCalledTimes(1)
    resolve(null)
    await waitFor(() => { expect(trigger().disabled).toBe(false) })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('surfaces admission and transport failures', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce('unknown command: /rollout')
      .mockRejectedValueOnce(new Error('socket closed'))
      .mockRejectedValueOnce('raw reason')
    mountButton(true, run as RolloutButtonProps['run'])
    fireEvent.click(trigger())
    expect((await screen.findByText('rollout failed')).getAttribute('title')).toBe('unknown command: /rollout')

    fireEvent.click(trigger())
    expect(await screen.findByTitle('socket closed')).toBeTruthy()

    fireEvent.click(trigger())
    expect(await screen.findByTitle('raw reason')).toBeTruthy()
  })

  it('ignores in-flight fulfillment and rejection after unmount', () => {
    let resolve!: (value: string | null) => void
    const settled = mountButton(true, vi.fn(() => new Promise<string | null>((done) => { resolve = done })))
    fireEvent.click(trigger())
    settled.view.unmount()
    expect(() => { resolve(null) }).not.toThrow()

    let reject!: (reason: unknown) => void
    const failing = mountButton(true, vi.fn(() => new Promise<string | null>((_done, fail) => { reject = fail })))
    fireEvent.click(trigger())
    failing.view.unmount()
    expect(() => { reject(new Error('late')) }).not.toThrow()
  })
})

function mountSettings(state: Partial<Omit<RolloutSettingsState, 'revision'>> = {}) {
  const store = syncedStore(state)
  const set = vi.fn(() => Promise.resolve())
  const unset = vi.fn(() => Promise.resolve())
  const props = {
    useStore: bindSnapshotSelector(store),
    set,
    unset,
    t,
  } as unknown as RolloutSettingsProps
  render(<RolloutSettings {...props} />)
  return { set, unset }
}

/** The labelled field as the input it is; the query itself is typed `HTMLElement`. */
const field = (label: string) => screen.getByLabelText<HTMLInputElement>(label)

/** Type a value into a labelled field and commit it the way the page does. */
function commit(label: string, value: string) {
  const input = field(label)
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
  return input
}

describe('RolloutSettings', () => {
  it('renders the synced snapshot across every row', () => {
    mountSettings({
      enabled: true,
      rolloutCount: 5,
      judgeModel: 'gpt-5.6-sol',
      judgeBaseURL: 'https://judge.example/v1',
      workerModels: ['a', 'b'],
      autoMilestone: true,
    })
    expect(field(zh['settings.enabled.label']).checked).toBe(true)
    expect(field(zh['settings.count.label']).value).toBe('5')
    expect(field(zh['settings.judge.label']).value).toBe('gpt-5.6-sol')
    expect(field(zh['settings.judgeBaseURL.label']).value).toBe('https://judge.example/v1')
    expect(field(zh['settings.workerModels.label']).value).toBe('a, b')
    expect(field(zh['settings.autoMilestone.label']).checked).toBe(true)
  })

  it('writes both switches immediately', () => {
    const { set } = mountSettings()
    fireEvent.click(screen.getByLabelText(zh['settings.enabled.label']))
    expect(set).toHaveBeenCalledWith('enabled', true)
    fireEvent.click(screen.getByLabelText(zh['settings.autoMilestone.label']))
    expect(set).toHaveBeenCalledWith('autoMilestone', true)
  })

  it('commits an in-range round size and reverts anything else', () => {
    const { set } = mountSettings({ rolloutCount: 3 })
    commit(zh['settings.count.label'], '6')
    expect(set).toHaveBeenCalledWith('rolloutCount', 6)

    for (const rejected of ['0', '9', '']) {
      set.mockClear()
      expect(commit(zh['settings.count.label'], rejected).value).toBe('3')
      expect(set).not.toHaveBeenCalled()
    }
  })

  it('keeps the judge model when the field is emptied', () => {
    const { set, unset } = mountSettings({ judgeModel: 'claude-opus-5' })
    commit(zh['settings.judge.label'], '  gpt-5.6-sol  ')
    expect(set).toHaveBeenCalledWith('judgeModel', 'gpt-5.6-sol')
    set.mockClear()
    commit(zh['settings.judge.label'], '   ')
    expect(set).not.toHaveBeenCalled()
    expect(unset).not.toHaveBeenCalled()
  })

  it('unsets the judge endpoint when emptied so a deployment value re-inherits', () => {
    const { set, unset } = mountSettings({ judgeBaseURL: 'https://judge.example/v1' })
    commit(zh['settings.judgeBaseURL.label'], '  https://other.example/v1 ')
    expect(set).toHaveBeenCalledWith('judgeBaseURL', 'https://other.example/v1')
    commit(zh['settings.judgeBaseURL.label'], '  ')
    expect(unset).toHaveBeenCalledWith('judgeBaseURL')
  })

  it('unsets the worker pool when emptied and splits it otherwise', () => {
    const { set, unset } = mountSettings({ workerModels: ['a'] })
    commit(zh['settings.workerModels.label'], ' x , , y ')
    expect(set).toHaveBeenCalledWith('workerModels', ['x', 'y'])
    commit(zh['settings.workerModels.label'], ' , ')
    expect(unset).toHaveBeenCalledWith('workerModels')
  })
})

/** Zeroed projection; each test raises only the fields it asserts on. */
const NO_ROUNDS: RolloutStatsProjection = {
  rollouts: 0,
  trajectories: 0,
  okTrajectories: 0,
  selectedRounds: 0,
  failedRounds: 0,
  workerOutputTokens: 0,
  judgeOutputTokens: 0,
  averageWinnerScore: null,
  manualRounds: 0,
  milestoneRounds: 0,
}

function mountStats(stats: RolloutStatsProjection | undefined) {
  const store = createSnapshotStore<{ value: RolloutStatsProjection | undefined }>({ value: stats })
  const useProjection = (_key: string, selector?: (v: unknown) => unknown) =>
    bindSnapshotSelector(store)(s => (selector ?? (v => v))(s.value))
  const props = { useProjection, t } as unknown as RolloutStatsPanelProps
  return render(<RolloutStatsPanel {...props} />)
}

/** Read one row's value cell by its label. */
const cell = (label: string) => screen.getByText(label).nextElementSibling?.textContent

describe('RolloutStatsPanel', () => {
  it('renders nothing before the projection exists or a round has run', () => {
    expect(mountStats(undefined).container.innerHTML).toBe('')
    cleanup()
    expect(mountStats(NO_ROUNDS).container.innerHTML).toBe('')
  })

  it('renders the counts, grouping token figures and rounding the winner score', () => {
    mountStats({
      ...NO_ROUNDS,
      rollouts: 4,
      trajectories: 12,
      okTrajectories: 11,
      selectedRounds: 3,
      failedRounds: 1,
      workerOutputTokens: 123456,
      judgeOutputTokens: 7890,
      averageWinnerScore: 84.6,
    })
    expect(screen.getByText(zh['stats.title'])).toBeTruthy()
    expect(cell(zh['stats.rounds'])).toBe('4')
    expect(cell(zh['stats.trajectories'])).toBe('12')
    expect(cell(zh['stats.ok'])).toBe('11')
    expect(cell(zh['stats.failedRounds'])).toBe('1')
    expect(cell(zh['stats.avgWinner'])).toBe('85')
    expect(cell(zh['stats.workerTokens'])).toBe((123456).toLocaleString())
    expect(cell(zh['stats.judgeTokens'])).toBe((7890).toLocaleString())
  })

  it('dashes the winner score while a started round has produced no selection', () => {
    mountStats({ ...NO_ROUNDS, rollouts: 1, trajectories: 3, failedRounds: 1 })
    expect(cell(zh['stats.avgWinner'])).toBe('—')
  })
})
