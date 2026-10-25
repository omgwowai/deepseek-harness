/// <reference types="node" />
/**
 * Oh My Pi (`omp`) native transport.
 *
 * Speaks OMP's JSONL-RPC protocol directly (`omp --mode rpc-ui`) instead of going
 * through ACP, which is the only way to get the vendor's real steering queue,
 * per-message usage and tool-approval dialog. The transport owns one `omp`
 * subprocess and normalizes its frames onto {@link NativeTransportEvent}:
 *
 * - stdout is one JSON object per line; the first `ready` frame means "accepting
 *   commands" (20s budget). Frames larger than 1MB arrive as `rpc_chunk` pieces
 *   after `negotiate_protocol` v2 and are reassembled before JSON parsing.
 * - `prompt` is acknowledged before the turn runs; the terminal signal is the
 *   `prompt_result` frame carrying the same correlation id. A streaming prompt is
 *   rejected with a failed response (some OMP builds follow it with a second
 *   success frame for the same id), so the terminal outcome is always taken from
 *   `prompt_result`.
 * - `steer`'s response only means "queued". `injected` is returned only after the
 *   three-stage proof from the protocol spec: `queue_update` admits the text,
 *   a later `queue_update` drops it (consumed), and a `role:"user"` message with
 *   `steering:true` / `liveSteered:true` lands in the transcript. A steer sent
 *   while idle starts a new turn; that is still reported as `injected`.
 * - per-message `usage` comes from `message_end.message.usage` (streaming usage is
 *   zero, only the end frame is final); context occupancy comes from
 *   `get_session_stats.contextUsage`, polled every 3s while a turn runs.
 * - tool approval arrives as `extension_ui_request {method:"select", options}`.
 *   The host chooses through `onPermission`; the selected label is echoed back as
 *   `extension_ui_response {value}`. Options are never assumed to be exactly two:
 *   `always-ask-cached` adds directory/file grant labels.
 *
 * Deliberately dependency-free (node builtins only) per the transport contract.
 */

import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { TextDecoder } from 'node:util'

import type {
  NativeContentBlock,
  NativeContextUsage,
  NativePermissionDecision,
  NativePermissionHandler,
  NativePermissionRequest,
  NativePromptResult,
  NativeToolCallStatus,
  NativeTransport,
  NativeTransportEvent,
  NativeTransportStartOptions,
  NativeUsage,
} from './contract.ts'
import { NativeTransportError } from './contract.ts'

/** `start()` waits this long for the first `{"type":"ready"}` frame. */
const READY_TIMEOUT_MS = 20_000
/** Default wall-clock timeout for control-plane RPCs (spec §2.2). */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
/** Context occupancy is re-read at this cadence while a turn is running. */
const CONTEXT_POLL_INTERVAL_MS = 3_000
/** How long `steer()` waits for the three-stage injection proof before rolling back. */
const DEFAULT_STEER_TIMEOUT_MS = 10_000
/** After a rejected prompt acknowledgement, wait this long for a late `prompt_result`. */
const PROMPT_ADMISSION_GRACE_MS = 1_500
/** Wait this long after the run's terminal frame before settling a prompt without `prompt_result`. */
const PROMPT_RESULT_FALLBACK_MS = 1_500
/** After the abort signal fires, wait this long for the aborted `prompt_result`. */
const ABORT_SETTLE_GRACE_MS = 5_000
/** Default context-usage read used when a turn settles. */
const TURN_END_CONTEXT_TIMEOUT_MS = 3_000
/** `stdin.end()` → wait → SIGTERM → wait → SIGKILL (spec §1.4). */
const STDIN_CLOSE_GRACE_MS = 500
const SIGTERM_GRACE_MS = 2_000
const SIGKILL_GRACE_MS = 1_000
/** stderr is diagnostics only; keep its tail for error reports. */
const STDERR_BUFFER_LIMIT = 8_192
/** RPC v2 framing limits (spec §2.3). */
const MAX_FRAME_BYTES = 1_048_576
const MAX_REASSEMBLED_BYTES = 67_108_864
const MAX_CHUNK_BYTES = 262_144
const MAX_CHUNK_DECODED_CHARS = Math.ceil(MAX_CHUNK_BYTES / 3) * 4
const MAX_CHUNK_COUNT = Math.ceil(MAX_REASSEMBLED_BYTES / MAX_CHUNK_BYTES)

type JsonObject = Record<string, unknown>

/** One option the vendor offered inside a `select` dialog. */
export type OmpPermissionOption = NativePermissionRequest['options'][number]

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: Error) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

function readStringArray(value: unknown): string[] {
  const array = readArray(value)
  if (array === undefined) return []
  const result: string[] = []
  for (const item of array) {
    const text = readString(item)
    if (text !== undefined) result.push(text)
  }
  return result
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new Error(reason === undefined ? 'Aborted' : String(reason))
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new NativeTransportError(`${label} timed out`, 'timeout', `${label} timeoutMs=${timeoutMs}`))
    }, timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

function sleep(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, timeoutMs)
  })
}

/** Join host content into OMP's `message` + `images` payload. */
function splitContent(content: readonly NativeContentBlock[]): {
  readonly message: string
  readonly images: Array<{ readonly type: 'image'; readonly data: string; readonly mimeType: string }>
} {
  const parts: string[] = []
  const images: Array<{ type: 'image'; data: string; mimeType: string }> = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
    else images.push({ type: 'image', data: block.data, mimeType: block.mimeType })
  }
  return { message: parts.join('\n'), images }
}

/** Text of an OMP message/content array, used for steering proofs and tool results. */
function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  const array = readArray(value)
  if (array === undefined) return ''
  const parts: string[] = []
  for (const block of array) {
    const record = asObject(block)
    if (record === undefined) continue
    const text = readString(record.text)
    if (text !== undefined) parts.push(text)
  }
  return parts.join('\n')
}

/**
 * Normalize the vendor argv the transport owns: approval dialogs only exist under
 * `--mode rpc-ui`, so an explicit `rpc` mode is upgraded; a resume target becomes
 * `--session` (its alias `--resume` is accepted too and left alone).
 */
