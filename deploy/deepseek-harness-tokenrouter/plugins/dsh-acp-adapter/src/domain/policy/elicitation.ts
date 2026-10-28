/** ACP 补充信息请求桥接层。
 *
 * broker 会一直保持 ACP 请求待处理，直到用户明确作出选择。请求按会话隔离，
 * 表单值会依据协商得到的基础 schema 校验，提交值不会持久化。SDK 目前仍将
 * 这部分协议标记为不稳定，因此未知或格式错误的变体会被拒绝，不做猜测性兼容。
 *
 * Agent 为选项问题附带的自由文本“其他”字段（claude-agent-acp 的 `question_<n>_custom`、OMP 的
 * `q<n>__other`、codex-acp 的 `<id>_note`）会并入对应的选项问题，不单独成题。
 * 合并后的问题把简短标签与问题正文分开：较长的文本（字段描述；没有描述且表单只有这一个问题时取消息首行）
 * 与标题都有时，较短者作为卡片小标题（header），较长者作为问题；只有其一时它就是问题，详情不重复二者。
 * Claude 把标签放在标题、问题放在描述（单个问题放在消息里），OMP 与 Codex 则相反。
 * codex-acp 把每个用户输入问题都列为 required，但它接受只回答一部分：这类问题（属性 `_meta.codex.isOther`
 * 为布尔值）可以留空，全部留空时返回空内容；其余必填字段缺失仍会取消。
 */
import type * as acp from '@agentclientprotocol/sdk'

const SENSITIVE_FIELD =
  /(?:password|passwd|token|secret|credential|api[\s_-]*key|authorization|private[\s_-]*key|passphrase)/i

/**
 * Key suffixes of a free-text companion: claude-agent-acp `question_<n>_custom`, OMP `q<n>__other`,
 * codex-acp `<id>_note`.
 */
const COMPANION_SUFFIXES = ['_custom', '__other', '_note'] as const

/** codex-acp `USER_INPUT_OTHER_OPTION`: how its required question says "my answer is in the note". */
const CODEX_OTHER_OPTION = 'None of the above'

/** DSH's question card badges (and, as the first option, preselects) a label that ends like this. */
const RECOMMENDED_LABEL = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i

export interface AcpElicitationFieldView {
  readonly name: string
  readonly type: string
  readonly title?: string
  readonly description?: string
  readonly required: boolean
  readonly options?: readonly { readonly value: string; readonly title?: string; readonly description?: string }[]
  readonly defaultValue?: string | number | boolean | readonly string[]
  readonly minimum?: number
  readonly maximum?: number
  readonly minItems?: number
  readonly maxItems?: number
  readonly format?: 'email' | 'uri' | 'date' | 'date-time'
}

type FormSchema = {
  readonly type?: unknown
  readonly properties?: unknown
  readonly required?: unknown
}

function plain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** The plain object found by following `path` from `value`, if every step is one. */
function recordAt(value: unknown, ...path: readonly string[]): Record<string, unknown> | undefined {
  let current: unknown = value
  for (const key of path) {
    if (!plain(current)) return undefined
    current = current[key]
  }
  return plain(current) ? current : undefined
}

function formSchemaOf(params: acp.CreateElicitationRequest): FormSchema {
  return (params as unknown as { requestedSchema: FormSchema }).requestedSchema
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function finiteOrAbsent(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'number' && Number.isFinite(value))
}

function boundedPair(item: Record<string, unknown>, minKey: string, maxKey: string, integer: boolean): boolean {
  const minimum = item[minKey]
  const maximum = item[maxKey]
  const valid = integer
    ? (minimum === undefined || minimum === null || nonNegativeInteger(minimum)) &&
      (maximum === undefined || maximum === null || nonNegativeInteger(maximum))
    : finiteOrAbsent(minimum) && finiteOrAbsent(maximum)
  return valid && !(typeof minimum === 'number' && typeof maximum === 'number' && minimum > maximum)
}

