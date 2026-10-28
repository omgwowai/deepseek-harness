/// <reference types="node" />
/**
 * Permission prompts of the Claude Code CLI (`control_request` `can_use_tool`) in the shape
 * `@agentclientprotocol/claude-agent-acp` presents them over ACP, and the user's answer decoded
 * back into the Claude `PermissionResult` that agent returns (permissions/*.js).
 *
 * Not reproduced: the "clear context and implement" ExitPlanMode choices. They restart the
 * conversation under a new session id, which a native session cannot do mid-run.
 */
import os from 'node:os'
import path from 'node:path'
import type * as acp from '@agentclientprotocol/sdk'

import { isRecord } from './claude-controls.ts'
import { claudeToolFacts, renderedRawInput, type ToolUse } from './claude-projection.ts'
import type { NativePermissionDecision, NativePermissionRequest } from './contract.ts'

type Json = Record<string, unknown>

const OPTION_ID = {
  allowOnce: 'allow-once',
  allowWithUpdates: 'allow-with-updates',
  allowSkillExact: 'allow-skill-exact',
  allowSkillPrefix: 'allow-skill-prefix',
  exitPlanBypass: 'exit-plan-bypass',
  exitPlanAuto: 'exit-plan-auto',
  exitPlanAcceptEdits: 'exit-plan-accept-edits',
  exitPlanDefault: 'exit-plan-default',
  reject: 'reject',
} as const

/** Permission updates the CLI suggested ("always allow"), validated and detached from the wire object. */
export interface DurableChangeSet {
  readonly updates: readonly Json[]
}

const MAX_UPDATES = 100
const MAX_RULES_PER_UPDATE = 100
const MAX_DIRECTORIES_PER_UPDATE = 100
const MAX_TOOL_NAME_LENGTH = 512
const MAX_RULE_CONTENT_LENGTH = 10_000
const MAX_DIRECTORY_LENGTH = 4_096
const DESTINATIONS: Readonly<Record<string, true>> = { session: true, cliArg: true, userSettings: true, projectSettings: true, localSettings: true }
const BEHAVIORS: Readonly<Record<string, true>> = { allow: true, deny: true, ask: true }
const MODES: Readonly<Record<string, true>> = { default: true, acceptEdits: true, bypassPermissions: true, plan: true, dontAsk: true, auto: true }

/** True when `value` is a printable string of 1..`maxLength` characters (no control characters). */
function safePlainString(value: unknown, maxLength: number): value is string {
  if (typeof value !== 'string') return false
  const normalized = value.trim()
  return (
    normalized.length > 0 &&
    value.length <= maxLength &&
    !Array.from(normalized).some((character) => {
      const code = character.charCodeAt(0)
      return code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f) || code === 0x7f
    })
  )
}

function isRule(value: unknown): boolean {
  return (
    isRecord(value) &&
    safePlainString(value['toolName'], MAX_TOOL_NAME_LENGTH) &&
    (value['ruleContent'] === undefined || safePlainString(value['ruleContent'], MAX_RULE_CONTENT_LENGTH))
  )
}

function isKnownUpdate(value: unknown): boolean {
  if (!isRecord(value) || typeof value['destination'] !== 'string' || !Object.hasOwn(DESTINATIONS, value['destination'])) return false
  switch (value['type']) {
    case 'addRules':
    case 'replaceRules':
    case 'removeRules':
      return (
        Array.isArray(value['rules']) &&
        value['rules'].length <= MAX_RULES_PER_UPDATE &&
        (value['type'] === 'replaceRules' || value['rules'].length > 0) &&
        value['rules'].every(isRule) &&
        typeof value['behavior'] === 'string' &&
        Object.hasOwn(BEHAVIORS, value['behavior'])
      )
    case 'setMode':
      return typeof value['mode'] === 'string' && Object.hasOwn(MODES, value['mode'])
    case 'addDirectories':
    case 'removeDirectories':
      return (
        Array.isArray(value['directories']) &&
        value['directories'].length > 0 &&
        value['directories'].length <= MAX_DIRECTORIES_PER_UPDATE &&
        value['directories'].every((directory) => safePlainString(directory, MAX_DIRECTORY_LENGTH))
      )
    default:
      return false
  }
}

