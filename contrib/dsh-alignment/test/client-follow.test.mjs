// Unit tests for the shared alignment iframe (createFrameDock) and the follow-on-switch rule (createFollower) in
// client.js. The DOM is a tiny fake: elements know their parent, whether they are connected and displayed, and the
// fake counts how often the iframe was re-inserted with appendChild (a reload in a browser) instead of moveBefore.
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

function fakeDom({ moveBefore = true } = {}) {
  const stats = { reloads: 0, moves: 0 }
  const detach = (c) => { if (c.parentNode) { c.parentNode.children = c.parentNode.children.filter((x) => x !== c); c.parentNode = null } }
  let body
  const el = (tag, attrs = {}) => {
    const e = {
      tag, attrs, children: [], parentNode: null, hidden: false, listeners: {},
      get isConnected() { let n = e; while (n.parentNode) n = n.parentNode; return n === body },
      closest(sel) { const a = /\[([^\]]+)\]/.exec(sel)[1]; let n = e; while (n) { if (n.attrs?.[a] !== undefined) return n; n = n.parentNode } return null },
      getAttribute: (k) => e.attrs[k] ?? null,
      getClientRects() { let n = e; while (n) { if (n.hidden) return []; n = n.parentNode } return e.isConnected ? [{}] : [] },
      appendChild(c) { const was = c.isConnected; detach(c); c.parentNode = e; e.children.push(c); if (c.tag === 'iframe' && was) stats.reloads++; return c },
      remove() { detach(e) },
      addEventListener(t, fn) { e.listeners[t] = fn },
    }
    if (moveBefore) e.moveBefore = (c) => { detach(c); c.parentNode = e; e.children.push(c); stats.moves++ }
    return e
  }
  body = el('body')
  const ids = {}
  const doc = {
    body,
    getElementById: (id) => { const x = ids[id]; return x && x.isConnected ? x : null },
    createElement: (tag) => { const x = el(tag); x.contentWindow = { tag: 'win' }; Object.defineProperty(x, 'id', { set: (v) => { ids[v] = x }, get: () => undefined }); return x },
  }
  /** One session view of the sidebar with a panel host inside; hidden = not the selected session. */
  const view = (sid, hidden = false) => { const v = el('div', { 'data-sidebar-right-session': sid }); v.hidden = hidden; body.appendChild(v); const host = el('div'); v.appendChild(host); return { v, host } }
  return { doc, body, view, stats, el }
}

const noTimers = { setTimer: () => 1, clearTimer: () => {} }

test('one iframe follows the session on screen without reloading (moveBefore)', async () => {
  const { createFrameDock } = await load()
  const dom = fakeDom()
  let sid = 'session-a'
  let seen = false
  const dock = createFrameDock({ doc: dom.doc, onScreen: () => sid, seen: () => seen, onLoad: () => {}, ...noTimers })
  const a = dom.view('session-a')
  const offA = dock.attach(a.host)
  dock.show('first-mate', 'light', 'First Mate')
  const frame = a.host.children[0]
  assert.equal(frame.tag, 'iframe'); assert.equal(frame.src, '/alignment/p/first-mate?embed=1&theme=light'); assert.equal(frame.title, 'First Mate')
  assert.equal(dock.visible(), false); seen = true; assert.equal(dock.visible(), true)
  // switch to B: B's view becomes the selected one and its panel mounts
  a.v.hidden = true; sid = 'session-b'
  const b = dom.view('session-b')
  dock.attach(b.host)
  assert.equal(frame.parentNode, b.host, 'frame moved into the on-screen session')
  // back to A: A's panel stayed mounted (keepMounted); place() moves the frame back
  b.v.hidden = true; a.v.hidden = false; sid = 'session-a'
  dock.place()
  assert.equal(frame.parentNode, a.host)
  assert.equal(dom.stats.reloads, 0, 'never re-inserted with appendChild')
  assert.equal(frame.src, '/alignment/p/first-mate?embed=1&theme=light', 'src untouched: no navigation')
  // the panel in A goes away (tab closed): the frame moves to the remaining host instead of dying with A
  offA()
  assert.equal(frame.parentNode, b.host)
})

