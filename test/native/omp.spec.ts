/// <reference types="node" />
/**
 * OMP native transport tests.
 *
 * The helper tests are hermetic. The final suite drives the real `omp` binary
 * (`--mode rpc-ui`, `--no-session`) through a short tool-using prompt and a
 * mid-turn steer, because the interesting protocol facts (double-ack on a
 * streaming prompt, steer confirmation, usage only at message_end) only exist
 * against a live vendor process. It skips when `omp` is not installed or when
 * `OMP_NATIVE_E2E=0` opts out.
 */
import { existsSync, accessSync, constants } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createOmpTransport,
  mapOmpPermissionOptions,
  mapOmpUsage,
  ompTransportArgs,
  OmpNativeTransport,
} from '../../src/runtime/native/transports/omp.ts'
import type {
  NativeContextUsage,
  NativePermissionDecision,
  NativePermissionRequest,
  NativeTransportEvent,
  NativeUsage,
} from '../../src/runtime/native/transports/contract.ts'

// ---------------------------------------------------------------------------
// Hermetic helpers
// ---------------------------------------------------------------------------

describe('ompTransportArgs', () => {
  it('always runs the approval-capable rpc-ui mode', () => {
    expect(ompTransportArgs([])).toEqual(['--mode', 'rpc-ui'])
    expect(ompTransportArgs(['--no-session'])).toEqual(['--mode', 'rpc-ui', '--no-session'])
    expect(ompTransportArgs(['--mode', 'rpc'])).toEqual(['--mode', 'rpc-ui'])
    expect(ompTransportArgs(['--mode=rpc', '--no-session'])).toEqual([
      '--mode',
      'rpc-ui',
      '--no-session',
    ])
    expect(ompTransportArgs(['--mode', 'rpc-ui', '--model', 'm'])).toEqual([
      '--mode',
      'rpc-ui',
      '--model',
      'm',
    ])
  })

  it('resumes through --session only when the caller did not pick a session', () => {
    expect(ompTransportArgs([], 'session-id')).toEqual(['--mode', 'rpc-ui', '--session', 'session-id'])
    expect(ompTransportArgs(['--session', 'explicit'], 'resume-me')).toEqual([
      '--mode',
      'rpc-ui',
      '--session',
      'explicit',
    ])
    expect(ompTransportArgs(['--resume', 'explicit'], 'resume-me')).toEqual([
      '--mode',
      'rpc-ui',
      '--resume',
      'explicit',
    ])
  })
})

describe('mapOmpPermissionOptions', () => {
  it('keeps every vendor option instead of assuming an Approve/Deny pair', () => {
    const options = mapOmpPermissionOptions([
      'Approve Directory: /repo',
      'Always Approve Directory: /repo',
      'Approve Once',
      'Deny',
    ])
    expect(options.map((option) => option.optionId)).toEqual([
      'Approve Directory: /repo',
      'Always Approve Directory: /repo',
      'Approve Once',
      'Deny',
    ])
    expect(options.map((option) => option.kind)).toEqual([
      'allow_once',
      'allow_always',
      'allow_once',
      'reject_once',
    ])
  })

  it('handles single-option and empty option lists', () => {
    expect(mapOmpPermissionOptions(['Approve'])).toHaveLength(1)
    expect(mapOmpPermissionOptions([])).toHaveLength(0)
  })
})

