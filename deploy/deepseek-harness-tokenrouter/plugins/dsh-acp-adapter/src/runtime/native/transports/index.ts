/** Vendor-native transport factory selection. */
import type { NativeTransport, NativeTransportKind } from './contract.ts'
import { createOmpTransport } from './omp.ts'
import { createCodexTransport } from './codex.ts'
import { createClaudeTransport } from './claude.ts'

export function createNativeTransport(kind: NativeTransportKind): NativeTransport {
  switch (kind) {
    case 'omp':
      return createOmpTransport()
    case 'codex':
      return createCodexTransport()
    case 'claude':
      return createClaudeTransport()
  }
}
