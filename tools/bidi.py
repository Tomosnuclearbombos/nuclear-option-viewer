"""Drive a real headless Firefox over WebDriver BiDi, with nothing but the Python standard library.

Tests that go through this see what a person sees: the whole page as Firefox paints it (DOM overlays on top of the
WebGL canvas), driven with real mouse, keyboard and file input events.

    from bidi import Firefox, DevServer
    with DevServer() as srv, Firefox() as ff:
        ff.set_viewport(1600, 900)
        ff.navigate(srv.url("index.html"))
        ff.set_files("#file2", ["data/replay.zip.acmi"])
        ff.wait_for("window.nov && window.nov.state.replay !== null", timeout=120)
        ff.screenshot("shot.png")
        print(ff.errors())

How it works
    Firefox is started with its built in Remote Agent (--remote-debugging-port 0, a fresh temporary profile,
    --no-remote so it never touches a Firefox you already have open). Firefox writes the port it picked to
    WebDriverBiDiServer.json in the profile; we open a WebSocket to ws://127.0.0.1:<port>/session and send
    session.new. Commands are JSON {id, method, params}; a reader thread matches each reply to its id and collects
    events (console messages, JS errors, failed network requests).

Why no websockets package
    The WebSocket client here is about 100 lines of stdlib code (RFC 6455: handshake, masked client frames,
    fragmentation, ping/pong, close). It only ever talks to Firefox on 127.0.0.1, so it needs no TLS or extensions,
    and the harness runs on any machine with Python 3.9+ and Firefox, with no venv, pip or network access.

Shutdown
    close() asks Firefox to quit (browser.close), then kills the process group it started (only that group: your own
    Firefox is never touched), and deletes the temporary profile. Firefox and DevServer are context managers and
    also clean up at interpreter exit.
"""
from __future__ import annotations

import atexit
import base64
import hashlib
import json
import os
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import Future
from concurrent.futures import TimeoutError as FutureTimeout

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# ---- WebSocket (RFC 6455), client side ---------------------------------------------------------------------------
class WebSocketClosed(Exception):
    pass


