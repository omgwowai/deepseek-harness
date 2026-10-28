/**
 * The one-line label `/rewind` shows for a user message. All three native transports use it, so the list reads the same for Claude
 * Code, Codex and Oh My Pi: what the user wrote, without the context DSH generates around it.
 *
 * `toAcpPrompt` sends a message as `[projection, host instructions, …user text…]`. Each generated block begins and ends with the blank-line
 * `generatedContextSeparator`, and a Host context message that was claimed together with the user's own is fenced by two bare separator
 * blocks. The vendors keep the blocks as sent (Claude's transcript, Codex's `userMessage` content, OMP's `message` content), so the label of a
 * message sent in this process and of the same message read back after a restart come out the same.
 */
import { generatedContextSeparator } from '../../text-block-boundary.ts'

/** The longest label; a longer message is cut with an ellipsis. */
export const CHECKPOINT_LABEL_LIMIT = 90

/** What the label says for a message without any text of its own (an image alone, say). */
const NO_TEXT = '(no text)'

/**
 * The markers Claude Code wraps a typed slash command or shell command in when it writes them to its transcript. They carry the
 * command the user typed, which is what the label shows; any other tag in a message is the user's own text and stays.
 */
const COMMAND_MARKERS = /<\/?(?:command-name|command-message|command-args|bash-input|bash-stdout|bash-stderr|bash-exit-code|local-command-stdout|local-command-caveat)>/g

/** The text of one block: a string, or a `{ type: 'text', text }` entry; `undefined` for anything else (an image, say). */
function blockText(block: unknown): string | undefined {
  if (typeof block === 'string') return block
  if (typeof block !== 'object' || block === null || !('type' in block) || block.type !== 'text') return undefined
  return 'text' in block && typeof block.text === 'string' ? block.text : undefined
}

/**
 * The first words of the context DSH sends around a user's message: the adapter's own blocks (`toAcpPrompt`: the model-context
 * projection and the host instructions) and the context messages DSH claims together with the user's (runtime context, the skill catalog
 * reminder, the time sample). Oh My Pi stores a prompt as its blocks joined by blank lines and trimmed, so the separators no longer mark the
 * generated blocks there; and DSH's time sample reaches every agent as a block of its own, outside any fence.
 */
const GENERATED_SEGMENT =
  /^(?:Complete current DSH model context projection\.|Current host instructions \(|Current runtime context\.|<system-reminder>|Time sampled while preparing turn )/

/**
 * Generated blocks are wrapped in blank lines and joined to their neighbours with another one, so in a joined prompt four or more newlines
 * separate a generated block from the next block, while the user's own paragraphs are separated by two.
 */
const JOINED_BLOCK_BOUNDARY = /\n{4,}/

/**
 * The text of a user message as the user wrote it: the blocks between the generated ones, without the segments that begin like generated
 * context. A message with nothing but generated blocks (or whose own text happens to begin and end with blank lines) is labelled by its last
 * block that has any text, so a message is never anonymous just because DSH generated all of it.
 */
function ownText(blocks: readonly string[]): string {
  const own: string[] = []
  let fenced = false
  for (const block of blocks) {
    if (block === generatedContextSeparator) {
      fenced = !fenced
      continue
    }
    if (fenced || (block.startsWith(generatedContextSeparator) && block.endsWith(generatedContextSeparator))) continue
    for (const segment of block.split(JOINED_BLOCK_BOUNDARY)) {
      const trimmed = segment.trim()
      if (trimmed !== '' && !GENERATED_SEGMENT.test(trimmed)) own.push(trimmed)
    }
  }
  return own.length > 0 ? own.join('\n') : (blocks.findLast((block) => block.trim() !== '') ?? '')
}

/**
 * A one-line label for a user message: `content` is its text (a string), one text block, or the list of blocks it was sent or stored as
 * (`{ type: 'text', text }` entries and plain strings; anything else is ignored). Whitespace is collapsed and a long message is cut at
 * {@link CHECKPOINT_LABEL_LIMIT} characters. A typed slash command that Claude Code's transcript stores in its marker form is shown as
 * the command line the user typed.
 */
export function checkpointLabel(content: unknown): string {
  const blocks: unknown[] = Array.isArray(content) ? content : [content]
  let raw = ownText(blocks.flatMap((block) => blockText(block) ?? []))
  const named = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(raw)
  if (named !== null) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(raw)?.[1]?.trim() ?? ''
    raw = `${named[1] ?? ''} ${args}`
  }
  const line = raw.replace(COMMAND_MARKERS, ' ').replace(/\s+/g, ' ').trim()
  if (line === '') return NO_TEXT
  return line.length <= CHECKPOINT_LABEL_LIMIT ? line : `${line.slice(0, CHECKPOINT_LABEL_LIMIT - 1).trimEnd()}…`
}
