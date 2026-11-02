// Incremental tail reader for session transcripts: plain JSONL (OMP, Claude, Codex) and DSH's
// `session.v4.jsonl.zstd` (concatenated, independent zstd frames: one header frame, then one frame per append).
//
//   const tail = createTail(path, {format: "jsonl" | "zstd"});
//   const {lines, reset, more, bad} = await tail.read();   // only what was appended since the last call
//
// - `lines` are parsed JSON objects. A trailing partial line (jsonl) or torn frame (zstd) is left unread and
//   picked up by the next call, once it is complete.
// - `reset: true` means the file was replaced (inode/device changed), shrank, or the bytes before our offset no
//   longer match what we read: the tail restarted from byte 0 and `lines` holds the file again from the start.
//   Callers drop their state and re-feed.
// - One call reads at most `maxBytes` (default 8 MiB; the window grows for a single line/frame larger than that).
//   `more: true` means unread complete data may remain and the caller may call again immediately.
// - `bad` counts complete lines/frames that could not be decoded (skipped, never fatal).
// - A missing file yields `{lines: [], reset: false, more: false, bad: 0, missing: true}`.
import { open, stat } from "node:fs/promises";
import { zstdDecompressSync } from "node:zlib";
import { LIMITS } from "./protocol.mjs";

const NL = 0x0a;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const MAX_FRAME_BYTES = 256 * 1024 * 1024;
const ANCHOR_BYTES = 32;
const YIELD_EVERY_FRAMES = 2000;

const ZSTD_MAGIC = 0xfd2fb528;
const ZSTD_SKIPPABLE = 0x184d2a50; // 0x184D2A50..5F
const ZSTD_MAGIC_BYTES = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const EMPTY = Buffer.alloc(0);
const yieldToLoop = () => new Promise(resolve => setImmediate(resolve));
const NOTHING = () => ({ lines: [], reset: false, more: false, bad: 0 });

/**
 * @param {string} path
 * @param {{format?: "jsonl"|"zstd", maxLineBytes?: number}} [options]
 */
