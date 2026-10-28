/**
 * Claude Code session controls, derived the way `@agentclientprotocol/claude-agent-acp`
 * derives them for `session/new` (session-mode.js, session-model.js, session-effort.js and
 * `buildConfigOptions` in acp-agent.js), so the option ids, categories, value strings and
 * names a native session reports are the ones DSH saved under the ACP route.
 *
 * Pure functions only: the transport feeds them the CLI's `initialize` answer
 * (`models`, `agents`, fast-mode state) and its merged settings.
 */
import type * as acp from '@agentclientprotocol/sdk'

export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions' | 'dontAsk'

export const MODE_CONFIG_ID = 'mode'
export const MODEL_CONFIG_ID = 'model'
export const EFFORT_CONFIG_ID = 'effort'
export const FAST_MODE_CONFIG_ID = 'fast'
export const AGENT_CONFIG_ID = 'agent'
export const DEFAULT_MODEL_ID = 'default'
export const DEFAULT_AGENT_ID = 'default'
/** Where an Auto request lands when the selected model cannot run Auto mode. */
export const AUTO_MODE_FALLBACK: ClaudePermissionMode = 'acceptEdits'
export const DEFAULT_CONTEXT_WINDOW = 200_000

/** One row of the CLI's model catalog (`initialize.models`). */
export interface ClaudeModelInfo {
  readonly value: string
  readonly displayName: string
  readonly description: string
  readonly resolvedModel?: string | undefined
  readonly supportsEffort?: boolean | undefined
  readonly supportedEffortLevels?: readonly string[] | undefined
  readonly supportsAdaptiveThinking?: boolean | undefined
  readonly supportsFastMode?: boolean | undefined
  readonly supportsAutoMode?: boolean | undefined
}

/** The model picker state: ACP `SessionModelState` without the unstable wrapper. */
export interface ClaudeModelState {
  readonly availableModels: readonly { readonly modelId: string; readonly name: string; readonly description?: string }[]
  readonly currentModelId: string
}

/** The slice of Claude Code's merged settings the controls depend on. */
export interface ClaudeSettingsView {
  readonly model?: unknown
  readonly availableModels?: unknown
  readonly modelOverrides?: Readonly<Record<string, string>> | undefined
  readonly deniedModels?: readonly string[] | undefined
  readonly effortLevel?: unknown
  readonly modelSettings?: Readonly<Record<string, { readonly effortLevel?: unknown } | undefined>> | undefined
  readonly ultracode?: unknown
  readonly permissions?: { readonly defaultMode?: unknown; readonly disableBypassPermissionsMode?: unknown } | undefined
}

/** The one object guard of the Claude transport family: fields stay `unknown` until checked. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const optionalText = (key: 'description', value: string | null | undefined): { description?: string } =>
  typeof value === 'string' ? { [key]: value } : {}

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

/** Validate the CLI's model rows; malformed rows are dropped. */
export function parseClaudeModelInfos(raw: unknown): ClaudeModelInfo[] {
  if (!Array.isArray(raw)) return []
  const models: ClaudeModelInfo[] = []
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry['value'] !== 'string' || entry['value'] === '') continue
    const levels = Array.isArray(entry['supportedEffortLevels'])
      ? entry['supportedEffortLevels'].filter((level): level is string => typeof level === 'string')
      : undefined
    models.push({
      value: entry['value'],
      displayName: typeof entry['displayName'] === 'string' ? entry['displayName'] : entry['value'],
      description: typeof entry['description'] === 'string' ? entry['description'] : '',
      ...(typeof entry['resolvedModel'] === 'string' ? { resolvedModel: entry['resolvedModel'] } : {}),
      ...(typeof entry['supportsEffort'] === 'boolean' ? { supportsEffort: entry['supportsEffort'] } : {}),
      ...(levels === undefined ? {} : { supportedEffortLevels: levels }),
      ...(typeof entry['supportsAdaptiveThinking'] === 'boolean'
        ? { supportsAdaptiveThinking: entry['supportsAdaptiveThinking'] }
        : {}),
      ...(typeof entry['supportsFastMode'] === 'boolean' ? { supportsFastMode: entry['supportsFastMode'] } : {}),
      ...(typeof entry['supportsAutoMode'] === 'boolean' ? { supportsAutoMode: entry['supportsAutoMode'] } : {}),
    })
  }
  return models
}

