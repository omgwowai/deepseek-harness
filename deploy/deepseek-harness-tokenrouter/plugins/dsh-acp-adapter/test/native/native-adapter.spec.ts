/**
 * The real AcpProfileAdapter driving NativeSessionRuntime over an in-memory vendor transport:
 * the lifecycle the desktop app runs (bind, saved mode, model convergence, restore, restart,
 * old ACP bindings, bindings of the first native preview, the pre-first-prompt mode menu).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'

import type { AcpAgentConfig } from '../../src/domain/session/agent-config.ts'
import { AcpProfileAdapter, type AcpProfileRuntime } from '../../src/host/composition/profile-adapter.ts'
import { acpConfigOptionsSnapshot } from '../../src/protocol/v1/config-options.ts'
import { ACP_INITIAL_MODE_BINDING_KEY, createAcpSidecar, type AcpSidecar } from '../../src/persistence/sidecar.ts'
import { NativeSessionRuntime } from '../../src/runtime/native/native-session-runtime.ts'
import { NATIVE_MODE_CONTRACTS } from '../../src/runtime/native/session-modes.ts'
import {
  NativeTransportError,
  selectNativeTransportKind,
  type NativeTransportKind,
} from '../../src/runtime/native/transports/contract.ts'
import type { AcpSessionRuntimeOptions } from '../../src/runtime/session/session-runtime.ts'
import { withSessionFacts } from '../support/session-facts.ts'
import { FakeNativeTransport, vendorControls, type FakePromptScript } from './support/fake-transport.ts'

const roots: string[] = []
const sidecars: AcpSidecar[] = []
afterEach(async () => {
  for (const sidecar of sidecars.splice(0)) await sidecar.dispose().catch(() => undefined)
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function newSidecar(): AcpSidecar {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-native-adapter-'))
  roots.push(root)
  const sidecar = createAcpSidecar({ root })
  sidecars.push(sidecar)
  return sidecar
}

/** The agent entries of the desktop profile, with placeholders for every credential. */
const PROFILES = {
  claude: {
    name: 'Claude Code (TokenRouter)',
    command: '/Users/test/.local/dsh/lib/node_modules/node/bin/node',
    args: ['/Users/test/dsh-agent-dag/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js'],
    env: {
      CLAUDE_CODE_EXECUTABLE: '/Users/test/dsh-agent-dag/claude-launch.mjs',
      DSH_CLAUDE_EXECUTABLE: '/Users/test/.local/bin/claude',
      PATH: '/usr/bin:/bin',
    },
    runtime: 'claude',
  },
  codex: {
    name: 'Codex (TokenRouter)',
    command: '/Users/test/.local/dsh/lib/node_modules/node/bin/node',
    args: ['/Users/test/dsh-agent-dag/node_modules/@agentclientprotocol/codex-acp/dist/index.js'],
    env: { CODEX_PATH: '/Users/test/dsh-agent-dag/codex-launch.mjs', PATH: '/usr/bin:/bin' },
    runtime: 'codex',
  },
  omp: {
    name: 'Oh My Pi (TokenRouter)',
    command: '/Users/test/.bun/bin/omp',
    args: ['acp', '-e', '/Users/test/dsh-agent-dag/omp-link-headers.js'],
    env: { PI_CODING_AGENT_DIR: '/Users/test/.omp/agent', PATH: '/usr/bin:/bin' },
  },
} satisfies Record<NativeTransportKind, AcpAgentConfig>

const MODELS = {
  claude: ['default', 'opus', 'sonnet'],
  codex: ['gpt-6-astra', 'gpt-5.5'],
  omp: ['tokenrouter/claude-opus-5.5', 'tokenrouter/gpt-5.5'],
} satisfies Record<NativeTransportKind, string[]>

type SessionEvent = { type: string; seq: number; data: unknown }

/** One DSH session: its event log grows one user step per `say`. */
class Conversation {
  readonly events: SessionEvent[] = []
  readonly session
  private turns = 0

