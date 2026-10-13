// Renderer, camera, controls and lights.
//
// The camera belongs to the person watching: only the first load and "frame everything" move it on their own.
// Left drag pans, right drag orbits, wheel zooms, like a map.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export class Viewer {
  constructor(canvas, { keepFrame = false } = {}) {
    this.canvas = canvas;
    // keepFrame lets a test read the last frame back (screenshots); off normally, it costs a little speed
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, preserveDrawingBuffer: keepFrame });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
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
    this.controls.maxDistance = 400000;
    this.controls.zoomSpeed = 1.4;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;

    this.hemi = new THREE.HemisphereLight(0xdfeaff, 0x4a4030, 1.6);
    this.sun = new THREE.DirectionalLight(0xfff2dc, 2.0);
    this.sun.position.set(-0.6, 1, 0.4).multiplyScalar(100000);
    this.scene.add(this.hemi, this.sun);

    this.onFrame = null;
    this.resize();
    window.addEventListener("resize", () => this.resize());
    this.renderer.setAnimationLoop((now) => this.frame(now));
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.height = h;
  }

  frame(now) {
    this.controls.update();
    if (this.onFrame) this.onFrame(now);
    this.renderer.render(this.scene, this.camera);
  }

  // look at a box of the world from a readable angle
  frameBox(x0, x1, z0, z1, ground = 0) {
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const span = Math.max(x1 - x0, z1 - z0, 4000);
    const dist = span * 0.85;
    this.controls.target.set(cx, ground, cz);
    this.camera.position.set(cx, ground + dist * 0.75, cz + dist * 0.65);
    this.controls.update();
  }
}
