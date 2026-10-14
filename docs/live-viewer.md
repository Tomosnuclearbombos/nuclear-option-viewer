# Live viewer: plan

Status: planned 2026-10-14. To be set up when the servers move to the new server PC (Tomo: "we'll need it running on the
new server PC, so plan it out and then when we migrate to that we can set it up"). Nothing is deployed yet.

## What people get

- A "Watch live" link (in the Discord post when a match starts) opens the viewer on the match as it happens, about a
  minute behind.
- Everything the replay viewer does works the same: map, models, buildings, labels, following, tracers, explosions.
- A LIVE button: lit while you're at the live moment, "GO LIVE" when you've paused or rewound, to jump back.
- Joining late works: you start at the live moment straight away, and can rewind through the last 15 minutes (older
  parts of the match can come later if wanted).
- When the match ends the page says so; the full replay then goes to the GitHub release as now.

## How it works

```
game server ── NOBlackBox writes the match's .acmi as it goes (flushed every few seconds)
     │
live publisher (tools/live_publish.py, on the same machine, reads the growing file)
     │  every 10 s of match time: one piece, published only once it is 45 s old
     ▼
web folder  live/<server>/current.json, <match>/manifest.json, <match>/c000123.acmi.gz
     │  served over https by a small web server (Caddy) with CORS, so the GitHub site can read it
     ▼
viewer  https://<github pages site>/?live=https://<server host>/live/s1/current.json
```

- **The delay is enforced on the server**: a piece only exists once it is 45 s old, so nobody can use the viewer to see
  enemies in real time, whatever they do in the browser. The viewer plays about 15 s behind the newest piece so a new
  one always arrives in time: about a minute in total.
- **Each piece stands alone**: it starts with a snapshot of every unit on the map, so a late joiner (or a dropped
  connection) picks up from any piece. Pieces after the first are read from after their snapshot, so the viewer joins
  them into one continuous recording.
- **Cost**: the publisher reads only new bytes every second and keeps the map state in memory (see the test numbers
  below). Each viewer downloads roughly 10 to 20 KB per second during a busy match. The web server only serves static
  files.

## The format (nov-live-1)

- `current.json`: `{format, match, manifest, title, mapId, updated, ended}`: the newest match on that server.
- `<match>/manifest.json`: `{format, match, title, mapId, referenceTime, recordingTime, chunkSeconds, delaySeconds,
  ended, updated, chunks: [{seq, file, t0, t1, bytes}]}`.
- `<match>/c<seq>.acmi.gz`: gzipped ACMI covering frame times (t0, t1]: the header and global properties, `#t0`, one
  keyframe line per unit alive at t0 (merged full transform and every latest property), the line
  `// nov-keyframe-end`, then the original lines for (t0, t1] verbatim.
- Files are written to a temporary name and renamed into place, manifest last, so a browser never gets half a file.

## Viewer work (this repo)

- `?live=<url>` opens live mode: fetch current.json, then the manifest; poll every 5 s.
- Keep the newest 15 minutes of pieces; rebuild the replay in the reader thread when new pieces arrive (at most every
  20 s; about half a second of background work for a busy 15 minutes), and swap it in keeping the time, play state,
  speed, camera, selection (matched by unit id) and following.
- Play at 1X at the live moment by default; never stop at the end of the data (wait for the next piece).
- LIVE / GO LIVE button, a "LIVE" line in the mission panel, "MATCH OVER" when the manifest says ended.

## Server setup (on migration day, done with the ops session)

1. Python 3.9 or newer on the server (standard library only, nothing to install).
2. One publisher per game server, run as a service that restarts on failure:
   `python3 tools/live_publish.py --watch <that server's NOBlackBox output folder> --out <web folder>/live/s1`
3. Caddy (automatic https certificates) serving `<web folder>` with:
   - `Access-Control-Allow-Origin: *`
   - `Cache-Control: no-cache` on `current.json` and `manifest.json`; the `.acmi.gz` pieces never change, so they can be
     cached.
4. A hostname for https (OVH gives each server one; a domain of Tomo's also works). The live URL is configured on the
   server and in the Discord poster, never committed to the repo (house rule: no server hostnames in git).
5. The Discord poster posts the "Watch live" link when a match starts (`current.json` changes to a new match).
6. Test with `tools/live_simulate.py` replaying a recorded match into a folder the publisher watches, before a real
   match.

## Decisions for Tomo

- The hostname to use (OVH's or a domain).
- The delay: 45 s on the server plus about 15 s in the viewer. Longer is safer against live spotting.
- Whether to keep a match's live pieces after it ends (the release zip covers replays; the default keeps the last 3
  matches per server).

## Test results

(Filled in from the publisher's test runs.)
