/// <reference types="node" />
/**
 * Codex app-server notifications -> ACP session updates.
 *
 * A port of the renderers of `@agentclientprotocol/codex-acp` 2.2.x (the
 * `AcpToolCallRenderer`, `CommandReporter`, `FileChangeReporter`,
 * `McpToolReporter`, `WebSearchReporter`, `GuardianReporter`, ... and the
 * `CodexEventHandler` event switch) for the capability set DSH's ACP client
 * advertises: not an AIR client, no `_meta.terminal_output*` capability, no
 * plan-update / compaction / notice / typed-failure capability. Under that set
 * codex-acp
 *
 *   - names a command tool call (`exec_command`), titles it with the unwrapped
 *     command, attaches a `terminal` content block and `_meta.terminal_info`,
 *     streams output as `_meta.terminal_output_delta` and ends it with
 *     `_meta.terminal_exit` (read/search/list commands end with
 *     `rawOutput: { exit_code }` instead);
 *   - renders a file change as one `diff` content block per hunk;
 *   - reports the plan as `plan` updates and a plan item as a message;
 *   - surfaces warnings and errors as agent message text.
 *
 * Reproducing those shapes is what keeps DSH's tool rows (`native-tool-rows.ts`),
 * its usage accounting and the saved transcripts identical across the ACP route
 * and this one.
 */
import type * as acp from '@agentclientprotocol/sdk'

import { asRecord, readArray, readNumber, readString, readStringArray, type JsonRecord } from './codex-json.ts'
import type { NativeContextUsage, NativeTurnUsage } from './contract.ts'

// ---------------------------------------------------------------------------
// Tool-call rendering (codex-acp `AcpToolCallRenderer`, non-AIR client)
// ---------------------------------------------------------------------------

type ToolStatus = acp.ToolCallStatus

interface CommandEndFacts {
  readonly output: string
  readonly exitCode: number | null
  /** The command showed a terminal (a read/search/list command does not). */
  readonly terminal: boolean
  /** Output chunks were already streamed, so the end does not repeat them. */
  readonly streamed: boolean
}

/** Fields a client that is not AIR takes over verbatim; `null` removes the field. */
interface StandardFacts {
  readonly title?: string | undefined
  readonly kind?: acp.ToolKind | undefined
  readonly status?: ToolStatus | undefined
  readonly locations?: readonly string[] | null | undefined
  readonly content?: readonly acp.ToolCallContent[] | null | undefined
  readonly rawInput?: unknown
  readonly rawOutput?: unknown
  readonly commandOutput?: { readonly data: string; readonly terminal: boolean } | undefined
  readonly commandEnd?: CommandEndFacts | undefined
  readonly mcpProgress?: string | undefined
}

export interface ToolFacts {
  readonly toolCallId: string
  readonly report: 'start' | 'update'
  readonly name?: string | undefined
  readonly kind?: acp.ToolKind | undefined
  readonly title?: string | undefined
  readonly status?: ToolStatus | undefined
  readonly locations?: readonly string[] | undefined
  readonly input?: unknown
  readonly opaqueResult?: unknown
  readonly result?: readonly acp.ToolCallContent[] | undefined
  readonly readableInput?: string | undefined
  readonly terminal?: { readonly cwd: string } | undefined
  readonly mcp?: boolean | undefined
  readonly standard?: StandardFacts | undefined
}

function textContent(text: string): acp.ToolCallContent {
  return { type: 'content', content: { type: 'text', text } }
}

function locationEntries(paths: readonly string[] | undefined): Array<{ path: string }> | undefined {
  return paths === undefined || paths.length === 0 ? undefined : paths.map((path) => ({ path }))
}

function contentField(facts: ToolFacts): acp.ToolCallContent[] | undefined {
  const readableInput = facts.readableInput === undefined ? [] : [textContent(facts.readableInput)]
  if (facts.terminal === undefined && readableInput.length === 0 && facts.result === undefined) return undefined
  return [
    ...(facts.terminal === undefined ? [] : [{ type: 'terminal' as const, terminalId: facts.toolCallId }]),
    ...readableInput,
    ...(facts.result ?? []),
  ]
}

function applyStandardFields(rendered: Record<string, unknown>, standard: StandardFacts | undefined): void {
  if (standard === undefined) return
  const locations =
    standard.locations === undefined || standard.locations === null
      ? standard.locations
      : (locationEntries(standard.locations) ?? null)
  const fields: Array<readonly [string, unknown]> = [
    ['title', standard.title],
    ['kind', standard.kind],
    ['status', standard.status],
    ['locations', locations],
    ['content', standard.content],
    ['rawInput', standard.rawInput],
    ['rawOutput', standard.rawOutput],
  ]
  for (const [name, value] of fields) {
    if (value === undefined) continue
    if (value === null) delete rendered[name]
    else rendered[name] = value
  }
}

/** `_meta` of a client without a chunk channel declaration: `terminal_output_delta` for every command. */
function standardMeta(facts: ToolFacts): Record<string, unknown> {
  const terminalId = facts.toolCallId
  const output = facts.standard?.commandOutput
  const end = facts.standard?.commandEnd
  const meta: Record<string, unknown> = {}
  if (facts.terminal !== undefined) meta['terminal_info'] = { cwd: facts.terminal.cwd, terminal_id: terminalId }
  if (output !== undefined) meta['terminal_output_delta'] = { data: output.data, terminal_id: terminalId }
  if (end !== undefined) {
    if (end.output.length > 0 && !end.streamed) {
      meta['terminal_output_delta'] = { data: end.output, terminal_id: terminalId }
    }
    if (end.terminal) {
      meta['terminal_exit'] = { exit_code: end.exitCode, signal: null, terminal_id: terminalId }
    }
  }
  if (facts.standard?.mcpProgress !== undefined) meta['mcp_output_delta'] = { data: facts.standard.mcpProgress }
  if (facts.mcp === true) meta['is_mcp_tool_call'] = true
  return meta
}

function renderFields(facts: ToolFacts): Record<string, unknown> {
  const rendered: Record<string, unknown> = { toolCallId: facts.toolCallId }
  if (facts.name !== undefined) rendered['name'] = facts.name
  if (facts.kind !== undefined) rendered['kind'] = facts.kind
  if (facts.title !== undefined) rendered['title'] = facts.title
  if (facts.status !== undefined) rendered['status'] = facts.status
  const content = contentField(facts)
  if (content !== undefined) rendered['content'] = content
  const locations = facts.locations === undefined ? undefined : facts.locations.map((path) => ({ path }))
  if (locations !== undefined) rendered['locations'] = locations
  if (facts.input !== undefined) rendered['rawInput'] = facts.input
  if (facts.opaqueResult !== undefined) rendered['rawOutput'] = facts.opaqueResult
  const meta = standardMeta(facts)
  applyStandardFields(rendered, facts.standard)
  const end = facts.standard?.commandEnd
  if (end !== undefined) {
    if (end.terminal) delete rendered['rawOutput']
    else rendered['rawOutput'] = { exit_code: end.exitCode }
  }
  if (facts.report === 'start' && rendered['title'] === undefined) rendered['title'] = ''
  return Object.keys(meta).length > 0 ? { ...rendered, _meta: meta } : rendered
}

/** The `tool_call` / `tool_call_update` session update for one set of tool facts. */
export function renderToolCall(facts: ToolFacts): acp.SessionUpdate {
  const fields = renderFields(facts)
  return (
    facts.report === 'start' ? { sessionUpdate: 'tool_call', ...fields } : { sessionUpdate: 'tool_call_update', ...fields }
  ) as acp.SessionUpdate
}

/** The `toolCall` of a `session/request_permission` request. */
export function renderPermissionToolCall(facts: ToolFacts): acp.ToolCallUpdate {
  const rendered: Record<string, unknown> = { toolCallId: facts.toolCallId }
  if (facts.name !== undefined) rendered['name'] = facts.name
  if (facts.kind !== undefined) rendered['kind'] = facts.kind
  if (facts.status !== undefined) rendered['status'] = facts.status
  if (facts.title !== undefined) rendered['title'] = facts.title
  if (facts.input !== undefined) rendered['rawInput'] = facts.input
  const locations = locationEntries(facts.locations)
  if (locations !== undefined) rendered['locations'] = locations
  const content = contentField(facts)
  if (content !== undefined) rendered['content'] = content
  applyStandardFields(rendered, facts.standard)
  return rendered as acp.ToolCallUpdate
}

