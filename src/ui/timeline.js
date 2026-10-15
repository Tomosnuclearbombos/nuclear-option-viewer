// The timeline: where you are in the mission, what was happening when, and a place to drag.
//
// Drawn on a canvas that fills its wrapper (the wrapper is sized by the layout, never by the canvas, so the
// canvas can shrink as well as grow). Aircraft in the air show as a green trace and weapons in flight as amber
// bars, each on its own scale so neither hides the other. The track is inset a few pixels so the playhead marker
// is whole at the very start and end. A white band marks one unit's time in the mission: the one under the mouse in
// the unit list, else the selected one. The wheel over the timeline nudges time.

import { KIND } from "../parser/acmi.js";
import { duration } from "./format.js";

const GREEN = "#00ff00", DIM = "#00b400", FAINT = "rgba(0, 255, 0, 0.22)", AMBER = "rgba(255, 128, 0, 0.75)";
const FONT = '10px "Brass Mono", ui-monospace, monospace';
const BUCKETS = 800;
const STEPS = [30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
const PAD = 6;           // track inset in CSS pixels, room for half the playhead marker
const LABEL_H = 12;      // height of the tick label row

export class Timeline {
  constructor(canvas, { onSeek, onNudge, label }) {
    this.canvas = canvas;
    this.onSeek = onSeek;
    this.onNudge = onNudge;    // (+1 or -1, shift held) for each notch of the wheel
    this.label = label;        // t -> text for the hover readout
    this.rp = null;
    this.band = null;          // [t0, t1] to mark, or null
    this.hoverX = -1;
    this.dragging = false;
    let wheel = 0, lastWheel = 0;
    canvas.addEventListener("wheel", (e) => {
      if (!this.rp || !this.onNudge) return;
      e.preventDefault();
      // a mouse notch (40 px or more) is one nudge; a touchpad's many small steps add up to one per 100 px
      const px = (e.deltaY || e.deltaX) * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      if (e.timeStamp - lastWheel > 300) wheel = 0;
      lastWheel = e.timeStamp;
      if (Math.abs(px) >= 40) { wheel = 0; this.onNudge(Math.sign(px), e.shiftKey); return; }
      wheel += px;
      if (Math.abs(wheel) >= 100) { this.onNudge(Math.sign(wheel), e.shiftKey); wheel = 0; }
    }, { passive: false });
    canvas.addEventListener("pointerdown", (e) => {
      if (!this.rp || e.button !== 0) return;
      this.dragging = true;
      canvas.setPointerCapture(e.pointerId);
      this.seekTo(e);
    });
    canvas.addEventListener("pointermove", (e) => {
      this.hoverX = this.xAt(e.clientX);
      if (this.dragging) this.seekTo(e);
    });
    const end = (e) => { this.dragging = false; if (canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId); };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("pointerleave", () => { this.hoverX = -1; });
  }

  // base: the time the labels count from (the start of the recording; live, the start of the match, before the window)
  setReplay(rp, base = rp.tMin) {
    this.rp = rp;
    this.base = base;
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

  // the canvas's box on the screen, in screen pixels. The UI size setting zooms the canvas; older Safari measures a
  // zoomed element unzoomed, in its own CSS pixels, so its box is scaled back up there.
  box() {
    const r = this.canvas.getBoundingClientRect(), k = RECTS_ZOOMED ? 1 : zoomOf(this.canvas);
    return { left: r.left * k, width: r.width * k, height: r.height * k };
  }

  // a point on the screen as x across the canvas, in the canvas's own CSS pixels (the UI size setting zooms the
  // canvas, so those and the screen's differ)
  xAt(clientX) {
    const b = this.box();
    return b.width > 0 ? ((clientX - b.left) * this.canvas.clientWidth) / b.width : 0;
  }

  // the track runs from PAD to width - PAD; positions outside it clamp to the ends
  fracAt(clientX) {
    const w = this.canvas.clientWidth - 2 * PAD;
    return w > 0 ? clamp((this.xAt(clientX) - PAD) / w, 0, 1) : 0;
  }

  seekTo(e) {
    this.onSeek(this.rp.tMin + this.fracAt(e.clientX) * (this.rp.tMax - this.rp.tMin));
  }

  draw(t) {
    const c = this.canvas, rp = this.rp;
    if (!rp) return;
    // one canvas pixel per screen pixel, drawn in the canvas's own CSS pixels: the UI size setting zooms the canvas,
    // so those are the device's pixel ratio times the zoom
    const r = this.box(), sp = window.devicePixelRatio || 1;
    const zoom = c.clientWidth ? r.width / c.clientWidth : 1;
    const dpr = sp * zoom;
    const w = Math.max(1, Math.round(r.width * sp)), h = Math.max(1, Math.round(r.height * sp));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = w / dpr, H = h / dpr;
    g.clearRect(0, 0, W, H);
    const span = rp.tMax - rp.tMin;
    if (!(span > 0) || !Number.isFinite(span)) return;
    const x0 = PAD, tw = Math.max(1, W - 2 * PAD);             // the track
    const xAt = (s) => x0 + (s / span) * tw;                    // s = seconds from the start
    const top = LABEL_H + 1, base = H - 1, gh = base - top;

    // frame
    g.strokeStyle = FAINT; g.lineWidth = 1;
    g.strokeRect(x0 + 0.5, top - 0.5, tw - 1, gh + 1);

    // one unit's time in the mission
    if (this.band) {
      const a = clamp(this.band[0] - rp.tMin, 0, span), b = clamp(Math.min(this.band[1], rp.tMax) - rp.tMin, a, span);
      const xa = Math.round(xAt(a)), xb = Math.max(xa + 2, Math.round(xAt(b)));
      g.fillStyle = "rgba(255, 255, 255, 0.13)";
      g.fillRect(xa, top, xb - xa, gh);
      g.fillStyle = "rgba(255, 255, 255, 0.7)";
      g.fillRect(xa, top, 1, gh); g.fillRect(xb - 1, top, 1, gh);
    }

    // time ticks every 30 s .. 2 h, the first that leaves 70 px for each label; past that, whole hours. They fall on
    // whole steps counted from the base, which is the track's start except live.
    let step = STEPS.find((s) => (s / span) * tw >= 70);
    if (!step) step = Math.ceil((span * 70) / tw / 3600) * 3600;
    g.font = FONT; g.textBaseline = "top";
    const off = rp.tMin - this.base;
    for (let s = Math.ceil(off / step) * step - off; s <= span; s += step) {
      const x = Math.round(xAt(s)) + 0.5;
      g.strokeStyle = s ? "rgba(0, 255, 0, 0.18)" : FAINT;
      g.beginPath(); g.moveTo(x, top); g.lineTo(x, base); g.stroke();
      const txt = duration(s + off);
      if (x + 3 + g.measureText(txt).width <= W) { g.fillStyle = DIM; g.fillText(txt, x + 3, 1); }
    }

    // activity: weapons as amber bars along the bottom, aircraft as a green trace over them
    const A = this.activity, B = BUCKETS, bw = tw / B;
    if (A) {
      g.fillStyle = AMBER;
      for (let b = 0; b < B; b++) {
        const v = A.wpn[b] / A.maxW;
        if (v > 0) { const bh = Math.max(1, v * gh * 0.5); g.fillRect(x0 + b * bw, base - bh, Math.max(1, bw), bh); }
      }
      g.beginPath();
      g.moveTo(x0, base);
      for (let b = 0; b < B; b++) g.lineTo(x0 + (b + 0.5) * bw, base - (A.air[b] / A.maxA) * gh * 0.92);
      g.lineTo(x0 + tw, base);
      g.closePath();
      g.fillStyle = "rgba(0, 255, 0, 0.14)";
      g.fill();
      g.beginPath();
      for (let b = 0; b < B; b++) {
        const x = x0 + (b + 0.5) * bw, y = base - (A.air[b] / A.maxA) * gh * 0.92;
        if (b) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.strokeStyle = "rgba(0, 255, 0, 0.85)"; g.lineWidth = 1.2;
      g.stroke();
    }

    // hover: where a click would land, with its time over a cleared label row
    if (this.hoverX >= 0 && !this.dragging) {
      const f = clamp((this.hoverX - x0) / tw, 0, 1);
      const x = Math.round(x0 + f * tw) + 0.5;
      g.strokeStyle = "rgba(255, 255, 255, 0.45)"; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, top); g.lineTo(x, base); g.stroke();
      const txt = this.label(rp.tMin + f * span);
      const bw2 = g.measureText(txt).width + 8;
      const bx = clamp(x - bw2 / 2, 0, W - bw2);
      g.fillStyle = "#000"; g.fillRect(0, 0, W, LABEL_H);
      g.fillStyle = "#ffffff"; g.fillText(txt, bx + 4, 1);
    }

    // playhead
    const x = Math.round(xAt(clamp(t - rp.tMin, 0, span)));
    g.fillStyle = GREEN;
    g.shadowColor = "rgba(0, 200, 0, 0.9)"; g.shadowBlur = 6;
    g.fillRect(x - 1, top, 2, gh + 1);
    g.beginPath(); g.moveTo(x - 5, top); g.lineTo(x + 5, top); g.lineTo(x, top + 6); g.closePath(); g.fill();
    g.shadowBlur = 0;
  }
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

// whether this browser measures an element under CSS zoom on the screen (as the standard says) or unzoomed (older
// Safari): a test box 10 px wide at double zoom is 20 px on the screen
const RECTS_ZOOMED = (() => {
  const probe = document.createElement("div");
  probe.style.cssText = "position: fixed; left: 0; top: 0; width: 10px; height: 1px; zoom: 2; visibility: hidden";
  document.body.append(probe);
  const w = probe.getBoundingClientRect().width;
  probe.remove();
  return w > 15;
})();

// how much an element is zoomed, its own zoom and its parents' together
function zoomOf(el) {
  if (el.currentCSSZoom) return el.currentCSSZoom;
  let z = 1;
  for (let e = el; e; e = e.parentElement) z *= parseFloat(getComputedStyle(e).zoom) || 1;
  return z;
}
