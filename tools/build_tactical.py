"""Pull the game's own tactical map pictures (the green in-game map) out of the client install.

    ~/.local/share/tacview-no-models/venv/bin/python -I tools/build_tactical.py [--game <NuclearOption_Data>]

Needs UnityPy (the kit's venv has it). Reads sharedassets1.assets read-only. Re-run after a game update.

The in-game map is a greyscale picture (hill shading, coastlines, roads, towns) that the game tints pure green
(#00FF00) and draws additively over a black plate, with a green 10 km / 1 km grid on top.

Outputs:
  assets/maps/<map>/tactical.png   greyscale, full size (Heartland 4096^2, Ignus 8192x4096), same area as meta.json
  assets/ui/backdrop.jpg           Heartland tinted the game's green on black, 2048^2, for the start screen
"""
import argparse
import os

import numpy as np
import UnityPy
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_GAME = os.path.expanduser("~/.local/share/Steam/steamapps/common/Nuclear Option/NuclearOption_Data")
WANT = {"terrain2_map": "heartland", "terrain_naval_map": "ignus"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", default=DEFAULT_GAME)
    a = ap.parse_args()
    env = UnityPy.load(os.path.join(a.game, "sharedassets1.assets"))
    found = {}
    for o in env.objects:
        if o.type.name != "Texture2D":
            continue
        name = o.peek_name()
        if name not in WANT or name in found:
            continue
        img = o.read().image.convert("L")      # R = G = B in the game file
        found[name] = img
        out = os.path.join(ROOT, "assets", "maps", WANT[name])
        os.makedirs(out, exist_ok=True)
        img.save(os.path.join(out, "tactical.png"), optimize=True)
        print(f"{name}: {img.size} -> assets/maps/{WANT[name]}/tactical.png")
    missing = set(WANT) - set(found)
    if missing:
        raise SystemExit(f"not found in the game files: {', '.join(sorted(missing))}")

    # start screen backdrop: the game's look (green x picture, additive over black), a little brighter to read,
    # with the game's grid added on top: 10 km squares at #007400 (2 px) and 1 km lines at #004100 (1 px)
    N = 2048
    pic = np.asarray(found["terrain2_map"].resize((N, N), Image.LANCZOS), dtype=np.float32) * 1.35
    # grid lines sit on whole kilometres of game x / z, the 10 km ones on multiples of 10 km (Heartland spans
    # -40.96 .. +40.96 km, row 0 = north)
    grid = np.zeros((N, N), dtype=np.float32)
    for k in range(-40, 41):
        px = int(round((k + 40.96) / 81.92 * (N - 1)))
        major = k % 10 == 0
        val, width = (116.0, 2) if major else (65.0, 1)
        for w in range(width):
            c = min(N - 1, px + w)
            grid[:, c] = np.maximum(grid[:, c], val)
            r = (N - 1) - c                      # rows count from the north, so mirror for z
            grid[r, :] = np.maximum(grid[r, :], val)
    g = np.clip(pic + grid, 0, 255).astype(np.uint8)   # the game adds the grid on top (Blend One One)
    black = np.zeros_like(g)
    img = Image.fromarray(np.dstack([black, g, black]), "RGB")
    os.makedirs(os.path.join(ROOT, "assets", "ui"), exist_ok=True)
    img.save(os.path.join(ROOT, "assets", "ui", "backdrop.jpg"), quality=86, optimize=True, progressive=True)
    print("start screen backdrop -> assets/ui/backdrop.jpg")


if __name__ == "__main__":
    main()