const MODEL_CONTEXT_HINT_PATTERN = /\[(\d+m)\]$/i
const CONTEXT_HINT_SUFFIX_PATTERN = /-(\d+m)$/i
const MODEL_FAMILY_VERSION_PATTERN = /\b(\d+)(?:[-.](\d+))?\b/
const VERSIONABLE_MODEL_DISPLAY_PATTERN =
  /^(?:Claude\s+)?([a-z][a-z0-9-]*)(?:\s+\d+(?:\.\d+)?)?(?:\s+\(\d+[mk]\s+context\))?$/i
const DISPLAY_CONTEXT_SUFFIX_PATTERN = /\s+\((\d+[mk])\s+context\)$/i
const MODEL_FAMILY_ALIASES: Readonly<Record<string, true>> = { opus: true, sonnet: true, haiku: true, fable: true }

function stripContextHints(value: string): string {
  return value.replace(/\[\d+m\]/gi, '').replace(CONTEXT_HINT_SUFFIX_PATTERN, '')
}

function canonicalizeModelId(value: string): string {
  return value.trim().toLowerCase().replace(CONTEXT_HINT_SUFFIX_PATTERN, '[$1]')
}

function contextHintOf(value: string): string | null {
  return canonicalizeModelId(value).match(MODEL_CONTEXT_HINT_PATTERN)?.[1] ?? null
}

function extractModelFamilyVersion(value: string): string | null {
  const match = stripContextHints(value).match(MODEL_FAMILY_VERSION_PATTERN)
  if (!match) return null
  return match[2] ? `${match[1]}.${match[2]}` : (match[1] ?? null)
}

function modelVersionsCompatible(preference: string, candidate: ClaudeModelInfo): boolean {
  const preferred = extractModelFamilyVersion(preference)
  if (!preferred) return true
  const candidateVersion =
    extractModelFamilyVersion(candidate.value) ??
    extractModelFamilyVersion(candidate.displayName) ??
    extractModelFamilyVersion(candidate.description)
  return candidateVersion ? preferred === candidateVersion : true
}

function displayModelVersion(model: ClaudeModelInfo, family: string): string | undefined {
  const familyVersion = new RegExp(`\\b${family}[-\\s]+(\\d+)(?:[-.](\\d+))?`, 'i')
  for (const source of [model.resolvedModel, model.description, model.value]) {
    const match = source?.match(familyVersion)
    if (match) return match[2] ? `${match[1]}.${match[2]}` : match[1]
  }
  return undefined
}

/** Add concrete versions when a terse catalog label names the same family as the model metadata. */
export function versionedModelDisplayName(model: ClaudeModelInfo): string {
  const versionable = model.displayName.match(VERSIONABLE_MODEL_DISPLAY_PATTERN)
  if (!versionable) return model.displayName
  const version = displayModelVersion(model, versionable[1] ?? '')
  if (!version) return model.displayName
  const contextSuffix = model.displayName.match(DISPLAY_CONTEXT_SUFFIX_PATTERN)
  const descriptionKeepsContext =
    contextSuffix !== null && new RegExp(`\\b${contextSuffix[1]}\\s+context\\b`, 'i').test(model.description)
  const withoutContext = model.displayName.replace(DISPLAY_CONTEXT_SUFFIX_PATTERN, '')
  if (/\b\d+(?:\.\d+)?\b/.test(withoutContext)) return descriptionKeepsContext ? withoutContext : model.displayName
  if (descriptionKeepsContext || contextSuffix === null) return `${withoutContext} ${version}`
  return `${withoutContext} ${version}${contextSuffix[0]}`
}

