/// <reference types="node" />
/**
 * Oh My Pi (`omp`) native transport.
 *
 * Drives `omp --mode rpc-ui` (JSONL over stdio) and reports everything exactly as OMP's own ACP
 * agent (`omp acp`: src/modes/acp/acp-agent.ts + acp-event-mapper.ts) would, so state DSH saved
 * under the ACP route stays valid:
 *
 * - Identity. The ACP session id is the OMP session id. `new` runs rpc `new_session` (which, like
 *   ACP `session/new`, writes the session file immediately, so the id is resumable before its first
 *   prompt). `resume` resolves the id to a session FILE the way `AcpAgent#findStoredSession` does
 *   (the cwd's session directory first, then every session directory) and attaches it with rpc
 *   `switch_session` on the freshly booted session — the same `createSession(cwd)` +
 *   `switchSession(path)` sequence ACP runs, including OMP's refusal to switch to a session that was
 *   recorded for another cwd. `fork` is `switch_session(parent)` + rpc `fork`
 *   (`AcpAgent#forkManagedSession`). The process cwd is always the session cwd the host passes.
 * - Controls. `mode` / `model` / `thinking` follow `AcpAgent#buildConfigOptions`: ids, categories,
 *   names, descriptions and value strings (`provider/id` models; `off`, `auto` and the model's levels
 *   as thinking values). Models come from rpc `get_available_models`, levels from
 *   `get_available_thinking_levels`.
 *   Plan mode CANNOT be switched on over `--mode rpc-ui` (OMP has no rpc command for it; `/plan` is
 *   a TUI-only handler; extensions have no plan API). ACP lists `plan` next to `default` when
 *   `plan.enabled`; the native mode list is `default` only, so the UI never offers a mode that cannot
 *   be applied, and `setConfigOption('mode', 'plan')` still rejects with `plan-mode-unsupported`. ACP
 *   does not restore plan state on session load either: the current mode is always `default`.
 * - Projection. Frames map onto ACP updates with the logic of `acp-event-mapper.ts`:
 *   `tool_call` / `tool_call_update` (kind, title, rawInput/rawOutput, locations, text + diff
 *   content, the vendor tool `name`), `agent_message_chunk` / `agent_thought_chunk` with a per-message
 *   `messageId`, `plan` from the todo tool, `available_commands_update`, `session_info_update`.
 *   Like ACP, turn content is only forwarded while a `prompt()` owns the turn.
 * - Usage. Each assistant `message_end.message.usage` is summed over the whole prompt; context
 *   occupancy and cumulative cost come from `get_session_stats`.
 * - Steering. `steer()` never starts a turn (idle → `promptRequired`, like ACP's `_session/steering`);
 *   inside a running turn it returns `injected` only after OMP's three-stage proof: `queue_update`
 *   admits the text, a later `queue_update` drops it, and a `role:"user"` message flagged
 *   `steering`/`liveSteered` lands in the transcript.
 * - Approvals. DSH runs unattended, so the process starts with `--auto-approve` unless the launcher
 *   already carries an approval flag. Any `extension_ui_request {method:"select"}` that still
 *   arrives is forwarded through `onPermission` in ACP shape and answered with the chosen label;
 *   OMP's own `cancel` frame aborts the pending prompt.
 *
 * The process is spawned only through `options.spawn` (the host subprocess seam owns env merging and
 * process-tree teardown); nothing here reads the host environment, cwd or PATH.
 */
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextDecoder } from 'node:util'
import type * as acp from '@agentclientprotocol/sdk'

import { NativeTransportError } from './contract.ts'
import type {
  NativeContentBlock,
  NativeContextUsage,
  NativeControls,
  NativePermissionDecision,
  NativePermissionHandler,
  NativePermissionRequest,
  NativeProcess,
  NativePromptResult,
  NativeSessionTarget,
  NativeTransport,
  NativeTransportEvent,
  NativeTransportStartOptions,
  NativeTurnUsage,
} from './contract.ts'

/** `start()` waits this long for the first `{"type":"ready"}` frame. */
const READY_TIMEOUT_MS = 20_000
/** Default wall-clock timeout for control-plane RPCs. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
/** `get_available_models` awaits OMP's background provider discovery and may touch the network. */
const MODEL_LIST_TIMEOUT_MS = 30_000
/** Session switches load (and may migrate) a whole transcript. */
const SESSION_COMMAND_TIMEOUT_MS = 60_000
/** Context occupancy is re-read at this cadence while a turn is running. */
const CONTEXT_POLL_INTERVAL_MS = 3_000
/** How long `steer()` waits for the three-stage injection proof before rolling back. */
const DEFAULT_STEER_TIMEOUT_MS = 10_000
/** After a rejected prompt acknowledgement, wait this long for a late `prompt_result`. */
const PROMPT_ADMISSION_GRACE_MS = 1_500
/** Wait this long after the run's terminal frame before settling a prompt without `prompt_result`. */
const PROMPT_RESULT_FALLBACK_MS = 1_500
/** After the abort signal fires, wait this long for the aborted `prompt_result`. */
const ABORT_SETTLE_GRACE_MS = 10_000
/** Context-usage read used when a turn settles. */
const TURN_END_CONTEXT_TIMEOUT_MS = 3_000
/** `stdin.end()` → wait → host terminate (spec §1.4). */
const STDIN_CLOSE_GRACE_MS = 3_000
const TERMINATE_WAIT_MS = 5_000
const VERSION_PROBE_TIMEOUT_MS = 10_000
/** `start()` waits at most this long for the (usually long finished) version probe. */
const VERSION_WAIT_MS = 2_000
/** stderr is diagnostics only; keep its tail for error reports. */
const STDERR_BUFFER_LIMIT = 8_192
/** RPC v2 framing limits (spec §2.3). */
const MAX_FRAME_BYTES = 1_048_576
const MAX_REASSEMBLED_BYTES = 67_108_864
const MAX_CHUNK_BYTES = 262_144
const MAX_CHUNK_DECODED_CHARS = Math.ceil(MAX_CHUNK_BYTES / 3) * 4
const MAX_CHUNK_COUNT = Math.ceil(MAX_REASSEMBLED_BYTES / MAX_CHUNK_BYTES)
/** Failed `get_available_models` retries: delays before attempt 1..n. */
const MODEL_LIST_RETRY_DELAYS_MS: readonly number[] = [5_000, 20_000, 60_000]

const ACP_MODE_ID_DEFAULT = 'default'
const ACP_MODE_ID_PLAN = 'plan'
const THINKING_OFF = 'off'
const THINKING_AUTO = 'auto'
/** Selectors `AcpAgent#setThinkingLevelById` accepts (`parseConfiguredThinkingLevel`), minus `inherit`. */
const THINKING_SELECTORS: Readonly<Record<string, true>> = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
  auto: true,
}

type JsonObject = Record<string, unknown>

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type Deferred<T> = PromiseWithResolvers<T>

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined
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
  const result = Promise.withResolvers<T>()
  const timer = setTimeout(() => {
    result.reject(new NativeTransportError(`${label} timed out`, 'timeout', `${label} timeoutMs=${timeoutMs}`))
  }, timeoutMs)
  promise.then(
    (value) => {
      clearTimeout(timer)
      result.resolve(value)
    },
    (error: unknown) => {
      clearTimeout(timer)
      result.reject(error instanceof Error ? error : new Error(String(error)))
    },
  )
  return result.promise
}

/** `promise`'s value, or `undefined` when it does not settle within `timeoutMs`; leaves no timer behind. */
async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  const timeout = Promise.withResolvers<undefined>()
  const timer = setTimeout(timeout.resolve, timeoutMs)
  try {
    return await Promise.race([promise, timeout.promise])
  } finally {
    clearTimeout(timer)
  }
}

/** Reject with the abort reason as soon as `signal` fires; the work itself keeps running. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(abortReason(signal))
  const result = Promise.withResolvers<T>()
  const onAbort = (): void => result.reject(abortReason(signal))
  signal.addEventListener('abort', onAbort, { once: true })
  promise.then(
    (value) => {
      signal.removeEventListener('abort', onAbort)
      result.resolve(value)
    },
    (error: unknown) => {
      signal.removeEventListener('abort', onAbort)
      result.reject(error instanceof Error ? error : new Error(String(error)))
    },
  )
  return result.promise
}

/** Join host content into OMP's `message` + `images` payload (`AcpAgent#convertPromptBlocks`). */
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
  return { message: parts.join('\n\n').trim(), images }
}

// ---------------------------------------------------------------------------
// Launch arguments
// ---------------------------------------------------------------------------

/** Flags that select the protocol or the session: the transport owns them, so launcher copies are dropped. */
const OWNED_VALUE_FLAGS: Readonly<Record<string, true>> = {
  '--mode': true,
  '--session': true,
  '--resume': true,
  '-r': true,
  '--fork': true,
  '--restore': true,
}
const OWNED_BOOLEAN_FLAGS: Readonly<Record<string, true>> = {
  '--no-session': true,
  '--continue': true,
  '-c': true,
  '--print': true,
  '-p': true,
}

export interface OmpLaunchPlan {
  /** Executable first, then the arguments to spawn. */
  readonly argv: readonly string[]
  /** Same executable and launcher arguments with `--version`: prints the OMP version and exits. */
  readonly versionArgv: readonly string[]
  /** Launcher arguments the transport owns and therefore dropped (for the host log). */
  readonly dropped: readonly string[]
}

/**
 * Turn the launcher argv (`[omp, ...configured args]`) into the rpc-ui argv. The ACP subcommand `acp`
 * and every protocol/session-selecting flag are removed (sessions stay persisted: `--no-session` would
 * make ids unresumable); `--mode rpc-ui` is appended, plus `--auto-approve` unless the launcher
 * already chose an approval mode. Extension flags (`-e <file>`) pass through untouched.
 */
export function buildOmpLaunchArgv(argv: readonly string[]): OmpLaunchPlan {
  const [executable, ...rest] = argv
  if (executable === undefined || executable.length === 0) {
    throw new NativeTransportError('OMP launch argv is empty', 'spawn-failed')
  }
  const kept: string[] = []
  const dropped: string[] = []
  let approvalChosen = false
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    if (arg === undefined) continue
    if (index === 0 && arg === 'acp') {
      dropped.push(arg)
      continue
    }
    if (Object.hasOwn(OWNED_VALUE_FLAGS, arg)) {
      dropped.push(arg)
      const next = rest[index + 1]
      if (next !== undefined && !next.startsWith('-')) {
        dropped.push(next)
        index += 1
      }
      continue
    }
    const equals = arg.indexOf('=')
    if (arg.startsWith('--') && equals > 0 && Object.hasOwn(OWNED_VALUE_FLAGS, arg.slice(0, equals))) {
      dropped.push(arg)
      continue
    }
    if (Object.hasOwn(OWNED_BOOLEAN_FLAGS, arg)) {
      dropped.push(arg)
      continue
    }
    if (
      arg === '--auto-approve' ||
      arg === '--yolo' ||
      arg === '--approval-mode' ||
      arg.startsWith('--approval-mode=')
    ) {
      approvalChosen = true
    }
    kept.push(arg)
  }
  return {
    argv: [executable, ...kept, '--mode', 'rpc-ui', ...(approvalChosen ? [] : ['--auto-approve'])],
    versionArgv: [executable, ...kept, '--version'],
    dropped,
  }
}

/** argv for the host log: values that follow credential-looking flags are masked. */
function redactArgv(argv: readonly string[]): string {
  const out: string[] = []
  let mask = false
  for (const arg of argv) {
    if (mask) {
      out.push('***')
      mask = false
      continue
    }
    if (/^--?[\w-]*(key|token|secret|password)[\w-]*$/i.test(arg)) mask = true
    out.push(/^--?[\w-]*(key|token|secret|password)[\w-]*=/i.test(arg) ? `${arg.split('=')[0]}=***` : arg)
  }
  return out.join(' ')
}

// ---------------------------------------------------------------------------
// Session files
// ---------------------------------------------------------------------------

const SESSION_HEADER_READ_BYTES = 16_384
const SESSION_TAIL_BLOCK_BYTES = 65_536
const SESSION_TAIL_MAX_BYTES = 8 * 1024 * 1024
const SESSION_HEADER_SCAN_LIMIT = 5_000
const SESSION_HEADER_SCAN_CONCURRENCY = 8

export interface OmpSessionHeader {
  readonly id: string
  readonly cwd: string | undefined
}

