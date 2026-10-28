/**
 * The slash commands of a native ACP agent as DSH host commands.
 *
 * DSH's composer claims only commands the host registered, and a registered command runs on Enter whether or not a turn
 * is running, without becoming a turn: its `command/run` and `command/done` rows are the only log entries it writes,
 * and it never reaches the model's history. For every live Agent on an ACP route this module registers, as agent-scoped
 * commands, the vendor's commands (its own catalog once the agent reported one, its built-in table before that), each
 * run the way the transport classified it (`NativeCommand.dispatch`):
 *
 * - `side`: the adapter's side question answers it from the conversation without adding to it (`/btw`);
 * - `immediate`: the transport runs it outside any turn and answers with Markdown;
 * - `prompt`: it is queued as a follow-up prompt `/name args`, which the vendor runs as a turn (`/compact` always was).
 *
 * The host adds `help`, `effort`, `fast` and, for the agents that have a native plan mode (Claude Code, Codex), `plan`.
 * Names DSH cannot register (`mcp:server:prompt`) keep working as typed text. `model` and `file` belong to the client
 * (a host command of either name breaks the `/` menu), `export feedback permission` stay DSH's, and an agent
 * without a native plan mode (Oh My Pi) keeps DSH's own `/plan`. `goal` is the agent's own goal mode when its catalog
 * has one: it shadows DSH's goal for that agent only, so DSH's `/goal` stays for an agent that has none and on every
 * ACP route that is not a native one. An ACP agent that is not a native one keeps the `/compact` shadow it always
 * had: DSH's own compaction needs a model call that an ACP route refuses.
 *
 * Registrations follow the agent: they are rebuilt when its catalog changes and when a draft session switches to (or
 * away from) an ACP model. Handlers never throw for an expected failure; they answer `{ kind: 'error', text }`.
 */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { createUserMessage, type LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { normalizeAcpConfigOptionKey } from '../../contract/config-options.ts'
import type { AcpAgentSessionOptionWrite, AcpAgentSessionSnapshotView, AcpConfigOption } from '../../contract/remote.ts'
import type { AcpLogger } from '../../domain/observability/logging.ts'
import type {
  NativeCommand,
  NativeCommandResult,
  NativeTransportKind,
} from '../../runtime/native/transports/contract.ts'
import { accessProvider } from './native-agent-access.ts'

/** The slice of an ACP profile adapter this module uses; `AcpProfileAdapter` implements it. */
export interface NativeCommandAdapter {
  nativeCommands(sessionId: string): readonly NativeCommand[]
  watchNativeCommands(listener: (sessionId: string) => void): () => void
  runNativeCommand(sessionId: string, name: string, args: string, signal: AbortSignal): Promise<NativeCommandResult>
  sideQuestion(sessionId: string, question: string, signal: AbortSignal): Promise<NativeCommandResult>
  draftSessionSnapshot(sessionId: string): Promise<AcpAgentSessionSnapshotView | null>
  setDraftMode(sessionId: string, modeId: string): Promise<AcpAgentSessionSnapshotView | null>
  setNativeSessionOption(
    sessionId: string,
    request: AcpAgentSessionOptionWrite,
    signal: AbortSignal,
  ): Promise<AcpAgentSessionSnapshotView>
  resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
}

/** What the installed-profile registry knows about the agent an LLM route belongs to. */
export interface NativeCommandRoute {
  readonly adapter: NativeCommandAdapter
  /** The native transport the agent runs on; absent for an ACP agent that is not a native one. */
  readonly kind: NativeTransportKind | undefined
}

export interface NativeCommandRoutes {
  /** The ACP route behind a provider id, or `undefined` for a provider that is not an ACP route. */
  resolve(provider: string | undefined): NativeCommandRoute | undefined
}

export interface NativeCommandBridge {
  /** Resolves once every agent's registrations match its route and catalog (a test seam; hosts never wait). */
  idle(): Promise<void>
}

/** What a command handler is given (`dsh-commands` `CommandInvocation`, the part used here). */
interface CommandInvocation {
  readonly agent: Agent
  readonly rawInput: string
  readonly signal: AbortSignal
}

type CommandOutcome =
  { readonly kind: 'success'; readonly text?: string } | { readonly kind: 'error'; readonly text: string }

/** A DSH command definition (`dsh-commands` `CommandDefinition`, the part used here). */
interface CommandDefinition {
  readonly name: string
  readonly description: string
  /** Present = the composer claims `/name args`; absent = only the bare `/name`. */
  readonly input?: { readonly hint: string }
  readonly handler: (invocation: CommandInvocation) => CommandOutcome | Promise<CommandOutcome>
}

/** The slice of DSH's command registry this module uses (`ctx.commands`, injected by name). */
interface CommandRegistryLike {
  register(definition: CommandDefinition): () => void
}

function isCommandRegistry(value: unknown): value is CommandRegistryLike {
  return typeof value === 'object' && value !== null && 'register' in value && typeof value.register === 'function'
}

/** One row of `/help`. */
interface HelpRow {
  readonly usage: string
  readonly does: string
  readonly runs: string
}

/** What one agent's registrations are made of; two plans with the same signature register the same commands. */
interface CommandPlan {
  readonly signature: string
  readonly agentName: string
  readonly definitions: readonly CommandDefinition[]
  readonly help: readonly HelpRow[]
  /** Vendor commands whose names DSH cannot register: they keep working as typed text. */
  readonly typed: readonly string[]
}

interface AgentState {
  /** What the agent's registrations should be, and what they are. */
  target: CommandPlan | undefined
  mounted: CommandPlan | undefined
  fiber: Fiber | undefined
  /** A pass that brings `mounted` to `target` is running; `settling` is that pass, or the last one. */
  draining: boolean
  settling: Promise<void> | undefined
  /** The mode `/plan` replaced, so that `/plan off` gives it back. */
  planBackup: string | undefined
}

/** What the handlers need from the installation around them. */
interface BridgeEnv {
  readonly ctx: Context
  /** The route the agent runs on right now; a route that went away answers `undefined`. */
  serving(agent: Agent): NativeCommandRoute | undefined
  stateOf(agent: Agent): AgentState | undefined
}

/** DSH command names (`dsh-commands`): anything else cannot be registered. */
const DSH_COMMAND_NAME = /^[a-z][a-z0-9_-]*$/

/** The client contributes `/model` and `/file`: a host command of either name breaks the whole `/` menu. */
const CLIENT_COMMANDS: readonly string[] = ['model', 'file']

/** DSH's own commands that stay DSH's, whatever the vendor offers under the same name. */
const DSH_COMMANDS: readonly string[] = ['export', 'feedback', 'permission']

/** What `/help` lists as DSH's own: `/goal` too, unless the agent's own goal mode took its name. */
const DSH_HELP_COMMANDS: readonly string[] = ['goal', ...DSH_COMMANDS, 'model']

/** The host answers these itself for a native agent: a vendor command of the same name is not registered. */
const HOST_COMMANDS: readonly string[] = ['help', 'plan', 'effort', 'fast']

/** Palette hint of a vendor command that declares no arguments: the line still carries whatever was typed. */
const ANY_ARGUMENTS = '[arguments]'

const AGENT_NAMES: Readonly<Record<NativeTransportKind, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  omp: 'Oh My Pi',
}

