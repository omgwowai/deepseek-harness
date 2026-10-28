/// <reference types="node" />
/**
 * Claude Code native transport: the `claude` CLI speaking stream-json, reporting what
 * `@agentclientprotocol/claude-agent-acp` reports for the same session (ids, controls, tool calls,
 * usage), so state DSH saved under the ACP route stays valid.
 *
 * Verified against Claude Code 2.1.296. Wire facts this file relies on (all measured):
 *
 *  - `-p --input-format stream-json --output-format stream-json` keeps the process alive across
 *    turns; one `result` frame settles one turn (prompt plus any steers folded into it).
 *  - A control `initialize` request is answered before any user message, with the model catalog,
 *    slash commands, agents and fast-mode state. `system/init` only appears with the first message.
 *  - `--session-id <uuid>` names a new session up front; `--resume <id>` continues one;
 *    `--resume <id> --fork-session --session-id <uuid>` forks. The CLI restores neither the
 *    permission mode nor the model on resume, so both are re-established here the way
 *    claude-agent-acp does (transcript tail, then `set_permission_mode` / `set_model`).
 *  - An unknown resume id makes the CLI print `No conversation found with session ID` and exit 1.
 *  - `priority:"next"` on a user message folds it into the running turn at the next tool boundary;
 *    `interrupt` answers with `{still_queued, cancelled}` (see `interrupt()`).
 *  - `result.modelUsage` is cumulative per model (continuing from the transcript's `cost-state`
 *    after a resume); turn usage is the difference between two readings.
 *  - AskUserQuestion arrives as a `can_use_tool` request whose `input` is the card the user sees. The CLI admits an
 *    answer only when `updatedInput` repeats every shown field unchanged and adds nothing but `answers` and
 *    `annotations` (both keyed by question text). An MCP server's form arrives as an `elicitation` request
 *    (`mcp_server_name`, `message`, `mode`, `url`, `elicitation_id`, `requested_schema`) answered with an
 *    `ElicitResult`. (Read from the 2.1.296 binary; not exercised against a live model.)
 *  - Beyond turns (measured against the real binary): `side_question` is a control request the CLI answers while a turn runs,
 *    with `control_request_progress` frames before the answer and `control_cancel_request` to withdraw it; `bash_command`
 *    runs a user shell command without a model (two `isReplay` user frames, then `command_lifecycle completed`, no `result`);
 *    `/clear` sends `conversation_reset` and a `system/init` that carries the new session id; `rewind_files` needs
 *    `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true` and the uuid of a user message the CLI wrote a `file-history-snapshot`
 *    for; declaring `perTaskStopAffordance` on `initialize` makes an interrupt spare background tasks, which `stop_task` ends.
 *
 * Questions: with `onElicitation` the model's `AskUserQuestion` and MCP servers' forms reach the user as the ACP forms
 * claude-agent-acp sends for them. Without it the tool stays disallowed and MCP forms are declined, as that agent
 * treats a client without form elicitation.
 */
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, open, readdir, type FileHandle } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createInterface, type Interface } from 'node:readline'
import type { Readable } from 'node:stream'
import type * as acp from '@agentclientprotocol/sdk'

import {
  AGENT_CONFIG_ID,
  AUTO_MODE_FALLBACK,
  DEFAULT_AGENT_ID,
  DEFAULT_MODEL_ID,
  EFFORT_CONFIG_ID,
  FAST_MODE_CONFIG_ID,
  MODEL_CONFIG_ID,
  MODE_CONFIG_ID,
  applyAvailableModelsAllowlist,
  buildClaudeAvailableModes,
  buildClaudeConfigOptions,
  chooseInitialModel,
  discoverCustomAgents,
  effortFlagSettings,
  fastModeStateEnabled,
  isPreModelSwitchHookBlock,
  isRecord,
  matchResumedModel,
  normalizeFastModeDisabledReason,
  parseClaudeModelInfos,
  parseSelectableMode,
  resolveFastModeEnabled,
  resolveInitialPermissionMode,
  resolveModelPreference,
  selectValues,
  settingsEffortForModel,
  withCurrentValue,
  withLiveModelInfo,
  type ClaudeAgentInfo,
  type ClaudeModelInfo,
  type ClaudeModelState,
  type ClaudePermissionMode,
  type ClaudeSettingsView,
} from './claude-controls.ts'
import { checkpointLabel } from './checkpoint-label.ts'
import { allowResult, denyResult, prepareClaudePermission } from './claude-permissions.ts'
import { CLAUDE_TERMINAL_COMMANDS, claudeCommandCatalog, resolveClaudeImmediateCommand } from './claude-commands.ts'
import {
  CheckpointScan,
  ClaudeTaskLedger,
  SideHistory,
  capMarkdown,
  findCheckpoint,
  isTaskLive,
  parseBashReplay,
  parseMcpArgs,
  parseRewindArgs,
  parseTasksArgs,
  renderCheckpoints,
  renderContext,
  renderDiff,
  renderHooks,
  renderMcp,
  renderMemory,
  renderPermissions,
  renderRewindPreview,
  renderRewindResult,
  renderSkills,
  renderStatus,
  renderTaskOutput,
  renderTasks,
  renderUsage,
  rewindFilePlan,
  rewindRefusal,
  shellEscapeCommand,
  sideAnswer,
  type ClaudeCheckpoint,
  type RewindFilePlan,
} from './claude-interactions.ts'
import {
  ClaudeFrameMapper,
  modelUsageIncrement,
  normalizeModelUsage,
  updateEvent,
  type ModelUsageRow,
} from './claude-projection.ts'
import {
  NativeTransportError,
  type NativeCommand,
  type NativeCommandResult,
  type NativeContentBlock,
  type NativeContextUsage,
  type NativeControls,
  type NativeElicitationHandler,
  type NativeElicitationRequest,
  type NativePermissionDecision,
  type NativePermissionRequest,
  type NativeProcess,
  type NativePromptResult,
  type NativeTransport,
  type NativeTransportEvent,
  type NativeTransportKind,
  type NativeTransportStartOptions,
  type NativeTurnUsage,
} from './contract.ts'

type Json = Record<string, unknown>

const INITIALIZE_TIMEOUT_MS = 60_000
const CONTROL_TIMEOUT_MS = 15_000
const SETTINGS_TIMEOUT_MS = 10_000
/** The immediate commands read the CLI's own state; the longest one lists a diff (the CLI limits its git calls to 5 s). */
const COMMAND_TIMEOUT_MS = 30_000
/** Reconnecting or toggling an MCP server waits for its connection. */
const MCP_COMMAND_TIMEOUT_MS = 60_000
/** A side question waits for the model; every progress frame renews the wait (the SDK's own default is ten minutes). */
const SIDE_QUESTION_TIMEOUT_MS = 660_000
/** Prompts of this process kept for `/rewind` until the transcript lists them. */
const MAX_SENT_PROMPTS = 100
/** Why a `/rewind … confirm` waits: both the files and the conversation change under a turn that is running. */
const REWIND_BUSY = 'Wait for the current turn to finish (or stop it), then confirm again: changing the files or cutting the conversation back under a running turn would corrupt both.'
const INTERRUPT_TIMEOUT_MS = 15_000
/** If the CLI drops the interrupted turn's `result`, keep the host from hanging. */
const INTERRUPT_SETTLE_FALLBACK_MS = 10_000
const CLOSE_STDIN_GRACE_MS = 1_500
const CLOSE_TERMINATE_GRACE_MS = 4_000
const STDERR_LIMIT = 8_192
const DETAIL_LIMIT = 2_000
const TAIL_CHUNK_BYTES = 64 * 1024
const ESCALATING_MODES: Readonly<Record<string, true>> = { bypassPermissions: true, auto: true, acceptEdits: true }
const NOT_FOUND_PATTERN = /No conversation found with session ID/i

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const truncate = (value: string, limit: number): string => (value.length <= limit ? value : `${value.slice(0, limit)}…`)
const commandSuccess = (value: string): NativeCommandResult => ({ kind: 'success', text: value })
const commandError = (value: string): NativeCommandResult => ({ kind: 'error', text: value })
/** `value` as one sentence: whatever the CLI or a message ended in, it ends in a single full stop. */
const sentence = (value: string): string => `${value.replace(/[.\s]+$/, '')}.`

/**
 * Sessions this host process created and has not prompted yet, with the conversation a fork was
 * made from. Claude Code writes a conversation at its first prompt, so such a session cannot be
 * resumed; like claude-agent-acp's `recreateLiveSession`, it restarts under the same id instead
 * of becoming "not found" (a fork is forked from its parent again, a new session starts empty).
 */
const unpromptedSessions = new Map<string, { readonly parentSessionId: string | undefined }>()

/** Context windows the CLI reported, by resolved model id, so a later switch starts from the truth. */
const learnedContextWindows = new Map<string, number>()

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
}

function deferred<T>(): Deferred<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  const { promise: timedOut, resolve } = Promise.withResolvers<T>()
  const timer = setTimeout(() => resolve(fallback), timeoutMs)
  timer.unref()
  try {
    return await Promise.race([promise, timedOut])
  } finally {
    clearTimeout(timer)
  }
}

/** Wait until a stream delivered its last data (or `timeoutMs` passed): a dying process's final words arrive after its exit. */
async function streamEnded(stream: Readable, timeoutMs: number): Promise<void> {
  if (stream.readableEnded || stream.destroyed) return
  const { promise, resolve } = Promise.withResolvers<void>()
  stream.once('end', resolve)
  stream.once('close', resolve)
  await withTimeout(promise, timeoutMs, undefined)
}

// ---------------------------------------------------------------------------
// Pure protocol helpers (exported for the test suite)
// ---------------------------------------------------------------------------

export type ClaudeLaunchKind = 'new' | 'resume' | 'fork' | 'fresh'

export interface ClaudeArgvInput {
  /** Launcher argv: the executable first, then any launcher arguments. */
  readonly launcher: readonly string[]
  readonly kind: ClaudeLaunchKind
  /** The session id this process runs under (the new id for `new`/`fork`/`fresh`). */
  readonly sessionId: string
  /** The parent conversation of a `fork`. */
  readonly parentSessionId?: string | undefined
  readonly permissionMode: ClaudePermissionMode
  readonly allowBypass: boolean
  /**
   * The host can put a form to the user (`onElicitation`). claude-agent-acp disallows AskUserQuestion only for a client
   * without form elicitation, so the model is offered the tool only when its questions can be shown.
   */
  readonly questionSurface: boolean
}

/**
 * The CLI argv: the launcher, then the stream-json protocol flags and the flags
 * claude-agent-acp's SDK passes (setting sources, permission routing, partial messages).
 * AskUserQuestion is disallowed unless the host has a question surface; without one there is no form to ask in.
 */
export function buildClaudeArgv(input: ClaudeArgvInput): string[] {
  const argv = [
    ...input.launcher,
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-prompt-tool=stdio',
    '--setting-sources',
    'user,project,local',
    '--permission-mode',
    input.permissionMode,
  ]
  if (!input.questionSurface) argv.push('--disallowedTools=AskUserQuestion')
  if (input.allowBypass) argv.push('--allow-dangerously-skip-permissions')
  switch (input.kind) {
    case 'resume':
      argv.push('--resume', input.sessionId)
      break
    case 'fork':
      argv.push('--resume', input.parentSessionId ?? '', '--fork-session', '--session-id', input.sessionId)
      break
    case 'new':
    case 'fresh':
      argv.push('--session-id', input.sessionId)
      break
  }
  return argv
}

/** One stdin line: the CLI's stream-json user message, stamped as the user's own input. */
export function claudeUserMessageFrame(input: {
  readonly blocks: readonly NativeContentBlock[]
  readonly sessionId: string
  readonly priority?: 'now' | 'next' | 'later' | undefined
  readonly uuid?: string | undefined
}): Json {
  const content = input.blocks.map((block) =>
    block.type === 'text'
      ? { type: 'text', text: block.text }
      : { type: 'image', source: { type: 'base64', media_type: block.mimeType, data: block.data } },
  )
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    session_id: input.sessionId,
    uuid: input.uuid ?? randomUUID(),
    origin: { kind: 'human' },
    ...(input.priority === undefined ? {} : { priority: input.priority }),
  }
}

/** How a `result` frame ends the turn: a stop reason, or the vendor error text the turn failed with. */
export type ClaudeTurnOutcome =
  | { readonly stopReason: NativePromptResult['stopReason'] }
  | { readonly error: string }

/** Port of claude-agent-acp's result switch. */
export function claudeTurnOutcome(frame: Json, interrupted: boolean): ClaudeTurnOutcome {
  if (interrupted) return { stopReason: 'cancelled' }
  const errors = Array.isArray(frame['errors']) ? frame['errors'].filter((entry): entry is string => typeof entry === 'string') : []
  const subtype = text(frame['subtype'])
  const isError = frame['is_error'] === true
  const failure = (): ClaudeTurnOutcome => ({
    error: (subtype === 'success' ? text(frame['result']) : undefined) || errors.join(', ') || subtype || 'Claude Code turn failed',
  })
  if (frame['stop_reason'] === 'refusal') return { stopReason: 'refusal' }
  switch (subtype) {
    case 'success':
      if (frame['stop_reason'] === 'max_tokens') return { stopReason: 'max_tokens' }
      return isError ? failure() : { stopReason: 'end_turn' }
    case 'error_during_execution':
      if (frame['stop_reason'] === 'max_tokens') return { stopReason: 'max_tokens' }
      return isError ? failure() : { stopReason: 'end_turn' }
    case 'error_max_budget_usd':
    case 'error_max_turns':
    case 'error_max_structured_output_retries':
      return isError ? failure() : { stopReason: 'max_turn_requests' }
    default:
      return failure()
  }
}

