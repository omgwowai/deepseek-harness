// Tool call → { category, preview, targets }: what one native tool call (or one shell command line) did.
//
//   classifyTool({kind, name, input, cwd, host, site, home?}) → {category, preview, targets}
//   parseCommand(cmd, {cwd, host, site, home?})              → {category, targets}   (cmd: string, or argv array)
//
// Pure and synchronous (no I/O); neither function throws. `host`/`site` say where the call ran, so file targets carry
// `host` and agent launches `site`; pass `home` (os.homedir()) so `~/x` resolves, else it is derived from `cwd`.
// Shell lines go through a small lexer (quotes, $(), heredocs, redirections, simple $VAR tracking) and recognisers for
// kubectl, ssh/scp/rsync, agent launches (omp/claude/codex/dsh) and common file commands; anything not recognised yields
// no target. A remote command (`ssh host …`, `kubectl exec pod -- …`) runs in a scope of its own: its files get the
// remote host id (site id, raw ssh target, or podHostId), `~/x` stays unexpanded (remote home unknown), relative paths
// need a known cwd, and files in a pod without a fleet site or in a deployment (no host id) are dropped. kubectl falls
// back to NAMESPACE for fleet clusters. A label selector (-l) is reported as `selector` on a k8s target (never as a name).
// Previews are one line, secrets redacted, ≤ LIMITS.previewChars; heredoc bodies and stdin text never reach them.

import { posix } from "node:path";
import { LIMITS, NAMESPACE, podHostId, siteOfCluster, siteOfSshTarget } from "./protocol.mjs";
import { redactText } from "./redact.mjs";

const DYN = "\uE003"; // an expansion that could not be resolved
const VAR = "\uE000", QVAR = "\uE001", END = "\uE002"; // variable reference markers inside lexed words
const REF = /([\uE000\uE001])([^\uE002]*)\uE002/g;
const clean = s => s.replace(/[\uE000-\uE002]/g, "");

const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
const str = v => (typeof v === "string" && v.trim() !== "" ? v : undefined);
const base = w => w.slice(w.lastIndexOf("/") + 1);
const oneLine = t => t.replace(/\s+/g, " ").trim();
const dyn = w => typeof w !== "string" || w.includes(DYN);
const V = list => new Set(list.split(" ").filter(Boolean));
const pv = t => redactText(oneLine(String(t ?? "").slice(0, 4000)), LIMITS.previewChars);

// ───────────────────────────────────────────── shell lexer ─────────────────────────────────────────────
// lexShell(text) → Stmt[]; Stmt = {words, redirs, nested}. Words are unquoted; `$VAR` stays as VAR…END markers so
// quoting is known when it is expanded later; `nested` holds the statements of $(…), `…`, <(…) and ( … ) groups.
// Heredoc bodies are cut out of the text and attached to their redirection ({op:"<<", heredoc:{body,…}}). `marks`
// (optional) collects display edits for previews: top-level newlines, line continuations and heredoc body cuts.

const SPECIAL = new Set([" ", "\t", "\r", "\n", ";", "&", "|", "(", ")", "<", ">", "'", '"', "\\", "$", "`"]);
const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;
const MAX_NEST = 24;

function lexShell(src, marks) {
  return lexSeq({ s: clean(src), i: 0, pending: [], marks, depth: 0 }, false);
}
function lexSeq(L, inParen) {
  if (!inParen) return seq(L, false);
  if (L.depth >= MAX_NEST) { L.i = L.s.length; return []; } // absurd nesting: give up on the rest of the text
  L.depth++;
  try { return seq(L, true); } finally { L.depth--; }
}

function seq(L, inParen) {
  const s = L.s, n = s.length, out = [];
  let st = { words: [], redirs: [], nested: [] }, w = null, redir = null;
  const add = t => { (w ??= { t: "", q: false }).t += t; };
  const quoted = () => { (w ??= { t: "", q: false }).q = true; };
  const ref = (dq, name) => add((dq ? QVAR : VAR) + name + END);
  const nest = () => st.nested.push(lexSeq(L, true));
  const flush = () => {
    if (w === null) return;
    const word = w;
    w = null;
    if (redir) {
      redir.word = word.t;
      if (redir.heredoc) {
        redir.heredoc.delim = word.t;
        L.pending.push(redir.heredoc);
      }
      st.redirs.push(redir);
      redir = null;
    } else st.words.push(word.t);
  };
  const end = () => {
    flush();
    if (redir) { st.redirs.push(redir); redir = null; }
    if (st.words.length || st.redirs.length || st.nested.length) out.push(st);
    st = { words: [], redirs: [], nested: [] };
  };
  const bodies = nl => { // heredoc bodies start on the line after the operator and end at the delimiter line
    let delim = "";
    for (let h = L.pending.shift(); h; h = L.pending.shift()) {
      const lines = [];
      delim = h.delim;
      while (L.i < n) {
        let eol = s.indexOf("\n", L.i);
        if (eol === -1) eol = n;
        const line = s.slice(L.i, eol).replace(/\r$/, "");
        if ((h.strip ? line.replace(/^\t+/, "") : line) === delim) { L.i = eol; break; } // stays on the newline
        lines.push(line);
        L.i = Math.min(n, eol + 1);
      }
      h.body = lines.join("\n");
      if (L.pending.length && s[L.i] === "\n") L.i++; // the next body starts on the following line
    }
    L.marks?.push({ at: nl, len: L.i - nl, to: ` … ${delim}` });
  };
  const ansi = () => { // $'…' (L.i is after the opening quote)
    let t = "";
    while (L.i < n && s[L.i] !== "'") {
      if (s[L.i] === "\\" && L.i + 1 < n) {
        const e = s[L.i + 1];
        L.i += 2;
        if (e === "n") t += "\n";
        else if (e === "t") t += "\t";
        else if (e === "r") t += "\r";
        else if (e === "x") {
          const m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(L.i, L.i + 2));
          if (m) { t += String.fromCharCode(parseInt(m[0], 16)); L.i += m[0].length; } else t += "x";
        } else if (/[0-7]/.test(e)) {
          const m = /^[0-7]{0,2}/.exec(s.slice(L.i, L.i + 2));
          t += String.fromCharCode(parseInt(e + m[0], 8));
          L.i += m[0].length;
        } else t += e;
      } else t += s[L.i++];
    }
    L.i++;
    quoted();
    add(t);
  };
  const backtick = dq => {
    let j = L.i + 1, raw = "";
    while (j < n && s[j] !== "`") {
      if (s[j] === "\\" && j + 1 < n && "`\\$".includes(s[j + 1])) { raw += s[j + 1]; j += 2; } else raw += s[j++];
    }
    L.i = Math.min(n, j + 1);
    if (L.depth < MAX_NEST) st.nested.push(lexSeq({ s: raw, i: 0, pending: [], depth: L.depth + 1 }, false));
    ref(dq, "?");
  };
  const dollar = dq => {
    const nx = s[L.i + 1];
    if (nx === "(") {
      if (s[L.i + 2] === "(") { // $(( arithmetic ))
        let depth = 0, j = L.i + 1;
        for (; j < n; j++) { if (s[j] === "(") depth++; else if (s[j] === ")" && --depth === 0) break; }
        L.i = Math.min(n, j + 1);
      } else {
        L.i += 2;
        nest();
      }
      ref(dq, "?");
      return;
    }
    if (nx === "{") {
      let depth = 0, j = L.i + 1;
      for (; j < n; j++) { if (s[j] === "{") depth++; else if (s[j] === "}" && --depth === 0) break; }
      const inner = s.slice(L.i + 2, j);
      L.i = Math.min(n, j + 1);
      ref(dq, /^[A-Za-z_]\w*$/.test(inner) ? inner : "?");
      return;
    }
    IDENT.lastIndex = L.i + 1;
    const m = IDENT.exec(s);
    if (m) { ref(dq, m[0]); L.i += 1 + m[0].length; return; }
    if (nx !== undefined && "0123456789@*#?$!-".includes(nx)) { ref(dq, "?"); L.i += 2; return; }
    if (nx === "'" && !dq) { L.i += 2; ansi(); return; }
    if (nx === '"' && !dq) { L.i++; return; }
    add("$");
    L.i++;
  };
  const dquote = () => {
    L.i++;
    quoted();
    while (L.i < n) {
      const c = s[L.i];
      if (c === '"') { L.i++; return; }
      if (c === "\\") {
        const e = s[L.i + 1];
        if (e === undefined) { L.i++; return; }
        if (e === '"' || e === "\\" || e === "$" || e === "`") add(e);
        else if (e !== "\n") add("\\" + e);
        L.i += 2;
        continue;
      }
      if (c === "$") { dollar(true); continue; }
      if (c === "`") { backtick(true); continue; }
      let j = L.i + 1;
      while (j < n && s[j] !== '"' && s[j] !== "\\" && s[j] !== "$" && s[j] !== "`") j++;
      add(s.slice(L.i, j));
      L.i = j;
    }
  };

  while (L.i < n) {
    const c = s[L.i];
    switch (c) {
      case " ": case "\t": case "\r": flush(); L.i++; break;
      case "\n": {
        const nl = L.i;
        end();
        L.i++;
        if (L.pending.length) bodies(nl); else L.marks?.push({ at: nl, len: 1, nl: true });
        break;
      }
      case ";": end(); L.i += s[L.i + 1] === ";" ? 2 : 1; break;
      case "|": end(); L.i += s[L.i + 1] === "|" || s[L.i + 1] === "&" ? 2 : 1; break;
      case "&":
        if (s[L.i + 1] === ">") {
          flush();
          const app = s[L.i + 2] === ">";
          redir = { op: app ? "&>>" : "&>" };
          L.i += app ? 3 : 2;
        } else { end(); L.i += s[L.i + 1] === "&" ? 2 : 1; }
        break;
      case "(":
        if (w !== null && w.t.endsWith("=")) { // array assignment: name=(a b c)
          let depth = 0, j = L.i;
          for (; j < n; j++) { if (s[j] === "(") depth++; else if (s[j] === ")" && --depth === 0) break; }
          quoted();
          add(s.slice(L.i, j + 1));
          L.i = Math.min(n, j + 1);
        } else { flush(); L.i++; nest(); }
        break;
      case ")": end(); L.i++; if (inParen) return out; break;
      case "'": { const j = s.indexOf("'", L.i + 1), e = j === -1 ? n : j; quoted(); add(s.slice(L.i + 1, e)); L.i = e + 1; break; }
      case '"': dquote(); break;
      case "$": dollar(false); break;
      case "`": backtick(false); break;
      case "\\": {
        const e = s[L.i + 1];
        if (e === "\n") L.marks?.push({ at: L.i, len: 2, to: " " });
        else if (e !== undefined) { quoted(); add(e); }
        L.i += e === undefined ? 1 : 2;
        break;
      }
      case "<": case ">": {
        if (s[L.i + 1] === "(") { L.i += 2; nest(); ref(false, "?"); break; }
        let fd = null;
        if (w !== null && !w.q && /^\d+$/.test(w.t)) { fd = w.t; w = null; } else flush();
        const n1 = s[L.i + 1], n2 = s[L.i + 2];
        let op = c;
        if (c === "<") {
          if (n1 === "<" && n2 === "<") { op = "<<<"; L.i += 3; }
          else if (n1 === "<") {
            const strip = n2 === "-";
            L.i += strip ? 3 : 2;
            redir = { op: "<<", fd, heredoc: { strip, delim: "", body: "" } };
            break;
          } else if (n1 === "&") { op = "<&"; L.i += 2; }
          else if (n1 === ">") { op = "<>"; L.i += 2; }
          else L.i++;
        } else if (n1 === ">") { op = ">>"; L.i += 2; }
        else if (n1 === "&") { op = ">&"; L.i += 2; }
        else if (n1 === "|") { op = ">|"; L.i += 2; }
        else L.i++;
        redir = { op, fd };
        break;
      }
      default: {
        if (c === "#" && w === null) { while (L.i < n && s[L.i] !== "\n") L.i++; break; }
        let j = L.i + 1;
        while (j < n && !SPECIAL.has(s[j])) j++;
        add(s.slice(L.i, j));
        L.i = j;
      }
    }
  }
  end();
  return out;
}

