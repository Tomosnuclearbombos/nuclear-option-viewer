// The match's chat and activity, for the FEED panel and the chat overlay (Tomo, 11-04: "a live chat feed ... a proper
// activity feed where you can find when things were killed like the killfeed").
//
// From the recorder's lines (11-04 on; the formats are in CLAUDE.md under "Chat and activity lines"): chat, kills (and
// crashes), ejections and base captures, each a Tacview event whose text starts with a "[kind key=value ...]" header,
// values percent encoded. Launches come from a weapon's Parent (its launcher). Takeoffs and landings are worked out
// here from each aircraft's AGL and TAS: the game has no event for them. Older recordings have none of the recorder's
// lines, only "Has been destroyed.", so they list what was destroyed and nothing about who did it (Tomo: "Ignore for
// old ones, or victims only").

import { KIND, CHANNELS } from "./parser/acmi.js";
import { isDeath } from "./ui/inspector.js";

const CH_AGL = CHANNELS.indexOf("AGL"), CH_TAS = CHANNELS.indexOf("TAS");

// "[chat side=Boscali name=Tomo text=hi%2C%20all] Tomo: hi, all" -> { tag: "chat", f: { side, name, text }, tail }
export function readTag(text) {
  if (!text || text.charCodeAt(0) !== 91) return null;   // "["
  const end = text.indexOf("]");
  if (end < 0) return null;
  // fields are split on the ASCII space only: the recorder leaves other spaces (a no break space, a Japanese full width
  // space) unencoded inside a value
  const head = text.slice(1, end).split(" ").filter(Boolean);
  const tag = head.shift();
  if (!tag || !/^[a-z]+$/.test(tag)) return null;
  const f = {};
  for (const kv of head) {
    const eq = kv.indexOf("=");
    if (eq <= 0) continue;
    let v = kv.slice(eq + 1);
    try { v = decodeURIComponent(v); } catch { /* a stray % */ }
    f[kv.slice(0, eq)] = v;
  }
  return { tag, f, tail: text.slice(end + 1).trim() };
}

// the activity's unit groups (the game's own kill feed groups: Aircraft, Vehicle, Building, Ship, Munition)
const GROUP_OF_KILL = { Aircraft: "air", Vehicle: "ground", Building: "building", Ship: "sea", Munition: "weapon" };
function groupOfKind(k) {
  if (k === KIND.PLANE || k === KIND.HELI) return "air";
  if (k === KIND.GROUND) return "ground";
  if (k === KIND.BUILDING) return "building";
  if (k === KIND.SHIP) return "sea";
  if (k === KIND.MISSILE || k === KIND.BOMB || k === KIND.SHELL) return "weapon";
  return "";
}

// how a kill reads, from the game's KillType
const VERB = { shotdown: "shot down", destroyed: "destroyed", demolished: "demolished", intercepted: "intercepted", sank: "sank" };
const ALONE = { crashed: "crashed", collapsed: "collapsed", sank: "sank", destroyed: "was destroyed" };

// Each entry: t, type (chat, kill, crash, death, eject, capture, launch, takeoff, landing), rec (the unit to pick, or
// -1), group (air, ground, building, sea, weapon), sides (the sides involved), player (a player is in it), and the
// words: for chat name, side, rank and text; for the rest parts, a list of [text, side] runs ("" side: plain).
export function buildFeed(rp) {
  const o = rp.o, chat = [], act = [];
  const nameOf = (r) => (r >= 0 ? o.pilot[r] || o.name[r] || o.callSign[r] || "?" : "?");
  const kills = new Map();   // rec -> times of the recorder's kill lines, to drop the old "Has been destroyed." beside them

  for (const ev of rp.events) {
    const tg = readTag(ev.text);
    const r0 = ev.recs && ev.recs.length ? ev.recs[0] : -1;
    if (tg && tg.tag === "chat" && ev.kind === "Message") {
      const f = tg.f;
      chat.push({ t: ev.t, type: "chat", rec: r0, name: f.name || nameOf(r0), side: f.side || "", rank: f.rank || "", text: f.text || "" });
    } else if (tg && tg.tag === "kill") {
      const f = tg.f, how = f.how || "destroyed";
      const killer = f.killer || "", vname = f.vname || nameOf(r0);
      const crash = !killer;
      const parts = crash
        ? [[vname, f.vside], [" " + (ALONE[how] || ALONE.destroyed), ""]]
        : [[killer, f.kside], [" " + (VERB[how] || "destroyed") + " ", ""], [vname, f.vside]];
      if (!crash && f.weapon) parts.push([" with " + f.weapon, ""]);
      if (f.ff === "1") parts.push([" (friendly fire)", ""]);
      act.push({
        t: ev.t, type: crash ? "crash" : "kill", rec: r0, group: GROUP_OF_KILL[f.kind] || (r0 >= 0 ? groupOfKind(o.kind[r0]) : ""),
        sides: [f.vside, f.kside].filter(Boolean), player: f.vplayer === "1" || f.kplayer === "1", parts,
      });
      if (r0 >= 0) { const l = kills.get(r0); if (l) l.push(ev.t); else kills.set(r0, [ev.t]); }
    } else if (tg && tg.tag === "eject") {
      const f = tg.f;
      act.push({ t: ev.t, type: "eject", rec: r0, group: "air", sides: [f.side].filter(Boolean), player: f.player === "1",
        parts: [[f.name || nameOf(r0), f.side], [" ejected", ""]] });
    } else if (tg && tg.tag === "capture") {
      const f = tg.f;
      act.push({ t: ev.t, type: "capture", rec: -1, group: "building", sides: [f.side, f.from].filter(Boolean), player: false,
        parts: [[SIDE_NAME[f.side] || f.side || "?", f.side], [" captured " + (f.base || "a base"), ""]] });
    }
  }

  // the older "Has been destroyed." lines: what was destroyed, for recordings from before kill lines
  // With kill lines in the file they cover every kill the game reports, and an old line left over is scenery (a wall or
  // a pad knocked down by a blast: the game doesn't report those), so it isn't listed.
  for (const ev of kills.size ? [] : rp.events) {
    if (!isDeath(ev) || ev.kind !== "Message") continue;
    const r = ev.recs && ev.recs.length ? ev.recs[0] : -1;
    if (r < 0 || (kills.get(r) || []).some((kt) => Math.abs(kt - ev.t) < 5)) continue;
    act.push({ t: ev.t, type: "death", rec: r, group: groupOfKind(o.kind[r]), sides: [rp.sideAt(r, ev.t)].filter(Boolean),
      player: !!o.pilot[r], parts: [[nameOf(r), rp.sideAt(r, ev.t)], [" destroyed", ""]] });
  }

  // when each unit died, to tell a crash from a landing
  const died = new Map();
  for (const e of act) if ((e.type === "kill" || e.type === "crash" || e.type === "death") && e.rec >= 0 && !died.has(e.rec)) died.set(e.rec, e.t);

  for (let i = 0; i < rp.count; i++) {
    const k = o.kind[i];
    // launches: a missile or bomb whose launcher the recording names
    if ((k === KIND.MISSILE || k === KIND.BOMB) && o.parent && o.parent[i] >= 0) {
      const p = o.parent[i], t = o.t0[i], side = rp.sideAt(p, t);
      const parts = [[nameOf(p), side], [" fired " + (o.name[i] || "a weapon"), ""]];
      act.push({ t, type: "launch", rec: p, group: groupOfKind(o.kind[p]), sides: [side].filter(Boolean), player: !!o.pilot[p], parts });
    }
    if (k === KIND.PLANE || k === KIND.HELI) flights(rp, i, act, nameOf, died.get(i));
  }

  chat.sort((a, b) => a.t - b.t);
  act.sort((a, b) => a.t - b.t);
  return { chat, act, hasKills: kills.size > 0, oldDeaths: act.some((e) => e.type === "death") };
}

