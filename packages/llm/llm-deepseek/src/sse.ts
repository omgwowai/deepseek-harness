/**
 * Decode an SSE byte stream into event `data` payloads. Framing — chunk
 * reassembly, UTF-8/CRLF/BOM handling, comment and non-data field skipping,
 * multi-`data:` joining — is `eventsource-parser`'s. Comments are reported
 * only through an optional transport-activity callback. This module keeps the
 * DeepSeek protocol: the literal `[DONE]` is yielded so the caller owns final
 * flushing, and EOF before it raises {@link LlmError}.
 *
 * Framing is spec-strict for payload events: one dispatches only on its
 * blank-line terminator, so an unterminated tail at EOF is truncation. The
 * closing sentinel is the single exception — a `data: [DONE]` line closed by
 * EOF instead of a blank line is accepted, because some OpenAI-compatible
 * gateways end the stream that way and the sentinel carries no payload to
 * truncate. Its whole content is the terminator, so EOF cannot have cut it
 * short without leaving a different tail, which still raises.
 *
 * @module dsh-llm-deepseek/sse
 */

import { EventSourceParserStream } from 'eventsource-parser/stream'
import { LlmError } from '@deepseek-ai/dsh-llm'

/** The terminal payload DeepSeek (and OpenAI) send after the last chunk. */
export const DONE = '[DONE]'

/** Blank-line event terminators, in the three line endings the SSE grammar allows. */
const EVENT_TERMINATORS = ['\r\n\r\n', '\n\n', '\r\r']

/** A lone `data: [DONE]` line, optionally closed by one line ending. */
const UNTERMINATED_DONE = /^data:[ \t]?\[DONE\](?:\r\n|\n|\r)?$/

/** The text following the last complete event terminator — what EOF left unterminated. */
function trailingSegment(text: string): string {
  const cut = EVENT_TERMINATORS
    .map(terminator => ({ at: text.lastIndexOf(terminator), length: terminator.length }))
    .filter(found => found.at !== -1)
    .reduce<{ at: number; length: number } | undefined>(
      (best, found) => best === undefined || found.at + found.length > best.at + best.length ? found : best,
      undefined,
    )
  return cut === undefined ? text : text.slice(cut.at + cut.length)
}

/**
 * Retain the unterminated tail while passing decoded text through untouched.
 * `eventsource-parser` drops it, and only the raw text says whether EOF cut an
 * event short or closed the sentinel line.
 * @param tail - single-element holder receiving the trailing segment.
 * @returns a pass-through transform over the decoded text.
 */
function retainTail(tail: { text: string }): TransformStream<string, string> {
  return new TransformStream<string, string>({
    transform(chunk, controller) {
      tail.text = trailingSegment(tail.text + chunk)
      controller.enqueue(chunk)
    },
  })
}

/**
 * Parse an SSE byte stream into data payloads. Yields `[DONE]` as the final
 * value and returns; throws `LlmError('STREAM_CLOSED')` when the stream ends
 * without it (truncated response — the model call cannot be trusted).
 * @param stream - raw SSE bytes; reads may split anywhere, including mid-UTF-8 sequence.
 * @param onComment - optional transport-activity callback; comments never enter the yielded payload stream.
 * @returns each event's data payload in arrival order, the `[DONE]` sentinel last.
 */
export async function* parseSse(
  stream: ReadableStream<BufferSource>,
  onComment?: (comment: string) => void,
): AsyncGenerator<string> {
  const tail = { text: '' }
  const events = stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(retainTail(tail))
    .pipeThrough(new EventSourceParserStream({ onComment }))
  for await (const { data } of events) {
    yield data
    if (data === DONE) return
  }
  if (UNTERMINATED_DONE.test(tail.text)) {
    yield DONE
    return
  }
  throw new LlmError('SSE stream ended without [DONE]', 'STREAM_CLOSED')
}
