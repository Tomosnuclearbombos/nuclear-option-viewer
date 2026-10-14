// Map scenery: the towns, cities and bridges (the game's own, from Tomo's Tacview kit), drawn flat grey like Tacview.
//
// Each map's scenery is stored as 4 km tiles (assets/maps/<map>/scenery/index.json). All of them load once the map
// is up, the ones nearest the camera first, and all stay shown, the same as Tacview. Full detail for now: speed gets
// looked at later.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const AT_ONCE = 4;       // downloads in flight

export class Scenery {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = "scenery";
    scene.add(this.group);
    this.material = new THREE.MeshLambertMaterial({ color: 0x9b9b9b, flatShading: true });
    this.loader = new GLTFLoader();
    this.tiles = [];
    this.base = "";
    this.token = 0;          // bumped by every setMap, so a late answer for an old map is dropped
    this.inFlight = 0;
    this.last = 0;
    this.show = true;
  }

  // the map key ("heartland", "ignus") or null for none; a map without scenery is fine
  async setMap(key) {
    const token = ++this.token;
    this.clear();
    if (!key) return;
    const base = `assets/maps/${key}/scenery/`;
    try {
      const r = await fetch(base + "index.json");
      if (!r.ok || token !== this.token) return;
      const idx = await r.json();
      if (token !== this.token || !idx || !Array.isArray(idx.tiles)) return;
      this.base = base;
      this.tiles = idx.tiles.map((t) => ({
        file: t.file, b: t.bounds, mesh: null, state: 0,   // 0 not loaded, 1 loading, 2 loaded, 3 failed
      }));
    } catch (e) {
      console.warn("scenery:", e);
    }
  }

  clear() {
    for (const t of this.tiles) if (t.mesh) this.free(t);
    this.tiles = [];
    this.inFlight = 0;
  }

  // grey like Tacview on the terrain; a dim green on the game's green map, where grey would glow white
  setLook(style) { this.material.color.setHex(style === "tactical" ? 0x2a7a2a : 0x9b9b9b); }

  setShown(on) {
    this.show = on;
    for (const t of this.tiles) if (t.mesh) t.mesh.visible = on;
  }

  free(t) {
    this.group.remove(t.mesh);
    t.mesh.geometry.dispose();
    t.mesh = null;
    t.state = 0;
  }

  // a few times a second while tiles are still to come: start the next downloads, nearest the camera first. Nothing
  // is fetched while the scenery is switched off.
  update(camera, now) {
    if (!this.show || !this.tiles.length || this.inFlight >= AT_ONCE || now - this.last < 200) return;
    this.last = now;
    const c = camera.position;
    const want = [];
    for (const t of this.tiles) {
      if (t.state !== 0) continue;
      const b = t.b;
      const dx = Math.max(b[0] - c.x, 0, c.x - b[3]), dz = Math.max(b[2] - c.z, 0, c.z - b[5]);
      want.push([dx * dx + dz * dz, t]);
    }
    want.sort((a, b) => a[0] - b[0]);
    for (const [, t] of want) {
      if (this.inFlight >= AT_ONCE) break;
      this.load(t, this.token);
    }
  }

  async load(t, token) {
    t.state = 1;
    this.inFlight++;
    try {
      const gltf = await this.loader.loadAsync(this.base + t.file);
      if (token !== this.token) { dispose(gltf.scene); return; }   // the map changed meanwhile
      let src = null;
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        if (!src) src = o;
        if (o.material && o.material.dispose) o.material.dispose();   // the loader's default; all scenery shares ours
      });
      if (!src) { t.state = 3; return; }
      const mesh = new THREE.Mesh(src.geometry, this.material);
      mesh.name = "scenery:" + t.file;
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(src.matrixWorld);   // tiles are stored relative to their centre, which keeps them precise
      mesh.visible = this.show;
      t.mesh = mesh;
      t.state = 2;
      this.group.add(mesh);
    } catch (e) {
      console.warn("scenery tile failed:", t.file, e);
      t.state = 3;
    } finally {
      if (token === this.token) this.inFlight--;
    }
  }
}

function dispose(root) {
  root.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); if (o.material && o.material.dispose) o.material.dispose(); } });
}
