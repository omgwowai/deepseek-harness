// Unit tests for dsh-alignment's browser half (client.js): registration shape against the right-sidebar contract,
// badge counting, the shared page-list store (polling only while subscribed and visible), and the panel's states.
// React is faked: function components are called eagerly so the rendered tree is plain data.
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const react = {
  createElement: (type, props, ...children) => {
    const kids = children.flat(Infinity)
    if (typeof type === 'function') return type({ ...(props || {}), children: kids })
    return { type, props: props || {}, children: kids }
  },
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
  useSyncExternalStore: (_sub, get) => get(),
}
const textOf = (n) => (n == null || typeof n === 'boolean' ? '' : typeof n !== 'object' ? String(n) : Array.isArray(n) ? n.map(textOf).join('') : textOf(n.children))
const findAll = (n, pred, out = []) => { if (n && typeof n === 'object') { if (Array.isArray(n)) n.forEach((c) => findAll(c, pred, out)); else { if (pred(n)) out.push(n); findAll(n.children, pred, out) } } return out }

function fakeDoc() {
  const listeners = new Set()
  const head = { children: [], appendChild(el) { this.children.push(el) } }
  return {
    visibilityState: 'visible', head, listeners,
    getElementById: (id) => head.children.find((e) => e.id === id) ?? null,
    createElement: () => ({}), body: {},
    addEventListener: (_t, fn) => listeners.add(fn),
    removeEventListener: (_t, fn) => listeners.delete(fn),
  }
}

async function load() {
  let reg
  const doc = fakeDoc()
  const storage = new Map()
  globalThis.document = doc
  // the visibility reporter (usage log) watches the sidebar markup
  globalThis.MutationObserver = class { constructor(cb) { this.cb = cb } observe(target, opts) { doc.observed = { target, opts } } disconnect() { doc.observed = null } }
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0)
  globalThis.window = {
    __ModuleLoader__: { load: (r) => { reg = r } },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, pages: [] }) }),
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    addEventListener: () => {}, removeEventListener: () => {},
    location: { origin: 'http://127.0.0.1:3080' },
  }
  await import(pathToFileURL(path.join(pluginDir, 'client.js')).href + '?t=' + Math.random())
  assert.equal(reg.id, 'dsh-alignment', 'module id must equal the package name')
  return { bundle: reg.factory((spec) => { if (spec === 'react') return react; throw new Error('unexpected require ' + spec) }), doc }
}

const pagesResponse = (pages, status = 200) => async () => ({ ok: status === 200, status, json: async () => (status === 200 ? { ok: true, pages } : { ok: false, message: '需要先登录 DSH' }) })

