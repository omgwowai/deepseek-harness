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
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import type * as acp from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { fileURLToPath } from 'node:url'

import { nativeSpawnFromSeam } from '../../src/runtime/native/native-spawn.ts'
import {
  answerCodexServerRequest,
  fallbackCodexServerAnswer,
  type CodexApprovalHost,
  type CodexServerRequestAnswer,
} from '../../src/runtime/native/transports/codex-approvals.ts'
import { CODEX_UNSUPPORTED_COMMANDS, isUnsupportedCodexCommand } from '../../src/runtime/native/transports/codex-commands.ts'
import { CodexControlsState, findCodexMode, initialCodexMode, parseCodexModelPage } from '../../src/runtime/native/transports/codex-controls.ts'
import { formatGoal, goalFailure, goalNote, parseGoal, parseGoalArgs, type CodexGoal } from '../../src/runtime/native/transports/codex-goal.ts'
import {
  CodexProjection,
  CodexTokenAccounting,
  parseSingleUnifiedPatch,
  readableServiceErrorMessage,
  stripShellPrefix,
  toTokenCount,
} from '../../src/runtime/native/transports/codex-projection.ts'
import { INIT_PROMPT, SIDE_BOUNDARY_PROMPT, SIDE_DEVELOPER_INSTRUCTIONS } from '../../src/runtime/native/transports/codex-prompts.ts'
import { fencedDiff } from '../../src/runtime/native/transports/codex-reports.ts'
import {
  applyRestore,
  checkpointsOf,
  fileChangesOf,
  findCheckpoint,
  nodeRestoreIo,
  parseRewindArgs,
  parseTurnPage,
  planRestore,
  type DiskFile,
  type FileChange,
  type RestoreIo,
} from '../../src/runtime/native/transports/codex-rewind.ts'
import {
  CodexSideRun,
  SIDE_ALREADY_RUNNING_MESSAGE,
  SIDE_NOT_STARTED_MESSAGE,
  SIDE_REVIEW_RUNNING_MESSAGE,
  SIDE_USAGE_MESSAGE,
} from '../../src/runtime/native/transports/codex-side.ts'
import {
  CodexRpcError,
  createCodexTransport,
  isDefinitiveSteerRejection,
} from '../../src/runtime/native/transports/codex.ts'
import {
  NativeTransportError,
  type NativeCommand,
  type NativeCommandResult,
  type NativeContentBlock,
  type NativePromptResult,
  type NativeElicitationRequest,
  type NativePermissionDecision,
  type NativePermissionRequest,
  type NativeSessionTarget,
  type NativeSpawn,
  type NativeTransport,
  type NativeTransportEvent,
} from '../../src/runtime/native/transports/contract.ts'
import { generatedContextBlock } from '../../src/runtime/text-block-boundary.ts'
import { sharedTestSubprocess } from '../fixtures/subprocess-seam-testing.ts'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Frame = Record<string, unknown>
type FakeConfig = Record<string, unknown>
type Step = Record<string, unknown>
type SpawnSpec = Parameters<NativeSpawn>[0]
type Decision = NativePermissionDecision | Promise<NativePermissionDecision>
type FormAnswer = acp.CreateElicitationResponse | Promise<acp.CreateElicitationResponse>

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

/** The text of the last assistant message the transport emitted. */
function lastText(harness: Harness): string {
  const update = harness.updates('agent_message_chunk').at(-1)
  return update === undefined ? '' : chunkText(update)
}

interface Harness {
  readonly transport: NativeTransport
  readonly events: NativeTransportEvent[]
  readonly permissions: NativePermissionRequest[]
  readonly elicitations: NativeElicitationRequest[]
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
  prompt(text: string, signal?: AbortSignal): Promise<NativePromptResult>
  /**
   * The requests the transport sent (`→ method@thread`) and the notifications the server sent (`← method@thread`) in
   * the order the fake saw them, limited to `methods`.
   */
  trace(methods: readonly string[]): string[]
  /** The `commands` events, in order. */
  catalogs(): Array<readonly NativeCommand[]>
  /** `runCommand` and `sideQuestion` of the transport, which the interface leaves optional. */
  run(name: string, args?: string, signal?: AbortSignal): Promise<NativeCommandResult>
  side(question: string, signal?: AbortSignal): Promise<NativeCommandResult>
}

