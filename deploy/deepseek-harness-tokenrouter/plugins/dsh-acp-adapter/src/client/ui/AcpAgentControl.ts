import { createElement as h, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AcpRemoteLike, AcpAgentSessionSnapshotView } from '../data/acp-remote.ts'
import type { OwnsAcpRoute } from '../coordinator/cross-backend-coordinator.ts'
import css from './AcpAgentControl.module.css'
import { AgentSessionMenu } from './AgentSessionMenu.ts'
import {
  agentControlMenuGroups,
  agentControlLabel,
  agentControlFooter,
  type AgentControlChoice,
} from './agent-session-controls.ts'
import type { RemoteStreamFactory } from '@deepseek-ai/dsh-api-gateway/client'
import { agentSessionStream } from '../data/agent-session-stream.ts'
import { toolApprovalPolicyStream, type ToolApprovalPolicySnapshot } from '../data/tool-approval-policy-stream.ts'
import { toolApprovalPolicyGroup } from './agent-session-controls.ts'
import type { AcpUiFeedback } from '../data/feedback.ts'
import type { SessionAccessSource } from './session-action-access.ts'

type AgentControlProps = PropsRuntime<'conversation.input.left'> &
  PropsLocale<'acpActivity'> & {
    readonly remote: AcpRemoteLike
    readonly streamFactory: RemoteStreamFactory
    readonly ownsRoute: OwnsAcpRoute
    readonly getDefaultProvider: () => Promise<string | undefined>
    readonly watchDefaultProvider: (changed: () => void) => () => void
    readonly feedback: Pick<AcpUiFeedback, 'report'>
    readonly sessionAccessSource: SessionAccessSource
  }

function providerOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const provider = (value as { readonly provider?: unknown }).provider
  return typeof provider === 'string' ? provider : undefined
}

/** The provider the session's composer has selected (its next model, else the last used, else the default). */
export function selectedProviderOf(value: unknown, fallbackProvider?: string): string | undefined {
  if (typeof value !== 'object' || value === null) return fallbackProvider
  const selection = value as { readonly lastUsed?: unknown; readonly next?: unknown }
  const current = selection.next === undefined ? selection.lastUsed : selection.next
  return current === null || current === undefined
    ? selection.lastUsed == null
      ? fallbackProvider
      : undefined
    : providerOf(current)
}

export function snapshotIsAcp(value: unknown, ownsRoute: OwnsAcpRoute, fallbackProvider?: string): boolean {
  return ownsRoute(selectedProviderOf(value, fallbackProvider))
}

