// Explosions, drawn the way the recording describes them. NOBlackBox records each explosion as the game's shockwave:
// its front (Radius) grows at the speed of sound until it reaches the blast radius, and then it ends. So each one is a
// sphere at exactly the recorded radius as it grows: about a quarter of a second to 90 m for a missile, about 10 s to
// 3.5 km for a big bomb's wave. It starts white hot and turns to dust as it spreads, then fades at full size so it
// stays on screen at least BLAST_SHOW seconds. A minimum size on screen keeps a far one visible.
//
// Detonations the recording has no explosion for (small warheads, weapons shot down; Replay.detonations) are drawn
// the same way, growing at the game's wave speed to the game's blast radius for their yield.

import * as THREE from "three";
import { WAVE_SPEED, BLAST_SHOW } from "../replay.js";

const MIN_PX = 5;   // smallest radius on screen, pixels

const vertex = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float aDone;     // how far the wave has got: 0 just exploded .. 1 at the blast radius
  attribute float aFade;     // 1 .. 0 over the last second on screen
  varying float vDone;
  varying float vFade;
  varying float vFacing;     // 1 where the surface faces the camera, 0 at the rim
  void main() {
    vDone = aDone; vFade = aFade;
    vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    vec3 n = normalize(mat3(modelViewMatrix) * mat3(instanceMatrix) * normal);
    vFacing = abs(dot(n, normalize(-mv.xyz)));
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }`;

const fragment = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  varying float vDone;
  varying float vFade;
  varying float vFacing;
  void main() {
    #include <logdepthbuf_fragment>
    float f = clamp(vDone, 0.0, 1.0);
    vec3 hot = vec3(1.0, 0.95, 0.75), fire = vec3(1.0, 0.5, 0.12), dust = vec3(0.62, 0.55, 0.47);
    vec3 c = f < 0.25 ? mix(hot, fire, f / 0.25) : mix(fire, dust, (f - 0.25) / 0.75);
    // a shell: solid while small and hot, then a thin front with a faint inside, fading out at the blast radius
    float rim = pow(1.0 - vFacing, 2.0);
    float a = mix(0.85, 0.12 + 0.6 * rim, smoothstep(0.0, 0.3, f)) * (1.0 - 0.6 * f * f) * vFade;
    gl_FragColor = vec4(c, a);
  }`;

export class Blasts {
  constructor(scene) {
    this.scene = scene;
    this.mesh = null;
    this.geometry = new THREE.IcosahedronGeometry(1, 3);
    this.material = new THREE.ShaderMaterial({ vertexShader: vertex, fragmentShader: fragment, transparent: true, depthWrite: false });
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3();
    this.pos = new Float64Array(7);
  }

  // sized for the replay's busiest moment
  setReplay(rp, peak) {
    if (this.mesh) { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.dispose(); }
    // room for the inferred detonations too: the most on screen at once (sorted times, a sliding window)
    const d = rp.detonations;
    let longest = BLAST_SHOW, most = 0;
    for (let k = 0; k < d.n; k++) longest = Math.max(longest, d.r[k] / WAVE_SPEED);
    for (let a = 0, b = 0; b < d.n; b++) { while (d.t[b] - d.t[a] > longest) a++; most = Math.max(most, b - a + 1); }
    this.dLongest = longest;
    const cap = Math.max(8, peak + 8) + most;
    this.cap = cap;
    const g = this.geometry.clone();
    this.done = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage);
    this.fade = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("aDone", this.done);
    g.setAttribute("aFade", this.fade);
    this.mesh = new THREE.InstancedMesh(g, this.material, cap);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;   // after the trails and tracers
    this.scene.add(this.mesh);
  }

  // list = record indices of the explosions alive at t (collected by Units.update)
  update(rp, t, list, n, camera, viewportH) {
    if (!this.mesh) return;
    const o = rp.o, cam = camera.position;
    const pxPerRad = viewportH / (2 * Math.tan((camera.fov * Math.PI) / 360));
    const m = this._m, q = this._q.identity(), p = this._p, s = this._s, done = this.done.array, fade = this.fade.array;
    let k = 0;
    const put = (x, y, z, r, R, end) => {
      p.set(x, y, z);
      const minR = (MIN_PX * Math.max(1, p.distanceTo(cam))) / pxPerRad;
      const shown = Math.max(r, minR);
      s.set(shown, shown, shown);
      m.compose(p, q, s);
      this.mesh.setMatrixAt(k, m);
      done[k] = R > 0 ? r / R : 1;
      fade[k] = Math.min(1, Math.max(0, end - t));   // fades over its last second
      k++;
    };
    // recorded explosions
    for (let j = 0; j < n && k < this.cap; j++) {
      const i = list[j];
      if (!rp.poseAt(i, t, this.pos)) continue;
      put(this.pos[0], this.pos[1], this.pos[2], rp.waveRadiusAt(i, t), o.radius[i], o.t1[i]);
    }
    // detonations the recording has no explosion for
    const d = rp.detonations;
    if (d.n) {
      let a = 0, b = d.n;
      const from = t - this.dLongest;
      while (a < b) { const mid = (a + b) >> 1; if (d.t[mid] < from) a = mid + 1; else b = mid; }
      for (let j = a; j < d.n && d.t[j] <= t && k < this.cap; j++) {
        const age = t - d.t[j], R = d.r[j];
        const end = d.t[j] + Math.max(BLAST_SHOW, R / WAVE_SPEED);
        if (t >= end) continue;
        put(d.x[j], d.y[j], d.z[j], Math.min(R, age * WAVE_SPEED), R, end);
      }
    }
    this.mesh.count = k;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.done.needsUpdate = true;
    this.fade.needsUpdate = true;
  }
}
