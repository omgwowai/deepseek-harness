/**
 * Claude Code native transport — the `claude` CLI in stream-json mode.
 *
 * Verified against claude 2.1.296 (and `@anthropic-ai/claude-agent-sdk@0.3.246`
 * type declarations, which this file intentionally does not depend on).
 * Probe transcripts: `.scratch/dsh-native-agents-20261026/codex-claude-protocol/probe/`.
 *
 * Lifecycle:
 *   spawn(command, [...args, PROTOCOL_FLAGS])            // no handshake exists
 *     -> <stdin>  {"type":"user","message":{...},...}    // one JSON line per user message
 *     -> <stdout> system/init | stream_event | assistant | user | result | control_request
 *
 * Wire facts this transport relies on (all measured, not inferred):
 *
 *  - `--print --input-format stream-json --output-format stream-json --verbose`
 *    is the only mode that keeps the process alive across turns, which is what
 *    makes steering possible at all. One `result` frame settles one turn.
 *  - `--permission-prompt-tool stdio` makes the CLI route permission prompts to
 *    the host as `control_request{subtype:"can_use_tool"}`; the host answers
 *    with `control_response{response:{subtype:"success",request_id,response}}`
 *    where `response` is a Claude `PermissionResult`
 *    (`{behavior:'allow',...}` / `{behavior:'deny',...}`). Without the flag the
 *    CLI never asks and silently applies its own policy.
 *  - Mid-turn steering is a *client-side* injection: write another user message
 *    with `priority:"next"` while a turn runs. The CLI folds it into the running
 *    turn at the next tool boundary (measured: one `result` frame, the in-flight
 *    shell call completes normally). `priority:"now"` preempts the turn and
 *    `priority:"later"` queues a following turn; DSH only uses `next`.
 *  - `control_request{subtype:"interrupt"}` answers with a receipt
 *    `{still_queued:[uuid], cancelled:[uuid]}`. Message uuids are ours, so
 *    `still_queued` entries we sent are withdrawn with
 *    `control_request{subtype:"cancel_async_message",message_uuid}`. CLIs
 *    advertising `interrupt_cancel_queued_v1` do it in one round trip via
 *    `{cancel_queued:true}`.
 *  - Turn usage must be read from `result.modelUsage` (cumulative, per model,
 *    carries `costUSD` + `contextWindow`), not from `result.usage` (main-loop
 *    only, per turn). `reasoning` comes from `modelUsage.*.thinkingTokens`.
 *  - `system/init` is NOT emitted at spawn time; it arrives with the first user
 *    message. `start()` therefore treats "process spawned and still alive" as
 *    the ready point, and learns `sessionId` from the first `init`/`result`.
 *
 * Dependency-free apart from node builtins, by contract.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
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

/** Raised when the CLI reports a protocol/API failure we cannot normalize. */
const INIT_GRACE_MS = 300
const CONTROL_TIMEOUT_MS = 15_000
const INTERRUPT_TIMEOUT_MS = 15_000
const CLOSE_SIGTERM_MS = 2_000
const CLOSE_SIGKILL_MS = 1_000
/** If the CLI drops the interrupted turn's `result`, keep the host from hanging. */
const INTERRUPT_SETTLE_FALLBACK_MS = 10_000
const STDERR_LIMIT = 8_192
const DETAIL_LIMIT = 2_000

/**
 * Protocol flags this transport owns. Callers pass `command`/`args` for model,
 * permission-mode and host configuration; these five are the transport's.
 * `--permission-prompt-tool stdio` is added only when the caller has not
 * chosen its own permission routing.
 */
const PROTOCOL_FLAGS: readonly (readonly string[])[] = [
  ['--print'],
  ['--input-format', 'stream-json'],
  ['--output-format', 'stream-json'],
  ['--verbose'],
  ['--include-partial-messages'],
]

const PERMISSION_HOST_FLAG = '--permission-prompt-tool'
const PERMISSION_HOST_VALUE = 'stdio'

/** Message priorities the CLI understands. DSH only steers with `next`. */
export type ClaudeMessagePriority = 'now' | 'next' | 'later'

// ---------------------------------------------------------------------------
// Small helpers (kept local: this transport must stay dependency-free)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function readString(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key]
  return typeof value === 'string' ? value : undefined
}

function readNumber(source: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = source?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readStringArray(source: Record<string, unknown> | undefined, key: string): string[] {
  const value = source?.[key]
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function hasFlag(args: readonly string[], flag: string): boolean {
  const aliases = FLAG_ALIASES[flag] ?? [flag]
  return args.some((arg) => aliases.some((alias) => arg === alias || arg.startsWith(`${alias}=`)))
}

/** Flags with a short form the host may already have used. */
const FLAG_ALIASES: Readonly<Record<string, readonly string[]>> = {
  '--print': ['--print', '-p'],
  '--continue': ['--continue', '-c'],
}

// ---------------------------------------------------------------------------
// Pure protocol helpers (exported for the test suite)
// ---------------------------------------------------------------------------

/**
 * Build the argv for the CLI: caller args first, then the protocol flags the
 * transport owns. Flags are de-duplicated so a host that already passes
 * `--output-format` is not punished with a double-flag error.
 *
 * `resumeSessionId` becomes `--resume=<id>`; an explicit `--continue` /
 * `--resume` / `--fork-session` from the host wins over it.
 */
export function buildClaudeArgs(
  args: readonly string[],
  options?: { readonly resumeSessionId?: string | undefined },
): string[] {
  const result = [...args]
  for (const group of PROTOCOL_FLAGS) {
    // Judge presence by the flag token only: `stream-json` is a *value* and
    // must not be mistaken for a flag that is already there.
    const flag = group[0]
    if (flag !== undefined && !hasFlag(result, flag)) result.push(...group)
  }
  if (!hasFlag(result, PERMISSION_HOST_FLAG)) {
    result.push(PERMISSION_HOST_FLAG, PERMISSION_HOST_VALUE)
  }
  const resumeSessionId = options?.resumeSessionId
  const hostAlreadyControlsSession =
    hasFlag(result, '--resume') || hasFlag(result, '-r') || hasFlag(result, '--continue') || hasFlag(result, '-c')
  if (resumeSessionId !== undefined && resumeSessionId !== '' && !hostAlreadyControlsSession) {
    result.push(`--resume=${resumeSessionId}`)
  }
  return result
}

/** One `<stdin>` line: the CLI's stream-json user message. */
export function claudeUserMessageFrame(input: {
  readonly blocks: readonly NativeContentBlock[]
  readonly sessionId?: string | undefined
  readonly priority?: ClaudeMessagePriority | undefined
  readonly uuid?: string | undefined
}): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = []
  for (const block of input.blocks) {
    if (block.type === 'text') {
      content.push({ type: 'text', text: block.text })
    } else {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: block.mimeType, data: block.data },
      })
    }
  }
  const frame: Record<string, unknown> = {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    session_id: input.sessionId ?? '',
    uuid: input.uuid ?? randomUUID(),
  }
  if (input.priority !== undefined) frame.priority = input.priority
  return frame
}

