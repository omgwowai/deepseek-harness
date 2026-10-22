import { describe, expect, it } from 'vitest'
import { AcpToolCallReducer } from '../../../src/host/composition/tool-call-reducer.ts'

describe('ACP tool-call reducer', () => {
  it('merges sparse updates into one current snapshot', () => {
    const reducer = new AcpToolCallReducer()
    expect(
      reducer.apply({
        callId: '7',
        title: 'Read',
        name: 'read_file',
        kind: 'read',
        rawInput: { path: '/tmp/a' },
        locations: [{ path: '/tmp/a' }],
        content: [{ type: 'terminal' }],
        status: 'in_progress',
      }).status,
    ).toBe('running')
    reducer.apply({ callId: '7', name: null, rawOutput: { bytes: 4 }, status: 'completed' })
    const settled = reducer.apply({ callId: '7', status: 'completed' })
    expect(settled).toMatchObject({
      callId: '7',
      title: 'Read',
      name: 'read_file',
      kind: 'read',
      rawInput: { path: '/tmp/a' },
      rawOutput: { bytes: 4 },
      locations: [{ path: '/tmp/a' }],
      content: [{ type: 'terminal' }],
      status: 'completed',
    })
  })

  it('does not regress a terminal call when a late progress patch arrives', () => {
    const reducer = new AcpToolCallReducer()
    reducer.apply({ callId: 'x', title: 'Run', status: 'completed' })
    expect(reducer.apply({ callId: 'x', status: 'in_progress' }).status).toBe('completed')
  })

  it('marks only a previously live call cancelled when failure arrives after external Stop', () => {
    const reducer = new AcpToolCallReducer()
    reducer.apply({ callId: 'x', title: 'Run', status: 'pending' })
    reducer.apply({ callId: 'x', status: 'in_progress' })
    expect(
      reducer.apply(
        { callId: 'x', status: 'failed', rawOutput: { error: 'interrupted' } },
        { externalSignalAborted: true },
      ),
    ).toMatchObject({
      status: 'cancelled',
      providerStatus: 'failed',
      rawOutput: { error: 'interrupted' },
    })
  })

  it('keeps unknown-first, pre-Stop failed, and post-Stop completed calls unchanged', () => {
    const unknown = new AcpToolCallReducer()
    expect(unknown.apply({ callId: 'x', status: 'failed' }, { externalSignalAborted: true })).toMatchObject({
      status: 'failed',
    })
    expect(unknown.apply({ callId: 'x', status: 'failed' }).providerStatus).toBeUndefined()

    const failed = new AcpToolCallReducer()
    failed.apply({ callId: 'x', status: 'running' })
    failed.apply({ callId: 'x', status: 'failed' })
    expect(failed.apply({ callId: 'x', status: 'failed' }, { externalSignalAborted: true })).toMatchObject({
      status: 'failed',
    })

    const completed = new AcpToolCallReducer()
    completed.apply({ callId: 'x', status: 'running' })
    expect(completed.apply({ callId: 'x', status: 'completed' }, { externalSignalAborted: true })).toMatchObject({
      status: 'completed',
    })
  })

  it.each(['failed', 'cancelled'] as const)('keeps prior fields when settling as %s', (status) => {
    const reducer = new AcpToolCallReducer()
    reducer.apply({ callId: 'x', name: 'Terminal', content: [{ type: 'terminal' }], status: 'running' })
    reducer.apply({ callId: 'x', status })
    expect(reducer.apply({ callId: 'x', status })).toMatchObject({
      name: 'Terminal',
      content: [{ type: 'terminal' }],
      status,
    })
  })

  it('isolates equal call ids across prompt-scoped instances', () => {
    const first = new AcpToolCallReducer()
    const second = new AcpToolCallReducer()
    first.apply({ callId: 'same', title: 'First prompt', status: 'completed' })
    expect(second.apply({ callId: 'same', status: 'running' })).toEqual({ callId: 'same', status: 'running' })
    expect(first.apply({ callId: 'same', status: 'in_progress' })).toMatchObject({
      title: 'First prompt',
      status: 'completed',
    })
  })
})
