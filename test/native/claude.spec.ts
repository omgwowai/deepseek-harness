import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  ClaudeCliTransport,
  ClaudeFrameMapper,
  buildClaudeArgs,
  claudePermissionRequest,
  claudePermissionResponsePayload,
  claudeStopReason,
  claudeToolResultText,
  claudeUsageDelta,
  claudeUsageTotals,
  claudeUserMessageFrame,
  createClaudeTransport,
} from '../../src/runtime/native/transports/claude.ts'
import type { NativeTransportEvent } from '../../src/runtime/native/transports/contract.ts'

// ---------------------------------------------------------------------------
// Fixtures: trimmed frames captured from claude 2.1.296 (see the module comment
// in claude.ts for the probe transcript location).
// ---------------------------------------------------------------------------

const TOOL_START = {
  type: 'stream_event',
  event: {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: 'toolu_01', name: 'Write', input: {} },
  },
}

function inputDelta(partialJson: string): Record<string, unknown> {
  return {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: partialJson } },
  }
}

const TOOL_STOP = { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }

const ASSISTANT_TOOL_USE = {
  type: 'assistant',
  parent_tool_use_id: null,
  message: {
    id: 'msg_01',
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_01', name: 'Write', input: { file_path: '/tmp/a.txt', content: 'hi' } }],
  },
  wire_tool_inputs: { toolu_01: { file_path: '/tmp/a.txt', content: 'hi' } },
}

const TOOL_RESULT = {
  type: 'user',
  parent_tool_use_id: null,
  message: {
    role: 'user',
    content: [{ tool_use_id: 'toolu_01', type: 'tool_result', content: 'File created successfully at: /tmp/a.txt' }],
  },
}

const MESSAGE_START = {
  type: 'stream_event',
  event: {
    type: 'message_start',
    message: {
      id: 'msg_01',
      usage: { input_tokens: 1, cache_creation_input_tokens: 37_755, cache_read_input_tokens: 0, output_tokens: 2 },
    },
  },
}

const RESULT_SUCCESS = {
  type: 'result',
  subtype: 'success',
  stop_reason: 'end_turn',
  total_cost_usd: 0.259_456_25,
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 37_967,
    cache_read_input_tokens: 37_755,
    output_tokens: 131,
    output_tokens_details: { thinking_tokens: 0 },
  },
  modelUsage: {
    'claude-opus-5.5': {
      inputTokens: 2,
      outputTokens: 131,
      cacheReadInputTokens: 37_755,
      cacheCreationInputTokens: 37_967,
      webSearchRequests: 0,
      costUSD: 0.259_456_25,
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
      thinkingTokens: 0,
    },
  },
}

// ---------------------------------------------------------------------------
// argv construction
// ---------------------------------------------------------------------------