export function ompTransportArgs(args: readonly string[], resumeSessionId?: string): string[] {
  const result: string[] = []
  let hasMode = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) continue
    if (arg === '--mode') {
      hasMode = true
      // The following value (if any) is the caller's chosen mode; rpc-ui replaces it.
      if (args[index + 1] !== undefined) index += 1
      result.push('--mode', 'rpc-ui')
      continue
    }
    if (arg.startsWith('--mode=')) {
      hasMode = true
      result.push('--mode', 'rpc-ui')
      continue
    }
    result.push(arg)
  }
  if (!hasMode) result.unshift('--mode', 'rpc-ui')
  if (resumeSessionId !== undefined && resumeSessionId.length > 0) {
    const hasSession = result.some(
      (arg) =>
        arg === '--session' ||
        arg === '--resume' ||
        arg.startsWith('--session=') ||
        arg.startsWith('--resume='),
    )
    if (!hasSession) result.push('--session', resumeSessionId)
  }
  return result
}

/**
 * Map the vendor's `select` labels to contract permission options. Labels are
 * kept verbatim as `optionId` because OMP matches the echoed `value` against
 * them. `always-ask-cached` adds `Approve Directory: …`, `Always Approve …` and
 * `Approve Once` entries, so nothing here assumes exactly two options.
 */
export function mapOmpPermissionOptions(options: readonly string[]): readonly OmpPermissionOption[] {
  return options.map((label) => ({
    optionId: label,
    name: label,
    kind: permissionOptionKind(label),
  }))
}

function permissionOptionKind(label: string): OmpPermissionOption['kind'] {
  const normalized = label.trim().toLowerCase()
  if (
    normalized === 'deny' ||
    normalized === 'cancel' ||
    normalized.startsWith('deny ') ||
    normalized.startsWith('deny:') ||
    normalized.startsWith('reject') ||
    normalized.startsWith('abort')
  ) {
    return 'reject_once'
  }
  if (normalized.startsWith('always') || normalized.includes('for this session')) return 'allow_always'
  return 'allow_once'
}

/** Map OMP's token accounting to the contract's {@link NativeUsage}. */
export function mapOmpUsage(raw: unknown): NativeUsage | undefined {
  const record = asObject(raw)
  if (record === undefined) return undefined
  const input = readNumber(record.input)
  const output = readNumber(record.output)
  const cacheRead = readNumber(record.cacheRead)
  const cacheWrite = readNumber(record.cacheWrite)
  const total = readNumber(record.totalTokens)
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined &&
    total === undefined
  ) {
    return undefined
  }
  const reasoning = readNumber(record.reasoningTokens) ?? 0
  const cost = asObject(record.cost)
  const costAmount = cost === undefined ? undefined : readNumber(cost.total)
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
    total: total ?? (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0),
    reasoning,
    ...(costAmount === undefined ? {} : { cost: { amount: costAmount, currency: 'USD' } }),
  }
}

interface ActivePromptState {
  readonly id: string
  readonly deferred: Deferred<NativePromptResult>
  usage: NativeUsage | undefined
  lastStopReason: string | undefined
  admissionError: Error | undefined
  aborted: boolean
  admissionTimer: ReturnType<typeof setTimeout> | undefined
  abortTimer: ReturnType<typeof setTimeout> | undefined
  fallbackTimer: ReturnType<typeof setTimeout> | undefined
  removeAbortListener: (() => void) | undefined
}

interface ActiveSteerState {
  readonly text: string
  admitted: boolean
  consumed: boolean
  injected: boolean
  readonly deferred: Deferred<'injected' | 'promptRequired'>
}

interface PendingRequest {
  readonly command: string
  readonly resolve: (data: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout> | undefined
}

interface ChunkAssembly {
  readonly id: string
  readonly count: number
  readonly byteLength: number
  readonly parts: Buffer[]
  bytes: number
}

/** Knobs that tests or the host may override; production defaults follow the protocol spec. */
export interface OmpNativeTransportOptions {
  readonly readyTimeoutMs?: number
  readonly requestTimeoutMs?: number
  readonly contextPollIntervalMs?: number
  readonly steerTimeoutMs?: number
}

/** OMP native transport: one `omp --mode rpc-ui` subprocess per instance. */
export class OmpNativeTransport implements NativeTransport {
  readonly kind = 'omp' as const

  private readonly readyTimeoutMs: number
  private readonly requestTimeoutMs: number
  private readonly contextPollIntervalMs: number
  private readonly steerTimeoutMs: number

  private child: ChildProcessWithoutNullStreams | undefined
  private eventSink: NativeTransportStartOptions['onEvent'] | undefined
  private permissionHandler: NativePermissionHandler | undefined
  private logSink: ((message: string) => void) | undefined
  private startPromise: Promise<void> | undefined
  private closePromise: Promise<void> | undefined
  private started = false
  private closing = false
  private closed = false
  private exited = false
  private exitError: Error | undefined
  private exitDeferred: Deferred<void> | undefined
  private nextRequestId = 1
  private readonly pending = new Map<string, PendingRequest>()
  private stderrBuffer = ''
  private lineBuffer = ''
  private malformedFrames = 0
  private chunkAssembly: ChunkAssembly | undefined

  private readyWaiter:
    | {
        readonly resolve: (frame: JsonObject) => void
        readonly reject: (error: Error) => void
      }
    | undefined

  private sessionIdValue: string | undefined
  private contextUsageValue: NativeContextUsage | undefined
  private busy = false
  private contextPollTimer: ReturnType<typeof setTimeout> | undefined
  private contextPollInFlight = false

  private activePrompt: ActivePromptState | undefined
  private activeSteer: ActiveSteerState | undefined
  private steerTail: Promise<void> = Promise.resolve()

  constructor(options: OmpNativeTransportOptions = {}) {
    this.readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.contextPollIntervalMs = options.contextPollIntervalMs ?? CONTEXT_POLL_INTERVAL_MS
    this.steerTimeoutMs = options.steerTimeoutMs ?? DEFAULT_STEER_TIMEOUT_MS
  }

  get sessionId(): string | undefined {
    return this.sessionIdValue
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  start(options: NativeTransportStartOptions): Promise<void> {
    if (this.started) return Promise.resolve()
    if (this.startPromise !== undefined) return this.startPromise
    this.startPromise = this.doStart(options)
    return this.startPromise
  }

  private async doStart(options: NativeTransportStartOptions): Promise<void> {
    if (this.closed) throw new NativeTransportError('OMP transport is closed', 'closed')
    if (this.child !== undefined) throw new NativeTransportError('OMP transport already spawned', 'already-started')
    this.eventSink = options.onEvent
    this.permissionHandler = options.onPermission
    this.logSink = options.log

    const args = ompTransportArgs(options.args, options.resumeSessionId)
    const env = normalizeEnv(options.env)
    const command = resolveExecutable(options.command, env)
    this.log(`spawning ${command} ${args.join(' ')} (cwd=${options.cwd})`)

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Own process group: close() can then take the whole OMP tree down with one signal.
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      throw new NativeTransportError('failed to spawn omp', 'spawn-failed', errorText(error))
    }
    this.child = child
    this.attachChild(child)

    try {
      const ready = await this.waitForReady()
      await this.handshake(ready)
      if (this.exitError !== undefined) throw this.exitError
      this.started = true
    } catch (error) {
      await this.close().catch(() => undefined)
      throw error
    }
  }

