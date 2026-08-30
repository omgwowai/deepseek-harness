/**
 * dsh-tokenrouter-cost 的 Host 面 Typert 清单（typert-loader 自动扫描注册）。
 */
import { z } from 'zod'

const num = z.number()

const bucketsSchema = z.object({
  input: num,
  output: num,
  cacheRead: num,
  cacheWrite: num,
  calls: num,
  cost: num,
  byModel: z.record(z.string(), z.object({
    input: num,
    output: num,
    cacheRead: num,
    cacheWrite: num,
    calls: num,
    cost: num,
  })),
})

const sessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  at: num,
  input: num,
  output: num,
  cacheRead: num,
  cacheWrite: num,
  calls: num,
  cost: num,
})

const priceSchema = z.object({
  input: num,
  cached: num,
  cachedWrite: num,
  output: num,
})

const stateSchema = z.object({
  prices: z.record(z.string(), priceSchema),
  today: bucketsSchema.extend({ date: z.string() }),
  sessions: z.array(sessionSchema),
})

const _state$codec = { mode: 'strict', typeSymbol: 'dsh-tokenrouter-cost#State', schema: stateSchema }

export const TYPERT = {
  package: 'dsh-tokenrouter-cost',
  face: 'host',
  schemas: [],
  invocations: [
    {
      id: 'dsh-tokenrouter-cost#tokenrouterCost/getState',
      service: 'tokenrouterCost',
      namespace: 'tokenrouterCost',
      method: 'getState',
      invocation: { kind: 'direct' },
      parameters: [],
      result: _state$codec,
    },
  ],
  model: {
    services: [
      {
        description: 'Token Router 计费账本服务（价格/当日用量与费用）。',
        summary: 'Token Router 计费账本服务。',
        tags: [],
        jsDoc: '/** Token Router 计费账本服务。 */',
        key: 'tokenrouterCost',
        exportName: 'TokenrouterCostService',
        members: [],
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
}

export default TYPERT
