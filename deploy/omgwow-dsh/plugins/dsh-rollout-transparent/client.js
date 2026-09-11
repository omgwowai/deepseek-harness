/**
 * dsh-rollout-transparent 客户端：
 * 1. 在 conversation.view 槽注册 "Rollout Tree" 标签页（order 20，排在 Chat 0 /
 *    Trajectory 10 之后），按 sessionId 从 remote.rolloutTree.getSessionTrees(sessionId)
 *    拉取每步 rollout 树并渲染。
 * 2. 在 conversation.input.right 槽注册 "Rollout" 控制（order 20，位于模型选择器
 *    左侧）：开关无感 best-of-N、设置轨迹数 N、以及选择 judge 端点/模型（仅列
 *    支持 sampling 前 logprobs 的端点）。设置经 getSettings/setSettings 持久化。
 */
window.__ModuleLoader__.load({
  id: 'dsh-rollout-transparent',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const react = require('react')
    const { useEffect, useRef, useState } = react
    const createElement = react.createElement
    const createPortal = typeof react.createPortal === 'function' ? react.createPortal : (node) => node

    const inject = ['remote', 'slots']

    // ── RPC 贡献（与服务端 ./typert 清单一一对应） ─────────────────────────

    const stringCodec = {
      parse(value) {
        if (typeof value !== 'string') throw new Error('sessionId must be a string')
        return value
      },
    }

    const objectCodec = {
      parse(value) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('expected an object')
        }
        return value
      },
    }

    const numberCodec = {
      parse(value) {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          throw new Error('expected a number')
        }
        return value
      },
    }

    const treesCodec = objectCodec
    const settingsCodec = objectCodec
    const settingsPatchCodec = objectCodec

    const CONTRIBUTION = {
      package: 'dsh-rollout-transparent',
      descriptors: [
        {
          id: 'dsh-rollout-transparent#rolloutTree/getSessionTrees',
          service: 'rolloutTree',
          namespace: 'rolloutTree',
          method: 'getSessionTrees',
          invocation: { kind: 'direct' },
          parameters: [
            {
              name: 'sessionId',
              wire: 'sessionId',
              source: 'json',
              codec: { mode: 'strict', typeSymbol: 'dsh-rollout-transparent#SessionId', schema: stringCodec },
            },
          ],
          result: { mode: 'strict', typeSymbol: 'dsh-rollout-transparent#SessionTrees', schema: treesCodec },
        },
        {
          id: 'dsh-rollout-transparent#rolloutTree/getSettings',
          service: 'rolloutTree',
          namespace: 'rolloutTree',
          method: 'getSettings',
          invocation: { kind: 'direct' },
          parameters: [
            {
              name: 'sessionId',
              wire: 'sessionId',
              source: 'json',
              codec: { mode: 'strict', typeSymbol: 'dsh-rollout-transparent#SessionId', schema: stringCodec },
            },
          ],
          result: { mode: 'strict', typeSymbol: 'dsh-rollout-transparent#Settings', schema: settingsCodec },
        },
        {
          id: 'dsh-rollout-transparent#rolloutTree/setSettings',
          service: 'rolloutTree',
          namespace: 'rolloutTree',
          method: 'setSettings',
          invocation: { kind: 'direct' },
          parameters: [
            {
              name: 'sessionId',
              wire: 'sessionId',
              source: 'json',
              codec: { mode: 'strict', typeSymbol: 'dsh-rollout-transparent#SessionId', schema: stringCodec },
            },
            {
              name: 'patch',
              wire: 'patch',
              source: 'json',
              codec: { mode: 'strict', typeSymbol: 'dsh-rollout-transparent#SettingsPatch', schema: settingsPatchCodec },
            },
          ],
          result: { mode: 'strict', typeSymbol: 'dsh-rollout-transparent#Settings', schema: settingsCodec },
        },
        {
          id: 'dsh-rollout-transparent#rolloutTree/getStepBody',
          service: 'rolloutTree',
          namespace: 'rolloutTree',
          method: 'getStepBody',
          invocation: { kind: 'direct' },
          parameters: [
            {
              name: 'sessionId',
              wire: 'sessionId',
              source: 'json',
              codec: { mode: 'strict', typeSymbol: 'dsh-rollout-transparent#SessionId', schema: stringCodec },
            },
            {
              name: 'turn',
              wire: 'turn',
              source: 'json',
              codec: { mode: 'strict', typeSymbol: 'dsh-rollout-transparent#Turn', schema: numberCodec },
            },
            {
              name: 'step',
              wire: 'step',
              source: 'json',
              codec: { mode: 'strict', typeSymbol: 'dsh-rollout-transparent#StepNo', schema: numberCodec },
            },
          ],
          result: { mode: 'strict', typeSymbol: 'dsh-rollout-transparent#StepBody', schema: objectCodec },
        },
        {
          id: 'dsh-rollout-transparent#rolloutTree/releaseStepBody',
          service: 'rolloutTree',
          namespace: 'rolloutTree',
          method: 'releaseStepBody',
          invocation: { kind: 'direct' },
          parameters: [
            {
              name: 'sessionId',
              wire: 'sessionId',
              source: 'json',
              codec: { mode: 'strict', typeSymbol: 'dsh-rollout-transparent#SessionId', schema: stringCodec },
            },
            {
              name: 'turn',
              wire: 'turn',
              source: 'json',
              codec: { mode: 'strict', typeSymbol: 'dsh-rollout-transparent#Turn', schema: numberCodec },
            },
            {
              name: 'step',
              wire: 'step',
              source: 'json',
              codec: { mode: 'strict', typeSymbol: 'dsh-rollout-transparent#StepNo', schema: numberCodec },
            },
          ],
          result: { mode: 'strict', typeSymbol: 'dsh-rollout-transparent#ReleaseResult', schema: objectCodec },
        },
        {
          id: 'dsh-rollout-transparent#rolloutTree/getSessionStreamStats',
          service: 'rolloutTree',
          namespace: 'rolloutTree',
          method: 'getSessionStreamStats',
          invocation: { kind: 'direct' },
          parameters: [
            {
              name: 'sessionId',
              wire: 'sessionId',
              source: 'json',
              codec: { mode: 'strict', typeSymbol: 'dsh-rollout-transparent#SessionId', schema: stringCodec },
            },
          ],
          result: { mode: 'strict', typeSymbol: 'dsh-rollout-transparent#StreamStats', schema: objectCodec },
        },
      ],
    }

    // ── 样式 ───────────────────────────────────────────────────────────────

    const rootStyle = {
      height: '100%', overflow: 'auto', padding: '16px',
      font: '13px/1.5 ui-sans-serif, -apple-system, sans-serif',
      color: 'var(--dsh-text-primary, #e8eef8)',
    }
    const emptyStyle = { padding: '16px', color: 'var(--dsh-text-secondary, #8b98a9)' }
    const titleStyle = { fontSize: '15px', fontWeight: 650, marginBottom: '12px' }
    const stepStyle = {
      marginBottom: '16px', borderRadius: '8px', border: '1px solid var(--dsh-border, #243044)',
      background: 'var(--dsh-bg-elevated, #121a2a)', overflow: 'hidden',
    }
    const stepHeaderStyle = {
      display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap',
      padding: '8px 12px', borderBottom: '1px solid var(--dsh-border, #243044)',
      fontSize: '12px', color: 'var(--dsh-text-secondary, #8b98a9)',
    }
    const stepTagStyle = { fontWeight: 650, color: 'var(--dsh-text-primary, #e8eef8)' }
    const judgeStyle = { color: 'var(--dsh-accent, #6aa9ff)' }
    const tpsStyle = { color: '#34c77b', fontWeight: 650 }
    const branchStyle = {
      display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '10px 12px',
      borderTop: '1px dashed var(--dsh-border, #243044)',
    }
    const branchFirstStyle = { borderTop: 'none' }
    const badgeBase = {
      flex: '0 0 auto', minWidth: '44px', textAlign: 'center', padding: '2px 6px',
      borderRadius: '6px', fontSize: '11px', fontWeight: 650, marginTop: '1px',
    }
    const winBadgeStyle = { ...badgeBase, background: 'rgba(52, 199, 123, 0.18)', color: '#34c77b' }
    const loseBadgeStyle = { ...badgeBase, background: 'rgba(139, 152, 169, 0.16)', color: 'var(--dsh-text-secondary, #8b98a9)' }
    const preStyle = {
      flex: '1 1 auto', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      fontSize: '12px', maxHeight: '320px', overflow: 'auto', color: 'var(--dsh-text-primary, #e8eef8)',
    }
    const scoreStyle = { flex: '0 0 auto', fontSize: '11px', color: 'var(--dsh-text-secondary, #8b98a9)' }
    // 最终价值 / judge 请求回答 区块样式
    const valueSectionStyle = {
      padding: '10px 12px', borderTop: '1px dashed var(--dsh-border, #243044)', fontSize: '12px',
    }
    const valueTitleStyle = { fontWeight: 650, color: 'var(--dsh-accent, #6aa9ff)', marginBottom: '6px' }
    const valueRowStyle = { margin: '2px 0', color: 'var(--dsh-text-secondary, #8b98a9)' }
    const judgeCallStyle = {
      margin: '6px 0', border: '1px solid var(--dsh-border, #243044)',
      borderRadius: '6px', overflow: 'hidden',
    }
    const judgeCallSummaryStyle = {
      display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap',
      padding: '6px 10px', cursor: 'pointer', fontSize: '12px',
      color: 'var(--dsh-text-secondary, #8b98a9)', background: 'var(--dsh-bg, #0c1322)',
      listStyle: 'none',
    }
    const judgeCritDescStyle = {
      margin: 0, padding: '6px 10px', fontSize: '11px',
      color: 'var(--dsh-text-secondary, #8b98a9)', whiteSpace: 'pre-wrap',
      borderTop: '1px solid var(--dsh-border, #243044)',
    }
    const judgeResponseStyle = {
      margin: 0, padding: '8px 10px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      fontSize: '12px', maxHeight: '280px', overflow: 'auto',
      color: 'var(--dsh-text-primary, #e8eef8)',
      borderTop: '1px solid var(--dsh-border, #243044)',
    }

    // Rollout 控制样式
    const triggerWrapStyle = { position: 'relative', display: 'inline-flex' }
    const triggerStyle = {
      display: 'inline-flex', alignItems: 'center', gap: '6px',
      height: '28px', padding: '0 10px', borderRadius: '14px',
      border: '1px solid var(--dsh-border, #243044)',
      background: 'var(--dsh-bg-elevated, #121a2a)',
      color: 'var(--dsh-text-primary, #e8eef8)',
      fontSize: '12px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
    }
    const dotStyle = { width: '8px', height: '8px', borderRadius: '50%', display: 'inline-block', flex: '0 0 auto' }
    const countBadgeStyle = {
      minWidth: '16px', height: '16px', lineHeight: '16px', textAlign: 'center',
      padding: '0 4px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
      background: 'rgba(106, 169, 255, 0.18)', color: 'var(--dsh-accent, #6aa9ff)',
    }
    const backdropStyle = { position: 'fixed', inset: 0, zIndex: 9998, background: 'rgba(0, 0, 0, 0.32)' }
    const panelStyle = {
      position: 'fixed', top: '16px', right: '16px', zIndex: 9999,
      width: '320px', maxWidth: 'calc(100vw - 32px)',
      borderRadius: '12px', border: '1px solid var(--dsh-border, #243044)',
      background: 'var(--dsh-bg-elevated, #121a2a)',
      color: 'var(--dsh-text-primary, #e8eef8)',
      boxShadow: '0 12px 40px rgba(0, 0, 0, 0.5)',
      fontSize: '13px', overflow: 'hidden',
    }
    const panelHeaderStyle = {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '12px 14px', borderBottom: '1px solid var(--dsh-border, #243044)',
    }
    const panelTitleStyle = { fontWeight: 650, fontSize: '13px' }
    const closeBtnStyle = {
      border: 'none', background: 'transparent', color: 'var(--dsh-text-secondary, #8b98a9)',
      cursor: 'pointer', fontSize: '14px', padding: '2px 4px',
    }
    const panelBodyStyle = { padding: '14px', display: 'flex', flexDirection: 'column', gap: '12px' }
    const rowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }
    const rowLabelStyle = { color: 'var(--dsh-text-secondary, #8b98a9)', fontSize: '12px' }
    const inputStyle = {
      background: 'var(--dsh-bg, #0c1322)', color: 'var(--dsh-text-primary, #e8eef8)',
      border: '1px solid var(--dsh-border, #243044)', borderRadius: '8px',
      padding: '5px 8px', fontSize: '12px', fontFamily: 'inherit',
    }
    const checkboxStyle = { width: '16px', height: '16px', cursor: 'pointer', accentColor: '#6aa9ff' }
    const numberStyle = { ...inputStyle, width: '72px' }
    const selectStyle = { ...inputStyle, maxWidth: '190px' }
    const noteStyle = { color: 'var(--dsh-text-secondary, #8b98a9)', fontSize: '11px', lineHeight: '1.5' }

    // ── 数据 hook：轮询 getSessionTrees，解包 RemoteResult ─────────────────

    function useRolloutTree(loadTree) {
      const [state, setState] = useState(null)
      useEffect(() => {
        if (typeof loadTree !== 'function') return () => {}
        let alive = true
        const tick = async () => {
          try {
            const result = await loadTree()
            if (result === null || typeof result !== 'object' || result.ok !== true) {
              throw new Error(result?.error?.message ?? 'RPC 失败')
            }
            if (alive) setState(result.value)
          } catch (error) {
            console.error('[dsh-rollout-transparent] getSessionTrees 失败:', String(error))
            if (alive) setState({ error: String(error) })
          }
        }
        tick()
        const timer = setInterval(tick, 3000)
        return () => { alive = false; clearInterval(timer) }
      }, [loadTree])
      return state
    }

    // ── 组件 ───────────────────────────────────────────────────────────────

    function fmtTps(v) {
      const n = Number(v)
      if (!Number.isFinite(n) || n <= 0) return '—'
      return n.toFixed(1)
    }

    function fmtDurationMs(ms) {
      const n = Number(ms)
      if (!Number.isFinite(n) || n <= 0) return '—'
      const s = n / 1000
      if (s < 60) return s.toFixed(1) + 's'
      const m = Math.floor(s / 60)
      const rem = Math.round(s - m * 60)
      return m + 'm' + rem + 's'
    }

    // 秒口径（x.xs）：tooltip / 非 rollout 摘要里的首 token 与吞吐展示。
    function fmtSeconds(ms) {
      const n = Number(ms)
      if (!Number.isFinite(n) || n <= 0) return '—'
      return (n / 1000).toFixed(1) + 's'
    }

    function critActionLabel(a) {
      switch (a) {
        case 'generated': return '已生成'
        case 'updated': return '已更新'
        case 'unchanged': return '未变更'
        case 'off': return '关闭'
        default: return String(a ?? '—')
      }
    }

    const ganttLegendRowStyle = {
      display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap',
      margin: '0 0 4px', fontSize: '11px', color: 'var(--dsh-text-secondary, #8b98a9)',
    }
    const ganttDot = (color) => createElement('span', {
      style: { width: 8, height: 8, borderRadius: 2, background: color, display: 'inline-block', marginRight: 4 },
    })

    /**
     * 整场会话的轨迹式甘特图（参照 ui-trajectory 的 overview timeline）：单一连续
     * 时间轴贯穿全部 rollout 步，左侧泳道标签 + 按累计偏移定位的彩色 span +
     * 每轮起始处的竖直分界线。泳道 = criteria / fanout×N / judge（与旧每步图一致）。
     * 支持横向滚动 + 滚轮缩放（拉伸/压缩，shift+滚轮/滚动条平移）+ 自定义悬停 tooltip。
     */
    function RolloutTimeline({ steps }) {
      const chrono = Array.isArray(steps) ? steps : []
      const [zoom, setZoom] = useState(1)
      const [tip, setTip] = useState(null)
      const scrollRef = useRef(null)

      // 滚轮 = 缩放（exp 因子 0.0015，与轨迹时间轴一致）；shift+滚轮交给浏览器横向平移。
      // nsys 风格键盘操作（时间轴聚焦后生效）：W 拉伸（放大，单位长度时间变小）、S 缩小、
      // A/D 左右平移；缩放以可视区中心为锚点保持视野稳定。
      useEffect(() => {
        const el = scrollRef.current
        if (el === null) return () => {}
        const zoomRef = { current: 1 }
        const applyZoom = (next) => {
          const clamped = Math.min(16, Math.max(0.1, next))
          const centerFrac = el.clientWidth > 0
            ? (el.scrollLeft + el.clientWidth / 2) / (el.scrollWidth || 1)
            : 0.5
          zoomRef.current = clamped
          setZoom(clamped)
          requestAnimationFrame(() => {
            el.scrollLeft = centerFrac * el.scrollWidth - el.clientWidth / 2
          })
        }
        const onWheel = (e) => {
          if (e.shiftKey) return
          e.preventDefault()
          const factor = Math.exp(e.deltaY * 0.0015)
          applyZoom(zoomRef.current * factor)
        }
        const onKeyDown = (e) => {
          const k = e.key.toLowerCase()
          if (k === 'w') { e.preventDefault(); applyZoom(zoomRef.current * 1.25) }
          else if (k === 's') { e.preventDefault(); applyZoom(zoomRef.current / 1.25) }
          else if (k === 'a') { e.preventDefault(); el.scrollLeft -= Math.max(60, el.clientWidth * 0.1) }
          else if (k === 'd') { e.preventDefault(); el.scrollLeft += Math.max(60, el.clientWidth * 0.1) }
        }
        const onFocus = () => { el.style.outline = '1px solid rgba(110,168,254,0.45)' }
        const onBlur = () => { el.style.outline = 'none' }
        el.tabIndex = 0
        el.style.outline = 'none'
        el.addEventListener('wheel', onWheel, { passive: false })
        el.addEventListener('keydown', onKeyDown)
        el.addEventListener('focus', onFocus)
        el.addEventListener('blur', onBlur)
        return () => {
          el.removeEventListener('wheel', onWheel)
          el.removeEventListener('keydown', onKeyDown)
          el.removeEventListener('focus', onFocus)
          el.removeEventListener('blur', onBlur)
        }
      }, [])

      const showTip = (e, text) => setTip({ x: e.clientX, y: e.clientY, text })
      const moveTip = (e) => setTip((t) => (t === null ? t : { ...t, x: e.clientX, y: e.clientY }))
      const hideTip = () => setTip(null)

      if (chrono.length === 0) return null

      const hasCriteria = chrono.some((s) => Boolean(s?.criteria?.enabled) || Number(s?.timing?.criteriaWallMs) > 0)
      const maxN = chrono.reduce((m, s) => Math.max(m, Array.isArray(s?.timing?.wallMs) ? s.timing.wallMs.length : 0), 0)
      const laneNames = []
      if (hasCriteria) laneNames.push('criteria')
      for (let j = 0; j < maxN; j++) laneNames.push(`fanout #${j}`)
      laneNames.push('judge')
      const criteriaLane = hasCriteria ? 1 : 0
      const judgeLane = laneNames.length - 1

      // 把每一步按 totalMs 首尾相接成一条连续时间轴（轨迹 overview 的连续化投影）。
      const segments = []
      let cursor = 0
      for (const step of chrono) {
        const totalMs = Math.max(1, Number(step?.timing?.totalMs) || 0)
        const start = cursor
        cursor += totalMs
        segments.push({ step, start, end: cursor })
      }
      const domain = Math.max(1, cursor)
      // 基准像素宽度（未缩放）：按总时长映射、最短 800px；缩放时整体乘 zoom。
      const baseWidth = Math.max(800, Math.round(domain / 20))
      const px = (t) => Math.min(Math.max(Number(t) || 0, 0) / domain, 1) * baseWidth

      // 每个 step 派生三类 span：fanout×N（各占一条泳道）/ criteria / judge。
      let id = 0
      const spans = []
      segments.forEach(({ step, start }, i) => {
        const t = step?.timing ?? {}
        const wallMs = Array.isArray(t.wallMs) ? t.wallMs : []
        const ttftMs = Array.isArray(t.ttftMs) ? t.ttftMs : []
        const reasoningMs = Array.isArray(t.reasoningMs) ? t.reasoningMs : []
        const usage = Array.isArray(step.usage) ? step.usage : []
        const critMs = Number(t.criteriaWallMs) || 0
        const judgeStart = Number(t.judgeStartMs) || Number(t.fanoutMs) || 0
        const judgeDur = Number(t.judgeTiming?.totalJudgeMs) || 0
        const judgeAgg = step.judgeAgg ?? null
        const critNames = Array.isArray(step?.criteria?.names) ? step.criteria.names : []
        wallMs.forEach((ms, j) => {
          const win = j === step.selected
          const u = usage[j] ?? {}
          spans.push({
            id: id++,
            lane: criteriaLane + j,
            start,
            end: start + Math.max(0, Number(ms) || 0),
            color: win ? '#6aa9ff' : '#4a90d9',
            win,
            tip: `rollout #${j}${win ? ' ✓ 胜出' : ''} — input ${u.inputTokens ?? 0} · output ${u.outputTokens ?? 0} · 首token ${fmtSeconds(ttftMs[j])} · 推理 ${fmtSeconds(reasoningMs[j])} · 总 ${fmtSeconds(ms)} · 第 ${i + 1} 轮`,
          })
        })
        if (hasCriteria) {
          spans.push({
            id: id++,
            lane: 0,
            start,
            end: start + Math.max(0, critMs),
            color: '#e5a05a',
            win: false,
            tip: `criteria ${critActionLabel(step?.criteria?.action)} — 首token ${fmtSeconds(t.criteriaTtftMs)} · 总 ${fmtSeconds(critMs)} · 名字: ${critNames.length > 0 ? critNames.join(' / ') : '—'} · 第 ${i + 1} 轮`,
          })
        }
        spans.push({
          id: id++,
          lane: judgeLane,
          start: start + judgeStart,
          end: start + judgeStart + Math.max(0, judgeDur),
          color: '#34c77b',
          win: false,
          tip: judgeAgg
            ? `judge — 平均 input ${Math.round(judgeAgg.avgInputTokens)} · 平均 output ${Math.round(judgeAgg.avgOutputTokens)} · 总 ${fmtSeconds(judgeAgg.totalMs)} · 第 ${i + 1} 轮`
            : `judge — 总 ${fmtSeconds(judgeDur)} · 第 ${i + 1} 轮`,
        })
      })

      const boundaries = segments
        .filter((s) => s.start > 0)
        .map((s, i) => ({ key: i, left: px(s.start) }))
      const plotHeight = laneNames.length * 14 + 14
      const innerWidth = Math.max(1, Math.round(baseWidth * zoom))

      const labels = laneNames.map((name, lane) => createElement('span', {
        key: name,
        style: {
          position: 'absolute', right: 3, top: 7 + lane * 14, height: 8,
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
          fontSize: 10, lineHeight: 1, textAlign: 'right', whiteSpace: 'nowrap',
          color: 'var(--dsh-text-secondary, #8b98a9)',
        },
      }, name))

      const spanEl = (s) => createElement('span', {
        key: `sp-${s.id}`,
        onMouseEnter: (e) => showTip(e, s.tip),
        onMouseMove: moveTip,
        onMouseLeave: hideTip,
        style: {
          position: 'absolute', top: s.lane * 14, height: 8, minWidth: 2, borderRadius: 1,
          left: px(s.start) * zoom,
          width: Math.max(2, (px(s.end) - px(s.start)) * zoom - 1),
          background: s.color, opacity: s.win ? 1 : 0.8, zIndex: s.win ? 2 : 1,
          boxShadow: s.win ? '0 0 0 1px rgba(255,255,255,0.45)' : undefined,
        },
      })

      const tooltip = tip
        ? createPortal(createElement('div', {
          style: {
            position: 'fixed', left: tip.x + 12, top: tip.y + 12, zIndex: 10000,
            maxWidth: '360px', padding: '6px 8px', borderRadius: '6px',
            background: 'var(--dsh-bg-elevated, #121a2a)',
            border: '1px solid var(--dsh-border, #243044)',
            color: 'var(--dsh-text-primary, #e8eef8)', fontSize: '11px', lineHeight: 1.5,
            whiteSpace: 'pre-line', pointerEvents: 'none',
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
          },
        }, tip.text), document.body)
        : null

      return createElement('div', { style: { padding: '10px 12px 10px', borderBottom: '1px solid var(--dsh-border, #243044)' } },
        createElement('div', { style: ganttLegendRowStyle },
          createElement('span', { style: { fontWeight: 650, color: 'var(--dsh-text-primary, #e8eef8)' } }, '整场甘特图 · 滚轮缩放 · shift+滚轮平移'),
          createElement('span', null, ganttDot('#4a90d9'), 'fanout'),
          createElement('span', null, ganttDot('#34c77b'), 'judge'),
          hasCriteria ? createElement('span', null, ganttDot('#e5a05a'), 'criteria') : null,
          createElement('span', null, `共 ${segments.length} 轮 · 总时长 ${fmtDurationMs(domain)} · 竖线 = 轮次分界`),
        ),
        createElement('div', { style: { display: 'flex', marginTop: 6, height: plotHeight } },
          createElement('div', { style: { position: 'relative', width: 64, flexShrink: 0, borderRight: '1px solid var(--dsh-border, #243044)', height: plotHeight } },
            ...labels,
          ),
          createElement('div', {
            ref: scrollRef,
            style: { position: 'relative', flex: '1 1 auto', minWidth: 0, overflowX: 'auto', overflowY: 'hidden', height: plotHeight },
          },
            createElement('div', { style: { position: 'relative', width: innerWidth, height: plotHeight } },
              ...boundaries.map((b) => createElement('span', {
                key: `b-${b.key}`,
                style: {
                  position: 'absolute', top: 0, bottom: 0, left: b.left * zoom, width: 1,
                  background: 'var(--dsh-border, #243044)',
                },
              })),
              ...spans.map(spanEl),
            ),
          ),
        ),
        tooltip,
      )
    }

    function StepCard({ step, index, loadBody, releaseBody }) {
      // 请求体信息默认关闭：卡片折叠，展开时才经 getStepBody 按需加载，
      // 收起时经 releaseStepBody 通知服务端清除内存缓存。
      const [expanded, setExpanded] = useState(false)
      const [body, setBody] = useState(null)
      const [loading, setLoading] = useState(false)

      const candidates = Array.isArray(body?.candidates) ? body.candidates
        : Array.isArray(step.candidates) ? step.candidates : []
      const judgeCalls = Array.isArray(body?.judgeCalls) ? body.judgeCalls
        : Array.isArray(step.judgeCalls) ? step.judgeCalls : []
      const problem = typeof body?.problem === 'string' ? body.problem
        : typeof step.problem === 'string' ? step.problem : ''
      const hasBody = step.hasBody === true || step.problem !== undefined ||
        Array.isArray(step.candidates) || Array.isArray(step.judgeCalls)

      const toggle = async () => {
        if (expanded) {
          setExpanded(false)
          setLoading(false)
          if (body !== null && typeof releaseBody === 'function') {
            try {
              releaseBody(step.turn, step.step)
            } catch (error) {
              console.error('[dsh-rollout-transparent] releaseStepBody 失败:', String(error))
            }
          }
          setBody(null)
          return
        }
        setExpanded(true)
        if (body === null && hasBody && typeof loadBody === 'function') {
          setLoading(true)
          try {
            const result = await loadBody(step.turn, step.step)
            if (result === null || typeof result !== 'object' || result.ok !== true) {
              throw new Error(result?.error?.message ?? 'RPC 失败')
            }
            setBody(result.value === null || typeof result.value !== 'object' ? {} : result.value)
          } catch (error) {
            console.error('[dsh-rollout-transparent] getStepBody 失败:', String(error))
            setBody({})
          } finally {
            setLoading(false)
          }
        }
      }

      const scores = Array.isArray(step.scores) ? step.scores : []
      const ranking = Array.isArray(step.ranking) ? step.ranking : []
      const perCriterion = Array.isArray(step.perCriterion) ? step.perCriterion : []
      const judgeInfo = step.judgeModel
        ? createElement('span', { style: judgeStyle }, `judge: ${step.judgeModel}`)
        : null
      const selectTag = step.judgeSkipped
        ? createElement('span', { style: judgeStyle },
            `跳过 judge · 随机 #${step.selected}（answer+tool=${step.answerToolLen ?? '—'} / thinking=${step.thinkingLen ?? '—'}）`)
        : createElement('span', { style: judgeStyle }, `judge 选中 #${step.selected}（${step.nComparisons} 次比较）`)
      const toggleHint = createElement('span', {
        style: { cursor: 'pointer', userSelect: 'none', fontWeight: 650, color: 'var(--dsh-accent, #6aa9ff)' },
        title: expanded ? '收起（清除请求体内存）' : '展开（按需加载请求体）',
      }, expanded ? '▾ 收起' : (hasBody ? '▸ 展开请求体' : '▸ 展开'))
      const header = createElement('div', {
        style: { ...stepHeaderStyle, cursor: 'pointer' },
        onClick: toggle,
      },
        createElement('span', { style: stepTagStyle }, `Step ${index + 1}`),
        createElement('span', null, `Turn ${step.turn} · Step ${step.step}`),
        createElement('span', null, `${step.n} 条 rollout`),
        selectTag,
        judgeInfo,
        createElement('span', { style: tpsStyle, title: '胜者轨迹 output tokens（含 reasoning）÷ 胜者总推理墙钟时长' }, `FinalOut ${fmtTps(step.tps?.finalOutTps)} tok/s`),
        createElement('span', { style: tpsStyle, title: 'judge completion tokens 之和 ÷ 各 judge 任务墙钟时长之和' }, `Judge ${fmtTps(step.tps?.judgeTps)} tok/s`),
        step.criteria?.enabled
          ? createElement('span', { style: { color: '#e5a05a', fontWeight: 650 }, title: '动态 criteria：动作 / 变更得分(logprobs 归一化) / 生成 TPS' },
              `criteria ${critActionLabel(step.criteria.action)}` +
              (step.criteria.changeScore != null ? ` Δ${Number(step.criteria.changeScore).toFixed(2)}` : '') +
              ` · ${fmtTps(step.criteria.tps)} tok/s`)
          : null,
        step.criteria?.error
          ? createElement('span', { style: { color: '#e5a05a' } }, `criteria 回退: ${step.criteria.error}`)
          : null,
        step.judgeError ? createElement('span', { style: { color: '#e5a05a' } }, `judge 回退: ${step.judgeError}`) : null,
        toggleHint,
      )

      let expandedSection = null
      if (expanded) {
        if (loading && body === null) {
          expandedSection = createElement('div', { style: valueSectionStyle }, '请求体加载中…')
        } else {
          const problemSection = problem
            ? createElement('details', { style: judgeCallStyle },
                createElement('summary', { style: judgeCallSummaryStyle }, '任务上下文（judge 请求体 · 打开时按需加载）'),
                createElement('pre', { style: judgeResponseStyle }, problem),
              )
            : null

          const branches = candidates.map((candidate, i) => {
            const isWin = i === step.selected
            const score = scores[i]
            const style = i === 0 ? { ...branchStyle, ...branchFirstStyle } : branchStyle
            const badge = createElement('span', { style: isWin ? winBadgeStyle : loseBadgeStyle },
              isWin ? `#${i} ✓` : `#${i}`)
            const scoreEl = Number.isFinite(score)
              ? createElement('span', { style: scoreStyle }, `偏好 ${(Number(score) * 100).toFixed(0)}%`)
              : null
            const text = candidate?.text || candidate?.preview || '(空 rollout)'
            return createElement('div', { key: i, style },
              badge,
              createElement('pre', { style: preStyle }, text),
              scoreEl,
            )
          })

          // 最终价值：Bradley-Terry 聚合后的排序 + 每标准得分，或跳过 judge 的直取说明。
          let valueSection
          if (step.judgeSkipped) {
            valueSection = createElement('div', { style: valueSectionStyle },
              createElement('div', { style: valueTitleStyle }, '最终价值 · 跳过 judge（短回复直取）'),
              createElement('div', { style: valueRowStyle }, `answer+tool ≤ ${step.answerToolLen ?? '—'} / thinking ≤ ${step.thinkingLen ?? '—'}，随机选中 #${step.selected}`),
            )
          } else {
            const rankLine = ranking.length
              ? ranking.map((idx, k) => `#${idx}(${Number.isFinite(Number(scores[idx])) ? (Number(scores[idx]) * 100).toFixed(0) : '—'}%)`).join(' > ')
              : '—'
            const rows = [
              createElement('div', { key: 'rank', style: valueRowStyle }, `排序: ${rankLine}  →  胜出 #${step.selected}`),
            ]
            perCriterion.forEach((pc, ci) => {
              const per = (Array.isArray(pc.scores) ? pc.scores : [])
                .map((s, i) => `#${i}=${Number.isFinite(Number(s)) ? (Number(s) * 100).toFixed(0) : '—'}%`)
                .join(' ')
              rows.push(createElement('div', { key: `pc-${ci}`, style: valueRowStyle }, `${pc.name ?? pc.id}: ${per}`))
            })
            valueSection = createElement('div', { style: valueSectionStyle },
              createElement('div', { style: valueTitleStyle }, '最终价值（Bradley-Terry 聚合）'),
              ...rows,
            )
          }

          // judge 逐请求展示：每个 judge 调用 = 标准 + A/B 候选对 + 评分（展开看回答正文）。
          let judgeSection = null
          if (judgeCalls.length > 0) {
            const callEls = judgeCalls.map((call, i) => {
              // scoreA/scoreB 始终按候选顺序记录（swap 只是把两条轨迹在 prompt 的 A/B 槽互换，
              // 评分已换回），这里直接以候选号标注，避免 A/B 槽位歧义。
              const verdict = call.error
                ? `失败/超时 → 随机判 #${Number(call.scoreA) > Number(call.scoreB) ? call.a : call.b}`
                : `#${call.a}=${(Number(call.scoreA) * 100).toFixed(0)}% · #${call.b}=${(Number(call.scoreB) * 100).toFixed(0)}%`
              const title = `${call.critName ?? call.critId} · #${call.a} vs #${call.b} · ${verdict}` +
                (call.rep > 0 ? ` · rep${call.rep}` : '') +
                (call.swap ? ' · 换槽' : '')
              const desc = call.critDescription
                ? createElement('div', { style: judgeCritDescStyle }, call.critDescription)
                : null
              const answer = call.error
                ? createElement('pre', { style: judgeResponseStyle }, `judge 调用失败/超时：${call.error}（随机兜底）`)
                : createElement('pre', { style: judgeResponseStyle },
                    (call.response ?? '') + (call.responseTruncated ? '\n…（回复过长已截断）' : ''))
              return createElement('details', { key: i, style: judgeCallStyle },
                createElement('summary', { style: judgeCallSummaryStyle }, title),
                desc,
                answer,
              )
            })
            judgeSection = createElement('div', { style: valueSectionStyle },
              createElement('div', { style: valueTitleStyle }, `Judge 请求与回答 × ${judgeCalls.length}`),
              ...callEls,
            )
          }

          expandedSection = createElement('div', null, problemSection, ...branches, valueSection, judgeSection)
        }
      }

      return createElement('div', { style: stepStyle }, header, expandedSection)
    }

    function RolloutTreeView({ loadTree, loadBody, releaseBody }) {
      const state = useRolloutTree(loadTree)
      if (state === null) return createElement('div', { style: emptyStyle }, '加载中…')
      if (state.error) {
        return createElement('div', { style: emptyStyle }, 'Rollout Tree 不可用：' + String(state.error).slice(0, 200))
      }
      const steps = Array.isArray(state.steps) ? [...state.steps].reverse() : []
      if (steps.length === 0) {
        return createElement('div', { style: emptyStyle }, '本会话尚无 rollout 记录（无感 best-of-N 尚未触发或已关闭）。')
      }
      return createElement('div', { style: rootStyle },
        createElement('div', { style: titleStyle }, `Rollout Tree · ${steps.length} 步（最终轨迹 = 每步选中的那条拼凑而成；请求体默认不驻留，展开某步时按需加载）`),
        createElement(RolloutTimeline, { steps }),
        steps.map((step, i) => createElement(StepCard, { key: `${step.at}-${i}`, step, index: i, loadBody, releaseBody })),
      )
    }

    // ── Rollout 控制（输入区左侧） ─────────────────────────────────────────

    function useSettings(getSettings, setSettings) {
      const [state, setState] = useState(null)
      useEffect(() => {
        if (typeof getSettings !== 'function') return () => {}
        let alive = true
        ;(async () => {
          try {
            const result = await getSettings()
            if (result === null || typeof result !== 'object' || result.ok !== true) {
              throw new Error(result?.error?.message ?? 'RPC 失败')
            }
            if (alive) setState(result.value)
          } catch (error) {
            console.error('[dsh-rollout-transparent] getSettings 失败:', String(error))
            if (alive) setState({ error: String(error) })
          }
        })()
        return () => { alive = false }
      }, [getSettings])

      const patch = async (p) => {
        if (typeof setSettings !== 'function') return
        try {
          const result = await setSettings(p)
          if (result && typeof result === 'object' && result.ok === true) {
            setState(result.value)
          } else {
            console.error('[dsh-rollout-transparent] setSettings 失败:', result?.error?.message)
          }
        } catch (error) {
          console.error('[dsh-rollout-transparent] setSettings 失败:', String(error))
        }
      }
      return { state, patch }
    }

    function RolloutControl({ getSettings, setSettings }) {
      const { state, patch } = useSettings(getSettings, setSettings)
      const [open, setOpen] = useState(false)

      const settings = state && !state.error ? state : null
      const enabled = settings ? Boolean(settings.enabled) : false
      const count = settings ? settings.rolloutCount : 1

      const backends = settings && Array.isArray(settings.judgeBackends) ? settings.judgeBackends : []
      // 仅保留「thinking 开启时仍返回 sampling 前 logprobs」的 judge 端点。
      const eligible = backends.filter((b) => b && b.supportsLogprobs !== false && b.logprobsWithThinking !== false)
      const currentBackend = eligible.find((b) => b.id === settings?.judgeBackendId) ?? eligible[0] ?? null
      const models = currentBackend && Array.isArray(currentBackend.models) ? currentBackend.models : []

      const dotColor = enabled ? '#34c77b' : 'var(--dsh-text-secondary, #8b98a9)'
      const trigger = createElement('button', {
        type: 'button',
        style: triggerStyle,
        onClick: () => setOpen((v) => !v),
        title: '无感 Best-of-N (rollout) 设置',
      },
        createElement('span', { style: { ...dotStyle, background: dotColor } }),
        createElement('span', null, 'Rollout'),
        enabled ? createElement('span', { style: countBadgeStyle }, String(count)) : null,
      )

      let popover = null
      if (open) {
        const bodyRows = []
        if (state && state.error) {
          bodyRows.push(createElement('div', { style: noteStyle }, '设置不可用：' + String(state.error).slice(0, 160)))
        } else {
          bodyRows.push(
            createElement('label', { key: 'enabled', style: rowStyle },
              createElement('span', { style: rowLabelStyle }, '开启 rollout'),
              createElement('input', {
                type: 'checkbox',
                checked: enabled,
                onChange: (e) => patch({ enabled: e.target.checked }),
                style: checkboxStyle,
              }),
            ),
            createElement('label', { key: 'count', style: rowStyle },
              createElement('span', { style: rowLabelStyle }, '轨迹数 (N)'),
              createElement('input', {
                type: 'number', min: 1, max: 64, step: 1,
                value: count,
                onChange: (e) => patch({ rolloutCount: Number(e.target.value) }),
                onKeyDown: (e) => { if (e.key === 'Enter') e.preventDefault() },
                style: numberStyle,
              }),
            ),
            createElement('div', { key: 'criteria', style: rowStyle },
              createElement('span', { style: rowLabelStyle }, 'criteria：首轮生成 · /criteria 重新判断'),
            ),
            createElement('label', { key: 'backend', style: rowStyle },
              createElement('span', { style: rowLabelStyle }, 'Judge 端点'),
              createElement('select', {
                value: currentBackend ? currentBackend.id : '',
                onChange: (e) => patch({ judgeBackendId: e.target.value }),
                style: selectStyle,
              },
                eligible.map((b) => createElement('option', { key: b.id, value: b.id }, `${b.displayName || b.id} · ${b.baseUrl}`)),
              ),
            ),
            createElement('label', { key: 'model', style: rowStyle },
              createElement('span', { style: rowLabelStyle }, 'Judge 模型'),
              createElement('select', {
                value: settings?.judgeModel ?? '',
                onChange: (e) => patch({ judgeModel: e.target.value }),
                style: selectStyle,
              },
                models.map((m) => createElement('option', { key: m.id, value: m.id }, m.name || m.id)),
              ),
            ),
            createElement('div', { key: 'note', style: noteStyle },
              '此设置为当前对话独立生效。Rollout 模型 = 顶部模型选择器（生成模型）。Judge 仅列支持 sampling 前 logprobs 的端点（thinking 开启）。criteria 在首轮自动生成，可用 /criteria 命令重新生成；judge 等待 criteria 与 fanout 都完成后再开始比较。'),
          )
        }
        popover = createElement('div', { style: backdropStyle, onClick: () => setOpen(false) },
          createElement('div', { style: panelStyle, onClick: (e) => e.stopPropagation() },
            createElement('div', { style: panelHeaderStyle },
              createElement('span', { style: panelTitleStyle }, '无感 Best-of-N'),
              createElement('button', { type: 'button', style: closeBtnStyle, onClick: () => setOpen(false) }, '✕'),
            ),
            createElement('div', { style: panelBodyStyle }, ...bodyRows),
          ),
        )
      }

      return createElement('div', { style: triggerWrapStyle },
        trigger,
        popover ? createPortal(popover, document.body) : null,
      )
    }

    // ── composer dock 摘要：区分 fanout / judge 两阶段的首 token 时延与 TPS ──

    const summaryDockStyle = {
      display: 'flex', gap: '8px', alignItems: 'center',
      font: '12px/1.4 ui-sans-serif, -apple-system, sans-serif',
      color: 'var(--dsh-text-secondary, #8b98a9)', whiteSpace: 'nowrap',
    }
    const summaryStrongStyle = { color: 'var(--dsh-text-secondary, #8b98a9)', fontWeight: 650 }
    const summaryDividerStyle = { color: 'var(--dsh-text-secondary, #8b98a9)' }

    /** 聚合会话内全部 rollout 步的 fanout/judge 两阶段指标。 */
    function aggregateStats(steps) {
      let fanoutTokens = 0
      let fanoutWall = 0
      let judgeTokens = 0
      let judgeWall = 0
      let fanoutTtft = 0
      let fanoutTtftN = 0
      let judgeTtft = 0
      let judgeTtftN = 0
      let criteriaTokens = 0
      let criteriaWall = 0
      let criteriaTtft = 0
      let criteriaTtftN = 0
      let criteriaSteps = 0
      for (const step of steps) {
        const tps = step?.tps ?? {}
        const timing = step?.timing ?? {}
        fanoutTokens += Number(step?.winnerUsage?.outputTokens) || 0
        fanoutWall += Number(timing.winnerWallMs) || 0
        judgeTokens += Number(tps.judgeCompletionTokens) || 0
        judgeWall += Number(tps.judgeCallMsSum) || 0
        const ft = Number(timing.fanoutTtftMs)
        if (Number.isFinite(ft) && ft > 0) {
          fanoutTtft += ft
          fanoutTtftN += 1
        }
        const jt = Number(timing.judgeTtftMsAvg)
        if (Number.isFinite(jt) && jt > 0) {
          judgeTtft += jt
          judgeTtftN += 1
        }
        if (step?.criteria?.enabled) {
          criteriaSteps += 1
          criteriaTokens += Number(step.criteria.completionTokens) || 0
          criteriaWall += Number(step.criteria.callMsSum) || 0
          const ct = Number(timing.criteriaTtftMs)
          if (Number.isFinite(ct) && ct > 0) {
            criteriaTtft += ct
            criteriaTtftN += 1
          }
        }
      }
      return {
        steps: steps.length,
        fanoutTps: fanoutWall > 0 ? fanoutTokens / (fanoutWall / 1000) : null,
        judgeTps: judgeWall > 0 ? judgeTokens / (judgeWall / 1000) : null,
        fanoutTtftAvg: fanoutTtftN > 0 ? fanoutTtft / fanoutTtftN : null,
        judgeTtftAvg: judgeTtftN > 0 ? judgeTtft / judgeTtftN : null,
        criteriaSteps,
        criteriaTps: criteriaWall > 0 ? criteriaTokens / (criteriaWall / 1000) : null,
        criteriaTtftAvg: criteriaTtftN > 0 ? criteriaTtft / criteriaTtftN : null,
      }
    }

    /** 轮询 getSessionStreamStats：解包 RemoteResult（非 rollout 模式 stats 展示）。 */
    function useStreamStats(getStreamStats) {
      const [state, setState] = useState(null)
      useEffect(() => {
        if (typeof getStreamStats !== 'function') return () => {}
        let alive = true
        const tick = async () => {
          try {
            const result = await getStreamStats()
            if (result === null || typeof result !== 'object' || result.ok !== true) {
              throw new Error(result?.error?.message ?? 'RPC 失败')
            }
            if (alive) setState(result.value)
          } catch (error) {
            if (alive) setState({ error: String(error) })
          }
        }
        tick()
        const timer = setInterval(tick, 3000)
        return () => { alive = false; clearInterval(timer) }
      }, [getStreamStats])
      return state
    }

    function RolloutSummary({ loadTree, getSettings, getStreamStats }) {
      const state = useRolloutTree(loadTree)
      const { state: settingsState } = useSettings(getSettings, null)
      const streamStats = useStreamStats(getStreamStats)
      if (state === null || state.error) return null
      const steps = Array.isArray(state.steps) ? state.steps : []
      if (steps.length > 0) {
        const s = aggregateStats(steps)
        return createElement('div', {
          style: summaryDockStyle,
          title: 'Rollout 三阶段：生成(fanout) / judge / criteria 的首 token 时延与 TPS（criteria 与 fanout 并行，judge 等待两者完成）',
        },
          createElement('span', null, '生成 首token ',
            createElement('span', { style: summaryStrongStyle }, fmtDurationMs(s.fanoutTtftAvg)),
            ' · ',
            createElement('span', { style: summaryStrongStyle }, `${fmtTps(s.fanoutTps)} tok/s`)),
          createElement('span', { style: summaryDividerStyle }, '|'),
          createElement('span', null, 'judge 首token ',
            createElement('span', { style: summaryStrongStyle }, fmtDurationMs(s.judgeTtftAvg)),
            ' · ',
            createElement('span', { style: summaryStrongStyle }, `${fmtTps(s.judgeTps)} tok/s`)),
          s.criteriaSteps > 0
            ? createElement('span', null,
                createElement('span', { style: summaryDividerStyle }, '|'),
                'criteria 首token ',
                createElement('span', { style: summaryStrongStyle }, fmtDurationMs(s.criteriaTtftAvg)),
                ' · ',
                createElement('span', { style: summaryStrongStyle }, `${fmtTps(s.criteriaTps)} tok/s`))
            : null,
        )
      }
      // steps.length === 0：区分「rollout 已启用但尚未触发」与「非 rollout 模式」。
      const settings = settingsState && !settingsState.error ? settingsState : null
      if (!settings) return null
      const rolloutEnabled = settings.enabled !== false && Number(settings.rolloutCount) > 1
      if (rolloutEnabled) return null // 尚未触发：等待首个 rollout 步
      const ss = streamStats && !streamStats.error ? streamStats : null
      if (!ss) return null
      const tps = Number(ss.wallMs) > 0 ? Number(ss.outputTokens) / (Number(ss.wallMs) / 1000) : null
      return createElement('div', {
        style: summaryDockStyle,
        title: '本会话普通生成（非 rollout）：首 token 时延与吞吐',
      },
        createElement('span', null, '生成 首token ',
          createElement('span', { style: summaryStrongStyle }, fmtSeconds(ss.ttftMs)),
          ' · ',
          createElement('span', { style: summaryStrongStyle }, `${fmtTps(tps)} tok/s`)),
      )
    }

    // ── 插件主体 ───────────────────────────────────────────────────────────

    async function apply(ctx) {
      const remote = ctx.get('remote')
      if (remote === undefined || typeof remote.$mount !== 'function') return
      const unmount = await remote.$mount(CONTRIBUTION)
      ctx.effect(() => () => { unmount() }, 'rollout-transparent: remote contribution')
      const rolloutTree = ctx.get('remote.rolloutTree')
      if (rolloutTree === undefined) return
      const slots = ctx.get('slots')
      if (slots === undefined) return

      slots.inject('conversation.view', () => slots.register({
        name: 'conversation.view',
        id: 'rollout-tree',
        order: 20,
        label: 'Rollout Tree',
        inject: (sessionId) => ({
          sessionId,
          loadTree: () => rolloutTree.getSessionTrees(sessionId),
          loadBody: (turn, step) => rolloutTree.getStepBody(sessionId, turn, step),
          releaseBody: (turn, step) => rolloutTree.releaseStepBody(sessionId, turn, step),
        }),
      }, RolloutTreeView))

      // composer dock：每个对话下方的摘要条，追加两阶段（fanout/judge）首 token 时延 + TPS。
      slots.inject('conversation.composer.dock', () => slots.register({
        name: 'conversation.composer.dock',
        id: 'rollout-summary-dock',
        order: 80,
        inject: (sessionId) => ({
          loadTree: () => rolloutTree.getSessionTrees(sessionId),
          getSettings: () => rolloutTree.getSettings(sessionId),
          getStreamStats: () => rolloutTree.getSessionStreamStats(sessionId),
        }),
      }, RolloutSummary))

      slots.inject('conversation.input.right', () => slots.register({
        name: 'conversation.input.right',
        id: 'rollout-control',
        order: 20,
        inject: (sessionId) => ({
          getSettings: () => rolloutTree.getSettings(sessionId),
          setSettings: (patch) => rolloutTree.setSettings(sessionId, patch),
        }),
      }, RolloutControl))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
