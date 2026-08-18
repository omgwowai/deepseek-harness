/**
 * SOTA judge: call the tokenrouter gateway (OpenAI-compatible) with the task
 * and candidate plans, and parse a strict-JSON scorecard. The judge only
 * reviews — it never generates the plans — so SOTA token usage stays bounded
 * to one call per rollout round.
 *
 * @module @deepseek-ai/dsh-tokenrouter-rollout/judge
 */

import type { ResolvedConfig } from './config.ts'
import type { RolloutSelectedEventData } from './types.ts'

/** A judge verdict over one round. */
export interface JudgeVerdict {
  /** Per-trajectory scores. */
  scores: { index: number; score: number; reasoning?: string }[]
  /** Winning trajectory index. */
  best: number
  /** Judge model that produced the verdict. */
  judgeModel: string
  /** Judge output tokens reported by the gateway, when available. */
  judgeOutputTokens?: number
}

/** Judge failure (typed so selection can fall back). */
export class JudgeError extends Error {
  constructor(
    message: string,
    readonly code: 'TIMEOUT' | 'HTTP' | 'PARSE' | 'SHAPE' | 'NO_KEY',
  ) {
    super(message)
    this.name = 'JudgeError'
  }
}

const DEFAULT_SYSTEM = 'You are a senior engineering evaluator. Given a task and candidate '
  + 'plans, score each plan 0-100 on completeness, feasibility, cost, and risk. '
  + 'Respond with STRICT JSON only, no markdown fences, exactly this shape: '
  + '{"scores":[{"index":0,"score":85,"reasoning":"..."}],"best":0,"summary":"..."}'

/** A retry uses a more forceful instruction so a second pass usually yields JSON. */
const RETRY_SYSTEM_SUFFIX = '\n\nIMPORTANT: Your previous response was not valid JSON. '
  + 'Reply with ONLY a JSON object — no prose, no fences, no commentary before or after.'

/** Strip a surrounding ```json fence if the gateway wrapped the JSON. */
function stripFence(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)
  return fenced === null ? trimmed : fenced[1] ?? trimmed
}

function parseScorecard(text: string): { scores: { index: number; score: number; reasoning?: string }[]; best: number } {
  const raw = JSON.parse(stripFence(text)) as unknown
  if (typeof raw !== 'object' || raw === null) throw new JudgeError('scorecard is not an object', 'SHAPE')
  const card = raw as Record<string, unknown>
  if (!Array.isArray(card.scores)) throw new JudgeError('scorecard has no scores array', 'SHAPE')
  if (typeof card.best !== 'number') throw new JudgeError('scorecard has no numeric best', 'SHAPE')
  const scores = card.scores.map((entry, position) => {
    if (typeof entry !== 'object' || entry === null) throw new JudgeError(`scores[${position}] is not an object`, 'SHAPE')
    const row = entry as Record<string, unknown>
    if (typeof row.index !== 'number' || typeof row.score !== 'number') {
      throw new JudgeError(`scores[${position}] lacks numeric index/score`, 'SHAPE')
    }
    return {
      index: row.index,
      score: row.score,
      ...typeof row.reasoning === 'string' ? { reasoning: row.reasoning } : {},
    }
  })
  return { scores, best: card.best }
}

/**
 * One raw judge call: POST the scorecard prompt and parse the response.
 * @param config - plugin config (judge endpoint/model/timeout).
 * @param apiKey - resolved judge API key.
 * @param task - the decision context (task or milestone summary).
 * @param candidates - candidate plans with their indexes.
 * @param systemPrompt - the system prompt for this attempt.
 * @param signal - cancellation signal from the triggering context.
 */
