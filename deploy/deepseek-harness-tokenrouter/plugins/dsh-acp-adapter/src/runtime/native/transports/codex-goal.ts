/**
 * Codex thread goals (`/goal`): parsing the command line, rendering a goal, and the one-line notes the app-server's goal
 * notifications turn into. The protocol side (`thread/goal/set|get|clear`, `thread/goal/updated|cleared`, the continuation
 * turns an active goal makes the server start) lives in `codex.ts`.
 */
import { asRecord, messageOf, readNumber, readString, truncate } from './codex-json.ts'
import type { NativeContentBlock } from './contract.ts'

/** The TUI's usage line (`goal_display.rs`), minus `edit`, which needs the terminal's editor. */
export const GOAL_USAGE = 'Usage: /goal [<objective>|clear|pause|resume]'

export interface CodexGoal {
  readonly objective: string
  /** `active`, `paused`, `blocked`, `usageLimited`, `budgetLimited` or `complete`. */
  readonly status: string
  readonly tokenBudget: number | undefined
  readonly tokensUsed: number
  readonly timeUsedSeconds: number
}

/** A `ThreadGoal` of the app-server; `undefined` for anything without an objective and a status. */
export function parseGoal(value: unknown): CodexGoal | undefined {
  const record = asRecord(value)
  const objective = readString(record, 'objective')
  const status = readString(record, 'status')
  if (objective === undefined || status === undefined) return undefined
  return {
    objective,
    status,
    tokenBudget: readNumber(record, 'tokenBudget'),
    tokensUsed: readNumber(record, 'tokensUsed') ?? 0,
    timeUsedSeconds: readNumber(record, 'timeUsedSeconds') ?? 0,
  }
}

export type GoalRequest =
  | { readonly action: 'show' }
  | { readonly action: 'clear' }
  | { readonly action: 'pause' }
  | { readonly action: 'resume' }
  | { readonly action: 'set'; readonly objective: string }
  | { readonly action: 'usage'; readonly problem: string }

/** `/goal`, `/goal clear|pause|resume`, `/goal <objective>`: the TUI's reading of the line (a control word is matched without regard to case). */
export function parseGoalArgs(args: string): GoalRequest {
  const text = args.trim()
  switch (text.toLowerCase()) {
    case '':
      return { action: 'show' }
    case 'clear':
      return { action: 'clear' }
    case 'pause':
      return { action: 'pause' }
    case 'resume':
      return { action: 'resume' }
    case 'edit':
      return { action: 'usage', problem: '`/goal edit` opens the terminal editor. To change the objective, `/goal clear` and set the new one.' }
    default:
      return { action: 'set', objective: text }
  }
}

/** The arguments of a message that is nothing but a `/goal …` line (`''` for a bare `/goal`); `undefined` for any other message. */
export function goalLineArgs(content: readonly NativeContentBlock[]): string | undefined {
  const [only, ...rest] = content
  if (only === undefined || only.type !== 'text' || rest.length > 0) return undefined
  const match = /^\/goal(?:\s+([\s\S]*))?$/i.exec(only.text.trim())
  return match === null ? undefined : (match[1] ?? '')
}

/** Why a goal request failed, in words the user can act on. */
export function goalFailure(error: unknown): string {
  const text = messageOf(error)
  if (text.includes('goals feature is disabled')) return 'Goals are turned off in this Codex configuration (`features.goals`).'
  if (text.includes('ephemeral thread does not support goals')) return 'Goals need a saved session; this one is temporary.'
  return `Codex refused the goal command: ${text}`
}

/** What the TUI calls each status (`goal_display.rs`). */
const STATUS_LABELS: Readonly<Record<string, string>> = {
  active: 'active',
  paused: 'paused',
  blocked: 'stalled',
  usageLimited: 'usage limited',
  budgetLimited: 'limited by budget',
  complete: 'complete',
}

export function goalStatusLabel(status: string): string {
  return Object.hasOwn(STATUS_LABELS, status) ? (STATUS_LABELS[status] ?? status) : status
}

/** `63876` -> `63.9K`, `50000` -> `50K`, `1250000` -> `1.3M`. */
function compactTokens(count: number): string {
  const scaled = (divisor: number, unit: string): string => `${(count / divisor).toFixed(1).replace(/\.0$/, '')}${unit}`
  if (count >= 1e9) return scaled(1e9, 'B')
  if (count >= 1e6) return scaled(1e6, 'M')
  if (count >= 1e3) return scaled(1e3, 'K')
  return String(count)
}

/** `45s`, `4m`, `1h 30m`, `2d 3h 5m`. */
function elapsed(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h ${rest}m`
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

/** "12.3K / 50K tokens · 4m": what the goal has used, against its budget when it has one. */
export function goalUsage(goal: CodexGoal): string {
  const parts: string[] = []
  if (goal.tokenBudget !== undefined) parts.push(`${compactTokens(goal.tokensUsed)} / ${compactTokens(goal.tokenBudget)} tokens`)
  else if (goal.tokensUsed > 0) parts.push(`${compactTokens(goal.tokensUsed)} tokens`)
  if (goal.timeUsedSeconds > 0) parts.push(elapsed(goal.timeUsedSeconds))
  return parts.join(' · ')
}

/** The objective as a quotation, so a multi-line one stays inside the message. */
const quoted = (objective: string): string =>
  objective
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')

/** `/goal` with no argument: the goal, its status and what it has used. */
export function formatGoal(goal: CodexGoal): string {
  const usage = goalUsage(goal)
  return [`**Goal** — ${goalStatusLabel(goal.status)}`, '', quoted(goal.objective), ...(usage === '' ? [] : ['', usage])].join('\n')
}

/** What a command that changed the goal tells: the status the goal is in now and the objective. */
export function formatGoalChange(heading: string, goal: CodexGoal): string {
  return [`**${heading}** — ${goalStatusLabel(goal.status)}`, '', quoted(goal.objective)].join('\n')
}

/** The cap of an objective inside a one-line note. */
const NOTE_OBJECTIVE_LIMIT = 160

/**
 * The note a goal notification deserves, or `undefined` for one that changes nothing the user can see: only a new objective or a new
 * status is worth a line (the token counters move with every turn). `previous` is `undefined` before the first notification.
 */
export function goalNote(previous: CodexGoal | undefined, next: CodexGoal | undefined): string | undefined {
  if (next === undefined) return previous === undefined ? undefined : 'Goal cleared.'
  if (previous !== undefined && previous.objective === next.objective && previous.status === next.status) return undefined
  // A goal that was already finished when the session opened is no news.
  if (previous === undefined && next.status === 'complete') return undefined
  const objective = truncate(next.objective.replace(/\s+/g, ' ').trim(), NOTE_OBJECTIVE_LIMIT)
  const usage = goalUsage(next)
  const used = usage === '' ? '' : ` (${usage})`
  switch (next.status) {
    case 'active':
      return `Goal active: ${objective}`
    case 'paused':
      return `Goal paused: ${objective}`
    case 'complete':
      return `Goal complete${used}: ${objective}`
    case 'blocked':
      return `Goal stalled: Codex cannot make progress without you${used}: ${objective}`
    case 'budgetLimited':
      return `Goal limited by its token budget${used}: ${objective}`
    case 'usageLimited':
      return `Goal stopped by a usage limit${used}: ${objective}`
    default:
      return `Goal ${goalStatusLabel(next.status)}: ${objective}`
  }
}
