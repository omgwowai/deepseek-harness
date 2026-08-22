/**
 * dsh-tokenrouter-cost —— 自研 Token Router 计费插件（替代 dsh-cost-meter）。
 *
 * 定位：omgwow × DeepSeek Harness 适配层中的自研计费插件。只做两件事：
 *   1. 按 prices.json 的 Input / Cached / CachedWrite / Output 四档价（CNY/1M
 *      tokens）对 llm/stream 用量计费，账本存 $DSH_HOME/storages/tokenrouter-cost/ledger.json；
 *   2. 经 Typert 暴露 tokenrouterCost.getState() 给客户端（价格/当日用量/会话明细）。
 * 余额暂不展示：本地无准确余额来源，等官方计费 API 开放后再接入查询。
 * 无峰谷、无订阅、无官方 API 调用——一切以 Token Router 页面价格为准。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'tokenrouter-cost'

const PRICES_FILE = new URL('./prices.json', import.meta.url)
const OLD_LEDGER = join(process.env.DSH_HOME ?? join(homedir(), '.dsh-v2'), 'storages', 'cost-meter', 'ledger.json')

function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh-v2')
}

const LEDGER_PATH = join(dshHome(), 'storages', 'tokenrouter-cost', 'ledger.json')

const PRICES = JSON.parse(readFileSync(PRICES_FILE, 'utf8')).models

function zeroBuckets() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, cost: 0, byModel: {} }
}

function emptyLedger() {
  return { version: 1, balance: { total: 0, granted: 0, topped: 0, currency: 'CNY', at: 0 }, days: {}, sessions: {} }
}

function loadJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function localDayKey(ms) {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 从旧 dsh-cost-meter 账本迁移（旧账本成本以 USD 存储，展示 ×7.2 = CNY）。 */
function migrateOldLedger() {
  const old = loadJson(OLD_LEDGER)
  if (!old || typeof old !== 'object') return null
  const days = {}
  const sessions = {}
  for (const [date, day] of Object.entries(old.days ?? {})) {
    const byModel = {}
    for (const [key, v] of Object.entries(day?.byProviderModel ?? {})) {
      byModel[key] = {
        input: v.input ?? 0,
        output: v.output ?? 0,
        cacheRead: v.cacheRead ?? 0,
        cacheWrite: v.cacheWrite ?? 0,
        calls: v.calls ?? 0,
        cost: (v.cost ?? 0) * 7.2,
      }
    }
    days[date] = {
      date,
      input: day.input ?? 0,
      output: day.output ?? 0,
      cacheRead: day.cacheRead ?? 0,
      cacheWrite: day.cacheWrite ?? 0,
      calls: day.calls ?? 0,
      cost: (day.cost ?? 0) * 7.2,
      byModel,
    }
    for (const s of day?.sessions ?? []) {
      if (!s || typeof s !== 'object') continue
      sessions[s.id] = {
        id: s.id,
        title: s.title ?? '',
        at: s.at ?? 0,
        input: s.input ?? 0,
        output: s.output ?? 0,
        cacheRead: s.cacheRead ?? 0,
        cacheWrite: s.cacheWrite ?? 0,
        calls: s.calls ?? 0,
        cost: (s.cost ?? 0) * 7.2,
      }
    }
  }
  return { days, sessions }
}

let ledger = loadJson(LEDGER_PATH) ?? (() => {
  const migrated = migrateOldLedger()
  const fresh = emptyLedger()
  if (migrated) {
    fresh.days = migrated.days
    fresh.sessions = migrated.sessions
  }
  return fresh
})()

let writeTimer = null
function scheduleWrite() {
  if (writeTimer !== null) return
  writeTimer = setTimeout(() => {
    writeTimer = null
    try {
      mkdirSync(dirname(LEDGER_PATH), { recursive: true })
      writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2))
    } catch (error) {
      console.warn(`[dsh-tokenrouter-cost] 账本写入失败: ${String(error)}`)
    }
  }, 1500)
}

function priceOf(model) {
  return PRICES[model] ?? null
}

function account(buckets, model, sessionId, timeMs) {
  const price = priceOf(model)
  if (price === null) return
  const input = price.input ?? 0
  // 缓存读无独立价（—）时按输入价；缓存写无独立价时按缓存读价。
  const cached = price.cached ?? input
  const cachedWrite = price.cachedWrite ?? cached
  const cost = (buckets.input * input
    + buckets.cacheRead * cached
    + buckets.cacheWrite * cachedWrite
    + buckets.output * (price.output ?? 0)) / 1_000_000
  const date = localDayKey(timeMs)
  const day = ledger.days[date] ?? (ledger.days[date] = { date, ...zeroBuckets() })
  const modelRow = day.byModel[model] ?? (day.byModel[model] = zeroBuckets())
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    day[field] += buckets[field]
    modelRow[field] += buckets[field]
  }
  day.calls += 1
  modelRow.calls += 1
  day.cost += cost
  modelRow.cost += cost

  if (typeof sessionId === 'string' && sessionId.length > 0) {
    const session = ledger.sessions[sessionId] ?? (ledger.sessions[sessionId] = { id: sessionId, title: '', at: timeMs, ...zeroBuckets() })
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) session[field] += buckets[field]
    session.calls += 1
    session.cost += cost
    if (timeMs > session.at) session.at = timeMs
  }
  scheduleWrite()
}