/** `control_response{response.response}` payload for a `can_use_tool` ask. */
export function claudePermissionResponsePayload(input: {
  readonly request: Record<string, unknown>
  readonly decision: NativePermissionDecision
  readonly suggestions?: readonly unknown[] | undefined
}): Record<string, unknown> {
  const toolUseId = readString(input.request, 'tool_use_id')
  const toolUseField = toolUseId === undefined ? {} : { toolUseID: toolUseId }
  const decision = input.decision
  if ('cancelled' in decision) {
    return { behavior: 'deny', message: 'Cancelled by DSH host.', interrupt: true, ...toolUseField }
  }
  if (decision.optionId === 'allow' || decision.optionId === 'allow_always') {
    const input0 = recordOf(input.request.input)
    const allow: Record<string, unknown> = {
      behavior: 'allow',
      ...(input0 === undefined ? {} : { updatedInput: input0 }),
      ...toolUseField,
    }
    // `permission_suggestions` are Claude `PermissionUpdate` values; echoing
    // them back is what the SDK does for an "always allow" answer.
    const suggestions = input.suggestions
    if (decision.optionId === 'allow_always' && suggestions !== undefined && suggestions.length > 0) {
      allow.updatedPermissions = [...suggestions]
    }
    return allow
  }
  const stop = decision.optionId === 'reject_stop'
  return {
    behavior: 'deny',
    message: stop ? 'Rejected by user; stop the turn.' : 'Rejected by user.',
    ...(stop ? { interrupt: true } : {}),
    ...toolUseField,
  }
}

/** Normalized permission prompt for one `can_use_tool` control request. */
export function claudePermissionRequest(
  controlRequestId: string,
  request: Record<string, unknown>,
): NativePermissionRequest {
  const toolName = readString(request, 'tool_name') ?? 'tool'
  const displayName = readString(request, 'display_name') ?? toolName
  const description = readString(request, 'description')
  const decisionReason = readString(request, 'decision_reason')
  const suggestions = Array.isArray(request.permission_suggestions) ? request.permission_suggestions : undefined
  const suppressAlways = request.suppress_always_allow_rule === true
  const options: NativePermissionRequest['options'][number][] = [
    { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
  ]
  if (suggestions !== undefined && suggestions.length > 0 && !suppressAlways) {
    options.push({ optionId: 'allow_always', name: 'Allow for this session', kind: 'allow_always' })
  }
  options.push({ optionId: 'reject', name: 'Reject', kind: 'reject_once' })
  options.push({ optionId: 'reject_stop', name: 'Reject and stop the turn', kind: 'reject_always' })
  const detailParts: string[] = []
  if (description !== undefined && description !== '') detailParts.push(description)
  else if (decisionReason !== undefined && decisionReason !== '') detailParts.push(decisionReason)
  else {
    const input0 = recordOf(request.input)
    if (input0 !== undefined) detailParts.push(truncate(JSON.stringify(input0), DETAIL_LIMIT))
  }
  return {
    requestId: controlRequestId,
    title: `${displayName} permission`,
    ...(detailParts.length > 0 ? { detail: detailParts.join(' — ') } : {}),
    options,
  }
}

/** Flatten a tool_result `content` value (string | blocks) into display text. */
export function claudeToolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (!isRecord(block)) continue
    if (typeof block.text === 'string' && block.text !== '') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * `result` -> contract stop reason.
 *
 * Claude's `error_during_execution` has no exact ACP peer; like the Codex
 * transport's `failed`, it is reported as `refusal` and the vendor error text
 * is surfaced separately. A turn killed by `interrupt()` is always `cancelled`.
 */
export function claudeStopReason(
  frame: Record<string, unknown>,
  options: { readonly interrupted: boolean },
): NativePromptResult['stopReason'] {
  if (options.interrupted) return 'cancelled'
  const subtype = readString(frame, 'subtype')
  if (subtype === 'success') {
    const reason = readString(frame, 'stop_reason')
    if (reason === 'max_tokens') return 'max_tokens'
    if (reason === 'refusal') return 'refusal'
    return 'end_turn'
  }
  if (subtype === 'error_max_turns') return 'max_tokens'
  const errors = readStringArray(frame, 'errors').join(' ')
  if (/\b(abort|interrupt|cancel)/i.test(errors)) return 'cancelled'
  return 'refusal'
}

/** Vendor error text for a result frame, when it represents a hard failure. */
export function claudeResultError(frame: Record<string, unknown>): string | undefined {
  const subtype = readString(frame, 'subtype')
  if (subtype === 'success' || subtype === 'error_max_turns') return undefined
  const errors = readStringArray(frame, 'errors')
  if (errors.length > 0) return errors.join('\n')
  const result = readString(frame, 'result')
  if (result !== undefined && result.trim() !== '') return result
  return subtype === undefined ? undefined : `Claude turn ended with ${subtype}`
}

/** Cumulative token totals parsed out of `result.modelUsage`, else `result.usage`. */
export interface ClaudeUsageTotals {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly reasoning: number
  readonly costUsd: number
  readonly contextWindow?: number | undefined
}

/** Sum per-model usage. `modelUsage` is cumulative across the whole query. */
export function claudeUsageTotals(frame: Record<string, unknown>): ClaudeUsageTotals | undefined {
  const modelUsage = recordOf(frame.modelUsage)
  if (modelUsage !== undefined) {
    let input = 0
    let output = 0
    let cacheRead = 0
    let cacheWrite = 0
    let reasoning = 0
    let costUsd = 0
    let contextWindow: number | undefined
    let sawEntry = false
    for (const entry of Object.values(modelUsage)) {
      if (!isRecord(entry)) continue
      sawEntry = true
      input += readNumber(entry, 'inputTokens') ?? 0
      output += readNumber(entry, 'outputTokens') ?? 0
      cacheRead += readNumber(entry, 'cacheReadInputTokens') ?? 0
      cacheWrite += readNumber(entry, 'cacheCreationInputTokens') ?? 0
      reasoning += readNumber(entry, 'thinkingTokens') ?? 0
      costUsd += readNumber(entry, 'costUSD') ?? 0
      const window = readNumber(entry, 'contextWindow')
      if (window !== undefined && (contextWindow === undefined || window > contextWindow)) {
        contextWindow = window
      }
    }
    if (sawEntry) {
      if (costUsd === 0) costUsd = readNumber(frame, 'total_cost_usd') ?? 0
      return {
        input,
        output,
        cacheRead,
        cacheWrite,
        reasoning,
        costUsd,
        ...(contextWindow === undefined ? {} : { contextWindow }),
      }
    }
  }
  const usage = recordOf(frame.usage)
  if (usage === undefined) return undefined
  return {
    input: readNumber(usage, 'input_tokens') ?? 0,
    output: readNumber(usage, 'output_tokens') ?? 0,
    cacheRead: readNumber(usage, 'cache_read_input_tokens') ?? 0,
    cacheWrite: readNumber(usage, 'cache_creation_input_tokens') ?? 0,
    reasoning: readNumber(recordOf(usage.output_tokens_details), 'thinking_tokens') ?? 0,
    costUsd: readNumber(frame, 'total_cost_usd') ?? 0,
  }
}

/** Turn-scoped usage = current cumulative totals minus the previous turn's. */
export function claudeUsageDelta(
  current: ClaudeUsageTotals,
  previous: ClaudeUsageTotals | undefined,
): NativeUsage {
  const delta = (value: number, prior: number): number => Math.max(0, value - prior)
  const input = delta(current.input, previous?.input ?? 0)
  const output = delta(current.output, previous?.output ?? 0)
  const cacheRead = delta(current.cacheRead, previous?.cacheRead ?? 0)
  const cacheWrite = delta(current.cacheWrite, previous?.cacheWrite ?? 0)
  const reasoning = delta(current.reasoning, previous?.reasoning ?? 0)
  const costAmount = delta(current.costUsd, previous?.costUsd ?? 0)
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
    reasoning,
    ...(costAmount > 0
      ? { cost: { amount: Number(costAmount.toFixed(6)), currency: 'USD' } }
      : {}),
  }
}