interface LaunchOptions {
  readonly config?: FakeConfig
  readonly env?: Readonly<Record<string, string>>
  readonly session?: NativeSessionTarget
  readonly decide?: (request: NativePermissionRequest) => Decision
  /** The host has a question surface, and this answers every form put to it. */
  readonly elicit?: (request: NativeElicitationRequest, signal: AbortSignal | undefined) => FormAnswer
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
  const elicitations: NativeElicitationRequest[] = []
  const elicit = options.elicit
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
    ...(elicit === undefined
      ? {}
      : {
          onElicitation: async (request: NativeElicitationRequest, signal?: AbortSignal) => {
            elicitations.push(request)
            return await elicit(request, signal)
          },
        }),
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
    elicitations,
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
    trace: (methods) =>
      frames().flatMap((frame) => {
        const sent = frame['sent']
        const method = typeof sent === 'string' ? sent : frame['method']
        const params = paramsOf(frame)
        const thread = typeof sent === 'string' ? frame['threadId'] : params['threadId']
        if (typeof method !== 'string' || !methods.includes(method)) return []
        return [`${typeof sent === 'string' ? '←' : '→'} ${method}${typeof thread === 'string' ? `@${thread}` : ''}`]
      }),
    catalogs: () =>
      events.flatMap((event) => (event.kind === 'commands' ? [event.commands] : [])),
    run: async (name, args = '', signal = new AbortController().signal) => {
      if (transport.runCommand === undefined) throw new Error('the Codex transport has no runCommand')
      return await transport.runCommand(name, args, signal)
    },
    side: async (question, signal = new AbortController().signal) => {
      if (transport.sideQuestion === undefined) throw new Error('the Codex transport has no sideQuestion')
      return await transport.sideQuestion(question, signal)
    },
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
 * appended to `FAKE_CODEX_LOG`.
 *
 * Goals: `goal` is the thread's goal (`thread/goal/get|set|clear` keep it and notify); while it is
 * active and no turn runs, the server starts the next scripted turn of `goalTurns` by itself, as the
 * real one does (`{ goal: 'complete' }` is a step that completes it; `goalStartsOnResume` starts one
 * when a thread is resumed). History: `history` is the list of recorded turns `{ id, startedAt, items }`
 * that `thread/turns/list` pages through (`turnsPageSize`) and `thread/revert` cuts; `watchOnRevert`
 * logs whether the named files exist at that moment. Written without backticks: it lives in a template literal.
 */
const FAKE_CODEX_APP_SERVER = `import { appendFileSync, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'

const NL = String.fromCharCode(10)
const cfg = JSON.parse(process.env.FAKE_CODEX_CONFIG || '{}')
const logPath = process.env.FAKE_CODEX_LOG
const THREAD = cfg.threadId || 'thr_test'
const FORK = cfg.forkId || 'thr_fork'
const SIDE = cfg.sideId || 'thr_side'

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
// The notifications the server sends are logged too, so that a test can order them against the client's requests.
function send(frame) {
  if (frame.method && frame.id === undefined) log({ sent: frame.method, threadId: frame.params && frame.params.threadId })
  process.stdout.write(JSON.stringify(frame) + NL)
}
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
  if (ctx.thread !== activeThread) return
  running -= 1
  // An active goal makes the server start the next turn by itself right after one completed (not after an interrupt).
  if (status === 'completed') setTimeout(continueGoal, 5)
}

async function run(ctx, steps) {
  if (ctx.thread === activeThread) running += 1
  for (const step of steps) {
    if (step.goal) {
      goal = Object.assign({}, goal, { status: step.goal })
      notify('thread/goal/updated', { threadId: ctx.thread, turnId: ctx.turn, goal: goal })
    } else if (step.n) {
      const params = sub(step.p, ctx)
      if (step.chunk) { notifyChunked(step.n, params); await sleep(80) } else notify(step.n, params)
    } else if (step.r) {
      await reverse(step.r, sub(step.p, ctx))
    } else if (step.sleep) {
      await sleep(step.sleep)
    } else if (step.wait === 'steer') {
      await waitFor('steer')
    } else if (step.wait === 'interrupt') {
      await waitFor('interrupt:' + ctx.thread)
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

// cfg.goalTurns[n] scripts the n-th turn the server starts by itself for an active goal (as the app-server does once the thread is idle).
function continueGoal() {
  if (!goal || goal.status !== 'active' || running > 0) return
  const spec = (cfg.goalTurns || [])[goalTurnCount]
  if (spec === undefined) return
  goalTurnCount += 1
  const ctx = { thread: activeThread, turn: 'turn_goal_' + goalTurnCount }
  notify('turn/started', { threadId: ctx.thread, turn: { id: ctx.turn, status: 'inProgress', items: [], error: null } })
  void run(ctx, Array.isArray(spec) ? spec : spec.steps || [])
}

// One turn of the recorded history as thread/turns/list shows it: nothing, the first user message and the last answer, or everything.
function turnView(turn, view) {
  const items = turn.items || []
  const summary = [items.find(function (item) { return item.type === 'userMessage' }), items.filter(function (item) { return item.type === 'agentMessage' }).pop()]
  const shown = view === 'full' ? items : view === 'notLoaded' ? [] : summary.filter(Boolean)
  return sub({ id: turn.id, rootTurnId: turn.id, items: shown, itemsView: view || 'summary', status: 'completed', error: null, startedAt: turn.startedAt === undefined ? null : turn.startedAt, completedAt: null, durationMs: null }, { thread: activeThread, turn: turn.id })
}

function threadResponse(id, resume) {
  const t = cfg.thread || {}
  const response = {
    thread: { id: id, name: t.name || null, forkedFromId: t.forkedFromId || null },
    model: t.model || 'gpt-6-astra',
    modelProvider: t.modelProvider || 'fake-provider',
    reasoningEffort: t.reasoningEffort === undefined ? 'max' : t.reasoningEffort,
    serviceTier: t.serviceTier || null,
    cwd: process.cwd(),
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: { type: 'workspaceWrite' },
    instructionSources: (cfg.instructionSources || []).map(function (source) { return source.split('$cwd').join(process.cwd()) })
  }
  if (resume && t.collaborationMode) {
    response.collaborationMode = { mode: t.collaborationMode, settings: { model: response.model, reasoning_effort: null, developer_instructions: null } }
  }
  return response
}

let activeThread = THREAD
let startCount = 0
let turnCount = 0
let steerCalls = 0
let interruptCalls = 0
let running = 0
let goalTurnCount = 0
let goal = cfg.goal ? Object.assign({ threadId: THREAD, tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 }, cfg.goal) : null
let history = cfg.history || []
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

// cfg.requestErrors fails a method, cfg.after sends notifications right behind the answer to a method.
function handle(frame) {
  const failure = (cfg.requestErrors || {})[frame.method]
  if (failure && typeof frame.id === 'number') { respondError(frame.id, -32600, failure); return }
  dispatch(frame)
  const extra = (cfg.after || {})[frame.method]
  if (extra) extra.forEach(function (entry) { notify(entry.n, entry.p) })
}

function dispatch(frame) {
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
    case 'thread/start': {
      // cfg.startIds[n] names the n-th thread/start; cfg.startError fails every one from cfg.startErrorFrom (default 1) on.
      const started = startCount++
      if (cfg.startError && started >= (cfg.startErrorFrom === undefined ? 1 : cfg.startErrorFrom)) { respondError(id, -32600, cfg.startError); break }
      const tid = (cfg.startIds || [])[started] || (started === 0 ? THREAD : THREAD + '_' + started)
      activeThread = tid
      respond(id, threadResponse(tid, false))
      break
    }
    case 'thread/fork':
      if (params.ephemeral) {
        // The fork of a side question: never the thread the conversation's turns run on.
        if (cfg.forkError) { respondError(id, -32600, cfg.forkError); break }
        respond(id, threadResponse(SIDE, false))
        notify('thread/started', { thread: { id: SIDE, ephemeral: true, forkedFromId: params.threadId, parentThreadId: null } })
        break
      }
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
        // A thread that was saved with an active goal: the server carries on with it as soon as the thread is loaded.
        if (cfg.goalStartsOnResume) setTimeout(continueGoal, 30)
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
      respond(id, { config: { model_provider: cfg.configProvider || null, developer_instructions: cfg.developerInstructions || null } })
      break
    case 'skills/list':
      respond(id, { data: [{ cwd: (params.cwds || [''])[0], skills: cfg.skills || [], errors: cfg.skillErrors || [] }] })
      break
    case 'skills/config/write': {
      const skill = (cfg.skills || []).find(function (entry) { return entry.path === params.path })
      if (!skill) { respondError(id, -32600, 'skill not found: ' + params.path); break }
      if (!cfg.skillsLocked) skill.enabled = params.enabled
      respond(id, { effectiveEnabled: skill.enabled !== false })
      break
    }
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
      if (params.threadId === SIDE) { startTurn(id, 'turn_side', cfg.side || [], SIDE); break }
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
      else { respond(id, {}); release('interrupt:' + params.threadId) }
      break
    case 'thread/inject_items':
      if (cfg.injectError) respondError(id, -32600, cfg.injectError)
      else respond(id, {})
      break
    case 'thread/unsubscribe':
      respond(id, { status: 'unsubscribed' })
      break
    case 'thread/shellCommand': {
      respond(id, {})
      // A command typed while a turn runs joins that turn: no turn of its own.
      if (cfg.shellJoins) break
      const ctx = { thread: params.threadId, turn: 'turn_shell' }
      notify('turn/started', { threadId: ctx.thread, turn: { id: ctx.turn, status: 'inProgress', items: [], error: null } })
      void run(ctx, cfg.shell || [])
      break
    }
    case 'mcpServerStatus/list': {
      const all = cfg.mcpServers || []
      const size = cfg.mcpPageSize || all.length || 1
      const start = params.cursor ? Number(params.cursor) : 0
      respond(id, { data: all.slice(start, start + size), nextCursor: start + size < all.length ? String(start + size) : null })
      break
    }
    case 'mcpServer/oauth/login':
      if (cfg.oauthError) respondError(id, -32600, cfg.oauthError)
      else respond(id, { authorizationUrl: cfg.oauthUrl || 'https://auth.example.com/login?x=1', loginId: 'login-1' })
      break
    case 'thread/backgroundTerminals/list':
      respond(id, { data: cfg.terminals || [], nextCursor: null })
      break
    case 'thread/backgroundTerminals/terminate':
      respond(id, { terminated: (cfg.terminals || []).some(function (entry) { return entry.processId === params.processId }) })
      break
    case 'hooks/list':
      respond(id, { data: [cfg.hooks || { cwd: process.cwd(), hooks: [], warnings: [], errors: [] }] })
      break
    case 'account/rateLimits/read':
      if (cfg.rateLimits) respond(id, cfg.rateLimits)
      else respondError(id, -32600, 'codex account authentication required to read rate limits')
      break
    case 'account/usage/read':
      if (cfg.accountUsage) respond(id, cfg.accountUsage)
      else respondError(id, -32600, 'codex account authentication required to read token usage')
      break
    case 'command/exec': {
      // The git arguments after the six configuration words the transport always passes.
      const key = params.command.slice(7).join(' ')
      const hit = (cfg.exec || []).find(function (entry) { return key.indexOf(entry.starts) === 0 })
      if (hit && hit.error) respondError(id, -32600, hit.error)
      else respond(id, hit ? hit.result : { exitCode: 0, stdout: '', stderr: '' })
      break
    }
    case 'thread/goal/get':
      respond(id, { goal: goal })
      break
    case 'thread/goal/set': {
      const fields = {}
      if (params.objective !== undefined) fields.objective = params.objective
      if (params.status !== undefined) fields.status = params.status
      goal = Object.assign({ threadId: params.threadId, objective: '', status: 'active', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 }, goal || {}, fields)
      respond(id, { goal: goal })
      notify('thread/goal/updated', { threadId: params.threadId, turnId: null, goal: goal })
      setTimeout(continueGoal, 5)
      break
    }
    case 'thread/goal/clear': {
      const had = goal !== null
      goal = null
      respond(id, { cleared: had })
      if (had) notify('thread/goal/cleared', { threadId: params.threadId })
      break
    }
    case 'thread/turns/list': {
      const ordered = params.sortDirection === 'desc' ? history.slice().reverse() : history.slice()
      const size = Math.min(params.limit || ordered.length || 1, cfg.turnsPageSize || 1000)
      const start = params.cursor ? Number(params.cursor) : 0
      respond(id, {
        data: ordered.slice(start, start + size).map(function (turn) { return turnView(turn, params.itemsView) }),
        nextCursor: start + size < ordered.length ? String(start + size) : null,
        backwardsCursor: null
      })
      break
    }
    case 'thread/revert': {
      const at = history.findIndex(function (turn) { return turn.id === params.beforeTurnId })
      if (at < 0) { respondError(id, -32600, 'turn not found: ' + params.beforeTurnId); break }
      // cfg.watchOnRevert names files whose existence is logged at the moment the conversation is rolled back.
      if (cfg.watchOnRevert) log({ atRevert: cfg.watchOnRevert.map(function (name) { return existsSync(name) }) })
      history = history.slice(0, at)
      respond(id, { thread: { id: params.threadId } })
      break
    }
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
/** A 0.162 `item/tool/requestUserInput`: the model's question with two options and room for another answer. */
const userInputStep: Step = {
  r: 'item/tool/requestUserInput',
  p: {
    threadId: '$thread',
    turnId: '$turn',
    itemId: 'q-1',
    isBlocking: true,
    autoResolutionMs: null,
    questions: [
      {
        id: 'a',
        header: 'Pick',
        question: 'Pick one?',
        isOther: true,
        isSecret: false,
        options: [
          { label: 'one', description: 'First' },
          { label: 'two', description: 'Second' },
        ],
      },
    ],
  },
}
/** An MCP elicitation form with a field (a legacy titled enum), as an MCP server asks it. */
const mcpFormStep: Step = {
  r: 'mcpServer/elicitation/request',
  p: {
    threadId: '$thread',
    turnId: '$turn',
    serverName: 'docs',
    mode: 'form',
    message: 'Where to?',
    requestedSchema: {
      type: 'object',
      properties: {
        env: { type: 'string', title: 'Environment', enum: ['dev', 'prod'], enumNames: ['Development', 'Production'] },
      },
      required: ['env'],
    },
  },
}

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
  readonly elicitations: NativeElicitationRequest[]
  readonly updates: acp.SessionUpdate[]
  readonly logs: string[]
  readonly projection: CodexProjection
}

/** A host whose permission prompts `decide` answers; it has a question surface only when `elicit` is given. */
function stubHost(
  decide: (request: NativePermissionRequest) => NativePermissionDecision,
  elicit?: (request: NativeElicitationRequest, signal: AbortSignal) => FormAnswer,
): StubHost {
  const requests: NativePermissionRequest[] = []
  const elicitations: NativeElicitationRequest[] = []
  const updates: acp.SessionUpdate[] = []
  const logs: string[] = []
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
    ...(elicit === undefined
      ? {}
      : {
          elicit: async (request: NativeElicitationRequest, signal: AbortSignal) => {
            elicitations.push(request)
            return await elicit(request, signal)
          },
        }),
    update: (update) => updates.push(update),
    nextStandaloneMcpToolCallId: (threadId, serverName) => projection.nextStandaloneMcpToolCallId(threadId, serverName),
    log: (message) => logs.push(message),
  }
  return { host, requests, elicitations, updates, logs, projection }
}

const never = new AbortController().signal

const accepted = (content: Record<string, string | number | boolean | string[]>): acp.CreateElicitationResponse => ({
  action: 'accept',
  content,
})

/** What a question surface that never answers returns. */
const silence = (): Promise<never> => Promise.withResolvers<never>().promise

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

  it('answers a message-only MCP question as a standalone call and cancels a form with fields without a question surface', async () => {
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

  /**
   * An `item/tool/requestUserInput` as codex 0.162 sends it: a choice that also takes another answer, a secret, a
   * plain choice, and a free-text question whose id clashes with the note field of the first one.
   */
  const userInputParams = {
    threadId: 't',
    turnId: 'u',
    itemId: 'q-1',
    isBlocking: true,
    autoResolutionMs: null,
    questions: [
      {
        id: 'color',
        header: 'Palette',
        question: 'Which color?',
        isOther: true,
        isSecret: false,
        options: [
          { label: 'red', description: 'Warm' },
          { label: 'blue', description: '' },
        ],
      },
      { id: 'token', header: 'Credentials', question: 'Paste the token', isOther: false, isSecret: true, options: null },
      {
        id: 'size',
        header: '',
        question: 'Which size?',
        isOther: false,
        isSecret: false,
        options: [{ label: 'S', description: 'Small' }],
      },
      { id: 'color_note', header: 'Why', question: 'Why that color?', isOther: false, isSecret: false, options: null },
    ],
  }

  const askUserInput = async (
    params: Record<string, unknown>,
    stub: StubHost,
    signal: AbortSignal = never,
  ): Promise<CodexServerRequestAnswer> =>
    await answerCodexServerRequest('item/tool/requestUserInput', params, stub.host, signal)

  const noAnswers = { result: { answers: {} } }

  it('puts all user-input questions into one required form with the sentinel and a note for isOther', async () => {
    const stub = stubHost(() => ({ cancelled: true }), () => ({ action: 'cancel' }))
    await askUserInput(userInputParams, stub)
    expect(stub.requests).toHaveLength(0)
    expect(stub.elicitations).toHaveLength(1)
    const form = stub.elicitations[0]
    expect(Object.keys(form?.requestedSchema.properties ?? {})).toEqual([
      'color',
      'color_note1',
      'token',
      'size',
      'color_note',
    ])
    expect(form).toEqual({
      toolCallId: 'q-1',
      message: 'Codex needs your input to continue.',
      requestedSchema: {
        type: 'object',
        properties: {
          color: {
            type: 'string',
            title: 'Which color?',
            description: 'Palette',
            _meta: { codex: { isOther: true, isSecret: false } },
            oneOf: [
              { const: 'red', title: 'red', description: 'Warm' },
              { const: 'blue', title: 'blue' },
              {
                const: 'None of the above',
                title: 'None of the above',
                description: 'Provide a different answer in the note field.',
              },
            ],
          },
          color_note1: {
            type: 'string',
            title: 'Additional answer or note',
            _meta: { codex: { questionId: 'color', role: 'user_note', isSecret: false } },
          },
          token: {
            type: 'string',
            title: 'Paste the token',
            description: 'Credentials',
            _meta: { codex: { isOther: false, isSecret: true } },
          },
          size: {
            type: 'string',
            title: 'Which size?',
            _meta: { codex: { isOther: false, isSecret: false } },
            oneOf: [{ const: 'S', title: 'S', description: 'Small' }],
          },
          color_note: {
            type: 'string',
            title: 'Why that color?',
            description: 'Why',
            _meta: { codex: { isOther: false, isSecret: false } },
          },
        },
        required: ['color', 'token', 'size', 'color_note'],
      },
      _meta: { codex: { autoResolutionMs: null } },
    })
  })

  it('adds no second sentinel, gives free-text questions no note and titles a bare question by its id', async () => {
    const stub = stubHost(() => ({ cancelled: true }), () => ({ action: 'cancel' }))
    await askUserInput(
      {
        itemId: 'q-2',
        questions: [
          {
            id: 'a',
            header: 'H',
            question: 'A?',
            isOther: true,
            isSecret: false,
            options: [
              { label: 'x', description: 'X' },
              { label: 'None of the above', description: '' },
            ],
          },
          { id: 'b', header: 'H', question: 'B?', isOther: true, isSecret: false, options: null },
          { id: 'c', header: '', question: '', isOther: false, isSecret: false, options: [] },
        ],
      },
      stub,
    )
    const form = stub.elicitations[0]
    const fields = form?.requestedSchema.properties ?? {}
    expect(Object.keys(fields)).toEqual(['a', 'a_note', 'b', 'c'])
    expect(fields['a']).toMatchObject({
      oneOf: [
        { const: 'x', title: 'x', description: 'X' },
        { const: 'None of the above', title: 'None of the above' },
      ],
    })
    expect(fields['a_note']).toMatchObject({ _meta: { codex: { questionId: 'a', role: 'user_note', isSecret: false } } })
    expect(fields['b']).toEqual({
      type: 'string',
      title: 'B?',
      description: 'H',
      _meta: { codex: { isOther: true, isSecret: false } },
    })
    expect(fields['c']).toEqual({ type: 'string', title: 'c', _meta: { codex: { isOther: false, isSecret: false } } })
    expect(form?.requestedSchema.required).toEqual(['a', 'b', 'c'])
    expect(form?.toolCallId).toBe('q-2')
    // The app-server sent no deadline: nothing is claimed about one.
    expect(form?._meta).toEqual({ codex: {} })
  })

  it('answers with the picked option, the typed text and the notes the way codex-acp decodes a form', async () => {
    const decode = async (response: acp.CreateElicitationResponse): Promise<unknown> =>
      await askUserInput(userInputParams, stubHost(() => ({ cancelled: true }), () => response))
    expect(await decode(accepted({ color: 'blue', token: 'sk-1', size: 'S', color_note: 'warm tones' }))).toEqual({
      result: {
        answers: {
          color: { answers: ['blue'] },
          token: { answers: ['sk-1'] },
          size: { answers: ['S'] },
          color_note: { answers: ['warm tones'] },
        },
      },
    })
    // The note of `color` is color_note1: `color_note` stays a question of its own.
    expect(await decode(accepted({ color: 'None of the above', color_note1: '  teal  ' }))).toEqual({
      result: { answers: { color: { answers: ['None of the above', 'user_note: teal'] } } },
    })
    expect(await decode(accepted({ color: 'red', color_note1: 'but darker' }))).toEqual({
      result: { answers: { color: { answers: ['red', 'user_note: but darker'] } } },
    })
    expect(await decode(accepted({ color_note1: 'only a note' }))).toEqual({
      result: { answers: { color: { answers: ['user_note: only a note'] } } },
    })
    // A skipped field, a blank text and an empty list are no answers.
    expect(await decode(accepted({ color: '', token: '   ', size: [] }))).toEqual(noAnswers)
    expect(await decode({ action: 'accept' })).toEqual(noAnswers)
  })

  it('answers nothing for a declined or cancelled form, bad content, a failing surface and an empty question list', async () => {
    const malformed = { action: 'accept', content: { color: { nested: true } } } as unknown as acp.CreateElicitationResponse
    const responses: acp.CreateElicitationResponse[] = [{ action: 'decline' }, { action: 'cancel' }, { action: '_vendor' }, malformed]
    for (const response of responses) {
      expect(await askUserInput(userInputParams, stubHost(() => ({ cancelled: true }), () => response))).toEqual(noAnswers)
    }
    const throwing = stubHost(
      () => ({ cancelled: true }),
      () => {
        throw new Error('ui exploded')
      },
    )
    expect(await askUserInput(userInputParams, throwing)).toEqual(noAnswers)
    expect(throwing.logs.join('\n')).toContain('ui exploded')
    const rejecting = stubHost(() => ({ cancelled: true }), () => Promise.reject(new Error('gone')))
    expect(await askUserInput(userInputParams, rejecting)).toEqual(noAnswers)
    expect(rejecting.logs.join('\n')).toContain('gone')
    const idle = stubHost(() => ({ cancelled: true }), () => accepted({}))
    expect(await askUserInput({ itemId: 'q', questions: [] }, idle)).toEqual(noAnswers)
    expect(idle.elicitations).toHaveLength(0)
  })

  it('withdraws the form and answers nothing once autoResolutionMs elapses or the turn is cancelled, and waits otherwise', async () => {
    let withdrawn: AbortSignal | undefined
    const silent = stubHost(
      () => ({ cancelled: true }),
      (_request, signal) => {
        withdrawn = signal
        return silence()
      },
    )
    expect(await askUserInput({ ...userInputParams, autoResolutionMs: 20 }, silent)).toEqual(noAnswers)
    expect(withdrawn?.aborted).toBe(true)
    expect(silent.elicitations[0]?._meta).toEqual({ codex: { autoResolutionMs: 20 } })

    let live: AbortSignal | undefined
    const timely = stubHost(
      () => ({ cancelled: true }),
      (_request, signal) => {
        live = signal
        return accepted({ size: 'S' })
      },
    )
    expect(await askUserInput({ ...userInputParams, autoResolutionMs: 60_000 }, timely)).toEqual({
      result: { answers: { size: { answers: ['S'] } } },
    })
    expect(live?.aborted).toBe(false)

    const turn = new AbortController()
    let pending: AbortSignal | undefined
    const waiting = stubHost(
      () => ({ cancelled: true }),
      (_request, signal) => {
        pending = signal
        return silence()
      },
    )
    const cancelled = askUserInput({ ...userInputParams, autoResolutionMs: 60_000 }, waiting, turn.signal)
    turn.abort()
    expect(await cancelled).toEqual(noAnswers)
    expect(pending?.aborted).toBe(true)

    // `null` is no deadline, and so is an absent field (the schema default).
    const slow = stubHost(
      () => ({ cancelled: true }),
      async () => {
        const { promise, resolve } = Promise.withResolvers<void>()
        setTimeout(resolve, 60)
        await promise
        return accepted({ size: 'S' })
      },
    )
    const bySize = { result: { answers: { size: { answers: ['S'] } } } }
    expect(await askUserInput(userInputParams, slow)).toEqual(bySize)
    const { questions } = userInputParams
    expect(await askUserInput({ itemId: 'q-3', questions }, slow)).toEqual(bySize)
  })

  it('answers user input with no answers, and asks nothing, when the host has no question surface', async () => {
    const stub = stubHost(() => ({ optionId: 'allow_once' }))
    expect(await askUserInput(userInputParams, stub)).toEqual(noAnswers)
    expect(stub.requests).toHaveLength(0)
    expect(stub.elicitations).toHaveLength(0)
  })

  it('withdraws a question the model does not block on after two minutes, and keeps waiting for a blocking one', async () => {
    vi.useFakeTimers()
    try {
      let withdrawn: AbortSignal | undefined
      const casual = stubHost(
        () => ({ cancelled: true }),
        (_request, signal) => {
          withdrawn = signal
          return silence()
        },
      )
      const unblocked = { ...userInputParams, isBlocking: false }
      const answering = askUserInput(unblocked, casual)
      await vi.advanceTimersByTimeAsync(119_000)
      expect(withdrawn?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await answering).toEqual(noAnswers)
      expect(withdrawn?.aborted).toBe(true)
      // The form tells the question surface how long it stays.
      expect(casual.elicitations[0]?._meta).toEqual({ codex: { autoResolutionMs: 120_000 } })

      // A deadline the request itself names wins over the default.
      const quick = askUserInput({ ...unblocked, autoResolutionMs: 5_000 }, stubHost(() => ({ cancelled: true }), silence))
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await quick).toEqual(noAnswers)

      // A blocking question waits for as long as it takes.
      let settled = false
      void askUserInput(userInputParams, stubHost(() => ({ cancelled: true }), silence)).then(() => {
        settled = true
      })
      await vi.advanceTimersByTimeAsync(60 * 60_000)
      expect(settled).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  const mcpFormParams = {
    threadId: 't',
    turnId: 'u',
    serverName: 'deploy',
    mode: 'form',
    message: 'Where to deploy?',
    requestedSchema: {
      type: 'object',
      properties: {
        env: {
          type: 'string',
          title: 'Environment',
          enum: ['dev', 'prod'],
          enumNames: ['Development', 'Production'],
          default: 'dev',
        },
        region: { type: 'string', enum: ['eu', 'us'], enumNames: ['Europe'] },
        retries: { type: 'integer', title: 'Retries', minimum: 1 },
        notify: { type: 'boolean', title: 'Notify' },
        tags: { type: 'array', title: 'Tags', items: { type: 'string', enum: ['a', 'b'] } },
      },
      required: ['env'],
    },
    _meta: { source: 'deploy-server' },
  }

  const askMcpForm = async (stub: StubHost): Promise<CodexServerRequestAnswer> =>
    await answerCodexServerRequest('mcpServer/elicitation/request', mcpFormParams, stub.host, never)

  it('puts an MCP form that has fields to the question surface, schema normalized and meta passed through', async () => {
    const content = { env: 'prod', retries: 3, notify: true, tags: ['a'] }
    const stub = stubHost(
      () => ({ cancelled: true }),
      () => ({ action: 'accept', content, _meta: { source: 'dsh' } }),
    )
    expect(await askMcpForm(stub)).toEqual({ result: { action: 'accept', content, _meta: { source: 'dsh' } } })
    expect(stub.requests).toHaveLength(0)
    expect(stub.updates).toEqual([])
    expect(stub.elicitations).toEqual([
      {
        message: 'Where to deploy?',
        requestedSchema: {
          type: 'object',
          properties: {
            env: {
              type: 'string',
              title: 'Environment',
              default: 'dev',
              oneOf: [
                { const: 'dev', title: 'Development' },
                { const: 'prod', title: 'Production' },
              ],
            },
            region: {
              type: 'string',
              oneOf: [
                { const: 'eu', title: 'Europe' },
                { const: 'us', title: 'us' },
              ],
            },
            retries: { type: 'integer', title: 'Retries', minimum: 1 },
            notify: { type: 'boolean', title: 'Notify' },
            tags: { type: 'array', title: 'Tags', items: { type: 'string', enum: ['a', 'b'] } },
          },
          required: ['env'],
        },
        _meta: { source: 'deploy-server' },
      },
    ])
  })

  it('converts the response to an MCP form the way codex-acp does', async () => {
    const answerWith = async (surface: () => FormAnswer): Promise<unknown> =>
      await askMcpForm(stubHost(() => ({ cancelled: true }), surface))
    const cancelled = { result: { action: 'cancel', content: null, _meta: null } }
    expect(await answerWith(() => ({ action: 'accept' }))).toEqual({ result: { action: 'accept', content: null, _meta: null } })
    expect(await answerWith(() => ({ action: 'accept', content: {} }))).toEqual({
      result: { action: 'accept', content: null, _meta: null },
    })
    expect(await answerWith(() => ({ action: 'decline' }))).toEqual({ result: { action: 'decline', content: null, _meta: null } })
    expect(await answerWith(() => ({ action: 'cancel' }))).toEqual(cancelled)
    expect(await answerWith(() => ({ action: '_vendor' }))).toEqual(cancelled)
    const malformed = { action: 'accept', content: { env: { nested: true } } } as unknown as acp.CreateElicitationResponse
    expect(await answerWith(() => malformed)).toEqual(cancelled)
    const throwing = stubHost(
      () => ({ cancelled: true }),
      () => {
        throw new Error('ui exploded')
      },
    )
    expect(await askMcpForm(throwing)).toEqual(cancelled)
    expect(throwing.logs.join('\n')).toContain('ui exploded')
  })

  it('keeps URL requests, message-only questions and tool approvals on permission prompts when a question surface exists', async () => {
    const surface = (): never => {
      throw new Error('only a form with fields belongs on the question surface')
    }
    const url = stubHost(() => ({ optionId: 'accept' }), surface)
    expect(
      await answerCodexServerRequest(
        'mcpServer/elicitation/request',
        {
          threadId: 't',
          serverName: 'docs',
          mode: 'url',
          message: 'Sign in',
          url: 'https://example.com/auth',
          elicitationId: 'el-1',
        },
        url.host,
        never,
      ),
    ).toEqual({ result: { action: 'accept', content: null, _meta: null } })
    expect(url.requests[0]?.toolCall).toMatchObject({
      toolCallId: 'elicitation-el-1',
      kind: 'fetch',
      title: 'MCP server requests to open a URL',
    })
    expect(url.requests[0]?.options.map((option) => option.optionId)).toEqual(['accept', 'decline', 'cancel'])
    expect(url.updates.at(-1)).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'elicitation-el-1',
      status: 'completed',
      rawOutput: { action: 'accept' },
    })
    expect(url.elicitations).toHaveLength(0)

    const question = stubHost(() => ({ optionId: 'decline' }), surface)
    expect(
      await answerCodexServerRequest(
        'mcpServer/elicitation/request',
        { threadId: 't', serverName: 'docs', mode: 'form', message: 'Proceed?', requestedSchema: { type: 'object', properties: {} } },
        question.host,
        never,
      ),
    ).toEqual({ result: { action: 'decline', content: null, _meta: null } })
    expect(question.requests[0]?.toolCall).toMatchObject({ kind: 'other', title: 'Question from MCP server' })
    expect(question.elicitations).toHaveLength(0)

    const approval = stubHost(() => ({ optionId: 'allow_once' }), surface)
    approval.projection.handle('item/started', {
      threadId: 't',
      item: { type: 'mcpToolCall', id: 'mcp-1', server: 'docs', tool: 'search', arguments: {}, status: 'inProgress', result: null, error: null },
    })
    expect(
      await answerCodexServerRequest(
        'mcpServer/elicitation/request',
        {
          threadId: 't',
          turnId: 'u',
          serverName: 'docs',
          mode: 'form',
          message: 'Allow docs?',
          requestedSchema: null,
          _meta: { codex_approval_kind: 'mcp_tool_call' },
        },
        approval.host,
        never,
      ),
    ).toEqual({ result: { action: 'accept', content: null, _meta: null } })
    expect(approval.requests[0]?.toolCall).toEqual({ toolCallId: 'mcp-1', kind: 'execute', status: 'pending' })
    expect(approval.elicitations).toHaveLength(0)
  })

  it('shows an MCP URL request as a link and declines the ones the TUI would not show', async () => {
    const ask = async (stub: StubHost, serverName: string, url: unknown): Promise<CodexServerRequestAnswer> =>
      await answerCodexServerRequest(
        'mcpServer/elicitation/request',
        { threadId: 't', serverName, mode: 'url', message: 'Sign in', url, elicitationId: 'el-9' },
        stub.host,
        never,
      )
    const accept = { result: { action: 'accept', content: null, _meta: null } }
    const decline = { result: { action: 'decline', content: null, _meta: null } }

    const shown = stubHost(() => ({ optionId: 'accept' }))
    expect(await ask(shown, 'docs', 'https://example.com/auth?x=1#top')).toEqual(accept)
    expect(shown.requests[0]?.toolCall.content).toEqual([
      { type: 'content', content: { type: 'text', text: 'Sign in\n\n<https://example.com/auth?x=1#top>' } },
    ])
    expect(shown.requests[0]?.toolCall.rawInput).toMatchObject({ url: 'https://example.com/auth?x=1#top' })

    // Only an https link without credentials is put in front of the user; nothing else is even asked about.
    for (const url of ['http://example.com/auth', 'https://user:secret@example.com/auth', 'ftp://example.com/file', 'javascript:alert(1)', 'not a url', '', 42, undefined]) {
      const refused = stubHost(() => ({ optionId: 'accept' }))
      expect(await ask(refused, 'docs', url), String(url)).toEqual(decline)
      expect(refused.requests, String(url)).toHaveLength(0)
      expect(refused.logs.join('\n')).toContain('declining a URL request of the MCP server docs')
    }

    // The ChatGPT apps connector may only send people to ChatGPT itself.
    const apps = stubHost(() => ({ optionId: 'accept' }))
    expect(await ask(apps, 'codex_apps', 'https://evil.example.com/login')).toEqual(decline)
    expect(await ask(apps, 'codex_apps', 'https://chatgpt.com.evil.example/login')).toEqual(decline)
    expect(apps.requests).toHaveLength(0)
    expect(await ask(apps, 'codex_apps', 'https://chatgpt.com/apps/calendar')).toEqual(accept)
    expect(await ask(apps, 'codex_apps', 'https://auth.chatgpt.com/login')).toEqual(accept)
    expect(apps.requests).toHaveLength(2)
  })

  it('closes an abandoned question with the answer for no input', () => {
    expect(fallbackCodexServerAnswer('item/tool/requestUserInput')).toEqual(noAnswers)
    expect(fallbackCodexServerAnswer('mcpServer/elicitation/request')).toEqual({
      result: { action: 'cancel', content: null, _meta: null },
    })
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

  it('announces the Codex commands, then adds the enabled skills as prompt commands, and no longer sends an ACP command list', async () => {
    const skill = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      name,
      description: `About ${name}`,
      path: `/skills/${name}/SKILL.md`,
      enabled: true,
      ...extra,
    })
    const harness = await launch({
      config: {
        skills: [
          skill('deploy', { description: 'A very long description for the model', interface: { shortDescription: 'Deploy it' } }),
          skill('lint'),
          skill('retired', { enabled: false }),
          // A skill cannot take the name of a command that Codex or DSH owns, nor a name that is not one word.
          skill('status'),
          skill('vim'),
          skill('two words'),
        ],
      },
    })
    await waitFor(() => harness.catalogs().length >= 2)
    const [builtIn = [], withSkills = []] = harness.catalogs()
    const side = builtIn.find((command) => command.name === 'side')
    expect(side).toMatchObject({ dispatch: 'side', aliases: ['btw'] })
    expect(builtIn.find((command) => command.name === 'stop')?.aliases).toEqual(['clean'])
    // Nothing that only makes sense in a terminal is offered.
    expect(builtIn.filter((command) => isUnsupportedCodexCommand(command.name))).toEqual([])
    expect(withSkills.slice(0, builtIn.length)).toEqual(builtIn)
    expect(withSkills.slice(builtIn.length)).toEqual([
      { name: 'deploy', description: 'Deploy it', hint: '[request]', dispatch: 'prompt' },
      { name: 'lint', description: 'About lint', hint: '[request]', dispatch: 'prompt' },
    ])
    expect(harness.transport.commands?.()).toEqual(withSkills)
    expect(harness.updates('available_commands_update')).toEqual([])
  })

  it('implements every command it advertises on the path its dispatch names', async () => {
    const compaction = [itemStarted({ type: 'contextCompaction', id: 'cc-1' }), itemCompleted({ type: 'contextCompaction', id: 'cc-1' })]
    const harness = await launch({ config: { review: messageSteps('review-1', 'looks fine'), compact: compaction } })
    await waitFor(() => harness.catalogs().length >= 1)
    const [catalog = []] = harness.catalogs()
    expect(harness.transport.runCommand).toBeDefined()
    expect(harness.transport.sideQuestion).toBeDefined()
    for (const command of catalog) {
      // They replace the conversation; the `/new` test covers them.
      if (command.dispatch === 'immediate' && command.name !== 'new' && command.name !== 'clear') {
        const result = await harness.run(command.name)
        expect(result.text, command.name).not.toContain('is not an immediate Codex command')
      } else if (command.dispatch === 'prompt') {
        await harness.prompt(`/${command.name}`)
      }
    }
    // Prompt commands are carried out or explained, never sent to the model as the typed line.
    const sentToModel = harness.sent('turn/start').flatMap((frame) => {
      const input = paramsOf(frame)['input']
      return Array.isArray(input) ? input.map((item) => objectOf(item)['text']) : []
    })
    expect(sentToModel.filter((text) => typeof text === 'string' && text.startsWith('/'))).toEqual([])
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
      elicit: (request) =>
        request.message === 'Codex needs your input to continue.' ? accepted({ a: 'one' }) : accepted({ env: 'prod' }),
      config: {
        turns: [
          [
            itemStarted(commandItem('exec-1')),
            { r: 'item/commandExecution/requestApproval', p: { threadId: '$thread', turnId: '$turn', itemId: 'exec-1', command: "/bin/zsh -lc 'rm x'", cwd: '$cwd', commandActions: [{ type: 'unknown', command: 'rm x' }] } },
            { r: 'item/fileChange/requestApproval', p: { threadId: '$thread', turnId: '$turn', itemId: 'patch-9' } },
            { r: 'item/permissions/requestApproval', p: { threadId: '$thread', turnId: '$turn', itemId: 'perm-1', cwd: '$cwd', permissions: { network: { enabled: true } } } },
            userInputStep,
            { r: 'mcpServer/elicitation/request', p: { threadId: '$thread', turnId: '$turn', serverName: 'docs', mode: 'form', message: 'Ok?', requestedSchema: null } },
            { r: 'item/tool/call', p: { threadId: '$thread', turnId: '$turn', callId: 'c', tool: 't', arguments: {} } },
            { r: 'account/chatgptAuthTokens/refresh', p: { reason: 'unauthorized' } },
            { r: 'attestation/generate', p: {} },
            { r: 'currentTime/read', p: {} },
            { r: 'applyPatchApproval', p: { conversationId: '$thread', callId: 'c1', fileChanges: {} } },
            { r: 'execCommandApproval', p: { conversationId: '$thread', callId: 'c2', command: ['ls'], cwd: '$cwd' } },
            { r: 'brand/newRequest', p: {} },
            mcpFormStep,
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
    expect(answer(9013)?.['result']).toEqual({ action: 'accept', content: { env: 'prod' }, _meta: null })
    // Approvals went to the permission handler, the questions to the question surface.
    expect(harness.permissions.map((request) => request.toolCall.toolCallId)).toEqual([
      'exec-1',
      'patch-9',
      'perm-1',
      'elicitation:thr_test:docs:1',
      'c1',
      'c2',
    ])
    expect(harness.elicitations.map((request) => request.message)).toEqual(['Codex needs your input to continue.', 'Where to?'])
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

  it('answers questions empty and cancels forms with fields when the host has no question surface', async () => {
    const harness = await launch({ config: { turns: [[userInputStep, mcpFormStep, ...messageSteps('msg-1', 'done')]] } })
    expect((await harness.prompt('go')).stopReason).toBe('end_turn')
    expect(replyTo(harness.frames(), 9001)?.['result']).toEqual({ answers: {} })
    expect(replyTo(harness.frames(), 9002)?.['result']).toEqual({ action: 'cancel', content: null, _meta: null })
    expect(harness.permissions).toEqual([])
  })

  it('releases a pending question with the empty answer when the turn is aborted, whether or not the surface notices', async () => {
    let formSignal: AbortSignal | undefined
    const harness = await launch({
      elicit: (_request, signal) => {
        formSignal = signal
        return silence()
      },
      config: { turns: [[userInputStep, { wait: 'interrupt' }]] },
    })
    const controller = new AbortController()
    const running = harness.prompt('go', controller.signal)
    await waitFor(() => harness.elicitations.length === 1)
    controller.abort()
    await expect(running).resolves.toMatchObject({ stopReason: 'cancelled' })
    expect(replyTo(harness.frames(), 9001)?.['result']).toEqual({ answers: {} })
    expect(formSignal?.aborted).toBe(true)
  })

  it('never hangs the server when the question surface throws', async () => {
    const harness = await launch({
      elicit: () => {
        throw new Error('ui exploded')
      },
      config: { turns: [[userInputStep, mcpFormStep, ...messageSteps('msg-1', 'after')]] },
    })
    expect((await harness.prompt('go')).stopReason).toBe('end_turn')
    expect(replyTo(harness.frames(), 9001)?.['result']).toEqual({ answers: {} })
    expect(replyTo(harness.frames(), 9002)?.['result']).toEqual({ action: 'cancel', content: null, _meta: null })
    expect(harness.logs.join('\n')).toContain('ui exploded')
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

  it('puts the questions Codex raises while planning to the question surface and still asks to implement the plan', async () => {
    const harness = await launch({
      decide: () => ({ optionId: 'revise_plan' }),
      elicit: () => accepted({ a: 'None of the above', a_note: ' only the CLI ' }),
      config: { turns: [[userInputStep, itemCompleted({ type: 'plan', id: 'plan-1', text: '1. CLI only' })]] },
    })
    await harness.transport.setConfigOption('collaboration_mode', 'plan')
    expect((await harness.prompt('plan the change')).stopReason).toBe('end_turn')
    // Codex only offers request_user_input in plan mode: the thread was in it before the turn that asked.
    const frames = harness.frames()
    const planned = frames.findIndex(
      (frame) =>
        frame['method'] === 'thread/settings/update' &&
        objectOf(paramsOf(frame)['collaborationMode'])['mode'] === 'plan',
    )
    const turn = frames.findIndex((frame) => frame['method'] === 'turn/start')
    const reply = frames.findIndex((frame) => frame['id'] === 9001 && frame['method'] === undefined)
    expect(planned).toBeGreaterThanOrEqual(0)
    expect(turn).toBeGreaterThan(planned)
    expect(reply).toBeGreaterThan(turn)
    expect(replyTo(frames, 9001)?.['result']).toEqual({
      answers: { a: { answers: ['None of the above', 'user_note: only the CLI'] } },
    })
    // The question reached the question surface; the permission handler saw only the plan review.
    expect(harness.elicitations).toHaveLength(1)
    expect(harness.elicitations[0]).toMatchObject({ toolCallId: 'q-1', message: 'Codex needs your input to continue.' })
    expect(harness.permissions.map((request) => request.toolCall.toolCallId)).toEqual(['plan-review:plan-1'])
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
  it('toggles plan mode with /plan without starting a turn and says what it did', async () => {
    const harness = await launch()
    expect((await harness.prompt('/plan')).stopReason).toBe('end_turn')
    expect(harness.sent('turn/start')).toHaveLength(0)
    expect(paramsOf(harness.sent('thread/settings/update').at(-1))).toMatchObject({ collaborationMode: { mode: 'plan' } })
    expect(harness.events.filter((event) => event.kind === 'controls')).toHaveLength(1)
    expect(lastText(harness)).toContain('Plan mode is on')
    await harness.prompt('/plan')
    expect(paramsOf(harness.sent('thread/settings/update').at(-1))).toMatchObject({ collaborationMode: { mode: 'default' } })
    expect(lastText(harness)).toContain('Plan mode is off')
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
    expect(lastText(harness)).toBe('Renamed the Codex thread to "Better name".')
    await harness.prompt('/review-branch')
    expect(harness.updates('agent_message_chunk').at(-1)).toMatchObject({ content: { text: 'Command "/review-branch" requires branch name.' } })
  })

  it('answers immediate commands typed as a prompt locally and forwards unknown slash text to the model', async () => {
    const harness = await launch({
      config: {
        skills: [{ name: 'deploy', description: 'Deploy', path: '/skills/deploy/SKILL.md', enabled: true, interface: { shortDescription: 'Deploy it' } }],
      },
    })
    await harness.prompt('/status')
    const text = lastText(harness)
    expect(text).toContain('**Model:** gpt-6-astra (reasoning max, summaries auto)')
    expect(text).toContain('**Permissions:** Auto review (approval on-request, sandbox workspace-write)')
    expect(text).toContain('**Session:** `thr_test`')
    expect(text).toContain('**Token usage:** data not available yet')
    await harness.prompt('/skills')
    expect(lastText(harness)).toContain('- `deploy` — Deploy it')
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
// 4b. Side questions, thread scoping, typed commands, immediate commands, shell escape, quiet notices
// ---------------------------------------------------------------------------

/** A turn that stays busy until it is aborted. */
const BUSY_TURN: Step[] = [itemStarted(commandItem('exec-1')), { wait: 'interrupt' }]

interface BusyTurn {
  readonly running: Promise<NativePromptResult>
  settled(): boolean
  abort(): void
}

/** Starts a prompt whose turn stays busy until `abort()`; resolves once Codex was asked to run it. */
async function startBusyTurn(harness: Harness, text = 'long task'): Promise<BusyTurn> {
  const controller = new AbortController()
  let settled = false
  const running = harness.prompt(text, controller.signal).finally(() => {
    settled = true
  })
  await waitFor(() => harness.sent('turn/start').length >= 1)
  return { running, settled: () => settled, abort: () => controller.abort() }
}

describe('codex side questions (/side, /btw)', () => {
  const tokens = { totalTokens: 50, inputTokens: 40, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 }

  it('asks an ephemeral fork the way the TUI does while the main turn keeps running', async () => {
    const harness = await launch({
      config: {
        turns: [BUSY_TURN],
        developerInstructions: 'Answer in French.',
        side: [usageStep(tokens, tokens), ...messageSteps('side-1', 'It retries without backing off.')],
      },
    })
    const main = await startBusyTurn(harness)

    const result = await harness.side('why is it slow?')

    expect(result).toEqual({ kind: 'success', text: 'It retries without backing off.' })
    // The TUI's order: the fork, the hidden boundary message, the question; the fork is closed once it answered.
    // The main thread is neither steered nor interrupted.
    expect(
      harness.trace(['turn/start', 'thread/fork', 'thread/inject_items', 'turn/completed', 'thread/unsubscribe', 'turn/steer', 'turn/interrupt']),
    ).toEqual([
      '→ turn/start@thr_test',
      '→ thread/fork@thr_test',
      '→ thread/inject_items@thr_side',
      '→ turn/start@thr_side',
      '← turn/completed@thr_side',
      '→ thread/unsubscribe@thr_side',
    ])
    expect(paramsOf(harness.sent('thread/fork')[0])).toEqual({
      threadId: 'thr_test',
      ephemeral: true,
      excludeTurns: true,
      model: 'gpt-6-astra',
      modelProvider: 'fake-provider',
      cwd: harness.dir,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandbox: 'workspace-write',
      config: { features: { cwd_relative_turn_diffs: false }, projects: { [harness.dir]: { trust_level: 'trusted' } } },
      // The instructions the thread already has come first.
      developerInstructions: `Answer in French.\n\n${SIDE_DEVELOPER_INSTRUCTIONS}`,
      threadSource: 'user',
    })
    expect(paramsOf(harness.sent('thread/inject_items')[0])).toEqual({
      threadId: 'thr_side',
      items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: SIDE_BOUNDARY_PROMPT }] }],
    })
    expect(paramsOf(harness.sent('turn/start')[1])).toMatchObject({
      threadId: 'thr_side',
      input: [{ type: 'text', text: 'why is it slow?', text_elements: [] }],
      model: 'gpt-6-astra',
      effort: 'max',
    })
    // Nothing of the side conversation reaches the main one: no text, no context meter.
    expect(harness.updates('agent_message_chunk')).toEqual([])
    expect(harness.events.filter((event) => event.kind === 'context_usage')).toEqual([])
    expect(main.settled()).toBe(false)
    main.abort()
    await expect(main.running).resolves.toMatchObject({ stopReason: 'cancelled' })
  })

  it('declines whatever the fork asks approval for, never asks the user, and says so in the answer', async () => {
    const harness = await launch({
      elicit: () => accepted({ a: 'one' }),
      config: {
        side: [
          { r: 'item/commandExecution/requestApproval', p: { threadId: '$thread', turnId: '$turn', itemId: 'cmd-1', command: "/bin/zsh -lc 'rm -rf build'", cwd: '$cwd', commandActions: [] } },
          { r: 'item/fileChange/requestApproval', p: { threadId: '$thread', turnId: '$turn', itemId: 'patch-1' } },
          { r: 'item/permissions/requestApproval', p: { threadId: '$thread', turnId: '$turn', itemId: 'perm-1', cwd: '$cwd', permissions: { network: { enabled: true } } } },
          userInputStep,
          mcpFormStep,
          ...messageSteps('side-1', 'I could not change anything.'),
        ],
      },
    })

    const result = await harness.side('delete the build folder')

    const frames = harness.frames()
    // A decline refuses the action but lets the turn go on, which a cancel would end.
    expect(replyTo(frames, 9001)?.['result']).toEqual({ decision: 'decline' })
    expect(replyTo(frames, 9002)?.['result']).toEqual({ decision: 'decline' })
    expect(replyTo(frames, 9003)?.['result']).toEqual({ permissions: {}, scope: 'turn', strictAutoReview: false })
    expect(replyTo(frames, 9004)?.['result']).toEqual({ answers: {} })
    expect(replyTo(frames, 9005)?.['result']).toEqual({ action: 'decline', content: null, _meta: null })
    expect(harness.permissions).toEqual([])
    expect(harness.elicitations).toEqual([])
    expect(result.kind).toBe('success')
    expect(result.text).toContain('I could not change anything.')
    expect(result.text).toContain('Declined: run `rm -rf build`, change files, get extra permissions, ask you a question, ask a question through an MCP server')
  })

  it('refuses a question that is empty, has nothing to fork from, or meets a code review', async () => {
    const unstarted = await launch({ config: { forkError: 'no rollout found for thread id thr_test' } })
    expect(await unstarted.side('   ')).toEqual({ kind: 'error', text: SIDE_USAGE_MESSAGE })
    expect(unstarted.sent('thread/fork')).toHaveLength(0)
    // A conversation without a first turn cannot be forked. Nothing else is sent, and there is no fork to close.
    expect(await unstarted.side('why?')).toEqual({ kind: 'error', text: SIDE_NOT_STARTED_MESSAGE })
    expect(unstarted.trace(['thread/fork', 'thread/inject_items', 'turn/start', 'thread/unsubscribe'])).toEqual(['→ thread/fork@thr_test'])

    const broken = await launch({ config: { forkError: 'the disk is full' } })
    expect(await broken.side('why?')).toEqual({ kind: 'error', text: 'Failed to start side conversation: the disk is full' })

    const reviewing = await launch({ config: { review: [{ wait: 'interrupt' }] } })
    const controller = new AbortController()
    const review = reviewing.prompt('/review', controller.signal)
    await waitFor(() => reviewing.sent('review/start').length === 1)
    expect(await reviewing.side('why?')).toEqual({ kind: 'error', text: SIDE_REVIEW_RUNNING_MESSAGE })
    expect(reviewing.sent('thread/fork')).toHaveLength(0)
    controller.abort()
    await expect(review).resolves.toMatchObject({ stopReason: 'cancelled' })
  })

  it('allows one side question at a time and closes the fork of a cancelled one', async () => {
    const harness = await launch({ config: { side: [{ wait: 'interrupt' }] } })
    const first = new AbortController()
    const asking = harness.side('one', first.signal)
    await waitFor(() => harness.sent('turn/start').length === 1)
    expect(await harness.side('two')).toEqual({ kind: 'error', text: SIDE_ALREADY_RUNNING_MESSAGE })
    expect(harness.sent('thread/fork')).toHaveLength(1)

    first.abort()
    expect(await asking).toMatchObject({ kind: 'error', text: expect.stringContaining('cancelled') })
    // The turn still running on the fork is interrupted, then the fork is closed.
    expect(harness.trace(['turn/interrupt', 'thread/unsubscribe'])).toEqual(['→ turn/interrupt@thr_side', '→ thread/unsubscribe@thr_side'])
    expect(paramsOf(harness.sent('turn/interrupt')[0])).toEqual({ threadId: 'thr_side', turnId: 'turn_side' })

    // The next question is accepted again.
    const second = new AbortController()
    const again = harness.side('three', second.signal)
    await waitFor(() => harness.sent('turn/start').length === 2)
    second.abort()
    await again
  })

  it('returns without a fork when the question was cancelled before it started', async () => {
    const harness = await launch()
    const controller = new AbortController()
    controller.abort()
    expect(await harness.side('why?', controller.signal)).toMatchObject({ kind: 'error', text: expect.stringContaining('cancelled') })
    expect(harness.sent('thread/fork')).toHaveLength(0)
  })

  it('reports a fork that cannot be prepared, a turn that fails and a turn without an answer, and closes the fork each time', async () => {
    const preparing = await launch({ config: { injectError: 'items rejected' } })
    expect(await preparing.side('why?')).toMatchObject({ kind: 'error', text: expect.stringContaining('items rejected') })
    expect(preparing.sent('turn/start')).toHaveLength(0)
    expect(preparing.trace(['thread/unsubscribe'])).toEqual(['→ thread/unsubscribe@thr_side'])

    const limited = '{"type":"error","status":429,"error":{"type":"rate_limit_error","message":"Slow down"}}'
    const failing = await launch({ config: { side: [{ end: 'failed', error: { message: limited } }] } })
    expect(await failing.side('why?')).toEqual({ kind: 'error', text: 'Slow down' })
    // The turn ended by itself: there is nothing to interrupt.
    expect(failing.sent('turn/interrupt')).toHaveLength(0)
    expect(failing.trace(['thread/unsubscribe'])).toEqual(['→ thread/unsubscribe@thr_side'])

    const silent = await launch({ config: { side: [] } })
    expect(await silent.side('why?')).toMatchObject({ kind: 'error', text: expect.stringContaining('without an answer') })
    expect(silent.trace(['thread/unsubscribe'])).toEqual(['→ thread/unsubscribe@thr_side'])
  })

  it('rejects when the app-server is lost while a side question runs', async () => {
    const harness = await launch({ config: { side: [{ exit: 3, stderr: 'segfault detail' }] } })
    const error = await harness.side('why?').catch((failure: unknown) => failure)
    expect(nativeError(error).code).toBe('process-exit')
    expect(nativeError(error).detail).toContain('segfault detail')
  })
})

describe('codex side run collection', () => {
  it('answers with the final messages, and completes once the turn id and its completion are both known', () => {
    const run = new CodexSideRun()
    run.handle('item/started', { item: { type: 'agentMessage', id: 'c1', text: '', phase: 'commentary' } })
    run.handle('item/agentMessage/delta', { itemId: 'c1', delta: 'Let me look. ' })
    run.handle('item/agentMessage/delta', { itemId: 'f1', delta: 'The ans' })
    run.handle('item/completed', { item: { type: 'agentMessage', id: 'f1', text: 'The answer.', phase: 'final_answer' } })
    // The turn can complete before the response that names it arrives.
    run.handle('turn/completed', { turn: { id: 't1', status: 'completed', error: null } })
    expect(run.completed).toBe(false)
    run.identify('t1')
    expect(run.completed).toBe(true)
    expect(run.outcome()).toEqual({ status: 'completed', answer: 'The answer.', error: undefined, declined: [] })
  })

  it('falls back to every message when none is marked final, shows what streamed of an unfinished one, and keeps the last error', () => {
    const run = new CodexSideRun()
    run.identify('t1')
    run.handle('item/agentMessage/delta', { itemId: 'm1', delta: 'Half an ans' })
    run.handle('item/completed', { item: { type: 'agentMessage', id: 'm2', text: 'Second.' } })
    run.handle('error', { error: { message: 'Reconnecting' }, willRetry: true })
    run.handle('error', { error: { message: 'Stream ended' }, willRetry: false })
    run.handle('turn/completed', { turn: { id: 't1', status: 'failed', error: { message: 'Stream ended early' } } })
    expect(run.outcome()).toEqual({ status: 'failed', answer: 'Half an ans\n\nSecond.', error: 'Stream ended', declined: [] })
  })
})

describe('codex thread scoping', () => {
  const command = (threadId: string, itemId: string): Step => ({
    r: 'item/commandExecution/requestApproval',
    p: { threadId, turnId: 't', itemId, command: 'rm x', cwd: '$cwd', commandActions: [] },
  })

  it('declines the requests of threads it does not know, and keeps asking for the sub-agents of the conversation', async () => {
    const harness = await launch({
      config: {
        turns: [
          [
            command('thr_stranger', 'x1'),
            { r: 'applyPatchApproval', p: { conversationId: 'thr_stranger', callId: 'x2', fileChanges: {} } },
            { n: 'thread/started', p: { thread: { id: 'thr_child', parentThreadId: '$thread' } } },
            command('thr_child', 'c1'),
            { n: 'thread/started', p: { thread: { id: 'thr_grandchild', parentThreadId: 'thr_child' } } },
            { r: 'item/fileChange/requestApproval', p: { threadId: 'thr_grandchild', turnId: 't', itemId: 'g1' } },
            command('$thread', 'm1'),
            ...messageSteps('msg-1', 'done'),
          ],
        ],
      },
    })

    expect((await harness.prompt('go')).stopReason).toBe('end_turn')

    const frames = harness.frames()
    // A stranger is refused without a word to the user, and its turn (which a cancel would end) goes on.
    expect(replyTo(frames, 9001)?.['result']).toEqual({ decision: 'decline' })
    expect(replyTo(frames, 9002)?.['result']).toEqual({ decision: 'denied' })
    expect(harness.logs.join('\n')).toContain('thr_stranger')
    // The conversation's own sub-agents, and theirs, are the user's to answer for.
    expect(harness.permissions.map((request) => request.toolCall.toolCallId)).toEqual(['c1', 'g1', 'm1'])
    for (const id of [9003, 9004, 9005]) expect(replyTo(frames, id)?.['result']).toEqual({ decision: 'accept' })
  })
})

describe('codex slash commands typed as prompts', () => {
  it('answers a Codex terminal command locally instead of letting it cost a model turn', async () => {
    const harness = await launch()
    const names = Object.keys(CODEX_UNSUPPORTED_COMMANDS)
    expect(names.length).toBeGreaterThan(40)
    for (const name of names) {
      const before = harness.updates('agent_message_chunk').length
      expect((await harness.prompt(`/${name.toUpperCase()} some arguments`)).stopReason, name).toBe('end_turn')
      expect(harness.updates('agent_message_chunk'), name).toHaveLength(before + 1)
      expect(lastText(harness), name).toContain(`/${name}`)
    }
    expect(harness.sent('turn/start')).toHaveLength(0)
  })

  it('sends /init as the prompt Codex ships, and /init with arguments is not sent at all', async () => {
    const harness = await launch()
    await harness.prompt('/init')
    expect(paramsOf(harness.sent('turn/start')[0])['input']).toEqual([{ type: 'text', text: INIT_PROMPT, text_elements: [] }])
    // The shipped asset is 1836 bytes long and opens with this sentence.
    expect(Buffer.byteLength(INIT_PROMPT)).toBe(1836)
    expect(INIT_PROMPT.startsWith('Generate a file named AGENTS.md that serves as a contributor guide for this repository.\n')).toBe(true)
    await harness.prompt('/init please')
    expect(harness.sent('turn/start')).toHaveLength(1)
    expect(lastText(harness)).toContain('requires no arguments')
  })

  it('runs a skill typed as a command with the structured skill item, but not a disabled or an unknown one', async () => {
    const harness = await launch({
      config: {
        skills: [
          { name: 'deploy', description: 'Deploy', path: '/skills/deploy/SKILL.md', enabled: true },
          { name: 'retired', description: 'Off', path: '/skills/retired/SKILL.md', enabled: false },
        ],
      },
    })
    await harness.prompt('/deploy to staging')
    await harness.prompt('/DEPLOY')
    await harness.transport.prompt(
      [{ type: 'text', text: '/deploy with a picture' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }],
      new AbortController().signal,
    )
    await harness.prompt('/retired now')
    const skill = { type: 'skill', name: 'deploy', path: '/skills/deploy/SKILL.md' }
    expect(harness.sent('turn/start').map((frame) => paramsOf(frame)['input'])).toEqual([
      [{ type: 'text', text: '$deploy to staging', text_elements: [] }, skill],
      [{ type: 'text', text: '$deploy', text_elements: [] }, skill],
      [{ type: 'text', text: '$deploy with a picture', text_elements: [] }, { type: 'image', url: 'data:image/png;base64,AAAA' }, skill],
      [{ type: 'text', text: '/retired now', text_elements: [] }],
    ])
  })
})

describe('codex immediate commands', () => {
  it('shows /status as the TUI does, with the limits and the usage of a ChatGPT account', async () => {
    const harness = await launch({
      config: {
        thread: { name: 'Fix the build', forkedFromId: 'thr_parent', modelProvider: 'openai' },
        account: { type: 'chatgpt', planType: 'plus', email: 'dev@example.com' },
        instructionSources: ['$cwd/AGENTS.md', '/etc/codex/AGENTS.md'],
        rateLimits: {
          rateLimits: {
            primary: { usedPercent: 12.4, windowDurationMins: 300, resetsAt: 1_800_000_000 },
            secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: null },
          },
        },
        accountUsage: { summary: {}, threadUsage: { estimatedUsageCreditsMicros: 2_500_000, estimatedUsageUsdMicros: 130_000 } },
      },
    })

    const result = await harness.run('status')

    expect(result.kind).toBe('success')
    for (const row of [
      '**Model:** gpt-6-astra (reasoning max, summaries auto)',
      '**Model provider:** openai',
      `**Directory:** ${harness.dir}`,
      '**Permissions:** Auto review (approval on-request, sandbox workspace-write)',
      '**Agents.md:** AGENTS.md, /etc/codex/AGENTS.md',
      '**Account:** ChatGPT plus (dev@example.com)',
      '**Thread name:** Fix the build',
      '**Collaboration mode:** default',
      '**Session:** `thr_test`',
      '**Forked from:** `thr_parent`',
      '**Token usage:** data not available yet',
      '**Context window:** data not available yet',
      '**Limits:** 5h limit: 12% used, resets 2027-01-15 08:00 UTC · Weekly limit: 40% used',
      '**Thread usage:** about $0.13 / 2.50 credits',
    ]) {
      expect(result.text).toContain(row)
    }
    expect(paramsOf(harness.sent('account/rateLimits/read')[0])).toEqual({ supportsLunaReserve: true, excludeResetCreditDetails: false })
    expect(paramsOf(harness.sent('account/usage/read')[0])).toEqual({ threadId: 'thr_test' })
  })

  it('answers /status while a turn runs, without a model call and without account lookups for a gateway', async () => {
    const harness = await launch({ config: { turns: [BUSY_TURN] } })
    const main = await startBusyTurn(harness)

    const result = await harness.run('status')

    expect(result.kind).toBe('success')
    expect(result.text).toContain('**Limits:** data not available yet')
    expect(harness.sent('turn/start')).toHaveLength(1)
    expect(harness.sent('account/rateLimits/read')).toHaveLength(0)
    expect(harness.sent('account/usage/read')).toHaveLength(0)
    expect(main.settled()).toBe(false)
    main.abort()
    await main.running
  })

  it('lists the skills with their short descriptions, and turns one on or off by its file', async () => {
    const harness = await launch({
      config: {
        skills: [
          { name: 'deploy', description: 'A very long description for the model', path: '/skills/deploy/SKILL.md', enabled: true, interface: { shortDescription: 'Deploy it' } },
          { name: 'lint', description: 'Lint all', path: '/skills/lint/SKILL.md', enabled: false },
        ],
        skillErrors: [{ path: '/skills/bad/SKILL.md', message: 'invalid yaml' }],
      },
    })
    await waitFor(() => harness.catalogs().length >= 2)
    const advertised = (): string[] => (harness.catalogs().at(-1) ?? []).map((command) => command.name)
    expect(advertised()).toContain('deploy')
    expect(advertised()).not.toContain('lint')

    const listing = await harness.run('skills')
    expect(listing.kind).toBe('success')
    expect(listing.text).toContain('1 enabled, 1 disabled')
    expect(listing.text).toContain('- `deploy` — Deploy it')
    expect(listing.text).toContain('- `lint` — Lint all _(disabled)_')
    expect(listing.text).toContain('`/skills/bad/SKILL.md`: invalid yaml')
    expect(paramsOf(harness.sent('skills/list').at(-1))).toEqual({ cwds: [harness.dir], forceReload: true })

    expect(await harness.run('skills', 'disable deploy')).toMatchObject({ kind: 'success', text: expect.stringContaining('disabled') })
    expect(paramsOf(harness.sent('skills/config/write')[0])).toEqual({ path: '/skills/deploy/SKILL.md', enabled: false })
    expect(advertised()).not.toContain('deploy')
    expect(await harness.run('skills', 'enable lint')).toMatchObject({ kind: 'success' })
    expect(paramsOf(harness.sent('skills/config/write')[1])).toEqual({ path: '/skills/lint/SKILL.md', enabled: true })
    expect(advertised()).toContain('lint')

    expect(await harness.run('skills', 'enable nope')).toMatchObject({ kind: 'error', text: expect.stringContaining('nope') })
    expect(await harness.run('skills', 'toggle deploy')).toMatchObject({ kind: 'error', text: expect.stringContaining('Usage') })
    expect(harness.sent('skills/config/write')).toHaveLength(2)
  })

  it('reports a skill toggle that the Codex configuration overrides as an error', async () => {
    const harness = await launch({
      config: { skillsLocked: true, skills: [{ name: 'lint', description: 'Lint all', path: '/skills/lint/SKILL.md', enabled: false }] },
    })
    expect(await harness.run('skills', 'enable lint')).toMatchObject({ kind: 'error', text: expect.stringContaining('stays disabled') })
  })

  const mcpServers = [
    {
      name: 'docs',
      runtimeStatus: 'connected',
      authStatus: 'oAuth',
      tools: { search: { name: 'search', inputSchema: {} }, fetch: { name: 'fetch', inputSchema: {} } },
      toolsError: null,
      resources: [{ name: 'readme', uri: 'file:///r', title: 'Read me' }],
      resourceTemplates: [{ name: 't', uriTemplate: 'file:///{p}' }],
    },
    { name: 'db', runtimeStatus: 'authenticationRequired', authStatus: 'notLoggedIn', tools: {}, toolsError: null, resources: [], resourceTemplates: [] },
    { name: 'bad', runtimeStatus: 'failed', authStatus: 'unknown', tools: {}, toolsError: 'spawn ENOENT', resources: [], resourceTemplates: [] },
  ]

  it('lists the MCP servers over every page, and their tools and resources in the verbose form', async () => {
    const harness = await launch({ config: { mcpServers, mcpPageSize: 2 } })

    const plain = await harness.run('mcp')

    expect(harness.sent('mcpServerStatus/list').map((frame) => paramsOf(frame))).toEqual([
      { cursor: null, limit: 100, detail: 'toolsAndAuthOnly', threadId: 'thr_test', serverName: null },
      { cursor: '2', limit: 100, detail: 'toolsAndAuthOnly', threadId: 'thr_test', serverName: null },
    ])
    expect(plain.kind).toBe('success')
    expect(plain.text).toContain('- `docs` — connected (2 tools)')
    expect(plain.text).toContain('- `db` — authentication required')
    expect(plain.text).toContain('- `bad` — failed')
    expect(plain.text).toContain('/mcp verbose')
    expect(plain.text).not.toContain('Tools:')

    const verbose = await harness.run('mcp', 'verbose')
    expect(paramsOf(harness.sent('mcpServerStatus/list')[2])).toMatchObject({ detail: 'full' })
    for (const row of [
      'Auth: OAuth',
      'Tools: fetch, search',
      'Resources: Read me (file:///r)',
      'Resource templates: t (file:///{p})',
      'Auth: not logged in',
      'Tools could not be listed: spawn ENOENT',
    ]) {
      expect(verbose.text).toContain(row)
    }
    expect(await harness.run('mcp', 'frobnicate')).toEqual({ kind: 'error', text: 'Usage: /mcp [verbose | login <name>]' })
  })

  it('gives the link to sign in to an MCP server, and nothing but a web link', async () => {
    const harness = await launch({ config: { mcpServers } })
    const login = await harness.run('mcp', 'login docs')
    expect(paramsOf(harness.sent('mcpServer/oauth/login')[0])).toEqual({
      name: 'docs',
      threadId: 'thr_test',
      clientRegistration: null,
      scopes: null,
      timeoutSecs: null,
    })
    expect(login).toMatchObject({ kind: 'success', text: expect.stringContaining('<https://auth.example.com/login?x=1>') })

    const unsafe = await launch({ config: { oauthUrl: 'javascript:alert(1)' } })
    expect(await unsafe.run('mcp', 'login docs')).toMatchObject({ kind: 'error', text: expect.stringContaining('did not return a link') })
  })

  const terminals = [
    { itemId: 'i1', processId: 'p-1', command: "/bin/zsh -lc 'npm run dev'", cwd: '/w', osPid: 4242, cpuPercent: 3.14, rssKb: 204_800 },
  ]

  it('lists the background terminals and stops all of them or one', async () => {
    const harness = await launch({ config: { terminals } })

    const listing = await harness.run('ps')
    expect(paramsOf(harness.sent('thread/backgroundTerminals/list')[0])).toEqual({ threadId: 'thr_test', cursor: null, limit: null })
    expect(listing.text).toContain("- `/bin/zsh -lc 'npm run dev'` — process `p-1`, pid 4242, 3.1% CPU, 200 MB")
    expect((await (await launch()).run('ps')).text).toContain('No background terminals running.')

    expect(await harness.run('stop')).toMatchObject({ kind: 'success' })
    expect(paramsOf(harness.sent('thread/backgroundTerminals/clean')[0])).toEqual({ threadId: 'thr_test' })
    // `clean` is Codex's other name for `stop`.
    expect(await harness.run('clean')).toMatchObject({ kind: 'success' })
    expect(harness.sent('thread/backgroundTerminals/clean')).toHaveLength(2)

    expect(await harness.run('stop', 'p-1')).toMatchObject({ kind: 'success' })
    expect(paramsOf(harness.sent('thread/backgroundTerminals/terminate')[0])).toEqual({ threadId: 'thr_test', processId: 'p-1' })
    expect(await harness.run('stop', 'p-9')).toMatchObject({ kind: 'error', text: expect.stringContaining('p-9') })
  })

  it('lists the hooks by event with their trust status and the problems Codex found', async () => {
    const harness = await launch({
      config: {
        hooks: {
          cwd: '/w',
          hooks: [
            { key: 'k1', eventName: 'preToolUse', matcher: 'Bash', handlerType: 'command', command: './check.sh', source: 'project', enabled: true, trustStatus: 'trusted' },
            { key: 'k2', eventName: 'preToolUse', matcher: null, handlerType: 'mcpTool', server: 'guard', tool: 'scan', source: 'user', enabled: false, trustStatus: 'modified' },
            { key: 'k3', eventName: 'stop', matcher: null, handlerType: 'prompt', source: 'plugin', enabled: true, trustStatus: 'untrusted' },
          ],
          warnings: ['stale cache'],
          errors: [{ path: '/h.toml', message: 'bad key' }],
        },
      },
    })
    const result = await harness.run('hooks')
    expect(paramsOf(harness.sent('hooks/list')[0])).toEqual({ cwds: [harness.dir] })
    expect(result.kind).toBe('success')
    for (const row of [
      '3 configured',
      '**preToolUse**',
      '- `Bash` → `./check.sh` — project · trusted',
      '- (all) → MCP tool `guard.scan` — user · modified since last trusted — review required · disabled',
      '**stop**',
      '- (all) → prompt hook — plugin · new hook — review required',
      '- stale cache',
      '- `/h.toml`: bad key',
    ]) {
      expect(result.text).toContain(row)
    }
  })

  const gitDiff = 'diff --no-textconv --no-ext-diff --submodule=short --ignore-submodules=dirty'
  const gitPrefix = ['git', '-c', 'safe.bareRepository=explicit', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null']

  it('shows the workspace diff with the tracked changes and the untracked files, computed by git the way the TUI runs it', async () => {
    const harness = await launch({
      config: {
        exec: [
          { starts: 'rev-parse', result: { exitCode: 0, stdout: 'true\n', stderr: '' } },
          { starts: 'config', result: { exitCode: 0, stdout: 'filter.lfs.clean\0filter.lfs.process\0filter.x.clean\0', stderr: '' } },
          { starts: `${gitDiff} --no-index`, result: { exitCode: 1, stdout: 'diff --git a/new.txt b/new.txt\n+++ b/new.txt\n+hello\n', stderr: '' } },
          { starts: gitDiff, result: { exitCode: 1, stdout: 'diff --git a/a.ts b/a.ts\n-old\n+new\n', stderr: '' } },
          { starts: 'ls-files', result: { exitCode: 0, stdout: 'new.txt\n', stderr: '' } },
        ],
      },
    })

    const result = await harness.run('diff')

    expect(result).toEqual({
      kind: 'success',
      text: '```diff\ndiff --git a/a.ts b/a.ts\n-old\n+new\ndiff --git a/new.txt b/new.txt\n+++ b/new.txt\n+hello\n```',
    })
    const executed = harness.sent('command/exec').map((frame) => paramsOf(frame))
    // No repository hook, fsmonitor or bare-repository trick may run, in the directory of the session.
    for (const params of executed) {
      expect(params['command']).toEqual(expect.arrayContaining(gitPrefix))
      expect(Array.isArray(params['command']) ? params['command'].slice(0, gitPrefix.length) : []).toEqual(gitPrefix)
      expect(params).toMatchObject({ cwd: harness.dir, timeoutMs: 30_000 })
    }
    expect(executed.map((params) => (Array.isArray(params['command']) ? params['command'].slice(gitPrefix.length).join(' ') : ''))).toEqual([
      'rev-parse --is-inside-work-tree',
      'config --null --name-only --get-regexp ^filter\\..*\\.(clean|process)$',
      gitDiff,
      'ls-files --others --exclude-standard',
      `${gitDiff} --no-index -- /dev/null new.txt`,
    ])
    // The filter drivers a repository configures are blanked so that showing a diff cannot run them.
    const filters = {
      GIT_CONFIG_COUNT: '6',
      GIT_CONFIG_KEY_0: 'filter.lfs.clean',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'filter.lfs.process',
      GIT_CONFIG_VALUE_1: '',
      GIT_CONFIG_KEY_2: 'filter.lfs.required',
      GIT_CONFIG_VALUE_2: 'false',
      GIT_CONFIG_KEY_3: 'filter.x.clean',
      GIT_CONFIG_VALUE_3: '',
      GIT_CONFIG_KEY_4: 'filter.x.process',
      GIT_CONFIG_VALUE_4: '',
      GIT_CONFIG_KEY_5: 'filter.x.required',
      GIT_CONFIG_VALUE_5: 'false',
    }
    expect(executed[2]?.['env']).toEqual(filters)
    expect(executed[4]?.['env']).toEqual(filters)
  })

  it('says so when /diff has nothing to show, outside a repository, or when git fails', async () => {
    const clean = await launch()
    expect(await clean.run('diff')).toEqual({ kind: 'success', text: 'No changes detected.' })

    const outside = await launch({ config: { exec: [{ starts: 'rev-parse', result: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' } }] } })
    expect(await outside.run('diff')).toMatchObject({ kind: 'success', text: expect.stringContaining('Not inside a git repository') })
    expect(outside.sent('command/exec')).toHaveLength(1)

    const failing = await launch({ config: { exec: [{ starts: gitDiff, result: { exitCode: 129, stdout: '', stderr: 'usage: git diff' } }] } })
    expect(await failing.run('diff')).toMatchObject({ kind: 'error', text: expect.stringContaining('git diff failed with status 129: usage: git diff') })

    const cancelled = new AbortController()
    cancelled.abort()
    expect(await clean.run('diff', '', cancelled.signal)).toMatchObject({ kind: 'error', text: expect.stringContaining('cancelled') })
    expect(clean.sent('command/exec')).toHaveLength(4)
  })

  it('starts a fresh thread for /clear and /new with the controls of the conversation, and announces the change', async () => {
    const harness = await launch({
      config: {
        startIds: ['thr_test', 'thr_second', 'thr_third'],
        turns: [
          [usageStep({ totalTokens: 10 }, { totalTokens: 10 }), ...messageSteps('m1', 'first')],
          // A late event of the old thread is not this conversation's any more.
          [{ n: 'item/agentMessage/delta', p: { threadId: 'thr_test', turnId: 'x', itemId: 'stray', delta: 'old thread' } }, ...messageSteps('m2', 'second')],
        ],
      },
    })
    await harness.transport.setConfigOption('model', 'gpt-5.6-sol')
    await harness.transport.setConfigOption('reasoning_effort', 'ultra')
    await harness.transport.setConfigOption('fast-mode', 'on')
    await harness.prompt('hello')

    const cleared = await harness.run('clear', 'Fresh start')

    expect(cleared.kind).toBe('success')
    expect(cleared.text).toContain('thr_second')
    expect(harness.transport.sessionId).toBe('thr_second')
    expect(harness.events).toContainEqual({ kind: 'session_changed', sessionId: 'thr_second', reason: 'clear' })
    expect(paramsOf(harness.sent('thread/start')[1])).toEqual({
      config: { features: { cwd_relative_turn_diffs: false }, projects: { [harness.dir]: { trust_level: 'trusted' } } },
      modelProvider: null,
      cwd: harness.dir,
      sessionStartSource: 'clear',
    })
    // A review or a compaction does not carry its own model, so the thread gets the controls' values.
    expect(paramsOf(harness.sent('thread/settings/update').at(-1))).toMatchObject({
      threadId: 'thr_second',
      model: 'gpt-5.6-sol',
      effort: 'ultra',
      serviceTier: 'fast',
    })
    expect(paramsOf(harness.sent('thread/name/set').at(-1))).toEqual({ threadId: 'thr_second', name: 'Fresh start' })
    await waitFor(() => harness.sent('thread/unsubscribe').length === 1)
    expect(paramsOf(harness.sent('thread/unsubscribe')[0])).toEqual({ threadId: 'thr_test' })
    // The context meter starts again.
    expect(harness.events.filter((event) => event.kind === 'context_usage').at(-1)).toEqual({
      kind: 'context_usage',
      contextUsage: { used: 0, size: 200_000 },
    })

    await harness.prompt('again')
    expect(paramsOf(harness.sent('turn/start')[1])).toMatchObject({ threadId: 'thr_second', model: 'gpt-5.6-sol' })
    expect(harness.updates('agent_message_chunk').map(chunkText)).toEqual(['first', 'second'])

    expect((await harness.run('new')).kind).toBe('success')
    expect(harness.transport.sessionId).toBe('thr_third')
    expect(paramsOf(harness.sent('thread/start')[2])).not.toHaveProperty('sessionStartSource')
    expect(harness.events).toContainEqual({ kind: 'session_changed', sessionId: 'thr_third', reason: 'new' })
  })

  it('puts the new thread in the collaboration mode of the conversation', async () => {
    const harness = await launch({
      session: { kind: 'resume', sessionId: 'thr_plan' },
      config: { thread: { collaborationMode: 'plan' }, startIds: ['thr_next'] },
    })
    expect((await harness.run('new')).kind).toBe('success')
    expect(paramsOf(harness.sent('thread/settings/update').at(-1))).toMatchObject({
      threadId: 'thr_next',
      collaborationMode: { mode: 'plan' },
    })
  })

  it('refuses /new while a turn runs, and keeps the conversation when the new thread cannot be started', async () => {
    const harness = await launch({ config: { turns: [BUSY_TURN], startError: 'thread limit reached' } })
    const main = await startBusyTurn(harness)

    expect(await harness.run('new')).toMatchObject({ kind: 'error', text: expect.stringContaining('task is in progress') })
    expect(harness.sent('thread/start')).toHaveLength(1)
    expect(main.settled()).toBe(false)
    main.abort()
    await main.running

    expect(await harness.run('new')).toMatchObject({ kind: 'error', text: expect.stringContaining('thread limit reached') })
    expect(harness.transport.sessionId).toBe('thr_test')
    expect(harness.events.filter((event) => event.kind === 'session_changed')).toEqual([])
    // Nothing is left stuck: the conversation goes on, and the command can be tried again.
    await harness.prompt('still here')
    expect(paramsOf(harness.sent('turn/start').at(-1))).toMatchObject({ threadId: 'thr_test' })
    expect((await harness.run('new')).kind).toBe('error')
    expect(harness.sent('thread/start')).toHaveLength(3)
  })

  it('turns a failed request into an error row, and rejects once the app-server is gone', async () => {
    const harness = await launch({
      config: { requestErrors: { 'hooks/list': 'hooks are disabled' }, turns: [[{ exit: 3, stderr: 'boom' }]] },
    })
    expect(await harness.run('hooks')).toMatchObject({ kind: 'error', text: expect.stringContaining('hooks are disabled') })
    expect(await harness.run('bogus')).toMatchObject({ kind: 'error' })

    await harness.prompt('go').catch(() => undefined)
    await expect(harness.run('status')).rejects.toBeInstanceOf(NativeTransportError)
    await expect(harness.side('why?')).rejects.toBeInstanceOf(NativeTransportError)
  })
})

describe('codex shell escape (!cmd)', () => {
  const shellItem = (extra: Record<string, unknown> = {}): Record<string, unknown> =>
    commandItem('sh-1', {
      source: 'userShell',
      processId: null,
      command: "/bin/zsh -lc 'ls src'",
      // Codex parses the command; a typed one is shown as typed all the same.
      commandActions: [{ type: 'listFiles', command: 'ls src', path: 'src' }],
      ...extra,
    })

  it('runs !cmd as the user shell command without a model turn, and shows it as a terminal', async () => {
    const harness = await launch({
      config: {
        shell: [
          itemStarted(shellItem()),
          note('item/commandExecution/outputDelta', { itemId: 'sh-1', delta: 'a.ts\n' }),
          itemCompleted(shellItem({ status: 'completed', aggregatedOutput: 'a.ts\n', exitCode: 0, durationMs: 4 })),
        ],
      },
    })

    expect((await harness.prompt('!ls src')).stopReason).toBe('end_turn')

    expect(paramsOf(harness.sent('thread/shellCommand')[0])).toEqual({ threadId: 'thr_test', command: 'ls src' })
    expect(harness.sent('turn/start')).toHaveLength(0)
    expect(harness.trace(['thread/shellCommand', 'turn/started', 'turn/completed'])).toEqual([
      '→ thread/shellCommand@thr_test',
      '← turn/started@thr_test',
      '← turn/completed@thr_test',
    ])
    expect(harness.updates('tool_call')[0]).toMatchObject({ kind: 'execute', title: 'ls src', content: [{ type: 'terminal', terminalId: 'sh-1' }] })
    expect(harness.updates('tool_call_update').at(-1)).toMatchObject({ toolCallId: 'sh-1', status: 'completed' })
    // The command row says it all; a success needs no words.
    expect(harness.updates('agent_message_chunk')).toEqual([])
  })

  it('says how a failed !cmd ended, because its failed row alone would read as no answer', async () => {
    const harness = await launch({
      config: {
        shell: [itemStarted(shellItem()), itemCompleted(shellItem({ status: 'failed', aggregatedOutput: 'ls: src: No such file\n', exitCode: 2 }))],
      },
    })
    expect((await harness.prompt('!ls src')).stopReason).toBe('end_turn')
    expect(harness.updates('tool_call_update').at(-1)).toMatchObject({ toolCallId: 'sh-1', status: 'failed' })
    expect(lastText(harness)).toContain('Exit code 2')
  })

  it('explains a bare !, and leaves a ! message that carries an attachment to the model', async () => {
    const harness = await launch()
    await harness.prompt('!')
    expect(lastText(harness)).toContain('Prefix a command with !')
    expect(harness.sent('thread/shellCommand')).toHaveLength(0)
    expect(harness.sent('turn/start')).toHaveLength(0)

    await harness.transport.prompt(
      [{ type: 'text', text: '!ls what is this?' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }],
      new AbortController().signal,
    )
    expect(harness.sent('thread/shellCommand')).toHaveLength(0)
    expect(paramsOf(harness.sent('turn/start')[0])['input']).toEqual([
      { type: 'text', text: '!ls what is this?', text_elements: [] },
      { type: 'image', url: 'data:image/png;base64,AAAA' },
    ])
  })

  it('interrupts a !cmd that is still running when the prompt is cancelled', async () => {
    const harness = await launch({ config: { shell: [itemStarted(shellItem()), { wait: 'interrupt' }] } })
    const controller = new AbortController()
    const running = harness.prompt('!sleep 60', controller.signal)
    await waitFor(() => harness.trace(['turn/started']).length === 1)
    controller.abort()
    await expect(running).resolves.toMatchObject({ stopReason: 'cancelled' })
    expect(paramsOf(harness.sent('turn/interrupt')[0])).toEqual({ threadId: 'thr_test', turnId: 'turn_shell' })
  })

  it('injects a ! line or a slash line steered into a running turn as text, and never answers promptRequired for it', async () => {
    const harness = await launch({ config: { turns: [[itemStarted(commandItem('exec-1')), { wait: 'steer' }, { wait: 'interrupt' }]] } })
    const main = await startBusyTurn(harness)
    expect(await harness.transport.steer(say('!rm -rf build'))).toBe('injected')
    expect(await harness.transport.steer(say('/btw why?'))).toBe('injected')
    expect(harness.sent('thread/shellCommand')).toHaveLength(0)
    expect(harness.sent('thread/fork')).toHaveLength(0)
    expect(harness.sent('turn/steer').map((frame) => paramsOf(frame)['input'])).toEqual([
      [{ type: 'text', text: '!rm -rf build', text_elements: [] }],
      [{ type: 'text', text: '/btw why?', text_elements: [] }],
    ])
    main.abort()
    await main.running
  })
})

describe('codex quiet notices', () => {
  it('shows the notices the TUI keeps quiet as thought notes inside the turn, and not the routine ones', async () => {
    const harness = await launch({
      config: {
        turns: [
          [
            note('hook/completed', { run: { id: 'h1', eventName: 'preToolUse', status: 'blocked', statusMessage: null, entries: [{ kind: 'stop', text: 'policy says no' }, { kind: 'context', text: 'for the model' }] } }),
            note('hook/completed', { run: { id: 'h2', eventName: 'sessionStart', status: 'completed', statusMessage: null, entries: [{ kind: 'context', text: 'quiet' }] } }),
            note('hook/completed', { run: { id: 'h3', eventName: 'postToolUse', status: 'completed', statusMessage: null, entries: [{ kind: 'warning', text: 'slow hook' }] } }),
            note('hook/completed', { run: { id: 'h4', eventName: 'stop', status: 'failed', statusMessage: 'exit 1', entries: [] } }),
            { n: 'deprecationNotice', p: { summary: 'old flag', details: 'use the new one' } },
            { n: 'guardianWarning', p: { threadId: '$thread', message: 'Automatic approval review approved (low risk)' } },
            { n: 'guardianWarning', p: { threadId: '$thread', message: 'risky action noticed' } },
            { n: 'mcpServer/startupStatus/updated', p: { threadId: null, name: 'docs', status: 'failed', error: 'spawn ENOENT', failureReason: null } },
            { n: 'mcpServer/startupStatus/updated', p: { threadId: null, name: 'db', status: 'failed', error: null, failureReason: 'reauthenticationRequired' } },
            { n: 'mcpServer/startupStatus/updated', p: { threadId: null, name: 'ok', status: 'ready', error: null, failureReason: null } },
            ...messageSteps('msg-1', 'done'),
          ],
        ],
      },
    })

    await harness.prompt('go')

    expect(harness.updates('agent_thought_chunk').map(chunkText)).toEqual([
      'Blocked by hook (preToolUse): policy says no\n\n',
      'Hook (postToolUse): slow hook\n\n',
      'Hook failed (stop): exit 1\n\n',
      'Deprecated: old flag — use the new one\n\n',
      'Auto-review warning: risky action noticed\n\n',
      'MCP server docs failed to start: spawn ENOENT\n\n',
      'MCP server db needs to be signed in again (/mcp login db).\n\n',
    ])
    // The answer stays the answer.
    expect(harness.updates('agent_message_chunk').map(chunkText)).toEqual(['done'])
  })

  it('keeps a notice out of the transcript when no turn is running', async () => {
    const harness = await launch({
      config: { after: { 'skills/list': [{ n: 'deprecationNotice', p: { summary: 'old flag', details: null } }] } },
    })
    await waitFor(() => harness.events.some((event) => event.kind === 'notice'))
    expect(harness.events).toContainEqual({ kind: 'notice', text: 'Deprecated: old flag' })
    expect(harness.updates('agent_thought_chunk')).toEqual([])
  })
})

describe('codex diff rendering', () => {
  it('fences a diff with more backticks than it contains, and cuts a long one at a line', () => {
    const body = ['diff --git a/x b/x', '+```js', '+const a = 1', '+```'].join('\n')
    expect(fencedDiff(body, 1000)).toBe(`\`\`\`\`diff\n${body}\n\`\`\`\``)

    const long = Array.from({ length: 100 }, (_, index) => `+line ${String(index)}`).join('\n')
    const cut = fencedDiff(long, 200)
    expect(cut.startsWith('```diff\n+line 0\n')).toBe(true)
    expect(cut).toMatch(/The diff is cut here: \d+ more lines/)
    expect(cut.split('\n').length).toBeLessThan(40)
  })
})