test('a session without the tab keeps the frame where it is; the last host leaving parks it, then it is dropped', async () => {
  const { createFrameDock, DROP_MS } = await load()
  const dom = fakeDom()
  let sid = 'session-a'
  const timers = []
  const dock = createFrameDock({ doc: dom.doc, onScreen: () => sid, seen: () => true, onLoad: () => {}, setTimer: (fn, ms) => { assert.equal(ms, DROP_MS); timers.push(fn); return 1 }, clearTimer: () => {} })
  const a = dom.view('session-a')
  const off = dock.attach(a.host)
  dock.show('p', 'dark')
  const frame = a.host.children[0]
  sid = 'session-c'; dock.place()
  assert.equal(frame.parentNode, a.host, 'no panel in C: stay in A (hidden with it)')
  off()
  assert.equal(frame.parentNode.hidden, true, 'parked in a hidden holder, still alive')
  assert.equal(frame.isConnected, true)
  // a host coming back within DROP_MS picks the same frame up
  const a2 = dom.view('session-a'); sid = 'session-a'
  const off2 = dock.attach(a2.host)
  assert.equal(a2.host.children[0], frame)
  off2(); timers.at(-1)()
  assert.equal(frame.isConnected, false, 'removed after the last panel is gone')
  assert.equal(dock.window(), null); assert.equal(dock.visible(), false)
})

test('page switch navigates the one frame; reload re-sets src; without moveBefore the move falls back to appendChild', async () => {
  const { createFrameDock } = await load()
  const dom = fakeDom({ moveBefore: false })
  let sid = 'session-a'
  const warned = []
  const dock = createFrameDock({ doc: dom.doc, onScreen: () => sid, seen: () => true, onLoad: () => {}, warn: (m) => warned.push(m), ...noTimers })
  const a = dom.view('session-a'); dock.attach(a.host); dock.show('p1', 'light')
  const frame = a.host.children[0]
  dock.show('p2', 'light')
  assert.equal(frame.src, '/alignment/p/p2?embed=1&theme=light')
  frame.src = 'x'; dock.reload('dark'); assert.equal(frame.src, '/alignment/p/p2?embed=1&theme=dark')
  a.v.hidden = true; sid = 'session-b'
  const b = dom.view('session-b'); dock.attach(b.host)
  assert.equal(frame.parentNode, b.host)
  assert.equal(dom.stats.reloads, 1, 'old browsers reload once; the page restores from localStorage')
  assert.equal(warned.length, 1); assert.match(warned[0], /moveBefore/)
  a.v.hidden = false; b.v.hidden = true; sid = 'session-a'; dock.place()
  assert.equal(warned.length, 1, 'warned once only')
})

test('a panel outside a sidebar session view fails loud', async () => {
  const { createFrameDock } = await load()
  const dom = fakeDom()
  const dock = createFrameDock({ doc: dom.doc, onScreen: () => 'session-a', seen: () => true, onLoad: () => {} })
  const stray = dom.el('div'); dom.body.appendChild(stray)
  assert.throws(() => dock.attach(stray), /data-sidebar-right-session/)
})

test('two alignment tabs visible in one session: the one keeping the frame stays put, the other can claim it', async () => {
  const { createFrameDock } = await load()
  const dom = fakeDom()
  const dock = createFrameDock({ doc: dom.doc, onScreen: () => 'session-a', seen: () => true, onLoad: () => {}, ...noTimers })
  const a = dom.view('session-a'); dock.attach(a.host); dock.show('p', 'light')
  const frame = a.host.children[0]
  const second = dom.el('div'); a.v.appendChild(second); dock.attach(second)
  assert.equal(frame.parentNode, a.host, 'a second visible tab does not steal the frame')
  dock.claim(second)
  assert.equal(frame.parentNode, second, 'its placeholder button moves it there')
  dock.place(); assert.equal(frame.parentNode, second, 'and it stays there')
})

/** Fake sidebar of the session on screen: per session {expanded, active, tabs}; ids are kind names. */
function fakeSidebar(start) {
  let snap = start, listener
  const s = {}
  const log = []
  const at = () => (s[snap] ??= { expanded: false, active: 'guide', tabs: ['guide'] })
  return {
    log, s,
    go(sid) { snap = sid; listener?.() },
    listener: () => listener,
    sidebarRight: {
      mounted: { getSnapshot: () => snap, subscribe: (fn) => { listener = fn; return () => { listener = null } } },
      openTab: (k) => { log.push('open ' + k + '@' + snap); const x = at(); x.expanded = true; if (!x.tabs.includes(k)) x.tabs.push(k); x.active = k },
      active: () => ({ id: at().active, kind: at().active }),
      tabsIn: (sid) => (s[sid]?.tabs ?? []).map((id) => ({ id, kind: id })),
      focus: (id) => { log.push('focus ' + id + '@' + snap); at().active = id },
      close: (id) => { log.push('close ' + id + '@' + snap); const x = at(); x.tabs = x.tabs.filter((t) => t !== id); if (x.active === id) x.active = x.tabs[0] ?? 'guide' },
      isExpanded: () => at().expanded,
      toggleExpanded: () => { log.push('toggle@' + snap); at().expanded = !at().expanded },
    },
  }
}
const memStorage = () => { const m = new Map(); return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) } }
const now = (cb) => cb()

