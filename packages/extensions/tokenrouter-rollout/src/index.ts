/**
 * Tokenrouter rollout: at plan-drafting and milestone boundaries, run N
 * parallel diverse trajectories on the cheap worker model (the deepseek route
 * dsh already chose), then let a SOTA judge model on the tokenrouter gateway
 * pick the best plan. The winning plan is injected back into the agent's
 * session as the decision that guides the next milestone.
 *
 * Disabled by default (`enabled: false`); the settings section lets a user
 * flip the switch and tune the round.
 *
 * @module @deepseek-ai/dsh-tokenrouter-rollout
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subagent'
import { DEFAULT_DIVERSITY_SLOTS, resolveConfig } from './config.ts'
import type { Config, ResolvedConfig } from './config.ts'
import { runRollout, type RolloutResult } from './rollout.ts'
import { selectedEventData } from './judge.ts'
import { rolloutStatsProjectionDefinition } from './stats.ts'
import type { RolloutTrigger } from './types.ts'

export type * from './types.ts'
export { DEFAULT_DIVERSITY_SLOTS, resolveConfig } from './config.ts'
export type {
  Config as TokenRouterRolloutConfig,
  DiversitySlot,
  ResolvedConfig as ResolvedTokenRouterRolloutConfig,
} from './config.ts'
export { runRollout } from './rollout.ts'
export type { RolloutResult, TrajectoryOutcome } from './rollout.ts'
export { judge, JudgeError } from './judge.ts'
export type { JudgeVerdict } from './judge.ts'
export { rolloutStatsProjectionDefinition, foldRolloutStats } from './stats.ts'

const NS = settingsNamespace('tokenrouter-rollout')

/** Settings section shape: a strict subset of the plugin config a user owns. */
export interface TokenRouterRolloutSettings {
  enabled: boolean
  rolloutCount: number
  judgeModel: string
  /**
   * Judge endpoint, user-owned because enabling rollout is a settings action
   * and the shipped composition carries no endpoint. Empty while unset; a
   * round refuses to start rather than calling nowhere.
   */
  judgeBaseURL: string
  workerModels: string[]
  autoMilestone: boolean
}

/** Schemastery schema of the settings section. */
export const TOKEN_ROUTER_ROLLOUT_SETTINGS_SCHEMA: z<TokenRouterRolloutSettings> = z.object({
  enabled: z.boolean().default(false),
  rolloutCount: z.number().step(1).min(1).max(8).default(3),
  judgeModel: z.string().default('claude-opus-5'),
  judgeBaseURL: z.string().default(''),
  workerModels: z.array(z.string()).default([]),
  autoMilestone: z.boolean().default(false),
})

/** Narration injected with the selected plan. */
function narrationFor(trigger: RolloutTrigger, result: RolloutResult): string {
  const winner = result.verdict
  if (winner === undefined) {
    return `[rollout] The rollout round (${trigger}) failed before selection: ${result.error ?? 'unknown'}. Proceeding without a rolled-out plan.`
  }
  const scoreLine = winner.scores.map(s => `#${s.index}: ${s.score}`).join(', ')
  const bestSummary = result.trajectories[winner.best]?.summary ?? `trajectory ${winner.best}`
  return `[rollout] ${result.trajectories.length} diverse trajectories were rolled out in parallel (${trigger} trigger) and the judge model ${winner.judgeModel} scored them (${scoreLine}). Selected trajectory #${winner.best} — "${bestSummary}". The selected plan follows; treat it as the working decision.`
}

/**
 * Persist a finished round's events on the session and deliver the winning
 * plan to the agent.
 *
 * Delivery is `steer`, not `inject`. A round outlives the turn that asked for
 * it — workers and the judge take minutes — so by the time a plan exists the
 * driver is usually idle, and injected context waits for a later wake that
 * nothing in this plugin produces. Steering opens a turn on an idle driver and
 * is consumed at the nearest step boundary on a running one, which is the
 * delivery both triggers need.
 */
function publishRound(
  agent: Agent,
  trigger: RolloutTrigger,
  decision: string,
  result: RolloutResult,
  workerProvider: string,
): void {
  const session = agent.session
  session.append('rollout/start', {
    trigger,
    decision: decision.slice(0, 300),
    count: result.trajectories.length,
  })
  for (const trajectory of result.trajectories) {
    session.append('rollout/trajectory', {
      index: trajectory.index,
      provider: workerProvider,
      model: trajectory.spec.model,
      slot: trajectory.spec.slot.label,
      summary: trajectory.summary,
      ok: trajectory.ok,
      ...trajectory.outputTokens === undefined ? {} : { outputTokens: trajectory.outputTokens },
    })
  }
  if (result.verdict !== undefined) {
    session.append('rollout/selected', selectedEventData(result.verdict))
  } else if (result.error !== undefined) {
    session.append('rollout/error', { trigger, reason: result.error.slice(0, 500) })
  }
  if (result.selectedPlan !== undefined) {
    agent.steer(createUserMessage({
      content: [
        { type: 'text', text: narrationFor(trigger, result) },
        { type: 'text', text: `\n\n## Selected plan\n\n${result.selectedPlan}` },
      ],
      source: { kind: 'user' },
    }))
  }
}

