# Nuclear Option Viewer — project notes

A browser viewer for Nuclear Option replays (Tacview `.acmi` / `.zip.acmi` files recorded on Tomo's Nukes servers by
our NOBlackBox fork). The point is **clarity**: the ACMI viewer and Tacview aren't made for Nuclear Option. This viewer
shows the real map with terrain, Tomo's own 3D models, and labels and icons that stay readable. It should be better
optimised than Tacview.

Owner: Tomo (GitHub `Tomosnuclearbombos`). Started 2026-10-14 from a plan he approved.

## Owner decisions (2026-10-14)

- **Name:** Nuclear Option Viewer.
- **Hosting:** a static site on GitHub Pages. No server and no replay hosting: people download the `.zip.acmi` from the
  GitHub release (repo `Tomosnuclearbombos/tomosnukes-replays`, one release per mission) and drag it into the viewer,
  or watch it in Tacview. "Let's not overcook it." No pack/convert step: the viewer reads the raw file.
- **Models:** Tomo's model kit on the gaming PC, `~/.local/share/tacview-no-models` (built 10-04/05 for Tacview).
  It holds 108 .obj meshes, heightmaps, map textures at 5 m/px, cities, the Ignus towns and the bridges. The `NOX_`
  models and the map data were extracted from the game files. The other 54 entries came from the community NOBlackBox
  Tacview pack: someone else's work, licence unknown. Prefer models rebuilt from the game files (the kit's
  `scripts/no_tacview_mesh.py`) over that pack.
- **Models, updated 2026-10-14:** use the Tacview models first. Tomo: "the ones we made and the community made for
  tacview work well! we may as well use those or something similar". The sources:
  - the community pack github.com/KopterBuzz/NOBlackBoxTacviewAssets (157 meshes plus a Tacview database). Its repo
    has no licence file, but Tomo has KopterBuzz's permission to use it in the viewer (through the NOBlackBox fork).
    Credit him in the viewer.
  - the kit's own NOX_ models.
  - for any unit neither covers, models built from the game files the same way (tools/build_models.py).
- **Permission (2026-10-14):** the game's developers told Tomo on Discord that using the game's models and maps is
  fine, as long as they aren't used for a similar purpose (in another game). They had recently given the same OK for
  3D and art competitions. A replay viewer qualifies, so game-derived models and map data may ship with the viewer.
- **Start page credit, Tomo's exact words (2026-10-15):** "Inspired by ACMI Viewer by Aleksi Lassila. Unit models from
  the NOBlackBox Tacview assets by KopterBuzz, forked by Tomo." Not "Tomo's own models". The changelog and the
  #how-to-replay post use the same words.
- **Credit:** acmi-viewer.github.io (author Aleksi Lassila) for the inspiration and idea. Tomo will contact him. That
  repo has **no licence**, so learn from its design but never copy its code. three.js and fflate are MIT and fine to
  use.
- **Performance target:** Tomo will test on the server PC, a mini PC with Intel Iris Xe graphics. If it's smooth there,
  it's smooth anywhere.
- **Repo:** private until Tomo says to go public (GitHub Pages on a free account needs a public repo).

## Plan (approved)

**Phase 1, core viewer**
- Drag and drop a replay; parse it in a worker.
- Real terrain with Tomo's map images draped over it; water and sky. Lighting follows the mission's time of day and
  weather (Dawn / Dusk / Night / Thunderstorm in the mission name, time of day from ReferenceTime).
