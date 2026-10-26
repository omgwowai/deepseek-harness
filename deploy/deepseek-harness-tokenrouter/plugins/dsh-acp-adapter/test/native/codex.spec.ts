/**
 * Tests for the Codex native transport (`codex app-server`, JSON-RPC over JSONL).
 *
 * The transport must report what `@agentclientprotocol/codex-acp` reports for the
 * same Codex session, so most of these tests pin ACP-shaped output:
 *
 *  1. pure modules: controls, unified-diff parsing, token accounting, reverse requests;
 *  2. the whole transport against a scripted fake `codex app-server` that is spawned
 *     through the real host subprocess seam (`nativeSpawnFromSeam`);
 *  3. opt-in live checks through the profile's TokenRouter launcher (`codex-launch.mjs`),
 *     enabled with `DSH_CODEX_LIVE=1`; they read the launcher environment from the
 *     profile file at run time and never print it.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import type * as acp from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { fileURLToPath } from 'node:url'

import { nativeSpawnFromSeam } from '../../src/runtime/native/native-spawn.ts'
import { answerCodexServerRequest, type CodexApprovalHost } from '../../src/runtime/native/transports/codex-approvals.ts'
import { CodexControlsState, findCodexMode, initialCodexMode, parseCodexModelPage } from '../../src/runtime/native/transports/codex-controls.ts'
import {
  CodexProjection,
  CodexTokenAccounting,
  parseSingleUnifiedPatch,
  readableServiceErrorMessage,
  stripShellPrefix,
  toTokenCount,
} from '../../src/runtime/native/transports/codex-projection.ts'
import {
  CodexRpcError,
  createCodexTransport,
  isDefinitiveSteerRejection,
} from '../../src/runtime/native/transports/codex.ts'
import {
  NativeTransportError,
  type NativeContentBlock,
  type NativePermissionDecision,
  type NativePermissionRequest,
  type NativeSessionTarget,
  type NativeSpawn,
  type NativeTransport,
  type NativeTransportEvent,
} from '../../src/runtime/native/transports/contract.ts'
import { sharedTestSubprocess } from '../fixtures/subprocess-seam-testing.ts'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Frame = Record<string, unknown>
type FakeConfig = Record<string, unknown>
type Step = Record<string, unknown>
type SpawnSpec = Parameters<NativeSpawn>[0]
type Decision = NativePermissionDecision | Promise<NativePermissionDecision>

const tempDirs: string[] = []
const openTransports: NativeTransport[] = []

afterEach(async () => {
  for (const transport of openTransports.splice(0)) await transport.close().catch(() => undefined)
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return realpathSync(dir)
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for condition')
}

const say = (value: string): NativeContentBlock[] => [{ type: 'text', text: value }]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The error a rejected start/prompt carried, asserted to be the transport's own error type. */
function nativeError(value: unknown): NativeTransportError {
  if (!(value instanceof NativeTransportError)) throw new Error(`expected a NativeTransportError, got ${String(value)}`)
  return value
}

/** `closed` is an optional member of a transport (the runtime re-attaches a closed one). */
function isClosed(transport: NativeTransport): boolean | undefined {
  return 'closed' in transport && typeof transport.closed === 'boolean' ? transport.closed : undefined
}

/** Every selectable value of a select option, groups flattened. */
function selectValues(option: acp.SessionConfigOption | undefined): string[] {
  if (option?.type !== 'select') return []
  const values: string[] = []
  for (const entry of option.options) {
    if ('value' in entry) values.push(entry.value)
    else for (const nested of entry.options) values.push(nested.value)
  }
  return values
}

/** The payload object of one rollout JSONL line (`{type, payload}`). */
function rolloutPayload(line: string): Record<string, unknown> {
  return objectOf(objectOf(JSON.parse(line))['payload'])
}

/** The text of an assistant message/thought chunk, or '' for any other update. */
function chunkText(update: acp.SessionUpdate): string {
  if (update.sessionUpdate !== 'agent_message_chunk' && update.sessionUpdate !== 'agent_thought_chunk') return ''
  return update.content.type === 'text' ? update.content.text : ''
}

/** The title of a tool call update, or '' when it has none. */
function titleOf(update: acp.SessionUpdate): string {
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return ''
  return update.title ?? ''
}

interface Harness {
  readonly transport: NativeTransport
  readonly events: NativeTransportEvent[]
  readonly permissions: NativePermissionRequest[]
  readonly logs: string[]
  readonly spawns: SpawnSpec[]
  readonly dir: string
  readonly script: string
  /** Every frame the fake server logged: boot facts and each frame the transport sent. */
  frames(): Frame[]
  /** The frames of one method the transport sent. */
  sent(method: string): Frame[]
  /** The ACP session updates the transport emitted, optionally of one kind. */
  updates(kind?: string): acp.SessionUpdate[]
  prompt(text: string, signal?: AbortSignal): ReturnType<NativeTransport['prompt']>
}

interface LaunchOptions {
  readonly config?: FakeConfig
  readonly env?: Readonly<Record<string, string>>
  readonly session?: NativeSessionTarget
  readonly decide?: (request: NativePermissionRequest) => Decision
  readonly spawn?: NativeSpawn
}

function defaultDecision(request: NativePermissionRequest): NativePermissionDecision {
  const option = request.options.find((candidate) => candidate.kind === 'allow_once')
  return option === undefined ? { cancelled: true } : { optionId: option.optionId }
}

async function launch(options: LaunchOptions = {}): Promise<Harness> {
  const dir = await tempDir('dsh-codex-fake-')
  const script = join(dir, 'fake-codex-app-server.mjs')
  const logFile = join(dir, 'frames.jsonl')
  await writeFile(script, FAKE_CODEX_APP_SERVER, 'utf8')
  const hostSpawn = nativeSpawnFromSeam((await sharedTestSubprocess()).seam)
  const spawns: SpawnSpec[] = []
  const spawn: NativeSpawn =
    options.spawn ??
    ((spec) => {
      spawns.push(spec)
      return hostSpawn(spec)
    })
  const events: NativeTransportEvent[] = []
  const permissions: NativePermissionRequest[] = []
  const logs: string[] = []
  const transport = createCodexTransport()
  openTransports.push(transport)
  await transport.start({
    argv: [process.execPath, script],
    env: { FAKE_CODEX_CONFIG: JSON.stringify(options.config ?? {}), FAKE_CODEX_LOG: logFile, ...options.env },
    cwd: dir,
    spawn,
    session: options.session ?? { kind: 'new' },
    onEvent: (event) => events.push(event),
    onPermission: async (request) => {
      permissions.push(request)
      return options.decide === undefined ? defaultDecision(request) : await options.decide(request)
    },
    log: (message) => logs.push(message),
  })
  const frames = (): Frame[] =>
    existsSync(logFile)
      ? readFileSync(logFile, 'utf8')
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line) => objectOf(JSON.parse(line)))
      : []
  return {
    transport,
    events,
    permissions,
    logs,
    spawns,
    dir,
    script,
    frames,
    sent: (method) => frames().filter((frame) => frame['method'] === method),
    updates: (kind) =>
      events
        .filter((event): event is Extract<NativeTransportEvent, { kind: 'update' }> => event.kind === 'update')
        .map((event) => event.update)
        .filter((update) => kind === undefined || update.sessionUpdate === kind),
    prompt: (text, signal = new AbortController().signal) => transport.prompt(say(text), signal),
  }
}

const objectOf = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {})

const paramsOf = (frame: Frame | undefined): Record<string, unknown> => objectOf(frame?.['params'])

const replyTo = (frames: readonly Frame[], id: number): Frame | undefined =>
  frames.find((frame) => frame['id'] === id && frame['method'] === undefined)

// ---------------------------------------------------------------------------
// Scripted fake `codex app-server`
// ---------------------------------------------------------------------------

/**
 * A deterministic app-server. `FAKE_CODEX_CONFIG` (JSON) selects behaviour; `turns[n]` is the
 * script of the n-th `turn/start`: an array of steps, or `{ steps, startedBeforeResponse,
 * responseDelayMs }`. Steps: `{ n, p }` notification, `{ r, p }` reverse request (waits for the
 * answer), `{ sleep }`, `{ wait: 'steer' | 'interrupt' }`, `{ end, error }`, `{ exit, stderr }`.
 * `$thread`, `$turn` and `$cwd` are substituted in strings. Every frame the client sends is
 * appended to `FAKE_CODEX_LOG`. Written without backticks: it lives in a template literal.
 */
const FAKE_CODEX_APP_SERVER = `import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const NL = String.fromCharCode(10)
const cfg = JSON.parse(process.env.FAKE_CODEX_CONFIG || '{}')
const logPath = process.env.FAKE_CODEX_LOG
const THREAD = cfg.threadId || 'thr_test'
const FORK = cfg.forkId || 'thr_fork'

function efforts(names) {
  return names.map(function (name) { return { reasoningEffort: name, description: name + ' effort' } })
}
function model(id, displayName, extra) {
  return Object.assign({
    id: id, model: id, displayName: displayName, description: 'About ' + id,
    isDefault: false, hidden: false, defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: efforts(['low', 'medium', 'high']),
    inputModalities: ['text', 'image'], additionalSpeedTiers: []
  }, extra || {})
}
const MODELS = cfg.models || [
  model('gpt-6-astra', 'GPT-6-Astra', {
    isDefault: true, defaultReasoningEffort: 'xhigh',
    supportedReasoningEfforts: efforts(['low', 'medium', 'high', 'xhigh', 'max'])
  }),
  model('gpt-5.6-sol', 'GPT-5.6-Sol', {
    defaultReasoningEffort: 'low', additionalSpeedTiers: ['fast'],
    supportedReasoningEfforts: efforts(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  }),
  model('glm-5.3', 'GLM-5.3', {
    defaultReasoningEffort: 'high', inputModalities: ['text'],
    supportedReasoningEfforts: efforts(['low', 'medium', 'high', 'xhigh', 'max'])
  })
]

function log(entry) { if (logPath) appendFileSync(logPath, JSON.stringify(entry) + NL) }
function send(frame) { process.stdout.write(JSON.stringify(frame) + NL) }
function respond(id, result) { send({ id: id, result: result }) }
function respondError(id, code, message) { send({ id: id, error: { code: code, message: message } }) }
function notify(method, params) { send({ method: method, params: params }) }
function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms) }) }

// A frame cut in the middle of a multi-byte character, as a pipe may deliver it.
function notifyChunked(method, params) {
  const bytes = Buffer.from(JSON.stringify({ method: method, params: params }) + NL, 'utf8')
  const cut = bytes.indexOf(0xe2) + 1
  process.stdout.write(bytes.subarray(0, cut))
  setTimeout(function () { process.stdout.write(bytes.subarray(cut)) }, 30)
}

log({ boot: {
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: {
    MODEL_PROVIDER: process.env.MODEL_PROVIDER || null,
    INITIAL_AGENT_MODE: process.env.INITIAL_AGENT_MODE || null,
    FAKE_MARK: process.env.FAKE_MARK || null
  }
} })

let nextServerId = 9001
const answers = new Map()
function reverse(method, params) {
  const id = nextServerId++
  return new Promise(function (resolve) {
    answers.set(id, resolve)
    send({ id: id, method: method, params: params })
  })
}

const released = {}
const waiters = {}
function waitFor(name) {
  if (released[name]) return Promise.resolve()
  return new Promise(function (resolve) {
    if (!waiters[name]) waiters[name] = []
    waiters[name].push(resolve)
  })
}
function release(name) {
  released[name] = true
  const list = waiters[name] || []
  waiters[name] = []
  list.forEach(function (resolve) { resolve() })
}

function sub(value, ctx) {
  if (typeof value === 'string') {
    return value.split('$thread').join(ctx.thread).split('$turn').join(ctx.turn).split('$cwd').join(process.cwd())
  }
  if (Array.isArray(value)) return value.map(function (entry) { return sub(entry, ctx) })
  if (value && typeof value === 'object') {
    const out = {}
    Object.keys(value).forEach(function (key) { out[key] = sub(value[key], ctx) })
    return out
  }
  return value
}

function completed(ctx, status, error) {
  notify('turn/completed', { threadId: ctx.thread, turn: { id: ctx.turn, status: status, items: [], error: error || null } })
}

async function run(ctx, steps) {
  for (const step of steps) {
    if (step.n) {
      const params = sub(step.p, ctx)
      if (step.chunk) { notifyChunked(step.n, params); await sleep(80) } else notify(step.n, params)
    } else if (step.r) {
      await reverse(step.r, sub(step.p, ctx))
    } else if (step.sleep) {
      await sleep(step.sleep)
    } else if (step.wait === 'steer') {
      await waitFor('steer')
    } else if (step.wait === 'interrupt') {
      await waitFor('interrupt')
      completed(ctx, 'interrupted')
      return
    } else if (step.end) {
      completed(ctx, step.end, step.error)
      return
    } else if (step.exit !== undefined) {
      if (step.stderr) process.stderr.write(step.stderr + NL)
      process.exit(step.exit)
    }
  }
  completed(ctx, 'completed')
}

function threadResponse(id, resume) {
  const t = cfg.thread || {}
  const response = {
    thread: { id: id },
    model: t.model || 'gpt-6-astra',
    modelProvider: t.modelProvider || 'fake-provider',
    reasoningEffort: t.reasoningEffort === undefined ? 'max' : t.reasoningEffort,
    serviceTier: t.serviceTier || null,
    cwd: process.cwd(),
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: { type: 'workspaceWrite' }
  }
  if (resume && t.collaborationMode) {
    response.collaborationMode = { mode: t.collaborationMode, settings: { model: response.model, reasoning_effort: null, developer_instructions: null } }
  }
  return response
}

let activeThread = THREAD
let turnCount = 0
let steerCalls = 0
let interruptCalls = 0
const unarchived = {}

function startTurn(id, turnId, spec, threadId) {
  const steps = Array.isArray(spec) ? spec : (spec && spec.steps) || []
  const options = Array.isArray(spec) || !spec ? {} : spec
  const ctx = { thread: threadId, turn: turnId }
  const response = { turn: { id: turnId, status: 'inProgress', items: [], error: null } }
  const begin = { threadId: threadId, turn: { id: turnId, status: 'inProgress', items: [], error: null } }
  if (options.startedBeforeResponse) notify('turn/started', begin)
  if (options.responseDelayMs) setTimeout(function () { respond(id, response) }, options.responseDelayMs)
  else respond(id, response)
  if (!options.startedBeforeResponse) {
    if (options.startedDelayMs) setTimeout(function () { notify('turn/started', begin) }, options.startedDelayMs)
    else notify('turn/started', begin)
  }
  void run(ctx, steps)
}

function handle(frame) {
  const id = frame.id
  const method = frame.method
  const params = frame.params || {}
  switch (method) {
    case 'initialize':
      if (cfg.exitOnInitialize) { process.stderr.write('fake boot failure' + NL); process.exit(7) }
      respond(id, { userAgent: cfg.userAgent || '@local/dsh-acp-adapter/0.162.1 (Mac OS 26.2.0; arm64) fake (fake; 0)', codexHome: '/nowhere', platformFamily: 'unix', platformOs: 'macos' })
      break
    case 'model/list': {
      const size = cfg.pageSize || MODELS.length
      const start = params.cursor ? Number(params.cursor) : 0
      respond(id, { data: MODELS.slice(start, start + size), nextCursor: start + size < MODELS.length ? String(start + size) : null })
      break
    }
    case 'thread/start':
      activeThread = THREAD
      respond(id, threadResponse(THREAD, false))
      break
    case 'thread/fork':
      activeThread = FORK
      respond(id, threadResponse(FORK, false))
      break
    case 'thread/resume': {
      const tid = params.threadId
      const state = cfg.threads === undefined ? 'ok' : cfg.threads[tid]
      if (state === 'archived' && !unarchived[tid]) {
        respondError(id, -32600, 'session ' + tid + ' is archived. Run codex unarchive ' + tid + ' to unarchive it first.')
      } else if (state === 'busy') {
        respondError(id, -32600, 'thread ' + tid + ' already has an active writer')
      } else if (state === undefined || state === 'missing') {
        respondError(id, -32600, 'no rollout found for thread id ' + tid)
      } else {
        activeThread = tid
        respond(id, threadResponse(tid, true))
        if (cfg.resumeUsage) notify('thread/tokenUsage/updated', { threadId: tid, turnId: 'turn_old', tokenUsage: cfg.resumeUsage })
      }
      break
    }
    case 'thread/unarchive': {
      const tid = params.threadId
      if (cfg.threads && cfg.threads[tid] === 'archived') { unarchived[tid] = true; respond(id, { thread: { id: tid } }) }
      else respondError(id, -32600, 'no archived rollout found for thread id ' + tid)
      break
    }
    case 'thread/settings/update':
      respond(id, {})
      notify('thread/settings/updated', { threadId: params.threadId, threadSettings: {} })
      break
    case 'account/read':
      respond(id, { account: cfg.account === undefined ? null : cfg.account, requiresOpenaiAuth: false })
      break
    case 'config/read':
      respond(id, { config: { model_provider: cfg.configProvider || null } })
      break
    case 'skills/list':
      respond(id, { data: [{ cwd: (params.cwds || [''])[0], skills: cfg.skills || [], errors: [] }] })
      break
    case 'thread/name/set':
      respond(id, {})
      break
    case 'thread/compact/start':
      respond(id, {})
      if (cfg.compact) void run({ thread: activeThread, turn: 'turn_compact' }, [{ n: 'turn/started', p: { threadId: '$thread', turn: { id: '$turn', status: 'inProgress', items: [] } } }].concat(cfg.compact))
      break
    case 'review/start':
      turnCount += 1
      startTurn(id, 'turn_review', cfg.review || [], activeThread)
      break
    case 'turn/start':
      turnCount += 1
      startTurn(id, 'turn_' + turnCount, (cfg.turns || [])[turnCount - 1], activeThread)
      break
    case 'turn/steer': {
      steerCalls += 1
      const rejection = (cfg.steerErrors || [])[steerCalls - 1]
      if (rejection) respondError(id, rejection.code, rejection.message)
      else { respond(id, { turnId: params.expectedTurnId }); release('steer') }
      break
    }
    case 'turn/interrupt':
      interruptCalls += 1
      if (interruptCalls <= (cfg.interruptFailures || 0)) respondError(id, -32600, 'no active turn to interrupt')
      else { respond(id, {}); release('interrupt') }
      break
    default:
      if (typeof id === 'number') respond(id, {})
  }
}

const rl = createInterface({ input: process.stdin })
rl.on('line', function (line) {
  let frame
  try { frame = JSON.parse(line) } catch (error) { return }
  log(frame)
  if (frame.id !== undefined && frame.method === undefined) {
    const resolve = answers.get(frame.id)
    if (resolve) { answers.delete(frame.id); resolve(frame) }
    return
  }
  handle(frame)
})
rl.on('close', function () { if (!cfg.ignoreStdinEnd) process.exit(0) })
if (cfg.ignoreStdinEnd) setInterval(function () {}, 1000)
`

