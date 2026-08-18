# dsh-client-ui-rollout

English | [中文](README.zh.md)

Web surface of the TokenRouter rollout feature (host logic lives in `@deepseek-ai/dsh-tokenrouter-rollout`): the composer rollout button, the settings page, and the session-details stats footer.

## Slots

| Slot | Contribution | Notes |
|---|---|---|
| `conversation.input.right` | Rollout button (`id: rollout`) | Executes `/rollout` through the command channel; disabled while the settings namespace says `enabled: false`. |
| `settings.section` | Rollout settings page (`id: rollout`) | Master switch (default off), judge endpoint, round size, judge model, worker pool, milestone auto-trigger. |
| `conversation.details.footer` | Rollout stats (`id: rollout-stats`) | Reads the `rolloutStats` projection; renders nothing before the first rollout. |

The `conversation.details.footer` seat is declared by `@deepseek-ai/dsh-client-ui-conversation`'s DetailsPanel (this package's dependency) — a per-session readout under the selected-call body.

## Settings namespace

`tokenrouter-rollout` — the same namespace the host plugin's `installSettingsSection` registers. The button reads `enabled`; the settings page writes `enabled`, `rolloutCount`, `judgeModel`, `judgeBaseURL`, `workerModels`, and `autoMilestone`.

`judgeBaseURL` is the one field a deployment cannot omit before enabling rollout: the shipped composition carries no judge endpoint, so this page is where a user supplies their own OpenAI-compatible URL. An enabled namespace with an empty endpoint makes the host refuse the round with a message instead of spawning workers.

## Model Experience

Indirectly, through the `/rollout` command and the `tokenrouter-rollout` settings namespace this page writes; `@deepseek-ai/dsh-tokenrouter-rollout` owns the round, its session events, and the steered winning plan.

#### KV Cache effect

Independent: this package makes no model request and appends no session event. The winning plan the host steers in is an ordinary appended user message, so the prefix the model already cached stays reusable.

## Known Limitations and Deferred Work

- **Button state is a snapshot read at inject time** — a settings change in another tab re-registers the contribution through the ledger, but a live toggle in the settings page does not re-render the composer button until the contribution re-injects; the settings page itself always shows current state.
- **The button does not surface a missing judge endpoint** — it enables as soon as `enabled` is true, and the refusal message arrives only after the user presses it; a pre-flight disabled state keyed on `judgeBaseURL` is deferred work.
- **Stats footer is a whole-session readout** — per-round detail (each round's scores and winner) is deferred; the projection currently exposes only aggregates.
