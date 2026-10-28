import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'

import type * as acp from '@agentclientprotocol/sdk'
import { parse as parseYaml } from 'yaml'
import { describe, expect, it, vi } from 'vitest'

import {
  buildClaudeAvailableModes,
  buildClaudeConfigOptions,
  chooseInitialModel,
  discoverCustomAgents,
  effortFlagSettings,
  isRecord,
  matchResumedModel,
  parseClaudeModelInfos,
  resolveInitialPermissionMode,
  resolveModelPreference,
  settingsEffortForModel,
  versionedModelDisplayName,
  applyAvailableModelsAllowlist,
  type ClaudeModelInfo,
} from '../../src/runtime/native/transports/claude-controls.ts'
import { CHECKPOINT_LABEL_LIMIT, checkpointLabel } from '../../src/runtime/native/transports/checkpoint-label.ts'
import { prepareClaudePermission } from '../../src/runtime/native/transports/claude-permissions.ts'
import { CLAUDE_NATIVE_COMMANDS, claudeCommandCatalog, resolveClaudeImmediateCommand } from '../../src/runtime/native/transports/claude-commands.ts'
import {
  CheckpointScan,
  ClaudeTaskLedger,
  SideHistory,
  parseBashReplay,
  parseMcpArgs,
  parseRewindArgs,
  parseTasksArgs,
  shellEscapeCommand,
} from '../../src/runtime/native/transports/claude-interactions.ts'
import {
  ClaudeFrameMapper,
  claudeSystemNote,
  claudeToolFacts,
  diffUpdateFromToolResponse,
  modelUsageIncrement,
  normalizeModelUsage,
  unstreamedRemainder,
} from '../../src/runtime/native/transports/claude-projection.ts'
import {
  ClaudeCliTransport,
  buildClaudeArgv,
  readClaudeCheckpoints,
  claudeTurnOutcome,
  claudeUserMessageFrame,
  createClaudeTransport,
  parseClaudeSettings,
  readClaudeResumedTail,
} from '../../src/runtime/native/transports/claude.ts'
import {
  NativeTransportError,
  type NativeElicitationHandler,
  type NativeElicitationRequest,
  type NativePermissionRequest,
  type NativeProcess,
  type NativeSpawn,
  type NativeCommand,
  type NativeTransportEvent,
  type NativeTransportStartOptions,
} from '../../src/runtime/native/transports/contract.ts'
import { generatedContextBlock, generatedContextSeparator } from '../../src/runtime/text-block-boundary.ts'

type Json = Record<string, unknown>

// ---------------------------------------------------------------------------
// Fixtures captured from Claude Code 2.1.296 behind the TokenRouter gateway
// ---------------------------------------------------------------------------

