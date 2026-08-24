# Agent Note: Resolve upstream-sync conflicts by regenerating, not merging

Status: implemented

English | [中文](2026-08-24-upstream-sync-regenerates-generated-conflicts.zh.md)

## Problem

The fork tracks `deepseek-ai/deepseek-harness` and carries its own packages (`tokenrouter-rollout`, `client-ui-rollout`) plus adapter fixes. Syncing 0.1.0-rc.8 to 0.1.1-rc.2 moved 207 upstream commits across 2416 files, and every merge conflict landed in a generated artifact: the client slot catalog, the config and persistence catalogs, the module graph, and four bilingual pairing records. Hand-merging those is wrong twice over — the file is not the source of truth, and a hand-merged catalog passes its own `--check` gate only by coincidence.

The sync also cannot assume a red gate means the merge broke something. Upstream rc.2 fails eight snapshot tests and both `rescope-vendor` exact edits on a clean checkout of the tag itself, on this host. Without separating those, a sync either chases upstream's failures or ships regressions hidden behind them.

## Decision

Conflicts in generated files are resolved by taking upstream's side and rerunning the generator, never by editing the artifact. The seven `verify-*-catalog`/`verify-*-graph` gates then prove the result, and the merged catalogs are diffed against the upstream tag to confirm zero upstream removals — the check that distinguishes "regenerated" from "regenerated against a broken source tree". Bilingual pairing records go through `resolve-translation-pairing-conflicts`, which stages every record whose two sides agree and names the ones that need an owner decision.

Every failing gate is reproduced against a pristine worktree of the upstream tag before it is treated as ours. That separated three classes on this sync: the fork's own defects, upstream defects the merge inherits, and host-environment noise. The first two are fixed in the sync; the third is recorded and left alone.

- **Fork defects the merge exposed.** `examples/headless-agent/README.zh.md` linked the English Agent Note, and `docs/module-graph.zh.md` still named `client-ui-slots` where rc.2 renamed the dependency to `client-ui-layout`. Both are fork-authored lines that only a tree containing rc.2's renames can catch.
- **Upstream defects the merge inherits.** Two `rescope-vendor` exact edits fail on pristine rc.2. `knip-logger-console` anchors on `packages/util/home`, which rc.2 deleted, and no manifest declares `@cordisjs/plugin-logger-console` any more, so the edit is retired rather than repaired. `vendoring-cookbook-name-invariant-zh` expects `../rescope.md` in the Chinese cookbook, which upstream's Chinese-link localization changed to `../rescope.zh.md` without updating the spec.
- **Host noise.** Three pwsh tests and five snapshot stderr assertions fail identically on pristine rc.2: local PowerShell 7.6.5 and Node 25's experimental-SQLite warning. CI pins Node 24 and runs pwsh on Linux, so neither reaches it.

rc.2 splits the projection table into `SessionProjectionStateMap` (host fold state) and `SessionProjectionMap` (client wire values), renames `schema` to `stateSchema`, and moves `view` behind an optional `wire`. The fork's `rolloutStats` unit follows that split: its state schema derives from the view schema plus the `winnerScores` trail it always carried, and it merges the state key alongside its existing wire key. The unit switches from a type annotation to `satisfies`, which is how upstream's own units are written and what makes the two-map constraint report at the definition rather than at the registration call.

## Alternatives considered

**Rebase the fork's commits onto the upstream tag.** The fork's published history is squash-merged, so upstream is not an ancestor of `master` and a rebase would replay six squashed commits — including two previous sync merges — against a tree 2416 files different. A merge keeps the upstream tag as a real parent, which is what lets the next sync compute a correct three-way base.

**Hand-merge the conflicting catalogs.** They are generator output. A hand-merge that happens to satisfy `--check` proves only that the artifact is self-consistent, and the next unrelated regeneration would silently rewrite it.

**Take the fork's side for the pairing records.** The records are blob hashes of a confirmed-consistent state, so keeping the pre-merge hash asserts consistency for content that no longer exists. Re-recording after the two sides genuinely agree is the only resolution that means anything.

**Fix the upstream `rescope-vendor` defects upstream first.** Both block this sync's `hygiene` gate the moment the merge lands, and neither fix touches upstream behavior — one retires a dead edit, one corrects a link in a spec string. Carrying them here keeps the fork green; they remain worth sending upstream.

**Re-record the pwsh and snapshot fixtures so the local suite is green.** The fixtures are correct and CI proves it. Re-recording them against local PowerShell and Node 25 would encode this host's quirks into the repository's expected output, which the testing policy forbids: fix fixtures, not normalizers — and here there is nothing to fix.

## Consequences

- The sync's own gates are green: 28/28 `doc-sync`, 13/13 `hygiene`, `typecheck`, `lint`, and 470 tests across the four fork-owned packages. `test` fails 3 and `test:snapshot` fails 5, all reproduced on pristine rc.2, where the same suite fails 8.
- Retiring `knip-logger-console` means a future upstream that reintroduces a `@cordisjs/plugin-logger-console` dependency entry gets no rescope coverage for it. `rescope-vendor --check` fails loudly on an unapplied edit but cannot notice a missing one, so that reintroduction would surface as a knip failure instead.
- The generated-artifact rule makes the sync's conflict count a function of how many generators the fork's packages feed, not of how much upstream changed. This sync's five conflicts came from two fork packages contributing slots, config, persistence events, and graph nodes.
- Reproducing failures against the upstream tag costs an install and a suite run per class, and it is the only evidence that separates a merge regression from an inherited one. Both worktrees are removed after use; neither is left for the next sync to rediscover.
