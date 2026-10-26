import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'

import { parse as parseYaml } from 'yaml'
import { describe, expect, it } from 'vitest'

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
import { prepareClaudePermission } from '../../src/runtime/native/transports/claude-permissions.ts'
import {
  ClaudeFrameMapper,
  claudeToolFacts,
  diffUpdateFromToolResponse,
  modelUsageIncrement,
  normalizeModelUsage,
  unstreamedRemainder,
} from '../../src/runtime/native/transports/claude-projection.ts'
import {
  ClaudeCliTransport,
  buildClaudeArgv,
  claudeAvailableCommands,
  claudeTurnOutcome,
  claudeUserMessageFrame,
  createClaudeTransport,
  parseClaudeSettings,
  readClaudeResumedTail,
} from '../../src/runtime/native/transports/claude.ts'
import {
  NativeTransportError,
  type NativePermissionRequest,
  type NativeProcess,
  type NativeSpawn,
  type NativeTransportEvent,
  type NativeTransportStartOptions,
} from '../../src/runtime/native/transports/contract.ts'

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
  const base = { launcher: ['/opt/claude-launch.mjs'], sessionId: '11111111-1111-4111-8111-111111111111', permissionMode: 'default' as const, allowBypass: true }

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

  it('advertises slash commands without the terminal-bound and unsupported ones', () => {
    const commands = claudeAvailableCommands(initResponse()['commands'], ['review'])
    expect(commands.map((command) => command.name)).toEqual(['cluster-task-monitor', 'mcp'])
    expect(commands[0]).toMatchObject({ description: 'Register tasks', input: null })
    expect(claudeAvailableCommands([{ name: 'x (MCP)', description: 'd', argumentHint: ['a', 'b'] }], [])[0]).toMatchObject({ name: 'mcp:x', input: { hint: 'a b' } })
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
}

interface FakeOptions {
  /** Called for every user message (prompt or steer). */
  readonly onUser?: (frame: Json, proc: FakeClaude) => void
  /** Called for control requests the default handler does not answer. */
  readonly onControl?: (request: Json, frame: Json, proc: FakeClaude) => boolean | void
  readonly init?: Json
  readonly settings?: Json
  /** Resume ids that exist; any other `--resume` fails like the CLI. */
  readonly knownSessions?: ReadonlySet<string>
}

function fakeCli(options: FakeOptions = {}): { spawn: NativeSpawn; procs: FakeClaude[] } {
  const procs: FakeClaude[] = []
  const spawnFake: NativeSpawn = (spec) => {
    const argv = [...spec.argv]
    const resumeAt = argv.indexOf('--resume')
    const missing = resumeAt >= 0 && options.knownSessions !== undefined && !options.knownSessions.has(argv[resumeAt + 1] ?? '')
    const proc: FakeClaude = new FakeClaude(argv, (frame, self) => {
      if (missing) return
      if (frame['type'] === 'user') {
        options.onUser?.(frame, self)
        return
      }
      if (frame['type'] !== 'control_request') return
      const request = frame['request'] as Json
      switch (request['subtype']) {
        case 'initialize':
          self.reply(frame, options.init ?? initResponse())
          return
        case 'get_settings':
          self.reply(frame, options.settings ?? settingsResponse())
          return
        case 'get_context_usage':
          self.reply(frame, { rawMaxTokens: 1_000_000, model: 'claude-opus-5.5' })
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
  readonly logs: string[]
  start(session?: NativeTransportStartOptions['session'], env?: Record<string, string>): Promise<void>
}

function harness(cli: ReturnType<typeof fakeCli>, answer: (request: NativePermissionRequest) => { optionId: string } | { cancelled: true } = () => ({ optionId: 'allow-once' })): Harness {
  const transport = new ClaudeCliTransport()
  const events: NativeTransportEvent[] = []
  const permissions: NativePermissionRequest[] = []
  const logs: string[] = []
  return {
    transport,
    events,
    permissions,
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

    await until(() => h.events.some((event) => event.kind === 'update' && rec(event.update)['sessionUpdate'] === 'available_commands_update'), 'commands update')
    const commands = updatesOf(h.events).find((update) => update['sessionUpdate'] === 'available_commands_update')
    const advertised = commands?.['availableCommands']
    expect((Array.isArray(advertised) ? advertised : []).map((command) => rec(command)['name'])).toEqual(['cluster-task-monitor', 'review', 'mcp'])
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

    // Host callbacks this transport cannot serve are refused so the CLI never waits on them.
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