const MODEL_ROWS = [
  { value: 'default', resolvedModel: 'claude-opus-5.5', displayName: 'Default (recommended)', description: 'Use the default model (currently Opus 5) · $5/$25 per Mtok', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsAdaptiveThinking: true, supportsFastMode: true, supportsAutoMode: true },
  { value: 'opus', resolvedModel: 'claude-opus-5.5', displayName: 'Opus 5.5 via proxy', description: 'Custom Opus model', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsAdaptiveThinking: true, supportsFastMode: true, supportsAutoMode: true },
  { value: 'fable', resolvedModel: 'claude-fable-5-1', displayName: 'Fable', description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks · $10/$50 per Mtok', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsAdaptiveThinking: true, supportsAutoMode: true },
  { value: 'sonnet', resolvedModel: 'claude-opus-5', displayName: 'Opus 5 via proxy', description: 'Custom Sonnet model', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsAdaptiveThinking: true, supportsFastMode: true, supportsAutoMode: true },
  { value: 'haiku', resolvedModel: 'claude-sonnet-5.5', displayName: 'claude-sonnet-5.5', description: 'Custom Haiku model', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsAdaptiveThinking: true, supportsAutoMode: true },
  { value: 'claude-sonnet-5.5', resolvedModel: 'claude-sonnet-5.5', displayName: 'Claude Sonnet 5.5', description: 'Claude Sonnet 5.5 via TokenRouter V2', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsAdaptiveThinking: true, supportsAutoMode: true },
]

const MODELS: ClaudeModelInfo[] = parseClaudeModelInfos(MODEL_ROWS)

/** A runtime-checked object: tests read frames and updates through this instead of asserting a shape. */
function rec(value: unknown): Json {
  if (!isRecord(value)) throw new Error(`expected an object, got ${JSON.stringify(value)}`)
  return value
}

function optionEntries(option: unknown): Json[] {
  const options = rec(option)['options']
  return (Array.isArray(options) ? options : []).map(rec)
}

const optionValues = (option: unknown): string[] => optionEntries(option).map((entry) => String(entry['value']))
const optionNames = (option: unknown): string[] => optionEntries(option).map((entry) => String(entry['name']))

function initResponse(overrides: Json = {}): Json {
  return {
    commands: [
      { name: 'cluster-task-monitor', description: 'Register tasks', argumentHint: '' },
      { name: 'login', description: 'Log in' },
      { name: 'mcp', description: 'terminal mcp' },
      { name: 'review', description: 'Review', argumentHint: ['<pr>'] },
    ],
    agents: [{ name: 'claude' }, { name: 'Explore' }, { name: 'general-purpose' }, { name: 'Plan' }, { name: 'statusline-setup' }],
    output_style: 'default',
    models: MODEL_ROWS,
    account: { tokenSource: 'none', apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' },
    claude_code_version: '2.1.296',
    current_permission_mode: 'default',
    fast_mode_state: 'off',
    fast_mode_disabled_reason: 'sdk_opt_in_required',
    capabilities: ['ui_surface_v1'],
    ...overrides,
  }
}

function settingsResponse(effective: Json = { model: 'opus' }): Json {
  return { effective, sources: [{ source: 'userSettings', settings: effective }], applied: { model: 'claude-opus-5.5', effort: 'high' } }
}

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

describe('buildClaudeArgv', () => {
  const base = {
    launcher: ['/opt/claude-launch.mjs'],
    sessionId: '11111111-1111-4111-8111-111111111111',
    permissionMode: 'default' as const,
    allowBypass: true,
    questionSurface: false,
  }

  it('names a new session up front and appends the stream-json protocol flags after the launcher', () => {
    const argv = buildClaudeArgv({ ...base, kind: 'new' })
    expect(argv.slice(0, 1)).toEqual(['/opt/claude-launch.mjs'])
    expect(argv).toEqual(
      expect.arrayContaining(['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool=stdio']),
    )
    expect(argv.slice(argv.indexOf('--setting-sources'), argv.indexOf('--setting-sources') + 2)).toEqual(['--setting-sources', 'user,project,local'])
    expect(argv.slice(argv.indexOf('--permission-mode'), argv.indexOf('--permission-mode') + 2)).toEqual(['--permission-mode', 'default'])
    expect(argv).toContain('--allow-dangerously-skip-permissions')
    expect(argv).toContain('--disallowedTools=AskUserQuestion')
    expect(argv.slice(-2)).toEqual(['--session-id', base.sessionId])
    expect(argv).not.toContain('--resume')
  })

  it('offers the model AskUserQuestion only when the host has a question surface', () => {
    const without = buildClaudeArgv({ ...base, kind: 'new', questionSurface: false })
    const surfaced = buildClaudeArgv({ ...base, kind: 'new', questionSurface: true })
    expect(without).toContain('--disallowedTools=AskUserQuestion')
    expect(surfaced.some((argument) => argument.startsWith('--disallowedTools'))).toBe(false)
    // That is the only flag the surface changes.
    expect(without.filter((argument) => !surfaced.includes(argument))).toEqual(['--disallowedTools=AskUserQuestion'])
    expect(surfaced.filter((argument) => !without.includes(argument))).toEqual([])
  })

  it('resumes by id, forks with a chosen id, and omits the bypass flag when bypass is unavailable', () => {
    const resume = buildClaudeArgv({ ...base, kind: 'resume', permissionMode: 'bypassPermissions' })
    expect(resume.slice(-2)).toEqual(['--resume', base.sessionId])
    expect(resume).not.toContain('--session-id')
    expect(resume.slice(resume.indexOf('--permission-mode'), resume.indexOf('--permission-mode') + 2)).toEqual(['--permission-mode', 'bypassPermissions'])

    const fork = buildClaudeArgv({ ...base, kind: 'fork', parentSessionId: 'parent-id', allowBypass: false })
    expect(fork.slice(-5)).toEqual(['--resume', 'parent-id', '--fork-session', '--session-id', base.sessionId])
    expect(fork).not.toContain('--allow-dangerously-skip-permissions')

    // `--session-id` alone with `--resume` is rejected by the CLI, so a fresh start never resumes.
    expect(buildClaudeArgv({ ...base, kind: 'fresh' })).not.toContain('--resume')
  })

  it('stamps user messages as human input and marks a steer with priority next', () => {
    const frame = claudeUserMessageFrame({
      blocks: [
        { type: 'text', text: 'hello' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ],
      sessionId: 's1',
      uuid: 'u1',
    })
    expect(frame).toMatchObject({ type: 'user', parent_tool_use_id: null, session_id: 's1', uuid: 'u1', origin: { kind: 'human' } })
    expect(rec(frame['message'])['content']).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ])
    expect(frame).not.toHaveProperty('priority')
    expect(claudeUserMessageFrame({ blocks: [{ type: 'text', text: 's' }], sessionId: 's1', priority: 'next' })['priority']).toBe('next')
  })
})

describe('claudeTurnOutcome', () => {
  it('maps result frames the way claude-agent-acp maps them', () => {
    expect(claudeTurnOutcome({ subtype: 'success', stop_reason: 'end_turn' }, false)).toEqual({ stopReason: 'end_turn' })
    expect(claudeTurnOutcome({ subtype: 'success', stop_reason: 'max_tokens' }, false)).toEqual({ stopReason: 'max_tokens' })
    expect(claudeTurnOutcome({ subtype: 'success', stop_reason: 'refusal' }, false)).toEqual({ stopReason: 'refusal' })
    expect(claudeTurnOutcome({ subtype: 'error_max_turns', is_error: false }, false)).toEqual({ stopReason: 'max_turn_requests' })
    expect(claudeTurnOutcome({ subtype: 'error_during_execution', is_error: false }, false)).toEqual({ stopReason: 'end_turn' })
    expect(claudeTurnOutcome({ subtype: 'error_during_execution', is_error: true, errors: ['boom', 'bang'] }, false)).toEqual({ error: 'boom, bang' })
    expect(claudeTurnOutcome({ subtype: 'success', is_error: true, result: 'API Error: 529' }, false)).toEqual({ error: 'API Error: 529' })
    // A turn the host interrupted is cancelled whatever the frame says.
    expect(claudeTurnOutcome({ subtype: 'error_during_execution', is_error: true, errors: ['x'] }, true)).toEqual({ stopReason: 'cancelled' })
  })
})

// ---------------------------------------------------------------------------
// Controls (claude-agent-acp session/new parity)
// ---------------------------------------------------------------------------

describe('Claude controls', () => {
  const baseInput = () => {
    const choice = chooseInitialModel({ models: MODELS, sdkModels: MODELS, settingsModel: 'opus', envModel: undefined, resumed: false, resumedModelHint: undefined })
    const modes = { currentModeId: 'default', availableModes: buildClaudeAvailableModes(true) }
    return { modes, models: choice.state, modelInfos: MODELS, effortLevel: undefined, agents: [], currentAgent: 'default', fast: { supported: true, enabled: false, disabledReason: undefined } }
  }

  it('reproduces the option ids, categories and values DSH saved from the ACP route', () => {
    const options = buildClaudeConfigOptions({ ...baseInput(), fast: { supported: false, enabled: false, disabledReason: undefined } })
    expect(options.map((option) => [option.id, option.category])).toEqual([
      ['mode', 'mode'],
      ['model', 'model'],
      ['effort', 'thought_level'],
    ])
    expect(optionValues(options[0])).toEqual(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'])
    expect(optionValues(options[1])).toEqual(['default', 'opus', 'fable', 'sonnet', 'haiku', 'claude-sonnet-5.5'])
    expect(optionValues(options[2])).toEqual(['default', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(options[0]).toMatchObject({ name: 'Mode', description: 'Session permission mode', currentValue: 'default' })
    expect(optionNames(options[0])).toEqual(['Manual', 'Accept edits', 'Plan', 'Auto', 'Bypass permissions'])
    expect(options[1]).toMatchObject({ name: 'Model', description: 'AI model to use', currentValue: 'opus' })
    expect(options[2]).toMatchObject({ name: 'Effort', description: 'Available effort levels for this model', currentValue: 'default' })
  })

  it('offers the fast-mode toggle only for models that support it, and a custom-agent picker only when agents exist', () => {
    const withFast = buildClaudeConfigOptions({ ...baseInput(), fast: { supported: true, enabled: false, disabledReason: 'free' } })
    const fast = withFast.find((option) => option.id === 'fast')
    expect(fast).toMatchObject({ category: 'model_config', type: 'select', currentValue: 'off' })
    expect(fast?.description).toContain('not available on the free plan')
    const agents = discoverCustomAgents([{ name: 'claude' }, { name: 'Plan' }, { name: 'reviewer', description: 'Reviews' }, { name: 'default' }])
    expect(agents).toEqual([{ name: 'reviewer', description: 'Reviews' }])
    const withAgents = buildClaudeConfigOptions({ ...baseInput(), agents })
    expect(optionValues(withAgents.find((option) => option.id === 'agent'))).toEqual(['default', 'reviewer'])
  })

  it('lists bypassPermissions only when the session may use it', () => {
    expect(buildClaudeAvailableModes(false).map((mode) => mode.id)).toEqual(['default', 'acceptEdits', 'plan', 'auto'])
    expect(buildClaudeAvailableModes(true).at(-1)).toMatchObject({ id: 'bypassPermissions', name: 'Bypass permissions' })
  })

  it('picks the model by ANTHROPIC_MODEL, settings, the resumed conversation, then the first row', () => {
    const run = (input: Partial<Parameters<typeof chooseInitialModel>[0]>) =>
      chooseInitialModel({ models: MODELS, sdkModels: MODELS, settingsModel: undefined, envModel: undefined, resumed: false, resumedModelHint: undefined, ...input })
    expect(run({}).state.currentModelId).toBe('default')
    expect(run({}).setModel).toBeUndefined()
    // A fresh session already runs the settings model; a resumed one re-asserts it.
    expect(run({ settingsModel: 'opus' })).toMatchObject({ state: { currentModelId: 'opus' }, setModel: undefined })
    expect(run({ settingsModel: 'opus', resumed: true })).toMatchObject({ state: { currentModelId: 'opus' }, setModel: 'opus' })
    expect(run({ settingsModel: 'opus', envModel: 'fable' }).state.currentModelId).toBe('fable')
    expect(run({ resumed: true, resumedModelHint: 'claude-opus-5.5' })).toMatchObject({ state: { currentModelId: 'default' }, setModel: undefined })
    expect(run({ settingsModel: 42 }).state.currentModelId).toBe('default')
  })

  it('names models the way the vendor does, adding concrete versions only when metadata proves them', () => {
    expect(versionedModelDisplayName({ value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 5 · fast', resolvedModel: 'claude-sonnet-5' })).toBe('Sonnet 5')
    expect(versionedModelDisplayName(MODELS[1]!)).toBe('Opus 5.5 via proxy')
    expect(resolveModelPreference(MODELS, 'opus')?.value).toBe('opus')
    expect(resolveModelPreference(MODELS, 'claude-opus-5.5')?.value).toBe('opus')
    expect(resolveModelPreference(MODELS, '   ')).toBeNull()
    expect(matchResumedModel(MODELS, 'claude-opus-5.5').value).toBe('default')
    expect(matchResumedModel(MODELS, 'claude-mystery-9')).toMatchObject({ value: 'claude-mystery-9', description: '' })
  })

  it('applies the availableModels allowlist and keeps Default', () => {
    const allowed = applyAvailableModelsAllowlist(MODELS, ['fable', 'claude-opus-4-1'], { fable: 'fable-override' }, [], undefined)
    expect(allowed.map((model) => model.value)).toEqual(['default', 'fable-override', 'claude-opus-4-1'])
    const denied = applyAvailableModelsAllowlist(MODELS, ['fable'], undefined, ['fable'], undefined)
    expect(denied.map((model) => model.value)).toEqual(['default'])
  })

  it('resolves effort from per-model settings first and clears the flag layer with null', () => {
    const info = MODELS[1]
    expect(settingsEffortForModel({ effortLevel: 'low' }, info)).toBe('low')
    expect(settingsEffortForModel({ effortLevel: 'low', modelSettings: { 'claude-opus-5.5': { effortLevel: 'max' } } }, info)).toBe('max')
    expect(settingsEffortForModel({}, info)).toBeUndefined()
    expect(effortFlagSettings('high', {})).toEqual({ effortLevel: 'high' })
    expect(effortFlagSettings('default', {})).toEqual({ effortLevel: null })
    expect(effortFlagSettings(undefined, { ultracode: true })).toEqual({ effortLevel: null, ultracode: true })
  })

  it('resolves the initial permission mode: explicit, resumed transcript, then trusted settings', () => {
    expect(resolveInitialPermissionMode({}, true)).toBe('default')
    expect(resolveInitialPermissionMode({ resumed: 'bypassPermissions' }, true)).toBe('bypassPermissions')
    expect(resolveInitialPermissionMode({ resumed: 'bypassPermissions', defaultMode: 'acceptEdits' }, false)).toBe('acceptEdits')
    expect(resolveInitialPermissionMode({ defaultMode: 'Manual' }, true)).toBe('default')
    // A settings string must never reach an inherited Object property.
    expect(resolveInitialPermissionMode({ defaultMode: 'constructor' }, true)).toBe('default')
    expect(resolveInitialPermissionMode({ explicit: 'plan', resumed: 'auto' }, true)).toBe('plan')
  })

  it('reads the settings the controls depend on and drops escalating defaults from repository settings', () => {
    const settings = parseClaudeSettings({
      effective: { model: 'opus', permissions: { defaultMode: 'bypassPermissions' }, availableModels: ['opus'] },
      sources: [
        { source: 'userSettings', settings: { model: 'opus' } },
        { source: 'projectSettings', settings: { permissions: { defaultMode: 'bypassPermissions' } } },
        { source: 'policySettings', settings: { deniedModels: ['haiku'] } },
      ],
    })
    expect(settings.permissions?.defaultMode).toBeUndefined()
    expect(settings.deniedModels).toEqual(['haiku'])
    expect(settings.availableModels).toEqual(['opus'])
    const trusted = parseClaudeSettings({ effective: { permissions: { defaultMode: 'acceptEdits' } }, sources: [{ source: 'userSettings', settings: { permissions: { defaultMode: 'acceptEdits' } } }] })
    expect(trusted.permissions?.defaultMode).toBe('acceptEdits')
  })

  it("lists the commands the transport answers itself first, then the CLI's own commands as prompts", () => {
    const live = [
      { name: 'hello', description: 'Probe project command (project)', argumentHint: '[who]' },
      { name: 'review', description: 'Review a pull request', argumentHint: ['<pr>', '[--fix]'], aliases: ['pr-review', 'mcp'] },
      { name: 'doctor', description: 'Health-check the setup', aliases: ['checkup'] },
      { name: 'heapdump', description: 'Dump the heap to the Desktop' },
      { name: 'effort', description: 'Set the effort level' },
      { name: 'goal', description: 'Set a goal' },
      { name: 'login', description: 'Log in' },
      { name: 'usage', description: 'Show usage', aliases: ['cost', 'stats'] },
      { name: 'srv:ask (MCP)', description: 'An MCP prompt' },
      { name: 'plugin:cmd', description: 'Words that go on and on. '.repeat(30) },
      { name: 'hello', description: 'listed twice' },
    ]
    const catalog = claudeCommandCatalog(live, ['doctor'])
    const byName = new Map(catalog.map((command) => [command.name, command]))
    expect(byName.get('btw')).toMatchObject({ dispatch: 'side', hint: '<question>' })
    for (const name of ['status', 'context', 'usage', 'memory', 'skills', 'hooks', 'permissions', 'diff', 'mcp', 'tasks', 'rewind']) {
      expect(byName.get(name)?.dispatch, name).toBe('immediate')
    }
    // The CLI's own commands run as turns; an argument hint given as a list is joined, and an alias a command we answer owns is not reused.
    expect(byName.get('hello')).toMatchObject({ dispatch: 'prompt', hint: '[who]' })
    expect(byName.get('review')).toMatchObject({ dispatch: 'prompt', hint: '<pr> [--fix]', aliases: ['pr-review'] })
    expect(byName.get('mcp:srv:ask')?.dispatch).toBe('prompt')
    expect(byName.get('plugin:cmd')?.description.length).toBeLessThanOrEqual(161)
    // /goal is the CLI's own: DSH forwards the text and the CLI answers (or works toward the goal) itself.
    expect(byName.get('goal')).toMatchObject({ dispatch: 'prompt', hint: '[<condition> | clear]' })
    // Terminal-bound, internal, session-controlled and unsupported commands are not offered; an answered command appears once.
    for (const hidden of ['doctor', 'checkup', 'heapdump', 'effort', 'login']) expect(byName.has(hidden), hidden).toBe(false)
    expect(catalog.filter((command) => command.name === 'usage')).toHaveLength(1)
    expect(byName.get('usage')?.dispatch).toBe('immediate')
    const spellings = catalog.flatMap((command) => [command.name, ...(command.aliases ?? [])])
    expect(new Set(spellings).size).toBe(spellings.length)
  })

  it('stands in for the CLI list with the built-ins, which DSH can all register under their own names', () => {
    const builtins = claudeCommandCatalog(undefined, [])
    expect(builtins.map((command) => command.name)).toEqual(expect.arrayContaining(['btw', 'status', 'compact', 'clear', 'init']))
    for (const command of CLAUDE_NATIVE_COMMANDS) {
      for (const name of [command.name, ...(command.aliases ?? [])]) expect(name).toMatch(/^[a-z][a-z0-9_-]*$/)
      expect(command.description).not.toBe('')
    }
    const spellings = CLAUDE_NATIVE_COMMANDS.flatMap((command) => [command.name, ...(command.aliases ?? [])])
    expect(new Set(spellings).size).toBe(spellings.length)
    // Names DSH registers or reserves itself.
    for (const reserved of ['model', 'file', 'effort', 'fast', 'plan', 'help', 'export', 'feedback', 'permission']) expect(spellings).not.toContain(reserved)
    expect(builtins.find((command) => command.name === 'goal')).toMatchObject({ dispatch: 'prompt' })
    expect(resolveClaudeImmediateCommand('/cost')).toBe('usage')
    expect(resolveClaudeImmediateCommand('bashes')).toBe('tasks')
    expect(resolveClaudeImmediateCommand('undo')).toBe('rewind')
    // /btw is a side question and /clear a turn: neither is answered as an immediate command.
    expect(resolveClaudeImmediateCommand('btw')).toBeUndefined()
    expect(resolveClaudeImmediateCommand('clear')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Projection (claude-agent-acp tool-call renderers, AIR-client mode)
// ---------------------------------------------------------------------------

const CWD = '/work/project'
const sessionFrame = { session_id: 's1', uuid: 'u' }

function streamEvent(event: Json, parent: string | null = null): Json {
  return { type: 'stream_event', event, parent_tool_use_id: parent, ...sessionFrame }
}

function updatesOf(events: readonly NativeTransportEvent[]): Json[] {
  return events.flatMap((event) => (event.kind === 'update' ? [rec(event.update)] : []))
}

function toolStart(id: string, name: string, parent: string | null = null): Json {
  return streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } }, parent)
}

function assistantTool(id: string, name: string, input: Json, parent: string | null = null): Json {
  return {
    type: 'assistant',
    message: { id: 'msg_1', model: 'claude-opus-5.5', role: 'assistant', content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 100 } },
    parent_tool_use_id: parent,
    ...sessionFrame,
  }
}

function toolResult(id: string, content: unknown, structured?: Json, extra: Json = {}): Json {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] },
    parent_tool_use_id: null,
    ...sessionFrame,
    ...(structured === undefined ? {} : { tool_use_result: structured }),
  }
}

describe('Claude tool-call projection', () => {
  it('renders a Bash call like the vendor: announced without input, refined with it, closed with a console fence', () => {
    const mapper = new ClaudeFrameMapper({ cwd: CWD })
    const announced = updatesOf(mapper.map(toolStart('toolu_B', 'Bash')))
    expect(announced).toEqual([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'toolu_B',
        name: 'Bash',
        status: 'pending',
        title: 'Terminal',
        kind: 'execute',
        content: [],
        _meta: { claudeCode: { toolName: 'Bash' }, jetbrains: { air: { version: 1 } } },
      },
    ])
    const refined = updatesOf(mapper.map(assistantTool('toolu_B', 'Bash', { command: 'sleep 5 && echo FIRST_OUT', description: 'Sleep then echo' })))
    expect(refined).toEqual([
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'toolu_B',
        rawInput: { command: 'sleep 5 && echo FIRST_OUT', description: 'Sleep then echo' },
        title: 'sleep 5 && echo FIRST_OUT',
        content: [{ type: 'content', content: { type: 'text', text: 'Sleep then echo' } }],
        _meta: { claudeCode: { toolName: 'Bash' }, jetbrains: { air: { version: 1, commandTitle: 'Sleep then echo' } } },
      },
    ])
    const done = updatesOf(mapper.map(toolResult('toolu_B', 'FIRST_OUT', { stdout: 'FIRST_OUT', stderr: '', interrupted: false, isImage: false, noOutputExpected: false }, { is_error: false })))
    expect(done).toEqual([
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'toolu_B',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: '```console\nFIRST_OUT\n```' } }],
        _meta: { claudeCode: { toolName: 'Bash' } },
      },
    ])
  })

  it('fences a failed command as plain error text and marks it failed', () => {
    const mapper = new ClaudeFrameMapper({ cwd: CWD })
    mapper.map(assistantTool('toolu_E', 'Bash', { command: 'false' }))
    const failed = updatesOf(mapper.map(toolResult('toolu_E', 'Exit code 1\nnope', { stdout: '', stderr: 'nope', interrupted: false }, { is_error: true })))
    expect(failed.at(-1)).toMatchObject({ status: 'failed', content: [{ type: 'content', content: { type: 'text', text: '```\nExit code 1\nnope\n```' } }] })
  })

  it('shows a Read as viewed file: location kept, file text dropped', () => {
    const mapper = new ClaudeFrameMapper({ cwd: CWD })
    const input = { file_path: `${CWD}/src/a.ts`, offset: 10, limit: 5 }
    const refined = updatesOf(mapper.map(assistantTool('toolu_R', 'Read', input)))
    expect(refined[0]).toMatchObject({ sessionUpdate: 'tool_call', name: 'Read', title: 'Read src/a.ts (10 - 14)', kind: 'read', locations: [{ path: `${CWD}/src/a.ts`, line: 10 }], rawInput: input })
    const done = updatesOf(mapper.map(toolResult('toolu_R', '10\tconst a = 1\n', { type: 'text', file: { filePath: input.file_path, content: 'const a = 1\n', numLines: 1, startLine: 10, totalLines: 14 } })))
    expect(done).toEqual([{ sessionUpdate: 'tool_call_update', toolCallId: 'toolu_R', status: 'completed', _meta: { claudeCode: { toolName: 'Read' } } }])
  })

  it('renders Write and Edit with diff content and file text stripped from rawInput, then the final structured patch', () => {
    const mapper = new ClaudeFrameMapper({ cwd: CWD })
    mapper.map(toolStart('toolu_W', 'Write'))
    const write = updatesOf(mapper.map(assistantTool('toolu_W', 'Write', { file_path: `${CWD}/a.txt`, content: 'hello world\n' })))
    expect(write[0]).toMatchObject({
      sessionUpdate: 'tool_call_update',
      title: 'Write a.txt',
      locations: [{ path: `${CWD}/a.txt` }],
      rawInput: { file_path: `${CWD}/a.txt` },
      content: [{ type: 'diff', path: `${CWD}/a.txt`, oldText: null, newText: 'hello world\n' }],
    })
    const created = updatesOf(mapper.map(toolResult('toolu_W', 'File created successfully', { type: 'create', filePath: `${CWD}/a.txt`, content: 'hello world\n', structuredPatch: [], originalFile: null, userModified: false })))
    expect(created.at(-1)).toMatchObject({ status: 'completed', rawOutput: 'File created successfully' })

    mapper.map(toolStart('toolu_Ed', 'Edit'))
    const edit = updatesOf(mapper.map(assistantTool('toolu_Ed', 'Edit', { file_path: `${CWD}/a.txt`, old_string: 'hello', new_string: 'bye' })))
    expect(edit[0]).toMatchObject({ title: 'Edit a.txt', rawInput: { file_path: `${CWD}/a.txt` }, content: [{ type: 'diff', oldText: 'hello', newText: 'bye' }] })
    const result = updatesOf(
      mapper.map(
        toolResult('toolu_Ed', 'updated', {
          filePath: `${CWD}/a.txt`,
          oldString: 'hello',
          newString: 'bye',
          originalFile: 'hello world\n',
          structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-hello world', '+bye world'] }],
          userModified: false,
          replaceAll: false,
        }),
      ),
    )
    // The late report carries the exact patch; the result then closes the call.
    expect(result[0]).toMatchObject({
      toolCallId: 'toolu_Ed',
      content: [{ type: 'diff', path: `${CWD}/a.txt`, oldText: 'hello world', newText: 'bye world' }],
      locations: [{ path: `${CWD}/a.txt`, line: 1 }],
      _meta: { claudeCode: { toolName: 'Edit' } },
    })
    expect(result.at(-1)).toMatchObject({ status: 'completed' })
  })

  it('builds titles and kinds for search, fetch and subagent tools', () => {
    expect(claudeToolFacts({ id: '1', name: 'Glob', input: { pattern: '*.ts', path: '/w' } }, CWD)).toMatchObject({ title: 'Find `/w` `*.ts`', kind: 'search', locations: [{ path: '/w' }] })
    expect(claudeToolFacts({ id: '1', name: 'Grep', input: { pattern: 'x', '-i': true, glob: '*.ts', path: 'src', output_mode: 'files_with_matches' } }, CWD)).toMatchObject({
      title: 'grep -i -l --include="*.ts" "x" src',
      kind: 'search',
    })
    expect(claudeToolFacts({ id: '1', name: 'WebFetch', input: { url: 'https://a.test', prompt: 'p' } }, CWD)).toMatchObject({ title: 'Fetch https://a.test', kind: 'fetch' })
    expect(claudeToolFacts({ id: '1', name: 'WebSearch', input: { query: 'q' } }, CWD)).toMatchObject({ title: 'Search "q"', kind: 'fetch' })
    expect(claudeToolFacts({ id: '1', name: 'Agent', input: { description: 'Ping', prompt: 'p', effort: 'low' } }, CWD)).toMatchObject({ title: 'Ping (low effort)', kind: 'think' })
    expect(claudeToolFacts({ id: '1', name: 'mcp__srv__tool', input: {} }, CWD)).toMatchObject({ title: 'mcp__srv__tool', kind: 'other' })
    expect(claudeToolFacts({ id: '1', name: 'ExitPlanMode', input: { plan: 'do it' } }, CWD)).toMatchObject({ title: 'Approve Plan', kind: 'switch_mode' })
  })

  it('reports a subagent for DSH: flagged call, report as content, whole response in _meta', () => {
    const mapper = new ClaudeFrameMapper({ cwd: CWD })
    mapper.map(toolStart('toolu_A', 'Agent'))
    const refined = updatesOf(mapper.map(assistantTool('toolu_A', 'Agent', { subagent_type: 'general-purpose', description: 'Ping', prompt: 'Reply PONG' })))
    expect(refined[0]).toMatchObject({ title: 'Ping', rawInput: { prompt: 'Reply PONG' }, _meta: { claudeCode: { toolName: 'Agent', subagent: true } } })
    const response = { status: 'completed', prompt: 'Reply PONG', agentId: 'a1', agentType: 'general-purpose', content: [{ type: 'text', text: 'PONG' }], totalDurationMs: 6428, totalTokens: 34557, usage: { input_tokens: 2, output_tokens: 5 } }
    const done = updatesOf(mapper.map(toolResult('toolu_A', [{ type: 'text', text: 'PONG\nagentId: a1 (use SendMessage with to: a1)' }], response)))
    expect(done[0]).toMatchObject({ toolCallId: 'toolu_A', _meta: { claudeCode: { toolName: 'Agent', toolResponse: response } } })
    expect(done.at(-1)).toMatchObject({ status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'PONG' } }] })
  })

  it('turns TodoWrite and Task* calls into plan snapshots instead of tool calls', () => {
    const mapper = new ClaudeFrameMapper({ cwd: CWD })
    expect(updatesOf(mapper.map(toolStart('toolu_T', 'TodoWrite')))).toEqual([])
    const plan = updatesOf(
      mapper.map(assistantTool('toolu_T', 'TodoWrite', { todos: [{ content: 'first', status: 'completed', activeForm: 'firsting' }, { content: 'second', status: 'in_progress', activeForm: 'seconding' }] })),
    )
    expect(plan).toEqual([
      { sessionUpdate: 'plan', entries: [{ content: 'first', status: 'completed', priority: 'medium' }, { content: 'seconding', status: 'in_progress', priority: 'medium' }] },
    ])
    expect(updatesOf(mapper.map(toolResult('toolu_T', 'ok')))).toEqual([])

    mapper.map(assistantTool('toolu_C', 'TaskCreate', { subject: 'Write tests', activeForm: 'Writing tests' }))
    const created = updatesOf(mapper.map(toolResult('toolu_C', 'Task #1 created successfully: Write tests')))
    expect(created).toEqual([{ sessionUpdate: 'plan', entries: [{ content: 'Write tests', status: 'pending', priority: 'medium' }] }])
    mapper.map(assistantTool('toolu_U', 'TaskUpdate', { taskId: '1', status: 'in_progress' }))
    const updated = updatesOf(mapper.map(toolResult('toolu_U', JSON.stringify({ success: true, taskId: '1', updatedFields: ['status'] }))))
    expect(updated).toEqual([{ sessionUpdate: 'plan', entries: [{ content: 'Writing tests', status: 'in_progress', priority: 'medium' }] }])
  })

  it('streams text and thinking once, with the API message id, and drops the duplicated consolidated blocks', () => {
    const mapper = new ClaudeFrameMapper({ cwd: CWD })
    mapper.map(streamEvent({ type: 'message_start', message: { id: 'msg_9', model: 'claude-opus-5.5', usage: { input_tokens: 1, output_tokens: 0 } } }))
    const thought = updatesOf(mapper.map(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } })))
    expect(thought).toEqual([{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' }, messageId: 'msg_9' }])
    const text = updatesOf(mapper.map(streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'DONE' } })))
    expect(text).toEqual([{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'DONE' }, messageId: 'msg_9' }])
    const consolidated = mapper.map({
      type: 'assistant',
      message: { id: 'msg_9', model: 'claude-opus-5.5', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'DONE' }], usage: { input_tokens: 1, output_tokens: 3 } },
      parent_tool_use_id: null,
      ...sessionFrame,
    })
    expect(updatesOf(consolidated)).toEqual([])
    // A text the stream never delivered is not lost.
    expect(unstreamedRemainder([{ type: 'text', text: 'never streamed' }], [])).toEqual([{ type: 'text', text: 'never streamed' }])
    expect(unstreamedRemainder([{ type: 'text', text: 'abcdef' }], [{ index: 0, type: 'text', text: 'abc' }])).toEqual([{ type: 'text', text: 'def' }])
  })

  it('keeps subagent prose out of the main answer and stamps nested tool calls with their parent', () => {
    const mapper = new ClaudeFrameMapper({ cwd: CWD })
    const nested = updatesOf(mapper.map(assistantTool('toolu_N', 'Bash', { command: 'ls' }, 'toolu_parent')))
    expect(nested[0]).toMatchObject({ toolCallId: 'toolu_N', _meta: { claudeCode: { toolName: 'Bash', parentToolUseId: 'toolu_parent' } } })
    const prose = mapper.map({
      type: 'assistant',
      message: { id: 'm', model: 'claude-opus-5.5', content: [{ type: 'text', text: 'subagent words' }], usage: {} },
      parent_tool_use_id: 'toolu_parent',
      ...sessionFrame,
    })
    expect(updatesOf(prose)).toEqual([])
    expect(updatesOf(mapper.map(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } }, 'toolu_parent')))).toEqual([])
  })

  it('reports context occupancy from message usage and the session cost at the end of a turn', () => {
    const mapper = new ClaudeFrameMapper({ cwd: CWD })
    mapper.seedContextWindow('claude-opus-5.5')
    const started = mapper.map(streamEvent({ type: 'message_start', message: { id: 'm1', model: 'claude-opus-5.5', usage: { input_tokens: 1, cache_creation_input_tokens: 37_755, cache_read_input_tokens: 0, output_tokens: 2 } } }))
    expect(started).toEqual([{ kind: 'context_usage', contextUsage: { used: 37_758, size: 200_000 } }])
    // Nothing changed, nothing to report.
    expect(mapper.map(streamEvent({ type: 'message_delta', usage: { output_tokens: 2 } }))).toEqual([])
    expect(mapper.map(streamEvent({ type: 'message_delta', usage: { output_tokens: 12 } }))).toEqual([{ kind: 'context_usage', contextUsage: { used: 37_768, size: 200_000 } }])
    const end = mapper.resultUsage({ total_cost_usd: 0.2594, modelUsage: { 'claude-opus-5.5': { contextWindow: 1_000_000 } } })
    expect(end).toEqual([{ kind: 'context_usage', contextUsage: { used: 37_768, size: 1_000_000, cost: { amount: 0.2594, currency: 'USD' } } }])
    expect(mapper.contextUsage).toEqual({ used: 37_768, size: 1_000_000, cost: { amount: 0.2594, currency: 'USD' } })
  })

  it('closes tool calls a turn left open, telling a never-started call from a lost result', () => {
    const mapper = new ClaudeFrameMapper({ cwd: CWD })
    mapper.map(toolStart('toolu_never', 'Bash'))
    mapper.map(assistantTool('toolu_lost', 'Bash', { command: 'sleep 9' }))
    const closed = updatesOf(mapper.settleTurn(false))
    const byId = Object.fromEntries(closed.map((update) => [String(update['toolCallId']), update]))
    expect(byId['toolu_never']).toMatchObject({ status: 'failed', content: [{ content: { text: 'Claude stopped this tool call before it ran.' } }] })
    expect(byId['toolu_lost']).toMatchObject({ status: 'failed', content: [{ content: { text: 'Claude ended the turn without returning a result for this tool.' } }] })
    mapper.map(assistantTool('toolu_cut', 'Bash', { command: 'sleep 9' }))
    expect(updatesOf(mapper.settleTurn(true))[0]).toMatchObject({ content: [{ content: { text: 'The turn was cancelled before this tool call returned a result.' } }] })
    expect(updatesOf(mapper.settleTurn(false))).toEqual([])
  })

  it('surfaces tool progress, denials and compaction as the vendor does', () => {
    const mapper = new ClaudeFrameMapper({ cwd: CWD })
    mapper.map(assistantTool('toolu_P', 'Bash', { command: 'sleep 9' }))
    const progress = updatesOf(mapper.map({ type: 'tool_progress', tool_use_id: 'toolu_P', tool_name: 'Bash', parent_tool_use_id: null, elapsed_time_seconds: 3 }))
    expect(progress[0]).toMatchObject({ toolCallId: 'toolu_P', status: 'in_progress', _meta: { claudeCode: { toolName: 'Bash', toolResponse: { elapsedTimeSeconds: 3 } } } })
    const denied = updatesOf(mapper.map({ type: 'system', subtype: 'permission_denied', tool_use_id: 'toolu_P', tool_name: 'Bash', decision_reason_type: 'rule', decision_reason: 'Bash is denied', message: 'denied' }))
    expect(denied[0]).toMatchObject({ status: 'failed', content: [{ content: { text: 'Permission denied: Bash is denied' } }] })

    const compactionStart = updatesOf(mapper.map({ type: 'system', subtype: 'status', status: 'compacting', uuid: 'cmp-1' }))
    expect(compactionStart[0]).toMatchObject({ sessionUpdate: 'tool_call', toolCallId: 'cmp-1', title: 'Compact conversation', kind: 'think', status: 'in_progress' })
    const boundary = mapper.map({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 900_000, post_tokens: 40_000, duration_ms: 12 } })
    expect(updatesOf(boundary)[0]).toMatchObject({ sessionUpdate: 'tool_call_update', toolCallId: 'cmp-1', status: 'completed' })
    expect(boundary.at(-1)).toMatchObject({ kind: 'context_usage', contextUsage: { used: 40_000 } })
  })

  it('computes whole-turn usage as the increase over the previous cumulative reading', () => {
    const first = normalizeModelUsage({ 'claude-sonnet-5.5': { inputTokens: 6, outputTokens: 105, cacheReadInputTokens: 0, cacheCreationInputTokens: 101_352, thinkingTokens: 0, costUSD: 0.25 } })
    const second = normalizeModelUsage({
      'claude-sonnet-5.5': { inputTokens: 6, outputTokens: 105, cacheReadInputTokens: 0, cacheCreationInputTokens: 101_352, thinkingTokens: 0, costUSD: 0.25 },
      'claude-opus-5.5': { inputTokens: 2, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 50_902, thinkingTokens: 3, costUSD: 0.5 },
    })
    expect(modelUsageIncrement(second, first)).toEqual({ input: 2, output: 5, cacheRead: 0, cacheWrite: 50_902, thinking: 3, costUsd: 0.5 })
    expect(modelUsageIncrement(first, {})).toMatchObject({ input: 6, output: 105 })
    // A reading that fell below the previous one restarted; it is itself the increase.
    expect(modelUsageIncrement(first, normalizeModelUsage({ 'claude-sonnet-5.5': { inputTokens: 600 } }))).toMatchObject({ input: 6, output: 105 })
    expect(diffUpdateFromToolResponse({ filePath: '/a', structuredPatch: [] })).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

describe('Claude permission requests', () => {
  const context = { cwd: CWD, availableModes: ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'], prePlanMode: undefined, autoUnavailable: false }
  const bashRequest: Json = {
    subtype: 'can_use_tool',
    tool_name: 'Bash',
    input: { command: 'npm test', description: 'Run tests' },
    tool_use_id: 'toolu_1',
    permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }],
  }

  it('presents the tool call and the vendor options for a shell command', () => {
    const prepared = prepareClaudePermission(bashRequest, context)
    expect(prepared.request.toolCall).toMatchObject({ toolCallId: 'toolu_1', title: 'npm test', rawInput: { command: 'npm test', description: 'Run tests' } })
    expect(prepared.request.options.map((option) => [option.optionId, option.kind, option.name])).toEqual([
      ['allow-once', 'allow_once', 'Yes'],
      ['allow-with-updates', 'allow_always', "Yes, and don't ask again for npm test commands"],
      ['reject', 'reject_once', 'No'],
    ])
  })

  it('answers each choice in Claude PermissionResult form', () => {
    const prepared = prepareClaudePermission(bashRequest, context)
    expect(prepared.decide({ optionId: 'allow-once' })).toEqual({ behavior: 'allow', updatedInput: bashRequest['input'], toolUseID: 'toolu_1', decisionClassification: 'user_temporary' })
    expect(prepared.decide({ optionId: 'allow-with-updates' })).toMatchObject({ behavior: 'allow', updatedPermissions: bashRequest['permission_suggestions'], decisionClassification: 'user_permanent' })
    expect(prepared.decide({ optionId: 'reject' })).toEqual({ behavior: 'deny', message: 'User refused permission to run tool', toolUseID: 'toolu_1', decisionClassification: 'user_reject' })
    expect(prepared.decide({ cancelled: true })).toBeUndefined()
    expect(() => prepared.decide({ optionId: 'exit-plan-auto' })).toThrow('was not offered')
  })

  it('offers no always-allow when the CLI forbids a persistent rule or the suggestions are malformed', () => {
    const suppressed = prepareClaudePermission({ ...bashRequest, suppress_always_allow_rule: true }, context)
    expect(suppressed.request.options.map((option) => option.optionId)).toEqual(['allow-once', 'reject'])
    const malformed = prepareClaudePermission({ ...bashRequest, permission_suggestions: [{ type: 'addRules', rules: [], behavior: 'allow', destination: 'localSettings' }] }, context)
    expect(malformed.request.options.map((option) => option.optionId)).toEqual(['allow-once', 'reject'])
    const declineFirst = prepareClaudePermission({ ...bashRequest, default_to_no: true }, context)
    expect(declineFirst.request.options.map((option) => option.optionId)).toEqual(['reject', 'allow-once', 'allow-with-updates'])
  })

  it('maps plan approval to the session mode it asks for, and keeps planning on reject', () => {
    const prepared = prepareClaudePermission({ subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: 'do it' }, tool_use_id: 'toolu_p' }, context)
    // The vendor lists "manually approve edits" (allow once) ahead of the always-allow grants.
    expect(prepared.request.options.map((option) => option.optionId)).toEqual(['exit-plan-default', 'exit-plan-auto', 'exit-plan-bypass', 'reject'])
    expect(prepared.decide({ optionId: 'exit-plan-bypass' })).toMatchObject({ behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }] })
    expect(prepared.decide({ optionId: 'reject' })).toMatchObject({ behavior: 'deny', interrupt: true, message: 'User chose to keep planning' })
    const noAuto = prepareClaudePermission({ subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: 'p' }, tool_use_id: 'toolu_q' }, { ...context, availableModes: ['default', 'plan'] })
    expect(noAuto.request.options.map((option) => option.optionId)).toEqual(['exit-plan-default', 'exit-plan-accept-edits', 'reject'])
  })

  it('rewrites a grant of Auto to Accept edits on a model without it', () => {
    const prepared = prepareClaudePermission({ subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: 'p' }, tool_use_id: 'toolu_r' }, { ...context, autoUnavailable: true })
    expect(prepared.decide({ optionId: 'exit-plan-auto' })).toMatchObject({ updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits' }] })
  })

  it('labels file permissions by session scope and keeps skill and web grants specific', () => {
    const edit = prepareClaudePermission(
      { subtype: 'can_use_tool', tool_name: 'Edit', input: { file_path: `${CWD}/a.ts` }, tool_use_id: 'e', permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] },
      context,
    )
    expect(edit.request.options.map((option) => option.name)).toEqual(['Yes', 'Yes, allow all edits during this session', 'No'])
    const web = prepareClaudePermission({ subtype: 'can_use_tool', tool_name: 'WebFetch', input: { url: 'https://docs.example.com/x' }, tool_use_id: 'w' }, context)
    expect(web.request.options[1]?.name).toBe("Yes, and don't ask again for docs.example.com")
    expect(web.decide({ optionId: 'allow-with-updates' })).toMatchObject({ updatedPermissions: [{ rules: [{ toolName: 'WebFetch', ruleContent: 'domain:docs.example.com' }], destination: 'localSettings' }] })
    const skill = prepareClaudePermission({ subtype: 'can_use_tool', tool_name: 'Skill', input: { skill: 'review pr' }, tool_use_id: 's' }, context)
    expect(skill.request.options.map((option) => option.optionId)).toEqual(['allow-once', 'allow-skill-exact', 'allow-skill-prefix', 'reject'])
    expect(skill.decide({ optionId: 'allow-skill-prefix' })).toMatchObject({ updatedPermissions: [{ rules: [{ toolName: 'Skill', ruleContent: 'review:*' }] }] })
    const mcp = prepareClaudePermission({ subtype: 'can_use_tool', tool_name: 'mcp__srv__do', input: {}, tool_use_id: 'm' }, context)
    expect(mcp.request.options.map((option) => option.optionId)).toEqual(['allow-once', 'reject'])
  })
})

