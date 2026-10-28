import { describe, expect, it, vi } from 'vitest'
import type * as acp from '@agentclientprotocol/sdk'
import {
  createAcpNativeElicitationHandler,
  type AcpNativeUserQuestionService,
} from '../../../src/domain/policy/elicitation.ts'

const form = (
  properties: Record<string, unknown>,
  required: string[] = Object.keys(properties),
  message = 'Please provide the release settings.',
): acp.CreateElicitationRequest =>
  ({
    mode: 'form',
    message,
    requestedSchema: { type: 'object', properties, required },
  }) as acp.CreateElicitationRequest

describe('native ACP form elicitation bridge (M5c)', () => {
  it('uses DSH native optionless questions for free text and consumes the custom answer channel', async () => {
    let question: { readonly options?: readonly unknown[] } | undefined
    const handler = createAcpNativeElicitationHandler({
      userQuestions: {
        ask: async ({ questions }) => {
          question = questions[0]
          return { answers: [{ id: 'summary', selected: [], custom: 'multi\nline' }] }
        },
      },
      getAgent: () => ({}),
    })

    await expect(handler(form({ summary: { type: 'string' } }))).resolves.toEqual({
      action: 'accept',
      content: { summary: 'multi\nline' },
    })
    expect(question?.options).toBeUndefined()
  })

  it('maps string/enum, boolean, number/integer and multi-select answers to ACP content', async () => {
    const agent = { id: 'root-agent' }
    const requests: unknown[] = []
    const userQuestions: AcpNativeUserQuestionService = {
      ask: async (request) => {
        requests.push(request)
        return {
          answers: [
            { id: 'name', selected: [], custom: 'release-1' },
            { id: 'channel', selected: ['stable'] },
            { id: 'enabled', selected: ['Yes'] },
            { id: 'ratio', selected: [], custom: '1.5' },
            { id: 'count', selected: [], custom: '2' },
            { id: 'tags', selected: ['one', 'two'] },
          ],
        }
      },
    }
    const handler = createAcpNativeElicitationHandler({ userQuestions, getAgent: () => agent })
    const response = await handler(
      form({
        name: { type: 'string' },
        channel: { type: 'string', enum: ['stable', 'canary'] },
        enabled: { type: 'boolean' },
        ratio: { type: 'number', minimum: 0, maximum: 2 },
        count: { type: 'integer', minimum: 1, maximum: 3 },
        tags: { type: 'array', items: { type: 'string', enum: ['one', 'two', 'three'] }, minItems: 1 },
      }),
    )
    expect(response).toEqual({
      action: 'accept',
      content: {
        name: 'release-1',
        channel: 'stable',
        enabled: true,
        ratio: 1.5,
        count: 2,
        tags: ['one', 'two'],
      },
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ agent })
    const questions = (requests[0] as { questions: { id: string; detail?: string; multiSelect?: boolean }[] }).questions
    expect(questions.map((item) => item.id)).toEqual(['name', 'channel', 'enabled', 'ratio', 'count', 'tags'])
    expect(questions[0]).toMatchObject({ id: 'name', detail: 'Please provide the release settings.' })
    expect(questions.at(-1)).toMatchObject({ id: 'tags', multiSelect: true })
  })

  it('removes only exact trimmed duplicates from question detail and preserves other fields', async () => {
    const message = '请确认本地改动应该如何处理，并说明选择依据。'
    const questions: { id: string; question: string; detail?: string }[] = []
    const handler = createAcpNativeElicitationHandler({
      userQuestions: {
        ask: async ({ questions: requested }) => {
          questions.push(...requested)
          return {
            answers: requested.map((item) => ({ id: item.id, selected: [], custom: `value:${item.id}` })),
          }
        },
      },
      getAgent: () => ({}),
    })

    const response = await handler(
      form(
        {
          local_action: {
            type: 'string',
            title: '本地改动',
            description: `  ${message}\n`,
          },
          follow_up: {
            type: 'string',
            title: '补充说明',
            description: '第二项的独立说明必须保留。',
          },
        },
        ['local_action', 'follow_up'],
        message,
      ),
    )

    expect(questions).toEqual([
      { id: 'local_action', question: '本地改动', detail: message },
      { id: 'follow_up', question: '补充说明', detail: '第二项的独立说明必须保留。' },
    ])
    expect(response).toEqual({
      action: 'accept',
      content: { local_action: `value:local_action`, follow_up: `value:follow_up` },
    })
  })

  it('does not repeat detail that matches the question title after trimming', async () => {
    const sameText = '本地改动应该如何处理？'
    let requested: { id: string; question: string; detail?: string } | undefined
    const handler = createAcpNativeElicitationHandler({
      userQuestions: {
        ask: async ({ questions }) => {
          requested = questions[0]
          return { answers: [{ id: 'local_action', selected: [], custom: '保留' }] }
        },
      },
      getAgent: () => ({}),
    })

    const response = await handler(
      form(
        { local_action: { type: 'string', title: sameText, description: ` ${sameText} ` } },
        ['local_action'],
        sameText,
      ),
    )

    expect(requested).toEqual({ id: 'local_action', question: sameText })
    expect(response).toEqual({ action: 'accept', content: { local_action: '保留' } })
  })

  it('keeps distinct request and field details complete and ordered', async () => {
    const message = '请先说明本次操作的总体目标。'
    const description = `${message} 此字段还补充了不同的额外条件。`
    let requested: { id: string; question: string; detail?: string } | undefined
    const handler = createAcpNativeElicitationHandler({
      userQuestions: {
        ask: async ({ questions }) => {
          requested = questions[0]
          return { answers: [{ id: 'reason', selected: [], custom: '已确认' }] }
        },
      },
      getAgent: () => ({}),
    })

    await handler(form({ reason: { type: 'string', title: message, description } }, ['reason'], message))

    expect(requested).toEqual({ id: 'reason', question: message, detail: description })
  })

  it('declines URL and unsupported, nested, sensitive or malformed schemas before asking', async () => {
    const ask = vi.fn(async () => ({ answers: [] }))
    const userQuestions = { ask } as unknown as AcpNativeUserQuestionService
    const handler = createAcpNativeElicitationHandler({ userQuestions, getAgent: () => ({}) })
    await expect(
      handler({ mode: 'url', message: 'login', url: 'https://example.com/login' } as acp.CreateElicitationRequest),
    ).resolves.toEqual({ action: 'cancel' })
    await expect(handler(form({ secret: { type: 'string' } }))).resolves.toEqual({ action: 'cancel' })
    await expect(handler(form({ nested: { type: 'object', properties: {} } }))).resolves.toEqual({ action: 'cancel' })
    await expect(
      handler(form({ value: { type: 'string', enum: ['a'], oneOf: [{ const: 'a', title: 'A' }] } })),
    ).resolves.toEqual({ action: 'cancel' })
    expect(ask).not.toHaveBeenCalled()
  })

  it('fails closed without the host service/Agent and never opens a URL', async () => {
    const params = form({ value: { type: 'string' } })
    await expect(createAcpNativeElicitationHandler({ getAgent: () => ({}) })(params)).resolves.toEqual({
      action: 'cancel',
    })
    await expect(
      createAcpNativeElicitationHandler({
        userQuestions: { ask: async () => ({ answers: [] }) },
        getAgent: () => undefined,
      })(params),
    ).resolves.toEqual({ action: 'cancel' })
  })

  it('propagates the prompt signal, and abort/throw/no answerer become cancel', async () => {
    const controller = new AbortController()
    let received: AbortSignal | undefined
    const service: AcpNativeUserQuestionService = {
      ask: async (request) => {
        received = request.signal
        return { answers: [{ id: 'value', selected: [], custom: 'ok' }] }
      },
    }
    const handler = createAcpNativeElicitationHandler({ userQuestions: service, getAgent: () => ({}) })
    await expect(handler(form({ value: { type: 'string' } }), controller.signal)).resolves.toEqual({
      action: 'accept',
      content: { value: 'ok' },
    })
    expect(received).toBe(controller.signal)
    controller.abort()
    await expect(handler(form({ value: { type: 'string' } }), controller.signal)).resolves.toEqual({ action: 'cancel' })
    const throwing = createAcpNativeElicitationHandler({
      userQuestions: {
        ask: async () => {
          throw new Error('no provider')
        },
      },
      getAgent: () => ({}),
    })
    await expect(throwing(form({ value: { type: 'string' } }))).resolves.toEqual({ action: 'cancel' })
  })

  it('keeps concurrent requests isolated', async () => {
    const answers = ['first', 'second']
    const service: AcpNativeUserQuestionService = {
      ask: vi.fn(async () => {
        const custom = answers.shift() ?? ''
        return { answers: [{ id: 'value', selected: [], custom }] }
      }),
    }
    const handler = createAcpNativeElicitationHandler({ userQuestions: service, getAgent: () => ({}) })
    const [first, second] = await Promise.all([
      handler(form({ value: { type: 'string' } })),
      handler(form({ value: { type: 'string' } })),
    ])
    expect(first).toEqual({ action: 'accept', content: { value: 'first' } })
    expect(second).toEqual({ action: 'accept', content: { value: 'second' } })
    expect(service.ask).toHaveBeenCalledTimes(2)
  })
  it.each(['zh-CN', 'en'])(
    'normalizes Codex scope labels in %s and returns the exact selected scope',
    async (locale) => {
      const params = {
        ...form({
          persist: {
            type: 'string',
            title: 'Approval scope',
            oneOf: [
              { const: 'once', title: 'Allow once' },
              { const: 'session', title: 'Allow for this session' },
              { const: 'always', title: "Allow and don't ask again" },
            ],
          },
        }),
        _meta: { codex_approval_kind: 'mcp_tool_call' },
      }
      for (const [index, scope] of ['once', 'session', 'always'].entries()) {
        const handler = createAcpNativeElicitationHandler({
          locale,
          hostToolName: 'glob',
          getAgent: () => ({}),
          userQuestions: {
            ask: async ({ questions }) => {
              expect(questions[0]?.header).toBeUndefined()
              expect(questions[0]?.question).toBe(locale === 'en' ? 'Approval scope' : '授权范围')
              expect(questions[0]?.detail).toContain('glob')
              expect(questions[0]?.options?.map((option) => option.label)).not.toContain('persist')
              return { answers: [{ id: 'persist', selected: [questions[0]!.options![index]!.label] }] }
            },
          },
        })
        expect(await handler(params)).toEqual({ action: 'accept', content: { persist: scope } })
      }
    },
  )

  it('preserves titled options/descriptions, disambiguates collisions and maps arrays back to values', async () => {
    const oneOf = [
      { const: 'a', title: 'Same', description: 'First' },
      { const: 'b', title: 'Same' },
      { const: 'c', title: 'Same (a)' },
    ]
    const handler = createAcpNativeElicitationHandler({
      getAgent: () => ({}),
      userQuestions: {
        ask: async ({ questions }) => {
          const options = questions[0]!.options!
          expect(new Set(options.map((option) => option.label)).size).toBe(3)
          expect(options[0]?.description).toBe('First')
          return { answers: [{ id: 'choices', selected: [options[0]!.label, options[2]!.label] }] }
        },
      },
    })
    expect(
      await handler(form({ choices: { type: 'array', title: 'Choose', items: { type: 'string', oneOf } } })),
    ).toEqual({ action: 'accept', content: { choices: ['a', 'c'] } })
  })

  it.each([{ selected: [], custom: 'always' }, { selected: ['always'] }, { selected: ['Allow once', 'Always allow'] }])(
    'does not guess enum values from free text or ambiguous selections: %j',
    async (answer) => {
      const handler = createAcpNativeElicitationHandler({
        getAgent: () => ({}),
        userQuestions: {
          ask: async () => ({ answers: [{ id: 'persist', ...answer }] }),
        },
      })
      expect(
        await handler(
          form({
            persist: {
              type: 'string',
              oneOf: [
                { const: 'once', title: 'Allow once' },
                { const: 'always', title: 'Always allow' },
              ],
            },
          }),
        ),
      ).toEqual({ action: 'cancel' })
    },
  )

  it.each([true, false])(
    'uses a child-owned native approval only after delegated rejection (allowed=%s)',
    async (allowed) => {
      const controller = new AbortController()
      const approveDelegatedOnce = vi.fn(async (signal?: AbortSignal) => {
        expect(signal).toBe(controller.signal)
        return allowed
      })
      const handler = createAcpNativeElicitationHandler({
        getAgent: () => ({}),
        hostToolName: 'bash',
        approveDelegatedOnce,
        userQuestions: {
          ask: async () => {
            throw Object.assign(new Error('owned child'), { code: 'DELEGATED_CALLER' })
          },
        },
      })
      const params = {
        ...form({ persist: { type: 'string', enum: ['once', 'session', 'always'] } }),
        _meta: { codex_approval_kind: 'mcp_tool_call' },
      }
      expect(await handler(params, controller.signal)).toEqual(
        allowed ? { action: 'accept', content: { persist: 'once' } } : { action: 'cancel' },
      )
      expect(approveDelegatedOnce).toHaveBeenCalledTimes(1)
    },
  )

  it.each([
    'unverified',
    'ordinary-form',
    'extra-field',
    'persistent-only',
    'other-error',
    'aborted',
    'approval-error',
    'late-abort',
  ])('fails closed for delegated approval: %s', async (scenario) => {
    const controller = new AbortController()
    const approveDelegatedOnce = vi.fn(async () => {
      if (scenario === 'approval-error') throw new Error('offline')
      if (scenario === 'late-abort') controller.abort()
      return true
    })
    const handler = createAcpNativeElicitationHandler({
      getAgent: () => ({}),
      ...(scenario === 'unverified' ? {} : { hostToolName: 'bash' }),
      approveDelegatedOnce,
      userQuestions: {
        ask: async () => {
          if (scenario === 'aborted') controller.abort()
          throw Object.assign(new Error('question rejected'), {
            code: scenario === 'other-error' ? 'NO_PROVIDER' : 'DELEGATED_CALLER',
          })
        },
      },
    })
    const params = {
      ...form({
        persist: { type: 'string', enum: scenario === 'persistent-only' ? ['session', 'always'] : ['once', 'always'] },
        ...(scenario === 'extra-field' ? { note: { type: 'string' } } : {}),
      }),
      ...(scenario === 'ordinary-form' ? {} : { _meta: { codex_approval_kind: 'mcp_tool_call' } }),
    }
    expect(await handler(params, controller.signal)).toEqual({ action: 'cancel' })
    expect(approveDelegatedOnce).toHaveBeenCalledTimes(['approval-error', 'late-abort'].includes(scenario) ? 1 : 0)
  })
})