test('registers a right-sidebar tab type with body + live title, and a header opener', async () => {
  const { bundle, doc } = await load()
  const registered = [], tabTypes = [], opened = []
  const slots = { inject: (_n, fn) => fn(), register: (opts, render) => { registered.push({ ...opts, render }); return () => {} } }
  const mounted = { getSnapshot: () => undefined, subscribe: () => () => {} }
  const native = { slots, effect: (fn) => fn(), sidebarRightTabs: { register: (def) => { tabTypes.push(def); return () => {} } }, sidebarRight: { openTab: (kind) => opened.push(kind), mounted, active: () => undefined, close: () => {}, focus: () => {}, isExpanded: () => false, toggleExpanded: () => {}, tabsIn: () => [] }, uiWorkspace: { openSession: () => {} } }
  const ctx = { get: (k) => (k === 'slots' ? slots : undefined), inject: (deps, fn) => { assert.deepEqual(deps, ['sidebarRight', 'sidebarRightTabs', 'uiWorkspace']); fn(native) } }
  bundle.apply(ctx)
  assert.equal(tabTypes.length, 1)
  const def = tabTypes[0]
  assert.equal(def.kind, 'alignment'); assert.equal(def.id, 'dsh-alignment/panel'); assert.equal(def.title(), '对齐页'); assert.equal(def.keepMounted, true)
  assert.equal(def.guide.length, 1); assert.equal(def.guide[0].title(), '对齐页')
  for (const seat of ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title']) assert.equal(registered.find((r) => r.name === seat)?.key, def.id, seat + ' keyed by the definition id')
  const header = registered.find((r) => r.name === 'conversation.session.header.actions')
  assert.equal(header.id, 'alignment-entry')
  const btn = header.render()
  btn.props.onClick()
  assert.deepEqual(opened, ['alignment'])
  assert.ok(doc.getElementById('dsh-alignment-style'), 'style injected once')
  assert.throws(() => bundle.apply({ get: () => undefined, inject: () => {} }), /slots service unavailable/)
})

// 2026-10-26: a DSH tab open for days gets new client.js through hot reload but kept the <style> of the old
// version (ensureStyle returned when the id existed); the 10-24 frame dock classes (.al-host / .al-frame /
// .al-elsewhere) had no rules, so the page sat in a 150px-tall iframe under a visible "另一个窗格" button.
test('apply replaces a stale style left by an older client.js', async () => {
  const { bundle, doc } = await load()
  doc.head.appendChild({ id: 'dsh-alignment-style', textContent: '.al-root{display:flex}' })
  const slots = { inject: (_n, fn) => fn(), register: () => () => {} }
  bundle.apply({ get: (k) => (k === 'slots' ? slots : undefined), inject: () => {} })
  const styles = doc.head.children.filter((e) => e.id === 'dsh-alignment-style')
  assert.equal(styles.length, 1, 'one style element')
  assert.match(styles[0].textContent, /\.al-host\{[^}]*display:flex/, 'current rules replace the stale ones')
})

test('badge counts open decisions across pages; header and title show it, hide it at zero', async () => {
  const { bundle } = await load()
  const { openCount, HeaderButtonView, TabTitleView } = bundle.__test
  assert.equal(openCount([{ open: 8 }, { open: 2 }, {}]), 10)
  assert.equal(openCount(null), 0)
  const badge = (tree) => findAll(tree, (n) => n.props?.className === 'al-badge').map(textOf)
  const b = HeaderButtonView({ count: 8, onOpen: () => {} })
  assert.deepEqual(badge(b), ['8']); assert.match(b.props['aria-label'], /8 件事等你/)
  assert.deepEqual(badge(HeaderButtonView({ count: 0, onOpen: () => {} })), [])
  assert.deepEqual(badge(TabTitleView({ count: 120 })), ['99+'])
})

test('store: fetches on first subscribe, polls only while visible, stops when last subscriber leaves', async () => {
  const { bundle } = await load()
  const { createPagesStore, POLL_MS } = bundle.__test
  const doc = fakeDoc()
  let calls = 0, tick = null, cleared = false
  const fetchFn = async (url, init) => { calls++; assert.equal(url, '/alignment/pages'); assert.equal(init.credentials, 'same-origin'); return pagesResponse([{ name: 'first-mate', title: 'FM', open: 3 }])() }
  const store = createPagesStore({ fetchFn, doc, setTimer: (fn, ms) => { assert.equal(ms, POLL_MS); tick = fn; return 1 }, clearTimer: () => { cleared = true } })
  let notified = 0
  const off = store.subscribe(() => notified++)
  await store.refresh()
  assert.equal(calls, 1, 'one request even though subscribe and refresh overlapped')
  assert.deepEqual(store.get(), { pages: [{ name: 'first-mate', title: 'FM', open: 3 }], error: null })
  assert.ok(notified >= 1)
  doc.visibilityState = 'hidden'; tick(); await new Promise((r) => setTimeout(r, 0))
  assert.equal(calls, 1, 'no polling while hidden')
  doc.visibilityState = 'visible'; for (const l of doc.listeners) l(); await store.refresh()
  assert.equal(calls, 2, 'refresh on becoming visible')
  off()
  assert.ok(cleared); assert.equal(doc.listeners.size, 0)
})

test('store keeps the last good list and reports the server message on failure', async () => {
  const { bundle } = await load()
  const { createPagesStore } = bundle.__test
  let fail = false
  const store = createPagesStore({ fetchFn: (...a) => (fail ? pagesResponse(null, 401) : pagesResponse([{ name: 'a', open: 1 }]))(...a), doc: fakeDoc(), setTimer: () => 0, clearTimer: () => {} })
  await store.refresh()
  fail = true
  await store.refresh()
  assert.deepEqual(store.get(), { pages: [{ name: 'a', open: 1 }], error: '需要先登录 DSH' })
})

test('panel: loading, error with retry, empty, single page, page picker, remembered pick', async () => {
  const { bundle } = await load()
  const { PanelView, pickPage } = bundle.__test
  const base = { picked: null, onPick: () => {}, onReload: () => {}, frameKey: 0, onFrameLoad: () => {} }
  assert.match(textOf(PanelView({ ...base, snap: { pages: null, error: null } })), /正在读取/)
  const err = PanelView({ ...base, snap: { pages: null, error: '需要先登录 DSH' } })
  assert.match(textOf(err), /需要先登录 DSH/); assert.ok(findAll(err, (n) => n.type === 'button' && textOf(n) === '重试').length === 1)
  assert.match(textOf(PanelView({ ...base, snap: { pages: [], error: null } })), /还没有对齐页/)
  const one = PanelView({ ...base, snap: { pages: [{ name: 'first-mate', title: 'First Mate 对齐页', open: 8 }], error: null } })
  const host = findAll(one, (n) => n.props?.className === 'al-host')[0]
  assert.equal(host.props['data-page'], 'first-mate', 'the panel draws a host for the shared iframe, not its own iframe')
  assert.equal(findAll(one, (n) => n.type === 'iframe').length, 0)
  assert.equal(findAll(one, (n) => n.type === 'select').length, 0, 'no picker for a single page')
  const two = PanelView({ ...base, picked: 'b', snap: { pages: [{ name: 'a', title: 'A', open: 2 }, { name: 'b', title: 'B', open: 0 }], error: null } })
  const sel = findAll(two, (n) => n.type === 'select')[0]
  assert.equal(sel.props.value, 'b'); assert.deepEqual(findAll(sel, (n) => n.type === 'option').map(textOf), ['A（2）', 'B'])
  assert.equal(findAll(two, (n) => n.props?.className === 'al-host')[0].props['data-page'], 'b')
  assert.equal(pickPage([{ name: 'a' }], 'gone'), 'a', 'a forgotten page falls back to the first')
})

test('badge scope: the label names which pages hold the open decisions; panel offers a switch when they are on another page', async () => {
  const { bundle } = await load()
  const { HeaderButtonView, PanelView } = bundle.__test
  const pages = [{ name: 'first-mate', title: 'First Mate 对齐页', open: 0 }, { name: 'test', title: '手机改版测试页', open: 3 }]
  const b = HeaderButtonView({ count: 3, pages, onOpen: () => {} })
  assert.equal(b.props['aria-label'], '对齐页，3 件事等你（手机改版测试页 3）')
  let picked = null
  const base = { onPick: (n) => { picked = n }, onReload: () => {}, frameKey: 0, onFrameLoad: () => {} }
  const panel = PanelView({ ...base, picked: 'first-mate', snap: { pages, error: null } })
  const sw = findAll(panel, (n) => n.props?.className === 'al-other')
  assert.equal(sw.length, 1)
  assert.equal(textOf(sw[0]), '3在 手机改版测试页')
  sw[0].props.onClick()
  assert.equal(picked, 'test')
  assert.equal(findAll(PanelView({ ...base, picked: 'test', snap: { pages, error: null } }), (n) => n.props?.className === 'al-other').length, 0)
  // 当前页也有待决定时，别的页面的仍然提示
  const both = [{ name: 'first-mate', title: 'FM', open: 1 }, { name: 'test', title: '手机改版测试页', open: 3 }]
  assert.equal(findAll(PanelView({ ...base, picked: 'first-mate', snap: { pages: both, error: null } }), (n) => n.props?.className === 'al-other').length, 1)
})

test('open session: switches the main area, waits for the sidebar to mount that session, then reopens the tab', async () => {
  const { bundle } = await load()
  const { openSessionKeepingPanel } = bundle.__test
  const calls = []
  let snap = 'session-a', listener = null
  const mounted = { getSnapshot: () => snap, subscribe: (fn) => { listener = fn; return () => { calls.push('unsub'); listener = null } } }
  const sidebarRight = { mounted, openTab: (k) => calls.push('openTab:' + k), tabsIn: () => [], isExpanded: () => true, active: () => undefined }
  const workspace = { openSession: (sid) => { calls.push('openSession:' + sid); snap = sid; listener?.() } }
  const frame = (cb) => { calls.push('frame'); cb() }
  await openSessionKeepingPanel({ workspace, sidebarRight, sid: 'session-b', frame, setTimer: () => 1, clearTimer: () => {} })
  assert.deepEqual(calls, ['openSession:session-b', 'unsub', 'frame', 'openTab:alignment'])
  // already on screen: no wait, still reopens the tab
  calls.length = 0
  await openSessionKeepingPanel({ workspace, sidebarRight, sid: 'session-b', frame, setTimer: () => 1, clearTimer: () => {} })
  assert.deepEqual(calls, ['openSession:session-b', 'frame', 'openTab:alignment'])
})

test('open session: unknown session and a sidebar that never mounts reject with the reason', async () => {
  const { bundle } = await load()
  const { openSessionKeepingPanel } = bundle.__test
  const mounted = { getSnapshot: () => 'session-a', subscribe: () => () => {} }
  const sidebarRight = { mounted, openTab: () => assert.fail('must not open the tab'), tabsIn: () => [], isExpanded: () => true, active: () => undefined }
  await assert.rejects(openSessionKeepingPanel({ workspace: { openSession: () => { throw new Error('unknown session session-x') } }, sidebarRight, sid: 'session-x', frame: (cb) => cb(), setTimer: () => 1, clearTimer: () => {} }), /unknown session/)
  let fire
  const p = openSessionKeepingPanel({ workspace: { openSession: () => {} }, sidebarRight, sid: 'session-y', frame: (cb) => cb(), setTimer: (fn) => { fire = fn; return 1 }, clearTimer: () => {} })
  fire()
  await assert.rejects(p, /侧栏 3 秒内没有就绪/)
})

test('open session message gate: only its own iframe, same origin, the fixed type and a session-shaped id', async () => {
  const { bundle } = await load()
  const { openRequestOf, OPEN_MSG } = bundle.__test
  const frame = {}, origin = 'http://127.0.0.1:3080'
  const ok = { source: frame, origin, data: { type: OPEN_MSG, sid: 'session-abc-123' } }
  assert.equal(openRequestOf(ok, frame, origin), 'session-abc-123')
  assert.equal(openRequestOf({ ...ok, source: {} }, frame, origin), null, 'another window')
  assert.equal(openRequestOf({ ...ok, origin: 'https://evil.example' }, frame, origin), null, 'another origin')
  assert.equal(openRequestOf({ ...ok, data: { type: 'x', sid: 'session-a' } }, frame, origin), null, 'another type')
  assert.equal(openRequestOf({ ...ok, data: { type: OPEN_MSG, sid: '../etc' } }, frame, origin), null, 'not a session id')
  assert.equal(openRequestOf(ok, null, origin), null, 'no frame yet')
})

test('First Mate refreshed: follow to the new one only while the main area still shows the old one', async () => {
  const { bundle } = await load()
  const { openRequestOf, REPLACED_MSG } = bundle.__test
  const frame = {}, origin = 'http://127.0.0.1:3080'
  const ev = { source: frame, origin, data: { type: REPLACED_MSG, oldSid: 'session-old', newSid: 'session-new' } }
  assert.equal(openRequestOf(ev, frame, origin, { now: 'session-old', last: 'session-old' }), 'session-new')
  assert.equal(openRequestOf(ev, frame, origin, { now: undefined, last: 'session-old' }), 'session-new', 'archiving emptied the main area')
  assert.equal(openRequestOf(ev, frame, origin, { now: 'session-other', last: 'session-other' }), null, 'user looks at another session: stay')
  assert.equal(openRequestOf(ev, frame, origin, { now: undefined, last: 'session-other' }), null, 'a global panel opened from elsewhere: stay')
  assert.equal(openRequestOf({ ...ev, origin: 'https://evil.example' }, frame, origin, { now: 'session-old' }), null)
  assert.equal(openRequestOf({ ...ev, data: { ...ev.data, newSid: 'x"' } }, frame, origin, { now: 'session-old' }), null)
})

test('open session: a target session that already has an alignment tab gets it focused, not a second one', async () => {
  const { showIn } = (await load()).bundle.__test
  const calls = []
  const sr = { tabsIn: () => [{ id: 't9', kind: 'alignment' }], active: () => ({ id: 't1', kind: 'files' }), focus: (id) => calls.push('focus:' + id), isExpanded: () => false, toggleExpanded: () => calls.push('expand'), openTab: () => calls.push('openTab') }
  assert.deepEqual(showIn(sr, 'session-b', () => false), { own: { id: 't9', kind: 'alignment' }, expandedHere: true })
  assert.deepEqual(calls, ['focus:t9', 'expand'])
  calls.length = 0
  showIn({ ...sr, tabsIn: () => [] }, 'session-b', () => false)
  assert.deepEqual(calls, ['openTab'])
})

test('open session (2026-10-26): a subagent session opens through its parent address and the tab follows the child', async () => {
  const { bundle } = await load()
  const { openSessionKeepingPanel, openRequestOf, OPEN_MSG } = bundle.__test
  const frame = {}, origin = 'http://127.0.0.1:3080', kid = '9a1b2c3d-aaaa-4bbb-8ccc-000000000002'
  const msg = (data) => ({ source: frame, origin, data: { type: OPEN_MSG, ...data } })
  assert.deepEqual(openRequestOf(msg({ sid: kid, parent: 'session-p1', mode: 'continuable' }), frame, origin), { parentSessionId: 'session-p1', childSessionId: kid, mode: 'continuable' })
  assert.deepEqual(openRequestOf(msg({ sid: kid, parent: 'session-p1', mode: 'one-shot' }), frame, origin)?.mode, 'one-shot')
  assert.equal(openRequestOf(msg({ sid: kid }), frame, origin), null, 'a bare id without its parent')
  assert.equal(openRequestOf(msg({ sid: kid, parent: 'session-p1', mode: 'external' }), frame, origin), null, 'external has no local session')
  assert.equal(openRequestOf(msg({ sid: kid, parent: '../x', mode: 'continuable' }), frame, origin), null, 'parent must be a session id')
  assert.equal(openRequestOf(msg({ sid: 'not-a-uuid', parent: 'session-p1', mode: 'continuable' }), frame, origin), null)
  const calls = []
  let snap = 'session-p1', listener = null
  const mounted = { getSnapshot: () => snap, subscribe: (fn) => { listener = fn; return () => { listener = null } } }
  const sidebarRight = { mounted, openTab: (k) => calls.push('openTab:' + k), tabsIn: () => [], isExpanded: () => true, active: () => undefined }
  const workspace = { openSession: (target) => { calls.push(target); snap = target.childSessionId; listener?.() } }
  const target = { parentSessionId: 'session-p1', childSessionId: kid, mode: 'continuable' }
  await openSessionKeepingPanel({ workspace, sidebarRight, sid: kid, target, frame: (cb) => cb(), setTimer: () => 1, clearTimer: () => {} })
  assert.deepEqual(calls, [target, 'openTab:alignment'])
})

test('full page (2026-11-08): the sidebar bar links to the page itself in a new tab, without the sidebar-only query', async () => {
  const { bundle } = await load()
  const { PanelView, fullUrl } = bundle.__test
  const base = { picked: null, onPick: () => {}, onReload: () => {} }
  const one = PanelView({ ...base, snap: { pages: [{ name: 'first-mate', title: 'First Mate 对齐页', open: 2 }], error: null } })
  const a = findAll(one, (n) => n.type === 'a' && n.props?.className === 'al-full')
  assert.equal(a.length, 1)
  assert.equal(a[0].props.href, '/alignment/p/first-mate', 'relative: the remote entry opens the remote address, 3080 the local one')
  assert.equal(a[0].props.target, '_blank'); assert.equal(a[0].props.rel, 'noopener')
  assert.equal(textOf(a[0]), '整页打开')
  assert.equal(fullUrl('a b'), '/alignment/p/a%20b')
  const two = PanelView({ ...base, picked: 'b', snap: { pages: [{ name: 'a', open: 0 }, { name: 'b', open: 0 }], error: null } })
  assert.equal(findAll(two, (n) => n.props?.className === 'al-full')[0].props.href, '/alignment/p/b', 'follows the picked page')
  assert.equal(findAll(PanelView({ ...base, snap: { pages: [], error: null } }), (n) => n.props?.className === 'al-full').length, 0, 'no page, no link')
})

test('full page: #align-open=<sid> in the DSH address is a request to open that session (same gate as the iframe message)', async () => {
  const { bundle } = await load()
  const { deepLinkOf } = bundle.__test
  const KID = '0b1c2d3e-4f50-4617-8899-aabbccddeeff'
  assert.equal(deepLinkOf(''), undefined)
  assert.equal(deepLinkOf('#d=d-1'), undefined, 'the alignment page\'s own hashes are not requests')
  assert.equal(deepLinkOf('#align-open=session-abc'), 'session-abc')
  assert.deepEqual(deepLinkOf('#align-open=' + KID + '&parent=session-p&mode=continuable'), { parentSessionId: 'session-p', childSessionId: KID, mode: 'continuable' })
  assert.equal(deepLinkOf('#align-open=' + KID), null, 'a subagent id without its parent is refused')
  assert.equal(deepLinkOf('#align-open=' + KID + '&parent=session-p&mode=external'), null)
  assert.equal(deepLinkOf('#align-open=..%2Fx'), null)
})

function fakeTab(hash) {
  const listeners = new Map(), posted = [], replaced = []
  const win = {
    location: { hash, pathname: '/', search: '', origin: 'http://127.0.0.1:3080' },
    history: { state: { k: 1 }, replaceState: (s, _t, url) => { replaced.push(url); win.location.hash = '' } },
    opener: { postMessage: (m, o) => posted.push([m, o]) },
    addEventListener: (t, fn) => listeners.set(t, fn), removeEventListener: (t) => listeners.delete(t),
  }
  return { win, listeners, posted, replaced }
}
function fakeMounted(v) {
  const subs = new Set()
  return { getSnapshot: () => v, subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn) }, set(x) { v = x; for (const f of [...subs]) f() }, subs }
}

