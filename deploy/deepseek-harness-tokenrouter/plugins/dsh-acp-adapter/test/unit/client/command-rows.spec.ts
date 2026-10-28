import { describe, expect, it, vi } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import type { CommandNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { CLAUDE_NATIVE_COMMANDS } from '../../../src/runtime/native/transports/claude-commands.ts'
import { CODEX_NATIVE_COMMANDS } from '../../../src/runtime/native/transports/codex-commands.ts'
import { OMP_NATIVE_COMMANDS } from '../../../src/runtime/native/transports/omp-commands.ts'

// The element-tree stub never mounts these; they only give each primitive a distinct identity to look up.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  DisclosureRow: function DisclosureRow() {
    return null
  },
  MarkdownText: function MarkdownText() {
    return null
  },
  TextShimmer: function TextShimmer() {
    return null
  },
  IconApiOutlineRegular: function IconApiOutlineRegular() {
    return null
  },
  IconQuestionOutlineRegular: function IconQuestionOutlineRegular() {
    return null
  },
}))

import { DisclosureRow, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { AcpCommandRow, installCommandRows } from '../../../src/client/ui/AcpCommandRow.ts'
import {
  COMMAND_RESULT_COMMANDS,
  SIDE_ANSWER_COMMANDS,
  commandRowView,
  type CommandRowPresentation,
} from '../../../src/client/ui/command-rows.ts'
import { en, zh } from '../../../src/client/ui/locales.ts'

interface Element {
  readonly type: unknown
  readonly props: Record<string, unknown>
}

function isElement(value: unknown): value is Element {
  return typeof value === 'object' && value !== null && 'type' in value && 'props' in value
}

/** Every element of a created tree, depth first, including the header content a prop (not `children`) carries. */
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isElement(node)) return []
  return [node, ...elements(node.props.children), ...elements(node.props.collapsedContent)]
}

function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (!isElement(node)) return ''
  return textOf(node.props.children) + textOf(node.props.collapsedContent)
}

const byType = (tree: unknown, type: unknown): Element[] => elements(tree).filter((element) => element.type === type)

function command(overrides: Partial<CommandNode>): CommandNode {
  return {
    kind: 'command',
    seq: 7,
    time: 1,
    commandId: 'command-1' as CommandNode['commandId'],
    name: 'btw',
    args: ' what is a monad?',
    outcome: null,
    ...overrides,
  }
}

function render(
  overrides: Partial<CommandNode>,
  presentation: CommandRowPresentation,
  t: (key: string) => string = (key) => key,
) {
  const tree = AcpCommandRow({ node: command(overrides), t, presentation } as never)
  const [root] = elements(tree)
  const [header] = byType(tree, DisclosureRow)
  return { tree, root: root!, header: header!, markdown: byType(tree, MarkdownText) }
}

