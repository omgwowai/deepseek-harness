/**
 * dsh-service-hub 客户端：composer dock 常驻「服务台」按钮。
 * 数据通道：remote.serviceHub.getInfo()（Typert RPC）读取 hubUrl；点击用
 * window.open 打开 hubUrl（有当前会话时带 ?session=<id> 深链）。
 * RPC 不可用时回退到 http://127.0.0.1:6692。
 */
window.__ModuleLoader__.load({
  id: 'dsh-service-hub',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const react = require('react')
    const { useEffect, useState } = react
    const createElement = react.createElement

    const inject = ['remote', 'slots']

    // ── RPC 贡献（与服务端 ./typert 清单一一对应） ─────────────────────────

    const infoCodec = {
      parse(value) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('info must be an object')
        }
        return value
      },
    }

    const CONTRIBUTION = {
      package: 'dsh-service-hub',
      descriptors: [
        {
          id: 'dsh-service-hub#serviceHub/getInfo',
          service: 'serviceHub',
          namespace: 'serviceHub',
          method: 'getInfo',
          invocation: { kind: 'direct' },
          parameters: [],
          result: { mode: 'strict', typeSymbol: 'dsh-service-hub#Info', schema: infoCodec },
        },
      ],
    }

    // ── 按钮 ────────────────────────────────────────────────────────────────

    const FALLBACK_URL = 'http://127.0.0.1:6692'

    const buttonStyle = {
      border: '1px solid var(--dsh-border, #263750)',
      background: 'var(--dsh-bg-secondary, #17263c)',
      color: 'var(--dsh-text-primary, #e8eef8)',
      borderRadius: '8px',
      padding: '4px 10px',
      cursor: 'pointer',
      font: '12px/1.4 ui-sans-serif, -apple-system, sans-serif',
      fontWeight: 650,
      whiteSpace: 'nowrap',
    }

    function HubButton({ remote, sessionId }) {
      const [info, setInfo] = useState(null)
      useEffect(() => {
        if (remote === undefined) return () => {}
        let alive = true
        const tick = async () => {
          try {
            const result = await remote.getInfo()
            if (result !== null && typeof result === 'object' && result.ok === true && result.value) {
              if (alive) setInfo(result.value)
            }
          } catch (error) {
            console.error('[dsh-service-hub] getInfo 失败，退回默认地址:', String(error))
          }
        }
        tick()
        return () => { alive = false }
      }, [remote])

      const hubUrl = info?.hubUrl ?? FALLBACK_URL
      const open = () => {
        const url = hubUrl + (sessionId ? '?session=' + encodeURIComponent(sessionId) : '')
        window.open(url, '_blank', 'noopener')
      }

      return createElement('button', {
        onClick: open,
        title: '打开本地服务台（本会话页面 / 集群任务 / 输入统计）',
        style: buttonStyle,
      }, '服务台')
    }

    // ── 插件主体 ────────────────────────────────────────────────────────────

    async function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      const remote = ctx.get('remote')
      let hub
      if (remote !== undefined && typeof remote.$mount === 'function') {
        try {
          const unmount = await remote.$mount(CONTRIBUTION)
          ctx.effect(() => () => { unmount() }, 'dsh-service-hub: remote contribution')
          hub = ctx.get('remote.serviceHub')
        } catch (error) {
          console.error('[dsh-service-hub] RPC 挂载失败，退回默认地址:', String(error))
        }
      }
      const injectedDock = (sessionId) => ({ remote: hub, sessionId })
      slots.inject('conversation.composer.dock', () => slots.register({
        name: 'conversation.composer.dock',
        id: 'dsh-service-hub-dock',
        order: 120,
        inject: injectedDock,
      }, HubButton))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