describe('mapOmpUsage', () => {
  it('maps OMP token fields and USD cost totals', () => {
    expect(
      mapOmpUsage({
        input: 146,
        output: 196,
        cacheRead: 8704,
        cacheWrite: 0,
        totalTokens: 9046,
        reasoningTokens: 126,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
      }),
    ).toEqual<NativeUsage>({
      input: 146,
      output: 196,
      cacheRead: 8704,
      cacheWrite: 0,
      total: 9046,
      reasoning: 126,
      cost: { amount: 0.25, currency: 'USD' },
    })
  })

  it('rejects payloads that carry no token accounting', () => {
    expect(mapOmpUsage(undefined)).toBeUndefined()
    expect(mapOmpUsage({})).toBeUndefined()
    expect(mapOmpUsage({ provider: 'x' })).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Live `omp` binary
// ---------------------------------------------------------------------------

function findOmp(): string | undefined {
  const explicit = process.env.OMP_COMMAND
  if (explicit !== undefined && explicit.length > 0) {
    return existsSync(explicit) ? explicit : undefined
  }
  const pathValue = process.env.PATH ?? ''
  for (const directory of pathValue.split(delimiter)) {
    if (directory.length === 0) continue
    const candidate = join(directory, 'omp')
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Keep looking.
    }
  }
  return undefined
}

function inheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  return env
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${description}`)
}

const ompCommand = findOmp()
const e2eEnabled = ompCommand !== undefined && process.env.OMP_NATIVE_E2E !== '0'

describe.skipIf(!e2eEnabled)('OmpNativeTransport against the real omp binary', () => {
  let transport: OmpNativeTransport | undefined
  let cwd: string | undefined

  afterEach(async () => {
    await transport?.close().catch(() => undefined)
    transport = undefined
    if (cwd !== undefined) await rm(cwd, { recursive: true, force: true }).catch(() => undefined)
    cwd = undefined
  })

  it(
    'runs one prompt, reports usage/context, and accepts a mid-turn steer',
    async () => {
      const events: NativeTransportEvent[] = []
      const permissionRequests: NativePermissionRequest[] = []
      const decisions: Array<'cancelled' | string> = []
      cwd = await mkdtemp(join(tmpdir(), 'omp-native-transport-'))
      transport = createOmpTransport()
      expect(transport.kind).toBe('omp')

      await transport.start({
        command: ompCommand ?? 'omp',
        args: ['--mode', 'rpc-ui', '--no-session'],
        env: inheritedEnv(),
        cwd,
        onEvent: (event) => events.push(event),
        onPermission: async (request): Promise<NativePermissionDecision> => {
          permissionRequests.push(request)
          // Approve whatever the vendor calls its positive option, even with grant labels.
          const approve =
            request.options.find((option) => /^approve|^allow|^yes/i.test(option.name)) ??
            request.options[0]
          if (approve === undefined) {
            decisions.push('cancelled')
            return { cancelled: true }
          }
          decisions.push(approve.optionId)
          return { optionId: approve.optionId }
        },
        log:
          process.env.OMP_NATIVE_DEBUG === '1'
            ? (message: string) => console.error(`[omp-native] ${message}`)
            : () => undefined,
      })

      expect(transport.sessionId).toBeTruthy()

      const controller = new AbortController()
      const promptPromise = transport.prompt(
        [
          {
            type: 'text',
            text: 'Run the bash tool once with the exact command `sleep 5` and then reply with exactly: DONE. Do not do anything else.',
          },
        ],
        controller.signal,
      )

      // Wait until a tool is actually executing, so the steer lands inside a live turn.
      await waitFor(
        () => events.some((event) => event.kind === 'tool_call'),
        120_000,
        'the agent to start a tool call',
      )
      expect(events.some((event) => event.kind === 'status' && event.busy)).toBe(true)

      const steerResult = await transport.steer([
        { type: 'text', text: 'IMPORTANT: after the tool finishes, reply with exactly: STEERED' },
      ])
      expect(steerResult).toBe('injected')

      const promptResult = await promptPromise
      expect(promptResult.stopReason).toBe('end_turn')

      const streamedText = events
        .filter((event): event is Extract<NativeTransportEvent, { kind: 'text' }> => event.kind === 'text')
        .map((event) => event.text)
        .join('')
      expect(streamedText.length).toBeGreaterThan(0)

      const usage = events.find(
        (event): event is Extract<NativeTransportEvent, { kind: 'usage' }> => event.kind === 'usage',
      )
      expect(usage).toBeDefined()
      expect(usage?.usage.total).toBeGreaterThan(0)

      // Prompt result usage mirrors the last per-message usage from message_end.
      expect(promptResult.usage?.total).toBeGreaterThan(0)

      const contextUsage: NativeContextUsage | undefined = transport.contextUsage()
      expect(contextUsage).toBeDefined()
      expect(contextUsage?.used).toBeGreaterThan(0)
      expect(contextUsage?.size).toBeGreaterThan(0)

      // The tool row closes with a completed status.
      const toolUpdate = events.find(
        (event) =>
          event.kind === 'tool_call_update' &&
          event.status === 'completed' &&
          event.toolCallId.startsWith('bash_'),
      )
      expect(toolUpdate).toBeDefined()

      if (permissionRequests.length > 0) {
        // A real approval dialog must round-trip our selected label, never a hardcoded pair.
        expect(permissionRequests.every((request) => request.options.length > 0)).toBe(true)
        expect(decisions.every((decision) => decision !== 'cancelled')).toBe(true)
      }

      await transport.close()
      await transport.close()
      expect(transport.sessionId).toBeTruthy()
    },
    180_000,
  )

  it.skipIf(process.env.OMP_NATIVE_E2E_APPROVAL !== '1')(
    'round-trips a real tool-approval select dialog',
    async () => {
      const events: NativeTransportEvent[] = []
      const approvalRequests: NativePermissionRequest[] = []
      const answered: string[] = []
      cwd = await mkdtemp(join(tmpdir(), 'omp-native-approval-'))
      transport = createOmpTransport()

      await transport.start({
        command: ompCommand ?? 'omp',
        args: ['--mode', 'rpc-ui', '--no-session', '--approval-mode=always-ask'],
        env: inheritedEnv(),
        cwd,
        onEvent: (event) => events.push(event),
        onPermission: async (request): Promise<NativePermissionDecision> => {
          approvalRequests.push(request)
          const approve = request.options.find((option) => /^approve/i.test(option.name))
          if (approve === undefined) return { cancelled: true }
          answered.push(approve.optionId)
          return { optionId: approve.optionId }
        },
        log:
          process.env.OMP_NATIVE_DEBUG === '1'
            ? (message: string) => console.error(`[omp-native] ${message}`)
            : () => undefined,
      })

      const result = await transport.prompt(
        [
          {
            type: 'text',
            text: 'Run the bash tool once with the exact command `echo OMP-APPROVAL-OK` and then reply with exactly: DONE. Do not do anything else.',
          },
        ],
        new AbortController().signal,
      )
      expect(result.stopReason).toBe('end_turn')

      // A real approval dialog reached the host and the selected label was accepted.
      expect(approvalRequests.length).toBeGreaterThan(0)
      const first = approvalRequests[0]
      expect(first?.title).toContain('Allow tool')
      expect(first?.options.some((option) => /^approve/i.test(option.name))).toBe(true)
      expect(first?.options.some((option) => /^deny/i.test(option.name))).toBe(true)
      expect(answered.length).toBe(approvalRequests.length)

      // Approving the exec tier let the tool actually run.
      expect(
        events.some(
          (event) => event.kind === 'tool_call_update' && event.status === 'completed',
        ),
      ).toBe(true)
    },
    180_000,
  )
})
