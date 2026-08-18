/**
 * The `rolloutStats` projection unit: a pure fold of the rollout domain
 * events into whole-log counts and token figures, served through the
 * session-projection seam exactly like `sessionStats`.
 *
 * @module @deepseek-ai/dsh-tokenrouter-rollout/stats
 */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { RolloutStatsProjection } from './types.ts'

/** Accumulated whole-log rollout figures (the view is exactly these totals). */
interface RolloutStatsState extends RolloutStatsProjection {
  /** Winner scores so far, for the trailing average. */
  winnerScores: number[]
}

const EMPTY: Omit<RolloutStatsState, 'winnerScores'> = {
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

const init: () => RolloutStatsState = () => ({ ...EMPTY, winnerScores: [] })

const view = (state: RolloutStatsState): RolloutStatsProjection => {
  const { winnerScores: _winnerScores, ...totals } = state
  return totals
}

const schema = z.object({
  rollouts: z.number(),
  trajectories: z.number(),
  okTrajectories: z.number(),
  selectedRounds: z.number(),
  failedRounds: z.number(),
  workerOutputTokens: z.number(),
  judgeOutputTokens: z.number(),
  averageWinnerScore: z.number().nullable(),
  manualRounds: z.number(),
  milestoneRounds: z.number(),
})

/**
 * Fold one session event into the rolling stats. Pure: returns a new state
 * only when the event contributes, else the same reference.
 * @param state - the stats folded from every earlier event.
 * @param event - the next session event, of any type.
 * @returns the next state, or `state` itself when the event contributes nothing.
 */
export function foldRolloutStats(state: RolloutStatsState, event: { type: string; data: unknown }): RolloutStatsState {
  switch (event.type) {
    case 'rollout/start': {
      const data = event.data as { trigger: 'manual' | 'milestone' }
      return {
        ...state,
        rollouts: state.rollouts + 1,
        manualRounds: state.manualRounds + (data.trigger === 'manual' ? 1 : 0),
        milestoneRounds: state.milestoneRounds + (data.trigger === 'milestone' ? 1 : 0),
      }
    }
    case 'rollout/trajectory': {
      const data = event.data as { ok: boolean; outputTokens?: number }
      return {
        ...state,
        trajectories: state.trajectories + 1,
        okTrajectories: state.okTrajectories + (data.ok ? 1 : 0),
        workerOutputTokens: state.workerOutputTokens + (data.ok && data.outputTokens !== undefined ? data.outputTokens : 0),
      }
    }
    case 'rollout/selected': {
      const data = event.data as { scores: { score: number }[]; judgeOutputTokens?: number }
      const winner = data.scores.reduce((a, b) => (b.score > a.score ? b : a), data.scores[0] ?? { score: 0 })
      return {
        ...state,
        selectedRounds: state.selectedRounds + 1,
        judgeOutputTokens: state.judgeOutputTokens + (data.judgeOutputTokens ?? 0),
        winnerScores: [...state.winnerScores, winner.score],
        averageWinnerScore: (state.winnerScores.length + 1 > 0)
          ? [...state.winnerScores, winner.score].reduce((a, b) => a + b, 0) / (state.winnerScores.length + 1)
          : null,
      }
    }
    case 'rollout/error': {
      return { ...state, failedRounds: state.failedRounds + 1 }
    }
    default:
      return state
  }
}

/** Projection definition for `rolloutStats`, matching the unit contract. */
export const rolloutStatsProjectionDefinition: ProjectionDefinition<'rolloutStats', RolloutStatsState> = {
  key: 'rolloutStats',
  schema,
  init,
  apply: (state, event) => foldRolloutStats(state, event),
  view,
  stateVersion: 1,
}
