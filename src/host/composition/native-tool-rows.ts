/**
 * Live native tool rows for ACP-executed tool calls.
 *
 * DSH's AgentLoop only writes `tool/call` + `tool/result` for calls it executes
 * itself; an ACP Agent executes its own tools, so the adapter appends the rows
 * directly while the loop's step is still open. The stored-log format admits a
 * tool lifecycle exactly inside an open turn+step and only for a call the same
 * step's assistant message advertises, so each row set is
 * `assistant/message{tool-call}` + `tool/call` at the call's first observation
 * and `tool/result` at its terminal status — the append times are the real
 * start/finish times, and DSH never re-executes anything.
 *
 * Every begun call must be settled before the step can end (`closeTools` in the
 * shipped format validator refuses an unresolved call at `step/end`), so the
 * caller settles whatever is still open on steering, on failure and right
 * before the terminal finish chunk is handed to DSH.
 *
 * The result body prefers the real output the adapter can actually obtain for
 * an ACP result: accumulated `_meta` output chunks (Codex's
 * `terminal_output_delta`/`terminal_exit`), then the client-side terminal this
 * connection still holds for a `terminal` content item, then the result's own
 * text content. A body is bounded to its tail and marked `[output truncated]`;
 * a known non-zero exit is marked `[exit code: N]` like DSH's own bash.
 *
 * `observe` also reports whether it recorded a successful result — the
 * fork-side evidence that a textless `end_turn` had real work behind it, the
 * native counterpart of the host-tool-result evidence upstream. And because
 * Codex reports a read-shaped command (its parser classified the call as a
 * file read) as an `exec_command` call with only a location and never attaches
 * `rawInput`, such a call is presented as the DSH `read` tool with its real
 * path instead of an empty argument set.
 */
import { randomUUID } from 'node:crypto'

import type { SessionLike } from '../../domain/session/session-facts.ts'
import { TerminalOutputRing, type AcpTerminalOutputPeek } from '../../runtime/client-capabilities/terminal.ts'
import type { AcpToolCallSnapshot, AcpToolCallStatus } from './tool-call-reducer.ts'

/**
 * Byte budget for one recorded result body, mirroring DSH bash's per-stream
 * `maxOutputBytes` default (64e3): retention keeps the tail and the row marks
 * the omitted prefix rather than growing an unbounded stored row.
 */
const NATIVE_TOOL_RESULT_MAX_BYTES = 64_000
/** Bound on calls whose ACP `_meta` output is accumulated per prompt. */
const NATIVE_TOOL_OUTPUT_CALL_LIMIT = 64
const TERMINAL_OUTPUT_OMITTED = '[terminal output omitted from the native row]'

/** Row payload accepted by `SessionLike.append`; the host owns the real schema. */

interface OpenRow {
  readonly name: string
  readonly arguments: string
  readonly turn: number
  readonly step: number
  snapshot: AcpToolCallSnapshot
}

/**
 * One call's ACP `_meta` facts: Codex streams command output as
 * `terminal_output_delta` chunks and reports the process outcome as
 * `terminal_exit`. Both are optional; a call may carry neither.
 */
interface CallOutput {
  readonly tail: TerminalOutputRing
  exitCode?: number
  signal?: string
}

/** Where one result body may come from, in effect for every call. */
interface ResultSources {
  readonly captured?: CallOutput | undefined
  /** Adapter read of a client-side terminal still held by this connection. */
  readonly peek?: ((terminalId: string) => AcpTerminalOutputPeek | undefined) | undefined
}

interface ToolPresentation {
  readonly name: string
  readonly rename?: Readonly<Record<string, string>>
  readonly shape?: (args: Record<string, unknown>) => Record<string, unknown> | null
}

/** Claude `Agent`/`Task` carry `subagent_type`; DSH's subagent tool does not read it. */
const agentArgs = (args: Record<string, unknown>): Record<string, unknown> => {
  const { subagent_type: _type, ...rest } = args
  return rest
}

/**
 * Native names → the DSH wire tool that renders them (same pairs as the panel's
 * importer: only same-tool pairs, renames translate a key DSH spells differently).
 */
