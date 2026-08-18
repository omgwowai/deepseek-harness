// @vitest-environment jsdom
/**
 * ui-rollout browser half: the composer button executes /rollout through the
 * command channel, the settings page binds the settings scope, and the stats
 * footer reads the rolloutStats projection. Node-half apply is a no-op.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import { createRolloutSettingsStore } from '../src/client/settings-store.ts'
import { apply as nodeApply } from '../src/index.ts'

const SID = 's-rollout' as SessionId

/**
 * Minimal settings scope transport used by the settings page binding.
 * @param loaded - false starts the scope in its pre-load state (no value, no revision).
 */
function fakeSettingsScope(loaded = true) {
  const state = new Map<string, unknown>([['enabled', false], ['rolloutCount', 3], ['judgeModel', 'claude-opus-5']])
  const listeners = new Set<() => void>()
  // The mirror ignores a snapshot whose revision it has already applied, so a
  // write has to advance it the way the real transport does.
  let revision = 0
  const notify = () => { for (const l of listeners) l() }
  const set = vi.fn(async (field: string, value: unknown) => {
    state.set(field, value)
    revision += 1
    notify()
  })
  const unset = vi.fn(async (field: string) => {
    state.delete(field)
    revision += 1
    notify()
  })
  return {
    state,
    set,
    unset,
    notify,
    /** Leave the pre-load state: the first namespace view lands at revision 0. */
    load: () => {
      loaded = true
      notify()
    },
    bind: () => ({
      getSnapshot: () => (loaded ? { value: Object.fromEntries(state), revision } : { value: undefined }),
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      set,
      unset,
    }),
  }
}

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: {
      'conversation.input.right': { kind: 'list', scope: 'session' },
      'settings.section': { kind: 'list', scope: 'root' },
      'conversation.details.footer': { kind: 'list', scope: 'session' },
    },
  } as never, () => null)
  const execute = vi.fn((_sessionId: SessionId, _line: string) =>
    Promise.resolve({ ok: true, value: { commandId: 'c1', result: { kind: 'success' as const } } }))
  const commandsRemote = { execute }
  ctx.provide('remote', { commands: commandsRemote })
  ctx.provide('remote.commands', commandsRemote)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const scope = fakeSettingsScope()
  ctx.provide('settingsScope', scope)
  return { ctx, slots, execute, scope }
}

