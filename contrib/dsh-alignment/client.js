/**
 * dsh-alignment client: the alignment pages as a right-sidebar tab inside the DSH web UI (same pattern as
 * dsh-personal-ops): opened from a conversation-header button or the right sidebar's guide page. The tab embeds this
 * plugin's own route /alignment/p/<page> in a same-origin iframe, so the DSH login cookie carries over and the page's
 * own answer POSTs work unchanged. The header button and the tab chip show the number of things waiting for the user
 * (sum of `open` from GET /alignment/pages: cards to handle, api 7), polled while the browser tab is visible.
 * Server side (routes, auth) is ./index.js; this file only draws the entry and the embed.
 *
 * Open session (2026-10-23): the embedded page posts {type: 'dsh-alignment/open-session', sid}; the panel checks the
 * message comes from its own iframe on this origin, switches the main area with uiWorkspace.openSession(sid), waits for
 * the right sidebar to mount that session (sidebarRight.mounted) and opens this tab there. The sidebar layout is kept
 * per session by DSH, so the target session gets its own copy of the tab; the page restores its selection, drafts and
 * scroll from localStorage (template align-view:<page> / align-picks:<page>). The result goes back to the iframe as
 * {type: 'dsh-alignment/open-session-result', ok, error?}.
 * A subagent's session (2026-10-26): {sid: <bare uuid>, parent: <its parent session-…>, mode: continuable | one-shot |
 * unknown} opens through the address object {parentSessionId, childSessionId, mode}, the way DSH's own subagent catalog
 * does (a bare string id the client has not seen throws 'sessions.retain: unknown session').
 *
 * Follow across sessions (2026-10-24): one iframe serves every alignment tab (createFrameDock). Each panel renders an
 * empty host; the dock moves the iframe into the host of the session on screen with Element.moveBefore, which keeps
 * the document alive (selection, scroll, drafts, splitter, polling timers, no reload, no flash). Browsers without
 * moveBefore fall back to appendChild, which reloads the page; it then restores from localStorage as before. When the
 * main area changes session while the alignment page was visible (seenNow, read before the new session renders), the
 * new session's sidebar shows this tab (createFollower). Closing the tab or collapsing the sidebar makes it not
 * visible, so later switches leave sidebars alone and undo the copies following opened.
 */
