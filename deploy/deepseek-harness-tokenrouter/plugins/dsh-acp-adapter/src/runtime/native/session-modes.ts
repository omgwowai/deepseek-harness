/**
 * Session-mode contract of the native agents.
 *
 * Saved mode intents (`mode_intents`), persisted option snapshots and the DSH mode picker key
 * on the exact ACP mode ids and names the vendor's own ACP agent advertises, so a session
 * bound under ACP keeps restoring under the native route. This module is the single table of
 * those modes (ordered as the ACP agents list them) plus how each one is applied natively;
 * `NativeSessionRuntime` enforces it on whatever controls a transport reports, and the
 * transports apply the modes through it.
 *
 * Sources (the parity oracles):
 * - claude: claude-agent-acp `session-mode.js` (`SessionModeManager.buildAvailableModes`, `configOption`);
 * - codex:  codex-acp `AgentMode` (`all()`, `toConfigOption`);
 * - omp:    `omp acp` `acp-agent.ts` (`#getAvailableModes`, `#getCurrentModeId`, `#buildConfigOptions`).
 */
import type * as acp from '@agentclientprotocol/sdk'
import type { NativeControls, NativeTransportKind } from './transports/contract.ts'

export interface NativeModeDefinition {
  readonly id: string
  readonly name: string
  readonly description: string
}

export interface NativeModeContract {
  /** Name and description of the `mode` config option. */
  readonly option: { readonly name: string; readonly description?: string }
  /** The mode a session reports when its transport reports none. */
  readonly defaultModeId: string
  /** Every mode the vendor's ACP agent can list, in its order. */
  readonly modes: readonly NativeModeDefinition[]
  /** Ids of `modes` the native route cannot apply: never offered, whatever a transport reports. */
  readonly unavailable: readonly string[]
}

/**
 * Native application of each mode:
 * - claude: the mode id is the Claude Code permission mode (`--permission-mode <id>` at launch,
 *   stream-json `set_permission_mode` afterwards);
 * - codex:  {@link codexModeSettings} (`thread/start` + `turn/start`);
 * - omp:    `default` only. OMP's rpc-ui mode has no plan-mode switch, so `plan` is never offered
 *   natively even though `omp acp` lists it when plan mode is enabled in the OMP settings.
 */
export const NATIVE_MODE_CONTRACTS: Readonly<Record<NativeTransportKind, NativeModeContract>> = {
  claude: {
    option: { name: 'Mode', description: 'Session permission mode' },
    defaultModeId: 'default',
    modes: [
      { id: 'default', name: 'Manual', description: 'Always ask before making changes' },
      { id: 'acceptEdits', name: 'Accept edits', description: 'Automatically accept all file edits' },
      { id: 'plan', name: 'Plan', description: 'Create a plan before making changes' },
      { id: 'auto', name: 'Auto', description: 'Claude handles permission decisions' },
      { id: 'bypassPermissions', name: 'Bypass permissions', description: 'Accepts all permissions' },
    ],
    unavailable: [],
  },
  codex: {
    option: { name: 'Mode', description: 'Approval and sandboxing preset for the session' },
    defaultModeId: 'agent',
    modes: [
      {
        id: 'read-only',
        name: 'Read-only',
        description: 'Requires approval to edit files and access the internet.',
      },
      {
        id: 'workspace-write',
        name: 'Workspace access',
        description: 'Edit workspace files; ask before writing outside the workspace or accessing the network.',
      },
      { id: 'agent', name: 'Auto review', description: 'Only ask for actions detected as potentially unsafe' },
      {
        id: 'agent-full-access',
        name: 'Full access',
        description: 'Unrestricted access to the internet and any file on your computer',
      },
    ],
    unavailable: [],
  },
  omp: {
    option: { name: 'Mode' },
    defaultModeId: 'default',
    modes: [
      { id: 'default', name: 'Default', description: 'Standard ACP headless mode' },
      {
        id: 'plan',
        name: 'Plan',
        description: 'Read-only planning mode that drafts a plan to a markdown file before any code changes',
      },
    ],
    unavailable: ['plan'],
  },
}