test('follower: opens the page in the next session while it was visible; stops once the user closed it', async () => {
  const { createFollower } = await load()
  const f = fakeSidebar('session-a')
  f.s['session-a'] = { expanded: true, active: 'alignment', tabs: ['alignment'] }
  let visible = true, places = 0
  const off = createFollower({ sidebarRight: f.sidebarRight, storage: memStorage(), visible: () => visible, place: () => places++, isFloating: () => false, frame: now })
  f.go('session-b')
  assert.deepEqual(f.log, ['open alignment@session-b'])
  visible = false; f.go('session-c')
  assert.deepEqual(f.log, ['open alignment@session-b'], 'closed: later switches leave the sidebar alone')
  // a global panel in between keeps the decision made when the last session left
  visible = true; f.go(undefined); visible = false; f.go('session-d')
  assert.deepEqual(f.log, ['open alignment@session-b', 'open alignment@session-d'])
  assert.ok(places >= 8, 'the frame is placed before and after every switch')
  f.listener()(); assert.equal(f.log.length, 2, 'same snapshot again: nothing')
  off(); assert.equal(f.listener(), null)
})

test('follower: a session that has its own alignment tab (other pane, behind another tab) gets it focused, never a duplicate', async () => {
  const { createFollower } = await load()
  const f = fakeSidebar('session-a')
  f.s['session-b'] = { expanded: false, active: 'files', tabs: ['files', 'alignment'] }
  const st = memStorage()
  let visible = true
  createFollower({ sidebarRight: f.sidebarRight, storage: st, visible: () => visible, place: () => {}, isFloating: () => false, frame: now })
  f.go('session-b')
  assert.deepEqual(f.log, ['focus alignment@session-b', 'toggle@session-b'])
  assert.deepEqual(f.s['session-b'].tabs, ['files', 'alignment'], 'no second alignment tab')
  // user stops following and comes back: B's own tab stays, the files tab is in front again, column collapsed again
  visible = false; f.go('session-c'); f.go('session-b')
  assert.deepEqual(f.log.slice(2), ['focus files@session-b', 'toggle@session-b'])
  assert.deepEqual(f.s['session-b'], { expanded: false, active: 'files', tabs: ['files', 'alignment'] })
})

test('follower: undo only when the sidebar is still as following left it; the record survives a reload', async () => {
  const { createFollower, FOLLOW_KEY } = await load()
  const st = memStorage()
  let f = fakeSidebar('session-a')
  f.s['session-b'] = { expanded: false, active: 'guide', tabs: ['guide'] }
  let visible = true
  let off = createFollower({ sidebarRight: f.sidebarRight, storage: st, visible: () => visible, place: () => {}, isFloating: () => false, frame: now })
  f.go('session-b')
  assert.ok(st.m.has(FOLLOW_KEY + 'session-b'), 'what following changed in B is saved')
  // user opens a file in B afterwards, then leaves with the page hidden behind it
  f.sidebarRight.openTab('files')
  visible = false; f.go('session-c'); f.go('session-b')
  assert.deepEqual(f.s['session-b'], { expanded: true, active: 'files', tabs: ['guide', 'alignment', 'files'] }, "the user's changes win: nothing undone")
  assert.equal(st.m.has(FOLLOW_KEY + 'session-b'), false, 'and the record is dropped')
  // reload: a new follower (new page) with the same storage still undoes an untouched copy
  off()
  visible = true; f.go('session-a')
  off = createFollower({ sidebarRight: f.sidebarRight, storage: st, visible: () => visible, place: () => {}, isFloating: () => false, frame: now })
  f.s['session-d'] = { expanded: false, active: 'guide', tabs: ['guide'] }
  f.go('session-d')
  off()
  const g = fakeSidebar('session-a'); g.s['session-d'] = f.s['session-d']; g.s['session-a'] = { expanded: false, active: 'guide', tabs: ['guide'] }
  createFollower({ sidebarRight: g.sidebarRight, storage: st, visible: () => false, place: () => {}, isFloating: () => false, frame: now })
  g.go('session-e'); g.go('session-d')
  assert.deepEqual(g.log, ['close alignment@session-d', 'toggle@session-d'])
  assert.deepEqual(g.s['session-d'], { expanded: false, active: 'guide', tabs: ['guide'] })
})