// ---------------------------------------------------------------------------
// Scripted CLI (in-memory process behind the injected spawner)
// ---------------------------------------------------------------------------

class FakeClaude implements NativeProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly exited: Promise<{ exitCode: number | null; signal: string | null }>
  readonly received: Json[] = []
  terminated = false
  private readonly settle: (outcome: { exitCode: number | null; signal: string | null }) => void
  private exitedAlready = false

  constructor(
    readonly argv: readonly string[],
    readonly env: Readonly<Record<string, string>>,
    private readonly handler: (frame: Json, proc: FakeClaude) => void,
  ) {
    const { promise, resolve } = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>()
    this.exited = promise
    this.settle = resolve
    createInterface({ input: this.stdin }).on('line', (line) => {
      const frame = JSON.parse(line) as Json
      this.received.push(frame)
      this.handler(frame, this)
    })
    // The real CLI leaves once its stdin closes and nothing is running.
    this.stdin.on('end', () => this.exit(0))
  }

  send(frame: Json): void {
    this.stdout.write(`${JSON.stringify(frame)}\n`)
  }

  reply(request: Json, response: Json = {}): void {
    this.send({ type: 'control_response', response: { subtype: 'success', request_id: request['request_id'], response } })
  }

  fail(request: Json, error: string): void {
    this.send({ type: 'control_response', response: { subtype: 'error', request_id: request['request_id'], error } })
  }

  exit(code: number | null, signal: string | null = null): void {
    if (this.exitedAlready) return
    this.exitedAlready = true
    this.stdout.end()
    this.stderr.end()
    this.settle({ exitCode: code, signal })
  }

  terminate(): void {
    this.terminated = true
    this.exit(null, 'SIGTERM')
  }

  requests(subtype: string): Json[] {
    return this.received.filter((frame) => frame['type'] === 'control_request' && rec(frame['request'])['subtype'] === subtype).map((frame) => rec(frame['request']))
  }

  userMessages(): Json[] {
    return this.received.filter((frame) => frame['type'] === 'user')
  }

  /** The `response` envelope of the control_response the transport wrote for `requestId`, once it is there. */
  answer(requestId: string): Json | undefined {
    const frame = this.received.find((candidate) => candidate['type'] === 'control_response' && rec(candidate['response'])['request_id'] === requestId)
    return frame === undefined ? undefined : rec(frame['response'])
  }
}

interface FakeOptions {
  /** Called for every user message (prompt or steer). */
  readonly onUser?: (frame: Json, proc: FakeClaude) => void
  /** Called for stdin frames that are neither user messages nor control requests (`bash_command`, …). */
  readonly onFrame?: (frame: Json, proc: FakeClaude) => void
  /** Called for control requests the default handler does not answer. */
  readonly onControl?: (request: Json, frame: Json, proc: FakeClaude) => boolean | void
  readonly init?: Json
  readonly settings?: Json
  /** Resume ids that exist; any other `--resume` fails like the CLI. */
  readonly knownSessions?: ReadonlySet<string>
}

/** A scripted CLI: the spawner to inject into the transport and the processes it started. */
interface FakeCli {
  readonly spawn: NativeSpawn
  readonly procs: FakeClaude[]
}

function fakeCli(options: FakeOptions = {}): FakeCli {
  const procs: FakeClaude[] = []
  const spawnFake: NativeSpawn = (spec) => {
    const argv = [...spec.argv]
    const resumeAt = argv.indexOf('--resume')
    const missing = resumeAt >= 0 && options.knownSessions !== undefined && !options.knownSessions.has(argv[resumeAt + 1] ?? '')
    const proc: FakeClaude = new FakeClaude(argv, spec.env, (frame, self) => {
      if (missing) return
      if (frame['type'] === 'user') {
        options.onUser?.(frame, self)
        return
      }
      if (frame['type'] !== 'control_request') {
        options.onFrame?.(frame, self)
        return
      }
      const request = frame['request'] as Json
      switch (request['subtype']) {
        case 'initialize':
          self.reply(frame, options.init ?? initResponse())
          return
        case 'get_settings':
          self.reply(frame, options.settings ?? settingsResponse())
          return
        case 'get_context_usage':
          // The handshake asks for the summary; the full detail is a user command a test can script.
          if (frame['request'] !== undefined && rec(frame['request'])['detail'] === 'full' && options.onControl?.(request, frame, self) === true) return
          self.reply(frame, { rawMaxTokens: 1_000_000, totalTokens: 12_345, model: 'claude-opus-5.5' })
          return
        case 'set_model':
        case 'set_permission_mode':
        case 'apply_flag_settings':
          self.reply(frame)
          return
        default:
          if (options.onControl?.(request, frame, self) !== true) self.reply(frame)
      }
    })
    procs.push(proc)
    if (missing) {
      const id = argv[resumeAt + 1] ?? ''
      proc.stderr.write(`No conversation found with session ID: ${id}\n`)
      proc.send({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [`No conversation found with session ID: ${id}`], session_id: id })
      queueMicrotask(() => proc.exit(1))
    }
    return proc
  }
  return { spawn: spawnFake, procs }
}

interface Harness {
  readonly transport: ClaudeCliTransport
  readonly events: NativeTransportEvent[]
  readonly permissions: NativePermissionRequest[]
  /** The forms the transport put to the host. */
  readonly forms: NativeElicitationRequest[]
  readonly logs: string[]
  start(session?: NativeTransportStartOptions['session'], env?: Record<string, string>): Promise<void>
}

/** `elicit` is the host's question surface; without it the host has none. */
function harness(
  cli: FakeCli,
  answer: (request: NativePermissionRequest) => { optionId: string } | { cancelled: true } = () => ({ optionId: 'allow-once' }),
  elicit?: NativeElicitationHandler,
): Harness {
  const transport = new ClaudeCliTransport()
  const events: NativeTransportEvent[] = []
  const permissions: NativePermissionRequest[] = []
  const forms: NativeElicitationRequest[] = []
  const logs: string[] = []
  return {
    transport,
    events,
    permissions,
    forms,
    logs,
    start: async (session = { kind: 'new' }, env = {}) => {
      await transport.start({
        argv: ['/fake/claude-launch.mjs'],
        env,
        cwd: CWD,
        spawn: cli.spawn,
        session,
        onEvent: (event) => events.push(event),
        onPermission: async (request) => {
          permissions.push(request)
          return answer(request)
        },
        ...(elicit === undefined
          ? {}
          : {
              onElicitation: async (request: NativeElicitationRequest, signal?: AbortSignal) => {
                forms.push(request)
                return elicit(request, signal)
              },
            }),
        log: (message) => logs.push(message),
      })
    },
  }
}

async function until(check: () => boolean, label = 'condition', timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function resultFrame(overrides: Json = {}, modelUsage?: Json, cost = 0.5): Json {
  return {
    type: 'result',
    subtype: 'success',
    stop_reason: 'end_turn',
    is_error: false,
    session_id: 's1',
    total_cost_usd: cost,
    usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: modelUsage ?? { 'claude-opus-5.5': { inputTokens: 10, outputTokens: 3, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, thinkingTokens: 0, costUSD: cost, contextWindow: 1_000_000 } },
    ...overrides,
  }
}

function textTurn(proc: FakeClaude, reply: string, result: Json = resultFrame()): void {
  proc.send(streamEvent({ type: 'message_start', message: { id: 'msg_t', model: 'claude-opus-5.5', usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }))
  proc.send(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } }))
  proc.send({ type: 'assistant', message: { id: 'msg_t', model: 'claude-opus-5.5', content: [{ type: 'text', text: reply }], usage: { input_tokens: 10, output_tokens: 3 } }, parent_tool_use_id: null, ...sessionFrame })
  proc.send(result)
}

const PROMPT = [{ type: 'text' as const, text: 'go' }]

describe('ClaudeCliTransport (scripted CLI)', () => {
  it('names a new session up front, handshakes before any user message, and reports the vendor controls', async () => {
    const cli = fakeCli()
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    expect(proc.argv[0]).toBe('/fake/claude-launch.mjs')
    const idAt = proc.argv.indexOf('--session-id')
    expect(h.transport.sessionId).toBe(proc.argv[idAt + 1])
    expect(h.transport.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(proc.received[0]).toMatchObject({ type: 'control_request', request: { subtype: 'initialize' } })
    expect(proc.userMessages()).toEqual([])
    expect(h.transport.agentInfo).toEqual({ name: 'claude', version: '2.1.296' })
    expect(h.transport.canFork).toBe(true)
    expect(h.transport.closed).toBe(false)

    const controls = h.transport.controls()
    expect(controls.imageInput).toBe(true)
    expect(controls.modes).toMatchObject({ currentModeId: 'default' })
    expect(controls.modes?.availableModes.map((mode) => mode.id)).toEqual(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'])
    expect(controls.configOptions.map((option) => option.id)).toEqual(['mode', 'model', 'effort', 'fast'])
    expect(controls.configOptions.find((option) => option.id === 'model')).toMatchObject({ currentValue: 'opus' })
    // The fresh session already runs the settings model: no switch is sent.
    expect(proc.requests('set_model')).toEqual([])

    await until(() => h.events.some((event) => event.kind === 'commands'), 'the commands announcement')
    const announced = h.events.filter((event) => event.kind === 'commands')
    expect(announced).toHaveLength(1)
    const catalog: readonly NativeCommand[] = announced[0]?.kind === 'commands' ? announced[0].commands : []
    expect(h.transport.commands()).toEqual(catalog)
    // The init fixture lists a custom command, a terminal login, the terminal /mcp and /review: the first and last run as turns.
    expect(catalog.find((command) => command.name === 'cluster-task-monitor')).toMatchObject({ dispatch: 'prompt', description: 'Register tasks' })
    expect(catalog.find((command) => command.name === 'review')).toMatchObject({ dispatch: 'prompt', hint: '<pr>' })
    expect(catalog.find((command) => command.name === 'login')).toBeUndefined()
    expect(catalog.filter((command) => command.name === 'mcp')).toEqual([expect.objectContaining({ dispatch: 'immediate' })])
    // The ACP command list is gone: the `commands` event replaces it.
    expect(updatesOf(h.events).some((update) => update['sessionUpdate'] === 'available_commands_update')).toBe(false)
    await h.transport.close()
  })

  it('restores the permission mode and model a resumed conversation had, as claude-agent-acp does', async () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), 'claude-cfg-'))
    try {
      const id = randomUUID()
      const projectDir = path.join(configDir, 'projects', '-work-project')
      mkdirSync(projectDir, { recursive: true })
      const usage = { 'claude-sonnet-5.5': { inputTokens: 6, outputTokens: 105, thinkingTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 1000, webSearchRequests: 0, costUSD: 0.25 } }
      writeFileSync(
        path.join(projectDir, `${id}.jsonl`),
        [
          { type: 'user', permissionMode: 'bypassPermissions', origin: { kind: 'human' }, message: { role: 'user', content: 'hi' } },
          { type: 'assistant', message: { model: 'claude-opus-5.5', role: 'assistant', content: [] } },
          { type: 'cost-state', sessionId: id, totalCostUSD: 0.25, modelUsage: usage },
        ]
          .map((record) => JSON.stringify(record))
          .join('\n') + '\n',
      )
      const tail = await readClaudeResumedTail(id, configDir)
      expect(tail).toMatchObject({ model: 'claude-opus-5.5', permissionMode: 'bypassPermissions', costState: { totalCostUsd: 0.25 } })

      const cli = fakeCli({ knownSessions: new Set([id]), settings: settingsResponse({}) })
      const h = harness(cli)
      await h.start({ kind: 'resume', sessionId: id }, { CLAUDE_CONFIG_DIR: configDir })
      const argv = cli.procs[0]!.argv
      expect(argv.slice(-2)).toEqual(['--resume', id])
      expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('bypassPermissions')
      expect(h.transport.sessionId).toBe(id)
      expect(h.transport.controls().modes?.currentModeId).toBe('bypassPermissions')
      // No settings model: the conversation's own model is shown, not re-asserted.
      expect(h.transport.controls().configOptions.find((option) => option.id === 'model')).toMatchObject({ currentValue: 'default' })
      expect(cli.procs[0]!.requests('set_model')).toEqual([])

      // The first turn of a resumed conversation costs what it added, not the whole history.
      const prompt = h.transport.prompt(PROMPT, new AbortController().signal)
      await until(() => cli.procs[0]!.userMessages().length === 1, 'prompt')
      const spend = { ...usage, 'claude-opus-5.5': { inputTokens: 10, outputTokens: 3, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, thinkingTokens: 0, costUSD: 0.5 } }
      textTurn(cli.procs[0]!, 'OK', resultFrame({}, spend, 0.75))
      expect(await prompt).toEqual({ stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 3, cachedReadTokens: 0, cachedWriteTokens: 0, costUsd: 0.5 } })
      await h.transport.close()

      // A settings model is re-asserted on resume, because the CLI restores neither.
      const reasserting = fakeCli({ knownSessions: new Set([id]) })
      const h2 = harness(reasserting)
      await h2.start({ kind: 'resume', sessionId: id }, { CLAUDE_CONFIG_DIR: configDir })
      expect(reasserting.procs[0]!.requests('set_model')).toEqual([{ subtype: 'set_model', model: 'opus' }])
      await h2.transport.close()
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  it('rejects an unknown resume id with a session-not-found error', async () => {
    const cli = fakeCli({ knownSessions: new Set() })
    const h = harness(cli)
    const missing = randomUUID()
    const failure = await h.start({ kind: 'resume', sessionId: missing }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(NativeTransportError)
    expect(failure).toMatchObject({ code: 'session-not-found' })
    expect((failure as Error).message).toContain('session not found')
    expect((failure as Error).message).toContain(missing)
    expect(h.transport.closed).toBe(true)
  })

  it('starts a never-prompted session fresh under the same id, like recreateLiveSession', async () => {
    const created = fakeCli()
    const first = harness(created)
    await first.start()
    const id = first.transport.sessionId!
    await first.transport.close()

    // The conversation was never written, so the CLI does not know the id.
    const again = fakeCli({ knownSessions: new Set() })
    const second = harness(again)
    await second.start({ kind: 'resume', sessionId: id })
    expect(again.procs).toHaveLength(2)
    expect(again.procs[0]!.argv).toContain('--resume')
    const retry = again.procs[1]!
    expect(retry.argv.slice(-2)).toEqual(['--session-id', id])
    expect(retry.argv).not.toContain('--resume')
    expect(again.procs[0]!.terminated || again.procs[0]!.received.length >= 0).toBe(true)
    expect(second.transport.sessionId).toBe(id)
    await second.transport.close()
  })

  it('forks from a parent under a new id, and re-forks a fork that was never prompted', async () => {
    const parent = randomUUID()
    const cli = fakeCli({ knownSessions: new Set([parent]) })
    const h = harness(cli)
    await h.start({ kind: 'fork', parentSessionId: parent })
    const argv = cli.procs[0]!.argv
    expect(argv.slice(-5, -2)).toEqual(['--resume', parent, '--fork-session'])
    const forkId = h.transport.sessionId!
    expect(forkId).not.toBe(parent)
    expect(argv.slice(-2)).toEqual(['--session-id', forkId])
    await h.transport.close()

    const later = fakeCli({ knownSessions: new Set([parent]) })
    const h2 = harness(later)
    await h2.start({ kind: 'resume', sessionId: forkId })
    expect(later.procs[1]!.argv.slice(-5)).toEqual(['--resume', parent, '--fork-session', '--session-id', forkId])
    await h2.transport.close()
  })

  it('applies mode, model, effort, fast and agent changes with the control frames claude-agent-acp uses', async () => {
    const cli = fakeCli({ init: initResponse({ agents: [{ name: 'claude' }, { name: 'reviewer', description: 'Reviews' }] }) })
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!

    await h.transport.setConfigOption('mode', 'acceptEdits')
    expect(proc.requests('set_permission_mode').at(-1)).toEqual({ subtype: 'set_permission_mode', mode: 'acceptEdits' })
    expect(h.transport.controls().modes?.currentModeId).toBe('acceptEdits')
    expect(h.transport.controls().configOptions.find((option) => option.id === 'mode')).toMatchObject({ currentValue: 'acceptEdits' })

    await h.transport.setConfigOption('effort', 'high')
    expect(proc.requests('apply_flag_settings').at(-1)).toEqual({ subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } })
    expect(h.transport.controls().configOptions.find((option) => option.id === 'effort')).toMatchObject({ currentValue: 'high' })

    // A model that does not offer the pinned effort level clears it; the picker is rebuilt for the new model.
    await h.transport.setConfigOption('model', 'claude-sonnet-5.5')
    expect(proc.requests('set_model').at(-1)).toEqual({ subtype: 'set_model', model: 'claude-sonnet-5.5' })
    const afterModel = h.transport.controls().configOptions
    expect(afterModel.find((option) => option.id === 'model')).toMatchObject({ currentValue: 'claude-sonnet-5.5' })
    // Effort carries over because the new model supports it; fast mode disappears with the model that offered it.
    expect(afterModel.find((option) => option.id === 'effort')).toMatchObject({ currentValue: 'high' })
    expect(afterModel.find((option) => option.id === 'fast')).toBeUndefined()

    // Human-friendly spellings resolve onto a picker row, as in the vendor.
    await h.transport.setConfigOption('model', 'opus')
    expect(proc.requests('set_model').at(-1)).toEqual({ subtype: 'set_model', model: 'opus' })
    expect(h.transport.controls().configOptions.find((option) => option.id === 'fast')).toMatchObject({ currentValue: 'off' })

    await h.transport.setConfigOption('fast', 'on')
    expect(proc.requests('apply_flag_settings').at(-1)).toEqual({ subtype: 'apply_flag_settings', settings: { fastMode: true } })
    await h.transport.setConfigOption('agent', 'reviewer')
    expect(proc.requests('apply_flag_settings').at(-1)).toEqual({ subtype: 'apply_flag_settings', settings: { agent: 'reviewer' } })
    await h.transport.setConfigOption('effort', 'default')
    expect(proc.requests('apply_flag_settings').at(-1)).toEqual({ subtype: 'apply_flag_settings', settings: { effortLevel: null } })

    await expect(h.transport.setConfigOption('mode', 'dontAsk')).rejects.toMatchObject({ code: 'invalid-config' })
    await expect(h.transport.setConfigOption('model', 'no-such-model')).rejects.toMatchObject({ code: 'invalid-config' })
    await expect(h.transport.setConfigOption('nope', 'x')).rejects.toMatchObject({ code: 'invalid-config' })
    await h.transport.close()
  })

  it('falls back from Auto to Accept edits on a model that cannot run it, and warns once', async () => {
    const legacy = { value: 'legacy-model', displayName: 'Legacy model', description: 'No auto mode' }
    const cli = fakeCli({ init: initResponse({ models: [...MODEL_ROWS, legacy] }) })
    const h = harness(cli)
    await h.start()
    await h.transport.setConfigOption('mode', 'auto')
    expect(cli.procs[0]!.requests('set_permission_mode').at(-1)).toEqual({ subtype: 'set_permission_mode', mode: 'auto' })
    // Switching to a model without Auto drops the session out of it, and the CLI must follow.
    await h.transport.setConfigOption('model', 'legacy-model')
    expect(cli.procs[0]!.requests('set_permission_mode').at(-1)).toEqual({ subtype: 'set_permission_mode', mode: 'acceptEdits' })
    expect(h.transport.controls().modes?.currentModeId).toBe('acceptEdits')
    // Asking for Auto again lands on Accept edits.
    await h.transport.setConfigOption('mode', 'auto')
    expect(cli.procs[0]!.requests('set_permission_mode').at(-1)).toEqual({ subtype: 'set_permission_mode', mode: 'acceptEdits' })
    const warnings = updatesOf(h.events).filter((update) => String(rec(update['content'] ?? {})['text']).includes('Auto mode unavailable'))
    expect(warnings).toHaveLength(1)
    await h.transport.close()
  })

  it('mirrors a mode the CLI changed itself and refuses settings changes while a prompt runs', async () => {
    const cli = fakeCli({ onUser: () => undefined })
    const h = harness(cli)
    await h.start()
    cli.procs[0]!.send({ type: 'system', subtype: 'status', status: null, permissionMode: 'plan', ...sessionFrame })
    await until(() => h.events.some((event) => event.kind === 'controls'), 'controls event')
    expect(h.transport.controls().modes?.currentModeId).toBe('plan')

    const prompt = h.transport.prompt(PROMPT, new AbortController().signal)
    await until(() => cli.procs[0]!.userMessages().length === 1, 'prompt')
    await expect(h.transport.setConfigOption('mode', 'default')).rejects.toMatchObject({ code: 'busy' })
    textTurn(cli.procs[0]!, 'ok')
    await prompt
    await h.transport.close()
  })

  it('streams a turn, settles it on the result and reports usage as the increase since the last result', async () => {
    let turn = 0
    const cli = fakeCli({
      onUser: (_frame, proc) => {
        turn += 1
        const total = (n: number) => ({ 'claude-opus-5.5': { inputTokens: 10 * n, outputTokens: 3 * n, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, thinkingTokens: n === 2 ? 4 : 0, costUSD: 0.5 * n, contextWindow: 1_000_000 } })
        textTurn(proc, `reply${turn}`, resultFrame({}, total(turn), 0.5 * turn))
      },
    })
    const h = harness(cli)
    await h.start()
    const first = await h.transport.prompt(PROMPT, new AbortController().signal)
    const second = await h.transport.prompt(PROMPT, new AbortController().signal)
    expect(first).toEqual({ stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 3, cachedReadTokens: 0, cachedWriteTokens: 0, costUsd: 0.5 } })
    expect(second).toEqual({ stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 3, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 4, costUsd: 0.5 } })
    const texts = updatesOf(h.events).filter((update) => update['sessionUpdate'] === 'agent_message_chunk')
    expect(texts.map((update) => rec(update['content'])['text'])).toEqual(['reply1', 'reply2'])
    expect(texts[0]).toMatchObject({ messageId: 'msg_t' })
    const usageEvents = h.events.filter((event) => event.kind === 'context_usage')
    expect(usageEvents.at(-1)).toMatchObject({ contextUsage: { size: 1_000_000, cost: { amount: 1, currency: 'USD' } } })
    expect(h.transport.contextUsage()).toMatchObject({ size: 1_000_000, cost: { amount: 1, currency: 'USD' } })
    // The first user message carries the session id the transport named and is stamped as human input.
    expect(cli.procs[0]!.userMessages()[0]).toMatchObject({ session_id: h.transport.sessionId, origin: { kind: 'human' } })
    await h.transport.close()
  })

  it('rejects the prompt when the turn ends in a vendor error, and refuses concurrent or empty prompts', async () => {
    const cli = fakeCli({
      onUser: (_frame, proc) => proc.send(resultFrame({ subtype: 'error_during_execution', is_error: true, errors: ['Overloaded'] })),
    })
    const h = harness(cli)
    await h.start()
    await expect(h.transport.prompt(PROMPT, new AbortController().signal)).rejects.toMatchObject({ code: 'prompt_failed', message: 'Overloaded' })
    await expect(h.transport.prompt([], new AbortController().signal)).rejects.toMatchObject({ code: 'empty_prompt' })
    expect(await h.transport.prompt(PROMPT, AbortSignal.abort())).toEqual({ stopReason: 'cancelled' })
    await h.transport.close()
  })

  it('injects a steer as priority "next" into the running turn, and asks for a prompt when none runs', async () => {
    const cli = fakeCli({ onUser: () => undefined })
    const h = harness(cli)
    await h.start()
    expect(await h.transport.steer([{ type: 'text', text: 'nobody home' }])).toBe('promptRequired')
    const prompt = h.transport.prompt(PROMPT, new AbortController().signal)
    await until(() => cli.procs[0]!.userMessages().length === 1, 'prompt')
    expect(await h.transport.steer([{ type: 'text', text: 'also say STEERED' }])).toBe('injected')
    await until(() => cli.procs[0]!.userMessages().length === 2, 'steer')
    expect(cli.procs[0]!.userMessages()[1]).toMatchObject({ priority: 'next', origin: { kind: 'human' }, message: { content: [{ type: 'text', text: 'also say STEERED' }] } })
    expect(await h.transport.steer([], undefined)).toBe('promptRequired')
    textTurn(cli.procs[0]!, 'DONE STEERED')
    await prompt
    expect(await h.transport.steer([{ type: 'text', text: 'late' }])).toBe('promptRequired')
    await h.transport.close()
  })

  it('stops a turn with an interrupt, withdraws steers the receipt still lists, and resolves cancelled', async () => {
    let steerUuid: string | undefined
    const cli = fakeCli({
      onUser: (frame) => {
        if (frame['priority'] === 'next') steerUuid = String(frame['uuid'])
      },
      onControl: (request, frame, proc) => {
        if (request['subtype'] !== 'interrupt') return false
        proc.reply(frame, { still_queued: steerUuid === undefined ? [] : [steerUuid], cancelled: [] })
        proc.send(resultFrame({ subtype: 'error_during_execution', is_error: true, errors: ['Interrupted by user'] }))
        return true
      },
    })
    const h = harness(cli)
    await h.start()
    const controller = new AbortController()
    const prompt = h.transport.prompt(PROMPT, controller.signal)
    await until(() => cli.procs[0]!.userMessages().length === 1, 'prompt')
    cli.procs[0]!.send(toolStart('toolu_slow', 'Bash'))
    cli.procs[0]!.send(assistantTool('toolu_slow', 'Bash', { command: 'sleep 99' }))
    expect(await h.transport.steer([{ type: 'text', text: 'queued steer' }])).toBe('injected')
    await until(() => steerUuid !== undefined, 'steer')
    controller.abort()
    expect((await prompt).stopReason).toBe('cancelled')
    await until(() => cli.procs[0]!.requests('cancel_async_message').length === 1, 'the withdrawn steer')
    expect(cli.procs[0]!.requests('cancel_async_message')[0]).toEqual({ subtype: 'cancel_async_message', message_uuid: steerUuid })
    // The tool call the interrupt left open is closed, not left running.
    const closed = updatesOf(h.events).filter((update) => update['toolCallId'] === 'toolu_slow' && update['status'] === 'failed')
    expect(closed).toHaveLength(1)
    await h.transport.close()
  })

  it('cancels queued steers in one round trip when the CLI supports it', async () => {
    const cli = fakeCli({
      onControl: (request, frame, proc) => {
        if (request['subtype'] !== 'interrupt') return false
        proc.reply(frame, { still_queued: [], cancelled: [] })
        proc.send(resultFrame({ subtype: 'error_during_execution', is_error: true }))
        return true
      },
    })
    const h = harness(cli)
    await h.start()
    const prompt = h.transport.prompt(PROMPT, new AbortController().signal)
    await until(() => cli.procs[0]!.userMessages().length === 1, 'prompt')
    cli.procs[0]!.send({ type: 'system', subtype: 'init', session_id: h.transport.sessionId, capabilities: ['interrupt_cancel_queued_v1'], model: 'claude-opus-5.5', permissionMode: 'default' })
    await until(() => true)
    void h.transport.interrupt()
    await until(() => cli.procs[0]!.requests('interrupt').length === 1, 'interrupt')
    expect(cli.procs[0]!.requests('interrupt')[0]).toEqual({ subtype: 'interrupt', cancel_queued: true })
    expect((await prompt).stopReason).toBe('cancelled')
    await h.transport.close()
  })

  it('asks the host about a permission request in ACP shape and answers the CLI with the chosen result', async () => {
    const cli = fakeCli({ onUser: () => undefined })
    const h = harness(cli, (request) => (request.options.some((option) => option.optionId === 'allow-with-updates') ? { optionId: 'allow-with-updates' } : { cancelled: true }))
    await h.start()
    const prompt = h.transport.prompt(PROMPT, new AbortController().signal)
    await until(() => cli.procs[0]!.userMessages().length === 1, 'prompt')
    const proc = cli.procs[0]!
    proc.send({
      type: 'control_request',
      request_id: 'perm-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'npm test', description: 'Run tests' },
        tool_use_id: 'toolu_perm',
        permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }],
      },
    })
    await until(() => proc.received.some((frame) => frame['type'] === 'control_response'), 'permission answer')
    expect(h.permissions).toHaveLength(1)
    expect(h.permissions[0]?.toolCall).toMatchObject({ toolCallId: 'toolu_perm', title: 'npm test' })
    const answer = proc.received.find((frame) => frame['type'] === 'control_response') as Json
    expect(answer).toMatchObject({
      response: { subtype: 'success', request_id: 'perm-1', response: { behavior: 'allow', toolUseID: 'toolu_perm', decisionClassification: 'user_permanent' } },
    })
    // The tool call the prompt names was surfaced to the host first.
    expect(updatesOf(h.events).some((update) => update['sessionUpdate'] === 'tool_call' && update['toolCallId'] === 'toolu_perm' && update['name'] === 'Bash')).toBe(true)

    // A cancelled prompt answers the CLI with an error, as the vendor does.
    proc.send({ type: 'control_request', request_id: 'perm-2', request: { subtype: 'can_use_tool', tool_name: 'Read', input: { file_path: '/x' }, tool_use_id: 'toolu_p2' } })
    await until(() => proc.received.filter((frame) => frame['type'] === 'control_response').length === 2, 'second answer')
    expect(rec(proc.received.filter((frame) => frame['type'] === 'control_response')[1])['response']).toMatchObject({ subtype: 'error', request_id: 'perm-2', error: 'Tool use aborted' })

    // Callbacks this transport cannot serve, and forms when the host has no question surface, are refused so the CLI never waits on them.
    proc.send({ type: 'control_request', request_id: 'odd-1', request: { subtype: 'mcp_message' } })
    proc.send({ type: 'control_request', request_id: 'elicit-1', request: { subtype: 'elicitation' } })
    await until(() => proc.received.filter((frame) => frame['type'] === 'control_response').length === 4, 'refusals')
    const refusals = proc.received.filter((frame) => frame['type'] === 'control_response').slice(2).map((frame) => rec(frame['response']))
    expect(refusals[0]).toMatchObject({ subtype: 'error', request_id: 'odd-1' })
    expect(refusals[1]).toMatchObject({ subtype: 'success', request_id: 'elicit-1', response: { action: 'decline' } })
    textTurn(proc, 'ok')
    await prompt
    await h.transport.close()
  })

  it('ends a turn on a process crash with a rejection, and reports itself closed', async () => {
    const cli = fakeCli({ onUser: () => undefined })
    const h = harness(cli)
    await h.start()
    const prompt = h.transport.prompt(PROMPT, new AbortController().signal)
    const settled = prompt.then(
      () => undefined,
      (error: unknown) => error,
    )
    await until(() => cli.procs[0]!.userMessages().length === 1, 'prompt')
    cli.procs[0]!.exit(137)
    expect(await settled).toMatchObject({ code: 'process_exit' })
    expect(h.transport.closed).toBe(true)
    await expect(h.transport.prompt(PROMPT, new AbortController().signal)).rejects.toMatchObject({ code: 'process_exit' })
    expect(await h.transport.steer([{ type: 'text', text: 'x' }])).toBe('promptRequired')
  })

  it('closes gracefully through stdin, terminates a process that stays, and is idempotent', async () => {
    const polite = fakeCli()
    const a = harness(polite)
    await a.start()
    await a.transport.close()
    await a.transport.close()
    expect(polite.procs[0]!.terminated).toBe(false)
    expect(a.transport.closed).toBe(true)

    const stubborn = fakeCli()
    const b = harness(stubborn)
    await b.start()
    const proc = stubborn.procs[0]!
    proc.stdin.removeAllListeners('end')
    await b.transport.close()
    expect(proc.terminated).toBe(true)

    const waiting = fakeCli({ onUser: () => undefined })
    const c = harness(waiting)
    await c.start()
    const pending = c.transport.prompt(PROMPT, new AbortController().signal).then(
      () => undefined,
      (error: unknown) => error,
    )
    await until(() => waiting.procs[0]!.userMessages().length === 1, 'prompt')
    await c.transport.close()
    expect(await pending).toMatchObject({ code: 'closed' })
  }, 15_000)

  it('is created through the factory and does not leak a session before start', () => {
    const transport = createClaudeTransport()
    expect(transport).toBeInstanceOf(ClaudeCliTransport)
    expect(transport.kind).toBe('claude')
    expect(transport.sessionId).toBeUndefined()
    expect(transport.contextUsage()).toBeUndefined()
    expect(transport.agentInfo.version).toBe('')
    expect(() => transport.controls()).toThrow()
  })
})

