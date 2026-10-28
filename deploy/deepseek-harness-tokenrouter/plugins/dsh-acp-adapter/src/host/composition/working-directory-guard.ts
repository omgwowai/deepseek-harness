import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { acpAgentIdFromRoute } from '../../domain/session/agent-config.ts'

/** The native guard also covers PTC inner calls, before any Git or cwd side effect. */
export function installWorkingDirectoryGuard(
  ctx: Context,
  adapterFor: (profileId: string) =>
    | {
        workingDirectoryChangeDenial(sessionId: string, owner: object): string | undefined
      }
    | undefined,
): void {
  ctx.inject(['tools'], (child) =>
    child.tools.guard((exec) => {
      if (exec.agent === undefined) return
      const changesDirectory =
        exec.name === 'working_directory' &&
        typeof exec.arguments === 'object' &&
        exec.arguments !== null &&
        !Array.isArray(exec.arguments) &&
        'cd' in exec.arguments &&
        exec.arguments.cd !== undefined
      if (exec.name !== 'create_worktree' && !changesDirectory) return
      const provider = exec.agent.session.requestHeader()?.config.provider ?? exec.agent.options.provider
      const profileId = provider === undefined ? undefined : acpAgentIdFromRoute(provider)
      if (profileId === undefined) return
      const adapter = adapterFor(profileId)
      return adapter === undefined
        ? 'ACP_WORKING_DIRECTORY_UNAVAILABLE: The ACP route is unavailable; the working directory was not changed.'
        : adapter.workingDirectoryChangeDenial(exec.agent.id, exec.agent.session)
    }),
  )
}