// ───────────────────────────────────────────── scopes and targets ─────────────────────────────────────────────
// scope = where a command runs: {host, site, cwd, home, env, remote, pod}. ctx collects targets and category flags.

function rootScope(o) {
  const cwd = str(o.cwd);
  const home = str(o.home) ?? (cwd ? /^(\/Users\/[^/]+|\/home\/[^/]+|\/root)(?=\/|$)/.exec(cwd)?.[1] : undefined);
  return { host: o.host, site: o.site, cwd, home, env: new Map(), remote: false, pod: undefined };
}
const cloneScope = s => ({ ...s, env: new Map(s.env) });
const remoteScope = (host, site, pod, cwd) => ({ host, site, cwd, home: undefined, env: new Map(), remote: true, pod });
const newCtx = () => ({ targets: [], keys: new Set(), spawn: false, k8s: false, remote: false, patch: null, depth: 0, steps: 0, chars: 0 });

function T(type, fields) {
  const t = { type };
  for (const k in fields) { const v = fields[k]; if (v !== undefined && v !== "") t[k] = v; }
  return t;
}
function push(ctx, t) {
  const key = [t.type, t.op, t.host, t.path ?? t.url ?? t.name, t.selector, t.site, t.cluster, t.namespace, t.container, t.resource, t.kind, t.pod].join("\u0001");
  if (ctx.keys.has(key) || ctx.targets.length >= 256) return;
  ctx.keys.add(key);
  ctx.targets.push(t);
}
// Over the cap, non-file targets win (they are few and structural); files keep their order.
function finish(ctx) {
  const cap = LIMITS.maxTargetsPerEvent;
  if (ctx.targets.length <= cap) return ctx.targets;
  const keep = new Set();
  for (const files of [false, true]) {
    for (let i = 0; i < ctx.targets.length && keep.size < cap; i++) if ((ctx.targets[i].type === "file") === files) keep.add(i);
  }
  return ctx.targets.filter((_, i) => keep.has(i));
}

const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const SYSTEM_BIN = /^\/(?:usr\/(?:local\/)?)?s?bin\/|^\/opt\/homebrew\/s?bin\//;

// Positional operands of commands that take files: not flags, numbers, assignments, URLs or multi-line text.
const plausible = w => !(/^\d+$/.test(w) || /^[-+]/.test(w) || URL_RE.test(w) || /^[A-Za-z_]\w*=[^/]/.test(w) || w.includes("\n"));

function resolvePath(word, scope) {
  if (dyn(word) || word === "" || word === "-") return null;
  let p = word;
  if (p === "~" || p.startsWith("~/")) {
    if (scope.home) p = scope.home + p.slice(1);
    else return p === "~" ? p : "~/" + posix.normalize(p.slice(2)).replace(/\/$/, "");
  } else if (p.startsWith("~")) return null;
  if (!p.startsWith("/")) {
    if (!scope.cwd) return null;
    p = posix.join(scope.cwd, p);
  }
  p = posix.normalize(p);
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p === "/dev" || p.startsWith("/dev/") ? null : p;
}
// bash brace expansion of comma lists (`a/{b,c}.py`), capped; words with glob characters stay as written.
function braces(word) {
  const m = word.length <= 512 ? /^(.*?)\{([^{}]*,[^{}]*)\}(.*)$/s.exec(word) : null;
  if (!m || /[*?[]/.test(word)) return [word];
  const out = [];
  for (const alt of m[2].split(",")) {
    for (const w of braces(m[1] + alt + m[3])) {
      out.push(w);
      if (out.length >= 16) return out;
    }
  }
  return out;
}
function addFile(ctx, scope, word, op) {
  if (dyn(word) || word.length > 4096 || word.includes("{}") || (scope.remote && scope.host == null) || !plausible(word)) return;
  for (const w of braces(word)) {
    const path = resolvePath(w, scope);
    if (path) push(ctx, T("file", { op, host: scope.host, path }));
  }
}
function addUrl(ctx, u) {
  if (!dyn(u)) push(ctx, T("url", { url: redactText(u, LIMITS.cmdChars) }));
}
function launch(ctx, scope, kind, transport = "cli") {
  ctx.spawn = true;
  push(ctx, T("agent", { op: "launch", kind, site: scope.site ?? null, pod: scope.pod, transport }));
}

// ───────────────────────────────────────────── interpreter ─────────────────────────────────────────────

function lookup(name, scope) {
  if (name === "HOME") return scope.home ?? "~";
  if (name === "PWD") return scope.cwd;
  return scope.env.get(name);
}
const expand1 = (w, scope) => (w.includes(VAR) || w.includes(QVAR) ? w.replace(REF, (_, __, name) => lookup(name, scope) ?? DYN) : w);
// A bare unquoted `$VAR` splits on whitespace (`K="kubectl -n x"; $K get pods`); anything else expands in place.
function expandWords(words, scope) {
  const out = [];
  for (const w of words) {
    const m = /^\uE000([^\uE002]*)\uE002$/.exec(w);
    if (!m) { out.push(expand1(w, scope)); continue; }
    const v = lookup(m[1], scope);
    if (v === undefined) out.push(DYN);
    else if (v.trim() !== "") out.push(...v.trim().split(/\s+/));
  }
  return out;
}
function setVar(scope, assign) {
  const eq = assign.indexOf("=");
  const name = assign.slice(0, eq), value = assign.slice(eq + 1);
  if (dyn(value)) scope.env.delete(name); else scope.env.set(name, value);
}

function runScript(text, scope, ctx, stdin = null) {
  if (ctx.depth >= 8 || typeof text !== "string" || text === "") return;
  if ((ctx.chars += text.length) > MAX_CHARS) return; // wrapper strings re-lexed inside loops cannot multiply the work
  ctx.depth++;
  try { runBlock(lexShell(text), scope, ctx, stdin); } finally { ctx.depth--; }
}
// Statements in order. `for VAR in WORDS; do …; done` runs its body once per word (the first few) with VAR bound.
// `ctx.steps` bounds the work of one analysis, so nested loops cannot multiply into minutes.
const LOOPS = V("for while until select");
const OPENERS = V("do then else elif { !"); // reserved words that may precede the first word of a statement
const MAX_LOOP_VALUES = 4, MAX_STEPS = 40000, MAX_CHARS = 3_000_000;
const firstWord = words => { let k = 0; while (k < words.length && OPENERS.has(words[k])) k++; return k; };
function loopEnds(stmts) { // loop opener index → index of its closing `done`
  const ends = new Map(), open = [];
  stmts.forEach((st, i) => {
    const w = st.words[firstWord(st.words)];
    if (LOOPS.has(w)) open.push(i);
    else if (w === "done" && open.length) ends.set(open.pop(), i);
  });
  return ends;
}
function runBlock(stmts, scope, ctx, stdin) {
  let ends = null;
  for (let i = 0; i < stmts.length; i++) {
    if (++ctx.steps > MAX_STEPS) return;
    const st = stmts[i], w = st.words.slice(firstWord(st.words));
    if (w[0] !== "for" || w[2] !== "in" || !/^[A-Za-z_]\w*$/.test(w[1])) { runStatement(st, scope, ctx, stdin); continue; }
    runNested(st, scope, ctx);
    ends ??= loopEnds(stmts);
    const end = ends.get(i) ?? stmts.length, body = stmts.slice(i + 1, end);
    const values = expandWords(w.slice(3), scope).filter(v => !dyn(v)).slice(0, MAX_LOOP_VALUES);
    for (const v of values.length ? values : [DYN]) {
      setVar(scope, `${w[1]}=${v}`);
      runBlock(body, scope, ctx, stdin);
    }
    scope.env.delete(w[1]);
    if (end < stmts.length) runStatement(stmts[end], scope, ctx, stdin); // `done < file`, `done | cmd`
    i = end;
  }
}
function runNested(st, scope, ctx) { // $(…), `…`, <(…) and ( … ) run in a copy of the scope
  for (const group of st.nested) {
    const sub = cloneScope(scope);
    for (const inner of group) runStatement(inner, sub, ctx, null);
  }
}
function runStatement(st, scope, ctx, inherited) {
  if (++ctx.steps > MAX_STEPS) return;
  runNested(st, scope, ctx);
  let stdin = inherited;
  for (const r of st.redirs) {
    if (r.op === "<<") stdin = r.heredoc.body;
    else if (r.op === "<<<") stdin = expand1(r.word ?? "", scope) + "\n";
  }
  const words = expandWords(st.words, scope);
  if (words.length) runCommand(words, scope, ctx, stdin);
  for (const r of st.redirs) {
    const target = expand1(r.word ?? "", scope);
    switch (r.op) {
      case "<": addFile(ctx, scope, target, "read"); break;
      case ">": case ">>": case ">|": case "&>": case "&>>": case "<>": addFile(ctx, scope, target, "write"); break;
      case ">&": if (!/^(\d+|-)$/.test(target)) addFile(ctx, scope, target, "write"); break;
    }
  }
}

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const RESERVED = V("if then else elif fi do done while until ! { } case esac function select");
const WRAPPERS = new Map(Object.entries({
  sudo: { valued: V("-u -g -C -D -h -p -r -t -T -U --user --group --chdir --host --prompt --role --type") },
  doas: { valued: V("-u -C") },
  nohup: {}, setsid: {}, unbuffer: {}, builtin: {},
  time: { valued: V("-o -f --output --format") },
  timeout: { valued: V("-k -s --kill-after --signal"), pos: 1 },
  nice: { valued: V("-n --adjustment") },
  ionice: { valued: V("-c -n -p -P -u -t") },
  env: { valued: V("-u -C -S --unset --chdir --split-string") },
  command: { lookup: true },
  exec: { valued: V("-a") },
  stdbuf: { valued: V("-i -o -e --input --output --error") },
  caffeinate: { valued: V("-t -w") },
  watch: { valued: V("-n --interval") },
  xargs: { valued: V("-I -n -P -L -s -E -d -a -R -S --max-args --max-procs --max-lines --max-chars --delimiter --arg-file --replace --eof") },
}));

// Consumes the flag at args[j] (and its separate value); returns the next index.
function eatFlag(args, j, valued) {
  const a = args[j];
  if (a.startsWith("--")) return a.includes("=") || !valued.has(a) ? j + 1 : j + 2;
  for (let k = 1; k < a.length; k++) if (valued.has("-" + a[k])) return k === a.length - 1 ? j + 2 : j + 1;
  return j + 1;
}
// Splits args into positionals and [flag, value|null] pairs. `valued` flags take a value; `--` ends options.
function scan(args, valued = new Set()) {
  const pos = [], opts = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { pos.push(...args.slice(i + 1)); break; }
    if (a.length < 2 || a[0] !== "-") { pos.push(a); continue; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) opts.push([a.slice(0, eq), a.slice(eq + 1)]);
      else opts.push([a, valued.has(a) ? (args[++i] ?? null) : null]);
      continue;
    }
    for (let k = 1; k < a.length; k++) {
      const f = "-" + a[k];
      if (valued.has(f)) {
        const attached = a.slice(k + 1).replace(/^=/, "");
        opts.push([f, attached !== "" ? attached : (args[++i] ?? null)]);
        break;
      }
      opts.push([f, null]);
    }
  }
  return { pos, opts };
}
const lastOpt = (opts, ...names) => {
  for (let i = opts.length - 1; i >= 0; i--) if (names.includes(opts[i][0]) && opts[i][1] != null) return opts[i][1];
  return undefined;
};
const hasOpt = (opts, ...names) => opts.some(([f]) => names.includes(f));