test('follower: a stale record (user changed the sidebar since) is not merged into a new follow', async () => {
  const { createFollower, FOLLOW_KEY } = await load()
  const st = memStorage()
  const f = fakeSidebar('session-a')
  f.s['session-b'] = { expanded: false, active: 'guide', tabs: ['guide'] }
  let visible = true
  createFollower({ sidebarRight: f.sidebarRight, storage: st, visible: () => visible, place: () => {}, isFloating: () => false, frame: now })
  f.go('session-b') // following opens and expands in B
  // user, in B, closes the copy and opens a file (the column stays expanded by the user's choice); leaves while following
  f.sidebarRight.close('alignment'); f.sidebarRight.openTab('files')
  f.go('session-a'); f.s['session-a'] = { expanded: true, active: 'alignment', tabs: ['alignment'] }
  f.go('session-b') // following again: B had expanded=true by the user now
  const rec = JSON.parse(st.m.get(FOLLOW_KEY + 'session-b'))
  assert.equal(rec.expanded, false, 'the old "following expanded B" is not carried over')
  visible = false; f.go('session-c'); f.go('session-b')
  assert.equal(f.s['session-b'].expanded, true, "the user's expanded column stays")
})

test('follower: own tab in a floating panel is focused without expanding the collapsed column', async () => {
  const { createFollower } = await load()
  const f = fakeSidebar('session-a')
  f.s['session-b'] = { expanded: false, active: 'guide', tabs: ['guide', 'alignment'] }
  createFollower({ sidebarRight: f.sidebarRight, storage: memStorage(), visible: () => true, place: () => {}, isFloating: (sid, id) => sid === 'session-b' && id === 'alignment', frame: now })
  f.go('session-b')
  assert.deepEqual(f.log, ['focus alignment@session-b'])
})

test('follower: errors from visible() and place() are reported, the switch goes on without following', async () => {
  const { createFollower } = await load()
  const f = fakeSidebar('session-a')
  const reported = []
  createFollower({ sidebarRight: f.sidebarRight, storage: memStorage(), visible: () => { throw new Error('markup changed') }, place: () => { throw new Error('no view') }, isFloating: () => false, frame: now, report: (e) => reported.push(e.message) })
  f.go('session-b')
  assert.deepEqual(reported, ['markup changed', 'no view', 'no view'])
  assert.deepEqual(f.log, [])
})

test('follower: an openTab failure is reported, not thrown into the store notification', async () => {
  const { createFollower } = await load()
  let snap = 'session-a', listener
  const reported = []
  createFollower({ sidebarRight: { mounted: { getSnapshot: () => snap, subscribe: (fn) => { listener = fn; return () => {} } }, isExpanded: () => false, active: () => undefined, tabsIn: () => [], openTab: () => { throw new Error('no session surface is mounted') } }, storage: memStorage(), visible: () => true, place: () => {}, isFloating: () => false, frame: now, report: (e) => reported.push(e.message) })
  snap = 'session-b'; listener()
  assert.deepEqual(reported, ['no session surface is mounted'])
})

test('seenNow: narrow fullscreen, collapsed column, hidden view are not seen; desktop fullscreen and floating are; missing markup throws', async () => {
  const { seenNow } = await load()
  const mk = ({ panel = 'push', open = true, float = false, visible = true, inView = true } = {}) => ({
    closest: (sel) => (sel === '[data-sidebar-right-session]' ? (inView ? {} : null) : sel === '[data-sidebar-right-panel]' ? (panel === null ? null : { getAttribute: () => panel, hasAttribute: () => open }) : sel === '[data-dockkit-float]' ? (float ? {} : null) : null),
    checkVisibility: () => visible,
  })
  const wide = () => false, narrow = () => true
  assert.equal(seenNow(mk(), wide), true)
  assert.equal(seenNow(mk({ panel: 'fullscreen' }), narrow), false, 'narrow screens: the page covers the conversation, do not follow')
  assert.equal(seenNow(mk({ panel: 'fullscreen' }), wide), true, 'a fullscreen the user picked on desktop still follows')
  assert.equal(seenNow(mk({ open: false }), wide), false, 'collapsed column')
  assert.equal(seenNow(mk({ open: false, float: true }), wide), true, 'a floating page stays on screen while the column is collapsed')
  assert.equal(seenNow(mk({ visible: false }), wide), false, 'hidden session view / inactive tab')
  assert.equal(seenNow(mk({ inView: false }), wide), false, 'parked frame')
  assert.throws(() => seenNow(mk({ panel: null }), wide), /data-sidebar-right-panel/)
  assert.throws(() => seenNow(mk({ panel: 'docked' }), wide), /data-sidebar-right-panel/)
})

test('pick store: one page choice shared by every panel, remembered in localStorage', async () => {
  const { createPickStore } = await load()
  const m = new Map([['dsh-alignment.page', 'a']])
  const s = createPickStore({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) })
  let n = 0; s.subscribe(() => n++)
  assert.equal(s.get(), 'a')
  s.set('b'); s.set('b'); s.set('')
  assert.equal(s.get(), 'b'); assert.equal(m.get('dsh-alignment.page'), 'b'); assert.equal(n, 1)
})
