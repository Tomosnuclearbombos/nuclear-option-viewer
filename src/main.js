// Nuclear Option Viewer: wiring. Open a replay, show it on the map, play it.

import { Viewer } from "./scene/viewer.js";
import { Ground, mapKeyFor } from "./scene/ground.js";
import { Units } from "./scene/units.js";
import { Replay } from "./replay.js";
import { KIND } from "./parser/acmi.js";

const $ = (id) => document.getElementById(id);
const q = new URL(location.href).searchParams;
const viewer = new Viewer($("view"), { keepFrame: q.has("shot") });
const ground = new Ground(viewer.scene);
const units = new Units(viewer.scene);

const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128];
const state = { replay: null, t: 0, playing: false, speed: 6, lastNow: 0, mapLoaded: null };

// ---- opening a replay ------------------------------------------------------------------------------------
async function open(file) {
  showError("");
  $("start").hidden = false;
  const prog = $("progress");
  prog.hidden = false;
  setProgress(0, "Reading " + file.name);
  try {
    const result = await parseInWorker(file, (done, total) => setProgress(done / total, `Reading ${file.name}  ${Math.round((100 * done) / total)}%`));
    setProgress(1, "Building the scene");
    const replay = new Replay(result);
    const key = mapKeyFor(replay.header.mapId);
    if (key && state.mapLoaded !== key) {
      await ground.load(replay.header.mapId);
      state.mapLoaded = key;
    }
    start(replay, file.name);
  } catch (err) {
    console.error(err);
    showError("Couldn't open that file: " + (err.message || err));
    prog.hidden = true;
  }
}

function parseInWorker(file, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./parser/worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (m) => {
      const d = m.data;
      if (d.type === "progress") onProgress(d.done, d.total);
      else if (d.type === "done") { worker.terminate(); resolve(d.result); }
      else if (d.type === "error") { worker.terminate(); reject(new Error(d.message)); }
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || "worker failed")); };
    worker.postMessage({ file });
  });
}

function start(replay, fileName) {
  state.replay = replay;
  state.t = replay.tMin;
  state.playing = true;
  units.setReplay(replay);
  const h = replay.header;
  $("mission").innerHTML = `<b>${escapeHtml(h.title || fileName)}</b>  ·  ${escapeHtml(mapName(h.mapId))}  ·  ${escapeHtml(dateOf(h.recordingTime))}`;
  document.title = (h.title || "Replay") + " | Nuclear Option Viewer";
  $("start").hidden = true;
  $("transport").hidden = false;
  $("length").textContent = fmtDuration(replay.tMax - replay.tMin);
  buildActivity(replay);
  // start over the busiest area: the middle of the action, from a readable height
  const b = replay.bounds;
  const m = ground.meta;
  const x0 = m ? Math.max(b.x0, m.x0) : b.x0, x1 = m ? Math.min(b.x1, m.x1) : b.x1;
  const z0 = m ? Math.max(b.z0, -m.z1) : b.z0, z1 = m ? Math.min(b.z1, -m.z0) : b.z1;
  viewer.frameBox(x0, x1, z0, z1);
  updateSpeed();
}

// ---- playback ---------------------------------------------------------------------------------------------
viewer.onFrame = (now) => {
  const rp = state.replay;
  if (!rp) return;
  const dt = state.lastNow ? Math.min(0.25, (now - state.lastNow) / 1000) : 0;
  state.lastNow = now;
  if (state.playing) {
    state.t += dt * SPEEDS[state.speed];
    if (state.t >= rp.tMax) { state.t = rp.tMax; state.playing = false; }
  }
  units.update(state.t, viewer.camera, viewer.height);
  drawTimeline();
  $("clock").textContent = missionClock(rp, state.t);
  $("play").textContent = state.playing ? "❚❚" : "▶";
};

$("play").onclick = () => togglePlay();
$("slower").onclick = () => { state.speed = Math.max(0, state.speed - 1); updateSpeed(); };
$("faster").onclick = () => { state.speed = Math.min(SPEEDS.length - 1, state.speed + 1); updateSpeed(); };
function togglePlay() {
  const rp = state.replay;
  if (!rp) return;
  if (!state.playing && state.t >= rp.tMax) state.t = rp.tMin;
  state.playing = !state.playing;
}
function updateSpeed() { const s = SPEEDS[state.speed]; $("speed").textContent = (s < 1 ? s : Math.round(s)) + "×"; }

window.addEventListener("keydown", (e) => {
  if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
  const rp = state.replay;
  if (!rp) return;
  if (e.code === "Space") { togglePlay(); e.preventDefault(); }
  else if (e.key === "+" || e.key === "=") { state.speed = Math.min(SPEEDS.length - 1, state.speed + 1); updateSpeed(); }
  else if (e.key === "-" || e.key === "_") { state.speed = Math.max(0, state.speed - 1); updateSpeed(); }
  else if (e.code === "ArrowRight") seek(state.t + 5 * SPEEDS[state.speed] * (e.shiftKey ? 12 : 1));
  else if (e.code === "ArrowLeft") seek(state.t - 5 * SPEEDS[state.speed] * (e.shiftKey ? 12 : 1));
  else if (e.code === "Home") seek(rp.tMin);
  else if (e.code === "End") seek(rp.tMax);
});

function seek(t) { const rp = state.replay; state.t = Math.max(rp.tMin, Math.min(rp.tMax, t)); }

