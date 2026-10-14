// A 2D layer over the 3D view: unit labels, the hover ring and its info box, the selection marker (corner brackets,
// like the game's lock marker), and the range readout between the selected unit and another one (hold Shift).
//
// It also does picking: every drawn unit is projected to the screen once a frame, and a click or hover takes the
// nearest one within reach, so small or far units are as easy to pick as big close ones.

import * as THREE from "three";
import { KIND } from "../parser/acmi.js";
import { SIDE, SELECTED } from "./units.js";

const FONT = '12px "Brass Mono", ui-monospace, monospace';
const FONT_SMALL = '11px "Brass Mono", ui-monospace, monospace';
const MAX_LABELS = 160;
const LABEL_KINDS = new Set([KIND.PLANE, KIND.HELI, KIND.SHIP]);
const WEAPON_KINDS = new Set([KIND.MISSILE, KIND.BOMB, KIND.SHELL]);

export class Overlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.g = canvas.getContext("2d");
    this.showLabels = true;
    this.hover = -1;
    this.selected = -1;
    this.relative = -1;        // unit compared with the selected one (Shift + hover)
    this.mouse = { x: -1, y: -1 };
    this.n = 0;
    this.sx = new Float32Array(0); this.sy = new Float32Array(0); this.sr = new Float32Array(0);
    this.front = new Uint8Array(0); this.depth = new Float32Array(0);
    this._v = new THREE.Vector3();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(this.canvas.clientWidth * dpr), h = Math.round(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.dpr = dpr; this.W = this.canvas.clientWidth; this.H = this.canvas.clientHeight;
  }

  // project every drawn unit; called once per frame after units.update
  project(live, camera) {
    this.resize();
    const n = live ? live.n : 0;
    if (this.sx.length < n) {
      const c = Math.max(n, 256) * 2;
      this.sx = new Float32Array(c); this.sy = new Float32Array(c); this.sr = new Float32Array(c);
      this.front = new Uint8Array(c); this.depth = new Float32Array(c);
    }
    const v = this._v, W = this.W, H = this.H;
    const pxPerM = H / (2 * Math.tan((camera.fov * Math.PI) / 360));
    for (let j = 0; j < n; j++) {
      v.set(live.x[j], live.y[j], live.z[j]).applyMatrix4(camera.matrixWorldInverse);
      const d = -v.z;                                  // distance in front of the camera
      this.depth[j] = d;
      if (d <= 1) { this.front[j] = 0; continue; }
      v.applyMatrix4(camera.projectionMatrix);
      this.sx[j] = (v.x + 1) * 0.5 * W;
      this.sy[j] = (1 - v.y) * 0.5 * H;
      this.sr[j] = Math.max(4, (live.size[j] * pxPerM) / d / 2);   // half the drawn length, in pixels
      this.front[j] = this.sx[j] > -50 && this.sx[j] < W + 50 && this.sy[j] > -50 && this.sy[j] < H + 50 ? 1 : 0;
    }
    this.live = live;
    this.n = n;
  }

  // the unit under a screen point (CSS px), or -1. Reach is at least 15 px; weapons only win when nothing else is near.
  pick(x, y) {
    const live = this.live;
    if (!live) return -1;
    let best = -1, bestScore = Infinity, bestDepth = Infinity;
    for (let j = 0; j < this.n; j++) {
      if (!this.front[j]) continue;
      const k = live.kind[j];
      if (k === KIND.BUILDING) continue;
      const dx = this.sx[j] - x, dy = this.sy[j] - y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const reach = Math.max(15, this.sr[j]);
      if (dist > reach) continue;
      const score = dist + (WEAPON_KINDS.has(k) ? 12 : 0);
      if (score < bestScore - 3 || (Math.abs(score - bestScore) <= 3 && this.depth[j] < bestDepth)) {
        best = live.idx[j]; bestScore = score; bestDepth = this.depth[j];
      }
    }
    return best;
  }

  slotOf(i) {
    const live = this.live;
    if (!live || i < 0) return -1;
    for (let j = 0; j < this.n; j++) if (live.idx[j] === i) return j;
    return -1;
  }

  // draw everything at time t; info(i) gives the hover box lines, rel(a, b) the range readout text
  draw(rp, info, rel, t) {
    const g = this.g, dpr = this.dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, this.W, this.H);
    if (!rp || !this.live) return;
    const live = this.live, o = rp.o;
    g.textBaseline = "middle";
    g.lineJoin = "round";

    // Labels for aircraft and ships. The selected and hovered units go first, then players, then AI aircraft, then
    // ships, nearest first within each. A label that would overlap one already placed tries the unit's other
    // corners and is left out if none is free, so a crowded fleet shows a few readable names instead of a smear.
    if (this.showLabels) {
      const order = [];
      for (let j = 0; j < this.n; j++) {
        if (!this.front[j]) continue;
        const i = live.idx[j];
        if (LABEL_KINDS.has(live.kind[j]) || i === this.selected || i === this.hover) order.push(j);
      }
      const rank = (j) => {
        const i = live.idx[j];
        return i === this.selected ? 0 : i === this.hover ? 1 : o.pilot[i] ? 2 : live.kind[j] === KIND.SHIP ? 4 : 3;
      };
      order.sort((a, b) => rank(a) - rank(b) || this.depth[a] - this.depth[b]);
      g.font = FONT;
      const boxes = [];   // placed label boxes, flat x0, y0, x1, y1
      const free = (x0, y0, x1, y1) => {
        for (let b = 0; b < boxes.length; b += 4) {
          if (x0 < boxes[b + 2] && x1 > boxes[b] && y0 < boxes[b + 3] && y1 > boxes[b + 1]) return false;
        }
        return true;
      };
      let drawn = 0;
      for (let q = 0; q < order.length && drawn < MAX_LABELS; q++) {
        const j = order[q], i = live.idx[j];
        const text = labelOf(o, i);
        if (!text) continue;
        const w = g.measureText(text).width, r = this.sr[j], sx = this.sx[j], sy = this.sy[j];
        const must = i === this.selected || i === this.hover;
        let x = 0, y = 0, ok = false;
        // right and up (the usual spot), right and down, left and up, left and down
        for (let c = 0; c < 4 && !ok; c++) {
          x = c < 2 ? sx + r + 6 : sx - r - 6 - w;
          y = c % 2 === 0 ? sy - r * 0.4 - 6 : sy + r * 0.4 + 8;
          ok = free(x - 3, y - 8, x + w + 3, y + 8);
          if (must && !ok && c === 3) { x = sx + r + 6; y = sy - r * 0.4 - 6; ok = true; }
        }
        if (!ok) continue;
        boxes.push(x - 3, y - 8, x + w + 3, y + 8);
        const side = rp.sideAt(i, t);
        const col = i === this.selected ? SELECTED[side] || SELECTED.neutral : SIDE[side] || SIDE.neutral;
        outlined(g, text, x, y, cssColor(col));
        drawn++;
      }
    }

    // range readout between the selected unit and another (Shift + hover)
    const sj = this.slotOf(this.selected);
    const rj = this.relative >= 0 ? this.slotOf(this.relative) : -1;
    if (sj >= 0 && rj >= 0 && this.front[sj] && this.front[rj]) {
      g.strokeStyle = "#00ff00"; g.lineWidth = 1.5; g.setLineDash([6, 4]);
      g.beginPath(); g.moveTo(this.sx[sj], this.sy[sj]); g.lineTo(this.sx[rj], this.sy[rj]); g.stroke();
      g.setLineDash([]);
      const lines = rel(this.selected, this.relative);
      box(g, lines, (this.sx[sj] + this.sx[rj]) / 2 + 10, (this.sy[sj] + this.sy[rj]) / 2 + 10, "#00ff00", this.W, this.H);
    }

    // selected: corner brackets in the game's selected colour
    if (sj >= 0 && this.front[sj]) {
      const col = cssColor(SELECTED[rp.sideAt(this.selected, t)] || SELECTED.neutral);
      brackets(g, this.sx[sj], this.sy[sj], Math.max(12, this.sr[sj] + 6), col);
    }

    // hover: a ring and an info box
    const hj = this.hover >= 0 && this.hover !== this.selected ? this.slotOf(this.hover) : -1;
    if (hj >= 0 && this.front[hj]) {
      g.strokeStyle = "rgba(255,255,255,0.9)"; g.lineWidth = 1.5;
      g.beginPath(); g.arc(this.sx[hj], this.sy[hj], Math.max(12, this.sr[hj] + 5), 0, Math.PI * 2); g.stroke();
    }
    if (this.hover >= 0) {
      const j = this.slotOf(this.hover);
      if (j >= 0 && this.front[j]) {
        const lines = info(this.hover);
        box(g, lines, this.sx[j] + Math.max(14, this.sr[j] + 10), this.sy[j] + 14, "#ffffff", this.W, this.H);
      }
    }
  }
}