function enumOptions(
  value: unknown,
  titled: boolean,
): readonly { readonly value: string; readonly title?: string; readonly description?: string }[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const out: { value: string; title?: string; description?: string }[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (!titled) {
      if (typeof raw !== 'string' || seen.has(raw)) return undefined
      seen.add(raw)
      out.push({ value: raw })
      continue
    }
    if (!plain(raw) || typeof raw.const !== 'string' || typeof raw.title !== 'string' || seen.has(raw.const))
      return undefined
    if (raw.description !== undefined && raw.description !== null && typeof raw.description !== 'string')
      return undefined
    seen.add(raw.const)
    out.push({
      value: raw.const,
      title: raw.title,
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    })
  }
  return out
}

function optionsOf(
  item: Record<string, unknown>,
): readonly { readonly value: string; readonly title?: string; readonly description?: string }[] | undefined {
  const enumPresent = item.enum !== undefined && item.enum !== null
  const oneOfPresent = item.oneOf !== undefined && item.oneOf !== null
  if (enumPresent && oneOfPresent) return undefined
  if (enumPresent) return enumOptions(item.enum, false)
  if (oneOfPresent) return enumOptions(item.oneOf, true)
  return []
}

function validStringFormat(value: string, format: unknown): boolean {
  if (format === undefined || format === null) return true
  if (format === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  if (format === 'uri') {
    try {
      return new URL(value).protocol.length > 1
    } catch {
      return false
    }
  }
  if (format === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
    const [year, month, day] = value.split('-').map(Number)
    const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1))
    return date.getUTCFullYear() === year && date.getUTCMonth() === (month ?? 1) - 1 && date.getUTCDate() === day
  }
  if (format === 'date-time') {
    return (
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
      Number.isFinite(Date.parse(value))
    )
  }
  return false
}

function validDefault(
  item: Record<string, unknown>,
  type: string,
  options: readonly { readonly value: string }[],
): boolean {
  const value = item.default
  if (value === undefined || value === null) return true
  if (type === 'string')
    return (
      typeof value === 'string' &&
      (options.length === 0 || options.some((option) => option.value === value)) &&
      (!(typeof item.minLength === 'number') || value.length >= item.minLength) &&
      (!(typeof item.maxLength === 'number') || value.length <= item.maxLength) &&
      (!(typeof item.pattern === 'string') || new RegExp(item.pattern).test(value)) &&
      validStringFormat(value, item.format)
    )
  if (type === 'number')
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      (!(typeof item.minimum === 'number') || value >= item.minimum) &&
      (!(typeof item.maximum === 'number') || value <= item.maximum)
    )
  if (type === 'integer')
    return (
      typeof value === 'number' &&
      Number.isInteger(value) &&
      (!(typeof item.minimum === 'number') || value >= item.minimum) &&
      (!(typeof item.maximum === 'number') || value <= item.maximum)
    )
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'array')
    return (
      Array.isArray(value) &&
      value.every((entry): entry is string => typeof entry === 'string') &&
      new Set(value).size === value.length &&
      value.every((entry) => options.some((option) => option.value === entry)) &&
      (!(typeof item.minItems === 'number') || value.length >= item.minItems) &&
      (!(typeof item.maxItems === 'number') || value.length <= item.maxItems)
    )
  return false
}

