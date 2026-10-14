// A parsed recording plus "where is everything at time t".
//
// Every object keeps a sample cursor that steps forward during playback and falls back to a binary search after a
// jump, so a frame costs about the same whether you are playing or scrubbing. Positions are interpolated between
// samples; angles take the short way round.

import { KIND, CHANNELS } from "./parser/acmi.js";
import { YIELD_KG, SHOCKWAVE_KG, blastRadius } from "./data/warheads.js";

const D2R = Math.PI / 180;

export class Replay {
  constructor(r) {
    this.header = r.header;
    this.tMin = r.tMin;
    this.tMax = r.tMax;
    this.o = r.objects;
    this.s = r.samples;
    this.channels = r.channels;
    this.locks = r.locks;
    this.events = r.events;
    const N = this.o.count;
    this.count = N;
    this.cursor = new Uint32Array(N);
    this.chCursor = new Map();

    // An explosion is the game's shockwave: NOBlackBox records its front (Radius) as it grows at the speed of sound
    // and removes it when it reaches the blast radius. Older recorders stopped sooner, so an explosion lasts at least
    // as long as its wave takes to reach its largest recorded radius. Each stays on screen at least BLAST_SHOW seconds,
    // fading at its full size, or a missile's quarter second wave would be gone in a frame at 8X.
    for (let i = 0; i < N; i++) {
      if (this.o.kind[i] === KIND.EXPLOSION) this.o.t1[i] = Math.max(this.o.t1[i], this.o.t0[i] + this.o.radius[i] / WAVE_SPEED, this.o.t0[i] + BLAST_SHOW);
    }

    // objects by start time, so the live set can be walked with one pointer
    const byStart = Array.from({ length: N }, (_, i) => i);
    byStart.sort((a, b) => this.o.t0[a] - this.o.t0[b]);
    this.byStart = Uint32Array.from(byStart);

    // per kind counts and the busiest moment, for sizing GPU buffers once
    this.maxAlive = peakAlive(this);

    // where the action is, for the first camera position
    this.bounds = sampleBounds(this);

    // detonations the recording has no explosion for (see inferDetonations)
    this.detonations = inferDetonations(this);

    // sides that change during the mission (airbases changing hands): record -> { t: [...], side: [...] } in time order
    this.sideLog = new Map();
    const sc = r.sideChanges;
    if (sc) for (let k = 0; k < sc.rec.length; k++) {
      let log = this.sideLog.get(sc.rec[k]);
      if (!log) { log = { t: [], side: [] }; this.sideLog.set(sc.rec[k], log); }
      log.t.push(sc.t[k]); log.side.push(sc.side[k]);
    }
  }

  // the side (Boscali, Primeva, Neutral) unit i is on at time t
  sideAt(i, t) {
    const log = this.sideLog.get(i);
    let side = this.o.coalition[i];
    if (log) for (let k = 0; k < log.t.length && log.t[k] <= t; k++) side = log.side[k];
    return side;
  }

  // ---- lookups -------------------------------------------------------------------------------------------
  name(i) { return this.o.name[i]; }
  label(i) {
    const p = this.o.pilot[i];
    const n = this.o.name[i] || this.o.callSign[i] || "";
    return p ? `${p} (${n})` : n;
  }
  kind(i) { return this.o.kind[i]; }
  alive(i, t) { return t >= this.o.t0[i] && t < this.o.t1[i] && this.o.sampleCount[i] > 0; }

  // index of the last sample at or before t (or the first sample if t is earlier)
  sampleAt(i, t) {
    const start = this.o.start[i], n = this.o.sampleCount[i];
    if (n === 0) return -1;
    const T = this.s.t;
    let c = this.cursor[i];
    if (c >= n) c = 0;
    // step a few samples, else binary search
    let k = start + c;
    if (T[k] <= t) {
      let steps = 0;
      while (k + 1 < start + n && T[k + 1] <= t) { k++; if (++steps > 8) { k = search(T, start, start + n, t); break; } }
    } else {
      k = search(T, start, start + n, t);
    }
    this.cursor[i] = k - start;
    return k;
  }

