#!/usr/bin/env python3
"""Open the viewer in a real headless Firefox, load a replay the way a person does, and report what is on screen.

    python3 tools/uitest.py data/some.zip.acmi --shot /tmp/after-load.png
    python3 tools/uitest.py data/some.zip.acmi --size 2000x728 --shot /tmp/wide.png
    python3 tools/uitest.py data/some.zip.acmi -s key:Space -s timeline:0.2,0.6 -s shot:/tmp/scrubbed.png
    python3 tools/uitest.py                      # no replay: just the start page

What it does, in order
    1. starts tools/devserver.py on a free port and a headless Firefox with a fresh profile (tools/bidi.py)
    2. sets the viewport (--size, default 1600x900) and opens index.html
    3. records what is visible on the start page (a control: the start card should be showing here)
    4. puts the replay into the "Choose a replay" file input (#file2), which fires the same change event as a
       person picking a file, then waits until window.nov.state.replay is set (or the page shows an error)
    5. lets the scene settle (--settle), records what is visible, and times frames for --measure seconds
    6. runs the --step list, in order
    7. takes the --shot screenshot, prints the JSON report on stdout and exits

Steps (-s/--step, repeatable; coordinates are CSS pixels from the top left of the viewport)
    wait:S                 wait S seconds
    key:NAME               press a key on whatever has focus: Space, ArrowRight, Shift+ArrowRight, +, -, Home, End
    hold:NAME,S            hold a key (or chord, Shift+w) down for S seconds, then let go
    click:X,Y              left click at a point
    click:SELECTOR         left click the middle of an element, e.g. click:#play
    dblclick:X,Y           double click at a point (or the middle of an element)
    drag:X0,Y0,X1,Y1[,B]   drag with mouse button B (0 left = pan, 2 right = orbit; default 0)
    wheel:X,Y,DY           mouse wheel at a point (DY < 0 zooms in)
    timeline:F0[,F1]       press on the timeline at fraction F0 (0..1), drag to F1, release, like scrubbing
    seek:F                 move the playhead to fraction F directly through window.nov.state (no UI)
    pause / play           set window.nov.state.playing directly (no UI)
    measure:S              time frames for S seconds
    shot:PATH              screenshot of the viewport now
    eval:JS                evaluate a JS expression in the page and record its result

Visibility
    For each checked element the report gives the hidden attribute, the computed display and visibility, opacity
    multiplied up the ancestors, its rectangle, how much of the screen it covers, and "onTop": the share of a 5x5
    grid of points inside it where the element is painted on top (0 means something else covers it). "coverage"
    samples a 32x18 grid over the whole viewport and says which top level element is painted on top at each point,
    so {"#start": 0.94} means the start card hides 94% of the screen. These hit tests use elementFromPoint with
    pointer-events briefly forced on for every element (within one synchronous call, never painted), so overlays
    that let clicks through, like the top bar, still count where they are drawn. A half transparent overlay counts
    as on top where it is drawn. The one exception is #overlay, the clear label canvas over the 3D view. Click and drag steps record "hit": the element a real click there reaches.

Report and exit status
    The JSON report goes to stdout (and to --report PATH if given); progress goes to stderr.
    "problems" lists anything a person would notice: the replay not loading, the start card still showing after
    load, no transport bar, the 3D view mostly covered, console errors, failed requests.
    Exit 0: ran, no problems. Exit 1: ran, problems found. Exit 2: the harness itself failed.

Needs only Python 3.9+ and Firefox (no pip packages). --headed shows the window instead of running headless.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bidi import DevServer, Firefox, png_size  # noqa: E402

CHECK = ["#start", "#transport", "#top", "#view", "#timeline", "#play", "#progress", "#error", "#drop"]

# ---- page side helpers -------------------------------------------------------------------------------------------
VISIBILITY_JS = r"""
(sels) => {
  const vw = innerWidth, vh = innerHeight;
  const desc = (el) => {
    if (!el) return null;
    if (el.id) return "#" + el.id;
    const s = el.localName + (el.classList.length ? "." + [...el.classList].join(".") : "");
    const a = el.parentElement && el.parentElement.closest("[id]");
    return a ? "#" + a.id + " " + s : s;
  };
  // the top level element (a child of <body>) that a point belongs to
  const region = (el) => {
    while (el && el.parentElement && el.parentElement !== document.body) el = el.parentElement;
    return el && el !== document.body && el !== document.documentElement ? desc(el) : "(page background)";
  };

  // 1. styles and boxes, as the page has them
  const elements = {}, boxes = {};
  for (const sel of sels) {
    const el = document.querySelector(sel);
    if (!el) { elements[sel] = { exists: false, visible: false }; continue; }
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    let opacity = 1, displayed = true;
    for (let e = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      opacity *= parseFloat(s.opacity);
      if (s.display === "none") displayed = false;
    }
    const x0 = Math.max(r.left, 0), y0 = Math.max(r.top, 0);
    const ix = Math.max(0, Math.min(r.right, vw) - x0), iy = Math.max(0, Math.min(r.bottom, vh) - y0);
    boxes[sel] = { el, x0, y0, ix, iy };
    elements[sel] = {
      exists: true, hiddenAttr: el.hidden, display: cs.display, visibility: cs.visibility,
      opacity: +opacity.toFixed(3), pointerEvents: cs.pointerEvents,
      rect: [r.left, r.top, r.width, r.height].map(Math.round),
      screenFraction: +((ix * iy) / (vw * vh)).toFixed(3),
      checkVisibility: typeof el.checkVisibility === "function"
        ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : null,
      shown: displayed && cs.visibility === "visible" && opacity > 0.01 && ix * iy > 0,
    };
  }

  // 2. what is painted on top. elementFromPoint skips anything with pointer-events: none (the top bar is like
  // that), so for the rest of this synchronous call every element takes hits. The override is removed before the
  // browser can paint, so the page never looks or behaves any different. #overlay is left out: it is the clear
  // canvas the labels are drawn on, laid over the whole 3D view, and the map shows through it.
  const force = document.createElement("style");
  force.textContent = "*:not(#overlay), *::before, *::after { pointer-events: auto !important; }";
  document.head.appendChild(force);
  try {
    for (const sel in boxes) {
      const { el, x0, y0, ix, iy } = boxes[sel], e = elements[sel];
      let hits = 0, n = 0;
      if (ix > 0 && iy > 0) for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) {
        const t = document.elementFromPoint(x0 + ((i + 0.5) * ix) / 5, y0 + ((j + 0.5) * iy) / 5);
        n++;
        if (t && (t === el || el.contains(t))) hits++;
      }
      e.onTop = n ? +(hits / n).toFixed(2) : 0;
      e.visible = e.shown && e.onTop > 0;
      delete e.shown;
    }
    const GX = 32, GY = 18, coverage = {};
    for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) {
      const k = region(document.elementFromPoint(((i + 0.5) * vw) / GX, ((j + 0.5) * vh) / GY));
      coverage[k] = (coverage[k] || 0) + 1;
    }
    for (const k in coverage) coverage[k] = +(coverage[k] / (GX * GY)).toFixed(3);
    return {
      viewport: [vw, vh], elements, coverage,
      topAtCenter: desc(document.elementFromPoint(vw / 2, vh / 2)),
      activeElement: desc(document.activeElement),
    };
  } finally {
    force.remove();
  }
}
"""

APP_JS = r"""(() => {
  const s = window.nov && window.nov.state;
  if (!s) return null;
  const rp = s.replay, clock = document.getElementById("clock");
  return { loaded: !!rp, t: s.t, frac: rp ? +((s.t - rp.tMin) / (rp.tMax - rp.tMin || 1)).toFixed(4) : null,
           playing: s.playing, speed: (document.getElementById("speed") || {}).textContent || null,
           clock: clock ? clock.textContent : null };
})()"""

LOAD_JS = r"""(() => {
  const s = window.nov && window.nov.state, e = document.getElementById("error");
  const l = document.querySelector("#progress .label");
  return { loaded: !!(s && s.replay), error: e && !e.hidden && e.textContent ? e.textContent : null,
           progress: l ? l.textContent : null };
})()"""

REPLAY_JS = r"""(() => {
  const rp = window.nov.state.replay, h = rp.header;
  return { title: h.title, mapId: h.mapId, referenceTime: h.referenceTime, recordingTime: h.recordingTime,
           objects: rp.count, tMin: rp.tMin, tMax: rp.tMax, durationSeconds: +(rp.tMax - rp.tMin).toFixed(1) };
})()"""

WEBGL_JS = r"""(() => {
  const v = window.nov && window.nov.viewer;
  if (!v) return null;
  const gl = v.renderer.getContext(), ext = gl.getExtension("WEBGL_debug_renderer_info");
  return { version: gl.getParameter(gl.VERSION),
           vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
           renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
           drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight], contextLost: gl.isContextLost() };
})()"""

# rAF intervals (what a person feels) and, when the viewer is there, the CPU time of each frame's JS work
FRAMES_JS = r"""
(seconds) => new Promise((resolve) => {
  const v = window.nov && window.nov.viewer;
  const cpu = [], ts = [];
  let hadOwn = false, orig = null;
  if (v) {
    hadOwn = Object.prototype.hasOwnProperty.call(v, "frame");
    orig = v.frame;
    v.frame = function (now) { const a = performance.now(); orig.call(this, now); cpu.push(performance.now() - a); };
  }
  const stats = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b), q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    return { n: xs.length, mean: +mean.toFixed(2), p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2),
             p99: +q(0.99).toFixed(2), max: +s[s.length - 1].toFixed(2) };
  };
  const t0 = performance.now();
  const tick = (now) => {
    ts.push(now);
    if (now - t0 < seconds * 1000) return requestAnimationFrame(tick);
    if (v) { if (hadOwn) v.frame = orig; else delete v.frame; }
    const iv = ts.slice(1).map((t, i) => t - ts[i]);
    const span = ts[ts.length - 1] - ts[0];
    const info = v ? v.renderer.info : null;
    resolve({
      seconds: +(span / 1000).toFixed(2), fps: span > 0 ? +((iv.length * 1000) / span).toFixed(1) : 0,
      intervalMs: stats(iv), longFrames50ms: iv.filter((x) => x > 50).length,
      cpuMsPerFrame: stats(cpu),
      render: info ? { calls: info.render.calls, triangles: info.render.triangles, points: info.render.points,
                       lines: info.render.lines, geometries: info.memory.geometries, textures: info.memory.textures } : null,
    });
  };
  requestAnimationFrame(tick);
})
"""

NEXT_FRAMES_JS = "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))"

RECT_JS = r"""(sel) => { const el = document.querySelector(sel); if (!el) return null;
  const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; }"""

HIT_JS = r"""(x, y) => { const el = document.elementFromPoint(x, y); if (!el) return null;
  if (el.id) return "#" + el.id; const a = el.closest("[id]");
  return (a ? "#" + a.id + " " : "") + el.localName + (el.classList.length ? "." + [...el.classList].join(".") : ""); }"""


# ---- runner ------------------------------------------------------------------------------------------------------
class Run:
    def __init__(self, args):
        self.a = args
        self.t0 = time.monotonic()
        self.report: dict = {"ok": False, "problems": []}
        self.shots: list[dict] = []
        self.ff: Firefox | None = None

    def log(self, msg: str) -> None:
        if not self.a.quiet:
            print(f"[{time.monotonic() - self.t0:6.1f}s] {msg}", file=sys.stderr, flush=True)

    def visibility(self) -> dict:
        return self.ff.call(VISIBILITY_JS, CHECK + self.a.check)

    def app(self):
        return self.ff.eval_json(APP_JS)

    def shot(self, path: str) -> dict:
        png = self.ff.screenshot(path)
        w, h = png_size(png)
        item = {"path": os.path.abspath(path), "size": [w, h], "bytes": len(png), "app": self.app()}
        self.shots.append(item)
        self.log(f"screenshot {w}x{h} -> {path}")
        return item

    def frames(self, seconds: float) -> dict:
        self.log(f"timing frames for {seconds}s")
        return self.ff.call(FRAMES_JS, seconds, timeout=seconds + 30)

    def element_point(self, sel: str, fx: float = 0.5, fy: float = 0.5):
        r = self.ff.call(RECT_JS, sel)
        if not r:
            raise ValueError(f"no element {sel!r}")
        return r[0] + r[2] * fx, r[1] + r[3] * fy

    def step(self, spec: str) -> dict:
        ff = self.ff
        name, _, arg = spec.partition(":")
        rec: dict = {"step": spec}
        before = self.app()
        t = time.monotonic()
        if name == "wait":
            time.sleep(float(arg))
        elif name == "key":
            rec["focus"] = ff.eval_json("document.activeElement && (document.activeElement.id ? '#' + document.activeElement.id : document.activeElement.localName)")
            ff.press(arg)
        elif name == "hold":
            combo, _, secs = arg.rpartition(",")
            rec["focus"] = ff.eval_json("document.activeElement && (document.activeElement.id ? '#' + document.activeElement.id : document.activeElement.localName)")
            ff.hold(combo, float(secs))
        elif name == "click":
            if arg and not arg[0].isdigit() and arg[0] != "-":
                x, y = self.element_point(arg)
            else:
                x, y = (float(v) for v in arg.split(","))
            rec["at"], rec["hit"] = [round(x), round(y)], ff.call(HIT_JS, x, y)
            ff.click(x, y)
        elif name == "dblclick":
            if arg and not arg[0].isdigit() and arg[0] != "-":
                x, y = self.element_point(arg)
            else:
                x, y = (float(v) for v in arg.split(","))
            rec["at"], rec["hit"] = [round(x), round(y)], ff.call(HIT_JS, x, y)
            ff.dblclick(x, y)
        elif name == "drag":
            v = [float(s) for s in arg.split(",")]
            rec["hit"] = ff.call(HIT_JS, v[0], v[1])
            ff.drag(v[0], v[1], v[2], v[3], button=int(v[4]) if len(v) > 4 else 0)
        elif name == "wheel":
            x, y, dy = (float(s) for s in arg.split(","))
            rec["hit"] = ff.call(HIT_JS, x, y)
            ff.wheel(x, y, int(dy))
        elif name == "timeline":
            fs = [float(s) for s in arg.split(",")]
            f0, f1 = fs[0], fs[-1]
            x0, y = self.element_point("#timeline", f0)
            x1, _ = self.element_point("#timeline", f1)
            rec["at"], rec["hit"] = [round(x0), round(y), round(x1)], ff.call(HIT_JS, x0, y)
            if f0 == f1:
                ff.click(x0, y)
            else:
                ff.drag(x0, y, x1, y)
        elif name == "seek":
            ff.evaluate(f"(() => {{ const s = nov.state, rp = s.replay; s.t = rp.tMin + {float(arg)} * (rp.tMax - rp.tMin); }})()")
        elif name in ("pause", "play"):
            ff.evaluate(f"nov.state.playing = {'true' if name == 'play' else 'false'}")
        elif name == "measure":
            rec["frames"] = self.frames(float(arg))
        elif name == "shot":
            rec["shot"] = self.shot(arg)["path"]
        elif name == "eval":
            rec["result"] = ff.eval_json(arg)
        else:
            raise ValueError(f"unknown step {spec!r} (see --help)")
        if name not in ("wait", "measure", "shot"):
            ff.evaluate(NEXT_FRAMES_JS)   # let the page react before reading its state back
        rec["seconds"] = round(time.monotonic() - t, 2)
        rec["before"], rec["after"] = before, self.app()
        return rec

    def go(self) -> int:
        a, rep = self.a, self.report
        w, h = (int(v) for v in a.size.lower().split("x"))
        with DevServer(log=self.log) as srv, \
                Firefox(binary=a.firefox, headless=not a.headed, window_size=(w, h), log=self.log,
                        workdir=a.workdir) as ff:
            self.ff = ff
            caps = ff.session.get("capabilities", {})
            rep["browser"] = f"{caps.get('browserName', 'firefox')} {caps.get('browserVersion', '')}".strip()
            ff.set_viewport(w, h, a.dpr)
            url = srv.url(a.page)
            rep["page"] = url
            self.log(f"opening {url} at {w}x{h}")
            ff.navigate(url)
            ff.wait_for("!!window.nov", timeout=30)
            rep["viewport"] = {"requested": [w, h], **ff.eval_json(
                "({inner: [innerWidth, innerHeight], devicePixelRatio: devicePixelRatio})")}
            rep["webgl"] = ff.eval_json(WEBGL_JS)
            rep["startPage"] = self.visibility()

            if a.replay:
                path = os.path.abspath(a.replay)
                rep["replay"] = {"file": path, "bytes": os.path.getsize(path)}
                self.log(f"choosing {os.path.basename(path)} in #file2 ({os.path.getsize(path) / 1e6:.1f} MB)")
                t = time.monotonic()
                ff.set_files("#file2", [path])
                last = None
                while True:
                    st = ff.eval_json(LOAD_JS, timeout=180)
                    if st["progress"] and st["progress"] != last and not a.quiet:
                        last = st["progress"]
                        if last.endswith("0%") or "%" not in last:
                            self.log(last)
                    if st["loaded"] or st["error"]:
                        break
                    if time.monotonic() - t > a.timeout:
                        st["error"] = f"replay not loaded after {a.timeout}s (last progress: {last})"
                        break
                    time.sleep(0.2)
                rep["replay"]["loadSeconds"] = round(time.monotonic() - t, 2)
                if st["error"]:
                    rep["replay"]["error"] = st["error"]
                    rep["problems"].append(f"replay did not load: {st['error']}")
                    self.log(f"load failed: {st['error']}")
                else:
                    rep["replay"].update(ff.eval_json(REPLAY_JS))
                    self.log(f"loaded in {rep['replay']['loadSeconds']}s: {rep['replay']['title']}, "
                             f"{rep['replay']['objects']} objects")
                    time.sleep(a.settle)
                    rep["afterLoad"] = {**self.visibility(), "app": self.app()}
                    rep["webgl"] = ff.eval_json(WEBGL_JS)
                    if a.measure > 0:
                        rep["frames"] = self.frames(a.measure)

            rep["steps"] = []
            for spec in a.step:
                self.log(f"step {spec}")
                rec = self.step(spec)
                rep["steps"].append(rec)

            if a.shot:
                self.shot(a.shot)
            rep["end"] = {**self.visibility(), "app": self.app()}
            rep["screenshots"] = self.shots
            others = len(ff.console(("info", "debug")))
            rep["console"] = {"errors": ff.errors(), "warnings": ff.warnings(), "infoAndDebugCount": others}
            rep["network"] = {"failures": ff.network_failures}

        self.judge()
        rep["seconds"] = round(time.monotonic() - self.t0, 1)
        return 0 if rep["ok"] else 1

    def judge(self) -> None:
        rep, p = self.report, self.report["problems"]
        after = rep.get("afterLoad")
        if after:
            el, cov = after["elements"], after["coverage"]
            if el["#start"]["visible"]:
                p.append(f"start card still visible after the replay loaded: it covers {cov.get('#start', 0):.0%} "
                         f"of the screen (hidden attribute {el['#start']['hiddenAttr']}, computed display "
                         f"{el['#start']['display']!r})")
            if not el["#transport"]["visible"]:
                p.append("transport bar (play button and timeline) not visible after load")
            if cov.get("#view", 0) < 0.5:
                p.append(f"3D view mostly covered after load: the map canvas shows on only "
                         f"{cov.get('#view', 0):.0%} of the screen")
        gl = rep.get("webgl")
        if gl is None or gl.get("contextLost"):
            p.append("no working WebGL context")
        for e in rep.get("console", {}).get("errors", []):
            p.append(f"console error: {e['text']}" + (f" ({e['at']})" if e.get("at") else ""))
        for f in rep.get("network", {}).get("failures", []):
            if str(f.get("url", "")).endswith("/favicon.ico"):
                continue   # the browser asks for it on its own; nobody sees it fail
            p.append(f"request failed: {f.get('url')} {f.get('status') or f.get('error')}")
        rep["ok"] = not p


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog=__doc__.split("\n\n", 1)[1])
    ap.add_argument("replay", nargs="?", help="replay to open through the 'Choose a replay' input (.acmi / .zip.acmi)")
    ap.add_argument("--size", default="1600x900", help="viewport WIDTHxHEIGHT in CSS pixels (default 1600x900)")
    ap.add_argument("--dpr", type=float, default=None, help="device pixel ratio (default: Firefox's, 1 headless)")
    ap.add_argument("--page", default="index.html", help="page to open, relative to the repo (default index.html)")
    ap.add_argument("-s", "--step", action="append", default=[], metavar="STEP", help="a step to run after load (repeatable, see below)")
    ap.add_argument("--shot", metavar="PATH", help="screenshot at the end, after the steps")
    ap.add_argument("--report", metavar="PATH", help="also write the JSON report to this file")
    ap.add_argument("--settle", type=float, default=2.0, help="seconds to let the scene settle after load (default 2)")
    ap.add_argument("--measure", type=float, default=3.0, help="seconds of frame timing after load, 0 to skip (default 3)")
    ap.add_argument("--timeout", type=float, default=600, help="seconds to wait for the replay to load (default 600)")
    ap.add_argument("--check", action="append", default=[], metavar="SELECTOR", help="another element to report visibility for")
    ap.add_argument("--workdir", default=None, help="where the temporary Firefox profile goes (default: system temp)")
    ap.add_argument("--headed", action="store_true", help="show the Firefox window instead of running headless")
    ap.add_argument("--firefox", default="firefox", help="Firefox binary (default: firefox on PATH)")
    ap.add_argument("-q", "--quiet", action="store_true", help="no progress on stderr")
    a = ap.parse_args()
    if a.replay and not os.path.isfile(a.replay):
        ap.error(f"no such replay: {a.replay}")
    # timeout(1) and kill send SIGTERM: turn it into an exit so Firefox and the server are still cleaned up
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    run = Run(a)
    try:
        code = run.go()
    except Exception as e:  # the harness itself failed: still print what we have
        run.report["ok"] = False
        run.report["harnessError"] = f"{type(e).__name__}: {e}"
        if run.ff is not None:
            run.report.setdefault("console", {"errors": run.ff.errors(), "warnings": run.ff.warnings()})
        run.report["screenshots"] = run.shots
        code = 2
    out = json.dumps(run.report, indent=2)
    print(out)
    if a.report:
        os.makedirs(os.path.dirname(os.path.abspath(a.report)), exist_ok=True)
        with open(a.report, "w") as f:
            f.write(out + "\n")
    return code


if __name__ == "__main__":
    sys.exit(main())
