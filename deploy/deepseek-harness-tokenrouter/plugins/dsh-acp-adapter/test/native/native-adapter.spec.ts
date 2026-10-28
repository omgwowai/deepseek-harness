/**
 * The real AcpProfileAdapter driving NativeSessionRuntime over an in-memory vendor transport:
 * the lifecycle the desktop app runs (bind, saved mode, model convergence, restore, restart,
 * old ACP bindings, bindings of the first native preview, the pre-first-prompt mode menu).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage, markAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'

import type { AcpAgentConfig } from '../../src/domain/session/agent-config.ts'
import { AcpProfileAdapter, type AcpProfileRuntime } from '../../src/host/composition/profile-adapter.ts'
import { acpConfigOptionsSnapshot } from '../../src/protocol/v1/config-options.ts'
import {
  createAcpSidecar,
  initialModeIntentBindingKey,
  modeIntentBindingKey,
  type AcpSidecar,
} from '../../src/persistence/sidecar.ts'
import { NativeSessionRuntime } from '../../src/runtime/native/native-session-runtime.ts'
import { NATIVE_MODE_CONTRACTS } from '../../src/runtime/native/session-modes.ts'
import {
  NativeTransportError,
  selectNativeTransportKind,
  type NativeCommandResult,
  type NativeControls,
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

/**
 * One DSH session. DSH accepts a prompt first (the Agent turns running and the turn opens), the loop then claims the
 * input (its step starts and the message is committed), and the request reaches the adapter's stream; the turn ends
 * when the stream is done, or without one if it is cancelled.
 */
