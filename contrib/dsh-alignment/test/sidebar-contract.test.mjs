// Upstream shape the shared alignment iframe relies on (dsh-client-ui-sidebar-right, read from the installed bundle):
// each session's sidebar is a <div data-sidebar-right-session={sid} hidden={!active}> view, and keepMounted tab
// bodies stay mounted in background views. If upstream renames the attribute or stops keeping bodies, the frame dock
// would fail loud at attach time; this test turns red at gate time instead.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

function sidebarBundle() {
  const bin = path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const req = createRequire(realpathSync(bin))
  const pkg = req.resolve('@deepseek-ai/dsh-client-ui-sidebar-right/package.json')
  return readFileSync(path.join(path.dirname(pkg), 'lib', 'client.js'), 'utf8')
}

test('sidebar-right draws one hidden-toggled view per session, tagged with the session id', () => {
  const src = sidebarBundle()
  assert.match(src, /hidden: !active,\s*"data-sidebar-right-session": view\.sessionId/, 'per-session view markup changed')
  assert.match(src, /retained = seat === "sidebar\.right\.pane\.tab" && definition\?\.keepMounted === true/, 'keepMounted retention changed')
})

test('client.js reads the same attribute', () => {
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(client, /const SESSION_ATTR = 'data-sidebar-right-session'/)
})