/** Context occupancy of one request, from an Anthropic `usage` block. */
export function claudeContextUsed(usage: Record<string, unknown> | undefined): number | undefined {
  if (usage === undefined) return undefined
  const input = readNumber(usage, 'input_tokens') ?? 0
  const cacheRead = readNumber(usage, 'cache_read_input_tokens') ?? 0
  const cacheWrite = readNumber(usage, 'cache_creation_input_tokens') ?? 0
  const used = input + cacheRead + cacheWrite
  return used > 0 ? used : undefined
}

// ---------------------------------------------------------------------------
// Frame mapper: stream-json frames -> contract timeline events
// ---------------------------------------------------------------------------

interface BlockState {
  readonly type: string
  readonly name: string
  readonly toolCallId: string
  json: string
}

/**
 * Maps one turn's stream-json frames onto `NativeTransportEvent`s.
 *
 * Text/thinking deltas are emitted from `stream_event` frames (the transport
 * always enables `--include-partial-messages`); the completed `assistant`
 * frame is a *fallback* — its text blocks are skipped when that message already
 * streamed, so the host never sees duplicated prose. Tool calls are emitted
 * once, at `content_block_stop`, so `rawInput` is complete; `assistant` tool
 * blocks are then deduplicated by `tool_use` id.
 *
 * Subagent sidechain frames (`parent_tool_use_id !== null`) contribute tool
 * rows but not text: their prose is not the main answer and the contract has no
 * sidechain dimension.
 */
export class ClaudeFrameMapper {
  private currentMessageId: string | undefined
  private readonly streamedTextMessages = new Set<string>()
  private readonly streamedThinkingMessages = new Set<string>()
  private readonly blocks = new Map<number, BlockState>()
  private readonly emittedToolCalls = new Set<string>()
  private readonly openToolCalls = new Map<string, string>()
  private contextWindowSize: number | undefined
  private interrupted = false
  private lastContextUsedTokens: number | undefined

  /** Context window size, learned from `result.modelUsage.*.contextWindow`. */
  noteContextWindow(size: number | undefined): void {
    if (size !== undefined && size > 0) this.contextWindowSize = size
  }

  /** Marks subsequent tool results as cancelled rather than failed. */
  noteInterrupted(interrupted: boolean): void {
    this.interrupted = interrupted
  }

  get lastContextUsed(): number | undefined {
    return this.lastContextUsedTokens
  }

  resetTurn(): void {
    this.currentMessageId = undefined
    this.streamedTextMessages.clear()
    this.streamedThinkingMessages.clear()
    this.blocks.clear()
    this.emittedToolCalls.clear()
    this.openToolCalls.clear()
    this.interrupted = false
  }

