// Every unit alive at the current time, drawn in side colours.
//
// One instanced mesh per model (or per stand-in shape for units without a model), sized once for the busiest moment
// of the replay and refilled each frame from the replay's evaluated state, so the picture is always a pure function
// of the playhead. Gun rounds are tracer streaks (a bright head and a fading tail along their path); flares are
// point sprites; explosions are listed for Blasts (this.booms) to draw. In "focus" (the default) every unit keeps a
// minimum size on screen, so a jet 50 km away is still a readable shape rather than a lost pixel; with focus off
// (the "real size" setting) everything is drawn at its true size, like Tacview.
//
// Each frame also leaves a list of what was drawn (this.live) for picking, labels and trails to reuse.

import * as THREE from "three";
import { KIND } from "../parser/acmi.js";

const D2R = Math.PI / 180;

export const SIDE = {
  Boscali: new THREE.Color("#a76bff"),   // BDF, lavender (the game's faction colour)
  Primeva: new THREE.Color("#ffb800"),   // PALA, yellow
  neutral: new THREE.Color("#808080"),   // the game's neutral map icon grey
};
// the game's colours for a selected unit in spectator mode (Faction.selectedColor)
export const SELECTED = {
  Boscali: new THREE.Color("#00ffff"),
  Primeva: new THREE.Color("#ff0000"),
  neutral: new THREE.Color("#ffffff"),
};

// real length in metres (stand-ins only) and minimum on-screen length in pixels, per kind. With ref, the kind keeps its
// order of size when far away: a ship ref metres long is kept minPx long, and another by the square root of how much
// longer or shorter it is (a 30 m patrol boat 0.6 of a corvette, a 162 m destroyer 1.4, a 267 m carrier 1.8). Grown by
// one amount for all, a ship's bulk went with the square of its length: a destroyer and a carrier in formation became
// one huge shape next to tiny corvettes (Tomo, 10-22: "the dynamo is huge and exponentially bigger than the shard").
const LOOK = {
  [KIND.PLANE]: { len: 16, minPx: 24 },
  [KIND.HELI]: { len: 15, minPx: 22 },
  [KIND.MISSILE]: { len: 4, minPx: 10 },
  [KIND.BOMB]: { len: 3, minPx: 8 },
  [KIND.SHELL]: { len: 1.5, minPx: 5 },
  [KIND.SHIP]: { len: 120, minPx: 20, ref: 80 },   // a 77 m corvette about 20 px long when far away
  [KIND.GROUND]: { len: 8, minPx: 10 },
  [KIND.BUILDING]: { len: 14, minPx: 6 },
};
const MESH_KINDS = [KIND.PLANE, KIND.HELI, KIND.MISSILE, KIND.BOMB, KIND.SHELL, KIND.SHIP, KIND.GROUND, KIND.BUILDING];
const POINT_KINDS = [KIND.ROUND, KIND.FLARE];
export const isMeshKind = (k) => LOOK[k] !== undefined;

// ---- stand-in shapes, all 1 m long, nose to -z, right to +x, up +y ----------------------------------------
function tris(list) {
  const pos = new Float32Array(list.flat());
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}
function planeShape() {
  const N = [0, 0, -0.5], S = [0, 0.06, 0.1], B = [0, -0.05, 0.1], L = [-0.07, 0, 0.05], R = [0.07, 0, 0.05], T = [0, 0.02, 0.5];
  const wl = [-0.48, 0, 0.22], wr = [0.48, 0, 0.22], wf = [0, 0, -0.18], wb = [0, 0, 0.3];
  const fin = [0, 0.26, 0.48], fb = [0, 0.02, 0.5], ff = [0, 0.02, 0.24];
  const tl = [-0.2, 0.01, 0.5], tr = [0.2, 0.01, 0.5], tc = [0, 0.01, 0.36];
  return tris([N, S, L, N, R, S, N, L, B, N, B, R, T, L, S, T, S, R, T, B, L, T, R, B,
    wf, wl, wb, wf, wb, wr, wf, wb, wl, wf, wr, wb,
    ff, fin, fb, ff, fb, fin, tc, tl, tr, tc, tr, tl]);
}
function heliShape() {
  const g = new THREE.CapsuleGeometry(0.12, 0.42, 2, 6).rotateX(Math.PI / 2);
  const tail = new THREE.CylinderGeometry(0.02, 0.04, 0.45, 5).rotateX(Math.PI / 2).translate(0, 0.04, 0.42);
  const rotor = new THREE.CylinderGeometry(0.46, 0.46, 0.01, 16).translate(0, 0.17, 0);
  return mergeAll([g, tail, rotor]);
}
function missileShape() { return new THREE.CylinderGeometry(0.06, 0.06, 1, 6).rotateX(Math.PI / 2); }
function bombShape() { return new THREE.CapsuleGeometry(0.12, 0.7, 2, 6).rotateX(Math.PI / 2); }
function shipShape() {
  const hull = new THREE.BoxGeometry(0.16, 0.06, 0.9).translate(0, 0.03, 0.05);
  const bow = new THREE.ConeGeometry(0.08, 0.15, 4).rotateX(-Math.PI / 2).rotateZ(Math.PI / 4).translate(0, 0.03, -0.47);
  const deck = new THREE.BoxGeometry(0.07, 0.07, 0.18).translate(0, 0.09, 0.08);
  return mergeAll([hull, bow, deck]);
}
function groundShape() { return new THREE.BoxGeometry(0.45, 0.32, 1).translate(0, 0.16, 0); }
function buildingShape() { return new THREE.BoxGeometry(1, 0.7, 1).translate(0, 0.35, 0); }