  private attachChild(child: ChildProcessWithoutNullStreams): void {
    this.exitDeferred = deferred<void>()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      this.handleStdoutChunk(chunk)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderrBuffer += chunk
      if (this.stderrBuffer.length > STDERR_BUFFER_LIMIT) {
        this.stderrBuffer = this.stderrBuffer.slice(-STDERR_BUFFER_LIMIT)
      }
    })
    child.stdin.on('error', (error) => {
      this.log(`stdin error: ${errorText(error)}`)
      if (!this.closing) void this.close()
    })
    child.on('error', (error) => {
      this.failProcess(new NativeTransportError('OMP process failed', 'process-error', errorText(error)))
    })
    child.on('exit', (code, signal) => {
      this.exited = true
      const detail = `code=${code === null ? 'null' : String(code)} signal=${signal === null ? 'null' : signal}`
      this.failProcess(new NativeTransportError('OMP process exited', 'process-exit', detail))
      this.exitDeferred?.resolve()
    })
  }

  private async handshake(ready: JsonObject): Promise<void> {
    const supported = readArray(ready.supportedProtocolVersions)?.filter(
      (version): version is number => typeof version === 'number',
    )
    const supportsV2 =
      supported !== undefined &&
      supported.includes(2) &&
      ready.maxFrameBytes === MAX_FRAME_BYTES &&
      ready.maxReassembledFrameBytes === MAX_REASSEMBLED_BYTES
    if (supportsV2) {
      try {
        const data = asObject(
          await this.request({ type: 'negotiate_protocol', protocolVersion: 2 }, this.requestTimeoutMs)
            .response,
        )
        if (data === undefined || readNumber(data.protocolVersion) !== 2) {
          this.log('OMP did not accept RPC protocol v2; staying on line framing')
        }
      } catch (error) {
        this.log(`OMP protocol v2 negotiation failed: ${errorText(error)}`)
      }
    }
    // Every session event, but drop the accumulating message snapshot from streaming updates:
    // deltas remain, which is all this transport renders. Best effort on older builds.
    try {
      await this.request({ type: 'set_event_filter', events: null, messageUpdates: 'delta' }, 5_000)
        .response
    } catch (error) {
      this.log(`OMP set_event_filter was rejected: ${errorText(error)}`)
    }
    await this.learnSessionState()
  }

  private async learnSessionState(): Promise<void> {
    try {
      const data = asObject(
        await this.request({ type: 'get_session_stats' }, this.requestTimeoutMs).response,
      )
      if (data !== undefined) {
        this.sessionIdValue = readString(data.sessionId) ?? this.sessionIdValue
        this.applyContextUsage(data.contextUsage)
        return
      }
    } catch (error) {
      this.log(`OMP get_session_stats failed: ${errorText(error)}`)
    }
    // COMPAT(ompGetStateFallback): older binaries lack get_session_stats; get_state carries the same ids.
    try {
      const state = asObject(await this.request({ type: 'get_state' }, this.requestTimeoutMs).response)
      if (state !== undefined) {
        this.sessionIdValue = readString(state.sessionId) ?? this.sessionIdValue
        this.applyContextUsage(state.contextUsage)
      }
    } catch (error) {
      this.log(`OMP get_state failed: ${errorText(error)}`)
    }
  }

  async close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    this.closing = true
    this.closePromise = this.terminate()
    return this.closePromise
  }

  private async terminate(): Promise<void> {
    this.closed = true
    this.stopContextPolling()
    this.setBusy(false)
    const closeError = this.exitError ?? new NativeTransportError('OMP transport is closed', 'closed')
    if (this.readyWaiter !== undefined) {
      this.readyWaiter.reject(closeError)
      this.readyWaiter = undefined
    }
    this.failPending(closeError)
    if (this.activePrompt !== undefined) this.failPrompt(this.activePrompt, closeError)
    if (this.activeSteer !== undefined) this.failSteer(this.activeSteer, closeError)

    const child = this.child
    if (child === undefined) return
    try {
      child.stdin.end()
    } catch {
      // Cleanup race: the pipe may already be gone.
    }
    if (await this.waitForExit(STDIN_CLOSE_GRACE_MS)) return
    this.signalProcessTree('SIGTERM')
    if (await this.waitForExit(SIGTERM_GRACE_MS)) return
    this.signalProcessTree('SIGKILL')
    await this.waitForExit(SIGKILL_GRACE_MS)
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return true
    const exitDeferred = this.exitDeferred
    if (exitDeferred === undefined) return true
    return Promise.race([
      exitDeferred.promise.then(() => true),
      sleep(timeoutMs).then(() => false),
    ])
  }

  private signalProcessTree(signal: NodeJS.Signals): void {
    const child = this.child
    if (child === undefined) return
    const pid = child.pid
    if (pid === undefined) return
    if (process.platform !== 'win32') {
      try {
        process.kill(-pid, signal)
        return
      } catch {
        // Not a group leader (or already reaped): fall back to the direct child.
      }
    }
    try {
      child.kill(signal)
    } catch {
      // Already gone.
    }
  }

  private failProcess(error: Error): void {
    if (this.exitError !== undefined) return
    this.exitError = error
    this.failPending(error)
    if (this.readyWaiter !== undefined) {
      this.readyWaiter.reject(error)
      this.readyWaiter = undefined
    }
    if (this.activePrompt !== undefined) {
      const prompt = this.activePrompt
      if (prompt.aborted) void this.finishPrompt(prompt, { stopReason: 'cancelled' })
      else this.failPrompt(prompt, error)
    }
    if (this.activeSteer !== undefined) this.failSteer(this.activeSteer, error)
    this.stopContextPolling()
    this.setBusy(false)
    if (!this.closing && !this.closed) {
      const detail = this.stderrTail()
      this.emit({
        kind: 'notice',
        text: `${error.message}${detail.length === 0 ? '' : `: ${detail.slice(-500)}`}`,
      })
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  // ---------------------------------------------------------------------------
  // stdio + frame decoding
  // ---------------------------------------------------------------------------

  private handleStdoutChunk(chunk: string): void {
    this.lineBuffer += chunk
    let newline = this.lineBuffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.lineBuffer.slice(0, newline).replace(/\r$/, '')
      this.lineBuffer = this.lineBuffer.slice(newline + 1)
      this.consumeLine(line)
      newline = this.lineBuffer.indexOf('\n')
    }
    if (this.lineBuffer.length > MAX_REASSEMBLED_BYTES * 2) {
      this.lineBuffer = ''
      this.reportMalformedFrame('stdout line exceeded the reassembly limit')
    }
  }

  private consumeLine(line: string): void {
    if (line.trim().length === 0) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.reportMalformedFrame('invalid JSON from OMP stdout')
      return
    }
    const frame = asObject(parsed)
    if (frame === undefined) return
    if (readString(frame.type) === 'rpc_chunk') {
      this.consumeChunk(frame)
      return
    }
    this.dispatchFrame(frame)
  }

  private consumeChunk(frame: JsonObject): void {
    const chunkId = readString(frame.chunkId)
    const index = readNumber(frame.index)
    const count = readNumber(frame.count)
    const byteLength = readNumber(frame.byteLength)
    const data = readString(frame.data)
    if (
      chunkId === undefined ||
      chunkId.length === 0 ||
      chunkId.length > 128 ||
      index === undefined ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      count === undefined ||
      !Number.isSafeInteger(count) ||
      count < 2 ||
      count > MAX_CHUNK_COUNT ||
      index >= count ||
      byteLength === undefined ||
      !Number.isSafeInteger(byteLength) ||
      byteLength < MAX_FRAME_BYTES ||
      byteLength > MAX_REASSEMBLED_BYTES ||
      data === undefined ||
      data.length === 0
    ) {
      this.dropChunkAssembly('invalid rpc_chunk header')
      return
    }
    if (data.length > MAX_CHUNK_DECODED_CHARS) {
      this.dropChunkAssembly('rpc_chunk payload too large')
      return
    }
    const bytes = Buffer.from(data, 'base64')
    if (bytes.byteLength > MAX_CHUNK_BYTES || bytes.toString('base64') !== data) {
      this.dropChunkAssembly('rpc_chunk payload is not canonical base64')
      return
    }
    let assembly = this.chunkAssembly
    if (assembly === undefined) {
      if (index !== 0) {
        this.dropChunkAssembly('rpc_chunk assembly started out of order')
        return
      }
      assembly = { id: chunkId, count, byteLength, parts: [], bytes: 0 }
      this.chunkAssembly = assembly
    }
    if (
      assembly.id !== chunkId ||
      assembly.count !== count ||
      assembly.byteLength !== byteLength ||
      assembly.parts.length !== index
    ) {
      this.dropChunkAssembly('rpc_chunk out of order')
      return
    }
    assembly.parts.push(bytes)
    assembly.bytes += bytes.byteLength
    if (assembly.bytes > assembly.byteLength) {
      this.dropChunkAssembly('rpc_chunk byte length mismatch')
      return
    }
    if (assembly.parts.length < assembly.count) return
    this.chunkAssembly = undefined
    if (assembly.bytes !== assembly.byteLength) {
      this.reportMalformedFrame('rpc_chunk reassembly length mismatch')
      return
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(assembly.parts))
      const frameText = asObject(JSON.parse(text))
      if (frameText === undefined) {
        this.reportMalformedFrame('reassembled rpc_chunk is not a JSON object')
        return
      }
      this.dispatchFrame(frameText)
    } catch {
      this.reportMalformedFrame('reassembled rpc_chunk is not valid UTF-8 JSON')
    }
  }

  private dropChunkAssembly(reason: string): void {
    this.chunkAssembly = undefined
    this.reportMalformedFrame(reason)
  }

  private reportMalformedFrame(reason: string): void {
    this.malformedFrames += 1
    if (this.malformedFrames <= 5) this.log(`ignoring malformed OMP frame: ${reason}`)
  }

  private dispatchFrame(frame: JsonObject): void {
    const type = readString(frame.type)
    if (type === 'ready') {
      this.resolveReady(frame)
      return
    }
    if (type === 'response') {
      this.handleResponse(frame)
      return
    }
    this.handleEvent(frame, type)
  }

  private writeFrame(frame: JsonObject): boolean {
    const child = this.child
    if (child === undefined || this.closing || this.closed) return false
    if (child.stdin.destroyed || !child.stdin.writable) return false
    try {
      child.stdin.write(`${JSON.stringify(frame)}\n`)
      return true
    } catch (error) {
      this.log(`writing to OMP stdin failed: ${errorText(error)}`)
      return false
    }
  }

  private request(
    command: JsonObject,
    timeoutMs: number = this.requestTimeoutMs,
  ): { id: string; response: Promise<unknown> } {
    const id = `req_${this.nextRequestId}`
    this.nextRequestId += 1
    const response = new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              const pending = this.pending.get(id)
              if (pending === undefined) return
              this.pending.delete(id)
              pending.reject(
                new NativeTransportError(
                  `OMP ${pending.command} request timed out`,
                  'request-timeout',
                  `phase=${pending.command} timeoutMs=${timeoutMs}\n${this.stderrTail()}`,
                ),
              )
            }, timeoutMs)
          : undefined
      this.pending.set(id, {
        command: readString(command.type) ?? 'command',
        resolve,
        reject,
        timer,
      })
      if (!this.writeFrame({ ...command, id })) {
        const pending = this.pending.get(id)
        if (pending !== undefined) {
          this.pending.delete(id)
          if (pending.timer !== undefined) clearTimeout(pending.timer)
        }
        reject(
          this.exitError ??
            new NativeTransportError('OMP stdin is not writable', 'transport-closed', this.stderrTail()),
        )
      }
    })
    return { id, response }
  }

  private handleResponse(frame: JsonObject): void {
    const id = readString(frame.id)
    const pending = id === undefined ? undefined : this.pending.get(id)
    if (pending !== undefined && id !== undefined) {
      this.pending.delete(id)
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      if (readBoolean(frame.success) === true) {
        pending.resolve(frame.data)
      } else {
        pending.reject(
          new NativeTransportError(
            `OMP ${pending.command} failed`,
            'request-failed',
            readString(frame.error) ?? `OMP ${pending.command} failed`,
          ),
        )
      }
      return
    }
    // A late duplicate response (OMP 18.3 answers a streaming prompt with error first, success
    // second, same id) is a diagnostic, not a turn outcome: `prompt_result` owns terminal state.
    if (readString(frame.command) === 'prompt' && readBoolean(frame.success) === false) {
      const prompt = this.activePrompt
      if (prompt !== undefined && (id === undefined || prompt.id === id)) {
        prompt.admissionError ??= new NativeTransportError(
          'OMP rejected the prompt',
          'prompt-rejected',
          readString(frame.error) ?? 'OMP rejected the prompt',
        )
      }
      return
    }
    const command = readString(frame.command)
    // Context polls legitimately race turn settlement/close; a late answer is expected there.
    if (command !== 'get_session_stats' && command !== 'get_state') {
      this.log(`ignoring unsolicited OMP response id=${id ?? 'none'} command=${command ?? 'unknown'}`)
    }
  }

  private resolveReady(frame: JsonObject): void {
    const waiter = this.readyWaiter
    if (waiter === undefined) return
    this.readyWaiter = undefined
    waiter.resolve(frame)
  }

  private waitForReady(): Promise<JsonObject> {
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.readyWaiter === undefined) return
        this.readyWaiter = undefined
        reject(
          new NativeTransportError(
            'OMP did not become ready',
            'ready-timeout',
            `waited ${this.readyTimeoutMs}ms\n${this.stderrTail()}`,
          ),
        )
      }, this.readyTimeoutMs)
      this.readyWaiter = {
        resolve: (frame) => {
          clearTimeout(timer)
          resolve(frame)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Event projection
  // ---------------------------------------------------------------------------

  private handleEvent(frame: JsonObject, type: string | undefined): void {
    switch (type) {
      case 'agent_start':
        this.setBusy(true)
        return
      case 'agent_end':
        this.schedulePromptResultFallback()
        return
      case 'session_settled':
        this.setBusy(false)
        void this.refreshContextUsage(TURN_END_CONTEXT_TIMEOUT_MS).catch(() => undefined)
        this.schedulePromptResultFallback()
        return
      case 'prompt_result':
        this.handlePromptResult(frame)
        return
      case 'message_start':
      case 'message_end':
        this.handleMessageBoundary(frame, type)
        return
      case 'message_update':
        this.handleMessageUpdate(frame)
        return
      case 'turn_end':
        this.handleTurnEnd(frame)
        return
      case 'tool_execution_start':
        this.handleToolExecutionStart(frame)
        return
      case 'tool_execution_end':
        this.handleToolExecutionEnd(frame)
        return
      case 'queue_update':
        this.handleQueueUpdate(frame)
        return
      case 'extension_ui_request':
        void this.handleExtensionUiRequest(frame)
        return
      case 'notice':
        this.emitNoticeFrame(frame)
        return
      case 'auto_retry_start':
        this.emitNotice(
          `OMP retry ${readNumber(frame.attempt) ?? '?'}/${readNumber(frame.maxAttempts) ?? '?'} in ${readNumber(frame.delayMs) ?? '?'}ms: ${readString(frame.errorMessage) ?? 'request failed'}`,
        )
        return
      case 'auto_retry_end':
        if (readBoolean(frame.success) !== true) {
          this.emitNotice(`OMP retry failed: ${readString(frame.finalError) ?? 'unknown error'}`)
        }
        return
      case 'auto_compaction_start':
        this.emitNotice('OMP is compacting the context window')
        return
      case 'auto_compaction_end': {
        const errorMessage = readString(frame.errorMessage)
        if (errorMessage !== undefined) this.emitNotice(`OMP context compaction failed: ${errorMessage}`)
        return
      }
      case 'rpc_frame_error':
        this.emitNotice(
          `OMP dropped an oversized frame (${readString(frame.originalType) ?? 'unknown'}): ${readString(frame.error) ?? 'transport limit'}`,
        )
        return
      default:
        // available_commands_update / subagent_* / model_changed / thinking_level_changed /
        // command_output and the remaining telemetry frames need no projection in v1.
        return
    }
  }

  private handleMessageBoundary(frame: JsonObject, type: 'message_start' | 'message_end'): void {
    const message = asObject(frame.message)
    if (message === undefined) return
    const role = readString(message.role)
    if (type === 'message_start' && role === 'user') {
      this.noteSteeringMessage(message)
      return
    }
    if (type !== 'message_end') return
    if (role === 'user') {
      this.noteSteeringMessage(message)
      return
    }
    if (role !== 'assistant') return
    this.noteAssistantUsage(message.usage)
    const stopReason = readString(message.stopReason)
    const prompt = this.activePrompt
    if (prompt !== undefined && stopReason !== undefined) prompt.lastStopReason = stopReason
  }

  private handleMessageUpdate(frame: JsonObject): void {
    const event = asObject(frame.assistantMessageEvent)
    if (event === undefined) return
    const delta = readString(event.delta)
    if (delta === undefined || delta.length === 0) return
    if (readString(event.type) === 'text_delta') this.emit({ kind: 'text', text: delta })
    else if (readString(event.type) === 'thinking_delta') this.emit({ kind: 'thought', text: delta })
  }

  private handleTurnEnd(frame: JsonObject): void {
    const message = asObject(frame.message)
    if (message === undefined || readString(message.role) !== 'assistant') return
    const prompt = this.activePrompt
    if (prompt === undefined) return
    const stopReason = readString(message.stopReason)
    if (stopReason !== undefined) prompt.lastStopReason = stopReason
    // message_end is authoritative; turn_end is only a fallback when the provider omitted it.
    if (prompt.usage !== undefined) return
    const usage = mapOmpUsage(message.usage)
    if (usage === undefined) return
    prompt.usage = usage
    this.emit({ kind: 'usage', usage })
  }

  private handleToolExecutionStart(frame: JsonObject): void {
    const toolCallId = readString(frame.toolCallId)
    if (toolCallId === undefined) return
    const toolName = readString(frame.toolName) ?? 'tool'
    const intent = readString(frame.intent)
    const args = frame.args
    this.emit({
      kind: 'tool_call',
      toolCallId,
      title: intent !== undefined && intent.length > 0 ? intent : toolName,
      status: 'in_progress',
      ...(args === undefined ? {} : { rawInput: args }),
    })
  }

  private handleToolExecutionEnd(frame: JsonObject): void {
    const toolCallId = readString(frame.toolCallId)
    if (toolCallId === undefined) return
    const isError = readBoolean(frame.isError) === true
    const status: NativeToolCallStatus = isError ? 'failed' : 'completed'
    const text = toolResultText(frame.result)
    this.emit({
      kind: 'tool_call_update',
      toolCallId,
      status,
      ...(text.length === 0 ? {} : { contentText: text }),
    })
  }

  private handleQueueUpdate(frame: JsonObject): void {
    const steer = this.activeSteer
    if (steer === undefined) return
    const steering = readStringArray(frame.steering)
    const queued =
      steer.text.length === 0 ? steering.length > 0 : steering.some((entry) => entry === steer.text)
    if (queued) {
      steer.admitted = true
      return
    }
    // Admission was observed and the text is gone again: OMP consumed it.
    if (steer.admitted) steer.consumed = true
  }

  private noteSteeringMessage(message: JsonObject): void {
    const steer = this.activeSteer
    if (steer === undefined) return
    if (readBoolean(message.steering) !== true && readBoolean(message.liveSteered) !== true) return
    steer.consumed = true
    steer.injected = true
    // The transcript now contains our injected message; every other signal is inference.
    this.settleSteer(steer, 'injected')
  }

  private noteAssistantUsage(rawUsage: unknown): void {
    const usage = mapOmpUsage(rawUsage)
    if (usage === undefined) return
    const prompt = this.activePrompt
    if (prompt !== undefined) prompt.usage = usage
    if (usage.total === 0 && usage.input === 0 && usage.output === 0) return
    this.emit({ kind: 'usage', usage })
  }

  private handlePromptResult(frame: JsonObject): void {
    const prompt = this.activePrompt
    if (prompt === undefined) return
    const id = readString(frame.id)
    if (id !== undefined && id !== prompt.id) return
    clearPromptTimers(prompt)
    const sessionSettled = readBoolean(frame.sessionSettled) === true
    if (sessionSettled) this.setBusy(false)
    const status = readString(frame.status) ?? 'completed'
    if (status === 'error') {
      const errorRecord = asObject(frame.error)
      const message = readString(errorRecord?.message) ?? 'OMP prompt failed'
      this.emit({ kind: 'notice', text: `OMP prompt failed: ${message}` })
      this.failPrompt(prompt, new NativeTransportError('OMP prompt failed', 'prompt-failed', message))
      return
    }
    const stopReason: NativePromptResult['stopReason'] =
      status === 'aborted' || prompt.aborted
        ? 'cancelled'
        : prompt.lastStopReason === 'length'
          ? 'max_tokens'
          : 'end_turn'
    const usage = prompt.usage
    void this.finishPrompt(prompt, {
      stopReason,
      ...(usage === undefined ? {} : { usage }),
    })
  }

  private schedulePromptResultFallback(): void {
    const prompt = this.activePrompt
    if (prompt === undefined || prompt.fallbackTimer !== undefined) return
    prompt.fallbackTimer = setTimeout(() => {
      prompt.fallbackTimer = undefined
      if (this.activePrompt !== prompt) return
      // COMPAT(ompPromptResultFallback): older OMP releases only end the run with agent_end.
      this.log('OMP did not report prompt_result; settling from the terminal run frame')
      const usage = prompt.usage
      void this.finishPrompt(prompt, {
        stopReason: prompt.aborted ? 'cancelled' : 'end_turn',
        ...(usage === undefined ? {} : { usage }),
      })
    }, PROMPT_RESULT_FALLBACK_MS)
  }

  // ---------------------------------------------------------------------------
  // Usage + busy tracking
  // ---------------------------------------------------------------------------

  contextUsage(): NativeContextUsage | undefined {
    return this.contextUsageValue
  }

  private applyContextUsage(raw: unknown): void {
    const record = asObject(raw)
    if (record === undefined) return
    const used = readNumber(record.tokens)
    const size = readNumber(record.contextWindow)
    if (used === undefined || size === undefined || size <= 0) return
    if (this.contextUsageValue?.used === used && this.contextUsageValue.size === size) return
    this.contextUsageValue = { used, size }
    this.emit({ kind: 'context_usage', contextUsage: { used, size } })
  }

  private async refreshContextUsage(
    timeoutMs: number = this.requestTimeoutMs,
  ): Promise<void> {
    if (this.closed || this.exitError !== undefined) return
    const data = asObject(await this.request({ type: 'get_session_stats' }, timeoutMs).response)
    if (data === undefined) return
    this.sessionIdValue = readString(data.sessionId) ?? this.sessionIdValue
    this.applyContextUsage(data.contextUsage)
  }

  private setBusy(busy: boolean): void {
    if (this.busy === busy) return
    this.busy = busy
    this.emit({ kind: 'status', busy })
    if (busy) this.startContextPolling()
    else this.stopContextPolling()
  }

  private startContextPolling(): void {
    this.stopContextPolling()
    const tick = (): void => {
      if (this.closed || !this.busy) return
      if (!this.contextPollInFlight) {
        this.contextPollInFlight = true
        void this.refreshContextUsage()
          .catch((error: unknown) => {
            this.log(`OMP context usage poll failed: ${errorText(error)}`)
          })
          .finally(() => {
            this.contextPollInFlight = false
          })
      }
      this.contextPollTimer = setTimeout(tick, this.contextPollIntervalMs)
    }
    tick()
  }

  private stopContextPolling(): void {
    if (this.contextPollTimer !== undefined) {
      clearTimeout(this.contextPollTimer)
      this.contextPollTimer = undefined
    }
  }

  // ---------------------------------------------------------------------------
  // Prompting
  // ---------------------------------------------------------------------------

  async prompt(content: readonly NativeContentBlock[], signal: AbortSignal): Promise<NativePromptResult> {
    if (this.closed) throw new NativeTransportError('OMP transport is closed', 'closed')
    if (this.exitError !== undefined) throw this.exitError
    if (this.activePrompt !== undefined) {
      throw new NativeTransportError('OMP prompt is already in flight', 'prompt-in-flight')
    }
    if (signal.aborted) throw abortReason(signal)
    const { message, images } = splitContent(content)
    if (message.length === 0 && images.length === 0) {
      throw new NativeTransportError('OMP prompt needs text or image content', 'empty-prompt')
    }

    const result = deferred<NativePromptResult>()
    const request = this.request(
      {
        type: 'prompt',
        message,
        ...(images.length > 0 ? { images } : {}),
      },
      this.requestTimeoutMs,
    )
    const prompt: ActivePromptState = {
      id: request.id,
      deferred: result,
      usage: undefined,
      lastStopReason: undefined,
      admissionError: undefined,
      aborted: false,
      admissionTimer: undefined,
      abortTimer: undefined,
      fallbackTimer: undefined,
      removeAbortListener: undefined,
    }
    this.activePrompt = prompt

    // The acknowledgement means "admitted", never "turn finished"; local-only slash commands
    // report `agentInvoked:false` and never emit prompt_result.
    request.response.then(
      (data) => {
        if (this.activePrompt !== prompt) return
        const record = asObject(data)
        if (record !== undefined && readBoolean(record.agentInvoked) === false) {
          void this.finishPrompt(prompt, { stopReason: 'end_turn' })
        }
      },
      (error: unknown) => {
        if (this.activePrompt !== prompt) return
        prompt.admissionError =
          error instanceof Error
            ? error
            : new NativeTransportError('OMP rejected the prompt', 'prompt-rejected', String(error))
        // Newer OMP reports rejection through prompt_result only; older builds emit a bare
        // failed response, so give the terminal frame a short grace before giving up.
        prompt.admissionTimer = setTimeout(() => {
          prompt.admissionTimer = undefined
          if (this.activePrompt !== prompt) return
          this.failPrompt(
            prompt,
            prompt.admissionError ??
              new NativeTransportError('OMP rejected the prompt', 'prompt-rejected'),
          )
        }, PROMPT_ADMISSION_GRACE_MS)
      },
    )

    const onAbort = (): void => {
      if (this.activePrompt !== prompt || prompt.aborted) return
      prompt.aborted = true
      void this.interrupt().catch((error: unknown) => {
        this.log(`OMP abort request failed: ${errorText(error)}`)
      })
      prompt.abortTimer = setTimeout(() => {
        prompt.abortTimer = undefined
        if (this.activePrompt !== prompt) return
        void this.finishPrompt(prompt, { stopReason: 'cancelled' })
      }, ABORT_SETTLE_GRACE_MS)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    prompt.removeAbortListener = () => {
      signal.removeEventListener('abort', onAbort)
    }

    return result.promise
  }

  private async finishPrompt(
    prompt: ActivePromptState,
    result: NativePromptResult,
  ): Promise<void> {
    if (this.activePrompt !== prompt) return
    this.activePrompt = undefined
    clearPromptTimers(prompt)
    prompt.removeAbortListener?.()
    prompt.removeAbortListener = undefined
    try {
      await this.refreshContextUsage(TURN_END_CONTEXT_TIMEOUT_MS)
    } catch (error) {
      this.log(`OMP context usage refresh after turn failed: ${errorText(error)}`)
    }
    prompt.deferred.resolve(result)
  }

  private failPrompt(prompt: ActivePromptState, error: Error): void {
    if (this.activePrompt !== prompt) return
    this.activePrompt = undefined
    clearPromptTimers(prompt)
    prompt.removeAbortListener?.()
    prompt.removeAbortListener = undefined
    prompt.deferred.reject(error)
  }

  async interrupt(): Promise<void> {
    if (this.closed || this.exitError !== undefined) return
    try {
      await this.request({ type: 'abort' }, this.requestTimeoutMs).response
    } catch (error) {
      // Stopping work an already-dead process is no longer running is not a failure.
      if (this.exitError === undefined) this.log(`OMP abort failed: ${errorText(error)}`)
    }
  }

  // ---------------------------------------------------------------------------
  // Steering
  // ---------------------------------------------------------------------------

  steer(
    content: readonly NativeContentBlock[],
    signal?: AbortSignal,
  ): Promise<'injected' | 'promptRequired'> {
    const run = this.steerTail.then(() => this.steerOnce(content, signal))
    this.steerTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async steerOnce(
    content: readonly NativeContentBlock[],
    signal?: AbortSignal,
  ): Promise<'injected' | 'promptRequired'> {
    if (this.closed) throw new NativeTransportError('OMP transport is closed', 'closed')
    if (this.exitError !== undefined) throw this.exitError
    if (signal?.aborted === true) throw abortReason(signal)
    const { message, images } = splitContent(content)
    if (message.length === 0 && images.length === 0) return 'promptRequired'

    const confirmation = deferred<'injected' | 'promptRequired'>()
    const steer: ActiveSteerState = {
      text: message,
      admitted: false,
      consumed: false,
      injected: false,
      deferred: confirmation,
    }
    this.activeSteer = steer
    const request = this.request(
      {
        type: 'steer',
        message,
        ...(images.length > 0 ? { images } : {}),
      },
      this.requestTimeoutMs,
    )
    try {
      await request.response
    } catch (error) {
      this.clearSteer(steer)
      if (this.exitError !== undefined) throw this.exitError
      // A definitive rejection means nothing was queued; a timeout might have been queued.
      const timedOut = error instanceof NativeTransportError && error.code === 'request-timeout'
      if (timedOut && (await this.rollbackSteer(steer.text))) return 'promptRequired'
      this.log(`OMP steer was not accepted: ${errorText(error)}`)
      if (timedOut) {
        throw new NativeTransportError(
          'OMP steering outcome could not be confirmed',
          'steer-unconfirmed',
          errorText(error),
        )
      }
      return 'promptRequired'
    }

    try {
      return await withTimeout(confirmation.promise, this.steerTimeoutMs, 'OMP steer confirmation')
    } catch (error) {
      // Timed out waiting for the transcript proof: withdraw the queued message when possible,
      // so the caller can fall back to a prompt without duplicating the user's text.
      const removed = await this.rollbackSteer(steer.text)
      const injected = steer.injected
      this.clearSteer(steer)
      // Injection may land while the rollback request is in flight.
      if (injected) return 'injected'
      if (removed) return 'promptRequired'
      if (this.exitError !== undefined) throw this.exitError
      throw new NativeTransportError(
        'OMP steering outcome could not be confirmed',
        'steer-unconfirmed',
        errorText(error),
      )
    }
  }

  private settleSteer(steer: ActiveSteerState, result: 'injected' | 'promptRequired'): void {
    if (this.activeSteer !== steer) return
    this.activeSteer = undefined
    steer.deferred.resolve(result)
  }

  private failSteer(steer: ActiveSteerState, error: Error): void {
    if (this.activeSteer !== steer) return
    this.activeSteer = undefined
    steer.deferred.reject(error)
  }

  private clearSteer(steer: ActiveSteerState): void {
    if (this.activeSteer === steer) this.activeSteer = undefined
  }

  /** Withdraw a still-queued steering message; `true` means nothing can be injected any more. */
  private async rollbackSteer(text: string): Promise<boolean> {
    if (this.closed || this.exitError !== undefined) return false
    try {
      const data = asObject(
        await this.request(
          { type: 'remove_queued_message', message: text, queue: 'steering' },
          5_000,
        ).response,
      )
      return data !== undefined && readBoolean(data.removed) === true
    } catch (error) {
      this.log(`OMP steering rollback failed: ${errorText(error)}`)
      return false
    }
  }

  // ---------------------------------------------------------------------------
  // Permission dialogs
  // ---------------------------------------------------------------------------

  private async handleExtensionUiRequest(frame: JsonObject): Promise<void> {
    const id = readString(frame.id)
    const method = readString(frame.method)
    if (id === undefined || method === undefined) return
    if (method === 'select') {
      await this.answerSelectDialog(id, frame)
      return
    }
    if (method === 'confirm' || method === 'input' || method === 'editor' || method === 'ask') {
      // Host has no dialog surface for these; dismissing is what the vendor expects and keeps
      // the agent moving (a `confirm` cancelled means "no").
      this.writeFrame({ type: 'extension_ui_response', id, cancelled: true })
      return
    }
    // notify / setStatus / setWidget / setTitle / set_editor_text / open_url / cancel need no reply.
  }

  private async answerSelectDialog(requestId: string, frame: JsonObject): Promise<void> {
    const options = mapOmpPermissionOptions(readStringArray(frame.options))
    if (options.length === 0) {
      this.writeFrame({ type: 'extension_ui_response', id: requestId, cancelled: true })
      return
    }
    const rawTitle = readString(frame.title) ?? readString(frame.message) ?? 'OMP permission request'
    const newline = rawTitle.indexOf('\n')
    const title = (newline === -1 ? rawTitle : rawTitle.slice(0, newline)).trim()
    const titleDetail = newline === -1 ? undefined : rawTitle.slice(newline + 1).trim()
    const message = readString(frame.message)
    const detailParts = [titleDetail, message].filter(
      (part): part is string => part !== undefined && part.length > 0,
    )
    const request: NativePermissionRequest = {
      requestId,
      title: title.length === 0 ? 'OMP permission request' : title,
      ...(detailParts.length === 0 ? {} : { detail: detailParts.join('\n') }),
      options,
    }
    let decision: NativePermissionDecision
    const handler = this.permissionHandler
    if (handler === undefined) {
      decision = { cancelled: true }
    } else {
      try {
        decision = await handler(request)
      } catch (error) {
        this.log(`OMP permission handler failed: ${errorText(error)}`)
        decision = { cancelled: true }
      }
    }
    if (this.closed || this.closing) return
    if ('cancelled' in decision) {
      this.writeFrame({ type: 'extension_ui_response', id: requestId, cancelled: true })
      return
    }
    const value = decision.optionId
    if (!options.some((option) => option.optionId === value)) {
      this.log(`OMP permission answer "${value}" is not one of the offered options; dismissing`)
      this.writeFrame({ type: 'extension_ui_response', id: requestId, cancelled: true })
      return
    }
    this.writeFrame({ type: 'extension_ui_response', id: requestId, value })
  }

  // ---------------------------------------------------------------------------
  // Diagnostics
  // ---------------------------------------------------------------------------

  private emit(event: NativeTransportEvent): void {
    const sink = this.eventSink
    if (sink === undefined) return
    try {
      sink(event)
    } catch (error) {
      this.log(`native event sink failed: ${errorText(error)}`)
    }
  }

  private emitNotice(text: string): void {
    this.emit({ kind: 'notice', text })
  }

  private emitNoticeFrame(frame: JsonObject): void {
    const message = readString(frame.message)
    if (message === undefined) return
    const level = readString(frame.level)
    this.emitNotice(level === 'warning' || level === 'error' ? `${level}: ${message}` : message)
  }

  private log(message: string): void {
    try {
      this.logSink?.(message)
    } catch {
      // A throwing diagnostic sink must never break frame handling.
    }
  }

  private stderrTail(): string {
    return this.stderrBuffer.trim()
  }
}

// -----------------------------------------------------------------------------
// Small lifecycle helpers
// -----------------------------------------------------------------------------

function clearPromptTimers(prompt: ActivePromptState): void {
  if (prompt.admissionTimer !== undefined) {
    clearTimeout(prompt.admissionTimer)
    prompt.admissionTimer = undefined
  }
  if (prompt.abortTimer !== undefined) {
    clearTimeout(prompt.abortTimer)
    prompt.abortTimer = undefined
  }
  if (prompt.fallbackTimer !== undefined) {
    clearTimeout(prompt.fallbackTimer)
    prompt.fallbackTimer = undefined
  }
}

/** Tool result text for a `tool_execution_end` frame. */
function toolResultText(result: unknown): string {
  if (typeof result === 'string') return result
  const record = asObject(result)
  if (record === undefined) return ''
  return contentText(record.content)
}

function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  return env
}

function normalizeEnv(given: Readonly<Record<string, string>>): Record<string, string> {
  // OMP needs HOME/PATH/credentials from the parent to find models and its session dir;
  // the host's explicit values only override what it configured.
  const env = { ...inheritedEnv(), ...given }
  if (env.NO_COLOR === undefined) env.NO_COLOR = '1'
  if (env.TERM === undefined) env.TERM = 'dumb'
  return env
}

/** Resolve a bare command through the environment the child will actually see. */
function resolveExecutable(command: string, env: Readonly<Record<string, string>>): string {
  if (command.length === 0) {
    throw new NativeTransportError('OMP command is empty', 'spawn-failed')
  }
  if (isAbsolute(command) || command.includes('/')) return command
  const pathValue = env.PATH ?? env.Path ?? ''
  const extensions =
    process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';') : ['']
  for (const directory of pathValue.split(delimiter)) {
    if (directory.length === 0) continue
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`)
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        // Try the next PATH entry.
      }
    }
  }
  return command
}

/** Create the transport selected by the shared native-transport factory. */
export function createOmpTransport(options: OmpNativeTransportOptions = {}): OmpNativeTransport {
  return new OmpNativeTransport(options)
}
