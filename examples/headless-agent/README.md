# headless-agent

English | [中文](README.zh.md)

This directory owns the replay and real-model test composition for a headless coding agent: DeepSeek V4 + local bash and filesystem tools + subagent delegation + workflows and fresh-agent Ralph iteration + `todo_write` + JSONL persistence. It explicitly mounts the shared agent spine, one root agent, persistence, and checkpoint policy; it is not a second product entry point.

## Run it

```sh
# repo root .env (gitignored) or exported env:
#   DEEPSEEK_API_KEY=sk-…
#   DEEPSEEK_BASE_URL=https://…   # optional; defaults to the public API
pnpm dsh --profile headless "fix the failing test in this workspace"
```

The product command is [`dsh --profile headless`](../../apps/cli/README.md): it accepts one nonblank task, creates and persists a fresh session, prints the final assistant text, and exits.

Snapshot suites run this directory's configuration through [`tests/fixtures/headless-driver.ts`](tests/fixtures/headless-driver.ts), an unexported test-only process that emits canonical session events as JSONL before its result record. That stream is test infrastructure, not a supported CLI output format. Child sessions surface only through parent tool events and results.

## E2B POC overlay

[`e2b.cordis.yml`](e2b.cordis.yml) replaces the local filesystem and subprocess providers with one shared E2B sandbox while retaining `dsh-bash-local` and the same model-facing tools. Put `E2B_API_KEY` beside `DEEPSEEK_API_KEY` in the gitignored root `.env`, then run the credential-gated live composition, which drives FS, Bash, PTY, and LSP in one sandbox and proves final deletion:

```sh
pnpm exec vitest run --config vitest.e2e.config.ts packages/e2b/e2b/tests/composition.e2e.ts
```

The overlay creates the same absolute cwd inside the sandbox, but it does not upload or mount the host workspace. File and Bash mutations exist only in E2B; Cordis, model calls, agent/session state, session logs, skills, and SDK buffers remain on the host. The composition kills its sandbox on timeout and disposal. It is a provider-composition POC, not a whole-harness migration or a workspace-sync feature.

## Multimodal over an aggregating gateway

[`tokenrouter-vision.cordis.yml`](tokenrouter-vision.cordis.yml) routes the agent through pi-ai to a gateway that multiplexes one OpenAI-compatible endpoint over many vendors, so images reach a vision model instead of the direct DeepSeek adapter:

```sh
DSH_TOKENROUTER_API_KEY=… node --import tsx/esm tests/fixtures/headless-driver.ts \
  tokenrouter-vision.cordis.yml "read_image ./shot.png and describe it"
```

Because the gateway hides the vendor behind the URL, every wire fact pi-ai would otherwise infer is declared, and each model states its own `input` modalities. Those lists record verified behavior: several routes accept an image part, return HTTP 200, and answer from the text alone. `deepseek-v3.2` is declared `[text]` for that reason, which makes `read_image` refuse up front rather than let the model describe an image it never received. The [Agent Note](../../.agents/notes/implemented/feature/2026-08-20-tokenrouter-declared-modality.md) owns the rationale.

## Advanced configuration

[`advanced.cordis.yml`](advanced.cordis.yml) adds Code Mode and the Cordis tools to the test composition.