// ---------------------------------------------------------------------------
// Status / naming helpers
// ---------------------------------------------------------------------------

/** codex-acp `toToolStatus`: `undefined` for a status the schema does not define. */
function toToolStatus(status: unknown): ToolStatus | undefined {
  switch (status) {
    case 'inProgress':
      return 'in_progress'
    case 'completed':
      return 'completed'
    case 'failed':
    case 'declined':
    case 'interrupted':
      return 'failed'
    default:
      return undefined
  }
}

function toTerminalToolStatus(status: unknown): ToolStatus {
  return status === 'completed' ? 'completed' : 'failed'
}

/** codex-acp `commandToolName`: only the unified-exec sources identify a model tool. */
export function commandToolName(source: unknown): string | undefined {
  switch (source) {
    case 'unifiedExecStartup':
      return 'exec_command'
    case 'unifiedExecInteraction':
      return 'write_stdin'
    default:
      return undefined
  }
}

/** codex-acp `stripShellPrefix`. */
export function stripShellPrefix(command: string): string {
  const withoutShell = command.replace(/^(?:\/bin\/)?(?:bash|zsh|sh)\s+(?:-[lc]+\s+)?/, '')
  if (withoutShell.startsWith("'") && withoutShell.endsWith("'")) return withoutShell.slice(1, -1)
  return withoutShell
}

// ---------------------------------------------------------------------------
// Command execution (codex-acp `CommandReporter`)
// ---------------------------------------------------------------------------

type CommandActionType = 'read' | 'search' | 'listFiles' | 'unknown'

function commandActionType(action: JsonRecord): CommandActionType {
  const type = readString(action, 'type')
  return type === 'read' || type === 'search' || type === 'listFiles' ? type : 'unknown'
}

function singleAction(item: JsonRecord): JsonRecord | undefined {
  const actions = readArray(item, 'commandActions')
  return actions?.length === 1 ? asRecord(actions[0]) : undefined
}

function usesTerminal(item: JsonRecord): boolean {
  const action = singleAction(item)
  return action === undefined || commandActionType(action) === 'unknown'
}

function searchTitle(query: string | undefined, path: string | undefined): string {
  if (query && path) return `Search for '${query}' in ${path}`
  if (query) return `Search for '${query}'`
  if (path) return `Search in '${path}'`
  return 'Search'
}

function commandActionFacts(
  id: string,
  status: unknown,
  cwd: string,
  action: JsonRecord,
  command: string,
): ToolFacts {
  const common = { toolCallId: id, report: 'start' as const, status: toToolStatus(status) }
  const path = readString(action, 'path')
  switch (commandActionType(action)) {
    case 'read':
      return { ...common, kind: 'read', title: `Read file '${path ?? ''}'`, locations: path === undefined ? [] : [path] }
    case 'search':
      return { ...common, kind: 'search', title: searchTitle(readString(action, 'query'), path) }
    case 'listFiles':
      return { ...common, kind: 'read', title: path ? `List files in '${path}'` : 'List files' }
    case 'unknown': {
      const actionCommand = readString(action, 'command') ?? command
      return {
        ...common,
        kind: 'execute',
        title: stripShellPrefix(actionCommand),
        input: { command: actionCommand, cwd },
        terminal: { cwd },
      }
    }
  }
}

function commandStartFacts(item: JsonRecord, id: string): ToolFacts {
  const name = commandToolName(item['source'])
  const command = readString(item, 'command') ?? ''
  const action = singleAction(item) ?? { type: 'unknown', command }
  const facts = commandActionFacts(id, item['status'], readString(item, 'cwd') ?? '', action, command)
  return name === undefined ? facts : { ...facts, name }
}

/** Tracks which commands showed a terminal and which already streamed output. */
class CommandReporter {
  private readonly nonTerminal = new Set<string>()
  private readonly terminal = new Set<string>()
  private readonly streamed = new Set<string>()

  started(item: JsonRecord, id: string): ToolFacts {
    if (usesTerminal(item)) {
      this.nonTerminal.delete(id)
      this.terminal.add(id)
    } else {
      this.nonTerminal.add(id)
      this.terminal.delete(id)
    }
    this.streamed.delete(id)
    return commandStartFacts(item, id)
  }

  /** A chunk of command output. */
  outputDelta(itemId: string, delta: string): ToolFacts {
    if (delta.length > 0) this.streamed.add(itemId)
    return {
      toolCallId: itemId,
      report: 'update',
      standard: { commandOutput: { data: delta, terminal: this.terminal.has(itemId) } },
    }
  }

  /** Text written to the stdin of a running command, shown as an output chunk on its own line. */
  terminalInput(itemId: string, stdin: string): ToolFacts {
    return {
      toolCallId: itemId,
      report: 'update',
      standard: { commandOutput: { data: `\n${stdin}\n`, terminal: this.terminal.has(itemId) } },
    }
  }

  completed(item: JsonRecord, id: string): ToolFacts {
    this.nonTerminal.delete(id)
    const name = commandToolName(item['source'])
    const exitCode = readNumber(item, 'exitCode')
    return {
      toolCallId: id,
      report: 'update',
      ...(name === undefined ? {} : { name }),
      status: toTerminalToolStatus(item['status']),
      standard: {
        content: null,
        commandEnd: {
          output: readString(item, 'aggregatedOutput') ?? '',
          exitCode: exitCode ?? null,
          terminal: this.terminal.delete(id),
          streamed: this.streamed.delete(id),
        },
      },
    }
  }
}

// ---------------------------------------------------------------------------
// File changes (codex-acp `FileChangeReporter`) and unified diffs
// ---------------------------------------------------------------------------

const FILE_CHANGE_TITLE = 'Editing files'
const DIFF_PATCH_MAX_BYTES = 1024 * 1024

interface UnifiedHunk {
  readonly lines: readonly string[]
}

/**
 * The hunks of a unified diff that holds exactly one file patch, or `null`.
 * Follows jsdiff's `parsePatch`, which codex-acp uses for the same job.
 */
export function parseSingleUnifiedPatch(diff: string): readonly UnifiedHunk[] | null {
  try {
    const patches = parseUnifiedPatches(diff)
    return patches.length === 1 ? (patches[0] ?? null) : null
  } catch {
    return null
  }
}

const isGitDiffHeader = (line: string): boolean => /^diff --git /.test(line)
const isDiffHeader = (line: string): boolean =>
  isGitDiffHeader(line) || /^Index:\s/.test(line) || /^diff(?: -r \w+)+\s/.test(line)
const isFileHeader = (line: string): boolean => /^(---|\+\+\+)\s/.test(line)
const isHunkHeader = (line: string): boolean => /^@@\s/.test(line)