  /** Maps one stdout frame. Unknown frames are ignored by design. */
  map(frame: Record<string, unknown>): NativeTransportEvent[] {
    switch (frame.type) {
      case 'stream_event':
        return this.mapStreamEvent(recordOf(frame.event))
      case 'assistant':
        return this.mapAssistant(frame)
      case 'user':
        return this.mapToolResults(frame)
      default:
        return []
    }
  }

  /** Closes tool calls still open when the turn ends (abort, crash, max turns). */
  settle(): NativeTransportEvent[] {
    const events: NativeTransportEvent[] = []
    const status: NativeToolCallStatus = this.interrupted ? 'cancelled' : 'failed'
    for (const toolCallId of this.openToolCalls.keys()) {
      events.push({ kind: 'tool_call_update', toolCallId, status })
    }
    this.openToolCalls.clear()
    return events
  }

  private mapStreamEvent(event: Record<string, unknown> | undefined): NativeTransportEvent[] {
    if (event === undefined) return []
    const type = readString(event, 'type')
    switch (type) {
      case 'message_start': {
        const message = recordOf(event.message)
        this.currentMessageId = readString(message, 'id')
        this.blocks.clear()
        const used = claudeContextUsed(recordOf(message?.usage))
        if (used !== undefined) {
          this.lastContextUsedTokens = used
          const size = this.contextWindowSize
          if (size !== undefined) {
            return [{ kind: 'context_usage', contextUsage: { used, size } }]
          }
        }
        return []
      }
      case 'content_block_start': {
        const index = readNumber(event, 'index')
        const block = recordOf(event.content_block)
        if (index === undefined || block === undefined) return []
        const blockType = readString(block, 'type') ?? 'unknown'
        if (blockType === 'tool_use') {
          const toolCallId = readString(block, 'id') ?? `claude-tool-${String(index)}`
          this.blocks.set(index, {
            type: blockType,
            name: readString(block, 'name') ?? 'tool',
            toolCallId,
            json: '',
          })
        } else {
          this.blocks.set(index, { type: blockType, name: '', toolCallId: '', json: '' })
        }
        return []
      }
      case 'content_block_delta': {
        const delta = recordOf(event.delta)
        if (delta === undefined) return []
        const deltaType = readString(delta, 'type')
        if (deltaType === 'text_delta') {
          const text = readString(delta, 'text')
          if (text === undefined || text === '') return []
          if (this.currentMessageId !== undefined) {
            this.streamedTextMessages.add(this.currentMessageId)
          }
          return [{ kind: 'text', text }]
        }
        if (deltaType === 'thinking_delta') {
          const thinking = readString(delta, 'thinking')
          if (thinking === undefined || thinking === '') return []
          if (this.currentMessageId !== undefined) {
            this.streamedThinkingMessages.add(this.currentMessageId)
          }
          return [{ kind: 'thought', text: thinking }]
        }
        if (deltaType === 'input_json_delta') {
          const index = readNumber(event, 'index')
          const partial = readString(delta, 'partial_json')
          if (index === undefined || partial === undefined) return []
          const block = this.blocks.get(index)
          if (block !== undefined) block.json += partial
        }
        return []
      }
      case 'content_block_stop': {
        const index = readNumber(event, 'index')
        if (index === undefined) return []
        const block = this.blocks.get(index)
        if (block === undefined || block.type !== 'tool_use') {
          this.blocks.delete(index)
          return []
        }
        this.blocks.delete(index)
        if (this.emittedToolCalls.has(block.toolCallId)) return []
        this.emittedToolCalls.add(block.toolCallId)
        this.openToolCalls.set(block.toolCallId, block.name)
        const rawInput = parseToolInput(block.json)
        return [
          {
            kind: 'tool_call',
            toolCallId: block.toolCallId,
            title: block.name,
            status: 'in_progress',
            ...(rawInput === undefined ? {} : { rawInput }),
          },
        ]
      }
      default:
        return []
    }
  }

  private mapAssistant(frame: Record<string, unknown>): NativeTransportEvent[] {
    const message = recordOf(frame.message)
    if (message === undefined) return []
    const messageId = readString(message, 'id')
    const sidechain = readString(frame, 'parent_tool_use_id') !== undefined
    const content = Array.isArray(message.content) ? message.content : []
    const wireToolInputs = recordOf(frame.wire_tool_inputs)
    const events: NativeTransportEvent[] = []
    for (const rawBlock of content) {
      const block = recordOf(rawBlock)
      if (block === undefined) continue
      const blockType = readString(block, 'type')
      if (blockType === 'text') {
        if (sidechain) continue
        const text = readString(block, 'text')
        if (text === undefined || text === '') continue
        if (messageId !== undefined && this.streamedTextMessages.has(messageId)) continue
        events.push({ kind: 'text', text })
        continue
      }
      if (blockType === 'thinking') {
        if (sidechain) continue
        const thinking = readString(block, 'thinking')
        if (thinking === undefined || thinking === '') continue
        if (messageId !== undefined && this.streamedThinkingMessages.has(messageId)) continue
        events.push({ kind: 'thought', text: thinking })
        continue
      }
      if (blockType !== 'tool_use') continue
      const toolCallId = readString(block, 'id')
      if (toolCallId === undefined || this.emittedToolCalls.has(toolCallId)) continue
      this.emittedToolCalls.add(toolCallId)
      const name = readString(block, 'name') ?? 'tool'
      this.openToolCalls.set(toolCallId, name)
      const fromWire = recordOf(wireToolInputs?.[toolCallId])
      const rawInput = fromWire ?? recordOf(block.input)
      events.push({
        kind: 'tool_call',
        toolCallId,
        title: name,
        status: 'in_progress',
        ...(rawInput === undefined ? {} : { rawInput }),
      })
    }
    return events
  }

