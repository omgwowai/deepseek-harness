/**
 * Server -> client requests of the Codex app-server.
 *
 * The app-server blocks on every one of them, so each request class gets an
 * answer: approvals are put to the host as ACP `session/request_permission`
 * requests built exactly like `@agentclientprotocol/codex-acp` builds them (the
 * same tool-call fields and the same option ids / names / kinds), and the user's
 * choice is mapped back with the same decision table. Questions
 * (`item/tool/requestUserInput` and the MCP forms that have fields) are put to
 * the host's question surface as the ACP form elicitation codex-acp sends for the
 * same request, and the response is decoded the way codex-acp decodes it; a host
 * without that surface is treated like an ACP client without form elicitation.
 * The remaining classes (dynamic tool calls, auth refresh, attestation, the
 * clock) get a schema-valid answer that never leaves Codex waiting.
 *
 * The eleven request methods of the 0.162 `ServerRequest` schema:
 *   item/commandExecution/requestApproval, item/fileChange/requestApproval,
 *   item/permissions/requestApproval, item/tool/requestUserInput,
 *   mcpServer/elicitation/request, item/tool/call,
 *   account/chatgptAuthTokens/refresh, attestation/generate, currentTime/read,
 *   applyPatchApproval, execCommandApproval.
 */
import type * as acp from '@agentclientprotocol/sdk'

import {
  asRecord,
  isRecord,
  messageOf,
  readArray,
  readBoolean,
  readNumber,
  readString,
  readStringArray,
  truncate,
  type JsonRecord,
} from './codex-json.ts'
import {
  commandPermissionToolCall,
  elicitationPermissionToolCall,
  fileChangePermissionToolCall,
  renderPermissionToolCall,
  renderToolCall,
  sandboxPermissionToolCall,
  stripShellPrefix,
  type CodexPermissionContext,
} from './codex-projection.ts'
import type { NativeElicitationRequest, NativePermissionDecision, NativePermissionRequest } from './contract.ts'

export type CodexServerRequestAnswer =
  | { readonly result: unknown }
  | { readonly error: { readonly code: number; readonly message: string } }

/** Puts one form to the host's question surface; see `CodexApprovalHost.elicit`. */
export type CodexElicit = (
  request: NativeElicitationRequest,
  signal: AbortSignal,
) => Promise<acp.CreateElicitationResponse>

/** What answering a request needs from the transport. */
export interface CodexApprovalHost {
  readonly context: CodexPermissionContext
  /** Put one permission request to the host; resolves `cancelled` when `signal` aborts. */
  ask(request: NativePermissionRequest, signal: AbortSignal): Promise<NativePermissionDecision>
  /**
   * Put one form to the host's question surface (`onElicitation`). Absent when the host has none: Codex is then
   * answered like codex-acp answers a client without form elicitation. Resolves `cancel` when `signal` aborts or
   * the surface fails.
   */
  readonly elicit?: CodexElicit | undefined
  /** Publish a session update (the status of a tool call a decision resolved). */
  update(update: acp.SessionUpdate): void
  nextStandaloneMcpToolCallId(threadId: string, serverName: string): string
  log(message: string): void
}

// ---------------------------------------------------------------------------
// Option ids (codex-acp `ApprovalOptionId` / `McpApprovalOptionId`)
// ---------------------------------------------------------------------------

const OPTION = {
  allowOnce: 'allow_once',
  allowForSession: 'allow_for_session',
  decline: 'decline',
  cancel: 'cancel',
  execpolicyAmendment: 'accept_execpolicy_amendment',
  networkPolicyAmendment: 'apply_network_policy_amendment',
  permissionsTurn: 'allow_permissions_turn',
  permissionsTurnStrict: 'allow_permissions_turn_strict_auto_review',
  permissionsSession: 'allow_permissions_session',
  rejectPermissions: 'reject_permissions',
} as const

const MCP_OPTION = {
  allowOnce: 'allow_once',
  allowSession: 'allow_session',
  allowAlways: 'allow_always',
  decline: 'decline',
  cancel: 'cancel',
} as const

function option(optionId: string, name: string, kind: acp.PermissionOptionKind): acp.PermissionOption {
  return { optionId, name, kind }
}

// ---------------------------------------------------------------------------
// Command approvals
// ---------------------------------------------------------------------------

interface NetworkAmendment {
  readonly host: string
  readonly action: 'allow' | 'deny'
}

type CommandDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel'
  | { readonly acceptWithExecpolicyAmendment: { readonly execpolicy_amendment: readonly string[] } }
  | { readonly applyNetworkPolicyAmendment: { readonly network_policy_amendment: NetworkAmendment } }

interface DecisionOption<D> {
  readonly option: acp.PermissionOption
  readonly decision: D
}

function parseNetworkAmendment(value: unknown): NetworkAmendment | undefined {
  const record = asRecord(value)
  const host = readString(record, 'host')
  const action = record?.['action']
  if (host === undefined || (action !== 'allow' && action !== 'deny')) return undefined
  return { host, action }
}

function stringArrayOrUndefined(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? (value as string[]) : undefined
}

function sameStrings(left: readonly string[], right: readonly string[] | undefined): boolean {
  return right !== undefined && left.length === right.length && left.every((value, index) => value === right[index])
}

function proposedNetworkAmendments(params: JsonRecord): NetworkAmendment[] {
  return (readArray(params, 'proposedNetworkPolicyAmendments') ?? []).flatMap((entry) => {
    const amendment = parseNetworkAmendment(entry)
    return amendment === undefined ? [] : [amendment]
  })
}

