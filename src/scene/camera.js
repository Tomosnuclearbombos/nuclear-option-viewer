// Camera moves on top of the mouse controls: keyboard movement, following a unit, closing in, framing everything.
//
// The camera belongs to the person watching. Following carries the camera along with the unit by the unit's own
// movement each frame, so the distance and angle they chose are kept and the wheel and orbit still work; panning
// (mouse or keys) lets go of the unit.

import * as THREE from "three";
import { KIND } from "../parser/acmi.js";

// distance to close in to, per kind (metres)
const CLOSE = { [KIND.PLANE]: 70, [KIND.HELI]: 60, [KIND.MISSILE]: 30, [KIND.BOMB]: 30, [KIND.SHELL]: 20,
  [KIND.SHIP]: 700, [KIND.GROUND]: 45, [KIND.BUILDING]: 80 };

export class CameraMan {
  constructor(viewer) {
    this.viewer = viewer;
    this.keys = new Set();          // movement keys held down (KeyboardEvent.code)
    this.follow = -1;               // record index being followed
    this.last = new THREE.Vector3();
    this.hasLast = false;
    this.onFollowChange = null;
    this._v = new THREE.Vector3(); this._f = new THREE.Vector3(); this._r = new THREE.Vector3();
    this.pos = new Float64Array(7);
    this.tried = { ok: false, cam: new THREE.Vector3(), tg: new THREE.Vector3() };   // the last view dropPivot ran on

    // a mouse pan (left drag) lets go of the followed unit; a click doesn't
    const canvas = viewer.canvas;
    let down = null;
    canvas.addEventListener("pointerdown", (e) => { down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null; });
    canvas.addEventListener("pointermove", (e) => {
      if (!down || this.follow < 0 || !(e.buttons & 1)) return;
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) { this.setFollow(-1); down = null; }
    });
    window.addEventListener("pointerup", () => { down = null; });
    window.addEventListener("blur", () => this.keys.clear());
  }

  setFollow(i) {
    if (i === this.follow) return;
    // let go: the pivot stays where the unit was until hands are off the mouse and keys, then lands (see update)
    this.viewer.airPivot = this.follow >= 0 && i < 0;
    this.tried.ok = false;
    this.follow = i;
    this.hasLast = false;
    this.viewer.following = i >= 0;
    if (this.onFollowChange) this.onFollowChange(i);
  }

  // called every frame with the frame time step (s), the replay and time t
  update(dt, rp, t) {
    const v = this.viewer, cam = v.camera, tg = v.controls.target;
    // keyboard movement
    if (this.keys.size && dt > 0) {
      const fast = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") ? 3 : 1;
      const dist = cam.position.distanceTo(tg);
      const f = this._f.subVectors(tg, cam.position).setY(0);
      if (f.lengthSq() < 1e-6) f.set(0, 0, -1);
      f.normalize();
      const r = this._r.set(-f.z, 0, f.x);                 // right of forward, on the ground
      let mx = 0, mz = 0, turn = 0, zoom = 0;
      if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) mz += 1;
      if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) mz -= 1;
      if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) mx += 1;
      if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) mx -= 1;
      if (this.keys.has("KeyE")) turn -= 1;
      if (this.keys.has("KeyQ")) turn += 1;
      if (this.keys.has("PageUp")) zoom -= 1;
      if (this.keys.has("PageDown")) zoom += 1;
      if (mx || mz) {
        const step = dist * 0.9 * dt * fast;               // about one view-width a second at any zoom
        const d = this._v.set(0, 0, 0).addScaledVector(f, mz * step).addScaledVector(r, mx * step);
        cam.position.add(d); tg.add(d);
        if (this.follow >= 0) this.setFollow(-1);           // moving away lets go of the unit
      }
      if (turn) {
        const off = this._v.subVectors(cam.position, tg);
        off.applyAxisAngle(UP, turn * 1.2 * dt * fast);
        cam.position.copy(tg).add(off);
        cam.lookAt(tg);
      }
      if (zoom) {
        const off = this._v.subVectors(cam.position, tg);
        const len = off.length();
        const next = Math.min(v.controls.maxDistance, Math.max(v.controls.minDistance, len * Math.pow(2.2, zoom * dt * fast)));
        off.multiplyScalar(next / len);
        cam.position.copy(tg).add(off);
      }
    }
    // just let go of a unit: once no drag, wheel or key is moving the view, slide the pivot down to the ground.
    // Doing it mid drag would change how far a pixel of mouse movement pans. If there's no ground ahead (looking
    // level or up), try again whenever the view has moved.
    if (v.airPivot && this.follow < 0 && !v.interacting && !this.keys.size) {
      const c = this.tried;
      if (!c.ok || !c.cam.equals(cam.position) || !c.tg.equals(tg)) {
        v.dropPivot();
        c.cam.copy(cam.position); c.tg.copy(tg); c.ok = true;
      }
    }
    // following: carry the camera with the unit
    if (this.follow >= 0 && rp) {
      const i = this.follow;
      if (!rp.alive(i, t) || !rp.poseAt(i, t, this.pos)) { this.setFollow(-1); return; }
      const p = this._v.set(this.pos[0], this.pos[1], this.pos[2]);
      if (this.hasLast) {
        const dx = p.x - this.last.x, dy = p.y - this.last.y, dz = p.z - this.last.z;
        cam.position.x += dx; cam.position.y += dy; cam.position.z += dz;
      } else {
        // first frame: slide the view over to the unit, keeping the distance and angle
        const off = cam.position.clone().sub(tg);
        cam.position.copy(p).add(off);
      }
      tg.copy(p);
      this.last.copy(p);
      this.hasLast = true;
    }
  }

  // move in to a readable distance from unit i (keeping the viewing angle) and follow it
  closeIn(rp, i, t) {
    if (!rp || i < 0 || !rp.poseAt(i, t, this.pos)) return;
    const v = this.viewer, cam = v.camera, tg = v.controls.target;
    const dir = this._v.subVectors(cam.position, tg);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0.5, 1);
    dir.normalize();
    if (dir.y < 0.15) { dir.y = 0.15; dir.normalize(); }
    const d = CLOSE[rp.o.kind[i]] || 80;
    tg.set(this.pos[0], this.pos[1], this.pos[2]);
    cam.position.copy(tg).addScaledVector(dir, d);
    this.hasLast = false;
    this.setFollow(i);
    this.hasLast = true;
    this.last.copy(tg);
  }

  // frame everything drawn right now (buildings and stray far objects left out)
  frameAll(live) {
    if (!live || !live.n) return;
    const xs = [], zs = [];
    for (let j = 0; j < live.n; j++) {
      if (live.kind[j] === KIND.BUILDING) continue;
      xs.push(live.x[j]); zs.push(live.z[j]);
    }
    if (!xs.length) return;
    xs.sort((a, b) => a - b); zs.sort((a, b) => a - b);
    const lo = (a) => a[Math.floor(a.length * 0.02)], hi = (a) => a[Math.ceil(a.length * 0.98) - 1];
    this.setFollow(-1);
    this.viewer.frameBox(lo(xs), hi(xs), lo(zs), hi(zs));
  }
}

const UP = new THREE.Vector3(0, 1, 0);
