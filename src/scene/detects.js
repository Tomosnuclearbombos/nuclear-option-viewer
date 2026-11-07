// Radar, sight and passive lines, from what the recorder says each unit's sensors have (agreed 10-25 for the next
// NOBlackBox build, sight 10-26):
//  - radar lines, lemon yellow: a radar to each aircraft and missile it sees (RadarDetects, its last full scan);
//  - sight lines, light blue: a unit to each enemy it sees by eye and not by radar (SightDetects, its last full scan);
//  - passive lines, light grey: an aircraft's passive receiver to each radar that pinged it in the last 4 s
//    (PassiveTracks).
// Tomo's colours (10-26): "grey for passive, yellow for detected, red for locked (plane or missile) and then sight lines
// can be orange", then sight the game's light blue (Tomo, 10-26: "In game the visual range is a lighter blue circle"; the
// map's range circle is Color.cyan, MapToolTip). The yellow is a lemon yellow, well apart from PALA's amber (#FFB800, its
// trails and labels). All three have the lock lines' dash, set in the green lock dashes' gaps, so a lock and a detection
// on the same two units show both (Tomo, 10-27: "make them the same kind of dash, that way those lines are thicker").
// With the rules below, two kinds of detection line on the same two units are rare (70 in about 100,000 over the S2
// match of 10-26), and then the one drawn last shows: radar over passive over sight. Sight lines come in thick bundles
// (every ground unit near a front), so they are drawn under the others. Where a radar line goes to a unit, no
// sight lines go to it: radar comes first (Tomo, 10-26: "a unit that has seen and detected by radar should just show
// the radar line"). And no passive line goes back along a radar line: a jet that radar has detected is no longer just
// hearing it, as the game's own warning lines turn from grey to yellow (Tomo, 10-27: "no grey when there is yellow is
// correct"). Each is a setting: SELECTED, ALL or OFF. SELECTED follows the colour key (Tomo, 11-07): radar and optical
// are what can see the selected unit (enemies only), passive is the radars the selected unit hears. Every line joins a
// BDF unit and a PALA unit: the recorder's lists also hold neutral scenery and teammates, which give nobody away.
//
// Drawn over everything (no depth test), like the lock lines. A wreck that stays in the recording (a destroyed radar
// station, Visible=0) has none.

import { recordsById } from "./locks.js";
import { LineBatch, inFront } from "./fatlines.js";

// each kind's look: colour, dash, gap and phase (CSS pixels, measured on screen so they read the same at any zoom) and
// draw order (over the explosions, under the lock lines)
const DASH = 10;   // as the lock lines (src/scene/locks.js), a dash along so they sit in green's gaps
export const RADAR = { color: "#fff23a", dash: DASH, gap: DASH, phase: DASH, order: 5 };     // a radar to what it sees
export const SIGHT = { color: "#00ffff", dash: DASH, gap: DASH, phase: DASH, order: 4.5 };   // a unit to what it sees by eye
export const PASSIVE = { color: "#8a9096", dash: DASH, gap: DASH, phase: DASH, order: 4.8 }; // a receiver to the radars it hears

// whether unit i is there at t: in the recording and not a wreck
function there(rp, i, t) { return rp.alive(i, t) && rp.visibleAt(i, t); }

// whether record r is the unit its id meant in a list written at tc (recs: the records with that id): r was there then,
// or no unit had the id then (its first line came after the list). Ids are reused after a unit is removed.
export function meant(rp, recs, r, tc) {
  if (rp.o.t0[r] <= tc) return true;
  for (const q of recs) if (rp.alive(q, tc)) return false;
  return true;
}

// the change of series g (rp.radarDetects, rp.sightDetects or rp.passiveTracks) in force for record i at t, or -1 if
// none yet
export function changeAt(g, i, t) {
  const n = g.count[i];
  if (!n) return -1;
  const a = g.start[i];
  let lo = a, hi = a + n;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (g.t[mid] <= t) lo = mid + 1; else hi = mid; }
  return lo - 1 >= a ? lo - 1 : -1;
}

// whether unit h's list in series g has unit j at t (j being there at t)
export function holds(rp, g, h, j, t, byId) {
  const k = changeAt(g, h, t);
  if (k < 0) return false;
  const id = rp.o.id[j];
  for (let q = g.at[k], end = q + g.n[k]; q < end; q++) if (g.ids[q] === id) return meant(rp, byId.get(id), j, g.t[k]);
  return false;
}

const TEAMS = new Set(["Boscali", "Primeva"]);