describe('codex goal command line and notes', () => {
  const goal = (extra: Partial<CodexGoal> = {}): CodexGoal => ({ objective: 'ship the release', status: 'active', tokenBudget: undefined, tokensUsed: 0, timeUsedSeconds: 0, ...extra })

  it('reads the command line the way the TUI does: control words in any case, anything else is the objective', () => {
    expect(parseGoalArgs('')).toEqual({ action: 'show' })
    expect(parseGoalArgs('  CLEAR ')).toEqual({ action: 'clear' })
    expect(parseGoalArgs('Pause')).toEqual({ action: 'pause' })
    expect(parseGoalArgs('resume')).toEqual({ action: 'resume' })
    expect(parseGoalArgs('  clear the cache, then ship  ')).toEqual({ action: 'set', objective: 'clear the cache, then ship' })
    // `edit` opens the terminal editor, which DSH has not.
    expect(parseGoalArgs('edit')).toMatchObject({ action: 'usage' })
  })

  it('reads a goal only when it has an objective and a status, and fills in what is missing', () => {
    expect(parseGoal({ objective: 'x' })).toBeUndefined()
    expect(parseGoal(null)).toBeUndefined()
    expect(parseGoal({ objective: 'x', status: 'paused' })).toEqual({ objective: 'x', status: 'paused', tokenBudget: undefined, tokensUsed: 0, timeUsedSeconds: 0 })
  })

  it('tells a new objective, a new status and a cleared goal, and keeps quiet about the token counters and about a goal that was already done', () => {
    expect(goalNote(undefined, goal())).toBe('Goal active: ship the release')
    expect(goalNote(goal(), goal({ tokensUsed: 5_000, timeUsedSeconds: 30 }))).toBeUndefined()
    expect(goalNote(goal(), goal({ status: 'paused' }))).toBe('Goal paused: ship the release')
    expect(goalNote(goal(), goal({ status: 'complete', tokensUsed: 12_300, timeUsedSeconds: 240 }))).toBe('Goal complete (12.3K tokens · 4m): ship the release')
    expect(goalNote(goal(), goal({ status: 'budgetLimited', tokenBudget: 50_000, tokensUsed: 50_100 }))).toContain('limited by its token budget (50.1K / 50K tokens)')
    expect(goalNote(undefined, goal({ status: 'complete' }))).toBeUndefined()
    expect(goalNote(goal(), undefined)).toBe('Goal cleared.')
    expect(goalNote(undefined, undefined)).toBeUndefined()
  })

  it('shows a goal with what it has used against its budget, and explains the two failures a user can fix', () => {
    expect(formatGoal(goal({ status: 'paused', tokenBudget: 50_000, tokensUsed: 12_300, timeUsedSeconds: 240 }))).toBe(
      '**Goal** — paused\n\n> ship the release\n\n12.3K / 50K tokens · 4m',
    )
    expect(goalFailure(new CodexRpcError('goals feature is disabled', -32600))).toContain('features.goals')
    expect(goalFailure(new CodexRpcError('ephemeral thread does not support goals', -32600))).toContain('temporary')
    expect(goalFailure(new CodexRpcError('boom', -32600))).toContain('boom')
  })
})

