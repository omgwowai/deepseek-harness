import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { PeerScope, RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteAccessAction, RemoteAccessBinding } from '@deepseek-ai/dsh-api-remote-access'
import type {} from '@deepseek-ai/dsh-api-gateway'
import { AcpRemoteService, type AcpRemoteServiceDeps } from '../../../src/remote/service.ts'
import type { AcpAgentSessionSnapshotView, AcpTeamMemberView } from '../../../src/contract/remote.ts'

// Exercise the exact published Host dispatch and principal implementation,
// without depending on generated plugin artifacts or starting an HTTP server.
const requireDsh = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const Registry = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-typert-registry')).href)
const Access = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-api-remote-access')).href)
const Gateway = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-api-gateway')).href)
const Connection = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-client-connection')).href)

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    'acp-resource-test': { readonly kind: 'acp-resource-test' }
  }
}

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()))
})

const actions: readonly RemoteAccessAction[] = [
  'dshAcp/teamMembers',
  'dshAcp/teamMemberModels',
  'dshAcp/setTeamMemberModel',
  'dshAcp/health',
  'dshAcp/projectedSubagentIds',
  'dshAcp/backendOf',
]

const member: AcpTeamMemberView = {
  sessionId: 'member',
  profileId: 'test',
  name: 'worker',
  status: 'inactive',
  model: 'test-model',
  description: null,
}

async function fixture(extra: Partial<AcpRemoteServiceDeps> = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Registry.default)
  await ctx.plugin(Access.default)
  await ctx.plugin(Gateway.default)
  ctx.typert.resources.register('session', { field: 'sessionId' })
  let held: readonly RemoteAccessBinding[] = []
  const bindings = vi.fn(() => held)
  ctx.remoteAccess.registerPolicy('acp-resource-test', { bindings })
  const members = vi.fn(async () => [member])
  const models = vi.fn(async () => ({ currentModel: 'test-model', pendingModel: null, models: [], writable: true }))
  const selectModel = vi.fn(async () => ({
    currentModel: 'test-model',
    pendingModel: null,
    models: [],
    writable: true,
  }))
  const backend = vi.fn(async () => 'acp-test')
  new AcpRemoteService(ctx, {
    registry: { agents: () => new Map(), probeCacheFor: () => undefined },
    checkExecutable: async () => true,
    queryVersion: async () => null,
    ownedSessionReadGate: async () => true,
    teamManagement: { members, models, selectModel },
    projectedSubagentIds: async () => ['lead', 'member', 'other'],
    listLiveSessions: () =>
      ['lead', 'member', 'other'].map((sessionId) => ({
        sessionId,
        continuity: { status: 'ok', cause: null, detail: null },
      })),
    backendFacts: { readBindingProvider: backend, peekHeaderProvider: backend, hasLiveAgent: () => true },
    ...extra,
  })
  const owner: PeerScope = new Connection.Peer(ctx, { principal: { kind: 'owner' } })
  const restricted: PeerScope = new Connection.Peer(ctx, { principal: { kind: 'acp-resource-test' } })
  const hold = (sessions: readonly string[], global = false, granted: readonly RemoteAccessAction[] = actions) => {
    held = [
      ...sessions.map((id): RemoteAccessBinding => ({
        role: { name: 'acp-test-session', resource: 'session', actions: granted },
        resource: { kind: 'session', id: SessionId(id) },
      })),
      ...(global
        ? [
            {
              role: { name: 'acp-test-global', resource: 'global' as const, actions: granted },
              resource: { kind: 'global' as const },
            },
          ]
        : []),
    ]
  }
  const call = (peer: PeerScope, method: string, args: Record<string, unknown> = {}) =>
    ctx.typertGateway.invoke({ peer, namespace: 'dshAcp', method, args })
  return { ctx, owner, restricted, hold, call, members, models, selectModel, backend, bindings }
}