// Step builders for the fake server's turn scripts.
const note = (n: string, p: Record<string, unknown>): Step => ({ n, p: { threadId: '$thread', turnId: '$turn', ...p } })
const itemStarted = (item: Record<string, unknown>): Step => note('item/started', { item, startedAtMs: 1 })
const itemCompleted = (item: Record<string, unknown>): Step => note('item/completed', { item, completedAtMs: 2 })
const messageSteps = (id: string, text: string): Step[] => [
  itemStarted({ type: 'agentMessage', id, text: '', phase: 'final_answer' }),
  note('item/agentMessage/delta', { itemId: id, delta: text }),
  itemCompleted({ type: 'agentMessage', id, text, phase: 'final_answer' }),
]
const commandItem = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'commandExecution',
  id,
  command: "/bin/zsh -lc 'echo hello'",
  cwd: '$cwd',
  processId: '1',
  source: 'unifiedExecStartup',
  status: 'inProgress',
  commandActions: [{ type: 'unknown', command: 'echo hello' }],
  aggregatedOutput: null,
  exitCode: null,
  durationMs: null,
  ...extra,
})
const usageStep = (last: Record<string, number>, total: Record<string, number>, window = 200_000): Step =>
  note('thread/tokenUsage/updated', { tokenUsage: { last, total, modelContextWindow: window } })

/** Models as `model/list` returns them, for the pure controls tests. */
const CATALOGUE = parseCodexModelPage({
  data: [
    {
      id: 'gpt-6-astra',
      displayName: 'GPT-6-Astra',
      description: 'About gpt-6-astra',
      isDefault: true,
      defaultReasoningEffort: 'xhigh',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'].map((reasoningEffort) => ({
        reasoningEffort,
        description: `${reasoningEffort} effort`,
      })),
      inputModalities: ['text', 'image'],
      additionalSpeedTiers: [],
    },
    {
      id: 'gpt-5.6-sol',
      displayName: 'GPT-5.6-Sol',
      description: 'About gpt-5.6-sol',
      isDefault: false,
      defaultReasoningEffort: 'low',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((reasoningEffort) => ({
        reasoningEffort,
        description: `${reasoningEffort} effort`,
      })),
      inputModalities: ['text', 'image'],
      additionalSpeedTiers: ['fast'],
    },
    {
      id: 'glm-5.3',
      displayName: 'GLM-5.3',
      description: 'About glm-5.3',
      isDefault: false,
      defaultReasoningEffort: 'high',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'].map((reasoningEffort) => ({
        reasoningEffort,
        description: `${reasoningEffort} effort`,
      })),
      inputModalities: ['text'],
      additionalSpeedTiers: [],
    },
  ],
  nextCursor: null,
}).models

function controlsState(overrides: { modelId?: string; effort?: string } = {}): CodexControlsState {
  const mode = findCodexMode('agent')
  if (mode === undefined) throw new Error('missing agent mode')
  return new CodexControlsState({
    mode,
    collaborationMode: 'default',
    models: CATALOGUE,
    modelId: overrides.modelId ?? 'gpt-6-astra',
    effort: overrides.effort ?? 'max',
    fastModeEnabled: false,
  })
}

// ---------------------------------------------------------------------------
// 1. Controls (codex-acp session/new result)
// ---------------------------------------------------------------------------

