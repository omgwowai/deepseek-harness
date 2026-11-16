// Readable names for background jobs (2026-10-26, the alignment page's 正在执行 row). A pwsh / bash job's label is the
// raw command (dsh-tool-pwsh and dsh-tool-bash register label: args.command); the description the agent gave that call
// only exists in the call's arguments, read from the session log (todos.js keeps it per job). jobName: the description
// first; without one, jobTitle(command): the families that run most often in the background on this machine (14 days
// of session logs, 2026-10-26: dsh-verify 459, preview servers 429, node / pwsh scripts, gradle 106, node --test 43,
// DSH instances 16, pnpm / npm, playwright, cargo) get a short Chinese name; anything else shows its program and key
// arguments - no $env: / cd setup statements, no pipes, redirections or "exit $LASTEXITCODE" tails, paths cut to their
// file name, one line of at most MAX characters.

export const COMMAND_KINDS = new Set(["pwsh", "bash"]);
const MAX = 60;

const clean = (s) => (typeof s === "string" && s.trim() !== "" ? s.trim() : null);
const oneLine = (s) => s.replace(/\s+/g, " ").trim();
const cut = (s) => { const t = oneLine(s); return t.length > MAX ? t.slice(0, MAX - 1) + "…" : t; };
const base = (s) => { const t = s.replace(/[\\/]+$/, ""); return t.slice(Math.max(t.lastIndexOf("/"), t.lastIndexOf("\\")) + 1); };
// a path (no spaces, has a slash, not a URL) shows as its file name
const pathy = (s) => !/\s/.test(s) && /[\\/]/.test(s) && !/^[a-z][\w+.-]*:\/\//i.test(s);
const shown = (s) => (pathy(s) ? base(s) : s);
const exe = (s) => base(s).replace(/\.(exe|cmd|bat)$/i, "");

/** Statements of a command line: split on ; && || and line breaks outside quotes, braces and parentheses. */
function statements(cmd) {
  const out = [];
  let cur = "", q = null, depth = 0;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === "{" || c === "(") depth++;
    else if ((c === "}" || c === ")") && depth > 0) depth--;
    if (depth === 0 && (c === ";" || c === "\n" || c === "\r" || ((c === "&" || c === "|") && cmd[i + 1] === c))) {
      out.push(cur); cur = "";
      if (c === "&" || c === "|") i++;
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Words of one statement ({v, q: was quoted}), up to the first pipe or redirection outside quotes. */
function words(stmt) {
  const out = [];
  let cur = "", q = null, quoted = false, started = false;
  const push = () => { if (started) out.push({ v: cur, q: quoted }); cur = ""; quoted = false; started = false; };
  for (let i = 0; i < stmt.length; i++) {
    const c = stmt[i];
    if (q) { if (c === q) q = null; else cur += c; continue; }
    if (c === "'" || c === '"') { q = c; quoted = true; started = true; continue; }
    if (c === "|" || c === ">" || (!started && (c === "*" || /\d/.test(c)) && stmt[i + 1] === ">")) break;
    if (/\s/.test(c)) { push(); continue; }
    cur += c; started = true;
  }
  push();
  return out;
}

const SETUP = new Set(["cd", "set-location", "sl", "push-location", "pushd", "pop-location", "popd", "remove-item", "rm", "del", "ri", "new-item", "ni", "mkdir", "md", "exit", "return", "write-host", "write-output", "echo", "clear-host", "out-null"]);
const PWSH = new Set(["pwsh", "powershell"]);
const PWSH_NOISE = new Set(["-noprofile", "-nologo", "-noninteractive", "-nop", "-noexit"]);
const UV_VALUE = new Set(["--with", "--python", "-p", "--project", "--directory", "--package", "--extra", "--group", "--env-file", "--index", "--from"]);

/** One statement as {name (program, lower case, no .exe), args, lead (words shown before args), setup}, or null. */
function program(ws) {
  let w = ws.slice();
  while (w.length && w[0].v === "&" && !w[0].q) w.shift();
  // $p = Start-Process …: the right-hand side; $env:X='…' (glued) or a bare string is not a program
  if (w.length > 1 && w[1].v === "=" && !w[1].q) w = w.slice(2);
  if (!w.length) return null;
  const head = w[0];
  if (head.q && ws[0].v !== "&") return { setup: true };
  if (/^\$[\w:]+=/.test(head.v) || (/^\$[\w:]+$/.test(head.v) && w.length === 1)) return { setup: true };
  const name = exe(head.v).toLowerCase();
  const args = w.slice(1).map((x) => x.v);
  if (name === "get-childitem" && /^env:/i.test(args[0] ?? "")) return { setup: true };
  if (SETUP.has(name)) return { setup: true, name, args, lead: [exe(head.v)] };
  if (PWSH.has(name)) {
    const rest = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i], l = a.toLowerCase();
      if (PWSH_NOISE.has(l)) continue;
      if (l === "-executionpolicy" || l === "-ep") { i++; continue; }
      if (l === "-command" || l === "-c") return inner(args.slice(i + 1).join(" "));
      if (l === "-file" || l === "-f") { const f = args[i + 1]; return f === undefined ? { name, args: rest, lead: ["pwsh"] } : { name: base(f).toLowerCase(), args: args.slice(i + 2), lead: ["pwsh", base(f)] }; }
      if (!a.startsWith("-")) return { name: base(a).toLowerCase(), args: args.slice(i + 1), lead: ["pwsh", base(a)] };
      rest.push(a);
    }
    return { name, args: rest, lead: ["pwsh"] };
  }
  if (name === "cmd" && /^\/[ck]$/i.test(args[0] ?? "")) return inner(args.slice(1).join(" "));
  // uv run [--flags] <tool> …, npx <tool> …: the tool is the program
  if (name === "uv" && args[0] === "run") {
    let i = 1;
    while (i < args.length && args[i].startsWith("-")) i += UV_VALUE.has(args[i]) ? 2 : 1;
    return i >= args.length ? { name, args, lead: ["uv"] } : program(args.slice(i).map((v) => ({ v, q: false })));
  }
  if (name === "start-process" && args.length) return program(args.filter((a) => !a.startsWith("-")).slice(0, 1).map((v) => ({ v, q: false })));
  if (name === "npx" && args.length) return program(args.filter((a, k) => k > 0 || !a.startsWith("-")).map((v) => ({ v, q: false })));
  return { name, args, lead: [exe(head.v)] };
}
const inner = (s) => { const st = statements(s).map(words).map(program).filter((p) => p && !p.setup); return st[0] ?? null; };

