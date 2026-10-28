/// <reference types="node" />
/**
 * OMP native transport tests.
 *
 * Three layers:
 * 1. Pure functions (launch argv, control derivation, event → ACP projection, usage, session files).
 * 2. The transport against a scripted in-process `omp --mode rpc-ui` (no binary, no network): launch
 *    shape, session attach (new / resume / fork), controls, turns, steering, approvals, abort, close.
 * 3. The real `omp` binary. It skips when `omp` is not installed or when `OMP_NATIVE_E2E=0` opts out.
 *    Every live test runs a short turn at most (plus one `omp acp` `session/new` as the parity oracle).
 *    `OMP_NATIVE_E2E_OLD_SESSION_DIR=<dir>` additionally resumes sessions an earlier `omp acp` run wrote in
 *    <dir> (start + controls only, no prompt); it is opt-in because it opens a user's real session files.
 */
import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import {
  NativeTransportError,
  type NativeContentBlock,
  type NativeElicitationHandler,
  type NativeElicitationRequest,
  type NativePermissionDecision,
  type NativePermissionRequest,
  type NativeProcess,
  type NativePromptResult,
  type NativeSessionTarget,
  type NativeSpawn,
  type NativeTransportEvent,
} from '../../src/runtime/native/transports/contract.ts'
import {
  formatGoal,
  goalFailure,
  goalNote,
  parseGoalArgs,
  parseOmpGoal,
  type OmpGoal,
} from '../../src/runtime/native/transports/omp-goal.ts'
import { createOmpConfigOverlay } from '../../src/runtime/native/transports/omp-overlay.ts'
import {
  applyRestore,
  findCheckpoint,
  nodeRestoreIo,
  parseRewindArgs,
  planRestore,
  readRewindModel,
  renderCheckpoints,
  renderRewindPreview,
  type DiskFile,
  type OmpCheckpoint,
  type OmpFileChange,
  type RestoreIo,
} from '../../src/runtime/native/transports/omp-rewind.ts'
import {
  buildOmpCommandCatalog,
  buildOmpLaunchArgv,
  buildOmpToolTitle,
  createOmpTransport,
  deriveOmpControls,
  extractOmpAssistantText,
  findOmpSessionFile,
  mapOmpPermissionOptions,
  mapOmpToolKind,
  OmpEventProjector,
  OmpNativeTransport,
  OmpUsageAccumulator,
  parseOmpModel,
  readOmpSessionHeader,
  readOmpSessionThinking,
  sumOmpUsage,
  type OmpModelInfo,
} from '../../src/runtime/native/transports/omp.ts'

type Json = Record<string, unknown>

/** Narrow `unknown` to a JSON object, or fail the test. */
function jsonObject(value: unknown): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`expected a JSON object, got ${JSON.stringify(value)}`)
  }
  return Object.fromEntries(Object.entries(value))
}

function jsonObjects(value: unknown): Json[] {
  if (!Array.isArray(value)) throw new Error(`expected a JSON array, got ${JSON.stringify(value)}`)
  return value.map(jsonObject)
}

function nativeError(value: unknown): NativeTransportError {
  if (!(value instanceof NativeTransportError)) throw new Error(`expected a NativeTransportError, got ${String(value)}`)
  return value
}

/** A field of an ACP update (or any object), `undefined` when absent. */
function fieldOf(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value ? Object.fromEntries(Object.entries(value))[key] : undefined
}

// ---------------------------------------------------------------------------
// 1. Pure functions
// ---------------------------------------------------------------------------

describe('buildOmpLaunchArgv', () => {
  it('drops the ACP subcommand and the flags the transport owns, keeps extensions, appends rpc-ui', () => {
    const plan = buildOmpLaunchArgv(['/bin/omp', 'acp', '-e', '/x/link.js', '--no-session', '--mode', 'rpc'])
    expect(plan.argv).toEqual(['/bin/omp', '-e', '/x/link.js', '--mode', 'rpc-ui', '--auto-approve'])
    expect(plan.dropped).toEqual(['acp', '--no-session', '--mode', 'rpc'])
    expect(plan.versionArgv).toEqual(['/bin/omp', '-e', '/x/link.js', '--version'])
  })

  it('drops session selectors in every spelling but not an unrelated value', () => {
    const plan = buildOmpLaunchArgv([
      '/bin/omp',
      '--session',
      '/s/a.jsonl',
      '--resume=abc',
      '-r',
      'def',
      '--mode=rpc',
      '--continue',
      '--model',
      'tokenrouter/x',
    ])
    expect(plan.argv).toEqual(['/bin/omp', '--model', 'tokenrouter/x', '--mode', 'rpc-ui', '--auto-approve'])
  })

  it('keeps an approval choice the launcher already made', () => {
    expect(buildOmpLaunchArgv(['omp', '--approval-mode=always-ask']).argv).toEqual([
      'omp',
      '--approval-mode=always-ask',
      '--mode',
      'rpc-ui',
    ])
    expect(buildOmpLaunchArgv(['omp', '--auto-approve']).argv).toEqual(['omp', '--auto-approve', '--mode', 'rpc-ui'])
    expect(buildOmpLaunchArgv(['omp', '--yolo']).argv).toEqual(['omp', '--yolo', '--mode', 'rpc-ui'])
  })

  it("appends the config overlay as the last --config, after the launcher's own, and keeps it out of the version probe", () => {
    const launcher = ['/bin/omp', 'acp', '--config', '/etc/mine.yml', '-e', '/x/link.js', '--approval-mode', 'ask']
    const plan = buildOmpLaunchArgv(launcher, '/tmp/dsh-acp-omp-x/overlay.yml')
    expect(plan.argv).toEqual([
      '/bin/omp',
      '--config',
      '/etc/mine.yml',
      '-e',
      '/x/link.js',
      '--approval-mode',
      'ask',
      '--mode',
      'rpc-ui',
      '--config',
      '/tmp/dsh-acp-omp-x/overlay.yml',
    ])
    expect(plan.versionArgv).toEqual(['/bin/omp', '--config', '/etc/mine.yml', '-e', '/x/link.js', '--approval-mode', 'ask', '--version'])
    // Without an overlay nothing about --config changes.
    expect(buildOmpLaunchArgv(launcher).argv).not.toContain('/tmp/dsh-acp-omp-x/overlay.yml')
  })

  it('keeps the wrapper arguments of a launcher that is not the omp binary itself', () => {
    const plan = buildOmpLaunchArgv(['/usr/bin/env', 'bun', '/opt/omp/cli.js', 'acp'])
    // `acp` is only the ACP subcommand at the first argument position.
    expect(plan.argv).toEqual(['/usr/bin/env', 'bun', '/opt/omp/cli.js', 'acp', '--mode', 'rpc-ui', '--auto-approve'])
  })

  it('rejects an empty launcher', () => {
    expect(() => buildOmpLaunchArgv([])).toThrowError(NativeTransportError)
  })
})

const MODEL_OPUS: OmpModelInfo = {
  provider: 'tokenrouter-v2',
  id: 'claude-opus-5.5',
  name: 'Claude Opus 5.5',
  reasoning: true,
  input: ['text', 'image'],
}
const MODEL_SOL: OmpModelInfo = {
  provider: 'tokenrouter-v2',
  id: 'gpt-6.1-sol',
  name: 'GPT-6.1 Sol (v2)',
  reasoning: true,
  input: ['text', 'image'],
}
const MODEL_GLM: OmpModelInfo = {
  provider: 'tokenrouter-v2',
  id: 'glm-5.3',
  name: 'GLM 5.3',
  reasoning: false,
  input: ['text'],
}

describe('deriveOmpControls', () => {
  it('reproduces the session/new controls of omp acp: ids, categories, names, values', () => {
    const controls = deriveOmpControls({
      models: [MODEL_OPUS, MODEL_SOL, MODEL_GLM],
      model: MODEL_SOL,
      thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh'],
      thinkingLevel: 'high',
      thinkingAuto: false,
    })
    expect(controls.modes).toEqual({
      currentModeId: 'default',
      availableModes: [{ id: 'default', name: 'Default', description: 'Standard ACP headless mode' }],
    })
    expect(controls.configOptions).toEqual([
      {
        id: 'mode',
        name: 'Mode',
        category: 'mode',
        type: 'select',
        currentValue: 'default',
        options: [{ value: 'default', name: 'Default', description: 'Standard ACP headless mode' }],
      },
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'tokenrouter-v2/gpt-6.1-sol',
        options: [
          { value: 'tokenrouter-v2/claude-opus-5.5', name: 'Claude Opus 5.5', description: 'tokenrouter-v2/claude-opus-5.5' },
          { value: 'tokenrouter-v2/gpt-6.1-sol', name: 'GPT-6.1 Sol (v2)', description: 'tokenrouter-v2/gpt-6.1-sol' },
          { value: 'tokenrouter-v2/glm-5.3', name: 'GLM 5.3', description: 'tokenrouter-v2/glm-5.3' },
        ],
      },
      {
        id: 'thinking',
        name: 'Thinking',
        category: 'thought_level',
        type: 'select',
        currentValue: 'high',
        options: [
          { value: 'off', name: 'Off' },
          { value: 'auto', name: 'Auto', description: 'Auto-detect per prompt' },
          { value: 'low', name: 'low' },
          { value: 'medium', name: 'medium' },
          { value: 'high', name: 'high' },
          { value: 'xhigh', name: 'xhigh' },
        ],
      },
    ])
    expect(controls.imageInput).toBe(true)
  })

  it('reports auto, off for non-reasoning models and image support from the current model', () => {
    const auto = deriveOmpControls({
      models: [MODEL_SOL],
      model: MODEL_SOL,
      thinkingLevels: ['off', 'low'],
      thinkingLevel: 'low',
      thinkingAuto: true,
    })
    expect(auto.configOptions.find((option) => option.id === 'thinking')?.currentValue).toBe('auto')

    const plain = deriveOmpControls({
      models: [MODEL_GLM],
      model: MODEL_GLM,
      thinkingLevels: ['off'],
      thinkingLevel: 'high',
      thinkingAuto: true,
    })
    // ACP: a model that does not reason always reports `off`, whatever the stored selector is.
    expect(plain.configOptions.find((option) => option.id === 'thinking')?.currentValue).toBe('off')
    expect(plain.imageInput).toBe(false)
  })

  it('omits the model option when no model is known, like ACP', () => {
    const controls = deriveOmpControls({
      models: [],
      model: undefined,
      thinkingLevels: ['off'],
      thinkingLevel: undefined,
      thinkingAuto: false,
    })
    expect(controls.configOptions.map((option) => option.id)).toEqual(['mode', 'thinking'])
    expect(controls.imageInput).toBe(false)
  })

  it('adds fast and slow as boolean toggles only when omp reports them', () => {
    const base = {
      models: [MODEL_SOL],
      model: MODEL_SOL,
      thinkingLevels: ['off', 'low'],
      thinkingLevel: 'low',
      thinkingAuto: false,
    }
    expect(deriveOmpControls(base).configOptions.map((option) => option.id)).toEqual(['mode', 'model', 'thinking'])
    const toggles = deriveOmpControls({ ...base, fastMode: true, slowMode: false }).configOptions.slice(3)
    expect(toggles.map((option) => [option.id, option.type, option.currentValue])).toEqual([
      ['fast', 'boolean', true],
      ['slow', 'boolean', false],
    ])
    expect(deriveOmpControls({ ...base, fastMode: false }).configOptions.map((option) => option.id)).toEqual([
      'mode',
      'model',
      'thinking',
      'fast',
    ])
  })
})

describe('parseOmpModel', () => {
  it('needs a provider and an id and falls back to the id as name', () => {
    expect(parseOmpModel({ provider: 'p', id: 'm', input: ['text', 3] })).toEqual({
      provider: 'p',
      id: 'm',
      name: 'm',
      reasoning: false,
      input: ['text'],
    })
    expect(parseOmpModel({ id: 'm' })).toBeUndefined()
    expect(parseOmpModel({ provider: 'p', id: '' })).toBeUndefined()
    expect(parseOmpModel('x')).toBeUndefined()
  })
})

describe('mapOmpPermissionOptions', () => {
  it('keeps every vendor label as option id and never assumes exactly two options', () => {
    const options = mapOmpPermissionOptions([
      'Approve Directory: /repo',
      'Always Approve Directory: /repo',
      'Approve Once',
      'Approve this session',
      'Deny',
    ])
    expect(options.map((option) => option.optionId)).toEqual([
      'Approve Directory: /repo',
      'Always Approve Directory: /repo',
      'Approve Once',
      'Approve this session',
      'Deny',
    ])
    expect(options.map((option) => option.kind)).toEqual([
      'allow_always',
      'allow_always',
      'allow_once',
      'allow_once',
      'reject_once',
    ])
  })

  it('maps the plain two-label dialog and tolerates empty lists', () => {
    expect(mapOmpPermissionOptions(['Approve', 'Deny'])).toEqual([
      { optionId: 'Approve', name: 'Approve', kind: 'allow_once' },
      { optionId: 'Deny', name: 'Deny', kind: 'reject_once' },
    ])
    expect(mapOmpPermissionOptions([])).toEqual([])
  })
})

describe('turn usage', () => {
  const callOne = {
    input: 3,
    output: 87,
    cacheRead: 0,
    cacheWrite: 9075,
    totalTokens: 9165,
    reasoningTokens: 10,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0125 },
  }
  const callTwo = {
    input: 3,
    output: 5,
    cacheRead: 9075,
    cacheWrite: 103,
    totalTokens: 9186,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0012 },
  }

  it('sums every model call of the turn: uncached input, cache read/write, output, reasoning, cost', () => {
    const usage = sumOmpUsage([callOne, callTwo])
    expect(usage).toEqual({
      inputTokens: 6,
      outputTokens: 92,
      cachedReadTokens: 9075,
      cachedWriteTokens: 9178,
      thoughtTokens: 10,
      costUsd: expect.closeTo(0.0137, 10),
    })
  })

  it('omits what the vendor did not report and ignores payloads without token accounting', () => {
    expect(sumOmpUsage([{ input: 5, output: 7, cacheRead: 0, cacheWrite: 0 }])).toEqual({
      inputTokens: 5,
      outputTokens: 7,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
    })
    expect(sumOmpUsage([])).toBeUndefined()
    expect(sumOmpUsage([{}, { provider: 'x' }, undefined, 'x'])).toBeUndefined()
    expect(sumOmpUsage([{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }])).toBeUndefined()
  })

  it('counts one message once even when its end frame is seen twice', () => {
    const accumulator = new OmpUsageAccumulator()
    expect(accumulator.add(callOne, 'msg-2')).toBe(true)
    expect(accumulator.add(callOne, 'msg-2')).toBe(false)
    expect(accumulator.add(callTwo, 'msg-4')).toBe(true)
    expect(accumulator.snapshot()?.inputTokens).toBe(6)
  })
})

describe('tool call projection helpers', () => {
  it('classifies tools like the ACP mapper', () => {
    expect(mapOmpToolKind('read')).toBe('read')
    expect(mapOmpToolKind('edit')).toBe('edit')
    expect(mapOmpToolKind('write', { path: 'a.txt' })).toBe('edit')
    expect(mapOmpToolKind('write', { path: 'xd://github' })).toBe('execute')
    expect(mapOmpToolKind('write', { path: 'proc://job' })).toBe('execute')
    expect(mapOmpToolKind('bash')).toBe('execute')
    expect(mapOmpToolKind('eval')).toBe('execute')
    expect(mapOmpToolKind('grep')).toBe('search')
    expect(mapOmpToolKind('glob')).toBe('search')
    expect(mapOmpToolKind('web_search')).toBe('fetch')
    expect(mapOmpToolKind('todo')).toBe('think')
    expect(mapOmpToolKind('browser')).toBe('other')
  })

  it('titles a call by command, intent, then subject', () => {
    expect(buildOmpToolTitle('bash', { command: 'ls -la' }, 'List files')).toBe('$ ls -la')
    expect(buildOmpToolTitle('read', { path: 'src/a.ts' }, '  Reading a  ')).toBe('Reading a')
    expect(buildOmpToolTitle('read', { path: 'src/a.ts' })).toBe('read: src/a.ts')
    expect(buildOmpToolTitle('grep', { pattern: 'TODO' })).toBe('grep: TODO')
    expect(buildOmpToolTitle('read', { path: 'skill://react' })).toBe('skill://react')
    expect(buildOmpToolTitle('browser', {})).toBe('browser')
    expect(buildOmpToolTitle('eval', { cells: [{ language: 'py', title: 't', code: '1+1' }] })).toBe('[py] t\n1+1')
  })

  it('extracts assistant text the way ACP does', () => {
    expect(
      extractOmpAssistantText({
        content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
      }),
    ).toBe('a\nb')
    expect(extractOmpAssistantText({ content: 'nope' })).toBe('')
  })

  it('classifies the rpc command catalogue for the host', () => {
    const catalog = buildOmpCommandCatalog([
      {
        name: 'security',
        description: 'Scan',
        input: { hint: '<plan|scan>' },
        subcommands: [{ name: 'plan' }],
        source: 'builtin',
      },
      { name: 'model', description: 'Show', aliases: ['models', 'model'], source: 'builtin' },
      { name: 'hello', description: 'Greet', input: { hint: 'name' }, source: 'file' },
      { name: 'skill:demo', source: 'skill' },
      { name: 'compact' },
      { description: 'nameless' },
    ])
    expect(
      catalog.commands
        .filter((command) => command.dispatch !== 'prompt')
        .map((command) => [command.name, command.dispatch]),
    ).toEqual([
      ['btw', 'side'],
      ['new', 'immediate'],
      ['clear', 'immediate'],
      ['rewind', 'immediate'],
    ])
    // `goal` is one of the commands the transport serves, but it runs as a turn the host holds open: a `prompt` command.
    expect(catalog.commands.filter((command) => command.dispatch === 'prompt').map((command) => command.name)).toEqual([
      'goal',
      'security',
      'model',
      'hello',
      'skill:demo',
      'compact',
    ])
    expect(catalog.commands.find((command) => command.name === 'security')).toEqual({
      name: 'security',
      description: 'Scan',
      hint: '<plan|scan>',
      dispatch: 'prompt',
    })
    expect(catalog.commands.find((command) => command.name === 'model')).toEqual({
      name: 'model',
      description: 'Show',
      aliases: ['models'],
      dispatch: 'prompt',
    })
    // Only commands omp resolves before its builtins can take a terminal-only name.
    expect([...catalog.overrides].sort()).toEqual(['hello', 'skill:demo'])
  })

  it('serves btw, new, clear, rewind and goal unless a user command already owns the name', () => {
    const catalog = buildOmpCommandCatalog([
      { name: 'btw', description: 'omp handles it some day', source: 'builtin' },
      { name: 'new', description: 'my extension', source: 'extension' },
      { name: 'goal', description: 'my goal command', source: 'file' },
    ])
    expect(Object.fromEntries(catalog.commands.map((command) => [command.name, command.dispatch]))).toEqual({
      btw: 'side',
      clear: 'immediate',
      rewind: 'immediate',
      new: 'prompt',
      goal: 'prompt',
    })
    expect(catalog.commands.find((command) => command.name === 'new')?.description).toBe('my extension')
    expect(catalog.commands.find((command) => command.name === 'goal')?.description).toBe('my goal command')
    expect(buildOmpCommandCatalog(undefined).commands.map((command) => command.name)).toEqual(['btw', 'new', 'clear', 'rewind', 'goal'])
  })

  it('treats a terminal-only builtin that omp now advertises as runnable, except the ones the transport serves', () => {
    const catalog = buildOmpCommandCatalog([
      { name: 'branch', aliases: ['fork'], description: 'Branch', source: 'builtin' },
      { name: 'btw', description: 'Side question', source: 'builtin' },
      { name: 'rewind', description: 'Rewind', source: 'builtin' },
      { name: 'goal', description: 'Goal', source: 'builtin' },
      { name: 'context', description: 'Usage', source: 'builtin' },
    ])
    expect([...catalog.overrides].sort()).toEqual(['branch', 'fork'])
    // The transport's entries stay, and keep their dispatch.
    expect(catalog.commands.filter((command) => ['btw', 'rewind', 'goal'].includes(command.name)).map((command) => [command.name, command.dispatch])).toEqual([
      ['btw', 'side'],
      ['rewind', 'immediate'],
      ['goal', 'prompt'],
    ])
  })
})

function newProjector(files: readonly string[] = []): OmpEventProjector {
  let counter = 0
  return new OmpEventProjector({
    cwd: '/work',
    homeDir: '/home/u',
    isFile: (path) => files.includes(path),
    newMessageId: () => `uuid-${(counter += 1)}`,
  })
}

const assistantFrame = (type: string, extra: Json = {}): Json => ({
  type,
  message: { role: 'assistant' },
  messageId: 'msg-2',
  ...extra,
})