describe('codex controls', () => {
  it('reports the options, categories, values and names codex-acp reports', () => {
    const controls = controlsState().snapshot()
    expect(controls.configOptions).toEqual([
      {
        id: 'mode',
        name: 'Mode',
        description: 'Approval and sandboxing preset for the session',
        category: 'mode',
        type: 'select',
        currentValue: 'agent',
        options: [
          { value: 'read-only', name: 'Read-only', description: 'Requires approval to edit files and access the internet.' },
          {
            value: 'workspace-write',
            name: 'Workspace access',
            description: 'Edit workspace files; ask before writing outside the workspace or accessing the network.',
          },
          { value: 'agent', name: 'Auto review', description: 'Only ask for actions detected as potentially unsafe' },
          {
            value: 'agent-full-access',
            name: 'Full access',
            description: 'Unrestricted access to the internet and any file on your computer',
          },
        ],
      },
      {
        id: 'collaboration_mode',
        name: 'Collaboration mode',
        description: 'How Codex collaborates for subsequent turns',
        category: 'collaboration_mode',
        type: 'select',
        currentValue: 'default',
        options: [
          { value: 'default', name: 'Default' },
          { value: 'plan', name: 'Plan', description: 'Plan before making changes' },
        ],
      },
      {
        id: 'model',
        name: 'Model',
        description: 'Model Codex uses for the session',
        category: 'model',
        type: 'select',
        currentValue: 'gpt-6-astra',
        options: [
          { value: 'gpt-6-astra', name: '6 Astra', description: 'About gpt-6-astra' },
          { value: 'gpt-5.6-sol', name: '5.6 Sol', description: 'About gpt-5.6-sol' },
          { value: 'glm-5.3', name: 'GLM-5.3', description: 'About glm-5.3' },
        ],
      },
      {
        id: 'reasoning_effort',
        name: 'Reasoning effort',
        description: 'How much reasoning effort the model should use',
        category: 'thought_level',
        type: 'select',
        currentValue: 'max',
        options: ['low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({
          value,
          name: value.charAt(0).toUpperCase() + value.slice(1),
          description: `${value} effort`,
        })),
      },
    ])
    expect(controls.modes).toEqual({
      currentModeId: 'agent',
      availableModes: [
        { id: 'read-only', name: 'Read-only', description: 'Requires approval to edit files and access the internet.' },
        {
          id: 'workspace-write',
          name: 'Workspace access',
          description: 'Edit workspace files; ask before writing outside the workspace or accessing the network.',
        },
        { id: 'agent', name: 'Auto review', description: 'Only ask for actions detected as potentially unsafe' },
        {
          id: 'agent-full-access',
          name: 'Full access',
          description: 'Unrestricted access to the internet and any file on your computer',
        },
      ],
    })
    expect(controls.imageInput).toBe(true)
  })

  it('starts from INITIAL_AGENT_MODE like codex-acp and falls back to Auto review', () => {
    expect(initialCodexMode({}).id).toBe('agent')
    expect(initialCodexMode({ INITIAL_AGENT_MODE: 'agent-full-access' }).id).toBe('agent-full-access')
    expect(initialCodexMode({ INITIAL_AGENT_MODE: 'not-a-mode' }).id).toBe('agent')
  })

  it('maps every mode to the approval policy, reviewer and sandbox of codex-acp', () => {
    const settings = (id: string): unknown => {
      const mode = findCodexMode(id)
      if (mode === undefined) throw new Error(`missing mode ${id}`)
      return {
        approvalPolicy: mode.settings.approvalPolicy,
        approvalsReviewer: mode.settings.approvalsReviewer,
        sandboxPolicy: mode.settings.sandboxPolicy,
      }
    }
    expect(settings('read-only')).toEqual({
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    })
    expect(settings('workspace-write')).toEqual({
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    })
    expect(settings('agent')).toMatchObject({ approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' })
    expect(settings('agent-full-access')).toEqual({
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'dangerFullAccess' },
    })
  })

  it('moves the effort list and image input with the selected model', () => {
    const state = controlsState()
    state.setModel('gpt-5.6-sol')
    // The effort survives a model change when the new model supports it, else the model default applies.
    expect(state.effort).toBe('max')
    const effort = state.snapshot().configOptions.find((option) => option.id === 'reasoning_effort')
    expect(effort?.type === 'select' && effort.options.map((option) => ('value' in option ? option.value : ''))).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ])
    state.setEffort('ultra')
    state.setModel('gpt-6-astra')
    expect(state.effort).toBe('xhigh')
    state.setModel('glm-5.3')
    expect(state.snapshot().imageInput).toBe(false)
  })

  it('offers fast mode only for models with a fast tier and sends it as the service tier', () => {
    const state = controlsState()
    expect(state.snapshot().configOptions.some((option) => option.id === 'fast-mode')).toBe(false)
    state.setModel('gpt-5.6-sol')
    const fast = state.snapshot().configOptions.find((option) => option.id === 'fast-mode')
    expect(fast).toEqual({
      id: 'fast-mode',
      name: 'Fast mode',
      description: '1.5x speed, increased usage',
      category: 'model_config',
      type: 'select',
      currentValue: 'off',
      options: [
        { value: 'off', name: 'Off', description: 'Default speed, normal usage' },
        { value: 'on', name: 'On', description: '1.5x speed, increased usage' },
      ],
    })
    expect(state.serviceTier).toBeNull()
    state.setFastMode('on')
    expect(state.serviceTier).toBe('fast')
    state.setModel('glm-5.3')
    expect(state.serviceTier).toBeNull()
  })

  it('rejects unknown values without changing state', () => {
    const state = controlsState()
    expect(() => state.setMode('nope')).toThrow(NativeTransportError)
    expect(() => state.setModel('gpt-0')).toThrow(NativeTransportError)
    expect(() => state.setEffort('ultra')).toThrow(NativeTransportError)
    expect(() => state.parseCollaborationMode('maybe')).toThrow(NativeTransportError)
    expect(state.mode.id).toBe('agent')
    expect(state.modelId).toBe('gpt-6-astra')
    expect(state.effort).toBe('max')
  })

  it('keeps a model the catalogue no longer lists selectable as the current value', () => {
    const state = new CodexControlsState({
      mode: initialCodexMode({}),
      collaborationMode: 'default',
      models: CATALOGUE,
      modelId: 'gpt-retired',
      effort: 'medium',
      fastModeEnabled: false,
    })
    const model = state.snapshot().configOptions.find((option) => option.id === 'model')
    // codex-acp names a model the catalogue dropped the same way it names a listed `gpt-*` model.
    expect(model?.type === 'select' && model.options[0]).toEqual({ value: 'gpt-retired', name: 'Retired', description: null })
    // No effort scale is known for it, so there is no effort option.
    expect(state.snapshot().configOptions.some((option) => option.id === 'reasoning_effort')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2. Unified diffs, token accounting, small renderers
// ---------------------------------------------------------------------------

describe('codex diffs and tokens', () => {
  it('parses one-file unified diffs with or without headers', () => {
    expect(parseSingleUnifiedPatch('@@ -1 +1 @@\n-hello\n+hello2\n')).toEqual([{ lines: ['-hello', '+hello2'] }])
    expect(
      parseSingleUnifiedPatch('--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n@@ -10 +10 @@\n-d\n+e\n'),
    ).toEqual([{ lines: [' a', '-b', '+c'] }, { lines: ['-d', '+e'] }])
    // Two files are not "a single patch"; a broken hunk is not a patch at all.
    expect(parseSingleUnifiedPatch('--- a\n+++ a\n@@ -1 +1 @@\n-x\n+y\n--- b\n+++ b\n@@ -1 +1 @@\n-x\n+y\n')).toBeNull()
    expect(parseSingleUnifiedPatch('@@ -1,3 +1,3 @@\n-only one line\n')).toBeNull()
  })

  it('unwraps shell prefixes like codex-acp', () => {
    expect(stripShellPrefix("/bin/zsh -lc 'echo hi'")).toBe('echo hi')
    expect(stripShellPrefix('bash -c ls')).toBe('ls')
    expect(stripShellPrefix('ls -la')).toBe('ls -la')
  })

  it('counts input without the cached and cache-written share', () => {
    expect(
      toTokenCount({
        totalTokens: 23_425,
        inputTokens: 23_313,
        cachedInputTokens: 11_586,
        cacheWriteInputTokens: 11_721,
        outputTokens: 112,
        reasoningOutputTokens: 34,
      }),
    ).toEqual({
      totalTokens: 23_425,
      inputTokens: 6,
      cachedInputTokens: 11_586,
      cacheWriteInputTokens: 11_721,
      outputTokens: 112,
      reasoningOutputTokens: 34,
    })
  })

  it('sums a prompt as the growth of the thread total and reports context occupancy', () => {
    const tokens = new CodexTokenAccounting(false)
    tokens.beginPrompt()
    tokens.observeModelOutput()
    const first = tokens.record({
      last: { totalTokens: 1050, inputTokens: 1000, cachedInputTokens: 0, cacheWriteInputTokens: 900, outputTokens: 50, reasoningOutputTokens: 20 },
      total: { totalTokens: 1050, inputTokens: 1000, cachedInputTokens: 0, cacheWriteInputTokens: 900, outputTokens: 50, reasoningOutputTokens: 20 },
      modelContextWindow: 200_000,
    })
    expect(first).toEqual({ used: 1050, size: 200_000 })
    const second = tokens.record({
      last: { totalTokens: 1230, inputTokens: 1200, cachedInputTokens: 900, cacheWriteInputTokens: 100, outputTokens: 30, reasoningOutputTokens: 0 },
      total: { totalTokens: 2280, inputTokens: 2200, cachedInputTokens: 900, cacheWriteInputTokens: 1000, outputTokens: 80, reasoningOutputTokens: 20 },
      modelContextWindow: 200_000,
    })
    // Context occupancy is the size of the last request, not the running total.
    expect(second).toEqual({ used: 1230, size: 200_000 })
    expect(tokens.promptUsage()).toEqual({
      inputTokens: 300,
      outputTokens: 80,
      cachedReadTokens: 900,
      cachedWriteTokens: 1000,
      thoughtTokens: 20,
    })
  })

  it('subtracts the thread total at the start of a later prompt and sums per call when it is unknown', () => {
    const resumed = new CodexTokenAccounting(true)
    const call = (total: number): Record<string, unknown> => ({
      last: { totalTokens: 100, inputTokens: 80, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 0 },
      total: { totalTokens: total, inputTokens: total - 40, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 40, reasoningOutputTokens: 0 },
      modelContextWindow: 1000,
    })
    // The usage replay of the resume arrives before the prompt starts.
    resumed.record(call(500))
    resumed.beginPrompt()
    resumed.observeModelOutput()
    resumed.record(call(600))
    resumed.record(call(700))
    // The prompt owns the growth of the thread total since the replay: 200 input, no new output.
    expect(resumed.promptUsage()).toMatchObject({ inputTokens: 200, outputTokens: 0 })

    // A resume whose replay was missed has no start total: the per-call counts are summed instead.
    const missed = new CodexTokenAccounting(true)
    missed.beginPrompt()
    missed.observeModelOutput()
    missed.record(call(600))
    missed.record(call(700))
    expect(missed.promptUsage()).toMatchObject({ inputTokens: 160, outputTokens: 40 })
    expect(new CodexTokenAccounting(false).promptUsage()).toBeUndefined()
  })

  it('renders OpenAI-style service errors as their message', () => {
    expect(
      readableServiceErrorMessage('{"type":"error","status":429,"error":{"type":"rate_limit_error","message":"Slow down"}}'),
    ).toBe('Slow down')
    expect(readableServiceErrorMessage('plain failure')).toBe('plain failure')
    expect(readableServiceErrorMessage('{"type":"error","status":200,"error":{"type":"server_error","message":"x"}}')).toBe(
      '{"type":"error","status":200,"error":{"type":"server_error","message":"x"}}',
    )
  })
})

// ---------------------------------------------------------------------------
// 3. Reverse requests: every class is answered, in codex-acp's ACP shape
// ---------------------------------------------------------------------------

interface StubHost {
  readonly host: CodexApprovalHost
  readonly requests: NativePermissionRequest[]
  readonly updates: acp.SessionUpdate[]
  readonly projection: CodexProjection
}

function stubHost(decide: (request: NativePermissionRequest) => NativePermissionDecision): StubHost {
  const requests: NativePermissionRequest[] = []
  const updates: acp.SessionUpdate[] = []
  const projection = new CodexProjection(
    {
      update: (update) => updates.push(update),
      contextUsage: () => undefined,
    },
    new CodexTokenAccounting(false),
  )
  const host: CodexApprovalHost = {
    context: projection,
    ask: async (request) => {
      requests.push(request)
      return decide(request)
    },
    update: (update) => updates.push(update),
    nextStandaloneMcpToolCallId: (threadId, serverName) => projection.nextStandaloneMcpToolCallId(threadId, serverName),
    log: () => undefined,
  }
  return { host, requests, updates, projection }
}

const never = new AbortController().signal

describe('codex reverse requests', () => {
  const commandParams = {
    threadId: 't',
    turnId: 'u',
    itemId: 'item_cmd',
    command: "/bin/zsh -lc 'rm x'",
    cwd: '/w',
    reason: 'cleanup',
    commandActions: [{ type: 'unknown', command: 'rm x' }],
  }

  it('asks command approvals with the options and tool call codex-acp builds', async () => {
    const stub = stubHost(() => ({ optionId: 'allow_for_session' }))
    const answer = await answerCodexServerRequest('item/commandExecution/requestApproval', commandParams, stub.host, never)
    expect(answer).toEqual({ result: { decision: 'acceptForSession' } })
    const request = stub.requests[0]
    expect(request?.options).toEqual([
      { optionId: 'allow_once', name: 'Yes, proceed', kind: 'allow_once' },
      { optionId: 'allow_for_session', name: "Yes, and don't ask again for this command in this session", kind: 'allow_always' },
      { optionId: 'decline', name: 'No, continue without running it', kind: 'reject_once' },
      { optionId: 'cancel', name: 'No, and tell Codex what to do differently', kind: 'reject_once' },
    ])
    expect(request?.toolCall).toEqual({
      toolCallId: 'item_cmd',
      kind: 'execute',
      status: 'pending',
      title: 'Run command',
      rawInput: { command: 'rm x', cwd: '/w' },
    })
  })

  it('maps each chosen command option, a dismissed prompt and an unknown option to a decision', async () => {
    const decisionFor = async (decision: NativePermissionDecision): Promise<unknown> => {
      const stub = stubHost(() => decision)
      return await answerCodexServerRequest('item/commandExecution/requestApproval', commandParams, stub.host, never)
    }
    expect(await decisionFor({ optionId: 'allow_once' })).toEqual({ result: { decision: 'accept' } })
    expect(await decisionFor({ optionId: 'decline' })).toEqual({ result: { decision: 'decline' } })
    expect(await decisionFor({ optionId: 'cancel' })).toEqual({ result: { decision: 'cancel' } })
    expect(await decisionFor({ cancelled: true })).toEqual({ result: { decision: 'cancel' } })
    expect(await decisionFor({ optionId: 'something-else' })).toEqual({ result: { decision: 'cancel' } })
  })

  it('offers the exec-policy and network amendments Codex proposed', async () => {
    const stub = stubHost(() => ({ optionId: 'accept_execpolicy_amendment' }))
    const answer = await answerCodexServerRequest(
      'item/commandExecution/requestApproval',
      { ...commandParams, proposedExecpolicyAmendment: ['rm', 'x'] },
      stub.host,
      never,
    )
    expect(answer).toEqual({
      result: { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['rm', 'x'] } } },
    })
    expect(stub.requests[0]?.options.map((option) => option.optionId)).toEqual([
      'allow_once',
      'allow_for_session',
      'accept_execpolicy_amendment',
      'decline',
      'cancel',
    ])
    expect(stub.requests[0]?.options[2]?.name).toBe("Yes, and don't ask again for commands that start with `rm x`")

    const network = stubHost(() => ({ optionId: 'apply_network_policy_amendment:0' }))
    const networkAnswer = await answerCodexServerRequest(
      'item/commandExecution/requestApproval',
      {
        ...commandParams,
        networkApprovalContext: { host: 'example.com', protocol: 'https' },
        proposedNetworkPolicyAmendments: [{ host: 'example.com', action: 'allow' }],
      },
      network.host,
      never,
    )
    expect(networkAnswer).toEqual({
      result: {
        decision: { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.com', action: 'allow' } } },
      },
    })
    expect(network.requests[0]?.toolCall.title).toBe('https network access to example.com')
  })

  it('cancels a command approval whose decision set cannot be offered safely', async () => {
    const stub = stubHost(() => ({ optionId: 'allow_once' }))
    const answer = await answerCodexServerRequest(
      'item/commandExecution/requestApproval',
      { ...commandParams, availableDecisions: ['accept'] },
      stub.host,
      never,
    )
    expect(answer).toEqual({ result: { decision: 'cancel' } })
    expect(stub.requests).toHaveLength(0)
  })

  it('answers file-change approvals and shows the diff paths of a started change', async () => {
    const stub = stubHost(() => ({ optionId: 'allow_once' }))
    stub.projection.handle('item/started', {
      threadId: 't',
      item: { type: 'fileChange', id: 'patch-1', status: 'inProgress', changes: [{ path: '/w/a.txt', kind: { type: 'add' }, diff: 'x\n' }] },
    })
    const answer = await answerCodexServerRequest(
      'item/fileChange/requestApproval',
      { threadId: 't', turnId: 'u', itemId: 'patch-1', reason: 'write outside' },
      stub.host,
      never,
    )
    expect(answer).toEqual({ result: { decision: 'accept' } })
    expect(stub.requests[0]?.options).toEqual([
      { optionId: 'allow_once', name: 'Yes, proceed', kind: 'allow_once' },
      { optionId: 'allow_for_session', name: "Yes, and don't ask again for these files", kind: 'allow_always' },
      { optionId: 'cancel', name: 'No, and tell Codex what to do differently', kind: 'reject_once' },
    ])
    expect(stub.requests[0]?.toolCall).toEqual({
      toolCallId: 'patch-1',
      title: 'Edit files',
      kind: 'edit',
      status: 'pending',
      locations: [{ path: '/w/a.txt' }],
    })
  })

  it('grants exactly what was requested for the chosen scope and nothing on rejection', async () => {
    const permissions = { network: { enabled: true }, fileSystem: { read: ['/r'], write: ['/w'] } }
    const grant = async (optionId: string): Promise<unknown> => {
      const stub = stubHost(() => ({ optionId }))
      return await answerCodexServerRequest(
        'item/permissions/requestApproval',
        { threadId: 't', turnId: 'u', itemId: 'perm-1', cwd: '/w', permissions },
        stub.host,
        never,
      )
    }
    expect(await grant('allow_permissions_turn')).toEqual({ result: { permissions, scope: 'turn', strictAutoReview: false } })
    expect(await grant('allow_permissions_turn_strict_auto_review')).toEqual({
      result: { permissions, scope: 'turn', strictAutoReview: true },
    })
    expect(await grant('allow_permissions_session')).toEqual({ result: { permissions, scope: 'session', strictAutoReview: false } })
    expect(await grant('reject_permissions')).toEqual({ result: { permissions: {}, scope: 'turn', strictAutoReview: false } })
    const dismissed = stubHost(() => ({ cancelled: true }))
    expect(
      await answerCodexServerRequest('item/permissions/requestApproval', { itemId: 'p', permissions }, dismissed.host, never),
    ).toEqual({ result: { permissions: {}, scope: 'turn', strictAutoReview: false } })
    expect(dismissed.requests[0]?.options.map((option) => option.optionId)).toEqual([
      'allow_permissions_turn',
      'allow_permissions_turn_strict_auto_review',
      'allow_permissions_session',
      'reject_permissions',
    ])
  })

  it('correlates an MCP tool approval with the started call and honours the persist choices', async () => {
    const stub = stubHost(() => ({ optionId: 'allow_session' }))
    stub.projection.handle('item/started', {
      threadId: 't',
      item: { type: 'mcpToolCall', id: 'mcp-1', server: 'docs', tool: 'search', arguments: {}, status: 'inProgress', result: null, error: null },
    })
    const answer = await answerCodexServerRequest(
      'mcpServer/elicitation/request',
      {
        threadId: 't',
        turnId: 'u',
        serverName: 'docs',
        mode: 'form',
        message: 'Allow docs?',
        requestedSchema: null,
        _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'] },
      },
      stub.host,
      never,
    )
    expect(answer).toEqual({ result: { action: 'accept', content: null, _meta: { persist: 'session' } } })
    expect(stub.requests[0]?.options).toEqual([
      { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'allow_session', name: 'Allow for this session', kind: 'allow_always' },
      { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
    ])
    expect(stub.requests[0]?.toolCall).toEqual({ toolCallId: 'mcp-1', kind: 'execute', status: 'pending' })
    expect(stub.updates.at(-1)).toMatchObject({ sessionUpdate: 'tool_call_update', toolCallId: 'mcp-1', status: 'in_progress' })
  })

  it('answers a message-only MCP question as a standalone call and cancels real forms', async () => {
    const decline = stubHost(() => ({ optionId: 'decline' }))
    const answer = await answerCodexServerRequest(
      'mcpServer/elicitation/request',
      { threadId: 't', serverName: 'docs', mode: 'form', message: 'Proceed?', requestedSchema: null },
      decline.host,
      never,
    )
    expect(answer).toEqual({ result: { action: 'decline', content: null, _meta: null } })
    expect(decline.requests[0]?.toolCall).toMatchObject({
      toolCallId: 'elicitation:t:docs:1',
      kind: 'other',
      title: 'Question from MCP server',
    })
    expect(decline.requests[0]?.options.map((option) => option.optionId)).toEqual(['accept', 'decline', 'cancel'])
    expect(decline.updates.at(-1)).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'elicitation:t:docs:1',
      status: 'completed',
      rawOutput: { action: 'decline' },
    })

    const form = stubHost(() => ({ optionId: 'accept' }))
    expect(
      await answerCodexServerRequest(
        'mcpServer/elicitation/request',
        {
          threadId: 't',
          serverName: 'docs',
          mode: 'form',
          message: 'Fill in',
          requestedSchema: { type: 'object', properties: { name: { type: 'string' } } },
        },
        form.host,
        never,
      ),
    ).toEqual({ result: { action: 'cancel', content: null, _meta: null } })
    expect(form.requests).toHaveLength(0)
  })

  it('asks each multiple-choice question with its labels as options', async () => {
    const stub = stubHost((request) => ({ optionId: request.options[1]?.optionId ?? 'dismiss' }))
    const answer = await answerCodexServerRequest(
      'item/tool/requestUserInput',
      {
        threadId: 't',
        turnId: 'u',
        itemId: 'q-1',
        questions: [
          { id: 'color', header: 'Pick', question: 'Which color?', options: [{ label: 'red' }, { label: 'blue' }] },
          { id: 'free', header: 'Name', question: 'Your name?', options: null },
        ],
      },
      stub.host,
      never,
    )
    expect(answer).toEqual({ result: { answers: { color: { answers: ['blue'] } } } })
    expect(stub.requests).toHaveLength(1)
    expect(stub.requests[0]?.toolCall).toMatchObject({ toolCallId: 'q-1', title: 'Pick: Which color?' })
    expect(stub.requests[0]?.options.map((option) => option.name)).toEqual(['red', 'blue', 'No answer'])

    const dismissed = stubHost(() => ({ cancelled: true }))
    expect(
      await answerCodexServerRequest(
        'item/tool/requestUserInput',
        { itemId: 'q', questions: [{ id: 'a', question: 'A?', options: [{ label: 'x' }] }] },
        dismissed.host,
        never,
      ),
    ).toEqual({ result: { answers: {} } })
  })

  it('answers the legacy v1 approvals with ReviewDecision values', async () => {
    const decide = async (method: string, params: Record<string, unknown>, optionId: string): Promise<unknown> =>
      await answerCodexServerRequest(method, params, stubHost(() => ({ optionId })).host, never)
    expect(await decide('applyPatchApproval', { callId: 'c', fileChanges: { '/w/a': {} } }, 'allow_once')).toEqual({
      result: { decision: 'approved' },
    })
    expect(await decide('applyPatchApproval', { callId: 'c' }, 'allow_for_session')).toEqual({
      result: { decision: 'approved_for_session' },
    })
    expect(await decide('applyPatchApproval', { callId: 'c' }, 'cancel')).toEqual({ result: { decision: 'abort' } })
    expect(await decide('execCommandApproval', { callId: 'c', command: ['rm', 'x'], cwd: '/w' }, 'decline')).toEqual({
      result: { decision: 'denied' },
    })
    expect(await decide('execCommandApproval', { callId: 'c', command: ['ls'] }, 'allow_once')).toEqual({
      result: { decision: 'approved' },
    })
  })

  it('answers the requests that need no human with schema-valid defaults', async () => {
    const stub = stubHost(() => ({ cancelled: true }))
    expect(await answerCodexServerRequest('item/tool/call', { callId: 'c', tool: 'x', arguments: {} }, stub.host, never)).toMatchObject({
      result: { success: false },
    })
    const now = await answerCodexServerRequest('currentTime/read', {}, stub.host, never)
    expect('result' in now && Math.abs(Number(objectOf(now.result)['currentTimeAt']) - Date.now() / 1000)).toBeLessThan(10)
    for (const method of ['account/chatgptAuthTokens/refresh', 'attestation/generate', 'brand/newMethod']) {
      const answer = await answerCodexServerRequest(method, {}, stub.host, never)
      expect('error' in answer && answer.error.code).toBe(-32601)
    }
    expect(stub.requests).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 4. The transport against a scripted fake app-server
// ---------------------------------------------------------------------------

describe('codex transport launch and session attachment', () => {
  it('spawns the launcher with app-server appended, only through the host seam, with the explicit environment', async () => {
    const harness = await launch({ env: { FAKE_MARK: 'explicit', MODEL_PROVIDER: 'codex-tr' } })
    expect(harness.spawns).toHaveLength(1)
    expect(harness.spawns[0]).toMatchObject({ argv: [process.execPath, harness.script, 'app-server'], cwd: harness.dir })
    expect(harness.spawns[0]?.env).toMatchObject({ FAKE_MARK: 'explicit', MODEL_PROVIDER: 'codex-tr' })
    const boot = harness.frames().find((frame) => 'boot' in frame)
    expect(boot).toMatchObject({
      boot: { argv: ['app-server'], cwd: harness.dir, env: { FAKE_MARK: 'explicit', MODEL_PROVIDER: 'codex-tr' } },
    })
    expect(harness.transport.kind).toBe('codex')
    expect(harness.transport.canFork).toBe(true)
    // codex-launch.mjs / DSH_CODEX_COMMAND cannot be bypassed with a node: nothing spawns process.execPath implicitly.
    for (const file of ['codex.ts', 'codex-approvals.ts', 'codex-controls.ts', 'codex-projection.ts']) {
      const source = readFileSync(fileURLToPath(new URL(`../../src/runtime/native/transports/${file}`, import.meta.url)), 'utf8')
      expect(source, file).not.toMatch(/node:child_process/)
      expect(source, file).not.toMatch(/\bprocess\.(execPath|cwd|env|platform)\b/)
    }
  })

  it('performs the initialize handshake codex-acp performs and reports the Codex version', async () => {
    const harness = await launch()
    const initialize = harness.sent('initialize')[0]
    expect(initialize?.params).toEqual({
      clientInfo: { name: '@local/dsh-acp-adapter', title: 'Codex ACP', version: '0.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
    expect(harness.sent('initialized')).toHaveLength(1)
    expect(harness.transport.agentInfo).toEqual({ name: 'codex', version: '0.162.1' })
  })

  it('starts a thread with the session config, provider and directory codex-acp sends', async () => {
    const harness = await launch({ env: { MODEL_PROVIDER: 'codex-tr' } })
    expect(harness.sent('thread/start')[0]?.params).toEqual({
      config: {
        features: { cwd_relative_turn_diffs: false },
        projects: { [harness.dir]: { trust_level: 'trusted' } },
      },
      modelProvider: 'codex-tr',
      cwd: harness.dir,
    })
    expect(harness.transport.sessionId).toBe('thr_test')
    expect(harness.logs.some((line) => line.includes('thr_test ready') && line.includes('provider fake-provider'))).toBe(true)
    // Without MODEL_PROVIDER the provider is null, exactly like codex-acp.
    const plain = await launch()
    expect(paramsOf(plain.sent('thread/start')[0])['modelProvider']).toBeNull()
  })

  it('merges CODEX_CONFIG into the session config and moves hooks to the startup flags', async () => {
    const harness = await launch({
      env: {
        CODEX_CONFIG: JSON.stringify({ model_reasoning_summary: 'detailed', features: { shell_tool: true }, hooks: { PreToolUse: [] } }),
      },
    })
    expect(paramsOf(harness.sent('thread/start')[0])['config']).toEqual({
      model_reasoning_summary: 'detailed',
      features: { shell_tool: true, cwd_relative_turn_diffs: false },
      projects: { [harness.dir]: { trust_level: 'trusted' } },
    })
    const boot = harness.frames().find((frame) => 'boot' in frame)
    expect(isRecord(boot?.['boot']) && boot['boot']['argv']).toEqual(['app-server', '-c', 'hooks={ "PreToolUse" = [] }'])
  })

  it('reports the controls of the thread response and the model catalogue', async () => {
    const harness = await launch({ config: { thread: { model: 'gpt-5.6-sol', reasoningEffort: 'ultra' } } })
    const controls = harness.transport.controls()
    expect(controls.modes?.currentModeId).toBe('agent')
    const byId = Object.fromEntries(controls.configOptions.map((option) => [option.id, option]))
    expect(Object.keys(byId)).toEqual(['mode', 'collaboration_mode', 'model', 'reasoning_effort', 'fast-mode'])
    expect(byId['model']).toMatchObject({ currentValue: 'gpt-5.6-sol' })
    expect(byId['reasoning_effort']).toMatchObject({ currentValue: 'ultra' })
    expect(controls.imageInput).toBe(true)
    // codex-acp reads every page of model/list.
    const paged = await launch({ config: { pageSize: 1 } })
    expect(paged.sent('model/list').map((frame) => paramsOf(frame)['cursor'])).toEqual([null, '1', '2'])
    expect(paged.transport.controls().configOptions.find((option) => option.id === 'model')).toMatchObject({
      options: [{ value: 'gpt-6-astra' }, { value: 'gpt-5.6-sol' }, { value: 'glm-5.3' }],
    })
  })

  it('falls back to the model default effort when the thread carries none', async () => {
    const harness = await launch({ config: { thread: { model: 'gpt-5.6-sol', reasoningEffort: null } } })
    expect(harness.transport.controls().configOptions.find((option) => option.id === 'reasoning_effort')).toMatchObject({
      currentValue: 'low',
    })
  })

  it('resumes a thread by the id the ACP route saved, with codex-acp resume params', async () => {
    const harness = await launch({
      env: { MODEL_PROVIDER: 'codex-tr' },
      session: { kind: 'resume', sessionId: 'thr_old' },
      config: { thread: { collaborationMode: 'plan' } },
    })
    expect(harness.sent('thread/resume')[0]?.params).toEqual({
      excludeTurns: true,
      config: { features: { cwd_relative_turn_diffs: false }, projects: { [harness.dir]: { trust_level: 'trusted' } } },
      cwd: harness.dir,
      modelProvider: 'codex-tr',
      threadId: 'thr_old',
    })
    expect(harness.transport.sessionId).toBe('thr_old')
    expect(harness.sent('thread/start')).toHaveLength(0)
    // The collaboration mode comes from the resume response.
    expect(harness.transport.controls().configOptions.find((option) => option.id === 'collaboration_mode')).toMatchObject({
      currentValue: 'plan',
    })
  })

  it('asks Codex for the configured provider when the profile names none, else uses openai', async () => {
    const configured = await launch({ session: { kind: 'resume', sessionId: 'thr_old' }, config: { configProvider: 'from-config' } })
    expect(paramsOf(configured.sent('thread/resume')[0])['modelProvider']).toBe('from-config')
    const bare = await launch({ session: { kind: 'resume', sessionId: 'thr_old' } })
    expect(paramsOf(bare.sent('thread/resume')[0])['modelProvider']).toBe('openai')
  })

  it('forks a thread with the parent id and reports the new thread', async () => {
    const harness = await launch({ env: { MODEL_PROVIDER: 'codex-tr' }, session: { kind: 'fork', parentSessionId: 'thr_parent' } })
    expect(harness.sent('thread/fork')[0]?.params).toEqual({
      excludeTurns: true,
      config: { features: { cwd_relative_turn_diffs: false }, projects: { [harness.dir]: { trust_level: 'trusted' } } },
      cwd: harness.dir,
      modelProvider: 'codex-tr',
      threadId: 'thr_parent',
    })
    expect(harness.transport.sessionId).toBe('thr_fork')
  })

  it('reports an unknown thread as "session not found"', async () => {
    const error = await launch({ session: { kind: 'resume', sessionId: 'thr_gone' }, config: { threads: {} } }).catch(
      (failure: unknown) => failure,
    )
    expect(error).toBeInstanceOf(NativeTransportError)
    expect(nativeError(error).code).toBe('session-not-found')
    expect(nativeError(error).message).toContain('session not found')
    expect(nativeError(error).message).toContain('thr_gone')
  })

  it('unarchives an archived thread and resumes it', async () => {
    const harness = await launch({
      session: { kind: 'resume', sessionId: 'thr_archived' },
      config: { threads: { thr_archived: 'archived' } },
    })
    expect(harness.transport.sessionId).toBe('thr_archived')
    expect(harness.sent('thread/resume')).toHaveLength(2)
    expect(harness.sent('thread/unarchive')[0]?.params).toEqual({ threadId: 'thr_archived' })
  })

  it('reports a thread another client holds as in use', async () => {
    const error = await launch({ session: { kind: 'resume', sessionId: 'thr_busy' }, config: { threads: { thr_busy: 'busy' } } }).catch(
      (failure: unknown) => failure,
    )
    expect(nativeError(error).code).toBe('session-in-use')
  })

  it('fails start with the process facts when the app-server dies during the handshake', async () => {
    const error = await launch({ config: { exitOnInitialize: true } }).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(NativeTransportError)
    expect(nativeError(error).code).toBe('process-exit')
    expect(nativeError(error).detail).toContain('fake boot failure')
  })

  it('surfaces a spawn failure from the host seam unchanged', async () => {
    const failure = new NativeTransportError('could not launch codex', 'spawn-failed')
    const error = await launch({
      spawn: () => {
        throw failure
      },
    }).catch((caught: unknown) => caught)
    expect(error).toBe(failure)
  })

  it('advertises the commands it implements and the skills Codex lists', async () => {
    const harness = await launch({
      config: { skills: [{ name: 'deploy', description: 'long', shortDescription: 'Deploy it' }, { name: 'lint', description: 'Lint all' }] },
    })
    await waitFor(() => harness.updates('available_commands_update').length >= 2)
    const [plain, withSkills] = harness.updates('available_commands_update')
    const names = (update: acp.SessionUpdate | undefined): string[] =>
      update?.sessionUpdate === 'available_commands_update' ? update.availableCommands.map((command) => command.name) : []
    expect(names(plain)).toEqual(['plan', 'skills', 'status', 'review', 'review-branch', 'review-commit', 'compact', 'rename'])
    expect(names(withSkills).slice(-2)).toEqual(['$deploy', '$lint'])
    expect(withSkills?.sessionUpdate === 'available_commands_update' && withSkills.availableCommands.at(-2)).toEqual({
      name: '$deploy',
      description: 'Deploy it',
      input: null,
    })
  })
})

describe('codex per-turn settings', () => {
  const lastTurnStart = (harness: Harness): Record<string, unknown> => paramsOf(harness.sent('turn/start').at(-1))

  it('sends the default mode, model, effort and summary like codex-acp runTurn', async () => {
    const harness = await launch()
    await harness.prompt('hello')
    expect(lastTurnStart(harness)).toEqual({
      threadId: 'thr_test',
      input: [{ type: 'text', text: 'hello', text_elements: [] }],
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      summary: 'auto',
      effort: 'max',
      model: 'gpt-6-astra',
      serviceTier: null,
    })
  })

  it('runs unattended in Full access: approvals never, no sandbox', async () => {
    const harness = await launch({ env: { INITIAL_AGENT_MODE: 'agent-full-access' } })
    await harness.prompt('hello')
    expect(lastTurnStart(harness)).toMatchObject({
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'dangerFullAccess' },
    })
    expect(harness.permissions).toHaveLength(0)
  })

  it('applies a mode chosen later to the next turn and to the thread', async () => {
    const harness = await launch()
    for (const [modeId, expected] of [
      ['agent-full-access', { approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' } }],
      ['read-only', { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly', networkAccess: false } }],
      ['agent', { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' }],
    ] as const) {
      await harness.transport.setConfigOption('mode', modeId)
      expect(harness.transport.controls().modes?.currentModeId).toBe(modeId)
      const mode = harness.transport.controls().configOptions.find((option) => option.id === 'mode')
      expect(mode).toMatchObject({ currentValue: modeId })
      await harness.prompt('go')
      expect(lastTurnStart(harness)).toMatchObject(expected)
      expect(paramsOf(harness.sent('thread/settings/update').at(-1))).toMatchObject({ threadId: 'thr_test', ...expected })
    }
  })

  it('applies model and effort choices to the next turn and keeps the effort list consistent', async () => {
    const harness = await launch()
    await harness.transport.setConfigOption('model', 'gpt-5.6-sol')
    await harness.transport.setConfigOption('reasoning_effort', 'ultra')
    const controls = harness.transport.controls()
    expect(controls.configOptions.find((option) => option.id === 'model')).toMatchObject({ currentValue: 'gpt-5.6-sol' })
    expect(controls.configOptions.find((option) => option.id === 'reasoning_effort')).toMatchObject({ currentValue: 'ultra' })
    await harness.prompt('go')
    expect(lastTurnStart(harness)).toMatchObject({ model: 'gpt-5.6-sol', effort: 'ultra', serviceTier: null })
    await harness.transport.setConfigOption('fast-mode', 'on')
    await harness.prompt('again')
    expect(lastTurnStart(harness)).toMatchObject({ model: 'gpt-5.6-sol', serviceTier: 'fast' })
    await expect(harness.transport.setConfigOption('reasoning_effort', 'nonsense')).rejects.toBeInstanceOf(NativeTransportError)
    await expect(harness.transport.setConfigOption('model', 'gpt-0')).rejects.toBeInstanceOf(NativeTransportError)
    await expect(harness.transport.setConfigOption('unknown_option', 'x')).rejects.toBeInstanceOf(NativeTransportError)
    expect(harness.transport.controls().configOptions.find((option) => option.id === 'model')).toMatchObject({
      currentValue: 'gpt-5.6-sol',
    })
  })

  it('sets the collaboration mode on the thread with the current model and effort', async () => {
    const harness = await launch()
    await harness.transport.setConfigOption('model', 'glm-5.3')
    await harness.transport.setConfigOption('reasoning_effort', 'medium')
    await harness.transport.setConfigOption('collaboration_mode', 'plan')
    expect(paramsOf(harness.sent('thread/settings/update').at(-1))).toEqual({
      threadId: 'thr_test',
      collaborationMode: {
        mode: 'plan',
        settings: { model: 'glm-5.3', reasoning_effort: 'medium', developer_instructions: null },
      },
    })
    expect(harness.transport.controls().configOptions.find((option) => option.id === 'collaboration_mode')).toMatchObject({
      currentValue: 'plan',
    })
    await expect(harness.transport.setConfigOption('collaboration_mode', 'chat')).rejects.toBeInstanceOf(NativeTransportError)
  })

  it('turns reasoning summaries off for API-key accounts on the OpenAI provider only', async () => {
    // The provider the thread response reports decides, as in codex-acp (not the launch variable).
    const apiKey = await launch({ config: { thread: { modelProvider: 'openai' }, account: { type: 'apiKey' } } })
    await apiKey.prompt('hi')
    expect(lastTurnStart(apiKey)['summary']).toBe('none')
    // A gateway provider has no account: codex-acp never reads it and keeps summaries on.
    const gateway = await launch({ env: { MODEL_PROVIDER: 'codex-tr' }, config: { thread: { modelProvider: 'codex-tr' }, account: { type: 'apiKey' } } })
    await gateway.prompt('hi')
    expect(lastTurnStart(gateway)['summary']).toBe('auto')
    expect(gateway.sent('account/read')).toHaveLength(0)
  })

  it('sends images as data URLs and refuses them for a text-only model', async () => {
    const harness = await launch()
    await harness.transport.prompt(
      [
        { type: 'text', text: 'look' },
        { type: 'image', data: 'QUJD', mimeType: 'image/png' },
      ],
      new AbortController().signal,
    )
    expect(lastTurnStart(harness)['input']).toEqual([
      { type: 'text', text: 'look', text_elements: [] },
      { type: 'image', url: 'data:image/png;base64,QUJD' },
    ])
    await harness.transport.setConfigOption('model', 'glm-5.3')
    expect(harness.transport.controls().imageInput).toBe(false)
    const before = harness.sent('turn/start').length
    await expect(
      harness.transport.prompt([{ type: 'image', data: 'QUJD', mimeType: 'image/png' }], new AbortController().signal),
    ).rejects.toMatchObject({ code: 'image-unsupported' })
    expect(harness.sent('turn/start')).toHaveLength(before)
  })

  it('rejects empty prompts and concurrent prompts without touching the wire', async () => {
    const harness = await launch({ config: { turns: [[{ wait: 'interrupt' }]] } })
    await expect(harness.transport.prompt([], new AbortController().signal)).rejects.toMatchObject({ code: 'empty-prompt' })
    const controller = new AbortController()
    const running = harness.prompt('first', controller.signal)
    await waitFor(() => harness.sent('turn/start').length === 1)
    await expect(harness.prompt('second')).rejects.toMatchObject({ code: 'busy' })
    controller.abort()
    await expect(running).resolves.toMatchObject({ stopReason: 'cancelled' })
    expect(harness.sent('turn/start')).toHaveLength(1)
  })
})

describe('codex projection through the transport', () => {
  it('renders a terminal command like codex-acp for a client without terminal capabilities', async () => {
    const harness = await launch({
      config: {
        turns: [
          [
            itemStarted(commandItem('exec-1')),
            note('item/commandExecution/outputDelta', { itemId: 'exec-1', delta: 'hel' }),
            note('item/commandExecution/outputDelta', { itemId: 'exec-1', delta: 'lo\n' }),
            itemCompleted(commandItem('exec-1', { status: 'completed', aggregatedOutput: 'hello\n', exitCode: 0, durationMs: 3 })),
            ...messageSteps('msg-1', 'DONE'),
          ],
        ],
      },
    })
    const result = await harness.prompt('run it')
    expect(result.stopReason).toBe('end_turn')
    expect(harness.updates().filter((update) => update.sessionUpdate !== 'available_commands_update')).toEqual([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'exec-1',
        name: 'exec_command',
        kind: 'execute',
        title: 'echo hello',
        status: 'in_progress',
        content: [{ type: 'terminal', terminalId: 'exec-1' }],
        rawInput: { command: 'echo hello', cwd: harness.dir },
        _meta: { terminal_info: { cwd: harness.dir, terminal_id: 'exec-1' } },
      },
      { sessionUpdate: 'tool_call_update', toolCallId: 'exec-1', _meta: { terminal_output_delta: { data: 'hel', terminal_id: 'exec-1' } } },
      { sessionUpdate: 'tool_call_update', toolCallId: 'exec-1', _meta: { terminal_output_delta: { data: 'lo\n', terminal_id: 'exec-1' } } },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'exec-1',
        name: 'exec_command',
        status: 'completed',
        _meta: { terminal_exit: { exit_code: 0, signal: null, terminal_id: 'exec-1' } },
      },
      { sessionUpdate: 'agent_message_chunk', messageId: 'msg-1', content: { type: 'text', text: 'DONE' } },
    ])
  })

  it('sends the whole output once when it never streamed, and leaves an unnamed agent command unnamed', async () => {
    const harness = await launch({
      config: {
        turns: [
          [
            itemStarted(commandItem('exec-2', { source: 'agent' })),
            itemCompleted(commandItem('exec-2', { source: 'agent', status: 'failed', aggregatedOutput: 'boom\n', exitCode: 2 })),
          ],
        ],
      },
    })
    await harness.prompt('run it')
    const [start, end] = harness.updates().filter((update) => update.sessionUpdate.startsWith('tool_call'))
    expect(start).not.toHaveProperty('name')
    expect(end).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'exec-2',
      status: 'failed',
      _meta: {
        terminal_output_delta: { data: 'boom\n', terminal_id: 'exec-2' },
        terminal_exit: { exit_code: 2, signal: null, terminal_id: 'exec-2' },
      },
    })
  })

  it('renders read-, search- and list-shaped commands without a terminal', async () => {
    const read = {
      commandActions: [{ type: 'read', command: 'cat a.ts', name: 'a.ts', path: '/w/a.ts' }],
      command: "/bin/zsh -lc 'cat a.ts'",
    }
    const search = { commandActions: [{ type: 'search', command: 'rg foo', query: 'foo', path: 'src' }] }
    const list = { commandActions: [{ type: 'listFiles', command: 'ls', path: 'src' }] }
    const multi = {
      command: "/bin/zsh -lc 'a && b'",
      commandActions: [
        { type: 'unknown', command: 'a' },
        { type: 'unknown', command: 'b' },
      ],
    }
    const harness = await launch({
      config: {
        turns: [
          [
            itemStarted(commandItem('rd', read)),
            itemCompleted(commandItem('rd', { ...read, status: 'completed', aggregatedOutput: 'content\n', exitCode: 0 })),
            itemStarted(commandItem('se', search)),
            itemStarted(commandItem('li', list)),
            itemStarted(commandItem('mu', multi)),
          ],
        ],
      },
    })
    await harness.prompt('go')
    const updates = harness.updates().filter((update) => update.sessionUpdate.startsWith('tool_call'))
    expect(updates[0]).toEqual({
      sessionUpdate: 'tool_call',
      toolCallId: 'rd',
      name: 'exec_command',
      kind: 'read',
      title: "Read file '/w/a.ts'",
      status: 'in_progress',
      locations: [{ path: '/w/a.ts' }],
    })
    expect(updates[1]).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'rd',
      name: 'exec_command',
      status: 'completed',
      rawOutput: { exit_code: 0 },
      _meta: { terminal_output_delta: { data: 'content\n', terminal_id: 'rd' } },
    })
    expect(updates[2]).toMatchObject({ toolCallId: 'se', kind: 'search', title: "Search for 'foo' in src" })
    expect(updates[3]).toMatchObject({ toolCallId: 'li', kind: 'read', title: "List files in 'src'" })
    expect(updates[4]).toMatchObject({
      toolCallId: 'mu',
      kind: 'execute',
      title: 'a && b',
      rawInput: { command: "/bin/zsh -lc 'a && b'", cwd: harness.dir },
    })
  })

  it('renders file changes as diff blocks and settles them', async () => {
    const changes = [
      { path: '/w/new.txt', kind: { type: 'add' }, diff: 'hello\n' },
      { path: '/w/edit.txt', kind: { type: 'update', move_path: null }, diff: '@@ -1,2 +1,2 @@\n a\n-b\n+c\n' },
      { path: '/w/gone.txt', kind: { type: 'delete' }, diff: 'bye\n' },
      { path: '/w/old.txt', kind: { type: 'update', move_path: '/w/moved.txt' }, diff: '' },
      { path: '/w/eol.txt', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n' },
    ]
    const harness = await launch({
      config: {
        turns: [
          [
            itemStarted({ type: 'fileChange', id: 'patch-1', changes, status: 'inProgress' }),
            itemCompleted({ type: 'fileChange', id: 'patch-1', changes, status: 'completed' }),
            itemStarted({ type: 'fileChange', id: 'patch-2', changes: [], status: 'inProgress' }),
            itemCompleted({ type: 'fileChange', id: 'patch-2', changes: [], status: 'declined' }),
          ],
        ],
      },
    })
    await harness.prompt('edit')
    const updates = harness.updates().filter((update) => update.sessionUpdate.startsWith('tool_call'))
    expect(updates[0]).toEqual({
      sessionUpdate: 'tool_call',
      toolCallId: 'patch-1',
      title: 'Editing files',
      kind: 'edit',
      status: 'in_progress',
      content: [
        { type: 'diff', path: '/w/new.txt', oldText: null, newText: 'hello\n', _meta: { kind: 'add' } },
        { type: 'diff', path: '/w/edit.txt', oldText: 'a\nb\n', newText: 'a\nc\n', _meta: { kind: 'update' } },
        { type: 'diff', path: '/w/gone.txt', oldText: 'bye\n', newText: '', _meta: { kind: 'delete' } },
        { type: 'diff', path: '/w/moved.txt', oldText: '', newText: '', _meta: { kind: 'update' } },
        { type: 'diff', path: '/w/eol.txt', oldText: 'a', newText: 'b', _meta: { kind: 'update' } },
      ],
    })
    expect(updates[1]).toEqual({ sessionUpdate: 'tool_call_update', toolCallId: 'patch-1', status: 'completed' })
    expect(updates[2]).toMatchObject({ toolCallId: 'patch-2', content: [] })
    expect(updates[3]).toEqual({ sessionUpdate: 'tool_call_update', toolCallId: 'patch-2', status: 'failed' })
  })

  it('renders MCP, dynamic, web search, image and compaction items', async () => {
    const mcp = { type: 'mcpToolCall', id: 'mcp-1', server: 'docs', tool: 'search', arguments: { q: 'x' }, status: 'inProgress', result: null, error: null }
    const web = { type: 'webSearch', id: 'ws-1', query: 'cats', action: { type: 'search', query: 'cats', queries: null } }
    const dynamic = { type: 'dynamicToolCall', id: 'dyn-1', namespace: 'ns.', tool: 'lookup', arguments: { a: 1 }, status: 'inProgress', contentItems: null }
    const harness = await launch({
      config: {
        turns: [
          [
            itemStarted(mcp),
            note('item/mcpToolCall/progress', { itemId: 'mcp-1', message: ' working ' }),
            itemCompleted({ ...mcp, status: 'completed', result: { content: [{ type: 'text', text: 'found' }] } }),
            itemStarted(web),
            itemCompleted(web),
            itemStarted(dynamic),
            itemCompleted({ ...dynamic, status: 'completed', contentItems: [{ type: 'inputText', text: 'ok' }] }),
            itemStarted({ type: 'imageView', id: 'iv-1', path: '/w/a.png' }),
            itemCompleted({ type: 'imageView', id: 'iv-1', path: '/w/a.png' }),
            itemStarted({ type: 'contextCompaction', id: 'cc-1' }),
            itemCompleted({ type: 'contextCompaction', id: 'cc-1' }),
          ],
        ],
      },
    })
    await harness.prompt('tools')
    const updates = harness.updates().filter((update) => update.sessionUpdate.startsWith('tool_call'))
    expect(updates).toEqual([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'mcp-1',
        kind: 'execute',
        title: 'mcp.docs.search',
        status: 'in_progress',
        rawInput: { server: 'docs', tool: 'search', arguments: { q: 'x' } },
        _meta: { is_mcp_tool_call: true },
      },
      { sessionUpdate: 'tool_call_update', toolCallId: 'mcp-1', _meta: { mcp_output_delta: { data: 'working' } } },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'mcp-1',
        status: 'completed',
        rawInput: { server: 'docs', tool: 'search', arguments: { q: 'x' } },
        rawOutput: { result: { content: [{ type: 'text', text: 'found' }] }, error: null },
      },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'ws-1',
        kind: 'search',
        title: 'Web search: cats',
        status: 'in_progress',
        rawInput: { type: 'webSearch', id: 'ws-1', query: 'cats', action: { type: 'search', query: 'cats', queries: null } },
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'ws-1',
        title: 'Web search: cats',
        status: 'completed',
        rawInput: { type: 'webSearch', id: 'ws-1', query: 'cats', action: { type: 'search', query: 'cats', queries: null } },
      },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'dyn-1',
        name: 'ns.lookup',
        kind: 'execute',
        title: 'lookup',
        status: 'in_progress',
        rawInput: { arguments: { a: 1 } },
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'dyn-1',
        name: 'ns.lookup',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
      },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'iv-1',
        name: 'view_image',
        kind: 'read',
        title: 'View Image /w/a.png',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'resource_link', name: '/w/a.png', uri: '/w/a.png' } }],
        locations: [{ path: '/w/a.png' }],
        rawInput: { path: '/w/a.png' },
      },
      { sessionUpdate: 'tool_call', toolCallId: 'cc-1', title: 'Compact conversation', kind: 'think', status: 'in_progress' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'cc-1', title: 'Compact conversation', status: 'completed' },
    ])
  })

  it('reports the plan as ACP plan updates and a plan item as a message', async () => {
    const harness = await launch({
      config: {
        turns: [
          [
            note('turn/plan/updated', {
              plan: [
                { step: 'Read files', status: 'inProgress' },
                { step: 'Edit files', status: 'pending' },
                { step: 'Run tests', status: 'completed' },
              ],
              explanation: null,
            }),
            note('item/plan/delta', { itemId: 'plan-1', delta: '# Pl' }),
            itemCompleted({ type: 'plan', id: 'plan-1', text: '# Plan' }),
          ],
        ],
      },
    })
    await harness.prompt('plan it')
    expect(harness.updates('plan')).toEqual([
      {
        sessionUpdate: 'plan',
        entries: [
          { status: 'in_progress', content: 'Read files', priority: 'medium' },
          { status: 'pending', content: 'Edit files', priority: 'medium' },
          { status: 'completed', content: 'Run tests', priority: 'medium' },
        ],
      },
    ])
    expect(harness.updates('agent_message_chunk')).toEqual([
      { sessionUpdate: 'agent_message_chunk', messageId: 'plan-1', content: { type: 'text', text: '# Plan' } },
    ])
  })

  it('streams reasoning and message deltas with message ids and survives frames cut mid-character', async () => {
    const harness = await launch({
      config: {
        turns: [
          [
            itemStarted({ type: 'reasoning', id: 'rs-1', summary: [], content: [] }),
            note('item/reasoning/summaryTextDelta', { itemId: 'rs-1', delta: 'thinking' }),
            note('item/reasoning/summaryPartAdded', { itemId: 'rs-1', summaryIndex: 1 }),
            itemCompleted({ type: 'reasoning', id: 'rs-1', summary: ['thinking'], content: [] }),
            itemCompleted({ type: 'reasoning', id: 'rs-2', summary: ['first', '', 'second'], content: ['ignored'] }),
            { ...note('item/agentMessage/delta', { itemId: 'msg-1', delta: '€€€' }), chunk: true },
            itemCompleted({ type: 'agentMessage', id: 'msg-1', text: '€€€', phase: 'final_answer' }),
            itemCompleted({ type: 'agentMessage', id: 'msg-2', text: 'never streamed', phase: null }),
          ],
        ],
      },
    })
    await harness.prompt('think')
    expect(harness.updates('agent_thought_chunk')).toEqual([
      { sessionUpdate: 'agent_thought_chunk', messageId: 'rs-1', content: { type: 'text', text: 'thinking' } },
      { sessionUpdate: 'agent_thought_chunk', messageId: 'rs-1', content: { type: 'text', text: '\n\n' } },
      { sessionUpdate: 'agent_thought_chunk', messageId: 'rs-2', content: { type: 'text', text: 'first\n\nsecond' } },
    ])
    expect(harness.updates('agent_message_chunk')).toEqual([
      { sessionUpdate: 'agent_message_chunk', messageId: 'msg-1', content: { type: 'text', text: '€€€' } },
      { sessionUpdate: 'agent_message_chunk', messageId: 'msg-2', content: { type: 'text', text: 'never streamed' } },
    ])
  })

  it('shows warnings, config warnings and reroutes as text like codex-acp', async () => {
    const harness = await launch({
      config: {
        turns: [
          [
            note('warning', { message: 'careful' }),
            note('configWarning', { summary: 'Bad key', details: 'in config.toml' }),
            note('model/rerouted', { fromModel: 'a', toModel: 'b', reason: 'capacity' }),
            note('thread/compacted', {}),
          ],
        ],
      },
    })
    await harness.prompt('x')
    const texts = (kind: string): string[] =>
      harness
        .updates(kind)
        .map(chunkText)
    expect(texts('agent_message_chunk')).toEqual([
      'Warning: careful\n\n',
      'Config warning: Bad key\n\nin config.toml\n\n',
      "*Context compacted to fit the model's context window.*\n\n",
    ])
    expect(texts('agent_thought_chunk')).toEqual(['Model rerouted from a to b (capacity).\n\n'])
  })

  it('reports usage as the sum over the turn and context occupancy per request', async () => {
    const harness = await launch({
      config: {
        turns: [
          [
            ...messageSteps('msg-1', 'a'),
            usageStep(
              { totalTokens: 1050, inputTokens: 1000, cachedInputTokens: 0, cacheWriteInputTokens: 900, outputTokens: 50, reasoningOutputTokens: 20 },
              { totalTokens: 1050, inputTokens: 1000, cachedInputTokens: 0, cacheWriteInputTokens: 900, outputTokens: 50, reasoningOutputTokens: 20 },
            ),
            usageStep(
              { totalTokens: 1230, inputTokens: 1200, cachedInputTokens: 900, cacheWriteInputTokens: 100, outputTokens: 30, reasoningOutputTokens: 0 },
              { totalTokens: 2280, inputTokens: 2200, cachedInputTokens: 900, cacheWriteInputTokens: 1000, outputTokens: 80, reasoningOutputTokens: 20 },
            ),
          ],
          [
            ...messageSteps('msg-2', 'b'),
            usageStep(
              { totalTokens: 1300, inputTokens: 1290, cachedInputTokens: 1200, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 5 },
              { totalTokens: 3580, inputTokens: 3490, cachedInputTokens: 2100, cacheWriteInputTokens: 1000, outputTokens: 90, reasoningOutputTokens: 25 },
            ),
          ],
        ],
      },
    })
    const first = await harness.prompt('one')
    expect(first.usage).toEqual({ inputTokens: 300, outputTokens: 80, cachedReadTokens: 900, cachedWriteTokens: 1000, thoughtTokens: 20 })
    expect(harness.transport.contextUsage()).toEqual({ used: 1230, size: 200_000 })
    const second = await harness.prompt('two')
    // The second prompt owns only its own request.
    expect(second.usage).toEqual({ inputTokens: 90, outputTokens: 10, cachedReadTokens: 1200, cachedWriteTokens: 0, thoughtTokens: 5 })
    expect(harness.events.filter((event) => event.kind === 'context_usage')).toEqual([
      { kind: 'context_usage', contextUsage: { used: 1050, size: 200_000 } },
      { kind: 'context_usage', contextUsage: { used: 1230, size: 200_000 } },
      { kind: 'context_usage', contextUsage: { used: 1300, size: 200_000 } },
    ])
  })

  it('reports no usage when Codex reported none, and picks up the usage replay of a resumed thread', async () => {
    const quiet = await launch()
    expect((await quiet.prompt('hi')).usage).toBeUndefined()

    const total = { totalTokens: 5000, inputTokens: 4000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1000, reasoningOutputTokens: 0 }
    const resumed = await launch({
      session: { kind: 'resume', sessionId: 'thr_old' },
      config: {
        resumeUsage: { last: total, total, modelContextWindow: 100_000 },
        turns: [
          [
            ...messageSteps('msg-1', 'a'),
            usageStep(
              { totalTokens: 120, inputTokens: 100, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 0 },
              { totalTokens: 5120, inputTokens: 4100, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1020, reasoningOutputTokens: 0 },
              100_000,
            ),
          ],
        ],
      },
    })
    // The replay made the context occupancy known before any prompt.
    expect(resumed.transport.contextUsage()).toEqual({ used: 5000, size: 100_000 })
    const result = await resumed.prompt('hi')
    expect(result.usage).toMatchObject({ inputTokens: 100, outputTokens: 20 })
  })

  it('shows a failed turn as text and ends it, and fails the prompt on auth and usage-limit errors', async () => {
    const failed = await launch({
      config: {
        turns: [
          [
            note('error', {
              error: {
                message: '{"type":"error","status":503,"error":{"type":"overloaded_error","message":"Try later"}}',
                codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } },
                additionalDetails: null,
              },
              willRetry: false,
            }),
            { end: 'failed', error: { message: 'Try later', codexErrorInfo: null, additionalDetails: null } },
          ],
          [{ end: 'failed', error: { message: 'bare failure', codexErrorInfo: null, additionalDetails: null } }],
        ],
      },
    })
    expect((await failed.prompt('x')).stopReason).toBe('end_turn')
    expect(failed.updates('agent_message_chunk')).toEqual([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Try later\n\n' } },
    ])
    // A failure whose error never reached the transcript still tells the user why.
    await failed.prompt('y')
    expect(failed.updates('agent_message_chunk').at(-1)).toEqual({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'bare failure\n\n' },
    })

    const auth = await launch({
      config: {
        turns: [
          [
            note('error', { error: { message: 'no key', codexErrorInfo: 'unauthorized', additionalDetails: null }, willRetry: false }),
            { end: 'failed', error: { message: 'no key', codexErrorInfo: 'unauthorized', additionalDetails: null } },
          ],
        ],
      },
    })
    await expect(auth.prompt('x')).rejects.toMatchObject({ code: 'auth-required' })

    const limited = await launch({
      config: {
        turns: [
          [
            note('error', { error: { message: 'limit hit', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null }, willRetry: false }),
            { end: 'failed', error: { message: 'limit hit', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null } },
          ],
        ],
      },
    })
    await expect(limited.prompt('x')).rejects.toMatchObject({ code: 'usage-limit' })
  })

  it('keeps retry notices out of the transcript', async () => {
    const harness = await launch({
      config: {
        turns: [
          [
            note('error', {
              error: { message: 'Reconnecting... 1/5', codexErrorInfo: null, additionalDetails: 'gone' },
              willRetry: true,
            }),
          ],
        ],
      },
    })
    await harness.prompt('x')
    expect(harness.updates('agent_message_chunk')).toEqual([])
    expect(harness.events).toContainEqual({ kind: 'notice', text: 'Codex error (will retry): Reconnecting... 1/5 — gone' })
  })

  it('ignores notifications of other threads', async () => {
    const harness = await launch({
      config: {
        turns: [
          [
            { n: 'item/agentMessage/delta', p: { threadId: 'thr_child', turnId: 'x', itemId: 'm', delta: 'child text' } },
            { n: 'turn/completed', p: { threadId: 'thr_child', turn: { id: 'x', status: 'completed', items: [], error: null } } },
            ...messageSteps('msg-1', 'mine'),
          ],
        ],
      },
    })
    expect((await harness.prompt('x')).stopReason).toBe('end_turn')
    expect(harness.updates('agent_message_chunk')).toEqual([
      { sessionUpdate: 'agent_message_chunk', messageId: 'msg-1', content: { type: 'text', text: 'mine' } },
    ])
  })
})

