#!/usr/bin/env node
// Builds dist/agent-fleet-collector.mjs: the collector CLI and everything it imports (readers, targets, protocol,
// channel, redact, jsonl…) as ONE ES module file whose only imports are `node:*` built-ins, so it can be copied into
// a pod and started with `node agent-fleet-collector.mjs --stdio …`.
//
// No bundler dependency: every module becomes a function in a registry, static imports become destructurings of
// `__req("<module id>")`, exports become getters. Supported syntax (anything else fails the build loudly): named /
// default / namespace imports, `export function|class|const`, `export { a as b }`, `export … from`, `export * from`,
// `export default`, dynamic `import("literal")`. Import cycles, `export let|var` and `import.meta` are rejected.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const NAME = "[A-Za-z_$][\\w$]*";

const fail = (file, message) => { throw new Error(`build-collector: ${file}: ${message}`); };

// ---------------------------------------------------------------------------------------------------- lexing

/** Copy of `src` with comments, string / template text and regex bodies blanked (positions are preserved). */
export function maskSource(src) {
  const out = Array.from(src);
  const blank = (from, to) => { for (let k = from; k < to; k += 1) if (src[k] !== "\n") out[k] = " "; };
  const REGEX_AFTER = /[(,=:[!&|?{};+\-*%<>~^]/;
  const REGEX_WORDS = new Set(["return", "typeof", "case", "in", "of", "delete", "void", "throw", "new", "else", "do", "yield", "await"]);
  const isWord = ch => ch !== undefined && /[\w$]/.test(ch);
  let i = 0;

  function lexTemplate() {
    i += 1;
    let start = i;
    while (i < src.length) {
      const ch = src[i];
      if (ch === "\\") { i += 2; continue; }
      if (ch === "`") { blank(start, i); i += 1; return; }
      if (ch === "$" && src[i + 1] === "{") { blank(start, i); i += 2; lexCode(true); i += 1; start = i; continue; }
      i += 1;
    }
    blank(start, i);
  }

  function lexCode(untilBrace) {
    let depth = 0, prev = "", prevWord = "";
    while (i < src.length) {
      const ch = src[i], next = src[i + 1];
      if (ch === "/" && next === "/") { const end = src.indexOf("\n", i); blank(i, end < 0 ? src.length : end); i = end < 0 ? src.length : end; continue; }
      if (ch === "/" && next === "*") { const close = src.indexOf("*/", i + 2); const end = close < 0 ? src.length : close + 2; blank(i, end); i = end; continue; }
      if (ch === '"' || ch === "'") {
        let j = i + 1;
        while (j < src.length && src[j] !== ch && src[j] !== "\n") { if (src[j] === "\\") j += 1; j += 1; }
        blank(i + 1, j); i = j + 1; prev = ch; prevWord = ""; continue;
      }
      if (ch === "`") { lexTemplate(); prev = "`"; prevWord = ""; continue; }
      if (ch === "/" && (prev === "" || REGEX_AFTER.test(prev) || REGEX_WORDS.has(prevWord))) {
        let j = i + 1, inClass = false;
        while (j < src.length) {
          const c = src[j];
          if (c === "\\") { j += 2; continue; }
          if (c === "\n") break;
          if (c === "[") inClass = true; else if (c === "]") inClass = false; else if (c === "/" && !inClass) break;
          j += 1;
        }
        blank(i + 1, j); i = j + 1;
        while (/[a-z]/i.test(src[i] ?? "")) i += 1;
        prev = ")"; prevWord = ""; continue;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") { if (depth === 0 && untilBrace) return; depth -= 1; }
      if (isWord(ch)) {
        let j = i;
        while (isWord(src[j])) j += 1;
        prevWord = src.slice(i, j); prev = "a"; i = j; continue;
      }
      if (!/\s/.test(ch)) { prev = ch; prevWord = ""; }
      i += 1;
    }
  }

  lexCode(false);
  return out.join("");
}

/** Nesting level of () [] {} at every index of the masked source. */
function depthMap(masked) {
  const depth = new Int32Array(masked.length + 1);
  let level = 0;
  for (let i = 0; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === "{" || ch === "(" || ch === "[") level += 1;
    depth[i] = level;
    if (ch === "}" || ch === ")" || ch === "]") level -= 1;
  }
  depth[masked.length] = level;
  return depth;
}

/** End offset of the statement starting at `start`: the next `;` at the same depth, else the end of the line. */
function statementEnd(masked, depth, start) {
  const level = depth[start];
  for (let i = start; i < masked.length; i += 1) {
    if (depth[i] !== level) continue;
    if (masked[i] === ";") return i + 1;
    if (masked[i] === "\n") return i;
  }
  return masked.length;
}

// ------------------------------------------------------------------------------------------- module analysis

function importCode(file, clause, id) {
  const spec = JSON.stringify(id);
  if (!clause) return `__req(${spec});`;
  const text = clause.trim();
  const named = list => list.split(",").map(part => part.trim()).filter(Boolean).map(part => {
    const [imported, local = imported] = part.split(/\s+as\s+/).map(piece => piece.trim());
    return imported === local ? local : `${imported}: ${local}`;
  }).join(", ");
  let match;
  if ((match = new RegExp(`^\\*\\s*as\\s+(${NAME})$`).exec(text))) return `const ${match[1]} = __req(${spec});`;
  if ((match = new RegExp(`^(${NAME})$`).exec(text))) return `const ${match[1]} = __req(${spec}).default;`;
  if ((match = new RegExp(`^(${NAME})\\s*,\\s*\\{([\\s\\S]*)\\}$`).exec(text))) return `const ${match[1]} = __req(${spec}).default; const { ${named(match[2])} } = __req(${spec});`;
  if ((match = new RegExp(`^(${NAME})\\s*,\\s*\\*\\s*as\\s+(${NAME})$`).exec(text))) return `const ${match[2]} = __req(${spec}); const ${match[1]} = ${match[2]}.default;`;
  if ((match = /^\{([\s\S]*)\}$/.exec(text))) return `const { ${named(match[1])} } = __req(${spec});`;
  return fail(file, `cannot parse import clause "${text}"`);
}

/**
 * Rewrite one module into the body of a registry function.
 * @param {string} file  module id (for messages)
 * @param {string} source
 * @param {(specifier: string) => string} resolveSpec  specifier → module id (or the `node:*` specifier)
 * @returns {{body: string, deps: string[], dynamic: string[], exportNames: string[]}}  exportNames: "name" | "name=localExpr"
 */
export function transformModule(file, source, resolveSpec) {
  const masked = maskSource(source);
  const depth = depthMap(masked);
  if (/\bimport\s*\.\s*meta\b/.test(masked)) fail(file, "uses import.meta, which a single-file bundle cannot provide");
  const edits = []; // {start, end, text}
  const deps = [], dynamic = [], exportNames = [];
  let counter = 0;
  const addDep = (spec, list = deps) => { const id = resolveSpec(spec); if (!list.includes(id)) list.push(id); return id; };

  for (const match of masked.matchAll(/\bimport\s*\(/g)) { // dynamic imports, anywhere
    const open = match.index + match[0].length;
    const literal = /^\s*(["'])([^"'\n]+)\1\s*\)/.exec(source.slice(open));
    if (!literal) fail(file, `dynamic import with a non-literal specifier at offset ${match.index}`);
    if (literal[2].startsWith("node:")) continue; // stays a native dynamic import
    const id = addDep(literal[2], dynamic);
    edits.push({ start: match.index, end: open + literal[0].length, text: `__dyn(${JSON.stringify(id)})` });
  }

  const statement = /(^|[\n;}])[ \t]*(import|export)\b(?!\s*[(.])/g; // top-level statements
  for (const match of masked.matchAll(statement)) {
    const start = match.index + match[0].length - match[2].length;
    if (depth[start] !== 0) continue;
    const keywordEnd = start + match[2].length;
    if (match[2] === "import") {
      const found = /^import\s*(?:([\s\S]*?)\s*from\s*)?(["'])([^"'\n]+)\2\s*;?/.exec(source.slice(start));
      if (!found) fail(file, `cannot parse the import at offset ${start}`);
      edits.push({ start, end: start + found[0].length, text: importCode(file, found[1], addDep(found[3])) });
      continue;
    }

    const rest = source.slice(keywordEnd);
    let m;
    if ((m = new RegExp(`^(\\s+)(default\\s+)?((?:async\\s+)?(?:function\\s*\\*?|class)\\s*(${NAME})?)`).exec(rest))) {
      if (m[2] && !m[4]) fail(file, "anonymous `export default function/class` is not supported");
      exportNames.push(m[2] ? `default=${m[4]}` : m[4]);
      edits.push({ start, end: keywordEnd + m[1].length + (m[2]?.length ?? 0), text: "" });
    } else if ((m = new RegExp(`^(\\s+)(const|let|var)\\s+(${NAME}|[{\\[])`).exec(rest))) {
      if (m[2] !== "const") fail(file, `\`export ${m[2]} ${m[3]}\` (a mutable binding) is not supported`);
      if (m[3] === "{" || m[3] === "[") fail(file, "destructuring export is not supported");
      const end = statementEnd(masked, depth, start);
      for (let i = start; i < end; i += 1) if (masked[i] === "," && depth[i] === depth[start]) fail(file, `\`export const ${m[3]}, …\` declares several names: split it`);
      exportNames.push(m[3]);
      edits.push({ start, end: keywordEnd + m[1].length, text: "" });
    } else if ((m = /^\s+default\s+/.exec(rest))) {
      const end = statementEnd(masked, depth, start);
      edits.push({ start, end: keywordEnd + m[0].length, text: "const __default = " });
      if (source[end - 1] !== ";") edits.push({ start: end, end, text: ";" });
      exportNames.push("default=__default");
    } else if ((m = new RegExp(`^\\s*\\*\\s*(?:as\\s+(${NAME})\\s+)?from\\s*(["'])([^"'\\n]+)\\2\\s*;?`).exec(rest))) {
      const alias = `__r${counter++}`, id = JSON.stringify(addDep(m[3]));
      if (m[1]) exportNames.push(`${m[1]}=${alias}`);
      edits.push({ start, end: keywordEnd + m[0].length, text: m[1] ? `const ${alias} = __req(${id});` : `const ${alias} = __req(${id}); __star(exports, ${alias});` });
    } else if ((m = /^\s*\{([^}]*)\}\s*(?:from\s*(["'])([^"'\n]+)\2)?\s*;?/.exec(rest))) {
      const pairs = m[1].split(",").map(part => part.trim()).filter(Boolean).map(part => {
        const [local, exported = local] = part.split(/\s+as\s+/).map(piece => piece.trim());
        return { local, exported };
      });
      if (m[3] !== undefined) {
        const alias = `__r${counter++}`;
        for (const pair of pairs) exportNames.push(`${pair.exported}=${alias}[${JSON.stringify(pair.local)}]`);
        edits.push({ start, end: keywordEnd + m[0].length, text: `const ${alias} = __req(${JSON.stringify(addDep(m[3]))});` });
      } else {
        for (const pair of pairs) exportNames.push(pair.exported === pair.local ? pair.local : `${pair.exported}=${pair.local}`);
        edits.push({ start, end: keywordEnd + m[0].length, text: "" });
      }
    } else fail(file, `unsupported export form: ${source.slice(start, start + 60).replace(/\n/g, " ")}`);
  }

  edits.sort((a, b) => b.start - a.start);
  let body = source;
  for (const edit of edits) body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
  return { body, deps, dynamic, exportNames };
}

// ------------------------------------------------------------------------------------------------- bundling

/**
 * @param {object} [options]
 * @param {string} [options.root]   plugin directory
 * @param {string} [options.entry]  module exporting `collectorMain(argv)`
 * @param {string} [options.out]    output file
 * @returns {{file: string, bytes: number, sha256: string, modules: string[], externals: string[]}}
 */
export function buildCollector({ root = resolve(here, ".."), entry = "lib/collector/main.mjs", out = join(root, "dist", "agent-fleet-collector.mjs") } = {}) {
  const modules = new Map(); // id → {body, exportNames}
  const externals = new Set();
  const stack = [];

  function load(id) {
    if (modules.has(id)) return;
    if (stack.includes(id)) fail(id, `import cycle: ${[...stack.slice(stack.indexOf(id)), id].join(" → ")}`);
    const file = join(root, id);
    const source = readFileSync(file, "utf8").replace(/^#!.*\n/, "");
    const resolveSpec = spec => {
      if (spec.startsWith("node:")) { externals.add(spec); return spec; }
      if (!spec.startsWith(".")) fail(id, `bare import "${spec}": only relative imports and node:* built-ins can be bundled`);
      const target = resolve(dirname(file), spec);
      const found = [target, `${target}.mjs`, join(target, "index.mjs")].find(candidate => existsSync(candidate) && statSync(candidate).isFile());
      if (!found) fail(id, `cannot resolve "${spec}"`);
      return relative(root, found).split(sep).join("/");
    };
    const result = transformModule(id, source, resolveSpec);
    stack.push(id);
    for (const dep of [...result.deps, ...result.dynamic]) if (!dep.startsWith("node:")) load(dep);
    stack.pop();
    modules.set(id, { body: result.body, exportNames: result.exportNames });
  }

  load(entry);

  const externalList = [...externals].sort();
  const lines = [
    "#!/usr/bin/env node",
    "// agent-fleet collector: single-file bundle generated by tools/build-collector.mjs (do not edit).",
    `// modules: ${[...modules.keys()].join(", ")}`,
    ...externalList.map((spec, index) => `import * as __x${index} from ${JSON.stringify(spec)};`),
    `const __externals = { ${externalList.map((spec, index) => `${JSON.stringify(spec)}: __x${index}`).join(", ")} };`,
    "const __defs = Object.create(null), __cache = Object.create(null);",
    "function __req(id) {",
    "  if (id in __externals) return __externals[id];",
    "  let module = __cache[id];",
    "  if (module === undefined) { module = __cache[id] = {}; __defs[id](module); }",
    "  return module;",
    "}",
    "function __dyn(id) { return Promise.resolve().then(() => __req(id)); }",
    "function __star(target, source) { for (const key of Object.keys(source)) if (key !== \"default\" && !(key in target)) Object.defineProperty(target, key, { enumerable: true, get: () => source[key] }); }",
  ];
  for (const [id, { body, exportNames }] of modules) {
    const getters = exportNames.map(spec => {
      const eq = spec.indexOf("=");
      const exported = eq < 0 ? spec : spec.slice(0, eq), local = eq < 0 ? spec : spec.slice(eq + 1);
      return `${JSON.stringify(exported)}: { enumerable: true, get: () => ${local} }`;
    });
    lines.push(`__defs[${JSON.stringify(id)}] = function (exports) {`, body.trimEnd(), ...(getters.length > 0 ? [`Object.defineProperties(exports, { ${getters.join(", ")} });`] : []), "};");
  }
  lines.push(
    "const __argv = process.argv.slice(2);",
    "if (__argv[0] === \"collector\") __argv.shift();",
    "else if (__argv[0] !== undefined && !__argv[0].startsWith(\"-\")) { process.stderr.write(`agent-fleet-collector: this bundle only runs the collector (got \"${__argv[0]}\")\\n`); process.exit(2); }",
    `await __req(${JSON.stringify(entry)}).collectorMain(__argv);`,
    "",
  );
  const text = lines.join("\n");

  // The output must parse as a module and import nothing but node:* built-ins.
  const staged = join(dirname(out), `.${process.pid}-staged.mjs`); // `--check` decides module vs script by extension
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(staged, text);
  const check = spawnSync(process.execPath, ["--check", staged], { encoding: "utf8" });
  if (check.status !== 0) { fail(out, `the bundle does not parse:\n${check.stderr}`); }
  for (const match of maskSource(text).matchAll(/(?:^|\n)\s*import\b[^;\n]*?\bfrom\s*(["'])([^"'\n]*)\1/g)) {
    const specifier = text.slice(match.index, match.index + match[0].length + 80).match(/from\s*(["'])([^"'\n]*)\1/)?.[2];
    if (specifier && !specifier.startsWith("node:")) fail(out, `the bundle imports ${specifier}`);
  }
  chmodSync(staged, 0o755);
  renameSync(staged, out);
  return { file: out, bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex"), modules: [...modules.keys()], externals: externalList };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flag = process.argv.indexOf("--out");
  try {
    const result = buildCollector(flag > 0 ? { out: resolve(process.argv[flag + 1]) } : {});
    process.stdout.write(`${relative(process.cwd(), result.file) || result.file}  ${result.bytes} bytes  sha256 ${result.sha256.slice(0, 16)}  ${result.modules.length} modules  externals: ${result.externals.join(" ")}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
