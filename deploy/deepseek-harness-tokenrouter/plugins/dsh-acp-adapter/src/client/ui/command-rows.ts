import type { CommandNode } from '@deepseek-ai/dsh-client-ui-chat/client'

/**
 * Which Chat command rows this adapter draws itself, and what they show.
 *
 * Chat renders every `/command` as one generic card: the name, the first line of the result, and any further
 * lines as raw text in a `<pre>` capped at 260px. A vendor side question or an immediate command (no model turn)
 * returns Markdown instead (an answer, a status table, a command list), so those rows are registered per command
 * name: the keyed `conversation.chat.commandview` slot has no wildcard, and every other command (`/compact`,
 * `/goal`, forwarded prompt commands) keeps Chat's card.
 *
 * The names are listed here, not read from the transports' command tables, because the client layer cannot
 * import the runtime layer (`architecture.spec.ts`); `command-rows.spec.ts` fails when a table gains an
 * immediate or side command that has no row.
 */

/** `/btw` and its Codex twin `/side`: a model answer to the question typed after the name. */
export const SIDE_ANSWER_COMMANDS: readonly string[] = ['btw', 'side']

/**
 * Commands answered without a model turn: the vendor's immediate commands, their aliases (the host registers each
 * alias as a command of its own), and the host-level `help`, `effort` and `fast`. `plan` is left out on purpose: the
 * slot is keyed by name only, and DSH's own `/plan` rows in non-ACP sessions must keep Chat's card.
 */
export const COMMAND_RESULT_COMMANDS: readonly string[] = [
  'help',
  'effort',
  'fast',
  'status',
  'context',
  'usage',
  'cost',
  'stats',
  'memory',
  'skills',
  'hooks',
  'permissions',
  'allowed-tools',
  'diff',
  'mcp',
  'tasks',
  'bashes',
  'rewind',
  'checkpoint',
  'undo',
  'ps',
  'stop',
  'clean',
  'new',
  'clear',
  'reset',
  'reload-skills',
  'reload-plugins',
]

/** `answer`: the question is quoted above a Markdown answer; `result`: the typed arguments sit in the header. */
export type CommandRowPresentation = 'answer' | 'result'

export type CommandRowState = 'running' | 'success' | 'error'

export interface CommandRowView {
  readonly state: CommandRowState
  /** `/name`, followed for a result row by the typed arguments on one line. */
  readonly title: string
  /** The question of an answer row as typed (line breaks kept); empty for a result row or a bare command. */
  readonly question: string
  /** The Markdown the host returned; empty while running or when it returned nothing. */
  readonly text: string
}

/** The facts of one folded `command/run` + `command/done` pair that a row depends on. */
export type CommandRowNode = Pick<CommandNode, 'name' | 'args' | 'outcome'>

export function commandRowView(node: CommandRowNode, presentation: CommandRowPresentation): CommandRowView {
  // `args` is the raw input after the name, separator included; null when the host did not record it.
  const input = (node.args ?? '').trim()
  const name = node.name === null ? '' : `/${node.name}`
  const text = node.outcome?.text ?? ''
  return {
    state: node.outcome === null ? 'running' : node.outcome.kind === 'error' ? 'error' : 'success',
    title: presentation === 'result' && input !== '' ? `${name} ${input.replace(/\s+/g, ' ')}` : name,
    question: presentation === 'answer' ? input : '',
    text: text.trim() === '' ? '' : text,
  }
}
