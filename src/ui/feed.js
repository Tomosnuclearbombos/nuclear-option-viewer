// The FEED panel (chat and activity, one tab each) and the chat overlay: what src/feed.js finds in the recording, up to
// the playhead. A click on a line jumps there and picks the unit. In a replay, lines after the playhead are dimmed; live,
// they're hidden (live data runs ahead of what's on screen). The filters and switches are settings, saved like the rest.

import { buildFeed, clean } from "../feed.js";

const SIDE_CLASS = { Boscali: "bdf", Primeva: "pala" };
const KILLS = new Set(["kill", "crash", "death"]);
// which filter switch each line type and unit group answers to
const TYPE_KEY = { kill: "evKill", death: "evKill", crash: "evCrash", eject: "evEject", capture: "evCapture", launch: "evLaunch", takeoff: "evTakeoff", landing: "evLanding" };
const GROUP_KEY = { air: "fAir", ground: "fGround", building: "fBuilding", sea: "fSea", weapon: "fWeapon" };
const OVERLAY_LINES = 6, OVERLAY_S = 30, FADE_S = 5;

export class Feed {
  // root: the panel; overlay: the chat overlay; ui: { settings, set(key, value), seek(t), select(rec), clock(t) }
  constructor(root, overlay, ui) {
    this.root = root;
    this.overlay = overlay;
    this.ui = ui;
    this.lists = { chat: root.querySelector("#feed-chat"), act: root.querySelector("#feed-act") };
    this.notes = { chat: root.querySelector("#feed-chat-note"), act: root.querySelector("#feed-act-note") };
    this.data = { chat: [], act: [] };
    this.shown = { chat: [], act: [] };   // the entries in each list, in order
    this.cut = { chat: -1, act: -1 };     // how many of them are at or before the playhead
    this.follow = { chat: true, act: true };   // whether each list keeps the newest past line in view
    this.live = false;
    this.overKey = "";
    root.addEventListener("click", (e) => {
      const tab = e.target.closest("[data-tab]");
      if (tab) { this.ui.set("feedTab", tab.dataset.tab); return; }
      const sw = e.target.closest("[data-toggle]");
      if (sw) { const k = sw.dataset.toggle; this.ui.set(k, this.ui.settings[k] === "on" ? "off" : "on"); return; }
      const row = e.target.closest(".feed-row");
      if (row) this.pick(row.parentElement === this.lists.chat ? "chat" : "act", +row.dataset.i);
    });
    // scrolling a list by hand stops it following the playhead; back at the newest line, it follows again
    for (const k of ["chat", "act"]) {
      this.lists[k].addEventListener("scroll", () => { if (!this.scrolling) this.follow[k] = nearEnd(this.lists[k], this.cut[k] < 0 ? this.shown[k].length : this.cut[k]); });
    }
    overlay.addEventListener("click", (e) => {
      const row = e.target.closest(".feed-row");
      if (row) this.pick("chat", +row.dataset.i);
    });
  }

  get open() { return !this.root.hidden; }

  setReplay(rp, live) {
    this.rp = rp;
    this.live = !!live;
    this.data = buildFeed(rp);
    // a live rebuild keeps each list where the viewer left it
    const keep = { chat: this.lists.chat.scrollTop, act: this.lists.act.scrollTop };
    this.render();
    for (const k of ["chat", "act"]) if (!this.follow[k]) this.lists[k].scrollTop = keep[k];
  }

  // the panel opened: both lists go to the playhead
  opened() { this.cut = { chat: -1, act: -1 }; this.follow = { chat: true, act: true }; }

  // a setting changed: redraw what depends on it
  setting(key) {
    if (key === "feedTab" || key === "chat" || key === "feedFilters") this.showTab();
    if (key === "feedTab") { const k = this.ui.settings.feedTab; this.cut[k] = -1; this.follow[k] = true; }
    if (key === "chat" || key === "ranks" || key === "swears") { this.renderChat(); this.overKey = ""; }
    if (key in TYPE_KEY_SET || key in GROUP_KEY_SET || key === "fPlayers" || key === "fBdf" || key === "fPala") this.renderAct();
    this.refreshSwitches();
  }

