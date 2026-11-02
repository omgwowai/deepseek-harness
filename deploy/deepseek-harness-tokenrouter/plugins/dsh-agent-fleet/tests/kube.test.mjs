// Behaviour tests for the kube source (lib/hub/sources/kube.mjs): the streaming JSON splitter, pod compaction, the
// list/watch lifecycle against a fake kubectl (tests/fixtures/kube/fake-kubectl.mjs), on-demand pod lookups, collector
// attach, pod file previews and kube events. All pods and events are synthetic.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compactPod, createJsonSplitter, createKubeSource } from "../lib/hub/sources/kube.mjs";
import { COLLECT_LABEL, NAMESPACE, podHostId, podKey } from "../lib/protocol.mjs";
import { isSecretPath } from "../lib/redact.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, "fixtures", "kube", "fake-kubectl.mjs");
const START_STOP = join(here, "fixtures", "kube", "start-stop.mjs");
const ACTIVE_ONLY = "status.phase!=Succeeded,status.phase!=Failed";
const CONTAINER_LABEL = "agent-fleet.omgwow.ai/container";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const pick = (object, keys) => Object.fromEntries(keys.map(key => [key, object[key]]));

async function waitFor(check, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

// ── harness ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A scratch directory with a `kubectl` wrapper around the fake, a call log and a scenario file. Removed after the test. */
function makeEnv(t) {
  const scratch = join(here, "..", ".scratch");
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "kube-test-"));
  for (const sub of ["bin", "files"]) mkdirSync(join(dir, sub));
  const kubectl = join(dir, "kubectl");
  writeFileSync(kubectl, `#!/bin/sh\nFAKE_KUBECTL_DIR='${dir}' exec '${process.execPath}' '${FAKE}' "$@"\n`, { mode: 0o755 });
  if (process.platform === "darwin") { // the pod-side script uses GNU `stat [-L] -c '%s %Y'`
    writeFileSync(join(dir, "bin", "stat"), '#!/bin/sh\nfollow=\n[ "$1" = "-L" ] && { follow=-L; shift; }\n[ "$1" = "-c" ] && exec /usr/bin/stat $follow -f "%z %m" "$3"\nexec /usr/bin/stat $follow "$@"\n', { mode: 0o755 });
  }
  const stoppers = [];
  t.after(async () => {
    for (const stop of stoppers) await stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const callsFile = join(dir, "calls.jsonl");
  return {
    dir, kubectl, kubeconfig: join(dir, "kubeconfig.yaml"),
    file: (...parts) => join(dir, ...parts),
    track(source) { stoppers.push(() => source.stop()); return source; },
    scenario(contexts) {
      writeFileSync(join(dir, "scenario.tmp"), JSON.stringify({ contexts }));
      renameSync(join(dir, "scenario.tmp"), join(dir, "scenario.json"));
    },
    calls: (filter = () => true) => (existsSync(callsFile) ? readFileSync(callsFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : []).filter(filter),
  };
}

/** Records what the hub would receive and keeps a mirror of the pod set per site (list replaces, watch upserts). */
function recorder() {
  const rec = { states: [], lists: [], watches: [], gone: [], seen: [], mirror: new Map() };
  const mirrorOf = site => rec.mirror.get(site) ?? rec.mirror.set(site, new Map()).get(site);
  rec.options = {
    onSourceState: (site, state) => rec.states.push({ site, ...state }),
    onPods: (site, pods, state) => {
      (state === "list" ? rec.lists : rec.watches).push({ site, pods });
      const mirror = mirrorOf(site);
      if (state === "list") mirror.clear();
      for (const pod of pods) { mirror.set(pod.key, pod); rec.seen.push({ site, state, pod }); }
    },
    onPodGone: (site, key) => { rec.gone.push({ site, key }); mirrorOf(site).delete(key); },
  };
  rec.names = site => [...mirrorOf(site).values()].map(pod => pod.name).sort();
  rec.pod = (site, name) => mirrorOf(site).get(podKey(site, NAMESPACE, name));
  return rec;
}

function startSource(env, rec, extra = {}) {
  const source = env.track(createKubeSource({ kubeconfig: env.kubeconfig, kubectl: env.kubectl, backoffMs: [20, 80], ...rec.options, ...extra }));
  source.start();
  return source;
}

/** A synthetic v1 Pod shaped like `kubectl get pods -o json` output (managedFields, statuses, owner …). */
function rawPod(name, o = {}) {
  const phase = o.phase ?? "Running", restart = o.restart ?? 0;
  const containers = o.containers ?? [{ name: "main", image: "registry.local/app:1" }];
  const statuses = o.statuses ?? containers.map(c => ({
    name: c.name, image: c.image, imageID: "sha256:feed", containerID: `containerd://${name}-${c.name}-${restart}`,
    ready: phase === "Running", restartCount: restart,
    state: phase === "Running" ? { running: { startedAt: "2026-10-30T01:00:05Z" } }
      : phase === "Pending" ? { waiting: { reason: "ContainerCreating" } }
      : { terminated: { exitCode: phase === "Succeeded" ? 0 : 1, reason: phase === "Succeeded" ? "Completed" : "Error", startedAt: "2026-10-30T01:00:05Z", finishedAt: o.finishedAt ?? "2026-10-30T02:00:00Z" } },
  }));
  return {
    apiVersion: "v1", kind: "Pod",
    metadata: {
      name, namespace: NAMESPACE, uid: o.uid ?? `uid-${name}`, resourceVersion: o.rv ?? "1", creationTimestamp: "2026-10-30T01:00:00Z",
      labels: o.labels ?? { app: "demo" }, annotations: o.annotations,
      ownerReferences: o.owner ? [{ apiVersion: "batch/v1", kind: o.owner.kind, name: o.owner.name, uid: "owner-uid", controller: true }] : undefined,
      deletionTimestamp: o.deleting,
      managedFields: [{ manager: o.manager ?? "kubelet", operation: "Update", time: "2026-10-30T01:00:06Z" }],
    },
    spec: { nodeName: o.node ?? "node-1", containers },
    status: {
      phase, podIP: phase === "Pending" ? undefined : "10.0.0.7", startTime: "2026-10-30T01:00:02Z",
      containerStatuses: o.noStatuses ? undefined : statuses, initContainerStatuses: o.initStatuses, conditions: o.conditions, reason: o.reason,
    },
  };
}
/** The same pod after a status heartbeat: new resourceVersion and managedFields, nothing a viewer could see. */
const churn = (pod, rv) => ({ ...pod, metadata: { ...pod.metadata, resourceVersion: rv, managedFields: [{ manager: "kube-controller", operation: "Update", time: "2026-10-30T09:00:00Z" }] } });
const crashing = (name, restarts, o = {}) => rawPod(name, {
  ...o,
  statuses: [{ name: "main", image: "registry.local/app:1", ready: false, restartCount: restarts, containerID: `containerd://${name}-crash`,
    state: { waiting: { reason: "CrashLoopBackOff", message: "back-off 5m0s restarting failed container" } }, lastState: { terminated: { exitCode: 1, reason: "Error" } } }],
});
const watchedCalls = env => env.calls(c => c.words[0] === "get" && c.words[1] === "pods");

// ── streaming JSON splitter ────────────────────────────────────────────────────────────────────────────────────────

const EVENTS = [
  { type: "ADDED", object: { name: "a{b}", note: 'quote " and \\ backslash \\" and }{ and ][', nested: [1, [2, { x: "]" }], { y: { z: "}" } }], uni: "héllo 日本 😀" } },
  { type: "MODIFIED", object: { empty: {}, list: [], n: -1.5e3 } },
  { type: "DELETED", object: { last: true } },
];

test("splitter: pretty-printed, compact and glued objects survive any chunk boundary, including inside UTF-8", () => {
  const texts = {
    pretty: `${EVENTS.map(e => JSON.stringify(e, null, 4)).join("\n")}\n`,
    compact: `${EVENTS.map(e => JSON.stringify(e)).join("\n")}\n`,
    glued: EVENTS.map(e => JSON.stringify(e)).join(""),
  };
  for (const [shape, text] of Object.entries(texts)) {
    const bytes = Buffer.from(text);
    for (let cut = 0; cut <= bytes.length; cut++) {
      const out = [];
      const splitter = createJsonSplitter(json => out.push(JSON.parse(json)));
      splitter.write(bytes.subarray(0, cut));
      splitter.write(bytes.subarray(cut));
      assert.deepEqual(out, EVENTS, `${shape} text cut at byte ${cut}`);
      assert.deepEqual(splitter.end(), { complete: true, values: 3, closed: 3 });
    }
    const out = [];
    const splitter = createJsonSplitter(json => out.push(JSON.parse(json)));
    for (const byte of bytes) splitter.write(Buffer.from([byte]));
    assert.deepEqual(out, EVENTS, `${shape} text fed byte by byte`);
  }
});

test("splitter: depth 3 yields the elements of a kubectl List and ignores the wrapper", () => {
  const items = [
    { metadata: { name: "a", annotations: { cfg: '{"json": [1, 2], "q": "\\""}' } }, spec: { containers: [{ name: "c", args: ["}", "{"] }] } },
    { metadata: { name: "b" } },
  ];
  const text = JSON.stringify({ apiVersion: "v1", items, kind: "List", metadata: { resourceVersion: "" } }, null, 4);
  for (let cut = 0; cut <= text.length; cut += 7) {
    const out = [];
    const splitter = createJsonSplitter(json => out.push(JSON.parse(json)), { depth: 3 });
    splitter.write(text.slice(0, cut));
    splitter.write(text.slice(cut));
    assert.deepEqual(out, items);
    assert.deepEqual(splitter.end(), { complete: true, values: 2, closed: 1 });
  }
  const empty = createJsonSplitter(() => assert.fail("no items expected"), { depth: 3 });
  empty.write('{"apiVersion":"v1","items":[],"kind":"List","metadata":{"resourceVersion":""}}');
  assert.deepEqual(empty.end(), { complete: true, values: 0, closed: 1 });
});

test("splitter: objects far larger than 64 KiB arrive whole, in any chunk size; truncated input and runaway objects are detected", () => {
  const blob = '{"k":"v\\"}"}'.repeat(25_000); // braces and escaped quotes inside a 300 KB string
  const big = { type: "ADDED", object: { metadata: { name: "big", annotations: { blob } }, items: Array.from({ length: 50 }, (_, i) => ({ i })) } };
  const text = `${JSON.stringify(big, null, 4)}\n${JSON.stringify({ type: "DELETED", object: {} })}`;
  assert.ok(text.length > 3 * 64 * 1024);
  for (const size of [997, 65_536, text.length]) {
    const out = [];
    const splitter = createJsonSplitter(json => out.push(JSON.parse(json)));
    for (let at = 0; at < text.length; at += size) splitter.write(text.slice(at, at + size));
    assert.deepEqual(out, [big, { type: "DELETED", object: {} }], `chunk size ${size}`);
  }
  const cutOff = createJsonSplitter(() => {});
  cutOff.write('{"a": [1, 2');
  assert.equal(cutOff.end().complete, false);
  const openString = createJsonSplitter(() => {});
  openString.write('{"a": "x');
  assert.equal(openString.end().complete, false);
  const runaway = createJsonSplitter(() => {}, { maxBytes: 100 });
  runaway.write(`{"a":"${"x".repeat(40)}`);
  assert.throws(() => { for (let i = 0; i < 5; i++) runaway.write("x".repeat(40)); }, /larger than 100 bytes/);
});

// ── pod compaction ─────────────────────────────────────────────────────────────────────────────────────────────────

test("compactPod: GPU pod with sidecar, owner, labels and the collect label", () => {
  const raw = rawPod("train-0", {
    labels: { app: "train", [COLLECT_LABEL]: "true" }, owner: { kind: "StatefulSet", name: "train" }, node: "gpu-3",
    containers: [
      { name: "main", image: "registry.local/train:7", resources: { requests: { cpu: "32", memory: "256Gi", "nvidia.com/gpu": "8" }, limits: { "nvidia.com/gpu": "8" } } },
      { name: "sidecar", image: "registry.local/side:1", resources: { requests: { cpu: "500m", memory: "512Mi" } } },
    ],
  });
  const pod = compactPod(raw, { site: "os", cluster: "ulanqab-osmium" });
  assert.deepEqual(pick(pod, ["key", "site", "cluster", "namespace", "name", "phase", "ready", "restarts", "node", "podIP", "collect"]), {
    key: podKey("os", NAMESPACE, "train-0"), site: "os", cluster: "ulanqab-osmium", namespace: NAMESPACE, name: "train-0",
    phase: "Running", ready: "2/2", restarts: 0, node: "gpu-3", podIP: "10.0.0.7", collect: true,
  });
  assert.deepEqual(pod.requests, { cpu: "32500m", memory: "262656Mi", gpu: 8 });
  assert.deepEqual(pod.owner, { kind: "StatefulSet", name: "train" });
  assert.deepEqual(pod.labels, { app: "train", [COLLECT_LABEL]: "true" });
  assert.deepEqual(pod.containers.map(c => [c.name, c.image, c.state, c.ready]), [["main", "registry.local/train:7", "Running", true], ["sidecar", "registry.local/side:1", "Running", true]]);
  assert.equal(pod.createdAt, Date.parse("2026-10-30T01:00:00Z"));
  assert.equal(pod.startedAt, Date.parse("2026-10-30T01:00:02Z"));
  assert.ok(JSON.stringify(pod).length < 1500, "managedFields, annotations and imageIDs are dropped");
  assert.equal(compactPod(rawPod("plain"), { site: "os", cluster: "c" }).collect, false);
  assert.deepEqual(compactPod(rawPod("one", { containers: [{ name: "m", image: "i", resources: { requests: { cpu: "250m", memory: "4G" } } }] }), { site: "os", cluster: "c" }).requests, { cpu: "250m", memory: "4G" });
});

test("compactPod: crash loops, finished jobs, evictions, init failures and terminating pods", () => {
  const where = { site: "iron", cluster: "ulanqab-iron" };
  const crash = compactPod(crashing("loop", 7), where);
  assert.deepEqual(crash.containers[0], { name: "main", image: "registry.local/app:1", ready: false, state: "CrashLoopBackOff", restarts: 7 });
  assert.deepEqual(pick(crash, ["phase", "ready", "restarts"]), { phase: "Running", ready: "0/1", restarts: 7 });

  const job = compactPod(rawPod("job-1-abc", { phase: "Succeeded", owner: { kind: "Job", name: "job-1" }, finishedAt: "2026-10-30T02:30:00Z" }), where);
  assert.equal(job.containers[0].state, "Completed");
  assert.equal(job.finishedAt, Date.parse("2026-10-30T02:30:00Z"));
  assert.deepEqual(job.owner, { kind: "Job", name: "job-1" });

  const evicted = compactPod(rawPod("evicted", {
    phase: "Failed", reason: "Evicted", noStatuses: true,
    conditions: [{ type: "PodScheduled", lastTransitionTime: "2026-10-30T01:00:01Z" }, { type: "DisruptionTarget", lastTransitionTime: "2026-10-30T03:00:00Z" }],
  }), where);
  assert.deepEqual(pick(evicted, ["phase", "reason", "ready", "finishedAt"]), { phase: "Failed", reason: "Evicted", ready: "0/1", finishedAt: Date.parse("2026-10-30T03:00:00Z") });
  assert.equal(evicted.containers[0].state, "Unknown");

  const init = compactPod(rawPod("init", {
    phase: "Pending",
    initStatuses: [{ name: "setup", ready: false, restartCount: 2, state: { terminated: { exitCode: 1, reason: "Error" } } }],
    statuses: [{ name: "main", ready: false, restartCount: 0, state: { waiting: { reason: "PodInitializing" } } }],
  }), where);
  assert.deepEqual(pick(init, ["phase", "reason"]), { phase: "Pending", reason: "Init:Error" });
  assert.equal(init.containers[0].state, "PodInitializing");

  const dying = compactPod(rawPod("bye", { deleting: "2026-10-30T04:00:00Z" }), where);
  assert.deepEqual(pick(dying, ["phase", "reason", "deletedAt"]), { phase: "Running", reason: "Terminating", deletedAt: Date.parse("2026-10-30T04:00:00Z") });
  assert.equal(compactPod(rawPod("fine"), where).reason, undefined);

  const queued = compactPod(rawPod("queued", {
    phase: "Pending", noStatuses: true,
    conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable", message: "0/12 nodes are available: 12 Insufficient nvidia.com/gpu." }],
  }), where);
  assert.deepEqual(pick(queued, ["phase", "reason", "ready"]), { phase: "Pending", reason: "Unschedulable", ready: "0/1" });
  assert.equal(compactPod(rawPod("starting", { phase: "Pending", noStatuses: true, conditions: [{ type: "PodScheduled", status: "True" }] }), where).reason, undefined);
});

// ── list + watch lifecycle ─────────────────────────────────────────────────────────────────────────────────────────

test("list + watch: active pods only, replay ignored, pretty-printed and 200 KB events, finished pods leave", async t => {
  const env = makeEnv(t), rec = recorder();
  const p1 = rawPod("p1", { rv: "10" });
  const p2 = crashing("p2", 7, { rv: "11" });
  const p3 = rawPod("p3", { rv: "13", phase: "Pending" });
  const big = rawPod("big", { rv: "14", annotations: { "kubectl.kubernetes.io/last-applied-configuration": '{"k":"v\\"}"}'.repeat(15_000) } });
  env.scenario({
    "ctx-os": { cycles: [{
      list: { items: [p1, p2, rawPod("done-job", { phase: "Succeeded", rv: "5" }), rawPod("failed-job", { phase: "Failed", rv: "6" })] },
      watch: { steps: [
        { after: 50, events: [{ type: "MODIFIED", object: rawPod("p2", { rv: "12", restart: 8 }) }] }, // recovered, pretty-printed
        { after: 60, events: [{ type: "ADDED", object: p3 }], compact: true },
        { after: 70, events: [{ type: "ADDED", object: big }], slice: 4096 }, // one object delivered over ~50 reads
        { after: 150, events: [{ type: "MODIFIED", object: churn(p1, "15") }, { type: "DELETED", object: p3 }] },
        { after: 170, events: [{ type: "MODIFIED", object: rawPod("p2", { rv: "20", phase: "Failed", restart: 8 }) }] }, // finished: leaves the active set
      ] },
    }] },
  });
  const source = startSource(env, rec, { sites: { os: "ctx-os" } });

  await waitFor(() => rec.lists.length === 1, "initial list");
  assert.deepEqual(rec.lists[0].pods.map(p => p.name), ["p1", "p2"], "finished pods are not in the active set");
  assert.equal(rec.lists[0].pods[1].containers[0].state, "CrashLoopBackOff");
  assert.equal(rec.states[0].status, "online");

  await waitFor(() => rec.gone.length === 2 && rec.pod("os", "big"), "watch to finish");
  assert.deepEqual(rec.gone.map(g => g.key), [podKey("os", NAMESPACE, "p3"), podKey("os", NAMESPACE, "p2")]);
  assert.deepEqual(rec.names("os"), ["big", "p1"]);
  const watched = rec.seen.filter(s => s.state === "watch").map(s => s.pod);
  assert.deepEqual(watched.map(p => p.name), ["p2", "p3", "big"], "p1 is never re-sent: the replay and the heartbeat change are invisible");
  assert.deepEqual(pick(watched[0], ["phase", "ready", "restarts"]), { phase: "Running", ready: "1/1", restarts: 8 });
  assert.equal(watched[2].containers[0].state, "Running");
  assert.ok(JSON.stringify(watched[2]).length < 2000, "the 200 KB annotation is not forwarded");
  assert.deepEqual(rec.states.map(s => s.status), ["online"]);

  const info = source.describe("os");
  assert.deepEqual(pick(info, ["status", "error", "pods", "phases", "lists", "watches"]), { status: "online", error: "", pods: 2, phases: { Running: 2 }, lists: 1, watches: 1 });
  assert.deepEqual(info.events, { ADDED: 4, MODIFIED: 3, DELETED: 1, changed: 3, replayed: 3 });
  assert.equal(source.describe("nowhere"), null);

  // every kubectl call names kubeconfig, context and namespace; list and watch are active-only; only the one-shot list has a request timeout
  const [list, watch, ...rest] = watchedCalls(env);
  assert.equal(rest.length, 0);
  for (const call of [list, watch]) {
    assert.equal(call.flags["--kubeconfig"], env.kubeconfig);
    assert.equal(call.flags["--context"], "ctx-os");
    assert.equal(call.flags["-n"], NAMESPACE);
    assert.equal(call.flags["--field-selector"], ACTIVE_ONLY);
    assert.equal(call.flags["-o"], "json");
  }
  assert.equal(list.flags["--watch"], undefined);
  assert.equal(list.flags["--request-timeout"], "15s");
  assert.equal(watch.flags["--watch"], true);
  assert.equal(watch.flags["--output-watch-events"], true);
  assert.equal(watch.flags["--request-timeout"], undefined);
});

test("list larger than a pipe buffer streams through item by item", async t => {
  const env = makeEnv(t), rec = recorder();
  const pods = Array.from({ length: 300 }, (_, i) => rawPod(`bulk-${String(i).padStart(3, "0")}`, { annotations: { blob: `{"n":${i}}`.repeat(700) } }));
  env.scenario({ "ctx-os": { cycles: [{ list: { items: pods }, watch: {} }] } });
  startSource(env, rec, { sites: { os: "ctx-os" } });
  await waitFor(() => rec.lists.length === 1, "list", 20_000);
  assert.deepEqual(rec.lists[0].pods.map(p => p.name), pods.map(p => p.metadata.name));
  assert.ok(rec.lists[0].pods.every(p => p.containers.length === 1 && p.phase === "Running"));
});

test("a failing context reports unreachable with its stderr (no kubeconfig path), backs off, recovers; other sites are unaffected", async t => {
  const env = makeEnv(t), rec = recorder();
  env.scenario({
    "ctx-fail": { cycles: [
      { list: { code: 1, stderr: "Unable to connect to the server: dial tcp 10.1.2.3:6443: i/o timeout (kubeconfig {{KUBECONFIG}})" } },
      { list: { code: 1, stderr: "error: You must be logged in to the server (Unauthorized)" } },
      { list: { items: [rawPod("w1")] }, watch: {} },
    ] },
    "ctx-ok": { cycles: [{ list: { items: [rawPod("ok1")] }, watch: {} }] },
  });
  const source = startSource(env, rec, { sites: { a: "ctx-fail", b: "ctx-ok" } });
  await waitFor(() => rec.names("a").length === 1, "site a to recover");

  const statesA = rec.states.filter(s => s.site === "a");
  assert.deepEqual(statesA.map(s => s.status), ["unreachable", "unreachable", "online"]);
  assert.equal(statesA[0].error, "Unable to connect to the server: dial tcp 10.1.2.3:6443: i/o timeout (kubeconfig <kubeconfig>)");
  assert.equal(statesA[1].error, "error: You must be logged in to the server (Unauthorized)");
  assert.equal(statesA[1].since, statesA[0].since, "a new error text does not restart the unreachable period");
  assert.equal(statesA[2].error, "");
  assert.ok(statesA[2].since >= statesA[1].since);
  assert.deepEqual(rec.states.filter(s => s.site === "b").map(s => s.status), ["online"]);
  assert.deepEqual(rec.lists.map(l => l.site).sort(), ["a", "b"], "failed cycles deliver no pods");
  assert.ok(!JSON.stringify(source.describe()).includes(env.kubeconfig));

  const lists = env.calls(c => c.ctx === "ctx-fail" && c.words[1] === "pods" && !c.flags["--watch"]);
  assert.equal(lists.length, 3);
  assert.ok(lists[1].at - lists[0].at >= 20 && lists[2].at - lists[1].at >= 40, "the delay between attempts doubles");
});

test("a missing kubectl binary is reported as unreachable", async t => {
  const env = makeEnv(t), rec = recorder();
  startSource(env, rec, { sites: { os: "ctx-os" }, kubectl: join(env.dir, "no-such-kubectl") });
  await waitFor(() => rec.states.length > 0, "state");
  assert.equal(rec.states[0].status, "unreachable");
  assert.match(rec.states[0].error, /ENOENT/);
});

test("watch restarts relist: clean exit keeps the site online, a failed watch flips it, vanished pods are dropped", async t => {
  const env = makeEnv(t), rec = recorder();
  env.scenario({
    "ctx-os": { cycles: [
      { list: { items: [rawPod("p1"), rawPod("p2", { rv: "2" })] }, watch: { exitAfter: 60, code: 0 } },
      { list: { items: [rawPod("p2", { rv: "3", restart: 1 }), rawPod("p5")] }, watch: { exitAfter: 60, code: 1, stderr: "error: unexpected EOF" } },
      { list: { items: [rawPod("p5")] }, watch: {} },
    ] },
  });
  const source = startSource(env, rec, { sites: { os: "ctx-os" }, confirmMs: 50 });
  await waitFor(() => rec.lists.length === 3 && rec.states.length === 3, "three lists and three state changes");
  assert.deepEqual(rec.lists.map(l => l.pods.map(p => p.name)), [["p1", "p2"], ["p2", "p5"], ["p5"]]);
  assert.equal(rec.lists[1].pods[0].restarts, 1);
  assert.deepEqual(rec.gone.map(g => g.key), [podKey("os", NAMESPACE, "p1"), podKey("os", NAMESPACE, "p2")]);
  assert.deepEqual(rec.states.map(s => s.status), ["online", "unreachable", "online"]);
  assert.equal(rec.states[1].error, "error: unexpected EOF");
  assert.ok(source.describe("os").restarts >= 2);
});

test("a server that ignores the field selector cannot make finished pods active", async t => {
  const env = makeEnv(t), rec = recorder();
  env.scenario({
    "ctx-os": { cycles: [
      { list: { items: [rawPod("p1"), rawPod("p2")] }, watch: { exitAfter: 40, code: 0 } },
      {
        list: { ignoreSelector: true, items: [rawPod("p1", { rv: "2" }), rawPod("p2", { phase: "Succeeded", rv: "3" }), rawPod("p9", { phase: "Failed" })] },
        watch: { steps: [{ after: 10, events: [{ type: "ADDED", object: rawPod("p9", { phase: "Failed" }) }, { type: "MODIFIED", object: rawPod("p1", { phase: "Succeeded", rv: "5" }) }] }] },
      },
    ] },
  });
  startSource(env, rec, { sites: { os: "ctx-os" } });
  await waitFor(() => rec.lists.length === 2 && rec.gone.length === 2, "second list and its watch");
  assert.deepEqual(rec.lists[1].pods.map(p => p.name), ["p1"], "a finished pod in a list is not active");
  assert.deepEqual(rec.gone.map(g => g.key), [podKey("os", NAMESPACE, "p2"), podKey("os", NAMESPACE, "p1")], "a pod that finishes in a watch event leaves");
  assert.deepEqual(rec.names("os"), []);
});

test("a pod that vanished between the list and the watch's replay is dropped once the replay settles", async t => {
  const env = makeEnv(t), rec = recorder();
  env.scenario({
    "ctx-os": { cycles: [
      { list: { items: [rawPod("p1"), rawPod("p2"), rawPod("p3")] }, watch: { replay: [rawPod("p1"), rawPod("p3")] } }, // p2 finished after the list was taken
      { list: { items: [rawPod("p1"), rawPod("p3")] } }, // the settling list
    ] },
  });
  startSource(env, rec, { sites: { os: "ctx-os" }, quietMs: 100 });
  await waitFor(() => rec.lists.length === 1, "initial list");
  assert.deepEqual(rec.names("os"), ["p1", "p2", "p3"]);
  await waitFor(() => rec.gone.length === 1, "settle");
  assert.deepEqual(rec.gone, [{ site: "os", key: podKey("os", NAMESPACE, "p2") }]);
  assert.deepEqual(rec.names("os"), ["p1", "p3"]);
  assert.equal(watchedCalls(env).filter(c => !c.flags["--watch"]).length, 2, "exactly one extra list");
  assert.equal(rec.lists.length, 1, "the settling list only removes, it does not replace the set");
});

test("a watch that cannot start keeps the site unreachable instead of flapping, and the lists stay fresh meanwhile", async t => {
  const env = makeEnv(t), rec = recorder();
  const denied = 'Error from server (Forbidden): pods is forbidden: User "fleet" cannot watch resource "pods" in API group "" in the namespace "mc-bochao-li"';
  env.scenario({
    "ctx-os": { cycles: [
      { list: { items: [rawPod("p1")] }, watch: { exitAfter: 10, code: 1, stderr: denied } },
      { list: { items: [rawPod("p1")] }, watch: { exitAfter: 10, code: 1, stderr: denied } },
      { list: { items: [rawPod("p1"), rawPod("p2")] }, watch: {} },
    ] },
  });
  startSource(env, rec, { sites: { os: "ctx-os" }, confirmMs: 100 });
  await waitFor(() => rec.states.length === 3, "unreachable and recovered");
  assert.deepEqual(rec.states.map(s => s.status), ["online", "unreachable", "online"]);
  assert.equal(rec.states[1].error, denied);
  assert.deepEqual(rec.lists.map(l => l.pods.map(p => p.name)), [["p1"], ["p1"], ["p1", "p2"]]);
});

test("a watch ERROR event (410 Gone) restarts the cycle without calling the site unreachable", async t => {
  const env = makeEnv(t), rec = recorder();
  const gone = { kind: "Status", apiVersion: "v1", status: "Failure", message: "too old resource version: 1 (2)", reason: "Expired", code: 410 };
  env.scenario({
    "ctx-os": { cycles: [
      { list: { items: [rawPod("p1")] }, watch: { steps: [{ after: 10, events: [{ type: "ERROR", object: gone }] }] } },
      { list: { items: [rawPod("p1"), rawPod("p2")] }, watch: {} },
    ] },
  });
  const source = startSource(env, rec, { sites: { os: "ctx-os" } });
  await waitFor(() => rec.lists.length === 2, "second list");
  assert.deepEqual(rec.lists[1].pods.map(p => p.name), ["p1", "p2"]);
  assert.deepEqual(rec.states.map(s => s.status), ["online"]);
  assert.match(source.describe("os").lastWatchError, /too old resource version/);
});

test("stop() kills kubectl, spawns nothing afterwards and start() is idempotent", async t => {
  const env = makeEnv(t), rec = recorder();
  env.scenario({ "ctx-os": { cycles: [{ list: { items: [rawPod("p1")] }, watch: {} }] } });
  const source = startSource(env, rec, { sites: { os: "ctx-os" } });
  source.start();
  await waitFor(() => rec.lists.length === 1, "list");
  const pidFile = env.file("pid-ctx-os-watch-0");
  const pid = Number(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8"), "watch pid"));
  process.kill(pid, 0);
  assert.equal(watchedCalls(env).filter(c => !c.flags["--watch"]).length, 1, "one loop per site");
  const began = Date.now();
  await source.stop();
  assert.ok(Date.now() - began < 3000);
  await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, "watch process to exit");
  const calls = env.calls().length;
  await sleep(250);
  assert.equal(env.calls().length, calls);
});

/** Runs `node script args…` as the leader of its own process group, so even a stray kill(0) could only hit that child. */
function runIsolated(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { detached: true, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

test("a kubectl that cannot be executed is never signalled: stop() in the tick of a failed spawn must not kill(0)", async t => {
  const env = makeEnv(t);
  const notExecutable = env.file("kubectl-without-exec-bit");
  writeFileSync(notExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
  for (const [why, kubectl] of [["ENOENT", env.file("no-such-kubectl")], ["EACCES", notExecutable]]) {
    // A child whose spawn failed has no pid yet; signalling it would hit pid 0 (this process group) or a stale pid.
    const run = await runIsolated(START_STOP, [kubectl]);
    assert.deepEqual({ signal: run.signal, code: run.code }, { signal: null, code: 0 }, `${why}: ${run.stderr}`);
    assert.deepEqual(JSON.parse(run.stdout), { controlSeen: true, killsWithoutPid: [], lookup: "rejected" }, why);
  }
});

// ── getPod ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test("getPod: live pod without kubectl, finished pod via `get pod` with a 60 s LRU cache, NotFound cached, transport errors not", async t => {
  const env = makeEnv(t), rec = recorder();
  const finished = rawPod("job-1-abc", { phase: "Succeeded", owner: { kind: "Job", name: "job-1" }, finishedAt: "2026-10-30T02:30:00Z" });
  const base = { cycles: [{ list: { items: [rawPod("p1")] }, watch: {} }], objects: { "job-1-abc": finished, "p-other": rawPod("p-other", { phase: "Failed" }), flaky: rawPod("flaky", { phase: "Succeeded" }) } };
  env.scenario({ "ctx-os": base });
  let clock = 1_000_000;
  const source = startSource(env, rec, { sites: { os: "ctx-os" }, now: () => clock, lookupCacheSize: 2 });
  await waitFor(() => rec.lists.length === 1, "list");
  const lookups = () => env.calls(c => c.words[0] === "get" && c.words[1] === "pod");

  assert.equal((await source.getPod({ site: "os", namespace: NAMESPACE, name: "p1" })).phase, "Running");
  assert.equal(lookups().length, 0, "an active pod is answered from the watch");

  const job = await source.getPod({ site: "os", name: "job-1-abc" });
  assert.deepEqual(pick(job, ["key", "phase", "finishedAt", "ready"]), { key: podKey("os", NAMESPACE, "job-1-abc"), phase: "Succeeded", finishedAt: Date.parse("2026-10-30T02:30:00Z"), ready: "0/1" });
  assert.equal(job.containers[0].state, "Completed");
  assert.equal(lookups().length, 1);
  assert.deepEqual(lookups()[0].words, ["get", "pod", "job-1-abc"]);
  assert.equal(lookups()[0].flags["-o"], "json");
  assert.equal(lookups()[0].flags["--request-timeout"], "15s");
  assert.equal(lookups()[0].flags["--kubeconfig"], env.kubeconfig);

  clock += 59_000;
  assert.deepEqual(await source.getPod({ site: "os", name: "job-1-abc" }), job);
  assert.equal(lookups().length, 1, "cached within 60 s");
  clock += 2_000;
  await source.getPod({ site: "os", name: "job-1-abc" });
  assert.equal(lookups().length, 2, "expired after 60 s");

  assert.equal(await source.getPod({ site: "os", name: "ghost" }), null);
  assert.equal(await source.getPod({ site: "os", name: "ghost" }), null);
  assert.equal(lookups().length, 3, "NotFound is cached too");

  // capacity 2: [job, ghost] + p-other evicts the oldest (job); p-other and the re-fetched job stay cached
  await source.getPod({ site: "os", name: "p-other" });
  assert.equal(lookups().length, 4);
  await source.getPod({ site: "os", name: "job-1-abc" });
  assert.equal(lookups().length, 5, "evicted entries are fetched again");
  await source.getPod({ site: "os", name: "p-other" });
  assert.equal(lookups().length, 5, "recently used entries survive");

  const lookup = () => source.getPod({ site: "os", name: "flaky" });
  env.scenario({ "ctx-os": { ...base, lookupFail: "Unable to connect to the server: net/http: TLS handshake timeout" } });
  await assert.rejects(lookup, /TLS handshake timeout/);
  env.scenario({ "ctx-os": base });
  assert.equal((await lookup()).phase, "Succeeded", "a failure is not cached");

  const before = lookups().length;
  const concurrent = await Promise.all([1, 2, 3].map(() => source.getPod({ site: "os", name: "job-1-abc" })));
  assert.ok(concurrent.every(p => p === concurrent[0]));
  assert.ok(lookups().length - before <= 1, "concurrent lookups share one kubectl call");

  const calls = env.calls().length;
  for (const query of [{ site: "mac", name: "x" }, { site: "os", namespace: "kube-system", name: "coredns" }, { site: "os", name: "../etc" }, { site: "os", name: "-n" }, { site: "os" }]) {
    assert.equal(await source.getPod(query), null, JSON.stringify(query));
  }
  assert.equal(env.calls().length, calls, "invalid or unwatched lookups never reach kubectl");
});

// ── collectors ─────────────────────────────────────────────────────────────────────────────────────────────────────

const BUNDLE = Buffer.from("// agent-fleet collector bundle (test)\nexport {};\n");
const collectLabels = { app: "ws", [COLLECT_LABEL]: "true", [CONTAINER_LABEL]: "workspace" };
const workspacePod = (o = {}) => rawPod("agent-fleet-test-0", { labels: collectLabels, containers: [{ name: "sidecar", image: "side:1" }, { name: "workspace", image: "node:22" }], ...o });
const execsOn = (env, name) => env.calls(c => c.words[0] === "exec" && c.words[1] === name);

function attacher() {
  const a = { attached: [], stops: [] };
  a.attachCollector = (site, pod, spec) => { a.attached.push({ site, pod, spec }); const n = a.attached.length; return { stop: () => a.stops.push(n) }; };
  return a;
}

test("collector attach: node probe, label-chosen container, sha-skipping push, spawn spec, container restart, deletion", async t => {
  const env = makeEnv(t), rec = recorder(), hub = attacher();
  const collect = { app: "x", [COLLECT_LABEL]: "true" };
  const watchSteps = [
    { gate: "restart", events: [{ type: "MODIFIED", object: workspacePod({ rv: "50", restart: 1 }) }] },
    { gate: "delete", events: [{ type: "DELETED", object: workspacePod({ rv: "60", restart: 1 }) }] },
  ];
  env.scenario({
    "ctx-os": {
      cycles: [{
        list: { items: [
          workspacePod(),
          rawPod("old-node", { labels: collect }), rawPod("bare", { labels: collect }), rawPod("queued", { labels: collect, phase: "Pending" }),
          rawPod("bad-container", { labels: { ...collect, [CONTAINER_LABEL]: "ghost" } }), rawPod("web-1", { labels: { app: "web" } }),
        ] },
        watch: { steps: watchSteps },
      }],
      pods: { "agent-fleet-test-0": { containers: ["sidecar", "workspace"], node: "v22.3.0" }, "old-node": { node: "v18.19.0" }, bare: {} },
    },
  });
  const source = startSource(env, rec, { sites: { os: "ctx-os" }, collectorBundle: BUNDLE, attachCollector: hub.attachCollector });
  const view = name => rec.pod("os", name);

  await waitFor(() => hub.attached.length === 1, "first attach");
  const [{ site, pod, spec }] = hub.attached;
  assert.equal(site, "os");
  assert.equal(pod.name, "agent-fleet-test-0");
  assert.equal(spec.command, env.kubectl);
  assert.equal(spec.hostId, podHostId("os", "agent-fleet-test-0"));
  assert.deepEqual(spec.args, [
    "--kubeconfig", env.kubeconfig, "--context", "ctx-os", "-n", NAMESPACE,
    "exec", "-i", "agent-fleet-test-0", "-c", "workspace", "--",
    "node", "/tmp/agent-fleet/collector.mjs", "collector", "--stdio", "--host-id", "k8s/os/agent-fleet-test-0", "--site", "os", "--kind", "pod", "--label", "agent-fleet-test-0",
  ]);

  await waitFor(() => view("agent-fleet-test-0")?.collector === "attached", "attached status");
  assert.equal(view("agent-fleet-test-0").hostId, "k8s/os/agent-fleet-test-0");
  assert.equal(rec.lists[0].pods.find(p => p.name === "agent-fleet-test-0").collector, "attaching", "the list already says an attach is under way");
  await waitFor(() => view("old-node")?.collector && view("bare")?.collector, "node verdicts");
  assert.equal(view("old-node").collector, "node v18.19.0 < 22");
  assert.equal(view("bare").collector, "no node runtime");
  assert.equal(view("queued").collector, "waiting for pod to run");
  assert.equal(view("bad-container").collector, 'container "ghost" not found');
  assert.equal(view("web-1").collector, undefined);
  assert.equal(view("old-node").hostId, undefined);
  assert.deepEqual(source.describe("os").collectors, { attached: 1, "node v18.19.0 < 22": 1, "no node runtime": 1, "waiting for pod to run": 1, 'container "ghost" not found': 1 });

  const [probe, push] = execsOn(env, "agent-fleet-test-0");
  assert.equal(probe.flags["-c"], "workspace", "the container named by the label, not the first one");
  assert.match(probe.remote[2], /command -v node && node -v/);
  assert.equal(push.flags["-i"], true);
  assert.match(push.remote[2], /cat > \/tmp\/agent-fleet\/collector\.mjs\.part/);
  assert.deepEqual(readFileSync(env.file("remote", "ctx-os-agent-fleet-test-0.bundle")), BUNDLE);
  for (const name of ["web-1", "queued", "bad-container"]) assert.equal(execsOn(env, name).length, 0, `${name} is never exec'd`);
  assert.equal(execsOn(env, "old-node").length, 1, "a node that is too old is not pushed to");

  writeFileSync(env.file("restart"), "");
  await waitFor(() => hub.attached.length === 2, "re-attach after the container restarted");
  assert.deepEqual(hub.stops, [1], "the old channel is released");
  await waitFor(() => view("agent-fleet-test-0")?.collector === "attached", "attached again");
  assert.equal(execsOn(env, "agent-fleet-test-0").length, 3, "a probe more, but no second push: the checksum matches");

  writeFileSync(env.file("delete"), "");
  await waitFor(() => hub.stops.length === 2, "detach on deletion");
  assert.deepEqual(rec.gone.map(g => g.key), [podKey("os", NAMESPACE, "agent-fleet-test-0")]);
  assert.equal(view("agent-fleet-test-0"), undefined);
});

test("collector attach: transient probe failures are retried quickly, then slowly; a read-only pod reports why; a corrupt push is caught", async t => {
  const env = makeEnv(t), rec = recorder(), hub = attacher();
  const pods = { "agent-fleet-test-0": { node: "v22.3.0", failProbe: 2 } };
  env.scenario({ "ctx-os": { cycles: [{ list: { items: [workspacePod()] }, watch: {} }], pods } });
  startSource(env, rec, { sites: { os: "ctx-os" }, collectorBundle: BUNDLE, attachCollector: hub.attachCollector, attachRetryMs: [20, 20, 20] });
  await waitFor(() => hub.attached.length === 1, "attach after two failed probes");
  const statuses = rec.seen.map(s => s.pod.collector);
  assert.ok(statuses.some(s => /^probe failed: error: unable to upgrade connection: container not found/.test(s)), statuses.join(" | "));
  assert.equal(statuses.at(-1), "attached");
  assert.equal(execsOn(env, "agent-fleet-test-0").filter(c => !c.flags["-i"]).length, 3, "three probes");

  const env2 = makeEnv(t), rec2 = recorder(), hub2 = attacher();
  env2.scenario({ "ctx-os": { cycles: [{ list: { items: [workspacePod()] }, watch: {} }], pods: { "agent-fleet-test-0": { node: "v22.3.0", failPush: true } } } });
  const source2 = startSource(env2, rec2, { sites: { os: "ctx-os" }, collectorBundle: BUNDLE, attachCollector: hub2.attachCollector, attachRetryMs: [20, 20] });
  await waitFor(() => execsOn(env2, "agent-fleet-test-0").filter(c => c.flags["-i"]).length === 3, "three push attempts");
  await sleep(150);
  assert.equal(execsOn(env2, "agent-fleet-test-0").filter(c => c.flags["-i"]).length, 3, "quick retries used up; the slow re-probe is minutes away");
  assert.equal(hub2.attached.length, 0);
  assert.match(rec2.pod("os", "agent-fleet-test-0").collector, /^push failed: sh: can't create .*Read-only file system/);
  assert.equal(Object.keys(source2.describe("os").collectors).length, 1);

  const env3 = makeEnv(t), rec3 = recorder(), hub3 = attacher();
  env3.scenario({ "ctx-os": { cycles: [{ list: { items: [workspacePod()] }, watch: {} }], pods: { "agent-fleet-test-0": { node: "v22.3.0", badPushSha: "0".repeat(64) } } } });
  startSource(env3, rec3, { sites: { os: "ctx-os" }, collectorBundle: BUNDLE, attachCollector: hub3.attachCollector, attachRetryMs: [] });
  await waitFor(() => rec3.pod("os", "agent-fleet-test-0")?.collector === "push failed: the bundle did not arrive intact", "integrity failure");
  assert.equal(hub3.attached.length, 0);
});

test("collector attach: a pod that gets a node runtime later is picked up by the slow re-probe, and stop() ends the retries", async t => {
  const env = makeEnv(t), rec = recorder(), hub = attacher();
  const scenario = node => ({ "ctx-os": { cycles: [{ list: { items: [workspacePod()] }, watch: {} }], pods: { "agent-fleet-test-0": node ? { node } : {} } } });
  env.scenario(scenario(null));
  const source = startSource(env, rec, { sites: { os: "ctx-os" }, collectorBundle: BUNDLE, attachCollector: hub.attachCollector, reprobeMs: 40 });
  await waitFor(() => rec.pod("os", "agent-fleet-test-0")?.collector === "no node runtime", "no node verdict");
  await waitFor(() => execsOn(env, "agent-fleet-test-0").length >= 3, "re-probes");
  assert.equal(hub.attached.length, 0);
  env.scenario(scenario("v22.3.0"));
  await waitFor(() => hub.attached.length === 1, "attach after node appeared");
  await waitFor(() => rec.pod("os", "agent-fleet-test-0").collector === "attached", "attached status");

  const env2 = makeEnv(t), rec2 = recorder(), hub2 = attacher();
  env2.scenario(scenario(null));
  const source2 = startSource(env2, rec2, { sites: { os: "ctx-os" }, collectorBundle: BUNDLE, attachCollector: hub2.attachCollector, reprobeMs: 40 });
  await waitFor(() => execsOn(env2, "agent-fleet-test-0").length >= 2, "first re-probe");
  await source2.stop();
  const probes = execsOn(env2, "agent-fleet-test-0").length;
  await sleep(200);
  assert.equal(execsOn(env2, "agent-fleet-test-0").length, probes, "no probes after stop()");
  await source.stop();
});

test("collector attach: the bundle may be a file path; a missing file and a missing hook are reported", async t => {
  const env = makeEnv(t), rec = recorder(), hub = attacher();
  const bundlePath = env.file("collector.mjs");
  writeFileSync(bundlePath, BUNDLE);
  env.scenario({ "ctx-os": { cycles: [{ list: { items: [workspacePod()] }, watch: {} }], pods: { "agent-fleet-test-0": { node: "v22.3.0" } } } });
  const source = startSource(env, rec, { sites: { os: "ctx-os" }, collectorBundle: bundlePath, attachCollector: hub.attachCollector });
  await waitFor(() => hub.attached.length === 1, "attach with a bundle path");
  assert.deepEqual(readFileSync(env.file("remote", "ctx-os-agent-fleet-test-0.bundle")), BUNDLE);
  await source.stop();
  assert.deepEqual(hub.stops, [1], "stop() releases the channels it opened");

  const env2 = makeEnv(t), rec2 = recorder(), hub2 = attacher();
  env2.scenario({ "ctx-os": { cycles: [{ list: { items: [workspacePod()] }, watch: {} }], pods: { "agent-fleet-test-0": { node: "v22.3.0" } } } });
  startSource(env2, rec2, { sites: { os: "ctx-os" }, collectorBundle: env2.file("missing.mjs"), attachCollector: hub2.attachCollector, attachRetryMs: [] });
  await waitFor(() => rec2.pod("os", "agent-fleet-test-0")?.collector?.startsWith("bundle unavailable:"), "bundle error");
  assert.equal(execsOn(env2, "agent-fleet-test-0").length, 0);

  const env3 = makeEnv(t), rec3 = recorder();
  env3.scenario({ "ctx-os": { cycles: [{ list: { items: [workspacePod(), rawPod("web-1")] }, watch: {} }], pods: { "agent-fleet-test-0": { node: "v22.3.0" } } } });
  startSource(env3, rec3, { sites: { os: "ctx-os" }, collectorBundle: BUNDLE });
  await waitFor(() => rec3.lists.length === 1, "list");
  assert.equal(rec3.pod("os", "agent-fleet-test-0").collector, "collector not configured");
  assert.equal(rec3.pod("os", "web-1").collector, undefined);
  assert.equal(env3.calls(c => c.words[0] === "exec").length, 0);
});

// ── readPodFile ────────────────────────────────────────────────────────────────────────────────────────────────────

/** A source over a fake pod whose "filesystem" is the scratch directory (the pod-side script really runs under sh). */
function filePod(t) {
  const env = makeEnv(t);
  env.scenario({ "ctx-os": { pods: { "pod-a": { containers: ["workspace"] } } } });
  const source = env.track(createKubeSource({ kubeconfig: env.kubeconfig, kubectl: env.kubectl, sites: { os: "ctx-os" } }));
  const read = (path, extra = {}) => source.readPodFile({ site: "os", pod: "pod-a", container: "workspace", path, knownSecrets: [], ...extra });
  const execCalls = () => env.calls(c => c.words[0] === "exec");
  return { env, source, read, execCalls };
}

test("readPodFile: text is redacted, stat is reported, the path is a positional argument of a constant script", async t => {
  const { env, read, execCalls } = filePod(t);
  const notes = env.file("files", "notes.txt");
  writeFileSync(notes, "hello\nOPENAI_API_KEY=sk-test0123456789abcdefghijklmn\nbye\n");
  utimesSync(notes, 1_700_000_000, 1_700_000_000);
  assert.equal(isSecretPath(notes), false, "test paths must not look secret");

  const preview = await read(notes);
  assert.deepEqual(pick(preview, ["host", "path", "exists", "size", "mtime", "truncated", "binary"]), {
    host: "k8s/os/pod-a", path: notes, exists: true, size: readFileSync(notes).length, mtime: 1_700_000_000_000, truncated: false, binary: false,
  });
  assert.ok(preview.content.includes("hello") && preview.content.includes("OPENAI_API_KEY="));
  assert.ok(!preview.content.includes("sk-test0123456789"), preview.content);
  assert.ok(preview.redactions >= 1);

  const [call] = execCalls();
  assert.deepEqual(call.words, ["exec", "pod-a"]);
  assert.equal(call.flags["-c"], "workspace");
  assert.equal(call.flags["--request-timeout"], "15s");
  assert.deepEqual([call.remote[0], call.remote[1], call.remote[3], call.remote[4], call.remote[5]], ["sh", "-c", "sh", notes, String(256 * 1024)]);
  assert.ok(!call.remote[2].includes(notes), "the path is never part of the script");
});

test("readPodFile: truncation by maxBytes, multi-byte cuts, binary and non-UTF-8 files, missing files and directories", async t => {
  const { env, read } = filePod(t);
  const log = env.file("files", "big.log");
  writeFileSync(log, "line of text\n".repeat(1000));
  const cut = await read(log, { maxBytes: 1000 });
  assert.deepEqual(pick(cut, ["exists", "size", "truncated"]), { exists: true, size: 13_000, truncated: true });
  assert.equal(cut.content.length, 1000);

  const cjk = env.file("files", "cjk.txt");
  writeFileSync(cjk, "日本語".repeat(10));
  const sliced = await read(cjk, { maxBytes: 10 }); // 3 whole characters + 1 byte of the fourth
  assert.equal(sliced.content, "日本語");
  assert.equal(sliced.truncated, true);

  // /etc/os-release is a symlink in most images: size and truncation describe the target, not the link
  const target = env.file("files", "real.txt"), link = env.file("files", "link.txt");
  writeFileSync(target, "0123456789".repeat(30));
  symlinkSync("real.txt", link);
  const through = await read(link, { maxBytes: 100 });
  assert.deepEqual(pick(through, ["exists", "size", "truncated"]), { exists: true, size: 300, truncated: true });
  assert.equal(through.content.length, 100);

  const blob = env.file("files", "blob.bin");
  writeFileSync(blob, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255, 254]));
  assert.deepEqual(pick(await read(blob), ["exists", "size", "binary", "content"]), { exists: true, size: 10, binary: true, content: undefined });
  const latin = env.file("files", "latin1.txt");
  writeFileSync(latin, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  assert.equal((await read(latin)).binary, true, "invalid UTF-8 is not shown as text");

  assert.deepEqual(await read(env.file("files", "absent.txt")), { host: "k8s/os/pod-a", path: env.file("files", "absent.txt"), exists: false });
  assert.deepEqual(await read(env.file("files")), { host: "k8s/os/pod-a", path: env.file("files"), exists: true, denied: "is a directory" });

  // a harmless-looking link to a credentials file is refused after resolution, a link to a plain file is not
  mkdirSync(env.file("files", ".ssh"));
  writeFileSync(env.file("files", ".ssh", "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n");
  symlinkSync(".ssh/id_rsa", env.file("files", "innocent.txt"));
  const viaLink = await read(env.file("files", "innocent.txt"));
  assert.deepEqual(viaLink, { host: "k8s/os/pod-a", path: env.file("files", "innocent.txt"), exists: false, denied: "secret path: credentials are never previewed" });
});

test("readPodFile: hostile file names stay data, refused paths never reach kubectl", async t => {
  const { env, read, execCalls } = filePod(t);
  const weird = env.file("files", `we ird $(touch pwned) 'q" \`touch pwned\`; name.txt`);
  writeFileSync(weird, "payload\n");
  assert.equal((await read(weird)).content, "payload\n");
  const [call] = execCalls();
  assert.equal(call.remote[4], weird);
  const script = call.remote[2];
  await read(env.file("files", "notes-2.txt"));
  assert.equal(execCalls().at(-1).remote[2], script, "the remote script is the same constant whatever the path");
  assert.equal(existsSync(join(env.dir, "files", "pwned")) || existsSync("pwned") || existsSync(join(here, "..", "pwned")), false);

  const before = env.calls().length;
  const secret = "secret path: credentials are never previewed";
  assert.deepEqual(await read("/root/.ssh/id_rsa"), { host: "k8s/os/pod-a", path: "/root/.ssh/id_rsa", exists: false, denied: secret });
  assert.equal((await read("/var/run/secrets/kubernetes.io/serviceaccount/token")).denied, secret);
  assert.equal((await read("/home/u/.kube/config")).denied, secret);
  assert.equal((await read("/proc/1/environ")).denied, "pseudo filesystem");
  assert.equal((await read("/sys/kernel/notes")).denied, "pseudo filesystem");
  assert.equal((await read("relative/path.txt")).denied, "path must be absolute");
  assert.equal((await read("/etc/hosts", { namespace: "kube-system" })).denied, "namespace kube-system is not watched");
  await assert.rejects(() => read("/etc/hosts", { pod: "../x" }), /invalid pod name/);
  await assert.rejects(() => read("/etc/hosts", { pod: "-n" }), /invalid pod name/);
  await assert.rejects(() => read("/etc/hosts", { container: "--rm" }), /invalid container name/);
  await assert.rejects(() => read("/etc/hosts\0x"), /invalid path/);
  await assert.rejects(() => read(""), /invalid path/);
  assert.equal(env.calls().length, before, "none of these reached kubectl");

  await assert.rejects(() => read("/etc/hosts", { pod: "no-such-pod" }), /NotFound/);
  await assert.rejects(() => read("/etc/hosts", { container: "sidecar" }), /container sidecar is not valid/);
});

// ── podEvents ──────────────────────────────────────────────────────────────────────────────────────────────────────

test("readPodFile: secret paths are case-insensitive and fleet-token content is refused; ordinary files preview", async t => {
  const { env, read } = filePod(t);
  mkdirSync(env.file("files", ".SSH"));
  writeFileSync(env.file("files", ".SSH", "ID_RSA"), "SSH-PRIVATE-MARKER\n");
  const upper = await read(env.file("files", ".SSH", "ID_RSA"));
  assert.equal(upper.denied, "secret path: credentials are never previewed");
  assert.equal(upper.content, undefined);
  assert.equal((await read(env.file("files", "ID_RSA"))).denied, "secret path: credentials are never previewed");
  // the path looks harmless, but `readlink -f` resolves it to the upper-case secret path
  symlinkSync(".SSH/ID_RSA", env.file("files", "upper-link.txt"));
  assert.equal((await read(env.file("files", "upper-link.txt"))).denied, "secret path: credentials are never previewed");

  const token = "0123456789abcdef".repeat(4);
  const copy = env.file("files", "token-copy.txt");
  writeFileSync(copy, `${token}\n`);
  const copied = await read(copy, { knownSecrets: [token] });
  assert.match(copied.denied ?? "", /secret content/, "a copy of a fleet token is refused by content");
  assert.equal(copied.content, undefined);
  assert.ok(!JSON.stringify(copied).includes(token), "the refusal does not echo the token");

  const embedded = env.file("files", "agent.log");
  writeFileSync(embedded, `2026-10-31T08:00:02Z reading config\nx-agent-fleet-token: ${token}\n`);
  assert.match((await read(embedded, { knownSecrets: [token] })).denied ?? "", /secret content/);

  const bare = env.file("files", "bare64.txt"), blob = env.file("files", "blob64.txt");
  writeFileSync(bare, `${token}\n`);
  writeFileSync(blob, `${"QUJD".repeat(40)}==\n`);
  assert.match((await read(bare, { knownSecrets: [] })).denied ?? "", /secret content/, "a lone 64-hex line");
  assert.match((await read(blob, { knownSecrets: [] })).denied ?? "", /secret content/, "a long base64 line");

  const source = env.file("files", "server.mjs"), config = env.file("files", "fleet.json"), log = env.file("files", "hub.log");
  writeFileSync(source, "export function add(a, b) {\n  return a + b;\n}\n");
  writeFileSync(config, '{"name":"fleet","port":8080,"tags":["a","b"]}\n');
  writeFileSync(log, "2026-10-31T08:00:00Z starting hub\n2026-10-31T08:00:01Z listening on 127.0.0.1:7840\n");
  for (const [file, needle] of [[source, "export function add"], [config, '"port":8080'], [log, "listening on 127.0.0.1:7840"]]) {
    const preview = await read(file, { knownSecrets: [token] });
    assert.equal(preview.exists, true, `${file} ${preview.denied ?? ""}`);
    assert.equal(preview.binary, false);
    assert.ok(preview.content.includes(needle), preview.content);
  }
});

// ── podEvents ──────────────────────────────────────────────────────────────────────────────────────────────────────

test("podEvents: compact list, oldest first, redacted and cut to 240 characters, old and new event shapes", async t => {
  const env = makeEnv(t);
  const events = [
    { type: "Warning", reason: "BackOff", count: 12, firstTimestamp: "2026-10-30T01:00:10Z", lastTimestamp: "2026-10-30T01:05:00Z",
      message: "Back-off restarting failed container main (token=abcdefghijklmnopqrstuvwxyz0123456789 Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789)" },
    { type: "Normal", reason: "Scheduled", message: "Successfully assigned mc-bochao-li/p1 to node-1", count: 1, firstTimestamp: "2026-10-30T01:00:01Z", lastTimestamp: "2026-10-30T01:00:01Z" },
    { type: "Normal", reason: "Pulled", message: "x".repeat(400), eventTime: "2026-10-30T01:00:03.000000Z", series: { count: 3, lastObservedTime: "2026-10-30T01:00:30.000000Z" }, metadata: { creationTimestamp: "2026-10-30T01:00:03Z" } },
  ];
  env.scenario({ "ctx-os": { events: { p1: events, noisy: Array.from({ length: 150 }, (_, i) => ({ type: "Normal", reason: `R${i}`, message: "m", count: 1, lastTimestamp: new Date(Date.UTC(2026, 9, 30, 1, 0, i)).toISOString() })) } } });
  const source = env.track(createKubeSource({ kubeconfig: env.kubeconfig, kubectl: env.kubectl, sites: { os: "ctx-os" } }));

  const list = await source.podEvents({ site: "os", namespace: NAMESPACE, pod: "p1" });
  assert.deepEqual(list.map(e => [e.reason, e.type, e.count]), [["Scheduled", "Normal", 1], ["Pulled", "Normal", 3], ["BackOff", "Warning", 12]]);
  assert.deepEqual(pick(list[1], ["firstAt", "lastAt"]), { firstAt: Date.parse("2026-10-30T01:00:03Z"), lastAt: Date.parse("2026-10-30T01:00:30Z") });
  assert.equal(list[1].message.length, 240);
  assert.ok(list[1].message.endsWith("…"));
  assert.ok(!list[2].message.includes("abcdefghijklmnopqrstuvwxyz0123456789"), list[2].message);
  assert.ok(list[2].message.includes("‹redacted›"));
  assert.deepEqual(Object.keys(list[0]), ["type", "reason", "message", "count", "firstAt", "lastAt"]);

  const [call] = env.calls(c => c.words[1] === "events");
  assert.equal(call.flags["--field-selector"], "involvedObject.kind=Pod,involvedObject.name=p1");
  assert.equal(call.flags["--request-timeout"], "15s");
  assert.equal(call.flags["--context"], "ctx-os");

  const noisy = await source.podEvents({ site: "os", pod: "noisy" });
  assert.equal(noisy.length, 100);
  assert.equal(noisy.at(-1).reason, "R149", "the newest events are kept");
  assert.deepEqual(await source.podEvents({ site: "os", pod: "quiet" }), []);
  await assert.rejects(() => source.podEvents({ site: "os", pod: "p1", namespace: "kube-system" }), /not watched/);
  await assert.rejects(() => source.podEvents({ site: "os", pod: "--all-namespaces" }), /invalid pod name/);
  await assert.rejects(() => source.podEvents({ site: "mac", pod: "p1" }), /unknown kube site/);
});
