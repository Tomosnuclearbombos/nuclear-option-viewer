// Nuclear Option Viewer: wiring. Open a replay, show it on the map, play it, pick and follow units.

import { Viewer } from "./scene/viewer.js";
import { Ground, mapKeyFor } from "./scene/ground.js";
import { Units, isMeshKind } from "./scene/units.js";
import { Trails } from "./scene/trails.js";
import { Overlay, labelOf } from "./scene/overlay.js";
import { CameraMan } from "./scene/camera.js";
import { ModelLibrary } from "./scene/models.js";
import { Scenery } from "./scene/scenery.js";
import { Blasts } from "./scene/blasts.js";
import { Replay } from "./replay.js";
import { KIND } from "./parser/acmi.js";
import { Timeline } from "./ui/timeline.js";
import { UnitList } from "./ui/unitlist.js";
import { Inspector } from "./ui/inspector.js";
import { loadSettings, SettingsPanel, RESOLUTION, FPS } from "./ui/settings.js";
import { mapName, duration, missionClock, recorded, speedLabel } from "./ui/format.js";

const $ = (id) => document.getElementById(id);
const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128];
const START_SPEED = SPEEDS.indexOf(1);   // every replay opens paused at 1X
const state = { replay: null, t: 0, playing: false, speed: START_SPEED, lastNow: 0, sel: -1 };
const NO_WEBGL = "This browser can't show 3D graphics. Turn on hardware acceleration in its settings, or try another browser.";

// the settings saved in this browser (the defaults on a first visit); smooth edges can only be set as the page opens
const settings = loadSettings();
const smoothInUse = settings.smooth === "on";

// ---- 3D view (needs WebGL 2) -------------------------------------------------------------------------------
let viewer = null, ground = null, scenery = null, blasts = null, units = null, trails = null, overlay = null, cameraMan = null;
try {
  viewer = new Viewer($("view"), { antialias: smoothInUse });
  ground = new Ground(viewer.scene);
  scenery = new Scenery(viewer.scene);
  units = new Units(viewer.scene);
  blasts = new Blasts(viewer.scene);
  trails = new Trails(viewer.scene);
  overlay = new Overlay($("overlay"));
  cameraMan = new CameraMan(viewer);
  viewer.groundAt = (x, z) => ground.surfaceAt(x, z);
  units.surfaceAt = viewer.groundAt;
} catch (err) {
  console.error(err);
  showStartError(NO_WEBGL);
}
const models = new ModelLibrary();

const timeline = new Timeline($("timeline"), {
  onSeek: (t) => seek(t),
  onNudge: (dir, big) => skip(dir, big),
  label: (t) => `${duration(t - state.replay.tMin)}  ${missionClock(state.replay.header.referenceTime, t)}`,
});
const unitList = new UnitList($("units"), { onPick: (i) => pickFromList(i) });
const inspector = new Inspector($("inspector"));

// ---- opening a replay ------------------------------------------------------------------------------------
// Only the newest open counts: opening another file while one is still loading cancels the first, and a file
// that fails to open leaves the replay you were watching exactly as it was.
let loadId = 0, job = null;

async function open(file, note = "") {
  if (!viewer) { showStartError(NO_WEBGL); return; }
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
    const loaded = await ground.load(replay.header.mapId, settings.map);
    if (id !== loadId) return;
    hideProgress();
    start(replay, file.name);
    scenery.setMap(loaded ? mapKeyFor(replay.header.mapId) : null);   // towns and bridges, fetched as you get near
    const notes = [];
    if (!known) notes.push("This replay's map isn't in the viewer yet, so it plays over open sea.");
    else if (!loaded) notes.push("The map didn't load. Units still play, but without terrain.");
    if (note) notes.push(note);
    if (notes.length) showToast(notes.join(" "));
    loadModels(replay, id);
  } catch (err) {
    if (id !== loadId || err === CANCELLED) return;
    console.error(err);
    hideProgress();
    const msg = err && err.message ? err.message : "That file couldn't be opened.";
    if (state.replay) showToast(msg);
    else showStartError(msg);
  }
}

