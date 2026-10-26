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
    text: "Quick look at what everything does. Skip any time, it's under KEYS." },
  { title: "PLAYBACK", target: "#transport",
    text: "Play, pause and speed. Click the timeline to jump." },
  { title: "MOVING AROUND",
    text: "Drag to move, right drag to turn, scroll to zoom. Click a unit to pick it." },
  { title: "UNITS", target: "#units-btn",
    text: "Every unit in the match. Tap one to follow it." },
  { title: "SELECTED UNIT", target: "#inspector", unit: true,
    text: "Speed, height, locks and who can see it. LESS hides the extra info." },
  { title: "SETTINGS", target: "#settings-btn",
    text: "Everything here saves in your browser." },
  { title: "LABELS, TRAILS AND CURTAINS", panel: "settings", target: '[data-set="labels"]', group: true, side: "left",
    text: "Names, where units have been, and how high they fly." },
  { title: "LOCK LINES", panel: "settings", target: '[data-set="lockLines"]', group: true, side: "left",
    text: "Green is what a unit has locked. Red is what has locked the unit you picked." },
  { title: "RADAR, SIGHT AND PASSIVE", panel: "settings", target: '[data-set="radarLines"]', group: true, side: "left",
    text: "Who can see who. Colours are in the key below." },
  { title: "MAP", panel: "settings", target: '[data-set="map"]', group: true, side: "left",
    text: "Real terrain, the game's tactical map, or an empty grid." },
  { title: "UNIT SIZE", panel: "settings", target: '[data-set="units"]', group: true, side: "left",
    text: "Focus keeps far units easy to spot. Real size is true to scale." },
  { title: "UI SIZE AND CAMERA SLIDERS", panel: "settings", target: ['[data-set="ui"]', '[data-set="sliders"]'], group: true, side: "left",
    text: "Bigger or smaller buttons, and camera sliders. Handy on a phone." },
  { title: "RANGE DOMES", panel: "settings", target: '[data-set="ranges"]', group: true, side: "left",
    text: "How far each unit's radar or eyes reach." },
  { title: "GRAPHICS", panel: "settings", target: '[data-set="resolution"]', group: true, side: "left",
    text: "Running slow? Turn these down." },
  { title: "KEYS", target: "#keys-btn",
    text: "All the controls, and this tour again." },
  { title: "OPEN REPLAY", target: "#top label.key",
    text: "Open another replay, or drop one on the page. That's it!" },
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
