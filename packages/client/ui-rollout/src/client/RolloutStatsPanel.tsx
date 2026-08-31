import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the session standard kit (useProjection) into the slot props.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: merges the rolloutStats key into SessionProjectionMap for useProjection.
import type {} from '@deepseek-ai/dsh-tokenrouter-rollout/types'
import type { RolloutKey } from './locales.ts'
import css from './RolloutStatsPanel.module.css'

/** Full stats-panel props: the standard kit's useProjection seat + locale. */
export type RolloutStatsPanelProps =
  PropsRuntime<'conversation.details.footer'> & PropsLocale<'rollout'>

/**
 * Session-details readout of the `rolloutStats` projection. Renders nothing
 * while no rollout has ever run in this session (stats all zero / null).
 */
export function RolloutStatsPanel({ useProjection, t }: RolloutStatsPanelProps) {
  const stats = useProjection('rolloutStats')
  if (stats === undefined || stats.rollouts === 0) return null

  const rows: { key: RolloutKey; value: string }[] = [
    { key: 'stats.rounds', value: String(stats.rollouts) },
    { key: 'stats.trajectories', value: String(stats.trajectories) },
    { key: 'stats.ok', value: String(stats.okTrajectories) },
    { key: 'stats.failedRounds', value: String(stats.failedRounds) },
    { key: 'stats.avgWinner', value: stats.averageWinnerScore === null ? '—' : stats.averageWinnerScore.toFixed(0) },
    { key: 'stats.workerTokens', value: stats.workerOutputTokens.toLocaleString() },
    { key: 'stats.judgeTokens', value: stats.judgeOutputTokens.toLocaleString() },
  ]

  return (
    <div className={css.panel}>
      <div className={css.title}>{t('stats.title')}</div>
      <div className={css.grid}>
        {rows.map(row => (
          <div key={row.key} className={css.item}>
            <span className={css.label}>{t(row.key)}</span>
            <span className={css.value}>{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
