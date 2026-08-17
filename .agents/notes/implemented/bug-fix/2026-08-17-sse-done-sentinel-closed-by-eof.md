# Agent Note: A closing `[DONE]` terminated by EOF instead of a blank line

Status: implemented

English | [中文](2026-08-17-sse-done-sentinel-closed-by-eof.zh.md)

## Problem

`parseSse` dispatched events spec-strictly: `eventsource-parser` emits an event only when it sees the blank line that terminates it, so a stream whose last bytes are `data: [DONE]\n` — one line ending, no blank line — never yielded the sentinel. The loop drained, and the function raised `STREAM_CLOSED: SSE stream ended without [DONE]` on a response the provider had in fact completed.

Some OpenAI-compatible gateways close the connection on the sentinel line itself. Observed against a gateway route serving `glm-5.3`: every response ended `…[DONE]\n` where the same gateway's DeepSeek routes ended `…[DONE]\n\n`. The failure was total rather than intermittent — five of five captures, including responses that carried a complete tool call and `finish_reason: tool_calls` — so the model was unusable through this adapter even though the bytes on the wire were whole. The symptom named the transport but attributed it to truncation, which is the one thing that had not happened.

The prior behavior was deliberate and tested (`treats a final DONE missing its blank-line terminator as truncation`), resting on the premise that real providers always terminate events. That premise is what the observation falsifies.

## Decision

The sentinel is exempt from blank-line termination; payload events are not. `parseSse` retains the text following the last complete event terminator, and when the generator drains without a dispatched sentinel it accepts the stream if that trailing text is exactly a `data: [DONE]` line, optionally closed by one line ending. Anything else still raises `STREAM_CLOSED`.

The exemption is safe precisely where it is applied. A payload event truncated by EOF is indistinguishable from a complete one, which is why strict framing must keep guarding it. The sentinel carries no payload: its entire content is the terminator, so EOF cannot have cut it short without leaving a tail that fails the match — `data: [DON` and `data: [DONE] extra` both still raise. Truncation of the useful part of the stream therefore remains detectable, and the check's purpose survives.

`retainTail` is a pass-through transform between the decoder and the parser rather than a second parse: `eventsource-parser` discards the unterminated tail, and only the raw decoded text says whether EOF cut an event short or closed the sentinel line. Splitting on all three line endings the SSE grammar allows, and measuring from the latest match, keeps the tail correct for a stream that mixes them.

## Alternatives considered

**Flush the parser's pending buffer at EOF.** Ask `eventsource-parser` for whatever it holds and treat a pending `[DONE]` as dispatched. Rejected because the library exposes no such flush, and adding one upstream would relax framing for every event, not the sentinel — the distinction that makes this safe is exactly the one a general flush erases.

**Drop the `[DONE]` requirement.** Return normally at EOF and let the caller judge completeness from `finish_reason`. Rejected as a real loss of a real signal: the sentinel is how this adapter distinguishes a completed response from a connection dropped mid-answer, and `finish_reason` is absent from precisely the truncated streams the check exists to catch.

**Handle it per model or per gateway.** Gate leniency on a config field naming endpoints that close on the sentinel. Rejected because the operator cannot be expected to know a framing detail of their gateway's SSE writer, the failure gives no clue which value to set, and the lenient path is safe unconditionally — a fact about the sentinel, not about any endpoint.

**Normalize the bytes before parsing.** Append a blank line when the stream ends without one. Rejected as strictly broader: it re-terminates any unterminated tail, so a payload event cut off by EOF would be parsed and delivered as if complete, which is the failure mode the strict check exists to prevent.

## Testing

`tests/sse.spec.ts` covers the accepted forms (no line ending, one LF, one CRLF, no space after the field name, the sentinel as the only event in the stream, and the sentinel split across reads), tail measurement across mixed line endings, and the rejected ones (a truncated payload, a partially written sentinel, a sentinel trailing other unterminated text, and a sentinel followed by an unterminated event). Per-file coverage for `src/sse.ts` is 100% on statements, branches, functions, and lines.

Verified end to end against the live gateway: a `glm-5.3` session that previously died at `STREAM_CLOSED` mid-tool-call now completes a write-then-read tool loop, and a `deepseek-v4-flash` session over the same build is unchanged.

## Consequences

Streams that end on the sentinel line become usable, which is what makes the affected gateway routes usable at all. No configuration accompanies the change: the lenient path is a fact about the sentinel rather than about a deployment, so nothing new has to be known or set.

The truncation guard narrows by exactly one case, and that case cannot hide data loss. What was one condition — a dispatched `[DONE]` — is now two paths to the same conclusion, so the module owns a small amount of framing knowledge (`EVENT_TERMINATORS`) that previously lived entirely in the parser. That knowledge is confined to measuring the trailing segment; event framing itself is still `eventsource-parser`'s.
