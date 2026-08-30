/**
 * dsh-rollout-transparent — 无感（model-unaware）推理期 best-of-N。
 *
 * 对模型完全透明：不注册任何工具、不修改 system prompt。每个 agent 循环步骤的
 * `llm/stream` 被拦截，改为并行发出 N 条 rollout（temperature 覆盖为
 * rolloutTemperature），由 judge（读 sampling 前 logprobs，thinking 开启）选出
 * 最优，胜者的 chunk 数组原样重放给循环——模型看到的、会话轨迹里记录的，始终只有
 * 被选中的那一条（拼凑出来的轨迹）。
 *
 * 数据通道：
 *   - `agent/request` 捕获 sessionId → { turn, step } 到 pendingSteps Map；
 *   - `llm/stream` 对同一 session 的下一步循环请求执行 fan-out → judge → select →
 *     replay；非循环请求（compaction/session-title，带 purpose）与未捕获的请求直接
 *     透传 next()。
 *   - 每步的 rollout 树（N 分支 + judge 得分 + 选中）落盘到
 *     $DSH_HOME/storages/rollout-transparent/trees.json（会话日志保持干净，只记录
 *     胜者），经 Typert rolloutTree.getSessionTrees(sessionId) 暴露给客户端页面。
 *
 * 安装（bundle）：`dsh plugin --profile <name> add dsh-rollout-transparent`。
 * judge 端点/模型由用户在 GUI 从 judgeBackends 池里选（默认 tokenrouter，thinking
 * 开启）；rollout 开关与轨迹数、judge 选择都持久化到 settings.json。
 */
import z from '@deepseek-ai/schemastery'
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { addUsage, CHANGE_SCALE_DESCRIPTION, createApi, extractScore, normalizeCriteria, selectBest } from './verifier.js'

export const name = 'rollout-transparent'

export const inject = ['llm', 'credentials']

const judgeModelSchema = z.object({
  id: z.string(),
  name: z.string(),
})

const judgeBackendSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  baseUrl: z.string(),
  apiKeyEnv: z.string(),
  reasoningEffort: z.string(),
  // supportsLogprobs：该端点返回 sampling 前的 top_logprobs。
  // logprobsWithThinking：thinking 开启时仍返回 top_logprobs。实测：tokenrouter 的
  // deepseek-*、api.deepseek.com（max_tokens 足够时）thinking 开启都返回 logprobs，
  // 均为 true；Claude/GLM/GPT/Kimi 不返回 logprobs，不列入 judge 后端池。
  supportsLogprobs: z.boolean(),
  logprobsWithThinking: z.boolean(),
  models: z.array(judgeModelSchema),
})

export const Config = z.object({
  enabled: z.boolean().default(true),
  rolloutCount: z.natural().default(3),
  rolloutTemperature: z.number().default(1.0),
  // 动态 Criteria 特性（独立开关）：fanout 的同时并行生成/更新任务专属的评测
  // criteria 与打分量表；judge 等待 fanout 与 criteria 流程都完成后才开始。
  criteriaEnabled: z.boolean().default(false),
  criteriaChangeThreshold: z.number().default(0.8),
  // Judge (verifier) 后端池：每个后端是「端点 + 密钥环境变量 + 模型」的组合，
  // 用户在 GUI 里从池中选端点与模型（不再是单一硬编码 judge）。
  judgeBackends: z.array(judgeBackendSchema).default([
    {
      id: 'tokenrouter',
      displayName: 'Token Router',
      baseUrl: 'https://tokenrouter.omgwow.tech/v1',
      apiKeyEnv: 'OWTR_DSH_KEY',
      reasoningEffort: 'off',
      supportsLogprobs: true,
      logprobsWithThinking: true,
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      ],
    },
    {
      id: 'deepseek-official',
      displayName: 'DeepSeek 官方 API',
      baseUrl: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      reasoningEffort: 'off',
      supportsLogprobs: true,
      logprobsWithThinking: true,
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
    },
  ]),
  defaultJudgeBackend: z.string().default('tokenrouter'),
  defaultJudgeModel: z.string().default('deepseek-v4-flash'),
  nEvaluations: z.natural().default(1),
  pivots: z.natural().default(1),
  // 锦标赛模式：roundrobin（完整两两、单阶段并行，小 n 默认，judge 墙钟减半）或
  // ppt（ring→pivot 两阶段近似，大 n 时把 O(N²) 降到 O(Nk)）。
  judgeMode: z.string().default('roundrobin'),
  maxWorkers: z.natural().default(16),
  maxTokens: z.natural().default(32768),
  topLogprobs: z.natural().default(20),
  // 每次 judge 调用的墙钟上限（ms）：超时即中止，该次对比随机判一方胜（见 verifier.js）。
  timeoutMs: z.natural().default(30000),
  // 短回复直取阈值（字符数）：本轮「thinking 长度」或「回答正文（text 块）+ 工具调用命令
  // （tool-call 块名+参数）」任一不超过该值时跳过 judge，直接随机选一条轨迹。短回复的 3 条
  // rollout 几乎无差异，judge 纯属浪费。
  judgeSkipUnderChars: z.natural().default(1000),
  maxStoredSteps: z.natural().default(200),
  // 请求体信息（problem/candidates/judgeCalls）默认不常驻内存：写入旁路文件
  // bodies/<sessionId>/<turn>-<step>.json，trees.json 只留轻量字段（轮询载荷从
  // ~300MB 级降到 KB 级）。页面打开某步时经 getStepBody 按需加载，关闭时经
  // releaseStepBody 清除缓存。置 true 恢复旧的 inline 常驻行为。
  retainBodies: z.boolean().default(false),
})

function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh-v2')
}

const TREES_PATH = join(dshHome(), 'storages', 'rollout-transparent', 'trees.json')

function loadJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function emptyStore() {
  return { version: 1, sessions: {} }
}

const store = loadJson(TREES_PATH) ?? emptyStore()

let writeTimer = null
function scheduleWrite() {
  if (writeTimer !== null) return
  writeTimer = setTimeout(() => {
    writeTimer = null
    try {
      mkdirSync(dirname(TREES_PATH), { recursive: true })
      writeFileSync(TREES_PATH, JSON.stringify(store, null, 2))
    } catch (error) {
      console.warn(`[dsh-rollout-transparent] 树落盘失败: ${String(error)}`)
    }
  }, 1500)
}

// ── 请求体旁路存储（默认关闭常驻：打开时加载、关闭时清除）────────────────────
// problem / candidates / judgeCalls 三个重字段（judge 请求体信息）不写进
// trees.json 常驻内存，而是按步落 bodies/<sessionId>/<turn>-<step>.json；
// getStepBody 打开时按需读取并缓存（上限 BODY_CACHE_MAX 条），releaseStepBody
// 关闭时清除缓存。树内只保留 hasBody 标记，getSessionTrees 轮询载荷降到 KB 级。
const BODIES_DIR = join(dshHome(), 'storages', 'rollout-transparent', 'bodies')
const BODY_KEYS = ['problem', 'candidates', 'judgeCalls']
const BODY_CACHE_MAX = 16
const bodyCache = new Map()