describe('codex approvals through the transport', () => {
  it('answers every reverse request class on the wire, asking the host in ACP shape', async () => {
    const harness = await launch({
      decide: (request) => {
        const wanted = request.options.find((option) => option.optionId === 'allow_for_session' || option.optionId === 'allow_permissions_session')
        return { optionId: wanted?.optionId ?? request.options[0]?.optionId ?? 'x' }
      },
      config: {
        turns: [
          [
            itemStarted(commandItem('exec-1')),
            { r: 'item/commandExecution/requestApproval', p: { threadId: '$thread', turnId: '$turn', itemId: 'exec-1', command: "/bin/zsh -lc 'rm x'", cwd: '$cwd', commandActions: [{ type: 'unknown', command: 'rm x' }] } },
            { r: 'item/fileChange/requestApproval', p: { threadId: '$thread', turnId: '$turn', itemId: 'patch-9' } },
            { r: 'item/permissions/requestApproval', p: { threadId: '$thread', turnId: '$turn', itemId: 'perm-1', cwd: '$cwd', permissions: { network: { enabled: true } } } },
            { r: 'item/tool/requestUserInput', p: { threadId: '$thread', turnId: '$turn', itemId: 'q-1', questions: [{ id: 'a', question: 'Pick?', options: [{ label: 'one' }] }] } },
            { r: 'mcpServer/elicitation/request', p: { threadId: '$thread', turnId: '$turn', serverName: 'docs', mode: 'form', message: 'Ok?', requestedSchema: null } },
            { r: 'item/tool/call', p: { threadId: '$thread', turnId: '$turn', callId: 'c', tool: 't', arguments: {} } },
            { r: 'account/chatgptAuthTokens/refresh', p: { reason: 'unauthorized' } },
            { r: 'attestation/generate', p: {} },
            { r: 'currentTime/read', p: {} },
            { r: 'applyPatchApproval', p: { conversationId: '$thread', callId: 'c1', fileChanges: {} } },
            { r: 'execCommandApproval', p: { conversationId: '$thread', callId: 'c2', command: ['ls'], cwd: '$cwd' } },
            { r: 'brand/newRequest', p: {} },
            ...messageSteps('msg-1', 'done'),
          ],
        ],
      },
    })
    expect((await harness.prompt('go')).stopReason).toBe('end_turn')
    const frames = harness.frames()
    const answer = (id: number): Frame | undefined => replyTo(frames, id)
    expect(answer(9001)?.['result']).toEqual({ decision: 'acceptForSession' })
    expect(answer(9002)?.['result']).toEqual({ decision: 'acceptForSession' })
    expect(answer(9003)?.['result']).toEqual({
      permissions: { network: { enabled: true } },
      scope: 'session',
      strictAutoReview: false,
    })
    expect(answer(9004)?.['result']).toEqual({ answers: { a: { answers: ['one'] } } })
    expect(answer(9005)?.['result']).toEqual({ action: 'accept', content: null, _meta: null })
    expect(answer(9006)?.['result']).toMatchObject({ success: false })
    expect(answer(9007)?.['error']).toMatchObject({ code: -32601 })
    expect(answer(9008)?.['error']).toMatchObject({ code: -32601 })
    expect(typeof objectOf(answer(9009)?.['result'])['currentTimeAt']).toBe('number')
    expect(answer(9010)?.['result']).toEqual({ decision: 'approved_for_session' })
    expect(answer(9011)?.['result']).toEqual({ decision: 'approved_for_session' })
    expect(answer(9012)?.['error']).toMatchObject({ code: -32601 })
    // Only the human-decision classes reached the host.
    expect(harness.permissions.map((request) => request.toolCall.toolCallId)).toEqual([
      'exec-1',
      'patch-9',
      'perm-1',
      'q-1',
      'elicitation:thr_test:docs:1',
      'c1',
      'c2',
    ])
  })

  it('releases a pending approval with a cancel answer when the turn is aborted', async () => {
    let release: (decision: NativePermissionDecision) => void = () => undefined
    const harness = await launch({
      decide: () =>
        new Promise<NativePermissionDecision>((resolve) => {
          release = resolve
        }),
      config: {
        turns: [
          [
            { r: 'item/commandExecution/requestApproval', p: { threadId: '$thread', turnId: '$turn', itemId: 'exec-1', command: 'rm x', cwd: '$cwd', commandActions: [] } },
            { wait: 'interrupt' },
          ],
        ],
      },
    })
    const controller = new AbortController()
    const running = harness.prompt('go', controller.signal)
    await waitFor(() => harness.permissions.length === 1)
    controller.abort()
    await expect(running).resolves.toMatchObject({ stopReason: 'cancelled' })
    expect(replyTo(harness.frames(), 9001)?.['result']).toEqual({ decision: 'cancel' })
    release({ optionId: 'allow_once' })
  })

  it('never hangs the server when the host handler throws', async () => {
    const harness = await launch({
      decide: () => {
        throw new Error('ui exploded')
      },
      config: {
        turns: [
          [
            { r: 'item/commandExecution/requestApproval', p: { threadId: '$thread', turnId: '$turn', itemId: 'exec-1', command: 'rm x', cwd: '$cwd', commandActions: [] } },
            ...messageSteps('msg-1', 'after'),
          ],
        ],
      },
    })
    expect((await harness.prompt('go')).stopReason).toBe('end_turn')
    expect(replyTo(harness.frames(), 9001)?.['result']).toEqual({ decision: 'cancel' })
  })

  it('asks to implement a plan made in plan mode and runs the implementation turn when approved', async () => {
    const harness = await launch({
      decide: (request) => ({ optionId: request.options[0]?.optionId ?? 'x' }),
      config: {
        thread: { collaborationMode: 'plan' },
        turns: [
          [itemCompleted({ type: 'plan', id: 'plan-1', text: '1. do it' })],
          [...messageSteps('msg-2', 'implemented')],
        ],
      },
      session: { kind: 'resume', sessionId: 'thr_plan' },
    })
    const result = await harness.prompt('plan something')
    expect(result.stopReason).toBe('end_turn')
    expect(harness.permissions).toHaveLength(1)
    expect(harness.permissions[0]).toEqual({
      toolCall: {
        toolCallId: 'plan-review:plan-1',
        title: 'Implement this plan?',
        kind: 'switch_mode',
        status: 'pending',
        rawInput: { plan: '1. do it' },
      },
      options: [
        { optionId: 'implement_plan', name: 'Yes, implement this plan', kind: 'allow_once' },
        { optionId: 'revise_plan', name: 'No, and tell Codex what to do differently', kind: 'reject_once' },
      ],
    })
    // The implementation runs in default mode with the same prompt contract.
    expect(harness.sent('turn/start')).toHaveLength(2)
    expect(paramsOf(harness.sent('turn/start')[1])['input']).toEqual([{ type: 'text', text: 'Implement the approved plan.', text_elements: [] }])
    expect(paramsOf(harness.sent('thread/settings/update').at(-1))).toMatchObject({ collaborationMode: { mode: 'default' } })
    expect(harness.events.some((event) => event.kind === 'controls')).toBe(true)
    expect(harness.transport.controls().configOptions.find((option) => option.id === 'collaboration_mode')).toMatchObject({
      currentValue: 'default',
    })
    expect(harness.updates('agent_message_chunk').map(chunkText)).toEqual([
      '1. do it',
      'implemented',
    ])
  })

  it('stays in plan mode when the plan is not approved', async () => {
    const harness = await launch({
      decide: () => ({ optionId: 'revise_plan' }),
      config: { thread: { collaborationMode: 'plan' }, turns: [[itemCompleted({ type: 'plan', id: 'plan-1', text: 'p' })]] },
      session: { kind: 'resume', sessionId: 'thr_plan' },
    })
    await harness.prompt('plan')
    expect(harness.sent('turn/start')).toHaveLength(1)
    expect(harness.transport.controls().configOptions.find((option) => option.id === 'collaboration_mode')).toMatchObject({
      currentValue: 'plan',
    })
  })
})

