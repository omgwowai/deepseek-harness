/**
 * Claude Code interactions that are not model turns, as pure functions: the user shell escape (`!cmd`), the background
 * task ledger, file checkpoints (`/rewind`), side-question history, and the Markdown DSH shows for the control
 * requests behind `/status`, `/context`, `/usage`, `/memory`, `/skills`, `/hooks`, `/permissions`, `/diff`, `/mcp` and `/tasks`.
 *
 * Wire shapes are those of Claude Code 2.1.296, read from its control-request schemas and from frames recorded against
 * the real binary (see `claude.ts`). Every renderer tolerates missing fields: the CLI marks several answers experimental.
 */
import { CHECKPOINT_LABEL_LIMIT, checkpointLabel } from './checkpoint-label.ts'
import { isRecord } from './claude-controls.ts'
import { markdownEscape } from './claude-projection.ts'
import type { NativeCommandResult, NativeContentBlock } from './contract.ts'

type Json = Record<string, unknown>

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
const records = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : [])
const count = (value: number): string => value.toLocaleString('en-US')

// ---------------------------------------------------------------------------
// Markdown helpers
// ---------------------------------------------------------------------------

/** One line of `value`: whitespace collapsed, cut to `limit` characters. */
function clip(value: unknown, limit: number): string {
  const raw = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
  const line = raw.replace(/\s+/g, ' ').trim()
  return line.length <= limit ? line : `${line.slice(0, limit - 1).trimEnd()}…`
}

/** One table cell: a single line with pipes escaped, cut to `limit` characters. */
const cell = (value: unknown, limit = 120): string => clip(value, limit).replace(/\|/g, '\\|')

function table(headers: readonly string[], rows: readonly (readonly string[])[], right: readonly number[] = []): string {
  const rule = headers.map((_, index) => (right.includes(index) ? '---:' : '---')).join('|')
  return [`| ${headers.join(' | ')} |`, `|${rule}|`, ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n')
}

/** Inline code that survives backticks inside the value. */
function code(value: string): string {
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length))
  const fence = '`'.repeat(longest + 1)
  return longest > 0 ? `${fence} ${value} ${fence}` : `${fence}${value}${fence}`
}

/** Inline code in a table cell, where a pipe would end the cell. */
const codeCell = (value: string, limit = 80): string => code(clip(value, limit)).replace(/\|/g, '\\|')

function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

/** Local `YYYY-MM-DD HH:MM` of an ISO timestamp; the input unchanged when it is not a date. */
function clock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const two = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}

const BULLET_CONTINUATION = '\n  '

/** Cap a rendered answer: DSH keeps the whole text in the session log. */
export function capMarkdown(value: string, limit = 60_000): string {
  return value.length <= limit ? value : `${value.slice(0, limit).trimEnd()}\n\n…(output cut at ${count(limit)} characters)`
}

// ---------------------------------------------------------------------------
// User shell escape (`!cmd`)
// ---------------------------------------------------------------------------

/** The shell command of a user shell escape: a message that is a single text block starting with `!`; `undefined` for any other message. */
export function shellEscapeCommand(content: readonly NativeContentBlock[]): string | undefined {
  const [block] = content
  if (content.length !== 1 || block?.type !== 'text') return undefined
  const line = block.text.trimStart()
  return line.startsWith('!') ? line.slice(1).trim() : undefined
}

/** One replay frame of a `bash_command`: the echo of the command, or its captured output. */
export type BashReplay =
  | { readonly kind: 'input' }
  | { readonly kind: 'output'; readonly stdout: string; readonly stderr: string; readonly exitCode: number | undefined }

const BASH_OUTPUT = /^<bash-stdout>([\s\S]*?)<\/bash-stdout><bash-stderr>([\s\S]*?)<\/bash-stderr>(?:<bash-exit-code>(-?\d+)<\/bash-exit-code>)?$/

/** The CLI wraps the text in XML tags and escapes `&`, `<` and `>`; `&amp;` goes last so `&amp;lt;` stays `&lt;`. */
function unescapeXml(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, '&')
}

/** Read a `user` replay frame of a `bash_command`; `undefined` when the frame is something else. */
export function parseBashReplay(frame: Json): BashReplay | undefined {
  if (frame['isReplay'] !== true || !isRecord(frame['message'])) return undefined
  const content = frame['message']['content']
  if (typeof content !== 'string') return undefined
  if (content.startsWith('<bash-input>')) return { kind: 'input' }
  const output = BASH_OUTPUT.exec(content)
  if (output === null) return undefined
  const exitCode = output[3] === undefined ? undefined : Number(output[3])
  return { kind: 'output', stdout: unescapeXml(output[1] ?? ''), stderr: unescapeXml(output[2] ?? ''), exitCode }
}

// ---------------------------------------------------------------------------
// Background tasks (`/tasks`)
// ---------------------------------------------------------------------------

export type ClaudeTaskStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'killed' | 'ended'

/** What `/tasks` knows about one background task, from the `task_*` and `background_tasks_changed` frames. */
export interface ClaudeTask {
  readonly id: string
  type: string | undefined
  description: string
  status: ClaudeTaskStatus
  subagentType: string | undefined
  /** `false` while the spawning tool call still blocks on the task. */
  backgrounded: boolean | undefined
  /** Housekeeping the CLI asks consumers to hide. */
  ambient: boolean
  startedAt: number
  endedAt: number | undefined
  toolUses: number | undefined
  tokens: number | undefined
  lastTool: string | undefined
  summary: string | undefined
  error: string | undefined
  outputFile: string | undefined
}

const FINISHED_TASK_STATUSES: Readonly<Record<string, true>> = { completed: true, failed: true, killed: true, ended: true }
const TASK_STATUSES: Readonly<Record<string, ClaudeTaskStatus>> = {
  pending: 'pending',
  running: 'running',
  paused: 'paused',
  completed: 'completed',
  failed: 'failed',
  killed: 'killed',
}
const MAX_TASKS = 200
const FINISHED_TASKS_LISTED = 20

export const isTaskLive = (task: ClaudeTask): boolean => !Object.hasOwn(FINISHED_TASK_STATUSES, task.status)

/**
 * The background tasks of one CLI process. `background_tasks_changed` is the authoritative level (the live set replaces what we
 * hold); the edge frames add what the level lacks: descriptions, usage, the final status and the output file.
 */
export class ClaudeTaskLedger {
  private readonly tasks = new Map<string, ClaudeTask>()

