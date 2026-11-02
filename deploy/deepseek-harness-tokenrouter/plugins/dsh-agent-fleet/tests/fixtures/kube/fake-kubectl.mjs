#!/usr/bin/env node
// Fake kubectl for tests/kube.test.mjs. It plays the scenario in $FAKE_KUBECTL_DIR/scenario.json (re-read on every call):
//   contexts[ctx].cycles[n].list   {items, ignoreSelector} | {code, stderr}   n-th `get pods` of that context (the last cycle repeats)
//   contexts[ctx].cycles[n].watch  n-th `get pods --watch`: first replays cycle n's list as ADDED events, like kubectl does
//                                  (replay: [objects] overrides what is replayed, compactReplay prints one line per event), then
//                                  {steps:[{after, gate, events|text, compact, glue, slice}], exitAfter, code, stderr}
//   contexts[ctx].objects[name]    `get pod NAME` answers; lookupFail = stderr of a transport failure
//   contexts[ctx].events[pod]      `get events` items
//   contexts[ctx].pods[name]       `exec`: {containers, node, sha, failProbe, failPush, badPushSha}
// Output is pretty-printed like kubectl's. Every call is appended to calls.jsonl; calls missing --kubeconfig, --context
// or -n are refused. The file-read script of `exec` really runs under sh against the local filesystem.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_KUBECTL_DIR;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const argv = process.argv.slice(2);
const dashes = argv.indexOf("--");
const before = dashes < 0 ? argv : argv.slice(0, dashes);
const remote = dashes < 0 ? [] : argv.slice(dashes + 1);
const flags = {}, words = [];
for (let i = 0; i < before.length; i++) {
  const arg = before[i];
  if (["--kubeconfig", "--context", "-n", "-c", "-o"].includes(arg)) flags[arg] = before[++i];
  else if (arg.startsWith("--") && arg.includes("=")) flags[arg.slice(0, arg.indexOf("="))] = arg.slice(arg.indexOf("=") + 1);
  else if (arg.startsWith("-")) flags[arg] = true;
  else words.push(arg);
}
const ctx = flags["--context"];
appendFileSync(join(dir, "calls.jsonl"), `${JSON.stringify({ at: Date.now(), ctx, words, flags, remote, argv })}\n`);

function finish(code, stdout = "", stderr = "") {
  if (stderr) process.stderr.write(stderr.endsWith("\n") ? stderr : `${stderr}\n`);
  process.stdout.write(stdout, () => process.exit(code));
}
const fail = (code, stderr) => finish(code, "", stderr);
const pretty = value => `${JSON.stringify(value, null, 4)}\n`;
const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8"));
const subst = text => String(text ?? "").replaceAll("{{KUBECONFIG}}", String(flags["--kubeconfig"]));
const cfg = scenario.contexts?.[ctx];

/** How many times this kind of call happened before (and records this one). */
function nextIndex(kind, key = ctx) {
  const file = join(dir, `count-${key}-${kind}`);
  const n = existsSync(file) ? readFileSync(file, "utf8").length : 0;
  appendFileSync(file, "x");
  return n;
}
const cycleAt = n => cfg.cycles?.[Math.min(n, (cfg.cycles?.length ?? 1) - 1)] ?? {};

/** Items as the API server returns them for this call's field selector. */
function selected(spec) {
  const items = spec.items ?? [];
  if (spec.ignoreSelector || !String(flags["--field-selector"] ?? "").includes("status.phase!=Succeeded")) return items;
  return items.filter(pod => !["Succeeded", "Failed"].includes(pod.status?.phase));
}

function list() {
  const spec = cycleAt(nextIndex("list")).list ?? {};
  if (spec.code) return fail(spec.code, subst(spec.stderr));
  return finish(0, pretty({ apiVersion: "v1", items: selected(spec), kind: "List", metadata: { resourceVersion: "" } }));
}

async function emit(text, slice) {
  if (!slice) return new Promise(resolve => process.stdout.write(text, resolve));
  for (let i = 0; i < text.length; i += slice) {
    await new Promise(resolve => process.stdout.write(text.slice(i, i + slice), resolve));
    await sleep(1);
  }
}