function tokenizeModelPreference(model: string): { tokens: string[]; contextHint: string | undefined } {
  const lower = model.trim().toLowerCase()
  const contextHint = lower.match(MODEL_CONTEXT_HINT_PATTERN)?.[1]?.toLowerCase()
  const tokens = lower
    .replace(MODEL_CONTEXT_HINT_PATTERN, ' $1 ')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((token) => (token === 'opusplan' ? 'opus' : token === 'best' || token === 'default' ? '' : token))
    .filter((token) => token && token !== 'claude')
    .filter((token) => /[a-z]/.test(token) || token.endsWith('m'))
  return { tokens, contextHint }
}

function scoreModelMatch(model: ClaudeModelInfo, tokens: readonly string[], contextHint: string | undefined): number {
  const haystack = `${model.value} ${model.displayName}`.toLowerCase()
  let score = 0
  let nonHintMatched = false
  for (const token of tokens) {
    if (!haystack.includes(token)) continue
    if (token !== contextHint) nonHintMatched = true
    score += token === contextHint ? 3 : 1
  }
  return contextHint && !nonHintMatched ? 0 : score
}

/** Map a user/settings model spelling onto a catalog row (exact, resolved id, substring, then token score). */
export function resolveModelPreference(models: readonly ClaudeModelInfo[], preference: string): ClaudeModelInfo | null {
  const trimmed = preference.trim()
  if (!trimmed) return null
  const lower = trimmed.toLowerCase()
  const canonicalPreference = canonicalizeModelId(trimmed)
  const directMatch = models.find(
    (model) =>
      model.value === trimmed ||
      canonicalizeModelId(model.value) === canonicalPreference ||
      model.displayName.toLowerCase() === lower,
  )
  if (directMatch) return directMatch
  const matchesResolved = (model: ClaudeModelInfo): boolean =>
    model.resolvedModel != null && canonicalizeModelId(model.resolvedModel) === canonicalPreference
  const resolvedMatch = models.find((model) => model.value !== DEFAULT_MODEL_ID && matchesResolved(model)) ?? models.find(matchesResolved)
  if (resolvedMatch) return resolvedMatch
  const preferenceHint = contextHintOf(trimmed)
  const includesMatch = models.find((model) => {
    if (!modelVersionsCompatible(trimmed, model)) return false
    if (contextHintOf(model.value) !== preferenceHint) return false
    const value = model.value.toLowerCase()
    const display = model.displayName.toLowerCase()
    return value.includes(lower) || display.includes(lower) || lower.includes(value)
  })
  if (includesMatch) return includesMatch
  const { tokens, contextHint } = tokenizeModelPreference(trimmed)
  if (tokens.length === 0) return null
  let bestMatch: ClaudeModelInfo | null = null
  let bestScore = 0
  for (const model of models) {
    if (!modelVersionsCompatible(trimmed, model)) continue
    const score = scoreModelMatch(model, tokens, contextHint)
    if (score > 0 && (!bestMatch || score > bestScore)) {
      bestMatch = model
      bestScore = score
    }
  }
  return bestMatch
}

/** The catalog row a resumed conversation's live model corresponds to (a synthesized row when none does). */
export function matchResumedModel(models: readonly ClaudeModelInfo[], liveModel: string): ClaudeModelInfo {
  const live = canonicalizeModelId(liveModel)
  const defaultEntry = models.find((model) => model.value === DEFAULT_MODEL_ID)
  const defaultResolved = defaultEntry?.resolvedModel ? canonicalizeModelId(defaultEntry.resolvedModel) : undefined
  if (defaultEntry && defaultResolved === live) return defaultEntry
  const exactMatch = models.find((model) => model.resolvedModel && canonicalizeModelId(model.resolvedModel) === live)
  if (exactMatch) return exactMatch
  if (defaultEntry && defaultResolved && stripContextHints(defaultResolved) === stripContextHints(live)) return defaultEntry
  return resolveModelPreference(models, liveModel) ?? { value: liveModel, displayName: liveModel, description: '' }
}

function normalizeModelId(value: string): string {
  let id = stripContextHints(value.trim().toLowerCase())
  const providerPrefix = id.lastIndexOf('anthropic.')
  if (providerPrefix !== -1) id = id.slice(providerPrefix + 'anthropic.'.length)
  return id
    .replace(/@.*$/, '')
    .replace(/-v\d+(?::\d+)?$/, '')
    .replace(/-fast$/, '')
    .replace(/-\d{8}$/, '')
}

