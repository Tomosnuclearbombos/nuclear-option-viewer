// Nuclear Option Viewer: wiring. Open a replay, show it on the map, play it.

import { Viewer } from "./scene/viewer.js";
import { Ground, mapKeyFor } from "./scene/ground.js";
import { Units } from "./scene/units.js";
import { Replay } from "./replay.js";
import { Timeline } from "./ui/timeline.js";
import { mapName, duration, missionClock, recorded, speedLabel } from "./ui/format.js";

const $ = (id) => document.getElementById(id);
const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128];
const state = { replay: null, t: 0, playing: false, speed: 6, lastNow: 0 };

// ---- 3D view (needs WebGL 2) -------------------------------------------------------------------------------
let viewer = null, ground = null, units = null;
try {
  viewer = new Viewer($("view"));
  ground = new Ground(viewer.scene);
  units = new Units(viewer.scene);
  viewer.groundAt = (x, z) => ground.surfaceAt(x, z);
  units.surfaceAt = viewer.groundAt;
} catch (err) {
  console.error(err);
  showStartError("This browser can't show 3D graphics. Turn on hardware acceleration in its settings, or try another browser.");
}

const timeline = new Timeline($("timeline"), {
  onSeek: (t) => seek(t),
  label: (t) => `${duration(t - state.replay.tMin)}  ${missionClock(state.replay.header.referenceTime, t)}`,
});

// ---- opening a replay ------------------------------------------------------------------------------------
// Only the newest open counts: opening another file while one is still loading cancels the first, and a file
// that fails to open leaves the replay you were watching exactly as it was.
let loadId = 0, job = null;

async function open(file, note = "") {
  if (!viewer) { showStartError("This browser can't show 3D graphics. Turn on hardware acceleration in its settings, or try another browser."); return; }
  const id = ++loadId;
  if (job) { job.cancel(); job = null; }
  ground.cancel();                    // a map still downloading for an earlier open must not land on screen
  hideToast();
  showProgress(0, "READING REPLAY");
  try {
    const result = await parseInWorker(file, (done, total) => { if (id === loadId) showProgress(done / total, "READING REPLAY"); });
    if (id !== loadId) return;
    showProgress(1, "BUILDING SCENE");
    const replay = new Replay(result);
    const known = mapKeyFor(replay.header.mapId) !== null;
    const loaded = await ground.load(replay.header.mapId);
    if (id !== loadId) return;
    hideProgress();
    start(replay, file.name);
    if (!known) showToast("This replay's map isn't in the viewer yet, so it plays over open sea.");
    else if (!loaded) showToast("The map didn't load. Units still play, but without terrain.");
    else if (note) showToast(note);
  } catch (err) {
    if (id !== loadId || err === CANCELLED) return;
    console.error(err);
    hideProgress();
    const msg = err && err.message ? err.message : "That file couldn't be opened.";
    if (state.replay) showToast(msg);
    else showStartError(msg);
  }
}

const CANCELLED = new Error("cancelled");
function parseInWorker(file, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./parser/worker.js", import.meta.url), { type: "module" });
    job = { cancel: () => { worker.terminate(); reject(CANCELLED); } };
    const done = () => { worker.terminate(); job = null; };
    worker.onmessage = (m) => {
      const d = m.data;
      if (d.type === "progress") onProgress(d.done, d.total);
      else if (d.type === "done") { done(); resolve(d.result); }
      else if (d.type === "error") { done(); reject(new Error(d.message)); }
    };
    worker.onerror = (e) => { done(); reject(new Error(e.message || "The replay reader stopped unexpectedly.")); };
    worker.postMessage({ file });
  });
}

function start(replay, fileName) {
  state.replay = replay;
  state.t = replay.tMin;
  state.playing = true;
  state.lastNow = 0;
  units.setReplay(replay);
  timeline.setReplay(replay);
  const h = replay.header;
  $("m-title").textContent = h.title || fileName;
  $("m-map").textContent = mapName(h.mapId);
  $("m-rec").textContent = recorded(h.recordingTime);
  document.title = (h.title || "Replay") + " | Nuclear Option Viewer";
  $("length").textContent = duration(replay.tMax - replay.tMin);
  $("start").hidden = true;
  $("top").hidden = false;
  $("transport").hidden = false;
  // start over the busiest area, from a readable height
  const b = replay.bounds, m = ground.meta;
  const x0 = m ? Math.max(b.x0, m.x0) : b.x0, x1 = m ? Math.min(b.x1, m.x1) : b.x1;
  const z0 = m ? Math.max(b.z0, -m.z1) : b.z0, z1 = m ? Math.min(b.z1, -m.z0) : b.z1;
  viewer.frameBox(x0, x1, z0, z1);
  updateSpeed();
}