type DshQuestion = Parameters<AcpNativeUserQuestionService['ask']>[0]['questions'][number]
type DshAnswer = { id: string; selected: string[]; custom?: string }

/** A DSH question service that records the questions it is asked and answers as scripted. */
function answering(answers: DshAnswer[], locale?: string, hostToolName?: string) {
  const asked: DshQuestion[] = []
  const ask = vi.fn<AcpNativeUserQuestionService['ask']>(async ({ questions }) => {
    asked.push(...questions)
    return { answers }
  })
  const handler = createAcpNativeElicitationHandler({
    userQuestions: { ask },
    getAgent: () => ({}),
    ...(locale === undefined ? {} : { locale }),
    ...(hostToolName === undefined ? {} : { hostToolName }),
  })
  return { ask, asked, handler }
}

/** A form as a vendor's ACP agent sends it: session scope and tool call included. */
const vendorForm = (
  message: string,
  properties: Record<string, unknown>,
  required: string[] | undefined,
  extra: Record<string, unknown> = {},
): acp.CreateElicitationRequest =>
  ({
    mode: 'form',
    sessionId: 'vendor-session',
    toolCallId: 'vendor-call',
    message,
    requestedSchema: { type: 'object', properties, required },
    ...extra,
  }) as acp.CreateElicitationRequest

