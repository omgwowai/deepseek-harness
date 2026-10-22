import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { connectFreshWorkspace, writeComposerDraft } from '#host-support'
import { OPTIONAL_TOOL_PLAN } from '../mock-agent/optional-tools-turn.ts'
import { launchBrowser, newEnglishPage, type TestBrowser } from './browser.ts'
import { callResult, launchOptionalToolWorld } from './optional-tool-world.ts'
import { required } from './required.ts'

const SEARCH_TOOLS = [
  'session_search',
  'session_event_search',
  'session_trace',
  'session_event_trace',
  'session_event_read',
]
const TERMINAL_TOOLS = [
  'terminal_open',
  'terminal_send',
  'terminal_read',
  'terminal_signal',
  'terminal_close',
  'terminal_list',
]

function shellQuote(text: string): string {
  return process.platform === 'win32' ? `'${text.replaceAll("'", "''")}'` : `'${text.replaceAll("'", "'\\''")}'`
}

function nodeCommand(script: string): string {
  return `${process.platform === 'win32' ? '& ' : ''}${shellQuote(process.execPath)} -e ${shellQuote(script)}`
}

it('mounts official session search and reads only prior history authorized by the caller workspace', async () => {
  const world = await launchOptionalToolWorld(['session-search'])
  try {
    const needle = 'OPTIONALSEARCHNEEDLE'
    const foreignSecret = 'FOREIGNHISTORYPRIVATE'
    const prior = await world.create()
    await world.run(prior, { label: needle, calls: [] })
    const priorEvent = required(
      prior.session
        .snapshotEvents()
        .find((event) => event.type === 'user/message' && JSON.stringify(event.data.content).includes(needle)),
    )
    const foreignCwd = join(world.workspaceCwd, 'foreign-workspace')
    mkdirSync(foreignCwd)
    const foreign = await world.create(foreignCwd)
    await world.run(foreign, { label: `${needle} ${foreignSecret}`, calls: [] })
    const foreignEvent = required(
      foreign.session
        .snapshotEvents()
        .find((event) => event.type === 'user/message' && JSON.stringify(event.data.content).includes(foreignSecret)),
    )
    const owner = await world.create()
    const result = await world.run(owner, {
      label: 'search-authorized-history',
      calls: [
        { name: 'session_search', arguments: { query: needle } },
        { name: 'session_event_search', arguments: { session_id: prior.id, query: needle } },
        { name: 'session_trace', arguments: { session_id: prior.id } },
        { name: 'session_event_trace', arguments: { session_id: prior.id, seq: priorEvent.seq } },
        { name: 'session_event_read', arguments: { session_id: prior.id, seq: priorEvent.seq, before: 1, after: 1 } },
      ],
    })
    expect(required(result.find((record) => record.kind === 'directory')).names).toEqual(
      expect.arrayContaining(SEARCH_TOOLS),
    )
    for (const name of SEARCH_TOOLS) expect(callResult(result, name).isError).toBe(false)
    const searched = callResult(result, 'session_search').text
    expect(searched).toContain(prior.id)
    expect(searched).toContain(needle)
    expect(searched).not.toContain(foreign.id)
    expect(searched).not.toContain(foreignSecret)
    expect(callResult(result, 'session_event_read').text).toContain(needle)
    expect(callResult(result, 'session_event_search').text).toContain(`seq ${priorEvent.seq}`)
    expect(callResult(result, 'session_trace').text).toContain(prior.id)
    expect(callResult(result, 'session_event_trace').text).toContain(String(priorEvent.seq))
    expect(world.nativeCalls.filter((call) => call.owner === owner.id).map((call) => call.name)).toEqual(SEARCH_TOOLS)

    // An explicit id cannot cross the same authorization boundary enforced by search.
    const denied = await world.run(owner, {
      label: 'search-foreign-denied',
      calls: [{ name: 'session_event_read', arguments: { session_id: foreign.id, seq: foreignEvent.seq } }],
    })
    expect(callResult(denied, 'session_event_read')).toMatchObject({ isError: true })
    expect(callResult(denied, 'session_event_read').text).toContain('outside the caller workspace')
    expect(callResult(denied, 'session_event_read').text).not.toContain(foreignSecret)

    // The current prompt is persisted, but the native current-step boundary excludes it.
    const current = await world.run(owner, {
      label: 'CURRENTSTEPSEARCHPRIVATE',
      calls: [{ name: 'session_event_search', arguments: { query: 'CURRENTSTEPSEARCHPRIVATE' } }],
    })
    expect(callResult(current, 'session_event_search')).toMatchObject({ isError: false })
    expect(callResult(current, 'session_event_search').text).toContain('No prior event matches found.')
    expect(prior.session.header.cwd).toBe(owner.session.header.cwd)
    expect(foreign.session.header.cwd).not.toBe(owner.session.header.cwd)
  } finally {
    await world.close()
  }
}, 90_000)

