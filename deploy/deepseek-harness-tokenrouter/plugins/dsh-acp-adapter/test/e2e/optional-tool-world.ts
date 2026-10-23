import type {} from '@deepseek-ai/dsh-plugin-manager'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AcpRemoteService } from '../../src/remote/service.ts'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { launchAdapterWorld, root } from './scaffold.ts'
import type { OptionalBundle } from './scaffold.ts'
import { required } from './required.ts'
import { OPTIONAL_TOOL_PLAN } from '../mock-agent/optional-tools-turn.ts'
import type { OptionalToolPlan, OptionalToolRecord } from '../mock-agent/optional-tools-turn.ts'

/** Real Loader + native Session controller; only the external ACP Agent is scripted. */
export async function launchOptionalToolWorld(
  optionalBundles: readonly OptionalBundle[],
  fixture: {
    profile?: string
    script?: string
    env?: Record<string, string>
  } = {},
) {
  const host = await launchAdapterWorld({ optionalBundles, toolsMode: 'native' })
  try {
    const resultsPath = join(host.workspaceCwd, 'optional-tools-results.jsonl')
    const agentLog = join(host.workspaceCwd, 'optional-agent.log')
    const profile = fixture.profile ?? 'devin'
    await host.ctx.settings.replace('dsh-acp-adapter', {
      toolApprovalDefault: 'auto',
      agents: {
        [profile]: {
          name: 'Official optional tools fixture',
          command: process.execPath,
          args: [fixture.script ?? join(root, 'test/mock-agent/mock-agent.ts')],
          env: {
            HOME: host.workspaceCwd,
            MOCK_SCENARIO: 'regression',
            MOCK_PROFILE: profile,
            MOCK_OPTIONAL_TOOL_RESULTS: resultsPath,
            MOCK_LOG: agentLog,
            ...fixture.env,
          },
        },
      },
    })
    await vi.waitFor(() => expect(host.ctx.llm.listProviders().some((item) => item.id === `acp-${profile}`)).toBe(true))
    await host.ctx.agentDefaultModel.saveSelection({ provider: `acp-${profile}`, model: 'mock-model-a' })
    for (const name of optionalBundles) {
      expect(
        (await host.ctx.pluginManager.listBundles()).find(
          (bundle) => bundle.name === `@deepseek-ai/dsh-experimental-${name}`,
        ),
      ).toMatchObject({ enabled: true })
    }
    const nativeCalls: { owner: string | undefined; name: string; value: unknown; isError: boolean }[] = []
    host.ctx.on('tools/post-execute', async (exec, result, next) => {
      nativeCalls.push({
        owner: exec.agent?.id,
        name: exec.name,
        value: result.value,
        isError: result.isError === true,
      })
      return next()
    })
    const records = (label: string): OptionalToolRecord[] =>
      (existsSync(resultsPath) ? readFileSync(resultsPath, 'utf8').trim().split('\n').filter(Boolean) : [])
        .map((line) => JSON.parse(line) as OptionalToolRecord)
        .filter((record) => record.label === label)
    const create = async (cwd = host.workspaceCwd): Promise<Agent> => {
      const { sessionId } = await host.ctx.sessionController.create({ cwd })
      const resolved = await host.ctx.sessionController.resolveAgent(sessionId)
      if ('error' in resolved) throw new Error(resolved.error.message)
      return resolved.agent
    }
    const run = async (agent: Agent, plan: OptionalToolPlan): Promise<OptionalToolRecord[]> => {
      const before = agent.session.snapshotEvents().filter((event) => event.type === 'turn/end').length
      await host.ctx.sessionController.prompt(
        {
          requestId: randomUUID() as SessionRequestId,
          sessionId: agent.id,
          mode: 'queue',
          content: [{ type: 'text', text: `${OPTIONAL_TOOL_PLAN}${JSON.stringify(plan)}` }],
        },
        new AbortController().signal,
      )
      try {
        await vi.waitFor(
          () =>
            expect(agent.session.snapshotEvents().filter((event) => event.type === 'turn/end').length).toBeGreaterThan(
              before,
            ),
          { timeout: 30_000 },
        )
      } catch (error) {
        const directory = join(root, '.local/optional-host-tools-evidence')
        mkdirSync(directory, { recursive: true })
        writeFileSync(
          join(directory, `${plan.label.replaceAll(/[^A-Za-z0-9_-]/g, '_')}.json`),
          JSON.stringify(
            {
              plan,
              sessionId: agent.id,
              status: agent.status,
              before,
              approvalPolicy: host.ctx.approval.overrideOf(agent.session),
              records: records(plan.label),
              events: agent.session.snapshotEvents(),
              agentLog: existsSync(agentLog) ? readFileSync(agentLog, 'utf8') : '',
            },
            null,
            2,
          ),
        )
        throw error
      }
      expect(
        required(agent.session.snapshotEvents().findLast((event) => event.type === 'turn/end')).data.reason,
      ).toMatchObject({ kind: 'completed' })
      const result = records(plan.label)
      expect(result.filter((record) => record.kind === 'failure')).toEqual([])
      expect(result.filter((record) => record.kind === 'complete')).toHaveLength(1)
      return result
    }
    return {
      ...host,
      create,
      run,
      records,
      nativeCalls,
      controls: host.ctx.get('dshAcp') as AcpRemoteService,
    }
  } catch (error) {
    await host.close()
    throw error
  }
}

export function callResult(records: readonly OptionalToolRecord[], name: string) {
  const record = required(records.find((entry) => entry.kind === 'call' && entry.name === name))
  const result = record.result as { isError?: boolean; content: { type: string; text?: string }[] }
  return {
    isError: result.isError === true,
    text: result.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n'),
  }
}
