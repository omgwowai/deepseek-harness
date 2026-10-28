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
  const draftWriteAllowed = useAccess('dshAcp/setDraftAgentMode')
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
  // A live Agent takes a change at any time. While a turn runs, or while the host is still settling it (the native
  // running projection can lead or lag the host), the host keeps the change and applies it before the next turn.
  const live = effective !== null && effective.freshness === 'live'
  const writable = live && optionWriteAllowed
  const queued = writable && (running || !effective.editable)
  const visibleSnapshot =
    effective === null
      ? null
      : { ...effective, editable: live ? optionWriteAllowed : effective.editable && !running && optionWriteAllowed }
  // With no live Agent the mode is still choosable, and the host saves the choice: before the first prompt, and while
  // an Agent is disconnected, it is applied before the next prompt is sent. The first turn's own window counts too,
  // once its prompt is out but its Agent session does not exist yet (nothing reported, so no snapshot): the host holds
  // a choice made then for the turn after it. A reported stale snapshot stays read-only while a turn runs.
  const modeDeferred =
    effective !== null &&
    effective.freshness === 'stale' &&
    effective.modeWritable === true &&
    (!running || snapshot === null)
  // Saving a mode is the session-option write that has to wait for the Agent, so it takes the grants of that write and
  // of the call that saves it. Without both the choices stay as disabled as the snapshot made them.
  const deferredAllowed = modeDeferred && optionWriteAllowed && draftWriteAllowed
  const label = effective === null ? t('toolApprovalSession') : agentControlLabel(effective, t)
  const agentGroups = (visibleSnapshot === null ? [] : agentControlMenuGroups(visibleSnapshot, t)).map((group) =>
    group.kind === 'mode' && deferredAllowed
      ? { ...group, choices: group.choices.map((choice) => ({ ...choice, disabled: false })) }
      : group,
  )
  const deferredChoices = new Set(
    agentGroups.filter((group) => group.kind === 'mode' && deferredAllowed).flatMap((group) => group.choices),
  )
  const groups = [
    ...(policySnapshot === null || policyStale || policySnapshot.applies === false
      ? []
      : [toolApprovalPolicyGroup({ ...policySnapshot, editable: policySnapshot.editable && policyWriteAllowed }, t)]),
    ...agentGroups,
  ]
  const footer = [...(snapshot === null ? [] : agentControlFooter(snapshot, t))]
  if (deferredAllowed)
    footer.push({
      type: 'label',
      id: 'mode-deferred',
      text: t(running ? 'agentChangesApplyNext' : 'agentModeAppliesNext'),
    })
  // A read-only explanation must not create an empty menu before controls arrive.
  if (groups.length === 0 && footer.length === 0 && snapshot?.note == null && error === null && policyError === null)
    return null
  // A change made now waits for the next turn: say so while a turn runs and for as long as a choice is waiting.
  const hasPending = effective?.pendingModeId != null || Object.keys(effective?.pendingOptions ?? {}).length > 0
  if (queued || (writable && hasPending))
    footer.push({ type: 'label', id: 'changes-queued', text: t('agentChangesApplyNext') })
  if (!queued && snapshot !== null && (running || (!visibleSnapshot?.editable && snapshot.freshness === 'live')))
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
      // A menu left open outlives the grants it was built with: ask the live sources again, for both writes.
      if (
        sessionAccessSource(sessionId, 'dshAcp/setAgentSessionOption')?.getSnapshot() !== true ||
        sessionAccessSource(sessionId, 'dshAcp/setDraftAgentMode')?.getSnapshot() !== true
      ) {
        setBusy(false)
        return
      }
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
