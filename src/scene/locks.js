// Lock lines: a line from a unit to each target in its recorded lock list (LOCK/S in its panel), apart from the side
// colours (Tomo, 10-22). Two kinds, each a toggle: green is what a unit has locked ("we need to see what units have
// locked onto (green)", 10-26), and red is a radar lock (Tomo, 10-27: "if someone has a lock on you and radar on the
// line goes red ... the green line changes to a red line"): from the recorder's RadarLockedBy where the recording has
// it, the radars giving an aircraft the game's red warning, a SAM's or a ship's included (they have no lock list, so
// they get red lines of their own); else a lock whose unit's radar list has the target too. For a missile the lock is
// the target it's guiding to. For an aircraft it is the recorder's LockedTarget list, which is a player's picked targets or an AI's planned shots, not a
// radar lock (Game expert, 2026-10-20), and older recordings only hold it when two or more are picked.
//
// Both are dashed, the dash as long as the gap, counted on screen from the same end of the line, and red sits in green's
// gaps: two units locked on each other, one with radar and one without, draw one line, green and red in turn (Tomo,
// 10-26: "dashed in the opposite so the lines merge perfectly"). Red sits where the radar lines' dashes do, so a radar
// line under a radar lock turns red, as the game's warning does.
//
// Drawn over everything (no depth test), so a line to a target behind a hill still shows.

import { LineBatch, inFront } from "./fatlines.js";
import { holds, changeAt, meant } from "./detects.js";

const DASH = 10;   // CSS pixels on, then off
const LOCKING = { color: "#00ff00", dash: DASH, gap: DASH, order: 6, opacity: 0.9 };                // a unit's lock
const LOCKED = { color: "#ff3b30", dash: DASH, gap: DASH, phase: DASH, order: 6, opacity: 0.9 };   // a lock with radar on

// every target in unit i's recorded lock list at time t, as record indices (one per slot, so a target can be there
// twice). byId maps a recorded id to its records (ids are reused after a unit is removed).
export function lockedTargets(rp, i, t, byId, out = []) {
  out.length = 0;
  const L = rp.locks, n = L.count[i];
  if (!n) return out;
  const a = L.start[i];
  // the last change at or before t, then back from there until every slot it ever uses has its latest value
  let lo = a, hi = a + n;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (L.t[mid] <= t) lo = mid + 1; else hi = mid; }
  let want = 0;
  for (let q = a; q < a + n; q++) want |= 1 << L.slot[q];
  let seen = 0;
  for (let q = lo - 1; q >= a && seen !== want; q--) {
    const bit = 1 << L.slot[q];
    if (seen & bit) continue;
    seen |= bit;
    const id = L.target[q];
    if (!id) continue;
    for (const r of byId.get(id) || []) if (rp.alive(r, t)) { out.push(r); break; }
  }
  return out;
}

// records by their recorded id, made once per replay (the lock, radar and passive lines share it)
export function recordsById(rp) {
  if (rp.byId) return rp.byId;
  const byId = new Map();
  for (let r = 0; r < rp.count; r++) {
    const id = rp.o.id[r];
    const list = byId.get(id);
    if (list) list.push(r); else byId.set(id, [r]);
  }
  return (rp.byId = byId);
}

// a radar lock blinks off and back on now and then (a quarter of the warnings that drop come back within 4 s, Public
// builds and releases, 10-27), so a red one is held this long
const HOLD = 4;

export class LockLines {
  constructor(scene) {
    this.a = new Float64Array(7); this.b = new Float64Array(7);
    this.ends = new Float64Array(6);
    this.targets = [];
    this.emitters = [];
    this.pairs = new Set();   // this frame's lines, as i * count + j
    this.width = 1;   // CSS pixels (the line width setting)
    this.green = new LineBatch(scene, LOCKING);
    this.red = new LineBatch(scene, LOCKED);
  }

  setReplay(rp) {
    this.rp = rp;
    this.byId = recordsById(rp);
    this.holders = [];   // records with a lock list at all
    this.lockedBy = [];  // aircraft with a RadarLockedBy list at all
    for (let i = 0; i < rp.count; i++) {
      if (rp.locks.count[i]) this.holders.push(i);
      if (rp.radarLockedBy.count[i]) this.lockedBy.push(i);
    }
    // A recording with RadarLockedBy says which radars lock whom, as the game warns (recorder 26a867efbafa, Tomo 10-27:
    // "fix that in the recorder then so it works properly"). Without it, a lock is red when the unit's own radar list
    // has the target too.
    this.fromRecorder = this.lockedBy.length > 0;
    const cap = Math.max(64, Math.min(4096, (this.holders.length + this.lockedBy.length) * 2));
    for (const s of [this.green, this.red]) s.reserve(cap);
  }

