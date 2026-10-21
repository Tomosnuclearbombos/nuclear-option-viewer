// The info panel for the selected unit: who it is and live readouts, in the game's "LABEL : value" style.
// Units are metric, as in the game: metres, km/h.

import { KIND, CHANNELS } from "../parser/acmi.js";
import { labelOf, callSignOf } from "../scene/overlay.js";

const CH = Object.fromEntries(CHANNELS.map((n, i) => [n, i]));
const SIDE_NAME = { Boscali: "BDF", Primeva: "PALA" };
const KIND_NAME = {
  [KIND.PLANE]: "AIRCRAFT", [KIND.HELI]: "HELICOPTER", [KIND.MISSILE]: "MISSILE", [KIND.BOMB]: "BOMB",
  [KIND.SHELL]: "SHELL", [KIND.SHIP]: "SHIP", [KIND.GROUND]: "GROUND UNIT", [KIND.BUILDING]: "BUILDING",
};
const SIDE_CLASS = { Boscali: "bdf", Primeva: "pala" };

export class Inspector {
  constructor(root) {
    this.root = root;
    this.title = root.querySelector("#insp-title");
    this.sub = root.querySelector("#insp-sub");
    this.rows = root.querySelector("#insp-rows");
    this.status = root.querySelector("#insp-status");
    this.follow = root.querySelector("#insp-follow");
    this.i = -1;
    this.rp = null;
    this.pos = new Float64Array(7);
    this.last = 0;
  }

  setReplay(rp) {
    this.rp = rp;
    this.show(-1);
    // who destroyed what: the recorder only says "Has been destroyed", so keep its time per unit
    this.destroyedAt = new Map();
    // records by recorded id (ids are reused after a unit is removed), for naming radar lock targets
    this.byId = new Map();
    for (let r = 0; r < rp.count; r++) {
      const id = rp.o.id[r];
      const list = this.byId.get(id);
      if (list) list.push(r); else this.byId.set(id, [r]);
    }
    for (const ev of rp.events) {
      if (/destroyed/i.test(ev.text || "")) for (const r of ev.recs || []) if (r >= 0 && !this.destroyedAt.has(r)) this.destroyedAt.set(r, ev.t);
    }
  }

  show(i) {
    this.i = i;
    this.root.hidden = i < 0;
    this.last = 0;
    if (i < 0 || !this.rp) return;
    this.title.textContent = labelOf(this.rp.o, i);
    this.side = undefined;
    this.paintSide(this.rp.o.coalition[i]);
  }

  // the side colour and name; a base's buildings can change hands, so update() repaints when it changes
  paintSide(side) {
    if (side === this.side) return;
    this.side = side;
    const o = this.rp.o, i = this.i;
    this.root.className = "plate inspector " + (SIDE_CLASS[side] || "neutral");
    const bits = [];
    if (o.pilot[i]) bits.push(o.name[i]);
    bits.push(SIDE_NAME[side] || "NEUTRAL");
    bits.push(KIND_NAME[o.kind[i]] || "UNIT");
    const cs = callSignOf(o, i);   // AI units only: a player's call sign repeats the type and their name
    if (cs) bits.push(cs);
    this.sub.textContent = bits.join("  ·  ").toUpperCase();
  }

  setFollowing(on) { this.follow.classList.toggle("off", !on); this.follow.setAttribute("aria-pressed", String(on)); }

  // a few times a second; groundAt for the height above ground when the recording has no AGL
  update(t, now, groundAt) {
    const i = this.i, rp = this.rp;
    if (i < 0 || !rp || now - this.last < 150) return;
    this.last = now;
    const o = rp.o, k = o.kind[i];
    this.paintSide(rp.sideAt(i, t));
    const here = rp.alive(i, t);
    const dead = this.destroyedAt.get(i);
    if (here && rp.visibleAt(i, t)) this.status.textContent = "";
    else if (dead !== undefined && t >= dead) this.status.textContent = "DESTROYED";
    else if (t < o.t0[i]) this.status.textContent = "NOT IN THE MISSION YET";
    else this.status.textContent = "GONE";
    if (!rp.poseAt(i, t, this.pos)) return;
    const alt = this.pos[1];
    const lines = [];
    lines.push(["ALT", fmt(alt, 0) + " M"]);
    const agl = rp.channelAt(CH.AGL, i, t);
    const ground = Number.isFinite(agl) ? agl : alt - Math.max(0, groundAt(this.pos[0], this.pos[2]));
    if (k !== KIND.SHIP) lines.push(["AGL", fmt(ground, 0) + " M"]);
    const tas = rp.channelAt(CH.TAS, i, t);
    if (Number.isFinite(tas)) lines.push(["SPD", fmt(tas * 3.6, 0) + " KM/H"]);
    const mach = rp.channelAt(CH.Mach, i, t);
    if (Number.isFinite(mach)) lines.push(["MACH", mach.toFixed(2)]);
    const s = rp.s, kk = rp.sampleAt(i, t);
    if (kk >= 0) lines.push(["HDG", String(Math.round(((s.yaw[kk] / 100) % 360 + 360) % 360)).padStart(3, "0")]);
    const aoa = rp.channelAt(CH.AOA, i, t);
    if (Number.isFinite(aoa) && (k === KIND.PLANE || k === KIND.HELI)) lines.push(["AOA", aoa.toFixed(1)]);
    const thr = rp.channelAt(CH.Throttle, i, t);
    if (Number.isFinite(thr)) lines.push(["THR", fmt(thr * 100, 0) + " %"]);
    const gear = rp.channelAt(CH.LandingGear, i, t);
    if (Number.isFinite(gear)) lines.push(["GEAR", gear > 0.5 ? "DOWN" : "UP"]);
    // what it has locked (Tomo: "Lock/s"), shown for every selected unit: the recorded LockedTarget list. On an aircraft
    // that is its picked or planned targets, on a missile the target it's guiding to.
    lines.push(["LOCK/S", lockList(o, lockedTargets(rp, i, t, this.byId))]);
    // the lock list can be long: it gets a whole line of its own, and wraps
    this.rows.innerHTML = lines.map(([a, b]) =>
      `<div class="row${a === "LOCK/S" ? " wide" : ""}"><span class="lbl">${a} :</span> <span>${esc(b)}</span></div>`).join("");
  }
}

// every target in the unit's recorded lock list at t, as record indices (one per slot, so a unit can be there twice)
function lockedTargets(rp, i, t, byId) {
  const L = rp.locks, n = L.count[i], out = [];
  if (!n) return out;
  const a = L.start[i], ids = new Float64Array(10);
  for (let q = a; q < a + n && L.t[q] <= t; q++) ids[L.slot[q]] = L.target[q];
  for (const id of ids) {
    if (!id) continue;
    // the record carrying that id at time t
    for (const r of byId.get(id) || []) if (rp.alive(r, t)) { out.push(r); break; }
  }
  return out;
}

// "NAME, NAME x2" for up to three names, then how many more
function lockList(o, recs) {
  if (!recs.length) return "NONE";
  const count = new Map();
  for (const r of recs) { const name = labelOf(o, r); count.set(name, (count.get(name) || 0) + 1); }
  const names = [...count].map(([name, n]) => (n > 1 ? `${name} x${n}` : name));
  return names.length > 3 ? names.slice(0, 3).join(", ") + ` +${names.length - 3} MORE` : names.join(", ");
}

function fmt(v, d) { return Number.isFinite(v) ? v.toLocaleString("en-GB", { maximumFractionDigits: d, minimumFractionDigits: d }) : "0"; }
function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]); }
