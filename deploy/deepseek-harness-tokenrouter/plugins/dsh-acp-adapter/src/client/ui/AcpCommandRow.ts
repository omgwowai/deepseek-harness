/** Chat rows for vendor side questions and immediate commands (`conversation.chat.commandview`). */
import { createElement as h, useMemo } from 'react'
import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandRowProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  DisclosureRow,
  IconApiOutlineRegular,
  IconQuestionOutlineRegular,
  MarkdownText,
  TextShimmer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './AcpCommandRow.module.css'
import { COMMAND_RESULT_COMMANDS, SIDE_ANSWER_COMMANDS, commandRowView } from './command-rows.ts'
import type { CommandRowPresentation, CommandRowView } from './command-rows.ts'
import type { AcpLocaleKey } from './locales.ts'

export type AcpCommandRowProps = CommandRowProps &
  PropsLocale<'acpActivity'> & {
    /** Set per registered command name by `installCommandRows`. */
    readonly presentation: CommandRowPresentation
  }

type Translate = (key: AcpLocaleKey) => string

/** DisclosureRow is memoized and requires a toggle although these headers never expand: one stable callback. */
const noToggle = (): void => undefined

function statusLabel(view: CommandRowView, presentation: CommandRowPresentation, t: Translate): string | undefined {
  if (view.state === 'running') return t(presentation === 'answer' ? 'commandAnswering' : 'commandRunning')
  return view.state === 'error' ? t('commandFailed') : undefined
}

/** The settled result. Nothing while the command runs; an error without a message is carried by the header alone. */
function commandRowBody(
  view: CommandRowView,
  presentation: CommandRowPresentation,
  labels: MarkdownLabels,
  t: Translate,
): ReactNode {
  if (view.state === 'running') return null
  if (view.text === '')
    return view.state === 'error'
      ? null
      : h('p', { className: css.empty }, t(presentation === 'answer' ? 'commandNoAnswer' : 'commandNoOutput'))
  return h(
    'div',
    { className: css.body, 'data-tone': view.state === 'error' ? 'error' : undefined },
    // An answer is read like an assistant message; command output is secondary and keeps the compact scale.
    h(MarkdownText, { text: view.text, labels, variant: presentation === 'answer' ? 'body' : 'compact' }),
  )
}

/**
 * One folded `command/run` + `command/done` pair. The header is the flow row every other command uses (shimmering
 * while the command runs); a side question's text is quoted under it, and the host's Markdown follows at its
 * natural height, so a long answer is read in place instead of inside Chat's 260px raw-text box.
 */
export function AcpCommandRow({ node, t, presentation }: AcpCommandRowProps): ReactNode {
  const view = commandRowView(node, presentation)
  const labels = useMemo(
    (): MarkdownLabels => ({
      code: {
        copyLabel: t('activity.copy'),
        copiedLabel: t('activity.copied'),
        toolbarLabels: {
          codeLabel: t('activity.code'),
          wrapLabel: t('activity.wrap'),
          unwrapLabel: t('activity.unwrap'),
        },
      },
      footnotes: t('acpQuestionFootnotes'),
    }),
    [t],
  )
  const status = statusLabel(view, presentation, t)
  return h(
    'div',
    {
      className: css.root,
      'data-acp-command': node.name ?? undefined,
      'data-state': view.state,
      'aria-busy': view.state === 'running' ? true : undefined,
    },
    h(DisclosureRow, {
      titleClassName: css.title,
      icon: h(presentation === 'answer' ? IconQuestionOutlineRegular : IconApiOutlineRegular),
      title: view.title,
      open: false,
      expandable: false,
      onToggle: noToggle,
      running: view.state === 'running',
      collapsedContent:
        status === undefined
          ? undefined
          : h(
              'span',
              { className: css.status },
              h('span', { className: css.separator, 'data-shimmer-decoration': true, 'aria-hidden': true }),
              h(TextShimmer, null, status),
            ),
    }),
    view.question === '' ? null : h('blockquote', { className: css.question }, view.question),
    commandRowBody(view, presentation, labels, t),
  )
}

/** A renderer another plugin registers for the same command wins (the lowest priority renders) instead of colliding. */
const COMMAND_ROW_PRIORITY = 10

/**
 * Register the rows by command name; the keyed slot has no wildcard. Every other command keeps Chat's generic card.
 */
export function installCommandRows(ctx: Context): void {
  for (const [names, presentation] of [
    [SIDE_ANSWER_COMMANDS, 'answer'],
    [COMMAND_RESULT_COMMANDS, 'result'],
  ] as const)
    for (const key of names)
      ctx.slots.inject('conversation.chat.commandview', () =>
        ctx.slots.register(
          {
            name: 'conversation.chat.commandview',
            key,
            priority: COMMAND_ROW_PRIORITY,
            locale: 'acpActivity',
            inject: () => ({ presentation }),
          },
          AcpCommandRow,
        ),
      )
}
