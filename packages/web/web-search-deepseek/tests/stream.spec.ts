/**
 * Reassembly of an Anthropic Messages event stream into a search response. The
 * gateway behavior this covers: results and citation excerpts arrive only on
 * the stream, so a search that reads the single-shot body reports no sources.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeepSeekSearchProvider } from '@deepseek-ai/dsh-web-search-deepseek'
import type { DeepSeekSearchProviderOptions } from '@deepseek-ai/dsh-web-search-deepseek'
import { readAnthropicStream } from '../src/stream.ts'

const streamOptions: DeepSeekSearchProviderOptions = {
  apiKey: 'ds-key',
  baseURL: 'https://api.deepseek.test/anthropic/v1',
  model: 'deepseek-chat',
  apiVersion: '2023-06-01',
  maxTokens: 4096,
  maxUses: 5,
  stream: true,
}

/** Serialize events as an SSE body, one `data:` frame each. */
function sse(...events: unknown[]): Response {
  const text = events.map(event => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join('')
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** The JSON body one dispatch carried; the provider always sends a string. */
function sentBody(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(init?.body as string) as Record<string, unknown>
}

/** The frames a gateway sends for one search that found two pages. */
const SEARCH_EVENTS = [
  { type: 'message_start', message: { id: 'msg_1' } },
  { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', name: 'web_search' } },
  {
    type: 'content_block_start',
    index: 1,
    content_block: {
      type: 'web_search_tool_result',
      content: [
        { type: 'web_search_result', url: 'https://a.test', title: 'A', page_age: '2026-02-02' },
        { type: 'web_search_result', url: 'https://b.test', title: 'B' },
      ],
    },
  },
  { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
  {
    type: 'content_block_delta',
    index: 2,
    delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://a.test', cited_text: 'excerpt for A' } },
  },
  { type: 'content_block_stop', index: 2 },
  { type: 'message_stop' },
]

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readAnthropicStream', () => {
  it('reassembles result blocks and citations in index order', async () => {
    const payload = await readAnthropicStream(sse(...SEARCH_EVENTS))

    expect(payload.content).toEqual([
      {
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result', url: 'https://a.test', title: 'A', page_age: '2026-02-02' },
          { type: 'web_search_result', url: 'https://b.test', title: 'B' },
        ],
      },
      {
        type: 'text',
        text: '',
        citations: [{ type: 'web_search_result_location', url: 'https://a.test', cited_text: 'excerpt for A' }],
      },
    ])
  })

  it('orders blocks by index, not by arrival', async () => {
    const payload = await readAnthropicStream(sse(
      { type: 'content_block_start', index: 3, content_block: { type: 'text', text: 'later' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'earlier' } },
    ))

    expect(payload.content?.map(block => (block as { text?: string }).text)).toEqual(['earlier', 'later'])
  })

  it('appends every citation delta to its own block', async () => {
    const payload = await readAnthropicStream(sse(
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', citation: { url: 'https://a.test', cited_text: 'one' } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', citation: { url: 'https://b.test', cited_text: 'two' } } },
    ))

    expect((payload.content?.[0] as { citations?: unknown[] }).citations).toEqual([
      { url: 'https://a.test', cited_text: 'one' },
      { url: 'https://b.test', cited_text: 'two' },
    ])
  })

  it('does not mutate the event payload it was handed', async () => {
    const started = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
    const payload = await readAnthropicStream(sse(
      started,
      { type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', citation: { url: 'https://a.test', cited_text: 'one' } } },
    ))

    expect(started.content_block).not.toHaveProperty('citations')
    expect(payload.content?.[0]).toHaveProperty('citations')
  })

  it.each([
    ['a text delta carrying no citation', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'prose' } }],
    ['a delta for a block that never started', { type: 'content_block_delta', index: 7, delta: { type: 'citations_delta', citation: { url: 'https://x.test', cited_text: 'x' } } }],
    ['a citation delta on a non-text block', { type: 'content_block_delta', index: 1, delta: { type: 'citations_delta', citation: { url: 'https://x.test', cited_text: 'x' } } }],
    ['an event with no index', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }],
    ['a block kind the mapper does not read', { type: 'content_block_start', index: 5, content_block: { type: 'thinking' } }],
  ])('ignores %s', async (_label, extra) => {
    const payload = await readAnthropicStream(sse(
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', content: [] } },
      extra,
    ))

    expect(payload.content).toEqual([
      { type: 'text', text: '' },
      { type: 'web_search_tool_result', content: [] },
    ])
  })

  it('skips an unparseable frame and keeps the surrounding blocks', async () => {
    const body = 'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"kept"}}\n\n'
      + 'data: {not json\n\n'
      + 'data: {"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result","content":[]}}\n\n'
    const payload = await readAnthropicStream(
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    )

    expect(payload.content).toEqual([
      { type: 'text', text: 'kept' },
      { type: 'web_search_tool_result', content: [] },
    ])
  })

  it('reassembles frames split across chunk boundaries', async () => {
    const text = SEARCH_EVENTS.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
    const bytes = new TextEncoder().encode(text)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // Every frame is cut mid-payload, including mid-JSON.
        for (let at = 0; at < bytes.length; at += 7) controller.enqueue(bytes.slice(at, at + 7))
        controller.close()
      },
    })
    const payload = await readAnthropicStream(new Response(body, { status: 200 }))

    expect(payload.content).toHaveLength(2)
    expect(payload.content?.[0]).toMatchObject({ type: 'web_search_tool_result' })
  })

  it('returns no blocks for a stream that carried none', async () => {
    const payload = await readAnthropicStream(sse({ type: 'message_stop' }))

    expect(payload.content).toEqual([])
  })

  it('rejects a response with no body', async () => {
    await expect(readAnthropicStream(new Response(null, { status: 204 })))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })

  it('stops reading and cancels the body once the caller aborts', async () => {
    const controller = new AbortController()
    let cancelled = false
    const delivered: number[] = []
    const body = new ReadableStream<Uint8Array>({
      pull(streamController) {
        delivered.push(delivered.length)
        streamController.enqueue(new TextEncoder().encode(
          `data: {"type":"content_block_start","index":${delivered.length},"content_block":{"type":"text","text":"x"}}\n\n`,
        ))
        controller.abort()
      },
      cancel() {
        cancelled = true
      },
    })

    const payload = await readAnthropicStream(new Response(body, { status: 200 }), controller.signal)

    expect(payload.content).toEqual([])
    expect(cancelled).toBe(true)
  })
})

