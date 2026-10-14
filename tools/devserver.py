"""Local web server for working on the viewer.

    python3 tools/devserver.py [--port 8000] [--lan] [--results FILE]

Serves the project folder. --lan also serves it to the home network, so a phone on the same Wi-Fi can open it (the
address it prints). Without it, only this PC can. Test pages may POST a JSON report to /__result, which is written to --results (one line
per report), so a headless browser run can hand its findings back to the command line.
"""
import argparse
import http.server
import json
import os
import socketserver

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
                      ".wasm": "application/wasm", ".acmi": "application/octet-stream", ".glb": "model/gltf-binary"}

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        if self.path != "/__result" or not self.server.results:
            self.send_error(404)
            return
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        try:
            line = json.dumps(json.loads(body))
        except ValueError:
            line = json.dumps({"raw": body.decode("utf-8", "replace")})
        with open(self.server.results, "a", encoding="utf-8") as f:
            f.write(line + "\n")
        self.send_response(204)
        self.end_headers()

    def log_message(self, fmt, *args):
        # quiet for this PC; with --lan, other devices' requests are printed, so you can see a phone get through
        if self.client_address[0] != "127.0.0.1":
            print(f"{self.client_address[0]}  {fmt % args}", flush=True)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def lan_address():
    # the address other devices reach this PC on (no packet is sent: connecting a UDP socket only picks a route)
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.168.0.1", 9))
        return s.getsockname()[0]
    except OSError:
        return "this-pc-address"
    finally:
        s.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--results", default="")
    ap.add_argument("--lan", action="store_true", help="also serve to other devices on the home network")
    a = ap.parse_args()
    srv = Server(("0.0.0.0" if a.lan else "127.0.0.1", a.port), Handler)
    srv.results = a.results
    print(f"serving {ROOT} on http://127.0.0.1:{a.port}/", flush=True)
    if a.lan:
        print(f"on the home network: http://{lan_address()}:{a.port}/", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