describe('ACP resources through the published RC1 Gateway and Peer', () => {
  it('keeps owner defaults and complete discovery without consulting non-owner policies', async () => {
    const h = await fixture()
    await expect(h.call(h.owner, 'teamMembers', { lead: 'lead' })).resolves.toEqual([member])
    await expect(h.call(h.owner, 'projectedSubagentIds')).resolves.toEqual({ sessionIds: ['lead', 'member', 'other'] })
    await expect(h.call(h.owner, 'health')).resolves.toMatchObject({
      liveSessions: [{ sessionId: 'lead' }, { sessionId: 'member' }, { sessionId: 'other' }],
    })
    expect(h.bindings).not.toHaveBeenCalled()
  })

  it('authorizes a lead resource without requiring global access and refuses another lead before reading', async () => {
    const h = await fixture()
    h.hold(['lead'])
    await expect(h.call(h.restricted, 'teamMembers', { lead: 'lead' })).resolves.toEqual([member])
    await expect(h.call(h.restricted, 'teamMembers', { lead: 'other' })).rejects.toMatchObject({
      code: 'remote-access/denied',
    })
    expect(h.members).toHaveBeenCalledTimes(1)
  })

  it.each(['teamMemberModels', 'setTeamMemberModel'])(
    'requires both lead and member resources for %s',
    async (method) => {
      const h = await fixture()
      const args = {
        lead: 'lead',
        sessionId: 'member',
        ...(method === 'setTeamMemberModel' ? { model: 'test-model' } : {}),
      }
      h.hold(['member'])
      await expect(h.call(h.restricted, method, args)).rejects.toMatchObject({ code: 'remote-access/denied' })
      h.hold(['lead'])
      await expect(h.call(h.restricted, method, args)).rejects.toMatchObject({ code: 'remote-access/denied' })
      expect(h.members).not.toHaveBeenCalled()
      expect(h.models).not.toHaveBeenCalled()
      expect(h.selectModel).not.toHaveBeenCalled()
      h.hold(['lead', 'member'])
      await expect(h.call(h.restricted, method, args)).resolves.toMatchObject({ currentModel: 'test-model' })
    },
  )

  it('filters session identities inside global discoveries by the actual caller and current bindings', async () => {
    const h = await fixture()
    h.hold(['member'], true)
    await expect(h.call(h.restricted, 'projectedSubagentIds')).resolves.toEqual({ sessionIds: ['member'] })
    await expect(h.call(h.restricted, 'health')).resolves.toMatchObject({ liveSessions: [{ sessionId: 'member' }] })
    h.hold([], true)
    await expect(h.call(h.restricted, 'projectedSubagentIds')).resolves.toEqual({ sessionIds: [] })
    await expect(h.call(h.restricted, 'health')).resolves.toMatchObject({ liveSessions: [] })
  })

  it('uses the native default sessionId resource for ordinary ACP reads before opening backend facts', async () => {
    const h = await fixture()
    h.hold(['member'])
    await expect(h.call(h.restricted, 'backendOf', { sessionId: 'member' })).resolves.toEqual({
      state: 'established',
      provider: 'acp-test',
    })
    await expect(h.call(h.restricted, 'backendOf', { sessionId: 'other' })).rejects.toMatchObject({
      code: 'remote-access/denied',
    })
    expect(h.backend).toHaveBeenCalledOnce()
  })
})