window.__ModuleLoader__.load({
  id: 'dsh-alignment',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const { createElement: h, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } = React

    const TAB_KIND = 'alignment'
    const TAB_ID = 'dsh-alignment/panel'
    const NAME = '对齐页'
    const PAGES_URL = '/alignment/pages'
    /** embed=1 hides the page's own title and theme switch; theme follows the DSH page (body[data-ds-dark-theme]). */
    const pageUrl = (name, theme) => '/alignment/p/' + encodeURIComponent(name) + '?embed=1&theme=' + theme
    const hostTheme = (doc) => (doc.body?.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light')
    const subscribeHostTheme = (cb) => { const o = new MutationObserver(cb); o.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] }); return () => o.disconnect() }
    const POLL_MS = 15000
    const PICK_KEY = 'dsh-alignment.page'
    const OPEN_MSG = 'dsh-alignment/open-session'
    const SID_RE = /^session-[A-Za-z0-9-]{1,128}$/
    /** A subagent's session id: a bare uuid (its session directory name), no session- prefix (2026-10-26). */
    const CHILD_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    /** Subagent modes DSH can open (an external one has no local session). */
    const CHILD_MODES = new Set(['continuable', 'one-shot', 'unknown'])
    const MOUNT_WAIT_MS = 3000

    /**
     * Switch the main area to sid and reopen this tab in its sidebar. Rejects with the reason (unknown session,
     * sidebar not mounted in time) instead of leaving the user on a session without the page.
     */
    function openSessionKeepingPanel({ workspace, sidebarRight, sid, target = sid, setTimer = setTimeout, clearTimer = clearTimeout, frame = (cb) => requestAnimationFrame(cb) }) {
      // target: sid, or a subagent's address {parentSessionId, childSessionId: sid, mode} (how DSH's own subagent catalog opens one)
      return new Promise((resolve, reject) => {
        const mounted = sidebarRight.mounted
        let off = () => {}, timer = null
        const done = (error) => { off(); clearTimer(timer); if (error) reject(error); else resolve() }
        const openHere = () => frame(() => { try { showIn(sidebarRight, sid); done() } catch (e) { done(e) } })
        if (mounted.getSnapshot() === sid) { try { workspace.openSession(target) } catch (e) { return done(e) } return openHere() }
        off = mounted.subscribe(() => { if (mounted.getSnapshot() === sid) { off(); off = () => {}; openHere() } })
        timer = setTimer(() => done(new Error('切到会话 ' + sid + ' 后侧栏 ' + MOUNT_WAIT_MS / 1000 + ' 秒内没有就绪')), MOUNT_WAIT_MS)
        try { workspace.openSession(target) } catch (e) { done(e) }
      })
    }

    const REPLACED_MSG = 'dsh-alignment/fm-replaced'

    /** Whether tab id of session sid sits in a floating panel (on screen even while the column is collapsed). */
    const floatingTab = (sid, id) => !!document.querySelector('[data-sidebar-right-session="' + sid + '"] [data-dockkit-float] [data-sidebar-right-tab="' + id + '"]')

    /**
     * Show the alignment page in the on-screen session sid: its own alignment tab when it has one (another pane,
     * a floating panel, behind another tab; openTab only dedupes within the active docked pane, so it would add a
     * second one), otherwise a new tab. A collapsed column is expanded unless the tab floats.
     * @returns {{own: TabRecord | undefined, expandedHere: boolean}} what was done
     */
    function showIn(sidebarRight, sid, isFloating = floatingTab) {
      const own = sidebarRight.tabsIn(sid).find((t) => t.kind === TAB_KIND)
      if (!own) { const was = sidebarRight.isExpanded(); sidebarRight.openTab(TAB_KIND); return { own, expandedHere: !was } }
      if (sidebarRight.active()?.id !== own.id) sidebarRight.focus(own.id)
      if (sidebarRight.isExpanded() || isFloating(sid, own.id)) return { own, expandedHere: false }
      sidebarRight.toggleExpanded()
      return { own, expandedHere: true }
    }
    const SESSION_ATTR = 'data-sidebar-right-session'
    const PARK_ID = 'dsh-alignment-park'
    const DROP_MS = 1000

    /**
     * The single alignment iframe shared by every panel. attach(host) registers a panel's host element (returns
     * detach); show(name, theme, title) creates or navigates the frame; place() moves it into the host of the
     * session on screen (visible one first), keeps it where it is when that session has no panel, and parks it when
     * its host goes away. With no hosts left for DROP_MS the frame is removed.
     * visible() says whether the user can see the page right now, read from the sidebar's markup (see seenNow).
     * deps: doc, onScreen() -> sid | undefined, seen(frame) -> boolean, onLoad(), setTimer / clearTimer, warn.
     */
    function createFrameDock({ doc, onScreen, seen, onLoad, setTimer = setTimeout, clearTimer = clearTimeout, warn = (m) => console.warn(m) }) {
      const hosts = new Set()
      let frame = null, page = null, dropTimer = null, warned = false
      const sessionOf = (host) => {
        const view = host.closest('[' + SESSION_ATTR + ']')
        if (!view) throw new Error('[dsh-alignment] the panel is not inside a [' + SESSION_ATTR + '] view; the dsh sidebar markup changed')
        return view.getAttribute(SESSION_ATTR)
      }
      const park = () => {
        let el = doc.getElementById(PARK_ID)
        if (!el) { el = doc.createElement('div'); el.id = PARK_ID; el.hidden = true; doc.body.appendChild(el) }
        return el
      }
      const move = (host) => {
        if (!frame || frame.parentNode === host) return
        // moveBefore keeps the iframe's document; appendChild of a connected iframe reloads it
        if (typeof host.moveBefore === 'function' && frame.isConnected && host.isConnected) return host.moveBefore(frame, null)
        if (frame.isConnected && !warned) { warned = true; warn('[dsh-alignment] this browser has no Element.moveBefore: the alignment page reloads when it moves to another session (state comes back from localStorage)') }
        host.appendChild(frame)
      }
      const shown = (host) => host.getClientRects().length > 0
      const place = (leaving) => {
        if (!frame) return
        const live = [...hosts].filter((x) => x !== leaving && x.isConnected)
        const sid = onScreen()
        const here = sid === undefined ? [] : live.filter((x) => sessionOf(x) === sid)
        const parent = frame.parentNode
        const target = (here.includes(parent) && shown(parent) ? parent : here.find(shown)) ?? here[0] ?? (live.includes(parent) ? parent : live[0])
        move(target ?? park())
      }
      const drop = () => {
        clearTimer(dropTimer); dropTimer = null
        if (hosts.size > 0 || !frame) return
        frame.remove(); frame = null; page = null
      }
      return {
        attach(host) {
          sessionOf(host)
          hosts.add(host); clearTimer(dropTimer); dropTimer = null
          place()
          return () => {
            hosts.delete(host)
            // runs before React removes the host, so the frame leaves it alive
            if (frame && frame.parentNode === host) place(host)
            if (hosts.size === 0) dropTimer = setTimer(drop, DROP_MS)
          }
        },
        show(name, theme, title) {
          if (!frame) {
            frame = doc.createElement('iframe')
            frame.className = 'al-frame'
            frame.addEventListener('load', () => onLoad())
            // inserted by place() below, straight into its host: moving a loading frame would reload it
          }
          if (page !== name) { page = name; frame.src = pageUrl(name, theme) }
          if (title !== undefined) frame.title = title
          place()
        },
        reload(theme) { if (frame && page) frame.src = pageUrl(page, theme) },
        theme(theme) { const d = frame?.contentDocument; if (d?.documentElement) d.documentElement.dataset.theme = theme },
        place: () => place(),
        /** Put the frame into this host (the user asked for it here: a second visible alignment tab). */
        claim(host) { if (hosts.has(host)) move(host) },
        window: () => frame?.contentWindow ?? null,
        visible: () => frame !== null && frame.isConnected && seen(frame),
        /** Whether the user sees the page (usage log): like visible() but a fullscreen panel on a narrow screen counts. */
        seenByUser: () => frame !== null && frame.isConnected && seen(frame, () => false),
        hosts: () => hosts.size,
      }
    }

    /**
     * Whether the user sees the alignment frame: displayed (not in a hidden session view, not an inactive tab), the
     * column is open or the frame floats, and not on a narrow screen with the panel fullscreen (there the page would
     * cover the conversation the user just picked, so it does not follow). Missing panel markup throws. Read from the sidebar's markup, which still shows
     * the old session when mounted changes. checkVisibility is missing only in old browsers (pre-2023); the
     * getClientRects fallback ignores visibility:hidden, acceptable since the open attribute already covers collapse.
     */
    function seenNow(frame, narrow = () => window.innerWidth < 768) {
      if (!frame.closest('[' + SESSION_ATTR + ']')) return false // parked between panels
      const panel = frame.closest('[data-sidebar-right-panel]')
      const mode = panel?.getAttribute('data-sidebar-right-panel')
      if (mode !== 'push' && mode !== 'fullscreen') throw new Error('[dsh-alignment] the sidebar panel has no data-sidebar-right-panel="push|fullscreen" (got ' + mode + '); the dsh sidebar markup changed')
      // upstream turns the panel fullscreen by itself below 768 px; a fullscreen the user picked on desktop still follows
      if (mode === 'fullscreen' && narrow()) return false
      if (!panel.hasAttribute('data-sidebar-right-open') && !frame.closest('[data-dockkit-float]')) return false
      return typeof frame.checkVisibility === 'function' ? frame.checkVisibility({ visibilityProperty: true }) : frame.getClientRects().length > 0
    }

    const VISIBLE_MSG = 'dsh-alignment/visible'
    // sidebar markup that changes when the frame is shown or hidden: column collapse, session view, active pane / tab, float, fullscreen
    const VISIBILITY_ATTRS = ['hidden', 'aria-hidden', 'style', 'data-sidebar-right-open', 'data-sidebar-right-panel', 'data-dockkit-pane-active', 'data-dockkit-float-active', 'data-dockkit-tab-active']
    const RECHECK_MS = 400

    /**
     * Tells the page in the frame whether the user can see it ({type: VISIBLE_MSG, visible}), for its usage log: a collapsed
     * column, another sidebar tab or a session without the page stops the page's visible time (a hidden browser tab the
     * page sees itself through visibilitychange). Sidebar attribute changes are coalesced into one check per animation
     * frame plus one RECHECK_MS later (after the collapse transition); only changes are posted, and every frame load
     * posts again. deps: doc, seen() -> boolean (dock.seenByUser), target() -> frame window | null, origin, observe(cb) ->
     * stop, frame(cb), setTimer / clearTimer, report(error).
     */
    function createVisibilityReporter({ doc, seen, target, origin, observe, frame = (cb) => requestAnimationFrame(cb), setTimer = setTimeout, clearTimer = clearTimeout, report = (e) => console.error('[dsh-alignment] visibility check failed', e) }) {
      let last = null, queued = false, timer = null
      const check = () => {
        queued = false
        const w = target()
        if (!w) { last = null; return }
        let v
        try { v = seen() } catch (e) { report(e); return }
        if (v === last) return
        last = v
        try { w.postMessage({ type: VISIBLE_MSG, visible: v }, origin) } catch { last = null /* the frame went away meanwhile */ }
      }
      const schedule = () => {
        if (!queued) { queued = true; frame(check) }
        clearTimer(timer); timer = setTimer(check, RECHECK_MS)
      }
      const stop = (observe ?? ((cb) => { const o = new MutationObserver(cb); o.observe(doc.body, { attributes: true, subtree: true, attributeFilter: VISIBILITY_ATTRS }); return () => o.disconnect() }))(schedule)
      return {
        schedule,
        /** The frame (re)loaded: its page starts as visible, so post the real state again. */
        loaded() { last = null; schedule() },
        dispose() { stop(); clearTimer(timer) },
      }
    }

    const FOLLOW_KEY = 'dsh-alignment.follow.'

    /**
     * Show the page in the next session when it was on screen as the last session left.
     * visible() is read when mounted changes, before the new session renders; a global panel in between (mounted
     * undefined) keeps the decision made when the last session left.
     * Following reuses the session's own alignment tab if it has one (focus), otherwise opens one, and expands a
     * collapsed column. What it changed is saved per session in localStorage (survives reloads, shared by browser
     * tabs): {added, expanded, prevActive, after: {active, tabs}}. When the user has stopped following (closed the page
     * or collapsed the column) and comes back to such a session, the change is undone only if that session's sidebar
     * is still exactly as following left it; anything the user did there since wins and the record is dropped.
     */
    function createFollower({ sidebarRight, storage, visible, place, isFloating = floatingTab, frame = (cb) => requestAnimationFrame(cb), report = (e) => console.error('[dsh-alignment] could not open or close the alignment tab in the new session', e) }) {
      const mounted = sidebarRight.mounted
      let prev = mounted.getSnapshot(), follow = false
      const ids = (sid) => sidebarRight.tabsIn(sid).map((t) => t.id).sort()
      const read = (sid) => { try { return JSON.parse(storage.getItem(FOLLOW_KEY + sid) ?? 'null') } catch { return null } }
      const arrive = (sid) => {
        const active = sidebarRight.active(), expanded = sidebarRight.isExpanded()
        if (follow) {
          if (expanded && active?.kind === TAB_KIND) return
          // an earlier record only counts while the sidebar is still as following left it
          const prior = read(sid)
          const old = prior && prior.after?.active === (active?.id ?? null) && JSON.stringify(prior.after?.tabs ?? []) === JSON.stringify(ids(sid)) ? prior : null
          const { own, expandedHere } = showIn(sidebarRight, sid, isFloating)
          const now = sidebarRight.active()
          storage.setItem(FOLLOW_KEY + sid, JSON.stringify({
            added: own ? (old?.added === own.id ? own.id : null) : now?.id ?? null,
            expanded: expandedHere || old?.expanded === true,
            prevActive: own && active?.id !== own.id ? active?.id ?? null : old?.prevActive ?? null,
            after: { active: now?.id ?? null, tabs: ids(sid) },
          }))
          return
        }
        const rec = read(sid)
        if (!rec) return
        storage.removeItem(FOLLOW_KEY + sid)
        const untouched = sidebarRight.active()?.id === rec.after?.active && JSON.stringify(ids(sid)) === JSON.stringify(rec.after?.tabs ?? [])
        if (!untouched) return
        if (rec.added) sidebarRight.close(rec.added)
        if (rec.prevActive && ids(sid).includes(rec.prevActive)) sidebarRight.focus(rec.prevActive)
        if (rec.expanded && sidebarRight.isExpanded()) sidebarRight.toggleExpanded()
      }
      const onChange = () => {
        const now = mounted.getSnapshot()
        if (now === prev) return
        // errors go to report: throwing here would land in the sidebar's store notification
        if (prev !== undefined) { try { follow = visible() } catch (e) { follow = false; report(e) } }
        prev = now
        try { place() } catch (e) { report(e) } // before the new session paints: its kept panel gets the frame now
        frame(() => {
          if (now !== undefined && mounted.getSnapshot() === now) { try { arrive(now) } catch (e) { report(e) } }
          try { place() } catch (e) { report(e) }
        })
      }
      return mounted.subscribe(onChange)
    }

    /**
     * The panel's message gate: only messages from its own iframe on this origin, with session-shaped ids.
     * open-session {sid} -> sid; fm-replaced {oldSid, newSid} (First Mate refreshed) -> newSid when the main area shows
     * oldSid, or shows nothing and oldSid was the last session on it (archiving it empties the main area), else null:
     * the user is elsewhere, leave them there. screen = {now, last}.
     */
    function openRequestOf(event, frameWindow, origin, screen = {}) {
      if (!frameWindow || event.source !== frameWindow || event.origin !== origin) return null
      const d = event.data
      if (d && d.type === REPLACED_MSG) {
        if (!SID_RE.test(d.oldSid ?? '') || !SID_RE.test(d.newSid ?? '')) return null
        return screen.now === d.oldSid || (screen.now === undefined && screen.last === d.oldSid) ? d.newSid : null
      }
      if (!d || d.type !== OPEN_MSG) return null
      return targetOf(d)
    }

    /** {sid, parent?, mode?} -> what uiWorkspace.openSession takes: a session-… id, a subagent's address, or null. */
    function targetOf(d) {
      if (typeof d.sid !== 'string') return null
      if (SID_RE.test(d.sid)) return d.sid
      // a subagent's session (2026-10-26): its bare id plus the parent it was dispatched from and its catalog mode
      if (CHILD_RE.test(d.sid) && typeof d.parent === 'string' && SID_RE.test(d.parent) && CHILD_MODES.has(d.mode)) return { parentSessionId: d.parent, childSessionId: d.sid, mode: d.mode }
      return null
    }

    /** The full page itself (no embed / theme query: those are for the sidebar frame). Relative, so a remote entry stays remote. */
    const fullUrl = (name) => '/alignment/p/' + encodeURIComponent(name)

    const DEEP_KEY = 'align-open'
    /** '#align-open=<sid>[&parent=<sid>&mode=<mode>]' -> target; undefined when the hash carries no request, null when it is malformed. */
    function deepLinkOf(hash) {
      const q = new URLSearchParams(String(hash || '').replace(/^#/, ''))
      if (!q.has(DEEP_KEY)) return undefined
      return targetOf({ sid: q.get(DEEP_KEY), parent: q.get('parent') ?? undefined, mode: q.get('mode') ?? undefined })
    }

    /**
     * Full page (2026-11-08): the alignment page open in a browser tab of its own has no sidebar around it, so its
     * 打开会话 / First Mate / subagent buttons open a DSH tab at /#align-open=<sid>[&parent=&mode=] (one tab, reused by
     * window name: a later request only changes the hash). This tab switches its main area to that session once DSH has
     * restored its own selection (mounted is a session; switching earlier would be overridden by the restore), drops the
     * hash, and answers the page that opened it with open-session-result. DSH itself does not read location.hash.
     * The switch runs a task later (defer): mounted is published from inside DSH's own replaceMain, and a switch made
     * there is overwritten when that call finishes (seen on a cold tab: First Mate for 10 ms, then the restored session).
     */
    function createDeepLink({ win, workspace, mounted, defer = (cb) => setTimeout(cb, 0), report = (m, e) => console.error(m, e) }) {
      let pending = null, queued = false
      const reply = (msg) => { try { win.opener?.postMessage({ type: OPEN_MSG + '-result', ...msg }, win.location.origin) } catch { /* the page that opened this tab is gone */ } }
      const run = () => {
        queued = false
        if (pending === null || mounted.getSnapshot() === undefined) return
        const target = pending
        pending = null
        try { workspace.openSession(target); reply({ ok: true }) } catch (e) { report('[dsh-alignment] open session from the address bar failed', e); reply({ ok: false, error: e?.message ?? String(e) }) }
      }
      const open = () => { if (pending !== null && !queued && mounted.getSnapshot() !== undefined) { queued = true; defer(run) } }
      const take = () => {
        const target = deepLinkOf(win.location.hash)
        if (target === undefined) return
        win.history.replaceState(win.history.state, '', win.location.pathname + win.location.search)
        if (target === null) { reply({ ok: false, error: '地址里的会话 ID 不对' }); return }
        pending = target
        open()
      }
      const off = mounted.subscribe(open)
      win.addEventListener('hashchange', take)
      take()
      return () => { off(); win.removeEventListener('hashchange', take) }
    }

    /** Sum of undecided items across pages; the badge number. */
    const openCount = (pages) => (pages ?? []).reduce((n, p) => n + (Number.isInteger(p.open) ? p.open : 0), 0)

    /** Response of GET /alignment/pages -> pages, or a thrown Error with the server's message. */
    async function readPages(fetchFn) {
      const res = await fetchFn(PAGES_URL, { credentials: 'same-origin', cache: 'no-store' })
      let body
      try { body = await res.json() } catch { throw new Error('对齐页服务返回了无法解析的内容（HTTP ' + res.status + '）') }
      if (!res.ok || body?.ok !== true || !Array.isArray(body.pages)) throw new Error(body?.message || '对齐页服务出错（HTTP ' + res.status + '）')
      return body.pages
    }

    /**
     * One shared page list for every badge and panel: polls while anything subscribes and the document is visible,
     * refreshes immediately when the document becomes visible again. Snapshot = {pages, error} (reference-stable
     * between changes, as useSyncExternalStore requires).
     */
    function createPagesStore({ fetchFn, doc, setTimer = setInterval, clearTimer = clearInterval }) {
      let snap = { pages: null, error: null }
      const listeners = new Set()
      let timer = null
      let inflight = null
      const emit = () => { for (const l of listeners) l() }
      const refresh = () => {
        if (inflight) return inflight
        inflight = readPages(fetchFn)
          .then((pages) => { snap = { pages, error: null } }, (e) => { snap = { pages: snap.pages, error: e?.message ?? String(e) } })
          .finally(() => { inflight = null; emit() })
        return inflight
      }
      const onVisible = () => { if (doc.visibilityState === 'visible') refresh() }
      const start = () => {
        refresh()
        timer = setTimer(() => { if (doc.visibilityState === 'visible') refresh() }, POLL_MS)
        doc.addEventListener('visibilitychange', onVisible)
      }
      const stop = () => { clearTimer(timer); timer = null; doc.removeEventListener('visibilitychange', onVisible) }
      return {
        get: () => snap,
        refresh,
        subscribe(listener) {
          listeners.add(listener)
          if (listeners.size === 1) start()
          return () => { listeners.delete(listener); if (listeners.size === 0) stop() }
        },
      }
    }

    // ── styles ─────────────────────────────────────────────────────────────
    const STYLE_ID = 'dsh-alignment-style'
    const CSS = [
      '.al-hbtn{all:unset;box-sizing:border-box;cursor:pointer;position:relative;flex:none;display:inline-grid;place-items:center;width:28px;height:28px;margin-right:6px;border-radius:8px;color:var(--dsw-alias-label-secondary)}',
      '.al-hbtn .al-badge{position:absolute;top:-5px;right:-8px;min-width:15px;height:15px;padding:0 3px;font-size:10px;line-height:15px;box-shadow:0 0 0 2px var(--dsw-alias-bg-base)}',
      '.al-hbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.al-hbtn:focus-visible{outline:2px solid currentColor;outline-offset:1px}',
      '.al-badge{display:inline-block;min-width:18px;height:18px;padding:0 5px;box-sizing:border-box;border-radius:9px;background:#d93036;color:#fff;font-size:11px;font-weight:700;line-height:18px;text-align:center;font-variant-numeric:tabular-nums}',
      '.al-title{display:inline-flex;align-items:center;gap:5px;min-width:0}',
      '.al-root{display:flex;flex-direction:column;height:100%;min-height:0}',
      '.al-bar{display:flex;align-items:center;gap:8px;min-height:40px;padding:0 8px 0 16px;border-bottom:1px solid var(--dsw-alias-border-l2);font-size:13px;color:var(--dsw-alias-label-secondary)}',
      '.al-bar select{min-width:0;max-width:100%;height:28px;font:inherit;font-weight:600;color:var(--dsw-alias-label-primary);background:transparent;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;padding:0 8px}',
      '.al-bar .al-name{color:var(--dsw-alias-label-primary);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.al-ib{all:unset;cursor:pointer;margin-left:auto;width:28px;height:28px;border-radius:8px;display:inline-grid;place-items:center;flex:none}',
      '.al-bar{container-type:inline-size}',
      '.al-full{all:unset;box-sizing:border-box;cursor:pointer;flex:none;margin-left:auto;display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 8px;border-radius:8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.al-full:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.al-full:focus-visible{outline:2px solid currentColor;outline-offset:1px}',
      '.al-full + .al-ib{margin-left:0}',
      '@container (max-width:340px){.al-full{width:28px;padding:0;justify-content:center}.al-full-t{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}}',
      '.al-ib:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.al-ib:focus-visible{outline:2px solid currentColor;outline-offset:1px}',
      '.al-host{flex:1;min-height:0;display:flex}',
      '.al-elsewhere{all:unset;cursor:pointer;margin:auto;padding:16px;font-size:13px;color:var(--dsw-alias-label-secondary);text-align:center}',
      '.al-elsewhere:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}',
      '.al-elsewhere:focus-visible{outline:2px solid currentColor;outline-offset:2px;border-radius:6px}',
      '.al-host:has(> .al-frame) > .al-elsewhere{display:none}',
      '.al-frame{flex:1;min-height:0;width:100%;border:0;display:block;background:var(--dsw-alias-bg-base)}',
      '.al-other{all:unset;box-sizing:border-box;cursor:pointer;display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:55%;height:28px;padding:0 8px 0 4px;border-radius:8px;font-size:12px;color:var(--dsw-alias-label-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l3)}',
      '.al-other .al-badge{flex:none}',
      '.al-other-t{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.al-other:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.al-other:focus-visible{outline:2px solid currentColor;outline-offset:1px}',
      '.al-msg{padding:16px;font-size:13px;color:var(--dsw-alias-label-secondary)}',
      '.al-msg button{all:unset;cursor:pointer;margin-left:8px;text-decoration:underline}',
    ].join('\n')
    // a tab open across a hot reload keeps the old version's <style>: replace its rules, not only add when missing
    function ensureStyle(doc) {
      let el = doc.getElementById(STYLE_ID)
      if (!el) { el = doc.createElement('style'); el.id = STYLE_ID; doc.head.appendChild(el) }
      if (el.textContent !== CSS) el.textContent = CSS
    }

    // ── views ──────────────────────────────────────────────────────────────
    function Icon({ size }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('rect', { x: 2.5, y: 2, width: 11, height: 12.5, rx: 2 }), h('path', { d: 'M5 5.5l1 1 2-2M5 10l1 1 2-2M9.5 6h2M9.5 10.5h2' }))
    }
    function RefreshIcon() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.5h-2.5' }))
    }

    function FullIcon() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M9 2.75h4.25V7M13.25 2.75 7.5 8.5M11.25 9.5v3.75h-8.5v-8.5H6.5' }))
    }

    const Badge = ({ n }) => (n > 0 ? h('span', { className: 'al-badge', 'aria-hidden': 'true' }, n > 99 ? '99+' : String(n)) : null)
    /** "3 件事等你（手机改版测试页 3）": the badge sums every registered page, so name where they are. */
    const countLabel = (n, pages) => {
      if (!(n > 0)) return ''
      const where = (pages ?? []).filter((p) => p.open > 0).map((p) => (p.title || p.name) + ' ' + p.open)
      return n + ' 件事等你' + (where.length ? '（' + where.join('，') + '）' : '')
    }

    function HeaderButtonView({ count, pages, onOpen }) {
      const label = count > 0 ? NAME + '，' + countLabel(count, pages) : NAME
      return h('button', { type: 'button', className: 'al-hbtn', title: label, 'aria-label': label, onClick: onOpen }, h(Icon, { size: 16 }), h(Badge, { n: count }))
    }

    function TabTitleView({ count, pages }) {
      return h('span', { className: 'al-title', title: count > 0 ? countLabel(count, pages) : undefined }, NAME, h(Badge, { n: count }))
    }

    /** Which page to show: the remembered one while it still exists, otherwise the first registered. */
    const pickPage = (pages, remembered) => (pages.some((p) => p.name === remembered) ? remembered : pages[0]?.name ?? null)

    function PanelView({ snap, picked, onPick, onReload, hostRef, onClaim, attachError, onFull = () => {} }) {
      if (attachError) return h('div', { className: 'al-root' }, h('div', { className: 'al-msg', role: 'alert' }, '对齐页没法显示：' + attachError))
      const { pages, error } = snap
      if (pages === null && error === null) return h('div', { className: 'al-root' }, h('div', { className: 'al-msg' }, '正在读取…'))
      if (pages === null) return h('div', { className: 'al-root' }, h('div', { className: 'al-msg', role: 'alert' }, error, h('button', { type: 'button', onClick: onReload }, '重试')))
      if (pages.length === 0) return h('div', { className: 'al-root' }, h('div', { className: 'al-msg' }, '还没有对齐页'))
      const name = pickPage(pages, picked)
      const current = pages.find((p) => p.name === name)
      const optionText = (p) => (p.title || p.name) + (p.open > 0 ? '（' + p.open + '）' : '')
      return h('div', { className: 'al-root' },
        h('div', { className: 'al-bar' },
          pages.length > 1
            ? h('select', { 'aria-label': '选择对齐页', value: name, onChange: (e) => onPick(e.target.value) }, ...pages.map((p) => h('option', { key: p.name, value: p.name }, optionText(p))))
            : h('span', { className: 'al-name' }, current.title || current.name),
          (() => {
            // the badge counts all pages; when the waiting cards sit on another page, say so and offer the switch
            const other = pages.filter((p) => p.name !== name && p.open > 0)
            if (!other.length) return null
            const n = other.reduce((s, p) => s + p.open, 0)
            const where = other.length === 1 ? (other[0].title || other[0].name) : '其他页面'
            const full = '另 ' + n + ' 件事等你：' + other.map((p) => (p.title || p.name) + ' ' + p.open).join('，')
            return h('button', { type: 'button', className: 'al-other', onClick: () => onPick(other[0].name), title: full, 'aria-label': full },
              h(Badge, { n }), h('span', { className: 'al-other-t' }, '在 ' + where))
          })(),
          error ? h('span', { role: 'status', title: error }, '刷新失败') : null,
          h('a', { className: 'al-full', href: fullUrl(name), target: '_blank', rel: 'noopener', title: '在新标签页打开', onClick: onFull }, h(FullIcon), h('span', { className: 'al-full-t' }, '整页打开')),
          h('button', { type: 'button', className: 'al-ib', title: '重新载入', 'aria-label': '重新载入', onClick: onReload }, h(RefreshIcon))),
        h('div', { className: 'al-host', ref: hostRef, 'data-page': name },
          h('button', { type: 'button', className: 'al-elsewhere', onClick: onClaim }, '对齐页正在另一个窗格里显示，点这里移到这里')))
    }

    /** The page picked in any panel, shared by all of them (one iframe shows it). */
    function createPickStore(storage) {
      let picked = storage.getItem(PICK_KEY)
      const listeners = new Set()
      return {
        get: () => picked,
        set(name) { if (!name || name === picked) return; picked = name; storage.setItem(PICK_KEY, name); for (const l of listeners) l() },
        subscribe(l) { listeners.add(l); return () => listeners.delete(l) },
      }
    }

    function makeComponents(store, picks, dock) {
      const useSnap = () => useSyncExternalStore(store.subscribe, store.get)
      function HeaderButton({ onOpen }) {
        const pages = useSnap().pages
        return h(HeaderButtonView, { count: openCount(pages), pages, onOpen })
      }
      function TabTitle() {
        const pages = useSnap().pages
        return h(TabTitleView, { count: openCount(pages), pages })
      }
      function Panel() {
        const snap = useSnap()
        const picked = useSyncExternalStore(picks.subscribe, picks.get)
        const theme = useSyncExternalStore(subscribeHostTheme, () => hostTheme(document))
        const hostRef = useRef(null)
        const pages = snap.pages
        const name = pages?.length ? pickPage(pages, picked) : null
        const title = name ? ((p) => p.title || p.name)(pages.find((p) => p.name === name)) : undefined
        const [attachError, setAttachError] = useState(null)
        // a sidebar markup change fails loud here, in this panel, instead of throwing out of a layout effect
        useLayoutEffect(() => {
          if (!name || !hostRef.current) return undefined
          try { return dock.attach(hostRef.current) } catch (e) { console.error(e); setAttachError(e?.message ?? String(e)); return undefined }
        }, [name !== null])
        useLayoutEffect(() => { if (name) dock.show(name, theme, title) }, [name, title])
        // Theme switches apply inside the loaded page (same origin) instead of reloading it, so drafts survive.
        useEffect(() => dock.theme(theme), [theme])
        return h(PanelView, {
          snap, picked, hostRef, attachError,
          onClaim: () => dock.claim(hostRef.current),
          onPick: picks.set,
          onReload: () => { dock.reload(theme); store.refresh() },
          // the page's own selection (#d= / #r=) goes along, so the new tab opens on the same item
          onFull: (e) => { const hash = dock.window()?.location.hash; if (name && hash) e.currentTarget.href = fullUrl(name) + hash },
        })
      }
      return { HeaderButton, TabTitle, Panel }
    }

    const tabDef = (store) => ({
      id: TAB_ID,
      kind: TAB_KIND,
      keepMounted: true,
      title: () => NAME,
      guide: [{
        id: 'open', order: 55, title: () => NAME,
        description: () => countLabel(openCount(store.get().pages), store.get().pages) || '没有等你的事',
        icon: (p) => h(Icon, { size: p?.size ?? 16 }),
      }],
    })
    const openPanel = (sidebarRight) => sidebarRight.openTab(TAB_KIND)

    const inject = ['slots']
    function apply(ctx) {
      const slots = ctx.get('slots')
      if (!slots) throw new Error('[dsh-alignment] slots service unavailable')
      ensureStyle(document)
      const store = createPagesStore({ fetchFn: (...a) => window.fetch(...a), doc: document })
      let navigate = null
      const nav = (req) => (navigate ? navigate(req) : Promise.reject(new Error('DSH 的会话切换接口还没就绪')))
      let screen = () => ({})
      let onScreen = () => undefined
      let visibility = null
      const dock = createFrameDock({
        doc: document,
        onScreen: () => onScreen(),
        seen: seenNow,
        onLoad: () => { store.refresh(); visibility?.loaded() },
      })
      const picks = createPickStore(window.localStorage)
      const { HeaderButton, TabTitle, Panel } = makeComponents(store, picks, dock)
      // one listener for the shared frame (a listener per panel would act once per session holding the tab)
      const onMessage = (event) => {
        const frame = dock.window()
        const req = openRequestOf(event, frame, window.location.origin, screen())
        if (req === null) return
        const sid = typeof req === 'string' ? req : req.childSessionId
        const reply = (msg) => { try { frame.postMessage({ type: OPEN_MSG + '-result', ...msg }, window.location.origin) } catch { /* the frame was removed meanwhile */ } }
        nav(req).then(() => reply({ ok: true }), (e) => { console.error('[dsh-alignment] open session ' + sid + ' failed', e); reply({ ok: false, error: e?.message ?? String(e) }) })
      }
      ctx.inject(['sidebarRight', 'sidebarRightTabs', 'uiWorkspace'], (native) => {
        const workspace = native.uiWorkspace, sidebarRight = native.sidebarRight
        if (typeof workspace?.openSession !== 'function') throw new Error('[dsh-alignment] uiWorkspace.openSession is missing; the dsh client navigation API changed')
        if (typeof sidebarRight?.openTab !== 'function' || typeof sidebarRight?.mounted?.subscribe !== 'function' || typeof sidebarRight?.mounted?.getSnapshot !== 'function') throw new Error('[dsh-alignment] sidebarRight.openTab / mounted is missing; the dsh sidebar API changed')
        for (const m of ['active', 'close', 'focus', 'isExpanded', 'toggleExpanded', 'tabsIn']) if (typeof sidebarRight[m] !== 'function') throw new Error('[dsh-alignment] sidebarRight.' + m + ' is missing; the dsh sidebar API changed')
        navigate = (req) => (typeof req === 'string' ? openSessionKeepingPanel({ workspace, sidebarRight, sid: req }) : openSessionKeepingPanel({ workspace, sidebarRight, sid: req.childSessionId, target: req }))
        let last
        const track = () => { const now = sidebarRight.mounted.getSnapshot(); if (now !== undefined) last = now }
        track()
        native.effect(() => sidebarRight.mounted.subscribe(track))
        screen = () => ({ now: sidebarRight.mounted.getSnapshot(), last })
        onScreen = () => sidebarRight.mounted.getSnapshot()
        native.effect(() => createFollower({ sidebarRight, storage: window.localStorage, visible: dock.visible, place: dock.place }))
        native.effect(() => { window.addEventListener('message', onMessage); return () => window.removeEventListener('message', onMessage) })
        native.effect(() => createDeepLink({ win: window, workspace, mounted: sidebarRight.mounted }))
        native.effect(() => () => { navigate = null; onScreen = () => undefined })
        native.effect(() => {
          const vis = createVisibilityReporter({ doc: document, seen: dock.seenByUser, target: dock.window, origin: window.location.origin })
          visibility = vis
          const unsub = sidebarRight.mounted.subscribe(() => vis.schedule())
          return () => { unsub(); vis.dispose(); visibility = null }
        })
        native.effect(() => native.sidebarRightTabs.register(tabDef(store)))
        native.slots.inject('sidebar.right.pane.tab', () => native.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, () => h(Panel)))
        native.slots.inject('sidebar.right.pane.tab.title', () => native.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, () => h(TabTitle)))
        native.slots.inject('conversation.session.header.actions', () => native.slots.register(
          { name: 'conversation.session.header.actions', id: 'alignment-entry', order: 61 },
          () => h(HeaderButton, { onOpen: () => openPanel(native.sidebarRight) })))
      })
    }

    exports.apply = apply
    exports.inject = inject
    exports.__test = { createFrameDock, createFollower, seenNow, createVisibilityReporter, VISIBLE_MSG, showIn, FOLLOW_KEY, createPickStore, DROP_MS, openSessionKeepingPanel, openRequestOf, targetOf, deepLinkOf, createDeepLink, fullUrl, OPEN_MSG, REPLACED_MSG, openCount, readPages, createPagesStore, pickPage, PanelView, HeaderButtonView, TabTitleView, tabDef, openPanel, TAB_ID, TAB_KIND, POLL_MS }
    return module.exports
  },
})