// the real unit models, fetched in the background; units show as simple shapes until theirs arrives. Not fetched at all
// while the models setting is on simple.
async function loadModels(replay, id) {
  if (settings.models !== "detailed") return;
  const names = new Set();
  const o = replay.o;
  for (let i = 0; i < replay.count; i++) if (isMeshKind(o.kind[i]) && o.name[i]) names.add(o.name[i]);
  try {
    const found = await models.forNames([...names]);
    if (id !== loadId || state.replay !== replay) return;
    units.setModels(replay, found);
  } catch (e) {
    console.warn("models:", e);
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
  state.playing = false;
  state.speed = START_SPEED;
  state.lastNow = 0;
  units.setReplay(replay);
  blasts.setReplay(replay, replay.maxAlive[KIND.EXPLOSION]);
  trails.setReplay(replay);
  timeline.setReplay(replay);
  unitList.setReplay(replay);
  inspector.setReplay(replay);
  select(-1);
  overlay.hover = -1;
  const h = replay.header;
  $("m-title").textContent = h.title || fileName;
  $("m-map").textContent = mapName(h.mapId);
  $("m-rec").textContent = recorded(h.recordingTime);
  document.title = (h.title || "Replay") + " | Nuclear Option Viewer";
  $("length").textContent = duration(replay.tMax - replay.tMin);
  // room for the longest "elapsed / length" up front, so the timeline never shrinks as the clock grows
  $("length").parentElement.style.minWidth = 2 * $("length").textContent.length + 3 + "ch";
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

// ---- selection and following -------------------------------------------------------------------------------
function select(i) {
  state.sel = i;
  units.selected = i;
  overlay.selected = i;
  overlay.relative = -1;
  trails.selected = i;
  unitList.setSelected(i);
  inspector.show(i);
  if (i < 0) cameraMan.setFollow(-1);
  inspector.setFollowing(cameraMan.follow >= 0 && cameraMan.follow === i);
}

function follow(i) {
  const rp = state.replay;
  if (!rp || i < 0) return;
  if (!rp.alive(i, state.t)) seek(rp.o.t0[i] + 0.05);   // not around right now: jump to when it appears
  cameraMan.setFollow(i);
}

function toggleFollow() {
  if (state.sel < 0) return;
  if (cameraMan.follow === state.sel) cameraMan.setFollow(-1);
  else follow(state.sel);
}

function closeIn() {
  const rp = state.replay;
  if (!rp || state.sel < 0) return;
  if (!rp.alive(state.sel, state.t)) seek(rp.o.t0[state.sel] + 0.05);
  cameraMan.closeIn(rp, state.sel, state.t);
}

function pickFromList(i) { select(i); follow(i); }

if (cameraMan) cameraMan.onFollowChange = (i) => inspector.setFollowing(i >= 0 && i === state.sel);
$("insp-follow").addEventListener("click", toggleFollow);
$("insp-close").addEventListener("click", closeIn);
$("insp-clear").addEventListener("click", () => select(-1));

// hover, click and double click on units in the 3D view
if (viewer) {
  const canvas = viewer.canvas;
  let down = null, shift = false;
  const pt = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener("pointermove", (e) => {
    if (!state.replay || e.buttons) { overlay.hover = -1; return; }
    const [x, y] = pt(e);
    overlay.hover = overlay.pick(x, y);
    overlay.relative = e.shiftKey && state.sel >= 0 && overlay.hover !== state.sel ? overlay.hover : -1;
    shift = e.shiftKey;
    canvas.style.cursor = overlay.hover >= 0 ? "pointer" : "";
  });
  canvas.addEventListener("pointerleave", () => { overlay.hover = -1; if (!shift) overlay.relative = -1; });
  canvas.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, b: e.button }; });
  canvas.addEventListener("pointerup", (e) => {
    if (!down || !state.replay) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const b = down.b;
    down = null;
    if (moved > 4 || b !== 0 || e.shiftKey) return;   // a drag, another button, or Shift (range readout)
    const [x, y] = pt(e);
    const i = overlay.pick(x, y);
    if (i >= 0) select(i);
  });
  canvas.addEventListener("dblclick", (e) => {
    if (!state.replay) return;
    const [x, y] = pt(e);
    const i = overlay.pick(x, y);
    if (i >= 0) { select(i); follow(i); }
  });
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
  const t = state.t;
  cameraMan.update(dt, rp, t);
  scenery.update(viewer.camera, now);
  if (cameraMan.follow >= 0 || cameraMan.gyro) viewer.keepAboveGround();   // the camera moved: keep it above the hills
  viewer.camera.updateMatrixWorld();
  units.update(t, viewer.camera, viewer.height);
  if (settings.effects === "on") blasts.update(rp, t, units.booms, units.nBooms, viewer.camera, viewer.height);
  else if (blasts.mesh) blasts.mesh.count = 0;
  overlay.project(units.live, viewer.camera);
  trails.update(t, units.live, viewer.groundAt);
  overlay.draw(rp, hoverInfo, rangeInfo, t);
  unitList.update(t, now);
  inspector.update(t, now, viewer.groundAt);
  const b = unitList.hovered >= 0 ? unitList.hovered : state.sel;   // that unit's time in the mission
  timeline.band = b >= 0 ? [rp.o.t0[b], rp.o.t1[b]] : null;
  timeline.draw(t);
  $("clock").textContent = missionClock(rp.header.referenceTime, t);
  $("elapsed").textContent = duration(t - rp.tMin);
  const label = state.playing ? "PAUSE" : "PLAY";
  if ($("play").textContent !== label) $("play").textContent = label;
};