function skipWrapper(words, i, spec) {
  const valued = spec.valued ?? new Set();
  let j = i + 1;
  for (; j < words.length; j++) {
    const a = words[j];
    if (a === "--") { j++; break; }
    if (spec.lookup && (a === "-v" || a === "-V")) return words.length;
    if (a.length < 2 || a[0] !== "-") break;
    j = eatFlag(words, j, valued) - 1;
  }
  return Math.min(words.length, j + (spec.pos ?? 0));
}
// Index of the command word after assignments, reserved words and wrappers (sudo, env, timeout, …).
function commandStart(words, assigns) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (ASSIGN.test(w)) { assigns?.push(w); i++; continue; }
    if (RESERVED.has(w)) { i++; continue; }
    const wrap = dyn(w) ? undefined : WRAPPERS.get(base(w));
    if (!wrap) break;
    i = skipWrapper(words, i, wrap);
  }
  return i;
}

function runCommand(words, scope, ctx, stdin) {
  const assigns = [];
  const i = commandStart(words, assigns);
  if (i >= words.length) { for (const a of assigns) setVar(scope, a); return; }
  const cmd = words[i], args = words.slice(i + 1);
  if (dyn(cmd)) return;
  const b = base(cmd);
  const handler = HANDLERS.get(b) ?? (/^python[0-9.]*$/.test(b) ? interpreter(PYTHON) : null);
  if (handler) handler(args, scope, ctx, stdin, cmd);
  else if (cmd.includes("/") && !SYSTEM_BIN.test(cmd)) addFile(ctx, scope, cmd, "exec");
}

// ───────────────────────────────────────────── agents, interpreters, shells ─────────────────────────────────────────────

const AGENT_BINS = new Map(Object.entries({
  omp: ["omp", "cli"], claude: ["claude", "cli"], codex: ["codex", "cli"], dsh: ["dsh", "cli"],
  "claude-agent-acp": ["claude", "acp"], "claude-code-acp": ["claude", "acp"], "codex-acp": ["codex", "acp"],
}));
const AGENT_PATHS = [
  [/\/pi-coding-agent\/|\/@oh-my-pi\/|\/oh-my-pi\//, "omp"],
  [/\/@deepseek-ai\/dsh\/|\/dsh\/lib\/bin\.js$/, "dsh"],
  [/@anthropic-ai\/claude-code|\/claude-code\//, "claude"],
  [/@openai\/codex|\/codex-cli\//, "codex"],
];
const NOT_A_SESSION = V("help version config login logout update upgrade install setup doctor mcp plugin plugins completion completions features auth apply " +
  "agents anonymize bench cleanse clip commit complete compress find gallery gc git grep images join models play predict ps read render say " +
  "session settings share shell skill ssh stats stream token toks ttsr usage web-search worktree migrate-installer setup-token review sandbox");
/** Flags that print something and exit: an invocation carrying one starts no session (`dsh --profile web --dump-config`). */
const PRINT_ONLY = V("--dump-config --dump-default-config --dump-config-schema --print-config --show-config");
/** Flags whose next word is a value, skipped before the first command word is read (dsh: `--profile web plugin add …`). */
const LEAD_VALUED = Object.freeze({ dsh: V("--profile --patch") });

function agentCommand(args, bin) {
  const [kind, transport] = AGENT_BINS.get(bin);
  if (args.some(a => a === "--version" || a === "-V" || a === "--help" || a === "-h")) return null;
  if (args.some(a => PRINT_ONLY.has(a.split("=")[0]))) return null;
  if (args[0] && !args[0].startsWith("-") && NOT_A_SESSION.has(args[0])) return null;
  const valued = LEAD_VALUED[kind];
  if (valued) {
    const word = commandWord(args, valued);
    if (word !== undefined && NOT_A_SESSION.has(word)) return null;
  }
  if (args[0]?.startsWith("__omp_")) return null; // omp's own worker processes
  return { kind, transport: transport === "acp" || args[0] === "acp" || args.includes("--acp") ? "acp" : "cli" };
}
/** First argument that is not a flag and not the value of one of `valued` (`--flag value` / `--flag=value`). */
function commandWord(args, valued) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith("-")) { if (valued.has(arg)) i += 1; continue; }
    return arg;
  }
  return undefined;
}
function agentScript(script, rest) {
  const direct = base(script);
  if (AGENT_BINS.has(direct)) return agentCommand(rest, direct);
  const hit = AGENT_PATHS.find(([re]) => re.test(script));
  return hit ? agentCommand(rest, hit[1]) : null;
}
function agentBin(bin) {
  return (args, scope, ctx) => {
    const a = agentCommand(args, bin);
    if (a) launch(ctx, scope, a.kind, a.transport);
  };
}

// `code`: flags whose argument is code or a module, so there is no script file to report. `files`: perl/ruby one-liners
// (`-pe CODE file…`) read the files that follow the code, or rewrite them with -i.
const PYTHON = { code: V("-c -m"), valued: V("-W -X -Q --check-hash-based-pycs") };
const NODE = { code: V("-e -p --eval --print"), valued: V("-r --require --import --loader --experimental-loader --input-type -C --conditions --env-file --title --max-old-space-size --stack-size") };
const BUN = { code: V("-e -p --eval --print"), valued: V("--preload -r --cwd --env-file --config -c --port"), sub: V("run"), skip: V("install add remove update pm test build x create init upgrade link unlink outdated patch publish repl") };
const SCRIPTING = { code: V("-e -E"), valued: V("-I -M -m -C -d -r -x"), files: true }; // ruby, perl, php
const IN_PLACE = /^-[0-9pnalwsTWtUuSc]*i/; // perl/ruby -i, -pi, -i.bak, -0777pi

// `python3 x.py`, `node x.mjs`, `bun run x.ts`, …: the script is an exec target, unless it is the cluster wrapper
// (access.py) or an agent entry point.
function interpreter(spec) {
  const letters = [...spec.code].filter(f => /^-[A-Za-z]$/.test(f)).map(f => f[1]).join("");
  const shortCode = new RegExp(`^-[A-Za-z0-9]*[${letters}]$`);
  const isCode = a => (a.startsWith("--") ? spec.code.has(a.split("=")[0]) : shortCode.test(a));
  return (args, scope, ctx, stdin) => {
    let i = 0, inline = false, inPlace = false;
    for (; i < args.length; i++) {
      const a = args[i];
      if (a === "--") { i++; break; }
      if (a === "-") return;
      if (a.length < 2 || a[0] !== "-") break;
      if (spec.files && IN_PLACE.test(a)) inPlace = true;
      if (isCode(a)) {
        if (!spec.files) return;
        inline = true;
        if (/[eE]$/.test(a)) i++; // the code is the next argument
        continue;
      }
      i = eatFlag(args, i, spec.valued) - 1;
    }
    if (inline) { for (const f of args.slice(i)) addFile(ctx, scope, f, inPlace ? "edit" : "read"); return; }
    let script = args[i];
    if (script === undefined || dyn(script)) return;
    if (spec.sub?.has(script)) script = args[++i];
    if (script === undefined || spec.skip?.has(script)) return;
    const rest = args.slice(i + 1);
    if (/(^|\/)access\.py$/.test(script)) { accessWrapper(rest, scope, ctx, stdin); return; }
    const agent = agentScript(script, rest);
    if (agent) launch(ctx, scope, agent.kind, agent.transport);
    else addFile(ctx, scope, script, "exec");
  };
}
function packageRunner(args, scope, ctx) { // npx / bunx <package> …
  const at = args.findIndex(a => !a.startsWith("-"));
  const agent = at !== -1 && agentScript(args[at], args.slice(at + 1));
  if (agent) launch(ctx, scope, agent.kind, agent.transport);
}

const SHELLS_VALUED = V("-o +o --rcfile --init-file");
function shellCommand(args, scope, ctx, stdin) { // bash/sh/zsh: -c script | -s / heredoc | script file
  let i = 0, fromStdin = false;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { i++; break; }
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) { runScript(args[i + 1], scope, ctx, stdin); return; }
    if (a.length < 2 || (a[0] !== "-" && a[0] !== "+")) break;
    if (/^-[A-Za-z]*s[A-Za-z]*$/.test(a)) fromStdin = true;
    i = eatFlag(args, i, SHELLS_VALUED) - 1;
  }
  if (fromStdin || args[i] === undefined || args[i] === "-") { if (stdin) runScript(stdin, scope, ctx); return; }
  addFile(ctx, scope, args[i], "exec");
}
function sourceCommand(args, scope, ctx) { if (args[0]) addFile(ctx, scope, args[0], "exec"); }
function cdCommand(args, scope) {
  const dir = args.find(a => a === "-" || !a.startsWith("-"));
  if (dir === undefined) scope.cwd = scope.home ?? (scope.remote ? "~" : undefined);
  else if (dir === "-" || dyn(dir)) scope.cwd = undefined;
  else scope.cwd = resolvePath(dir, scope) ?? undefined;
}
function exportCommand(args, scope) { for (const a of args) if (ASSIGN.test(a)) setVar(scope, a); }

// ───────────────────────────────────────────── kubectl ─────────────────────────────────────────────

const KUBE_BASE = V("-n --namespace --context --kubeconfig -c --container -l --selector -o --output -s --server --request-timeout --cluster " +
  "--user --token --as --as-group --as-uid --pod-running-timeout --timeout --tail --since --since-time --field-selector --sort-by -L " +
  "--label-columns --template --limit-bytes --max-log-requests --replicas --image --target --profile --copy-to --grace-period --address " +
  "--field-manager --overrides -k --kustomize --certificate-authority --client-certificate --client-key --cache-dir --username --password " +
  "--tls-server-name --chunk-size --raw --subresource --for --type -v --v --env --labels --annotations --port --requests --limits " +
  "--restart --serviceaccount --from-file --from-literal --from-env-file");
const KUBE_FILE = new Set([...KUBE_BASE, "-f", "--filename"]); // -f is a flag for logs (follow), a file elsewhere
const KUBE_PATCH = new Set([...KUBE_FILE, "-p", "--patch"]);
const KUBE_QUIET = V("config version cluster-info api-resources api-versions explain completion plugin help auth proxy options alpha");
const KUBE_POD_GROUP = V("exec attach logs port-forward debug");
const POD_OPS = { exec: "exec", attach: "exec", debug: "exec", logs: "logs", get: "get", top: "get", describe: "describe", delete: "delete", cp: "cp",
  "port-forward": "port-forward", apply: "apply", create: "apply", replace: "apply", patch: "apply", edit: "apply", label: "apply",
  annotate: "apply", run: "apply" };
