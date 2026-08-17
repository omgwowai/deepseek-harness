# Agent Note: Search results delivered only on the event stream

Status: implemented

English | [中文](2026-08-16-search-results-only-on-the-event-stream.zh.md)

## Problem

`dsh-web-search-deepseek` reads its Messages call as one JSON body. Against some Anthropic-compatible gateways that is the wrong read: the gateway runs the server-side search — `usage.server_tool_use.web_search_requests` counts it — but the single-shot response carries a `web_search_tool_result` block with **no `content`** and no citations, while the same request with `stream: true` yields the complete result items and every `citations_delta` excerpt.

The provider's strict mode does find a result block, so it does not fail; it maps zero citeable items and the search returns no sources. The conversation model then reads an empty web where results exist, and nothing in the failure names the transport as the cause. No response field distinguishes this gateway from one that genuinely found nothing, so the provider cannot detect the case.

## Decision

`Config.stream` (default `false`) selects how the response is read. When set, the provider sends `stream: true` with `Accept: text/event-stream`, and `src/stream.ts` reassembles the frames into the same `AnthropicResponse` the single-shot path produces, which `mapAnthropicResponse` then maps unchanged. Strict mode, URL dedup, snippet joining, request logging, and `WEB_ABORTED` cancellation are therefore identical across both modes by construction rather than by parallel implementation.

Reassembly keeps only what the mapper reads: `web_search_tool_result` blocks from `content_block_start`, and `text` blocks with `citations_delta` citations appended in arrival order. Blocks are emitted in index order, not arrival order. Every other event — `message_start`, `text_delta`, `thinking`, `message_stop` — is dropped.

Frame decoding is lenient and the strict check stays in the mapper: an unreadable or unrecognized frame is skipped, because a gateway may interleave frames the Messages event schema does not describe and one bad frame must not discard assembled results. A stream carrying no result block at all still fails, in the mapper, with the existing message.

SSE framing is `eventsource-parser`'s, as in [`dsh-llm-deepseek/sse`](../../../../packages/llm/llm-deepseek/src/sse.ts). That module is not reused directly because it enforces the chat-completions `[DONE]` sentinel, which the Messages stream does not send — it ends at `message_stop`.

The default stays `false` because official DeepSeek returns complete blocks in the single-shot response, and streaming there would only add reassembly. `stream` is a settings-section field like the rest, so it reaches the next search without re-registering the provider.

## Alternatives considered

**Always stream.** One code path, no setting, and it works against both endpoint kinds. Rejected as an unexplained default change for every existing deployment: official DeepSeek needs nothing from it, and it would put reassembly, partial-frame handling, and a longer-lived connection on the path that works today. The `stream` field keeps the change opt-in and reversible per deployment.

**Detect and retry.** Notice a `web_search_tool_result` block with absent or empty `content` and re-issue the search as a stream. Rejected because the signal is ambiguous: a search that genuinely found nothing produces the same body, so the retry fires on every empty result, doubling the cost of a full Messages turn to confirm the emptiness. Nothing on the wire separates the two cases, which is why the mode is a stated fact about the endpoint rather than an inference.

**Scrape URLs from the streamed prose.** The `text` blocks name the pages found. Rejected for the reason the provider has never scraped prose: it fabricates sources the search did not return, and the package's strict mode exists to prevent exactly that.

**Reuse `parseSse` from `dsh-llm-deepseek`.** Rejected on the sentinel: it throws `STREAM_CLOSED` when a stream ends without `[DONE]`, which every Messages stream does. Relaxing it would weaken the truncation check the chat-completions path depends on, and a search package depending on the LLM adapter would contradict this provider's deliberate independence from `ctx.llm`. Both modules share `eventsource-parser`, so no framing logic is duplicated.

## Testing

`tests/stream.spec.ts` covers reassembly (index ordering, multiple citation deltas, no mutation of the handed event, ignored event kinds, an unparseable frame between good ones, frames split every 7 bytes mid-JSON, a missing body, and abort mid-stream cancelling the body) and the provider in streaming mode (the dispatched `stream: true` and `Accept` header, the absent field when off, the logged request, strict-mode failure, and `WEB_ABORTED`).

`tests/settings.spec.ts` adds the real-composition case: `stream` stored in the settings section reaches the next search through `ctx.web.search`, and that search returns mapped sources from a body that carries them only as frames. Per-file coverage for the package is 100% on statements, branches, functions, and lines.

## Consequences

An operator pointing the provider at a gateway must now know one more fact about it. The cost is a wrong `stream` value surfacing as a search that reports no sources — the same symptom the change fixes, in the opposite direction — which the README's Known Limitations names. What it buys is that such a gateway becomes usable at all, through configuration rather than a code change, and that the two modes cannot drift: streaming produces the response body the existing mapper already consumes, so every mapping rule and every test above it applies to both.

Streaming affects only how the response is read. The seam still returns one complete `WebSearchResult` after the stream ends; search does not become incremental, and the tool consumer sees no difference.
