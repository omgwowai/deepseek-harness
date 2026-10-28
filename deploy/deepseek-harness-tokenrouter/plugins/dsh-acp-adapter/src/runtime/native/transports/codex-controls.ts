/**
 * Session controls of the Codex native transport.
 *
 * Mirrors `@agentclientprotocol/codex-acp` 2.2.x so that DSH state saved while
 * the profile ran Codex over ACP (mode intents, the model picker, reasoning
 * effort) keeps resolving: the same option ids (`mode`, `collaboration_mode`,
 * `model`, `reasoning_effort`, `fast-mode`), categories, value strings, names
 * and descriptions, derived from the same sources:
 *
 *   - modes: the fixed `AgentMode` table (approval policy + sandbox + reviewer);
 *   - models and reasoning efforts: the app-server `model/list` catalogue;
 *   - the current model / effort: the `thread/start|resume|fork` response.
 *
 * The state is pure data; the transport performs the I/O (`thread/settings/update`
 * for the collaboration mode, `turn/start` overrides for everything else).
 */
import type * as acp from '@agentclientprotocol/sdk'

import { NATIVE_MODE_CONTRACTS, codexModeSettings, type CodexModeSettings } from '../session-modes.ts'
import { isRecord, readString, readStringArray } from './codex-json.ts'
import { NativeTransportError, type NativeControls } from './contract.ts'

// ---------------------------------------------------------------------------
// Modes (codex-acp `AgentMode`; the single table lives in `../session-modes.ts`)
// ---------------------------------------------------------------------------

/** One Codex preset: how it is listed and the app-server settings the next `turn/start` carries. */
export interface CodexAgentMode {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly settings: CodexModeSettings
}

export const CODEX_AGENT_MODES: readonly CodexAgentMode[] = NATIVE_MODE_CONTRACTS.codex.modes.map((mode) => {
  const settings = codexModeSettings(mode.id)
  if (settings === undefined) throw new Error(`the Codex mode ${mode.id} has no app-server settings`)
  return { id: mode.id, name: mode.name, description: mode.description, settings }
})

export function findCodexMode(modeId: string): CodexAgentMode | undefined {
  return CODEX_AGENT_MODES.find((mode) => mode.id === modeId)
}

/** codex-acp `AgentMode.getInitialAgentMode`: `INITIAL_AGENT_MODE` or the vendor default preset. */
export function initialCodexMode(env: Readonly<Record<string, string>>): CodexAgentMode {
  const fallback = findCodexMode(NATIVE_MODE_CONTRACTS.codex.defaultModeId)
  if (fallback === undefined) throw new Error('the default Codex mode is not registered')
  const requested = env['INITIAL_AGENT_MODE']
  return requested === undefined || requested === '' ? fallback : (findCodexMode(requested) ?? fallback)
}

// ---------------------------------------------------------------------------
// Collaboration mode (codex-acp `CollaborationModeConfig`)
// ---------------------------------------------------------------------------

export type CodexCollaborationMode = 'default' | 'plan'

export function parseCodexCollaborationMode(value: unknown): CodexCollaborationMode | undefined {
  return value === 'default' || value === 'plan' ? value : undefined
}

// ---------------------------------------------------------------------------
// Model catalogue (`model/list`)
// ---------------------------------------------------------------------------

export interface CodexReasoningEffortInfo {
  readonly reasoningEffort: string
  readonly description: string | null
}

export interface CodexModelInfo {
  readonly id: string
  readonly displayName: string
  readonly description: string | null
  readonly isDefault: boolean
  readonly defaultReasoningEffort: string
  readonly supportedReasoningEfforts: readonly CodexReasoningEffortInfo[]
  readonly inputModalities: readonly string[]
  readonly additionalSpeedTiers: readonly string[]
}

