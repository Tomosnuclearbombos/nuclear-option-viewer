// The ATIS panel in live mode (Tomo, 11-08: "an ATIS feature please that shows the weather stats and a little direction
// symbol too for the wind direction"): the server's live weather from 2.4.0 (PvE+ and PvP+), published beside the live
// pieces as weather.json by tools/live_weather.py: the last few minutes of the plugin's samples, so the panel shows the
// weather at the playback time (about a minute behind). Hidden when there's no file, or the weather isn't running.
//
// The arrow points the way the wind blows, as seen on screen from the camera: windToDeg is the game's heading, 0 = +z
// (the recording's V, the scene's -z), 90 = +x.

const POLL_MS = 10000;

export class Atis {
  constructor(el) {
    this.el = el;
    this.letter = el.querySelector("#atis-letter");
    this.wind = el.querySelector("#atis-wind");
    this.sky = el.querySelector("#atis-sky");
    this.outlook = el.querySelector("#atis-outlook");
    this.arrow = el.querySelector("#atis-arrow");
    this.url = null;
    this.samples = [];
    this.shown = null;
    this.timer = 0;
  }

  // the live feed's current.json url, or null when not live
  setFeed(url) {
    clearInterval(this.timer);
    this.url = url ? url.replace(/current\.json(\?.*)?$/, "weather.json") : null;
    this.samples = [];
    this.shown = null;
    this.el.hidden = true;
    if (!this.url) return;
    const poll = async () => {
      try {
        const r = await fetch(this.url + "?t=" + Date.now(), { cache: "no-store" });
        if (!r.ok) { this.samples = []; return; }
        const w = await r.json();
        this.samples = (w && Array.isArray(w.samples) ? w.samples : []).filter((s) => s && s.v === 1);
        for (const s of this.samples) s.ms = Date.parse(s.utc);
      } catch { /* no file yet (a server without live weather), or the network: try again next time */ }
    };
    poll();
    this.timer = setInterval(poll, POLL_MS);
  }

  // each frame: the sample for the playback time, and the arrow turned to the camera
  update(rp, t, camera) {
    if (!this.url || !rp) return;
    const s = this.pick(rp, t);
    if (!s || !s.running) { if (!this.el.hidden) this.el.hidden = true; this.shown = null; return; }
    if (s !== this.shown) { this.show(s); this.shown = s; }
    if (this.el.hidden) this.el.hidden = false;
    // the wind's way in the scene (x = +x, z = -V), against the camera's right and its flat forward
    const d = (s.windToDeg * Math.PI) / 180, wx = Math.sin(d), wz = -Math.cos(d);
    const e = camera.matrixWorld.elements;
    const rx = e[0], rz = e[2];                       // camera right
    let fx = -e[8], fz = -e[10];                      // camera forward
    const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
    const ang = Math.atan2(wx * rx + wz * rz, wx * fx + wz * fz);
    this.arrow.style.transform = `rotate(${ang}rad)`;
  }

  // the newest sample at or before the playback time (its real time: the recording's start plus t), else the oldest
  pick(rp, t) {
    const list = this.samples;
    if (!list.length) return null;
    const start = Date.parse(rp.header.recordingTime || "");
    if (!Number.isFinite(start)) return list[list.length - 1];
    const now = start + t * 1000;
    let best = list[0];
    for (const s of list) if (s.ms <= now) best = s;
    return best;
  }

  show(s) {
    this.letter.textContent = "ATIS " + String(s.letter || "").toUpperCase();
    const from = String(Math.round(((s.windFromDeg % 360) + 360) % 360)).padStart(3, "0");
    const gust = s.gustKt > s.windKt ? ` G${Math.round(s.gustKt)}` : "";
    this.wind.textContent = `WIND ${from}° ${Math.round(s.windKt)} KT${gust}`;
    this.sky.textContent = `TURB ${String(s.turbWord || "").toUpperCase()} · ${String(s.sky || "").toUpperCase()}`;
    this.outlook.textContent = s.outlook ? "Outlook: " + s.outlook : "";
    this.outlook.hidden = !s.outlook;
  }
}