export class DetectLines {
  // key: the series drawn, "radarDetects", "sightDetects" or "passiveTracks"; look: RADAR, SIGHT or PASSIVE; enemyOnly:
  // with "selected", only the enemy's lines to the selected unit; under: the lines that come first (the radar lines),
  // updated before these each frame; back: true when a line of under's from j to i hides this one from i to j (passive
  // under radar), else any line of under's to j does (sight under radar)
  constructor(scene, key, look, enemyOnly = false, under = null, back = false) {
    this.key = key;
    this.dashed = !!look.dash;
    this.enemyOnly = enemyOnly;
    this.under = under;
    this.back = back;
    this.pairs = new Set();   // this frame's lines, as i * count + j
    this.frame = 0;
    this.width = 1;   // CSS pixels (the line width setting)
    this.pose = new Float64Array(7);
    // one batch for good: a new one for each replay (each live piece) would compile its shader again
    this.batch = new LineBatch(scene, look);
  }

  get n() { return this.batch.n; }

  setReplay(rp) {
    this.rp = rp;
    this.g = rp[this.key];
    this.byId = recordsById(rp);
    this.holders = [];   // records with a list at all
    for (let i = 0; i < rp.count; i++) if (this.g.count[i]) this.holders.push(i);
    // each unit's place, worked out once a frame however many lines it has (a ship can be in hundreds of sight lists):
    // the time it's for, whether it's there, and where
    this.when = new Float64Array(rp.count).fill(NaN);
    this.here = new Uint8Array(rp.count);
    this.xyz = new Float32Array(rp.count * 3);
    this.hit = new Uint32Array(rp.count);   // the frame each unit last had a line to it (for the lines under these)
    // a bigger buffer from the last replay is kept: a live rebuild would otherwise miss lines for a few frames while it
    // grew back
    this.batch.reserve(Math.max(64, Math.min(4096, this.holders.length * 4)));
  }

  // mode: "selected" (the lines to and from the selected unit), "all" or "off"; viewer for the camera and the screen
  update(t, mode, selected, viewer) {
    if (!this.rp) return;
    const rp = this.rp, g = this.g;
    this.batch.begin();
    this.t = t;
    this.frame++;
    this.pairs.clear();
    this.cam = viewer.camera;
    if (mode === "all") {
      for (const h of this.holders) if (this.spot(h, t)) this.from(h, t);
    } else if (mode === "selected" && selected >= 0 && this.spot(selected, t)) {
      // As the colour key says (Tomo, 11-07: "The blue lines show what can see it, not what it can see"): radar and
      // optical are ENEMY SENSORS, the enemy units whose list has the selected unit; passive is OWN SENSORS, the radars
      // the selected unit itself hears. put() keeps every line between BDF and PALA.
      if (this.enemyOnly) {
        for (const h of this.holders) {
          if (h !== selected && rp.alive(h, t) && holds(rp, g, h, selected, t, this.byId) && this.spot(h, t)) this.put(h, selected);
        }
      } else if (g.count[selected]) this.from(selected, t);
    }
    this.batch.end(viewer, this.width);
  }

  // a line from unit h to each unit in its list at t: each id is the unit it meant when the list was written, and
  // counts only while that unit is still there
  from(h, t) {
    const g = this.g, k = changeAt(g, h, t);
    if (k < 0) return;
    const tc = g.t[k];
    for (let q = g.at[k], end = q + g.n[k]; q < end; q++) {
      const recs = this.byId.get(g.ids[q]);
      if (recs) for (const r of recs) if (this.spot(r, t) && meant(this.rp, recs, r, tc)) { this.put(h, r); break; }
    }
  }

  // whether unit r is there at t, its place then in xyz (from r * 3)
  spot(r, t) {
    if (this.when[r] !== t) {
      this.when[r] = t;
      const p = this.pose, ok = there(this.rp, r, t) && this.rp.poseAt(r, t, p);
      this.here[r] = ok ? 1 : 0;
      if (ok) { const o = r * 3; this.xyz[o] = p[0]; this.xyz[o + 1] = p[1]; this.xyz[o + 2] = p[2]; }
    }
    return this.here[r] === 1;
  }

  // one segment, from unit i to unit j (both spotted this frame), unless the lines under these hide it this frame
  put(i, j) {
    // only between enemies, BDF and PALA: the recorder's lists also hold neutral scenery and teammates a unit sees, and
    // those give nobody away (Tomo, 11-07: "only things that can should show the visual")
    const si = this.rp.sideAt(i, this.t), sj = this.rp.sideAt(j, this.t);
    if (si === sj || !TEAMS.has(si) || !TEAMS.has(sj)) return;
    const u = this.under, N = this.rp.count;
    if (u && u.rp === this.rp && (this.back ? u.pairs.has(j * N + i) : u.hit[j] === u.frame)) return;
    this.hit[j] = this.frame;
    this.pairs.add(i * N + j);
    const P = this.xyz, a = i * 3, b = j * 3;
    // The dashes count from the same end whichever unit's list the line came from, so two units in each other's lists
    // draw one pattern; from the other end when that one is behind the camera.
    let s = i < j ? a : b;
    if (this.dashed && !inFront(this.cam, P, s)) s = s === a ? b : a;
    this.batch.add(P, a, P, b, P, s);
  }
}