function parseReasoningEfforts(value: unknown): CodexReasoningEffortInfo[] {
  if (!Array.isArray(value)) return []
  const efforts: CodexReasoningEffortInfo[] = []
  for (const entry of value) {
    if (typeof entry === 'string') {
      efforts.push({ reasoningEffort: entry, description: '' })
    } else if (isRecord(entry)) {
      const reasoningEffort = readString(entry, 'reasoningEffort')
      if (reasoningEffort === undefined) continue
      efforts.push({ reasoningEffort, description: readString(entry, 'description') ?? null })
    }
  }
  return efforts
}

/** Parse one `model/list` page entry; entries without an id cannot be selected and are dropped. */
export function parseCodexModel(value: unknown): CodexModelInfo | undefined {
  if (!isRecord(value)) return undefined
  const id = readString(value, 'id') ?? readString(value, 'model')
  if (id === undefined || id === '') return undefined
  const supportedReasoningEfforts = parseReasoningEfforts(value['supportedReasoningEfforts'])
  const inputModalities = readStringArray(value, 'inputModalities')
  return {
    id,
    displayName: readString(value, 'displayName') ?? id,
    description: readString(value, 'description') ?? null,
    isDefault: value['isDefault'] === true,
    defaultReasoningEffort:
      readString(value, 'defaultReasoningEffort') ?? supportedReasoningEfforts[0]?.reasoningEffort ?? 'medium',
    supportedReasoningEfforts,
    // codex-acp assumes text+image when the catalogue carries no modalities.
    inputModalities: Array.isArray(value['inputModalities']) ? inputModalities : ['text', 'image'],
    additionalSpeedTiers: readStringArray(value, 'additionalSpeedTiers'),
  }
}

export function parseCodexModelPage(result: unknown): { readonly models: CodexModelInfo[]; readonly nextCursor: string | null } {
  const models: CodexModelInfo[] = []
  const data = isRecord(result) ? result['data'] : undefined
  if (Array.isArray(data)) {
    for (const entry of data) {
      const model = parseCodexModel(entry)
      if (model !== undefined) models.push(model)
    }
  }
  const cursor = isRecord(result) ? result['nextCursor'] : undefined
  return { models, nextCursor: typeof cursor === 'string' && cursor !== '' ? cursor : null }
}

/** codex-acp `findSupportedEffort`. */
function findSupportedEffort(efforts: readonly CodexReasoningEffortInfo[], effort: string | undefined): string | undefined {
  if (effort === undefined || effort === '') return undefined
  return efforts.find((candidate) => candidate.reasoningEffort === effort)?.reasoningEffort
}

/** codex-acp `createModelId`: the (model, effort) pair a thread response selects. */
export function resolveCodexModelSelection(
  models: readonly CodexModelInfo[],
  modelId: string | undefined,
  reasoningEffort: string | undefined,
): { readonly model: string; readonly effort: string } {
  const selected = models.find((candidate) => candidate.id === modelId)
  if (selected !== undefined) {
    return { model: selected.id, effort: reasoningEffort ?? selected.defaultReasoningEffort }
  }
  if (modelId !== undefined && modelId !== '') return { model: modelId, effort: reasoningEffort ?? 'medium' }
  const fallback = models.find((candidate) => candidate.isDefault)
  if (fallback === undefined) {
    throw new NativeTransportError(
      'Codex did not report a current model and the catalogue has no default model',
      'no-models',
    )
  }
  return { model: fallback.id, effort: reasoningEffort ?? fallback.defaultReasoningEffort }
}

// ---------------------------------------------------------------------------
// Config option builders (codex-acp `ModelConfigOption` / `FastModeConfig`)
// ---------------------------------------------------------------------------

export const CODEX_MODE_CONFIG_ID = 'mode'
export const CODEX_COLLABORATION_CONFIG_ID = 'collaboration_mode'
export const CODEX_MODEL_CONFIG_ID = 'model'
export const CODEX_EFFORT_CONFIG_ID = 'reasoning_effort'
export const CODEX_FAST_MODE_CONFIG_ID = 'fast-mode'
const FAST_MODE_ON = 'on'
const FAST_MODE_OFF = 'off'
const FAST_MODE_DESCRIPTION = '1.5x speed, increased usage'

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/** `GPT-5.6-Sol` -> `5.6 Sol`; non-GPT names are kept. */
function formatModelDisplayName(displayName: string): string {
  if (!/^gpt-/i.test(displayName)) return displayName
  return displayName
    .replace(/^gpt-/i, '')
    .split(/[-/]+/)
    .filter(Boolean)
    .map(capitalize)
    .join(' ')
}