/** Absolute path of the Claude configuration directory. */
export function claudeConfigDir(env: Readonly<Record<string, string | undefined>>): string {
  return env['CLAUDE_CONFIG_DIR'] ?? process.env['CLAUDE_CONFIG_DIR'] ?? path.join(os.homedir(), '.claude')
}

// ---------------------------------------------------------------------------
// Resumed transcript tail (resumed-session.js)
// ---------------------------------------------------------------------------

/** What a resume needs from the end of a transcript. */
export interface ResumedTail {
  /** Model of the last real assistant response. */
  readonly model?: string | undefined
  /** Permission mode the last human prompt ran in. */
  readonly permissionMode?: string | undefined
  /** Cumulative cost and per-model usage at the end of the transcript. */
  readonly costState?: { readonly totalCostUsd: number; readonly modelUsage: Record<string, ModelUsageRow> } | undefined
}

const concreteModel = (model: unknown): string | undefined => {
  if (typeof model !== 'string') return undefined
  const name = model.trim()
  return name.length > 0 && !/^<[^>]+>$/.test(name) ? name : undefined
}

/** Reads transcript lines from the end and keeps what a resume needs. */
class TailScan {
  readonly tail: { model?: string | undefined; permissionMode?: string | undefined; costState?: ResumedTail['costState'] } = {}
  private modeDone = false
  private planExited = false
  private humanSeen = false

  /** Visit the previous line; true when the scan has all it needs. */
  visit(line: Buffer): boolean {
    let parsed: Json | null | undefined
    const record = (marker: string): Json | undefined => {
      if (!line.includes(marker)) return undefined
      if (parsed === undefined) {
        try {
          const value: unknown = JSON.parse(line.toString('utf8'))
          parsed = isRecord(value) && value['isSidechain'] !== true ? value : null
        } catch {
          parsed = null
        }
      }
      return parsed ?? undefined
    }
    if (this.tail.model === undefined) {
      const entry = record('"assistant"')
      if (entry?.['type'] === 'assistant' && entry['parent_tool_use_id'] == null && entry['parent_agent_id'] == null && isRecord(entry['message'])) {
        const model = concreteModel(entry['message']['model'])
        if (model) this.tail.model = model
      }
    }
    if (this.tail.costState === undefined) {
      const entry = record('"cost-state"')
      if (entry?.['type'] === 'cost-state' && num(entry['totalCostUSD']) !== undefined) {
        this.tail.costState = { totalCostUsd: num(entry['totalCostUSD']) ?? 0, modelUsage: normalizeModelUsage(entry['modelUsage']) }
      }
    }
    if (!this.modeDone) this.visitForMode(record)
    return this.tail.model !== undefined && this.modeDone && (this.tail.costState !== undefined || this.humanSeen)
  }

  private visitForMode(record: (marker: string) => Json | undefined): void {
    const modeEntry = record('"permissionMode"')
    if (modeEntry?.['type'] === 'user' && typeof modeEntry['permissionMode'] === 'string' && modeEntry['permissionMode'].trim() !== '') {
      const mode = modeEntry['permissionMode'].trim()
      this.modeDone = true
      if (!(this.planExited && mode === 'plan')) this.tail.permissionMode = mode
      return
    }
    const exit = record('"plan_mode_exit"')
    if (exit && isRecord(exit['attachment']) && exit['attachment']['type'] === 'plan_mode_exit') {
      this.planExited = true
      return
    }
    const human = record('"human"')
    if (human?.['type'] === 'user' && isRecord(human['origin']) && human['origin']['kind'] === 'human') {
      this.modeDone = true
      this.humanSeen = true
    }
  }

  /** The end of the file was reached: whatever is missing does not exist. */
  finish(): void {
    this.modeDone = true
  }
}

/** The local transcript of a session, in whichever project directory Claude Code stored it. */
async function findTranscript(sessionId: string, configDir: string): Promise<string | undefined> {
  const projects = path.join(configDir, 'projects')
  let directories: string[]
  try {
    directories = await readdir(projects)
  } catch {
    return undefined
  }
  for (const directory of directories) {
    const candidate = path.join(projects, directory, `${sessionId}.jsonl`)
    try {
      await access(candidate)
      return candidate
    } catch {
      // Not in this project directory.
    }
  }
  return undefined
}