  render() { this.renderChat(); this.renderAct(); this.showTab(); this.refreshSwitches(); this.overKey = ""; }

  showTab() {
    const tab = this.ui.settings.feedTab;
    this.root.querySelector(".feed-filters").hidden = this.ui.settings.feedFilters === "off";
    this.root.querySelector("[data-toggle=feedFilters]").hidden = tab !== "act";
    for (const b of this.root.querySelectorAll("[data-tab]")) {
      const on = b.dataset.tab === tab;
      b.classList.toggle("off", !on);
      b.setAttribute("aria-pressed", String(on));
    }
    this.root.querySelector("#feed-chat-view").hidden = tab !== "chat";
    this.root.querySelector("#feed-act-view").hidden = tab !== "act";
  }

  refreshSwitches() {
    for (const b of this.root.querySelectorAll("[data-toggle]")) {
      const on = this.ui.settings[b.dataset.toggle] === "on";
      b.classList.toggle("off", !on);
      b.setAttribute("aria-pressed", String(on));
    }
  }

  // ---- chat ---------------------------------------------------------------------------------------------------
  chatLine(c, i, cls) {
    const s = this.ui.settings, side = SIDE_CLASS[c.side] || "";
    const rank = s.ranks === "on" && c.rank ? `<span class="feed-rank">${esc(c.rank)}</span> ` : "";
    const text = s.swears === "on" ? clean(c.text) : c.text;
    return `<div class="feed-row ${cls}" data-i="${i}"><span class="feed-t">${this.ui.clock(c.t)}</span>` +
      `<span class="feed-x">${rank}<span class="feed-who ${side}">${esc(c.name)}</span>: ${esc(text)}</span></div>`;
  }

  renderChat() {
    const list = this.lists.chat, chat = this.data.chat, on = this.ui.settings.chat === "on";
    this.shown.chat = on ? chat : [];
    this.cut.chat = -1;
    list.innerHTML = this.shown.chat.map((c, i) => this.chatLine(c, i, "")).join("");
    this.notes.chat.textContent = !on ? "Chat is off. Turn it on in Settings." : chat.length ? "" : "No chat in this recording. Recordings have chat from 4 Nov 2026.";
    this.notes.chat.hidden = !this.notes.chat.textContent;
  }

  // ---- activity -----------------------------------------------------------------------------------------------
  passes(e) {
    const s = this.ui.settings;
    if (s[TYPE_KEY[e.type]] === "off") return false;
    if (e.group && s[GROUP_KEY[e.group]] === "off") return false;
    if (s.fPlayers === "on" && !e.player) return false;
    if (e.sides.length && !e.sides.some((sd) => (sd === "Boscali" ? s.fBdf : sd === "Primeva" ? s.fPala : "on") === "on")) return false;
    return true;
  }

  renderAct() {
    const list = this.lists.act, act = this.data.act.filter((e) => this.passes(e));
    this.shown.act = act;
    this.cut.act = -1;
    list.innerHTML = act.map((e, i) => `<div class="feed-row ${e.type}" data-i="${i}"><span class="feed-t">${this.ui.clock(e.t)}</span>` +
      `<span class="feed-x">${e.parts.map(([txt, side]) => (side && SIDE_CLASS[side] ? `<span class="feed-who ${SIDE_CLASS[side]}">${esc(txt)}</span>` : esc(txt))).join("")}</span></div>`).join("");
    const old = this.data.oldDeaths && !this.data.hasKills;
    this.notes.act.textContent = !this.data.act.length ? "Nothing yet." : !act.length ? "Nothing matches the filters." : old ? "This recording is from before kill lines, so it only says what was destroyed." : "";
    this.notes.act.hidden = !this.notes.act.textContent;
    // the kills on the timeline, as the filters show them (live: only up to the playhead, the timeline sees to that)
    this.ui.marks(act.filter((e) => KILLS.has(e.type)).map((e) => e.t), this.live);
  }

