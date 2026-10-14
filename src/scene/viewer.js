// Renderer, camera, controls and lights.
//
// The camera belongs to the person watching: only the first load and "frame everything" move it on their own.
// Left drag pans, right drag orbits, wheel zooms, like a map.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const CLEARANCE = 12; // metres the camera keeps above the ground

export class Viewer {
  // Throws if the browser can't give us WebGL 2.
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", { antialias: true, powerPreference: "high-performance" });
    if (!gl) throw new Error("no webgl2");
    this.renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: true, logarithmicDepthBuffer: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x8fb4d6);
    this.scene.fog = new THREE.Fog(0x8fb4d6, 120000, 420000);

    this.camera = new THREE.PerspectiveCamera(50, 1, 2, 2_000_000);
    this.camera.position.set(0, 60000, 60000);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
    this.controls.screenSpacePanning = false;   // pan along the ground
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 10;
    this.controls.maxDistance = 300000;   // still frames all of Ignus (164 km across)
    this.controls.zoomSpeed = 1.4;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;

    this.hemi = new THREE.HemisphereLight(0xdfeaff, 0x4a4030, 1.6);
    this.sun = new THREE.DirectionalLight(0xfff2dc, 2.0);
    this.sun.position.set(-0.6, 1, 0.4).multiplyScalar(100000);
    this.scene.add(this.hemi, this.sun);

    this.groundAt = null;   // (x, sceneZ) -> ground height under that point, set once a map is loaded
    this.following = false; // set while the camera follows a unit
    this.airPivot = false;  // the pivot is up where a followed unit was let go; it lands with dropPivot
    this.interacting = false;   // a mouse drag or wheel turn is in progress
    this.controls.addEventListener("start", () => { this.interacting = true; });
    this.controls.addEventListener("end", () => { this.interacting = false; });
    this._d = new THREE.Vector3();
    this.onFrame = null;
    this.resize();
    window.addEventListener("resize", () => this.resize());
    this.watchPixelRatio();
    this.renderer.setAnimationLoop((now) => this.frame(now));
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.height = h;
  }

  // browser zoom or a move to another monitor changes devicePixelRatio, often without a resize event
  watchPixelRatio() {
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    mq.addEventListener("change", () => { this.resize(); this.watchPixelRatio(); }, { once: true });
  }

  frame(now) {
    this.controls.update();
    this.keepAboveGround();
    this.fitFog();
    if (this.onFrame) this.onFrame(now);
    this.renderer.render(this.scene, this.camera);
  }

  // Haze starts beyond the point you are looking at, so the map never fades out when you zoom right out to see it all.
  fitFog() {
    const d = this.camera.position.distanceTo(this.controls.target);
    this.scene.fog.near = Math.max(120000, d * 1.1);
    this.scene.fog.far = this.scene.fog.near + 300000;
  }

  // The orbit pivot follows the ground under it, so zooming in on a mountain lands on the mountain rather than
  // sea level inside it; and the camera itself never goes below the ground.
  keepAboveGround() {
    if (!this.groundAt) return;
    const tg = this.controls.target, cam = this.camera.position;
    if (!this.following && !this.airPivot) {   // the pivot of a followed unit is the unit itself, maybe flying
      const gt = Math.max(0, this.groundAt(tg.x, tg.z));
      const dy = (gt - tg.y) * 0.25;   // ease, so panning over ridges doesn't jolt
      if (Math.abs(dy) > 0.01) { tg.y += dy; cam.y += dy; }
    }
    const floor = Math.max(0, this.groundAt(cam.x, cam.z)) + CLEARANCE;
    if (cam.y < floor) { cam.y = floor; this.camera.lookAt(tg); }   // re-aim, or the view drifts off the pivot
  }

  // After letting go of a followed unit the pivot is wherever the unit was, maybe high in the sky. Slide it along the
  // line of sight down to the ground: the picture doesn't move at all, but orbiting and zooming work around the
  // map again. Looking level or up there is no ground ahead, so the pivot stays in the air. True if it landed.
  dropPivot() {
    const tg = this.controls.target, cam = this.camera.position;
    const d = this._d.subVectors(tg, cam);
    const len = d.length();
    if (!this.groundAt || len < 1e-3) return false;
    d.divideScalar(len);
    const s = this.groundAlong(cam, d, this.controls.maxDistance);
    if (s === null) return false;
    tg.copy(cam).addScaledVector(d, Math.max(s, this.controls.minDistance));
    this.airPivot = false;
    return true;
  }

  // distance along a ray (unit direction d) from o to where it meets the ground or the sea, or null
  groundAlong(o, d, maxD) {
    if (d.y > -1e-3) return null;
    const gap = (s) => o.y + d.y * s - Math.max(0, this.groundAt(o.x + d.x * s, o.z + d.z * s));
    let s0 = 0, h = gap(0);
    if (h <= 0) return 0;
    // half the height above the ground is a safe step on any slope up to 45 degrees; then halve in on the crossing
    for (let n = 0; n < 20000 && s0 < maxD; n++) {
      const s1 = s0 + Math.max(0.5, h * 0.5);
      const h1 = gap(s1);
      if (h1 <= 0) {
        let a = s0, b = s1;
        for (let k = 0; k < 24; k++) { const m = (a + b) / 2; if (gap(m) > 0) a = m; else b = m; }
        return (a + b) / 2;
      }
      s0 = s1; h = h1;
    }
    return null;
  }

  // look at a box of the world from a readable angle
  frameBox(x0, x1, z0, z1) {
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const ground = this.groundAt ? Math.max(0, this.groundAt(cx, cz)) : 0;
    const span = Math.max(x1 - x0, z1 - z0, 4000);
    const dist = span * 0.85;
    this.airPivot = false;
    this.controls.target.set(cx, ground, cz);
    this.camera.position.set(cx, ground + dist * 0.75, cz + dist * 0.65);
    this.controls.update();
  }
}
