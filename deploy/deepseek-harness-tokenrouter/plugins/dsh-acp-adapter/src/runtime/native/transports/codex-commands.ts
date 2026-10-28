/**
 * Codex slash commands as DSH surfaces them (static built-ins of codex-cli 0.162.1). The app-server has no
 * slash-command layer: every command of the TUI is client code over JSON-RPC, so each entry below is
 * implemented by the transport itself (`codex.ts`), and the name of every TUI command that is not implemented
 * is listed in {@link CODEX_UNSUPPORTED_COMMANDS} so that typing one never reaches the model as plain text.
 *
 * `codex-rs/tui/src/slash_command.rs` has 63 variants: 17 are implemented here (`side`+`btw`, `status`,
 * `skills`, `mcp`, `ps`, `stop`, `hooks`, `diff`, `new`, `clear`, `compact`, `review`, `init`, `rename`,
 * `plan`, `goal`), the other 46 are in the unsupported table (plus the aliases `cwd` and `pet`). `review-branch`,
 * `review-commit` and `rewind` are not TUI commands: codex-acp offers the first two and DSH keeps them, and `rewind`
 * is DSH's (the conversation goes back with `thread/revert`; the files, which Codex does not checkpoint, from the changes the agent recorded).
 */
import type { NativeCommand } from './contract.ts'

export const CODEX_NATIVE_COMMANDS: readonly NativeCommand[] = [
  {
    name: 'side',
    description: 'Ask a side question in an ephemeral fork; the main thread is untouched',
    hint: '<question>',
    aliases: ['btw'],
    dispatch: 'side',
  },
  { name: 'status', description: 'Show the session configuration and token usage', dispatch: 'immediate' },
  {
    name: 'skills',
    description: 'List the skills Codex offers, or turn one on or off',
    hint: '[enable|disable <name>]',
    dispatch: 'immediate',
  },
  {
    name: 'mcp',
    description: 'List MCP servers and their tools; sign in to a server',
    hint: '[verbose | login <name>]',
    dispatch: 'immediate',
  },
  { name: 'ps', description: 'List the background terminals', dispatch: 'immediate' },
  {
    name: 'stop',
    description: 'Stop the background terminals, or one of them',
    hint: '[process id]',
    aliases: ['clean'],
    dispatch: 'immediate',
  },
  { name: 'hooks', description: 'List the lifecycle hooks and their trust status', dispatch: 'immediate' },
  { name: 'diff', description: 'Show the git diff of the workspace, including untracked files', dispatch: 'immediate' },
  {
    name: 'new',
    description: 'Start a new Codex conversation (the current one stays in the Codex history)',
    hint: '[name]',
    dispatch: 'immediate',
  },
  {
    name: 'clear',
    description: 'Clear the context and start a new Codex conversation',
    hint: '[name]',
    dispatch: 'immediate',
  },
  { name: 'compact', description: 'Summarize the conversation to prevent hitting the context limit', dispatch: 'prompt' },
  {
    name: 'review',
    description: 'Review the uncommitted changes, or review with custom instructions',
    hint: '[instructions]',
    dispatch: 'prompt',
  },
  { name: 'review-branch', description: 'Review the changes relative to a base branch', hint: '<branch>', dispatch: 'prompt' },
  { name: 'review-commit', description: 'Review a specific commit', hint: '<sha>', dispatch: 'prompt' },
  { name: 'init', description: 'Create an AGENTS.md file with instructions for Codex', dispatch: 'prompt' },
  { name: 'rename', description: 'Rename the current Codex thread', hint: '<name>', dispatch: 'prompt' },
  { name: 'plan', description: 'Switch to Plan mode', hint: '[message]', dispatch: 'prompt' },
  {
    name: 'goal',
    description: 'Set a goal Codex keeps working towards, or show, pause, resume or clear it',
    hint: '[<objective>|clear|pause|resume]',
    dispatch: 'prompt',
  },
  {
    name: 'rewind',
    description: 'Go back to just before one of your earlier messages: the conversation, the files, or both',
    hint: '[<n> [code|chat] [confirm]]',
    dispatch: 'immediate',
  },
]

/**
 * TUI commands with no counterpart in DSH: they configure the terminal (`vim`, `theme`, `keymap`, …), leave it
 * (`quit`), need a ChatGPT login (`usage`, `apps`), or belong to a DSH surface of its own (`model`,
 * `feedback`, `export`, session and directory management). Aliases included.
 */
export const CODEX_UNSUPPORTED_COMMANDS: Readonly<Record<string, true>> = {
  model: true,
  daybreak: true,
  ide: true,
  permissions: true,
  keymap: true,
  vim: true,
  'setup-default-sandbox': true,
  experimental: true,
  approve: true,
  memories: true,
  import: true,
  archive: true,
  delete: true,
  resume: true,
  fork: true,
  worktree: true,
  app: true,
  recap: true,
  voice: true,
  agents: true,
  copy: true,
  export: true,
  raw: true,
  tui: true,
  mention: true,
  daemon: true,
  warnings: true,
  cd: true,
  pwd: true,
  cwd: true,
  usage: true,
  'debug-config': true,
  title: true,
  statusline: true,
  theme: true,
  pets: true,
  pet: true,
  apps: true,
  plugins: true,
  logout: true,
  quit: true,
  exit: true,
  feedback: true,
  rollout: true,
  'test-approval': true,
  subagents: true,
  'debug-m-drop': true,
  'debug-m-update': true,
}

/** Whether `name` (lower case) is a TUI command DSH does not carry. */
export function isUnsupportedCodexCommand(name: string): boolean {
  return Object.hasOwn(CODEX_UNSUPPORTED_COMMANDS, name)
}

/** The canonical name of a built-in command or of one of its aliases (lower case), else `undefined`. */
export function canonicalCodexCommand(name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const command of CODEX_NATIVE_COMMANDS) {
    if (command.name === lower || command.aliases?.includes(lower) === true) return command.name
  }
  return undefined
}

/** The answer to a TUI command DSH does not carry; nothing reaches the model. */
export function unsupportedCodexCommandMessage(name: string): string {
  return `\`/${name}\` belongs to the Codex terminal interface and is not available through DSH. Nothing was sent to the model.`
}
