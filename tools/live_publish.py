#!/usr/bin/env python3
"""Live publisher: turns the match being recorded right now into delayed pieces the viewer can play as it happens.

    python tools/live_publish.py --watch-dir <folder NOBlackBox writes into> --out <web folder>/live/s2 [--delay 45]

Follows the newest growing .acmi in --watch-dir (the way the server panel's live map does), keeps the latest state of
every unit, and every --piece seconds of match time writes one piece:

    <out>/<match>/c000001.acmi.gz   the ACMI header, a snapshot of every unit alive at the piece's start (one line each,
                                    every property merged), the line "// nov-keyframe-end", then the recording's own
                                    lines for that stretch, untouched
    <out>/<match>/manifest.json     the match and its pieces, newest last
    <out>/current.json              which match is on now

A piece is only written once it is --delay seconds old in match time, so nobody can use the viewer to see the battle
as it happens: the delay is enforced here, not in the browser. Each piece stands alone, so someone joining late (or
reconnecting) starts from any piece. Only the newest --keep seconds of pieces are kept. When the match ends (its file
stops growing or a newer recording starts), the rest is written straight away (it can't help anyone now), the manifest
says so, and the match's folder is deleted --cleanup seconds later.

Every file is written to a temporary name and renamed into place, the manifest last, so a browser never reads half a
file. Standard library only. Never prints hosts, credentials or Steam IDs (NOBlackBox records none).
"""
import argparse
import gzip
import io
import json
import os
import re
import shutil
import sys
import time

FORMAT = "nov-live-1"
MARK = "// nov-keyframe-end"


def log(msg):
    print(time.strftime("%H:%M:%S ") + msg, flush=True)


# ---- sources: where the growing recording is read from ----------------------------------------------------------

class LocalDir:
    """A folder on this machine (the simulator's, or the game server's own once it runs here)."""

    def __init__(self, path):
        self.path = path

    def recordings(self):
        out = []
        try:
            for e in os.scandir(self.path):
                if e.is_file() and e.name.lower().endswith(".acmi"):
                    st = e.stat()
                    out.append((e.name, st.st_size, st.st_mtime))
        except FileNotFoundError:
            pass
        return out

    def read(self, name, offset, limit=4 << 20):
        try:
            with open(os.path.join(self.path, name), "rb") as f:
                f.seek(offset)
                return f.read(limit)
        except FileNotFoundError:
            return None


# ---- the recording's state ---------------------------------------------------------------------------------------

def split_props(rest):
    """Split 'a=1,b=x\\,y' on the commas that aren't escaped."""
    out, cur, i, n = [], [], 0, len(rest)
    while i < n:
        c = rest[i]
        if c == "\\" and i + 1 < n:
            cur.append(c); cur.append(rest[i + 1]); i += 2; continue
        if c == ",":
            out.append("".join(cur)); cur = []
        else:
            cur.append(c)
        i += 1
    out.append("".join(cur))
    return out


class State:
    """Everything needed to write a snapshot: the header lines, the global properties, and every live unit's
    latest properties (its position merged field by field, the way Tacview reads a partial T=)."""

    def __init__(self):
        self.header = []          # FileType / FileVersion lines
        self.globals = {}         # 0,Key=value
        self.units = {}           # id (text) -> {key: value}; "T" kept as a list of fields
        self.time = None          # newest frame time seen

    def line(self, s):
        if not s or s.startswith("//"):
            return
        c = s[0]
        if c == "#":
            try:
                self.time = float(s[1:])
            except ValueError:
                pass
            return
        if c == "-":
            self.units.pop(s[1:].strip(), None)
            return
        if s.startswith("FileType=") or s.startswith("FileVersion="):
            self.header.append(s)
            return
        comma = s.find(",")
        if comma <= 0:
            return
        oid, rest = s[:comma], s[comma + 1:]
        if oid == "0":
            for p in split_props(rest):
                k, eq, v = p.partition("=")
                if eq and k != "Event":            # events belong to their moment, not to a snapshot
                    self.globals[k] = v
            return
        u = self.units.get(oid)
        if u is None:
            u = self.units[oid] = {}
        for p in split_props(rest):
            k, eq, v = p.partition("=")
            if not eq:
                continue
            if k == "T":
                f = v.split("|")
                old = u.get("T")
                if old is None or len(old) != len(f):
                    u["T"] = f
                else:
                    for j, x in enumerate(f):
                        if x != "":
                            old[j] = x
            else:
                u[k] = v

    def snapshot(self, t):
        """The header and every live unit as of time t, ending with the marker line."""
        out = list(self.header)
        if self.globals:
            out.append("0," + ",".join(k + "=" + v for k, v in self.globals.items()))
        out.append("#" + fmt_t(t))
        for oid, u in self.units.items():
            props = []
            if "T" in u:
                props.append("T=" + "|".join(u["T"]))
            props.extend(k + "=" + v for k, v in u.items() if k != "T")
            out.append(oid + "," + ",".join(props))
        out.append(MARK)
        return "\n".join(out) + "\n"


