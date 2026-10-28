/**
 * `/rewind` for Oh My Pi: going back to just before one of the user's messages.
 *
 * The conversation half is rpc `branch` (a new session that holds everything before the message). omp keeps no file checkpoints, so
 * the file half undoes what the agent's own file tool recorded in the session: an `edit` result carries the file before and after
 * (`oldText` / `newText`, byte for byte), newest edit first. What the records cannot prove is never touched: a `write` does not say what
 * it replaced (or whether the file existed), a rename does not say whether the new name replaced a file, `ast_edit` keeps no copy, and
 * omp prunes the copies of a very large file. A file whose current bytes are not the state the newest record left behind is a conflict
 * and is left alone, like every file with a change that cannot be reversed.
 *
 * Everything here is a function of the session entries and of an injected file system (`RestoreIo`); the requests are made by the
 * transport (`omp.ts`).
 */
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { CHECKPOINT_LABEL_LIMIT, checkpointLabel } from './checkpoint-label.ts'

type Rec = Readonly<Record<string, unknown>>

function rec(value: unknown): Rec | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Rec) : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function arr(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

/** What a `/rewind` rolls back: the files and the conversation (the default), the files only, or the conversation only. */
export type RewindMode = 'both' | 'code' | 'chat'

export type RewindRequest =
  | { readonly action: 'list' }
  | { readonly action: 'preview' | 'apply'; readonly reference: string; readonly mode: RewindMode }
  | { readonly action: 'usage'; readonly problem: string }

const USAGE_ORDER = 'Say which message first: /rewind <n> [code|chat] [confirm].'

/** `/rewind`, `/rewind <n> [code|chat]` (a preview) and `/rewind <n> [code|chat] confirm` (does it). */
export function parseRewindArgs(args: string): RewindRequest {
  const [reference, ...options] = args
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '')
  if (reference === undefined) return { action: 'list' }
  if (['confirm', 'code', 'chat'].includes(reference.toLowerCase())) return { action: 'usage', problem: USAGE_ORDER }
  let mode: RewindMode = 'both'
  let confirm = false
  for (const word of options.map((option) => option.toLowerCase())) {
    if (word === 'confirm') confirm = true
    else if (word === 'code' || word === 'chat') {
      if (mode !== 'both' && mode !== word)
        return { action: 'usage', problem: 'Choose `code` or `chat`, or neither to roll back both.' }
      mode = word
    } else return { action: 'usage', problem: `Unexpected "${word}".` }
  }
  return { action: confirm ? 'apply' : 'preview', reference, mode }
}

// ---------------------------------------------------------------------------
// The conversation as the session records it
// ---------------------------------------------------------------------------

/** A user message of the current conversation: `rpc branch` goes back to just before it. */
export interface OmpCheckpoint {
  readonly entryId: string
  /** What the user wrote, without the context DSH generates around it. */
  readonly label: string
  readonly at: string | undefined
  /** Where the message sits on the conversation's path; everything the agent did for it comes after. */
  readonly index: number
}

/** A file change the records can describe: the whole file before and after (`null`: no file). */
export interface OmpSetChange {
  readonly kind: 'set'
  readonly index: number
  readonly path: string
  readonly before: string | null
  readonly after: string | null
}

/** A file change the records cannot reverse, and why. */
export interface OmpOpaqueChange {
  readonly kind: 'opaque'
  readonly index: number
  readonly path: string
  readonly reason: string
}

export type OmpFileChange = OmpSetChange | OmpOpaqueChange

export interface OmpRewindModel {
  readonly checkpoints: readonly OmpCheckpoint[]
  /** Oldest first. */
  readonly changes: readonly OmpFileChange[]
  /** Shell commands, subagent runs and other calls that may have changed files in ways omp does not record. */
  readonly unrecorded: readonly { readonly index: number; readonly tool: string }[]
}