/** The CLI's "always allow" suggestions as a bundle, or undefined when absent, invalid, or forced to ask. */
export function normalizeDurablePermissionChangeSet(suggestions: unknown, forcedAsk: boolean): DurableChangeSet | undefined {
  if (forcedAsk) return undefined
  try {
    if (!Array.isArray(suggestions) || suggestions.length === 0 || suggestions.length > MAX_UPDATES || !suggestions.every(isKnownUpdate)) return undefined
    return { updates: structuredClone(suggestions) as Json[] }
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Option builders
// ---------------------------------------------------------------------------

interface OptionContext {
  readonly toolName: string
  readonly displayName: string | undefined
  readonly input: Json
  readonly cwd: string
  readonly durableChangeSet: DurableChangeSet | undefined
  readonly allowPersistentOptions: boolean
  readonly availableModes: readonly string[]
  readonly prePlanMode: string | undefined
}

const allowOnce = (name = 'Yes'): acp.PermissionOption => ({ optionId: OPTION_ID.allowOnce, name, kind: 'allow_once' })
const allowWithUpdates = (name: string): acp.PermissionOption => ({ optionId: OPTION_ID.allowWithUpdates, name, kind: 'allow_always' })
const rejectOption = (name = 'No'): acp.PermissionOption => ({ optionId: OPTION_ID.reject, name, kind: 'reject_once' })

function plainString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function withOptionalUpdate(changeSet: DurableChangeSet | undefined, updateName: string | undefined, allowName = 'Yes', rejectName = 'No'): acp.PermissionOption[] {
  const options = [allowOnce(allowName)]
  if (changeSet && updateName) options.push(allowWithUpdates(updateName))
  options.push(rejectOption(rejectName))
  return options
}

function withGeneratedUpdate(name: string, rejectName = 'No'): acp.PermissionOption[] {
  return [allowOnce(), allowWithUpdates(name), rejectOption(rejectName)]
}

function exactLocalAllowRule(changeSet: DurableChangeSet | undefined, toolName: string, ruleContent?: string): boolean {
  if (!changeSet || changeSet.updates.length !== 1) return false
  const update = changeSet.updates[0]
  if (update?.['type'] !== 'addRules' || update['behavior'] !== 'allow' || update['destination'] !== 'localSettings') return false
  const rules = Array.isArray(update['rules']) ? update['rules'] : []
  if (rules.length !== 1) return false
  const rule = rules[0]
  if (!isRecord(rule) || rule['toolName'] !== toolName) return false
  return ruleContent === undefined ? rule['ruleContent'] === undefined : plainString(rule['ruleContent']) === ruleContent
}

/** An MCP "don't ask again" is truthful only when every update allows exactly the tool being asked about. */
function isMcpAllowChangeSet(changeSet: DurableChangeSet | undefined, toolName: string): boolean {
  return (
    !!changeSet &&
    changeSet.updates.length > 0 &&
    changeSet.updates.every(
      (update) =>
        update['type'] === 'addRules' &&
        update['behavior'] === 'allow' &&
        Array.isArray(update['rules']) &&
        update['rules'].length > 0 &&
        update['rules'].every((rule) => isRecord(rule) && rule['toolName'] === toolName && rule['ruleContent'] === undefined),
    )
  )
}

function permissionRulePrefix(value: string): string {
  return value.endsWith(':*') ? value.slice(0, -2) : value
}

function displayList(values: readonly string[]): string {
  if (values.join(', ').length > 50) return 'similar'
  if (values.length === 1) return values[0] ?? ''
  if (values.length === 2) return `${values[0]} and ${values[1]}`
  return `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`
}

/** Shorten paths only as far as needed to tell them apart in prompt text. */
function displayPaths(paths: readonly string[]): string {
  const normalizedPaths = [...new Set(paths.map((value) => path.normalize(value)))]
  const segments = normalizedPaths.map((value) => value.split(path.sep).filter(Boolean))
  const suffix = (index: number, depth: number): string => (segments[index] ?? []).slice(-depth).join(path.sep) || (normalizedPaths[index] ?? '')
  const names = normalizedPaths.map((value, index) => {
    const parts = segments[index] ?? []
    let name = path.basename(value) || value
    for (let depth = 1; depth <= parts.length; depth++) {
      const candidate = suffix(index, depth)
      if (normalizedPaths.every((_, other) => other === index || suffix(other, depth) !== candidate)) {
        name = candidate
        break
      }
      if (depth === parts.length) name = value
    }
    return name.endsWith(path.sep) ? name : `${name}${path.sep}`
  })
  if (names.length <= 2) return displayList(names)
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`
}

/** Plain-text port of Claude Code's shell "don't ask again" label. */
function shellSuggestionsLabel(toolName: string, changeSet: DurableChangeSet): string | undefined {
  const representable = changeSet.updates.every((update) => {
    if (update['type'] === 'addDirectories') return update['destination'] === 'session'
    if (update['type'] !== 'addRules' || update['behavior'] !== 'allow' || !Array.isArray(update['rules'])) return false
    return update['rules'].every(
      (rule) => isRecord(rule) && (rule['toolName'] === toolName || rule['toolName'] === 'Read') && plainString(rule['ruleContent']) !== undefined,
    )
  })
  if (!representable) return undefined
  const rules = changeSet.updates.filter((update) => update['type'] === 'addRules').flatMap((update) => (update['rules'] as Json[]) ?? [])
  const readPaths = rules.filter((rule) => rule['toolName'] === 'Read').map((rule) => String(rule['ruleContent']).replace(/\/\*\*$/, ''))
  const commands = [
    ...new Set(rules.filter((rule) => rule['toolName'] === toolName && rule['ruleContent']).map((rule) => permissionRulePrefix(String(rule['ruleContent'])))),
  ]
  const directories = changeSet.updates.filter((update) => update['type'] === 'addDirectories').flatMap((update) => (update['directories'] as string[]) ?? [])
  const hasPaths = readPaths.length > 0 || directories.length > 0
  if (readPaths.length > 0 && directories.length === 0 && commands.length === 0) return `Yes, allow reading from ${displayPaths(readPaths)} from this project`
  if (directories.length > 0 && readPaths.length === 0 && commands.length === 0) return `Yes, and always allow access to ${displayPaths(directories)} from this project`
  if (commands.length > 0 && !hasPaths) return `Yes, and don't ask again for ${displayList(commands)} commands`
  if (hasPaths && commands.length === 0) return `Yes, and always allow access to ${displayPaths([...directories, ...readPaths])} from this project`
  if (hasPaths && commands.length > 0) {
    const paths = [...directories, ...readPaths]
    return paths.length === 1 && commands.length === 1
      ? `Yes, and allow access to ${displayPaths(paths)} and ${displayList(commands)} commands`
      : `Yes, and allow ${displayPaths(paths)} access and ${displayList(commands)} commands`
  }
  return undefined
}

function isInside(directory: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..')
}

function isFileSessionChangeSet(changeSet: DurableChangeSet | undefined, operation: 'read' | 'write'): boolean {
  return (
    !!changeSet &&
    changeSet.updates.every((update) => {
      if (update['destination'] !== 'session') return false
      if (update['type'] === 'setMode') return operation === 'write' && update['mode'] === 'acceptEdits'
      if (update['type'] === 'addDirectories') return operation === 'write'
      if (update['type'] !== 'addRules' || update['behavior'] !== 'allow' || !Array.isArray(update['rules'])) return false
      return update['rules'].every((rule) => isRecord(rule) && rule['toolName'] === (operation === 'read' ? 'Read' : 'Edit'))
    })
  )
}

function hasSessionAllowRuleFor(changeSet: DurableChangeSet, toolName: string): boolean {
  return changeSet.updates.some(
    (update) =>
      update['type'] === 'addRules' &&
      update['destination'] === 'session' &&
      update['behavior'] === 'allow' &&
      Array.isArray(update['rules']) &&
      update['rules'].some((rule) => isRecord(rule) && rule['toolName'] === toolName),
  )
}

function hasBroadSessionAllowRuleFor(changeSet: DurableChangeSet, toolName: string): boolean {
  return changeSet.updates.some(
    (update) =>
      update['type'] === 'addRules' &&
      update['destination'] === 'session' &&
      update['behavior'] === 'allow' &&
      Array.isArray(update['rules']) &&
      update['rules'].some((rule) => isRecord(rule) && rule['toolName'] === toolName && rule['ruleContent'] === undefined),
  )
}

function hasAcceptEditsMode(changeSet: DurableChangeSet): boolean {
  return changeSet.updates.some((update) => update['type'] === 'setMode' && update['destination'] === 'session' && update['mode'] === 'acceptEdits')
}

function effectCoversFilePath(changeSet: DurableChangeSet, filePath: string, operation: 'read' | 'write', cwd: string): boolean {
  const directory = path.dirname(filePath)
  const comparable = (candidate: string): boolean => {
    const resolved = path.resolve(cwd, candidate)
    return resolved === directory || isInside(resolved, filePath)
  }
  const paths = changeSet.updates.flatMap((update): string[] => {
    if (update['type'] === 'addDirectories') return (update['directories'] as string[]) ?? []
    if (update['type'] !== 'addRules' || update['behavior'] !== 'allow' || !Array.isArray(update['rules'])) return []
    return update['rules']
      .filter((rule): rule is Json => isRecord(rule) && rule['toolName'] === (operation === 'read' ? 'Read' : 'Edit'))
      .map((rule) => plainString(rule['ruleContent'])?.replace(/[/\\]\*\*$/, ''))
      .filter((value): value is string => value !== undefined)
  })
  return paths.some(comparable)
}

function fileSessionLabel(context: OptionContext, filePath: string | undefined, operation: 'read' | 'write'): string | undefined {
  const changeSet = context.durableChangeSet
  if (!changeSet || !isFileSessionChangeSet(changeSet, operation)) return undefined
  const resolvedFilePath = filePath ? path.resolve(context.cwd, filePath) : undefined
  const isClaudePath =
    operation === 'write' &&
    !!resolvedFilePath &&
    (isInside(path.join(context.cwd, '.claude'), resolvedFilePath) || isInside(path.join(os.homedir(), '.claude'), resolvedFilePath))
  const broadRule = hasBroadSessionAllowRuleFor(changeSet, operation === 'read' ? 'Read' : 'Edit')
  if (resolvedFilePath) {
    const covers =
      effectCoversFilePath(changeSet, resolvedFilePath, operation, context.cwd) ||
      broadRule ||
      (operation === 'write' && !isClaudePath && hasAcceptEditsMode(changeSet))
    if (!covers) return undefined
  } else if (!broadRule && !(operation === 'write' && hasAcceptEditsMode(changeSet))) {
    return undefined
  }
  if (operation === 'write' && resolvedFilePath && isClaudePath && hasSessionAllowRuleFor(changeSet, 'Edit')) {
    return 'Yes, and allow Claude to edit its own settings for this session'
  }
  if (!resolvedFilePath || isInside(context.cwd, resolvedFilePath)) {
    return operation === 'read' ? 'Yes, during this session' : 'Yes, allow all edits during this session'
  }
  const directoryName = path.basename(path.dirname(resolvedFilePath)) || 'this directory'
  return operation === 'read'
    ? `Yes, allow reading from ${directoryName}${path.sep} during this session`
    : `Yes, allow all edits in ${directoryName}${path.sep} during this session`
}

function exitPlanModeOptions(context: OptionContext): acp.PermissionOption[] {
  const modes = new Set(context.availableModes)
  const elevated = (context.prePlanMode === 'bypassPermissions' ? ['bypassPermissions', 'auto'] : ['auto', 'bypassPermissions']).filter((mode) => modes.has(mode))
  const options: acp.PermissionOption[] = elevated.map((mode) =>
    mode === 'auto'
      ? { optionId: OPTION_ID.exitPlanAuto, name: 'Yes, and use auto mode', kind: 'allow_always' as const }
      : { optionId: OPTION_ID.exitPlanBypass, name: 'Yes, and bypass permissions', kind: 'allow_always' as const },
  )
  if (elevated.length === 0) options.push({ optionId: OPTION_ID.exitPlanAcceptEdits, name: 'Yes, auto-accept edits', kind: 'allow_always' })
  options.push({ optionId: OPTION_ID.exitPlanDefault, name: 'Yes, manually approve edits', kind: 'allow_once' })
  options.push(rejectOption('No, keep planning'))
  return options
}

function fallbackOptions(context: OptionContext): acp.PermissionOption[] {
  const toolLabel = plainString(context.displayName) ?? context.toolName
  if (context.toolName.startsWith('mcp__')) {
    const changeSet = context.allowPersistentOptions && isMcpAllowChangeSet(context.durableChangeSet, context.toolName) ? context.durableChangeSet : undefined
    return withOptionalUpdate(changeSet, changeSet ? `Yes, and don't ask again for ${toolLabel} commands` : undefined)
  }
  if (context.allowPersistentOptions) return withGeneratedUpdate(`Yes, and don't ask again for ${toolLabel} commands`)
  return [allowOnce(), rejectOption('No')]
}

function unsortedOptions(context: OptionContext): acp.PermissionOption[] {
  const { toolName, input } = context
  if (toolName.startsWith('mcp__computer-use__')) {
    const label = plainString(context.displayName) ?? toolName
    const changeSet = context.allowPersistentOptions && isMcpAllowChangeSet(context.durableChangeSet, toolName) ? context.durableChangeSet : undefined
    return withOptionalUpdate(changeSet, changeSet ? `Yes, and don't ask again for ${label}` : undefined)
  }
  const fileOptions = (filePath: string | undefined, operation: 'read' | 'write'): acp.PermissionOption[] =>
    withOptionalUpdate(context.durableChangeSet, fileSessionLabel(context, filePath, operation), 'Yes', 'No')
  switch (toolName) {
    case 'Bash':
    case 'PowerShell': {
      const name = context.durableChangeSet ? shellSuggestionsLabel(toolName, context.durableChangeSet) : undefined
      return withOptionalUpdate(context.durableChangeSet, name, 'Yes', 'No')
    }
    case 'Read':
      return fileOptions(plainString(input['file_path']), 'read')
    case 'Glob':
    case 'Grep':
      return fileOptions(plainString(input['path']) ?? context.cwd, 'read')
    case 'Edit':
    case 'Write':
      return fileOptions(plainString(input['file_path']), 'write')
    case 'NotebookEdit':
      return fileOptions(plainString(input['notebook_path']), 'write')
    case 'WebFetch': {
      const url = plainString(input['url'])
      if (url && context.allowPersistentOptions) {
        try {
          const hostname = new URL(url).hostname
          if (hostname) return withGeneratedUpdate(`Yes, and don't ask again for ${hostname}`)
        } catch {
          // An invalid URL has no domain-specific option.
        }
      }
      return [allowOnce(), rejectOption('No')]
    }
    case 'Skill': {
      const skill = plainString(input['skill'])
      const options = [allowOnce()]
      if (skill && context.allowPersistentOptions) {
        options.push({ optionId: OPTION_ID.allowSkillExact, name: `Yes, and don't ask again for ${skill}`, kind: 'allow_always' })
        const spaceIndex = skill.indexOf(' ')
        if (spaceIndex > 0) {
          options.push({
            optionId: OPTION_ID.allowSkillPrefix,
            name: `Yes, and don't ask again for ${skill.slice(0, spaceIndex)}:* commands`,
            kind: 'allow_always',
          })
        }
      }
      options.push(rejectOption('No'))
      return options
    }
    case 'EnterPlanMode':
      return [allowOnce('Yes, enter plan mode'), rejectOption('No, start implementing now')]
    case 'ExitPlanMode':
      return exitPlanModeOptions(context)
    case 'SandboxNetworkAccess': {
      const host = plainString(input['host'])
      const name = host && exactLocalAllowRule(context.durableChangeSet, toolName, host) ? `Yes, and don't ask again for ${host}` : undefined
      return withOptionalUpdate(context.durableChangeSet, name, 'Yes', 'No')
    }
    default:
      return fallbackOptions(context)
  }
}

function optionRank(option: acp.PermissionOption): number {
  switch (option.kind) {
    case 'allow_once':
      return 0
    case 'allow_always':
      return 1
    case 'reject_once':
    case 'reject_always':
      return 3
    default:
      return 2
  }
}

/** Options in the order the CLI's own dialog lists them; `defaultToNo` leads with the declines. */
export function buildClaudePermissionOptions(context: OptionContext & { readonly defaultToNo: boolean }): acp.PermissionOption[] {
  const rank = context.defaultToNo
    ? (option: acp.PermissionOption): number => (option.kind === 'reject_once' || option.kind === 'reject_always' ? 0 : 1 + optionRank(option))
    : optionRank
  return unsortedOptions(context).sort((left, right) => rank(left) - rank(right))
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/** Plain, single-line text of at most `maxLength` characters, or undefined. */
function humanText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const withoutControls = Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0)
      return !(code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f) || code === 0x7f)
    })
    .join('')
  const normalized = withoutControls.replace(/\s+/gu, ' ').trim()
  return normalized && normalized.length <= maxLength ? normalized : undefined
}

