/**
 * dsh-mem-watch —— 5s 级全实例内存监控插件。
 *
 * 目的：以 5 秒粒度持续记录整个 dsh 实例进程的内存形态（RSS / V8 堆 / external /
 * arrayBuffers / 系统空闲内存 / loadavg），用于发现与定位内存泄漏：
 *   - 每 5s 采样一行，追加写 $DSH_HOME/logs/mem-watch.ndjson（约 2.6MB/天）；
 *   - 内存中保留 24h 环形缓冲（17280 条），供 RPC 快照；
 *   - 滚动窗口（5m / 30m / 2h）统计 min/max/growth，按阈值给出泄漏疑似判定；
 *   - 经 Typert 暴露 memWatch.getSnapshot()，客户端 composer dock 常驻展示。
 */
import { appendFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir, freemem, loadavg } from 'node:os'
import { z } from 'zod'

export const name = 'mem-watch'

function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh-v2')
}

const Config = z.object({
  intervalMs: z.number().int().min(1000).max(60000).default(5000),
  ringSize: z.number().int().min(600).max(200000).default(17280),
  logDir: z.string().optional(),
  growthWarnMB: z.number().min(50).default(200),
  growthErrorMB: z.number().min(100).default(400),
})
const config = Config.parse({})

function logPath() {
  return join(config.logDir ?? join(dshHome(), 'logs'), 'mem-watch.ndjson')
}

function mb(v) {
  return Math.round((v / 1048576) * 10) / 10
}

function sample() {
  const mem = process.memoryUsage()
  const free = freemem()
  const load = loadavg()
  return {
    at: Date.now(),
    rss: mb(mem.rss),
    heapTotal: mb(mem.heapTotal),
    heapUsed: mb(mem.heapUsed),
    external: mb(mem.external),
    arrayBuffers: mb(mem.arrayBuffers),
    sysFree: mb(free),
    load1: Math.round(load[0] * 100) / 100,
  }
}

function windowStats(samples, endMs, durationMs) {
  const start = endMs - durationMs
  const win = samples.filter((s) => s.at >= start)
  if (win.length === 0) return null
  const minHeap = Math.min(...win.map((s) => s.heapUsed))
  const maxHeap = Math.max(...win.map((s) => s.heapUsed))
  const minRss = Math.min(...win.map((s) => s.rss))
  const maxRss = Math.max(...win.map((s) => s.rss))
  const growthHeap = Math.round((win[win.length - 1].heapUsed - minHeap) * 10) / 10
  const growthRss = Math.round((win[win.length - 1].rss - minRss) * 10) / 10
  return { samples: win.length, minHeap, maxHeap, growthHeap, minRss, maxRss, growthRss }
}

function verdict(stats30m) {
  if (stats30m === null) return { level: 'watching', reason: '等待 30 分钟窗口数据…' }
  const { growthHeap, growthRss, minRss, maxRss } = stats30m
  if (growthHeap >= config.growthErrorMB || growthRss >= config.growthErrorMB) {
    return { level: 'error', reason: `30 分钟内 heap +${growthHeap}MB / RSS +${growthRss}MB，疑似内存泄漏` }
  }
  if (growthHeap >= config.growthWarnMB || growthRss >= config.growthWarnMB) {
    return { level: 'warn', reason: `30 分钟内 heap +${growthHeap}MB / RSS +${growthRss}MB，持续观察` }
  }
  if (maxRss > 0 && minRss > 0 && (maxRss - minRss) < -64) {
    return { level: 'ok', reason: '内存已释放（GC/降载）' }
  }
  return { level: 'ok', reason: '内存稳定' }
}

const service = {
  getSnapshot() {
    const endMs = Date.now()
    const stats5m = windowStats(ring, endMs, 5 * 60 * 1000)
    const stats30m = windowStats(ring, endMs, 30 * 60 * 1000)
    const stats2h = windowStats(ring, endMs, 2 * 60 * 60 * 1000)
    const v = verdict(stats30m)
    let logSize = null
    try {
      logSize = statSync(logPath()).size
    } catch { /* 尚未写入 */ }
    return {
      now: endMs,
      intervalMs: config.intervalMs,
      latest: ring.length > 0 ? ring[ring.length - 1] : null,
      windows: { m5: stats5m, m30: stats30m, h2: stats2h },
      verdict: v,
      logPath: logPath(),
      logSize,
      samplesKept: ring.length,
      uptimeMs: Math.round(process.uptime() * 1000),
    }
  },
}

// 环形缓冲（服务端常驻，最多 24h @5s）
const ring = []

// Typert RPC 网关要求 service 携带 typertRemote 绑定（serviceKey/namespace 与 typert.js 清单一致）。
Object.defineProperty(service, 'typertRemote', {
  configurable: false,
  enumerable: false,
  writable: false,
  value: { service, serviceKey: 'memWatch', namespace: 'memWatch' },
})

export function apply(ctx) {
  const timer = setInterval(() => {
    try {
      const s = sample()
      ring.push(s)
      if (ring.length > config.ringSize) ring.splice(0, ring.length - config.ringSize)
      try {
        mkdirSync(dirname(logPath()), { recursive: true })
        appendFileSync(logPath(), JSON.stringify(s) + '\n')
      } catch (error) {
        ctx.logger?.warn?.(`[dsh-mem-watch] 采样写盘失败: ${String(error)}`)
      }
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-mem-watch] 采样失败: ${String(error)}`)
    }
  }, config.intervalMs)
  ctx.effect(() => () => {
    clearInterval(timer)
  }, 'dsh-mem-watch: 5s sampler')

  // 每次会话流结束顺手写一行标记（供离线对照"哪些活动带来增长"）。
  ctx.on('llm/stream', (_options, next) => {
    const downstream = next()
    return (async function* markStream() {
      try {
        for await (const chunk of downstream) yield chunk
      } finally {
        try {
          mkdirSync(dirname(logPath()), { recursive: true })
          appendFileSync(logPath(), JSON.stringify({ at: Date.now(), event: 'stream-end' }) + '\n')
        } catch { /* 忽略 */ }
      }
    })()
  })

  ctx.provide('memWatch', service)
}