class Conversation {
  readonly events: SessionEvent[] = []
  readonly session
  private turns = 0
  private readonly turnEndListeners = new Set<() => void>()

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
      watchTurnEnd: (listener: () => void) => {
        this.turnEndListeners.add(listener)
        return () => void this.turnEndListeners.delete(listener)
      },
    })
  }

  /** DSH accepts a prompt: `turn/start` is committed ahead of any step, message or request. */
  acceptTurn(): void {
    this.turns += 1
    this.events.push({ type: 'turn/start', seq: this.events.length + 1, data: { turn: this.turns } })
  }

  /** The loop claims the input of the open turn: its step starts and the message is committed. */
  claim(content: string): UserMessage {
    const message = createUserMessage({ content: [{ type: 'text', text: content }], source: { kind: 'user' } })
    const base = this.events.length
    this.events.push(
      { type: 'step/start', seq: base + 1, data: { turn: this.turns, step: 0 } },
      { type: 'user/message', seq: base + 2, data: message },
    )
    return message
  }

  /** The turn ends, whatever became of it. */
  endTurn(): void {
    this.events.push({
      type: 'turn/end',
      seq: this.events.length + 1,
      data: { turn: this.turns, reason: { kind: 'completed' } },
    })
    for (const listener of [...this.turnEndListeners]) listener()
  }

  say(content: string): UserMessage {
    this.acceptTurn()
    return this.claim(content)
  }

  /** A row DSH logs between turns, such as the row of a command the user runs. */
  logRow(type: string): void {
    this.events.push({ type, seq: this.events.length + 1, data: {} })
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
  /** The vendor controls a new transport starts with; the kind's own when absent. */
  controls: NativeControls | undefined
  readonly runtimes: NativeSessionRuntime[] = []
  /** Runs once before the next restore of a session; lets a spec hold a turn while its prompt is being prepared. */
  beforeRestore: (() => Promise<void>) | undefined
  /** Held by the next Agent start: the first prompt has been sent, and no Agent session or binding exists yet. */
  beforeStart: (() => Promise<void>) | undefined
  /** Runs before each control write of every transport; lets a spec look at the session between its steps. */
  beforeSet: ((id: string, value: string | boolean) => Promise<void>) | undefined
  /** Runs for every transport the world creates, before it is used; lets a spec script its commands and side channel. */
  onTransport: ((transport: FakeNativeTransport) => void) | undefined

  constructor(
    readonly sidecar: AcpSidecar,
    readonly kind: NativeTransportKind,
  ) {}

  /** The runtime the registry builds for a native profile. */
  nativeRuntime(options: AcpSessionRuntimeOptions): AcpProfileRuntime {
    const runtime = new NativeSessionRuntime({
      ...options,
      createTransport: () => {
        const transport = new FakeNativeTransport({
          kind: this.kind,
          ...(this.controls === undefined ? {} : { controls: this.controls }),
        })
        transport.promptScript = this.script
        transport.beforeStart = this.beforeStart
        this.beforeStart = undefined
        transport.beforeSet = this.beforeSet
        this.onTransport?.(transport)
        this.transports.push(transport)
        return transport
      },
    })
    const restore = runtime.restore.bind(runtime)
    runtime.restore = async (binding, signal) => {
      const hold = this.beforeRestore
      this.beforeRestore = undefined
      await hold?.()
      const how = await restore(binding, signal)
      this.restores.push(how)
      return how
    }
    this.runtimes.push(runtime)
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
    return await this.dispatch(adapter, conversation, conversation.say(content), model)
  }

  /** The request for an accepted, claimed message reaches the adapter's stream, and the turn ends with it. */
  async dispatch(
    adapter: AcpProfileAdapter,
    conversation: Conversation,
    message: UserMessage,
    model: string = MODELS[this.kind][0]!,
  ): Promise<StreamChunk[]> {
    const chunks: StreamChunk[] = []
    try {
      for await (const chunk of adapter.stream(
        markAgentLoopRequest({
          provider: `acp-${this.kind}`,
          model,
          sessionId: conversation.sessionId as never,
          messages: [message],
        }),
      ))
        chunks.push(chunk)
    } finally {
      conversation.endTurn()
    }
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
        bindingKey: initialModeIntentBindingKey('acp-claude'),
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
        bindingKey: initialModeIntentBindingKey('acp-claude'),
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
          bindingKey: initialModeIntentBindingKey(`acp-${world.kind}`),
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
          bindingKey: initialModeIntentBindingKey('acp-codex'),
          modeId: 'agent-full-access',
        })
      } finally {
        await Promise.all(Object.values(worlds).map((world) => world.close()))
      }
    })

    it('keys a choice made before the first prompt by the route it was made for', async () => {
      const sidecar = newSidecar()
      const claude = new World(sidecar, 'claude')
      const codex = new World(sidecar, 'codex')
      try {
        await claude.adapter(new Conversation('keyed')).setDraftMode('keyed', 'plan')
        const saved = await sidecar.readModeIntent('keyed' as never)
        expect(saved).toEqual({ bindingKey: initialModeIntentBindingKey('acp-claude'), modeId: 'plan' })
        expect(initialModeIntentBindingKey('acp-claude')).not.toBe(initialModeIntentBindingKey('acp-codex'))
        await codex.adapter(new Conversation('keyed')).setDraftMode('keyed', 'agent')
        expect(await sidecar.readModeIntent('keyed' as never)).toEqual({
          bindingKey: initialModeIntentBindingKey('acp-codex'),
          modeId: 'agent',
        })
      } finally {
        await Promise.all([claude.close(), codex.close()])
      }
    })

    it('neither shows nor applies a choice made for another route when the composer switches (incompatible id)', async () => {
      const sidecar = newSidecar()
      const claude = new World(sidecar, 'claude')
      const codex = new World(sidecar, 'codex')
      const conversation = new Conversation('route-switch')
      try {
        const onClaude = claude.adapter(conversation)
        const onCodex = codex.adapter(conversation)
        await onClaude.setDraftMode('route-switch', 'bypassPermissions')
        expect(await onClaude.draftSessionSnapshot('route-switch')).toMatchObject({
          currentModeId: 'bypassPermissions',
        })

        // The composer moves to Codex: Claude's mode is not a choice made for Codex, and looking changes nothing.
        expect(await onCodex.draftSessionSnapshot('route-switch')).toMatchObject({
          currentModeId: null,
          pendingModeId: null,
        })
        expect(await onClaude.draftSessionSnapshot('route-switch')).toMatchObject({
          currentModeId: 'bypassPermissions',
        })

        // The first prompt goes to Codex: it starts under Codex's own mode, and nothing of Claude's is applied or fails it.
        expect(textOf(await codex.say(onCodex, conversation, 'hello codex'))).toBe('ok')
        expect(codex.transports[0]?.calls).toEqual(['start:new', 'prompt'])
        expect(claude.transports).toEqual([])
        expect(await sidecar.readModeIntent('route-switch' as never)).toBeUndefined()
      } finally {
        await Promise.all([claude.close(), codex.close()])
      }
    })

    it('attaches a fresh session when a replaced but unprompted agent conversation is lost', async () => {
      const world = new World(newSidecar(), 'codex')
      const conversation = new Conversation('unprompted-replaced')
      try {
        const first = world.adapter(conversation)
        await world.say(first, conversation, 'hello')
        world.transports[0]?.replaceSession('codex-session-2', 'new')
        await vi.waitFor(async () => {
          const lookup = await world.sidecar.readLatestBinding('unprompted-replaced' as never)
          expect(lookup?.status === 'ok' ? lookup.binding.agentSessionId : undefined).toBe('codex-session-2')
        })
        const rebound = await world.sidecar.readLatestBinding('unprompted-replaced' as never)
        expect(rebound?.status === 'ok' ? rebound.binding : undefined).toMatchObject({
          agentSessionId: 'codex-session-2',
          generation: 2,
          committedPromptOrdinal: 0,
        })
        await first.close()

        // Codex never wrote the thread it started: after the restart the vendor does not know the id.
        world.beforeStart = async () => {
          throw new NativeTransportError('Codex session not found: codex-session-2', 'session-not-found')
        }
        const restarted = world.adapter(conversation)
        expect(textOf(await world.say(restarted, conversation, 'are you still there?'))).toBe('ok')

        expect(world.transports.map((transport) => transport.startOptions?.session)).toEqual([
          { kind: 'new' },
          { kind: 'resume', sessionId: 'codex-session-2' },
          { kind: 'new' },
        ])
        const fresh = await world.sidecar.readLatestBinding('unprompted-replaced' as never)
        expect(fresh?.status === 'ok' ? fresh.binding : undefined).toMatchObject({
          agentSessionId: 'codex-session-new',
          generation: 3,
          committedPromptOrdinal: 1,
        })
        expect(await world.sidecar.readRecoveryState('unprompted-replaced' as never)).toMatchObject({ kind: 'healthy' })
      } finally {
        await world.close()
      }
    })

    it('keeps the recovery gate when a prompted session is not found', async () => {
      const world = new World(newSidecar(), 'claude')
      const conversation = new Conversation('prompted-lost')
      try {
        const first = world.adapter(conversation)
        await world.say(first, conversation, 'hello')
        world.transports[0]?.replaceSession('claude-session-2', 'clear')
        await vi.waitFor(async () => {
          const lookup = await world.sidecar.readLatestBinding('prompted-lost' as never)
          expect(lookup?.status === 'ok' ? lookup.binding.agentSessionId : undefined).toBe('claude-session-2')
        })
        await world.say(first, conversation, 'continue')
        const prompted = await world.sidecar.readLatestBinding('prompted-lost' as never)
        expect(prompted?.status === 'ok' ? prompted.binding.committedPromptOrdinal : undefined).toBe(1)
        await first.close()

        world.beforeStart = async () => {
          throw new NativeTransportError('Claude Code session not found: claude-session-2', 'session-not-found')
        }
        const restarted = world.adapter(conversation)
        await expect(world.say(restarted, conversation, 'hello')).rejects.toMatchObject({
          code: 'ACP_SESSION_NOT_FOUND',
        })

        expect(world.transports).toHaveLength(2)
        expect(await world.sidecar.readRecoveryState('prompted-lost' as never)).toMatchObject({ kind: 'session-lost' })
        const gated = await world.sidecar.readLatestBinding('prompted-lost' as never)
        expect(gated?.status === 'ok' ? gated.binding.agentSessionId : undefined).toBe('claude-session-2')
      } finally {
        await world.close()
      }
    })

    it('does not apply a mode id two routes share to the route it was not chosen for', async () => {
      const sidecar = newSidecar()
      const claude = new World(sidecar, 'claude')
      const omp = new World(sidecar, 'omp')
      try {
        // OMP running over ACP lists `plan` too; the controls it recorded give it a draft menu.
        const modes = [
          { id: 'default', name: 'Default' },
          { id: 'plan', name: 'Plan' },
        ]
        await seedAcpEra(omp, 'omp-recorded', modes)
        const conversation = new Conversation('shared-id')
        await claude.adapter(conversation).setDraftMode('shared-id', 'plan')

        let agent: AcpProfileRuntime | undefined
        const onOmp = omp.adapter(
          conversation,
          () => {
            agent = acpEraRuntime({
              sessionId: 'omp-agent',
              agent: { name: 'omp', version: '1' },
              modes,
              models: MODELS.omp,
            })
            return agent
          },
          () => undefined,
        )
        expect(await onOmp.draftSessionSnapshot('shared-id')).toMatchObject({ currentModeId: null })
        await omp.say(onOmp, conversation, 'hello omp')
        expect(agent?.currentModeId).toBe('default')
        expect(await sidecar.readModeIntent('shared-id' as never)).toBeUndefined()
      } finally {
        await Promise.all([claude.close(), omp.close()])
      }
    })

    it('drops a choice saved under the key that named no route instead of applying it to whichever route prompts first', async () => {
      const world = new World(newSidecar(), 'claude')
      const conversation = new Conversation('unrouted-initial')
      try {
        await world.sidecar.writeModeIntent('unrouted-initial' as never, {
          bindingKey: 'initial',
          modeId: 'bypassPermissions',
        })
        const adapter = world.adapter(conversation)
        expect(await adapter.draftSessionSnapshot('unrouted-initial')).toMatchObject({ currentModeId: null })
        expect(textOf(await world.say(adapter, conversation, 'hello'))).toBe('ok')
        expect(world.transports[0]?.calls).toEqual(['start:new', 'prompt'])
        expect(await world.sidecar.readModeIntent('unrouted-initial' as never)).toBeUndefined()
      } finally {
        await world.close()
      }
    })
  })

  describe('a mode chosen once the first prompt is on its way', () => {
    /** Holds the Agent's start open: the prompt was sent, but no Agent session or binding exists yet. */
    function holdStart(world: World): { readonly entered: Promise<void>; release(): void } {
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      world.beforeStart = async () => {
        entered.resolve()
        await release.promise
      }
      return { entered: entered.promise, release: () => release.resolve() }
    }

    it('waits for the second turn instead of reaching the first, and shows as pending meanwhile', async () => {
      const sessionId = 'first-turn-pending'
      const world = new World(newSidecar(), 'claude')
      const conversation = new Conversation(sessionId)
      const adapter = world.adapter(conversation)
      const start = holdStart(world)
      try {
        const first = world.say(adapter, conversation, 'first')
        await start.entered
        // The prompt is out and the Agent is still starting: no binding, so the dock still holds the draft menu.
        expect(await world.sidecar.readLatestBinding(sessionId as never)).toBeUndefined()
        const during = await adapter.setDraftMode(sessionId, 'bypassPermissions')
        expect(during).toMatchObject({ freshness: 'stale', currentModeId: null, pendingModeId: 'bypassPermissions' })
        expect(await adapter.draftSessionSnapshot(sessionId)).toMatchObject({
          currentModeId: null,
          pendingModeId: 'bypassPermissions',
        })

        start.release()
        await first
        const transport = world.transports[0]!
        // The first turn ran as it was started; the choice still waits, shown beside the mode the Agent has.
        expect(transport.calls).toEqual(['start:new', 'prompt'])
        expect(await adapter.agentSessionSnapshot(sessionId)).toMatchObject({
          freshness: 'live',
          currentModeId: 'default',
          pendingModeId: 'bypassPermissions',
        })

        transport.promptScript = answers('second answer')
        expect(textOf(await world.say(adapter, conversation, 'second'))).toBe('second answer')
        expect(transport.calls).toEqual(['start:new', 'prompt', 'set:mode=bypassPermissions', 'prompt'])
        expect(await adapter.agentSessionSnapshot(sessionId)).toMatchObject({
          currentModeId: 'bypassPermissions',
          pendingModeId: null,
        })
        expect(await world.sidecar.readModeIntent(sessionId as never)).toBeUndefined()
      } finally {
        start.release()
        await world.close()
      }
    })

    it('starts the first turn with the mode chosen before the prompt was sent, and holds a later choice back', async () => {
      const sessionId = 'first-turn-two-choices'
      const world = new World(newSidecar(), 'claude')
      const conversation = new Conversation(sessionId)
      const adapter = world.adapter(conversation)
      const start = holdStart(world)
      try {
        await adapter.setDraftMode(sessionId, 'acceptEdits')
        const first = world.say(adapter, conversation, 'first')
        await start.entered
        const during = await adapter.setDraftMode(sessionId, 'plan')
        expect(during).toMatchObject({ currentModeId: 'acceptEdits', pendingModeId: 'plan' })

        start.release()
        await first
        const transport = world.transports[0]!
        expect(transport.calls).toEqual(['start:new', 'set:mode=acceptEdits', 'prompt'])
        expect(await adapter.agentSessionSnapshot(sessionId)).toMatchObject({
          currentModeId: 'acceptEdits',
          pendingModeId: 'plan',
        })

        transport.promptScript = answers('second answer')
        await world.say(adapter, conversation, 'second')
        expect(transport.calls.slice(3)).toEqual(['set:mode=plan', 'prompt'])
        expect(await world.sidecar.readModeIntent(sessionId as never)).toBeUndefined()
      } finally {
        start.release()
        await world.close()
      }
    })

    it('shows the mode chosen before the prompt as pending from the moment the Agent is bound, until it is applied', async () => {
      const sessionId = 'first-turn-bound'
      const world = new World(newSidecar(), 'claude')
      const conversation = new Conversation(sessionId)
      const adapter = world.adapter(conversation)
      try {
        await adapter.setDraftMode(sessionId, 'acceptEdits')
        // The first prompt's model write comes after the binding exists and before its mode is applied.
        let between: unknown
        world.beforeSet = async (id) => {
          if (id === 'model') between = await adapter.agentSessionSnapshot(sessionId)
        }
        await world.say(adapter, conversation, 'first', 'opus')
        expect(world.transports[0]?.calls).toEqual(['start:new', 'set:model=opus', 'set:mode=acceptEdits', 'prompt'])
        expect(between).toMatchObject({ freshness: 'live', currentModeId: 'default', pendingModeId: 'acceptEdits' })
        expect(await adapter.agentSessionSnapshot(sessionId)).toMatchObject({
          currentModeId: 'acceptEdits',
          pendingModeId: null,
        })
      } finally {
        await world.close()
      }
    })

    it('stays on the route the first prompt went to when the composer looks at another one', async () => {
      const sessionId = 'first-turn-route'
      const sidecar = newSidecar()
      const claude = new World(sidecar, 'claude')
      const codex = new World(sidecar, 'codex')
      const conversation = new Conversation(sessionId)
      const onClaude = claude.adapter(conversation)
      const onCodex = codex.adapter(conversation)
      const start = holdStart(claude)
      try {
        const first = claude.say(onClaude, conversation, 'first')
        await start.entered
        await onClaude.setDraftMode(sessionId, 'plan')
        expect(await onCodex.draftSessionSnapshot(sessionId)).toMatchObject({
          currentModeId: null,
          pendingModeId: null,
        })

        start.release()
        await first
        expect(await onClaude.agentSessionSnapshot(sessionId)).toMatchObject({ pendingModeId: 'plan' })
        expect(codex.transports).toEqual([])
      } finally {
        start.release()
        await Promise.all([claude.close(), codex.close()])
      }
    })

    it('does not hang when the Agent gets bound while a draft choice waits for the control lock', async () => {
      const sessionId = 'first-turn-bind-race'
      const real = newSidecar()
      // The choice was checked against a session with no binding yet; by the time it holds the lock there is one.
      let hideBinding = false
      const racing = new Proxy(real, {
        get(target, property) {
          if (property === 'readLatestBinding')
            return async (id: Parameters<AcpSidecar['readLatestBinding']>[0]) => {
              if (!hideBinding) return await target.readLatestBinding(id)
              hideBinding = false
              return undefined
            }
          const member: unknown = Reflect.get(target, property, target)
          return typeof member === 'function' ? member.bind(target) : member
        },
      })
      const world = new World(racing, 'claude')
      const conversation = new Conversation(sessionId)
      const adapter = world.adapter(conversation)
      try {
        await world.say(adapter, conversation, 'first')
        hideBinding = true
        expect(await adapter.setDraftMode(sessionId, 'plan')).toBeDefined()
        // Saved under the route's key, the choice waits beside the bound Agent and the next prompt applies it.
        expect(await adapter.agentSessionSnapshot(sessionId)).toMatchObject({ pendingModeId: 'plan' })
        world.transports[0]!.promptScript = answers('second answer')
        await world.say(adapter, conversation, 'second')
        expect(world.transports[0]?.calls).toEqual(['start:new', 'prompt', 'set:mode=plan', 'prompt'])
      } finally {
        await world.close()
      }
    })
  })

  describe('a mode chosen after DSH accepted the prompt, before its stream registers', () => {
    // The Stop button is showing, the Agent is running and the turn is open, yet this adapter has registered nothing:
    // no stream, no Agent, no binding. What the user chooses now still belongs to the turn after it.
    it.each([
      ['the turn has just opened', false],
      ['its step has started and its message is committed', true],
    ] as const)('keeps the first turn on the mode chosen before the send: %s', async (_window, claimed) => {
      const sessionId = `accepted-first-${claimed ? 'claimed' : 'opened'}`
      const world = new World(newSidecar(), 'claude')
      const conversation = new Conversation(sessionId)
      const adapter = world.adapter(conversation)
      const route = initialModeIntentBindingKey('acp-claude')
      try {
        await adapter.setDraftMode(sessionId, 'bypassPermissions')
        conversation.acceptTurn()
        const early = claimed ? conversation.claim('first') : undefined

        const during = await adapter.setDraftMode(sessionId, 'default')
        expect(world.transports).toEqual([])
        // Bypass is what the first turn will run under; the choice made since is pending for the one after it.
        expect(during).toMatchObject({
          freshness: 'stale',
          currentModeId: 'bypassPermissions',
          pendingModeId: 'default',
        })
        expect(await world.sidecar.readModeIntent(sessionId as never)).toEqual({ bindingKey: route, modeId: 'default' })

        await world.dispatch(adapter, conversation, early ?? conversation.claim('first'))
        const transport = world.transports[0]!
        expect(transport.calls).toEqual(['start:new', 'set:mode=bypassPermissions', 'prompt'])
        expect(await adapter.agentSessionSnapshot(sessionId)).toMatchObject({
          freshness: 'live',
          currentModeId: 'bypassPermissions',
          pendingModeId: 'default',
        })
        expect(await world.sidecar.readModeIntent(sessionId as never)).toEqual({ bindingKey: route, modeId: 'default' })

        transport.promptScript = answers('second answer')
        await world.say(adapter, conversation, 'second')
        expect(transport.calls.slice(3)).toEqual(['set:mode=default', 'prompt'])
        expect(await world.sidecar.readModeIntent(sessionId as never)).toBeUndefined()
        expect(await adapter.agentSessionSnapshot(sessionId)).toMatchObject({
          currentModeId: 'default',
          pendingModeId: null,
        })
      } finally {
        await world.close()
      }
    })

    it('keeps the first turn on the Agent default when nothing was chosen before the send', async () => {
      const sessionId = 'accepted-first-unchosen'
      const world = new World(newSidecar(), 'claude')
      const conversation = new Conversation(sessionId)
      const adapter = world.adapter(conversation)
      try {
        conversation.acceptTurn()
        const during = await adapter.setDraftMode(sessionId, 'plan')
        expect(during).toMatchObject({ currentModeId: null, pendingModeId: 'plan' })

        await world.dispatch(adapter, conversation, conversation.claim('first'))
        const transport = world.transports[0]!
        expect(transport.calls).toEqual(['start:new', 'prompt'])
        expect(await adapter.agentSessionSnapshot(sessionId)).toMatchObject({
          currentModeId: 'default',
          pendingModeId: 'plan',
        })

        transport.promptScript = answers('second answer')
        await world.say(adapter, conversation, 'second')
        expect(transport.calls.slice(2)).toEqual(['set:mode=plan', 'prompt'])
        expect(await world.sidecar.readModeIntent(sessionId as never)).toBeUndefined()
      } finally {
        await world.close()
      }
    })

    it('still starts the first turn with a mode chosen before the send, and a repeat after it changes nothing', async () => {
      const sessionId = 'accepted-first-presend'
      const world = new World(newSidecar(), 'claude')
      const conversation = new Conversation(sessionId)
      const adapter = world.adapter(conversation)
      try {
        // However shortly before Enter: the prompt was not accepted yet, so this is the first turn's own mode.
        await adapter.setDraftMode(sessionId, 'acceptEdits')
        conversation.acceptTurn()
        expect(await adapter.draftSessionSnapshot(sessionId)).toMatchObject({
          currentModeId: 'acceptEdits',
          pendingModeId: null,
        })

        // The same mode chosen again after the send is no change to wait for.
        const repeated = await adapter.setDraftMode(sessionId, 'acceptEdits')
        expect(repeated).toMatchObject({ currentModeId: 'acceptEdits', pendingModeId: null })

        await world.dispatch(adapter, conversation, conversation.claim('first'))
        const transport = world.transports[0]!
        expect(transport.calls).toEqual(['start:new', 'set:mode=acceptEdits', 'prompt'])
        expect(await world.sidecar.readModeIntent(sessionId as never)).toBeUndefined()
        expect(await adapter.agentSessionSnapshot(sessionId)).toMatchObject({
          currentModeId: 'acceptEdits',
          pendingModeId: null,
        })

        transport.promptScript = answers('second answer')
        await world.say(adapter, conversation, 'second')
        expect(transport.calls.slice(3)).toEqual(['prompt'])
      } finally {
        await world.close()
      }
    })

    it('queues a control of a warm session instead of writing it to the Agent before the prompt', async () => {
      const sessionId = 'accepted-warm'
      const world = new World(newSidecar(), 'codex')
      const conversation = new Conversation(sessionId)
      const adapter = world.adapter(conversation)
      try {
        await world.say(adapter, conversation, 'first')
        const transport = world.transports[0]!
        conversation.acceptTurn()
        const second = conversation.claim('second')

        // The runtime is idle and nothing is registered: this used to be an immediate write.
        await adapter.setAgentSessionOption(sessionId, { kind: 'config', id: 'mode', value: 'read-only' })
        const pending = await adapter.setAgentSessionOption(sessionId, {
          kind: 'config',
          id: 'collaboration_mode',
          value: 'plan',
        })
        expect(pending).toMatchObject({
          freshness: 'live',
          pendingModeId: 'read-only',
          pendingOptions: { collaboration_mode: 'plan' },
        })
        expect(transport.calls).toEqual(['start:new', 'prompt'])

        await world.dispatch(adapter, conversation, second)
        expect(transport.calls).toEqual(['start:new', 'prompt', 'prompt'])
        expect(await adapter.agentSessionSnapshot(sessionId)).toMatchObject({
          pendingModeId: 'read-only',
          pendingOptions: { collaboration_mode: 'plan' },
        })

        await world.say(adapter, conversation, 'third')
        expect(transport.calls.slice(3)).toEqual(['set:mode=read-only', 'set:collaboration_mode=plan', 'prompt'])
      } finally {
        await world.close()
      }
    })

    it('takes its fence along when the turn ends without a stream: the next turn starts with the choice', async () => {
      const sessionId = 'accepted-cancelled'
      const world = new World(newSidecar(), 'claude')
      const conversation = new Conversation(sessionId)
      const adapter = world.adapter(conversation)
      try {
        conversation.acceptTurn()
        await adapter.setDraftMode(sessionId, 'plan')
        expect(await adapter.draftSessionSnapshot(sessionId)).toMatchObject({
          currentModeId: null,
          pendingModeId: 'plan',
        })
        // Stopped, or served by a provider this adapter has nothing to do with: no request ever reached it.
        conversation.endTurn()
        expect(world.transports).toEqual([])
        expect(await adapter.draftSessionSnapshot(sessionId)).toMatchObject({
          currentModeId: 'plan',
          pendingModeId: null,
        })

        await world.say(adapter, conversation, 'again')
        expect(world.transports[0]?.calls).toEqual(['start:new', 'set:mode=plan', 'prompt'])
        expect(await world.sidecar.readModeIntent(sessionId as never)).toBeUndefined()
      } finally {
        await world.close()
      }
    })

    it('keeps one route’s fence out of a turn another route served', async () => {
      const sessionId = 'accepted-other-route'
      const sidecar = newSidecar()
      const claude = new World(sidecar, 'claude')
      const codex = new World(sidecar, 'codex')
      const conversation = new Conversation(sessionId)
      const onClaude = claude.adapter(conversation)
      const onCodex = codex.adapter(conversation)
      try {
        conversation.acceptTurn()
        await onClaude.setDraftMode(sessionId, 'plan')
        await codex.dispatch(onCodex, conversation, conversation.claim('first'), 'gpt-6-astra')
        // Codex ran its turn as it was and dropped a choice that was made for another route.
        expect(codex.transports[0]?.calls).toEqual(['start:new', 'prompt'])
        expect(claude.transports).toEqual([])
        expect(await sidecar.readModeIntent(sessionId as never)).toBeUndefined()
      } finally {
        await Promise.all([claude.close(), codex.close()])
      }
    })

    it('refuses to save a mode for a bound session without a connected Agent while its turn is open', async () => {
      const sessionId = 'accepted-resume'
      const world = new World(newSidecar(), 'claude')
      const conversation = new Conversation(sessionId)
      try {
        const first = world.adapter(conversation)
        await world.say(first, conversation, 'first')
        await first.close()

        const restarted = world.adapter(conversation)
        conversation.acceptTurn()
        // Saved now it would be applied to the very turn that is about to start.
        await expect(restarted.setDraftMode(sessionId, 'plan')).rejects.toMatchObject({
          code: 'ACP_SESSION_OPTIONS_READ_ONLY',
        })
        expect(await world.sidecar.readModeIntent(sessionId as never)).toBeUndefined()

        conversation.endTurn()
        await restarted.setDraftMode(sessionId, 'plan')
        const lookup = await world.sidecar.readLatestBinding(sessionId as never)
        if (lookup?.status !== 'ok') throw new Error('the session has no binding')
        expect(await world.sidecar.readModeIntent(sessionId as never)).toEqual({
          bindingKey: modeIntentBindingKey(lookup.binding),
          modeId: 'plan',
        })
      } finally {
        await world.close()
      }
    })
  })

  describe('a mode chosen once the Agent is bound, before the first prompt is prepared', () => {
    /**
     * The mode chosen before the send is applied by the first prompt's pre-prompt step, after the binding exists and
     * the stream is registered. The first control write of that prompt (its model) is the point to choose in between.
     */
    async function chooseBetweenBindingAndPreparation(sessionId: string, after: string) {
      const world = new World(newSidecar(), 'claude')
      const conversation = new Conversation(sessionId)
      const adapter = world.adapter(conversation)
      await adapter.setDraftMode(sessionId, 'acceptEdits')
      let during: unknown
      world.beforeSet = async (id) => {
        if (id === 'model')
          during = await adapter.setAgentSessionOption(sessionId, { kind: 'config', id: 'mode', value: after })
      }
      await world.say(adapter, conversation, 'first', 'opus')
      return { world, conversation, adapter, transport: world.transports[0]!, during }
    }

    it.each([
      ['another mode', 'plan'],
      ['the mode the Agent starts in', 'default'],
    ])(
      'starts the first turn with the mode chosen before the send and queues %s for the second',
      async (_name, after) => {
        const sessionId = `bound-window-${after}`
        const { world, conversation, adapter, transport } = await chooseBetweenBindingAndPreparation(sessionId, after)
        try {
          // Neither choice is lost: the first turn runs under the one made before the send, the second under the
          // one made after it.
          expect(transport.calls).toEqual(['start:new', 'set:model=opus', 'set:mode=acceptEdits', 'prompt'])
          expect(await adapter.agentSessionSnapshot(sessionId)).toMatchObject({
            currentModeId: 'acceptEdits',
            pendingModeId: after,
          })
          const lookup = await world.sidecar.readLatestBinding(sessionId as never)
          if (lookup?.status !== 'ok') throw new Error('the session has no binding')
          expect(await world.sidecar.readModeIntent(sessionId as never)).toEqual({
            bindingKey: modeIntentBindingKey(lookup.binding),
            modeId: after,
          })

          transport.promptScript = answers('second answer')
          await world.say(adapter, conversation, 'second', 'opus')
          expect(transport.calls.slice(4)).toEqual([`set:mode=${after}`, 'prompt'])
          expect(await world.sidecar.readModeIntent(sessionId as never)).toBeUndefined()
        } finally {
          await world.close()
        }
      },
    )

    it('cancels, rather than queues, the mode the first turn runs under when it is chosen again', async () => {
      const sessionId = 'bound-window-repeat'
      const { world, conversation, adapter, transport, during } = await chooseBetweenBindingAndPreparation(
        sessionId,
        'acceptEdits',
      )
      try {
        expect(during).toMatchObject({ currentModeId: 'default', pendingModeId: null })
        expect(transport.calls).toEqual(['start:new', 'set:model=opus', 'set:mode=acceptEdits', 'prompt'])
        expect(await world.sidecar.readModeIntent(sessionId as never)).toBeUndefined()
        expect(await adapter.agentSessionSnapshot(sessionId)).toMatchObject({
          currentModeId: 'acceptEdits',
          pendingModeId: null,
        })

        transport.promptScript = answers('second answer')
        await world.say(adapter, conversation, 'second', 'opus')
        expect(transport.calls.slice(4)).toEqual(['prompt'])
      } finally {
        await world.close()
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

  describe('a control changed while a turn runs', () => {
    /** A script that keeps the turn open until released, and the handles to wait for and end it. */
    function holdTurn(world: World): { readonly entered: Promise<void>; release(): void } {
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      world.script = async (context) => {
        context.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } })
        entered.resolve()
        await release.promise
        return { stopReason: 'end_turn' }
      }
      return { entered: entered.promise, release: () => release.resolve() }
    }

    it('keeps a Codex mode and collaboration mode pending, then applies them before the next prompt', async () => {
      const sessionId = 'native-pending-codex'
      const world = new World(newSidecar(), 'codex')
      const conversation = new Conversation(sessionId)
      const adapter = world.adapter(conversation)
      const turn = holdTurn(world)
      try {
        const first = world.say(adapter, conversation, 'long task')
        await turn.entered
        const transport = world.transports[0]!
        // The native runtime itself refuses a write during its prompt, so the host must not attempt one.
        expect(world.runtimes[0]?.isBusy).toBe(true)
        await expect(world.runtimes[0]!.setConfigOption('collaboration_mode', 'plan')).rejects.toThrow(
          'ACP_CONFIG_CHANGE_DURING_PROMPT',
        )

        await adapter.setAgentSessionOption(sessionId, { kind: 'config', id: 'mode', value: 'read-only' })
        const pending = await adapter.setAgentSessionOption(sessionId, {
          kind: 'config',
          id: 'collaboration_mode',
          value: 'plan',
        })
        expect(pending).toMatchObject({ pendingModeId: 'read-only', pendingOptions: { collaboration_mode: 'plan' } })
        expect(transport.calls).toEqual(['start:new', 'prompt'])

        turn.release()
        await first
        transport.promptScript = answers('second answer')
        expect(textOf(await world.say(adapter, conversation, 'next'))).toBe('second answer')
        expect(transport.calls).toEqual([
          'start:new',
          'prompt',
          'set:mode=read-only',
          'set:collaboration_mode=plan',
          'prompt',
        ])
        const settled = await adapter.agentSessionSnapshot(sessionId)
        expect(settled).toMatchObject({ pendingModeId: null, pendingOptions: {} })
        expect(settled.configOptions?.find((option) => option.id === 'mode')?.currentValue).toBe('read-only')
        expect(settled.configOptions?.find((option) => option.id === 'collaboration_mode')?.currentValue).toBe('plan')
      } finally {
        turn.release()
        await world.close()
      }
    })

    it('keeps a Claude mode and fast mode pending across a restart of the plugin host', async () => {
      const sessionId = 'native-pending-claude'
      const world = new World(newSidecar(), 'claude')
      const base = vendorControls('claude')
      world.controls = {
        ...base,
        configOptions: [
          ...base.configOptions,
          {
            id: 'fast',
            name: 'Fast mode',
            category: 'model_config',
            type: 'select',
            currentValue: 'off',
            options: [
              { value: 'on', name: 'On' },
              { value: 'off', name: 'Off' },
            ],
          },
        ],
      }
      const conversation = new Conversation(sessionId)
      const adapter = world.adapter(conversation)
      const turn = holdTurn(world)
      try {
        const first = world.say(adapter, conversation, 'long task')
        await turn.entered
        await adapter.setAgentSessionOption(sessionId, { kind: 'config', id: 'fast', value: 'on' })
        await adapter.setAgentSessionOption(sessionId, { kind: 'config', id: 'mode', value: 'acceptEdits' })
        expect(world.transports[0]?.calls).toEqual(['start:new', 'prompt'])
        turn.release()
        await first

        await adapter.close()
        world.script = answers('after the restart')
        const restarted = world.adapter(conversation)
        expect(await restarted.agentSessionSnapshot(sessionId)).toMatchObject({
          freshness: 'stale',
          pendingModeId: 'acceptEdits',
          pendingOptions: { fast: 'on' },
        })
        expect(textOf(await world.say(restarted, conversation, 'welcome back'))).toBe('after the restart')
        expect(world.restores).toEqual(['resumed'])
        expect(world.transports[1]?.calls).toEqual(['start:resume', 'set:mode=acceptEdits', 'set:fast=on', 'prompt'])
        expect(await world.sidecar.readModeIntent(sessionId as never)).toBeUndefined()
        expect(await world.sidecar.listOptionIntents(sessionId as never)).toEqual([])
      } finally {
        turn.release()
        await world.close()
      }
    })

    it('keeps a choice made while the turn is being prepared for the next turn, on the native route', async () => {
      const sessionId = 'native-pending-preparing'
      const world = new World(newSidecar(), 'codex')
      const conversation = new Conversation(sessionId)
      const adapter = world.adapter(conversation)
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      try {
        await world.say(adapter, conversation, 'first')
        const transport = world.transports[0]!
        world.beforeRestore = async () => {
          entered.resolve()
          await release.promise
        }
        // DSH shows the turn as running and the adapter has registered it, but its prompt is not prepared yet.
        const second = world.say(adapter, conversation, 'second')
        await entered.promise
        await adapter.setAgentSessionOption(sessionId, { kind: 'config', id: 'mode', value: 'read-only' })
        const pending = await adapter.setAgentSessionOption(sessionId, {
          kind: 'config',
          id: 'collaboration_mode',
          value: 'plan',
        })
        expect(pending).toMatchObject({ pendingModeId: 'read-only', pendingOptions: { collaboration_mode: 'plan' } })

        release.resolve()
        await second
        // The prompt that was being prepared went out as the user saw it; nothing was written to the vendor for it.
        expect(transport.calls).toEqual(['start:new', 'prompt', 'prompt'])
        expect(await adapter.agentSessionSnapshot(sessionId)).toMatchObject({
          pendingModeId: 'read-only',
          pendingOptions: { collaboration_mode: 'plan' },
        })

        await world.say(adapter, conversation, 'third')
        expect(transport.calls.slice(3)).toEqual(['set:mode=read-only', 'set:collaboration_mode=plan', 'prompt'])
      } finally {
        release.resolve()
        await world.close()
      }
    })

    it('keeps a draft-menu mode write that reaches a bound session mid-turn for the next turn', async () => {
      const sessionId = 'native-draft-write-running'
      const world = new World(newSidecar(), 'claude')
      const conversation = new Conversation(sessionId)
      const adapter = world.adapter(conversation)
      const turn = holdTurn(world)
      try {
        const first = world.say(adapter, conversation, 'long task')
        await turn.entered
        // The dock can still hold the draft menu for a moment after the binding exists: its write must wait, not fail.
        const pending = await adapter.setDraftMode(sessionId, 'plan')
        expect(pending).toMatchObject({ freshness: 'live', currentModeId: 'default', pendingModeId: 'plan' })
        expect(world.transports[0]?.calls).toEqual(['start:new', 'prompt'])

        turn.release()
        await first
        world.transports[0]!.promptScript = answers('next answer')
        await world.say(adapter, conversation, 'next')
        expect(world.transports[0]?.calls).toEqual(['start:new', 'prompt', 'set:mode=plan', 'prompt'])
      } finally {
        turn.release()
        await world.close()
      }
    })

    it.each([
      ['claude', 'model', 'sonnet', 'effort', 'high'],
      ['codex', 'model', 'gpt-5.5', 'reasoning_effort', 'high'],
      ['omp', 'model', 'tokenrouter/gpt-5.5', 'thinking', 'high'],
    ] as const)(
      'refuses a %s model or reasoning write mid-turn: both stay on the DSH picker',
      async (kind, model, modelValue, effort, effortValue) => {
        const sessionId = `native-picker-${kind}`
        const world = new World(newSidecar(), kind)
        const conversation = new Conversation(sessionId)
        const adapter = world.adapter(conversation)
        const turn = holdTurn(world)
        try {
          const first = world.say(adapter, conversation, 'long task')
          await turn.entered
          for (const write of [
            { id: model, value: modelValue },
            { id: effort, value: effortValue },
          ])
            await expect(adapter.setAgentSessionOption(sessionId, { kind: 'config', ...write })).rejects.toMatchObject({
              code: 'ACP_CONFIG_UNSUPPORTED',
            })
          expect(await world.sidecar.listOptionIntents(sessionId as never)).toEqual([])
          turn.release()
          await first
          expect(world.transports[0]?.calls).toEqual(['start:new', 'prompt'])
        } finally {
          turn.release()
          await world.close()
        }
      },
    )
  })
})

