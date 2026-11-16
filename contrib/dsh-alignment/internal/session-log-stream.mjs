// Read a DSH session log (session.v*.jsonl.zstd, or plain .jsonl) line by line without ever holding the whole log
// (2026-11-16). A session log is one zstd frame per flush; a long session's log can decode to more text than one JS
// string can hold (e.g. 169 MB zstd decoding to 608 MB of jsonl; V8's limit is about 512 MB), so
// zstdDecompressSync(raw).toString() fails with ERR_STRING_TOO_LONG. Here whole frames are found from their headers,
// decompressed in batches and cut into lines; a caller looks at each line (as a Buffer) and keeps only what it needs.
// Users here: tool-stats.js (tool-call P90) and cli/align.mjs (paths a session touched).
import { closeSync, openSync, readSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = 0xFD2FB528;
/**
 * Where the zstd frame starting at `at` ends and how many bytes it decodes to (-1: the frame does not say), read from
 * the frame and block headers alone (RFC 8878 section 3.1), nothing decompressed. null: buf ends inside the frame.
 * Frame boundaries cannot be found by searching for the magic number: it also occurs inside compressed data.
 */
function frameAt(buf, at, base) {
  if (at + 4 > buf.length) return null;
  const magic = buf.readUInt32LE(at);
  if ((magic & 0xFFFFFFF0) >>> 0 === 0x184D2A50) { // skippable frame: magic, 4-byte length, data
    if (at + 8 > buf.length) return null;
    const end = at + 8 + buf.readUInt32LE(at + 4);
    return end > buf.length ? null : { end, size: 0 };
  }
  if (magic !== ZSTD_MAGIC) throw new Error('not a zstd frame at byte ' + (base + at) + ' (starts with 0x' + magic.toString(16).padStart(8, '0') + ')');
  if (at + 5 > buf.length) return null;
  const descriptor = buf[at + 4];
  const single = (descriptor >> 5) & 1; // single segment: no window descriptor, content size always present
  const sizeBytes = descriptor >> 6 === 0 ? single : [0, 2, 4, 8][descriptor >> 6];
  let p = at + 5 + (single ? 0 : 1) + [0, 1, 2, 4][descriptor & 3]; // window descriptor, dictionary id
  if (p + sizeBytes > buf.length) return null;
  const size = sizeBytes === 0 ? -1 : sizeBytes === 1 ? buf[p] : sizeBytes === 2 ? buf.readUInt16LE(p) + 256 : sizeBytes === 4 ? buf.readUInt32LE(p) : Number(buf.readBigUInt64LE(p));
  p += sizeBytes;
  for (;;) { // blocks: 3-byte header = last flag (1 bit), type (2 bits), size (21 bits)
    if (p + 3 > buf.length) return null;
    const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    const type = (h >> 1) & 3;
    if (type === 3) throw new Error('damaged zstd frame at byte ' + (base + at) + ' (reserved block type at byte ' + (base + p) + ')');
    p += 3 + (type === 1 ? 1 : h >>> 3); // an RLE block stores one byte whatever its size
    if (h & 1) break;
  }
  if (descriptor & 4) p += 4; // content checksum
  return p > buf.length ? null : { end: p, size };
}

/**
 * Call onLine(Buffer) for every line of a session log (.jsonl.zstd or plain .jsonl) without ever holding the whole log:
 * the file is read chunkBytes at a time, whole zstd frames are decompressed in batches of about outBytes of output.
 * dsh appends one frame per flush, so a read can catch the last frame half-written: at the end of the file with part of
 * a frame left, read once more. Still incomplete, or any frame damaged: throw. A log whose end cannot be decoded may hide
 * exactly the event that matters, so it is never used "up to
 * the bad frame".
 * opts.chunkBytes / opts.outBytes: for tests (lines across chunks and batches, frames larger than a chunk).
 */
export function eachLogLine(file, onLine, opts = {}) {
  const chunkBytes = opts.chunkBytes ?? 4 << 20, outBytes = opts.outBytes ?? 8 << 20;
  const zstd = file.endsWith('.zstd');
  let carry = []; // pieces of the line that continues in the next output
  const lines = (buf) => {
    let from = 0;
    for (let nl = buf.indexOf(10); nl >= 0; nl = buf.indexOf(10, from)) {
      const piece = buf.subarray(from, nl);
      if (carry.length) { carry.push(piece); onLine(Buffer.concat(carry)); carry = []; } else onLine(piece);
      from = nl + 1;
    }
    if (from < buf.length) carry.push(buf.subarray(from));
  };
  const fd = openSync(file, 'r');
  try {
    let pending = Buffer.alloc(0), base = 0, reread = false; // pending: compressed bytes not decoded yet, from file offset base
    for (;;) {
      const chunk = Buffer.allocUnsafe(chunkBytes); // a new buffer each time: lines and pending keep views into the old ones
      const n = readSync(fd, chunk, 0, chunkBytes, null);
      if (n === 0) {
        if (!pending.length) break;
        if (reread) throw new Error('last zstd frame incomplete: it starts at byte ' + base + ' and the file ends at byte ' + (base + pending.length) + ' (same after one re-read)');
        reread = true;
        continue;
      }
      reread = false;
      const data = chunk.subarray(0, n);
      if (!zstd) { lines(data); continue; }
      pending = pending.length ? Buffer.concat([pending, data]) : data;
      let at = 0, start = 0, expect = 0;
      const decode = (end, size) => {
        const out = zstdDecompressSync(pending.subarray(start, end));
        // also the check that this Node decodes every frame of a multi-frame buffer, not only the first
        if (size >= 0 && out.length !== size) throw new Error('zstd frames at bytes ' + (base + start) + '-' + (base + end) + ' decoded to ' + out.length + ' bytes, their headers say ' + size);
        lines(out);
        start = end;
        expect = 0;
      };
      for (let f = frameAt(pending, at, base); f; f = frameAt(pending, at, base)) {
        if (f.size < 0) { // size unknown: decode what is batched, then this frame alone
          if (at > start) decode(at, expect);
          decode(f.end, -1);
        } else {
          expect += f.size;
          if (expect >= outBytes) decode(f.end, expect);
        }
        at = f.end;
      }
      if (at > start) decode(at, expect);
      base += at;
      pending = pending.subarray(at);
    }
  } finally { closeSync(fd); }
  if (carry.length) onLine(Buffer.concat(carry));
}