describe('claude-agent-acp AskUserQuestion form (question_<n> with question_<n>_custom)', () => {
  const library = {
    type: 'string',
    title: 'Library',
    description: undefined,
    oneOf: [
      { const: 'React', title: 'React', description: 'Component model' },
      { const: 'Vue', title: 'Vue' },
    ],
  }
  const other = {
    type: 'string',
    title: 'Other',
    description: 'Type your own answer, or add a note to the option you chose above (optional).',
  }
  const single = (): acp.CreateElicitationRequest =>
    vendorForm('Which library should we use?', { question_0: library, question_0_custom: other }, undefined)
  const several = (): acp.CreateElicitationRequest =>
    vendorForm(
      'Please answer the following questions.',
      {
        question_0: { ...library, description: 'Which library should we use?' },
        question_0_custom: other,
        question_1: {
          type: 'array',
          title: 'Features',
          description: 'Which features do you need?',
          items: {
            anyOf: [
              { const: 'Auth', title: 'Auth' },
              { const: 'Billing', title: 'Billing', description: 'Invoices' },
            ],
          },
        },
        question_1_custom: {
          ...other,
          description: 'Type your own answer to add to your selection above (optional).',
        },
      },
      undefined,
    )

  it('asks one question per AskUserQuestion question, the custom box merged into it', async () => {
    const { handler, asked } = answering([])
    await handler(single())
    // A lone question has its text in the message alone; the chip in the title is its header.
    expect(asked).toEqual([
      {
        id: 'question_0',
        header: 'Library',
        question: 'Which library should we use?',
        options: [{ label: 'React', description: 'Component model' }, { label: 'Vue' }],
      },
    ])

    // With several questions Claude puts the chip label in the title and the question in the description.
    const multiple = answering([])
    await multiple.handler(several())
    expect(multiple.asked).toEqual([
      {
        id: 'question_0',
        header: 'Library',
        question: 'Which library should we use?',
        detail: 'Please answer the following questions.',
        options: [{ label: 'React', description: 'Component model' }, { label: 'Vue' }],
      },
      {
        id: 'question_1',
        header: 'Features',
        question: 'Which features do you need?',
        options: [{ label: 'Auth' }, { label: 'Billing', description: 'Invoices' }],
        multiSelect: true,
      },
    ])
  })

  it('answers the question field with the pick and leaves the custom field out', async () => {
    const { handler } = answering([{ id: 'question_0', selected: ['Vue'] }])
    expect(await handler(single())).toEqual({ action: 'accept', content: { question_0: 'Vue' } })
  })

  it('puts typed text into the custom field and clears the pick, trimmed', async () => {
    const { handler } = answering([{ id: 'question_0', selected: [], custom: '  Svelte, please \n' }])
    expect(await handler(single())).toEqual({ action: 'accept', content: { question_0_custom: 'Svelte, please' } })
  })

  it('sends a pick and typed text to their own fields', async () => {
    const { handler } = answering([{ id: 'question_0', selected: ['React'], custom: 'with Vite' }])
    expect(await handler(single())).toEqual({
      action: 'accept',
      content: { question_0: 'React', question_0_custom: 'with Vite' },
    })
  })

  it('keeps a multi-select pick and the typed text as separate answers', async () => {
    const { handler } = answering([
      { id: 'question_0', selected: ['Vue'] },
      { id: 'question_1', selected: ['Auth', 'Billing'], custom: 'Audit log' },
    ])
    expect(await handler(several())).toEqual({
      action: 'accept',
      content: { question_0: 'Vue', question_1: ['Auth', 'Billing'], question_1_custom: 'Audit log' },
    })
    const typedOnly = answering([{ id: 'question_1', selected: [], custom: 'Audit log' }])
    expect(await typedOnly.handler(several())).toEqual({
      action: 'accept',
      content: { question_1_custom: 'Audit log' },
    })
  })

  it('omits a skipped question and its custom field; the form still completes', async () => {
    const skips = [[], [{ id: 'question_0', selected: [] }], [{ id: 'question_0', selected: [], custom: ' ' }]]
    for (const answers of skips) {
      const { handler } = answering(answers)
      expect(await handler(single())).toEqual({ action: 'accept', content: {} })
    }
    const half = answering([
      { id: 'question_0', selected: ['React'] },
      { id: 'question_1', selected: [] },
    ])
    expect(await half.handler(several())).toEqual({ action: 'accept', content: { question_0: 'React' } })
  })

  it('cancels an answer that names no offered choice or more than one choice for a single-select', async () => {
    for (const answer of [
      { id: 'question_0', selected: ['Angular'] },
      { id: 'question_0', selected: ['React', 'Vue'] },
    ]) {
      expect(await answering([answer]).handler(single())).toEqual({ action: 'cancel' })
    }
  })

  it('marks the default option of a single-select as recommended and maps it back to its value', async () => {
    const form = vendorForm(
      'Which library should we use?',
      { question_0: { ...library, default: 'Vue' }, question_0_custom: other },
      undefined,
    )
    const { handler, asked } = answering([{ id: 'question_0', selected: ['Vue (Recommended)'] }])
    expect(await handler(form)).toEqual({ action: 'accept', content: { question_0: 'Vue' } })
    expect(asked[0]?.options?.map((entry) => entry.label)).toEqual(['React', 'Vue (Recommended)'])
  })
})

