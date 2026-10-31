// Readers slice: lib/jsonl.mjs (incremental tail, zstd frames) and lib/collector/readers/* over synthetic fixtures
// (tests/fixtures/readers/**, modelled on the structure of real OMP / Claude / Codex / DSH transcripts).
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { constants, zstdCompressSync } from "node:zlib";
import { createTail, readFirstLine, zstdFrameEnd } from "../lib/jsonl.mjs";
import { READERS, matchSession } from "../lib/collector/readers/index.mjs";
import { LIMITS, STATUSES } from "../lib/protocol.mjs";

setFlagsFromString("--expose-gc"); // memory-retention checks need a full collection on demand
const gc = runInNewContext("gc");
const here = dirname(fileURLToPath(import.meta.url));
const FX = join(here, "fixtures", "readers");
const T0 = 1790848800000; // 2026-10-01T10:00:00Z, the fixtures' time origin

const scratchRoot = join(here, "..", ".scratch");
mkdirSync(scratchRoot, { recursive: true });
const tmp = mkdtempSync(join(scratchRoot, "readers-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
let counter = 0;
const tmpFile = (name = "t.jsonl") => { const dir = join(tmp, String(++counter)); mkdirSync(dir, { recursive: true }); return join(dir, name); };

const fixtureRows = rel => readFileSync(join(FX, rel), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));

/** Feed a fixture through its reader in one batch. DSH fixtures are stored as plain rows; `as` is the virtual transcript path. */
function load(kind, rel, { as, now } = {}) {
  const file = as ?? join(FX, rel);
  const reader = READERS[kind].createReader({ file, host: "h1", site: "mac", now });
  reader.feed(fixtureRows(rel));
  const events = new Map();
  for (const event of reader.takeEvents()) events.set(event.id, event);
  return { reader, record: reader.snapshot(), events };
}
const dshFile = id => join(FX, "dsh/sessions/--work-demo--", id, "session.v4.jsonl.zstd");
const loadDsh = id => load("dsh", `dsh/sessions/--work-demo--/${id}/rows.jsonl`, { as: dshFile(id) });

const OMP_DIR = "omp/sessions/-work-demo/2026-10-01T10-00-00-000Z_0aaaaaaa-1111-7000-8000-000000000001";
const OMP_ID = "0aaaaaaa-1111-7000-8000-000000000001";
const CLAUDE_DIR = "claude/projects/-work-demo/5c000000-0000-4000-8000-000000000001";
const CLAUDE_ID = "5c000000-0000-4000-8000-000000000001";
const CODEX_DIR = "codex/sessions/2026/10/01";
const CODEX_P = "0bbbbbbb-0000-7000-8000-000000000001";
const CODEX_C = "0bbbbbbb-0000-7000-8000-000000000002";
const DSH_MAIN = "session-d0000000-0000-4000-8000-000000000001";
const DSH_SUB = "d0000000-0000-4000-8000-000000000002";
const DSH_FORK = "session-d0000000-0000-4000-8000-000000000003";
const DSH_PROJ = "session-dsh-acp-0123456789abcdef0123456789abcdef";

// ---------------------------------------------------------------------------------------------------- jsonl tail

describe("createTail (jsonl)", () => {
  it("returns only appended complete lines and keeps a partial line for the next read", async () => {
    const file = tmpFile();
    writeFileSync(file, '{"n":1}\n{"n":2}\n{"n":');
    const tail = createTail(file);
    let r = await tail.read();
    assert.deepEqual(r.lines, [{ n: 1 }, { n: 2 }]);
    assert.equal(r.reset, false);
    appendFileSync(file, '3}\n{"n":4}\n');
    r = await tail.read();
    assert.deepEqual(r.lines, [{ n: 3 }, { n: 4 }], "the torn line is completed, nothing is re-read");
    r = await tail.read();
    assert.deepEqual(r.lines, []);
    appendFileSync(file, '{"n":5}\n');
    assert.deepEqual((await tail.read()).lines, [{ n: 5 }]);
  });

  it("reads only the new bytes (a second tail on a grown file does not re-parse old lines)", async () => {
    const file = tmpFile();
    writeFileSync(file, '{"n":1}\n');
    const tail = createTail(file);
    await tail.read();
    // corrupt the already-consumed bytes' continuity would be caught by the anchor; here: append and compare sizes
    appendFileSync(file, '{"n":2}\n');
    const r = await tail.read();
    assert.deepEqual(r.lines, [{ n: 2 }]);
  });

  it("restarts from byte 0 with reset:true when the file is replaced (new inode)", async () => {
    const file = tmpFile();
    writeFileSync(file, '{"gen":1,"n":1}\n{"gen":1,"n":2}\n');
    const tail = createTail(file);
    assert.equal((await tail.read()).lines.length, 2);
    renameSync(file, `${file}.old`);
    writeFileSync(file, '{"gen":2,"n":1}\n{"gen":2,"n":2}\n{"gen":2,"n":3}\n');
    const r = await tail.read();
    assert.equal(r.reset, true);
    assert.deepEqual(r.lines.map(l => l.gen), [2, 2, 2], "the whole new file is delivered");
    appendFileSync(file, '{"gen":2,"n":4}\n');
    const next = await tail.read();
    assert.equal(next.reset, false);
    assert.deepEqual(next.lines, [{ gen: 2, n: 4 }]);
  });

  it("restarts with reset:true when the file shrinks in place", async () => {
    const file = tmpFile();
    writeFileSync(file, '{"n":1}\n{"n":2}\n{"n":3}\n');
    const tail = createTail(file);
    await tail.read();
    truncateSync(file, 8);
    writeFileSync(file, '{"n":1}\n{"x":9}\n'); // same inode, rewritten shorter than what was consumed
    const r = await tail.read();
    assert.equal(r.reset, true);
    assert.deepEqual(r.lines, [{ n: 1 }, { x: 9 }]);
  });

  it("detects an in-place rewrite that keeps the length (bytes before the offset changed)", async () => {
    const file = tmpFile();
    writeFileSync(file, '{"v":"aaaa"}\n{"v":"bbbb"}\n');
    const tail = createTail(file);
    await tail.read();
    writeFileSync(file, '{"v":"zzzz"}\n{"v":"yyyy"}\n{"v":"cccc"}\n'); // same inode, longer, history differs
    const r = await tail.read();
    assert.equal(r.reset, true);
    assert.deepEqual(r.lines.map(l => l.v), ["zzzz", "yyyy", "cccc"]);
  });

  it("skips undecodable lines, counts them, and strips a BOM", async () => {
    const file = tmpFile();
    writeFileSync(file, '\ufeff{"n":1}\nnot json\n[1,2]\n"str"\n{"n":2}\n\n');
    const r = await createTail(file).read();
    assert.deepEqual(r.lines, [{ n: 1 }, { n: 2 }]);
    assert.equal(r.bad, 3);
  });

  it("reports a missing file without throwing and picks it up when it appears", async () => {
    const file = tmpFile();
    const tail = createTail(file);
    const r = await tail.read();
    assert.deepEqual([r.lines.length, r.missing, r.reset], [0, true, false]);
    writeFileSync(file, '{"n":1}\n');
    assert.deepEqual((await tail.read()).lines, [{ n: 1 }]);
  });

  it("pages large files (more:true) without losing or duplicating lines", async () => {
    const file = tmpFile();
    const total = 5000;
    writeFileSync(file, Array.from({ length: total }, (_, i) => JSON.stringify({ i, pad: "x".repeat(100) })).join("\n") + "\n");
    const tail = createTail(file);
    const seen = [];
    let calls = 0;
    for (;;) {
      const r = await tail.read({ maxBytes: 64 * 1024 });
      calls += 1;
      seen.push(...r.lines.map(l => l.i));
      if (!r.more) break;
    }
    assert.ok(calls > 3, "the window forced several reads");
    assert.deepEqual(seen, Array.from({ length: total }, (_, i) => i));
  });

  it("delivers a line larger than the read window", async () => {
    const file = tmpFile();
    const big = "y".repeat(300_000);
    writeFileSync(file, `{"big":"${big}"}\n{"n":2}\n`);
    const tail = createTail(file);
    const lines = [];
    for (;;) {
      const r = await tail.read({ maxBytes: 4096 });
      lines.push(...r.lines);
      if (!r.more) break;
    }
    assert.equal(lines.length, 2);
    assert.equal(lines[0].big.length, 300_000);
  });

  it("does not keep the rows it delivered alive (a collector holds one tail per transcript, mostly idle)", async () => {
    const file = tmpFile();
    writeFileSync(file, '{"n":1}\n{"n":2}\n');
    const tail = createTail(file);
    const ref = new WeakRef((await tail.read()).lines);
    for (let i = 0; i < 5 && ref.deref() !== undefined; i += 1) {
      await new Promise(resolve => setImmediate(resolve));
      gc();
    }
    assert.equal(ref.deref(), undefined, "the read chain must not retain the batch it delivered");
    assert.deepEqual((await tail.read()).lines, [], "the tail stays usable (and alive until here)");
  });
});

describe("readFirstLine", () => {
  it("returns the parsed first line, null for a missing file or non-JSON", async () => {
    const file = tmpFile();
    writeFileSync(file, '{"type":"title","title":"A","pad":"   "}\n{"type":"session"}\n');
    assert.deepEqual(await readFirstLine(file), { type: "title", title: "A", pad: "   " });
    writeFileSync(file, '{"type":"title","title":"B","pad":""}\n{"type":"session"}\n'); // OMP rewrites line 1 in place
    assert.equal((await readFirstLine(file)).title, "B");
    assert.equal(await readFirstLine(join(tmp, "nope.jsonl")), null);
    writeFileSync(file, "plain text\n");
    assert.equal(await readFirstLine(file), null);
  });
});

// ----------------------------------------------------------------------------------------------- zstd frame tail

/** One DSH-style file: frame 0 is the header row, each later frame one append batch. */
const frame = rows => zstdCompressSync(Buffer.from(rows.map(r => JSON.stringify(r)).join("\n") + "\n"));
const row = (seq, extra = {}) => ({ type: "tool/call", seq, time: T0 + seq, data: { callId: `c${seq}` }, ...extra });

describe("createTail (zstd frames)", () => {
  it("decodes only new complete frames and keeps a torn trailing frame for the next read", async () => {
    const file = tmpFile("session.v4.jsonl.zstd");
    const header = frame([{ type: "session", id: "s", version: 4 }]);
    const batch1 = frame([row(1), row(2)]);
    const batch2 = frame([row(3), row(4), row(5)]);
    writeFileSync(file, Buffer.concat([header, batch1, batch2.subarray(0, batch2.length - 7)])); // batch 2 is torn mid-frame
    const tail = createTail(file, { format: "zstd" });
    let r = await tail.read();
    assert.deepEqual(r.lines.map(l => l.seq ?? l.type), ["session", 1, 2], "the complete frames only");
    assert.equal(r.bad, 0);
    appendFileSync(file, batch2.subarray(batch2.length - 7));
    r = await tail.read();
    assert.deepEqual(r.lines.map(l => l.seq), [3, 4, 5], "the completed frame is decoded once");
    appendFileSync(file, frame([row(6)]));
    r = await tail.read();
    assert.deepEqual(r.lines.map(l => l.seq), [6]);
    assert.deepEqual((await tail.read()).lines, []);
  });

  it("copes with a frame header torn after the magic number", async () => {
    const file = tmpFile("session.v4.jsonl.zstd");
    const a = frame([row(1)]), b = frame([row(2)]);
    writeFileSync(file, Buffer.concat([a, b.subarray(0, 5)]));
    const tail = createTail(file, { format: "zstd" });
    assert.deepEqual((await tail.read()).lines.map(l => l.seq), [1]);
    appendFileSync(file, b.subarray(5));
    assert.deepEqual((await tail.read()).lines.map(l => l.seq), [2]);
  });

  it("restarts with reset:true on a new inode", async () => {
    const file = tmpFile("session.v4.jsonl.zstd");
    writeFileSync(file, Buffer.concat([frame([{ type: "session", gen: 1 }]), frame([row(1)])]));
    const tail = createTail(file, { format: "zstd" });
    assert.equal((await tail.read()).lines.length, 2);
    renameSync(file, `${file}.old`);
    writeFileSync(file, Buffer.concat([frame([{ type: "session", gen: 2 }]), frame([row(1), row(2)])]));
    const r = await tail.read();
    assert.equal(r.reset, true);
    assert.deepEqual(r.lines.map(l => l.gen ?? l.seq), [2, 1, 2]);
  });

  it("finds the end of frames with every descriptor variant (content size 0/1/2/4 bytes, checksum, raw / RLE / multi-block)", () => {
    // The real DSH files mix descriptors 0x04, 0x24, 0x64, 0x84 and 0xA4: checksum always on, content size from none to 8 bytes.
    const checksum = { [constants.ZSTD_c_checksumFlag]: 1 };
    const noSize = { [constants.ZSTD_c_contentSizeFlag]: 0 };
    const random = (n) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (i * 2654435761 >>> 7) & 0xff; return b; };
    const variants = [
      zstdCompressSync(Buffer.from("{}\n")),                                         // single segment, 1 byte content size
      zstdCompressSync(Buffer.alloc(300, 0x61), { params: checksum }),               // 2 byte content size + checksum
      zstdCompressSync(Buffer.alloc(70_000, 0x62), { params: checksum }),            // 4 byte content size + checksum, RLE-able
      zstdCompressSync(random(600_000), { params: checksum }),                       // several blocks
      zstdCompressSync(Buffer.from('{"a":1}\n{"a":2}\n'), { params: { ...checksum, ...noSize } }), // window descriptor, no content size
    ];
    const file = Buffer.concat(variants);
    let pos = 0;
    for (const f of variants) {
      assert.equal(zstdFrameEnd(file, pos), pos + f.length, `frame at ${pos} (${f.length} bytes, descriptor ${f[4].toString(16)})`);
      pos += f.length;
    }
    assert.deepEqual(new Set(variants.map(f => f[4] & 0xc0)).size > 1, true, "the variants really use different content size encodings");
    // never a false end: every proper prefix of a frame is incomplete
    for (const f of [variants[0], variants[1], variants[4]]) {
      for (let cut = 0; cut < f.length; cut++) assert.equal(zstdFrameEnd(f.subarray(0, cut), 0), -1, `prefix of ${cut}/${f.length} bytes`);
    }
    for (let cut = 0; cut < variants[3].length; cut += 997) assert.equal(zstdFrameEnd(variants[3].subarray(0, cut), 0), -1);
    assert.equal(zstdFrameEnd(Buffer.from("not a frame at all"), 0), -2, "garbage is not a frame");
  });

  it("skips skippable frames and resynchronises after garbage", async () => {
    const file = tmpFile("session.v4.jsonl.zstd");
    const skippable = Buffer.concat([Buffer.from([0x50, 0x2a, 0x4d, 0x18, 0x04, 0, 0, 0]), Buffer.from("junk")]);
    writeFileSync(file, Buffer.concat([frame([row(1)]), skippable, Buffer.from("GARBAGE!"), frame([row(2)])]));
    const r = await createTail(file, { format: "zstd" }).read();
    assert.deepEqual(r.lines.map(l => l.seq), [1, 2]);
    assert.ok(r.bad >= 1, "the garbage run is counted");
  });
});

