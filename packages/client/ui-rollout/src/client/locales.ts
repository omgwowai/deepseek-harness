/** `rollout` namespace dictionaries (the composer button + settings section + stats panel copy). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'button.aria': '运行 rollout：并行生成多份方案并由 SOTA 模型评审',
  'button.title': 'Rollout — 并行生成多份方案，SOTA 评审选优（/rollout）',
  'button.running': 'rollout 进行中…',
  'settings.section.title': 'TokenRouter Rollout',
  'settings.enabled.label': '启用 rollout',
  'settings.enabled.desc': '在规划/里程碑决策点并行生成多样方案，用 SOTA 模型评审选优（默认关闭）',
  'settings.count.label': '并行轨迹数',
  'settings.count.desc': '每个决策点并行生成的方案数量（1-8）',
  'settings.judge.label': '评审模型',
  'settings.judge.desc': '评审端点上的 SOTA 模型 id，如 claude-opus-5 / gpt-5.6-sol',
  'settings.judgeBaseURL.label': '评审端点',
  'settings.judgeBaseURL.desc': 'OpenAI 兼容的评审端点 URL；启用 rollout 前必填，留空则拒绝执行',
  'settings.workerModels.label': 'Worker 模型池',
  'settings.workerModels.desc': '生成方案的模型列表（逗号分隔）；留空使用当前模型',
  'settings.autoMilestone.label': '里程碑自动触发',
  'settings.autoMilestone.desc': '一个里程碑完成后自动评审实现并规划下一个',
  'stats.title': 'Rollout 统计',
  'stats.rounds': '轮次',
  'stats.trajectories': '轨迹',
  'stats.ok': '成功',
  'stats.failedRounds': '失败轮次',
  'stats.avgWinner': '平均胜出分',
  'stats.workerTokens': 'Worker tokens',
  'stats.judgeTokens': 'Judge tokens',
} satisfies Record<string, string>

/** The rollout namespace key union. */
export type RolloutKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'button.aria': 'Run rollout: generate diverse plans in parallel and let a SOTA model judge them',
  'button.title': 'Rollout — parallel diverse plans, SOTA judge picks the best (/rollout)',
  'button.running': 'rollout in progress…',
  'settings.section.title': 'TokenRouter Rollout',
  'settings.enabled.label': 'Enable rollout',
  'settings.enabled.desc': 'At plan/milestone decision points, generate diverse plans in parallel and pick the best with a SOTA judge (off by default)',
  'settings.count.label': 'Parallel trajectories',
  'settings.count.desc': 'Plans generated per decision point (1-8)',
  'settings.judge.label': 'Judge model',
  'settings.judge.desc': 'SOTA judge model id on the judge endpoint, e.g. claude-opus-5 / gpt-5.6-sol',
  'settings.judgeBaseURL.label': 'Judge endpoint',
  'settings.judgeBaseURL.desc': 'OpenAI-compatible judge endpoint URL; required before enabling rollout, which refuses to run while it is empty',
  'settings.workerModels.label': 'Worker model pool',
  'settings.workerModels.desc': 'Comma-separated models that generate plans; empty uses the current model',
  'settings.autoMilestone.label': 'Auto-trigger on milestones',
  'settings.autoMilestone.desc': 'When a milestone completes, review its implementation and plan the next one',
  'stats.title': 'Rollout stats',
  'stats.rounds': 'Rounds',
  'stats.trajectories': 'Trajectories',
  'stats.ok': 'OK',
  'stats.failedRounds': 'Failed rounds',
  'stats.avgWinner': 'Avg winner score',
  'stats.workerTokens': 'Worker tokens',
  'stats.judgeTokens': 'Judge tokens',
} satisfies Record<RolloutKey, string>
