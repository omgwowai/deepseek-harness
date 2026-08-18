/**
 * TokenRouter rollout web surface, browser half: the composer rollout button,
 * the settings page, and the session-details stats footer. The button reads
 * the `tokenrouter-rollout` settings namespace through a shared synced store
 * for its enabled state and executes `/rollout` through the command channel;
 * the settings page owns the section and writes through the scope; the stats
 * footer renders the `rolloutStats` projection.
 */
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (input.right, composer.dock).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the ui-layout SlotMap merge (details slot props).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the settings slot declarations.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the rolloutStats SessionProjectionMap merge for useProjection.
import type {} from '@deepseek-ai/dsh-tokenrouter-rollout/types'
import { RolloutButton } from './RolloutButton.tsx'
import { RolloutSettings } from './RolloutSettings.tsx'
import { RolloutStatsPanel } from './RolloutStatsPanel.tsx'
import { createRolloutSettingsStore, ROLLOUT_DEFAULTS, type RolloutSettingsState } from './settings-store.ts'
import { en, zh, type RolloutKey } from './locales.ts'

export type { RolloutKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The rollout button/settings/stats copy. */
    rollout: RolloutKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'rollout'

/** The settings namespace the host plugin owns. */
export const ROLLOUT_SETTINGS_NAMESPACE = 'tokenrouter-rollout' as const

/** Settings-section shape the settings page edits. */
export interface RolloutSettingsView {
  enabled?: boolean
  rolloutCount?: number
  judgeModel?: string
  judgeBaseURL?: string
  workerModels?: string[]
  autoMilestone?: boolean
}

/** Injected business face of the composer rollout button. */
export interface RolloutButtonInjected {
  /**
   * Start a rollout round for one session.
   * @returns null on admitted execution; a user-visible failure line otherwise.
   */
  run: (sessionId: SessionId) => Promise<string | null>
}

/** Injected business face of the settings page. */
export interface RolloutSettingsInjected {
  /** Persist one field. */
  set: (field: string, value: unknown) => Promise<void>
  /** Clear one field (re-inherit the composition default). */
  unset: (field: string) => Promise<void>
}

/** Required services: slots, command Remote, locale, and the settings scope transport. */
export const inject = ['slots', 'remote', 'remote.commands', 'locale', 'settingsScope']

/** Map one settings snapshot into the store's draft shape. */
function viewToState(view: RolloutSettingsView | undefined): Omit<RolloutSettingsState, 'revision'> {
  return {
    enabled: view?.enabled ?? ROLLOUT_DEFAULTS.enabled,
    rolloutCount: view?.rolloutCount ?? ROLLOUT_DEFAULTS.rolloutCount,
    judgeModel: view?.judgeModel ?? ROLLOUT_DEFAULTS.judgeModel,
    judgeBaseURL: view?.judgeBaseURL ?? ROLLOUT_DEFAULTS.judgeBaseURL,
    workerModels: view?.workerModels ?? ROLLOUT_DEFAULTS.workerModels,
    autoMilestone: view?.autoMilestone ?? ROLLOUT_DEFAULTS.autoMilestone,
  }
}

/**
 * Client plugin body: register the rollout button, settings section, and
 * stats footer, each once its slot declaration is on the ledger. The settings
 * scope is subscribed once; both surfaces hold their own store handle (slot
 * handles pin to one scope, and the button is session-scoped while the
 * settings page is root-scoped), each adopting the same mirrored snapshot.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-rollout: dictionaries')

  // The settings namespace this surface edits. The host plugin owns the same
  // namespace; the scope read/write path is the shared settings transport.
  const scope = ctx.settingsScope.bind<RolloutSettingsView>({ namespace: ROLLOUT_SETTINGS_NAMESPACE })
  const buttonStore = createRolloutSettingsStore()
  const settingsStore = createRolloutSettingsStore()

  // The session-scoped button holds one handle; the root-scoped settings page
  // holds the other. The scope subscription mirrors into the handle whose
  // inject has run (both are adopted at inject time too, so no update is
  // ever lost between subscribe and first inject).
  let buttonActions: BoundActions<typeof buttonStore> | undefined
  let settingsActions: BoundActions<typeof settingsStore> | undefined
  let lastRevision = -1
  ctx.effect(() => scope.subscribe(() => {
    const snapshot = scope.getSnapshot()
    const revision = snapshot.revision ?? -1
    if (revision === lastRevision) return
    lastRevision = revision
    const state = viewToState(snapshot.value)
    if (buttonActions !== undefined) buttonActions.sync(state, revision)
    if (settingsActions !== undefined) settingsActions.sync(state, revision)
  }), 'ui-rollout: settings scope mirror')

  const adoptButton = (actions: BoundActions<typeof buttonStore>): void => {
    buttonActions = actions
    const snapshot = scope.getSnapshot()
    lastRevision = snapshot.revision ?? -1
    actions.sync(viewToState(snapshot.value), lastRevision)
  }
  const adoptSettings = (actions: BoundActions<typeof settingsStore>): void => {
    settingsActions = actions
    const snapshot = scope.getSnapshot()
    lastRevision = snapshot.revision ?? -1
    actions.sync(viewToState(snapshot.value), lastRevision)
  }

  // Composer button: reads enabled off the synced store.
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'rollout',
    order: 90,
    store: buttonStore,
    locale: NS,
    inject: (_sessionId: SessionId, actions: BoundActions<typeof buttonStore>): RolloutButtonInjected => {
      adoptButton(actions)
      return {
        run: async (sid) => {
          const result = await ctx.remote.commands.execute(sid, '/rollout')
          if (!result.ok) return `${result.error.message} (${result.error.code})`
          if (result.value === undefined) return 'unknown command: /rollout'
          return null
        },
      }
    },
  }, RolloutButton))

  // Settings page: owns the section; writes route through the scope so they
  // persist and apply live on the host.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'rollout',
    order: 60,
    label: () => ctx.locale.bind(NS)('settings.section.title'),
    store: settingsStore,
    locale: NS,
    inject: (actions: BoundActions<typeof settingsStore>): RolloutSettingsInjected => {
      adoptSettings(actions)
      return {
        set: (field, value) => scope.set(field, value),
        unset: field => scope.unset(field),
      }
    },
  }, RolloutSettings))

  // Session-details footer: the rollout stats readout.
  ctx.slots.inject('conversation.details.footer', () => ctx.slots.register({
    name: 'conversation.details.footer',
    id: 'rollout-stats',
    order: 0,
    locale: NS,
  }, RolloutStatsPanel))
}