export function codexModelSupportsFast(model: CodexModelInfo | undefined): boolean {
  return model?.additionalSpeedTiers.includes('fast') ?? false
}

function modeConfigOption(mode: CodexAgentMode): acp.SessionConfigOption {
  return {
    id: CODEX_MODE_CONFIG_ID,
    name: 'Mode',
    description: 'Approval and sandboxing preset for the session',
    category: 'mode',
    type: 'select',
    currentValue: mode.id,
    options: CODEX_AGENT_MODES.map((candidate) => ({
      value: candidate.id,
      name: candidate.name,
      description: candidate.description,
    })),
  }
}

function collaborationConfigOption(current: CodexCollaborationMode): acp.SessionConfigOption {
  return {
    id: CODEX_COLLABORATION_CONFIG_ID,
    name: 'Collaboration mode',
    description: 'How Codex collaborates for subsequent turns',
    category: 'collaboration_mode',
    type: 'select',
    currentValue: current,
    options: [
      { value: 'default', name: 'Default' },
      { value: 'plan', name: 'Plan', description: 'Plan before making changes' },
    ],
  }
}

function modelConfigOption(models: readonly CodexModelInfo[], currentModelId: string): acp.SessionConfigOption {
  const options: acp.SessionConfigSelectOption[] = models.map((model) => ({
    value: model.id,
    name: formatModelDisplayName(model.displayName),
    description: model.description,
  }))
  if (!models.some((model) => model.id === currentModelId)) {
    options.unshift({ value: currentModelId, name: formatModelDisplayName(currentModelId), description: null })
  }
  return {
    id: CODEX_MODEL_CONFIG_ID,
    name: 'Model',
    description: 'Model Codex uses for the session',
    category: 'model',
    type: 'select',
    currentValue: currentModelId,
    options,
  }
}

function effortConfigOption(efforts: readonly CodexReasoningEffortInfo[], currentEffort: string): acp.SessionConfigOption {
  return {
    id: CODEX_EFFORT_CONFIG_ID,
    name: 'Reasoning effort',
    description: 'How much reasoning effort the model should use',
    category: 'thought_level',
    type: 'select',
    currentValue: currentEffort,
    options: efforts.map((option) => ({
      value: option.reasoningEffort,
      name: capitalize(option.reasoningEffort),
      description: option.description,
    })),
  }
}

function fastModeConfigOption(enabled: boolean): acp.SessionConfigOption {
  return {
    id: CODEX_FAST_MODE_CONFIG_ID,
    name: 'Fast mode',
    description: FAST_MODE_DESCRIPTION,
    category: 'model_config',
    type: 'select',
    currentValue: enabled ? FAST_MODE_ON : FAST_MODE_OFF,
    options: [
      { value: FAST_MODE_OFF, name: 'Off', description: 'Default speed, normal usage' },
      { value: FAST_MODE_ON, name: 'On', description: FAST_MODE_DESCRIPTION },
    ],
  }
}

function invalidValue(configId: string, value: string | boolean): NativeTransportError {
  return new NativeTransportError(
    `Codex does not accept ${JSON.stringify(value)} for the session option ${configId}`,
    'invalid-config-option',
  )
}

// ---------------------------------------------------------------------------
// Mutable control state
// ---------------------------------------------------------------------------

export interface CodexControlsInit {
  readonly mode: CodexAgentMode
  readonly collaborationMode: CodexCollaborationMode
  readonly models: readonly CodexModelInfo[]
  readonly modelId: string
  readonly effort: string
  readonly fastModeEnabled: boolean
}

