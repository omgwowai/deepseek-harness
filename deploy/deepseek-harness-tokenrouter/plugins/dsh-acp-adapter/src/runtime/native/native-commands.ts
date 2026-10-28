/**
 * The static slash-command tables of the supported vendor versions, by transport kind. Each table is owned by
 * its transport (`transports/<kind>-commands.ts`); this index is how the runtime and the host reach them without
 * knowing the vendors. A started transport reports the vendor's live catalog on top of its table, and a session
 * that has no process yet (not started, or restarted) still shows the table.
 */
import { CLAUDE_NATIVE_COMMANDS } from './transports/claude-commands.ts'
import { CODEX_NATIVE_COMMANDS } from './transports/codex-commands.ts'
import { OMP_NATIVE_COMMANDS } from './transports/omp-commands.ts'
import type { NativeCommand, NativeTransportKind } from './transports/contract.ts'

const STATIC_COMMANDS: Readonly<Record<NativeTransportKind, readonly NativeCommand[]>> = {
  claude: CLAUDE_NATIVE_COMMANDS,
  codex: CODEX_NATIVE_COMMANDS,
  omp: OMP_NATIVE_COMMANDS,
}

/** The built-in commands of one vendor; the shared table, never to be mutated. */
export function staticNativeCommands(kind: NativeTransportKind): readonly NativeCommand[] {
  return STATIC_COMMANDS[kind]
}
