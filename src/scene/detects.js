// Radar, sight and passive lines, from what the recorder says each unit's sensors have (agreed 10-25 for the next
// NOBlackBox build, sight 10-26):
//  - radar lines, solid lemon yellow: a radar to each aircraft and missile it sees (RadarDetects, its last full scan);
//  - sight lines, dotted orange: a unit to each enemy it sees by eye and not by radar (SightDetects, its last full scan);
//  - passive lines, dashed light grey: an aircraft's passive receiver to each radar that pinged it in the last 4 s
//    (PassiveTracks).
// Tomo's colours (10-26): "grey for passive, yellow for detected, red for locked (plane or missile) and then sight lines
// can be orange". The yellow is a lemon yellow and the orange a deep one, both well apart from PALA's amber (#FFB800, its
// trails and labels), and each kind has its own pattern too, so a line reads by colour and pattern. Lines of different
// kinds can lie on each other: a receiver is pinged by the radar that sees it, so the passive lines are drawn over the
// radar lines; sight lines come in thick bundles (every ground unit near a front), so they are drawn under them. Each is
// a setting: SELECTED, ALL or OFF. SELECTED is the enemy units that see the selected unit (radar and sight, as the unit
// panel counts them), or the selected unit's own list and every unit whose list has it (passive).
//
// Drawn over everything (no depth test), like the lock lines. A wreck that stays in the recording (a destroyed radar
// station, Visible=0) has none.

import * as THREE from "three";
import { recordsById } from "./locks.js";

// each kind's look: colour, dash and gap (CSS pixels, measured on screen so they read the same at any zoom; none:
// solid) and draw order (over the explosions, under the lock lines)
export const RADAR = { color: "#fff23a", order: 5 };                        // a radar to what it sees
export const SIGHT = { color: "#ff6a00", dash: 4, gap: 4, order: 4.5 };     // a unit to what it sees by eye
export const PASSIVE = { color: "#d4d8dc", dash: 12, gap: 8, order: 5.5 };  // a receiver to the radars it picks up

// whether unit i is there at t: in the recording and not a wreck
function there(rp, i, t) { return rp.alive(i, t) && rp.visibleAt(i, t); }

// whether record r is the unit its id meant in a list written at tc (recs: the records with that id): r was there then,
// or no unit had the id then (its first line came after the list). Ids are reused after a unit is removed.
function meant(rp, recs, r, tc) {
  if (rp.o.t0[r] <= tc) return true;
  for (const q of recs) if (rp.alive(q, tc)) return false;
  return true;
}

// the change of series g (rp.radarDetects, rp.sightDetects or rp.passiveTracks) in force for record i at t, or -1 if
// none yet
function changeAt(g, i, t) {
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
  // key: the series drawn, "radarDetects", "sightDetects" or "passiveTracks"; look: RADAR, SIGHT or PASSIVE; seenOnly:
  // with "selected", only the lines to the selected unit, from what detects it, not its own list (Tomo, 10-26:
  // "selected unit only (show only what that unit is being detected by)")
  constructor(scene, key, look, seenOnly = false) {
    this.scene = scene;
    this.key = key;
    this.look = look;
    this.dashed = !!look.dash;
    this.seenOnly = seenOnly;
    this.cap = 0;
    this.n = 0;
    this.lines = null;
    this.full = false;
    this.pose = new Float64Array(7);
    this.view = { value: new THREE.Vector2(1, 1) };   // the drawing buffer's size, for the dashes
    // one material for good: a new one for each replay (each live piece) would compile its shader again
    const opts = { color: new THREE.Color(look.color), transparent: true, opacity: 0.85, depthTest: false, depthWrite: false };
    this.material = this.dashed ? screenDashed(opts, this.view) : new THREE.LineBasicMaterial(opts);
  }

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
    // a bigger buffer from the last replay is kept: a live rebuild would otherwise miss lines for a few frames while it
    // grew back
    const cap = Math.max(64, Math.min(4096, this.holders.length * 4));
    if (cap > this.cap) this.grow(cap);
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
    this.lines.renderOrder = this.look.order;
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
      m.dashSize = this.look.dash * r.getPixelRatio();
      m.gapSize = this.look.gap * r.getPixelRatio();
      this.cam = viewer.camera;
    }
    if (mode === "all") {
      for (const h of this.holders) if (this.spot(h, t)) this.from(h, t);
    } else if (mode === "selected" && selected >= 0 && this.spot(selected, t)) {
      if (!this.seenOnly && g.count[selected]) this.from(selected, t);
      // and every unit whose list has it; for what detects it, the enemy only, as the unit panel counts them (a base's
      // building keeps its list for a scan after it changes hands)
      const side = this.seenOnly ? rp.sideAt(selected, t) : null;
      for (const h of this.holders) {
        if (h !== selected && rp.alive(h, t) && holds(rp, g, h, selected, t, this.byId) && (side === null || rp.sideAt(h, t) !== side) && this.spot(h, t)) this.put(h, selected);
      }
    }
    geo.setDrawRange(0, this.n * 2);
    geo.attributes.position.needsUpdate = true;
    if (this.dashed) geo.attributes.anchor.needsUpdate = true;
    this.lines.visible = this.n > 0;
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

  // one segment, from unit i to unit j (both spotted this frame)
  put(i, j) {
    if (this.n >= this.cap) { this.full = true; return; }
    const P = this.xyz, a = i * 3, b = j * 3;
    const geo = this.lines.geometry, p = geo.attributes.position.array, o = this.n * 6;
    p[o] = P[a]; p[o + 1] = P[a + 1]; p[o + 2] = P[a + 2];
    p[o + 3] = P[b]; p[o + 4] = P[b + 1]; p[o + 5] = P[b + 2];
    if (this.dashed) {
      // The dashes count from the same end whichever unit's list the line came from, so two units in each other's
      // lists draw one pattern; from the other end when that one is behind the camera.
      let s = i < j ? a : b;
      if (!this.inFront(s)) s = s === a ? b : a;
      const A = geo.attributes.anchor.array;
      A[o] = A[o + 3] = P[s]; A[o + 1] = A[o + 4] = P[s + 1]; A[o + 2] = A[o + 5] = P[s + 2];
    }
    this.n++;
  }

  // whether the point at xyz[s] is in front of the camera
  inFront(s) {
    const e = this.cam.matrixWorldInverse.elements, P = this.xyz;
    return e[2] * P[s] + e[6] * P[s + 1] + e[10] * P[s + 2] + e[14] < -this.cam.near;
  }
}
