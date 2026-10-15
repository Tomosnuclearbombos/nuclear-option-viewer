#!/usr/bin/env python3
"""Live publisher: turns the match being recorded right now into delayed pieces the viewer can play as it happens.

    python tools/live_publish.py --watch-dir <folder NOBlackBox writes into> --out <web folder>/live/s2 [--delay 45]

Follows the newest growing .acmi in --watch-dir (the way the server panel's live map does), keeps the latest state of
every unit, and every --piece seconds of match time cuts one piece:

    <out>/<match>/c0000001.acmi.gz   the ACMI header, a snapshot of every unit alive at the piece's start (one line
                                     each, every property merged), the line "// nov-keyframe-end", then the
                                     recording's own lines for that stretch, untouched
    <out>/<match>/c0000123e.acmi.gz  the match's last piece, cut short where the recording stopped ("final" in the
                                     manifest; a name of its own, so a match that picks up again never reuses it)
    <out>/<match>/manifest.json      the match, its first frame time ("start") and its pieces, newest last
    <out>/current.json               which match is on now (match and manifest are null when none is)

A piece is only written once it is --delay seconds old in match time, so nobody can use the viewer to see the battle
as it happens: the delay is enforced here, not in the browser. That holds when a match ends too: its last pieces go
out on the wall clock, each when it would have been --delay old had the match kept running. Each piece stands alone,
so someone joining late (or reconnecting) starts from any piece, and a publisher restarted mid match rebuilds the very
same pieces under the very same names. Only the newest --keep seconds of pieces are kept, and catching up on a match
already under way only builds those.

A match is over once its file is gone (missing from 3 listings in a row: the recorder zips it at the end), a newer
recording is running and this one hasn't grown for --switch-quiet seconds, or it hasn't grown for --idle-end seconds.
Its manifest says "ended" once its last piece is out, and its folder is deleted --cleanup seconds after that. One
match is on the air at a time (current.json names it): a match still letting out its last pieces comes before the
next one. A match that picks up again after going quiet is followed again from the start. Folders nothing is using
any more (a publisher stopped before its cleanup) are swept when it starts and every 5 minutes after.

run() can be given allow(title): a match it turns down (PvP must never go out live) gets nothing written at all, and
current.json says no match is on.

Every file is written to a temporary name and renamed into place, the manifest last, so a browser never reads half a
file. A failed pass is tried again after 5 s, then 10, 20 and so on up to 5 minutes. Standard library only. Never
prints hosts, credentials or Steam IDs (NOBlackBox records none; host names and IP addresses in error text are
blanked out).
"""
import argparse
import gzip
import io
import json
import math
import os
import re
import shutil
import sys
import time

FORMAT = "nov-live-1"
MARK = "// nov-keyframe-end"
MAX_FRAME_JUMP = 6 * 3600     # seconds; a bigger jump between frame times is damage, not a real gap (as in the viewer)
SWEEP_S = 300                 # how often the output is swept for folders nothing uses any more
BLOCK = 4 << 20               # bytes per read


def log(msg):
    print(time.strftime("%H:%M:%S ") + msg, flush=True)


IPV4 = re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b")


def scrubbed(text, hosts=()):
    """Error text with the given host names and any IPv4 address blanked out (a dropped connection names its host)."""
    for h in hosts:
        if h:
            text = re.sub(re.escape(h), "<host>", text, flags=re.IGNORECASE)
    return IPV4.sub("<ip>", text)


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

    def read(self, name, offset, limit=BLOCK):
        try:
            with open(os.path.join(self.path, name), "rb") as f:
                f.seek(offset)
                return f.read(limit)
        except FileNotFoundError:
            return None


# ---- the recording's state ---------------------------------------------------------------------------------------

def split_props(rest):
    """Split 'a=1,b=x\\,y' on the commas that aren't escaped."""
    if "\\" not in rest:
        return rest.split(",")
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


# Properties the viewer's reader (src/parser/acmi.js) skips when they come empty. NOBlackBox sends a destroyed unit as
# "<id>,Visible=0.0,Type=": kept, that empty Type would go into the snapshot and leave the unit with no type at all.
KEEP_ON_EMPTY = frozenset(("Type", "Coalition", "Armed", "EngagementRange", "Radius", "TAS", "Mach", "AOA", "AGL",
                           "Throttle", "PitchControlInput", "RollControlInput", "YawControlInput", "LandingGear",
                           "Visible"))