/** The calls whose effects on the files omp does not record. */
const UNRECORDED_TOOLS: Readonly<Record<string, true>> = {
  bash: true,
  eval: true,
  task: true,
  lsp: true,
  github: true,
  ssh: true,
}

const OPAQUE_WRITE = 'was written with `write`, which does not record what it replaced'
const OPAQUE_RENAME = 'was renamed with `edit`, which does not record whether the new name replaced a file'
const OPAQUE_AST = 'was rewritten with `ast_edit`, which keeps no copy of the file'
const OPAQUE_PRUNED = 'is too large for omp to have kept a copy of it'
const OPAQUE_NO_COPY = 'was edited, but the record holds no copy of the file'

/** The text of a user message: its text blocks, joined the way omp's branch picker does; empty for a message without any. */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  return (arr(content) ?? []).map((block) => str(rec(block)?.['text']) ?? '').join('')
}

function opaque(index: number, path: string, reason: string): OmpOpaqueChange {
  return { kind: 'opaque', index, path, reason }
}

/** The changes of one `edit` result: one file, or every file of a multi-file edit. */
function editChanges(details: Rec, index: number, cwd: string): OmpFileChange[] {
  const files: readonly Rec[] = arr(details['perFileResults'])?.flatMap((file): Rec[] => {
    const record = rec(file)
    return record === undefined ? [] : [record]
  }) ?? [details]
  const out: OmpFileChange[] = []
  for (const file of files) {
    const raw = str(file['path'])
    if (file['isError'] === true || raw === undefined) continue
    const path = resolve(cwd, raw)
    const moved = str(file['move'])
    const source = str(file['sourcePath'])
    if (moved !== undefined || source !== undefined) {
      for (const involved of new Set([
        path,
        ...(moved === undefined ? [] : [resolve(cwd, moved)]),
        ...(source === undefined ? [] : [resolve(cwd, source)]),
      ])) {
        out.push(opaque(index, involved, OPAQUE_RENAME))
      }
      continue
    }
    if (file['snapshotsPruned'] === true) {
      out.push(opaque(index, path, OPAQUE_PRUNED))
      continue
    }
    const before = file['oldText']
    const after = file['newText']
    const op = str(file['op'])
    if (op === 'delete' && typeof before === 'string') out.push({ kind: 'set', index, path, before, after: null })
    else if (op === 'create' && typeof after === 'string') out.push({ kind: 'set', index, path, before: null, after })
    else if (op !== 'delete' && op !== 'create' && typeof before === 'string' && typeof after === 'string')
      out.push({ kind: 'set', index, path, before, after })
    else out.push(opaque(index, path, OPAQUE_NO_COPY))
  }
  return out
}

/** The files an applied `ast_edit` rewrote (staged previews change nothing); it may arrive as the result of the `xd://resolve` write. */
function astEditChanges(details: Rec, index: number, cwd: string): OmpFileChange[] | undefined {
  const files = arr(details['files'])
  if (details['applied'] !== true || files === undefined) return undefined
  return files.flatMap((file) => (typeof file === 'string' ? [opaque(index, resolve(cwd, file), OPAQUE_AST)] : []))
}