  /** Apply one `system` frame; false when it is not a task frame. */
  apply(frame: Json, now: number = Date.now()): boolean {
    switch (frame['subtype']) {
      case 'task_started': {
        const task = this.upsert(text(frame['task_id']), now)
        if (task === undefined) return true
        task.status = 'running'
        task.startedAt = now
        task.type = text(frame['task_type']) ?? task.type
        task.description = text(frame['description']) ?? task.description
        task.subagentType = text(frame['subagent_type']) ?? task.subagentType
        if (typeof frame['is_backgrounded'] === 'boolean') task.backgrounded = frame['is_backgrounded']
        if (frame['ambient'] === true || frame['skip_transcript'] === true) task.ambient = true
        return true
      }
      case 'task_progress': {
        const task = this.upsert(text(frame['task_id']), now)
        if (task === undefined) return true
        task.description = text(frame['description']) ?? task.description
        task.subagentType = text(frame['subagent_type']) ?? task.subagentType
        task.lastTool = text(frame['last_tool_name']) ?? task.lastTool
        task.summary = text(frame['summary']) ?? task.summary
        if (isRecord(frame['usage'])) {
          task.toolUses = num(frame['usage']['tool_uses']) ?? task.toolUses
          task.tokens = num(frame['usage']['total_tokens']) ?? task.tokens
        }
        return true
      }
      case 'task_updated': {
        const task = this.upsert(text(frame['task_id']), now)
        if (task === undefined) return true
        const patch = isRecord(frame['patch']) ? frame['patch'] : {}
        const status = text(patch['status'])
        if (status !== undefined && Object.hasOwn(TASK_STATUSES, status)) task.status = TASK_STATUSES[status] ?? task.status
        task.description = text(patch['description']) ?? task.description
        task.error = text(patch['error']) ?? task.error
        if (typeof patch['is_backgrounded'] === 'boolean') task.backgrounded = patch['is_backgrounded']
        if (!isTaskLive(task)) task.endedAt = num(patch['end_time']) ?? task.endedAt ?? now
        return true
      }
      case 'task_notification': {
        const task = this.upsert(text(frame['task_id']), now)
        if (task === undefined) return true
        const status = text(frame['status'])
        task.status = status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'killed'
        task.endedAt ??= now
        task.summary = text(frame['summary']) ?? task.summary
        task.outputFile = text(frame['output_file']) ?? task.outputFile
        if (isRecord(frame['usage'])) {
          task.toolUses = num(frame['usage']['tool_uses']) ?? task.toolUses
          task.tokens = num(frame['usage']['total_tokens']) ?? task.tokens
        }
        return true
      }
      case 'background_tasks_changed': {
        const live = new Set<string>()
        for (const entry of records(frame['tasks'])) {
          const task = this.upsert(text(entry['task_id']), now)
          if (task === undefined) continue
          live.add(task.id)
          if (!isTaskLive(task)) task.status = 'running'
          task.backgrounded = true
          task.type = text(entry['task_type']) ?? task.type
          task.description = text(entry['description']) ?? task.description
          task.subagentType = text(entry['subagent_type']) ?? task.subagentType
          task.ambient = entry['ambient'] === true
        }
        // A background task that left the live set ended; its closing edge may have been missed.
        for (const task of this.tasks.values()) {
          if (isTaskLive(task) && task.backgrounded !== false && !live.has(task.id)) {
            task.status = 'ended'
            task.endedAt ??= now
          }
        }
        return true
      }
      default:
        return false
    }
  }

  private upsert(id: string | undefined, now: number): ClaudeTask | undefined {
    if (id === undefined || id === '') return undefined
    let task = this.tasks.get(id)
    if (task === undefined) {
      task = {
        id,
        type: undefined,
        description: '',
        status: 'running',
        subagentType: undefined,
        backgrounded: undefined,
        ambient: false,
        startedAt: now,
        endedAt: undefined,
        toolUses: undefined,
        tokens: undefined,
        lastTool: undefined,
        summary: undefined,
        error: undefined,
        outputFile: undefined,
      }
      this.tasks.set(id, task)
      this.prune()
    }
    return task
  }

  /** Keep the ledger bounded: the oldest finished tasks go first. */
  private prune(): void {
    for (const task of this.tasks.values()) {
      if (this.tasks.size <= MAX_TASKS) return
      if (!isTaskLive(task)) this.tasks.delete(task.id)
    }
  }

  /** Visible tasks: the live ones in start order, then the most recently finished. */
  list(): ClaudeTask[] {
    const visible = [...this.tasks.values()].filter((task) => !task.ambient)
    const live = visible.filter(isTaskLive).sort((a, b) => a.startedAt - b.startedAt)
    const finished = visible
      .filter((task) => !isTaskLive(task))
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
      .slice(0, FINISHED_TASKS_LISTED)
    return [...live, ...finished]
  }

  /** A task by its id or a unique prefix of it. */
  find(reference: string): { readonly task: ClaudeTask } | { readonly error: string } {
    const wanted = reference.trim()
    const exact = this.tasks.get(wanted)
    if (exact !== undefined) return { task: exact }
    const matches = wanted === '' ? [] : [...this.tasks.values()].filter((task) => task.id.startsWith(wanted))
    if (matches.length === 1 && matches[0] !== undefined) return { task: matches[0] }
    return { error: matches.length > 1 ? `Task "${wanted}" is ambiguous: ${matches.map((task) => task.id).join(', ')}.` : `No task with id "${wanted}". /tasks lists them.` }
  }
}

const TASK_KINDS: Readonly<Record<string, string>> = {
  local_bash: 'shell',
  local_agent: 'agent',
  remote_agent: 'remote agent',
  in_process_teammate: 'teammate',
  local_workflow: 'workflow',
  monitor_mcp: 'monitor',
  monitor_ws: 'monitor',
  mcp_task: 'MCP task',
}

export function taskKind(task: ClaudeTask): string {
  const kind = task.type !== undefined && Object.hasOwn(TASK_KINDS, task.type) ? TASK_KINDS[task.type] : (task.type ?? 'task')
  return task.subagentType === undefined ? (kind ?? 'task') : `${kind} (${task.subagentType})`
}

