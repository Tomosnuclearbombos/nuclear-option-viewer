// Explosions: a fireball that pops out and burns down from white through orange to dark red, a faint shock bubble out
// to the blast radius the recording gives (60 to 180 m for most munitions, kilometres for a nuke), and smoke that
// swells and fades. Everything is a function of the playhead: an explosion's age is just t minus when it happened.
//
// Two instances per explosion (fireball and smoke, shock bubble) in one instanced mesh with a small shader; each
// instance carries its age and which part it is. The fireball keeps a minimum size on screen so a blast 30 km away
// still shows.

import * as THREE from "three";

export const BLAST_LIFE = 6.0;    // seconds an explosion shows: fire for the first ~1.5 s, then smoke
const FIRE_S = 1.5;
const POP_S = 0.25;               // the fireball reaches full size this fast
const FIREBALL = 0.35;            // fireball radius as a share of the recorded blast radius
const MIN_PX = 7;                 // smallest fireball radius on screen, pixels
const SHOCK_S = 1.0;              // the shock bubble shows this long

const vertex = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float aAge;      // seconds since the explosion
  attribute float aPart;     // 0 fireball and smoke, 1 shock bubble
  varying float vAge;
  varying float vPart;
  varying float vFacing;     // 1 where the surface faces the camera, 0 at the rim
  void main() {
    vAge = aAge; vPart = aPart;
    vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    vec3 n = normalize(mat3(modelViewMatrix) * mat3(instanceMatrix) * normal);
    vFacing = abs(dot(n, normalize(-mv.xyz)));
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }`;

const fragment = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  uniform float uFire, uShock, uLife;
  varying float vAge;
  varying float vPart;
  varying float vFacing;
  void main() {
    #include <logdepthbuf_fragment>
    if (vPart > 0.5) {
      // shock bubble: a thin bright rim, fading
      float k = 1.0 - clamp(vAge / uShock, 0.0, 1.0);
      float rim = pow(1.0 - vFacing, 3.0);
      gl_FragColor = vec4(1.0, 0.85, 0.6, rim * k * 0.5);
      return;
    }
    if (vAge < uFire) {
      float f = vAge / uFire;                                        // 0 new .. 1 burnt out
      vec3 hot = vec3(1.0, 0.98, 0.85), mid = vec3(1.0, 0.55, 0.12), cool = vec3(0.55, 0.12, 0.04);
      vec3 c = f < 0.35 ? mix(hot, mid, f / 0.35) : mix(mid, cool, (f - 0.35) / 0.65);
      float body = mix(0.55, 1.0, pow(vFacing, 0.6));               // denser through the middle
      gl_FragColor = vec4(c * mix(1.0, 0.8, 1.0 - vFacing), body * (1.0 - 0.35 * f));
      return;
    }
    // smoke: dark grey, thinning out
    float s = clamp((vAge - uFire) / (uLife - uFire), 0.0, 1.0);
    float body = mix(0.3, 1.0, pow(vFacing, 0.8));
    gl_FragColor = vec4(vec3(0.16, 0.15, 0.14) + 0.1 * s, body * 0.7 * (1.0 - s) * (1.0 - s));
  }`;

export class Blasts {
  constructor(scene) {
    this.scene = scene;
    this.mesh = null;
    this.geometry = new THREE.IcosahedronGeometry(1, 3);
    this.material = new THREE.ShaderMaterial({
      vertexShader: vertex, fragmentShader: fragment,
      uniforms: { uFire: { value: FIRE_S }, uShock: { value: SHOCK_S }, uLife: { value: BLAST_LIFE } },
      transparent: true, depthWrite: false,
    });
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3();
    this.pos = new Float64Array(7);
  }

  // sized for the replay's busiest moment
  setReplay(rp, peak) {
    if (this.mesh) { this.scene.remove(this.mesh); this.mesh.dispose(); }
    const cap = Math.max(8, peak * 2 + 8);
    this.cap = cap;
    const g = this.geometry.clone();
    this.age = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage);
    this.part = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("aAge", this.age);
    g.setAttribute("aPart", this.part);
    this.mesh = new THREE.InstancedMesh(g, this.material, cap);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;   // after the trails and tracers, so the smoke covers them
    this.scene.add(this.mesh);
  }

  // list = record indices of the explosions alive at t (collected by Units.update)
  update(rp, t, list, n, camera, viewportH) {
    if (!this.mesh) return;
    const o = rp.o, cam = camera.position;
    const pxPerRad = viewportH / (2 * Math.tan((camera.fov * Math.PI) / 360));
    const m = this._m, q = this._q.identity(), p = this._p, s = this._s;
    const ages = this.age.array, parts = this.part.array;
    let k = 0;
    for (let j = 0; j < n && k + 2 <= this.cap; j++) {
      const i = list[j];
      if (!rp.poseAt(i, t, this.pos)) continue;
      const age = t - o.t0[i];
      if (age < 0 || age > BLAST_LIFE) continue;
      const R = o.radius[i] > 0 ? o.radius[i] : 20;
      p.set(this.pos[0], this.pos[1], this.pos[2]);
      const dist = Math.max(1, p.distanceTo(cam));
      const minR = (MIN_PX * dist) / pxPerRad;
      // fireball, then smoke: pops out fast, smoke keeps swelling a little
      const grow = Math.min(1, age / POP_S);
      const swell = age < FIRE_S ? 1 : 1 + 0.4 * ((age - FIRE_S) / (BLAST_LIFE - FIRE_S));
      const r = Math.max(FIREBALL * R * (1 - (1 - grow) * (1 - grow)) * swell, age < FIRE_S ? minR : 0);
      if (r > 0) {
        s.set(r, r, r); m.compose(p, q, s);
        this.mesh.setMatrixAt(k, m); ages[k] = age; parts[k] = 0; k++;
      }
      // the shock bubble out to the blast radius
      if (age < SHOCK_S) {
        const rs = R * Math.min(1, 0.3 + age / (SHOCK_S * 0.5));
        s.set(rs, rs, rs); m.compose(p, q, s);
        this.mesh.setMatrixAt(k, m); ages[k] = age; parts[k] = 1; k++;
      }
    }
    this.mesh.count = k;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.age.needsUpdate = true;
    this.part.needsUpdate = true;
  }
}