function bodyCacheKey(sessionId, turn, step) {
  return `${sessionId}|${turn}|${step}`
}

function bodyPathFor(sessionId, turn, step) {
  return join(BODIES_DIR, sessionId, `${turn}-${step}.json`)
}

function writeBodyFile(sessionId, turn, step, body) {
  const file = bodyPathFor(sessionId, turn, step)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(body))
}

function removeBodyFile(sessionId, turn, step) {
  try {
    unlinkSync(bodyPathFor(sessionId, turn, step))
  } catch {
    // 文件不存在或不可删，忽略。
  }
}

function removeSessionBodies(sessionId) {
  try {
    rmSync(join(BODIES_DIR, sessionId), { recursive: true, force: true })
  } catch {
    // 目录不存在或不可删，忽略。
  }
}

function extractBody(step) {
  const body = {}
  let has = false
  for (const k of BODY_KEYS) {
    if (step[k] !== undefined) {
      body[k] = step[k]
      has = true
    }
  }
  return has ? body : null
}

/** 启动迁移：把历史 trees.json 里 inline 的重字段拆到旁路文件并压缩重写。 */
function migrateInlineBodies() {
  let migrated = 0
  for (const session of Object.values(store.sessions ?? {})) {
    if (!Array.isArray(session.steps)) continue
    for (const step of session.steps) {
      if (!step || typeof step !== 'object') continue
      const body = extractBody(step)
      if (!body) continue
      writeBodyFile(session.id, step.turn, step.step, body)
      for (const k of BODY_KEYS) delete step[k]
      step.hasBody = true
      migrated++
    }
  }
  if (migrated > 0) {
    mkdirSync(dirname(TREES_PATH), { recursive: true })
    writeFileSync(TREES_PATH, JSON.stringify(store, null, 2))
    console.warn(`[dsh-rollout-transparent] 请求体已迁移到旁路文件: ${migrated} 步（trees.json 已压缩重写）`)
  }
}

function recordStep(sessionId, step, maxStoredSteps) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return
  const session = store.sessions[sessionId] ?? (store.sessions[sessionId] = { id: sessionId, at: 0, steps: [] })
  // 请求体信息默认不常驻：拆出旁路落盘，树里只留 hasBody 标记。
  if (activeConfig?.retainBodies !== true) {
    const body = extractBody(step)
    if (body) {
      writeBodyFile(sessionId, step.turn, step.step, body)
      for (const k of BODY_KEYS) delete step[k]
      step.hasBody = true
    }
  }
  session.steps.unshift(step)
  const dropped = session.steps.splice(maxStoredSteps)
  for (const old of dropped) {
    if (old?.hasBody) removeBodyFile(sessionId, old.turn, old.step)
  }
  session.at = step.at
  const ids = Object.keys(store.sessions)
  if (ids.length > 200) {
    ids.sort((a, b) => (store.sessions[b].at ?? 0) - (store.sessions[a].at ?? 0))
    for (const id of ids.slice(200)) {
      delete store.sessions[id]
      removeSessionBodies(id)
    }
  }
  scheduleWrite()
}

// ── 动态 Criteria 存储（独立于 trees.json，按会话隔离）────────────────────
// 每个会话持久化「当前生效的 criteria + 打分量表」；生成/更新时写回，变更检测
// 的输入就是这里的 text 与该轮用户输入。
const CRITERIA_PATH = join(dshHome(), 'storages', 'rollout-transparent', 'criteria.json')
const criteriaStore = loadJson(CRITERIA_PATH) ?? { version: 1, sessions: {} }

let criteriaWriteTimer = null
function scheduleCriteriaWrite() {
  if (criteriaWriteTimer !== null) return
  criteriaWriteTimer = setTimeout(() => {
    criteriaWriteTimer = null
    try {
      mkdirSync(dirname(CRITERIA_PATH), { recursive: true })
      writeFileSync(CRITERIA_PATH, JSON.stringify(criteriaStore, null, 2))
    } catch (error) {
      console.warn(`[dsh-rollout-transparent] criteria 落盘失败: ${String(error)}`)
    }
  }, 1500)
}

// ── 主会话最近一次 llm/stream 的上下文（/criteria 命令据此重新生成）──────────
// 只记录主会话（子代理不在此列；见 llm/stream 监听器里的 pending 判定）。键为
// sessionId（== agent.id），值为该步 options.messages 与稳定 agentId。
// 持久化到 context.json：实例重启后 /criteria 仍能为既有会话重新生成。
const CONTEXT_PATH = join(dshHome(), 'storages', 'rollout-transparent', 'context.json')
const CONTEXT_MAX_SESSIONS = 32
const CONTEXT_MAX_BYTES = 400 * 1024 // 每会话消息 JSON 上限（超出则裁剪尾部）
const lastSessionContext = new Map() // sid -> { messages, agentId }

function loadContext() {
  const data = loadJson(CONTEXT_PATH)
  if (!data || typeof data !== 'object' || typeof data.sessions !== 'object') return
  for (const [sid, rec] of Object.entries(data.sessions)) {
    if (!rec || !Array.isArray(rec.messages)) continue
    lastSessionContext.set(sid, { messages: rec.messages, agentId: sid })
  }
}

let contextWriteTimer = null
function scheduleContextWrite() {
  if (contextWriteTimer !== null) return
  contextWriteTimer = setTimeout(() => {
    contextWriteTimer = null
    try {
      const sessions = {}
      for (const [sid, rec] of lastSessionContext) {
        if (!Array.isArray(rec.messages)) continue
        let messages = rec.messages
        let bytes = JSON.stringify(messages).length
        // 超出预算时裁剪最旧消息，保留最近上下文
        while (bytes > CONTEXT_MAX_BYTES && messages.length > 4) {
          messages = messages.slice(Math.ceil(messages.length / 2))
          bytes = JSON.stringify(messages).length
        }
        sessions[sid] = { at: Date.now(), messages }
      }
      mkdirSync(dirname(CONTEXT_PATH), { recursive: true })
      writeFileSync(CONTEXT_PATH, JSON.stringify({ version: 1, sessions }, null, 2))
    } catch (error) {
      console.warn(`[dsh-rollout-transparent] 上下文落盘失败: ${String(error)}`)
    }
  }, 2000)
}

function recordSessionContext(sid, messages) {
  lastSessionContext.set(sid, { messages, agentId: sid })
  if (lastSessionContext.size > CONTEXT_MAX_SESSIONS) {
    const oldest = lastSessionContext.keys().next().value
    if (oldest !== undefined) lastSessionContext.delete(oldest)
  }
  scheduleContextWrite()
}
// ── 主会话最近一次 llm/stream 的用量/计时（非 rollout 模式的 stats 展示）──────
// 无论 rollout 开启与否，主会话每次 llm/stream（透传与 fanout）都会更新。
const lastStreamStatsBySession = new Map() // sid -> { ttftMs, outputTokens, wallMs, model, at }