it('executes official persistent terminal tools with native approval, exact owners and cancellation', async () => {
  const world = await launchOptionalToolWorld(['terminal-bundle'])
  let browser: TestBrowser | undefined
  try {
    browser = await launchBrowser({ headless: true })
    const page = await newEnglishPage(browser)
    await page.goto(world.authenticatedUrl)
    await connectFreshWorkspace(page, world.workspaceCwd)
    await writeComposerDraft(
      page,
      page.locator('[data-composer-input]').first(),
      `${OPTIONAL_TOOL_PLAN}${JSON.stringify({ label: 'terminal-bootstrap', calls: [] })}`,
    )
    const bootstrap = world.whenTurnSettled()
    void bootstrap.catch(() => undefined)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    const resolved = await world.ctx.sessionController.resolveAgent(await bootstrap)
    if ('error' in resolved) throw new Error(resolved.error.message)
    const owner = resolved.agent
    await world.controls.setToolApprovalPolicy(owner.id, { policy: 'ask' })
    const rejecting = world.run(owner, {
      label: 'terminal-native-rejection',
      calls: [{ name: 'terminal_open', arguments: { type: 'shell', name: 'must-not-exist' } }],
    })
    void rejecting.catch(() => undefined)
    const approval = page.locator('[data-approval-key]').filter({ hasText: 'terminal_open' }).first()
    await approval.waitFor({ state: 'visible' })
    expect(world.nativeCalls.filter((call) => call.owner === owner.id)).toEqual([])
    await approval.getByRole('button', { name: 'Reject', exact: true }).click()
    const denied = await rejecting
    expect(denied.filter((record) => record.kind === 'call')).toEqual([])
    expect(required(denied.find((record) => record.kind === 'permission')).result).toMatchObject({
      outcome: { outcome: 'selected', optionId: 'deny' },
    })
    expect(world.nativeCalls.filter((call) => call.owner === owner.id)).toEqual([])
    expect(
      owner.session
        .snapshotEvents()
        .some((event) => event.type === 'approval/decided' && event.data.outcome === 'rejected'),
    ).toBe(true)

    await world.controls.setToolApprovalPolicy(owner.id, { policy: 'auto' })
    const opened = await world.run(owner, {
      label: 'terminal-open',
      calls: [{ name: 'terminal_open', arguments: { type: 'shell', name: 'official-state' } }],
    })
    expect(required(opened.find((record) => record.kind === 'directory')).names).toEqual(
      expect.arrayContaining(TERMINAL_TOOLS),
    )
    expect(callResult(opened, 'terminal_open').isError).toBe(false)
    const spawn = required(world.nativeCalls.find((call) => call.owner === owner.id && call.name === 'terminal_open'))
    const terminalId = (spawn.value as { sessionId: string }).sessionId
    expect(terminalId).toMatch(/^pty-/)
    expect(callResult(opened, 'terminal_open').text).toContain(terminalId)

    const setState =
      process.platform === 'win32'
        ? "$env:DSH_OPTIONAL_STATE='PERSISTENT_NATIVE_SECRET'"
        : "export DSH_OPTIONAL_STATE='PERSISTENT_NATIVE_SECRET'"
    await world.run(owner, {
      label: 'terminal-set-state',
      calls: [{ name: 'terminal_send', arguments: { sessionId: terminalId, text: setState } }],
    })
    const state = await world.run(owner, {
      label: 'terminal-read-state',
      calls: [
        {
          name: 'terminal_send',
          arguments: { sessionId: terminalId, text: nodeCommand('console.log(process.env.DSH_OPTIONAL_STATE)') },
        },
        { name: 'terminal_read', arguments: { sessionId: terminalId } },
        { name: 'terminal_list' },
      ],
    })
    expect(callResult(state, 'terminal_send').text).toContain('PERSISTENT_NATIVE_SECRET')
    expect(callResult(state, 'terminal_read').text).toContain('PERSISTENT_NATIVE_SECRET')
    expect(callResult(state, 'terminal_list').text).toContain(terminalId)

    const other = await world.create()
    const forbiddenWrite = join(world.workspaceCwd, 'foreign-terminal-write')
    const foreign = await world.run(other, {
      label: 'terminal-foreign-denied',
      calls: [
        { name: 'terminal_list' },
        { name: 'terminal_read', arguments: { sessionId: terminalId } },
        {
          name: 'terminal_send',
          arguments: {
            sessionId: terminalId,
            text: nodeCommand(`require('node:fs').writeFileSync(${JSON.stringify(forbiddenWrite)},'wrong-owner')`),
          },
        },
        { name: 'terminal_signal', arguments: { sessionId: terminalId, signal: 'SIGINT' } },
        { name: 'terminal_close', arguments: { sessionId: terminalId } },
      ],
    })
    expect(callResult(foreign, 'terminal_list')).toEqual({ isError: false, text: '(no terminal sessions)' })
    for (const name of ['terminal_read', 'terminal_send', 'terminal_signal', 'terminal_close']) {
      expect(callResult(foreign, name).isError).toBe(true)
      expect(callResult(foreign, name).text).toContain('belongs to another agent')
      expect(callResult(foreign, name).text).not.toContain('PERSISTENT_NATIVE_SECRET')
    }
    expect(existsSync(forbiddenWrite)).toBe(false)

    const ready = join(world.workspaceCwd, 'terminal-foreground.ready')
    const stopped = join(world.workspaceCwd, 'terminal-foreground.stopped')
    const cancel = join(world.workspaceCwd, 'terminal-mcp.cancel')
    const script = `const fs=require('node:fs');process.on('SIGINT',()=>{fs.writeFileSync(${JSON.stringify(stopped)},'interrupted');process.exit(0)});fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000)`
    const pending = world.run(owner, {
      label: 'terminal-cancel-call',
      calls: [
        { name: 'terminal_send', arguments: { sessionId: terminalId, text: nodeCommand(script) }, cancelFile: cancel },
      ],
    })
    void pending.catch(() => undefined)
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 15_000 })
    const childPid = Number(readFileSync(ready, 'utf8'))
    expect(childPid).toBeGreaterThan(0)
    writeFileSync(cancel, 'cancel this one MCP request')
    const cancelled = await pending
    expect(cancelled.filter((record) => record.kind === 'cancelled')).toMatchObject([{ name: 'terminal_send' }])
    await vi.waitFor(() => expect(existsSync(stopped)).toBe(true), { timeout: 10_000 })
    const after = await world.run(owner, {
      label: 'terminal-after-cancel',
      calls: [
        {
          name: 'terminal_send',
          arguments: { sessionId: terminalId, text: nodeCommand('console.log(process.env.DSH_OPTIONAL_STATE)') },
        },
        { name: 'terminal_close', arguments: { sessionId: terminalId } },
        { name: 'terminal_list' },
      ],
    })
    expect(callResult(after, 'terminal_send')).toMatchObject({ isError: false })
    expect(callResult(after, 'terminal_send').text).toContain('PERSISTENT_NATIVE_SECRET')
    expect(callResult(after, 'terminal_close').isError).toBe(false)
    expect(callResult(after, 'terminal_list')).toEqual({ isError: false, text: '(no terminal sessions)' })
    // This lane exercised Host PTY tools, never ACP terminal/create or acp-terminal jobs.
    expect(world.ctx.jobs.list(owner.id).filter((job) => job.kind === 'acp-terminal')).toEqual([])
  } finally {
    await browser?.close()
    await world.close()
  }
}, 120_000)
