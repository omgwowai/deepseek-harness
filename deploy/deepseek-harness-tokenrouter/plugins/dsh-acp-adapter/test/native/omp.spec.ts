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
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import {
  NativeTransportError,
  type NativeContentBlock,
  type NativePermissionDecision,
  type NativePermissionRequest,
  type NativeProcess,
  type NativeSessionTarget,
  type NativeSpawn,
  type NativeTransportEvent,
} from '../../src/runtime/native/transports/contract.ts'
import {
  buildOmpLaunchArgv,
  buildOmpToolTitle,
  createOmpTransport,
  deriveOmpControls,
  extractOmpAssistantText,
  findOmpSessionFile,
  mapOmpAvailableCommands,
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

  it('maps the rpc command catalogue to ACP available commands', () => {
    expect(
      mapOmpAvailableCommands([
        { name: 'security', description: 'Scan', input: { hint: '<plan|scan>' }, subcommands: [{ name: 'plan' }] },
        { name: 'compact' },
        { description: 'nameless' },
      ]),
    ).toEqual([
      { name: 'security', description: 'Scan', input: { hint: '<plan|scan>' } },
      { name: 'compact', description: '' },
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
}

const fakeModel = (info: OmpModelInfo): Json => ({
  provider: info.provider,
  id: info.id,
  name: info.name,
  reasoning: info.reasoning,
  input: info.input,
})

class FakeRpcError extends Error {}

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
    this.emit({
      id: command.id,
      type: 'response',
      command: type,
      success: true,
      ...(data === undefined ? {} : { data }),
    })
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
        return () => ({
          model: state.model,
          thinkingLevel: state.thinkingLevel,
          sessionId: state.sessionId,
          sessionFile: state.sessionFile,
          isStreaming: false,
        })
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
  start: (session?: NativeSessionTarget, argv?: readonly string[]) => Promise<void>
  updates: () => Array<Extract<NativeTransportEvent, { kind: 'update' }>['update']>
}

const text = (value: string): NativeContentBlock[] => [{ type: 'text', text: value }]

async function harness(options: { fakeOptions?: { sendReady?: boolean }; transport?: ConstructorParameters<typeof OmpNativeTransport>[0] } = {}): Promise<Harness> {
  const root = await tempDir('omp-fake-')
  const bucket = join(root, 'agent', 'sessions', '-work-here')
  await mkdir(bucket, { recursive: true })
  const fake = new FakeOmp(bucket, options.fakeOptions)
  const calls: SpawnCall[] = []
  const events: NativeTransportEvent[] = []
  const permissions: NativePermissionRequest[] = []
  const transport = new OmpNativeTransport({ contextPollIntervalMs: 60_000, ...options.transport })
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
    start: (session = { kind: 'new' }, argv = ['/bin/omp', 'acp', '-e', '/x/link.js']) =>
      transport.start({
        argv,
        env: { PI_CODING_AGENT_DIR: join(root, 'agent'), HOME: '/home/u' },
        cwd: '/work/here',
        spawn: fakeSpawn(fake, calls),
        session,
        onEvent: (event) => events.push(event),
        onPermission: (request, signal) => built.decide(request, signal),
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
    expect(main?.argv).toEqual(['/bin/omp', '-e', '/x/link.js', '--mode', 'rpc-ui', '--auto-approve'])
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

  it('forwards OMP command catalogue frames as available_commands_update', async () => {
    const h = await create()
    await h.start()
    h.fake.emit({ type: 'available_commands_update', commands: [{ name: 'compact', description: 'Compact', input: { hint: '[focus]' } }] })
    await waitFor(() => h.updates().some((update) => update.sessionUpdate === 'available_commands_update'), 2_000, 'commands')
    expect(h.updates().find((update) => update.sessionUpdate === 'available_commands_update')).toEqual({
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'compact', description: 'Compact', input: { hint: '[focus]' } }],
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

      const updates = h.updates().filter((update) => update.sessionUpdate !== 'available_commands_update')
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
      h.fake.emit({ type: 'extension_ui_request', id: 'dlg-2', method: 'select', title: 'Pick one', options: ['A', 'B'] })
      await waitFor(() => signal !== undefined, 2_000, 'host prompt')
      h.fake.emit({ type: 'extension_ui_request', id: 'cancel-1', method: 'cancel', targetId: 'dlg-2' })
      await waitFor(() => signal?.aborted === true, 2_000, 'withdrawal')
      pending.resolve({ optionId: 'A' })
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(h.fake.commands.some((command) => command.type === 'extension_ui_response')).toBe(false)
    })

    it('dismisses dialogs the host has no surface for and ignores UI chatter', async () => {
      const h = await create()
      await h.start()
      h.fake.emit({ type: 'extension_ui_request', id: 'c1', method: 'confirm', title: 'Sure?', message: 'm' })
      h.fake.emit({ type: 'extension_ui_request', id: 'n1', method: 'notify', message: 'hello' })
      h.fake.emit({ type: 'extension_ui_request', id: 'w1', method: 'setWidget', widgetKey: 'k' })
      await waitFor(() => h.fake.commands.some((command) => command.type === 'extension_ui_response'), 2_000, 'confirm dismissal')
      expect(h.fake.commands.filter((command) => command.type === 'extension_ui_response')).toEqual([
        { type: 'extension_ui_response', id: 'c1', cancelled: true },
      ])
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
        live
          .updates()
          .some(
            (update) =>
              update.sessionUpdate === 'available_commands_update' &&
              update.availableCommands.some((command) => command.name === 'dsh-native-test-marker'),
          ),
      'the extension command in available_commands_update',
    )
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
    expect(native.configOptions).toEqual(acpOptions)
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
      expect(resumed?.transport.controls().configOptions.map((option) => option.id)).toEqual(['mode', 'model', 'thinking'])
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