/**
 * The rollout controller: owns the round lifetime, the /rollout command, the
 * milestone watcher, and the settings wiring.
 */
export class TokenRouterRollout extends Service {
  static inject = ['agents', 'subagents']

  /**
   * Loader-time schema for this plugin's composition entry. Declared inline so
   * the config catalog can walk it; `judgeBaseURL` carries no default because
   * the judge endpoint belongs to the deployment (see {@link resolveConfig}).
   */
  static Config: z<Config> = z.object({
    enabled: z.boolean().default(false),
    rolloutCount: z.number().step(1).min(1).max(8).default(3),
    judgeModel: z.string().default('claude-opus-5'),
    judgeBaseURL: z.string(),
    judgeApiKeyEnv: z.string().default('DEEPSEEK_API_KEY'),
    workerProvider: z.string().default('deepseek-official'),
    workerSubagentProvider: z.string().default('fork'),
    workerModels: z.array(z.string()).default([]),
    diversitySlots: z.array(z.object({
      label: z.string().required(),
      strategy: z.string(),
    })).default(DEFAULT_DIVERSITY_SLOTS as never),
    workerTimeoutMs: z.number().step(1).min(1000).default(600_000),
    judgeTimeoutMs: z.number().step(1).min(1000).default(180_000),
    maxPlanChars: z.number().step(1).min(500).default(12_000),
    autoMilestone: z.boolean().default(false),
    maxContextChars: z.number().step(1).min(200).default(4_000),
    judgeSystemPrompt: z.string(),
  })

