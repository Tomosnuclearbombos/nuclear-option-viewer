// Lines with a width in pixels, for the lock and detection lines (Tomo, 10-26: "a setting where you can make the lines
// thicker"). WebGL draws its own lines one pixel wide on most machines whatever width is asked for, so each segment is a
// thin quad, turned to face the screen in the vertex shader. A segment running behind the camera is cut at the near
// plane, so its front part still draws.
//
// Dashes are counted in pixels on screen from an anchor point (one of the segment's ends) instead of in metres along
// the line: a line tens of km long, seen from close to one end, would otherwise be one long dash near the camera and a
// shimmer far away. phase shifts the pattern along, so kinds of line on the same two units fit into each other's gaps.

import * as THREE from "three";

const VERT = /* glsl */ `
attribute vec3 iStart;
attribute vec3 iEnd;
attribute vec3 iAnchor;
uniform vec2 resolution;
uniform float width;
uniform float near;
varying vec4 vAnchor;
void main() {
  vec4 s = modelViewMatrix * vec4(iStart, 1.0);
  vec4 e = modelViewMatrix * vec4(iEnd, 1.0);
  float z = -near * 1.001;
  if (s.z > z && e.z > z) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }   // all of it behind the camera
  if (s.z > z) s = mix(s, e, (z - s.z) / (e.z - s.z));
  else if (e.z > z) e = mix(e, s, (z - e.z) / (s.z - e.z));
  vec4 cs = projectionMatrix * s, ce = projectionMatrix * e;
  vec2 d = (ce.xy / ce.w - cs.xy / cs.w) * resolution;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec4 c = position.x < 0.5 ? cs : ce;
  c.xy += vec2(-dir.y, dir.x) * position.y * width / resolution * c.w;
  gl_Position = c;
  vAnchor = projectionMatrix * modelViewMatrix * vec4(iAnchor, 1.0);
}`;

const FRAG = /* glsl */ `
uniform vec3 color;
uniform float opacity;
uniform vec2 resolution;
uniform float dash;
uniform float gap;
uniform float phase;
varying vec4 vAnchor;
void main() {
  if (dash > 0.0) {
    float d = distance(gl_FragCoord.xy, (vAnchor.xy / vAnchor.w * 0.5 + 0.5) * resolution) + phase;
    if (mod(d, dash + gap) > dash) discard;
  }
  gl_FragColor = vec4(color, opacity);
}`;

// a quad's corners: along the segment (0 start, 1 end) and across it (-1, 1)
const CORNERS = new Float32Array([0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0]);

export class LineBatch {
  // look: color; dash, gap and phase in CSS pixels (no dash: solid); order: draw order; opacity
  constructor(scene, look) {
    this.scene = scene;
    this.look = look;
    this.cap = 0;
    this.n = 0;
    this.full = false;
    this.mesh = null;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        color: { value: new THREE.Color(look.color) }, opacity: { value: look.opacity ?? 0.85 },
        resolution: { value: new THREE.Vector2(1, 1) }, width: { value: 1 }, near: { value: 0.1 },
        dash: { value: 0 }, gap: { value: 0 }, phase: { value: 0 },
      },
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    });
  }

  // room for at least cap segments
  reserve(cap) { if (cap > this.cap) this.grow(cap); }

  grow(cap) {
    if (this.mesh) { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); }
    this.cap = cap;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(CORNERS, 3));
    g.setIndex([0, 2, 1, 1, 2, 3]);
    for (const k of ["iStart", "iEnd", "iAnchor"]) {
      g.setAttribute(k, new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage));
    }
    g.instanceCount = 0;
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = this.look.order;
    this.mesh.visible = false;
    this.scene.add(this.mesh);
  }

  // a new frame's segments: more room first if the last frame ran out
  begin() {
    if (!this.mesh) this.grow(64);
    else if (this.full) this.grow(this.cap * 2);
    this.full = false;
    this.n = 0;
  }

  // one segment from a to b, its dashes counted from c (each [x, y, z] at offsets ao, bo, co)
  add(a, ao, b, bo, c, co) {
    if (this.n >= this.cap) { this.full = true; return; }
    const at = this.mesh.geometry.attributes, o = this.n * 3;
    const S = at.iStart.array, E = at.iEnd.array, A = at.iAnchor.array;
    S[o] = a[ao]; S[o + 1] = a[ao + 1]; S[o + 2] = a[ao + 2];
    E[o] = b[bo]; E[o + 1] = b[bo + 1]; E[o + 2] = b[bo + 2];
    A[o] = c[co]; A[o + 1] = c[co + 1]; A[o + 2] = c[co + 2];
    this.n++;
  }

  // the frame's segments drawn, width CSS pixels wide (the dashes grow a little with it)
  end(viewer, width) {
    const g = this.mesh.geometry, u = this.material.uniforms, r = viewer.renderer, px = r.getPixelRatio();
    r.getDrawingBufferSize(u.resolution.value);
    const grow = 1 + (width - 1) / 2;
    u.width.value = width * px;
    u.near.value = viewer.camera.near;
    u.dash.value = (this.look.dash || 0) * grow * px;
    u.gap.value = (this.look.gap || 0) * grow * px;
    u.phase.value = (this.look.phase || 0) * grow * px;
    g.instanceCount = this.n;
    for (const k of ["iStart", "iEnd", "iAnchor"]) g.attributes[k].needsUpdate = true;
    this.mesh.visible = this.n > 0;
  }
}

// whether the point at p[o] is in front of the camera
export function inFront(cam, p, o) {
  const e = cam.matrixWorldInverse.elements;
  return e[2] * p[o] + e[6] * p[o + 1] + e[10] * p[o + 2] + e[14] < -cam.near;
}