describe('ui-rollout browser apply', () => {
  it('declares every service it binds', () => {
    expect(inject).toEqual(['slots', 'remote', 'remote.commands', 'locale', 'settingsScope'])
  })

  it('node-half apply is an intentional no-op', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })

  it('registers the button, settings page, and stats footer once their seats exist', async () => {
    const { ctx } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    await Promise.resolve()
    expect(ctx.slots.entries('conversation.input.right').some(e => e.options.id === 'rollout')).toBe(true)
    expect(ctx.slots.entries('settings.section').some(e => e.options.id === 'rollout')).toBe(true)
    expect(ctx.slots.entries('conversation.details.footer').some(e => e.options.id === 'rollout-stats')).toBe(true)
  })

  it('button run() executes /rollout and folds failure lines', async () => {
    const { ctx, execute, scope } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    await Promise.resolve()
    const entry = ctx.slots.entries('conversation.input.right').find(e => e.options.id === 'rollout')
    const injected = entry?.inject
    expect(injected).toBeTypeOf('function')
    // enable via the settings scope first, then bind the inject face
    scope.state.set('enabled', true)
    const store = createRolloutSettingsStore().create()
    const face = (injected as (sessionId: SessionId, actions: unknown) => unknown)(SID, store.actions) as {
      run: (id: SessionId) => Promise<string | null>
    }
    const failure = await face.run(SID)
    expect(execute).toHaveBeenCalledWith(SID, '/rollout')
    expect(failure).toBeNull()
  })

  it('button run() surfaces command failures', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({
      name: 'root',
      children: {
        'conversation.input.right': { kind: 'list', scope: 'session' },
        'settings.section': { kind: 'list', scope: 'root' },
        'conversation.details.footer': { kind: 'list', scope: 'session' },
      },
    } as never, () => null)
    const execute = vi.fn(async () => ({ ok: false, error: { message: 'boom', code: 'X' } }))
    ctx.provide('remote', { commands: { execute } })
    ctx.provide('remote.commands', { execute })
    ctx.provide('locale', new LocaleRuntime(ctx))
    ctx.provide('settingsScope', fakeSettingsScope())
    await ctx.plugin({ inject: [...inject], apply }).await()
    await Promise.resolve()
    const entry = ctx.slots.entries('conversation.input.right').find(e => e.options.id === 'rollout')
    const injected = entry?.inject
    const store = createRolloutSettingsStore().create()
    const face = (injected as (sessionId: SessionId, actions: unknown) => unknown)(SID, store.actions) as {
      run: (id: SessionId) => Promise<string | null>
    }
    expect(await face.run(SID)).toBe('boom (X)')
  })

  it('button run() reports an unrecognized command', async () => {
    const { ctx } = await bench()
    const commands = ctx.get('remote.commands') as { execute: unknown }
    commands.execute = vi.fn(async () => ({ ok: true, value: undefined }))
    await ctx.plugin({ inject: [...inject], apply }).await()
    await Promise.resolve()
    const entry = ctx.slots.entries('conversation.input.right').find(e => e.options.id === 'rollout')
    const store = createRolloutSettingsStore().create()
    const face = (entry!.inject as (sessionId: SessionId, actions: unknown) => unknown)(SID, store.actions) as {
      run: (id: SessionId) => Promise<string | null>
    }
    expect(await face.run(SID)).toBe('unknown command: /rollout')
  })

  it('adopts the scope snapshot into both stores and mirrors later writes', async () => {
    const { ctx, scope } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    await Promise.resolve()
    const button = ctx.slots.entries('conversation.input.right').find(e => e.options.id === 'rollout')!
    const settings = ctx.slots.entries('settings.section').find(e => e.options.id === 'rollout')!
    const buttonStore = createRolloutSettingsStore().create()
    const settingsStore = createRolloutSettingsStore().create()
    ;(button.inject as (sessionId: SessionId, actions: unknown) => unknown)(SID, buttonStore.actions)
    const face = (settings.inject as (actions: unknown) => unknown)(settingsStore.actions) as {
      set: (field: string, value: unknown) => Promise<void>
      unset: (field: string) => Promise<void>
    }
    // Adoption at inject time: fields the scope omits fall back to defaults.
    expect(settingsStore.store.getSnapshot().judgeModel).toBe('claude-opus-5')
    expect(settingsStore.store.getSnapshot().judgeBaseURL).toBe('')

    // A write routes through the scope; its notification mirrors into both handles.
    await face.set('judgeBaseURL', 'https://judge.example/v1')
    expect(scope.set).toHaveBeenCalledWith('judgeBaseURL', 'https://judge.example/v1')
    expect(settingsStore.store.getSnapshot().judgeBaseURL).toBe('https://judge.example/v1')
    expect(buttonStore.store.getSnapshot().judgeBaseURL).toBe('https://judge.example/v1')

    await face.unset('judgeBaseURL')
    expect(scope.unset).toHaveBeenCalledWith('judgeBaseURL')
    expect(settingsStore.store.getSnapshot().judgeBaseURL).toBe('')
  })

  it('drops a scope update that predates either inject, and re-adoption at the same revision', async () => {
    const { ctx, scope } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    await Promise.resolve()
    // A write landing before any slot has injected has nowhere to mirror to;
    // the adopting inject reads the same snapshot straight from the scope.
    await scope.set('judgeModel', 'gpt-5.6-sol')
    const settings = ctx.slots.entries('settings.section').find(e => e.options.id === 'rollout')!
    const store = createRolloutSettingsStore().create()
    const adopt = settings.inject as (actions: unknown) => unknown
    adopt(store.actions)
    expect(store.store.getSnapshot().judgeModel).toBe('gpt-5.6-sol')

    // Re-injecting (a remounted section) re-adopts at the same revision; both
    // the mirror and the store's own guard treat it as already applied.
    store.actions.sync({ ...store.store.getSnapshot(), judgeModel: 'ignored' }, store.store.getSnapshot().revision)
    scope.notify()
    expect(store.store.getSnapshot().judgeModel).toBe('gpt-5.6-sol')
  })

  it('mirrors the first namespace view into a store adopted while the scope was loading', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ;(ctx.get('slots') as SlotRegistry).register({
      name: 'root',
      children: {
        'conversation.input.right': { kind: 'list', scope: 'session' },
        'settings.section': { kind: 'list', scope: 'root' },
        'conversation.details.footer': { kind: 'list', scope: 'session' },
      },
    } as never, () => null)
    const execute = vi.fn(async () => ({ ok: true, value: { commandId: 'c1' } }))
    ctx.provide('remote', { commands: { execute } })
    ctx.provide('remote.commands', { execute })
    ctx.provide('locale', new LocaleRuntime(ctx))
    const scope = fakeSettingsScope(false)
    ctx.provide('settingsScope', scope)
    await ctx.plugin({ inject: [...inject], apply }).await()
    await Promise.resolve()
    // A pre-load snapshot carries no value and no revision: both stores adopt
    // defaults, and the load that follows still counts as an advance because
    // the mirror starts one below the first real revision.
    const button = ctx.slots.entries('conversation.input.right').find(e => e.options.id === 'rollout')!
    const settings = ctx.slots.entries('settings.section').find(e => e.options.id === 'rollout')!
    const buttonStore = createRolloutSettingsStore().create()
    const settingsStore = createRolloutSettingsStore().create()
    ;(button.inject as (sessionId: SessionId, actions: unknown) => unknown)(SID, buttonStore.actions)
    ;(settings.inject as (actions: unknown) => unknown)(settingsStore.actions)
    expect(settingsStore.store.getSnapshot().judgeModel).toBe('claude-opus-5')

    // A pre-load notification (a status or writability change) carries no
    // revision either, so it is not an advance and mirrors nothing.
    scope.state.set('judgeModel', 'ignored-while-loading')
    scope.notify()
    expect(settingsStore.store.getSnapshot().judgeModel).toBe('claude-opus-5')

    scope.state.set('judgeModel', 'gpt-5.6-sol')
    scope.load()
    expect(buttonStore.store.getSnapshot().judgeModel).toBe('gpt-5.6-sol')
    expect(settingsStore.store.getSnapshot().judgeModel).toBe('gpt-5.6-sol')
  })

  it('falls back to defaults for an empty scope value and localizes the section label', async () => {
    const { ctx, scope } = await bench()
    scope.state.clear()
    await ctx.plugin({ inject: [...inject], apply }).await()
    await Promise.resolve()
    const settings = ctx.slots.entries('settings.section').find(e => e.options.id === 'rollout')!
    const store = createRolloutSettingsStore().create()
    ;(settings.inject as (actions: unknown) => unknown)(store.actions)
    expect(store.store.getSnapshot()).toMatchObject({ enabled: false, rolloutCount: 3, judgeModel: 'claude-opus-5' })
    expect((settings.options as { label: () => string }).label()).toBe('TokenRouter Rollout')
  })
})