describe('codex steering, interruption and turn identification', () => {
  const runningTool = (extra: Step[] = []): Step[] => [itemStarted(commandItem('exec-1')), ...extra]

  it('steers the running turn with the expected turn id', async () => {
    const harness = await launch({
      config: { turns: [[...runningTool(), { wait: 'steer' }, note('item/agentMessage/delta', { itemId: 'm', delta: 'steered' })]] },
    })
    expect(await harness.transport.steer(say('too early'))).toBe('promptRequired')
    expect(harness.sent('turn/steer')).toHaveLength(0)
    const running = harness.prompt('start')
    await waitFor(() => harness.updates('tool_call').length === 1)
    expect(await harness.transport.steer(say('steer!'))).toBe('injected')
    await running
    const steer = harness.sent('turn/steer')[0]
    expect(steer?.params).toMatchObject({
      threadId: 'thr_test',
      expectedTurnId: 'turn_1',
      input: [{ type: 'text', text: 'steer!', text_elements: [] }],
    })
    expect(String(paramsOf(steer)['clientUserMessageId'])).toMatch(/^dsh-steer-/)
    // The turn is over: a late steer is definitively not accepted.
    expect(await harness.transport.steer(say('late'))).toBe('promptRequired')
  })

  it('identifies the turn from turn/started when the response is slow, and steers it', async () => {
    const harness = await launch({
      config: { turns: [{ steps: [...runningTool(), { wait: 'steer' }], responseDelayMs: 150 }] },
    })
    const running = harness.prompt('start')
    await waitFor(() => harness.updates('tool_call').length === 1)
    expect(await harness.transport.steer(say('now'))).toBe('injected')
    await running
    expect(paramsOf(harness.sent('turn/steer')[0])['expectedTurnId']).toBe('turn_1')
  })

  it('waits for a turn id that is still being announced before steering', async () => {
    const harness = await launch({
      config: { turns: [{ steps: [{ wait: 'steer' }], responseDelayMs: 200, startedBeforeResponse: false, startedDelayMs: 200 }] },
    })
    const running = harness.prompt('start')
    await waitFor(() => harness.sent('turn/start').length === 1)
    expect(await harness.transport.steer(say('early'))).toBe('injected')
    await running
  })

  it('falls back to a new prompt on definitive rejections and rethrows ambiguous ones', async () => {
    const definitive = await launch({
      config: {
        steerErrors: [{ code: -32600, message: 'no active turn to steer' }],
        turns: [[...runningTool(), { wait: 'interrupt' }]],
      },
    })
    const controller = new AbortController()
    const running = definitive.prompt('start', controller.signal)
    await waitFor(() => definitive.updates('tool_call').length === 1)
    expect(await definitive.transport.steer(say('x'))).toBe('promptRequired')
    controller.abort()
    await running

    const ambiguous = await launch({
      config: { steerErrors: [{ code: -32000, message: 'internal error' }], turns: [[...runningTool(), { wait: 'interrupt' }]] },
    })
    const second = new AbortController()
    const secondRun = ambiguous.prompt('start', second.signal)
    await waitFor(() => ambiguous.updates('tool_call').length === 1)
    await expect(ambiguous.transport.steer(say('x'))).rejects.toBeInstanceOf(CodexRpcError)
    second.abort()
    await secondRun
  })

  it('refuses to inject an image into a turn on a text-only model', async () => {
    const harness = await launch({ config: { thread: { model: 'glm-5.3', reasoningEffort: 'high' }, turns: [[...runningTool(), { wait: 'interrupt' }]] } })
    const controller = new AbortController()
    const running = harness.prompt('start', controller.signal)
    await waitFor(() => harness.updates('tool_call').length === 1)
    expect(await harness.transport.steer([{ type: 'image', data: 'QUJD', mimeType: 'image/png' }])).toBe('promptRequired')
    controller.abort()
    await running
  })

  it('interrupts the turn on abort and resolves cancelled once Codex confirmed it', async () => {
    const harness = await launch({ config: { turns: [[...runningTool(), { wait: 'interrupt' }]] } })
    const controller = new AbortController()
    const running = harness.prompt('start', controller.signal)
    await waitFor(() => harness.updates('tool_call').length === 1)
    controller.abort()
    await expect(running).resolves.toMatchObject({ stopReason: 'cancelled' })
    expect(harness.sent('turn/interrupt')[0]?.params).toEqual({ threadId: 'thr_test', turnId: 'turn_1' })
    // Idle again: the next prompt runs normally.
    expect((await harness.prompt('next')).stopReason).toBe('end_turn')
  })

  it('retries an interrupt that raced the turn becoming interruptible', async () => {
    const harness = await launch({ config: { interruptFailures: 2, turns: [[...runningTool(), { wait: 'interrupt' }]] } })
    const controller = new AbortController()
    const running = harness.prompt('start', controller.signal)
    await waitFor(() => harness.updates('tool_call').length === 1)
    controller.abort()
    await expect(running).resolves.toMatchObject({ stopReason: 'cancelled' })
    expect(harness.sent('turn/interrupt')).toHaveLength(3)
  })

  it('interrupts a turn whose id was not known yet when the abort came', async () => {
    const harness = await launch({
      config: { turns: [{ steps: [{ wait: 'interrupt' }], responseDelayMs: 200, startedDelayMs: 200 }] },
    })
    const controller = new AbortController()
    const running = harness.prompt('start', controller.signal)
    await waitFor(() => harness.sent('turn/start').length === 1)
    controller.abort()
    await expect(running).resolves.toMatchObject({ stopReason: 'cancelled' })
    expect(harness.sent('turn/interrupt')[0]?.params).toEqual({ threadId: 'thr_test', turnId: 'turn_1' })
  })

  it('does not lose a turn that starts and completes before the turn/start response', async () => {
    const harness = await launch({
      config: { turns: [{ steps: messageSteps('msg-1', 'fast'), startedBeforeResponse: true, responseDelayMs: 100 }] },
    })
    const result = await harness.prompt('go')
    expect(result.stopReason).toBe('end_turn')
    expect(harness.updates('agent_message_chunk')).toHaveLength(1)
  })

  it('returns cancelled without touching the wire when the signal is already aborted', async () => {
    const harness = await launch()
    const controller = new AbortController()
    controller.abort()
    expect(await harness.prompt('x', controller.signal)).toEqual({ stopReason: 'cancelled' })
    expect(harness.sent('turn/start')).toHaveLength(0)
  })

  it('classifies steer rejections', () => {
    expect(isDefinitiveSteerRejection(new CodexRpcError('method not found', -32601))).toBe(true)
    expect(isDefinitiveSteerRejection(new CodexRpcError('no active turn to steer', -32600))).toBe(true)
    expect(isDefinitiveSteerRejection(new CodexRpcError('expected active turn id `a` but found `b`', -32600))).toBe(true)
    expect(isDefinitiveSteerRejection(new CodexRpcError('x', -32600, { codexErrorInfo: { activeTurnNotSteerable: {} } }))).toBe(true)
    expect(isDefinitiveSteerRejection(new CodexRpcError('active turn uses a different output schema', -32600))).toBe(true)
    expect(isDefinitiveSteerRejection(new CodexRpcError('invalid request', -32600))).toBe(false)
    expect(isDefinitiveSteerRejection(new CodexRpcError('internal error', -32000))).toBe(false)
    expect(isDefinitiveSteerRejection(new Error('request timed out'))).toBe(false)
  })
})

