/**
 * Native launch derivation.
 *
 * A profile still describes its agent as the ACP agent it was configured with
 * (`omp acp -e …`, `node codex-acp/dist/index.js`, `node claude-agent-acp/dist/index.js`).
 * The native route drives the vendor's own CLI instead, so this module maps the
 * configured ACP launch onto the launcher the native transport extends with its
 * protocol flags:
 *
 * - omp:    the configured argv without the `acp` subcommand (`-e <extension>` is kept);
 * - codex:  `CODEX_PATH` (the profile's launcher script), else `DSH_CODEX_COMMAND`
 *           (JSON argv the launcher would run), else `codex`;
 * - claude: `CLAUDE_CODE_EXECUTABLE` (the profile's launcher script), else
 *           `DSH_CLAUDE_EXECUTABLE`, else `claude`.
 *
 * The environment is the host-prepared `prepareLaunch` environment (explicit profile
 * entries plus the lineage headers); this module never reads the host process
 * environment, working directory or PATH. Binaries are resolved by the host subprocess
 * seam when the transport spawns them, exactly like the ACP route.
 */
import type { AcpRuntimeConfig, AcpRuntimeLaunch } from '../session/session-runtime.ts'
import type { NativeTransportKind } from './transports/contract.ts'

/** The configured ACP launch the native argv is derived from. */
export interface NativeLaunchSource {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/** A prepared native launch: launcher argv (executable first) and explicit environment entries. */
export interface NativeLaunch {
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value
}

function executableName(command: string): string {
  const name = command.split(/[\\/]/).pop() ?? command
  return name.toLowerCase().replace(/\.(?:exe|cmd|bat)$/, '')
}

/** `DSH_CODEX_COMMAND` is the JSON argv the codex launcher script runs. */
function commandArray(value: string): string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((item): item is string => typeof item === 'string' && item !== '')
    )
      return parsed
  } catch {
    /* not a JSON command array */
  }
  return undefined
}

function ompArgv(source: NativeLaunchSource): string[] {
  const subcommand = source.args.indexOf('acp')
  const args =
    subcommand < 0 ? source.args : [...source.args.slice(0, subcommand), ...source.args.slice(subcommand + 1)]
  return [source.command, ...args]
}

function codexArgv(source: NativeLaunchSource): string[] {
  const launcher = nonEmpty(source.env['CODEX_PATH'])
  if (launcher !== undefined) return [launcher]
  const configured = nonEmpty(source.env['DSH_CODEX_COMMAND'])
  if (configured !== undefined) return commandArray(configured) ?? [configured]
  return [executableName(source.command) === 'codex' ? source.command : 'codex']
}

function claudeArgv(source: NativeLaunchSource): string[] {
  const launcher = nonEmpty(source.env['CLAUDE_CODE_EXECUTABLE'])
  if (launcher !== undefined) return [launcher]
  const configured = nonEmpty(source.env['DSH_CLAUDE_EXECUTABLE'])
  if (configured !== undefined) return [configured]
  return [executableName(source.command) === 'claude' ? source.command : 'claude']
}

/** Pure derivation of the native launcher argv from one configured ACP launch. */
export function nativeLaunchArgv(kind: NativeTransportKind, source: NativeLaunchSource): string[] {
  switch (kind) {
    case 'omp':
      return ompArgv(source)
    case 'codex':
      return codexArgv(source)
    case 'claude':
      return claudeArgv(source)
  }
}

/**
 * Run the host's launch preparation (environment policy, lineage headers) and derive the
 * native launcher from its result.
 */
export async function prepareNativeLaunch(input: {
  readonly kind: NativeTransportKind
  readonly config: AcpRuntimeConfig
  readonly cwd: string
  readonly prepareLaunch: (config: AcpRuntimeConfig, cwd: string) => Promise<AcpRuntimeLaunch>
}): Promise<NativeLaunch> {
  const launch = await input.prepareLaunch(input.config, input.cwd)
  // Native agents host no DSH MCP tools: a lease prepared anyway would otherwise outlive the launch.
  if (launch.mcpLease !== undefined) await launch.mcpLease.close().catch(() => undefined)
  const [command, ...args] = launch.argv
  if (command === undefined) throw new Error('the native agent launch has no command')
  return { argv: nativeLaunchArgv(input.kind, { command, args, env: launch.env }), env: launch.env }
}