describe('DeepSeekSearchProvider streaming', () => {
  it('asks for the stream and maps sources the single-shot body would omit', async () => {
    const fetchSpy = vi.fn<typeof fetch>(() => Promise.resolve(sse(...SEARCH_EVENTS)))
    vi.stubGlobal('fetch', fetchSpy)

    const result = await new DeepSeekSearchProvider(() => streamOptions).search({ query: 'q' })

    const init = fetchSpy.mock.calls[0]?.[1]
    expect(sentBody(init)).toMatchObject({ stream: true })
    expect((init?.headers as Record<string, string>).accept).toBe('text/event-stream')
    expect(result.sources).toEqual([
      { url: 'https://a.test', title: 'A', snippet: 'excerpt for A', publishedAt: '2026-02-02' },
      { url: 'https://b.test', title: 'B' },
    ])
  })

  it('omits the stream field and asks for JSON when streaming is off', async () => {
    const fetchSpy = vi.fn<typeof fetch>(() => Promise.resolve(new Response(
      JSON.stringify({ content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://a.test' }] }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )))
    vi.stubGlobal('fetch', fetchSpy)

    await new DeepSeekSearchProvider(() => ({ ...streamOptions, stream: false })).search({ query: 'q' })

    const init = fetchSpy.mock.calls[0]?.[1]
    expect(sentBody(init)).not.toHaveProperty('stream')
    expect((init?.headers as Record<string, string>).accept).toBe('application/json')
  })

  it('records the streamed request body it dispatched', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(sse(...SEARCH_EVENTS))))
    const recorded: unknown[] = []

    await new DeepSeekSearchProvider(() => ({
      ...streamOptions,
      recordRequest: request => recorded.push(request),
    })).search({ query: 'q' })

    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({ body: { stream: true } })
  })

  it('fails a stream that carried no result block, rather than reporting no sources', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(sse(
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'I cannot search.' } },
      { type: 'message_stop' },
    ))))

    await expect(new DeepSeekSearchProvider(() => streamOptions).search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })

  it('reports an abort during the stream as cancellation', async () => {
    const controller = new AbortController()
    const body = new ReadableStream<Uint8Array>({
      pull(streamController) {
        streamController.enqueue(new TextEncoder().encode('data: {"type":"message_start"}\n\n'))
        controller.abort()
      },
    })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(body, { status: 200 }))))

    await expect(new DeepSeekSearchProvider(() => streamOptions).search({ query: 'q' }, controller.signal))
      .rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })
})