  // position + attitude at t into out = [x, y, z, roll, pitch, yaw] (degrees)
  stateAt(i, t, out) {
    const k = this.sampleAt(i, t);
    if (k < 0) return false;
    const s = this.s, end = this.o.start[i] + this.o.sampleCount[i];
    const t0 = s.t[k];
    if (k + 1 < end && t > t0) {
      const t1 = s.t[k + 1];
      const f = t1 > t0 ? Math.min(1, (t - t0) / (t1 - t0)) : 0;
      out[0] = s.x[k] + (s.x[k + 1] - s.x[k]) * f;
      out[1] = s.y[k] + (s.y[k + 1] - s.y[k]) * f;
      out[2] = s.z[k] + (s.z[k + 1] - s.z[k]) * f;
      out[3] = lerpAngle(s.roll[k], s.roll[k + 1], f) / 100;
      out[4] = lerpAngle(s.pitch[k], s.pitch[k + 1], f) / 100;
      out[5] = lerpAngle(s.yaw[k], s.yaw[k + 1], f) / 100;
    } else {
      out[0] = s.x[k]; out[1] = s.y[k]; out[2] = s.z[k];
      out[3] = s.roll[k] / 100; out[4] = s.pitch[k] / 100; out[5] = s.yaw[k] / 100;
    }
    return true;
  }

  // Position and orientation at t into out = [x, y, z, qx, qy, qz, qw]. Orientation is a quaternion blended
  // between the two samples (slerp), so a jet rolling through inverted flight turns the short way instead of
  // spinning through a wrong attitude, which blending roll, pitch and yaw separately would do.
  poseAt(i, t, out) {
    const k = this.sampleAt(i, t);
    if (k < 0) return false;
    const s = this.s, end = this.o.start[i] + this.o.sampleCount[i];
    const t0 = s.t[k];
    let f = 0;
    if (k + 1 < end && t > t0) {
      const t1 = s.t[k + 1];
      f = t1 > t0 ? Math.min(1, (t - t0) / (t1 - t0)) : 0;
    }
    if (f > 0) {
      out[0] = s.x[k] + (s.x[k + 1] - s.x[k]) * f;
      out[1] = s.y[k] + (s.y[k + 1] - s.y[k]) * f;
      out[2] = s.z[k] + (s.z[k + 1] - s.z[k]) * f;
      sampleQuat(s, k, Q0);
      sampleQuat(s, k + 1, Q1);
      slerp(Q0, Q1, f, out, 3);
    } else {
      out[0] = s.x[k]; out[1] = s.y[k]; out[2] = s.z[k];
      sampleQuat(s, k, Q0);
      out[3] = Q0[0]; out[4] = Q0[1]; out[5] = Q0[2]; out[6] = Q0[3];
    }
    return true;
  }

  // value of numeric channel ch for object i at time t (step function), or NaN
  channelAt(ch, i, t) {
    const c = this.channels[ch];
    const n = c.count[i];
    if (!n) return NaN;
    const start = c.start[i];
    const k = search(c.t, start, start + n, t);
    if (c.t[k] > t) return NaN;
    return c.v[k];
  }

  // An explosion's shockwave radius at t: the recorded front, joined up between records; before the first record and
  // after the last it grows at the game's wave speed, up to the largest radius recorded.
  waveRadiusAt(i, t) {
    const c = this.channels[RADIUS], n = c.count[i], R = this.o.radius[i];
    const a = c.start[i], b = a + n - 1;
    // older recorders logged only the final radius: grow it from the blast point at the wave's speed
    if (!n || c.v[a] >= 0.95 * R) return Math.min(R, Math.max(0, (t - this.o.t0[i]) * WAVE_SPEED));
    if (t <= c.t[a]) return Math.max(0, c.v[a] - (c.t[a] - t) * WAVE_SPEED);
    if (t >= c.t[b]) return Math.min(R, c.v[b] + (t - c.t[b]) * WAVE_SPEED);
    const k = search(c.t, a, b + 1, t);
    const t0 = c.t[k], t1 = c.t[k + 1];
    return t1 > t0 ? c.v[k] + ((c.v[k + 1] - c.v[k]) * (t - t0)) / (t1 - t0) : c.v[k];
  }

