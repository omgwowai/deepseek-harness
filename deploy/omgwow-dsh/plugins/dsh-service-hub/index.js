/**
 * dsh-service-hub —— 本地服务台插件（host 面）。
 *
 * 目的：把 dsh 实例与会话上报到本地 hub（http://127.0.0.1:6692），并在
 * composer dock 提供一键打开服务台按钮：
 *   - apply 时 POST /api/instances（实例行，含 base_url / dsh_home / hub_port）；
 *   - 每 pushIntervalMs 重推一次实例行（幂等，重试直到成功）；
 *   - ctx.on('session/created') 时 POST /api/sessions（会话行，workspace 取
 *     session.header.cwd）；
 *   - 经 Typert 暴露 serviceHub.getInfo() 给客户端读 hubUrl / instanceId。
 * 全部 fetch 均为 fire-and-forget，绝不向 cordis 循环抛出异常。
 */
import { z } from 'zod'

export const name = 'service-hub'

const Config = z.object({
  hubUrl: z.string().min(1).default('http://127.0.0.1:6692'),
  instanceId: z.string().min(1).default(process.env.DSH_INSTANCE_ID ?? 'local'),
  instanceName: z.string().default(process.env.DSH_INSTANCE_NAME ?? ''),
  baseUrl: z.string().default(process.env.DSH_BASE_URL ?? ''),
  pushIntervalMs: z.number().int().min(5000).max(3600000).default(15000),
})
const config = Config.parse({})
const instanceId = config.instanceId
const instanceName = config.instanceName || ('dsh-' + instanceId)
const baseUrl = config.baseUrl || process.env.DSH_BASE_URL || ''

function hubBase() {
  return config.hubUrl.replace(/\/+$/, '')
}

function hubPort() {
  try {
    const port = Number(new URL(config.hubUrl).port || 6692)
    return Number.isFinite(port) && port > 0 ? port : 6692
  } catch {
    return 6692
  }
}

async function pushInstance(ctx) {
  try {
    const response = await fetch(hubBase() + '/api/instances', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instance_id: instanceId,
        name: instanceName,
        base_url: baseUrl,
        dsh_home: process.env.DSH_HOME ?? null,
        hub_port: hubPort(),
      }),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return true
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-service-hub] 实例上报失败: ${String(error)}`)
    return false
  }
}

async function pushSession(session) {
  try {
    const workspace = session?.header?.cwd ?? session?.cwd ?? ''
    await fetch(hubBase() + '/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: session?.id ?? '',
        instance_id: instanceId,
        workspace,
        title: '',
      }),
    })
  } catch {
    // 静默忽略：会话上报失败不影响 agent 循环，后续周期/新会话会重试。
  }
}

const service = {
  getHubUrl() {
    return { hubUrl: config.hubUrl, instanceId }
  },
  getInfo() {
    return { hubUrl: config.hubUrl, instanceId, baseUrl }
  },
}

Object.defineProperty(service, 'typertRemote', {
  configurable: false,
  enumerable: false,
  writable: false,
  value: { service, serviceKey: 'serviceHub', namespace: 'serviceHub' },
})

export function apply(ctx) {
  void pushInstance(ctx)
  const timer = setInterval(() => {
    void pushInstance(ctx)
  }, config.pushIntervalMs)
  ctx.effect(() => () => {
    clearInterval(timer)
  }, 'dsh-service-hub: instance push')

  ctx.on('session/created', (session) => {
    void pushSession(session)
  })

  ctx.provide('serviceHub', service)
}