describe('codex commands and lifecycle', () => {
  it('toggles plan mode with /plan without starting a turn', async () => {
    const harness = await launch()
    expect((await harness.prompt('/plan')).stopReason).toBe('end_turn')
    expect(harness.sent('turn/start')).toHaveLength(0)
    expect(paramsOf(harness.sent('thread/settings/update').at(-1))).toMatchObject({ collaborationMode: { mode: 'plan' } })
    expect(harness.events.at(-1)).toMatchObject({ kind: 'controls' })
    await harness.prompt('/plan')
    expect(paramsOf(harness.sent('thread/settings/update').at(-1))).toMatchObject({ collaborationMode: { mode: 'default' } })
    await harness.prompt('/plan extra')
    expect(harness.updates('agent_message_chunk').at(-1)).toMatchObject({ content: { text: 'Command "/plan" requires no arguments.' } })
  })

  it('runs /compact as a turn of its own and reports its progress like a tool call', async () => {
    const harness = await launch({
      config: {
        compact: [
          itemStarted({ type: 'contextCompaction', id: 'cc-1' }),
          itemCompleted({ type: 'contextCompaction', id: 'cc-1' }),
          note('thread/compacted', {}),
        ],
      },
    })
    const result = await harness.prompt('/compact')
    expect(result.stopReason).toBe('end_turn')
    expect(harness.sent('thread/compact/start')[0]?.params).toEqual({ threadId: 'thr_test' })
    expect(harness.sent('turn/start')).toHaveLength(0)
    expect(harness.updates('tool_call').map(titleOf)).toEqual(['Compact conversation'])
  })

  it('starts reviews with the codex-acp targets and renames the thread', async () => {
    const harness = await launch({ config: { review: messageSteps('msg-1', 'review done') } })
    await harness.prompt('/review')
    await harness.prompt('/review check the diff')
    await harness.prompt('/review-branch main')
    await harness.prompt('/review-commit abc123')
    expect(harness.sent('review/start').map((frame) => paramsOf(frame))).toEqual([
      { threadId: 'thr_test', target: { type: 'uncommittedChanges' }, delivery: 'inline' },
      { threadId: 'thr_test', target: { type: 'custom', instructions: 'check the diff' }, delivery: 'inline' },
      { threadId: 'thr_test', target: { type: 'baseBranch', branch: 'main' }, delivery: 'inline' },
      { threadId: 'thr_test', target: { type: 'commit', sha: 'abc123', title: null }, delivery: 'inline' },
    ])
    await harness.prompt('/rename Better name')
    expect(harness.sent('thread/name/set')[0]?.params).toEqual({ threadId: 'thr_test', name: 'Better name' })
    await harness.prompt('/review-branch')
    expect(harness.updates('agent_message_chunk').at(-1)).toMatchObject({ content: { text: 'Command "/review-branch" requires branch name.' } })
  })

  it('answers /status and /skills locally and forwards unknown slash text to the model', async () => {
    const harness = await launch({ config: { skills: [{ name: 'deploy', description: 'Deploy', shortDescription: 'Deploy it' }] } })
    await harness.prompt('/status')
    const status = harness.updates('agent_message_chunk').at(-1)
    const text = status === undefined ? '' : chunkText(status)
    expect(text).toContain('**Model:** gpt-6-astra[max]')
    expect(text).toContain('**Approval:** on-request')
    expect(text).toContain('**Sandbox:** workspace-write')
    expect(text).toContain('**Session:** `thr_test`')
    expect(text).toContain('**Token usage:** data not available yet')
    await harness.prompt('/skills')
    expect(harness.updates('agent_message_chunk').at(-1)).toMatchObject({
      content: { text: 'Available skills:\n- deploy: Deploy it' },
    })
    expect(harness.sent('turn/start')).toHaveLength(0)
    await harness.prompt('/unknown thing')
    expect(paramsOf(harness.sent('turn/start')[0])['input']).toEqual([{ type: 'text', text: '/unknown thing', text_elements: [] }])
  })

  it('starts once, closes gracefully and idempotently, and then reports itself closed', async () => {
    const harness = await launch()
    expect(isClosed(harness.transport)).toBe(false)
    const options = { argv: [], env: {}, cwd: harness.dir, spawn: () => { throw new Error('must not spawn again') }, session: { kind: 'new' } as const, onEvent: () => undefined, onPermission: async () => ({ cancelled: true as const }) }
    await harness.transport.start(options)
    expect(harness.spawns).toHaveLength(1)
    await harness.transport.close()
    await harness.transport.close()
    expect(isClosed(harness.transport)).toBe(true)
    await expect(harness.prompt('x')).rejects.toBeInstanceOf(NativeTransportError)
    expect(await harness.transport.steer(say('x'))).toBe('promptRequired')
  })

  it('terminates an app-server that ignores the end of its stdin', async () => {
    const harness = await launch({ config: { ignoreStdinEnd: true } })
    const started = Date.now()
    await harness.transport.close()
    expect(Date.now() - started).toBeLessThan(8_000)
    expect(harness.logs.some((line) => line.includes('terminating'))).toBe(true)
  }, 15_000)

  it('rejects the prompt with the process facts and fails open tool calls when the app-server dies mid-turn', async () => {
    const harness = await launch({
      config: { turns: [[itemStarted(commandItem('exec-1')), { exit: 3, stderr: 'segfault detail' }]] },
    })
    const error = await harness.prompt('go').catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(NativeTransportError)
    expect(nativeError(error).code).toBe('process-exit')
    expect(nativeError(error).detail).toContain('segfault detail')
    expect(harness.updates('tool_call_update').at(-1)).toEqual({ sessionUpdate: 'tool_call_update', toolCallId: 'exec-1', status: 'failed' })
    expect(isClosed(harness.transport)).toBe(true)
    await expect(harness.prompt('again')).rejects.toBeInstanceOf(NativeTransportError)
  })
})

