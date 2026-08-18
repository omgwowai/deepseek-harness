# Agent Note: A rollout round is owned by the plugin, not by the trigger that opened it

Status: implemented

English | [中文](2026-08-17-rollout-round-owned-by-the-plugin.zh.md)

## Problem

`tokenrouter-rollout` spawns N worker subagents to plan the same decision in parallel, has a SOTA judge score their plans, and delivers the winner back to the agent. A probe of the unshipped extension found that no round it started could reach that outcome, and that several of the failures were invisible from the session log rather than merely broken.

The controlling defect: `runRound` took its cancellation from whatever asked for the round. The `/rollout` command handler returns as soon as workers are spawned, and the UI request's `AbortSignal` aborts when that response closes, so the round's workers were aborted in the same tick they started. Every round settled as `all workers failed; nothing to judge` — observed directly as both worker signals `aborted: true`, both trajectory texts `cancelled`, and zero `dispose` calls for two started runs. A round that survived cancellation would still not have been read: the winning plan was delivered with `agent.inject()`, which appends to the inbox without waking an idle driver, and a round takes minutes, so by the time a plan exists the driver is idle and nothing in the plugin wakes it.

Behind those two, the probe found a round that produced wrong output rather than none. A worker that times out or errors returns its failure detail in the same `text` field a plan uses; the judge scored those strings alongside real plans, so `worker 2 ended with error: …` could win a round and be delivered to the agent as "the working decision". `outputTokens` was declared on `TrajectoryOutcome`, on the `rollout/trajectory` event, and in the stats fold, but nothing ever populated it, so the panel's `workerOutputTokens` was permanently `0` — a measurement absent by omission, displayed as a measurement of zero. `DiversitySlot` carried a `temperature` field that `AgentOptions` has no slot for, so every slot's temperature was dropped and all N trajectories ran identically, which removes the diversity the plugin exists to produce.

Two more defects were reachable in a user's live configuration. `session/event` is a global feed, so a rollout worker's own `todo/write` reached the milestone watcher, and a round spawned off it would have its workers spawn further rounds — unbounded recursion off one completed milestone, with `autoMilestone` a single switch away. And the judge endpoint was a hardcoded host: one operator's internal gateway URL sat in the config schema default, in `DEFAULTS`, and in `cordis.patch.yml`, so every install would have pointed its judge traffic at a host it does not own.

## Decision

A round is an operation of the plugin, and its lifetime, cancellation, and delivery follow from that rather than from the trigger.

Cancellation is a plugin-owned `AbortController` (`this.rounds`), created with the controller and aborted only on disposal. Both triggers pass `roundSignal`; nothing else can cancel a round, which is the cost of having one outlive the request that asked for it. Delivery is `agent.steer()`, not `agent.inject()`: steering opens a turn on an idle driver and is consumed at the nearest step boundary on a running one, which covers both the manual trigger (user waiting, driver idle) and the milestone trigger (driver mid-turn).

The judge scores only `ok` trajectories. `candidates` maps the judge's dense `0..n-1` numbering back to round indexes, so `rollout/selected` and the trajectory log stay aligned with a filtered candidate set; when no candidate survives, the round reports `all workers failed; nothing to judge` instead of selecting a failure string. `outputTokens` is summed from the child session's assistant-message usage and stays **absent** rather than zero when the child is remote or the adapter reports no usage, so the stats fold cannot read a missing measurement as a free trajectory.

The judge endpoint is owned by the deployment and the user, never by the plugin. `judgeBaseURL` has no default; an enabled plugin without one throws at load, and because the settings section can enable rollout after load, `runRound` throws again before spawning workers — refusing there costs the round nothing, while spawning first would burn N worker runs whose plans no judge can score. The settings page carries the field, and emptying it unsets rather than storing `''`, so clearing a user override re-inherits the deployment's value instead of overriding it with emptiness.

Diversity is prompt-level and says so. `temperature` is gone from `DiversitySlot`; a slot varies what the worker is asked to do (`strategy`), not how its sampler behaves, and per-trajectory sampling is recorded as deferred work that would need the `agent/request` waterfall on each child.

## Defects the probe found beyond round ownership

