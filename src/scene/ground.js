// The map: terrain shaped from the game's height grid, the map picture on top, and the open sea past the edges.
//
// First version: one mesh per map with ~160 m between vertices and the overview picture. Detail tiles near the
// camera come next. Scene axes: x = east (game x), y = up, z = south (game z negated).

import * as THREE from "three";
import { gunzipSync } from "../../vendor/fflate/fflate.js";

const MAPS = {
  "NuclearOption.Terrain1": "heartland",
  "NuclearOption.Terrain_naval": "ignus",
};
const MESH_STEP = 160; // metres between vertices of the far terrain mesh
const SEA = 3_000_000;  // open sea plane size (metres): its edge stays inside the fog even zoomed right out

export function mapKeyFor(mapId) { return MAPS[mapId] || null; }

export class Ground {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.key = null;
    this.meta = null;
    this.heights = null;
    this.mesh = null;      // { x0, z0 (scene, north-west corner), cols, rows, step, h: Float32Array } of the drawn mesh
    this.loading = 0;
  }

  // Loads the map for a replay. Returns true when it is (or already was) loaded, false when the map is unknown, the
  // download failed (the units then play over plain sea), or a newer load or cancel() took over. A superseded load
  // never touches the screen, so a replay can't end up on the wrong map, or on two maps at once.
  async load(mapId, base = "assets/maps/") {
    const token = ++this.loading;
    const key = mapKeyFor(mapId);
    if (!key) { this.reset(); this.drawSea(); return false; }
    if (key === this.key) return true;
    const dir = base + key + "/";
    let meta, raw, tex = null;
    try {
      const mr = await fetch(dir + "meta.json");
      if (!mr.ok) throw new Error("map description missing (HTTP " + mr.status + ")");
      meta = await mr.json();
      const [hs, ts] = await Promise.allSettled([
        fetch(dir + meta.height.file).then((r) => { if (!r.ok) throw new Error("map heights missing (HTTP " + r.status + ")"); return r.arrayBuffer(); }),
        new THREE.TextureLoader().loadAsync(dir + meta.overview.file),
      ]);
      if (ts.status === "fulfilled") tex = ts.value;
      if (hs.status === "rejected") throw hs.reason;
      if (ts.status === "rejected") throw new Error("map picture missing");
      if (token !== this.loading) { tex.dispose(); return false; }   // a newer load or a cancel took over
      raw = gunzipSync(new Uint8Array(hs.value));
    } catch (err) {
      console.warn("map load failed:", err);
      tex?.dispose();
      if (token === this.loading) { this.reset(); this.drawSea(); }   // no stale terrain under the new replay
      return false;
    }
    this.reset();
    this.heights = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
    this.meta = meta;
    this.key = key;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    this.build(tex);
    return true;
  }

  // Abandons any map load still in flight, without changing what is on screen.
  cancel() { this.loading++; }

  // Removes the current map, and abandons any load in flight.
  clear() { this.cancel(); this.reset(); }

  // Plain sea at 0 m, for replays whose map isn't known or didn't load.
  drawSea() {
    const sea = new THREE.Mesh(
      new THREE.PlaneGeometry(SEA, SEA).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: new THREE.Color().setRGB(0.16, 0.31, 0.4, THREE.SRGBColorSpace) }),
    );
    sea.position.y = -2;
    sea.name = "sea";
    this.group.add(sea);
  }

  // removes and frees everything drawn for the current map
  reset() {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      child.geometry?.dispose();
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const m of mats) { if (!m) continue; m.map?.dispose(); m.dispose(); }
    }
    this.key = null; this.meta = null; this.heights = null; this.mesh = null;
  }

  // height in metres of the game's ground at game x / scene z (bilinear over the 20 m grid; sea floor negative)
  heightAt(x, sz) {
    const m = this.meta;
    if (!m) return 0;
    const H = m.height;
    const gz = -sz;
    const fx = (x - m.x0) / H.step, fy = (m.z1 - gz) / H.step;
    if (!(fx >= 0 && fy >= 0 && fx <= H.cols - 1 && fy <= H.rows - 1)) return -200;
    const i = Math.min(H.cols - 2, Math.floor(fx)), j = Math.min(H.rows - 2, Math.floor(fy));
    const u = fx - i, v = fy - j, h = this.heights, c = H.cols;
    const a = h[j * c + i], b = h[j * c + i + 1], d = h[(j + 1) * c + i], e = h[(j + 1) * c + i + 1];
    return (a * (1 - u) + b * u) * (1 - v) + (d * (1 - u) + e * u) * v;
  }

  // height of the terrain AS DRAWN at x / scene z: the same vertices and the same triangle split as the mesh, so a
  // unit lifted to this height sits on the visible ground instead of inside a hill. Sea and off map = 0.
  surfaceAt(x, sz) {
    const g = this.mesh;
    if (!g) return 0;
    const fx = (x - g.x0) / g.step, fy = (sz - g.z0) / g.step;   // fy grows southward, like the mesh rows
    if (!(fx >= 0 && fy >= 0 && fx <= g.cols && fy <= g.rows)) return 0;
    const i = Math.min(g.cols - 1, Math.floor(fx)), j = Math.min(g.rows - 1, Math.floor(fy));
    const u = fx - i, v = fy - j, w = g.cols + 1, h = g.h;
    const a = h[j * w + i], d = h[j * w + i + 1], b = h[(j + 1) * w + i], c = h[(j + 1) * w + i + 1];
    // PlaneGeometry splits each quad along b (south-west) to d (north-east): triangles (a, b, d) and (b, c, d)
    if (u + v <= 1) return a + (d - a) * u + (b - a) * v;
    return c + (b - c) * (1 - u) + (d - c) * (1 - v);
  }

  build(tex) {
    const m = this.meta;
    const W = m.x1 - m.x0, D = m.z1 - m.z0;
    const cols = Math.round(W / MESH_STEP), rows = Math.round(D / MESH_STEP);
    const geo = new THREE.PlaneGeometry(W, D, cols, rows);
    geo.rotateX(-Math.PI / 2);                          // plane in x/z, its top edge to -z (north)
    geo.translate((m.x0 + m.x1) / 2, 0, -(m.z0 + m.z1) / 2);
    // The map picture already paints the water (shallows included), so the sea is the terrain held at 0 m.
    const pos = geo.attributes.position;
    const hs = new Float32Array(pos.count);
    for (let k = 0; k < pos.count; k++) {
      const y = Math.max(0, this.heightAt(pos.getX(k), pos.getZ(k)));
      pos.setY(k, y);
      hs[k] = y;
    }
    geo.computeVertexNormals();
    this.mesh = { x0: m.x0, z0: -m.z1, cols, rows, step: W / cols, h: hs };
    const land = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex }));
    land.name = "land";
    this.group.add(land);

    // open sea past the map edges, in the picture's own deep-water colour, wide enough that its edge is always in the fog
    const sea = new THREE.Mesh(
      new THREE.PlaneGeometry(SEA, SEA).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: edgeColour(tex.image) }),
    );
    sea.position.set((m.x0 + m.x1) / 2, -2, -(m.z0 + m.z1) / 2);
    sea.name = "sea";
    this.group.add(sea);
  }
}

// average colour of a picture's outermost pixels (the open sea on both maps)
function edgeColour(img) {
  const c = document.createElement("canvas");
  c.width = 64; c.height = 64;
  const g = c.getContext("2d");
  g.drawImage(img, 0, 0, 64, 64);
  const d = g.getImageData(0, 0, 64, 64).data;
  let r = 0, gr = 0, b = 0, n = 0;
  for (let i = 0; i < 64; i++) for (const [x, y] of [[i, 0], [i, 63], [0, i], [63, i]]) {
    const k = (y * 64 + x) * 4; r += d[k]; gr += d[k + 1]; b += d[k + 2]; n++;
  }
  return new THREE.Color().setRGB(r / n / 255, gr / n / 255, b / n / 255, THREE.SRGBColorSpace);
}
