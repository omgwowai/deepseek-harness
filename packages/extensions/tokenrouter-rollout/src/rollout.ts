/**
 * Rollout orchestration: spawn N parallel worker subagents (each with its own
 * diversity slot), collect their plans, and hand them to the judge. Workers
 * use the cheap model dsh already chose; the judge (SOTA) only reviews.
 *
 * @module @deepseek-ai/dsh-tokenrouter-rollout/rollout
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from './config.ts'
import { resolveTrajectories, withStrategy, type TrajectorySpec } from './diversity.ts'
import { judge, JudgeError, type JudgeVerdict } from './judge.ts'

/** One trajectory's settled outcome. */
export interface TrajectoryOutcome {
  /** Index in the round. */
  index: number
  /** Trajectory spec used. */
  spec: TrajectorySpec
  /** Whether the worker produced a usable plan. */
  ok: boolean
  /**
   * The worker's plan text when `ok`, or its failure detail otherwise. A
   * failure detail is diagnostic only: it never reaches the judge or the
   * selected plan, both of which read `ok` outcomes exclusively.
   */
  text: string
  /** Short summary line (first heading or first line). */
  summary: string
  /** Worker output tokens summed over the child session's reported usage. */
  outputTokens?: number
}

/** The full result of one rollout round. */
export interface RolloutResult {
  /** All trajectory outcomes, in index order. */
  trajectories: TrajectoryOutcome[]
  /** The judge verdict, when selection succeeded. */
  verdict: JudgeVerdict | undefined
  /** The winning plan text (verdict present), or fallback pick. */
  selectedPlan: string | undefined
  /** Reason when the round failed before selection. */
  error: string | undefined
}

const WORKER_PROMPT = `You are one of several parallel planning agents working on the same
decision. Produce a COMPLETE, self-contained plan for the decision below, as
markdown starting with a "# " heading that names the plan. Do not ask for
clarification; make reasonable assumptions and state them. End with a short
"## Rationale" section explaining the key trade-offs you chose.

DECISION CONTEXT:
{context}`

function firstLine(text: string): string {
  const line = text.split('\n').find(l => l.trim() !== '')
  return (line ?? '').slice(0, 120)
}

function firstHeading(text: string): string {
  for (const line of text.split('\n')) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line.trim())
    if (match !== null) return (match[1] ?? '').slice(0, 120)
  }
  return firstLine(text)
}