function parseUnifiedPatches(diff: string): UnifiedHunk[][] {
  const lines = diff.split(/\n/)
  const patches: UnifiedHunk[][] = []
  let i = 0

  const parseFileHeader = (state: { names: number }): void => {
    if (i < lines.length && /^(---|\+\+\+)\s+/.test(lines[i] ?? '')) {
      state.names += 1
      i += 1
    }
  }

  const parseHunk = (): UnifiedHunk => {
    const headerIndex = i
    const header = (lines[i] ?? '').split(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    i += 1
    let oldLines = header[2] === undefined ? 1 : Number(header[2])
    let newLines = header[4] === undefined ? 1 : Number(header[4])
    const hunkLines: string[] = []
    let addCount = 0
    let removeCount = 0
    for (; i < lines.length && (removeCount < oldLines || addCount < newLines || lines[i]?.startsWith('\\')); i += 1) {
      const line = lines[i] ?? ''
      const operation = line.length === 0 && i !== lines.length - 1 ? ' ' : line[0]
      if (operation !== '+' && operation !== '-' && operation !== ' ' && operation !== '\\') {
        throw new Error(`Hunk at line ${String(headerIndex + 1)} contained invalid line ${line}`)
      }
      hunkLines.push(line)
      if (operation === '+') addCount += 1
      else if (operation === '-') removeCount += 1
      else if (operation === ' ') {
        addCount += 1
        removeCount += 1
      }
    }
    if (addCount === 0 && newLines === 1) newLines = 0
    if (removeCount === 0 && oldLines === 1) oldLines = 0
    if (addCount !== newLines) throw new Error(`Added line count did not match for hunk at line ${String(headerIndex + 1)}`)
    if (removeCount !== oldLines) {
      throw new Error(`Removed line count did not match for hunk at line ${String(headerIndex + 1)}`)
    }
    const next = lines[i]
    if (next !== undefined && next !== '' && /^[+ -]/.test(next) && !isFileHeader(next)) {
      throw new Error(`Hunk at line ${String(headerIndex + 1)} has more lines than expected`)
    }
    return { lines: hunkLines }
  }

  const parseIndex = (): void => {
    const hunks: UnifiedHunk[] = []
    patches.push(hunks)
    let seenDiffHeader = false
    while (i < lines.length) {
      const line = lines[i] ?? ''
      if (isFileHeader(line) || isHunkHeader(line)) break
      if (isGitDiffHeader(line)) {
        if (seenDiffHeader) return
        seenDiffHeader = true
        i += 1
        while (i < lines.length) {
          const extension = lines[i] ?? ''
          if (isFileHeader(extension) || isHunkHeader(extension) || isDiffHeader(extension)) break
          i += 1
        }
        continue
      }
      if (isDiffHeader(line)) {
        if (seenDiffHeader) return
        seenDiffHeader = true
      }
      i += 1
    }
    const headers = { names: 0 }
    parseFileHeader(headers)
    parseFileHeader(headers)
    if (headers.names === 1) throw new Error('Missing file header')
    while (i < lines.length) {
      const line = lines[i] ?? ''
      if (isDiffHeader(line) || isFileHeader(line) || /^===================================================================/.test(line)) break
      if (isHunkHeader(line)) hunks.push(parseHunk())
      else i += 1
    }
  }

  while (i < lines.length) parseIndex()
  return patches
}

function stripLineBreak(lines: string[]): void {
  const last = lines.at(-1)
  if (last !== undefined) lines[lines.length - 1] = last.slice(0, -1)
}

/** codex-acp `hunkTexts`: the old and new text of one hunk. */
function hunkTexts(lines: readonly string[]): { readonly oldText: string; readonly newText: string } {
  const oldLines: string[] = []
  const newLines: string[] = []
  let previous = ' '
  for (const line of lines) {
    const sign = line[0] ?? ' '
    if (sign === '\\') {
      if (previous !== '+') stripLineBreak(oldLines)
      if (previous !== '-') stripLineBreak(newLines)
      continue
    }
    const text = `${line.slice(1)}\n`
    if (sign !== '+') oldLines.push(text)
    if (sign !== '-') newLines.push(text)
    previous = sign
  }
  return { oldText: oldLines.join(''), newText: newLines.join('') }
}

function fitsDiffLimit(text: string): boolean {
  return text.length <= DIFF_PATCH_MAX_BYTES && Buffer.byteLength(text, 'utf8') <= DIFF_PATCH_MAX_BYTES
}

function diffBlock(path: string, kind: string, oldText: string | null, newText: string): acp.ToolCallContent {
  return { type: 'diff', path, oldText, newText, _meta: { kind } }
}

function createPatchContent(change: JsonRecord): acp.ToolCallContent[] {
  const path = readString(change, 'path')
  const kind = asRecord(change['kind'])
  const kindType = readString(kind, 'type')
  const diff = readString(change, 'diff') ?? ''
  if (path === undefined || kindType === undefined) return []
  if (kindType === 'add' || kindType === 'delete') {
    if (!fitsDiffLimit(diff)) return []
    return [diffBlock(path, kindType, kindType === 'add' ? null : diff, kindType === 'add' ? diff : '')]
  }
  if (kindType !== 'update') return []
  const movePath = readString(kind, 'move_path') ?? null
  const unifiedDiff = diff.replace(/\n\nMoved to: .*$/, '')
  const targetPath = movePath ?? path
  if (!fitsDiffLimit(unifiedDiff)) return []
  if (movePath !== null && unifiedDiff.trim().length === 0) return [diffBlock(targetPath, 'update', '', '')]
  const hunks = parseSingleUnifiedPatch(unifiedDiff)
  if (hunks === null) return []
  return hunks.map((hunk) => {
    const { oldText, newText } = hunkTexts(hunk.lines)
    return diffBlock(targetPath, 'update', oldText, newText)
  })
}

function fileChangeStartFacts(item: JsonRecord, id: string): ToolFacts {
  const diffs: acp.ToolCallContent[] = []
  for (const change of readArray(item, 'changes') ?? []) {
    const record = asRecord(change)
    if (record !== undefined) diffs.push(...createPatchContent(record))
  }
  return {
    toolCallId: id,
    report: 'start',
    title: FILE_CHANGE_TITLE,
    kind: 'edit',
    status: toToolStatus(item['status']),
    result: diffs,
  }
}

export function fileChangePermissionFacts(itemId: string, item: JsonRecord | undefined): ToolFacts {
  const paths = new Set<string>()
  for (const change of readArray(item, 'changes') ?? []) {
    const path = readString(asRecord(change), 'path')
    if (path !== undefined) paths.add(path)
  }
  return {
    toolCallId: itemId,
    report: 'update',
    title: FILE_CHANGE_TITLE,
    ...(item === undefined ? { kind: 'edit' as const, status: 'pending' as const } : {}),
    locations: [...paths],
    standard: { kind: 'edit', status: 'pending', title: 'Edit files' },
  }
}

// ---------------------------------------------------------------------------
// MCP / dynamic tools / web search / images / sub-agents / compaction / guardian
// ---------------------------------------------------------------------------

function mcpInput(item: JsonRecord): Record<string, unknown> {
  return { server: item['server'], tool: item['tool'], arguments: item['arguments'] }
}

function mcpResultFacts(item: JsonRecord): { readonly opaqueResult?: unknown } {
  const result = item['result'] ?? null
  const error = item['error'] ?? null
  return result === null && error === null ? {} : { opaqueResult: { result, error } }
}

function mcpStartFacts(item: JsonRecord, id: string): ToolFacts {
  return {
    toolCallId: id,
    report: 'start',
    kind: 'execute',
    title: `mcp.${readString(item, 'server') ?? ''}.${readString(item, 'tool') ?? ''}`,
    status: toToolStatus(item['status']),
    input: mcpInput(item),
    ...mcpResultFacts(item),
    mcp: true,
  }
}

function mcpCompletedFacts(item: JsonRecord, id: string): ToolFacts {
  return {
    toolCallId: id,
    report: 'update',
    status: toTerminalToolStatus(item['status']),
    input: mcpInput(item),
    ...mcpResultFacts(item),
  }
}

function dynamicToolName(item: JsonRecord): string {
  return `${readString(item, 'namespace') ?? ''}${readString(item, 'tool') ?? ''}`
}

function dynamicToolResult(item: JsonRecord): { readonly result?: readonly acp.ToolCallContent[] } {
  const contentItems = readArray(item, 'contentItems')
  if (contentItems === undefined) return {}
  return {
    result: contentItems.map((entry): acp.ToolCallContent => {
      const record = asRecord(entry)
      switch (readString(record, 'type')) {
        case 'inputImage':
          return {
            type: 'content',
            content: { type: 'resource_link', uri: readString(record, 'imageUrl') ?? '', name: 'image' },
          }
        case 'inputAudio':
          return {
            type: 'content',
            content: { type: 'resource_link', uri: readString(record, 'audioUrl') ?? '', name: 'audio' },
          }
        default:
          return { type: 'content', content: { type: 'text', text: readString(record, 'text') ?? '' } }
      }
    }),
  }
}

function dynamicToolStartFacts(item: JsonRecord, id: string): ToolFacts {
  return {
    toolCallId: id,
    report: 'start',
    name: dynamicToolName(item),
    kind: 'execute',
    title: readString(item, 'tool') ?? '',
    status: toToolStatus(item['status']),
    input: { arguments: item['arguments'] },
    ...dynamicToolResult(item),
  }
}

function dynamicToolCompletedFacts(item: JsonRecord, id: string): ToolFacts {
  return {
    toolCallId: id,
    report: 'update',
    name: dynamicToolName(item),
    status: toTerminalToolStatus(item['status']),
    ...dynamicToolResult(item),
  }
}

function webSearchTitle(item: JsonRecord): string {
  const query = readString(item, 'query')
  const action = asRecord(item['action'])
  if (action === undefined) return query ? `Web search: ${query}` : 'Web search'
  switch (readString(action, 'type')) {
    case 'search': {
      const queries = readStringArray(action, 'queries').filter((candidate) => candidate.length > 0)
      const actionQuery = readString(action, 'query') ?? (queries.length > 0 ? queries.join(', ') : undefined) ?? query
      return actionQuery ? `Web search: ${actionQuery}` : 'Web search'
    }
    case 'openPage': {
      const url = readString(action, 'url')
      return url ? `Open page: ${url}` : 'Open page'
    }
    case 'findInPage': {
      const pattern = readString(action, 'pattern')
      const url = readString(action, 'url')
      return `Find in page${pattern ? ` for '${pattern}'` : ''}${url ? ` in ${url}` : ''}`.trim()
    }
    default:
      return 'Web search'
  }
}

function webSearchFacts(item: JsonRecord, id: string, report: 'start' | 'update'): ToolFacts {
  return {
    toolCallId: id,
    report,
    title: webSearchTitle(item),
    input: { query: item['query'], action: item['action'] },
    // A live report of a client that is not AIR also names the item.
    standard: { rawInput: { type: item['type'], id, query: item['query'], action: item['action'] } },
  }
}

function imageViewFacts(item: JsonRecord, id: string): ToolFacts {
  const path = readString(item, 'path') ?? ''
  return {
    toolCallId: id,
    report: 'start',
    name: 'view_image',
    kind: 'read',
    title: `View Image ${path}`,
    status: 'completed',
    result: [{ type: 'content', content: { type: 'resource_link', name: path, uri: path } }],
    locations: [path],
    input: { path },
  }
}

function imageGenerationResult(item: JsonRecord): acp.ToolCallContent[] {
  const result: acp.ToolCallContent[] = []
  const revisedPrompt = readString(item, 'revisedPrompt')
  if (revisedPrompt !== undefined && revisedPrompt.trim() !== '') result.push(textContent(`Revised prompt: ${revisedPrompt}`))
  const savedPathValue = readString(item, 'savedPath')
  const savedPath = savedPathValue !== undefined && savedPathValue.trim() !== '' ? savedPathValue : undefined
  const data = readString(item, 'result') ?? ''
  if (data.trim() !== '') {
    result.push({
      type: 'content',
      content: { type: 'image', data, mimeType: 'image/png', ...(savedPath === undefined ? {} : { uri: savedPath }) },
    })
  } else if (savedPath !== undefined) {
    result.push({ type: 'content', content: { type: 'resource_link', name: savedPath, uri: savedPath } })
  }
  return result
}

function imageGenerationStandard(item: JsonRecord): StandardFacts {
  const rawOutput: Record<string, unknown> = {
    status: item['status'],
    revisedPrompt: item['revisedPrompt'],
    result: item['result'],
  }
  if ('savedPath' in item) rawOutput['savedPath'] = item['savedPath'] ?? null
  return {
    content: imageGenerationResult(item).filter(
      (entry) => entry.type !== 'content' || entry.content.type !== 'resource_link',
    ),
    rawOutput,
  }
}

const imageTerminalStatus = (status: unknown): ToolStatus => (status === 'failed' ? 'failed' : 'completed')

function collabAgentFacts(item: JsonRecord, id: string, report: 'start' | 'update'): ToolFacts {
  const input = {
    prompt: item['prompt'],
    senderThreadId: item['senderThreadId'],
    receiverThreadIds: item['receiverThreadIds'],
    agentsStates: item['agentsStates'],
    model: item['model'],
    reasoningEffort: item['reasoningEffort'],
  }
  return {
    toolCallId: id,
    report,
    title: readString(item, 'tool') ?? '',
    status: toToolStatus(item['status']),
    input,
    standard: { content: null, rawInput: { ...input, status: item['status'] }, rawOutput: null },
    ...(report === 'start' ? { kind: 'other' as const } : {}),
  }
}

function subagentActivityTitle(kind: unknown, name: string): string {
  switch (kind) {
    case 'started':
      return `Start subagent ${name}`
    case 'interacted':
      return `Interact with subagent ${name}`
    case 'interrupted':
      return `Interrupt subagent ${name}`
    default:
      return `Complete subagent ${name}`
  }
}

function subagentActivityFacts(item: JsonRecord, id: string, status: ToolStatus, report: 'start' | 'update'): ToolFacts {
  const agentPath = readString(item, 'agentPath') ?? ''
  const name = agentPath.split('/').filter(Boolean).at(-1) ?? 'subagent'
  return {
    toolCallId: id,
    report,
    ...(report === 'start' ? { kind: 'other' as const, title: subagentActivityTitle(item['kind'], name) } : {}),
    status,
    input: {
      agentThreadId: item['agentThreadId'],
      agentPath: item['agentPath'],
      activityKind: item['kind'],
    },
  }
}

const COMPACTION_TITLE = 'Compact conversation'

function guardianToolCallId(reviewId: string): string {
  return `guardian_assessment:${reviewId}`
}

function guardianStatus(status: unknown): ToolStatus | undefined {
  switch (status) {
    case 'inProgress':
      return 'in_progress'
    case 'approved':
      return 'completed'
    case 'denied':
    case 'aborted':
    case 'timedOut':
      return 'failed'
    default:
      return undefined
  }
}

function formatGuardianStatus(status: unknown): string {
  switch (status) {
    case 'inProgress':
      return 'In progress'
    case 'approved':
      return 'Approved'
    case 'denied':
      return 'Denied'
    case 'aborted':
      return 'Aborted'
    case 'timedOut':
      return 'Timed out'
    default:
      return String(status)
  }
}

function shellQuote(arg: string): string {
  if (arg.length === 0) return "''"
  if (/^[A-Za-z0-9_/:=+.,@%-]+$/.test(arg)) return arg
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

function guardianCommandSourceLabel(source: unknown): string {
  return source === 'unifiedExec' ? 'exec' : 'shell'
}

function guardianActionSummary(action: JsonRecord | undefined): string | undefined {
  if (action === undefined) return undefined
  switch (readString(action, 'type')) {
    case 'command':
      return `${guardianCommandSourceLabel(action['source'])} ${readString(action, 'command') ?? ''}`
    case 'execve': {
      const argv = readStringArray(action, 'argv')
      const command = argv.length > 0 ? argv : [readString(action, 'program') ?? '']
      return `${guardianCommandSourceLabel(action['source'])} ${command.map(shellQuote).join(' ')}`
    }
    case 'writeStdin':
      return `write stdin to process ${String(action['processId'])}`
    case 'applyPatch': {
      const files = readStringArray(action, 'files')
      return files.length === 1 ? `apply_patch touching ${files[0] ?? ''}` : `apply_patch touching ${String(files.length)} files`
    }
    case 'networkAccess': {
      const target = readString(action, 'target') ?? ''
      return `network access to ${target.length > 0 ? target : (readString(action, 'host') ?? '')}`
    }
    case 'mcpToolCall':
      return `MCP ${readString(action, 'toolName') ?? ''} on ${readString(action, 'connectorName') ?? readString(action, 'server') ?? ''}`
    case 'requestPermissions':
      return readString(action, 'reason') ?? 'request additional permissions'
    default:
      return undefined
  }
}

function guardianVerdict(review: JsonRecord | undefined, action: string | null): acp.ToolCallContent {
  const lines = [`Status: ${formatGuardianStatus(review?.['status'])}`]
  if (action) lines.push(`Action: ${action}`)
  const riskLevel = readString(review, 'riskLevel')
  if (riskLevel) lines.push(`Risk: ${riskLevel}`)
  const authorization = readString(review, 'userAuthorization')
  if (authorization) lines.push(`Authorization: ${authorization}`)
  const rationale = readString(review, 'rationale')
  if (rationale?.trim()) lines.push(`Rationale: ${rationale}`)
  return textContent(lines.join('\n'))
}

function guardianFacts(event: JsonRecord, report: 'start' | 'update'): ToolFacts | undefined {
  const reviewId = readString(event, 'reviewId')
  if (reviewId === undefined) return undefined
  const review = asRecord(event['review'])
  const actionRecord = asRecord(event['action'])
  const summary = guardianActionSummary(actionRecord) ?? null
  return {
    toolCallId: guardianToolCallId(reviewId),
    report,
    ...(report === 'start' ? { kind: 'think' as const, title: 'Guardian Review' } : {}),
    status: guardianStatus(review?.['status']),
    input: { action: event['action'] },
    ...(summary === null ? {} : { readableInput: `Action: ${summary}` }),
    result: [guardianVerdict(review, null)],
    standard: {
      // A client that is not AIR gets one text with the action, and the whole event.
      content: [guardianVerdict(review, summary)],
      ...(report === 'start' ? { rawInput: event } : { rawInput: null, rawOutput: event }),
    },
  }
}

// ---------------------------------------------------------------------------
// Permission tool calls (codex-acp `CommandReporter.permission`, ...)
// ---------------------------------------------------------------------------

export interface CodexPermissionContext {
  commandStarted(itemId: string): boolean
  commandName(itemId: string): string | undefined
  fileChange(itemId: string): JsonRecord | undefined
  popPendingMcpApproval(serverName: string): string | undefined
}

/** codex-acp `permissionProfileContent`: text lines for the filesystem/network scopes of a profile. */
function permissionProfileContent(permissions: JsonRecord | undefined): acp.ToolCallContent[] {
  const lines: string[] = []
  const network = asRecord(permissions?.['network'])
  const enabled = network?.['enabled']
  if (typeof enabled === 'boolean') lines.push(enabled ? 'Enable network access' : 'Disable network access')
  const fileSystem = asRecord(permissions?.['fileSystem'])
  for (const entry of readArray(fileSystem, 'entries') ?? []) {
    const record = asRecord(entry)
    const path = asRecord(record?.['path'])
    const access = readString(record, 'access') ?? ''
    switch (readString(path, 'type')) {
      case 'glob_pattern':
        lines.push(`${access} filesystem pattern ${readString(path, 'pattern') ?? ''}`)
        break
      case 'special':
        lines.push(`${access} Codex filesystem scope ${JSON.stringify(path?.['value'])}`)
        break
      default:
        break
    }
  }
  return lines.length > 0 ? [textContent(lines.join('\n'))] : []
}

/** codex-acp `permissionProfilePaths`. */
function permissionProfilePaths(permissions: JsonRecord | undefined): string[] {
  const fileSystem = asRecord(permissions?.['fileSystem'])
  const paths = new Set<string>([...readStringArray(fileSystem, 'read'), ...readStringArray(fileSystem, 'write')])
  for (const entry of readArray(fileSystem, 'entries') ?? []) {
    const path = asRecord(asRecord(entry)?.['path'])
    if (readString(path, 'type') === 'path') {
      const value = readString(path, 'path')
      if (value !== undefined) paths.add(value)
    }
  }
  return [...paths]
}

function permissionTitle(actions: readonly JsonRecord[]): string {
  const first = actions[0]
  if (first === undefined) return 'Run command'
  switch (commandActionType(first)) {
    case 'read':
      return actions.length === 1 ? 'Read file' : 'Run command with file reads'
    case 'listFiles':
      return 'List files'
    case 'search':
      return 'Search files'
    case 'unknown':
      return 'Run command'
  }
}

function actionPaths(actions: readonly JsonRecord[]): string[] {
  return actions.flatMap((action) => {
    const path = readString(action, 'path')
    return path === undefined ? [] : [path]
  })
}

/** The tool call of a command approval request. */
export function commandPermissionToolCall(params: JsonRecord, context: CodexPermissionContext): acp.ToolCallUpdate {
  const itemId = readString(params, 'itemId') ?? ''
  const started = context.commandStarted(itemId)
  const name = context.commandName(itemId)
  const network = asRecord(params['networkApprovalContext'])
  const protocol = readString(network, 'protocol')
  const host = readString(network, 'host')
  const networkUrl = protocol === 'http' || protocol === 'https' ? `${protocol}://${host ?? ''}` : undefined
  const additionalPermissions = asRecord(params['additionalPermissions'])
  const command = readString(params, 'command')
  const cwd = readString(params, 'cwd')
  const input: Record<string, unknown> = {
    ...(command ? { command: stripShellPrefix(command) } : {}),
    ...(cwd ? { cwd } : {}),
    ...(networkUrl ? { url: networkUrl } : {}),
    ...(additionalPermissions ? { additionalPermissions } : {}),
  }
  const actions = (readArray(params, 'commandActions') ?? []).flatMap((entry) => {
    const record = asRecord(entry)
    return record === undefined ? [] : [record]
  })
  const content = [
    ...(network ? [textContent(`${protocol ?? ''} access to ${host ?? ''}`)] : []),
    ...(additionalPermissions ? permissionProfileContent(additionalPermissions) : []),
  ]
  const permissionPaths = permissionProfilePaths(additionalPermissions)
  const networkTitle = `${protocol ?? ''} network access to ${host ?? ''}`
  const startedTitle = ((): string => {
    const action = actions.length === 1 ? actions[0] : command ? { type: 'unknown', command } : undefined
    if (action === undefined) return 'Run command'
    return commandActionFacts(itemId, 'inProgress', cwd ?? '', action, command ?? '').title ?? 'Run command'
  })()
  return renderPermissionToolCall({
    toolCallId: itemId,
    report: 'update',
    ...(name === undefined ? {} : { name }),
    ...(started ? {} : { kind: 'execute' as const, status: 'pending' as const }),
    title: network ? networkTitle : started ? startedTitle : permissionTitle(actions),
    ...(Object.keys(input).length > 0 ? { input } : {}),
    locations: [...new Set([...(started ? [] : actionPaths(actions)), ...permissionPaths])],
    ...(content.length > 0 ? { result: content } : {}),
    standard: {
      kind: 'execute',
      status: 'pending',
      title: network ? networkTitle : permissionTitle(actions),
      locations: [...new Set([...actionPaths(actions), ...permissionPaths])],
    },
  })
}

/** The tool call of a file-change approval request. */
export function fileChangePermissionToolCall(params: JsonRecord, context: CodexPermissionContext): acp.ToolCallUpdate {
  const itemId = readString(params, 'itemId') ?? ''
  return renderPermissionToolCall(fileChangePermissionFacts(itemId, context.fileChange(itemId)))
}

/** The tool call of an additional-permissions (`request_permissions`) approval request. */
export function sandboxPermissionToolCall(params: JsonRecord): acp.ToolCallUpdate {
  const permissions = asRecord(params['permissions'])
  const content = permissionProfileContent(permissions)
  return renderPermissionToolCall({
    toolCallId: readString(params, 'itemId') ?? '',
    report: 'update',
    name: 'request_permissions',
    kind: 'other',
    status: 'pending',
    title: 'Additional sandbox permissions',
    input: {
      permissions: params['permissions'],
      cwd: params['cwd'],
      environmentId: params['environmentId'],
    },
    locations: permissionProfilePaths(permissions),
    ...(content.length > 0 ? { result: content } : {}),
  })
}

/** The tool call of an MCP elicitation shown as a permission request. */
export function elicitationPermissionToolCall(
  params: JsonRecord,
  isToolApproval: boolean,
  correlatedCallId: string | undefined,
  standaloneToolCallId: () => string,
): acp.ToolCallUpdate {
  const mode = readString(params, 'mode')
  if (mode === 'url') {
    const message = readString(params, 'message')
    return renderPermissionToolCall({
      toolCallId: `elicitation-${readString(params, 'elicitationId') ?? ''}`,
      report: 'update',
      kind: 'fetch',
      status: 'pending',
      title: 'MCP server requests to open a URL',
      input: { serverName: params['serverName'], description: params['message'], url: params['url'] },
      ...(message === undefined ? {} : { readableInput: message }),
    })
  }
  if (correlatedCallId !== undefined) {
    return renderPermissionToolCall({
      toolCallId: correlatedCallId,
      report: 'update',
      kind: 'execute',
      status: 'pending',
    })
  }
  const message = readString(params, 'message')
  return renderPermissionToolCall({
    toolCallId: standaloneToolCallId(),
    report: 'update',
    kind: isToolApproval ? 'execute' : 'other',
    status: 'pending',
    title: isToolApproval ? 'MCP tool call approval' : 'Question from MCP server',
    input: { serverName: params['serverName'], description: params['message'], schema: params['requestedSchema'] },
    ...(message === undefined ? {} : { readableInput: message }),
  })
}

/** A tool call the host shows for a decision that has no app-server item (plan review). */
export function planReviewToolCall(itemId: string, plan: string): acp.ToolCallUpdate {
  return renderPermissionToolCall({
    toolCallId: `plan-review:${itemId}`,
    report: 'update',
    title: 'Implement this plan?',
    kind: 'switch_mode',
    status: 'pending',
    input: { plan },
  })
}

// ---------------------------------------------------------------------------
// Token accounting (codex-acp `TokenCount`, `PromptTokenUsage`)
// ---------------------------------------------------------------------------

export interface CodexTokenCount {
  readonly totalTokens: number
  /** Input tokens served neither from the cache nor written to it. */
  readonly inputTokens: number
  readonly cachedInputTokens: number
  readonly cacheWriteInputTokens: number
  readonly outputTokens: number
  readonly reasoningOutputTokens: number
}

const ZERO_TOKEN_COUNT: CodexTokenCount = {
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
}

const TOKEN_COUNT_FIELDS = [
  'totalTokens',
  'inputTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'outputTokens',
  'reasoningOutputTokens',
] as const

function count(record: JsonRecord, key: string): number {
  return readNumber(record, key) ?? 0
}

/** codex-acp `toTokenCount`: `inputTokens` excludes the cached and cache-written share. */
export function toTokenCount(usage: JsonRecord): CodexTokenCount {
  const cached = count(usage, 'cachedInputTokens')
  const cacheWrite = count(usage, 'cacheWriteInputTokens')
  return {
    totalTokens: count(usage, 'totalTokens'),
    inputTokens: Math.max(0, count(usage, 'inputTokens') - cached - cacheWrite),
    cachedInputTokens: cached,
    cacheWriteInputTokens: cacheWrite,
    outputTokens: count(usage, 'outputTokens'),
    reasoningOutputTokens: count(usage, 'reasoningOutputTokens'),
  }
}

function combine(
  a: CodexTokenCount,
  b: CodexTokenCount,
  operation: (left: number, right: number) => number,
): CodexTokenCount {
  const result: Record<(typeof TOKEN_COUNT_FIELDS)[number], number> = { ...ZERO_TOKEN_COUNT }
  for (const field of TOKEN_COUNT_FIELDS) result[field] = operation(a[field], b[field])
  return result
}

function sameCount(a: CodexTokenCount, b: CodexTokenCount): boolean {
  return TOKEN_COUNT_FIELDS.every((field) => a[field] === b[field])
}

/** Usage of one prompt: the growth of the thread total, or the sum of the per-call counts. */
class CodexPromptTokenUsage {
  private startTotal: CodexTokenCount | null
  private previousTotal: CodexTokenCount | null
  private latestTotal: CodexTokenCount | null = null
  private summedLast: CodexTokenCount | null = null
  private totalWentBack = false
  private modelOutputSeen = false

  /** @param startTotal the thread total when the prompt started, or `null` when it is unknown. */
  constructor(startTotal: CodexTokenCount | null) {
    this.startTotal = startTotal
    this.previousTotal = startTotal
  }

  /** The model produced output in this prompt, so a later update is one of its requests. */
  observeModelOutput(): void {
    this.modelOutputSeen = true
  }

  observe(total: CodexTokenCount, last: CodexTokenCount): void {
    const previous = this.previousTotal
    if (previous !== null && sameCount(total, previous)) return
    if (previous === null && !this.modelOutputSeen) {
      this.startTotal = total
      this.previousTotal = total
      return
    }
    if (previous !== null && TOKEN_COUNT_FIELDS.some((field) => total[field] < previous[field])) {
      this.totalWentBack = true
    }
    this.summedLast = this.summedLast === null ? { ...last } : combine(this.summedLast, last, (x, y) => x + y)
    this.previousTotal = total
    this.latestTotal = total
  }

  usage(): CodexTokenCount | null {
    const start = this.startTotal
    const latest = this.latestTotal
    if (latest === null) return null
    if (start !== null && !this.totalWentBack) return combine(latest, start, (x, y) => x - y)
    return this.summedLast
  }
}

/** Token state of one thread: the context occupancy and the usage of the running prompt. */
export class CodexTokenAccounting {
  private lastTokenUsage: CodexTokenCount | null = null
  private totalTokenUsage: CodexTokenCount | null = null
  private modelContextWindow: number | null = null
  private promptTokenUsage: CodexPromptTokenUsage | null = null

  constructor(private readonly threadHasHistory: boolean) {}

  /** codex-acp `beginPromptTokenUsage`. */
  beginPrompt(): void {
    this.lastTokenUsage = null
    const startTotal = this.totalTokenUsage ?? (this.threadHasHistory ? null : ZERO_TOKEN_COUNT)
    this.promptTokenUsage = new CodexPromptTokenUsage(startTotal)
  }

  observeModelOutput(): void {
    this.promptTokenUsage?.observeModelOutput()
  }

  /** Record one `thread/tokenUsage/updated`; returns the context occupancy when it is known. */
  record(tokenUsage: JsonRecord): NativeContextUsage | undefined {
    const last = asRecord(tokenUsage['last'])
    const total = asRecord(tokenUsage['total'])
    if (last === undefined || total === undefined) return undefined
    this.lastTokenUsage = toTokenCount(last)
    this.totalTokenUsage = toTokenCount(total)
    this.promptTokenUsage?.observe(this.totalTokenUsage, this.lastTokenUsage)
    this.modelContextWindow = readNumber(tokenUsage, 'modelContextWindow') ?? null
    const used = this.lastTokenUsage.totalTokens
    const size = this.modelContextWindow
    return size === null || size <= 0 ? undefined : { used, size }
  }

  /** The usage of the whole prompt, or `undefined` when Codex reported none. */
  promptUsage(): NativeTurnUsage | undefined {
    const usage = this.promptTokenUsage?.usage() ?? null
    if (usage === null) return undefined
    return {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedReadTokens: usage.cachedInputTokens,
      cachedWriteTokens: usage.cacheWriteInputTokens,
      thoughtTokens: usage.reasoningOutputTokens,
    }
  }

  /** The token lines of `/status` (codex-acp `formatTokenUsage` and `formatContextWindow`). */
  statusLines(): readonly [tokenUsage: string, contextWindow: string] {
    const usage = this.totalTokenUsage
    const tokenUsage =
      usage === null
        ? 'data not available yet'
        : `${formatTokenCount(usage.totalTokens)} total  (${formatTokenCount(usage.inputTokens)} input + ${formatTokenCount(usage.cachedInputTokens)} cached input${
            usage.cacheWriteInputTokens > 0 ? ` + ${formatTokenCount(usage.cacheWriteInputTokens)} cache write` : ''
          }, ${formatTokenCount(usage.outputTokens)} output)`
    const last = this.lastTokenUsage
    const window = this.modelContextWindow
    const contextWindow =
      last === null || window === null || window === 0
        ? 'data not available yet'
        : `${String(Math.round((last.totalTokens / window) * 100))}% used (${formatTokenCount(last.totalTokens)} used / ${formatTokenCount(window)})`
    return [tokenUsage, contextWindow]
  }
}

function formatTokenCount(count: number): string {
  if (count >= 1e6) return `${(count / 1e6).toFixed(1)}M`
  if (count >= 1e3) return `${(count / 1e3).toFixed(1)}K`
  return String(count)
}

// ---------------------------------------------------------------------------
// Errors (codex-acp `ServiceErrorMessage`)
// ---------------------------------------------------------------------------

const SERVICE_ERROR_TYPES: Readonly<Record<string, true>> = {
  invalid_request_error: true,
  server_error: true,
  rate_limit_error: true,
  insufficient_quota: true,
  authentication_error: true,
  permission_error: true,
  not_found_error: true,
  conflict_error: true,
  overloaded_error: true,
}

/** An OpenAI-style `{type:"error",status,error:{type,message}}` body becomes its message. */
export function readableServiceErrorMessage(text: string): string {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return text
  }
  const record = asRecord(value)
  if (record === undefined) return text
  const status = record['status']
  const error = asRecord(record['error'])
  if (
    Object.keys(record).some((key) => !['type', 'status', 'error'].includes(key)) ||
    record['type'] !== 'error' ||
    typeof status !== 'number' ||
    !Number.isInteger(status) ||
    status < 400 ||
    status > 599 ||
    error === undefined
  ) {
    return text
  }
  const errorType = readString(error, 'type')
  const message = readString(error, 'message')
  if (
    Object.keys(error).some((key) => !['type', 'message', 'code', 'param'].includes(key)) ||
    errorType === undefined ||
    !Object.hasOwn(SERVICE_ERROR_TYPES, errorType) ||
    message === undefined ||
    message.trim().length === 0
  ) {
    return text
  }
  return message
}

// ---------------------------------------------------------------------------
// Event projection (codex-acp `CodexEventHandler`)
// ---------------------------------------------------------------------------

/** Item types that are not model output (codex-acp `NON_MODEL_OUTPUT_ITEM_TYPES`). */
const NON_MODEL_OUTPUT_ITEM_TYPES: Readonly<Record<string, true>> = {
  userMessage: true,
  hookPrompt: true,
  enteredReviewMode: true,
  subAgentActivity: true,
  contextCompaction: true,
}

export interface CodexProjectionSink {
  update(update: acp.SessionUpdate): void
  contextUsage(usage: NativeContextUsage): void
}

function messageChunk(kind: 'agent_message_chunk' | 'agent_thought_chunk', text: string, messageId?: string): acp.SessionUpdate {
  const content = { type: 'text' as const, text }
  const id = messageId === undefined || messageId === '' ? {} : { messageId }
  return kind === 'agent_message_chunk'
    ? { sessionUpdate: 'agent_message_chunk', ...id, content }
    : { sessionUpdate: 'agent_thought_chunk', ...id, content }
}

export interface CodexCompletedPlan {
  readonly itemId: string
  readonly text: string
}

/**
 * Projects the notifications of the root thread onto ACP session updates and
 * keeps the per-item facts the permission requests refer to.
 */
export class CodexProjection implements CodexPermissionContext {
  private readonly commands = new CommandReporter()
  private readonly activeGuardianReviews = new Set<string>()
  private readonly seenReasoningItems = new Set<string>()
  private readonly streamedMessageItems = new Set<string>()
  private readonly streamedPlanText = new Map<string, string>()
  private readonly activeImageGenerations = new Set<string>()
  private readonly emittedImageViews = new Set<string>()
  private readonly activeSubagentActivities = new Set<string>()
  private readonly startedCommands = new Set<string>()
  private readonly commandNames = new Map<string, string>()
  private readonly fileChanges = new Map<string, JsonRecord>()
  private readonly pendingMcpApprovals = new Map<string, string[]>()
  private completedPlan: CodexCompletedPlan | null = null
  private standaloneMcpSequence = 0

  constructor(
    private readonly sink: CodexProjectionSink,
    private readonly tokens: CodexTokenAccounting,
  ) {}

  // -- permission context ---------------------------------------------------

  commandStarted(itemId: string): boolean {
    return this.startedCommands.has(itemId)
  }

  commandName(itemId: string): string | undefined {
    return this.commandNames.get(itemId)
  }

  fileChange(itemId: string): JsonRecord | undefined {
    return this.fileChanges.get(itemId)
  }

  popPendingMcpApproval(serverName: string): string | undefined {
    const pending = this.pendingMcpApprovals.get(serverName)
    if (pending?.length !== 1) return undefined
    this.pendingMcpApprovals.delete(serverName)
    return pending[0]
  }

  nextStandaloneMcpToolCallId(threadId: string, serverName: string): string {
    this.standaloneMcpSequence += 1
    return ['elicitation', threadId, serverName, String(this.standaloneMcpSequence)].join(':')
  }

  takeCompletedPlan(): CodexCompletedPlan | null {
    const plan = this.completedPlan
    this.completedPlan = null
    return plan
  }

  /** `turn/completed`: transient per-turn state ends with the turn. */
  endTurn(): void {
    this.streamedPlanText.clear()
    this.startedCommands.clear()
    this.commandNames.clear()
    this.fileChanges.clear()
    this.pendingMcpApprovals.clear()
  }

  // -- notifications ----------------------------------------------------------

  /** Project one notification of the root thread; unknown methods are ignored. */
  handle(method: string, params: JsonRecord): void {
    switch (method) {
      case 'item/agentMessage/delta': {
        const delta = readString(params, 'delta')
        if (delta === undefined || delta === '') return
        const itemId = readString(params, 'itemId')
        if (itemId !== undefined) this.streamedMessageItems.add(itemId)
        this.emit(messageChunk('agent_message_chunk', delta, itemId))
        return
      }
      case 'item/plan/delta': {
        const itemId = readString(params, 'itemId')
        const delta = readString(params, 'delta')
        if (itemId === undefined || delta === undefined || delta === '') return
        this.streamedPlanText.set(itemId, (this.streamedPlanText.get(itemId) ?? '') + delta)
        return
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const itemId = readString(params, 'itemId')
        if (itemId !== undefined) this.seenReasoningItems.add(itemId)
        this.emit(messageChunk('agent_thought_chunk', readString(params, 'delta') ?? '', itemId))
        return
      }
      case 'item/reasoning/summaryPartAdded': {
        const itemId = readString(params, 'itemId')
        if (itemId !== undefined) this.seenReasoningItems.add(itemId)
        this.emit(messageChunk('agent_thought_chunk', '\n\n', itemId))
        return
      }
      case 'item/started':
        this.itemStarted(asRecord(params['item']))
        return
      case 'item/completed':
        this.itemCompleted(asRecord(params['item']))
        return
      case 'turn/plan/updated':
        this.planUpdated(params)
        return
      case 'thread/tokenUsage/updated': {
        const usage = asRecord(params['tokenUsage'])
        const context = usage === undefined ? undefined : this.tokens.record(usage)
        if (context !== undefined) this.sink.contextUsage(context)
        return
      }
      case 'item/commandExecution/outputDelta': {
        const itemId = readString(params, 'itemId')
        if (itemId === undefined) return
        this.emitFacts(this.commands.outputDelta(itemId, readString(params, 'delta') ?? ''))
        return
      }
      case 'item/commandExecution/terminalInteraction': {
        const itemId = readString(params, 'itemId')
        if (itemId === undefined) return
        this.emitFacts(this.commands.terminalInput(itemId, readString(params, 'stdin') ?? ''))
        return
      }
      case 'item/mcpToolCall/progress': {
        const itemId = readString(params, 'itemId')
        if (itemId === undefined) return
        this.emitFacts({
          toolCallId: itemId,
          report: 'update',
          standard: { mcpProgress: (readString(params, 'message') ?? '').trim() },
        })
        return
      }
      case 'item/autoApprovalReview/started': {
        const reviewId = readString(params, 'reviewId')
        if (reviewId === undefined) return
        const report = this.activeGuardianReviews.has(reviewId) ? 'update' : 'start'
        this.activeGuardianReviews.add(reviewId)
        this.emitOptionalFacts(guardianFacts(params, report))
        return
      }
      case 'item/autoApprovalReview/completed': {
        const reviewId = readString(params, 'reviewId')
        if (reviewId === undefined) return
        this.emitOptionalFacts(guardianFacts(params, this.activeGuardianReviews.delete(reviewId) ? 'update' : 'start'))
        return
      }
      case 'warning': {
        const message = readString(params, 'message')
        if (message !== undefined) this.emit(messageChunk('agent_message_chunk', `Warning: ${message}\n\n`))
        return
      }
      case 'configWarning': {
        const summary = readString(params, 'summary') ?? ''
        const details = readString(params, 'details')
        const text = details ? `${summary}\n\n${details}` : summary
        this.emit(messageChunk('agent_message_chunk', `Config warning: ${text}\n\n`))
        return
      }
      case 'thread/compacted':
        this.emit(messageChunk('agent_message_chunk', "*Context compacted to fit the model's context window.*\n\n"))
        return
      case 'model/rerouted':
        this.emit(
          messageChunk(
            'agent_thought_chunk',
            `Model rerouted from ${readString(params, 'fromModel') ?? ''} to ${readString(params, 'toModel') ?? ''} (${readString(params, 'reason') ?? ''}).\n\n`,
          ),
        )
        return
      case 'thread/name/updated': {
        const name = readString(params, 'threadName')?.replace(/\s+/g, ' ').trim()
        this.emit({ sessionUpdate: 'session_info_update', title: name === undefined || name === '' ? null : name })
        return
      }
      default:
        return
    }
  }

  private emit(update: acp.SessionUpdate): void {
    this.sink.update(update)
  }

  private emitFacts(facts: ToolFacts): void {
    this.sink.update(renderToolCall(facts))
  }

  private emitOptionalFacts(facts: ToolFacts | undefined): void {
    if (facts !== undefined) this.emitFacts(facts)
  }

  private planUpdated(params: JsonRecord): void {
    const entries = (readArray(params, 'plan') ?? []).flatMap((step): acp.PlanEntry[] => {
      const record = asRecord(step)
      if (record === undefined) return []
      const status = readString(record, 'status')
      return [
        {
          status: status === 'inProgress' ? 'in_progress' : status === 'completed' ? 'completed' : 'pending',
          content: readString(record, 'step') ?? '',
          priority: 'medium',
        },
      ]
    })
    this.emit({ sessionUpdate: 'plan', entries })
  }

  private itemStarted(item: JsonRecord | undefined): void {
    const type = readString(item, 'type')
    const id = readString(item, 'id')
    if (item === undefined || type === undefined || id === undefined) return
    if (!Object.hasOwn(NON_MODEL_OUTPUT_ITEM_TYPES, type)) this.tokens.observeModelOutput()
    this.rememberStarted(type, id, item)
    switch (type) {
      case 'fileChange':
        this.emitFacts(fileChangeStartFacts(item, id))
        return
      case 'commandExecution':
        this.emitFacts(this.commands.started(item, id))
        return
      case 'mcpToolCall':
        this.emitFacts(mcpStartFacts(item, id))
        return
      case 'dynamicToolCall':
        this.emitFacts(dynamicToolStartFacts(item, id))
        return
      case 'webSearch':
        this.emitFacts({ ...webSearchFacts(item, id, 'start'), kind: 'search', status: 'in_progress' })
        return
      case 'imageView':
        this.emittedImageViews.add(id)
        this.emitFacts(imageViewFacts(item, id))
        return
      case 'imageGeneration':
        this.activeImageGenerations.add(id)
        this.emitFacts({
          toolCallId: id,
          report: 'start',
          kind: 'other',
          title: 'Image generation',
          status: 'in_progress',
          standard: { rawInput: { id } },
        })
        return
      case 'collabAgentToolCall':
        this.emitFacts(collabAgentFacts(item, id, 'start'))
        return
      case 'contextCompaction':
        this.emitFacts({ toolCallId: id, report: 'start', title: COMPACTION_TITLE, kind: 'think', status: 'in_progress' })
        return
      case 'subAgentActivity':
        this.activeSubagentActivities.add(id)
        this.emitFacts(subagentActivityFacts(item, id, 'in_progress', 'start'))
        return
      default:
        return
    }
  }

  private rememberStarted(type: string, id: string, item: JsonRecord): void {
    if (type === 'commandExecution') {
      this.startedCommands.add(id)
      const name = commandToolName(item['source'])
      if (name !== undefined) this.commandNames.set(id, name)
    } else if (type === 'fileChange') {
      this.fileChanges.set(id, item)
    } else if (type === 'mcpToolCall') {
      const server = readString(item, 'server') ?? ''
      const pending = this.pendingMcpApprovals.get(server)
      if (pending === undefined) this.pendingMcpApprovals.set(server, [id])
      else pending.push(id)
    }
  }

  private forgetCompleted(type: string, id: string, item: JsonRecord): void {
    if (type === 'commandExecution') {
      this.startedCommands.delete(id)
      this.commandNames.delete(id)
    } else if (type === 'fileChange') {
      this.fileChanges.delete(id)
    } else if (type === 'mcpToolCall') {
      const server = readString(item, 'server') ?? ''
      const pending = this.pendingMcpApprovals.get(server)
      if (pending === undefined) return
      const index = pending.indexOf(id)
      if (index >= 0) pending.splice(index, 1)
      if (pending.length === 0) this.pendingMcpApprovals.delete(server)
    }
  }

  private itemCompleted(item: JsonRecord | undefined): void {
    const type = readString(item, 'type')
    const id = readString(item, 'id')
    if (item === undefined || type === undefined || id === undefined) return
    this.forgetCompleted(type, id, item)
    switch (type) {
      case 'fileChange':
        this.emitFacts({ toolCallId: id, report: 'update', status: toTerminalToolStatus(item['status']) })
        return
      case 'dynamicToolCall':
        this.emitFacts(dynamicToolCompletedFacts(item, id))
        return
      case 'mcpToolCall':
        this.emitFacts(mcpCompletedFacts(item, id))
        return
      case 'commandExecution':
        this.emitFacts(this.commands.completed(item, id))
        return
      case 'imageView':
        if (!this.emittedImageViews.delete(id)) this.emitFacts(imageViewFacts(item, id))
        return
      case 'imageGeneration': {
        const active = this.activeImageGenerations.delete(id)
        this.emitFacts({
          toolCallId: id,
          report: active ? 'update' : 'start',
          ...(active ? {} : { kind: 'other' as const, title: 'Image generation' }),
          status: imageTerminalStatus(item['status']),
          result: imageGenerationResult(item),
          standard: imageGenerationStandard(item),
        })
        return
      }
      case 'reasoning': {
        if (this.seenReasoningItems.delete(id)) return
        const summary = readStringArray(item, 'summary')
        const parts = summary.length > 0 ? summary : readStringArray(item, 'content')
        const text = parts.filter((part) => part.length > 0).join('\n\n')
        if (text.length > 0) this.emit(messageChunk('agent_thought_chunk', text, id))
        return
      }
      case 'webSearch':
        this.emitFacts({ ...webSearchFacts(item, id, 'update'), status: 'completed' })
        return
      case 'collabAgentToolCall':
        this.emitFacts(collabAgentFacts(item, id, 'update'))
        return
      case 'agentMessage': {
        // codex-acp renders only the deltas; a message that never streamed would be lost, so show it whole.
        const text = readString(item, 'text')
        if (!this.streamedMessageItems.delete(id) && text !== undefined && text !== '') {
          this.emit(messageChunk('agent_message_chunk', text, id))
        }
        return
      }
      case 'plan':
        this.planCompleted(id, readString(item, 'text') ?? '')
        return
      case 'exitedReviewMode': {
        const review = (readString(item, 'review') ?? '').trim()
        if (review.length > 0) this.emit(messageChunk('agent_message_chunk', review))
        return
      }
      case 'contextCompaction':
        this.emitFacts({ toolCallId: id, report: 'update', title: COMPACTION_TITLE, status: 'completed' })
        return
      case 'subAgentActivity': {
        const report = this.activeSubagentActivities.delete(id) ? 'update' : 'start'
        this.emitFacts(subagentActivityFacts(item, id, 'completed', report))
        return
      }
      default:
        return
    }
  }

  private planCompleted(itemId: string, itemText: string): void {
    const text = itemText.length > 0 ? itemText : (this.streamedPlanText.get(itemId) ?? '')
    this.streamedPlanText.delete(itemId)
    if (text.length === 0) return
    this.completedPlan = { itemId, text }
    this.emit(messageChunk('agent_message_chunk', text, itemId))
  }
}
