/**
 * The immediate Codex commands that only read the app-server (`/skills`, `/mcp`, `/ps`, `/stop`, `/hooks`,
 * `/diff`). Each makes its requests through the `request` function the transport hands over and returns the
 * Markdown for the DSH command row; a failed request throws and the transport turns it into an error row.
 */
import { asRecord, readArray, readNumber, readString, truncate } from './codex-json.ts'
import {
  fencedDiff,
  formatBackgroundTerminals,
  formatHooks,
  formatMcpServers,
  formatSkills,
  parseMcpServers,
  parseSkillsList,
  type CodexMcpServer,
  type CodexSkill,
} from './codex-reports.ts'
import type { NativeCommandResult } from './contract.ts'

/** One app-server request (the transport's own, with its timeouts and error mapping). */
export type CodexRequest = (method: string, params: unknown, timeoutMs?: number) => Promise<unknown>

const SKILLS_TIMEOUT_MS = 10_000
/** Per-command limit of the git processes `/diff` starts (the TUI uses the same). */
const GIT_TIMEOUT_MS = 30_000
const GIT_REQUEST_TIMEOUT_MS = GIT_TIMEOUT_MS + 10_000
/** What `/diff` shows: about this many characters, and at most this many untracked files. */
const DIFF_TEXT_LIMIT = 100_000
const DIFF_UNTRACKED_LIMIT = 50
const DIFF_OUTPUT_BYTES_CAP = 8_000_000

const ok = (text: string): NativeCommandResult => ({ kind: 'success', text })
const failed = (text: string): NativeCommandResult => ({ kind: 'error', text })

// ---------------------------------------------------------------------------
// /skills
// ---------------------------------------------------------------------------

/** The skills Codex offers for `cwd` (`skills/list`; `forceReload` re-scans the disk, as the TUI does for `/skills`). */
export async function fetchSkills(
  request: CodexRequest,
  cwd: string,
  forceReload: boolean,
): Promise<{ readonly skills: CodexSkill[]; readonly errors: string[] }> {
  return parseSkillsList(await request('skills/list', { cwds: [cwd], ...(forceReload ? { forceReload: true } : {}) }, SKILLS_TIMEOUT_MS))
}

export async function listSkillsCommand(request: CodexRequest, cwd: string): Promise<NativeCommandResult> {
  const { skills, errors } = await fetchSkills(request, cwd, true)
  return ok(formatSkills(skills, errors))
}

// ---------------------------------------------------------------------------
// /mcp
// ---------------------------------------------------------------------------

/** Every page of `mcpServerStatus/list` (the TUI pages by 100). */
async function fetchMcpServers(request: CodexRequest, threadId: string, detail: 'full' | 'toolsAndAuthOnly'): Promise<CodexMcpServer[]> {
  const entries: unknown[] = []
  const seen = new Set<string>()
  let cursor: string | null = null
  do {
    const page = asRecord(await request('mcpServerStatus/list', { cursor, limit: 100, detail, threadId, serverName: null }))
    entries.push(...(readArray(page, 'data') ?? []))
    cursor = readString(page, 'nextCursor') ?? null
    if (cursor !== null) {
      if (seen.has(cursor)) break
      seen.add(cursor)
    }
  } while (cursor !== null)
  return parseMcpServers(entries)
}

/** An authorization link is opened by a person, so it must at least be a web link. */
function webLink(value: string | undefined): URL | undefined {
  if (value === undefined) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : undefined
  } catch {
    return undefined
  }
}