/** Whether managed `deniedModels` blocks a model id (a family alias blocks the whole family). */
export function isDeniedModel(modelId: string, deniedModels: readonly string[]): boolean {
  const id = normalizeModelId(modelId)
  if (!id) return false
  return deniedModels.some((entry) => {
    const denied = normalizeModelId(entry)
    if (!denied) return false
    if (Object.hasOwn(MODEL_FAMILY_ALIASES, denied)) return id === denied || id.includes(`-${denied}`)
    return id === denied || id.startsWith(`${denied}-`)
  })
}

/**
 * Restrict the catalog to the user's `availableModels` allowlist. The user's exact spellings (or
 * their `modelOverrides` targets) become the values passed to `set_model`; Default is always kept.
 */
export function applyAvailableModelsAllowlist(
  sdkModels: readonly ClaudeModelInfo[],
  allowlist: readonly string[],
  overrides: Readonly<Record<string, string>> | undefined,
  deniedModels: readonly string[],
  customModelOption: string | undefined,
): ClaudeModelInfo[] {
  const defaultModel = sdkModels.find((m) => m.value === DEFAULT_MODEL_ID) ?? {
    value: DEFAULT_MODEL_ID,
    displayName: 'Default',
    description: '',
  }
  const result: ClaudeModelInfo[] = [defaultModel]
  const seen = new Set<string>([defaultModel.value])
  const withoutDefault = sdkModels.filter((m) => m.value !== DEFAULT_MODEL_ID)
  for (const entry of allowlist) {
    const trimmed = entry.trim()
    if (!trimmed || seen.has(trimmed)) continue
    const effective = overrides?.[trimmed] ?? trimmed
    if (seen.has(effective)) continue
    const sdkMatch = resolveModelPreference(withoutDefault, trimmed)
    if ([trimmed, effective, sdkMatch?.resolvedModel].some((id) => id != null && isDeniedModel(id, deniedModels))) continue
    result.push(sdkMatch ? { ...sdkMatch, value: effective } : { value: effective, displayName: trimmed, description: '' })
    seen.add(effective)
  }
  const custom = customModelOption?.trim()
  if (custom && !seen.has(custom)) {
    const customModel = sdkModels.find((m) => m.value === custom)
    if (customModel) result.push(customModel)
  }
  return result
}

/** What `getAvailableModels` decided: the picker state and the `set_model` the session must issue. */
export interface ClaudeInitialModelChoice {
  readonly state: ClaudeModelState
  /** Model value to send with `set_model`; undefined when the CLI already runs the chosen model. */
  readonly setModel: string | undefined
  /** The model to report when `set_model` is vetoed or fails on a fresh session. */
  readonly modelBeforeSwitch: string
  readonly switchToListed: boolean
}

/**
 * Pick the session's current model with claude-agent-acp's priority: ANTHROPIC_MODEL, settings
 * `model`, the resumed conversation's model, then the first catalog row.
 */
