// Every unit alive at the current time, drawn in side colours.
//
// One instanced mesh per kind (planes, helicopters, missiles, ...) sized once for the busiest moment of the replay,
// refilled each frame from the replay's evaluated state, so the picture is always a pure function of the playhead.
// Gun rounds, flares and explosions are point sprites. Every shape keeps a minimum size on screen, so a jet 50 km
// away is still a readable shape rather than a lost pixel.
//
// Shapes here are simple stand-ins until the real models are wired in.

import * as THREE from "three";
import { KIND } from "../parser/acmi.js";

const D2R = Math.PI / 180;

export const SIDE = {
  Boscali: new THREE.Color("#a76bff"),   // BDF, lavender
  Primeva: new THREE.Color("#ffb800"),   // PALA, yellow
  neutral: new THREE.Color("#808080"),   // the game's neutral map icon grey
};

// real length in metres and minimum on-screen length in pixels, per kind
const LOOK = {
  [KIND.PLANE]: { len: 16, minPx: 22 },
  [KIND.HELI]: { len: 15, minPx: 20 },
  [KIND.MISSILE]: { len: 4, minPx: 9 },
  [KIND.BOMB]: { len: 3, minPx: 7 },
  [KIND.SHELL]: { len: 1.5, minPx: 5 },
  [KIND.SHIP]: { len: 120, minPx: 26 },
  [KIND.GROUND]: { len: 8, minPx: 9 },
  [KIND.BUILDING]: { len: 14, minPx: 6 },
};
const MESH_KINDS = [KIND.PLANE, KIND.HELI, KIND.MISSILE, KIND.BOMB, KIND.SHELL, KIND.SHIP, KIND.GROUND, KIND.BUILDING];
const POINT_KINDS = [KIND.ROUND, KIND.FLARE, KIND.EXPLOSION];

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

const SHAPES = {
  [KIND.PLANE]: planeShape, [KIND.HELI]: heliShape, [KIND.MISSILE]: missileShape, [KIND.BOMB]: bombShape,
  [KIND.SHELL]: missileShape, [KIND.SHIP]: shipShape, [KIND.GROUND]: groundShape, [KIND.BUILDING]: buildingShape,
};

export class Units {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.meshes = new Map();
    this.points = null;
    this.state = new Float64Array(7);
    this.surfaceAt = null;   // (x, sceneZ) -> drawn ground height; ground units are lifted onto it
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3(); this._s = new THREE.Vector3();
  }

  // size the buffers for this replay's busiest moment
  setReplay(replay) {
    this.replay = replay;
    for (const m of this.meshes.values()) { this.group.remove(m); m.geometry.dispose(); m.material.dispose(); m.dispose(); }
    this.meshes.clear();
    if (this.points) { this.group.remove(this.points); this.points.geometry.dispose(); this.points.material.dispose(); }
    for (const k of MESH_KINDS) {
      const cap = Math.max(1, replay.maxAlive[k] + 8);
      const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
      const mesh = new THREE.InstancedMesh(SHAPES[k](), mat, cap);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.name = "kind" + k;
      this.meshes.set(k, mesh);
      this.group.add(mesh);
    }
    let cap = 8;
    for (const k of POINT_KINDS) cap += replay.maxAlive[k];
    this.pointCap = cap;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    this.points = new THREE.Points(g, new THREE.PointsMaterial({ size: 3, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false }));
    this.points.frustumCulled = false;
    this.group.add(this.points);
    this.colorOf = [];
    for (let i = 0; i < replay.count; i++) this.colorOf.push(SIDE[replay.o.coalition[i]] || SIDE.neutral);
  }

  // refill every instance for time t; camera + viewport height set the minimum on-screen sizes
  update(t, camera, viewportH) {
    const rp = this.replay;
    if (!rp) return;
    const o = rp.o, st = this.state;
    const counts = new Map();
    for (const k of MESH_KINDS) counts.set(k, 0);
    const pxPerRad = viewportH / (2 * Math.tan((camera.fov * D2R) / 2));
    const cam = camera.position;
    const pts = this.points.geometry, pp = pts.attributes.position.array, pc = pts.attributes.color.array;
    let np = 0;
    const m = this._m, q = this._q, p = this._p, s = this._s;

    const surface = this.surfaceAt;
    const cap = this.pointCap;
    rp.forEachAlive(t, (i) => {
      const k = o.kind[i];
      if (!rp.poseAt(i, t, st)) return;
      if ((k === KIND.GROUND || k === KIND.BUILDING || k === KIND.SHIP) && !rp.visibleAt(i, t)) return; // destroyed
      if (k === KIND.ROUND || k === KIND.FLARE || k === KIND.EXPLOSION) {
        if (np >= cap) return;
        const c = k === KIND.ROUND ? ROUND_COL : k === KIND.FLARE ? FLARE_COL : BOOM_COL;
        pp[np * 3] = st[0]; pp[np * 3 + 1] = st[1]; pp[np * 3 + 2] = st[2];
        pc[np * 3] = c.r; pc[np * 3 + 1] = c.g; pc[np * 3 + 2] = c.b;
        np++;
        return;
      }
      const mesh = this.meshes.get(k);
      if (!mesh) return;
      const n = counts.get(k);
      if (n >= mesh.instanceMatrix.count) return;
      // Until the detailed terrain lands, the far terrain mesh can sit a few metres above a vehicle on a hillside;
      // lift ground units and buildings onto the ground as drawn so they never vanish inside it.
      let y = st[1];
      if (surface && (k === KIND.GROUND || k === KIND.BUILDING)) y = Math.max(y, surface(st[0], st[2]));
      const look = LOOK[k];
      const dx = st[0] - cam.x, dy = y - cam.y, dz = st[2] - cam.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const len = Math.max(look.len, (look.minPx * dist) / pxPerRad);
      q.set(st[3], st[4], st[5], st[6]);
      p.set(st[0], y, st[2]);
      s.set(len, len, len);
      m.compose(p, q, s);
      mesh.setMatrixAt(n, m);
      mesh.setColorAt(n, this.colorOf[i]);
      counts.set(k, n + 1);
    });

    for (const [k, mesh] of this.meshes) {
      mesh.count = counts.get(k);
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    pts.setDrawRange(0, np);
    pts.attributes.position.needsUpdate = true;
    pts.attributes.color.needsUpdate = true;
  }
}

const ROUND_COL = new THREE.Color("#ffe08a");
const FLARE_COL = new THREE.Color("#ffffff");
const BOOM_COL = new THREE.Color("#ff7a3a");