// the hover box: who it is, and height and speed
const SIDE_NAME = { Boscali: "BDF", Primeva: "PALA" };
const pose = new Float64Array(7);
function hoverInfo(i) {
  const rp = state.replay, o = rp.o;
  const lines = [labelOf(o, i)];
  const sub = [o.pilot[i] ? o.name[i] : "", SIDE_NAME[rp.sideAt(i, state.t)] || ""].filter(Boolean).join("  ");
  if (sub) lines.push(sub.toUpperCase());
  if (rp.poseAt(i, state.t, pose)) {
    const tas = rp.channelAt(0, i, state.t);   // TAS, m/s
    const k = o.kind[i];
    const bits = [];
    if (k !== KIND.SHIP && k !== KIND.GROUND && k !== KIND.BUILDING) bits.push("ALT " + Math.round(pose[1]).toLocaleString("en-GB") + " M");
    if (Number.isFinite(tas)) bits.push("SPD " + Math.round(tas * 3.6).toLocaleString("en-GB") + " KM/H");
    if (bits.length) lines.push(bits.join("  "));
  }
  return lines;
}

// the range readout between the selected unit (a) and another (b): range, height difference, closing speed
const pa = new Float64Array(7), pb = new Float64Array(7), qa = new Float64Array(7), qb = new Float64Array(7);
function rangeInfo(a, b) {
  const rp = state.replay, t = state.t;
  if (!rp.poseAt(a, t, pa) || !rp.poseAt(b, t, pb)) return [];
  const dx = pb[0] - pa[0], dy = pb[1] - pa[1], dz = pb[2] - pa[2];
  const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const lines = ["RNG " + (r / 1000).toFixed(r < 10000 ? 2 : 1) + " KM", "ALT " + (dy >= 0 ? "+" : "") + Math.round(dy).toLocaleString("en-GB") + " M"];
  // closing speed from where both were half a second ago
  if (rp.poseAt(a, t - 0.5, qa) && rp.poseAt(b, t - 0.5, qb)) {
    const r0 = Math.hypot(qb[0] - qa[0], qb[1] - qa[1], qb[2] - qa[2]);
    const vc = ((r0 - r) / 0.5) * 3.6;
    lines.push("VC " + Math.round(vc).toLocaleString("en-GB") + " KM/H");
  }
  return lines;
}

