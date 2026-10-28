# @local/dsh-mermaid-pele

Renders ` ```mermaid ` fenced code blocks in the DeepSeek Harness chat into themeable SVG,
using [Pele](https://pele.run) — the Mermaid-syntax renderer released by Obsidian's author
(kepano) under the MIT license.

## What it does

- Every code block whose info string is `mermaid` (or `mmd`) is rendered **in place**.
- The original source stays in the DOM, hidden — **"查看源码 / 查看图"** switches between the two.
- While a block is still streaming, or if it never parses, the code block stays visible instead:
  Pele is asked to render first, and a `PeleError` simply defers to the next change.
- Nothing leaves the browser: `links: false, images: false`, so a diagram can only be shapes and text.
- Colours follow the app theme through Pele's CSS variables (`--pele-*`), which are mapped from
  DSH's `--dsw-*` design tokens.

## Install

The plugin is a normal DSH bundle whose client half is a hand-written
`window.__ModuleLoader__.load({ id, factory })` module. Install it once, at profile level, and it
applies to every session in every workspace. From the parent directory:

```bash
node install.mjs --profile desktop --plugins mermaid --skill   # or --profile web
```

That links this directory into the profile (`"@local/dsh-mermaid-pele": "link:<this directory>"`),
adds it to `dsh.profile.bundles`, runs `pnpm install` in the profile, and copies the
`mermaid-diagrams` skill to `~/.agents/skills`.

Then reload the Web GUI page once so the browser picks up the new client bundle.
Disable it like any other bundle (Plugins page, or drop it from `dsh.profile.bundles`).

## Layout

| Path | Role |
|---|---|
| `index.js` | host half — deliberately empty (`export {}`) |
| `client.js` | built browser bundle: vendored Pele + the DOM logic |
| `src/body.js` | the plugin body (edit this, then rebuild) |
| `vendor/pele.global.js` | Pele 1.7.0, MIT, verbatim |
| `tools/build.mjs` | `node tools/build.mjs` → regenerates `client.js` |
| `tools/dom-test.cjs` | jsdom test of the DOM behaviour (`npm i jsdom` first) |

**Never re-indent `vendor/pele.global.js`.** The bundle contains 141 multi-line template literals
(grammar tables); adding leading whitespace corrupts the mermaid parsers in ways that surface only
as bogus syntax errors for some diagram types. `tools/build.mjs` inserts it verbatim on purpose.

## Debugging

```js
window.__DSH_PELE_DEBUG = true;   // then reload: render/validation/mount steps are logged
```

## Attribution

Pele — MIT, © Obsidian — <https://github.com/obsidianmd/pele> (see `vendor/pele.LICENSE`, `NOTICE.md`).