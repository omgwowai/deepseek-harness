# Agent Note: Declared modality for an aggregating gateway

Status: implemented

English | [中文](2026-08-20-tokenrouter-declared-modality.zh.md)

## Problem

rc8 added image input to the pi-ai route and to the [direct DeepSeek adapter](2026-08-20-unified-image-request-pipeline.md), both of which read modality from exact-model metadata. That metadata is trustworthy when one provider owns the endpoint. The tokenrouter gateway breaks the assumption: it multiplexes a single OpenAI-compatible URL over many vendors, so pi-ai's URL-derived detection cannot recognize it and would address it as OpenAI itself, inheriting the wrong compat switches and no usable model list.

The harder problem is that the gateway does not report capability. Requesting a text-only model with an `image_url` part returns HTTP 200 with a fluent answer produced from the text alone — the image is discarded without a warning, an error, or a field to detect it by. `deepseek-v3.2` asked to name four colored quadrants invented a "Color Harmony Wheel" instead. A composition that trusts the endpoint therefore produces confident hallucinations that read exactly like successful vision.

## Decision

`examples/headless-agent/tokenrouter-vision.cordis.yml` composes the gateway as a pi-ai provider whose every wire fact is declared rather than inferred: `api: openai-completions`, an explicit `baseURL`, `compat.supportsDeveloperRole: false` and `compat.maxTokensField: max_tokens`, and a per-model catalog. The credential is a reference (`apiKeyEnv: DSH_TOKENROUTER_API_KEY`), never an inlined key. The overlay disables `llm-deepseek` so the direct adapter does not shadow the route, and inserts `attachment-local`, without which an image-carrying request fails with `UNSUPPORTED_CONTENT`.

Each model's `input` list records the **empirically verified** modality, not the advertised one. Six routes on this key accept an image part and silently drop it; `deepseek-v3.2` is declared `input: [text]` for that reason. Route-level `defaultInput: [text]` keeps an undeclared model blind, so a model added later fails closed.

A 2026-08-27 re-probe added `deepseek-v4-flash-vision-exp` as the composition's default agent model, and it is the case the family-name trap was written for: the gateway serves three V4 Flash ids and only the `-vision-exp` suffix sees. It answered the quadrant order on 3 of 3 attempts, streamed those tokens under SSE, and returned tool calls, while bare `deepseek-v4-flash` and `deepseek-v4-flash-preview` both reasoned that no image was provided. Both siblings are therefore listed explicitly as `input: [text]` rather than omitted, so a reader who reaches for the shorter id gets a refusal naming the model instead of a route-default guess. Its `contextWindow` is pi-ai's own 1,000,000 for the family rather than a probed ceiling: the gateway enforces no limit of its own (900k prompt tokens were accepted, and the next step up failed on a TPM quota, not on length), so no probe can establish one. `maxRequestImageBytes: 12582912` stays under the gateway's body cap, below the 20 MiB default the [request image bound](2026-08-20-unified-image-request-pipeline.md) sets.

Declaring `[text]` is load-bearing, not documentation. The harness refuses the image up front at three independent sites — `read_image`, the MCP tool bridge, and ACP content conversion — with `model "<id>" does not declare image input`. The model never receives an image block and cannot describe one it did not see, which converts a silent wrong answer into a legible refusal.

Verifying such a claim needs an unguessable probe. A single-color image lets a blind model pass by naming a plausible color; the fixture is a four-quadrant PNG whose colors and order are improbable by chance.

## Consequences

Vision works through the gateway with the fork's cheap default route intact, and the composition documents which of its models actually see. The cost is that `input` is a hand-maintained claim: the gateway offers nothing to derive it from, so a vendor swap behind a stable model id can silently invalidate an entry, and only a re-probe detects it. Fail-closed defaulting bounds the damage — a stale `[image]` claim degrades to hallucination, so the list is verified rather than assumed, while a stale `[text]` claim only costs a capability.

This composition also carries the rc8 merge's one behavior fix: rc8 made the image list a required parameter of the remote `commands/execute` envelope, and the fork's rollout button now passes it explicitly.

## Alternatives considered

- **Trust the gateway and declare every model `[text, image]`.** The failure mode is the reason not to. A dropped image yields HTTP 200 and a confident answer, so the harness cannot detect it and neither can the user reading a plausible description of an image the model never received.
- **Probe capability at load.** A start-up image request per model would make the claim self-verifying, but it spends tokens and latency on every boot, needs a fixture the gateway cannot cache-answer, and still fails closed exactly as the declaration does. Modality stays a claim about the endpoint, matching how rc8 treats exact-model metadata everywhere else.
- **Extend the direct `deepseek-official` adapter instead.** It speaks one vendor's protocol and one model-id namespace. The gateway's value is many vendors behind one URL, which is what the configurable pi-ai route already models.
- **Omit the deliberate text-only entry.** Dropping `deepseek-v3.2` would make every listed model a vision model and hide the interesting fact. Keeping it, declared honestly, is what demonstrates the guard rail.
- **Replay the fork's commits onto rc8 rather than merge.** Rebasing across a 1604-file upstream delta re-resolves the same conflicts once per commit. The fork's rc7 sync established the merge pattern, and a merge records both parents so the next sync has a base.
