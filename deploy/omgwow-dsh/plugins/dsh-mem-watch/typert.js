/**
 * dsh-mem-watch 的 Host 面 Typert 清单（typert-loader 自动扫描注册）。
 */
import { z } from 'zod'

const num = z.number()

const sampleSchema = z.object({
  at: num,
  rss: num,
  heapTotal: num,
  heapUsed: num,
  external: num,
  arrayBuffers: num,
  sysFree: num,
  load1: num,
})

const winSchema = z.object({
  samples: num,
  minHeap: num,
  maxHeap: num,
  growthHeap: num,
  minRss: num,
  maxRss: num,
  growthRss: num,
}).nullable()

const verdictSchema = z.object({
  level: z.string(),
  reason: z.string(),
})

const snapshotSchema = z.object({
  now: num,
  intervalMs: num,
  latest: sampleSchema.nullable(),
  windows: z.object({ m5: winSchema, m30: winSchema, h2: winSchema }),
  verdict: verdictSchema,
  logPath: z.string(),
  logSize: num.nullable(),
  samplesKept: num,
  uptimeMs: num,
})

const _snapshot$codec = { mode: 'strict', typeSymbol: 'dsh-mem-watch#Snapshot', schema: snapshotSchema }

export const TYPERT = {
  package: 'dsh-mem-watch',
  face: 'host',
  schemas: [],
  invocations: [
    {
      id: 'dsh-mem-watch#memWatch/getSnapshot',
      service: 'memWatch',
      namespace: 'memWatch',
      method: 'getSnapshot',
      invocation: { kind: 'direct' },
      parameters: [],
      result: _snapshot$codec,
    },
  ],
  model: {
    services: [
      {
        description: '5s 级全实例内存监控服务（采样快照 + 滚动窗口 + 泄漏疑似判定）。',
        summary: '实例内存监控服务。',
        tags: [],
        jsDoc: '/** 实例内存监控服务。 */',
        key: 'memWatch',
        exportName: 'MemWatchService',
        members: [],
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
}

export default TYPERT