describe('OmpEventProjector', () => {
  it('projects a bash call: pending tool_call with the command as title/content, then progress, then the result', () => {
    const projector = newProjector()
    const start = projector.project({
      type: 'tool_execution_start',
      toolCallId: 'call_1|fc_9',
      toolName: 'bash',
      args: { command: 'echo hi', timeout: 10 },
      intent: 'Running echo',
    })
    expect(start).toEqual([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_1|fc_9',
        title: '$ echo hi',
        name: 'bash',
        kind: 'execute',
        status: 'pending',
        rawInput: { command: 'echo hi', timeout: 10 },
        content: [{ type: 'content', content: { type: 'text', text: '$ echo hi' } }],
      },
    ])
    const partial = { content: [{ type: 'text', text: 'hi\n' }], details: {} }
    expect(
      projector.project({
        type: 'tool_execution_update',
        toolCallId: 'call_1|fc_9',
        toolName: 'bash',
        args: { command: 'echo hi', timeout: 10 },
        partialResult: partial,
      }),
    ).toEqual([
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_1|fc_9',
        name: 'bash',
        status: 'in_progress',
        rawOutput: partial,
        // ACP emits the raw block and, because the trimmed fallback differs by the trailing newline, the trimmed text too.
        content: [
          { type: 'content', content: { type: 'text', text: '$ echo hi' } },
          { type: 'content', content: { type: 'text', text: 'hi\n' } },
          { type: 'content', content: { type: 'text', text: 'hi' } },
        ],
      },
    ])
    const result = { content: [{ type: 'text', text: 'hi\n' }], details: { wallTimeMs: 3 } }
    expect(
      projector.project({ type: 'tool_execution_end', toolCallId: 'call_1|fc_9', toolName: 'bash', result, isError: false }),
    ).toEqual([
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_1|fc_9',
        name: 'bash',
        status: 'completed',
        rawOutput: result,
        content: [
          { type: 'content', content: { type: 'text', text: '$ echo hi' } },
          { type: 'content', content: { type: 'text', text: 'hi\n' } },
          { type: 'content', content: { type: 'text', text: 'hi' } },
        ],
      },
    ])
  })

  it('marks a failed result as failed and keeps the error text', () => {
    const projector = newProjector()
    projector.project({ type: 'tool_execution_start', toolCallId: 't', toolName: 'bash', args: { command: 'false' } })
    const [update] = projector.project({
      type: 'tool_execution_end',
      toolCallId: 't',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'exit 1' }] },
      isError: true,
    })
    expect(update).toMatchObject({ sessionUpdate: 'tool_call_update', status: 'failed' })
  })

  it('settles a call from the finished background-job frame of a tool_execution_update', () => {
    const projector = newProjector()
    const [done] = projector.project({
      type: 'tool_execution_update',
      toolCallId: 't',
      toolName: 'bash',
      args: { command: 'sleep 1' },
      partialResult: { content: [], details: { async: { state: 'completed' } } },
    })
    expect(done).toMatchObject({ status: 'completed' })
    const [failed] = projector.project({
      type: 'tool_execution_update',
      toolCallId: 't',
      toolName: 'bash',
      args: { command: 'sleep 1' },
      partialResult: { content: [], details: { async: { state: 'cancelled' } } },
    })
    expect(failed).toMatchObject({ status: 'failed' })
  })

  it('publishes a read location only for an existing regular file, selectors stripped', () => {
    const projector = newProjector(['/work/src/a.ts'])
    const [plain] = projector.project({
      type: 'tool_execution_start',
      toolCallId: 'r1',
      toolName: 'read',
      args: { path: 'src/a.ts' },
    })
    expect(plain).toMatchObject({ kind: 'read', title: 'read: src/a.ts', locations: [{ path: '/work/src/a.ts' }] })
    const [ranged] = projector.project({
      type: 'tool_execution_start',
      toolCallId: 'r2',
      toolName: 'read',
      args: { path: 'src/a.ts:10-20' },
    })
    expect(ranged).toMatchObject({ locations: [{ path: '/work/src/a.ts' }] })
    const [missing] = projector.project({
      type: 'tool_execution_start',
      toolCallId: 'r3',
      toolName: 'read',
      args: { path: 'src/gone.ts' },
    })
    expect(missing).not.toHaveProperty('locations')
    const [internal] = projector.project({
      type: 'tool_execution_start',
      toolCallId: 'r4',
      toolName: 'read',
      args: { path: 'skill://react' },
    })
    expect(internal).toMatchObject({ title: 'skill://react' })
    expect(internal).not.toHaveProperty('locations')
  })

  it('locates edit/write targets (absolute, home-relative) and carries diff content from the result', () => {
    const projector = newProjector()
    const [start] = projector.project({
      type: 'tool_execution_start',
      toolCallId: 'e1',
      toolName: 'edit',
      args: { path: '~/notes.md' },
    })
    expect(start).toMatchObject({ kind: 'edit', locations: [{ path: '/home/u/notes.md' }] })
    const [update] = projector.project({
      type: 'tool_execution_end',
      toolCallId: 'e1',
      toolName: 'edit',
      result: {
        content: [{ type: 'text', text: 'Updated notes.md' }],
        details: { path: '/home/u/notes.md', oldText: 'a', newText: 'b', diff: '-a\n+b' },
      },
      isError: false,
    })
    expect(update).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'e1',
      name: 'edit',
      status: 'completed',
      rawOutput: {
        content: [{ type: 'text', text: 'Updated notes.md' }],
        details: { path: '/home/u/notes.md', oldText: 'a', newText: 'b', diff: '-a\n+b' },
      },
      content: [
        { type: 'diff', path: '/home/u/notes.md', oldText: 'a', newText: 'b' },
        { type: 'content', content: { type: 'text', text: 'Updated notes.md' } },
      ],
      locations: [{ path: '/home/u/notes.md' }],
    })
  })

  it('emits one diff per file of a multi-file edit and skips failed entries', () => {
    const projector = newProjector()
    projector.project({ type: 'tool_execution_start', toolCallId: 'm', toolName: 'edit', args: {} })
    const [update] = projector.project({
      type: 'tool_execution_end',
      toolCallId: 'm',
      toolName: 'edit',
      result: {
        content: [{ type: 'text', text: 'ok' }],
        details: {
          perFileResults: [
            { path: '/w/a.ts', oldText: 'x', newText: 'y' },
            { path: '/w/b.ts', newText: 'new file' },
            { path: '/w/c.ts', oldText: 'p', newText: 'q', isError: true },
          ],
        },
      },
    })
    expect(update).toMatchObject({
      content: [
        { type: 'diff', path: '/w/a.ts', oldText: 'x', newText: 'y' },
        { type: 'diff', path: '/w/b.ts', oldText: null, newText: 'new file' },
        { type: 'content', content: { type: 'text', text: 'ok' } },
      ],
      locations: [{ path: '/w/a.ts' }, { path: '/w/b.ts' }, { path: '/w/c.ts' }],
    })
  })

  it('keeps peer messages off the stream and shows device writes as executions', () => {
    const projector = newProjector()
    expect(
      projector.project({ type: 'tool_execution_start', toolCallId: 'a', toolName: 'write', args: { path: 'agent://peer' } }),
    ).toEqual([])
    expect(
      projector.project({
        type: 'tool_execution_end',
        toolCallId: 'a',
        toolName: 'write',
        args: { path: 'agent://peer' },
        result: { content: [] },
      }),
    ).toEqual([])
    const [device] = projector.project({
      type: 'tool_execution_start',
      toolCallId: 'x',
      toolName: 'write',
      args: { path: 'xd://github', content: '{}' },
    })
    expect(device).toMatchObject({ kind: 'execute', title: 'xd://github' })
    expect(device).not.toHaveProperty('locations')
  })

  it('turns a finished todo call into an ACP plan with the mapper status table', () => {
    const projector = newProjector()
    projector.project({ type: 'tool_execution_start', toolCallId: 'td', toolName: 'todo', args: {} })
    const updates = projector.project({
      type: 'tool_execution_end',
      toolCallId: 'td',
      toolName: 'todo',
      result: {
        content: [{ type: 'text', text: 'ok' }],
        details: {
          phases: [
            {
              name: 'p1',
              tasks: [
                { content: 'one', status: 'completed' },
                { content: 'two', status: 'in_progress' },
                { content: 'three', status: 'blocked' },
                { content: 'four', status: 'abandoned' },
                { content: 'five' },
              ],
            },
          ],
        },
      },
    })
    expect(updates).toHaveLength(2)
    expect(updates[1]).toEqual({
      sessionUpdate: 'plan',
      entries: [
        { content: 'one', priority: 'medium', status: 'completed' },
        { content: 'two', priority: 'medium', status: 'in_progress' },
        { content: 'three', priority: 'medium', status: 'pending' },
        { content: 'four', priority: 'medium', status: 'completed' },
        { content: 'five', priority: 'medium', status: 'pending' },
      ],
    })
    expect(projector.project({ type: 'todo_auto_clear' })).toEqual([{ sessionUpdate: 'plan', entries: [] }])
    expect(projector.project({ type: 'todo_reminder', todos: [{ content: 'later', status: 'pending' }] })).toEqual([
      { sessionUpdate: 'plan', entries: [{ content: 'later', priority: 'medium', status: 'pending' }] },
    ])
  })

  it('streams thought and text with one messageId per assistant message and no duplicate final text', () => {
    const projector = newProjector()
    expect(projector.project(assistantFrame('message_start'))).toEqual([])
    expect(
      projector.project(assistantFrame('message_update', { assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } })),
    ).toEqual([])
    expect(
      projector.project(
        assistantFrame('message_update', {
          assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Let me ' },
        }),
      ),
    ).toEqual([{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Let me ' }, messageId: 'uuid-1' }])
    expect(
      projector.project(
        assistantFrame('message_update', { assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'Hello' } }),
      ),
    ).toEqual([{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' }, messageId: 'uuid-1' }])
    // `done` after streamed text, and message_end after streamed text: nothing is repeated.
    expect(
      projector.project(
        assistantFrame('message_update', {
          assistantMessageEvent: { type: 'done', message: { content: [{ type: 'text', text: 'Hello' }] } },
        }),
      ),
    ).toEqual([])
    expect(
      projector.project({
        type: 'message_end',
        messageId: 'msg-2',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
      }),
    ).toEqual([])
    // The next assistant message gets a fresh id.
    projector.project(assistantFrame('message_start', { messageId: 'msg-4' }))
    expect(
      projector.project(
        assistantFrame('message_update', {
          messageId: 'msg-4',
          assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Again' },
        }),
      ),
    ).toEqual([{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Again' }, messageId: 'uuid-2' }])
  })

  it('drops thinking deltas that are only dots/whitespace so far, then emits from the first real text on', () => {
    const projector = newProjector()
    projector.project(assistantFrame('message_start'))
    projector.project(assistantFrame('message_update', { assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } }))
    const delta = (text: string): ReturnType<OmpEventProjector['project']> =>
      projector.project(
        assistantFrame('message_update', { assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: text } }),
      )
    expect(delta('  ')).toEqual([])
    expect(delta('...')).toEqual([])
    expect(delta('Plan')).toEqual([
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Plan' }, messageId: 'uuid-1' },
    ])
  })

  it('surfaces the text of a message that never streamed any, and a narration block as the reply', () => {
    const projector = newProjector()
    projector.project(assistantFrame('message_start'))
    expect(
      projector.project({
        type: 'message_end',
        messageId: 'msg-2',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Only at the end' }] },
      }),
    ).toEqual([{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Only at the end' }, messageId: 'uuid-1' }])

    projector.project(assistantFrame('message_start', { messageId: 'msg-4' }))
    expect(
      projector.project({
        type: 'message_end',
        messageId: 'msg-4',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'Checking the repo first.', narration: true }, { type: 'toolCall', name: 'read' }],
        },
      }),
    ).toEqual([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Checking the repo first.' }, messageId: 'uuid-2' },
    ])
  })

  it('reports a streamed provider error as text and does not repeat it at the end of the turn', () => {
    const projector = newProjector()
    projector.project(assistantFrame('message_start'))
    expect(
      projector.project(
        assistantFrame('message_update', {
          assistantMessageEvent: { type: 'error', error: { errorMessage: '429 rate limited' } },
        }),
      ),
    ).toEqual([{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '429 rate limited' }, messageId: 'uuid-1' }])
    expect(projector.flushTurnError({ assistantError: '429 rate limited' })).toEqual([])
  })

  it('flushes a provider failure that never streamed a message, once', () => {
    const projector = newProjector()
    const updates = projector.flushTurnError({ assistantError: '410 model_sunset', promptError: 'other' })
    expect(updates).toEqual([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '410 model_sunset' }, messageId: 'uuid-1' },
    ])
    expect(projector.flushTurnError({ assistantError: '410 model_sunset' })).toEqual([])
    expect(newProjector().flushTurnError({})).toEqual([])
  })

  it('projects image output and slash-command output as message chunks', () => {
    const projector = newProjector()
    projector.project(assistantFrame('message_start'))
    const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' }
    expect(
      projector.project(assistantFrame('message_update', { assistantMessageEvent: { type: 'image_end', content: image } })),
    ).toEqual([{ sessionUpdate: 'agent_message_chunk', content: image, messageId: 'uuid-1' }])
    expect(projector.project({ type: 'command_output', text: 'Model set' })).toEqual([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Model set' }, messageId: 'uuid-2' },
    ])
  })

  it('strips terminal escapes from slash-command output', () => {
    const projector = newProjector()
    const colored = '\u001B[38;5;243m░░\u001B[39m 6%\n\u001B]8;;https://example.test\u0007link\u001B]8;;\u0007\u001B[2K'
    expect(projector.project({ type: 'command_output', text: colored })).toEqual([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '░░ 6%\nlink' }, messageId: 'uuid-1' },
    ])
    expect(projector.project({ type: 'command_output', text: '\u001B[0m' })).toEqual([])
  })

  it('surfaces vendor notices as one-line thoughts and keeps routine ones out', () => {
    const cases: Array<[Json, string | undefined]> = [
      [
        { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: '429 rate limited' },
        'OMP retry 1/3 in 2000ms: 429 rate limited',
      ],
      [{ type: 'auto_retry_end', success: true, attempt: 1 }, undefined],
      [
        { type: 'auto_retry_end', success: false, attempt: 3, finalError: 'overloaded' },
        'OMP retry failed: overloaded',
      ],
      [
        { type: 'retry_fallback_applied', from: 'a/m1', to: 'b/m2', role: 'default', reason: '429' },
        'OMP switched model a/m1 → b/m2 (429)',
      ],
      [
        { type: 'retry_fallback_succeeded', model: 'b/m2', role: 'default' },
        'OMP continued on the fallback model b/m2',
      ],
      [
        { type: 'auto_compaction_start', reason: 'threshold', action: 'context-full' },
        'OMP is compacting the context window',
      ],
      [
        { type: 'auto_compaction_end', action: 'context-full', aborted: false, willRetry: false },
        'OMP finished compacting the context window',
      ],
      [
        { type: 'auto_compaction_end', action: 'context-full', aborted: false, willRetry: false, skipped: true },
        undefined,
      ],
      [
        { type: 'auto_compaction_end', action: 'context-full', aborted: true, willRetry: false },
        'OMP context compaction was cancelled',
      ],
      [
        {
          type: 'auto_compaction_end',
          action: 'context-full',
          aborted: false,
          willRetry: false,
          errorMessage: 'too small',
        },
        'OMP context compaction failed: too small',
      ],
      [
        { type: 'extension_error', extensionPath: '/x/ext.js', event: 'tool_call', error: 'boom' },
        'OMP extension error (/x/ext.js / tool_call): boom',
      ],
      [{ type: 'notice', level: 'warning', message: 'careful', source: 'compaction' }, 'warning: careful'],
      [{ type: 'notice', level: 'info', message: 'fyi' }, undefined],
      [{ type: 'notice', level: 'error', message: 'Could not save /btw history', source: 'btw-history' }, undefined],
      [
        { type: 'extension_ui_request', id: 'u1', method: 'notify', message: 'picked beta', notifyType: 'info' },
        'picked beta',
      ],
      [
        { type: 'extension_ui_request', id: 'u2', method: 'notify', message: 'low disk', notifyType: 'warning' },
        'warning: low disk',
      ],
      [
        {
          type: 'extension_ui_request',
          id: 'u3',
          method: 'open_url',
          url: 'https://a.test/login',
          launchUrl: 'https://a.test/go',
          instructions: 'Sign in',
        },
        'OMP asks you to open https://a.test/go: Sign in',
      ],
      [{ type: 'extension_ui_request', id: 'u4', method: 'setStatus', statusKey: 'k', statusText: 'busy' }, undefined],
    ]
    for (const [frame, expected] of cases) {
      const updates = newProjector().project(frame)
      if (expected === undefined) expect(updates, JSON.stringify(frame)).toEqual([])
      else {
        expect(updates).toEqual([
          { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: expected }, messageId: 'uuid-1' },
        ])
      }
    }
  })

  it('finds the open call an approval dialog is about', () => {
    const projector = newProjector()
    projector.project({ type: 'tool_execution_start', toolCallId: 'b1', toolName: 'bash', args: { command: 'ls' } })
    projector.project({ type: 'tool_execution_start', toolCallId: 'w1', toolName: 'write', args: { path: 'a.txt' } })
    expect(projector.findOpenToolCall('bash')?.toolCallId).toBe('b1')
    expect(projector.findOpenToolCall()?.toolCallId).toBe('w1')
    projector.project({ type: 'tool_execution_end', toolCallId: 'w1', toolName: 'write', result: { content: [] } })
    expect(projector.findOpenToolCall()?.toolCallId).toBe('b1')
    expect(projector.findOpenToolCall('read')?.toolCallId).toBe('b1')
  })
})

// ---------------------------------------------------------------------------
// Session files
// ---------------------------------------------------------------------------

const tempRoots: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