describe('side answer row', () => {
  it('shows a pending question as visibly in progress, with the question quoted and no answer yet', () => {
    const { tree, header, markdown, root } = render({ outcome: null }, 'answer')
    expect(header.props.running).toBe(true)
    expect(header.props.title).toBe('/btw')
    expect(textOf(header)).toBe('commandAnswering')
    expect(root.props['data-state']).toBe('running')
    expect(root.props['aria-busy']).toBe(true)
    expect(elements(tree).find((element) => element.type === 'blockquote')?.props.children).toBe('what is a monad?')
    expect(markdown).toEqual([])
  })

  it('hands a long settled answer whole to the Markdown renderer', () => {
    const answer = `# Monads\n\n${'A monad is a design pattern.\n'.repeat(2000)}\n\`\`\`ts\nconst x = 1\n\`\`\``
    const { header, markdown, root } = render({ outcome: { kind: 'success', text: answer } }, 'answer')
    expect(markdown).toHaveLength(1)
    expect(markdown[0]!.props.text).toBe(answer)
    expect(markdown[0]!.props.variant).toBe('body')
    expect(header.props.running).toBe(false)
    expect(header.props.collapsedContent).toBeUndefined()
    expect(root.props['data-state']).toBe('success')
    expect(root.props['aria-busy']).toBeUndefined()
  })

  it('keeps the whole multi-line question, trimmed at both ends only', () => {
    const { tree } = render(
      { args: '  first line\n  second line \n', outcome: { kind: 'success', text: 'ok' } },
      'answer',
    )
    expect(elements(tree).find((element) => element.type === 'blockquote')?.props.children).toBe(
      'first line\n  second line',
    )
  })

  it('omits the quote for a bare command and when the host recorded no arguments', () => {
    for (const args of ['', '   ', null]) {
      const { tree } = render({ args, outcome: { kind: 'error', text: 'Usage: /btw <question>' } }, 'answer')
      expect(elements(tree).filter((element) => element.type === 'blockquote')).toEqual([])
    }
  })

  it('marks a failed question with the error tone and still renders the message as Markdown', () => {
    const { tree, header, markdown, root } = render(
      { outcome: { kind: 'error', text: 'Send a message first, then try `/btw` again.' } },
      'answer',
    )
    expect(root.props['data-state']).toBe('error')
    expect(textOf(header)).toBe('commandFailed')
    expect(header.props.running).toBe(false)
    expect(markdown.map((element) => element.props.text)).toEqual(['Send a message first, then try `/btw` again.'])
    const body = elements(tree).find((element) => element.props['data-tone'] !== undefined)
    expect(body?.props['data-tone']).toBe('error')
    expect(elements(body).includes(markdown[0]!)).toBe(true)
  })

  it('does not tone a successful answer as an error', () => {
    const { tree } = render({ outcome: { kind: 'success', text: 'fine' } }, 'answer')
    expect(elements(tree).filter((element) => element.props['data-tone'] !== undefined)).toEqual([])
  })

  it('says so when a successful command returned nothing, and lets a failure without text stand on its header', () => {
    const empty = render({ outcome: { kind: 'success', text: ' \n ' } }, 'answer')
    expect(empty.markdown).toEqual([])
    expect(textOf(empty.tree)).toContain('commandNoAnswer')
    const missing = render({ outcome: { kind: 'success' } }, 'answer')
    expect(textOf(missing.tree)).toContain('commandNoAnswer')
    const failed = render({ outcome: { kind: 'error' } }, 'answer')
    expect(failed.markdown).toEqual([])
    expect(textOf(failed.header)).toBe('commandFailed')
    expect(textOf(failed.tree)).not.toContain('commandNoAnswer')
  })
})

describe('immediate command row', () => {
  it('puts the typed arguments in the header on one line and shows a running command as in progress', () => {
    const { tree, header, markdown } = render({ name: 'mcp', args: ' reconnect\n  all ', outcome: null }, 'result')
    expect(header.props.title).toBe('/mcp reconnect all')
    expect(header.props.running).toBe(true)
    expect(textOf(header)).toBe('commandRunning')
    expect(markdown).toEqual([])
    expect(elements(tree).filter((element) => element.type === 'blockquote')).toEqual([])
  })

  it('renders the result as compact Markdown', () => {
    const table = '| Category | Tokens |\n| --- | --- |\n| Messages | 1,204 |'
    const { header, markdown } = render(
      { name: 'context', args: '', outcome: { kind: 'success', text: table } },
      'result',
    )
    expect(header.props.title).toBe('/context')
    expect(header.props.collapsedContent).toBeUndefined()
    expect(markdown).toHaveLength(1)
    expect(markdown[0]!.props.text).toBe(table)
    expect(markdown[0]!.props.variant).toBe('compact')
  })

  it('reports an empty successful result and a failed command', () => {
    const empty = render({ name: 'diff', args: null, outcome: { kind: 'success', text: '' } }, 'result')
    expect(textOf(empty.tree)).toContain('commandNoOutput')
    const failed = render(
      { name: 'stop', args: null, outcome: { kind: 'error', text: 'Nothing is running.' } },
      'result',
    )
    expect(textOf(failed.header)).toBe('commandFailed')
    expect(failed.markdown.map((element) => element.props.text)).toEqual(['Nothing is running.'])
  })
})

