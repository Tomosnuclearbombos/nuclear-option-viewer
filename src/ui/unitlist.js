// The unit list: everyone present at the current time (or the whole replay), searchable, filtered by kind.
// Clicking a row selects that unit and follows it; a unit that isn't around right now is jumped to.
// Each life is its own row, so a pilot who died and came back three times has three, each with the time it began.
// The unit being watched stays in the list even when the filters would drop it (say it was just shot down), pinned
// to the top, until something else is selected.
//
// Rows are plain DOM from a fixed pool. A full rebuild runs only when the filters or the search change; the cheap
// refresh (who is present, the selected row) runs a few times a second.

import { KIND } from "../parser/acmi.js";
import { labelOf, callSignOf } from "../scene/overlay.js";
import { duration } from "./format.js";

const MAX_ROWS = 300;
const GROUPS = {
  air: [KIND.PLANE, KIND.HELI],
  sea: [KIND.SHIP],
  ground: [KIND.GROUND],
  weapons: [KIND.MISSILE, KIND.BOMB, KIND.SHELL],
};
const SIDE_CLASS = { Boscali: "bdf", Primeva: "pala" };

export class UnitList {
  constructor(root, { onPick }) {
    this.root = root;
    this.onPick = onPick;
    this.search = root.querySelector("#units-search");
    this.count = root.querySelector("#units-count");
    this.list = root.querySelector("#units-rows");
    this.toggles = root.querySelector(".toggles");
    this.presentOnly = true;
    this.groups = new Set(["air", "sea"]);
    this.rp = null;
    this.selected = -1;
    this.hoverRow = null;    // the row under the mouse (its unit's time in the mission shows on the timeline)
    this.rows = [];
    this.shown = [];
    this.lastRefresh = 0;
    this.dirty = true;

    for (const b of root.querySelectorAll("[data-group]")) {
      b.addEventListener("click", () => {
        const g = b.dataset.group;
        if (this.groups.has(g)) this.groups.delete(g); else this.groups.add(g);
        b.classList.toggle("off", !this.groups.has(g));
        b.setAttribute("aria-pressed", String(this.groups.has(g)));
        this.dirty = true;
      });
    }
    const present = root.querySelector("#units-present");
    present.addEventListener("click", () => {
      this.presentOnly = !this.presentOnly;
      present.classList.toggle("off", !this.presentOnly);
      present.setAttribute("aria-pressed", String(this.presentOnly));
      this.dirty = true;
    });
    this.search.addEventListener("input", () => { this.dirty = true; });
    this.search.addEventListener("keydown", (e) => { if (e.key === "Escape") { this.search.value = ""; this.search.blur(); this.dirty = true; } e.stopPropagation(); });
    this.list.addEventListener("click", (e) => {
      const row = e.target.closest("[data-i]");
      if (row) this.onPick(Number(row.dataset.i));
    });
    // the row element, not its unit: rows are reused as the list refreshes under a still mouse
    this.list.addEventListener("pointerover", (e) => { this.hoverRow = e.target.closest("[data-i]"); });
    this.list.addEventListener("pointerleave", () => { this.hoverRow = null; });
  }

  get hovered() {
    const r = this.hoverRow;
    return r && !r.hidden && !this.root.hidden && r.dataset.i !== undefined ? Number(r.dataset.i) : -1;
  }

  setSelected(i) {
    if (i === this.selected) return;
    this.selected = i;
    this.dirty = true;       // pin it (or unpin the last one)
  }

  setReplay(rp) {
    this.rp = rp;
    this.selected = -1;
    this.dirty = true;
    // the kind groups each record belongs to, once
    this.groupOf = new Array(rp.count);
    for (let i = 0; i < rp.count; i++) {
      const k = rp.o.kind[i];
      this.groupOf[i] = Object.keys(GROUPS).find((g) => GROUPS[g].includes(k)) || null;
    }
  }

  // called every frame; does real work a few times a second
  update(t, now) {
    if (!this.rp || this.root.hidden) return;
    if (!this.dirty && now - this.lastRefresh < 250) return;
    this.lastRefresh = now;
    this.t = t;
    const rp = this.rp, o = rp.o;
    if (this.dirty) {
      this.dirty = false;
      const q = this.search.value.trim().toLowerCase();
      const out = [];
      for (let i = 0; i < rp.count; i++) {
        const g = this.groupOf[i];
        if (!g || !o.sampleCount[i]) continue;
        if (q) {
          const hay = (o.pilot[i] + " " + o.name[i] + " " + o.callSign[i]).toLowerCase();
          if (!hay.includes(q)) continue;
        } else {
          if (!this.groups.has(g)) continue;
          if (this.presentOnly && !rp.alive(i, t)) continue;
        }
        out.push(i);
      }
      // present now: grouped by kind then name; whole replay or search: in the order they appeared, with the time
      const chrono = !this.presentOnly || !!q;
      if (!chrono) out.sort((a, b) => o.kind[a] - o.kind[b] || labelOf(o, a).localeCompare(labelOf(o, b)));
      else out.sort((a, b) => o.t0[a] - o.t0[b]);
      this.total = out.length;
      this.shown = out.slice(0, MAX_ROWS);
      // the unit being watched stays, pinned to the top, when the filters would drop it
      const sel = this.selected;
      this.pinned = sel >= 0 && sel < rp.count && !this.shown.includes(sel);
      if (this.pinned) this.shown.unshift(sel);
      this.list.classList.toggle("chrono", chrono);
      this.toggles.classList.toggle("muted", !!q);   // a search looks through everything, whatever these say
      this.render();
    }
    // cheap pass: who is present, and the selected row
    for (const row of this.rows) {
      if (row.hidden) continue;
      const i = Number(row.dataset.i);
      const here = rp.alive(i, t);
      row.classList.toggle("gone", !here);
      row.classList.toggle("selected", i === this.selected);
    }
    if (this.presentOnly && !this.search.value.trim()) this.dirty = true;   // the present set changes as time moves
  }

  render() {
    const rp = this.rp, o = rp.o;
    while (this.rows.length < this.shown.length) {
      const row = document.createElement("div");
      row.className = "unit-row";
      row.setAttribute("role", "listitem");
      row.innerHTML = '<span class="swatch"></span><span class="u-name"></span><span class="u-type"></span><span class="u-time"></span>';
      this.list.appendChild(row);
      this.rows.push(row);
    }
    this.rows.forEach((row, n) => {
      const i = this.shown[n];
      if (i === undefined) { row.hidden = true; return; }
      row.hidden = false;
      row.dataset.i = String(i);
      row.className = "unit-row " + (SIDE_CLASS[rp.sideAt(i, this.t)] || "neutral");
      const label = labelOf(o, i);
      row.children[1].textContent = label;
      row.children[2].textContent = o.pilot[i] ? o.name[i] : callSignOf(o, i);
      row.children[3].textContent = duration(o.t0[i] - rp.tMin);
    });
    const listed = this.shown.length - (this.pinned ? 1 : 0);   // the count is of what the filters found
    this.count.textContent = this.total > listed ? `${listed} OF ${this.total}` : String(this.total);
  }
}
