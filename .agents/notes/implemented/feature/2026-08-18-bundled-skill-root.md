# Agent Note: Bundled skill root

Status: implemented

English | [中文](2026-08-18-bundled-skill-root.zh.md)

## Problem

A skill that every session should carry had nowhere to live in this repository.

`packages/skill/skill-filesystem` already mounts a `bundled` root at `BUNDLED_SKILL_RANK` and already defaults it to `$DSH_BUNDLED_SKILL_DIR`, but nothing in the tree ever set that variable, so the lowest-precedence root was permanently empty and the feature was reachable only by a deployment exporting the variable by hand.

The two roots that did carry skills answer different questions. `$DSH_HOME/skills` is the person's own directory: an install writes nothing there, and a second machine has none of it. `config/agent-presets/cordis/skills/` travels with one preset, which is correct for the composition-authoring skill it holds and wrong for anything the other presets should also have — a preset-owned copy is invisible to `standard`, and duplicating it per preset makes four copies to update.

## Decision

**`apps/cli/config/skills/` is the shipped root, and the launcher installs it through the environment variable rather than a row patch.** `skill-filesystem` mounts once on the host plane under the headless and TUI profiles but once per agent preset under the web profile, where the host row is disabled and each preset owns discovery. A patch would have to name rows the launcher cannot enumerate — it does not know which composition it just booted. The environment default reaches every one of those rows without knowing any of them.

The root sits beside `config/agent-presets/`, under the `config` entry `apps/cli/package.json` already publishes, and resolves from `import.meta.url` in both the source and built layouts — the same anchor `SHIPPED_PRESET_ROOT` uses.

**An inherited value always wins, including the empty string.** `resolveBundledSkillRoot` returns the shipped root only for `undefined`. Treating `''` as unset would remount the root a deployment had just cleared, and the ranking matches `loadLayeredEnv`, where the process environment outranks every file layer.

**Precedence is unchanged, which is what makes the root safe to ship.** `BUNDLED_SKILL_RANK` is the highest number and therefore the weakest claim, so a same-named skill under a project root, a custom root, or `$DSH_HOME/skills` shadows the shipped copy. Someone who wants a different `j-space` writes one and it wins; nobody has to uninstall this.

**The root holds directories only.** `discoverRoot` reads a top-level `.md` file as a skill in its own right, so a `README.md` in the root would be parsed, rejected for missing frontmatter, and logged as ignored on every boot. The directory's documentation is a section of the app README pair instead, and a test pins the absence.

## What ships in it

`config/skills/j-space` is vendored from [J-Space Cognition Suite V3.6](https://github.com/Tiger3807861189/J-Space-Cognition-Suite-V3.6) at `885dc513702cc884f0b4fa07d24a27b2df5a1daf`, Apache-2.0, with the upstream `LICENSE` kept beside it. It is Markdown plus three dependency-free Python scripts; the ledger script writes only under a `.jspace/` directory in the working directory and runs no subprocess, opens no socket, and calls no `eval`.

`THIRD_PARTY_NOTICES.md` is not affected: its generator reads manifests, `vendor/README.md`, and `pyproject.toml` files, and this suite is none of those. Attribution is the `LICENSE` file the directory carries, which is what Apache-2.0 §4 asks for.

## Testing

`apps/cli/tests/bundled-skill-root.spec.ts` pins the resolver against both branches, that the shipped root really contains `j-space/SKILL.md`, that no loose `.md` sits in the root, that the upstream license travels with the suite, and that the frontmatter carries the `name` and `description` the local provider requires before it will publish a skill at all.

Discovery was verified end to end from a `DSH_HOME` holding an empty `skills/`: `j-space` appears in the session catalog, which it can only do through the bundled root.

## Consequences

The deployment now decides part of every session's skill catalog, which it could not before. That is the point, and it is also the cost: one more entry in every catalog the model reads, for every profile, whether or not the session wants it. The precedence rank bounds the cost — anyone may shadow the shipped copy by name — but nobody can make the root itself vanish except by exporting an empty `DSH_BUNDLED_SKILL_DIR`, which is now the documented way to do it.

Vendored third-party Markdown is a maintenance surface this repository did not have. It is not generated, so no gate keeps it fresh; the app README pair records the update procedure and the upstream revision lives in this note. A stale copy fails nothing and is discovered only by someone looking.

What it buys is that a skill reaches every surface from one statement. The variable is read by the host row under headless and TUI and by each preset's own row under web, so no future preset — in-tree or out — has to remember anything to inherit the root.

## Alternatives considered

**Mount it as a `customSkillDirs` entry on each `skill-filesystem` row.** This is what the `cordis` preset does for its own two skills, and it is right there — but it is per-composition by construction. Every preset would need the row, out-of-tree presets would silently lack it, and the web profile's per-preset rows would each need patching. The environment default is one statement covering all of them.

**Put it in `$DSH_HOME/skills` at install time.** An install that writes into a person's directory owns bytes it cannot later update without overwriting edits, and the copy would be per-machine rather than per-deployment. The bundled root is read-only and belongs to the install, which is the relationship that actually holds.

**A repository-root `skills/`.** It would not ship: `apps/cli/package.json` publishes `lib/*.js` and `config`, so a root directory reaches no installed deployment, and the launcher's `import.meta.url` anchor could not resolve it from the built layout.
