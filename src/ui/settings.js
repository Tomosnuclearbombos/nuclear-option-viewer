// The settings panel: how the map looks, how units are sized, the size of the panels and keys, the camera sliders,
// and graphics options that help a slower PC.
//
// Every choice is saved in this browser (localStorage), so it comes back next time the viewer opens. A browser that
// blocks storage (a private window, cleared site data) simply starts from the defaults each time; nothing breaks.

const STORE = "nov.settings.v1";

// each setting's allowed values, the first being the default
export const SETTINGS = {
  map: ["terrain", "tactical", "empty"],
  units: ["focus", "real"],
  focusSize: ["100", "80", "50", "25"],    // how big focus mode keeps far units, in percent
  ui: ["100", "80", "90", "120", "140"],   // size of the panels and keys, in percent
  sliders: ["off", "on"],                  // the camera sliders over the view
  lockLines: ["selected", "all", "off"],   // lines from units to what they have locked
  radarLines: ["selected", "all", "off"],  // lines from radars to what they see
  sightLines: ["selected", "all", "off"],  // lines from units to what they see by eye
  passiveLines: ["selected", "all", "off"], // lines from passive receivers to the radars they pick up
  ranges: ["off", "on"],                   // radar and sight range domes
  rangePlanes: ["on", "off"],              // ... for planes and helicopters,
  rangeShips: ["on", "off"],               // ships,
  rangeGround: ["on", "off"],              // ground units that move,
  rangeStationary: ["on", "off"],          // and ground units and buildings that stay put
  rangeSight: ["off", "on"],               // ground units and buildings without a radar (their sight range)
  rangeSelected: ["off", "on"],            // only the selected unit's range
  resolution: ["full", "high", "low"],
  fps: ["max", "60", "30"],
  smooth: ["on", "off"],
  models: ["detailed", "simple"],
  scenery: ["on", "off"],
  effects: ["on", "off"],
  labels: ["on", "off"],
  trails: ["on", "off"],
  curtains: ["off", "on"],
};
export const RESOLUTION = { full: 1, high: 0.75, low: 0.5 };
export const FPS = { max: 0, 60: 60, 30: 30 };

// what each choice does, under its row
const NOTES = {
  map: {
    terrain: "The real ground, with the map picture on it.",
    tactical: "The game's own green map, on the real ground.",
    empty: "No map, just a grid at sea level, like ACMI Viewer.",
  },
  units: {
    focus: "Units grow when they're far away, so you can always spot them.",
    real: "Every unit at its true size, like Tacview.",
  },
};

export function loadSettings() {
  const s = {};
  for (const [k, vals] of Object.entries(SETTINGS)) s[k] = vals[0];
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || "{}");
    if (saved && typeof saved === "object") {
      for (const [k, vals] of Object.entries(SETTINGS)) if (vals.includes(saved[k])) s[k] = saved[k];
    }
  } catch { /* storage blocked or garbled: the defaults */ }
  return s;
}

export function saveSettings(s) {
  try { localStorage.setItem(STORE, JSON.stringify(s)); } catch { /* storage blocked: kept for this visit only */ }
}

export class SettingsPanel {
  // el = the panel; settings = the live settings object; onChange(key, value) applies a change to the viewer.
  // smoothInUse = whether this page opened with smooth edges, which only changes when the viewer next opens.
  constructor(el, settings, onChange, smoothInUse) {
    this.el = el;
    this.settings = settings;
    this.onChange = onChange;
    this.smoothInUse = smoothInUse;
    el.addEventListener("click", (e) => {
      const flip = e.target.closest("button[data-toggle]");   // a key that is a setting of its own, on or off
      if (flip) { const k = flip.dataset.toggle; this.set(k, this.settings[k] === "on" ? "off" : "on"); return; }
      const btn = e.target.closest("button[data-val]");
      const row = btn && btn.closest("[data-set]");
      if (!row) return;
      this.set(row.dataset.set, btn.dataset.val);
    });
    this.refresh();
  }

  // change one setting (from the panel or a shortcut key), save it and apply it
  set(key, value) {
    if (!SETTINGS[key] || !SETTINGS[key].includes(value) || this.settings[key] === value) return;
    this.settings[key] = value;
    saveSettings(this.settings);
    this.refresh();
    this.onChange(key, value);
  }

  // the buttons and notes to match the settings
  refresh() {
    for (const row of this.el.querySelectorAll("[data-set]")) {
      const cur = this.settings[row.dataset.set];
      for (const b of row.querySelectorAll("button[data-val]")) {
        const on = b.dataset.val === cur;
        b.classList.toggle("off", !on);
        b.setAttribute("aria-pressed", String(on));
      }
    }
    for (const b of this.el.querySelectorAll("button[data-toggle]")) {
      const on = this.settings[b.dataset.toggle] === "on";
      b.classList.toggle("off", !on);
      b.setAttribute("aria-pressed", String(on));
    }
    for (const n of this.el.querySelectorAll("[data-note]")) {
      const k = n.dataset.note;
      if (k === "smooth") {
        n.hidden = (this.settings.smooth === "on") === this.smoothInUse;
        n.textContent = "Smooth edges change next time the viewer opens.";
      } else {
        n.textContent = (NOTES[k] && NOTES[k][this.settings[k]]) || "";
      }
    }
  }
}
