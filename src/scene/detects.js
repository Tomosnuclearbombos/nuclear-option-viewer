// Radar and passive lines, from what the recorder says each unit's sensors have (agreed 10-25 for the next NOBlackBox
// build):
//  - radar lines, solid magenta: a radar to each aircraft and missile it sees (RadarDetects, its last full scan);
//  - passive lines, dashed blue: an aircraft's passive receiver to each radar that pinged it in the last 4 s
//    (PassiveTracks).
// Colours apart from the lock lines (red, white), the side colours and the selection colours (Tomo, 10-25: "a distinct
// colour line different to the active lock colour"). A receiver is pinged by the radar that sees it, so most passive
// lines lie on a radar line: they have a colour of their own and are drawn over the radar lines, or their dashes would
// vanish into it. Each is a setting: SELECTED (the lines to and from the selected unit), ALL or OFF.
//
// Drawn over everything (no depth test), like the lock lines. A wreck that stays in the recording (a destroyed radar
// station, Visible=0) has none.

import * as THREE from "three";
import { recordsById } from "./locks.js";

const MAGENTA = new THREE.Color("#ff3df2");   // a radar to what it sees
const BLUE = new THREE.Color("#3d9bff");      // a passive receiver to the radars it picks up
const DASH = 12, GAP = 8;   // CSS pixels: the dashes are measured on screen, so they read the same at any zoom

// whether unit i is there at t: in the recording and not a wreck
function there(rp, i, t) { return rp.alive(i, t) && rp.visibleAt(i, t); }

// whether record r is the unit its id meant in a list written at tc (recs: the records with that id): r was there then,
// or no unit had the id then (its first line came after the list). Ids are reused after a unit is removed.
function meant(rp, recs, r, tc) {
  if (rp.o.t0[r] <= tc) return true;
  for (const q of recs) if (rp.alive(q, tc)) return false;
  return true;
}

// the change of series g (rp.radarDetects or rp.passiveTracks) in force for record i at t, or -1 if none yet
function changeAt(g, i, t) {
  const n = g.count[i];
  if (!n) return -1;
  const a = g.start[i];
  let lo = a, hi = a + n;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (g.t[mid] <= t) lo = mid + 1; else hi = mid; }
  return lo - 1 >= a ? lo - 1 : -1;
}

// what unit i's list in series g holds at t, as record indices: each id is the unit it meant when the list was written,
// and counts only while that unit is still there
export function detectedAt(rp, g, i, t, byId, out = []) {
  out.length = 0;
  const k = changeAt(g, i, t);
  if (k < 0) return out;
  const tc = g.t[k];
  for (let q = g.at[k], end = q + g.n[k]; q < end; q++) {
    const recs = byId.get(g.ids[q]) || [];
    for (const r of recs) if (there(rp, r, t) && meant(rp, recs, r, tc)) { out.push(r); break; }
  }
  return out;
}

// whether unit h's list in series g has unit j at t (j being there at t)
export function holds(rp, g, h, j, t, byId) {
  const k = changeAt(g, h, t);
  if (k < 0) return false;
  const id = rp.o.id[j];
  for (let q = g.at[k], end = q + g.n[k]; q < end; q++) if (g.ids[q] === id) return meant(rp, byId.get(id), j, g.t[k]);
  return false;
}

// LineDashedMaterial with its dashes counted in pixels on screen from an anchor point (a per vertex attribute, the same
// at both ends of a segment) instead of in metres along the line: a line tens of km long, seen from a camera close to
// one end, would otherwise be one long dash near the camera and a shimmer far away
function screenDashed(opts, view) {
  const m = new THREE.LineDashedMaterial(opts);
  m.onBeforeCompile = (sh) => {
    sh.uniforms.view = view;
    sh.vertexShader = sh.vertexShader
      .replace("attribute float lineDistance;", "attribute vec3 anchor;")
      .replace("varying float vLineDistance;", "varying vec4 vAnchor;")
      .replace("vLineDistance = scale * lineDistance;", "vAnchor = projectionMatrix * modelViewMatrix * vec4( anchor, 1.0 );");
    sh.fragmentShader = sh.fragmentShader
      .replace("varying float vLineDistance;", "varying vec4 vAnchor;\nuniform vec2 view;")
      .replace("if ( mod( vLineDistance, totalSize ) > dashSize ) {",
        "float vLineDistance = distance( gl_FragCoord.xy, ( vAnchor.xy / vAnchor.w * 0.5 + 0.5 ) * view );\n\tif ( mod( vLineDistance, totalSize ) > dashSize ) {");
  };
  m.customProgramCacheKey = () => "nov-screen-dash";
  return m;
}