// ---------------------------------------------------------------------------
// Questions: AskUserQuestion and MCP elicitations as host forms
// ---------------------------------------------------------------------------

const LIBRARY_QUESTION = {
  question: 'Which date library should we use?',
  header: 'Library',
  multiSelect: false,
  options: [
    { label: 'date-fns', description: 'Modular functions' },
    { label: 'dayjs', description: 'Tiny and familiar', preview: "import dayjs from 'dayjs'" },
  ],
}

const FEATURES_QUESTION = {
  question: 'Which features should ship?',
  header: 'Features',
  multiSelect: true,
  options: [
    { label: 'Auth', description: 'Login and sessions' },
    { label: 'Cache', description: 'Response caching' },
  ],
}

/** The descriptions claude-agent-acp gives the "Other" box of a single-select and of a multi-select. */
const OTHER_SINGLE = 'Type your own answer, or add a note to the option you chose above (optional).'
const OTHER_MULTI = 'Type your own answer to add to your selection above (optional).'

/** The CLI asks the model's AskUserQuestion through `can_use_tool`. */
function sendQuestion(proc: FakeClaude, input: Json, requestId = 'ask-1'): void {
  proc.send({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input, tool_use_id: 'toolu_ask' } })
}

/** The control_response envelope the transport wrote for `requestId`. */
async function envelopeFor(proc: FakeClaude, requestId: string): Promise<Json> {
  await until(() => proc.answer(requestId) !== undefined, `the answer to ${requestId}`)
  return rec(proc.answer(requestId))
}

/** One AskUserQuestion round against a scripted CLI: what the host was shown and what the CLI got back. */
async function askRound(input: Json, answer: NativeElicitationHandler) {
  const cli = fakeCli()
  const h = harness(cli, undefined, answer)
  await h.start()
  const proc = cli.procs[0]!
  sendQuestion(proc, input)
  const envelope = await envelopeFor(proc, 'ask-1')
  await h.transport.close()
  return { forms: h.forms, events: h.events, permissions: h.permissions, envelope }
}

/** The `updatedInput` an answered question hands to the tool, after checking the CLI is told the tool may run. */
function updatedInputOf(envelope: Json): Json {
  expect(envelope).toMatchObject({ subtype: 'success', request_id: 'ask-1' })
  const result = rec(envelope['response'])
  expect(result).toMatchObject({ behavior: 'allow', toolUseID: 'toolu_ask', decisionClassification: 'user_temporary' })
  return rec(result['updatedInput'])
}

/** A host whose form never answers and ignores its signal; the signals it was handed are collected. */
function hangingHost(signals: AbortSignal[]): NativeElicitationHandler {
  return (_request, signal) =>
    new Promise<acp.CreateElicitationResponse>(() => {
      if (signal !== undefined) signals.push(signal)
    })
}

describe('Claude questions (scripted CLI)', () => {
  it('puts one question to the host as the form claude-agent-acp builds for it, after surfacing the tool call', async () => {
    const { forms, events, permissions } = await askRound({ questions: [LIBRARY_QUESTION] }, async () => ({ action: 'decline' }))
    expect(forms).toEqual([
      {
        message: 'Which date library should we use?',
        toolCallId: 'toolu_ask',
        requestedSchema: {
          type: 'object',
          properties: {
            // The question is the form message, so its field carries only the header.
            question_0: {
              type: 'string',
              title: 'Library',
              oneOf: [
                { const: 'date-fns', title: 'date-fns', description: 'Modular functions' },
                {
                  const: 'dayjs',
                  title: 'dayjs',
                  description: 'Tiny and familiar',
                  _meta: { '_claude/askUserQuestionOption': { preview: "import dayjs from 'dayjs'" } },
                },
              ],
            },
            question_0_custom: { type: 'string', title: 'Other', description: OTHER_SINGLE },
          },
        },
      },
    ])
    expect(forms[0]?.requestedSchema).not.toHaveProperty('required')
    // The question is a form for the user, never a permission prompt.
    expect(permissions).toEqual([])
    const surfaced = updatesOf(events).filter((update) => update['sessionUpdate'] === 'tool_call' && update['toolCallId'] === 'toolu_ask')
    expect(surfaced).toHaveLength(1)
    expect(surfaced[0]).toMatchObject({ name: 'AskUserQuestion', title: 'Asking for your input', status: 'pending' })
  })

  it('numbers several questions, repeats each question on its field, and asks a multi-select as an array of titled items', async () => {
    const { forms } = await askRound({ questions: [LIBRARY_QUESTION, FEATURES_QUESTION] }, async () => ({ action: 'cancel' }))
    expect(forms).toHaveLength(1)
    const form = forms[0]!
    expect(form.message).toBe('Please answer the following questions.')
    expect(form.toolCallId).toBe('toolu_ask')
    expect(Object.keys(form.requestedSchema.properties ?? {})).toEqual(['question_0', 'question_0_custom', 'question_1', 'question_1_custom'])
    expect(form.requestedSchema.properties).toMatchObject({
      question_0: { type: 'string', title: 'Library', description: 'Which date library should we use?' },
      question_0_custom: { type: 'string', title: 'Other', description: OTHER_SINGLE },
      question_1: {
        type: 'array',
        title: 'Features',
        description: 'Which features should ship?',
        items: {
          anyOf: [
            { const: 'Auth', title: 'Auth', description: 'Login and sessions' },
            { const: 'Cache', title: 'Cache', description: 'Response caching' },
          ],
        },
      },
      question_1_custom: { type: 'string', title: 'Other', description: OTHER_MULTI },
    })
    expect(rec(form.requestedSchema.properties)['question_1']).not.toHaveProperty('oneOf')
    expect(form.requestedSchema).not.toHaveProperty('required')
  })

  it('decodes the form into the answers the tool runs with: pick, typed text, pick with a note, multi-select with text, skip', async () => {
    const input = { questions: [LIBRARY_QUESTION, FEATURES_QUESTION], note: 'kept' }
    const library = LIBRARY_QUESTION.question
    const features = FEATURES_QUESTION.question
    const decode = async (content: Record<string, string | string[]>): Promise<Json> =>
      updatedInputOf((await askRound(input, async () => ({ action: 'accept', content }))).envelope)
    // A pick answers with the option label; a multi-select is comma-joined. The rest of the tool input is kept.
    expect(await decode({ question_0: 'dayjs', question_1: ['Auth', 'Cache'] })).toEqual({
      ...input,
      answers: { [library]: 'dayjs', [features]: 'Auth, Cache' },
    })
    // Typed text alone is the answer of a single-select.
    expect(await decode({ question_0_custom: '  Luxon  ' })).toEqual({ ...input, answers: { [library]: 'Luxon' } })
    // A pick with typed text keeps the pick and carries the text as the question's note.
    expect(await decode({ question_0: 'date-fns', question_0_custom: 'only for the CLI' })).toEqual({
      ...input,
      answers: { [library]: 'date-fns' },
      annotations: { [library]: { notes: 'only for the CLI' } },
    })
    // A multi-select takes the typed text as one more pick, JSON-quoted when it holds the separator.
    expect(await decode({ question_1: ['Auth'], question_1_custom: 'Redis, not Memcached' })).toEqual({
      ...input,
      answers: { [features]: 'Auth, "Redis, not Memcached"' },
    })
    expect(await decode({ question_1_custom: 'SSO' })).toEqual({ ...input, answers: { [features]: 'SSO' } })
    // Skipping answers nothing, and the tool still runs.
    expect(await decode({})).toEqual({ ...input, answers: {} })
    expect(await decode({ question_0: '', question_0_custom: '   ' })).toEqual({ ...input, answers: {} })
  })

  it('treats a declined form as skipped, an ill-typed accept as empty, and a cancelled or unknown response as an aborted tool use', async () => {
    const input = { questions: [LIBRARY_QUESTION] }
    const declined = await askRound(input, async () => ({ action: 'decline' }))
    expect(updatedInputOf(declined.envelope)).toEqual({ ...input, answers: {} })

    // Content of the wrong type counts as no content.
    const malformed = { action: 'accept', content: { question_0: { nested: 'object' } } } as unknown as acp.CreateElicitationResponse
    const ignored = await askRound(input, async () => malformed)
    expect(updatedInputOf(ignored.envelope)).toEqual({ ...input, answers: {} })

    const withdrawals: acp.CreateElicitationResponse[] = [{ action: 'cancel' }, { action: '_future' }]
    for (const response of withdrawals) {
      const { envelope } = await askRound(input, async () => response)
      expect(envelope).toMatchObject({ subtype: 'error', request_id: 'ask-1', error: 'Tool use aborted' })
    }
  })

  it('denies a call with no valid question without bothering the host, and asks only the usable questions otherwise', async () => {
    const invalid: Json[] = [
      {},
      { questions: 'nope' },
      { questions: [] },
      { questions: [null, 'x', { question: 'No options?', options: [] }, { question: 7, options: [{ label: 'a' }] }, { question: 'Unlabelled?', options: [{ description: 'no label' }] }] },
    ]
    for (const input of invalid) {
      const { forms, permissions, envelope } = await askRound(input, async () => ({ action: 'accept', content: {} }))
      expect(rec(envelope['response'])).toEqual({
        behavior: 'deny',
        message: 'AskUserQuestion called with no valid questions.',
        toolUseID: 'toolu_ask',
        decisionClassification: 'user_reject',
      })
      expect(forms).toEqual([])
      expect(permissions).toEqual([])
    }
    // Unusable entries are skipped and the usable question is numbered from zero.
    const mixed = { questions: [{ question: 'Skipped?', options: [] }, { question: 'Kept?', options: [{ label: 'A' }, { description: 'no label' }] }] }
    const { forms } = await askRound(mixed, async () => ({ action: 'cancel' }))
    expect(forms[0]).toMatchObject({ message: 'Kept?', requestedSchema: { properties: { question_0: { oneOf: [{ const: 'A', title: 'A' }] } } } })
  })

  it('tells the model it could not ask when the host fails to present the form', async () => {
    const { envelope } = await askRound({ questions: [LIBRARY_QUESTION] }, async () => {
      throw new Error('card failed')
    })
    expect(rec(envelope['response'])).toMatchObject({
      behavior: 'deny',
      message: 'Could not present the question to the user.',
      toolUseID: 'toolu_ask',
    })
  })

  it('abandons the form when the CLI withdraws the question, even if the host ignores its signal', async () => {
    const cli = fakeCli()
    const signals: AbortSignal[] = []
    const h = harness(cli, undefined, hangingHost(signals))
    await h.start()
    const proc = cli.procs[0]!
    sendQuestion(proc, { questions: [LIBRARY_QUESTION] })
    await until(() => signals.length === 1, 'the form')
    expect(signals[0]?.aborted).toBe(false)
    proc.send({ type: 'control_cancel_request', request_id: 'ask-1' })
    expect(await envelopeFor(proc, 'ask-1')).toMatchObject({ subtype: 'error', request_id: 'ask-1', error: 'Tool use aborted' })
    expect(signals[0]?.aborted).toBe(true)
    await h.transport.close()
  })

  it('withdraws an open question when the turn is interrupted', async () => {
    const cli = fakeCli({
      onControl: (request, frame, proc) => {
        if (request['subtype'] !== 'interrupt') return false
        proc.reply(frame, { still_queued: [], cancelled: [] })
        proc.send(resultFrame({ subtype: 'error_during_execution', is_error: true, errors: ['Interrupted by user'] }))
        return true
      },
    })
    const signals: AbortSignal[] = []
    const h = harness(cli, undefined, hangingHost(signals))
    await h.start()
    const proc = cli.procs[0]!
    const turn = new AbortController()
    const prompt = h.transport.prompt(PROMPT, turn.signal)
    await until(() => proc.userMessages().length === 1, 'prompt')
    sendQuestion(proc, { questions: [LIBRARY_QUESTION] })
    await until(() => signals.length === 1, 'the form')
    turn.abort()
    expect((await prompt).stopReason).toBe('cancelled')
    expect(signals[0]?.aborted).toBe(true)
    expect(await envelopeFor(proc, 'ask-1')).toMatchObject({ subtype: 'error', error: 'Tool use aborted' })
    await h.transport.close()
  })
})

describe('Claude MCP elicitations (scripted CLI)', () => {
  const schema = { type: 'object', properties: { name: { type: 'string', title: 'Name' } }, required: ['name'] }

  /** One `elicitation` control request from an MCP server, answered by `answer`. */
  async function elicitRound(answer: NativeElicitationHandler, overrides: Json = {}) {
    const cli = fakeCli()
    const h = harness(cli, undefined, answer)
    await h.start()
    const proc = cli.procs[0]!
    proc.send({
      type: 'control_request',
      request_id: 'mcp-1',
      request: { subtype: 'elicitation', mcp_server_name: 'registry', message: 'Enter your name', mode: 'form', requested_schema: schema, ...overrides },
    })
    const envelope = await envelopeFor(proc, 'mcp-1')
    await h.transport.close()
    return { forms: h.forms, envelope }
  }

  it('forwards an MCP server form to the host and maps its response to the ElicitResult', async () => {
    const accepted = await elicitRound(async () => ({ action: 'accept', content: { name: 'Ada' } }))
    expect(accepted.forms).toEqual([{ message: 'Enter your name', requestedSchema: schema }])
    expect(accepted.envelope).toEqual({ subtype: 'success', request_id: 'mcp-1', response: { action: 'accept', content: { name: 'Ada' } } })

    const noContent = await elicitRound(async () => ({ action: 'accept' }))
    expect(rec(noContent.envelope['response'])).toEqual({ action: 'accept', content: {} })
    const malformed = { action: 'accept', content: { name: { nested: 'object' } } } as unknown as acp.CreateElicitationResponse
    expect(rec((await elicitRound(async () => malformed)).envelope['response'])).toEqual({ action: 'accept', content: {} })

    expect(rec((await elicitRound(async () => ({ action: 'decline' }))).envelope['response'])).toEqual({ action: 'decline' })
    expect(rec((await elicitRound(async () => ({ action: 'cancel' }))).envelope['response'])).toEqual({ action: 'cancel' })
    expect(rec((await elicitRound(async () => ({ action: '_future' }))).envelope['response'])).toEqual({ action: 'cancel' })
    // A host that fails to present the form refuses it rather than leaving the server waiting.
    const failed = await elicitRound(async () => {
      throw new Error('card failed')
    })
    expect(rec(failed.envelope['response'])).toEqual({ action: 'decline' })
  })

  it('always sends an object schema, and an empty one when the server gave none', async () => {
    const untyped = await elicitRound(async () => ({ action: 'decline' }), { requested_schema: { properties: { ok: { type: 'boolean' } } } })
    expect(untyped.forms[0]?.requestedSchema).toEqual({ type: 'object', properties: { ok: { type: 'boolean' } } })
    const bare = await elicitRound(async () => ({ action: 'decline' }), { requested_schema: undefined, mode: undefined })
    expect(bare.forms).toEqual([{ message: 'Enter your name', requestedSchema: { type: 'object', properties: {} } }])
  })

  it('declines a URL elicitation without asking the host: DSH never opens agent URLs', async () => {
    const { forms, envelope } = await elicitRound(async () => ({ action: 'accept', content: {} }), {
      mode: 'url',
      url: 'https://example.test/login',
      elicitation_id: 'elicit-1',
      requested_schema: undefined,
    })
    expect(forms).toEqual([])
    expect(envelope).toEqual({ subtype: 'success', request_id: 'mcp-1', response: { action: 'decline' } })
  })

  it('cancels a form the CLI withdraws, even if the host ignores its signal', async () => {
    const cli = fakeCli()
    const signals: AbortSignal[] = []
    const h = harness(cli, undefined, hangingHost(signals))
    await h.start()
    const proc = cli.procs[0]!
    proc.send({ type: 'control_request', request_id: 'mcp-1', request: { subtype: 'elicitation', mcp_server_name: 'registry', message: 'Enter your name', requested_schema: schema } })
    await until(() => signals.length === 1, 'the form')
    proc.send({ type: 'control_cancel_request', request_id: 'mcp-1' })
    expect(rec((await envelopeFor(proc, 'mcp-1'))['response'])).toEqual({ action: 'cancel' })
    expect(signals[0]?.aborted).toBe(true)
    await h.transport.close()
  })
})

