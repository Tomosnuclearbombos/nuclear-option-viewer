"""Build the map scenery tiles (towns, cities, bridges) for the viewer from Tomo's Tacview kit.

Sources (read only):
  ~/.local/share/tacview-no-models/addon/nuclear-option-scenery/main.lua   object names and lon/lat per MapId
  ~/.local/share/tacview-no-models/installed/Database/Default Properties/NuclearOption.TomoExtras.xml   Name -> Shape
  ~/.local/share/tacview-no-models/installed/Meshes/NOX_*.obj               the meshes (full detail, single sided)

Placement: game x = lon * 111319.49, game z = lat * 111319.49, altitude 0. Each OBJ's origin is the group's centre at
sea level with +X east, +Y up, -Z north (the kit converts Unity (x, y, z) -> (x, y, -z)). Scene frame of the viewer:
x = game x, y = up, z = -game z, so an OBJ vertex (vx, vy, vz) of an object at game (gx, gz) lands at scene
(gx + vx, vy, -gz + vz). Checked against the overview pictures (see the check renders).

Output per map, assets/maps/<key>/scenery/:
  t_<i>_<j>.glb   tile i, j on the game grid (game x in [i*4096, (i+1)*4096), game z in [j*4096, (j+1)*4096)).
                  One node with a translation (content bbox centre, scene coords), one mesh: POSITION float32 local to
                  the translation, indices u16 (< 65536 vertices) or u32. No normals, colours or materials.
                  Whole buildings go to the tile holding their centre (connected parts, plus parts whose ground
                  footprints overlap, are kept together); each bridge goes whole to one tile.
  index.json      tile list with scene-coord bounds, triangle and byte counts, kinds.

Full detail: every triangle of the kit meshes is kept (no simplification, no dedup of faces). Duplicate vertices are
merged (positions equal to 0.1 mm, the precision of the OBJ files).

  /home/tomo/.local/share/tacview-no-models/venv/bin/python -I tools/build_scenery.py [heartland|ignus ...]
"""
import json
import os
import re
import struct
import sys
import time

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

KIT = os.path.expanduser("~/.local/share/tacview-no-models")
LUA = f"{KIT}/addon/nuclear-option-scenery/main.lua"
XML = f"{KIT}/installed/Database/Default Properties/NuclearOption.TomoExtras.xml"
MESHES = f"{KIT}/installed/Meshes"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEG = 111319.49
TILE = 4096
WELD = 1e-4            # metres; the OBJ files carry 4 decimals
TOUCH = 0.05           # metres; footprints closer than this count as one building
MAPS = {"heartland": "NuclearOption.Terrain1", "ignus": "NuclearOption.Terrain_naval"}
SOURCE = "Tomo's Tacview kit (game scenery, used with the developers' OK)"

# OBJ (vx, vy, vz) of an object at game (gx, gz) -> scene coords. Kept in one place so the check can swap it.
def to_scene(V, gx, gz):
    return np.column_stack([gx + V[:, 0], V[:, 1], -gz + V[:, 2]])


def read_lua():
    """MapId -> [(name, lon, lat, alt)]."""
    out, cur = {}, None
    with open(LUA, encoding="utf-8") as fh:
        for ln in fh:
            m = re.match(r'\s*\["([^"]+)"\]\s*=\s*\{', ln)
            if m:
                cur = out.setdefault(m.group(1), [])
                continue
            m = re.match(r'\s*\{\s*0x[0-9A-Fa-f]+\s*,\s*"([^"]+)"\s*,\s*([-0-9.e]+)\s*,\s*([-0-9.e]+)\s*,\s*([-0-9.e]+)\s*\}',
                         ln)
            if m and cur is not None:
                cur.append((m.group(1), float(m.group(2)), float(m.group(3)), float(m.group(4))))
    return out


def read_shapes():
    """Name -> shape file, from the TomoExtras database."""
    txt = open(XML, encoding="utf-8").read()
    shapes = {}
    for block in re.findall(r"<DefaultProperties\b.*?</DefaultProperties>", txt, re.S):
        sh = re.search(r"<Shape>([^<]+)</Shape>", block)
        if not sh:
            continue
        for nm in re.findall(r"<Name>([^<]+)</Name>", block):
            shapes.setdefault(nm.strip(), sh.group(1).strip())
    return shapes