// ---- playback ---------------------------------------------------------------------------------------------
if (viewer) viewer.onFrame = (now) => {
  const rp = state.replay;
  if (!rp) return;
  const dt = state.lastNow ? Math.min(0.25, (now - state.lastNow) / 1000) : 0;
  state.lastNow = now;
  if (state.playing) {
    state.t += dt * SPEEDS[state.speed];
    if (state.t >= rp.tMax) { state.t = rp.tMax; state.playing = false; }
  }
  units.update(state.t, viewer.camera, viewer.height);
  timeline.draw(state.t);
  $("clock").textContent = missionClock(rp.header.referenceTime, state.t);
  $("elapsed").textContent = duration(state.t - rp.tMin);
  const label = state.playing ? "PAUSE" : "PLAY";
  if ($("play").textContent !== label) $("play").textContent = label;
};

function togglePlay() {
  const rp = state.replay;
  if (!rp) return;
  if (!state.playing && state.t >= rp.tMax) state.t = rp.tMin;
  state.playing = !state.playing;
}
function changeSpeed(d) { state.speed = Math.max(0, Math.min(SPEEDS.length - 1, state.speed + d)); updateSpeed(); }
function updateSpeed() { $("speed").textContent = speedLabel(SPEEDS[state.speed]); }
function seek(t) { const rp = state.replay; if (rp) state.t = Math.max(rp.tMin, Math.min(rp.tMax, t)); }

$("play").addEventListener("click", togglePlay);
$("slower").addEventListener("click", () => changeSpeed(-1));
$("faster").addEventListener("click", () => changeSpeed(1));

window.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;              // leave browser shortcuts (zoom etc.) alone
  const tg = e.target;
  if (tg && (tg.tagName === "TEXTAREA" || tg.isContentEditable || (tg.tagName === "INPUT" && tg.type !== "file"))) return;
  if (e.key === "Escape") { toggleKeys(false); hideToast(); return; }
  const rp = state.replay;
  if (!rp) return;                                            // the start screen has no shortcuts
  if (e.key === "?") { toggleKeys(); return; }
  const skip = 5 * SPEEDS[state.speed] * (e.shiftKey ? 12 : 1);   // 5 s (or 60 s) of watching at any speed
  switch (e.code) {
    case "Space": if (!e.repeat) togglePlay(); break;
    case "ArrowRight": seek(state.t + skip); break;
    case "ArrowLeft": seek(state.t - skip); break;
    case "Home": seek(rp.tMin); break;
    case "End": seek(rp.tMax); break;
    default:
      if (e.key === "+" || e.key === "=") changeSpeed(1);
      else if (e.key === "-" || e.key === "_") changeSpeed(-1);
      else return;
  }
  e.preventDefault();   // also stops Space from clicking whichever button has focus
});

// ---- panels and messages ----------------------------------------------------------------------------------
function toggleKeys(show) {
  const p = $("keys");
  const on = show === undefined ? p.hidden : show;
  p.hidden = !on;
  $("keys-btn").setAttribute("aria-expanded", String(on));
}
$("keys-btn").addEventListener("click", () => toggleKeys());

function showProgress(f, label) {
  const first = !state.replay;
  const pct = Math.round(Math.max(0, Math.min(1, f)) * 100) + "%";
  if (first) {
    $("start").hidden = false;
    $("error").hidden = true;
    $("progress").hidden = false;
    $("progress-label").textContent = label;
    $("progress-pct").textContent = pct;
    $("progress-fill").style.width = pct;
  } else {
    $("loader").hidden = false;
    $("loader-label").textContent = label;
    $("loader-pct").textContent = pct;
    $("loader-fill").style.width = pct;
  }
}
function hideProgress() { $("progress").hidden = true; $("loader").hidden = true; }
function showStartError(msg) { const e = $("error"); e.textContent = msg; e.hidden = false; }
let toastTimer = 0;
function showToast(msg) {
  $("toast-msg").textContent = msg;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 12000);
}
function hideToast() { $("toast").hidden = true; }
$("toast-close").addEventListener("click", hideToast);

// ---- file input + drag and drop ---------------------------------------------------------------------------
for (const id of ["file", "file2"]) {
  $(id).addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    e.target.blur();                      // so Space and the other keys go back to the viewer
    if (f) open(f);
  });
}
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
window.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $("drop").hidden = false; });
window.addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $("drop").hidden = true; } });
window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("drop").hidden = true;
  const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
  if (!files.length) return;
  // several files dropped at once: open the first one that looks like a replay
  const replays = files.filter((f) => /\.(acmi|zip|gz)$/i.test(f.name));
  open(replays[0] || files[0], replays.length > 1 ? "Only the first replay was opened. Drop one at a time to switch." : "");
});

// for testing: ?replay=<url> opens a file from the site itself
const q = new URL(location.href).searchParams;
if (q.get("replay")) {
  fetch(q.get("replay"))
    .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.blob(); })
    .then((b) => open(new File([b], q.get("replay").split("/").pop())))
    .catch((e) => showStartError("Couldn't fetch that replay: " + e.message));
}

window.nov = { viewer, ground, units, state, open, timeline };
