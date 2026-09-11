/**
 * dsh-mem-watch 客户端：composer dock 常驻展示实例内存（RSS / 堆 / 30m 增长趋势）。
 * 数据通道：remote.memWatch.getSnapshot()（Typert RPC，轮询间隔 = 采样间隔）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-mem-watch',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const react = require('react')
    const { useEffect, useState } = react
    const createElement = react.createElement

    const inject = ['remote', 'slots']

    // ── RPC 贡献（与服务端 ./typert 清单一一对应） ─────────────────────────

    const snapshotCodec = {
      parse(value) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('snapshot must be an object')
        }
        return value
      },
    }

    const CONTRIBUTION = {
      package: 'dsh-mem-watch',
      descriptors: [
        {
          id: 'dsh-mem-watch#memWatch/getSnapshot',
          service: 'memWatch',
          namespace: 'memWatch',
          method: 'getSnapshot',
          invocation: { kind: 'direct' },
          parameters: [],
          result: { mode: 'strict', typeSymbol: 'dsh-mem-watch#Snapshot', schema: snapshotCodec },
        },
      ],
    }

    // ── 显示助手 ────────────────────────────────────────────────────────────

    const dockStyle = {
      display: 'flex', gap: '8px', alignItems: 'center',
      font: '12px/1.4 ui-sans-serif, -apple-system, sans-serif',
      color: 'var(--dsh-text-secondary, #8b98a9)', whiteSpace: 'nowrap',
    }
    const strongStyle = { fontWeight: 650 }

    function verdictColor(level) {
      if (level === 'error') return '#e5484d'
      if (level === 'warn') return '#f5a524'
      return '#34c77b'
    }

    function fmtMB(v) {
      const n = Number(v)
      if (!Number.isFinite(n)) return '-'
      if (n >= 1024) return (n / 1024).toFixed(2) + 'GB'
      return Math.round(n) + 'MB'
    }

    function fmtDelta(v) {
      const n = Number(v)
      if (!Number.isFinite(n)) return '±-'
      if (n > 0) return '+' + Math.round(n) + 'MB'
      return String(Math.round(n)) + 'MB'
    }

    function useMemState(remote) {
      const [state, setState] = useState(null)
      useEffect(() => {
        if (remote === undefined) return () => {}
        let alive = true
        const tick = async () => {
          try {
            const result = await remote.getSnapshot()
            if (result === null || typeof result !== 'object' || result.ok !== true) {
              throw new Error(result?.error?.message ?? 'RPC 失败')
            }
            if (alive) setState(result.value)
          } catch (error) {
            console.error('[dsh-mem-watch] getSnapshot 失败:', String(error))
            if (alive) setState({ error: String(error) })
          }
        }
        tick()
        const timer = setInterval(tick, 5000)
        return () => { alive = false; clearInterval(timer) }
      }, [remote])
      return state
    }

    function DockComponent({ remote }) {
      const state = useMemState(remote)
      if (state === null) return null
      if (state.error) {
        return createElement('div', { style: dockStyle, title: '内存监控不可用: ' + state.error.slice(0, 120) }, '内存监控不可用')
      }
      const latest = state.latest
      if (latest === null || latest === undefined) {
        return createElement('div', { style: dockStyle }, '内存采样中…')
      }
      const w30 = state.windows?.m30 ?? null
      const color = verdictColor(state.verdict?.level ?? 'ok')
      const title = `${state.verdict?.reason ?? ''}\nRSS ${latest.rss}MB · 堆 ${latest.heapUsed}/${latest.heapTotal}MB · external ${latest.external}MB\n30m: heap ${w30 ? fmtDelta(w30.growthHeap) : '-'} · rss ${w30 ? fmtDelta(w30.growthRss) : '-'}\n2h: heap ${state.windows?.h2 ? fmtDelta(state.windows.h2.growthHeap) : '-'}\n日志: ${state.logPath}`
      return createElement('div', { style: dockStyle, title },
        createElement('span', null, 'MEM ', createElement('span', { style: { ...strongStyle, color } }, fmtMB(latest.rss))),
        createElement('span', null, 'heap ', createElement('span', { style: strongStyle }, fmtMB(latest.heapUsed))),
        createElement('span', null, '30m ', createElement('span', { style: { ...strongStyle, color } }, fmtDelta(w30 ? w30.growthRss : NaN))),
      )
    }

    // ── 插件主体 ────────────────────────────────────────────────────────────

    async function apply(ctx) {
      const remote = ctx.get('remote')
      if (remote === undefined || typeof remote.$mount !== 'function') return
      const unmount = await remote.$mount(CONTRIBUTION)
      ctx.effect(() => () => { unmount() }, 'dsh-mem-watch: remote contribution')
      const mem = ctx.get('remote.memWatch')
      if (mem === undefined) return
      const slots = ctx.get('slots')
      if (slots === undefined) return

      const injectedDock = () => ({ remote: mem })
      slots.inject('conversation.composer.dock', () => slots.register({
        name: 'conversation.composer.dock',
        id: 'dsh-mem-watch-dock',
        order: 110,
        inject: injectedDock,
      }, DockComponent))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