/** The family name of a program, or null. */
function family(p) {
  const { name, args } = p, has = (re) => args.some((a) => re.test(a));
  const flag = (n) => { const i = args.findIndex((a) => a.toLowerCase() === n); return i < 0 ? null : args[i + 1] ?? ""; };
  if (name === "dsh-verify.ps1" || name === "dsh-verify") {
    const only = flag("-only");
    if (only !== null) return "检查 dsh-verify 的 " + only.split(",").map((s) => s.trim()).filter(Boolean).join("、") + " 段";
    return has(/^-SkipRegressionTests$/i) ? "快速检查 dsh-verify" : "完整检查 dsh-verify";
  }
  if (name === "pnpm" || name === "npm" || name === "yarn") {
    const a = args.filter((x) => !x.startsWith("-")), s = a[0] === "run" ? a[1] : a[0];
    if (s && /^test(:|$)/.test(s)) return "测试 " + name + " " + (a[0] === "run" ? "run " : "") + s;
    return null;
  }
  if (name === "node" && has(/^--test$/)) {
    const files = args.filter((a) => !a.startsWith("-")).map(base);
    return files.length === 0 ? "测试 node --test" : "测试 " + files[0] + (files.length > 1 ? " 等 " + files.length + " 个文件" : "");
  }
  if (name === "gradlew" || name === "gradle") {
    const tasks = args.filter((a) => !a.startsWith("-")).map((t) => t.slice(t.lastIndexOf(":") + 1)).filter(Boolean);
    if (tasks.some((t) => /^assemble/i.test(t))) return "打 APK gradle " + tasks.find((t) => /^assemble/i.test(t));
    if (tasks.some((t) => /test/i.test(t))) return "测试 gradle " + tasks.filter((t) => /test/i.test(t)).join(" ");
    return tasks.length ? "gradle " + tasks.join(" ") : null;
  }
  if ((name === "playwright" && args[0] === "test") || (name.startsWith("python") && args[0] === "-m" && args[1] === "playwright" && args[2] === "test")) return "测试 playwright";
  if (name.startsWith("python") && args[0] === "-m" && args[1] === "http.server") { const port = args.slice(2).find((a) => /^\d+$/.test(a)); return "预览服务 http.server" + (port ? " :" + port : ""); }
  if (name === "dsh" && (has(/^web$/) || has(/^--profile$/) || has(/^headless$/))) {
    const port = flag("--port");
    return has(/^headless$/) ? "DSH headless" : "独立 DSH 实例" + (port ? " :" + port : "");
  }
  if (name === "cargo" && (args[0] === "build" || args[0] === "test")) return (args[0] === "build" ? "构建 cargo build" : "测试 cargo test");
  return null;
}

/** A readable one-line name for a shell command, or null for an empty one. */
export function jobTitle(command) {
  const c = clean(command);
  if (c === null) return null;
  const progs = statements(c).map(words).map(program).filter(Boolean);
  // setup statements ($env:, cd, Remove-Item …) carry no name; a family anywhere in the chain names the whole job
  const main = progs.filter((p) => !p.setup);
  for (const p of main) { const f = family(p); if (f !== null) return cut(f); }
  const p = main[0] ?? progs.find((x) => x.lead);
  if (p === undefined) return cut(c);
  const args = p.args.filter((a) => !(p.lead[0] === "pwsh" && PWSH_NOISE.has(a.toLowerCase()))).map(shown);
  return cut([...p.lead, ...args].join(" "));
}

/**
 * {name, cmd} of a background job. cmd = the raw command for pwsh / bash jobs (their label is the command), else null.
 * name = desc (the description of the call that started it) when there is one, else jobTitle(cmd), else the label
 * (a workflow job's label is its meta.name); null when none is known.
 */
export function jobName(kind, label, desc) {
  const cmd = COMMAND_KINDS.has(kind) ? clean(label) : null;
  return { name: clean(desc) ?? (cmd !== null ? jobTitle(cmd) : clean(label)), cmd };
}