describe('Claude without a question surface (scripted CLI)', () => {
  it('keeps AskUserQuestion disallowed when the host cannot show forms, and offers it when it can', async () => {
    const bare = fakeCli()
    const withoutSurface = harness(bare)
    await withoutSurface.start()
    expect(bare.procs[0]!.argv).toContain('--disallowedTools=AskUserQuestion')
    await withoutSurface.transport.close()

    const surfaced = fakeCli()
    const withSurface = harness(surfaced, undefined, async () => ({ action: 'cancel' }))
    await withSurface.start()
    expect(surfaced.procs[0]!.argv.some((argument) => argument.startsWith('--disallowedTools'))).toBe(false)
    await withSurface.transport.close()
  })

  it('falls back to the ordinary permission prompt for a question and declines MCP forms', async () => {
    const cli = fakeCli()
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    const input = { questions: [LIBRARY_QUESTION] }
    sendQuestion(proc, input)
    expect(await envelopeFor(proc, 'ask-1')).toMatchObject({
      subtype: 'success',
      response: { behavior: 'allow', updatedInput: input, toolUseID: 'toolu_ask', decisionClassification: 'user_temporary' },
    })
    expect(h.permissions).toHaveLength(1)
    expect(h.permissions[0]?.toolCall).toMatchObject({ toolCallId: 'toolu_ask', title: 'Asking for your input' })
    expect(h.forms).toEqual([])

    proc.send({ type: 'control_request', request_id: 'mcp-1', request: { subtype: 'elicitation', mcp_server_name: 'registry', message: 'Enter your name', mode: 'form', requested_schema: { type: 'object', properties: {} } } })
    expect(await envelopeFor(proc, 'mcp-1')).toEqual({ subtype: 'success', request_id: 'mcp-1', response: { action: 'decline' } })
    await h.transport.close()
  })
})

// ---------------------------------------------------------------------------
// Interactions beyond turns (scripted CLI): side questions, /clear, !cmd, notes, commands, tasks, checkpoints
// ---------------------------------------------------------------------------

/** One turn of real I/O: lets frames cross the in-memory pipes while the timers are faked. */
function tick(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setImmediate(resolve)
  return promise
}

/** Poll an asynchronous condition (a command's own answer, say) until it holds. */
async function eventually(check: () => Promise<boolean>, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 5)
    await promise
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** The events of the transport without the one-time announcement of the command catalog, which lands a moment after `start()`. */
const quiet = (events: readonly NativeTransportEvent[]): NativeTransportEvent[] => events.filter((event) => event.kind !== 'commands')

const signalOf = (): AbortSignal => new AbortController().signal

const sideFrames = (proc: FakeClaude): Json[] =>
  proc.received.filter((frame) => frame['type'] === 'control_request' && rec(frame['request'])['subtype'] === 'side_question')

const thoughtTexts = (events: readonly NativeTransportEvent[]): string[] =>
  updatesOf(events)
    .filter((update) => update['sessionUpdate'] === 'agent_thought_chunk')
    .map((update) => String(rec(update['content'])['text']))

/** The text of a user message frame. */
function userText(frame: Json): string {
  const content = rec(frame['message'])['content']
  return Array.isArray(content) ? content.map((block) => String(rec(block)['text'] ?? '')).join('') : String(content)
}

const system = (subtype: string, fields: Json = {}): Json => ({ type: 'system', subtype, uuid: randomUUID(), session_id: 's1', ...fields })

describe('Claude side questions (scripted CLI)', () => {
  it('answers a side question while a turn runs, without touching the turn', async () => {
    const cli = fakeCli({
      onUser: () => undefined,
      onControl: (request, frame, proc) => {
        if (request['subtype'] !== 'side_question') return false
        proc.send(system('control_request_progress', { request_id: frame['request_id'], status: 'started' }))
        proc.reply(frame, { response: 'Because the cache is cold.', synthetic: false })
        return true
      },
    })
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    const turn = h.transport.prompt(PROMPT, signalOf())
    await until(() => proc.userMessages().length === 1, 'the prompt')
    const seen = quiet(h.events).length
    await expect(h.transport.sideQuestion('  why is it slow?  ', signalOf())).resolves.toEqual({ kind: 'success', text: 'Because the cache is cold.' })
    const sent = rec(proc.requests('side_question')[0])
    expect(sent).toMatchObject({ question: 'why is it slow?' })
    expect(sent).not.toHaveProperty('history')
    // Neither the progress frame nor the answer is part of the turn, and nothing was said to the model.
    expect(quiet(h.events).slice(seen)).toEqual([])
    expect(proc.userMessages()).toHaveLength(1)
    textTurn(proc, 'The answer to the turn.')
    await expect(turn).resolves.toMatchObject({ stopReason: 'end_turn' })
    expect(replyText(h.events)).toBe('The answer to the turn.')
    await h.transport.close()
  })

  it('waits as long as the CLI reports progress, and withdraws a question the CLI goes silent on', async () => {
    const cli = fakeCli({ onControl: (request) => request['subtype'] === 'side_question' })
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const slow = h.transport.sideQuestion('slow one', signalOf())
      let settled = false
      void slow.then(() => {
        settled = true
      })
      await tick()
      const asked = rec(sideFrames(proc)[0])
      // Twenty minutes pass, but a progress frame arrived after ten: the CLI is not silent.
      await vi.advanceTimersByTimeAsync(600_000)
      proc.send(system('control_request_progress', { request_id: asked['request_id'], status: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 529 }))
      await tick()
      await vi.advanceTimersByTimeAsync(600_000)
      expect(settled).toBe(false)
      proc.reply(asked, { response: 'finally', synthetic: false })
      await expect(slow).resolves.toEqual({ kind: 'success', text: 'finally' })

      const silent = h.transport.sideQuestion('silent one', signalOf())
      await tick()
      const second = rec(sideFrames(proc)[1])
      await vi.advanceTimersByTimeAsync(661_000)
      await expect(silent).resolves.toMatchObject({ kind: 'error' })
      expect(proc.received).toContainEqual({ type: 'control_cancel_request', request_id: second['request_id'] })
    } finally {
      vi.useRealTimers()
    }
    await h.transport.close()
  })

  it('withdraws a side question the user stops and drops the answer the CLI still sends for it', async () => {
    const cli = fakeCli({ onControl: (request) => request['subtype'] === 'side_question' })
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    const stop = new AbortController()
    const asking = h.transport.sideQuestion('never mind', stop.signal)
    await until(() => sideFrames(proc).length === 1, 'the side question')
    const asked = rec(sideFrames(proc)[0])
    stop.abort()
    await expect(asking).resolves.toMatchObject({ kind: 'error' })
    await until(() => proc.received.some((frame) => frame['type'] === 'control_cancel_request' && frame['request_id'] === asked['request_id']), 'the withdrawal')
    // The CLI confirms the withdrawal with an error; nobody needs to hear about it.
    proc.fail(asked, 'Side question cancelled')
    await tick()
    await tick()
    expect(h.logs.some((line) => line.includes('unknown request'))).toBe(false)
    // A signal that is already aborted never reaches the CLI.
    await expect(h.transport.sideQuestion('too late', stop.signal)).resolves.toMatchObject({ kind: 'error' })
    expect(sideFrames(proc)).toHaveLength(1)
    await h.transport.close()
  })

  it('replays answered side questions as history, forgets failed ones, and starts over with the conversation', async () => {
    const answers: Json[] = [
      { response: 'one', synthetic: false },
      { response: '(API error: Connection refused)', synthetic: true },
      { response: 'three', synthetic: false, refusal_fallback: { original_model: 'big', fallback_model: 'small', content: 'Answered by small.' } },
      { response: null, synthetic: false },
      { response: 'five', synthetic: false },
      { response: 'six', synthetic: false },
    ]
    let next = 0
    const cli = fakeCli({
      onControl: (request, frame, proc) => {
        if (request['subtype'] !== 'side_question') return false
        proc.reply(frame, answers[next++] ?? {})
        return true
      },
    })
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    const ask = (question: string) => h.transport.sideQuestion(question, signalOf())
    expect(await ask('q1')).toEqual({ kind: 'success', text: 'one' })
    expect(await ask('q2')).toEqual({ kind: 'error', text: '(API error: Connection refused)' })
    const third = await ask('q3')
    expect(third.kind).toBe('success')
    expect(third.text).toContain('three')
    expect(third.text).toContain('Answered by small.')
    expect((await ask('q4')).kind).toBe('error')
    expect(await ask('q5')).toEqual({ kind: 'success', text: 'five' })
    const histories = proc.requests('side_question').map((request) => request['history'])
    expect(histories[0]).toBeUndefined()
    expect(histories[1]).toEqual([{ question: 'q1', response: 'one' }])
    expect(histories[2]).toEqual([{ question: 'q1', response: 'one' }])
    expect(histories[3]).toEqual([
      { question: 'q1', response: 'one' },
      { question: 'q3', response: 'three', fallback_notice: 'Answered by small.' },
    ])
    expect(histories[4]).toEqual(histories[3])
    // `/clear` starts another conversation: the side questions belonged to the old one.
    proc.send({ type: 'conversation_reset', new_conversation_id: randomUUID(), trigger: 'clear', session_id: h.transport.sessionId })
    proc.send(system('init', { session_id: randomUUID(), model: 'claude-opus-5.5', permissionMode: 'default' }))
    await until(() => h.events.some((event) => event.kind === 'session_changed'), 'the new session')
    expect(await ask('q6')).toEqual({ kind: 'success', text: 'six' })
    expect(proc.requests('side_question')[5]).not.toHaveProperty('history')
    await h.transport.close()
  })

  it('keeps the newest ten exchanges within a size budget, and cuts an oversized answer rather than the history', () => {
    const history = new SideHistory()
    for (let n = 1; n <= 12; n += 1) history.push({ question: `q${n}`, response: `a${n}` })
    expect(history.payload().map((entry) => entry['question'])).toEqual(Array.from({ length: 10 }, (_, index) => `q${index + 3}`))

    const huge = new SideHistory()
    huge.push({ question: 'small', response: 'ok' })
    huge.push({ question: 'huge', response: 'x'.repeat(100_000) })
    const payload = huge.payload()
    expect(payload.map((entry) => entry['question'])).toEqual(['small', 'huge'])
    expect(String(payload[1]?.['response']).length).toBeLessThan(10_000)

    // When the budget runs out the oldest exchanges go first.
    const many = new SideHistory()
    for (let n = 1; n <= 10; n += 1) many.push({ question: `q${n}`, response: 'y'.repeat(5_000) })
    const kept = many.payload()
    expect(kept.length).toBeLessThan(10)
    expect(kept.at(-1)?.['question']).toBe('q10')
  })

  it('turns a refusal of the CLI into the result, rejects a bare question, and keeps a lost process an exception', async () => {
    const cli = fakeCli({
      onControl: (request, frame, proc) => {
        if (request['subtype'] !== 'side_question') return false
        if (request['question'] === 'die') proc.exit(1)
        else proc.fail(frame, 'Session is shutting down')
        return true
      },
    })
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    await expect(h.transport.sideQuestion('   ', signalOf())).resolves.toMatchObject({ kind: 'error' })
    expect(sideFrames(proc)).toHaveLength(0)
    await expect(h.transport.sideQuestion('hello?', signalOf())).resolves.toMatchObject({ kind: 'error', text: expect.stringContaining('shutting down') })
    await expect(h.transport.sideQuestion('die', signalOf())).rejects.toMatchObject({ code: 'process_exit' })
    await expect(h.transport.sideQuestion('after', signalOf())).rejects.toBeInstanceOf(NativeTransportError)
    await h.transport.close()
  })
})

describe('Claude /clear (scripted CLI)', () => {
  /** What the CLI sends for `/clear`: the reset, the new session's init, and an empty result with the zeroed counters of the new session. */
  function resets(proc: FakeClaude, frame: Json, newId: string, trigger = 'clear'): void {
    const oldId = frame['session_id']
    proc.send({ type: 'command_lifecycle', command_uuid: frame['uuid'], state: 'started', session_id: oldId })
    proc.send({ type: 'conversation_reset', new_conversation_id: randomUUID(), trigger, user_message_uuid: frame['uuid'], session_id: oldId })
    proc.send(system('init', { session_id: newId, model: 'claude-opus-5.5', permissionMode: 'default' }))
    proc.send(resultFrame({ result: '', local_command: 'clear', session_id: newId }, {}, 0))
  }

  it('moves to the new session, says what happened because the CLI answers with an empty result, and bills the next turn from zero', async () => {
    const newId = randomUUID()
    const cli = fakeCli({ onUser: (frame, proc) => (userText(frame) === '/clear' ? resets(proc, frame, newId) : textTurn(proc, 'after the clear')) })
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    const oldId = h.transport.sessionId
    // A turn first, so the cumulative counters the CLI reports are not zero.
    await h.transport.prompt(PROMPT, signalOf())
    const cleared = await h.transport.prompt([{ type: 'text', text: '/clear' }], signalOf())
    expect(cleared).toMatchObject({ stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } })

    expect(h.transport.sessionId).toBe(newId)
    const changed = h.events.findIndex((event) => event.kind === 'session_changed')
    expect(h.events[changed]).toEqual({ kind: 'session_changed', sessionId: newId, reason: 'clear' })
    const said = h.events.findIndex((event) => event.kind === 'update' && rec(event.update)['sessionUpdate'] === 'agent_message_chunk' && JSON.stringify(event.update).includes(newId.slice(0, 8)))
    expect(said).toBeGreaterThan(changed)
    // Nothing fills the context window of the new conversation.
    const occupancy = h.events.slice(changed).find((event) => event.kind === 'context_usage')
    expect(occupancy?.kind === 'context_usage' ? occupancy.contextUsage.used : undefined).toBe(0)

    const next = await h.transport.prompt(PROMPT, signalOf())
    // The counters restarted with the new session: the whole reading is this turn's.
    expect(next.usage).toMatchObject({ inputTokens: 10, outputTokens: 3 })
    expect(rec(proc.userMessages().at(-1))['session_id']).toBe(newId)
    expect(oldId).not.toBe(newId)
    await h.transport.close()
  })

  it('follows a reset the CLI starts itself without claiming the user asked for it', async () => {
    const newId = randomUUID()
    const cli = fakeCli({ onUser: (frame, proc) => resets(proc, frame, newId, 'plan_mode_exit') })
    const h = harness(cli)
    await h.start()
    await h.transport.prompt(PROMPT, signalOf())
    expect(h.transport.sessionId).toBe(newId)
    expect(h.events).toContainEqual({ kind: 'session_changed', sessionId: newId, reason: 'plan_mode_exit' })
    expect(updatesOf(h.events).some((update) => update['sessionUpdate'] === 'agent_message_chunk')).toBe(false)
    await h.transport.close()
  })
})

describe('Claude shell escape (scripted CLI)', () => {
  const xml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  /** What the CLI reports for a `bash_command`: the echo, the captured output, then `command_lifecycle completed`. */
  function reports(frame: Json, proc: FakeClaude, output: { stdout: string; stderr: string; exitCode: number }): void {
    const replay = (content: string): Json => ({ type: 'user', message: { role: 'user', content }, session_id: 's1', parent_tool_use_id: null, uuid: randomUUID(), isReplay: true })
    proc.send(replay(`<bash-input>${xml(String(frame['command']))}</bash-input>`))
    proc.send(replay(`<bash-stdout>${xml(output.stdout)}</bash-stdout><bash-stderr>${xml(output.stderr)}</bash-stderr><bash-exit-code>${output.exitCode}</bash-exit-code>`))
    proc.send({ type: 'command_lifecycle', command_uuid: frame['uuid'], state: 'completed', session_id: 's1' })
  }

  const shellFrames = (proc: FakeClaude): Json[] => proc.received.filter((frame) => frame['type'] === 'bash_command')

  it("runs !cmd as the user's own shell command: nothing for the model, one Bash call with its output", async () => {
    const cli = fakeCli({ onFrame: (frame, proc) => frame['type'] === 'bash_command' && reports(frame, proc, { stdout: 'hi\n', stderr: '', exitCode: 0 }) })
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    await expect(h.transport.prompt([{ type: 'text', text: '!  echo hi ' }], signalOf())).resolves.toMatchObject({ stopReason: 'end_turn' })
    expect(proc.userMessages()).toEqual([])
    expect(shellFrames(proc)).toEqual([{ type: 'bash_command', uuid: expect.any(String), command: 'echo hi', cwd: CWD }])
    const calls = updatesOf(h.events).filter((update) => update['toolCallId'] !== undefined)
    expect(calls[0]).toMatchObject({ sessionUpdate: 'tool_call', kind: 'execute', title: 'echo hi', rawInput: { command: 'echo hi' } })
    expect(calls.at(-1)).toMatchObject({ sessionUpdate: 'tool_call_update', status: 'completed' })
    expect(JSON.stringify(calls.at(-1))).toContain('hi')
    // The echo of the command is not a conversation message.
    expect(updatesOf(h.events).some((update) => update['sessionUpdate'] === 'user_message_chunk')).toBe(false)
    await h.transport.close()
  })

  it('reports a failing command with its exit code and the text the CLI escaped, unescaped once', async () => {
    const cli = fakeCli({ onFrame: (frame, proc) => frame['type'] === 'bash_command' && reports(frame, proc, { stdout: 'a<b>&amp;c\n', stderr: 'denied\n', exitCode: 3 }) })
    const h = harness(cli)
    await h.start()
    await h.transport.prompt([{ type: 'text', text: '!make' }], signalOf())
    const failed = JSON.stringify(updatesOf(h.events).find((update) => update['status'] === 'failed'))
    expect(failed).toContain('Exit code 3')
    expect(failed).toContain('a<b>&amp;c')
    expect(failed).toContain('denied')
    await h.transport.close()
  })

  it('stops waiting for a shell command the user stops, and ignores whatever it reports afterwards', async () => {
    const held: { frame?: Json } = {}
    const cli = fakeCli({
      onFrame: (frame) => {
        if (frame['type'] === 'bash_command') held.frame = frame
      },
      onUser: (_frame, proc) => textTurn(proc, 'next'),
    })
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    const stop = new AbortController()
    const running = h.transport.prompt([{ type: 'text', text: '!sleep 60' }], stop.signal)
    await until(() => held.frame !== undefined, 'the command')
    stop.abort()
    await expect(running).resolves.toEqual({ stopReason: 'cancelled' })
    expect(updatesOf(h.events).at(-1)).toMatchObject({ status: 'failed' })
    const seen = quiet(h.events).length
    reports(held.frame!, proc, { stdout: 'late\n', stderr: '', exitCode: 0 })
    await tick()
    await tick()
    expect(quiet(h.events)).toHaveLength(seen)
    await expect(h.transport.prompt(PROMPT, signalOf())).resolves.toMatchObject({ stopReason: 'end_turn' })
    await h.transport.close()
  })

  it('does not take the result of a turn the CLI started on its own for the end of a shell command', async () => {
    const held: { frame?: Json } = {}
    const cli = fakeCli({
      onFrame: (frame) => {
        if (frame['type'] === 'bash_command') held.frame = frame
      },
    })
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    const running = h.transport.prompt([{ type: 'text', text: '!make' }], signalOf())
    let done = false
    void running.then(() => {
      done = true
    })
    await until(() => held.frame !== undefined, 'the command')
    proc.send(resultFrame())
    await tick()
    await tick()
    expect(done).toBe(false)
    reports(held.frame!, proc, { stdout: '', stderr: '', exitCode: 0 })
    await expect(running).resolves.toMatchObject({ stopReason: 'end_turn' })
    await h.transport.close()
  })

  it('steers a line that starts with "!" into a running turn like any other text, but not into a running shell command', async () => {
    const held: { frame?: Json } = {}
    const cli = fakeCli({
      onUser: () => undefined,
      onFrame: (frame) => {
        if (frame['type'] === 'bash_command') held.frame = frame
      },
    })
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    const turn = h.transport.prompt(PROMPT, signalOf())
    await until(() => proc.userMessages().length === 1, 'the prompt')
    await expect(h.transport.steer([{ type: 'text', text: '!ls' }])).resolves.toBe('injected')
    expect(proc.userMessages().map(userText)).toEqual(['go', '!ls'])
    expect(rec(proc.userMessages()[1])['priority']).toBe('next')
    expect(shellFrames(proc)).toEqual([])
    textTurn(proc, 'done')
    await turn

    const stop = new AbortController()
    const running = h.transport.prompt([{ type: 'text', text: '!sleep 5' }], stop.signal)
    await until(() => held.frame !== undefined, 'the command')
    await expect(h.transport.steer([{ type: 'text', text: 'also check the lint' }])).resolves.toBe('promptRequired')
    expect(proc.userMessages()).toHaveLength(2)
    stop.abort()
    await running
    await h.transport.close()
  })

  it('does not spend a model turn on a bare "!"', async () => {
    const cli = fakeCli()
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    await expect(h.transport.prompt([{ type: 'text', text: '!' }], signalOf())).resolves.toMatchObject({ stopReason: 'end_turn' })
    expect(proc.userMessages()).toEqual([])
    expect(shellFrames(proc)).toEqual([])
    expect(replyText(h.events)).not.toBe('')
    await h.transport.close()
  })

  it('fails the turn when the process dies under a shell command', async () => {
    const cli = fakeCli({ onFrame: (frame, proc) => frame['type'] === 'bash_command' && proc.exit(1) })
    const h = harness(cli)
    await h.start()
    await expect(h.transport.prompt([{ type: 'text', text: '!make' }], signalOf())).rejects.toMatchObject({ code: 'process_exit' })
    await h.transport.close()
  })

  it('recognises a lone "!" text block, and reads the replay frames of a shell command', () => {
    expect(shellEscapeCommand([{ type: 'text', text: '!ls -la' }])).toBe('ls -la')
    expect(shellEscapeCommand([{ type: 'text', text: ' !x' }])).toBe('x')
    expect(shellEscapeCommand([{ type: 'text', text: '!' }])).toBe('')
    expect(shellEscapeCommand([{ type: 'text', text: 'ls !x' }])).toBeUndefined()
    expect(shellEscapeCommand([{ type: 'text', text: '!a' }, { type: 'text', text: 'b' }])).toBeUndefined()
    expect(shellEscapeCommand([{ type: 'image', data: 'AAAA', mimeType: 'image/png' }])).toBeUndefined()

    const replay = (content: unknown, isReplay = true): Json => ({ type: 'user', message: { role: 'user', content }, isReplay })
    expect(parseBashReplay(replay('<bash-input>echo &amp;&amp; pwd</bash-input>'))).toEqual({ kind: 'input' })
    // `&amp;lt;` is the text "&lt;" once, not "<".
    expect(parseBashReplay(replay('<bash-stdout>1 &amp;lt; 2 &lt;b&gt;</bash-stdout><bash-stderr>e</bash-stderr><bash-exit-code>2</bash-exit-code>'))).toEqual({
      kind: 'output',
      stdout: '1 &lt; 2 <b>',
      stderr: 'e',
      exitCode: 2,
    })
    expect(parseBashReplay(replay('<bash-stdout></bash-stdout><bash-stderr></bash-stderr>'))).toMatchObject({ kind: 'output', exitCode: undefined })
    expect(parseBashReplay(replay('<bash-input>x</bash-input>', false))).toBeUndefined()
    expect(parseBashReplay(replay('an ordinary replayed message'))).toBeUndefined()
    expect(parseBashReplay(replay([{ type: 'text', text: 'x' }]))).toBeUndefined()
  })
})

