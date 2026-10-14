"""Turn the Tacview models Tomo likes into GLB files for the viewer, mapped to recorded Names the way Tacview maps them.

    ~/.local/share/tacview-no-models/venv/bin/python -I tools/build_tacview_models.py PACK KIT \
        [--stock DIR] [--replays FILE ...] [--out assets/models-tacview]

Inputs (all read only):
  PACK       a checkout of github.com/KopterBuzz/NOBlackBoxTacviewAssets: database/NuclearOption.xml and
             meshes/*.obj. Treated as data only. It also ships .ps1/.bat installers: they are never run.
  KIT        Tomo's Tacview kit, ~/.local/share/tacview-no-models/installed (the kit root works too):
             Meshes/*.obj and Database/Default Properties/NuclearOption.TomoExtras.xml.
  --stock    optional: Tacview's own database, the folder 'Database/Default Properties' of github.com/Vyrtuoz/Tacview.
             With it Tacview's generic entries take part in the matching exactly as they do in Tacview, so a Name
             that Tacview would give one of its own (not Nuclear Option) shapes stays unmapped. Without it, the table
             BASES below stands in for the few Tacview base classes the two databases derive from.
  --replays  optional .zip.acmi / .txt.acmi files. Every Name recorded in them is matched as well (with its recorded
             Type), added to the aliases and listed in a coverage table.

Needs numpy, plus fast_simplification for meshes over budget (the kit's venv has both).

How Tacview picks the model for a recorded object (rules from Tacview's own Tacview.DefaultProperties.Core.xml and
its manual), as this script applies them:
  - Each database file has a LoadingOrder (older files say Priority). Files load lowest first: Tacview's own 0.0 to
    0.1, the pack 1.0, the kit 1.1. An entry whose Id appears again in a later file is replaced completely.
  - Base: an entry inherits every property it does not declare (Shape, Type filter, ...) from its Base entry.
  - Criteria/Type (inherited; the last one declared in an entry counts): every tag in it must be in the object's
    recorded Type, or the entry is not a candidate. E.g. Core.Missile needs "Missile", the Vehicle.* classes need
    "Vehicle", so the pack bases the trailers (recorded Type "Ground") on Core.Default.
  - Criteria/Name (any number of aliases): all significant characters of an alias must be found in the recorded
    Name. Characters like - ( ) and spaces are not significant: they only add to the score when they match too.
    The alias with the most characters wins. "*" matches anything with the lowest score. Ties go to the file
    loaded last.
  - Properties/Shape names an .obj in Data/Meshes (case sensitive). The kit's mesh folder is searched first.
  - Tacview has no rotation, offset or scale property for shapes (none in its format, none in these files), so
    meshes are used as they are: metres, nose -Z, up +Y, right +X, origin = the recorded position. Checked against
    the replays: ground vehicles' recorded altitude sits 0.8 to 1.8 m above the game's terrain and the meshes' wheels
    reach that far below their origin; units move along their recorded heading.

What this script adds on top:
  - When the kit has a model built from the game files for a unit (NOX_<prefab>.obj), it is used for every name of
    that unit, also the names only the pack lists (e.g. the pack's Missile_G2G names use NOX_Missile_G2G).
  - Meshes with identical geometry become one model (e.g. the four containers, the HE and nuclear Piledriver).
  - Left out: the kit's map scenery (NOX_Heartland_*, NOX_Ignus_*: cities, towns and bridges that its Tacview add-on
    places, not units) and pack meshes no database entry uses.
  - Quads and polygons are fanned into triangles (Tacview itself would show only the first half of a quad).
  - Triangle budgets per kind (BUDGET, budget()). Over budget a mesh is decimated (fast_simplification), whole or
    piece by piece, and a version is only used if it keeps the box, the outlines and every visible piece
    (shape_kept); otherwise the target grows, up to MAX_GROWTH times the budget. The kit's game-built vehicles are
    kept as built.
  - Faces the viewer would see from behind (its material culls back faces, so they show as holes; the pack has a
    few open or inside-out meshes such as Ruin_Building1 and Platform_small_columns) are found by looking at the
    mesh from 26 directions: turned round when only ever seen from behind, given a reversed copy when seen from
    both sides. (Tacview culls back faces as well, so it shows those holes.)

Outputs (assets/models-tacview/):
  <key>.glb    one mesh: POSITION, NORMAL (split at edges sharper than 40 degrees), COLOR_0 (grey 0.8, glass and
               canopies 0.3), indices. Same axes and origin as the Tacview mesh.
  index.json   { "models": { key: {file, kind, tris, size {len, wid, hgt}, source, names} },
                 "aliases": { recorded Name (trimmed): key }, "credits": { "community": ..., "kit": ... } }
"""
import argparse
import collections
import hashlib
import io
import json
import os
import re
import struct
import xml.etree.ElementTree as ET
import zipfile

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(ROOT, "assets", "models-tacview")

# Triangle budget per kind: (decimate above this, down to this). See budget() for the ground vehicle rules.
BUDGET = {"plane": (8000, 6000), "heli": (8000, 6000), "ship": (20000, 20000),
          "ground": (1800, 1500), "weapon": (360, 300), "building": (1200, 1000)}
GROUND_MAX = 2500      # detailed ground vehicles: at most halved, down to no less than 1,500 and no more than this
KIT_GROUND_KEEP = 6000  # the kit's game-built vehicles are kept as built up to this


def budget(kind, source, tris_in):
    """(decimate above, down to) for one model. Ground vehicles: the kit's game-built ones (back-to-back faces,
    about 5,000 triangles) are kept as built, since decimating them broke the wheels and removed the MLRS truck's
    outriggers. The pack's detailed trucks are at most halved (1,500 to 2,500 triangles), so radomes and wheels keep
    their shape."""
    above, want = BUDGET[kind]
    if kind == "ground":
        if source == "kit":
            return KIT_GROUND_KEEP, KIT_GROUND_KEEP
        want = int(min(max(want, tris_in / 2), GROUND_MAX))
    return above, want
