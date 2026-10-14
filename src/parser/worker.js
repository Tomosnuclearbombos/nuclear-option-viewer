// Background thread: reads a dropped replay (plain .acmi, Tacview's .zip.acmi, or gzip), streams it through
// decompression into the reader, and sends the finished arrays back without copying them.
//
// in:  { file: File }
// out: { type: "progress", done, total }  then  { type: "done", result }  or  { type: "error", message }
// Error messages are shown to people as they are, so they are plain sentences that say what to do.

import { Unzip, UnzipInflate, Gunzip } from "../../vendor/fflate/fflate.js";
import { AcmiParser, transferables } from "./acmi.js";

// a message meant for the person, passed through unchanged
class ReplayError extends Error {}

const DAMAGED = "That replay file is damaged or only partly downloaded. Download it again.";
const MAX_SPAN = 48 * 3600;   // seconds; no real recording is longer than this

self.onmessage = async (msg) => {
  const { file } = msg.data;
  try {
    const result = await read(file);
    self.postMessage({ type: "done", result }, transferables(result));
  } catch (err) {
    self.postMessage({ type: "error", message: plain(err) });
  }
};

function plain(err) {
  if (err instanceof ReplayError) return err.message;
  console.error("replay reader:", err);
  const name = err && err.name;
  // the browser couldn't read the file itself (moved, still downloading, permission)
  if (name === "NotReadableError" || name === "NotFoundError" || name === "AbortError" || name === "SecurityError") {
    return "That file couldn't be read. If it's still downloading, wait for it to finish and try again.";
  }
  // decompression errors (fflate tags them with a number 0..14; browser DOMExceptions also carry numbers, but they
  // are handled above by name)
  if (err instanceof Error && !(typeof DOMException !== "undefined" && err instanceof DOMException) && typeof err.code === "number") {
    if (err.code === 14) return "That zip is packed in a way the viewer can't read. Use the original .zip.acmi file.";
    return DAMAGED;
  }
  return "Something went wrong reading that replay.";
}

async function read(file) {
  const parser = new AcmiParser();
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const isZip = head[0] === 0x50 && head[1] === 0x4b;
  const isGzip = head[0] === 0x1f && head[1] === 0x8b;

  let sink = (chunk) => parser.push(chunk);
  let feed, close;
  let picked = false, want = null, crc = 0, size = 0;
  if (isZip) {
    // The zip's own checksum of each file: damage that still unpacks (a few flipped bytes) only shows up here.
    const dir = await zipDirectory(file);
    const unzip = new Unzip((entry) => {
      // a .zip.acmi holds one .acmi file; take the first one
      if (picked || !/\.acmi$/i.test(entry.name || "")) return;
      picked = true;
      want = dir ? dir.get(entry.name) || null : null;
      entry.ondata = (err, chunk) => {
        if (err) throw err;
        if (chunk && chunk.length) { if (want) { crc = crc32(crc, chunk); size += chunk.length; } sink(chunk); }
      };
      entry.start();
    });
    unzip.register(UnzipInflate);
    feed = (chunk) => unzip.push(chunk, false);
    close = () => unzip.push(new Uint8Array(0), true);
  } else if (isGzip) {
    const gz = new Gunzip((chunk) => { if (chunk && chunk.length) sink(chunk); });
    feed = (chunk) => gz.push(chunk, false);
    close = () => gz.push(new Uint8Array(0), true);
  } else {
    feed = sink;
    close = () => {};
  }

  const total = file.size;
  let done = 0, lastReport = 0;
  const reader = file.stream().getReader();
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    done += value.length;
    feed(value);
    const now = performance.now();
    if (now - lastReport > 100) { lastReport = now; self.postMessage({ type: "progress", done, total }); }
  }
  close();
  self.postMessage({ type: "progress", done: total, total });
  if (isZip && !picked) throw new ReplayError("There's no replay inside that zip file.");
  if (want && (size !== want.size || crc >>> 0 !== want.crc)) throw new ReplayError(DAMAGED);
  const result = parser.finish();
  // Anything that isn't a Tacview recording (a picture, a mission file, random bytes) reads as zero objects.
  if (!String(result.header.fileType).startsWith("text/acmi")) throw new ReplayError("That file isn't a Tacview replay.");
  if (result.objects.count === 0 || result.frames === 0) throw new ReplayError("That replay is empty.");
  // corruption that still decompresses cleanly shows up as impossible times
  const span = result.tMax - result.tMin;
  if (!Number.isFinite(result.tMin) || !Number.isFinite(result.tMax) || span < 0 || span > MAX_SPAN) throw new ReplayError(DAMAGED);
  // more frame times thrown away than kept: the clock itself is damaged (say the very first time was garbled)
  if (result.badFrames > result.frames) throw new ReplayError(DAMAGED);
  return result;
}

// name -> { crc, size } for each file in a zip, from the central directory at its end; null if it can't be read
// (a cut-short zip, which unpacking catches anyway)
async function zipDirectory(file) {
  try {
    const tailLen = Math.min(file.size, 65557);
    const tail = new DataView(await file.slice(file.size - tailLen).arrayBuffer());
    let e = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { e = i; break; }
    if (e < 0) return null;
    const count = tail.getUint16(e + 10, true), cdSize = tail.getUint32(e + 12, true), cdOff = tail.getUint32(e + 16, true);
    if (cdOff === 0xffffffff || cdOff + cdSize > file.size) return null;   // zip64 or nonsense: skip the check
    const cd = new DataView(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
    const out = new Map(), dec = new TextDecoder();
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.byteLength; n++) {
      if (cd.getUint32(p, true) !== 0x02014b50) return null;
      const crc = cd.getUint32(p + 16, true), size = cd.getUint32(p + 24, true);
      const nameLen = cd.getUint16(p + 28, true), extra = cd.getUint16(p + 30, true), comment = cd.getUint16(p + 32, true);
      const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
      if (size !== 0xffffffff) out.set(name, { crc, size });
      p += 46 + nameLen + extra + comment;
    }
    return out;
  } catch (e) {
    return null;
  }
}

// CRC-32 (the zip one), eight bytes at a time
const CRC = (() => {
  const t = new Int32Array(256 * 8);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  for (let n = 0; n < 256; n++) for (let k = 1; k < 8; k++) t[k * 256 + n] = (t[(k - 1) * 256 + n] >>> 8) ^ t[t[(k - 1) * 256 + n] & 255];
  return t;
})();
function crc32(crc, b) {
  const t = CRC;
  let c = ~crc, i = 0;
  const n8 = b.length - (b.length & 7);
  for (; i < n8; i += 8) {
    const a = c ^ (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24));
    c = t[1792 + (a & 255)] ^ t[1536 + ((a >>> 8) & 255)] ^ t[1280 + ((a >>> 16) & 255)] ^ t[1024 + (a >>> 24)] ^
      t[768 + b[i + 4]] ^ t[512 + b[i + 5]] ^ t[256 + b[i + 6]] ^ t[b[i + 7]];
  }
  for (; i < b.length; i++) c = t[(c ^ b[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}