/** Codex app-server settings of one mode: `thread/start` `approvalPolicy`/`sandbox`, `turn/start` `approvalPolicy`/`sandboxPolicy`/`approvalsReviewer`. */
export interface CodexModeSettings {
  readonly approvalPolicy: 'on-request' | 'never'
  readonly approvalsReviewer: 'user' | 'auto_review'
  readonly sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access'
  readonly sandboxPolicy: Readonly<Record<string, unknown>>
}

const WORKSPACE_WRITE_POLICY = {
  type: 'workspaceWrite',
  writableRoots: [],
  networkAccess: false,
  excludeTmpdirEnvVar: false,
  excludeSlashTmp: false,
} as const

const CODEX_MODE_SETTINGS: Readonly<Record<string, CodexModeSettings>> = {
  'read-only': {
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandboxMode: 'read-only',
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
  },
  'workspace-write': {
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandboxMode: 'workspace-write',
    sandboxPolicy: WORKSPACE_WRITE_POLICY,
  },
  agent: {
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
    sandboxMode: 'workspace-write',
    sandboxPolicy: WORKSPACE_WRITE_POLICY,
  },
  'agent-full-access': {
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandboxMode: 'danger-full-access',
    sandboxPolicy: { type: 'dangerFullAccess' },
  },
}

/** A private copy of the Codex settings of one mode id, or `undefined` for an id Codex does not offer. */
export function codexModeSettings(modeId: string): CodexModeSettings | undefined {
  const settings = CODEX_MODE_SETTINGS[modeId]
  return settings === undefined ? undefined : structuredClone(settings)
}

/** The ACP mode selector: id or category `mode`, the first such option wins (same rule as the DSH mode picker). */
export function isModeOption(option: acp.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase().replaceAll('-', '_')
  const category = (option.category ?? '').trim().toLowerCase().replaceAll('-', '_')
  return id === 'mode' || category === 'mode'
}

/**
 * Enforce the mode contract on reported controls: every mode of the vendor's ACP agent that the
 * native route can apply is offered under its exact id and name, modes the route cannot apply
 * are dropped, vendor-only extras keep their reported definition, and a current mode that is
 * not offered falls back to the vendor default. Mode controls of a conforming transport pass
 * through unchanged.
 */
export function withNativeModeContract(kind: NativeTransportKind, controls: NativeControls): NativeControls {
  const contract = NATIVE_MODE_CONTRACTS[kind]
  const position = controls.configOptions.findIndex(isModeOption)
  const existing = controls.configOptions[position]
  const select = existing?.type === 'select' ? existing : undefined
  const reported: { id: string; name: string; description?: string | null | undefined }[] =
    select === undefined
      ? (controls.modes?.availableModes ?? [])
      : select.options
          .flatMap((entry) => ('options' in entry ? entry.options : [entry]))
          .map((entry) => ({ id: entry.value, name: entry.name, description: entry.description }))
  const available: acp.SessionMode[] = [
    ...contract.modes.filter((mode) => !contract.unavailable.includes(mode.id)),
    ...reported.filter((entry) => !contract.modes.some((mode) => mode.id === entry.id)),
  ].map((mode) => ({
    id: mode.id,
    name: mode.name,
    ...(mode.description == null ? {} : { description: mode.description }),
  }))
  const reportedCurrent = select === undefined ? controls.modes?.currentModeId : select.currentValue
  const currentModeId =
    reportedCurrent !== undefined && available.some((mode) => mode.id === reportedCurrent)
      ? reportedCurrent
      : contract.defaultModeId
  const description = existing?.description ?? contract.option.description
  const modeOption: acp.SessionConfigOption = {
    id: existing?.id ?? 'mode',
    name: existing?.name ?? contract.option.name,
    ...(description == null ? {} : { description }),
    category: existing?.category ?? 'mode',
    type: 'select',
    currentValue: currentModeId,
    options: available.map((mode) => ({
      value: mode.id,
      name: mode.name,
      ...(mode.description == null ? {} : { description: mode.description }),
    })),
  }
  return {
    configOptions:
      existing === undefined
        ? [modeOption, ...controls.configOptions]
        : controls.configOptions.map((option, index) => (index === position ? modeOption : option)),
    modes: { availableModes: available, currentModeId },
    imageInput: controls.imageInput,
  }
}