// -------------------------------------------------------------------------------------------------------- match

describe("matchSession", () => {
  const cases = [
    // OMP: <sessions>/<slug>/<ts>_<uuid>.jsonl, flat <sessions>/<ts>_<uuid>.jsonl (container runs), subagents under <ts>_<uuid>/
    ["/h/.omp/agent/sessions/-w/2026-10-01T10-00-00-000Z_0aaaaaaa-1111-7000-8000-000000000001.jsonl", { kind: "omp", id: OMP_ID, role: "main" }],
    ["/data/task-telemetry/v4/argon/R1/work/sessions/2026-10-01T10-00-00-000Z_0aaaaaaa-1111-7000-8000-000000000001.jsonl", { kind: "omp", id: OMP_ID, role: "main" }],
    ["/s/-w/2026-10-01T10-00-00-000Z_0aaaaaaa-1111-7000-8000-000000000001/KitBuilder.jsonl", { kind: "omp", id: `${OMP_ID}/KitBuilder`, role: "subagent", parentFile: "/s/-w/2026-10-01T10-00-00-000Z_0aaaaaaa-1111-7000-8000-000000000001.jsonl" }],
    ["/s/2026-10-01T10-00-00-000Z_0aaaaaaa-1111-7000-8000-000000000001/KitBuilder.jsonl", { kind: "omp", id: `${OMP_ID}/KitBuilder`, role: "subagent", parentFile: "/s/2026-10-01T10-00-00-000Z_0aaaaaaa-1111-7000-8000-000000000001.jsonl" }],
    ["/s/-w/2026-10-01T10-00-00-000Z_0aaaaaaa-1111-7000-8000-000000000001/KitBuilder/KitBuilder.ToolCatSmith.jsonl", { kind: "omp", id: `${OMP_ID}/KitBuilder.ToolCatSmith`, role: "subagent", parentFile: "/s/-w/2026-10-01T10-00-00-000Z_0aaaaaaa-1111-7000-8000-000000000001/KitBuilder.jsonl" }],
    // Claude
    ["/h/.claude/projects/-w/5c000000-0000-4000-8000-000000000001.jsonl", { kind: "claude", id: CLAUDE_ID, role: "main" }],
    ["/h/.claude/projects/-w/5c000000-0000-4000-8000-000000000001/subagents/agent-a1b2c3.jsonl", { kind: "claude", id: `${CLAUDE_ID}/a1b2c3`, role: "subagent", parentFile: "/h/.claude/projects/-w/5c000000-0000-4000-8000-000000000001.jsonl" }],
    // Codex
    ["/h/.codex/sessions/2026/10/01/rollout-2026-10-01T10-00-00-0bbbbbbb-0000-7000-8000-000000000001.jsonl", { kind: "codex", id: CODEX_P, role: "main" }],
    ["/h/.codex/archived_sessions/rollout-2026-10-01T10-00-00-0bbbbbbb-0000-7000-8000-000000000001.jsonl", { kind: "codex", id: CODEX_P, role: "main" }],
    // DSH under ~/.dsh and under a container run's harness-home (bare uuid dir, slug --work--)
    ["/h/.dsh/sessions/--Users-x--/session-d0000000-0000-4000-8000-000000000001/session.v4.jsonl.zstd", { kind: "dsh", id: DSH_MAIN, role: "main" }],
    ["/data/task-telemetry/v4/runs/R1/work/harness-home/sessions/--work--/d0000000-0000-4000-8000-000000000002/session.v4.jsonl.zstd", { kind: "dsh", id: DSH_SUB, role: "main" }],
    ["/h/.dsh/sessions/--x--/session-dsh-acp-0123456789abcdef0123456789abcdef/session.v4.jsonl.zstd", { kind: "dsh", id: DSH_PROJ, role: "projection" }],
    ["/h/.dsh/sessions/--x--/session-d0000000-0000-4000-8000-000000000001/session.jsonl.zstd", { kind: "dsh", id: DSH_MAIN, role: "main" }],
  ];
  for (const [path, expected] of cases) {
    it(`${expected.kind} ${expected.role}: …${path.slice(-52)}`, () => assert.deepEqual(matchSession(path), expected));
  }

  it("ignores logs, lock files, markdown, tombstones, artifacts, memory notes and meta files", () => {
    for (const path of [
      "/s/-w/2026-10-01T10-00-00-000Z_0aaaaaaa-1111-7000-8000-000000000001/1.bash.log",
      "/s/-w/.2026-10-01T10-00-00-000Z_0aaaaaaa-1111-7000-8000-000000000001.jsonl.lock.os",
      "/s/-w/2026-10-01T10-00-00-000Z_0aaaaaaa-1111-7000-8000-000000000001/.Kit.jsonl.lock.os",
      "/s/-w/2026-10-01T10-00-00-000Z_0aaaaaaa-1111-7000-8000-000000000001/Kit.md",
      "/s/-w/2026-10-01T10-00-00-000Z_0aaaaaaa-1111-7000-8000-000000000001/Kit.jsonl.tombstone",
      "/s/-w/2026-10-01T10-00-00-000Z_0aaaaaaa-1111-7000-8000-000000000001/local/events.jsonl", // not named after its directory
      "/h/.claude/projects/-w/memory/MEMORY.md",
      "/h/.claude/projects/-w/5c000000-0000-4000-8000-000000000001/subagents/agent-a1.meta.json",
      "/h/.dsh/sessions/--x--/session-d0000000-0000-4000-8000-000000000001/session.lock",
      "/h/.codex/sessions/2026/10/01/notes.jsonl",
      "/h/.codex/config.toml",
    ]) assert.equal(matchSession(path), null, path);
  });

  it("a legacy session.jsonl.zstd next to a session.v4.jsonl.zstd is the same session: only v4 matches", () => {
    const dir = join(tmp, "legacy", "--x--", "session-d0000000-0000-4000-8000-000000000009");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.jsonl.zstd"), "");
    assert.equal(matchSession(join(dir, "session.jsonl.zstd"))?.id, "session-d0000000-0000-4000-8000-000000000009");
    writeFileSync(join(dir, "session.v4.jsonl.zstd"), "");
    assert.equal(matchSession(join(dir, "session.jsonl.zstd")), null);
    assert.equal(matchSession(join(dir, "session.v4.jsonl.zstd"))?.id, "session-d0000000-0000-4000-8000-000000000009");
  });
});

