---
description: "TokenRouter rollout Web surface for users and maintainers configuring the composer rollout button, the judge endpoint settings page, and the session-details stats footer."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-rollout

English | [中文](README.zh.md)

## Summary

This package gives the Web GUI three rollout surfaces: a composer button that starts a rollout round, a settings page that supplies the judge endpoint and round shape, and a session-details footer that reads the round statistics back. Mount it when a deployment wants users to drive TokenRouter rollout from the GUI instead of typing `/rollout`; the host plugin `@deepseek-ai/dsh-tokenrouter-rollout` still owns the round, its session events, and the steered winning plan. The one field a deployment cannot skip is `judgeBaseURL` — no shipped composition carries a judge endpoint, so this settings page is where a user supplies their own OpenAI-compatible URL. The surfaces are read-and-dispatch only: they append no session event and make no model request of their own.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin alongside `ui-conversation`, `ui-chat`, `ui-settings`, and the host `dsh-tokenrouter-rollout`; the three surfaces then occupy their seats, and a user turns rollout on and points it at a judge from the settings page.

### When to choose it

Mount it for any Web composition whose users should reach rollout without the command line. Leave it out of headless, ACP, and SDK compositions: they have no slot host, and the `/rollout` command already covers them. The host plugin works with or without this package; this package is useless without it.

### Slots

| Slot | Contribution | Notes |
|---|---|---|
| `conversation.input.right` | Rollout button (`id: rollout`) | Executes `/rollout` through the command channel; disabled while the settings namespace says `enabled: false`. |
| `settings.section` | Rollout settings page (`id: rollout`) | Master switch (default off), judge endpoint, round size, judge model, worker pool, milestone auto-trigger. |
| `conversation.details.footer` | Rollout stats (`id: rollout-stats`) | Reads the `rolloutStats` projection; renders nothing before the first rollout. |

The `conversation.details.footer` seat is declared by `@deepseek-ai/dsh-client-ui-chat`'s details panel — a per-session readout under the selected-call body.

### Settings namespace

`tokenrouter-rollout` — the same namespace the host plugin's `settings.installSection` registers. The button reads `enabled`; the settings page writes `enabled`, `rolloutCount`, `judgeModel`, `judgeBaseURL`, `workerModels`, and `autoMilestone`.

`judgeBaseURL` is the one field a deployment cannot omit before enabling rollout: the shipped composition carries no judge endpoint, so this page is where a user supplies their own OpenAI-compatible URL. An enabled namespace with an empty endpoint makes the host refuse the round with a message instead of spawning workers.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One `settingsScope` binding on the `tokenrouter-rollout` namespace feeds two store handles, because a slot handle pins to one scope and the button is session-scoped while the settings page is root-scoped. The scope subscription mirrors each new snapshot into whichever handles have injected, and each handle also adopts the current snapshot at inject time, so no update is lost between subscribe and first inject. A revision guard drops repeat snapshots.

The button's injected face carries one verb, `run`, which dispatches `/rollout` through `ctx.remote.commands.execute` and maps an admission failure to a user-visible line. The settings page's face carries `set` and `unset`, both writing straight through the scope so the host applies them live. The stats footer takes no injected face at all: it reads the `rolloutStats` projection through the session standard kit's `useProjection` and returns `null` while no rollout has run.

| File | Role |
|---|---|
| `src/client/index.ts` | Plugin body: locale registration, scope mirror, three slot registrations. |
| `src/client/RolloutButton.tsx` | Composer button. |
| `src/client/RolloutSettings.tsx` | Settings page. |
| `src/client/RolloutStatsPanel.tsx` | Session-details stats readout. |
| `src/client/settings-store.ts` | The shared draft store and its defaults. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the Web surface is not enough. They move from the surfaces to the host domain and the slot hosts.

- [dsh-tokenrouter-rollout](../../extensions/tokenrouter-rollout/README.md) — owns the round, the judge, the settings namespace, and the `rolloutStats` projection.
- [ui-chat](../ui-chat/README.md) — declares the `conversation.details.footer` seat this package's stats panel fills.
- [ui-conversation](../ui-conversation/README.md) — declares the composer's `conversation.input.right` seat.
- [ui-settings](../ui-settings/README.md) — declares the `settings.section` seat and owns the settings page shell.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the `/rollout` command and the `tokenrouter-rollout` settings namespace this page writes; `@deepseek-ai/dsh-tokenrouter-rollout` owns the round, its session events, and the steered winning plan.

#### KV Cache effect

Independent: this package makes no model request and appends no session event. The winning plan the host steers in is an ordinary appended user message, so the prefix the model already cached stays reusable.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current rollout surfaces. They are current package constraints, not a rollout-feature comparison or a task backlog.

- **Button state is a snapshot read at inject time** — a settings change in another tab re-registers the contribution through the ledger, but a live toggle in the settings page does not re-render the composer button until the contribution re-injects; the settings page itself always shows current state.
- **The button does not surface a missing judge endpoint** — it enables as soon as `enabled` is true, and the refusal message arrives only after the user presses it; a pre-flight disabled state keyed on `judgeBaseURL` is deferred work.
- **Stats footer is a whole-session readout** — per-round detail (each round's scores and winner) is deferred; the projection currently exposes only aggregates.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
