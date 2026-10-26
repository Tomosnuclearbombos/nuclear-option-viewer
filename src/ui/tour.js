// The tour: a short look at what everything does, one step at a time (Tomo, 10-26: "add a tutorial to the page
// guiding people on what each option does, and they can skip it"). It starts by itself the first time a replay opens
// in a browser, and again from the KEYS panel. Each step lights up one part of the page and says what it does; the
// page underneath can't be clicked meanwhile, so every step finds it the way it left it.

const STORE = "nov.tour.v1";

// panel: the panel open for the step (none closes both); unit: the step needs a unit picked; target: what lights up,
// a selector or several (the box around them all), or none for a card in the middle; group: light up the whole
// settings group the target sits in; side: where the card goes first.
const STEPS = [
  { title: "QUICK TOUR",
    text: "Here's what everything does, one bit at a time. It takes about a minute. Skip it whenever you like, it's under KEYS if you want it again." },
  { title: "PLAYBACK", target: "#transport",
    text: "Play and pause, and set the speed from 0.1x to 128x. Click or drag the timeline to jump. The green trace shows how many aircraft are up, the amber bars how many weapons are flying." },
  { title: "MOVING AROUND",
    text: "Drag to move, right drag to turn, and scroll to zoom. On a phone, drag one finger to move, two fingers to turn, and pinch to zoom. Click or tap a unit to pick it; double click follows it." },
  { title: "UNITS", target: "#units-btn",
    text: "Every unit in the match. Search for a pilot and tap one to follow it." },
  { title: "THE UNIT YOU PICK", target: "#inspector", unit: true,
    text: "Its height, speed and heading, what it has locked, and whether the enemy can see it: DATA LINK, with the radars and eyes that have it. FOLLOW keeps the camera on it, CLEAR lets it go. LESS shrinks this down to the name and plane." },
  { title: "SETTINGS", target: "#settings-btn",
    text: "How the viewer looks and runs. Anything you change is saved in this browser. Here's what each part does." },
  { title: "LABELS, TRAILS AND CURTAINS", panel: "settings", target: '[data-set="labels"]', group: true, side: "left",
    text: "Labels name every aircraft and ship, or just the players. Trails show where units have been. Curtains hang down from each trail to the ground, so you can see how high it was flying." },
  { title: "LOCK LINES", panel: "settings", target: '[data-set="lockLines"]', group: true, side: "left",
    text: "A red line from a missile to the target it's flying at, or from a plane to the targets its pilot picked. Off to start with. Selected shows them for the unit you've picked, all shows everyone's." },
  { title: "RADAR, SIGHT AND PASSIVE", panel: "settings", target: '[data-set="radarLines"]', group: true, side: "left",
    text: "Who can see who. Yellow is a radar seeing a target, orange dots a unit seeing an enemy by eye, grey dashes a jet hearing an enemy radar. Off to start with. Selected shows what can see the unit you've picked." },
  { title: "MAP", panel: "settings", target: '[data-set="map"]', group: true, side: "left",
    text: "Terrain is the real ground with the map picture on it. Tactical is the game's own green map. Empty is just a grid at sea level." },
  { title: "UNIT SIZE", panel: "settings", target: '[data-set="units"]', group: true, side: "left",
    text: "Focus grows far units so you can always spot them, and focus size sets by how much. Real size shows everything at its true size, like Tacview." },
  { title: "UI SIZE AND CAMERA SLIDERS", panel: "settings", target: ['[data-set="ui"]', '[data-set="sliders"]'], group: true, side: "left",
    text: "Make the panels and keys bigger or smaller, and put sliders on screen to zoom, turn and tilt. Both are handy on a phone." },
  { title: "RANGE DOMES", panel: "settings", target: '[data-set="ranges"]', group: true, side: "left",
    text: "How far each unit's radar reaches, or how far it can see if it has no radar. Pick which kinds of units show them, or just the one you've picked." },
  { title: "GRAPHICS", panel: "settings", target: '[data-set="resolution"]', group: true, side: "left",
    text: "If it runs slow, lower the resolution or cap the frame rate first. Simple models, and scenery and effects off, help too." },
  { title: "KEYS", target: "#keys-btn",
    text: "Every key and mouse control, and this tour again." },
  { title: "OPEN REPLAY", target: "#top label.key",
    text: "That's everything. Open another replay here, or drop a .zip.acmi file anywhere on the page." },
];

export function tourSeen() {
  try { return localStorage.getItem(STORE) === "seen"; } catch { return true; }   // storage blocked: don't nag every visit
}