const SETTINGS_PATH = join(dshHome(), 'storages', 'rollout-transparent', 'settings.json')

/**
 * 按会话（sessionId）隔离的运行时设置。每个会话独立保存 rollout 开关、轨迹数与
 * judge 端点/模型选择；新会话用配置默认值（旧版全局扁平设置迁移后成为 defaults）
 * 初始化，之后各会话互不影响。settings.json 存为
 * `{ version: 2, defaults: {...}, sessions: { [sessionId]: {...} } }`。
 */
let settingsStore = { version: 2, defaults: null, sessions: {} }
let activeConfig = null

function loadSettings() {
  return loadJson(SETTINGS_PATH) ?? {}
}

let settingsWriteTimer = null
function scheduleSettingsWrite() {
  if (settingsWriteTimer !== null) return
  settingsWriteTimer = setTimeout(() => {
    settingsWriteTimer = null
    try {
      mkdirSync(dirname(SETTINGS_PATH), { recursive: true })
      writeFileSync(SETTINGS_PATH, JSON.stringify(settingsStore, null, 2))
    } catch (error) {
      console.warn(`[dsh-rollout-transparent] 设置落盘失败: ${String(error)}`)
    }
  }, 500)
}

function judgeBackendById(id) {
  const pool = Array.isArray(activeConfig?.judgeBackends) ? activeConfig.judgeBackends : []
  return pool.find((b) => b.id === id) ?? pool[0] ?? null
}

/** 当前选中的 judge 后端（按会话解析 baseUrl/apiKeyEnv/model/reasoningEffort）。 */
function getJudgeBackend(sessionId) {
  return judgeBackendById(getSessionSettings(sessionId)?.judgeBackendId)
}

function normalizeSessionSettings(s) {
  const b = judgeBackendById(s.judgeBackendId)
  const backendId = b?.id ?? ''
  const modelIds = (Array.isArray(b?.models) ? b.models : []).map((m) => m.id)
  const judgeModel = modelIds.includes(s.judgeModel) ? s.judgeModel : (modelIds[0] ?? '')
  return {
    enabled: Boolean(s.enabled),
    rolloutCount: Math.max(1, Math.min(64, Math.floor(Number(s.rolloutCount) || 1))),
    judgeBackendId: backendId,
    judgeModel,
    criteriaEnabled: Boolean(s.criteriaEnabled),
  }
}

/** 新会话的默认设置（迁移/配置计算得出，apply 时已写入 settingsStore.defaults）。 */
function sessionDefaults() {
  // 归一化补全缺失字段（旧版 defaults 可能没有 criteriaEnabled），并返回新对象。
  return normalizeSessionSettings(settingsStore.defaults ?? {})
}

/** 某个会话的运行时设置（不存在则返回默认值；读取不落盘，仅在显式修改时才持久化）。 */
function getSessionSettings(sessionId) {
  const sid = typeof sessionId === 'string' ? sessionId : ''
  if (!sid) return sessionDefaults()
  // 每次读取都归一化：补全旧版会话设置缺失的字段（如 criteriaEnabled），
  // 否则 getSettings 返回 undefined，会被 Typert 边界 schema 校验拒绝。
  return normalizeSessionSettings(settingsStore.sessions[sid] ?? sessionDefaults())
}

/** 暴露给客户端的会话只读设置视图（含 judge 后端池与 logprobs 能力标记，不含密钥）。 */
function getSettings(sessionId) {
  const s = getSessionSettings(sessionId)
  return {
    enabled: s.enabled,
    rolloutCount: s.rolloutCount,
    judgeBackendId: s.judgeBackendId,
    judgeModel: s.judgeModel,
    criteriaEnabled: s.criteriaEnabled,
    criteriaChangeThreshold: Number(activeConfig?.criteriaChangeThreshold) || 0.8,
    judgeBackends: (Array.isArray(activeConfig?.judgeBackends) ? activeConfig.judgeBackends : []).map((b) => ({
      id: b.id,
      displayName: b.displayName,
      baseUrl: b.baseUrl,
      supportsLogprobs: b.supportsLogprobs,
      logprobsWithThinking: b.logprobsWithThinking,
      models: (Array.isArray(b.models) ? b.models : []).map((m) => ({ id: m.id, name: m.name })),
    })),
  }
}

/** 应用某会话的一个部分更新，校验并持久化，返回该会话的新设置视图。 */
function updateSettings(sessionId, patch) {
  const sid = typeof sessionId === 'string' ? sessionId : ''
  if (!sid) return getSettings(sid)
  if (!settingsStore.sessions[sid]) settingsStore.sessions[sid] = sessionDefaults()
  else settingsStore.sessions[sid] = normalizeSessionSettings(settingsStore.sessions[sid])
  const s = settingsStore.sessions[sid]
  const p = patch ?? {}
  if (p.enabled !== undefined) s.enabled = Boolean(p.enabled)
  if (p.rolloutCount !== undefined) {
    const n = Number(p.rolloutCount)
    if (Number.isInteger(n) && n >= 1 && n <= 64) s.rolloutCount = n
  }
  if (p.judgeBackendId !== undefined) {
    const b = judgeBackendById(p.judgeBackendId)
    if (b) {
      s.judgeBackendId = b.id
      const modelIds = (Array.isArray(b.models) ? b.models : []).map((m) => m.id)
      if (!modelIds.includes(s.judgeModel)) s.judgeModel = modelIds[0] ?? ''
    }
  }
  if (p.judgeModel !== undefined) {
    const b = judgeBackendById(s.judgeBackendId)
    const modelIds = (Array.isArray(b?.models) ? b.models : []).map((m) => m.id)
    if (modelIds.includes(p.judgeModel)) s.judgeModel = p.judgeModel
  }
  if (p.criteriaEnabled !== undefined) s.criteriaEnabled = Boolean(p.criteriaEnabled)
  scheduleSettingsWrite()
  return getSettings(sid)
}

/** Rollout 树服务 + 运行时设置服务（经 Typert 暴露给客户端）。 */
/** 轮询/列表视图只回轻量字段：重字段（请求体）一律剥离，避免 3s 轮询传输大载荷。 */
function lightStep(step) {
  const out = { ...step }
  for (const k of BODY_KEYS) delete out[k]
  return out
}