function mergeAll(geos) {
  const parts = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  let n = 0;
  for (const p of parts) n += p.attributes.position.count;
  const pos = new Float32Array(n * 3);
  let o = 0;
  for (const p of parts) { pos.set(p.attributes.position.array, o); o += p.attributes.position.array.length; }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

const STAND_INS = {
  [KIND.PLANE]: planeShape, [KIND.HELI]: heliShape, [KIND.MISSILE]: missileShape, [KIND.BOMB]: bombShape,
  [KIND.SHELL]: missileShape, [KIND.SHIP]: shipShape, [KIND.GROUND]: groundShape, [KIND.BUILDING]: buildingShape,
};

export class Units {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.shapes = [];        // { geometry, len (metres, models only), model: bool, kind, mesh }
    this.points = null;
    this.state = new Float64Array(7);
    this.tail = new Float64Array(7);
    this.surfaceAt = null;   // (x, sceneZ) -> drawn ground height; ground units are lifted onto it
    this.selected = -1;      // record index drawn in the selected colour
    this.focus = true;       // keep a minimum size on screen (false = real size)
    this.modelsOn = true;    // the detailed models (false = the simple shapes, lighter on a slow PC)
    this.effects = true;     // gun round tracers and flares (the effects setting)
    this.modelSet = null;    // the models found for this replay, kept so they can be switched back on
    this.live = null;        // what the last frame drew: { n, idx, x, y, z, size, kind }
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3(); this._s = new THREE.Vector3();
    this.standIn = new Map();
    for (const k of MESH_KINDS) this.standIn.set(k, STAND_INS[k]());
  }

  // size the buffers for this replay's busiest moment; units start as stand-in shapes
  setReplay(replay) {
    this.replay = replay;
    this.selected = -1;
    this.modelSet = null;
    this.clearMeshes();
    if (this.points) { this.group.remove(this.points); this.points.geometry.dispose(); this.points.material.dispose(); }
    if (this.tracers) { this.group.remove(this.tracers); this.tracers.geometry.dispose(); this.tracers.material.dispose(); }
    const o = replay.o, N = replay.count;
    // one stand-in shape per kind
    this.shapes = [];
    const kindShape = new Map();
    for (const k of MESH_KINDS) { kindShape.set(k, this.shapes.length); this.shapes.push({ geometry: this.standIn.get(k), len: 1, model: false, kind: k, mesh: null }); }
    this.kindShape = kindShape;
    this.drawKey = new Int32Array(N).fill(-1);
    this.useStandIns();
    this.buildMeshes();

    let cap = 8;
    for (const k of POINT_KINDS) cap += replay.maxAlive[k];
    this.pointCap = cap;
    this.booms = new Int32Array(replay.maxAlive[KIND.EXPLOSION] + 8);   // explosions alive this frame, for Blasts
    this.nBooms = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    this.points = new THREE.Points(g, new THREE.PointsMaterial({ size: 3, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false }));
    this.points.frustumCulled = false;
    this.group.add(this.points);
    // gun rounds: one line segment each, from where the round was TRACER_S ago to where it is
    const tcap = replay.maxAlive[KIND.ROUND] + 8;
    this.tracerCap = tcap;
    const tg = new THREE.BufferGeometry();
    tg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(tcap * 6), 3).setUsage(THREE.DynamicDrawUsage));
    const tc = new Float32Array(tcap * 8);
    for (let k = 0; k < tcap; k++) tc.set([TRACER.r, TRACER.g, TRACER.b, 0, TRACER.r, TRACER.g, TRACER.b, 1], k * 8);   // tail clear, head solid
    tg.setAttribute("color", new THREE.BufferAttribute(tc, 4));
    tg.setDrawRange(0, 0);
    this.tracers = new THREE.LineSegments(tg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
    this.tracers.frustumCulled = false;
    this.tracers.renderOrder = 3;
    this.group.add(this.tracers);
    this.colorOf = new Array(N);
    this.selColorOf = new Array(N);
    for (let i = 0; i < N; i++) {
      const side = o.coalition[i];
      this.colorOf[i] = SIDE[side] || SIDE.neutral;
      this.selColorOf[i] = SELECTED[side] || SELECTED.neutral;
    }
    this.sideMoves = new Uint8Array(N);   // units whose side changes during the mission get coloured per frame
    for (const i of replay.sideLog.keys()) this.sideMoves[i] = 1;
    let liveCap = 8;
    for (const k of MESH_KINDS) liveCap += replay.maxAlive[k];
    this.live = { n: 0, idx: new Int32Array(liveCap), x: new Float32Array(liveCap), y: new Float32Array(liveCap),
      z: new Float32Array(liveCap), size: new Float32Array(liveCap), kind: new Uint8Array(liveCap) };
  }

  // every unit drawn as its kind's simple shape
  useStandIns() {
    const o = this.replay.o, key = this.drawKey, ks = this.kindShape;
    let changed = false;
    for (let i = 0; i < this.replay.count; i++) {
      const s = ks.get(o.kind[i]);
      const v = s === undefined ? -1 : s;
      if (key[i] !== v) { key[i] = v; changed = true; }
    }
    return changed;
  }

  // the detailed models on or off; off draws the simple shapes, which is lighter on a slow graphics chip
  setModelsOn(on) {
    this.modelsOn = on;
    if (!this.replay) return;
    if (on) { if (this.modelSet) this.setModels(this.replay, this.modelSet); return; }
    if (this.useStandIns()) { this.clearMeshes(); this.buildMeshes(); }
  }

  // Swap in real models: models = Map(recordedName -> { id, geometry, len }). Units whose Name has one use it.
  setModels(replay, models) {
    if (replay !== this.replay || !models.size) return;
    this.modelSet = models;
    if (!this.modelsOn) return;
    const o = replay.o;
    const byId = new Map();
    let changed = false;
    for (let i = 0; i < replay.count; i++) {
      if (!isMeshKind(o.kind[i])) continue;
      const m = models.get(o.name[i]);
      if (!m) continue;
      let s = byId.get(m.id);
      if (s === undefined) {
        s = this.shapes.findIndex((x) => x.model && x.id === m.id);
        if (s < 0) { s = this.shapes.length; this.shapes.push({ geometry: m.geometry, len: m.len, model: true, id: m.id, kind: o.kind[i], mesh: null }); }
        byId.set(m.id, s);
      }
      if (this.drawKey[i] !== s) { this.drawKey[i] = s; changed = true; }
    }
    if (changed) { this.clearMeshes(); this.buildMeshes(); }
  }

  clearMeshes() {
    for (const s of this.shapes) {
      if (!s.mesh) continue;
      this.group.remove(s.mesh);
      s.mesh.material.dispose();
      s.mesh.dispose();
      s.mesh = null;
    }
  }

  // one instanced mesh per shape, sized for that shape's busiest moment
  buildMeshes() {
    const rp = this.replay, o = rp.o;
    const peak = peakByKey(rp, this.drawKey, this.shapes.length);
    this.shapes.forEach((s, k) => {
      if (!peak[k]) return;
      const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: s.model, flatShading: !s.model });
      const mesh = new THREE.InstancedMesh(s.geometry, mat, peak[k] + 4);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array((peak[k] + 4) * 3), 3);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.name = s.model ? "model:" + s.id : "standin:" + s.kind;
      s.mesh = mesh;
      this.group.add(mesh);
    });
    void o;
  }

  // refill every instance for time t; camera + viewport height set the minimum on-screen sizes
  update(t, camera, viewportH) {
    const rp = this.replay;
    if (!rp) return;
    const o = rp.o, st = this.state, shapes = this.shapes, key = this.drawKey;
    const counts = new Int32Array(shapes.length);
    const pxPerRad = viewportH / (2 * Math.tan((camera.fov * D2R) / 2));
    const cam = camera.position;
    const pts = this.points.geometry, pp = pts.attributes.position.array, pc = pts.attributes.color.array;
    let np = 0;
    const m = this._m, q = this._q, p = this._p, s = this._s;
    const surface = this.surfaceAt, cap = this.pointCap, live = this.live, sel = this.selected;
    const tr = this.tracers.geometry, tp = tr.attributes.position.array, tcap = this.tracerCap, tail = this.tail;
    let nt = 0;
    const booms = this.booms;
    this.nBooms = 0;
    live.n = 0;

    rp.forEachAlive(t, (i) => {
      const k = o.kind[i];
      if (!rp.poseAt(i, t, st)) return;
      if ((k === KIND.GROUND || k === KIND.BUILDING || k === KIND.SHIP) && !rp.visibleAt(i, t)) return; // destroyed
      if (k === KIND.EXPLOSION) { if (this.nBooms < booms.length) booms[this.nBooms++] = i; return; }
      if (!this.effects && (k === KIND.ROUND || k === KIND.FLARE)) return;
      if (k === KIND.ROUND) {
        if (nt < tcap && rp.poseAt(i, Math.max(o.t0[i], t - TRACER_S), tail)) {
          const b = nt * 6;
          tp[b] = tail[0]; tp[b + 1] = tail[1]; tp[b + 2] = tail[2]; tp[b + 3] = st[0]; tp[b + 4] = st[1]; tp[b + 5] = st[2];
          nt++;
        }
      }
      if (k === KIND.ROUND || k === KIND.FLARE || k === KIND.EXPLOSION) {
        if (np >= cap) return;
        const c = k === KIND.ROUND ? ROUND_COL : FLARE_COL;
        pp[np * 3] = st[0]; pp[np * 3 + 1] = st[1]; pp[np * 3 + 2] = st[2];
        pc[np * 3] = c.r; pc[np * 3 + 1] = c.g; pc[np * 3 + 2] = c.b;
        np++;
        return;
      }
      const sk = key[i];
      if (sk < 0) return;
      const shape = shapes[sk], mesh = shape.mesh;
      if (!mesh || counts[sk] >= mesh.instanceMatrix.count) return;
      // Until the detailed terrain lands, the far terrain mesh can sit a few metres above a vehicle on a hillside;
      // lift ground units and buildings onto the ground as drawn so they never vanish inside it.
      let y = st[1];
      if (surface && (k === KIND.GROUND || k === KIND.BUILDING)) y = Math.max(y, surface(st[0], st[2]));
      const look = LOOK[k];
      const dx = st[0] - cam.x, dy = y - cam.y, dz = st[2] - cam.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const minLen = this.focus ? (look.minPx * dist) / pxPerRad : 0;
      // stand-ins are 1 m long and scale to their kind's length; models are real size and only grow when far away
      // buildings keep their real size: grown to a minimum, a cluster of oil rig parts became a giant star
      let scale;
      if (look.ref) {                                    // in order of size, the differences squeezed (see LOOK)
        const len = shape.model ? shape.len : look.len;
        const grow = Math.max(1, (minLen * Math.sqrt(len / look.ref)) / len);
        scale = shape.model ? grow : look.len * grow;
      } else scale = shape.model ? (k === KIND.BUILDING ? 1 : Math.max(1, minLen / shape.len)) : Math.max(look.len, minLen);
      const drawnLen = shape.model ? shape.len * scale : scale;
      q.set(st[3], st[4], st[5], st[6]);
      p.set(st[0], y, st[2]);
      s.set(scale, scale, scale);
      m.compose(p, q, s);
      const n = counts[sk]++;
      mesh.setMatrixAt(n, m);
      if (this.sideMoves[i]) {
        const side = rp.sideAt(i, t);
        mesh.setColorAt(n, i === sel ? SELECTED[side] || SELECTED.neutral : SIDE[side] || SIDE.neutral);
      } else mesh.setColorAt(n, i === sel ? this.selColorOf[i] : this.colorOf[i]);
      if (live.n < live.idx.length) {
        const j = live.n++;
        live.idx[j] = i; live.x[j] = st[0]; live.y[j] = y; live.z[j] = st[2]; live.size[j] = drawnLen; live.kind[j] = k;
      }
    });

    shapes.forEach((sh, k) => {
      if (!sh.mesh) return;
      sh.mesh.count = counts[k];
      sh.mesh.instanceMatrix.needsUpdate = true;
      sh.mesh.instanceColor.needsUpdate = true;
    });
    pts.setDrawRange(0, np);
    tr.setDrawRange(0, nt * 2);
    tr.attributes.position.needsUpdate = true;
    pts.attributes.position.needsUpdate = true;
    pts.attributes.color.needsUpdate = true;
  }
}

// most units alive at once per draw key (one sweep over start and end times)
function peakByKey(rp, drawKey, nKeys) {
  const o = rp.o, ev = [];
  for (let i = 0; i < rp.count; i++) {
    const k = drawKey[i];
    if (k < 0 || !o.sampleCount[i]) continue;
    ev.push([o.t0[i], 1, k], [o.t1[i], -1, k]);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cur = new Int32Array(nKeys), max = new Int32Array(nKeys);
  for (const [, d, k] of ev) { cur[k] += d; if (cur[k] > max[k]) max[k] = cur[k]; }
  return max;
}

const ROUND_COL = new THREE.Color("#fff2b0");
const TRACER = new THREE.Color("#ffc23a");
const TRACER_S = 0.15;   // seconds of a round's flight shown as its tracer streak (about 100 to 150 m)
const FLARE_COL = new THREE.Color("#ffffff");
