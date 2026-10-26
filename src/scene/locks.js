// Lock lines: a line from a unit to each target in its recorded lock list (LOCK/S in its panel), apart from the side
// colours (Tomo, 10-22). Three kinds, each a toggle (Tomo, 10-26): magenta is what the selected unit has locked ("what
// the target following has locked onto ... should be a different colour"), red is an enemy's lock on the selected unit,
// and green is any other unit's lock on its target. For a missile that is the target it's guiding to. For an aircraft
// it is the recorder's LockedTarget list, which is a player's picked targets or an AI's planned shots, not a
// radar lock (Game expert, 2026-10-20), and older recordings only hold it when two or more are picked.
//
// All are dashed, the dash as long as the gap, counted on screen from the same end of the line, and red sits in the
// others' gaps: the selected unit and an enemy locked on each other draw one line, magenta and red in turn (Tomo, 10-26:
// "dashed in the opposite so the lines merge perfectly").
//
// Drawn over everything (no depth test), so a line to a target behind a hill still shows.

import { LineBatch, inFront } from "./fatlines.js";

const DASH = 10;   // CSS pixels on, then off
const MINE = { color: "#ff40ff", dash: DASH, gap: DASH, order: 6, opacity: 0.9 };                  // the selected unit's lock
const LOCKED = { color: "#ff3b30", dash: DASH, gap: DASH, phase: DASH, order: 6, opacity: 0.9 };   // a lock on it
const LOCKING = { color: "#00ff00", dash: DASH, gap: DASH, order: 6, opacity: 0.9 };                // any other lock

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

export class LockLines {
  constructor(scene) {
    this.a = new Float64Array(7); this.b = new Float64Array(7);
    this.ends = new Float64Array(6);
    this.targets = [];
    this.width = 1;   // CSS pixels (the line width setting)
    this.mine = new LineBatch(scene, MINE);
    this.red = new LineBatch(scene, LOCKED);
    this.green = new LineBatch(scene, LOCKING);
  }

  setReplay(rp) {
    this.rp = rp;
    this.byId = recordsById(rp);
    this.holders = [];   // records with a lock list at all
    for (let i = 0; i < rp.count; i++) if (rp.locks.count[i]) this.holders.push(i);
    const cap = Math.max(64, Math.min(4096, this.holders.length * 2));
    for (const s of [this.mine, this.red, this.green]) s.reserve(cap);
  }

  // mode: "selected" (what the selected unit has locked, and what has locked it), "all" or "off"; mine, enemy and other:
  // whether the magenta, red and green lines are on; viewer for the camera and the screen
  update(t, mode, selected, viewer, mine = true, enemy = true, other = true) {
    if (!this.rp) return;
    const rp = this.rp;
    this.cam = viewer.camera;
    for (const s of [this.mine, this.red, this.green]) s.begin();
    // only: just the line to that record (what has locked the selected unit), or -1 for all of them
    const draw = (i, only) => {
      if (!rp.alive(i, t)) return;
      const targets = lockedTargets(rp, i, t, this.byId, this.targets);
      if (!targets.length || (only >= 0 && !targets.includes(only)) || !rp.poseAt(i, t, this.a)) return;
      for (const j of targets) {
        if ((only >= 0 && j !== only) || !rp.poseAt(j, t, this.b)) continue;
        const s = i === selected ? (mine ? this.mine : null) : j === selected ? (enemy ? this.red : null) : other ? this.green : null;
        if (s) this.put(s, i, j);
      }
    };
    if (mode === "all") for (const i of this.holders) draw(i, -1);
    else if (mode === "selected" && selected >= 0) {
      if (mine && rp.locks.count[selected]) draw(selected, -1);
      if (enemy) for (const i of this.holders) if (i !== selected) draw(i, selected);
    }
    for (const s of [this.mine, this.red, this.green]) s.end(viewer, this.width);
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
