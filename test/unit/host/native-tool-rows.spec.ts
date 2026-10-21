import { describe, expect, it } from 'vitest'
import { initialSessionFacts } from '../../../src/domain/session/session-facts.ts'
import type { SessionLike } from '../../../src/domain/session/session-facts.ts'
import type { AcpTerminalOutputPeek } from '../../../src/runtime/client-capabilities/terminal.ts'
import { AcpNativeToolRows } from '../../../src/host/composition/native-tool-rows.ts'
import type { AcpToolCallSnapshot } from '../../../src/host/composition/tool-call-reducer.ts'

interface Appended {
  readonly type: string
  readonly data: unknown
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error('expected an appended object')
  return value as Record<string, unknown>
}

function harness(peek?: (terminalId: string) => AcpTerminalOutputPeek | undefined) {
  const appends: Appended[] = []
  const session: SessionLike = {
    seq: 3,
    facts: { ...initialSessionFacts(), openSteps: [{ turn: 1, step: 1, startSeq: 2, messageIds: [] }] },
    permissions: { sandbox: null, approval: null },
    append: (type, data) => {
      appends.push({ type: String(type), data })
    },
  }
  const rows = new AcpNativeToolRows(session, 'acp-codex', 'model-a', undefined, peek)
  const result = (): { content: unknown; isError: unknown; toolCallId: unknown } => {
    const entry = appends.filter((appended) => appended.type === 'tool/result').at(-1)
    if (entry === undefined) throw new Error('no tool/result was appended')
    const message = record(record(entry.data)['message'])
    return { content: message['content'], isError: message['isError'], toolCallId: message['toolCallId'] }
  }
  return { rows, appends, result }
}

/** Merged ACP snapshots, as the reducer hands them to the recorder. */
function codexCall(overrides: Partial<AcpToolCallSnapshot>): AcpToolCallSnapshot {
  return {
    callId: 'exec-1',
    status: 'running',
    name: 'exec_command',
    kind: 'execute',
    title: "printf 'out\\n'",
    rawInput: { command: "printf 'out\\n'", cwd: '/work' },
    content: [{ type: 'terminal', terminalId: 'exec-1' }],
    ...overrides,
  }
}

describe('native ACP tool rows', () => {
  it('records a Codex terminal result from _meta chunks with the real exit marker', () => {
    const { rows, result } = harness()
    rows.observe(codexCall({}))
    rows.observe(codexCall({}), { terminal_output_delta: { data: 'boom-line\n', terminal_id: 'exec-1' } })
    rows.observe(codexCall({ status: 'failed' }), {
      terminal_output_delta: { data: 'still-scrolled\n', terminal_id: 'exec-1' },
      terminal_exit: { exit_code: 3, signal: null, terminal_id: 'exec-1' },
    })
    const { content, isError, toolCallId } = result()
    expect(toolCallId).toBe('exec-1')
    expect(isError).toBe(true)
    expect(content).toEqual([
      { type: 'text', text: 'boom-line\nstill-scrolled\n' },
      { type: 'text', text: '[exit code: 3]' },
    ])
  })

  it('leaves a clean exit unmarked and keeps the output verbatim', () => {
    const { rows, result } = harness()
    rows.observe(codexCall({}))
    rows.observe(codexCall({}), { terminal_output_delta: { data: 'PROBEX-line1\nPROBEX-line2\n' } })
    rows.observe(codexCall({ status: 'completed' }), { terminal_exit: { exit_code: 0, signal: null } })
    expect(result().content).toEqual([{ type: 'text', text: 'PROBEX-line1\nPROBEX-line2\n' }])
  })

  it('bounds a long captured body to its tail and marks the truncation', () => {
    const { rows, result } = harness()
    rows.observe(codexCall({}))
    rows.observe(codexCall({}), { terminal_output_delta: { data: 'x'.repeat(70_000) } })
    rows.observe(codexCall({ status: 'completed' }), { terminal_exit: { exit_code: 0, signal: null } })
    const content = result().content as Array<{ type: string; text: string }>
    expect(content).toHaveLength(2)
    expect(Buffer.byteLength(content[0]!.text, 'utf8')).toBeLessThanOrEqual(64_000)
    expect(content[0]!.text.endsWith('x')).toBe(true)
    expect(content[1]).toEqual({ type: 'text', text: '[output truncated]' })
  })

  it('prefers the client-side terminal the adapter still holds and uses its exit fact', () => {
    const { rows, result } = harness(() => ({
      output: 'from the managed terminal\n',
      truncated: false,
      exitCode: 2,
      signal: null,
    }))
    rows.observe(codexCall({}))
    rows.observe(codexCall({ status: 'completed' }))
    expect(result().content).toEqual([
      { type: 'text', text: 'from the managed terminal\n' },
      { type: 'text', text: '[exit code: 2]' },
    ])
  })

  it('keeps the omission marker when no output source exists', () => {
    const { rows, result } = harness()
    rows.observe(codexCall({}))
    rows.observe(codexCall({ status: 'completed' }))
    expect(result().content).toEqual([{ type: 'text', text: '[terminal output omitted from the native row]' }])
  })

  it('appends captured output for a command whose content carries no terminal item', () => {
    const { rows, result } = harness()
    const call: AcpToolCallSnapshot = {
      callId: 'exec-2',
      status: 'running',
      name: 'exec_command',
      rawInput: { command: 'ls', cwd: '/work' },
    }
    rows.observe(call)
    rows.observe(call, { terminal_output_delta: { data: 'file-a\n' } })
    rows.observe({ ...call, status: 'completed' }, { terminal_exit: { exit_code: 0, signal: null } })
    expect(result().content).toEqual([{ type: 'text', text: 'file-a\n' }])
  })

  it('advertises the call once with the presented bash row and settles it in the open step', () => {
    const { rows, appends } = harness()
    rows.observe(codexCall({}))
    rows.observe(codexCall({}), { terminal_output_delta: { data: 'out\n' } })
    rows.observe(codexCall({ status: 'completed' }), { terminal_exit: { exit_code: 0, signal: null } })
    const kinds = appends.map((appended) => appended.type)
    expect(kinds).toEqual(['assistant/message', 'tool/call', 'tool/result'])
    const call = record(appends[1]!.data)
    expect(call).toMatchObject({
      turn: 1,
      step: 1,
      callId: 'exec-1',
      name: 'bash',
      arguments: JSON.stringify({ command: "printf 'out\\n'", cwd: '/work' }, null, 2),
    })
  })
})