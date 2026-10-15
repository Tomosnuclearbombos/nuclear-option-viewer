// Live mode: follows a match while it is being played, from the pieces tools/live_publish.py writes.
//
// The publisher only puts a piece out once it is about 45 s old, so what this shows is always at least that far behind
// the real battle. Each piece starts with a snapshot of every unit, then that stretch of the recording. The newest run
// of pieces that follow on from each other is joined back into one ordinary recording (its first piece whole, the rest
// from after their snapshot) and read by the same reader a dropped file goes through. That is redone as new pieces
// arrive, and main.js swaps the result in keeping the time, camera, selection and following.
//
// The match on screen stays until it is over and has been watched to the end. Only then does the next match on the
// server (once it has a piece to show) take its place, opened as a new match.

import { gunzipSync } from "../vendor/fflate/fflate.js";

const TICK_MS = 500;            // how often it looks whether a check is due
const POLL_MS = 5000;           // a check of the feed this often,
const SOON_MS = 1500;           // this often while playback is near the end of the data,
const OVER_MS = 15000;          // and this often once the match on screen is over (looking out for the next one)
const REBUILD_MS = 20000;       // the replay is rebuilt at most this often, unless playback is about to run out
const TIMEOUT_MS = 15000;       // a request that takes longer than this has failed
const PARALLEL = 6;             // pieces downloaded at once
const BATCH = 18;               // pieces fetched per check, newest first: joining shows the newest 3 minutes straight
                                // away, and the rest of the window comes in over the next few checks