/** A plain `write`; the scheme writes (`xd://`, `local://`, …) are not files of the workspace. */
function writeChanges(
  details: Rec,
  call: { readonly args: Rec | undefined } | undefined,
  index: number,
): OmpFileChange[] {
  const target = str(call?.args?.['path'])
  if (target !== undefined && /^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return []
  const path = str(details['resolvedPath'])
  return path === undefined ? [] : [opaque(index, path, OPAQUE_WRITE)]
}

/**
 * Reads the conversation out of `get_entries`: the entries on the path from the root to `leafId` (a session that was navigated holds
 * other branches too), in order. `leafId` is `null` for an empty session and `undefined` when the answer did not say.
 */
export function readRewindModel(input: {
  readonly entries: readonly unknown[]
  readonly leafId: string | null | undefined
  readonly cwd: string
}): OmpRewindModel {
  const byId = new Map<string, Rec>()
  let last: string | undefined
  for (const raw of input.entries) {
    const entry = rec(raw)
    const id = str(entry?.['id'])
    if (entry === undefined || id === undefined) continue
    byId.set(id, entry)
    last = id
  }
  const path: Rec[] = []
  const seen = new Set<string>()
  let cursor = input.leafId === undefined ? last : (input.leafId ?? undefined)
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor)
    const entry = byId.get(cursor)
    if (entry === undefined) break
    path.push(entry)
    cursor = str(entry['parentId'])
  }
  path.reverse()

  const checkpoints: OmpCheckpoint[] = []
  const changes: OmpFileChange[] = []
  const unrecorded: { index: number; tool: string }[] = []
  const calls = new Map<string, { readonly args: Rec | undefined }>()
  for (const [index, entry] of path.entries()) {
    const message = str(entry['type']) === 'message' ? rec(entry['message']) : undefined
    if (message === undefined) continue
    switch (str(message['role'])) {
      case 'user': {
        const entryId = str(entry['id'])
        if (entryId === undefined || messageText(message['content']) === '') break
        checkpoints.push({ entryId, label: checkpointLabel(message['content']), at: str(entry['timestamp']), index })
        break
      }
      case 'assistant':
        for (const block of arr(message['content']) ?? []) {
          const call = rec(block)
          const id = str(call?.['id'])
          if (str(call?.['type']) === 'toolCall' && id !== undefined) calls.set(id, { args: rec(call?.['arguments']) })
        }
        break
      case 'bashExecution':
        unrecorded.push({ index, tool: 'bash' })
        break
      case 'toolResult': {
        const tool = str(message['toolName'])
        const details = rec(message['details'])
        if (message['isError'] !== true && details !== undefined) {
          const rewritten = astEditChanges(details, index, input.cwd)
          if (rewritten !== undefined) changes.push(...rewritten)
          else if (tool === 'edit') changes.push(...editChanges(details, index, input.cwd))
          else if (tool === 'write')
            changes.push(...writeChanges(details, calls.get(str(message['toolCallId']) ?? ''), index))
        }
        if (tool !== undefined && (Object.hasOwn(UNRECORDED_TOOLS, tool) || tool.startsWith('mcp__')))
          unrecorded.push({ index, tool })
        break
      }
    }
  }
  return { checkpoints, changes, unrecorded }
}

/** A checkpoint by its number in the list (`3` or `#3`, 1-based); the list shows no ids, so a number is the only way to name one. */
export function findCheckpoint(
  checkpoints: readonly OmpCheckpoint[],
  reference: string,
): { readonly checkpoint: OmpCheckpoint; readonly position: number } | { readonly error: string } {
  const digits = /^#?(\d+)$/.exec(reference.trim())?.[1]
  if (digits === undefined) return { error: `"${reference}" is not a message number. \`/rewind\` lists them.` }
  const position = Number(digits)
  const checkpoint = checkpoints[position - 1]
  return checkpoint === undefined
    ? { error: `There is no message ${position}. \`/rewind\` lists ${checkpoints.length}.` }
    : { checkpoint, position }
}

// ---------------------------------------------------------------------------
// The file system the restore reads and writes
// ---------------------------------------------------------------------------

export type DiskFile =
  | { readonly kind: 'absent' }
  | { readonly kind: 'text'; readonly content: string }
  /** Something the restore must not touch, and why. */
  | { readonly kind: 'unreadable'; readonly reason: string }

export interface RestoreIo {
  read(path: string): Promise<DiskFile>
  /** Writes the file, creating the directories it needs. */
  write(path: string, content: string): Promise<void>
  remove(path: string): Promise<void>
}

/** The biggest file a restore reads. */
const MAX_FILE_BYTES = 10 * 1024 * 1024

