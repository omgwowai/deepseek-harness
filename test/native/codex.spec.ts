/**
 * Tests for the Codex native transport (`codex app-server`, JSON-RPC 2.0 JSONL).
 *
 * Three layers:
 *  1. Pure mapping tests against real 0.162.1 schema frames (notifications,
 *     usage, stop reasons, reverse-request answers).
 *  2. A deterministic fake `codex app-server` subprocess that exercises the
 *     whole wire protocol (handshake, thread/start + resume, turn/start,
 *     turn/steer, turn/interrupt, reverse approvals, process shutdown) without
 *     spending model quota.
 *  3. Optional live checks against the real `codex app-server` binary
 *     (handshake/thread/start always; one real turn only when
 *     `DSH_CODEX_REAL_TURN=1`).
 */
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type {
  NativePermissionDecision,
  NativePermissionRequest,
  NativeTransport,
  NativeTransportEvent,
  NativeTransportStartOptions,
} from '../../src/runtime/native/transports/contract.ts'
import {
  answerCodexServerRequest,
  buildCodexPermissionRequest,
  codexNotificationEvents,
  codexServerRequestNeedsPermission,
  codexStopReason,
  codexUsageFromParams,
  CodexRpcError,
  createCodexTransport,
  isDefinitiveSteerRejection,
} from '../../src/runtime/native/transports/codex.ts'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const tempDirs: string[] = []
const liveTransports: NativeTransport[] = []