/** The `{"type":"session"}` record near the top of an OMP session file. */
export async function readOmpSessionHeader(file: string): Promise<OmpSessionHeader | undefined> {
  let handle: FileHandle
  try {
    handle = await open(file, 'r')
  } catch {
    return undefined
  }
  try {
    const buffer = Buffer.allocUnsafe(SESSION_HEADER_READ_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, SESSION_HEADER_READ_BYTES, 0)
    for (const line of buffer.toString('utf8', 0, bytesRead).split('\n')) {
      if (!line.startsWith('{')) continue
      let record: unknown
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      const object = asObject(record)
      if (object === undefined || object.type !== 'session') continue
      const id = readString(object.id)
      if (id !== undefined) return { id, cwd: readString(object.cwd) }
    }
    return undefined
  } catch {
    return undefined
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function listDirectory(dir: string): Promise<Array<{ readonly name: string; readonly directory: boolean }>> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.map((entry) => ({ name: entry.name, directory: entry.isDirectory() }))
  } catch {
    return []
  }
}

/**
 * Resolve a stored OMP session id to its session file, the way `AcpAgent#findStoredSession` does: the
 * directory the process would store a session of this cwd in comes first, then every sibling session
 * directory (the global by-id fallback). `referenceFile` is the (not necessarily persisted) session
 * file the freshly booted process reported; its directory and the directory above are the search roots,
 * so no OMP directory convention (profiles, XDG, `PI_CODING_AGENT_DIR`) is re-implemented here.
 * Files are matched by their `<timestamp>_<id>.jsonl` name and confirmed against the header id; a header
 * scan covers files that do not carry the id in their name.
 */
export async function findOmpSessionFile(input: {
  readonly sessionId: string
  readonly referenceFile: string
  /** Further `sessions` roots to search (e.g. `<PI_CODING_AGENT_DIR>/sessions`), when the layout is not the standard one. */
  readonly extraRoots?: readonly string[]
  readonly headerScanLimit?: number
}): Promise<string | undefined> {
  const id = input.sessionId
  if (id.length === 0) return undefined
  const localDir = dirname(input.referenceFile)
  const parentDir = dirname(localDir)
  const dirs = [localDir]
  const roots = [...(basename(parentDir) === 'sessions' ? [parentDir] : []), ...(input.extraRoots ?? [])]
  for (const root of roots) {
    for (const entry of await listDirectory(root)) {
      const dir = join(root, entry.name)
      if (entry.directory && !dirs.includes(dir)) dirs.push(dir)
    }
  }
  const listings = new Map<string, string[]>()
  for (const dir of dirs) {
    const names = (await listDirectory(dir))
      .filter((entry) => !entry.directory && entry.name.endsWith('.jsonl') && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
    listings.set(dir, names)
  }
  for (const dir of dirs) {
    for (const name of listings.get(dir) ?? []) {
      if (name !== `${id}.jsonl` && !name.endsWith(`_${id}.jsonl`)) continue
      const file = join(dir, name)
      const header = await readOmpSessionHeader(file)
      if (header === undefined || header.id === id) return file
    }
  }
  // Files named `<timestamp>_<id>.jsonl` state their id; only legacy names need their header read.
  const candidates: string[] = []
  const limit = input.headerScanLimit ?? SESSION_HEADER_SCAN_LIMIT
  scan: for (const dir of dirs) {
    for (const name of listings.get(dir) ?? []) {
      if (/_[\w-]+\.jsonl$/.test(name)) continue
      if (candidates.length >= limit) break scan
      candidates.push(join(dir, name))
    }
  }
  let cursor = 0
  let found: string | undefined
  const worker = async (): Promise<void> => {
    while (found === undefined) {
      const file = candidates[cursor]
      cursor += 1
      if (file === undefined) return
      const header = await readOmpSessionHeader(file)
      if (header?.id === id) found = file
    }
  }
  await Promise.all(Array.from({ length: SESSION_HEADER_SCAN_CONCURRENCY }, () => worker()))
  return found
}

export interface OmpSessionThinking {
  /** The configured selector (`auto` or a level), when the entry carries one. */
  readonly configured: string | undefined
  /** The concrete level the entry recorded. */
  readonly level: string | undefined
}

/**
 * The newest `thinking_level_change` entry of a session file. `get_state.thinkingLevel` only reports
 * the resolved level, so this is how `auto` (which OMP persists as `configured: "auto"` and restores on
 * resume) is told apart from a pinned level.
 */
export async function readOmpSessionThinking(
  file: string,
  maxBytes: number = SESSION_TAIL_MAX_BYTES,
): Promise<OmpSessionThinking | undefined> {
  let handle: FileHandle
  try {
    handle = await open(file, 'r')
  } catch {
    return undefined
  }
  try {
    const { size } = await handle.stat()
    let position = size
    let scanned = 0
    let carry: Buffer = Buffer.alloc(0)
    while (position > 0 && scanned < maxBytes) {
      const length = Math.min(SESSION_TAIL_BLOCK_BYTES, position)
      position -= length
      const block = Buffer.allocUnsafe(length)
      const { bytesRead } = await handle.read(block, 0, length, position)
      scanned += bytesRead
      const chunk = Buffer.concat([block.subarray(0, bytesRead), carry])
      let complete: Buffer
      if (position === 0) {
        complete = chunk
        carry = Buffer.alloc(0)
      } else {
        const firstNewline = chunk.indexOf(0x0a)
        if (firstNewline === -1) {
          carry = chunk
          continue
        }
        carry = chunk.subarray(0, firstNewline)
        complete = chunk.subarray(firstNewline + 1)
      }
      const lines = complete.toString('utf8').split('\n')
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]
        if (line === undefined || !line.includes('"thinking_level_change"')) continue
        let record: unknown
        try {
          record = JSON.parse(line)
        } catch {
          continue
        }
        const entry = asObject(record)
        if (entry === undefined || entry.type !== 'thinking_level_change') continue
        return { configured: readString(entry.configured), level: readString(entry.thinkingLevel) }
      }
    }
    return undefined
  } catch {
    return undefined
  } finally {
    await handle.close().catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// Models and controls (`AcpAgent#buildConfigOptions` / `#getAvailableModes`)
// ---------------------------------------------------------------------------

export interface OmpModelInfo {
  readonly provider: string
  readonly id: string
  readonly name: string
  readonly reasoning: boolean
  /** Input modalities the model accepts (`text`, `image`). */
  readonly input: readonly string[]
}

export function parseOmpModel(raw: unknown): OmpModelInfo | undefined {
  const record = asObject(raw)
  if (record === undefined) return undefined
  const provider = readString(record.provider)
  const id = readString(record.id)
  if (provider === undefined || provider.length === 0 || id === undefined || id.length === 0) return undefined
  return {
    provider,
    id,
    name: readString(record.name) ?? id,
    reasoning: readBoolean(record.reasoning) === true,
    input: readStringArray(record.input),
  }
}

/** ACP model value: `AcpAgent#toModelId`. */
export function ompModelValue(model: Pick<OmpModelInfo, 'provider' | 'id'>): string {
  return `${model.provider}/${model.id}`
}

export interface OmpControlsInput {
  readonly models: readonly OmpModelInfo[]
  readonly model: OmpModelInfo | undefined
  /** `get_available_thinking_levels` (leading `off` included). */
  readonly thinkingLevels: readonly string[]
  /** Concrete effective level the session reports. */
  readonly thinkingLevel: string | undefined
  /** Whether the configured selector is `auto`. */
  readonly thinkingAuto: boolean
}

/**
 * The ACP `session/new` controls of an OMP session, rebuilt from rpc facts. The mode list is `default`
 * only: ACP adds `plan` when `plan.enabled`, but plan mode cannot be applied over rpc-ui.
 */
export function deriveOmpControls(input: OmpControlsInput): NativeControls {
  const availableModes: acp.SessionMode[] = [
    { id: ACP_MODE_ID_DEFAULT, name: 'Default', description: 'Standard ACP headless mode' },
  ]
  const modes: acp.SessionModeState = { availableModes, currentModeId: ACP_MODE_ID_DEFAULT }

  const configOptions: acp.SessionConfigOption[] = [
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: modes.currentModeId,
      options: availableModes.map((mode) => ({
        value: mode.id,
        name: mode.name,
        ...(mode.description === undefined || mode.description === null ? {} : { description: mode.description }),
      })),
    },
  ]
  const first = input.models[0]
  if (first !== undefined) {
    configOptions.push({
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: ompModelValue(input.model ?? first),
      options: input.models.map((model) => ({
        value: ompModelValue(model),
        name: model.name,
        description: `${model.provider}/${model.id}`,
      })),
    })
  }
  const efforts = input.thinkingLevels.filter((level) => level !== THINKING_OFF)
  const configured = input.model?.reasoning === true ? (input.thinkingAuto ? THINKING_AUTO : input.thinkingLevel) : undefined
  configOptions.push({
    id: 'thinking',
    name: 'Thinking',
    category: 'thought_level',
    type: 'select',
    currentValue: configured !== undefined && configured !== 'inherit' && configured.length > 0 ? configured : THINKING_OFF,
    options: [
      { value: THINKING_OFF, name: 'Off' },
      { value: THINKING_AUTO, name: 'Auto', description: 'Auto-detect per prompt' },
      ...efforts.map((level) => ({ value: level, name: level })),
    ],
  })
  return { configOptions, modes, imageInput: input.model?.input.includes('image') === true }
}

function controlsSignature(controls: NativeControls): string {
  return JSON.stringify([controls.configOptions, controls.modes, controls.imageInput])
}

// ---------------------------------------------------------------------------
// Permission dialogs
// ---------------------------------------------------------------------------

function permissionOptionKind(label: string): acp.PermissionOptionKind {
  const normalized = label.trim().toLowerCase()
  if (
    normalized === 'deny' ||
    normalized === 'no' ||
    normalized === 'cancel' ||
    normalized.startsWith('deny ') ||
    normalized.startsWith('deny:') ||
    normalized.startsWith('reject') ||
    normalized.startsWith('decline') ||
    normalized.startsWith('abort')
  ) {
    return 'reject_once'
  }
  // Grants remember the answer (a folder/file for the session, or across sessions): never `allow_once`,
  // so a policy that wants the narrowest approval picks `Approve` / `Approve Once`.
  if (
    normalized.startsWith('always') ||
    normalized.includes('for this session') ||
    normalized.startsWith('approve directory') ||
    normalized.startsWith('approve file')
  ) {
    return 'allow_always'
  }
  return 'allow_once'
}

/**
 * Map the vendor's `select` labels to ACP permission options. Labels are kept verbatim as `optionId`
 * because OMP matches the echoed `value` against them; `always-ask-cached` adds directory/file grant
 * labels, so nothing here assumes exactly two options.
 */
export function mapOmpPermissionOptions(options: readonly string[]): acp.PermissionOption[] {
  return options.map((label) => ({ optionId: label, name: label, kind: permissionOptionKind(label) }))
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/** Sums `message_end.message.usage` over one prompt turn (OMP reports usage per model call). */
export class OmpUsageAccumulator {
  private input = 0
  private output = 0
  private cacheRead = 0
  private cacheWrite = 0
  private reasoning = 0
  private cost = 0
  private sawUsage = false
  private sawReasoning = false
  private sawCost = false
  private readonly counted = new Set<string>()

  /** Add one message's usage; returns false when the payload carries no token accounting. */
  add(usage: unknown, messageId?: string): boolean {
    const record = asObject(usage)
    if (record === undefined) return false
    const input = readNumber(record.input)
    const output = readNumber(record.output)
    const cacheRead = readNumber(record.cacheRead)
    const cacheWrite = readNumber(record.cacheWrite)
    if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) {
      return false
    }
    if (messageId !== undefined) {
      if (this.counted.has(messageId)) return false
      this.counted.add(messageId)
    }
    this.sawUsage = true
    this.input += input ?? 0
    this.output += output ?? 0
    this.cacheRead += cacheRead ?? 0
    this.cacheWrite += cacheWrite ?? 0
    const reasoning = readNumber(record.reasoningTokens)
    if (reasoning !== undefined) {
      this.sawReasoning = true
      this.reasoning += reasoning
    }
    const cost = readNumber(asObject(record.cost)?.total)
    if (cost !== undefined) {
      this.sawCost = true
      this.cost += cost
    }
    return true
  }

  /** The turn total, or `undefined` when no tokens were accounted (ACP omits an all-zero usage). */
  snapshot(): NativeTurnUsage | undefined {
    if (!this.sawUsage || this.input + this.output + this.cacheRead + this.cacheWrite === 0) return undefined
    return {
      inputTokens: this.input,
      outputTokens: this.output,
      cachedReadTokens: this.cacheRead,
      cachedWriteTokens: this.cacheWrite,
      ...(this.sawReasoning ? { thoughtTokens: this.reasoning } : {}),
      ...(this.sawCost ? { costUsd: this.cost } : {}),
    }
  }
}