async function callJudgeOnce(
  config: ResolvedConfig,
  apiKey: string,
  task: string,
  candidates: { index: number; plan: string }[],
  systemPrompt: string,
  signal: AbortSignal,
): Promise<{ scorecard: { scores: { index: number; score: number; reasoning?: string }[]; best: number }; completionTokens?: number }> {
  const user = JSON.stringify({ task, candidates }, null, 2)
  const timeout = AbortSignal.timeout(config.judgeTimeoutMs)
  const fused = AbortSignal.any([signal, timeout])

  let res: Response
  try {
    res = await fetch(`${config.judgeBaseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: config.judgeModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: user },
        ],
        max_tokens: 4000,
      }),
      signal: fused,
    })
  } catch (error: unknown) {
    if (signal.aborted) throw error
    const reason = error instanceof Error && error.name === 'TimeoutError'
      ? `judge timed out after ${config.judgeTimeoutMs}ms`
      : `judge fetch failed: ${error instanceof Error ? error.message : String(error)}`
    throw new JudgeError(reason, error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'HTTP')
  }

  if (!res.ok) {
    throw new JudgeError(`judge HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, 'HTTP')
  }

  const body = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
    usage?: { completion_tokens?: number }
  }
  const content = body.choices?.[0]?.message?.content
  if (content === undefined) throw new JudgeError('judge returned no content', 'SHAPE')

  let scorecard: { scores: { index: number; score: number; reasoning?: string }[]; best: number }
  try {
    scorecard = parseScorecard(content)
  } catch (error: unknown) {
    if (error instanceof JudgeError) throw error
    throw new JudgeError(`judge JSON parse failed: ${error instanceof Error ? error.message : String(error)}`, 'PARSE')
  }

  if (scorecard.scores.length === 0) throw new JudgeError('judge returned empty scores', 'SHAPE')
  const bestInScores = scorecard.scores.some(s => s.index === scorecard.best)
  if (!bestInScores) {
    // The judge's `best` should match a scored index; when it does not, prefer
    // the highest-scored index and record it (shape repair, not silent data loss).
    const winner = scorecard.scores.reduce((a, b) => (b.score > a.score ? b : a))
    scorecard = { ...scorecard, best: winner.index }
  }

  return {
    scorecard,
    ...body.usage?.completion_tokens === undefined ? {} : { completionTokens: body.usage.completion_tokens },
  }
}

/**
 * Judge one rollout round. One retry with a more forceful prompt on the
 * first failure; when both attempts fail the error propagates to the caller,
 * which falls back to a deterministic selection.
 * @param config - plugin config (judge endpoint/model/timeout).
 * @param task - the decision context (task or milestone summary).
 * @param plans - candidate plans, parallel to trajectory indexes.
 * @param signal - cancellation signal from the triggering context.
 * @returns the scorecard the judge returned, keyed to the `plans` indexes.
 */
export async function judge(
  config: ResolvedConfig,
  task: string,
  plans: readonly string[],
  signal: AbortSignal,
): Promise<JudgeVerdict> {
  const apiKey = process.env[config.judgeApiKeyEnv]
  if (apiKey === undefined || apiKey === '') {
    throw new JudgeError(`no API key in env "${config.judgeApiKeyEnv}"`, 'NO_KEY')
  }

  const candidates = plans.map((plan, index) => ({ index, plan }))
  const baseSystem = config.judgeSystemPrompt ?? DEFAULT_SYSTEM

  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    const system = attempt === 0 ? baseSystem : `${baseSystem}${RETRY_SYSTEM_SUFFIX}`
    try {
      const { scorecard, completionTokens } = await callJudgeOnce(
        config, apiKey, task, candidates, system, signal,
      )
      return {
        scores: scorecard.scores,
        best: scorecard.best,
        judgeModel: config.judgeModel,
        ...completionTokens === undefined ? {} : { judgeOutputTokens: completionTokens },
      }
    } catch (error: unknown) {
      lastError = error
      if (signal.aborted) throw error
    }
  }
  throw lastError
}

/**
 * Build the durable `rollout/selected` payload from a verdict.
 * @param verdict - the judge's settled scorecard for one round.
 * @returns the event payload, omitting judge tokens the provider did not report.
 */
export function selectedEventData(verdict: JudgeVerdict): RolloutSelectedEventData {
  return {
    best: verdict.best,
    judgeModel: verdict.judgeModel,
    scores: verdict.scores,
    ...verdict.judgeOutputTokens === undefined ? {} : { judgeOutputTokens: verdict.judgeOutputTokens },
  }
}