GREY, GREY_GLASS = 0.8, 0.3
SMOOTH_DEG = 40.0
GLASS = re.compile(r"transparent|glass|canopy|window|visor", re.I)   # o / g / usemtl names
SCENERY = re.compile(r"^NOX_(Heartland|Ignus)_")

# Tacview's base classes used by the Nuclear Option databases: (Type filter, kind). From Tacview's own files.
BASES = {
    "Core.Default": ("", None),
    "Core.Shell": ("Shell", "weapon"), "Core.Missile": ("Missile", "weapon"), "Bomb.Glider": ("Bomb", "weapon"),
    "Vehicle.Military.Truck": ("Vehicle", "ground"), "Vehicle.Military.APC": ("Vehicle", "ground"),
    "Vehicle.Military.Tank": ("Vehicle", "ground"),
    "FixedWing.Fighter.Jet": ("FixedWing", "plane"), "FixedWing.Fighter.TwinProp": ("FixedWing", "plane"),
    "FixedWing.Bomber.Jet": ("FixedWing", "plane"),
    "Rotorcraft.Attack": ("Rotorcraft", "heli"), "Watercraft.Military": ("Watercraft", "ship"),
}
CORE_KIND = {"Core.FixedWing": "plane", "Core.Rotorcraft": "heli", "Core.Watercraft": "ship",
             "Core.Vehicle": "ground", "Core.Weapon": "weapon"}
# Units the databases put under Core.Default (no class) that are vehicles, not buildings
GROUND_UNITS = {"CRAMTrailer1", "LaserTrailer1", "Truck2-MLRS", "HLT-MArt", "SAMTurret1", "pilotDismounted"}

CREDITS = {
    "community": {
        "title": "NOBlackBox Tacview Assets",
        "author": "KopterBuzz",
        "url": "https://github.com/KopterBuzz/NOBlackBoxTacviewAssets",
        "text": "This is the Tacview Asset pack for recordings generated with NOBlackBox "
                "(https://github.com/KopterBuzz/NOBlackBox)",
        "note": "Used in Nuclear Option Viewer with KopterBuzz's permission. Thank you!",
    },
    "kit": {
        "title": "Tomo's Tacview kit",
        "text": "Models built from the Nuclear Option game files, used with the developers' OK.",
    },
}


# ---------------------------------------------------------------- Tacview database

class Entry:
    def __init__(self, dp, lo, seq, src):
        self.id = dp.get("Id") or ""
        self.base = (dp.get("Base") or "").strip() or None
        self.lo, self.seq, self.src = lo, seq, src
        crit = dp.find("Criteria")
        self.has_criteria = crit is not None
        self.names = [(n.text or "").strip() for n in crit.findall("Name")] if crit is not None else []
        types = [(t.text or "").strip() for t in crit.findall("Type")] if crit is not None else []
        self.type_decl = types[-1] if types else None         # the last Type declared counts
        props = dp.find("Properties")
        self.props = {p.tag: (p.text or "").strip() for p in props} if props is not None else {}


def load_databases(files):
    """files: [(path, src)]. Returns {Id: Entry} after Tacview's loading order and replacement rules."""
    loaded = []
    for path, src in files:
        root = ET.parse(path).getroot()
        lo = float(root.get("LoadingOrder") or root.get("Priority") or 0)
        loaded.append((lo, len(loaded), path, src, root))
    entries, seq = {}, 0
    for lo, _, path, src, root in sorted(loaded, key=lambda t: (t[0], t[1])):
        for dp in root.findall("DefaultProperties"):
            seq += 1
            e = Entry(dp, lo, seq, src)
            entries[e.id] = e                                    # later file / later declaration replaces
    return entries


def chain(entries, e):
    seen = set()
    while e is not None and e.id not in seen:
        seen.add(e.id)
        yield e.id, e
        if not e.base:
            return
        nxt = entries.get(e.base)
        if nxt is None:
            yield e.base, None                                   # base class from Tacview's own files, not loaded
            return
        e = nxt


def inherited(entries, e, prop):
    for _, x in chain(entries, e):
        if x is not None and prop in x.props:
            return x.props[prop]
    return None


def type_filter(entries, e):
    for eid, x in chain(entries, e):
        if x is None:
            return BASES.get(eid, ("", None))[0]
        if x.type_decl is not None:
            return x.type_decl
    return ""


def class_kind(entries, e):
    for eid, x in chain(entries, e):
        if eid in BASES and BASES[eid][1]:
            return BASES[eid][1]
        if eid in CORE_KIND:
            return CORE_KIND[eid]
    return None


def tagset(t):
    return frozenset(x.strip().lower() for x in (t or "").split("+") if x.strip())


def significant(s):
    return "".join(ch for ch in s.lower() if ch.isalnum())


class Matcher:
    """Tacview's best match between a recorded Name (+ Type) and the database entries."""

    def __init__(self, entries):
        self.cands = []
        for e in entries.values():
            if not e.has_criteria:
                continue
            need = tagset(type_filter(entries, e))
            aliases = [(a, significant(a), a.lower()) for a in e.names if a]
            self.cands.append((e, need, aliases))

    def best(self, name, rec_type):
        tags = tagset(rec_type)
        n_sig, n_low = significant(name), name.lower()
        best = None
        for e, need, aliases in self.cands:
            if need and not need <= tags:
                continue
            for alias, a_sig, a_low in aliases:
                if alias == "*":
                    score = (0, 0)
                elif a_sig and a_sig in n_sig:
                    score = (len(a_sig), len(alias) if a_low in n_low else len(a_sig))
                else:
                    continue
                key = (score, e.lo, e.seq)
                if best is None or key > best[0]:
                    best = (key, e, alias)
        return best


# ---------------------------------------------------------------- meshes