const PHONE_PIECES = 30;        // phones and tablets keep only the newest 5 minutes
const STALE_MS = 60000;         // a feed that hasn't changed for this long has paused
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
  // url = the server's current.json. The callbacks each get this feed last, so a feed that has been replaced can be
  // told apart: onBuild(file, info) gets the joined recording as a File (info: match, title, start = the match's first
  // frame time); onStatus(text, final) says what is going on; onProgress(f) how far the first download has got.
  // needSoon() says whether playback is close to the end of the data, playedOut() whether it has reached the end.
  constructor(url, { onBuild, onStatus, onProgress, needSoon, playedOut }) {
    this.url = new URL(url, location.href).href;
    this.onBuild = onBuild;
    this.onStatus = onStatus;
    this.onProgress = onProgress;
    this.needSoon = needSoon;
    this.playedOut = playedOut;
    this.keep = window.matchMedia("(pointer: coarse)").matches ? PHONE_PIECES : Infinity;
    this.updated = undefined;   // current.json's "updated" when last read, and when (on this browser's clock) it changed
    this.changedAt = performance.now();
    this.next = null;           // another match on air while this one is still on screen
    this.timer = 0;
    this.lastPoll = -Infinity;
    this.busy = false;
    this.again = false;
    this.stopped = false;
    this.track(null);
  }

  // follow this match (from current.json) from scratch: nothing of it is on screen yet
  track(air) {
    this.match = air ? air.match : null;
    this.manUrl = air ? air.man : null;
    this.title = air ? air.title : "";
    this.man = null;            // its newest manifest
    this.manUpdated = undefined;
    this.manChangedAt = 0;
    this.pieces = new Map();    // file -> { p: its manifest entry, bytes: Uint8Array (unzipped), body: offset after the snapshot, 0 if broken }
    this.shown = false;         // a build of it has been handed over
    this.built = "";            // the run of pieces the last build was made of
    this.lastBuild = 0;
    this.ended = false;         // every piece of it is out (or its manifest has gone)
    this.over = false;          // ...and the last of them is on screen
  }

  start() {
    this.onVisible = () => { if (!document.hidden) this.tick(true); };
    document.addEventListener("visibilitychange", this.onVisible);
    this.tick(true);
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    document.removeEventListener("visibilitychange", this.onVisible);
  }
  // check straight away rather than at the next turn
  pollNow() { this.tick(true); }

  // A check is due every 1.5 s while playback is near the end of the data, every 5 s otherwise, and every 15 s once the
  // match on screen is over. Nothing is checked while the tab is hidden; showing it again checks at once.
  async tick(now = false) {
    clearTimeout(this.timer);
    if (this.stopped || document.hidden) return;
    this.timer = setTimeout(() => this.tick(), TICK_MS);
    if (this.busy) { if (now) this.again = true; return; }
    const every = this.over ? OVER_MS : this.needSoon() ? SOON_MS : POLL_MS;
    if (!now && performance.now() - this.lastPoll < every) return;
    this.busy = true;
    this.lastPoll = performance.now();
    try { await this.poll(); } catch (err) {
      if (!this.stopped) { console.warn("live:", err); this.onStatus("RECONNECTING", false, this); }
    } finally { this.busy = false; }
    if (this.again) { this.again = false; this.tick(true); }
  }

  async poll() {
    // which match is on air
    let cur;
    try { cur = await getJSON(this.url); } catch (err) { if (this.over) return; throw err; }   // once over, only the next match needs it
    if (this.stopped) return;
    if (cur && cur.updated !== this.updated) { this.updated = cur.updated; this.changedAt = performance.now(); }
    let air = cur && cur.match && cur.manifest
      ? { match: cur.match, man: new URL(cur.manifest, this.url).href, title: cur.title || "", ended: !!cur.ended } : null;
    if (!this.shown && (air ? air.match : null) !== this.match) this.track(air);   // nothing on screen: whatever is on air
    if (!this.match) { this.onStatus("NO LIVE MATCH RIGHT NOW", true, this); return; }
    this.next = air && air.match !== this.match ? air : null;
    if (this.ended && air && !this.next && !air.ended) { this.ended = false; this.over = false; }   // it carried on after all

    // the match on screen is over and has been watched to the end: the next one takes over once it has a piece to show
    let man = null;
    if (this.over && this.next && this.playedOut()) {
      try { man = await getJSON(this.next.man); } catch { man = null; }
      if (this.stopped) return;
      if (man && man.pieces && man.pieces.length) { this.track(this.next); this.next = null; air = null; } else man = null;
    }

    // its manifest, until it has ended (nothing changes after that)
    if (!man && !this.ended) {
      let failed = null;
      try { man = await getJSON(this.manUrl); } catch (err) { failed = err; }
      if (this.stopped) return;
      if (!man || !man.pieces) {
        man = null;
        // gone or out of reach after the server has moved on, or has said it is over: it ended with what there is
        if (this.next || (air && air.ended)) this.man = { ...this.man, ended: true, pieces: [...this.pieces.values()].map((h) => h.p) };
        else if (!failed && !this.shown) { this.onStatus("NO LIVE MATCH RIGHT NOW", true, this); return; }
        else throw failed || new Error("no manifest");
        this.ended = true;
      }
    }
    if (man) {
      const now = performance.now();
      if (man.updated !== this.manUpdated) { this.manUpdated = man.updated; this.manChangedAt = now; }
      this.man = man;
      // over once every piece is out; also once the server has moved on and this manifest has stopped changing
      this.ended = !!man.ended || (!!this.next && now - this.manChangedAt > STALE_MS);
    }

    // the window, oldest first: everything listed (the newest 5 minutes on phones)
    const list = [...this.man.pieces].sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1).slice(-this.keep);
    if (!list.length) {
      this.over = this.shown && this.ended;
      this.onStatus(this.ended ? "MATCH OVER" : "MATCH STARTING", this.ended, this);
      return;
    }
    const files = new Set(list.map((p) => p.file));
    for (const f of this.pieces.keys()) if (!files.has(f)) this.pieces.delete(f);
    // what is missing, newest first, a batch at a time (so a new piece always comes before older ones)
    const failed = await this.fetchPieces(list.filter((p) => !this.pieces.has(p.file)).reverse().slice(0, BATCH));
    if (this.stopped) return;

    // the newest run of pieces that follow on from each other: a piece not fetched, or broken, ends it
    const run = [];
    for (let k = list.length - 1; k >= 0; k--) {
      const p = list[k], h = this.pieces.get(p.file);
      if (h && h.body && (!run.length || Math.abs(p.t1 - run[0].t0) < 0.01)) run.unshift(p);
      else if (run.length && p.t0 < run[0].t0) break;
      // else: newer than anything fetched so far, or a second copy of a stretch the run already has
    }
    if (!run.length) {
      this.onStatus(failed ? "RECONNECTING" : this.ended ? "MATCH OVER" : "MATCH STARTING", !failed && this.ended, this);
      return;
    }
    const last = run[run.length - 1];
    const caughtUp = list.every((p) => p.t1 <= last.t1 || this.pieces.has(p.file));   // nothing newer left to fetch
    const key = run[0].file + " " + last.file;
    const due = !this.shown || this.ended || this.needSoon() || performance.now() - this.lastBuild >= REBUILD_MS;
    if (key !== this.built && due) {
      this.built = key;
      this.lastBuild = performance.now();
      const start = Number.isFinite(this.man.start) ? this.man.start : 0;
      await this.onBuild(this.join(run), { match: this.match, title: this.man.title || this.title, start }, this);   // one build at a time
      if (this.stopped) return;
      this.shown = true;
    }
    this.over = this.shown && this.ended && caughtUp && this.built === key;
    const paused = !this.ended && performance.now() - this.changedAt > STALE_MS;
    const status = this.over ? "MATCH OVER" : failed && !caughtUp ? "RECONNECTING" : paused ? "LIVE FEED PAUSED" : "LIVE";
    this.onStatus(status, this.over, this);
  }

  // downloads pieces, PARALLEL at a time; one that fails is left for the next check. Returns how many failed.
  async fetchPieces(list) {
    const total = list.reduce((s, p) => s + (p.bytes || 0), 0);
    let next = 0, got = 0, failed = 0;
    const one = async () => {
      while (next < list.length) {
        const p = list[next++];
        try {
          const buf = await getBytes(new URL(p.file, this.manUrl).href);
          if (this.stopped) return;
          if (!buf) throw new Error("HTTP 404");   // dropped from the server since the manifest was written
          const bytes = gunzipSync(new Uint8Array(buf));
          this.pieces.set(p.file, { p, bytes, body: bodyStart(bytes) });
        } catch (err) {
          if (this.stopped) return;
          failed++;
          console.warn("live: piece " + p.file + ":", err);
        }
        got += p.bytes || 0;
        if (!this.shown && total) this.onProgress(got / total, this);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, list.length) }, one));
    return failed;
  }

  // a run of pieces as one recording: the first whole, the rest without their snapshot
  join(run) {
    const parts = run.map((p, k) => {
      const h = this.pieces.get(p.file);
      return k === 0 ? h.bytes : h.bytes.subarray(h.body);
    });
    return new File(parts, (this.match || "live") + ".acmi", { type: "text/plain" });
  }
}

// a request with a time limit (one that hangs has failed); null for a file that isn't there
async function get(url, cache, read) {
  let timer = 0, signal;
  if (typeof AbortSignal.timeout === "function") signal = AbortSignal.timeout(TIMEOUT_MS);
  else { const c = new AbortController(); timer = setTimeout(() => c.abort(), TIMEOUT_MS); signal = c.signal; }
  try {
    const r = await fetch(url, { cache, signal });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await read(r);
  } finally { clearTimeout(timer); }
}
const getJSON = (url) => get(url, "no-store", (r) => r.json());
const getBytes = (url) => get(url, "force-cache", (r) => r.arrayBuffer());

// where the recording itself starts in a piece: just after its "// nov-keyframe-end" line (0 if it has none)
function bodyStart(b) {
  const m = MARK, n = m.length;
  outer: for (let i = 0; i + n <= b.length; i++) {
    for (let k = 0; k < n; k++) if (b[i + k] !== m[k]) continue outer;
    return i + n;
  }
  return 0;
}
