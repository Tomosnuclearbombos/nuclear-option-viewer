// Trails behind aircraft and weapons, and "altitude curtains": a see-through ribbon hanging from an aircraft's trail
// down to the ground, which makes climbs, dives and terrain-hugging runs obvious at a glance.
//
// Both are rebuilt every frame from the replay's samples into fixed-size buffers, fading with age. A trail too long
// for its share of the buffer is thinned evenly rather than cut short.

import * as THREE from "three";
import { KIND } from "../parser/acmi.js";
import { SIDE, SELECTED } from "./units.js";

const MAX_SEGS = 60000;        // trail line segments per frame, shared by everything trailed
const MAX_CURTAIN = 30000;     // curtain quads per frame
const TRAIL_S = { [KIND.PLANE]: 90, [KIND.HELI]: 90, [KIND.MISSILE]: 25, [KIND.BOMB]: 25, [KIND.SHIP]: 300 };

export class Trails {
  constructor(scene) {
    this.scene = scene;
    this.showTrails = true;
    this.showCurtains = false;
    this.replay = null;
    this.selected = -1;

    const lg = new THREE.BufferGeometry();
    lg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_SEGS * 6), 3).setUsage(THREE.DynamicDrawUsage));
    lg.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAX_SEGS * 8), 4).setUsage(THREE.DynamicDrawUsage));
    lg.setDrawRange(0, 0);
    this.lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 2;

    const cg = new THREE.BufferGeometry();
    cg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_CURTAIN * 18), 3).setUsage(THREE.DynamicDrawUsage));
    cg.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAX_CURTAIN * 24), 4).setUsage(THREE.DynamicDrawUsage));
    cg.setDrawRange(0, 0);
    this.curtain = new THREE.Mesh(cg, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    this.curtain.frustumCulled = false;
    this.curtain.renderOrder = 1;
    scene.add(this.lines, this.curtain);
  }

  setReplay(rp) { this.replay = rp; this.selected = -1; }

  // live = units.live from the same frame; groundAt(x, z) gives the curtain's bottom
  update(t, live, groundAt) {
    const rp = this.replay;
    const lg = this.lines.geometry, cg = this.curtain.geometry;
    let nl = 0, nc = 0;
    if (rp && live && (this.showTrails || this.showCurtains)) {
      const s = rp.s, o = rp.o;
      const lp = lg.attributes.position.array, lc = lg.attributes.color.array;
      const cp = cg.attributes.position.array, cc = cg.attributes.color.array;
      // who gets a trail: aircraft, weapons, the selected unit (any kind); ships only when selected
      const list = [];
      for (let j = 0; j < live.n; j++) {
        const i = live.idx[j], k = live.kind[j];
        if (i === this.selected || k === KIND.PLANE || k === KIND.HELI || k === KIND.MISSILE || k === KIND.BOMB) list.push(j);
      }
      const segShare = Math.max(8, Math.floor(MAX_SEGS / Math.max(1, list.length)));
      for (const j of list) {
        const i = live.idx[j], k = live.kind[j];
        const sel = i === this.selected;
        const span = (TRAIL_S[k] || 60) * (sel ? 2 : 1);
        const a = o.start[i], end = rp.sampleAt(i, t);      // samples a..end are in the past
        if (end < a) continue;
        // first sample inside the window
        let first = end;
        while (first > a && s.t[first - 1] >= t - span) first--;
        const count = end - first + 1;
        if (count < 1) continue;
        const stride = Math.max(1, Math.ceil(count / segShare));
        const side = rp.sideAt(i, t);
        const col = sel ? SELECTED[side] || SELECTED.neutral : SIDE[side] || SIDE.neutral;
        const weapon = k === KIND.MISSILE || k === KIND.BOMB;
        const alpha = weapon ? 0.55 : 0.8;
        // walk from the unit's current position backwards
        let px = live.x[j], py = live.y[j], pz = live.z[j], pt = t;
        for (let q = end; q >= first; q -= stride) {
          const x = s.x[q], y = s.y[q], z = s.z[q], tq = s.t[q];
          const f0 = 1 - (t - pt) / span, f1 = 1 - (t - tq) / span;   // fade with age
          if (this.showTrails && nl < MAX_SEGS) {
            const b = nl * 6, c = nl * 8;
            lp[b] = px; lp[b + 1] = py; lp[b + 2] = pz; lp[b + 3] = x; lp[b + 4] = y; lp[b + 5] = z;
            lc[c] = col.r; lc[c + 1] = col.g; lc[c + 2] = col.b; lc[c + 3] = alpha * f0;
            lc[c + 4] = col.r; lc[c + 5] = col.g; lc[c + 6] = col.b; lc[c + 7] = alpha * f1;
            nl++;
          }
          if (this.showCurtains && !weapon && nc < MAX_CURTAIN && (k === KIND.PLANE || k === KIND.HELI || sel)) {
            const g0 = Math.max(0, groundAt(px, pz)), g1 = Math.max(0, groundAt(x, z));
            const b = nc * 18, c = nc * 24;
            // two triangles: top0, top1, bottom1 and top0, bottom1, bottom0
            set3(cp, b, px, py, pz); set3(cp, b + 3, x, y, z); set3(cp, b + 6, x, g1, z);
            set3(cp, b + 9, px, py, pz); set3(cp, b + 12, x, g1, z); set3(cp, b + 15, px, g0, pz);
            const at = 0.28 * f0, at1 = 0.28 * f1, ab = 0.04 * f0, ab1 = 0.04 * f1;
            set4(cc, c, col, at); set4(cc, c + 4, col, at1); set4(cc, c + 8, col, ab1);
            set4(cc, c + 12, col, at); set4(cc, c + 16, col, ab1); set4(cc, c + 20, col, ab);
            nc++;
          }
          px = x; py = y; pz = z; pt = tq;
        }
      }
    }
    lg.setDrawRange(0, nl * 2);
    lg.attributes.position.needsUpdate = true; lg.attributes.color.needsUpdate = true;
    cg.setDrawRange(0, nc * 6);
    cg.attributes.position.needsUpdate = true; cg.attributes.color.needsUpdate = true;
  }
}

function set3(a, i, x, y, z) { a[i] = x; a[i + 1] = y; a[i + 2] = z; }
function set4(a, i, c, alpha) { a[i] = c.r; a[i + 1] = c.g; a[i + 2] = c.b; a[i + 3] = alpha; }
