/**
 * `/rewind` for Codex: going back to just before one of the user's messages.
 *
 * The conversation half is `thread/revert` (history only: "it does not revert local file changes"). Codex keeps no file checkpoints, so
 * the file half undoes what the agent's own file tool recorded: every completed `fileChange` item after the message (an `add` holds the
 * new content, a `delete` the removed content, an `update` a unified diff), newest first. A file whose current bytes do not match the
 * state the record leaves behind is a conflict and is left alone, together with every file it was moved to or from.
 *
 * Everything here is a function of the app-server's answers and of an injected file system (`RestoreIo`); the requests are made by
 * the transport (`codex.ts`).
 */
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { CHECKPOINT_LABEL_LIMIT, checkpointLabel } from './checkpoint-label.ts'
import { asRecord, messageOf, readArray, readNumber, readString, type JsonRecord } from './codex-json.ts'

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
  const [reference, ...options] = args.trim().split(/\s+/).filter((word) => word !== '')
  if (reference === undefined) return { action: 'list' }
  if (['confirm', 'code', 'chat'].includes(reference.toLowerCase())) return { action: 'usage', problem: USAGE_ORDER }
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
// The turns of the conversation (`thread/turns/list`)
// ---------------------------------------------------------------------------

export interface CodexTurn {
  readonly id: string
  /** When the turn started (ISO), when Codex says. */
  readonly startedAt: string | undefined
  /** The blocks of the user message the turn began with; `undefined` for a turn the user did not write (a shell command, a compaction, a goal). */
  readonly message: readonly unknown[] | undefined
  /** The items the listing carried: the first user message and the last answer with the `summary` view, all of them with `full`. */
  readonly items: readonly JsonRecord[]
}

/** One page of `thread/turns/list`. */
export function parseTurnPage(response: unknown): { readonly turns: CodexTurn[]; readonly nextCursor: string | undefined } {
  const page = asRecord(response)
  const turns = (readArray(page, 'data') ?? []).flatMap((entry): CodexTurn[] => {
    const record = asRecord(entry)
    const id = readString(record, 'id')
    if (record === undefined || id === undefined) return []
    const items = (readArray(record, 'items') ?? []).flatMap((item): JsonRecord[] => {
      const parsed = asRecord(item)
      return parsed === undefined ? [] : [parsed]
    })
    const first = items[0]
    const startedAt = readNumber(record, 'startedAt')
    return [
      {
        id,
        startedAt: startedAt === undefined ? undefined : new Date(startedAt * 1000).toISOString(),
        message: first !== undefined && readString(first, 'type') === 'userMessage' ? (readArray(first, 'content') ?? []) : undefined,
        items,
      },
    ]
  })
  return { turns, nextCursor: readString(page, 'nextCursor') }
}

/** A user message of the conversation: the point `/rewind` can go back to (just before it). */
export interface CodexCheckpoint {
  readonly turnId: string
  /** The message as the user wrote it, one short line. */
  readonly label: string
  readonly at: string | undefined
  /** Where its turn sits among all the turns of the conversation, oldest first. */
  readonly turnIndex: number
}

/** The turns that began with a user message, oldest first; the first of them is message 1. */
export function checkpointsOf(turns: readonly CodexTurn[]): CodexCheckpoint[] {
  return turns.flatMap((turn, turnIndex): CodexCheckpoint[] =>
    turn.message === undefined ? [] : [{ turnId: turn.id, label: checkpointLabel(turn.message), at: turn.startedAt, turnIndex }],
  )
}