const RUNS = {
  side: 'on the side; the agent keeps working',
  immediate: 'at once, without a turn',
  prompt: 'as a turn',
} as const

const NO_CONVERSATION = 'There is no agent conversation in this session yet. Send a message first, then try again.'
const GONE = 'This agent is no longer available in DSH.'

/** The sentence `/compact` has always answered with. */
const COMPACT_SENT = 'Sent /compact to the Agent; it compacts its own context.'

/**
 * How the native plan mode of each agent is read and written. Claude Code has it as one of its permission modes (saved
 * for the next prompt before the first one, queued while a turn runs); Codex as its collaboration mode, an option of
 * the running session.
 */
interface PlanControl {
  readonly on: string
  /** Where `/plan off` goes when it is not known what the mode was before. */
  readonly off: string
  read(snapshot: AcpAgentSessionSnapshotView): string | undefined
  write(adapter: NativeCommandAdapter, sessionId: string, value: string, signal: AbortSignal): Promise<unknown>
}

const CODEX_COLLABORATION_OPTION = 'collaboration_mode'

const PLAN_CONTROLS: Readonly<Partial<Record<NativeTransportKind, PlanControl>>> = {
  claude: {
    on: 'plan',
    off: 'default',
    read: (snapshot) => snapshot.pendingModeId ?? snapshot.currentModeId ?? 'default',
    write: (adapter, sessionId, value) => adapter.setDraftMode(sessionId, value),
  },
  codex: {
    on: 'plan',
    off: 'default',
    read: (snapshot) => {
      const option = snapshot.configOptions?.find((candidate) => candidate.id === CODEX_COLLABORATION_OPTION)
      return option === undefined ? undefined : String(snapshot.pendingOptions?.[option.id] ?? option.currentValue)
    },
    write: (adapter, sessionId, value, signal) =>
      adapter.setNativeSessionOption(sessionId, { kind: 'config', id: CODEX_COLLABORATION_OPTION, value }, signal),
  },
}