function defaultCommandDecisions(params: JsonRecord): CommandDecision[] {
  if (asRecord(params['networkApprovalContext']) !== undefined) {
    return [
      'accept',
      'acceptForSession',
      ...proposedNetworkAmendments(params).map(
        (amendment): CommandDecision => ({ applyNetworkPolicyAmendment: { network_policy_amendment: amendment } }),
      ),
      'decline',
      'cancel',
    ]
  }
  if (asRecord(params['additionalPermissions']) !== undefined) return ['accept', 'cancel']
  const decisions: CommandDecision[] = ['accept', 'acceptForSession']
  const proposed = stringArrayOrUndefined(params['proposedExecpolicyAmendment'])
  if (proposed !== undefined && proposed.length > 0) {
    decisions.push({ acceptWithExecpolicyAmendment: { execpolicy_amendment: proposed } })
  }
  decisions.push('decline', 'cancel')
  return decisions
}

function parseCommandDecision(candidate: unknown, params: JsonRecord): CommandDecision | undefined {
  if (candidate === 'accept' || candidate === 'acceptForSession' || candidate === 'decline' || candidate === 'cancel') {
    return candidate
  }
  const record = asRecord(candidate)
  if (record === undefined) return undefined
  if ('acceptWithExecpolicyAmendment' in record) {
    const amendment = stringArrayOrUndefined(asRecord(record['acceptWithExecpolicyAmendment'])?.['execpolicy_amendment'])
    if (amendment === undefined || amendment.length === 0) return undefined
    if (!sameStrings(amendment, stringArrayOrUndefined(params['proposedExecpolicyAmendment']))) return undefined
    return { acceptWithExecpolicyAmendment: { execpolicy_amendment: [...amendment] } }
  }
  if ('applyNetworkPolicyAmendment' in record) {
    const amendment = parseNetworkAmendment(asRecord(record['applyNetworkPolicyAmendment'])?.['network_policy_amendment'])
    const network = asRecord(params['networkApprovalContext'])
    if (amendment === undefined || network === undefined) return undefined
    if (amendment.host !== readString(network, 'host')) return undefined
    const proposed = proposedNetworkAmendments(params)
    if (!proposed.some((entry) => entry.host === amendment.host && entry.action === amendment.action)) return undefined
    return { applyNetworkPolicyAmendment: { network_policy_amendment: amendment } }
  }
  return undefined
}

function availableCommandDecisions(params: JsonRecord): CommandDecision[] | undefined {
  const available = params['availableDecisions']
  if (available === undefined || available === null) return defaultCommandDecisions(params)
  if (!Array.isArray(available) || available.length === 0) return undefined
  const decisions: CommandDecision[] = []
  for (const candidate of available) {
    const decision = parseCommandDecision(candidate, params)
    if (decision === undefined) return undefined
    decisions.push(decision)
  }
  return decisions
}

function isShlexUnquoted(character: string): boolean {
  return /^[0-9A-Za-z]$/.test(character) || '+-./:@]_'.includes(character)
}

/** Python `shlex.quote`-compatible quoting, as codex renders an exec-policy prefix. */
function shlexQuote(value: string): string {
  if (value.length === 0) return "''"
  const UNQUOTED = 1
  const SINGLE_QUOTED = 2
  const DOUBLE_QUOTED = 4
  let offset = 0
  let result = ''
  while (offset < value.length) {
    const start = offset
    let allowed = UNQUOTED | SINGLE_QUOTED | DOUBLE_QUOTED
    if (value[offset] === '^') {
      allowed = SINGLE_QUOTED
      offset += 1
    }
    while (offset < value.length) {
      const character = value[offset] ?? ''
      let nextAllowed = allowed
      if (!isShlexUnquoted(character)) nextAllowed &= ~UNQUOTED
      if (character === "'" || character === '^' || character === '\\') nextAllowed &= ~SINGLE_QUOTED
      if (character === '`' || character === '$' || character === '!' || character === '^') nextAllowed &= ~DOUBLE_QUOTED
      if (nextAllowed === 0) break
      allowed = nextAllowed
      offset += 1
    }
    const chunk = value.slice(start, offset)
    if ((allowed & UNQUOTED) !== 0) result += chunk
    else if ((allowed & SINGLE_QUOTED) !== 0) result += `'${chunk}'`
    else result += `"${chunk.replace(/["\\]/g, '\\$&')}"`
  }
  return result
}

function executableName(command: string | undefined): string | undefined {
  let filename = command?.replaceAll('\\', '/').split('/').at(-1)
  while (filename !== undefined) {
    if (['bash', 'zsh', 'sh', 'pwsh', 'powershell'].includes(filename)) return filename
    const dot = filename.lastIndexOf('.')
    if (dot <= 0) return undefined
    filename = filename.slice(0, dot)
  }
  return undefined
}

function extractWrappedScript(command: readonly string[]): string | undefined {
  const executable = executableName(command[0])
  if ((executable === 'bash' || executable === 'zsh' || executable === 'sh') && command.length === 3) {
    if (command[1] === '-lc' || command[1] === '-c') return command[2]
  }
  if (executable !== 'pwsh' && executable !== 'powershell') return undefined
  const allowedFlags = ['-nologo', '-noprofile', '-command', '-c']
  for (let index = 1; index + 1 < command.length; index += 1) {
    const flag = command[index]?.toLowerCase()
    if (flag === undefined || !allowedFlags.includes(flag)) return undefined
    if (flag === '-command' || flag === '-c') return command[index + 1]
  }
  return undefined
}

function renderExecPolicyPrefix(command: readonly string[]): string {
  const script = extractWrappedScript(command)
  if (script !== undefined) return script
  if (command.some((value) => value.includes('\0'))) return command.join(' ')
  return command.map(shlexQuote).join(' ')
}

function optionOrder(entry: acp.PermissionOption): number {
  if (entry.kind === 'allow_once') return 0
  if (entry.kind === 'allow_always') return 1
  return 2
}

/** codex-acp `commandDecisionOptions`: `undefined` when the decision set cannot be offered safely. */
function commandDecisionOptions(params: JsonRecord): Array<DecisionOption<CommandDecision>> | undefined {
  const decisions = availableCommandDecisions(params)
  if (decisions === undefined) return undefined
  const network = asRecord(params['networkApprovalContext']) !== undefined
  const additional = asRecord(params['additionalPermissions']) !== undefined
  const options: Array<DecisionOption<CommandDecision>> = []
  let networkIndex = 0
  for (const decision of decisions) {
    if (decision === 'accept') {
      options.push({ option: option(OPTION.allowOnce, network ? 'Yes, just this once' : 'Yes, proceed', 'allow_once'), decision })
    } else if (decision === 'acceptForSession') {
      const name = network
        ? 'Yes, and allow this host for this conversation'
        : additional
          ? 'Yes, and allow these permissions for this session'
          : "Yes, and don't ask again for this command in this session"
      options.push({ option: option(OPTION.allowForSession, name, 'allow_always'), decision })
    } else if (decision === 'decline') {
      options.push({ option: option(OPTION.decline, 'No, continue without running it', 'reject_once'), decision })
    } else if (decision === 'cancel') {
      options.push({ option: option(OPTION.cancel, 'No, and tell Codex what to do differently', 'reject_once'), decision })
    } else if ('acceptWithExecpolicyAmendment' in decision) {
      const prefix = renderExecPolicyPrefix(decision.acceptWithExecpolicyAmendment.execpolicy_amendment)
      if (prefix.includes('\n') || prefix.includes('\r')) continue
      options.push({
        option: option(
          OPTION.execpolicyAmendment,
          `Yes, and don't ask again for commands that start with \`${prefix}\``,
          'allow_always',
        ),
        decision,
      })
    } else {
      const amendment = decision.applyNetworkPolicyAmendment.network_policy_amendment
      const allow = amendment.action === 'allow'
      options.push({
        option: option(
          `${OPTION.networkPolicyAmendment}:${String(networkIndex)}`,
          allow ? 'Yes, and allow this host in the future' : 'No, and block this host in the future',
          allow ? 'allow_always' : 'reject_always',
        ),
        decision,
      })
      networkIndex += 1
    }
  }
  const ordered = [...options].sort((left, right) => optionOrder(left.option) - optionOrder(right.option))
  const hasAllow = ordered.some((entry) => entry.option.kind === 'allow_once' || entry.option.kind === 'allow_always')
  const hasReject = ordered.some((entry) => entry.option.kind === 'reject_once' || entry.option.kind === 'reject_always')
  const ids = ordered.map((entry) => entry.option.optionId)
  return hasAllow && hasReject && new Set(ids).size === ids.length ? ordered : undefined
}

type FileChangeDecision = 'accept' | 'acceptForSession' | 'cancel'

function fileChangeDecisionOptions(): Array<DecisionOption<FileChangeDecision>> {
  return [
    { option: option(OPTION.allowOnce, 'Yes, proceed', 'allow_once'), decision: 'accept' },
    {
      option: option(OPTION.allowForSession, "Yes, and don't ask again for these files", 'allow_always'),
      decision: 'acceptForSession',
    },
    { option: option(OPTION.cancel, 'No, and tell Codex what to do differently', 'reject_once'), decision: 'cancel' },
  ]
}

function selectedDecision<D>(decision: NativePermissionDecision, options: ReadonlyArray<DecisionOption<D>>): D | undefined {
  if ('cancelled' in decision) return undefined
  return options.find((entry) => entry.option.optionId === decision.optionId)?.decision
}

// ---------------------------------------------------------------------------
// Additional permissions
// ---------------------------------------------------------------------------

function permissionProfileOptions(): acp.PermissionOption[] {
  return [
    option(OPTION.permissionsTurn, 'Yes, grant these permissions for this turn', 'allow_once'),
    option(OPTION.permissionsTurnStrict, 'Yes, grant for this turn with strict auto review', 'allow_once'),
    option(OPTION.permissionsSession, 'Yes, grant these permissions for this session', 'allow_always'),
    option(OPTION.rejectPermissions, 'No, continue without permissions', 'reject_once'),
  ]
}

function permissionsResponse(params: JsonRecord, decision: NativePermissionDecision): JsonRecord {
  const reject = { permissions: {}, scope: 'turn', strictAutoReview: false }
  if ('cancelled' in decision) return reject
  const permissions = asRecord(params['permissions']) ?? {}
  const granted = (scope: 'turn' | 'session', strictAutoReview: boolean): JsonRecord => ({
    permissions: {
      ...(permissions['network'] ? { network: permissions['network'] } : {}),
      ...(permissions['fileSystem'] ? { fileSystem: permissions['fileSystem'] } : {}),
    },
    scope,
    strictAutoReview,
  })
  switch (decision.optionId) {
    case OPTION.permissionsTurn:
      return granted('turn', false)
    case OPTION.permissionsTurnStrict:
      return granted('turn', true)
    case OPTION.permissionsSession:
      return granted('session', false)
    default:
      return reject
  }
}

// ---------------------------------------------------------------------------
// Form elicitations (codex-acp `CodexElicitationHandler`)
// ---------------------------------------------------------------------------

/** The record without its `undefined` members, as JSON carries it: an absent flag stays absent. */
function defined(record: JsonRecord): JsonRecord {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))
}

/**
 * codex-acp `normalizeElicitationSchema`: the schema as ACP carries it. A legacy titled enum (`enum` with
 * `enumNames`) becomes a titled `oneOf`; everything else passes through.
 */
function normalizeElicitationSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeElicitationSchemaValue)
  if (!isRecord(value)) return value
  const result: JsonRecord = Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, normalizeElicitationSchemaValue(nested)]),
  )
  const values = result['enum']
  const names = result['enumNames']
  if (result['type'] === 'string' && Array.isArray(values) && Array.isArray(names) && !Array.isArray(result['oneOf'])) {
    result['oneOf'] = values.map((entry: unknown, index: number) => ({
      const: String(entry),
      title: String(names[index] ?? entry),
    }))
    delete result['enum']
    delete result['enumNames']
  }
  return result
}

function normalizeElicitationSchema(value: unknown): acp.ElicitationSchema {
  const normalized = normalizeElicitationSchemaValue(value)
  if (!isRecord(normalized)) return { type: 'object', properties: {} }
  return { ...normalized, type: 'object' } as acp.ElicitationSchema
}

/**
 * The content of an accepted response (`{}` when it carries none); `undefined` when the response is anything but a
 * well-formed `accept`, as acp `CreateElicitationResponse.isAccept` judges it.
 */
function acceptedContent(response: acp.CreateElicitationResponse): JsonRecord | undefined {
  if (response.action !== 'accept') return undefined
  const content: unknown = 'content' in response ? response.content : undefined
  if (content === undefined || content === null) return {}
  if (!isRecord(content)) return undefined
  // acp `ElicitationContentValue`: a string, a finite number, a boolean or a list of strings.
  const wellFormed = Object.values(content).every(
    (value) =>
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      (Array.isArray(value) && value.every((item) => typeof item === 'string')),
  )
  return wellFormed ? content : undefined
}

// ---------------------------------------------------------------------------
// MCP elicitations (codex-acp `permissions/mcp.ts`)
// ---------------------------------------------------------------------------

type McpPersist = 'session' | 'always'

function parsePersistOptions(meta: unknown): Set<McpPersist> {
  const result = new Set<McpPersist>()
  const persist = asRecord(meta)?.['persist']
  if (persist === 'session') result.add('session')
  else if (persist === 'always') result.add('always')
  else if (Array.isArray(persist)) {
    if (persist.includes('session')) result.add('session')
    if (persist.includes('always')) result.add('always')
  }
  return result
}

function isMessageOnlyForm(params: JsonRecord): boolean {
  const mode = readString(params, 'mode')
  if (mode !== 'form' && mode !== 'openai/form' && mode !== 'openaiForm') return false
  const schema = params['requestedSchema']
  if (schema === null || schema === undefined) return true
  const record = asRecord(schema)
  const properties = asRecord(record?.['properties'])
  return record?.['type'] === 'object' && properties !== undefined && Object.keys(properties).length === 0
}

function mcpPermissionOptions(isToolApproval: boolean, persist: ReadonlySet<McpPersist>): acp.PermissionOption[] {
  const options = [option(isToolApproval ? MCP_OPTION.allowOnce : 'accept', 'Allow', 'allow_once')]
  if (persist.has('session')) options.push(option(MCP_OPTION.allowSession, 'Allow for this session', 'allow_always'))
  if (persist.has('always')) options.push(option(MCP_OPTION.allowAlways, 'Always allow', 'allow_always'))
  if (isToolApproval) {
    options.push(option(MCP_OPTION.cancel, 'Cancel', 'reject_once'))
  } else {
    options.push(option(MCP_OPTION.decline, 'Deny', 'reject_once'), option(MCP_OPTION.cancel, 'Cancel', 'reject_once'))
  }
  return options
}

interface McpElicitationAnswer {
  readonly action: 'accept' | 'decline' | 'cancel'
  readonly content: JsonRecord | null
  readonly _meta: JsonRecord | null
}

const MCP_CANCELLED: McpElicitationAnswer = { action: 'cancel', content: null, _meta: null }
const MCP_DECLINED: McpElicitationAnswer = { action: 'decline', content: null, _meta: null }

/** The MCP server of the ChatGPT apps connector: the only server whose links must point at ChatGPT itself. */
const CODEX_APPS_SERVER = 'codex_apps'

function isChatgptHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return (
    host === 'chatgpt.com' ||
    host === 'chatgpt-staging.com' ||
    host.endsWith('.chatgpt.com') ||
    host.endsWith('.chatgpt-staging.com')
  )
}

/**
 * The TUI's `validate_external_url`: an `https` URL with a host and no credentials, and for the apps connector a ChatGPT
 * host. `undefined` when the link must not be shown.
 */
function validatedMcpUrl(value: string | undefined, serverName: string): URL | undefined {
  if (value === undefined) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' || url.hostname === '') return undefined
  if (url.username !== '' || url.password !== '') return undefined
  if (serverName === CODEX_APPS_SERVER && !isChatgptHost(url.hostname)) return undefined
  return url
}

function mcpAnswer(
  decision: NativePermissionDecision,
  isToolApproval: boolean,
  persist: ReadonlySet<McpPersist>,
): McpElicitationAnswer {
  if ('cancelled' in decision) return MCP_CANCELLED
  switch (decision.optionId) {
    case MCP_OPTION.allowSession:
      return persist.has('session') ? { action: 'accept', content: null, _meta: { persist: 'session' } } : MCP_CANCELLED
    case MCP_OPTION.allowAlways:
      return persist.has('always') ? { action: 'accept', content: null, _meta: { persist: 'always' } } : MCP_CANCELLED
    case MCP_OPTION.allowOnce:
      return isToolApproval ? { action: 'accept', content: null, _meta: null } : MCP_CANCELLED
    case 'accept':
      return !isToolApproval ? { action: 'accept', content: null, _meta: null } : MCP_CANCELLED
    case MCP_OPTION.decline:
      return !isToolApproval ? { action: 'decline', content: null, _meta: null } : MCP_CANCELLED
    default:
      return MCP_CANCELLED
  }
}

/** What codex-acp's `createMcpElicitationContext` derives from one request. */
interface McpContext {
  readonly isToolApproval: boolean
  readonly persist: ReadonlySet<McpPersist>
  readonly correlatedCallId: string | undefined
}

/** codex-acp `buildElicitationRequest`, form mode; the runtime adds the session id and the mode. */
function buildElicitationRequest(params: JsonRecord, context: McpContext): NativeElicitationRequest {
  const meta = asRecord(params['_meta'])
  return {
    message: readString(params, 'message') ?? '',
    requestedSchema: normalizeElicitationSchema(params['requestedSchema']),
    ...(context.correlatedCallId === undefined ? {} : { toolCallId: context.correlatedCallId }),
    ...(meta === undefined ? {} : { _meta: meta }),
  }
}

/** codex-acp `elicitationResponseMeta`. */
function elicitationResponseMeta(
  response: acp.CreateElicitationResponse,
  context: McpContext,
  persist?: unknown,
): JsonRecord | null {
  const meta: JsonRecord = { ...asRecord(response._meta) }
  if (context.isToolApproval) delete meta['persist']
  if (persist === 'session' || persist === 'always') meta['persist'] = persist
  return Object.keys(meta).length === 0 ? null : meta
}

/**
 * codex-acp `convertElicitationResponse`: the app-server's answer to a form the host filled in. Tool approvals are
 * message-only forms and stay on the permission prompt, so `isToolApproval` is false for every form that reaches
 * here; the persist rules are codex-acp's and apply should that routing ever change.
 */
function convertElicitationResponse(
  response: acp.CreateElicitationResponse,
  context: McpContext,
): McpElicitationAnswer {
  const content = acceptedContent(response)
  if (content !== undefined) {
    const persist = context.isToolApproval ? content['persist'] : undefined
    if (context.isToolApproval) {
      // codex-acp `isAllowedToolApprovalPersist`: no choice, a one-off, or a persistence the request offered.
      const offered = persist === 'session' || persist === 'always' ? context.persist.has(persist) : false
      if (persist !== undefined && persist !== 'once' && !offered) return MCP_CANCELLED
    }
    const answered: JsonRecord = { ...content }
    if (persist === 'session' || persist === 'always' || persist === 'once') delete answered['persist']
    return {
      action: 'accept',
      content: Object.keys(answered).length === 0 ? null : answered,
      _meta: elicitationResponseMeta(response, context, persist),
    }
  }
  switch (response.action) {
    case 'decline':
      return {
        action: context.isToolApproval ? 'cancel' : 'decline',
        content: null,
        _meta: elicitationResponseMeta(response, context),
      }
    case 'cancel':
      return { action: 'cancel', content: null, _meta: elicitationResponseMeta(response, context) }
    default:
      return MCP_CANCELLED
  }
}

/** codex-acp `handleElicitation`, form branch: a form that has fields goes to the host's question surface. */
async function answerMcpForm(
  params: JsonRecord,
  host: CodexApprovalHost,
  elicit: CodexElicit,
  signal: AbortSignal,
  context: McpContext,
): Promise<McpElicitationAnswer> {
  try {
    const answer = convertElicitationResponse(await elicit(buildElicitationRequest(params, context), signal), context)
    if (answer.action === 'accept' && context.correlatedCallId !== undefined) {
      host.update(renderToolCall({ toolCallId: context.correlatedCallId, report: 'update', status: 'in_progress' }))
    }
    return answer
  } catch (error: unknown) {
    host.log(`codex: MCP elicitation failed: ${messageOf(error)}`)
    return MCP_CANCELLED
  }
}

async function answerElicitation(
  params: JsonRecord,
  host: CodexApprovalHost,
  signal: AbortSignal,
): Promise<McpElicitationAnswer> {
  const mode = readString(params, 'mode')
  const threadId = readString(params, 'threadId') ?? ''
  const serverName = readString(params, 'serverName') ?? ''
  const isToolApproval = asRecord(params['_meta'])?.['codex_approval_kind'] === 'mcp_tool_call' && isMessageOnlyForm(params)
  const persist = parsePersistOptions(params['_meta'])
  const correlatedCallId = isToolApproval ? host.context.popPendingMcpApproval(serverName) : undefined
  const elicit = host.elicit
  if (mode === 'form' && elicit !== undefined && !isMessageOnlyForm(params)) {
    return await answerMcpForm(params, host, elicit, signal, { isToolApproval, persist, correlatedCallId })
  }
  // Only the message-only forms (tool approvals) and URL requests map onto a permission prompt. Any other form is
  // cancelled, as codex-acp cancels one for a client without form elicitation.
  if (!(mode === 'url' || isMessageOnlyForm(params))) return MCP_CANCELLED
  // A link the user is asked to open must be one the TUI would show too; anything else is declined unseen.
  let request = params
  if (mode === 'url') {
    const url = validatedMcpUrl(readString(params, 'url'), serverName)
    if (url === undefined) {
      host.log(
        `codex: declining a URL request of the MCP server ${serverName === '' ? '(unnamed)' : serverName}: only https links without credentials are shown`,
      )
      return MCP_DECLINED
    }
    request = { ...params, url: url.href }
  }
  const toolCall = elicitationPermissionToolCall(request, isToolApproval, mode === 'url' ? undefined : correlatedCallId, () =>
    host.nextStandaloneMcpToolCallId(threadId, serverName),
  )
  const decision = await host.ask({ toolCall, options: mcpPermissionOptions(isToolApproval, persist) }, signal)
  const answer = mcpAnswer(decision, isToolApproval, persist)
  if (correlatedCallId !== undefined && mode !== 'url') {
    if (answer.action === 'accept') host.update(renderToolCall({ toolCallId: correlatedCallId, report: 'update', status: 'in_progress' }))
  } else {
    host.update(
      renderToolCall({
        toolCallId: toolCall.toolCallId,
        report: 'update',
        status: 'completed',
        opaqueResult: { action: answer.action },
      }),
    )
  }
  return answer
}

// ---------------------------------------------------------------------------
// User input (`item/tool/requestUserInput`)
// ---------------------------------------------------------------------------

const USER_INPUT_NOTE_FIELD_SUFFIX = '_note'
const USER_INPUT_OTHER_OPTION = 'None of the above'
const USER_INPUT_NOTE_PREFIX = 'user_note: '
const USER_INPUT_MESSAGE = 'Codex needs your input to continue.'
/** `setTimeout` fires at once for a delay beyond a signed 32-bit integer. */
const MAX_TIMER_MS = 2 ** 31 - 1
/** TUI: a question the model does not block on (`isBlocking: false`) is withdrawn after this long without an answer. */
const NON_BLOCKING_INPUT_WAIT_MS = 120_000

interface UserInputOption {
  readonly label: string
  readonly description: string | undefined
}

interface UserInputQuestion {
  readonly id: string
  readonly header: string
  readonly question: string
  readonly options: readonly UserInputOption[]
  /** The flags as the app-server sent them: an absent flag stays absent in the form's `_meta`. */
  readonly isOther: boolean | undefined
  readonly isSecret: boolean | undefined
}

interface UserInputAnswers {
  readonly answers: Record<string, { readonly answers: string[] }>
}

function parseUserInputQuestions(params: JsonRecord): UserInputQuestion[] {
  return (readArray(params, 'questions') ?? []).flatMap((entry) => {
    const record = asRecord(entry)
    const id = readString(record, 'id')
    if (record === undefined || id === undefined) return []
    const options = (readArray(record, 'options') ?? []).flatMap((choice) => {
      const label = readString(asRecord(choice), 'label')
      return label === undefined ? [] : [{ label, description: readString(asRecord(choice), 'description') }]
    })
    return [
      {
        id,
        header: readString(record, 'header') ?? '',
        question: readString(record, 'question') ?? '',
        options,
        isOther: readBoolean(record, 'isOther'),
        isSecret: readBoolean(record, 'isSecret'),
      },
    ]
  })
}

/** codex-acp `userInputNoteFieldId`: `<id>_note`, moved aside while a question already has that id. */
function userInputNoteFieldId(questionId: string, questionIds: ReadonlySet<string>): string {
  const base = `${questionId}${USER_INPUT_NOTE_FIELD_SUFFIX}`
  let fieldId = base
  let index = 1
  while (questionIds.has(fieldId)) fieldId = `${base}${String(index++)}`
  return fieldId
}

/**
 * codex-acp `buildUserInputRequest` for a client without the AIR extension: one required field per question, a
 * `oneOf` for the options (plus the "None of the above" sentinel when the question takes another answer) and, for
 * such a question, a companion note field.
 */
function buildUserInputRequest(
  params: JsonRecord,
  questions: readonly UserInputQuestion[],
  autoResolutionMs: number | null | undefined,
): NativeElicitationRequest {
  const questionIds = new Set(questions.map((question) => question.id))
  const itemId = readString(params, 'itemId')
  const fields: Array<[string, acp.ElicitationPropertySchema]> = []
  for (const question of questions) {
    const hasOptions = question.options.length > 0
    const hasOtherAnswer = question.isOther === true && hasOptions
    const base = {
      title: question.question || question.header || question.id,
      ...(question.header === '' ? {} : { description: question.header }),
      _meta: { codex: defined({ isOther: question.isOther, isSecret: question.isSecret }) },
    }
    fields.push([
      question.id,
      hasOptions
        ? {
            ...base,
            type: 'string',
            oneOf: [
              ...question.options.map((choice) => ({
                const: choice.label,
                title: choice.label,
                ...(choice.description ? { description: choice.description } : {}),
              })),
              ...(hasOtherAnswer && !question.options.some((choice) => choice.label === USER_INPUT_OTHER_OPTION)
                ? [
                    {
                      const: USER_INPUT_OTHER_OPTION,
                      title: USER_INPUT_OTHER_OPTION,
                      description: 'Provide a different answer in the note field.',
                    },
                  ]
                : []),
            ],
          }
        : { ...base, type: 'string' },
    ])
    if (hasOtherAnswer) {
      fields.push([
        userInputNoteFieldId(question.id, questionIds),
        {
          type: 'string',
          title: 'Additional answer or note',
          _meta: { codex: defined({ questionId: question.id, role: 'user_note', isSecret: question.isSecret }) },
        },
      ])
    }
  }
  return {
    ...(itemId === undefined ? {} : { toolCallId: itemId }),
    message: USER_INPUT_MESSAGE,
    requestedSchema: {
      type: 'object',
      properties: Object.fromEntries(fields),
      required: questions.map((question) => question.id),
    },
    _meta: { codex: defined({ autoResolutionMs }) },
  }
}

/** codex-acp `userInputResponseValue`: a blank string or an empty list is no answer. */
function userInputResponseValue(content: JsonRecord, fieldId: string): unknown {
  const value = Object.hasOwn(content, fieldId) ? content[fieldId] : undefined
  if (typeof value === 'string' && value.trim() === '') return undefined
  if (Array.isArray(value) && value.length === 0) return undefined
  return value
}

/**
 * codex-acp `convertUserInputResponse` for a client without the AIR extension: the picked option or typed text of a
 * question, then the note of a question that takes another answer prefixed `user_note: `. Anything but an accepted
 * form answers nothing.
 */
function convertUserInputResponse(
  response: acp.CreateElicitationResponse,
  questions: readonly UserInputQuestion[],
): UserInputAnswers {
  const content = acceptedContent(response)
  if (content === undefined) return { answers: {} }
  const questionIds = new Set(questions.map((question) => question.id))
  const answers: Array<[string, { readonly answers: string[] }]> = []
  for (const question of questions) {
    const values: string[] = []
    const value = userInputResponseValue(content, question.id)
    if (value !== undefined) {
      const picked: unknown[] = Array.isArray(value) ? value : [value]
      values.push(...picked.map(String))
    }
    if (question.isOther === true && question.options.length > 0) {
      const note = userInputResponseValue(content, userInputNoteFieldId(question.id, questionIds))
      if (note !== undefined) {
        const notes: unknown[] = Array.isArray(note) ? note : [note]
        values.push(...notes.map((item) => `${USER_INPUT_NOTE_PREFIX}${String(item).trim()}`))
      }
    }
    if (values.length > 0) answers.push([question.id, { answers: values }])
  }
  return { answers: Object.fromEntries(answers) }
}

/**
 * codex-acp `requestUserInputElicitation`. `null` waits for the user. A number races the form against that many
 * milliseconds; when they pass, or the turn is cancelled first, the form is withdrawn and nothing is answered.
 */
async function requestUserInputElicitation(
  request: NativeElicitationRequest,
  autoResolutionMs: number | null,
  elicit: CodexElicit,
  signal: AbortSignal,
): Promise<acp.CreateElicitationResponse | null> {
  if (autoResolutionMs === null) return await elicit(request, signal)
  if (signal.aborted) return null
  const withdrawn = new AbortController()
  const { promise: unanswered, resolve } = Promise.withResolvers<null>()
  const resolveWithoutInput = (): void => {
    withdrawn.abort()
    resolve(null)
  }
  const timeout = setTimeout(resolveWithoutInput, Math.min(Math.max(0, autoResolutionMs), MAX_TIMER_MS))
  signal.addEventListener('abort', resolveWithoutInput, { once: true })
  try {
    const answered = elicit(request, withdrawn.signal)
    void answered.catch(() => undefined)
    return await Promise.race([answered, unanswered])
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', resolveWithoutInput)
  }
}

/**
 * codex-acp `handleUserInput`: all questions as one form on the host's question surface. A host without one, a
 * declined or cancelled form, a failure and an abort all answer nothing, which Codex takes as "no answer given".
 */
async function answerUserInput(
  params: JsonRecord,
  host: CodexApprovalHost,
  signal: AbortSignal,
): Promise<UserInputAnswers> {
  const elicit = host.elicit
  if (elicit === undefined) return { answers: {} }
  try {
    const questions = parseUserInputQuestions(params)
    if (questions.length === 0) return { answers: {} }
    // An absent `autoResolutionMs` is `null`, the schema default: wait for the user. `isBlocking: false` replaces
    // that wait with the TUI's, so a question nobody answers cannot hold the turn forever.
    const reported = params['autoResolutionMs'] === null ? null : readNumber(params, 'autoResolutionMs')
    const autoResolutionMs = reported ?? (params['isBlocking'] === false ? NON_BLOCKING_INPUT_WAIT_MS : reported)
    const response = await requestUserInputElicitation(
      buildUserInputRequest(params, questions, autoResolutionMs),
      autoResolutionMs ?? null,
      elicit,
      signal,
    )
    return response === null ? { answers: {} } : convertUserInputResponse(response, questions)
  } catch (error: unknown) {
    host.log(`codex: user input request failed: ${messageOf(error)}`)
    return { answers: {} }
  }
}

// ---------------------------------------------------------------------------
// Legacy v1 requests (`applyPatchApproval`, `execCommandApproval`)
// ---------------------------------------------------------------------------

function reviewDecision(decision: FileChangeDecision | CommandDecision | undefined): string {
  switch (decision) {
    case 'accept':
      return 'approved'
    case 'acceptForSession':
      return 'approved_for_session'
    case 'cancel':
      return 'abort'
    default:
      return 'denied'
  }
}

async function answerLegacyPatch(params: JsonRecord, host: CodexApprovalHost, signal: AbortSignal): Promise<unknown> {
  const options = fileChangeDecisionOptions()
  const fileChanges = asRecord(params['fileChanges'])
  const decision = await host.ask(
    {
      toolCall: renderPermissionToolCall({
        toolCallId: readString(params, 'callId') ?? '',
        report: 'update',
        kind: 'edit',
        status: 'pending',
        title: 'Edit files',
        locations: fileChanges === undefined ? [] : Object.keys(fileChanges),
      }),
      options: options.map((entry) => entry.option),
    },
    signal,
  )
  return { decision: reviewDecision(selectedDecision(decision, options) ?? 'cancel') }
}

async function answerLegacyExec(params: JsonRecord, host: CodexApprovalHost, signal: AbortSignal): Promise<unknown> {
  const options = commandDecisionOptions({}) ?? []
  const command = readStringArray(params, 'command').join(' ')
  const decision = await host.ask(
    {
      toolCall: renderPermissionToolCall({
        toolCallId: readString(params, 'callId') ?? '',
        report: 'update',
        kind: 'execute',
        status: 'pending',
        title: 'Run command',
        input: { command, cwd: readString(params, 'cwd') },
      }),
      options: options.map((entry) => entry.option),
    },
    signal,
  )
  return { decision: reviewDecision(selectedDecision(decision, options) ?? 'cancel') }
}

/** DSH registers no client-side tools; the call fails instead of leaving Codex blocked. */
const DYNAMIC_TOOL_UNAVAILABLE: CodexServerRequestAnswer = {
  result: {
    contentItems: [{ type: 'inputText', text: 'Dynamic tools are not available in this DSH session.' }],
    success: false,
  },
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Answer one app-server -> client request. Never rejects: a failure while
 * asking the host is answered with the request's cancel/deny form so Codex is
 * not left waiting.
 */
export async function answerCodexServerRequest(
  method: string,
  rawParams: unknown,
  host: CodexApprovalHost,
  signal: AbortSignal,
): Promise<CodexServerRequestAnswer> {
  const params = asRecord(rawParams) ?? {}
  switch (method) {
    case 'item/commandExecution/requestApproval': {
      const decisions = commandDecisionOptions(params)
      if (decisions === undefined) {
        host.log('codex: cancelling a command approval without a complete decision set')
        return { result: { decision: 'cancel' } }
      }
      const decision = await host.ask(
        { toolCall: commandPermissionToolCall(params, host.context), options: decisions.map((entry) => entry.option) },
        signal,
      )
      return { result: { decision: selectedDecision(decision, decisions) ?? 'cancel' } }
    }
    case 'item/fileChange/requestApproval': {
      const decisions = fileChangeDecisionOptions()
      const decision = await host.ask(
        { toolCall: fileChangePermissionToolCall(params, host.context), options: decisions.map((entry) => entry.option) },
        signal,
      )
      return { result: { decision: selectedDecision(decision, decisions) ?? 'cancel' } }
    }
    case 'item/permissions/requestApproval': {
      const decision = await host.ask(
        { toolCall: sandboxPermissionToolCall(params), options: permissionProfileOptions() },
        signal,
      )
      return { result: permissionsResponse(params, decision) }
    }
    case 'mcpServer/elicitation/request':
      return { result: await answerElicitation(params, host, signal) }
    case 'item/tool/requestUserInput':
      return { result: await answerUserInput(params, host, signal) }
    case 'applyPatchApproval':
      return { result: await answerLegacyPatch(params, host, signal) }
    case 'execCommandApproval':
      return { result: await answerLegacyExec(params, host, signal) }
    case 'item/tool/call':
      return DYNAMIC_TOOL_UNAVAILABLE
    case 'currentTime/read':
      return { result: { currentTimeAt: Math.floor(Date.now() / 1000) } }
    case 'account/chatgptAuthTokens/refresh':
      return { error: { code: -32601, message: 'DSH does not manage ChatGPT authentication tokens.' } }
    case 'attestation/generate':
      return { error: { code: -32601, message: 'DSH cannot generate client attestations.' } }
    default:
      return { error: { code: -32601, message: `Unsupported Codex app-server request: ${method}` } }
  }
}

/** The answer that closes a request whose asking failed or was abandoned. */
export function fallbackCodexServerAnswer(method: string): CodexServerRequestAnswer {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { result: { decision: 'cancel' } }
    case 'item/permissions/requestApproval':
      return { result: { permissions: {}, scope: 'turn', strictAutoReview: false } }
    case 'mcpServer/elicitation/request':
      return { result: MCP_CANCELLED }
    case 'item/tool/requestUserInput':
      return { result: { answers: {} } }
    case 'applyPatchApproval':
    case 'execCommandApproval':
      return { result: { decision: 'abort' } }
    default:
      return { error: { code: -32603, message: `DSH could not answer ${method}` } }
  }
}

// ---------------------------------------------------------------------------
// Requests of threads the user is not looking at
// ---------------------------------------------------------------------------

/**
 * The answer to a request of a thread nobody can answer for (a side question, a thread the transport does not know): the
 * action is refused but its turn goes on, which a `cancel` would end. Forms and questions are answered with nothing.
 */
export function declinedCodexServerAnswer(method: string): CodexServerRequestAnswer {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { result: { decision: 'decline' } }
    case 'item/permissions/requestApproval':
      return { result: { permissions: {}, scope: 'turn', strictAutoReview: false } }
    case 'mcpServer/elicitation/request':
      return { result: MCP_DECLINED }
    case 'item/tool/requestUserInput':
      return { result: { answers: {} } }
    case 'applyPatchApproval':
    case 'execCommandApproval':
      return { result: { decision: 'denied' } }
    case 'item/tool/call':
      return DYNAMIC_TOOL_UNAVAILABLE
    default:
      return { error: { code: -32601, message: `Unsupported Codex app-server request: ${method}` } }
  }
}

/** What a declined request asked for, in a few words (shown to the user); `undefined` for a request that asks nothing. */
export function describeCodexServerRequest(method: string, rawParams: unknown): string | undefined {
  const params = asRecord(rawParams) ?? {}
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'execCommandApproval': {
      const command =
        method === 'execCommandApproval'
          ? readStringArray(params, 'command').join(' ')
          : stripShellPrefix(readString(params, 'command') ?? '')
      return command === '' ? 'run a command' : `run \`${truncate(command.replaceAll('`', "'"), 160)}\``
    }
    case 'item/fileChange/requestApproval':
    case 'applyPatchApproval':
      return 'change files'
    case 'item/permissions/requestApproval':
      return 'get extra permissions'
    case 'mcpServer/elicitation/request':
      return 'ask a question through an MCP server'
    case 'item/tool/requestUserInput':
      return 'ask you a question'
    default:
      return undefined
  }
}