function togglePlay() {
  const rp = state.replay;
  if (!rp) return;
  if (!state.playing && state.t >= rp.tMax) state.t = rp.tMin;
  state.playing = !state.playing;
}
function changeSpeed(d) { state.speed = Math.max(0, Math.min(SPEEDS.length - 1, state.speed + d)); updateSpeed(); }
function updateSpeed() { $("speed").textContent = speedLabel(SPEEDS[state.speed]); }
function seek(t) { const rp = state.replay; if (rp) state.t = Math.max(rp.tMin, Math.min(rp.tMax, t)); }
// back or on by 5 s of watching at the current speed (60 s with Shift): 5 s of the mission at 1X, 40 s at 8X
function skip(dir, big) { seek(state.t + dir * 5 * SPEEDS[state.speed] * (big ? 12 : 1)); }

$("play").addEventListener("click", togglePlay);
$("slower").addEventListener("click", () => changeSpeed(-1));
$("faster").addEventListener("click", () => changeSpeed(1));

// ---- keys -------------------------------------------------------------------------------------------------
const MOVE_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "KeyQ", "KeyE", "PageUp", "PageDown", "ShiftLeft", "ShiftRight"]);

window.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;              // leave browser shortcuts (zoom etc.) alone
  const tg = e.target;
  if (tg && (tg.tagName === "TEXTAREA" || tg.isContentEditable || (tg.tagName === "INPUT" && tg.type !== "file"))) return;
  const rp = state.replay;
  if (e.key === "Escape") {
    if (!$("keys").hidden || !$("settings").hidden) { toggleKeys(false); toggleSettings(false); }
    else if (rp) select(-1);
    hideToast();
    return;
  }
  if (!rp) return;                                            // the start screen has no shortcuts
  if (MOVE_KEYS.has(e.code)) {
    cameraMan.keys.add(e.code);
    if (!e.code.startsWith("Shift")) e.preventDefault();      // arrows and page keys must not scroll anything
    return;
  }
  if (e.key === "?") { toggleKeys(); return; }
  switch (e.code) {
    case "Space": if (!e.repeat) togglePlay(); break;
    case "Period": skip(1, e.shiftKey); break;
    case "Comma": skip(-1, e.shiftKey); break;
    case "Home": seek(rp.tMin); break;
    case "End": seek(rp.tMax); break;
    case "KeyF": toggleFollow(); break;
    case "KeyZ": closeIn(); break;
    case "KeyH": cameraMan.frameAll(units.live); break;
    case "KeyU": toggleUnits(); break;
    case "KeyL": toggleLabels(); break;
    case "KeyT": toggleTrails(); break;
    case "KeyC": toggleCurtains(); break;
    default:
      if (e.key === "+" || e.key === "=") changeSpeed(1);
      else if (e.key === "-" || e.key === "_") changeSpeed(-1);
      else return;
  }
  e.preventDefault();   // also stops Space from clicking whichever button has focus
});
window.addEventListener("keyup", (e) => { if (cameraMan) cameraMan.keys.delete(e.code); });

// ---- panels, toggles and messages -------------------------------------------------------------------------
function setKey(btn, on) { btn.classList.toggle("off", !on); btn.setAttribute("aria-pressed", String(on)); }
function toggleUnits(show) {
  const p = $("units");
  const on = show === undefined ? p.hidden : show;
  p.hidden = !on;
  setKey($("units-btn"), on);
  if (on) unitList.dirty = true;
}
// labels, trails and curtains are settings too, so they stay the way you left them next time
function toggleLabels() { settingsPanel.set("labels", overlay.showLabels ? "off" : "on"); }
function toggleTrails() { settingsPanel.set("trails", trails.showTrails ? "off" : "on"); }
function toggleCurtains() { settingsPanel.set("curtains", trails.showCurtains ? "off" : "on"); }
$("units-btn").addEventListener("click", () => toggleUnits());
$("labels-btn").addEventListener("click", () => toggleLabels());
$("trails-btn").addEventListener("click", () => toggleTrails());
$("curtains-btn").addEventListener("click", () => toggleCurtains());
setKey($("units-btn"), false);

