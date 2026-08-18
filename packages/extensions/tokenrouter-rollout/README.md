# dsh-tokenrouter-rollout

English | [中文](README.zh.md)

Decision-point rollout with a SOTA judge. At decision boundaries (a `/rollout` command, or a completed milestone with a next one pending), the plugin runs N parallel diverse trajectories on the cheap worker model — the deepseek route dsh already chose — and lets a SOTA judge model (`claude-opus-5` by default, validated alternatives include `gpt-5.6-sol`) score the plans and pick the winner. The winning plan is steered back into the agent's session as the working decision, so SOTA tokens are spent only on review, not on generation.

The judge endpoint is not shipped: `judgeBaseURL` has no default, and an enabled plugin without one fails at load (composition) or refuses the round with a message (settings). Point it at any OpenAI-compatible gateway.

## Service

`ctx.tokenRouterRollout` — one `TokenRouterRollout` service owning the round lifetime.

| Member | Purpose |
|---|---|
| `config` | Effective config (settings-folded). |
| `roundSignal` | Cancellation shared by detached rounds; aborts when the plugin unloads. |
| `runRound(agent, trigger, decision, signal)` | Run one round: parallel workers → judge → steer winner. |

A round outlives the turn that asked for it, so both triggers pass `roundSignal` rather than the caller's signal — a UI request's signal aborts when its response closes, which is before the first worker has answered.

## Events

| Session event | Payload | When |
|---|---|---|
| `rollout/start` | `{ trigger, decision, count }` | A round opened. |
| `rollout/trajectory` | `{ index, provider, model, slot, summary, ok, outputTokens? }` | One worker settled. |
| `rollout/selected` | `{ best, judgeModel, scores[], judgeOutputTokens? }` | The judge picked a winner. |
| `rollout/error` | `{ trigger, reason }` | The round failed before selection. |

## Projection

`rolloutStats` (registered through the session-projection seam when composed): whole-log rounds, trajectories, winner scores, and worker/judge token figures — the data behind the session-details stats panel.

## Extension points

- `ctx.commands` `/rollout` — manual trigger (UI button and slash command).
- `session/event` `todo/write` — milestone boundary detection (auto trigger when a completed milestone leaves a pending next one). The feed is global, so the watcher ignores sessions whose header records `origin: 'subagent'`; without that a round's own workers would spawn further rounds.

## Configuration

All fields optional except `judgeBaseURL` once enabled; the plugin is inert while `enabled: false`.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch. |
| `rolloutCount` | `3` | Parallel trajectories per round. |
| `judgeModel` | `claude-opus-5` | SOTA judge model id on the endpoint. |
| `judgeBaseURL` | none (required while enabled) | OpenAI-compatible judge endpoint. |
| `judgeApiKeyEnv` | `DEEPSEEK_API_KEY` | Judge key environment variable. |
| `workerProvider` | `deepseek-official` | Worker provider route. |
| `workerSubagentProvider` | `fork` | Subagent provider running the workers. |
| `workerModels` | `[]` | Worker model pool; empty = the agent's own model. |
| `diversitySlots` | conservative / thorough / creative | Per-trajectory prompt strategies. |
| `workerTimeoutMs` | `600000` | Per-worker timeout. |
| `judgeTimeoutMs` | `180000` | Judge call timeout. |
| `maxPlanChars` | `12000` | Per-plan judge input cap. |
| `autoMilestone` | `false` | Auto-trigger on milestone completion. |
| `maxContextChars` | `4000` | Decision context cap. |
| `judgeSystemPrompt` | built-in | Judge prompt override. |

Diversity is prompt-level. A child is routed through `AgentOptions`, which carries provider, model, and token cap but no sampling scalars, so a slot varies what the worker is asked to do rather than how the sampler behaves.

The settings section (`tokenrouter-rollout`) owns `enabled`, `rolloutCount`, `judgeModel`, `judgeBaseURL`, `workerModels`, and `autoMilestone`. An empty `judgeBaseURL` in the section leaves the composition's value standing, so a deployment that supplies an endpoint is not cleared by a user who never set one.