  // whether the object is drawn (NOBlackBox marks destroyed ground units Visible=0)
  visibleAt(i, t) {
    const v = this.channelAt(VISIBLE, i, t);
    return !(v === 0);
  }

  // ---- the live set ----------------------------------------------------------------------------------------
  // Calls fn(i) for each object alive at t. Walks objects in start order and stops at the first one that starts
  // after t, so cost grows with what has started, not with the file. Good enough for ~100k objects per frame.
  forEachAlive(t, fn) {
    const o = this.o, order = this.byStart;
    for (let j = 0; j < order.length; j++) {
      const i = order[j];
      if (o.t0[i] > t) break;
      if (t < o.t1[i] && o.sampleCount[i] > 0) fn(i);
    }
  }
}

export const VISIBLE = 9; // index of "Visible" in CHANNELS
export const WAVE_SPEED = 340;   // m/s, how fast the game's shockwave front grows (NOBlackBox ACMIShockwave_mono notes)
export const BLAST_SHOW = 2;     // seconds an explosion stays on screen at the least
const RADIUS = CHANNELS.indexOf("Radius");

// ---- orientation maths (no three.js needed here) -------------------------------------------------------------
// ACMI angles: yaw = heading clockwise from north, pitch = nose up, roll = right wing down. Scene: north is -z,
// east is +x, up is +y, and models face -z. That is three.js Euler order YXZ with (x = pitch, y = -yaw, z = -roll).
const Q0 = new Float64Array(4), Q1 = new Float64Array(4);
function sampleQuat(s, k, q) {
  const x = (s.pitch[k] / 100) * D2R * 0.5, y = (-s.yaw[k] / 100) * D2R * 0.5, z = (-s.roll[k] / 100) * D2R * 0.5;
  const c1 = Math.cos(x), c2 = Math.cos(y), c3 = Math.cos(z), s1 = Math.sin(x), s2 = Math.sin(y), s3 = Math.sin(z);
  q[0] = s1 * c2 * c3 + c1 * s2 * s3;
  q[1] = c1 * s2 * c3 - s1 * c2 * s3;
  q[2] = c1 * c2 * s3 - s1 * s2 * c3;
  q[3] = c1 * c2 * c3 + s1 * s2 * s3;
}
function slerp(a, b, f, out, o) {
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }   // the short way round
  let wa, wb;
  if (cos > 0.9995) { wa = 1 - f; wb = f; }                              // nearly equal: plain blend
  else {
    const th = Math.acos(cos), sn = Math.sin(th);
    wa = Math.sin((1 - f) * th) / sn; wb = Math.sin(f * th) / sn;
  }
  let x = a[0] * wa + bx * wb, y = a[1] * wa + by * wb, z = a[2] * wa + bz * wb, w = a[3] * wa + bw * wb;
  const n = Math.hypot(x, y, z, w) || 1;
  out[o] = x / n; out[o + 1] = y / n; out[o + 2] = z / n; out[o + 3] = w / n;
}

function search(T, lo, hi, t) {
  // last index in [lo, hi) with T <= t, or lo
  let a = lo, b = hi - 1;
  if (T[a] > t) return lo;
  while (a < b) {
    const m = (a + b + 1) >> 1;
    if (T[m] <= t) a = m; else b = m - 1;
  }
  return a;
}

function lerpAngle(a, b, f) {
  let d = b - a;
  if (d > 18000) d -= 36000; else if (d < -18000) d += 36000;
  return a + d * f;
}

