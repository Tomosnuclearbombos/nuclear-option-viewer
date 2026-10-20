# Live viewer

Status: live for S2 (PvE) since 2026-10-15. Tomo's decisions are in CLAUDE.md ("Live mode").

## What people get

- A link in the S2 new mission Discord alert, and the start page's LIVE MATCH: PVE SERVER key (lit while a match is on,
  grey when not), open the viewer on the match being played, about a minute behind.
- Everything the replay viewer does works the same: map, models, labels, following, tracers, explosions.
- The LIVE key: lit at the live moment, GO LIVE when paused, rewound or sped up. It also carries the feed's state, since
  phones hide the mission panel: RECONNECTING, FEED PAUSED (nothing new is arriving) or MATCH OVER.
- Rewind through the last 15 minutes (5 minutes on phones and tablets, to keep the download and memory down).
- When the match ends it plays out to its last piece, says the match is over, and when the next S2 match is on air the
  viewer opens it freshly (its own map, title and lighting).

## How it works

```
PvE box: NOBlackBox writes the match's .acmi into /home/container/tacview as it goes
     |  read every second, from the same box
     v
PvE box: tools/live_runner.py (the systemd user unit nov-live-s2, run by PvE OPs) runs tools/live_publish.py
     |  every 10 s of match time one piece, published only once it is 45 s old
     v  uploaded over ssh (the "vps" alias in ~/.ssh/config)
OVH VPS: Caddy serves /srv/nov-live/s2 over https
     v
viewer: ?live=<the VPS>/s2/current.json (or ?live=pve)
```

- **The delay is enforced by the publisher**: a piece only exists once it is 45 s old, also at a match end (the last
  pieces go out on the wall clock as if the match had kept running). The viewer plays 15 s behind the newest piece.
- **Each piece stands alone**: header, a snapshot of every unit at its start, `// nov-keyframe-end`, then the recording's
  own lines for that stretch. The viewer joins the newest contiguous run of pieces (the first whole, the rest after the
  marker) and reads it with the same reader a dropped file goes through, rebuilding as pieces arrive and keeping the
  time, camera, selection, follow and hover. After a feed outage it jumps back to the live moment if you were on it.
- **PvP never goes out live**: the runner reads the bot's PVP_MISSIONS list out of its file (--pvp-list; the bot is
  never imported or run) and the publisher writes nothing for a mission on it. If the list can't be read, nothing goes
  out. Only the S2 feed exists.
- **Restarts are safe**: piece names come from their place in the match, so a restarted publisher rebuilds the same
  bytes under the same names. Catching up on a long match skips pieces that can't be shown (a 3 h, 610 MB recording
  catches up in about 20 s).
- **Cleanup**: a match's folder is deleted about 10 minutes after its last piece; the publisher also sweeps folders left
  behind by an earlier run.
- **Known gap**: the recorder zips the file away the moment a match ends, so up to about a second of the very end can
  miss the live feed. The full replay has it.

## The format (nov-live-1)

- `current.json`: `{format, match, manifest, title, mapId, ended, updated}` for the one match on air, or
  `{format, match: null, manifest: null, ended: true, updated}` when none is.
- `<match>/manifest.json`: `{format, match, title, mapId, referenceTime, recordingTime, pieceSeconds, delaySeconds,
  ended, updated, start, pieces: [{seq, file, t0, t1, bytes, final?}]}`. `start` is the recording's first frame time
  (the viewer counts elapsed time from it). `ended` means every piece is out.
- `<match>/c<seq>.acmi.gz` covers frame times (t0, t1]. The match's last piece, cut short, is `c<seq>e.acmi.gz` with
  `final: true`.
- Files are written to a temporary name and renamed into place, the manifest last.

## Web server (Caddy on the VPS)

- `Access-Control-Allow-Origin: *` on everything, errors included.
- `Cache-Control: no-store` on the json files and on errors; `public, max-age=86400, immutable` on pieces that exist.
- `*.tmp` (files being uploaded) answer 404.

## Test results (2026-10-15)

- Join check: pieces cut from a recorded match and joined the viewer's way read back with the same unit states as the
  original, in 6 windows (7,000 to 8,000 states each, 0 mismatches).
- Delay check: all 451 piece versions written in an end to end run (two matches, a mission change and publisher
  restarts) held nothing newer than the recording minus 45 s.
- A restarted publisher rewrote 105 pieces byte for byte the same.
- Viewer: first picture from the newest 3 minutes (about 4 MB) in 2 to 5 s; a mission change opens the next match on
  its own map with the selection cleared; a dropped piece, a hung request, a dead feed and a missing feed all show the
  right state; phones keep 5 minutes and show the state on the key.