def read_obj(path):
    """Positions (n, 3) float64 and triangles (m, 3) int64; polygons fanned. Group names returned for the report."""
    vs, fs, groups = [], [], []
    with open(path, encoding="utf-8", errors="replace") as fh:
        for ln in fh:
            if ln.startswith("v "):
                vs.append(ln[2:])
            elif ln.startswith("f "):
                fs.append(ln[2:].split())
            elif ln.startswith(("o ", "g ")):
                groups.append(ln[2:].strip())
    V = np.array(" ".join(vs).split(), dtype=np.float64).reshape(-1, 3)
    n = len(V)
    tri = [f for f in fs if len(f) == 3]
    F = np.array([int(t.split("/", 1)[0]) for f in tri for t in f], dtype=np.int64).reshape(-1, 3)
    extra = []
    for f in fs:
        if len(f) > 3:
            idx = [int(t.split("/", 1)[0]) for t in f]
            extra += [(idx[0], idx[k], idx[k + 1]) for k in range(1, len(idx) - 1)]
    if extra:
        F = np.concatenate([F, np.array(extra, dtype=np.int64)])
    F = np.where(F > 0, F - 1, n + F)
    return V, F, groups


def weld(V, F):
    q = np.round(V / WELD).astype(np.int64)
    _, first, inv = np.unique(q, axis=0, return_index=True, return_inverse=True)
    return V[first], inv.reshape(-1)[F]


def components(nv, F):
    e = np.concatenate([F[:, [0, 1]], F[:, [1, 2]]])
    g = coo_matrix((np.ones(len(e), dtype=np.int8), (e[:, 0], e[:, 1])), shape=(nv, nv))
    return connected_components(g, directed=False)[1][F[:, 0]]


def merge_overlapping(lo, hi):
    """Union parts whose x/z footprints overlap (lo, hi: (k, 2) scene x, z). Returns a group label per part."""
    k = len(lo)
    parent = np.arange(k)

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    # sweep along x: parts sorted by min x; each part checks the ones that start before it ends
    order = np.argsort(lo[:, 0], kind="stable")
    slo, shi = lo[order], hi[order]
    starts = slo[:, 0]
    for a in range(k):
        end = np.searchsorted(starts, shi[a, 0] + TOUCH, side="right")
        if end <= a + 1:
            continue
        b = np.arange(a + 1, end)
        hit = b[(slo[b, 1] <= shi[a, 1] + TOUCH) & (shi[b, 1] >= slo[a, 1] - TOUCH)]
        ra = find(order[a])
        for c in hit:
            rc = find(order[c])
            if rc != ra:
                parent[rc] = ra
    return np.array([find(a) for a in range(k)])


def object_groups(name, kind, V, F):
    """Split one placed object into groups that must stay whole. Returns list of face-index arrays."""
    if kind == "bridge":
        return [np.arange(len(F))]
    comp = components(len(V), F)
    ncomp = comp.max() + 1
    xz = V[:, [0, 2]]
    corner = xz[F.reshape(-1)].reshape(-1, 3, 2)
    flo, fhi = corner.min(1), corner.max(1)
    lo = np.full((ncomp, 2), np.inf)
    hi = np.full((ncomp, 2), -np.inf)
    np.minimum.at(lo, comp, flo)
    np.maximum.at(hi, comp, fhi)
    grp = merge_overlapping(lo, hi)[comp]
    order = np.argsort(grp, kind="stable")
    cuts = np.flatnonzero(np.diff(grp[order])) + 1
    return np.split(order, cuts)


def write_glb(path, name, translation, pos, idx):
    big = len(pos) >= 65536
    idx = np.ascontiguousarray(idx.reshape(-1).astype("<u4" if big else "<u2"))
    pos = np.ascontiguousarray(pos.astype("<f4"))
    binbuf = bytearray(pos.tobytes())
    binbuf += b"\0" * (-len(binbuf) % 4)
    ioff = len(binbuf)
    binbuf += idx.tobytes()
    binbuf += b"\0" * (-len(binbuf) % 4)
    gltf = {
        "asset": {"version": "2.0", "generator": "Nuclear Option Viewer tools/build_scenery.py", "copyright": SOURCE},
        "scene": 0, "scenes": [{"nodes": [0]}],
        "nodes": [{"name": name, "mesh": 0, "translation": [float(t) for t in translation]}],
        "meshes": [{"name": name, "primitives": [{"attributes": {"POSITION": 0}, "indices": 1, "mode": 4}]}],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": len(pos), "type": "VEC3",
             "min": [float(v) for v in pos.min(0)], "max": [float(v) for v in pos.max(0)]},
            {"bufferView": 1, "componentType": 5125 if big else 5123, "count": len(idx), "type": "SCALAR"},
        ],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": pos.nbytes, "target": 34962},
            {"buffer": 0, "byteOffset": ioff, "byteLength": idx.nbytes, "target": 34963},
        ],
        "buffers": [{"byteLength": len(binbuf)}],
    }
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    with open(path, "wb") as fh:
        fh.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(binbuf)))
        fh.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
        fh.write(struct.pack("<II", len(binbuf), 0x004E4942) + bytes(binbuf))
    return os.path.getsize(path)