  /** Effective config with the live settings section folded in. */
  private liveConfig: ResolvedConfig
  private disposed = false
  /**
   * Cancellation for every detached round, owned by the plugin rather than by
   * whatever asked for one. A round outlives its trigger — the command handler
   * returns as soon as workers are spawned, and the UI request's signal aborts
   * when that response closes — so binding rounds to the trigger's signal
   * cancels them the moment they start. Disposal is the one thing that must
   * still cancel them, which is exactly this controller's lifetime.
   */
  private readonly rounds = new AbortController()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'tokenRouterRollout')
    const resolved = resolveConfig(config)
    this.liveConfig = resolved

    // Settings section: user-owned fields overlay the composition entry.
    installSettingsSection(ctx, NS, TOKEN_ROUTER_ROLLOUT_SETTINGS_SCHEMA, {
      enabled: resolved.enabled,
      rolloutCount: resolved.rolloutCount,
      judgeModel: resolved.judgeModel,
      judgeBaseURL: resolved.judgeBaseURL,
      workerModels: resolved.workerModels,
      autoMilestone: resolved.autoMilestone,
    }, {
      setSource: (source) => {
        const section = source()
        this.liveConfig = Object.assign({}, this.liveConfig, {
          enabled: section.enabled,
          rolloutCount: section.rolloutCount,
          judgeModel: section.judgeModel,
          // An empty section value means the user never set an endpoint; the
          // composition's value (when the deployment supplied one) stands.
          ...section.judgeBaseURL.trim() === '' ? {} : { judgeBaseURL: section.judgeBaseURL },
          workerModels: section.workerModels,
          autoMilestone: section.autoMilestone,
        })
      },
      onChange: () => {},
    })

    // The /rollout command: manual trigger from the UI or a human.
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        name: 'rollout',
        description: 'Run a diverse rollout round over the current task and let the SOTA judge pick the best plan',
        input: { hint: '[decision context]' },
        handler: ({ agent, rawInput }) => {
          if (!this.liveConfig.enabled) {
            return { kind: 'success', text: 'Rollout is disabled (enable it in Settings → TokenRouter Rollout).' }
          }
          if (this.liveConfig.judgeBaseURL.trim() === '') {
            return { kind: 'success', text: 'Rollout has no judge endpoint: set judgeBaseURL in Settings → TokenRouter Rollout to an OpenAI-compatible URL.' }
          }
          const decision = rawInput.trim() === ''
            ? 'Plan the next milestone for the current task based on everything discussed so far.'
            : rawInput.trim()
          // The invocation's `signal` is deliberately unused: it belongs to the
          // dispatching UI request and aborts when that response closes, which
          // is before the first worker has answered.
          this.startDetachedRound(ctx, agent, 'manual', decision)
          return { kind: 'success', text: `Rollout started: ${this.liveConfig.rolloutCount} parallel trajectories will be judged by ${this.liveConfig.judgeModel}.` }
        },
      })
    })

    // Milestone watcher: when a todo flips to completed and another pending
    // todo remains, review the completed milestone's implementation and plan
    // the next one with a rollout round.
    ctx.on('session/event', (session, event) => {
      if (!this.liveConfig.enabled || !this.liveConfig.autoMilestone) return
      if (event.type !== 'todo/write') return
      this.maybeTriggerMilestone(ctx, session, event)
    })

    ctx.effect(() => () => {
      this.disposed = true
      this.rounds.abort()
    }, 'tokenrouter-rollout: close lifetime')

    // The stats projection unit (activates only when a projection registry is
    // composed, e.g. web assemblies).
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.register(rolloutStatsProjectionDefinition)
    })
  }

  /** Current effective config (settings-folded). */
  get config(): ResolvedConfig {
    return this.liveConfig
  }

  /**
   * Run one round for an agent, persisting events and steering the winner in.
   * @param agent - the agent whose session receives the round's events and plan.
   * @param trigger - what opened the round.
   * @param decision - the decision context workers and the judge see.
   * @param signal - cancellation for this round; pass {@link roundSignal} for a detached one.
   * @returns the settled round, including a failure reason when selection did not happen.
   */
  async runRound(agent: Agent, trigger: RolloutTrigger, decision: string, signal: AbortSignal): Promise<RolloutResult> {
    if (this.disposed) throw new Error('tokenrouter-rollout: plugin disposed')
    if (!this.liveConfig.enabled) throw new Error('tokenrouter-rollout: disabled')
    // The settings section can enable rollout without an endpoint, which the
    // load-time check in `resolveConfig` never sees. Refusing here costs the
    // round nothing; spawning workers first would burn N worker runs whose
    // plans no judge can score.
    if (this.liveConfig.judgeBaseURL.trim() === '') {
      throw new Error('tokenrouter-rollout: judgeBaseURL is unset (set it in Settings → TokenRouter Rollout)')
    }
    const result = await runRollout(this.ctx, agent, decision, this.liveConfig, signal)
    publishRound(agent, trigger, decision, result, this.liveConfig.workerProvider)
    return result
  }

  /** Cancellation shared by detached rounds; aborts when the plugin unloads. */
  get roundSignal(): AbortSignal {
    return this.rounds.signal
  }

  /** Start a round that outlives its trigger, reporting failure to the log. */
  private startDetachedRound(ctx: Context, agent: Agent, trigger: RolloutTrigger, decision: string): void {
    void this.runRound(agent, trigger, decision, this.rounds.signal).catch((error: unknown) => {
      ctx.logger.warn('tokenrouter-rollout: %s round failed: %o', trigger, error)
    })
  }

  /** Trigger a round when a completed milestone leaves a next one pending. */
  private maybeTriggerMilestone(ctx: Context, session: SessionLike, event: SessionEvent<'todo/write'>): void {
    // `session/event` is a global feed, so a rollout worker's own todo/write
    // arrives here too. Spawning a round for it would have that round's
    // workers spawn further rounds — unbounded recursion off one milestone.
    // A subagent child records `origin: 'subagent'` in its durable header.
    if (session.header.origin === 'subagent') return
    const agent = ctx.agents.get(session.id)
    if (agent === undefined) return
    // Find the previous todo/write to diff statuses against: todo_write
    // replaces the whole list, so a completed milestone keeps its content but
    // its status flips from pending/in_progress to completed.
    const previous = session.events
      .filter((e): e is SessionEvent<'todo/write'> => e.type === 'todo/write')
      .findLast(e => e.seq < event.seq)
    const before = new Map(previous?.data.todos.map(t => [t.content, t.status]) ?? [])
    const completed = event.data.todos.filter((t) => {
      const prior = before.get(t.content)
      return t.status === 'completed' && prior !== undefined && prior !== 'completed'
    })
    if (completed.length === 0) return
    const next = event.data.todos.find(t => t.status === 'pending')
    if (next === undefined) return
    // Mutation memory: attach the recent work trail (last few model-visible
    // text outputs) so workers/judge review the actual implementation, not
    // just the todo headline.
    const trail = recentWorkTrail(session, 600)
    const base = `The milestone "${completed.map(t => t.content).join(', ')}" just completed. Review its implementation and plan the next milestone: "${next.content}".`
    const decision = trail === '' ? base : `${base}\n\nRECENT WORK TRAIL (for context):\n${trail}`
    this.startDetachedRound(ctx, agent, 'milestone', decision)
  }
}

/** Last model-visible text of the session, capped at `maxChars`. */
function recentWorkTrail(session: SessionLike, maxChars: number): string {
  const parts: string[] = []
  for (const event of session.events) {
    if (event.type === 'assistant/message') {
      const text = event.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n')
      if (text !== '') parts.push(text)
    }
  }
  const tail = parts.slice(-3).join('\n---\n')
  return tail.length <= maxChars ? tail : tail.slice(-maxChars)
}

/** The session fields the milestone watcher reads. */
interface SessionLike {
  readonly id: SessionId
  readonly events: readonly SessionEvent[]
  /** Durable creation metadata; `origin` distinguishes a subagent child. */
  readonly header: { readonly origin?: 'subagent' }
}

export default TokenRouterRollout