afterEach(async () => {
  for (const transport of liveTransports.splice(0)) await transport.close().catch(() => undefined)
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

const CHILD_ENV: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
)

interface Harness {
  readonly transport: NativeTransport
  readonly events: NativeTransportEvent[]
  readonly permissions: NativePermissionRequest[]
  readonly logs: string[]
  readonly startOptions: NativeTransportStartOptions
  /** Frames the fake server received, in order (only for fake launches). */
  readFrames(): Promise<Array<Record<string, unknown>>>
}

async function launch(
  options: Omit<NativeTransportStartOptions, 'onEvent' | 'onPermission' | 'log'> & {
    readonly onPermission?: (request: NativePermissionRequest) => Promise<NativePermissionDecision>
    readonly frameLog?: string
  },
): Promise<Harness> {
  const events: NativeTransportEvent[] = []
  const permissions: NativePermissionRequest[] = []
  const logs: string[] = []
  const transport = createCodexTransport()
  liveTransports.push(transport)
  const startOptions: NativeTransportStartOptions = {
    command: options.command,
    args: options.args,
    env: options.env,
    cwd: options.cwd,
    ...(options.resumeSessionId === undefined ? {} : { resumeSessionId: options.resumeSessionId }),
    onEvent: (event) => events.push(event),
    onPermission: async (request) => {
      permissions.push(request)
      return options.onPermission === undefined
        ? { optionId: 'accept' }
        : await options.onPermission(request)
    },
    log: (message) => logs.push(message),
  }
  await transport.start(startOptions)
  return {
    transport,
    events,
    permissions,
    logs,
    startOptions,
    async readFrames(): Promise<Array<Record<string, unknown>>> {
      if (options.frameLog === undefined) return []
      const text = await readFile(options.frameLog, 'utf8')
      return text
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    },
  }
}

async function writeFakeServer(): Promise<{ readonly dir: string; readonly script: string; readonly frameLog: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-codex-fake-'))
  tempDirs.push(dir)
  const script = join(dir, 'fake-codex-app-server.mjs')
  const frameLog = join(dir, 'frames.jsonl')
  await writeFile(script, FAKE_CODEX_APP_SERVER, 'utf8')
  return { dir, script, frameLog }
}

interface FakeHarness extends Harness {
  readonly frameLog: string
}

async function launchFake(
  env: Readonly<Record<string, string>> = {},
  resumeSessionId?: string,
): Promise<FakeHarness> {
  const { dir, script, frameLog } = await writeFakeServer()
  const harness = await launch({
    command: process.execPath,
    args: [script],
    env: { ...CHILD_ENV, FAKE_CODEX_LOG: frameLog, ...env },
    cwd: dir,
    frameLog,
    ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
  })
  return { ...harness, frameLog }
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for condition')
}

function framesByMethod(frames: readonly Record<string, unknown>[], method: string): Array<Record<string, unknown>> {
  return frames.filter((frame) => frame.method === method)
}

function idOf(frame: Record<string, unknown>): number | undefined {
  return typeof frame.id === 'number' ? frame.id : undefined
}

// ---------------------------------------------------------------------------
// Deterministic fake `codex app-server` (newline-delimited JSON-RPC 2.0).
// Behaviours are selected with env vars so one script covers every flow.
// ---------------------------------------------------------------------------

const FAKE_CODEX_APP_SERVER = `import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const logPath = process.env.FAKE_CODEX_LOG
const mode = process.env.FAKE_CODEX_MODE || 'complete'
const loaded = process.env.FAKE_LOADED === '1'
const archived = process.env.FAKE_ARCHIVED === '1'
const steerRejectFirst = process.env.FAKE_STEER_REJECT_FIRST === '1'

let unarchived = false
let steerAttempts = 0
let nextServerRequestId = 9001
const replyWaiters = new Map()

function append(frame) {
  if (logPath) appendFileSync(logPath, JSON.stringify(frame) + '\\n')
}
function send(frame) {
  process.stdout.write(JSON.stringify(frame) + '\\n')
}
function respond(id, result) {
  send({ id: id, result: result })
}
function respondError(id, code, message) {
  send({ id: id, error: { code: code, message: message } })
}
function notify(method, params) {
  send({ method: method, params: params })
}
function requestClient(method, params) {
  const id = nextServerRequestId
  nextServerRequestId += 1
  const promise = new Promise(function (resolve) {
    replyWaiters.set(id, resolve)
  })
  send({ id: id, method: method, params: params })
  return promise
}
function threadResponse(threadId) {
  return {
    thread: { id: threadId },
    model: 'fake-model',
    modelProvider: 'fake-provider',
    cwd: process.cwd(),
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: 'danger-full-access',
  }
}
function sendTurnStarted() {
  notify('turn/started', {
    threadId: 'thr_test',
    turn: { id: 'turn_test', status: 'inProgress', items: [] },
  })
}
function sendRunningTool() {
  notify('item/started', {
    threadId: 'thr_test',
    turnId: 'turn_test',
    startedAtMs: 1,
    item: {
      type: 'commandExecution',
      id: 'item_cmd',
      command: 'sleep 1',
      cwd: process.cwd(),
      commandActions: [],
      status: 'inProgress',
    },
  })
}
async function runCompleteTurn() {
  const threadId = 'thr_test'
  const turnId = 'turn_test'
  sendTurnStarted()
  notify('item/started', {
    threadId: threadId,
    turnId: turnId,
    startedAtMs: 1,
    item: {
      type: 'commandExecution',
      id: 'item_cmd',
      command: 'echo hello',
      cwd: process.cwd(),
      commandActions: [],
      status: 'inProgress',
    },
  })
  const approval = await requestClient('item/commandExecution/requestApproval', {
    itemId: 'item_cmd',
    threadId: threadId,
    turnId: turnId,
    command: 'echo hello',
    cwd: process.cwd(),
    reason: 'fake approval',
  })
  let decision = 'no-answer'
  if (approval && approval.result && typeof approval.result.decision === 'string') {
    decision = approval.result.decision
  }
  notify('item/completed', {
    threadId: threadId,
    turnId: turnId,
    completedAtMs: 2,
    item: {
      type: 'commandExecution',
      id: 'item_cmd',
      command: 'echo hello',
      cwd: process.cwd(),
      commandActions: [],
      status: 'completed',
      aggregatedOutput: 'hello\\n',
      exitCode: 0,
    },
  })
  notify('item/started', {
    threadId: threadId,
    turnId: turnId,
    startedAtMs: 3,
    item: { type: 'agentMessage', id: 'item_msg', text: '' },
  })
  notify('item/agentMessage/delta', {
    threadId: threadId,
    turnId: turnId,
    itemId: 'item_msg',
    delta: 'Hello',
  })
  const attestation = await requestClient('attestation/generate', {})
  let attestationLabel = 'no-answer'
  if (attestation && attestation.error) attestationLabel = 'error' + String(attestation.error.code)
  else if (attestation && attestation.result) attestationLabel = 'ok'
  notify('item/agentMessage/delta', {
    threadId: threadId,
    turnId: turnId,
    itemId: 'item_msg',
    delta: ' approval=' + String(decision) + ' attestation=' + attestationLabel,
  })
  notify('thread/tokenUsage/updated', {
    threadId: threadId,
    turnId: turnId,
    tokenUsage: {
      last: {
        inputTokens: 123,
        cachedInputTokens: 7,
        cacheWriteInputTokens: 2,
        outputTokens: 45,
        reasoningOutputTokens: 9,
        totalTokens: 456,
      },
      total: {
        inputTokens: 123,
        cachedInputTokens: 7,
        cacheWriteInputTokens: 2,
        outputTokens: 45,
        reasoningOutputTokens: 9,
        totalTokens: 456,
      },
      modelContextWindow: 200000,
    },
  })
  notify('item/completed', {
    threadId: threadId,
    turnId: turnId,
    completedAtMs: 4,
    item: {
      type: 'agentMessage',
      id: 'item_msg',
      text: 'Hello approval=' + String(decision) + ' attestation=' + attestationLabel,
    },
  })
  notify('turn/completed', {
    threadId: threadId,
    turn: { id: turnId, status: 'completed', items: [], error: null },
  })
}

const rl = createInterface({ input: process.stdin })
rl.on('line', function (line) {
  let frame
  try {
    frame = JSON.parse(line)
  } catch {
    return
  }
  append(frame)
  if (frame.id !== undefined && frame.method === undefined) {
    const waiter = replyWaiters.get(frame.id)
    if (waiter) {
      replyWaiters.delete(frame.id)
      waiter(frame)
    }
    return
  }
  const id = frame.id
  const method = frame.method
  const params = frame.params || {}
  switch (method) {
    case 'initialize':
      respond(id, {
        userAgent: 'fake-codex/0.0.0',
        codexHome: '/tmp/fake-codex-home',
        platformFamily: 'unix',
        platformOs: 'macos',
      })
      break
    case 'thread/start':
      respond(id, threadResponse('thr_test'))
      break
    case 'thread/loaded/list':
      respond(id, { data: loaded ? ['thr_test'] : [], nextCursor: null })
      break
    case 'thread/resume':
      if (archived && params.threadId === 'thr_archived' && !unarchived) {
        respondError(id, -32600, 'thread is archived')
        break
      }
      respond(id, threadResponse(params.threadId))
      break
    case 'thread/unarchive':
      unarchived = true
      respond(id, {})
      break
    case 'turn/start':
      respond(id, { turn: { id: 'turn_test', status: 'inProgress', items: [] } })
      if (mode === 'hang') {
        sendTurnStarted()
        sendRunningTool()
      } else {
        void runCompleteTurn()
      }
      break
    case 'turn/steer':
      steerAttempts += 1
      if (steerRejectFirst && steerAttempts === 1) {
        respondError(id, -32600, 'expected active turn id \`turn_test\` but found \`turn_stale\`')
        break
      }
      respond(id, { turnId: params.expectedTurnId })
      notify('item/agentMessage/delta', {
        threadId: 'thr_test',
        turnId: params.expectedTurnId,
        itemId: 'item_steer',
        delta: 'steered',
      })
      break
    case 'turn/interrupt':
      respond(id, {})
      notify('turn/completed', {
        threadId: 'thr_test',
        turn: { id: params.turnId, status: 'interrupted', items: [], error: null },
      })
      break
    default:
      if (typeof id === 'number') respond(id, {})
      break
  }
})
`

// ---------------------------------------------------------------------------
// 1. Pure mapping (real schema frames)
// ---------------------------------------------------------------------------

describe('codex notification mapping', () => {
  it('maps assistant and reasoning deltas', () => {
    expect(codexNotificationEvents('item/agentMessage/delta', { delta: 'hello', itemId: 'i1' })).toEqual(
      [{ kind: 'text', text: 'hello' }],
    )
    expect(
      codexNotificationEvents('item/reasoning/summaryTextDelta', { delta: 'thinking', itemId: 'i2' }),
    ).toEqual([{ kind: 'thought', text: 'thinking' }])
    expect(codexNotificationEvents('item/reasoning/textDelta', { delta: 'more', itemId: 'i2' })).toEqual([
      { kind: 'thought', text: 'more' },
    ])
    expect(codexNotificationEvents('item/agentMessage/delta', {})).toEqual([])
  })

  it('maps item/started and item/completed tool items', () => {
    const started = codexNotificationEvents('item/started', {
      item: {
        type: 'commandExecution',
        id: 'item_cmd',
        command: 'echo hi',
        cwd: '/tmp',
        commandActions: [],
        status: 'inProgress',
      },
    })
    expect(started).toEqual([
      {
        kind: 'tool_call',
        toolCallId: 'item_cmd',
        title: 'Run echo hi',
        status: 'in_progress',
        rawInput: { command: 'echo hi', cwd: '/tmp' },
      },
    ])
    const completed = codexNotificationEvents('item/completed', {
      item: {
        type: 'commandExecution',
        id: 'item_cmd',
        command: 'echo hi',
        cwd: '/tmp',
        commandActions: [],
        status: 'completed',
        aggregatedOutput: 'hi\n',
        exitCode: 0,
      },
    })
    expect(completed).toEqual([
      { kind: 'tool_call_update', toolCallId: 'item_cmd', status: 'completed', contentText: 'hi\n' },
    ])
  })

  it('maps statuses and file-change items', () => {
    const failed = codexNotificationEvents('item/completed', {
      item: {
        type: 'fileChange',
        id: 'item_patch',
        status: 'declined',
        changes: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
      },
    })
    expect(failed).toEqual([
      {
        kind: 'tool_call_update',
        toolCallId: 'item_patch',
        status: 'cancelled',
        contentText: 'src/a.ts\nsrc/b.ts',
      },
    ])
    const mcp = codexNotificationEvents('item/completed', {
      item: {
        type: 'mcpToolCall',
        id: 'item_mcp',
        server: 'docs',
        tool: 'search',
        status: 'completed',
        result: { content: [{ type: 'text', text: 'found it' }] },
      },
    })
    expect(mcp).toEqual([
      { kind: 'tool_call_update', toolCallId: 'item_mcp', status: 'completed', contentText: 'found it' },
    ])
  })

  it('leaves agentMessage/reasoning items to the transport delta logic', () => {
    expect(
      codexNotificationEvents('item/completed', {
        item: { type: 'agentMessage', id: 'item_msg', text: 'full text' },
      }),
    ).toEqual([])
    expect(
      codexNotificationEvents('item/completed', {
        item: { type: 'reasoning', id: 'item_reason', summary: ['why'], content: [] },
      }),
    ).toEqual([])
  })

  it('maps thread/tokenUsage/updated into usage + context_usage', () => {
    const params = {
      threadId: 'thr',
      turnId: 'turn',
      tokenUsage: {
        last: {
          inputTokens: 123,
          cachedInputTokens: 7,
          cacheWriteInputTokens: 2,
          outputTokens: 45,
          reasoningOutputTokens: 9,
          totalTokens: 456,
        },
        total: { inputTokens: 1, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 4, totalTokens: 5 },
        modelContextWindow: 200000,
      },
    }
    expect(codexUsageFromParams(params)).toEqual({
      usage: { input: 123, output: 45, cacheRead: 7, cacheWrite: 2, total: 456, reasoning: 9 },
      contextUsage: { used: 456, size: 200000 },
    })
    expect(codexNotificationEvents('thread/tokenUsage/updated', params)).toEqual([
      { kind: 'usage', usage: { input: 123, output: 45, cacheRead: 7, cacheWrite: 2, total: 456, reasoning: 9 } },
      { kind: 'context_usage', contextUsage: { used: 456, size: 200000 } },
    ])
    const noWindow = codexUsageFromParams({
      tokenUsage: {
        last: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0, totalTokens: 3 },
      },
    })
    expect(noWindow?.contextUsage).toEqual({ used: 3, size: 0 })
  })

  it('maps diagnostics and plan updates to notices', () => {
    expect(codexNotificationEvents('error', { error: { message: 'boom' }, willRetry: true })).toEqual([
      { kind: 'notice', text: 'Codex error (will retry): boom' },
    ])
    expect(codexNotificationEvents('warning', { message: 'careful' })).toEqual([
      { kind: 'notice', text: 'Codex warning: careful' },
    ])
    expect(codexNotificationEvents('thread/compacted', { threadId: 'thr' })).toEqual([
      { kind: 'notice', text: 'Codex compacted the conversation context.' },
    ])
    const plan = codexNotificationEvents('turn/plan/updated', {
      plan: [
        { step: 'Read files', status: 'inProgress' },
        { step: 'Edit files', status: 'pending' },
      ],
    })
    expect(plan).toHaveLength(1)
    const notice = plan[0]
    expect(notice?.kind).toBe('notice')
    if (notice?.kind === 'notice') {
      expect(notice.text).toContain('Read files [inProgress]')
      expect(notice.text).toContain('Edit files [pending]')
    }
  })

  it('maps turn status to the contract stop reason', () => {
    expect(codexStopReason('completed')).toBe('end_turn')
    expect(codexStopReason('interrupted')).toBe('cancelled')
    expect(codexStopReason('failed')).toBe('refusal')
    expect(codexStopReason(undefined)).toBe('end_turn')
  })
})