// ---- timeline: activity graph + playhead -------------------------------------------------------------------
const tl = $("timeline");
let activity = null;
function buildActivity(rp) {
  // aircraft, weapons and ground units alive per bucket of time
  const B = 600, span = rp.tMax - rp.tMin || 1;
  const air = new Float32Array(B), wpn = new Float32Array(B), gnd = new Float32Array(B);
  const o = rp.o;
  for (let i = 0; i < rp.count; i++) {
    const k = o.kind[i];
    const arr = k === KIND.PLANE || k === KIND.HELI ? air : k === KIND.MISSILE || k === KIND.BOMB ? wpn : k === KIND.GROUND || k === KIND.SHIP ? gnd : null;
    if (!arr || !o.sampleCount[i]) continue;
    const b0 = Math.max(0, Math.floor(((o.t0[i] - rp.tMin) / span) * B)), b1 = Math.min(B - 1, Math.floor(((o.t1[i] - rp.tMin) / span) * B));
    for (let b = b0; b <= b1; b++) arr[b]++;
  }
  activity = { B, air, wpn, gnd, max: Math.max(1, ...air, ...wpn) };
}

function drawTimeline() {
  const rp = state.replay;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(tl.clientWidth * dpr), h = Math.round(tl.clientHeight * dpr);
  if (tl.width !== w || tl.height !== h) { tl.width = w; tl.height = h; }
  const g = tl.getContext("2d");
  g.clearRect(0, 0, w, h);
  g.fillStyle = "rgba(255,255,255,0.06)";
  g.fillRect(0, 0, w, h);
  if (activity) {
    const { B, air, wpn, max } = activity;
    const bw = w / B;
    for (const [arr, col] of [[air, "rgba(111,195,255,0.55)"], [wpn, "rgba(255,150,80,0.55)"]]) {
      g.fillStyle = col;
      for (let b = 0; b < B; b++) { const v = arr[b] / max; if (v) g.fillRect(b * bw, h - v * (h - 4), Math.max(1, bw), v * (h - 4)); }
    }
  }
  const x = ((state.t - rp.tMin) / (rp.tMax - rp.tMin || 1)) * w;
  g.fillStyle = "#ffffff";
  g.fillRect(Math.round(x) - dpr, 0, 2 * dpr, h);
}

let scrubbing = false;
function scrubTo(ev) {
  const r = tl.getBoundingClientRect();
  const f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
  const rp = state.replay;
  seek(rp.tMin + f * (rp.tMax - rp.tMin));
}
tl.addEventListener("pointerdown", (e) => { if (!state.replay) return; scrubbing = true; tl.setPointerCapture(e.pointerId); scrubTo(e); });
tl.addEventListener("pointermove", (e) => { if (scrubbing) scrubTo(e); });
tl.addEventListener("pointerup", () => { scrubbing = false; });

// ---- file input + drag and drop ---------------------------------------------------------------------------
for (const id of ["file", "file2"]) $(id).addEventListener("change", (e) => { const f = e.target.files[0]; if (f) open(f); e.target.value = ""; });
let dragDepth = 0;
window.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; $("drop").hidden = false; });
window.addEventListener("dragleave", (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $("drop").hidden = true; } });
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault(); dragDepth = 0; $("drop").hidden = true;
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) open(f);
});

// ---- helpers ----------------------------------------------------------------------------------------------
function setProgress(f, label) {
  const p = $("progress");
  p.querySelector(".bar").style.width = Math.round(f * 100) + "%";
  p.querySelector(".label").textContent = label;
}
function showError(msg) { const e = $("error"); e.textContent = msg; e.hidden = !msg; }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }
function mapName(id) { return id === "NuclearOption.Terrain1" ? "Heartland" : id === "NuclearOption.Terrain_naval" ? "Ignus Archipelago" : id || "Unknown map"; }
function dateOf(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
function fmtDuration(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0");
}
// time of day in the mission: ReferenceTime carries it, frame times count seconds from it
function missionClock(rp, t) {
  const ref = new Date(rp.header.referenceTime);
  if (isNaN(ref)) return fmtDuration(t - rp.tMin);
  const d = new Date(ref.getTime() + t * 1000);
  return d.toISOString().slice(11, 19);
}

// for testing: ?replay=<url> opens a file from the site itself.
// &shot=<0..1> also jumps to that point of the mission, pauses, and POSTs a screenshot to /__result
// (tools/devserver.py). Optional &cam=x,y,z,tx,ty,tz places the camera.
if (q.get("replay")) {
  fetch(q.get("replay")).then((r) => r.blob()).then(async (b) => {
    await open(new File([b], q.get("replay").split("/").pop()));
    if (!q.has("shot")) return;
    const rp = state.replay;
    state.playing = false;
    seek(rp.tMin + parseFloat(q.get("shot") || "0.5") * (rp.tMax - rp.tMin));
    if (q.get("cam")) {
      const c = q.get("cam").split(",").map(Number);
      viewer.camera.position.set(c[0], c[1], c[2]);
      viewer.controls.target.set(c[3], c[4], c[5]);
    }
    let frames = 0;
    const t0 = performance.now();
    const prev = viewer.onFrame;
    viewer.onFrame = (now) => {
      prev(now);
      if (++frames === 40) {
        requestAnimationFrame(() => {
          const ms = (performance.now() - t0) / 40;
          const info = { t: state.t, alive: Object.fromEntries([...units.meshes].map(([k, m]) => [k, m.count])), msPerFrame: +ms.toFixed(1),
            gl: viewer.renderer.getContext().getParameter(viewer.renderer.getContext().VERSION), calls: viewer.renderer.info.render.calls };
          fetch("/__result", { method: "POST", body: JSON.stringify({ info, png: $("view").toDataURL("image/jpeg", 0.88) }) });
        });
      }
    };
  }).catch((e) => fetch("/__result", { method: "POST", body: JSON.stringify({ error: String(e) }) }));
}

window.nov = { viewer, ground, units, state, open };