function peakAlive(rp) {
  const o = rp.o, N = rp.count;
  const kinds = 16;
  const ev = [];
  for (let i = 0; i < N; i++) {
    if (!o.sampleCount[i]) continue;
    ev.push([o.t0[i], 1, o.kind[i]], [o.t1[i], -1, o.kind[i]]);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cur = new Int32Array(kinds), max = new Int32Array(kinds);
  for (const [, d, k] of ev) { cur[k] += d; if (cur[k] > max[k]) max[k] = cur[k]; }
  return max;
}

// The recording only has the explosions that made a game shockwave: warheads of about 45 kg and up. Every missile,
// bomb, rocket and shell that ended during the mission without one gets a detonation where it ended:
//  - a small warhead (air to air missiles, AGM-48, shells...) went off but the game made no shockwave: its blast at
//    the game's size for its yield, 13 x cbrt(kg);
//  - a big one with no shockwave was shot down before it went off: a small flash (SHOT_DOWN_R).
// Weapons whose yield isn't known (or is 0) get nothing. Returns arrays sorted by time.
const SHOT_DOWN_R = 20;
function inferDetonations(rp) {
  const o = rp.o, s = rp.s, N = rp.count;
  const ex = [];
  for (let i = 0; i < N; i++) if (o.kind[i] === KIND.EXPLOSION && o.sampleCount[i]) ex.push(i);
  ex.sort((a, b) => o.t0[a] - o.t0[b]);
  const et = Float64Array.from(ex, (i) => o.t0[i]);
  const first = (t) => { let a = 0, b = et.length; while (a < b) { const m = (a + b) >> 1; if (et[m] < t) a = m + 1; else b = m; } return a; };
  const out = [];
  for (let i = 0; i < N; i++) {
    const k = o.kind[i];
    if ((k !== KIND.MISSILE && k !== KIND.BOMB && k !== KIND.SHELL) || !o.sampleCount[i]) continue;
    const t1 = o.t1[i];
    if (!Number.isFinite(t1) || t1 > rp.tMax - 0.5) continue;      // still flying when the recording ended
    const kg = YIELD_KG[o.name[i]];
    if (!kg) continue;
    const last = o.start[i] + o.sampleCount[i] - 1, x = s.x[last], y = s.y[last], z = s.z[last];
    let recorded = false;
    for (let j = first(t1 - 1); j < ex.length && et[j] <= t1 + 1; j++) {
      const a = o.start[ex[j]];
      if (Math.hypot(s.x[a] - x, s.y[a] - y, s.z[a] - z) < 300) { recorded = true; break; }
    }
    if (recorded) continue;
    out.push([t1, x, y, z, kg >= SHOCKWAVE_KG ? SHOT_DOWN_R : blastRadius(kg), kg >= SHOCKWAVE_KG ? 1 : 0]);
  }
  out.sort((a, b) => a[0] - b[0]);
  const n = out.length, d = { n, t: new Float64Array(n), x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n),
    r: new Float32Array(n), shotDown: new Uint8Array(n) };
  out.forEach((e, k) => { d.t[k] = e[0]; d.x[k] = e[1]; d.y[k] = e[2]; d.z[k] = e[3]; d.r[k] = e[4]; d.shotDown[k] = e[5]; });
  return d;
}

function sampleBounds(rp) {
  const s = rp.s, o = rp.o;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y1 = 0;
  for (let i = 0; i < rp.count; i++) {
    const k = o.kind[i];
    if (k === KIND.ROUND || k === KIND.FLARE || k === KIND.EXPLOSION || k === KIND.UNKNOWN) continue;
    const a = o.start[i], n = o.sampleCount[i];
    for (let j = a; j < a + n; j += Math.max(1, n >> 4)) {
      const x = s.x[j], z = s.z[j];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; if (s.y[j] > y1) y1 = s.y[j];
    }
  }
  if (x0 === Infinity) return { x0: -1000, x1: 1000, z0: -1000, z1: 1000, y1: 1000 };
  return { x0, x1, z0, z1, y1 };
}

export { D2R };