describe('OMP ask dialog form (q<n> with q<n>__other)', () => {
  const other = { type: 'string', title: 'Other (type your own)' }
  const database = {
    type: 'string',
    title: 'Which database should we use?',
    description: 'Storage',
    oneOf: [
      { const: 'SQLite', title: 'SQLite', description: 'Embedded' },
      { const: 'Postgres', title: 'Postgres' },
    ],
    default: 'SQLite',
  }
  const checks = {
    type: 'array',
    title: 'Which checks should run?',
    items: {
      anyOf: [
        { const: 'lint', title: 'lint' },
        { const: 'unit', title: 'unit' },
      ],
    },
  }
  const dialog = (): acp.CreateElicitationRequest =>
    vendorForm(
      'Answer 2 questions',
      { q0: database, q0__other: other, q1: checks, q1__other: other },
      undefined,
      { toolCallId: undefined },
    )

  it('asks one question per ask question with the default shown as recommended', async () => {
    const { handler, asked } = answering([])
    await handler(dialog())
    // OMP puts the question in the title and the chip label in the description.
    expect(asked).toEqual([
      {
        id: 'q0',
        header: 'Storage',
        question: 'Which database should we use?',
        detail: 'Answer 2 questions',
        options: [{ label: 'SQLite (Recommended)', description: 'Embedded' }, { label: 'Postgres' }],
      },
      {
        id: 'q1',
        question: 'Which checks should run?',
        options: [{ label: 'lint' }, { label: 'unit' }],
        multiSelect: true,
      },
    ])
  })

  it('asks a lone ask question and its other box as exactly one question', async () => {
    const { handler, asked } = answering([{ id: 'q0', selected: ['Postgres'] }])
    const form = vendorForm('Which database should we use?', { q0: database, q0__other: other }, undefined)
    expect(await handler(form)).toEqual({ action: 'accept', content: { q0: 'Postgres' } })
    expect(asked).toHaveLength(1)
    // The message repeats the question, so nothing is left for the detail.
    expect(asked[0]).toEqual({
      id: 'q0',
      header: 'Storage',
      question: 'Which database should we use?',
      options: [{ label: 'SQLite (Recommended)', description: 'Embedded' }, { label: 'Postgres' }],
    })
  })

  it('answers q<n> with the pick (by its exact value) and q<n>__other with typed text', async () => {
    const picked = answering([{ id: 'q0', selected: ['SQLite (Recommended)'] }])
    expect(await picked.handler(dialog())).toEqual({ action: 'accept', content: { q0: 'SQLite' } })
    const typed = answering([{ id: 'q0', selected: [], custom: 'DuckDB' }])
    expect(await typed.handler(dialog())).toEqual({ action: 'accept', content: { q0__other: 'DuckDB' } })
  })

  it('answers a multi-select pick together with the typed text', async () => {
    const { handler } = answering([
      { id: 'q0', selected: ['Postgres'] },
      { id: 'q1', selected: ['lint'], custom: 'e2e' },
    ])
    expect(await handler(dialog())).toEqual({
      action: 'accept',
      content: { q0: 'Postgres', q1: ['lint'], q1__other: 'e2e' },
    })
  })

  it('omits skipped questions', async () => {
    const { handler } = answering([
      { id: 'q0', selected: [] },
      { id: 'q1', selected: [] },
    ])
    expect(await handler(dialog())).toEqual({ action: 'accept', content: {} })
  })

  it('asks a text-only ask question, which OMP sends as a lone q<n>__other, as a free-text question', async () => {
    const { handler, asked } = answering([{ id: 'q0__other', selected: [], custom: 'because' }])
    const form = vendorForm('Why?', { q0__other: other }, undefined)
    expect(await handler(form)).toEqual({ action: 'accept', content: { q0__other: 'because' } })
    expect(asked).toHaveLength(1)
    expect(asked[0]?.options).toBeUndefined()
  })

  it('shows a default in the zh locale with the Chinese suffix', async () => {
    const { handler, asked } = answering([{ id: 'q0', selected: ['SQLite（推荐）'] }], 'zh-CN')
    expect(await handler(dialog())).toEqual({ action: 'accept', content: { q0: 'SQLite' } })
    expect(asked[0]?.options?.map((entry) => entry.label)).toEqual(['SQLite（推荐）', 'Postgres'])
  })
})