describe('deferred Agent mode writes through the published RC1 Gateway', () => {
  const snapshot: AcpAgentSessionSnapshotView = {
    sessionId: 'lead',
    profileId: 'test',
    freshness: 'stale',
    editable: false,
    modeWritable: true,
    configOptions: null,
    modes: [{ id: 'plan', name: 'Plan' }],
    currentModeId: 'plan',
    contextUsage: null,
    note: null,
  }
  const request = { sessionId: 'lead', provider: 'acp-test', modeId: 'plan' }
  const draftRead: RemoteAccessAction = 'dshAcp/draftAgentSession'
  const draftWrite: RemoteAccessAction = 'dshAcp/setDraftAgentMode'
  const optionWrite: RemoteAccessAction = 'dshAcp/setAgentSessionOption'

  async function deferred() {
    const setDraftMode = vi.fn(async () => snapshot)
    const h = await fixture({
      // An unbound session: before its first prompt only the route the composer selected names an adapter.
      backendFacts: {
        readBindingProvider: async () => undefined,
        peekHeaderProvider: async () => undefined,
        hasLiveAgent: () => true,
      },
      agentSessionChanges: { canRead: async () => true, subscribe: () => () => {} },
      agentSessionControl: (provider) =>
        provider === 'acp-test'
          ? {
              agentSessionSnapshot: async () => snapshot,
              setAgentSessionOption: async () => snapshot,
              draftSessionSnapshot: async () => snapshot,
              setDraftMode,
            }
          : undefined,
    })
    return { ...h, setDraftMode }
  }

  it.each([
    { granted: [draftRead], code: 'remote-access/denied' },
    { granted: [optionWrite], code: 'remote-access/denied' },
    // The Gateway admits the call it is asked to decide; the service still wants the session-option write too.
    { granted: [draftWrite], code: 'dsh-acp/user-rejected' },
  ])('persists nothing for a caller whose grants are $granted', async ({ granted, code }) => {
    const h = await deferred()
    h.hold(['lead'], false, granted)
    await expect(h.call(h.restricted, 'setDraftAgentMode', request)).rejects.toMatchObject({ code })
    expect(h.setDraftMode).not.toHaveBeenCalled()
  })

  it('persists the mode for a caller who holds both writes, and for the owner without asking any policy', async () => {
    const h = await deferred()
    h.hold(['lead'], false, [draftWrite, optionWrite])
    await expect(h.call(h.restricted, 'setDraftAgentMode', request)).resolves.toMatchObject({ currentModeId: 'plan' })
    expect(h.setDraftMode).toHaveBeenCalledExactlyOnceWith('lead', 'plan')

    h.setDraftMode.mockClear()
    h.bindings.mockClear()
    h.hold([])
    await expect(h.call(h.owner, 'setDraftAgentMode', request)).resolves.toMatchObject({ currentModeId: 'plan' })
    expect(h.setDraftMode).toHaveBeenCalledExactlyOnceWith('lead', 'plan')
    expect(h.bindings).not.toHaveBeenCalled()
  })

  it('still serves the draft menu to a caller who holds only its read grant', async () => {
    const h = await deferred()
    h.hold(['lead'], false, [draftRead])
    await expect(
      h.call(h.restricted, 'draftAgentSession', { sessionId: 'lead', provider: 'acp-test' }),
    ).resolves.toMatchObject({ currentModeId: 'plan' })
  })

  it('refuses a missing grant itself when the call never went through the Gateway decision', async () => {
    const h = await deferred()
    // Only the session-option write is held: the Gateway would have denied this endpoint before dispatch.
    h.hold(['lead'], false, [optionWrite])
    // The Gateway builds the real invocation; the service reads nothing from it but the calling Peer.
    const invocation = {
      request: { namespace: 'dshAcp', method: 'setDraftAgentMode', args: {} },
      service: 'dshAcp',
      peer: h.restricted,
    } as unknown as RemoteInvocation
    const reached = h.ctx.extend({ invocation }).get('dshAcp') as AcpRemoteService

    await expect(reached.setDraftAgentMode('lead', 'acp-test', 'plan')).rejects.toMatchObject({
      code: 'dsh-acp/user-rejected',
    })
    expect(h.setDraftMode).not.toHaveBeenCalled()
    // In-process callers outside a Remote call are trusted, as for every other service method.
    await expect(h.ctx.get('dshAcp')!.setDraftAgentMode('lead', 'acp-test', 'plan')).resolves.toBeDefined()
  })
})