/** `path` below or at `root`. */
function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** The place `path` really is: the real path of its nearest existing ancestor, followed by the part that does not exist yet. */
async function realLocation(path: string): Promise<string> {
  const missing: string[] = []
  let probe = resolve(path)
  for (;;) {
    try {
      return join(await realpath(probe), ...missing.toReversed())
    } catch {
      const parent = dirname(probe)
      if (parent === probe) return resolve(path)
      missing.push(basename(probe))
      probe = parent
    }
  }
}

/** The real file system, limited to `roots` (the directories of the session): a path that leads out of them, by name or through a link, is never read or written. */
export function nodeRestoreIo(roots: readonly string[]): RestoreIo {
  let realRoots: Promise<string[]> | undefined
  const allowed = async (path: string): Promise<boolean> => {
    realRoots ??= Promise.all(roots.map((root) => realLocation(root)))
    const location = await realLocation(path)
    return (await realRoots).some((root) => within(root, location))
  }
  return {
    async read(path) {
      if (!isAbsolute(path) || !(await allowed(path)))
        return { kind: 'unreadable', reason: 'is outside the directories of this session' }
      let info
      try {
        info = await lstat(path)
      } catch (error: unknown) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
          return { kind: 'absent' }
        return { kind: 'unreadable', reason: `cannot be read (${describe(error)})` }
      }
      if (info.isSymbolicLink()) return { kind: 'unreadable', reason: 'is a symbolic link' }
      if (!info.isFile()) return { kind: 'unreadable', reason: 'is not a regular file' }
      if (info.size > MAX_FILE_BYTES) return { kind: 'unreadable', reason: 'is too large to compare' }
      const bytes = await readFile(path)
      try {
        const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        return content.includes('\0') ? { kind: 'unreadable', reason: 'is a binary file' } : { kind: 'text', content }
      } catch {
        return { kind: 'unreadable', reason: 'is not valid UTF-8 text' }
      }
    },
    async write(path, content) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content)
    },
    async remove(path) {
      await rm(path, { force: true })
    },
  }
}

// ---------------------------------------------------------------------------
// The restore plan
// ---------------------------------------------------------------------------

export interface PlannedFile {
  readonly path: string
  /** `create`: the file is back after the agent deleted it; `write`: its content changes; `delete`: the agent created it. */
  readonly action: 'create' | 'write' | 'delete'
  readonly content: string | undefined
  readonly insertions: number
  readonly deletions: number
}

export interface RestoreConflict {
  readonly path: string
  readonly reason: string
}

export interface RestorePlan {
  /** The files the restore writes or removes, by path. */
  readonly files: readonly PlannedFile[]
  /** The files the changes touched that already are as they were before. */
  readonly unchanged: readonly string[]
  /** The files that are left alone, and why. */
  readonly conflicts: readonly RestoreConflict[]
}

function lines(text: string): string[] {
  if (text === '') return []
  const parts = text.replace(/\r\n/g, '\n').split('\n')
  if (parts.at(-1) === '') parts.pop()
  return parts
}

/** Lines that are in `after` and not in `before` (insertions) and the other way round (deletions), counted as a multiset. */
function lineDelta(before: string, after: string): { readonly insertions: number; readonly deletions: number } {
  const counts = new Map<string, number>()
  for (const line of lines(before)) counts.set(line, (counts.get(line) ?? 0) + 1)
  let insertions = 0
  for (const line of lines(after)) {
    const left = counts.get(line) ?? 0
    if (left > 0) counts.set(line, left - 1)
    else insertions += 1
  }
  let deletions = 0
  for (const left of counts.values()) deletions += left
  return { insertions, deletions }
}

function changedSince(change: OmpSetChange): string {
  if (change.after === null) return 'exists again after the agent deleted it'
  return change.before === null ? 'changed since the agent created it' : 'changed since the agent edited it'
}

const CHANGED_BETWEEN = "was changed between two of the agent's edits by something other than its file tools"

/**
 * What undoing `changes` (oldest first) would do to the files on disk. Per file, newest first, each undo is checked against the state
 * the previous one left, so several edits of one file, or a file that was created and then edited, come out right. A file whose state
 * does not match what a record says, and a file with a change nothing can reverse, are conflicts and no part of the plan.
 */