describe('row copy', () => {
  it('only asks for dictionary keys that both languages define, in every state of both presentations', () => {
    const requested = new Set<string>()
    const t = (key: string): string => {
      requested.add(key)
      return key
    }
    for (const presentation of ['answer', 'result'] as const)
      for (const outcome of [
        null,
        { kind: 'success' as const, text: '**done**' },
        { kind: 'success' as const },
        { kind: 'error' as const, text: 'failed' },
        { kind: 'error' as const },
      ])
        render({ outcome }, presentation, t)
    expect(requested.size).toBeGreaterThan(0)
    for (const key of requested) {
      expect(Object.keys(en), key).toContain(key)
      expect(Object.keys(zh), key).toContain(key)
    }
  })
})

describe('commandRowView', () => {
  it('derives the state from the folded outcome', () => {
    expect(commandRowView(command({ outcome: null }), 'answer').state).toBe('running')
    expect(commandRowView(command({ outcome: { kind: 'success' } }), 'answer').state).toBe('success')
    expect(commandRowView(command({ outcome: { kind: 'error', text: 'no' } }), 'answer').state).toBe('error')
  })

  it('tolerates a window cut between run and done, where the name and arguments are unknown', () => {
    const view = commandRowView(
      command({ name: null, args: null, outcome: { kind: 'success', text: 'late' } }),
      'result',
    )
    expect(view).toEqual({ state: 'success', title: '', question: '', text: 'late' })
  })

  it('treats whitespace-only output as no output but keeps meaningful whitespace inside Markdown', () => {
    expect(commandRowView(command({ outcome: { kind: 'success', text: '\n  \n' } }), 'result').text).toBe('')
    expect(commandRowView(command({ outcome: { kind: 'success', text: '    indented code\n' } }), 'result').text).toBe(
      '    indented code\n',
    )
  })
})

describe('command name registration', () => {
  const names = [...SIDE_ANSWER_COMMANDS, ...COMMAND_RESULT_COMMANDS]

  it('only lists names DSH can register as commands, each in exactly one group', () => {
    for (const name of names) expect(name, name).toMatch(/^[a-z][a-z0-9_-]*$/)
    expect(new Set(names).size).toBe(names.length)
  })

  it('registers one row per name without displacing a renderer another plugin already owns', () => {
    const slots = new SlotCore()
    slots.register(
      { name: 'root', children: { 'conversation.chat.commandview': { kind: 'keyed', scope: 'session' } } } as never,
      (() => null) as never,
    )
    const Foreign = (): null => null
    // The same key at the default priority: a second registration at that priority would throw.
    slots.register({ name: 'conversation.chat.commandview', key: 'status' } as never, Foreign as never)
    const releases: (() => void)[] = []
    installCommandRows({
      slots: {
        register: slots.register.bind(slots),
        inject: (_key: string, setup: () => () => void) => {
          releases.push(setup())
        },
      },
    } as never)

    const winners = slots.entriesOfSlot('conversation.chat.commandview')
    expect(winners.map((entry) => entry.options.key).sort()).toEqual([...names].sort())
    for (const entry of winners) {
      const key = entry.options.key!
      if (key === 'status') {
        expect(entry.component).toBe(Foreign)
        continue
      }
      expect(entry.component).toBe(AcpCommandRow)
      expect(entry.locale).toBe('acpActivity')
      expect(entry.inject?.(), key).toEqual({ presentation: SIDE_ANSWER_COMMANDS.includes(key) ? 'answer' : 'result' })
    }

    for (const release of releases) release()
    expect(slots.entries('conversation.chat.commandview').map((entry) => entry.component)).toEqual([Foreign])
  })

  it.each([
    ['Claude Code', CLAUDE_NATIVE_COMMANDS],
    ['Codex', CODEX_NATIVE_COMMANDS],
    ['Oh My Pi', OMP_NATIVE_COMMANDS],
  ])('has a row for every side and immediate command of the %s table, aliases included', (_agent, table) => {
    const missing = table.flatMap((entry) => {
      const group =
        entry.dispatch === 'side'
          ? SIDE_ANSWER_COMMANDS
          : entry.dispatch === 'immediate'
            ? COMMAND_RESULT_COMMANDS
            : undefined
      return group === undefined ? [] : [entry.name, ...(entry.aliases ?? [])].filter((name) => !group.includes(name))
    })
    expect(missing, 'add these names to src/client/ui/command-rows.ts').toEqual([])
  })
})
