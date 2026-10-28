/**
 * Oh My Pi slash commands as DSH surfaces them: the catalog omp 18.12.6 advertises in `available_commands_update`
 * (the builtins that run in-process under `--mode rpc-ui`, plus the commands that ship with the package), and the
 * terminal-only builtins the transport serves itself because omp's rpc `prompt` would send them to the model as
 * plain text. The live catalog replaces the advertised `prompt` entries once omp reports it (user commands, skills,
 * extensions); the served entries stay.
 */
import type { NativeCommand } from './contract.ts'

/**
 * The commands the transport answers itself, in the order the table lists them first. `btw`, `new`, `clear` and
 * `rewind` are rpc calls of their own (`btw`, `new_session`, `get_entries` + `branch`). `goal` is rpc `goal`, but it is
 * a `prompt` command: an active goal makes omp start runs on its own (when its config lets rpc hosts continue goals),
 * and only a turn the host holds open can show them and stop them.
 */
export const OMP_SERVED_COMMAND_NAMES: readonly string[] = ['btw', 'new', 'clear', 'rewind', 'goal']

export const OMP_NATIVE_COMMANDS: readonly NativeCommand[] = [
  // Terminal-only in omp (no rpc handler), served by the transport.
  {
    name: 'btw',
    description: "Ask a side question without interrupting the agent's current turn",
    hint: '<question>',
    dispatch: 'side',
  },
  { name: 'new', description: 'Start a new session', dispatch: 'immediate' },
  { name: 'clear', description: 'Clear the conversation context (starts a new session)', dispatch: 'immediate' },
  {
    name: 'rewind',
    description: 'Go back to just before one of your earlier messages: the conversation, the files, or both',
    hint: '[<n> [code|chat] [confirm]]',
    dispatch: 'immediate',
  },
  {
    name: 'goal',
    description: 'Set a goal Oh My Pi keeps working towards, or show, pause, resume or clear it',
    hint: '[<objective>|clear|pause|resume]',
    dispatch: 'prompt',
  },
  {
    name: 'security',
    description: 'Plan, run, inspect, import, and compare OMP-native security scans',
    hint: '<plan|scan|status|cancel|scans|show|import|export|validate|compare|disposition>',
    dispatch: 'prompt',
  },
  { name: 'model', description: 'Show current model selection', aliases: ['models'], dispatch: 'prompt' },
  { name: 'switch', description: 'Switch model for this session only', hint: '[model]', dispatch: 'prompt' },
  { name: 'fast', description: 'Toggle fast mode', hint: '[on|ultra|off|status]', dispatch: 'prompt' },
  { name: 'slow', description: 'Toggle slow mode', hint: '[on|off|status]', dispatch: 'prompt' },
  { name: 'skillful', description: 'Toggle skill listing', hint: '[on|off|status]', dispatch: 'prompt' },
  { name: 'extended-context', description: 'Toggle extended context', hint: '[on|off|status]', dispatch: 'prompt' },
  { name: 'computer', description: 'Toggle computer use', hint: '[on|off|status]', dispatch: 'prompt' },
  {
    name: 'ratchet',
    description: 'Build (or reuse) an eval for an LLM flow, then hillclimb it unattended',
    hint: '[flow and goal]',
    dispatch: 'prompt',
  },
  { name: 'prewalk', description: 'Arm, restart, or cancel prewalk', hint: '[restart|off]', dispatch: 'prompt' },
  {
    name: 'modelpreset',
    description: 'Manage model presets',
    hint: '[list|save|switch|delete] [name]',
    dispatch: 'prompt',
  },
  {
    name: 'effort',
    description: 'Set or show reasoning effort (thinking level, intelligence)',
    hint: '[level]',
    dispatch: 'prompt',
  },
  { name: 'advisor', description: 'Toggle advisor', hint: '[on|off|status|dump [raw]|configure]', dispatch: 'prompt' },
  { name: 'export', description: 'Export session to HTML file', hint: '[--themes] [path]', dispatch: 'prompt' },
  { name: 'trace', description: "Open this session's trace in the stats dashboard", dispatch: 'prompt' },
  {
    name: 'dump',
    description: 'Return full transcript as plain text, with LLM request JSON path',
    hint: '[all|anon]',
    dispatch: 'prompt',
  },
  {
    name: 'share',
    description: 'Share session via an encrypted link (share server or secret gist)',
    dispatch: 'prompt',
  },
  {
    name: 'browser',
    description: 'Toggle browser eval-prelude headless vs visible mode',
    hint: '[headless|visible]',
    dispatch: 'prompt',
  },
  { name: 'todo', description: 'Manage todos', hint: '<subcommand>', dispatch: 'prompt' },
  {
    name: 'session',
    description: 'Show or configure the current session',
    hint: '[info|delete|pin [account]]',
    dispatch: 'prompt',
  },
  { name: 'jobs', description: 'Show background jobs', hint: '[full|kill <id>|kill all]', dispatch: 'prompt' },
  {
    name: 'usage',
    description: 'Show token usage',
    hint: '[show|reset [provider/credential-id|provider/active]]',
    dispatch: 'prompt',
  },
  {
    name: 'stats',
    description: 'Launch the local stats dashboard',
    hint: '[--port <port>] [--host <host>]',
    dispatch: 'prompt',
  },
  { name: 'changelog', description: 'Show changelog', hint: '[full|last [N]]', dispatch: 'prompt' },
  { name: 'tools', description: 'Show available tools', dispatch: 'prompt' },
  { name: 'context', description: 'Show context usage', dispatch: 'prompt' },
  { name: 'mcp', description: 'Manage MCP servers', hint: '<subcommand>', dispatch: 'prompt' },
  { name: 'ssh', description: 'Manage SSH connections', hint: '<subcommand>', dispatch: 'prompt' },
  {
    name: 'fresh',
    description: 'Reset provider stream state without changing the local transcript',
    dispatch: 'prompt',
  },
  {
    name: 'compact',
    description: 'Compact the conversation',
    hint: '[soft|remote|snapcompact] [focus]',
    dispatch: 'prompt',
  },
  {
    name: 'shake',
    description: 'Shake heavy content out of the conversation context',
    hint: '[elide|images|thinking]',
    dispatch: 'prompt',
  },
  {
    name: 'handoff',
    description: 'Summarize the session into a handoff document and compact in place',
    hint: '[focus instructions]',
    dispatch: 'prompt',
  },
  {
    name: 'pin',
    description: 'Pin or unpin a session at the top of the resume list',
    hint: '[session id]',
    dispatch: 'prompt',
  },
  { name: 'retry', description: 'Retry the last failed agent turn', dispatch: 'prompt' },
  { name: 'memory', description: 'Manage memory', hint: '<subcommand>', dispatch: 'prompt' },
  {
    name: 'rename',
    description: 'Rename the current session (omit title to generate)',
    hint: '[title]',
    dispatch: 'prompt',
  },
  {
    name: 'move',
    description: 'Move the current session to a different directory',
    hint: '[<path>]',
    dispatch: 'prompt',
  },
  {
    name: 'wt',
    description: 'Move this session into a new worktree, changes included',
    hint: '[<branch>]',
    aliases: ['worktree'],
    dispatch: 'prompt',
  },
  { name: 'add-dir', description: 'Add a workspace directory to this session', hint: '<path>', dispatch: 'prompt' },
  {
    name: 'remove-dir',
    description: 'Remove a workspace directory from this session',
    hint: '<path>',
    dispatch: 'prompt',
  },
  { name: 'dirs', description: "List this session's workspace directories", dispatch: 'prompt' },
  { name: 'marketplace', description: 'Manage plugins from marketplaces', hint: '<subcommand>', dispatch: 'prompt' },
  {
    name: 'plugins',
    description: 'Manage plugins',
    hint: '[list|enable|disable]',
    aliases: ['plugin'],
    dispatch: 'prompt',
  },
  { name: 'reload-plugins', description: 'Reload all plugins', dispatch: 'prompt' },
  {
    name: 'force',
    description: 'Force next turn to use a specific tool',
    hint: '<tool-name> [prompt]',
    aliases: ['force:'],
    dispatch: 'prompt',
  },
  {
    name: 'forget-approvals',
    description: 'Forget every file and folder approval Ask and remember has recorded',
    dispatch: 'prompt',
  },
  {
    name: 'autoresearch',
    description: 'Toggle builtin autoresearch mode, or pass off / clear, or a goal message.',
    hint: 'arguments',
    dispatch: 'prompt',
  },
  {
    name: 'green',
    description: 'Generate a prompt to iterate on CI failures until the branch is green',
    hint: 'arguments',
    dispatch: 'prompt',
  },
  { name: 'review', description: 'Launch interactive code review', hint: 'arguments', dispatch: 'prompt' },
  {
    name: 'annotate',
    description: 'Annotate a diff or text from a file, prompt, latest reply, or session',
    hint: 'arguments',
    dispatch: 'prompt',
  },
  { name: 'init', description: 'Generate AGENTS.md for current codebase', dispatch: 'prompt' },
]

/**
 * Builtins without a text-mode handler (omp 18.12.6, `BUILTIN_SLASH_COMMANDS_INTERNAL` entries lacking `handle`),
 * aliases included. omp's `prompt` path hands them to the model as ordinary text; the transport refuses them
 * unless the live catalog gives the same name to an extension, custom or file command, which omp runs first.
 */
export const OMP_TERMINAL_ONLY_COMMANDS: readonly string[] = [
  'settings',
  'setup',
  'plan',
  'plan-review',
  'vibe',
  'goal',
  'guided-goal',
  'loop',
  'queue',
  'collab',
  'join',
  'leave',
  'copy',
  'open',
  'hotkeys',
  'extensions',
  'agents',
  'git',
  'hub',
  'branch',
  'fork',
  'tree',
  'login',
  'logout',
  'new',
  'clear',
  'delete',
  'seance',
  'resume',
  'btw',
  'tan',
  'omfg',
  'cleanse',
  'debug',
  'exit',
  'restart',
  'skills',
  'live',
  'record',
  'pause',
  'quit',
  'providers',
  'status',
  'rewind',
  'q',
]