export async function planRestore(changes: readonly OmpFileChange[], io: RestoreIo): Promise<RestorePlan> {
  const byPath = new Map<string, OmpFileChange[]>()
  for (const change of changes) byPath.set(change.path, [...(byPath.get(change.path) ?? []), change])

  const files: PlannedFile[] = []
  const unchanged: string[] = []
  const conflicts: RestoreConflict[] = []
  for (const [path, list] of byPath) {
    const newestOpaque = list.findLast((change) => change.kind === 'opaque')
    if (newestOpaque !== undefined) {
      conflicts.push({ path, reason: newestOpaque.reason })
      continue
    }
    const oldest = list[0]
    if (oldest?.kind !== 'set') continue
    const disk = await io.read(path)
    if (disk.kind === 'unreadable') {
      conflicts.push({ path, reason: disk.reason })
      continue
    }
    const current = disk.kind === 'absent' ? null : disk.content
    // The edit may have been undone by hand.
    if (current === oldest.before) {
      unchanged.push(path)
      continue
    }
    let state = current
    let reason: string | undefined
    for (const [step, change] of list.toReversed().entries()) {
      if (change.kind !== 'set') continue
      if (state !== change.after) {
        reason = step === 0 ? changedSince(change) : CHANGED_BETWEEN
        break
      }
      state = change.before
    }
    if (reason !== undefined) {
      conflicts.push({ path, reason })
      continue
    }
    files.push({
      path,
      action: current === null ? 'create' : state === null ? 'delete' : 'write',
      content: state ?? undefined,
      ...lineDelta(current ?? '', state ?? ''),
    })
  }
  files.sort((left, right) => left.path.localeCompare(right.path))
  unchanged.sort()
  conflicts.sort((left, right) => left.path.localeCompare(right.path))
  return { files, unchanged, conflicts }
}

export interface RestoreResult {
  readonly restored: readonly PlannedFile[]
  readonly failed: readonly RestoreConflict[]
}

/** Carries out a plan; a file that cannot be written is reported and does not stop the others. */
export async function applyRestore(plan: RestorePlan, io: RestoreIo): Promise<RestoreResult> {
  const restored: PlannedFile[] = []
  const failed: RestoreConflict[] = []
  for (const file of plan.files) {
    try {
      if (file.action === 'delete') await io.remove(file.path)
      else await io.write(file.path, file.content ?? '')
      restored.push(file)
    } catch (error: unknown) {
      failed.push({ path: file.path, reason: `could not be written (${describe(error)})` })
    }
  }
  return { restored, failed }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** One line of `value`: whitespace collapsed, cut to `limit` characters. */
function clip(value: string, limit: number): string {
  const line = value.replace(/\s+/g, ' ').trim()
  return line.length <= limit ? line : `${line.slice(0, limit - 1).trimEnd()}…`
}

/** Inline code that survives backticks inside the value. */
function inlineCode(value: string): string {
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length))
  const fence = '`'.repeat(longest + 1)
  return longest > 0 ? `${fence} ${value} ${fence}` : `${fence}${value}${fence}`
}

/** Local `YYYY-MM-DD HH:MM` of an ISO timestamp; the input unchanged when it is not a date. */
function clock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const two = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}

/** A path as the user should see it: relative to the session directory when inside it. */
export function shownPath(cwd: string, path: string): string {
  const shown = relative(cwd, path)
  return shown === '' || shown.startsWith('..') || isAbsolute(shown) ? path : shown
}

const CHECKPOINTS_LISTED = 20
const FILES_LISTED = 40