/** Everything needed to ask the user about one `can_use_tool` request and to answer the CLI afterwards. */
export interface PreparedClaudePermission {
  readonly request: NativePermissionRequest
  readonly toolUse: ToolUse
  /** The Claude `PermissionResult` for the user's choice, or `undefined` when the request was cancelled. */
  decide(decision: NativePermissionDecision): Json | undefined
}

export interface PermissionContext {
  readonly cwd: string
  readonly availableModes: readonly string[]
  readonly prePlanMode: string | undefined
  /** Auto mode cannot run on the selected model: a grant of it falls back to Accept edits. */
  readonly autoUnavailable: boolean
}

/** The Claude `PermissionResult` that lets the tool run (`input` is what it runs with), echoing the tool use it answers. */
export function allowResult(input: unknown, toolUseID: string, updatedPermissions?: readonly unknown[], permanent = false): Json {
  return {
    behavior: 'allow',
    updatedInput: input,
    ...(updatedPermissions ? { updatedPermissions } : {}),
    toolUseID,
    decisionClassification: permanent ? 'user_permanent' : 'user_temporary',
  }
}

/** The Claude `PermissionResult` that refuses the tool, echoing the tool use it answers. */
export function denyResult(toolUseID: string, message = 'User refused permission to run tool', interrupt = false): Json {
  return { behavior: 'deny', message, ...(interrupt ? { interrupt: true } : {}), toolUseID, decisionClassification: 'user_reject' }
}