/** Files in memory: the state of the disk a restore is planned against and applied to. */
function memoryFiles(initial: Record<string, string>): RestoreIo & { readonly files: Map<string, string> } {
  const files = new Map(Object.entries(initial))
  return {
    files,
    read: async (path): Promise<DiskFile> => {
      const content = files.get(path)
      return content === undefined ? { kind: 'absent' } : { kind: 'text', content }
    },
    write: async (path, content) => {
      files.set(path, content)
    },
    remove: async (path) => {
      files.delete(path)
    },
  }
}

describe('codex rewind command line and checkpoints', () => {
  it('reads /rewind, a preview of /rewind <n> and the confirmed form, with a mode', () => {
    expect(parseRewindArgs('')).toEqual({ action: 'list' })
    expect(parseRewindArgs(' 3 ')).toEqual({ action: 'preview', reference: '3', mode: 'both' })
    expect(parseRewindArgs('3 confirm')).toEqual({ action: 'apply', reference: '3', mode: 'both' })
    expect(parseRewindArgs('#3 CODE')).toEqual({ action: 'preview', reference: '#3', mode: 'code' })
    expect(parseRewindArgs('3 chat confirm')).toEqual({ action: 'apply', reference: '3', mode: 'chat' })
    expect(parseRewindArgs('3 confirm code')).toEqual({ action: 'apply', reference: '3', mode: 'code' })
  })

  it('refuses a line that does not say which message, names two modes, or has a word it does not know', () => {
    expect(parseRewindArgs('confirm')).toMatchObject({ action: 'usage' })
    expect(parseRewindArgs('code 3')).toMatchObject({ action: 'usage' })
    expect(parseRewindArgs('3 code chat')).toMatchObject({ action: 'usage', problem: expect.stringContaining('code') })
    expect(parseRewindArgs('3 now')).toMatchObject({ action: 'usage', problem: expect.stringContaining('"now"') })
  })

  const page = (turns: unknown[], nextCursor: string | null = null): unknown => ({ data: turns, nextCursor })
  const userTurn = (id: string, text: string, startedAt?: number): unknown => ({
    id,
    startedAt: startedAt ?? null,
    items: [{ type: 'userMessage', id: `${id}-u`, content: [{ type: 'text', text, text_elements: [] }] }],
  })

  it('makes a checkpoint of every turn that began with a user message, and none of a shell command, a goal turn or a compaction', () => {
    const parsed = parseTurnPage(
      page([
        userTurn('t1', 'first', 1_793_203_780),
        { id: 't-shell', items: [{ type: 'commandExecution', id: 'c1' }] },
        { id: 't-goal', items: [{ type: 'agentMessage', id: 'a1', text: 'continuing' }] },
        { id: 't-compact', items: [] },
        userTurn('t2', 'second'),
        { items: [] },
      ], 'next'),
    )
    expect(parsed.nextCursor).toBe('next')
    expect(parsed.turns.map((turn) => turn.id)).toEqual(['t1', 't-shell', 't-goal', 't-compact', 't2'])
    const checkpoints = checkpointsOf(parsed.turns)
    expect(checkpoints.map((checkpoint) => [checkpoint.turnId, checkpoint.label, checkpoint.turnIndex])).toEqual([
      ['t1', 'first', 0],
      ['t2', 'second', 4],
    ])
    expect(checkpoints[0]?.at).toBe(new Date(1_793_203_780 * 1000).toISOString())
    expect(checkpoints[1]?.at).toBeUndefined()
  })

  it('finds a message by its number, with or without #, or by an unambiguous prefix of its turn id', () => {
    const checkpoints = checkpointsOf(parseTurnPage(page([userTurn('abc123-one', 'a'), userTurn('abc123-two', 'b'), userTurn('0194cc-three', 'c')])).turns)
    expect(findCheckpoint(checkpoints, '2')).toMatchObject({ position: 2, checkpoint: { turnId: 'abc123-two' } })
    expect(findCheckpoint(checkpoints, '#3')).toMatchObject({ position: 3 })
    // An id that starts with digits is still an id once it is long enough not to be a message number.
    expect(findCheckpoint(checkpoints, '0194cc')).toMatchObject({ position: 3 })
    expect(findCheckpoint(checkpoints, 'abc123-t')).toMatchObject({ position: 2 })
    expect(findCheckpoint(checkpoints, 'abc123')).toMatchObject({ error: expect.stringContaining('matches several messages') })
    expect(findCheckpoint(checkpoints, 'abc12')).toMatchObject({ error: expect.stringContaining('No message matches') })
    expect(findCheckpoint(checkpoints, '4')).toMatchObject({ error: 'There is no message 4. /rewind lists 3.' })
    expect(findCheckpoint(checkpoints, '0')).toMatchObject({ error: expect.stringContaining('There is no message 0') })
  })

  it('lists only the changes that were applied, and counts the kinds it cannot undo', () => {
    const change = (path: string, type: string): unknown => ({ path, kind: { type }, diff: 'x\n' })
    const turn = (id: string, items: unknown[]): unknown => ({ id, items })
    const { turns } = parseTurnPage(
      page([
        turn('t1', [
          { type: 'fileChange', status: 'completed', changes: [change('/w/a', 'add'), change('/w/b', 'delete')] },
          { type: 'fileChange', status: 'declined', changes: [change('/w/c', 'add')] },
          { type: 'fileChange', status: 'failed', changes: [change('/w/d', 'add')] },
          { type: 'fileChange', status: 'inProgress', changes: [change('/w/e', 'add')] },
          { type: 'agentMessage', text: 'x' },
        ]),
        turn('t2', [{ type: 'fileChange', status: 'completed', changes: [change('/w/f', 'symlink'), { kind: { type: 'add' } }, { path: '/w/g', kind: { type: 'update', move_path: '/w/h' }, diff: '@@ -1 +1 @@\n-a\n+b\n\n\nMoved to: /w/h' }] }]),
      ]),
    )
    const { changes, unsupported } = fileChangesOf(turns)
    expect(unsupported).toBe(1)
    expect(changes.map((entry) => [entry.path, entry.kind, entry.movePath])).toEqual([
      ['/w/a', 'add', undefined],
      ['/w/b', 'delete', undefined],
      ['/w/g', 'update', '/w/h'],
    ])
    // Codex appends where the file went to the diff of a move; the diff itself is what is undone.
    expect(changes[2]?.diff).toBe('@@ -1 +1 @@\n-a\n+b\n')
  })
})

