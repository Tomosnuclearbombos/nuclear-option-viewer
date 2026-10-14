// The timeline: where you are in the mission, what was happening when, and a place to drag.
//
// Drawn on a canvas that fills its wrapper (the wrapper is sized by the layout, never by the canvas, so the
// canvas can shrink as well as grow). Aircraft in the air show as a green trace and weapons in flight as amber
// bars, each on its own scale so neither hides the other.

import { KIND } from "../parser/acmi.js";
import { duration } from "./format.js";

const GREEN = "#00ff00", DIM = "#00b400", FAINT = "rgba(0, 255, 0, 0.22)", AMBER = "rgba(255, 128, 0, 0.75)";
const FONT = '10px "Brass Mono", ui-monospace, monospace';
const BUCKETS = 800;
const STEPS = [30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

export class Timeline {
  constructor(canvas, { onSeek, label }) {
    this.canvas = canvas;
    this.onSeek = onSeek;
    this.label = label;        // t -> text for the hover readout
    this.rp = null;
    this.hoverX = -1;
    this.dragging = false;
    canvas.addEventListener("pointerdown", (e) => {
      if (!this.rp || e.button !== 0) return;
      this.dragging = true;
      canvas.setPointerCapture(e.pointerId);
      this.seekTo(e);
    });
    canvas.addEventListener("pointermove", (e) => {
      this.hoverX = e.offsetX;
      if (this.dragging) this.seekTo(e);
    });
    const end = (e) => { this.dragging = false; if (canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId); };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("pointerleave", () => { this.hoverX = -1; });
  }

  setReplay(rp) {
    this.rp = rp;
    // aircraft and weapons alive in each bucket, via difference arrays (one pass over the objects)
    const B = BUCKETS, span = rp.tMax - rp.tMin || 1;
    const air = new Float32Array(B + 1), wpn = new Float32Array(B + 1);
    const o = rp.o;
    for (let i = 0; i < rp.count; i++) {
      const k = o.kind[i];
      const arr = k === KIND.PLANE || k === KIND.HELI ? air : k === KIND.MISSILE || k === KIND.BOMB ? wpn : null;
      if (!arr || !o.sampleCount[i]) continue;
      const b0 = clamp(Math.floor(((o.t0[i] - rp.tMin) / span) * B), 0, B - 1);
      const b1 = clamp(Math.floor(((Math.min(o.t1[i], rp.tMax) - rp.tMin) / span) * B), b0, B - 1);
      arr[b0] += 1; arr[b1 + 1] -= 1;
    }
    for (let b = 1; b <= B; b++) { air[b] += air[b - 1]; wpn[b] += wpn[b - 1]; }
    let maxA = 1, maxW = 1;
    for (let b = 0; b < B; b++) { if (air[b] > maxA) maxA = air[b]; if (wpn[b] > maxW) maxW = wpn[b]; }
    this.activity = { air, wpn, maxA, maxW };
  }

  seekTo(e) {
    const r = this.canvas.getBoundingClientRect();
    const f = clamp((e.clientX - r.left) / r.width, 0, 1);
    this.onSeek(this.rp.tMin + f * (this.rp.tMax - this.rp.tMin));
  }

  draw(t) {
    const c = this.canvas, rp = this.rp;
    if (!rp) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = w / dpr, H = h / dpr;
    g.clearRect(0, 0, W, H);
    const span = rp.tMax - rp.tMin || 1;
    const top = 13, base = H - 1, gh = base - top;

    // frame
    g.strokeStyle = FAINT; g.lineWidth = 1;
    g.strokeRect(0.5, top - 0.5, W - 1, gh + 1);

    // time ticks every 30 s .. 2 h, whichever leaves room for the labels
    const step = STEPS.find((s) => (s / span) * W >= 70) || STEPS[STEPS.length - 1];
    g.font = FONT; g.textBaseline = "top"; g.fillStyle = DIM;
    for (let s = 0; s <= span; s += step) {
      const x = Math.round((s / span) * W) + 0.5;
      g.strokeStyle = s ? "rgba(0, 255, 0, 0.18)" : FAINT;
      g.beginPath(); g.moveTo(x, top); g.lineTo(x, base); g.stroke();
      if (x < W - 30) g.fillText(duration(s), x + 3, 1);
    }

    // activity: weapons as amber bars along the bottom, aircraft as a green trace over them
    const A = this.activity, B = BUCKETS, bw = W / B;
    if (A) {
      g.fillStyle = AMBER;
      for (let b = 0; b < B; b++) {
        const v = A.wpn[b] / A.maxW;
        if (v > 0) { const bh = Math.max(1, v * gh * 0.5); g.fillRect(b * bw, base - bh, Math.max(1, bw), bh); }
      }
      g.beginPath();
      g.moveTo(0, base);
      for (let b = 0; b < B; b++) g.lineTo((b + 0.5) * bw, base - (A.air[b] / A.maxA) * gh * 0.92);
      g.lineTo(W, base);
      g.closePath();
      g.fillStyle = "rgba(0, 255, 0, 0.14)";
      g.fill();
      g.beginPath();
      for (let b = 0; b < B; b++) {
        const x = (b + 0.5) * bw, y = base - (A.air[b] / A.maxA) * gh * 0.92;
        if (b) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.strokeStyle = "rgba(0, 255, 0, 0.85)"; g.lineWidth = 1.2;
      g.stroke();
    }

    // hover: where a click would land
    if (this.hoverX >= 0 && !this.dragging) {
      const x = Math.round(this.hoverX) + 0.5;
      g.strokeStyle = "rgba(255, 255, 255, 0.45)"; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, top); g.lineTo(x, base); g.stroke();
      const txt = this.label(rp.tMin + (this.hoverX / W) * span);
      const tw = g.measureText(txt).width + 8;
      const tx = clamp(x - tw / 2, 0, W - tw);
      g.fillStyle = "#000"; g.fillRect(tx, 0, tw, 12);
      g.fillStyle = "#ffffff"; g.fillText(txt, tx + 4, 1);
    }

    // playhead
    const x = Math.round(((t - rp.tMin) / span) * W);
    g.fillStyle = GREEN;
    g.shadowColor = "rgba(0, 200, 0, 0.9)"; g.shadowBlur = 6;
    g.fillRect(x - 1, top, 2, gh + 1);
    g.beginPath(); g.moveTo(x - 5, top); g.lineTo(x + 5, top); g.lineTo(x, top + 6); g.closePath(); g.fill();
    g.shadowBlur = 0;
  }
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