/** Sum a list of OMP usage payloads (one per model call) into a turn usage. */
export function sumOmpUsage(usages: readonly unknown[]): NativeTurnUsage | undefined {
  const accumulator = new OmpUsageAccumulator()
  for (const usage of usages) accumulator.add(usage)
  return accumulator.snapshot()
}

// ---------------------------------------------------------------------------
// Event projection (`acp-event-mapper.ts`)
// ---------------------------------------------------------------------------

type SessionUpdateOf<K extends acp.SessionUpdate['sessionUpdate']> = Extract<acp.SessionUpdate, { sessionUpdate: K }>

const ACP_TEXT_LIMIT = 4_000
/** `scheme://…` subjects name internal resources, never local files. */
const INTERNAL_URL_SUBJECT = /^[a-z][a-z0-9+.-]*:\/\//i
const UNICODE_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g
/** `AssistantMessage.errorMessage` of an expected internal abort that must not surface. */
const SILENT_ABORT_MARKER = '__omp.silent_abort__'

function limitText(text: string): string {
  return text.length > ACP_TEXT_LIMIT ? `${text.slice(0, ACP_TEXT_LIMIT - 1)}…` : text
}

/** `canonicalizeMessage` of @oh-my-pi/pi-tui: text that is only dots/ellipses/whitespace is empty. */
function canonicalizeMessage(text: string | null | undefined): string {
  if (!text) return ''
  const trimmed = text.trim()
  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index)
    if (code !== 0x2e && code !== 0x2026 && code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      return trimmed
    }
  }
  return ''
}

function normalizeText(text: string | undefined): string | undefined {
  if (!text) return undefined
  const normalized = text.trim()
  return normalized.length > 0 ? limitText(normalized) : undefined
}

function stringProp(value: unknown, key: string): string | undefined {
  const record = asObject(value)
  const property = record?.[key]
  return typeof property === 'string' && property.length > 0 ? property : undefined
}

function safeJsonStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

function textToolContent(text: string): acp.ToolCallContent {
  return { type: 'content', content: { type: 'text', text } }
}

function hasEquivalentText(content: readonly acp.ToolCallContent[], text: string): boolean {
  return content.some((item) => item.type === 'content' && item.content.type === 'text' && item.content.text === text)
}

function writeTargetScheme(toolName: string, args: unknown): string | undefined {
  if (toolName !== 'write') return undefined
  const path = stringProp(args, 'path')
  if (path === undefined) return undefined
  return /^([a-z][a-z0-9+.-]*):\/\//i.exec(path)?.[1]?.toLowerCase()
}

/** Peer-to-peer messages (OMP `scope: "coordination"` writes to `agent://`) stay off the external ACP stream. */
function isInternalAgentMessageTool(toolName: string, args: unknown): boolean {
  return writeTargetScheme(toolName, args) === 'agent'
}

/** `mapToolKind` of acp-event-mapper.ts. */
export function mapOmpToolKind(toolName: string, args?: unknown): acp.ToolKind {
  // A device write (xd:// tool dispatch, proc:// control) executes something: "edit" would make clients
  // render a file modification to a nonexistent path.
  const scheme = writeTargetScheme(toolName, args)
  if (scheme === 'xd' || scheme === 'proc') return 'execute'
  switch (toolName) {
    case 'read':
      return 'read'
    case 'write':
    case 'edit':
      return 'edit'
    case 'delete':
      return 'delete'
    case 'move':
      return 'move'
    case 'bash':
    case 'shell':
    case 'exec':
    case 'eval':
      return 'execute'
    case 'grep':
    case 'glob':
    case 'ast_grep':
      return 'search'
    case 'web_search':
      return 'fetch'
    case 'todo':
      return 'think'
    default:
      return 'other'
  }
}

function buildEvalStartText(args: unknown): string | undefined {
  const record = asObject(args)
  if (record === undefined) return undefined
  const cells = Array.isArray(record.cells) ? record.cells : typeof record.code === 'string' ? [record] : []
  if (cells.length === 0) return undefined
  const lines: string[] = []
  for (const cell of cells) {
    if (asObject(cell) === undefined) continue
    const language = stringProp(cell, 'language') ?? '?'
    const title = stringProp(cell, 'title')
    const code = stringProp(cell, 'code')
    if (!code) continue
    lines.push(title ? `[${language}] ${title}` : `[${language}]`, code)
  }
  return lines.length > 0 ? limitText(lines.join('\n')) : undefined
}

function buildToolStartText(toolName: string, args: unknown): string | undefined {
  if (toolName === 'bash' || toolName === 'shell' || toolName === 'exec') {
    const command = stringProp(args, 'command')
    return command ? limitText(`$ ${command}`) : undefined
  }
  if (toolName === 'eval') return buildEvalStartText(args)
  return undefined
}

function buildToolStartContent(toolName: string, args: unknown): acp.ToolCallContent[] {
  const text = buildToolStartText(toolName, args)
  return text ? [textToolContent(text)] : []
}

/** `buildToolTitle` of acp-event-mapper.ts. */
export function buildOmpToolTitle(toolName: string, args: unknown, intent?: string): string {
  // Command tools show the command line, eval shows its cells; both double as the start content.
  const startText = buildToolStartText(toolName, args)
  if (startText) return startText
  const trimmedIntent = intent?.trim()
  if (trimmedIntent) return trimmedIntent
  const subject =
    stringProp(args, 'path') ?? stringProp(args, 'command') ?? stringProp(args, 'pattern') ?? stringProp(args, 'query')
  if (subject) {
    // Internal URLs (xd://github, skill://react, …) name their target fully.
    if (INTERNAL_URL_SUBJECT.test(subject)) return subject
    return `${toolName}: ${subject}`
  }
  return toolName
}

function mergeToolUpdateContent(
  startContent: readonly acp.ToolCallContent[],
  resultContent: readonly acp.ToolCallContent[],
): acp.ToolCallContent[] {
  if (startContent.length === 0) return [...resultContent]
  const merged = [...startContent]
  for (const item of resultContent) {
    if (item.type === 'content' && item.content.type === 'text' && hasEquivalentText(merged, item.content.text)) continue
    merged.push(item)
  }
  return merged
}

interface ProjectionContext {
  readonly cwd: string
  readonly home: string
  readonly isFile: (path: string) => boolean
}

function toLocationPath(raw: string, ctx: ProjectionContext): string {
  let value = raw.replace(UNICODE_SPACES, ' ')
  if (value.startsWith('@')) {
    const rest = value.slice(1)
    if (rest.startsWith('/') || rest === '~' || rest.startsWith('~/')) value = rest
  }
  if (value.toLowerCase().startsWith('file://')) {
    try {
      value = fileURLToPath(value)
    } catch {
      // Keep the raw value.
    }
  }
  if (value === '~') value = ctx.home
  else if (value.startsWith('~/')) value = ctx.home + value.slice(1)
  if (/^\/+$/.test(value)) return ctx.cwd
  return isAbsolute(value) ? value : resolvePath(ctx.cwd, value)
}

function existingFileLocationPath(raw: string | undefined, ctx: ProjectionContext): string | undefined {
  if (!raw || INTERNAL_URL_SUBJECT.test(raw)) return undefined
  const resolved = toLocationPath(raw, ctx)
  return ctx.isFile(resolved) ? resolved : undefined
}

/**
 * The single existing file a `read` argument names: read inputs may carry selectors (`file:20-40`),
 * globs, directories or internal resources, and only a regular file is safe to publish as a location.
 */
function readLocationBasePath(raw: string | undefined, ctx: ProjectionContext, toolName: string | undefined): string | undefined {
  if (raw === undefined || toolName !== 'read') return raw
  if (INTERNAL_URL_SUBJECT.test(raw)) return undefined
  if (ctx.isFile(toLocationPath(raw, ctx))) return existingFileLocationPath(raw, ctx)
  const match = /^(.*[^:]):([A-Za-z0-9_,+.-]+(?::[A-Za-z]+)?)$/.exec(raw)
  return existingFileLocationPath(match?.[1] ?? raw, ctx)
}

function extractToolLocations(args: unknown, ctx: ProjectionContext, toolName?: string): acp.ToolCallLocation[] {
  const locations: acp.ToolCallLocation[] = []
  const seen = new Set<string>()
  const push = (raw: string | undefined): void => {
    if (!raw || INTERNAL_URL_SUBJECT.test(raw)) return
    const path = toLocationPath(raw, ctx)
    if (seen.has(path)) return
    seen.add(path)
    locations.push({ path })
  }
  push(readLocationBasePath(stringProp(args, 'path'), ctx, toolName))
  push(stringProp(args, 'oldPath'))
  push(stringProp(args, 'newPath'))
  return locations
}

/** Locations from a result's details (e.g. `EditToolDetails.perFileResults[].path`). */
function extractToolLocationsFromResult(result: unknown, ctx: ProjectionContext): acp.ToolCallLocation[] {
  const details = asObject(asObject(result)?.details)
  if (details === undefined) return []
  const direct = extractToolLocations(details, ctx)
  const resolvedFile = existingFileLocationPath(stringProp(details, 'resolvedPath'), ctx)
  if (resolvedFile && !direct.some((location) => location.path === resolvedFile)) direct.push({ path: resolvedFile })
  const perFile = readArray(details.perFileResults)
  if (perFile === undefined) return direct
  const seen = new Set(direct.map((location) => location.path))
  const locations = [...direct]
  for (const entry of perFile) {
    const raw = stringProp(entry, 'path')
    if (!raw) continue
    const path = toLocationPath(raw, ctx)
    if (seen.has(path)) continue
    seen.add(path)
    locations.push({ path })
  }
  return locations
}

function buildDiffContent(entry: unknown): acp.ToolCallContent | undefined {
  const record = asObject(entry)
  if (record === undefined || record.isError === true) return undefined
  const path = stringProp(record, 'path')
  if (!path) return undefined
  const oldText = readString(record.oldText)
  const newText = readString(record.newText)
  if (oldText === undefined && newText === undefined) return undefined
  return { type: 'diff', path, oldText: oldText ?? null, newText: newText ?? '' }
}

/** A `diff` content block for each per-file edit result that carries oldText/newText. */
function extractDiffToolCallContent(result: unknown): acp.ToolCallContent[] {
  const details = asObject(asObject(result)?.details)
  if (details === undefined) return []
  const perFile = readArray(details.perFileResults)
  const entries: unknown[] = perFile ?? [details]
  const blocks: acp.ToolCallContent[] = []
  for (const entry of entries) {
    const block = buildDiffContent(entry)
    if (block) blocks.push(block)
  }
  return blocks
}

function extractTerminalId(value: unknown): string | undefined {
  return stringProp(value, 'terminalId') ?? stringProp(asObject(value)?.details, 'terminalId')
}

/** `tool_execution_update` status: only a settled background-job frame settles the call. */
function toolUpdateStatus(partialResult: unknown): 'in_progress' | 'completed' | 'failed' {
  const details = asObject(asObject(partialResult)?.details)
  if (details === undefined) return 'in_progress'
  const state = stringProp(details.async, 'state')
  if (state === 'completed') return 'completed'
  return state === 'failed' || state === 'cancelled' ? 'failed' : 'in_progress'
}

function getContentBlocks(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value
  const record = asObject(value)
  const content = record?.content
  return Array.isArray(content) ? content : undefined
}

function extractStructuredText(value: unknown): string | undefined {
  const text = stringProp(value, 'text')
  return text ? limitText(text) : undefined
}

function binaryToolContent(type: 'image' | 'audio', value: unknown): acp.ToolCallContent | undefined {
  const data = stringProp(value, 'data')
  const mimeType = stringProp(value, 'mimeType')
  if (!data || !mimeType) return undefined
  return { type: 'content', content: { type, data, mimeType } }
}