def build(key, lua, shapes):
    t0 = time.time()
    objs = lua[MAPS[key]]
    out_dir = f"{ROOT}/assets/maps/{key}/scenery"
    os.makedirs(out_dir, exist_ok=True)
    for f in os.listdir(out_dir):
        if re.fullmatch(r"t_-?\d+_-?\d+\.glb", f) or f == "index.json":
            os.remove(os.path.join(out_dir, f))

    tiles = {}             # (i, j) -> {"V": [...], "F": [...], "kinds": set(), "nv": int}
    src_tris = 0
    for name, lon, lat, alt in objs:
        shape = shapes[name]
        kind = "bridge" if "bridge" in name.lower() else "town"
        V, F, groups = read_obj(f"{MESHES}/{shape}")
        src_tris += len(F)
        if any(g.lower().startswith("transp") for g in groups):
            print(f"  note: {shape} has a Transparent group (kept as plain geometry)")
        gx, gz = lon * DEG, lat * DEG
        V = to_scene(V, gx, gz)
        V[:, 1] += alt
        V, F = weld(V, F)
        parts = object_groups(name, kind, V, F)
        sizes = []
        for faces in parts:
            sub = F[faces]
            used = np.unique(sub)
            P = V[used]
            lo, hi = P.min(0), P.max(0)
            cx, cz = (lo[0] + hi[0]) / 2, -(lo[2] + hi[2]) / 2      # centre in game x, z
            ij = (int(np.floor(cx / TILE)), int(np.floor(cz / TILE)))
            t = tiles.setdefault(ij, {"V": [], "F": [], "kinds": set(), "nv": 0})
            remap = np.searchsorted(used, sub)
            t["V"].append(P)
            t["F"].append(remap + t["nv"])
            t["nv"] += len(P)
            t["kinds"].add(kind)
            sizes.append(max(hi[0] - lo[0], hi[2] - lo[2]))
        sizes = np.array(sizes)
        print(f"  {name:34s} {len(F):7d} tris  {len(parts):5d} groups  largest {sizes.max():7.0f} m"
              f"  median {np.median(sizes):5.0f} m  at game ({gx:.0f}, {gz:.0f})")

    index = {"tileSize": TILE, "tiles": [], "tris": 0, "bytes": 0, "source": SOURCE}
    for (i, j) in sorted(tiles):
        t = tiles[(i, j)]
        V, F = weld(np.concatenate(t["V"]), np.concatenate(t["F"]))
        lo, hi = V.min(0), V.max(0)
        centre = np.round((lo + hi) / 2, 3)
        fname = f"t_{i}_{j}.glb"
        nbytes = write_glb(f"{out_dir}/{fname}", f"t_{i}_{j}", centre, V - centre, F)
        index["tiles"].append({"file": fname, "bounds": [round(float(v), 3) for v in (*lo, *hi)],
                               "tris": int(len(F)), "bytes": int(nbytes), "kinds": sorted(t["kinds"])})
        index["tris"] += int(len(F))
        index["bytes"] += int(nbytes)
        print(f"  {fname:14s} {len(F):8d} tris {len(V):8d} verts {nbytes / 1e6:7.2f} MB  {sorted(t['kinds'])}")
    with open(f"{out_dir}/index.json", "w") as fh:
        json.dump(index, fh, indent=1)
    assert index["tris"] == src_tris, (index["tris"], src_tris)
    print(f"{key}: {len(index['tiles'])} tiles, {index['tris']} tris (source {src_tris}), "
          f"{index['bytes'] / 1e6:.2f} MB  [{time.time() - t0:.1f} s]")
    return index


def main():
    keys = sys.argv[1:] or list(MAPS)
    lua, shapes = read_lua(), read_shapes()
    for key in keys:
        print(key)
        build(key, lua, shapes)


if __name__ == "__main__":
    main()
