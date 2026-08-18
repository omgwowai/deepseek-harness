import { useState } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { RolloutSettingsInjected } from './index.ts'
import type { createRolloutSettingsStore } from './settings-store.ts'
import css from './RolloutSettings.module.css'

/** Full settings-section props: runtime share + store + injected face + locale seat. */
export type RolloutSettingsProps =
  PropsRuntime<'settings.section'>
  & PropsStore<ReturnType<typeof createRolloutSettingsStore>>
  & RolloutSettingsInjected
  & PropsLocale<'rollout'>

/**
 * The TokenRouter Rollout settings page: master switch (default off), round
 * size, judge model, worker pool, and milestone auto-trigger. State rides
 * the synced store; writes go through the injected settings scope, so they
 * persist and apply live.
 */
export function RolloutSettings({ t, useStore, set, unset }: RolloutSettingsProps) {
  const state = {
    enabled: useStore(s => s.enabled),
    rolloutCount: useStore(s => s.rolloutCount),
    judgeModel: useStore(s => s.judgeModel),
    judgeBaseURL: useStore(s => s.judgeBaseURL),
    workerModels: useStore(s => s.workerModels),
    autoMilestone: useStore(s => s.autoMilestone),
  }
  const [countDraft, setCountDraft] = useState<string>(String(state.rolloutCount))
  const [judgeDraft, setJudgeDraft] = useState<string>(state.judgeModel)
  const [urlDraft, setUrlDraft] = useState<string>(state.judgeBaseURL)
  const [modelsDraft, setModelsDraft] = useState<string>(state.workerModels.join(', '))

  const commitCount = (): void => {
    const parsed = Number.parseInt(countDraft, 10)
    if (Number.isNaN(parsed) || parsed < 1 || parsed > 8) {
      setCountDraft(String(state.rolloutCount))
      return
    }
    void set('rolloutCount', parsed)
  }

  // An emptied field unsets rather than storing '': the host reads an empty
  // section value as "no user endpoint" and keeps the composition's one, so
  // clearing here re-inherits instead of overriding a deployment's endpoint.
  const commitJudgeBaseURL = (): void => {
    const trimmed = urlDraft.trim()
    if (trimmed === '') void unset('judgeBaseURL')
    else void set('judgeBaseURL', trimmed)
  }

  const commitModels = (): void => {
    const models = modelsDraft.split(',').map(m => m.trim()).filter(m => m !== '')
    if (models.length === 0) void unset('workerModels')
    else void set('workerModels', models)
  }

  return (
    <div className={css.section}>
      <div className={css.row}>
        <label className={css.label}>
          <input
            type="checkbox"
            className={css.checkbox}
            checked={state.enabled}
            onChange={(e) => { void set('enabled', e.target.checked) }}
          />
          {t('settings.enabled.label')}
        </label>
        <span className={css.desc}>{t('settings.enabled.desc')}</span>
      </div>

      <div className={css.row}>
        <label className={css.label} htmlFor="rollout-count">
          {t('settings.count.label')}
        </label>
        <input
          id="rollout-count"
          className={css.input}
          type="number"
          min={1}
          max={8}
          value={countDraft}
          onChange={(e) => { setCountDraft(e.target.value); return undefined }}
          onBlur={commitCount}
        />
        <span className={css.desc}>{t('settings.count.desc')}</span>
      </div>

      <div className={css.row}>
        <label className={css.label} htmlFor="rollout-judge">
          {t('settings.judge.label')}
        </label>
        <input
          id="rollout-judge"
          className={css.input}
          type="text"
          value={judgeDraft}
          onChange={(e) => { setJudgeDraft(e.target.value); return undefined }}
          onBlur={() => {
            const trimmed = judgeDraft.trim()
            if (trimmed !== '') void set('judgeModel', trimmed)
          }}
        />
        <span className={css.desc}>{t('settings.judge.desc')}</span>
      </div>

      <div className={css.row}>
        <label className={css.label} htmlFor="rollout-judge-url">
          {t('settings.judgeBaseURL.label')}
        </label>
        <input
          id="rollout-judge-url"
          className={css.input}
          type="text"
          value={urlDraft}
          onChange={(e) => { setUrlDraft(e.target.value); return undefined }}
          onBlur={commitJudgeBaseURL}
        />
        <span className={css.desc}>{t('settings.judgeBaseURL.desc')}</span>
      </div>

      <div className={css.row}>
        <label className={css.label} htmlFor="rollout-models">
          {t('settings.workerModels.label')}
        </label>
        <input
          id="rollout-models"
          className={css.input}
          type="text"
          value={modelsDraft}
          onChange={(e) => { setModelsDraft(e.target.value); return undefined }}
          onBlur={commitModels}
        />
        <span className={css.desc}>{t('settings.workerModels.desc')}</span>
      </div>

      <div className={css.row}>
        <label className={css.label}>
          <input
            type="checkbox"
            className={css.checkbox}
            checked={state.autoMilestone}
            onChange={(e) => { void set('autoMilestone', e.target.checked) }}
          />
          {t('settings.autoMilestone.label')}
        </label>
        <span className={css.desc}>{t('settings.autoMilestone.desc')}</span>
      </div>
    </div>
  )
}