// ---------------------------------------------------------------------------------------------------------- OMP

describe("omp reader", () => {
  it("main session: record fields, usage totals, tool upgrade pending→ok/error, exit code, session_exit", () => {
    const { record, events } = load("omp", `${OMP_DIR}.jsonl`);
    assert.equal(record.key, `h1#omp:${OMP_ID}`);
    assert.deepEqual([record.role, record.title, record.cwd, record.provider, record.model, record.effort], ["main", "Fixture run", "/work/demo", "acme", "model-a", "high"]);
    assert.equal(record.startedAt, T0);
    assert.equal(record.updatedAt, T0 + 20000);
    assert.deepEqual(record.usage, { input: 30, output: 60, cacheRead: 900, cacheWrite: 120, reasoning: 0, cost: 1.5, contextTokens: 350 });
    assert.deepEqual(record.counts, { turns: 1, tools: 3, errors: 1, subagents: 2, events: 9 });
    assert.equal(record.status, "done");
    assert.equal(record.live.state, "ended");
    assert.equal(record.endedAt, T0 + 20000);
    assert.equal(record.live.alive, null);

    const read = events.get("c1");
    assert.deepEqual([read.type, read.status, read.category, read.duration], ["tool", "ok", "read", 50]);
    assert.ok(read.targets.some(t => t.type === "file" && t.path.endsWith("README.md")), "targets come from lib/targets.mjs");
    const bash = events.get("c3");
    assert.deepEqual([bash.status, bash.exitCode, bash.category, bash.preview], ["error", 1, "shell", "npm test"]);

    const model = events.get("model:1");
    assert.deepEqual([model.model, model.ttft, model.duration, model.usage], ["model-a", 800, 2900, { input: 10, output: 20, cacheRead: 300, cacheWrite: 40 }]);
    assert.equal(model.t, T0 + 1100, "model events start at the message's own timestamp, not the row time");
    assert.equal(events.get("user:1").text, "Read the README, then spawn two helpers");
  });

  it("task spawns: one spawn event per task with the child record id, in call order", () => {
    const { events, reader } = load("omp", `${OMP_DIR}.jsonl`);
    const a = events.get("c2"), b = events.get("c2#1");
    assert.deepEqual([a.type, a.status, a.child], ["spawn", "ok", { kind: "omp", name: "Scout", id: `${OMP_ID}/Scout` }]);
    assert.deepEqual([b.type, b.child.name, b.child.id], ["spawn", "Probe", `${OMP_ID}/Probe`]);
    assert.deepEqual(reader.children(), [`${OMP_ID}/Scout`, `${OMP_ID}/Probe`]);
  });

  it("inter-agent messages: irc:incoming becomes a message event", () => {
    const { events } = load("omp", `${OMP_DIR}.jsonl`);
    const m = events.get("message:1");
    assert.deepEqual([m.type, m.peer, m.text], ["message", "Scout", "found the entry point"]);
  });

  it("subagent: id, name, parent from the path (header parentSession is absolute path, id, or missing)", () => {
    const scout = load("omp", `${OMP_DIR}/Scout.jsonl`).record;
    assert.equal(scout.id, `${OMP_ID}/Scout`);
    assert.deepEqual([scout.role, scout.name, scout.status], ["subagent", "Scout", "done"]);
    assert.deepEqual([scout.parent.kind, scout.parent.id, scout.parent.via, scout.parent.exact], ["omp", OMP_ID, "file", true]);
    assert.ok(scout.parent.file.endsWith(`${OMP_ID}.jsonl`));
    assert.equal(scout.title, "Scout the repo and delegate one probe", "a subagent without a title row uses its first prompt");

    const probe = load("omp", `${OMP_DIR}/Probe.jsonl`).record;
    assert.equal(probe.parent.id, OMP_ID, "no parentSession in the header: the path decides");

    const deep = load("omp", `${OMP_DIR}/Scout/Scout.Deep.jsonl`).record;
    assert.equal(deep.id, `${OMP_ID}/Scout.Deep`);
    assert.equal(deep.parent.id, `${OMP_ID}/Scout`, "a nested subagent belongs to the subagent whose directory it sits in");
    assert.ok(deep.parent.file.endsWith("Scout.jsonl"));
  });

  it("the DSH ACP adapter's model-catalogue probe is role `probe`, not a user session", () => {
    const { record, events } = load("omp", "omp/sessions/-tmp-dsh-acp-probe-Ab12Cd/2026-10-01T10-00-50-000Z_0aaaaaaa-1111-7000-8000-000000000006.jsonl");
    assert.deepEqual([record.id, record.role, record.cwd], ["0aaaaaaa-1111-7000-8000-000000000006", "probe", "/tmp/dsh-acp-probe-Ab12Cd"]);
    assert.equal(record.parent, null, "a probe has no parent: the adapter is not an agent");
    assert.equal(events.size, 0);
  });

  it("an ask tool that is still pending puts the agent in `waiting`, with the question as `doing`", () => {
    const { record, events } = load("omp", `${OMP_DIR}/Probe.jsonl`);
    assert.equal(events.get("p1").status, "pending");
    assert.deepEqual([record.status, record.live.state, record.live.turnOpen], ["waiting", "waiting", true]);
    assert.match(record.live.doing, /waiting/);
    assert.equal(record.endedAt, null);
  });

  it("a fork replays no copied history: no events, no usage, own start time", () => {
    const { record, events } = load("omp", "omp/sessions/-work-demo/2026-10-01T12-00-00-000Z_0aaaaaaa-5555-7000-8000-000000000005.jsonl");
    assert.equal(record.role, "fork");
    assert.deepEqual([record.parent.kind, record.parent.id], ["omp", OMP_ID]);
    assert.deepEqual([...events.keys()], ["user:1"]);
    assert.equal(events.get("user:1").text, "A new question in the fork");
    assert.equal(record.usage.input + record.usage.output, 0);
    assert.equal(record.startedAt, T0 + 7200000);
    assert.equal(record.title, "Forked run", "a title_change copied from the parent's history must not rename the fork");
    assert.equal(record.status, "running");
  });

  it("title rows: a re-fed title updates the title without creating events; event ids are position-stable on re-feed", () => {
    const file = join(FX, `${OMP_DIR}.jsonl`);
    const rows = fixtureRows(`${OMP_DIR}.jsonl`);
    const reader = READERS.omp.createReader({ file, host: "h1", site: "mac" });
    reader.feed(rows);
    const first = reader.takeEvents();
    reader.feed([{ ...rows[0], title: "Renamed", pad: "" }]);
    assert.equal(reader.snapshot().title, "Renamed");
    assert.deepEqual(reader.takeEvents(), [], "a title update is not an event");
    const again = READERS.omp.createReader({ file, host: "h1", site: "mac" });
    again.feed(rows);
    assert.deepEqual(again.takeEvents().map(e => e.id), first.map(e => e.id), "a reader rebuilt after a reset produces the same ids");
  });

  it("an incremental feed (pending first, result later) upserts the same event id", async () => {
    const file = tmpFile("2026-10-01T10-00-00-000Z_0aaaaaaa-1111-7000-8000-0000000000aa.jsonl");
    const rows = fixtureRows(`${OMP_DIR}.jsonl`);
    const upto = rows.findIndex(r => r.message?.role === "toolResult" && r.message.toolCallId === "c3"); // bash result
    writeFileSync(file, rows.slice(0, upto).map(r => JSON.stringify(r)).join("\n") + "\n");
    const tail = createTail(file), reader = READERS.omp.createReader({ file, host: "h1", site: "mac" });
    reader.feed((await tail.read()).lines);
    const early = reader.takeEvents();
    assert.equal(early.find(e => e.id === "c3").status, "pending");
    assert.equal(early.find(e => e.id === "c3").duration, undefined);
    assert.equal(reader.snapshot().live.state, "tool");
    assert.match(reader.snapshot().live.doing, /^bash/);

    appendFileSync(file, rows.slice(upto).map(r => JSON.stringify(r)).join("\n") + "\n");
    reader.feed((await tail.read()).lines);
    const late = reader.takeEvents();
    const c3 = late.find(e => e.id === "c3");
    assert.deepEqual([c3.status, c3.exitCode, c3.duration], ["error", 1, 3000]);
    assert.ok(late.every(e => e.id !== "c1"), "events that did not change are not re-sent");
  });
});