  constructor(readonly sessionId: string) {
    this.session = withSessionFacts({
      id: sessionId,
      header: { cwd: os.tmpdir() },
      inheritedEventCount: 0,
      events: this.events,
      snapshotEvents: () => [...this.events],
      append: (type: string, data: unknown) => {
        const event = { type, seq: this.events.length + 1, data }
        this.events.push(event)
        return event
      },
    })
  }

  say(content: string): UserMessage {
    this.turns += 1
    const message = createUserMessage({ content: [{ type: 'text', text: content }], source: { kind: 'user' } })
    const base = this.events.length
    this.events.push(
      { type: 'step/start', seq: base + 1, data: { turn: this.turns, step: 0 } },
      { type: 'user/message', seq: base + 2, data: message },
    )
    return message
  }
}

const answers =
  (reply: string): FakePromptScript =>
  async (context) => {
    context.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } })
    return {
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 30, cachedWriteTokens: 10, thoughtTokens: 5 },
    }
  }

/** One vendor, one sidecar, and every adapter and native transport created over them. */
class World {
  readonly transports: FakeNativeTransport[] = []
  readonly restores: string[] = []
  private readonly adapters: AcpProfileAdapter[] = []
  script: FakePromptScript = answers('ok')

  constructor(
    readonly sidecar: AcpSidecar,
    readonly kind: NativeTransportKind,
  ) {}

  /** The runtime the registry builds for a native profile. */
  nativeRuntime(options: AcpSessionRuntimeOptions): AcpProfileRuntime {
    const runtime = new NativeSessionRuntime({
      ...options,
      createTransport: () => {
        const transport = new FakeNativeTransport({ kind: this.kind })
        transport.promptScript = this.script
        this.transports.push(transport)
        return transport
      },
    })
    const restore = runtime.restore.bind(runtime)
    runtime.restore = async (binding, signal) => {
      const how = await restore(binding, signal)
      this.restores.push(how)
      return how
    }
    return runtime
  }

  adapter(
    conversation: Conversation,
    runtimeFactory: (options: AcpSessionRuntimeOptions) => AcpProfileRuntime = (options) => this.nativeRuntime(options),
    nativeKindOf: typeof selectNativeTransportKind = selectNativeTransportKind,
  ): AcpProfileAdapter {
    const kind = this.kind
    const sidecar = this.sidecar
    const adapter = new AcpProfileAdapter(
      kind,
      () => PROFILES[kind],
      { ok: true, seam: undefined as never },
      () => conversation.session,
      {
        begin: (record) => sidecar.beginDispatch(record as never),
        settle: (id, key) => sidecar.settleDispatch(id as never, key),
        read: (id, key) => sidecar.readDispatch(id as never, key),
      },
      () => ({
        async listModels() {
          return MODELS[kind].map((id) => ({ id, name: id, provider: `acp-${kind}` }))
        },
      }),
      runtimeFactory,
      sidecar,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      nativeKindOf,
    )
    this.adapters.push(adapter)
    return adapter
  }

  async say(
    adapter: AcpProfileAdapter,
    conversation: Conversation,
    content: string,
    model: string = MODELS[this.kind][0]!,
  ): Promise<StreamChunk[]> {
    const message = conversation.say(content)
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream(
      markAgentLoopRequest({
        provider: `acp-${this.kind}`,
        model,
        sessionId: conversation.sessionId as never,
        messages: [message],
      }),
    ))
      chunks.push(chunk)
    return chunks
  }

  async close(): Promise<void> {
    await Promise.all(this.adapters.splice(0).map((adapter) => adapter.close()))
  }
}

const textOf = (chunks: readonly StreamChunk[]): string =>
  chunks.map((chunk) => (chunk.type === 'text-delta' ? chunk.text : '')).join('')