test('full page: the DSH tab opens the session from #align-open once DSH has restored its own selection, then drops the hash and answers', async () => {
  const { bundle } = await load()
  const { createDeepLink } = bundle.__test
  const t = fakeTab('#align-open=session-b')
  const mounted = fakeMounted(undefined)
  const opened = [], later = []
  const flush = () => { while (later.length) later.shift()() }
  const dispose = createDeepLink({ win: t.win, workspace: { openSession: (x) => opened.push(x) }, mounted, defer: (cb) => later.push(cb) })
  assert.deepEqual(t.replaced, ['/'], 'the request leaves the address bar at once (a reload does not repeat it)')
  flush()
  assert.deepEqual(opened, [], 'not before DSH restored its last session: the restore would switch it back')
  mounted.set('session-old')
  assert.deepEqual(opened, [], 'not inside the mounted notification either: DSH is still inside its replaceMain and would overwrite the switch')
  flush()
  assert.deepEqual(opened, ['session-b'])
  assert.deepEqual(t.posted, [[{ type: 'dsh-alignment/open-session-result', ok: true }, 'http://127.0.0.1:3080']])
  mounted.set('session-b'); flush()
  assert.equal(opened.length, 1, 'one request opens once')
  // a later click in the full page reuses this tab: only the hash changes
  t.win.location.hash = '#align-open=session-c'
  t.listeners.get('hashchange')(); flush()
  assert.deepEqual(opened, ['session-b', 'session-c'])
  dispose()
  assert.equal(mounted.subs.size, 0); assert.equal(t.listeners.has('hashchange'), false)
})