describe('OMP select, confirm, input and editor dialogs (one untitled field named value)', () => {
  const cases: {
    name: string
    properties: Record<string, unknown>
    message: string
    extra?: Record<string, unknown>
    hostToolName?: string
    expected: { question: string; detail?: string }
  }[] = [
    {
      name: 'select: the dialog text is the whole message',
      properties: { value: { type: 'string', enum: ['main', 'dev'] } },
      message: 'Pick a branch',
      expected: { question: 'Pick a branch' },
    },
    {
      name: 'confirm: the title is the question and the body, every line of it, the detail',
      properties: { value: { type: 'boolean' } },
      message: 'Delete the cache?\n\nThis removes 3 files.\nIt cannot be undone.',
      expected: { question: 'Delete the cache?', detail: 'This removes 3 files.\nIt cannot be undone.' },
    },
    {
      name: 'input: the placeholder is the field description and follows the message detail',
      properties: { value: { type: 'string', description: 'for example feature/x' } },
      message: '  Branch name  ',
      expected: { question: 'Branch name', detail: 'for example feature/x' },
    },
    {
      name: 'editor: a CRLF message splits at its first line',
      properties: { value: { type: 'string', default: 'draft' } },
      message: 'Edit the note\r\n\r\nKeep it short',
      expected: { question: 'Edit the note', detail: 'Keep it short' },
    },
    {
      name: 'a body that repeats the question is not repeated',
      properties: { value: { type: 'string' } },
      message: 'Name\n\nName',
      expected: { question: 'Name' },
    },
    {
      name: 'the 4_096 character bound still applies',
      properties: { value: { type: 'string' } },
      message: `Title\n${'y'.repeat(5_000)}`,
      expected: { question: 'Title', detail: `${'y'.repeat(4_090)}…` },
    },
    {
      name: 'a titled field keeps its title and the message as detail',
      properties: { value: { type: 'string', title: 'Branch' } },
      message: 'Pick a branch',
      expected: { question: 'Branch', detail: 'Pick a branch' },
    },
    {
      name: 'a form of several fields keeps the field names',
      properties: { first: { type: 'string' }, second: { type: 'string' } },
      message: 'Fill both',
      expected: { question: 'first', detail: 'Fill both' },
    },
    {
      name: 'the Codex persist scope keeps its own title',
      properties: { persist: { type: 'string', enum: ['once', 'session', 'always'] } },
      message: 'Allow glob?\n\nIt reads the workspace.',
      extra: { _meta: { codex_approval_kind: 'mcp_tool_call' } },
      expected: { question: 'Approval scope', detail: 'Allow glob?\n\nIt reads the workspace.' },
    },
    {
      name: 'a verified DSH tool approval keeps its replaced message',
      properties: { value: { type: 'string' } },
      message: 'Allow glob?',
      hostToolName: 'glob',
      expected: { question: 'value', detail: 'Allow the Agent to use the DSH tool "glob"?' },
    },
  ]

  it('asks a lone untitled field by its message: first line the question, later lines the detail', async () => {
    for (const { name, properties, message, extra, hostToolName, expected } of cases) {
      const { handler, asked } = answering([], undefined, hostToolName)
      await handler(vendorForm(message, properties, [], extra))
      expect({ question: asked[0]?.question, detail: asked[0]?.detail }, name).toEqual(expected)
    }
  })
})