export function chooseInitialModel(input: {
  readonly models: readonly ClaudeModelInfo[]
  readonly sdkModels: readonly ClaudeModelInfo[]
  readonly settingsModel: unknown
  readonly envModel: string | undefined
  readonly resumed: boolean
  readonly resumedModelHint: string | undefined
  readonly log?: ((message: string) => void) | undefined
}): ClaudeInitialModelChoice {
  const { models, sdkModels, resumed, resumedModelHint } = input
  if (models.length === 0) {
    return {
      state: {
        availableModels: [],
        currentModelId: (resumed && resumedModelHint) || sdkModels[0]?.value || DEFAULT_MODEL_ID,
      },
      setModel: undefined,
      modelBeforeSwitch: sdkModels[0]?.value || DEFAULT_MODEL_ID,
      switchToListed: false,
    }
  }
  let currentModel: ClaudeModelInfo = models[0] as ClaudeModelInfo
  let resolvedFromInput: string | undefined
  if (input.envModel) {
    const match = resolveModelPreference(models, input.envModel)
    if (match) {
      currentModel = match
      resolvedFromInput = input.envModel
    }
  } else if (input.settingsModel !== undefined) {
    if (typeof input.settingsModel !== 'string') {
      input.log?.(`Ignoring model from settings: expected a string, got ${input.settingsModel === null ? 'null' : typeof input.settingsModel}.`)
    } else {
      const match = resolveModelPreference(models, input.settingsModel)
      if (match) {
        currentModel = match
        resolvedFromInput = input.settingsModel
      }
    }
  }
  if (resolvedFromInput === undefined && resumed) {
    currentModel = resumedModelHint ? matchResumedModel(models, resumedModelHint) : currentModel
  }
  const sdkSawSameValue = sdkModels.some((m) => m.value === currentModel.value)
  const sdkDefault = sdkModels.find((m) => m.value === DEFAULT_MODEL_ID)
  const sdkDefaultDropped = sdkDefault !== undefined && !models.some((m) => m.value === DEFAULT_MODEL_ID)
  const switchToListed = resolvedFromInput === undefined && (!resumed || !resumedModelHint) && sdkDefaultDropped
  const skipSetModel =
    (resolvedFromInput === undefined && !switchToListed) ||
    (!resumed && currentModel.value === resolvedFromInput && sdkSawSameValue)
  const displayNames = models.map(versionedModelDisplayName)
  const counts = new Map<string, number>()
  for (const name of displayNames) counts.set(name, (counts.get(name) ?? 0) + 1)
  return {
    state: {
      availableModels: models.map((model, index) => ({
        modelId: model.value,
        name: counts.get(displayNames[index] ?? '') === 1 ? (displayNames[index] ?? model.displayName) : model.displayName,
        ...optionalText('description', model.description),
      })),
      currentModelId: currentModel.value,
    },
    setModel: skipSetModel ? undefined : currentModel.value,
    modelBeforeSwitch: (switchToListed && sdkDefault !== undefined ? sdkDefault : (models[0] as ClaudeModelInfo)).value,
    switchToListed,
  }
}

/** Whether a rejected `set_model` was vetoed by a user-configured PreModelSwitch hook. */
export function isPreModelSwitchHookBlock(error: unknown): boolean {
  return error instanceof Error && error.message.includes('blocked by a PreModelSwitch hook')
}

/**
 * Register capabilities of the live model under its verbatim id when it is not a catalog row
 * (a resumed conversation on an allowlist-excluded model), so effort and Auto lookups still work.
 */
export function withLiveModelInfo(
  allowed: readonly ClaudeModelInfo[],
  sdkModels: readonly ClaudeModelInfo[],
  currentModelId: string,
): { readonly modelInfos: ClaudeModelInfo[]; readonly currentModelInfo: ClaudeModelInfo | undefined } {
  const allowlisted = allowed.find((m) => m.value === currentModelId)
  const fallback = allowlisted ? undefined : (resolveModelPreference(sdkModels, currentModelId) ?? undefined)
  const currentModelInfo = allowlisted ?? fallback
  if (!fallback) return { modelInfos: [...allowed], currentModelInfo }
  const { resolvedModel: _resolved, ...capabilities } = fallback
  return {
    modelInfos: [...allowed, { ...capabilities, value: currentModelId, displayName: currentModelId, description: '' }],
    currentModelInfo,
  }
}

/** Context window to assume before the CLI reports one: a "1m" hint in the model text, else 200k. */
export function inferContextWindow(...texts: readonly (string | null | undefined)[]): number {
  return texts.some((text) => text != null && /\b1m\b/i.test(text)) ? 1_000_000 : DEFAULT_CONTEXT_WINDOW
}

// ---------------------------------------------------------------------------
// Permission modes
// ---------------------------------------------------------------------------

const PERMISSION_MODE_ALIASES: Readonly<Record<string, ClaudePermissionMode>> = {
  auto: 'auto',
  default: 'default',
  manual: 'default',
  acceptedits: 'acceptEdits',
  dontask: 'dontAsk',
  plan: 'plan',
  bypasspermissions: 'bypassPermissions',
  bypass: 'bypassPermissions',
}