// --------------------------------------------------------------------------------------------------------- Claude

describe("claude reader", () => {
  it("main session: one model event per response (rows of one message id merge), usage once, user prompts, cost", () => {
    const { record, events } = load("claude", `${CLAUDE_DIR}.jsonl`);
    assert.equal(record.key, `h1#claude:${CLAUDE_ID}`);
    assert.deepEqual([record.role, record.title, record.model, record.version, record.cwd], ["main", "Fixture claude run", "claude-sonnet-x", "2.1.296", "/work/demo"]);
    assert.deepEqual(record.usage, { input: 8, output: 180, cacheRead: 2500, cacheWrite: 300, reasoning: 40, cost: 1.25, contextTokens: 1603 });
    assert.deepEqual(record.counts, { turns: 1, tools: 1, errors: 1, subagents: 1, events: 5 });
    assert.equal(record.status, "done");
    const models = [...events.values()].filter(e => e.type === "model");
    assert.equal(models.length, 2, "thinking/text/tool_use rows of msg_1 are one response");
    assert.deepEqual(models[0].usage, { input: 5, output: 120, cacheRead: 1000, cacheWrite: 200, reasoning: 40 });
    assert.deepEqual([...events.values()].filter(e => e.type === "user").map(e => e.text), ["Summarize the repo and ask a helper to read input.txt"], "meta/system-reminder rows are not prompts");
    assert.equal(events.get("error:1").text, "503 overloaded (retry 2/10)");
  });

  it("Agent tool call → spawn event with the child's record id from toolUseResult.agentId", () => {
    const { events, reader } = load("claude", `${CLAUDE_DIR}.jsonl`);
    const spawn = events.get("tu_agent1");
    assert.deepEqual([spawn.type, spawn.status, spawn.name, spawn.category], ["spawn", "ok", "Agent", "spawn"]);
    assert.deepEqual(spawn.child, { kind: "claude", name: "Read input.txt", id: `${CLAUDE_ID}/a1` });
    assert.equal(spawn.duration, 16700);
    assert.deepEqual(reader.children(), [`${CLAUDE_ID}/a1`]);
  });

  it("subagent: meta toolUseId becomes parent.toolCallId; flat nested subagents use parentAgentId; old meta has no toolUseId", () => {
    const a1 = load("claude", `${CLAUDE_DIR}/subagents/agent-a1.jsonl`).record;
    assert.deepEqual([a1.id, a1.role, a1.name, a1.description, a1.title], [`${CLAUDE_ID}/a1`, "subagent", "general-purpose", "Read input.txt", "Read input.txt"]);
    assert.deepEqual([a1.parent.id, a1.parent.toolCallId, a1.parent.via, a1.parent.exact], [CLAUDE_ID, "tu_agent1", "file", true]);

    const a2 = load("claude", `${CLAUDE_DIR}/subagents/agent-a2.jsonl`).record;
    assert.equal(a2.parent.id, `${CLAUDE_ID}/a1`, "parentAgentId parents a nested subagent to the other subagent");
    assert.ok(a2.parent.file.endsWith("agent-a1.jsonl"));
    assert.equal(a2.parent.toolCallId, "tu_nested");

    const old = load("claude", `${CLAUDE_DIR}/subagents/agent-old.jsonl`).record;
    assert.equal(old.parent.id, CLAUDE_ID);
    assert.equal(old.parent.toolCallId, undefined, "Claude Code 2.1.121 wrote no toolUseId; the parent's Agent result names the child instead");
  });

  it("a subagent whose last row has no stop_reason is running until the quiet period passes, then done", () => {
    const end = T0 + 19000;
    const soon = load("claude", `${CLAUDE_DIR}/subagents/agent-a1.jsonl`, { now: () => end + 5000 });
    assert.deepEqual([soon.record.status, soon.record.live.state, soon.record.endedAt], ["running", "model", null]);
    assert.equal(soon.reader.settleAt(), end + 15000, "tells the collector when the snapshot will change on its own");

    const later = load("claude", `${CLAUDE_DIR}/subagents/agent-a1.jsonl`, { now: () => end + 15000 });
    assert.deepEqual([later.record.status, later.record.live.state, later.record.endedAt], ["done", "idle", end]);
    assert.equal(later.reader.settleAt(), null);
  });

  it("a pending Bash tool in a subagent keeps it running regardless of the clock", () => {
    const { record, events } = load("claude", `${CLAUDE_DIR}/subagents/agent-a2.jsonl`, { now: () => T0 + 99_000_000 });
    assert.equal(events.get("tu_n1").status, "pending");
    assert.deepEqual([record.status, record.live.state, record.live.doing], ["running", "tool", "Bash ls"]);
  });

  it("a fork skips rows copied from the parent (forkedFrom) and links to the parent session", () => {
    const { record, events } = load("claude", "claude/projects/-work-demo/5c000000-0000-4000-8000-000000000002.jsonl");
    assert.equal(record.role, "fork");
    assert.deepEqual([record.parent.kind, record.parent.id], ["claude", CLAUDE_ID]);
    assert.deepEqual([...events.values()].map(e => e.text).filter(Boolean), ["Fresh question in the fork", "Fresh answer"]);
    assert.equal(record.usage.input, 2, "copied usage (9) is not counted");
    assert.equal(record.startedAt, T0 + 3600000);
  });
});