export function createTail(path, { format = "jsonl", maxLineBytes = LIMITS.lineBytes } = {}) {
  if (format !== "jsonl" && format !== "zstd") throw new Error(`createTail: unknown format ${format}`);
  const state = {
    dev: null, ino: null,
    offset: 0,        // first byte not yet turned into lines (start of the partial line / torn frame)
    sizeSeen: -1,     // file size at the previous read: a smaller size means the file was cut
    caughtUpAt: -1,   // file size at which everything complete had been consumed; equal size = nothing to do
    anchor: EMPTY,    // the last bytes before `offset`: detects a file rewritten behind our back
    skipping: false,  // jsonl: discarding the rest of an oversized line
  };
  let chain = Promise.resolve();

  /** @param {{maxBytes?: number}} [options] */
  function read(options = {}) {
    const run = chain.then(() => readOnce(options));
    // Order reads without holding the last result: a resolved chain would keep its whole batch of rows alive.
    chain = run.then(() => {}, () => {});
    return run;
  }

  async function readOnce({ maxBytes = DEFAULT_MAX_BYTES } = {}) {
    let st;
    try { st = await stat(path); } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return { ...NOTHING(), missing: true };
      throw error;
    }
    const known = state.ino !== null;
    if (known && st.ino === state.ino && st.dev === state.dev && st.size === state.caughtUpAt) return NOTHING();

    let fd;
    try { fd = await open(path, "r"); } catch (error) {
      if (error.code === "ENOENT") return { ...NOTHING(), missing: true };
      throw error;
    }
    try {
      const fst = await fd.stat();
      let reset = known && (fst.ino !== state.ino || fst.dev !== state.dev || fst.size < state.sizeSeen || fst.size < state.offset);
      if (reset) restart();
      let result = await pass(fd, fst, maxBytes);
      if (result === null) { // the bytes before our offset changed: start over
        reset = true;
        restart();
        result = await pass(fd, fst, maxBytes);
      }
      state.dev = fst.dev; state.ino = fst.ino; state.sizeSeen = fst.size;
      state.caughtUpAt = result.more ? -1 : fst.size;
      return { lines: result.lines, reset, more: result.more, bad: result.bad };
    } finally {
      await fd.close();
    }
  }

  function restart() {
    state.offset = 0; state.anchor = EMPTY; state.skipping = false; state.sizeSeen = -1; state.caughtUpAt = -1;
  }

  /** One read window starting at `state.offset`. Returns null when the anchor no longer matches the file. */
  async function pass(fd, fst, maxBytes) {
    const limit = format === "jsonl" ? maxLineBytes + 1 : MAX_FRAME_BYTES;
    let window = Math.max(1024, maxBytes);
    for (;;) {
      const anchorLen = state.anchor.length;
      const start = state.offset - anchorLen;
      const want = Math.min(fst.size - start, anchorLen + window);
      if (want <= anchorLen) return { lines: [], more: false, bad: 0 };
      const buf = Buffer.allocUnsafe(want);
      let got = 0;
      while (got < want) {
        const { bytesRead } = await fd.read(buf, got, want - got, start + got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      if (anchorLen > 0 && (got < anchorLen || buf.compare(state.anchor, 0, anchorLen, 0, anchorLen) !== 0)) return null;
      const data = buf.subarray(anchorLen, got);
      const atEof = start + got >= fst.size;
      const parsed = format === "jsonl" ? parseJsonl(data) : await parseZstd(data);
      let { consumed, bad } = parsed;
      if (consumed === 0 && !atEof) { // a single line/frame larger than the window
        if (window < limit) { window = Math.min(window * 2, limit); continue; }
        consumed = data.length; bad += 1; // larger than any sane record: drop it
        if (format === "jsonl") state.skipping = true;
      }
      state.offset += consumed;
      state.anchor = Buffer.from(buf.subarray(Math.max(0, anchorLen + consumed - ANCHOR_BYTES), anchorLen + consumed));
      return { lines: parsed.lines, more: !atEof, bad };
    }
  }

  function parseJsonl(data) {
    const lines = [];
    let bad = 0, pos = 0;
    if (state.skipping) {
      const nl = data.indexOf(NL);
      if (nl < 0) return { lines, consumed: data.length, bad };
      pos = nl + 1; state.skipping = false;
    }
    for (;;) {
      const nl = data.indexOf(NL, pos);
      if (nl < 0) break;
      if (nl > pos) {
        const record = decodeLine(data.toString("utf8", pos, nl));
        if (record === undefined) bad += 1; else lines.push(record);
      }
      pos = nl + 1;
    }
    if (data.length - pos > maxLineBytes) { state.skipping = true; bad += 1; pos = data.length; } // oversized line: drop it
    return { lines, consumed: pos, bad };
  }

  async function parseZstd(data) {
    const lines = [];
    let bad = 0, pos = 0, frames = 0;
    while (pos < data.length) {
      const end = zstdFrameEnd(data, pos);
      if (end === -1) break; // torn frame: wait for the rest
      if (end === -2) { // not a frame boundary: resync on the next magic number
        bad += 1;
        const next = data.indexOf(ZSTD_MAGIC_BYTES, pos + 1);
        if (next < 0) { pos = Math.max(pos + 1, data.length - ZSTD_MAGIC_BYTES.length + 1); break; }
        pos = next;
        continue;
      }
      if (!isSkippable(data, pos)) {
        try {
          const text = zstdDecompressSync(data.subarray(pos, end)).toString("utf8");
          let from = 0;
          while (from < text.length) {
            let nl = text.indexOf("\n", from);
            if (nl < 0) nl = text.length;
            if (nl > from) {
              const record = decodeLine(text.slice(from, nl));
              if (record === undefined) bad += 1; else lines.push(record);
            }
            from = nl + 1;
          }
        } catch { bad += 1; }
      }
      pos = end;
      if (++frames % YIELD_EVERY_FRAMES === 0) await yieldToLoop();
    }
    return { lines, consumed: pos, bad };
  }

  return { read };
}

/** Parse one JSON line; undefined when it is not a JSON object. */
function decodeLine(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch { return undefined; }
}

function isSkippable(data, start) {
  return ((data.readUInt32LE(start) & 0xfffffff0) >>> 0) === ZSTD_SKIPPABLE;
}

/**
 * End offset (exclusive) of the zstd frame starting at `start`; -1 when the buffer ends inside the frame,
 * -2 when no frame starts there. Walks the frame header and block headers (RFC 8878 §3.1.1) without decoding.
 * @param {Buffer} b
 * @param {number} start
 */
export function zstdFrameEnd(b, start) {
  if (b.length - start < 4) return -1;
  const magic = b.readUInt32LE(start);
  if (((magic & 0xfffffff0) >>> 0) === ZSTD_SKIPPABLE) {
    if (b.length - start < 8) return -1;
    const end = start + 8 + b.readUInt32LE(start + 4);
    return end <= b.length ? end : -1;
  }
  if (magic !== ZSTD_MAGIC) return -2;
  let p = start + 4;
  if (p >= b.length) return -1;
  const descriptor = b[p++];
  if (descriptor & 0x08) return -2; // reserved bit
  const sizeFlag = descriptor >> 6, single = (descriptor >> 5) & 1, checksum = (descriptor >> 2) & 1, dictFlag = descriptor & 3;
  if (!single) p += 1; // window descriptor
  p += [0, 1, 2, 4][dictFlag];
  p += sizeFlag === 0 ? single : sizeFlag === 1 ? 2 : sizeFlag === 2 ? 4 : 8;
  for (;;) {
    if (p + 3 > b.length) return -1;
    const header = b[p] | (b[p + 1] << 8) | (b[p + 2] << 16);
    const last = header & 1, type = (header >> 1) & 3, size = header >>> 3;
    if (type === 3) return -2; // reserved block type
    p += 3 + (type === 1 ? 1 : size); // an RLE block carries a single byte
    if (p > b.length) return -1;
    if (last) break;
  }
  if (checksum) p += 4;
  return p <= b.length ? p : -1;
}

/**
 * First line of a file as a parsed object (OMP rewrites its padded `{"type":"title",…}` line in place, which an
 * append-only tail never sees; callers re-read it when the file's mtime changes). null when missing or not JSON.
 * @param {string} path
 */
export async function readFirstLine(path) {
  let fd;
  try { fd = await open(path, "r"); } catch { return null; }
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    const nl = buf.subarray(0, bytesRead).indexOf(NL);
    if (nl < 0 && bytesRead === buf.length) return null; // no newline in 64 KiB: not a transcript
    return decodeLine(buf.toString("utf8", 0, nl < 0 ? bytesRead : nl)) ?? null;
  } catch { return null; } finally { await fd.close(); }
}
