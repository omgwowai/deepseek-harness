/**
 * Rollout settings store: a mirror of the settings scope snapshot. The
 * plugin's apply-world subscriber is the only writer; the settings page
 * reads via props.useStore.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** Store state mirrored from the settings scope snapshot. */
export interface RolloutSettingsState {
  /** Whether rollout is enabled. */
  enabled: boolean
  /** Parallel trajectories per round. */
  rolloutCount: number
  /** Judge model id. */
  judgeModel: string
  /**
   * Judge endpoint base URL. Empty until a deployment supplies one; the host
   * refuses a round rather than calling nowhere, so this is the field a user
   * must fill before enabling rollout has any effect.
   */
  judgeBaseURL: string
  /** Worker model pool. */
  workerModels: string[]
  /** Automatically trigger on milestone completion. */
  autoMilestone: boolean
  /** Scope revision; -1 until first sync so revision 0 lands as a change. */
  revision: number
}

/** Declared action shape giving the exported factory a stable return type. */
type RolloutSettingsActions = {
  /** Replace the mirrored state; the draft is baked away by the framework. */
  sync: (draft: RolloutSettingsState, state: Omit<RolloutSettingsState, 'revision'>, revision: number) => void
}

/**
 * Declares the rollout settings state and write surface.
 * @returns the store handle.
 */
export function createRolloutSettingsStore(): EngineStoreHandle<RolloutSettingsState, RolloutSettingsActions> {
  return defineStore({
    init: (): RolloutSettingsState => ({
      enabled: false,
      rolloutCount: 3,
      judgeModel: 'claude-opus-5',
      judgeBaseURL: '',
      workerModels: [],
      autoMilestone: false,
      revision: -1,
    }),
    actions: {
      sync: (draft, state, revision) => {
        if (revision <= draft.revision) return
        draft.enabled = state.enabled
        draft.rolloutCount = state.rolloutCount
        draft.judgeModel = state.judgeModel
        draft.judgeBaseURL = state.judgeBaseURL
        draft.workerModels = state.workerModels
        draft.autoMilestone = state.autoMilestone
        draft.revision = revision
      },
    },
  })
}

/** Defaults matching the host plugin's composition entry. */
export const ROLLOUT_DEFAULTS: Omit<RolloutSettingsState, 'revision'> = {
  enabled: false,
  rolloutCount: 3,
  judgeModel: 'claude-opus-5',
  judgeBaseURL: '',
  workerModels: [],
  autoMilestone: false,
}