function toToolCallContent(value: unknown): acp.ToolCallContent | undefined {
  const type = readString(asObject(value)?.type)
  switch (type) {
    case 'text': {
      const text = extractStructuredText(value)
      return text ? textToolContent(text) : undefined
    }
    case 'image':
    case 'audio':
      return binaryToolContent(type, value)
    case 'resource_link': {
      const uri = stringProp(value, 'uri')
      const name = stringProp(value, 'name')
      if (!uri || !name) return undefined
      const title = stringProp(value, 'title')
      const description = stringProp(value, 'description')
      const mimeType = stringProp(value, 'mimeType')
      const size = readNumber(asObject(value)?.size)
      return {
        type: 'content',
        content: {
          type: 'resource_link',
          uri,
          name,
          ...(title ? { title } : {}),
          ...(description ? { description } : {}),
          ...(mimeType ? { mimeType } : {}),
          ...(size !== undefined ? { size } : {}),
        },
      }
    }
    case 'resource': {
      const resource = asObject(asObject(value)?.resource)
      const uri = stringProp(resource, 'uri')
      if (!uri) return undefined
      const mimeType = stringProp(resource, 'mimeType')
      const text = stringProp(resource, 'text')
      if (text) return { type: 'content', content: { type: 'resource', resource: { uri, text, ...(mimeType ? { mimeType } : {}) } } }
      const blob = stringProp(resource, 'blob')
      if (!blob) return undefined
      return { type: 'content', content: { type: 'resource', resource: { uri, blob, ...(mimeType ? { mimeType } : {}) } } }
    }
    default:
      return undefined
  }
}

function imageContentKey(value: acp.ToolCallContent): string | undefined {
  if (value.type !== 'content' || value.content.type !== 'image') return undefined
  return `${value.content.mimeType}\u0000${value.content.data}`
}

function extractDetailsImages(value: unknown): unknown[] | undefined {
  const images = readArray(asObject(asObject(value)?.details)?.images)
  return images !== undefined && images.length > 0 ? images : undefined
}

function isTerminalOnlyDetails(value: unknown): boolean {
  if (extractTerminalId(value) === undefined) return false
  const content = asObject(value)?.content
  return content === undefined || (Array.isArray(content) && content.length === 0)
}

function extractReadableText(value: unknown): string | undefined {
  if (typeof value === 'string') return normalizeText(value)
  if (value instanceof Error) return normalizeText(value.message)
  if (typeof value !== 'object' || value === null) return undefined
  const directText = stringProp(value, 'text') ?? stringProp(value, 'errorMessage') ?? stringProp(value, 'message')
  if (directText) return normalizeText(directText)
  const blocks = getContentBlocks(value)
  if (blocks) {
    const text = blocks
      .map((block) => extractStructuredText(block))
      .filter((chunk): chunk is string => typeof chunk === 'string' && chunk.length > 0)
      .join('\n')
    if (text.length > 0) return normalizeText(text)
    // A structured envelope whose blocks carry no text has nothing readable; its data rides as rawOutput.
    return undefined
  }
  if (extractDetailsImages(value)) return undefined
  if (isTerminalOnlyDetails(value)) return undefined
  return normalizeText(safeJsonStringify(value))
}

/** `extractToolCallContent` of acp-event-mapper.ts. */
function extractToolCallContent(value: unknown): acp.ToolCallContent[] {
  const rich: acp.ToolCallContent[] = []
  for (const block of getContentBlocks(value) ?? []) {
    const content = toToolCallContent(block)
    if (content) rich.push(content)
  }
  const seen = new Set(rich.map(imageContentKey).filter((key): key is string => key !== undefined))
  const imageContent: acp.ToolCallContent[] = []
  for (const image of extractDetailsImages(value) ?? []) {
    const content = binaryToolContent('image', image)
    const key = content === undefined ? undefined : imageContentKey(content)
    if (!content || !key || seen.has(key)) continue
    seen.add(key)
    imageContent.push(content)
  }
  const combined = [...rich, ...imageContent]
  const terminalId = extractTerminalId(value)
  const content: acp.ToolCallContent[] =
    terminalId && !combined.some((item) => item.type === 'terminal' && item.terminalId === terminalId)
      ? [...combined, { type: 'terminal', terminalId }]
      : combined
  const fallbackText = extractReadableText(value)
  if (!fallbackText || hasEquivalentText(content, fallbackText)) return content
  return [...content, textToolContent(fallbackText)]
}

/** Extract the visible text of an assistant message (`extractAssistantMessageText`). */
export function extractOmpAssistantText(message: unknown): string {
  const content = asObject(message)?.content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => extractStructuredText(block))
    .filter((chunk): chunk is string => typeof chunk === 'string' && chunk.length > 0)
    .join('\n')
}

type PlanStatus = 'pending' | 'in_progress' | 'completed'
const TODO_STATUS: Readonly<Record<string, PlanStatus>> = {
  pending: 'pending',
  in_progress: 'in_progress',
  completed: 'completed',
  abandoned: 'completed',
  blocked: 'pending',
}

function planEntry(content: string, status: unknown): acp.PlanEntry {
  return { content, priority: 'medium', status: (typeof status === 'string' ? TODO_STATUS[status] : undefined) ?? 'pending' }
}

function todoResultToPlan(toolName: string, isError: boolean, result: unknown): SessionUpdateOf<'plan'> | undefined {
  if (toolName !== 'todo' || isError) return undefined
  const phases = asObject(asObject(result)?.details)?.phases
  if (!Array.isArray(phases)) return undefined
  const entries: acp.PlanEntry[] = []
  for (const phase of phases) {
    const tasks = asObject(phase)?.tasks
    if (!Array.isArray(tasks)) continue
    for (const task of tasks) {
      const content = stringProp(task, 'content')
      if (content) entries.push(planEntry(content, asObject(task)?.status))
    }
  }
  return { sessionUpdate: 'plan', entries }
}

/** A tool call the vendor started and has not finished (for matching approval dialogs). */
export interface OmpOpenToolCall {
  readonly toolCallId: string
  readonly toolName: string
  readonly title: string
  readonly kind: acp.ToolKind
  readonly rawInput: unknown
  readonly content: readonly acp.ToolCallContent[]
  readonly locations: readonly acp.ToolCallLocation[]
}

export interface OmpProjectorOptions {
  /** Session cwd: relative tool paths resolve against it. */
  readonly cwd: string
  /** Existence probe used to publish `read` locations (default: `fs.statSync(path).isFile()`). */
  readonly isFile?: (path: string) => boolean
  readonly homeDir?: string | undefined
  /** Message id factory (default `crypto.randomUUID`). */
  readonly newMessageId?: () => string
}

interface LiveMessage {
  readonly id: string
  textEmitted: boolean
  /** Thinking text accumulated per content index (deltas stream without the partial message). */
  readonly thinking: Map<number, string>
}

/**
 * Pure projection of OMP session frames onto ACP session updates, following `acp-event-mapper.ts`
 * and the live-message bookkeeping of `AcpAgent`. Frames arrive in `messageUpdates: "delta"` form, so
 * thinking blocks are accumulated here instead of read from the partial message.
 */
export class OmpEventProjector {
  private readonly ctx: ProjectionContext
  private readonly newId: () => string
  private live: LiveMessage | undefined
  private errorTextEmitted = false
  private readonly toolArgs = new Map<string, unknown>()
  private readonly open = new Map<string, OmpOpenToolCall>()

  constructor(options: OmpProjectorOptions) {
    this.ctx = {
      cwd: options.cwd,
      home: options.homeDir ?? homedir(),
      isFile:
        options.isFile ??
        ((path: string): boolean => {
          try {
            return statSync(path).isFile()
          } catch {
            return false
          }
        }),
    }
    this.newId = options.newMessageId ?? randomUUID
  }

  /** Forget every per-turn fact (a session switch or a new prompt). */
  reset(): void {
    this.live = undefined
    this.errorTextEmitted = false
    this.toolArgs.clear()
    this.open.clear()
  }

  /** The newest unfinished call, preferring one of `toolName`. */
  findOpenToolCall(toolName?: string): OmpOpenToolCall | undefined {
    const calls = [...this.open.values()]
    if (toolName !== undefined) {
      for (let index = calls.length - 1; index >= 0; index -= 1) {
        const call = calls[index]
        if (call?.toolName === toolName) return call
      }
    }
    return calls[calls.length - 1]
  }

  /** Project one session frame; frames that carry no ACP-visible change return `[]`. */
  project(frame: JsonObject): acp.SessionUpdate[] {
    switch (readString(frame.type)) {
      case 'message_start':
      case 'message_update':
      case 'message_end':
        return this.projectMessage(frame)
      case 'tool_execution_start':
        return this.toolStart(frame)
      case 'tool_execution_update':
        return this.toolUpdate(frame)
      case 'tool_execution_end':
        return this.toolEnd(frame)
      case 'todo_reminder': {
        const entries: acp.PlanEntry[] = []
        for (const todo of readArray(frame.todos) ?? []) {
          const content = readString(asObject(todo)?.content)
          if (content !== undefined) entries.push(planEntry(content, asObject(todo)?.status))
        }
        return [{ sessionUpdate: 'plan', entries }]
      }
      case 'todo_auto_clear':
        return [{ sessionUpdate: 'plan', entries: [] }]
      case 'command_output': {
        const text = readString(frame.text)
        return text ? [this.messageChunk('agent_message_chunk', { type: 'text', text }, this.newId())] : []
      }
      default:
        return []
    }
  }

  /**
   * End-of-turn fallback (`#flushUnreportedTurnError`): a provider failure that never streamed a
   * message (e.g. `HTTP 410 model_sunset` before any token) still has to reach the client as text.
   */
  flushTurnError(input: { readonly assistantError?: string | undefined; readonly promptError?: string | undefined }): acp.SessionUpdate[] {
    if (this.errorTextEmitted) return []
    const message = input.assistantError ?? input.promptError
    if (message === undefined || message.length === 0) return []
    this.errorTextEmitted = true
    return [this.messageChunk('agent_message_chunk', { type: 'text', text: message }, this.live?.id ?? this.newId())]
  }

  private messageChunk(
    kind: 'agent_message_chunk' | 'agent_thought_chunk',
    content: acp.ContentBlock,
    messageId: string | undefined,
  ): SessionUpdateOf<'agent_message_chunk'> | SessionUpdateOf<'agent_thought_chunk'> {
    return { sessionUpdate: kind, content, ...(messageId === undefined ? {} : { messageId }) }
  }

  private prepareLive(type: string, role: string | undefined): LiveMessage | undefined {
    if (role !== 'assistant') return this.live
    if (type === 'message_start' || this.live === undefined) {
      this.live = { id: this.newId(), textEmitted: false, thinking: new Map() }
    }
    return this.live
  }

  private projectMessage(frame: JsonObject): acp.SessionUpdate[] {
    const type = readString(frame.type) ?? ''
    const message = asObject(frame.message)
    const role = readString(message?.role)
    const live = this.prepareLive(type, role)
    if (role !== 'assistant' || live === undefined) return []
    if (type === 'message_start') return []
    if (type === 'message_update') return this.assistantUpdate(frame, live)
    const updates = this.assistantEnd(message, live)
    // The assistant `message_end` closes the live message (`#clearLiveAssistantMessageAfterEvent`).
    this.live = undefined
    return updates
  }

  private assistantUpdate(frame: JsonObject, live: LiveMessage): acp.SessionUpdate[] {
    const event = asObject(frame.assistantMessageEvent)
    if (event === undefined) return []
    let kind: 'agent_message_chunk' | 'agent_thought_chunk'
    let text: string
    switch (readString(event.type)) {
      case 'image_end': {
        const content = asObject(event.content)
        return content === undefined ? [] : [this.messageChunk('agent_message_chunk', content as unknown as acp.ContentBlock, live.id)]
      }
      case 'text_delta':
        kind = 'agent_message_chunk'
        text = readString(event.delta) ?? ''
        if (text.length > 0) live.textEmitted = true
        break
      case 'thinking_start':
        live.thinking.set(readNumber(event.contentIndex) ?? 0, '')
        return []
      case 'thinking_delta': {
        const index = readNumber(event.contentIndex) ?? 0
        text = readString(event.delta) ?? ''
        const accumulated = (live.thinking.get(index) ?? '') + text
        live.thinking.set(index, accumulated)
        // The ACP mapper drops deltas while the block so far canonicalizes to nothing.
        if (!canonicalizeMessage(accumulated)) return []
        kind = 'agent_thought_chunk'
        break
      }
      case 'done':
        if (live.textEmitted) return []
        kind = 'agent_message_chunk'
        text = extractOmpAssistantText(event.message)
        if (text.length > 0) live.textEmitted = true
        break
      case 'error': {
        kind = 'agent_message_chunk'
        text = readString(asObject(event.error)?.errorMessage) ?? 'Unknown error'
        if (text.length > 0) live.textEmitted = true
        this.errorTextEmitted = true
        break
      }
      default:
        return []
    }
    return text.length === 0 ? [] : [this.messageChunk(kind, { type: 'text', text }, live.id)]
  }