const service = {
  getSessionTrees(sessionId) {
    const session = store.sessions[sessionId]
    if (!session) return { id: sessionId, steps: [] }
    return { id: session.id, steps: session.steps.map(lightStep) }
  },
  /** 打开某步时按需加载请求体（旁路文件优先，兼容 inline 旧数据），带 LRU 缓存。 */
  getStepBody(sessionId, turn, step) {
    const sid = typeof sessionId === 'string' ? sessionId : ''
    if (!sid) return null
    const key = bodyCacheKey(sid, turn, step)
    if (bodyCache.has(key)) return bodyCache.get(key)
    let body = null
    if (typeof turn === 'number' && typeof step === 'number') {
      const file = bodyPathFor(sid, turn, step)
      if (existsSync(file)) {
        try {
          body = JSON.parse(readFileSync(file, 'utf8'))
        } catch (error) {
          console.warn(`[dsh-rollout-transparent] 读取旁路请求体失败 ${file}: ${String(error)}`)
        }
      }
    }
    if (!body) {
      const inline = store.sessions[sid]?.steps?.find((s) => s?.turn === turn && s?.step === step)
      body = inline ? extractBody(inline) : null
    }
    if (body) {
      bodyCache.set(key, body)
      while (bodyCache.size > BODY_CACHE_MAX) bodyCache.delete(bodyCache.keys().next().value)
    }
    return body
  },
  /** 关闭某步时清除其内存缓存（旁路文件保留，可再次按需加载）。 */
  releaseStepBody(sessionId, turn, step) {
    const sid = typeof sessionId === 'string' ? sessionId : ''
    if (sid) bodyCache.delete(bodyCacheKey(sid, turn, step))
    return { released: true }
  },
  getSettings(sessionId) {
    return getSettings(sessionId)
  },
  setSettings(sessionId, patch) {
    return updateSettings(sessionId, patch)
  },
  /** 最近一次主会话 llm/stream 的用量/计时（非 rollout 模式的 stats 展示）。 */
  getSessionStreamStats(sessionId) {
    const sid = typeof sessionId === 'string' ? sessionId : ''
    return lastStreamStatsBySession.get(sid) ?? null
  },
}

Object.defineProperty(service, 'typertRemote', {
  configurable: false,
  enumerable: false,
  writable: false,
  value: { service, serviceKey: 'rolloutTree', namespace: 'rolloutTree' },
})

/** 把一个 ContentBlock 渲染为 judge/展示用的纯文本。 */
function renderBlock(block) {
  if (!block || typeof block !== 'object') return ''
  switch (block.type) {
    case 'text':
      return String(block.text ?? '')
    case 'reasoning':
      return `[thinking]\n${String(block.text ?? '')}`
    case 'tool-call':
      return `[tool_call:${String(block.name ?? '')}]\n${String(block.arguments ?? '')}`
    case 'tool-result': {
      const content = Array.isArray(block.content)
        ? block.content.map(renderBlock).join('\n')
        : String(block.content ?? '')
      return `[tool_result]\n${content}`
    }
    default:
      return ''
  }
}

function renderBlocks(blocks) {
  return (Array.isArray(blocks) ? blocks : []).map(renderBlock).join('\n').trim()
}

/** 从一条 rollout 的 chunk 数组拼出候选文本（block-end 携带已组装块）。 */
function assembleCandidate(chunks) {
  const blocks = []
  for (const chunk of chunks) {
    if (chunk !== null && chunk !== undefined && chunk.type === 'block-end' && chunk.block !== undefined) {
      blocks.push(chunk.block)
    }
  }
  const text = renderBlocks(blocks)
  return { text, preview: text.slice(0, 500) }
}

/**
 * 一条 rollout 的长度画像（字符数）：
 *  - answerTool = text 块（回答正文）+ tool-call 块（命令名 + 参数）
 *  - thinking   = reasoning([thinking]) 块正文
 * 短回复直取的预判输入：thinking ≤ 阈值 或 answerTool ≤ 阈值（任一生效）即跳过 judge。
 */
function measureResponse(chunks) {
  let answerTool = 0
  let thinking = 0
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    if (chunk === null || chunk === undefined || chunk.type !== 'block-end' || !chunk.block) continue
    const b = chunk.block
    if (b.type === 'text') {
      answerTool += String(b.text ?? '').length
    } else if (b.type === 'tool-call') {
      answerTool += String(b.name ?? '').length + String(b.arguments ?? '').length
    } else if (b.type === 'reasoning') {
      thinking += String(b.text ?? '').length
    }
  }
  return { answerTool, thinking }
}

/** 从一条 rollout 的 chunk 数组里取最后一条 usage（outputTokens 用于 FinalOut TPS）。 */
function extractUsageTokens(chunks) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  let usage = null
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    if (chunk !== null && chunk !== undefined && chunk.type === 'usage' && chunk.usage && typeof chunk.usage === 'object') {
      usage = chunk.usage
    }
  }
  return { inputTokens: num(usage?.inputTokens), outputTokens: num(usage?.outputTokens) }
}

/** 从 judgeCalls 汇总 judge 泳道 tooltip 所需聚合：平均 input/output 长度 + 总墙钟。 */
function computeJudgeAgg(calls) {
  const arr = Array.isArray(calls) ? calls : []
  const n = arr.length
  if (n === 0) return null
  let inSum = 0
  let outSum = 0
  let msSum = 0
  for (const c of arr) {
    inSum += Number(c?.inputTokens) || 0
    outSum += Number(c?.outputTokens) || 0
    msSum += Number(c?.wallMs) || 0
  }
  return { avgInputTokens: inSum / n, avgOutputTokens: outSum / n, totalMs: msSum }
}

/** 把循环请求的消息历史渲染为 judge 的 problem（不含 system prompt）。 */
function renderProblem(messages) {
  const lines = []
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!msg || typeof msg !== 'object') continue
    const body = renderBlocks(msg.content)
    if (!body) continue
    if (msg.role === 'system') continue
    const tag = msg.role === 'assistant' ? 'ASSISTANT' : msg.role === 'user' ? 'USER' : 'TOOL'
    lines.push(`${tag}:\n${body}`)
  }
  return lines.join('\n\n')
}

/** 是否为 token 增量 chunk（用于测量「首 token → 末 chunk」的真实解码耗时）。 */
function isDeltaChunk(chunk) {
  return chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta'
}

