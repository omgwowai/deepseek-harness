/**
 * dsh-rollout-transparent 的 Host 面 Typert 清单（typert-loader 自动扫描注册）。
 */
import { z } from 'zod'

const judgeCallSchema = z.object({
  a: z.number(),
  b: z.number(),
  rep: z.number(),
  swap: z.boolean(),
  critId: z.string(),
  critName: z.string(),
  critDescription: z.string(),
  response: z.string(),
  responseTruncated: z.boolean(),
  error: z.string(),
  scoreA: z.number(),
  scoreB: z.number(),
  ttftMs: z.number().nullable(),
  wallMs: z.number(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
})

const stepSchema = z.object({
  turn: z.number(),
  step: z.number(),
  at: z.number(),
  model: z.string(),
  n: z.number(),
  selected: z.number(),
  scores: z.array(z.number()),
  ranking: z.array(z.number()),
  nComparisons: z.number(),
  judgeError: z.string(),
  judgeModel: z.string().optional(),
  judgeBackendId: z.string().optional(),
  judgeSkipped: z.boolean().optional(),
  answerToolLen: z.number().optional(),
  thinkingLen: z.number().optional(),
  // 请求体信息默认不随树常驻：getSessionTrees 已剥离这三个重字段，仅留 hasBody
  // 标记；打开某步时经 getStepBody 按需加载（见 stepBodySchema）。
  judgeCalls: z.array(judgeCallSchema).optional(),
  perCriterion: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    scores: z.array(z.number()),
  })).optional(),
  problem: z.string().optional(),
  candidates: z.array(z.object({
    text: z.string(),
    preview: z.string(),
  })).optional(),
  hasBody: z.boolean().optional(),
  winnerUsage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
  }).nullable().optional(),
  judgeUsage: z.object({
    promptTokens: z.number(),
    completionTokens: z.number(),
    cacheHitTokens: z.number(),
    cacheMissTokens: z.number(),
  }).nullable().optional(),
  usage: z.array(z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
  })).nullable().optional(),
  judgeAgg: z.object({
    avgInputTokens: z.number(),
    avgOutputTokens: z.number(),
    totalMs: z.number(),
  }).nullable().optional(),
  tps: z.object({
    finalOutTps: z.number().nullable(),
    judgeTps: z.number().nullable(),
    judgeCompletionTokens: z.number(),
    judgeCallMsSum: z.number(),
  }).optional(),
  criteria: z.object({
    enabled: z.boolean(),
    action: z.string(),
    changed: z.boolean(),
    changeScore: z.number().nullable(),
    names: z.array(z.string()),
    error: z.string(),
    tps: z.number().nullable(),
    completionTokens: z.number(),
    callMsSum: z.number(),
  }).optional(),
  timing: z.object({
    fanoutMs: z.number(),
    criteriaWallMs: z.number().optional(),
    criteriaTtftMs: z.number().nullable().optional(),
    judgeStartMs: z.number().optional(),
    totalMs: z.number(),
    winnerDecodeMs: z.number().nullable(),
    winnerWallMs: z.number().nullable().optional(),
    fanoutTtftMs: z.number().nullable().optional(),
    judgeTtftMsAvg: z.number().nullable().optional(),
    decodeMs: z.array(z.number().nullable()),
    wallMs: z.array(z.number().nullable()).optional(),
    ttftMs: z.array(z.number().nullable()).optional(),
    reasoningMs: z.array(z.number().nullable()).optional(),
    judgeTiming: z.object({
      ringMs: z.number(),
      pivotMs: z.number(),
      totalJudgeMs: z.number(),
      calls: z.number(),
      callMs: z.array(z.number()),
      callTtftMs: z.array(z.number().nullable()),
    }).nullable().optional(),
  }).optional(),
})

const sessionSchema = z.object({
  id: z.string(),
  steps: z.array(stepSchema),
})

const judgeModelSchema = z.object({
  id: z.string(),
  name: z.string(),
})

const judgeBackendViewSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  baseUrl: z.string(),
  supportsLogprobs: z.boolean(),
  logprobsWithThinking: z.boolean(),
  models: z.array(judgeModelSchema),
})

const settingsSchema = z.object({
  enabled: z.boolean(),
  rolloutCount: z.number(),
  judgeBackendId: z.string(),
  judgeModel: z.string(),
  criteriaEnabled: z.boolean().optional(),
  criteriaChangeThreshold: z.number().optional(),
  judgeBackends: z.array(judgeBackendViewSchema),
})

const settingsPatchSchema = z.object({
  enabled: z.boolean().optional(),
  rolloutCount: z.number().optional(),
  judgeBackendId: z.string().optional(),
  judgeModel: z.string().optional(),
  criteriaEnabled: z.boolean().optional(),
})

