// The map: terrain shaped from the game's height grid, a picture on top, and the open sea past the edges.
//
// Three looks (setStyle), picked in the settings:
//   terrain   the map picture on the real ground (lit)
//   tactical  the game's own green map screen on black, on the same ground, with its 10 km / 1 km grid
//   empty     no map at all: a dark plane at sea level with the grid, the way ACMI Viewer shows a replay
// One mesh per map with ~160 m between vertices. Scene axes: x = east (game x), y = up, z = south (game z negated).

import * as THREE from "three";
import { gunzipSync } from "../../vendor/fflate/fflate.js";

const MAPS = {
  "NuclearOption.Terrain1": "heartland",
  "NuclearOption.Terrain_naval": "ignus",
};
export const MAP_STYLES = ["terrain", "tactical", "empty"];
const MESH_STEP = 160; // metres between vertices of the far terrain mesh
const SEA = 3_000_000;  // open sea plane size (metres): its edge stays inside the fog even zoomed right out
// The game tints its map picture pure green, drawn over black. 1.35 times brighter to read (as the start screen
// backdrop is): a gain on the picture's sRGB value is about its 2.2nd power on the linear value the shader works in.
const GREEN = new THREE.Color().setRGB(0, Math.pow(1.35, 2.2), 0);
const GRID_MAJOR = new THREE.Color("#007400");   // its 10 km grid
const GRID_MINOR = new THREE.Color("#004100");   // and 1 km grid
const EMPTY_GROUND = new THREE.Color("#0b1612");

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
    this.landGeo = null;   // the ground shape, kept across style changes
    this.seaGeo = null;    // the open sea frame around it
    this.texture = null;   // the current style's picture: { style, tex, edge }
    this.style = "terrain";
    this.loading = 0;      // bumped by every map load and cancel
    this.picLoading = 0;   // bumped by every style picture load, so only the newest lands
  }

  // Loads the map for a replay, drawn in `style`. Returns true when it is (or already was) loaded, false when the map
  // is unknown, the download failed (the units then play over plain sea), or a newer load or cancel() took over. A
  // superseded load never touches the screen, so a replay can't end up on the wrong map, or on two maps at once.
  async load(mapId, style = this.style, base = "assets/maps/") {
    const token = ++this.loading;
    this.picLoading++;   // a style picture still coming for the old map must not land on this one
    const key = mapKeyFor(mapId);
    this.style = style;
    if (!key) { this.reset(); this.drawPlain(); return false; }
    if (key === this.key) return this.setStyle(style);
    const dir = base + key + "/";
    let meta, raw, pic = null;
    try {
      const mr = await fetch(dir + "meta.json");
      if (!mr.ok) throw new Error("map description missing (HTTP " + mr.status + ")");
      meta = await mr.json();
      const [hs, ps] = await Promise.allSettled([
        fetch(dir + meta.height.file).then((r) => { if (!r.ok) throw new Error("map heights missing (HTTP " + r.status + ")"); return r.arrayBuffer(); }),
        loadPicture(dir, meta, style),
      ]);
      if (ps.status === "fulfilled") pic = ps.value;
      if (hs.status === "rejected") throw hs.reason;
      if (ps.status === "rejected") throw ps.reason;
      if (token !== this.loading) { pic?.tex.dispose(); return false; }   // a newer load or a cancel took over
      raw = gunzipSync(new Uint8Array(hs.value));
    } catch (err) {
      console.warn("map load failed:", err);
      pic?.tex.dispose();
      if (token === this.loading) { this.reset(); this.drawPlain(); }   // no stale terrain under the new replay
      return false;
    }
    this.reset();
    this.heights = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
    this.meta = meta;
    this.key = key;
    this.dir = dir;
    this.texture = pic;
    this.buildShape();
    this.draw();
    return true;
  }

  // Changes how the map looks, keeping the replay and the camera. Fetches the style's picture when it isn't loaded
  // yet. Returns true when the new look is on screen, false if its picture couldn't be loaded (the old look stays).
  async setStyle(style) {
    if (!MAP_STYLES.includes(style)) return false;
    const prev = this.style;
    this.style = style;
    if (!this.meta) { this.clearDrawn(); this.drawPlain(); return true; }
    if (style !== "empty" && (!this.texture || this.texture.style !== style)) {
      const token = ++this.picLoading, key = this.key;
      let pic;
      try { pic = await loadPicture(this.dir, this.meta, style); } catch (err) {
        console.warn("map picture failed:", err);
        if (token === this.picLoading && this.style === style) this.style = prev;   // the old look is still on screen
        return false;
      }
      if (token !== this.picLoading || key !== this.key || style !== this.style) { pic.tex.dispose(); return false; }
      this.texture?.tex.dispose();   // only one picture in memory at a time: they are 64 to 128 MB each on the GPU
      this.texture = pic;
    }
    this.draw();
    return true;
  }

  // Abandons any map load still in flight, without changing what is on screen.
  cancel() { this.loading++; }

  // Removes the current map, and abandons any load in flight.
  clear() { this.cancel(); this.reset(); }

  // the map's own look, in the current style, from the kept shape and picture
  draw() {
    this.clearDrawn();
    if (this.style === "empty") { this.drawPlain(); return; }
    const pic = this.texture;
    const tactical = this.style === "tactical";
    const landMat = tactical ? gridMaterial({ map: pic.tex, color: GREEN }) : new THREE.MeshLambertMaterial({ map: pic.tex });
    const land = new THREE.Mesh(this.landGeo, landMat);
    land.name = "land";
    this.group.add(land);
    // open sea past the map edges, in the picture's own deep water colour, wide enough that its edge is always in the
    // fog. It stops at the map edge. A sea plane under the whole map sat 2 m below the map's own water and the two
    // fought over the depth buffer, so the sea flickered in patches (worst on Ignus, which is 93% sea). No grid out
    // here: the game's map has none past its edge, and this frame's cells are far too big to draw one steadily.
    const seaMat = tactical ? new THREE.MeshBasicMaterial({ color: pic.edge.clone().multiply(GREEN) }) : new THREE.MeshLambertMaterial({ color: pic.edge });
    const sea = new THREE.Mesh(this.seaGeo, seaMat);
    sea.name = "sea";
    this.group.add(sea);
  }

  // A flat plane at sea level, for replays whose map isn't known or didn't load, and for the "empty" style. The empty
  // style's plane carries the grid, so it is the fine one that follows the camera (see followPlane and update).
  drawPlain() {
    const empty = this.style === "empty";
    const mat = empty
      ? gridMaterial({ color: EMPTY_GROUND })
      : new THREE.MeshLambertMaterial({ color: new THREE.Color().setRGB(0.16, 0.31, 0.4, THREE.SRGBColorSpace) });
    const plain = new THREE.Mesh(empty ? followPlane() : new THREE.PlaneGeometry(SEA, SEA).rotateX(-Math.PI / 2), mat);
    plain.position.y = empty ? 0 : -2;
    plain.name = empty ? "empty" : "sea";
    plain.userData.ownGeometry = true;
    plain.userData.follow = empty;
    plain.frustumCulled = false;   // it moves under the camera; never let a stale bounding box hide it
    this.group.add(plain);
  }

  // Once a frame: the empty style's plane re-centres under the camera, in whole 10 km steps (so it only moves now and
  // then, and the grid, worked out from world position, doesn't move at all).
  update(camera) {
    for (const child of this.group.children) {
      if (!child.userData.follow) continue;
      const x = Math.round(camera.position.x / 10000) * 10000, z = Math.round(camera.position.z / 10000) * 10000;
      if (child.position.x !== x || child.position.z !== z) child.position.set(x, child.position.y, z);
    }
  }

  // takes the current look off the screen; the shape and the picture stay for the next one
  clearDrawn() {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      if (child.userData.ownGeometry) child.geometry.dispose();
      child.material?.dispose();
    }
  }

  // removes and frees everything kept for the current map
  reset() {
    this.clearDrawn();
    this.landGeo?.dispose();
    this.seaGeo?.dispose();
    this.texture?.tex.dispose();
    this.landGeo = null; this.seaGeo = null; this.texture = null;
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
  // unit lifted to this height sits on the visible ground instead of inside a hill. Sea, off map and the empty
  // style (where everything sits over a flat sea level plane) = 0.
  surfaceAt(x, sz) {
    const g = this.mesh;
    if (!g || this.style === "empty") return 0;
    const fx = (x - g.x0) / g.step, fy = (sz - g.z0) / g.step;   // fy grows southward, like the mesh rows
    if (!(fx >= 0 && fy >= 0 && fx <= g.cols && fy <= g.rows)) return 0;
    const i = Math.min(g.cols - 1, Math.floor(fx)), j = Math.min(g.rows - 1, Math.floor(fy));
    const u = fx - i, v = fy - j, w = g.cols + 1, h = g.h;
    const a = h[j * w + i], d = h[j * w + i + 1], b = h[(j + 1) * w + i], c = h[(j + 1) * w + i + 1];
    // PlaneGeometry splits each quad along b (south-west) to d (north-east): triangles (a, b, d) and (b, c, d)
    if (u + v <= 1) return a + (d - a) * u + (b - a) * v;
    return c + (b - c) * (1 - u) + (d - c) * (1 - v);
  }

  // the ground shape (once per map): the far terrain mesh and the sea frame around it
  buildShape() {
    const m = this.meta;
    const W = m.x1 - m.x0, D = m.z1 - m.z0;
    const cols = Math.round(W / MESH_STEP), rows = Math.round(D / MESH_STEP);
    const geo = new THREE.PlaneGeometry(W, D, cols, rows);
    geo.rotateX(-Math.PI / 2);                          // plane in x/z, its top edge to -z (north)
    geo.translate((m.x0 + m.x1) / 2, 0, -(m.z0 + m.z1) / 2);
    // The map picture already paints the water (shallows included), so the sea is the terrain held at 0 m. Past the
    // edges, seaFrame continues it at the same 0 m.
    const pos = geo.attributes.position;
    const hs = new Float32Array(pos.count);
    for (let k = 0; k < pos.count; k++) {
      const y = Math.max(0, this.heightAt(pos.getX(k), pos.getZ(k)));
      pos.setY(k, y);
      hs[k] = y;
    }
    geo.computeVertexNormals();
    this.mesh = { x0: m.x0, z0: -m.z1, cols, rows, step: W / cols, h: hs };
    this.landGeo = geo;
    this.seaGeo = seaFrame(m, cols, rows);
  }
}