/** Settings spelling → wire mode; `bypassPermissions` clamps to `default` when bypass is unavailable. */
export function resolvePermissionMode(
  value: unknown,
  allowBypass: boolean,
  log?: (message: string) => void,
): ClaudePermissionMode {
  if (value === undefined) return 'default'
  if (typeof value !== 'string') {
    log?.('Ignoring permissions.defaultMode from settings: expected a string.')
    return 'default'
  }
  const normalized = value.trim().toLowerCase()
  if (normalized === '') {
    log?.('Ignoring permissions.defaultMode from settings: expected a non-empty string.')
    return 'default'
  }
  const mapped = Object.hasOwn(PERMISSION_MODE_ALIASES, normalized) ? PERMISSION_MODE_ALIASES[normalized] : undefined
  if (!mapped) {
    log?.(`Ignoring permissions.defaultMode from settings: unknown value '${value}'.`)
    return 'default'
  }
  if (mapped === 'bypassPermissions' && !allowBypass) {
    log?.('Ignoring permission mode bypassPermissions: not available in this session.')
    return 'default'
  }
  return mapped
}

/** The mode a query starts in: an explicit mode, else the resumed transcript's, else the settings default. */
export function resolveInitialPermissionMode(
  sources: { readonly explicit?: unknown; readonly resumed?: unknown; readonly defaultMode?: unknown },
  allowBypass: boolean,
  log?: (message: string) => void,
): ClaudePermissionMode {
  if (sources.explicit !== undefined) return resolvePermissionMode(sources.explicit, allowBypass, log)
  if (sources.resumed !== undefined) {
    let rejected = false
    const mode = resolvePermissionMode(sources.resumed, allowBypass, () => {
      rejected = true
    })
    if (!rejected) return mode
    log?.(`Ignoring permission mode "${String(sources.resumed)}" of the resumed transcript: not available in this session.`)
  }
  return resolvePermissionMode(sources.defaultMode, allowBypass, log)
}

/** The modes claude-agent-acp lists; bypass only when the session may use it. */
export function buildClaudeAvailableModes(allowBypass: boolean): acp.SessionMode[] {
  const modes: acp.SessionMode[] = [
    { id: 'default', name: 'Manual', description: 'Always ask before making changes' },
    { id: 'acceptEdits', name: 'Accept edits', description: 'Automatically accept all file edits' },
    { id: 'plan', name: 'Plan', description: 'Create a plan before making changes' },
    { id: 'auto', name: 'Auto', description: 'Claude handles permission decisions' },
  ]
  if (allowBypass) modes.push({ id: 'bypassPermissions', name: 'Bypass permissions', description: 'Accepts all permissions' })
  return modes
}

/** Wire mode names this session accepts as a mode change. */
export function parseSelectableMode(modeId: string): ClaudePermissionMode {
  switch (modeId) {
    case 'auto':
    case 'default':
    case 'acceptEdits':
    case 'bypassPermissions':
    case 'dontAsk':
    case 'plan':
      return modeId
    default:
      throw new Error('Invalid Mode')
  }
}

export function claudeModeConfigOption(modes: acp.SessionModeState): acp.SessionConfigOption {
  return {
    id: MODE_CONFIG_ID,
    name: 'Mode',
    description: 'Session permission mode',
    category: 'mode',
    type: 'select',
    currentValue: modes.currentModeId,
    options: modes.availableModes.map((mode) => ({
      value: mode.id,
      name: mode.name,
      ...optionalText('description', mode.description),
    })),
  }
}

// ---------------------------------------------------------------------------
// Effort, fast mode, agents
// ---------------------------------------------------------------------------

const canonicalizeModelSettingsKey = (value: string): string =>
  value.trim().toLowerCase().replace(/-(\d+m)$/i, '[$1]')

/** The effort the CLI will use from settings: per-model entry first, then the top-level value. */
export function settingsEffortForModel(
  settings: ClaudeSettingsView,
  modelInfo: ClaudeModelInfo | undefined,
  modelId?: string,
): string | undefined {
  const modelSettings = settings.modelSettings
  if (modelSettings) {
    for (const key of [modelInfo?.resolvedModel, modelInfo?.value, modelId]) {
      if (key === undefined) continue
      const exact = modelSettings[key]?.effortLevel
      if (typeof exact === 'string') return exact
      const canonicalKey = canonicalizeModelSettingsKey(key)
      const matching = Object.entries(modelSettings).find(([candidate]) => canonicalizeModelSettingsKey(candidate) === canonicalKey)
      const perModel = matching?.[1]?.effortLevel
      if (typeof perModel === 'string') return perModel
    }
  }
  return typeof settings.effortLevel === 'string' ? settings.effortLevel : undefined
}

