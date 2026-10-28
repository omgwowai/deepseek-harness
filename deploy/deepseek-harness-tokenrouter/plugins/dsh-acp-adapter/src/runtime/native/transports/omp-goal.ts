/**
 * Oh My Pi goals (`/goal`): reading the command line, reading a goal and putting it into words, and the one-line notes a
 * `goal_updated` frame turns into. The protocol side (rpc `goal`, the runs omp starts by itself for an active goal, holding
 * the turn open while they run) lives in `omp.ts`.
 */

/** The usage line of a command line that makes no sense. */
export const GOAL_USAGE = 'Usage: /goal [<objective>|clear|pause|resume]'

/**
 * What the reply of a goal command adds when omp did not start working on the goal by itself and the transport could not give
 * it the setting that lets goals continue over rpc (`goal.continuationModes` includes `rpc`; omp's default has `interactive`
 * alone, and the transport passes a config overlay that adds it, see `omp-overlay.ts`). The goal then waits for the next message.
 */
export const GOAL_WAITS =
  'Oh My Pi did not start working on the goal by itself: this session could not give it the setting that lets goals continue over rpc (`goal.continuationModes` includes `rpc`). The goal waits for your next message.'

/** The `Goal` of omp's rpc (`goal` responses, `goal_updated` frames, `get_state.goal`). */
export interface OmpGoal {
  readonly id: string
  readonly objective: string
  /** `active`, `paused`, `budget-limited`, `complete` or `dropped`. */
  readonly status: string
  readonly tokenBudget: number | undefined
  readonly tokensUsed: number
  readonly timeUsedSeconds: number
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** A goal of omp; `undefined` for anything without an objective and a status. */
export function parseOmpGoal(value: unknown): OmpGoal | undefined {
  const goal = record(value)
  const objective = goal?.['objective']
  const status = goal?.['status']
  if (goal === undefined || typeof objective !== 'string' || typeof status !== 'string') return undefined
  const budget = goal['tokenBudget']
  return {
    id: typeof goal['id'] === 'string' ? goal['id'] : '',
    objective,
    status,
    tokenBudget: typeof budget === 'number' && Number.isFinite(budget) && budget > 0 ? budget : undefined,
    tokensUsed: count(goal['tokensUsed']),
    timeUsedSeconds: count(goal['timeUsedSeconds']),
  }
}

export type GoalRequest =
  | { readonly action: 'show' }
  | { readonly action: 'clear' }
  | { readonly action: 'pause' }
  | { readonly action: 'resume' }
  | { readonly action: 'set'; readonly objective: string }
  /** A command line that makes no sense, and what to tell the user about it. */
  | { readonly action: 'usage'; readonly problem: string }

/**
 * The words of omp's own `/goal` (`set`, `show`, `pause`, `resume`, `drop`, `budget`) plus `clear` and `status`, matched without regard
 * to case; anything else is the objective. A control word with more words after it is refused, not run: omp's terminal ignores them,
 * which would pause a goal when the user typed "pause the deployment" meaning an objective. `/goal set <text>` takes any text.
 */
export function parseGoalArgs(args: string): GoalRequest {
  const text = args.trim()
  const match = /^(\S+)(?:\s+([\s\S]*\S))?$/.exec(text)
  if (match === null) return { action: 'show' }
  const word = (match[1] ?? '').toLowerCase()
  const rest = match[2]
  const control = (action: 'show' | 'clear' | 'pause' | 'resume'): GoalRequest =>
    rest === undefined
      ? { action }
      : {
          action: 'usage',
          problem: `\`/goal ${word}\` takes no further words. To make "${text}" the objective, write \`/goal set ${text}\`.`,
        }
  switch (word) {
    case 'show':
    case 'status':
      return control('show')
    case 'clear':
    case 'drop':
      return control('clear')
    case 'pause':
      return control('pause')
    case 'resume':
      return control('resume')
    case 'set':
      return rest === undefined
        ? { action: 'usage', problem: 'Say what the goal is: `/goal set <objective>`.' }
        : { action: 'set', objective: rest }
    case 'budget':
      return { action: 'usage', problem: "Oh My Pi's rpc protocol cannot change the token budget of a goal." }
    default:
      return { action: 'set', objective: text }
  }
}

/** Why omp refused a goal command, in words the user can act on. */
export function goalFailure(detail: string): string {
  if (detail.includes('goal.enabled')) return 'Goals are turned off in this Oh My Pi configuration (`goal.enabled`).'
  if (detail.includes('already active') || detail.includes('paused goal before creating')) {
    return 'This session already has a goal. `/goal clear` drops it, `/goal` shows it.'
  }
  if (detail.includes('plan mode')) return 'Oh My Pi is in plan mode; leave it before starting a goal.'
  return `Oh My Pi refused the goal command: ${detail}`
}

const STATUS_LABELS: Readonly<Record<string, string>> = {
  active: 'active',
  paused: 'paused',
  'budget-limited': 'limited by budget',
  complete: 'complete',
  dropped: 'cleared',
}

export function goalStatusLabel(status: string): string {
  return Object.hasOwn(STATUS_LABELS, status) ? (STATUS_LABELS[status] ?? status) : status
}

/** `63876` -> `63.9K`, `50000` -> `50K`, `1250000` -> `1.3M`. */
function compactTokens(tokens: number): string {
  const scaled = (divisor: number, unit: string): string =>
    `${(tokens / divisor).toFixed(1).replace(/\.0$/, '')}${unit}`
  if (tokens >= 1e9) return scaled(1e9, 'B')
  if (tokens >= 1e6) return scaled(1e6, 'M')
  if (tokens >= 1e3) return scaled(1e3, 'K')
  return String(tokens)
}

/** `45s`, `4m`, `1h 30m`, `2d 3h 5m`. */
function elapsed(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h ${rest}m`
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

/** "12.3K / 50K tokens · 4m": what the goal has used, against its budget when it has one. */
export function goalUsage(goal: OmpGoal): string {
  const parts: string[] = []
  if (goal.tokenBudget !== undefined)
    parts.push(`${compactTokens(goal.tokensUsed)} / ${compactTokens(goal.tokenBudget)} tokens`)
  else if (goal.tokensUsed > 0) parts.push(`${compactTokens(goal.tokensUsed)} tokens`)
  if (goal.timeUsedSeconds > 0) parts.push(elapsed(goal.timeUsedSeconds))
  return parts.join(' · ')
}

/** The objective as a quotation, so a multi-line one stays inside the message. */
function quoted(objective: string): string {
  return objective
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}

/** A goal, its status and what it has used; `heading` says what the reply is about ("Goal", "Goal set"). */
export function formatGoal(goal: OmpGoal, heading = 'Goal'): string {
  const usage = goalUsage(goal)
  return [
    `**${heading}** — ${goalStatusLabel(goal.status)}`,
    '',
    quoted(goal.objective),
    ...(usage === '' ? [] : ['', usage]),
  ].join('\n')
}

/** The cap of an objective inside a one-line note. */
const NOTE_OBJECTIVE_LIMIT = 160

function oneLine(objective: string): string {
  const line = objective.replace(/\s+/g, ' ').trim()
  return line.length <= NOTE_OBJECTIVE_LIMIT ? line : `${line.slice(0, NOTE_OBJECTIVE_LIMIT - 1).trimEnd()}…`
}

/**
 * The note a `goal_updated` frame deserves, or `undefined` for one that changes nothing the user can see: only a new objective
 * or a new status is worth a line (the token counters move with every turn). `previous` is `undefined` before the first frame, and
 * `next` is `undefined` once the goal is gone.
 */
export function goalNote(previous: OmpGoal | undefined, next: OmpGoal | undefined): string | undefined {
  if (next === undefined) return previous === undefined ? undefined : 'Goal cleared.'
  if (
    previous !== undefined &&
    previous.id === next.id &&
    previous.objective === next.objective &&
    previous.status === next.status
  ) {
    return undefined
  }
  // A goal that was already finished when the session opened is no news.
  if (previous === undefined && next.status === 'complete') return undefined
  const objective = oneLine(next.objective)
  const usage = goalUsage(next)
  const used = usage === '' ? '' : ` (${usage})`
  switch (next.status) {
    case 'active':
      return `Goal active: ${objective}`
    case 'paused':
      return `Goal paused: ${objective}`
    case 'complete':
      return `Goal complete${used}: ${objective}`
    case 'budget-limited':
      return `Goal limited by its token budget${used}: ${objective}`
    default:
      return `Goal ${goalStatusLabel(next.status)}: ${objective}`
  }
}