const KIND_ALIASES = { po: "pod", deploy: "deployment", svc: "service", ds: "daemonset", sts: "statefulset", rs: "replicaset", cj: "cronjob",
  no: "node", ns: "namespace", cm: "configmap", pv: "persistentvolume", pvc: "persistentvolumeclaim", ing: "ingress", ev: "event",
  sa: "serviceaccount", ep: "endpoints", hpa: "horizontalpodautoscaler", netpol: "networkpolicy" };
const KIND_REF = /^([A-Za-z][\w.-]*)\/(.+)$/;

function kindName(raw) {
  const k = raw.toLowerCase().split(".")[0];
  if (KIND_ALIASES[k]) return KIND_ALIASES[k];
  if (k === "endpoints" || k === "status") return k;
  if (k.endsWith("ies")) return k.slice(0, -3) + "y";
  if (k.endsWith("sses")) return k.slice(0, -2);
  return k.length > 3 && k.endsWith("s") && !k.endsWith("ss") ? k.slice(0, -1) : k;
}

function accessWrapper(args, scope, ctx, stdin) { // …/access.py kubectl <cluster> -- <kubectl args>
  if (args[0] !== "kubectl") return;
  let rest = args.slice(2);
  if (rest[0] === "--") rest = rest.slice(1);
  kubectl(rest, scope, ctx, stdin, args[1]);
}

function kubectl(args, scope, ctx, stdin, wrapperCluster) {
  ctx.k8s = true;
  const dd = args.indexOf("--");
  const head = dd === -1 ? args : args.slice(0, dd), tail = dd === -1 ? null : args.slice(dd + 1);
  const verb = scan(head, KUBE_BASE).pos[0];
  if (verb === undefined || dyn(verb) || KUBE_QUIET.has(verb)) return;
  const { pos, opts } = scan(head, verb === "logs" || verb === "exec" ? KUBE_BASE : verb === "patch" ? KUBE_PATCH : KUBE_FILE);
  const rest = pos.slice(1);

  const ctxName = lastOpt(opts, "--context") ?? wrapperCluster;
  const cluster = ctxName && !dyn(ctxName) ? ctxName : undefined;
  const site = cluster ? siteOfCluster(cluster) : null;
  const nsOpt = lastOpt(opts, "-n", "--namespace");
  const namespace = nsOpt === undefined ? (site && !hasOpt(opts, "-A", "--all-namespaces") ? NAMESPACE : undefined) : dyn(nsOpt) ? undefined : nsOpt;
  const containerOpt = lastOpt(opts, "-c", "--container"), selectorOpt = lastOpt(opts, "-l", "--selector");
  const c = {
    verb, site, cluster, namespace,
    container: containerOpt !== undefined && !dyn(containerOpt) ? containerOpt : undefined,
    selector: selectorOpt !== undefined && !dyn(selectorOpt) ? selectorOpt : undefined,
  };

  if (verb === "cp") { kubeCopy(rest, c, scope, ctx); return; }
  if (KUBE_POD_GROUP.has(verb)) {
    const ref = kubeRef(ctx, c, rest[0]);
    if (verb === "exec") {
      const inner = tail ?? rest.slice(1);
      if (inner.length) runCommand(inner, podScope(c, ref), ctx, stdin);
    }
    return;
  }
  const manifest = [];
  for (const [k, v] of opts) {
    if (v == null || !["-f", "--filename", "-k", "--kustomize"].includes(k)) continue;
    if (v === "-") { if (stdin) manifest.push(...manifestObjects(stdin)); }
    else if (URL_RE.test(v)) addUrl(ctx, v);
    else addFile(ctx, scope, v, "read");
  }
  for (const o of manifest.slice(0, 8)) emitRef(ctx, { ...c, namespace: o.namespace ?? c.namespace }, o);
  if (verb === "run") {
    if (rest[0] !== undefined && !dyn(rest[0])) emitRef(ctx, c, { kind: "pod", name: rest[0] });
    return;
  }
  if (verb === "cordon" || verb === "uncordon" || verb === "drain") { // the operands are node names, not kinds
    for (const node of rest.slice(0, 8)) if (!dyn(node)) emitRef(ctx, c, { kind: "node", name: node });
    return;
  }
  let names = rest;
  if (verb === "rollout" || verb === "set" || verb === "certificate") names = rest.slice(1);
  if (verb === "create" && names.length > 1 && (names[0] === "secret" || names[0] === "service")) names = [names[0], ...names.slice(2)];
  if (names.length || manifest.length === 0) kubeResources(ctx, c, names);
}

