/**
 * Markdown renderings of the read-only Codex data the immediate commands show (`/skills`, `/mcp`, `/ps`,
 * `/hooks`, `/diff`, the limits of `/status`). The transport (`codex.ts`) makes the app-server requests; everything
 * here is a pure function of their responses, so a protocol drift shows up as a skipped field, never as a throw.
 */
import { asRecord, readArray, readNumber, readString, readStringArray, truncate, type JsonRecord } from './codex-json.ts'

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** Inline code; a backtick inside would end the span, so it becomes a quote. */
const code = (text: string): string => `\`${text.replaceAll('`', "'")}\``

/** A label from a table of known values; prototype names (`constructor`) and unknown values get the fallback. */
function labelOf(table: Readonly<Record<string, string>>, key: string | undefined, fallback: string): string {
  return key !== undefined && Object.hasOwn(table, key) ? (table[key] ?? fallback) : fallback
}

/** At most `limit` items, then how many more there are. */
function listOf(items: readonly string[], limit: number): string {
  const shown = items.slice(0, limit).join(', ')
  return items.length > limit ? `${shown}, … and ${String(items.length - limit)} more` : shown
}

// ---------------------------------------------------------------------------
// /skills
// ---------------------------------------------------------------------------

export interface CodexSkill {
  readonly name: string
  readonly description: string
  /** The `SKILL.md` path: what `skills/config/write` and a `skill` input item are addressed by. */
  readonly path: string
  readonly enabled: boolean
}

/** The skills of a `skills/list` response (one entry per requested directory), each file once, and the load errors. */
export function parseSkillsList(response: unknown): { readonly skills: CodexSkill[]; readonly errors: string[] } {
  const skills: CodexSkill[] = []
  const errors: string[] = []
  const seen = new Set<string>()
  for (const entry of readArray(asRecord(response), 'data') ?? []) {
    for (const skill of readArray(asRecord(entry), 'skills') ?? []) {
      const record = asRecord(skill)
      const name = readString(record, 'name')
      const path = readString(record, 'path')
      if (name === undefined || path === undefined || seen.has(path)) continue
      seen.add(path)
      // The short description of the skill's interface is what the TUI lists; the long one is the model's trigger text.
      const description =
        readString(asRecord(record?.['interface']), 'shortDescription') ??
        readString(record, 'shortDescription') ??
        readString(record, 'description') ??
        ''
      skills.push({ name, description: collapse(description), path, enabled: record?.['enabled'] !== false })
    }
    for (const error of readArray(asRecord(entry), 'errors') ?? []) {
      const record = asRecord(error)
      const message = readString(record, 'message')
      if (message !== undefined) errors.push(`${code(readString(record, 'path') ?? 'skill')}: ${collapse(message)}`)
    }
  }
  return { skills, errors }
}

