// The info panel for the selected unit: who it is and live readouts, in the game's "LABEL : value" style.
// Units are metric, as in the game: metres, km/h.

import { KIND, CHANNELS, sideBit } from "../parser/acmi.js";
import { labelOf, callSignOf } from "../scene/overlay.js";
import { lockedTargets } from "../scene/locks.js";
import { holds } from "../scene/detects.js";

const CH = Object.fromEntries(CHANNELS.map((n, i) => [n, i]));
const SIDE_NAME = { Boscali: "BDF", Primeva: "PALA" };
const KIND_NAME = {
  [KIND.PLANE]: "AIRCRAFT", [KIND.HELI]: "HELICOPTER", [KIND.MISSILE]: "MISSILE", [KIND.BOMB]: "BOMB",
  [KIND.SHELL]: "SHELL", [KIND.SHIP]: "SHIP", [KIND.GROUND]: "GROUND UNIT", [KIND.BUILDING]: "BUILDING",
};
const SIDE_CLASS = { Boscali: "bdf", Primeva: "pala" };
const WIDE = new Set(["LOCK/S", "DATA LINK", "DETECTED BY"]);   // rows with a whole line of their own

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
    this.byRadar = []; this.bySight = [];
  }

  setReplay(rp) {
    this.rp = rp;
    this.show(-1);
    // who destroyed what: the recorder only says "Has been destroyed", so keep its time per unit
    this.destroyedAt = new Map();
    // the units with a radar or sight list, once per replay: for finding the enemy units that see the selected unit
    this.radars = []; this.sights = [];
    for (let r = 0; r < rp.count; r++) {
      if (rp.radarDetects.count[r]) this.radars.push(r);
      if (rp.sightDetects.count[r]) this.sights.push(r);
    }
    // records by recorded id (ids are reused after a unit is removed), for naming lock targets and reading the lists
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
    const here = rp.alive(i, t) && rp.visibleAt(i, t);
    const dead = this.destroyedAt.get(i);
    if (here) this.status.textContent = "";
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
    // the enemy units whose radar or eyes have it right now (Tomo, 10-26: "what has detected something")
    const side = rp.sideAt(i, t);
    const radar = this.seenBy(this.radars, rp.radarDetects, i, side, t, here, this.byRadar);
    const sight = this.seenBy(this.sights, rp.sightDetects, i, side, t, here, this.bySight, radar);
    // whether the enemy's data link has it (Tomo, 10-25), when the recording says (TrackedBy) and it's still there
    const tracked = here ? rp.trackedAt(i, t) : -1;
    const onLink = tracked < 0 || (tracked & ~sideBit(side)) !== 0;   // or the recording doesn't say
    if (tracked >= 0) {
      if (onLink) {
        // and how many enemy radars and eyes have it (Tomo: "add to detected how many"); passive detections reach
        // the data link too but aren't counted, so it can say DETECTED with none
        const n = radar.length, m = sight.length, parts = [];
        if (n) parts.push(`${n} ${n === 1 ? "RADAR" : "RADARS"}`);
        if (m) parts.push(`${m} BY SIGHT`);
        lines.push(["DATA LINK", parts.length ? `DETECTED (${parts.join(", ")})` : "DETECTED"]);
      } else lines.push(["DATA LINK", "NOT DETECTED"]);
    }
    // and which they are, on recordings with radar or sight lists. Not under NOT DETECTED: each list is its unit's last
    // full scan, so it can trail the data link by a scan (3 to 5 s on a corvette) when a target drops off.
    if (onLink && (radar.length || sight.length)) {
      const parts = [];
      if (radar.length) parts.push("RADAR: " + nameList(o, radar));
      if (sight.length) parts.push("SIGHT: " + nameList(o, sight));
      lines.push(["DETECTED BY", parts.join("; ")]);
    }
    // the lock and detection lists can be long: they get a whole line of their own, and wrap
    this.rows.innerHTML = lines.map(([a, b]) =>
      `<div class="row${WIDE.has(a) ? " wide" : ""}${a === "DETECTED BY" ? " by" : ""}"><span class="lbl">${a} :</span> <span>${esc(b)}</span></div>`).join("");
  }

  // the enemy units among holders (records with a list in series g) whose list has unit i at t, alive and not wrecks;
  // none when i isn't there. skip: units already counted (by radar), as each list is its own last scan and the two
  // can both have a target for a moment.
  seenBy(holders, g, i, side, t, here, out, skip) {
    out.length = 0;
    if (!here) return out;
    const rp = this.rp;
    for (const h of holders) {
      if (rp.alive(h, t) && rp.sideAt(h, t) !== side && holds(rp, g, h, i, t, this.byId) && rp.visibleAt(h, t) && !(skip && skip.includes(h))) out.push(h);
    }
    return out;
  }
}

function lockList(o, recs) { return recs.length ? nameList(o, recs) : "NONE"; }

// "NAME, NAME x2" for up to three names, then how many more
function nameList(o, recs) {
  const count = new Map();
  for (const r of recs) { const name = labelOf(o, r); count.set(name, (count.get(name) || 0) + 1); }
  const names = [...count].map(([name, n]) => (n > 1 ? `${name} x${n}` : name));
  return names.length > 3 ? names.slice(0, 3).join(", ") + ` +${names.length - 3} MORE` : names.join(", ");
}

function fmt(v, d) { return Number.isFinite(v) ? v.toLocaleString("en-GB", { maximumFractionDigits: d, minimumFractionDigits: d }) : "0"; }
function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]); }