def read_obj(path):
    """Wavefront OBJ -> V (n,3) float64, F (m,3) int64, glass (m,) bool. Polygons are fanned; lines ignored."""
    V, F, G = [], [], []
    glass = False
    names = {"o": "", "g": "", "usemtl": ""}
    with open(path, encoding="utf-8", errors="replace") as fh:
        for ln in fh:
            t = ln.split()
            if not t:
                continue
            k = t[0]
            if k == "v":
                V.append((float(t[1]), float(t[2]), float(t[3])))
            elif k == "f":
                idx = []
                for tok in t[1:]:
                    i = int(tok.split("/")[0])
                    idx.append(i - 1 if i > 0 else len(V) + i)
                for j in range(1, len(idx) - 1):
                    F.append((idx[0], idx[j], idx[j + 1]))
                    G.append(glass)
            elif k in names:
                names[k] = " ".join(t[1:])
                glass = any(GLASS.search(v) for v in names.values())
    return (np.array(V, dtype=np.float64).reshape(-1, 3), np.array(F, dtype=np.int64).reshape(-1, 3),
            np.array(G, dtype=bool))


def geometry_hash(V, F, G):
    h = hashlib.sha1()
    for a in (np.round(V, 5), F, G):
        h.update(np.ascontiguousarray(a).tobytes())
    return h.hexdigest()


def weld(V, F, tol=1e-5):
    q = np.round(V / tol).astype(np.int64)
    _, first, inv = np.unique(q, axis=0, return_index=True, return_inverse=True)
    return V[first], inv.reshape(-1)[F]


def clean(V, F):
    """Drop degenerate and repeated triangles (same corners, same winding), and unused vertices."""
    F = F[(F[:, 0] != F[:, 1]) & (F[:, 1] != F[:, 2]) & (F[:, 0] != F[:, 2])]
    if len(F):
        area = np.linalg.norm(np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]]), axis=1)
        F = F[area > 1e-12]
    if len(F):
        r = np.argmin(F, axis=1)                                 # rotate so the smallest index comes first
        canon = np.stack([F[np.arange(len(F)), r], F[np.arange(len(F)), (r + 1) % 3],
                          F[np.arange(len(F)), (r + 2) % 3]], 1)
        _, keep = np.unique(canon, axis=0, return_index=True)
        F = F[np.sort(keep)]
    used, F = np.unique(F, return_inverse=True)
    return V[used], F.reshape(-1, 3)


def split_twins(F):
    """(one-sided faces, one face of each back-to-back pair). The kit's game-built meshes are all such pairs: thin
    parts made visible from both sides for Tacview's back-face culling."""
    s = np.sort(F, axis=1)
    r = np.argmin(F, axis=1)
    rising = F[np.arange(len(F)), (r + 1) % 3] == s[:, 1]
    _, inv = np.unique(s, axis=0, return_inverse=True)
    inv = inv.reshape(-1)
    up = np.bincount(inv, weights=rising)
    tot = np.bincount(inv)
    twin = ((up > 0) & (up < tot))[inv]
    return F[~twin], F[twin & rising]


def decimate(V, F, target, agg, border):
    import fast_simplification                                    # only needed for meshes over budget
    target = max(int(round(target)), 4)
    if len(F) <= target:
        return V, F
    c = (V.min(0) + V.max(0)) / 2
    s = float(np.ptp(V, axis=0).max()) or 1.0
    P, F2 = fast_simplification.simplify((V - c) / s, F.astype(np.int32), target_count=target,
                                         agg=agg, preserve_border=border)
    return clean(P * s + c, F2.astype(np.int64))