function fieldViewOf(name: string, item: unknown, required: boolean): AcpElicitationFieldView | undefined {
  if (!plain(item) || typeof item.type !== 'string') return undefined
  // ACP v1 form elicitation is intentionally non-sensitive. Credential-shaped
  // fields must use URL elicitation; never render a password control or accept
  // a value merely because a caller bypassed the UI.
  // Codex flags a question whose answer is a secret as `_meta.codex.isSecret`.
  if (
    SENSITIVE_FIELD.test(name) ||
    (typeof item.title === 'string' && SENSITIVE_FIELD.test(item.title)) ||
    (typeof item.description === 'string' && SENSITIVE_FIELD.test(item.description)) ||
    item.sensitive === true ||
    item.secret === true ||
    recordAt(item._meta, 'codex')?.isSecret === true
  )
    return undefined
  if (item.title !== undefined && item.title !== null && typeof item.title !== 'string') return undefined
  if (item.description !== undefined && item.description !== null && typeof item.description !== 'string')
    return undefined
  const type = item.type
  let options: readonly { readonly value: string; readonly title?: string; readonly description?: string }[] = []
  if (type === 'string') {
    if (!boundedPair(item, 'minLength', 'maxLength', true)) return undefined
    if (item.pattern !== undefined && item.pattern !== null) {
      if (typeof item.pattern !== 'string') return undefined
      try {
        new RegExp(item.pattern)
      } catch {
        return undefined
      }
    }
    if (
      item.format !== undefined &&
      item.format !== null &&
      !['email', 'uri', 'date', 'date-time'].includes(String(item.format))
    )
      return undefined
    const parsed = optionsOf(item)
    if (parsed === undefined) return undefined
    options = parsed
  } else if (type === 'number' || type === 'integer') {
    if (!boundedPair(item, 'minimum', 'maximum', false)) return undefined
  } else if (type === 'boolean') {
    // 布尔字段没有额外的结构约束。
  } else if (type === 'array') {
    if (!boundedPair(item, 'minItems', 'maxItems', true) || !plain(item.items)) return undefined
    const items = item.items
    if (items.type !== undefined && items.type !== 'string') return undefined
    // ACP titles multi-select items with `anyOf`; `oneOf` is read as the same list.
    if (items.anyOf !== undefined && items.anyOf !== null && items.oneOf !== undefined && items.oneOf !== null)
      return undefined
    const parsed = optionsOf({ enum: items.enum, oneOf: items.anyOf ?? items.oneOf })
    if (parsed === undefined || parsed.length === 0) return undefined
    options = parsed
  } else return undefined
  if (!validDefault(item, type, options)) return undefined
  return {
    name,
    type,
    required,
    ...(typeof item.title === 'string' ? { title: item.title } : {}),
    ...(typeof item.description === 'string' ? { description: item.description } : {}),
    ...(options.length === 0 ? {} : { options }),
    ...(item.default !== undefined && item.default !== null
      ? { defaultValue: item.default as string | number | boolean | readonly string[] }
      : {}),
    ...(typeof item.minimum === 'number' ? { minimum: item.minimum } : {}),
    ...(typeof item.maximum === 'number' ? { maximum: item.maximum } : {}),
    ...(typeof item.minItems === 'number' ? { minItems: item.minItems } : {}),
    ...(typeof item.maxItems === 'number' ? { maxItems: item.maxItems } : {}),
    ...(['email', 'uri', 'date', 'date-time'].includes(String(item.format))
      ? { format: item.format as 'email' | 'uri' | 'date' | 'date-time' }
      : {}),
  }
}

function schemaOf(params: acp.CreateElicitationRequest): {
  fields: readonly AcpElicitationFieldView[]
  valid: boolean
} {
  const schema = formSchemaOf(params)
  if (!plain(schema) || (schema.type !== undefined && schema.type !== 'object')) return { fields: [], valid: false }
  const rawProperties = schema.properties
  if (rawProperties !== undefined && !plain(rawProperties)) return { fields: [], valid: false }
  const properties: Record<string, unknown> = rawProperties ?? {}
  const names = Object.keys(properties)
  const rawRequired = schema.required
  if (names.length > 32 || (rawRequired !== undefined && rawRequired !== null && !Array.isArray(rawRequired)))
    return { fields: [], valid: false }
  const requiredValues: readonly unknown[] = Array.isArray(rawRequired) ? rawRequired : []
  if (
    !requiredValues.every((value): value is string => typeof value === 'string') ||
    new Set(requiredValues).size !== requiredValues.length ||
    requiredValues.some((name) => !Object.prototype.hasOwnProperty.call(properties, name))
  )
    return { fields: [], valid: false }
  const required = new Set<string>(requiredValues)
  const fields: AcpElicitationFieldView[] = []
  for (const [name, item] of Object.entries(properties)) {
    const field = fieldViewOf(name, item, required.has(name))
    if (field === undefined) return { fields: [], valid: false }
    fields.push(field)
  }
  return { fields, valid: true }
}

