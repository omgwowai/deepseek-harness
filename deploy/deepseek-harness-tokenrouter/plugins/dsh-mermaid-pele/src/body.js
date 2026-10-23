/* ------------------------------------------------------------------------- *
 * dsh × Pele — render ```mermaid fences in the chat transcript.
 *
 * `pele` is inlined above this file by tools/build.mjs (MIT, pele@1.7.0,
 * https://github.com/obsidianmd/pele). Nothing here reaches the network:
 * links and images are disabled, so a diagram can only be shapes and text.
 *
 * Strategy (agreed with the user):
 *   - the model's ```mermaid block stays in the DOM, hidden, as the source of truth
 *   - a diagram is rendered in place, right after it
 *   - a "view source / view diagram" toggle switches between the two
 *   - while the block is still streaming (or if it never parses) the source shows
 * ------------------------------------------------------------------------- */

const LANGS = new Set(["mermaid", "mmd", "mermaidjs"]);
const HOST_ATTR = "data-dsh-pele";
const STYLE_ID = "dsh-pele-style";
const DEBOUNCE_MS = 220;
const DEBUG = typeof window !== "undefined" && window.__DSH_PELE_DEBUG === true;
const debug = (...args) => { if (DEBUG) console.log("[dsh-mermaid-pele]", ...args); };

const RENDER_OPTIONS = {
  links: false,
  images: false,
  responsive: true,
  autoDirection: true,
};

const LABELS = {
  viewSource: { zh: "查看源码", en: "View source" },
  viewDiagram: { zh: "查看图", en: "View diagram" },
};

const CSS = `
[${HOST_ATTR}] {
  margin: 4px 0 4px 4px;
}
[${HOST_ATTR}] .dsh-pele-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 24px;
  margin-bottom: 4px;
}
[${HOST_ATTR}] .dsh-pele-toggle {
  border: 0;
  background: none;
  padding: 0;
  margin: 0;
  cursor: pointer;
  font: inherit;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: 24px;
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
}
[${HOST_ATTR}] .dsh-pele-toggle:hover { color: var(--dsw-alias-label-secondary, #555); }
[${HOST_ATTR}] .dsh-pele-status {
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: 24px;
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
}
[${HOST_ATTR}] .dsh-pele-diagram {
  /* Pele reads these; fall back to the app's design tokens. */
  --pele-bg: var(--dsw-alias-bg-base, transparent);
  --pele-fg: var(--dsw-alias-label-primary, #1f1f1f);
  --pele-muted: var(--dsw-alias-label-tertiary, #6e6e6e);
  --pele-line: var(--dsw-alias-label-secondary, #1f1f1f);
  --pele-surface: var(--dsw-alias-markdown-code-block, #f3f3f3);
  --pele-surface-alt: var(--dsw-alias-interactive-bg-hover-solid, #e6e6e6);
  --pele-border: var(--dsw-alias-border-l2, #8a8a8a);
  --pele-accent: var(--dsw-alias-state-business-primary, #5b7bd5);
}
`;

/**
 * Fence language of a code block.
 *
 * The banner is not authoritative: dsh highlights through Shiki and has no
 * mermaid grammar, so for ```mermaid it prints the localized generic label
 * ("Code block" / 「代码块」) instead of the info string. The exact value is the
 * `lang` prop of the code block component that owns `.md-code-block`, one
 * React fiber above the element. When that is unreachable (React internals
 * changed), fall back to the banner token and, if the banner shows the generic
 * label, to Pele's own diagram-type detection on the source.
 */