// --------------------------------------------------------------------------------------------------------- Codex

describe("codex reader", () => {
  const parent = () => load("codex", `${CODEX_DIR}/rollout-2026-10-01T10-00-00-${CODEX_P}.jsonl`);
  const child = () => load("codex", `${CODEX_DIR}/rollout-2026-10-01T10-00-06-${CODEX_C}.jsonl`);

  it("main session: record fields, per-response usage from cumulative token_count, one prompt despite two echoes", () => {
    const { record, events } = parent();
    assert.deepEqual([record.id, record.role, record.model, record.effort, record.provider, record.version], [CODEX_P, "main", "gpt-x", "high", "acme", "0.164.0"]);
    assert.deepEqual(record.usage, { input: 900, output: 200, cacheRead: 2300, cacheWrite: 200, reasoning: 40, contextTokens: 2400, contextWindow: 258400 });
    assert.deepEqual([...events.values()].filter(e => e.type === "user").map(e => e.text), ["Run the tests and ask a helper to review"], "environment context is not a prompt; the item_completed echo is not a second prompt");
    const models = [...events.values()].filter(e => e.type === "model");
    assert.deepEqual(models.map(m => m.usage), [
      { input: 500, output: 50, cacheRead: 400, cacheWrite: 100, reasoning: 10 },
      { input: 400, output: 150, cacheRead: 1900, cacheWrite: 100, reasoning: 30 },
    ], "input excludes cached and cache-write tokens, growth per token_count");
    assert.equal(models[1].text, "Tests fail; reviewer started");
    assert.equal(record.status, "done");
    assert.equal(record.title, "Run the tests and ask a helper to review");
  });

  it("exec_command: Process exited with code N → exitCode and error status; spawn_agent links the child thread id", () => {
    const { events, reader } = parent();
    const exec = events.get("call_exec1");
    assert.deepEqual([exec.status, exec.exitCode, exec.category, exec.duration], ["error", 1, "shell", 3000]);
    const spawn = events.get("call_spawn1");
    assert.deepEqual([spawn.type, spawn.status, spawn.child], ["spawn", "ok", { kind: "codex", name: "reviewer", id: CODEX_C }]);
    assert.deepEqual(reader.children(), [CODEX_C]);
    const msg = events.get("call_msg1");
    assert.deepEqual([msg.type, msg.peer, msg.text], ["message", "reviewer", "also check the lockfile"]);
  });

  it("a one-line adapter probe rollout is role `probe`; an adapter run in a workspace stays `main`", () => {
    const probe = load("codex", `${CODEX_DIR}/rollout-2026-10-01T10-00-30-0bbbbbbb-0000-7000-8000-000000000003.jsonl`);
    assert.deepEqual([probe.record.role, probe.record.cwd, probe.record.parent], ["probe", "/tmp/dsh-acp-probe-Ab12Cd", null]);
    assert.equal(probe.events.size, 0);

    const real = load("codex", `${CODEX_DIR}/rollout-2026-10-01T10-00-40-0bbbbbbb-0000-7000-8000-000000000004.jsonl`);
    assert.equal(real.record.role, "main", "the adapter stamps the same originator on its real sessions: only the probe cwd decides");
    assert.equal(real.record.cwd, "/work/demo");
    assert.deepEqual([real.events.get("call_acp1").status, real.events.get("call_acp1").category], ["ok", "shell"]);
  });

  it("child rollout: first session_meta is its own; the parent's meta and history copy are ignored", () => {
    const { record, events } = child();
    assert.deepEqual([record.id, record.role, record.name], [CODEX_C, "subagent", "reviewer"]);
    assert.deepEqual([record.parent.kind, record.parent.id, record.parent.via, record.parent.exact], ["codex", CODEX_P, "file", true]);
    assert.equal(record.description, "Banach · /root/reviewer");
    assert.equal(record.startedAt, T0 + 5500);
    assert.ok(!events.has("call_hist1"), "the copied tool call is history, not this thread's work");
    assert.deepEqual(record.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, contextWindow: 258400 }, "the copied token_count (900000 tokens) is not counted");
    assert.equal(record.effort, "medium", "turn_context after the copy applies");
  });

  it("child rollout: agent_message to this thread is an incoming message, one addressed elsewhere is ignored; a task_complete error ends the turn in error", () => {
    const { record, events } = child();
    const messages = [...events.values()].filter(e => e.type === "message");
    assert.deepEqual(messages.map(m => [m.peer, m.text]), [["/root", "review the failure"]]);
    assert.equal(events.get("call_c1").exitCode, 0);
    assert.deepEqual([record.status, record.live.state, record.counts.errors], ["error", "idle", 1]);
    assert.equal(events.get("error:1").text, "response_too_many_failed_attempts");
    assert.equal(record.title, "review the failure", "a child without a prompt takes its first incoming message as title");
  });
});