  private assistantEnd(message: JsonObject | undefined, live: LiveMessage): acp.SessionUpdate[] {
    const updates: acp.SessionUpdate[] = []
    // Narration streams as thinking; once its block closes as narration, ACP surfaces it as the reply.
    // Delta frames carry no block flags, so the closed message is where narration is recognized.
    for (const block of readArray(message?.content) ?? []) {
      const record = asObject(block)
      if (record?.type !== 'thinking' || record.narration !== true) continue
      const text = canonicalizeMessage(readString(record.thinking))
      if (text.length === 0) continue
      live.textEmitted = true
      updates.push(this.messageChunk('agent_message_chunk', { type: 'text', text }, live.id))
    }
    if (live.textEmitted) return updates
    const text = extractOmpAssistantText(message)
    if (text.length === 0) return updates
    live.textEmitted = true
    updates.push(this.messageChunk('agent_message_chunk', { type: 'text', text }, live.id))
    return updates
  }

  private toolStart(frame: JsonObject): acp.SessionUpdate[] {
    const toolCallId = readString(frame.toolCallId)
    if (toolCallId === undefined) return []
    const toolName = readString(frame.toolName) ?? 'tool'
    const args = frame.args
    if (isInternalAgentMessageTool(toolName, args)) return []
    this.toolArgs.set(toolCallId, args)
    const content = buildToolStartContent(toolName, args)
    const locations = extractToolLocations(args, this.ctx, toolName)
    const title = buildOmpToolTitle(toolName, args, readString(frame.intent))
    const kind = mapOmpToolKind(toolName, args)
    this.open.set(toolCallId, { toolCallId, toolName, title, kind, rawInput: args, content, locations })
    return [
      {
        sessionUpdate: 'tool_call',
        toolCallId,
        title,
        name: toolName,
        kind,
        status: 'pending',
        rawInput: args,
        ...(content.length > 0 ? { content } : {}),
        ...(locations.length > 0 ? { locations } : {}),
      },
    ]
  }

  private toolUpdate(frame: JsonObject): acp.SessionUpdate[] {
    const toolCallId = readString(frame.toolCallId)
    if (toolCallId === undefined) return []
    const toolName = readString(frame.toolName) ?? 'tool'
    const args = frame.args
    if (args !== undefined) this.toolArgs.set(toolCallId, args)
    if (isInternalAgentMessageTool(toolName, args)) return []
    const partialResult = frame.partialResult
    const content = mergeToolUpdateContent(buildToolStartContent(toolName, args), extractToolCallContent(partialResult))
    const locations = extractToolLocations(args, this.ctx, toolName)
    return [
      {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        name: toolName,
        status: toolUpdateStatus(partialResult),
        rawOutput: partialResult,
        ...(content.length > 0 ? { content } : {}),
        ...(locations.length > 0 ? { locations } : {}),
      },
    ]
  }

  private toolEnd(frame: JsonObject): acp.SessionUpdate[] {
    const toolCallId = readString(frame.toolCallId)
    if (toolCallId === undefined) return []
    const toolName = readString(frame.toolName) ?? 'tool'
    const args = 'args' in frame ? frame.args : this.toolArgs.get(toolCallId)
    this.toolArgs.delete(toolCallId)
    this.open.delete(toolCallId)
    if (isInternalAgentMessageTool(toolName, args)) return []
    const result = frame.result
    const isError = frame.isError === true
    const content = mergeToolUpdateContent(buildToolStartContent(toolName, args), [
      ...extractDiffToolCallContent(result),
      ...extractToolCallContent(result),
    ])
    const locations = extractToolLocationsFromResult(result, this.ctx)
    const updates: acp.SessionUpdate[] = [
      {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        name: toolName,
        status: isError ? 'failed' : 'completed',
        rawOutput: result,
        ...(content.length > 0 ? { content } : {}),
        ...(locations.length > 0 ? { locations } : {}),
      },
    ]
    const plan = todoResultToPlan(toolName, isError, result)
    if (plan) updates.push(plan)
    return updates
  }
}