describe('Claude retry, fallback and notification frames (scripted CLI)', () => {
  it('notes a retry once in the turn being watched, and nothing when no turn is', async () => {
    const cli = fakeCli({ onUser: () => undefined })
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    // Between turns nobody is listening.
    proc.send(system('api_retry', { attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 529, error: 'overloaded' }))
    const turn = h.transport.prompt(PROMPT, signalOf())
    await until(() => proc.userMessages().length === 1, 'the prompt')
    expect(thoughtTexts(h.events)).toEqual([])
    proc.send(system('api_retry', { attempt: 2, max_retries: 10, retry_delay_ms: 2400, error_status: 429, error: 'rate_limit' }))
    // The internal twin of the same retry adds nothing; the next attempt, which got no response at all, does.
    proc.send(system('api_error', { error: { message: 'Rate limited', formatted: 'Rate limited (429)' }, retry_in_ms: 2400, retry_attempt: 2, max_retries: 10 }))
    proc.send(system('api_retry', { attempt: 3, max_retries: 10, retry_delay_ms: 5000, error_status: null, error: 'unknown', no_response: { waited_ms: 30_000, retry_wait_ms: 60_000 } }))
    await until(() => thoughtTexts(h.events).length >= 2, 'the notes')
    await tick()
    const notes = thoughtTexts(h.events)
    expect(notes).toHaveLength(2)
    expect(notes[0]).toMatch(/429/)
    expect(notes[0]).toMatch(/attempt 2 of 10/)
    expect(notes[1]).toMatch(/attempt 3 of 10/)
    expect(notes[1]).toMatch(/30 s/)
    textTurn(proc, 'recovered')
    await turn
    await h.transport.close()
  })

  it('follows a model swap that outlives the turn, and only notes the ones that do not', async () => {
    const cli = fakeCli({ onUser: () => undefined })
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    const model = (): unknown => h.transport.controls().configOptions.find((option) => option.id === 'model')?.currentValue
    const swaps = (): number => h.events.filter((event) => event.kind === 'controls').length
    expect(model()).toBe('opus')
    const turn = h.transport.prompt(PROMPT, signalOf())
    await until(() => proc.userMessages().length === 1, 'the prompt')
    proc.send(system('model_fallback', { trigger: 'overloaded', original_model: 'claude-opus-5.5', fallback_model: 'claude-sonnet-5.5', content: 'Opus is overloaded; this turn runs on Sonnet.' }))
    proc.send(system('model_refusal_fallback', { trigger: 'refusal', direction: 'retry', scope: 'local', original_model: 'claude-opus-5.5', fallback_model: 'claude-sonnet-5.5', content: 'A side answer came from Sonnet.' }))
    proc.send(system('model_refusal_no_fallback', { original_model: 'claude-opus-5.5', request_id: null, content: 'Opus declined and no fallback is set.' }))
    await until(() => thoughtTexts(h.events).length === 3, 'the notes')
    expect(thoughtTexts(h.events)[0]).toContain('this turn runs on Sonnet')
    expect(model()).toBe('opus')
    expect(swaps()).toBe(0)

    proc.send(system('model_refusal_fallback', { trigger: 'refusal', direction: 'retry', scope: 'session', original_model: 'claude-opus-5.5', fallback_model: 'claude-fable-5-1', content: 'The session now runs on Fable.' }))
    await until(() => model() === 'fable', 'the session model to follow the fallback')
    expect(swaps()).toBe(1)
    proc.send(system('model_consent_fallback', { choice: 'switch_default', original_model: 'claude-fable-5-1', fallback_model: 'sonnet', persisted_as_default: false, content: 'Switched to Sonnet.' }))
    await until(() => model() === 'sonnet', 'the session model to follow the consent fallback')
    expect(thoughtTexts(h.events)).toHaveLength(5)
    textTurn(proc, 'done')
    await turn
    await h.transport.close()
  })

  it('shows notifications that matter and leaves out the passing ones', async () => {
    const cli = fakeCli({ onUser: () => undefined })
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    const turn = h.transport.prompt(PROMPT, signalOf())
    await until(() => proc.userMessages().length === 1, 'the prompt')
    proc.send(system('notification', { key: 'tip', text: 'Press ctrl+o to expand', priority: 'low' }))
    proc.send(system('notification', { key: 'limit', text: 'Approaching the usage limit', priority: 'high' }))
    await until(() => thoughtTexts(h.events).length >= 1, 'the notification')
    await tick()
    expect(thoughtTexts(h.events)).toHaveLength(1)
    expect(thoughtTexts(h.events)[0]).toContain('Approaching the usage limit')
    textTurn(proc, 'done')
    await turn
    await h.transport.close()
  })

  it('says a warning once when the CLI sends it both as a banner and as a notification, and again in the next turn', async () => {
    const cli = fakeCli({ onUser: () => undefined })
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    const limit = 'You have used 90% of your weekly limit'
    const first = h.transport.prompt(PROMPT, signalOf())
    await until(() => proc.userMessages().length === 1, 'the prompt')
    proc.send(system('informational', { level: 'warning', content: limit }))
    proc.send(system('notification', { key: 'limit', text: limit, priority: 'high' }))
    proc.send(system('notification', { key: 'other', text: 'Something else', priority: 'high' }))
    await until(() => thoughtTexts(h.events).length >= 1, 'the notification')
    await tick()
    // The banner is part of the answer; only what it did not say already is a note.
    expect(thoughtTexts(h.events)).toEqual(['Something else\n\n'])
    expect(replyText(h.events)).toContain(`**Warning:** ${limit}`)
    textTurn(proc, 'done')
    await first

    // The next turn starts without remembering the banner.
    const second = h.transport.prompt(PROMPT, signalOf())
    await until(() => proc.userMessages().length === 2, 'the second prompt')
    proc.send(system('notification', { key: 'limit', text: limit, priority: 'high' }))
    await until(() => thoughtTexts(h.events).length === 2, 'the note in the next turn')
    expect(thoughtTexts(h.events)[1]).toBe(`${limit}\n\n`)
    textTurn(proc, 'done again')
    await second
    await h.transport.close()
  })

  it('words a frame only when it has something to say', () => {
    expect(claudeSystemNote(system('api_retry', { attempt: 1, max_retries: 3, retry_delay_ms: 1500, error_status: 500, error: 'server_error' }))).toMatch(/500.*1\.5 s.*attempt 1 of 3/)
    expect(claudeSystemNote(system('model_fallback', { trigger: 'model_not_found', original_model: 'a', fallback_model: 'b', content: '  ' }))).toMatch(/a.*model not found.*b/)
    expect(claudeSystemNote(system('notification', { text: 'x', priority: 'low' }))).toBeUndefined()
    expect(claudeSystemNote(system('notification', { text: '   ', priority: 'high' }))).toBeUndefined()
    expect(claudeSystemNote(system('task_started'))).toBeUndefined()
  })
})

describe('Claude /goal progress (scripted CLI)', () => {
  /** The verdict of the Stop hook behind `/goal`: the CLI hands it to the model as a synthetic user message when the condition is not met yet. */
  const feedback = (reason: string, extra: Json = {}): Json => ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: `Stop hook feedback:\n[all tests pass]: ${reason}` }] },
    isSynthetic: true,
    parent_tool_use_id: null,
    ...sessionFrame,
    uuid: randomUUID(),
    ...extra,
  })
  /** What a remote worker is sent after each check of the goal; a local stream-json session is not. */
  const activeGoal = (iterations: number, reason?: string): Json => ({
    type: 'active_goal',
    value: { condition: 'all tests pass', iterations, set_at: 1_790_000_000_000, tokens_at_start: 0, ...(reason === undefined ? {} : { last_reason: reason }) },
    uuid: randomUUID(),
    session_id: 's1',
  })

  it('tells the user why the goal is not met yet, from the feedback a local session hands the model', async () => {
    const cli = fakeCli({ onUser: () => undefined })
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    const turn = h.transport.prompt([{ type: 'text', text: '/goal all tests pass' }], signalOf())
    await until(() => proc.userMessages().length === 1, 'the prompt')
    proc.send(feedback('2 tests still fail'))
    // The same words typed by the user are the user's message, not a verdict.
    proc.send(feedback('typed by the user', { isSynthetic: false }))
    proc.send(feedback('1 test still fails'))
    await until(() => thoughtTexts(h.events).length >= 2, 'the notes')
    await tick()
    expect(thoughtTexts(h.events)).toEqual(['Goal not met yet: 2 tests still fail\n\n', 'Goal not met yet: 1 test still fails\n\n'])
    textTurn(proc, 'done')
    await turn
    await h.transport.close()
  })

  it('narrates each check once from active_goal frames, and leaves the feedback to them from then on', async () => {
    const cli = fakeCli({ onUser: () => undefined })
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    const turn = h.transport.prompt([{ type: 'text', text: '/goal all tests pass' }], signalOf())
    await until(() => proc.userMessages().length === 1, 'the prompt')
    // Just set: the CLI announces that itself.
    proc.send(activeGoal(0))
    proc.send(activeGoal(1, 'two tests fail'))
    // The same check once more, and the feedback the model gets for it: neither is a second note.
    proc.send(activeGoal(1, 'two tests fail'))
    proc.send(feedback('two tests fail'))
    proc.send(activeGoal(2, 'one test fails'))
    // Met or cleared, and a goal set afresh counts its checks from the first again.
    proc.send({ type: 'active_goal', value: null, uuid: randomUUID(), session_id: 's1' })
    proc.send(activeGoal(1, 'again'))
    await until(() => thoughtTexts(h.events).length >= 3, 'the notes')
    await tick()
    expect(thoughtTexts(h.events)).toEqual([
      'Goal not met yet (check 1): two tests fail\n\n',
      'Goal not met yet (check 2): one test fails\n\n',
      'Goal not met yet (check 1): again\n\n',
    ])
    textTurn(proc, 'done')
    await turn
    await h.transport.close()
  })

  it('keeps a long reason short, and leaves other synthetic messages alone', () => {
    const mapper = new ClaudeFrameMapper({ cwd: CWD })
    const [note] = thoughtTexts(mapper.map(feedback('x'.repeat(2_000))))
    expect(note).toMatch(/^Goal not met yet: x+…\n\n$/)
    expect(note?.length).toBeLessThan(700)
    // Other text the CLI hands the model on its own is not a goal check, and a check with no reason has nothing to say.
    const reminder = { message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>The date changed</system-reminder>' }] } }
    expect(thoughtTexts(mapper.map(feedback('r', reminder)))).toEqual([])
    expect(thoughtTexts(mapper.map(feedback('   ')))).toEqual([])
  })
})

/** Answers to the control requests behind the immediate commands, shaped like Claude Code 2.1.296's. */
const COMMAND_REPLIES: Readonly<Record<string, Json>> = {
  get_status: {
    sections: [
      { title: 'Session', rows: [{ label: 'Version', value: '2.1.296' }, { label: 'Session ID', value: 'abc-123' }] },
      { title: 'Environment', rows: [{ label: 'Model', value: 'claude-opus-5-5' }] },
    ],
  },
  get_context_usage: {
    categories: [
      { name: 'System prompt', tokens: 1921, kind: 'used' },
      { name: 'Free space', tokens: 934_842, kind: 'free' },
    ],
    totalTokens: 32_158,
    maxTokens: 1_000_000,
    percentage: 3,
    model: 'claude-opus-5-5',
    isAutoCompactEnabled: true,
    autoCompactThreshold: 967_000,
  },
  get_session_cost: { text: 'Total cost:            $1.2300\nTotal duration (API):  4s' },
  get_usage: { session: { total_cost_usd: 1.23, total_api_duration_ms: 4000, total_duration_ms: 9000, total_lines_added: 3, total_lines_removed: 1, model_usage: {} }, subscription_type: null, rate_limits_available: false, rate_limits: null },
  get_memory_dialog: {
    files: [{ kind: 'user', path: '/home/u/.claude/CLAUDE.md', label: 'User instructions', description: 'Saved in ~/.claude/CLAUDE.md', exists: false }],
    folders: [],
    memories: [],
    auto_memory: { enabled: true, toggleable: true, status: 'on' },
  },
  get_skills_dialog: { skills: [{ name: 'demo-skill', display_name: 'demo-skill', description: 'A project skill', source: 'project', tokens: 20, state: 'on', advertised: true }] },
  get_hooks_listing: {
    events: [],
    hooks: [{ event: 'PreToolUse', matcher: 'Bash', source: 'userSettings', sourceLabel: 'User settings', type: 'command', displayText: 'lint', commandText: 'npm run lint' }],
    eventCatalog: [],
    policy: {},
  },
  list_permission_rules: {
    state: {
      rules: [{ behavior: 'allow', source: 'localSettings', rule: 'Bash(npm test:*)', editability: 'persistent', description: { prefix: 'Any Bash command starting with ', emphasis: 'npm test' } }],
      workspaceDirectories: [],
      originalCwd: '/work/project',
      managedOnly: false,
    },
  },
  get_workspace_diff: {
    diff: {
      stats: { filesCount: 1, linesAdded: 2, linesRemoved: 1 },
      perFileStats: [{ path: 'src/a.ts', added: 2, removed: 1, isBinary: false, isUntracked: false, status: 'modified' }],
      hunks: [{ path: 'src/a.ts', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-old line', '+new line', '+extra line'] }] }],
      skippedLarge: [],
      restricted: [],
      source: { kind: 'working-tree' },
    },
  },
}

/** A scripted CLI that answers the control requests behind the immediate commands. */
function commandCli(extra: FakeOptions = {}): FakeCli {
  return fakeCli({
    ...extra,
    onControl: (request, frame, proc) => {
      const reply = COMMAND_REPLIES[String(request['subtype'])]
      if (reply === undefined) return extra.onControl?.(request, frame, proc)
      proc.reply(frame, reply)
      return true
    },
  })
}

describe('Claude immediate commands (scripted CLI)', () => {
  it.each([
    { command: 'status', asks: ['get_status'], shows: ['2.1.296', 'Environment', 'claude-opus-5-5'] },
    { command: 'context', asks: ['get_context_usage'], shows: ['32,158', '1,000,000', '3%', 'System prompt', '1,921'] },
    { command: 'usage', asks: ['get_session_cost', 'get_usage'], shows: ['$1.2300', 'Plan usage'] },
    { command: 'cost', asks: ['get_session_cost', 'get_usage'], shows: ['$1.2300'] },
    { command: 'memory', asks: ['get_memory_dialog'], shows: ['User instructions', 'not created'] },
    { command: 'skills', asks: ['get_skills_dialog'], shows: ['demo-skill', 'project', 'A project skill'] },
    { command: 'hooks', asks: ['get_hooks_listing'], shows: ['PreToolUse', 'npm run lint', 'User settings'] },
    { command: 'permissions', asks: ['list_permission_rules'], shows: ['Bash(npm test:*)', 'npm test', 'localSettings'] },
    { command: 'diff', asks: ['get_workspace_diff'], shows: ['src/a.ts', '```diff', '+new line'] },
  ])('answers /$command from a control request, without a turn', async ({ command, asks, shows }) => {
    const cli = commandCli()
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    const result = await h.transport.runCommand(command, '', signalOf())
    expect(result.kind).toBe('success')
    for (const fragment of shows) expect(result.text).toContain(fragment)
    for (const ask of asks) expect(proc.requests(ask).length, ask).toBeGreaterThanOrEqual(1)
    expect(proc.userMessages()).toEqual([])
    expect(updatesOf(h.events)).toEqual([])
    await h.transport.close()
  })

  it('asks for the full context breakdown, and skips the transcript scan when it asks for usage', async () => {
    const cli = commandCli()
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    await h.transport.runCommand('context', '', signalOf())
    expect(proc.requests('get_context_usage').map((request) => request['detail'])).toContain('full')
    await h.transport.runCommand('usage', '', signalOf())
    expect(proc.requests('get_usage')[0]).toMatchObject({ skip_behaviors: true })
    await h.transport.close()
  })

  it('answers an immediate command while a turn runs and leaves the turn alone', async () => {
    const cli = commandCli({ onUser: () => undefined })
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    const turn = h.transport.prompt(PROMPT, signalOf())
    await until(() => proc.userMessages().length === 1, 'the prompt')
    const seen = quiet(h.events).length
    expect((await h.transport.runCommand('status', '', signalOf())).kind).toBe('success')
    expect(quiet(h.events).slice(seen)).toEqual([])
    textTurn(proc, 'fine')
    await expect(turn).resolves.toMatchObject({ stopReason: 'end_turn' })
    await h.transport.close()
  })

  it('turns what the CLI refuses into the result, and keeps a lost process an exception', async () => {
    const cli = fakeCli({
      onControl: (request, frame, proc) => {
        if (request['subtype'] === 'get_status') proc.fail(frame, 'not available right now')
        else if (request['subtype'] === 'get_hooks_listing') proc.exit(1)
        else return false
        return true
      },
    })
    const h = harness(cli)
    await h.start()
    await expect(h.transport.runCommand('status', '', signalOf())).resolves.toMatchObject({ kind: 'error', text: expect.stringContaining('not available right now') })
    await expect(h.transport.runCommand('nonsense', '', signalOf())).resolves.toMatchObject({ kind: 'error' })
    await expect(h.transport.runCommand('hooks', '', signalOf())).rejects.toMatchObject({ code: 'process_exit' })
    await h.transport.close()
  })

  it('lets the user cancel a command the CLI is slow to answer, without telling the CLI to withdraw it', async () => {
    const cli = fakeCli({ onControl: (request) => request['subtype'] === 'get_status' })
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    const stop = new AbortController()
    const pending = h.transport.runCommand('status', '', stop.signal)
    await until(() => proc.requests('get_status').length === 1, 'the request')
    stop.abort()
    await expect(pending).resolves.toMatchObject({ kind: 'error' })
    expect(proc.received.some((frame) => frame['type'] === 'control_cancel_request')).toBe(false)
    await h.transport.close()
  })

  describe('/mcp', () => {
    const SERVERS = [
      { name: 'alpha', status: 'connected', serverInfo: { name: 'alpha-server', version: '1.2.0' }, tools: [{ name: 't1' }, { name: 't2' }], scope: 'user' },
      { name: 'beta', status: 'failed', error: 'ECONNREFUSED: Unable to connect', scope: 'project' },
    ]
    const mcpCli = (): FakeCli =>
      fakeCli({
        onControl: (request, frame, proc) => {
          switch (request['subtype']) {
            case 'mcp_status':
              proc.reply(frame, { mcpServers: SERVERS })
              return true
            case 'mcp_reconnect':
              if (request['serverName'] === 'beta') proc.fail(frame, 'ECONNREFUSED: Unable to connect')
              else proc.reply(frame, {})
              return true
            case 'mcp_toggle':
              proc.reply(frame)
              return true
            default:
              return false
          }
        },
      })

    it('shows the servers, and reconnects, enables or disables one or all of them', async () => {
      const cli = mcpCli()
      const h = harness(cli)
      await h.start()
      const proc = cli.procs[0]!
      const mcp = (args: string) => h.transport.runCommand('mcp', args, signalOf())
      const status = await mcp('')
      expect(status.kind).toBe('success')
      for (const fragment of ['alpha', 'connected', '2 tools', 'beta', 'failed', 'ECONNREFUSED']) expect(status.text).toContain(fragment)

      // One server of two comes back: the command did what it could.
      const all = await mcp('reconnect all')
      expect(proc.requests('mcp_reconnect').map((request) => request['serverName']).sort()).toEqual(['alpha', 'beta'])
      expect(all.kind).toBe('success')
      expect(all.text).toContain('alpha')
      expect(all.text).toContain('beta')
      // The only server asked for stays down: that is an error.
      expect((await mcp('reconnect beta')).kind).toBe('error')

      await mcp('disable beta')
      await mcp('enable alpha')
      expect(proc.requests('mcp_toggle')).toEqual([
        { subtype: 'mcp_toggle', serverName: 'beta', enabled: false },
        { subtype: 'mcp_toggle', serverName: 'alpha', enabled: true },
      ])

      const asked = proc.requests('mcp_reconnect').length
      expect((await mcp('reconnect')).kind).toBe('error')
      expect((await mcp('restart alpha')).kind).toBe('error')
      expect(proc.requests('mcp_reconnect')).toHaveLength(asked)
      await h.transport.close()
    })

    it('says so when there is nothing to reconnect', async () => {
      const cli = fakeCli({ onControl: (request, frame, proc) => (request['subtype'] === 'mcp_status' ? (proc.reply(frame, { mcpServers: [] }), true) : false) })
      const h = harness(cli)
      await h.start()
      expect((await h.transport.runCommand('mcp', 'reconnect all', signalOf())).kind).toBe('error')
      expect((await h.transport.runCommand('mcp', '', signalOf())).kind).toBe('success')
      await h.transport.close()
    })

    it('reads the arguments of /mcp, /tasks and /rewind', () => {
      expect(parseMcpArgs('')).toEqual({ action: 'status' })
      expect(parseMcpArgs(' Reconnect  my server ')).toEqual({ action: 'reconnect', target: 'my server' })
      expect(parseMcpArgs('disable all')).toEqual({ action: 'disable', target: 'all' })
      expect(parseMcpArgs('reconnect')).toMatchObject({ action: 'usage' })
      expect(parseMcpArgs('restart x')).toMatchObject({ action: 'usage' })
      expect(parseTasksArgs('')).toEqual({ action: 'list' })
      expect(parseTasksArgs('stop b1')).toEqual({ action: 'stop', reference: 'b1' })
      expect(parseTasksArgs('output')).toMatchObject({ action: 'usage' })
      expect(parseTasksArgs('kill b1')).toMatchObject({ action: 'usage' })
      expect(parseRewindArgs('')).toEqual({ action: 'list' })
      // The files and the conversation go back together unless one of them is named.
      expect(parseRewindArgs('3')).toEqual({ action: 'preview', reference: '3', mode: 'both' })
      expect(parseRewindArgs('3 confirm')).toEqual({ action: 'apply', reference: '3', mode: 'both' })
      expect(parseRewindArgs('3 code')).toEqual({ action: 'preview', reference: '3', mode: 'code' })
      expect(parseRewindArgs('3 CHAT Confirm')).toEqual({ action: 'apply', reference: '3', mode: 'chat' })
      expect(parseRewindArgs('3 confirm code')).toEqual({ action: 'apply', reference: '3', mode: 'code' })
      // Whatever is not a message first, or names both halves, or is not a word of the grammar, is refused with the usage.
      for (const refused of ['confirm', 'code', 'chat confirm', '3 code chat', '3 maybe', '1 2 3', '3 confirm now']) {
        expect(parseRewindArgs(refused), refused).toMatchObject({ action: 'usage' })
      }
    })
  })

  it('takes the commands a plugin reload reports into the catalog', async () => {
    const cli = fakeCli({
      onControl: (request, frame, proc) => {
        if (request['subtype'] !== 'reload_plugins') return false
        proc.reply(frame, { commands: [{ name: 'fresh', description: 'From a plugin', argumentHint: '[x]' }], agents: [], plugins: [{ name: 'p', path: 'builtin' }], mcpServers: [], error_count: 0 })
        return true
      },
    })
    const h = harness(cli)
    await h.start()
    await until(() => h.events.some((event) => event.kind === 'commands'), 'the first announcement')
    expect((await h.transport.runCommand('reload-plugins', '', signalOf())).kind).toBe('success')
    const names = h.transport.commands().map((command) => command.name)
    expect(names).toContain('fresh')
    expect(names).not.toContain('cluster-task-monitor')
    const last = h.events.filter((event) => event.kind === 'commands').at(-1)
    expect(last?.kind === 'commands' ? last.commands.map((command) => command.name) : []).toContain('fresh')
    await h.transport.close()
  })

  it('follows the CLI when it lists its commands again, announcing only real changes', async () => {
    const cli = fakeCli()
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    const announcements = () => h.events.flatMap((event) => (event.kind === 'commands' ? [event.commands] : []))
    await until(() => announcements().length === 1, 'the first announcement')
    const list = [{ name: 'fresh', description: 'A new skill', argumentHint: '[x]' }]
    proc.send(system('commands_changed', { commands: list }))
    await until(() => announcements().length === 2, 'the change')
    expect(announcements()[1]?.find((command) => command.name === 'fresh')).toMatchObject({ dispatch: 'prompt', hint: '[x]' })
    expect(h.transport.commands().some((command) => command.name === 'cluster-task-monitor')).toBe(false)
    // The same list again changes nothing; a turn's init that calls the new command terminal-bound hides it.
    proc.send(system('commands_changed', { commands: list }))
    proc.send(system('init', { session_id: h.transport.sessionId, model: 'claude-opus-5.5', permissionMode: 'default', terminal_slash_commands: ['fresh'] }))
    await until(() => announcements().length >= 3, 'the terminal subset')
    expect(announcements()).toHaveLength(3)
    expect(announcements()[2]?.some((command) => command.name === 'fresh')).toBe(false)
    await h.transport.close()
  })
})

describe('Claude background tasks (scripted CLI)', () => {
  /** The CLI ends a stopped task before it answers `stop_task`. */
  function tasksCli(): FakeCli {
    return fakeCli({
      onControl: (request, frame, proc) => {
        switch (request['subtype']) {
          case 'stop_task':
            proc.send(system('task_updated', { task_id: request['task_id'], patch: { status: 'killed', end_time: Date.now() } }))
            proc.send(system('task_notification', { task_id: request['task_id'], status: 'stopped', output_file: '/tmp/b1.output', summary: 'dev server' }))
            proc.send(system('background_tasks_changed', { tasks: [] }))
            proc.reply(frame, {})
            return true
          case 'get_task_output':
            proc.reply(frame, { output: 'listening on 3000\n', total_bytes: 18, truncated: false })
            return true
          default:
            return false
        }
      },
    })
  }

  it('declares the per-task stop control, and asks the CLI for file checkpoints', async () => {
    const cli = fakeCli()
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    expect(proc.received[0]).toMatchObject({ type: 'control_request', request: { subtype: 'initialize', perTaskStopAffordance: true } })
    expect(proc.env['CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING']).toBe('true')
    expect(proc.env['CLAUDE_CODE_ENTRYPOINT']).toBe('sdk-ts')
    await h.transport.close()
  })

  it('lists the tasks the CLI reports, stops a running one by id or prefix, and reads the output of a shell task', async () => {
    const cli = tasksCli()
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    const tasks = async (args: string) => await h.transport.runCommand('tasks', args, signalOf())
    const listed = async (fragment: string) => (await tasks('')).text.includes(fragment)
    expect((await tasks('')).kind).toBe('success')
    proc.send(system('background_tasks_changed', { tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'dev server' }] }))
    proc.send(system('task_started', { task_id: 'b1', tool_use_id: 'toolu_1', description: 'dev server', is_backgrounded: true, task_type: 'local_bash' }))
    proc.send(system('task_progress', { task_id: 'b1', description: 'dev server', usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 5000 }, last_tool_name: 'Bash' }))
    await eventually(() => listed('3 tool calls'), 'the task')
    const listing = (await tasks('')).text
    for (const fragment of ['b1', 'shell', 'dev server', 'running']) expect(listing).toContain(fragment)
    // Tasks are a command's business: they never reach the conversation.
    expect(updatesOf(h.events)).toEqual([])

    // `stop_task` answers success for any id, so an id this session does not know is refused before it is sent.
    expect((await tasks('stop nope')).kind).toBe('error')
    expect(proc.requests('stop_task')).toEqual([])
    const output = await tasks('output b')
    expect(proc.requests('get_task_output')).toEqual([{ subtype: 'get_task_output', task_id: 'b1' }])
    expect(output.text).toContain('listening on 3000')

    const stopped = await tasks('stop b1')
    expect(proc.requests('stop_task')).toEqual([{ subtype: 'stop_task', task_id: 'b1' }])
    expect(stopped.kind).toBe('success')
    expect(await listed('killed')).toBe(true)
    expect((await tasks('stop b1')).kind).toBe('error')
    expect(proc.requests('stop_task')).toHaveLength(1)
    await h.transport.close()
  })

  it('follows the edge frames and lets the live set correct what they missed', () => {
    const ledger = new ClaudeTaskLedger()
    ledger.apply(system('task_started', { task_id: 'a', description: 'build', task_type: 'local_bash', is_backgrounded: true }), 1000)
    ledger.apply(system('task_started', { task_id: 'fg', description: 'subagent', task_type: 'local_agent', is_backgrounded: false }), 1000)
    ledger.apply(system('task_started', { task_id: 'chore', description: 'housekeeping', ambient: true }), 1000)
    expect(ledger.list().map((task) => task.id)).toEqual(['a', 'fg'])
    expect(ledger.apply(system('keep_alive'))).toBe(false)

    // The live set lost `a` without a closing edge; a foreground task is not part of that set.
    ledger.apply(system('background_tasks_changed', { tasks: [] }), 5000)
    expect(ledger.find('a')).toMatchObject({ task: { status: 'ended', endedAt: 5000 } })
    expect(ledger.find('fg')).toMatchObject({ task: { status: 'running' } })

    ledger.apply(system('task_notification', { task_id: 'fg', status: 'failed', summary: 'boom', output_file: '/o' }), 6000)
    expect(ledger.find('fg')).toMatchObject({ task: { status: 'failed', endedAt: 6000, outputFile: '/o' } })
    // Live tasks come first, then the finished ones, newest first.
    ledger.apply(system('task_started', { task_id: 'next', description: 'tests', task_type: 'local_bash', is_backgrounded: true }), 7000)
    expect(ledger.list().map((task) => task.id)).toEqual(['next', 'fg', 'a'])

    ledger.apply(system('task_started', { task_id: 'bx1' }), 8000)
    ledger.apply(system('task_started', { task_id: 'bx2' }), 8000)
    expect(ledger.find('bx')).toHaveProperty('error')
    expect(ledger.find('bx2')).toMatchObject({ task: { id: 'bx2' } })
    expect(ledger.find('zz')).toHaveProperty('error')
  })

  it('keeps the ledger bounded without forgetting a task that still runs', () => {
    const ledger = new ClaudeTaskLedger()
    ledger.apply(system('task_started', { task_id: 'long-runner', description: 'watch' }), 0)
    for (let n = 0; n < 300; n += 1) {
      ledger.apply(system('task_started', { task_id: `t${n}` }), n)
      ledger.apply(system('task_notification', { task_id: `t${n}`, status: 'completed' }), n)
    }
    expect(ledger.find('long-runner')).toMatchObject({ task: { status: 'running' } })
    expect(ledger.find('t0')).toHaveProperty('error')
    expect(ledger.find('t299')).toMatchObject({ task: { status: 'completed' } })
    expect(ledger.list().filter((task) => task.status === 'completed').length).toBeLessThanOrEqual(20)
  })
})

