/**
 * Durable session-event and session-projection vocabulary of the
 * tokenrouter-rollout domain. The ONE home of the `rolloutStats`
 * projection-key declaration, free of this package's host-side value imports.
 *
 * @module @deepseek-ai/dsh-tokenrouter-rollout/types
 */

export {}

/** Why a rollout round started. */
export type RolloutTrigger = 'manual' | 'milestone'

/** One trajectory's durable record: worker route, diversity slot, and outcome. */
export interface RolloutTrajectoryEventData {
  /** Index in the round, 0-based; the judge's scores key on it. */
  index: number
  /** Provider route the worker used. */
  provider: string
  /** Exact model the worker used. */
  model: string
  /** Diversity slot label (e.g. `conservative`, `thorough`). */
  slot: string
  /** First line / short label of the produced plan, for UI display. */
  summary: string
  /** Whether the worker finished with a usable plan. */
  ok: boolean
  /** Provider-reported output tokens, when available. */
  outputTokens?: number
}

/** One judge verdict over the round's trajectories. */
export interface RolloutSelectedEventData {
  /** Index of the winning trajectory. */
  best: number
  /** Judge model that produced the scores. */
  judgeModel: string
  /** Per-trajectory scores (present when the judge returned them). */
  scores: { index: number; score: number; reasoning?: string }[]
  /** Judge provider-reported output tokens, when available. */
  judgeOutputTokens?: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A rollout round opened: N diverse trajectories will run in parallel and
     * a judge will pick one. Durable, log-only (non-surface): the selected
     * plan itself is delivered through `rollout/selected` narration, and the
     * round's bookkeeping stays trace-only.
     */
    'rollout/start': {
      trigger: RolloutTrigger
      /** Short human-readable description of the decision being rolled out. */
      decision: string
      /** Number of trajectories requested. */
      count: number
    }
    /**
     * One trajectory's durable record, appended when it settles. The worker's
     * full plan text is NOT logged here (it can be long); the summary line
     * keeps the log lightweight and the judge input reconstructable from the
     * worker sessions.
     */
    'rollout/trajectory': RolloutTrajectoryEventData
    /**
     * The judge's selection: which trajectory won and why. Model-visible
     * narration derives from this event (the surface projection renders the
     * winning plan summary as a user-role context message).
     */
    'rollout/selected': RolloutSelectedEventData
    /**
     * A rollout round failed before selection (e.g. all workers failed or the
     * judge was unreachable and no fallback applied). Log-only.
     */
    'rollout/error': {
      trigger: RolloutTrigger
      reason: string
    }
  }
}

/** Whole-log rollout figures served through the session-projection seam. */
export interface RolloutStatsProjection {
  /** Rollout rounds with a recorded start. */
  rollouts: number
  /** Trajectories that settled, across all rounds. */
  trajectories: number
  /** Trajectories that produced a usable plan. */
  okTrajectories: number
  /** Rounds that reached a judge selection. */
  selectedRounds: number
  /** Rounds that failed before selection. */
  failedRounds: number
  /** Summed worker output tokens across ok trajectories. */
  workerOutputTokens: number
  /** Summed judge output tokens across selections. */
  judgeOutputTokens: number
  /** Latest average winner score, or null before the first selection. */
  averageWinnerScore: number | null
  /** Manual-trigger rounds. */
  manualRounds: number
  /** Milestone-trigger rounds. */
  milestoneRounds: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * Whole-log rollout counts and token figures; every field is 0 (or null)
     * until its first contributing event lands.
     */
    rolloutStats: RolloutStatsProjection
  }
}