export function renderCheckpoints(checkpoints: readonly OmpCheckpoint[]): string {
  if (checkpoints.length === 0) return 'There are no messages in the current Oh My Pi conversation yet.'
  const first = Math.max(0, checkpoints.length - CHECKPOINTS_LISTED)
  const rows = checkpoints
    .slice(first)
    .map(
      (checkpoint, index) =>
        `| ${first + index + 1} | ${clip(checkpoint.label, CHECKPOINT_LABEL_LIMIT).replace(/\|/g, '\\|')} | ${checkpoint.at === undefined ? '' : clock(checkpoint.at)} |`,
    )
  return [
    `**Rewind points** — ${checkpoints.length} message${checkpoints.length === 1 ? '' : 's'} in this conversation${first > 0 ? `, the last ${CHECKPOINTS_LISTED} shown` : ''}`,
    '',
    '| # | Message | Sent |',
    '|---:|---|---|',
    ...rows,
    '',
    '`/rewind <n>` previews going back to just before message *n*; `/rewind <n> confirm` restores the files Oh My Pi changed since then and rolls the conversation back (`code`: files only, `chat`: conversation only).',
  ].join('\n')
}

/** "message 3", or "message 3 and the 2 messages after it". */
function messageSpan(position: number, total: number): string {
  const later = total - position
  return later === 0
    ? `message ${position}`
    : `message ${position} and the ${later === 1 ? '1 message' : `${later} messages`} after it`
}

/** "3 files (+10 −2)". */
function fileCount(files: readonly PlannedFile[]): string {
  const insertions = files.reduce((sum, file) => sum + file.insertions, 0)
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0)
  return `${files.length} file${files.length === 1 ? '' : 's'} (+${insertions} −${deletions})`
}

/** What `/rewind` tells about the message it goes back to; `mode` is what the user asked to roll back. */
export interface RewindPoint {
  readonly checkpoint: OmpCheckpoint
  readonly position: number
  /** How many messages the conversation has. */
  readonly total: number
  readonly mode: RewindMode
  /** A path as the user should see it (relative to the session directory when inside it). */
  readonly display: (path: string) => string
  /** The shell commands, subagent runs and other calls after the message whose effects omp does not record. */
  readonly unrecorded: number
}

const REWIND_LIMITS =
  'The messages stay visible in this DSH conversation (its log is append-only). Shell-command side effects are never undone; only files Oh My Pi changed through its file tools are restored.'

function fileLine(file: PlannedFile, display: (path: string) => string): string {
  const what =
    file.action === 'delete'
      ? `removed (−${file.deletions})`
      : file.action === 'create'
        ? `back (+${file.insertions})`
        : `+${file.insertions} −${file.deletions}`
  return `  - ${inlineCode(display(file.path))} — ${what}`
}

function conflictLines(
  conflicts: readonly RestoreConflict[],
  display: (path: string) => string,
  intro: string,
): string[] {
  if (conflicts.length === 0) return []
  return [
    `- **${intro}**`,
    ...conflicts
      .slice(0, FILES_LISTED)
      .map((conflict) => `  - ${inlineCode(display(conflict.path))} — ${conflict.reason}`),
    ...(conflicts.length > FILES_LISTED ? [`  - …and ${conflicts.length - FILES_LISTED} more`] : []),
  ]
}

function unrecordedLine(count: number): string[] {
  if (count === 0) return []
  return [
    `- ${count} shell command${count === 1 ? '' : 's'}, subagent run${count === 1 ? '' : 's'} or other call${count === 1 ? '' : 's'} came after this message; what ${count === 1 ? 'it' : 'they'} changed is not undone.`,
  ]
}

/** The "Files" bullets of a preview. */
function planLines(plan: RestorePlan, display: (path: string) => string): string[] {
  const out: string[] = []
  if (plan.files.length > 0) {
    out.push(
      `- **Files:** ${fileCount(plan.files)} would be restored:`,
      ...plan.files.slice(0, FILES_LISTED).map((file) => fileLine(file, display)),
      ...(plan.files.length > FILES_LISTED ? [`  - …and ${plan.files.length - FILES_LISTED} more`] : []),
    )
  }
  out.push(...conflictLines(plan.conflicts, display, 'Files that cannot be restored (they are left as they are):'))
  if (plan.unchanged.length > 0)
    out.push(
      `- **Files:** ${plan.unchanged.length} already ${plan.unchanged.length === 1 ? 'is' : 'are'} as before that message.`,
    )
  if (out.length === 0)
    out.push("- **Files:** nothing to restore; no file changed through Oh My Pi's file tools after this message.")
  return out
}