describe('native commands, side questions and vendor session changes on a session', () => {
  const signal = (): AbortSignal => new AbortController().signal
  const answered = (value: string): NativeCommandResult => ({ kind: 'success', text: value })
  const say =
    (value: string): FakePromptScript =>
    async (context) => {
      context.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } })
      return { stopReason: 'end_turn' }
    }

  /** A session whose first turn bound it to a vendor session. */
  async function boundSession(kind: NativeTransportKind, sessionId: string) {
    const world = new World(newSidecar(), kind)
    const conversation = new Conversation(sessionId)
    const adapter = world.adapter(conversation)
    await world.say(adapter, conversation, 'hello')
    return { world, conversation, adapter, transport: world.transports[0]! }
  }

  async function bindingOf(world: World, sessionId: string) {
    const lookup = await world.sidecar.readLatestBinding(sessionId as never)
    if (lookup?.status !== 'ok') throw new Error('the session is not bound')
    return lookup.binding
  }

  /** A turn that stays open until released, so that something can happen while it runs. */
  function holdTurn(transport: FakeNativeTransport) {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    transport.promptScript = async (context) => {
      entered.resolve()
      await release.promise
      return await say('done')(context)
    }
    return { entered: entered.promise, release: () => release.resolve() }
  }

  describe('the side channel', () => {
    it('asks a session without an agent conversation to send a message first, and starts no agent for it', async () => {
      const world = new World(newSidecar(), 'claude')
      const conversation = new Conversation('side-unbound')
      const adapter = world.adapter(conversation)
      try {
        const results = [
          await adapter.sideQuestion('side-unbound', 'anyone?', signal()),
          await adapter.runNativeCommand('side-unbound', 'status', '', signal()),
        ]
        for (const result of results)
          expect(result).toMatchObject({ kind: 'error', text: expect.stringMatching(/send a message first/i) })
        expect(world.transports).toHaveLength(0)
        expect(conversation.events).toEqual([])
        // The commands are offered before any agent exists: the built-ins of the profile's kind.
        expect(adapter.nativeCommands('side-unbound').map((command) => command.name)).toContain('btw')
      } finally {
        await world.close()
      }
    })

    it('answers and runs commands while a turn is open, without a log write or a prompt of its own', async () => {
      const { world, conversation, adapter, transport } = await boundSession('codex', 'side-running')
      try {
        transport.sideQuestion = async (question) => answered(`side: ${question}`)
        transport.runCommand = async (name, args) => answered(`${name}(${args})`)
        const turn = holdTurn(transport)
        const second = world.say(adapter, conversation, 'second')
        await turn.entered
        const logged = structuredClone(conversation.events)

        expect(await adapter.sideQuestion('side-running', 'what?', signal())).toEqual(answered('side: what?'))
        expect(await adapter.runNativeCommand('side-running', 'status', 'verbose', signal())).toEqual(
          answered('status(verbose)'),
        )
        expect(conversation.events).toEqual(logged)

        turn.release()
        await second
        // The two turns are the only prompts the binding committed.
        expect(await bindingOf(world, 'side-running')).toMatchObject({ committedPromptOrdinal: 2 })
      } finally {
        await world.close()
      }
    })

    it('reconnects a saved session for a side question, the way its next prompt would', async () => {
      const world = new World(newSidecar(), 'claude')
      const conversation = new Conversation('side-cold')
      try {
        const first = world.adapter(conversation)
        await world.say(first, conversation, 'hello')
        await first.close()
        world.onTransport = (transport) => {
          transport.sideQuestion = async (question) => answered(`cold: ${question}`)
        }
        const restarted = world.adapter(conversation)

        expect(await restarted.sideQuestion('side-cold', 'still there?', signal())).toEqual(
          answered('cold: still there?'),
        )
        expect(world.transports).toHaveLength(2)
        expect(world.transports[1]?.startOptions?.session).toEqual({ kind: 'resume', sessionId: 'claude-session-new' })
        expect(world.restores).toEqual(['resumed'])
        await world.say(restarted, conversation, 'welcome back')
        expect(world.restores).toEqual(['resumed', 'reused'])
        expect(world.transports).toHaveLength(2)
      } finally {
        await world.close()
      }
    })

    it('leaves a session that needs recovery alone', async () => {
      const world = new World(newSidecar(), 'claude')
      const conversation = new Conversation('side-gated')
      try {
        const first = world.adapter(conversation)
        await world.say(first, conversation, 'hello')
        await first.close()
        await world.sidecar.writeRecoveryState({
          dshSessionId: 'side-gated',
          kind: 'reconnect-required',
          cause: 'load-failed',
          detail: 'the agent was lost',
          provider: 'acp-claude',
          acpSessionId: 'claude-session-new',
          generation: 1,
          updatedAt: Date.now(),
        } as never)

        const restarted = world.adapter(conversation)
        expect(await restarted.sideQuestion('side-gated', 'q', signal())).toMatchObject({
          kind: 'error',
          text: expect.stringMatching(/recovery/i),
        })
        expect(world.transports).toHaveLength(1)
        expect(await world.sidecar.readRecoveryState('side-gated' as never)).toMatchObject({
          kind: 'reconnect-required',
        })
      } finally {
        await world.close()
      }
    })

    it('reports a failed reconnect without poisoning the session', async () => {
      const world = new World(newSidecar(), 'claude')
      const conversation = new Conversation('side-failed')
      try {
        const first = world.adapter(conversation)
        await world.say(first, conversation, 'hello')
        await first.close()
        world.beforeStart = async () => {
          throw new Error('login required')
        }
        const restarted = world.adapter(conversation)

        expect(await restarted.sideQuestion('side-failed', 'q', signal())).toMatchObject({
          kind: 'error',
          text: expect.stringContaining('login required'),
        })
        // Nothing was written about the failure, and no runtime is kept for an agent that never attached.
        expect(await world.sidecar.readRecoveryState('side-failed' as never)).toMatchObject({ kind: 'healthy' })
        expect(await restarted.agentSessionSnapshot('side-failed')).toMatchObject({ freshness: 'stale' })
        await world.say(restarted, conversation, 'again')
        expect(world.transports).toHaveLength(3)
        expect(world.transports[2]?.startOptions?.session).toEqual({ kind: 'resume', sessionId: 'claude-session-new' })
      } finally {
        await world.close()
      }
    })

    it('ends a side question that is still waiting when its session is disposed', async () => {
      const { world, conversation, adapter, transport } = await boundSession('omp', 'side-disposed')
      try {
        let given: AbortSignal | undefined
        transport.sideQuestion = (_question, callSignal) => {
          given = callSignal
          return new Promise<NativeCommandResult>(() => undefined)
        }
        const asked = adapter.sideQuestion('side-disposed', 'q', signal())
        await vi.waitFor(() => expect(given).toBeDefined())
        await adapter.disposeSession(conversation.session)
        await expect(asked).resolves.toMatchObject({ kind: 'error' })
        expect(given?.aborted).toBe(true)
      } finally {
        await world.close()
      }
    })

    it('tells the command bridge when the agent reports a new catalog', async () => {
      const { world, adapter, transport } = await boundSession('omp', 'side-catalog')
      try {
        const told: string[] = []
        const stop = adapter.watchNativeCommands((sessionId) => told.push(sessionId))
        transport.emit({ kind: 'commands', commands: [{ name: 'deploy', description: 'Deploy', dispatch: 'prompt' }] })
        expect(told).toEqual(['side-catalog'])
        expect(adapter.nativeCommands('side-catalog').map((command) => command.name)).toEqual(['deploy'])
        stop()
        transport.emit({ kind: 'commands', commands: [] })
        expect(told).toEqual(['side-catalog'])
      } finally {
        await world.close()
      }
    })
  })

  describe('a conversation the agent replaced on its own', () => {
    it('moves the binding when a command replaces it while idle, and a restart resumes the new session', async () => {
      const { world, conversation, adapter, transport } = await boundSession('claude', 'change-idle')
      try {
        const before = await bindingOf(world, 'change-idle')
        transport.runCommand = async () => {
          transport.replaceSession('claude-session-2', 'new')
          return answered('Started a new conversation.')
        }
        const logged = structuredClone(conversation.events)

        expect(await adapter.runNativeCommand('change-idle', 'new', '', signal())).toEqual(
          answered('Started a new conversation.'),
        )

        // The vendor conversation was replaced: the blank rebind of the new session, before the answer is returned.
        const after = await bindingOf(world, 'change-idle')
        expect(after).toMatchObject({
          agentSessionId: 'claude-session-2',
          generation: before.generation + 1,
          bindingEpoch: before.bindingEpoch + 1,
          committedPromptOrdinal: 0,
        })
        expect(after.historyBaseSeq).toBe(after.dshCommittedSeq)
        expect(after.historyBaseSeq).toBeGreaterThanOrEqual(before.dshCommittedSeq)
        expect(await world.sidecar.readRecoveryState('change-idle' as never)).toMatchObject({
          kind: 'healthy',
          acpSessionId: 'claude-session-2',
          generation: after.generation,
        })
        expect(conversation.events).toEqual(logged)

        await adapter.close()
        await world.say(world.adapter(conversation), conversation, 'carry on')
        expect(world.transports[1]?.startOptions?.session).toEqual({ kind: 'resume', sessionId: 'claude-session-2' })
      } finally {
        await world.close()
      }
    })

    it('moves the binding when the turn that replaced it settles, not before', async () => {
      const { world, conversation, adapter, transport } = await boundSession('claude', 'change-turn')
      try {
        const duringTurn: string[] = []
        transport.promptScript = async (context) => {
          context.update({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Conversation cleared.' },
          })
          transport.replaceSession('claude-session-2')
          duringTurn.push((await bindingOf(world, 'change-turn')).agentSessionId)
          return { stopReason: 'end_turn' }
        }

        const chunks = await world.say(adapter, conversation, '/clear')

        expect(duringTurn).toEqual(['claude-session-new'])
        expect(await bindingOf(world, 'change-turn')).toMatchObject({
          agentSessionId: 'claude-session-2',
          generation: 2,
          committedPromptOrdinal: 0,
        })
        expect(adapter.localSettlementStatus('change-turn')).toBeUndefined()
        expect(await world.sidecar.readRecoveryState('change-turn' as never)).toMatchObject({
          kind: 'healthy',
          acpSessionId: 'claude-session-2',
          generation: 2,
        })
        // The replay marker of the turn names the session that now holds the conversation.
        expect(chunks.at(-1)).toMatchObject({
          type: 'finish',
          replayState: {
            response: { agentSessionId: 'claude-session-2', profileGeneration: 2, committedPromptOrdinal: 0 },
          },
        })
        // The next turn finds the agent attached to it and commits against it.
        transport.promptScript = answers('next answer')
        await world.say(adapter, conversation, 'next')
        expect(world.transports).toHaveLength(1)
        expect(await bindingOf(world, 'change-turn')).toMatchObject({
          agentSessionId: 'claude-session-2',
          committedPromptOrdinal: 1,
        })
      } finally {
        await world.close()
      }
    })

    it('waits for the end of a running turn when a command replaces it meanwhile', async () => {
      const { world, conversation, adapter, transport } = await boundSession('codex', 'change-busy')
      try {
        transport.runCommand = async () => {
          transport.replaceSession('codex-session-2', 'new')
          return answered('started')
        }
        const turn = holdTurn(transport)
        const second = world.say(adapter, conversation, 'second')
        await turn.entered

        await adapter.runNativeCommand('change-busy', 'new', '', signal())
        expect((await bindingOf(world, 'change-busy')).agentSessionId).toBe('codex-session-new')

        turn.release()
        await second
        expect(await bindingOf(world, 'change-busy')).toMatchObject({
          agentSessionId: 'codex-session-2',
          generation: 2,
        })
      } finally {
        await world.close()
      }
    })

    it('moves the binding before the next prompt when the change came after DSH accepted it', async () => {
      const { world, conversation, adapter, transport } = await boundSession('claude', 'change-accepted')
      try {
        conversation.acceptTurn()
        transport.replaceSession('claude-session-2', 'new')
        expect((await bindingOf(world, 'change-accepted')).agentSessionId).toBe('claude-session-new')

        await world.dispatch(adapter, conversation, conversation.claim('go on'))

        expect(await bindingOf(world, 'change-accepted')).toMatchObject({
          agentSessionId: 'claude-session-2',
          generation: 2,
          committedPromptOrdinal: 1,
        })
        expect(world.transports).toHaveLength(1)
        expect(world.restores).toEqual(['reused'])
      } finally {
        await world.close()
      }
    })

    it('leaves the binding to recovery when the turn that replaced it fails', async () => {
      const { world, conversation, adapter, transport } = await boundSession('claude', 'change-failed')
      try {
        transport.promptScript = async () => {
          transport.replaceSession('claude-session-2')
          throw new Error('the agent crashed')
        }
        await expect(world.say(adapter, conversation, 'work')).rejects.toThrow('the agent crashed')

        // The gate the failure raised owns the binding: it still names the session the dispatch went to.
        expect(await bindingOf(world, 'change-failed')).toMatchObject({
          agentSessionId: 'claude-session-new',
          generation: 1,
        })
        expect(await world.sidecar.readRecoveryState('change-failed' as never)).toMatchObject({
          kind: 'outcome-unknown',
        })
      } finally {
        await world.close()
      }
    })

    describe('a rewind', () => {
      it.each([
        { kind: 'codex', where: 'the session it was in', next: (held: string) => held },
        { kind: 'omp', where: 'a branch with a session of its own', next: () => 'omp-session-branch' },
      ] as const)(
        'rebinds the conversation when it leaves the agent in $where, and the next turn continues there',
        async ({ kind, next }) => {
          const id = `rewind-${kind}`
          const { world, conversation, adapter, transport } = await boundSession(kind, id)
          try {
            await world.say(adapter, conversation, 'second')
            const before = await bindingOf(world, id)
            expect(before).toMatchObject({ generation: 1, committedPromptOrdinal: 2 })
            const target = next(before.agentSessionId)
            transport.runCommand = async () => {
              transport.replaceSession(target, 'rewind')
              return answered('Rewound.')
            }
            // DSH logged the row of the command before the agent ran it.
            conversation.logRow('command/run')
            const logged = structuredClone(conversation.events)

            expect(await adapter.runNativeCommand(id, 'rewind', '1 confirm', signal())).toEqual(answered('Rewound.'))

            // The agent forgot messages the DSH log still holds: the blank rebind of the session it is in now, with the
            // history it can know starting at the current head of the log.
            const after = await bindingOf(world, id)
            expect(logged.length).toBeGreaterThan(before.dshCommittedSeq)
            expect(after).toMatchObject({
              agentSessionId: target,
              generation: before.generation + 1,
              bindingEpoch: before.bindingEpoch + 1,
              committedPromptOrdinal: 0,
              historyBaseSeq: logged.length,
              dshCommittedSeq: logged.length,
            })
            expect(await world.sidecar.readRecoveryState(id as never)).toMatchObject({
              kind: 'healthy',
              acpSessionId: target,
              generation: after.generation,
            })
            expect(conversation.events).toEqual(logged)

            // The next turn goes to the agent in the session it is in, and commits against the new generation.
            transport.promptScript = answers('after the rewind')
            expect(textOf(await world.say(adapter, conversation, 'carry on'))).toBe('after the rewind')
            expect(world.transports).toHaveLength(1)
            expect(await bindingOf(world, id)).toMatchObject({
              agentSessionId: target,
              generation: after.generation,
              committedPromptOrdinal: 1,
            })

            // A restart resumes that session at that generation.
            await adapter.close()
            await world.say(world.adapter(conversation), conversation, 'welcome back')
            expect(world.transports[1]?.startOptions?.session).toEqual({ kind: 'resume', sessionId: target })
            expect(await bindingOf(world, id)).toMatchObject({
              agentSessionId: target,
              generation: after.generation,
              committedPromptOrdinal: 2,
            })
          } finally {
            await world.close()
          }
        },
      )

      it.each([
        { id: 'lost-rewind-held', reason: 'rewind', where: 'in place', next: (held: string) => held },
        { id: 'lost-rewind-branch', reason: 'rewind', where: 'on a branch', next: () => 'claude-session-branch' },
        {
          id: 'lost-plan-exit',
          reason: 'plan_mode_exit',
          where: 'by a conversation that carries the plan',
          next: () => 'claude-session-plan',
        },
      ] as const)(
        'keeps the session-lost gate when the agent cannot find, after a restart, a conversation replaced $where ($reason)',
        async ({ id, reason, next }) => {
          const { world, conversation, adapter, transport } = await boundSession('claude', id)
          try {
            const held = (await bindingOf(world, id)).agentSessionId
            const target = next(held)
            transport.replaceSession(target, reason)
            await vi.waitFor(async () => expect((await bindingOf(world, id)).generation).toBe(2))
            expect(await bindingOf(world, id)).toMatchObject({ agentSessionId: target, committedPromptOrdinal: 0 })
            await adapter.close()

            // What the agent still holds of the rewound or carried conversation is lost with it: no fresh session is
            // started in its place, where an empty replacement is let go (a session that was never written).
            world.beforeStart = async () => {
              throw new NativeTransportError(`Claude Code session not found: ${target}`, 'session-not-found')
            }
            await expect(world.say(world.adapter(conversation), conversation, 'hello')).rejects.toMatchObject({
              code: 'ACP_SESSION_NOT_FOUND',
            })
            expect(world.transports).toHaveLength(2)
            expect(await world.sidecar.readRecoveryState(id as never)).toMatchObject({ kind: 'session-lost' })
            expect(await bindingOf(world, id)).toMatchObject({ agentSessionId: target, generation: 2 })
          } finally {
            await world.close()
          }
        },
      )
    })
  })
})
