// Lock lines: a line from a unit to each target in its recorded lock list (LOCK/S in its panel), in colours of their
// own, apart from the side colours (Tomo, 10-22): red from a missile or bomb, white from an aircraft. For a missile
// that is the target it's guiding to. For an aircraft it is the recorder's LockedTarget list, which is a player's
// picked targets or an AI's planned shots, not a radar lock (Game expert, 2026-10-20), and older recordings only hold
// it when two or more are picked.
//
// Drawn over everything (no depth test), so a line to a target behind a hill still shows.

import * as THREE from "three";
import { KIND } from "../parser/acmi.js";

const WEAPON = new THREE.Color("#ff3b30");   // a missile or bomb to the target it's flying at
const PICKED = new THREE.Color("#ffffff");   // an aircraft to its targets

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

// records by their recorded id
export function recordsById(rp) {
  const byId = new Map();
  for (let r = 0; r < rp.count; r++) {
    const id = rp.o.id[r];
    const list = byId.get(id);
    if (list) list.push(r); else byId.set(id, [r]);
  }
  return byId;
}

export class LockLines {
  constructor(scene) {
    this.scene = scene;
    this.cap = 0;
    this.lines = null;
    this.a = new Float64Array(7); this.b = new Float64Array(7);
    this.targets = [];
  }

  setReplay(rp) {
    this.rp = rp;
    this.byId = recordsById(rp);
    this.holders = [];   // records with a lock list at all
    for (let i = 0; i < rp.count; i++) if (rp.locks.count[i]) this.holders.push(i);
    this.grow(Math.max(64, Math.min(4096, this.holders.length * 2)));
  }

  grow(cap) {
    if (this.lines) { this.scene.remove(this.lines); this.lines.geometry.dispose(); this.lines.material.dispose(); }
    this.cap = cap;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(cap * 6), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(cap * 6), 3).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false,
    }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 6;
    this.scene.add(this.lines);
  }

  // mode: "selected" (the selected unit's lines only), "all" or "off"
  update(t, mode, selected) {
    if (!this.lines) return;
    if (this.full) { this.grow(this.cap * 2); this.full = false; }   // ran out of room last frame
    const rp = this.rp, geo = this.lines.geometry;
    const pos = geo.attributes.position.array, col = geo.attributes.color.array;
    let n = 0;
    const draw = (i) => {
      if (!rp.alive(i, t) || !rp.poseAt(i, t, this.a)) return;
      const targets = lockedTargets(rp, i, t, this.byId, this.targets);
      if (!targets.length) return;
      const k = rp.o.kind[i], c = k === KIND.MISSILE || k === KIND.BOMB ? WEAPON : PICKED;
      for (const r of targets) {
        if (!rp.poseAt(r, t, this.b)) continue;
        if (n >= this.cap) { this.full = true; return; }
        pos.set([this.a[0], this.a[1], this.a[2], this.b[0], this.b[1], this.b[2]], n * 6);
        col.set([c.r, c.g, c.b, c.r, c.g, c.b], n * 6);
        n++;
      }
    };
    if (mode === "all") for (const i of this.holders) draw(i);
    else if (mode === "selected" && selected >= 0 && rp.locks.count[selected]) draw(selected);
    geo.setDrawRange(0, n * 2);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    this.lines.visible = n > 0;
  }
}
