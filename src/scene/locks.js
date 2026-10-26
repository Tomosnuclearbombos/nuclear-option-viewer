// Lock lines: a line from a unit to each target in its recorded lock list (LOCK/S in its panel), apart from the side
// colours (Tomo, 10-22). Green is what a unit has locked; red is what has locked the unit you've picked (Tomo, 10-26:
// "what line shows whether a unit has locked a target? not being locked by a target?"). For a missile that is the
// target it's guiding to. For an
// aircraft it is the recorder's LockedTarget list, which is a player's picked targets or an AI's planned shots, not a
// radar lock (Game expert, 2026-10-20), and older recordings only hold it when two or more are picked.
//
// Both are dashed, the dash as long as the gap, counted on screen from the same end of the line, and red sits in green's
// gaps: two units locked on each other draw one line, green and red in turn (Tomo, 10-26: "dashed in the opposite so
// the lines merge perfectly").
//
// Drawn over everything (no depth test), so a line to a target behind a hill still shows.

import * as THREE from "three";
import { screenDashed } from "./detects.js";

const DASH = 10;                // CSS pixels on, then off
const LOCKING = "#00ff00";      // a unit to what it has locked
const LOCKED = "#ff3b30";       // a unit to the selected unit, which it has locked

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
    this.scene = scene;
    this.a = new Float64Array(7); this.b = new Float64Array(7);
    this.targets = [];
    this.view = { value: new THREE.Vector2(1, 1) };   // the drawing buffer's size, for the dashes
    this.phase = { value: 0 };                          // red's dashes start one dash along
    const opts = (c) => ({ color: new THREE.Color(c), transparent: true, opacity: 0.9, depthTest: false, depthWrite: false });
    this.green = { material: screenDashed(opts(LOCKING), this.view), cap: 0, n: 0, lines: null, full: false };
    this.red = { material: screenDashed(opts(LOCKED), this.view, this.phase), cap: 0, n: 0, lines: null, full: false };
  }

  setReplay(rp) {
    this.rp = rp;
    this.byId = recordsById(rp);
    this.holders = [];   // records with a lock list at all
    for (let i = 0; i < rp.count; i++) if (rp.locks.count[i]) this.holders.push(i);
    const cap = Math.max(64, Math.min(4096, this.holders.length * 2));
    for (const s of [this.green, this.red]) if (cap > s.cap) this.grow(s, cap);
  }

  grow(s, cap) {
    if (s.lines) { this.scene.remove(s.lines); s.lines.geometry.dispose(); }
    s.cap = cap;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(cap * 6), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("anchor", new THREE.BufferAttribute(new Float32Array(cap * 6), 3).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    s.lines = new THREE.LineSegments(g, s.material);
    s.lines.frustumCulled = false;
    s.lines.renderOrder = 6;
    this.scene.add(s.lines);
  }

  // mode: "selected" (what the selected unit has locked, and what has locked it), "all" or "off"; viewer for the camera
  // and the screen
  update(t, mode, selected, viewer) {
    if (!this.green.lines) return;
    const r = viewer.renderer, px = DASH * r.getPixelRatio();
    r.getDrawingBufferSize(this.view.value);
    this.phase.value = px;
    this.cam = viewer.camera;
    for (const s of [this.green, this.red]) {
      if (s.full) { this.grow(s, s.cap * 2); s.full = false; }   // ran out of room last frame
      s.material.dashSize = s.material.gapSize = px;
      s.n = 0;
    }
    const rp = this.rp;
    // only: just the line to that record (what has locked the selected unit), or -1 for all of them
    const draw = (i, only) => {
      if (!rp.alive(i, t)) return;
      const targets = lockedTargets(rp, i, t, this.byId, this.targets);
      if (!targets.length || (only >= 0 && !targets.includes(only)) || !rp.poseAt(i, t, this.a)) return;
      for (const j of targets) {
        if ((only >= 0 && j !== only) || !rp.poseAt(j, t, this.b)) continue;
        this.put(j === selected && i !== selected ? this.red : this.green, i, j);
      }
    };
    if (mode === "all") for (const i of this.holders) draw(i, -1);
    else if (mode === "selected" && selected >= 0) {
      if (rp.locks.count[selected]) draw(selected, -1);
      for (const i of this.holders) if (i !== selected) draw(i, selected);
    }
    for (const s of [this.green, this.red]) {
      const geo = s.lines.geometry;
      geo.setDrawRange(0, s.n * 2);
      geo.attributes.position.needsUpdate = true;
      geo.attributes.anchor.needsUpdate = true;
      s.lines.visible = s.n > 0;
    }
  }

  // one segment into batch s, from unit i (at this.a) to unit j (at this.b)
  put(s, i, j) {
    if (s.n >= s.cap) { s.full = true; return; }
    const a = this.a, b = this.b, o = s.n * 6, geo = s.lines.geometry;
    geo.attributes.position.array.set([a[0], a[1], a[2], b[0], b[1], b[2]], o);
    // the dashes count from the end with the lower record, whichever unit has the lock, so a lock each way lines up;
    // from the other end when that one is behind the camera
    let p = i < j ? a : b;
    if (!this.inFront(p)) p = p === a ? b : a;
    geo.attributes.anchor.array.set([p[0], p[1], p[2], p[0], p[1], p[2]], o);
    s.n++;
  }

  inFront(p) {
    const e = this.cam.matrixWorldInverse.elements;
    return e[2] * p[0] + e[6] * p[1] + e[10] * p[2] + e[14] < -this.cam.near;
  }
}