def components(V, F):
    """Connected component label of each face (faces sharing a vertex are connected)."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    e = np.concatenate([F[:, [0, 1]], F[:, [1, 2]]])
    g = coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(len(V), len(V)))
    return connected_components(g, directed=False)[1][F[:, 0]]


FLOOR_TRIS = 12        # a protected piece never gets fewer triangles than this, or its own count if smaller
FLOOR_SHARE = 0.4      # at most this much of the target goes to those floors (the largest pieces are protected first)


def reduce_part(V, F, target, agg, border):
    """Decimate one part to about `target` triangles, piece by piece. Decimating the whole mesh at once let the
    quadric collapse remove small pieces entirely (the MLRS truck's outrigger legs), so the largest pieces (by
    their longest side) are protected: each keeps at least FLOOR_TRIS triangles, together at most FLOOR_SHARE of
    the target. The rest of the budget is shared out by triangle count. A protected piece whose reduced version
    no longer fills its own bounding box (10 % per axis) is kept whole."""
    lab = components(V, F)
    cnt = np.bincount(lab)
    ids = np.flatnonzero(cnt)
    ext = np.zeros(len(cnt))
    for c in ids:
        P = V[np.unique(F[lab == c])]
        ext[c] = float(np.ptp(P, axis=0).max())
    floor = np.zeros(len(cnt), np.int64)
    room = FLOOR_SHARE * target
    for c in ids[np.argsort(-ext[ids], kind="stable")]:
        f = min(cnt[c], FLOOR_TRIS)
        if f > room:
            break
        floor[c], room = f, room - f
    pieces = {c: clean(V, F[lab == c]) for c in ids}

    def reduce_one(c, share):
        Vc, Fc = pieces[c]
        if share >= 0.9 * cnt[c]:
            return Vc, Fc
        Vr, Fr = reduce_twins(Vc, Fc, max(share, floor[c]), agg, border)
        if floor[c]:
            tol = np.maximum(0.1 * np.ptp(Vc, axis=0), 0.01)
            if not len(Fr) or np.any(np.abs(Vr.min(0) - Vc.min(0)) > tol) \
                    or np.any(np.abs(Vr.max(0) - Vc.max(0)) > tol):
                return Vc, Fc
        return Vr, Fr

    # Small pieces often cannot go as low as their share (open edges, back-to-back pairs). Those keep what they
    # reached and the others share the rest of the budget again, a few rounds at most.
    done = {}
    for rnd in range(4):
        act = np.array([c for c in ids if c not in done])
        if not len(act):
            break
        left = target - sum(len(f) for _, f in done.values())
        over = cnt[act] - floor[act]
        share = floor[act] + max(left - floor[act].sum(), 0) * over / max(over.sum(), 1)
        res = {c: reduce_one(c, sh) for c, sh in zip(act, share)}
        stuck = [c for c, sh in zip(act, share) if len(res[c][1]) > 1.15 * sh + 2]
        if sum(len(f) for _, f in res.values()) <= 1.05 * left or not stuck or len(stuck) == len(act) or rnd == 3:
            done.update(res)
            break
        done.update({c: res[c] for c in stuck})
    Vs, Fs, n = [], [], 0
    for c in ids:
        Vc, Fc = done[c]
        if not len(Fc):
            continue
        Vs.append(Vc)
        Fs.append(Fc + n)
        n += len(Vc)
    return np.concatenate(Vs), np.concatenate(Fs)


def reduce_twins(V, F, target, agg, border):
    """Decimate one piece to about `target` triangles, keeping back-to-back pairs as pairs."""
    single, twin = split_twins(F)
    cost = len(single) + 2 * len(twin)
    out, Vs = [], []
    for faces, double in ((single, False), (twin, True)):
        if not len(faces):
            continue
        Vp, Fp = clean(V, faces)
        Vp, Fp = decimate(Vp, Fp, target * len(faces) / cost, agg, border)
        if double:
            Fp = np.concatenate([Fp, Fp[:, ::-1]])
        out.append(Fp + sum(len(v) for v in Vs))
        Vs.append(Vp)
    return np.concatenate(Vs), np.concatenate(out)


def silhouettes(V, F, lo, hi, res=128):
    from PIL import Image, ImageDraw
    masks = []
    for a, b in ((0, 1), (0, 2), (2, 1)):                         # front, top, side
        s = (res - 1) / (max(hi[a] - lo[a], hi[b] - lo[b]) or 1.0)
        X, Y = (V[:, a] - lo[a]) * s, (V[:, b] - lo[b]) * s
        im = Image.new("1", (res, res), 0)
        draw = ImageDraw.Draw(im)
        for f in F:
            draw.polygon([(X[f[0]], Y[f[0]]), (X[f[1]], Y[f[1]]), (X[f[2]], Y[f[2]])], fill=1)
        masks.append(np.array(im, dtype=bool))
    return masks


def merged(parts):
    Vs, Fs, n = [], [], 0
    for V, F, _ in parts:
        Vs.append(V)
        Fs.append(F + n)
        n += len(V)
    return np.concatenate(Vs), np.concatenate(Fs)


def surface_points(V, F, h):
    """Points on every triangle (corners included), about one per h x h of area (slivers get their corners and
    a few more). Returns the points, the face each lies on and the area each stands for."""
    area = np.linalg.norm(np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]]), axis=1) / 2
    k = np.clip(np.ceil(np.sqrt(2 * area) / h).astype(np.int64), 1, 64)
    pts, face, wt = [], [], []
    for n in np.unique(k):
        i, j = np.meshgrid(np.arange(n + 1), np.arange(n + 1), indexing="ij")
        keep = i + j <= n
        w = np.stack([i[keep], j[keep], n - i[keep] - j[keep]], 1) / n          # barycentric grid
        sel = np.flatnonzero(k == n)
        pts.append(np.einsum("pk,tkc->tpc", w, V[F[sel]]).reshape(-1, 3))
        face.append(np.repeat(sel, len(w)))
        wt.append(np.repeat(area[sel] / len(w), len(w)))
    return np.concatenate(pts), np.concatenate(face), np.concatenate(wt)


class Reference:
    """What the decimation guard compares against, worked out once per model: the source's box, outlines and
    points spread over its surface, grouped by connected piece."""

    def __init__(self, parts):
        V, F = merged(parts)
        self.lo, self.hi = V.min(0), V.max(0)
        self.size = float((self.hi - self.lo).max()) or 1.0
        self.masks = silhouettes(V, F, self.lo, self.hi)
        self.h = 0.004 * self.size
        self.P, face, self.wt = surface_points(V, F, self.h)
        self.lab = components(V, F)[face]
        self.pieces = []
        for c in np.unique(self.lab):
            m = self.lab == c
            ext = float(np.ptp(self.P[m], axis=0).max())
            if ext >= 0.02 * self.size:
                self.pieces.append((m, max(0.15 * ext, 0.006 * self.size)))


def lost_pieces(ref, V1, F1):
    """What the reduced mesh no longer covers, measured on points spread over the source surface:
      - a visible piece (longest side at least 2 % of the model's) of which more than a quarter of the surface is
        further from the reduced mesh than 15 % of the piece's size (at least 0.6 % of the model's): lost outrigger
        legs, aerials, rails, wheels squashed into shards;
      - more than 2 % of the whole surface further than 1 % of the model's size: a lost roof or panel.
    Returns the number of such losses."""
    from scipy.spatial import cKDTree
    tree = cKDTree(surface_points(V1, F1, ref.h)[0])
    d, _ = tree.query(ref.P, distance_upper_bound=ref.size, workers=-1)
    lost = int(ref.wt[d > 0.01 * ref.size].sum() > 0.02 * ref.wt.sum())
    for m, tol in ref.pieces:
        lost += int(ref.wt[m][d[m] > tol].sum() > 0.25 * ref.wt[m].sum())
    return lost


def shape_kept(ref, after):
    """Decimation guard: same bounding box on every axis (1.5 % of that axis, at least 0.5 % of the longest side
    and 2 cm), same outline from front, top and side (IoU), and nothing lost (lost_pieces). The earlier
    3 %-of-the-longest-side box let the MLRS truck lose its outriggers and 0.24 m of width."""
    V1, F1 = merged(after)
    ext = ref.hi - ref.lo
    tol = np.maximum(np.maximum(0.015 * ext, 0.005 * ref.size), 0.02)
    dev = np.maximum(np.abs(V1.min(0) - ref.lo), np.abs(V1.max(0) - ref.hi))
    ious = [(m0 & m1).sum() / max((m0 | m1).sum(), 1)
            for m0, m1 in zip(ref.masks, silhouettes(V1, F1, ref.lo, ref.hi))]
    ok = bool(np.all(dev <= tol)) and min(ious) >= 0.92
    lost = lost_pieces(ref, V1, F1) if ok else 0
    return ok and not lost, float(dev.max()), min(ious), lost


# (aggressiveness, keep open edges, piece by piece). The whole mesh at once first: it spends the budget best.
# Piece by piece (reduce_part) when that loses a piece.
VARIANTS = ((7, True, False), (7, False, False), (7, True, True), (3, True, False), (3, False, False),
            (3, True, True))


def prepare(V, F, G):
    """Weld and clean, opaque and glass parts separately: [(V, F, glass)]."""
    parts = []
    for g in (False, True):
        sel = F[G == g]
        if len(sel):
            parts.append((*clean(*weld(V, sel)), g))
    return parts


MAX_GROWTH = 3         # the target may grow to this many times the budget while looking for a version that keeps
                       # everything; past it the version with the fewest losses at that size is used


def build_mesh(parts, limits):
    """Over budget, decimate (opaque and glass parts separately). The first variant that keeps the shape wins; if
    none does, the target grows by a third and it tries again, up to MAX_GROWTH times the budget. Returns parts,
    tris in, note."""
    tris_in = sum(len(p[1]) for p in parts)
    above, want = limits
    if tris_in <= above:
        return parts, tris_in, ""
    cap = MAX_GROWTH * want
    lost_seen, fallback = 0, None
    ref = Reference(parts)
    while want < tris_in * 0.9:
        for agg, border, pieces in VARIANTS:
            reduce = reduce_part if pieces else reduce_twins
            out = []
            for Vp, Fp, g in parts:
                share = want * len(Fp) / tris_in
                out.append((*reduce(Vp, Fp, share, agg, border), g) if len(Fp) > 40 else (Vp, Fp, g))
            n = sum(len(p[1]) for p in out)
            ok, box, iou, lost = shape_kept(ref, out)
            lost_seen = max(lost_seen, lost)
            how = (f"agg {agg}{' borders kept' if border else ''}{' by piece' if pieces else ''}, "
                   f"box {box:.2f} m, IoU {iou:.3f}")
            if ok and n <= want * 1.25:
                return out, tris_in, how + (f", rejected {lost_seen} lost pieces" if lost_seen else "")
            if lost and n <= want * 1.25 and (fallback is None or (lost, n) < fallback[:2]):
                fallback = (lost, n, out, how)                   # outline and box fine, some pieces lost
        if want * 4 / 3 > cap and fallback is not None:
            return fallback[2], tris_in, f"{fallback[3]}, {fallback[0]} pieces lost at {MAX_GROWTH}x the budget"
        want = int(want * 4 / 3)
    return parts, tris_in, "kept whole: no smaller version kept its shape"


def view_dirs():
    d = np.array([(x, y, z) for x in (-1, 0, 1) for y in (-1, 0, 1) for z in (-1, 0, 1) if (x, y, z) != (0, 0, 0)],
                 dtype=np.float64)
    return d / np.linalg.norm(d, axis=1)[:, None]


def seen_sides(V, F, res=192, chunk=4_000_000):
    """Look at the mesh from 26 directions round it (orthographic z-buffer, no culling) and count, per face, the
    pixels where it is the nearest surface with its front turned to the viewer and with its back turned. A small
    depth bias lets a front face win a tie (as a polygon offset would), so back-to-back pairs and closed shells
    report no back pixels."""
    front, back = np.zeros(len(F), np.int64), np.zeros(len(F), np.int64)
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    size = float(np.ptp(V, axis=0).max()) or 1.0
    for d in view_dirs():
        up = np.array([0.0, 1.0, 0.0]) if abs(d[1]) < 0.9 else np.array([1.0, 0.0, 0.0])
        u = np.cross(up, d)
        u /= np.linalg.norm(u)
        w = np.cross(d, u)
        P = np.stack([V @ u, V @ w, V @ d], 1)                   # x, y on screen; depth grows away from the viewer
        lo = P[:, :2].min(0)
        s = (res - 1) / (float((P[:, :2].max(0) - lo).max()) or 1.0)
        X, Y, Z = (P[:, 0] - lo[0]) * s, (P[:, 1] - lo[1]) * s, P[:, 2]
        is_back = (fn @ d) > 0                                    # normal points away from the viewer
        T = np.stack([np.stack([X[F[:, k]], Y[F[:, k]], Z[F[:, k]]], 1) for k in range(3)], 1)   # (m, 3, 3)
        x0 = np.ceil(T[:, :, 0].min(1)).astype(np.int64)
        x1 = np.floor(T[:, :, 0].max(1)).astype(np.int64)
        y0 = np.ceil(T[:, :, 1].min(1)).astype(np.int64)
        y1 = np.floor(T[:, :, 1].max(1)).astype(np.int64)
        nx, ny = np.maximum(x1 - x0 + 1, 0), np.maximum(y1 - y0 + 1, 0)
        npx = nx * ny
        best_d = np.full(res * res, np.inf)
        best_f = np.full(res * res, -1, np.int64)
        bias = 0.002 * size
        tri_ids = np.flatnonzero(npx)
        group = np.cumsum(npx[tri_ids]) // chunk
        for gv in np.unique(group):
            ids = tri_ids[group == gv]
            k = npx[ids]
            t = np.repeat(ids, k)
            off = np.arange(len(t)) - np.repeat(np.cumsum(k) - k, k)
            px = x0[t] + off % nx[t]
            py = y0[t] + off // nx[t]
            A, B, C = T[t, 0], T[t, 1], T[t, 2]
            den = (B[:, 1] - C[:, 1]) * (A[:, 0] - C[:, 0]) + (C[:, 0] - B[:, 0]) * (A[:, 1] - C[:, 1])
            ok = np.abs(den) > 1e-12
            den = np.where(ok, den, 1.0)
            l1 = ((B[:, 1] - C[:, 1]) * (px - C[:, 0]) + (C[:, 0] - B[:, 0]) * (py - C[:, 1])) / den
            l2 = ((C[:, 1] - A[:, 1]) * (px - C[:, 0]) + (A[:, 0] - C[:, 0]) * (py - C[:, 1])) / den
            l3 = 1 - l1 - l2
            eps = -1e-6
            inside = ok & (l1 >= eps) & (l2 >= eps) & (l3 >= eps)
            depth = l1 * A[:, 2] + l2 * B[:, 2] + l3 * C[:, 2] + np.where(is_back[t], bias, 0.0)
            pix = (py * res + px)[inside]
            t, depth = t[inside], depth[inside]
            order = np.lexsort((depth, pix))
            pix, t, depth = pix[order], t[order], depth[order]
            first = np.r_[True, pix[1:] != pix[:-1]]
            pix, t, depth = pix[first], t[first], depth[first]
            better = depth < best_d[pix]
            best_d[pix[better]] = depth[better]
            best_f[pix[better]] = t[better]
        hit = best_f[best_f >= 0]
        b = is_back[hit]
        front += np.bincount(hit[~b], minlength=len(F))
        back += np.bincount(hit[b], minlength=len(F))
    return front, back


def fix_inside_out(parts, min_px=2):
    """Faces the viewer would see from behind (its material culls back faces, so they show as holes): a face only
    ever seen from behind is turned round; one seen from both sides (an open sheet) gets a reversed copy. Returns
    the new parts, faces turned, faces doubled."""
    V, F = merged(parts)
    front, back = seen_sides(V, F)
    flip = (back >= min_px) & (front == 0)
    double = (back >= min_px) & (front > 0)
    out, i0, n_flip, n_double = [], 0, int(flip.sum()), int(double.sum())
    for Vp, Fp, g in parts:
        fl, db = flip[i0:i0 + len(Fp)], double[i0:i0 + len(Fp)]
        i0 += len(Fp)
        Fp = Fp.copy()
        Fp[fl] = Fp[fl][:, ::-1]
        out.append((Vp, np.concatenate([Fp, Fp[db][:, ::-1]]), g))
    return out, n_flip, n_double


def split_normals(V, F, angle=SMOOTH_DEG):
    """Corner normals: area weighted mean of the faces round the vertex within `angle` of this corner's face."""
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    fu = fn / np.maximum(np.linalg.norm(fn, axis=1), 1e-30)[:, None]
    cv = F.reshape(-1)
    cf = np.repeat(np.arange(len(F)), 3)
    order = np.argsort(cv, kind="stable")
    ks = cv[order]
    starts = np.flatnonzero(np.r_[True, ks[1:] != ks[:-1]])
    counts = np.diff(np.r_[starts, len(ks)])
    gid = np.repeat(np.arange(len(starts)), counts)
    rep = counts[gid]
    I = np.repeat(np.arange(len(ks)), rep)
    J = starts[gid[I]] + (np.arange(len(I)) - np.repeat(np.cumsum(rep) - rep, rep))
    fi, fj = cf[order[I]], cf[order[J]]
    ok = (fu[fi] * fu[fj]).sum(1) >= np.cos(np.radians(angle)) - 1e-9
    acc = np.zeros((len(ks), 3))
    np.add.at(acc, I[ok], fn[fj[ok]])
    out = np.empty_like(acc)
    out[order] = acc
    ln = np.linalg.norm(out, axis=1)
    bad = ln < 1e-20
    out[bad] = fu[cf[bad]]
    return out / np.linalg.norm(out, axis=1)[:, None]