afterAll(async () => {
  for (const dir of tempRoots.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

function sessionHeader(id: string, cwd: string): string {
  return [
    JSON.stringify({ type: 'title', v: 1, title: '', updatedAt: '2026-10-26T06:00:00.000Z', pad: ' '.repeat(120) }),
    JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-10-26T06:00:00.000Z', cwd }),
  ].join('\n')
}

describe('OMP session files', () => {
  it('reads the session header after the padded title record', async () => {
    const dir = await tempDir('omp-session-header-')
    const file = join(dir, '2026-10-26T06-00-00-000Z_abc.jsonl')
    await writeFile(file, `${sessionHeader('abc', '/work')}\n{"type":"thinking_level_change"}\n`)
    expect(await readOmpSessionHeader(file)).toEqual({ id: 'abc', cwd: '/work' })
    expect(await readOmpSessionHeader(join(dir, 'missing.jsonl'))).toBeUndefined()
    await writeFile(join(dir, 'junk.jsonl'), 'not json\n')
    expect(await readOmpSessionHeader(join(dir, 'junk.jsonl'))).toBeUndefined()
  })

  it('finds a stored session by id: the cwd bucket first, then every other bucket', async () => {
    const root = await tempDir('omp-sessions-')
    const sessions = join(root, 'agent', 'sessions')
    const local = join(sessions, '-work-here')
    const other = join(sessions, '-work-elsewhere')
    await mkdir(local, { recursive: true })
    await mkdir(other, { recursive: true })
    const bootFile = join(local, '2026-10-26T06-00-00-000Z_boot.jsonl')
    const localFile = join(local, '2026-10-25T06-00-00-000Z_local-id.jsonl')
    const otherFile = join(other, '2026-10-24T06-00-00-000Z_other-id.jsonl')
    await writeFile(localFile, sessionHeader('local-id', '/work/here'))
    await writeFile(otherFile, sessionHeader('other-id', '/work/elsewhere'))
    expect(await findOmpSessionFile({ sessionId: 'local-id', referenceFile: bootFile })).toBe(localFile)
    expect(await findOmpSessionFile({ sessionId: 'other-id', referenceFile: bootFile })).toBe(otherFile)
    expect(await findOmpSessionFile({ sessionId: 'nope', referenceFile: bootFile })).toBeUndefined()
    expect(await findOmpSessionFile({ sessionId: '', referenceFile: bootFile })).toBeUndefined()
    // A partial id never matches: ACP resolves exact ids.
    expect(await findOmpSessionFile({ sessionId: 'local', referenceFile: bootFile })).toBeUndefined()
  })

  it('falls back to the header of a legacy-named file and honors an extra sessions root', async () => {
    const root = await tempDir('omp-sessions-legacy-')
    const local = join(root, 'a', 'sessions', '-local')
    const legacyDir = join(root, 'a', 'sessions', '-legacy')
    const extraRoot = join(root, 'custom-agent', 'sessions')
    const extraBucket = join(extraRoot, '-extra')
    for (const dir of [local, legacyDir, extraBucket]) await mkdir(dir, { recursive: true })
    const legacy = join(legacyDir, '2025-01-01T00-00-00-000Z.jsonl')
    const extra = join(extraBucket, '2026-01-01T00-00-00-000Z_extra-id.jsonl')
    await writeFile(legacy, sessionHeader('legacy-id', '/old'))
    await writeFile(extra, sessionHeader('extra-id', '/x'))
    const bootFile = join(local, '2026-10-26T06-00-00-000Z_boot.jsonl')
    expect(await findOmpSessionFile({ sessionId: 'legacy-id', referenceFile: bootFile })).toBe(legacy)
    // The boot bucket is not under a `sessions` directory, so only the extra root reaches the file.
    const flatBoot = join(root, 'flat', '2026-10-26T06-00-00-000Z_boot.jsonl')
    expect(await findOmpSessionFile({ sessionId: 'extra-id', referenceFile: flatBoot })).toBeUndefined()
    expect(await findOmpSessionFile({ sessionId: 'extra-id', referenceFile: flatBoot, extraRoots: [extraRoot] })).toBe(extra)
  })

  it('reads the newest thinking selector from the end of a large transcript', async () => {
    const dir = await tempDir('omp-session-thinking-')
    const file = join(dir, 's.jsonl')
    const lines = [
      sessionHeader('t', '/w'),
      JSON.stringify({ type: 'thinking_level_change', thinkingLevel: 'high', configured: 'high' }),
      JSON.stringify({ type: 'thinking_level_change', thinkingLevel: 'low', configured: 'auto' }),
      ...Array.from({ length: 1200 }, (_, index) => JSON.stringify({ type: 'message', index, pad: 'y'.repeat(150) })),
    ]
    await writeFile(file, `${lines.join('\n')}\n`)
    expect((await stat(file)).size).toBeGreaterThan(65_536)
    expect(await readOmpSessionThinking(file)).toEqual({ configured: 'auto', level: 'low' })
    // A scan budget that does not reach the entry finds nothing instead of guessing.
    expect(await readOmpSessionThinking(file, 4_096)).toBeUndefined()
    expect(await readOmpSessionThinking(join(dir, 'missing.jsonl'))).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 1b. Goals and rewind: command lines, records, plans (the file system is injected, or a temp dir)
// ---------------------------------------------------------------------------

describe('createOmpConfigOverlay', () => {
  it('writes the overlay that adds rpc to the goal continuation modes into a private directory of its own', async () => {
    const root = await tempDir('omp-overlay-')
    const first = await createOmpConfigOverlay(root)
    const second = await createOmpConfigOverlay(root)
    expect(dirname(first.file).startsWith(root)).toBe(true)
    expect(dirname(first.file)).not.toBe(dirname(second.file))
    const content = await readFile(first.file, 'utf8')
    // omp reads this strictly (a YAML mapping), and `interactive` stays as in omp's own default.
    expect(content).toMatch(/^goal:\n {2}continuationModes: \[(?=[^\]]*\binteractive\b)(?=[^\]]*\brpc\b)[^\]]*\]\n$/)
    if (process.platform !== 'win32') {
      expect((await stat(dirname(first.file))).mode & 0o777).toBe(0o700)
      expect((await stat(first.file)).mode & 0o777).toBe(0o600)
    }
  })

  it('creates the root when it is missing and removes only its own directory', async () => {
    const root = join(await tempDir('omp-overlay-'), 'not', 'yet')
    const overlay = await createOmpConfigOverlay(root)
    const other = await createOmpConfigOverlay(root)
    expect(existsSync(overlay.file)).toBe(true)
    await overlay.remove()
    expect(existsSync(dirname(overlay.file))).toBe(false)
    expect(existsSync(other.file)).toBe(true)
    // Removing twice is not an error.
    await overlay.remove()
  })
})

describe('parseGoalArgs', () => {
  it("reads omp's own control words and takes anything else as the objective", () => {
    expect(parseGoalArgs('')).toEqual({ action: 'show' })
    expect(parseGoalArgs('  Status ')).toEqual({ action: 'show' })
    expect(parseGoalArgs('CLEAR')).toEqual({ action: 'clear' })
    expect(parseGoalArgs('drop')).toEqual({ action: 'clear' })
    expect(parseGoalArgs('pause')).toEqual({ action: 'pause' })
    expect(parseGoalArgs('Resume')).toEqual({ action: 'resume' })
    expect(parseGoalArgs('make the tests pass')).toEqual({ action: 'set', objective: 'make the tests pass' })
    expect(parseGoalArgs('set fix the build\nthen deploy')).toEqual({ action: 'set', objective: 'fix the build\nthen deploy' })
  })

  it('refuses a control word followed by more words instead of acting on it', () => {
    // omp's terminal ignores the rest, which would pause the goal for "pause the deployment pipeline".
    for (const line of ['pause the deployment pipeline', 'clear everything up', 'show me', 'resume work on x']) {
      expect(parseGoalArgs(line), line).toMatchObject({ action: 'usage' })
    }
    expect(parseGoalArgs('set')).toMatchObject({ action: 'usage' })
    expect(parseGoalArgs('budget 50k')).toMatchObject({ action: 'usage' })
  })
})

describe('goal records and notes', () => {
  const parsed = (extra: Json = {}): OmpGoal => {
    const goal = parseOmpGoal({ id: 'g1', objective: 'ship it', status: 'active', tokensUsed: 10, timeUsedSeconds: 3, ...extra })
    if (goal === undefined) throw new Error('the goal did not parse')
    return goal
  }

  it('reads a goal of omp and rejects anything without an objective and a status', () => {
    expect(parsed({ tokenBudget: 50_000 })).toMatchObject({ objective: 'ship it', status: 'active', tokenBudget: 50_000, tokensUsed: 10, timeUsedSeconds: 3 })
    expect(parsed({ tokenBudget: 0, tokensUsed: -5 })).toMatchObject({ tokenBudget: undefined, tokensUsed: 0 })
    expect(parseOmpGoal(null)).toBeUndefined()
    expect(parseOmpGoal({ objective: 'x' })).toBeUndefined()
  })

  it('notes a new goal and a new status, never the token counters that move with every turn', () => {
    const active = parsed()
    expect(goalNote(undefined, active)).toContain('ship it')
    expect(goalNote(active, parsed({ tokensUsed: 5_000, timeUsedSeconds: 90 }))).toBeUndefined()
    expect(goalNote(active, parsed({ status: 'paused' }))).toContain('paused')
    expect(goalNote(active, parsed({ status: 'complete' }))).toContain('complete')
    expect(goalNote(active, parsed({ id: 'g2', objective: 'another' }))).toContain('another')
    // A goal that was already finished when the session opened is no news; a goal that is gone is.
    expect(goalNote(undefined, parsed({ status: 'complete' }))).toBeUndefined()
    expect(goalNote(active, undefined)).toBeDefined()
    expect(goalNote(undefined, undefined)).toBeUndefined()
  })

  it('keeps a long or multi-line objective to one line in a note and to a quotation in a reply', () => {
    const long = parsed({ objective: `first line\n${'word '.repeat(80)}` })
    const note = goalNote(undefined, long) ?? ''
    expect(note).not.toContain('\n')
    expect(note.length).toBeLessThan(260)
    expect(formatGoal(long).split('\n').filter((line) => line.startsWith('> '))).toHaveLength(2)
  })

  it('shows what the goal used against its budget', () => {
    expect(formatGoal(parsed({ tokenBudget: 50_000, tokensUsed: 12_345, timeUsedSeconds: 250 }))).toContain('12.3K / 50K tokens · 4m')
  })

  it('turns the refusals of omp into what the user can do about them', () => {
    expect(goalFailure('Goal mode is disabled (goal.enabled).')).toContain('goal.enabled')
    expect(goalFailure('A goal is already active. Drop it before creating another.')).toContain('/goal clear')
    expect(goalFailure('Resume or drop the paused goal before creating another.')).toContain('/goal clear')
    expect(goalFailure('something else')).toContain('something else')
  })
})

const STAMP = '2026-10-28T10:00:00.000Z'

/** The entries of a session as `get_entries` reports them. */
const entryUser = (id: string, parentId: string | null, content: string | Json[] = id): Json => ({
  type: 'message',
  id,
  parentId,
  timestamp: STAMP,
  message: { role: 'user', content: typeof content === 'string' ? [{ type: 'text', text: content }] : content },
})
const entryCall = (id: string, parentId: string, callId: string, name: string, args: Json = {}): Json => ({
  type: 'message',
  id,
  parentId,
  timestamp: STAMP,
  message: { role: 'assistant', content: [{ type: 'toolCall', id: callId, name, arguments: args }] },
})
const entryResult = (id: string, parentId: string, callId: string, toolName: string, details: Json, isError = false): Json => ({
  type: 'message',
  id,
  parentId,
  timestamp: STAMP,
  message: { role: 'toolResult', toolCallId: callId, toolName, content: [], details, isError },
})

describe('readRewindModel', () => {
  it('lists the user messages on the path to the leaf, in order, and leaves other branches and empty messages out', () => {
    const entries = [
      { type: 'model_change', id: 'm0', parentId: null },
      entryUser('u1', 'm0', 'first task'),
      entryUser('u2', 'u1', 'second task'),
      entryUser('side', 'u1', 'a branch that was left'),
      entryUser('u3', 'u2', [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }]),
      entryUser('u4', 'u3', 'fourth'),
    ]
    const labels = (leafId: string | null | undefined): string[][] =>
      readRewindModel({ entries, leafId, cwd: '/w' }).checkpoints.map((checkpoint) => [checkpoint.entryId, checkpoint.label])
    expect(labels('u4')).toEqual([['u1', 'first task'], ['u2', 'second task'], ['u4', 'fourth']])
    expect(labels('side')).toEqual([['u1', 'first task'], ['side', 'a branch that was left']])
    // An empty session has no leaf; a leaf the answer did not name is the newest entry.
    expect(labels(null)).toEqual([])
    expect(labels(undefined)).toEqual(labels('u4'))
  })

  it('records edits with the file before and after, the files of a multi-file edit, and skips failed ones', () => {
    const entries = [
      entryUser('u1', null, 'edit things'),
      entryResult('r1', 'u1', 'c1', 'edit', { op: 'update', path: '/w/a.txt', oldText: 'a\n', newText: 'A\n' }),
      entryResult('r2', 'r1', 'c2', 'edit', {
        perFileResults: [
          { op: 'update', path: 'b.txt', oldText: 'b', newText: 'B' },
          { op: 'create', path: '/w/c.txt', newText: 'c' },
          { op: 'delete', path: '/w/d.txt', oldText: 'd' },
        ],
      }),
      entryResult('r3', 'r2', 'c3', 'edit', { op: 'update', path: '/w/e.txt', oldText: 'e', newText: 'E' }, true),
    ]
    expect(readRewindModel({ entries, leafId: 'r3', cwd: '/w' }).changes).toEqual([
      { kind: 'set', index: 1, path: '/w/a.txt', before: 'a\n', after: 'A\n' },
      { kind: 'set', index: 2, path: '/w/b.txt', before: 'b', after: 'B' },
      { kind: 'set', index: 2, path: '/w/c.txt', before: null, after: 'c' },
      { kind: 'set', index: 2, path: '/w/d.txt', before: 'd', after: null },
    ])
  })

  it('marks the changes the records cannot reverse, and ignores what is not a file of the workspace', () => {
    const entries = [
      entryUser('u1', null, 'go'),
      entryCall('a1', 'u1', 'w1', 'write', { path: 'notes.md' }),
      entryResult('r1', 'a1', 'w1', 'write', { resolvedPath: '/w/notes.md' }),
      entryCall('a2', 'r1', 'w2', 'write', { path: 'xd://resolve' }),
      entryResult('r2', 'a2', 'w2', 'write', { resolvedPath: '/w/xd:/resolve' }),
      entryResult('r3', 'r2', 'c3', 'edit', { op: 'update', path: '/w/new.txt', move: '/w/moved.txt', sourcePath: '/w/old.txt' }),
      entryResult('r4', 'r3', 'c4', 'ast_edit', { applied: true, files: ['code.ts'] }),
      entryResult('r5', 'r4', 'c5', 'ast_edit', { applied: false, files: ['staged.ts'] }),
      entryResult('r6', 'r5', 'c6', 'edit', { op: 'update', path: '/w/big.txt', snapshotsPruned: true }),
    ]
    const { changes } = readRewindModel({ entries, leafId: 'r6', cwd: '/w' })
    expect(changes.every((change) => change.kind === 'opaque')).toBe(true)
    expect(changes.map((change) => change.path).sort()).toEqual(
      ['/w/big.txt', '/w/code.ts', '/w/moved.txt', '/w/new.txt', '/w/notes.md', '/w/old.txt'],
    )
  })

  it('counts the calls whose effects on files omp does not record', () => {
    const entries = [
      entryUser('u1', null, 'go'),
      entryResult('r1', 'u1', 'c1', 'bash', {}),
      { type: 'message', id: 'b1', parentId: 'r1', message: { role: 'bashExecution', command: 'ls' } },
      entryResult('r2', 'b1', 'c2', 'mcp__docs__fetch', {}),
      entryResult('r3', 'r2', 'c3', 'read', {}),
    ]
    expect(readRewindModel({ entries, leafId: 'r3', cwd: '/w' }).unrecorded).toEqual([
      { index: 1, tool: 'bash' },
      { index: 2, tool: 'bash' },
      { index: 3, tool: 'mcp__docs__fetch' },
    ])
  })
})

describe('findCheckpoint and parseRewindArgs', () => {
  const checkpoints: OmpCheckpoint[] = ['first', 'second', 'third'].map((entryId, index) => ({ entryId, label: entryId, at: STAMP, index }))

  it('finds a message by its number in the list, with or without the hash, and nothing else', () => {
    expect(findCheckpoint(checkpoints, '2')).toMatchObject({ position: 2, checkpoint: { entryId: 'second' } })
    expect(findCheckpoint(checkpoints, ' #3 ')).toMatchObject({ position: 3, checkpoint: { entryId: 'third' } })
    for (const reference of ['0', '4', 'second', '2x', '-1', '']) {
      expect(findCheckpoint(checkpoints, reference), reference).toHaveProperty('error')
    }
  })

  it('reads the number, the half to roll back and the confirmation in any order after the number', () => {
    expect(parseRewindArgs('')).toEqual({ action: 'list' })
    expect(parseRewindArgs('3')).toEqual({ action: 'preview', reference: '3', mode: 'both' })
    expect(parseRewindArgs('3 confirm')).toEqual({ action: 'apply', reference: '3', mode: 'both' })
    expect(parseRewindArgs('3 code confirm')).toEqual({ action: 'apply', reference: '3', mode: 'code' })
    expect(parseRewindArgs('3 CONFIRM chat')).toEqual({ action: 'apply', reference: '3', mode: 'chat' })
    expect(parseRewindArgs('3 chat')).toEqual({ action: 'preview', reference: '3', mode: 'chat' })
    for (const line of ['confirm', 'code 3', '3 code chat', '3 bogus']) {
      expect(parseRewindArgs(line), line).toMatchObject({ action: 'usage' })
    }
  })
})

/** A file system in memory; a file the test did not put there is absent. */
function memoryIo(initial: Record<string, DiskFile>): RestoreIo & { readonly disk: Map<string, DiskFile> } {
  const disk = new Map(Object.entries(initial))
  return {
    disk,
    read: async (path) => disk.get(path) ?? { kind: 'absent' },
    write: async (path, content) => {
      disk.set(path, { kind: 'text', content })
    },
    remove: async (path) => {
      disk.set(path, { kind: 'absent' })
    },
  }
}
const textFile = (content: string): DiskFile => ({ kind: 'text', content })
const setChange = (index: number, path: string, before: string | null, after: string | null): OmpFileChange => ({ kind: 'set', index, path, before, after })

describe('planRestore', () => {
  it('undoes the edits of a file newest first, checking each step against the state the previous one left', async () => {
    const io = memoryIo({ '/w/a.txt': textFile('three\n') })
    const plan = await planRestore([setChange(1, '/w/a.txt', 'one\n', 'two\n'), setChange(2, '/w/a.txt', 'two\n', 'three\n')], io)
    expect(plan.conflicts).toEqual([])
    expect(plan.files).toEqual([{ path: '/w/a.txt', action: 'write', content: 'one\n', insertions: 1, deletions: 1 }])
  })

  it('deletes a file the agent created and brings back one it deleted', async () => {
    const io = memoryIo({ '/w/new.txt': textFile('made\n') })
    const plan = await planRestore([setChange(1, '/w/new.txt', null, 'made\n'), setChange(1, '/w/gone.txt', 'was here\n', null)], io)
    expect(plan.files.map((file) => [file.path, file.action, file.content])).toEqual([
      ['/w/gone.txt', 'create', 'was here\n'],
      ['/w/new.txt', 'delete', undefined],
    ])
  })

  it('leaves a file alone that something else changed after the agent did', async () => {
    const io = memoryIo({ '/w/a.txt': textFile('edited by hand\n') })
    const plan = await planRestore([setChange(1, '/w/a.txt', 'one\n', 'two\n')], io)
    expect(plan.files).toEqual([])
    expect(plan.conflicts.map((conflict) => conflict.path)).toEqual(['/w/a.txt'])
  })

  it('refuses a chain with a gap: something changed the file between two of the agent edits', async () => {
    const io = memoryIo({ '/w/a.txt': textFile('C\n') })
    const plan = await planRestore([setChange(1, '/w/a.txt', 'A\n', 'B\n'), setChange(2, '/w/a.txt', 'B2\n', 'C\n')], io)
    expect(plan.files).toEqual([])
    expect(plan.conflicts.map((conflict) => conflict.path)).toEqual(['/w/a.txt'])
  })

  it('reports a file that is already as it was, and plans nothing for it', async () => {
    const io = memoryIo({ '/w/a.txt': textFile('one\n') })
    const plan = await planRestore([setChange(1, '/w/a.txt', 'one\n', 'two\n')], io)
    expect(plan).toEqual({ files: [], unchanged: ['/w/a.txt'], conflicts: [] })
  })

  it('never plans a file with a change nothing can reverse, nor one it cannot read', async () => {
    const io = memoryIo({ '/w/a.txt': textFile('x'), '/w/bin': { kind: 'unreadable', reason: 'is a binary file' } })
    const plan = await planRestore(
      [
        { kind: 'opaque', index: 1, path: '/w/a.txt', reason: 'was written with `write`' },
        setChange(1, '/w/bin', 'b', 'c'),
      ],
      io,
    )
    expect(plan.files).toEqual([])
    expect(plan.conflicts).toEqual([
      { path: '/w/a.txt', reason: 'was written with `write`' },
      { path: '/w/bin', reason: 'is a binary file' },
    ])
  })
})

describe('applyRestore', () => {
  it('carries out the plan and reports a file it cannot write without stopping the others', async () => {
    const io = memoryIo({ '/w/a.txt': textFile('x'), '/w/b.txt': textFile('y') })
    const failing: RestoreIo = {
      read: io.read,
      remove: io.remove,
      write: async (path, content) => {
        if (path === '/w/a.txt') throw new Error('EACCES')
        await io.write(path, content)
      },
    }
    const plan = await planRestore([setChange(1, '/w/a.txt', 'x0', 'x'), setChange(1, '/w/b.txt', null, 'y')], failing)
    const result = await applyRestore(plan, failing)
    expect(result.restored.map((file) => file.path)).toEqual(['/w/b.txt'])
    expect(result.failed).toEqual([{ path: '/w/a.txt', reason: expect.stringContaining('EACCES') }])
    expect(io.disk.get('/w/b.txt')).toEqual({ kind: 'absent' })
    expect(io.disk.get('/w/a.txt')).toEqual(textFile('x'))
  })
})

describe('nodeRestoreIo', () => {
  it('reads text and absent files, and never touches binary files, links or anything outside its roots', async () => {
    const root = await tempDir('omp-restore-')
    const outside = await tempDir('omp-outside-')
    await writeFile(join(root, 'a.txt'), 'hello\n')
    await writeFile(join(root, 'bin.dat'), Buffer.from([1, 0, 2]))
    await writeFile(join(root, 'latin.txt'), Buffer.from([0xff, 0xfe, 0x41]))
    await writeFile(join(outside, 'secret.txt'), 'secret\n')
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'))
    await symlink(outside, join(root, 'dir-link'))
    await mkdir(join(root, 'sub'))
    const io = nodeRestoreIo([root])
    expect(await io.read(join(root, 'a.txt'))).toEqual({ kind: 'text', content: 'hello\n' })
    expect(await io.read(join(root, 'missing.txt'))).toEqual({ kind: 'absent' })
    for (const refused of [join(root, 'bin.dat'), join(root, 'latin.txt'), join(root, 'sub'), join(root, 'link.txt')]) {
      expect(await io.read(refused), basename(refused)).toMatchObject({ kind: 'unreadable' })
    }
    // Outside the roots: by its own name, through a linked directory, and as a relative path.
    for (const escaped of [join(outside, 'secret.txt'), join(root, 'dir-link', 'secret.txt'), 'relative.txt']) {
      expect(await io.read(escaped), escaped).toMatchObject({ kind: 'unreadable' })
    }
  })

  it('writes through missing directories and removes files', async () => {
    const root = await tempDir('omp-restore-')
    const io = nodeRestoreIo([root])
    const file = join(root, 'deep', 'er', 'f.txt')
    await io.write(file, 'x')
    expect(await readFile(file, 'utf8')).toBe('x')
    await io.remove(file)
    expect(existsSync(file)).toBe(false)
  })
})

describe('rewind rendering', () => {
  const checkpoint = (position: number): OmpCheckpoint => ({ entryId: `e${position}`, label: `message ${position} | with a pipe`, at: STAMP, index: position })

  it('lists the last twenty messages with their number in the whole conversation and keeps a pipe from breaking the table', () => {
    const rows = renderCheckpoints(Array.from({ length: 25 }, (_, index) => checkpoint(index + 1)))
      .split('\n')
      .filter((line) => /^\| \d+ \|/.test(line))
    expect(rows).toHaveLength(20)
    expect(rows[0]).toMatch(/^\| 6 \|/)
    expect(rows.at(-1)).toMatch(/^\| 25 \|/)
    expect(rows[0]).toContain('\\|')
  })

  it('previews the conversation, the files or both, and never speaks of a half it was not asked about', () => {
    const point = { checkpoint: checkpoint(3), position: 3, total: 5, display: (path: string) => path, unrecorded: 2 }
    const plan = {
      files: [{ path: 'a.txt', action: 'write' as const, content: 'x', insertions: 2, deletions: 1 }],
      unchanged: [],
      conflicts: [{ path: 'b.txt', reason: 'is a binary file' }],
    }
    const both = renderRewindPreview({ ...point, mode: 'both', plan })
    expect(both).toContain('**Conversation:**')
    expect(both).toContain('`a.txt`')
    expect(both).toContain('`b.txt`')
    expect(both).toContain('`/rewind 3 confirm`')
    const chat = renderRewindPreview({ ...point, mode: 'chat', plan: undefined })
    expect(chat).toContain('**Conversation:**')
    expect(chat).not.toContain('**Files:**')
    expect(renderRewindPreview({ ...point, mode: 'code', plan })).not.toContain('**Conversation:**')
  })
})

// ---------------------------------------------------------------------------
// 2. The transport against a scripted `omp --mode rpc-ui`
// ---------------------------------------------------------------------------

interface FakeState {
  sessionId: string
  sessionFile: string
  model: Json
  thinkingLevel: string
  thinkingLevels: string[]
  models: Json[]
  contextTokens: number
  contextWindow: number
  cost: number
  /** `get_state` reports these when set; an omp without `/fast` and `/slow` leaves them out. */
  fastModeEnabled?: boolean
  slowModeSupported?: boolean
  slowModeEnabled?: boolean
  /** The goal of the session (`goal` rpc, `get_state.goal`) as omp's `Goal`; `null` or absent for none. */
  goal?: Json | null
  /** Goal mode is off in the configuration: `goal create` and `goal resume` refuse. */
  goalDisabled?: boolean
  /** `get_state.isSettled`: false while omp runs, or is about to run, something by itself. Settled when absent. */
  settled?: boolean
  /** Runs while `get_state` is answered: the frames a test wants in the stream just before the response. */
  onGetState?: (() => void) | undefined
  /** `get_entries`: the session as omp recorded it, root first; `branch` cuts it before the message. */
  entries?: Json[]
  leafId?: string | null
  /** Runs when `branch` is asked, before it changes anything: what the test wants to see of the world at that moment. */
  onBranch?: () => void
}

const fakeModel = (info: OmpModelInfo): Json => ({
  provider: info.provider,
  id: info.id,
  name: info.name,
  reasoning: info.reasoning,
  input: info.input,
})

class FakeRpcError extends Error {}

/** Returned by a handler override that leaves the request open; the test answers later with `FakeOmp.respond`. */
const NO_RESPONSE = Symbol('no response')

/** In-process stand-in for `omp --mode rpc-ui`: JSONL commands in, responses and events out. */
class FakeOmp {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly commands: Json[] = []
  readonly exited: Promise<{ exitCode: number | null; signal: string | null }>
  stdinEnded = false
  terminated = false
  state: FakeState
  private readonly resolveExit: (outcome: { exitCode: number | null; signal: string | null }) => void
  private readonly overrides = new Map<string, (command: Json) => unknown>()
  private buffer = ''
  private sessionCounter = 0

  constructor(bucket: string, options: { sendReady?: boolean } = {}) {
    const exit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>()
    this.exited = exit.promise
    this.resolveExit = exit.resolve
    this.state = {
      sessionId: 'boot-session',
      sessionFile: join(bucket, '2026-10-26T06-00-00-000Z_boot-session.jsonl'),
      model: fakeModel(MODEL_SOL),
      thinkingLevel: 'high',
      thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh'],
      models: [fakeModel(MODEL_OPUS), fakeModel(MODEL_SOL), fakeModel(MODEL_GLM)],
      contextTokens: 14_777,
      contextWindow: 1_000_000,
      cost: 0,
    }
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (chunk: string) => this.read(chunk))
    this.stdin.on('end', () => {
      this.stdinEnded = true
      this.exit(0, null)
    })
    if (options.sendReady !== false) {
      queueMicrotask(() =>
        this.emit({
          type: 'ready',
          protocolVersion: 1,
          supportedProtocolVersions: [1, 2],
          maxFrameBytes: 1_048_576,
          maxReassembledFrameBytes: 67_108_864,
        }),
      )
    }
  }

  asProcess(): NativeProcess {
    return {
      stdin: this.stdin,
      stdout: this.stdout,
      stderr: this.stderr,
      exited: this.exited,
      terminate: () => {
        this.terminated = true
        this.exit(null, 'SIGTERM')
      },
    }
  }

  /** The process dies on its own (crash). */
  crash(code: number): void {
    this.exit(code, null)
  }

  exit(exitCode: number | null, signal: string | null): void {
    this.resolveExit({ exitCode, signal })
    this.stdout.end()
  }

  emit(frame: Json): void {
    if (!this.stdout.writableEnded) this.stdout.write(`${JSON.stringify(frame)}\n`)
  }

  override(type: string, handler: (command: Json) => unknown): void {
    this.overrides.set(type, handler)
  }

  commandsOfType(type: string): Json[] {
    return this.commands.filter((command) => command.type === type)
  }

  /** Answer a request an override left open. */
  respond(id: unknown, command: string, data?: unknown): void {
    this.emit({ id, type: 'response', command, success: true, ...(data === undefined ? {} : { data }) })
  }

  private read(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (line.trim().length > 0) this.dispatch(JSON.parse(line) as Json)
      newline = this.buffer.indexOf('\n')
    }
  }

  private dispatch(command: Json): void {
    this.commands.push(command)
    const type = String(command.type)
    if (type === 'extension_ui_response') return
    let data: unknown
    try {
      const handler = this.overrides.get(type) ?? this.defaultHandler(type)
      data = handler(command)
    } catch (error) {
      this.emit({
        id: command.id,
        type: 'response',
        command: type,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }
    if (data === NO_RESPONSE) return
    this.emit({
      id: command.id,
      type: 'response',
      command: type,
      success: true,
      ...(data === undefined ? {} : { data }),
    })
  }

  /** `goal`: omp's `RpcGoalController`, errors included; every change is announced with `goal_updated` before the response. */
  private goalCommand(command: Json): unknown {
    const state = this.state
    const current = state.goal ?? null
    const reply = (goal: Json | null): unknown => ({
      goal,
      state: goal === null ? null : { enabled: goal.status === 'active', mode: 'active', goal },
    })
    const refuseWhenDisabled = (): void => {
      if (state.goalDisabled === true) throw new FakeRpcError('Goal mode is disabled (goal.enabled).')
    }
    switch (String(command.op)) {
      case 'get':
        return reply(current)
      case 'create': {
        refuseWhenDisabled()
        const objective = typeof command.objective === 'string' ? command.objective.trim() : ''
        if (objective.length === 0) throw new FakeRpcError('objective is required when op=create')
        if (current?.status === 'active') throw new FakeRpcError('A goal is already active. Drop it before creating another.')
        if (current?.status === 'paused') throw new FakeRpcError('Resume or drop the paused goal before creating another.')
        const goal = { id: 'goal-1', objective, status: 'active', tokensUsed: 0, timeUsedSeconds: 0 }
        state.goal = goal
        this.emit({ type: 'goal_updated', goal })
        return reply(goal)
      }
      case 'pause': {
        if (current === null) return reply(null)
        const goal = { ...current, status: current.status === 'active' ? 'paused' : current.status }
        state.goal = goal
        this.emit({ type: 'goal_updated', goal })
        return reply(goal)
      }
      case 'resume': {
        refuseWhenDisabled()
        if (current?.status !== 'paused') throw new FakeRpcError('No paused goal to resume.')
        const goal = { ...current, status: 'active' }
        state.goal = goal
        this.emit({ type: 'goal_updated', goal })
        return reply(goal)
      }
      case 'drop': {
        if (current !== null) this.emit({ type: 'goal_updated', goal: { ...current, status: 'dropped' } })
        state.goal = null
        return reply(null)
      }
      default:
        throw new FakeRpcError(`Unknown goal op: ${String(command.op)}`)
    }
  }

  private nextSession(): void {
    this.sessionCounter += 1
    const id = `fake-session-${this.sessionCounter}`
    this.state.sessionId = id
    this.state.sessionFile = join(dirname(this.state.sessionFile), `2026-10-26T06-0${this.sessionCounter}-00-000Z_${id}.jsonl`)
  }

  private defaultHandler(type: string): (command: Json) => unknown {
    const state = this.state
    switch (type) {
      case 'negotiate_protocol':
        return () => ({ protocolVersion: 2 })
      case 'set_event_filter':
        return () => ({ events: null, messageUpdates: 'delta' })
      case 'get_session_stats':
        return () => ({
          sessionFile: state.sessionFile,
          sessionId: state.sessionId,
          userMessages: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: state.cost,
          contextUsage: {
            tokens: state.contextTokens,
            contextWindow: state.contextWindow,
            percent: (state.contextTokens / state.contextWindow) * 100,
          },
        })
      case 'get_state':
        return () => {
          state.onGetState?.()
          return {
            model: state.model,
            thinkingLevel: state.thinkingLevel,
            sessionId: state.sessionId,
            sessionFile: state.sessionFile,
            isStreaming: false,
            isSettled: state.settled ?? true,
            goal:
              state.goal === undefined || state.goal === null
                ? null
                : { enabled: state.goal.status === 'active', mode: 'active', goal: state.goal },
            ...(state.fastModeEnabled === undefined ? {} : { fastModeEnabled: state.fastModeEnabled }),
            ...(state.slowModeSupported === undefined
              ? {}
              : { slowModeSupported: state.slowModeSupported, slowModeEnabled: state.slowModeEnabled ?? false }),
          }
        }
      case 'get_available_thinking_levels':
        return () => ({ levels: state.thinkingLevels })
      case 'get_available_models':
        return () => ({ models: state.models })
      case 'new_session':
        return () => {
          this.nextSession()
          return { cancelled: false }
        }
      case 'switch_session':
        return (command) => {
          const path = String(command.sessionPath)
          const id = /_([^_/]+)\.jsonl$/.exec(path)?.[1]
          if (id === undefined) throw new FakeRpcError(`ENOENT: ${path}`)
          state.sessionId = id
          state.sessionFile = path
          this.emit({ type: 'model_changed' })
          return { cancelled: false }
        }
      case 'fork':
        return () => {
          this.nextSession()
          return { cancelled: false }
        }
      case 'set_model':
        return (command) => {
          const next = state.models.find((model) => model.provider === command.provider && model.id === command.modelId)
          if (next === undefined) throw new FakeRpcError(`Model not found: ${String(command.provider)}/${String(command.modelId)}`)
          state.model = next
          this.emit({ type: 'model_changed' })
          if (next.reasoning !== true) {
            state.thinkingLevel = 'off'
            state.thinkingLevels = ['off']
            this.emit({ type: 'thinking_level_changed', thinkingLevel: 'off' })
          }
          return next
        }
      case 'set_thinking_level':
        return (command) => {
          const level = String(command.level)
          if (level === 'auto') {
            state.thinkingLevel = 'high'
            this.emit({ type: 'thinking_level_changed', thinkingLevel: 'high', configured: 'auto' })
          } else {
            state.thinkingLevel = level
            this.emit({ type: 'thinking_level_changed', thinkingLevel: level })
          }
          return undefined
        }
      case 'set_fast_mode':
        return (command) => {
          state.fastModeEnabled = command.enabled === true
          return { enabled: state.fastModeEnabled, active: state.fastModeEnabled }
        }
      case 'set_slow_mode':
        return (command) => {
          state.slowModeEnabled = command.enabled === true
          return { enabled: state.slowModeEnabled }
        }
      case 'goal':
        return (command) => this.goalCommand(command)
      case 'get_entries':
        return () => ({ entries: state.entries ?? [], leafId: state.leafId ?? null })
      case 'branch':
        return (command) => {
          state.onBranch?.()
          const entries = state.entries ?? []
          const index = entries.findIndex((entry) => entry.id === command.entryId)
          const target = entries[index]
          if (target === undefined || target.type !== 'message' || fieldOf(target.message, 'role') !== 'user') {
            throw new FakeRpcError('Invalid entry ID for branching')
          }
          // The branch is a session of its own that holds everything before the message.
          state.entries = entries.slice(0, index)
          state.leafId = entries[index - 1] === undefined ? null : String(entries[index - 1]?.id)
          this.nextSession()
          return { text: 'the message', cancelled: false }
        }
      case 'remove_queued_message':
        return () => ({ removed: false })
      default:
        return () => undefined
    }
  }
}

interface SpawnCall {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}

function versionProcess(version: string): NativeProcess {
  const stdout = new PassThrough()
  stdout.end(`omp/${version}\n`)
  return {
    stdin: new PassThrough(),
    stdout,
    stderr: new PassThrough(),
    exited: Promise.resolve({ exitCode: 0, signal: null }),
    terminate: () => undefined,
  }
}

function fakeSpawn(fake: FakeOmp, calls: SpawnCall[], version = '18.12.6'): NativeSpawn {
  return (spec) => {
    calls.push({ argv: spec.argv, cwd: spec.cwd, env: spec.env })
    return spec.argv.includes('--version') ? versionProcess(version) : fake.asProcess()
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number, description: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`)
}

interface Harness {
  readonly fake: FakeOmp
  readonly calls: SpawnCall[]
  readonly events: NativeTransportEvent[]
  readonly permissions: NativePermissionRequest[]
  readonly transport: OmpNativeTransport
  readonly root: string
  decide: (request: NativePermissionRequest, signal?: AbortSignal) => Promise<NativePermissionDecision>
  readonly elicitations: NativeElicitationRequest[]
  answer: NativeElicitationHandler
  start: (session?: NativeSessionTarget, argv?: readonly string[]) => Promise<void>
  updates: () => Array<Extract<NativeTransportEvent, { kind: 'update' }>['update']>
}

const text = (value: string): NativeContentBlock[] => [{ type: 'text', text: value }]

/** An overlay root the transport cannot create (below a regular file): it then runs without the overlay. */
async function blockedOverlayRoot(): Promise<string> {
  const dir = await tempDir('omp-overlay-blocked-')
  await writeFile(join(dir, 'file'), 'not a directory')
  return join(dir, 'file', 'overlays')
}

async function harness(
  options: {
    fakeOptions?: { sendReady?: boolean }
    transport?: ConstructorParameters<typeof OmpNativeTransport>[0]
    /** Give the transport a question surface (`onElicitation`). */
    questions?: boolean
    /** The session directory the transport is started in (default: a path that does not exist). */
    cwd?: string
  } = {},
): Promise<Harness> {
  const root = await tempDir('omp-fake-')
  const bucket = join(root, 'agent', 'sessions', '-work-here')
  await mkdir(bucket, { recursive: true })
  const fake = new FakeOmp(bucket, options.fakeOptions)
  const calls: SpawnCall[] = []
  const events: NativeTransportEvent[] = []
  const permissions: NativePermissionRequest[] = []
  const elicitations: NativeElicitationRequest[] = []
  // Every transport keeps its overlay below the test's own root, so nothing is left in the system temp directory.
  const transport = new OmpNativeTransport({
    contextPollIntervalMs: 60_000,
    overlayRoot: join(root, 'overlays'),
    ...options.transport,
  })
  const built: Harness = {
    fake,
    calls,
    events,
    permissions,
    transport,
    root,
    decide: async (request) => {
      permissions.push(request)
      const approve = request.options.find((option) => option.kind === 'allow_once')
      return approve === undefined ? { cancelled: true } : { optionId: approve.optionId }
    },
    elicitations,
    answer: async () => ({ action: 'cancel' }),
    start: (session = { kind: 'new' }, argv = ['/bin/omp', 'acp', '-e', '/x/link.js']) =>
      transport.start({
        argv,
        env: { PI_CODING_AGENT_DIR: join(root, 'agent'), HOME: '/home/u' },
        cwd: options.cwd ?? '/work/here',
        spawn: fakeSpawn(fake, calls),
        session,
        onEvent: (event) => events.push(event),
        onPermission: (request, signal) => built.decide(request, signal),
        ...(options.questions === true
          ? {
              onElicitation: (request: NativeElicitationRequest, signal?: AbortSignal) => {
                built.elicitations.push(request)
                return built.answer(request, signal)
              },
            }
          : {}),
      }),
    updates: () =>
      events.flatMap((event) => (event.kind === 'update' ? [event.update] : [])),
  }
  return built
}

/** One tool-using turn the way OMP 18.12.6 frames it (captured with the live probe). */
function playToolTurn(fake: FakeOmp, promptId: string, usage: { first: Json; second: Json }): void {
  const toolCallId = 'call_1|fc_9'
  const userMessage = { role: 'user', content: [{ type: 'text', text: 'run it' }], attribution: 'user' }
  fake.emit({ type: 'agent_start' })
  fake.emit({ type: 'turn_start' })
  fake.emit({ type: 'message_start', message: userMessage, messageId: 'msg-1' })
  fake.emit({ type: 'message_end', message: userMessage, messageId: 'msg-1' })
  fake.emit({ type: 'message_start', message: { role: 'assistant', content: [] }, messageId: 'msg-2' })
  fake.emit({
    type: 'message_update',
    message: { role: 'assistant' },
    messageId: 'msg-2',
    assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 },
  })
  fake.emit({
    type: 'message_update',
    message: { role: 'assistant' },
    messageId: 'msg-2',
    assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Need to run echo.' },
  })
  fake.emit({
    type: 'message_end',
    messageId: 'msg-2',
    message: {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'Need to run echo.' }, { type: 'toolCall', id: toolCallId, name: 'bash' }],
      usage: usage.first,
      stopReason: 'toolUse',
    },
  })
  fake.emit({
    type: 'tool_execution_start',
    toolCallId,
    toolName: 'bash',
    args: { command: 'echo hello-from-omp', timeout: 10 },
    intent: 'Running requested echo command',
  })
  fake.emit({
    type: 'tool_execution_update',
    toolCallId,
    toolName: 'bash',
    args: { command: 'echo hello-from-omp', timeout: 10 },
    partialResult: { content: [{ type: 'text', text: 'hello-from-omp\n' }], details: {} },
  })
  fake.emit({
    type: 'tool_execution_end',
    toolCallId,
    toolName: 'bash',
    result: { content: [{ type: 'text', text: 'hello-from-omp\n' }], details: { wallTimeMs: 64 } },
    isError: false,
  })
  fake.emit({ type: 'turn_end', message: { role: 'assistant', stopReason: 'toolUse', usage: usage.first } })
  fake.emit({ type: 'turn_start' })
  fake.emit({ type: 'message_start', message: { role: 'assistant', content: [] }, messageId: 'msg-4' })
  fake.emit({
    type: 'message_update',
    message: { role: 'assistant' },
    messageId: 'msg-4',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'DONE' },
  })
  const finalMessage = {
    role: 'assistant',
    content: [{ type: 'text', text: 'DONE' }],
    usage: usage.second,
    stopReason: 'stop',
  }
  fake.emit({ type: 'message_end', messageId: 'msg-4', message: finalMessage })
  fake.emit({ type: 'turn_end', message: finalMessage })
  fake.emit({ type: 'agent_end', messages: [userMessage, finalMessage] })
  fake.emit({ type: 'prompt_result', id: promptId, agentInvoked: true, status: 'completed', sessionSettled: true })
  fake.emit({ type: 'session_settled' })
}

const USAGE_ONE = {
  input: 3,
  output: 87,
  cacheRead: 0,
  cacheWrite: 9075,
  totalTokens: 9165,
  reasoningTokens: 10,
  cost: { total: 0.0125 },
}
const USAGE_TWO = { input: 3, output: 5, cacheRead: 9075, cacheWrite: 103, totalTokens: 9186, cost: { total: 0.0012 } }

/** Resolve after `ms`: lets scripted frames reach the transport, or lets a timer that must not fire run out. */
function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

/** The reply text the host received so far. */
function messageText(h: Harness): string {
  return h
    .updates()
    .flatMap((update) =>
      update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? [update.content.text] : [],
    )
    .join('')
}

/** The one-line notes the host received as thoughts. */
function thoughtLines(h: Harness): string[] {
  return h
    .updates()
    .flatMap((update) =>
      update.sessionUpdate === 'agent_thought_chunk' && update.content.type === 'text' ? [update.content.text] : [],
    )
}

const textDelta = (delta: string): Json =>
  assistantFrame('message_update', { assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta } })

/** A run the test owns: the prompt is sent and omp reports the agent as started. */
async function openTurn(
  h: Harness,
  signal: AbortSignal = new AbortController().signal,
): Promise<{ turn: Promise<NativePromptResult>; promptId: string }> {
  h.fake.override('prompt', () => {
    h.fake.emit({ type: 'agent_start' })
    return undefined
  })
  const turn = h.transport.prompt(text('long task'), signal)
  turn.catch(() => undefined)
  await waitFor(() => h.fake.commandsOfType('prompt').length === 1, 2_000, 'prompt')
  return { turn, promptId: String(h.fake.commandsOfType('prompt')[0]?.id) }
}

describe('OmpNativeTransport against a scripted rpc-ui process', () => {
  const transports: OmpNativeTransport[] = []
  afterEach(async () => {
    for (const transport of transports.splice(0)) await transport.close().catch(() => undefined)
  })
  async function create(options?: Parameters<typeof harness>[0]): Promise<Harness> {
    const built = await harness(options)
    transports.push(built.transport)
    return built
  }

  it('launches omp through the host spawner with rpc-ui, the launcher extensions and the session cwd', async () => {
    const h = await create()
    await h.start()
    const main = h.calls.find((call) => !call.argv.includes('--version'))
    expect(main?.argv.slice(0, -2)).toEqual(['/bin/omp', '-e', '/x/link.js', '--mode', 'rpc-ui', '--auto-approve'])
    // The last two arguments are the config overlay that lets goals continue over rpc.
    expect(main?.argv.at(-2)).toBe('--config')
    expect(main?.argv.at(-1)?.startsWith(join(h.root, 'overlays'))).toBe(true)
    expect(main?.cwd).toBe('/work/here')
    expect(main?.env).toEqual({ PI_CODING_AGENT_DIR: join(h.root, 'agent'), HOME: '/home/u' })
    const probe = h.calls.find((call) => call.argv.includes('--version'))
    expect(probe?.argv).toEqual(['/bin/omp', '-e', '/x/link.js', '--version'])
    expect(h.transport.kind).toBe('omp')
    expect(h.transport.canFork).toBe(true)
    expect(h.transport.agentInfo).toEqual({ name: 'omp', version: '18.12.6' })
  })

  it('negotiates v2 framing, starts a new persisted session and learns its id', async () => {
    const h = await create()
    await h.start()
    expect(h.fake.commands.map((command) => command.type)).toEqual([
      'negotiate_protocol',
      'set_event_filter',
      'get_session_stats',
      'new_session',
      'get_session_stats',
      'get_state',
      'get_available_thinking_levels',
      'get_available_models',
    ])
    expect(h.fake.commands[1]).toMatchObject({ events: null, messageUpdates: 'delta' })
    expect(h.transport.sessionId).toBe('fake-session-1')
    expect(h.transport.sessionFilePath).toBe(h.fake.state.sessionFile)
    expect(h.transport.closed).toBe(false)
    expect(h.transport.contextUsage()).toEqual({ used: 14_777, size: 1_000_000 })
    expect(h.events.filter((event) => event.kind === 'context_usage')).toHaveLength(1)
  })

  it('derives the ACP controls from the session state', async () => {
    const h = await create()
    await h.start()
    const controls = h.transport.controls()
    expect(controls.configOptions.map((option) => [option.id, option.category, option.currentValue])).toEqual([
      ['mode', 'mode', 'default'],
      ['model', 'model', 'tokenrouter-v2/gpt-6.1-sol'],
      ['thinking', 'thought_level', 'high'],
    ])
    expect(controls.modes?.availableModes.map((mode) => mode.id)).toEqual(['default'])
    expect(controls.imageInput).toBe(true)
    const model = controls.configOptions.find((option) => option.id === 'model')
    expect(model?.type === 'select' ? model.options.map((entry) => ('value' in entry ? entry.value : '')) : []).toEqual([
      'tokenrouter-v2/claude-opus-5.5',
      'tokenrouter-v2/gpt-6.1-sol',
      'tokenrouter-v2/glm-5.3',
    ])
  })

  describe('command catalogue', () => {
    it('reports the static table until omp sends its catalogue, then the classified live list', async () => {
      const h = await create()
      await h.start()
      const before = h.transport.commands()
      expect(before.find((command) => command.name === 'btw')?.dispatch).toBe('side')
      expect(before.filter((command) => command.dispatch === 'prompt').length).toBeGreaterThan(10)
      h.fake.emit({ type: 'available_commands_update' })
      h.fake.emit({
        type: 'available_commands_update',
        commands: [
          { name: 'compact', description: 'Compact', input: { hint: '[focus]' }, source: 'builtin' },
          { name: 'hello', description: 'Greet', source: 'file' },
        ],
      })
      await waitFor(() => h.events.some((event) => event.kind === 'commands'), 2_000, 'commands event')
      expect(h.transport.commands().map((command) => [command.name, command.dispatch])).toEqual([
        ['btw', 'side'],
        ['new', 'immediate'],
        ['clear', 'immediate'],
        ['rewind', 'immediate'],
        ['goal', 'prompt'],
        ['compact', 'prompt'],
        ['hello', 'prompt'],
      ])
      // A frame without a command list is not a catalogue; the real one is the only event, and no ACP update.
      expect(h.events.filter((event) => event.kind === 'commands')).toEqual([
        { kind: 'commands', commands: h.transport.commands() },
      ])
      expect(h.updates().some((update) => update.sessionUpdate === 'available_commands_update')).toBe(false)
    })

    it('reports a changed catalogue and stays quiet about an identical one', async () => {
      const h = await create()
      await h.start()
      const first = [{ name: 'compact', description: 'Compact', source: 'builtin' }]
      h.fake.emit({ type: 'available_commands_update', commands: first })
      h.fake.emit({ type: 'available_commands_update', commands: first })
      h.fake.emit({ type: 'available_commands_update', commands: [...first, { name: 'review', source: 'custom' }] })
      await waitFor(() => h.events.filter((event) => event.kind === 'commands').length >= 2, 2_000, 'second catalogue')
      await sleep(20)
      const reported = h.events.flatMap((event) =>
        event.kind === 'commands' ? [event.commands.map((command) => command.name)] : [],
      )
      expect(reported).toEqual([
        ['btw', 'new', 'clear', 'rewind', 'goal', 'compact'],
        ['btw', 'new', 'clear', 'rewind', 'goal', 'compact', 'review'],
      ])
    })
  })

  describe('session targets', () => {
    async function withStoredSessions(h: Harness): Promise<{ localFile: string; otherFile: string }> {
      const sessions = join(h.root, 'agent', 'sessions')
      const other = join(sessions, '-work-elsewhere')
      await mkdir(other, { recursive: true })
      const localFile = join(sessions, '-work-here', '2026-10-25T06-00-00-000Z_stored-local.jsonl')
      const otherFile = join(other, '2026-10-24T06-00-00-000Z_stored-other.jsonl')
      await writeFile(localFile, sessionHeader('stored-local', '/work/here'))
      await writeFile(otherFile, sessionHeader('stored-other', '/work/elsewhere'))
      return { localFile, otherFile }
    }

    it('resumes a stored id by opening its session FILE with switch_session on the booted process', async () => {
      const h = await create()
      const { localFile } = await withStoredSessions(h)
      await h.start({ kind: 'resume', sessionId: 'stored-local' })
      expect(h.fake.commandsOfType('switch_session')).toEqual([
        expect.objectContaining({ type: 'switch_session', sessionPath: localFile }),
      ])
      expect(h.fake.commandsOfType('new_session')).toHaveLength(0)
      expect(h.transport.sessionId).toBe('stored-local')
    })

    it('finds an id saved under another cwd bucket (global fallback) like ACP', async () => {
      const h = await create()
      const { otherFile } = await withStoredSessions(h)
      await h.start({ kind: 'resume', sessionId: 'stored-other' })
      expect(h.fake.commandsOfType('switch_session')[0]).toMatchObject({ sessionPath: otherFile })
      expect(h.transport.sessionId).toBe('stored-other')
    })

    it('rejects an unknown id with session-not-found and tears the process down', async () => {
      const h = await create()
      await withStoredSessions(h)
      const failure = await h.start({ kind: 'resume', sessionId: 'never-existed' }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(NativeTransportError)
      expect(failure).toMatchObject({ code: 'session-not-found' })
      expect(nativeError(failure).message).toContain('session not found')
      await waitFor(() => h.fake.stdinEnded || h.fake.terminated, 5_000, 'process teardown')
      expect(h.transport.closed).toBe(true)
    })

    it('reports a switch OMP cancelled (session recorded for another cwd) as resume-failed', async () => {
      const h = await create()
      await withStoredSessions(h)
      h.fake.override('switch_session', () => ({ cancelled: true }))
      const failure = await h.start({ kind: 'resume', sessionId: 'stored-local' }).catch((error: unknown) => error)
      expect(failure).toMatchObject({ code: 'resume-failed' })
      expect(nativeError(failure).detail).toContain('another working directory')
    })

    it('rejects when OMP attaches a session other than the requested one', async () => {
      const h = await create()
      await withStoredSessions(h)
      h.fake.override('switch_session', () => {
        h.fake.state.sessionId = 'somebody-else'
        return { cancelled: false }
      })
      const failure = await h.start({ kind: 'resume', sessionId: 'stored-local' }).catch((error: unknown) => error)
      expect(failure).toMatchObject({ code: 'resume-failed' })
    })

    it('forks like ACP: open the parent file, then rpc fork; the id is the fork, not the parent', async () => {
      const h = await create()
      const { localFile } = await withStoredSessions(h)
      await h.start({ kind: 'fork', parentSessionId: 'stored-local' })
      expect(h.fake.commands.filter((command) => command.type === 'switch_session' || command.type === 'fork')).toEqual([
        expect.objectContaining({ type: 'switch_session', sessionPath: localFile }),
        expect.objectContaining({ type: 'fork' }),
      ])
      expect(h.transport.sessionId).toBe('fake-session-1')
      expect(h.transport.sessionId).not.toBe('stored-local')
    })

    it('fails a fork whose parent cannot be found or that OMP refuses', async () => {
      const missing = await create()
      await withStoredSessions(missing)
      expect(await missing.start({ kind: 'fork', parentSessionId: 'nope' }).catch((error: unknown) => error)).toMatchObject({
        code: 'session-not-found',
      })
      const busy = await create()
      await withStoredSessions(busy)
      busy.fake.override('fork', () => {
        throw new FakeRpcError('Cannot fork the session while a turn is running')
      })
      expect(await busy.start({ kind: 'fork', parentSessionId: 'stored-local' }).catch((error: unknown) => error)).toMatchObject({
        code: 'fork-failed',
        detail: expect.stringContaining('while a turn is running'),
      })
    })
  })

  describe('controls', () => {
    it('applies model and thinking through rpc and reflects them without emitting a controls event', async () => {
      const h = await create()
      await h.start()
      const before = h.events.length
      await h.transport.setConfigOption('model', 'tokenrouter-v2/claude-opus-5.5')
      expect(h.fake.commandsOfType('set_model')).toEqual([
        expect.objectContaining({ provider: 'tokenrouter-v2', modelId: 'claude-opus-5.5' }),
      ])
      await h.transport.setConfigOption('thinking', 'low')
      expect(h.fake.commandsOfType('set_thinking_level')).toEqual([expect.objectContaining({ level: 'low' })])
      const values = Object.fromEntries(h.transport.controls().configOptions.map((option) => [option.id, option.currentValue]))
      expect(values).toEqual({ mode: 'default', model: 'tokenrouter-v2/claude-opus-5.5', thinking: 'low' })
      expect(h.events.slice(before).filter((event) => event.kind === 'controls')).toEqual([])
    })

    it('does not touch the vendor when the current model or mode is selected again', async () => {
      const h = await create()
      await h.start()
      await h.transport.setConfigOption('model', 'tokenrouter-v2/gpt-6.1-sol')
      await h.transport.setConfigOption('mode', 'default')
      expect(h.fake.commandsOfType('set_model')).toHaveLength(0)
    })

    it('selects auto thinking and reports it as auto although OMP reports the resolved level', async () => {
      const h = await create()
      await h.start()
      await h.transport.setConfigOption('thinking', 'auto')
      expect(h.fake.commandsOfType('set_thinking_level')).toEqual([expect.objectContaining({ level: 'auto' })])
      expect(h.transport.controls().configOptions.find((option) => option.id === 'thinking')?.currentValue).toBe('auto')
    })

    it('switching to a model without reasoning re-derives thinking as off', async () => {
      const h = await create()
      await h.start()
      await h.transport.setConfigOption('model', 'tokenrouter-v2/glm-5.3')
      const controls = h.transport.controls()
      expect(controls.configOptions.find((option) => option.id === 'thinking')?.currentValue).toBe('off')
      expect(controls.imageInput).toBe(false)
    })

    it('rejects plan mode with a clear error, unknown ids/values and booleans', async () => {
      const h = await create()
      await h.start()
      const plan = await h.transport.setConfigOption('mode', 'plan').catch((error: unknown) => error)
      expect(plan).toBeInstanceOf(NativeTransportError)
      expect(plan).toMatchObject({
        code: 'plan-mode-unsupported',
        message: 'OMP plan mode is not available over the native rpc-ui protocol',
      })
      expect(await h.transport.setConfigOption('mode', 'nope').catch((error: unknown) => error)).toMatchObject({ code: 'unknown-mode' })
      expect(await h.transport.setConfigOption('model', 'x/none').catch((error: unknown) => error)).toMatchObject({ code: 'unknown-model' })
      expect(await h.transport.setConfigOption('thinking', 'ultra').catch((error: unknown) => error)).toMatchObject({
        code: 'unknown-thinking-level',
      })
      expect(await h.transport.setConfigOption('bogus', 'x').catch((error: unknown) => error)).toMatchObject({
        code: 'unknown-config-option',
      })
      expect(await h.transport.setConfigOption('mode', true).catch((error: unknown) => error)).toMatchObject({
        code: 'unsupported-config-value',
      })
    })

    it('surfaces a vendor refusal of set_model', async () => {
      const h = await create()
      await h.start()
      h.fake.override('set_model', () => {
        throw new FakeRpcError('No API key for tokenrouter-v2/claude-opus-5.5')
      })
      const failure = await h.transport.setConfigOption('model', 'tokenrouter-v2/claude-opus-5.5').catch((error: unknown) => error)
      expect(failure).toMatchObject({ code: 'request-failed', detail: 'No API key for tokenrouter-v2/claude-opus-5.5' })
      expect(h.transport.controls().configOptions.find((option) => option.id === 'model')?.currentValue).toBe('tokenrouter-v2/gpt-6.1-sol')
    })

    it('emits a controls event when OMP changes thinking by itself', async () => {
      const h = await create()
      await h.start()
      h.fake.state.thinkingLevel = 'low'
      h.fake.emit({ type: 'thinking_level_changed', thinkingLevel: 'low' })
      await waitFor(() => h.events.some((event) => event.kind === 'controls'), 2_000, 'controls event')
      const event = h.events.find((entry) => entry.kind === 'controls')
      expect(event?.kind === 'controls' && event.controls.configOptions.find((option) => option.id === 'thinking')?.currentValue).toBe('low')
      // The auto-classifier re-reporting the same selector is not a change.
      const count = h.events.filter((entry) => entry.kind === 'controls').length
      h.fake.emit({ type: 'thinking_level_changed', thinkingLevel: 'low' })
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(h.events.filter((entry) => entry.kind === 'controls')).toHaveLength(count)
    })

    it('re-reads the model when OMP switches it (fallback, /model) and emits controls', async () => {
      const h = await create()
      await h.start()
      h.fake.state.model = fakeModel(MODEL_OPUS)
      h.fake.state.thinkingLevels = ['off', 'low', 'medium', 'high', 'max']
      h.fake.emit({ type: 'model_changed' })
      await waitFor(() => h.events.some((event) => event.kind === 'controls'), 2_000, 'controls event')
      const controls = h.transport.controls()
      expect(controls.configOptions.find((option) => option.id === 'model')?.currentValue).toBe('tokenrouter-v2/claude-opus-5.5')
      const thinking = controls.configOptions.find((option) => option.id === 'thinking')
      expect(thinking?.type === 'select' ? thinking.options.map((entry) => ('value' in entry ? entry.value : '')) : []).toEqual([
        'off',
        'auto',
        'low',
        'medium',
        'high',
        'max',
      ])
    })

    it('degrades to the current model when the catalogue is unavailable and fills it in on a retry', async () => {
      const h = await create({ transport: { modelListTimeoutMs: 500, modelListRetryDelaysMs: [30] } })
      let attempts = 0
      h.fake.override('get_available_models', () => {
        attempts += 1
        if (attempts === 1) throw new FakeRpcError('provider discovery failed')
        return { models: h.fake.state.models }
      })
      await h.start()
      const options = h.transport.controls().configOptions.find((option) => option.id === 'model')
      expect(options?.type === 'select' ? options.options.length : 0).toBe(1)
      await waitFor(() => h.events.some((event) => event.kind === 'controls'), 2_000, 'catalogue retry')
      const full = h.transport.controls().configOptions.find((option) => option.id === 'model')
      expect(full?.type === 'select' ? full.options.length : 0).toBe(3)
    })
  })

  describe('turns', () => {
    it('projects a tool-using turn in ACP shape and sums usage over every model call', async () => {
      const h = await create()
      await h.start()
      h.fake.override('prompt', (command) => {
        setTimeout(() => playToolTurn(h.fake, String(command.id), { first: USAGE_ONE, second: USAGE_TWO }), 5)
        return undefined
      })
      const result = await h.transport.prompt(text('run it'), new AbortController().signal)
      expect(result.stopReason).toBe('end_turn')
      expect(result.usage).toEqual({
        inputTokens: 6,
        outputTokens: 92,
        cachedReadTokens: 9075,
        cachedWriteTokens: 9178,
        thoughtTokens: 10,
        costUsd: expect.closeTo(0.0137, 10),
      })
      expect(h.fake.commandsOfType('prompt')[0]).toMatchObject({ message: 'run it' })

      const updates = h.updates()
      const names = updates.map((update) => update.sessionUpdate)
      expect(names).toEqual([
        'agent_thought_chunk',
        'tool_call',
        'tool_call_update',
        'tool_call_update',
        'agent_message_chunk',
      ])
      const [thought, call, progress, done, reply] = updates
      expect(thought).toMatchObject({ content: { type: 'text', text: 'Need to run echo.' }, messageId: expect.any(String) })
      expect(call).toMatchObject({
        toolCallId: 'call_1|fc_9',
        title: '$ echo hello-from-omp',
        name: 'bash',
        kind: 'execute',
        status: 'pending',
        rawInput: { command: 'echo hello-from-omp', timeout: 10 },
      })
      expect(progress).toMatchObject({ toolCallId: 'call_1|fc_9', status: 'in_progress' })
      expect(done).toMatchObject({
        toolCallId: 'call_1|fc_9',
        status: 'completed',
        rawOutput: { content: [{ type: 'text', text: 'hello-from-omp\n' }], details: { wallTimeMs: 64 } },
      })
      expect(reply).toMatchObject({ content: { type: 'text', text: 'DONE' } })
      // The thought and the reply belong to different assistant messages.
      expect(fieldOf(thought, 'messageId')).not.toBe(fieldOf(reply, 'messageId'))
    })

    it('reports window occupancy and cumulative cost when the turn settles', async () => {
      const h = await create()
      await h.start()
      h.fake.override('prompt', (command) => {
        setTimeout(() => {
          h.fake.state.contextTokens = 9_181
          h.fake.state.cost = 0.0247
          playToolTurn(h.fake, String(command.id), { first: USAGE_ONE, second: USAGE_TWO })
        }, 5)
        return undefined
      })
      await h.transport.prompt(text('run it'), new AbortController().signal)
      expect(h.transport.contextUsage()).toEqual({ used: 9_181, size: 1_000_000, cost: { amount: 0.0247, currency: 'USD' } })
      const last = h.events.filter((event) => event.kind === 'context_usage').at(-1)
      expect(last).toEqual({ kind: 'context_usage', contextUsage: h.transport.contextUsage() })
    })

    it('shows a provider failure as the reply text and ends the turn', async () => {
      const h = await create()
      await h.start()
      h.fake.override('prompt', (command) => {
        setTimeout(() => {
          const failed = { role: 'assistant', content: [], stopReason: 'error', errorMessage: '410 model has been sunset', usage: {} }
          h.fake.emit({ type: 'agent_start' })
          h.fake.emit({ type: 'message_start', message: failed, messageId: 'msg-2' })
          h.fake.emit({ type: 'message_end', message: failed, messageId: 'msg-2' })
          h.fake.emit({ type: 'agent_end', messages: [failed] })
          h.fake.emit({
            type: 'prompt_result',
            id: command.id,
            agentInvoked: true,
            status: 'error',
            sessionSettled: true,
            error: { message: '410 model has been sunset' },
          })
        }, 5)
        return undefined
      })
      const result = await h.transport.prompt(text('hi'), new AbortController().signal)
      expect(result).toEqual({ stopReason: 'end_turn' })
      expect(h.updates()).toContainEqual(
        expect.objectContaining({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '410 model has been sunset' } }),
      )
    })

    it('rejects a prompt OMP refuses before running the agent (busy session)', async () => {
      const h = await create()
      await h.start()
      h.fake.override('prompt', (command) => {
        setTimeout(
          () =>
            h.fake.emit({
              type: 'prompt_result',
              id: command.id,
              agentInvoked: false,
              status: 'error',
              sessionSettled: false,
              error: { message: 'Agent is already processing.' },
            }),
          5,
        )
        return undefined
      })
      const failure = await h.transport.prompt(text('hi'), new AbortController().signal).catch((error: unknown) => error)
      expect(failure).toMatchObject({ code: 'prompt-failed', detail: 'Agent is already processing.' })
    })

    it('finishes a local slash command that never runs the agent', async () => {
      const h = await create()
      await h.start()
      h.fake.override('prompt', () => ({ agentInvoked: false }))
      expect(await h.transport.prompt(text('/title x'), new AbortController().signal)).toEqual({ stopReason: 'end_turn' })
    })

    it('maps a length stop and a refusal to their ACP stop reasons', async () => {
      const length = await create()
      await length.start()
      length.fake.override('prompt', (command) => {
        setTimeout(() => {
          const cut = { role: 'assistant', content: [{ type: 'text', text: 'partial' }], stopReason: 'length', usage: {} }
          length.fake.emit({ type: 'agent_start' })
          length.fake.emit({ type: 'message_end', message: cut, messageId: 'msg-2' })
          length.fake.emit({ type: 'agent_end', messages: [cut] })
          length.fake.emit({ type: 'prompt_result', id: command.id, agentInvoked: true, status: 'completed', sessionSettled: true })
        }, 5)
        return undefined
      })
      expect((await length.transport.prompt(text('x'), new AbortController().signal)).stopReason).toBe('max_tokens')

      const refused = await create()
      await refused.start()
      refused.fake.override('prompt', (command) => {
        setTimeout(() => {
          const blocked = { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'Blocked by content filter', usage: {} }
          refused.fake.emit({ type: 'agent_start' })
          refused.fake.emit({ type: 'agent_end', messages: [blocked] })
          refused.fake.emit({
            type: 'prompt_result',
            id: command.id,
            agentInvoked: true,
            status: 'error',
            sessionSettled: true,
            error: { message: 'Blocked by content filter' },
          })
        }, 5)
        return undefined
      })
      expect((await refused.transport.prompt(text('x'), new AbortController().signal)).stopReason).toBe('refusal')
    })

    it('settles from the terminal run frame when an older OMP never sends prompt_result', async () => {
      const h = await create()
      await h.start()
      h.fake.override('prompt', () => {
        setTimeout(() => {
          const message = { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop', usage: USAGE_TWO }
          h.fake.emit({ type: 'agent_start' })
          h.fake.emit({ type: 'message_end', message, messageId: 'msg-2' })
          h.fake.emit({ type: 'agent_end', messages: [message] })
        }, 5)
        return undefined
      })
      const result = await h.transport.prompt(text('x'), new AbortController().signal)
      expect(result.stopReason).toBe('end_turn')
      expect(result.usage?.outputTokens).toBe(5)
    })

    it('cancels through rpc abort, resolves cancelled and forwards nothing after the abort', async () => {
      const h = await create()
      await h.start()
      h.fake.override('prompt', () => {
        h.fake.emit({ type: 'agent_start' })
        return undefined
      })
      h.fake.override('abort', () => {
        setTimeout(() => {
          // A late delta that raced the abort must not reach the host.
          h.fake.emit({
            type: 'message_update',
            message: { role: 'assistant' },
            messageId: 'msg-2',
            assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'late' },
          })
          h.fake.emit({ type: 'prompt_result', id: h.fake.commandsOfType('prompt')[0]?.id, agentInvoked: true, status: 'aborted', sessionSettled: true })
        }, 10)
        return undefined
      })
      const controller = new AbortController()
      const turn = h.transport.prompt(text('long task'), controller.signal)
      await waitFor(() => h.fake.commandsOfType('prompt').length === 1, 2_000, 'prompt')
      controller.abort()
      expect((await turn).stopReason).toBe('cancelled')
      expect(h.fake.commandsOfType('abort')).toHaveLength(1)
      expect(h.updates().some((update) => update.sessionUpdate === 'agent_message_chunk')).toBe(false)
    })

    it('does not start a turn for an already aborted signal and refuses concurrent prompts', async () => {
      const h = await create()
      await h.start()
      const aborted = new AbortController()
      aborted.abort()
      await expect(h.transport.prompt(text('x'), aborted.signal)).rejects.toBeDefined()
      expect(h.fake.commandsOfType('prompt')).toHaveLength(0)
      h.fake.override('prompt', () => undefined)
      const first = h.transport.prompt(text('first'), new AbortController().signal)
      first.catch(() => undefined)
      await expect(h.transport.prompt(text('second'), new AbortController().signal)).rejects.toMatchObject({
        code: 'prompt-in-flight',
      })
      await expect(h.transport.prompt([], new AbortController().signal)).rejects.toBeDefined()
    })

    it('sends image blocks with the prompt text', async () => {
      const h = await create()
      await h.start()
      h.fake.override('prompt', (command) => {
        setTimeout(() => h.fake.emit({ type: 'prompt_result', id: command.id, agentInvoked: true, status: 'completed', sessionSettled: true }), 5)
        return undefined
      })
      await h.transport.prompt(
        [
          { type: 'text', text: 'what is this' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'text', text: 'be brief' },
        ],
        new AbortController().signal,
      )
      expect(h.fake.commandsOfType('prompt')[0]).toMatchObject({
        message: 'what is this\n\nbe brief',
        images: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
      })
    })

    it('loses the turn, not the host, when the process dies mid-prompt', async () => {
      const h = await create()
      await h.start()
      h.fake.override('prompt', () => {
        h.fake.stderr.write('Segmentation fault\n')
        setTimeout(() => h.fake.crash(139), 5)
        return undefined
      })
      const failure = await h.transport.prompt(text('x'), new AbortController().signal).catch((error: unknown) => error)
      expect(failure).toMatchObject({ code: 'process-exit' })
      expect(nativeError(failure).detail).toContain('Segmentation fault')
      expect(h.transport.closed).toBe(true)
      await expect(h.transport.prompt(text('again'), new AbortController().signal)).rejects.toMatchObject({ code: 'process-exit' })
    })
  })

  describe('steering', () => {
    it('never starts a turn from an idle steer: the host submits a prompt instead', async () => {
      const h = await create()
      await h.start()
      expect(await h.transport.steer(text('hey'))).toBe('promptRequired')
      expect(h.fake.commandsOfType('steer')).toHaveLength(0)
    })

    it('confirms injection only after queue admission, consumption and the steering transcript message', async () => {
      const h = await create()
      await h.start()
      const stages: string[] = []
      h.fake.override('prompt', () => {
        h.fake.emit({ type: 'agent_start' })
        return undefined
      })
      h.fake.override('steer', (command) => {
        const message = String(command.message)
        h.fake.emit({ type: 'queue_update', steering: [message], followUp: [], liveSteered: 0 })
        stages.push('queued')
        setTimeout(() => {
          h.fake.emit({ type: 'queue_update', steering: [], followUp: [], liveSteered: 0 })
          stages.push('consumed')
          h.fake.emit({
            type: 'message_start',
            message: { role: 'user', content: [{ type: 'text', text: message }], steering: true },
            messageId: 'msg-5',
          })
          stages.push('injected')
        }, 15)
        return undefined
      })
      const turn = h.transport.prompt(text('start'), new AbortController().signal)
      await waitFor(() => h.fake.commandsOfType('prompt').length === 1, 2_000, 'prompt')
      expect(await h.transport.steer(text('change course'))).toBe('injected')
      expect(stages).toEqual(['queued', 'consumed', 'injected'])
      h.fake.emit({ type: 'prompt_result', id: h.fake.commandsOfType('prompt')[0]?.id, agentInvoked: true, status: 'completed', sessionSettled: true })
      await turn
    })

    it('withdraws a steer that was queued but never injected and asks for a prompt instead', async () => {
      const h = await create({ transport: { steerTimeoutMs: 40 } })
      await h.start()
      h.fake.override('prompt', () => {
        h.fake.emit({ type: 'agent_start' })
        return undefined
      })
      h.fake.override('steer', (command) => {
        h.fake.emit({ type: 'queue_update', steering: [String(command.message)], followUp: [], liveSteered: 0 })
        return undefined
      })
      h.fake.override('remove_queued_message', () => ({ removed: true }))
      const turn = h.transport.prompt(text('start'), new AbortController().signal)
      turn.catch(() => undefined)
      await waitFor(() => h.fake.commandsOfType('prompt').length === 1, 2_000, 'prompt')
      expect(await h.transport.steer(text('too late'))).toBe('promptRequired')
      expect(h.fake.commandsOfType('remove_queued_message')[0]).toMatchObject({ message: 'too late', queue: 'steering' })
    })

    it('throws when acceptance cannot be established (queued, not withdrawable, never injected)', async () => {
      const h = await create({ transport: { steerTimeoutMs: 40 } })
      await h.start()
      h.fake.override('prompt', () => {
        h.fake.emit({ type: 'agent_start' })
        return undefined
      })
      h.fake.override('steer', () => undefined)
      const turn = h.transport.prompt(text('start'), new AbortController().signal)
      turn.catch(() => undefined)
      await waitFor(() => h.fake.commandsOfType('prompt').length === 1, 2_000, 'prompt')
      await expect(h.transport.steer(text('maybe'))).rejects.toMatchObject({ code: 'steer-unconfirmed' })
    })

    it('says promptRequired when OMP refuses the steer outright', async () => {
      const h = await create()
      await h.start()
      h.fake.override('prompt', () => {
        h.fake.emit({ type: 'agent_start' })
        return undefined
      })
      h.fake.override('steer', () => {
        throw new FakeRpcError('nothing to steer')
      })
      const turn = h.transport.prompt(text('start'), new AbortController().signal)
      turn.catch(() => undefined)
      await waitFor(() => h.fake.commandsOfType('prompt').length === 1, 2_000, 'prompt')
      expect(await h.transport.steer(text('x'))).toBe('promptRequired')
    })
  })

  describe('approvals', () => {
    async function runDialog(h: Harness, decide: Harness['decide']): Promise<Json | undefined> {
      h.decide = decide
      h.fake.override('prompt', () => {
        h.fake.emit({ type: 'agent_start' })
        h.fake.emit({
          type: 'tool_execution_start',
          toolCallId: 'bash_9',
          toolName: 'bash',
          args: { command: 'rm -rf build' },
        })
        h.fake.emit({
          type: 'extension_ui_request',
          id: 'dlg-1',
          method: 'select',
          title: 'Allow tool: bash\nCommand: rm -rf build',
          options: ['Approve', 'Deny'],
        })
        return undefined
      })
      const turn = h.transport.prompt(text('clean'), new AbortController().signal)
      turn.catch(() => undefined)
      await waitFor(() => h.fake.commands.some((command) => command.type === 'extension_ui_response'), 2_000, 'dialog answer')
      const answer = h.fake.commands.find((command) => command.type === 'extension_ui_response')
      h.fake.emit({ type: 'prompt_result', id: h.fake.commandsOfType('prompt')[0]?.id, agentInvoked: true, status: 'completed', sessionSettled: true })
      await turn
      return answer
    }

    it('forwards a select dialog as an ACP permission request about the running tool and echoes the chosen label', async () => {
      const h = await create()
      await h.start()
      const answer = await runDialog(h, async (request) => {
        h.permissions.push(request)
        return { optionId: 'Approve' }
      })
      expect(h.permissions).toHaveLength(1)
      expect(h.permissions[0]).toEqual({
        toolCall: {
          toolCallId: 'bash_9',
          title: '$ rm -rf build',
          name: 'bash',
          kind: 'execute',
          status: 'pending',
          rawInput: { command: 'rm -rf build' },
          content: [
            { type: 'content', content: { type: 'text', text: '$ rm -rf build' } },
            { type: 'content', content: { type: 'text', text: 'Allow tool: bash\nCommand: rm -rf build' } },
          ],
        },
        options: [
          { optionId: 'Approve', name: 'Approve', kind: 'allow_once' },
          { optionId: 'Deny', name: 'Deny', kind: 'reject_once' },
        ],
      })
      expect(answer).toEqual({ type: 'extension_ui_response', id: 'dlg-1', value: 'Approve' })
    })

    it('answers exactly what the user chose, including a denial', async () => {
      const h = await create()
      await h.start()
      const answer = await runDialog(h, async () => ({ optionId: 'Deny' }))
      expect(answer).toEqual({ type: 'extension_ui_response', id: 'dlg-1', value: 'Deny' })
    })

    it('cancels the dialog when the host cancels, throws or picks an option that was not offered', async () => {
      const cancelled = await create()
      await cancelled.start()
      expect(await runDialog(cancelled, async () => ({ cancelled: true }))).toEqual({
        type: 'extension_ui_response',
        id: 'dlg-1',
        cancelled: true,
      })
      const throwing = await create()
      await throwing.start()
      expect(
        await runDialog(throwing, async () => {
          throw new Error('ui gone')
        }),
      ).toMatchObject({ cancelled: true })
      const invented = await create()
      await invented.start()
      expect(await runDialog(invented, async () => ({ optionId: 'Approve everything' }))).toMatchObject({ cancelled: true })
    })

    it('withdraws the host prompt when OMP cancels its own dialog and never answers it', async () => {
      const h = await create()
      await h.start()
      let signal: AbortSignal | undefined
      const pending = Promise.withResolvers<NativePermissionDecision>()
      h.decide = (_request, requestSignal) => {
        signal = requestSignal
        return pending.promise
      }
      h.fake.emit({ type: 'extension_ui_request', id: 'dlg-2', method: 'select', title: 'Allow tool: bash', options: ['A', 'B'] })
      await waitFor(() => signal !== undefined, 2_000, 'host prompt')
      h.fake.emit({ type: 'extension_ui_request', id: 'cancel-1', method: 'cancel', targetId: 'dlg-2' })
      await waitFor(() => signal?.aborted === true, 2_000, 'withdrawal')
      pending.resolve({ optionId: 'A' })
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(h.fake.commands.some((command) => command.type === 'extension_ui_response')).toBe(false)
    })

    it('ignores UI chatter that needs no reply', async () => {
      const h = await create()
      await h.start()
      h.fake.emit({ type: 'extension_ui_request', id: 'n1', method: 'notify', message: 'hello' })
      h.fake.emit({ type: 'extension_ui_request', id: 'w1', method: 'setWidget', widgetKey: 'k' })
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(h.fake.commands.some((command) => command.type === 'extension_ui_response')).toBe(false)
    })
  })

  describe('questions', () => {
    const responsesOf = (h: Harness): Json[] => h.fake.commands.filter((command) => command.type === 'extension_ui_response')

    /** Emit one `extension_ui_request` frame and wait for the transport's answer to it. */
    async function ask(h: Harness, frame: Json): Promise<Json> {
      h.fake.emit({ type: 'extension_ui_request', ...frame })
      await waitFor(() => responsesOf(h).some((response) => response.id === frame.id), 2_000, `answer to ${String(frame.id)}`)
      return jsonObject(responsesOf(h).find((response) => response.id === frame.id))
    }

    const SINGLE: Json = {
      id: 'q1',
      question: 'Which database?',
      header: ' Storage ',
      options: [
        { label: 'Postgres', description: ' Relational ' },
        { label: 'SQLite' },
      ],
      recommended: 1,
    }
    const MULTI: Json = {
      id: 'q2',
      question: 'Which checks?',
      multi: true,
      options: [{ label: 'lint' }, { label: 'unit' }, { label: 'e2e' }],
    }

    it('sends set_ask_dialog once during start when the host has a question surface, and never without one', async () => {
      const withSurface = await create({ questions: true })
      await withSurface.start()
      const types = withSurface.fake.commands.map((command) => command.type)
      expect(types.filter((type) => type === 'set_ask_dialog')).toHaveLength(1)
      expect(withSurface.fake.commandsOfType('set_ask_dialog')[0]).toMatchObject({ enabled: true })
      expect(types.indexOf('set_ask_dialog')).toBeGreaterThan(types.indexOf('set_event_filter'))
      expect(types.indexOf('set_ask_dialog')).toBeLessThan(types.indexOf('new_session'))

      const without = await create()
      await without.start()
      expect(without.fake.commands.some((command) => command.type === 'set_ask_dialog')).toBe(false)
    })

    it('starts anyway when OMP rejects set_ask_dialog', async () => {
      const logs: string[] = []
      const h = await create({ questions: true })
      h.fake.override('set_ask_dialog', () => {
        throw new FakeRpcError('Unknown command: set_ask_dialog')
      })
      await h.transport.start({
        argv: ['/bin/omp', 'acp'],
        env: { PI_CODING_AGENT_DIR: join(h.root, 'agent'), HOME: '/home/u' },
        cwd: '/work/here',
        spawn: fakeSpawn(h.fake, h.calls),
        session: { kind: 'new' },
        onEvent: () => undefined,
        onPermission: async () => ({ cancelled: true }),
        onElicitation: async () => ({ action: 'cancel' }),
        log: (message) => logs.push(message),
      })
      expect(h.transport.sessionId).toBe('fake-session-1')
      expect(logs.some((message) => message.includes('set_ask_dialog was rejected'))).toBe(true)
    })

    it('puts a single-select ask to the host as omp acp does: options, recommended default, header, free-text companion', async () => {
      const h = await create({ questions: true })
      await h.start()
      h.answer = async () => ({ action: 'cancel' })
      await ask(h, { id: 'a1', method: 'ask', questions: [SINGLE] })
      expect(h.elicitations).toEqual([
        {
          message: 'Which database?',
          requestedSchema: {
            type: 'object',
            properties: {
              q0: {
                type: 'string',
                title: 'Which database?',
                description: 'Storage',
                oneOf: [
                  { const: 'Postgres', title: 'Postgres', description: 'Relational' },
                  { const: 'SQLite', title: 'SQLite' },
                ],
                default: 'SQLite',
              },
              q0__other: { type: 'string', title: 'Other (type your own)' },
            },
          },
        },
      ])
      expect(h.elicitations[0]?.requestedSchema).not.toHaveProperty('required')
    })

    it('puts several questions in one form, multi-select as an array of anyOf options', async () => {
      const h = await create({ questions: true })
      await h.start()
      await ask(h, { id: 'a2', method: 'ask', questions: [SINGLE, MULTI] })
      const request = h.elicitations[0]
      expect(request?.message).toBe('Answer 2 questions')
      expect(request?.requestedSchema.properties).toEqual({
        q0: expect.objectContaining({ type: 'string', default: 'SQLite' }),
        q0__other: { type: 'string', title: 'Other (type your own)' },
        q1: {
          type: 'array',
          title: 'Which checks?',
          items: {
            anyOf: [
              { const: 'lint', title: 'lint' },
              { const: 'unit', title: 'unit' },
              { const: 'e2e', title: 'e2e' },
            ],
          },
        },
        q1__other: { type: 'string', title: 'Other (type your own)' },
      })
    })

    it('omits the default for an out-of-range recommended index', async () => {
      const h = await create({ questions: true })
      await h.start()
      await ask(h, { id: 'a3', method: 'ask', questions: [{ ...SINGLE, recommended: 7 }] })
      expect(h.elicitations[0]?.requestedSchema.properties?.q0).not.toHaveProperty('default')
    })

    it('names the running ask tool call on the form', async () => {
      const h = await create({ questions: true })
      await h.start()
      h.fake.override('prompt', () => {
        h.fake.emit({ type: 'agent_start' })
        h.fake.emit({ type: 'tool_execution_start', toolCallId: 'ask_7', toolName: 'ask', args: { questions: [] } })
        h.fake.emit({ type: 'extension_ui_request', id: 'a4', method: 'ask', questions: [SINGLE] })
        return undefined
      })
      const turn = h.transport.prompt(text('decide'), new AbortController().signal)
      turn.catch(() => undefined)
      await waitFor(() => responsesOf(h).length === 1, 2_000, 'ask answer')
      h.fake.emit({ type: 'prompt_result', id: h.fake.commandsOfType('prompt')[0]?.id, agentInvoked: true, status: 'completed', sessionSettled: true })
      await turn
      expect(h.elicitations[0]?.toolCallId).toBe('ask_7')
    })

    it('answers a picked option, one entry per question in order', async () => {
      const h = await create({ questions: true })
      await h.start()
      h.answer = async () => ({ action: 'accept', content: { q0: 'Postgres', q1: ['lint', 'e2e'] } })
      expect(await ask(h, { id: 'a5', method: 'ask', questions: [SINGLE, MULTI] })).toEqual({
        type: 'extension_ui_response',
        id: 'a5',
        answers: [
          { id: 'q1', selectedOptions: ['Postgres'] },
          { id: 'q2', selectedOptions: ['lint', 'e2e'] },
        ],
      })
    })

    it('keeps typed text and drops the pick of a single-select, trims it, and ignores blank text', async () => {
      const h = await create({ questions: true })
      await h.start()
      h.answer = async () => ({ action: 'accept', content: { q0: 'Postgres', q0__other: '  MySQL, please ', q1__other: '   ' } })
      expect(await ask(h, { id: 'a6', method: 'ask', questions: [SINGLE, MULTI] })).toEqual({
        type: 'extension_ui_response',
        id: 'a6',
        answers: [
          { id: 'q1', selectedOptions: [], customInput: 'MySQL, please' },
          { id: 'q2', selectedOptions: [] },
        ],
      })
    })

    it('sends picks together with typed text for a multi-select, deduplicated and only offered labels', async () => {
      const h = await create({ questions: true })
      await h.start()
      h.answer = async () => ({
        action: 'accept',
        content: { q0: ['lint', 'lint', 'invented', 'unit'], q0__other: 'also fuzz' },
      })
      expect(await ask(h, { id: 'a7', method: 'ask', questions: [MULTI] })).toEqual({
        type: 'extension_ui_response',
        id: 'a7',
        answers: [{ id: 'q2', selectedOptions: ['lint', 'unit'], customInput: 'also fuzz' }],
      })
    })

    it('answers a skipped question with no selection', async () => {
      const h = await create({ questions: true })
      await h.start()
      h.answer = async () => ({ action: 'accept', content: { q1: ['unit'] } })
      expect(await ask(h, { id: 'a8', method: 'ask', questions: [SINGLE, MULTI] })).toMatchObject({
        answers: [
          { id: 'q1', selectedOptions: [] },
          { id: 'q2', selectedOptions: ['unit'] },
        ],
      })
    })

    it('cancels the ask on decline, cancel, a throw, an accept without content and a malformed frame', async () => {
      const h = await create({ questions: true })
      await h.start()
      const outcomes: Array<[string, Harness['answer']]> = [
        ['d1', async () => ({ action: 'decline' })],
        ['d2', async () => ({ action: 'cancel' })],
        [
          'd3',
          async () => {
            throw new Error('ui gone')
          },
        ],
        ['d4', async () => ({ action: 'accept' })],
      ]
      for (const [id, answer] of outcomes) {
        h.answer = answer
        expect(await ask(h, { id, method: 'ask', questions: [SINGLE] })).toEqual({ type: 'extension_ui_response', id, cancelled: true })
      }
      const count = h.elicitations.length
      expect(await ask(h, { id: 'd5', method: 'ask', questions: [{ id: 'x' }] })).toEqual({
        type: 'extension_ui_response',
        id: 'd5',
        cancelled: true,
      })
      expect(h.elicitations).toHaveLength(count)
    })

    it('still routes an Allow tool select to onPermission and never to the question surface', async () => {
      const h = await create({ questions: true })
      await h.start()
      const answer = await ask(h, {
        id: 's1',
        method: 'select',
        title: 'Allow tool: bash\nCommand: ls',
        options: ['Approve', 'Deny'],
      })
      expect(answer).toEqual({ type: 'extension_ui_response', id: 's1', value: 'Approve' })
      expect(h.permissions).toHaveLength(1)
      expect(h.elicitations).toHaveLength(0)
    })

    it('turns any other select into a required value form and answers the chosen label', async () => {
      const h = await create({ questions: true })
      await h.start()
      h.answer = async () => ({ action: 'accept', content: { value: 'Beta' } })
      expect(await ask(h, { id: 's2', method: 'select', title: 'Pick a channel', options: ['Alpha', 'Beta'] })).toEqual({
        type: 'extension_ui_response',
        id: 's2',
        value: 'Beta',
      })
      expect(h.elicitations).toEqual([
        {
          message: 'Pick a channel',
          requestedSchema: { type: 'object', properties: { value: { type: 'string', enum: ['Alpha', 'Beta'] } }, required: ['value'] },
        },
      ])
      expect(h.permissions).toHaveLength(0)
      h.answer = async () => ({ action: 'decline' })
      expect(await ask(h, { id: 's3', method: 'select', title: 'Pick a channel', options: ['Alpha', 'Beta'] })).toEqual({
        type: 'extension_ui_response',
        id: 's3',
        cancelled: true,
      })
    })

    it('round-trips confirm, input and editor', async () => {
      const h = await create({ questions: true })
      await h.start()
      h.answer = async () => ({ action: 'accept', content: { value: true } })
      expect(await ask(h, { id: 'c1', method: 'confirm', title: 'Delete?', message: 'This cannot be undone' })).toEqual({
        type: 'extension_ui_response',
        id: 'c1',
        confirmed: true,
      })
      h.answer = async () => ({ action: 'accept', content: { value: false } })
      expect(await ask(h, { id: 'c2', method: 'confirm', title: 'Delete?', message: '  ' })).toEqual({
        type: 'extension_ui_response',
        id: 'c2',
        confirmed: false,
      })
      h.answer = async () => ({ action: 'decline' })
      expect(await ask(h, { id: 'c3', method: 'confirm', title: 'Delete?', message: '' })).toEqual({
        type: 'extension_ui_response',
        id: 'c3',
        cancelled: true,
      })
      h.answer = async () => ({ action: 'accept', content: { value: 'main' } })
      expect(await ask(h, { id: 'i1', method: 'input', title: 'Branch name', placeholder: ' e.g. main ' })).toEqual({
        type: 'extension_ui_response',
        id: 'i1',
        value: 'main',
      })
      expect(await ask(h, { id: 'i2', method: 'input', title: 'Anything else', placeholder: '  ' })).toMatchObject({ value: 'main' })
      h.answer = async () => ({ action: 'accept', content: { value: 'edited text' } })
      expect(await ask(h, { id: 'e1', method: 'editor', title: 'Edit the message', prefill: 'draft' })).toEqual({
        type: 'extension_ui_response',
        id: 'e1',
        value: 'edited text',
      })
      expect(await ask(h, { id: 'e2', method: 'editor', title: 'Empty one' })).toMatchObject({ value: 'edited text' })

      const required = ['value']
      expect(h.elicitations.map((request) => [request.message, request.requestedSchema.properties?.value, request.requestedSchema.required])).toEqual([
        ['Delete?\n\nThis cannot be undone', { type: 'boolean' }, required],
        ['Delete?', { type: 'boolean' }, required],
        ['Delete?', { type: 'boolean' }, required],
        ['Branch name', { type: 'string', description: ' e.g. main ' }, required],
        ['Anything else', { type: 'string' }, required],
        ['Edit the message', { type: 'string', default: 'draft' }, required],
        ['Empty one', { type: 'string' }, required],
      ])
    })

    it('dismisses an input whose answer is not text', async () => {
      const h = await create({ questions: true })
      await h.start()
      h.answer = async () => ({ action: 'accept', content: { value: 5 } })
      expect(await ask(h, { id: 'i3', method: 'input', title: 'Name' })).toEqual({ type: 'extension_ui_response', id: 'i3', cancelled: true })
    })

    it('withdraws a pending question when OMP sends a cancel frame and writes nothing afterwards', async () => {
      const h = await create({ questions: true })
      await h.start()
      let signal: AbortSignal | undefined
      const pending = Promise.withResolvers<{ action: 'accept'; content: Record<string, string[]> }>()
      h.answer = (_request, requestSignal) => {
        signal = requestSignal
        return pending.promise
      }
      h.fake.emit({ type: 'extension_ui_request', id: 'p1', method: 'ask', questions: [SINGLE] })
      await waitFor(() => signal !== undefined, 2_000, 'host question')
      expect(signal?.aborted).toBe(false)
      h.fake.emit({ type: 'extension_ui_request', id: 'cancel-2', method: 'cancel', targetId: 'p1' })
      await waitFor(() => signal?.aborted === true, 2_000, 'withdrawal')
      pending.resolve({ action: 'accept', content: { q0: ['Postgres'] } })
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(responsesOf(h)).toEqual([])
    })

    it('writes nothing for a question still pending when the transport closes', async () => {
      const h = await create({ questions: true })
      await h.start()
      const pending = Promise.withResolvers<{ action: 'cancel' }>()
      let asked = false
      h.answer = () => {
        asked = true
        return pending.promise
      }
      h.fake.emit({ type: 'extension_ui_request', id: 'p2', method: 'confirm', title: 'Sure?', message: '' })
      await waitFor(() => asked, 2_000, 'host question')
      await h.transport.close()
      pending.resolve({ action: 'cancel' })
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(responsesOf(h)).toEqual([])
    })

    it('dismisses every question kind when the host has no question surface, while approvals still reach onPermission', async () => {
      const h = await create()
      await h.start()
      const frames: Json[] = [
        { id: 'n1', method: 'ask', questions: [SINGLE] },
        { id: 'n2', method: 'select', title: 'Pick a channel', options: ['Alpha', 'Beta'] },
        { id: 'n3', method: 'confirm', title: 'Sure?', message: 'm' },
        { id: 'n4', method: 'input', title: 'Name' },
        { id: 'n5', method: 'editor', title: 'Edit', prefill: 'x' },
      ]
      for (const frame of frames) {
        expect(await ask(h, frame)).toEqual({ type: 'extension_ui_response', id: frame.id, cancelled: true })
      }
      expect(h.permissions).toHaveLength(0)
      expect(await ask(h, { id: 'n6', method: 'select', title: 'Allow tool: bash', options: ['Approve', 'Deny'] })).toEqual({
        type: 'extension_ui_response',
        id: 'n6',
        value: 'Approve',
      })
      expect(h.permissions).toHaveLength(1)
    })
  })

  describe('side questions', () => {
    const topic = (id: string, status: string, extra: Json = {}): Json => ({
      id,
      question: 'why?',
      answer: '',
      status,
      createdAt: 1,
      updatedAt: 2,
      leafId: 'leaf-1',
      ...extra,
    })
    const ask = (h: Harness, signal: AbortSignal = new AbortController().signal) =>
      h.transport.sideQuestion('why?', signal)

    /** omp's frame order for one question: the running record, then the response, then deltas and the final record. */
    function scriptQuestion(
      h: Harness,
      deltas: readonly string[],
      final: Json = topic('btw-1', 'complete', { answer: deltas.join('') }),
    ): void {
      h.fake.override('btw', () => {
        h.fake.emit({ type: 'btw_record', record: topic('btw-1', 'running') })
        setTimeout(() => {
          for (const delta of deltas) h.fake.emit({ type: 'btw_delta', recordId: 'btw-1', delta })
          h.fake.emit({ type: 'btw_record', record: final })
        }, 15)
        return { record: topic('btw-1', 'running') }
      })
    }

    it('answers while a prompt streams, and no side-question frame reaches the turn', async () => {
      const h = await create()
      await h.start()
      const { turn, promptId } = await openTurn(h)
      h.fake.emit(assistantFrame('message_start'))
      h.fake.emit(textDelta('main-1 '))
      scriptQuestion(h, ['BTW-', 'REPLY'])
      const answer = ask(h)
      h.fake.emit(textDelta('main-2 '))
      expect(await answer).toEqual({ kind: 'success', text: 'BTW-REPLY' })
      // The main turn kept streaming, was neither steered nor aborted, and ends normally.
      h.fake.emit({
        type: 'prompt_result',
        id: promptId,
        agentInvoked: true,
        status: 'completed',
        sessionSettled: true,
      })
      expect((await turn).stopReason).toBe('end_turn')
      expect(messageText(h)).toBe('main-1 main-2 ')
      expect(h.fake.commandsOfType('btw')).toEqual([expect.objectContaining({ question: 'why?' })])
      expect(h.fake.commandsOfType('steer')).toHaveLength(0)
      expect(h.fake.commandsOfType('abort')).toHaveLength(0)
    })

    it('decides on the latest turn of a topic, not on its stale top-level status', async () => {
      const h = await create()
      await h.start()
      // After a follow-up the topic's own fields stay `complete` (first turn) while the follow-up still runs.
      const followUp = (latest: Json): Json =>
        topic('btw-1', 'complete', {
          question: 'earlier',
          answer: 'old answer',
          followUps: [{ question: 'why?', createdAt: 3, updatedAt: 4, ...latest }],
        })
      h.fake.override('btw', () => {
        h.fake.emit({ type: 'btw_record', record: followUp({ status: 'running', answer: '' }) })
        setTimeout(() => {
          h.fake.emit({ type: 'btw_record', record: followUp({ status: 'running', answer: 'new ' }) })
          setTimeout(
            () => h.fake.emit({ type: 'btw_record', record: followUp({ status: 'complete', answer: 'new answer' }) }),
            20,
          )
        }, 10)
        return { record: followUp({ status: 'running', answer: '' }) }
      })
      expect(await ask(h)).toEqual({ kind: 'success', text: 'new answer' })
    })

    it('falls back to the streamed text when the final record carries no answer', async () => {
      const h = await create()
      await h.start()
      scriptQuestion(h, ['part ', 'two'], topic('btw-1', 'complete'))
      expect(await ask(h)).toEqual({ kind: 'success', text: 'part two' })
    })

    it.each([
      ['error', { error: 'provider exploded' }, 'provider exploded'],
      ['interrupted', {}, 'interrupted'],
    ])('reports a %s record as an error and keeps the partial answer', async (status, extra, headline) => {
      const h = await create()
      await h.start()
      scriptQuestion(h, ['half an ans'], topic('btw-1', status, { answer: 'half an ans', ...extra }))
      const result = await ask(h)
      expect(result.kind).toBe('error')
      expect(result.text).toContain(headline)
      expect(result.text).toContain('half an ans')
    })

    it.each(['A /btw question is still running; cancel it first', 'No active model available for /btw.'])(
      'turns the refusal %j into an error result and stays usable',
      async (message) => {
        const h = await create()
        await h.start()
        h.fake.override('btw', () => {
          throw new FakeRpcError(message)
        })
        expect(await ask(h)).toEqual({ kind: 'error', text: message })
        scriptQuestion(h, ['fine'])
        expect(await ask(h)).toEqual({ kind: 'success', text: 'fine' })
      },
    )

    it('refuses a blank question and a second concurrent question without asking omp', async () => {
      const h = await create()
      await h.start()
      h.fake.override('btw', () => NO_RESPONSE)
      const first = ask(h)
      first.catch(() => undefined)
      await waitFor(() => h.fake.commandsOfType('btw').length === 1, 2_000, 'first question')
      expect(await ask(h)).toMatchObject({ kind: 'error' })
      expect(await h.transport.sideQuestion('   ', new AbortController().signal)).toMatchObject({
        kind: 'error',
        text: expect.stringContaining('/btw'),
      })
      expect(h.fake.commandsOfType('btw')).toHaveLength(1)
    })

    it('cancels through btw_cancel on abort and resolves from the cancelled record that precedes the cancel response', async () => {
      const h = await create()
      await h.start()
      scriptQuestion(h, ['b0 ', 'b1 '], topic('btw-1', 'running'))
      h.fake.override('btw_cancel', () => {
        h.fake.emit({ type: 'btw_record', record: topic('btw-1', 'cancelled', { answer: 'b0 b1 ' }) })
        return { cancelled: true }
      })
      const controller = new AbortController()
      const answer = ask(h, controller.signal)
      await waitFor(() => h.fake.commandsOfType('btw').length === 1, 2_000, 'question')
      await sleep(40)
      controller.abort()
      const result = await answer
      expect(result.kind).toBe('error')
      expect(result.text).toContain('cancelled')
      expect(result.text).toContain('b0 b1')
      expect(h.fake.commandsOfType('btw_cancel')).toEqual([expect.objectContaining({ recordId: 'btw-1' })])
    })

    it('aims a second btw_cancel at the topic when the first went out before its id was known', async () => {
      const h = await create()
      await h.start()
      h.fake.override('btw', () => NO_RESPONSE)
      const controller = new AbortController()
      const answer = ask(h, controller.signal)
      await waitFor(() => h.fake.commandsOfType('btw').length === 1, 2_000, 'question')
      controller.abort()
      await waitFor(() => h.fake.commandsOfType('btw_cancel').length === 1, 2_000, 'first cancel')
      expect(h.fake.commandsOfType('btw_cancel')[0]).not.toHaveProperty('recordId')
      // omp takes the question up late: the running record and the response now name the topic.
      h.fake.emit({ type: 'btw_record', record: topic('btw-1', 'running') })
      h.fake.respond(h.fake.commandsOfType('btw')[0]?.id, 'btw', { record: topic('btw-1', 'running') })
      await waitFor(() => h.fake.commandsOfType('btw_cancel').length === 2, 2_000, 'second cancel')
      expect(h.fake.commandsOfType('btw_cancel')[1]).toMatchObject({ recordId: 'btw-1' })
      h.fake.emit({ type: 'btw_record', record: topic('btw-1', 'cancelled') })
      expect(await answer).toMatchObject({ kind: 'error' })
    })

    it('cancels a question the model never finishes', async () => {
      const h = await create({ transport: { btwTimeoutMs: 40 } })
      await h.start()
      scriptQuestion(h, ['slow '], topic('btw-1', 'running'))
      h.fake.override('btw_cancel', () => {
        h.fake.emit({ type: 'btw_record', record: topic('btw-1', 'cancelled', { answer: 'slow ' }) })
        return { cancelled: true }
      })
      const result = await ask(h)
      expect(result).toMatchObject({ kind: 'error', text: expect.stringContaining('too long') })
      expect(h.fake.commandsOfType('btw_cancel')).toHaveLength(1)
    })

    it('bounds a question omp never takes up by the same watchdog', async () => {
      const h = await create({ transport: { btwTimeoutMs: 40, abortGraceMs: 30 } })
      await h.start()
      h.fake.override('btw', () => NO_RESPONSE)
      const result = await ask(h)
      expect(result).toMatchObject({ kind: 'error', text: expect.stringContaining('too long') })
      // The cancel could not name a topic: omp never announced one.
      expect(h.fake.commandsOfType('btw_cancel')).toEqual([
        expect.not.objectContaining({ recordId: expect.anything() }),
      ])
    })

    it('ends the question even when omp never confirms the cancellation', async () => {
      const h = await create({ transport: { abortGraceMs: 30 } })
      await h.start()
      scriptQuestion(h, [], topic('btw-1', 'running'))
      const controller = new AbortController()
      const answer = ask(h, controller.signal)
      await waitFor(() => h.fake.commandsOfType('btw').length === 1, 2_000, 'question')
      controller.abort()
      expect(await answer).toMatchObject({ kind: 'error', text: expect.stringContaining('cancelled') })
      // The slot is free again.
      scriptQuestion(h, ['next'])
      expect(await ask(h)).toEqual({ kind: 'success', text: 'next' })
    })

    it('rejects when the process dies or the transport closes while a question is open', async () => {
      const dying = await create()
      await dying.start()
      dying.fake.override('btw', () => NO_RESPONSE)
      const lost = ask(dying)
      lost.catch(() => undefined)
      await waitFor(() => dying.fake.commandsOfType('btw').length === 1, 2_000, 'question')
      dying.fake.crash(139)
      await expect(lost).rejects.toMatchObject({ code: 'process-exit' })
      await expect(ask(dying)).rejects.toMatchObject({ code: 'process-exit' })

      const closing = await create()
      await closing.start()
      closing.fake.override('btw', () => NO_RESPONSE)
      const pending = ask(closing)
      pending.catch(() => undefined)
      await waitFor(() => closing.fake.commandsOfType('btw').length === 1, 2_000, 'question')
      await closing.transport.close()
      await expect(pending).rejects.toMatchObject({ code: 'closed' })
    })
  })

  describe('terminal-only commands', () => {
    it('answers a terminal-only builtin itself instead of sending it to the model', async () => {
      const h = await create()
      await h.start()
      expect(await h.transport.prompt(text('/settings'), new AbortController().signal)).toEqual({
        stopReason: 'end_turn',
      })
      expect(h.fake.commandsOfType('prompt')).toHaveLength(0)
      expect(messageText(h)).toContain('/settings')
    })

    it('refuses aliases, colon forms and the commands the host serves itself, one reply each', async () => {
      const h = await create()
      await h.start()
      for (const line of ['/q', '/providers extra args', '/new:now', '/clear', '/btw what?', '/rewind 2']) {
        const before = h.updates().length
        expect(await h.transport.prompt(text(line), new AbortController().signal)).toEqual({ stopReason: 'end_turn' })
        expect(h.updates().length - before, line).toBe(1)
      }
      expect(h.fake.commandsOfType('prompt')).toHaveLength(0)
    })

    it('sends everything else to omp: handled builtins, unknown names and ordinary text', async () => {
      const h = await create()
      await h.start()
      h.fake.override('prompt', () => ({ agentInvoked: false }))
      const lines: NativeContentBlock[][] = [
        text('/context'),
        text('/bogus-unknown arg'),
        text('hello /settings'),
        // Only a lone text block is a shell escape; with more blocks around it the line is ordinary text.
        [...text('!ls'), ...text('more')],
      ]
      for (const line of lines) {
        await h.transport.prompt(line, new AbortController().signal)
      }
      expect(h.fake.commandsOfType('prompt').map((command) => command.message)).toEqual([
        '/context',
        '/bogus-unknown arg',
        'hello /settings',
        '!ls\n\nmore',
      ])
    })

    it('lets a live extension, custom or file command keep a terminal-only name', async () => {
      const h = await create()
      await h.start()
      h.fake.override('prompt', () => ({ agentInvoked: false }))
      h.fake.emit({
        type: 'available_commands_update',
        commands: [
          { name: 'tree', description: 'my tree', source: 'extension' },
          { name: 'q', description: 'quick', source: 'file' },
        ],
      })
      await waitFor(() => h.events.some((event) => event.kind === 'commands'), 2_000, 'catalogue')
      await h.transport.prompt(text('/tree 3'), new AbortController().signal)
      await h.transport.prompt(text('/q'), new AbortController().signal)
      await h.transport.prompt(text('/settings'), new AbortController().signal)
      expect(h.fake.commandsOfType('prompt').map((command) => command.message)).toEqual(['/tree 3', '/q'])
      // The override ends with the catalogue entry that caused it.
      h.fake.emit({ type: 'available_commands_update', commands: [] })
      await waitFor(() => h.events.filter((event) => event.kind === 'commands').length === 2, 2_000, 'second catalogue')
      await h.transport.prompt(text('/tree 4'), new AbortController().signal)
      expect(h.fake.commandsOfType('prompt')).toHaveLength(2)
    })

    it('injects a slash line or a shell escape into the running turn like any other steering text', async () => {
      const h = await create()
      await h.start()
      // omp admits the text, consumes it at the next step boundary and records it as a steering message.
      h.fake.override('steer', (command) => {
        const message = String(command.message)
        h.fake.emit({ type: 'queue_update', steering: [message], followUp: [], liveSteered: 0 })
        setTimeout(() => {
          h.fake.emit({ type: 'queue_update', steering: [], followUp: [], liveSteered: 0 })
          h.fake.emit({
            type: 'message_start',
            message: { role: 'user', content: [{ type: 'text', text: message }], steering: true },
            messageId: `msg-${message}`,
          })
        }, 15)
        return undefined
      })
      const { turn, promptId } = await openTurn(h)
      // `promptRequired` would make the host interrupt this turn to prompt the line again.
      expect(await h.transport.steer(text('/settings'))).toBe('injected')
      expect(await h.transport.steer(text('!ls'))).toBe('injected')
      expect(h.fake.commandsOfType('steer').map((command) => command.message)).toEqual(['/settings', '!ls'])
      expect(h.fake.commandsOfType('bash')).toHaveLength(0)
      h.fake.emit({
        type: 'prompt_result',
        id: promptId,
        agentInvoked: true,
        status: 'completed',
        sessionSettled: true,
      })
      expect((await turn).stopReason).toBe('end_turn')
    })
  })

  describe('slash command completion', () => {
    it('ends a local command that omp closes with an aborted result nobody asked for (/fresh)', async () => {
      const h = await create()
      await h.start()
      h.fake.override('prompt', (command) => {
        setTimeout(() => {
          h.fake.emit({ type: 'command_output', text: 'Fresh provider session started.' })
          h.fake.emit({
            type: 'prompt_result',
            id: command.id,
            agentInvoked: true,
            status: 'aborted',
            sessionSettled: true,
          })
        }, 5)
        return undefined
      })
      expect((await h.transport.prompt(text('/fresh'), new AbortController().signal)).stopReason).toBe('end_turn')
      expect(messageText(h)).toBe('Fresh provider session started.')
    })

    it('still reports cancelled for an aborted result after a run started, or after a plain message', async () => {
      const h = await create()
      await h.start()
      const abortedBy = (withRun: boolean) => (command: Json) => {
        setTimeout(() => {
          if (withRun) h.fake.emit({ type: 'agent_start' })
          h.fake.emit({
            type: 'prompt_result',
            id: command.id,
            agentInvoked: true,
            status: 'aborted',
            sessionSettled: true,
          })
        }, 5)
        return undefined
      }
      h.fake.override('prompt', abortedBy(true))
      expect((await h.transport.prompt(text('/review'), new AbortController().signal)).stopReason).toBe('cancelled')
      h.fake.override('prompt', abortedBy(false))
      expect((await h.transport.prompt(text('hello'), new AbortController().signal)).stopReason).toBe('cancelled')
    })
  })

  describe('wake turns', () => {
    /** A run omp starts on its own once background work finished: it streams `delta` and yields. */
    function wakeRun(h: Harness, delta: string): void {
      h.fake.emit({ type: 'agent_start' })
      h.fake.emit(assistantFrame('message_start'))
      h.fake.emit(textDelta(delta))
      const message = {
        role: 'assistant',
        content: [{ type: 'text', text: delta }],
        usage: USAGE_TWO,
        stopReason: 'stop',
      }
      h.fake.emit({ type: 'message_end', messageId: 'msg-9', message })
      h.fake.emit({ type: 'agent_end', messages: [message], isTerminal: true, yielded: true })
    }

    /** The agent yielded its answer while a background job is still running. */
    async function yieldWithBackgroundWork(
      h: Harness,
      signal?: AbortSignal,
    ): Promise<{ turn: Promise<NativePromptResult>; settled: () => boolean }> {
      const { turn, promptId } = await openTurn(h, signal)
      h.fake.emit(assistantFrame('message_start'))
      h.fake.emit(textDelta('first answer. '))
      const message = {
        role: 'assistant',
        content: [{ type: 'text', text: 'first answer. ' }],
        usage: USAGE_ONE,
        stopReason: 'stop',
      }
      h.fake.emit({ type: 'message_end', messageId: 'msg-2', message })
      h.fake.emit({ type: 'agent_end', messages: [message], isTerminal: false, yielded: true, awaitingAsyncWork: true })
      h.fake.emit({
        type: 'prompt_result',
        id: promptId,
        agentInvoked: true,
        status: 'completed',
        sessionSettled: false,
      })
      let done = false
      const end = (): void => {
        done = true
      }
      turn.then(end, end)
      return { turn, settled: () => done }
    }

    it('keeps the turn open for the wake run and ends it when the session settles', async () => {
      const h = await create()
      await h.start()
      const { turn, settled } = await yieldWithBackgroundWork(h)
      await sleep(40)
      expect(settled()).toBe(false)
      wakeRun(h, 'background result. ')
      h.fake.emit({ type: 'session_settled' })
      const result = await turn
      expect(result.stopReason).toBe('end_turn')
      expect(messageText(h)).toBe('first answer. background result. ')
      // The wake run's model call belongs to this turn.
      expect(result.usage?.outputTokens).toBe(USAGE_ONE.output + USAGE_TWO.output)
    })

    it('ends a held turn after the settle window of silence, but never cuts a wake run that is producing output', async () => {
      const quiet = await create({ transport: { wakeSettleMs: 40 } })
      await quiet.start()
      expect((await (await yieldWithBackgroundWork(quiet)).turn).stopReason).toBe('end_turn')

      const busy = await create({ transport: { wakeSettleMs: 300 } })
      await busy.start()
      const { turn, settled } = await yieldWithBackgroundWork(busy)
      busy.fake.emit({ type: 'agent_start' })
      for (let index = 0; index < 5; index += 1) {
        await sleep(100)
        busy.fake.emit(textDelta(`w${index} `))
      }
      expect(settled()).toBe(false)
      busy.fake.emit({ type: 'session_settled' })
      await turn
      expect(messageText(busy)).toBe('first answer. w0 w1 w2 w3 w4 ')
    })

    it('does not settle a held turn from the terminal frame of the wake run', async () => {
      const h = await create({ transport: { promptResultFallbackMs: 30 } })
      await h.start()
      const { turn, settled } = await yieldWithBackgroundWork(h)
      wakeRun(h, 'background result. ')
      await sleep(120)
      expect(settled()).toBe(false)
      h.fake.emit({ type: 'session_settled' })
      await turn
    })

    it('does not mistake a retrying run for the end of the turn', async () => {
      const h = await create({ transport: { promptResultFallbackMs: 30 } })
      await h.start()
      const { turn, promptId } = await openTurn(h)
      const failed = {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: '429 rate limited',
        usage: {},
      }
      h.fake.emit({ type: 'agent_end', messages: [failed], isTerminal: false, yielded: false })
      let done = false
      turn.then(() => {
        done = true
      })
      await sleep(120)
      expect(done).toBe(false)
      wakeRun(h, 'retried answer. ')
      h.fake.emit({
        type: 'prompt_result',
        id: promptId,
        agentInvoked: true,
        status: 'completed',
        sessionSettled: true,
      })
      expect((await turn).stopReason).toBe('end_turn')
      expect(messageText(h)).toBe('retried answer. ')
    })

    it('ends a held turn on a steer instead of injecting into a run that is not there', async () => {
      const h = await create()
      await h.start()
      const { turn } = await yieldWithBackgroundWork(h)
      expect(await h.transport.steer(text('actually, do something else'))).toBe('promptRequired')
      expect(h.fake.commandsOfType('steer')).toHaveLength(0)
      expect((await turn).stopReason).toBe('end_turn')
    })

    it('injects a steer, slash lines included, while the wake run of a held turn is streaming', async () => {
      const h = await create()
      await h.start()
      h.fake.override('steer', (command) => {
        const message = String(command.message)
        h.fake.emit({ type: 'queue_update', steering: [message], followUp: [], liveSteered: 0 })
        setTimeout(() => {
          h.fake.emit({ type: 'queue_update', steering: [], followUp: [], liveSteered: 0 })
          h.fake.emit({
            type: 'message_start',
            message: { role: 'user', content: [{ type: 'text', text: message }], steering: true },
            messageId: 'msg-steer',
          })
        }, 15)
        return undefined
      })
      const { turn } = await yieldWithBackgroundWork(h)
      // A run is live again, so this is an ordinary running turn: bouncing the line would interrupt the wake run.
      h.fake.emit({ type: 'agent_start' })
      expect(await h.transport.steer(text('/theme dark'))).toBe('injected')
      expect(h.fake.commandsOfType('steer')).toEqual([expect.objectContaining({ message: '/theme dark' })])
      h.fake.emit({ type: 'agent_end', messages: [], isTerminal: true, yielded: true })
      h.fake.emit({ type: 'session_settled' })
      expect((await turn).stopReason).toBe('end_turn')
    })

    it('cancels a held turn at once when no run is left to confirm the abort', async () => {
      const h = await create({ transport: { abortGraceMs: 60_000 } })
      await h.start()
      const controller = new AbortController()
      const { turn } = await yieldWithBackgroundWork(h, controller.signal)
      controller.abort()
      expect((await turn).stopReason).toBe('cancelled')
    })

    it('ends a held turn normally when the process dies after the answer was given', async () => {
      const h = await create()
      await h.start()
      const { turn } = await yieldWithBackgroundWork(h)
      h.fake.crash(137)
      expect((await turn).stopReason).toBe('end_turn')
      expect(messageText(h)).toBe('first answer. ')
      await expect(h.transport.prompt(text('again'), new AbortController().signal)).rejects.toMatchObject({
        code: 'process-exit',
      })
    })

    it('reports a held turn cancelled when the user stops it while the wake run streams', async () => {
      const h = await create({ transport: { abortGraceMs: 60_000 } })
      await h.start()
      const controller = new AbortController()
      const { turn } = await yieldWithBackgroundWork(h, controller.signal)
      h.fake.emit({ type: 'agent_start' })
      await sleep(20)
      // omp stops the wake run and then reports the session settled.
      h.fake.override('abort', () => {
        setTimeout(() => h.fake.emit({ type: 'session_settled' }), 5)
        return undefined
      })
      controller.abort()
      expect((await turn).stopReason).toBe('cancelled')
      expect(h.fake.commandsOfType('abort')).toHaveLength(1)
    })

    it('keeps a held turn open while a wake run is live, however quiet it is', async () => {
      const h = await create({ transport: { wakeSettleMs: 150 } })
      await h.start()
      const { turn, settled } = await yieldWithBackgroundWork(h)
      h.fake.emit({ type: 'agent_start' })
      // More than three windows of silence with a run live: a tool call of a long run says nothing for a long time.
      await sleep(500)
      expect(settled()).toBe(false)
      // The run ends, and the session goes quiet without ever reporting it: that ends the turn after the window.
      h.fake.emit({ type: 'agent_end', messages: [], isTerminal: true, yielded: true })
      expect((await turn).stopReason).toBe('end_turn')
    })

    it('queues a prompt behind a run omp started on its own instead of failing it', async () => {
      const h = await create()
      await h.start()
      const stats = h.fake.commandsOfType('get_session_stats').length
      h.fake.emit({ type: 'agent_start' })
      // Busy tracking starts a context poll: once it is out, the transport has seen the run.
      await waitFor(() => h.fake.commandsOfType('get_session_stats').length > stats, 2_000, 'busy tracking')
      h.fake.override('prompt', (command) => {
        setTimeout(
          () =>
            h.fake.emit({
              type: 'prompt_result',
              id: command.id,
              agentInvoked: true,
              status: 'completed',
              sessionSettled: true,
            }),
          5,
        )
        return undefined
      })
      await h.transport.prompt(text('next'), new AbortController().signal)
      expect(h.fake.commandsOfType('prompt')[0]).toMatchObject({ message: 'next', streamingBehavior: 'followUp' })
      // The session settled with that result: the next prompt is a plain one again.
      await h.transport.prompt(text('after'), new AbortController().signal)
      expect(h.fake.commandsOfType('prompt')[1]).toMatchObject({ message: 'after' })
      expect(h.fake.commandsOfType('prompt')[1]).not.toHaveProperty('streamingBehavior')
    })
  })

  describe('notices', () => {
    it('shows retry, fallback and extension notices as thoughts while a turn is open', async () => {
      const h = await create()
      await h.start()
      const { turn, promptId } = await openTurn(h)
      h.fake.emit({
        type: 'auto_retry_start',
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2000,
        errorMessage: '429 rate limited',
      })
      h.fake.emit({ type: 'retry_fallback_applied', from: 'a/m1', to: 'b/m2', role: 'default' })
      h.fake.emit({
        type: 'extension_ui_request',
        id: 'n1',
        method: 'notify',
        message: 'picked beta',
        notifyType: 'info',
      })
      h.fake.emit({ type: 'notice', level: 'info', message: 'routine' })
      h.fake.emit({
        type: 'prompt_result',
        id: promptId,
        agentInvoked: true,
        status: 'completed',
        sessionSettled: true,
      })
      await turn
      expect(thoughtLines(h)).toEqual([
        'OMP retry 1/3 in 2000ms: 429 rate limited',
        'OMP switched model a/m1 → b/m2',
        'picked beta',
      ])
    })

    it('keeps them out of the turn stream when no turn is open, and still logs them', async () => {
      const h = await create()
      await h.start()
      h.fake.emit({
        type: 'auto_retry_start',
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2000,
        errorMessage: '429 rate limited',
      })
      h.fake.emit({
        type: 'extension_ui_request',
        id: 'n1',
        method: 'notify',
        message: 'late news',
        notifyType: 'info',
      })
      await waitFor(() => h.events.some((event) => event.kind === 'notice'), 2_000, 'notice')
      await sleep(20)
      expect(thoughtLines(h)).toEqual([])
      expect(h.events.find((event) => event.kind === 'notice')).toEqual({
        kind: 'notice',
        text: 'OMP retry 1/3 in 2000ms: 429 rate limited',
      })
    })
  })

  describe('user shell', () => {
    const shellResult = (extra: Json = {}): Json => ({
      exitCode: 0,
      cancelled: false,
      output: '',
      truncated: false,
      totalLines: 0,
      outputLines: 0,
      ...extra,
    })

    it('runs !cmd through rpc bash as one execute tool call, without a model call', async () => {
      const h = await create()
      await h.start()
      h.fake.override('bash', () => shellResult({ output: 'hi\n', totalLines: 1, outputLines: 1 }))
      expect(await h.transport.prompt(text('!echo hi'), new AbortController().signal)).toEqual({
        stopReason: 'end_turn',
      })
      expect(h.fake.commandsOfType('bash')).toEqual([expect.objectContaining({ command: 'echo hi' })])
      expect(h.fake.commandsOfType('prompt')).toHaveLength(0)
      const [call, done, ...rest] = h.updates()
      expect(rest).toEqual([])
      expect(call).toMatchObject({
        sessionUpdate: 'tool_call',
        name: 'bash',
        kind: 'execute',
        title: '$ echo hi',
        status: 'in_progress',
        rawInput: { command: 'echo hi' },
      })
      expect(done).toMatchObject({
        sessionUpdate: 'tool_call_update',
        toolCallId: fieldOf(call, 'toolCallId'),
        status: 'completed',
        rawOutput: { exitCode: 0, output: 'hi\n' },
      })
      expect(JSON.stringify(done)).toContain('hi')
    })

    it('marks a failing command failed, shows its exit code and strips terminal colors', async () => {
      const h = await create()
      await h.start()
      h.fake.override('bash', () => shellResult({ exitCode: 2, output: '\u001B[31mboom\u001B[0m\n' }))
      expect((await h.transport.prompt(text('!make'), new AbortController().signal)).stopReason).toBe('end_turn')
      const done = h.updates().at(-1)
      expect(done).toMatchObject({ sessionUpdate: 'tool_call_update', status: 'failed' })
      const shown = JSON.stringify(fieldOf(done, 'content'))
      expect(shown).toContain('boom')
      expect(shown).toContain('exit code 2')
      expect(shown).not.toContain('\\u001b')
    })

    it('kills the command with abort_bash on abort and reports the turn cancelled', async () => {
      const h = await create()
      await h.start()
      h.fake.override('bash', () => NO_RESPONSE)
      h.fake.override('abort_bash', () => {
        const bash = h.fake.commandsOfType('bash')[0]
        setTimeout(
          () => h.fake.respond(bash?.id, 'bash', shellResult({ cancelled: true, output: '[Command cancelled]\n' })),
          5,
        )
        return undefined
      })
      const controller = new AbortController()
      const turn = h.transport.prompt(text('!sleep 30'), controller.signal)
      await waitFor(() => h.fake.commandsOfType('bash').length === 1, 2_000, 'bash')
      controller.abort()
      expect(await turn).toEqual({ stopReason: 'cancelled' })
      expect(h.fake.commandsOfType('abort_bash')).toHaveLength(1)
      expect(h.updates().at(-1)).toMatchObject({ sessionUpdate: 'tool_call_update', status: 'failed' })
    })

    it('ends the turn when omp never confirms the kill', async () => {
      const h = await create({ transport: { abortGraceMs: 30 } })
      await h.start()
      h.fake.override('bash', () => NO_RESPONSE)
      const controller = new AbortController()
      const turn = h.transport.prompt(text('!sleep 30'), controller.signal)
      await waitFor(() => h.fake.commandsOfType('bash').length === 1, 2_000, 'bash')
      controller.abort()
      expect(await turn).toEqual({ stopReason: 'cancelled' })
      expect(h.updates().at(-1)).toMatchObject({ sessionUpdate: 'tool_call_update', status: 'failed' })
      // The slot is free for the next turn.
      h.fake.override('prompt', () => ({ agentInvoked: false }))
      await h.transport.prompt(text('hello'), new AbortController().signal)
    })

    it('shows an rpc refusal as a failed call and still ends the turn', async () => {
      const h = await create()
      await h.start()
      h.fake.override('bash', () => {
        throw new FakeRpcError('Shell is disabled')
      })
      expect((await h.transport.prompt(text('!ls'), new AbortController().signal)).stopReason).toBe('end_turn')
      const done = h.updates().at(-1)
      expect(done).toMatchObject({ sessionUpdate: 'tool_call_update', status: 'failed' })
      expect(JSON.stringify(done)).toContain('Shell is disabled')
    })

    it('fails the call and rejects when the process dies mid-command', async () => {
      const h = await create()
      await h.start()
      h.fake.override('bash', () => NO_RESPONSE)
      const turn = h.transport.prompt(text('!sleep 30'), new AbortController().signal)
      turn.catch(() => undefined)
      await waitFor(() => h.fake.commandsOfType('bash').length === 1, 2_000, 'bash')
      h.fake.crash(137)
      await expect(turn).rejects.toMatchObject({ code: 'process-exit' })
      expect(h.updates().at(-1)).toMatchObject({ sessionUpdate: 'tool_call_update', status: 'failed' })
    })

    it('refuses !! and a bare ! locally', async () => {
      const h = await create()
      await h.start()
      for (const line of ['!!ls', '!', '!   ']) {
        const before = h.updates().length
        expect(await h.transport.prompt(text(line), new AbortController().signal)).toEqual({ stopReason: 'end_turn' })
        expect(h.updates().length - before, line).toBe(1)
      }
      expect(h.fake.commandsOfType('bash')).toHaveLength(0)
      expect(h.fake.commandsOfType('prompt')).toHaveLength(0)
    })

    it('holds the prompt slot while the command runs', async () => {
      const h = await create()
      await h.start()
      h.fake.override('bash', () => NO_RESPONSE)
      const turn = h.transport.prompt(text('!sleep 1'), new AbortController().signal)
      await waitFor(() => h.fake.commandsOfType('bash').length === 1, 2_000, 'bash')
      await expect(h.transport.prompt(text('second'), new AbortController().signal)).rejects.toMatchObject({
        code: 'prompt-in-flight',
      })
      expect(await h.transport.steer(text('anything'))).toBe('promptRequired')
      h.fake.respond(h.fake.commandsOfType('bash')[0]?.id, 'bash', shellResult())
      expect((await turn).stopReason).toBe('end_turn')
    })
  })

  describe('fast and slow controls', () => {
    const valueOf = (h: Harness, id: string): string | boolean | undefined =>
      h.transport.controls().configOptions.find((option) => option.id === id)?.currentValue

    it('offers fast, and slow only for a model that supports it, as boolean options', async () => {
      const h = await create()
      h.fake.state.fastModeEnabled = false
      h.fake.state.slowModeSupported = true
      h.fake.state.slowModeEnabled = true
      await h.start()
      expect(h.transport.controls().configOptions.map((option) => [option.id, option.type])).toEqual([
        ['mode', 'select'],
        ['model', 'select'],
        ['thinking', 'select'],
        ['fast', 'boolean'],
        ['slow', 'boolean'],
      ])
      expect([valueOf(h, 'fast'), valueOf(h, 'slow')]).toEqual([false, true])
    })

    it('applies the toggles through rpc and reads the value back without a controls event', async () => {
      const h = await create()
      h.fake.state.fastModeEnabled = false
      h.fake.state.slowModeSupported = true
      await h.start()
      const before = h.events.length
      await h.transport.setConfigOption('fast', true)
      await h.transport.setConfigOption('slow', true)
      expect(h.fake.commandsOfType('set_fast_mode')).toEqual([expect.objectContaining({ enabled: true })])
      expect(h.fake.commandsOfType('set_slow_mode')).toEqual([expect.objectContaining({ enabled: true })])
      expect([valueOf(h, 'fast'), valueOf(h, 'slow')]).toEqual([true, true])
      await h.transport.setConfigOption('fast', false)
      expect(valueOf(h, 'fast')).toBe(false)
      expect(h.events.slice(before).filter((event) => event.kind === 'controls')).toEqual([])
    })

    it('surfaces omp refusing a toggle and keeps the previous value', async () => {
      const h = await create()
      h.fake.state.fastModeEnabled = false
      await h.start()
      h.fake.override('set_fast_mode', () => {
        throw new FakeRpcError('Fast mode is unavailable for the current model.')
      })
      const failure = await h.transport.setConfigOption('fast', true).catch((error: unknown) => error)
      expect(failure).toMatchObject({
        code: 'request-failed',
        detail: 'Fast mode is unavailable for the current model.',
      })
      expect(valueOf(h, 'fast')).toBe(false)
    })

    it('rejects a string for a toggle and a toggle omp does not offer', async () => {
      const h = await create()
      h.fake.state.fastModeEnabled = false
      await h.start()
      expect(await h.transport.setConfigOption('fast', 'on').catch((error: unknown) => error)).toMatchObject({
        code: 'unsupported-config-value',
      })
      expect(await h.transport.setConfigOption('slow', true).catch((error: unknown) => error)).toMatchObject({
        code: 'unknown-config-option',
      })
      expect(h.fake.commandsOfType('set_fast_mode')).toHaveLength(0)
      expect(h.fake.commandsOfType('set_slow_mode')).toHaveLength(0)
    })

    it('reads the toggles back after a typed slash command changed them', async () => {
      const h = await create()
      h.fake.state.fastModeEnabled = false
      await h.start()
      h.fake.override('prompt', () => {
        h.fake.state.fastModeEnabled = true
        return { agentInvoked: false }
      })
      await h.transport.prompt(text('/fast on'), new AbortController().signal)
      await waitFor(() => h.events.some((event) => event.kind === 'controls'), 2_000, 'controls event')
      expect(valueOf(h, 'fast')).toBe(true)
    })
  })

  describe('immediate commands', () => {
    const run = (h: Harness, name: string) => h.transport.runCommand(name, '', new AbortController().signal)
    const valueOf = (h: Harness, id: string): string | boolean | undefined =>
      h.transport.controls().configOptions.find((option) => option.id === id)?.currentValue

    it('starts a new session for /new and tells the host before the command resolves', async () => {
      const h = await create()
      await h.start()
      expect(h.transport.sessionId).toBe('fake-session-1')
      // The new session reports other defaults than the one it replaces.
      h.fake.state.thinkingLevel = 'low'
      const result = await run(h, 'new')
      expect(result.kind).toBe('success')
      expect(result.text).toContain('fake-session-2')
      expect(h.fake.commandsOfType('new_session')).toHaveLength(2)
      expect(h.transport.sessionId).toBe('fake-session-2')
      expect(h.transport.sessionFilePath).toBe(h.fake.state.sessionFile)
      expect(h.events.filter((event) => event.kind === 'session_changed')).toEqual([
        { kind: 'session_changed', sessionId: 'fake-session-2', reason: 'new' },
      ])
      expect(valueOf(h, 'thinking')).toBe('low')
    })

    it('reports /clear with its own reason', async () => {
      const h = await create()
      await h.start()
      expect((await run(h, 'clear')).kind).toBe('success')
      expect(h.events.filter((event) => event.kind === 'session_changed')).toEqual([
        { kind: 'session_changed', sessionId: 'fake-session-2', reason: 'clear' },
      ])
    })

    it('needs an idle session: nothing is sent while a turn runs', async () => {
      const h = await create()
      await h.start()
      const { turn, promptId } = await openTurn(h)
      expect(await run(h, 'new')).toMatchObject({ kind: 'error' })
      expect(h.fake.commandsOfType('new_session')).toHaveLength(1)
      h.fake.emit({
        type: 'prompt_result',
        id: promptId,
        agentInvoked: true,
        status: 'completed',
        sessionSettled: true,
      })
      await turn
      expect((await run(h, 'new')).kind).toBe('success')
    })

    it('reports an extension veto and an rpc refusal as errors and keeps the session', async () => {
      const h = await create()
      await h.start()
      h.fake.override('new_session', () => ({ cancelled: true }))
      expect(await run(h, 'new')).toMatchObject({ kind: 'error', text: expect.stringContaining('vetoed') })
      h.fake.override('new_session', () => {
        throw new FakeRpcError('session store is read-only')
      })
      expect(await run(h, 'clear')).toEqual({ kind: 'error', text: 'session store is read-only' })
      expect(h.transport.sessionId).toBe('fake-session-1')
      expect(h.events.filter((event) => event.kind === 'session_changed')).toEqual([])
    })

    it('answers a command it does not run without a turn with an error', async () => {
      const h = await create()
      await h.start()
      expect(await run(h, 'compact')).toMatchObject({ kind: 'error' })
      const aborted = new AbortController()
      aborted.abort()
      expect(await h.transport.runCommand('new', '', aborted.signal)).toMatchObject({ kind: 'error' })
      expect(h.fake.commandsOfType('new_session')).toHaveLength(1)
    })
  })

  describe('config overlay', () => {
    const overlayOf = (h: Harness): string | undefined => {
      const argv = h.calls.find((call) => !call.argv.includes('--version'))?.argv ?? []
      const at = argv.lastIndexOf('--config')
      return at === -1 ? undefined : argv[at + 1]
    }

    it("launches omp with an overlay that lets goals continue over rpc, after the launcher's own --config", async () => {
      const h = await create()
      await h.start(undefined, ['/bin/omp', 'acp', '--config', '/etc/mine.yml'])
      const argv = h.calls.find((call) => !call.argv.includes('--version'))?.argv ?? []
      expect(argv.slice(0, 3)).toEqual(['/bin/omp', '--config', '/etc/mine.yml'])
      const file = overlayOf(h) ?? ''
      expect(argv.indexOf('--config')).toBeLessThan(argv.lastIndexOf('--config'))
      expect(file.startsWith(join(h.root, 'overlays'))).toBe(true)
      expect(await readFile(file, 'utf8')).toMatch(/continuationModes:.*\brpc\b/)
      // The version probe asks the same launcher and has no use for it.
      expect(h.calls.find((call) => call.argv.includes('--version'))?.argv).not.toContain(file)
    })

    it('removes the overlay with the process: on close, after a crash, and when start fails', async () => {
      const closed = await create()
      await closed.start()
      const closedFile = overlayOf(closed) ?? ''
      expect(existsSync(closedFile)).toBe(true)
      await closed.transport.close()
      expect(existsSync(dirname(closedFile))).toBe(false)

      const crashed = await create()
      await crashed.start()
      const crashedFile = overlayOf(crashed) ?? ''
      expect(existsSync(crashedFile)).toBe(true)
      crashed.fake.crash(1)
      await waitFor(() => !existsSync(dirname(crashedFile)), 2_000, 'the overlay to go after the crash')

      const failed = await create({ fakeOptions: { sendReady: false }, transport: { readyTimeoutMs: 50 } })
      await expect(failed.start()).rejects.toMatchObject({ code: 'ready-timeout' })
      expect(overlayOf(failed)).toBeDefined()
      expect(await readdir(join(failed.root, 'overlays'))).toEqual([])
    })

    it('removes the overlay when the process cannot be spawned', async () => {
      const h = await create()
      await expect(
        h.transport.start({
          argv: ['/bin/omp'],
          env: {},
          cwd: '/work/here',
          spawn: () => {
            throw new Error('ENOENT: omp')
          },
          session: { kind: 'new' },
          onEvent: () => undefined,
          onPermission: async () => ({ cancelled: true }),
        }),
      ).rejects.toMatchObject({ code: 'spawn-failed' })
      expect(await readdir(join(h.root, 'overlays'))).toEqual([])
    })

    it('keeps no overlay behind when the transport is closed while it is being written', async () => {
      const h = await create()
      const started = h.start()
      started.catch(() => undefined)
      await h.transport.close()
      await expect(started).rejects.toMatchObject({ code: 'closed' })
      expect(await readdir(join(h.root, 'overlays')).catch(() => [])).toEqual([])
    })

    it('runs without a --config of its own when the overlay cannot be written', async () => {
      const h = await create({ transport: { overlayRoot: await blockedOverlayRoot() } })
      await h.start()
      expect(overlayOf(h)).toBeUndefined()
      expect(h.transport.sessionId).toBe('fake-session-1')
      expect(h.transport.closed).toBe(false)
    })
  })

  describe('goal command', () => {
    const say = (h: Harness, args: string, signal: AbortSignal = new AbortController().signal) =>
      h.transport.prompt(text(args === '' ? '/goal' : `/goal ${args}`), signal)
    const goalOps = (h: Harness): unknown[] => h.fake.commandsOfType('goal').map((command) => command.op)
    const active = (extra: Json = {}): Json => ({
      id: 'goal-1',
      objective: 'fix the build',
      status: 'active',
      tokensUsed: 0,
      timeUsedSeconds: 0,
      ...extra,
    })

    /** A run omp starts by itself for the goal: it streams `delta` and yields. */
    function continuation(h: Harness, delta: string): void {
      h.fake.emit({ type: 'agent_start' })
      h.fake.emit(assistantFrame('message_start'))
      h.fake.emit(textDelta(delta))
      const message = { role: 'assistant', content: [{ type: 'text', text: delta }], usage: USAGE_TWO, stopReason: 'stop' }
      h.fake.emit({ type: 'message_end', messageId: 'msg-9', message })
      h.fake.emit({ type: 'agent_end', messages: [message], isTerminal: true, yielded: true })
    }

    /** The command was answered and omp reported itself not settled: the turn is held for the runs that follow. */
    async function held(
      h: Harness,
      args: string,
      signal?: AbortSignal,
    ): Promise<{ turn: Promise<NativePromptResult>; done: () => boolean }> {
      h.fake.state.settled = false
      const reads = h.fake.commandsOfType('get_state').length
      const turn = say(h, args, signal)
      let finished = false
      const end = (): void => {
        finished = true
      }
      turn.then(end, end)
      await waitFor(() => h.fake.commandsOfType('get_state').length > reads, 2_000, 'the state read after the goal command')
      await sleep(30)
      return { turn, done: () => finished }
    }

    it('answers /goal through rpc and never sends the line to the model', async () => {
      const h = await create()
      await h.start()
      expect((await say(h, '')).stopReason).toBe('end_turn')
      expect(messageText(h)).toMatch(/no goal/i)
      h.fake.state.goal = active({ status: 'paused', tokensUsed: 1_200 })
      expect((await say(h, 'status')).stopReason).toBe('end_turn')
      expect(messageText(h)).toContain('fix the build')
      expect(messageText(h)).toContain('paused')
      expect(goalOps(h)).toEqual(['get', 'get'])
      expect(h.fake.commandsOfType('prompt')).toHaveLength(0)
    })

    it('creates a goal and ends the turn with the goal alone when omp does not go on by itself', async () => {
      const h = await create()
      await h.start()
      expect((await say(h, 'fix the build')).stopReason).toBe('end_turn')
      expect(h.fake.commandsOfType('goal')).toEqual([expect.objectContaining({ op: 'create', objective: 'fix the build' })])
      expect(h.fake.state.goal).toMatchObject({ status: 'active' })
      // The reply tells what the command did, so the frame it caused adds no note of its own.
      expect(thoughtLines(h)).toEqual([])
      // omp was launched with the overlay, so a goal that stays put is its own decision: no remark about the configuration.
      expect(h.updates().filter((update) => update.sessionUpdate === 'agent_message_chunk')).toHaveLength(1)
      expect(messageText(h)).toContain('fix the build')
      expect(messageText(h)).not.toContain('continuationModes')
    })

    it('says that the goal waits for the next message when the overlay could not be applied', async () => {
      const h = await create({ transport: { overlayRoot: await blockedOverlayRoot() } })
      await h.start()
      expect((await say(h, 'fix the build')).stopReason).toBe('end_turn')
      expect(h.updates().filter((update) => update.sessionUpdate === 'agent_message_chunk')).toHaveLength(2)
      expect(messageText(h)).toContain('fix the build')
      expect(messageText(h)).toContain('continuationModes')
    })

    it('holds the turn for the runs omp starts by itself, and lets them reach it', async () => {
      const h = await create()
      await h.start()
      const { turn, done } = await held(h, 'fix the build')
      expect(done()).toBe(false)
      continuation(h, 'working on it. ')
      // The counters moving are no news; the goal finishing is.
      h.fake.emit({ type: 'goal_updated', goal: active({ tokensUsed: 300 }) })
      h.fake.emit({ type: 'goal_updated', goal: active({ status: 'complete', tokensUsed: 500 }) })
      expect(done()).toBe(false)
      h.fake.emit({ type: 'session_settled' })
      const result = await turn
      expect(result.stopReason).toBe('end_turn')
      expect(result.usage?.outputTokens).toBe(USAGE_TWO.output)
      const reply = messageText(h)
      expect(reply.indexOf('fix the build')).toBeGreaterThanOrEqual(0)
      expect(reply.indexOf('fix the build')).toBeLessThan(reply.indexOf('working on it. '))
      expect(thoughtLines(h)).toHaveLength(1)
      expect(thoughtLines(h)[0]).toContain('complete')
      expect(h.fake.commandsOfType('prompt')).toHaveLength(0)
    })

    it('ends a held goal turn when the user stops it', async () => {
      const h = await create({ transport: { abortGraceMs: 60_000 } })
      await h.start()
      const controller = new AbortController()
      const { turn } = await held(h, 'fix the build', controller.signal)
      controller.abort()
      expect((await turn).stopReason).toBe('cancelled')
      expect(h.fake.commandsOfType('abort')).toHaveLength(1)
    })

    it('ends a held goal turn on a steer: the line the user typed runs as a prompt of its own', async () => {
      const h = await create()
      await h.start()
      const { turn } = await held(h, 'fix the build')
      expect(await h.transport.steer(text('actually, stop'))).toBe('promptRequired')
      expect(h.fake.commandsOfType('steer')).toHaveLength(0)
      expect((await turn).stopReason).toBe('end_turn')
    })

    it('does not hold the turn when omp settled while the transport was deciding', async () => {
      // Without the overlay the remark would be due; a run that already happened makes it wrong.
      const h = await create({ transport: { wakeSettleMs: 60_000, overlayRoot: await blockedOverlayRoot() } })
      await h.start()
      h.fake.state.settled = false
      // The run was short: it started, answered and settled before the state read came back.
      h.fake.state.onGetState = () => {
        h.fake.state.onGetState = undefined
        continuation(h, 'quick. ')
        h.fake.emit({ type: 'session_settled' })
      }
      const outcome = await Promise.race([say(h, 'fix the build'), sleep(1_000).then(() => 'held' as const)])
      expect(outcome).not.toBe('held')
      expect(messageText(h)).toContain('quick. ')
      expect(messageText(h)).not.toContain('continuationModes')
    })

    it('answers the refusals of omp as the reply of the turn, not as a failure', async () => {
      const h = await create()
      await h.start()
      h.fake.state.goal = active()
      expect((await say(h, 'another goal')).stopReason).toBe('end_turn')
      expect(messageText(h)).toContain('/goal clear')
      h.fake.state.goal = null
      h.fake.state.goalDisabled = true
      expect((await say(h, 'a goal')).stopReason).toBe('end_turn')
      expect(messageText(h)).toContain('goal.enabled')
    })

    it('clears, pauses and resumes through rpc, and holds a resumed goal like a new one', async () => {
      const h = await create()
      await h.start()
      // Nothing to clear: omp is not asked to drop anything. Nothing to pause: the answer says so.
      await say(h, 'clear')
      await say(h, 'pause')
      expect(goalOps(h)).toEqual(['get', 'pause'])
      h.fake.state.goal = active()
      await say(h, 'pause')
      expect(h.fake.state.goal).toMatchObject({ status: 'paused' })
      const { turn } = await held(h, 'resume')
      expect(h.fake.state.goal).toMatchObject({ status: 'active' })
      h.fake.emit({ type: 'session_settled' })
      expect((await turn).stopReason).toBe('end_turn')
      await say(h, 'clear')
      expect(h.fake.state.goal).toBeNull()
      expect(goalOps(h)).toEqual(['get', 'pause', 'pause', 'resume', 'get', 'drop'])
      expect(thoughtLines(h)).toEqual([])
    })

    it('refuses a control word with more words after it without calling omp', async () => {
      const h = await create()
      await h.start()
      await say(h, 'pause the deployment pipeline')
      expect(h.fake.commandsOfType('goal')).toHaveLength(0)
      expect(messageText(h)).toContain('/goal set pause the deployment pipeline')
    })

    it('leaves /goal to a user command of that name', async () => {
      const h = await create()
      await h.start()
      h.fake.override('prompt', () => ({ agentInvoked: false }))
      h.fake.emit({ type: 'available_commands_update', commands: [{ name: 'goal', description: 'Mine', source: 'file' }] })
      await waitFor(() => h.events.some((event) => event.kind === 'commands'), 2_000, 'catalogue')
      await say(h, 'ship it')
      expect(h.fake.commandsOfType('prompt').map((command) => command.message)).toEqual(['/goal ship it'])
      expect(h.fake.commandsOfType('goal')).toHaveLength(0)
    })

    it('rejects the turn when the process dies under the command', async () => {
      const h = await create()
      await h.start()
      h.fake.override('goal', () => NO_RESPONSE)
      const turn = say(h, 'fix the build')
      turn.catch(() => undefined)
      await waitFor(() => h.fake.commandsOfType('goal').length === 1, 2_000, 'goal command')
      h.fake.crash(137)
      await expect(turn).rejects.toMatchObject({ code: 'process-exit' })
    })

    it('shows a goal that changed during an ordinary turn as a note of that turn, and only logs one outside a turn', async () => {
      const h = await create()
      await h.start()
      h.fake.emit({ type: 'goal_updated', goal: active() })
      await sleep(20)
      const { turn, promptId } = await openTurn(h)
      h.fake.emit({ type: 'goal_updated', goal: active({ status: 'complete' }) })
      h.fake.emit({ type: 'prompt_result', id: promptId, agentInvoked: true, status: 'completed', sessionSettled: true })
      await turn
      expect(thoughtLines(h)).toHaveLength(1)
      expect(thoughtLines(h)[0]).toContain('complete')
      expect(h.events.filter((event) => event.kind === 'notice')).toHaveLength(2)
    })
  })

  describe('rewind command', () => {
    const rewind = (h: Harness, args: string, signal: AbortSignal = new AbortController().signal) =>
      h.transport.runCommand('rewind', args, signal)
    const changed = (h: Harness) => h.events.filter((event) => event.kind === 'session_changed')
    const rows = (text: string): string[] => text.split('\n').filter((line) => /^\| \d+ \|/.test(line))

    async function started(): Promise<{ h: Harness; cwd: string }> {
      const cwd = await tempDir('omp-rewind-cwd-')
      const h = await create({ cwd })
      await h.start()
      return { h, cwd }
    }

    /** Two user messages and the file changes the agent made for them; the files are on disk as the agent left them. */
    async function conversation(): Promise<{ h: Harness; a: string; b: string }> {
      const { h, cwd } = await started()
      const a = join(cwd, 'a.txt')
      const b = join(cwd, 'b.txt')
      await writeFile(a, 'two\n')
      await writeFile(b, 'new\n')
      h.fake.state.entries = [
        entryUser('u1', null, 'first task'),
        entryResult('r1', 'u1', 'c1', 'edit', { op: 'update', path: a, oldText: 'zero\n', newText: 'one\n' }),
        entryUser('u2', 'r1', 'second task'),
        entryResult('r2', 'u2', 'c2', 'edit', { op: 'update', path: a, oldText: 'one\n', newText: 'two\n' }),
        entryResult('r3', 'r2', 'c3', 'edit', { op: 'create', path: b, newText: 'new\n' }),
      ]
      h.fake.state.leafId = 'r3'
      return { h, a, b }
    }

    it('lists the user messages on the current path, newest last, from the session entries', async () => {
      const { h } = await conversation()
      // A branch that was left is not part of the conversation.
      h.fake.state.entries?.push(entryUser('side', 'r1', 'a branch that was left'))
      const result = await rewind(h, '')
      expect(result.kind).toBe('success')
      const listed = rows(result.text)
      expect(listed).toHaveLength(2)
      expect(listed[0]).toContain('first task')
      expect(listed[1]).toContain('second task')
      expect(h.fake.commandsOfType('get_entries')).toHaveLength(1)
      expect(h.fake.commandsOfType('branch')).toHaveLength(0)
    })

    it('previews without changing anything, also while a turn runs', async () => {
      const { h, a, b } = await conversation()
      const { turn, promptId } = await openTurn(h)
      const preview = await rewind(h, '2')
      expect(preview.kind).toBe('success')
      expect(preview.text).toContain('a.txt')
      expect(preview.text).toContain('b.txt')
      expect(await readFile(a, 'utf8')).toBe('two\n')
      expect(existsSync(b)).toBe(true)
      expect(h.fake.commandsOfType('branch')).toHaveLength(0)
      h.fake.emit({ type: 'prompt_result', id: promptId, agentInvoked: true, status: 'completed', sessionSettled: true })
      await turn
    })

    it('restores the files, then moves the conversation to a branch and tells the host the session it is in now', async () => {
      const { h, a, b } = await conversation()
      let filesWereBackWhenBranched = false
      h.fake.state.onBranch = () => {
        filesWereBackWhenBranched = !existsSync(b)
      }
      const result = await rewind(h, '2 confirm')
      expect(result.kind).toBe('success')
      expect(await readFile(a, 'utf8')).toBe('one\n')
      expect(existsSync(b)).toBe(false)
      expect(filesWereBackWhenBranched).toBe(true)
      expect(h.fake.commandsOfType('branch')).toEqual([expect.objectContaining({ entryId: 'u2' })])
      expect(changed(h)).toEqual([{ kind: 'session_changed', sessionId: 'fake-session-2', reason: 'rewind' }])
      expect(h.transport.sessionId).toBe('fake-session-2')
      expect(h.transport.sessionFilePath).toBe(h.fake.state.sessionFile)
      // What the branch holds is what the next listing reads, and the next rewind undoes the older edit too.
      expect(rows((await rewind(h, '')).text)).toHaveLength(1)
      expect((await rewind(h, '1 confirm')).kind).toBe('success')
      expect(await readFile(a, 'utf8')).toBe('zero\n')
    })

    it('restores only the files for `code` and only the conversation for `chat`', async () => {
      const code = await conversation()
      expect((await rewind(code.h, '2 code confirm')).kind).toBe('success')
      expect(await readFile(code.a, 'utf8')).toBe('one\n')
      expect(existsSync(code.b)).toBe(false)
      expect(code.h.fake.commandsOfType('branch')).toHaveLength(0)
      expect(changed(code.h)).toEqual([])
      expect(code.h.transport.sessionId).toBe('fake-session-1')

      const chat = await conversation()
      expect((await rewind(chat.h, '2 chat confirm')).kind).toBe('success')
      expect(await readFile(chat.a, 'utf8')).toBe('two\n')
      expect(existsSync(chat.b)).toBe(true)
      expect(chat.h.fake.commandsOfType('branch')).toHaveLength(1)
      expect(changed(chat.h)).toHaveLength(1)
    })

    it('changes nothing while a turn runs', async () => {
      const { h, a, b } = await conversation()
      const { turn, promptId } = await openTurn(h)
      expect((await rewind(h, '2 confirm')).kind).toBe('error')
      expect(await readFile(a, 'utf8')).toBe('two\n')
      expect(existsSync(b)).toBe(true)
      expect(h.fake.commandsOfType('branch')).toHaveLength(0)
      h.fake.emit({ type: 'prompt_result', id: promptId, agentInvoked: true, status: 'completed', sessionSettled: true })
      await turn
      expect((await rewind(h, '2 confirm')).kind).toBe('success')
    })

    it('leaves a file alone that something else changed since, still rolls the conversation back and names the file', async () => {
      const { h, a, b } = await conversation()
      await writeFile(a, 'edited by hand\n')
      const result = await rewind(h, '2 confirm')
      expect(result.kind).toBe('success')
      expect(result.text).toContain('a.txt')
      expect(await readFile(a, 'utf8')).toBe('edited by hand\n')
      expect(existsSync(b)).toBe(false)
      expect(h.fake.commandsOfType('branch')).toHaveLength(1)
    })

    it('never reads or writes a file outside the session directory, whatever a record says', async () => {
      const { h } = await started()
      const outside = join(await tempDir('omp-rewind-outside-'), 'x.txt')
      await writeFile(outside, 'after\n')
      h.fake.state.entries = [
        entryUser('u1', null, 'go'),
        entryResult('r1', 'u1', 'c1', 'edit', { op: 'update', path: outside, oldText: 'before\n', newText: 'after\n' }),
      ]
      h.fake.state.leafId = 'r1'
      const result = await rewind(h, '1 code confirm')
      expect(await readFile(outside, 'utf8')).toBe('after\n')
      expect(result.text).toContain('outside')
    })

    it('reports a conversation that would not move, after the files already went back', async () => {
      const { h, a } = await conversation()
      h.fake.override('branch', () => ({ text: '', cancelled: true }))
      const vetoed = await rewind(h, '2 confirm')
      expect(vetoed.kind).toBe('error')
      expect(vetoed.text).toContain('vetoed')
      expect(changed(h)).toEqual([])
      expect(h.transport.sessionId).toBe('fake-session-1')
      expect(await readFile(a, 'utf8')).toBe('one\n')
      h.fake.override('branch', () => {
        throw new FakeRpcError('Invalid entry ID for branching')
      })
      const refused = await rewind(h, '2 chat confirm')
      expect(refused).toMatchObject({ kind: 'error', text: expect.stringContaining('Invalid entry ID for branching') })
      expect(changed(h)).toEqual([])
    })

    it('starts no prompt while the conversation is moving', async () => {
      const { h } = await conversation()
      h.fake.override('branch', () => NO_RESPONSE)
      const run = rewind(h, '2 chat confirm')
      await waitFor(() => h.fake.commandsOfType('branch').length === 1, 2_000, 'branch')
      await expect(h.transport.prompt(text('hello'), new AbortController().signal)).rejects.toMatchObject({ code: 'busy' })
      expect(h.fake.commandsOfType('prompt')).toHaveLength(0)
      h.fake.respond(h.fake.commandsOfType('branch')[0]?.id, 'branch', { text: '', cancelled: false })
      expect((await run).kind).toBe('success')
      h.fake.override('prompt', () => ({ agentInvoked: false }))
      await h.transport.prompt(text('hello'), new AbortController().signal)
      expect(h.fake.commandsOfType('prompt')).toHaveLength(1)
    })

    it('answers a command line that makes no sense, a cancelled command and a refused read without changing anything', async () => {
      const { h } = await started()
      expect((await rewind(h, 'confirm')).kind).toBe('error')
      const aborted = new AbortController()
      aborted.abort()
      expect((await rewind(h, '', aborted.signal)).kind).toBe('error')
      expect(h.fake.commandsOfType('get_entries')).toHaveLength(0)
      h.fake.override('get_entries', () => {
        throw new FakeRpcError('session not loaded')
      })
      expect(await rewind(h, '')).toMatchObject({ kind: 'error', text: expect.stringContaining('session not loaded') })
    })

    it('lets a lost process through instead of answering for it', async () => {
      const { h } = await started()
      h.fake.override('get_entries', () => NO_RESPONSE)
      const run = rewind(h, '')
      run.catch(() => undefined)
      await waitFor(() => h.fake.commandsOfType('get_entries').length === 1, 2_000, 'get_entries')
      h.fake.crash(1)
      await expect(run).rejects.toMatchObject({ code: 'process-exit' })
    })
  })

  describe('lifecycle', () => {
    it('closes gracefully by ending stdin, is idempotent and reports closed', async () => {
      const h = await create()
      await h.start()
      await h.transport.close()
      await h.transport.close()
      expect(h.fake.stdinEnded).toBe(true)
      expect(h.fake.terminated).toBe(false)
      expect(h.transport.closed).toBe(true)
      await expect(h.transport.setConfigOption('thinking', 'low')).rejects.toMatchObject({ code: 'closed' })
      await expect(h.transport.prompt(text('x'), new AbortController().signal)).rejects.toMatchObject({ code: 'closed' })
    })

    it('terminates through the host handle when stdin close is not enough', async () => {
      const h = await create({ transport: { stdinCloseGraceMs: 20 } })
      await h.start()
      // This process ignores EOF.
      h.fake.stdin.removeAllListeners('end')
      await h.transport.close()
      expect(h.fake.terminated).toBe(true)
    })

    it('fails start with the stderr tail when the launcher exits before ready', async () => {
      const h = await create({ fakeOptions: { sendReady: false } })
      h.fake.stderr.write('env: bun: No such file or directory\n')
      setTimeout(() => h.fake.crash(127), 10)
      const failure = await h.start().catch((error: unknown) => error)
      expect(failure).toMatchObject({ code: 'process-exit' })
      expect(nativeError(failure).message).toContain('PATH')
      expect(nativeError(failure).detail).toContain('env: bun: No such file or directory')
    })

    it('fails start when omp never becomes ready', async () => {
      const h = await create({ fakeOptions: { sendReady: false }, transport: { readyTimeoutMs: 40 } })
      const failure = await h.start().catch((error: unknown) => error)
      expect(failure).toMatchObject({ code: 'ready-timeout' })
      expect(h.fake.stdinEnded || h.fake.terminated).toBe(true)
    })

    it('surfaces a spawn failure from the host spawner', async () => {
      const transport = new OmpNativeTransport()
      const failure = await transport
        .start({
          argv: ['/missing/omp'],
          env: {},
          cwd: '/work',
          spawn: () => {
            throw new NativeTransportError('could not launch /missing/omp: ENOENT', 'spawn-failed')
          },
          session: { kind: 'new' },
          onEvent: () => undefined,
          onPermission: async () => ({ cancelled: true }),
        })
        .catch((error: unknown) => error)
      expect(failure).toMatchObject({ code: 'spawn-failed' })
    })

    it('reassembles rpc_chunk frames larger than the frame limit', async () => {
      const h = await create()
      await h.start()
      const message = 'x'.repeat(1_300_000)
      const bytes = Buffer.from(JSON.stringify({ type: 'notice', level: 'info', message }))
      const parts: Buffer[] = []
      for (let offset = 0; offset < bytes.length; offset += 262_144) parts.push(bytes.subarray(offset, offset + 262_144))
      parts.forEach((part, index) =>
        h.fake.emit({
          type: 'rpc_chunk',
          chunkId: 'c1',
          index,
          count: parts.length,
          byteLength: bytes.length,
          data: part.toString('base64'),
        }),
      )
      await waitFor(() => h.events.some((event) => event.kind === 'notice'), 5_000, 'reassembled notice')
      expect(h.events.find((event) => event.kind === 'notice')).toEqual({ kind: 'notice', text: message })
    })

    it('tolerates garbage on stdout and unknown frames', async () => {
      const h = await create()
      await h.start()
      h.fake.stdout.write('this is not json\n')
      h.fake.emit({ type: 'live_phase', phase: 'x' })
      h.fake.emit({ type: 'notice', level: 'warning', message: 'careful' })
      await waitFor(() => h.events.some((event) => event.kind === 'notice'), 2_000, 'notice')
      expect(h.events.find((event) => event.kind === 'notice')).toEqual({ kind: 'notice', text: 'warning: careful' })
    })
  })
})

// ---------------------------------------------------------------------------
// 3. The real `omp` binary
// ---------------------------------------------------------------------------

function findOmp(): string | undefined {
  const explicit = process.env.OMP_COMMAND
  if (explicit !== undefined && explicit.length > 0) return existsSync(explicit) ? explicit : undefined
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory.length === 0) continue
    const candidate = join(directory, 'omp')
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Keep looking.
    }
  }
  return undefined
}

function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  return env
}

/** Test spawner with the host seam's semantics: explicit entries merged onto the inherited environment. */
const spawnedProcesses: Array<{ pid: number | undefined; alive: () => boolean; kill: () => void }> = []

const nodeSpawn: NativeSpawn = (spec) => {
  const child = spawn(spec.argv[0] ?? '', spec.argv.slice(1), {
    cwd: spec.cwd,
    env: { ...inheritedEnv(), ...spec.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  const exited = new Promise<{ exitCode: number | null; signal: string | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }))
  })
  exited.catch(() => undefined)
  const kill = (): void => {
    try {
      if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM')
      else child.kill('SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }
  spawnedProcesses.push({ pid: child.pid, alive: () => child.exitCode === null && child.signalCode === null, kill })
  return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited, terminate: kill }
}

afterAll(() => {
  for (const entry of spawnedProcesses.splice(0)) if (entry.alive()) entry.kill()
})

const ompCommand = findOmp()
const e2eEnabled = ompCommand !== undefined && process.env.OMP_NATIVE_E2E !== '0'

/** A minimal omp extension: registers a command so the test can prove `-e` extensions load under rpc-ui. */
const EXTENSION_SOURCE = `export default function dshTestExtension(pi) {
  pi.registerCommand('dsh-native-test-marker', { description: 'dsh native transport test marker', handler: async () => {} })
}
`

class LiveSession {
  readonly events: NativeTransportEvent[] = []
  readonly permissions: NativePermissionRequest[] = []
  readonly transport = new OmpNativeTransport()

  constructor(
    private readonly cwd: string,
    private readonly extension: string,
  ) {}

  start(session: NativeSessionTarget): Promise<void> {
    return this.transport.start({
      argv: [ompCommand ?? 'omp', 'acp', '-e', this.extension],
      env: {},
      cwd: this.cwd,
      spawn: nodeSpawn,
      session,
      onEvent: (event) => this.events.push(event),
      onPermission: async (request) => {
        this.permissions.push(request)
        return { cancelled: true }
      },
      log: process.env.OMP_NATIVE_DEBUG === '1' ? (message: string) => console.error(`[omp-native] ${message}`) : undefined,
    })
  }

  updates(): Array<Extract<NativeTransportEvent, { kind: 'update' }>['update']> {
    return this.events.flatMap((event) => (event.kind === 'update' ? [event.update] : []))
  }

  /** The reply text streamed since `fromEvent`. */
  reply(fromEvent = 0): string {
    return this.events
      .slice(fromEvent)
      .flatMap((event) =>
        event.kind === 'update' && event.update.sessionUpdate === 'agent_message_chunk' && event.update.content.type === 'text'
          ? [event.update.content.text]
          : [],
      )
      .join('')
  }

  controlValue(id: string): string | boolean | undefined {
    return this.transport.controls().configOptions.find((option) => option.id === id)?.currentValue
  }

  controlValues(id: string): string[] {
    const option = this.transport.controls().configOptions.find((entry) => entry.id === id)
    return option?.type === 'select' ? option.options.flatMap((entry) => ('value' in entry ? [entry.value] : [])) : []
  }
}

describe.skipIf(!e2eEnabled)('OmpNativeTransport against the real omp binary', () => {
  const sessions: LiveSession[] = []
  const sessionFiles = new Set<string>()
  let workDir = ''
  let extension = ''

  async function workspace(): Promise<string> {
    if (workDir === '') {
      workDir = await tempDir('omp-native-live-')
      extension = join(workDir, 'dsh-test-extension.js')
      await writeFile(extension, EXTENSION_SOURCE)
      workDir = join(workDir, 'cwd')
      await mkdir(workDir, { recursive: true })
    }
    return workDir
  }

  async function open(session: NativeSessionTarget, cwd?: string): Promise<LiveSession> {
    const dir = cwd ?? (await workspace())
    const live = new LiveSession(dir, extension)
    sessions.push(live)
    await live.start(session)
    if (live.transport.sessionFilePath !== undefined) sessionFiles.add(live.transport.sessionFilePath)
    return live
  }

  afterEach(async () => {
    for (const live of sessions.splice(0)) await live.transport.close().catch(() => undefined)
    // Remove only the session files this run created (and their artifact directories).
    for (const file of sessionFiles) {
      await rm(file, { force: true }).catch(() => undefined)
      await rm(file.replace(/\.jsonl$/, ''), { recursive: true, force: true }).catch(() => undefined)
      await rm(join(dirname(file), `.${file.slice(dirname(file).length + 1)}.lock.os`), { force: true }).catch(() => undefined)
      if ((await readdir(dirname(file)).catch(() => ['x'])).length === 0) await rm(dirname(file), { recursive: true, force: true }).catch(() => undefined)
    }
    sessionFiles.clear()
  })

  /** Pin a cheap fast model and no reasoning so the live turns stay short. */
  async function economize(live: LiveSession): Promise<void> {
    const cheap = live.controlValues('model').find((value) => value.endsWith('/gpt-6.1-sol'))
    if (cheap !== undefined && live.controlValue('model') !== cheap) await live.transport.setConfigOption('model', cheap)
    if (live.controlValues('thinking').includes('off')) await live.transport.setConfigOption('thinking', 'off')
  }

  it('loads -e extensions under rpc-ui and reports the omp version', async () => {
    const live = await open({ kind: 'new' })
    expect(live.transport.agentInfo.name).toBe('omp')
    expect(live.transport.agentInfo.version).toMatch(/^\d+\.\d+\.\d+/)
    await expectEventually(
      () =>
        live.events.some(
          (event) =>
            event.kind === 'commands' && event.commands.some((command) => command.name === 'dsh-native-test-marker'),
        ),
      'the extension command in the commands event',
    )
    // omp's catalogue plus the commands the transport serves is what the host registers; no ACP update carries it.
    expect(live.transport.commands().map((command) => command.name)).toEqual(
      expect.arrayContaining(['btw', 'new', 'clear', 'rewind', 'goal', 'compact', 'dsh-native-test-marker']),
    )
    expect(live.updates().some((update) => update.sessionUpdate === 'available_commands_update')).toBe(false)
  }, 60_000)

  it('reports the same controls as omp acp session/new for the same cwd (plan mode aside)', async () => {
    const dir = await workspace()
    const acp = await acpSessionNew(ompCommand ?? 'omp', dir)
    const live = await open({ kind: 'new' })
    const native = jsonObject(JSON.parse(JSON.stringify(live.transport.controls())))
    // Clean up the session the oracle created.
    const reference = live.transport.sessionFilePath
    if (reference !== undefined) {
      const found = await findOmpSessionFile({ sessionId: acp.sessionId, referenceFile: reference })
      if (found !== undefined) sessionFiles.add(found)
    }
    // ACP also lists the plan mode (plan.enabled); the native protocol cannot apply it.
    const acpModes = jsonObject(acp.modes)
    const acpAvailable = jsonObjects(acpModes.availableModes)
    expect(acpAvailable.map((mode) => mode.id)).toContain('default')
    expect(native.modes).toEqual({
      currentModeId: acpModes.currentModeId,
      availableModes: acpAvailable.filter((mode) => mode.id !== 'plan'),
    })
    const acpOptions = acp.configOptions.map((option) =>
      option.id === 'mode' ? { ...option, options: jsonObjects(option.options).filter((entry) => entry.value !== 'plan') } : option,
    )
    // omp acp has no `/fast` and `/slow` toggles: the native controls add them next to its three options.
    expect(jsonObjects(native.configOptions).filter((option) => option.id !== 'fast' && option.id !== 'slow')).toEqual(
      acpOptions,
    )
  }, 90_000)

  it('runs a tool-using turn: ACP-shaped tool_call/tool_call_update, reply text, per-turn usage and context', async () => {
    const live = await open({ kind: 'new' })
    await economize(live)
    const result = await live.transport.prompt(
      text('Use the bash tool to run exactly: echo hello-from-omp . Then reply with exactly the single word DONE.'),
      new AbortController().signal,
    )
    expect(result.stopReason).toBe('end_turn')
    expect(live.reply()).toContain('DONE')

    const calls = live.updates().filter((update) => update.sessionUpdate === 'tool_call')
    expect(calls.length).toBeGreaterThan(0)
    const call = calls[0]
    expect(call).toMatchObject({
      sessionUpdate: 'tool_call',
      name: 'bash',
      kind: 'execute',
      status: 'pending',
      title: '$ echo hello-from-omp .',
    })
    const toolCallId = fieldOf(call, 'toolCallId')
    const finals = live
      .updates()
      .filter((update) => update.sessionUpdate === 'tool_call_update' && update.toolCallId === toolCallId && update.status === 'completed')
    expect(finals).toHaveLength(1)
    expect(JSON.stringify(finals[0])).toContain('hello-from-omp')
    expect(result.usage?.outputTokens).toBeGreaterThan(0)
    expect((result.usage?.inputTokens ?? 0) + (result.usage?.cachedReadTokens ?? 0) + (result.usage?.cachedWriteTokens ?? 0)).toBeGreaterThan(0)
    const context = live.transport.contextUsage()
    expect(context?.used).toBeGreaterThan(0)
    expect(context?.size).toBeGreaterThan(0)
    expect(live.permissions).toHaveLength(0)
  }, 180_000)

  it('injects a steer into a running tool turn', async () => {
    const live = await open({ kind: 'new' })
    await economize(live)
    const turn = live.transport.prompt(
      text('Run the bash tool once with the exact command `sleep 8`, then reply with exactly: DONE. Do nothing else.'),
      new AbortController().signal,
    )
    await expectEventually(() => live.updates().some((update) => update.sessionUpdate === 'tool_call'), 'the tool call', 120_000)
    const mark = live.events.length
    expect(await live.transport.steer(text('IMPORTANT: after this, reply with exactly: STEERED'))).toBe('injected')
    expect((await turn).stopReason).toBe('end_turn')
    expect(live.reply(mark).toUpperCase()).toContain('STEERED')
    // Idle again: a steer must not start a turn.
    expect(await live.transport.steer(text('anything'))).toBe('promptRequired')
  }, 240_000)

  it('cancels a running turn through the abort signal', async () => {
    const live = await open({ kind: 'new' })
    await economize(live)
    const controller = new AbortController()
    const turn = live.transport.prompt(
      text('Run the bash tool once with the exact command `sleep 30`, then reply DONE.'),
      controller.signal,
    )
    await expectEventually(() => live.updates().some((update) => update.sessionUpdate === 'tool_call'), 'the tool call', 120_000)
    controller.abort()
    expect((await turn).stopReason).toBe('cancelled')
    // The process is still usable for the next turn.
    const next = await live.transport.prompt(text('Reply with exactly: AFTER-CANCEL'), new AbortController().signal)
    expect(next.stopReason).toBe('end_turn')
    expect(live.reply().toUpperCase()).toContain('AFTER-CANCEL')
  }, 240_000)

  it('resumes by the returned id in a new instance and the conversation continues; a fork inherits it', async () => {
    const token = `ZEBRA-${Math.floor(Math.random() * 9000 + 1000)}-QUILL`
    const first = await open({ kind: 'new' })
    await economize(first)
    const sessionId = first.transport.sessionId
    expect(sessionId).toBeTruthy()
    await first.transport.prompt(text(`Remember this token exactly: ${token}. Reply with just: OK`), new AbortController().signal)
    await first.transport.close()
    expect(first.transport.closed).toBe(true)

    const resumed = await open({ kind: 'resume', sessionId: sessionId ?? '' })
    expect(resumed.transport.sessionId).toBe(sessionId)
    // The model/thinking the first process pinned come back with the transcript.
    expect(resumed.controlValue('model')).toBe(first.controlValue('model'))
    expect(resumed.controlValue('thinking')).toBe('off')
    await resumed.transport.prompt(text('What token did I ask you to remember? Reply with only the token.'), new AbortController().signal)
    expect(resumed.reply()).toContain(token)
    await resumed.transport.close()

    const forked = await open({ kind: 'fork', parentSessionId: sessionId ?? '' })
    expect(forked.transport.sessionId).toBeTruthy()
    expect(forked.transport.sessionId).not.toBe(sessionId)
    await forked.transport.prompt(text('What token did I ask you to remember? Reply with only the token.'), new AbortController().signal)
    expect(forked.reply()).toContain(token)
  }, 360_000)

  it('rejects an unknown session id with session-not-found', async () => {
    const failure = await open({ kind: 'resume', sessionId: '01a00000-0000-7000-8000-000000000000' }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(NativeTransportError)
    expect(failure).toMatchObject({ code: 'session-not-found' })
    expect(nativeError(failure).message).toContain('session not found')
  }, 60_000)

  it('applies model and thinking via setConfigOption and the next turn runs with them', async () => {
    const live = await open({ kind: 'new' })
    const models = live.controlValues('model')
    const current = live.controlValue('model')
    const target = models.find((value) => value.endsWith('/gpt-6.1-sol') && value !== current) ?? models.find((value) => value !== current)
    expect(target).toBeDefined()
    await live.transport.setConfigOption('model', target ?? '')
    expect(live.controlValue('model')).toBe(target)
    const levels = live.controlValues('thinking')
    const level = levels.find((value) => value === 'low') ?? levels.find((value) => value !== 'off' && value !== 'auto')
    expect(level).toBeDefined()
    await live.transport.setConfigOption('thinking', level ?? '')
    expect(live.controlValue('thinking')).toBe(level)
    await live.transport.setConfigOption('thinking', 'auto')
    expect(live.controlValue('thinking')).toBe('auto')
    await live.transport.setConfigOption('thinking', level ?? '')

    await live.transport.prompt(text('Reply with exactly: PONG'), new AbortController().signal)
    expect(live.reply().toUpperCase()).toContain('PONG')
    const file = live.transport.sessionFilePath ?? ''
    // OMP's own transcript is the ground truth for what the turn ran with.
    const entries = (await readFile(file, 'utf8'))
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Json)
    const assistant = entries
      .map((entry) => entry.message as Json | undefined)
      .filter((message): message is Json => message !== undefined && message.role === 'assistant')
      .at(-1)
    expect(`${String(assistant?.provider)}/${String(assistant?.model)}`).toBe(target)
    const thinking = entries.filter((entry) => entry.type === 'thinking_level_change').at(-1)
    expect(thinking?.configured ?? thinking?.thinkingLevel).toBe(level)
    await live.transport.close()

    // A new process restores the same selection from the transcript.
    const again = await open({ kind: 'resume', sessionId: live.transport.sessionId ?? '' })
    expect(again.controlValue('model')).toBe(target)
    expect(again.controlValue('thinking')).toBe(level)
    await expectRejected(again.transport.setConfigOption('mode', 'plan'), 'plan-mode-unsupported')
  }, 240_000)

  const oldSessionDir = process.env.OMP_NATIVE_E2E_OLD_SESSION_DIR
  it.skipIf(oldSessionDir === undefined || oldSessionDir === '')(
    'resumes ids written by an earlier omp acp run (start and controls only, no prompt)',
    async () => {
      const dir = oldSessionDir ?? ''
      const files = await Promise.all(
        (await readdir(dir))
          .filter((name) => name.endsWith('.jsonl') && !name.startsWith('.'))
          .map(async (name) => ({ file: join(dir, name), mtime: (await stat(join(dir, name))).mtimeMs })),
      )
      files.sort((a, b) => b.mtime - a.mtime)
      let resumed: LiveSession | undefined
      let resumedId = ''
      const failures: string[] = []
      for (const { file } of files.slice(0, 8)) {
        const header = await readOmpSessionHeader(file)
        if (header?.cwd === undefined || !existsSync(header.cwd)) continue
        try {
          resumed = await open({ kind: 'resume', sessionId: header.id }, header.cwd)
          resumedId = header.id
          break
        } catch (error) {
          failures.push(`${header.id}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      // An old session's file is the user's: never delete it, whatever the assertions below find.
      sessionFiles.clear()
      expect(resumed, `no recent session in ${dir} could be resumed:\n${failures.join('\n')}`).toBeDefined()
      expect(resumed?.transport.sessionId).toBe(resumedId)
      expect(
        resumed?.transport
          .controls()
          .configOptions.map((option) => option.id)
          .filter((id) => id !== 'fast' && id !== 'slow'),
      ).toEqual(['mode', 'model', 'thinking'])
      expect(resumed?.transport.controls().modes?.currentModeId).toBe('default')
      expect(resumed?.controlValue('model')).toMatch(/.+\/.+/)
      expect(resumed?.transport.contextUsage()?.size).toBeGreaterThan(0)
    },
    120_000,
  )
})

async function expectEventually(predicate: () => boolean, description: string, timeoutMs = 30_000): Promise<void> {
  await waitFor(predicate, timeoutMs, description)
}

async function expectRejected(promise: Promise<unknown>, code: string): Promise<void> {
  const failure = await promise.then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(failure).toMatchObject({ code })
}

/** Run `omp acp`, `initialize` + `session/new`, and return what the ACP agent reports (the parity oracle). */
async function acpSessionNew(
  command: string,
  cwd: string,
): Promise<{ sessionId: string; configOptions: Json[]; modes: unknown }> {
  const child = spawn(command, ['acp'], { cwd, env: inheritedEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
  const responses = new Map<number, Json>()
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      try {
        const message = jsonObject(JSON.parse(line))
        if (typeof message.id === 'number' && (message.result !== undefined || message.error !== undefined)) {
          responses.set(message.id, message)
        }
      } catch {
        // Not a JSON-RPC line.
      }
      newline = buffer.indexOf('\n')
    }
  })
  child.stderr.on('data', () => undefined)
  const call = async (id: number, method: string, params: Json): Promise<Json> => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    await waitFor(() => responses.has(id), 60_000, `ACP ${method} response`)
    const response = responses.get(id)
    if (response === undefined) throw new Error(`ACP ${method} produced no response`)
    if (response.error !== undefined) throw new Error(`ACP ${method} failed: ${JSON.stringify(response.error)}`)
    return jsonObject(response.result)
  }
  try {
    await call(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} })
    const created = await call(2, 'session/new', { cwd, mcpServers: [] })
    return {
      sessionId: String(created.sessionId),
      configOptions: jsonObjects(created.configOptions),
      modes: created.modes,
    }
  } finally {
    child.stdin.end()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        resolve()
      }, 5_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}

describe('createOmpTransport', () => {
  it('returns the transport the native factory selects', () => {
    const transport = createOmpTransport()
    expect(transport.kind).toBe('omp')
    expect(transport.sessionId).toBeUndefined()
    expect(transport.agentInfo.version).toBe('')
    expect(transport.canFork).toBe(true)
  })
})