/**
 * Audits retain only field names, coarse schema types, and required-ness. Keep
 * this independent of the renderable view so a declined sensitive schema is
 * still observable without exposing a value or accidentally rendering it.
 */
function validateValues(
  params: acp.CreateElicitationRequest,
  input:
    readonly { readonly name: string; readonly value: string | number | boolean | readonly string[] }[] | undefined,
): Record<string, acp.ElicitationContentValue> | undefined {
  const schema = formSchemaOf(params)
  if (!plain(schema)) return undefined
  const rawProperties = schema.properties
  if (rawProperties !== undefined && !plain(rawProperties)) return undefined
  const properties: Record<string, unknown> = rawProperties ?? {}
  const required = new Set<string>(
    Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === 'string') : [],
  )
  const values = input ?? []
  const out: Record<string, acp.ElicitationContentValue> = {}
  for (const item of values) {
    const schema = properties[item.name] as Record<string, unknown> | undefined
    if (
      schema === undefined ||
      SENSITIVE_FIELD.test(item.name) ||
      (typeof schema.title === 'string' && SENSITIVE_FIELD.test(schema.title)) ||
      (typeof schema.description === 'string' && SENSITIVE_FIELD.test(schema.description)) ||
      schema.sensitive === true ||
      schema.secret === true ||
      recordAt(schema._meta, 'codex')?.isSecret === true ||
      Object.prototype.hasOwnProperty.call(out, item.name)
    )
      return undefined
    const type = schema.type
    const validType =
      type === 'string'
        ? typeof item.value === 'string'
        : type === 'number'
          ? typeof item.value === 'number' && Number.isFinite(item.value)
          : type === 'integer'
            ? typeof item.value === 'number' && Number.isInteger(item.value)
            : type === 'boolean'
              ? typeof item.value === 'boolean'
              : type === 'array' && Array.isArray(item.value) && item.value.every((value) => typeof value === 'string')
    if (!validType) return undefined
    if ((type === 'number' || type === 'integer') && typeof item.value === 'number') {
      if (typeof schema.minimum === 'number' && item.value < schema.minimum) return undefined
      if (typeof schema.maximum === 'number' && item.value > schema.maximum) return undefined
    }
    if (type === 'array' && Array.isArray(item.value)) {
      if (typeof schema.minItems === 'number' && item.value.length < schema.minItems) return undefined
      if (typeof schema.maxItems === 'number' && item.value.length > schema.maxItems) return undefined
      const items = schema.items as Record<string, unknown> | undefined
      const titled = items !== undefined && Array.isArray(items.anyOf) ? items.anyOf : items?.oneOf
      const allowed =
        items !== undefined && Array.isArray(items.enum)
          ? items.enum
          : Array.isArray(titled)
            ? titled.map((value) =>
                typeof value === 'object' && value !== null ? (value as Record<string, unknown>).const : undefined,
              )
            : undefined
      if (allowed !== undefined && item.value.some((value) => !allowed.includes(value))) return undefined
    }
    if (typeof item.value === 'string') {
      if (typeof schema.minLength === 'number' && item.value.length < schema.minLength) return undefined
      if (typeof schema.maxLength === 'number' && item.value.length > schema.maxLength) return undefined
      if (typeof schema.pattern === 'string') {
        try {
          if (!new RegExp(schema.pattern).test(item.value)) return undefined
        } catch {
          return undefined
        }
      }
      const allowed = Array.isArray(schema.enum)
        ? schema.enum
        : Array.isArray(schema.oneOf)
          ? schema.oneOf.map((value) =>
              typeof value === 'object' && value !== null ? (value as Record<string, unknown>).const : undefined,
            )
          : undefined
      if (allowed !== undefined && !allowed.includes(item.value)) return undefined
      if (!validStringFormat(item.value, schema.format)) return undefined
    }
    out[item.name] = item.value as acp.ElicitationContentValue
  }
  for (const name of required) {
    // codex-acp lists every user-input question as required so that a form UI forces an answer, yet it decodes
    // the answers it receives and leaves the rest. DSH's card always offers Skip, so such a question may be
    // absent; any other required field that is missing fails the form.
    if (typeof recordAt(properties[name], '_meta', 'codex')?.isOther === 'boolean') continue
    if (!Object.prototype.hasOwnProperty.call(out, name)) return undefined
  }
  return out
}