describe('codex-acp user input form (<id> with <id>_note and "None of the above")', () => {
  const NONE = 'None of the above'
  const scope = (flags: Record<string, unknown> = { isOther: true, isSecret: false }) => ({
    title: 'Which scope should the migration cover?',
    description: 'Scope',
    _meta: { codex: flags },
    type: 'string',
    oneOf: [
      { const: 'Narrow', title: 'Narrow', description: 'Only touched files' },
      { const: 'Broad', title: 'Broad' },
      { const: NONE, title: NONE, description: 'Provide a different answer in the note field.' },
    ],
  })
  const note = (flags: Record<string, unknown> = {}, questionId = 'scope') => ({
    type: 'string',
    title: 'Additional answer or note',
    _meta: { codex: { questionId, role: 'user_note', isSecret: false, ...flags } },
  })
  const input = (properties: Record<string, unknown> = { scope: scope(), scope_note: note() }) =>
    vendorForm('Codex needs your input to continue.', properties, ['scope'], {
      _meta: { codex: { autoResolutionMs: null } },
    })

  it('asks one question for the required question and its note', async () => {
    const { handler, asked } = answering([])
    await handler(input())
    // Codex puts the question in the title and the chip label in the description.
    expect(asked).toEqual([
      {
        id: 'scope',
        header: 'Scope',
        question: 'Which scope should the migration cover?',
        detail: 'Codex needs your input to continue.',
        options: [
          { label: 'Narrow', description: 'Only touched files' },
          { label: 'Broad' },
          { label: NONE, description: 'Provide a different answer in the note field.' },
        ],
      },
    ])
  })

  it('answers the question with the pick', async () => {
    const { handler } = answering([{ id: 'scope', selected: ['Broad'] }])
    expect(await handler(input())).toEqual({ action: 'accept', content: { scope: 'Broad' } })
  })

  it('answers typed text through the note, with "None of the above" for the required question', async () => {
    const { handler } = answering([{ id: 'scope', selected: [], custom: ' Only the api package ' }])
    expect(await handler(input())).toEqual({
      action: 'accept',
      content: { scope: NONE, scope_note: 'Only the api package' },
    })
  })

  it('keeps a pick and a note apart, and an explicit "None of the above" as picked', async () => {
    const both = answering([{ id: 'scope', selected: ['Narrow'], custom: 'plus the docs' }])
    expect(await both.handler(input())).toEqual({
      action: 'accept',
      content: { scope: 'Narrow', scope_note: 'plus the docs' },
    })
    const none = answering([{ id: 'scope', selected: [NONE] }])
    expect(await none.handler(input())).toEqual({ action: 'accept', content: { scope: NONE } })
  })

  it('leaves a skipped required question out, though codex lists every question as required', async () => {
    for (const answers of [[], [{ id: 'scope', selected: [] }], [{ id: 'scope', selected: [], custom: '   ' }]]) {
      expect(await answering(answers).handler(input())).toEqual({ action: 'accept', content: {} })
    }
  })

  it('sends typed text through the note alone when "None of the above" is not offered to carry it', async () => {
    const without = { ...scope(), oneOf: scope().oneOf.slice(0, 2) }
    const { handler } = answering([{ id: 'scope', selected: [], custom: 'Only the api package' }])
    expect(await handler(input({ scope: without, scope_note: note() }))).toEqual({
      action: 'accept',
      content: { scope_note: 'Only the api package' },
    })
  })

  it('does not use "None of the above" for an optional question', async () => {
    const { handler } = answering([{ id: 'scope', selected: [], custom: 'Only the api package' }])
    const form = vendorForm('Codex needs your input to continue.', { scope: scope(), scope_note: note() }, [])
    expect(await handler(form)).toEqual({ action: 'accept', content: { scope_note: 'Only the api package' } })
  })

  it('pairs a note whose id codex had to make unique through its marker', async () => {
    // Questions `scope` and `scope_note` exist, so codex names the note of `scope` `scope_note1`.
    const second = { ...scope({ isOther: false, isSecret: false }), oneOf: scope().oneOf.slice(0, 2) }
    const { handler, asked } = answering([{ id: 'scope', selected: [], custom: 'only api' }])
    const form = input({ scope: scope(), scope_note1: note(), scope_note: second })
    expect(await handler(form)).toEqual({
      action: 'accept',
      content: { scope: NONE, scope_note1: 'only api' },
    })
    expect(asked.map((question) => question.id)).toEqual(['scope', 'scope_note'])
  })

  it.each([
    ['the question', { scope: scope({ isOther: true, isSecret: true }), scope_note: note() }],
    ['its note', { scope: scope(), scope_note: note({ isSecret: true }) }],
  ])('declines the form when %s is flagged secret', async (_where, properties) => {
    const { handler, ask } = answering([{ id: 'scope', selected: ['Broad'] }])
    expect(await handler(input(properties))).toEqual({ action: 'cancel' })
    expect(ask).not.toHaveBeenCalled()
  })

  // codex-acp lists every question id as required, whatever the user does with the card.
  const choiceQuestion = (title: string, labels: string[]) => ({
    title,
    _meta: { codex: { isOther: false, isSecret: false } },
    type: 'string',
    oneOf: labels.map((label) => ({ const: label, title: label })),
  })
  const twoQuestions = () =>
    vendorForm(
      'Codex needs your input to continue.',
      {
        color: choiceQuestion('Which color?', ['Red', 'Green']),
        size: choiceQuestion('Which size?', ['Small', 'Large']),
      },
      ['color', 'size'],
      { _meta: { codex: { autoResolutionMs: null } } },
    )

  it('keeps the answered question when the other one is skipped', async () => {
    const { handler, asked } = answering([
      { id: 'color', selected: ['Green'] },
      { id: 'size', selected: [] },
    ])
    expect(await handler(twoQuestions())).toEqual({ action: 'accept', content: { color: 'Green' } })
    expect(asked.map((question) => question.id)).toEqual(['color', 'size'])
    const unanswered = answering([{ id: 'size', selected: ['Large'] }])
    expect(await unanswered.handler(twoQuestions())).toEqual({ action: 'accept', content: { size: 'Large' } })
  })

  it('accepts empty content when every question is skipped, which codex reads as no answers', async () => {
    const skipped = [
      { id: 'color', selected: [] },
      { id: 'size', selected: [] },
    ]
    for (const answers of [[], skipped]) {
      expect(await answering(answers).handler(twoQuestions())).toEqual({ action: 'accept', content: {} })
    }
  })

  it.each([
    ['without any codex meta', { type: 'string' }],
    ['with codex meta that does not say isOther', { type: 'string', _meta: { codex: { isSecret: false } } }],
    ['with an isOther that is not a boolean', { type: 'string', _meta: { codex: { isOther: 'yes' } } }],
    ['with isOther outside the codex meta', { type: 'string', isOther: true }],
  ])('still fails the form for a skipped required field %s', async (_how, field) => {
    const { handler } = answering([{ id: 'name', selected: [] }])
    expect(await handler(vendorForm('Name', { name: field }, ['name']))).toEqual({ action: 'cancel' })
  })

  it('still fails the form for a skipped generic required field next to codex questions', async () => {
    const properties = { color: choiceQuestion('Which color?', ['Red', 'Green']), name: { type: 'string' } }
    const form = vendorForm('Codex needs your input to continue.', properties, ['color', 'name'])
    const generic = answering([
      { id: 'color', selected: ['Red'] },
      { id: 'name', selected: [] },
    ])
    expect(await generic.handler(form)).toEqual({ action: 'cancel' })
    const codex = answering([
      { id: 'color', selected: [] },
      { id: 'name', selected: [], custom: 'Ada' },
    ])
    expect(await codex.handler(form)).toEqual({ action: 'accept', content: { name: 'Ada' } })
  })
})