export function renderTasks(tasks: readonly ClaudeTask[], now: number = Date.now()): string {
  if (tasks.length === 0) return 'No background tasks in this session.'
  const live = tasks.filter(isTaskLive).length
  const rows = tasks.map((task) => {
    const elapsed = duration((task.endedAt ?? now) - task.startedAt)
    const activity = [
      elapsed,
      task.toolUses === undefined ? undefined : `${count(task.toolUses)} tool calls`,
      task.tokens === undefined ? undefined : `${count(task.tokens)} tokens`,
      isTaskLive(task) ? task.lastTool : undefined,
      task.error ?? (isTaskLive(task) ? task.summary : undefined),
    ].filter((part): part is string => part !== undefined && part !== '')
    return [codeCell(task.id), cell(taskKind(task), 40), task.status, cell(task.description || task.summary || '', 80), cell(activity.join(' · '), 100)]
  })
  return [
    `**Background tasks** — ${live} running, ${tasks.length - live} finished`,
    '',
    table(['ID', 'Kind', 'Status', 'Description', 'Activity'], rows),
    '',
    'Stop one with `/tasks stop <id>`; read the output of a shell task with `/tasks output <id>`.',
  ].join('\n')
}

/** The answer to `get_task_output`: the tail the CLI keeps (8 KiB) as a console block. */
export function renderTaskOutput(task: ClaudeTask, reply: Json): string {
  const output = text(reply['output']) ?? ''
  const total = num(reply['total_bytes'])
  const head = `**Output of ${code(task.id)}**${task.description ? ` — ${task.description}` : ''}`
  const note = reply['truncated'] === true ? `\n\n_Showing the end of the output${total === undefined ? '' : ` (${count(total)} bytes in total)`}._` : ''
  return output.trim() === '' ? `${head}\n\n_No output yet._` : `${head}\n\n${markdownEscape(output)}${note}`
}

// ---------------------------------------------------------------------------
// Arguments of the immediate commands
// ---------------------------------------------------------------------------

export type McpRequest =
  | { readonly action: 'status' }
  | { readonly action: 'reconnect' | 'enable' | 'disable'; readonly target: string }
  | { readonly action: 'usage'; readonly problem: string }

export function parseMcpArgs(args: string): McpRequest {
  const [, verb = '', target = ''] = /^(\S*)\s*([\s\S]*)$/.exec(args.trim()) ?? []
  const name = verb.toLowerCase()
  if (name === '') return { action: 'status' }
  if (name !== 'reconnect' && name !== 'enable' && name !== 'disable') return { action: 'usage', problem: `Unknown argument "${verb}".` }
  return target.trim() === '' ? { action: 'usage', problem: `/mcp ${name} needs a server name, or "all".` } : { action: name, target: target.trim() }
}

export type TasksRequest =
  | { readonly action: 'list' }
  | { readonly action: 'stop' | 'output'; readonly reference: string }
  | { readonly action: 'usage'; readonly problem: string }

export function parseTasksArgs(args: string): TasksRequest {
  const [, verb = '', reference = ''] = /^(\S*)\s*([\s\S]*)$/.exec(args.trim()) ?? []
  const name = verb.toLowerCase()
  if (name === '' || name === 'list') return { action: 'list' }
  if (name !== 'stop' && name !== 'output') return { action: 'usage', problem: `Unknown argument "${verb}".` }
  return reference.trim() === '' ? { action: 'usage', problem: `/tasks ${name} needs a task id.` } : { action: name, reference: reference.trim() }
}

/** What a `/rewind` rolls back: the files and the conversation (the default), the files only, or the conversation only. */
export type RewindMode = 'both' | 'code' | 'chat'

export type RewindRequest =
  | { readonly action: 'list' }
  | { readonly action: 'preview' | 'apply'; readonly reference: string; readonly mode: RewindMode }
  | { readonly action: 'usage'; readonly problem: string }

const REWIND_USAGE_ORDER = 'Say which message first: /rewind <n> [code|chat] [confirm].'

/** `/rewind`, `/rewind <n> [code|chat]` (a preview) and `/rewind <n> [code|chat] confirm` (does it). */
export function parseRewindArgs(args: string): RewindRequest {
  const [reference, ...options] = args.trim().split(/\s+/).filter((word) => word !== '')
  if (reference === undefined) return { action: 'list' }
  if (['confirm', 'code', 'chat'].includes(reference.toLowerCase())) return { action: 'usage', problem: REWIND_USAGE_ORDER }
  let mode: RewindMode = 'both'
  let confirm = false
  for (const word of options.map((option) => option.toLowerCase())) {
    if (word === 'confirm') confirm = true
    else if (word === 'code' || word === 'chat') {
      if (mode !== 'both' && mode !== word) return { action: 'usage', problem: 'Choose `code` or `chat`, or neither to roll back both.' }
      mode = word
    } else return { action: 'usage', problem: `Unexpected "${word}".` }
  }
  return { action: confirm ? 'apply' : 'preview', reference, mode }
}

// ---------------------------------------------------------------------------
// Rewind points (`/rewind`)
// ---------------------------------------------------------------------------

/** A user message of the current conversation: the point `/rewind` can go back to (just before it). */
export interface ClaudeCheckpoint {
  readonly uuid: string
  /** The message as the user wrote it, one short line. */
  readonly label: string
  readonly at: string | undefined
}

/**
 * Reads the user messages of the conversation a transcript currently holds, line by line in file order. The transcript is a tree: every
 * entry names its `parentUuid`, and a rewind leaves the abandoned messages in the file while the next ones continue from an earlier entry.
 * The conversation is the chain from its last entry back to the root, where a `last-prompt` entry marked `rewound` moves that last entry to
 * the point the rewind cut back to (none when it cut back to the first message). Reading it from the file is also what lets the list
 * survive a restart of the process.
 */
export class CheckpointScan {
  private readonly parents = new Map<string, string | undefined>()
  private readonly prompts = new Map<string, { readonly label: string; readonly at: string | undefined }>()
  private leaf: string | undefined

