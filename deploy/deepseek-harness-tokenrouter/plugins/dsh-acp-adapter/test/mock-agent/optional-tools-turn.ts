import type { MockPeer, MockSession, PromptMessage } from './types.ts'
import { appendFileSync, existsSync, watch } from 'node:fs'
import { dirname } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

export interface OptionalToolStep {
  name: string
  arguments?: Record<string, unknown>
  /** Test-owned gate: cancelling this one MCP call must not cancel the ACP turn. */
  cancelFile?: string
}

export interface OptionalToolPlan {
  label: string
  calls: OptionalToolStep[]
}

export interface OptionalToolRecord {
  label: string
  acpSessionId: string
  cwd: string
  kind: 'directory' | 'call' | 'permission' | 'cancelled' | 'complete' | 'failure'
  name?: string
  names?: string[]
  result?: unknown
  error?: string
}

export const OPTIONAL_TOOL_PLAN = 'E2E_OPTIONAL_TOOL_PLAN '

/** Watch an explicit test gate, with no time-based cancellation of the tool under test. */
function cancelAtFile(file: string, controller: AbortController): () => void {
  const watcher = watch(dirname(file), () => {
    if (existsSync(file)) controller.abort(new Error('Fixture requested MCP cancellation'))
  })
  watcher.on('error', (error) => controller.abort(error))
  if (existsSync(file)) controller.abort(new Error('Fixture requested MCP cancellation'))
  return () => watcher.close()
}

/** The fixture chooses calls; the real session MCP server owns discovery, execution and results. */
export async function optionalToolsTurn(session: MockSession, msg: PromptMessage, peer: MockPeer): Promise<boolean> {
  const text = msg.params.prompt
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  const line = text.split('\n').find((candidate) => candidate.startsWith(OPTIONAL_TOOL_PLAN))
  if (line === undefined) return false
  const plan = JSON.parse(line.slice(OPTIONAL_TOOL_PLAN.length)) as OptionalToolPlan
  const output = process.env.MOCK_OPTIONAL_TOOL_RESULTS
  if (output === undefined) throw new Error('MOCK_OPTIONAL_TOOL_RESULTS is required')
  const record = (entry: Omit<OptionalToolRecord, 'label' | 'acpSessionId' | 'cwd'>) =>
    appendFileSync(
      output,
      `${JSON.stringify({ label: plan.label, acpSessionId: session.id, cwd: session.cwd, ...entry })}\n`,
    )
  const controller = new AbortController()
  session.turn = {
    cancelled: false,
    cancel() {
      this.cancelled = true
      controller.abort(new Error('ACP turn cancelled'))
    },
  }
  const client = new Client({ name: 'optional-host-tool-fixture', version: '1' })
  try {
    const server = session.mcpServers?.[0]
    if (server === undefined) throw new Error('ACP session has no DSH MCP server')
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
    record({ kind: 'directory', names })
    for (const [index, step] of plan.calls.entries()) {
      if (!names.includes(step.name)) throw new Error(`Official tool missing from tools/list: ${step.name}`)
      const toolCall = {
        toolCallId: `optional-${plan.label}-${index}`,
        name: `mcp__${server.name}__${step.name}`,
        title: `Calling ${step.name} from ${server.name}`,
        kind: 'other',
        status: 'pending',
        rawInput: step.arguments ?? {},
      }
      peer.sendUpdate(session.id, { sessionUpdate: 'tool_call', ...toolCall })
      const answer = await peer.sendAgentRequest('session/request_permission', {
        sessionId: session.id,
        toolCall,
        options: [
          { optionId: 'allow', kind: 'allow_once', name: 'Allow this operation' },
          { optionId: 'deny', kind: 'reject_once', name: 'Reject this operation' },
        ],
      })
      record({ kind: 'permission', name: step.name, result: answer })
      if (answer.outcome.optionId !== 'allow') {
        peer.sendUpdate(session.id, {
          sessionUpdate: 'tool_call_update',
          toolCallId: toolCall.toolCallId,
          status: 'failed',
        })
        continue
      }
      const callController = new AbortController()
      const stopWatching = step.cancelFile === undefined ? undefined : cancelAtFile(step.cancelFile, callController)
      try {
        const result = await client.callTool(
          { name: step.name, arguments: step.arguments ?? {} },
          { signal: AbortSignal.any([controller.signal, callController.signal]) },
        )
        record({ kind: 'call', name: step.name, result })
        peer.sendUpdate(session.id, {
          sessionUpdate: 'tool_call_update',
          toolCallId: toolCall.toolCallId,
          status: result.isError === true ? 'failed' : 'completed',
          rawOutput: result,
        })
      } catch (error) {
        if (!callController.signal.aborted && !controller.signal.aborted) throw error
        record({ kind: 'cancelled', name: step.name, error: error instanceof Error ? error.message : String(error) })
        peer.sendUpdate(session.id, {
          sessionUpdate: 'tool_call_update',
          toolCallId: toolCall.toolCallId,
          status: 'failed',
        })
      } finally {
        stopWatching?.()
      }
    }
    record({ kind: 'complete' })
    peer.sendUpdate(session.id, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `E2E_OPTIONAL_DONE ${plan.label}` },
    })
    peer.respond(msg.id, { stopReason: controller.signal.aborted ? 'cancelled' : 'end_turn' })
  } catch (error) {
    record({ kind: 'failure', error: error instanceof Error ? error.message : String(error) })
    peer.sendUpdate(session.id, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `E2E_OPTIONAL_FAILED ${plan.label}` },
    })
    peer.respond(msg.id, { stopReason: 'end_turn' })
  } finally {
    session.turn = null
    await client.close()
  }
  return true
}