describe('free-text companions in general', () => {
  const pick = {
    type: 'string',
    title: 'Pick one',
    oneOf: [
      { const: 'a', title: 'A' },
      { const: 'b', title: 'B' },
    ],
  }

  it.each([
    ['_meta.jetbrains.air.customAnswer', { jetbrains: { air: { customAnswer: { questionId: 'pick' } } } }],
    ['the legacy _askUserQuestionCustomAnswer', { _askUserQuestionCustomAnswer: { questionId: 'pick' } }],
  ])('merges a free-text field that declares its question through %s, whatever its key', async (_marker, meta) => {
    const { handler, asked } = answering([{ id: 'pick', selected: ['B'], custom: 'but quickly' }])
    const form = vendorForm('Pick', { pick, remarks: { type: 'string', title: 'Remarks', _meta: meta } }, [])
    expect(await handler(form)).toEqual({ action: 'accept', content: { pick: 'b', remarks: 'but quickly' } })
    expect(asked.map((question) => question.id)).toEqual(['pick'])
  })

  it.each(['_custom', '__other', '_note'])('merges the %s companion of an array question', async (suffix) => {
    const tags = { type: 'array', title: 'Tags', items: { enum: ['x', 'y'] } }
    const { handler, asked } = answering([{ id: 'tags', selected: ['x', 'y'], custom: 'z' }])
    const form = vendorForm('Tags', { tags, [`tags${suffix}`]: { type: 'string' } }, [])
    expect(await handler(form)).toEqual({ action: 'accept', content: { tags: ['x', 'y'], [`tags${suffix}`]: 'z' } })
    expect(asked.map((question) => question.id)).toEqual(['tags'])
  })

  it.each([
    ['a required field', { type: 'string' }, ['pick', 'pick_note']],
    ['a field with a length limit', { type: 'string', maxLength: 20 }, []],
    ['a field with a pattern', { type: 'string', pattern: '^[a-z]+$' }, []],
    ['a field with a format', { type: 'string', format: 'email' }, []],
    ['a field with its own default', { type: 'string', default: 'n/a' }, []],
    ['a number field', { type: 'number' }, []],
  ])('keeps %s next to a choice question a question of its own', async (_kind, companion, required) => {
    const { handler, asked } = answering([{ id: 'pick', selected: [], custom: 'typed' }])
    await handler(vendorForm('Pick', { pick, pick_note: companion }, required))
    expect(asked.map((question) => question.id)).toEqual(['pick', 'pick_note'])
  })

  it('does not pair a free-text field with a question that has no choices', async () => {
    const { handler, asked } = answering([])
    const properties = {
      name: { type: 'string' },
      name_note: { type: 'string' },
      on: { type: 'boolean' },
      on_note: { type: 'string' },
    }
    await handler(vendorForm('Settings', properties, []))
    expect(asked.map((question) => question.id)).toEqual(['name', 'name_note', 'on', 'on_note'])
  })

  it('pairs a question with one companion, a marked one before a keyed one; the rest stay questions', async () => {
    const marked = { type: 'string', _meta: { _askUserQuestionCustomAnswer: { questionId: 'pick' } } }
    const { handler, asked } = answering([
      { id: 'pick', selected: ['A'], custom: 'one' },
      { id: 'pick_note', selected: [], custom: 'two' },
    ])
    const form = vendorForm('Pick', { pick, pick_note: { type: 'string' }, pick_custom: marked }, [])
    expect(await handler(form)).toEqual({
      action: 'accept',
      content: { pick: 'a', pick_custom: 'one', pick_note: 'two' },
    })
    expect(asked.map((question) => question.id)).toEqual(['pick', 'pick_note'])
  })

  it('lets an explicit marker outrank the key, and never second-guesses a marker that names nothing', async () => {
    const other = { ...pick, title: 'Other one' }
    const toOther = { type: 'string', _meta: { codex: { role: 'user_note', questionId: 'other' } } }
    const { handler, asked } = answering([{ id: 'other', selected: [], custom: 'typed' }])
    expect(await handler(vendorForm('Pick', { pick, other, pick_note: toOther }, []))).toEqual({
      action: 'accept',
      content: { pick_note: 'typed' },
    })
    expect(asked.map((question) => question.id)).toEqual(['pick', 'other'])

    const dangling = { type: 'string', _meta: { codex: { role: 'user_note', questionId: 'missing' } } }
    const unpaired = answering([{ id: 'pick', selected: [], custom: 'typed' }])
    expect(await unpaired.handler(vendorForm('Pick', { pick, pick_note: dangling }, []))).toEqual({ action: 'cancel' })
    expect(unpaired.asked.map((question) => question.id)).toEqual(['pick', 'pick_note'])
  })

  it('still cancels the whole form for typed text on a choice question without a companion', async () => {
    const { handler } = answering([{ id: 'pick', selected: [], custom: 'typed' }])
    expect(await handler(vendorForm('Pick', { pick }, []))).toEqual({ action: 'cancel' })
  })

  it('leaves a skipped field out and cancels only when the skipped field is required', async () => {
    const properties = {
      name: { type: 'string' },
      size: { type: 'integer' },
      tags: { type: 'array', items: { enum: ['x'] } },
    }
    const skipped = [
      { id: 'name', selected: [] },
      { id: 'size', selected: [], custom: '' },
      { id: 'tags', selected: [] },
    ]
    expect(await answering(skipped).handler(vendorForm('Settings', properties, []))).toEqual({
      action: 'accept',
      content: {},
    })
    for (const required of ['name', 'size', 'tags']) {
      expect(await answering(skipped).handler(vendorForm('Settings', properties, [required]))).toEqual({
        action: 'cancel',
      })
    }
  })
})

describe('header and question of a question merged with its free-text box', () => {
  const ASK = 'Which color do you prefer?'
  const choice = (title?: string, description?: string) => ({
    type: 'string',
    oneOf: [
      { const: 'red', title: 'Red' },
      { const: 'blue', title: 'Blue' },
    ],
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
  })
  const box = { type: 'string' }
  /** A second question: the form no longer asks only the merged one. */
  const another = { size: { type: 'string', title: 'Size' } }
  const cases: {
    name: string
    properties: Record<string, unknown>
    message: string
    extra?: Record<string, unknown>
    hostToolName?: string
    expected: { header?: string; question: string; detail?: string }
  }[] = [
    // The field's description is the long text.
    {
      name: 'both texts are trimmed',
      properties: { pick: choice(' Color ', `  ${ASK}  `), pick_custom: box },
      message: 'Pick',
      expected: { header: 'Color', question: ASK, detail: 'Pick' },
    },
    {
      name: 'equal length: the description is the header and the title the question',
      properties: { pick: choice('Colors', 'Shades'), pick_custom: box },
      message: 'Pick',
      expected: { header: 'Shades', question: 'Colors', detail: 'Pick' },
    },
    {
      name: 'identical text: no header, and the text is not repeated',
      properties: { pick: choice('Color', ' Color '), pick_custom: box },
      message: 'Pick',
      expected: { question: 'Color', detail: 'Pick' },
    },
    {
      name: 'a message that repeats the question is not repeated as the detail',
      properties: { pick: choice('Color', ASK), pick_custom: box },
      message: ASK,
      expected: { header: 'Color', question: ASK },
    },
    {
      name: 'a description alone is the question, with no header',
      properties: { pick: choice(undefined, ASK), pick_custom: box, ...another },
      message: 'Please answer the following questions.',
      expected: { question: ASK, detail: 'Please answer the following questions.' },
    },
    // A lone question without a description takes the message as its long text.
    {
      name: 'a lone question takes the message as its question and the title as its header',
      properties: { pick: choice('Color'), pick_custom: box },
      message: ASK,
      expected: { header: 'Color', question: ASK },
    },
    {
      name: 'a lone question with neither title nor description is worded by the message alone',
      properties: { pick: choice(), pick_custom: box },
      message: ASK,
      expected: { question: ASK },
    },
    {
      name: 'only the first line of the message is the question; the lines after it are the detail',
      properties: { pick: choice('Color'), pick_custom: box },
      message: `${ASK}\n\nPick one of the two.`,
      expected: { header: 'Color', question: ASK, detail: 'Pick one of the two.' },
    },
    {
      name: 'a message identical to the title is neither a header nor repeated',
      properties: { pick: choice(ASK), pick_custom: box },
      message: ASK,
      expected: { question: ASK },
    },
    {
      name: 'the message stays the detail when other questions share the form',
      properties: { pick: choice('Color'), pick_custom: box, ...another },
      message: 'Please answer the following questions.',
      expected: { question: 'Color', detail: 'Please answer the following questions.' },
    },
    {
      name: 'the message stays the detail when a tool name is verified',
      properties: { pick: choice('Color'), pick_custom: box },
      message: 'Allow glob?',
      hostToolName: 'glob',
      expected: { question: 'Color', detail: 'Allow the Agent to use the DSH tool "glob"?' },
    },
    {
      name: 'the Codex persist scope keeps its own title and the message as the detail',
      properties: { persist: { type: 'string', enum: ['once', 'session', 'always'] }, persist_note: box },
      message: 'Allow glob?',
      extra: { _meta: { codex_approval_kind: 'mcp_tool_call' } },
      expected: { question: 'Approval scope', detail: 'Allow glob?' },
    },
    {
      name: 'a form with the codex root meta never takes its generic message as the question',
      properties: { pick: choice('Pick one?'), pick_custom: box },
      message: 'Codex needs your input to continue.',
      extra: { _meta: { codex: { autoResolutionMs: null } } },
      expected: { question: 'Pick one?', detail: 'Codex needs your input to continue.' },
    },
    {
      name: 'a form with codex meta on a field never takes its generic message as the question',
      properties: {
        pick: { ...choice('Pick one?'), _meta: { codex: { isOther: true, isSecret: false } } },
        pick_custom: box,
      },
      message: 'Codex needs your input to continue.',
      expected: { question: 'Pick one?', detail: 'Codex needs your input to continue.' },
    },
    // Without a free-text box nothing changes.
    {
      name: 'without a free-text box a titled question keeps its title and the message as the detail',
      properties: { pick: choice('Color') },
      message: ASK,
      expected: { question: 'Color', detail: ASK },
    },
    {
      name: 'without a free-text box the description stays the detail',
      properties: { pick: choice(ASK, 'Color') },
      message: 'Pick',
      expected: { question: ASK, detail: 'Pick\n\nColor' },
    },
  ]

  it('splits a merged question into its header, question and detail', async () => {
    for (const { name, properties, message, extra, hostToolName, expected } of cases) {
      const { handler, asked } = answering([], undefined, hostToolName)
      await handler(vendorForm(message, properties, [], extra))
      const sent = { header: asked[0]?.header, question: asked[0]?.question, detail: asked[0]?.detail }
      expect(sent, name).toEqual(expected)
    }
  })
})