async function watch() {
  const n = nextIndex("watch");
  writeFileSync(join(dir, `pid-${ctx}-watch-${n}`), String(process.pid));
  process.on("SIGTERM", () => process.exit(143));
  const cycle = cycleAt(n), spec = cycle.watch ?? {};
  const began = Date.now();
  const replay = spec.replay ?? selected(cycle.list ?? {});
  if (replay.length > 0) {
    await emit(`${replay.map(object => JSON.stringify({ type: "ADDED", object }, null, spec.compactReplay ? undefined : 4)).join("\n")}\n`, spec.replaySlice);
  }
  for (const step of spec.steps ?? []) {
    const wait = step.after - (Date.now() - began);
    if (wait > 0) await sleep(wait);
    while (step.gate && !existsSync(join(dir, step.gate))) await sleep(10); // the test opens the gate when it is ready
    const text = step.text ?? `${(step.events ?? []).map(e => step.compact ? JSON.stringify(e) : JSON.stringify(e, null, 4)).join(step.glue ? "" : "\n")}\n`;
    await emit(text, step.slice);
  }
  if (spec.exitAfter === undefined) return setInterval(() => {}, 1 << 30); // lives until killed
  const wait = spec.exitAfter - (Date.now() - began);
  if (wait > 0) await sleep(wait);
  return finish(spec.code ?? 0, "", subst(spec.stderr));
}

function getPod() {
  const name = words[2];
  if (cfg.lookupFail) return fail(1, subst(cfg.lookupFail));
  const object = cfg.objects?.[name];
  if (!object) return fail(1, `Error from server (NotFound): pods "${name}" not found`);
  return finish(0, pretty(object));
}

function events() {
  const name = /involvedObject\.name=([^,]+)/.exec(String(flags["--field-selector"] ?? ""))?.[1];
  return finish(0, pretty({ apiVersion: "v1", items: cfg.events?.[name] ?? [], kind: "List", metadata: { resourceVersion: "" } }));
}

async function exec() {
  const name = words[1];
  const pod = cfg.pods?.[name];
  if (!pod) return fail(1, `Error from server (NotFound): pods "${name}" not found`);
  const container = flags["-c"];
  if (container && pod.containers && !pod.containers.includes(container)) {
    return fail(1, `Error from server (BadRequest): container ${container} is not valid for pod ${name}`);
  }
  if (remote[0] !== "sh" || remote[1] !== "-c") return fail(1, "fake-kubectl: unsupported exec command");
  const script = remote[2];
  const key = `${ctx}-${name}`, shaFile = join(dir, "remote", `${key}.sha`);
  if (script.includes("command -v node")) {
    if (nextIndex("probe", key) < (pod.failProbe ?? 0)) return fail(1, 'error: unable to upgrade connection: container not found ("workspace")');
    const sha = existsSync(shaFile) ? readFileSync(shaFile, "utf8") : pod.sha ?? "";
    return finish(0, `${pod.node ? `/usr/local/bin/node\n${pod.node}\n` : ""}---\n${sha ? `${sha}  /tmp/agent-fleet/collector.mjs\n` : ""}`);
  }
  if (script.includes(".part")) {
    nextIndex("push", key);
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    if (pod.failPush) return fail(1, "sh: can't create /tmp/agent-fleet/collector.mjs.part: Read-only file system");
    const bundle = Buffer.concat(chunks), sha = createHash("sha256").update(bundle).digest("hex");
    mkdirSync(join(dir, "remote"), { recursive: true });
    writeFileSync(shaFile, sha);
    writeFileSync(join(dir, "remote", `${key}.bundle`), bundle);
    return finish(0, `PUSHED\n${pod.badPushSha ?? sha}  /tmp/agent-fleet/collector.mjs\n`);
  }
  if (script.includes("head -c")) {
    const run = spawnSync("sh", ["-c", script, ...remote.slice(3)], { env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` } });
    const code = run.status ?? 1;
    return finish(code, run.stdout, `${run.stderr}${code ? `command terminated with exit code ${code}\n` : ""}`);
  }
  return fail(1, "fake-kubectl: unsupported exec script");
}

async function main() {
  if (!flags["--kubeconfig"] || !ctx || !flags["-n"]) return fail(2, "fake-kubectl: --kubeconfig, --context and -n are required");
  if (!cfg) return fail(1, `error: context "${ctx}" does not exist`);
  if (words[0] === "get" && words[1] === "pods") return flags["--watch"] ? watch() : list();
  if (words[0] === "get" && words[1] === "pod") return getPod();
  if (words[0] === "get" && words[1] === "events") return events();
  if (words[0] === "exec") return exec();
  return fail(1, `fake-kubectl: unsupported command: ${words.join(" ")}`);
}
main();