/** The option that switches fast mode: Claude Code and Codex name it `fast-mode`, Oh My Pi `fast`. */
const FAST_OPTION_IDS: readonly string[] = ['fast', 'fast_mode']

const failure = (text: string): CommandOutcome => ({ kind: 'error', text })

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A command row needs text: an answer the vendor left empty still says that it ran. */
function outcomeOf(result: NativeCommandResult): CommandOutcome {
  if (result.text.trim() !== '') return result
  return result.kind === 'error' ? failure('The command failed without a message.') : { kind: 'success', text: 'Done.' }
}

/** Put a message to the agent as the next prompt of the session, as if the user had sent it. */
function sendToAgent(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
}

/** Queue `/name args` as the agent's next prompt: the vendor runs it as a turn. */
function forwardCommand(agent: Agent, name: string, rawInput: string, text: string): CommandOutcome {
  sendToAgent(agent, `/${name}${rawInput}`)
  return { kind: 'success', text }
}

/** A table cell: one line, no column break. */
function cell(text: string): string {
  return text.replace(/\s+/g, ' ').replaceAll('|', '\\|').trim()
}

function flatValues(option: Extract<AcpConfigOption, { type: 'select' }>): readonly string[] {
  return option.options.flatMap((entry) => ('options' in entry ? entry.options : [entry]).map((value) => value.value))
}

/** `on` / `off` as typed; anything else is not a choice. */
function parseSwitch(text: string): boolean | undefined {
  if (/^(on|true|yes|1)$/i.test(text)) return true
  if (/^(off|false|no|0)$/i.test(text)) return false
  return undefined
}