/** The narrow structural face of DSH's native user-question service. */
export interface AcpNativeUserQuestionService {
  ask(request: {
    readonly questions: readonly {
      readonly id: string
      readonly question: string
      readonly detail?: string
      readonly header?: string
      readonly options?: readonly { readonly label: string; readonly description?: string }[]
      readonly multiSelect?: boolean
    }[]
    readonly agent?: unknown
    readonly signal?: AbortSignal
  }): Promise<{
    readonly answers: readonly { readonly id: string; readonly selected: readonly string[]; readonly custom?: string }[]
  }>
}

export interface AcpNativeElicitationDeps {
  readonly userQuestions?: AcpNativeUserQuestionService
  readonly getAgent: () => unknown
  readonly locale?: string
  /** Supplied only by the live host bridge after exact request/call correlation. */
  readonly hostToolName?: string
  /** Native child approval for an exactly correlated DSH tool; never answers arbitrary forms. */
  readonly approveDelegatedOnce?: (signal?: AbortSignal) => Promise<boolean>
  readonly log?: (message: string) => void
}

interface CompanionLink {
  /** The free-text field that carries what the user types beside the question's choices. */
  readonly field: AcpElicitationFieldView
  /** codex-acp's `user_note`: its required single-select can only be answered through "None of the above". */
  readonly codexNote: boolean
}

/** The question a free-text field declares itself the text box of, by an explicit vendor marker. */
function declaredBase(meta: unknown): { readonly base: string; readonly codexNote: boolean } | undefined {
  const codex = recordAt(meta, 'codex')
  const note = codex?.role === 'user_note' ? codex.questionId : undefined
  if (typeof note === 'string') return { base: note, codexNote: true }
  for (const marker of [
    recordAt(meta, 'jetbrains', 'air', 'customAnswer'),
    recordAt(meta, '_askUserQuestionCustomAnswer'),
  ]) {
    const questionId = marker?.questionId
    if (typeof questionId === 'string') return { base: questionId, codexNote: false }
  }
  return undefined
}

/**
 * Pair each free-text companion with the choice question it belongs to: by the Agent's own marker first, then
 * by key suffix. A question takes at most one companion, and a field that does not qualify stays a question of
 * its own.
 */
function companionLinks(
  properties: Record<string, unknown>,
  fields: readonly AcpElicitationFieldView[],
): ReadonlyMap<string, CompanionLink> {
  const choices = new Set(
    fields
      .filter((field) => (field.type === 'string' || field.type === 'array') && field.options !== undefined)
      .map((field) => field.name),
  )
  // Plain, optional, optionless text: nothing a card's text box could not carry.
  const texts = fields.filter((field) => {
    const raw = properties[field.name]
    return (
      field.type === 'string' &&
      !field.required &&
      field.options === undefined &&
      field.defaultValue === undefined &&
      field.format === undefined &&
      plain(raw) &&
      ['minLength', 'maxLength', 'pattern'].every((key) => raw[key] === undefined || raw[key] === null)
    )
  })
  const claims: { base: string; field: AcpElicitationFieldView; codexNote: boolean }[] = []
  for (const field of texts) {
    const declared = declaredBase(recordAt(properties[field.name])?._meta)
    if (declared !== undefined) claims.push({ ...declared, field })
  }
  // A field that carries a marker never falls back to guessing from its key.
  const marked = new Set(claims.map((claim) => claim.field.name))
  for (const field of texts) {
    const suffix = COMPANION_SUFFIXES.find((candidate) => field.name.endsWith(candidate))
    if (suffix !== undefined && !marked.has(field.name))
      claims.push({ base: field.name.slice(0, -suffix.length), field, codexNote: false })
  }
  const links = new Map<string, CompanionLink>()
  for (const { base, field, codexNote } of claims)
    if (choices.has(base) && !links.has(base)) links.set(base, { field, codexNote })
  return links
}

