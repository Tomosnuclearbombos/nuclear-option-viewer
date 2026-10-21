// Range domes: how far each unit's radar reaches, or for a unit without a radar how far it can see, drawn around it in
// its side's colour. Ships, ground units and buildings see all round, so theirs is a dome. An aircraft's radar only
// looks ahead (30 or 60 degrees either side of the nose), so its range is a cone out of the nose, turning with it.
//
// The ranges are the game's own (src/data/ranges.js, from the game's data). The recorder's table has gaps and a few
// wrong values, so the recording's EngagementRange is only used for a unit that isn't in ours. They are nominal ranges:
// in the game, hills, the curve of the earth and a target flying low all cut detection shorter, and a big target is
// seen out to twice the range (Game expert, 2026-10-20). Ground units and buildings without a radar are left out unless
// asked for (sightGround): there can be hundreds of them, each with a small sight range.

import * as THREE from "three";
import { KIND } from "../parser/acmi.js";
import { SIDE } from "./units.js";
import { RANGES } from "../data/ranges.js";

// which filter a unit falls under
export const RANGE_GROUPS = ["planes", "ships", "ground", "stationary"];
const STILL_M = 25;   // a ground unit that never moves further than this from where it started is stationary

const vertex = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vLocal;       // the point on the unit shape (a dome or cone of radius 1)
  varying vec3 vColor;
  varying float vFacing;     // 1 where the surface faces the camera, 0 at the rim
  void main() {
    vLocal = position;
    vColor = instanceColor;
    vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    vec3 n = normalize(mat3(modelViewMatrix) * mat3(instanceMatrix) * normal);
    vFacing = abs(dot(n, normalize(-mv.xyz)));
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }`;

const fragment = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform float uRing;       // 1: a dome, with a crisp ring where it meets the ground
  varying vec3 vLocal;
  varying vec3 vColor;
  varying float vFacing;
  void main() {
    #include <logdepthbuf_fragment>
    // Many domes overlap (a base can have dozens), so each is a clear bubble: an almost invisible skin, a soft outline
    // where it curves away, and its range as one crisp ring on the ground. No lines across the surface: their spacing
    // differs with every dome's size, and stacked they turned into a mesh.
    float a = 0.01 + 0.2 * pow(1.0 - vFacing, 5.0);
    if (uRing > 0.5) {
      float lat = asin(clamp(normalize(vLocal).y, -1.0, 1.0));
      a += 0.6 * (1.0 - smoothstep(fwidth(lat) * 1.0, fwidth(lat) * 2.5, lat));
    }
    gl_FragColor = vec4(vColor, min(a, 0.75));
  }`;

// a dome of radius 1 over the ground plane
function domeGeometry() {
  return new THREE.SphereGeometry(1, 48, 12, 0, Math.PI * 2, 0, Math.PI / 2);
}
// a whole sphere, for an aircraft whose radar sees all round
function sphereGeometry() {
  return new THREE.SphereGeometry(1, 48, 24);
}
// everything within distance 1 and `half` radians of the nose (-z): the cone's side and the curved end
function coneGeometry(half) {
  const end = new THREE.SphereGeometry(1, 32, 6, 0, Math.PI * 2, 0, half).rotateX(-Math.PI / 2);
  const len = Math.cos(half), r = Math.sin(half);
  const side = new THREE.ConeGeometry(r, len, 32, 1, true).rotateX(Math.PI / 2).translate(0, 0, -len / 2);   // point at the nose
  const g = new THREE.BufferGeometry();
  const parts = [end.toNonIndexed(), side.toNonIndexed()];
  for (const name of ["position", "normal"]) {
    const arrays = parts.map((p) => p.attributes[name].array);
    const all = new Float32Array(arrays.reduce((n, a) => n + a.length, 0));
    let o = 0;
    for (const a of arrays) { all.set(a, o); o += a.length; }
    g.setAttribute(name, new THREE.BufferAttribute(all, 3));
  }
  return g;
}

