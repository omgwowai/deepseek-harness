# Route images through an aggregating gateway

English | [中文](tokenrouter-vision.zh.md)

This overlay sends one `dsh` process to a gateway that multiplexes a single OpenAI-compatible endpoint over many vendors, so image input reaches a vision model instead of the direct DeepSeek adapter:

```sh
DSH_TOKENROUTER_API_KEY=… dsh --profile headless \
  --patch apps/cli/config/examples/tokenrouter-vision/cordis.yml \
  "read_image ./shot.png and describe it"
```

The shipped composition already mounts the pi-ai adapter dormant and the durable image backend, so the overlay only supplies the provider profile that wakes the route and repoints the default model. The API key stays a reference resolved per request; the overlay never carries a key.

Because the gateway hides each vendor behind one URL, pi-ai's URL-derived detection cannot recognize it and would address it as OpenAI itself. Every wire fact it would otherwise infer is therefore declared: the endpoint, the completions API, `supportsDeveloperRole: false`, `maxTokensField: max_tokens`, and a per-model catalog.

Each model's `input` list records verified behavior, not the advertised capability. Several routes on this gateway accept an image part, return HTTP 200, and answer from the text alone. Declaring those `[text]` is load-bearing: the harness refuses the image up front with `model "<id>" does not declare image input`, which turns a confident wrong answer into a legible refusal. `defaultInput: [text]` keeps an undeclared model blind, so a model added later fails closed.

Model ids matter more than model families here. The gateway serves three DeepSeek V4 Flash ids and only `deepseek-v4-flash-vision-exp` sees; bare `deepseek-v4-flash` and `deepseek-v4-flash-preview` both discard the image. Both siblings are listed as `[text]` rather than omitted, so reaching for the shorter id gets a refusal naming the model instead of a route-default guess.

The [Agent Note](../../../.agents/notes/implemented/feature/2026-08-20-tokenrouter-declared-modality.md) owns the rationale and the probe method.