/**
 * DSH returns labels, so every displayed choice must map unambiguously to its wire value. The Agent's default
 * choice is shown as the recommended one; only its label changes, never the value it maps back to.
 */
function displayOptions(
  options: NonNullable<AcpElicitationFieldView['options']>,
  recommended?: { readonly value: string; readonly suffix: string },
) {
  const titles = options.map((option) => option.title?.trim() || option.value)
  let labels = titles.map((title, index) =>
    titles.indexOf(title) === titles.lastIndexOf(title) ? title : `${title} (${options[index]!.value})`,
  )
  if (recommended !== undefined)
    labels = labels.map((label, index) =>
      options[index]!.value === recommended.value && !RECOMMENDED_LABEL.test(label)
        ? `${label}${recommended.suffix}`
        : label,
    )
  // A supplied title can itself collide with a disambiguated title. Number the
  // entire set in that rare case rather than guessing which value was chosen.
  if (new Set(labels).size !== labels.length) labels = labels.map((label, index) => `${index + 1}. ${label}`)
  return options.map((option, index) => ({ ...option, label: labels[index]! }))
}

/**
 * Bridge ACP form elicitation to DSH's native question waterfall. URL
 * elicitation is deliberately declined: this plugin has no public, safe host
 * URL-opener seam and must never open or prefetch an Agent-supplied URL.
 */