  // whether unit i has a radar lock on unit j at t
  radarLock(i, j, t) {
    const rp = this.rp;
    if (!this.fromRecorder) return holds(rp, rp.radarDetects, i, j, t, this.byId);
    return this.lockersOf(j, t).includes(i);
  }

  // the radars with a lock on aircraft j at t, held HOLD s (records, there at t)
  lockersOf(j, t, out = this.emitters) {
    out.length = 0;
    const rp = this.rp, g = rp.radarLockedBy;
    for (let k = changeAt(g, j, t); k >= g.start[j]; k--) {
      for (let q = g.at[k], end = q + g.n[k]; q < end; q++) {
        const recs = this.byId.get(g.ids[q]);
        if (recs) for (const r of recs) if (rp.alive(r, t) && meant(rp, recs, r, g.t[k])) { if (!out.includes(r)) out.push(r); break; }
      }
      if (g.t[k] <= t - HOLD) break;   // the list in force HOLD s ago, and every one since
    }
    return out;
  }

  // mode: "selected" (what the selected unit has locked, and what has locked it), "all" or "off"; locking and locked:
  // whether the green (no radar lock) and the red (radar lock) lines are on; viewer for the camera and the screen
  update(t, mode, selected, viewer, locking = true, locked = true) {
    if (!this.rp) return;
    const rp = this.rp, N = rp.count;
    this.cam = viewer.camera;
    this.pairs.clear();
    for (const s of [this.green, this.red]) s.begin();
    // only: just the line to that record (what has locked the selected unit), or -1 for all of them
    const draw = (i, only) => {
      if (!rp.alive(i, t)) return;
      const targets = lockedTargets(rp, i, t, this.byId, this.targets);
      if (!targets.length || (only >= 0 && !targets.includes(only)) || !rp.poseAt(i, t, this.a)) return;
      for (const j of targets) {
        if ((only >= 0 && j !== only) || !rp.poseAt(j, t, this.b)) continue;
        this.pairs.add(i * N + j);
        const s = this.radarLock(i, j, t) ? (locked ? this.red : null) : locking ? this.green : null;
        if (s) this.put(s, i, j);
      }
    };
    // and the radar locks with no lock list behind them (a SAM's, a ship's): red lines of their own
    const radar = (j, only) => {
      if (!locked || !this.fromRecorder || !rp.alive(j, t)) return;
      for (const i of this.lockersOf(j, t)) {
        if ((only >= 0 && i !== only) || this.pairs.has(i * N + j)) continue;
        if (rp.poseAt(i, t, this.a) && rp.poseAt(j, t, this.b)) { this.pairs.add(i * N + j); this.put(this.red, i, j); }
      }
    };
    if (mode === "all") {
      for (const i of this.holders) draw(i, -1);
      for (const j of this.lockedBy) radar(j, -1);
    } else if (mode === "selected" && selected >= 0 && (locking || locked)) {
      if (rp.locks.count[selected]) draw(selected, -1);
      for (const i of this.holders) if (i !== selected) draw(i, selected);
      if (rp.radarLockedBy.count[selected]) radar(selected, -1);
      for (const j of this.lockedBy) if (j !== selected) radar(j, selected);
    }
    for (const s of [this.green, this.red]) s.end(viewer, this.width);
  }

  // one segment into batch s, from unit i (at this.a) to unit j (at this.b)
  put(s, i, j) {
    const E = this.ends, a = this.a, b = this.b;
    E[0] = a[0]; E[1] = a[1]; E[2] = a[2]; E[3] = b[0]; E[4] = b[1]; E[5] = b[2];
    // the dashes count from the end with the lower record, whichever unit has the lock, so a lock each way lines up;
    // from the other end when that one is behind the camera
    let p = i < j ? 0 : 3;
    if (!inFront(this.cam, E, p)) p = 3 - p;
    s.add(E, 0, E, 3, E, p);
  }
}