/** The `/help` answer: every command of the agent, or the one asked for. */
function helpText(plan: CommandPlan, topic: string): CommandOutcome {
  if (topic !== '') {
    const name = topic.replace(/^\//, '')
    const row = plan.help.find((candidate) => candidate.usage.split(/\s/, 1)[0] === `/${name}`)
    if (row === undefined) return failure(`${plan.agentName} has no command /${name} in DSH. /help lists them.`)
    return { kind: 'success', text: `**${row.usage}**\n\n${row.does}\n\nRuns ${row.runs}.` }
  }
  const registered = new Set(plan.definitions.map((definition) => definition.name))
  const own = DSH_HELP_COMMANDS.filter((name) => !registered.has(name)).map((name) => `\`/${name}\``)
  const lines = [
    `**Commands of ${plan.agentName}**`,
    '',
    '| Command | What it does | Runs |',
    '| --- | --- | --- |',
    ...plan.help.map((row) => `| \`${cell(row.usage)}\` | ${cell(row.does)} | ${cell(row.runs)} |`),
    '',
    `DSH's own commands (${own.join(', ')}) work as usual.`,
  ]
  if (plan.typed.length > 0) {
    const shown = plan.typed.slice(0, 20).map((name) => `\`/${name}\``)
    const more = plan.typed.length > shown.length ? ` and ${String(plan.typed.length - shown.length)} more` : ''
    lines.push(
      `The agent also understands ${shown.join(', ')}${more}; they are not in the \`/\` menu, type them as a message.`,
    )
  }
  return { kind: 'success', text: lines.join('\n') }
}

/** The route and model the agent's next request uses: the pending pick, else the last request, else the default. */
function currentSelection(
  ctx: Context,
  agent: Agent,
): { readonly provider: string; readonly model: string; readonly reasoningEffort: string | undefined } | undefined {
  const pending = ctx.get('sessionProjections')?.stateOf(agent.session, 'modelSelection')?.pending
  const source =
    pending ??
    agent.session.requestHeader()?.config ??
    ctx.get('agentDefaultModel')?.currentSelection() ??
    agent.options
  return source.provider === undefined || source.model === undefined
    ? undefined
    : { provider: source.provider, model: source.model, reasoningEffort: source.reasoningEffort }
}

/** A vendor command, run the way its transport classified it. */
function vendorHandler(env: BridgeEnv, command: NativeCommand): CommandDefinition['handler'] {
  switch (command.dispatch) {
    case 'side':
      return async ({ agent, rawInput, signal }) => {
        const question = rawInput.trim()
        if (question === '') return failure(`Usage: /${command.name} ${command.hint ?? '<question>'}`)
        const adapter = env.serving(agent)?.adapter
        if (adapter === undefined) return failure(GONE)
        return outcomeOf(await adapter.sideQuestion(String(agent.session.id), question, signal))
      }
    case 'immediate':
      return async ({ agent, rawInput, signal }) => {
        const adapter = env.serving(agent)?.adapter
        if (adapter === undefined) return failure(GONE)
        return outcomeOf(
          await adapter.runNativeCommand(String(agent.session.id), command.name, rawInput.trim(), signal),
        )
      }
    case 'prompt':
      return ({ agent, rawInput }) =>
        forwardCommand(
          agent,
          command.name,
          rawInput,
          command.name === 'compact' ? COMPACT_SENT : `Sent /${command.name} to the Agent.`,
        )
  }
}

/** `/help [command]`: reads the plan the agent has right now, not the one it had when the command was built. */
function helpDefinition(env: BridgeEnv): CommandDefinition {
  return {
    name: 'help',
    description: 'List the commands of this Agent',
    input: { hint: '[command]' },
    handler: ({ agent, rawInput }) => {
      const plan = env.stateOf(agent)?.target
      return plan === undefined ? failure(GONE) : helpText(plan, rawInput.trim())
    },
  }
}

/** `/plan [off | message]`: the agent's native plan mode instead of DSH's plan text. */
function planDefinition(env: BridgeEnv, kind: NativeTransportKind, control: PlanControl): CommandDefinition {
  return {
    name: 'plan',
    description: `Switch ${AGENT_NAMES[kind]} to plan mode; /plan off goes back, /plan <message> plans that message`,
    input: { hint: '[off | message]' },
    handler: async ({ agent, rawInput, signal }) => {
      const adapter = env.serving(agent)?.adapter
      const state = env.stateOf(agent)
      if (adapter === undefined || state === undefined) return failure(GONE)
      const sessionId = String(agent.session.id)
      const argument = rawInput.trim()
      try {
        const snapshot = await adapter.draftSessionSnapshot(sessionId)
        const current = snapshot === null ? undefined : control.read(snapshot)
        if (current === undefined) return failure(NO_CONVERSATION)
        // A choice made while a turn runs is kept for the next one.
        const later = agent.status === 'running' ? ' from the next turn' : ''
        if (/^off$/i.test(argument)) {
          if (current !== control.on) return { kind: 'success', text: 'Plan mode is already off.' }
          await control.write(adapter, sessionId, state.planBackup ?? control.off, signal)
          state.planBackup = undefined
          return { kind: 'success', text: `Plan mode off${later}.` }
        }
        if (current !== control.on) {
          await control.write(adapter, sessionId, control.on, signal)
          state.planBackup = current
        }
        let text =
          current === control.on
            ? 'Plan mode is already on.'
            : `Plan mode on${later}: the agent plans before it changes anything.`
        if (argument !== '') {
          sendToAgent(agent, argument)
          text += ' Your message was sent to it.'
        }
        return { kind: 'success', text }
      } catch (error: unknown) {
        return failure(describeError(error))
      }
    },
  }
}

/**
 * `/effort [level]`: the reasoning effort of the next turn. DSH's model selection owns it (the agent is set to it before
 * every turn), so it is changed there, the way the model menu changes it, never on the agent behind DSH's back.
 */
function effortDefinition(env: BridgeEnv): CommandDefinition {
  return {
    name: 'effort',
    description: 'Show or set the reasoning effort for the next turn',
    input: { hint: '[level]' },
    handler: async ({ agent, rawInput, signal }) => {
      const adapter = env.serving(agent)?.adapter
      if (adapter === undefined) return failure(GONE)
      const selection = currentSelection(env.ctx, agent)
      if (selection === undefined)
        return failure('No model is selected in this session yet; pick one in the model menu.')
      let info: LlmResolvedModelInfo
      try {
        info = await adapter.resolveModel(selection.provider, selection.model, signal)
      } catch (error: unknown) {
        return failure(`The effort levels of ${selection.model} could not be read: ${describeError(error)}`)
      }
      const efforts = info.reasoning?.efforts ?? []
      if (efforts.length === 0) return failure(`${selection.model} has no effort levels to choose from.`)
      const current = selection.reasoningEffort ?? info.reasoning?.defaultEffort
      const wanted = rawInput.trim().toLowerCase()
      if (wanted === '') {
        const levels = efforts.map(
          (level) => `- ${String(level.id) === current ? `**${level.name}** (current)` : level.name}`,
        )
        const hint = '`/effort <level>` changes it from the next turn; the model menu shows the same setting.'
        return {
          kind: 'success',
          text: [`Reasoning effort of \`${selection.model}\`:`, '', ...levels, '', hint].join('\n'),
        }
      }
      const level = efforts.find(
        (candidate) => String(candidate.id).toLowerCase() === wanted || candidate.name.toLowerCase() === wanted,
      )
      if (level === undefined) {
        const choices = efforts.map((candidate) => String(candidate.id)).join(', ')
        return failure(`"${rawInput.trim()}" is not an effort level of ${selection.model}. Choose one of: ${choices}.`)
      }
      const controller = env.ctx.get('sessionController', false)
      if (controller === undefined)
        return failure('This host cannot change the effort from a command; use the model menu.')
      try {
        await controller.selectModel({
          sessionId: agent.session.id,
          provider: selection.provider,
          model: selection.model,
          reasoningEffort: String(level.id),
        })
      } catch (error: unknown) {
        return failure(describeError(error))
      }
      return { kind: 'success', text: `Effort set to **${level.name}** for the next turn.` }
    },
  }
}

/** `/fast [on | off]`: the fast-mode option of the agent, when its model has one. */
function fastDefinition(env: BridgeEnv): CommandDefinition {
  return {
    name: 'fast',
    description: 'Show or set fast mode',
    input: { hint: '[on | off]' },
    handler: async ({ agent, rawInput, signal }) => {
      const adapter = env.serving(agent)?.adapter
      if (adapter === undefined) return failure(GONE)
      const sessionId = String(agent.session.id)
      try {
        const snapshot = await adapter.draftSessionSnapshot(sessionId)
        const options = snapshot?.configOptions
        if (options === undefined || options === null) return failure(NO_CONVERSATION)
        const option = options.find((candidate) => FAST_OPTION_IDS.includes(normalizeAcpConfigOptionKey(candidate.id)))
        if (option === undefined) return failure('Fast mode is not available for this agent or model.')
        const waiting = snapshot?.pendingOptions?.[option.id]
        const argument = rawInput.trim()
        if (argument === '') {
          const shown = waiting ?? option.currentValue
          const isOn = typeof shown === 'boolean' ? shown : shown === 'on'
          const note = waiting === undefined ? '' : ' (from the next turn)'
          return {
            kind: 'success',
            text: `Fast mode is **${isOn ? 'on' : 'off'}**${note}. \`/fast on\` and \`/fast off\` change it.`,
          }
        }
        const wanted = parseSwitch(argument)
        if (wanted === undefined) return failure('Use /fast on or /fast off.')
        const word = wanted ? 'on' : 'off'
        const value =
          option.type === 'boolean' ? wanted : flatValues(option).find((candidate) => candidate.toLowerCase() === word)
        if (value === undefined) return failure(`${option.name} does not offer "${word}".`)
        const result = await adapter.setNativeSessionOption(sessionId, { kind: 'config', id: option.id, value }, signal)
        return {
          kind: 'success',
          text: `Fast mode ${word}${result.pendingOptions?.[option.id] === undefined ? '' : ' from the next turn'}.`,
        }
      } catch (error: unknown) {
        return failure(describeError(error))
      }
    },
  }
}

/** The registrations an agent should have on its route right now. */
function planFor(env: BridgeEnv, agent: Agent, route: NativeCommandRoute): CommandPlan {
  const kind = route.kind
  if (kind === undefined) {
    // An ACP agent that is no native one has no catalog; DSH's own compaction cannot run on its route.
    const compact: CommandDefinition = {
      name: 'compact',
      description: "Compact the Agent's own context (native /compact)",
      handler: ({ agent: target, rawInput }) => forwardCommand(target, 'compact', rawInput, COMPACT_SENT),
    }
    return { signature: 'compact', agentName: 'this agent', definitions: [compact], help: [], typed: [] }
  }
  const taken = new Set([...CLIENT_COMMANDS, ...DSH_COMMANDS, ...HOST_COMMANDS])
  const definitions: CommandDefinition[] = []
  const help: HelpRow[] = []
  const typed: string[] = []
  const signature: unknown[] = [kind]
  for (const command of route.adapter.nativeCommands(String(agent.session.id))) {
    const names = [command.name, ...(command.aliases ?? [])]
    if (!names.some((name) => DSH_COMMAND_NAME.test(name))) typed.push(command.name)
    const free = names.filter((name) => DSH_COMMAND_NAME.test(name) && !taken.has(name))
    if (free.length === 0) continue
    const does = command.description.trim() === '' ? `/${command.name}` : command.description.trim()
    const hint = command.hint ?? ANY_ARGUMENTS
    const handler = vendorHandler(env, command)
    for (const name of free) {
      taken.add(name)
      definitions.push({
        name,
        description: name === command.name ? does : `${does} (alias of /${command.name})`,
        input: { hint },
        handler,
      })
    }
    // The handler forwards or runs by the vendor's name and class: both belong to the signature.
    signature.push([command.name, command.dispatch, does, hint, free])
    const aliases = free.slice(1).map((name) => `/${name}`)
    help.push({
      usage: command.hint === undefined ? `/${free[0]}` : `/${free[0]} ${command.hint}`,
      does: aliases.length === 0 ? does : `${does} (also ${aliases.join(', ')})`,
      runs: RUNS[command.dispatch],
    })
  }
  const own = [helpDefinition(env), effortDefinition(env), fastDefinition(env)]
  const control = PLAN_CONTROLS[kind]
  if (control !== undefined) own.push(planDefinition(env, kind, control))
  for (const definition of own) {
    definitions.push(definition)
    signature.push([definition.name, definition.description, definition.input?.hint])
    help.push({
      usage: `/${definition.name} ${definition.input?.hint ?? ''}`.trim(),
      does: definition.description,
      runs: 'as a setting',
    })
  }
  return {
    signature: JSON.stringify(signature),
    agentName: AGENT_NAMES[kind],
    definitions,
    help: help.toSorted((left, right) => (left.usage < right.usage ? -1 : 1)),
    typed,
  }
}

/** Mount one plan on the agent: the commands live exactly as long as the returned plugin fiber. */
function mount(agent: Agent, plan: CommandPlan): Fiber {
  return agent.ctx.plugin({
    name: 'dsh-acp-native-commands',
    inject: ['commands'],
    apply(child: Context) {
      const commands: unknown = Reflect.get(child, 'commands')
      if (!isCommandRegistry(commands)) return
      child.effect(() => {
        const registered: (() => void)[] = []
        try {
          for (const definition of plan.definitions) registered.push(commands.register(definition))
        } catch (error: unknown) {
          for (const unregister of registered.reverse()) unregister()
          throw error
        }
        return () => {
          for (const unregister of registered.reverse()) unregister()
        }
      }, 'dsh-acp native commands')
    },
  })
}

/**
 * Install the vendor commands of every native ACP agent as agent-scoped DSH commands. `routes` says which provider ids
 * are ACP routes and which of them are native; it is asked again whenever a command runs, so a route that went away
 * answers instead of acting.
 */
export function installNativeCommands(ctx: Context, routes: NativeCommandRoutes, log: AcpLogger): NativeCommandBridge {
  const states = new Map<Agent, AgentState>()
  const watched = new Map<NativeCommandAdapter, () => void>()
  let closed = false

  const env: BridgeEnv = {
    ctx,
    // A request header already names the route a session runs on; before the first request the pending pick does.
    serving: (agent) => routes.resolve(agent.session.requestHeader()?.config.provider ?? accessProvider(ctx, agent)),
    stateOf: (agent) => states.get(agent),
  }

  /** Bring the agent's registrations to the plan it should have; one pass at a time, the last plan wins. */
  const settle = async (agent: Agent, state: AgentState): Promise<void> => {
    state.draining = true
    try {
      while (state.mounted !== state.target) {
        const next = state.target
        const previous = state.fiber
        state.fiber = undefined
        state.mounted = undefined
        if (previous !== undefined) await previous.dispose()
        if (closed) return
        if (next !== undefined) state.fiber = mount(agent, next)
        state.mounted = next
      }
    } catch (error: unknown) {
      // The next sync builds the plan again instead of trusting registrations of unknown state.
      state.target = undefined
      state.mounted = undefined
      log.warn(`dsh-acp: native commands could not be registered: ${describeError(error)}`, {
        operation: 'native-commands',
        result: 'error',
      })
    } finally {
      state.draining = false
    }
  }

  const sync = (agent: Agent): void => {
    if (closed) return
    try {
      let state = states.get(agent)
      if (state === undefined) {
        state = {
          target: undefined,
          mounted: undefined,
          fiber: undefined,
          draining: false,
          settling: undefined,
          planBackup: undefined,
        }
        states.set(agent, state)
      }
      const route = env.serving(agent)
      if (route?.kind !== undefined && !watched.has(route.adapter)) {
        watched.set(
          route.adapter,
          route.adapter.watchNativeCommands((sessionId) => {
            const live = ctx.get('agents', false)?.get(sessionId as never)
            if (live !== undefined) sync(live)
          }),
        )
      }
      const next = route === undefined ? undefined : planFor(env, agent, route)
      if (next?.signature === state.target?.signature) return
      state.target = next
      if (!state.draining) state.settling = settle(agent, state)
    } catch (error: unknown) {
      log.warn(`dsh-acp: native commands could not be planned: ${describeError(error)}`, {
        operation: 'native-commands',
        result: 'error',
      })
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    sync(agent)
  })
  ctx.on('agent/inbox/claimed', ({ agent }) => {
    sync(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    states.delete(agent)
  })
  // A draft session switches to an ACP model before it has a request header: its route is the pending pick. The change
  // feed runs inside the projection's own drive, so the plan is built after it.
  const stopFeed = ctx.get('sessionProjections', false)?.onChanged((session, key) => {
    if (key !== 'modelSelection') return
    queueMicrotask(() => {
      const agent = ctx.get('agents', false)?.get(session.id)
      if (agent !== undefined) sync(agent)
    })
  })
  ctx.effect(
    () => () => {
      closed = true
      stopFeed?.()
      for (const stop of watched.values()) stop()
      watched.clear()
      for (const state of states.values()) void state.fiber?.dispose().catch(() => undefined)
      states.clear()
    },
    'dsh-acp: native commands',
  )
  for (const agent of ctx.get('agents', false)?.list() ?? []) sync(agent)

  return {
    idle: async () => {
      while ([...states.values()].some((state) => state.draining))
        await Promise.allSettled([...states.values()].map((state) => state.settling))
    },
  }
}
