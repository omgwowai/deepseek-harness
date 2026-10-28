/** Fresh-child ACP fixture for the shipped Ralph + spawn + structured-output stack. */
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

type Id = number | string
type Server =
  | { type: 'http'; url: string }
  | { type?: 'stdio'; command: string; args: string[]; env: { name: string; value: string }[] }
interface Frame {
  id?: Id
  method?: string
  params?: { sessionId?: string; cwd?: string; mcpServers?: Server[]; prompt?: { type: string; text?: string }[] }
}
const sessions = new Map<string, { servers: Server[]; cancelled: boolean }>()
let sequence = 0
const configOptions = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'mock-model-a',
    options: [{ value: 'mock-model-a', name: 'Offline Ralph fixture' }],
  },
]
function log(value: unknown) {
  if (process.env.RALPH_FIXTURE_LOG) appendFileSync(process.env.RALPH_FIXTURE_LOG, `${JSON.stringify(value)}\n`)
}
function send(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}
function respond(id: Id, result: unknown) {
  send({ jsonrpc: '2.0', id, result })
}
function text(sessionId: string, value: string) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } } },
  })
}
async function prompt(frame: Frame, id: Id) {
  const sessionId = frame.params?.sessionId
  if (!sessionId) throw new Error('Missing ACP session')
  const session = sessions.get(sessionId)
  if (!session) throw new Error('Missing fresh ACP session state')
  session.cancelled = false
  const promptText = (frame.params?.prompt ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
  log({ kind: 'prompt', sessionId, text: promptText })
  if (!promptText.includes('You are one fresh worker in a foreground Ralph loop.')) {
    text(sessionId, 'RALPH_PARENT_HISTORY_MARKER')
  } else if (promptText.includes('RALPH_CANCEL_OBJECTIVE')) {
    log({ kind: 'held-child', sessionId })
    while (!session.cancelled) await new Promise((resolve) => setTimeout(resolve, 20))
  } else {
    const server = session.servers[0]
    if (!server) throw new Error('Fresh Ralph child has no native DSH MCP bridge')
    const client = new Client({ name: 'ralph-acp-fixture', version: '1' })
    try {
      await client.connect(
        server.type === 'http'
          ? new StreamableHTTPClientTransport(new URL(server.url))
          : new StdioClientTransport({
              command: server.command,
              args: server.args,
              env: Object.fromEntries(server.env.map((entry) => [entry.name, entry.value])),
              stderr: 'pipe',
            }),
      )
      const names = (await client.listTools()).tools.map((tool) => tool.name)
      if (!names.includes('structured_output'))
        throw new Error(`Fresh child lacks structured_output: ${JSON.stringify(names)}`)
      const first = promptText.includes('Ralph round: 1 of ')
      const report = {
        status: first ? 'continue' : 'complete',
        summary: first ? 'RALPH_ROUND_ONE_HANDOFF' : 'RALPH_COMPLETE_REPORT',
        evidence: [first ? 'Fixture round one completed.' : 'Fixture structured completion recorded.'],
        nextSteps: first ? ['Finish the second fixture round.'] : [],
        blocker: '',
      }
      const result = await client.callTool({ name: 'structured_output', arguments: report })
      log({ kind: 'structured-output', sessionId, names, report, result })
      if (result.isError) throw new Error(`Native structured output failed: ${JSON.stringify(result)}`)
    } finally {
      await client.close()
    }
  }
  respond(id, { stopReason: session.cancelled ? 'cancelled' : 'end_turn' })
}

createInterface({ input: process.stdin }).on('line', (line) => {
  void (async () => {
    const frame = JSON.parse(line) as Frame
    if (frame.method === 'session/cancel') {
      const session = sessions.get(frame.params?.sessionId ?? '')
      if (session) session.cancelled = true
      log({ kind: 'cancel', sessionId: frame.params?.sessionId })
      if (frame.id !== undefined) respond(frame.id, {})
      return
    }
    if (frame.id === undefined) return
    if (frame.method === 'initialize')
      respond(frame.id, {
        protocolVersion: 1,
        authMethods: [],
        agentInfo: { name: 'ralph-acp-fixture', version: '1' },
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: { http: true, sse: false },
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          sessionCapabilities: { delete: {}, list: {} },
        },
      })
    else if (frame.method === 'session/new' || frame.method === 'session/load') {
      const sessionId = frame.params?.sessionId ?? `ralph-${process.pid}-${++sequence}`
      sessions.set(sessionId, { servers: frame.params?.mcpServers ?? [], cancelled: false })
      log({ kind: frame.method, sessionId, cwd: frame.params?.cwd })
      respond(frame.id, { ...(frame.method === 'session/new' ? { sessionId } : {}), configOptions })
    } else if (frame.method === 'session/prompt') await prompt(frame, frame.id)
    else if (frame.method === 'session/set_config_option') respond(frame.id, { configOptions })
    else if (frame.method === 'session/list') respond(frame.id, { sessions: [] })
    else respond(frame.id, {})
  })().catch((error: unknown) => {
    log({ kind: 'error', error: String(error) })
    process.stderr.write(`${String(error)}\n`)
    process.exitCode = 1
  })
})