/** `apply_flag_settings` payload for an effort pick; `default`/absent clears the flag layer with `null`. */
export function effortFlagSettings(value: string | undefined, settings: ClaudeSettingsView): Record<string, unknown> {
  const effortLevel = value === undefined || value === DEFAULT_MODEL_ID ? null : value
  return settings.ultracode === true ? { effortLevel, ultracode: true } : { effortLevel }
}

const effortName = (level: string): string =>
  level
    .split(/[_-]/)
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(' ')

export function buildEffortConfigOption(
  modelInfos: readonly ClaudeModelInfo[],
  currentModelId: string,
  currentEffortLevel: string | undefined,
): acp.SessionConfigOption | undefined {
  const info = modelInfos.find((model) => model.value === currentModelId)
  const supported = info?.supportsEffort ? (info.supportedEffortLevels ?? []) : []
  if (supported.length === 0) return undefined
  const currentValue =
    currentEffortLevel && (currentEffortLevel === DEFAULT_MODEL_ID || supported.includes(currentEffortLevel))
      ? currentEffortLevel
      : DEFAULT_MODEL_ID
  return {
    id: EFFORT_CONFIG_ID,
    name: 'Effort',
    description: 'Available effort levels for this model',
    category: 'thought_level',
    type: 'select',
    currentValue,
    options: [
      { value: DEFAULT_MODEL_ID, name: 'Default' },
      ...supported.map((level) => ({ value: level, name: effortName(level) })),
    ],
  }
}

const FAST_MODE_UNAVAILABLE_EXPLANATIONS: Readonly<Record<string, string>> = {
  free: 'not available on the free plan',
  extra_usage_disabled: 'requires extra usage to be enabled for this account',
  model_not_allowed: 'not available for the selected model',
  not_first_party: 'not available on this API provider',
  disabled_by_env: 'disabled by environment configuration',
  network_error: 'eligibility could not be verified (network error)',
}

/** Keep only the disabled reasons a user can act on; routine reports never churn the option. */
export function normalizeFastModeDisabledReason(reason: unknown): string | undefined {
  return typeof reason === 'string' && Object.hasOwn(FAST_MODE_UNAVAILABLE_EXPLANATIONS, reason) ? reason : undefined
}

export const fastModeStateEnabled = (state: unknown): boolean => state !== 'off'

/** Fast mode as a select (DSH's client does not opt into boolean config options). */
export function claudeFastModeOption(enabled: boolean, disabledReason: string | undefined): acp.SessionConfigOption {
  const explanation =
    enabled || disabledReason === undefined || !Object.hasOwn(FAST_MODE_UNAVAILABLE_EXPLANATIONS, disabledReason)
      ? undefined
      : FAST_MODE_UNAVAILABLE_EXPLANATIONS[disabledReason]
  return {
    id: FAST_MODE_CONFIG_ID,
    name: 'Fast mode',
    description: explanation ? `Faster responses on supported models — ${explanation}` : 'Faster responses on supported models',
    category: 'model_config',
    type: 'select',
    currentValue: enabled ? 'on' : 'off',
    options: [
      { value: 'on', name: 'On' },
      { value: 'off', name: 'Off' },
    ],
  }
}

/** A fast-mode pick: `on`/`off` select values or a boolean. */
export function resolveFastModeEnabled(value: string | boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'on') return true
  if (value === 'off') return false
  throw new Error(`Invalid value for config option ${FAST_MODE_CONFIG_ID}: ${value}`)
}

/** Built-in subagents are not main-thread personas, so they never reach the Agent picker. */
const BUILTIN_AGENT_NAMES: Readonly<Record<string, true>> = {
  claude: true,
  'general-purpose': true,
  Explore: true,
  Plan: true,
  'statusline-setup': true,
}