export function labelOf(o, i) {
  const pilot = o.pilot[i], name = o.name[i];
  if (pilot) return pilot;
  return name || o.callSign[i] || "";
}

// What tells an AI unit from others of its type: its call sign, minus the type name when it only repeats it
// ("Shard Class Corvette 269" gives "269", "EW-25 99E" stays). Players go by their names, so they get none.
export function callSignOf(o, i) {
  if (o.pilot[i]) return "";
  const cs = String(o.callSign[i] || "").trim(), name = String(o.name[i] || "").trim();
  if (!cs || cs === name) return "";
  if (name && cs.toLowerCase().startsWith(name.toLowerCase() + " ")) return cs.slice(name.length + 1);
  return cs;
}

function cssColor(c) { return "#" + c.getHexString(); }

function outlined(g, text, x, y, col) {
  g.lineWidth = 3; g.strokeStyle = "rgba(0,0,0,0.85)"; g.strokeText(text, x, y);
  g.fillStyle = col; g.fillText(text, x, y);
}

function brackets(g, x, y, r, col) {
  const a = r * 0.45;
  g.strokeStyle = col; g.lineWidth = 2;
  g.beginPath();
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const cx = x + sx * r, cy = y + sy * r;
    g.moveTo(cx, cy - sy * a); g.lineTo(cx, cy); g.lineTo(cx - sx * a, cy);
  }
  g.stroke();
}

// a small black plate with lines of text, kept on screen
function box(g, lines, x, y, col, W, H) {
  if (!lines || !lines.length) return;
  g.font = FONT_SMALL;
  const lh = 15, pad = 6;
  let w = 0;
  for (const l of lines) w = Math.max(w, g.measureText(l).width);
  const bw = w + pad * 2, bh = lines.length * lh + pad * 2 - 3;
  const bx = Math.min(Math.max(4, x), W - bw - 4), by = Math.min(Math.max(4, y), H - bh - 70);
  g.fillStyle = "rgba(0,0,0,0.9)"; g.fillRect(bx, by, bw, bh);
  g.strokeStyle = "rgba(0,255,0,0.5)"; g.lineWidth = 1; g.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
  g.fillStyle = col;
  lines.forEach((l, n) => g.fillText(l, bx + pad, by + pad + n * lh + 5));
}
