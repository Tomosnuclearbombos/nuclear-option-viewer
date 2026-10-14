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
  let picked = false;
  if (isZip) {
    const unzip = new Unzip((entry) => {
      // a .zip.acmi holds one .acmi file; take the first one
      if (picked || !/\.acmi$/i.test(entry.name || "")) return;
      picked = true;
      entry.ondata = (err, chunk) => { if (err) throw err; if (chunk && chunk.length) sink(chunk); };
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
  const result = parser.finish();
  // Anything that isn't a Tacview recording (a picture, a mission file, random bytes) reads as zero objects.
  if (!String(result.header.fileType).startsWith("text/acmi")) throw new ReplayError("That file isn't a Tacview replay.");
  if (result.objects.count === 0 || result.frames === 0) throw new ReplayError("That replay is empty.");
  // corruption that still decompresses cleanly shows up as impossible times
  const span = result.tMax - result.tMin;
  if (!Number.isFinite(result.tMin) || !Number.isFinite(result.tMax) || span < 0 || span > MAX_SPAN) throw new ReplayError(DAMAGED);
  return result;
}