  // ---- each frame ---------------------------------------------------------------------------------------------
  update(t) {
    if (!this.rp) return;
    if (this.open) for (const k of ["chat", "act"]) this.mark(k, t);
    this.updateOverlay(t);
  }

  // dim or hide the lines after the playhead; keep the newest past line in view while the list is at the bottom
  mark(k, t) {
    const items = this.shown[k], list = this.lists[k];
    let cut = upper(items, t);
    if (cut === this.cut[k]) return;
    const prev = this.cut[k] < 0 ? items.length : this.cut[k];
    const rows = list.children;
    const a = Math.min(prev, cut), b = Math.max(prev, cut);
    for (let i = this.cut[k] < 0 ? 0 : a; i < (this.cut[k] < 0 ? items.length : b); i++) {
      const later = i >= cut;
      rows[i].classList.toggle("later", later);
      rows[i].hidden = later && this.live;
    }
    this.cut[k] = cut;
    if (this.follow[k] && cut > 0 && !list.closest("[hidden]")) {
      this.scrolling = true;
      bringIntoView(list, rows[cut - 1]);
      this.scrolling = false;
    }
  }

  // the last few chat lines, fading out (desktop only; style.css hides it on phones)
  updateOverlay(t) {
    const s = this.ui.settings, chat = this.data.chat;
    const end = s.chat === "on" ? upper(chat, t) : 0;
    let start = end;
    while (start > 0 && end - start < OVERLAY_LINES && chat[start - 1].t > t - OVERLAY_S) start--;
    const key = start + ":" + end;
    if (key !== this.overKey) {
      this.overKey = key;
      this.overlay.innerHTML = chat.slice(start, end).map((c, j) => this.chatLine(c, start + j, "")).join("");
      this.overlay.hidden = start === end;
    }
    const rows = this.overlay.children;
    for (let j = 0; j < rows.length; j++) {
      const age = t - chat[start + j].t;
      rows[j].style.opacity = String(Math.max(0, Math.min(1, (OVERLAY_S - age) / FADE_S)));
    }
  }

  pick(k, i) {
    const e = this.shown[k][i];
    if (!e) return;
    this.ui.seek(e.t - 3);
    if (e.rec >= 0) this.ui.select(e.rec);
    this.ui.picked();   // on a small screen the panel makes way for the unit's own
  }
}

const TYPE_KEY_SET = Object.fromEntries(Object.values(TYPE_KEY).map((k) => [k, 1]));
const GROUP_KEY_SET = Object.fromEntries(Object.values(GROUP_KEY).map((k) => [k, 1]));

// how many entries are at or before t (entries sorted by t)
function upper(items, t) {
  let lo = 0, hi = items.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (items[m].t <= t) lo = m + 1; else hi = m; }
  return lo;
}

// Whether row n-1 (the newest past line) is in view at the bottom of the list. In the list's own pixels (offsetTop,
// scrollTop and clientHeight; the list is positioned, so it is the rows' offsetParent): screen rectangles are scaled
// by the UI size zoom and would not match scrollTop.
function nearEnd(list, n) {
  if (n <= 0) return true;
  const row = list.children[n - 1];
  if (!row) return true;
  return row.offsetTop + row.offsetHeight <= list.scrollTop + list.clientHeight + 4;
}

// scroll the list (and only the list: scrollIntoView would scroll the panel too) so the row is in view
function bringIntoView(list, row) {
  const top = row.offsetTop, bottom = top + row.offsetHeight;
  if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  else if (top < list.scrollTop) list.scrollTop = top;
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }
