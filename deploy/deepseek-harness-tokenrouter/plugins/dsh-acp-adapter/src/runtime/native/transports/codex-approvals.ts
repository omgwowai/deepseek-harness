/**
 * Server -> client requests of the Codex app-server.
 *
 * The app-server blocks on every one of them, so each request class gets an
 * answer: approvals are put to the host as ACP `session/request_permission`
 * requests built exactly like `@agentclientprotocol/codex-acp` builds them (the
 * same tool-call fields and the same option ids / names / kinds), and the user's
 * choice is mapped back with the same decision table. The remaining classes
 * (dynamic tool calls, auth refresh, attestation, the clock) get a schema-valid
 * answer that never leaves Codex waiting.
 *
 * The eleven request methods of the 0.162 `ServerRequest` schema:
 *   item/commandExecution/requestApproval, item/fileChange/requestApproval,
 *   item/permissions/requestApproval, item/tool/requestUserInput,
 *   mcpServer/elicitation/request, item/tool/call,
 *   account/chatgptAuthTokens/refresh, attestation/generate, currentTime/read,
 *   applyPatchApproval, execCommandApproval.
 */
import type * as acp from '@agentclientprotocol/sdk'

import { asRecord, readArray, readString, readStringArray, truncate, type JsonRecord } from './codex-json.ts'
import {
  commandPermissionToolCall,
  elicitationPermissionToolCall,
  fileChangePermissionToolCall,
  renderPermissionToolCall,
  renderToolCall,
  sandboxPermissionToolCall,
  type CodexPermissionContext,
} from './codex-projection.ts'
import type { NativePermissionDecision, NativePermissionRequest } from './contract.ts'

export type CodexServerRequestAnswer =
  | { readonly result: unknown }
  | { readonly error: { readonly code: number; readonly message: string } }

/** What answering a request needs from the transport. */
export interface CodexApprovalHost {
  readonly context: CodexPermissionContext
  /** Put one permission request to the host; resolves `cancelled` when `signal` aborts. */
  ask(request: NativePermissionRequest, signal: AbortSignal): Promise<NativePermissionDecision>
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
  readonly content: null
  readonly _meta: JsonRecord | null
}

const MCP_CANCELLED: McpElicitationAnswer = { action: 'cancel', content: null, _meta: null }

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
  // Real forms need an elicitation channel the native host does not have; only the
  // message-only forms (tool approvals) and URL requests map onto a permission prompt.
  if (!(mode === 'url' || isMessageOnlyForm(params))) return MCP_CANCELLED
  const toolCall = elicitationPermissionToolCall(params, isToolApproval, mode === 'url' ? undefined : correlatedCallId, () =>
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

/**
 * codex-acp turns this into an ACP form elicitation; the native contract has no
 * elicitation channel, so each multiple-choice question is put to the host as a
 * permission prompt whose options are the question's choices. A skipped or
 * cancelled question stays unanswered, and a free-text question cannot be asked.
 */
async function answerUserInput(
  params: JsonRecord,
  host: CodexApprovalHost,
  signal: AbortSignal,
): Promise<{ readonly answers: Record<string, { readonly answers: string[] }> }> {
  const answers: Record<string, { answers: string[] }> = {}
  const itemId = readString(params, 'itemId') ?? ''
  for (const entry of readArray(params, 'questions') ?? []) {
    if (signal.aborted) break
    const question = asRecord(entry)
    const id = readString(question, 'id')
    const labels = (readArray(question, 'options') ?? []).flatMap((choice) => {
      const label = readString(asRecord(choice), 'label')
      return label === undefined || label.trim() === '' ? [] : [label]
    })
    if (id === undefined || labels.length === 0) continue
    const prompt = readString(question, 'question') ?? readString(question, 'header') ?? id
    const header = readString(question, 'header')
    const title = truncate(header !== undefined && header !== prompt ? `${header}: ${prompt}` : prompt, 200)
    const decision = await host.ask(
      {
        toolCall: renderPermissionToolCall({
          toolCallId: itemId,
          report: 'update',
          kind: 'other',
          status: 'pending',
          title,
          input: { question },
        }),
        options: [
          ...labels.map((label, index) => option(`answer:${String(index)}`, label, 'allow_once')),
          option('dismiss', 'No answer', 'reject_once'),
        ],
      },
      signal,
    )
    if ('cancelled' in decision || !decision.optionId.startsWith('answer:')) continue
    const label = labels[Number(decision.optionId.slice('answer:'.length))]
    if (label !== undefined) answers[id] = { answers: [label] }
  }
  return { answers }
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
      // DSH registers no client-side tools; fail the call instead of leaving Codex blocked.
      return {
        result: {
          contentItems: [{ type: 'inputText', text: 'Dynamic tools are not available in this DSH session.' }],
          success: false,
        },
      }
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
