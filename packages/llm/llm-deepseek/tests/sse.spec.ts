import { describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { DONE, parseSse } from '../src/sse.ts'

/**
 * DeepSeek protocol contract only: the [DONE] sentinel and STREAM_CLOSED on
 * EOF without it. SSE framing (chunk splits, CRLF, multi-data joins, comments)
 * is eventsource-parser's contract, not re-proven here.
 */

/** Build an SSE byte stream from string fragments (fragments = network reads). */
function bytes(...fragments: string[]): ReadableStream<Uint8Array<ArrayBuffer>> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const fragment of fragments) controller.enqueue(encoder.encode(fragment))
      controller.close()
    },
  })
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = []
  for await (const item of stream) out.push(item)
  return out
}

describe('parseSse', () => {
  it('yields event payloads and the DONE sentinel', async () => {
    const events = await collect(parseSse(bytes('data: {"a":1}\n\ndata: [DONE]\n\n')))
    expect(events).toEqual(['{"a":1}', DONE])
  })

  it('reports comments out of band without yielding them', async () => {
    const comments: string[] = []
    const events = await collect(parseSse(
      bytes(': keep-alive\n\ndata: {"a":1}\n\ndata: [DONE]\n\n'),
      (comment) => { comments.push(comment) },
    ))
    expect(comments).toEqual(['keep-alive'])
    expect(events).toEqual(['{"a":1}', DONE])
  })

  it('stops yielding after DONE even when more data follows', async () => {
    const events = await collect(parseSse(bytes('data: [DONE]\n\ndata: {"late":1}\n\n')))
    expect(events).toEqual([DONE])
  })

  it('throws STREAM_CLOSED when the stream ends without DONE', async () => {
    await expect(collect(parseSse(bytes('data: {"a":1}\n\n')))).rejects.toThrow(LlmError)
    await expect(collect(parseSse(bytes('data: {"a":1}\n\n')))).rejects.toThrow(/without \[DONE\]/)
  })

  it('throws STREAM_CLOSED for an empty stream', async () => {
    await expect(collect(parseSse(bytes()))).rejects.toThrow(/without \[DONE\]/)
  })

  it('throws STREAM_CLOSED for a mid-event close', async () => {
    await expect(collect(parseSse(bytes('data: {"a"')))).rejects.toThrow(/without \[DONE\]/)
  })

  it.each([
    ['no line ending', 'data: {"a":1}\n\ndata: [DONE]'],
    ['one LF', 'data: {"a":1}\n\ndata: [DONE]\n'],
    ['one CRLF', 'data: {"a":1}\r\n\r\ndata: [DONE]\r\n'],
    ['no space after the field name', 'data: {"a":1}\n\ndata:[DONE]\n'],
    ['the only event in the stream', 'data: [DONE]\n'],
  ])('accepts a closing DONE that EOF terminated instead of a blank line: %s', async (_label, body) => {
    // Some OpenAI-compatible gateways close the stream on the sentinel line
    // itself. The sentinel carries no payload, so EOF cannot have truncated it
    // without leaving a different tail.
    expect(await collect(parseSse(bytes(body)))).toContain(DONE)
  })

  it('measures the tail from the last terminator when line endings are mixed', async () => {
    // The CRLF blank line is the last terminator even though the LF one is
    // listed after it; only text past the latest match is the unterminated tail.
    expect(await collect(parseSse(bytes('data: {"a":1}\n\ndata: {"b":2}\r\n\r\ndata: [DONE]\n'))))
      .toEqual(['{"a":1}', '{"b":2}', DONE])
  })

  it('splits the closing DONE across reads and still accepts it', async () => {
    expect(await collect(parseSse(bytes('data: {"a":1}\n\ndat', 'a: [DO', 'NE]\n')))).toEqual(['{"a":1}', DONE])
  })

  it.each([
    ['a truncated data payload', 'data: {"a":1}\n\ndata: {"b"'],
    ['a partially written sentinel', 'data: {"a":1}\n\ndata: [DON'],
    ['a sentinel trailing other unterminated text', 'data: {"a":1}\n\ndata: [DONE] extra'],
    ['a sentinel followed by an unterminated event', 'data: [DONE] \n\ndata: {"b"'],
  ])('still reports %s as truncation', async (_label, body) => {
    await expect(collect(parseSse(bytes(body)))).rejects.toThrow(/without \[DONE\]/)
  })
})