// ---------------------------------------------------------------------------
// 2. Steer error classification
// ---------------------------------------------------------------------------

describe('codex steer rejection classification', () => {
  it('treats only definitive rejections as fallbacks', () => {
    expect(isDefinitiveSteerRejection(new CodexRpcError('method not found', -32601))).toBe(true)
    expect(isDefinitiveSteerRejection(new CodexRpcError('no active turn to steer', -32600))).toBe(true)
    expect(
      isDefinitiveSteerRejection(
        new CodexRpcError('expected active turn id `turn_a` but found `turn_b`', -32600),
      ),
    ).toBe(true)
    expect(
      isDefinitiveSteerRejection(
        new CodexRpcError('invalid request', -32600, { codexErrorInfo: { activeTurnNotSteerable: {} } }),
      ),
    ).toBe(true)
    expect(isDefinitiveSteerRejection(new CodexRpcError('active turn uses a different output schema', -32600))).toBe(
      true,
    )
    // Ambiguous errors must be rethrown, never downgraded.
    expect(isDefinitiveSteerRejection(new CodexRpcError('invalid request', -32600))).toBe(false)
    expect(isDefinitiveSteerRejection(new CodexRpcError('internal error', -32000))).toBe(false)
    expect(isDefinitiveSteerRejection(new Error('request timed out'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. Reverse requests: every method must be answered
// ---------------------------------------------------------------------------

const SERVER_REQUEST_METHODS = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
  'item/permissions/requestApproval',
  'item/tool/call',
  'account/chatgptAuthTokens/refresh',
  'attestation/generate',
  'currentTime/read',
  'applyPatchApproval',
  'execCommandApproval',
] as const

describe('codex reverse requests', () => {
  it('knows which reverse requests need the host permission callback', () => {
    const withPermission = SERVER_REQUEST_METHODS.filter((method) => codexServerRequestNeedsPermission(method))
    expect(withPermission).toEqual([
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/tool/requestUserInput',
      'mcpServer/elicitation/request',
      'item/permissions/requestApproval',
      'applyPatchApproval',
      'execCommandApproval',
    ])
    expect(codexServerRequestNeedsPermission('item/tool/call')).toBe(false)
    expect(codexServerRequestNeedsPermission('attestation/generate')).toBe(false)
  })

  it('answers all 11 schema reverse-request methods, including unknown ones', () => {
    for (const method of SERVER_REQUEST_METHODS) {
      const answer = answerCodexServerRequest({
        method,
        params: {
          itemId: 'item',
          threadId: 'thread',
          turnId: 'turn',
          questions: [],
          permissions: {},
        },
        decision: { optionId: 'accept' },
      })
      expect('result' in answer || 'error' in answer).toBe(true)
    }
    const unknown = answerCodexServerRequest({ method: 'brand/newMethod', params: {}, decision: { cancelled: true } })
    expect('error' in unknown && unknown.error.code).toBe(-32601)
  })

  it('maps command/file approval decisions', () => {
    const call = (method: string, decision: NativePermissionDecision): unknown => {
      const answer = answerCodexServerRequest({ method, params: { itemId: 'i' }, decision })
      if (!('result' in answer)) throw new Error('expected a result answer')
      return answer.result
    }
    expect(call('item/commandExecution/requestApproval', { optionId: 'accept' })).toEqual({ decision: 'accept' })
    expect(call('item/commandExecution/requestApproval', { optionId: 'acceptForSession' })).toEqual({
      decision: 'acceptForSession',
    })
    expect(call('item/fileChange/requestApproval', { optionId: 'cancel' })).toEqual({ decision: 'cancel' })
    // A dismissed host prompt declines instead of interrupting the turn.
    expect(call('item/fileChange/requestApproval', { cancelled: true })).toEqual({ decision: 'decline' })
  })

  it('maps legacy v1 ReviewDecision', () => {
    const call = (method: string, decision: NativePermissionDecision): unknown => {
      const answer = answerCodexServerRequest({ method, params: { callId: 'c' }, decision })
      if (!('result' in answer)) throw new Error('expected a result answer')
      return answer.result
    }
    expect(call('applyPatchApproval', { optionId: 'accept' })).toEqual({ decision: 'approved' })
    expect(call('applyPatchApproval', { optionId: 'acceptForSession' })).toEqual({
      decision: 'approved_for_session',
    })
    expect(call('execCommandApproval', { optionId: 'decline' })).toEqual({ decision: 'denied' })
    expect(call('execCommandApproval', { optionId: 'cancel' })).toEqual({ decision: 'abort' })
  })

  it('echoes the requested permissions on grant and grants nothing on deny', () => {
    const params = { itemId: 'i', permissions: { fileSystem: { read: ['/tmp'], write: [] } }, cwd: '/tmp' }
    const grant = answerCodexServerRequest({
      method: 'item/permissions/requestApproval',
      params,
      decision: { optionId: 'accept' },
    })
    expect('result' in grant && grant.result).toEqual({
      permissions: { fileSystem: { read: ['/tmp'], write: [] } },
      scope: 'turn',
    })
    const grantSession = answerCodexServerRequest({
      method: 'item/permissions/requestApproval',
      params,
      decision: { optionId: 'acceptForSession' },
    })
    expect('result' in grantSession && grantSession.result).toMatchObject({ scope: 'session' })
    const deny = answerCodexServerRequest({
      method: 'item/permissions/requestApproval',
      params,
      decision: { optionId: 'decline' },
    })
    expect('result' in deny && deny.result).toEqual({ permissions: {} })
  })

  it('answers user-input questions and MCP elicitation', () => {
    const questions = [
      {
        id: 'q1',
        header: 'Pick one',
        question: 'Which option?',
        options: [
          { label: 'A', description: 'first' },
          { label: 'B', description: 'second' },
        ],
      },
    ]
    const accepted = answerCodexServerRequest({
      method: 'item/tool/requestUserInput',
      params: { itemId: 'i', questions },
      decision: { optionId: 'accept' },
    })
    expect('result' in accepted && accepted.result).toEqual({ answers: { q1: { answers: ['A'] } } })
    const legacy = answerCodexServerRequest({
      method: 'tool/requestUserInput',
      params: { itemId: 'i', questions },
      decision: { optionId: 'accept' },
    })
    expect('result' in legacy && legacy.result).toEqual({ answers: { q1: { answers: ['A'] } } })
    const dismissed = answerCodexServerRequest({
      method: 'item/tool/requestUserInput',
      params: { itemId: 'i', questions },
      decision: { optionId: 'decline' },
    })
    expect('result' in dismissed && dismissed.result).toEqual({ answers: {} })

    const elicitationAccept = answerCodexServerRequest({
      method: 'mcpServer/elicitation/request',
      params: { serverName: 'docs' },
      decision: { optionId: 'accept' },
    })
    expect('result' in elicitationAccept && elicitationAccept.result).toEqual({
      action: 'accept',
      content: {},
      _meta: null,
    })
    const elicitationCancel = answerCodexServerRequest({
      method: 'mcpServer/elicitation/request',
      params: { serverName: 'docs' },
      decision: { optionId: 'cancel' },
    })
    expect('result' in elicitationCancel && elicitationCancel.result).toEqual({
      action: 'cancel',
      content: null,
      _meta: null,
    })
  })

  it('answers non-approval reverse requests with schema-valid defaults', () => {
    const toolCall = answerCodexServerRequest({
      method: 'item/tool/call',
      params: { callId: 'c', tool: 'x', arguments: {} },
      decision: { cancelled: true },
    })
    expect('result' in toolCall && toolCall.result).toMatchObject({ success: false })
    const now = answerCodexServerRequest({ method: 'currentTime/read', params: {}, decision: { cancelled: true } })
    if (!('result' in now)) throw new Error('expected currentTime/read result')
    const currentTimeAt = (now.result as { currentTimeAt?: unknown }).currentTimeAt
    expect(typeof currentTimeAt).toBe('number')
    expect(Math.abs(Number(currentTimeAt) - Math.floor(Date.now() / 1000))).toBeLessThan(10)
    for (const method of ['account/chatgptAuthTokens/refresh', 'attestation/generate']) {
      const answer = answerCodexServerRequest({ method, params: {}, decision: { cancelled: true } })
      expect('error' in answer && answer.error.code).toBe(-32601)
    }
  })

  it('builds host permission requests for approval-shaped methods', () => {
    const command = buildCodexPermissionRequest(
      'item/commandExecution/requestApproval',
      { itemId: 'item_cmd', command: 'rm -rf /tmp/x', cwd: '/tmp', reason: 'cleanup' },
      'req-1',
    )
    expect(command).toMatchObject({ requestId: 'req-1', title: 'Run rm -rf /tmp/x', detail: 'cleanup' })
    expect(command?.options.map((option) => option.optionId)).toEqual([
      'accept',
      'acceptForSession',
      'decline',
      'cancel',
    ])
    const question = buildCodexPermissionRequest(
      'item/tool/requestUserInput',
      {
        itemId: 'item_q',
        questions: [
          { id: 'q1', header: 'Mode', question: 'Which mode?', options: [{ label: 'fast', description: '' }] },
        ],
      },
      'req-2',
    )
    expect(question?.title).toBe('Mode: Which mode?')
    expect(question?.detail).toContain('fast')
    const permission = buildCodexPermissionRequest(
      'item/permissions/requestApproval',
      { itemId: 'item_p', permissions: { network: { enabled: true } }, reason: 'need network' },
      'req-3',
    )
    expect(permission?.title).toBe('Codex requests additional permissions')
    expect(permission?.detail).toContain('need network')
    expect(buildCodexPermissionRequest('attestation/generate', {}, 'req-4')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 4. Full protocol against the fake app-server
// ---------------------------------------------------------------------------

describe('codex app-server protocol (fake server)', () => {
  it('handshakes, runs one turn, maps events and answers an approval', async () => {
    const harness = await launchFake()
    expect(harness.transport.kind).toBe('codex')
    expect(harness.transport.sessionId).toBe('thr_test')

    // Starting twice must be idempotent.
    await harness.transport.start(harness.startOptions)
    expect(harness.transport.sessionId).toBe('thr_test')

    const controller = new AbortController()
    const result = await harness.transport.prompt([{ type: 'text', text: 'hi' }], controller.signal)
    expect(result.stopReason).toBe('end_turn')
    expect(result.usage).toMatchObject({ input: 123, output: 45, total: 456 })
    expect(harness.transport.contextUsage()).toEqual({ used: 456, size: 200000 })

    // The host was asked once, for the shell command.
    expect(harness.permissions).toHaveLength(1)
    expect(harness.permissions[0]?.title).toBe('Run echo hello')
    expect(harness.permissions[0]?.detail).toBe('fake approval')

    const text = harness.events
      .filter((event): event is Extract<NativeTransportEvent, { kind: 'text' }> => event.kind === 'text')
      .map((event) => event.text)
      .join('')
    // The final agentMessage item is de-duplicated against the streamed deltas.
    expect(text).toBe('Hello approval=accept attestation=error-32601')
    const toolCalls = harness.events.filter((event) => event.kind === 'tool_call')
    expect(toolCalls).toHaveLength(1)
    const toolCall = toolCalls[0]
    if (toolCall?.kind === 'tool_call') {
      expect(toolCall.toolCallId).toBe('item_cmd')
      expect(toolCall.title).toBe('Run echo hello')
      expect(toolCall.status).toBe('in_progress')
    }
    const toolUpdates = harness.events.filter((event) => event.kind === 'tool_call_update')
    expect(toolUpdates).toEqual([
      { kind: 'tool_call_update', toolCallId: 'item_cmd', status: 'completed', contentText: 'hello\n' },
    ])
    expect(harness.events.filter((event) => event.kind === 'status')).toEqual([
      { kind: 'status', busy: true },
      { kind: 'status', busy: false },
    ])
    expect(harness.events.some((event) => event.kind === 'usage')).toBe(true)
    expect(harness.events.some((event) => event.kind === 'context_usage')).toBe(true)

    const frames = await harness.readFrames()
    const initialize = framesByMethod(frames, 'initialize')[0]
    expect(initialize?.params).toMatchObject({
      clientInfo: { name: 'dsh' },
      capabilities: { experimentalApi: true },
    })
    expect(framesByMethod(frames, 'initialized')).toHaveLength(1)
    const threadStart = framesByMethod(frames, 'thread/start')[0]
    expect(threadStart?.params).toMatchObject({
      approvalPolicy: 'on-request',
      sandbox: 'danger-full-access',
    })
    const turnStart = framesByMethod(frames, 'turn/start')[0]
    expect(turnStart?.params).toMatchObject({
      threadId: 'thr_test',
      input: [{ type: 'text', text: 'hi', text_elements: [] }],
    })
    // Reverse requests are answered with a JSON-RPC result / error, not dropped.
    const replies = frames.filter((frame) => idOf(frame) !== undefined && frame.method === undefined)
    const approvalReply = replies.find((frame) => idOf(frame) === 9001)
    expect(approvalReply?.result).toEqual({ decision: 'accept' })
    const attestationReply = replies.find((frame) => idOf(frame) === 9002)
    expect(attestationReply?.error).toMatchObject({ code: -32601 })

    await harness.transport.close()
    await harness.transport.close()
  })

  it('steers the running turn and interrupts it', async () => {
    const harness = await launchFake({ FAKE_CODEX_MODE: 'hang' })
    const controller = new AbortController()
    expect(await harness.transport.steer([{ type: 'text', text: 'too early' }])).toBe('promptRequired')

    const settling = harness.transport.prompt([{ type: 'text', text: 'start' }], controller.signal)
    const promptController = new AbortController()
    await expect(harness.transport.prompt([{ type: 'text', text: 'second' }], promptController.signal)).rejects.toThrow(
      /already in progress/,
    )
    await waitFor(() => harness.events.some((event) => event.kind === 'tool_call'))

    expect(await harness.transport.steer([{ type: 'text', text: 'steer!' }])).toBe('injected')
    await harness.transport.interrupt()
    const result = await settling
    expect(result.stopReason).toBe('cancelled')

    // Interrupting again while idle is a no-op, not an error.
    await harness.transport.interrupt()

    const frames = await harness.readFrames()
    const steer = framesByMethod(frames, 'turn/steer')[0]
    expect(steer?.params).toMatchObject({
      threadId: 'thr_test',
      expectedTurnId: 'turn_test',
      input: [{ type: 'text', text: 'steer!', text_elements: [] }],
    })
    expect(typeof (steer?.params as { clientUserMessageId?: unknown } | undefined)?.clientUserMessageId).toBe('string')
    const interrupt = framesByMethod(frames, 'turn/interrupt')[0]
    expect(interrupt?.params).toEqual({ threadId: 'thr_test', turnId: 'turn_test' })
  })

  it('falls back to promptRequired when the steer precondition rejects', async () => {
    const harness = await launchFake({ FAKE_CODEX_MODE: 'hang', FAKE_STEER_REJECT_FIRST: '1' })
    const controller = new AbortController()
    const settling = harness.transport.prompt([{ type: 'text', text: 'start' }], controller.signal)
    await waitFor(() => harness.events.some((event) => event.kind === 'tool_call'))
    expect(await harness.transport.steer([{ type: 'text', text: 'steer!' }])).toBe('promptRequired')
    await harness.transport.interrupt()
    await settling
    const frames = await harness.readFrames()
    expect(framesByMethod(frames, 'turn/steer')).toHaveLength(1)
  })

  it('resumes an archived thread through thread/unarchive', async () => {
    const harness = await launchFake({ FAKE_LOADED: '0', FAKE_ARCHIVED: '1' }, 'thr_archived')
    expect(harness.transport.sessionId).toBe('thr_archived')
    const frames = await harness.readFrames()
    expect(framesByMethod(frames, 'thread/loaded/list')).toHaveLength(1)
    expect(framesByMethod(frames, 'thread/resume')).toHaveLength(2)
    expect(framesByMethod(frames, 'thread/unarchive')).toHaveLength(1)
    expect(framesByMethod(frames, 'thread/resume')[0]?.params).toMatchObject({ threadId: 'thr_archived' })
  })

  it('rejects prompts with empty content before touching the wire', async () => {
    const harness = await launchFake()
    await expect(
      harness.transport.prompt([], new AbortController().signal),
    ).rejects.toThrow(/must not be empty/)
    const frames = await harness.readFrames()
    expect(framesByMethod(frames, 'turn/start')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 5. Live codex app-server (no model call unless DSH_CODEX_REAL_TURN=1)
// ---------------------------------------------------------------------------

const codexAvailable = spawnSync('codex', ['--version'], { encoding: 'utf8' }).status === 0

describe('codex app-server live', () => {
  it.skipIf(!codexAvailable)(
    'spawns a real codex app-server and creates a thread',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dsh-codex-live-'))
      tempDirs.push(dir)
      const harness = await launch({ command: 'codex', args: ['app-server'], env: CHILD_ENV, cwd: dir })
      const threadId = harness.transport.sessionId
      expect(typeof threadId).toBe('string')
      expect(threadId ?? '').not.toBe('')
      expect(harness.logs.some((line) => line.includes('initialized'))).toBe(true)
      await harness.transport.close()
    },
    120_000,
  )

  it.skipIf(!codexAvailable || process.env.DSH_CODEX_REAL_STEER !== '1')(
    'steers a real codex turn while a tool call is running',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dsh-codex-live-steer-'))
      tempDirs.push(dir)
      const harness = await launch({ command: 'codex', args: ['app-server'], env: CHILD_ENV, cwd: dir })
      const controller = new AbortController()
      const settling = harness.transport.prompt(
        [
          {
            type: 'text',
            text: 'Run the shell command `sleep 5` in the foreground. After it finishes reply exactly DONE.',
          },
        ],
        controller.signal,
      )
      await waitFor(() => harness.events.some((event) => event.kind === 'tool_call'), 180_000)
      const steerResult = await harness.transport.steer([
        { type: 'text', text: 'After the command finishes, also include the word STEERED in your reply.' },
      ])
      expect(steerResult).toBe('injected')
      const result = await settling
      expect(result.stopReason).toBe('end_turn')
      const text = harness.events
        .filter((event): event is Extract<NativeTransportEvent, { kind: 'text' }> => event.kind === 'text')
        .map((event) => event.text)
        .join('')
      expect(text).not.toBe('')
      expect(text.toUpperCase()).toContain('STEERED')
      await harness.transport.close()
    },
    300_000,
  )

  it.skipIf(!codexAvailable || process.env.DSH_CODEX_REAL_TURN !== '1')(
    'completes a real codex turn',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dsh-codex-live-turn-'))
      tempDirs.push(dir)
      const harness = await launch({ command: 'codex', args: ['app-server'], env: CHILD_ENV, cwd: dir })
      const controller = new AbortController()
      const result = await harness.transport.prompt(
        [{ type: 'text', text: 'Reply with the single word PONG and nothing else.' }],
        controller.signal,
      )
      const text = harness.events
        .filter((event): event is Extract<NativeTransportEvent, { kind: 'text' }> => event.kind === 'text')
        .map((event) => event.text)
        .join('')
      expect(result.stopReason).toBe('end_turn')
      expect(text).not.toBe('')
      await harness.transport.close()
    },
    240_000,
  )
})