describe('codex rewind restore plan', () => {
  const edit = (path: string, diff: string, movePath?: string): FileChange => ({ path, kind: 'update', diff, movePath })
  const add = (path: string, content: string): FileChange => ({ path, kind: 'add', diff: content, movePath: undefined })
  const remove = (path: string, content: string): FileChange => ({ path, kind: 'delete', diff: content, movePath: undefined })
  const plan = async (changes: FileChange[], disk: Record<string, string>, unsupported?: number) => await planRestore(changes, memoryFiles(disk), unsupported)

  it('undoes several edits of one file newest first, and counts the lines that come and go', async () => {
    const result = await plan(
      [edit('/w/a', '@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n'), edit('/w/a', '@@ -2,2 +2,2 @@\n TWO\n-three\n+THREE\n')],
      { '/w/a': 'one\nTWO\nTHREE\n' },
    )
    expect(result.conflicts).toEqual([])
    expect(result.files).toEqual([{ path: '/w/a', action: 'write', content: 'one\ntwo\nthree\n', insertions: 2, deletions: 2 }])
  })

  it('removes what the agent created, brings back what it deleted, and leaves what is already as it was', async () => {
    const result = await plan(
      [add('/w/new', 'made\n'), remove('/w/gone', 'was here\n'), remove('/w/back', 'again\n'), add('/w/undone', 'x\n')],
      { '/w/new': 'made\n', '/w/back': 'again\n' },
    )
    expect(result.conflicts).toEqual([])
    expect(result.files).toEqual([
      { path: '/w/gone', action: 'create', content: 'was here\n', insertions: 1, deletions: 0 },
      { path: '/w/new', action: 'delete', content: undefined, insertions: 0, deletions: 1 },
    ])
    expect(result.unchanged).toEqual(['/w/back', '/w/undone'])
  })

  it('leaves a file alone that is not as the agent left it, and says which edit it no longer matches', async () => {
    const result = await plan(
      [add('/w/made', 'made\n'), edit('/w/edited', '@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n'), remove('/w/gone', 'was\n'), add('/w/fine', 'ok\n')],
      { '/w/made': 'made\nand more\n', '/w/edited': 'one\nTWO by hand\nthree\n', '/w/gone': 'something else\n', '/w/fine': 'ok\n' },
    )
    expect(result.files.map((file) => file.path)).toEqual(['/w/fine'])
    expect(result.conflicts.map((conflict) => [conflict.path, conflict.reason])).toEqual([
      ['/w/edited', expect.stringContaining('changed since the agent edited it')],
      ['/w/gone', expect.stringContaining('exists again')],
      ['/w/made', expect.stringContaining('changed since the agent created it')],
    ])
  })

  it('finds an edit where the lines moved to, but not when it could be in two places', async () => {
    const diff = '@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n'
    const moved = await plan([edit('/w/a', diff)], { '/w/a': 'new first line\none\nTWO\nthree\nlast\n' })
    expect(moved.files).toEqual([{ path: '/w/a', action: 'write', content: 'new first line\none\ntwo\nthree\nlast\n', insertions: 1, deletions: 1 }])
    const twice = await plan([edit('/w/a', diff)], { '/w/a': 'x\none\nTWO\nthree\none\nTWO\nthree\n' })
    expect(twice.files).toEqual([])
    expect(twice.conflicts).toHaveLength(1)
  })

  it('takes an edit that someone already undid for nothing to restore, and keeps the file endings it recorded', async () => {
    const diff = '@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n'
    expect(await plan([edit('/w/a', diff)], { '/w/a': 'one\ntwo\nthree\n' })).toMatchObject({ files: [], conflicts: [], unchanged: ['/w/a'] })
    const noEol = '@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n'
    const result = await plan([edit('/w/n', noEol)], { '/w/n': 'a\nc' })
    expect(result.files).toEqual([{ path: '/w/n', action: 'write', content: 'a\nb', insertions: 1, deletions: 1 }])
    // The file does not end the way the record says: someone has been at it.
    expect((await plan([edit('/w/n', noEol)], { '/w/n': 'a\nc\n' })).conflicts).toHaveLength(1)
  })

  it('puts a moved file back under its old name, and keeps both names out of the plan when one cannot be restored', async () => {
    const diff = '@@ -1,2 +1,2 @@\n x\n-y\n+Y\n'
    const clean = await plan([edit('/w/old', diff, '/w/new')], { '/w/new': 'x\nY\n' })
    expect(clean.conflicts).toEqual([])
    expect(clean.files).toEqual([
      { path: '/w/new', action: 'delete', content: undefined, insertions: 0, deletions: 2 },
      { path: '/w/old', action: 'create', content: 'x\ny\n', insertions: 2, deletions: 0 },
    ])
    const changedLater = await plan([edit('/w/old', diff, '/w/new'), add('/w/other', 'o\n')], { '/w/new': 'x\nelsewhere\n', '/w/other': 'o\n' })
    expect(changedLater.files.map((file) => file.path)).toEqual(['/w/other'])
    expect(changedLater.conflicts).toHaveLength(1)
    const occupied = await plan([edit('/w/old', diff, '/w/new')], { '/w/new': 'x\nY\n', '/w/old': 'a new file\n' })
    expect(occupied.files).toEqual([])
    expect(occupied.conflicts[0]?.reason).toContain('exists again')
  })

  it('does not touch a file the disk refuses to show, and passes on the changes of a kind it does not know', async () => {
    const io: RestoreIo = {
      read: async (path) => (path === '/w/link' ? { kind: 'unreadable', reason: 'is a symbolic link' } : { kind: 'absent' }),
      write: async () => undefined,
      remove: async () => undefined,
    }
    const result = await planRestore([add('/w/link', 'x\n'), remove('/w/fine', 'back\n')], io, 2)
    expect(result.conflicts).toEqual([{ path: '/w/link', reason: 'is a symbolic link' }])
    expect(result.files.map((file) => file.path)).toEqual(['/w/fine'])
    expect(result.unsupported).toBe(2)
  })

  it('writes what the plan says, and carries on past a file it cannot write', async () => {
    const io = memoryFiles({ '/w/new': 'made\n' })
    const failing: RestoreIo = {
      ...io,
      write: async (path, content) => {
        if (path === '/w/locked') throw new Error('read-only file system')
        await io.write(path, content)
      },
    }
    const result = await planRestore([add('/w/new', 'made\n'), remove('/w/locked', 'a\n'), remove('/w/back', 'b\n')], failing)
    const done = await applyRestore(result, failing)
    expect(done.restored.map((file) => file.path)).toEqual(['/w/back', '/w/new'])
    expect(done.failed).toEqual([{ path: '/w/locked', reason: 'could not be written (read-only file system)' }])
    expect([...io.files.entries()]).toEqual([['/w/back', 'b\n']])
  })
})