def vertex_buffers(parts):
    """[(V, F, glass)] -> position, normal, colour (float32 arrays) and triangle indices."""
    pos, nrm, col, idx, base = [], [], [], [], 0
    for V, F, glass in parts:
        if not len(F):
            continue
        cn = split_normals(V, F)
        key = np.concatenate([F.reshape(-1, 1), np.round(cn * 2048).astype(np.int64)], 1)
        _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
        pos.append(V[F.reshape(-1)[first]])
        n = cn[first]
        nrm.append(n / np.linalg.norm(n, axis=1)[:, None])
        col.append(np.full((len(first), 3), GREY_GLASS if glass else GREY))
        idx.append(inv.reshape(-1) + base)
        base += len(first)
    return (np.concatenate(pos).astype("<f4"), np.concatenate(nrm).astype("<f4"),
            np.concatenate(col).astype("<f4"), np.concatenate(idx))


def write_glb(path, name, pos, nrm, col, idx, copyright_text):
    big = len(pos) > 65535
    idx = idx.astype("<u4" if big else "<u2")
    blobs = [(pos.tobytes(), 34962), (nrm.tobytes(), 34962), (col.tobytes(), 34962), (idx.tobytes(), 34963)]
    binbuf, views = bytearray(), []
    for blob, target in blobs:
        binbuf += b"\0" * (-len(binbuf) % 4)
        views.append({"buffer": 0, "byteOffset": len(binbuf), "byteLength": len(blob), "target": target})
        binbuf += blob
    binbuf += b"\0" * (-len(binbuf) % 4)
    n = len(pos)
    gltf = {
        "asset": {"version": "2.0", "generator": "Nuclear Option Viewer tools/build_tacview_models.py",
                  "copyright": copyright_text},
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0, "name": name}],
        "meshes": [{"name": name, "primitives": [
            {"attributes": {"POSITION": 0, "NORMAL": 1, "COLOR_0": 2}, "indices": 3, "mode": 4}]}],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": n, "type": "VEC3",
             "min": [float(v) for v in pos.min(0)], "max": [float(v) for v in pos.max(0)]},
            {"bufferView": 1, "componentType": 5126, "count": n, "type": "VEC3"},
            {"bufferView": 2, "componentType": 5126, "count": n, "type": "VEC3"},
            {"bufferView": 3, "componentType": 5125 if big else 5123, "count": len(idx), "type": "SCALAR"},
        ],
        "bufferViews": views,
        "buffers": [{"byteLength": len(binbuf)}],
    }
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    with open(path, "wb") as fh:
        fh.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(binbuf)))
        fh.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
        fh.write(struct.pack("<II", len(binbuf), 0x004E4942) + bytes(binbuf))