The milestone watcher skips any session whose durable header records `origin: 'subagent'`. The header is the authoritative fact — it is written at child creation and survives a reload — which a spawned-child registry held in the controller would not be. Its `next === undefined` branch (a write that completes a milestone while leaving no pending next) carried no test; it now has a mutation-verified one, and the README records the non-trigger as deliberate rather than as a gap.

`workerSubagentProvider` replaces a hardcoded `'fork'`. The default stays `fork`, which seeds each worker with the parent's completed-turn history, but the route is now a validated config field like every other deployment-varying choice.

Three defects lived in the composer button, and the per-file coverage gate is what exposed them. `aliveRef` had no paired `useEffect` to clear it, so the post-unmount guard on both settlement paths was inert. A `if (!enabled || running) return` guard duplicated the condition that sets `disabled`, so it could never run — dropped, with a comment in its place per the repo's unreachable-guard idiom. And `css.wrap` did not exist in the CSS module, so the `?? ''` fallback fired on every render and the button and its error line had no flex wrapper at all; the class now exists and the fallback is gone.

## Alternatives considered

**Keep the trigger's signal and hold the request open.** Let `/rollout` await the round so its signal stays live. Rejected because it inverts the feature: a round takes minutes, and a command that blocks for minutes cannot be issued from the composer at all, while the milestone trigger has no request to hold open in the first place.

**Deliver with `inject` plus an explicit wake.** Keep inbox semantics and have the plugin nudge the driver after appending. Rejected as two owners for one delivery: the wake would have to know the driver's state to avoid interrupting a running turn, which is exactly the state `steer` already owns. A second waking path in a plugin is a race with the one the loop maintains.

**Let the judge recognize failure text.** Pass every trajectory and instruct the judge to score obvious failures at zero. Rejected because it spends judge tokens on strings that are known non-plans before the call, and because it makes correctness depend on the judge's compliance — a judge that ranks a plausible-looking error message first delivers it as the decision, which is the failure being prevented.

**Ship a default judge endpoint.** Give `judgeBaseURL` the gateway the extension was developed against. Rejected on two independent grounds: the endpoint is a property of the deployment rather than of this plugin, and the specific value is one operator's internal host, which must not be distributed to installs that cannot reach it and should not be told about it.

**Track spawned children instead of reading the header.** Have the controller record the session ids it spawned and filter the feed against that set. Rejected because the set is process-local and empties on reload while the recursion risk does not, and because a child is disposed as soon as its result settles — the watcher would consult a set that no longer contains the session whose event it is judging.

**Thread a per-child `agent/request` waterfall for temperature.** Keep the field and make sampling diversity real. Rejected as a change to the child-request path rather than to this plugin, and out of scope for a defect pass; prompt-level diversity is the mechanism that actually ships, so the field that promised more than it delivered is removed rather than left accepting values it drops.

## Testing

`packages/extensions/tokenrouter-rollout` carries 22 tests at 100% per-file coverage. The milestone watcher is exercised through the composed controller — real agents append real `todo/write` events and the plugin's own watcher decides — with the round observed at `ctx.subagents.start`, the first thing a triggered round does; the recursion and no-pending-next guards are mutation-verified there. `runRollout` covers the filtered candidate set with winners reported in round indexes, per-trajectory child output tokens, and the every-worker-failed path.

`packages/client/ui-rollout` carries 23 tests at 100% per-file coverage, including render tests for all three React surfaces that did not exist before. The button's failure surface is covered for a returned failure line, an `Error` rejection, and a raw-string rejection, and both settlement paths are exercised after unmount. The settings page is covered for the emptied-field unset on `judgeBaseURL` and the worker pool, and the apply-level mirror is covered for adoption at inject time, later writes reaching both store handles, a pre-inject write, and a scope that is still loading.

## Consequences

Rounds now run to completion and their winners reach the agent, which is what makes the extension usable at all. The stats panel reports real worker token spend, and a round can no longer deliver a worker's error message as a plan.

The cost is deliberate and recorded in the README's limitations: because cancellation belongs to the plugin, a round cannot be cancelled individually — only unloading the plugin stops one, and a round in flight when the process exits is lost. Steering also means a milestone-triggered plan can land at a step boundary the user did not ask for, which is the same property that makes it arrive at all.

Removing the endpoint default moves a required decision onto whoever enables rollout, and the two throws make that decision fail loud at load and again before any worker spends tokens. `judgeBaseURL` is consequently the one field a deployment cannot omit while enabled, which the package README states directly.
