#!/usr/bin/env node
/**
 * DOM-behaviour test for the dsh × Pele mermaid renderer.
 *
 *   cd /tmp && npm i jsdom           # jsdom is not vendored
 *   node tools/dom-test.cjs
 *
 * Builds a synthetic page that mimics dsh's code-block markup
 * (div.md-code-block > [data-code-block-banner] + [data-code-block-content] > pre),
 * then exercises the plugin: initial render, the source/diagram toggle, streaming
 * updates, a diagram-type switch, the untranslated fallback, and disposal.
 */
const fs = require("node:fs");
const path = require("node:path");

let JSDOM;
try {
  ({ JSDOM } = require("jsdom"));
} catch {
  console.error("jsdom is required: npm i jsdom");
  process.exit(2);
}

const ROOT = path.join(__dirname, "..");
const CLIENT = path.join(ROOT, "client.js");

const PAGE = `<!doctype html><html lang="zh-CN"><head></head><body>
<div id="transcript">
  <div class="md-code-block" id="mmd">
    <div class="bannerWrap"><div data-code-block-banner>
      <div class="infostring">mermaid</div>
      <div class="action"><button class="copyButton">复制</button></div>
    </div></div>
    <div data-code-block-content id="mmd-content"><pre class="plain"><code>flowchart LR
  A[开始] --> B[结束]</code></pre></div>
  </div>
  <div class="md-code-block" id="js">
    <div data-code-block-banner><div class="infostring">javascript</div>
      <div class="action"><button>复制</button></div></div>
    <div data-code-block-content id="js-content"><pre><code>const a = 1;</code></pre></div>
  </div>
</div>
</body></html>`;

const dom = new JSDOM(PAGE, { pretendToBeVisual: true, url: "http://localhost/" });
const { window } = dom;

// Minimal stubs for the browser APIs jsdom lacks.
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(Date.now()), 0);
window.cancelAnimationFrame = (id) => window.clearTimeout(id);
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

globalThis.window = window;
for (const key of [
  "document", "navigator", "MutationObserver", "HTMLElement", "Node", "getComputedStyle",
  "ResizeObserver", "CSS", "DOMRect", "SVGElement", "Element", "Event", "MouseEvent",
]) {
  if (window[key] !== undefined) globalThis[key] = window[key];
}

let captured = null;
window.__ModuleLoader__ = { load: (spec) => { captured = spec; } };
eval(fs.readFileSync(CLIENT, "utf8"));
if (captured === null) throw new Error("client.js did not register a module");
const mod = captured.factory(() => { throw new Error("unexpected require"); });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const doc = window.document;
const mmd = doc.getElementById("mmd");
const mmdContent = doc.getElementById("mmd-content");
const js = doc.getElementById("js");
const jsContent = doc.getElementById("js-content");
const code = mmd.querySelector("code");

const results = [];
const check = (name, ok, extra = "") => results.push([name, ok, extra]);

const dispose = mod.apply({ effect: (fn) => fn(), logger: { warn() {} } });

(async () => {
  await sleep(400);
  const host = mmd.querySelector("[data-dsh-pele]");
  check("host inserted", host !== null);
  check("source hidden after render", mmdContent.style.display === "none");
  check("svg rendered", host?.querySelector("svg.pele") !== null);
  check("toggle starts on 查看源码", host?.querySelector(".dsh-pele-toggle")?.textContent === "查看源码");
  check("non-mermaid block untouched", js.querySelector("[data-dsh-pele]") === null && jsContent.style.display === "");

  host.querySelector(".dsh-pele-toggle").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(20);
  check("toggle shows source", mmdContent.style.display === "" && host.querySelector(".dsh-pele-diagram").style.display === "none");
  check("toggle label flips", host.querySelector(".dsh-pele-toggle").textContent === "查看图");
  host.querySelector(".dsh-pele-toggle").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(20);
  check("toggle back to diagram", mmdContent.style.display === "none");

  code.textContent = "flowchart LR\n  A[开始";
  await sleep(400);
  check("incomplete source keeps the code block", mmdContent.style.display === "");

  code.textContent = "flowchart LR\n  A[开始] --> B[结束] --> C[归档]";
  await sleep(400);
  let svg = mmd.querySelector("[data-dsh-pele] svg");
  check("same-type update applied", mmdContent.style.display === "none" && svg !== null && svg.textContent.includes("归档"));

  code.textContent = "sequenceDiagram\n  A->>B: hi\n  B-->>A: ok";
  await sleep(400);
  svg = mmd.querySelector("[data-dsh-pele] svg");
  check("type switch remounts", svg !== null && svg.classList.contains("pele-sequence"), svg?.getAttribute("class"));
  check("type switch hides source", mmdContent.style.display === "none");

  code.textContent = "not a diagram at all";
  await sleep(400);
  check("unsupported text keeps the code block", mmdContent.style.display === "");

  dispose();
  await sleep(50);
  check("host removed on dispose", mmd.querySelector("[data-dsh-pele]") === null);
  check("source restored on dispose", mmdContent.style.display === "");

  let failed = 0;
  for (const [name, ok, extra] of results) {
    if (!ok) failed += 1;
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? `  [${extra}]` : ""}`);
  }
  console.log(failed === 0 ? `\nALL PASS (${results.length})` : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();