describe('recommended default', () => {
  const database = (extra: Record<string, unknown> = {}, titles: [string, string] = ['SQLite', 'Postgres']) =>
    vendorForm(
      'Database',
      {
        db: {
          type: 'string',
          title: 'Database',
          oneOf: [
            { const: 'sqlite', title: titles[0] },
            { const: 'pg', title: titles[1] },
          ],
          ...extra,
        },
      },
      [],
    )

  it.each([
    ['en', 'Postgres (Recommended)'],
    ['zh-CN', 'Postgres（推荐）'],
  ])('suffixes the default option in %s without touching its value', async (locale, label) => {
    const { handler, asked } = answering([{ id: 'db', selected: [label] }], locale)
    expect(await handler(database({ default: 'pg' }))).toEqual({ action: 'accept', content: { db: 'pg' } })
    expect(asked[0]?.options?.map((entry) => entry.label)).toEqual(['SQLite', label])
  })

  it.each([
    ['Postgres (recommended)', 'en'],
    ['Postgres  （推荐）', 'en'],
    ['Postgres（Recommended）', 'zh'],
    ['Postgres (推荐)', 'zh'],
  ])('does not suffix a default whose label already says so: %s', async (title, locale) => {
    const { handler, asked } = answering([{ id: 'db', selected: [title] }], locale)
    expect(await handler(database({ default: 'pg' }, ['SQLite', title]))).toEqual({
      action: 'accept',
      content: { db: 'pg' },
    })
    expect(asked[0]?.options?.map((entry) => entry.label)).toEqual(['SQLite', title])
  })

  it('numbers the options when the suffix makes two labels equal, so the pick still maps to one value', async () => {
    const { handler, asked } = answering([{ id: 'db', selected: ['2. Postgres (Recommended)'] }])
    expect(await handler(database({ default: 'pg' }, ['Postgres (Recommended)', 'Postgres']))).toEqual({
      action: 'accept',
      content: { db: 'pg' },
    })
    expect(asked[0]?.options?.map((entry) => entry.label)).toEqual([
      '1. Postgres (Recommended)',
      '2. Postgres (Recommended)',
    ])
  })

  it('recommends nothing without a default, and leaves multi-selects and text defaults alone', async () => {
    const none = answering([])
    await none.handler(database())
    expect(none.asked[0]?.options?.map((entry) => entry.label)).toEqual(['SQLite', 'Postgres'])

    const many = answering([])
    const tags = { type: 'array', items: { enum: ['x', 'y'] }, default: ['y'] }
    await many.handler(vendorForm('Tags', { tags }, []))
    expect(many.asked[0]?.options?.map((entry) => entry.label)).toEqual(['x', 'y'])

    const text = answering([])
    await text.handler(vendorForm('Name', { name: { type: 'string', default: 'prefill' } }, []))
    expect(text.asked[0]?.options).toBeUndefined()
  })
})

describe('multi-select items and secrets', () => {
  it('reads titled multi-select items from anyOf, the ACP shape, and refuses an ambiguous list', async () => {
    const items = { anyOf: [{ const: 'a', title: 'Alpha' }, { const: 'b', title: 'Beta' }] }
    const { handler, asked } = answering([{ id: 'letters', selected: ['Beta'] }])
    expect(await handler(vendorForm('Letters', { letters: { type: 'array', items } }, []))).toEqual({
      action: 'accept',
      content: { letters: ['b'] },
    })
    expect(asked[0]?.options?.map((entry) => entry.label)).toEqual(['Alpha', 'Beta'])

    const ambiguous = answering([])
    const both = { ...items, oneOf: items.anyOf }
    expect(await ambiguous.handler(vendorForm('Letters', { letters: { type: 'array', items: both } }, []))).toEqual({
      action: 'cancel',
    })
    expect(ambiguous.ask).not.toHaveBeenCalled()
  })

  it('declines any form that carries a property Codex flags as secret, before asking', async () => {
    const { handler, ask } = answering([{ id: 'name', selected: [], custom: 'x' }])
    const secret = { type: 'string', _meta: { codex: { isSecret: true } } }
    expect(await handler(vendorForm('Name', { name: secret }, []))).toEqual({ action: 'cancel' })
    expect(ask).not.toHaveBeenCalled()
    const open = { type: 'string', _meta: { codex: { isSecret: false } } }
    expect(await handler(vendorForm('Name', { name: open }, []))).toEqual({ action: 'accept', content: { name: 'x' } })
  })
})
