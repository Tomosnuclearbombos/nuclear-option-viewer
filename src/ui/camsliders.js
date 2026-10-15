// The camera sliders (a setting): zoom, turn and tilt the view with sliders on the screen, handy on a phone.
//
// They move the camera around the pivot just like orbiting does, so they work while following a unit too (following
// keeps whatever distance and angle they set). They also go along with the camera: however the view is moved
// (dragging, keys, the gyro, a unit being followed), they show where it is now, except the one being dragged. With
// the gyro on, the phone turns and tilts the view, so TURN and TILT rest and only ZOOM works.

import * as THREE from "three";

const D2R = Math.PI / 180;

export class CameraSliders {
  constructor(el, viewer, cameraMan) {
    this.el = el;
    this.viewer = viewer;
    this.cameraMan = cameraMan;
    this.zoom = el.querySelector("#cam-zoom");   // 0 all the way out .. max all the way in, evenly per doubling
    this.turn = el.querySelector("#cam-turn");   // degrees the view faces, clockwise from north
    this.tilt = el.querySelector("#cam-tilt");   // degrees from looking straight down
    this.tilt.max = String(Math.floor(viewer.controls.maxPolarAngle / D2R));   // to level, as far as orbiting goes
    this.held = null;   // the slider a finger or the mouse is on: left alone until it's let go
    this._s = new THREE.Spherical();
    this._v = new THREE.Vector3();
    for (const input of [this.zoom, this.turn, this.tilt]) {
      input.addEventListener("input", () => this.apply(input));
      input.addEventListener("pointerdown", () => {
        this.settle();
        this.held = input;
        viewer.interacting = true;   // like a drag: if the followed unit goes meanwhile, the pivot waits for the release
      });
      input.addEventListener("keydown", () => this.settle());
      // a click on its name would give the slider the keys and leave them there (Space, WASD): only the slider takes them
      input.closest("label").addEventListener("click", (e) => { if (e.target !== input) e.preventDefault(); });
    }
    // let go: the keys go back to the viewer (a slider that has focus keeps Space, the arrows and so on)
    const release = () => {
      if (!this.held) return;
      this.held.blur();
      this.held = null;
      viewer.interacting = false;
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
  }

  // A drag that is still gliding to a stop would go on turning the view under a slider: finish it now, and show
  // where it ended
  settle() {
    const c = this.viewer.controls;
    if (!c.enableDamping) return;
    c.enableDamping = false;
    c.update();
    c.enableDamping = true;
    this.update();
  }

  // where the camera is around the pivot: distance and two angles (the same ones orbiting turns)
  orbit() {
    return this._s.setFromVector3(this._v.subVectors(this.viewer.camera.position, this.viewer.controls.target));
  }

  // one slider moved: change just that about the view
  apply(input) {
    const v = this.viewer, c = v.controls, s = this.orbit();
    if (input === this.zoom) s.radius = c.maxDistance * Math.pow(c.minDistance / c.maxDistance, input.value / input.max);
    else if (this.cameraMan.gyro) return;
    else if (input === this.turn) s.theta = -input.value * D2R;
    else s.phi = Math.min(c.maxPolarAngle, Math.max(1e-4, input.value * D2R));
    v.camera.position.copy(c.target).add(this._v.setFromSpherical(s));
    v.camera.lookAt(c.target);
  }

  // every frame while they're on: the sliders to match the view
  update() {
    if (this.el.hidden) return;
    const c = this.viewer.controls, s = this.orbit(), gyro = this.cameraMan.gyro;
    this.show(this.zoom, (Math.log(c.maxDistance / s.radius) / Math.log(c.maxDistance / c.minDistance)) * this.zoom.max);
    this.show(this.turn, (((-s.theta / D2R) % 360) + 360) % 360);
    this.show(this.tilt, s.phi / D2R);
    if (this.turn.disabled !== gyro) this.turn.disabled = this.tilt.disabled = gyro;
  }

  show(input, value) {
    if (input === this.held) return;
    const v = String(Math.round(value));
    if (input.value !== v) input.value = v;
  }
}