export async function mcpCommand(request: CodexRequest, threadId: string, args: string): Promise<NativeCommandResult> {
  const [subcommand = '', ...rest] = args.trim().split(/\s+/).filter((word) => word !== '')
  if (subcommand === '' && rest.length === 0) return ok(formatMcpServers(await fetchMcpServers(request, threadId, 'toolsAndAuthOnly'), false))
  if (subcommand === 'verbose' && rest.length === 0) return ok(formatMcpServers(await fetchMcpServers(request, threadId, 'full'), true))
  if (subcommand === 'login' && rest.length > 0) {
    const name = rest.join(' ')
    const response = asRecord(
      await request('mcpServer/oauth/login', { name, threadId, clientRegistration: null, scopes: null, timeoutSecs: null }),
    )
    const link = webLink(readString(response, 'authorizationUrl'))
    if (link === undefined) return failed(`Codex did not return a link to sign in to ${name}.`)
    return ok(`Open <${link.href}> to sign in to \`${name.replaceAll('`', "'")}\`. Codex completes the sign-in when you finish it in the browser.`)
  }
  return failed('Usage: /mcp [verbose | login <name>]')
}

// ---------------------------------------------------------------------------
// /ps, /stop
// ---------------------------------------------------------------------------

export async function psCommand(request: CodexRequest, threadId: string): Promise<NativeCommandResult> {
  const terminals: unknown[] = []
  const seen = new Set<string>()
  let cursor: string | null = null
  do {
    const page = asRecord(await request('thread/backgroundTerminals/list', { threadId, cursor, limit: null }))
    terminals.push(...(readArray(page, 'data') ?? []))
    cursor = readString(page, 'nextCursor') ?? null
    if (cursor !== null) {
      if (seen.has(cursor)) break
      seen.add(cursor)
    }
  } while (cursor !== null)
  return ok(formatBackgroundTerminals(terminals))
}

/** `/stop` ends every background terminal (the TUI's only form); `/stop <process id>` ends that one. */
export async function stopCommand(request: CodexRequest, threadId: string, args: string): Promise<NativeCommandResult> {
  const processId = args.trim()
  if (processId === '') {
    await request('thread/backgroundTerminals/clean', { threadId })
    return ok('Stopped all background terminals.')
  }
  const response = asRecord(await request('thread/backgroundTerminals/terminate', { threadId, processId }))
  return response?.['terminated'] === true
    ? ok(`Stopped the background terminal \`${processId.replaceAll('`', "'")}\`.`)
    : failed(`No background terminal with the process id \`${processId.replaceAll('`', "'")}\` is running. \`/ps\` lists them.`)
}

// ---------------------------------------------------------------------------
// /hooks
// ---------------------------------------------------------------------------

export async function hooksCommand(request: CodexRequest, cwd: string): Promise<NativeCommandResult> {
  return ok(formatHooks(await request('hooks/list', { cwds: [cwd] })))
}

// ---------------------------------------------------------------------------
// /diff
// ---------------------------------------------------------------------------

/**
 * Git as the TUI runs it for `/diff`: no repository hook, fsmonitor or bare-repository trick may execute, and the
 * clean/process filter drivers a repository configures are blanked through `GIT_CONFIG_*` (see `diffFilterOverrides`).
 */
const GIT = ['git', '-c', 'safe.bareRepository=explicit', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'] as const

/** Plain text (no ANSI colour), for a fenced block. */
const GIT_DIFF = ['diff', '--no-textconv', '--no-ext-diff', '--submodule=short', '--ignore-submodules=dirty'] as const

interface Executed {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

async function exec(request: CodexRequest, cwd: string, args: readonly string[], env?: Record<string, string>): Promise<Executed> {
  const response = asRecord(
    await request(
      'command/exec',
      {
        command: [...GIT, ...args],
        cwd,
        timeoutMs: GIT_TIMEOUT_MS,
        outputBytesCap: DIFF_OUTPUT_BYTES_CAP,
        ...(env === undefined ? {} : { env }),
      },
      GIT_REQUEST_TIMEOUT_MS,
    ),
  )
  return {
    exitCode: readNumber(response, 'exitCode') ?? -1,
    stdout: readString(response, 'stdout') ?? '',
    stderr: readString(response, 'stderr') ?? '',
  }
}

/** `git diff` exits 1 when it found differences. */
function diffText(output: Executed, what: string): string {
  if (output.exitCode === 0 || output.exitCode === 1) return output.stdout
  throw new Error(`git ${what} failed with status ${String(output.exitCode)}${output.stderr === '' ? '' : `: ${truncate(output.stderr.trim(), 300)}`}`)
}

/** `GIT_CONFIG_COUNT/KEY/VALUE` entries that blank every configured clean/process filter driver. */
async function diffFilterOverrides(request: CodexRequest, cwd: string): Promise<Record<string, string>> {
  const found = await exec(request, cwd, ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process)$'])
  // Exit 1: nothing configured.
  if (found.exitCode !== 0 && found.exitCode !== 1) throw new Error(`git config failed with status ${String(found.exitCode)}`)
  const drivers = new Set<string>()
  for (const key of found.stdout.split('\0')) {
    if (key.endsWith('.clean')) drivers.add(key.slice(0, -'.clean'.length))
    else if (key.endsWith('.process')) drivers.add(key.slice(0, -'.process'.length))
  }
  const entries = [...drivers].sort().flatMap((driver) => [
    [`${driver}.clean`, ''],
    [`${driver}.process`, ''],
    [`${driver}.required`, 'false'],
  ])
  const env: Record<string, string> = entries.length === 0 ? {} : { GIT_CONFIG_COUNT: String(entries.length) }
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${String(index)}`] = key ?? ''
    env[`GIT_CONFIG_VALUE_${String(index)}`] = value ?? ''
  })
  return env
}

/** The TUI's `/diff`: tracked changes plus every untracked file, computed with git through `command/exec`. */
export async function diffCommand(request: CodexRequest, cwd: string, signal: AbortSignal): Promise<NativeCommandResult> {
  const inside = await exec(request, cwd, ['rev-parse', '--is-inside-work-tree'])
  if (inside.exitCode !== 0) return ok('Not inside a git repository.')
  signal.throwIfAborted()
  const env = await diffFilterOverrides(request, cwd)
  const [tracked, listed] = await Promise.all([exec(request, cwd, GIT_DIFF, env), exec(request, cwd, ['ls-files', '--others', '--exclude-standard'])])
  if (listed.exitCode !== 0) throw new Error(`git ls-files failed with status ${String(listed.exitCode)}`)
  let text = diffText(tracked, 'diff')
  const untracked = listed.stdout.split('\n').map((file) => file.trim()).filter((file) => file !== '')
  for (const file of untracked.slice(0, DIFF_UNTRACKED_LIMIT)) {
    // Enough is enough: the rest would be cut from the block anyway.
    if (text.length > DIFF_TEXT_LIMIT) break
    signal.throwIfAborted()
    text += diffText(await exec(request, cwd, [...GIT_DIFF, '--no-index', '--', '/dev/null', file], env), 'diff --no-index')
  }
  if (text.trim() === '') return ok('No changes detected.')
  const skipped = untracked.length > DIFF_UNTRACKED_LIMIT ? `\n\n_${String(untracked.length - DIFF_UNTRACKED_LIMIT)} more untracked files are not shown._` : ''
  return ok(`${fencedDiff(text, DIFF_TEXT_LIMIT)}${skipped}`)
}