function localAllowRuleUpdate(toolName: string, ruleContent?: string): Json[] {
  return [{ type: 'addRules', rules: [{ toolName, ...(ruleContent === undefined ? {} : { ruleContent }) }], behavior: 'allow', destination: 'localSettings' }]
}

function exitPlanTargetMode(optionId: string): string | undefined {
  switch (optionId) {
    case OPTION_ID.exitPlanBypass:
      return 'bypassPermissions'
    case OPTION_ID.exitPlanAuto:
      return 'auto'
    case OPTION_ID.exitPlanAcceptEdits:
      return 'acceptEdits'
    case OPTION_ID.exitPlanDefault:
      return 'default'
    default:
      return undefined
  }
}

/** Apply a chosen option with the semantics of the tool that offered it. */
function applySelection(optionId: string, toolName: string, input: Json, toolUseID: string, durable: DurableChangeSet | undefined): Json {
  const common = (): Json => {
    switch (optionId) {
      case OPTION_ID.allowOnce:
        return allowResult(input, toolUseID)
      case OPTION_ID.allowWithUpdates:
        if (!durable) throw new Error('Invalid durable permission selection')
        return allowResult(input, toolUseID, durable.updates, true)
      case OPTION_ID.reject:
        return denyResult(toolUseID)
      default:
        throw new Error(`Unknown permission option: ${optionId}`)
    }
  }
  const generated = (updates: () => Json[]): Json => (optionId === OPTION_ID.allowWithUpdates ? allowResult(input, toolUseID, updates(), true) : common())
  switch (toolName) {
    case 'Skill': {
      const skill = typeof input['skill'] === 'string' ? input['skill'].trim() : ''
      if (optionId === OPTION_ID.allowSkillExact || optionId === OPTION_ID.allowSkillPrefix) {
        if (!skill || skill.length > 1_000) throw new Error('Invalid Skill permission input')
        if (optionId === OPTION_ID.allowSkillExact) return allowResult(input, toolUseID, localAllowRuleUpdate('Skill', skill), true)
        const spaceIndex = skill.indexOf(' ')
        if (spaceIndex <= 0) throw new Error('Skill prefix permission requires arguments')
        return allowResult(input, toolUseID, localAllowRuleUpdate('Skill', `${skill.slice(0, spaceIndex)}:*`), true)
      }
      return common()
    }
    case 'WebFetch':
      return generated(() => {
        let hostname = ''
        try {
          hostname = new URL(String(input['url'])).hostname
        } catch {
          // Reported below.
        }
        if (!hostname) throw new Error('Invalid WebFetch permission input')
        return localAllowRuleUpdate('WebFetch', `domain:${hostname}`)
      })
    case 'ExitPlanMode': {
      const mode = exitPlanTargetMode(optionId)
      if (mode) return allowResult(input, toolUseID, [{ type: 'setMode', mode, destination: 'session' }], mode !== 'default')
      // A plain deny lets Claude keep planning and ask again; interrupt ends this turn instead.
      if (optionId === OPTION_ID.reject) return denyResult(toolUseID, 'User chose to keep planning', true)
      return common()
    }
    case 'EnterPlanMode':
    case 'Read':
    case 'Bash':
    case 'PowerShell':
    case 'Glob':
    case 'Grep':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
    case 'SandboxNetworkAccess':
      return common()
    default:
      return toolName.startsWith('mcp__') ? common() : generated(() => localAllowRuleUpdate(toolName))
  }
}