## Model Experience

### Worker planning prompt (per trajectory)

#### What the model sees

Each worker subagent receives the literal below with `{context}` replaced by the decision context, truncated to `maxContextChars`. A diversity slot with a strategy appends `\n\nSTRATEGY GUIDANCE: <strategy>`. A milestone-triggered context additionally carries the last three assistant text outputs, capped at 600 characters, under a `RECENT WORK TRAIL (for context):` heading.

##### Verbatim worker prompt

```markdown
You are one of several parallel planning agents working on the same
decision. Produce a COMPLETE, self-contained plan for the decision below, as
markdown starting with a "# " heading that names the plan. Do not ask for
clarification; make reasonable assumptions and state them. End with a short
"## Rationale" section explaining the key trade-offs you chose.

DECISION CONTEXT:
{context}
```

#### Token effect

Conditional and multiplied: one worker run per trajectory (`rolloutCount`, 1–8), each a full subagent turn on the cheap worker route. The prompt itself is fixed; the context is capped at `maxContextChars`.

#### KV Cache effect

Independent: every worker is a separate child request. The `fork` provider seeds each child with the parent's completed-turn history, so workers of one round share that prefix with each other and with the parent, and the differing strategy suffix sits at the end of the prompt.

### Judge scorecard request

#### What the model sees

One request to the configured OpenAI-compatible endpoint per round, outside the harness's own LLM seam. The system prompt is the literal below (`judgeSystemPrompt` replaces it), plus a retry suffix on a second attempt. The user message carries the decision context and the plans of `ok` trajectories only, each truncated to `maxPlanChars`; a failed worker's error detail never reaches the judge.

##### Verbatim judge system prompt

```markdown
You are a senior engineering evaluator. Given a task and candidate plans, score each plan 0-100 on completeness, feasibility, cost, and risk. Respond with STRICT JSON only, no markdown fences, exactly this shape: {"scores":[{"index":0,"score":85,"reasoning":"..."}],"best":0,"summary":"..."}
```

#### Token effect

Fixed at one call per round, retried at most once when the response is not valid JSON. Input is bounded by `rolloutCount × maxPlanChars`; output is a scorecard.

#### KV Cache effect

Independent: the judge call goes to a separate endpoint and shares no prefix with the agent's own requests.

### Steered winning plan

#### What the model sees

After a round settles with a selected plan, the agent receives a user message with two text blocks: a `[rollout] …` narration naming the trajectory count, trigger, judge model, per-trajectory scores, and the winning summary, followed by `## Selected plan` and the winner's full text. Delivery is `steer`, not `inject`: a round takes minutes, so the driver is usually idle by then and injected context would wait for a wake nothing here produces.

#### Token effect

Retained: the narration and the full winning plan stay in the session as an ordinary user message and count toward every later request.

#### KV Cache effect

Append-only: the message lands at the end of the conversation, so the already-cached prefix stays reusable and the next request extends it.

## Known Limitations and Deferred Work

- **A round survives its trigger but not a reload** — rounds are cancelled only by plugin disposal, so a `/rollout` continues after the dispatching UI request closes; there is no way to cancel one round without unloading the plugin, and a round in flight when the process exits is lost.
- **Worker plans are not persisted in full** — only summaries and scores land in the session log; the full winning plan is delivered through the steered user message (which is logged), while losing plans exist only in worker sessions.
- **Single judge with one retry, no ensemble** — a second judge model or majority voting is deferred work; the judge call is the only SOTA-token spend per round, and a double failure degrades to deterministic selection (longest complete plan among `ok` trajectories).
- **Milestone detection keys on `todo/write` status diffs** — a milestone completed by a write that also marks the final todo completed (no pending next) does not trigger, by design; the recent-work-trail context is capped to the last three assistant outputs.
- **Diversity cannot vary sampling** — per-trajectory temperature would need the `agent/request` waterfall on each child; until that exists, slots differ only by prompt strategy.
