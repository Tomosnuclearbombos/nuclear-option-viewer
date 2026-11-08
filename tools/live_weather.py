#!/usr/bin/env python3
"""Publish a server's weather next to its live pieces, for the viewer's ATIS panel (Tomo, 11-08: "an ATIS feature ...
that shows the weather stats and a little direction symbol too for the wind direction").

The game plugin (2.4.0 on, PvE+ and PvP+ only) rewrites <tacview>/weather.json every 10 s while its live weather runs.
This keeps the last few minutes of it and uploads them as <remote dir>/weather.json:

    {"v": 1, "updated": <unix s>, "samples": [<the plugin's objects, oldest first>]}

so the viewer can show the weather at its playback time, which runs about a minute behind. When the plugin says the
weather isn't running, or there's no file, the samples are the latest object only (running false), and the panel hides.

Runs beside the live runner as its own user unit (nov-weather-s1, ...), so the runners stay on their pinned commit.
Upload: one `ssh <host> 'cat > tmp && mv tmp weather.json'` per change, the host from ~/.ssh/config like the runner's.

    live_weather.py --watch-dir /home/container/tacview --ssh-host vps --remote-dir /srv/nov-live/s1
"""

import argparse, json, os, shlex, subprocess, sys, time

KEEP_S = 300        # how much weather to keep: the viewer plays about a minute behind
POLL_S = 5


def log(path, msg):
    line = time.strftime("%m-%d %H:%M:%S ") + msg
    print(line, flush=True)
    if path:
        with open(path, "a", encoding="utf-8") as f:
            f.write(line + "\n")


def read(path):
    try:
        with open(path, encoding="utf-8") as f:
            o = json.load(f)
        return o if isinstance(o, dict) and o.get("v") == 1 else None
    except (OSError, ValueError):
        return None


def utc_s(o):
    try:
        return time.mktime(time.strptime(o["utc"], "%Y-%m-%dT%H:%M:%SZ")) - time.timezone
    except (KeyError, ValueError, TypeError):
        return None


def upload(host, remote_dir, body):
    d = shlex.quote(remote_dir.rstrip("/"))
    cmd = f"cat > {d}/.weather.json.tmp && mv {d}/.weather.json.tmp {d}/weather.json"
    r = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host, cmd],
                       input=body.encode("utf-8"), capture_output=True, timeout=60)
    if r.returncode != 0:
        raise OSError((r.stderr or b"").decode("utf-8", "replace").strip()[:200] or f"ssh exit {r.returncode}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--watch-dir", required=True, help="the server's tacview folder (weather.json is written there)")
    ap.add_argument("--ssh-host", required=True)
    ap.add_argument("--remote-dir", required=True, help="the live folder on the web server, e.g. /srv/nov-live/s1")
    ap.add_argument("--log")
    ap.add_argument("--once", action="store_true", help="publish once and stop (for a test)")
    a = ap.parse_args()
    src = os.path.join(a.watch_dir, "weather.json")
    log(a.log, f"watching {src}, writing <web server>:<live folder>/weather.json (keep {KEEP_S}s)")
    samples, sent, fails = [], None, 0
    while True:
        o = read(src)
        if o and o.get("running"):
            if not samples or samples[-1].get("utc") != o.get("utc"):
                if samples and samples[-1].get("mission") != o.get("mission"):
                    samples = []                                  # a new mission: its own weather
                samples.append(o)
                newest = utc_s(o)
                if newest is not None:
                    samples = [s for s in samples if (utc_s(s) or newest) >= newest - KEEP_S]
            out = samples
        else:
            samples = []
            out = [o] if o else []
        body = json.dumps({"v": 1, "updated": int(time.time()), "samples": out}, separators=(",", ":"))
        key = json.dumps(out, sort_keys=True)
        if key != sent:
            try:
                upload(a.ssh_host, a.remote_dir, body)
                if sent is None or fails:
                    log(a.log, f"published ({len(out)} samples)")
                sent, fails = key, 0
            except (OSError, subprocess.TimeoutExpired) as e:
                fails += 1
                if fails in (1, 10) or fails % 100 == 0:
                    log(a.log, f"upload failed ({fails}): {e}")
        if a.once:
            return 0
        time.sleep(POLL_S)


if __name__ == "__main__":
    sys.exit(main() or 0)