# ---------------------------------------------------------------- replays

def replay_names(path):
    """{(Name, Type): number of objects} for every named object in a .zip.acmi / .txt.acmi file."""
    def lines():
        if zipfile.is_zipfile(path):
            with zipfile.ZipFile(path) as z, z.open(z.namelist()[0]) as fh:
                yield from io.TextIOWrapper(fh, encoding="utf-8-sig", errors="replace")
        else:
            with open(path, encoding="utf-8-sig", errors="replace") as fh:
                yield from fh

    def fields(line):
        if "\\" not in line:
            return line.split(",")
        out, cur, esc = [], [], False
        for ch in line:
            if esc:
                cur.append(ch)
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == ",":
                out.append("".join(cur))
                cur = []
            else:
                cur.append(ch)
        out.append("".join(cur))
        return out

    objs, seen = {}, collections.Counter()
    for raw in lines():
        line = raw.rstrip("\r\n")
        if line.startswith("-"):
            objs.pop(line[1:].strip(), None)
            continue
        if ("Name=" not in line and "Type=" not in line) or line.startswith(("#", "0,")):
            continue
        parts = fields(line)
        o = objs.setdefault(parts[0], {})
        before = (o.get("Name"), o.get("Type"))
        for p in parts[1:]:
            k, _, v = p.partition("=")
            if k in ("Name", "Type") and v.strip():
                o[k] = v
        now = (o.get("Name"), o.get("Type"))
        if now != before and now[0] and now[1]:
            seen[(now[0].strip(), now[1].strip())] += 1
    return seen


