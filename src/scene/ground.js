// The map: terrain shaped from the game's height grid, the map picture on top, and the sea at 0 m.
//
// First version: one mesh per map at a reduced grid, with the overview picture. Detail tiles near the camera come
// next. Scene axes: x = east (game x), y = up, z = south (game z negated).

import * as THREE from "three";
import { gunzipSync } from "../../vendor/fflate/fflate.js";

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

const MAPS = {
  "NuclearOption.Terrain1": "heartland",
  "NuclearOption.Terrain_naval": "ignus",
};

export function mapKeyFor(mapId) { return MAPS[mapId] || null; }

export class Ground {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.meta = null;
    this.heights = null;
  }

  async load(mapId, base = "assets/maps/") {
    const key = mapKeyFor(mapId);
    if (!key) return false;
    const dir = base + key + "/";
    const meta = await (await fetch(dir + "meta.json")).json();
    const [buf, tex] = await Promise.all([
      fetch(dir + meta.height.file).then((r) => r.arrayBuffer()),
      new THREE.TextureLoader().loadAsync(dir + meta.overview.file),
    ]);
    const raw = gunzipSync(new Uint8Array(buf));
    this.heights = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
    this.meta = meta;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    this.build(tex);
    return true;
  }

  // height in metres at game x / scene z (bilinear), sea floor values included
  heightAt(x, sz) {
    const m = this.meta, H = m.height;
    if (!m) return 0;
    const gz = -sz;
    const fx = (x - m.x0) / H.step, fy = (m.z1 - gz) / H.step;
    if (fx < 0 || fy < 0 || fx > H.cols - 1 || fy > H.rows - 1) return -200;
    const i = Math.min(H.cols - 2, Math.floor(fx)), j = Math.min(H.rows - 2, Math.floor(fy));
    const u = fx - i, v = fy - j, h = this.heights, c = H.cols;
    const a = h[j * c + i], b = h[j * c + i + 1], d = h[(j + 1) * c + i], e = h[(j + 1) * c + i + 1];
    return (a * (1 - u) + b * u) * (1 - v) + (d * (1 - u) + e * u) * v;
  }

  build(tex) {
    const m = this.meta;
    const W = m.x1 - m.x0, D = m.z1 - m.z0;
    // ~160 m between vertices for the far view
    const sx = Math.round(W / 160), sz = Math.round(D / 160);
    const geo = new THREE.PlaneGeometry(W, D, sx, sz);
    geo.rotateX(-Math.PI / 2);                          // plane in x/z, its top edge to -z (north)
    geo.translate((m.x0 + m.x1) / 2, 0, -(m.z0 + m.z1) / 2);
    // The map picture already paints the water (shallows included), so the sea is the terrain held at 0 m.
    const pos = geo.attributes.position;
    for (let k = 0; k < pos.count; k++) pos.setY(k, Math.max(0, this.heightAt(pos.getX(k), pos.getZ(k))));
    geo.computeVertexNormals();
    const land = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex }));
    land.name = "land";
    this.group.add(land);

    // open sea past the map edges, in the picture's own deep-water colour
    const sea = new THREE.Mesh(
      new THREE.PlaneGeometry(W * 8, D * 8).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: edgeColour(tex.image) }),
    );
    sea.position.set((m.x0 + m.x1) / 2, -2, -(m.z0 + m.z1) / 2);
    sea.name = "sea";
    this.group.add(sea);
  }
}