  visit(line: string): void {
    // Cheap filter first: a transcript line can hold megabytes of tool output.
    if (!line.includes('"uuid"') && !line.includes('"rewound"')) return
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      return
    }
    if (!isRecord(entry) || entry['isSidechain'] === true) return
    if (entry['type'] === 'last-prompt') {
      if (entry['rewound'] === true) this.leaf = text(entry['leafUuid']) || undefined
      return
    }
    const uuid = text(entry['uuid'])
    if (uuid === undefined || !('parentUuid' in entry)) return
    this.parents.set(uuid, text(entry['parentUuid']) || undefined)
    this.leaf = uuid
    const content = isRecord(entry['message']) ? entry['message']['content'] : undefined
    // A tool result, the caveats and hook feedback the CLI adds, and a compaction summary are user entries too, but nobody typed them.
    const typed =
      entry['type'] === 'user' &&
      entry['isMeta'] !== true &&
      entry['isCompactSummary'] !== true &&
      !(Array.isArray(content) && content.some((block) => isRecord(block) && block['type'] === 'tool_result'))
    if (typed) this.prompts.set(uuid, { label: checkpointLabel(content), at: text(entry['timestamp']) })
  }

  /** Every message the transcript holds as typed by the user, on the conversation or not. */
  get recorded(): ReadonlySet<string> {
    return new Set(this.prompts.keys())
  }

  /** The typed messages of the conversation as it stands, oldest first. */
  get checkpoints(): ClaudeCheckpoint[] {
    const chain: string[] = []
    const seen = new Set<string>()
    for (let at = this.leaf; at !== undefined && !seen.has(at); at = this.parents.get(at)) {
      seen.add(at)
      chain.push(at)
    }
    return chain.reverse().flatMap((uuid) => {
      const prompt = this.prompts.get(uuid)
      return prompt === undefined ? [] : [{ uuid, ...prompt }]
    })
  }
}

