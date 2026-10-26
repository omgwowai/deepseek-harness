/// <reference types="node" />
/**
 * Native agent processes go through the host subprocess seam, exactly like ACP
 * agents: the host merges the explicit profile environment onto its scrubbed
 * parent environment and owns process-tree termination.
 */
import type { SubprocessSeam } from '../process/subprocess.ts'
import { NativeTransportError, type NativeProcess, type NativeSpawn } from './transports/contract.ts'

/** Grace the host waits between its terminate escalation steps. */
const NATIVE_TERMINATE_GRACE_MS = 2_000

export function nativeSpawnFromSeam(seam: SubprocessSeam, graceMs: number = NATIVE_TERMINATE_GRACE_MS): NativeSpawn {
  return (spec): NativeProcess => {
    let handle
    try {
      handle = seam.spawn({ argv: spec.argv, cwd: spec.cwd, env: { ...spec.env }, graceMs })
    } catch (error) {
      throw new NativeTransportError(
        `could not launch ${spec.argv[0] ?? 'agent'}: ${error instanceof Error ? error.message : String(error)}`,
        'spawn-failed',
      )
    }
    const { stdin, stdout, stderr } = handle
    if (stdin === undefined || stdout === undefined || stderr === undefined) {
      handle.terminate()
      throw new NativeTransportError('the host subprocess service dropped a piped stream', 'spawn-failed')
    }
    const exited = handle.done.then((outcome) => ({ exitCode: outcome.exitCode, signal: outcome.signal }))
    // Launch failures surface through `exited`; an unobserved rejection must not crash the host.
    exited.catch(() => undefined)
    return { stdin, stdout, stderr, exited, terminate: () => handle.terminate() }
  }
}