export class DetectLines {
  // key: the series drawn, "radarDetects" (solid) or "passiveTracks"; dashed: drawn dashed; seenOnly: with "selected",
  // only the lines to the selected unit, from what detects it, not its own list (Tomo, 10-26: "selected unit only
  // (show only what that unit is being detected by)")
  constructor(scene, key, dashed, seenOnly = false) {
    this.scene = scene;
    this.key = key;
    this.dashed = dashed;
    this.seenOnly = seenOnly;
    this.cap = 0;
    this.n = 0;
    this.lines = null;
    this.full = false;
    this.a = new Float64Array(7); this.b = new Float64Array(7);
    this.targets = [];
    this.view = { value: new THREE.Vector2(1, 1) };   // the drawing buffer's size, for the dashes
    // one material for good: a new one for each replay (each live piece) would compile its shader again
    const opts = { color: dashed ? BLUE : MAGENTA, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false };
    this.material = dashed ? screenDashed(opts, this.view) : new THREE.LineBasicMaterial(opts);
  }

  setReplay(rp) {
    this.rp = rp;
    this.g = rp[this.key];
    this.byId = recordsById(rp);
    this.holders = [];   // records with a list at all
    for (let i = 0; i < rp.count; i++) if (this.g.count[i]) this.holders.push(i);
    this.grow(Math.max(64, Math.min(4096, this.holders.length * 4)));
  }

  grow(cap) {
    if (this.lines) { this.scene.remove(this.lines); this.lines.geometry.dispose(); }
    this.cap = cap;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(cap * 6), 3).setUsage(THREE.DynamicDrawUsage));
    if (this.dashed) g.setAttribute("anchor", new THREE.BufferAttribute(new Float32Array(cap * 6), 3).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    this.lines = new THREE.LineSegments(g, this.material);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = this.dashed ? 5.5 : 5;   // under the lock lines, the passive lines over the radar lines
    this.scene.add(this.lines);
  }

  // mode: "selected" (the lines to the selected unit, and from it unless seenOnly), "all" or "off"; viewer for the camera
  // and the screen
  update(t, mode, selected, viewer) {
    if (!this.lines) return;
    if (this.full) { this.grow(this.cap * 2); this.full = false; }   // ran out of room last frame
    const rp = this.rp, g = this.g, geo = this.lines.geometry;
    this.n = 0;
    if (this.dashed) {
      const r = viewer.renderer, m = this.lines.material;
      r.getDrawingBufferSize(this.view.value);
      m.dashSize = DASH * r.getPixelRatio();
      m.gapSize = GAP * r.getPixelRatio();
      this.cam = viewer.camera;
    }
    if (mode === "all") {
      for (const h of this.holders) if (there(rp, h, t)) this.from(h, t);
    } else if (mode === "selected" && selected >= 0 && there(rp, selected, t)) {
      if (!this.seenOnly && g.count[selected]) this.from(selected, t);
      // and every unit whose list has it
      if (rp.poseAt(selected, t, this.b)) {
        for (const h of this.holders) {
          if (h !== selected && there(rp, h, t) && holds(rp, g, h, selected, t, this.byId) && rp.poseAt(h, t, this.a)) this.put(h, this.a, selected, this.b);
        }
      }
    }
    geo.setDrawRange(0, this.n * 2);
    geo.attributes.position.needsUpdate = true;
    if (this.dashed) geo.attributes.anchor.needsUpdate = true;
    this.lines.visible = this.n > 0;
  }

  // a line from unit h to each unit in its list
  from(h, t) {
    const targets = detectedAt(this.rp, this.g, h, t, this.byId, this.targets);
    if (!targets.length || !this.rp.poseAt(h, t, this.a)) return;
    for (const r of targets) if (this.rp.poseAt(r, t, this.b)) this.put(h, this.a, r, this.b);
  }

  // one segment, from unit i at pa to unit j at pb
  put(i, pa, j, pb) {
    if (this.n >= this.cap) { this.full = true; return; }
    const geo = this.lines.geometry, p = geo.attributes.position.array, o = this.n * 6;
    p[o] = pa[0]; p[o + 1] = pa[1]; p[o + 2] = pa[2];
    p[o + 3] = pb[0]; p[o + 4] = pb[1]; p[o + 5] = pb[2];
    if (this.dashed) {
      // The dashes count from the same end whichever unit's list the line came from, so two units in each other's
      // lists draw one pattern; from the other end when that one is behind the camera.
      let s = i < j ? pa : pb;
      if (!this.inFront(s)) s = s === pa ? pb : pa;
      const A = geo.attributes.anchor.array;
      A[o] = A[o + 3] = s[0]; A[o + 1] = A[o + 4] = s[1]; A[o + 2] = A[o + 5] = s[2];
    }
    this.n++;
  }

  inFront(p) {
    const e = this.cam.matrixWorldInverse.elements;
    return e[2] * p[0] + e[6] * p[1] + e[10] * p[2] + e[14] < -this.cam.near;
  }
}
