#!/usr/bin/env python3
"""Plays a recorded match into a folder as if it were being recorded right now, for testing the live publisher and
viewer without a real match.

    python tools/live_simulate.py <recording.zip.acmi | .acmi> --out-dir <folder> [--speed 1] [--start 600]

Writes <out-dir>/<the recording's name>.acmi and appends to it in step with the recording's own frame times (#t),
--speed times faster than real time, flushing as it goes like NOBlackBox does. --start skips straight to that many
seconds into the match (everything before it is written at once, like joining a match already under way). At the end
the file is renamed to .acmi.done, the way the recorder's zipping takes the .acmi away.
"""
import argparse
import io
import os
import sys
import time
import zipfile


def open_recording(path):
    if path.lower().endswith(".zip.acmi") or path.lower().endswith(".zip"):
        z = zipfile.ZipFile(path)
        name = next(n for n in z.namelist() if n.lower().endswith(".acmi"))
        return os.path.basename(name), io.BufferedReader(z.open(name))
    return os.path.basename(path), open(path, "rb")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("recording")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--start", type=float, default=0.0, help="seconds into the match to start playing from")
    ap.add_argument("--stop", type=float, default=0.0, help="stop this many seconds into the match (0 = the end)")
    a = ap.parse_args()

    name, f = open_recording(a.recording)
    os.makedirs(a.out_dir, exist_ok=True)
    out_path = os.path.join(a.out_dir, name)
    out = open(out_path, "wb")
    t_first = None
    wall0 = None
    pending = []
    n = 0
    for raw in f:
        if raw.startswith(b"#"):
            try:
                t = float(raw[1:])
            except ValueError:
                t = None
            if t is not None:
                if t_first is None:
                    t_first = t
                rel = t - t_first
                if a.stop and rel > a.stop:
                    break
                if rel >= a.start:
                    out.write(b"".join(pending)); pending = []
                    out.flush()
                    if wall0 is None:
                        wall0 = time.time() - 0.0
                        print("playing from %.0f s, speed %gx" % (rel, a.speed), flush=True)
                    due = wall0 + (rel - a.start) / a.speed
                    wait = due - time.time()
                    if wait > 0:
                        time.sleep(wait)
                    n += 1
                    if n % 600 == 0:
                        print("at %.0f s" % rel, flush=True)
        pending.append(raw)
    out.write(b"".join(pending))
    out.close()
    os.replace(out_path, out_path + ".done")
    print("finished: %s.done" % name, flush=True)


if __name__ == "__main__":
    main()