# ---------------------------------------------------------------- main

def ci(s):
    """Sort key: case-insensitive, then exact (names that differ only in case keep a fixed order)."""
    return s.lower(), s


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("pack", help="checkout of KopterBuzz/NOBlackBoxTacviewAssets")
    ap.add_argument("kit", help="Tomo's Tacview kit (its 'installed' folder or the kit root)")
    ap.add_argument("--stock", help="Tacview's own 'Database/Default Properties' folder (optional)")
    ap.add_argument("--replays", nargs="*", default=[], help=".zip.acmi / .txt.acmi files to check names against")
    ap.add_argument("--out", default=DEFAULT_OUT)
    a = ap.parse_args()

    kit = a.kit
    if not os.path.isdir(os.path.join(kit, "Meshes")) and os.path.isdir(os.path.join(kit, "installed", "Meshes")):
        kit = os.path.join(kit, "installed")
    pack_meshes = {f: os.path.join(a.pack, "meshes", f) for f in os.listdir(os.path.join(a.pack, "meshes"))
                   if f.lower().endswith(".obj")}
    kit_meshes = {f: os.path.join(kit, "Meshes", f) for f in os.listdir(os.path.join(kit, "Meshes"))
                  if f.lower().endswith(".obj")}

    files = [(os.path.join(a.pack, "database", "NuclearOption.xml"), "pack")]
    kit_db = os.path.join(kit, "Database", "Default Properties")
    files += [(os.path.join(kit_db, f), "kit") for f in sorted(os.listdir(kit_db)) if f.lower().endswith(".xml")]
    if a.stock:   # Tacview's generic classes; its own NuclearOption.xml is an older copy of the pack's file
        files += [(os.path.join(a.stock, f), "tacview") for f in sorted(os.listdir(a.stock))
                  if f.lower().endswith(".xml") and not f.lower().startswith("nuclearoption")]
    entries = load_databases(files)
    matcher = Matcher(entries)

    # ---- which mesh file a Shape means (kit first; the kit's game-built NOX_ version of a unit before all)
    def mesh_file(shape):
        if not shape:
            return None
        stem = shape[:-4] if shape.lower().endswith(".obj") else shape
        if not stem.startswith("NOX_") and f"NOX_{stem}.obj" in kit_meshes:
            return kit_meshes[f"NOX_{stem}.obj"]
        for pool in (kit_meshes, pack_meshes):
            if shape in pool:
                return pool[shape]
        for pool in (kit_meshes, pack_meshes):
            for f, p in pool.items():
                if f.lower() == shape.lower():
                    print(f"  warning: Shape {shape} only matches {f} without case (Tacview is case sensitive)")
                    return p
        return None

    # ---- every name to resolve: database aliases (with their own entry's Type) and recorded names
    queries = {}                                                  # name -> {type: weight}
    for e in entries.values():
        if e.src in ("pack", "kit") and e.has_criteria:
            for n in e.names:
                if n and n != "*":
                    queries.setdefault(n, collections.Counter())[type_filter(entries, e)] += 0
    recorded = collections.Counter()
    rec_types = collections.defaultdict(collections.Counter)
    for path in a.replays:
        for (name, typ), cnt in replay_names(path).items():
            recorded[name] += cnt
            rec_types[name][typ] += cnt
    for name, types in rec_types.items():
        q = queries.setdefault(name, collections.Counter())
        q.clear()                                                 # the recorded Type wins over a guess
        q.update(types)

    resolved = {}                                                 # name -> (entry, alias, mesh path or None)
    for name, types in sorted(queries.items()):
        picks = collections.Counter()
        for typ, w in types.items():
            b = matcher.best(name, typ)
            if b:
                picks[(b[1].id, b[2])] += w + 1
        if not picks:
            resolved[name] = (None, None, None)
            continue
        if len(picks) > 1:
            print(f"  note: '{name}' matches differently by Type: {dict(picks)}; using the most common")
        (eid, alias), _ = picks.most_common(1)[0]
        e = entries[eid]
        shape = inherited(entries, e, "Shape")
        path = mesh_file(shape) if e.src in ("pack", "kit") else None
        if path and SCENERY.match(os.path.basename(path)):
            path = None
        resolved[name] = (e, alias, path)

    # ---- load the meshes in use, merge identical geometry
    pack_hash = {}
    for f, p in pack_meshes.items():
        V, F, G = read_obj(p)
        pack_hash.setdefault(geometry_hash(V, F, G), []).append(f[:-4])
    models = {}                                                   # geometry hash -> info
    by_path = {}
    for name, (e, alias, path) in resolved.items():
        if not path:
            continue
        if path not in by_path:
            V, F, G = read_obj(path)
            h = geometry_hash(V, F, G)
            fname = os.path.basename(path)
            community = path in pack_meshes.values() or fname in pack_meshes or h in pack_hash
            stems = pack_hash.get(h) or [fname[:-4]]
            m = models.setdefault(h, {"geom": (V, F, G), "files": set(), "keys": set(), "community": False,
                                      "names": set(), "kinds": collections.Counter(), "entries": set()})
            m["files"].add(path)
            m["keys"].update(stems)
            m["community"] |= community
            by_path[path] = h
        m = models[by_path[path]]
        m["names"].add(name)
        m["entries"].add(e.id)
        kind = class_kind(entries, e)
        if kind is None:
            unit = os.path.basename(path)[:-4].removeprefix("NOX_")
            kind = "ground" if unit in GROUND_UNITS else "building"
        m["kinds"][kind] += 1

    os.makedirs(a.out, exist_ok=True)
    index = {"models": {}, "aliases": {}, "credits": CREDITS}
    fixed_faces = {}
    print(f"{'key':28} {'kind':8} {'source':9} {'tris in':>7} {'out':>6}  {'len x wid x hgt (m)':22} names")
    for h, m in sorted(models.items(), key=lambda kv: ci(min(kv[1]["keys"], key=ci))):
        key = min(m["keys"], key=ci)
        kind = m["kinds"].most_common(1)[0][0]
        if len(m["kinds"]) > 1:
            print(f"  note: {key} has names of several kinds {dict(m['kinds'])}; using {kind}")
        source = "community" if m["community"] else "kit"
        parts = prepare(*m["geom"])
        parts, tris_in, note = build_mesh(parts, budget(kind, source, sum(len(p[1]) for p in parts)))
        parts, n_flip, n_double = fix_inside_out(parts)
        if n_flip or n_double:
            note = f"{note}; " if note else ""
            note += f"inside-out faces: {n_flip} turned, {n_double} doubled"
            fixed_faces[key] = (n_flip, n_double)
        pos, nrm, col, idx = vertex_buffers(parts)
        cr = (f"{CREDITS['community']['title']} by {CREDITS['community']['author']}, used with permission"
              if source == "community" else CREDITS["kit"]["text"])
        write_glb(os.path.join(a.out, f"{key}.glb"), key, pos, nrm, col, idx, cr)
        ext = pos.max(0) - pos.min(0)
        size = {"len": round(float(ext[2]), 2), "wid": round(float(ext[0]), 2), "hgt": round(float(ext[1]), 2)}
        tris = len(idx) // 3
        index["models"][key] = {"file": f"{key}.glb", "kind": kind, "tris": tris, "size": size, "source": source,
                                "names": sorted(m["names"], key=ci)}
        for n in m["names"]:
            index["aliases"][n] = key
        print(f"{key:28} {kind:8} {source:9} {tris_in:7d} {tris:6d}  "
              f"{size['len']:6.1f} x {size['wid']:5.1f} x {size['hgt']:5.1f}   {len(m['names'])}  {note}")
    index["aliases"] = dict(sorted(index["aliases"].items(), key=lambda kv: ci(kv[0])))
    with open(os.path.join(a.out, "index.json"), "w", encoding="utf-8") as fh:
        json.dump(index, fh, indent=1, ensure_ascii=False)
        fh.write("\n")
    keep = {f"{k}.glb" for k in index["models"]} | {"index.json"}
    for f in os.listdir(a.out):
        if f.endswith(".glb") and f not in keep:
            os.remove(os.path.join(a.out, f))                     # models dropped since the last run

    # ---- report
    used = set(by_path)
    left = sorted(f for f, p in pack_meshes.items() if p not in used and not any(
        f[:-4] in m["keys"] for m in models.values()) and f"NOX_{f}" not in kit_meshes)
    replaced = sorted(f for f in pack_meshes if f"NOX_{f}" in kit_meshes and kit_meshes[f"NOX_{f}"] in used
                      and not any(f[:-4] in m["keys"] for m in models.values()))
    scenery = sorted(f for f in kit_meshes if SCENERY.match(f))
    no_mesh = sorted({inherited(entries, e, "Shape") or "(none)" for e, _, p in resolved.values()
                      if e is not None and e.src in ("pack", "kit") and not p
                      and not SCENERY.match(inherited(entries, e, "Shape") or "")})
    print(f"\nmodels {len(index['models'])}, aliases {len(index['aliases'])}, "
          f"{sum(os.path.getsize(os.path.join(a.out, f)) for f in keep) / 1e6:.1f} MB in {a.out}")
    print(f"not converted: {len(scenery)} kit scenery meshes (cities, towns, bridges); pack meshes no entry uses: "
          f"{', '.join(left) or 'none'}; pack meshes replaced by the kit's game-built version: "
          f"{', '.join(replaced) or 'none'}; shapes without a mesh: {', '.join(no_mesh) or 'none'}")
    if recorded:
        miss = [(n, resolved[n][0]) for n in recorded if not (resolved[n][2])]
        print(f"\nrecorded names: {len(recorded)}, mapped {len(recorded) - len(miss)}, unmapped {len(miss)}")
        for n, e in sorted(miss, key=lambda t: ci(t[0])):
            what = f"Tacview uses its generic {e.id}" if e is not None else "no entry matches"
            print(f"  unmapped: {n!r:40} ({recorded[n]} objects, {', '.join(rec_types[n])}): {what}")


if __name__ == "__main__":
    main()