export class Tour {
  // ui: panel(name or null) opens that panel and closes the rest; pickUnit() picks a unit to show, if none is picked,
  // and says whether one is; done(pickedByTour) puts the page back
  constructor(root, ui) {
    this.root = root;
    this.ui = ui;
    this.spot = root.querySelector("#tour-spot");
    this.card = root.querySelector("#tour-card");
    this.titleEl = root.querySelector("#tour-title");
    this.countEl = root.querySelector("#tour-count");
    this.textEl = root.querySelector("#tour-text");
    this.back = root.querySelector("#tour-back");
    this.next = root.querySelector("#tour-next");
    this.skip = root.querySelector("#tour-skip");
    this.k = -1;
    this.back.addEventListener("click", () => this.go(this.k - 1, -1));
    this.next.addEventListener("click", () => (this.k >= STEPS.length - 1 ? this.end() : this.go(this.k + 1, 1)));
    this.skip.addEventListener("click", () => this.end());
    // while it's open, the keys are the tour's: Esc ends it, the arrows step through, and nothing reaches the viewer
    window.addEventListener("keydown", (e) => {
      if (this.root.hidden) return;
      e.stopPropagation();
      if (e.key === "Escape") this.end();
      else if (e.key === "ArrowRight") this.next.click();
      else if (e.key === "ArrowLeft" && this.k > 0) this.back.click();
      else return;
      e.preventDefault();
    }, true);
    window.addEventListener("resize", () => { if (!this.root.hidden) this.place(); });
  }

  get open() { return !this.root.hidden; }

  start() {
    this.picked = false;
    this.root.hidden = false;
    this.go(0, 1);
  }

  end() {
    this.root.hidden = true;
    this.k = -1;
    try { localStorage.setItem(STORE, "seen"); } catch { /* storage blocked */ }
    this.ui.done(this.picked);
  }

  // show step k; dir says which way to skip a step that can't be shown (no unit to pick)
  go(k, dir) {
    while (k >= 0 && k < STEPS.length) {
      const s = STEPS[k];
      this.ui.panel(s.panel || null);
      if (!s.unit) break;
      const had = this.ui.hasUnit();
      if (this.ui.pickUnit()) { if (!had) this.picked = true; break; }
      k += dir;
    }
    if (k < 0 || k >= STEPS.length) { this.end(); return; }
    this.k = k;
    const s = STEPS[k];
    this.titleEl.textContent = s.title;
    this.countEl.textContent = `${k + 1} / ${STEPS.length}`;
    this.textEl.textContent = s.text;
    this.back.hidden = k === 0;
    this.skip.hidden = k === STEPS.length - 1;
    this.next.textContent = k === STEPS.length - 1 ? "DONE" : "NEXT";
    // a settings group into the middle of its panel first, then measured once the page has caught up
    for (const el of this.targets(s)) if (s.group) el.scrollIntoView({ block: "center", inline: "nearest" });
    this.place();
    requestAnimationFrame(() => requestAnimationFrame(() => this.place()));
    this.next.focus({ preventScroll: true });
  }

  targets(s) {
    if (!s.target) return [];
    const els = [];
    for (const sel of [].concat(s.target)) {
      let el = document.querySelector(sel);
      if (el && s.group) el = el.closest(".set-group") || el;
      if (el && el.getClientRects().length) els.push(el);
    }
    return els;
  }

  // the light round the target, and the card next to it where it fits
  place() {
    const s = STEPS[this.k];
    if (!s) return;
    const W = window.innerWidth, H = window.innerHeight, M = 12, PAD = 6;
    const els = this.targets(s);
    let r = null;
    for (const el of els) {
      const b = el.getBoundingClientRect();
      r = r ? { l: Math.min(r.l, b.left), t: Math.min(r.t, b.top), r: Math.max(r.r, b.right), b: Math.max(r.b, b.bottom) }
        : { l: b.left, t: b.top, r: b.right, b: b.bottom };
    }
    this.root.classList.toggle("whole", !r);
    this.spot.hidden = !r;
    const cw = this.card.offsetWidth, ch = this.card.offsetHeight;
    let x = (W - cw) / 2, y = (H - ch) / 2;
    if (r) {
      r = { l: Math.max(2, r.l - PAD), t: Math.max(2, r.t - PAD), r: Math.min(W - 2, r.r + PAD), b: Math.min(H - 2, r.b + PAD) };
      Object.assign(this.spot.style, { left: r.l + "px", top: r.t + "px", width: r.r - r.l + "px", height: r.b - r.t + "px" });
      const midX = Math.min(Math.max(M, (r.l + r.r - cw) / 2), W - cw - M);
      const midY = Math.min(Math.max(M, (r.t + r.b - ch) / 2), H - ch - M);
      const spots = {
        below: H - r.b - M >= ch + M && [midX, r.b + M],
        above: r.t - M >= ch + M && [midX, r.t - M - ch],
        left: r.l - M >= cw + M && [r.l - M - cw, midY],
        right: W - r.r - M >= cw + M && [r.r + M, midY],
      };
      const pick = [s.side, "below", "above", "left", "right"].map((k) => spots[k]).find(Boolean);
      if (pick) [x, y] = pick;
      else [x, y] = [midX, (r.t + r.b) / 2 > H / 2 ? M : H - ch - M];   // no room anywhere: over the far half
    }
    this.card.style.left = Math.round(x) + "px";
    this.card.style.top = Math.round(y) + "px";
  }
}
