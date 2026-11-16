// client.js createVisibilityReporter（2026-10-24，对齐页使用日志）：侧栏收起 / 切标签 / 切会话时告诉页面看不看得见，
// 页面据此停算「可见时长」。假依赖：observe 记下回调、frame / setTimer 手动触发、target 收 postMessage。
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
async function load() {
  let reg
  globalThis.document = { getElementById: () => null, head: { appendChild() {} }, createElement: () => ({}) }
  globalThis.window = { __ModuleLoader__: { load: (r) => { reg = r } } }
  await import(pathToFileURL(path.join(pluginDir, 'client.js')).href + '?t=' + Math.random())
  return reg.factory(() => ({ createElement: () => null })).__test
}
const T = await load()

function rig({ seen = () => true, win = true } = {}) {
  const st = { posts: [], frames: [], timers: new Map(), observed: null, stopped: false, errors: [], seen, win, nextId: 1 }
  const w = { postMessage: (m, o) => st.posts.push([m.type, m.visible, o]) }
  const r = T.createVisibilityReporter({
    doc: {}, seen: () => st.seen(), target: () => (st.win ? w : null), origin: 'http://h',
    observe: (cb) => { st.observed = cb; return () => { st.stopped = true } },
    frame: (cb) => st.frames.push(cb),
    setTimer: (cb) => { const id = st.nextId++; st.timers.set(id, cb); return id }, clearTimer: (id) => st.timers.delete(id),
    report: (e) => st.errors.push(e.message),
  })
  const runFrames = () => { const f = st.frames.splice(0); f.forEach((cb) => cb()) }
  const runTimers = () => { const t = [...st.timers.values()]; st.timers.clear(); t.forEach((cb) => cb()) }
  return { r, st, runFrames, runTimers }
}

test('侧栏变化合并成每帧一次检查，只在变化时发；400ms 后再查一次（收起动画之后）', () => {
  const { r, st, runFrames, runTimers } = rig()
  let vis = true; st.seen = () => vis
  st.observed(); st.observed(); st.observed()
  assert.equal(st.frames.length, 1, '同一帧里的多次变化只查一次')
  runFrames()
  assert.deepEqual(st.posts, [[T.VISIBLE_MSG, true, 'http://h']])
  runTimers()
  assert.equal(st.posts.length, 1, '没变就不再发')
  vis = false; st.observed(); runFrames()
  assert.deepEqual(st.posts.at(-1), [T.VISIBLE_MSG, false, 'http://h'])
  vis = true; st.observed(); runFrames(); runTimers()
  assert.deepEqual(st.posts.map((p) => p[1]), [true, false, true])
  assert.equal(st.timers.size, 0)
  r.dispose()
})

test('页面重新加载：再发一次当前状态；没有 iframe 时不发；检查出错报告、不发', () => {
  const { r, st, runFrames } = rig()
  r.schedule(); runFrames()
  r.loaded(); runFrames()
  assert.deepEqual(st.posts.map((p) => p[1]), [true, true], '加载后页面当自己看得见，要再告诉它一次')
  st.win = false; r.loaded(); runFrames()
  assert.equal(st.posts.length, 2)
  st.win = true; st.seen = () => { throw new Error('markup changed') }; r.schedule(); runFrames()
  assert.deepEqual(st.errors, ['markup changed'])
  assert.equal(st.posts.length, 2)
  r.dispose()
  assert.ok(st.stopped && st.timers.size === 0, 'dispose 停掉监听和定时器')
})

test('frame dock 的 seenByUser：窄屏全屏也算看得见（visible() 为跟随判断不算）', () => {
  const calls = []
  const dock = T.createFrameDock({ doc: { getElementById: () => null, createElement: () => ({ addEventListener() {}, isConnected: true }), body: { appendChild() {} } }, onScreen: () => undefined, seen: (f, narrow) => { calls.push(narrow ? narrow() : 'default'); return true }, onLoad() {} })
  assert.equal(dock.seenByUser(), false, '还没有 iframe')
})