describe('codex rewind file system', () => {
  it('reads what is there as text, and refuses what a restore must not touch', async () => {
    const dir = await tempDir('dsh-rewind-io-')
    const io = nodeRestoreIo([dir])
    await writeFile(join(dir, 'text.txt'), 'héllo\n')
    await writeFile(join(dir, 'binary.bin'), Buffer.from([0x61, 0x00, 0x62]))
    await writeFile(join(dir, 'latin1.txt'), Buffer.from([0xe9, 0x0a]))
    await mkdir(join(dir, 'sub'))
    await symlink(join(dir, 'text.txt'), join(dir, 'link.txt'))

    expect(await io.read(join(dir, 'text.txt'))).toEqual({ kind: 'text', content: 'héllo\n' })
    expect(await io.read(join(dir, 'nothing.txt'))).toEqual({ kind: 'absent' })
    expect(await io.read(join(dir, 'binary.bin'))).toEqual({ kind: 'unreadable', reason: 'is a binary file' })
    expect(await io.read(join(dir, 'latin1.txt'))).toEqual({ kind: 'unreadable', reason: 'is not valid UTF-8 text' })
    expect(await io.read(join(dir, 'link.txt'))).toEqual({ kind: 'unreadable', reason: 'is a symbolic link' })
    expect(await io.read(join(dir, 'sub'))).toEqual({ kind: 'unreadable', reason: 'is not a regular file' })
    expect(await io.read('relative.txt')).toMatchObject({ kind: 'unreadable' })
  })

  it('writes and removes inside the session, creating the directories it needs, and nowhere else', async () => {
    const dir = await tempDir('dsh-rewind-io-')
    const outside = await tempDir('dsh-rewind-outside-')
    const io = nodeRestoreIo([dir])

    await io.write(join(dir, 'a', 'b', 'c.txt'), 'x\n')
    expect(readFileSync(join(dir, 'a', 'b', 'c.txt'), 'utf8')).toBe('x\n')
    await io.remove(join(dir, 'a', 'b', 'c.txt'))
    expect(existsSync(join(dir, 'a', 'b', 'c.txt'))).toBe(false)
    // Removing what is not there is nothing to report.
    await io.remove(join(dir, 'never-was.txt'))

    await expect(io.write(join(outside, 'x.txt'), 'x')).rejects.toThrow('outside the directories')
    await expect(io.remove(join(outside, 'x.txt'))).rejects.toThrow('outside the directories')
    // A link in the session that leads out of it is out of the session.
    await symlink(outside, join(dir, 'door'))
    await expect(io.write(join(dir, 'door', 'x.txt'), 'x')).rejects.toThrow('outside the directories')
    expect(existsSync(join(outside, 'x.txt'))).toBe(false)
    // A `..` behind a link is read the way the check read it, so it cannot lead to the other side of the link.
    await io.write(`${dir}/door/../escape.txt`, 'x\n')
    expect(existsSync(join(dir, 'escape.txt'))).toBe(true)
    expect(existsSync(join(outside, '..', 'escape.txt'))).toBe(false)
  })
})