- 3D models in side colours; far units become icons that keep a minimum size.
- Cameras: free orbit, follow, cockpit, and a top-down map view.
- Labels with pilot names, trails, altitude curtains.
- Timeline with an activity graph, speeds from 0.1x to 128x, and a URL hash for time and selection.
- Settings (Tomo 2026-10-15), saved in the browser (localStorage `nov.settings.v1`, src/ui/settings.js):
  - map: Terrain / Tactical (the game's green map screen with its grid) / Empty (a sea level grid, like ACMI Viewer)
  - units: Focus (minimum size on screen) / Real Size
  - graphics: resolution, frame rate cap, smooth edges (on reload), detailed or simple models, scenery, effects
  - labels, trails and curtains are remembered too

**Phase 2, Tacview analysis tools**
- Telemetry panel: altitude, AGL, TAS, Mach, AoA, G (computed), throttle, gear, stick inputs, radar mode, locks.
- Telemetry charts over time.
- Radar lock lines and missile-to-target lines.
- SAM and ship threat rings/domes from `EngagementRange`.
- A ruler: range, bearing, height difference, closure.
- Events log (launches, kills, deaths, takeoffs and landings; click to jump).
- Per-pilot debrief.

**Phase 3, Nuclear Option extras**
- Nuke blasts with real ring sizes. Ring 13 x cbrt(kg) only above 200 kg, else stock ~58 m. Warhead kg from
  nuclearoption.wiki.gg/wiki/Munitions — look it up, never guess.
- Gun rounds as tracers.
- Explosions, flares, destroyed markers.
- Player ranks.
- "Watch in Nuclear Option Viewer" in the Discord #replays posts. The poster runs on the server PC and is a small
  change there later.

## Recording format (NOBlackBox, Nuclear Option 0.34.x)

- **Header:**
  - `FileVersion=2.2`.
  - `ReferenceTime` = mission time of day (fictional date).
  - `RecordingTime` = real UTC start.
  - `MapId=NuclearOption.Terrain1` (Heartland) or `NuclearOption.Terrain_naval` (Ignus).
  - `Title` = mission name.
- **`T=` has 9 fields:** `lon|lat|alt|roll|pitch|yaw|U|V|heading`.
  - Gun rounds, explosions and some other objects have 5 fields: `lon|lat|alt|U|V`.
  - **Use U/V, not lat/lon.** U/V are exact game-world metres (proven: 92.5% of 1.6 M moving-vehicle samples sit on
    the game's road meshes with zero offset). Lat/lon are tiny fake values near 0,0.
  - `alt` is metres MSL.
- **Properties:** Name, CallSign, Pilot (player name, only when known), Coalition (Boscali / Primeva), Color, Type,
  TAS, Mach, AOA, AGL, Pitch/Roll/YawControlInput, Throttle, LandingGear, RadarMode, LockedTarget and
  LockedTarget1..9, Visible, Radius, EngagementRange, Debug. EngineRPM may appear in older files.
- **Types seen:**
  - Air+FixedWing / Air+Rotorcraft.
  - Ground+... (Vehicle, Tank, AntiAircraft, Sensor, Static+Building).
  - Sea+Watercraft (+Warship, +AircraftCarrier).
  - Weapon+Missile / Weapon+Bomb, Projectile+Shell.
  - Misc+Projectile+Shell (gun rounds), Misc+Decoy+Flare, Misc+Explosion.
- **Gun rounds:** exactly 2 positions each (muzzle, then end point), then removal. Interpolate between them.
- **Events:** only `0,Event=Message|<id>|Has been destroyed.`
  - No launch or kill attribution in the file.
  - The server PC's bot keeps a kill ledger (killer, weapon, time, x/z). It could be exported per mission later; it is
    not public.
- **Ids:** hex. Recycled after a `-id` removal line.
- **Sizes:** a busy 2 h S2 mission is ~400 MB of text, 140-190 MB zipped. Tomo says that's fine. Still parse
  streaming in a worker and store as typed arrays, never one big string.

## Maps and terrain (game-world metres)

- **Heartland (Terrain1):**
  - 16x16 terrain tiles of 5120 m, so x and z span +-40960.
  - Heights 0..1307 m.
- **Ignus (Terrain_naval):**
  - x +-81920, z +-40960.
  - Islands `terrain_naval_island1..15`.
- **Terrain meshes:** these survive in the dedicated server build (`NuclearOptionServer_Data/sharedassets1.assets` +
  `.resS`; Heartland tiles `terrain2_tile*` x256, yaw 180, y -200). The game client install also has the full map
  textures.
- **Tomo's hi-res map images:** Heartland 8192², Ignus 8192x4096 and 16384x8192 colour. They cover the full terrain
  bounds above.
- **Side colours:** BDF / Boscali `#A76BFF` (lavender), PALA / Primeva `#FFB800` (yellow). These match the server
  panel and the 2D replay videos.

## House rules

- **Commits:** `TomosBombos <323103104+Tomosnuclearbombos@users.noreply.github.com>`, never his Gmail. End messages
  with the Co-Authored-By line.
- **Never commit:**
  - server IPs or hostnames. One exception (Tomo, 2026-10-15): the live feed's VPS address in `src/live.js`
    (`LIVE_PVE`), for the start page's live match button. It's public in the Discord alert anyway.
  - Steam IDs (except Tomo's own)
  - tokens, keys or passwords
  - the Discord webhook
- **Player-facing text:** no dashes (hyphens or em dashes as punctuation). Plain words, in Tomo's voice.
- **Version numbers are Tomo's call.** Ask before anything goes public: making the repo public, turning on Pages, or
  posting anywhere.
- **Answer his actual question first, in plain English.** Do only what he asks; no unasked extras.