/** What the ACP route recorded for a session: a plain runtime that reports a vendor session id and its controls. */
function acpEraRuntime(init: {
  readonly sessionId: string
  readonly agent: { readonly name: string; readonly version: string }
  readonly modes: readonly { readonly id: string; readonly name: string }[]
  readonly models: readonly string[]
}): AcpProfileRuntime {
  let mode = init.modes[0]?.id ?? 'default'
  return {
    acpSessionId: init.sessionId,
    agentInfo: init.agent,
    protocolVersion: 1,
    agentCapabilities: { sessionCapabilities: { resume: {} } },
    get configOptions() {
      return acpConfigOptionsSnapshot([
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: init.models[0] ?? 'default',
          options: init.models.map((value) => ({ value, name: value })),
        },
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: mode,
          options: init.modes.map(({ id, name }) => ({ value: id, name })),
        },
      ])
    },
    get modes() {
      return { currentModeId: mode, availableModes: init.modes.map(({ id, name }) => ({ id, name })) }
    },
    get currentModeId() {
      return mode
    },
    start: async () => undefined,
    restore: async () => 'resumed',
    setConfigOption: async (id, value) => {
      if (id === 'mode' && typeof value === 'string') mode = value
    },
    prompt: async (_content, onUpdate) => {
      onUpdate({
        sessionId: init.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'acp era reply' } },
      })
      return { stopReason: 'end_turn' }
    },
    close: async () => undefined,
  }
}