// kind: Pod / metadata.name / metadata.namespace of every document of a manifest piped through `-f -`.
function manifestObjects(text) {
  const out = [];
  for (const doc of String(text).slice(0, 200000).split(/^---[ \t]*$/m)) {
    let kind, name, namespace, meta = false, indent = null;
    for (const line of doc.split("\n")) {
      if (/^kind:/.test(line)) kind = /^kind:\s*["']?([A-Za-z]+)/.exec(line)?.[1]?.toLowerCase();
      else if (/^metadata:\s*$/.test(line)) { meta = true; indent = null; }
      else if (meta && line.trim() !== "") {
        const lead = /^\s*/.exec(line)[0];
        if (lead === "") { meta = false; continue; }
        indent ??= lead;
        const m = lead === indent ? /^\s*(name|namespace):\s*["']?([^\s"'#]+)/.exec(line) : null;
        if (m?.[1] === "name") name = m[2];
        else if (m) namespace = m[2];
      }
    }
    if (kind) out.push({ kind, name, namespace });
  }
  return out;
}

// One object: a pod target for a named pod, a k8s target for everything else (a selector stands for the matching set).
function emitRef(ctx, c, ref) {
  if (ref.kind === "pod" && ref.name) {
    push(ctx, T("pod", { op: POD_OPS[c.verb] ?? "other", site: c.site ?? null, cluster: c.cluster, namespace: c.namespace, name: ref.name, container: c.container }));
  } else {
    push(ctx, T("k8s", {
      op: c.verb, site: c.site ?? null, cluster: c.cluster, namespace: c.namespace, resource: ref.kind, name: ref.name,
      selector: ref.name ? undefined : c.selector, container: KUBE_POD_GROUP.has(c.verb) ? c.container : undefined,
    }));
  }
}
// `NAME`, `pod/NAME`, `deploy/NAME` after exec/logs/…; returns the reference for the exec scope.
function kubeRef(ctx, c, word) {
  if (word === undefined || dyn(word)) {
    emitRef(ctx, c, { kind: "pod" });
    return null;
  }
  const m = KIND_REF.exec(word);
  const ref = { kind: m ? kindName(m[1]) : "pod", name: m ? m[2] : word };
  emitRef(ctx, c, ref);
  return ref;
}
// `get pods`, `get pod a b`, `describe deploy/x`, `delete pod -l app=x`, `scale deployment x`, …
function kubeResources(ctx, c, names) {
  const [first, ...more] = names;
  const refs = [];
  if (first !== undefined && !dyn(first)) {
    if (first.includes("/")) {
      for (const w of names) {
        const m = dyn(w) ? null : KIND_REF.exec(w);
        if (m) refs.push({ kind: kindName(m[1]), name: m[2] });
      }
    } else {
      const kinds = first.split(",").map(kindName);
      const named = more.filter(w => !dyn(w) && !w.includes("=")); // label/annotate pass key=value pairs
      if (named.length) for (const name of named) refs.push({ kind: kinds[0], name });
      else for (const kind of kinds.slice(0, 4)) refs.push({ kind });
    }
  }
  if (refs.length === 0) refs.push({});
  for (const ref of refs.slice(0, 8)) emitRef(ctx, c, ref);
}
const KUBE_COPY = /^(?:([a-z0-9][a-z0-9.-]*)\/)?([a-z0-9][a-z0-9.-]*):(.*)$/;
function kubeCopy(rest, c, scope, ctx) {
  const [src, dst] = rest;
  if (src === undefined || dst === undefined) return;
  for (const [word, other, remoteOp, localOp] of [[src, dst, "read", "write"], [dst, src, "write", "read"]]) {
    const m = /^[/.~]/.test(word) || dyn(word) ? null : KUBE_COPY.exec(word);
    if (!m) continue;
    push(ctx, T("pod", { op: "cp", site: c.site ?? null, cluster: c.cluster, namespace: m[1] ?? c.namespace, name: m[2], container: c.container }));
    addFile(ctx, remoteScope(c.site ? podHostId(c.site, m[2]) : null, c.site ?? undefined, m[2]), m[3], remoteOp);
    addFile(ctx, scope, other, localOp);
  }
}
function podScope(c, ref) {
  const pod = ref?.kind === "pod" && ref.name && !dyn(ref.name) ? ref.name : undefined;
  return remoteScope(pod && c.site ? podHostId(c.site, pod) : null, c.site ?? undefined, pod);
}

// ───────────────────────────────────────────── ssh, scp, rsync ─────────────────────────────────────────────

const SSH_VALUED = V("-b -c -D -E -e -F -I -i -J -L -l -m -O -o -p -Q -R -S -W -w");
const SCP_VALUED = V("-c -D -F -i -J -l -o -P -S -X");
const RSYNC_VALUED = V("-e --rsh --rsync-path --exclude --include --exclude-from --include-from -f --filter --files-from --port --bwlimit " +
  "--timeout --contimeout --log-file --partial-dir --backup-dir --suffix --max-size --min-size -B --block-size --chmod --chown --usermap " +
  "--groupmap --compare-dest --copy-dest --link-dest -T --temp-dir --out-format --info --debug --compress-level --skip-compress " +
  "--password-file --protocol --address --sockopts --outbuf --modify-window -M --remote-option --iconv --checksum-choice");
const MOSH_VALUED = V("-p --port --ssh --server --client --predict --family --bind-server");

// Registers the host target; returns the scope commands/files on that host run in.
function remoteHost(ctx, raw, op) {
  const target = raw.replace(/^(?:ssh|scp|sftp):\/\//i, "").replace(/\/.*$/, "").replace(/^([^@:]+):[^@]*@/, "$1@");
  const site = siteOfSshTarget(target);
  push(ctx, T("host", { op, host: target, site }));
  ctx.remote = true;
  return remoteScope(site ?? target, site ?? undefined, undefined, "~"); // sessions start in the remote home
}
// ssh [options] destination [command…]: options may follow the destination; the first other word starts the command.
function parseSsh(args, valued) {
  let dest = null, i = 0, flags = "";
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { i++; if (dest === null) dest = args[i++]; break; }
    if (a.length > 1 && a[0] === "-") {
      if (a[1] !== "-") {
        for (const ch of a.slice(1)) {
          if (ch === "Q") flags += ch; // -Q lists algorithms
          if (valued.has("-" + ch)) break; // the rest of the cluster (or the next word) is that option's value
          flags += ch;
        }
      }
      i = eatFlag(args, i, valued) - 1;
      continue;
    }
    if (dest === null) { dest = a; continue; }
    break;
  }
  return { dest, command: args.slice(i), flags };
}
function sshCommand(args, scope, ctx, stdin) {
  const { dest, command, flags } = parseSsh(args, SSH_VALUED);
  if (dest == null || dyn(dest) || /[GVQ]/.test(flags)) return; // -G / -V / -Q only print information
  const remote = remoteHost(ctx, dest, "ssh");
  const script = command.join(" ");
  if (script.trim() !== "") runScript(script, remote, ctx, stdin);
  else if (stdin) runScript(stdin, remote, ctx);
}
function moshCommand(args, scope, ctx, stdin) {
  const dd = args.indexOf("--");
  const { dest } = parseSsh(dd === -1 ? args : args.slice(0, dd), MOSH_VALUED);
  if (!dest || dyn(dest)) return;
  const remote = remoteHost(ctx, dest, "ssh");
  if (dd !== -1 && dd + 1 < args.length) runCommand(args.slice(dd + 1), remote, ctx, stdin);
}
function sftpCommand(args, scope, ctx) {
  const dest = scan(args, V("-B -b -c -D -F -i -J -l -o -P -R -S -s")).pos[0];
  if (dest && !dyn(dest)) remoteHost(ctx, dest.replace(/:.*$/, ""), "scp");
}

const REMOTE_OPERAND = /^(?:([^@/:\s]+)@)?(\[[^\]\s]+\]|[^/:\s@]{2,}):(.*)$/s;
const REMOTE_URL = /^(?:scp|ssh|sftp):\/\/(?:([^@/]+)@)?([^/:]+)(?::\d+)?(\/.*)?$/i;
// scp/rsync operands: `[user@]host:path` or scp://… are remote; everything else is local. Last operand is the destination.
function transfer(op, valued) {
  return (args, scope, ctx) => {
    const { pos } = scan(args, valued);
    if (pos.length < 2) return;
    pos.forEach((word, k) => {
      if (dyn(word)) return;
      const fileOp = k === pos.length - 1 ? "write" : "read";
      let m = REMOTE_URL.exec(word), user, host, path;
      if (m) [, user, host, path] = m;
      else if (!/^[/.~]/.test(word) && !URL_RE.test(word) && (m = REMOTE_OPERAND.exec(word))) [, user, host, path] = m;
      if (!host) { addFile(ctx, scope, word, fileOp); return; }
      const remote = remoteHost(ctx, (user ? user + "@" : "") + host, op);
      addFile(ctx, remote, path === "" || path === undefined ? "~" : /^[/~]/.test(path) ? path : "~/" + path, fileOp);
    });
  };
}

// ───────────────────────────────────────────── file commands ─────────────────────────────────────────────

// Commands whose every positional is a file: name → [op, valued flags].
const OPERAND_COMMANDS = {
  cat: ["read", ""], tac: ["read", ""], nl: ["read", "-b -d -f -h -i -l -n -s -v -w"],
  head: ["read", "-n -c --lines --bytes"], tail: ["read", "-n -c -s --lines --bytes --pid"],
  less: ["read", "-b -h -j -k -o -O -p -P -t -T -x -y -z --pattern"], more: ["read", ""],
  bat: ["read", "-l --language -r --line-range -H --highlight-line --theme --style --paging --color --decorations --tabs --wrap --terminal-width --map-syntax --file-name"],
  wc: ["read", "--files0-from"], stat: ["read", "-c -f --format --printf"], file: ["read", "-m -e -F -f"],
  md5sum: ["read", ""], md5: ["read", ""], sha1sum: ["read", ""], sha256sum: ["read", ""], sha512sum: ["read", ""],
  shasum: ["read", "-a --algorithm"], cksum: ["read", ""], od: ["read", "-A -j -N -t -w -S"], xxd: ["read", "-c -g -l -s -o"],
  hexdump: ["read", "-n -s -e -f"], strings: ["read", "-n -t -e"], diff: ["read", "-U -C -x -X -I -F --label -W"],
  cmp: ["read", "-n -i"], comm: ["read", ""], sort: ["read", "-k -t -o -T -S --key --field-separator --output --buffer-size"],
  uniq: ["read", "-f -s -w"], cut: ["read", "-d -f -c -b --delimiter --fields --characters --bytes"],
  zcat: ["read", ""], gzcat: ["read", ""], bzcat: ["read", ""], xzcat: ["read", ""], zstdcat: ["read", ""],
  ls: ["list", "-I -w -T --ignore --width --tabsize --sort --time --format --time-style --block-size --hide"], ll: ["list", ""], la: ["list", ""],
  tree: ["list", "-L -P -I -o --charset --filelimit --sort --timefmt"],
  du: ["list", "-d -B -t -X --max-depth --block-size --threshold --exclude --files0-from --time-style"],
  touch: ["write", "-d -t -r --date --reference"], mkdir: ["write", "-m --mode"], tee: ["write", ""], truncate: ["write", "-s -r --size --reference"],
  sponge: ["write", ""], rm: ["delete", ""], rmdir: ["delete", ""], unlink: ["delete", ""],
};
function operandCommand([op, flags]) {
  const valued = V(flags);
  return (args, scope, ctx) => {
    for (const p of scan(args, valued).pos) addFile(ctx, scope, p, op);
  };
}
const MODE_FLAG = /^-[rwxXstugoa]+(,.*)?$/; // chmod "-x" is a mode, not an option
function modeCommand(args, scope, ctx) { // chmod MODE FILE…, chown OWNER FILE…: the first operand is not a file
  const pos = [];
  let reference = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { pos.push(...args.slice(i + 1)); break; }
    if (a === "--reference") { reference = true; i++; continue; }
    if (a.startsWith("--reference=")) { reference = true; continue; }
    if (a.length > 1 && a[0] === "-" && !MODE_FLAG.test(a)) continue;
    pos.push(a);
  }
  for (const p of reference ? pos : pos.slice(1)) addFile(ctx, scope, p, "edit");
}
const SQLITE_VALUED = V("-cmd -init -separator -newline -nullvalue -vfs -mmap -pagecache -lookaside -maxsize -nonce");
function sqliteCommand(args, scope, ctx) { // sqlite3 [options] DB [SQL…]: only SQL that changes data counts as an edit
  let readonly = false, i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { i++; break; }
    if (a.length < 2 || a[0] !== "-") break;
    if (a === "-readonly" || a === "--readonly") readonly = true;
    if (SQLITE_VALUED.has(a)) i++;
  }
  const [db, ...sql] = args.slice(i);
  if (db === undefined || db === "" || db === ":memory:") return;
  const writes = !readonly && /\b(insert|update|delete|create|drop|alter|replace|vacuum|reindex)\b/i.test(sql.join(" "));
  addFile(ctx, scope, db.replace(/^file:(?:\/\/)?/, "").replace(/\?.*$/, ""), writes ? "edit" : "read");
}
// cp/mv/install SRC… DEST or -t DIR SRC…; a directory destination receives each source by name.
function copyCommand(name) {
  const valued = V("-t --target-directory -S --suffix -m --mode -o --owner -g --group --backup");
  return (args, scope, ctx) => {
    const { pos, opts } = scan(args, valued);
    if (name === "install" && hasOpt(opts, "-d", "--directory")) { for (const p of pos) addFile(ctx, scope, p, "write"); return; }
    const dir = lastOpt(opts, "-t", "--target-directory");
    const srcs = dir === undefined ? pos.slice(0, -1) : pos;
    const dest = dir ?? pos[pos.length - 1];
    if (dest === undefined) return;
    for (const s of srcs) addFile(ctx, scope, s, name === "mv" ? "delete" : "read");
    const asDir = dir !== undefined || srcs.length > 1 || dest.endsWith("/");
    for (const s of asDir ? srcs : [null]) {
      const target = s === null ? dest : /[*?[]/.test(s) || dyn(s) ? dest : posix.join(dest, base(s));
      addFile(ctx, scope, target, "write");
    }
  };
}
function lnCommand(args, scope, ctx) {
  const { pos } = scan(args, V("-t --target-directory -S --suffix"));
  if (pos.length >= 2) addFile(ctx, scope, pos[pos.length - 1], "write");
}
function ddCommand(args, scope, ctx) {
  for (const a of args) {
    const m = /^(if|of)=(.*)$/.exec(a);
    if (m) addFile(ctx, scope, m[2], m[1] === "if" ? "read" : "write");
  }
}
function sedCommand(args, scope, ctx) {
  const { pos, opts } = scan(args.map(a => (/^-i./.test(a) ? "-i" : a)), V("-e -f -l --expression --file --line-length"));
  const inPlace = hasOpt(opts, "-i", "--in-place");
  if (inPlace && pos[0] === "") pos.shift(); // BSD sed -i ''
  const scripted = hasOpt(opts, "-e", "-f", "--expression", "--file");
  for (const p of scripted ? pos : pos.slice(1)) addFile(ctx, scope, p, inPlace ? "edit" : "read");
  const sf = lastOpt(opts, "-f", "--file");
  if (sf !== undefined) addFile(ctx, scope, sf, "read");
}
function awkCommand(args, scope, ctx) {
  const { pos, opts } = scan(args, V("-F -v -f --field-separator --assign --file"));
  const prog = lastOpt(opts, "-f", "--file");
  for (const p of prog !== undefined ? pos : pos.slice(1)) addFile(ctx, scope, p, "read");
  if (prog !== undefined) addFile(ctx, scope, prog, "read");
}
function jqCommand(args, scope, ctx) { // jq / yq: first positional is the filter unless -f FILE
  const pos = [];
  let filterFile = false, rest = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (rest && !a.startsWith("-")) continue;
    if (a === "--args" || a === "--jsonargs") rest = true;
    else if (a === "--arg" || a === "--argjson") i += 2;
    else if (a === "--slurpfile" || a === "--rawfile") { addFile(ctx, scope, args[i + 2], "read"); i += 2; }
    else if (a === "-f" || a === "--from-file") { filterFile = true; addFile(ctx, scope, args[++i], "read"); }
    else if (a === "--indent" || a === "-L") i++;
    else if (a.length < 2 || a[0] !== "-") pos.push(a);
  }
  for (const p of filterFile ? pos : pos.slice(1)) addFile(ctx, scope, p, "read");
}
const GREP_VALUED = V("-e -f -m -A -B -C -d -D --regexp --file --max-count --include --exclude --exclude-dir --include-dir --label --context " +
  "--after-context --before-context --binary-files --devices --directories");
const RG_VALUED = V("-e -f -g -t -T -A -B -C -m -d -j -M -E -r --regexp --file --glob --iglob --type --type-not --type-add --context " +
  "--after-context --before-context --max-count --max-depth --max-filesize --threads --max-columns --encoding --replace --sort --sortr " +
  "--pre --pre-glob --path-separator --context-separator --field-context-separator --field-match-separator --colors --color --engine " +
  "--dfa-size-limit --regex-size-limit --ignore-file");
