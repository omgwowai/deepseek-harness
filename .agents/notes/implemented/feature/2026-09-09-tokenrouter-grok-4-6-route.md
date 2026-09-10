# Agent Note: Grok 4.6 on the tokenrouter route, over TLS

Status: implemented

English | [中文](2026-09-09-tokenrouter-grok-4-6-route.zh.md)

## Problem

The tokenrouter overlay reached the gateway at `http://tokenrouter.omgwow.tech:8081/v1`, which carries the per-request bearer credential in cleartext. The gateway now answers on `https://tokenrouter.omgwow.tech/v1`, and it serves `xai.grok-4.6` — a vision-capable route the overlay did not offer, so an image-carrying session had to fall back to the DeepSeek V4 Flash experimental id.

Adding the model is not a matter of copying advertised capability. [The declared-modality note](2026-08-20-tokenrouter-declared-modality.md) established why: this gateway answers HTTP 200 to an image part it discards, so `input` is a verified claim and never an inference. Reasoning is the same kind of claim — pi-ai's `reasoningEfforts` map spells each level's wire value, and a level the backend rejects turns a routine request into a hard failure rather than a degraded one.

## Decision

`apps/cli/config/examples/tokenrouter-vision/cordis.yml` repoints `baseURL` to the TLS origin and adds `xai.grok-4.6`. Both facts were probed against the live gateway on 2026-09-09.

The origin swap is behavior-preserving for this composition: the TLS endpoint returned the same 83-model list as `:8081`, containing every model the overlay declares. The endpoint is what changed, not the catalog.

`input: [text, image]` records three separate probes with unguessable four-quadrant PNGs — red/green/blue/yellow, purple/yellow/green/orange, orange/blue/red/purple — each answered in the correct order, each billed `image_tokens: 66`. The token count is the load-bearing half: it distinguishes an image the backend read from one it accepted and dropped, which is the failure this composition exists to prevent. A single-color probe would not, since a blind model can guess one color.

`contextWindow: 500000` is a probed ceiling, not a catalog figure. The backend names it in the rejection — `This model's maximum prompt length is 500000 but the request contains 500213 tokens` — and 499k tokens were accepted, so the boundary is observed from both sides. This is the opposite of the V4 Flash entry beside it, whose gateway enforces no limit and whose figure therefore comes from pi-ai's catalog.

`reasoningEfforts` omits `off` because the model cannot stop reasoning: the backend rejects `reasoning_effort` values `none`, `off`, and `disabled` with HTTP 400. Omission is the accurate encoding — `catalog.ts` allows `off` to carry no wire value only as a valueless key, and declaring one anyway would map a level the endpoint refuses. `max` is rejected too and is likewise absent; `minimal`, `low`, `medium`, `high`, and `xhigh` were each accepted, and reasoning token counts rose with the level on a combinatorics prompt. The model always emits `reasoning_content`, so the map claims a reasoning model with five reachable levels rather than a controllable on/off.

The model is added to the catalog but is not made `agent-default-model`. The overlay's default stays the cheap V4 Flash vision route. The CLI has no model flag, so reaching Grok 4.6 means repointing `agent-default-model` through a second `--patch` overlay, which is what the guide shows.

## Consequences

An image-carrying session on this gateway now has a second verified vision route, on a 500k context, without changing what a default run costs. The credential stops crossing the network in cleartext.

The cost is the one the declared-modality note already names, extended by one entry: `input`, `contextWindow`, and every reasoning level are hand-maintained claims about a gateway that reports no capability. A vendor swap behind the stable `xai.grok-4.6` id can invalidate them silently, and only a re-probe detects it. The reasoning map is the more brittle half — a backend that later accepts `off` merely leaves a level unreachable, but one that stops accepting `xhigh` turns a working configuration into HTTP 400 on every request that selects it.

## Alternatives considered

- **Declare `reasoningEfforts.off` anyway, for symmetry with the V4 Flash entry beside it.** The two models differ in exactly this respect: V4 Flash's `thinking: {type: disabled}` verifiably zeroes `reasoning_content`, while Grok 4.6 rejects every spelling of the request. Symmetry here would encode a capability the endpoint refuses.
- **Trust xAI's published context window instead of probing.** The gateway is not xAI; it multiplexes vendors behind one URL and may impose its own bound. The rejection message states the bound this route actually enforces, which is the only figure the harness can act on.
- **Make Grok 4.6 the default agent model.** It is the stronger route, but the overlay's purpose is a cheap default with vision available, and the fork's other work depends on that cost profile. A flag reaches it without repricing every run.
- **Keep the `:8081` origin and add the model separately.** The two changes touch the same six lines of one file and were verified in one probe session against one endpoint; splitting them would land a model entry verified against an origin the composition no longer uses.