// the gyro, on touch screens only: turning and tilting the phone turns the view
const GYRO_SAYS = {
  insecure: "The gyro only works on the secure (https) site, like the GitHub one.",
  denied: "The phone didn't let the viewer read its motion sensor.",
  none: "This device didn't send any motion sensor readings.",
};
if (viewer && window.matchMedia("(pointer: coarse)").matches && "DeviceOrientationEvent" in window) $("gyro-btn").hidden = false;
$("gyro-btn").addEventListener("click", async () => {
  const on = !cameraMan.gyro;
  const result = await cameraMan.setGyro(on);
  setKey($("gyro-btn"), cameraMan.gyro);
  if (result !== "ok") showToast(GYRO_SAYS[result] || GYRO_SAYS.none);
});

// the controls list and the settings share a spot on screen, so opening one closes the other
function toggleKeys(show) {
  const p = $("keys");
  const on = show === undefined ? p.hidden : show;
  p.hidden = !on;
  $("keys-btn").setAttribute("aria-expanded", String(on));
  if (on) toggleSettings(false);
}
$("keys-btn").addEventListener("click", () => toggleKeys());
function toggleSettings(show) {
  const p = $("settings");
  const on = show === undefined ? p.hidden : show;
  p.hidden = !on;
  $("settings-btn").setAttribute("aria-expanded", String(on));
  if (on) toggleKeys(false);
}
$("settings-btn").addEventListener("click", () => toggleSettings());

// ---- settings --------------------------------------------------------------------------------------------
// puts one setting into effect; every one applies straight away except smooth edges (next time the page opens)
function applySetting(key, value) {
  if (!viewer) return;
  const on = value === "on";
  switch (key) {
    case "map":
      viewer.setLook(value);
      scenery.setLook(value);
      scenery.setShown(settings.scenery === "on" && value !== "empty");   // no ground for towns to stand on
      ground.setStyle(value).then((ok) => {
        if (ok || settings.map !== value) return;
        // the picture for that look couldn't be downloaded: stay on the one still showing
        settingsPanel.set("map", ground.style);
        showToast("That map look couldn't be loaded. Check your connection and try again.");
      });
      break;
    case "units": units.focus = value === "focus"; break;
    case "resolution": viewer.setRenderScale(RESOLUTION[value]); break;
    case "fps": viewer.maxFps = FPS[value]; break;
    case "models":
      units.setModelsOn(value === "detailed");
      if (value === "detailed" && state.replay && !units.modelSet) loadModels(state.replay, loadId);
      break;
    case "scenery": scenery.setShown(on && settings.map !== "empty"); break;
    case "effects": units.effects = on; break;
    case "labels": overlay.showLabels = on; setKey($("labels-btn"), on); break;
    case "trails": trails.showTrails = on; setKey($("trails-btn"), on); break;
    case "curtains": trails.showCurtains = on; setKey($("curtains-btn"), on); break;
  }
}
const settingsPanel = new SettingsPanel($("settings"), settings, applySetting, smoothInUse);
if (viewer) {
  ground.style = settings.map;   // the first map loads straight in the saved look
  for (const [k, v] of Object.entries(settings)) if (k !== "map") applySetting(k, v);
  viewer.setLook(settings.map);
  scenery.setLook(settings.map);
  scenery.setShown(settings.scenery === "on" && settings.map !== "empty");
}

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
  // several files dropped at once: open the first one that looks like a replay (.acmi and .zip.acmi before any
  // other .zip or .gz, which may be something else entirely)
  const replays = [...files.filter((f) => /\.acmi$/i.test(f.name)), ...files.filter((f) => /\.(zip|gz)$/i.test(f.name))];
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

window.nov = { viewer, ground, scenery, blasts, units, trails, overlay, cameraMan, models, state, open, timeline, unitList, inspector, select, follow };