const PRESENTATIONS: Readonly<Record<string, Readonly<Record<string, ToolPresentation>>>> = {
  claude: {
    Bash: { name: 'bash', rename: { timeout: 'timeoutMs' } },
    Read: { name: 'read' },
    Write: { name: 'write' },
    Edit: { name: 'edit' },
    Glob: { name: 'glob' },
    Grep: { name: 'grep', rename: { glob: 'include' } },
    WebFetch: { name: 'web_fetch' },
    WebSearch: {
      name: 'web_search',
      shape: (args) => (typeof args.query === 'string' && args.query !== '' ? { queries: [args.query] } : null),
    },
    TodoWrite: { name: 'todo_write' },
    Skill: { name: 'skill', rename: { skill: 'name' } },
    Agent: { name: 'subagent', shape: agentArgs },
    Task: { name: 'subagent', shape: agentArgs },
  },
  codex: {
    exec_command: { name: 'bash', rename: { cmd: 'command' } },
    view_image: { name: 'read_image', rename: { path: 'file_path' } },
  },
  omp: {
    bash: { name: 'bash', rename: { i: 'description' } },
    read: { name: 'read', rename: { path: 'file_path' } },
    write: { name: 'write', rename: { path: 'file_path' } },
    glob: { name: 'glob', rename: { path: 'pattern' } },
    grep: { name: 'grep' },
    edit: { name: 'edit' },
  },
}

/**
 * ACP call kinds → the DSH wire tool, used when the profile has no name/title
 * pair for a call (an ACP `execute` announcement often carries only the command
 * line in its title). Only pairs whose argument shape is known are listed.
 */