test('full page: a bad id or a failed switch is answered with the reason; no request, nothing happens', async () => {
  const { bundle } = await load()
  const { createDeepLink } = bundle.__test
  const bad = fakeTab('#align-open=nope')
  createDeepLink({ defer: (cb) => cb(), win: bad.win, workspace: { openSession: () => assert.fail('must not open') }, mounted: fakeMounted('session-a') })
  assert.equal(bad.posted[0][0].ok, false); assert.match(bad.posted[0][0].error, /会话 ID/)
  const boom = fakeTab('#align-open=session-gone')
  createDeepLink({ defer: (cb) => cb(), win: boom.win, workspace: { openSession: () => { throw new Error('sessions.retain: unknown session') } }, mounted: fakeMounted('session-a'), report: () => {} })
  assert.deepEqual(boom.posted[0][0], { type: 'dsh-alignment/open-session-result', ok: false, error: 'sessions.retain: unknown session' })
  const none = fakeTab('#something')
  createDeepLink({ defer: (cb) => cb(), win: none.win, workspace: { openSession: () => assert.fail('must not open') }, mounted: fakeMounted('session-a') })
  assert.deepEqual([none.posted, none.replaced], [[], []], 'an unrelated hash is left alone')
  const orphan = fakeTab('#align-open=session-b')
  orphan.win.opener = null
  const opened = []
  createDeepLink({ defer: (cb) => cb(), win: orphan.win, workspace: { openSession: (x) => opened.push(x) }, mounted: fakeMounted('session-a') })
  assert.deepEqual(opened, ['session-b'], 'typed or bookmarked (no opener): still opens')
})