export function formatSkills(skills: readonly CodexSkill[], errors: readonly string[]): string {
  const failed = errors.length === 0 ? [] : ['', '_Skills that failed to load:_', ...errors.map((error) => `- ${error}`)]
  if (skills.length === 0) return ['No skills available.', ...failed].join('\n')
  const enabled = skills.filter((skill) => skill.enabled).length
  return [
    `**Skills** — ${String(enabled)} enabled, ${String(skills.length - enabled)} disabled`,
    '',
    ...skills.map((skill) => {
      const description = truncate(skill.description, 160)
      return `- ${code(skill.name)}${description === '' ? '' : ` — ${description}`}${skill.enabled ? '' : ' _(disabled)_'}`
    }),
    '',
    'Run a skill with `/<name> <request>` or `$<name>`. `/skills disable <name>` and `/skills enable <name>` turn one off or on.',
    ...failed,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// /mcp
// ---------------------------------------------------------------------------

const MCP_STATUS_LABELS: Readonly<Record<string, string>> = {
  notStarted: 'not started',
  starting: 'starting',
  connected: 'connected',
  authenticationRequired: 'authentication required',
  failed: 'failed',
  cancelled: 'cancelled',
  disabled: 'disabled',
}

const MCP_AUTH_LABELS: Readonly<Record<string, string>> = {
  unknown: 'unknown',
  unsupported: 'not supported',
  notLoggedIn: 'not logged in',
  bearerToken: 'bearer token',
  oAuth: 'OAuth',
}

export interface CodexMcpServer {
  readonly name: string
  readonly status: string
  readonly auth: string
  readonly tools: readonly string[]
  readonly toolsError: string | undefined
  readonly resources: readonly string[]
  readonly templates: readonly string[]
}

/** `title (location)` for a resource or a resource template. */
function resourceLabel(entry: unknown, locationKey: string): string[] {
  const record = asRecord(entry)
  const label = readString(record, 'title') ?? readString(record, 'name')
  const location = readString(record, locationKey)
  if (label === undefined) return location === undefined ? [] : [location]
  return [location === undefined ? label : `${label} (${location})`]
}

export function parseMcpServers(data: readonly unknown[]): CodexMcpServer[] {
  return data.flatMap((entry) => {
    const record = asRecord(entry)
    const name = readString(record, 'name')
    if (record === undefined || name === undefined) return []
    return [
      {
        name,
        status: labelOf(MCP_STATUS_LABELS, readString(record, 'runtimeStatus'), 'unknown'),
        auth: labelOf(MCP_AUTH_LABELS, readString(record, 'authStatus'), 'unknown'),
        tools: Object.keys(asRecord(record['tools']) ?? {}).sort(),
        toolsError: readString(record, 'toolsError'),
        resources: (readArray(record, 'resources') ?? []).flatMap((resource) => resourceLabel(resource, 'uri')),
        templates: (readArray(record, 'resourceTemplates') ?? []).flatMap((template) => resourceLabel(template, 'uriTemplate')),
      },
    ]
  })
}

export function formatMcpServers(servers: readonly CodexMcpServer[], verbose: boolean): string {
  if (servers.length === 0) return 'No MCP servers configured.'
  const lines = ['**MCP servers**', '']
  for (const server of servers) {
    const tools = server.tools.length === 0 ? '' : ` (${String(server.tools.length)} ${server.tools.length === 1 ? 'tool' : 'tools'})`
    lines.push(`- ${code(server.name)} — ${server.status}${tools}`)
    if (!verbose) continue
    lines.push(`  - Auth: ${server.auth}`)
    if (server.toolsError !== undefined) lines.push(`  - Tools could not be listed: ${collapse(server.toolsError)}`)
    else if (server.tools.length > 0) lines.push(`  - Tools: ${listOf(server.tools, 40)}`)
    if (server.resources.length > 0) lines.push(`  - Resources: ${listOf(server.resources, 20)}`)
    if (server.templates.length > 0) lines.push(`  - Resource templates: ${listOf(server.templates, 20)}`)
  }
  if (!verbose) lines.push('', '_Use `/mcp verbose` for tools and resources._')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// /ps
// ---------------------------------------------------------------------------

/** TUI: at most this many background terminals are listed. */
const BACKGROUND_TERMINAL_LIMIT = 16

export function formatBackgroundTerminals(data: readonly unknown[]): string {
  const terminals = data.flatMap((entry) => {
    const record = asRecord(entry)
    const command = readString(record, 'command')
    return record === undefined || command === undefined ? [] : [record]
  })
  if (terminals.length === 0) return 'No background terminals running.'
  const lines = [`**Background terminals** (${String(terminals.length)})`, '']
  for (const terminal of terminals.slice(0, BACKGROUND_TERMINAL_LIMIT)) {
    const processId = readString(terminal, 'processId')
    const pid = readNumber(terminal, 'osPid')
    const cpu = readNumber(terminal, 'cpuPercent')
    const rss = readNumber(terminal, 'rssKb')
    const detail = [
      processId === undefined ? undefined : `process ${code(processId)}`,
      pid === undefined ? undefined : `pid ${String(pid)}`,
      cpu === undefined ? undefined : `${String(Math.round(cpu * 10) / 10)}% CPU`,
      rss === undefined ? undefined : `${String(Math.round(rss / 1024))} MB`,
    ].filter((part) => part !== undefined)
    const command = code(truncate(collapse(readString(terminal, 'command') ?? ''), 80))
    lines.push(detail.length === 0 ? `- ${command}` : `- ${command} — ${detail.join(', ')}`)
  }
  if (terminals.length > BACKGROUND_TERMINAL_LIMIT) {
    lines.push(`- … and ${String(terminals.length - BACKGROUND_TERMINAL_LIMIT)} more running`)
  }
  lines.push('', 'Stop one with `/stop <process id>`, or all of them with `/stop`.')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// /hooks
// ---------------------------------------------------------------------------

const HOOK_TRUST_LABELS: Readonly<Record<string, string>> = {
  managed: 'managed',
  trusted: 'trusted',
  untrusted: 'new hook — review required',
  modified: 'modified since last trusted — review required',
}

function hookHandler(hook: JsonRecord): string {
  switch (readString(hook, 'handlerType')) {
    case 'command':
      return code(truncate(collapse(readString(hook, 'command') ?? ''), 120))
    case 'mcpTool':
      return `MCP tool ${code(`${readString(hook, 'server') ?? ''}.${readString(hook, 'tool') ?? ''}`)}`
    case 'prompt':
      return 'prompt hook'
    case 'agent':
      return 'agent hook'
    default:
      return 'hook'
  }
}

export function formatHooks(response: unknown): string {
  const entries = (readArray(asRecord(response), 'data') ?? []).flatMap((entry): JsonRecord[] => {
    const record = asRecord(entry)
    return record === undefined ? [] : [record]
  })
  const byEvent = new Map<string, JsonRecord[]>()
  for (const entry of entries) {
    for (const hook of readArray(entry, 'hooks') ?? []) {
      const record = asRecord(hook)
      if (record === undefined) continue
      const event = readString(record, 'eventName') ?? 'unknown'
      byEvent.set(event, [...(byEvent.get(event) ?? []), record])
    }
  }
  const problems = entries.flatMap((entry) => [
    ...readStringArray(entry, 'warnings').map((warning) => `- ${collapse(warning)}`),
    ...(readArray(entry, 'errors') ?? []).flatMap((error) => {
      const message = readString(asRecord(error), 'message')
      return message === undefined ? [] : [`- ${code(readString(asRecord(error), 'path') ?? 'hooks')}: ${collapse(message)}`]
    }),
  ])
  const trailer = problems.length === 0 ? [] : ['', '_Problems:_', ...problems]
  if (byEvent.size === 0) return ['No hooks configured.', ...trailer].join('\n')
  const lines = [`**Hooks** — ${String([...byEvent.values()].reduce((sum, hooks) => sum + hooks.length, 0))} configured`]
  for (const [event, hooks] of byEvent) {
    lines.push('', `**${event}**`)
    for (const hook of hooks) {
      const matcher = readString(hook, 'matcher')
      const facts = [
        readString(hook, 'source'),
        labelOf(HOOK_TRUST_LABELS, readString(hook, 'trustStatus'), 'trust unknown'),
        hook['enabled'] === false ? 'disabled' : undefined,
      ].filter((fact) => fact !== undefined)
      lines.push(`- ${matcher === undefined || matcher === '' ? '(all)' : code(matcher)} → ${hookHandler(hook)} — ${facts.join(' · ')}`)
    }
  }
  lines.push('', '_DSH lists the hooks; enable, disable and trust them in the Codex terminal (`/hooks`)._', ...trailer)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// /status limits (ChatGPT accounts only)
// ---------------------------------------------------------------------------

function windowLabel(minutes: number | undefined): string {
  if (minutes === undefined) return 'Limit'
  if (minutes === 10_080) return 'Weekly limit'
  if (minutes % 60 === 0) return `${String(minutes / 60)}h limit`
  return `${String(minutes)}m limit`
}

/** One line per rate-limit window of an `account/rateLimits/read` response; empty when it reports none. */
export function formatRateLimits(response: unknown): string[] {
  const snapshot = asRecord(asRecord(response)?.['rateLimits'])
  return ['primary', 'secondary'].flatMap((key) => {
    const window = asRecord(snapshot?.[key])
    const used = readNumber(window, 'usedPercent')
    if (window === undefined || used === undefined) return []
    const resetsAt = readNumber(window, 'resetsAt')
    const reset = resetsAt === undefined ? '' : `, resets ${new Date(resetsAt * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`
    return [`${windowLabel(readNumber(window, 'windowDurationMins'))}: ${String(Math.round(used))}% used${reset}`]
  })
}

/** The estimated cost of the thread from an `account/usage/read` response, when the account's plan reports one. */
export function formatThreadUsage(response: unknown): string | undefined {
  const usage = asRecord(asRecord(response)?.['threadUsage'])
  const credits = readNumber(usage, 'estimatedUsageCreditsMicros')
  if (credits === undefined) return undefined
  const usd = readNumber(usage, 'estimatedUsageUsdMicros')
  const amounts = [usd === undefined ? undefined : `$${(usd / 1e6).toFixed(2)}`, `${(credits / 1e6).toFixed(2)} credits`]
  return `about ${amounts.filter((amount) => amount !== undefined).join(' / ')}`
}

// ---------------------------------------------------------------------------
// /diff
// ---------------------------------------------------------------------------

/** A fenced `diff` block of at most about `limit` characters (whole lines); the fence outgrows any backticks in the text. */
export function fencedDiff(text: string, limit: number): string {
  let shown = text
  let omitted = 0
  if (text.length > limit) {
    const cut = text.lastIndexOf('\n', limit)
    shown = text.slice(0, cut > 0 ? cut : limit)
    omitted = text.slice(shown.length).split('\n').length - 1
  }
  const longestRun = (shown.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 0)
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  const block = `${fence}diff\n${shown.replace(/\n$/, '')}\n${fence}`
  return omitted > 0 ? `${block}\n\n_The diff is cut here: ${String(omitted)} more lines are not shown._` : block
}