/** Auto mode granted on a model without it falls back to Accept edits, as claude-agent-acp does. */
function applyAutoFallback(result: Json, autoUnavailable: boolean): Json {
  if (!autoUnavailable || result['behavior'] !== 'allow' || !Array.isArray(result['updatedPermissions'])) return result
  const rewritten = result['updatedPermissions'].map((update) =>
    isRecord(update) && update['type'] === 'setMode' && update['mode'] === 'auto' ? { ...update, mode: 'acceptEdits' } : update,
  )
  return { ...result, updatedPermissions: rewritten }
}

/**
 * Prepare one `can_use_tool` control request: the ACP-shaped prompt the host shows and the decoder
 * for the choice it returns.
 */
export function prepareClaudePermission(request: Json, context: PermissionContext): PreparedClaudePermission {
  const toolName = typeof request['tool_name'] === 'string' ? request['tool_name'] : 'tool'
  const input = isRecord(request['input']) ? request['input'] : {}
  const toolUseID = typeof request['tool_use_id'] === 'string' ? request['tool_use_id'] : ''
  const displayName = typeof request['display_name'] === 'string' ? request['display_name'] : undefined
  const noPersistentRule = request['matched_ask_rule'] !== undefined || request['suppress_always_allow_rule'] === true
  const durableChangeSet = normalizeDurablePermissionChangeSet(request['permission_suggestions'], noPersistentRule)
  const toolUse: ToolUse = { id: toolUseID, name: toolName, input }
  const facts = claudeToolFacts(toolUse, context.cwd)
  const host = toolName === 'SandboxNetworkAccess' ? humanText(input['host'], 160) : undefined
  const subjectTitle = host ?? (toolName.startsWith('mcp__computer-use__') ? humanText(displayName, 160) : undefined)
  const blockedPath = humanText(request['blocked_path'], 4_096)
  const extraLocations = blockedPath && !(facts.locations ?? []).some((location) => location.path === blockedPath) ? [{ path: blockedPath }] : undefined
  const mcpServer = isRecord(request['mcp_server']) ? request['mcp_server'] : undefined
  const toolCall: acp.ToolCallUpdate = {
    toolCallId: toolUseID,
    title: subjectTitle ?? facts.title,
    rawInput: renderedRawInput(facts, input),
    ...(extraLocations ? { locations: [...(facts.locations ?? []), ...extraLocations] } : {}),
    ...(mcpServer ? { _meta: { claudeCode: { mcpServer: { name: mcpServer['name'], source: mcpServer['source'] } } } } : {}),
  }
  const options = buildClaudePermissionOptions({
    toolName,
    displayName,
    input,
    cwd: context.cwd,
    durableChangeSet,
    allowPersistentOptions: !noPersistentRule,
    availableModes: context.availableModes,
    prePlanMode: context.prePlanMode,
    defaultToNo: request['default_to_no'] === true,
  })
  return {
    request: { toolCall, options },
    toolUse,
    decide: (decision) => {
      if ('cancelled' in decision) return undefined
      if (!options.some((option) => option.optionId === decision.optionId)) throw new Error(`Permission option was not offered: ${decision.optionId}`)
      return applyAutoFallback(applySelection(decision.optionId, toolName, input, toolUseID, durableChangeSet), context.autoUnavailable)
    },
  }
}
