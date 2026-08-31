/**
 * Milestone-boundary trigger, exercised through the composed controller: real
 * agents append real `todo/write` events and the plugin's own watcher decides
 * whether a round starts. The round is observed at `ctx.subagents.start`,
 * which is the first thing a triggered round does.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import TokenRouterRollout from '@deepseek-ai/dsh-tokenrouter-rollout'
import { resolveConfig } from '@deepseek-ai/dsh-tokenrouter-rollout/src/config.ts'

/** Todo shape mirroring the todo/write payload. */
interface Todo {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** An adapter that is never called: the watcher path reaches no model. */
class SilentAdapter extends LlmAdapter {
  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('the milestone watcher must not drive the model')
  }
}

interface Harness {
  ctx: Context
  /** One `label` per worker the plugin tried to spawn. */
  started: string[]
  /** Create an agent; `subagent: true` gives it a child session header. */
  agent(id: string, options?: { subagent?: boolean }): Promise<Agent>
  dispose(): Promise<void>
}

async function harness(settings: { autoMilestone: boolean }): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new SilentAdapter())

  const started: string[] = []
  // A round that gets this far has passed every watcher decision; hanging the
  // result keeps the round from reaching the judge, which is not under test.
  ctx.provide('subagents')
  ctx.set('subagents', {
    start(_provider: string, request: { label: string }) {
      started.push(request.label)
      return Promise.resolve({
        id: request.label,
        localAgent: undefined,
        result: new Promise(() => {}),
        dispose: () => Promise.resolve(),
      })
    },
  } as never)

  // Resolved rather than partial: the Loader validates against `static Config`
  // and hands the plugin a complete one, so the composed test does the same.
  await ctx.plugin(TokenRouterRollout, resolveConfig({
    enabled: true,
    judgeBaseURL: 'http://judge.invalid/v1',
    rolloutCount: 1,
    autoMilestone: settings.autoMilestone,
  }))

  const handles: { dispose(): Promise<void> }[] = []
  return {
    ctx,
    started,
    async agent(id, options) {
      const handle = await ctx.agents.create({
        sessionId: SessionId(id),
        agentOptions: { provider: 'mock', model: 'mock' },
        ...options?.subagent === true ? { meta: { origin: 'subagent' as const } } : {},
      })
      handles.push(handle)
      return handle.agent
    },
    async dispose() {
      for (const handle of handles) await handle.dispose()
      await ctx.fiber.dispose()
    },
  }
}

/** Append a todo/write and let the synchronous watcher run. */
async function writeTodos(agent: Agent, todos: Todo[]): Promise<void> {
  agent.session.append('todo/write', { todos })
  await Promise.resolve()
}

describe('milestone watcher', () => {
  it('starts a round when a milestone completes and another stays pending', async () => {
    const h = await harness({ autoMilestone: true })
    try {
      const agent = await h.agent('session-milestone')
      await writeTodos(agent, [
        { content: 'design API', status: 'in_progress' },
        { content: 'implement core', status: 'pending' },
      ])
      expect(h.started).toEqual([])
      await writeTodos(agent, [
        { content: 'design API', status: 'completed' },
        { content: 'implement core', status: 'pending' },
      ])
      expect(h.started).toEqual(['rollout-0'])
    } finally {
      await h.dispose()
    }
  })

  it('ignores a completion with no pending milestone left', async () => {
    const h = await harness({ autoMilestone: true })
    try {
      const agent = await h.agent('session-final')
      await writeTodos(agent, [{ content: 'design API', status: 'in_progress' }])
      await writeTodos(agent, [{ content: 'design API', status: 'completed' }])
      expect(h.started).toEqual([])
    } finally {
      await h.dispose()
    }
  })

  it('ignores an already-completed milestone re-reported', async () => {
    // A pending milestone remains throughout, so only the completed-status
    // diff can decide: an unchanged `completed` entry is not a new boundary.
    const h = await harness({ autoMilestone: true })
    try {
      const agent = await h.agent('session-repeat')
      await writeTodos(agent, [
        { content: 'design API', status: 'completed' },
        { content: 'implement core', status: 'pending' },
        { content: 'write tests', status: 'pending' },
      ])
      await writeTodos(agent, [
        { content: 'design API', status: 'completed' },
        { content: 'implement core', status: 'in_progress' },
        { content: 'write tests', status: 'pending' },
      ])
      expect(h.started).toEqual([])
    } finally {
      await h.dispose()
    }
  })

  it('does not recurse when a worker subagent completes its own milestone', async () => {
    // `session/event` is global, so a rollout worker's todo/write reaches this
    // watcher too. Without the origin guard each round would spawn further
    // rounds off its own children.
    const h = await harness({ autoMilestone: true })
    try {
      const child = await h.agent('session-child', { subagent: true })
      await writeTodos(child, [
        { content: 'draft plan', status: 'in_progress' },
        { content: 'refine plan', status: 'pending' },
      ])
      await writeTodos(child, [
        { content: 'draft plan', status: 'completed' },
        { content: 'refine plan', status: 'pending' },
      ])
      expect(h.started).toEqual([])
    } finally {
      await h.dispose()
    }
  })

  it('stays inert while autoMilestone is off', async () => {
    const h = await harness({ autoMilestone: false })
    try {
      const agent = await h.agent('session-off')
      await writeTodos(agent, [
        { content: 'design API', status: 'in_progress' },
        { content: 'implement core', status: 'pending' },
      ])
      await writeTodos(agent, [
        { content: 'design API', status: 'completed' },
        { content: 'implement core', status: 'pending' },
      ])
      expect(h.started).toEqual([])
    } finally {
      await h.dispose()
    }
  })
})