/** Map an rpc `available_commands_update.commands` list to the ACP command list (`toAcpAvailableCommands`). */
export function mapOmpAvailableCommands(commands: unknown): acp.AvailableCommand[] {
  const result: acp.AvailableCommand[] = []
  for (const command of readArray(commands) ?? []) {
    const record = asObject(command)
    const name = readString(record?.name)
    if (record === undefined || name === undefined || name.length === 0) continue
    const hint = readString(asObject(record.input)?.hint)
    result.push({
      name,
      description: readString(record.description) ?? '',
      ...(hint === undefined ? {} : { input: { hint } }),
    })
  }
  return result
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

interface ActivePromptState {
  readonly id: string
  readonly deferred: Deferred<NativePromptResult>
  readonly usage: OmpUsageAccumulator
  lastStopReason: string | undefined
  /** `errorMessage` of the run's final assistant message when it failed (from `agent_end`). */
  lastAssistantError: string | undefined
  admissionError: Error | undefined
  aborted: boolean
  admissionTimer: NodeJS.Timeout | undefined
  abortTimer: NodeJS.Timeout | undefined
  fallbackTimer: NodeJS.Timeout | undefined
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
  readonly timer: NodeJS.Timeout | undefined
}

interface ChunkAssembly {
  readonly id: string
  readonly count: number
  readonly byteLength: number
  readonly parts: Buffer[]
  bytes: number
}

interface SessionStats {
  readonly sessionId: string
  readonly sessionFile: string | undefined
  readonly data: JsonObject
}

/** Knobs that tests or the host may override; production defaults follow the protocol spec. */
export interface OmpNativeTransportOptions {
  readonly readyTimeoutMs?: number
  readonly requestTimeoutMs?: number
  readonly modelListTimeoutMs?: number
  readonly contextPollIntervalMs?: number
  readonly steerTimeoutMs?: number
  readonly stdinCloseGraceMs?: number
  /** Delays between background `get_available_models` retries after a failed first attempt. */
  readonly modelListRetryDelaysMs?: readonly number[]
}

/** OMP native transport: one `omp --mode rpc-ui` subprocess per instance. */
export class OmpNativeTransport implements NativeTransport {
  readonly kind = 'omp' as const

  private readonly readyTimeoutMs: number
  private readonly requestTimeoutMs: number
  private readonly modelListTimeoutMs: number
  private readonly contextPollIntervalMs: number
  private readonly steerTimeoutMs: number
  private readonly stdinCloseGraceMs: number
  private readonly modelListRetryDelaysMs: readonly number[]

  private proc: NativeProcess | undefined
  private agentEnv: Readonly<Record<string, string>> = {}
  private eventSink: NativeTransportStartOptions['onEvent'] | undefined
  private permissionHandler: NativePermissionHandler | undefined
  private logSink: ((message: string) => void) | undefined
  private projector: OmpEventProjector | undefined
  private startPromise: Promise<void> | undefined
  private closePromise: Promise<void> | undefined
  private started = false
  private closing = false
  private sessionFile: string | undefined
  private exited = false
  private exitError: Error | undefined
  private readonly exitDeferred = Promise.withResolvers<void>()
  private nextRequestId = 1
  private readonly pending = new Map<string, PendingRequest>()
  private stderrBuffer = ''
  private lineBuffer = ''
  private malformedFrames = 0
  private chunkAssembly: ChunkAssembly | undefined
  private readyFrame: JsonObject | undefined
  private readyWaiter:
    | {
        readonly resolve: (frame: JsonObject) => void
        readonly reject: (error: Error) => void
      }
    | undefined

  private sessionIdValue: string | undefined
  private agentInfoValue: { readonly name: string; readonly version: string } = { name: 'omp', version: '' }
  private model: OmpModelInfo | undefined
  private models: readonly OmpModelInfo[] = []
  private thinkingLevels: readonly string[] = [THINKING_OFF]
  private thinkingLevel: string | undefined
  private thinkingAuto = false
  private controlsValue: NativeControls = deriveOmpControls({
    models: [],
    model: undefined,
    thinkingLevels: [THINKING_OFF],
    thinkingLevel: undefined,
    thinkingAuto: false,
  })
  private emittedSignature = ''
  private selfChange = 0
  private configTail: Promise<void> = Promise.resolve()
  private modelRefresh: Promise<void> | undefined
  private modelRefreshDirty = false
  private modelListRetryTimer: NodeJS.Timeout | undefined

  private contextUsageValue: NativeContextUsage | undefined
  private busy = false
  private contextPollTimer: NodeJS.Timeout | undefined
  private contextPollInFlight = false

  private activePrompt: ActivePromptState | undefined
  private activeSteer: ActiveSteerState | undefined
  private steerTail: Promise<void> = Promise.resolve()
  private readonly dialogs = new Map<string, AbortController>()

  constructor(options: OmpNativeTransportOptions = {}) {
    this.readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.modelListTimeoutMs = options.modelListTimeoutMs ?? MODEL_LIST_TIMEOUT_MS
    this.contextPollIntervalMs = options.contextPollIntervalMs ?? CONTEXT_POLL_INTERVAL_MS
    this.steerTimeoutMs = options.steerTimeoutMs ?? DEFAULT_STEER_TIMEOUT_MS
    this.stdinCloseGraceMs = options.stdinCloseGraceMs ?? STDIN_CLOSE_GRACE_MS
    this.modelListRetryDelaysMs = options.modelListRetryDelaysMs ?? MODEL_LIST_RETRY_DELAYS_MS
  }

  get sessionId(): string | undefined {
    return this.sessionIdValue
  }

  get agentInfo(): { readonly name: string; readonly version: string } {
    return this.agentInfoValue
  }

  /** `switch_session` + `fork` over rpc replicate `AcpAgent#forkManagedSession`. */
  get canFork(): boolean {
    return true
  }

  /** True once the process exited or `close()` ran: the runtime then re-attaches before the next turn. */
  get closed(): boolean {
    return this.closing || this.exited
  }

  /** Path of the persisted OMP session file this transport is attached to (diagnostics and test cleanup). */
  get sessionFilePath(): string | undefined {
    return this.sessionFile
  }

  controls(): NativeControls {
    return this.controlsValue
  }

  contextUsage(): NativeContextUsage | undefined {
    return this.contextUsageValue
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  start(options: NativeTransportStartOptions): Promise<void> {
    if (this.startPromise !== undefined) return this.startPromise
    this.startPromise = this.doStart(options)
    return this.startPromise
  }

  private async doStart(options: NativeTransportStartOptions): Promise<void> {
    if (this.closing) throw new NativeTransportError('OMP transport is closed', 'closed')
    this.eventSink = options.onEvent
    this.permissionHandler = options.onPermission
    this.logSink = options.log
    this.agentEnv = options.env
    this.projector = new OmpEventProjector({ cwd: options.cwd, homeDir: options.env['HOME'] })

    const plan = buildOmpLaunchArgv(options.argv)
    if (plan.dropped.length > 0) this.log(`ignoring launcher args the transport owns: ${redactArgv(plan.dropped)}`)
    this.log(`spawning ${redactArgv(plan.argv)} (cwd=${options.cwd})`)
    let proc: NativeProcess
    try {
      proc = options.spawn({ argv: plan.argv, cwd: options.cwd, env: options.env })
    } catch (error) {
      throw error instanceof NativeTransportError
        ? error
        : new NativeTransportError('failed to spawn omp', 'spawn-failed', errorText(error))
    }
    this.proc = proc
    this.attachProcess(proc)
    // The rpc handshake does not carry the OMP version: ask the same launcher while the session boots.
    const versionProbe = this.probeVersion(options, plan.versionArgv)

    try {
      const ready = await this.waitForReady()
      await this.handshake(ready)
      await this.attachSession(options.session)
      await this.loadControlState()
      const version = await settleWithin(versionProbe, VERSION_WAIT_MS)
      if (version !== undefined) this.agentInfoValue = { name: 'omp', version }
      if (this.exitError !== undefined) throw this.exitError
      this.started = true
    } catch (error) {
      await this.close().catch(() => undefined)
      throw error
    }
  }

  /** `omp --version` → `18.12.6`; `undefined` when the launcher does not answer in time. Never throws. */
  private async probeVersion(options: NativeTransportStartOptions, argv: readonly string[]): Promise<string | undefined> {
    let proc: NativeProcess
    try {
      proc = options.spawn({ argv, cwd: options.cwd, env: options.env })
    } catch {
      return undefined
    }
    proc.stdin.on('error', () => undefined)
    proc.stderr.on('data', () => undefined)
    proc.stderr.on('error', () => undefined)
    try {
      proc.stdin.end()
    } catch {
      // The probe needs no input.
    }
    let output = ''
    const streamEnded = Promise.withResolvers<void>()
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      if (output.length < 4_096) output += chunk
    })
    proc.stdout.on('end', streamEnded.resolve)
    proc.stdout.on('close', streamEnded.resolve)
    proc.stdout.on('error', () => streamEnded.resolve())
    const exited = proc.exited.then(
      () => undefined,
      () => undefined,
    )
    const finished = Promise.all([streamEnded.promise, exited]).then(() => true)
    if ((await settleWithin(finished, VERSION_PROBE_TIMEOUT_MS)) !== true) {
      proc.terminate()
      return undefined
    }
    return /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(output)?.[1]
  }

  private attachProcess(proc: NativeProcess): void {
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      this.handleStdoutChunk(chunk)
    })
    proc.stdout.on('error', (error: Error) => {
      this.log(`stdout error: ${errorText(error)}`)
    })
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      this.stderrBuffer += chunk
      if (this.stderrBuffer.length > STDERR_BUFFER_LIMIT) {
        this.stderrBuffer = this.stderrBuffer.slice(-STDERR_BUFFER_LIMIT)
      }
    })
    proc.stderr.on('error', (error: Error) => {
      this.log(`stderr error: ${errorText(error)}`)
    })
    proc.stdin.on('error', (error: Error) => {
      this.log(`stdin error: ${errorText(error)}`)
    })
    proc.exited.then(
      (outcome) => {
        this.handleProcessExit(`code=${outcome.exitCode === null ? 'null' : String(outcome.exitCode)} signal=${outcome.signal ?? 'null'}`, outcome.exitCode)
      },
      (error: unknown) => {
        this.handleProcessExit(`launch failed: ${errorText(error)}`, null)
      },
    )
  }

  private handleProcessExit(detail: string, exitCode: number | null): void {
    this.exited = true
    const tail = this.stderrTail()
    const launcherHint =
      exitCode === 127 || /command not found|No such file or directory/i.test(tail)
        ? ' (the omp launcher could not find an executable it needs on PATH; omp is `#!/usr/bin/env bun`, so the agent env PATH must include bun)'
        : ''
    this.failProcess(
      new NativeTransportError(
        `OMP process exited${launcherHint}`,
        'process-exit',
        tail.length === 0 ? detail : `${detail}\n${tail.slice(-1_000)}`,
      ),
    )
    this.exitDeferred.resolve()
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
          await this.request({ type: 'negotiate_protocol', protocolVersion: 2 }, this.requestTimeoutMs).response,
        )
        if (data === undefined || readNumber(data.protocolVersion) !== 2) {
          this.log('OMP did not accept RPC protocol v2; staying on line framing')
        }
      } catch (error) {
        this.log(`OMP protocol v2 negotiation failed: ${errorText(error)}`)
      }
    }
    // Every session event, but drop the accumulating message snapshot from streaming updates: deltas
    // remain, which is all this transport projects. Best effort on older builds.
    try {
      await this.request({ type: 'set_event_filter', events: null, messageUpdates: 'delta' }, 5_000).response
    } catch (error) {
      this.log(`OMP set_event_filter was rejected: ${errorText(error)}`)
    }
  }

  // ---------------------------------------------------------------------------
  // Attaching to a session
  // ---------------------------------------------------------------------------

  private async statsRequest(timeoutMs: number): Promise<SessionStats> {
    const data = asObject(await this.request({ type: 'get_session_stats' }, timeoutMs).response)
    const sessionId = readString(data?.sessionId)
    if (data === undefined || sessionId === undefined || sessionId.length === 0) {
      throw new NativeTransportError('OMP did not report a session id', 'protocol-error')
    }
    return { sessionId, sessionFile: readString(data.sessionFile), data }
  }

  private async attachSession(target: NativeSessionTarget): Promise<void> {
    // The process booted a fresh in-memory session for this cwd; ACP does the same before it loads one.
    const boot = await this.statsRequest(this.requestTimeoutMs)
    this.projector?.reset()
    switch (target.kind) {
      case 'new':
        await this.sessionChange(
          { type: 'new_session' },
          'start a new session',
          'new-session-failed',
          'an extension vetoed the new session',
        )
        break
      case 'resume': {
        const file = await this.locateSession(target.sessionId, boot)
        await this.sessionChange(
          { type: 'switch_session', sessionPath: file },
          `resume session ${target.sessionId}`,
          'resume-failed',
          'the session was recorded for another working directory (OMP refuses to switch across directories) or an extension vetoed the switch',
        )
        break
      }
      case 'fork': {
        const file = await this.locateSession(target.parentSessionId, boot)
        await this.sessionChange(
          { type: 'switch_session', sessionPath: file },
          `open session ${target.parentSessionId} to fork it`,
          'fork-failed',
          'the session was recorded for another working directory or an extension vetoed the switch',
        )
        await this.sessionChange(
          { type: 'fork' },
          `fork session ${target.parentSessionId}`,
          'fork-failed',
          'the session is busy or an extension vetoed the fork',
        )
        break
      }
    }
    const stats = await this.statsRequest(this.requestTimeoutMs)
    if (target.kind === 'resume' && stats.sessionId !== target.sessionId) {
      throw new NativeTransportError(
        `OMP attached session ${stats.sessionId} instead of ${target.sessionId}`,
        'resume-failed',
      )
    }
    if (target.kind === 'fork' && stats.sessionId === target.parentSessionId) {
      throw new NativeTransportError(`OMP did not fork session ${target.parentSessionId}`, 'fork-failed')
    }
    this.sessionIdValue = stats.sessionId
    this.sessionFile = stats.sessionFile
    this.applyStats(stats.data)
  }

  private async locateSession(sessionId: string, boot: SessionStats): Promise<string> {
    if (boot.sessionFile === undefined) {
      throw new NativeTransportError(
        'OMP runs without session persistence, so stored sessions cannot be opened',
        'persistence-disabled',
      )
    }
    const agentDir = this.agentEnv['PI_CODING_AGENT_DIR']
    const file = await findOmpSessionFile({
      sessionId,
      referenceFile: boot.sessionFile,
      ...(agentDir === undefined || agentDir.length === 0 ? {} : { extraRoots: [join(agentDir, 'sessions')] }),
    })
    if (file === undefined) {
      throw new NativeTransportError(
        `OMP session not found: ${sessionId}`,
        'session-not-found',
        `searched ${dirname(boot.sessionFile)} and the sibling session directories`,
      )
    }
    return file
  }

  private async sessionChange(command: JsonObject, action: string, failureCode: string, cancelledWhy: string): Promise<void> {
    let data: JsonObject | undefined
    try {
      data = asObject(await this.request(command, SESSION_COMMAND_TIMEOUT_MS).response)
    } catch (error) {
      if (error instanceof NativeTransportError && error.code === 'request-failed') {
        throw new NativeTransportError(`OMP could not ${action}`, failureCode, error.detail)
      }
      throw error
    }
    if (readBoolean(data?.cancelled) === true) {
      throw new NativeTransportError(`OMP did not ${action}`, failureCode, `the vendor reported cancelled:true: ${cancelledWhy}`)
    }
  }

  // ---------------------------------------------------------------------------
  // Controls state
  // ---------------------------------------------------------------------------

  private async loadControlState(): Promise<void> {
    await this.refreshState()
    await this.loadThinkingLevels()
    await this.loadModels()
    if (this.sessionFile !== undefined) {
      // `auto` is only visible in the transcript (the state reports the level it resolved to).
      const recorded = await readOmpSessionThinking(this.sessionFile)
      if (recorded?.configured === THINKING_AUTO) this.thinkingAuto = true
    }
    this.rebuildControls()
    this.emittedSignature = controlsSignature(this.controlsValue)
  }

  /** `get_state`: the current model and effective thinking level. */
  private async refreshState(): Promise<void> {
    const state = asObject(await this.request({ type: 'get_state' }, SESSION_COMMAND_TIMEOUT_MS).response)
    if (state === undefined) return
    const model = parseOmpModel(state.model)
    if (model !== undefined) this.model = model
    this.thinkingLevel = readString(state.thinkingLevel)
  }

  private async loadThinkingLevels(): Promise<void> {
    try {
      const data = asObject(await this.request({ type: 'get_available_thinking_levels' }, this.requestTimeoutMs).response)
      const levels = readStringArray(data?.levels)
      this.thinkingLevels = levels.includes(THINKING_OFF) ? levels : [THINKING_OFF, ...levels]
    } catch (error) {
      if (this.exitError !== undefined) throw this.exitError
      this.log(`OMP get_available_thinking_levels failed: ${errorText(error)}`)
    }
  }

  private async loadModels(): Promise<void> {
    try {
      const data = asObject(await this.request({ type: 'get_available_models' }, this.modelListTimeoutMs).response)
      const models: OmpModelInfo[] = []
      for (const raw of readArray(data?.models) ?? []) {
        const model = parseOmpModel(raw)
        if (model !== undefined) models.push(model)
      }
      this.models = models
    } catch (error) {
      if (this.exitError !== undefined || this.closing) throw this.exitError ?? error
      // Discovery can be slow or offline; the picker degrades to the current model and the full list
      // follows with a `controls` event once a retry succeeds.
      this.log(`OMP get_available_models failed: ${errorText(error)}`)
      this.scheduleModelListRetry(0)
    }
  }

  private scheduleModelListRetry(attempt: number): void {
    const delay = this.modelListRetryDelaysMs[attempt]
    if (delay === undefined || this.closing) return
    this.modelListRetryTimer = setTimeout(() => {
      this.modelListRetryTimer = undefined
      if (this.closing) return
      this.request({ type: 'get_available_models' }, this.modelListTimeoutMs).response.then(
        (raw) => {
          const models: OmpModelInfo[] = []
          for (const entry of readArray(asObject(raw)?.models) ?? []) {
            const model = parseOmpModel(entry)
            if (model !== undefined) models.push(model)
          }
          this.models = models
          this.onControlInputsChanged()
        },
        (error: unknown) => {
          this.log(`OMP get_available_models retry ${attempt + 1} failed: ${errorText(error)}`)
          this.scheduleModelListRetry(attempt + 1)
        },
      )
    }, delay)
  }

  private rebuildControls(): void {
    const models = this.models.length > 0 ? this.models : this.model === undefined ? [] : [this.model]
    this.controlsValue = deriveOmpControls({
      models,
      model: this.model,
      thinkingLevels: this.thinkingLevels,
      thinkingLevel: this.thinkingLevel,
      thinkingAuto: this.thinkingAuto,
    })
  }

  /** Rebuild after a vendor-side change and tell the host when the visible controls differ. */
  private onControlInputsChanged(): void {
    this.rebuildControls()
    if (this.selfChange > 0 || !this.started) return
    const signature = controlsSignature(this.controlsValue)
    if (signature === this.emittedSignature) return
    this.emittedSignature = signature
    this.emit({ kind: 'controls', controls: this.controlsValue })
  }

  /** `model_changed` carries no payload: re-read the model, its thinking levels and the effective level. */
  private scheduleModelRefresh(): void {
    if (this.modelRefresh !== undefined) {
      this.modelRefreshDirty = true
      return
    }
    this.modelRefresh = (async () => {
      do {
        this.modelRefreshDirty = false
        try {
          await this.refreshState()
          await this.loadThinkingLevels()
          this.onControlInputsChanged()
        } catch (error) {
          this.log(`OMP control refresh failed: ${errorText(error)}`)
        }
      } while (this.modelRefreshDirty && !this.closing)
    })().finally(() => {
      this.modelRefresh = undefined
    })
  }

  async setConfigOption(configId: string, value: string | boolean, signal?: AbortSignal): Promise<void> {
    this.assertUsable()
    if (typeof value === 'boolean') {
      throw new NativeTransportError(`Unsupported boolean config option: ${configId}`, 'unsupported-config-value')
    }
    const run = this.configTail.then(async () => {
      if (signal?.aborted === true) throw abortReason(signal)
      this.selfChange += 1
      try {
        switch (configId) {
          case 'mode':
            this.applyMode(value)
            break
          case 'model':
            await raceAbort(this.applyModel(value), signal)
            break
          case 'thinking':
            await raceAbort(this.applyThinking(value), signal)
            break
          default:
            throw new NativeTransportError(`Unknown config option: ${configId}`, 'unknown-config-option')
        }
      } finally {
        this.selfChange -= 1
      }
      this.rebuildControls()
      // The caller reads `controls()` after this resolves; only later vendor-side changes are events.
      this.emittedSignature = controlsSignature(this.controlsValue)
    })
    this.configTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private applyMode(modeId: string): void {
    if (modeId === ACP_MODE_ID_DEFAULT) return
    if (modeId === ACP_MODE_ID_PLAN) {
      throw new NativeTransportError(
        'OMP plan mode is not available over the native rpc-ui protocol',
        'plan-mode-unsupported',
        'rpc-ui has no plan-mode command: `/plan` is a terminal-only handler and extensions have no plan API. ' +
          'Plan with this member through the ACP route (`omp acp`), or stay in the default mode.',
      )
    }
    throw new NativeTransportError(`Unsupported mode: ${modeId}`, 'unknown-mode')
  }

  private async applyModel(modelValue: string): Promise<void> {
    // ACP re-applies the model unconditionally; re-selecting the current one only resets provider state.
    if (this.model !== undefined && ompModelValue(this.model) === modelValue) return
    let target = this.models.find((candidate) => ompModelValue(candidate) === modelValue)
    if (target === undefined) {
      await this.loadModels()
      target = this.models.find((candidate) => ompModelValue(candidate) === modelValue)
    }
    if (target === undefined) throw new NativeTransportError(`Unknown model: ${modelValue}`, 'unknown-model')
    const data = await this.request(
      { type: 'set_model', provider: target.provider, modelId: target.id },
      SESSION_COMMAND_TIMEOUT_MS,
    ).response
    this.model = parseOmpModel(data) ?? target
    // The thinking level is re-clamped to the new model: `thinking_level_changed` already updated it.
    await this.loadThinkingLevels()
  }

  private async applyThinking(selector: string): Promise<void> {
    if (!Object.hasOwn(THINKING_SELECTORS, selector)) {
      throw new NativeTransportError(`Unknown thinking level: ${selector}`, 'unknown-thinking-level')
    }
    await this.request({ type: 'set_thinking_level', level: selector }, this.requestTimeoutMs).response
    this.thinkingAuto = selector === THINKING_AUTO
  }

  private assertUsable(): void {
    if (this.closing) throw new NativeTransportError('OMP transport is closed', 'closed')
    if (this.exitError !== undefined) throw this.exitError
    if (!this.started) throw new NativeTransportError('OMP transport is not started', 'not-started')
  }

  // ---------------------------------------------------------------------------
  // Close
  // ---------------------------------------------------------------------------

  async close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    this.closing = true
    this.closePromise = this.shutdown()
    return this.closePromise
  }

  private async shutdown(): Promise<void> {
    this.closing = true
    this.stopContextPolling()
    this.busy = false
    if (this.modelListRetryTimer !== undefined) {
      clearTimeout(this.modelListRetryTimer)
      this.modelListRetryTimer = undefined
    }
    const closeError = this.exitError ?? new NativeTransportError('OMP transport is closed', 'closed')
    if (this.readyWaiter !== undefined) {
      this.readyWaiter.reject(closeError)
      this.readyWaiter = undefined
    }
    this.failPending(closeError)
    for (const dialog of this.dialogs.values()) dialog.abort()
    this.dialogs.clear()
    if (this.activePrompt !== undefined) this.failPrompt(this.activePrompt, closeError)
    if (this.activeSteer !== undefined) this.failSteer(this.activeSteer, closeError)

    const proc = this.proc
    if (proc === undefined) return
    try {
      proc.stdin.end()
    } catch {
      // Cleanup race: the pipe may already be gone.
    }
    if (await this.waitForExit(this.stdinCloseGraceMs)) return
    proc.terminate()
    await this.waitForExit(TERMINATE_WAIT_MS)
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return true
    return (await settleWithin(this.exitDeferred.promise.then(() => true), timeoutMs)) === true
  }

  private failProcess(error: Error): void {
    if (this.exitError !== undefined) return
    this.exitError = error
    this.failPending(error)
    if (this.readyWaiter !== undefined) {
      this.readyWaiter.reject(error)
      this.readyWaiter = undefined
    }
    for (const dialog of this.dialogs.values()) dialog.abort()
    this.dialogs.clear()
    if (this.activePrompt !== undefined) {
      const prompt = this.activePrompt
      if (prompt.aborted) void this.finishPrompt(prompt, { stopReason: 'cancelled' })
      else this.failPrompt(prompt, error)
    }
    if (this.activeSteer !== undefined) this.failSteer(this.activeSteer, error)
    this.stopContextPolling()
    this.busy = false
    if (!this.closing) {
      const detail = this.stderrTail()
      this.emitNotice(`${error.message}${detail.length === 0 ? '' : `: ${detail.slice(-500)}`}`)
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
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
      const reassembled = asObject(JSON.parse(text))
      if (reassembled === undefined) {
        this.reportMalformedFrame('reassembled rpc_chunk is not a JSON object')
        return
      }
      this.dispatchFrame(reassembled)
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
    try {
      this.handleEvent(frame, type)
    } catch (error) {
      this.log(`OMP ${type ?? 'unknown'} frame handler failed: ${errorText(error)}`)
    }
  }

  private writeFrame(frame: JsonObject): boolean {
    const proc = this.proc
    if (proc === undefined || this.closing) return false
    if (proc.stdin.destroyed || !proc.stdin.writable) return false
    try {
      proc.stdin.write(`${JSON.stringify(frame)}\n`)
      return true
    } catch (error) {
      this.log(`writing to OMP stdin failed: ${errorText(error)}`)
      return false
    }
  }

  private mintRequestId(): string {
    const id = `req_${this.nextRequestId}`
    this.nextRequestId += 1
    return id
  }

  private request(
    command: JsonObject,
    timeoutMs: number = this.requestTimeoutMs,
    id: string = this.mintRequestId(),
  ): { id: string; response: Promise<unknown> } {
    const { promise: response, resolve, reject } = Promise.withResolvers<unknown>()
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
    this.pending.set(id, { command: readString(command.type) ?? 'command', resolve, reject, timer })
    if (!this.writeFrame({ ...command, id })) {
      const pending = this.pending.get(id)
      if (pending !== undefined) {
        this.pending.delete(id)
        clearTimeout(pending.timer)
      }
      reject(
        this.exitError ?? new NativeTransportError('OMP stdin is not writable', 'transport-closed', this.stderrTail()),
      )
    }
    return { id, response }
  }

  private handleResponse(frame: JsonObject): void {
    const id = readString(frame.id)
    const pending = id === undefined ? undefined : this.pending.get(id)
    if (pending !== undefined && id !== undefined) {
      this.pending.delete(id)
      clearTimeout(pending.timer)
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
    // A late duplicate response (OMP answers a streaming prompt with error first, success second, same
    // id) is a diagnostic, not a turn outcome: `prompt_result` owns terminal state.
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
    this.readyFrame = frame
    const waiter = this.readyWaiter
    if (waiter === undefined) return
    this.readyWaiter = undefined
    waiter.resolve(frame)
  }

  private waitForReady(): Promise<JsonObject> {
    if (this.readyFrame !== undefined) return Promise.resolve(this.readyFrame)
    if (this.exitError !== undefined) return Promise.reject(this.exitError)
    const ready = Promise.withResolvers<JsonObject>()
    const timer = setTimeout(() => {
      if (this.readyWaiter === undefined) return
      this.readyWaiter = undefined
      ready.reject(
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
        ready.resolve(frame)
      },
      reject: (error) => {
        clearTimeout(timer)
        ready.reject(error)
      },
    }
    return ready.promise
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
        this.handleAgentEnd(frame)
        return
      case 'session_settled':
        this.setBusy(false)
        if (this.activePrompt === undefined) void this.refreshContextUsage(TURN_END_CONTEXT_TIMEOUT_MS).catch(() => undefined)
        this.schedulePromptResultFallback()
        return
      case 'prompt_result':
        this.handlePromptResult(frame)
        return
      case 'message_start':
      case 'message_end':
        this.handleMessageBoundary(frame, type)
        this.projectTurnFrame(frame)
        return
      case 'message_update':
      case 'tool_execution_start':
      case 'tool_execution_update':
      case 'tool_execution_end':
      case 'todo_reminder':
      case 'todo_auto_clear':
      case 'command_output':
        this.projectTurnFrame(frame)
        return
      case 'turn_end':
        this.handleTurnEnd(frame)
        return
      case 'queue_update':
        this.handleQueueUpdate(frame)
        return
      case 'extension_ui_request':
        void this.handleExtensionUiRequest(frame)
        return
      case 'available_commands_update':
        this.emit({
          kind: 'update',
          update: { sessionUpdate: 'available_commands_update', availableCommands: mapOmpAvailableCommands(frame.commands) },
        })
        return
      case 'session_info_update': {
        const title = readString(frame.title)
        this.emit({
          kind: 'update',
          update: {
            sessionUpdate: 'session_info_update',
            ...(title === undefined ? {} : { title }),
            updatedAt: new Date().toISOString(),
          },
        })
        return
      }
      case 'model_changed':
        if (this.started && this.selfChange === 0) this.scheduleModelRefresh()
        return
      case 'thinking_level_changed':
        this.handleThinkingLevelChanged(frame)
        return
      case 'config_update':
        this.handleConfigUpdate(frame)
        return
      case 'notice':
        this.emitNoticeFrame(frame)
        return
      case 'retry_fallback_applied':
        this.emitNotice(
          `OMP switched model ${readString(frame.from) ?? '?'} → ${readString(frame.to) ?? '?'}${readString(frame.reason) === undefined ? '' : ` (${readString(frame.reason)})`}`,
        )
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
      case 'extension_error':
        this.emitNotice(
          `OMP extension error (${readString(frame.extensionPath) ?? 'unknown'} / ${readString(frame.event) ?? 'unknown'}): ${readString(frame.error) ?? 'failed'}`,
        )
        return
      case 'rpc_frame_error':
        this.emitNotice(
          `OMP dropped an oversized frame (${readString(frame.originalType) ?? 'unknown'}): ${readString(frame.error) ?? 'transport limit'}`,
        )
        return
      default:
        // subagent_* / host_* / live_* / btw_* and the remaining telemetry frames need no projection.
        return
    }
  }

  /** Turn content is only forwarded while a `prompt()` owns the turn, exactly like `#handlePromptEvent`. */
  private turnOpen(): boolean {
    const prompt = this.activePrompt
    return prompt !== undefined && !prompt.aborted
  }

  private projectTurnFrame(frame: JsonObject): void {
    if (!this.turnOpen()) return
    for (const update of this.projector?.project(frame) ?? []) this.emit({ kind: 'update', update })
  }

  private handleMessageBoundary(frame: JsonObject, type: 'message_start' | 'message_end'): void {
    const message = asObject(frame.message)
    if (message === undefined) return
    const role = readString(message.role)
    if (role === 'user') {
      this.noteSteeringMessage(message)
      return
    }
    if (type !== 'message_end' || role !== 'assistant') return
    const prompt = this.activePrompt
    if (prompt === undefined) return
    prompt.usage.add(message.usage, readString(frame.messageId))
    const stopReason = readString(message.stopReason)
    if (stopReason !== undefined) prompt.lastStopReason = stopReason
  }

  private handleTurnEnd(frame: JsonObject): void {
    const message = asObject(frame.message)
    if (message === undefined || readString(message.role) !== 'assistant') return
    const prompt = this.activePrompt
    if (prompt === undefined) return
    const stopReason = readString(message.stopReason)
    if (stopReason !== undefined) prompt.lastStopReason = stopReason
  }

  private handleAgentEnd(frame: JsonObject): void {
    const prompt = this.activePrompt
    if (prompt !== undefined) {
      const messages = readArray(frame.messages) ?? []
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = asObject(messages[index])
        if (message === undefined || readString(message.role) !== 'assistant') continue
        const stopReason = readString(message.stopReason)
        if (stopReason !== undefined) prompt.lastStopReason = stopReason
        const errorMessage = readString(message.errorMessage)
        prompt.lastAssistantError =
          stopReason === 'error' && errorMessage !== undefined && errorMessage.length > 0 && errorMessage !== SILENT_ABORT_MARKER
            ? errorMessage
            : undefined
        break
      }
    }
    this.schedulePromptResultFallback()
  }

  private handleThinkingLevelChanged(frame: JsonObject): void {
    this.thinkingLevel = readString(frame.thinkingLevel)
    // `configured` is present exactly when the selector differs from the effective level (auto).
    this.thinkingAuto = readString(frame.configured) === THINKING_AUTO
    this.onControlInputsChanged()
  }

  /** `config_update` follows `/model` and `/thinking` slash commands. */
  private handleConfigUpdate(frame: JsonObject): void {
    const model = parseOmpModel(frame.model)
    if (model !== undefined) this.model = model
    const level = readString(frame.thinkingLevel)
    if (level !== undefined) this.thinkingLevel = level
    if (this.started && this.selfChange === 0) this.scheduleModelRefresh()
    else this.onControlInputsChanged()
  }

  private handleQueueUpdate(frame: JsonObject): void {
    const steer = this.activeSteer
    if (steer === undefined) return
    const steering = readStringArray(frame.steering)
    const queued = steer.text.length === 0 ? steering.length > 0 : steering.some((entry) => entry === steer.text)
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

  private handlePromptResult(frame: JsonObject): void {
    const prompt = this.activePrompt
    if (prompt === undefined) return
    const id = readString(frame.id)
    if (id !== undefined && id !== prompt.id) return
    clearPromptTimers(prompt)
    if (readBoolean(frame.sessionSettled) === true) this.setBusy(false)
    const status = readString(frame.status) ?? 'completed'
    const errorMessage = readString(asObject(frame.error)?.message)
    if (status === 'error' && readBoolean(frame.agentInvoked) === false) {
      // Rejected before the agent ran (e.g. a prompt into a running turn): nothing was answered.
      const message = errorMessage ?? 'OMP prompt failed'
      this.emitNotice(`OMP prompt failed: ${message}`)
      this.failPrompt(prompt, new NativeTransportError('OMP prompt failed', 'prompt-failed', message))
      return
    }
    // A provider failure ends the turn like ACP does: the error text is the visible reply.
    const failure = status === 'error' ? (prompt.lastAssistantError ?? errorMessage) : undefined
    if (!prompt.aborted) {
      for (const update of this.projector?.flushTurnError({
        assistantError: prompt.lastAssistantError,
        promptError: status === 'error' ? errorMessage : undefined,
      }) ?? []) {
        this.emit({ kind: 'update', update })
      }
    }
    const stopReason: NativePromptResult['stopReason'] =
      status === 'aborted' || prompt.aborted
        ? 'cancelled'
        : prompt.lastStopReason === 'length'
          ? 'max_tokens'
          : failure !== undefined && /content[_ ]?filter|refus(al|ed)/i.test(failure)
            ? 'refusal'
            : 'end_turn'
    const usage = prompt.usage.snapshot()
    void this.finishPrompt(prompt, { stopReason, ...(usage === undefined ? {} : { usage }) })
  }

  private schedulePromptResultFallback(): void {
    const prompt = this.activePrompt
    if (prompt === undefined || prompt.fallbackTimer !== undefined) return
    prompt.fallbackTimer = setTimeout(() => {
      prompt.fallbackTimer = undefined
      if (this.activePrompt !== prompt) return
      // COMPAT(ompPromptResultFallback): older OMP releases only end the run with agent_end.
      this.log('OMP did not report prompt_result; settling from the terminal run frame')
      if (!prompt.aborted) {
        for (const update of this.projector?.flushTurnError({ assistantError: prompt.lastAssistantError }) ?? []) {
          this.emit({ kind: 'update', update })
        }
      }
      const usage = prompt.usage.snapshot()
      void this.finishPrompt(prompt, {
        stopReason: prompt.aborted ? 'cancelled' : prompt.lastStopReason === 'length' ? 'max_tokens' : 'end_turn',
        ...(usage === undefined ? {} : { usage }),
      })
    }, PROMPT_RESULT_FALLBACK_MS)
  }

  // ---------------------------------------------------------------------------
  // Context + busy tracking
  // ---------------------------------------------------------------------------

  /** `usage_update` semantics: window occupancy plus cumulative session cost. */
  private applyStats(data: JsonObject): void {
    const context = asObject(data.contextUsage)
    const size = readNumber(context?.contextWindow)
    if (context === undefined || size === undefined || size <= 0) return
    const used = readNumber(context.tokens) ?? 0
    const cost = readNumber(data.cost)
    const next: NativeContextUsage = {
      used,
      size,
      ...(cost !== undefined && cost > 0 ? { cost: { amount: cost, currency: 'USD' } } : {}),
    }
    const previous = this.contextUsageValue
    if (previous?.used === next.used && previous.size === next.size && previous.cost?.amount === next.cost?.amount) return
    this.contextUsageValue = next
    this.emit({ kind: 'context_usage', contextUsage: next })
  }

  private async refreshContextUsage(timeoutMs: number = this.requestTimeoutMs): Promise<void> {
    if (this.closing || this.exitError !== undefined) return
    const data = asObject(await this.request({ type: 'get_session_stats' }, timeoutMs).response)
    if (data === undefined) return
    this.applyStats(data)
  }

  private setBusy(busy: boolean): void {
    if (this.busy === busy) return
    this.busy = busy
    if (busy) this.startContextPolling()
    else this.stopContextPolling()
  }

  private startContextPolling(): void {
    this.stopContextPolling()
    const tick = (): void => {
      if (this.closing || !this.busy) return
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
    this.assertUsable()
    if (this.activePrompt !== undefined) {
      throw new NativeTransportError('OMP prompt is already in flight', 'prompt-in-flight')
    }
    if (signal.aborted) throw abortReason(signal)
    const { message, images } = splitContent(content)
    if (message.length === 0 && images.length === 0) {
      throw new NativeTransportError('OMP prompt needs text or image content', 'empty-prompt')
    }

    const result = Promise.withResolvers<NativePromptResult>()
    const id = this.mintRequestId()
    const prompt: ActivePromptState = {
      id,
      deferred: result,
      usage: new OmpUsageAccumulator(),
      lastStopReason: undefined,
      lastAssistantError: undefined,
      admissionError: undefined,
      aborted: false,
      admissionTimer: undefined,
      abortTimer: undefined,
      fallbackTimer: undefined,
      removeAbortListener: undefined,
    }
    // The turn owns the frames from the moment the command is written: register it before sending.
    this.activePrompt = prompt
    this.projector?.reset()
    const request = this.request(
      {
        type: 'prompt',
        message,
        ...(images.length > 0 ? { images } : {}),
      },
      this.requestTimeoutMs,
      id,
    )

    // The acknowledgement means "admitted", never "turn finished"; local-only slash commands report
    // `agentInvoked:false` and never emit prompt_result.
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
        // Newer OMP reports rejection through prompt_result only; older builds emit a bare failed
        // response, so give the terminal frame a short grace before giving up.
        prompt.admissionTimer = setTimeout(() => {
          prompt.admissionTimer = undefined
          if (this.activePrompt !== prompt) return
          this.failPrompt(
            prompt,
            prompt.admissionError ?? new NativeTransportError('OMP rejected the prompt', 'prompt-rejected'),
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

  private async finishPrompt(prompt: ActivePromptState, result: NativePromptResult): Promise<void> {
    if (this.activePrompt !== prompt) return
    this.activePrompt = undefined
    clearPromptTimers(prompt)
    prompt.removeAbortListener?.()
    prompt.removeAbortListener = undefined
    // The turn's usage includes everything accounted until now, even after a cancel.
    const usage = result.usage ?? prompt.usage.snapshot()
    try {
      await this.refreshContextUsage(TURN_END_CONTEXT_TIMEOUT_MS)
    } catch (error) {
      this.log(`OMP context usage refresh after turn failed: ${errorText(error)}`)
    }
    prompt.deferred.resolve({ stopReason: result.stopReason, ...(usage === undefined ? {} : { usage }) })
  }

  private failPrompt(prompt: ActivePromptState, error: Error): void {
    if (this.activePrompt !== prompt) return
    this.activePrompt = undefined
    clearPromptTimers(prompt)
    prompt.removeAbortListener?.()
    prompt.removeAbortListener = undefined
    prompt.deferred.reject(error)
  }

  private async interrupt(): Promise<void> {
    if (this.closing || this.exitError !== undefined) return
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

  steer(content: readonly NativeContentBlock[], signal?: AbortSignal): Promise<'injected' | 'promptRequired'> {
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
    if (this.closing) throw new NativeTransportError('OMP transport is closed', 'closed')
    if (this.exitError !== undefined) throw this.exitError
    if (signal?.aborted === true) throw abortReason(signal)
    const { message, images } = splitContent(content)
    if (message.length === 0 && images.length === 0) return 'promptRequired'
    // Like ACP's `_session/steering`, an idle (or aborting) session is never started or consumed by a
    // steer: the host submits the content through `prompt()` and keeps owning the turn.
    const prompt = this.activePrompt
    if (prompt === undefined || prompt.aborted) return 'promptRequired'

    const confirmation = Promise.withResolvers<'injected' | 'promptRequired'>()
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
      // Timed out waiting for the transcript proof: withdraw the queued message when possible, so the
      // caller can fall back to a prompt without duplicating the user's text.
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
    if (this.closing || this.exitError !== undefined) return false
    try {
      const data = asObject(
        await this.request({ type: 'remove_queued_message', message: text, queue: 'steering' }, 5_000).response,
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
    if (method === 'cancel') {
      // OMP settled the dialog itself (abort, timeout, supersede): withdraw the host prompt.
      const target = readString(frame.targetId)
      if (target !== undefined) this.dialogs.get(target)?.abort()
      return
    }
    if (method === 'confirm' || method === 'input' || method === 'editor' || method === 'ask') {
      // The host has no dialog surface for these; dismissing keeps the agent moving and is what ACP
      // does for a client without elicitation (a `confirm` cancelled means "no").
      this.writeFrame({ type: 'extension_ui_response', id, cancelled: true })
      return
    }
    // notify / setStatus / setWidget / setTitle / set_editor_text / open_url need no reply.
  }

  private async answerSelectDialog(requestId: string, frame: JsonObject): Promise<void> {
    const labels = readStringArray(frame.options)
    if (labels.length === 0) {
      this.writeFrame({ type: 'extension_ui_response', id: requestId, cancelled: true })
      return
    }
    const options = mapOmpPermissionOptions(labels)
    const rawTitle = readString(frame.title) ?? readString(frame.message) ?? 'OMP permission request'
    const request: NativePermissionRequest = { toolCall: this.permissionToolCall(requestId, rawTitle), options }
    const controller = new AbortController()
    this.dialogs.set(requestId, controller)
    let decision: NativePermissionDecision
    const handler = this.permissionHandler
    if (handler === undefined) {
      decision = { cancelled: true }
    } else {
      try {
        decision = await handler(request, controller.signal)
      } catch (error) {
        this.log(`OMP permission handler failed: ${errorText(error)}`)
        decision = { cancelled: true }
      }
    }
    this.dialogs.delete(requestId)
    // OMP withdrew the dialog (or the transport is going down): there is nothing left to answer.
    if (controller.signal.aborted || this.closing) return
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

  /**
   * The ACP `toolCall` of an approval dialog: the in-flight tool the dialog is about (`Allow tool: <name>`
   * names it), else a call synthesized from the dialog text.
   */
  private permissionToolCall(requestId: string, dialogTitle: string): acp.ToolCallUpdate {
    const toolName = /^Allow tool:\s*(\S+)/m.exec(dialogTitle)?.[1]
    const call = this.projector?.findOpenToolCall(toolName)
    if (call !== undefined) {
      return {
        toolCallId: call.toolCallId,
        title: call.title,
        name: call.toolName,
        kind: call.kind,
        status: 'pending',
        rawInput: call.rawInput,
        content: [...call.content, textToolContent(dialogTitle)],
        ...(call.locations.length > 0 ? { locations: [...call.locations] } : {}),
      }
    }
    const firstLine = dialogTitle.split('\n')[0]?.trim() ?? ''
    return {
      toolCallId: `omp-dialog:${requestId}`,
      title: firstLine.length === 0 ? 'OMP permission request' : firstLine,
      status: 'pending',
      content: [textToolContent(dialogTitle)],
    }
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

/** Create the OMP transport selected by the shared native-transport factory. */
export function createOmpTransport(options: OmpNativeTransportOptions = {}): NativeTransport {
  return new OmpNativeTransport(options)
}
