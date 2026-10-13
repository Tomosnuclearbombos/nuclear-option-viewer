"""Local web server for working on the viewer.

    python3 tools/devserver.py [--port 8000] [--results FILE]

Serves the project folder. Test pages may POST a JSON report to /__result, which is written to --results (one line
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
        pass


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--results", default="")
    a = ap.parse_args()
    srv = Server(("127.0.0.1", a.port), Handler)
    srv.results = a.results
    print(f"serving {ROOT} on http://127.0.0.1:{a.port}/", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