function todayOf() {
  const date = localDayKey(Date.now())
  return ledger.days[date] ?? { date, ...zeroBuckets() }
}

/**
 * 账本一致性校验：每一天的合计必须等于其 byModel 各行之和（token 桶、调用数、
 * 费用均逐项比对，费用按 1e-9 容差）。返回违规描述数组（空 = 一致）。
 * 供 invariant 伴生与测试调用。
 * @returns 违规描述列表。
 */
export function ledgerConsistencyViolations() {
  const violations = []
  const EPS = 1e-9
  for (const [date, day] of Object.entries(ledger.days)) {
    const sums = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, cost: 0 }
    for (const row of Object.values(day.byModel ?? {})) {
      for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'calls', 'cost']) {
        sums[field] += row[field] ?? 0
      }
    }
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'calls', 'cost']) {
      const diff = Math.abs((day[field] ?? 0) - sums[field])
      const ok = field === 'calls' ? diff === 0 : diff <= EPS
      if (!ok) violations.push(`${date}: 合计 ${field}=${day[field]} ≠ byModel 之和 ${sums[field]}`)
    }
  }
  return violations
}

/** 把价格表归一化为 RPC 载荷：填平空档（缓存读缺省=输入价、缓存写缺省=缓存读价），去掉 _tiers 等内部字段。 */
function normalizedPrices() {
  const out = {}
  for (const [model, price] of Object.entries(PRICES)) {
    const input = price.input ?? 0
    const cached = price.cached ?? input
    out[model] = {
      input,
      cached,
      cachedWrite: price.cachedWrite ?? cached,
      output: price.output ?? 0,
    }
  }
  return out
}

const service = {
  getState() {
    return {
      prices: normalizedPrices(),
      today: todayOf(),
      sessions: Object.values(ledger.sessions)
        .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
        .slice(0, 30),
    }
  },
}

Object.defineProperty(service, 'typertRemote', {
  configurable: false,
  enumerable: false,
  writable: false,
  value: { service, serviceKey: 'tokenrouterCost', namespace: 'tokenrouterCost' },
})

export function apply(ctx) {
  scheduleWrite() // 启动时把（含迁移的）账本落盘，保证重启前数据可见
  ctx.effect(() => () => scheduleWrite(), 'tokenrouter-cost: final flush')

  // invariant 合规：官方 invariants 服务存在时注册伴生（web 组合通常不挂载该服务）；
  // 无论是否存在，都自带账本一致性自检（每次流结束落盘后复核，不一致记错误日志）。
  const invariants = ctx.get('invariants')
  if (invariants !== undefined) {
    import('./invariant.js').then(({ apply: register }) => register(ctx))
      .catch((error) => ctx.logger?.warn?.(`[dsh-tokenrouter-cost] invariant 伴生注册失败: ${String(error)}`))
  }
  const selfCheckTimer = () => {
    setTimeout(() => {
      const violations = ledgerConsistencyViolations()
      if (violations.length > 0) {
        ctx.logger?.error?.(`[dsh-tokenrouter-cost] 账本一致性违规: ${violations.join('; ')}`)
      }
    }, 1800).unref?.()
  }
  ctx.on('llm/stream', (_options, next) => {
    const downstream = next()
    return (async function* selfCheckStream() {
      try {
        for await (const chunk of downstream) yield chunk
      } finally {
        selfCheckTimer()
      }
    })()
  }, { prepend: false })
  ctx.on('llm/stream', (options, next) => {
    const downstream = next()
    return (async function* tokenrouterCostStream() {
      let usage = null
      try {
        for await (const chunk of downstream) {
          if (chunk !== null && chunk !== undefined && chunk.type === 'usage' && chunk.usage !== undefined) {
            usage = chunk.usage
          }
          yield chunk
        }
      } finally {
        if (usage !== null) {
          try {
            account({
              input: usage.inputTokens ?? 0,
              output: usage.outputTokens ?? 0,
              cacheRead: usage.cacheReadTokens ?? 0,
              cacheWrite: usage.cacheWriteTokens ?? 0,
            }, options?.model, options?.sessionId, Date.now())
          } catch (error) {
            ctx.logger?.warn?.(`[dsh-tokenrouter-cost] 计费失败: ${String(error)}`)
          }
        }
      }
    })()
  })
  ctx.provide('tokenrouterCost', service)
}