/** Model, permission mode and cost baseline of a stored conversation; empty when it cannot be read. */
export async function readClaudeResumedTail(sessionId: string, configDir: string): Promise<ResumedTail> {
  const filePath = await findTranscript(sessionId, configDir)
  if (filePath === undefined) return {}
  let handle: FileHandle | undefined
  try {
    handle = await open(filePath, 'r')
    const scan = new TailScan()
    let end = (await handle.stat()).size
    let pending: Buffer[] = []
    while (end > 0) {
      const start = Math.max(0, end - TAIL_CHUNK_BYTES)
      let chunk = Buffer.alloc(end - start)
      await handle.read(chunk, 0, chunk.length, start)
      for (let at = chunk.lastIndexOf(0x0a); at >= 0; at = chunk.lastIndexOf(0x0a)) {
        if (scan.visit(Buffer.concat([chunk.subarray(at + 1), ...pending]))) return scan.tail
        pending = []
        chunk = chunk.subarray(0, at)
      }
      pending.unshift(chunk)
      end = start
    }
    scan.visit(Buffer.concat(pending))
    scan.finish()
    return scan.tail
  } catch {
    return {}
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/**
 * The user messages of the conversation a stored transcript holds as it stands (oldest first), and every user message the transcript
 * recorded, on that conversation or cut off by a rewind. Both are empty when the transcript is missing or unreadable. The file outlives
 * the process and records a rewind, so the list does too.
 */
export async function readClaudeCheckpoints(
  sessionId: string,
  configDir: string,
): Promise<{ readonly checkpoints: ClaudeCheckpoint[]; readonly recorded: ReadonlySet<string> }> {
  const filePath = await findTranscript(sessionId, configDir)
  if (filePath === undefined) return { checkpoints: [], recorded: new Set() }
  const scan = new CheckpointScan()
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  try {
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) scan.visit(line)
  } catch {
    return { checkpoints: [], recorded: new Set() }
  } finally {
    stream.destroy()
  }
  return { checkpoints: scan.checkpoints, recorded: scan.recorded }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** `permissions.defaultMode`, unless a repository-controlled settings file tried to escalate it. */
function trustedDefaultMode(effective: Json, sources: readonly unknown[]): unknown {
  const permissions = isRecord(effective['permissions']) ? effective['permissions'] : undefined
  const mode = permissions?.['defaultMode']
  if (typeof mode !== 'string' || !Object.hasOwn(ESCALATING_MODES, mode)) return mode
  for (let index = sources.length - 1; index >= 0; index -= 1) {
    const source = sources[index]
    if (!isRecord(source) || !isRecord(source['settings'])) continue
    const sourcePermissions = isRecord(source['settings']['permissions']) ? source['settings']['permissions'] : undefined
    if (sourcePermissions?.['defaultMode'] === undefined) continue
    const name = String(source['source'])
    const untrusted = /project/i.test(name) || (mode !== 'acceptEdits' && /local/i.test(name))
    return untrusted ? undefined : mode
  }
  return mode
}

/** The settings the controls depend on, from the CLI's `get_settings` answer. */
export function parseClaudeSettings(raw: Json | undefined): ClaudeSettingsView {
  const effective = isRecord(raw?.['effective']) ? raw['effective'] : {}
  const sources = Array.isArray(raw?.['sources']) ? raw['sources'] : []
  const permissions = isRecord(effective['permissions']) ? effective['permissions'] : undefined
  const denied = sources
    .filter((source): source is Json => isRecord(source) && /managed|policy/i.test(String(source['source'])))
    .flatMap((source) => (isRecord(source['settings']) && Array.isArray(source['settings']['deniedModels']) ? source['settings']['deniedModels'] : []))
    .filter((entry): entry is string => typeof entry === 'string')
  const overrides = isRecord(effective['modelOverrides'])
    ? Object.fromEntries(Object.entries(effective['modelOverrides']).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : undefined
  return {
    model: effective['model'],
    availableModels: effective['availableModels'],
    modelOverrides: overrides,
    deniedModels: denied,
    effortLevel: effective['effortLevel'],
    modelSettings: isRecord(effective['modelSettings']) ? (effective['modelSettings'] as ClaudeSettingsView['modelSettings']) : undefined,
    ultracode: effective['ultracode'],
    permissions: { defaultMode: trustedDefaultMode(effective, sources), disableBypassPermissionsMode: permissions?.['disableBypassPermissionsMode'] },
  }
}

// ---------------------------------------------------------------------------
// Questions and MCP elicitations (ports of claude-agent-acp's elicitation.js)
// ---------------------------------------------------------------------------

/** `_meta` key under which an option carries its `preview`, the one option field ACP's `EnumOption` has no slot for. */
const ASK_OPTION_META_KEY = '_claude/askUserQuestionOption'

interface AskOption {
  readonly label: string
  readonly description: string | undefined
  readonly preview: string | undefined
}

/** One question of an AskUserQuestion call, with the form fields that carry its answer. */
interface AskQuestion {
  readonly question: string
  readonly header: string | undefined
  readonly options: readonly AskOption[]
  readonly multiSelect: boolean
  /** The form field holding the picks, and the free-text "Other" field that goes with it. */
  readonly field: string
  readonly customField: string
}

/**
 * Port of `extractAskUserQuestions`: the usable questions of an AskUserQuestion input, or `undefined` when none is
 * left. An option without a label cannot be shown, so it is dropped like a malformed question. The form fields are
 * numbered by position among the usable questions: `question_<n>` and its companion `question_<n>_custom`.
 */
function extractAskUserQuestions(input: Json): AskQuestion[] | undefined {
  const entries = input['questions']
  if (!Array.isArray(entries)) return undefined
  const questions: AskQuestion[] = []
  for (const entry of entries) {
    if (!isRecord(entry)) continue
    const question = entry['question']
    const rawOptions = entry['options']
    if (typeof question !== 'string' || !Array.isArray(rawOptions)) continue
    const options: AskOption[] = []
    for (const option of rawOptions) {
      if (!isRecord(option)) continue
      const label = text(option['label'])
      if (label !== undefined) {
        options.push({ label, description: text(option['description']), preview: text(option['preview']) })
      }
    }
    if (options.length > 0) {
      const index = questions.length
      questions.push({
        question,
        header: text(entry['header']),
        options,
        multiSelect: entry['multiSelect'] === true,
        field: `question_${index}`,
        customField: `question_${index}_custom`,
      })
    }
  }
  return questions.length > 0 ? questions : undefined
}

/**
 * Port of `askUserQuestionsToCreateRequest` for a client that is not AIR. Each question is a field `question_<n>`: a
 * titled `oneOf` enum, or for a multi-select an array of titled `anyOf` items, whose `const` is the option label (what
 * the tool records as the answer). It is followed by its own free-text field `question_<n>_custom`, the CLI's "Other"
 * box. Nothing is required, so the user can also skip.
 */
function askUserQuestionsRequest(questions: readonly AskQuestion[], toolUseID: string): NativeElicitationRequest {
  // A lone question is the form message; with several, each field carries its own question text.
  const only = questions.length === 1 ? questions[0] : undefined
  const properties: Record<string, acp.ElicitationPropertySchema> = {}
  for (const question of questions) {
    const options = question.options.map((option) => {
      const entry: acp.EnumOption = { const: option.label, title: option.label }
      if (option.description) entry.description = option.description
      // ACP's `EnumOption` has no slot for the preview; it travels under the reserved `_meta`.
      if (option.preview) entry._meta = { [ASK_OPTION_META_KEY]: { preview: option.preview } }
      return entry
    })
    const labels: { title?: string; description?: string } = {}
    if (question.header) labels.title = question.header
    if (only === undefined) labels.description = question.question
    properties[question.field] = question.multiSelect
      ? { type: 'array', ...labels, items: { anyOf: options } }
      : { type: 'string', ...labels, oneOf: options }
    properties[question.customField] = {
      type: 'string',
      title: 'Other',
      description: question.multiSelect
        ? 'Type your own answer to add to your selection above (optional).'
        : 'Type your own answer, or add a note to the option you chose above (optional).',
    }
  }
  return {
    message: only?.question ?? 'Please answer the following questions.',
    requestedSchema: { type: 'object', properties },
    ...(toolUseID === '' ? {} : { toolCallId: toolUseID }),
  }
}

/**
 * The content of an accepted response. As with the ACP SDK's validating guard, an accept whose content is ill-typed
 * counts as having none.
 */
function acceptedContent(response: acp.CreateElicitationResponse): Record<string, unknown> {
  if (response.action !== 'accept') return {}
  const content: unknown = isRecord(response) ? response['content'] : undefined
  if (!isRecord(content)) return {}
  // Every value must be an `ElicitationContentValue`: a string, a finite number, a boolean or a list of strings.
  const wellTyped = Object.values(content).every(
    (entry) =>
      typeof entry === 'string' ||
      typeof entry === 'boolean' ||
      (typeof entry === 'number' && Number.isFinite(entry)) ||
      (Array.isArray(entry) && entry.every((item) => typeof item === 'string')),
  )
  return wellTyped ? content : {}
}

/**
 * Port of `applyAskElicitationResponse`: the tool input with the user's answers folded in, or `undefined` when the
 * response cancels the call. Answers are keyed by question text. A single-select is answered by the pick, else by the
 * typed text; with both, the text rides along as the question's `notes` annotation. A multi-select takes the typed text
 * as one more pick. Decline answers nothing, so the model is told the user skipped.
 */
function applyAskResponse(
  response: acp.CreateElicitationResponse,
  input: Json,
  questions: readonly AskQuestion[],
): Json | undefined {
  if (response.action === 'decline') return { ...input, answers: {} }
  if (response.action !== 'accept') return undefined
  const content = acceptedContent(response)
  const answers: Record<string, string> = {}
  const annotations: Record<string, { readonly notes: string }> = {}
  for (const question of questions) {
    const custom = content[question.customField]
    const customText = typeof custom === 'string' ? custom.trim() : ''
    const value = content[question.field]
    const picks =
      value === undefined || value === null
        ? []
        : Array.isArray(value)
          ? value.filter((item) => item !== undefined && item !== null && item !== '').map(String)
          : [String(value)]
    if (question.multiSelect) {
      // The CLI's own UI writes a multi-select answer comma-joined, JSON-quoting an item with the separator or a quote.
      const items = customText === '' ? picks : [...picks, customText]
      const answer = items
        .map((item) => (item.includes(', ') || item.includes('"') ? JSON.stringify(item) : item))
        .join(', ')
      if (answer !== '') answers[question.question] = answer
      continue
    }
    const picked = picks.join(', ')
    if (picked === '') {
      if (customText !== '') answers[question.question] = customText
      continue
    }
    answers[question.question] = picked
    if (customText !== '') annotations[question.question] = { notes: customText }
  }
  return { ...input, answers, ...(Object.keys(annotations).length > 0 ? { annotations } : {}) }
}

/**
 * Port of `mcpElicitationToCreateRequest` for form mode: the form of an MCP server's `elicitation` control request
 * (Claude Agent SDK `SDKControlElicitationRequest`: `message`, `requested_schema`), or `undefined` when it carries no
 * message. The schema is only guaranteed to be an object schema.
 */
function mcpFormRequest(request: Json): NativeElicitationRequest | undefined {
  const message = text(request['message'])
  if (message === undefined) return undefined
  const schema = request['requested_schema']
  const requestedSchema: acp.ElicitationSchema = isRecord(schema)
    ? { ...schema, type: 'object' }
    : { type: 'object', properties: {} }
  return { message, requestedSchema }
}

/** Port of `createElicitationResponseToElicitResult`: the MCP `ElicitResult` for the host's response. */
function mcpElicitResult(response: acp.CreateElicitationResponse): Json {
  switch (response.action) {
    case 'accept':
      return { action: 'accept', content: acceptedContent(response) }
    case 'decline':
      return { action: 'decline' }
    default:
      return { action: 'cancel' }
  }
}

/** Settle with `operation`, or reject at once when `signal` aborts: a host that ignores it must not hold the CLI. */
function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  const onAbort = (): void => reject(new Error('Tool use aborted'))
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  operation.then(
    (value) => {
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    },
    (error: unknown) => {
      signal.removeEventListener('abort', onAbort)
      reject(error)
    },
  )
  return promise
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

interface SessionState {
  modes: acp.SessionModeState
  models: ClaudeModelState
  modelInfos: ClaudeModelInfo[]
  readonly sdkModels: ClaudeModelInfo[]
  readonly agents: ClaudeAgentInfo[]
  currentAgent: string
  fastEnabled: boolean
  fastReason: string | undefined
  /** The effort shown as current: a pick, or what settings resolve to. */
  effortSeed: string | undefined
  /** The effort the user pinned this session (cleared by "default" or an unsupporting model). */
  effortPinned: string | undefined
  readonly settings: ClaudeSettingsView
  readonly allowBypass: boolean
  prePlanMode: string | undefined
  autoFallbackWarned: boolean
  options: acp.SessionConfigOption[]
}

interface PendingControl {
  readonly deferred: Deferred<Json>
  /** Called for each `control_request_progress` frame of this request. */
  readonly onProgress?: (() => void) | undefined
  /** The caller stopped waiting (abort, timeout): the answer the CLI may still send is dropped without a diagnostic. */
  abandoned?: boolean
}

interface PromptSettlement {
  readonly resolve: (result: NativePromptResult) => void
  readonly reject: (error: Error) => void
}

/** A user shell command (`!cmd`) in flight: the CLI streams its output as replay frames and ends it with `command_lifecycle`. */
interface ShellEscape {
  readonly uuid: string
  readonly toolCallId: string
  stdout: string
  stderr: string
  exitCode: number | undefined
}

/** One `claude` CLI process speaking stream-json. Not reusable after `close()`. */
export class ClaudeCliTransport implements NativeTransport {
  readonly kind: NativeTransportKind = 'claude'
  readonly canFork = true

  private options: NativeTransportStartOptions | undefined
  private proc: NativeProcess | undefined
  private lines: Interface | undefined
  private stderr = ''
  private startupResultErrors = ''
  private exitError: NativeTransportError | undefined
  private exited = false
  private closeRequested = false

  private sessionIdValue: string | undefined
  private claudeVersion: string | undefined
  private state: SessionState | undefined
  /** The CLI's own command list (`initialize.commands`, then every `commands_changed`); `undefined` until it reported one. */
  private liveCommands: unknown
  private terminalCommands: readonly string[] = CLAUDE_TERMINAL_COMMANDS
  /** The catalog last announced with a `commands` event. */
  private catalog: readonly NativeCommand[] | undefined
  private mapper: ClaudeFrameMapper | undefined
  private readonly capabilities = new Set<string>()

  private promptSettlement: PromptSettlement | undefined
  private activeTurnUuid: string | undefined
  private interruptRequested = false
  private interruptInFlight: Promise<void> | undefined
  private interruptFallbackTimer: NodeJS.Timeout | undefined
  /** uuids of messages this transport injected into the running turn. */
  private readonly injectedTurnUuids = new Set<string>()
  private readonly pendingControls = new Map<string, PendingControl>()
  /** Aborts the host callbacks the CLI may withdraw or an interrupt ends: permission prompts, questions, MCP forms. */
  private readonly permissionControllers = new Map<string, AbortController>()
  private exitPlanInterrupted = false
  /** Background tasks of this process, for `/tasks`. */
  private readonly tasks = new ClaudeTaskLedger()
  /** The side questions already answered in this conversation: the next one carries them as its `history`. */
  private readonly sideHistory = new SideHistory()
  /** The messages this process sent as prompts: file checkpoints the transcript may not hold yet. */
  private sentPrompts: ClaudeCheckpoint[] = []
  /**
   * The messages a `/rewind` of this process cut off. The CLI writes the marker that records the cut a moment after it answers, and
   * until then the transcript still lists them; a message that was forgotten never comes back, so they stay hidden.
   */
  private readonly forgotten = new Set<string>()
  /** Set by `conversation_reset`: the next frame of the new conversation names its session id. */
  private pendingReset: { readonly trigger: string } | undefined
  /** The `!cmd` the active prompt runs, if any. */
  private shell: ShellEscape | undefined

  /** Cumulative per-model usage at the last `result`, the baseline of the next turn. */
  private usageBaseline: Record<string, ModelUsageRow> | undefined
  private baselineCost: number | undefined
  /** Usage of results that arrived with no prompt in flight; charged to the next turn. */
  private carry: ModelUsageRow = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0, costUsd: 0 }
  private refusalExplanation: string | undefined

  private startPromise: Promise<void> | undefined
  private closePromise: Promise<void> | undefined

  get sessionId(): string | undefined {
    return this.sessionIdValue
  }

  get agentInfo(): { readonly name: string; readonly version: string } {
    return { name: 'claude', version: this.claudeVersion ?? '' }
  }

  /** True once the process exited or `close()` ran; such a transport cannot take another turn. */
  get closed(): boolean {
    return this.closeRequested || this.exited
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
    try {
      this.options?.onEvent(event)
    } catch (error: unknown) {
      this.log(`claude: onEvent handler threw: ${messageOf(error)}`)
    }
  }

  private emitAll(events: readonly NativeTransportEvent[]): void {
    for (const event of events) this.emit(event)
  }

  private notice(message: string): void {
    this.emit({ kind: 'notice', text: truncate(message, DETAIL_LIMIT) })
  }

  // -- lifecycle -----------------------------------------------------------

  start(options: NativeTransportStartOptions): Promise<void> {
    if (this.startPromise !== undefined) return this.startPromise
    this.startPromise = this.startInternal(options).catch(async (error: unknown) => {
      await this.close().catch(() => undefined)
      throw error instanceof NativeTransportError
        ? error
        : new NativeTransportError(`Failed to start Claude Code: ${messageOf(error)}`, 'claude_start_failed', this.stderrTail())
    })
    return this.startPromise
  }

  private async startInternal(options: NativeTransportStartOptions): Promise<void> {
    if (this.closeRequested) throw new NativeTransportError('Claude transport is closed', 'closed')
    this.options = options
    if (options.argv.length === 0 || !options.argv[0]) {
      throw new NativeTransportError('no Claude Code launcher was configured', 'spawn-failed')
    }
    const target = options.session
    const configDir = claudeConfigDir(options.env)
    const sessionId = target.kind === 'resume' ? target.sessionId : randomUUID()
    const allowBypass = this.allowBypassFor(options.env)
    // The conversation a resume continues or a fork inherits; its transcript tail restores mode and model.
    let kind: ClaudeLaunchKind = target.kind
    let parentSessionId = target.kind === 'fork' ? target.parentSessionId : undefined
    const sourceOf = (): string | undefined => parentSessionId ?? (kind === 'resume' ? sessionId : undefined)
    let tail = await this.readTail(sourceOf(), configDir)
    const launchWith = async (): Promise<{ readonly init: Json; readonly mode: ClaudePermissionMode }> => {
      const mode = resolveInitialPermissionMode({ resumed: tail?.permissionMode }, allowBypass, (message) => this.log(message))
      const argv = buildClaudeArgv({
        launcher: options.argv,
        kind,
        sessionId,
        parentSessionId,
        permissionMode: mode,
        allowBypass,
        questionSurface: options.onElicitation !== undefined,
      })
      return { init: await this.launch(argv, sessionId), mode }
    }
    let launched: { readonly init: Json; readonly mode: ClaudePermissionMode }
    try {
      launched = await launchWith()
    } catch (error: unknown) {
      const unprompted = target.kind === 'resume' ? unpromptedSessions.get(sessionId) : undefined
      if (!(error instanceof NativeTransportError && error.code === 'session-not-found' && unprompted !== undefined)) throw error
      // Never prompted in this process, so nothing was stored: start again under the same id (a fork from its parent again).
      this.log(`claude: session ${sessionId} was never persisted; starting it again under the same id`)
      await this.discardProcess()
      parentSessionId = unprompted.parentSessionId
      kind = parentSessionId === undefined ? 'fresh' : 'fork'
      tail = await this.readTail(parentSessionId, configDir)
      launched = await launchWith()
    }
    this.sessionIdValue = sessionId
    await this.assemble(launched.init, tail, launched.mode, kind === 'resume' || kind === 'fork')
    // A new conversation has no cost history; a resumed or forked one continues from its transcript.
    if (kind === 'new' || kind === 'fresh') {
      this.usageBaseline = {}
      this.baselineCost = 0
    } else if (tail?.costState !== undefined) {
      this.usageBaseline = tail.costState.modelUsage
      this.baselineCost = tail.costState.totalCostUsd
    }
    if (kind === 'resume') unpromptedSessions.delete(sessionId)
    else unpromptedSessions.set(sessionId, { parentSessionId: kind === 'fork' ? parentSessionId : undefined })
    this.announceCommandsSoon()
    void this.refreshContextWindow()
  }

  private async readTail(sessionId: string | undefined, configDir: string): Promise<ResumedTail | undefined> {
    return sessionId === undefined ? undefined : await readClaudeResumedTail(sessionId, configDir)
  }

  /** Root cannot use bypass unless sandboxed; the CLI refuses it too. */
  private allowBypassFor(env: Readonly<Record<string, string>>): boolean {
    const isRoot = (process.geteuid?.() ?? process.getuid?.()) === 0
    return !isRoot || !!(env['IS_SANDBOX'] ?? process.env['IS_SANDBOX'])
  }

  /** Spawn the CLI and complete the control handshake; resolves with the `initialize` answer. */
  private async launch(argv: readonly string[], sessionId: string): Promise<Json> {
    const options = this.requireOptions()
    this.stderr = ''
    this.startupResultErrors = ''
    this.exitError = undefined
    this.exited = false
    // File checkpoints are what `/rewind` restores. A host that sets CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING still switches them off.
    const env: Record<string, string> = { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: 'true', ...options.env }
    let proc: NativeProcess
    try {
      proc = options.spawn({ argv, cwd: options.cwd, env })
    } catch (error: unknown) {
      if (error instanceof NativeTransportError) throw error
      throw new NativeTransportError(`could not launch ${argv[0] ?? 'claude'}: ${messageOf(error)}`, 'spawn-failed')
    }
    this.proc = proc
    this.mapper = new ClaudeFrameMapper({ cwd: options.cwd })
    proc.stderr.on('data', (chunk: Buffer | string) => {
      this.stderr += chunk.toString()
      if (this.stderr.length > STDERR_LIMIT) this.stderr = this.stderr.slice(-STDERR_LIMIT)
    })
    proc.stdin.on('error', (error: Error) => this.log(`claude: stdin error: ${error.message}`))
    this.lines = createInterface({ input: proc.stdout })
    this.lines.on('line', (line: string) => this.handleLine(line))
    proc.exited.then(
      (outcome) => this.handleExit(proc, outcome.exitCode, outcome.signal),
      (error: unknown) => this.handleLaunchFailure(proc, error),
    )
    try {
      // `perTaskStopAffordance`: /tasks can stop one background task, so an interrupt may leave them running.
      return await this.controlRequest('initialize', { perTaskStopAffordance: true }, INITIALIZE_TIMEOUT_MS)
    } catch (error: unknown) {
      // The CLI's last words (stderr, an error `result`) may still be in flight when it exits.
      await Promise.all([streamEnded(proc.stderr, 500), streamEnded(proc.stdout, 500)])
      if (NOT_FOUND_PATTERN.test(`${this.stderr}\n${this.startupResultErrors}`)) {
        throw new NativeTransportError(`Claude Code session not found: ${sessionId}`, 'session-not-found', this.stderrTail())
      }
      if (error instanceof NativeTransportError) throw error
      throw new NativeTransportError(`Claude Code did not initialize: ${messageOf(error)}`, 'claude_start_failed', this.stderrTail())
    }
  }

  /** Stop the process of a failed start attempt without closing the transport. */
  private async discardProcess(): Promise<void> {
    const proc = this.proc
    this.proc = undefined
    this.lines?.close()
    this.lines = undefined
    this.rejectPendingControls(new NativeTransportError('Claude process discarded', 'closed'))
    if (proc !== undefined && !this.exited) {
      proc.terminate()
      await withTimeout(proc.exited.catch(() => undefined), CLOSE_TERMINATE_GRACE_MS, undefined)
    }
  }

  private requireOptions(): NativeTransportStartOptions {
    if (this.options === undefined) throw new NativeTransportError('Claude transport was not started', 'not_started')
    return this.options
  }

  private requireState(): SessionState {
    if (this.state === undefined) throw new NativeTransportError('Claude transport was not started', 'not_started')
    return this.state
  }

  private stderrTail(): string | undefined {
    const trimmed = this.stderr.replace(/⚠[^\n]*\n?/g, '').trim()
    return trimmed === '' ? undefined : truncate(trimmed, DETAIL_LIMIT)
  }

  private handleExit(proc: NativeProcess, exitCode: number | null, signal: string | null): void {
    if (proc !== this.proc) return
    this.exited = true
    if (this.closeRequested) return
    const description =
      exitCode === 0 && signal === null ? 'claude CLI exited' : `claude CLI exited with code ${String(exitCode)} signal ${String(signal)}`
    this.failProcess(new NativeTransportError(description, 'process_exit', this.stderrTail()))
  }

  private handleLaunchFailure(proc: NativeProcess, error: unknown): void {
    if (proc !== this.proc) return
    this.exited = true
    if (this.closeRequested) return
    this.failProcess(new NativeTransportError(`could not launch claude: ${messageOf(error)}`, 'spawn-failed'))
  }

  private failProcess(error: NativeTransportError): void {
    this.exitError ??= error
    this.log(`claude: ${error.message}${error.detail === undefined ? '' : ` (${error.detail})`}`)
    this.settlePromptReject(error)
    this.rejectPendingControls(error)
    this.notice(error.message)
  }

  // -- stdin / stdout --------------------------------------------------------

  private writeFrame(payload: Json): void {
    const proc = this.proc
    if (proc === undefined || this.closeRequested) return
    if (proc.stdin.destroyed || !proc.stdin.writable) throw new NativeTransportError('claude CLI stdin is not writable', 'stdin_closed')
    proc.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  private handleLine(line: string): void {
    if (this.closeRequested) return
    const trimmed = line.trim()
    if (trimmed === '') return
    let raw: unknown
    try {
      raw = JSON.parse(trimmed)
    } catch {
      this.log(`claude: ignoring non-JSON stdout line: ${truncate(trimmed, 200)}`)
      return
    }
    if (!isRecord(raw)) return
    switch (raw['type']) {
      case 'control_request':
        void this.handleControlRequest(raw)
        return
      case 'control_response':
        this.handleControlResponse(raw)
        return
      case 'control_cancel_request': {
        const requestId = text(raw['request_id'])
        if (requestId !== undefined) this.permissionControllers.get(requestId)?.abort()
        return
      }
      case 'result':
        this.handleResult(raw)
        return
      case 'system':
        this.handleSystemFrame(raw)
        return
      case 'conversation_reset':
        // `/clear` and the plan-exit "clear context" start a new conversation; the `system/init` that follows names its session.
        this.pendingReset = { trigger: text(raw['trigger']) ?? 'clear' }
        return
      case 'command_lifecycle':
        this.handleCommandLifecycle(raw)
        return
      case 'user':
        // The replay frames of a user shell command carry its output; they are not conversation messages.
        if (!this.captureBashReplay(raw)) this.mapFrame(raw)
        return
      case 'stream_event':
      case 'assistant':
      case 'tool_progress':
      case 'rate_limit_event':
      case 'active_goal':
        this.mapFrame(raw)
        return
      default:
        // keep_alive, prompt_suggestion, … are additive.
        return
    }
  }

  private mapFrame(frame: Json): void {
    const mapper = this.mapper
    if (mapper === undefined) return
    if (frame['type'] === 'assistant') this.noteRefusal(frame)
    this.emitAll(mapper.map(frame))
  }

  private noteRefusal(frame: Json): void {
    const message = isRecord(frame['message']) ? frame['message'] : undefined
    if (message?.['stop_reason'] === 'refusal' && isRecord(message['stop_details'])) {
      this.refusalExplanation = text(message['stop_details']['explanation']) ?? this.refusalExplanation
    }
  }

  private handleSystemFrame(frame: Json): void {
    const subtype = text(frame['subtype'])
    switch (subtype) {
      case 'init':
        this.handleInit(frame)
        return
      case 'control_request_progress':
        // Progress of a side question: it renews that request's wait and belongs to no turn.
        this.pendingControls.get(text(frame['request_id']) ?? '')?.onProgress?.()
        return
      case 'commands_changed':
        this.setLiveCommands(frame['commands'])
        return
      case 'status':
        this.syncPermissionMode(frame['permissionMode'])
        break
      case 'api_retry':
      case 'api_error':
      case 'model_fallback':
      case 'model_refusal_fallback':
      case 'model_refusal_no_fallback':
      case 'model_consent_fallback':
      case 'notification':
        this.handleNote(subtype, frame)
        return
      default:
        // Background task frames feed /tasks; they never reach the conversation.
        if (this.tasks.apply(frame)) return
    }
    this.mapFrame(frame)
  }

  /**
   * A retry, fallback or notification frame: a note in the turn the user is watching, and a new model in the controls when the
   * swap outlives the turn (the main thread's refusal fallback, a declined usage-credit prompt). A fallback of one turn, of a
   * subagent or of a side question leaves the session model alone.
   */
  private handleNote(subtype: string, frame: Json): void {
    if ((subtype === 'model_refusal_fallback' && frame['scope'] !== 'local') || subtype === 'model_consent_fallback') {
      this.syncModelFromInit(text(frame['fallback_model']))
    }
    // An autonomous turn has no listener for a note.
    if (this.promptSettlement !== undefined) this.mapFrame(frame)
  }

  private handleInit(frame: Json): void {
    const sessionId = text(frame['session_id'])
    this.adoptResetSession(sessionId)
    if (sessionId !== undefined && sessionId !== '' && sessionId !== this.sessionIdValue) {
      this.log(`claude: the CLI reports session ${sessionId} for requested ${this.sessionIdValue ?? 'unknown'}`)
    }
    if (Array.isArray(frame['capabilities'])) {
      this.capabilities.clear()
      for (const entry of frame['capabilities']) if (typeof entry === 'string') this.capabilities.add(entry)
    }
    this.syncPermissionMode(frame['permissionMode'])
    this.syncFastMode(frame['fast_mode_state'], frame['fast_mode_disabled_reason'])
    this.syncModelFromInit(text(frame['model']))
    if (Array.isArray(frame['terminal_slash_commands'])) {
      const terminal = frame['terminal_slash_commands'].filter((entry): entry is string => typeof entry === 'string')
      if (JSON.stringify(terminal) !== JSON.stringify(this.terminalCommands)) {
        this.terminalCommands = terminal
        this.refreshCatalog(false)
      }
    }
  }

  /**
   * After `conversation_reset` the next frame that names a session names the new one: from then on every turn, resume and rebind
   * belongs to it, and what the old conversation said (side questions, checkpoints) no longer applies.
   */
  private adoptResetSession(sessionId: string | undefined): void {
    const reset = this.pendingReset
    if (reset === undefined || sessionId === undefined || sessionId === '' || sessionId === this.sessionIdValue) return
    this.pendingReset = undefined
    this.log(`claude: the conversation was reset (${reset.trigger}); session ${this.sessionIdValue ?? 'unknown'} is now ${sessionId}`)
    this.sessionIdValue = sessionId
    this.sideHistory.clear()
    this.sentPrompts = []
    this.forgotten.clear()
    this.emit({ kind: 'session_changed', sessionId, reason: reset.trigger })
    this.emitAll(this.mapper?.restartContext(0) ?? [])
    // The CLI answers `/clear` with an empty result, which the host would take for a turn without a reply.
    if (reset.trigger === 'clear' && this.promptSettlement !== undefined) {
      const note = `Cleared the model's context: Claude Code started a new session (\`${sessionId.slice(0, 8)}\`). The messages above stay in this conversation but are no longer sent to the model.`
      this.emit(updateEvent({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: note } }))
    }
  }

  // -- commands ----------------------------------------------------------------

  commands(): readonly NativeCommand[] {
    return this.catalog ?? claudeCommandCatalog(this.liveCommands, this.terminalCommands)
  }

  /** Recompute the catalog and announce it when it differs from the last one (or `force`: the first announcement after `start()`). */
  private refreshCatalog(force: boolean): void {
    const next = claudeCommandCatalog(this.liveCommands, this.terminalCommands)
    const changed = JSON.stringify(next) !== JSON.stringify(this.catalog ?? [])
    this.catalog = next
    if (changed || force) this.emit({ kind: 'commands', commands: next })
  }

  /** The CLI re-listed its commands (`commands_changed`, a plugin or skill reload): follow it. */
  private setLiveCommands(commands: unknown): void {
    if (!Array.isArray(commands)) return
    this.liveCommands = commands
    this.refreshCatalog(false)
  }

  private announceCommandsSoon(): void {
    // Delivered after start() resolves, so the runtime has attached the session id by then.
    const timer = setTimeout(() => {
      if (!this.closeRequested) this.refreshCatalog(true)
    }, 0)
    timer.unref()
  }

  // -- control channel -------------------------------------------------------

  /** Send a control request and resolve with its `response` object; rejects on an error answer or timeout. */
  private async controlRequest(subtype: string, extra: Json, timeoutMs: number = CONTROL_TIMEOUT_MS): Promise<Json> {
    if (this.exitError !== undefined) throw this.exitError
    const requestId = `dsh-${subtype}-${randomUUID()}`
    const pending = deferred<Json>()
    this.pendingControls.set(requestId, { deferred: pending })
    try {
      this.writeFrame({ type: 'control_request', request_id: requestId, request: { subtype, ...extra } })
      const timeout = Symbol('timeout')
      const answer = await withTimeout<Json | typeof timeout>(pending.promise, timeoutMs, timeout)
      if (answer === timeout) throw new NativeTransportError(`Claude Code did not answer ${subtype} in time`, 'control-timeout', this.stderrTail())
      return answer
    } finally {
      this.pendingControls.delete(requestId)
    }
  }

  /** A control request whose failure only needs logging. */
  private async controlRequestSoft(subtype: string, extra: Json, timeoutMs: number = CONTROL_TIMEOUT_MS): Promise<Json | undefined> {
    try {
      return await this.controlRequest(subtype, extra, timeoutMs)
    } catch (error: unknown) {
      // A request the host's own shutdown cut short is not worth a diagnostic.
      if (!this.closeRequested) this.log(`claude: ${subtype} failed: ${messageOf(error)}`)
      return undefined
    }
  }

  /**
   * A control request the caller can walk away from, for the requests that are not part of the handshake: a side question that
   * may wait for the model, a command the user can cancel. `idleMs` is how long the CLI may stay silent, and each progress frame
   * renews it. When the caller aborts or the CLI stays silent, the request is withdrawn with `control_cancel_request` if the CLI
   * can act on that (`withdraw`), and whatever it answers later is dropped. Rejects with code `control-cancelled` on an abort.
   */
  private async cancellableRequest(
    subtype: string,
    extra: Json,
    options: { readonly signal: AbortSignal; readonly idleMs: number; readonly withdraw: boolean },
  ): Promise<Json> {
    if (this.exitError !== undefined) throw this.exitError
    if (options.signal.aborted) throw new NativeTransportError(`${subtype} was cancelled`, 'control-cancelled')
    const requestId = `dsh-${subtype}-${randomUUID()}`
    const answer = deferred<Json>()
    let timer: NodeJS.Timeout | undefined
    const abandon = (error: NativeTransportError): void => {
      pending.abandoned = true
      if (options.withdraw) {
        try {
          this.writeFrame({ type: 'control_cancel_request', request_id: requestId })
        } catch (cancelError: unknown) {
          this.log(`claude: could not withdraw ${subtype}: ${messageOf(cancelError)}`)
        }
      }
      answer.reject(error)
    }
    const wait = (): void => {
      clearTimeout(timer)
      timer = setTimeout(
        () => abandon(new NativeTransportError(`Claude Code did not answer ${subtype} in time`, 'control-timeout', this.stderrTail())),
        options.idleMs,
      )
      timer.unref()
    }
    const pending: PendingControl = {
      deferred: answer,
      onProgress: () => {
        // A late progress frame of an abandoned request must not arm another wait.
        if (pending.abandoned !== true) wait()
      },
    }
    const onAbort = (): void => abandon(new NativeTransportError(`${subtype} was cancelled`, 'control-cancelled'))
    this.pendingControls.set(requestId, pending)
    options.signal.addEventListener('abort', onAbort, { once: true })
    try {
      this.writeFrame({ type: 'control_request', request_id: requestId, request: { subtype, ...extra } })
      wait()
      return await answer.promise
    } finally {
      clearTimeout(timer)
      options.signal.removeEventListener('abort', onAbort)
      // An abandoned request stays registered until the CLI answers it, so the late answer is recognised and dropped.
      if (pending.abandoned !== true) this.pendingControls.delete(requestId)
    }
  }

  private handleControlResponse(frame: Json): void {
    const response = isRecord(frame['response']) ? frame['response'] : undefined
    const requestId = text(response?.['request_id'])
    if (response === undefined || requestId === undefined) return
    const pending = this.pendingControls.get(requestId)
    if (pending === undefined) {
      this.log(`claude: control response for unknown request ${requestId}`)
      return
    }
    this.pendingControls.delete(requestId)
    // The caller gave up on this request (abort, timeout): the CLI's answer, possibly its "cancelled" error, is of no use.
    if (pending.abandoned === true) return
    if (response['subtype'] === 'error') {
      pending.deferred.reject(new NativeTransportError(text(response['error']) ?? 'Claude Code rejected the request', 'control-error'))
      return
    }
    pending.deferred.resolve(isRecord(response['response']) ? response['response'] : {})
  }

  private replyControl(requestId: string, response: Json): void {
    try {
      this.writeFrame({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
    } catch (error: unknown) {
      this.log(`claude: failed to answer control request ${requestId}: ${messageOf(error)}`)
    }
  }

  private replyControlError(requestId: string, message: string): void {
    try {
      this.writeFrame({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: message } })
    } catch (error: unknown) {
      this.log(`claude: failed to answer control request ${requestId}: ${messageOf(error)}`)
    }
  }

  private rejectPendingControls(error: Error): void {
    for (const pending of this.pendingControls.values()) pending.deferred.reject(error)
    this.pendingControls.clear()
    for (const controller of this.permissionControllers.values()) controller.abort()
    this.permissionControllers.clear()
  }

  private async handleControlRequest(frame: Json): Promise<void> {
    const requestId = text(frame['request_id'])
    const request = isRecord(frame['request']) ? frame['request'] : undefined
    if (requestId === undefined || request === undefined) {
      this.log('claude: ignoring malformed control_request')
      return
    }
    const subtype = text(request['subtype'])
    try {
      switch (subtype) {
        case 'can_use_tool':
          await this.handleCanUseTool(requestId, request)
          return
        case 'elicitation':
          await this.answerMcpElicitation(requestId, request)
          return
        case 'request_user_dialog':
          this.replyControl(requestId, { behavior: 'cancelled' })
          return
        case 'hook_callback':
          this.replyControl(requestId, { continue: true })
          return
        default:
          // The CLI waits for an answer: an unknown host callback must be refused or the turn hangs.
          this.log(`claude: unsupported control request ${subtype ?? 'unknown'} (${requestId})`)
          this.replyControlError(requestId, `DSH native transport does not support ${subtype ?? 'this'} request`)
      }
    } catch (error: unknown) {
      this.log(`claude: failed to answer ${subtype ?? 'control'} request: ${messageOf(error)}`)
      this.replyControlError(requestId, messageOf(error))
    }
  }

  private async handleCanUseTool(requestId: string, request: Json): Promise<void> {
    // With a question surface the model's questions are a form for the user rather than a permission check.
    const elicit = this.requireOptions().onElicitation
    if (request['tool_name'] === 'AskUserQuestion' && elicit !== undefined) {
      await this.askUserQuestion(requestId, request, elicit)
      return
    }
    const state = this.state
    const mapper = this.mapper
    const prepared = prepareClaudePermission(request, {
      cwd: this.requireOptions().cwd,
      availableModes: state?.modes.availableModes.map((mode) => mode.id) ?? [],
      prePlanMode: state?.prePlanMode,
      autoUnavailable: state !== undefined && this.isAutoUnavailable(state),
    })
    this.log(`claude: permission request ${requestId} (${prepared.toolUse.name})`)
    // The request names a tool call the host must already know.
    if (mapper !== undefined) this.emitAll(mapper.ensureToolCall(prepared.toolUse))
    const controller = new AbortController()
    this.permissionControllers.set(requestId, controller)
    try {
      const decision = await this.askPermission(prepared.request, controller.signal)
      const result = prepared.decide(decision)
      if (result === undefined || controller.signal.aborted) {
        this.replyControlError(requestId, 'Tool use aborted')
        return
      }
      if (prepared.toolUse.name === 'ExitPlanMode' && result['behavior'] === 'deny' && result['interrupt'] === true) {
        this.exitPlanInterrupted = true
      }
      this.replyControl(requestId, result)
    } finally {
      this.permissionControllers.delete(requestId)
    }
  }

  private async askPermission(request: NativePermissionRequest, signal: AbortSignal): Promise<NativePermissionDecision> {
    const handler = this.options?.onPermission
    if (handler === undefined || signal.aborted) return { cancelled: true }
    const { promise, resolve } = Promise.withResolvers<NativePermissionDecision>()
    const onAbort = (): void => finish({ cancelled: true })
    const finish = (decision: NativePermissionDecision): void => {
      signal.removeEventListener('abort', onAbort)
      resolve(decision)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve()
      .then(() => handler(request, signal))
      .then(finish, (error: unknown) => {
        this.log(`claude: onPermission handler failed: ${messageOf(error)}`)
        finish({ cancelled: true })
      })
    return await promise
  }

  /**
   * Port of claude-agent-acp's `handleAskUserQuestion`: the questions of an AskUserQuestion call go to the host as one
   * form, and the answers return as the `updatedInput` the tool runs with. The CLI asks through `can_use_tool`.
   */
  private async askUserQuestion(requestId: string, request: Json, elicit: NativeElicitationHandler): Promise<void> {
    const toolUseID = text(request['tool_use_id']) ?? ''
    const input = isRecord(request['input']) ? request['input'] : {}
    const mapper = this.mapper
    this.log(`claude: question request ${requestId} (AskUserQuestion)`)
    // The form names a tool call the host must already know.
    if (mapper !== undefined) this.emitAll(mapper.ensureToolCall({ id: toolUseID, name: 'AskUserQuestion', input }))
    const questions = extractAskUserQuestions(input)
    if (questions === undefined) {
      this.replyControl(requestId, denyResult(toolUseID, 'AskUserQuestion called with no valid questions.'))
      return
    }
    const form = askUserQuestionsRequest(questions, toolUseID)
    const controller = new AbortController()
    const { signal } = controller
    this.permissionControllers.set(requestId, controller)
    try {
      let response: acp.CreateElicitationResponse | undefined
      try {
        response = await raceWithAbort(Promise.resolve().then(() => elicit(form, signal)), signal)
      } catch (error: unknown) {
        // A withdrawn question aborts the tool use; any other failure tells the model it could not be asked.
        if (!signal.aborted) {
          this.log(`claude: could not present AskUserQuestion: ${messageOf(error)}`)
          this.replyControl(requestId, denyResult(toolUseID, 'Could not present the question to the user.'))
          return
        }
      }
      const answered =
        response === undefined || signal.aborted ? undefined : applyAskResponse(response, input, questions)
      if (answered === undefined) {
        this.replyControlError(requestId, 'Tool use aborted')
        return
      }
      this.replyControl(requestId, allowResult(answered, toolUseID))
    } finally {
      this.permissionControllers.delete(requestId)
    }
  }

  /**
   * Port of claude-agent-acp's `handleMcpElicitation`: an MCP server's form goes to the host and the response returns
   * as the `ElicitResult`. A URL (DSH never opens agent URLs), a request without a form to show, and a host without a
   * question surface are declined; a withdrawn request is cancelled.
   */
  private async answerMcpElicitation(requestId: string, request: Json): Promise<void> {
    const elicit = this.requireOptions().onElicitation
    const form = request['mode'] === 'url' ? undefined : mcpFormRequest(request)
    if (elicit === undefined || form === undefined) {
      this.replyControl(requestId, { action: 'decline' })
      return
    }
    const controller = new AbortController()
    const { signal } = controller
    this.permissionControllers.set(requestId, controller)
    let result: Json
    try {
      const response = await raceWithAbort(Promise.resolve().then(() => elicit(form, signal)), signal)
      result = signal.aborted ? { action: 'cancel' } : mcpElicitResult(response)
    } catch (error: unknown) {
      if (!signal.aborted) this.log(`claude: could not forward the MCP elicitation: ${messageOf(error)}`)
      result = { action: signal.aborted ? 'cancel' : 'decline' }
    } finally {
      this.permissionControllers.delete(requestId)
    }
    this.replyControl(requestId, result)
  }

  // -- session assembly --------------------------------------------------------

  /** Build the session state from the CLI's `initialize` answer, applying the model and mode a vendor session would. */
  private async assemble(init: Json, tail: ResumedTail | undefined, spawnMode: ClaudePermissionMode, resumed: boolean): Promise<void> {
    const options = this.requireOptions()
    this.claudeVersion = text(init['claude_code_version']) ?? this.claudeVersion
    this.liveCommands = init['commands']
    const sdkModels = parseClaudeModelInfos(init['models'])
    const agents = discoverCustomAgents(init['agents'])
    const settings = parseClaudeSettings(await this.controlRequestSoft('get_settings', {}, SETTINGS_TIMEOUT_MS))
    const allowBypass = this.allowBypassFor(options.env) && settings.permissions?.disableBypassPermissionsMode !== 'disable'
    const allowlist = Array.isArray(settings.availableModels) ? settings.availableModels.filter((entry): entry is string => typeof entry === 'string') : undefined
    const allowed =
      allowlist === undefined
        ? sdkModels
        : applyAvailableModelsAllowlist(sdkModels, allowlist, settings.modelOverrides, settings.deniedModels ?? [], options.env['ANTHROPIC_CUSTOM_MODEL_OPTION'])
    const choice = chooseInitialModel({
      models: allowed,
      sdkModels,
      settingsModel: settings.model,
      envModel: options.env['ANTHROPIC_MODEL'],
      resumed,
      resumedModelHint: tail?.model,
      log: (message) => this.log(message),
    })
    let currentModelId = choice.state.currentModelId
    if (choice.setModel !== undefined) {
      try {
        await this.controlRequest('set_model', { model: choice.setModel })
      } catch (error: unknown) {
        if (!resumed && !choice.switchToListed && !isPreModelSwitchHookBlock(error)) throw error
        this.log(`claude: model switch to "${choice.setModel}" failed or was vetoed; keeping the running model: ${messageOf(error)}`)
        currentModelId = resumed && tail?.model ? matchResumedModel(allowed, tail.model).value : choice.modelBeforeSwitch
      }
    }
    const models: ClaudeModelState = { ...choice.state, currentModelId }
    const { modelInfos, currentModelInfo } = withLiveModelInfo(allowed, sdkModels, currentModelId)

    // Initial permission mode: the resumed transcript's, else the trusted settings default; Auto needs model support.
    const wanted = resolveInitialPermissionMode(
      { resumed: tail?.permissionMode, defaultMode: settings.permissions?.defaultMode },
      allowBypass,
      (message) => this.log(message),
    )
    const availableModes = buildClaudeAvailableModes(allowBypass)
    let mode: ClaudePermissionMode = wanted
    if (wanted === 'auto' && currentModelInfo !== undefined && currentModelInfo.supportsAutoMode !== true) {
      this.log(`permissions.defaultMode "auto" is not available for model "${currentModelId}"; falling back to "${AUTO_MODE_FALLBACK}".`)
      mode = AUTO_MODE_FALLBACK
    } else if (!availableModes.some((entry) => entry.id === wanted)) {
      this.log(`permissions.defaultMode "${wanted}" is not available in this session; falling back to "default".`)
      mode = 'default'
    }
    if (mode !== spawnMode) {
      try {
        await this.controlRequest('set_permission_mode', { mode })
      } catch (error: unknown) {
        this.log(`claude: failed to sync the initial permission mode: ${messageOf(error)}`)
      }
    }

    const fastEnabled = init['fast_mode_state'] !== undefined && fastModeStateEnabled(init['fast_mode_state'])
    const state: SessionState = {
      modes: { currentModeId: mode, availableModes },
      models,
      modelInfos,
      sdkModels,
      agents,
      currentAgent: DEFAULT_AGENT_ID,
      fastEnabled,
      fastReason: fastEnabled ? undefined : normalizeFastModeDisabledReason(init['fast_mode_disabled_reason']),
      effortSeed: settingsEffortForModel(settings, currentModelInfo),
      effortPinned: undefined,
      settings,
      allowBypass,
      prePlanMode: undefined,
      autoFallbackWarned: false,
      options: [],
    }
    this.state = state
    this.rebuildOptions()
    this.mapper?.seedContextWindow(currentModelId, currentModelInfo?.resolvedModel, currentModelInfo?.displayName, currentModelInfo?.description)
    this.applyLearnedWindow(currentModelInfo, currentModelId)
  }

  private applyLearnedWindow(info: ClaudeModelInfo | undefined, modelId: string): void {
    const learned = learnedContextWindows.get(info?.resolvedModel ?? modelId)
    if (learned !== undefined) this.mapper?.setContextWindow(learned, true)
  }

  /** The CLI's own answer for the window of the running model; refines the text heuristic. */
  private async refreshContextWindow(): Promise<void> {
    const mapper = this.mapper
    const modelId = this.state?.models.currentModelId
    const usage = await this.controlRequestSoft('get_context_usage', { detail: 'summary' }, 5_000)
    const raw = num(usage?.['rawMaxTokens'])
    if (raw !== undefined && raw > 0 && mapper === this.mapper && modelId === this.state?.models.currentModelId) mapper?.setContextWindow(raw, true)
  }

  private currentModelInfo(state: SessionState): ClaudeModelInfo | undefined {
    return state.modelInfos.find((model) => model.value === state.models.currentModelId)
  }

  private isAutoUnavailable(state: SessionState, modelId: string = state.models.currentModelId): boolean {
    const info = state.modelInfos.find((model) => model.value === modelId)
    return info !== undefined && info.supportsAutoMode !== true
  }

  private rebuildOptions(): void {
    const state = this.requireState()
    state.options = buildClaudeConfigOptions({
      modes: state.modes,
      models: state.models,
      modelInfos: state.modelInfos,
      effortLevel: state.effortSeed,
      agents: state.agents,
      currentAgent: state.currentAgent,
      fast: { supported: this.currentModelInfo(state)?.supportsFastMode ?? false, enabled: state.fastEnabled, disabledReason: state.fastReason },
    })
  }

  controls(): NativeControls {
    const state = this.requireState()
    return { configOptions: state.options, modes: state.modes, imageInput: true }
  }

  // -- vendor-driven control changes -----------------------------------------------

  private announceControls(): void {
    if (this.state !== undefined) this.emit({ kind: 'controls', controls: this.controls() })
  }

  /** The CLI changed the permission mode itself (plan exit, shift-tab, …); mirror it. */
  private syncPermissionMode(raw: unknown): void {
    const state = this.state
    if (state === undefined || typeof raw !== 'string' || raw === state.modes.currentModeId) return
    if (!state.modes.availableModes.some((mode) => mode.id === raw)) return
    this.applyModeState(raw)
    this.announceControls()
  }

  private syncFastMode(fastState: unknown, reason: unknown): void {
    const state = this.state
    if (state === undefined || fastState === undefined || !state.options.some((option) => option.id === FAST_MODE_CONFIG_ID)) return
    if (fastState === 'cooldown') return
    const enabled = fastState === 'on'
    const nextReason = enabled ? undefined : normalizeFastModeDisabledReason(reason)
    if (enabled === state.fastEnabled && nextReason === state.fastReason) return
    state.fastEnabled = enabled
    state.fastReason = nextReason
    this.rebuildOptions()
    this.announceControls()
  }

  /** The running model changed under us (`/model`, a refusal fallback); follow it. */
  private syncModelFromInit(model: string | undefined): void {
    const state = this.state
    if (state === undefined || model === undefined) return
    const current = this.currentModelInfo(state)
    const canonical = (value: string): string => value.trim().toLowerCase()
    if (current !== undefined && [current.resolvedModel, current.value].some((candidate) => candidate !== undefined && canonical(candidate) === canonical(model))) return
    const resolved = resolveModelPreference(state.modelInfos, model)
    const value = resolved?.value ?? model
    if (value === state.models.currentModelId) return
    this.applyModelState(value)
    this.announceControls()
  }

  // -- caller-driven control changes -----------------------------------------------

  async setConfigOption(configId: string, value: string | boolean, signal?: AbortSignal): Promise<void> {
    const state = this.requireState()
    if (this.closed) throw new NativeTransportError('Claude transport is closed', 'closed')
    if (this.promptSettlement !== undefined) throw new NativeTransportError('Cannot change a setting while a prompt runs', 'busy')
    signal?.throwIfAborted()
    const option = state.options.find((entry) => entry.id === configId)
    if (option === undefined) throw new NativeTransportError(`Unknown config option: ${configId}`, 'invalid-config')
    if (configId === FAST_MODE_CONFIG_ID) {
      await this.applyFastMode(state, resolveFastModeEnabled(value))
      return
    }
    if (typeof value !== 'string') throw new NativeTransportError(`Invalid value for config option ${configId}: ${String(value)}`, 'invalid-config')
    const values = selectValues(option)
    // The option's own current value is always a valid target, even when it has no entry (an out-of-picker live model).
    let resolved = values.includes(value) || (option.type === 'select' && option.currentValue === value) ? value : undefined
    if (resolved === undefined && configId === MODEL_CONFIG_ID) {
      // Human-friendly spellings ("opus", a full model id) resolve onto a picker row.
      const match = resolveModelPreference(state.modelInfos, value)
      resolved = match !== null && values.includes(match.value) ? match.value : undefined
    }
    if (resolved === undefined) throw new NativeTransportError(`Invalid value for config option ${configId}: ${value}`, 'invalid-config')
    switch (configId) {
      case MODE_CONFIG_ID:
        await this.selectMode(state, resolved)
        return
      case MODEL_CONFIG_ID:
        await this.selectModel(state, resolved)
        return
      case EFFORT_CONFIG_ID:
        await this.controlRequest('apply_flag_settings', { settings: effortFlagSettings(resolved, state.settings) })
        state.effortSeed = resolved
        state.effortPinned = resolved === DEFAULT_MODEL_ID ? undefined : resolved
        this.rebuildOptions()
        return
      case AGENT_CONFIG_ID:
        await this.controlRequest('apply_flag_settings', { settings: { agent: resolved === DEFAULT_AGENT_ID ? null : resolved } })
        state.currentAgent = resolved
        this.rebuildOptions()
        return
      default:
        state.options = withCurrentValue(state.options, configId, resolved)
    }
  }

  private async applyFastMode(state: SessionState, enabled: boolean): Promise<void> {
    // The flag goes first so a rejected request leaves the displayed state alone.
    await this.controlRequest('apply_flag_settings', { settings: { fastMode: enabled } })
    state.fastEnabled = enabled
    this.rebuildOptions()
  }

  private applyModeState(mode: string): void {
    const state = this.requireState()
    const previous = state.modes.currentModeId
    if (mode !== 'plan') state.prePlanMode = undefined
    else if (previous !== 'plan') state.prePlanMode = previous
    state.modes = { ...state.modes, currentModeId: mode }
    this.rebuildOptions()
  }

  private async selectMode(state: SessionState, modeId: string): Promise<void> {
    let requested: ClaudePermissionMode
    try {
      requested = parseSelectableMode(modeId)
    } catch {
      throw new NativeTransportError('Invalid Mode', 'invalid-config')
    }
    if (!state.modes.availableModes.some((mode) => mode.id === requested)) {
      throw new NativeTransportError(`Mode ${modeId} is not available in this session`, 'invalid-config')
    }
    const effective: ClaudePermissionMode = requested === 'auto' && this.isAutoUnavailable(state) ? AUTO_MODE_FALLBACK : requested
    await this.controlRequest('set_permission_mode', { mode: effective })
    this.applyModeState(effective)
    if (effective !== requested) this.warnAutoFallback(state)
  }

  private warnAutoFallback(state: SessionState): void {
    if (state.autoFallbackWarned) return
    state.autoFallbackWarned = true
    this.emit(
      updateEvent({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '**Auto mode unavailable:** the selected model does not support Auto mode; using Accept edits instead.' },
      }),
    )
  }

  private async selectModel(state: SessionState, value: string): Promise<void> {
    await this.controlRequest('set_model', { model: value })
    const previousMode = state.modes.currentModeId
    const info = this.applyModelState(value)
    // A mode the new model cannot run (Auto) falls back; the CLI must follow.
    if (previousMode === 'auto' && state.modes.currentModeId !== 'auto') {
      try {
        await this.controlRequest('set_permission_mode', { mode: AUTO_MODE_FALLBACK })
      } catch (error: unknown) {
        this.log(`claude: failed to sync permission mode after model switch: ${messageOf(error)}`)
      }
      this.warnAutoFallback(state)
    }
    // A pinned effort the new model does not support must be cleared from the flag layer too.
    if (state.effortPinned === undefined && state.effortSeed !== undefined && !this.supportsEffort(info, state.effortSeed)) {
      state.effortSeed = settingsEffortForModel(state.settings, info, value)
    }
    void this.refreshContextWindow()
  }

  /** Move the session's bookkeeping onto model `value`; returns the model's catalog row. */
  private applyModelState(value: string): ClaudeModelInfo | undefined {
    const state = this.requireState()
    const info = state.modelInfos.find((model) => model.value === value)
    if (state.models.currentModelId !== value) {
      this.mapper?.seedContextWindow(value, info?.resolvedModel, info?.displayName, info?.description)
      this.applyLearnedWindow(info, value)
    }
    state.models = { ...state.models, currentModelId: value }
    if (state.fastReason === 'model_not_allowed') state.fastReason = undefined
    if (state.modes.currentModeId === 'auto' && info !== undefined && info.supportsAutoMode !== true) {
      state.modes = { ...state.modes, currentModeId: AUTO_MODE_FALLBACK }
    }
    const pinned = state.effortPinned
    const pinnedForNew = pinned !== undefined && this.supportsEffort(info, pinned)
    state.effortSeed = pinnedForNew ? pinned : settingsEffortForModel(state.settings, info, value)
    if (pinned !== undefined && !pinnedForNew) {
      state.effortPinned = undefined
      void this.controlRequestSoft('apply_flag_settings', { settings: effortFlagSettings(undefined, state.settings) })
    }
    this.rebuildOptions()
    return info
  }

  private supportsEffort(info: ClaudeModelInfo | undefined, level: string): boolean {
    return level === DEFAULT_MODEL_ID || (info?.supportsEffort === true && info.supportedEffortLevels?.includes(level) === true)
  }

  // -- turns -----------------------------------------------------------------------

  async prompt(content: readonly NativeContentBlock[], signal: AbortSignal): Promise<NativePromptResult> {
    if (this.closeRequested) throw new NativeTransportError('Claude transport is closed', 'closed')
    if (this.exitError !== undefined) throw this.exitError
    if (this.state === undefined || this.sessionIdValue === undefined) throw new NativeTransportError('Claude transport was not started', 'not_started')
    if (this.promptSettlement !== undefined) throw new NativeTransportError('A Claude prompt is already in progress', 'busy')
    if (signal.aborted) return { stopReason: 'cancelled' }
    if (content.length === 0) throw new NativeTransportError('Claude prompt is empty', 'empty_prompt')

    const uuid = randomUUID()
    const settled = deferred<NativePromptResult>()
    void settled.promise.catch(() => undefined)
    this.promptSettlement = { resolve: settled.resolve, reject: settled.reject }
    this.activeTurnUuid = uuid
    this.interruptRequested = false
    this.interruptInFlight = undefined
    this.refusalExplanation = undefined
    this.exitPlanInterrupted = false

    const shellCommand = shellEscapeCommand(content)
    const onAbort = (): void => {
      // The CLI cannot abort a user shell command; the turn just stops waiting for it.
      if (this.shell === undefined) void this.interrupt()
      else this.cancelShellEscape()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      if (shellCommand === undefined) {
        this.writeFrame(claudeUserMessageFrame({ blocks: content, sessionId: this.sessionIdValue, uuid }))
        this.recordPrompt(uuid, content)
        // From the first message on, the conversation exists on disk and can be resumed.
        unpromptedSessions.delete(this.sessionIdValue)
      } else {
        this.startShellEscape(uuid, shellCommand)
      }
      return await settled.promise
    } catch (error: unknown) {
      this.settlePromptReject(error instanceof Error ? error : new Error(String(error)))
      if (signal.aborted) return { stopReason: 'cancelled' }
      throw error instanceof NativeTransportError ? error : new NativeTransportError(`Claude prompt failed: ${messageOf(error)}`, 'prompt_failed', this.stderrTail())
    } finally {
      signal.removeEventListener('abort', onAbort)
      if (this.activeTurnUuid === uuid) this.activeTurnUuid = undefined
    }
  }

  /**
   * Inject a message into the running turn (`priority:"next"`: the CLI folds it in at the next
   * tool boundary). `promptRequired` means no turn can take it and the caller must use `prompt()`.
   */
  async steer(content: readonly NativeContentBlock[], signal?: AbortSignal): Promise<'injected' | 'promptRequired'> {
    if (this.closed || this.exitError !== undefined || this.sessionIdValue === undefined) return 'promptRequired'
    if (signal?.aborted === true || content.length === 0) return 'promptRequired'
    // While a shell command holds the prompt slot no model turn runs, so there is nothing to fold a message into. Text that merely
    // starts with "!" or "/" is steered like any other: the host turns a registered command into a command before it gets here.
    if (this.shell !== undefined) return 'promptRequired'
    if (this.promptSettlement === undefined || this.activeTurnUuid === undefined || this.interruptRequested) return 'promptRequired'
    const frame = claudeUserMessageFrame({ blocks: content, sessionId: this.sessionIdValue, priority: 'next' })
    const uuid = text(frame['uuid'])
    try {
      if (uuid !== undefined) this.injectedTurnUuids.add(uuid)
      this.writeFrame(frame)
      this.log(`claude: injected steer ${uuid ?? '(no uuid)'} into the running turn`)
      return 'injected'
    } catch (error: unknown) {
      if (uuid !== undefined) this.injectedTurnUuids.delete(uuid)
      this.log(`claude: steer failed: ${messageOf(error)}`)
      return 'promptRequired'
    }
  }

  // -- user shell escape (`!cmd`) ------------------------------------------------------

  /**
   * Remember a prompt this process sent: its message uuid is what `rewind_files` needs, before the transcript holds it. The label is
   * the user's own text, which the host sends after the context it generates (the transcript gets the same blocks, so a restart agrees).
   */
  private recordPrompt(uuid: string, content: readonly NativeContentBlock[]): void {
    this.sentPrompts = [...this.sentPrompts, { uuid, label: checkpointLabel(content), at: new Date().toISOString() }].slice(-MAX_SENT_PROMPTS)
  }

  /**
   * Run `command` as the user's own shell command: no model, no approval. The CLI reports it with two replay frames (the echo, then
   * stdout, stderr and the exit code) and ends it with `command_lifecycle`; it sends no `result`. It is shown as one Bash tool call.
   */
  private startShellEscape(uuid: string, command: string): void {
    if (command === '') {
      // Nothing to run: say so instead of spending a model turn on a bare "!".
      this.emit(updateEvent({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Type a shell command after `!`, for example `!ls`.' } }))
      this.finishTurn({ stopReason: 'end_turn' })
      return
    }
    const toolCallId = `shell-${uuid}`
    this.shell = { uuid, toolCallId, stdout: '', stderr: '', exitCode: undefined }
    this.emitAll(this.mapper?.ensureToolCall({ id: toolCallId, name: 'Bash', input: { command } }) ?? [])
    this.writeFrame({ type: 'bash_command', uuid, command, cwd: this.requireOptions().cwd })
  }

  /** Keep the output a running `!cmd` reports; true when the frame was a replay frame of a shell command. */
  private captureBashReplay(frame: Json): boolean {
    const replay = parseBashReplay(frame)
    if (replay === undefined) return false
    if (replay.kind === 'output' && this.shell !== undefined) {
      this.shell.stdout = replay.stdout
      this.shell.stderr = replay.stderr
      this.shell.exitCode = replay.exitCode
    }
    return true
  }

  private handleCommandLifecycle(frame: Json): void {
    const shell = this.shell
    if (shell === undefined || text(frame['command_uuid']) !== shell.uuid) return
    const state = text(frame['state'])
    if (state === 'completed') this.finishShellEscape(shell, undefined)
    else if (state === 'cancelled' || state === 'discarded' || state === 'refused') this.finishShellEscape(shell, `Claude Code did not run the command (${state}).`)
  }

  private finishShellEscape(shell: ShellEscape, refusal: string | undefined): void {
    this.shell = undefined
    const output = [shell.stdout, shell.stderr].filter((part) => part !== '').join('\n')
    const failed = refusal !== undefined || (shell.exitCode !== undefined && shell.exitCode !== 0)
    // The shapes of the Bash tool's own result, so the call renders like a command the model ran.
    const content = refusal ?? (failed ? `Exit code ${shell.exitCode ?? 1}\n${output}`.trimEnd() : output)
    this.emitAll(
      this.mapper?.map({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: shell.toolCallId, content, ...(failed ? { is_error: true } : {}) }] },
        tool_use_result: { stdout: shell.stdout, stderr: shell.stderr, interrupted: false },
        parent_tool_use_id: null,
        uuid: shell.uuid,
      }) ?? [],
    )
    this.emitAll(this.mapper?.settleTurn(false) ?? [])
    this.finishTurn({ stopReason: 'end_turn' })
  }

  /** Stop waiting for a `!cmd`: the CLI cannot abort it, so it runs to its end and its output is dropped. */
  private cancelShellEscape(): void {
    this.shell = undefined
    this.log('claude: stopped waiting for a shell command; the CLI keeps running it')
    this.emitAll(this.mapper?.settleTurn(true) ?? [])
    this.finishTurn({ stopReason: 'cancelled' })
  }

  /** Stop the running turn. Resolves once the interrupt was acknowledged; the turn settles on its `result`. */
  async interrupt(): Promise<void> {
    if (this.closed || this.activeTurnUuid === undefined || this.promptSettlement === undefined) return
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
    clearTimeout(this.interruptFallbackTimer)
    const timer = setTimeout(() => {
      this.interruptFallbackTimer = undefined
      if (this.promptSettlement === undefined) return
      this.log('claude: interrupted turn produced no result; settling as cancelled')
      this.emitAll(this.mapper?.settleTurn(true) ?? [])
      this.finishTurn({ stopReason: 'cancelled' })
    }, INTERRUPT_SETTLE_FALLBACK_MS)
    timer.unref()
    this.interruptFallbackTimer = timer
  }

  private async interruptInternal(): Promise<void> {
    this.interruptRequested = true
    for (const controller of this.permissionControllers.values()) controller.abort()
    // Snapshot before the round trip: the interrupted turn's own `result` can be processed while we wait.
    const injectedBeforeInterrupt = new Set(this.injectedTurnUuids)
    const cancelQueued = this.capabilities.has('interrupt_cancel_queued_v1')
    const receipt = await this.controlRequestSoft('interrupt', cancelQueued ? { cancel_queued: true } : {}, INTERRUPT_TIMEOUT_MS)
    const uuids = (key: string): string[] => (Array.isArray(receipt?.[key]) ? receipt[key].filter((entry): entry is string => typeof entry === 'string') : [])
    if (cancelQueued) {
      // The receipt already lists the withdrawn messages.
      for (const uuid of uuids('cancelled')) this.injectedTurnUuids.delete(uuid)
      return
    }
    // Older CLIs leave injected messages queued: withdraw each one we sent, or a stopped turn is silently resumed.
    for (const uuid of uuids('still_queued')) {
      if (!injectedBeforeInterrupt.has(uuid)) continue
      this.injectedTurnUuids.delete(uuid)
      try {
        this.writeFrame({ type: 'control_request', request_id: `dsh-cancel-${uuid}`, request: { subtype: 'cancel_async_message', message_uuid: uuid } })
        this.log(`claude: withdrew queued steer ${uuid} after interrupt`)
      } catch (error: unknown) {
        this.log(`claude: failed to withdraw queued steer ${uuid}: ${messageOf(error)}`)
      }
    }
  }

  contextUsage(): NativeContextUsage | undefined {
    return this.mapper?.contextUsage
  }

  // -- commands and side questions ---------------------------------------------------------
  //
  // Neither runs through `prompt()`: they never claim the prompt slot, never reach the frame mapper, and may run while a turn does.

  /** Commands answer from the live process only. */
  private requireLive(): void {
    if (this.closeRequested) throw new NativeTransportError('Claude transport is closed', 'closed')
    if (this.exitError !== undefined) throw this.exitError
    if (this.state === undefined || this.sessionIdValue === undefined) throw new NativeTransportError('Claude transport was not started', 'not_started')
  }

  /** The CLI refusing a request, not answering it, or the user cancelling it is the command's result; a lost process stays an exception. */
  private commandFailure(what: string, error: unknown): NativeCommandResult {
    if (error instanceof NativeTransportError) {
      if (error.code === 'control-cancelled') return commandError(`${what} was cancelled.`)
      if (error.code === 'control-error' || error.code === 'control-timeout') return commandError(`${what} failed: ${error.message}`)
    }
    throw error
  }

  private commandRequest(subtype: string, extra: Json, signal: AbortSignal, idleMs: number = COMMAND_TIMEOUT_MS): Promise<Json> {
    return this.cancellableRequest(subtype, extra, { signal, idleMs, withdraw: false })
  }

  /**
   * `/btw`: the CLI answers from a fork of the live conversation, with no tools and nothing written to the transcript, while a turn
   * may be running. Its earlier answers are not kept by the CLI here, so they are sent back as `history` (cleared with the conversation).
   */
  async sideQuestion(question: string, signal: AbortSignal): Promise<NativeCommandResult> {
    this.requireLive()
    const asked = question.trim()
    if (asked === '') return commandError('Usage: /btw <question>')
    const history = this.sideHistory.payload()
    let reply: Json
    try {
      reply = await this.cancellableRequest(
        'side_question',
        { question: asked, ...(history.length === 0 ? {} : { history }) },
        { signal, idleMs: SIDE_QUESTION_TIMEOUT_MS, withdraw: true },
      )
    } catch (error: unknown) {
      return this.commandFailure('The side question', error)
    }
    const answer = sideAnswer(asked, reply)
    if (answer.exchange !== undefined) this.sideHistory.push(answer.exchange)
    return answer.result
  }

  async runCommand(name: string, args: string, signal: AbortSignal): Promise<NativeCommandResult> {
    this.requireLive()
    const command = resolveClaudeImmediateCommand(name)
    if (command === undefined) return commandError(`/${name.replace(/^\//, '')} is not a Claude Code command DSH answers without a turn.`)
    try {
      const result = await this.immediateCommand(command, args.trim(), signal)
      return { kind: result.kind, text: capMarkdown(result.text) }
    } catch (error: unknown) {
      return this.commandFailure(`/${command}`, error)
    }
  }

  private async immediateCommand(command: string, args: string, signal: AbortSignal): Promise<NativeCommandResult> {
    switch (command) {
      case 'status':
        return commandSuccess(renderStatus(await this.commandRequest('get_status', {}, signal)))
      case 'context':
        return commandSuccess(renderContext(await this.commandRequest('get_context_usage', { detail: 'full' }, signal)))
      case 'usage':
        return await this.usageCommand(signal)
      case 'memory':
        return commandSuccess(renderMemory(await this.commandRequest('get_memory_dialog', {}, signal)))
      case 'skills':
        return commandSuccess(renderSkills(await this.commandRequest('get_skills_dialog', {}, signal)))
      case 'hooks':
        return commandSuccess(renderHooks(await this.commandRequest('get_hooks_listing', {}, signal)))
      case 'permissions':
        return commandSuccess(renderPermissions(await this.commandRequest('list_permission_rules', {}, signal)))
      case 'diff':
        return commandSuccess(renderDiff(await this.commandRequest('get_workspace_diff', {}, signal)))
      case 'mcp':
        return await this.mcpCommand(args, signal)
      case 'tasks':
        return await this.tasksCommand(args, signal)
      case 'rewind':
        return await this.rewindCommand(args, signal)
      case 'reload-skills': {
        const reply = await this.commandRequest('reload_skills', {}, signal)
        return commandSuccess(`Reloaded skills: ${Array.isArray(reply['skills']) ? reply['skills'].length : 0} available.`)
      }
      case 'reload-plugins':
        return await this.reloadPluginsCommand(signal)
      default:
        return commandError(`/${command} has no handler in this transport.`)
    }
  }

  /** `/usage`: the session totals the CLI prints for `/cost`, and the plan windows when the account has any. Either alone is enough. */
  private async usageCommand(signal: AbortSignal): Promise<NativeCommandResult> {
    const [cost, usage] = await Promise.allSettled([
      this.commandRequest('get_session_cost', {}, signal),
      this.commandRequest('get_usage', { skip_behaviors: true }, signal),
    ])
    if (cost.status === 'rejected' && usage.status === 'rejected') throw cost.reason
    return commandSuccess(renderUsage(cost.status === 'fulfilled' ? cost.value : undefined, usage.status === 'fulfilled' ? usage.value : undefined))
  }

  /** The reply of `reload_plugins` lists every command again, exactly like `commands_changed`. */
  private async reloadPluginsCommand(signal: AbortSignal): Promise<NativeCommandResult> {
    const reply = await this.commandRequest('reload_plugins', {}, signal)
    this.setLiveCommands(reply['commands'])
    const size = (key: string): number => (Array.isArray(reply[key]) ? reply[key].length : 0)
    const errors = num(reply['error_count']) ?? 0
    return commandSuccess(`Reloaded: ${size('plugins')} plugins · ${size('commands')} commands · ${size('agents')} agents${errors > 0 ? ` · ${errors} errors` : ''}.`)
  }

  private async mcpCommand(args: string, signal: AbortSignal): Promise<NativeCommandResult> {
    const request = parseMcpArgs(args)
    if (request.action === 'usage') return commandError(`${request.problem}\n\nUsage: \`/mcp [reconnect|enable|disable [<server>|all]]\``)
    const servers = async (): Promise<Json[]> => {
      const reply = await this.commandRequest('mcp_status', {}, signal)
      return Array.isArray(reply['mcpServers']) ? reply['mcpServers'].filter(isRecord) : []
    }
    if (request.action === 'status') return commandSuccess(renderMcp(await servers()))
    const names = (await servers()).flatMap((server) => (typeof server['name'] === 'string' ? [server['name']] : []))
    const targets = request.target === 'all' && !names.includes('all') ? names : [request.target]
    if (targets.length === 0) return commandError('No MCP servers are configured.')
    const outcomes = await Promise.allSettled(
      targets.map((serverName) =>
        request.action === 'reconnect'
          ? this.commandRequest('mcp_reconnect', { serverName }, signal, MCP_COMMAND_TIMEOUT_MS)
          : this.commandRequest('mcp_toggle', { serverName, enabled: request.action === 'enable' }, signal, MCP_COMMAND_TIMEOUT_MS),
      ),
    )
    const done = { reconnect: 'reconnected', enable: 'enabled', disable: 'disabled' }[request.action]
    let failures = 0
    const lines = outcomes.map((outcome, index) => {
      const server = `\`${targets[index] ?? ''}\``
      if (outcome.status === 'fulfilled') return `- ✓ ${server} ${done}`
      failures += 1
      return `- ✗ ${this.commandFailure(server, outcome.reason).text}`
    })
    // What the servers look like now; the actions above already succeeded or failed on their own.
    const now = await servers().then(renderMcp, () => undefined)
    return { kind: failures === targets.length ? 'error' : 'success', text: [...lines, ...(now === undefined ? [] : ['', now])].join('\n') }
  }

  private async tasksCommand(args: string, signal: AbortSignal): Promise<NativeCommandResult> {
    const request = parseTasksArgs(args)
    if (request.action === 'usage') return commandError(`${request.problem}\n\nUsage: \`/tasks [stop <id> | output <id>]\``)
    if (request.action === 'list') return commandSuccess(renderTasks(this.tasks.list()))
    const found = this.tasks.find(request.reference)
    if ('error' in found) return commandError(found.error)
    const { task } = found
    if (request.action === 'output') return commandSuccess(renderTaskOutput(task, await this.commandRequest('get_task_output', { task_id: task.id }, signal)))
    // `stop_task` answers success for any id, so only a task this session knows to be running is stopped.
    if (!isTaskLive(task)) return commandError(`Task \`${task.id}\` is already ${task.status}.`)
    await this.commandRequest('stop_task', { task_id: task.id }, signal)
    // The frames that end the task usually arrive before the answer.
    const label = task.description === '' ? '' : ` (${task.description})`
    return commandSuccess(isTaskLive(task) ? `Asked Claude Code to stop task \`${task.id}\`${label}. /tasks shows when it has ended.` : `Stopped task \`${task.id}\`${label}.`)
  }

  /**
   * The points `/rewind` offers: the user messages of the conversation the transcript holds (the file outlives the process and records a
   * rewind), then this process's own messages the transcript does not hold yet, without the ones a rewind of this process cut off.
   */
  private async checkpoints(): Promise<ClaudeCheckpoint[]> {
    const sessionId = this.sessionIdValue
    const { checkpoints, recorded } =
      sessionId === undefined ? { checkpoints: [], recorded: new Set<string>() } : await readClaudeCheckpoints(sessionId, claudeConfigDir(this.requireOptions().env))
    return [...checkpoints, ...this.sentPrompts.filter((prompt) => !recorded.has(prompt.uuid))].filter((row) => !this.forgotten.has(row.uuid))
  }

  /**
   * `/rewind` for the files, the conversation or both (`code`, `chat`, and both by default). Listing and previews change nothing and run any
   * time; `confirm` waits for the turn to end. The files go first (`rewind_files`, which restores what Claude changed through its file
   * tools), then the conversation is cut back in place (`rewind_conversation`): the session keeps its id, Claude Code forgets the messages
   * from the target on, and DSH's log, which still shows them, is told with `session_changed`.
   */
  private async rewindCommand(args: string, signal: AbortSignal): Promise<NativeCommandResult> {
    const request = parseRewindArgs(args)
    if (request.action === 'usage') return commandError(`${request.problem}\n\nUsage: \`/rewind [<n> [code|chat] [confirm]]\``)
    if (request.action === 'apply' && this.promptSettlement !== undefined) return commandError(REWIND_BUSY)
    const sessionId = this.sessionIdValue
    if (sessionId === undefined) throw new NativeTransportError('Claude transport was not started', 'not_started')
    const rows = await this.checkpoints()
    if (request.action === 'list') return commandSuccess(renderCheckpoints(rows))
    const found = findCheckpoint(rows, request.reference)
    if ('error' in found) return commandError(found.error)
    const { checkpoint, position } = found
    const point = { checkpoint, position, total: rows.length, mode: request.mode }
    // Claude Code's dry run says what a restore would change, or why it cannot restore (a local command has no checkpoint, say).
    const plan = request.mode === 'chat' ? undefined : rewindFilePlan(await this.commandRequest('rewind_files', { user_message_id: checkpoint.uuid, dry_run: true }, signal))
    if (request.action === 'preview') return commandSuccess(renderRewindPreview({ ...point, plan }))

    let restored: RewindFilePlan | undefined = plan
    let skippedLinks = 0
    let filesRestored = false
    if (plan?.restorable === true && plan.files.length > 0) {
      try {
        const applied = await this.commandRequest('rewind_files', { user_message_id: checkpoint.uuid, dry_run: false }, signal)
        // A refusal arrives as an error answer; `canRewind: false` is the same refusal in the other shape.
        if (applied['canRewind'] !== true) throw new NativeTransportError(text(applied['error']) ?? 'Claude Code refused', 'control-error')
        skippedLinks = num(applied['skippedLinks']) ?? 0
        filesRestored = true
      } catch (error: unknown) {
        return commandError(`${sentence(this.commandFailure('The restore of the files', error).text)} The conversation was not rolled back.`)
      }
    } else if (plan?.restorable === false && request.mode === 'code') {
      return commandError(`The files cannot be restored to before message ${position}: ${plan.reason}.`)
    }
    if (request.mode === 'code') return commandSuccess(renderRewindResult({ ...point, restored, skippedLinks, rolledBack: false }))

    // From here on the files, if any, are restored: say so when the conversation cannot follow.
    const filesNote = filesRestored ? 'The files were restored. ' : ''
    if (this.promptSettlement !== undefined) return commandError(`${filesNote}A turn started meanwhile, so the conversation was not rolled back. ${REWIND_BUSY}`)
    const newest = rows[rows.length - 1]?.uuid ?? checkpoint.uuid
    let reply: Json
    try {
      // The newest message is what this list was made from: Claude Code refuses a cut when it holds newer ones the list never showed.
      reply = await this.commandRequest('rewind_conversation', { target_message_uuid: checkpoint.uuid, last_seen_user_message_uuid: newest }, signal)
    } catch (error: unknown) {
      return commandError(`${filesNote}${sentence(this.commandFailure('The conversation rollback', error).text)}`)
    }
    if (reply['rewound'] !== true) return commandError(`${filesNote}${sentence(`Claude Code did not roll the conversation back: ${rewindRefusal(reply)}`)}`)

    // The conversation now ends before the target: the messages from there on are forgotten, and so is what was asked about them.
    for (const row of rows.slice(position - 1)) this.forgotten.add(row.uuid)
    this.sideHistory.clear()
    this.emit({ kind: 'session_changed', sessionId, reason: 'rewind' })
    await this.reportOccupancy()
    return commandSuccess(renderRewindResult({ ...point, restored, skippedLinks, rolledBack: true }))
  }

  /** The conversation just got shorter: report what the context window holds now, as far as Claude Code can tell. */
  private async reportOccupancy(): Promise<void> {
    const usage = await this.controlRequestSoft('get_context_usage', { detail: 'summary' }, 5_000)
    const used = num(usage?.['totalTokens'])
    if (used !== undefined) this.emitAll(this.mapper?.restartContext(used) ?? [])
  }

  // -- results -----------------------------------------------------------------------

  /** Token and cost accounting of one `result`: the increase over the previous reading. */
  private accountUsage(frame: Json): ModelUsageRow {
    const reading = normalizeModelUsage(frame['modelUsage'])
    const totalCost = num(frame['total_cost_usd'])
    let delta: ModelUsageRow
    if (this.usageBaseline !== undefined) {
      delta = modelUsageIncrement(reading, this.usageBaseline)
      if (totalCost !== undefined && this.baselineCost !== undefined) {
        delta = { ...delta, costUsd: totalCost >= this.baselineCost ? totalCost - this.baselineCost : totalCost }
      }
    } else {
      // A resumed conversation without a saved baseline: only the main-loop usage of this turn is attributable.
      const usage = isRecord(frame['usage']) ? frame['usage'] : {}
      const details = isRecord(usage['output_tokens_details']) ? usage['output_tokens_details'] : {}
      delta = {
        input: num(usage['input_tokens']) ?? 0,
        output: num(usage['output_tokens']) ?? 0,
        cacheRead: num(usage['cache_read_input_tokens']) ?? 0,
        cacheWrite: num(usage['cache_creation_input_tokens']) ?? 0,
        thinking: num(details['thinking_tokens']) ?? 0,
        costUsd: 0,
      }
    }
    this.usageBaseline = reading
    if (totalCost !== undefined) this.baselineCost = totalCost
    return delta
  }

  private turnUsage(delta: ModelUsageRow): NativeTurnUsage {
    return {
      inputTokens: delta.input,
      outputTokens: delta.output,
      cachedReadTokens: delta.cacheRead,
      cachedWriteTokens: delta.cacheWrite,
      ...(delta.thinking > 0 ? { thoughtTokens: delta.thinking } : {}),
      ...(delta.costUsd > 0 ? { costUsd: Number(delta.costUsd.toFixed(6)) } : {}),
    }
  }

  private handleResult(frame: Json): void {
    this.adoptResetSession(text(frame['session_id']))
    const mapper = this.mapper
    if (this.state === undefined) {
      // The CLI's verdict on a launch that never completed its handshake (an unknown resume id).
      const errors = Array.isArray(frame['errors']) ? frame['errors'].filter((entry): entry is string => typeof entry === 'string') : []
      this.startupResultErrors += `${errors.join('\n')}\n`
    }
    if (mapper === undefined || this.state === undefined) return
    const delta = this.accountUsage(frame)
    this.syncFastMode(frame['fast_mode_state'], frame['fast_mode_disabled_reason'])
    const modelUsage = isRecord(frame['modelUsage']) ? frame['modelUsage'] : {}
    this.emitAll(mapper.resultUsage(frame))
    for (const key of Object.keys(modelUsage)) {
      const usage = modelUsage[key]
      const window = isRecord(usage) ? num(usage['contextWindow']) : undefined
      if (window !== undefined && window > 0) learnedContextWindows.set(key, window)
    }
    // A model `result` while a shell command holds the prompt slot comes from a turn the CLI started on its own.
    const settlement = this.shell === undefined ? this.promptSettlement : undefined
    if (settlement === undefined) {
      // Work the CLI started on its own (a background task finishing): real spend, charged to the next turn.
      this.carry = {
        input: this.carry.input + delta.input,
        output: this.carry.output + delta.output,
        cacheRead: this.carry.cacheRead + delta.cacheRead,
        cacheWrite: this.carry.cacheWrite + delta.cacheWrite,
        thinking: this.carry.thinking + delta.thinking,
        costUsd: this.carry.costUsd + delta.costUsd,
      }
      this.log('claude: result frame without an active prompt')
      return
    }
    const turn: ModelUsageRow = {
      input: delta.input + this.carry.input,
      output: delta.output + this.carry.output,
      cacheRead: delta.cacheRead + this.carry.cacheRead,
      cacheWrite: delta.cacheWrite + this.carry.cacheWrite,
      thinking: delta.thinking + this.carry.thinking,
      costUsd: delta.costUsd + this.carry.costUsd,
    }
    this.carry = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0, costUsd: 0 }
    const interrupted = this.interruptRequested
    // "No, keep planning" ends the turn with a CLI diagnostic; that is a cancel, not a failure.
    const planStop = this.exitPlanInterrupted && frame['is_error'] === true && /\[ede_diagnostic\]/.test(JSON.stringify(frame['errors'] ?? frame['result'] ?? ''))
    this.exitPlanInterrupted = false
    const outcome = interrupted || planStop ? claudeTurnOutcome(frame, true) : claudeTurnOutcome(frame, false)
    this.emitAll(mapper.settleTurn(interrupted || planStop))
    if ('error' in outcome) {
      this.log(`claude: turn failed: ${truncate(outcome.error, DETAIL_LIMIT)}`)
      this.settlePromptReject(new NativeTransportError(truncate(outcome.error, DETAIL_LIMIT), 'prompt_failed', this.stderrTail()))
      return
    }
    if (outcome.stopReason === 'refusal' && this.refusalExplanation) {
      this.emit(updateEvent({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: this.refusalExplanation } }))
    }
    this.finishTurn({ stopReason: outcome.stopReason, usage: this.turnUsage(turn) })
  }

  private clearTurnState(): void {
    clearTimeout(this.interruptFallbackTimer)
    this.interruptFallbackTimer = undefined
    this.promptSettlement = undefined
    this.shell = undefined
    this.activeTurnUuid = undefined
    this.interruptRequested = false
    this.interruptInFlight = undefined
    this.injectedTurnUuids.clear()
  }

  private finishTurn(result: NativePromptResult): void {
    const settlement = this.promptSettlement
    this.clearTurnState()
    settlement?.resolve(result)
  }

  private settlePromptReject(error: Error): void {
    const settlement = this.promptSettlement
    this.clearTurnState()
    settlement?.reject(error)
  }

  // -- shutdown ------------------------------------------------------------------------

  close(): Promise<void> {
    this.closePromise ??= this.closeInternal()
    return this.closePromise
  }

  private async closeInternal(): Promise<void> {
    this.closeRequested = true
    this.settlePromptReject(new NativeTransportError('Claude transport closed', 'closed'))
    this.rejectPendingControls(new NativeTransportError('Claude transport closed', 'closed'))
    const proc = this.proc
    if (proc !== undefined) {
      const exited = proc.exited.then(
        () => true,
        () => true,
      )
      // A graceful end is stdin EOF; a process that does not leave is terminated by the host.
      try {
        proc.stdin.end()
      } catch {
        // The pipe may already be gone.
      }
      if (!(await withTimeout(exited, CLOSE_STDIN_GRACE_MS, false))) {
        this.log('claude: CLI did not exit after stdin closed; terminating')
        proc.terminate()
        await withTimeout(exited, CLOSE_TERMINATE_GRACE_MS, false)
      }
    }
    this.lines?.close()
    this.lines = undefined
    this.proc = undefined
  }
}

export function createClaudeTransport(): NativeTransport {
  return new ClaudeCliTransport()
}