export function createAcpNativeElicitationHandler(
  deps: AcpNativeElicitationDeps,
): (params: acp.CreateElicitationRequest, signal?: AbortSignal) => Promise<acp.CreateElicitationResponse> {
  return async (params, signal) => {
    if (params.mode !== 'form' || deps.userQuestions === undefined) return { action: 'cancel' }
    if (signal?.aborted === true) return { action: 'cancel' }
    const schema = schemaOf(params)
    if (!schema.valid || schema.fields.length === 0) return { action: 'cancel' }
    const message =
      params.message.trim().length > 4_096 ? `${params.message.trim().slice(0, 4_096)}…` : params.message.trim()
    // The first line of the message and the lines after it: a form of one untitled field is asked by them.
    const lineEnd = message.search(/[\r\n]/)
    const headline = lineEnd < 0 ? message : message.slice(0, lineEnd).trim()
    const body = lineEnd < 0 ? '' : message.slice(lineEnd).trim()
    const zh = deps.locale?.toLowerCase().startsWith('zh') === true
    const scopeTitles: Record<string, string> = zh
      ? { once: '仅允许一次', session: '在本次会话中允许', always: '始终允许，不再询问' }
      : { once: 'Allow once', session: 'Allow for this session', always: "Always allow, don't ask again" }
    const recommendedSuffix = zh ? '（推荐）' : ' (Recommended)'
    const rawProperties = (formSchemaOf(params).properties ?? {}) as Record<string, unknown>
    // A free-text companion is the card's own text box, so it is never a question of its own.
    const companions = companionLinks(rawProperties, schema.fields)
    const companionNames = new Set([...companions.values()].map((link) => link.field.name))
    const asked = schema.fields.filter((field) => !companionNames.has(field.name))
    // The message of a Codex form ("Codex needs your input to continue.") is generic, so it never words a
    // question. Codex marks its forms with `_meta.codex.autoResolutionMs` at the root and `_meta.codex` on fields.
    const rootCodex = recordAt(params._meta, 'codex')
    const codexForm =
      (rootCodex !== undefined && Object.hasOwn(rootCodex, 'autoResolutionMs')) ||
      Object.values(rawProperties).some((property) => recordAt(property, '_meta', 'codex') !== undefined)
    // The first line of the message can word the lone question that its field leaves unworded.
    const messageWords = deps.hostToolName === undefined && !codexForm && headline !== ''
    const fields = asked.map((field) => {
      const scope =
        params._meta?.codex_approval_kind === 'mcp_tool_call' &&
        field.name === 'persist' &&
        field.type === 'string' &&
        (field.options?.length ?? 0) > 0 &&
        field.options!.every((option) => Object.hasOwn(scopeTitles, option.value))
      const options = displayOptions(
        field.options?.map((option) => (scope ? { ...option, title: scopeTitles[option.value]! } : option)) ??
          (field.type === 'boolean'
            ? [
                { value: 'true', title: zh ? '是' : 'Yes' },
                { value: 'false', title: zh ? '否' : 'No' },
              ]
            : []),
        field.type === 'string' && typeof field.defaultValue === 'string'
          ? { value: field.defaultValue, suffix: recommendedSuffix }
          : undefined,
      )
      const title = field.title?.trim() ?? ''
      const description = field.description?.trim() ?? ''
      // OMP's select, confirm, input and editor dialogs send one untitled field, `value`, with the dialog text
      // as the message: that text is the question, not the field name.
      const askedByMessage = !scope && schema.fields.length === 1 && messageWords && title === ''
      // A question merged with its free-text box comes from an ask tool (Claude AskUserQuestion, OMP ask, Codex
      // user input), which keeps a short chip label and the question itself apart: Claude puts the chip in the
      // title and the question in the description (a lone question in the message), OMP and Codex put the
      // question in the title and the chip in the description. The card shows `header` as a small label above
      // the question. So the long text is the field's description, or else the message of a form that asks only
      // this question; with the title and a long text the shorter becomes the header and the longer the
      // question (a tie keeps the title as the question), and a text alone is the question.
      const merged = !scope && companions.has(field.name)
      const longFromMessage = merged && description === '' && asked.length === 1 && messageWords
      const longText = longFromMessage ? headline : merged ? description : ''
      const labelled = title !== '' && longText !== '' && title !== longText
      const titleIsShorter = title.length < longText.length
      const shorter = titleIsShorter ? title : longText
      const longer = titleIsShorter ? longText : title
      const question = labelled ? longer : title || longText || (askedByMessage ? headline : field.name)
      return {
        ...field,
        question: scope ? (zh ? '授权范围' : 'Approval scope') : question,
        header: labelled ? shorter : undefined,
        // Merged, the description is on the card already: as the header or as the question.
        description: merged ? undefined : field.description,
        options,
        // The message's first line is on the card when it worded the question or became the header.
        usesHeadline: askedByMessage || longFromMessage,
      }
    })
    const questions = fields.map((field, index) => {
      // Only a verified, exact Codex bridge message is replaced. Other agents'
      // explanations remain intact, including any additional approval context.
      const introduction =
        deps.hostToolName === undefined
          ? message
          : zh
            ? `允许 Agent 调用 DSH 工具“${deps.hostToolName}”吗？`
            : `Allow the Agent to use the DSH tool "${deps.hostToolName}"?`
      // A message whose first line is on the card already leaves only the lines after it to say.
      const lead = field.usesHeadline ? body : introduction
      const questionText = field.question.trim()
      const detailParts: string[] = []
      // The detail never repeats what the card shows as the header or as the question.
      const seenDetails = new Set<string>(field.header === undefined ? [] : [field.header])
      for (const part of [index === 0 ? lead : undefined, field.description]) {
        if (part === undefined || part.length === 0) continue
        const comparable = part.trim()
        if (comparable === questionText || seenDetails.has(comparable)) continue
        seenDetails.add(comparable)
        detailParts.push(part)
      }
      const detail = detailParts.join('\n\n')
      return {
        id: field.name,
        question: field.question,
        ...(field.header === undefined ? {} : { header: field.header }),
        ...(detail.length === 0 ? {} : { detail }),
        ...(field.options.length === 0
          ? {}
          : {
              options: field.options.map((option) => ({
                label: option.label,
                ...(option.description === undefined ? {} : { description: option.description }),
              })),
            }),
        ...(field.type === 'array' ? { multiSelect: true } : {}),
      }
    })
    try {
      const agent = deps.getAgent()
      if (agent === undefined) return { action: 'cancel' }
      const answer = await deps.userQuestions.ask({ questions, agent, ...(signal === undefined ? {} : { signal }) })
      if (signal?.aborted) return { action: 'cancel' }
      const values: { name: string; value: string | number | boolean | readonly string[] }[] = []
      for (const field of fields) {
        const item = answer.answers.find((candidate) => candidate.id === field.name)
        if (item === undefined) continue
        const companion = companions.get(field.name)
        const typed = item.custom?.trim() ?? ''
        // Enum answers must be explicit displayed choices; never interpret free
        // text as a permission scope or guess from a protocol identifier. Typed
        // text answers a choice question only through the companion field the
        // Agent's own form gave it.
        if (
          field.options.length > 0 &&
          ((typed !== '' && companion === undefined) ||
            item.selected.some((label) => !field.options.some((option) => option.label === label)))
        )
          return { action: 'cancel' }
        // Skip leaves the field out. A missing required field fails the form below, except a Codex question,
        // which Codex lists as required but accepts unanswered.
        if (item.selected.length === 0 && typed === '') continue
        if (field.type !== 'array' && item.selected.length > 1) return { action: 'cancel' }
        const selected = item.selected.map(
          (label) => field.options.find((option) => option.label === label)?.value ?? label,
        )
        if (companion !== undefined) {
          // The pick answers the question itself and the typed text its companion field.
          if (selected.length > 0)
            values.push({ name: field.name, value: field.type === 'array' ? selected : selected[0]! })
          else if (
            companion.codexNote &&
            field.required &&
            field.type === 'string' &&
            field.options.some((option) => option.value === CODEX_OTHER_OPTION)
          )
            // Codex insists on an answer to the question itself; "None of the above" sends the note instead.
            values.push({ name: field.name, value: CODEX_OTHER_OPTION })
          if (typed !== '') values.push({ name: companion.field.name, value: typed })
          continue
        }
        if (field.type === 'array') values.push({ name: field.name, value: selected })
        else if (field.type === 'boolean') {
          const value = selected[0] ?? item.custom
          if (value !== 'true' && value !== 'false') return { action: 'cancel' }
          values.push({ name: field.name, value: value === 'true' })
        } else if (field.type === 'number' || field.type === 'integer') {
          const raw = selected[0] ?? item.custom
          if (raw === undefined || raw.trim() === '') return { action: 'cancel' }
          const value = Number(raw)
          if (!Number.isFinite(value)) return { action: 'cancel' }
          values.push({ name: field.name, value })
        } else {
          values.push({ name: field.name, value: selected[0] ?? item.custom ?? '' })
        }
      }
      const content = validateValues(params, values)
      return content === undefined ? { action: 'cancel' } : { action: 'accept', content }
    } catch (error: unknown) {
      // Native questions intentionally reject owned children. Preserve that
      // boundary for questions, but a verified tool-approval scope can use the
      // native approval service, which supports the original child ownership.
      const once = validateValues(params, [{ name: 'persist', value: 'once' }])
      if (plain(error) || error instanceof Error) {
        const code = (error as { code?: unknown }).code
        if (
          code === 'DELEGATED_CALLER' &&
          !signal?.aborted &&
          deps.hostToolName !== undefined &&
          deps.approveDelegatedOnce !== undefined &&
          params._meta?.codex_approval_kind === 'mcp_tool_call' &&
          schema.fields.length === 1 &&
          schema.fields[0]?.name === 'persist' &&
          schema.fields[0].type === 'string' &&
          schema.fields[0].options?.some((option) => option.value === 'once') &&
          once !== undefined
        ) {
          try {
            const allowed = await deps.approveDelegatedOnce(signal)
            return allowed && !signal?.aborted ? { action: 'accept', content: once } : { action: 'cancel' }
          } catch {
            return { action: 'cancel' }
          }
        }
      }
      deps.log?.(`dsh-acp native elicitation cancelled: ${error instanceof Error ? error.message : String(error)}`)
      return { action: 'cancel' }
    }
  }
}
