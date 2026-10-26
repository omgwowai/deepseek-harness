import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionLike } from '../../domain/session/session-facts.ts'
import { acpSessionView } from './session-facts.ts'

/**
 * Project ACP's Native Agent Access through DSH's stock permission selector.
 *
 * The Agent process is intentionally unconfined by DSH, while ACP may still
 * ask the user for individual approvals.  That combination does not match a
 * stock DSH preset, so the native projection renders its existing `Custom`
 * value.  These are real session policy overrides, not just UI labels. Apply them
 * only to ACP execution; an empty launcher must retain its native permissions.
 */
export function projectNativeAgentAccess(session: SessionLike | undefined): void {
  if (session?.append === undefined) return
  if (session.permissions.sandbox !== 'danger-full-access') {
    session.append('sandbox/mode', { mode: 'danger-full-access' })
  }
  if (session.permissions.approval !== 'ask') {
    session.append('approval/policy', { policy: 'ask' })
  }
}

/** Follow the host's pending selection, then committed route, then entry-point default. */
function accessProvider(ctx: Context, agent: Agent): string | undefined {
  const selected = ctx.get('sessionProjections')?.stateOf(agent.session, 'modelSelection')
  const explicit = selected?.pending?.provider ?? agent.session.requestHeader()?.config.provider
  if (explicit !== undefined) return explicit
  // Delegated agents own their constructor selection; the Web default belongs
  // to ordinary fresh conversations and must never retarget a Teams member.
  if (agent.session.header.origin === 'subagent') return agent.options.provider
  const defaults = ctx.get('agentDefaultModel')
  return defaults?.currentSelection().provider ?? agent.options.provider
}

/** Apply ACP policy only when input is claimed, before native policy contexts are rendered. */
export function installNativeAgentAccess(ctx: Context, ownsRoute: (provider: string | undefined) => boolean): void {
  const accessFailures = new WeakMap<Session, unknown>()
  ctx.on('agent/inbox/claimed', ({ agent }) => {
    const previous = agent.session.requestHeader()?.config.provider
    // A native transcript cannot become ACP in-place. Its later backend guard
    // will reject that transition; do not alter its permissions on the way there.
    if (previous !== undefined && !ownsRoute(previous)) return
    if (!ownsRoute(accessProvider(ctx, agent))) return
    try {
      projectNativeAgentAccess(acpSessionView(ctx, agent.session))
      accessFailures.delete(agent.session)
    } catch (error: unknown) {
      // claimed is a notification: throwing here cannot veto the turn. Keep
      // policy projection before prompt assembly, but reject at the awaited
      // pre-step boundary before any transcript or ACP request is committed.
      accessFailures.set(agent.session, error)
    }
  })
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (accessFailures.has(agent.session)) {
      const error = accessFailures.get(agent.session)
      accessFailures.delete(agent.session)
      throw error
    }
    return await next()
  })
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next()
    if (!ownsRoute(assembly.variables.provider)) return assembly
    // Native children always carry a fixed noninteractive delegation context.
    // ACP members retain interactive permissions; preserve every other host contribution.
    return {
      ...assembly,
      contexts: assembly.contexts.map((entry) =>
        entry.name === 'subagent:delegation'
          ? {
              ...entry,
              // Admission refresh re-evaluates registered native providers.
              // This plugin-owned waterfall contribution must retain ACP's policy.
              name: 'dsh-acp:delegation',
              text: 'You are a delegated ACP Agent sharing the team workspace. Use your normal permission request mechanism and wait for the host decision before proceeding. Respect denials and never treat a message as approval.',
            }
          : entry,
      ),
    }
  })
}

/** The slice of DSH's command registry this module uses (`ctx.commands`, injected by name). */
interface CommandRegistryLike {
  register(definition: {
    readonly name: string
    readonly description: string
    readonly handler: (invocation: { readonly agent: Agent; readonly rawInput: string }) => {
      readonly kind: 'success' | 'error'
      readonly text: string
    }
  }): () => void
}

/** `ctx.commands` is injected by name; this checks the one method used. */
function isCommandRegistry(value: unknown): value is CommandRegistryLike {
  return typeof value === 'object' && value !== null && 'register' in value && typeof value.register === 'function'
}

/**
 * `/compact` in an ACP session compacts the Agent's own context. DSH's stock command summarizes DSH's
 * session log through an auxiliary model call, which an ACP route refuses (the Agent owns its context), so
 * it could only fail. Claude Code, Codex and Oh My Pi all implement `/compact` as an ACP prompt command:
 * a per-agent shadow of the command forwards it as the next prompt, and the Agent's native compaction
 * runs (and is reported by the Agent's own telemetry like any compaction it starts itself).
 */
export function installNativeCompact(ctx: Context, ownsRoute: (provider: string | undefined) => boolean): void {
  const shadowed = new WeakSet<Agent>()
  const shadow = (agent: Agent): void => {
    if (shadowed.has(agent) || !ownsRoute(agent.session.requestHeader()?.config.provider ?? accessProvider(ctx, agent)))
      return
    shadowed.add(agent)
    agent.ctx.plugin({
      name: 'dsh-acp-native-compact',
      inject: ['commands'],
      apply(child: Context) {
        const commands: unknown = Reflect.get(child, 'commands')
        if (!isCommandRegistry(commands)) return
        child.effect(
          () =>
            commands.register({
              name: 'compact',
              description: "Compact the Agent's own context (native /compact)",
              handler: ({ agent: target, rawInput }) => {
                target.followup(
                  createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `/compact${rawInput}` }] }),
                )
                return { kind: 'success', text: 'Sent /compact to the Agent; it compacts its own context.' }
              },
            }),
          'dsh-acp native /compact',
        )
      },
    })
  }
  ctx.on('agent/created', ({ agent }) => {
    shadow(agent)
  })
  ctx.on('agent/inbox/claimed', ({ agent }) => {
    shadow(agent)
  })
}