// the picture for a style: the map picture (terrain) or the game's greyscale map screen picture (tactical)
async function loadPicture(dir, meta, style) {
  if (style === "empty") return null;
  const file = style === "tactical" ? (meta.tactical?.file || "tactical.png") : meta.overview.file;
  let tex;
  try { tex = await new THREE.TextureLoader().loadAsync(dir + file); } catch { throw new Error("map picture missing"); }
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return { style, tex, edge: edgeColour(tex.image) };
}

// An unlit material with the game's map grid drawn on it: thin 1 km lines and brighter 10 km lines at whole multiples
// of the game's own coordinates (the same squares as the in-game map). The lines stay about a pixel wide at any zoom;
// the 1 km lines fade out before they get so close together that they would turn into a green haze.
function gridMaterial(params) {
  const mat = new THREE.MeshBasicMaterial(params);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.gridMajor = { value: GRID_MAJOR };
    shader.uniforms.gridMinor = { value: GRID_MINOR };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vGridXZ;")
      .replace("#include <project_vertex>", "#include <project_vertex>\n\tvGridXZ = (modelMatrix * vec4(transformed, 1.0)).xz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vGridXZ;\nuniform vec3 gridMajor;\nuniform vec3 gridMinor;\n" + GRID_GLSL)
      .replace("#include <opaque_fragment>", "outgoingLight = mapGrid(outgoingLight, vGridXZ);\n\t#include <opaque_fragment>");
  };
  mat.customProgramCacheKey = () => "nov-map-grid";
  return mat;
}

