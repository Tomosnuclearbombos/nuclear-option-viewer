// Live mode: follows a match while it is being played, from the pieces tools/live_publish.py writes.
//
// The publisher only puts a piece out once it is about 45 s old, so what this shows is always at least that far behind
// the real battle. Each piece starts with a snapshot of every unit, then that stretch of the recording; the pieces
// kept (the newest 15 minutes) are joined back into one ordinary recording (the first piece whole, the rest from after
// their snapshot) and read by the same reader a dropped file goes through. That is redone as new pieces arrive, and
// main.js swaps the result in keeping the time, camera, selection and following.

import { gunzipSync } from "../vendor/fflate/fflate.js";

const POLL_MS = 5000;           // how often the manifest is checked
const REBUILD_MS = 20000;       // the replay is rebuilt at most this often, unless playback is about to run out
export const LIVE_BUFFER_S = 15; // the live moment sits this far behind the newest data, so a new piece is always in time
const MARK = new TextEncoder().encode("\n// nov-keyframe-end\n");

// the PvE server's feed, for the start page's live key
export const LIVE_PVE = "https://vps-26413982.vps.ovh.ca/s2/current.json";
const FRESH_S = 300;            // a feed not updated for this long has stopped (its publisher is down)

// the title of the match being played on that server right now, or "" when there's none
export async function liveMatch(url) {
  try {
    const cur = await getJSON(new URL(url, location.href).href);
    if (!cur || !cur.manifest || cur.ended || !(Date.now() / 1000 - cur.updated < FRESH_S)) return "";
    return cur.title || "Live match";
  } catch { return ""; }
}

export class LiveFeed {
  // url = the server's current.json. onBuild(file, info) gets the joined recording as a File; onStatus(text, ended)
  // reports what is going on; needSoon() says whether playback is close to the end of the data.
  constructor(url, { onBuild, onStatus, needSoon }) {
    this.url = new URL(url, location.href).href;
    this.onBuild = onBuild;
    this.onStatus = onStatus;
    this.needSoon = needSoon;
    this.match = null;
    this.pieces = new Map();    // seq -> { t0, t1, bytes: Uint8Array (unzipped), body: offset after the snapshot }
    this.builtSeq = -1;         // newest piece in the last build
    this.lastBuild = 0;
    this.ended = false;
    this.busy = false;
    this.stopped = false;
  }

  start() { this.tick(); this.timer = setInterval(() => this.tick(), POLL_MS); }
  stop() { this.stopped = true; clearInterval(this.timer); }

  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try { await this.poll(); } catch (err) { console.warn("live:", err); this.onStatus("CONNECTION LOST, RETRYING", false); }
    finally { this.busy = false; }
  }

  async poll() {
    const cur = await getJSON(this.url);
    if (!cur || !cur.manifest) { this.onStatus("NO LIVE MATCH RIGHT NOW", true); return; }
    if (cur.match !== this.match) {   // a new match started: start over
      this.match = cur.match;
      this.pieces.clear();
      this.builtSeq = -1;
      this.ended = false;
    }
    const manUrl = new URL(cur.manifest, this.url).href;
    const man = await getJSON(manUrl);
    if (!man) { this.onStatus(cur.ended ? "MATCH OVER" : "NO LIVE MATCH RIGHT NOW", true); return; }
    const want = new Set(man.pieces.map((p) => p.seq));
    for (const seq of [...this.pieces.keys()]) if (!want.has(seq)) this.pieces.delete(seq);
    for (const p of man.pieces) {
      if (this.pieces.has(p.seq)) continue;
      const r = await fetch(new URL(p.file, manUrl).href, { cache: "force-cache" });
      if (!r.ok) continue;                       // dropped from the server since the manifest was written
      const bytes = gunzipSync(new Uint8Array(await r.arrayBuffer()));
      this.pieces.set(p.seq, { t0: p.t0, t1: p.t1, bytes, body: bodyStart(bytes) });
    }
    this.ended = !!man.ended;
    if (!this.pieces.size) { this.onStatus(this.ended ? "MATCH OVER" : "MATCH STARTING", this.ended); return; }
    const newest = Math.max(...this.pieces.keys());
    const due = this.builtSeq < 0 || this.ended || this.needSoon() || performance.now() - this.lastBuild >= REBUILD_MS;
    if (newest > this.builtSeq && due) {
      this.builtSeq = newest;
      this.lastBuild = performance.now();
      await this.onBuild(this.join(), { title: man.title, ended: this.ended, match: man.match });   // one build at a time
    }
    this.onStatus(this.ended ? "MATCH OVER" : "LIVE", this.ended);
    if (this.ended && this.builtSeq === newest) this.stop();
  }

  // the kept pieces as one recording: the first whole, the rest without their snapshot
  join() {
    const seqs = [...this.pieces.keys()].sort((a, b) => a - b);
    const parts = seqs.map((s, k) => {
      const p = this.pieces.get(s);
      return k === 0 ? p.bytes : p.bytes.subarray(p.body);
    });
    return new File(parts, (this.match || "live") + ".acmi", { type: "text/plain" });
  }
}

async function getJSON(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

// where the recording itself starts in a piece: just after its "// nov-keyframe-end" line
function bodyStart(b) {
  const m = MARK, n = m.length;
  outer: for (let i = 0; i + n <= b.length; i++) {
    for (let k = 0; k < n; k++) if (b[i + k] !== m[k]) continue outer;
    return i + n;
  }
  return 0;
}
