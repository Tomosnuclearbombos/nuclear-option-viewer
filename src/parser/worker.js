// Background thread: reads a dropped replay (plain .acmi, Tacview's .zip.acmi, or gzip), streams it through
// decompression into the reader, and sends the finished arrays back without copying them.
//
// in:  { file: File }
// out: { type: "progress", done, total }  then  { type: "done", result }  or  { type: "error", message }

import { Unzip, UnzipInflate, Gunzip } from "../../vendor/fflate/fflate.js";
import { AcmiParser, transferables } from "./acmi.js";

self.onmessage = async (msg) => {
  const { file } = msg.data;
  try {
    const result = await read(file);
    self.postMessage({ type: "done", result }, transferables(result));
  } catch (err) {
    self.postMessage({ type: "error", message: String((err && err.message) || err) });
  }
};

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
  if (isZip && !picked) throw new Error("There's no replay inside that zip file.");
  const result = parser.finish();
  // Anything that isn't a Tacview recording (a picture, a mission file, random bytes) reads as zero objects.
  if (!String(result.header.fileType).startsWith("text/acmi")) throw new Error("That file isn't a Tacview replay.");
  if (result.objects.count === 0 || result.frames === 0) throw new Error("That replay is empty.");
  return result;
}
