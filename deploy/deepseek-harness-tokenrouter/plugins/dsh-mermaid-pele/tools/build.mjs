#!/usr/bin/env node
/**
 * Build client.js for @local/dsh-mermaid-pele.
 *
 * The browser module system wants `window.__ModuleLoader__.load({id, factory})`
 * whose factory returns the plugin module (`{ inject, apply }`). Pele ships a
 * self-contained IIFE that declares a `pele` var, so we run it in its own scope
 * and re-expose it on window for our body.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

const pele = await readFile(join(root, "vendor/pele.global.js"), "utf8");
const body = await readFile(join(root, "src/body.js"), "utf8");

const out = `/*! ${pkg.name} — bundles Pele (MIT) https://github.com/obsidianmd/pele */
window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory: require => {
    /* ---- vendored pele 1.7.0 (MIT) ---- */
    (function () {
/* ---- pele verbatim: never re-indent, its bundle contains multi-line
   template literals (grammar tables) that indentation would corrupt ---- */
${pele}
window.pele = pele;
    })();

    /* ---- plugin ---- */
    return (function () {
${body}
    })();
  }
});
`;

await writeFile(join(root, "client.js"), out);
console.log(`client.js written (${(out.length / 1024).toFixed(1)} KiB)`);