class WebSocket:
    """A minimal blocking WebSocket client: text messages in and out, enough for WebDriver BiDi on localhost."""

    GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

    def __init__(self, host: str, port: int, path: str = "/", timeout: float = 10.0):
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self._send_lock = threading.Lock()
        self._buf = b""
        key = base64.b64encode(os.urandom(16)).decode()
        # no Origin header: Firefox refuses WebSocket upgrades that carry one unless --remote-allow-origins says so
        req = (f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
        self.sock.sendall(req.encode())
        head = self._read_until(b"\r\n\r\n").decode("latin-1")
        status = head.split("\r\n", 1)[0]
        if " 101 " not in status + " ":
            raise ConnectionError(f"WebSocket upgrade refused: {status}")
        headers = {k.strip().lower(): v.strip() for k, _, v in (ln.partition(":") for ln in head.split("\r\n")[1:]) if k}
        want = base64.b64encode(hashlib.sha1((key + self.GUID).encode()).digest()).decode()
        if headers.get("sec-websocket-accept") != want:
            raise ConnectionError("WebSocket upgrade: bad Sec-WebSocket-Accept")
        self.sock.settimeout(None)   # reads block; close() unblocks them

    def _read_until(self, marker: bytes) -> bytes:
        while marker not in self._buf:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise WebSocketClosed("connection closed during handshake")
            self._buf += chunk
        head, _, self._buf = self._buf.partition(marker)
        return head

    def _read_exact(self, n: int) -> bytes:
        if len(self._buf) < n:
            # gather in a list: screenshots arrive as multi-MB messages, and += on bytes would copy quadratically
            chunks, have = [self._buf], len(self._buf)
            while have < n:
                chunk = self.sock.recv(min(max(65536, n - have), 1 << 22))
                if not chunk:
                    raise WebSocketClosed("connection closed")
                chunks.append(chunk)
                have += len(chunk)
            self._buf = b"".join(chunks)
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        n = len(payload)
        head = bytes([0x80 | opcode])
        if n < 126:
            head += bytes([0x80 | n])
        elif n < 65536:
            head += bytes([0x80 | 126]) + struct.pack("!H", n)
        else:
            head += bytes([0x80 | 127]) + struct.pack("!Q", n)
        mask = os.urandom(4)
        # client frames must be masked; XOR through int keeps this fast for big payloads
        m = int.from_bytes((mask * (n // 4 + 1))[:n], "big") if n else 0
        body = (int.from_bytes(payload, "big") ^ m).to_bytes(n, "big") if n else b""
        with self._send_lock:
            self.sock.sendall(head + mask + body)

    def send_text(self, text: str) -> None:
        self._send_frame(0x1, text.encode("utf-8"))

    def recv_text(self) -> str:
        """Next complete text message. Answers pings; raises WebSocketClosed on close."""
        parts: list[bytes] = []
        while True:
            b0, b1 = self._read_exact(2)
            fin, opcode = b0 & 0x80, b0 & 0x0F
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack("!H", self._read_exact(2))[0]
            elif n == 127:
                n = struct.unpack("!Q", self._read_exact(8))[0]
            mask = self._read_exact(4) if b1 & 0x80 else None
            payload = self._read_exact(n)
            if mask:
                m = int.from_bytes((mask * (n // 4 + 1))[:n], "big")
                payload = (int.from_bytes(payload, "big") ^ m).to_bytes(n, "big")
            if opcode == 0x9:                       # ping
                self._send_frame(0xA, payload)
                continue
            if opcode == 0xA:                       # pong
                continue
            if opcode == 0x8:                       # close
                try:
                    self._send_frame(0x8, payload[:2])
                except OSError:
                    pass
                raise WebSocketClosed("closed by peer")
            parts.append(payload)                   # text (1), binary (2) or continuation (0)
            if fin:
                return b"".join(parts).decode("utf-8")

    def close(self) -> None:
        try:
            self._send_frame(0x8, struct.pack("!H", 1000))
        except OSError:
            pass
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.sock.close()


# ---- BiDi protocol -----------------------------------------------------------------------------------------------
class BiDiError(Exception):
    """A BiDi command failed (error reply) or a script threw."""


class ScriptError(BiDiError):
    pass


KEYS = {  # WebDriver key codes for named keys (https://w3c.github.io/webdriver/#keyboard-actions)
    "Space": " ", "Enter": "\uE007", "Return": "\uE007", "Escape": "\uE00C", "Esc": "\uE00C", "Tab": "\uE004",
    "Backspace": "\uE003", "Delete": "\uE017", "Shift": "\uE008", "Control": "\uE009", "Ctrl": "\uE009",
    "Alt": "\uE00A", "Meta": "\uE03D", "PageUp": "\uE00E", "PageDown": "\uE00F", "End": "\uE010", "Home": "\uE011",
    "ArrowLeft": "\uE012", "Left": "\uE012", "ArrowUp": "\uE013", "Up": "\uE013", "ArrowRight": "\uE014",
    "Right": "\uE014", "ArrowDown": "\uE015", "Down": "\uE015", "Plus": "+", "Minus": "-",
    **{f"F{i}": chr(0xE031 + i - 1) for i in range(1, 13)},
}


def key_value(name: str) -> str:
    """'Space' -> ' ', 'ArrowRight' -> WebDriver code, 'a' -> 'a'."""
    if name in KEYS:
        return KEYS[name]
    if len(name) == 1:
        return name
    raise ValueError(f"unknown key {name!r}; use a single character or one of: {', '.join(sorted(KEYS))}")


def deserialize(v):
    """Turn a BiDi RemoteValue into plain Python. Nodes come back as {'sharedId': ..., 'nodeType': ...}."""
    if not isinstance(v, dict) or "type" not in v:
        return v
    t, val = v["type"], v.get("value")
    if t in ("undefined", "null"):
        return None
    if t == "number":
        return {"NaN": float("nan"), "-0": -0.0, "Infinity": float("inf"), "-Infinity": float("-inf")}.get(val, val) \
            if isinstance(val, str) else val
    if t in ("string", "boolean"):
        return val
    if t == "bigint":
        return int(val)
    if t in ("array", "set", "nodelist", "htmlcollection"):
        return [deserialize(x) for x in (val or [])]
    if t in ("object", "map"):
        return {(k if isinstance(k, str) else json.dumps(deserialize(k))): deserialize(x) for k, x in (val or [])}
    if t == "date":
        return val
    if t == "node":
        return {"sharedId": v.get("sharedId"), **{k: x for k, x in (val or {}).items() if k in ("nodeType", "localName")}}
    return {"type": t, **({"handle": v["handle"]} if "handle" in v else {})}


class Firefox:
    """A headless Firefox with a fresh profile, driven over WebDriver BiDi."""

    DEFAULT_PREFS = {
        # WebGL on, even without a display (headless) or on a blocklisted driver
        "webgl.force-enabled": True,
        "webgl.disabled": False,
        "layers.acceleration.force-enabled": True,
        # performance.now() and rAF times to the microsecond instead of rounded to 1 ms, for frame timing
        "privacy.reduceTimerPrecision": False,
        # quiet first run
        "browser.shell.checkDefaultBrowser": False,
        "browser.aboutwelcome.enabled": False,
        "browser.startup.homepage_override.mstone": "ignore",
        "datareporting.policy.dataSubmissionEnabled": False,
        "toolkit.telemetry.reportingpolicy.firstRun": False,
        "app.update.disabledForTesting": True,
    }

    def __init__(self, binary: str = "firefox", headless: bool = True, window_size: tuple[int, int] = (1600, 900),
                 prefs: dict | None = None, workdir: str | None = None, log=None, start_timeout: float = 30.0):
        self.binary, self.headless, self.window_size = binary, headless, window_size
        self.prefs = {**self.DEFAULT_PREFS, **(prefs or {})}
        self.workdir = workdir
        self.log = log or (lambda msg: None)
        self.start_timeout = start_timeout
        self.proc: subprocess.Popen | None = None
        self.ws: WebSocket | None = None
        self.tmp: str | None = None
        self.context: str | None = None
        self.entries: list[dict] = []        # log.entryAdded params, in arrival order
        self.network_failures: list[dict] = []
        self.event_handlers: list = []       # callables(method, params)
        self._next_id = 0
        self._pending: dict[int, Future] = {}
        self._lock = threading.Lock()
        self._reader: threading.Thread | None = None
        self._closed = False

    # -- lifecycle --
    def __enter__(self):
        self.start()
        return self

    def __exit__(self, *exc):
        self.close()

    def start(self) -> "Firefox":
        # if starting fails, __exit__ never runs (the with statement never began): clean up here instead
        try:
            return self._start()
        except BaseException:
            self.close()
            raise

    def _start(self) -> "Firefox":
        atexit.register(self.close)
        self.tmp = tempfile.mkdtemp(prefix="nov-firefox-", dir=self.workdir)
        profile = os.path.join(self.tmp, "profile")
        os.makedirs(profile)
        with open(os.path.join(profile, "user.js"), "w") as f:
            for k, v in self.prefs.items():
                f.write(f"user_pref({json.dumps(k)}, {json.dumps(v)});\n")
        args = [self.binary, "--no-remote", "--new-instance", "--profile", profile, "--remote-debugging-port", "0",
                "--window-size", f"{self.window_size[0]},{self.window_size[1]}"]
        if self.headless:
            args.insert(1, "--headless")
        args.append("about:blank")
        self._stderr_path = os.path.join(self.tmp, "firefox.log")
        env = {**os.environ, "MOZ_CRASHREPORTER_DISABLE": "1"}
        # own process group, so close() can take Firefox and all its content processes down and nothing else
        self._stderr_file = open(self._stderr_path, "wb")
        self.proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=self._stderr_file,
                                     stdin=subprocess.DEVNULL, start_new_session=True, env=env)
        port = self._wait_for_port(profile)
        self.log(f"firefox pid {self.proc.pid}, BiDi on 127.0.0.1:{port}")
        self.ws = WebSocket("127.0.0.1", port, "/session")
        self._reader = threading.Thread(target=self._read_loop, name="bidi-reader", daemon=True)
        self._reader.start()
        self.session = self.send("session.new", {"capabilities": {"alwaysMatch": {"acceptInsecureCerts": True}}})
        self.send("session.subscribe", {"events": ["log.entryAdded", "network.responseCompleted", "network.fetchError"]})
        tree = self.send("browsingContext.getTree", {"maxDepth": 0})
        self.context = tree["contexts"][0]["context"]
        return self

    def _wait_for_port(self, profile: str) -> int:
        info = os.path.join(profile, "WebDriverBiDiServer.json")
        deadline = time.monotonic() + self.start_timeout
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(f"firefox exited with {self.proc.returncode}:\n{self.firefox_log()[-2000:]}")
            try:
                with open(info) as f:
                    return int(json.load(f)["ws_port"])
            except (OSError, ValueError, KeyError):
                time.sleep(0.1)
        raise TimeoutError(f"firefox did not start its Remote Agent in {self.start_timeout}s:\n{self.firefox_log()[-2000:]}")

    def firefox_log(self) -> str:
        try:
            with open(self._stderr_path, "rb") as f:
                return f.read().decode("utf-8", "replace")
        except (OSError, AttributeError):
            return ""

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self.ws:
            try:
                self.send("browser.close", {}, timeout=5)
            except Exception:
                pass
            self.ws.close()
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        if self.proc:
            # whatever is left of our group (content processes, crash helper): only the group we started
            for sig in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.killpg(self.proc.pid, sig)
                except (ProcessLookupError, PermissionError):
                    break
                time.sleep(0.5)
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        if getattr(self, "_stderr_file", None):
            self._stderr_file.close()
        if self.tmp:
            shutil.rmtree(self.tmp, ignore_errors=True)

    # -- transport --
    def _read_loop(self) -> None:
        while True:
            try:
                msg = json.loads(self.ws.recv_text())
            except (WebSocketClosed, OSError, ValueError) as e:
                with self._lock:
                    pending, self._pending = self._pending, {}
                for fut in pending.values():
                    if not fut.done():
                        fut.set_exception(BiDiError(f"connection to Firefox lost: {e}"))
                return
            if "id" in msg and msg.get("type") in ("success", "error"):
                with self._lock:
                    fut = self._pending.pop(msg["id"], None)
                if fut is None:
                    continue
                if msg["type"] == "success":
                    fut.set_result(msg.get("result", {}))
                else:
                    fut.set_exception(BiDiError(f"{msg.get('error')}: {msg.get('message')}"))
            elif msg.get("type") == "event":
                self._on_event(msg["method"], msg.get("params", {}))

    def _on_event(self, method: str, p: dict) -> None:
        if method == "log.entryAdded":
            self.entries.append(p)
        elif method == "network.responseCompleted":
            status = p.get("response", {}).get("status", 0)
            if status >= 400:
                self.network_failures.append({"url": p["request"]["url"], "status": status})
        elif method == "network.fetchError":
            self.network_failures.append({"url": p.get("request", {}).get("url"), "error": p.get("errorText")})
        for h in self.event_handlers:
            try:
                h(method, p)
            except Exception as e:  # a broken handler must not kill the reader
                print(f"bidi event handler failed: {e}", file=sys.stderr)

    def send(self, method: str, params: dict | None = None, timeout: float = 60.0) -> dict:
        """Send one BiDi command and wait for its result (raises BiDiError on an error reply)."""
        if self.ws is None:
            raise BiDiError("not connected")
        fut: Future = Future()
        with self._lock:
            self._next_id += 1
            cid = self._next_id
            self._pending[cid] = fut
        self.ws.send_text(json.dumps({"id": cid, "method": method, "params": params or {}}))
        try:
            return fut.result(timeout=timeout)
        except FutureTimeout:
            with self._lock:
                self._pending.pop(cid, None)
            raise TimeoutError(f"{method} got no answer in {timeout}s") from None

    # -- page --
    def navigate(self, url: str, wait: str = "complete", timeout: float = 60.0) -> dict:
        return self.send("browsingContext.navigate", {"context": self.context, "url": url, "wait": wait}, timeout)

    def set_viewport(self, width: int, height: int, device_pixel_ratio: float | None = None) -> None:
        p = {"context": self.context, "viewport": {"width": int(width), "height": int(height)}}
        if device_pixel_ratio:
            p["devicePixelRatio"] = device_pixel_ratio
        self.send("browsingContext.setViewport", p)

    def _script_result(self, r: dict):
        if r.get("type") == "exception":
            d = r.get("exceptionDetails", {})
            raise ScriptError(d.get("text") or json.dumps(d)[:500])
        return deserialize(r.get("result"))

    def evaluate(self, expression: str, await_promise: bool = True, timeout: float = 60.0):
        """Evaluate JS in the page; returns the value as plain Python (see deserialize)."""
        r = self.send("script.evaluate", {
            "expression": expression, "target": {"context": self.context}, "awaitPromise": await_promise,
            "resultOwnership": "none", "serializationOptions": {"maxObjectDepth": 8}}, timeout + 5)
        return self._script_result(r)

    def call(self, function: str, *args, await_promise: bool = True, timeout: float = 60.0):
        """Call a JS function declaration with JSON-able args (dicts with a 'sharedId' pass as node references)."""
        def arg(a):
            if isinstance(a, dict) and "sharedId" in a:
                return {"sharedId": a["sharedId"]}
            return {"type": "string", "value": json.dumps(a)}  # decoded below, keeps any JSON shape
        decl = f"(...a) => ({function})(...a.map((x) => typeof x === 'string' ? JSON.parse(x) : x))"
        r = self.send("script.callFunction", {
            "functionDeclaration": decl, "target": {"context": self.context}, "arguments": [arg(a) for a in args],
            "awaitPromise": await_promise, "resultOwnership": "none",
            "serializationOptions": {"maxObjectDepth": 8}}, timeout + 5)
        return self._script_result(r)

    def eval_json(self, expression: str, timeout: float = 60.0):
        """Evaluate an expression (may be a promise) and bring it back through JSON.stringify: exact nested data."""
        s = self.evaluate(f"Promise.resolve({expression}).then((v) => JSON.stringify(v === undefined ? null : v))",
                          timeout=timeout)
        return json.loads(s) if s is not None else None

    def wait_for(self, expression: str, timeout: float = 60.0, interval: float = 0.1):
        """Poll a JS expression until it is truthy; returns its value (through JSON)."""
        deadline = time.monotonic() + timeout
        while True:
            v = self.eval_json(expression)
            if v:
                return v
            if time.monotonic() > deadline:
                raise TimeoutError(f"timed out after {timeout}s waiting for: {expression}")
            time.sleep(interval)

    def locate(self, css: str, max_count: int = 0) -> list[dict]:
        """Nodes matching a CSS selector, as shared references usable by set_files / call."""
        p = {"context": self.context, "locator": {"type": "css", "value": css}}
        if max_count:
            p["maxNodeCount"] = max_count
        return [{"sharedId": n["sharedId"]} for n in self.send("browsingContext.locateNodes", p)["nodes"]]

    def set_files(self, element, paths: list[str]) -> None:
        """Put files in an <input type=file> the way a file chooser does (fires input and change)."""
        if isinstance(element, str):
            found = self.locate(element, 1)
            if not found:
                raise BiDiError(f"no element matches {element!r}")
            element = found[0]
        self.send("input.setFiles", {"context": self.context, "element": element,
                                     "files": [os.path.abspath(p) for p in paths]})

    # -- input --
    def perform_actions(self, actions: list[dict]) -> None:
        self.send("input.performActions", {"context": self.context, "actions": actions})
        self.send("input.releaseActions", {"context": self.context})

    def click(self, x: float, y: float, button: int = 0) -> None:
        self.perform_actions([{"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": [
            {"type": "pointerMove", "x": int(x), "y": int(y), "origin": "viewport"},
            {"type": "pointerDown", "button": button}, {"type": "pause", "duration": 50},
            {"type": "pointerUp", "button": button}]}])

    def dblclick(self, x: float, y: float) -> None:
        click = [{"type": "pointerDown", "button": 0}, {"type": "pause", "duration": 40}, {"type": "pointerUp", "button": 0}]
        self.perform_actions([{"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": [
            {"type": "pointerMove", "x": int(x), "y": int(y), "origin": "viewport"}, *click,
            {"type": "pause", "duration": 80}, *click]}])

    def drag(self, x0: float, y0: float, x1: float, y1: float, button: int = 0, duration_ms: int = 600,
             steps: int = 12) -> None:
        moves = [{"type": "pointerMove", "x": int(x0 + (x1 - x0) * i / steps), "y": int(y0 + (y1 - y0) * i / steps),
                  "origin": "viewport", "duration": duration_ms // steps} for i in range(1, steps + 1)]
        self.perform_actions([{"type": "pointer", "id": "mouse", "parameters": {"pointerType": "mouse"}, "actions": [
            {"type": "pointerMove", "x": int(x0), "y": int(y0), "origin": "viewport"},
            {"type": "pointerDown", "button": button}, *moves, {"type": "pointerUp", "button": button}]}])

    def wheel(self, x: float, y: float, delta_y: int, delta_x: int = 0) -> None:
        self.perform_actions([{"type": "wheel", "id": "wheel", "actions": [
            {"type": "scroll", "x": int(x), "y": int(y), "deltaX": int(delta_x), "deltaY": int(delta_y),
             "origin": "viewport"}]}])

    def press(self, combo: str) -> None:
        """Press a key or chord: 'Space', 'ArrowRight', '+', 'Shift+ArrowRight', 'Shift++'."""
        if combo == "+":
            names = ["+"]
        elif combo.endswith("++"):
            names = combo[:-2].split("+") + ["+"]
        else:
            names = combo.split("+")
        vals = [key_value(n) for n in names]
        down = [{"type": "keyDown", "value": v} for v in vals]
        up = [{"type": "keyUp", "value": v} for v in reversed(vals)]
        self.perform_actions([{"type": "key", "id": "keyboard", "actions": down + up}])

    def hold(self, combo: str, seconds: float) -> None:
        """Hold a key or chord down for a while, then let go: 'w', 'Shift+ArrowUp', 'PageUp'."""
        vals = [key_value(n) for n in combo.split("+")]
        down = [{"type": "keyDown", "value": v} for v in vals]
        up = [{"type": "keyUp", "value": v} for v in reversed(vals)]
        pause = [{"type": "pause", "duration": int(seconds * 1000)}]
        self.send("input.performActions", {"context": self.context, "actions": [
            {"type": "key", "id": "keyboard", "actions": down + pause + up}]}, timeout=seconds + 30)
        self.send("input.releaseActions", {"context": self.context})

    # -- output --
    def screenshot(self, path: str | None = None, origin: str = "viewport") -> bytes:
        """PNG of what is on screen: every layer the page paints, WebGL canvas included."""
        r = self.send("browsingContext.captureScreenshot", {"context": self.context, "origin": origin,
                                                           "format": {"type": "image/png"}}, timeout=60)
        png = base64.b64decode(r["data"])
        if path:
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
            with open(path, "wb") as f:
                f.write(png)
        return png

    def console(self, levels=("error", "warn", "info", "debug")) -> list[dict]:
        """Console messages and uncaught errors so far, simplified: {level, type, text, source, line}."""
        out = []
        for e in list(self.entries):
            if e.get("level") not in levels:
                continue
            item = {"level": e.get("level"), "type": e.get("type"), "text": e.get("text")}
            st = (e.get("stackTrace") or {}).get("callFrames") or []
            if st:
                item["at"] = f"{st[0].get('url', '')}:{st[0].get('lineNumber', 0) + 1}"
            out.append(item)
        return out

    def errors(self) -> list[dict]:
        return self.console(("error",))

    def warnings(self) -> list[dict]:
        return self.console(("warn",))


def png_size(png: bytes) -> tuple[int, int]:
    """Width and height from a PNG header."""
    if png[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    return struct.unpack(">II", png[16:24])


# ---- the project's dev server -------------------------------------------------------------------------------------
class DevServer:
    """tools/devserver.py on a free port, for the lifetime of a test."""

    def __init__(self, root: str = ROOT, log=None):
        self.root = root
        self.log = log or (lambda msg: None)
        self.proc: subprocess.Popen | None = None
        self.port = 0

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, *exc):
        self.stop()

    def start(self) -> "DevServer":
        for _ in range(5):
            s = socket.socket()
            s.bind(("127.0.0.1", 0))
            self.port = s.getsockname()[1]
            s.close()
            # stderr to a file, never a pipe nobody reads: a full pipe would freeze the server mid-test
            self.errlog = tempfile.TemporaryFile()
            self.proc = subprocess.Popen([sys.executable, os.path.join(self.root, "tools", "devserver.py"),
                                          "--port", str(self.port)], cwd=self.root, stdin=subprocess.DEVNULL,
                                         stdout=subprocess.DEVNULL, stderr=self.errlog, start_new_session=True)
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and self.proc.poll() is None:
                try:
                    socket.create_connection(("127.0.0.1", self.port), timeout=0.5).close()
                    atexit.register(self.stop)
                    self.log(f"dev server pid {self.proc.pid} on http://127.0.0.1:{self.port}/")
                    return self
                except OSError:
                    time.sleep(0.05)
            self.stop()   # port taken in the meantime, or it died: try another port
        raise RuntimeError("could not start tools/devserver.py")

    def url(self, path: str = "") -> str:
        return f"http://127.0.0.1:{self.port}/{path.lstrip('/')}"

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
                self.proc.wait(timeout=5)
            except (ProcessLookupError, PermissionError, subprocess.TimeoutExpired):
                try:
                    os.killpg(self.proc.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
        self.proc = None
        if getattr(self, "errlog", None):
            self.errlog.close()
            self.errlog = None