describe('codex goals through the transport', () => {
  /** The last turn of a goal: its answer, then the goal completes. */
  const finishing = (id: string, text: string): Step[] => [...messageSteps(id, text), { goal: 'complete' }]
  /** A saved thread that already has a goal: the app-server reports it when the thread is resumed. */
  const saved = (goal: Record<string, unknown>, extra: FakeConfig = {}): Pick<LaunchOptions, 'config' | 'session'> => ({
    session: { kind: 'resume', sessionId: 'thr_goal' },
    config: { threads: { thr_goal: 'ok' }, goal, ...extra },
  })

  it('sets the goal and keeps the prompt open for every turn the app-server starts for it, until the goal is complete', async () => {
    const harness = await launch({ config: { goalTurns: [messageSteps('g1', 'step one done'), finishing('g2', 'all done')] } })

    const result = await harness.prompt('/goal finish the migration')

    expect(result.stopReason).toBe('end_turn')
    // The app-server starts the turns of an active goal itself: the transport only follows them.
    expect(harness.sent('turn/start')).toHaveLength(0)
    expect(paramsOf(harness.sent('thread/goal/set')[0])).toEqual({ threadId: 'thr_test', origin: 'user', objective: 'finish the migration', status: 'active' })
    expect(harness.trace(['thread/goal/get', 'thread/goal/set', 'turn/started', 'turn/completed'])).toEqual([
      '→ thread/goal/get@thr_test',
      '→ thread/goal/set@thr_test',
      '← turn/started@thr_test',
      '← turn/completed@thr_test',
      '← turn/started@thr_test',
      '← turn/completed@thr_test',
    ])
    const texts = harness.updates('agent_message_chunk').map(chunkText)
    expect(texts[0]).toContain('**Goal set** — active')
    expect(texts.slice(1)).toEqual(['step one done', 'all done'])
    // What the command did is its answer; the end of the goal is told inside the turn that reached it.
    expect(harness.updates('agent_thought_chunk').map(chunkText)).toEqual(['Goal complete: finish the migration\n\n'])
  })

  it('follows the turns an active goal starts after an ordinary message, and ends the prompt with the goal', async () => {
    const harness = await launch(saved({ objective: 'keep going', status: 'active' }, { turns: [messageSteps('m1', 'answer')], goalTurns: [finishing('g1', 'and on')] }))

    expect((await harness.prompt('hello')).stopReason).toBe('end_turn')

    expect(harness.updates('agent_message_chunk').map(chunkText)).toEqual(['answer', 'and on'])
    expect(harness.sent('turn/start')).toHaveLength(1)
    // The goal was read once, when the thread was resumed: that is how the prompt knows to stay open.
    expect(harness.sent('thread/goal/get')).toHaveLength(1)
  })

  it('does not hold a prompt for a goal that is not pursued', async () => {
    const harness = await launch(saved({ objective: 'ship the release', status: 'paused' }, { turns: [messageSteps('m1', 'answer')] }))
    const started = Date.now()

    expect((await harness.prompt('hello')).stopReason).toBe('end_turn')

    // Waiting for the next turn of an active goal takes up to three seconds; a paused goal has none.
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(harness.updates('agent_message_chunk').map(chunkText)).toEqual(['answer'])
  })

  it('pauses the goal before it interrupts the turn when the prompt is cancelled, so that nothing follows', async () => {
    const harness = await launch({ config: { goalTurns: [[itemStarted(commandItem('exec-1')), { wait: 'interrupt' }]] } })
    const controller = new AbortController()
    const running = harness.prompt('/goal long job', controller.signal)
    await waitFor(() => harness.trace(['turn/started']).length === 1)

    controller.abort()

    await expect(running).resolves.toMatchObject({ stopReason: 'cancelled' })
    // The pause reaches the app-server first: an active goal starts the next turn the moment this one is interrupted.
    expect(harness.trace(['thread/goal/set', 'turn/started', 'turn/interrupt'])).toEqual([
      '→ thread/goal/set@thr_test',
      '← turn/started@thr_test',
      '→ thread/goal/set@thr_test',
      '→ turn/interrupt@thr_test',
    ])
    expect(paramsOf(harness.sent('thread/goal/set')[1])).toEqual({ threadId: 'thr_test', status: 'paused', origin: 'user' })
  })

  it('pauses the goal when the user cancels an approval of one of its turns, before the answer reaches the app-server', async () => {
    const harness = await launch({
      decide: () => ({ cancelled: true }),
      config: {
        goalTurns: [
          [
            { r: 'item/commandExecution/requestApproval', p: { threadId: '$thread', turnId: '$turn', itemId: 'cmd-1', command: 'rm -rf build', cwd: '$cwd', commandActions: [] } },
            { end: 'interrupted' },
          ],
        ],
      },
    })

    await expect(harness.prompt('/goal clean up')).resolves.toMatchObject({ stopReason: 'cancelled' })

    const frames = harness.frames()
    const pause = frames.findIndex((frame) => frame['method'] === 'thread/goal/set' && paramsOf(frame)['status'] === 'paused')
    const answer = frames.findIndex((frame) => frame['id'] === 9001 && frame['method'] === undefined)
    expect(objectOf(frames[answer]?.['result'])['decision']).toBe('cancel')
    expect(pause).toBeGreaterThan(-1)
    expect(pause).toBeLessThan(answer)
  })

  it('ends a prompt that waits for the next turn of the goal as soon as it is cancelled, and pauses the goal', async () => {
    // Only one turn is scripted: the goal stays active and the app-server never starts another.
    const harness = await launch({ config: { goalTurns: [messageSteps('g1', 'one')] } })
    const controller = new AbortController()
    const running = harness.prompt('/goal keep working', controller.signal)
    await waitFor(() => harness.trace(['turn/completed']).length === 1)
    // The wait for the next turn is three seconds; Stop must not sit it out.
    const stopped = Date.now()

    controller.abort()

    await expect(running).resolves.toMatchObject({ stopReason: 'cancelled' })
    expect(Date.now() - stopped).toBeLessThan(1_500)
    expect(paramsOf(harness.sent('thread/goal/set').at(-1))).toEqual({ threadId: 'thr_test', status: 'paused', origin: 'user' })
    expect(harness.sent('turn/interrupt')).toHaveLength(0)
  })

  it('controls the goal of a running turn from a steered /goal line, which the model never sees', async () => {
    const harness = await launch({ config: { goalTurns: [[itemStarted(commandItem('exec-1')), { wait: 'interrupt' }]] } })
    const controller = new AbortController()
    const running = harness.prompt('/goal long job', controller.signal)
    await waitFor(() => harness.trace(['turn/started']).length === 1)

    expect(await harness.transport.steer(say('/goal pause'))).toBe('injected')

    expect(harness.sent('turn/steer')).toHaveLength(0)
    expect(paramsOf(harness.sent('thread/goal/set')[1])).toEqual({ threadId: 'thr_test', status: 'paused', origin: 'user' })
    expect(lastText(harness)).toContain('**Goal paused** — paused')
    // An ordinary line is still steered as text.
    expect(await harness.transport.steer(say('look at the logs'))).toBe('injected')
    expect(harness.sent('turn/steer')).toHaveLength(1)
    controller.abort()
    await running
  })

  it('shows the goal with what it used, refuses to replace one that is not finished, and carries it in /status', async () => {
    const harness = await launch(
      saved({ objective: 'ship the release', status: 'paused', tokenBudget: 50_000, tokensUsed: 12_300, timeUsedSeconds: 240 }),
    )

    expect((await harness.prompt('/goal')).stopReason).toBe('end_turn')
    expect(lastText(harness)).toBe('**Goal** — paused\n\n> ship the release\n\n12.3K / 50K tokens · 4m')

    await harness.prompt('/goal write the docs')
    expect(lastText(harness)).toContain('This goal is not finished')
    expect(lastText(harness)).toContain('/goal clear')
    expect(harness.sent('thread/goal/set')).toHaveLength(0)

    expect((await harness.run('status')).text).toContain('**Goal:** paused — ship the release')
  })

  it('resumes a goal and follows it, pauses and clears it, and says when there is nothing to do', async () => {
    const harness = await launch(saved({ objective: 'ship the release', status: 'paused' }, { goalTurns: [finishing('g1', 'shipped')] }))

    await harness.prompt('/goal resume')
    expect(paramsOf(harness.sent('thread/goal/set')[0])).toEqual({ threadId: 'thr_goal', status: 'active', origin: 'user' })
    expect(harness.updates('agent_message_chunk').map(chunkText).slice(-1)).toEqual(['shipped'])

    await harness.prompt('/goal clear')
    expect(paramsOf(harness.sent('thread/goal/clear')[0])).toEqual({ threadId: 'thr_goal', origin: 'user' })
    expect(lastText(harness)).toBe('Goal cleared.')

    await harness.prompt('/goal clear')
    expect(lastText(harness)).toContain('No goal to clear')
    await harness.prompt('/goal pause')
    expect(lastText(harness)).toContain('No goal to pause')
    await harness.prompt('/goal')
    expect(lastText(harness)).toContain('No goal is currently set.')
    expect(harness.sent('thread/goal/set')).toHaveLength(1)
  })

  it('pauses an active goal without a turn, and replaces a finished goal by clearing it first', async () => {
    const active = await launch(saved({ objective: 'keep going', status: 'active' }))
    await active.prompt('/goal pause')
    expect(lastText(active)).toContain('**Goal paused** — paused')
    expect(paramsOf(active.sent('thread/goal/set')[0])).toMatchObject({ status: 'paused' })
    expect(active.sent('turn/start')).toHaveLength(0)

    const finished = await launch(saved({ objective: 'old goal', status: 'complete' }, { goalTurns: [finishing('g1', 'done')] }))
    await finished.prompt('/goal a new goal')
    expect(finished.trace(['thread/goal/clear', 'thread/goal/set'])).toEqual(['→ thread/goal/clear@thr_goal', '→ thread/goal/set@thr_goal'])
    expect(paramsOf(finished.sent('thread/goal/set')[0])).toMatchObject({ objective: 'a new goal', status: 'active' })
  })

  it('turns a goal request the app-server refuses into an answer, and starts nothing', async () => {
    const harness = await launch({ config: { requestErrors: { 'thread/goal/set': 'goals feature is disabled' } } })

    expect((await harness.prompt('/goal ship it')).stopReason).toBe('end_turn')

    expect(lastText(harness)).toContain('features.goals')
    expect(harness.sent('turn/start')).toHaveLength(0)
  })

  it('stops a turn the app-server starts for the goal while no prompt is open, pauses the goal and says so', async () => {
    const harness = await launch(
      saved({ objective: 'keep going', status: 'active' }, { goalStartsOnResume: true, goalTurns: [[itemStarted(commandItem('exec-1')), { wait: 'interrupt' }]] }),
    )

    await waitFor(() => harness.sent('turn/interrupt').length === 1, 8_000)

    expect(harness.trace(['turn/started', 'thread/goal/set', 'turn/interrupt'])).toEqual([
      '← turn/started@thr_goal',
      '→ thread/goal/set@thr_goal',
      '→ turn/interrupt@thr_goal',
    ])
    expect(paramsOf(harness.sent('thread/goal/set')[0])).toMatchObject({ status: 'paused' })
    await waitFor(() => harness.events.some((event) => event.kind === 'notice' && event.text.includes('the goal was paused')))
  })

  it('forgets the goal of the old conversation when /new starts another', async () => {
    const harness = await launch(saved({ objective: 'ship the release', status: 'paused' }, { startIds: ['thr_next'] }))
    expect((await harness.run('status')).text).toContain('**Goal:**')

    expect(await harness.run('new')).toMatchObject({ kind: 'success' })

    expect((await harness.run('status')).text).not.toContain('**Goal:**')
  })
})

