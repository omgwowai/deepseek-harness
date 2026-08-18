import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the input.right seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { RolloutButtonInjected } from './index.ts'
import type { createRolloutSettingsStore } from './settings-store.ts'
import type { RolloutKey } from './locales.ts'
import css from './RolloutButton.module.css'

/** Full composer-button props: runtime share (standard kit) + store + injected face + locale seat. */
export type RolloutButtonProps =
  PropsRuntime<'conversation.input.right'>
  & PropsStore<ReturnType<typeof createRolloutSettingsStore>>
  & RolloutButtonInjected
  & PropsLocale<'rollout'>

/**
 * The rollout trigger pill in the composer's tool row. Reads the enabled flag
 * off the synced store; while a round is admitted it shows a running state;
 * failures surface as a status line.
 */
export function RolloutButton({ sessionId, useStore, run, t }: RolloutButtonProps) {
  const enabled = useStore(s => s.enabled)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const start = (): void => {
    // No enabled/running guard: both disable the button, so no click arrives.
    setRunning(true)
    setError(null)
    void run(sessionId).then((failure) => {
      if (!aliveRef.current) return
      setRunning(false)
      setError(failure)
    }, (reason: unknown) => {
      if (!aliveRef.current) return
      setRunning(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  return (
    <span className={css.wrap}>
      <button
        type="button"
        className={clsx(css.rollout, running && css.running)}
        aria-label={t('button.aria' satisfies RolloutKey)}
        title={t('button.title' satisfies RolloutKey)}
        disabled={!enabled || running}
        onClick={start}
      >
        Rollout
      </button>
      {/* Failure copy stays English (error-surface policy: not localized). */}
      {error !== null && <span className={css.error} role="status" title={error}>rollout failed</span>}
    </span>
  )
}