describe('AcpProfileAdapter over NativeSessionRuntime', () => {
  it('runs two turns on one session: saved mode, model convergence, reuse, usage', async () => {
    const world = new World(newSidecar(), 'claude')
    world.script = answers('first answer')
    const conversation = new Conversation('native-two-turns')
    const adapter = world.adapter(conversation)
    try {
      await world.sidecar.writeModeIntent('native-two-turns' as never, {
        bindingKey: ACP_INITIAL_MODE_BINDING_KEY,
        modeId: 'bypassPermissions',
      })
      const first = await world.say(adapter, conversation, 'first question', 'opus')

      const transport = world.transports[0]!
      expect(world.transports).toHaveLength(1)
      expect(transport.calls).toEqual(['start:new', 'set:model=opus', 'set:mode=bypassPermissions', 'prompt'])
      expect(transport.startOptions).toMatchObject({
        argv: ['/Users/test/dsh-agent-dag/claude-launch.mjs'],
        session: { kind: 'new' },
      })
      expect(transport.startOptions?.cwd).toBe(fs.realpathSync.native(os.tmpdir()))
      expect(transport.startOptions?.env).toMatchObject({
        CLAUDE_CODE_EXECUTABLE: '/Users/test/dsh-agent-dag/claude-launch.mjs',
        DSH_CLAUDE_EXECUTABLE: '/Users/test/.local/bin/claude',
      })
      expect(textOf(first)).toBe('first answer')
      expect(first.filter((chunk) => chunk.type === 'usage')).toEqual([
        {
          type: 'usage',
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 160,
            cacheReadTokens: 30,
            cacheWriteTokens: 10,
            reasoningTokens: 5,
          },
        },
      ])
      expect(first.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      expect(await world.sidecar.readLatestBinding('native-two-turns' as never)).toMatchObject({
        status: 'ok',
        binding: {
          provider: 'acp-claude',
          agentSessionId: 'claude-session-new',
          agent: { name: 'claude', version: '1.0.0' },
          protocolVersion: 1,
        },
      })
      expect(await world.sidecar.readModeIntent('native-two-turns' as never)).toBeUndefined()
      const snapshot = await world.sidecar.readOptionSnapshot('native-two-turns' as never)
      expect(snapshot?.currentModeId).toBe('bypassPermissions')
      expect(snapshot?.modes?.availableModes.map((mode) => mode.id)).toEqual(
        NATIVE_MODE_CONTRACTS.claude.modes.map((mode) => mode.id),
      )
      expect(await adapter.agentSessionSnapshot('native-two-turns')).toMatchObject({
        freshness: 'live',
        currentModeId: 'bypassPermissions',
      })

      transport.promptScript = answers('second answer')
      const second = await world.say(adapter, conversation, 'second question', 'sonnet')
      expect(world.restores).toEqual(['reused'])
      expect(world.transports).toHaveLength(1)
      expect(transport.calls.slice(4)).toEqual(['set:model=sonnet', 'prompt'])
      expect(textOf(second)).toBe('second answer')
      expect(second.filter((chunk) => chunk.type === 'usage')).toHaveLength(1)
    } finally {
      await world.close()
    }
  })

  it('resumes the saved vendor session after a restart and keeps the binding id', async () => {
    const world = new World(newSidecar(), 'codex')
    world.script = answers('before restart')
    const conversation = new Conversation('native-restart')
    try {
      const adapter = world.adapter(conversation)
      await world.say(adapter, conversation, 'hello')
      await adapter.close()
      expect(await world.sidecar.readLatestBinding('native-restart' as never)).toMatchObject({
        status: 'ok',
        binding: { agentSessionId: 'codex-session-new' },
      })

      const restarted = world.adapter(conversation)
      await world.say(restarted, conversation, 'welcome back', 'gpt-5.5')
      const resumed = world.transports[1]!
      expect(world.transports).toHaveLength(2)
      expect(world.restores).toEqual(['resumed'])
      expect(resumed.startOptions).toMatchObject({
        argv: ['/Users/test/dsh-agent-dag/codex-launch.mjs'],
        session: { kind: 'resume', sessionId: 'codex-session-new' },
      })
      expect(resumed.calls).toEqual(['start:resume', 'set:model=gpt-5.5', 'prompt'])
      expect(await world.sidecar.readLatestBinding('native-restart' as never)).toMatchObject({
        status: 'ok',
        binding: { agentSessionId: 'codex-session-new' },
      })
    } finally {
      await world.close()
    }
  })

  it('restores a binding the ACP route saved with the vendor session id', async () => {
    const world = new World(newSidecar(), 'claude')
    const conversation = new Conversation('native-acp-era')
    try {
      const acp = world.adapter(conversation, () =>
        acpEraRuntime({
          sessionId: '4b1c2d3e-aaaa-4bbb-8ccc-0123456789ab',
          agent: { name: '@agentclientprotocol/claude-agent-acp', version: '0.93.0' },
          modes: [
            { id: 'default', name: 'Manual' },
            { id: 'bypassPermissions', name: 'Bypass permissions' },
          ],
          models: MODELS.claude,
        }),
      )
      await world.say(acp, conversation, 'under ACP')
      await acp.close()
      await world.sidecar.writeModeIntent('native-acp-era' as never, {
        bindingKey: ACP_INITIAL_MODE_BINDING_KEY,
        modeId: 'bypassPermissions',
      })

      const chunks = await world.say(world.adapter(conversation), conversation, 'now native')
      expect(textOf(chunks)).toBe('ok')
      expect(world.restores).toEqual(['resumed'])
      expect(world.transports[0]?.startOptions?.session).toEqual({
        kind: 'resume',
        sessionId: '4b1c2d3e-aaaa-4bbb-8ccc-0123456789ab',
      })
      expect(world.transports[0]?.calls).toEqual(['start:resume', 'set:mode=bypassPermissions', 'prompt'])
      expect(await world.sidecar.readModeIntent('native-acp-era' as never)).toBeUndefined()
      expect(await world.sidecar.readLatestBinding('native-acp-era' as never)).toMatchObject({
        binding: { agentSessionId: '4b1c2d3e-aaaa-4bbb-8ccc-0123456789ab', agent: { version: '0.93.0' } },
      })
    } finally {
      await world.close()
    }
  })

  describe('a binding whose session the vendor cannot resume', () => {
    const PREVIEW = {
      claude: 'native-claude-b948d6a4-e266-43b4-8504-6952698de42f',
      codex: 'native-codex-3c392f16-a6ed-4955-9815-ae3b83b599e4',
    } as const

    /** Bind a session the way the ACP route (or the first native preview) did, then set how many prompts it committed. */
    async function bind(
      world: World,
      conversation: Conversation,
      init: {
        readonly sessionId: string
        readonly agent: { readonly name: string; readonly version: string }
        readonly modes: readonly { readonly id: string; readonly name: string }[]
        readonly ordinal: number
        readonly intent?: string
      },
    ): Promise<void> {
      const acp = world.adapter(conversation, () =>
        acpEraRuntime({
          sessionId: init.sessionId,
          agent: init.agent,
          modes: init.modes,
          models: MODELS[world.kind],
        }),
      )
      await world.say(acp, conversation, 'under ACP')
      await acp.close()
      const saved = await world.sidecar.readLatestBinding(conversation.sessionId as never)
      if (saved?.status !== 'ok') throw new Error('the binding was not written')
      await world.sidecar.append(conversation.sessionId as never, {
        kind: 'binding',
        data: { ...saved.binding, committedPromptOrdinal: init.ordinal },
      })
      if (init.intent !== undefined)
        await world.sidecar.writeModeIntent(conversation.sessionId as never, {
          bindingKey: ACP_INITIAL_MODE_BINDING_KEY,
          modeId: init.intent,
        })
    }

    const modesOf = (kind: 'claude' | 'codex') =>
      NATIVE_MODE_CONTRACTS[kind].modes.map(({ id, name }) => ({ id, name }))

    it.each([
      ['claude', 'bypassPermissions'],
      ['codex', 'agent-full-access'],
    ] as const)(
      'continues a first-preview %s session that never dispatched a prompt, with no click and its saved mode',
      async (kind, intent) => {
        const world = new World(newSidecar(), kind)
        world.script = answers('continued')
        const conversation = new Conversation(`preview-${kind}`)
        try {
          await bind(world, conversation, {
            sessionId: PREVIEW[kind],
            agent: { name: kind, version: '0.0.0-native' },
            modes: modesOf(kind),
            ordinal: 0,
            intent,
          })
          const transcriptBefore = structuredClone(conversation.events)
          const adapter = world.adapter(conversation)
          const chunks = await world.say(adapter, conversation, 'continue')

          expect(textOf(chunks)).toBe('continued')
          expect(world.restores).toEqual([])
          expect(world.transports).toHaveLength(1)
          expect(world.transports[0]?.calls).toEqual(['start:new', `set:mode=${intent}`, 'prompt'])
          expect(await world.sidecar.readModeIntent(conversation.sessionId as never)).toBeUndefined()
          expect(await world.sidecar.readLatestBinding(conversation.sessionId as never)).toMatchObject({
            status: 'ok',
            binding: { agentSessionId: `${kind}-session-new`, generation: 2, bindingEpoch: 2 },
          })
          expect(await world.sidecar.readRecoveryState(conversation.sessionId as never)).toMatchObject({
            kind: 'healthy',
            generation: 2,
          })
          // The DSH transcript keeps every event of the earlier turn exactly as it was.
          expect(JSON.stringify(conversation.events.slice(0, transcriptBefore.length))).toBe(
            JSON.stringify(transcriptBefore),
          )

          const again = await world.say(adapter, conversation, 'and again')
          expect(textOf(again)).toBe('continued')
          expect(world.restores).toEqual(['reused'])
          expect(world.transports).toHaveLength(1)
        } finally {
          await world.close()
        }
      },
    )

    it('keeps the session-lost gate for a first-preview id once a prompt was committed, until the user rebinds', async () => {
      const world = new World(newSidecar(), 'claude')
      world.script = answers('continued')
      const conversation = new Conversation('preview-committed')
      try {
        await bind(world, conversation, {
          sessionId: PREVIEW.claude,
          agent: { name: 'claude', version: '0.0.0-native' },
          modes: modesOf('claude'),
          ordinal: 2,
          intent: 'bypassPermissions',
        })
        const adapter = world.adapter(conversation)
        await expect(world.say(adapter, conversation, 'continue')).rejects.toMatchObject({
          code: 'ACP_SESSION_NOT_FOUND',
        })
        expect(world.transports[0]?.calls).toEqual([])
        expect(await world.sidecar.readRecoveryState('preview-committed' as never)).toMatchObject({
          kind: 'session-lost',
          cause: 'id-not-found',
        })
        // The saved mode is a valid choice of the native route: only the lost session blocks the conversation.
        expect(await world.sidecar.readModeIntent('preview-committed' as never)).toMatchObject({
          modeId: 'bypassPermissions',
        })

        await adapter.rebindBlank('preview-committed')
        const chunks = await world.say(adapter, conversation, 'start over')
        expect(textOf(chunks)).toBe('continued')
        expect(world.transports.at(-1)?.calls).toEqual(['start:new', 'set:mode=bypassPermissions', 'prompt'])
        expect(await world.sidecar.readLatestBinding('preview-committed' as never)).toMatchObject({
          binding: { agentSessionId: 'claude-session-new', generation: 2 },
        })
      } finally {
        await world.close()
      }
    })

    it('keeps the recovery gate of a first-preview id whose dispatch outcome is unknown', async () => {
      const world = new World(newSidecar(), 'claude')
      const conversation = new Conversation('preview-unknown')
      try {
        await bind(world, conversation, {
          sessionId: PREVIEW.claude,
          agent: { name: 'claude', version: '0.0.0-native' },
          modes: modesOf('claude'),
          ordinal: 0,
        })
        await world.sidecar.writeRecoveryState({
          dshSessionId: 'preview-unknown' as never,
          kind: 'outcome-unknown',
          cause: 'load-failed',
          detail: 'a dispatch never settled',
          provider: 'acp-claude',
          acpSessionId: PREVIEW.claude,
          generation: 1,
          updatedAt: Date.now(),
        })
        await expect(world.say(world.adapter(conversation), conversation, 'continue')).rejects.toMatchObject({
          code: 'ACP_RECOVERY_REQUIRED',
        })
        expect(world.transports[0]?.calls ?? []).toEqual([])
      } finally {
        await world.close()
      }
    })

    it('keeps the session-lost gate for a vendor session that is simply gone, even before its first committed prompt', async () => {
      const world = new World(newSidecar(), 'omp')
      const conversation = new Conversation('vendor-gone')
      try {
        await bind(world, conversation, {
          sessionId: 'omp-session-gone',
          agent: { name: 'omp', version: '18.10.4' },
          modes: [{ id: 'default', name: 'Default' }],
          ordinal: 0,
        })
        const native = world.adapter(
          conversation,
          (options) =>
            new NativeSessionRuntime({
              ...options,
              createTransport: () => {
                const transport = new FakeNativeTransport({ kind: 'omp' })
                transport.startError = new NativeTransportError(
                  'OMP session not found: omp-session-gone',
                  'session-not-found',
                )
                return transport
              },
            }),
        )
        await expect(world.say(native, conversation, 'resume please')).rejects.toMatchObject({
          code: 'ACP_SESSION_NOT_FOUND',
        })
        expect(await world.sidecar.readRecoveryState('vendor-gone' as never)).toMatchObject({
          kind: 'session-lost',
          cause: 'id-not-found',
        })
        expect(await world.sidecar.readLatestBinding('vendor-gone' as never)).toMatchObject({
          binding: { agentSessionId: 'omp-session-gone', generation: 1 },
        })
      } finally {
        await world.close()
      }
    })
  })

  describe('the mode menu before the first prompt', () => {
    async function seedAcpEra(
      world: World,
      sessionId: string,
      modes: readonly { id: string; name: string }[],
    ): Promise<void> {
      const conversation = new Conversation(sessionId)
      const adapter = world.adapter(
        conversation,
        () =>
          acpEraRuntime({
            sessionId: `${sessionId}-agent`,
            agent: { name: 'acp-agent', version: '1' },
            modes,
            models: MODELS[world.kind],
          }),
        () => undefined,
      )
      await world.say(adapter, conversation, 'under ACP')
      await adapter.close()
    }

    const ids = (view: { readonly modes: readonly { readonly id: string }[] | null } | null): string[] =>
      view?.modes?.map((mode) => mode.id) ?? []

    it('drops a plan mode an ACP-era OMP session recorded but the native route cannot apply', async () => {
      const world = new World(newSidecar(), 'omp')
      try {
        await seedAcpEra(world, 'omp-acp-era', [
          { id: 'default', name: 'Default' },
          { id: 'plan', name: 'Plan' },
        ])
        const adapter = world.adapter(new Conversation('omp-draft'))
        expect(ids(await adapter.draftSessionSnapshot('omp-draft'))).toEqual(['default'])
        await expect(adapter.setDraftMode('omp-draft', 'plan')).rejects.toMatchObject({
          code: 'ACP_CONFIG_UNSUPPORTED',
        })
        expect((await adapter.setDraftMode('omp-draft', 'default'))?.currentModeId).toBe('default')
        // The same snapshot still serves a profile that runs over ACP.
        const acp = world.adapter(new Conversation('omp-acp-draft'), undefined, () => undefined)
        expect(ids(await acp.draftSessionSnapshot('omp-acp-draft'))).toEqual(['default', 'plan'])
      } finally {
        await world.close()
      }
    })

    it('keeps the full Codex list the ACP agent recorded', async () => {
      const world = new World(newSidecar(), 'codex')
      try {
        await seedAcpEra(
          world,
          'codex-acp-era',
          NATIVE_MODE_CONTRACTS.codex.modes.map(({ id, name }) => ({ id, name })),
        )
        const draft = await world.adapter(new Conversation('codex-draft')).draftSessionSnapshot('codex-draft')
        expect(ids(draft)).toEqual(['read-only', 'workspace-write', 'agent', 'agent-full-access'])
        expect(draft).toMatchObject({ freshness: 'stale', modeWritable: true, currentModeId: null })
      } finally {
        await world.close()
      }
    })

    it('offers the native contract when nothing usable was recorded', async () => {
      const worlds = {
        claude: new World(newSidecar(), 'claude'),
        omp: new World(newSidecar(), 'omp'),
        codex: new World(newSidecar(), 'codex'),
      }
      try {
        const menu = async (world: World): Promise<string[]> =>
          ids(await world.adapter(new Conversation('fresh')).draftSessionSnapshot('fresh'))
        expect(await menu(worlds.claude)).toEqual(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'])
        expect(await menu(worlds.omp)).toEqual(['default'])
        expect(await menu(worlds.codex)).toEqual(['read-only', 'workspace-write', 'agent', 'agent-full-access'])
        // A snapshot that names no mode the route knows is as good as none.
        await seedAcpEra(worlds.codex, 'codex-legacy', [
          { id: 'auto', name: 'Auto' },
          { id: 'full-access', name: 'Full access' },
        ])
        expect(await menu(worlds.codex)).toEqual(['read-only', 'workspace-write', 'agent', 'agent-full-access'])
        const chosen = await worlds.codex.adapter(new Conversation('fresh')).setDraftMode('fresh', 'agent-full-access')
        expect(chosen?.currentModeId).toBe('agent-full-access')
        expect(await worlds.codex.sidecar.readModeIntent('fresh' as never)).toEqual({
          bindingKey: ACP_INITIAL_MODE_BINDING_KEY,
          modeId: 'agent-full-access',
        })
      } finally {
        await Promise.all(Object.values(worlds).map((world) => world.close()))
      }
    })
  })

  it('exposes every vendor control the moment a session is bound', async () => {
    for (const kind of ['claude', 'codex', 'omp'] as const) {
      const world = new World(newSidecar(), kind)
      const conversation = new Conversation(`controls-${kind}`)
      try {
        const adapter = world.adapter(conversation)
        await world.say(adapter, conversation, 'hi')
        const live = await adapter.agentSessionSnapshot(`controls-${kind}`)
        expect(live.configOptions?.map((option) => option.id)).toEqual(
          vendorControls(kind).configOptions.map((option) => option.id),
        )
        const contract = NATIVE_MODE_CONTRACTS[kind]
        expect(live.modes?.map((mode) => mode.id)).toEqual(
          contract.modes.filter((mode) => !contract.unavailable.includes(mode.id)).map((mode) => mode.id),
        )
      } finally {
        await world.close()
      }
    }
  })
})