export class Ranges {
  constructor(scene) {
    this.scene = scene;
    this.on = false;
    this.show = { planes: true, ships: true, ground: true, stationary: true };
    this.sightGround = false;  // ground units and buildings without a radar (their range is only how far they see)
    this.onlySelected = false; // just the selected unit's range, whatever it is (the filters don't apply to it)
    this.selected = -1;        // record index of the selected unit
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);
    this.meshes = [];          // { mesh, units: [{ i, r, group, sight }] }
    this.pos = new Float64Array(7);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3();
  }

  // the units with a range, and a mesh per shape for them
  setReplay(rp) {
    for (const { mesh } of this.meshes) { this.group.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); }
    this.meshes = [];
    this.rp = rp;
    const o = rp.o, s = rp.s;
    const byShape = new Map();   // "dome" | "sphere" | "cone:<deg>" -> units
    for (let i = 0; i < rp.count; i++) {
      const k = o.kind[i];
      const air = k === KIND.PLANE || k === KIND.HELI;
      if (!air && k !== KIND.SHIP && k !== KIND.GROUND && k !== KIND.BUILDING) continue;
      if (!o.sampleCount[i]) continue;
      const known = RANGES[o.name[i]];
      const r = known ? known.radar || known.optical : air ? 0 : o.range[i];
      if (!(r > 0)) continue;
      let group = air ? "planes" : k === KIND.SHIP ? "ships" : "ground";
      if (k === KIND.BUILDING) group = "stationary";
      else if (k === KIND.GROUND) {
        const a = o.start[i], b = a + o.sampleCount[i] - 1;
        if (Math.hypot(s.x[b] - s.x[a], s.z[b] - s.z[a]) < STILL_M) group = "stationary";
      }
      const cone = air && known && known.radar > 0 ? known.cone || 180 : 180;
      const shape = !air ? "dome" : cone >= 180 ? "sphere" : "cone:" + cone;
      if (!byShape.has(shape)) byShape.set(shape, []);
      const radar = !!(known && known.radar > 0);
      byShape.get(shape).push({ i, r, group, sight: !radar && (group === "ground" || group === "stationary") });
    }
    for (const [shape, list] of byShape) {
      const geometry = shape === "dome" ? domeGeometry() : shape === "sphere" ? sphereGeometry()
        : coneGeometry((Number(shape.slice(5)) * Math.PI) / 180);
      const material = new THREE.ShaderMaterial({
        vertexShader: vertex, fragmentShader: fragment, transparent: true, depthWrite: false, side: THREE.DoubleSide,
        uniforms: { uRing: { value: shape === "dome" ? 1 : 0 } },
      });
      const mesh = new THREE.InstancedMesh(geometry, material, list.length);
      mesh.setColorAt(0, SIDE.neutral);   // makes the colour attribute
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.renderOrder = 3;               // over the ground, under the explosions
      this.group.add(mesh);
      this.meshes.push({ mesh, units: list, turns: shape !== "dome" });
    }
  }

  // every frame while shown: each unit with a range that is around (and not destroyed) at t, if its group is shown
  update(t) {
    this.group.visible = this.on && this.meshes.length > 0;
    if (!this.group.visible) return;
    const rp = this.rp, st = this.pos, m = this._m, q = this._q, p = this._p, s = this._s;
    for (const { mesh, units, turns } of this.meshes) {
      let n = 0;
      for (const u of units) {
        if (this.onlySelected ? u.i !== this.selected : !this.show[u.group] || (u.sight && !this.sightGround)) continue;
        if (!rp.alive(u.i, t) || !rp.visibleAt(u.i, t) || !rp.poseAt(u.i, t, st)) continue;
        p.set(st[0], st[1], st[2]);
        if (turns) q.set(st[3], st[4], st[5], st[6]); else q.identity();
        s.set(u.r, u.r, u.r);
        m.compose(p, q, s);
        mesh.setMatrixAt(n, m);
        mesh.setColorAt(n, SIDE[rp.sideAt(u.i, t)] || SIDE.neutral);
        n++;
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }
}
