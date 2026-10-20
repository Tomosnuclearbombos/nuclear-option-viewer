// Range domes: how far each unit's radar reaches, or for a unit without a radar how far it can see, drawn around it in
// its side's colour. Ships, ground units and buildings see all round, so theirs is a dome. An aircraft's radar only
// looks ahead (30 or 60 degrees either side of the nose), so its range is a cone out of the nose, turning with it.
//
// The ranges are the game's own (src/data/ranges.js, from the game's data). The recorder's table has gaps and a few
// wrong values, so the recording's EngagementRange is only used for a unit that isn't in ours. They are nominal ranges:
// in the game, hills, the curve of the earth and a target flying low all cut detection shorter, and a big target is
// seen out to twice the range (Game expert, 2026-10-20).

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
  uniform float uGrid;       // 1: draw lines of latitude and longitude on it (domes)
  varying vec3 vLocal;
  varying vec3 vColor;
  varying float vFacing;
  // 1 on a line every 'step' radians of angle a, about a pixel wide whatever the size on screen
  float lines(float a, float step) {
    float d = abs(fract(a / step + 0.5) - 0.5) * step;
    return 1.0 - smoothstep(0.0, fwidth(a) * 1.2, d);
  }
  void main() {
    #include <logdepthbuf_fragment>
    // A very faint skin, a little stronger towards its outline: many domes overlap (a base can have hundreds of units),
    // so the fill has to stay see-through when stacked, and the lines carry the shape.
    float a = 0.012 + 0.12 * pow(1.0 - vFacing, 4.0);
    if (uGrid > 0.5) {
      vec3 p = normalize(vLocal);
      float lat = asin(clamp(p.y, -1.0, 1.0)), lon = atan(p.z, p.x);
      float grid = max(lines(lat, PI / 6.0), lines(lon, PI / 6.0) * (1.0 - smoothstep(1.2, 1.5, lat)));
      a += 0.16 * grid + 0.45 * (1.0 - smoothstep(0.0, fwidth(lat) * 2.0, lat));   // and a ring on the ground
    } else a += 0.03;
    gl_FragColor = vec4(vColor, min(a, 0.7));
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
  const side = new THREE.ConeGeometry(r, len, 32, 1, true).rotateX(-Math.PI / 2).translate(0, 0, -len / 2);
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
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);
    this.meshes = [];          // { mesh, units: [{ i, r, group }] }
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
      byShape.get(shape).push({ i, r, group });
    }
    for (const [shape, list] of byShape) {
      const geometry = shape === "dome" ? domeGeometry() : shape === "sphere" ? sphereGeometry()
        : coneGeometry((Number(shape.slice(5)) * Math.PI) / 180);
      const material = new THREE.ShaderMaterial({
        vertexShader: vertex, fragmentShader: fragment, transparent: true, depthWrite: false, side: THREE.DoubleSide,
        uniforms: { uGrid: { value: shape === "dome" ? 1 : 0 } },
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
        if (!this.show[u.group] || !rp.alive(u.i, t) || !rp.visibleAt(u.i, t) || !rp.poseAt(u.i, t, st)) continue;
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