/** What a session reports and what the next `turn/start` carries. */
export class CodexControlsState {
  mode: CodexAgentMode
  collaborationMode: CodexCollaborationMode
  models: readonly CodexModelInfo[]
  modelId: string
  effort: string
  fastModeEnabled: boolean

  constructor(init: CodexControlsInit) {
    this.mode = init.mode
    this.collaborationMode = init.collaborationMode
    this.models = init.models
    this.modelId = init.modelId
    this.effort = init.effort
    this.fastModeEnabled = init.fastModeEnabled
  }

  get currentModel(): CodexModelInfo | undefined {
    return this.models.find((model) => model.id === this.modelId)
  }

  get supportedEfforts(): readonly CodexReasoningEffortInfo[] {
    return this.currentModel?.supportedReasoningEfforts ?? []
  }

  get imageInput(): boolean {
    return (this.currentModel?.inputModalities ?? ['text', 'image']).includes('image')
  }

  /** `turn/start.serviceTier`: `fast` only when enabled and the model offers it. */
  get serviceTier(): 'fast' | null {
    return this.fastModeEnabled && codexModelSupportsFast(this.currentModel) ? 'fast' : null
  }

  /** codex-acp disables reasoning summaries for models without a reasoning scale. */
  get modelLacksReasoning(): boolean {
    const efforts = this.supportedEfforts
    return efforts.length > 0 && efforts.every((option) => option.reasoningEffort === 'none')
  }

  snapshot(): NativeControls {
    const configOptions: acp.SessionConfigOption[] = [
      modeConfigOption(this.mode),
      collaborationConfigOption(this.collaborationMode),
      modelConfigOption(this.models, this.modelId),
    ]
    if (this.supportedEfforts.length > 0) configOptions.push(effortConfigOption(this.supportedEfforts, this.effort))
    if (codexModelSupportsFast(this.currentModel)) configOptions.push(fastModeConfigOption(this.fastModeEnabled))
    return {
      configOptions,
      modes: {
        currentModeId: this.mode.id,
        availableModes: CODEX_AGENT_MODES.map((mode) => ({
          id: mode.id,
          name: mode.name,
          description: mode.description,
        })),
      },
      imageInput: this.imageInput,
    }
  }

  setMode(value: string | boolean): CodexAgentMode {
    const mode = typeof value === 'string' ? findCodexMode(value) : undefined
    if (mode === undefined) throw invalidValue(CODEX_MODE_CONFIG_ID, value)
    this.mode = mode
    return mode
  }

  /** Validates only; the transport sends `thread/settings/update` and then commits. */
  parseCollaborationMode(value: string | boolean): CodexCollaborationMode {
    const mode = parseCodexCollaborationMode(value)
    if (mode === undefined) throw invalidValue(CODEX_COLLABORATION_CONFIG_ID, value)
    return mode
  }

  setModel(value: string | boolean): void {
    if (typeof value !== 'string') throw invalidValue(CODEX_MODEL_CONFIG_ID, value)
    const model = this.models.find((candidate) => candidate.id === value)
    if (model === undefined) {
      // codex-acp tolerates re-selecting the current model even when the catalogue dropped it.
      if (value === this.modelId) return
      throw invalidValue(CODEX_MODEL_CONFIG_ID, value)
    }
    this.effort = findSupportedEffort(model.supportedReasoningEfforts, this.effort) ?? model.defaultReasoningEffort
    this.modelId = model.id
  }

  setEffort(value: string | boolean): void {
    const effort = typeof value === 'string' ? findSupportedEffort(this.supportedEfforts, value) : undefined
    if (effort === undefined) throw invalidValue(CODEX_EFFORT_CONFIG_ID, value)
    this.effort = effort
  }

  setFastMode(value: string | boolean): void {
    if (typeof value === 'boolean') {
      this.fastModeEnabled = value
      return
    }
    if (value !== FAST_MODE_ON && value !== FAST_MODE_OFF) throw invalidValue(CODEX_FAST_MODE_CONFIG_ID, value)
    this.fastModeEnabled = value === FAST_MODE_ON
  }
}