/** Small ACP-only control in DSH's native input-left extension point. */
export function AcpAgentControl({
  sessionId,
  useProjection,
  useSession,
  useAccess,
  t,
  remote,
  streamFactory,
  ownsRoute,
  getDefaultProvider,
  watchDefaultProvider,
  feedback,
  sessionAccessSource,
}: AgentControlProps): ReactNode {
  const projection = useProjection('modelSelection')
  const sessionTitle = useProjection('title')
  const running = useSession((state) => state.running)
  const optionWriteAllowed = useAccess('dshAcp/setAgentSessionOption')
  const policyWriteAllowed = useAccess('dshAcp/setToolApprovalPolicy')
  const [defaultProvider, setDefaultProvider] = useState<string | undefined>()
  const [defaultGeneration, setDefaultGeneration] = useState(0)
  useEffect(
    () =>
      watchDefaultProvider(() => {
        setDefaultProvider(undefined)
        setDefaultGeneration((value) => value + 1)
      }),
    [watchDefaultProvider],
  )
  useEffect(() => {
    let active = true
    void getDefaultProvider()
      .then((provider) => {
        if (active) setDefaultProvider(provider)
      })
      .catch(() => {
        if (active) setDefaultProvider(undefined)
      })
    return () => {
      active = false
    }
  }, [getDefaultProvider, defaultGeneration])
  const selectedProvider = selectedProviderOf(projection, defaultProvider)
  const isAcp = ownsRoute(selectedProvider)
  const [snapshot, setSnapshot] = useState<AcpAgentSessionSnapshotView | null>(null)
  // Before the first prompt there is no Agent session to read; its mode choices come from the adapter's draft.
  const [draft, setDraft] = useState<AcpAgentSessionSnapshotView | null>(null)
  const [draftTick, setDraftTick] = useState(0)
  const [policySnapshot, setPolicySnapshot] = useState<ToolApprovalPolicySnapshot | null>(null)
  const [policyError, setPolicyError] = useState<string | null>(null)
  const [policyStale, setPolicyStale] = useState(false)
  const [policyReadFailed, setPolicyReadFailed] = useState(false)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [readFailed, setReadFailed] = useState(false)
  const epoch = useRef(0)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    const current = ++epoch.current
    setOpen(false)
    setBusy(false)
    setError(null)
    setReadFailed(false)
    setSnapshot(null)
    setPolicySnapshot(null)
    setPolicyError(null)
    setPolicyStale(false)
    setPolicyReadFailed(false)
    if (!isAcp || sessionId === undefined) return
    const stream = agentSessionStream(
      remote,
      streamFactory,
      sessionId,
      (value) => {
        if (current !== epoch.current) return
        setSnapshot(value)
        setError(null)
        setReadFailed(false)
      },
      () => {
        if (current !== epoch.current) return
        setSnapshot((value) => (value === null ? null : { ...value, editable: false, freshness: 'stale' }))
        setError(t('agentControlUnavailable'))
        setReadFailed(true)
      },
    )
    stream.start()
    return () => {
      ++epoch.current
      void stream.dispose()
    }
  }, [epoch, isAcp, remote, streamFactory, sessionId, t, retry])

  useEffect(() => {
    setDraft(null)
    if (!isAcp || sessionId === undefined || selectedProvider === undefined || snapshot !== null) return
    let active = true
    void remote
      .draftAgentSession(sessionId, selectedProvider)
      .then((result) => {
        if (active && result.ok) setDraft(result.value)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [isAcp, remote, sessionId, selectedProvider, snapshot === null, draftTick])

  const policyEpoch = useRef(0)
  useEffect(() => {
    const current = ++policyEpoch.current
    if (!isAcp || sessionId === undefined) {
      setPolicySnapshot(null)
      setPolicyError(null)
      setPolicyStale(false)
      setPolicyReadFailed(false)
      return
    }
    setPolicySnapshot(null)
    setPolicyError(null)
    setPolicyStale(false)
    setPolicyReadFailed(false)
    const stream = toolApprovalPolicyStream(
      remote,
      streamFactory,
      sessionId,
      (value) => {
        if (current !== policyEpoch.current || value.sessionId !== sessionId) return
        setPolicySnapshot(value)
        setPolicyError(null)
        setPolicyStale(false)
        setPolicyReadFailed(false)
      },
      () => {
        if (current !== policyEpoch.current) return
        setPolicyError(t('toolApprovalUnavailable'))
        setPolicyStale(true)
        setPolicyReadFailed(true)
      },
    )
    stream.start()
    return () => {
      ++policyEpoch.current
      void stream.dispose()
    }
  }, [isAcp, remote, streamFactory, sessionId, t, retry])

  if (
    !isAcp ||
    (snapshot !== null && snapshot.sessionId !== sessionId) ||
    (policySnapshot !== null && policySnapshot.sessionId !== sessionId)
  )
    return null
  const effective = snapshot ?? (draft !== null && draft.sessionId === sessionId ? draft : null)
  if (effective === null && policySnapshot === null) {
    if (policyError === null && error === null) return null
    return h(
      'button',
      {
        type: 'button',
        className: `${css.trigger} ${css.retryTrigger}`,
        onClick: () => setRetry((value) => value + 1),
        title: t(policyError !== null ? 'toolApprovalRetry' : 'agentControlRetry'),
      },
      policyError ?? error,
    )
  }
  // The native running projection also locks the small interval before ACP prompt begins.
  const visibleSnapshot =
    effective === null ? null : { ...effective, editable: effective.editable && !running && optionWriteAllowed }
  // With no live Agent (before the first prompt, or while it is disconnected) the mode is still choosable:
  // the choice is saved and applied before the next prompt is sent.
  const modeDeferred = effective !== null && effective.freshness === 'stale' && effective.modeWritable === true && !running
  const label = effective === null ? t('toolApprovalSession') : agentControlLabel(effective, t)
  const agentGroups = (visibleSnapshot === null ? [] : agentControlMenuGroups(visibleSnapshot, t)).map((group) =>
    group.kind === 'mode' && modeDeferred
      ? { ...group, choices: group.choices.map((choice) => ({ ...choice, disabled: false })) }
      : group,
  )
  const deferredChoices = new Set(agentGroups.filter((group) => group.kind === 'mode' && modeDeferred).flatMap((group) => group.choices))
  const groups = [
    ...(policySnapshot === null || policyStale || policySnapshot.applies === false
      ? []
      : [toolApprovalPolicyGroup({ ...policySnapshot, editable: policySnapshot.editable && policyWriteAllowed }, t)]),
    ...agentGroups,
  ]
  const footer = [...(snapshot === null ? [] : agentControlFooter(snapshot, t))]
  if (modeDeferred) footer.push({ type: 'label', id: 'mode-deferred', text: t('agentModeAppliesNext') })
  // A read-only explanation must not create an empty menu before controls arrive.
  if (groups.length === 0 && footer.length === 0 && snapshot?.note == null && error === null && policyError === null)
    return null
  if (snapshot !== null && (running || (!visibleSnapshot?.editable && snapshot.freshness === 'live')))
    footer.push({ type: 'label', id: 'read-only', text: t(running ? 'agentControlRunning' : 'agentControlReadOnly') })
  if (error !== null) footer.push({ type: 'label', id: 'error', text: error })
  if (policyError !== null) footer.push({ type: 'label', id: 'policy-error', text: policyError })
  const select = (item: AgentControlChoice): void => {
    if (sessionId === undefined) return
    const current = epoch.current
    // Submitted operations outlive this view; only their local error state is generation-scoped.
    const sourceSession = { id: sessionId, title: sessionTitle ?? null }
    setOpen(false)
    setBusy(true)
    if (item.write.kind === 'tool-approval-policy') {
      if (
        policySnapshot === null ||
        policyStale ||
        !policySnapshot.editable ||
        !policyWriteAllowed ||
        sessionAccessSource(sessionId, 'dshAcp/setToolApprovalPolicy')?.getSnapshot() !== true
      ) {
        setBusy(false)
        return
      }
      setPolicyError(null)
      void remote
        .setToolApprovalPolicy(sessionId, { policy: item.write.policy })
        .then((result) => {
          if (result.ok) return
          feedback.report('tool-approval-failed', current === epoch.current ? undefined : sourceSession)
          if (current === epoch.current) setPolicyError(t('toolApprovalChangeFailed'))
        })
        .catch(() => {
          feedback.report('tool-approval-failed', current === epoch.current ? undefined : sourceSession)
          if (current === epoch.current) setPolicyError(t('toolApprovalChangeFailed'))
        })
        .finally(() => {
          if (current === epoch.current) setBusy(false)
        })
      return
    }
    if (deferredChoices.has(item)) {
      const modeId = item.write.kind === 'mode' ? item.write.id : String(item.write.value)
      setError(null)
      void remote
        .setDraftAgentMode(sessionId, selectedProvider ?? '', modeId)
        .then((result) => {
          if (!result.ok && current === epoch.current) setError(result.error.message)
          if (snapshot === null) setDraftTick((value) => value + 1)
        })
        .catch((reason) => {
          if (current === epoch.current) setError(reason instanceof Error ? reason.message : String(reason))
        })
        .finally(() => {
          if (current === epoch.current) setBusy(false)
        })
      return
    }
    if (
      snapshot === null ||
      visibleSnapshot === null ||
      !visibleSnapshot.editable ||
      snapshot.freshness !== 'live' ||
      !optionWriteAllowed ||
      sessionAccessSource(sessionId, 'dshAcp/setAgentSessionOption')?.getSnapshot() !== true
    ) {
      setBusy(false)
      return
    }
    setError(null)
    void remote
      .setAgentSessionOption(sessionId, item.write)
      .then((result) => {
        if (result.ok) return
        feedback.report('session-option-failed', current === epoch.current ? undefined : sourceSession)
        if (current === epoch.current) setError(result.error.message)
      })
      .catch((reason) => {
        feedback.report('session-option-failed', current === epoch.current ? undefined : sourceSession)
        if (current === epoch.current) setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (current === epoch.current) setBusy(false)
      })
  }
  return h(AgentSessionMenu, {
    groups,
    footer,
    label,
    t,
    open,
    disabled: busy,
    side: 'top',
    onOpenChange: (value) => {
      if (value && (readFailed || policyReadFailed)) setRetry((current) => current + 1)
      setOpen(value)
    },
    onSelect: select,
  })
}
