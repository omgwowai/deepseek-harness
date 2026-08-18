/**
 * Diversity slot resolution: map each trajectory index to a worker model and a
 * strategy suffix.
 *
 * @module @deepseek-ai/dsh-tokenrouter-rollout/diversity
 */

import type { DiversitySlot } from './config.ts'

/** One trajectory's resolved worker route and planning posture. */
export interface TrajectorySpec {
  /** Diversity slot (label, strategy). */
  slot: DiversitySlot
  /** Model id for this trajectory. */
  model: string
}

/**
 * Resolve `count` trajectory specs: each gets a diversity slot (cycling the
 * configured list) and a model (cycling `workerModels`, or `fallbackModel`
 * when the pool is empty).
 * @param count - number of trajectories.
 * @param slots - configured diversity slots (may be empty).
 * @param workerModels - configured worker model pool (may be empty).
 * @param fallbackModel - the triggering agent's model, used when the pool is empty.
 * @returns exactly `count` specs, in trajectory-index order.
 */
export function resolveTrajectories(
  count: number,
  slots: readonly DiversitySlot[],
  workerModels: readonly string[],
  fallbackModel: string,
): TrajectorySpec[] {
  const specs: TrajectorySpec[] = []
  for (let index = 0; index < count; index++) {
    const slot: DiversitySlot = slots.length > 0
      ? (slots[index % slots.length] ?? { label: 'default' })
      : { label: 'default' }
    const model = workerModels.length > 0
      ? (workerModels[index % workerModels.length] ?? fallbackModel)
      : fallbackModel
    specs.push({ slot, model })
  }
  return specs
}

/**
 * Append the slot's strategy guidance to a worker prompt, when present.
 * @param prompt - the worker prompt built from the decision context.
 * @param slot - the trajectory's diversity slot.
 * @returns the prompt, unchanged when the slot carries no strategy.
 */
export function withStrategy(prompt: string, slot: DiversitySlot): string {
  if (slot.strategy === undefined || slot.strategy === '') return prompt
  return `${prompt}\n\nSTRATEGY GUIDANCE: ${slot.strategy}`
}