def fmt_t(t):
    s = ("%.3f" % t).rstrip("0").rstrip(".")
    return s or "0"


# ---- outputs: where the pieces are written (paths are relative, "/" separated) ----------------------------------

def write_atomic(path, data):
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


class LocalOut:
    """A folder on this machine (a web server serves it, or the dev server while testing)."""

    def __init__(self, root):
        self.root = root
        os.makedirs(root, exist_ok=True)

    def _p(self, rel):
        return os.path.join(self.root, *rel.split("/"))

    def makedirs(self, rel):
        os.makedirs(self._p(rel), exist_ok=True)

    def write(self, rel, data):
        write_atomic(self._p(rel), data)

    def remove(self, rel):
        try:
            os.remove(self._p(rel))
        except FileNotFoundError:
            pass

    def rmtree(self, rel):
        shutil.rmtree(self._p(rel), ignore_errors=True)


# ---- the publisher ----------------------------------------------------------------------------------------------


class Match:
    """One recording being cut into pieces."""

    def __init__(self, name, out, a):
        self.name = name
        self.a = a
        self.state = State()
        self.offset = 0
        self.partial = b""
        self.last_growth = time.time()
        self.match_id = None
        self.dir = None                # the match's folder, relative to the output
        self.out = out
        self.piece_start = None       # match time the open piece starts at
        self.piece_lines = []         # its lines so far
        self.piece_snapshot = None    # its snapshot, taken when it opened
        self.done = []                # finished pieces waiting out the delay: (t0, t1, text)
        self.published = []           # manifest entries
        self.seq = 0
        self.ended = False

    # match id from the recording's real start time (header RecordingTime), else the file name
    def ensure_id(self):
        if self.match_id:
            return
        rt = self.state.globals.get("RecordingTime", "")
        m = re.match(r"(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)", rt)
        self.match_id = "".join(m.groups()) if m else re.sub(r"[^A-Za-z0-9]+", "", self.name)[:40]
        self.dir = self.match_id
        self.out.makedirs(self.dir)

    def feed(self, data):
        lines = (self.partial + data).split(b"\n")
        self.partial = lines.pop()       # an unfinished last line waits for the rest
        for raw in lines:
            s = raw.decode("utf-8", "replace").rstrip("\r")
            if s.startswith("﻿"):
                s = s[1:]
            self.line(s)

    def line(self, s):
        P = self.a.piece
        if s.startswith("#"):
            try:
                t = float(s[1:])
            except ValueError:
                t = None
            if t is not None:
                if self.piece_start is None:
                    self.ensure_id()
                    self.open_piece(P * int(t // P))
                # every boundary this frame crosses closes the open piece
                while t > self.piece_start + P:
                    self.close_piece()
                    self.open_piece(self.piece_start + P)
        self.state.line(s)
        if self.piece_start is not None and not s.startswith(("FileType=", "FileVersion=")):
            self.piece_lines.append(s)

    def open_piece(self, t0):
        self.piece_start = t0
        self.piece_lines = []
        self.piece_snapshot = self.state.snapshot(t0)

    def close_piece(self):
        t0, t1 = self.piece_start, self.piece_start + self.a.piece
        self.done.append((t0, t1, self.piece_snapshot + "\n".join(self.piece_lines) + ("\n" if self.piece_lines else "")))
        # catching up on a match already under way: only the newest stretch can ever be shown, so older finished
        # pieces are dropped before they are written (and memory stays bounded)
        span = self.a.keep + self.a.delay + self.a.piece
        while self.done and self.done[0][1] < t1 - span:
            self.done.pop(0)

    # pieces old enough to show (all of them once the match is over). A piece leaves the queue only once it is written,
    # so an upload that fails is tried again on the next pass rather than lost.
    def release(self, force=False):
        newest = self.state.time
        changed = False
        while self.done and (force or (newest is not None and self.done[0][1] <= newest - self.a.delay)):
            t0, t1, text = self.done[0]
            fname = "c%06d.acmi.gz" % (self.seq + 1)
            data = gzip.compress(text.encode("utf-8"), compresslevel=6, mtime=0)
            self.out.write(self.dir + "/" + fname, data)
            self.done.pop(0)
            self.seq += 1
            self.published.append({"seq": self.seq, "file": fname, "t0": round(t0, 3), "t1": round(t1, 3), "bytes": len(data)})
            changed = True
        # keep only the newest --keep seconds
        if self.published:
            cut = self.published[-1]["t1"] - self.a.keep
            while len(self.published) > 1 and self.published[0]["t1"] <= cut:
                old = self.published.pop(0)
                self.out.remove(self.dir + "/" + old["file"])
                changed = True
        return changed

    def end(self):
        if self.piece_start is not None and self.piece_lines:
            self.close_piece()
            self.piece_lines = []
        self.ended = True
        if self.dir:
            self.release(force=True)
            self.write_manifest()

    def write_manifest(self):
        g = self.state.globals
        man = {
            "format": FORMAT, "match": self.match_id, "title": g.get("Title", ""), "mapId": g.get("MapId", ""),
            "referenceTime": g.get("ReferenceTime", ""), "recordingTime": g.get("RecordingTime", ""),
            "pieceSeconds": self.a.piece, "delaySeconds": self.a.delay, "ended": self.ended,
            "updated": int(time.time()), "newest": self.state.time, "pieces": self.published,
        }
        self.out.write(self.dir + "/manifest.json", json.dumps(man, separators=(",", ":")).encode())
        cur = {"format": FORMAT, "match": self.match_id, "manifest": self.match_id + "/manifest.json",
               "title": man["title"], "mapId": man["mapId"], "ended": self.ended, "updated": man["updated"]}
        self.out.write("current.json", json.dumps(cur, separators=(",", ":")).encode())


def pick_running(recs, now, active_s):
    """the newest raw .acmi still growing (a killed server leaves an old one behind). Finished matches sit next to it as
    .zip.acmi, which also ends in .acmi: never those."""
    live = [r for r in recs if now - r[2] < active_s and not r[0].lower().endswith(".zip.acmi")]
    return max(live, key=lambda r: (r[2], r[0])) if live else None


def run(a, src=None, out=None):
    """The publisher's loop. src lists and reads the recordings (LocalDir by default), out writes the pieces
    (LocalOut by default); tools that read over SFTP or upload to a web server pass their own."""
    src = src or LocalDir(a.watch_dir)
    out = out or LocalOut(a.out)
    cur = None
    ended_at = {}                      # match dir -> when it ended, for cleanup
    finished = {}                      # recording -> its size when its match ended: a quiet file left behind (a killed
                                       # server's) is not followed again unless it grows
    log("watching %s, writing %s (pieces %ds, delay %ds, keep %ds)" % (a.watch_dir, a.out, a.piece, a.delay, a.keep))
    while True:
        try:
            cur = step(a, src, out, cur, ended_at, finished)
        except Exception as e:               # noqa: BLE001 - a dropped connection or a failed upload: try again
            log("error, retrying: %s: %s" % (type(e).__name__, str(e)[:200]))
            time.sleep(5)
        if a.once:
            break
        time.sleep(a.poll)


def step(a, src, out, cur, ended_at, finished):
    """One pass: read whatever the running recording has gained, publish what is old enough, and notice the end of a
    match. "Gone quiet" counts from the last read that got anything, so catching up on a long match already under way
    (which can take a while over SFTP) never looks like the match stopping."""
    recs = src.recordings()
    run_rec = pick_running(recs, time.time(), a.active)
    got = False
    if cur:
        while True:
            data = src.read(cur.name, cur.offset)
            if not data:
                break
            cur.offset += len(data)
            cur.feed(data)
            got = True
            cur.last_growth = time.time()
            if len(data) < (4 << 20):    # a full block means more is waiting: keep catching up before publishing
                break
        if cur.dir and (cur.release() or got):
            cur.write_manifest()         # also before the first piece, so the page can say the match has started
        # over once its file is gone (zipped at the end), a newer recording has started, or it has stopped growing
        gone = not got and not any(r[0] == cur.name for r in recs)
        newer = run_rec is not None and run_rec[0] != cur.name
        quiet = time.time() - cur.last_growth > a.idle_end
        if gone or newer or quiet:
            log("match %s over (%s): %d pieces published" % (cur.match_id, "file gone" if gone else "newer match" if newer else "quiet", cur.seq))
            finished[cur.name] = cur.offset
            cur.end()
            if cur.dir:
                ended_at[cur.dir] = time.time()
            cur = None
    if cur is None and run_rec and finished.get(run_rec[0]) != run_rec[1]:
        cur = Match(run_rec[0], out, a)
        log("following %s" % run_rec[0])
    now = time.time()
    for d, t in list(ended_at.items()):
        if now - t > a.cleanup:
            out.rmtree(d)
            del ended_at[d]
            log("deleted %s" % d)
    return cur


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--watch-dir", required=True, help="folder the growing .acmi is in")
    ap.add_argument("--out", required=True, help="web folder for this server's live pieces, e.g. <web>/live/s2")
    ap.add_argument("--piece", type=int, default=10, help="seconds of match per piece (10)")
    ap.add_argument("--delay", type=int, default=45, help="seconds a piece must be old before it is published (45)")
    ap.add_argument("--keep", type=int, default=900, help="seconds of pieces kept for rewinding (900)")
    ap.add_argument("--poll", type=float, default=1.0, help="seconds between reads (1)")
    ap.add_argument("--active", type=float, default=180, help="a .acmi untouched this long isn't the running match (180)")
    ap.add_argument("--idle-end", type=float, default=120, help="the match is over once its file hasn't grown this long (120)")
    ap.add_argument("--cleanup", type=float, default=600, help="seconds after a match ends before its pieces are deleted (600)")
    ap.add_argument("--once", action="store_true", help="one pass, then exit (tests)")
    a = ap.parse_args()
    run(a)


if __name__ == "__main__":
    main()