const GRID_GLSL = /* glsl */ `
// 1 where a grid line of this spacing passes through the pixel, fading to 0 a pixel or so away
float gridLine(vec2 p, float spacing, vec2 fw, float width) {
  vec2 d = abs(fract(p / spacing - 0.5) - 0.5) * spacing / max(fw, vec2(1e-4));
  return 1.0 - smoothstep(width * 0.5, width * 0.5 + 1.0, min(d.x, d.y));
}
vec3 mapGrid(vec3 col, vec2 p) {
  vec2 fw = fwidth(p);                                  // metres per pixel, along each axis
  float mpp = max(fw.x, fw.y);
  float minor = gridLine(p, 1000.0, fw, 1.0) * (1.0 - smoothstep(30.0, 90.0, mpp));   // only once zoomed in
  float major = gridLine(p, 10000.0, fw, 1.5);
  return col + gridMinor * minor + gridMajor * major;   // added on top, the way the game draws its grid
}`;

// The empty style's ground: a plane out to SEA / 2 each way whose cells are 500 m across in the middle and 10% bigger
// with each step out (about 120 x 120 cells). It is kept under the camera. Drawn as two huge triangles it made the grid
// jitter: the world position the lines come from is interpolated across each triangle, and across 3000 km the
// graphics card's number precision runs out by metres. Small cells near the camera keep it steady.
function followPlane() {
  const half = [0];
  for (let x = 0, s = 500; x < SEA / 2; s *= 1.1) { x = Math.min(SEA / 2, x + s); half.push(x); }
  const c = [...half.slice(1).reverse().map((v) => -v), ...half];
  const n = c.length;
  const pos = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) pos.set([c[i], 0, c[j]], (j * n + i) * 3);
  const idx = [];
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + n, d = a + 1, e = b + 1;   // a north-west, b south-west, d north-east, e south-east
      idx.push(a, b, d, b, e, d);                             // both facing up
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  return geo;
}