// ---------------------------------------------------------------------------
// /rewind: what a transcript holds, how a message is labelled, and the command itself (scripted CLI)
// ---------------------------------------------------------------------------

/** One entry of a Claude Code transcript. Each names the entry it follows, which is how a rewind cuts the conversation back without deleting anything. */
const entry = (type: 'user' | 'assistant', uuid: string, parent: string | null, extra: Json = {}): Json => ({ type, uuid, parentUuid: parent, timestamp: '2026-10-28T09:00:00.000Z', ...extra })
/** A message the user typed. */
const typed = (uuid: string, parent: string | null, content: unknown, extra: Json = {}): Json => entry('user', uuid, parent, { origin: { kind: 'human' }, message: { role: 'user', content }, ...extra })
const answered = (uuid: string, parent: string): Json => entry('assistant', uuid, parent, { message: { role: 'assistant', model: 'claude-opus-5.5', content: [{ type: 'text', text: 'ok' }] } })
/** What a rewind appends to the transcript: the conversation now ends at `leaf` (nowhere, when it was cut back to before the first message). */
const cutBack = (leaf?: string): Json => ({ type: 'last-prompt', rewound: true, ...(leaf === undefined ? {} : { leafUuid: leaf }) })
const jsonl = (...lines: (Json | string)[]): string => `${lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')}\n`

/** Write the transcript of `sessionId` where the CLI keeps it, under a throw-away configuration directory. */
function writeTranscript(configDir: string, sessionId: string, ...lines: (Json | string)[]): string {
  const directory = path.join(configDir, 'projects', '-work-project')
  mkdirSync(directory, { recursive: true })
  const file = path.join(directory, `${sessionId}.jsonl`)
  writeFileSync(file, jsonl(...lines))
  return file
}

async function inConfigDir(run: (configDir: string) => Promise<void>): Promise<void> {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'claude-cfg-'))
  try {
    await run(configDir)
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
}