// ---------------------------------------------------------------------------
// 5. Live checks through the profile's TokenRouter launcher (opt-in: DSH_CODEX_LIVE=1)
// ---------------------------------------------------------------------------

interface LiveProfile {
  readonly env: Record<string, string>
  readonly launcher: string
}

/** The `codex` agent environment of the user's DSH profile; never logged. */
function loadLiveProfile(): LiveProfile | undefined {
  if (process.env['DSH_CODEX_LIVE'] !== '1') return undefined
  const path = process.env['DSH_CODEX_PROFILE'] ?? join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
  if (!existsSync(path)) return undefined
  const stack: unknown[] = [parseYaml(readFileSync(path, 'utf8'))]
  while (stack.length > 0) {
    const node = stack.pop()
    if (Array.isArray(node)) {
      // The profile patch is a list of patch documents; walk into each.
      stack.push(...(node as unknown[]))
      continue
    }
    if (!isRecord(node)) continue
    const agents = node['agents']
    const codex = isRecord(agents) ? agents['codex'] : undefined
    const env = isRecord(codex) ? codex['env'] : undefined
    if (isRecord(env) && typeof env['CODEX_PATH'] === 'string') {
      const entries = Object.entries(env).flatMap(([key, value]) =>
        typeof value === 'string' || typeof value === 'number' ? [[key, String(value)] as const] : [],
      )
      return { env: Object.fromEntries(entries), launcher: env['CODEX_PATH'] }
    }
    stack.push(...Object.values(node))
  }
  return undefined
}