/** A message by its position in the list (1-based, `#3` too) or a unique prefix of its turn id (six characters at least). */
export function findCheckpoint(
  checkpoints: readonly CodexCheckpoint[],
  reference: string,
): { readonly checkpoint: CodexCheckpoint; readonly position: number } | { readonly error: string } {
  const wanted = reference.trim().toLowerCase().replace(/^#/, '')
  // Turn ids are UUIDs and may start with digits: only a short run of digits is a position.
  if (/^\d{1,5}$/.test(wanted)) {
    const position = Number(wanted)
    const checkpoint = checkpoints[position - 1]
    return checkpoint === undefined
      ? { error: `There is no message ${position}. /rewind lists ${checkpoints.length}.` }
      : { checkpoint, position }
  }
  const matches = checkpoints.flatMap((checkpoint, index) =>
    wanted.length >= 6 && checkpoint.turnId.toLowerCase().startsWith(wanted) ? [{ checkpoint, position: index + 1 }] : [],
  )
  const [only] = matches
  if (matches.length === 1 && only !== undefined) return only
  return { error: matches.length > 1 ? `"${reference}" matches several messages; use the number from /rewind.` : `No message matches "${reference}". /rewind lists them.` }
}

// ---------------------------------------------------------------------------
// What the agent changed (`fileChange` items)
// ---------------------------------------------------------------------------

export interface FileChange {
  readonly path: string
  readonly kind: 'add' | 'delete' | 'update'
  /** `add`/`delete`: the whole content. `update`: the unified diff. */
  readonly diff: string
  /** `update` only: where the file went. */
  readonly movePath: string | undefined
}

/** Codex appends this to the diff of an update that moved the file. */
function withoutMoveTrailer(diff: string, movePath: string | undefined): string {
  if (movePath === undefined) return diff
  const trailer = `\n\nMoved to: ${movePath}`
  return diff.endsWith(trailer) ? diff.slice(0, -trailer.length) : diff
}

/** The file changes the turns recorded and the app-server applied, oldest first; `unsupported` counts the changes of a kind this version does not know. */
export function fileChangesOf(turns: readonly CodexTurn[]): { readonly changes: FileChange[]; readonly unsupported: number } {
  const changes: FileChange[] = []
  let unsupported = 0
  for (const turn of turns) {
    for (const item of turn.items) {
      // A declined or failed patch changed nothing that is worth undoing.
      if (readString(item, 'type') !== 'fileChange' || readString(item, 'status') !== 'completed') continue
      for (const entry of readArray(item, 'changes') ?? []) {
        const change = asRecord(entry)
        const path = readString(change, 'path')
        const kind = asRecord(change?.['kind'])
        const type = readString(kind, 'type')
        if (change === undefined || path === undefined) continue
        const diff = readString(change, 'diff') ?? ''
        if (type === 'add' || type === 'delete') changes.push({ path, kind: type, diff, movePath: undefined })
        else if (type === 'update') {
          const movePath = readString(kind, 'move_path')
          changes.push({ path, kind: 'update', diff: withoutMoveTrailer(diff, movePath), movePath })
        } else unsupported += 1
      }
    }
  }
  return { changes, unsupported }
}

// ---------------------------------------------------------------------------
// Unified diffs, applied backwards
// ---------------------------------------------------------------------------

interface HunkLine {
  readonly op: ' ' | '+' | '-'
  readonly text: string
}

interface Hunk {
  readonly oldStart: number
  readonly oldCount: number
  readonly newStart: number
  readonly newCount: number
  readonly lines: readonly HunkLine[]
  /** `\ No newline at end of file` followed the last line of that side. */
  readonly oldNoEol: boolean
  readonly newNoEol: boolean
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** The hunks of a unified diff (none for a diff that has none); `undefined` when a hunk is malformed. */
export function parseHunks(diff: string): Hunk[] | undefined {
  const rows = diff.split('\n')
  const hunks: Hunk[] = []
  let index = 0
  while (index < rows.length) {
    const header = HUNK_HEADER.exec(rows[index] ?? '')
    index += 1
    // File headers and the blank tail are not part of any hunk.
    if (header === null) continue
    const oldCount = header[2] === undefined ? 1 : Number(header[2])
    const newCount = header[4] === undefined ? 1 : Number(header[4])
    const lines: HunkLine[] = []
    let oldSeen = 0
    let newSeen = 0
    let oldNoEol = false
    let newNoEol = false
    while (index < rows.length) {
      const row = rows[index] ?? ''
      if (row.startsWith('\\')) {
        const previous = lines.at(-1)
        if (previous === undefined) return undefined
        if (previous.op !== '+') oldNoEol = true
        if (previous.op !== '-') newNoEol = true
        index += 1
        continue
      }
      if (oldSeen >= oldCount && newSeen >= newCount) break
      index += 1
      // A context line that is empty lost its single space on the way.
      const op = row === '' ? ' ' : row[0]
      const text = row.slice(1)
      if (op === ' ') {
        lines.push({ op, text })
        oldSeen += 1
        newSeen += 1
      } else if (op === '-') {
        lines.push({ op, text })
        oldSeen += 1
      } else if (op === '+') {
        lines.push({ op, text })
        newSeen += 1
      } else return undefined
    }
    if (oldSeen !== oldCount || newSeen !== newCount) return undefined
    hunks.push({ oldStart: Number(header[1]), oldCount, newStart: Number(header[3]), newCount, lines, oldNoEol, newNoEol })
  }
  return hunks
}

/** A file as lines, and whether its last line ends with a newline. */
interface TextLines {
  readonly lines: readonly string[]
  readonly eol: boolean
}

function splitText(content: string): TextLines {
  if (content === '') return { lines: [], eol: true }
  const lines = content.split('\n')
  const eol = content.endsWith('\n')
  if (eol) lines.pop()
  return { lines, eol }
}

const joinText = (text: TextLines): string => (text.lines.length === 0 ? '' : text.lines.join('\n') + (text.eol ? '\n' : ''))

/**
 * Replaces, in every hunk, the text of one side by the text of the other: `from: 'new'` undoes the diff, `from: 'old'` redoes it (and
 * succeeding means the file is already in the state before the diff). Each hunk must be found exactly where the diff says, or else at one
 * and only one place after the previous hunk; `undefined` when a hunk is nowhere or in several places.
 */
function replaceHunks(text: TextLines, hunks: readonly Hunk[], from: 'new' | 'old'): TextLines | undefined {
  const out: string[] = []
  let consumed = 0
  let eol = text.eol
  for (const hunk of hunks) {
    const matchOps = from === 'new' ? ' +' : ' -'
    const replaceOps = from === 'new' ? ' -' : ' +'
    const match = hunk.lines.filter((line) => matchOps.includes(line.op)).map((line) => line.text)
    const replace = hunk.lines.filter((line) => replaceOps.includes(line.op)).map((line) => line.text)
    const matchNoEol = from === 'new' ? hunk.newNoEol : hunk.oldNoEol
    const replaceNoEol = from === 'new' ? hunk.oldNoEol : hunk.newNoEol
    const start = from === 'new' ? hunk.newStart : hunk.oldStart
    const count = from === 'new' ? hunk.newCount : hunk.oldCount
    // A side with no lines is placed after the line the header names.
    const expected = count === 0 ? start : start - 1
    const fits = (at: number): boolean => {
      if (at < consumed || at < 0 || at + match.length > text.lines.length) return false
      if (!match.every((line, offset) => text.lines[at + offset] === line)) return false
      // A hunk that reaches the end of the file also says whether the file ends with a newline.
      return at + match.length < text.lines.length || match.length === 0 || text.eol === !matchNoEol
    }
    let at = expected
    if (!fits(at)) {
      const found: number[] = []
      for (let candidate = consumed; candidate + match.length <= text.lines.length; candidate += 1) if (fits(candidate)) found.push(candidate)
      const [only] = found
      if (found.length !== 1 || only === undefined) return undefined
      at = only
    }
    out.push(...text.lines.slice(consumed, at), ...replace)
    consumed = at + match.length
    if (consumed === text.lines.length) eol = !replaceNoEol
  }
  out.push(...text.lines.slice(consumed))
  return { lines: out, eol }
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

const OUTSIDE_SESSION = 'is outside the directories of this session'

/** The real file system, limited to `roots` (the directories of the session): a path that leads out of them, by name or through a link, is never read or written. */
export function nodeRestoreIo(roots: readonly string[]): RestoreIo {
  let realRoots: Promise<string[]> | undefined
  /**
   * `path` normalized, when it lies inside the session. Only this form is handed to the file system: a `..` that follows a link means
   * something else to the file system than to a check made on the name, so the name checked is the name used.
   */
  const inside = async (path: string): Promise<string | undefined> => {
    if (!isAbsolute(path)) return undefined
    const target = resolve(path)
    realRoots ??= Promise.all(roots.map((root) => realLocation(root)))
    const location = await realLocation(target)
    return (await realRoots).some((root) => within(root, location)) ? target : undefined
  }
  return {
    async read(path) {
      const target = await inside(path)
      if (target === undefined) return { kind: 'unreadable', reason: OUTSIDE_SESSION }
      let info
      try {
        info = await lstat(target)
      } catch (error: unknown) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return { kind: 'absent' }
        return { kind: 'unreadable', reason: `cannot be read (${messageOf(error)})` }
      }
      if (info.isSymbolicLink()) return { kind: 'unreadable', reason: 'is a symbolic link' }
      if (!info.isFile()) return { kind: 'unreadable', reason: 'is not a regular file' }
      if (info.size > MAX_FILE_BYTES) return { kind: 'unreadable', reason: 'is too large to compare' }
      const bytes = await readFile(target)
      try {
        const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        return content.includes('\0') ? { kind: 'unreadable', reason: 'is a binary file' } : { kind: 'text', content }
      } catch {
        return { kind: 'unreadable', reason: 'is not valid UTF-8 text' }
      }
    },
    async write(path, content) {
      const target = await inside(path)
      if (target === undefined) throw new Error(OUTSIDE_SESSION)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content)
    },
    async remove(path) {
      const target = await inside(path)
      if (target === undefined) throw new Error(OUTSIDE_SESSION)
      await rm(target, { force: true })
    },
  }
}

// ---------------------------------------------------------------------------
// The restore plan
// ---------------------------------------------------------------------------

export interface PlannedFile {
  readonly path: string
  /** `create`: the file is back after the agent deleted it (or moved it away); `write`: its content changes; `delete`: the agent created it. */
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
  /** The files (with the others they are tied to by a move) that are left alone, and why. */
  readonly conflicts: readonly RestoreConflict[]
  /** File changes of a kind this version does not know. */
  readonly unsupported: number
}

/** Lines that are in `after` and not in `before` (insertions) and the other way round (deletions), counted as a multiset. */
function lineDelta(before: string, after: string): { readonly insertions: number; readonly deletions: number } {
  const counts = new Map<string, number>()
  for (const line of splitText(before).lines) counts.set(line, (counts.get(line) ?? 0) + 1)
  let insertions = 0
  for (const line of splitText(after).lines) {
    const left = counts.get(line) ?? 0
    if (left > 0) counts.set(line, left - 1)
    else insertions += 1
  }
  let deletions = 0
  for (const left of counts.values()) deletions += left
  return { insertions, deletions }
}

interface Tracked {
  readonly initial: string | null
  /** The file as the changes undone so far leave it; `null`: no file. */
  content: string | null
}

type Loaded = { readonly ok: true; readonly file: Tracked } | { readonly ok: false; readonly reason: string }

const CHANGED_AFTER_CREATE = 'changed since the agent created it'
const CHANGED_AFTER_EDIT = 'changed since the agent edited it (the lines around the edit are not what it left)'

/**
 * What undoing `changes` (oldest first) would do to the files on disk. Newest first, each undo is checked against the state the
 * previous ones left in memory, so several edits of one file, or a file that was created, edited and moved, come out right. A file whose
 * state does not match what a record says is a conflict; nothing of it, nor of the files it was moved to or from, is part of the plan.
 */
export async function planRestore(changes: readonly FileChange[], io: RestoreIo, unsupported = 0): Promise<RestorePlan> {
  // Files tied together by a move are restored together or not at all.
  const parent = new Map<string, string>()
  const find = (path: string): string => {
    const up = parent.get(path)
    if (up === undefined || up === path) return path
    const root = find(up)
    parent.set(path, root)
    return root
  }
  for (const change of changes) {
    if (change.movePath === undefined) continue
    const [left, right] = [find(change.path), find(change.movePath)]
    if (left !== right) parent.set(left, right)
  }

  const tracked = new Map<string, Loaded>()
  const load = async (path: string): Promise<Loaded> => {
    const known = tracked.get(path)
    if (known !== undefined) return known
    const disk = await io.read(path)
    const loaded: Loaded =
      disk.kind === 'unreadable'
        ? { ok: false, reason: disk.reason }
        : { ok: true, file: { initial: disk.kind === 'absent' ? null : disk.content, content: disk.kind === 'absent' ? null : disk.content } }
    tracked.set(path, loaded)
    return loaded
  }
  const blocked = new Map<string, RestoreConflict>()
  const fail = (path: string, reason: string): void => {
    const root = find(path)
    if (!blocked.has(root)) blocked.set(root, { path, reason })
  }

  for (const change of changes.toReversed()) {
    if (blocked.has(find(change.path))) continue
    const here = await load(change.path)
    if (!here.ok) {
      fail(change.path, here.reason)
      continue
    }
    const file = here.file
    if (change.kind === 'add') {
      if (file.content === null) continue
      if (file.content === change.diff) file.content = null
      else fail(change.path, CHANGED_AFTER_CREATE)
    } else if (change.kind === 'delete') {
      if (file.content === null) file.content = change.diff
      else if (file.content !== change.diff) fail(change.path, 'exists again with other content than the agent deleted')
    } else {
      const hunks = parseHunks(change.diff)
      if (hunks === undefined) {
        fail(change.path, 'the recorded edit cannot be read')
        continue
      }
      // The edit moved the file: what now lives at the new name goes back to the old one.
      const there = change.movePath === undefined ? here : await load(change.movePath)
      if (!there.ok) {
        fail(change.movePath ?? change.path, there.reason)
        continue
      }
      const edited = there.file
      if (edited.content === null) {
        // Moved back already, or gone.
        if (change.movePath === undefined || file.content === null) fail(change.movePath ?? change.path, 'no longer exists')
        continue
      }
      if (change.movePath !== undefined && file.content !== null) {
        fail(change.path, 'exists again, so the moved file cannot go back to it')
        continue
      }
      const text = splitText(edited.content)
      const reverted = replaceHunks(text, hunks, 'new')
      if (reverted === undefined) {
        // The edit may have been undone by hand.
        if (change.movePath === undefined && replaceHunks(text, hunks, 'old') !== undefined) continue
        fail(change.movePath ?? change.path, CHANGED_AFTER_EDIT)
        continue
      }
      if (change.movePath === undefined) edited.content = joinText(reverted)
      else {
        file.content = joinText(reverted)
        edited.content = null
      }
    }
  }

  const files: PlannedFile[] = []
  const unchanged: string[] = []
  for (const [path, loaded] of tracked) {
    if (!loaded.ok || blocked.has(find(path))) continue
    const { initial, content } = loaded.file
    if (initial === content) {
      unchanged.push(path)
      continue
    }
    files.push({ path, action: initial === null ? 'create' : content === null ? 'delete' : 'write', content: content ?? undefined, ...lineDelta(initial ?? '', content ?? '') })
  }
  files.sort((left, right) => left.path.localeCompare(right.path))
  unchanged.sort()
  return { files, unchanged, conflicts: [...blocked.values()].sort((left, right) => left.path.localeCompare(right.path)), unsupported }
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
      failed.push({ path: file.path, reason: `could not be written (${messageOf(error)})` })
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

const CHECKPOINTS_LISTED = 20
const FILES_LISTED = 40

export function renderCheckpoints(checkpoints: readonly CodexCheckpoint[]): string {
  if (checkpoints.length === 0) return 'There are no messages in the current Codex conversation yet.'
  const first = Math.max(0, checkpoints.length - CHECKPOINTS_LISTED)
  const rows = checkpoints
    .slice(first)
    .map((checkpoint, index) => `| ${first + index + 1} | ${clip(checkpoint.label, CHECKPOINT_LABEL_LIMIT).replace(/\|/g, '\\|')} | ${checkpoint.at === undefined ? '' : clock(checkpoint.at)} |`)
  return [
    `**Rewind points** — ${checkpoints.length} message${checkpoints.length === 1 ? '' : 's'} in this conversation${first > 0 ? `, the last ${CHECKPOINTS_LISTED} shown` : ''}`,
    '',
    '| # | Message | Sent |',
    '|---:|---|---|',
    ...rows,
    '',
    '`/rewind <n>` previews going back to just before message *n*; `/rewind <n> confirm` restores the files Codex changed since then and rolls the conversation back (`code`: files only, `chat`: conversation only).',
  ].join('\n')
}

/** "message 3", or "message 3 and the 2 messages after it". */
function messageSpan(position: number, total: number): string {
  const later = total - position
  return later === 0 ? `message ${position}` : `message ${position} and the ${later === 1 ? '1 message' : `${later} messages`} after it`
}

/** "3 files (+10 −2)". */
function fileCount(files: readonly PlannedFile[]): string {
  const insertions = files.reduce((sum, file) => sum + file.insertions, 0)
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0)
  return `${files.length} file${files.length === 1 ? '' : 's'} (+${insertions} −${deletions})`
}

/** What `/rewind` tells about the message it goes back to; `mode` is what the user asked to roll back. */
export interface RewindPoint {
  readonly checkpoint: CodexCheckpoint
  readonly position: number
  /** How many messages the conversation has. */
  readonly total: number
  readonly mode: RewindMode
  /** A path as the user should see it (relative to the session directory when inside it). */
  readonly display: (path: string) => string
}

const REWIND_LIMITS =
  'The messages stay visible in this DSH conversation (its log is append-only). Shell-command side effects are never undone; only files Codex changed through its file tools are restored.'

function fileLine(file: PlannedFile, display: (path: string) => string): string {
  const what =
    file.action === 'delete' ? `removed (−${file.deletions})` : file.action === 'create' ? `back (+${file.insertions})` : `+${file.insertions} −${file.deletions}`
  return `  - ${inlineCode(display(file.path))} — ${what}`
}

function conflictLines(conflicts: readonly RestoreConflict[], display: (path: string) => string, intro: string): string[] {
  if (conflicts.length === 0) return []
  return [
    `- **${intro}**`,
    ...conflicts.slice(0, FILES_LISTED).map((conflict) => `  - ${inlineCode(display(conflict.path))} — ${conflict.reason}`),
    ...(conflicts.length > FILES_LISTED ? [`  - …and ${conflicts.length - FILES_LISTED} more`] : []),
  ]
}

/** Files the agent changed since the message that are as they were before it already (put back by hand, or moved on and gone again). */
function unchangedLine(count: number): string {
  return `- **Files:** ${count} file${count === 1 ? '' : 's'} Codex changed since then ${count === 1 ? 'is' : 'are'} already as before that message.`
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
  if (plan.unchanged.length > 0) out.push(unchangedLine(plan.unchanged.length))
  if (plan.unsupported > 0) out.push(`- ${plan.unsupported} recorded change${plan.unsupported === 1 ? ' is' : 's are'} of a kind this Codex version does not describe; not restored.`)
  if (out.length === 0) out.push("- **Files:** nothing to restore; no file changed through Codex's file tools after this message.")
  return out
}

export function renderRewindPreview(point: RewindPoint & { readonly plan: RestorePlan | undefined }): string {
  const { checkpoint, position, total, mode, plan, display } = point
  const out = [`**Rewind to just before message ${position}** (${inlineCode(clip(checkpoint.label, CHECKPOINT_LABEL_LIMIT))})`, '']
  if (mode !== 'code') out.push(`- **Conversation:** Codex would forget ${messageSpan(position, total)}.`)
  if (plan !== undefined) out.push(...planLines(plan, display))
  out.push('')
  const confirm = (words: string): string => `\`/rewind ${position}${words} confirm\``
  if (mode === 'both') {
    out.push(`Run ${confirm('')} to do both, ${confirm(' code')} to restore the files only, or ${confirm(' chat')} to roll the conversation back only.`)
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
      out.push(plan.unchanged.length > 0 ? unchangedLine(plan.unchanged.length) : "- **Files:** nothing to restore; no file changed through Codex's file tools after this message.")
    }
    out.push(...conflictLines(notRestored, display, 'Files that were not restored (they are left as they are):'))
  }
  if (rolledBack) out.push(`- **Conversation:** Codex no longer remembers ${messageSpan(position, total)}.`)
  if (rollbackError !== undefined) out.push(`- **Conversation:** not rolled back — ${rollbackError}`)
  out.push('')
  if (!rolledBack && mode !== 'chat') out.push('The conversation was not rolled back: Codex still remembers the later work, so tell it the files changed back.')
  out.push(REWIND_LIMITS)
  return out.join('\n')
}