const FD_VALUED = V("-e -E -t -x -X -d -S -c -j -o --extension --exclude --type --max-depth --min-depth --size --changed-within --changed-before --color --threads --owner");
function searchCommand(valued) { // grep / rg / fd: first positional is the pattern unless -e/-f/--files
  return (args, scope, ctx) => {
    const { pos, opts } = scan(args, valued);
    const noPattern = hasOpt(opts, "-e", "-f", "--regexp", "--file", "--files");
    for (const p of noPattern ? pos : pos.slice(1)) addFile(ctx, scope, p, "search");
    const pf = lastOpt(opts, "-f", "--file");
    if (pf !== undefined && !hasOpt(opts, "--files")) addFile(ctx, scope, pf, "read");
  };
}
function findCommand(args, scope, ctx) {
  let i = 0;
  while (i < args.length && /^-[HLPO]/.test(args[i])) i++;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("-") || a === "(" || a === "!" || a === ")") break;
    addFile(ctx, scope, a, "search");
  }
}
const TAR_VALUED = V("--exclude --exclude-from -T --files-from --transform --strip-components --use-compress-program -I --owner --group --mode --newer --newer-mtime --format --label");
function tarCommand(args, scope, ctx) {
  let mode = null, archive, dir;
  const members = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("="), k = eq === -1 ? a : a.slice(0, eq), v = eq === -1 ? undefined : a.slice(eq + 1);
      if (k === "--file") archive = v ?? args[++i];
      else if (k === "--directory") dir = v ?? args[++i];
      else if (k === "--create") mode ??= "c";
      else if (k === "--extract" || k === "--get") mode ??= "x";
      else if (k === "--list") mode ??= "t";
      else if (TAR_VALUED.has(k) && v === undefined) i++;
    } else if ((a.length > 1 && a[0] === "-") || (i === 0 && /^[cxtru][A-Za-z]*$/.test(a))) {
      for (const ch of a[0] === "-" ? a.slice(1) : a) {
        if ("cxtru".includes(ch)) mode ??= ch === "x" ? "x" : ch === "t" ? "t" : "c";
        if (ch === "f") archive = args[++i];
        else if (ch === "C") dir = args[++i];
        else if ("TXIKLNbgHMVF".includes(ch)) i++;
      }
    } else members.push(a);
  }
  const within = p => (dir !== undefined && !p.startsWith("/") && !p.startsWith("~") ? posix.join(dir, p) : p);
  if (archive !== undefined && archive !== "-") addFile(ctx, scope, archive, mode === "c" ? "write" : "read");
  if (mode === "c") for (const m of members) addFile(ctx, scope, within(m), "read");
  if (mode === "x" && dir !== undefined) addFile(ctx, scope, dir, "write");
}
function applyPatchCommand(args, scope, ctx, stdin) {
  applyPatch(ctx, scope, parsePatch(args.find(a => a.includes("*** Begin Patch")) ?? stdin ?? ""));
}

const CURL_VALUED = V("-o --output -H --header -d --data --data-binary --data-raw --data-ascii --data-urlencode -X --request -u --user -A " +
  "--user-agent -b --cookie -c --cookie-jar -e --referer -F --form -T --upload-file -m --max-time --connect-timeout --retry --retry-delay " +
  "--retry-max-time -x --proxy --resolve --cacert --cert --key -w --write-out --url -K --config --json -r --range --limit-rate --interface " +
  "-y -Y -z --keepalive-time --dns-servers --proto");
function curlCommand(args, scope, ctx) {
  for (const a of args) if (URL_RE.test(a)) addUrl(ctx, a);
  for (const [f, v] of scan(args, CURL_VALUED).opts) {
    if (v == null) continue;
    if (f === "-o" || f === "--output" || f === "-c" || f === "--cookie-jar") addFile(ctx, scope, v, "write");
    else if (f === "-T" || f === "--upload-file") addFile(ctx, scope, v, "read");
    else if (/^(-d|--data(-binary|-ascii|-urlencode)?|--json|-F|--form)$/.test(f)) {
      const m = /(?:^|=)@([^;]+)/.exec(v);
      if (m) addFile(ctx, scope, m[1], "read");
    }
  }
}
const WGET_VALUED = V("-O -P -i -o -a -e -t -T -w -Q -U -B --output-document --directory-prefix --input-file --output-file --append-output --header --user --password");
function wgetCommand(args, scope, ctx) {
  for (const a of args) if (URL_RE.test(a)) addUrl(ctx, a);
  for (const [f, v] of scan(args, WGET_VALUED).opts) {
    if (v == null) continue;
    if (["-O", "--output-document", "-P", "--directory-prefix", "-o", "--output-file", "-a", "--append-output"].includes(f)) addFile(ctx, scope, v, "write");
    else if (f === "-i" || f === "--input-file") addFile(ctx, scope, v, "read");
  }
}
const GIT_SCP = /^[\w.-]+@[\w.-]+:[\w./~-]+$/;
function urlCommand(args, scope, ctx) { // git, gh, httpie, …: remote ops name a URL
  for (const a of args) if (URL_RE.test(a) || GIT_SCP.test(a)) addUrl(ctx, a);
}

const HANDLERS = new Map(Object.entries({
  cd: cdCommand, pushd: cdCommand, export: exportCommand, declare: exportCommand, local: exportCommand, readonly: exportCommand, typeset: exportCommand,
  eval: (args, scope, ctx, stdin) => runScript(args.join(" "), scope, ctx, stdin), source: sourceCommand, ".": sourceCommand,
  bash: shellCommand, sh: shellCommand, zsh: shellCommand, dash: shellCommand, ksh: shellCommand,
  node: interpreter(NODE), bun: interpreter(BUN), ruby: interpreter(SCRIPTING), perl: interpreter(SCRIPTING), php: interpreter(SCRIPTING),
  npx: packageRunner, bunx: packageRunner,
  "access.py": accessWrapper,
  kubectl, oc: kubectl, k: kubectl,
  ssh: sshCommand, mosh: moshCommand, sftp: sftpCommand, scp: transfer("scp", SCP_VALUED), rsync: transfer("rsync", RSYNC_VALUED),
  chmod: modeCommand, chown: modeCommand, chgrp: modeCommand,
  cp: copyCommand("cp"), mv: copyCommand("mv"), install: copyCommand("install"), ln: lnCommand, dd: ddCommand,
  sed: sedCommand, awk: awkCommand, gawk: awkCommand, mawk: awkCommand, jq: jqCommand, yq: jqCommand, sqlite3: sqliteCommand,
  grep: searchCommand(GREP_VALUED), egrep: searchCommand(GREP_VALUED), fgrep: searchCommand(GREP_VALUED), zgrep: searchCommand(GREP_VALUED),
  rg: searchCommand(RG_VALUED), ag: searchCommand(RG_VALUED), ack: searchCommand(RG_VALUED), fd: searchCommand(FD_VALUED),
  find: findCommand, tar: tarCommand, apply_patch: applyPatchCommand, applypatch: applyPatchCommand,
  curl: curlCommand, wget: wgetCommand, http: urlCommand, https: urlCommand, xh: urlCommand, aria2c: urlCommand, git: urlCommand, gh: urlCommand,
  omp: agentBin("omp"), claude: agentBin("claude"), codex: agentBin("codex"), dsh: agentBin("dsh"),
  "claude-agent-acp": agentBin("claude-agent-acp"), "claude-code-acp": agentBin("claude-code-acp"), "codex-acp": agentBin("codex-acp"),
  ...Object.fromEntries(Object.entries(OPERAND_COMMANDS).map(([name, spec]) => [name, operandCommand(spec)])),
}));

// ───────────────────────────────────────────── patches ─────────────────────────────────────────────

// Codex apply_patch: `*** Add File: p`, `*** Update File: p` (+ `*** Move to: q`), `*** Delete File: p`.
function parsePatch(text) {
  const ops = [];
  for (const line of String(text).split("\n")) {
    let m;
    if ((m = /^\*\*\* (Add|Update|Delete) File:\s*(.+?)\s*$/.exec(line))) ops.push({ action: m[1], path: m[2] });
    else if ((m = /^\*\*\* Move to:\s*(.+?)\s*$/.exec(line)) && ops.length) ops[ops.length - 1].moveTo = m[1];
  }
  return ops;
}
function applyPatch(ctx, scope, ops) {
  if (ops.length === 0) return;
  ctx.patch = [...(ctx.patch ?? []), ...ops];
  for (const o of ops) {
    addFile(ctx, scope, o.path, o.action === "Add" ? "write" : o.action === "Delete" ? "delete" : "edit");
    if (o.moveTo) addFile(ctx, scope, o.moveTo, "write");
  }
}
const patchCategory = ops => (ops.every(o => o.action === "Add") ? "write" : "edit");
function patchSummary(ops, cwd) {
  const rel = p => (cwd && p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : p);
  return "apply_patch: " + ops.map(o => `${o.action.toLowerCase()} ${rel(o.path)}${o.moveTo ? ` → ${rel(o.moveTo)}` : ""}`).join(", ");
}

// ───────────────────────────────────────────── command analysis ─────────────────────────────────────────────

function categoryOf(ctx) {
  if (ctx.spawn) return "spawn";
  if (ctx.k8s) return "k8s";
  if (ctx.remote) return "remote";
  return ctx.patch ? patchCategory(ctx.patch) : "shell";
}
function analyze(cmd, o, ctx = newCtx()) {
  const scope = rootScope(o);
  if (Array.isArray(cmd)) runCommand(cmd.map(String), scope, ctx, null);
  else runScript(String(cmd).slice(0, 1_000_000), scope, ctx);
  return ctx;
}

/**
 * Category and targets of a shell command line (string) or argv (array); also used for process command lines.
 * @param {string|string[]} cmd
 * @param {{cwd?: string, host?: string, site?: string, home?: string}} [opts]
 * @returns {{category: string, targets: object[]}}
 */
export function parseCommand(cmd, opts = {}) {
  try {
    const ctx = analyze(cmd ?? "", opts ?? {});
    return { category: categoryOf(ctx), targets: finish(ctx) };
  } catch {
    return { category: "shell", targets: [] };
  }
}

// ── preview of a shell command: `bash -lc '…'` / `eval` wrappers and the access.py cluster wrapper removed; heredoc
// bodies cut; newlines turned into `;`; one line.
const ACCESS_RE = /(?:(?:env\s+)?(?:[A-Za-z_]\w*=\S*\s+)*python[0-9.]*\s+(?:-[A-Za-z]+\s+)*)?(?:\S*\/)?access\.py\s+kubectl\s+(\S+)\s+(?:--\s+)?/g;
const restoreVars = w => w.replace(REF, (_, __, name) => (name === "?" ? "$(…)" : "$" + name)).replaceAll(DYN, "");