class State:
    """Everything needed to write a snapshot: the header lines, the global properties, and every live unit's
    latest properties (its position merged field by field, the way Tacview reads a partial T=)."""

    def __init__(self):
        self.header = []          # FileType / FileVersion lines
        self.globals = {}         # 0,Key=value
        self.units = {}           # id (text) -> {key: value}; "T" kept as a list of fields
        self.time = None          # newest frame time seen
        self.gone = set()         # ids removed in this frame

    def line(self, s):
        if not s or s.startswith("//"):
            return
        c = s[0]
        if c == "#":
            try:
                t = float(s[1:])
            except ValueError:
                return
            if t != self.time:
                self.gone.clear()
            self.time = t
            return
        if c == "-":
            oid = s[1:].strip()
            if self.units.pop(oid, None) is not None:
                self.gone.add(oid)
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
        props = split_props(rest)
        u = self.units.get(oid)
        if u is None:
            # NOBlackBox removes an explosion and then, in the same instant, sends its Radius: an update with no
            # position and no type, in the frame its id went, belongs to the unit that went (as in the viewer)
            if oid in self.gone and not any(p.startswith(("T=", "Type=")) for p in props):
                return
            u = self.units[oid] = {}
        for p in props:
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
            elif v or k not in KEEP_ON_EMPTY:
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
    """A folder on this machine (a web server serves it, or the dev server while testing).

    An output has makedirs(rel), write(rel, data) (atomic), remove(rel), rmtree(rel), and list(), which gives the
    output root's entries as [(name, is_dir, mtime)], mtime in epoch seconds: a folder's mtime changes whenever a file
    in it is written. An output without list() is never swept for folders left behind."""

    def __init__(self, root):
        self.root = root
        os.makedirs(root, exist_ok=True)

    def _p(self, rel):
        return os.path.join(self.root, *rel.split("/"))

    def makedirs(self, rel):
        os.makedirs(self._p(rel), exist_ok=True)

    def write(self, rel, data):
        try:
            write_atomic(self._p(rel), data)
        except FileNotFoundError:          # its folder went (deleted by hand, say): make it again
            os.makedirs(os.path.dirname(self._p(rel)), exist_ok=True)
            write_atomic(self._p(rel), data)

    def remove(self, rel):
        try:
            os.remove(self._p(rel))
        except FileNotFoundError:
            pass

    def rmtree(self, rel):
        shutil.rmtree(self._p(rel), ignore_errors=True)

    def list(self):
        return [(e.name, e.is_dir(), e.stat().st_mtime) for e in os.scandir(self.root)]


def write_no_match(out):
    """current.json when no match is on the air."""
    cur = {"format": FORMAT, "match": None, "manifest": None, "ended": True, "updated": int(time.time())}
    out.write("current.json", json.dumps(cur, separators=(",", ":")).encode())


# ---- the publisher ----------------------------------------------------------------------------------------------


