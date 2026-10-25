/**
 * Codex native transport — `codex app-server` over newline-delimited JSON-RPC 2.0.
 *
 * Verified against codex-cli 0.162.1 (protocol generated from
 * `codex app-server generate-json-schema`, see the probe schema bundle in
 * `.scratch/dsh-native-agents-20261026/codex-claude-protocol/probe/codex-schema`).
 *
 * Lifecycle:
 *   spawn(command, [...args, "app-server"])
 *     -> initialize {clientInfo, capabilities:{experimentalApi:true}}
 *     -> initialized (notification)
 *     -> thread/start | thread/resume  (threadId)
 *     -> turn/start {threadId, input[]}  -> turn/started ... turn/completed
 *
 * Only `turn/*`, `item/*` and `thread/tokenUsage/updated` notifications are
 * mapped; the Paseo v1 names (`turn/aborted`, `codex/event/*`, bare
 * `exec_command_begin`, ...) do not exist in the 0.162.1 schema and are not
 * implemented. Turn completion is always `turn/completed` with
 * `turn.status ∈ completed | interrupted | failed` (there is no
 * `turn/aborted` notification).
 *
 * The app-server can also send server -> client *requests* (approvals, user
 * input, MCP elicitation, dynamic tool calls, auth refresh, attestation,
 * current-time). Every one of the 11 request methods is answered: the
 * approval-shaped ones are routed through `onPermission`, and the rest get a
 * schema-valid default answer. A missing answer would block Codex forever.
 *
 * Dependency-free apart from node builtins, by contract.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { NativeTransportError } from './contract.ts'
import type {
  NativeContentBlock,
  NativeContextUsage,
  NativePermissionDecision,
  NativePermissionRequest,
  NativePromptResult,
  NativeToolCallStatus,
  NativeTransport,
  NativeTransportEvent,
  NativeTransportKind,
  NativeTransportStartOptions,
  NativeUsage,
} from './contract.ts'

const CLIENT_INFO = { name: 'dsh', title: 'DeepSeek Harness', version: '0.0.1' } as const

/** Thread/turn requests are fast; the long wait is the turn itself, not an RPC. */
const REQUEST_TIMEOUT_MS = 60_000
const HANDSHAKE_TIMEOUT_MS = 30_000
const INTERRUPT_TIMEOUT_MS = 15_000
/** How long `steer()`/`interrupt()` wait for a `turn/started` to reveal the native turn id. */
const TURN_ID_WAIT_MS = 2_000
/** Fallback if a turn never settles after an abort; keeps the host from hanging. */
const ABORT_SETTLE_FALLBACK_MS = 30_000
const CLOSE_SIGTERM_MS = 2_000
const CLOSE_SIGKILL_MS = 1_000
const STDERR_LIMIT = 8_192
const TITLE_LIMIT = 160
const DETAIL_LIMIT = 2_000

// ---------------------------------------------------------------------------
// Small value helpers (the app-server payloads are typed as unknown in tests
// and across CLI versions, so every read is defensive).
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readNonNegativeInteger(record: Record<string, unknown>, key: string): number {
  const value = readNumber(record, key)
  return value === undefined || value < 0 ? 0 : Math.trunc(value)
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false
    const finish = (value: T): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(fallback), timeoutMs)
    timer.unref?.()
    promise.then(finish, () => finish(fallback))
  })
}

// ---------------------------------------------------------------------------
// JSON-RPC error + steer classification
// ---------------------------------------------------------------------------

/** A JSON-RPC error object returned by the app-server (as opposed to a transport failure). */
export class CodexRpcError extends Error {
  constructor(
    message: string,
    readonly code: number | string | undefined,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = 'CodexRpcError'
  }
}

/**
 * `true` only for errors that *definitively* mean the input was not accepted:
 * the method does not exist (-32601) or the invalid-request message is one of
 * the known steer preconditions (-32600 + exact message / codexErrorInfo).
 * Timeouts, disconnects and unknown -32600 errors are ambiguous and must be
 * rethrown — treating them as "steer unsupported" duplicates user input.
 */
export function isDefinitiveSteerRejection(error: unknown): boolean {
  if (!(error instanceof CodexRpcError)) return false
  if (error.code === -32601) return true
  if (error.code !== -32600) return false
  const data = isRecord(error.data) ? error.data : undefined
  const codexErrorInfo =
    data !== undefined && isRecord(data.codexErrorInfo) ? data.codexErrorInfo : undefined
  if (codexErrorInfo !== undefined && isRecord(codexErrorInfo.activeTurnNotSteerable)) return true
  return (
    error.message === 'no active turn to steer' ||
    /^expected active turn id .+ but found .+$/.test(error.message) ||
    error.message === 'active turn uses a different output schema'
  )
}

/** `turn/interrupt` raced the turn completion: codex is already idle, nothing to do. */
function isAlreadyIdleInterrupt(error: unknown): boolean {
  return (
    error instanceof CodexRpcError &&
    error.code === -32600 &&
    /no active turn to interrupt/i.test(error.message)
  )
}

// ---------------------------------------------------------------------------
// Usage / context mapping (`thread/tokenUsage/updated`)
// ---------------------------------------------------------------------------

interface CodexUsageSnapshot {
  readonly usage: NativeUsage
  readonly contextUsage: NativeContextUsage
}

/**
 * Map one `thread/tokenUsage/updated` params object.
 *
 * Codex reports a snapshot, not a delta: `last` is the most recent turn and
 * `total` is cumulative. The ACP usage surface wants context occupancy, so
 * `last.totalTokens` becomes the used count and `modelContextWindow` the size.
 */
export function codexUsageFromParams(params: unknown): CodexUsageSnapshot | undefined {
  if (!isRecord(params)) return undefined
  const tokenUsage = params.tokenUsage
  if (!isRecord(tokenUsage)) return undefined
  const last = tokenUsage.last
  if (!isRecord(last)) return undefined
  const input = readNonNegativeInteger(last, 'inputTokens')
  const output = readNonNegativeInteger(last, 'outputTokens')
  const cacheRead = readNonNegativeInteger(last, 'cachedInputTokens')
  const cacheWrite = readNonNegativeInteger(last, 'cacheWriteInputTokens')
  const reasoning = readNonNegativeInteger(last, 'reasoningOutputTokens')
  const total = readNonNegativeInteger(last, 'totalTokens')
  const window = readNumber(tokenUsage, 'modelContextWindow')
  const size = window === undefined || window <= 0 ? 0 : Math.trunc(window)
  return {
    usage: { input, output, cacheRead, cacheWrite, total, reasoning },
    contextUsage: { used: total, size },
  }
}

// ---------------------------------------------------------------------------
// Notification -> contract event mapping
// ---------------------------------------------------------------------------

type CodexToolItemStatus = NativeToolCallStatus

function codexItemStatus(value: unknown): CodexToolItemStatus | undefined {
  switch (value) {
    case 'inProgress':
      return 'in_progress'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'interrupted':
    case 'declined':
    case 'canceled':
    case 'cancelled':
      return 'cancelled'
    default:
      return undefined
  }
}