// ----------------------------------------------------------------------------------------------------------- DSH

describe("dsh reader", () => {
  it("main session: turn/step/tool rows → events; model event spans the step; ttft from stream time0; usage; context window", () => {
    const { record, events } = loadDsh(DSH_MAIN);
    assert.equal(record.id, DSH_MAIN);
    assert.deepEqual([record.role, record.title, record.model, record.provider, record.cwd], ["main", "List files and delegate a check", "ds-flash", "deepseek", "/work/demo"]);
    assert.deepEqual(record.usage, { input: 100, output: 40, cacheRead: 900, cacheWrite: 0, reasoning: 5, contextTokens: 1000, contextWindow: 1000000 });
    const model = events.get("model:1");
    assert.deepEqual([model.t, model.duration, model.ttft, model.model], [T0 + 120, 2880, 1380, "ds-flash"]);
    assert.equal(record.counts.turns, 2);
  });

  it("tool/call + tool/result: pending→ok; a non-zero exit code printed in the result marks it an error", () => {
    const { events } = loadDsh(DSH_MAIN);
    const bash = events.get("call_bash1");
    assert.deepEqual([bash.status, bash.exitCode, bash.category, bash.duration, bash.preview], ["error", 2, "shell", 500, "ls -la"]);
  });

  it("an unanswered ask tool means waiting for the user; the open turn keeps the status running→waiting", () => {
    const { record, events } = loadDsh(DSH_MAIN);
    assert.equal(events.get("call_ask1").status, "pending");
    assert.deepEqual([record.status, record.live.state, record.live.turnOpen, record.endedAt], ["waiting", "waiting", true, null]);
  });

  it("subagent tool call + subagent/catalog row: the spawn event gets the child id; unmatched catalog rows become standalone spawns", () => {
    const { events, reader } = loadDsh(DSH_MAIN);
    const spawn = events.get("call_sub1");
    assert.deepEqual([spawn.type, spawn.status, spawn.child], ["spawn", "ok", { kind: "dsh", name: "Check the lockfile", id: DSH_SUB }]);
    const standalone = events.get("spawn:d0000000-0000-4000-8000-0000000000aa");
    assert.deepEqual([standalone.type, standalone.child.name], ["spawn", "Teammate spawned elsewhere"]);
    assert.deepEqual(reader.children(), [DSH_SUB, "d0000000-0000-4000-8000-0000000000aa"]);
  });

  it("subagent session: header parentSession + origin:subagent; the turn that ended in error is status error", () => {
    const { record, events } = loadDsh(DSH_SUB);
    assert.deepEqual([record.role, record.name, record.effort, record.status], ["subagent", "Check the lockfile", "max", "error"]);
    assert.deepEqual([record.parent.kind, record.parent.id, record.parent.via, record.parent.exact], ["dsh", DSH_MAIN, "file", true]);
    assert.equal(record.parent.toolCallId, undefined);
    assert.equal(events.get("error:1").text, "upstream stream failed");
  });

  it("seeded fork: rows before session/end-seed are copied history (no events/usage), fresh rows count", () => {
    const { record, events } = loadDsh(DSH_FORK);
    assert.equal(record.role, "fork");
    assert.equal(record.parent.id, DSH_MAIN);
    assert.deepEqual([...events.values()].map(e => [e.type, e.text]), [["user", "fresh question after the fork"]]);
    assert.equal(record.usage.input, 0);
    assert.equal(record.counts.tools, 0);
    assert.equal(record.status, "running");
  });

  it("session-dsh-acp-* is a projection of an ACP agent's subagent", () => {
    const { record } = loadDsh(DSH_PROJ);
    assert.deepEqual([record.role, record.name, record.parent.id, record.status], ["projection", "Mirror of an ACP subagent", DSH_MAIN, "done"]);
  });

  it("a catalog row names the spawn call by its label even when the call's result carries no id; a label mismatch falls back to the only open call", () => {
    const file = dshFile("session-d0000000-0000-4000-8000-0000000000bb");
    const reader = READERS.dsh.createReader({ file, host: "h1", site: "mac" });
    const call = (seq, callId, description) => ({ type: "tool/call", seq, time: T0 + seq * 10, data: { turn: 1, step: 1, callId, name: "subagent", arguments: JSON.stringify({ description, prompt: "p" }) } });
    const catalog = (seq, childId, label) => ({ type: "subagent/catalog", seq, time: T0 + seq * 10, data: { childId, mode: "continuable", label } });
    const result = (seq, callId) => ({ type: "tool/result", seq, time: T0 + seq * 10, data: { turn: 1, step: 1, message: { toolCallId: callId, content: [{ type: "text", text: "queued" }], isError: false } } });
    reader.feed([
      { type: "session", version: 4, id: "session-d0000000-0000-4000-8000-0000000000bb", createdAt: T0, cwd: "/w" },
      { type: "turn/start", seq: 1, time: T0 + 10, data: { turn: 1 } },
      call(2, "cA", "Alpha job"), call(3, "cB", "Beta job"),
      catalog(4, "d0000000-0000-4000-8000-00000000000b", "Beta job"),   // arrives first although B was called second
      catalog(5, "d0000000-0000-4000-8000-00000000000a", "Alpha job"),
      result(6, "cA"), result(7, "cB"),
    ]);
    const events = new Map(reader.takeEvents().map(e => [e.id, e]));
    assert.equal(events.get("cA").child.id, "d0000000-0000-4000-8000-00000000000a");
    assert.equal(events.get("cB").child.id, "d0000000-0000-4000-8000-00000000000b");
  });
});

