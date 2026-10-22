/** ACP fork fixture: private conversation state survives replacement Agent processes. */
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type {
  ClientResults,
  MockPeer,
  MockRequest,
  MockSession,
  PromptMessage,
  RpcId,
} from '../../../mock-agent/types.ts'
import { OPTIONAL_TOOL_PLAN, optionalToolsTurn } from '../../../mock-agent/optional-tools-turn.ts'
import type { OptionalToolPlan } from '../../../mock-agent/optional-tools-turn.ts'

export interface WorktreePlan extends OptionalToolPlan {
  remember?: string
  afterDirectoryChange?: { marker: string; file: string; content: string }
}
interface State {
  id: string
  cwd: string
  history: string[]
  afterDirectoryChange?: WorktreePlan['afterDirectoryChange']
  forkedFrom?: string
}
interface Frame extends MockRequest {
  result?: unknown
  error?: unknown
}
const output = process.env.MOCK_OPTIONAL_TOOL_RESULTS
if (output === undefined) throw new Error('MOCK_OPTIONAL_TOOL_RESULTS is required')
const stateDirectory = join(dirname(output), 'worktree-agent-state')
const logPath = join(dirname(output), 'worktree-agent-events.jsonl')
mkdirSync(stateDirectory, { recursive: true })
const sessions = new Map<string, MockSession>()
const pending = new Map<RpcId, { resolve: (result: unknown) => void; reject: (error: unknown) => void }>()
const configOptions = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select' as const,
    currentValue: 'mock-model-a',
    options: [{ value: 'mock-model-a', name: 'Offline Worktree fixture' }],
  },
]
function log(value: unknown) {
  appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, ...(value as object) })}\n`)
}
function send(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}
function respond(id: RpcId, result: unknown) {
  send({ jsonrpc: '2.0', id, result })
}
function statePath(id: string) {
  if (!/^worktree-[a-f0-9-]+$/.test(id)) throw new Error('Invalid fixture session id')
  return join(stateDirectory, `${id}.json`)
}
function load(id: string): State {
  return JSON.parse(readFileSync(statePath(id), 'utf8')) as State
}
function save(state: State) {
  writeFileSync(statePath(state.id), JSON.stringify(state))
}
function attach(state: State, frame: Frame) {
  sessions.set(state.id, {
    id: state.id,
    cwd: state.cwd,
    modes: null,
    configOptions,
    turn: null,
    closed: false,
    mcpServers: frame.params?.mcpServers ?? [],
  })
}
const peer: MockPeer = {
  sendUpdate(sessionId, update) {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } })
  },
  sendAgentRequest<M extends keyof ClientResults>(
    method: M,
    params: Record<string, unknown>,
  ): Promise<ClientResults[M]> {
    const id = randomUUID()
    const result = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }))
    send({ jsonrpc: '2.0', id, method, params })
    return result as Promise<ClientResults[M]>
  },
  respond,
  log(message) {
    log({ kind: 'agent-log', message })
  },
}
async function prompt(frame: Frame) {
  const id = frame.params?.sessionId
  if (id === undefined) throw new Error('Missing ACP session id')
  const session = sessions.get(id)
  if (session === undefined) throw new Error('ACP session was not attached')
  const state = load(id)
  const text = (frame.params?.prompt ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  log({ kind: 'prompt', sessionId: id, cwd: session.cwd, text, history: state.history })
  if (state.forkedFrom !== undefined && state.afterDirectoryChange !== undefined) {
    const instruction = state.afterDirectoryChange
    if (!text.includes('The working directory changed from '))
      throw new Error('Fork did not receive the native directory notice')
    if (!state.history.includes(instruction.marker)) throw new Error('Fork lost private Agent history')
    if (realpathSync(process.cwd()) !== session.cwd)
      throw new Error('Replacement process was not launched in the new cwd')
    const file = join(session.cwd, instruction.file)
    writeFileSync(file, instruction.content)
    delete state.afterDirectoryChange
    save(state)
    log({
      kind: 'continued-write',
      sessionId: id,
      cwd: session.cwd,
      file,
      history: state.history,
      parentId: state.forkedFrom,
    })
    peer.sendUpdate(id, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'WORKTREE_FORK_CONTINUED' },
    })
    respond(frame.id, { stopReason: 'end_turn' })
    return
  }
  const line = text.split('\n').find((candidate) => candidate.startsWith(OPTIONAL_TOOL_PLAN))
  if (line !== undefined) {
    const plan = JSON.parse(line.slice(OPTIONAL_TOOL_PLAN.length)) as WorktreePlan
    if (plan.remember !== undefined) state.history.push(plan.remember)
    if (plan.afterDirectoryChange !== undefined) state.afterDirectoryChange = plan.afterDirectoryChange
    save(state)
    if (await optionalToolsTurn(session, frame as PromptMessage, peer)) return
  }
  peer.sendUpdate(id, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'WORKTREE_FIXTURE_IDLE' },
  })
  respond(frame.id, { stopReason: 'end_turn' })
}
async function handle(frame: Frame) {
  if (frame.method === undefined) {
    const request = pending.get(frame.id)
    if (request !== undefined) {
      pending.delete(frame.id)
      if (frame.error === undefined) request.resolve(frame.result)
      else request.reject(frame.error)
    }
    return
  }
  if (frame.method === 'session/cancel') {
    sessions.get(frame.params?.sessionId ?? '')?.turn?.cancel()
    for (const [id, request] of pending) {
      request.resolve({ outcome: { outcome: 'cancelled' } })
      pending.delete(id)
    }
    log({ kind: 'cancel', sessionId: frame.params?.sessionId })
    if (frame.id !== undefined) respond(frame.id, {})
    return
  }
  if (frame.id === undefined) return
  if (frame.method === 'initialize')
    respond(frame.id, {
      protocolVersion: 1,
      authMethods: [],
      agentInfo: { name: 'worktree-fixture', version: '1' },
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: true, sse: false },
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        sessionCapabilities: {
          list: {},
          delete: {},
          ...(process.env.WORKTREE_FIXTURE_FORK === '1' ? { fork: {} } : {}),
        },
      },
    })
  else if (frame.method === 'session/new') {
    const state: State = {
      id: `worktree-${randomUUID()}`,
      cwd: realpathSync(frame.params?.cwd ?? process.cwd()),
      history: [],
    }
    save(state)
    attach(state, frame)
    log({ kind: 'session/new', sessionId: state.id, cwd: state.cwd })
    respond(frame.id, { sessionId: state.id, configOptions })
  } else if (frame.method === 'session/fork') {
    if (process.env.WORKTREE_FIXTURE_FORK !== '1') throw new Error('Unsupported session/fork')
    const parent = load(frame.params?.sessionId ?? '')
    const state: State = {
      ...parent,
      id: `worktree-${randomUUID()}`,
      cwd: realpathSync(frame.params?.cwd ?? process.cwd()),
      forkedFrom: parent.id,
    }
    save(state)
    attach(state, frame)
    log({ kind: 'session/fork', sessionId: state.id, parentId: parent.id, cwd: state.cwd, history: state.history })
    respond(frame.id, { sessionId: state.id, configOptions })
  } else if (frame.method === 'session/load') {
    const state = load(frame.params?.sessionId ?? '')
    if (state.cwd !== realpathSync(frame.params?.cwd ?? process.cwd()))
      throw new Error('session/load cannot change cwd')
    attach(state, frame)
    log({ kind: 'session/load', sessionId: state.id, cwd: state.cwd })
    respond(frame.id, { configOptions })
  } else if (frame.method === 'session/prompt') await prompt(frame)
  else if (frame.method === 'session/set_config_option') respond(frame.id, { configOptions })
  else if (frame.method === 'session/list') respond(frame.id, { sessions: [] })
  else respond(frame.id, {})
}
createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line) as Frame
  void handle(frame).catch((error: unknown) => {
    log({ kind: 'error', error: String(error) })
    if (frame.id !== undefined) send({ jsonrpc: '2.0', id: frame.id, error: { code: -32603, message: String(error) } })
    else process.stderr.write(`${String(error)}\n`)
  })
})