function fenceLangOf(block) {
  const fiberKey = Object.keys(block).find((key) => key.startsWith("__reactFiber$"));
  let fiber = fiberKey === undefined ? null : block[fiberKey];
  for (let depth = 0; fiber != null && depth < 4; depth += 1, fiber = fiber.return) {
    const props = fiber.memoizedProps;
    if (props !== null && typeof props === "object" && typeof props.code === "string") {
      return { lang: typeof props.lang === "string" ? props.lang.toLowerCase() : "", exact: true };
    }
  }
  const banner = block.querySelector("[data-code-block-banner]");
  if (banner === null) return { lang: "", exact: false };
  const info = banner.firstElementChild;
  const raw = (info ? info.textContent : banner.textContent) || "";
  return { lang: raw.trim().split(/[\s{]/)[0].toLowerCase(), exact: false };
}

/** Whether this code block holds a Mermaid diagram. */
function isDiagram(block, source) {
  const { lang, exact } = fenceLangOf(block);
  if (LANGS.has(lang)) return true;
  if (exact) return false;
  try {
    return window.pele.detectType(source) != null;
  } catch {
    return false;
  }
}

/** The diagram source, straight out of the rendered code block. */
function sourceOf(block) {
  const pre =
    block.querySelector("[data-code-block-content] pre") ||
    block.querySelector("[pre]") ||
    block.querySelector("pre");
  if (pre === null) return null;
  return pre.textContent.replace(/\n$/, "");
}

function sourceView(block) {
  return block.querySelector("[data-code-block-content]");
}

function pickLabel(key) {
  const lang = (document.documentElement.lang || navigator.language || "en").toLowerCase();
  return lang.startsWith("zh") ? LABELS[key].zh : LABELS[key].en;
}

function installStyles() {
  if (document.getElementById(STYLE_ID) !== null) return () => {};
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
  return () => style.remove();
}

function apply(ctx) {
  const state = new Map();
  const timers = new Map();
  const removeStyles = installStyles();

  const showSource = (block, entry, reason) => {
    const content = sourceView(block);
    if (content !== null) content.style.display = "";
    entry.diagram.style.display = "none";
    entry.toggle.style.display = "none";
    entry.status.textContent = reason;
  };

  const showDiagram = (block, entry) => {
    const content = sourceView(block);
    if (content !== null) content.style.display = "none";
    entry.diagram.style.display = "";
    entry.toggle.style.display = "";
    entry.status.textContent = "";
    entry.toggle.textContent = pickLabel("viewSource");
  };

  /** Render (or re-render) one code block. Never throws. */
  const render = (block) => {
    const source = sourceOf(block);
    if (source === null || source.trim() === "" || !isDiagram(block, source)) return;
    debug("render", JSON.stringify(source.slice(0, 40)));

    let entry = state.get(block);
    if (entry === undefined || !block.contains(entry.host)) {
      const host = document.createElement("div");
      host.setAttribute(HOST_ATTR, "");
      const toolbar = document.createElement("div");
      toolbar.className = "dsh-pele-toolbar";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "dsh-pele-toggle";
      const status = document.createElement("span");
      status.className = "dsh-pele-status";
      toolbar.append(toggle, status);
      const diagram = document.createElement("div");
      diagram.className = "dsh-pele-diagram";
      host.append(toolbar, diagram);
      block.appendChild(host);
      entry = { host, toggle, status, diagram, mounted: null, source: null, view: "diagram" };
      state.set(block, entry);
      toggle.addEventListener("click", () => {
        const toSource = entry.view === "diagram";
        entry.view = toSource ? "source" : "diagram";
        const content = sourceView(block);
        if (content !== null) content.style.display = toSource ? "" : "none";
        entry.diagram.style.display = toSource ? "none" : "";
        entry.toggle.textContent = pickLabel(toSource ? "viewDiagram" : "viewSource");
      });
    }

    if (entry.source === source) return;

    // Validate first: an incomplete streaming block must keep showing its source.
    try {
      window.pele.render(source, RENDER_OPTIONS);
    } catch (error) {
      const peleError = window.pele.PeleError;
      if (!(error instanceof peleError)) throw error;
      debug("validation failed", error.code, JSON.stringify(String(error.message).slice(0, 80)));
      entry.source = null;
      showSource(block, entry, "");
      return;
    }

    try {
      // Remount on every source change. Pele's update() defers the redraw of a
      // container it thinks is hidden, and silently ignores a switch to another
      // diagram type, so a fresh mount is the only predictable path. Rendering
      // is 0.05-0.3 ms, so this is cheap. The container is made visible first.
      entry.view = "diagram";
      showDiagram(block, entry);
      if (entry.mounted !== null) {
        try {
          entry.mounted.destroy?.();
        } catch {
          /* already gone */
        }
        entry.mounted = null;
        entry.diagram.textContent = "";
      }
      entry.mounted = window.pele.mount(entry.diagram, source, {
        ...RENDER_OPTIONS,
        onError: () => showSource(block, entry, ""),
      });
      entry.source = source;
    } catch (error) {
      debug("mount failed", error && error.constructor && error.constructor.name, String(error && error.message).slice(0, 120));
      entry.source = null;
      showSource(block, entry, "");
    }
  };

  const schedule = (block) => {
    const pending = timers.get(block);
    if (pending !== undefined) window.clearTimeout(pending);
    timers.set(
      block,
      window.setTimeout(() => {
        timers.delete(block);
        try {
          render(block);
        } catch (error) {
          ctx.logger?.warn?.("[dsh-mermaid-pele] render failed", error);
        }
      }, DEBOUNCE_MS),
    );
  };

  const scan = (root) => {
    if (root.nodeType === 1 && root.matches?.(".md-code-block")) schedule(root);
    root.querySelectorAll?.(".md-code-block").forEach(schedule);
  };

  return ctx.effect(() => {
    scan(document);

    const observer = new MutationObserver((records) => {
      const touched = new Set();
      for (const record of records) {
        const target = record.target;
        if (target.nodeType !== 1 && target.parentElement == null) continue;
        const element = target.nodeType === 1 ? target : target.parentElement;
        // Ignore our own insertions and the SVG we render.
        if (element.closest?.(`[${HOST_ATTR}]`) != null) continue;
        const block = element.closest?.(".md-code-block");
        if (block != null) touched.add(block);
        element.querySelectorAll?.(".md-code-block").forEach((node) => touched.add(node));
      }
      touched.forEach(schedule);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => {
      observer.disconnect();
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
      for (const [block, entry] of state) {
        try {
          entry.mounted?.destroy?.();
        } catch {
          /* pele already gone */
        }
        entry.host.remove();
        const content = sourceView(block);
        if (content !== null) content.style.display = "";
      }
      state.clear();
      removeStyles();
    };
  });
}

return { inject: [], apply };