// ------------------------------------------------------------------- DSH end to end: zstd frames through the tail

describe("dsh transcript through createTail + reader (real zstd frames)", () => {
  it("appends arrive as new frames; a torn frame is held back; the tool upgrades from pending to ok across reads", async () => {
    const rows = fixtureRows(`dsh/sessions/--work-demo--/${DSH_MAIN}/rows.jsonl`);
    const iCall = rows.findIndex(r => r.type === "tool/call" && r.data.callId === "call_bash1");
    const dir = join(tmp, "dsh-live", "--work-demo--", DSH_MAIN);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "session.v4.jsonl.zstd");
    const header = frame([rows[0]]);
    const batchA = frame(rows.slice(1, iCall + 1));          // …up to and including the bash tool/call
    const batchB = frame(rows.slice(iCall + 1, iCall + 4));  // its tool/result and the subagent call
    writeFileSync(file, Buffer.concat([header, batchA, batchB.subarray(0, 20)]));

    const match = matchSession(file);
    assert.deepEqual([match.kind, match.id], ["dsh", DSH_MAIN]);
    const tail = createTail(file, { format: "zstd" });
    const reader = READERS.dsh.createReader({ file, host: "h1", site: "mac" });

    reader.feed((await tail.read()).lines);
    const first = new Map(reader.takeEvents().map(e => [e.id, e]));
    assert.equal(first.get("call_bash1").status, "pending");
    assert.equal(reader.snapshot().live.state, "tool");
    assert.equal(reader.snapshot().live.doing, "bash ls -la");

    appendFileSync(file, batchB.subarray(20));
    appendFileSync(file, frame(rows.slice(iCall + 4)));
    const second = await tail.read();
    assert.equal(second.reset, false);
    reader.feed(second.lines);
    const changed = new Map(reader.takeEvents().map(e => [e.id, e]));
    assert.deepEqual([changed.get("call_bash1").status, changed.get("call_bash1").exitCode], ["error", 2], "same id, upgraded");
    assert.equal(changed.get("call_sub1").child.id, DSH_SUB);
    assert.equal(reader.snapshot().status, "waiting");
  });

  it("a replaced transcript (reset) rebuilt from byte 0 yields the same event ids as the first pass", async () => {
    const rows = fixtureRows(`dsh/sessions/--work-demo--/${DSH_MAIN}/rows.jsonl`);
    const dir = join(tmp, "dsh-reset", "--work-demo--", DSH_MAIN);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "session.v4.jsonl.zstd");
    const write = () => writeFileSync(file, Buffer.concat([frame([rows[0]]), frame(rows.slice(1, 10)), frame(rows.slice(10))]));
    write();
    const tail = createTail(file, { format: "zstd" });
    const r1 = READERS.dsh.createReader({ file, host: "h1", site: "mac" });
    r1.feed((await tail.read()).lines);
    const ids1 = r1.takeEvents().map(e => e.id);

    renameSync(file, `${file}.bak`);
    write();
    const again = await tail.read();
    assert.equal(again.reset, true);
    const r2 = READERS.dsh.createReader({ file, host: "h1", site: "mac" });
    r2.feed(again.lines);
    assert.deepEqual(r2.takeEvents().map(e => e.id), ids1);
  });
});

// --------------------------------------------------------------------------------------- cross-cutting guarantees