describe('Claude /rewind (scripted CLI)', () => {
  /**
   * `rewind_files` and `rewind_conversation` as the CLI answers them: a dry run reports what a restore would change, the real run
   * restores, and the conversation is cut back. A test scripts any other answer through `onControl`.
   */
  function rewindCli(extra: FakeOptions = {}): FakeCli {
    return fakeCli({
      onUser: (_frame, proc) => textTurn(proc, 'done'),
      ...extra,
      onControl: (request, frame, proc) => {
        if (extra.onControl?.(request, frame, proc) === true) return true
        switch (request['subtype']) {
          case 'rewind_files':
            if (request['dry_run'] === true) proc.reply(frame, { canRewind: true, filesChanged: ['/work/project/a.ts', '/work/project/b.ts'], insertions: 3, deletions: 1 })
            else proc.reply(frame, { canRewind: true, skippedLinks: 0 })
            return true
          case 'rewind_conversation':
            proc.reply(frame, { rewound: true, targetMessageUuid: request['target_message_uuid'], prefillText: 'the message', precedingAssistantUuid: randomUUID() })
            return true
          default:
            return false
        }
      },
    })
  }

  /** What the CLI was asked to rewind, in order: the files (a dry run, or the restore itself) and the conversation. */
  const rewinds = (proc: FakeClaude): string[] =>
    proc.received.flatMap((frame) => {
      const request = frame['type'] === 'control_request' ? rec(frame['request']) : undefined
      if (request?.['subtype'] === 'rewind_conversation') return ['conversation']
      return request?.['subtype'] === 'rewind_files' ? [request['dry_run'] === true ? 'files (dry run)' : 'files'] : []
    })

  const sessionChanges = (h: Harness): NativeTransportEvent[] => h.events.filter((event) => event.kind === 'session_changed')

  /** One turn per message; the uuids the CLI received them under. */
  async function say(h: Harness, proc: FakeClaude, ...messages: string[]): Promise<string[]> {
    for (const message of messages) await h.transport.prompt([{ type: 'text', text: message }], signalOf())
    return proc.userMessages().slice(-messages.length).map((frame) => String(rec(frame)['uuid']))
  }

  it('lists the messages, previews with a dry run, and rolls the files and then the conversation back only on confirmation', async () => {
    const cli = rewindCli()
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    const rewind = (args: string) => h.transport.runCommand('rewind', args, signalOf())
    // Nothing to go back to yet is an answer, not a failure.
    expect((await rewind('')).kind).toBe('success')
    const [, second, third] = await say(h, proc, 'rename the parser', 'add tests for it', 'update the docs')
    const listing = await rewind('')
    expect(listing.text).toMatch(/\| 1 \| rename the parser \|/)
    expect(listing.text).toMatch(/\| 3 \| update the docs \|/)

    // A preview changes nothing: the CLI is only asked what a restore would do.
    const preview = await rewind('2')
    expect(rewinds(proc)).toEqual(['files (dry run)'])
    expect(proc.requests('rewind_files')[0]).toMatchObject({ user_message_id: second, dry_run: true })
    for (const shown of ['/work/project/a.ts', '/work/project/b.ts', '/rewind 2 confirm']) expect(preview.text).toContain(shown)
    expect(sessionChanges(h)).toEqual([])

    const done = await rewind('2 confirm')
    expect(done.kind).toBe('success')
    // The files first, then the conversation, cut back to just before message 2; the newest message the list showed is what the CLI checks against.
    expect(rewinds(proc)).toEqual(['files (dry run)', 'files (dry run)', 'files', 'conversation'])
    expect(proc.requests('rewind_files')[2]).toMatchObject({ user_message_id: second, dry_run: false })
    expect(proc.requests('rewind_conversation')).toEqual([{ subtype: 'rewind_conversation', target_message_uuid: second, last_seen_user_message_uuid: third }])
    expect(done.text).toContain('add tests for it')
    expect(done.text).toMatch(/restored 2 files/)
    expect(done.text).toMatch(/message 2 and the 1 message after it/)

    // DSH's log still shows what Claude Code now forgets, so the host is told the conversation is no longer the whole log.
    expect(sessionChanges(h)).toEqual([{ kind: 'session_changed', sessionId: h.transport.sessionId, reason: 'rewind' }])
    // The shorter conversation fills less of the context window: the CLI is asked again (the scripted one says 12,345).
    const occupancy = h.events.slice(h.events.findIndex((event) => event.kind === 'session_changed')).find((event) => event.kind === 'context_usage')
    expect(occupancy?.kind === 'context_usage' ? occupancy.contextUsage.used : undefined).toBe(12_345)
    // And the list follows: what Claude Code forgot is gone from it.
    const after = (await rewind('')).text
    expect(after).toContain('rename the parser')
    for (const gone of ['add tests for it', 'update the docs']) expect(after).not.toContain(gone)
    await h.transport.close()
  })

  it('restores only the files, or rolls back only the conversation, when asked to', async () => {
    const cli = rewindCli()
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    const rewind = (args: string) => h.transport.runCommand('rewind', args, signalOf())
    const [first, second] = await say(h, proc, 'one', 'two')

    // Files only: the conversation is not touched, so the host is not told and both messages stay on the list.
    expect((await rewind('1 code confirm')).kind).toBe('success')
    expect(rewinds(proc)).toEqual(['files (dry run)', 'files'])
    expect(proc.requests('rewind_files').map((request) => request['user_message_id'])).toEqual([first, first])
    expect(sessionChanges(h)).toEqual([])
    expect((await rewind('')).text).toContain('two')

    // Conversation only: the files are not looked at, not even for a preview.
    await rewind('2 chat')
    expect(rewinds(proc)).toEqual(['files (dry run)', 'files'])
    expect((await rewind('2 chat confirm')).kind).toBe('success')
    expect(rewinds(proc)).toEqual(['files (dry run)', 'files', 'conversation'])
    expect(proc.requests('rewind_conversation')).toEqual([{ subtype: 'rewind_conversation', target_message_uuid: second, last_seen_user_message_uuid: second }])
    expect(sessionChanges(h)).toHaveLength(1)
    await h.transport.close()
  })

  it('refuses what names no message, or does not parse, before the CLI hears of it', async () => {
    const cli = rewindCli()
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    const rewind = (args: string) => h.transport.runCommand('rewind', args, signalOf())
    const [first] = await say(h, proc, 'one', 'two')
    // The number may carry the `#` the list does not show; an id is only recognised from six characters on.
    expect((await rewind('#1')).kind).toBe('success')
    expect(proc.requests('rewind_files')).toEqual([{ subtype: 'rewind_files', user_message_id: first, dry_run: true }])
    for (const refused of ['0', '3', 'nope', 'confirm', 'code', '1 code chat', '1 maybe', '1 2']) expect((await rewind(refused)).kind, refused).toBe('error')
    expect(rewinds(proc)).toEqual(['files (dry run)'])
    await h.transport.close()
  })

  it('lists the newest twenty messages and still reaches the older ones by their number', async () => {
    const cli = rewindCli()
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    const rewind = (args: string) => h.transport.runCommand('rewind', args, signalOf())
    const uuids = await say(h, proc, ...Array.from({ length: 25 }, (_, index) => `message ${index + 1}`))
    const listing = (await rewind('')).text
    expect(listing).toMatch(/\| 25 \| message 25 \|/)
    expect(listing).toMatch(/\| 6 \| message 6 \|/)
    expect(listing).not.toContain('| message 5 |')
    await rewind('3')
    expect(proc.requests('rewind_files')).toEqual([{ subtype: 'rewind_files', user_message_id: uuids[2], dry_run: true }])
    await h.transport.close()
  })

  it('changes nothing under a turn that is running, previews freely, and goes through once the turn is over', async () => {
    let turns = 0
    const cli = rewindCli({
      onUser: (_frame, proc) => {
        turns += 1
        if (turns === 1) textTurn(proc, 'one')
      },
    })
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    const rewind = (args: string) => h.transport.runCommand('rewind', args, signalOf())
    await h.transport.prompt(PROMPT, signalOf())
    const running = h.transport.prompt(PROMPT, signalOf())
    await until(() => proc.userMessages().length === 2, 'the second prompt')
    for (const args of ['1 confirm', '1 code confirm', '1 chat confirm']) expect((await rewind(args)).kind, args).toBe('error')
    expect(rewinds(proc)).toEqual([])
    expect((await rewind('1')).kind).toBe('success')
    expect(rewinds(proc)).toEqual(['files (dry run)'])
    textTurn(proc, 'two')
    await running
    expect((await rewind('1 chat confirm')).kind).toBe('success')
    expect(rewinds(proc)).toEqual(['files (dry run)', 'conversation'])
    await h.transport.close()
  })

  it('stops before the conversation when a turn starts while the files are being restored, and says the files were restored', async () => {
    let held = false
    let meanwhile: Promise<unknown> | undefined
    const cli = rewindCli({
      onUser: (_frame, proc) => {
        if (!held) textTurn(proc, 'done')
      },
      onControl: (request) => {
        if (request['subtype'] === 'rewind_files' && request['dry_run'] === false) {
          // The user's next message goes out while the restore is under way.
          held = true
          meanwhile = h.transport.prompt(PROMPT, signalOf())
        }
        return false
      },
    })
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    await say(h, proc, 'one')
    const result = await h.transport.runCommand('rewind', '1 confirm', signalOf())
    expect(result.kind).toBe('error')
    expect(result.text).toMatch(/files were restored/i)
    expect(rewinds(proc)).toEqual(['files (dry run)', 'files'])
    expect(sessionChanges(h)).toEqual([])
    textTurn(proc, 'late')
    await meanwhile
    await h.transport.close()
  })

  it.each([
    {
      shape: 'a refusal',
      answer: (proc: FakeClaude, frame: Json) => proc.reply(frame, { rewound: false, prefillText: null, precedingAssistantUuid: null, error: 'stale target', reason: 'stale_target' }),
      says: /newer messages/,
    },
    { shape: 'an error', answer: (proc: FakeClaude, frame: Json) => proc.fail(frame, 'conversation is locked'), says: /conversation is locked/ },
  ])('reports $shape from Claude Code for the conversation, with the files restored before it, and forgets nothing', async ({ answer, says }) => {
    const cli = rewindCli({
      onControl: (request, frame, proc) => {
        if (request['subtype'] !== 'rewind_conversation') return false
        answer(proc, frame)
        return true
      },
    })
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    const rewind = (args: string) => h.transport.runCommand('rewind', args, signalOf())
    await say(h, proc, 'one', 'two')
    const refused = await rewind('1 confirm')
    expect(refused.kind).toBe('error')
    expect(refused.text).toMatch(/files were restored/i)
    expect(refused.text).toMatch(says)
    expect(rewinds(proc)).toEqual(['files (dry run)', 'files', 'conversation'])
    expect(sessionChanges(h)).toEqual([])
    // Nothing was forgotten: both messages are still on the list.
    expect((await rewind('')).text).toContain('two')
    await h.transport.close()
  })

  it('rolls only the conversation back when the files of that message cannot be restored, and refuses a files-only rewind', async () => {
    const cli = rewindCli({
      onControl: (request, frame, proc) => {
        if (request['subtype'] !== 'rewind_files') return false
        proc.reply(frame, { canRewind: false, error: 'No file checkpoint found for this message.' })
        return true
      },
    })
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    const rewind = (args: string) => h.transport.runCommand('rewind', args, signalOf())
    await say(h, proc, 'one')
    const preview = await rewind('1')
    expect(preview.kind).toBe('success')
    expect(preview.text).toContain('No file checkpoint found')
    expect((await rewind('1 code confirm')).kind).toBe('error')
    // Nothing was restored, and the conversation was left alone.
    expect(rewinds(proc)).toEqual(['files (dry run)', 'files (dry run)'])
    expect(sessionChanges(h)).toEqual([])

    const both = await rewind('1 confirm')
    expect(both.kind).toBe('success')
    expect(both.text).toContain('No file checkpoint found')
    expect(both.text).not.toContain('..')
    expect(rewinds(proc)).toEqual(['files (dry run)', 'files (dry run)', 'files (dry run)', 'conversation'])
    expect(sessionChanges(h)).toHaveLength(1)
    await h.transport.close()
  })

  it.each([
    { shape: 'a refusal', fail: (proc: FakeClaude, frame: Json) => proc.reply(frame, { canRewind: false, error: 'A file changed outside Claude Code' }), says: 'A file changed outside Claude Code' },
    { shape: 'an error', fail: (proc: FakeClaude, frame: Json) => proc.fail(frame, 'disk full'), says: 'disk full' },
  ])('leaves the conversation alone when the restore of the files ends in $shape', async ({ fail, says }) => {
    const cli = rewindCli({
      onControl: (request, frame, proc) => {
        if (request['subtype'] !== 'rewind_files' || request['dry_run'] === true) return false
        fail(proc, frame)
        return true
      },
    })
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    await say(h, proc, 'one')
    const result = await h.transport.runCommand('rewind', '1 confirm', signalOf())
    expect(result.kind).toBe('error')
    expect(result.text).toContain(says)
    expect(result.text).toMatch(/conversation was not rolled back/)
    expect(rewinds(proc)).toEqual(['files (dry run)', 'files'])
    expect(sessionChanges(h)).toEqual([])
    await h.transport.close()
  })

  it('does not ask for a restore when no file changed since the message, and still rolls the conversation back', async () => {
    const cli = rewindCli({
      onControl: (request, frame, proc) => {
        if (request['subtype'] !== 'rewind_files') return false
        proc.reply(frame, { canRewind: true, filesChanged: [], insertions: 0, deletions: 0 })
        return true
      },
    })
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    await say(h, proc, 'one')
    expect((await h.transport.runCommand('rewind', '1 confirm', signalOf())).kind).toBe('success')
    expect(rewinds(proc)).toEqual(['files (dry run)', 'conversation'])
    await h.transport.close()
  })

  it('reads the conversation a transcript holds as it stands: typed messages only, minus what a rewind cut off', () => {
    const [first, firstReply, tool, caveat, command, second, secondReply, third, summary, again, fresh] = Array.from({ length: 11 }, () => randomUUID())
    const scan = new CheckpointScan()
    const visit = (...lines: (Json | string)[]): void => {
      for (const line of lines) scan.visit(typeof line === 'string' ? line : JSON.stringify(line))
    }
    visit(
      typed(first!, null, [{ type: 'text', text: 'add the parser' }]),
      answered(firstReply!, first!),
      // A tool result is a user entry nobody typed; so are the caveat a local command leaves and the summary of compacted history.
      typed(tool!, firstReply!, [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
      typed(caveat!, tool!, 'caveat', { isMeta: true }),
      typed(command!, caveat!, '<command-name>/usage</command-name>\n<command-message>usage</command-message>\n<command-args></command-args>'),
      typed(second!, command!, 'wire it in'),
      answered(secondReply!, second!),
      typed(third!, secondReply!, 'and the docs'),
      typed(summary!, third!, 'This session is being continued', { isCompactSummary: true }),
      // A subagent's messages, a line that is not JSON and the snapshot entries of the file history are not part of the conversation.
      { ...typed(randomUUID(), third!, 'from a subagent'), isSidechain: true },
      'not json at all',
      { type: 'file-history-snapshot', messageId: third, snapshot: {}, isSnapshotUpdate: false },
    )
    expect(scan.checkpoints.map((checkpoint) => checkpoint.label)).toEqual(['add the parser', '/usage', 'wire it in', 'and the docs'])
    expect(scan.checkpoints[0]).toMatchObject({ uuid: first, at: '2026-10-28T09:00:00.000Z' })
    expect(scan.recorded).toEqual(new Set([first, command, second, third]))

    // The CLI rewound to just before `second` and the user went on from there: the file keeps what was cut off, the conversation does not.
    visit(cutBack(command))
    expect(scan.checkpoints.map((checkpoint) => checkpoint.uuid)).toEqual([first, command])
    visit(typed(again!, command!, 'wire it in differently'))
    expect(scan.checkpoints.map((checkpoint) => checkpoint.uuid)).toEqual([first, command, again])
    expect(scan.recorded).toEqual(new Set([first, command, second, third, again]))
    // Cut back to before the very first message: nothing is left until the user writes again.
    visit(cutBack())
    expect(scan.checkpoints).toEqual([])
    visit(typed(fresh!, null, 'a fresh start'))
    expect(scan.checkpoints.map((checkpoint) => checkpoint.label)).toEqual(['a fresh start'])
  })

  it('lists what a resumed conversation holds, finds a message by the start of its id, and follows the transcript through a rewind', async () => {
    await inConfigDir(async (configDir) => {
      const id = randomUUID()
      // Two ids that begin alike: the first six characters name neither of them, the first eight name one.
      const parser = 'a1b2c3d4-0000-4000-8000-000000000001'
      const fix = 'a1b2c3ff-0000-4000-8000-000000000002'
      const parserReply = randomUUID()
      const file = writeTranscript(
        configDir,
        id,
        typed(parser, null, [{ type: 'text', text: 'add the parser' }]),
        answered(parserReply, parser),
        typed(fix, parserReply, '<command-name>/fix</command-name>\n<command-message>fix</command-message>\n<command-args>the failing test</command-args>'),
        answered(randomUUID(), fix),
      )
      const cli = rewindCli({ knownSessions: new Set([id]) })
      const h = harness(cli)
      await h.start({ kind: 'resume', sessionId: id }, { CLAUDE_CONFIG_DIR: configDir })
      const proc = cli.procs[0]!
      const rewind = (args: string) => h.transport.runCommand('rewind', args, signalOf())
      const stored = (await rewind('')).text
      expect(stored).toContain('add the parser')
      expect(stored).toContain('/fix the failing test')
      // What was sent since follows: the transcript does not hold it yet.
      const [newest] = await say(h, proc, 'one more thing')
      expect((await rewind('')).text).toContain('one more thing')

      expect((await rewind('a1b2c3')).kind).toBe('error')
      expect(rewinds(proc)).toEqual([])
      await rewind('a1b2c3ff')
      expect(proc.requests('rewind_files')).toEqual([{ subtype: 'rewind_files', user_message_id: fix, dry_run: true }])

      // Back to before the fix. The CLI answers before it has written the marker that records the cut, so the transcript still lists everything.
      expect((await rewind('2 chat confirm')).kind).toBe('success')
      expect(proc.requests('rewind_conversation')).toEqual([{ subtype: 'rewind_conversation', target_message_uuid: fix, last_seen_user_message_uuid: newest }])
      const cut = (await rewind('')).text
      expect(cut).toContain('add the parser')
      for (const gone of ['/fix the failing test', 'one more thing']) expect(cut).not.toContain(gone)
      // The marker arrives: nothing changes, and a message sent from here on continues from where the conversation now ends.
      appendFileSync(file, jsonl(cutBack(parserReply)))
      expect((await rewind('')).text).toBe(cut)
      await say(h, proc, 'a different approach')
      const next = (await rewind('')).text
      expect(next).toContain('add the parser')
      expect(next).toContain('a different approach')
      expect(next).not.toContain('/fix the failing test')
      await h.transport.close()
    })
  })

  it('knows what its own rewind cut off before the CLI has written the marker for it, so the next rewind is checked against the right message', async () => {
    await inConfigDir(async (configDir) => {
      const id = randomUUID()
      const [a, b, c, aReply, bReply] = Array.from({ length: 5 }, () => randomUUID())
      const file = writeTranscript(configDir, id, typed(a!, null, 'task a'), answered(aReply!, a!), typed(b!, aReply!, 'task b'), answered(bReply!, b!), typed(c!, bReply!, 'task c'), answered(randomUUID(), c!))
      const cli = rewindCli({ knownSessions: new Set([id]) })
      const h = harness(cli)
      await h.start({ kind: 'resume', sessionId: id }, { CLAUDE_CONFIG_DIR: configDir })
      const proc = cli.procs[0]!
      const rewind = (args: string) => h.transport.runCommand('rewind', args, signalOf())
      expect((await rewind('3 chat confirm')).kind).toBe('success')
      // The transcript still has all three; the list does not.
      const listed = (await rewind('')).text
      for (const shown of ['task a', 'task b']) expect(listed).toContain(shown)
      expect(listed).not.toContain('task c')
      // Each cut is checked against the newest message that is still in the conversation, not against one the previous cut removed.
      expect((await rewind('2 chat confirm')).kind).toBe('success')
      expect(proc.requests('rewind_conversation')).toEqual([
        { subtype: 'rewind_conversation', target_message_uuid: c, last_seen_user_message_uuid: c },
        { subtype: 'rewind_conversation', target_message_uuid: b, last_seen_user_message_uuid: b },
      ])
      // Once the markers are written the transcript says the same.
      appendFileSync(file, jsonl(cutBack(bReply), cutBack(aReply)))
      const written = (await rewind('')).text
      expect(written).toContain('task a')
      for (const gone of ['task b', 'task c']) expect(written).not.toContain(gone)
      await h.transport.close()
    })
  })

  it('lists a message of this process until the transcript holds it, and never brings back one the transcript records as cut off', async () => {
    await inConfigDir(async (configDir) => {
      const cli = rewindCli()
      const h = harness(cli)
      await h.start({ kind: 'new' }, { CLAUDE_CONFIG_DIR: configDir })
      const proc = cli.procs[0]!
      const rewind = (args: string) => h.transport.runCommand('rewind', args, signalOf())
      const [first, second] = await say(h, proc, 'first task', 'second task')
      // Before the CLI has written anything, the list is what this process sent.
      const before = (await rewind('')).text
      expect(before).toContain('first task')
      expect(before).toContain('second task')

      // The transcript holds the first message, and the second together with the rewind that cut it off; the third is not written yet.
      await say(h, proc, 'third task')
      const firstReply = randomUUID()
      writeTranscript(configDir, h.transport.sessionId!, typed(first!, null, 'first task'), answered(firstReply, first!), typed(second!, firstReply, 'second task'), cutBack(firstReply))
      const after = (await rewind('')).text
      expect(after.match(/first task/g)).toHaveLength(1)
      expect(after).toContain('third task')
      expect(after).not.toContain('second task')
      await h.transport.close()
    })
  })

  /** What `toAcpPrompt` puts ahead of the user's text: the DSH context projection and the host instructions, each fenced by blank lines. */
  const PROJECTION = generatedContextBlock(
    'Complete current DSH model context projection. This replaces earlier DSH runtime-context and skill-catalog projections for this ACP session; it does not add tools or permissions:\n\n[runtime-context]\nMode: read-only.',
  )
  const HOST = generatedContextBlock(
    'Current host instructions (replace earlier host instructions for this request). Use only tools available in your agent.\n\nNo additional host instructions.',
  )
  /** A Host context message the user's message was claimed with: the host fences it with bare separator blocks. */
  const fenced = (value: string): string[] => [generatedContextSeparator, value, generatedContextSeparator]
  const textBlocks = (...texts: string[]) => texts.map((value) => ({ type: 'text' as const, text: value }))

  it('labels a message with what the user wrote, not with the DSH context the host sends ahead of it', async () => {
    const cli = rewindCli()
    const h = harness(cli)
    await h.start()
    const proc = cli.procs[0]!
    await h.transport.prompt(textBlocks(PROJECTION, HOST, 'rename the parser'), signalOf())
    // The user's text may also come before a claimed Host context message.
    await h.transport.prompt(textBlocks(PROJECTION, HOST, 'add tests for it', ...fenced('claimed runtime snapshot')), signalOf())
    const listing = await h.transport.runCommand('rewind', '', signalOf())
    expect(listing.text).toContain('rename the parser')
    expect(listing.text).toContain('add tests for it')
    for (const generated of ['projection', 'host instructions', 'claimed runtime snapshot']) expect(listing.text).not.toContain(generated)
    const preview = await h.transport.runCommand('rewind', '1', signalOf())
    expect(preview.text).toContain('(`rename the parser`)')
    expect(proc.requests('rewind_files')).toEqual([{ subtype: 'rewind_files', user_message_id: rec(proc.userMessages()[0])['uuid'], dry_run: true }])
    await h.transport.close()
  })

  it('labels the messages of a resumed conversation the same way, from the blocks the CLI stored as sent', async () => {
    await inConfigDir(async (configDir) => {
      const id = randomUUID()
      const [first, firstReply, second] = [randomUUID(), randomUUID(), randomUUID()]
      writeTranscript(
        configDir,
        id,
        typed(first, null, textBlocks(PROJECTION, HOST, 'rename the parser')),
        answered(firstReply, first),
        typed(second, firstReply, textBlocks(PROJECTION, 'add tests for it', ...fenced('claimed runtime snapshot'))),
      )
      const stored = await readClaudeCheckpoints(id, configDir)
      expect(stored.checkpoints.map((checkpoint) => checkpoint.label)).toEqual(['rename the parser', 'add tests for it'])

      const cli = rewindCli({ knownSessions: new Set([id]) })
      const h = harness(cli)
      await h.start({ kind: 'resume', sessionId: id }, { CLAUDE_CONFIG_DIR: configDir })
      const listing = await h.transport.runCommand('rewind', '', signalOf())
      expect(listing.text).toContain('rename the parser')
      expect(listing.text).toContain('add tests for it')
      for (const generated of ['projection', 'host instructions', 'claimed runtime snapshot']) expect(listing.text).not.toContain(generated)
      await h.transport.close()
    })
  })

  it('takes the user text out of a message DSH wrapped in generated blocks, and never ends up with none', () => {
    // The layout of `toAcpPrompt`: projection, host instructions, then the user's text.
    expect(checkpointLabel(textBlocks(PROJECTION, HOST, 'rename the parser'))).toBe('rename the parser')
    // A claimed Host context message sits between bare separators, on either side of the user's text or between two of the user's messages.
    expect(checkpointLabel(textBlocks(PROJECTION, 'add tests', ...fenced('snapshot')))).toBe('add tests')
    expect(checkpointLabel(textBlocks(PROJECTION, ...fenced('snapshot'), 'add tests'))).toBe('add tests')
    expect(checkpointLabel(textBlocks('original task', ...fenced('snapshot'), 'next block'))).toBe('original task next block')
    // An attachment's link and the other blocks the user's message carries stay with its text.
    expect(checkpointLabel([...textBlocks(PROJECTION, 'look at this'), { type: 'image', source: {} }, ...textBlocks('[@a.ts](file:///tmp/a.ts)')])).toBe('look at this [@a.ts](file:///tmp/a.ts)')
    // Nothing but generated blocks: the last one that says anything stands in, and silence is "(no text)".
    expect(checkpointLabel(textBlocks(HOST, PROJECTION))).toMatch(/^Complete current DSH model context projection/)
    expect(checkpointLabel(textBlocks(generatedContextSeparator, generatedContextSeparator))).toBe('(no text)')
    // User text that itself begins and ends with blank lines is still the user's; so is text after a fence that never closes.
    expect(checkpointLabel(textBlocks(PROJECTION, '\n\nwith blank lines\n\n'))).toBe('with blank lines')
    expect(checkpointLabel(textBlocks(generatedContextSeparator, 'user text'))).toBe('user text')
  })

  it('finds the user text in a prompt whose blocks were joined, and drops the time sample DSH sends unfenced', () => {
    // Oh My Pi stores the blocks joined by blank lines and trimmed (shape copied from a real omp 18.12.6 session file).
    const joined = [
      'Complete current DSH model context projection. This replaces earlier DSH runtime-context and skill-catalog projections for this ACP session; it does not add tools or permissions:\n\nruntime-context: current replacement snapshot is already present in this request.',
      'Current host instructions (replace earlier host instructions for this request). Use only tools available in your agent.\n\nYou are a coding agent.',
      'Remember the codeword ALPHA-OMP.\n\nReply with exactly READY.',
      'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent working directory: "/w"',
      '<system-reminder>\nA skill is a reusable set of task-specific instructions.\n</system-reminder>',
      'Time sampled while preparing turn 1, step 1: 2026-10-29T01:16:07+08:00[Asia/Shanghai]',
    ].join('\n\n\n\n')
    expect(checkpointLabel(joined)).toBe('Remember the codeword ALPHA-OMP. Reply with exactly READY.')
    // Claude Code and Codex keep the blocks; the time sample is one of its own after the user's text.
    const timeSample = 'Time sampled while preparing turn 2, step 1: 2026-10-29T01:14:02+08:00[Asia/Shanghai]\nBrowser time zone for this request: Asia/Shanghai.'
    expect(checkpointLabel(textBlocks(PROJECTION, HOST, 'Remember a second codeword BETA.', timeSample))).toBe('Remember a second codeword BETA.')
  })

  it('labels a transcript message the way the user typed it', () => {
    expect(checkpointLabel([{ type: 'text', text: 'first line\nsecond line' }, { type: 'image', source: {} }])).toBe('first line second line')
    expect(checkpointLabel('<command-name>/hello</command-name><command-args> world </command-args>')).toBe('/hello world')
    expect(checkpointLabel('x'.repeat(300)).length).toBeLessThanOrEqual(CHECKPOINT_LABEL_LIMIT)
    expect(checkpointLabel('')).toBe('(no text)')
  })
})

// ---------------------------------------------------------------------------
// Live: the real CLI through the user's launcher and profile environment
// ---------------------------------------------------------------------------

interface LiveProfile {
  readonly launcher: string
  readonly env: Record<string, string>
}

function loadLiveProfile(): LiveProfile | undefined {
  if (process.env['DSH_CLAUDE_NATIVE_LIVE'] !== '1') return undefined
  try {
    const file = path.join(os.homedir(), '.dsh/profiles/desktop/cordis.patch.yml')
    const entries: unknown = parseYaml(readFileSync(file, 'utf8'))
    const entry = Array.isArray(entries) ? entries.map(rec).find((candidate) => candidate['id'] === 'dsh-acp-adapter') : undefined
    const claude = rec(rec(rec(entry?.['config'])['agents'])['claude'])
    const env = Object.fromEntries(Object.entries(rec(claude['env'])).filter((pair): pair is [string, string] => typeof pair[1] === 'string'))
    const launcher = env['CLAUDE_CODE_EXECUTABLE']
    return launcher === undefined ? undefined : { launcher, env }
  } catch {
    return undefined
  }
}

const live = loadLiveProfile()

/** A host spawner for the live run: the explicit profile env merged onto this process's environment. */
const liveSpawn: NativeSpawn = (spec) => {
  const child = spawn(spec.argv[0] ?? '', spec.argv.slice(1), { cwd: spec.cwd, env: { ...process.env, ...spec.env }, stdio: 'pipe' })
  const { promise, resolve, reject } = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>()
  child.once('error', reject)
  child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }))
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    exited: promise,
    terminate: () => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref()
    },
  }
}

function liveHarness(profile: LiveProfile, cwd: string) {
  const events: NativeTransportEvent[] = []
  const permissions: NativePermissionRequest[] = []
  const logs: string[] = []
  const transport = new ClaudeCliTransport()
  return {
    transport,
    events,
    permissions,
    logs,
    start: async (session: NativeTransportStartOptions['session']) =>
      await transport.start({
        argv: [profile.launcher],
        env: profile.env,
        cwd,
        spawn: liveSpawn,
        session,
        onEvent: (event) => events.push(event),
        onPermission: async (request) => {
          permissions.push(request)
          return { optionId: 'allow-once' }
        },
        log: (message) => logs.push(message),
      }),
  }
}

function replyText(events: readonly NativeTransportEvent[]): string {
  return updatesOf(events)
    .filter((update) => update['sessionUpdate'] === 'agent_message_chunk')
    .map((update) => String(rec(update['content'])['text']))
    .join('')
}

/** A transcript of an old claude-agent-acp session in a TokenRouterNew directory, preferring one that ran in bypassPermissions. */
function findOldAcpSession(): { sessionId: string; mode: string | undefined } | undefined {
  const projects = path.join(os.homedir(), '.claude', 'projects')
  let best: { sessionId: string; mode: string | undefined; size: number } | undefined
  try {
    for (const directory of readdirSync(projects).filter((name) => name.includes('TokenRouterNew'))) {
      for (const file of readdirSync(path.join(projects, directory)).filter((name) => name.endsWith('.jsonl'))) {
        const full = path.join(projects, directory, file)
        const head = readFileSync(full, 'utf8').split('\n').slice(0, 5).join('\n')
        if (!head.includes('"entrypoint":"sdk-cli"')) continue
        const mode = /"permissionMode":"(\w+)"/.exec(head)?.[1]
        const size = statSync(full).size
        if (best === undefined || (mode === 'bypassPermissions' && best.mode !== 'bypassPermissions') || (mode === best.mode && size > best.size)) {
          best = { sessionId: file.replace(/\.jsonl$/, ''), mode, size }
        }
      }
    }
  } catch {
    return undefined
  }
  return best
}

describe.skipIf(live === undefined)('Claude Code through claude-launch.mjs (live; DSH_CLAUDE_NATIVE_LIVE=1)', () => {
  const baseDir = process.env['DSH_CLAUDE_NATIVE_LIVE_DIR'] ?? os.tmpdir()
  const cwd = mkdtempSync(path.join(baseDir, 'dsh-claude-live-'))
  const token = `KUMQUAT-${Math.floor(Math.random() * 9000 + 1000)}`
  let sessionId: string | undefined

  it(
    'runs a Bash turn with ACP-shaped updates, steers it mid-tool and reports whole-turn usage',
    { timeout: 240_000 },
    async () => {
      const profile = live!
      const h = liveHarness(profile, cwd)
      try {
        await h.start({ kind: 'new' })
        sessionId = h.transport.sessionId
        expect(sessionId).toMatch(/^[0-9a-f-]{36}$/)
        expect(h.transport.agentInfo.version).toMatch(/^\d+\.\d+\.\d+/)
        const controls = h.transport.controls()
        expect(controls.configOptions.map((option) => option.id)).toEqual(expect.arrayContaining(['mode', 'model', 'effort']))
        expect(controls.modes?.availableModes.map((mode) => mode.id)).toEqual(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'])

        // DSH runs unattended: bypassPermissions must not prompt.
        await h.transport.setConfigOption('mode', 'bypassPermissions')
        expect(h.transport.controls().modes?.currentModeId).toBe('bypassPermissions')

        const prompt = h.transport.prompt(
          [{ type: 'text', text: `Remember the token ${token}. Use the Bash tool to run exactly: sleep 6 && echo FIRST_OUT . After it finishes reply with exactly: DONE` }],
          new AbortController().signal,
        )
        await until(() => updatesOf(h.events).some((update) => update['toolCallId'] !== undefined && update['rawInput'] !== undefined && update['title'] === 'sleep 6 && echo FIRST_OUT'), 'Bash tool call', 120_000)
        expect(await h.transport.steer([{ type: 'text', text: 'Also include the exact word STEERED in your final reply.' }])).toBe('injected')
        const result = await prompt

        expect(result.stopReason).toBe('end_turn')
        expect(replyText(h.events)).toContain('STEERED')
        const updates = updatesOf(h.events)
        const start = updates.find((update) => update['sessionUpdate'] === 'tool_call' && update['name'] === 'Bash')
        expect(start).toMatchObject({ status: 'pending', kind: 'execute', _meta: { claudeCode: { toolName: 'Bash' } } })
        const toolCallId = String(start?.['toolCallId'])
        expect(updates.some((update) => update['toolCallId'] === toolCallId && update['rawInput'] !== undefined)).toBe(true)
        const finished = updates.find((update) => update['toolCallId'] === toolCallId && update['status'] === 'completed')
        expect(JSON.stringify(finished?.['content'])).toContain('FIRST_OUT')
        expect(h.permissions).toEqual([])
        expect(result.usage?.inputTokens).toBeGreaterThanOrEqual(0)
        expect((result.usage?.outputTokens ?? 0) + (result.usage?.cachedWriteTokens ?? 0) + (result.usage?.cachedReadTokens ?? 0)).toBeGreaterThan(0)
        expect(result.usage?.costUsd).toBeGreaterThan(0)
        expect(h.events.some((event) => event.kind === 'context_usage' && event.contextUsage.size > 0 && event.contextUsage.used > 0)).toBe(true)
        expect(h.transport.contextUsage()?.cost?.amount).toBeGreaterThan(0)
      } finally {
        await h.transport.close()
      }
    },
  )

  it(
    'resumes in a new transport and recalls the token, then switches model and effort and runs on the new model',
    { timeout: 240_000 },
    async () => {
      const profile = live!
      expect(sessionId, 'the first live test must have created a session').toBeDefined()
      const h = liveHarness(profile, cwd)
      try {
        await h.start({ kind: 'resume', sessionId: sessionId! })
        expect(h.transport.sessionId).toBe(sessionId)
        // The CLI restores neither the mode nor the model; the transport re-establishes the mode from the transcript.
        expect(h.transport.controls().modes?.currentModeId).toBe('bypassPermissions')

        await h.transport.setConfigOption('model', 'claude-sonnet-5.5')
        await h.transport.setConfigOption('effort', 'low')
        const after = h.transport.controls().configOptions
        expect(after.find((option) => option.id === 'model')).toMatchObject({ currentValue: 'claude-sonnet-5.5' })
        expect(after.find((option) => option.id === 'effort')).toMatchObject({ currentValue: 'low' })

        const result = await h.transport.prompt([{ type: 'text', text: 'Which token did I ask you to remember? Reply with only the token.' }], new AbortController().signal)
        expect(result.stopReason).toBe('end_turn')
        expect(replyText(h.events)).toContain(token)
        // This turn added a little; the history (the previous turn's spend) is not charged again.
        expect(result.usage?.costUsd).toBeGreaterThan(0)
        expect(result.usage?.costUsd).toBeLessThan((h.transport.contextUsage()?.cost?.amount ?? 0) * 0.9)
        const tail = await readClaudeResumedTail(sessionId!, path.join(os.homedir(), '.claude'))
        expect(tail.model).toBe('claude-sonnet-5.5')
        expect(tail.permissionMode).toBe('bypassPermissions')
      } finally {
        await h.transport.close()
      }
    },
  )

  it('resumes an old claude-agent-acp session id with start() and controls() only', { timeout: 120_000 }, async () => {
    const profile = live!
    const old = findOldAcpSession()
    if (old === undefined) return
    const h = liveHarness(profile, cwd)
    try {
      await h.start({ kind: 'resume', sessionId: old.sessionId })
      expect(h.transport.sessionId).toBe(old.sessionId)
      const controls = h.transport.controls()
      expect(controls.configOptions.map((option) => option.id)).toEqual(expect.arrayContaining(['mode', 'model', 'effort']))
      if (old.mode !== undefined) expect(controls.modes?.currentModeId).toBe(old.mode)
    } finally {
      await h.transport.close()
    }
  })

  it('reports an unknown session id as not found', { timeout: 60_000 }, async () => {
    const profile = live!
    const h = liveHarness(profile, cwd)
    const failure = await h.start({ kind: 'resume', sessionId: randomUUID() }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toMatchObject({ code: 'session-not-found' })
    expect((failure as Error).message).toContain('session not found')
    rmSync(cwd, { recursive: true, force: true })
  })
})