/** A message by its position in the list (1-based) or a unique prefix of its uuid. */
export function findCheckpoint(
  checkpoints: readonly ClaudeCheckpoint[],
  reference: string,
): { readonly checkpoint: ClaudeCheckpoint; readonly position: number } | { readonly error: string } {
  const wanted = reference.trim().toLowerCase().replace(/^#/, '')
  if (/^\d+$/.test(wanted)) {
    const position = Number(wanted)
    const checkpoint = checkpoints[position - 1]
    return checkpoint === undefined
      ? { error: `There is no message ${position}. /rewind lists ${checkpoints.length}.` }
      : { checkpoint, position }
  }
  const matches = checkpoints.flatMap((checkpoint, index) => (wanted.length >= 6 && checkpoint.uuid.startsWith(wanted) ? [{ checkpoint, position: index + 1 }] : []))
  if (matches.length === 1 && matches[0] !== undefined) return matches[0]
  return { error: matches.length > 1 ? `"${reference}" matches several messages; use the number from /rewind.` : `No message matches "${reference}". /rewind lists them.` }
}

const CHECKPOINTS_LISTED = 20

export function renderCheckpoints(checkpoints: readonly ClaudeCheckpoint[]): string {
  if (checkpoints.length === 0) return 'There are no messages in the current Claude Code conversation yet.'
  const first = Math.max(0, checkpoints.length - CHECKPOINTS_LISTED)
  const rows = checkpoints.slice(first).map((checkpoint, index) => [String(first + index + 1), cell(checkpoint.label, CHECKPOINT_LABEL_LIMIT), checkpoint.at === undefined ? '' : clock(checkpoint.at)])
  return [
    `**Rewind points** — ${checkpoints.length} message${checkpoints.length === 1 ? '' : 's'} in this conversation${first > 0 ? `, the last ${CHECKPOINTS_LISTED} shown` : ''}`,
    '',
    table(['#', 'Message', 'Sent'], rows, [0]),
    '',
    '`/rewind <n>` previews going back to just before message *n*; `/rewind <n> confirm` restores the files Claude changed since then and rolls the conversation back (`code`: files only, `chat`: conversation only).',
  ].join('\n')
}

/** What a restore of the files would change (Claude Code's dry run of `rewind_files`), or why it cannot restore them. */
export type RewindFilePlan =
  | { readonly restorable: true; readonly files: readonly string[]; readonly insertions: number | undefined; readonly deletions: number | undefined }
  | { readonly restorable: false; readonly reason: string }

export function rewindFilePlan(reply: Json): RewindFilePlan {
  if (reply['canRewind'] !== true) return { restorable: false, reason: clip((text(reply['error']) ?? 'Claude Code refused').replace(/[.\s]+$/, ''), 200) }
  const files = (Array.isArray(reply['filesChanged']) ? reply['filesChanged'] : []).filter((file): file is string => typeof file === 'string')
  return { restorable: true, files, insertions: num(reply['insertions']), deletions: num(reply['deletions']) }
}

const FILES_LISTED = 40

/** "message 3", or "message 3 and the 2 messages after it". */
function messageSpan(position: number, total: number): string {
  const later = total - position
  return later === 0 ? `message ${position}` : `message ${position} and the ${later === 1 ? '1 message' : `${later} messages`} after it`
}

/** "3 files (+10 −2)": the files a restore changes and, when Claude Code says, how many lines. */
const fileCount = (changed: number, insertions: number | undefined, deletions: number | undefined): string =>
  `${changed} file${changed === 1 ? '' : 's'}${insertions === undefined && deletions === undefined ? '' : ` (+${insertions ?? 0} −${deletions ?? 0})`}`

/** What `/rewind` tells about the message it goes back to; `mode` is what the user asked to roll back. */
export interface RewindPoint {
  readonly checkpoint: ClaudeCheckpoint
  readonly position: number
  /** How many messages the conversation has. */
  readonly total: number
  readonly mode: RewindMode
}

const REWIND_LIMITS =
  'The messages stay visible in this DSH conversation (its log is append-only). Shell-command side effects are never undone; only files Claude changed through its file tools are restored.'

export function renderRewindPreview(point: RewindPoint & { readonly plan: RewindFilePlan | undefined }): string {
  const { checkpoint, position, total, mode, plan } = point
  const out = [`**Rewind to just before message ${position}** (${code(clip(checkpoint.label, CHECKPOINT_LABEL_LIMIT))})`, '']
  if (mode !== 'code') out.push(`- **Conversation:** Claude Code would forget ${messageSpan(position, total)}.`)
  if (plan !== undefined) {
    if (!plan.restorable) out.push(`- **Files:** cannot be restored — ${plan.reason}.`)
    else if (plan.files.length === 0) out.push("- **Files:** nothing to restore; no file changed through Claude's file tools after this message.")
    else {
      out.push(
        `- **Files:** ${fileCount(plan.files.length, plan.insertions, plan.deletions)} would be restored:`,
        ...plan.files.slice(0, FILES_LISTED).map((file) => `  - ${code(file)}`),
        ...(plan.files.length > FILES_LISTED ? [`  - …and ${plan.files.length - FILES_LISTED} more`] : []),
      )
    }
  }
  out.push('')
  const confirm = (words: string): string => `\`/rewind ${position}${words} confirm\``
  if (mode === 'both') {
    out.push(
      plan?.restorable === false
        ? `Run ${confirm('')} to roll the conversation back; the files cannot be restored, so they stay as they are.`
        : `Run ${confirm('')} to do both, ${confirm(' code')} to restore the files only, or ${confirm(' chat')} to roll the conversation back only.`,
    )
  } else if (mode === 'code') {
    out.push(plan?.restorable === false ? 'There is nothing to run for the files.' : `Run ${confirm(' code')} to restore the files. The conversation stays as it is.`)
  } else out.push(`Run ${confirm(' chat')} to roll the conversation back. The files stay as they are.`)
  out.push('', REWIND_LIMITS)
  return out.join('\n')
}

/** What `/rewind … confirm` did: the files it restored (none when it did not touch them or could not) and whether the conversation went back. */
export interface RewindOutcome extends RewindPoint {
  readonly restored: RewindFilePlan | undefined
  readonly skippedLinks: number
  readonly rolledBack: boolean
}

export function renderRewindResult(outcome: RewindOutcome): string {
  const { checkpoint, position, total, mode, restored, skippedLinks, rolledBack } = outcome
  const label = `message ${position} (${code(clip(checkpoint.label, CHECKPOINT_LABEL_LIMIT))})`
  const head = mode === 'code' ? `Restored the files to how they were before ${label}.` : mode === 'chat' ? `Rolled the conversation back to just before ${label}.` : `Rewound to just before ${label}.`
  const out = [head, '']
  if (mode !== 'chat' && restored !== undefined) {
    if (!restored.restorable) out.push(`- **Files:** not restored — ${restored.reason}.`)
    else if (restored.files.length === 0) out.push("- **Files:** nothing to restore; no file changed through Claude's file tools after this message.")
    else out.push(`- **Files:** restored ${fileCount(restored.files.length, restored.insertions, restored.deletions)}${skippedLinks > 0 ? `; ${skippedLinks} link${skippedLinks === 1 ? '' : 's'} skipped` : ''}.`)
  }
  if (rolledBack) out.push(`- **Conversation:** Claude Code no longer remembers ${messageSpan(position, total)}.`)
  out.push('')
  if (!rolledBack && mode !== 'chat') out.push('The conversation was not rolled back: Claude still remembers the later work, so tell it the files changed back.')
  out.push(REWIND_LIMITS)
  return out.join('\n')
}

const REWIND_REFUSALS: Readonly<Record<string, string>> = {
  turn_running: 'a turn is running',
  commands_queued: 'Claude Code has messages waiting in its queue',
  prompt_pending: 'Claude Code is waiting for an answer to a permission request or a question',
  target_not_found: 'Claude Code no longer has that message in its conversation (it is before a compaction, or was rolled back already)',
  stale_target: 'Claude Code has newer messages than this list shows; run /rewind again',
  unseen_later_turn: 'Claude Code has newer messages than this list shows; run /rewind again',
  target_splits_tool_call: 'that message sits inside a tool call',
  poll_tool_result_target: 'that message is the result of a tool call',
  delivered_poll_events_in_range: 'a tool delivered results after that message',
  persist_failed: 'Claude Code could not save the change',
  state_changed: 'the conversation changed while it was rolled back; try again',
  usage_limited: 'the account has reached a usage limit',
  expired: 'the request expired',
}

/** Why Claude Code refused a `rewind_conversation`, in words. */
export function rewindRefusal(reply: Json): string {
  const reason = text(reply['reason'])
  const known = reason !== undefined && Object.hasOwn(REWIND_REFUSALS, reason) ? REWIND_REFUSALS[reason] : undefined
  return known ?? text(reply['error']) ?? reason ?? 'Claude Code refused'
}

// ---------------------------------------------------------------------------
// Side questions (`/btw`)
// ---------------------------------------------------------------------------

/** One answered side question, as the CLI wants it back in `history`. */
export interface SideExchange {
  readonly question: string
  readonly response: string
  readonly fallbackNotice?: string | undefined
}

const SIDE_HISTORY_EXCHANGES = 10
const SIDE_HISTORY_CHARS = 24_000
/** One long answer must not push every earlier exchange out of the budget: it is replayed as context, not as a record. */
const SIDE_RESPONSE_CHARS = 6_000

/** The side questions this conversation already asked: the CLI keeps no memory of them in a stream-json session, so the client replays them. */
export class SideHistory {
  private exchanges: SideExchange[] = []

  push(exchange: SideExchange): void {
    const response = exchange.response.length <= SIDE_RESPONSE_CHARS ? exchange.response : `${exchange.response.slice(0, SIDE_RESPONSE_CHARS)}…`
    this.exchanges = [...this.exchanges, { ...exchange, response }].slice(-SIDE_HISTORY_EXCHANGES)
  }

  clear(): void {
    this.exchanges = []
  }

  /** The newest exchanges that fit the size budget, oldest first, in the wire shape of `side_question.history`. */
  payload(): Json[] {
    const kept: SideExchange[] = []
    let size = 0
    for (const exchange of [...this.exchanges].reverse()) {
      size += exchange.question.length + exchange.response.length + (exchange.fallbackNotice?.length ?? 0)
      if (size > SIDE_HISTORY_CHARS) break
      kept.unshift(exchange)
    }
    return kept.map((exchange) => ({
      question: exchange.question,
      response: exchange.response,
      ...(exchange.fallbackNotice === undefined ? {} : { fallback_notice: exchange.fallbackNotice }),
    }))
  }
}

/**
 * The outcome of a `side_question` answer. A `synthetic` response is the CLI's own placeholder for a failed call ("(API error: …)",
 * "(The model tried to call a tool …)"); it is an error for the user and is not remembered as history.
 */
export function sideAnswer(question: string, reply: Json): { readonly result: NativeCommandResult; readonly exchange: SideExchange | undefined } {
  const response = text(reply['response'])
  if (response === undefined || response.trim() === '') {
    return { result: { kind: 'error', text: 'Claude Code returned no answer to the side question.' }, exchange: undefined }
  }
  if (reply['synthetic'] === true) return { result: { kind: 'error', text: response }, exchange: undefined }
  const fallback = isRecord(reply['refusal_fallback']) ? reply['refusal_fallback'] : undefined
  if (fallback === undefined) return { result: { kind: 'success', text: response }, exchange: { question, response } }
  const notice =
    text(fallback['content']) ??
    `Answered by ${text(fallback['fallback_model']) ?? 'the fallback model'}: ${text(fallback['original_model']) ?? 'the model'} declined to answer.`
  return { result: { kind: 'success', text: `${response}\n\n> ${notice}` }, exchange: { question, response, fallbackNotice: notice } }
}

// ---------------------------------------------------------------------------
// Renderers of control-request answers
// ---------------------------------------------------------------------------

export function renderStatus(reply: Json): string {
  const sections = records(reply['sections'])
  if (sections.length === 0) return 'Claude Code reported no status information.'
  return sections
    .map((section) => {
      const rows = records(section['rows']).flatMap((row) => {
        const value = text(row['value'])
        if (value === undefined) return []
        const label = text(row['label'])
        return [`- ${label === undefined ? '' : `**${label}:** `}${value.trim().replace(/\n/g, BULLET_CONTINUATION)}`]
      })
      return `### ${text(section['title']) ?? 'Status'}\n\n${rows.length === 0 ? '_Nothing to show._' : rows.join('\n')}`
    })
    .join('\n\n')
}

const share = (tokens: number, size: number | undefined): string => (size === undefined || size <= 0 ? '' : `${((tokens / size) * 100).toFixed(1)}%`)

export function renderContext(reply: Json): string {
  const total = num(reply['totalTokens'])
  const size = num(reply['maxTokens']) ?? num(reply['rawMaxTokens'])
  const percentage = num(reply['percentage'])
  const model = text(reply['model'])
  const usage =
    total === undefined
      ? 'unknown'
      : `${count(total)}${size === undefined ? '' : ` of ${count(size)}`} tokens${percentage === undefined ? '' : ` (${percentage}%)`}`
  const out = [`**Context usage:** ${usage}${model === undefined ? '' : ` · model ${code(model)}`}`]
  const categories = records(reply['categories'])
  if (categories.length > 0) {
    const rows = categories.map((category) => {
      const tokens = num(category['tokens']) ?? 0
      return [cell(category['name'], 60), count(tokens), share(tokens, size)]
    })
    out.push('', table(['Category', 'Tokens', 'Share'], rows, [1, 2]))
  }
  const threshold = num(reply['autoCompactThreshold'])
  if (typeof reply['isAutoCompactEnabled'] === 'boolean') {
    out.push('', reply['isAutoCompactEnabled'] ? `Auto-compact is on${threshold === undefined ? '' : ` and starts at ${count(threshold)} tokens`}.` : 'Auto-compact is off.')
  }
  const memory = records(reply['memoryFiles'])
  if (memory.length > 0) {
    out.push('', '**Memory files**', ...memory.map((file) => `- ${code(text(file['path']) ?? '?')} — ${count(num(file['tokens']) ?? 0)} tokens`))
  }
  const agents = records(reply['agents'])
  if (agents.length > 0) {
    out.push('', '**Custom agents**', ...agents.map((agent) => `- ${text(agent['agentType']) ?? '?'}${text(agent['source']) ? ` (${text(agent['source'])})` : ''} — ${count(num(agent['tokens']) ?? 0)} tokens`))
  }
  const skills = isRecord(reply['skills']) ? reply['skills'] : undefined
  if (skills !== undefined) {
    out.push('', `**Skills:** ${count(num(skills['includedSkills']) ?? num(skills['totalSkills']) ?? 0)} listed, ${count(num(skills['tokens']) ?? 0)} tokens. \`/skills\` shows them.`)
  }
  const mcpTools = records(reply['mcpTools'])
  if (mcpTools.length > 0) {
    out.push('', '**MCP tools**', ...mcpTools.map((tool) => `- ${text(tool['name']) ?? '?'}${text(tool['serverName']) ? ` (${text(tool['serverName'])})` : ''} — ${count(num(tool['tokens']) ?? 0)} tokens`))
  }
  const breakdown = isRecord(reply['messageBreakdown']) ? reply['messageBreakdown'] : undefined
  if (breakdown !== undefined) {
    const labels: readonly (readonly [string, string])[] = [
      ['userMessageTokens', 'your messages'],
      ['assistantMessageTokens', 'assistant replies'],
      ['toolCallTokens', 'tool calls'],
      ['toolResultTokens', 'tool results'],
      ['attachmentTokens', 'attachments'],
    ]
    const parts = labels.flatMap(([key, label]) => ((num(breakdown[key]) ?? 0) > 0 ? [`${label} ${count(num(breakdown[key]) ?? 0)}`] : []))
    if (parts.length > 0) out.push('', `**Messages:** ${parts.join(' · ')} tokens`)
  }
  return out.join('\n')
}

const USAGE_WINDOWS: readonly (readonly [string, string])[] = [
  ['five_hour', '5-hour window'],
  ['seven_day', '7-day window'],
  ['seven_day_opus', '7-day Opus window'],
  ['seven_day_sonnet', '7-day Sonnet window'],
  ['seven_day_oauth_apps', '7-day OAuth apps window'],
]

function usageWindow(label: string, window: unknown): string | undefined {
  if (!isRecord(window)) return undefined
  const used = num(window['utilization'])
  const resets = text(window['resets_at'])
  if (used === undefined && resets === undefined) return undefined
  return `- **${label}:** ${used === undefined ? 'usage unknown' : `${Math.round(used)}% used`}${resets === undefined ? '' : `, resets ${clock(resets)}`}`
}

export function renderUsage(cost: Json | undefined, usage: Json | undefined): string {
  const out: string[] = []
  const summary = text(cost?.['text'])
  if (summary !== undefined && summary.trim() !== '') out.push('**Session**', '', markdownEscape(summary))
  else if (isRecord(usage?.['session'])) {
    const session = usage['session']
    out.push(
      '**Session**',
      '',
      `- Cost: $${(num(session['total_cost_usd']) ?? 0).toFixed(4)}`,
      `- API time: ${duration(num(session['total_api_duration_ms']) ?? 0)} · wall time: ${duration(num(session['total_duration_ms']) ?? 0)}`,
      `- Code changes: ${count(num(session['total_lines_added']) ?? 0)} lines added, ${count(num(session['total_lines_removed']) ?? 0)} removed`,
    )
  }
  if (usage !== undefined) {
    const limits = isRecord(usage['rate_limits']) ? usage['rate_limits'] : undefined
    const lines =
      limits === undefined
        ? []
        : [
            ...USAGE_WINDOWS.flatMap(([key, label]) => usageWindow(label, limits[key]) ?? []),
            ...records(limits['model_scoped']).flatMap((entry) => usageWindow(`${text(entry['display_name']) ?? 'Model'} weekly window`, entry) ?? []),
          ]
    const plan = text(usage['subscription_type'])
    if (usage['rate_limits_available'] === true && lines.length > 0) out.push('', `**Plan usage**${plan === undefined ? '' : ` (${plan})`}`, '', ...lines)
    else out.push('', '**Plan usage:** not available here; plan rate limits only exist for claude.ai subscriptions, not for an API key or a gateway.')
  }
  return out.length === 0 ? 'Claude Code reported no usage information.' : out.join('\n')
}

export function renderMemory(reply: Json): string {
  const out: string[] = []
  const files = records(reply['files'])
  if (files.length > 0) {
    out.push(
      '**Memory files**',
      '',
      ...files.map((file) => {
        const label = text(file['label']) ?? text(file['kind']) ?? 'file'
        const where = text(file['path'])
        const note = text(file['description'])
        return `- ${file['exists'] === false ? '○' : '●'} ${label}${where === undefined || where === label ? '' : ` — ${code(where)}`}${file['exists'] === false ? ' _(not created)_' : ''}${note ? ` · ${note}` : ''}`
      }),
    )
  }
  const folders = records(reply['folders'])
  if (folders.length > 0) {
    out.push('', '**Folders**', '', ...folders.map((folder) => `- ${text(folder['label']) ?? text(folder['kind']) ?? 'folder'}: ${code(text(folder['path']) ?? '?')}`))
  }
  const memories = records(reply['memories'])
  if (memories.length > 0) {
    out.push('', `**Saved memories** (${memories.length})`, '', ...memories.slice(0, 40).map((memory) => `- ${cell(text(memory['title']) ?? text(memory['name']) ?? text(memory['path']) ?? JSON.stringify(memory), 140)}`))
  }
  const auto = isRecord(reply['auto_memory']) ? reply['auto_memory'] : undefined
  if (auto !== undefined) out.push('', `**Auto-memory:** ${text(auto['status']) ?? (auto['enabled'] === true ? 'on' : 'off')}`)
  const dream = isRecord(reply['auto_dream']) ? reply['auto_dream'] : undefined
  if (dream !== undefined && dream['shown'] === true) out.push(`**Auto-dream:** ${text(dream['status']) ?? (dream['enabled'] === true ? 'on' : 'off')}${text(dream['detail']) ? ` — ${text(dream['detail'])}` : ''}`)
  return out.length === 0 ? 'Claude Code reported no memory information.' : out.join('\n')
}

export function renderSkills(reply: Json): string {
  const skills = records(reply['skills'])
  if (skills.length === 0) return 'No skills are available in this session.'
  const rows = skills.map((skill) => [
    codeCell(text(skill['display_name']) ?? text(skill['name']) ?? '?'),
    cell(skill['source'], 30),
    cell(text(skill['state']) ?? '', 30) + (text(skill['locked_by']) ? ` (locked: ${text(skill['locked_by'])})` : ''),
    count(num(skill['tokens']) ?? 0),
    cell(skill['description'], 80),
  ])
  const tokens = skills.reduce((sum, skill) => sum + (num(skill['tokens']) ?? 0), 0)
  return [`**Skills** — ${skills.length}, about ${count(tokens)} tokens in the system prompt`, '', table(['Skill', 'Source', 'State', 'Tokens', 'Description'], rows, [3])].join('\n')
}

export function renderHooks(reply: Json): string {
  const hooks = records(reply['hooks'])
  const policy = isRecord(reply['policy']) ? reply['policy'] : {}
  const banners = [
    policy['disabledByPolicy'] === true ? 'All hooks are disabled by managed policy.' : undefined,
    policy['allDisabled'] === true && policy['disabledByPolicy'] !== true ? 'Hooks are disabled (`disableAllHooks`).' : undefined,
    policy['managedOnly'] === true ? 'Only managed hooks run; hooks from other settings are blocked.' : undefined,
    policy['pluginOnly'] === true ? 'Hooks are limited to plugins by managed policy.' : undefined,
    isRecord(reply['safeMode']) ? 'Claude Code runs in safe mode.' : undefined,
    isRecord(reply['bareMode']) ? 'Claude Code runs in bare mode; settings, flag, policy and plugin hooks never fire.' : undefined,
  ].filter((banner): banner is string => banner !== undefined)
  const out: string[] = []
  if (hooks.length === 0) out.push('No hooks are configured.')
  else {
    const byEvent = new Map<string, Json[]>()
    for (const hook of hooks) {
      const event = text(hook['event']) ?? '?'
      byEvent.set(event, [...(byEvent.get(event) ?? []), hook])
    }
    out.push(`**Hooks** — ${hooks.length}`)
    for (const [event, entries] of byEvent) {
      out.push('', `#### ${event}`)
      for (const hook of entries) {
        const matcher = text(hook['matcher'])
        const body = text(hook['commandText']) ?? text(hook['displayText']) ?? ''
        out.push(
          `- ${matcher ? `\`${matcher}\` → ` : ''}${text(hook['type']) ?? 'hook'}: ${code(clip(body, 160))} · ${text(hook['sourceLabel']) ?? text(hook['source']) ?? ''}${hook['disabled'] === true ? ' _(not running)_' : ''}`,
        )
      }
    }
  }
  if (banners.length > 0) out.push('', ...banners.map((banner) => `> ${banner}`))
  const errors = (Array.isArray(reply['errors']) ? reply['errors'] : []).map((error) => (isRecord(error) ? (text(error['message']) ?? JSON.stringify(error)) : String(error)))
  if (errors.length > 0) out.push('', '**Settings files skipped:**', ...errors.map((error) => `- ${error}`))
  return out.join('\n')
}

const RULE_BEHAVIORS: readonly (readonly [string, string])[] = [
  ['allow', 'Allowed'],
  ['ask', 'Ask first'],
  ['deny', 'Denied'],
]

const RULES_PER_GROUP = 40

export function renderPermissions(reply: Json): string {
  const state = isRecord(reply['state']) ? reply['state'] : {}
  const rules = records(state['rules'])
  const out: string[] = []
  if (state['managedOnly'] === true) out.push('> Managed settings pin the rules: only policy rules are applied.', '')
  if (rules.length === 0) out.push('No permission rules are set.')
  for (const [behavior, title] of RULE_BEHAVIORS) {
    const group = rules.filter((rule) => rule['behavior'] === behavior)
    if (group.length === 0) continue
    out.push(
      `**${title}** (${group.length})`,
      '',
      ...group.slice(0, RULES_PER_GROUP).map((rule) => {
        const parts = isRecord(rule['description']) ? rule['description'] : undefined
        // Plain text: cutting a long reading must not leave a bold marker open.
        const meaning = parts === undefined ? '' : clip(`${text(parts['prefix']) ?? ''}${text(parts['emphasis']) ?? ''}${text(parts['suffix']) ?? ''}`, 90)
        const notes = [text(rule['source']), rule['editability'] === 'readonly' ? 'read-only' : undefined, rule['notInEffect'] === true ? 'ignored: managed settings only' : undefined].filter(Boolean)
        return `- ${code(clip(text(rule['rule']) ?? '?', 120))}${meaning === '' ? '' : ` — ${meaning}`} · ${notes.join(', ')}`
      }),
      ...(group.length > RULES_PER_GROUP ? [`- …and ${group.length - RULES_PER_GROUP} more`] : []),
      '',
    )
  }
  const directories = records(state['workspaceDirectories'])
  if (directories.length > 0) out.push('**Extra working directories**', '', ...directories.map((directory) => `- ${code(text(directory['path']) ?? '?')} · ${text(directory['source']) ?? ''}`), '')
  const cwd = text(state['originalCwd'])
  if (cwd !== undefined) out.push(`Working directory: ${code(cwd)}`)
  const errors = (Array.isArray(state['errors']) ? state['errors'] : []).map((error) => (isRecord(error) ? (text(error['message']) ?? JSON.stringify(error)) : String(error)))
  if (errors.length > 0) out.push('', '**Settings files skipped:**', ...errors.map((error) => `- ${error}`))
  return out.join('\n').trim()
}

const DIFF_LINES_PER_FILE = 120
const DIFF_LINES_TOTAL = 400
const DIFF_FILES_LISTED = 40
const DIFF_PATHS_NAMED = 10

/** A short list of paths for a note under the diff: the first few, then how many more. */
function namedPaths(paths: readonly string[]): string {
  return `${paths.slice(0, DIFF_PATHS_NAMED).map((file) => code(clip(file, 80))).join(', ')}${paths.length > DIFF_PATHS_NAMED ? ` and ${paths.length - DIFF_PATHS_NAMED} more` : ''}`
}

export function renderDiff(reply: Json): string {
  const diff = isRecord(reply['diff']) ? reply['diff'] : undefined
  if (diff === undefined) return 'No diff is available: the workspace is not a git repository, or git is in the middle of a merge, rebase or cherry-pick.'
  const files = records(diff['perFileStats'])
  if (files.length === 0) return 'No uncommitted changes.'
  const stats = isRecord(diff['stats']) ? diff['stats'] : {}
  const total = num(stats['filesCount']) ?? files.length
  const source = isRecord(diff['source']) && diff['source']['kind'] === 'branch' ? ` against ${code(text(diff['source']['baseBranch']) ?? 'the base branch')}` : ''
  const rows = files.slice(0, DIFF_FILES_LISTED).map((file) => [
    codeCell(text(file['newPath']) ?? text(file['path']) ?? '?'),
    cell([text(file['status']) ?? 'modified', file['isBinary'] === true ? 'binary' : undefined, file['isUntracked'] === true ? 'untracked' : undefined].filter(Boolean).join(', '), 40),
    `+${count(num(file['added']) ?? 0)} −${count(num(file['removed']) ?? 0)}`,
  ])
  const out = [
    `**${total} file${total === 1 ? '' : 's'} changed** (+${count(num(stats['linesAdded']) ?? 0)} −${count(num(stats['linesRemoved']) ?? 0)})${source}`,
    '',
    table(['File', 'Change', 'Lines'], rows, [2]),
    ...(files.length > DIFF_FILES_LISTED ? ['', `_…and ${files.length - DIFF_FILES_LISTED} more files._`] : []),
  ]
  let budget = DIFF_LINES_TOTAL
  for (const entry of records(diff['hunks'])) {
    if (budget <= 0) break
    const hunks = records(entry['hunks'])
    if (hunks.length === 0) continue
    const lines = hunks.flatMap((hunk) => [
      `@@ -${num(hunk['oldStart']) ?? 0},${num(hunk['oldLines']) ?? 0} +${num(hunk['newStart']) ?? 0},${num(hunk['newLines']) ?? 0} @@`,
      ...(Array.isArray(hunk['lines']) ? hunk['lines'].filter((line): line is string => typeof line === 'string') : []),
    ])
    const shown = lines.slice(0, Math.min(DIFF_LINES_PER_FILE, budget))
    budget -= shown.length
    out.push('', `#### ${text(entry['path']) ?? '?'}`, '', markdownEscape(shown.join('\n')).replace(/^(`+)/, '$1diff'), ...(shown.length < lines.length ? [`_…${lines.length - shown.length} more lines not shown._`] : []))
  }
  const skipped = (Array.isArray(diff['skippedLarge']) ? diff['skippedLarge'] : []).filter((file): file is string => typeof file === 'string')
  if (skipped.length > 0) out.push('', `Too large to show: ${namedPaths(skipped)}`)
  const restricted = (Array.isArray(diff['restricted']) ? diff['restricted'] : []).filter((file): file is string => typeof file === 'string')
  if (restricted.length > 0) out.push('', `Withheld by read rules: ${namedPaths(restricted)}`)
  return out.join('\n')
}

export function renderMcp(servers: readonly Json[]): string {
  if (servers.length === 0) return 'No MCP servers are configured.'
  const rows = servers.map((server) => {
    const info = isRecord(server['serverInfo']) ? `${text(server['serverInfo']['name']) ?? ''} ${text(server['serverInfo']['version']) ?? ''}`.trim() : ''
    const tools = Array.isArray(server['tools']) ? `${server['tools'].length} tools` : ''
    const scope = text(server['scope']) ?? text(server['source']) ?? ''
    return [codeCell(text(server['name']) ?? '?'), text(server['status']) ?? '?', cell(text(server['error']) ?? ([info, tools].filter(Boolean).join(' · ') || ''), 140), cell(scope, 30)]
  })
  return [
    `**MCP servers** — ${servers.length}`,
    '',
    table(['Server', 'Status', 'Details', 'Scope'], rows),
    '',
    'Change one with `/mcp reconnect <server>`, `/mcp enable <server>` or `/mcp disable <server>` (`all` for every server).',
  ].join('\n')
}
