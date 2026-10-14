// Unit models: the Tacview models (community pack + Tomo's kit) first, models built from the game files second.
//
// Each source has an index.json: { models: { key: { file, kind, size: {len, wid, hgt}, ... } },
// aliases: { "<recorded Name>": key } }. Only the models a replay actually uses are downloaded. A unit with no
// model keeps its simple stand-in shape. Models are metres, nose to -z, up +y; their greyscale vertex colours are
// multiplied by the unit's side colour when drawn.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const SOURCES = ["assets/models-tacview/", "assets/models/"];   // first match wins

export class ModelLibrary {
  constructor() {
    this.ready = this.loadIndexes();
    this.cache = new Map();     // "source|key" -> Promise<{ geometry, len } | null>
    this.loader = new GLTFLoader();
  }

  async loadIndexes() {
    this.sources = [];
    for (const base of SOURCES) {
      try {
        const r = await fetch(base + "index.json");
        if (!r.ok) continue;
        const idx = await r.json();
        if (idx && idx.models) this.sources.push({ base, idx });
      } catch (e) { /* that source isn't there: fine */ }
    }
  }

  // the source + key a recorded Name uses, or null
  find(name) {
    const n = String(name || "").trim();
    if (!n) return null;
    for (const s of this.sources || []) {
      const key = s.idx.aliases?.[n] ?? (s.idx.models[n] ? n : null);
      if (key && s.idx.models[key]) return { source: s, key };
    }
    return null;
  }

  // loads the models for a set of recorded Names; resolves to Map(name -> { id, geometry, len })
  async forNames(names) {
    await this.ready;
    const out = new Map();
    await Promise.all([...new Set(names)].map(async (name) => {
      const hit = this.find(name);
      if (!hit) return;
      const id = hit.source.base + "|" + hit.key;
      if (!this.cache.has(id)) this.cache.set(id, this.load(hit.source, hit.key));
      const m = await this.cache.get(id);
      if (m) out.set(name, { id, ...m });
    }));
    return out;
  }

  async load(source, key) {
    const meta = source.idx.models[key];
    try {
      const gltf = await this.loader.loadAsync(source.base + meta.file);
      gltf.scene.updateMatrixWorld(true);
      const parts = [];
      gltf.scene.traverse((o) => {
        if (!o.isMesh || !o.geometry) return;
        const g = o.geometry.clone();
        g.applyMatrix4(o.matrixWorld);
        if (!g.attributes.normal) g.computeVertexNormals();
        if (!g.attributes.color) {
          const n = g.attributes.position.count;
          g.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(n * 3).fill(0.8), 3));
        } else if (g.attributes.color.itemSize === 4) {
          g.setAttribute("color", dropAlpha(g.attributes.color));
        }
        for (const name of Object.keys(g.attributes)) if (!["position", "normal", "color"].includes(name)) g.deleteAttribute(name);
        parts.push(g);
      });
      if (!parts.length) return null;
      const geometry = parts.length === 1 ? parts[0] : mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)), false);
      geometry.computeBoundingBox();
      const bb = geometry.boundingBox;
      const len = Math.max(bb.max.z - bb.min.z, bb.max.x - bb.min.x, 0.5);
      return { geometry, len, kind: meta.kind || "" };
    } catch (e) {
      console.warn("model failed to load:", key, e);
      return null;
    }
  }
}

function dropAlpha(attr) {
  const n = attr.count, out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { out[i * 3] = attr.getX(i); out[i * 3 + 1] = attr.getY(i); out[i * 3 + 2] = attr.getZ(i); }
  return new THREE.Float32BufferAttribute(out, 3);
}