// The open sea around a map: flat at 0 m (the height the map holds its own water at), from the map edge out to SEA / 2
// from the map's middle, with a hole where the map is. Its inner edge uses the land mesh's own edge vertices, worked out
// the way PlaneGeometry + translate work them out, so the two meet without cracks or T-junctions.
function seaFrame(m, cols, rows) {
  const W = m.x1 - m.x0, D = m.z1 - m.z0;
  const cx = (m.x0 + m.x1) / 2, cz = -(m.z0 + m.z1) / 2;           // map middle in scene x / z
  const f = Math.fround;
  const xs = [cx - SEA / 2], zs = [cz - SEA / 2];
  for (let i = 0; i <= cols; i++) xs.push(f(f(i * (W / cols) - W / 2) + cx));
  for (let j = 0; j <= rows; j++) zs.push(f(f(j * (D / rows) - D / 2) + cz));
  xs.push(cx + SEA / 2);
  zs.push(cz + SEA / 2);
  const nx = xs.length - 1, nz = zs.length - 1;
  const pos = [], nor = [], idx = [];
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      if (i > 0 && i < nx - 1 && j > 0 && j < nz - 1) continue;      // inside the map: the land mesh draws it
      const k = pos.length / 3;
      pos.push(xs[i], 0, zs[j], xs[i], 0, zs[j + 1], xs[i + 1], 0, zs[j + 1], xs[i + 1], 0, zs[j]);
      nor.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
      idx.push(k, k + 1, k + 3, k + 1, k + 2, k + 3);                 // both triangles face up
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  geo.setIndex(idx);
  return geo;
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