const SIDE_NAME = { Boscali: "BDF", Primeva: "PALA" };

// Takeoffs and landings of aircraft i: on the ground is under GROUND_AGL m and slower than its kind's taxi speed, in the
// air is over AIR_AGL m. A landing that ends in the aircraft being destroyed within a few seconds is a crash, not a
// landing, and is left out (the kill or the old destroyed line says it).
const GROUND_AGL = 3, AIR_AGL = 15, TAXI = { [KIND.PLANE]: 45, [KIND.HELI]: 15 };
function flights(rp, i, act, nameOf, death) {
  const a = rp.channels[CH_AGL], s = rp.channels[CH_TAS];
  const n = a.count[i];
  if (!n) return;
  const a0 = a.start[i], s0 = s.start[i], sn = s.count[i];
  const taxi = TAXI[rp.o.kind[i]] || 45, player = !!rp.o.pilot[i];
  // AGL and TAS walked together in time order: the recorder writes AGL only when it changes, so after touchdown it
  // sits at 0 with no more samples while TAS keeps coming down past taxi speed
  let state = "", k = a0, q = s0, tas = NaN, agl = NaN;
  while (k < a0 + n || q < s0 + sn) {
    let t;
    if (q >= s0 + sn || (k < a0 + n && a.t[k] <= s.t[q])) { t = a.t[k]; agl = a.v[k++]; }
    else { t = s.t[q]; tas = s.v[q++]; }
    if (agl !== agl) continue;   // no AGL yet
    const ground = agl < GROUND_AGL && !(tas > taxi), air = agl > AIR_AGL;
    if (!state) { state = ground ? "ground" : air ? "air" : ""; continue; }   // spawned in the air: no takeoff
    if (state === "ground" && air) {
      state = "air";
      const side = rp.sideAt(i, t);
      act.push({ t, type: "takeoff", rec: i, group: "air", sides: [side].filter(Boolean), player, parts: [[nameOf(i), side], [" took off", ""]] });
    } else if (state === "air" && ground) {
      state = "ground";
      if (death !== undefined && death >= t - 1 && death - t < 10) continue;   // came down and died: a crash
      const side = rp.sideAt(i, t);
      act.push({ t, type: "landing", rec: i, group: "air", sides: [side].filter(Boolean), player, parts: [[nameOf(i), side], [" landed", ""]] });
    }
  }
}

// Swear words turned to stars when the swear filter is on (Tomo, 11-04: "Swear filter works"). Slurs are already
// swapped out on the server by NukeStats; this is the everyday swearing it leaves. Whole words only, so "cockpit",
// "Dickson" and "Scunthorpe" stay as they are.
const SWEARS = /\b(?:f+u+c+k+\w*|fck\w*|fuk\w*|motherf\w*|sh[i1]t+(?:s|ty|ter|head|hole|ting)?|bullshit|c+u+n+t+s?|tw[a@]ts?|b[i1]tch(?:es|y|ing)?|bastards?|dick(?:s|head|heads)?|cocks?|cocksucker\w*|piss(?:ed|ing)?|wank\w*|pricks?|(?:ass|arse)holes?|dumbass|jackass|bollocks|wtf|stfu)\b/gi;
export function clean(text) {
  return text.replace(SWEARS, (w) => "*".repeat(w.length));
}