const live = loadLiveProfile()

function requireLive(): LiveProfile {
  if (live === undefined) throw new Error('the live Codex profile is not available')
  return live
}

interface LiveRun {
  readonly transport: NativeTransport
  readonly events: NativeTransportEvent[]
  readonly logs: string[]
  readonly dir: string
  updates(): acp.SessionUpdate[]
  text(): string
}

async function liveLaunch(
  session: NativeSessionTarget,
  options: { readonly cwd?: string; readonly env?: Record<string, string> } = {},
): Promise<LiveRun> {
  const profile = requireLive()
  const dir = options.cwd ?? (await tempDir('dsh-codex-live-'))
  const events: NativeTransportEvent[] = []
  const logs: string[] = []
  const transport = createCodexTransport()
  openTransports.push(transport)
  await transport.start({
    argv: [profile.launcher],
    env: { ...profile.env, ...options.env },
    cwd: dir,
    spawn: nativeSpawnFromSeam((await sharedTestSubprocess()).seam),
    session,
    onEvent: (event) => events.push(event),
    onPermission: async (request) => defaultDecision(request),
    log: (message) => logs.push(message),
  })
  const updates = (): acp.SessionUpdate[] =>
    events
      .filter((event): event is Extract<NativeTransportEvent, { kind: 'update' }> => event.kind === 'update')
      .map((event) => event.update)
  return {
    transport,
    events,
    logs,
    dir,
    updates,
    text: () =>
      updates()
        .map((update) => (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? update.content.text : ''))
        .join(''),
  }
}

/** A cheap model and a low effort the live catalogue offers, chosen at run time. */
function cheapChoice(transport: NativeTransport): { readonly model: string; readonly effort: string } {
  const controls = transport.controls()
  const modelOption = controls.configOptions.find((option) => option.id === 'model')
  const values = selectValues(modelOption)
  const current = modelOption?.type === 'select' ? modelOption.currentValue : undefined
  const model = values.find((value) => /luna|mini|flash/i.test(value)) ?? values.find((value) => value !== current) ?? values[0]
  if (model === undefined) throw new Error('the live catalogue lists no model')
  return { model, effort: 'low' }
}

/** The Codex rollout file of a thread under the profile's Codex home. */
function findRollout(sessionId: string): string | undefined {
  const root = join(homedir(), '.codex', 'sessions')
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined || !existsSync(current)) continue
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (entry.name.endsWith(`-${sessionId}.jsonl`)) return path
    }
  }
  return undefined
}

describe.skipIf(live === undefined)('codex live (TokenRouter launcher)', () => {
  it('starts a thread through the launcher and runs a shell turn with ACP-shaped output and usage', async () => {
    const run = await liveLaunch({ kind: 'new' })
    expect(typeof run.transport.sessionId).toBe('string')
    expect(run.transport.agentInfo.version).toMatch(/^\d+\.\d+\.\d+/)
    // The launcher's TokenRouter provider is in effect, not the default OpenAI one.
    expect(run.logs.some((line) => line.includes(`provider ${requireLive().env['MODEL_PROVIDER'] ?? 'default'}`))).toBe(true)
    const choice = cheapChoice(run.transport)
    await run.transport.setConfigOption('model', choice.model)
    await run.transport.setConfigOption('reasoning_effort', choice.effort)
    const result = await run.transport.prompt(
      say('Run the shell command `echo live-probe-ok` and then reply with exactly: DONE'),
      new AbortController().signal,
    )
    expect(result.stopReason).toBe('end_turn')
    expect(run.text().toUpperCase()).toContain('DONE')
    const tools = run.updates().filter((update) => update.sessionUpdate === 'tool_call')
    const shell = tools.find((update) => update.sessionUpdate === 'tool_call' && update.kind === 'execute')
    expect(shell).toMatchObject({
      kind: 'execute',
      status: 'in_progress',
      content: [{ type: 'terminal' }],
      _meta: { terminal_info: { cwd: run.dir } },
    })
    expect(JSON.stringify(shell?.sessionUpdate === 'tool_call' ? shell.rawInput : null)).toContain('echo live-probe-ok')
    const exits = run.updates().flatMap((update) => (update.sessionUpdate === 'tool_call_update' ? [update._meta?.['terminal_exit']] : []))
    expect(exits.some((exit) => isRecord(exit) && exit['exit_code'] === 0)).toBe(true)
    expect(result.usage?.outputTokens ?? 0).toBeGreaterThan(0)
    expect((result.usage?.inputTokens ?? 0) + (result.usage?.cachedReadTokens ?? 0) + (result.usage?.cachedWriteTokens ?? 0)).toBeGreaterThan(0)
    expect(run.transport.contextUsage()?.size ?? 0).toBeGreaterThan(0)
  }, 240_000)

  it('injects a steer while a shell tool is running', async () => {
    const run = await liveLaunch({ kind: 'new' })
    const choice = cheapChoice(run.transport)
    await run.transport.setConfigOption('model', choice.model)
    await run.transport.setConfigOption('reasoning_effort', choice.effort)
    const running = run.transport.prompt(
      say('Run the shell command `sleep 8` in the foreground. After it finishes reply with the single word DONE.'),
      new AbortController().signal,
    )
    await waitFor(() => run.updates().some((update) => update.sessionUpdate === 'tool_call'), 180_000)
    expect(
      await run.transport.steer(say('After the command finishes, also include the word STEERED in your reply.')),
    ).toBe('injected')
    expect((await running).stopReason).toBe('end_turn')
    expect(run.text().toUpperCase()).toContain('STEERED')
  }, 300_000)

  it('resumes the thread in a new transport and recalls what the first one was told', async () => {
    const first = await liveLaunch({ kind: 'new' })
    const choice = cheapChoice(first.transport)
    await first.transport.setConfigOption('model', choice.model)
    await first.transport.setConfigOption('reasoning_effort', choice.effort)
    const token = `PURPLE-${String(Math.floor(Math.random() * 90_000) + 10_000)}`
    await first.transport.prompt(say(`Remember this token for later: ${token}. Reply with only: OK`), new AbortController().signal)
    const sessionId = first.transport.sessionId
    expect(sessionId).toBeDefined()
    await first.transport.close()
    const second = await liveLaunch({ kind: 'resume', sessionId: sessionId ?? '' }, { cwd: first.dir })
    expect(second.transport.sessionId).toBe(sessionId)
    expect(second.transport.controls().configOptions.some((option) => option.id === 'model')).toBe(true)
    await second.transport.setConfigOption('model', choice.model)
    await second.transport.setConfigOption('reasoning_effort', choice.effort)
    await second.transport.prompt(say('What token did I ask you to remember? Reply with only the token.'), new AbortController().signal)
    expect(second.text()).toContain(token)
  }, 360_000)

  it('runs the next turn on the model and effort chosen through setConfigOption', async () => {
    const run = await liveLaunch({ kind: 'new' })
    const choice = cheapChoice(run.transport)
    // A collaboration mode set on the thread carries a model; a later model choice must still win on the next turn.
    await run.transport.setConfigOption('collaboration_mode', 'plan')
    await run.transport.setConfigOption('collaboration_mode', 'default')
    await run.transport.setConfigOption('model', choice.model)
    await run.transport.setConfigOption('reasoning_effort', choice.effort)
    const controls = run.transport.controls().configOptions
    expect(controls.find((option) => option.id === 'model')).toMatchObject({ currentValue: choice.model })
    expect(controls.find((option) => option.id === 'reasoning_effort')).toMatchObject({ currentValue: choice.effort })
    await run.transport.prompt(say('Reply with exactly: OK'), new AbortController().signal)
    const sessionId = run.transport.sessionId ?? ''
    const rollout = findRollout(sessionId)
    expect(rollout).toBeDefined()
    const contexts = readFileSync(rollout ?? '', 'utf8')
      .split('\n')
      .filter((line) => line.includes('"turn_context"'))
      .map(rolloutPayload)
    expect(contexts.at(-1)).toMatchObject({ model: choice.model, effort: choice.effort })
  }, 240_000)

  it('resumes a thread an ACP run saved, from a copy so the user history is untouched', async (context) => {
    const sessions = join(homedir(), '.codex', 'sessions')
    const candidates: Array<{ readonly file: string; readonly id: string; readonly cwd: string; readonly mtime: number }> = []
    const stack = [sessions]
    while (stack.length > 0) {
      const current = stack.pop()
      if (current === undefined || !existsSync(current)) continue
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const path = join(current, entry.name)
        if (entry.isDirectory()) {
          stack.push(path)
          continue
        }
        if (!entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) continue
        const first = readFileSync(path, 'utf8').split('\n', 1)[0] ?? ''
        if (!first.includes('dsh-acp-adapter')) continue
        const payload = rolloutPayload(first)
        const id = payload['id']
        const cwd = payload['cwd']
        if (typeof id !== 'string' || typeof cwd !== 'string' || payload['source'] !== 'vscode') continue
        if (!existsSync(cwd)) continue
        candidates.push({ file: path, id, cwd, mtime: statSync(path).mtimeMs })
      }
    }
    candidates.sort((left, right) => right.mtime - left.mtime)
    const old = candidates[0]
    if (old === undefined) {
      context.skip()
      return
    }
    const home = await tempDir('dsh-codex-home-')
    const target = join(home, 'sessions', relative(sessions, old.file))
    await mkdir(dirname(target), { recursive: true })
    await copyFile(old.file, target)
    const run = await liveLaunch({ kind: 'resume', sessionId: old.id }, { cwd: old.cwd, env: { CODEX_HOME: home } })
    expect(run.transport.sessionId).toBe(old.id)
    const controls = run.transport.controls()
    expect(controls.modes?.availableModes.map((mode) => mode.id)).toEqual(['read-only', 'workspace-write', 'agent', 'agent-full-access'])
    expect(controls.configOptions.map((option) => option.id)).toEqual(expect.arrayContaining(['mode', 'collaboration_mode', 'model', 'reasoning_effort']))
    // A thread nobody saved is "session not found" through the real server too.
    const missing = await liveLaunch({ kind: 'resume', sessionId: '01a00000-0000-7000-8000-000000000000' }, { env: { CODEX_HOME: home } }).catch(
      (failure: unknown) => failure,
    )
    expect(missing).toBeInstanceOf(NativeTransportError)
    expect(nativeError(missing).code).toBe('session-not-found')
    await rm(home, { recursive: true, force: true })
  }, 120_000)
})
