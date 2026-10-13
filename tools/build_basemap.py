"""Build the base map assets the viewer loads first: one overview picture and one height grid per map.

    python3 tools/build_basemap.py [--kit ~/.local/share/tacview-no-models]

Inputs come from Tomo's Tacview model kit (built from the game's files; the game's developers OK'd using them):
  heights  mapbuild/game-heights/*_game10m.raw (Heartland) and *_game20m.raw (Ignus): int16 little endian, 8193x8193,
           row 0 = north, sea = negative
  pictures mapbuild/heartland-ab/*_Terrain1_A.jpg (16384^2) and mapbuild/ignus-texture/*_naval_A.jpg (32768^2), 5 m/px

Outputs (assets/maps/<map>/):
  overview.jpg   the whole map, for the far view and as the fallback under detail tiles
  height.i16.gz  gzipped int16 metres, row 0 = north, 20 m spacing
  meta.json      where all of it sits in game metres (x east, z north)
"""
import argparse
import gzip
import json
import os

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MAPS = [
    {
        "key": "heartland", "mapId": "NuclearOption.Terrain1", "name": "Heartland",
        "heights": "mapbuild/game-heights/NOX_NuclearOption_heightmap_Terrain1_game10m.raw",
        "heightsSpan": 40960, "heightsStep": 10,          # samples at -40960 + 10 i, z = 40960 - 10 j
        "picture": "mapbuild/heartland-ab/NOX_NuclearOption_texture_Terrain1_A.jpg",
        "pictureSpan": 40960,                             # pixel edges at +-40960
        "x": (-40960, 40960), "z": (-40960, 40960),       # map area in game metres
        "overview": (4096, 4096),
    },
    {
        "key": "ignus", "mapId": "NuclearOption.Terrain_naval", "name": "Ignus Archipelago",
        "heights": "mapbuild/game-heights/NOX_NuclearOption_heightmap_Terrain_naval_game20m.raw",
        "heightsSpan": 81920, "heightsStep": 20,
        "picture": "mapbuild/ignus-texture/NOX_NuclearOption_texture_Terrain_naval_A.jpg",
        "pictureSpan": 81920,
        "x": (-81920, 81920), "z": (-40960, 40960),       # the game's 2:1 map inside the square files
        "overview": (8192, 4096),
    },
]
STEP = 20  # output height spacing, metres


def build(m, kit):
    out = os.path.join(ROOT, "assets", "maps", m["key"])
    os.makedirs(out, exist_ok=True)
    x0, x1 = m["x"]
    z0, z1 = m["z"]

    # ---- heights: crop to the map area, resample to 20 m ----
    n = 8193
    h = np.fromfile(os.path.join(kit, m["heights"]), dtype="<i2").reshape(n, n)
    span, step = m["heightsSpan"], m["heightsStep"]
    stride = STEP // step
    # column i -> x = -span + step i ; row j -> z = span - step j  (row 0 = north = z max)
    i0, i1 = (x0 + span) // step, (x1 + span) // step
    j0, j1 = (span - z1) // step, (span - z0) // step
    hh = h[j0:j1 + 1:stride, i0:i1 + 1:stride]
    hh = np.ascontiguousarray(hh, dtype="<i2")
    with gzip.open(os.path.join(out, "height.i16.gz"), "wb", compresslevel=9) as f:
        f.write(hh.tobytes())
    rows, cols = hh.shape

    # ---- overview picture: crop to the map area, shrink ----
    im = Image.open(os.path.join(kit, m["picture"]))
    W, H = im.size
    pspan = m["pictureSpan"]
    px = W / (2 * pspan)                       # pixels per metre
    box = (round((x0 + pspan) * px), round((pspan - z1) * px), round((x1 + pspan) * px), round((pspan - z0) * px))
    ow, oh = m["overview"]
    im.draft("RGB", (max(ow, oh) * 2, max(ow, oh) * 2))  # decode the JPEG at a reduced scale: fast, low memory
    k = im.size[0] / W
    im = im.crop(tuple(round(v * k) for v in box)).resize((ow, oh), Image.LANCZOS)
    im.save(os.path.join(out, "overview.jpg"), quality=88, optimize=True, progressive=True)

    meta = {
        "key": m["key"], "mapId": m["mapId"], "name": m["name"],
        "x0": x0, "x1": x1, "z0": z0, "z1": z1,
        "height": {"file": "height.i16.gz", "cols": cols, "rows": rows, "step": STEP,
                   "min": int(hh.min()), "max": int(hh.max()), "note": "int16 metres, row 0 = north (z1), col 0 = west (x0)"},
        "overview": {"file": "overview.jpg", "width": ow, "height": oh},
        "source": "Nuclear Option game data via Tomo's Tacview kit; used with the developers' OK",
    }
    with open(os.path.join(out, "meta.json"), "w") as f:
        json.dump(meta, f, indent=2)
    size = sum(os.path.getsize(os.path.join(out, p)) for p in os.listdir(out))
    print(f"{m['key']}: heights {cols}x{rows} ({hh.min()}..{hh.max()} m), overview {ow}x{oh}, {size / 1e6:.1f} MB")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--kit", default=os.path.expanduser("~/.local/share/tacview-no-models"))
    a = ap.parse_args()
    for m in MAPS:
        build(m, a.kit)


if __name__ == "__main__":
    main()
