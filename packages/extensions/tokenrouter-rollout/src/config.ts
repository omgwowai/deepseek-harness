/**
 * Plugin configuration for tokenrouter-rollout: the cordis.yml-facing config
 * type and the resolution that fills its defaults. Every field is optional in
 * yml and the plugin is DISABLED by default (`enabled: false`), so mounting
 * the row changes nothing until a user (or an overlay) turns it on. The
 * runtime schemastery schema lives on the plugin class (`static Config`).
 *
 * @module @deepseek-ai/dsh-tokenrouter-rollout/config
 */

/**
 * Rollout worker diversity slot. Diversity is PROMPT-level: the harness routes
 * a child through `AgentOptions`, which carries provider, model, and token cap
 * but no sampling scalars, so a slot varies what the worker is asked to do
 * rather than how the sampler behaves. A per-slot temperature would need the
 * `agent/request` waterfall on each child; that is deferred work, and until it
 * exists a temperature field would be accepted and silently dropped.
 */
export interface DiversitySlot {
  /** Stable slot label recorded in `rollout/trajectory` and used in prompts. */
  label: string
  /** Extra strategy guidance appended to the worker prompt. */
  strategy?: string
}

/** Plugin configuration as written in cordis.yml; {@link resolveConfig} fills the rest. */
export interface Config {
  /** Master switch; the plugin is inert while false. Default false. */
  enabled?: boolean
  /** Parallel trajectories per rollout round. Default 3. */
  rolloutCount?: number
  /**
   * SOTA judge model id on the judge endpoint. Default `claude-opus-5`;
   * `gpt-5.6-sol` is a validated alternative.
   */
  judgeModel?: string
  /**
   * Judge endpoint base URL (OpenAI-compatible), e.g.
   * `https://gateway.example/v1`. No default: the endpoint is a property of
   * the deployment, not of this plugin, and a built-in one would ship a
   * specific operator's host to every install. An enabled plugin without it
   * fails at load.
   */
  judgeBaseURL?: string
  /** API-key environment variable name for the judge endpoint. Default `DEEPSEEK_API_KEY`. */
  judgeApiKeyEnv?: string
  /**
   * Worker provider route. Default `deepseek-official` (the dsh adapter the
   * deployment already configures), so rollout uses the cheap model dsh
   * already chose.
   */
  workerProvider?: string
  /**
   * Subagent provider that runs the workers. Default `fork`, which seeds each
   * worker with the parent's completed-turn history so it plans against the
   * real conversation rather than the decision line alone.
   */
  workerSubagentProvider?: string
  /**
   * Worker model pool; each trajectory picks `pool[i % pool.length]`. When
   * empty, trajectories fall back to the triggering agent's own model.
   */
  workerModels?: string[]
  /** Diversity slots; one per trajectory when non-empty (cycling). */
  diversitySlots?: DiversitySlot[]
  /** Timeout per worker run, ms. Default 10 minutes. */
  workerTimeoutMs?: number
  /** Timeout for the judge call, ms. Default 3 minutes. */
  judgeTimeoutMs?: number
  /** Max chars of each plan sent to the judge (keeps SOTA tokens bounded). Default 12_000. */
  maxPlanChars?: number
  /** Whether milestone completion auto-triggers a rollout round. Default false (follows `enabled`). */
  autoMilestone?: boolean
  /** Max chars of the milestone context sent to the judge/workers. Default 4_000. */
  maxContextChars?: number
  /** Optional judge system prompt override. */
  judgeSystemPrompt?: string
}

/**
 * {@link Config} with every default applied. `judgeSystemPrompt` stays
 * optional: absence selects the judge's built-in prompt, which no default
 * value can express.
 */
export type ResolvedConfig =
  Required<Omit<Config, 'judgeSystemPrompt'>> & Pick<Config, 'judgeSystemPrompt'>

/**
 * Diversity slots shipped by default: three planning postures over the same
 * decision. Each is a prompt suffix, which is the whole of the diversity a
 * worker actually receives (see {@link DiversitySlot}).
 */
export const DEFAULT_DIVERSITY_SLOTS: DiversitySlot[] = [
  { label: 'conservative', strategy: 'Be conservative: prefer the simplest robust solution.' },
  { label: 'thorough', strategy: 'Be thorough: cover edge cases and future-proofing.' },
  { label: 'creative', strategy: 'Be creative: consider unconventional but viable approaches.' },
]

/** Defaults applied when the loader did not provide a field. */
const DEFAULTS: Omit<ResolvedConfig, 'judgeBaseURL' | 'judgeSystemPrompt'> = {
  enabled: false,
  rolloutCount: 3,
  judgeModel: 'claude-opus-5',
  judgeApiKeyEnv: 'DEEPSEEK_API_KEY',
  workerProvider: 'deepseek-official',
  workerSubagentProvider: 'fork',
  workerModels: [],
  diversitySlots: DEFAULT_DIVERSITY_SLOTS,
  workerTimeoutMs: 600_000,
  judgeTimeoutMs: 180_000,
  maxPlanChars: 12_000,
  autoMilestone: false,
  maxContextChars: 4_000,
}

/**
 * Every {@link Config} key. Typed as `Record<keyof Config, true>`, so adding a
 * field without listing it here is a type error rather than a key the typo
 * check silently accepts.
 */
const CONFIG_KEY_MAP: Record<keyof Config, true> = {
  enabled: true,
  rolloutCount: true,
  judgeModel: true,
  judgeBaseURL: true,
  judgeApiKeyEnv: true,
  workerProvider: true,
  workerSubagentProvider: true,
  workerModels: true,
  diversitySlots: true,
  workerTimeoutMs: true,
  judgeTimeoutMs: true,
  maxPlanChars: true,
  autoMilestone: true,
  maxContextChars: true,
  judgeSystemPrompt: true,
}

const CONFIG_KEYS = new Set(Object.keys(CONFIG_KEY_MAP))

/**
 * Resolve a possibly-partial config to a complete one, rejecting typos.
 * @param config - the loader's or a caller's partial configuration.
 * @returns the complete configuration with defaults applied.
 * @throws when a key is unknown, a bound is violated, or an enabled plugin has no judge endpoint.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const unknown = Object.keys(config).filter(key => !CONFIG_KEYS.has(key))
  if (unknown.length > 0) {
    throw new Error(`tokenrouter-rollout: unknown config key(s) ${unknown.join(', ')}`)
  }
  const resolved: ResolvedConfig = Object.assign({ judgeBaseURL: '' }, DEFAULTS, config)
  if (resolved.rolloutCount < 1 || resolved.rolloutCount > 8) {
    throw new Error('tokenrouter-rollout: rolloutCount must be 1..8')
  }
  if (resolved.judgeModel.trim() === '') {
    throw new Error('tokenrouter-rollout: judgeModel must be non-empty')
  }
  // A disabled plugin never calls the judge, so the endpoint may stay unset
  // until the deployment that turns rollout on supplies its own.
  if (resolved.enabled && resolved.judgeBaseURL.trim() === '') {
    throw new Error('tokenrouter-rollout: judgeBaseURL is required while enabled (set the OpenAI-compatible judge endpoint in cordis.yml)')
  }
  return resolved
}
