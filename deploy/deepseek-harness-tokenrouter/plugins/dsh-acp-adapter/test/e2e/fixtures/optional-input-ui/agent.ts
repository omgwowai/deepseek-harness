/** Offline ACP transport fixture; stdout contains JSON-RPC frames only. */
import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

type Id = number | string
interface Frame {
  id?: Id
  method?: string
  params?: { sessionId?: string; prompt?: { type: string; text?: string }[] }
  result?: unknown
}
const sessions = new Map<string, { cancelled: boolean }>()
const pending = new Map<Id, (value: unknown) => void>()
let sequence = 0
const configOptions = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'mock-model-a',
    options: [{ value: 'mock-model-a', name: 'Offline optional UI fixture' }],
  },
]
function send(frame: unknown) {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}
function respond(id: Id, result: unknown) {
  send({ jsonrpc: '2.0', id, result })
}
function chunk(sessionId: string, text: string, thought = false) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: thought ? 'agent_thought_chunk' : 'agent_message_chunk',
        content: { type: 'text', text },
      },
    },
  })
}
async function prompt(frame: Frame, id: Id) {
  const sessionId = frame.params?.sessionId
  if (!sessionId) throw new Error('Expected ACP session id')
  const turn = { cancelled: false }
  sessions.set(sessionId, turn)
  const text = (frame.params?.prompt ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
  if (process.env.OPTIONAL_UI_LOG)
    appendFileSync(process.env.OPTIONAL_UI_LOG, `${JSON.stringify({ text, blocks: frame.params?.prompt })}\n`)
  if (text.includes('COT_STREAM') || text.includes('COT_CANCEL')) {
    const cancel = text.includes('COT_CANCEL')
    chunk(
      sessionId,
      cancel ? 'Cancel paragraph.\n\nUnfinished cancel tail' : 'First paragraph.\n\nUnfinished tail',
      true,
    )
    const gate = join(process.env.OPTIONAL_UI_GATE ?? '.', cancel ? 'cancel' : 'continue')
    while (!turn.cancelled && !existsSync(gate)) await new Promise((resolve) => setTimeout(resolve, 20))
    if (!turn.cancelled) {
      chunk(sessionId, ' completed.', true)
      chunk(sessionId, 'COT_DONE')
    }
  } else if (text.includes('OPTIONAL_UI_PERMISSION')) {
    const permissionId = `permission-${++sequence}`
    const permission = new Promise<unknown>((resolve) => pending.set(permissionId, resolve))
    send({
      jsonrpc: '2.0',
      id: permissionId,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: { toolCallId: 'interaction_00000001', title: 'Choose a fixture option', rawInput: {} },
        options: [
          { optionId: 'alpha', name: 'ALPHA', kind: 'allow_once' },
          { optionId: 'beta', name: 'BETA', kind: 'allow_once' },
        ],
      },
    })
    await permission
    if (!turn.cancelled) chunk(sessionId, 'PERMISSION_DONE')
  } else {
    chunk(sessionId, 'VOICE_DONE')
  }
  respond(id, { stopReason: turn.cancelled ? 'cancelled' : 'end_turn' })
}

const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  void (async () => {
    const frame = JSON.parse(line) as Frame
    if (frame.method === undefined) {
      if (frame.id !== undefined) {
        pending.get(frame.id)?.(frame.result)
        pending.delete(frame.id)
      }
      return
    }
    if (frame.method === 'session/cancel') {
      const turn = sessions.get(frame.params?.sessionId ?? '')
      if (turn) turn.cancelled = true
      for (const [id, resolve] of pending) {
        resolve({ outcome: { outcome: 'cancelled' } })
        pending.delete(id)
      }
      if (frame.id !== undefined) respond(frame.id, {})
      return
    }
    if (frame.id === undefined) return
    if (frame.method === 'initialize') {
      respond(frame.id, {
        protocolVersion: 1,
        authMethods: [],
        agentInfo: { name: 'optional-ui-fixture', version: '1.0.0' },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          mcpCapabilities: { http: false, sse: false },
          sessionCapabilities: { list: {}, delete: {} },
        },
      })
    } else if (frame.method === 'session/new') {
      respond(frame.id, { sessionId: `optional-ui-${++sequence}`, configOptions })
    } else if (frame.method === 'session/load' || frame.method === 'session/set_config_option') {
      respond(frame.id, { configOptions })
    } else if (frame.method === 'session/list') {
      respond(frame.id, { sessions: [] })
    } else if (frame.method === 'session/prompt') {
      await prompt(frame, frame.id)
    } else {
      respond(frame.id, {})
    }
  })().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`)
    process.exitCode = 1
  })
})