const KIND_PRESENTATIONS: Readonly<Record<string, ToolPresentation>> = {
  execute: {
    name: 'bash',
    shape: (args) => {
      if (typeof args['command'] !== 'string' || args['command'] === '') return null
      const out: Record<string, unknown> = { command: args['command'] }
      if (typeof args['cwd'] === 'string' && args['cwd'] !== '') out['workdir'] = args['cwd']
      return out
    },
  },
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/**
 * One location without `rawInput` is a file read. Codex parses a command such
 * as `sed -n '1,240p' README.md` as a read and reports it as an `exec_command`
 * tool call whose only argument material is the single `locations` entry; it
 * never attaches `rawInput`, so the location is the call's real argument.
 */
function locationReadPresentation(
  snapshot: AcpToolCallSnapshot,
): { readonly name: string; readonly arguments: string } | undefined {
  if (snapshot.name !== 'exec_command') return undefined
  const locations = Array.isArray(snapshot.locations) ? snapshot.locations : []
  if (locations.length !== 1) return undefined
  const path = record(locations[0])?.['path']
  if (typeof path !== 'string' || path === '') return undefined
  return { name: 'read', arguments: JSON.stringify({ file_path: path }, null, 2) }
}

/**
 * The row a call presents as once its arguments are known: a DSH wire tool when
 * the profile maps the native pair, else the native pair unchanged. `undefined`
 * means the call must wait — an agent may announce a call with a title first
 * and attach its input one update later, and the stored row is immutable. A
 * terminal snapshot instead admits the fallback row: the terminal update never
 * comes later and must still advertise the call.
 */
function knownPresentation(
  profile: string,
  snapshot: AcpToolCallSnapshot,
  terminal: boolean,
): { readonly name: string; readonly arguments: string } | undefined {
  const args = record(snapshot.rawInput)
  const origin =
    (typeof snapshot.name === 'string' && snapshot.name !== '' ? snapshot.name : undefined) ??
    (typeof snapshot.title === 'string' && snapshot.title !== '' ? snapshot.title : undefined) ??
    (typeof snapshot.kind === 'string' && snapshot.kind !== '' ? snapshot.kind : 'tool')
  if (args === undefined) {
    const read = locationReadPresentation(snapshot)
    if (read !== undefined) return read
    return terminal ? { name: origin, arguments: JSON.stringify({}, null, 2) } : undefined
  }
  const entry =
    PRESENTATIONS[profile]?.[origin] ??
    (typeof snapshot.kind === 'string' ? KIND_PRESENTATIONS[snapshot.kind] : undefined)
  if (entry === undefined) return { name: origin, arguments: JSON.stringify(args, null, 2) }
  const shaped = entry.shape === undefined ? args : entry.shape(args)
  if (shaped === null) return { name: origin, arguments: JSON.stringify(args, null, 2) }
  const out: Record<string, unknown> = { ...shaped }
  for (const [from, to] of Object.entries(entry.rename ?? {})) {
    if (from in out) {
      out[to] = out[from]
      delete out[from]
    }
  }
  return { name: entry.name, arguments: JSON.stringify(out, null, 2) }
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/**
 * ACP prompt usage → the durable usage DSH folds (dsh-token-meter `normalizeUsage`):
 * `inputTokens` is uncached input, `totalTokens` must equal input+output+cacheRead+cacheWrite.
 */
export function dshUsageFromAcp(
  usage: unknown,
): { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens?: number } | undefined {
  const source = record(usage)
  if (source === undefined) return undefined
  const input = source['inputTokens']
  const output = source['outputTokens']
  if (!isCount(input) || !isCount(output)) return undefined
  const cacheRead = isCount(source['cachedReadTokens']) ? source['cachedReadTokens'] : 0
  const cacheWrite = isCount(source['cachedWriteTokens']) ? source['cachedWriteTokens'] : 0
  const thought = isCount(source['thoughtTokens']) ? source['thoughtTokens'] : undefined
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output + cacheRead + cacheWrite,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    ...(thought === undefined || thought > output ? {} : { reasoningTokens: thought }),
  }
}

/** One result content list for a terminal (or abandoned) ACP call. */
function resultContent(
  snapshot: AcpToolCallSnapshot,
  sources: ResultSources = {},
): { content: Array<{ type: 'text'; text: string }>; isError: boolean } {
  const content: Array<{ type: 'text'; text: string }> = []
  const capturedText =
    sources.captured !== undefined && sources.captured.tail.text().trim() !== ''
      ? sources.captured.tail.text()
      : undefined
  let capturedUsed = false
  let truncated = sources.captured?.tail.truncated === true
  let exitCode = sources.captured?.exitCode
  let signal = sources.captured?.signal
  const rawRecord = record(snapshot.rawOutput)
  const rawString =
    typeof snapshot.rawOutput === 'string' && snapshot.rawOutput.trim() !== '' ? snapshot.rawOutput : undefined
  const formattedValue = rawRecord?.['formatted_output']
  const rawFormatted =
    typeof formattedValue === 'string' && formattedValue.trim() !== '' ? formattedValue : undefined
  if (exitCode === undefined) {
    const rawExit = rawRecord?.['exit_code'] ?? rawRecord?.['exitCode']
    if (typeof rawExit === 'number' && Number.isSafeInteger(rawExit)) exitCode = rawExit
  }
  const items = Array.isArray(snapshot.content) ? snapshot.content : []
  for (const raw of items) {
    const item = record(raw)
    if (item === undefined) continue
    if (item['type'] === 'content') {
      const block = record(item['content'])
      if (block?.['type'] === 'text' && typeof block['text'] === 'string') {
        content.push({ type: 'text', text: block['text'] })
        continue
      }
      if (block !== undefined && typeof block['type'] === 'string') {
        content.push({ type: 'text', text: `[ACP ${block['type']} content omitted]` })
      }
      continue
    }
    if (item['type'] === 'diff') {
      const path = typeof item['path'] === 'string' ? item['path'] : ''
      content.push({ type: 'text', text: `[diff${path === '' ? '' : ` ${path}`}]` })
      continue
    }
    if (item['type'] === 'terminal') {
      // The real output, in order of what this adapter can actually obtain: the
      // terminal the adapter itself still holds for this id, then the call's own
      // `_meta` chunks. An exit fact with no bytes anywhere means the command
      // produced none (`(no output)`, as DSH bash renders an empty run); only a
      // call with no bytes *and* no exit fact records the omission marker.
      const terminalId = typeof item['terminalId'] === 'string' ? item['terminalId'] : ''
      const peeked = terminalId === '' ? undefined : sources.peek?.(terminalId)
      if (peeked !== undefined && peeked.output.trim() !== '') {
        content.push({ type: 'text', text: peeked.output })
        if (exitCode === undefined && peeked.exitCode !== null) exitCode = peeked.exitCode
        if (signal === undefined && peeked.signal !== null) signal = peeked.signal
        if (peeked.truncated) truncated = true
      } else if (capturedText !== undefined && !capturedUsed) {
        content.push({ type: 'text', text: capturedText })
        capturedUsed = true
      } else {
        content.push({
          type: 'text',
          text: exitCode === undefined && signal === undefined ? TERMINAL_OUTPUT_OMITTED : '(no output)',
        })
      }
      continue
    }
  }
  // A non-terminal command sends its output only as `_meta` chunks, so the
  // captured text belongs to the result even without a terminal item.
  if (!capturedUsed && capturedText !== undefined && !content.some((part) => part.text === capturedText)) {
    content.push({ type: 'text', text: capturedText })
  }
  if (!content.some((part) => part.text.trim() !== '')) {
    if (rawString !== undefined) content.push({ type: 'text', text: rawString })
    else if (rawFormatted !== undefined) content.push({ type: 'text', text: rawFormatted })
    else content.push({ type: 'text', text: snapshot.status === 'completed' ? '(no output)' : `ACP tool call ${snapshot.status}` })
  }
  // Exit markers follow DSH bash: the signal names the kill, a known non-zero
  // exit is reported, a clean exit stays unmarked.
  const markers: string[] = []
  if (truncated) markers.push('[output truncated]')
  if (signal !== undefined) markers.push(`[killed by signal: ${signal}]`)
  else if (exitCode !== undefined && exitCode !== 0) markers.push(`[exit code: ${exitCode}]`)
  if (markers.length > 0) content.push({ type: 'text', text: markers.join('\n') })
  return { content, isError: snapshot.status !== 'completed' }
}

/**
 * Per-prompt recorder appending the native rows for one ACP session's tool calls.
 * One instance belongs to one DSH turn; ids are the ACP call ids.
 */
export class AcpNativeToolRows {
  private readonly open = new Map<string, OpenRow>()
  private readonly settled = new Set<string>()
  /** Per-call `_meta` output/exit facts, bounded by NATIVE_TOOL_OUTPUT_CALL_LIMIT. */
  private readonly outputs = new Map<string, CallOutput>()

  constructor(
    private readonly session: SessionLike | undefined,
    private readonly provider: string,
    private readonly model: string,
    private readonly log?: (message: string) => void,
    private readonly terminalOutput?: (terminalId: string) => AcpTerminalOutputPeek | undefined,
  ) {}

  /**
   * Observe one merged ACP call snapshot: advertise on first sight, settle on
   * terminal. Returns true when this observation itself settled a call whose
   * recorded result proves the agent ran it successfully — the evidence the
   * profile adapter uses to accept a textless `end_turn` instead of failing it
   * (a call whose row was refused proves nothing).
   */
  observe(snapshot: AcpToolCallSnapshot, meta?: unknown): boolean {
    const session = this.session
    const id = snapshot.callId
    if (session === undefined || typeof id !== 'string' || id.length === 0 || this.settled.has(id)) return false
    const terminal = snapshot.status === 'completed' || snapshot.status === 'failed' || snapshot.status === 'cancelled'
    if (meta !== undefined && meta !== null) this.absorbMeta(id, meta)
    const presented = knownPresentation(this.profile(), snapshot, terminal)
    let row = this.open.get(id)
    if (row === undefined) {
      // A call with no arguments yet (and no derivable ones) is not advertised
      // until its terminal update, which never comes later and must still
      // produce a row — with whatever the snapshot shows.
      if (presented === undefined) return false
      const step = session.facts.openSteps.at(-1)
      const append = session.append
      if (step !== undefined && append !== undefined) {
        try {
          append('assistant/message', {
            turn: step.turn,
            step: step.step,
            message: {
              role: 'assistant',
              content: [{ type: 'tool-call', id, name: presented.name, arguments: presented.arguments }],
              source: { kind: 'model', provider: this.provider, model: this.model },
              id: randomUUID(),
            },
            stream: [
              {
                type: 'tool-call-chunks',
                time0: 0,
                index: 0,
                dt: [],
                id,
                name: presented.name,
                args: [presented.arguments],
              },
              { type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } },
            ],
          }, { surfaceOp: 'append' })
          append('tool/call', {
            turn: step.turn,
            step: step.step,
            callId: id,
            name: presented.name,
            arguments: presented.arguments,
          })
        } catch (error) {
          this.settled.add(id)
          this.log?.(`ACP native tool row skipped for ${id}: ${String(error)}`)
          return false
        }
        row = { name: presented.name, arguments: presented.arguments, turn: step.turn, step: step.step, snapshot }
        this.open.set(id, row)
      } else if (!terminal) {
        return false
      }
    } else row.snapshot = snapshot
    return terminal ? this.settle(id) : false
  }

  /** Settle every open row with its last observed status (unfinished calls keep their content). */
  settleOpen(unresolved: AcpToolCallStatus = 'cancelled'): void {
    for (const id of [...this.open.keys()]) this.settle(id, unresolved)
  }

  /**
   * Accumulate one tool update's ACP `_meta`: Codex streams a command's output
   * as `terminal_output_delta.data` appends and closes with `terminal_exit`
   * (its `terminal` result content item carries no bytes of its own).
   */
  private absorbMeta(id: string, meta: unknown): void {
    const source = record(meta)
    const delta = record(source?.['terminal_output_delta'])
    const data = delta?.['data']
    const exit = record(source?.['terminal_exit'])
    if (typeof data !== 'string' && exit === undefined) return
    let output = this.outputs.get(id)
    if (output === undefined) {
      if (this.outputs.size >= NATIVE_TOOL_OUTPUT_CALL_LIMIT) return
      output = { tail: new TerminalOutputRing(NATIVE_TOOL_RESULT_MAX_BYTES) }
      this.outputs.set(id, output)
    }
    if (typeof data === 'string' && data.length > 0) output.tail.append(data)
    if (exit === undefined) return
    const exitCode = exit['exit_code']
    if (typeof exitCode === 'number' && Number.isSafeInteger(exitCode)) output.exitCode = exitCode
    const signal = exit['signal']
    if (typeof signal === 'string' && signal !== '') output.signal = signal
  }

  /**
   * Append the `tool/result` row for one open call. Returns true when the
   * recorded result is a successful run — the durable evidence for accepting a
   * textless `end_turn`; a call settled as cancelled/failed, or a result the
   * session refused, is not evidence.
   */
  private settle(id: string, force?: AcpToolCallStatus): boolean {
    const row = this.open.get(id)
    if (row === undefined) return false
    this.open.delete(id)
    this.settled.add(id)
    const captured = this.outputs.get(id)
    this.outputs.delete(id)
    const session = this.session
    if (session === undefined) return false
    const snapshot = force === undefined ? row.snapshot : { ...row.snapshot, status: force }
    const { content, isError } = resultContent(snapshot, { captured, peek: this.terminalOutput })
    const append = session.append
    if (append === undefined) return false
    try {
      append('tool/result', {
        turn: row.turn,
        step: row.step,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: id },
          toolCallId: id,
          content,
          isError,
          id: randomUUID(),
        },
        ...isError ? { error: { message: `ACP tool call ${snapshot.status}`, info: { name: 'AcpToolCall', code: String(snapshot.status) } } } : {},
      }, { surfaceOp: 'append' })
    } catch (error) {
      this.log?.(`ACP native tool result skipped for ${id}: ${String(error)}`)
      return false
    }
    return !isError
  }

  private profile(): string {
    return this.provider.startsWith('acp-') ? this.provider.slice(4) : this.provider
  }
}