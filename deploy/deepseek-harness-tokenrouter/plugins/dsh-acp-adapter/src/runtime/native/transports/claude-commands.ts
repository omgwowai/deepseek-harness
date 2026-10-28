/**
 * Claude Code slash commands as DSH surfaces them (the built-ins of Claude Code 2.1.296).
 *
 * How a command reaches the CLI decides its dispatch:
 *  - `side` / `immediate`: terminal-bound commands (`local-jsx`, `thinClientDispatch: "control-request"`) that the CLI
 *    answers "isn't available in this environment" when sent as text. A thin client has to implement them with the
 *    control request that backs them, so the transport answers them without a turn.
 *  - `prompt`: everything the CLI's SDK command table runs from user text (prompt commands, skills, custom and plugin
 *    commands, and its local commands that answer in-line, such as `/clear` and `/config`): DSH sends `/name args`.
 *
 * The transport merges the CLI's own catalog (`initialize.commands`, `commands_changed`, `reload_plugins`) into this list at
 * runtime; see `claudeCommandCatalog`.
 */
import { isRecord } from './claude-controls.ts'
import type { NativeCommand } from './contract.ts'

export const CLAUDE_NATIVE_COMMANDS: readonly NativeCommand[] = [
  // -- answered by a control request, no turn -------------------------------------------------------------------------
  {
    name: 'btw',
    description: 'Ask a quick side question without interrupting the main conversation',
    hint: '<question>',
    dispatch: 'side',
  },
  { name: 'status', description: 'Show the Claude Code version, session, model and environment', dispatch: 'immediate' },
  { name: 'context', description: 'Show how the context window is used, by category', dispatch: 'immediate' },
  { name: 'usage', description: 'Show the session cost, token totals and plan usage', aliases: ['cost', 'stats'], dispatch: 'immediate' },
  { name: 'memory', description: 'Show the memory files Claude Code loads and the auto-memory state', dispatch: 'immediate' },
  { name: 'skills', description: 'List the available skills with their token cost', dispatch: 'immediate' },
  { name: 'hooks', description: 'Show the configured hooks', dispatch: 'immediate' },
  { name: 'permissions', description: 'Show the permission rules and extra working directories', aliases: ['allowed-tools'], dispatch: 'immediate' },
  { name: 'diff', description: 'Show the uncommitted changes of the workspace', dispatch: 'immediate' },
  {
    name: 'mcp',
    description: 'Show the MCP servers, or reconnect, enable or disable one',
    hint: '[reconnect|enable|disable [<server>|all]]',
    dispatch: 'immediate',
  },
  {
    name: 'tasks',
    description: 'List background tasks, stop one, or read the output of a shell task',
    aliases: ['bashes'],
    hint: '[stop <id> | output <id>]',
    dispatch: 'immediate',
  },
  {
    name: 'rewind',
    description: 'Roll the conversation and the files Claude changed back to just before an earlier message',
    aliases: ['checkpoint', 'undo'],
    hint: '[<n> [code|chat] [confirm]]',
    dispatch: 'immediate',
  },
  { name: 'reload-skills', description: 'Pick up skills added or changed on disk during this session', dispatch: 'immediate' },
  { name: 'reload-plugins', description: 'Activate pending plugin changes in this session', dispatch: 'immediate' },

  // -- run by the CLI from user text (a turn) ------------------------------------------------------------------------
  { name: 'compact', description: 'Compact the conversation (native /compact)', hint: '[instructions]', dispatch: 'prompt' },
  {
    name: 'clear',
    description: 'Start a new session with empty context; the previous session stays on disk',
    aliases: ['reset', 'new'],
    hint: '[name]',
    dispatch: 'prompt',
  },
  { name: 'init', description: 'Initialize a CLAUDE.md file with codebase documentation', dispatch: 'prompt' },
  { name: 'config', description: 'Set a Claude Code setting by key', aliases: ['settings'], hint: 'key=value', dispatch: 'prompt' },
  { name: 'output-style', description: 'List output styles or switch to one', hint: '[style]', dispatch: 'prompt' },
  { name: 'rename', description: 'Rename the current conversation', aliases: ['name'], hint: '[name]', dispatch: 'prompt' },
  { name: 'autocompact', description: 'Configure the auto-compact window size', hint: '[auto|<tokens>]', dispatch: 'prompt' },
  { name: 'list-agents', description: 'List subagents, teammates and other Claude sessions you can message', aliases: ['peers'], dispatch: 'prompt' },
  { name: 'goal', description: 'Set a goal and keep working until a condition is met; show or clear it', hint: '[<condition> | clear]', dispatch: 'prompt' },
  { name: 'recap', description: 'Generate a one-line recap of the session', dispatch: 'prompt' },
  { name: 'insights', description: 'Generate a report analyzing your Claude Code sessions', dispatch: 'prompt' },
  { name: 'security-review', description: 'Review the pending changes on the current branch for security issues', dispatch: 'prompt' },
  { name: 'team-onboarding', description: 'Create a guide that helps teammates ramp on Claude Code, from your usage', dispatch: 'prompt' },
  {
    name: 'code-review',
    description: 'Review the current diff, or a PR, branch or path, for correctness bugs',
    aliases: ['review'],
    hint: '[low|medium|high|xhigh|max] [--fix] [--comment] [<pr#>|<branch>|<path>] [--max-findings <n>|all]',
    dispatch: 'prompt',
  },
  { name: 'simplify', description: 'Review the changed code for reuse and simplification, then apply the fixes', hint: '[<target>]', dispatch: 'prompt' },
  { name: 'batch', description: 'Plan a large change and run it in parallel across isolated worktree agents', hint: '<instruction>', dispatch: 'prompt' },
  { name: 'debug', description: 'Enable debug logging for this session and help diagnose issues', hint: '[issue description]', dispatch: 'prompt' },
  { name: 'verify', description: 'Verify that a code change does what it should by exercising it end to end', dispatch: 'prompt' },
  { name: 'loop', description: 'Run a prompt or slash command on a recurring interval', aliases: ['proactive'], hint: '[interval] [prompt]', dispatch: 'prompt' },
  { name: 'run', description: "Launch and drive this project's app to see a change working", dispatch: 'prompt' },
  { name: 'run-skill-generator', description: 'Author or improve the per-project run skill', dispatch: 'prompt' },
  { name: 'deep-research', description: 'Fan out web searches, verify the claims and write a cited report', dispatch: 'prompt' },
  { name: 'fewer-permission-prompts', description: 'Add an allowlist for common read-only calls from your transcripts', dispatch: 'prompt' },
  { name: 'update-config', description: 'Configure Claude Code through settings.json', dispatch: 'prompt' },
  { name: 'claude-api', description: 'Reference for the Claude API and the Anthropic SDKs', dispatch: 'prompt' },
  { name: 'dataviz', description: 'Create charts, graphs and other data visualizations', dispatch: 'prompt' },
  { name: 'workflow-authoring', description: 'Reference for writing a Workflow tool script', dispatch: 'prompt' },
  { name: 'plugin-authoring', description: "Change Claude's own interface or behaviour with a mod", dispatch: 'prompt' },
]