describe("turn status", () => {
  const stamp = ms => new Date(T0 + ms).toISOString();
  const ompUser = (ms, text) => ({ type: "message", id: `u${ms}`, timestamp: stamp(ms), message: { role: "user", content: [{ type: "text", text }], timestamp: T0 + ms } });
  const ompAssistant = (ms, content, stopReason, extra = {}) => ({ type: "message", id: `a${ms}`, timestamp: stamp(ms), message: { role: "assistant", content, stopReason, timestamp: T0 + ms - 500, usage: { input: 1, output: 1 }, ...extra } });
  const ompReader = () => {
    const reader = READERS.omp.createReader({ file: join(FX, `${OMP_DIR}.jsonl`), host: "h1", site: "mac" });
    reader.feed([{ type: "session", version: 3, id: OMP_ID, timestamp: stamp(0), cwd: "/w" }]);
    return reader;
  };

  it("omp: an aborted response is `interrupted`; the next prompt starts a new turn and abandons the tool the abort left open", () => {
    const reader = ompReader();
    reader.feed([
      ompUser(100, "first"),
      ompAssistant(1000, [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "sleep 100" } }], "toolUse"),
    ]);
    assert.equal(reader.snapshot().status, "running");
    reader.feed([ompAssistant(5000, [], "aborted", { errorMessage: "Request was aborted" })]);
    let record = reader.snapshot();
    assert.deepEqual([record.status, record.live.state, record.live.turnOpen], ["interrupted", "idle", false]);
    assert.equal(reader.takeEvents().find(e => e.id === "t1").status, "unknown", "no result will ever arrive for it");
    reader.feed([ompUser(9000, "second")]);
    record = reader.snapshot();
    assert.deepEqual([record.status, record.counts.turns], ["running", 2]);
  });

  it("omp: a response that failed and was auto-retried does not end the turn; an unrecovered error does", () => {
    const reader = ompReader();
    reader.feed([ompUser(100, "go"), ompAssistant(1000, [], "error", { errorMessage: "socket closed", retryRecovery: { status: "recovered" } })]);
    assert.equal(reader.snapshot().status, "running");
    assert.equal(reader.snapshot().counts.errors, 1);
    reader.feed([ompAssistant(3000, [], "error", { errorMessage: "quota exceeded" })]);
    assert.deepEqual([reader.snapshot().status, reader.snapshot().live.state], ["error", "idle"]);
  });

  it("omp: a message injected while idle (async job result) wakes the agent without counting as a user prompt", () => {
    const reader = ompReader();
    reader.feed([ompUser(100, "go"), ompAssistant(1000, [{ type: "text", text: "waiting for the job" }], "stop")]);
    assert.equal(reader.snapshot().status, "done");
    reader.feed([{ type: "custom_message", customType: "async-result", content: "job finished", display: true, attribution: "agent", id: "cm", timestamp: stamp(8000) }]);
    const record = reader.snapshot();
    assert.deepEqual([record.status, record.live.state, record.counts.turns], ["running", "model", 2]);
    assert.equal(reader.takeEvents().filter(e => e.type === "user").length, 1);
  });

  it("claude: '[Request interrupted by user]' ends the turn as interrupted", () => {
    const reader = READERS.claude.createReader({ file: join(FX, `${CLAUDE_DIR}.jsonl`), host: "h1", site: "mac" });
    const base = ms => ({ isSidechain: false, timestamp: stamp(ms), sessionId: CLAUDE_ID, cwd: "/w", version: "2.1.296" });
    reader.feed([
      { ...base(100), type: "user", uuid: "u1", message: { role: "user", content: [{ type: "text", text: "do it" }] } },
      { ...base(1000), type: "assistant", uuid: "a1", message: { id: "m1", role: "assistant", model: "m", stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", id: "tb", name: "Bash", input: { command: "sleep 99" } }] } },
    ]);
    assert.equal(reader.snapshot().live.state, "tool");
    reader.feed([{ ...base(5000), type: "user", uuid: "u2", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } }]);
    const record = reader.snapshot();
    assert.deepEqual([record.status, record.live.turnOpen], ["interrupted", false]);
    assert.equal(reader.takeEvents().find(e => e.id === "tb").status, "unknown");
  });

  it("claude: two rows of one response that both say end_turn are one turn, not two", () => {
    const reader = READERS.claude.createReader({ file: join(FX, `${CLAUDE_DIR}.jsonl`), host: "h1", site: "mac" });
    const base = ms => ({ isSidechain: false, timestamp: stamp(ms), sessionId: CLAUDE_ID, cwd: "/w", version: "2.1.296" });
    const row = (ms, uuid, text) => ({ ...base(ms), type: "assistant", uuid, message: { id: "msg_same", role: "assistant", model: "m", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text }] } });
    reader.feed([
      { ...base(100), type: "user", uuid: "u1", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      row(1000, "a1", "first block"), row(1001, "a2", "second block"),
    ]);
    const record = reader.snapshot();
    assert.deepEqual([record.counts.turns, record.status, record.live.turnOpen], [1, "done", false]);
    assert.equal(reader.takeEvents().filter(e => e.type === "model").length, 1);
  });

  it("codex: turn_aborted ends the turn as interrupted; a later task_started opens a new one", () => {
    const reader = READERS.codex.createReader({ file: join(FX, `${CODEX_DIR}/rollout-2026-10-01T10-00-00-${CODEX_P}.jsonl`), host: "h1", site: "mac" });
    const ev = (ms, payload) => ({ timestamp: stamp(ms), type: "event_msg", payload });
    reader.feed([ev(100, { type: "task_started", turn_id: "t1" }), ev(900, { type: "turn_aborted", turn_id: "t1", reason: "interrupted" })]);
    assert.equal(reader.snapshot().status, "interrupted");
    reader.feed([ev(2000, { type: "task_started", turn_id: "t2" })]);
    assert.deepEqual([reader.snapshot().status, reader.snapshot().counts.turns], ["running", 2]);
  });

  it("dsh: an aborted turn is interrupted, a completed one done; an approval request means waiting", () => {
    const file = dshFile("session-d0000000-0000-4000-8000-0000000000cc");
    const reader = READERS.dsh.createReader({ file, host: "h1", site: "mac" });
    const r = (seq, type, data) => ({ type, seq, time: T0 + seq * 100, data });
    reader.feed([
      { type: "session", version: 4, id: "session-d0000000-0000-4000-8000-0000000000cc", createdAt: T0, cwd: "/w" },
      r(1, "turn/start", { turn: 1 }),
      r(2, "tool/call", { callId: "k1", name: "bash", arguments: JSON.stringify({ command: "rm -rf build" }) }),
      r(3, "approval/asked", { id: "ap1", toolName: "bash", callId: "k1" }),
    ]);
    assert.deepEqual([reader.snapshot().status, reader.snapshot().live.doing], ["waiting", "waiting for approval: bash"]);
    reader.feed([r(4, "approval/decided", { id: "ap1", outcome: "allowed-once" })]);
    assert.equal(reader.snapshot().status, "running");
    reader.feed([r(5, "turn/end", { turn: 1, reason: { kind: "aborted", reason: { kind: "user" } } })]);
    assert.equal(reader.snapshot().status, "interrupted");
    reader.feed([r(6, "turn/start", { turn: 2 }), r(7, "turn/end", { turn: 2, reason: { kind: "completed" } })]);
    assert.equal(reader.snapshot().status, "done");
  });
});

describe("reader contract", () => {
  const all = () => [
    ["omp", `${OMP_DIR}.jsonl`], ["omp", `${OMP_DIR}/Scout.jsonl`], ["claude", `${CLAUDE_DIR}.jsonl`],
    ["codex", `${CODEX_DIR}/rollout-2026-10-01T10-00-00-${CODEX_P}.jsonl`],
  ].map(([kind, rel]) => load(kind, rel)).concat([loadDsh(DSH_MAIN)]);

  it("every record has valid enums and bounded text; events respect preview/text/target limits", () => {
    for (const { record, events } of all()) {
      assert.ok(STATUSES.includes(record.status));
      assert.equal(record.live.alive, null, "liveness is the collector's business");
      for (const e of events.values()) {
        assert.ok((e.preview ?? "").length <= LIMITS.previewChars);
        assert.ok((e.text ?? "").length <= LIMITS.textChars);
        assert.ok((e.targets ?? []).length <= LIMITS.maxTargetsPerEvent);
        assert.ok(Number.isFinite(e.t));
      }
    }
  });

  it("secrets in prompts, tool commands and errors never reach events or the record", () => {
    const secret = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const file = join(FX, `${OMP_DIR}.jsonl`);
    const reader = READERS.omp.createReader({ file, host: "h1", site: "mac" });
    reader.feed([
      { type: "session", version: 3, id: OMP_ID, timestamp: new Date(T0).toISOString(), cwd: "/work/demo" },
      { type: "message", id: "u", timestamp: new Date(T0 + 10).toISOString(), message: { role: "user", content: [{ type: "text", text: `use key ${secret} please` }], timestamp: T0 + 10 } },
      { type: "message", id: "a", timestamp: new Date(T0 + 20).toISOString(), message: { role: "assistant", stopReason: "toolUse", timestamp: T0 + 15, usage: { input: 1, output: 1 }, content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: `curl -H "Authorization: Bearer ${secret}" https://x.example/api` } }] } },
      { type: "message", id: "r", timestamp: new Date(T0 + 30).toISOString(), message: { role: "toolResult", toolCallId: "t1", toolName: "bash", isError: true, content: [{ type: "text", text: `401 for ${secret}` }], timestamp: T0 + 30 } },
    ]);
    const dump = JSON.stringify([reader.snapshot(), ...reader.takeEvents()]);
    assert.ok(!dump.includes("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"), "the key must be redacted everywhere");
    assert.match(dump, /‹redacted›/);
  });

  it("a malformed row becomes at most a few error events and never stops the stream", () => {
    const file = join(FX, `${OMP_DIR}.jsonl`);
    const reader = READERS.omp.createReader({ file, host: "h1", site: "mac" });
    const stamp = new Date(T0).toISOString();
    reader.feed([
      { type: "session", version: 3, id: OMP_ID, timestamp: stamp, cwd: "/w" },
      { type: "message", id: "x", timestamp: stamp, message: { role: "assistant", content: "not-an-array", usage: 7, stopReason: "stop", timestamp: T0 } },
      { type: "message", id: "y", timestamp: stamp, message: null },
      { type: "message", id: "z", timestamp: new Date(T0 + 5).toISOString(), message: { role: "user", content: [{ type: "text", text: "still alive" }], timestamp: T0 + 5 } },
    ]);
    const events = reader.takeEvents();
    assert.ok(events.some(e => e.type === "user" && e.text === "still alive"));
    assert.ok(events.filter(e => e.type === "error").length <= 3);
  });

  it("takeEvents drains: a second call returns nothing until something changes", () => {
    const { reader } = load("omp", `${OMP_DIR}.jsonl`);
    assert.deepEqual(reader.takeEvents(), []);
    assert.equal(reader.snapshot().key, `h1#omp:${OMP_ID}`);
  });
});