const candidateSchema = z.object({
  text: z.string(),
  preview: z.string(),
})

const stepBodySchema = z.object({
  problem: z.string().optional(),
  candidates: z.array(candidateSchema).optional(),
  judgeCalls: z.array(judgeCallSchema).optional(),
}).nullable()

const releaseResultSchema = z.object({
  released: z.boolean(),
})

const streamStatsSchema = z.object({
  ttftMs: z.number().nullable(),
  outputTokens: z.number(),
  wallMs: z.number(),
  model: z.string(),
  at: z.number(),
}).nullable()

const _session$codec = { mode: 'strict', typeSymbol: 'dsh-rollout-transparent#SessionTrees', schema: sessionSchema }
const _sessionId$codec = { mode: 'strict', typeSymbol: 'dsh-rollout-transparent#SessionId', schema: z.string() }
const _settings$codec = { mode: 'strict', typeSymbol: 'dsh-rollout-transparent#Settings', schema: settingsSchema }
const _settingsPatch$codec = { mode: 'strict', typeSymbol: 'dsh-rollout-transparent#SettingsPatch', schema: settingsPatchSchema }
const _turn$codec = { mode: 'strict', typeSymbol: 'dsh-rollout-transparent#Turn', schema: z.number() }
const _step$codec = { mode: 'strict', typeSymbol: 'dsh-rollout-transparent#StepNo', schema: z.number() }
const _stepBody$codec = { mode: 'strict', typeSymbol: 'dsh-rollout-transparent#StepBody', schema: stepBodySchema }
const _releaseResult$codec = { mode: 'strict', typeSymbol: 'dsh-rollout-transparent#ReleaseResult', schema: releaseResultSchema }
const _streamStats$codec = { mode: 'strict', typeSymbol: 'dsh-rollout-transparent#StreamStats', schema: streamStatsSchema }

export const TYPERT = {
  package: 'dsh-rollout-transparent',
  face: 'host',
  schemas: [],
  invocations: [
    {
      id: 'dsh-rollout-transparent#rolloutTree/getSessionTrees',
      service: 'rolloutTree',
      namespace: 'rolloutTree',
      method: 'getSessionTrees',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'sessionId', wire: 'sessionId', source: 'json', codec: _sessionId$codec },
      ],
      result: _session$codec,
    },
    {
      id: 'dsh-rollout-transparent#rolloutTree/getSettings',
      service: 'rolloutTree',
      namespace: 'rolloutTree',
      method: 'getSettings',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'sessionId', wire: 'sessionId', source: 'json', codec: _sessionId$codec },
      ],
      result: _settings$codec,
    },
    {
      id: 'dsh-rollout-transparent#rolloutTree/setSettings',
      service: 'rolloutTree',
      namespace: 'rolloutTree',
      method: 'setSettings',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'sessionId', wire: 'sessionId', source: 'json', codec: _sessionId$codec },
        { name: 'patch', wire: 'patch', source: 'json', codec: _settingsPatch$codec },
      ],
      result: _settings$codec,
    },
    {
      id: 'dsh-rollout-transparent#rolloutTree/getStepBody',
      service: 'rolloutTree',
      namespace: 'rolloutTree',
      method: 'getStepBody',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'sessionId', wire: 'sessionId', source: 'json', codec: _sessionId$codec },
        { name: 'turn', wire: 'turn', source: 'json', codec: _turn$codec },
        { name: 'step', wire: 'step', source: 'json', codec: _step$codec },
      ],
      result: _stepBody$codec,
    },
    {
      id: 'dsh-rollout-transparent#rolloutTree/releaseStepBody',
      service: 'rolloutTree',
      namespace: 'rolloutTree',
      method: 'releaseStepBody',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'sessionId', wire: 'sessionId', source: 'json', codec: _sessionId$codec },
        { name: 'turn', wire: 'turn', source: 'json', codec: _turn$codec },
        { name: 'step', wire: 'step', source: 'json', codec: _step$codec },
      ],
      result: _releaseResult$codec,
    },
    {
      id: 'dsh-rollout-transparent#rolloutTree/getSessionStreamStats',
      service: 'rolloutTree',
      namespace: 'rolloutTree',
      method: 'getSessionStreamStats',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'sessionId', wire: 'sessionId', source: 'json', codec: _sessionId$codec },
      ],
      result: _streamStats$codec,
    },
  ],
  model: {
    services: [
      {
        description: '无感 best-of-N 的 rollout 树服务（每步 N 分支 + judge 得分 + 选中）与运行时设置（开关/轨迹数/judge 端点与模型）。',
        summary: 'Rollout 树与设置服务。',
        tags: [],
        jsDoc: '/** Rollout 树与设置服务。 */',
        key: 'rolloutTree',
        exportName: 'RolloutTreeService',
        members: [],
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
}

export default TYPERT
