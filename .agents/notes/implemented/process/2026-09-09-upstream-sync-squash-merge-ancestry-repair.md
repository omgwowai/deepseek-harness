# Agent Note: Repair squash-flattened upstream ancestry before merging a sync

Status: implemented

English | [中文](2026-09-09-upstream-sync-squash-merge-ancestry-repair.zh.md)

## Problem

Syncing 0.1.2-alpha.2 to 0.1.5-alpha.1 moves 1629 upstream commits across 7570 files. The merge reported 3275 conflicts, including in files neither side had touched since the previous sync.

The count is a symptom of history, not of content. The fork's previous sync landed on `omgwowai/master` as PR #11, squash-merged. A squash merge writes one commit whose tree is the merge result and whose only parent is the fork's own previous tip, so the upstream tag that sync consumed — `dsh-v0.1.2-alpha.2`, present on the branch as `ef9853546f` — is not an ancestor of `master`. Git therefore has to reach back past both syncs for a common base, lands on 2026-08-13, and re-merges 17 days of upstream history that the working tree already contains. Every one of those already-applied changes arrives as a conflict against itself.

The [previous sync's rules](2026-08-24-upstream-sync-regenerates-generated-conflicts.md) for generated artifacts and its [successor's structural checks](2026-08-31-upstream-sync-fork-content-loss-checks.md) for bilingual pairs both assume the conflict set is real. Neither is usable against 3275 phantom conflicts: taking upstream's side and regenerating would replay the base's version of the fork's own work.

## Decision

Before merging a sync, the previous sync's upstream tag must be an ancestor of the fork's branch. When a squash merge flattened it away, the repair is a parent-only merge — `git merge -s ours <previous-sync-commit>` — which records the missing lineage and changes no file. The tree the fork publishes is already the merge result; `-s ours` asserts exactly that and nothing more, so the commit is empty by construction and reviewable as such. With `ef9853546f` recorded as a second parent, the same `git merge dsh-v0.1.5-alpha.1` picks the correct base and yields 19 conflicts, all of them real.

The 19 sort into the three classes the previous notes established, and each was resolved by that note's rule: generated artifacts by taking upstream and rerunning the generator, bilingual pairs by restoring the fork's sections from the pre-merge blob and re-recording only after the structural-invariant diff is clean, hand-authored files by reading both sides. `docs/event-producer-consumer.zh.md` lost the fork's `tokenrouter-rollout` listener exactly as the 2026-08-31 note predicts, and the invariant diff found it: 74/74 event keys and 268/268 package keys after repair.

Two of the fork's four carried changes are no longer the fork's. Upstream's `acceptIdentity` supersedes the tool-call guard, and `stream.ts` auto-merged onto upstream's Messages API rewrite; both are dropped rather than reapplied. The two that remain are the `stream` provider field, which upstream still does not have, and the SSE EOF handling.

Upstream retired the session-details panel, and with it the `conversation.details.footer` seat. That seat carried one of `client-ui-rollout`'s three registrations. This sync removes the registration and retypes `RolloutStatsPanel` against `SessionStandardProps & PropsLocale<'rollout'>` — the standard kit any session-scoped seat supplies — rather than deleting the component or inventing a seat. The host projection it reads is untouched and still recorded, so rebinding it later is a one-line change with no host work. The `tokenrouter-rollout` extension's own adaptation to 0.1.5-alpha.1 is deliberately out of this PR.

Upstream's `Session.events` property became `snapshotEvents(fromSeq?, toSeqExclusive?)` and `ownEvents()`. The two readers follow the distinction rather than the mechanical rename: the milestone watcher wants the whole log including a forked prefix and calls `snapshotEvents()`, while `childOutputTokens` must not bill a forked child for tokens its parent spent and calls `ownEvents()`.

## Alternatives considered

**Rebase the fork onto the upstream tag.** `master` carries 8 commits since the tag, but five of them are squashed sync merges: replaying them means re-resolving three previous syncs' conflicts against a tree 7570 files different, and the result carries no upstream parent either. The [rc.2 sync note](2026-08-24-upstream-sync-regenerates-generated-conflicts.md) rejected this one sync earlier for the same reason; each squashed sync adds another such commit.

**Resolve the 3275 conflicts.** Most are the merge base's version of changes already in the tree, so "resolving" them means re-choosing between two states of upstream's own history with no fork content at stake. The volume also hides the 19 that matter.

**Cherry-pick upstream's diff onto the fork instead of merging.** It produces the right tree once and leaves the next sync in exactly this position: no upstream ancestor, no correct base. The defect is the missing parent, so the fix has to be a parent.

**Rewrite `master` to un-squash PR #11.** It restores true ancestry, but rewrites published history other clones have, and `--force-with-lease` on a shared default branch is a cost far beyond the one empty commit that fixes the same problem going forward.

**Delete `RolloutStatsPanel` with its seat.** The component and the `rolloutStats` projection are fork work upstream's deletion did not touch; removing them would make the follow-up PR rebuild what a retype preserves. Keeping it typed against the standard kit also makes the next seat change a rebinding rather than a rewrite.

**Keep the panel mounted on a seat that still exists.** Choosing a new seat is a product decision about where a per-session readout belongs, not a merge resolution, and this PR's scope is the sync.

## Consequences

- The ancestry repair is one commit with an empty diff, and its value is entirely in the parent list. A reviewer cannot see it in the file view; the commit message carries the reason, and this note carries it durably.
- The next sync computes a correct base only if `dsh-v0.1.5-alpha.1` is an ancestor of `master` when it starts. If this PR is squash-merged like #11, the defect returns and the next sync pays the same repair. A merge commit — or the same `-s ours` repair at the start of the next sync — is what keeps it from recurring.
- The `-s ours` commit asserts that the fork's tree already contains the named upstream state. That is true here because the previous sync's merge result is what was squashed. It is not a general-purpose ancestry rewrite: applied to a commit whose content the tree does not actually contain, it would silently claim upstream changes the fork never took.
- `RolloutStatsPanel` compiles and is covered but renders nowhere. `client-ui-rollout`'s tests now assert the seat count rather than the absent seat's emptiness, because the retired key is no longer in the typed slot map and the old assertion could not be written at all.
- Upstream 0.1.5-alpha.1 adds `verify-package-readme-summaries`, a 100-word cap on English package README Summaries, which both fork packages exceeded. Trimming them relocated two facts (the fail-loud endpoint behavior, the retired seat) into the sections that own them; both Chinese counterparts were brought along before the pairing records were re-recorded.
- `typecheck`, `lint`, `doc-sync` (34/34), and the 460 tests across the four touched packages pass. `test:coverage` and the platform matrix stay with CI.