/** The subset of `slash_commands` Claude Code 2.1.296 binds to its terminal; the first `system/init` confirms or corrects it. */
export const CLAUDE_TERMINAL_COMMANDS: readonly string[] = ['doctor', 'color', 'focus', 'reload-plugins']

/**
 * Commands the CLI lists that a person has no use for, that DSH answers with the session controls (model picker, effort
 * level, fast mode), or that claude-agent-acp never advertised (login flows, terminal help, the diagnostic wizards).
 */
const HIDDEN_COMMANDS: Readonly<Record<string, true>> = {
  // Diagnostic and machine-driven entries.
  heapdump: true,
  '__remote-workflow': true,
  'workflow-launch-exec': true,
  // The agents wizard was removed; only a stub that says so is left.
  agents: true,
  // A wizard driven by request ids and checksums, not typed by hand.
  'auto-mode-setup': true,
  // The session controls cover them.
  model: true,
  effort: true,
  fast: true,
  // Terminal-only flows.
  'keybindings-help': true,
  login: true,
  logout: true,
  'output-style:new': true,
  'release-notes': true,
  todos: true,
}

/** Static, name-keyed view of the built-ins: the curated description and hint of a command the CLI also lists. */
const CURATED: Readonly<Record<string, NativeCommand>> = Object.fromEntries(CLAUDE_NATIVE_COMMANDS.map((command) => [command.name, command]))