class Match:
    """One recording being cut into pieces."""

    def __init__(self, name, out, a, allow=None):
        self.name = name
        self.a = a
        self.allow = allow
        self.state = State()
        self.offset = 0
        self.used = 0                  # bytes of whole lines read
        self.partial = b""
        self.size_hint = 0             # the file's size in the latest listing
        self.last_growth = time.time()
        self.missing = 0               # listings in a row without the file
        self.match_id = None
        self.dir = None                # the match's folder, relative to the output (never set for a blocked match)
        self.blocked = False           # allow() turned it down: nothing at all is written for it
        self.made = False              # its folder has been made
        self.aired = False             # it has written current.json since it went on the air
        self.out = out
        self.start = None              # its first frame time
        self.piece_start = None       # match time the open piece starts at
        self.piece_lines = []         # its lines so far
        self.piece_snapshot = None    # its snapshot, taken when it opened (None: too far back to be shown)
        self.snapshots = False        # snapshots are being taken: from the first one on, every piece gets one
        self.done = []                # finished pieces waiting out the delay: (t0, t1, text, final)
        self.published = []           # manifest entries
        self.seq = 0
        self.end_wall = None          # when the match ended (wall clock), and its newest frame then
        self.end_newest = None
        self.ended = False            # its last piece is out

    # match id from the recording's real start time (header RecordingTime), else the file name. The globals come
    # before the first frame, so the title is known here too, and allow() is asked about it.
    def ensure_id(self):
        if self.match_id:
            return
        g = self.state.globals
        m = re.match(r"(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)", g.get("RecordingTime", ""))
        self.match_id = "".join(m.groups()) if m else re.sub(r"[^A-Za-z0-9]+", "", self.name)[:40]
        if self.allow is not None:
            title = g.get("Title", "")
            try:
                self.blocked = not self.allow(title)
            except Exception:              # noqa: BLE001 - when in doubt it stays off the air
                self.blocked = True
            if self.blocked:
                log("not published live: %s" % title)
                return
        self.dir = self.match_id

    def feed(self, data):
        lines = (self.partial + data).split(b"\n")
        self.partial = lines.pop()       # an unfinished last line waits for the rest
        for raw in lines:
            self.used += len(raw) + 1
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
                t = math.nan
            # A damaged frame time (endless, or hours away from the last one) is dropped, the way the viewer's reader
            # drops it: one would stretch the match to years, and cut a piece for every 10 s of them.
            if not math.isfinite(t) or (self.state.time is not None and abs(t - self.state.time) > MAX_FRAME_JUMP):
                return
            if self.start is None:
                self.start = t
            if self.piece_start is None:
                self.ensure_id()
                if not self.blocked:
                    self.open_piece(P * int(t // P))
            # every boundary this frame crosses closes the open piece
            while self.piece_start is not None and t > self.piece_start + P:
                self.close_piece()
                self.open_piece(self.piece_start + P)
        self.state.line(s)
        if self.piece_snapshot is not None and not s.startswith(("FileType=", "FileVersion=")):
            self.piece_lines.append(s)

    def open_piece(self, t0):
        self.piece_start = t0
        self.piece_lines = []
        # Catching up on a long match already under way (a restart late in it), only the newest stretch can ever be
        # shown. While the match time still to read (from the file's size and the bytes per match second so far) is
        # more than twice that, a piece gets no snapshot, keeps no lines and is never written. From the first piece
        # that may be shown on, every piece gets one, so the pieces shown never have a gap.
        secs = (self.start if self.state.time is None else self.state.time) - self.start
        if not self.snapshots and secs > 0:
            left = (self.size_hint - self.used) * secs / self.used
            self.snapshots = left <= 2 * (self.a.keep + self.a.delay + self.a.piece)
        if self.snapshots or secs <= 0:      # the very first piece comes before any rate to go by (and is tiny)
            self.piece_snapshot = self.state.snapshot(t0)
        else:
            self.piece_snapshot = None
            self.done.clear()                # nothing before a piece that can't be shown can be shown either

    def close_piece(self, t1=None):
        """Queues the open piece. t1 is given for the last one, cut short where the recording stopped."""
        t0, final = self.piece_start, t1 is not None
        if not final:
            t1 = t0 + self.a.piece
        text = None
        if self.piece_snapshot is not None:
            text = self.piece_snapshot + "\n".join(self.piece_lines) + ("\n" if self.piece_lines else "")
        self.done.append((t0, t1, text, final))
        # catching up on a match already under way: only the newest stretch can ever be shown, so older finished
        # pieces are dropped before they are written (and memory stays bounded)
        span = self.a.keep + self.a.delay + self.a.piece
        while self.done and self.done[0][1] < t1 - span:
            self.done.pop(0)

    def due(self, t1):
        """Whether a piece ending at match time t1 is --delay old: by the newest frame read while the match runs, and
        once it has ended by the wall clock, as if it had kept running."""
        if self.end_wall is None:
            newest = self.state.time
            return newest is not None and t1 <= newest - self.a.delay
        return time.time() - self.end_wall >= self.a.delay - (self.end_newest - min(t1, self.end_newest))

    # pieces old enough to show. A piece leaves the queue only once it is written, so an upload that fails is tried
    # again on the next pass rather than lost.
    def release(self):
        changed = False
        while self.done and self.due(self.done[0][1]):
            t0, t1, text, final = self.done[0]
            if text is not None:       # a piece with no snapshot (too far back to be shown) is never written
                # Named by its place in the match, not by how many came before: a publisher restarted mid match rebuilds
                # the very same piece (same lines, same snapshot) under the very same name, so a copy a browser cached
                # stays right. The last piece, cut short, has a name of its own.
                seq = int(round(t0 / self.a.piece))
                fname = "c%07d%s.acmi.gz" % (seq, "e" if final else "")
                data = gzip.compress(text.encode("utf-8"), compresslevel=6, mtime=0)
                self.out.write(self.dir + "/" + fname, data)
                entry = {"seq": seq, "file": fname, "t0": round(t0, 3), "t1": round(t1, 3), "bytes": len(data)}
                if final:
                    entry["final"] = True
                self.published.append(entry)
                self.seq += 1
                changed = True
            self.done.pop(0)
        # keep only the newest --keep seconds
        if self.published:
            cut = self.published[-1]["t1"] - self.a.keep
            while len(self.published) > 1 and self.published[0]["t1"] <= cut:
                old = self.published.pop(0)
                self.out.remove(self.dir + "/" + old["file"])
                changed = True
        if self.end_wall is not None and not self.done and not self.ended:
            self.ended = changed = True
        return changed

    def end(self):
        """The recording has stopped: its last line (a file can end without a newline) is read, and the open piece is
        queued cut short. The rest then goes out on the wall clock (due)."""
        if self.partial:
            self.feed(b"\n")
        if self.piece_start is not None:
            self.close_piece(self.state.time)
            self.piece_start = self.piece_snapshot = None
            self.piece_lines = []
        self.end_wall = time.time()
        self.end_newest = self.state.time

    def publish(self, on_air, force=False):
        """Writes what is due, then the manifest when anything changed (and current.json when on the air)."""
        if self.blocked:
            if on_air and not self.aired:
                write_no_match(self.out)
                self.aired = True
            return
        if not self.dir:
            return
        if not self.made:
            self.out.makedirs(self.dir)
            self.made = True
        if self.release() or force or (on_air and not self.aired):
            self.write_manifest(on_air)

    def write_manifest(self, on_air):
        g = self.state.globals
        man = {
            "format": FORMAT, "match": self.match_id, "title": g.get("Title", ""), "mapId": g.get("MapId", ""),
            "referenceTime": g.get("ReferenceTime", ""), "recordingTime": g.get("RecordingTime", ""),
            "pieceSeconds": self.a.piece, "delaySeconds": self.a.delay, "ended": self.ended,
            "updated": int(time.time()), "start": self.start, "pieces": self.published,
        }
        self.out.write(self.dir + "/manifest.json", json.dumps(man, separators=(",", ":")).encode())
        if on_air:
            cur = {"format": FORMAT, "match": self.match_id, "manifest": self.match_id + "/manifest.json",
                   "title": man["title"], "mapId": man["mapId"], "ended": self.ended, "updated": man["updated"]}
            self.out.write("current.json", json.dumps(cur, separators=(",", ":")).encode())
            self.aired = True


def pick_running(recs, now, active_s):
    """the newest raw .acmi still growing (a killed server leaves an old one behind). Finished matches sit next to it as
    .zip.acmi, which also ends in .acmi: never those."""
    live = [r for r in recs if now - r[2] < active_s and not r[0].lower().endswith(".zip.acmi")]
    return max(live, key=lambda r: (r[2], r[0])) if live else None


class Feed:
    """What the publisher carries from one pass to the next."""

    def __init__(self, allow=None):
        self.allow = allow
        self.cur = None                # the match being read
        self.closing = []              # matches over but still letting out their last pieces, oldest first
        self.on_air = None             # the match current.json is for: the oldest closing one, else cur
        self.ended_at = {}             # match dir -> when its last piece went out, for cleanup
        self.finished = {}             # recording -> its size when its match ended: a quiet file left behind (a killed
                                       # server's) is not followed again unless it grows
        self.swept = None              # when the output was last swept for folders left behind


def run(a, src=None, out=None, allow=None, scrub=()):
    """The publisher's loop. src lists and reads the recordings (LocalDir by default), out writes the pieces
    (LocalOut by default); tools that read over SFTP or upload to a web server pass their own. allow(title) says
    whether a match may go out live (False or an exception: it doesn't). scrub lists host names to blank out of
    logged errors."""
    src = src or LocalDir(a.watch_dir)
    out = out or LocalOut(a.out)
    st = Feed(allow)
    fails = 0
    log("watching %s, writing %s (pieces %ds, delay %ds, keep %ds)" % (a.watch_dir, a.out, a.piece, a.delay, a.keep))
    while True:
        try:
            step(a, src, out, st)
            fails = 0
        except Exception as e:               # noqa: BLE001 - a dropped connection or a failed upload: try again
            wait = min(300, 5 << min(fails, 6))
            fails += 1
            log("error, retrying in %ds: %s: %s" % (wait, type(e).__name__, scrubbed(str(e), scrub)[:200]))
            if not a.once:
                time.sleep(wait)
        if a.once:
            break
        time.sleep(a.poll)


def step(a, src, out, st):
    """One pass: pick up the running recording, read whatever it has gained, publish what is old enough, notice the
    end of a match, and clean up. "Gone quiet" counts from the last read that got anything, so catching up on a long
    match already under way (which can take a while over SFTP) never looks like the match stopping."""
    recs = src.recordings()
    run_rec = pick_running(recs, time.time(), a.active)
    if st.cur is None and run_rec and st.finished.get(run_rec[0]) != run_rec[1]:
        st.cur = Match(run_rec[0], out, a, st.allow)
        log("following %s" % run_rec[0])
    cur, got = st.cur, False
    if cur:
        listed = [r for r in recs if r[0] == cur.name]
        if listed:
            cur.size_hint = listed[0][1]
        while True:
            data = src.read(cur.name, cur.offset)
            if not data:
                break
            cur.offset += len(data)
            cur.feed(data)
            got = True
            cur.last_growth = time.time()
            if len(data) < BLOCK:        # a full block means more is waiting: keep catching up before publishing
                break
        cur.missing = 0 if got or listed else cur.missing + 1
        if cur.dir:
            # a match that went quiet and picked up again: its folder stays, and this reading takes over from the last
            st.ended_at.pop(cur.dir, None)
            st.closing = [m for m in st.closing if m.dir != cur.dir]
        # over once its file is gone (zipped at the end), a newer recording is running and this one has stopped
        # growing, or it has been quiet a long while
        gone = cur.missing >= 3
        newer = (run_rec is not None and run_rec[0] != cur.name
                 and time.time() - cur.last_growth >= getattr(a, "switch_quiet", 10))
        quiet = time.time() - cur.last_growth > a.idle_end
        if gone or newer or quiet:
            log("match %s over (%s)" % (cur.match_id, "file gone" if gone else "newer match" if newer else "quiet"))
            st.finished[cur.name] = cur.offset
            cur.end()
            if cur.dir:
                st.closing.append(cur)
            st.cur = cur = None
    # one match on the air: the oldest one still letting out its last pieces, else the one being read
    on_air = st.closing[0] if st.closing else cur
    if on_air is not st.on_air:
        st.on_air = on_air
        if on_air:
            on_air.aired = False
    for m in list(st.closing):
        m.publish(m is on_air)
        if m.ended:
            log("match %s finished: %d pieces published" % (m.match_id, m.seq))
            st.closing.remove(m)
            st.ended_at[m.dir] = time.time()
    if cur:
        cur.publish(cur is on_air, got)  # also before the first piece, so the page can say the match has started
    cleanup(a, out, st)


def cleanup(a, out, st):
    """Deletes the folders of matches that ended --cleanup seconds ago, and (on the first pass, then every 5 minutes)
    any other folder nothing is using that hasn't changed for longer than that: a publisher stopped before cleaning up
    leaves them behind. Never the folder of the match being read or of one still letting out its last pieces."""
    now = time.time()
    used = {m.dir for m in st.closing}
    if st.cur and st.cur.dir:
        used.add(st.cur.dir)
    gone = []
    for d, t in list(st.ended_at.items()):
        if d not in used and now - t > a.cleanup:
            del st.ended_at[d]
            gone.append(d)
    if hasattr(out, "list") and (st.swept is None or now - st.swept >= SWEEP_S):
        st.swept = now
        try:
            gone += [name for name, is_dir, mtime in out.list()
                     if is_dir and name not in used and name not in gone and mtime < now - (a.cleanup + 120)]
        except Exception as e:             # noqa: BLE001 - swept again next time
            log("could not list the output: %s" % type(e).__name__)
    deleted = False
    for d in gone:
        st.ended_at.pop(d, None)
        try:
            out.rmtree(d)
            deleted = True
            log("deleted %s" % d)
        except Exception as e:             # noqa: BLE001 - its folder is swept again later
            log("could not delete %s: %s" % (d, type(e).__name__))
    if deleted and not st.closing and not (st.cur and st.cur.aired):     # nothing on the air
        write_no_match(out)


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
    ap.add_argument("--switch-quiet", type=float, default=10,
                    help="a newer recording only ends this one once this one hasn't grown this long (10)")
    ap.add_argument("--cleanup", type=float, default=600, help="seconds after a match ends before its pieces are deleted (600)")
    ap.add_argument("--once", action="store_true", help="one pass, then exit (tests)")
    a = ap.parse_args()
    run(a)


if __name__ == "__main__":
    main()
