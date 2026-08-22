/**
 * dsh-tokenrouter-cost 客户端：composer dock（今日费用/用量）与侧边栏底部（今日费用）。
 *
 * 数据通道：remote.tokenrouterCost.getState()（Typert RPC）。与宿主清单
 * （./typert）一一对应的贡献必须先经 remote.$mount 安装，`remote.tokenrouterCost`
 * 命名空间才会存在；RPC 返回 RemoteResult（{ ok, value } | { ok:false, error }）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-tokenrouter-cost',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const react = require('react')
    const { useEffect, useState } = react
    const createElement = react.createElement

    const inject = ['remote', 'slots']

    // ── RPC 贡献（与服务端 ./typert 清单一一对应） ─────────────────────────

    /** 客户端结果 codec：仅要求结果为普通对象，其余交给宿主侧严格校验。 */
    const stateCodec = {
      parse(value) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('state must be an object')
        }
        return value
      },
    }

    const CONTRIBUTION = {
      package: 'dsh-tokenrouter-cost',
      descriptors: [
        {
          id: 'dsh-tokenrouter-cost#tokenrouterCost/getState',
          service: 'tokenrouterCost',
          namespace: 'tokenrouterCost',
          method: 'getState',
          invocation: { kind: 'direct' },
          parameters: [],
          result: { mode: 'strict', typeSymbol: 'dsh-tokenrouter-cost#State', schema: stateCodec },
        },
      ],
    }

    // ── 显示助手 ────────────────────────────────────────────────────────────

    function fmtMoney(value) {
      const n = Number(value)
      if (!Number.isFinite(n)) return '¥0'
      if (n >= 1) return '¥' + n.toFixed(2).replace(/\.?0+$/, '')
      return '¥' + n.toFixed(4).replace(/0+$/, '')
    }

    function fmtTokens(value) {
      const n = Number(value) || 0
      if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
      if (n >= 1000) return (n / 1000).toFixed(1) + 'K'
      return String(n)
    }

    /** 轮询 getState：解包 RemoteResult，失败落到 { error }。 */
    function useCostState(remote) {
      const [state, setState] = useState(null)
      useEffect(() => {
        if (remote === undefined) return () => {}
        let alive = true
        const tick = async () => {
          try {
            const result = await remote.getState()
            if (result === null || typeof result !== 'object' || result.ok !== true) {
              throw new Error(result?.error?.message ?? 'RPC 失败')
            }
            if (alive) setState(result.value)
          } catch (error) {
            console.error('[dsh-tokenrouter-cost] getState 失败:', String(error))
            if (alive) setState({ error: String(error) })
          }
        }
        tick()
        const timer = setInterval(tick, 5000)
        return () => { alive = false; clearInterval(timer) }
      }, [remote])
      return state
    }

    // ── 样式与组件 ──────────────────────────────────────────────────────────

    const dockStyle = {
      display: 'flex', gap: '10px', alignItems: 'center',
      font: '12px/1.4 ui-sans-serif, -apple-system, sans-serif',
      color: 'var(--dsh-text-secondary, #8b98a9)', whiteSpace: 'nowrap',
    }
    const strongStyle = { color: 'var(--dsh-text-primary, #e8eef8)', fontWeight: 650 }

    function DockComponent({ remote }) {
      const state = useCostState(remote)
      if (state === null) return null
      if (state.error) {
        return createElement('div', { style: dockStyle, title: 'Token Router 计费不可用: ' + state.error.slice(0, 120) }, '计费不可用')
      }
      const today = state.today ?? {}
      return createElement('div', { style: dockStyle, title: 'Token Router 计费（今日费用/用量）' },
        createElement('span', null, '今日 ', createElement('span', { style: strongStyle }, fmtMoney(today.cost))),
        createElement('span', null, `${fmtTokens(today.input)} in · ${fmtTokens(today.cacheRead)} cache · ${fmtTokens(today.output)} out`),
      )
    }

    function FooterComponent({ remote }) {
      const state = useCostState(remote)
      if (state === null) return null
      if (state.error) {
        return createElement('div', { style: dockStyle, title: 'Token Router 计费不可用: ' + state.error.slice(0, 120) }, '计费不可用')
      }
      const today = state.today ?? {}
      return createElement('div', { style: dockStyle, title: 'Token Router 今日费用' },
        createElement('span', null, '今日费用 ', createElement('span', { style: strongStyle }, fmtMoney(today.cost))),
      )
    }

    // ── 插件主体 ────────────────────────────────────────────────────────────

    async function apply(ctx) {
      const remote = ctx.get('remote')
      if (remote === undefined || typeof remote.$mount !== 'function') return
      const unmount = await remote.$mount(CONTRIBUTION)
      ctx.effect(() => () => { unmount() }, 'tokenrouter-cost: remote contribution')
      const cost = ctx.get('remote.tokenrouterCost')
      if (cost === undefined) return
      const slots = ctx.get('slots')
      if (slots === undefined) return
      const injected = () => ({ remote: cost })

      slots.inject('conversation.composer.dock', () => slots.register({
        name: 'conversation.composer.dock',
        id: 'tokenrouter-cost-dock',
        order: 100,
        inject: injected,
      }, DockComponent))
      slots.inject('sidebar.footer.action', () => slots.register({
        name: 'sidebar.footer.action',
        id: 'tokenrouter-cost-footer',
        order: 100,
        inject: injected,
      }, FooterComponent))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