describe('buildClaudeArgs', () => {
  it('adds the protocol flags the transport owns', () => {
    const args = buildClaudeArgs([])
    expect(args).toEqual([
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-prompt-tool',
      'stdio',
    ])
  })

  it('does not duplicate flags the host already passed, including the -p short form', () => {
    const args = buildClaudeArgs(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'])
    expect(args.filter((arg) => arg === '--print')).toHaveLength(0)
    expect(args.filter((arg) => arg === '-p')).toHaveLength(1)
    expect(args.filter((arg) => arg === '--verbose')).toHaveLength(1)
    expect(args.filter((arg) => arg === '--output-format')).toHaveLength(1)
    // Still owns the partial-message and permission routing flags.
    expect(args).toContain('--include-partial-messages')
    expect(args.slice(-2)).toEqual(['--permission-prompt-tool', 'stdio'])
  })

  it('adds --resume=<id> unless the host controls the session itself', () => {
    expect(buildClaudeArgs([], { resumeSessionId: 'sess-1' })).toContain('--resume=sess-1')
    expect(buildClaudeArgs(['--continue'], { resumeSessionId: 'sess-1' })).not.toContain('--resume=sess-1')
    expect(buildClaudeArgs(['--resume', 'sess-2'], { resumeSessionId: 'sess-1' })).not.toContain('--resume=sess-1')
    expect(buildClaudeArgs([], { resumeSessionId: '' })).not.toContain('--resume=')
  })

  it('respects a host-chosen permission prompt target', () => {
    const args = buildClaudeArgs(['--permission-prompt-tool', 'none'])
    expect(args.filter((arg) => arg === '--permission-prompt-tool')).toHaveLength(1)
    expect(args).toContain('none')
  })
})

describe('claudeUserMessageFrame', () => {
  it('wraps text and image blocks in the CLI stream-json envelope', () => {
    const frame = claudeUserMessageFrame({
      blocks: [
        { type: 'text', text: 'hello' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ],
      sessionId: 'sess-1',
      uuid: 'uuid-1',
    })
    expect(frame).toMatchObject({
      type: 'user',
      parent_tool_use_id: null,
      session_id: 'sess-1',
      uuid: 'uuid-1',
    })
    const message = frame.message as { role: string; content: unknown[] }
    expect(message.role).toBe('user')
    expect(message.content).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ])
    // No priority means "start a turn"; only steering sets one.
    expect(frame).not.toHaveProperty('priority')
  })

  it('marks a steered message with priority:"next"', () => {
    const frame = claudeUserMessageFrame({ blocks: [{ type: 'text', text: 'steer' }], priority: 'next' })
    expect(frame.priority).toBe('next')
    expect(typeof frame.uuid).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// result -> contract mapping
// ---------------------------------------------------------------------------

describe('claudeStopReason', () => {
  it('maps a normal result to end_turn', () => {
    expect(claudeStopReason(RESULT_SUCCESS, { interrupted: false })).toBe('end_turn')
  })

  it('maps max_tokens and refusal stop reasons', () => {
    expect(claudeStopReason({ type: 'result', subtype: 'success', stop_reason: 'max_tokens' }, { interrupted: false })).toBe(
      'max_tokens',
    )
    expect(claudeStopReason({ type: 'result', subtype: 'success', stop_reason: 'refusal' }, { interrupted: false })).toBe(
      'refusal',
    )
    expect(claudeStopReason({ type: 'result', subtype: 'error_max_turns' }, { interrupted: false })).toBe('max_tokens')
  })

  it('treats a locally requested interrupt as cancelled regardless of frame', () => {
    expect(claudeStopReason(RESULT_SUCCESS, { interrupted: true })).toBe('cancelled')
    expect(
      claudeStopReason({ type: 'result', subtype: 'error_during_execution', errors: ['aborted'] }, { interrupted: true }),
    ).toBe('cancelled')
  })

  it('detects a vendor-side abort and otherwise reports refusal', () => {
    expect(
      claudeStopReason({ type: 'result', subtype: 'error_during_execution', errors: ['Request aborted'] }, { interrupted: false }),
    ).toBe('cancelled')
    expect(
      claudeStopReason({ type: 'result', subtype: 'error_during_execution', errors: ['Overloaded'] }, { interrupted: false }),
    ).toBe('refusal')
  })
})

describe('usage', () => {
  it('reads cumulative totals from modelUsage, including cost and context window', () => {
    const totals = claudeUsageTotals(RESULT_SUCCESS)
    expect(totals).toMatchObject({
      input: 2,
      output: 131,
      cacheRead: 37_755,
      cacheWrite: 37_967,
      reasoning: 0,
      costUsd: 0.259_456_25,
      contextWindow: 1_000_000,
    })
  })

  it('falls back to result.usage when modelUsage is absent', () => {
    const totals = claudeUsageTotals({
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.5,
      usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 5, cache_creation_input_tokens: 6 },
    })
    expect(totals).toMatchObject({ input: 3, output: 4, cacheRead: 5, cacheWrite: 6, costUsd: 0.5 })
    expect(totals?.contextWindow).toBeUndefined()
  })

  it('reports the turn as the delta between cumulative snapshots', () => {
    const first = claudeUsageTotals(RESULT_SUCCESS)
    expect(first).toBeDefined()
    const turnOne = claudeUsageDelta(first!, undefined)
    expect(turnOne).toMatchObject({ input: 2, output: 131, cacheRead: 37_755, cacheWrite: 37_967 })
    expect(turnOne.total).toBe(2 + 131 + 37_755 + 37_967)
    expect(turnOne.cost?.currency).toBe('USD')
    expect(turnOne.cost?.amount).toBeCloseTo(0.259_456, 6)

    const second = {
      input: first!.input + 1,
      output: first!.output + 10,
      cacheRead: first!.cacheRead + 20,
      cacheWrite: first!.cacheWrite,
      reasoning: 7,
      costUsd: first!.costUsd + 0.01,
      contextWindow: first!.contextWindow,
    }
    const turnTwo = claudeUsageDelta(second, first)
    expect(turnTwo).toMatchObject({ input: 1, output: 10, cacheRead: 20, cacheWrite: 0, reasoning: 7 })
    expect(turnTwo.total).toBe(31)
    expect(turnTwo.cost?.amount).toBeCloseTo(0.01, 6)
  })

  it('never reports negative deltas when usage resets', () => {
    const current = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 }
    const previous = { input: 10, output: 10, cacheRead: 5, cacheWrite: 5, reasoning: 3, costUsd: 1 }
    const delta = claudeUsageDelta(current, previous)
    expect(delta).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
    expect(delta.cost).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// permission round trip
// ---------------------------------------------------------------------------

const CAN_USE_TOOL = {
  subtype: 'can_use_tool',
  tool_name: 'Write',
  display_name: 'Write',
  input: { file_path: '/tmp/a.txt', content: 'hi' },
  description: 'a.txt',
  permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
  tool_use_id: 'toolu_01',
}

describe('permission mapping', () => {
  it('builds ACP-shaped options with always-allow only when the CLI suggests one', () => {
    const request = claudePermissionRequest('req-1', CAN_USE_TOOL)
    expect(request.requestId).toBe('req-1')
    expect(request.title).toBe('Write permission')
    expect(request.detail).toBe('a.txt')
    expect(request.options.map((option) => option.optionId)).toEqual([
      'allow',
      'allow_always',
      'reject',
      'reject_stop',
    ])
    const noSuggestions = claudePermissionRequest('req-2', { ...CAN_USE_TOOL, permission_suggestions: undefined })
    expect(noSuggestions.options.map((option) => option.optionId)).toEqual(['allow', 'reject', 'reject_stop'])
  })

  it('honours suppress_always_allow_rule', () => {
    const request = claudePermissionRequest('req-3', { ...CAN_USE_TOOL, suppress_always_allow_rule: true })
    expect(request.options.map((option) => option.optionId)).not.toContain('allow_always')
  })

  it('answers allow / allow_always / reject / reject_stop / cancel in Claude PermissionResult shape', () => {
    const allow = claudePermissionResponsePayload({ request: CAN_USE_TOOL, decision: { optionId: 'allow' } })
    expect(allow).toMatchObject({ behavior: 'allow', updatedInput: { file_path: '/tmp/a.txt', content: 'hi' }, toolUseID: 'toolu_01' })
    expect(allow).not.toHaveProperty('updatedPermissions')

    const always = claudePermissionResponsePayload({
      request: CAN_USE_TOOL,
      decision: { optionId: 'allow_always' },
      suggestions: CAN_USE_TOOL.permission_suggestions,
    })
    expect(always.updatedPermissions).toEqual(CAN_USE_TOOL.permission_suggestions)

    const reject = claudePermissionResponsePayload({ request: CAN_USE_TOOL, decision: { optionId: 'reject' } })
    expect(reject).toMatchObject({ behavior: 'deny', toolUseID: 'toolu_01' })
    expect(reject).not.toHaveProperty('interrupt')

    const stop = claudePermissionResponsePayload({ request: CAN_USE_TOOL, decision: { optionId: 'reject_stop' } })
    expect(stop).toMatchObject({ behavior: 'deny', interrupt: true })

    const cancelled = claudePermissionResponsePayload({ request: CAN_USE_TOOL, decision: { cancelled: true } })
    expect(cancelled).toMatchObject({ behavior: 'deny', interrupt: true })
  })
})

describe('claudeToolResultText', () => {
  it('flattens string and block content', () => {
    expect(claudeToolResultText('ok')).toBe('ok')
    expect(claudeToolResultText([{ type: 'text', text: 'line 1' }, { type: 'text', text: 'line 2' }])).toBe(
      'line 1\nline 2',
    )
    expect(claudeToolResultText(undefined)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// frame mapper
// ---------------------------------------------------------------------------

describe('ClaudeFrameMapper', () => {
  it('emits one tool_call with the completed rawInput at content_block_stop', () => {
    const mapper = new ClaudeFrameMapper()
    mapper.resetTurn()
    const events: NativeTransportEvent[] = []
    events.push(...mapper.map(TOOL_START))
    events.push(...mapper.map(inputDelta('{"file_path": "/tmp/a.txt", ')))
    events.push(...mapper.map(inputDelta('"content": "hi"}')))
    events.push(...mapper.map(TOOL_STOP))
    const toolCalls = events.filter((event) => event.kind === 'tool_call')
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]).toMatchObject({
      kind: 'tool_call',
      toolCallId: 'toolu_01',
      title: 'Write',
      status: 'in_progress',
      rawInput: { file_path: '/tmp/a.txt', content: 'hi' },
    })
  })

  it('does not repeat the tool_call from the completed assistant frame', () => {
    const mapper = new ClaudeFrameMapper()
    mapper.resetTurn()
    mapper.map(TOOL_START)
    mapper.map(inputDelta('{"file_path": "/tmp/a.txt", "content": "hi"}'))
    mapper.map(TOOL_STOP)
    expect(mapper.map(ASSISTANT_TOOL_USE).filter((event) => event.kind === 'tool_call')).toHaveLength(0)
  })

  it('falls back to the assistant frame when partial events are unavailable', () => {
    const mapper = new ClaudeFrameMapper()
    mapper.resetTurn()
    const events = mapper.map(ASSISTANT_TOOL_USE)
    expect(events).toEqual([
      {
        kind: 'tool_call',
        toolCallId: 'toolu_01',
        title: 'Write',
        status: 'in_progress',
        rawInput: { file_path: '/tmp/a.txt', content: 'hi' },
      },
    ])
  })

  it('maps a tool_result into a completed tool_call_update with its text', () => {
    const mapper = new ClaudeFrameMapper()
    mapper.resetTurn()
    const events = mapper.map(TOOL_RESULT)
    expect(events).toEqual([
      {
        kind: 'tool_call_update',
        toolCallId: 'toolu_01',
        status: 'completed',
        contentText: 'File created successfully at: /tmp/a.txt',
      },
    ])
  })

  it('marks a failed tool_result as failed, or cancelled after an interrupt', () => {
    const failedResult = {
      type: 'user',
      message: { role: 'user', content: [{ tool_use_id: 'toolu_01', type: 'tool_result', content: 'boom', is_error: true }] },
    }
    const mapper = new ClaudeFrameMapper()
    mapper.resetTurn()
    expect(mapper.map(failedResult)[0]).toMatchObject({ status: 'failed' })

    const interrupted = new ClaudeFrameMapper()
    interrupted.resetTurn()
    interrupted.noteInterrupted(true)
    expect(interrupted.map(failedResult)[0]).toMatchObject({ status: 'cancelled' })
  })

  it('streams text deltas once and suppresses the duplicated assistant block', () => {
    const mapper = new ClaudeFrameMapper()
    mapper.resetTurn()
    mapper.map(MESSAGE_START)
    const delta = {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'DONE' } },
    }
    expect(mapper.map(delta)).toEqual([{ kind: 'text', text: 'DONE' }])
    const assistant = {
      type: 'assistant',
      message: { id: 'msg_01', content: [{ type: 'text', text: 'DONE' }] },
    }
    expect(mapper.map(assistant)).toEqual([])
  })

  it('maps thinking deltas to thought events', () => {
    const mapper = new ClaudeFrameMapper()
    mapper.resetTurn()
    mapper.map(MESSAGE_START)
    const delta = {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
    }
    expect(mapper.map(delta)).toEqual([{ kind: 'thought', text: 'hmm' }])
  })

  it('reports context occupancy once the context window size is known', () => {
    const mapper = new ClaudeFrameMapper()
    mapper.resetTurn()
    expect(mapper.map(MESSAGE_START)).toEqual([])
    mapper.noteContextWindow(1_000_000)
    expect(mapper.map(MESSAGE_START)).toEqual([
      { kind: 'context_usage', contextUsage: { used: 37_756, size: 1_000_000 } },
    ])
    expect(mapper.lastContextUsed).toBe(37_756)
  })

  it('settles still-open tool calls at turn end', () => {
    const mapper = new ClaudeFrameMapper()
    mapper.resetTurn()
    mapper.map(TOOL_START)
    mapper.map(inputDelta('{}'))
    mapper.map(TOOL_STOP)
    expect(mapper.settle()).toEqual([{ kind: 'tool_call_update', toolCallId: 'toolu_01', status: 'failed' }])

    const interrupted = new ClaudeFrameMapper()
    interrupted.resetTurn()
    interrupted.map(TOOL_START)
    interrupted.map(inputDelta('{}'))
    interrupted.map(TOOL_STOP)
    interrupted.noteInterrupted(true)
    expect(interrupted.settle()).toEqual([{ kind: 'tool_call_update', toolCallId: 'toolu_01', status: 'cancelled' }])
  })
})

describe('createClaudeTransport', () => {
  it('returns a claude-kind transport that does not leak a session before start', () => {
    const transport = createClaudeTransport()
    expect(transport).toBeInstanceOf(ClaudeCliTransport)
    expect(transport.kind).toBe('claude')
    expect(transport.sessionId).toBeUndefined()
    expect(transport.contextUsage()).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Real CLI integration (one short prompt + one steer)
// ---------------------------------------------------------------------------

const CLAUDE_BIN = process.env['CLAUDE_BIN'] ?? 'claude'
const INTEGRATION_ENABLED = process.env['DSH_CLAUDE_NATIVE_IT'] !== '0'

function claudeAvailable(): boolean {
  if (!INTEGRATION_ENABLED) return false
  try {
    execFileSync(CLAUDE_BIN, ['--version'], { stdio: 'ignore', timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

describe.skipIf(!claudeAvailable())('real claude CLI', () => {
  it(
    'runs a turn, steers mid tool call, and reports usage/cost',
    { timeout: 240_000 },
    async () => {
      const cwd = mkdtempSync(path.join(tmpdir(), 'dsh-claude-native-'))
      const events: NativeTransportEvent[] = []
      const transport = createClaudeTransport()
      let resolveToolCall!: () => void
      const toolCallSeen = new Promise<void>((resolve) => {
        resolveToolCall = resolve
      })
      try {
        await transport.start({
          command: CLAUDE_BIN,
          args: [],
          env: { ...process.env } as Record<string, string>,
          cwd,
          onEvent: (event) => {
            events.push(event)
            if (event.kind === 'tool_call' && event.status === 'in_progress') resolveToolCall()
          },
          onPermission: async () => ({ optionId: 'allow' }),
        })

        const promptResult = transport.prompt(
          [
            {
              type: 'text',
              text: 'Use the Bash tool to run exactly: sleep 4 in the foreground. After it finishes, reply exactly: FIRST_DONE',
            },
          ],
          new AbortController().signal,
        )

        await toolCallSeen
        const steerResult = await transport.steer([
          { type: 'text', text: 'Also include the exact word STEERED in your final reply.' },
        ])
        expect(steerResult).toBe('injected')

        const result = await promptResult
        const text = events
          .filter((event): event is Extract<NativeTransportEvent, { kind: 'text' }> => event.kind === 'text')
          .map((event) => event.text)
          .join('')

        expect(result.stopReason).toBe('end_turn')
        expect(text).toContain('STEERED')
        expect(events.some((event) => event.kind === 'status' && event.busy)).toBe(true)
        expect(events.some((event) => event.kind === 'status' && !event.busy)).toBe(true)
        expect(events.some((event) => event.kind === 'tool_call' && event.title.toLowerCase().includes('bash'))).toBe(true)
        expect(events.some((event) => event.kind === 'tool_call_update' && event.status === 'completed')).toBe(true)
        expect(events.some((event) => event.kind === 'usage')).toBe(true)
        expect(events.some((event) => event.kind === 'context_usage')).toBe(true)

        expect(result.usage).toBeDefined()
        expect(result.usage?.total).toBeGreaterThan(0)
        expect(result.usage?.cost?.currency).toBe('USD')
        expect(result.usage?.cost?.amount).toBeGreaterThan(0)

        expect(typeof transport.sessionId).toBe('string')
        const context = transport.contextUsage()
        expect(context?.size).toBeGreaterThan(0)
        expect(context?.used).toBeGreaterThan(0)
      } finally {
        await transport.close()
        // Idempotent by contract.
        await transport.close()
        rmSync(cwd, { recursive: true, force: true })
      }
    },
  )
})

// ---------------------------------------------------------------------------
// Scripted CLI double: exercises the control channel (steer / interrupt receipt
// / cancel_async_message) deterministically, with no model calls.
// ---------------------------------------------------------------------------

const FAKE_CLI_SOURCE = `
const fs = require('node:fs')
const readline = require('node:readline')
const logPath = process.env.DSH_FAKE_CLI_LOG
const mode = process.env.DSH_FAKE_MODE || 'echo'
const log = (frame) => { if (logPath) fs.appendFileSync(logPath, JSON.stringify(frame) + '\\n') }
const out = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n')
let turn = 0
let steeredUuid = null
let initSent = false
const sendInit = () => {
  if (initSent) return
  initSent = true
  out({ type: 'system', subtype: 'init', session_id: 'fake-session', capabilities: [], model: 'fake-model', permissionMode: 'default' })
}
const usageFrame = (input, output, cost) => ({
  type: 'result', subtype: 'success', stop_reason: 'end_turn', session_id: 'fake-session',
  total_cost_usd: cost,
  usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  modelUsage: { 'fake-model': { inputTokens: input, outputTokens: output, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: cost, contextWindow: 1000, thinkingTokens: 0 } },
})
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let frame
  try { frame = JSON.parse(line) } catch { return }
  log(frame)
  if (frame.type === 'user') {
    if (frame.priority === 'next') {
      steeredUuid = frame.uuid
      return // folded into the running turn; no separate result
    }
    turn += 1
    sendInit()
    out({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_' + turn, usage: { input_tokens: 10 * turn, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } } } })
    out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'reply' + turn } } })
    out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
    if (mode === 'hold') {
      out({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_' + turn, name: 'Bash', input: {} } } })
      out({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"sleep 8"}' } } })
      out({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } })
      return // hold the turn open until interrupt
    }
    out(usageFrame(10 * turn, turn, 0.5 * turn))
    return
  }
  if (frame.type === 'control_request') {
    const subtype = frame.request && frame.request.subtype
    if (subtype === 'interrupt') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { still_queued: steeredUuid ? [steeredUuid] : [], cancelled: [] } } })
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Interrupted by user'], session_id: 'fake-session', total_cost_usd: 0.1, modelUsage: { 'fake-model': { inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.1, contextWindow: 1000, thinkingTokens: 0 } } })
      return
    }
    if (subtype === 'cancel_async_message') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { cancelled: true } } })
      return
    }
    out({ type: 'control_response', response: { subtype: 'error', request_id: frame.request_id, error: 'unsupported' } })
  }
})
`

interface FakeCliHarness {
  readonly transport: ClaudeCliTransport
  readonly frames: () => Record<string, unknown>[]
  readonly events: NativeTransportEvent[]
  readonly close: () => Promise<void>
}

function startFakeCli(mode: 'echo' | 'hold' = 'echo'): FakeCliHarness {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-fake-claude-'))
  const scriptPath = path.join(dir, 'fake-claude.cjs')
  const logPath = path.join(dir, 'frames.jsonl')
  writeFileSync(scriptPath, FAKE_CLI_SOURCE, 'utf8')
  writeFileSync(logPath, '', 'utf8')
  const transport = new ClaudeCliTransport()
  const events: NativeTransportEvent[] = []
  const started = transport.start({
    command: process.execPath,
    args: [scriptPath],
    env: { ...process.env, DSH_FAKE_CLI_LOG: logPath, DSH_FAKE_MODE: mode } as Record<string, string>,
    cwd: dir,
    onEvent: (event) => events.push(event),
    onPermission: async () => ({ optionId: 'allow' }),
  })
  return {
    transport,
    events,
    frames: () => {
      const raw = readFileSync(logPath, 'utf8').trim()
      if (raw === '') return []
      return raw.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    },
    close: async () => {
      await started.catch(() => undefined)
      await transport.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function waitForCondition(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('condition was not met in time')
}

describe('control channel (scripted CLI double)', () => {
  it('streams a turn and reports per-turn usage deltas from cumulative modelUsage', async () => {
    const fake = startFakeCli('echo')
    try {
      const events = fake.events
      const first = await fake.transport.prompt([{ type: 'text', text: 'one' }], new AbortController().signal)
      const second = await fake.transport.prompt([{ type: 'text', text: 'two' }], new AbortController().signal)

      expect(first.stopReason).toBe('end_turn')
      expect(first.usage).toMatchObject({ input: 10, output: 1 })
      expect(first.usage?.cost?.currency).toBe('USD')
      expect(first.usage?.cost?.amount).toBeCloseTo(0.5, 6)

      // Second turn is the delta of cumulative totals: 20-10 input, 2-1 output.
      expect(second.usage).toMatchObject({ input: 10, output: 1 })
      expect(second.usage?.cost?.amount).toBeCloseTo(0.5, 6)

      const usageEvents = events.filter((event) => event.kind === 'usage')
      expect(usageEvents).toHaveLength(2)
      expect(events.some((event) => event.kind === 'context_usage' && event.contextUsage.size === 1000)).toBe(true)
      expect(fake.transport.sessionId).toBe('fake-session')
      expect(fake.transport.contextUsage()).toEqual({ used: 20, size: 1000 })
    } finally {
      await fake.close()
    }
  })

  it('injects a steer as a priority:"next" message and returns injected', async () => {
    const fake = startFakeCli('hold')
    try {
      const promptPromise = fake.transport.prompt([{ type: 'text', text: 'run it' }], new AbortController().signal)
      await waitForCondition(() => fake.events.some((event) => event.kind === 'tool_call'))

      expect(await fake.transport.steer([{ type: 'text', text: 'also say STEERED' }])).toBe('injected')
      await waitForCondition(() =>
        fake.frames().some((frame) => frame['type'] === 'user' && frame['priority'] === 'next'),
      )
      const steerFrame = fake.frames().find((frame) => frame['type'] === 'user' && frame['priority'] === 'next')
      expect(steerFrame?.['uuid']).toEqual(expect.any(String))

      await fake.transport.interrupt()
      const result = await promptPromise
      expect(result.stopReason).toBe('cancelled')
      // Nothing is left open after the interrupted turn settles.
      expect(
        fake.events.some(
          (event) => event.kind === 'tool_call_update' && (event.status === 'cancelled' || event.status === 'failed'),
        ),
      ).toBe(true)
    } finally {
      await fake.close()
    }
  })

  it('withdraws a queued steer listed by the interrupt receipt', { timeout: 15_000 }, async () => {
    const fake = startFakeCli('hold')
    try {
      const promptPromise = fake.transport.prompt([{ type: 'text', text: 'run it' }], new AbortController().signal)
      await waitForCondition(() => fake.events.some((event) => event.kind === 'tool_call'))
      await fake.transport.steer([{ type: 'text', text: 'queued steer' }])
      // The double must have consumed the steer before interrupt(), otherwise the
      // receipt legitimately lists nothing.
      await waitForCondition(() =>
        fake.frames().some((frame) => frame['type'] === 'user' && frame['priority'] === 'next'),
      )
      const steerUuid = fake
        .frames()
        .find((frame) => frame['type'] === 'user' && frame['priority'] === 'next')?.['uuid']
      expect(steerUuid).toEqual(expect.any(String))
      await fake.transport.interrupt()
      await promptPromise

      // The receipt listed our message as still queued: the transport must send
      // cancel_async_message for exactly that uuid.
      await waitForCondition(() =>
        fake.frames().some((frame) => {
          if (frame['type'] !== 'control_request') return false
          const request = frame['request'] as Record<string, unknown> | undefined
          return request?.['subtype'] === 'cancel_async_message' && request?.['message_uuid'] === steerUuid
        }),
      )
    } finally {
      await fake.close()
    }
  })

  it('returns promptRequired when no turn is running', async () => {
    const fake = startFakeCli('echo')
    try {
      expect(await fake.transport.steer([{ type: 'text', text: 'nobody home' }])).toBe('promptRequired')
    } finally {
      await fake.close()
    }
  })

  it('rejects concurrent prompts and refuses empty content', async () => {
    const fake = startFakeCli('hold')
    try {
      const promptPromise = fake.transport.prompt([{ type: 'text', text: 'hold' }], new AbortController().signal)
      await waitForCondition(() => fake.events.some((event) => event.kind === 'tool_call'))
      await expect(fake.transport.prompt([{ type: 'text', text: 'again' }], new AbortController().signal)).rejects.toMatchObject(
        { code: 'busy' },
      )
      await fake.transport.interrupt()
      await promptPromise
      await expect(fake.transport.prompt([], new AbortController().signal)).rejects.toMatchObject({
        code: 'empty_prompt',
      })
    } finally {
      await fake.close()
    }
  })

  it('close() is idempotent and settles a running prompt', async () => {
    const fake = startFakeCli('hold')
    // Attach the rejection handler immediately: close() rejects the in-flight
    // prompt, and an unobserved rejection would be reported as a suite error.
    const outcome = fake.transport
      .prompt([{ type: 'text', text: 'hold' }], new AbortController().signal)
      .then(
        () => ({ resolved: true as const }),
        (error: unknown) => ({ resolved: false as const, error }),
      )
    await waitForCondition(() => fake.events.some((event) => event.kind === 'tool_call'))
    await fake.transport.close()
    await fake.transport.close()
    const settled = await outcome
    expect(settled.resolved).toBe(false)
    expect(settled).toMatchObject({ error: { code: 'closed' } })
    await fake.close()
  })
})