function blocksToText(blocks: readonly ContentBlock[]): string {
  // Reasoning blocks carry the model's chain of thought, not the plan;
  // the deliverable is the text blocks only.
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/** Shorten a plan for judge input while keeping its structure. */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n[TRUNCATED]`
}

/**
 * Provider-reported output tokens the child spent, summed across its assistant
 * messages. A remote run exposes no local session, and an adapter may report
 * no usage at all, so the figure is absent rather than zero when unknown —
 * `rolloutStats` must not read a missing measurement as a free trajectory.
 */
function childOutputTokens(run: SubagentRun): number | undefined {
  const child = run.localAgent
  if (child === undefined) return undefined
  let total: number | undefined
  for (const event of child.session.events) {
    if (event.type !== 'assistant/message') continue
    const reported = event.data.usage?.outputTokens
    if (reported === undefined) continue
    total = (total ?? 0) + reported
  }
  return total
}

/**
 * Run one worker subagent and return its settled outcome. Failures (timeout,
 * rejection, infrastructure) become `ok: false` outcomes — the round continues.
 */
async function runWorker(
  ctx: Context,
  parent: Agent,
  index: number,
  spec: TrajectorySpec,
  context: string,
  config: ResolvedConfig,
  signal: AbortSignal,
): Promise<TrajectoryOutcome> {
  const timeout = AbortSignal.timeout(config.workerTimeoutMs)
  const fused = AbortSignal.any([signal, timeout])
  const prompt = withStrategy(WORKER_PROMPT.replace('{context}', truncate(context, config.maxContextChars)), spec.slot)
  let run: SubagentRun | undefined
  try {
    run = await ctx.subagents.start(config.workerSubagentProvider, {
      label: `rollout-${index}`,
      prompt: [{ type: 'text', text: prompt }],
      parent,
      signal: fused,
      agentOptions: {
        provider: config.workerProvider,
        model: spec.model,
      },
    })
    const result = await run.result
    const tokens = childOutputTokens(run)
    const text = blocksToText(result.output).trim()
    const ok = result.stopReason === 'completed' && text !== ''
    return {
      index,
      spec,
      ok,
      text: ok ? text : (text === '' ? `worker ${index} ended with ${result.stopReason}` : text),
      summary: ok ? firstHeading(text) : `failed (${result.stopReason})`,
      ...tokens === undefined ? {} : { outputTokens: tokens },
    }
  } catch (error: unknown) {
    const reason = signal.aborted
      ? 'cancelled'
      : error instanceof Error && error.name === 'TimeoutError'
        ? `timed out after ${config.workerTimeoutMs}ms`
        : `error: ${error instanceof Error ? error.message : String(error)}`
    return { index, spec, ok: false, text: reason, summary: `failed (${reason})` }
  } finally {
    // `start` publishes the child before `result` settles, so a rejected or
    // aborted result still leaves a run whose child must reach quiescence.
    if (run !== undefined) await run.dispose()
  }
}

/**
 * Restate a verdict over the judge's dense candidate numbering in round
 * indexes. The judge sees only usable plans, so its `index: 1` is the second
 * SURVIVOR, which is the round's trajectory #2 when #1 failed. A score whose
 * position names no candidate is dropped: it can only come from a judge that
 * invented an index, and keeping it would attribute a score to a trajectory
 * that was never shown.
 */
function remapToRoundIndexes(verdict: JudgeVerdict, candidates: readonly TrajectoryOutcome[]): JudgeVerdict {
  const roundIndex = (position: number): number | undefined => candidates[position]?.index
  const scores = verdict.scores
    .map(score => ({ ...score, index: roundIndex(score.index) }))
    .filter((score): score is typeof score & { index: number } => score.index !== undefined)
  return {
    ...verdict,
    scores,
    // A `best` outside the candidate list means the judge named a plan it was
    // not given; the highest surviving score is the honest reading, and an
    // empty score list falls back to the first candidate that did run.
    best: roundIndex(verdict.best)
      ?? (scores.length > 0
        ? scores.reduce((a, b) => (b.score > a.score ? b : a)).index
        // oxlint-disable-next-line typescript/no-non-null-assertion -- only reached with candidates.length > 0
        : candidates[0]!.index),
  }
}

/** Pick the best trajectory without a judge (fallback heuristic). */
function fallbackPick(trajectories: TrajectoryOutcome[]): TrajectoryOutcome | undefined {
  const ok = trajectories.filter(t => t.ok)
  if (ok.length === 0) return undefined
  // Prefer longer plans (proxy for completeness) with a tie-break on index.
  return ok.reduce((a, b) => (b.text.length > a.text.length ? b : a))
}

/**
 * Run one rollout round end to end: spawn workers in parallel, judge the
 * plans, select the winner, and return everything the caller needs to
 * persist (events) and deliver (plan).
 * @param ctx - a context with `subagents`, used to spawn the worker runs.
 * @param parent - the triggering agent; supplies the fallback worker model.
 * @param decision - the decision context workers plan against and the judge scores.
 * @param config - the round's resolved settings (counts, routes, timeouts, caps).
 * @param signal - cancellation for the whole round, workers and judge alike.
 * @returns the settled round; `error` is set instead of `verdict` when selection did not happen.
 */
export async function runRollout(
  ctx: Context,
  parent: Agent,
  decision: string,
  config: ResolvedConfig,
  signal: AbortSignal,
): Promise<RolloutResult> {
  const specs = resolveTrajectories(
    config.rolloutCount,
    config.diversitySlots,
    config.workerModels,
    parent.options.model ?? '',
  )
  const outcomes = await Promise.all(specs.map((spec, index) =>
    runWorker(ctx, parent, index, spec, decision, config, signal),
  ))

  // A failed worker's text is its failure detail, not a plan. Judging only the
  // usable ones keeps an error string from being scored and selected as the
  // working decision; `candidates` maps the judge's dense 0..n-1 numbering back
  // to round indexes so `rollout/selected` and the trajectory log stay aligned.
  const candidates = outcomes.filter(o => o.ok)
  let verdict: JudgeVerdict | undefined
  let error: string | undefined
  if (candidates.length > 0) {
    try {
      const scored = await judge(
        config,
        decision,
        candidates.map(o => truncate(o.text, config.maxPlanChars)),
        signal,
      )
      verdict = remapToRoundIndexes(scored, candidates)
    } catch (judgeError: unknown) {
      if (judgeError instanceof JudgeError) error = judgeError.message
      else error = `judge failed: ${judgeError instanceof Error ? judgeError.message : String(judgeError)}`
    }
  } else {
    error = 'all workers failed; nothing to judge'
  }

  let selectedPlan: string | undefined
  if (verdict !== undefined) {
    const winner = candidates.find(o => o.index === verdict.best) ?? fallbackPick(outcomes)
    selectedPlan = winner?.text
  } else {
    const fallback = fallbackPick(outcomes)
    if (fallback !== undefined) selectedPlan = fallback.text
    else if (error === undefined) error = 'no usable plan'
  }

  return { trajectories: outcomes, verdict, selectedPlan, error }
}