function codexContentItemsText(items: unknown): string | undefined {
  if (!Array.isArray(items)) return undefined
  const parts: string[] = []
  for (const item of items) {
    if (!isRecord(item)) continue
    if (item.type === 'inputText' && typeof item.text === 'string') parts.push(item.text)
    else if (item.type === 'inputImage') parts.push('[image]')
    else if (item.type === 'inputAudio') parts.push('[audio]')
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

function codexMcpResultText(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined
  const content = result.content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const entry of content) {
    if (!isRecord(entry)) continue
    if (entry.type === 'text' && typeof entry.text === 'string') parts.push(entry.text)
    else if (entry.type === 'image') parts.push('[image]')
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

function codexFileChangePaths(item: Record<string, unknown>): string[] {
  const changes = item.changes
  if (!Array.isArray(changes)) return []
  const paths: string[] = []
  for (const change of changes) {
    if (!isRecord(change)) continue
    const path = readString(change, 'path')
    if (path !== undefined) paths.push(path)
  }
  return paths
}

interface CodexToolItemMapping {
  readonly title: string
  readonly rawInput?: unknown
  readonly contentText?: string
}

function codexToolItemMapping(
  item: Record<string, unknown>,
  started: boolean,
): CodexToolItemMapping | NativeTransportEvent[] | undefined {
  const type = readString(item, 'type')
  if (type === undefined) return undefined
  const failed = item.status === 'failed' || item.status === 'declined'
  switch (type) {
    case 'commandExecution': {
      const command = readString(item, 'command')
      const cwd = readString(item, 'cwd')
      const aggregatedOutput = readString(item, 'aggregatedOutput')
      const exitCode = readNumber(item, 'exitCode')
      const contentText =
        aggregatedOutput !== undefined && aggregatedOutput.trim() !== ''
          ? aggregatedOutput
          : !started && !failed && exitCode !== undefined
            ? `exit code ${String(exitCode)}`
            : undefined
      return {
        title: command === undefined ? 'Run command' : `Run ${truncate(command, TITLE_LIMIT)}`,
        rawInput: { command, cwd },
        ...(contentText === undefined ? {} : { contentText }),
      }
    }
    case 'fileChange': {
      const paths = codexFileChangePaths(item)
      return {
        title: 'Apply file changes',
        rawInput: { paths },
        ...(paths.length === 0 ? {} : { contentText: paths.join('\n') }),
      }
    }
    case 'mcpToolCall': {
      const server = readString(item, 'server')
      const tool = readString(item, 'tool')
      const error = isRecord(item.error) ? item.error : undefined
      const contentText =
        started || error !== undefined
          ? error === undefined
            ? undefined
            : readString(error, 'message')
          : codexMcpResultText(item.result)
      return {
        title: `MCP ${server ?? 'tool'}/${tool ?? 'call'}`,
        rawInput: item.arguments,
        ...(contentText === undefined ? {} : { contentText }),
      }
    }
    case 'dynamicToolCall': {
      const tool = readString(item, 'tool')
      const contentText = started ? undefined : codexContentItemsText(item.contentItems)
      return {
        title: `Tool ${tool ?? 'call'}`,
        rawInput: item.arguments,
        ...(contentText === undefined ? {} : { contentText }),
      }
    }
    case 'collabAgentToolCall': {
      const tool = readString(item, 'tool')
      return {
        title: `Agent ${tool ?? 'call'}`,
        rawInput: { tool, prompt: item.prompt, receiverThreadIds: item.receiverThreadIds },
      }
    }
    case 'webSearch': {
      const query = readString(item, 'query')
      return {
        title: query === undefined ? 'Web search' : `Search ${truncate(query, TITLE_LIMIT)}`,
        rawInput: { query },
      }
    }
    case 'imageView': {
      const path = readString(item, 'path')
      return {
        title: 'View image',
        rawInput: { path },
        ...(started || path === undefined ? {} : { contentText: path }),
      }
    }
    case 'imageGeneration': {
      const revisedPrompt = readString(item, 'revisedPrompt')
      const savedPath = readString(item, 'savedPath')
      return {
        title: 'Generate image',
        rawInput: { revisedPrompt },
        ...(started
          ? {}
          : savedPath === undefined
            ? {}
            : { contentText: savedPath }),
      }
    }
    case 'sleep': {
      const durationMs = readNumber(item, 'durationMs')
      return {
        title: durationMs === undefined ? 'Wait' : `Wait ${String(Math.trunc(durationMs))} ms`,
      }
    }
    case 'plan': {
      const text = readString(item, 'text')
      return {
        title: 'Plan',
        rawInput: { text },
        ...(started || text === undefined ? {} : { contentText: text }),
      }
    }
    case 'enteredReviewMode':
    case 'exitedReviewMode': {
      const review = readString(item, 'review')
      return {
        title: type === 'enteredReviewMode' ? 'Enter review mode' : 'Exit review mode',
        ...(started || review === undefined ? {} : { contentText: review }),
      }
    }
    case 'contextCompaction':
      return started ? [] : [{ kind: 'notice', text: 'Codex compacted the conversation context.' }]
    // Text/reasoning items stream through deltas; user echoes and hook prompts
    // are not agent tool calls.
    case 'agentMessage':
    case 'reasoning':
    case 'userMessage':
    case 'hookPrompt':
    case 'functionCallOutput':
    case 'subAgentActivity':
      return undefined
    default:
      return undefined
  }
}

/**
 * Map one stateless app-server notification onto contract events.
 *
 * Stateful pieces (turn lifecycle, tool-call anchoring, delta/full-text
 * de-duplication) stay in the transport; this function is exported so the
 * mapping can be unit-tested against the real schema frames.
 */
export function codexNotificationEvents(
  method: string,
  params: unknown,
): readonly NativeTransportEvent[] {
  const record = isRecord(params) ? params : {}
  switch (method) {
    case 'item/agentMessage/delta': {
      const delta = readString(record, 'delta')
      return delta === undefined || delta === '' ? [] : [{ kind: 'text', text: delta }]
    }
    case 'item/reasoning/summaryTextDelta':
    case 'item/reasoning/textDelta': {
      const delta = readString(record, 'delta')
      return delta === undefined || delta === '' ? [] : [{ kind: 'thought', text: delta }]
    }
    case 'item/started':
    case 'item/completed': {
      const item = record.item
      if (!isRecord(item)) return []
      const id = readString(item, 'id')
      if (id === undefined) return []
      const started = method === 'item/started'
      const mapping = codexToolItemMapping(item, started)
      if (mapping === undefined) return []
      if (Array.isArray(mapping)) return mapping
      const status = codexItemStatus(item.status) ?? (started ? 'in_progress' : 'completed')
      if (started) {
        const event: NativeTransportEvent = {
          kind: 'tool_call',
          toolCallId: id,
          title: mapping.title,
          status: 'in_progress',
          ...(mapping.rawInput === undefined ? {} : { rawInput: mapping.rawInput }),
        }
        return [event]
      }
      const event: NativeTransportEvent = {
        kind: 'tool_call_update',
        toolCallId: id,
        status,
        ...(mapping.contentText === undefined ? {} : { contentText: mapping.contentText }),
      }
      return [event]
    }
    case 'thread/tokenUsage/updated': {
      const snapshot = codexUsageFromParams(params)
      if (snapshot === undefined) return []
      return [
        { kind: 'usage', usage: snapshot.usage },
        { kind: 'context_usage', contextUsage: snapshot.contextUsage },
      ]
    }
    case 'error': {
      const error = isRecord(record.error) ? record.error : {}
      const message = readString(error, 'message') ?? 'unknown error'
      const extra = readString(error, 'additionalDetails')
      const retrying = record.willRetry === true ? ' (will retry)' : ''
      return [
        {
          kind: 'notice',
          text: truncate(`Codex error${retrying}: ${message}${extra === undefined ? '' : ` — ${extra}`}`, DETAIL_LIMIT),
        },
      ]
    }
    case 'warning': {
      const message = readString(record, 'message')
      return message === undefined
        ? []
        : [{ kind: 'notice', text: truncate(`Codex warning: ${message}`, DETAIL_LIMIT) }]
    }
    case 'configWarning': {
      const summary = readString(record, 'summary') ?? 'configuration warning'
      const details = readString(record, 'details')
      return [
        {
          kind: 'notice',
          text: truncate(
            `Codex config warning: ${summary}${details === undefined ? '' : ` — ${details}`}`,
            DETAIL_LIMIT,
          ),
        },
      ]
    }
    case 'deprecationNotice': {
      const summary = readString(record, 'summary') ?? 'deprecated API'
      return [{ kind: 'notice', text: truncate(`Codex deprecation notice: ${summary}`, DETAIL_LIMIT) }]
    }
    case 'thread/compacted':
      return [{ kind: 'notice', text: 'Codex compacted the conversation context.' }]
    case 'turn/plan/updated': {
      const plan = record.plan
      if (!Array.isArray(plan)) return []
      const steps: string[] = []
      plan.forEach((step, index) => {
        if (!isRecord(step)) return
        const label = readString(step, 'step') ?? ''
        const status = readString(step, 'status') ?? 'unknown'
        steps.push(`${String(index + 1)}. ${label} [${status}]`)
      })
      if (steps.length === 0) return []
      const explanation = readString(record, 'explanation')
      const text = `Codex plan updated: ${steps.join('; ')}${explanation === undefined ? '' : ` — ${explanation}`}`
      return [{ kind: 'notice', text: truncate(text, DETAIL_LIMIT) }]
    }
    default:
      return []
  }
}

/**
 * `turn/completed.turn.status` (completed | interrupted | failed | inProgress)
 * -> contract stop reason.
 *
 * `failed` has no exact ACP peer; it is reported as `refusal` and the turn's
 * error message is surfaced separately as a notice. There is no `turn/aborted`
 * notification — `interrupted` is the user-cancel path.
 */
export function codexStopReason(status: unknown): NativePromptResult['stopReason'] {
  switch (status) {
    case 'interrupted':
      return 'cancelled'
    case 'failed':
      return 'refusal'
    default:
      return 'end_turn'
  }
}

// ---------------------------------------------------------------------------
// Server -> client requests (approvals). All 11 methods must be answered.
// ---------------------------------------------------------------------------

const APPROVAL_OPTIONS: readonly NativePermissionRequest['options'][number][] = [
  { optionId: 'accept', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'acceptForSession', name: 'Allow for this session', kind: 'allow_always' },
  { optionId: 'decline', name: 'Reject', kind: 'reject_once' },
  { optionId: 'cancel', name: 'Reject and stop the turn', kind: 'reject_always' },
]

const QUESTION_OPTIONS: readonly NativePermissionRequest['options'][number][] = [
  { optionId: 'accept', name: 'Answer with the default option', kind: 'allow_once' },
  { optionId: 'decline', name: 'Dismiss the question', kind: 'reject_once' },
]

const ELICITATION_OPTIONS: readonly NativePermissionRequest['options'][number][] = [
  { optionId: 'accept', name: 'Accept', kind: 'allow_once' },
  { optionId: 'decline', name: 'Decline', kind: 'reject_once' },
  { optionId: 'cancel', name: 'Cancel', kind: 'reject_always' },
]

/** Reverse-request methods whose answer is a human decision. */
export function codexServerRequestNeedsPermission(method: string): boolean {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
    case 'item/permissions/requestApproval':
    case 'item/tool/requestUserInput':
    // Pre-0.162 name still accepted by some builds.
    case 'tool/requestUserInput':
    case 'mcpServer/elicitation/request':
    case 'applyPatchApproval':
    case 'execCommandApproval':
      return true
    default:
      return false
  }
}

function isAcceptedDecision(decision: NativePermissionDecision): boolean {
  if ('cancelled' in decision) return false
  return decision.optionId === 'accept' || decision.optionId === 'acceptForSession'
}

function selectedOptionId(decision: NativePermissionDecision): 'accept' | 'acceptForSession' | 'decline' | 'cancel' {
  if ('cancelled' in decision) return 'decline'
  switch (decision.optionId) {
    case 'accept':
    case 'acceptForSession':
    case 'cancel':
      return decision.optionId
    default:
      return 'decline'
  }
}

function codexApprovalDecision(decision: NativePermissionDecision): 'accept' | 'acceptForSession' | 'decline' | 'cancel' {
  return selectedOptionId(decision)
}

/** Legacy v1 `ReviewDecision` used by `applyPatchApproval` / `execCommandApproval`. */
function codexReviewDecision(decision: NativePermissionDecision): string {
  switch (selectedOptionId(decision)) {
    case 'accept':
      return 'approved'
    case 'acceptForSession':
      return 'approved_for_session'
    case 'cancel':
      return 'abort'
    default:
      return 'denied'
  }
}

function codexUserInputResponse(
  params: Record<string, unknown> | undefined,
  decision: NativePermissionDecision,
): unknown {
  if (!isAcceptedDecision(decision)) return { answers: {} }
  const questions = params?.questions
  if (!Array.isArray(questions)) return { answers: {} }
  const answers: Record<string, { answers: string[] }> = {}
  for (const question of questions) {
    if (!isRecord(question)) continue
    const id = readString(question, 'id')
    if (id === undefined) continue
    const options = question.options
    if (!Array.isArray(options)) continue
    for (const option of options) {
      if (!isRecord(option)) continue
      const label = readString(option, 'label')
      if (label === undefined || label.trim() === '') continue
      answers[id] = { answers: [label] }
      break
    }
  }
  return { answers }
}

function codexPermissionsResponse(
  params: Record<string, unknown> | undefined,
  decision: NativePermissionDecision,
): unknown {
  const optionId = selectedOptionId(decision)
  if (optionId !== 'accept' && optionId !== 'acceptForSession') {
    // The native negative for this family is a granted profile that grants
    // nothing (there is no `decision` field in the response schema).
    return { permissions: {} }
  }
  const requested = params?.permissions
  const permissions = isRecord(requested) ? requested : {}
  return { permissions, scope: optionId === 'acceptForSession' ? 'session' : 'turn' }
}

function codexElicitationResponse(decision: NativePermissionDecision): unknown {
  switch (selectedOptionId(decision)) {
    case 'accept':
      return { action: 'accept', content: {}, _meta: null }
    case 'cancel':
      return { action: 'cancel', content: null, _meta: null }
    default:
      return { action: 'decline', content: null, _meta: null }
  }
}

/** One schema-valid answer (or JSON-RPC error) for every reversable request. */
export type CodexServerRequestAnswer =
  | { readonly result: unknown }
  | { readonly error: { readonly code: number; readonly message: string } }

/**
 * Answer one app-server -> client request.
 *
 * Every method from the 0.162.1 `ServerRequest` schema is handled; unknown
 * methods still get a JSON-RPC error so the server never waits forever.
 */
export function answerCodexServerRequest(input: {
  readonly method: string
  readonly params: unknown
  readonly decision: NativePermissionDecision
}): CodexServerRequestAnswer {
  const params = isRecord(input.params) ? input.params : undefined
  switch (input.method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { result: { decision: codexApprovalDecision(input.decision) } }
    case 'applyPatchApproval':
    case 'execCommandApproval':
      return { result: { decision: codexReviewDecision(input.decision) } }
    case 'item/permissions/requestApproval':
      return { result: codexPermissionsResponse(params, input.decision) }
    case 'item/tool/requestUserInput':
    case 'tool/requestUserInput':
      return { result: codexUserInputResponse(params, input.decision) }
    case 'mcpServer/elicitation/request':
      return { result: codexElicitationResponse(input.decision) }
    case 'item/tool/call':
      // Dynamic client-side tools are not registered by DSH; answer with a
      // failing call instead of leaving Codex blocked.
      return {
        result: {
          contentItems: [
            { type: 'inputText', text: 'Dynamic tools are not available in this DSH session.' },
          ],
          success: false,
        },
      }
    case 'currentTime/read':
      return { result: { currentTimeAt: Math.floor(Date.now() / 1000) } }
    case 'account/chatgptAuthTokens/refresh':
      return {
        error: { code: -32601, message: 'DSH does not manage ChatGPT authentication tokens.' },
      }
    case 'attestation/generate':
      return { error: { code: -32601, message: 'DSH cannot generate client attestations.' } }
    default:
      return {
        error: { code: -32601, message: `Unsupported Codex app-server request: ${input.method}` },
      }
  }
}

function questionTitle(questions: readonly unknown[]): string {
  for (const question of questions) {
    if (!isRecord(question)) continue
    const header = readString(question, 'header')
    const prompt = readString(question, 'question')
    const text = header !== undefined && prompt !== undefined ? `${header}: ${prompt}` : (prompt ?? header)
    if (text !== undefined && text !== '') return truncate(text, TITLE_LIMIT)
  }
  return 'Answer a question from Codex'
}

function questionDetail(questions: readonly unknown[]): string | undefined {
  const lines: string[] = []
  for (const question of questions) {
    if (!isRecord(question)) continue
    const prompt = readString(question, 'question') ?? readString(question, 'header')
    if (prompt === undefined) continue
    const labels: string[] = []
    if (Array.isArray(question.options)) {
      for (const option of question.options) {
        if (!isRecord(option)) continue
        const label = readString(option, 'label')
        if (label !== undefined) labels.push(label)
      }
    }
    lines.push(labels.length === 0 ? prompt : `${prompt} (${labels.join(' / ')})`)
  }
  return lines.length === 0 ? undefined : truncate(lines.join('\n'), DETAIL_LIMIT)
}

/**
 * Build the host-facing permission request for one reverse request.
 * Returns `undefined` for methods that are not permission-shaped.
 */
export function buildCodexPermissionRequest(
  method: string,
  params: unknown,
  requestId = `codex-${randomUUID()}`,
): NativePermissionRequest | undefined {
  const record = isRecord(params) ? params : {}
  switch (method) {
    case 'item/commandExecution/requestApproval': {
      const command = readString(record, 'command')
      const reason = readString(record, 'reason')
      const cwd = readString(record, 'cwd')
      return {
        requestId,
        title: command === undefined ? 'Codex wants to run a command' : `Run ${truncate(command, TITLE_LIMIT)}`,
        ...(reason !== undefined
          ? { detail: reason }
          : cwd === undefined
            ? {}
            : { detail: `cwd: ${cwd}` }),
        options: APPROVAL_OPTIONS,
      }
    }
    case 'item/fileChange/requestApproval': {
      const reason = readString(record, 'reason')
      const grantRoot = readString(record, 'grantRoot')
      return {
        requestId,
        title: 'Codex wants to apply file changes',
        ...(reason !== undefined
          ? { detail: reason }
          : grantRoot === undefined
            ? {}
            : { detail: `write root: ${grantRoot}` }),
        options: APPROVAL_OPTIONS,
      }
    }
    case 'item/permissions/requestApproval': {
      const reason = readString(record, 'reason')
      const permissions = record.permissions
      const permissionText =
        permissions === undefined ? undefined : truncate(JSON.stringify(permissions), DETAIL_LIMIT)
      const detail = [reason, permissionText].filter((part): part is string => part !== undefined).join('\n')
      return {
        requestId,
        title: 'Codex requests additional permissions',
        ...(detail === '' ? {} : { detail }),
        options: APPROVAL_OPTIONS,
      }
    }
    case 'item/tool/requestUserInput':
    case 'tool/requestUserInput': {
      const questions = Array.isArray(record.questions) ? record.questions : []
      const detail = questionDetail(questions)
      return {
        requestId,
        title: questionTitle(questions),
        ...(detail === undefined ? {} : { detail }),
        options: QUESTION_OPTIONS,
      }
    }
    case 'mcpServer/elicitation/request': {
      const serverName = readString(record, 'serverName') ?? 'MCP server'
      const message = readString(record, 'message')
      return {
        requestId,
        title: truncate(`MCP approval: ${serverName}`, TITLE_LIMIT),
        ...(message === undefined ? {} : { detail: truncate(message, DETAIL_LIMIT) }),
        options: ELICITATION_OPTIONS,
      }
    }
    case 'applyPatchApproval': {
      const reason = readString(record, 'reason')
      return {
        requestId,
        title: 'Codex wants to apply a patch',
        ...(reason === undefined ? {} : { detail: reason }),
        options: APPROVAL_OPTIONS,
      }
    }
    case 'execCommandApproval': {
      const command = Array.isArray(record.command)
        ? record.command.filter((part): part is string => typeof part === 'string').join(' ')
        : undefined
      const reason = readString(record, 'reason')
      return {
        requestId,
        title: command === undefined ? 'Codex wants to run a command' : `Run ${truncate(command, TITLE_LIMIT)}`,
        ...(reason === undefined ? {} : { detail: reason }),
        options: APPROVAL_OPTIONS,
      }
    }
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

interface PendingRequest {
  readonly method: string
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

interface PendingServerRequest {
  readonly method: string
  readonly controller: AbortController
}

interface PromptSettlement {
  readonly resolve: (result: NativePromptResult) => void
  readonly reject: (error: Error) => void
}

/**
 * One `codex app-server` process. Not reusable after `close()`.
 *
 * @internal exported so the test suite can exercise the protocol machinery.
 */
export class CodexAppServerTransport implements NativeTransport {
  readonly kind: NativeTransportKind = 'codex'

  private options: NativeTransportStartOptions | undefined
  private child: ChildProcessWithoutNullStreams | undefined
  private readline: ReturnType<typeof createInterface> | undefined
  private detached = false
  private stderr = ''
  private exitError: NativeTransportError | undefined

  private nextRequestId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly pendingServerRequests = new Map<number, PendingServerRequest>()

  private threadId: string | undefined
  private activeTurnId: string | undefined
  private turnIdentification: Deferred<string | undefined> | undefined
  private promptSettlement: PromptSettlement | undefined
  /** Set synchronously at prompt() entry so a concurrent prompt cannot race the setup await. */
  private promptActive = false
  private pendingAbort = false
  private abortTimer: ReturnType<typeof setTimeout> | undefined

  private lastUsage: NativeUsage | undefined
  private lastContextUsage: NativeContextUsage | undefined

  private readonly streamedItems = new Set<string>()
  private readonly knownToolCalls = new Set<string>()
  private readonly tempDirs = new Set<string>()

  private startPromise: Promise<void> | undefined
  private closePromise: Promise<void> | undefined
  private closed = false

  get sessionId(): string | undefined {
    return this.threadId
  }

  // -- logging / events ----------------------------------------------------

  private log(message: string): void {
    try {
      this.options?.log?.(message)
    } catch {
      // A diagnostic sink must never break the protocol loop.
    }
  }

  private emit(event: NativeTransportEvent): void {
    const handler = this.options?.onEvent
    if (handler === undefined) return
    try {
      handler(event)
    } catch (error: unknown) {
      this.log(`codex: onEvent handler threw: ${messageOf(error)}`)
    }
  }

  // -- lifecycle -----------------------------------------------------------

  async start(options: NativeTransportStartOptions): Promise<void> {
    if (this.startPromise !== undefined) return await this.startPromise
    this.startPromise = this.startInternal(options)
    return await this.startPromise
  }

  private async startInternal(options: NativeTransportStartOptions): Promise<void> {
    if (this.closed) throw new NativeTransportError('Codex transport is closed', 'closed')
    this.options = options
    try {
      this.spawnProcess(options)
      await this.handshake()
      await this.ensureThread(options)
    } catch (error: unknown) {
      await this.closePromise?.catch(() => undefined)
      if (!this.closed) await this.close().catch(() => undefined)
      if (error instanceof NativeTransportError) throw error
      throw new NativeTransportError(
        `Failed to start codex app-server: ${messageOf(error)}`,
        'codex_start_failed',
        this.stderrTail(),
      )
    }
  }

  private appendArgs(args: readonly string[]): string[] {
    const copy = [...args]
    // `codex app-server` is the only subcommand this transport speaks. The
    // host normally passes it already (native-session-runtime builds it); be
    // forgiving when constructed directly.
    if (!copy.includes('app-server')) copy.push('app-server')
    return copy
  }

  private spawnProcess(options: NativeTransportStartOptions): void {
    const detached = process.platform !== 'win32'
    const child = spawn(options.command, this.appendArgs(options.args), {
      cwd: options.cwd,
      env: { ...options.env },
      stdio: 'pipe',
      detached,
    })
    this.child = child
    this.detached = detached
    this.stderr = ''

    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString()
      if (this.stderr.length > STDERR_LIMIT) this.stderr = this.stderr.slice(-STDERR_LIMIT)
    })
    child.stdin.on('error', (error: Error) => {
      this.log(`codex: stdin error: ${messageOf(error)}`)
    })
    child.on('error', (error: Error) => {
      this.handleProcessFailure(
        new NativeTransportError(`codex app-server failed: ${messageOf(error)}`, 'process_error'),
      )
    })
    child.on('exit', (code, signal) => {
      const description =
        code === 0 && signal === null
          ? 'codex app-server exited'
          : `codex app-server exited with code ${String(code)} signal ${String(signal)}`
      this.handleProcessFailure(
        new NativeTransportError(description, 'process_exit', this.stderrTail()),
      )
    })

    const readline = createInterface({ input: child.stdout })
    this.readline = readline
    readline.on('line', (line: string) => {
      this.handleLine(line)
    })
  }

  private stderrTail(): string {
    return this.stderr.trim().slice(-DETAIL_LIMIT)
  }

  private handleProcessFailure(error: NativeTransportError): void {
    if (this.closed || this.exitError !== undefined) return
    this.exitError = error
    this.rejectPending(error)
    for (const pending of this.pendingServerRequests.values()) pending.controller.abort()
    this.pendingServerRequests.clear()
    this.resolveTurnIdentification(undefined)
    const promptActive = this.promptSettlement !== undefined
    this.settlePromptReject(error)
    if (promptActive) this.emit({ kind: 'status', busy: false })
    this.log(`${error.message}${error.detail === undefined ? '' : `\n${error.detail}`}`)
  }

  private async handshake(): Promise<void> {
    const result = await this.request(
      'initialize',
      {
        clientInfo: CLIENT_INFO,
        capabilities: { experimentalApi: true },
      },
      HANDSHAKE_TIMEOUT_MS,
    )
    const userAgent = isRecord(result) ? readString(result, 'userAgent') : undefined
    this.log(`codex: initialized${userAgent === undefined ? '' : ` (${truncate(userAgent, 200)})`}`)
    this.notify('initialized', {})
  }

  private async ensureThread(options: NativeTransportStartOptions): Promise<void> {
    const resume = options.resumeSessionId
    if (resume === undefined || resume === '') {
      await this.startThread(options)
      return
    }
    try {
      const loaded = await this.request('thread/loaded/list', {}, REQUEST_TIMEOUT_MS)
      const ids =
        isRecord(loaded) && Array.isArray(loaded.data)
          ? loaded.data.filter((id): id is string => typeof id === 'string')
          : []
      if (ids.includes(resume)) {
        this.threadId = resume
        return
      }
    } catch (error: unknown) {
      this.log(`codex: thread/loaded/list failed (${messageOf(error)}); resuming directly`)
    }
    await this.resumeThread(resume, options)
  }

  private threadPolicyParams(options: NativeTransportStartOptions): Record<string, unknown> {
    // DSH's native sessions are unconfined (native-agent-access projects
    // danger-full-access) while individual approvals may still be asked.
    return {
      cwd: options.cwd,
      approvalPolicy: 'on-request',
      sandbox: 'danger-full-access',
    }
  }

  private readThreadId(response: unknown): string | undefined {
    if (!isRecord(response)) return undefined
    const thread = response.thread
    if (!isRecord(thread)) return undefined
    return readString(thread, 'id')
  }

  private async startThread(options: NativeTransportStartOptions): Promise<void> {
    const response = await this.request(
      'thread/start',
      this.threadPolicyParams(options),
      REQUEST_TIMEOUT_MS,
    )
    const threadId = this.readThreadId(response)
    if (threadId === undefined) {
      throw new NativeTransportError(
        'codex app-server did not return a thread id from thread/start',
        'protocol_error',
        truncate(JSON.stringify(response) ?? '', DETAIL_LIMIT),
      )
    }
    this.threadId = threadId
  }

  private async resumeThread(threadId: string, options: NativeTransportStartOptions): Promise<void> {
    try {
      const response = await this.request(
        'thread/resume',
        { threadId, ...this.threadPolicyParams(options) },
        REQUEST_TIMEOUT_MS,
      )
      this.threadId = this.readThreadId(response) ?? threadId
    } catch (error: unknown) {
      if (!isArchivedThreadError(error)) throw error
      this.log(`codex: thread ${threadId} is archived; unarchiving before resume`)
      await this.request('thread/unarchive', { threadId }, REQUEST_TIMEOUT_MS)
      const response = await this.request(
        'thread/resume',
        { threadId, ...this.threadPolicyParams(options) },
        REQUEST_TIMEOUT_MS,
      )
      this.threadId = this.readThreadId(response) ?? threadId
    }
  }

  // -- JSON-RPC plumbing ---------------------------------------------------

  private writeFrame(payload: Record<string, unknown>): void {
    const child = this.child
    if (child === undefined) throw new NativeTransportError('codex app-server is not running', 'not_running')
    if (child.stdin.destroyed || !child.stdin.writable) {
      throw this.exitError ?? new NativeTransportError('codex app-server stdin is closed', 'not_running')
    }
    try {
      child.stdin.write(`${JSON.stringify(payload)}\n`)
    } catch (error: unknown) {
      throw new NativeTransportError(
        `failed to write to codex app-server: ${messageOf(error)}`,
        'write_failed',
      )
    }
  }

  private request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.closed) return Promise.reject(new NativeTransportError('Codex transport is closed', 'closed'))
    if (this.exitError !== undefined) return Promise.reject(this.exitError)
    const id = this.nextRequestId
    this.nextRequestId += 1
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return
        reject(new NativeTransportError(`codex app-server request timed out: ${method}`, 'timeout'))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { method, resolve, reject, timer })
      try {
        this.writeFrame({ id, method, params })
      } catch (error: unknown) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private notify(method: string, params: unknown): void {
    if (this.closed) return
    try {
      this.writeFrame({ method, params })
    } catch (error: unknown) {
      this.log(`codex: failed to send ${method}: ${messageOf(error)}`)
    }
  }

  private reply(id: number, result: unknown): void {
    if (this.closed) return
    try {
      this.writeFrame({ id, result })
    } catch (error: unknown) {
      this.log(`codex: failed to reply to server request ${String(id)}: ${messageOf(error)}`)
    }
  }

  private replyError(id: number, code: number, message: string): void {
    if (this.closed) return
    try {
      this.writeFrame({ id, error: { code, message } })
    } catch (error: unknown) {
      this.log(`codex: failed to reply to server request ${String(id)}: ${messageOf(error)}`)
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private handleLine(line: string): void {
    if (this.closed) return
    const trimmed = line.trim()
    if (trimmed === '') return
    let raw: unknown
    try {
      raw = JSON.parse(trimmed)
    } catch {
      this.log(`codex: ignoring non-JSON stdout line: ${truncate(trimmed, 200)}`)
      return
    }
    if (!isRecord(raw)) {
      this.log(`codex: ignoring non-object stdout frame: ${truncate(trimmed, 200)}`)
      return
    }
    const id = raw.id
    if (typeof id === 'number' && typeof raw.method === 'string') {
      // Server -> client request; it carries both `id` and `method`, so it must
      // be distinguished from a response before anything else.
      void this.handleServerRequest(id, raw.method, raw.params)
      return
    }
    if (typeof id === 'number' && ('result' in raw || 'error' in raw)) {
      this.handleResponse(id, raw)
      return
    }
    if (typeof raw.method === 'string') {
      this.handleNotification(raw.method, raw.params)
      return
    }
    this.log(`codex: ignoring unrecognized stdout frame: ${truncate(trimmed, 200)}`)
  }

  private handleResponse(id: number, raw: Record<string, unknown>): void {
    const pending = this.pending.get(id)
    if (pending === undefined) {
      this.log(`codex: response for unknown request id ${String(id)}`)
      return
    }
    clearTimeout(pending.timer)
    this.pending.delete(id)
    const error = raw.error
    if (error !== undefined) {
      if (!isRecord(error)) {
        pending.reject(new CodexRpcError('malformed JSON-RPC error', undefined, error))
        return
      }
      const code = typeof error.code === 'number' || typeof error.code === 'string' ? error.code : undefined
      const message = readString(error, 'message') ?? 'codex app-server error'
      pending.reject(new CodexRpcError(message, code, error.data))
      return
    }
    pending.resolve(raw.result)
  }

  private async handleServerRequest(id: number, method: string, params: unknown): Promise<void> {
    if (this.closed) return
    const controller = new AbortController()
    this.pendingServerRequests.set(id, { method, controller })
    try {
      let decision: NativePermissionDecision = { cancelled: true }
      if (codexServerRequestNeedsPermission(method)) {
        const request = buildCodexPermissionRequest(method, params)
        if (request !== undefined) {
          this.log(`codex: permission request ${method} (${request.requestId})`)
          decision = await this.askPermission(request, controller.signal)
        }
      }
      const answer = answerCodexServerRequest({ method, params, decision })
      if ('result' in answer) this.reply(id, answer.result)
      else this.replyError(id, answer.error.code, answer.error.message)
    } catch (error: unknown) {
      this.log(`codex: failed to answer server request ${method}: ${messageOf(error)}`)
      this.replyError(id, -32603, `DSH failed to answer ${method}: ${messageOf(error)}`)
    } finally {
      this.pendingServerRequests.delete(id)
    }
  }

  private async askPermission(
    request: NativePermissionRequest,
    signal: AbortSignal,
  ): Promise<NativePermissionDecision> {
    const handler = this.options?.onPermission
    if (handler === undefined) return { cancelled: true }
    if (signal.aborted) return { cancelled: true }
    return await new Promise<NativePermissionDecision>((resolve) => {
      let settled = false
      const finish = (decision: NativePermissionDecision): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve(decision)
      }
      const onAbort = (): void => finish({ cancelled: true })
      signal.addEventListener('abort', onAbort, { once: true })
      void handler(request, signal).then(finish, (error: unknown) => {
        this.log(`codex: onPermission handler failed: ${messageOf(error)}`)
        finish({ cancelled: true })
      })
    })
  }

  // -- notifications -------------------------------------------------------

  private notificationThreadId(params: Record<string, unknown> | undefined): string | undefined {
    if (params === undefined) return undefined
    return readString(params, 'threadId') ?? readString(params, 'conversationId')
  }

  private handleNotification(method: string, params: unknown): void {
    if (this.closed) return
    const record = isRecord(params) ? params : undefined
    const notificationThread = this.notificationThreadId(record)
    if (
      notificationThread !== undefined &&
      this.threadId !== undefined &&
      notificationThread !== this.threadId
    ) {
      // Sub-agent threads share the connection; only this conversation maps to
      // the host surface.
      this.log(`codex: ignoring ${method} for thread ${truncate(notificationThread, 64)}`)
      return
    }

    const events = codexNotificationEvents(method, params)
    for (const event of events) {
      if (event.kind === 'tool_call') {
        this.knownToolCalls.add(event.toolCallId)
      } else if (event.kind === 'tool_call_update' && !this.knownToolCalls.has(event.toolCallId)) {
        // `item/completed` can arrive without `item/started` after a resume.
        // Anchor the tool call before updating it so the host can render it.
        this.emit({
          kind: 'tool_call',
          toolCallId: event.toolCallId,
          title: 'Tool call',
          status: 'in_progress',
        })
        this.knownToolCalls.add(event.toolCallId)
      }
      this.emit(event)
    }

    const itemId = record === undefined ? undefined : readString(record, 'itemId')
    switch (method) {
      case 'thread/started': {
        const thread = record?.thread
        const startedThreadId = isRecord(thread) ? readString(thread, 'id') : undefined
        if (this.threadId === undefined && startedThreadId !== undefined) {
          this.threadId = startedThreadId
        }
        return
      }
      case 'turn/started': {
        const turn = record?.turn
        const turnId = isRecord(turn) ? readString(turn, 'id') : undefined
        if (turnId === undefined) return
        this.activeTurnId = turnId
        this.streamedItems.clear()
        this.knownToolCalls.clear()
        this.resolveTurnIdentification(turnId)
        if (this.pendingAbort) {
          this.pendingAbort = false
          void this.sendInterrupt(turnId)
        }
        return
      }
      case 'turn/completed': {
        const turn = record?.turn
        const status = isRecord(turn) ? turn.status : undefined
        const error = isRecord(turn) && isRecord(turn.error) ? turn.error : undefined
        this.activeTurnId = undefined
        this.resolveTurnIdentification(undefined)
        this.streamedItems.clear()
        this.knownToolCalls.clear()
        if (error !== undefined) {
          const message = readString(error, 'message') ?? 'Codex turn failed'
          const details = readString(error, 'additionalDetails')
          this.emit({
            kind: 'notice',
            text: truncate(`Codex turn failed: ${message}${details === undefined ? '' : ` — ${details}`}`, DETAIL_LIMIT),
          })
        }
        this.settlePrompt({ stopReason: codexStopReason(status) })
        return
      }
      case 'item/agentMessage/delta':
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        if (itemId !== undefined) this.streamedItems.add(itemId)
        return
      }
      case 'item/completed': {
        const item = record?.item
        if (!isRecord(item)) return
        const completedItemId = readString(item, 'id')
        if (completedItemId === undefined || this.streamedItems.has(completedItemId)) return
        const type = readString(item, 'type')
        if (type === 'agentMessage') {
          const text = readString(item, 'text')
          if (text !== undefined && text !== '') this.emit({ kind: 'text', text })
        } else if (type === 'reasoning') {
          const summary = Array.isArray(item.summary)
            ? item.summary.filter((part): part is string => typeof part === 'string')
            : []
          const content = Array.isArray(item.content)
            ? item.content.filter((part): part is string => typeof part === 'string')
            : []
          const text = [...summary, ...content].join('\n')
          if (text !== '') this.emit({ kind: 'thought', text })
        }
        return
      }
      case 'thread/tokenUsage/updated': {
        const snapshot = codexUsageFromParams(params)
        if (snapshot !== undefined) {
          this.lastUsage = snapshot.usage
          this.lastContextUsage = snapshot.contextUsage
        }
        return
      }
      case 'serverRequest/resolved': {
        const requestId = record?.requestId
        if (typeof requestId !== 'number') return
        const pending = this.pendingServerRequests.get(requestId)
        if (pending === undefined) return
        this.log(`codex: ${pending.method} was resolved elsewhere; answering with the default`)
        pending.controller.abort()
        return
      }
      default:
        return
    }
  }

  // -- turn identification -------------------------------------------------

  private resolveTurnIdentification(turnId: string | undefined): void {
    const identification = this.turnIdentification
    if (identification === undefined) return
    this.turnIdentification = undefined
    identification.resolve(turnId)
  }

  private async awaitTurnId(timeoutMs: number): Promise<string | undefined> {
    if (this.activeTurnId !== undefined) return this.activeTurnId
    const identification = this.turnIdentification
    if (identification === undefined) return undefined
    return await withTimeout(identification.promise, timeoutMs, undefined)
  }

  // -- prompt settlement ---------------------------------------------------

  private settlePrompt(result: NativePromptResult): void {
    const settlement = this.promptSettlement
    if (settlement === undefined) {
      this.emit({ kind: 'status', busy: false })
      return
    }
    this.promptSettlement = undefined
    this.turnIdentification = undefined
    this.clearAbortTimer()
    this.emit({ kind: 'status', busy: false })
    const usage = result.usage ?? this.lastUsage
    settlement.resolve(usage === undefined ? result : { ...result, usage })
  }

  private settlePromptReject(error: Error): void {
    const settlement = this.promptSettlement
    if (settlement === undefined) return
    this.promptSettlement = undefined
    this.turnIdentification = undefined
    this.clearAbortTimer()
    settlement.reject(error)
  }

  private clearAbortTimer(): void {
    if (this.abortTimer !== undefined) {
      clearTimeout(this.abortTimer)
      this.abortTimer = undefined
    }
  }

  private requestAbort(): void {
    const turnId = this.activeTurnId
    if (turnId === undefined) {
      // turn/start is still in flight: interrupt as soon as turn/started (or
      // the turn/start response) reveals the native turn id.
      this.pendingAbort = true
      return
    }
    void this.sendInterrupt(turnId)
  }

  private async sendInterrupt(turnId: string): Promise<void> {
    const threadId = this.threadId
    if (threadId === undefined) return
    if (this.abortTimer === undefined) {
      this.abortTimer = setTimeout(() => {
        this.abortTimer = undefined
        this.log('codex: turn did not settle after interrupt; reporting cancelled')
        this.settlePrompt({ stopReason: 'cancelled' })
      }, ABORT_SETTLE_FALLBACK_MS)
      this.abortTimer.unref?.()
    }
    try {
      await this.request('turn/interrupt', { threadId, turnId }, INTERRUPT_TIMEOUT_MS)
    } catch (error: unknown) {
      if (isAlreadyIdleInterrupt(error)) {
        this.settlePrompt({ stopReason: 'cancelled' })
        return
      }
      this.log(`codex: turn/interrupt failed: ${messageOf(error)}`)
    }
  }

  // -- NativeTransport surface --------------------------------------------

  async prompt(
    content: readonly NativeContentBlock[],
    signal: AbortSignal,
  ): Promise<NativePromptResult> {
    if (this.closed) throw new NativeTransportError('Codex transport is closed', 'closed')
    if (this.exitError !== undefined) throw this.exitError
    const threadId = this.threadId
    if (threadId === undefined) throw new NativeTransportError('Codex transport was not started', 'not_started')
    if (this.promptActive) {
      throw new NativeTransportError('A Codex prompt is already in progress', 'busy')
    }
    if (signal.aborted) return { stopReason: 'cancelled' }
    this.promptActive = true
    try {
      return await this.promptInternal(content, signal)
    } finally {
      this.promptActive = false
    }
  }

  private async promptInternal(
    content: readonly NativeContentBlock[],
    signal: AbortSignal,
  ): Promise<NativePromptResult> {
    const threadId = this.threadId
    if (threadId === undefined) throw new NativeTransportError('Codex transport was not started', 'not_started')
    const input = await this.buildUserInput(content)
    let resolveSettlement!: (result: NativePromptResult) => void
    let rejectSettlement!: (error: Error) => void
    const settled = new Promise<NativePromptResult>((resolve, reject) => {
      resolveSettlement = resolve
      rejectSettlement = reject
    })
    this.promptSettlement = { resolve: resolveSettlement, reject: rejectSettlement }
    // `settled` is awaited after turn/start resolves; if the transport fails
    // first the rejection must not surface as an unhandled rejection.
    void settled.catch(() => undefined)
    this.turnIdentification = deferred<string | undefined>()
    this.pendingAbort = false
    this.abortTimer = undefined
    this.streamedItems.clear()
    this.knownToolCalls.clear()
    this.emit({ kind: 'status', busy: true })

    const onAbort = (): void => {
      this.requestAbort()
    }
    signal.addEventListener('abort', onAbort, { once: true })

    try {
      const response = await this.request(
        'turn/start',
        { threadId, input },
        REQUEST_TIMEOUT_MS,
      )
      const turn = isRecord(response) ? response.turn : undefined
      const turnId = isRecord(turn) ? readString(turn, 'id') : undefined
      if (turnId !== undefined && this.activeTurnId === undefined) {
        // 0.162.1 returns the turn object synchronously; older builds only
        // reveal it via turn/started. Accept both without losing the race.
        this.activeTurnId = turnId
        this.resolveTurnIdentification(turnId)
        if (this.pendingAbort) {
          this.pendingAbort = false
          void this.sendInterrupt(turnId)
        }
      }
      const result = await settled
      return result
    } catch (error: unknown) {
      if (signal.aborted) {
        this.settlePrompt({ stopReason: 'cancelled' })
        return { stopReason: 'cancelled' }
      }
      this.settlePromptReject(error instanceof Error ? error : new Error(String(error)))
      throw error instanceof NativeTransportError
        ? error
        : new NativeTransportError(
            `Codex turn/start failed: ${messageOf(error)}`,
            'turn_start_failed',
            error instanceof CodexRpcError ? truncate(JSON.stringify(error.data) ?? '', DETAIL_LIMIT) : undefined,
          )
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  async steer(
    content: readonly NativeContentBlock[],
    signal?: AbortSignal,
  ): Promise<'injected' | 'promptRequired'> {
    if (this.closed) return 'promptRequired'
    if (signal?.aborted === true) return 'promptRequired'
    const threadId = this.threadId
    if (threadId === undefined) return 'promptRequired'
    const textContent = content.filter((block) => block.type === 'text')
    if (textContent.length === 0) return 'promptRequired'
    // The steer target must be the *currently active* turn; wait for the
    // turn/started gap instead of declaring defeat.
    const initialTurnId = await this.awaitTurnId(TURN_ID_WAIT_MS)
    if (initialTurnId === undefined) return 'promptRequired'
    const input = this.textInput(content)
    const steerWith = (turnId: string): Promise<unknown> =>
      this.request(
        'turn/steer',
        {
          threadId,
          expectedTurnId: turnId,
          input,
          clientUserMessageId: `dsh-steer-${randomUUID()}`,
        },
        REQUEST_TIMEOUT_MS,
      )
    try {
      const response = await steerWith(initialTurnId)
      const acknowledged = isRecord(response) ? readString(response, 'turnId') : undefined
      if (acknowledged !== undefined && acknowledged !== initialTurnId) {
        throw new NativeTransportError(
          'codex app-server acknowledged turn/steer for a different turn',
          'protocol_error',
        )
      }
      return 'injected'
    } catch (error: unknown) {
      if (!isDefinitiveSteerRejection(error)) throw error
      // A newer turn may have started while the request was in flight: retry
      // exactly once against it before falling back to a fresh prompt.
      const refreshed = this.activeTurnId
      if (refreshed === undefined || refreshed === initialTurnId) return 'promptRequired'
      try {
        await steerWith(refreshed)
        return 'injected'
      } catch (retryError: unknown) {
        if (isDefinitiveSteerRejection(retryError)) return 'promptRequired'
        throw retryError
      }
    }
  }

  async interrupt(): Promise<void> {
    if (this.closed) return
    const turnId = this.activeTurnId ?? (await this.awaitTurnId(TURN_ID_WAIT_MS))
    if (turnId === undefined) return
    await this.sendInterrupt(turnId)
  }

  contextUsage(): NativeContextUsage | undefined {
    return this.lastContextUsage
  }

  async close(): Promise<void> {
    if (this.closePromise !== undefined) return await this.closePromise
    this.closePromise = this.closeInternal()
    return await this.closePromise
  }

  private async closeInternal(): Promise<void> {
    this.closed = true
    this.emit({ kind: 'status', busy: false })
    this.settlePromptReject(new NativeTransportError('Codex transport closed', 'closed'))
    for (const pending of this.pendingServerRequests.values()) pending.controller.abort()
    this.pendingServerRequests.clear()
    this.rejectPending(new NativeTransportError('Codex transport closed', 'closed'))
    await this.terminateChild()
    this.readline?.close()
    this.readline = undefined
    this.child = undefined
    await Promise.all(
      [...this.tempDirs].map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)),
    )
    this.tempDirs.clear()
  }

  private async terminateChild(): Promise<void> {
    const child = this.child
    if (child === undefined) return
    const alreadyExited = child.exitCode !== null || child.signalCode !== null
    if (alreadyExited) return
    const exitPromise = new Promise<boolean>((resolve) => {
      child.once('exit', () => resolve(true))
    })
    try {
      child.stdin.end()
    } catch {
      // The pipe may already be gone.
    }
    this.signalChild(child, 'SIGTERM')
    if (await withTimeout(exitPromise, CLOSE_SIGTERM_MS, false)) return
    this.log('codex: app-server ignored SIGTERM; sending SIGKILL')
    this.signalChild(child, 'SIGKILL')
    await withTimeout(exitPromise, CLOSE_SIGKILL_MS, false)
  }

  private signalChild(child: ChildProcessWithoutNullStreams, signal: 'SIGTERM' | 'SIGKILL'): void {
    const pid = child.pid
    if (pid === undefined) return
    if (this.detached) {
      try {
        // Negative pid targets the process group so Codex's own shell children
        // die too.
        process.kill(-pid, signal)
        return
      } catch {
        // Fall through to a direct child kill.
      }
    }
    try {
      child.kill(signal)
    } catch (error: unknown) {
      this.log(`codex: failed to send ${signal}: ${messageOf(error)}`)
    }
  }

  // -- user input ----------------------------------------------------------

  /** Text-only reduction used by steer (images cannot be injected mid-turn cheaply). */
  private textInput(content: readonly NativeContentBlock[]): unknown[] {
    return content
      .filter((block): block is Extract<NativeContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => ({ type: 'text', text: block.text, text_elements: [] }))
  }

  private async buildUserInput(content: readonly NativeContentBlock[]): Promise<unknown[]> {
    if (content.length === 0) {
      throw new NativeTransportError('prompt content must not be empty', 'empty_prompt')
    }
    const input: unknown[] = []
    for (const block of content) {
      if (block.type === 'text') {
        input.push({ type: 'text', text: block.text, text_elements: [] })
        continue
      }
      try {
        const path = await this.materializeImage(block)
        input.push({ type: 'localImage', path })
      } catch (error: unknown) {
        this.log(`codex: failed to attach image: ${messageOf(error)}`)
        input.push({
          type: 'text',
          text: `[image attachment could not be written: ${messageOf(error)}]`,
          text_elements: [],
        })
      }
    }
    if (input.length === 0) {
      throw new NativeTransportError('prompt content must not be empty', 'empty_prompt')
    }
    return input
  }

  /**
   * Codex 0.162.1 accepts inline data URLs for images, but the reference
   * implementation materializes a temp file and sends `localImage`; do the
   * same so the frame shape stays compatible with older app-servers.
   */
  private async materializeImage(block: Extract<NativeContentBlock, { type: 'image' }>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-codex-image-'))
    this.tempDirs.add(dir)
    const extension = imageExtension(block.mimeType)
    const path = join(dir, `image-${randomUUID()}.${extension}`)
    await writeFile(path, Buffer.from(block.data, 'base64'))
    return path
  }
}

function imageExtension(mimeType: string): string {
  switch (mimeType) {
    case 'image/png':
      return 'png'
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg'
    case 'image/gif':
      return 'gif'
    case 'image/webp':
      return 'webp'
    default:
      return 'png'
  }
}

function isArchivedThreadError(error: unknown): boolean {
  return error instanceof CodexRpcError && error.code === -32600 && /archived/i.test(error.message)
}

/** Create one Codex transport. See the module comment for the protocol surface. */
export function createCodexTransport(): NativeTransport {
  return new CodexAppServerTransport()
}