export function renderRewindPreview(point: RewindPoint & { readonly plan: RestorePlan | undefined }): string {
  const { checkpoint, position, total, mode, plan, display } = point
  const out = [
    `**Rewind to just before message ${position}** (${inlineCode(clip(checkpoint.label, CHECKPOINT_LABEL_LIMIT))})`,
    '',
  ]
  if (mode !== 'code')
    out.push(
      `- **Conversation:** Oh My Pi would forget ${messageSpan(position, total)}; it continues in a new session branched from the messages before.`,
    )
  if (plan !== undefined) out.push(...planLines(plan, display))
  if (mode !== 'chat') out.push(...unrecordedLine(point.unrecorded))
  out.push('')
  const confirm = (words: string): string => `\`/rewind ${position}${words} confirm\``
  if (mode === 'both') {
    out.push(
      `Run ${confirm('')} to do both, ${confirm(' code')} to restore the files only, or ${confirm(' chat')} to roll the conversation back only.`,
    )
  } else if (mode === 'code') {
    out.push(`Run ${confirm(' code')} to restore the files. The conversation stays as it is.`)
  } else out.push(`Run ${confirm(' chat')} to roll the conversation back. The files stay as they are.`)
  out.push('', REWIND_LIMITS)
  return out.join('\n')
}

/** What `/rewind … confirm` did: the files it restored (none when it did not touch them) and whether the conversation went back. */
export interface RewindOutcome extends RewindPoint {
  readonly restore: RestoreResult | undefined
  readonly plan: RestorePlan | undefined
  readonly rolledBack: boolean
  /** Why the conversation did not go back, when it was asked to. */
  readonly rollbackError: string | undefined
}

export function renderRewindResult(outcome: RewindOutcome): string {
  const { checkpoint, position, total, mode, restore, plan, rolledBack, rollbackError, display } = outcome
  const label = `message ${position} (${inlineCode(clip(checkpoint.label, CHECKPOINT_LABEL_LIMIT))})`
  const head =
    mode === 'code'
      ? `Restored the files to how they were before ${label}.`
      : mode === 'chat'
        ? `Rolled the conversation back to just before ${label}.`
        : `Rewound to just before ${label}.`
  const out = [rollbackError !== undefined ? `Could not rewind to just before ${label}.` : head, '']
  if (mode !== 'chat' && plan !== undefined && restore !== undefined) {
    const notRestored = [...plan.conflicts, ...restore.failed]
    if (restore.restored.length > 0) out.push(`- **Files:** restored ${fileCount(restore.restored)}.`)
    else if (notRestored.length === 0 && plan.files.length === 0) {
      out.push(
        plan.unchanged.length > 0
          ? `- **Files:** ${plan.unchanged.length} already ${plan.unchanged.length === 1 ? 'is' : 'are'} as before that message.`
          : "- **Files:** nothing to restore; no file changed through Oh My Pi's file tools after this message.",
      )
    }
    out.push(...conflictLines(notRestored, display, 'Files that were not restored (they are left as they are):'))
    out.push(...unrecordedLine(outcome.unrecorded))
  }
  if (rolledBack) out.push(`- **Conversation:** Oh My Pi no longer remembers ${messageSpan(position, total)}.`)
  if (rollbackError !== undefined) out.push(`- **Conversation:** not rolled back — ${rollbackError}`)
  out.push('')
  if (!rolledBack && mode !== 'chat' && rollbackError !== undefined) {
    out.push(
      'The conversation was not rolled back: Oh My Pi still remembers the later work, so tell it the files changed back.',
    )
  }
  out.push(REWIND_LIMITS)
  return out.join('\n')
}