export interface ClaudeAgentInfo {
  readonly name: string
  readonly description: string
}

export function discoverCustomAgents(raw: unknown): ClaudeAgentInfo[] {
  if (!Array.isArray(raw)) return []
  const agents: ClaudeAgentInfo[] = []
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry['name'] !== 'string') continue
    if (Object.hasOwn(BUILTIN_AGENT_NAMES, entry['name']) || entry['name'] === DEFAULT_AGENT_ID) continue
    agents.push({ name: entry['name'], description: typeof entry['description'] === 'string' ? entry['description'] : '' })
  }
  return agents
}

// ---------------------------------------------------------------------------
// Option assembly
// ---------------------------------------------------------------------------

export function buildClaudeModelConfigOption(
  models: ClaudeModelState,
  modelInfos: readonly ClaudeModelInfo[],
): acp.SessionConfigOption {
  const defaultInfo = modelInfos.find((model) => model.value === DEFAULT_MODEL_ID)
  return {
    id: MODEL_CONFIG_ID,
    name: 'Model',
    description: 'AI model to use',
    category: 'model',
    type: 'select',
    currentValue: models.currentModelId,
    options: models.availableModels.map((model) => {
      if (model.modelId === DEFAULT_MODEL_ID && defaultInfo?.resolvedModel) {
        const named = modelInfos.find((info) => info.value !== DEFAULT_MODEL_ID && info.resolvedModel === defaultInfo.resolvedModel)
        return { value: model.modelId, name: model.name, description: named?.displayName ?? defaultInfo.resolvedModel }
      }
      return { value: model.modelId, name: model.name, ...optionalText('description', model.description) }
    }),
  }
}

export interface ClaudeOptionsInput {
  readonly modes: acp.SessionModeState
  readonly models: ClaudeModelState
  readonly modelInfos: readonly ClaudeModelInfo[]
  readonly effortLevel: string | undefined
  readonly agents: readonly ClaudeAgentInfo[]
  readonly currentAgent: string
  readonly fast: { readonly supported: boolean; readonly enabled: boolean; readonly disabledReason: string | undefined }
}

/** `mode`, `model`, `effort`, `fast`, `agent` — in the order and shapes claude-agent-acp returns them. */
export function buildClaudeConfigOptions(input: ClaudeOptionsInput): acp.SessionConfigOption[] {
  const options: acp.SessionConfigOption[] = [claudeModeConfigOption(input.modes)]
  if (input.models.availableModels.length > 0) options.push(buildClaudeModelConfigOption(input.models, input.modelInfos))
  const effort = buildEffortConfigOption(input.modelInfos, input.models.currentModelId, input.effortLevel)
  if (effort) options.push(effort)
  if (input.fast.supported) options.push(claudeFastModeOption(input.fast.enabled, input.fast.disabledReason))
  if (input.agents.length > 0) {
    options.push({
      id: AGENT_CONFIG_ID,
      name: 'Agent',
      description: 'Main-thread agent persona',
      type: 'select',
      currentValue: input.currentAgent,
      options: [
        { value: DEFAULT_AGENT_ID, name: 'Default', description: 'Standard Claude Code agent' },
        ...input.agents.map((agent) => ({
          value: agent.name,
          name: agent.name,
          ...optionalText('description', agent.description || undefined),
        })),
      ],
    })
  }
  return options
}

/** Flat list of every selectable value of a select option. */
export function selectValues(option: acp.SessionConfigOption): string[] {
  if (option.type !== 'select') return []
  return (option.options as readonly (acp.SessionConfigSelectOption | acp.SessionConfigSelectGroup)[]).flatMap((entry) =>
    'options' in entry ? entry.options.map((nested) => nested.value) : [entry.value],
  )
}

/** Immutable copy of `options` with one select's current value replaced. */
export function withCurrentValue(
  options: readonly acp.SessionConfigOption[],
  configId: string,
  value: string,
): acp.SessionConfigOption[] {
  return options.map((option) => (option.id === configId && option.type === 'select' ? { ...option, currentValue: value } : option))
}
