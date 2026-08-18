/**
 * Unit tests for the tokenrouter-rollout projection fold, diversity
 * resolution, and judge scorecard parsing. Pure-function tests: no cordis
 * machinery needed for the fold itself.
 */

import { describe, expect, it } from 'vitest'
import { foldRolloutStats } from '@deepseek-ai/dsh-tokenrouter-rollout/src/stats.ts'
import { resolveTrajectories } from '@deepseek-ai/dsh-tokenrouter-rollout/src/diversity.ts'
import { JudgeError, judge } from '@deepseek-ai/dsh-tokenrouter-rollout/src/judge.ts'
import { runRollout } from '@deepseek-ai/dsh-tokenrouter-rollout/src/rollout.ts'
import { resolveConfig } from '@deepseek-ai/dsh-tokenrouter-rollout/src/config.ts'
import type { ResolvedConfig } from '@deepseek-ai/dsh-tokenrouter-rollout/src/config.ts'
import type { RolloutStatsProjection } from '@deepseek-ai/dsh-tokenrouter-rollout/types'

/** The initial projection value (the view of the empty state). */
function empty(): RolloutStatsProjection {
  return {
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
}

describe('rolloutStats fold', () => {
  it('starts empty and stays empty for unrelated events', () => {
    const state = { ...empty(), winnerScores: [] as number[] }
    const same = foldRolloutStats(state, { type: 'user/message', data: {} })
    expect(same).toBe(state)
  })

  it('counts a manual round start', () => {
    const state = { ...empty(), winnerScores: [] as number[] }
    const next = foldRolloutStats(state, {
      type: 'rollout/start',
      data: { trigger: 'manual', decision: 'd', count: 3 },
    })
    expect(next.rollouts).toBe(1)
    expect(next.manualRounds).toBe(1)
    expect(next.milestoneRounds).toBe(0)
  })

  it('counts a milestone round start', () => {
    const state = { ...empty(), winnerScores: [] as number[] }
    const next = foldRolloutStats(state, {
      type: 'rollout/start',
      data: { trigger: 'milestone', decision: 'd', count: 3 },
    })
    expect(next.milestoneRounds).toBe(1)
  })

  it('tracks trajectories and worker tokens', () => {
    let state = { ...empty(), winnerScores: [] as number[] }
    state = foldRolloutStats(state, {
      type: 'rollout/trajectory',
      data: { index: 0, ok: true, outputTokens: 120 },
    })
    state = foldRolloutStats(state, {
      type: 'rollout/trajectory',
      data: { index: 1, ok: false },
    })
    expect(state.trajectories).toBe(2)
    expect(state.okTrajectories).toBe(1)
    expect(state.workerOutputTokens).toBe(120)
  })

  it('folds selection into averages and judge tokens', () => {
    let state = { ...empty(), winnerScores: [] as number[] }
    state = foldRolloutStats(state, {
      type: 'rollout/selected',
      data: { best: 1, judgeModel: 'claude-opus-5', scores: [{ index: 0, score: 60 }, { index: 1, score: 90 }], judgeOutputTokens: 500 },
    })
    expect(state.selectedRounds).toBe(1)
    expect(state.judgeOutputTokens).toBe(500)
    expect(state.averageWinnerScore).toBe(90)
    state = foldRolloutStats(state, {
      type: 'rollout/selected',
      data: { best: 0, judgeModel: 'claude-opus-5', scores: [{ index: 0, score: 70 }, { index: 1, score: 30 }] },
    })
    expect(state.averageWinnerScore).toBe(80)
  })

  it('counts failed rounds', () => {
    const state = { ...empty(), winnerScores: [] as number[] }
    const next = foldRolloutStats(state, { type: 'rollout/error', data: { trigger: 'manual', reason: 'x' } })
    expect(next.failedRounds).toBe(1)
  })
})

describe('resolveTrajectories', () => {
  const slots = [
    { label: 'a', strategy: 'be conservative' },
    { label: 'b', strategy: 'be thorough' },
    { label: 'c', strategy: 'be creative' },
  ]

  it('cycles slots and models', () => {
    const specs = resolveTrajectories(3, slots, ['m1', 'm2'], 'fallback')
    expect(specs.map(s => s.slot.label)).toEqual(['a', 'b', 'c'])
    expect(specs.map(s => s.model)).toEqual(['m1', 'm2', 'm1'])
  })

  it('falls back to the agent model when the pool is empty', () => {
    const specs = resolveTrajectories(2, slots, [], 'deepseek-v4-flash')
    expect(specs.map(s => s.model)).toEqual(['deepseek-v4-flash', 'deepseek-v4-flash'])
  })

  it('falls back to a default slot when none are configured', () => {
    const specs = resolveTrajectories(2, [], [], 'm')
    expect(specs.every(s => s.slot.label === 'default')).toBe(true)
  })
})

describe('runRollout selection', () => {
  /**
   * A subagents double: each worker's outcome is scripted by index, and every
   * `dispose` is recorded so the disposal contract is observable.
   */
  function subagentsDouble(outcomes: readonly ({ text: string } | { fail: string })[]) {
    const disposed: number[] = []
    let next = 0
    const subagents = {
      start(_provider: string, request: { label: string }) {
        const index = next++
        const scripted = outcomes[index]
        if (scripted === undefined) throw new Error(`no scripted outcome for ${request.label}`)
        if ('fail' in scripted) {
          return Promise.resolve({
            id: request.label,
            localAgent: undefined,
            result: Promise.reject(new Error(scripted.fail)),
            dispose: () => { disposed.push(index); return Promise.resolve() },
          })
        }
        return Promise.resolve({
          id: request.label,
          localAgent: {
            session: {
              events: [{
                type: 'assistant/message',
                data: { message: { content: [] }, usage: { outputTokens: 10 * (index + 1) } },
              }],
            },
          },
          result: Promise.resolve({
            output: [{ type: 'text', text: scripted.text }],
            stopReason: 'completed',
          }),
          dispose: () => { disposed.push(index); return Promise.resolve() },
        })
      },
    }
    return { disposed, ctx: { subagents } }
  }

  const parent = { options: { model: 'worker-model' } }

  /** Config whose judge points at a scripted server; workers are the double's. */
  function config(judgeBaseURL: string, count: number): ResolvedConfig {
    return resolveConfig({
      enabled: true,
      judgeBaseURL,
      judgeApiKeyEnv: 'TR_ROLLOUT_TEST_KEY',
      judgeModel: 'judge-x',
      rolloutCount: count,
      judgeTimeoutMs: 5000,
      workerTimeoutMs: 5000,
    })
  }

  it('hides failed workers from the judge and reports winners in round indexes', async () => {
    // Worker 0 fails. The judge therefore sees ONE candidate at its index 0,
    // which is round trajectory #1 — a verdict left unmapped would name the
    // failed worker and publish its error text as the working decision.
    let seenPlans: string[] = []
    const server = await startJudgeServer((_req, body) => {
      seenPlans = body.messages.map(m => m.content)
      return {
        choices: [{ message: { content: '{"scores":[{"index":0,"score":91}],"best":0}' } }],
        usage: { completion_tokens: 7 },
      }
    })
    process.env.TR_ROLLOUT_TEST_KEY = 'test-key'
    try {
      const { ctx, disposed } = subagentsDouble([{ fail: 'worker blew up' }, { text: '# Real plan' }])
      const result = await runRollout(
        ctx as never,
        parent as never,
        'ship the thing',
        config(server.url, 2),
        new AbortController().signal,
      )
      expect(seenPlans.join('\n')).not.toContain('worker blew up')
      expect(result.selectedPlan).toBe('# Real plan')
      expect(result.verdict?.best).toBe(1)
      expect(result.verdict?.scores).toEqual([{ index: 1, score: 91 }])
      // Both runs reach quiescence, including the one whose result rejected.
      expect(disposed.toSorted()).toEqual([0, 1])
    } finally {
      await server.close()
      delete process.env.TR_ROLLOUT_TEST_KEY
    }
  })

  it('records the child session output tokens per trajectory', async () => {
    const server = await startJudgeServer(() => ({
      choices: [{ message: { content: '{"scores":[{"index":0,"score":50}],"best":0}' } }],
    }))
    process.env.TR_ROLLOUT_TEST_KEY = 'test-key'
    try {
      const { ctx } = subagentsDouble([{ text: '# Plan' }])
      const result = await runRollout(
        ctx as never,
        parent as never,
        'decide',
        config(server.url, 1),
        new AbortController().signal,
      )
      expect(result.trajectories[0]?.outputTokens).toBe(10)
    } finally {
      await server.close()
      delete process.env.TR_ROLLOUT_TEST_KEY
    }
  })

  it('reports an error instead of judging when every worker failed', async () => {
    const { ctx, disposed } = subagentsDouble([{ fail: 'a' }, { fail: 'b' }])
    const result = await runRollout(
      ctx as never,
      parent as never,
      'decide',
      config('http://judge.invalid/v1', 2),
      new AbortController().signal,
    )
    expect(result.verdict).toBeUndefined()
    expect(result.selectedPlan).toBeUndefined()
    expect(result.error).toBe('all workers failed; nothing to judge')
    expect(disposed.toSorted()).toEqual([0, 1])
  })
})

describe('resolveConfig', () => {
  it('demands a judge endpoint once enabled', () => {
    expect(() => resolveConfig({ enabled: true })).toThrow(/judgeBaseURL is required/)
    expect(resolveConfig({ enabled: false }).judgeBaseURL).toBe('')
  })

  it('rejects an unknown key', () => {
    expect(() => resolveConfig({ temperature: 0.4 } as never)).toThrow(/unknown config key/)
  })
})

describe('judge scorecard parsing', () => {
  it('accepts fenced JSON', async () => {
    // Exercise the fence stripping via a tiny local server.
    const server = await startJudgeServer((_req, body) => {
      expect(body.model).toBe('judge-x')
      return {
        choices: [{ message: { content: '```json\n{"scores":[{"index":0,"score":80,"reasoning":"ok"}],"best":0}\n```' } }],
        usage: { completion_tokens: 42 },
      }
    })
    try {
      const config = {
        judgeBaseURL: server.url,
        judgeApiKeyEnv: 'TR_ROLLOUT_TEST_KEY',
        judgeModel: 'judge-x',
        judgeTimeoutMs: 5000,
      } as Parameters<typeof judge>[0]
      process.env.TR_ROLLOUT_TEST_KEY = 'test-key'
      const verdict = await judge(config, 'task', ['plan A'], new AbortController().signal)
      expect(verdict.best).toBe(0)
      expect(verdict.scores[0]?.score).toBe(80)
      expect(verdict.judgeOutputTokens).toBe(42)
    } finally {
      await server.close()
      delete process.env.TR_ROLLOUT_TEST_KEY
    }
  })

  it('throws a typed error on non-JSON output', async () => {
    const server = await startJudgeServer(() => ({
      choices: [{ message: { content: 'sorry, no json here' } }],
    }))
    try {
      const config = {
        judgeBaseURL: server.url,
        judgeApiKeyEnv: 'TR_ROLLOUT_TEST_KEY',
        judgeModel: 'judge-x',
        judgeTimeoutMs: 5000,
      } as Parameters<typeof judge>[0]
      process.env.TR_ROLLOUT_TEST_KEY = 'test-key'
      await expect(judge(config, 'task', ['plan A'], new AbortController().signal))
        .rejects.toThrow(JudgeError)
    } finally {
      await server.close()
      delete process.env.TR_ROLLOUT_TEST_KEY
    }
  })

  it('throws NO_KEY without the environment key', async () => {
    const config = {
      judgeBaseURL: 'http://x',
      judgeApiKeyEnv: 'TR_ROLLOUT_TEST_KEY',
      judgeModel: 'judge-x',
      judgeTimeoutMs: 5000,
    } as Parameters<typeof judge>[0]
    delete process.env.TR_ROLLOUT_TEST_KEY
    await expect(judge(config, 'task', ['plan A'], new AbortController().signal))
      .rejects.toMatchObject({ code: 'NO_KEY' })
  })
})

/** The judge request fields a scripted handler inspects. */
interface JudgeRequestBody {
  model: string
  messages: { role: string; content: string }[]
}

/** Tiny in-process HTTP server returning scripted judge responses. */
async function startJudgeServer(
  handler: (req: Request, body: JudgeRequestBody) => unknown,
): Promise<{ url: string; close(): Promise<void> }> {
  const { default: http } = await import('node:http')
  const server = http.createServer((req, res) => {
    void (async () => {
      let raw = ''
      for await (const chunk of req) raw += String(chunk)
      const body = JSON.parse(raw) as JudgeRequestBody
      const payload = handler(req as unknown as Request, body)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err === null || err === undefined) resolve()
        else reject(err)
      })
    }),
  }
}