describe('codex /rewind through the transport', () => {
  const turn = (id: string, content: unknown[], startedAt: number, ...items: Record<string, unknown>[]): Record<string, unknown> => ({
    id,
    startedAt,
    items: [{ type: 'userMessage', id: `${id}-user`, content }, ...items, { type: 'agentMessage', id: `${id}-answer`, text: `done ${id}` }],
  })
  const message = (text: string): unknown[] => [{ type: 'text', text, text_elements: [] }]
  const fileChange = (id: string, ...changes: Record<string, unknown>[]): Record<string, unknown> => ({ type: 'fileChange', id, status: 'completed', changes })
  const added = (name: string, content: string): Record<string, unknown> => ({ path: `$cwd/${name}`, kind: { type: 'add' }, diff: content })
  const deleted = (name: string, content: string): Record<string, unknown> => ({ path: `$cwd/${name}`, kind: { type: 'delete' }, diff: content })
  const edited = (name: string, diff: string): Record<string, unknown> => ({ path: `$cwd/${name}`, kind: { type: 'update', move_path: null }, diff })

  /** Message 1 creates a.txt; message 2 (sent with context DSH generated) edits it and adds b.txt; a shell command; message 3 deletes a.txt. */
  const history = [
    turn('turn_1', message('create a.txt'), 1_793_203_780, fileChange('p1', added('a.txt', 'one\ntwo\nthree\n'))),
    turn(
      'turn_2',
      [{ type: 'text', text: generatedContextBlock('Host context: it is Tuesday.'), text_elements: [] }, ...message('edit a.txt and add b.txt')],
      1_793_203_790,
      fileChange('p2', edited('a.txt', '@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n'), added('b.txt', 'bee\n')),
    ),
    { id: 'turn_shell', startedAt: 1_793_203_795, items: [commandItem('sh-1', { source: 'userShell' })] },
    turn('turn_3', message('delete a.txt'), 1_793_203_800, fileChange('p3', deleted('a.txt', 'one\nTWO\nthree\n'))),
  ]
  const read = (harness: Harness, name: string): string | undefined =>
    existsSync(join(harness.dir, name)) ? readFileSync(join(harness.dir, name), 'utf8') : undefined
  /** The disk as the three messages left it: a.txt is gone, b.txt is there. */
  const leave = async (harness: Harness): Promise<void> => {
    await writeFile(join(harness.dir, 'b.txt'), 'bee\n')
  }
  const changes = (harness: Harness): NativeTransportEvent[] => harness.events.filter((event) => event.kind === 'session_changed')

  it('lists the messages of the conversation by what the user wrote, newest last, across the pages the app-server returns', async () => {
    const harness = await launch({ session: { kind: 'resume', sessionId: 'thr_old' }, config: { threads: { thr_old: 'ok' }, history, turnsPageSize: 2 } })

    const result = await harness.run('rewind')

    expect(result.kind).toBe('success')
    expect(result.text).toContain('3 messages in this conversation')
    // The shell command is not a message, and the context DSH put in front of message 2 is not what the user wrote.
    const rows = result.text.split('\n').filter((line) => /^\| \d+ \|/.test(line))
    expect(rows.map((row) => row.split('|')[1]?.trim())).toEqual(['1', '2', '3'])
    expect(rows.map((row) => row.split('|')[2]?.trim())).toEqual(['create a.txt', 'edit a.txt and add b.txt', 'delete a.txt'])
    // Only the cheap summary view is read for the list, page after page.
    expect(harness.sent('thread/turns/list').map((frame) => [paramsOf(frame)['itemsView'], paramsOf(frame)['sortDirection'], paramsOf(frame)['threadId'], paramsOf(frame)['cursor']])).toEqual([
      ['summary', 'asc', 'thr_old', null],
      ['summary', 'asc', 'thr_old', '2'],
    ])
  })

  it('lists the last twenty messages of a long conversation, and says so when there are none', async () => {
    const many = Array.from({ length: 25 }, (_, index) => turn(`turn_${String(index + 1)}`, message(`message ${String(index + 1)}`), 1_793_203_000 + index))
    const long = await launch({ config: { history: many } })
    const text = (await long.run('rewind')).text
    expect(text).toContain('25 messages in this conversation, the last 20 shown')
    expect(text.split('\n').filter((line) => /^\| \d+ \|/.test(line)).map((row) => row.split('|')[1]?.trim())).toEqual(
      Array.from({ length: 20 }, (_, index) => String(index + 6)),
    )

    const empty = await launch()
    expect(await empty.run('rewind')).toEqual({ kind: 'success', text: 'There are no messages in the current Codex conversation yet.' })
  })

  it('previews going back to a message, saying what Codex forgets and which files come back, and changes nothing', async () => {
    const harness = await launch({ config: { history } })
    await leave(harness)

    const result = await harness.run('rewind', '2')

    expect(result.kind).toBe('success')
    expect(result.text).toContain('Codex would forget message 2 and the 1 message after it')
    expect(result.text).toContain('2 files (+3 −1) would be restored')
    expect(result.text).toContain('`a.txt` — back (+3)')
    expect(result.text).toContain('`b.txt` — removed (−1)')
    expect(result.text).toContain('/rewind 2 confirm')
    // The preview is a look: no rollback, files as they were, nothing announced.
    expect(harness.sent('thread/revert')).toHaveLength(0)
    expect(read(harness, 'a.txt')).toBeUndefined()
    expect(read(harness, 'b.txt')).toBe('bee\n')
    expect(changes(harness)).toEqual([])
    // The changes come from the full view, newest first, and stop at message 2.
    expect(harness.sent('thread/turns/list').map((frame) => [paramsOf(frame)['itemsView'], paramsOf(frame)['sortDirection']])).toContainEqual(['full', 'desc'])
  })

  it('restores the files first and then rolls the conversation back, and announces that the vendor session changed', async () => {
    const harness = await launch({ session: { kind: 'resume', sessionId: 'thr_old' }, config: { threads: { thr_old: 'ok' }, history, watchOnRevert: ['a.txt', 'b.txt'] } })
    await leave(harness)

    const result = await harness.run('rewind', '2 confirm')

    expect(result.kind).toBe('success')
    expect(read(harness, 'a.txt')).toBe('one\ntwo\nthree\n')
    expect(read(harness, 'b.txt')).toBeUndefined()
    expect(paramsOf(harness.sent('thread/revert')[0])).toEqual({ threadId: 'thr_old', beforeTurnId: 'turn_2' })
    // When Codex was told to roll back, the files were already back.
    expect(harness.frames().find((frame) => 'atRevert' in frame)).toEqual({ atRevert: [true, false] })
    expect(changes(harness)).toEqual([{ kind: 'session_changed', sessionId: 'thr_old', reason: 'rewind' }])
    expect(result.text).toContain('Rewound to just before message 2')
    expect(result.text).toContain('Codex no longer remembers message 2 and the 1 message after it')
    expect(result.text).toContain('Shell-command side effects are never undone')
    // What Codex keeps is what the list shows next.
    expect((await harness.run('rewind')).text).toContain('1 message in this conversation')
  })

  it('rolls back only the files with `code` and only the conversation with `chat`', async () => {
    const code = await launch({ config: { history } })
    await leave(code)
    expect((await code.run('rewind', '2 code')).text).not.toContain('Codex would forget')
    expect((await code.run('rewind', '2 code confirm')).text).toContain('Restored the files')
    expect(read(code, 'a.txt')).toBe('one\ntwo\nthree\n')
    expect(code.sent('thread/revert')).toHaveLength(0)
    expect(changes(code)).toEqual([])

    const chat = await launch({ config: { history } })
    await leave(chat)
    expect((await chat.run('rewind', '2 chat')).text).not.toContain('would be restored')
    expect((await chat.run('rewind', '2 chat confirm')).text).toContain('Rolled the conversation back')
    expect(read(chat, 'a.txt')).toBeUndefined()
    expect(read(chat, 'b.txt')).toBe('bee\n')
    expect(paramsOf(chat.sent('thread/revert')[0])).toMatchObject({ beforeTurnId: 'turn_2' })
    expect(changes(chat)).toHaveLength(1)
    // The files were never looked at: the full view of the turns is not read for a conversation-only rollback.
    expect(chat.sent('thread/turns/list').every((frame) => paramsOf(frame)['itemsView'] === 'summary')).toBe(true)
  })

  it('leaves the files that are not as the agent left them, says why, and still rolls the conversation back', async () => {
    const harness = await launch({ config: { history } })
    // b.txt was edited by hand after the agent created it.
    await writeFile(join(harness.dir, 'b.txt'), 'bee\nand more\n')

    const preview = await harness.run('rewind', '2')
    expect(preview.text).toContain('Files that cannot be restored')
    expect(preview.text).toContain('`b.txt` — changed since the agent created it')
    expect(preview.text).toContain('`a.txt` — back (+3)')

    const result = await harness.run('rewind', '2 confirm')

    expect(result.text).toContain('Files that were not restored')
    expect(read(harness, 'b.txt')).toBe('bee\nand more\n')
    expect(read(harness, 'a.txt')).toBe('one\ntwo\nthree\n')
    expect(harness.sent('thread/revert')).toHaveLength(1)
  })

  it('never reads or writes a file outside the directories of the session', async () => {
    const outside = [turn('turn_1', message('touch two files'), 1_793_203_780, fileChange('p1', added('../outside-rewind.txt', 'x\n'), added('inside.txt', 'y\n')))]
    const harness = await launch({ config: { history: outside } })
    await writeFile(join(harness.dir, 'inside.txt'), 'y\n')
    const stray = join(harness.dir, '..', 'outside-rewind.txt')
    await writeFile(stray, 'x\n')
    try {
      const result = await harness.run('rewind', '1 confirm')

      expect(read(harness, 'inside.txt')).toBeUndefined()
      expect(readFileSync(stray, 'utf8')).toBe('x\n')
      expect(result.text).toContain('is outside the directories of this session')
    } finally {
      await rm(stray, { force: true })
    }
  })

  it('reports a conversation that could not be rolled back after the files were restored, without announcing a change', async () => {
    const harness = await launch({ config: { history, requestErrors: { 'thread/revert': 'rollout is being written' } } })
    await leave(harness)

    const result = await harness.run('rewind', '2 confirm')

    expect(result.kind).toBe('error')
    expect(result.text).toContain('Could not rewind to just before message 2')
    expect(result.text).toContain('not rolled back — rollout is being written')
    expect(result.text).toContain('Codex still remembers the later work')
    expect(read(harness, 'a.txt')).toBe('one\ntwo\nthree\n')
    expect(changes(harness)).toEqual([])
  })

  it('refuses to roll back while Codex works, and still previews', async () => {
    const harness = await launch({ config: { history, turns: [BUSY_TURN] } })
    await leave(harness)
    const main = await startBusyTurn(harness)

    expect(await harness.run('rewind', '2 confirm')).toMatchObject({ kind: 'error', text: expect.stringContaining('Wait for the current turn to finish') })
    expect(harness.sent('thread/revert')).toHaveLength(0)
    expect(read(harness, 'b.txt')).toBe('bee\n')
    expect(await harness.run('rewind', '2')).toMatchObject({ kind: 'success' })

    main.abort()
    await main.running
  })

  it('names the message that does not exist, and what a line needs to say', async () => {
    const harness = await launch({ config: { history } })

    expect(await harness.run('rewind', '9')).toEqual({ kind: 'error', text: 'There is no message 9. /rewind lists 3.' })
    expect(await harness.run('rewind', 'confirm')).toMatchObject({ kind: 'error', text: expect.stringContaining('Usage: /rewind') })
    expect(await harness.run('rewind', '2 code chat')).toMatchObject({ kind: 'error' })
    expect(harness.sent('thread/revert')).toHaveLength(0)
  })

  it('answers /rewind typed as a prompt without a turn, but does not roll back from inside a prompt', async () => {
    const harness = await launch({ config: { history } })

    expect((await harness.prompt('/rewind')).stopReason).toBe('end_turn')
    expect(lastText(harness)).toContain('3 messages in this conversation')
    expect((await harness.prompt('/rewind 2')).stopReason).toBe('end_turn')
    expect(lastText(harness)).toContain('Codex would forget message 2')

    expect((await harness.prompt('/rewind 2 confirm')).stopReason).toBe('end_turn')
    expect(lastText(harness)).toContain('runs as a command')
    expect(harness.sent('thread/revert')).toHaveLength(0)
    expect(harness.sent('turn/start')).toHaveLength(0)
  })
})

// The strings the transport sends on the TUI's behalf must be the ones the vendor ships. Opt-in, because it reads the
// whole binary: DSH_CODEX_BINARY=/path/to/codex.
const vendorBinary = process.env['DSH_CODEX_BINARY']

describe.skipIf(vendorBinary === undefined || !existsSync(vendorBinary))('codex vendor texts (opt-in: DSH_CODEX_BINARY)', () => {
  it('still ships the side-conversation and /init texts the transport sends', () => {
    const binary = readFileSync(vendorBinary ?? '')
    for (const [name, text] of [
      ['side boundary prompt', SIDE_BOUNDARY_PROMPT],
      ['side developer instructions', SIDE_DEVELOPER_INSTRUCTIONS],
      ['/init prompt', INIT_PROMPT],
    ] as const) {
      expect(binary.includes(Buffer.from(text, 'utf8')), name).toBe(true)
    }
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
