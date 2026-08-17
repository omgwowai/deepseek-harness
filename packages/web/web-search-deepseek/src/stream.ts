/**
 * Reassemble an Anthropic Messages SSE stream into the same response body
 * `mapAnthropicResponse` consumes.
 *
 * Streaming exists here for a wire reason, not a latency one: an
 * Anthropic-compatible gateway may deliver `web_search_tool_result.content` and
 * the `citations_delta` excerpts only on the event stream, answering the
 * single-shot request with a `web_search_tool_result` block whose `content` is
 * absent. A search reading that body then finds a result block with no citeable
 * items and reports no sources. Only the two block kinds the search mapper reads
 * are reassembled — `web_search_tool_result` blocks in full, and `text` blocks
 * for their citations; every other block is dropped.
 *
 * Framing is `eventsource-parser`'s, as in `dsh-llm-deepseek/sse`. That module
 * is not reused directly because it enforces the chat-completions `[DONE]`
 * sentinel, which the Messages stream does not send — it ends at
 * `message_stop`.
 * @module @deepseek-ai/dsh-web-search-deepseek/stream
 */

import { EventSourceParserStream } from 'eventsource-parser/stream'
import { WebError } from '@deepseek-ai/dsh-web'
import type {
  AnthropicResponse,
  ContentBlock,
  StreamEvent,
  TextBlock,
} from './types.ts'

/**
 * Decode one `data:` payload. A malformed payload is skipped rather than fatal:
 * a gateway may interleave frames the Messages event schema does not describe,
 * and one unreadable frame must not discard the blocks already assembled. A
 * stream that yields no result block at all still fails, in the mapper.
 * @param payload - the event's data payload.
 * @returns the decoded event, or `undefined` when it is not usable JSON.
 */
function parseEvent(payload: string): StreamEvent | undefined {
  try {
    return JSON.parse(payload) as StreamEvent
  } catch {
    // Unreadable frame; see this function's contract. Nothing else observes it:
    // the assembled blocks are the only result, and the mapper judges those.
    return undefined
  }
}

/**
 * Apply one decoded event to the blocks assembled so far.
 * @param event - the decoded Messages stream event.
 * @param blocks - index-keyed blocks being assembled, mutated in place.
 */
function applyEvent(event: StreamEvent, blocks: Map<number, ContentBlock>): void {
  const index = event.index
  if (index === undefined) return
  if (event.type === 'content_block_start') {
    const started = event.content_block
    if (started?.type === 'web_search_tool_result' || started?.type === 'text') {
      // Copied, not aliased: `citations_delta` appends into this block, and the
      // event object is not ours to retain.
      blocks.set(index, { ...started })
    }
    return
  }
  const block = blocks.get(index)
  const citation = event.delta?.type === 'citations_delta' ? event.delta.citation : undefined
  if (citation === undefined || block?.type !== 'text') return
  const text = block as TextBlock
  text.citations = [...text.citations ?? [], citation]
}

/**
 * Read an Anthropic Messages SSE body and return the equivalent response.
 * @param response - the streaming HTTP response; its body is consumed.
 * @param signal - abort signal for the surrounding search; abort stops reading and cancels the body.
 * @returns the response reassembled from the stream, blocks in index order.
 * @throws {@link WebError} `WEB_PROVIDER_ERROR` when the response carries no body.
 */
export async function readAnthropicStream(
  response: Response,
  signal?: AbortSignal,
): Promise<AnthropicResponse> {
  const body = response.body
  if (body === null) {
    throw new WebError('DeepSeek search returned no response body', 'WEB_PROVIDER_ERROR')
  }
  const blocks = new Map<number, ContentBlock>()
  const events = body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream())
  // Breaking out of this loop cancels the body, releasing an upstream
  // connection the caller has stopped waiting for.
  for await (const { data } of events) {
    if (signal?.aborted === true) break
    const event = parseEvent(data)
    if (event !== undefined) applyEvent(event, blocks)
  }
  return {
    content: [...blocks.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, block]) => block),
  }
}