function shellBody(text) { // the script of a lone `bash -lc '…'` / `eval …`, else null
  const stmts = lexShell(text);
  if (stmts.length !== 1 || stmts[0].redirs.length) return null;
  const words = stmts[0].words, i = commandStart(words);
  const b = words[i] === undefined ? "" : base(words[i]);
  if (b === "eval") return words.slice(i + 1).map(restoreVars).join(" ");
  if (!["bash", "sh", "zsh", "dash", "ksh"].includes(b)) return null;
  for (let j = i + 1; j < words.length; j++) {
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(words[j])) return words[j + 1] === undefined ? null : restoreVars(words[j + 1]);
    if (words[j].length < 2 || (words[j][0] !== "-" && words[j][0] !== "+")) return null;
    j = eatFlag(words, j, SHELLS_VALUED) - 1;
  }
  return null;
}
function flatten(text) {
  const src = clean(text), marks = [];
  lexShell(src, marks);
  let out = "", at = 0;
  for (const m of marks) {
    out += src.slice(at, m.at);
    at = m.at + m.len;
    out += m.nl ? (/(?:[;&|({]|\b(?:then|do|else))\s*$/.test(out.slice(-16)) ? " " : "; ") : m.to;
  }
  return oneLine(out + src.slice(at)).replace(/(?:;\s*)+$/, "");
}
const shq = w => (/^[\w@%+=:,./~-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`);
function displayCommand(raw) {
  let text = Array.isArray(raw) ? raw.map(shq).join(" ") : String(raw);
  for (let n = 0; n < 3; n++) {
    const inner = shellBody(text.slice(0, 20000));
    if (inner === null) break;
    text = inner;
  }
  const flat = flatten(text.slice(0, 20000));
  return flat.includes("access.py") ? flat.replace(ACCESS_RE, "kubectl --context $1 ") : flat;
}
const BARE_PATCH = /^(?:cd\s+\S+\s*(?:&&|;)\s*)?(?:\S*\/)?apply_?patch\b/;
const commandPreview = (raw, ctx, cwd) => {
  const text = displayCommand(raw);
  return ctx.patch && BARE_PATCH.test(text) ? patchSummary(ctx.patch, cwd) : text;
};

// ───────────────────────────────────────────── tool calls ─────────────────────────────────────────────

const PATH_KEYS = ["path", "file_path", "filePath", "file", "filepath", "target_file", "notebook_path", "dir_path", "directory", "dir", "filename"];
const TEXT_KEYS = ["description", "summary", "title", "subject", "task_name", "taskName", "query", "queries", "url", "i", "reason", "prompt", "message", "objective", "name", "skill", "plan"];
const ENCRYPTED = /^gAAAA[\w-]{16,}/; // opaque (encrypted) prompts exchanged between agents

function textHint(input) {
  if (typeof input === "string") return input;
  if (!isObj(input)) return "";
  for (const k of TEXT_KEYS) {
    const v = input[k];
    if (typeof v === "string" && v.trim() && !ENCRYPTED.test(v)) return v;
    if (Array.isArray(v) && v.length && v.every(x => typeof x === "string")) return v.join(" | ");
  }
  return isObj(input.action) ? textHint(input.action) : "";
}
const headOf = t => (typeof t === "string" && !ENCRYPTED.test(t) ? oneLine(t.split("\n").find(l => l.trim()) ?? "").slice(0, 160) : "");
const pathOf = input => (typeof input === "string" ? input : isObj(input) ? PATH_KEYS.map(k => str(input[k])).find(Boolean) : undefined);
// `k=v` of the first short scalar arguments: a preview for tools nobody described above.
const scalars = input => (isObj(input)
  ? Object.entries(input).filter(([, v]) => ["number", "boolean"].includes(typeof v) || (typeof v === "string" && v.length <= 60 && !ENCRYPTED.test(v)))
    .slice(0, 3).map(([k, v]) => `${k}=${v}`).join(" ")
  : "");
const res = (category, preview, targets = []) => ({ category, preview: pv(preview), targets });
function withCtx(c, fn) {
  const ctx = newCtx();
  fn(ctx, rootScope(c));
  return finish(ctx);
}

// OMP selectors: `file.ts:50-80`, `:raw`, `:img`, `:conflicts`, `:50+30`, `:-60`, `:5-16,960-973`.
const SELECTOR = /:(?:raw|img|conflicts|-?\d+(?:[-+]\d*)?(?:,\d+(?:[-+]\d*)?)*)$/;
function stripSelectors(p) {
  for (let n = 0; n < 3 && SELECTOR.test(p); n++) p = p.replace(SELECTOR, "");
  return p;
}
const safeDecode = s => { try { return decodeURI(s); } catch { return s; } };
// A path argument of a tool: real files and ssh:// become file targets, http(s) a url, other schemes (agent://, local://,
// artifact://, skill://, history://, xd://, …) nothing.
function toolPath(ctx, scope, raw, op) {
  const p = typeof raw === "string" ? raw.trim() : "";
  if (!p) return;
  const m = URL_RE.test(p) ? /^([a-z][a-z0-9+.-]*):\/\/(.*)$/is.exec(p) : null;
  if (m) {
    const scheme = m[1].toLowerCase();
    if (scheme === "http" || scheme === "https") addUrl(ctx, p);
    else if (scheme === "file") addFile(ctx, scope, stripSelectors(safeDecode(m[2])), op);
    else if (scheme === "ssh") {
      const u = REMOTE_URL.exec(stripSelectors(p));
      if (u) {
        const remote = remoteHost(ctx, (u[1] ? u[1] + "@" : "") + u[2], "ssh");
        if (u[3]) addFile(ctx, remote, u[3], op);
      }
    }
    return;
  }
  const clean = stripSelectors(p);
  addFile(ctx, scope, clean, op === "read" && clean.endsWith("/") ? "list" : op);
}
const splitPaths = raw => (typeof raw === "string" ? raw.split(";").map(s => s.trim()).filter(Boolean) : Array.isArray(raw) ? raw.filter(x => typeof x === "string") : []);
function rangeOf(input) {
  if (!isObj(input)) return "";
  const { offset, limit } = input;
  if (Number.isFinite(offset) && Number.isFinite(limit)) return `:${offset}+${limit}`;
  if (Number.isFinite(offset)) return `:${offset}-`;
  return Number.isFinite(limit) ? `:1+${limit}` : "";
}
function commandOf(input) {
  if (typeof input === "string") return input;
  if (!isObj(input)) return undefined;
  for (const k of ["command", "cmd", "script", "shell_command"]) {
    const v = input[k];
    if (typeof v === "string") return v;
    if (Array.isArray(v) && v.length && v.every(x => typeof x === "string")) return v;
  }
  return undefined;
}
function cwdOf(c) {
  const given = isObj(c.input) ? str(c.input.workdir) ?? str(c.input.cwd) ?? str(c.input.working_directory) : undefined;
  if (!given) return c.cwd;
  if (given.startsWith("/") || given.startsWith("~") || !c.cwd) return given;
  return posix.join(c.cwd, given);
}

function shellTool(c) {
  const raw = commandOf(c.input);
  if (raw === undefined) return res("shell", textHint(c.input) || c.tool);
  const cwd = cwdOf(c), ctx = analyze(raw, { ...c, cwd });
  return res(categoryOf(ctx), commandPreview(raw, ctx, cwd), finish(ctx));
}
function shellMisc(c) { // stdin pokes, job control: never echo the typed text (it may be a password)
  const i = isObj(c.input) ? c.input : {};
  const target = ["session_id", "bash_id", "shell_id", "job_id", "task_id", "id", "taskId"].map(k => i[k]).find(v => v !== undefined);
  const typed = typeof i.chars === "string" ? (i.chars === "" ? " (poll)" : ` (${i.chars.length} chars)`) : "";
  return res("shell", `${c.name}${target !== undefined ? " " + target : ""}${typed}${typeof i.i === "string" ? ": " + i.i : ""}`);
}
function codeTool(c) { // eval / run_code / js: opaque code, no targets
  const i = isObj(c.input) ? c.input : {};
  const code = typeof c.input === "string" ? c.input : str(i.code) ?? str(i.source) ?? "";
  const lang = str(i.language) ?? str(i.lang);
  return res("shell", `${c.tool}${lang ? " " + lang : ""}: ${str(i.title) ?? headOf(code)}`);
}

// Codex "code mode" (`exec`): JS calling tools.exec_command({cmd: "…", workdir: "…"}) and tools.apply_patch("…").
function jsString(code, i) { // the JS string literal at code[i]; null when it is not one or interpolates
  const q = code[i];
  if (q !== '"' && q !== "'" && q !== "`") return null;
  let out = "";
  for (let j = i + 1; j < code.length; j++) {
    const ch = code[j];
    if (ch === q) return out;
    if (q === "`" && ch === "$" && code[j + 1] === "{") return null;
    if (ch !== "\\") { out += ch; continue; }
    const e = code[++j];
    if (e === "n") out += "\n";
    else if (e === "t") out += "\t";
    else if (e === "r") out += "\r";
    else if (e === "x" || e === "u") {
      const m = e === "x" ? /^[0-9a-fA-F]{2}/.exec(code.slice(j + 1, j + 3)) : /^(?:\{([0-9a-fA-F]{1,6})\}|([0-9a-fA-F]{4}))/.exec(code.slice(j + 1, j + 9));
      const cp = m ? parseInt(m[1] ?? m[2] ?? m[0], 16) : NaN;
      if (!(cp <= 0x10ffff)) return null;
      out += String.fromCodePoint(cp);
      j += m[0].length;
    } else if (e !== "\n") out += e;
  }
  return null;
}
const jsKey = (seg, key) => {
  const m = new RegExp(`["']?\\b${key}["']?\\s*:\\s*`).exec(seg);
  return m ? jsString(seg, m.index + m[0].length) : null;
};
function codexExec(c) {
  const code = typeof c.input === "string" ? c.input : str(c.input?.code) ?? "";
  const calls = [...code.matchAll(/\btools\.(exec_command|apply_patch)\s*\(\s*/g)];
  const ctx = newCtx(), shown = [];
  calls.forEach((m, k) => {
    const start = m.index + m[0].length, seg = code.slice(start, calls[k + 1]?.index ?? code.length);
    if (m[1] === "apply_patch") {
      const ops = parsePatch(jsString(seg, 0) ?? "");
      applyPatch(ctx, rootScope(c), ops);
      if (ops.length) shown.push(patchSummary(ops, c.cwd));
      return;
    }
    const cmd = jsKey(seg, "cmd");
    if (cmd === null) return;
    const cwd = jsKey(seg, "workdir") ?? c.cwd;
    analyze(cmd, { ...c, cwd }, ctx);
    shown.push(displayCommand(cmd));
  });
  if (shown.length === 0) return codeTool({ ...c, tool: "exec" });
  return res(categoryOf(ctx), shown[0] + (shown.length > 1 ? ` (+${shown.length - 1} more)` : ""), finish(ctx));
}

function readTool(c) {
  const p = pathOf(c.input);
  if (!p) return res("read", textHint(c.input) || c.tool);
  return res("read", p + rangeOf(c.input), withCtx(c, (ctx, scope) => toolPath(ctx, scope, p, "read")));
}
function writeTool(c) {
  const p = pathOf(c.input);
  if (!p) return res("write", c.tool);
  const content = isObj(c.input) ? c.input.content : undefined;
  const pseudo = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/is.exec(p);
  if (pseudo) {
    const scheme = pseudo[1].toLowerCase();
    if (scheme === "xd") return xdCall(c, pseudo[2], content);
    if (scheme === "agent") return res("coordination", `→ ${pseudo[2]}: ${headOf(content)}`);
    if (scheme === "proc") return res("shell", `proc ${pseudo[2]}`);
    if (scheme === "conflict") return res("edit", p);
  }
  return res("write", p, withCtx(c, (ctx, scope) => toolPath(ctx, scope, p, "write")));
}
// `write xd://<tool>` with JSON content calls that tool.
function xdCall(c, device, content) {
  let input;
  try { input = JSON.parse(typeof content === "string" ? content : "null"); } catch { input = null; }
  const name = device.replace(/[?#].*$/, "").replace(DSH_MCP, "");
  if (!isObj(input)) return res("other", `xd://${device}`);
  return classify({ ...c, name, input });
}
const HASHLINE_HEADER = /^\[(.+?)(?:#[0-9A-Fa-f]{2,8})?\]\s*$/;
// OMP/DSH edit input: hashline patches (`[path#TAG]` blocks with PUT/CUT/REM/MV lines) or path-based arguments.
function editTool(c) {
  const i = isObj(c.input) ? c.input : {};
  const ctx = newCtx(), scope = rootScope(c);
  const text = typeof c.input === "string" ? c.input : typeof i.input === "string" ? i.input : "";
  const blocks = []; // one per [path#TAG] header: its file, op (edit | delete) and rename destination
  for (const line of text.split("\n")) {
    const h = HASHLINE_HEADER.exec(line);
    if (h) { blocks.push({ path: h[1], op: "edit" }); continue; }
    const b = blocks[blocks.length - 1];
    if (!b) continue;
    if (/^REM\b/.test(line)) b.op = "delete";
    else if (/^MV\s/.test(line)) b.moveTo = line.slice(3).trim().replace(/^["']|["']$/g, "");
  }
  const direct = isObj(c.input) ? pathOf({ ...c.input, input: undefined }) : undefined;
  if (direct && !blocks.some(b => b.path === direct)) blocks.unshift({ path: direct, op: "edit" });
  for (const b of blocks) {
    toolPath(ctx, scope, b.path, b.moveTo ? "delete" : b.op);
    if (b.moveTo) toolPath(ctx, scope, b.moveTo, "write");
  }
  const paths = blocks.map(b => b.path);
  const shown = paths.slice(0, 3).join(", ") + (paths.length > 3 ? ` +${paths.length - 3}` : "");
  return res("edit", shown || c.tool, finish(ctx));
}
function strEditorTool(c) { // str_replace_editor: view | create | str_replace | insert | undo_edit
  const i = isObj(c.input) ? c.input : {};
  const op = i.command === "view" ? "read" : i.command === "create" ? "write" : "edit";
  const p = pathOf(i);
  return res(op, p ?? c.tool, p ? withCtx(c, (ctx, scope) => toolPath(ctx, scope, p, op)) : []);
}
function patchTool(c) {
  const i = isObj(c.input) ? c.input : {};
  const text = typeof c.input === "string" ? c.input : str(i.input) ?? str(i.patch) ?? (Array.isArray(i.command) ? i.command.find(a => String(a).includes("*** Begin Patch")) : undefined) ?? "";
  const ops = parsePatch(text), cwd = cwdOf(c), ctx = newCtx();
  applyPatch(ctx, rootScope({ ...c, cwd }), ops);
  return res(ops.length ? patchCategory(ops) : "edit", ops.length ? patchSummary(ops, cwd) : c.tool, finish(ctx));
}
function astEditTool(c) {
  const i = isObj(c.input) ? c.input : {};
  const paths = [...splitPaths(i.paths), ...splitPaths(i.path)];
  const targets = withCtx(c, (ctx, scope) => paths.forEach(p => toolPath(ctx, scope, p, "edit")));
  const n = Array.isArray(i.ops) ? i.ops.length : 0;
  return res("edit", `${paths.slice(0, 3).join(", ") || c.tool}${n ? ` (${n} ops)` : ""}`, targets);
}
const LISTING = V("glob find ls listdir");
function searchTool(c) {
  const i = isObj(c.input) ? c.input : {};
  const op = LISTING.has(c.tool) ? "list" : "search";
  const pattern = str(i.pattern) ?? str(i.pat) ?? str(i.query) ?? str(i.regex);
  const paths = splitPaths(i.path ?? i.dir_path ?? i.directory ?? i.paths);
  const targets = withCtx(c, (ctx, scope) => {
    for (const p of paths) toolPath(ctx, scope, p, op);
    if (op === "list" && pattern?.startsWith("/")) toolPath(ctx, scope, pattern, op);
  });
  const where = paths.join(";");
  return res("search", pattern && where ? `${pattern} in ${where}` : pattern ?? (where || c.tool), targets);
}
function lspTool(c) {
  const i = isObj(c.input) ? c.input : {};
  const edits = ["rename", "rename_file", "code_actions"].includes(i.action) && i.apply === true;
  const f = str(i.file);
  const targets = f && f !== "*" ? withCtx(c, (ctx, scope) => toolPath(ctx, scope, f, edits ? "edit" : "read")) : [];
  const what = str(i.symbol) ?? str(i.query);
  return res(edits ? "edit" : "search", `${i.action ?? "lsp"}${f ? " " + f : ""}${what ? " " + what : ""}`, targets);
}
function spawnTool(c) {
  const i = isObj(c.input) ? c.input : {};
  if (Array.isArray(i.tasks) && i.tasks.length) {
    const names = i.tasks.map(t => (isObj(t) ? str(t.name) ?? str(t.id) ?? str(t.description) ?? str(t.agent) ?? "task" : "task"));
    const shown = names.slice(0, 4).join(", ") + (names.length > 4 ? ` +${names.length - 4}` : "");
    const d = isObj(i.tasks[0]) ? str(i.tasks[0].description) : undefined;
    return res("spawn", d && names.length === 1 ? `${shown}: ${d}` : shown);
  }
  const label = str(i.subagent_type) ?? str(i.agent) ?? (c.tool.startsWith("subagent") ? c.tool.replace(/^subagent/, "") : "");
  const d = str(i.description) ?? str(i.task_name) ?? str(i.name) ?? headOf(i.prompt ?? i.task ?? i.message);
  return res("spawn", label && d ? `${label}: ${d}` : d || label || c.tool);
}
const splitUrls = v => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter(x => typeof x === "string") : []);
function fetchTool(c) {
  const i = isObj(c.input) ? c.input : {};
  const urls = [...splitUrls(i.url), ...splitUrls(i.urls)];
  const targets = withCtx(c, ctx => urls.forEach(u => addUrl(ctx, u)));
  return res("web", urls[0] ?? (textHint(c.input) || c.tool), targets);
}
function browserTool(c) {
  const i = isObj(c.input) ? c.input : {};
  const url = typeof i.url === "string" ? i.url : undefined;
  return res("web", `${str(i.action) ?? "browser"}${url ? " " + url : ""}`, url ? withCtx(c, ctx => addUrl(ctx, url)) : []);
}
function messageTool(c) { // send_message & friends: → target: message
  const i = isObj(c.input) ? c.input : {};
  const to = ["target", "to", "agent_id", "agentId", "id", "recipient"].map(k => str(i[k])).find(Boolean);
  const msg = headOf(i.message ?? i.summary ?? i.content);
  return res("coordination", to ? `→ ${to}${msg ? ": " + msg : ""}` : msg || c.tool);
}
function todoTool(c) {
  const i = isObj(c.input) ? c.input : {};
  if (Array.isArray(i.todos) || Array.isArray(i.plan)) {
    const items = (i.todos ?? i.plan).filter(isObj);
    const active = items.find(t => t.status === "in_progress");
    const label = active ? str(active.activeForm) ?? str(active.content) ?? str(active.step) : undefined;
    return res("coordination", `${items.length} items${label ? ": " + label : ""}`);
  }
  const what = str(i.task) ?? str(i.phase) ?? (Array.isArray(i.list) ? `${i.list.length} phases` : undefined) ?? (Array.isArray(i.items) ? `${i.items.length} items` : undefined);
  return res("coordination", [str(i.op), what].filter(Boolean).join(": ") || textHint(i) || c.tool);
}
function askTool(c) {
  const i = isObj(c.input) ? c.input : {};
  const q = Array.isArray(i.questions) && isObj(i.questions[0]) ? str(i.questions[0].question) ?? str(i.questions[0].header) : undefined;
  return res("coordination", q ?? (textHint(c.input) || c.tool));
}
const coordTool = c => res("coordination", textHint(c.input) || scalars(c.input) || c.tool);
function hubTool(c) { // OMP service hub: start/stop/list local services
  const i = isObj(c.input) ? c.input : {};
  const label = `hub ${str(i.op) ?? ""} ${str(i.name) ?? ""}`.trim();
  if (i.op !== "start" || typeof i.application !== "string") return res("shell", label);
  const words = [i.application, ...(Array.isArray(i.args) ? i.args.map(String) : [])], cwd = cwdOf(c);
  const ctx = analyze(words, { ...c, cwd });
  return res(categoryOf(ctx), `${label}: ${words.map(shq).join(" ")}`, finish(ctx));
}
// DSH sessions that mirror an ACP agent name tool calls by their title ("Creating game favicon"); the arguments still
// say what the call did.
function byShape(c) {
  const i = c.kind === "dsh" && isObj(c.input) ? c.input : null;
  if (!i) return null;
  const path = pathOf(i);
  if (commandOf(i) !== undefined) return shellTool(c);
  if (path && "content" in i) return writeTool(c);
  if (path && "old_string" in i) return editTool(c);
  if (typeof i.pattern === "string") return searchTool(c);
  return path ? readTool(c) : null;
}
function otherTool(c) {
  const hint = textHint(c.input) || pathOf(c.input) || scalars(c.input);
  return res("other", hint ? `${c.name}: ${hint}` : c.name || c.tool);
}

const TOOLS = new Map();
const def = (names, fn) => { for (const n of names.split(" ")) TOOLS.set(n.replace(/[_-]/g, ""), fn); };
def("bash exec_command shell local_shell shell_command run_terminal_cmd run_shell_command execute_bash terminal monitor", shellTool);
def("bashoutput killshell killbash job_output job_kill job_list write_stdin taskoutput taskstop", shellMisc);
def("eval run_code js js_repl python", codeTool);
def("exec", codexExec);
def("read read_file read_many_files view_image read_image view notebookread", readTool);
def("write write_file create_file", writeTool);
def("edit multiedit notebookedit edit_file replace", editTool);
def("str_replace_editor str_replace_based_edit_tool", strEditorTool);
def("apply_patch", patchTool);
def("ast_edit", astEditTool);
def("grep find glob ls list_dir ast_grep grep_files search_files file_search session_search", searchTool);
def("lsp", lspTool);
def("task agent subagent subagent_fork subagent_claude_code subagent_codex spawn_agent spawn_teammate delegate new_task", spawnTool);
def("webfetch web_fetch fetch read_url", fetchTool);
def("websearch web_search", c => res("web", textHint(c.input) || c.tool));
def("browser", browserTool);
def("send_message sendmessage send_input peer_send_message followup_task interrupt_agent", messageTool);
def("todo todowrite todo_write update_plan", todoTool);
def("askuserquestion ask ask_user_question request_user_input", askTool);
def("wait wait_agent wait_threads list_agents listagents close_agent resume_agent exitplanmode enterplanmode taskcreate taskupdate tasklist " +
  "taskget schedulewakeup schedule_create schedule_update get_goal create_goal update_goal list_threads read_thread list_archived_threads automation_update", coordTool);
def("hub", hubTool);

const DSH_MCP = /^mcp__dshteam_[0-9a-f]+_{1,2}/i; // DSH exposes its own tools to ACP agents under this prefix
const canonicalName = name => String(name ?? "").trim().toLowerCase().replace(/^(?:functions|collaboration|multi_tool_use)\./, "").replace(/[_\-\s]/g, "");
function classify(call) {
  const name = String(call.name ?? "");
  let input = call.input;
  if (typeof input === "string" && /^\s*[{[]/.test(input)) {
    try { const parsed = JSON.parse(input); if (isObj(parsed)) input = parsed; } catch { /* raw text stays */ }
  }
  const c = { ...call, name, input, tool: canonicalName(name) };
  const fn = TOOLS.get(c.tool);
  if (fn) return fn(c);
  if (DSH_MCP.test(name)) return classify({ ...c, name: name.replace(DSH_MCP, "") });
  if (/^mcp__?/i.test(name)) return res("other", `mcp ${name.replace(/^mcp__?/i, "").replace(/__/g, ".")}: ${textHint(input) || scalars(input)}`);
  if (/^(start|complete) subagent /i.test(name)) return res("spawn", name);
  if (/^subagent/i.test(name)) return spawnTool(c);
  return byShape(c) ?? otherTool(c);
}

/**
 * Category, one-line preview and targets of one tool call.
 * @param {{kind?: string, name: string, input?: any, cwd?: string, host?: string, site?: string, home?: string}} call
 * @returns {{category: string, preview: string, targets: object[]}}
 */
export function classifyTool(call) {
  try {
    return classify(call ?? {});
  } catch {
    return { category: "other", preview: pv(call?.name), targets: [] };
  }
}