/** 完整缓冲一条流的所有 chunk（LlmRuntime 已把异常规范为 error/aborted finish）。 */
async function bufferStream(stream) {
  const t0 = Date.now()
  const chunks = []
  let firstTokenAt = null
  let lastChunkAt = null
  let lastReasoningAt = null
  try {
    for await (const chunk of stream) {
      if (chunk !== null && chunk !== undefined) {
        chunks.push(chunk)
        if (chunk.type === 'reasoning-delta') lastReasoningAt = Date.now()
        if (firstTokenAt === null && isDeltaChunk(chunk)) firstTokenAt = Date.now()
        lastChunkAt = Date.now()
      }
    }
  } catch (error) {
    // Defensive: LlmRuntime.stream() 已把适配器异常折叠为终端 finish；此处兜底。
    chunks.push({ type: 'finish', reason: { kind: 'error', failure: { message: String(error), code: 'rollout-stream-error' } } })
    lastChunkAt = Date.now()
  }
  const wallMs = Math.max(0, Date.now() - t0)
  const decodeMs = firstTokenAt !== null && lastChunkAt !== null ? Math.max(0, lastChunkAt - firstTokenAt) : null
  const ttftMs = firstTokenAt !== null ? Math.max(0, firstTokenAt - t0) : null
  // 推理阶段时长：最后一个 reasoning-delta 相对流起点的墙钟（无 reasoning 则为 0）。
  const reasoningMs = lastReasoningAt !== null ? Math.max(0, lastReasoningAt - t0) : 0
  const usage = extractUsageTokens(chunks)
  return { chunks, decodeMs, wallMs, ttftMs, reasoningMs, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
}

/**
 * 透传一条主会话流并顺带记录其用量/计时（非 rollout 模式 stats 展示用）。
 * 与 bufferStream 不同：不缓冲全部 chunk，而是逐 chunk 转发（避免为统计而把
 * 主会话流整段滞留内存）。finally 保证结束/中止/异常时都落一条最近记录。
 */
async function* observeStreamStats(stream, sid, model) {
  const t0 = Date.now()
  let firstTokenAt = null
  let outputTokens = 0
  try {
    for await (const chunk of stream) {
      if (chunk !== null && chunk !== undefined) {
        if (firstTokenAt === null && isDeltaChunk(chunk)) firstTokenAt = Date.now()
        if (chunk.type === 'usage' && chunk.usage && typeof chunk.usage === 'object') {
          outputTokens = Number(chunk.usage.outputTokens) || 0
        }
      }
      yield chunk
    }
  } finally {
    const wallMs = Math.max(0, Date.now() - t0)
    const ttftMs = firstTokenAt !== null ? Math.max(0, firstTokenAt - t0) : null
    lastStreamStatsBySession.set(sid, { ttftMs, outputTokens, wallMs, model, at: Date.now() })
  }
}

/** 把 judge 直连 fetch 汇总出的用量映射为 tokenrouter-cost 的计费桶。 */
function judgeUsageToBuckets(ju) {
  if (!ju || typeof ju !== 'object') return null
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  const hit = num(ju.cacheHitTokens)
  const miss = num(ju.cacheMissTokens)
  const prompt = num(ju.promptTokens)
  return {
    input: miss > 0 ? miss : Math.max(0, prompt - hit),
    output: num(ju.completionTokens),
    cacheRead: hit,
    cacheWrite: 0,
  }
}

/** 把 judge 的实际用量补记到 tokenrouter-cost 账本（judge 直连绕过 ctx.llm，不会被自动计费）。 */
function accountJudgeUsage(ctx, sessionId, model, judgeUsage) {
  const buckets = judgeUsageToBuckets(judgeUsage)
  if (!buckets || buckets.input + buckets.output + buckets.cacheRead + buckets.cacheWrite === 0) return
  try {
    const cost = ctx.get('tokenrouterCost')
    if (cost && typeof cost.accountUsage === 'function') {
      cost.accountUsage(buckets, model, sessionId)
    }
  } catch (error) {
    ctx.logger?.warn?.(`[rollout-transparent] judge 计费失败: ${String(error)}`)
  }
}

// ── 动态 Criteria：生成 / 变更检测 / 编排 ──────────────────────────────────

/** 提取 messages 里最后一条 user 消息的纯文本（变更检测的「当轮输入」）。 */
function lastUserMessage(messages) {
  const arr = Array.isArray(messages) ? messages : []
  for (let i = arr.length - 1; i >= 0; i--) {
    const msg = arr[i]
    if (msg && msg.role === 'user') {
      const body = renderBlocks(msg.content)
      if (body) return body
    }
  }
  return ''
}

/** 从模型输出里稳健地抽出首个 JSON 对象（容忍代码围栏与前后说明文字）。 */
function parseCriteriaJson(text) {
  if (typeof text !== 'string') return null
  let s = text.replace(/```json/gi, '').replace(/```/g, '')
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  s = s.slice(start, end + 1)
  try {
    const obj = JSON.parse(s)
    const criteria = normalizeCriteria(obj.criteria)
    const rubric = typeof obj.rubric === 'string' && obj.rubric.trim() ? obj.rubric.trim() : ''
    if (criteria.length === 0) return null
    return { criteria, rubric }
  } catch {
    return null
  }
}

function buildCriteriaPrompt(fullHistory) {
  return [
    'You are designing the evaluation rubric that a separate judge will use to rank',
    'candidate agent trajectories for the task in the conversation history below.',
    '',
    'Produce a precise, task-specific rubric. Output ONLY a single JSON object (no markdown',
    'fences, no commentary) with exactly these two keys:',
    '  - "criteria": an array of 1-3 objects, each {"name": "<snake_case id>", "description": "<one specific question the judge answers about a candidate trajectory>"}',
    '  - "rubric": a string describing how to map performance to the 20-point letter scale',
    '    A (best) through T (worst), tailored to this task.',
    '',
    '**Conversation history:**',
    fullHistory,
  ].join('\n')
}

function buildChangePrompt(prevCriteriaText, userInput) {
  return [
    'You are deciding whether a task\'s evaluation rubric still applies after a new user message.',
    '',
    '**Current evaluation rubric (criteria + scale):**',
    prevCriteriaText,
    '',
    '**Latest user message:**',
    userInput,
    '',
    'Reason about whether the user\'s goal has changed enough to require regenerating the rubric,',
    'then END your reply with exactly this line and nothing after it:',
    '<change> LETTER_A_TO_T </change>',
    '',
    CHANGE_SCALE_DESCRIPTION,
  ].join('\n')
}

/** 生成 criteria：输入全量历史（renderProblem 产物，含 system 之外的完整对话）。 */
async function generateCriteria(api, settings, options, fullHistory) {
  const t0 = Date.now()
  // 超长历史（10 万+ 事件的对话）会让 judge 复述对话而非输出 JSON：截断到尾部窗口，
  // 并在解析失败时用纠正指令重试一次。
  const MAX_HISTORY_CHARS = 60000
  const history = fullHistory.length > MAX_HISTORY_CHARS
    ? '[…更早的历史已截断…]\n' + fullHistory.slice(-MAX_HISTORY_CHARS)
    : fullHistory
  let prompt = buildCriteriaPrompt(history)
  let res = await api.call(prompt, settings.judgeModel, options.signal, options.sessionId)
  let parsed = parseCriteriaJson(res.text)
  if (!parsed) {
    prompt = '你上一次的输出不是合法 JSON，无法解析。请严格只输出一个 JSON 对象（不要 markdown 围栏、不要复述对话、不要任何其它文字），键为 criteria 与 rubric。\n' + history
    res = await api.call(prompt, settings.judgeModel, options.signal, options.sessionId)
    parsed = parseCriteriaJson(res.text)
  }
  if (!parsed) {
    throw new Error(`criteria 生成结果无法解析为 JSON（前 200 字: ${String(res.text ?? '').slice(0, 200)}）`)
  }
  return {
    text: String(res.text ?? '').trim(),
    criteria: parsed.criteria,
    rubric: parsed.rubric,
    ttftMs: res.ttftMs ?? null,
    usage: res.usage ?? null,
    wallMs: Date.now() - t0,
  }
}

/** 变更检测：输入「既有 criteria + 当轮用户输入」，读 <change> 处的 logprobs 期望。 */
async function detectChange(api, settings, options, prevText, userInput) {
  const t0 = Date.now()
  const prompt = buildChangePrompt(prevText, userInput)
  const res = await api.call(prompt, settings.judgeModel, options.signal, options.sessionId)
  const score = extractScore(res.text, res.tokens, res.positionLogprobs, '<change>')
  return {
    score,
    ttftMs: res.ttftMs ?? null,
    usage: res.usage ?? null,
    wallMs: Date.now() - t0,
  }
}

/**
 * 动态 Criteria 编排（与 fanout 并行）。首步（该会话尚无 criteria）无条件生成
 * （即便 criteriaEnabled 开关关闭）；后续步骤一律沿用既有 criteria，不再做每步
 * 变更检测（只有 /criteria 命令会重新生成）。返回给 judge 用的 criteria/rubric
 * 与用于甘特图/计费的计时数据。
 */
async function ensureCriteria(ctx, api, settings, options) {
  const sid = options.sessionId
  const t0 = Date.now()
  const out = {
    enabled: Boolean(settings.criteriaEnabled),
    action: 'off',
    changed: false,
    changeScore: null,
    wallMs: 0,
    ttftMs: null,
    completionTokens: 0,
    callMsSum: 0,
    error: '',
    criteria: null,
    rubric: null,
    usage: null,
  }

  const prev = criteriaStore.sessions[sid] ?? null
  const isFirstStep = !prev || !prev.text
  // 新机制：首步必生成、之后保持不变、/criteria 手动重判。enabled 反映的是
  // criteria 的实际活动（首步生成/命中），不再沿用独立开关，避免与行为不一致。
  out.enabled = isFirstStep
  const fullHistory = renderProblem(options.messages)
  const critUsage = { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 }
  let gen = null

  try {
    if (isFirstStep) {
      gen = await generateCriteria(api, settings, options, fullHistory)
      out.action = 'generated'
      out.changed = true
    } else {
      out.action = 'unchanged'
      out.criteria = prev.criteria ?? null
      out.rubric = prev.rubric ?? null
    }

    if (gen) {
      out.criteria = gen.criteria
      out.rubric = gen.rubric
      out.ttftMs = gen.ttftMs ?? out.ttftMs
      out.callMsSum += gen.wallMs
      addUsage(critUsage, gen.usage)
      criteriaStore.sessions[sid] = {
        id: sid,
        at: Date.now(),
        text: gen.text,
        criteria: gen.criteria,
        rubric: gen.rubric,
      }
      scheduleCriteriaWrite()
    }
  } catch (error) {
    out.error = String(error)
    out.criteria = prev?.criteria ?? null
    out.rubric = prev?.rubric ?? null
    ctx.logger?.warn?.(`[rollout-transparent] criteria 流程失败，回退既有 criteria: ${out.error}`)
  }

  out.usage = critUsage
  out.completionTokens = critUsage.completionTokens
  out.wallMs = Date.now() - t0
  // 计费：criteria 走直连 fetch（绕过 ctx.llm），按会话补记到 tokenrouter-cost 账本。
  accountJudgeUsage(ctx, sid, settings.judgeModel, critUsage)
  return out
}

/**
 * 无感 best-of-N 主流程：并行 N 条 rollout → judge 选优 → 落盘树 → 重放胜者 chunk。
 * 作为 `llm/stream` 的短路监听器返回（不调用 next()，因此胜者之外的请求不会进入
 * 下游适配器，也不会被 tokenrouter-cost 二次计费）。
 */
async function* rolloutStream(ctx, options, config, api, settings, turn, step) {
  const n = settings.rolloutCount
  const t0 = Date.now()
  const subRequests = Array.from({ length: n }, () => ({
    ...options,
    temperature: config.rolloutTemperature,
  }))

  // 并行触发 N 条 rollout（每条经 ctx.llm.stream 重入瀑布，因 pendingSteps 已弹出、
  // 且无 purpose，直接透传到适配器）。bufferStream 顺带测量每条的真实解码耗时，
  // 因为后面重放是同步的，事件时间会失真。
  // 动态 Criteria 特性开启时，criteria 生成/更新流程与 fanout 完全并行；judge 等待
  // 两者都完成后才开始（结算点 judgeStartMs = max(fanoutMs, criteriaWallMs)）。
  const fanoutPromise = Promise.all(subRequests.map((sub) => bufferStream(ctx.llm.stream(sub)))).then((results) => ({
    results,
    fanoutMs: Date.now() - t0,
  }))
  const criteriaPromise = ensureCriteria(ctx, api, settings, options)
  const [{ results, fanoutMs }, criteriaResult] = await Promise.all([fanoutPromise, criteriaPromise])
  const rolloutDecodeMs = results.map((r) => r.decodeMs ?? null)
  const rolloutWallMs = results.map((r) => r.wallMs ?? null)
  const rolloutTtftMs = results.map((r) => r.ttftMs ?? null)
  const rolloutReasoningMs = results.map((r) => Number(r.reasoningMs) || 0)
  const rolloutUsage = results.map((r) => ({ inputTokens: Number(r.inputTokens) || 0, outputTokens: Number(r.outputTokens) || 0 }))
  const criteriaWallMs = criteriaResult.wallMs ?? 0
  const judgeStartMs = Math.max(fanoutMs, criteriaWallMs)

  const candidates = results.map((r) => assembleCandidate(r.chunks))
  const candidateTexts = candidates.map((c) => c.text)
  const problem = renderProblem(options.messages)

  let selected = 0
  let scores = new Array(n).fill(0)
  let ranking = Array.from({ length: n }, (_, i) => i)
  let nComparisons = 0
  let judgeError = ''
  let judgeUsage = null
  let judgeTiming = null
  let judgeSkipped = false
  let judgeCalls = []
  let perCriterion = []

  // 短回复直取：thinking ≤ 阈值 或「回答正文 + 工具调用命令」≤ 阈值（任一生效即跳过；
  // 均取 3 条 rollout 的最大值，即只有全部都很短才跳过），跳过 judge 直接随机选一条，
  // 省掉整轮 judge 的 token 与墙钟。
  const answerToolLen = results.reduce((m, r) => Math.max(m, measureResponse(r.chunks).answerTool), 0)
  const thinkingLen = results.reduce((m, r) => Math.max(m, measureResponse(r.chunks).thinking), 0)
  const threshold = Number(config.judgeSkipUnderChars ?? 0)
  const skipJudge = thinkingLen <= threshold || answerToolLen <= threshold

  if (skipJudge) {
    selected = Math.floor(Math.random() * n)
    judgeSkipped = true
  } else {
    try {
      const judge = await selectBest(api, {
        problem,
        candidates: candidateTexts,
        criteria: Array.isArray(criteriaResult.criteria) && criteriaResult.criteria.length > 0
          ? criteriaResult.criteria
          : undefined,
        scaleDescription: criteriaResult.rubric ? criteriaResult.rubric : undefined,
        nEvaluations: config.nEvaluations,
        pivots: config.pivots,
        judgeMode: config.judgeMode,
        seed: 0,
        model: settings.judgeModel,
        maxWorkers: config.maxWorkers,
        timeoutMs: config.timeoutMs,
        signal: options.signal,
        sessionId: options.sessionId,
      })
      selected = Math.min(Math.max(judge.index ?? 0, 0), n - 1)
      scores = Array.isArray(judge.scores) ? judge.scores : scores
      ranking = Array.isArray(judge.ranking) ? judge.ranking : ranking
      nComparisons = judge.n_comparisons ?? 0
      judgeUsage = judge.judgeUsage ?? null
      judgeTiming = judge.judgeTiming ?? null
      judgeCalls = Array.isArray(judge.judgeCalls) ? judge.judgeCalls : []
      perCriterion = Array.isArray(judge.per_criterion) ? judge.per_criterion : []
    } catch (error) {
      judgeError = String(error)
      ctx.logger?.warn?.(`[rollout-transparent] t${turn}/s${step} judge 失败，回退候选 #0: ${judgeError}`)
    }
  }

  const totalMs = Date.now() - t0

  // TPS 统计（按用户口径分两种）：
  //  - FinalOut TPS = 最终选中轨迹的 output tokens（含 reasoning）/ 该轨迹总推理墙钟时长（秒）。
  //  - Judge TPS    = 并发 n 个 judge 任务的 completion tokens 之和 / 各任务墙钟时长之和（秒）。
  const winnerDecodeMs = rolloutDecodeMs[selected] ?? null
  const winnerWallMs = rolloutWallMs[selected] ?? null
  const winnerUsage = extractUsageTokens(results[selected]?.chunks)
  const finalOutTps = winnerWallMs != null && winnerWallMs > 0
    ? winnerUsage.outputTokens / (winnerWallMs / 1000)
    : null
  // 首 token 时延（fanout 阶段）= 胜者轨迹墙钟时长 − 真实解码时长（首 token → 末 chunk）。
  const fanoutTtftMs = winnerWallMs != null && winnerDecodeMs != null
    ? Math.max(0, winnerWallMs - winnerDecodeMs)
    : null
  const judgeCallMsSum = Array.isArray(judgeTiming?.callMs)
    ? judgeTiming.callMs.reduce((s, x) => s + (Number.isFinite(Number(x)) ? Number(x) : 0), 0)
    : 0
  const judgeCompletionTokens = Number(judgeUsage?.completionTokens) || 0
  const judgeTps = judgeCallMsSum > 0 ? judgeCompletionTokens / (judgeCallMsSum / 1000) : null
  // 首 token 时延（judge 阶段）= 各 judge 任务首 token 时延的均值。
  const judgeTtftArr = (Array.isArray(judgeTiming?.callTtftMs) ? judgeTiming.callTtftMs : [])
    .filter((x) => Number.isFinite(Number(x)))
  const judgeTtftMsAvg = judgeTtftArr.length > 0
    ? judgeTtftArr.reduce((s, x) => s + Number(x), 0) / judgeTtftArr.length
    : null
  const criteriaTps = criteriaResult.callMsSum > 0
    ? criteriaResult.completionTokens / (criteriaResult.callMsSum / 1000)
    : null

  // fanout 也更新最近一条主会话流统计（与透传路径保持一致口径）。
  lastStreamStatsBySession.set(options.sessionId, {
    ttftMs: fanoutTtftMs,
    outputTokens: winnerUsage.outputTokens,
    wallMs: winnerWallMs,
    model: options.model ?? '',
    at: Date.now(),
  })

  // judge 走直连 fetch（绕过 ctx.llm），不会进入 tokenrouter-cost 的 llm/stream
  // 包装器，这里把 judge 的实际用量按会话补记到计费账本。
  accountJudgeUsage(ctx, options.sessionId, settings.judgeModel, judgeUsage)

  const judgeAgg = computeJudgeAgg(judgeCalls)

  recordStep(options.sessionId, {
    turn,
    step,
    at: Date.now(),
    model: options.model,
    n,
    selected,
    scores: scores.map((s) => Number(Number(s).toFixed(4))),
    ranking,
    nComparisons,
    judgeError,
    judgeSkipped,
    answerToolLen,
    thinkingLen,
    judgeCalls,
    perCriterion,
    judgeModel: settings.judgeModel,
    judgeBackendId: settings.judgeBackendId,
    problem,
    candidates: candidates.map((c) => ({ text: c.text, preview: c.preview })),
    timing: {
      fanoutMs,
      criteriaWallMs: criteriaWallMs === 0 ? 0 : Number(criteriaWallMs.toFixed(0)),
      criteriaTtftMs: criteriaResult.ttftMs === null ? null : Number(criteriaResult.ttftMs.toFixed(0)),
      judgeStartMs: Number(judgeStartMs.toFixed(0)),
      totalMs,
      winnerDecodeMs,
      winnerWallMs,
      fanoutTtftMs: fanoutTtftMs === null ? null : Number(fanoutTtftMs.toFixed(0)),
      judgeTtftMsAvg: judgeTtftMsAvg === null ? null : Number(judgeTtftMsAvg.toFixed(0)),
      decodeMs: rolloutDecodeMs,
      wallMs: rolloutWallMs,
      ttftMs: rolloutTtftMs,
      reasoningMs: rolloutReasoningMs,
      judgeTiming,
    },
    winnerUsage,
    judgeUsage,
    usage: rolloutUsage,
    judgeAgg,
    tps: {
      finalOutTps: finalOutTps === null ? null : Number(finalOutTps.toFixed(2)),
      judgeTps: judgeTps === null ? null : Number(judgeTps.toFixed(2)),
      judgeCompletionTokens,
      judgeCallMsSum,
    },
    criteria: {
      enabled: criteriaResult.enabled,
      action: criteriaResult.action,
      changed: criteriaResult.changed,
      changeScore: criteriaResult.changeScore === null ? null : Number(Number(criteriaResult.changeScore).toFixed(4)),
      names: Array.isArray(criteriaResult.criteria) ? criteriaResult.criteria.map((c) => c.name ?? c.id) : [],
      error: criteriaResult.error,
      tps: criteriaTps === null ? null : Number(criteriaTps.toFixed(2)),
      completionTokens: criteriaResult.completionTokens,
      callMsSum: criteriaResult.callMsSum,
    },
  }, config.maxStoredSteps)

  // 重放胜者的完整 chunk 数组（保留 finish reason、replayState、tool-call、
  // reasoning 与 usage，循环只组装这一条）。
  for (const chunk of results[selected].chunks) {
    yield chunk
  }
}

export function apply(ctx, config) {
  activeConfig = config
  loadContext() // 恢复持久化的会话上下文（/criteria 跨重启可用）
  // 历史 inline 请求体 → 旁路文件（一次性迁移，压缩 trees.json）。
  try {
    migrateInlineBodies()
  } catch (error) {
    console.warn(`[dsh-rollout-transparent] 请求体迁移失败: ${String(error)}`)
  }
  // 初始化/迁移会话级设置存储。新版 `{ version, defaults, sessions }` 直接沿用；
  // 旧版扁平 `{ enabled, rolloutCount, judgeBackendId, judgeModel }` 迁移为所有新
  // 会话的默认值（保留「曾全局关闭」等旧行为），并立即落盘为 v2 结构。
  const loaded = loadSettings()
  const configDefaults = normalizeSessionSettings({
    enabled: config.enabled,
    rolloutCount: config.rolloutCount,
    judgeBackendId: config.defaultJudgeBackend,
    judgeModel: config.defaultJudgeModel,
    criteriaEnabled: config.criteriaEnabled,
  })
  if (loaded && typeof loaded === 'object' && loaded.sessions && typeof loaded.sessions === 'object') {
    settingsStore = {
      version: 2,
      // config 优先：cordis 配置是部署事实，覆盖历史 boot 残留的持久化 defaults
      // （否则切换 profile/config 后旧 defaults 会遮蔽新配置，rollout 被意外关闭）。
      defaults: normalizeSessionSettings({ ...(loaded.defaults ?? {}), ...configDefaults }),
      sessions: loaded.sessions,
    }
    if (JSON.stringify(settingsStore.defaults) !== JSON.stringify(loaded.defaults ?? null)) {
      scheduleSettingsWrite()
    }
  } else {
    settingsStore = {
      version: 2,
      defaults: normalizeSessionSettings({
        ...configDefaults,
        ...(loaded && typeof loaded === 'object' ? loaded : {}),
      }),
      sessions: {},
    }
    scheduleSettingsWrite()
  }

  const api = createApi(ctx, config, getJudgeBackend)
  const pendingSteps = new Map()

  // 稳定地从一个命令 invocation 的 agent 上取回 sessionId（agent.id 与 session.id 同源）。
  const resolveSessionId = (agent) => {
    const sid = agent?.session?.id ?? agent?.id
    return typeof sid === 'string' && sid.length > 0 ? sid : ''
  }

  // /criteria：立即用当前会话的最新对话重新生成 criteria 并持久化。
  const criteriaHandler = async (invocation) => {
    const sid = resolveSessionId(invocation?.agent)
    if (!sid) return { kind: 'error', text: '当前会话尚无 rollout 上下文，无法生成 criteria' }
    const rec = lastSessionContext.get(sid)
    if (!rec || !Array.isArray(rec.messages)) return { kind: 'error', text: '当前会话尚无 rollout 上下文，无法生成 criteria' }
    try {
      const settings = getSessionSettings(sid)
      const gen = await generateCriteria(api, settings, { signal: invocation.signal, sessionId: sid }, renderProblem(rec.messages))
      criteriaStore.sessions[sid] = { id: sid, at: Date.now(), text: gen.text, criteria: gen.criteria, rubric: gen.rubric }
      scheduleCriteriaWrite()
      // 计费：与 ensureCriteria 同路径，直连调用补记到 tokenrouter-cost 账本。
      const critUsage = { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 }
      addUsage(critUsage, gen.usage)
      accountJudgeUsage(ctx, sid, settings.judgeModel, critUsage)
      return { kind: 'success', text: 'criteria 已重新生成' }
    } catch (error) {
      return { kind: 'error', text: 'criteria 重新生成失败: ' + String(error) }
    }
  }

  // 命令服务为可选且加载时序不定：apply 时若未就绪，由 llm/stream 的惰性重试兜底注册
  // （web 组合里 commands 可能在 rollout 之后才就绪；hint 必须非空否则注册表拒绝）。
  let criteriaCommandRegistered = false
  function registerCriteriaCommand() {
    if (criteriaCommandRegistered) return
    const commands = ctx.get('commands')
    if (!commands || typeof commands.register !== 'function') return
    commands.register({
      name: 'criteria',
      description: '重新生成本会话的 rollout 评测 criteria',
      input: { hint: '（可选说明）强制基于当前对话重新生成 criteria' },
      handler: criteriaHandler,
    })
    criteriaCommandRegistered = true
  }
  registerCriteriaCommand()

  // 捕获每个循环步骤的 turn/step（agent/request 在 buildRequest 里同步先于该步的
  // llm/stream 触发；compaction/session-title 不触发 agent/request，天然被排除）。
  // 子代理（subagent）是进程内 child Agent，其会话 header 带 origin:'subagent'
  // （含 parentSession 指向父会话）；它们永远单路：不记录 pendingSteps，随后其
  // llm/stream 因拿不到 pending 而直接放行，只有主会话才 fanout。
  ctx.on('agent/request', (payload, next) => {
    try {
      const session = payload?.agent?.session
      const header = session?.header
      if (header && (header.origin === 'subagent' || header.parentSession !== undefined)) {
        return next()
      }
      const sid = session?.id
      if (typeof sid === 'string' && sid.length > 0) {
        pendingSteps.set(sid, { turn: payload.turn ?? 0, step: payload.step ?? 0 })
      }
    } catch (error) {
      ctx.logger?.warn?.(`[rollout-transparent] agent/request 捕获失败: ${String(error)}`)
    }
    return next()
  }, { global: true })

  // prepend 让本监听器先于 tokenrouter-cost 等下游包装器执行：短路时不调用 next()，
  // 标记请求不会进入下游适配器，也就不会被按胜者 usage 二次计费；N 条 rollout 各自
  // 重入完整瀑布、各计一次费，账目准确。
  ctx.on('llm/stream', (options, next) => {
    registerCriteriaCommand() // 惰性兜底：commands 在 apply 之后才就绪的组合在此补注册
    if (options?.purpose !== undefined) return next()
    const sid = options?.sessionId
    if (typeof sid !== 'string' || sid.length === 0) return next()
    const pending = pendingSteps.get(sid)
    if (!pending) return next()
    pendingSteps.delete(sid)

    // 记录主会话最近一次上下文（子代理永远拿不到 pending，不在此列）。
    recordSessionContext(sid, options.messages)

    const s = getSessionSettings(sid)
    if (!s.enabled || s.rolloutCount <= 1) {
      // 透传：顺带记录该主会话流的用量/计时，供非 rollout 模式的 stats 展示。
      return observeStreamStats(next(), sid, options.model ?? '')
    }
    return rolloutStream(ctx, options, config, api, s, pending.turn, pending.step)
  }, { global: true, prepend: true })

  ctx.provide('rolloutTree', service)
}