  private mapToolResults(frame: Record<string, unknown>): NativeTransportEvent[] {
    const message = recordOf(frame.message)
    const content = Array.isArray(message?.content) ? message.content : []
    const events: NativeTransportEvent[] = []
    for (const rawBlock of content) {
      const block = recordOf(rawBlock)
      if (block === undefined || readString(block, 'type') !== 'tool_result') continue
      const toolCallId = readString(block, 'tool_use_id')
      if (toolCallId === undefined) continue
      this.openToolCalls.delete(toolCallId)
      const isError = block.is_error === true
      const status: NativeToolCallStatus = isError ? (this.interrupted ? 'cancelled' : 'failed') : 'completed'
      const contentText = claudeToolResultText(block.content)
      events.push({
        kind: 'tool_call_update',
        toolCallId,
        status,
        ...(contentText === '' ? {} : { contentText: truncate(contentText, DETAIL_LIMIT) }),
      })
    }
    return events
  }
}

function parseToolInput(json: string): unknown {
  if (json.trim() === '') return undefined
  try {
    return JSON.parse(json) as unknown
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

interface PromptSettlement {
  readonly resolve: (result: NativePromptResult) => void
  readonly reject: (error: Error) => void
}

interface PendingControl {
  readonly deferred: Deferred<Record<string, unknown> | undefined>
}

/**
 * One `claude` CLI process speaking stream-json. Not reusable after `close()`.
 *
 * @internal exported so the test suite can exercise the protocol machinery.
 */
export class ClaudeCliTransport implements NativeTransport {
  readonly kind: NativeTransportKind = 'claude'

  private options: NativeTransportStartOptions | undefined
  private child: ChildProcessWithoutNullStreams | undefined
  private readline: ReturnType<typeof createInterface> | undefined
  private detached = false
  private stderr = ''
  private exitError: NativeTransportError | undefined

  private sessionIdValue: string | undefined
  private readonly capabilities = new Set<string>()
  private readonly mapper = new ClaudeFrameMapper()

  private promptSettlement: PromptSettlement | undefined
  private activeTurnUuid: string | undefined
  private interruptRequested = false
  private interruptInFlight: Promise<void> | undefined
  private interruptFallbackTimer: ReturnType<typeof setTimeout> | undefined
  /** uuids of messages this transport injected into a running turn. */
  private readonly injectedTurnUuids = new Set<string>()
  private readonly pendingControls = new Map<string, PendingControl>()
  private readonly permissionControllers = new Set<AbortController>()

  private lastUsageTotals: ClaudeUsageTotals | undefined
  private lastContextUsage: NativeContextUsage | undefined

  private startPromise: Promise<void> | undefined
  private closePromise: Promise<void> | undefined
  private closed = false

  get sessionId(): string | undefined {
    return this.sessionIdValue
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
      this.log(`claude: onEvent handler threw: ${messageOf(error)}`)
    }
  }

  private emitAll(events: readonly NativeTransportEvent[]): void {
    for (const event of events) this.emit(event)
  }

  // -- lifecycle -----------------------------------------------------------

  async start(options: NativeTransportStartOptions): Promise<void> {
    if (this.startPromise !== undefined) return await this.startPromise
    this.startPromise = this.startInternal(options)
    return await this.startPromise
  }

  private async startInternal(options: NativeTransportStartOptions): Promise<void> {
    if (this.closed) throw new NativeTransportError('Claude transport is closed', 'closed')
    this.options = options
    if (options.resumeSessionId !== undefined && options.resumeSessionId !== '') {
      this.sessionIdValue = options.resumeSessionId
    }
    try {
      await this.spawnProcess(options)
    } catch (error: unknown) {
      await this.close().catch(() => undefined)
      if (error instanceof NativeTransportError) throw error
      throw new NativeTransportError(
        `Failed to start claude CLI: ${messageOf(error)}`,
        'claude_start_failed',
        this.stderrTail(),
      )
    }
  }

  private async spawnProcess(options: NativeTransportStartOptions): Promise<void> {
    const args = buildClaudeArgs(options.args, { resumeSessionId: options.resumeSessionId })
    const detached = process.platform !== 'win32'
    const child = spawn(options.command, args, {
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
      this.log(`claude: stdin error: ${messageOf(error)}`)
    })
    child.on('error', (error: Error) => {
      this.handleProcessFailure(
        new NativeTransportError(`claude CLI failed: ${messageOf(error)}`, 'process_error'),
      )
    })
    child.on('exit', (code, signal) => {
      const description =
        code === 0 && signal === null
          ? 'claude CLI exited'
          : `claude CLI exited with code ${String(code)} signal ${String(signal)}`
      this.handleProcessFailure(new NativeTransportError(description, 'process_exit', this.stderrTail()))
    })

    const readline = createInterface({ input: child.stdout })
    this.readline = readline
    readline.on('line', (line: string) => {
      this.handleLine(line)
    })

    // Claude has no handshake request: `system/init` only appears once the
    // first user message starts a session. The ready point is therefore "the
    // process is alive"; catch an immediate arg/auth failure instead of
    // blocking on a frame that will never come.
    await this.waitForAlive(child)
  }

  private waitForAlive(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (this.exitError !== undefined) return Promise.reject(this.exitError)
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.reject(
        new NativeTransportError('claude CLI exited during startup', 'process_exit', this.stderrTail()),
      )
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.removeListener('exit', onExit)
        if (error === undefined) resolve()
        else reject(error)
      }
      const timer = setTimeout(() => finish(), INIT_GRACE_MS)
      timer.unref?.()
      const onExit = (): void => {
        finish(
          this.exitError ??
            new NativeTransportError('claude CLI exited during startup', 'process_exit', this.stderrTail()),
        )
      }
      child.once('exit', onExit)
    })
  }

  private stderrTail(): string | undefined {
    const trimmed = this.stderr.trim()
    return trimmed === '' ? undefined : truncate(trimmed, DETAIL_LIMIT)
  }

  private handleProcessFailure(error: NativeTransportError): void {
    if (this.closed) return
    if (this.exitError === undefined) this.exitError = error
    this.log(`claude: ${error.message}${error.detail === undefined ? '' : ` (${error.detail})`}`)
    this.settlePromptReject(error)
    this.rejectPendingControls(error)
    this.emit({ kind: 'status', busy: false })
    this.emit({ kind: 'notice', text: truncate(error.message, DETAIL_LIMIT) })
  }

  // -- stdin / stdout ------------------------------------------------------

  private writeFrame(payload: Record<string, unknown>): void {
    const child = this.child
    if (child === undefined || this.closed) return
    if (child.stdin.destroyed || !child.stdin.writable) {
      throw new NativeTransportError('claude CLI stdin is not writable', 'stdin_closed')
    }
    child.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  private handleLine(line: string): void {
    if (this.closed) return
    const trimmed = line.trim()
    if (trimmed === '') return
    let raw: unknown
    try {
      raw = JSON.parse(trimmed)
    } catch {
      this.log(`claude: ignoring non-JSON stdout line: ${truncate(trimmed, 200)}`)
      return
    }
    if (!isRecord(raw)) {
      this.log(`claude: ignoring non-object stdout frame: ${truncate(trimmed, 200)}`)
      return
    }
    const type = readString(raw, 'type')
    switch (type) {
      case 'system':
        this.handleSystemFrame(raw)
        return
      case 'control_request':
        void this.handleControlRequest(raw)
        return
      case 'control_response':
        this.handleControlResponse(raw)
        return
      case 'result':
        this.handleResult(raw)
        return
      case 'stream_event':
      case 'assistant':
      case 'user':
        this.emitAll(this.mapper.map(raw))
        return
      default:
        // hook_started / command_lifecycle / system/status / ... are additive.
        return
    }
  }

  private handleSystemFrame(frame: Record<string, unknown>): void {
    if (readString(frame, 'subtype') !== 'init') return
    const sessionId = readString(frame, 'session_id')
    if (sessionId !== undefined && sessionId !== '') this.sessionIdValue = sessionId
    const capabilities = frame.capabilities
    if (Array.isArray(capabilities)) {
      this.capabilities.clear()
      for (const entry of capabilities) {
        if (typeof entry === 'string') this.capabilities.add(entry)
      }
    }
    this.log(
      `claude: init session=${this.sessionIdValue ?? 'unknown'} permissionMode=${readString(frame, 'permissionMode') ?? 'unknown'}`,
    )
  }

  // -- control channel -----------------------------------------------------

  private async controlRequest(
    subtype: string,
    extra: Record<string, unknown>,
    timeoutMs: number = CONTROL_TIMEOUT_MS,
  ): Promise<Record<string, unknown> | undefined> {
    if (this.closed) return undefined
    const requestId = `dsh-${subtype}-${randomUUID()}`
    const pending = deferred<Record<string, unknown> | undefined>()
    this.pendingControls.set(requestId, { deferred: pending })
    try {
      this.writeFrame({ type: 'control_request', request_id: requestId, request: { subtype, ...extra } })
      return await withTimeout(pending.promise, timeoutMs, undefined)
    } finally {
      this.pendingControls.delete(requestId)
    }
  }

  private replyControlResponse(requestId: string, response: Record<string, unknown>): void {
    try {
      this.writeFrame({
        type: 'control_response',
        response: { subtype: 'success', request_id: requestId, response },
      })
    } catch (error: unknown) {
      this.log(`claude: failed to answer control request ${requestId}: ${messageOf(error)}`)
    }
  }

  private replyControlError(requestId: string, message: string): void {
    try {
      this.writeFrame({
        type: 'control_response',
        response: { subtype: 'error', request_id: requestId, error: message },
      })
    } catch (error: unknown) {
      this.log(`claude: failed to answer control request ${requestId}: ${messageOf(error)}`)
    }
  }

  private handleControlResponse(frame: Record<string, unknown>): void {
    const response = recordOf(frame.response)
    if (response === undefined) return
    const requestId = readString(response, 'request_id')
    if (requestId === undefined) return
    const pending = this.pendingControls.get(requestId)
    if (pending === undefined) {
      this.log(`claude: control response for unknown request ${requestId}`)
      return
    }
    this.pendingControls.delete(requestId)
    if (readString(response, 'subtype') === 'error') {
      const error = response.error
      pending.deferred.resolve(undefined)
      this.log(`claude: control request ${requestId} failed: ${messageOf(error)}`)
      return
    }
    pending.deferred.resolve(recordOf(response.response) ?? {})
  }

  private async handleControlRequest(frame: Record<string, unknown>): Promise<void> {
    const requestId = readString(frame, 'request_id')
    const request = recordOf(frame.request)
    if (requestId === undefined || request === undefined) {
      this.log('claude: ignoring malformed control_request')
      return
    }
    const subtype = readString(request, 'subtype')
    if (subtype !== 'can_use_tool') {
      // The CLI waits for an answer. Unknown host callbacks must be refused
      // explicitly or the turn hangs.
      this.log(`claude: unsupported control request ${subtype ?? 'unknown'} (${requestId})`)
      this.replyControlError(requestId, `DSH native transport does not support ${subtype ?? 'this'} request`)
      return
    }
    const controller = new AbortController()
    this.permissionControllers.add(controller)
    try {
      const permission = claudePermissionRequest(requestId, request)
      this.log(`claude: permission request ${permission.requestId} (${readString(request, 'tool_name') ?? 'tool'})`)
      const decision = await this.askPermission(permission, controller.signal)
      const suggestions = Array.isArray(request.permission_suggestions)
        ? request.permission_suggestions
        : undefined
      this.replyControlResponse(
        requestId,
        claudePermissionResponsePayload({
          request,
          decision,
          ...(suggestions === undefined ? {} : { suggestions }),
        }),
      )
    } catch (error: unknown) {
      this.log(`claude: failed to answer permission request: ${messageOf(error)}`)
      this.replyControlError(requestId, `DSH failed to answer can_use_tool: ${messageOf(error)}`)
    } finally {
      this.permissionControllers.delete(controller)
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
      void Promise.resolve()
        .then(() => handler(request, signal))
        .then(
          (decision) => finish(decision),
          (error: unknown) => {
            this.log(`claude: onPermission handler failed: ${messageOf(error)}`)
            finish({ cancelled: true })
          },
        )
    })
  }

  private rejectPendingControls(error: Error): void {
    for (const pending of this.pendingControls.values()) pending.deferred.resolve(undefined)
    this.pendingControls.clear()
    for (const controller of this.permissionControllers) controller.abort()
    this.permissionControllers.clear()
    void error
  }

  // -- turn lifecycle ------------------------------------------------------

  async prompt(
    content: readonly NativeContentBlock[],
    signal: AbortSignal,
  ): Promise<NativePromptResult> {
    if (this.closed) throw new NativeTransportError('Claude transport is closed', 'closed')
    if (this.exitError !== undefined) throw this.exitError
    if (this.startPromise === undefined) {
      throw new NativeTransportError('Claude transport was not started', 'not_started')
    }
    if (this.promptSettlement !== undefined) {
      throw new NativeTransportError('A Claude prompt is already in progress', 'busy')
    }
    if (signal.aborted) return { stopReason: 'cancelled' }
    if (content.length === 0) throw new NativeTransportError('Claude prompt is empty', 'empty_prompt')

    const uuid = randomUUID()
    let resolveSettlement!: (result: NativePromptResult) => void
    let rejectSettlement!: (error: Error) => void
    const settled = new Promise<NativePromptResult>((resolve, reject) => {
      resolveSettlement = resolve
      rejectSettlement = reject
    })
    void settled.catch(() => undefined)

    this.promptSettlement = { resolve: resolveSettlement, reject: rejectSettlement }
    this.activeTurnUuid = uuid
    this.interruptRequested = false
    this.interruptInFlight = undefined
    this.mapper.resetTurn()
    this.emit({ kind: 'status', busy: true })

    const onAbort = (): void => {
      void this.interrupt()
    }
    signal.addEventListener('abort', onAbort, { once: true })

    try {
      const frame = claudeUserMessageFrame({
        blocks: content,
        ...(this.sessionIdValue === undefined ? {} : { sessionId: this.sessionIdValue }),
        uuid,
      })
      this.writeFrame(frame)
      const result = await settled
      return result
    } catch (error: unknown) {
      this.settlePromptReject(error instanceof Error ? error : new Error(String(error)))
      if (signal.aborted) return { stopReason: 'cancelled' }
      throw error instanceof NativeTransportError
        ? error
        : new NativeTransportError(`Claude prompt failed: ${messageOf(error)}`, 'prompt_failed', this.stderrTail())
    } finally {
      signal.removeEventListener('abort', onAbort)
      if (this.activeTurnUuid === uuid) this.activeTurnUuid = undefined
    }
  }

  /**
   * Inject a message into the running turn. `injected` means the CLI took the
   * message into the current turn (`priority:"next"`); `promptRequired` means
   * no turn is running and the caller must use `prompt()`.
   */
  async steer(
    content: readonly NativeContentBlock[],
    signal?: AbortSignal,
  ): Promise<'injected' | 'promptRequired'> {
    if (this.closed || this.exitError !== undefined) return 'promptRequired'
    if (signal?.aborted === true) return 'promptRequired'
    if (this.promptSettlement === undefined || this.activeTurnUuid === undefined) return 'promptRequired'
    if (content.length === 0) return 'promptRequired'
    try {
      const frame = claudeUserMessageFrame({
        blocks: content,
        ...(this.sessionIdValue === undefined ? {} : { sessionId: this.sessionIdValue }),
        priority: 'next',
      })
      const uuid = readString(frame, 'uuid')
      if (uuid !== undefined) this.injectedTurnUuids.add(uuid)
      this.writeFrame(frame)
      this.log(`claude: injected steer ${uuid ?? '(no uuid)'} into running turn`)
      return 'injected'
    } catch (error: unknown) {
      this.log(`claude: steer failed: ${messageOf(error)}`)
      return 'promptRequired'
    }
  }

  async interrupt(): Promise<void> {
    if (this.closed) return
    if (this.activeTurnUuid === undefined || this.promptSettlement === undefined) return
    if (this.interruptInFlight !== undefined) return await this.interruptInFlight
    this.interruptInFlight = this.interruptInternal()
    try {
      await this.interruptInFlight
    } finally {
      this.interruptInFlight = undefined
    }
    this.armInterruptFallback()
  }

  private armInterruptFallback(): void {
    if (this.promptSettlement === undefined) return
    if (this.interruptFallbackTimer !== undefined) clearTimeout(this.interruptFallbackTimer)
    const timer = setTimeout(() => {
      this.interruptFallbackTimer = undefined
      if (this.promptSettlement === undefined) return
      this.log('claude: interrupted turn produced no result; settling as cancelled')
      this.emitAll(this.mapper.settle())
      this.finishTurn({ stopReason: 'cancelled' })
    }, INTERRUPT_SETTLE_FALLBACK_MS)
    timer.unref?.()
    this.interruptFallbackTimer = timer
  }

  private clearInterruptFallback(): void {
    if (this.interruptFallbackTimer === undefined) return
    clearTimeout(this.interruptFallbackTimer)
    this.interruptFallbackTimer = undefined
  }

  private async interruptInternal(): Promise<void> {
    this.interruptRequested = true
    this.mapper.noteInterrupted(true)
    for (const controller of this.permissionControllers) controller.abort()
    // Snapshot before the round trip: the interrupted turn's own `result` frame
    // can be processed while we await the receipt, which clears the live set.
    const injectedBeforeInterrupt = new Set(this.injectedTurnUuids)
    const cancelQueued = this.capabilities.has('interrupt_cancel_queued_v1')
    let receipt: Record<string, unknown> | undefined
    try {
      receipt = await this.controlRequest(
        'interrupt',
        cancelQueued ? { cancel_queued: true } : {},
        INTERRUPT_TIMEOUT_MS,
      )
    } catch (error: unknown) {
      this.log(`claude: interrupt failed: ${messageOf(error)}`)
      return
    }
    if (cancelQueued) {
      // The receipt already lists the withdrawn messages; drop our bookkeeping.
      for (const uuid of readStringArray(receipt, 'cancelled')) this.injectedTurnUuids.delete(uuid)
      return
    }
    // Older CLIs leave injected messages queued: withdraw each one we sent,
    // otherwise a stopped turn is silently resumed by the leftover message.
    for (const uuid of readStringArray(receipt, 'still_queued')) {
      if (!injectedBeforeInterrupt.has(uuid)) continue
      this.injectedTurnUuids.delete(uuid)
      try {
        this.writeFrame({
          type: 'control_request',
          request_id: `dsh-cancel-${uuid}`,
          request: { subtype: 'cancel_async_message', message_uuid: uuid },
        })
        this.log(`claude: withdrew queued steer ${uuid} after interrupt`)
      } catch (error: unknown) {
        this.log(`claude: failed to withdraw queued steer ${uuid}: ${messageOf(error)}`)
      }
    }
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
    this.settlePromptReject(new NativeTransportError('Claude transport closed', 'closed'))
    for (const controller of this.permissionControllers) controller.abort()
    this.permissionControllers.clear()
    this.rejectPendingControls(new NativeTransportError('Claude transport closed', 'closed'))
    await this.terminateChild()
    this.readline?.close()
    this.readline = undefined
    this.child = undefined
  }

  private async terminateChild(): Promise<void> {
    const child = this.child
    if (child === undefined) return
    if (child.exitCode !== null || child.signalCode !== null) return
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
    this.log('claude: CLI ignored SIGTERM; sending SIGKILL')
    this.signalChild(child, 'SIGKILL')
    await withTimeout(exitPromise, CLOSE_SIGKILL_MS, false)
  }

  private signalChild(child: ChildProcessWithoutNullStreams, signal: 'SIGTERM' | 'SIGKILL'): void {
    const pid = child.pid
    if (pid === undefined) return
    if (this.detached) {
      try {
        process.kill(-pid, signal)
        return
      } catch {
        // Fall through to the direct child (process group may be gone).
      }
    }
    try {
      child.kill(signal)
    } catch {
      // Already gone.
    }
  }

  // -- result / usage ------------------------------------------------------

  private handleResult(frame: Record<string, unknown>): void {
    const settlement = this.promptSettlement
    if (settlement === undefined) {
      this.log('claude: result frame without an active prompt')
      return
    }
    const sessionId = readString(frame, 'session_id')
    if (sessionId !== undefined && sessionId !== '') this.sessionIdValue = sessionId

    const interrupted = this.interruptRequested
    const stopReason = claudeStopReason(frame, { interrupted })
    const error = interrupted ? undefined : claudeResultError(frame)

    const totals = claudeUsageTotals(frame)
    let turnUsage: NativeUsage | undefined
    if (totals !== undefined) {
      this.mapper.noteContextWindow(totals.contextWindow)
      turnUsage = claudeUsageDelta(totals, this.lastUsageTotals)
      this.lastUsageTotals = totals
      this.emit({ kind: 'usage', usage: turnUsage })
      const size = totals.contextWindow
      if (size !== undefined) {
        const used = this.mapper.lastContextUsed
        if (used !== undefined) {
          const contextUsage: NativeContextUsage = { used, size }
          this.lastContextUsage = contextUsage
          this.emit({ kind: 'context_usage', contextUsage })
        }
      }
    } else {
      const fallbackUsage = claudeUsageFromResultUsage(frame)
      if (fallbackUsage !== undefined) {
        this.emit({ kind: 'usage', usage: fallbackUsage })
      }
    }

    this.emitAll(this.mapper.settle())
    if (error !== undefined) {
      this.log(`claude: turn failed: ${truncate(error, DETAIL_LIMIT)}`)
      this.emit({ kind: 'notice', text: truncate(error, DETAIL_LIMIT) })
    }
    this.finishTurn({
      stopReason,
      ...(turnUsage === undefined ? {} : { usage: turnUsage }),
    })
  }

  private finishTurn(result: NativePromptResult): void {
    this.clearInterruptFallback()
    const settlement = this.promptSettlement
    this.promptSettlement = undefined
    this.activeTurnUuid = undefined
    this.interruptRequested = false
    this.interruptInFlight = undefined
    this.injectedTurnUuids.clear()
    this.emit({ kind: 'status', busy: false })
    settlement?.resolve(result)
  }

  private settlePromptReject(error: Error): void {
    this.clearInterruptFallback()
    const settlement = this.promptSettlement
    this.promptSettlement = undefined
    this.activeTurnUuid = undefined
    this.interruptRequested = false
    this.interruptInFlight = undefined
    this.injectedTurnUuids.clear()
    settlement?.reject(error)
  }
}

/** Fallback usage when `modelUsage` is absent (older CLI builds). */
function claudeUsageFromResultUsage(frame: Record<string, unknown>): NativeUsage | undefined {
  const usage = recordOf(frame.usage)
  if (usage === undefined) return undefined
  const input = readNumber(usage, 'input_tokens') ?? 0
  const output = readNumber(usage, 'output_tokens') ?? 0
  const cacheRead = readNumber(usage, 'cache_read_input_tokens') ?? 0
  const cacheWrite = readNumber(usage, 'cache_creation_input_tokens') ?? 0
  const reasoning = readNumber(recordOf(usage.output_tokens_details), 'thinking_tokens') ?? 0
  const costUsd = readNumber(frame, 'total_cost_usd') ?? 0
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
    reasoning,
    ...(costUsd > 0 ? { cost: { amount: Number(costUsd.toFixed(6)), currency: 'USD' } } : {}),
  }
}

/** Exported aliases kept small on purpose: the class is the product, these help tests. */
export function createClaudeTransport(): NativeTransport {
  return new ClaudeCliTransport()
}