/** True for a command the CLI lists that this transport must not offer: internal, session-controlled, or terminal-bound. */
function isHidden(name: string, terminal: readonly string[]): boolean {
  return Object.hasOwn(HIDDEN_COMMANDS, name) || name.startsWith('design-') || terminal.includes(name)
}

const DESCRIPTION_LIMIT = 160

/** First line of a vendor description, cut at a word boundary: the palette shows one line. */
function shortDescription(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const line = value.replace(/\s+/g, ' ').trim()
  if (line === '') return undefined
  if (line.length <= DESCRIPTION_LIMIT) return line
  const cut = line.slice(0, DESCRIPTION_LIMIT)
  const space = cut.lastIndexOf(' ')
  return `${(space > DESCRIPTION_LIMIT / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

function hintOf(value: unknown): string | undefined {
  const hint = Array.isArray(value) ? value.filter((part): part is string => typeof part === 'string').join(' ') : value
  return typeof hint === 'string' && hint.trim() !== '' ? hint.trim() : undefined
}

/**
 * The catalog DSH shows for a session: the commands this transport answers itself, then every command of the CLI's own
 * list as a `prompt` command. `live` is the raw `commands` array of the CLI (`{ name, description, argumentHint, aliases? }`);
 * while it is unknown the built-ins stand in for it. An MCP server's prompt is listed by the CLI as `server:prompt (MCP)` and
 * typed as `/mcp:server:prompt` in DSH, which the runtime rewrites back.
 */
export function claudeCommandCatalog(live: unknown, terminal: readonly string[]): NativeCommand[] {
  const catalog: NativeCommand[] = []
  const taken = new Set<string>()
  const take = (command: NativeCommand): void => {
    catalog.push(command)
    taken.add(command.name)
    for (const alias of command.aliases ?? []) taken.add(alias)
  }
  for (const command of CLAUDE_NATIVE_COMMANDS) if (command.dispatch !== 'prompt') take(command)
  if (!Array.isArray(live)) {
    for (const command of CLAUDE_NATIVE_COMMANDS) if (command.dispatch === 'prompt' && !isHidden(command.name, terminal)) take(command)
    return catalog
  }
  for (const entry of live) {
    if (!isRecord(entry) || typeof entry['name'] !== 'string' || entry['name'] === '') continue
    const name = entry['name'].endsWith(' (MCP)') ? `mcp:${entry['name'].slice(0, -' (MCP)'.length)}` : entry['name']
    if (taken.has(name) || isHidden(name, terminal)) continue
    const known = Object.hasOwn(CURATED, name) ? CURATED[name] : undefined
    const hint = hintOf(entry['argumentHint']) ?? known?.hint
    const aliases = (Array.isArray(entry['aliases']) ? entry['aliases'] : []).filter(
      (alias): alias is string => typeof alias === 'string' && alias !== '' && !taken.has(alias) && !isHidden(alias, terminal),
    )
    take({
      name,
      description: known?.description ?? shortDescription(entry['description']) ?? `Run /${name}`,
      ...(hint === undefined ? {} : { hint }),
      ...(aliases.length === 0 ? {} : { aliases }),
      dispatch: 'prompt',
    })
  }
  return catalog
}

/** The canonical name of an `immediate` command typed under its name or one of its aliases. */
export function resolveClaudeImmediateCommand(name: string): string | undefined {
  const wanted = name.trim().replace(/^\//, '')
  return CLAUDE_NATIVE_COMMANDS.find(
    (command) => command.dispatch === 'immediate' && (command.name === wanted || command.aliases?.includes(wanted) === true),
  )?.name
}
