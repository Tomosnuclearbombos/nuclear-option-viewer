// Streaming reader for Tacview ACMI text, written for NOBlackBox recordings of Nuclear Option.
//
// Feed it raw bytes in any chunk sizes (push), then call finish(). It never builds the file as one string: it scans
// bytes, reads numbers straight from them, and only decodes text for names and other strings. The result is a set of
// flat typed arrays, ready to hand to the main thread without copying.
//
// Positions use U/V, the recorder's flat map metres, which are exact game world metres. Scene axes: x = U (east),
// y = altitude (metres above sea level), z = -V (north is -z).

const TEXT = new TextDecoder("utf-8");

// Object kinds. The renderer groups by these.
export const KIND = {
  UNKNOWN: 0, PLANE: 1, HELI: 2, MISSILE: 3, BOMB: 4, SHELL: 5, ROUND: 6, FLARE: 7, EXPLOSION: 8,
  SHIP: 9, GROUND: 10, BUILDING: 11,
};
export const KIND_NAMES = Object.keys(KIND);

// Type is a "+" list of tags, e.g. Ground+Medium+Vehicle+AntiAircraft. Compare whole tags: a substring test would
// read the "Air" in AntiAircraft as an aircraft.
export function kindOfType(type) {
  if (!type) return KIND.UNKNOWN;
  const tags = type.split("+");
  const has = (t) => tags.indexOf(t) >= 0;
  if (has("Air")) return has("Rotorcraft") ? KIND.HELI : KIND.PLANE;
  if (has("Missile") || has("Rocket")) return KIND.MISSILE;
  if (has("Bomb")) return KIND.BOMB;
  if (has("Explosion")) return KIND.EXPLOSION;
  if (has("Flare") || has("Chaff") || has("Decoy")) return KIND.FLARE;
  if (has("Shell") || has("Bullet")) return has("Misc") ? KIND.ROUND : KIND.SHELL;
  if (has("Sea") || has("Watercraft")) return KIND.SHIP;
  if (has("Building") || has("Static")) return KIND.BUILDING;
  if (has("Ground")) return KIND.GROUND;
  return KIND.UNKNOWN;
}

// Numeric properties kept as time series, one channel each. Index = channel number.
export const CHANNELS = [
  "TAS", "Mach", "AOA", "AGL", "Throttle", "PitchControlInput", "RollControlInput", "YawControlInput",
  "LandingGear", "Visible", "RadarMode",
];
// LockedTarget, LockedTarget1..9 hold object ids; kept as one channel per slot.
const LOCK_SLOTS = 10;

// ---- growable typed arrays -------------------------------------------------------------------------------
class Grow {
  constructor(Type, cap = 1 << 16) { this.Type = Type; this.a = new Type(cap); this.n = 0; }
  push(v) {
    if (this.n === this.a.length) { const b = new this.Type(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = v;
  }
  done() { return this.a.slice(0, this.n); }
}

// ---- fast number reading straight from bytes ---------------------------------------------------------------
// Handles sign, digits, one decimal point and an optional exponent. Returns NaN for an empty field.
function readNumber(b, s, e) {
  if (s >= e) return NaN;
  let i = s, neg = false;
  if (b[i] === 45) { neg = true; i++; } else if (b[i] === 43) i++;
  let v = 0, frac = 0, scale = 1, seen = false;
  for (; i < e; i++) {
    const c = b[i];
    if (c >= 48 && c <= 57) { seen = true; if (frac) { scale /= 10; v += (c - 48) * scale; } else v = v * 10 + (c - 48); }
    else if (c === 46 && !frac) frac = 1;
    else if (c === 101 || c === 69) { // exponent
      let j = i + 1, en = false, ev = 0;
      if (b[j] === 45) { en = true; j++; } else if (b[j] === 43) j++;
      for (; j < e; j++) { const d = b[j]; if (d < 48 || d > 57) break; ev = ev * 10 + (d - 48); }
      v *= Math.pow(10, en ? -ev : ev);
      break;
    } else break;
  }
  if (!seen) return NaN;
  return neg ? -v : v;
}

// Object ids are hex. Some reach 0x400000xxx, past 32 bits, so they are kept as plain numbers (exact to 2^53).
function readHex(b, s, e) {
  let v = 0;
  for (let i = s; i < e; i++) {
    const c = b[i];
    const d = c <= 57 ? c - 48 : (c | 32) - 87;
    if (d < 0 || d > 15) return -1;
    v = v * 16 + d;
  }
  return e > s ? v : -1;
}

function decode(b, s, e) {
  // plain ASCII fast path, else UTF-8
  let ascii = true;
  for (let i = s; i < e; i++) if (b[i] > 127) { ascii = false; break; }
  if (ascii) {
    let out = "";
    for (let i = s; i < e; i += 4096) out += String.fromCharCode.apply(null, b.subarray(i, Math.min(e, i + 4096)));
    return out;
  }
  return TEXT.decode(b.subarray(s, e));
}

// A value may contain escaped characters (\, for a comma, \\ for a backslash). Only strings can.
function unescape(str) { return str.indexOf("\\") < 0 ? str : str.replace(/\\(.)/g, "$1"); }

const DEG = 100; // angles stored as int16 hundredths of a degree
function angle16(deg) {
  let a = deg % 360;
  if (a >= 180) a -= 360; else if (a < -180) a += 360;
  return Math.round(a * DEG);
}

export class AcmiParser {
  constructor() {
    this.header = { fileType: "", fileVersion: "", referenceTime: "", recordingTime: "", mapId: "", title: "",
      dataSource: "", dataRecorder: "", author: "" };
    this.time = 0;
    this.tMin = Infinity; this.tMax = -Infinity;
    this.lineCount = 0;
    this.bytesRead = 0;
    this.pending = null;      // partial line carried between chunks
    this.continued = null;    // a line ending in a backslash continues on the next line

    // object records (a recycled id starts a new record)
    this.live = new Map();    // id -> record index
    this.justRemoved = new Map(); // id -> record index, for ids removed in the current frame
    this.recId = []; this.recName = []; this.recType = []; this.recCallSign = []; this.recPilot = [];
    this.recCoalition = []; this.recColor = []; this.recKind = []; this.recT0 = []; this.recT1 = [];
    this.recRange = []; this.recRadius = [];
    // last full transform per record, for fields left empty in an update ("unchanged")
    this.last = [];

    // samples, in file order; sorted by record at the end
    this.sRec = new Grow(Uint32Array); this.sT = new Grow(Float32Array);
    this.sX = new Grow(Float32Array); this.sY = new Grow(Float32Array); this.sZ = new Grow(Float32Array);
    this.sR = new Grow(Int16Array); this.sP = new Grow(Int16Array); this.sH = new Grow(Int16Array);
    this.sHasAtt = 0; // count of samples carrying attitude

    // numeric channels: rec, t, value
    this.ch = CHANNELS.map(() => ({ rec: new Grow(Uint32Array, 1 << 12), t: new Grow(Float32Array, 1 << 12), v: new Grow(Float32Array, 1 << 12) }));
    this.locks = { rec: new Grow(Uint32Array, 1 << 12), t: new Grow(Float32Array, 1 << 12), slot: new Grow(Uint8Array, 1 << 12), target: new Grow(Float64Array, 1 << 12) };

    this.events = [];        // { t, kind, ids:[...], text }
    this.keyCache = new Map();
  }

  // ---- input ----------------------------------------------------------------------------------------------
  push(chunk) {
    this.bytesRead += chunk.length;
    let b = chunk, start = 0;
    if (this.pending) {
      // find the end of the carried line in the new chunk
      const nl = chunk.indexOf(10);
      if (nl < 0) { this.pending = concat(this.pending, chunk); return; }
      const line = concat(this.pending, chunk.subarray(0, nl));
      this.pending = null;
      this.line(line, 0, line.length);
      start = nl + 1;
    }
    for (;;) {
      const nl = b.indexOf(10, start);
      if (nl < 0) break;
      this.line(b, start, nl);
      start = nl + 1;
    }
    if (start < b.length) this.pending = b.slice(start);
  }

  finish() {
    if (this.pending) { const p = this.pending; this.pending = null; this.line(p, 0, p.length); }
    if (this.continued) { const c = this.continued; this.continued = null; this.handle(c, 0, c.length); }
    return this.build();
  }

  // one physical line [s, e)
  line(b, s, e) {
    if (e > s && b[e - 1] === 13) e--;             // CRLF
    if (s === 0 && this.lineCount === 0 && e - s >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) s += 3; // BOM
    this.lineCount++;
    // a trailing backslash joins the next line (with a newline in between)
    if (e > s && b[e - 1] === 92 && !(e - 1 > s && b[e - 2] === 92)) {
      const part = b.slice(s, e - 1);
      this.continued = this.continued ? concat(concat(this.continued, NL), part) : part;
      return;
    }
    if (this.continued) {
      const all = concat(concat(this.continued, NL), b.subarray(s, e));
      this.continued = null;
      this.handle(all, 0, all.length);
      return;
    }
    this.handle(b, s, e);
  }

  handle(b, s, e) {
    if (e <= s) return;
    const c0 = b[s];
    if (c0 === 35) { // '#' frame time
      const t = readNumber(b, s + 1, e);
      if (t === t) {
        if (t !== this.time) this.justRemoved.clear();
        this.time = t; if (t < this.tMin) this.tMin = t; if (t > this.tMax) this.tMax = t;
      }
      return;
    }
    if (c0 === 45) { // '-' removal
      const id = readHex(b, s + 1, e);
      const r = this.live.get(id);
      if (r !== undefined) { this.recT1[r] = this.time; this.live.delete(id); this.justRemoved.set(id, r); }
      return;
    }
    if (c0 === 47 && b[s + 1] === 47) return; // comment
    // header lines: FileType=..., FileVersion=...
    if (c0 === 70 && (startsWith(b, s, e, "FileType=") || startsWith(b, s, e, "FileVersion="))) {
      const eq = b.indexOf(61, s);
      const key = decode(b, s, eq), val = decode(b, eq + 1, e);
      if (key === "FileType") this.header.fileType = val; else this.header.fileVersion = val;
      return;
    }
    // "<id>,<props>"
    const comma = b.indexOf(44, s);
    if (comma < 0 || comma >= e) return;
    const id = readHex(b, s, comma);
    if (id < 0) return;
    if (id === 0) { this.global(b, comma + 1, e); return; }

    let r = this.live.get(id);
    if (r === undefined) {
      // NOBlackBox removes an explosion and then, in the same instant, sends its Radius. An update with no position
      // and no type, arriving in the frame its id was removed, belongs to that removed object. A new object reusing
      // the id would carry a type and a position.
      const gone = this.justRemoved.get(id);
      if (gone !== undefined && !hasKey(b, comma + 1, e, "T=") && !hasKey(b, comma + 1, e, "Type=")) {
        this.props(gone, b, comma + 1, e);
        return;
      }
      r = this.newRecord(id);
    }
    this.props(r, b, comma + 1, e);
  }

  newRecord(id) {
    const r = this.recId.length;
    this.recId.push(id); this.recName.push(""); this.recType.push(""); this.recCallSign.push(""); this.recPilot.push("");
    this.recCoalition.push(""); this.recColor.push(""); this.recKind.push(KIND.UNKNOWN);
    this.recT0.push(this.time); this.recT1.push(NaN); this.recRange.push(0); this.recRadius.push(0);
    this.last.push(null);
    this.live.set(id, r);
    return r;
  }

  key(b, s, e) {
    let h = e - s;
    for (let i = s; i < e; i++) h = (Math.imul(h, 31) + b[i]) | 0;
    let k = this.keyCache.get(h);
    if (k === undefined) { k = decode(b, s, e); this.keyCache.set(h, k); }
    return k;
  }

  // split "k=v,k=v" honouring escaped commas
  props(r, b, s, e) {
    let i = s;
    while (i < e) {
      // find the end of this property (an unescaped comma)
      let j = i;
      while (j < e) {
        const c = b[j];
        if (c === 92) { j += 2; continue; }
        if (c === 44) break;
        j++;
      }
      const eq = b.indexOf(61, i);
      if (eq > i && eq < j) this.prop(r, this.key(b, i, eq), b, eq + 1, j);
      i = j + 1;
    }
  }

  prop(r, k, b, s, e) {
    switch (k) {
      case "T": this.transform(r, b, s, e); return;
      case "Name": this.recName[r] = unescape(decode(b, s, e)).trim(); return;
      case "Type": {
        const t = decode(b, s, e);
        if (t) { this.recType[r] = t; if (this.recKind[r] === KIND.UNKNOWN) this.recKind[r] = kindOfType(t); }
        return;
      }
      case "CallSign": this.recCallSign[r] = unescape(decode(b, s, e)).trim(); return;
      case "Pilot": this.recPilot[r] = unescape(decode(b, s, e)).trim(); return;
      case "Coalition": this.recCoalition[r] = decode(b, s, e); return;
      case "Color": this.recColor[r] = decode(b, s, e); return;
      case "EngagementRange": { const v = readNumber(b, s, e); if (v === v) this.recRange[r] = v; return; }
      case "Radius": { const v = readNumber(b, s, e); if (v === v) this.recRadius[r] = v; return; }
    }
    if (k.charCodeAt(0) === 76 && k.startsWith("LockedTarget")) {
      const slot = k.length === 12 ? 0 : (k.charCodeAt(12) - 48);
      if (slot >= 0 && slot < LOCK_SLOTS) {
        const L = this.locks;
        L.rec.push(r); L.t.push(this.time); L.slot.push(slot); L.target.push(e > s ? readHex(b, s, e) : 0);
      }
      return;
    }
    const c = CHANNELS.indexOf(k);
    if (c >= 0) {
      let v = readNumber(b, s, e);
      if (v !== v && k === "RadarMode") v = 0;
      if (v === v) { const ch = this.ch[c]; ch.rec.push(r); ch.t.push(this.time); ch.v.push(v); }
    }
  }

  // T=lon|lat|alt|roll|pitch|yaw|U|V|heading  or  lon|lat|alt|U|V  or  lon|lat|alt
  // An empty field means "same as last time".
  transform(r, b, s, e) {
    const f = this.fieldBuf || (this.fieldBuf = new Float64Array(9));
    let n = 0, i = s;
    while (n < 9) {
      let j = i;
      while (j < e && b[j] !== 124) j++;
      f[n++] = readNumber(b, i, j);
      if (j >= e) break;
      i = j + 1;
    }
    let last = this.last[r];
    if (!last) { last = this.last[r] = new Float64Array([0, 0, 0, 0, 0, 0, 0, 0, NaN]); last.att = false; }
    // map the fields by count: 3 = lon lat alt, 5 = + U V, 6 = + roll pitch yaw, 9 = all
    let alt = f[2], u = NaN, v = NaN, roll = NaN, pitch = NaN, yaw = NaN;
    if (n === 5 || n === 4) { u = f[3]; v = f[4]; }
    else if (n >= 6) { roll = f[3]; pitch = f[4]; yaw = f[5]; if (n >= 8) { u = f[6]; v = f[7]; } }
    if (alt === alt) last[2] = alt;
    if (u === u) last[6] = u;
    if (v === v) last[7] = v;
    if (roll === roll) { last[3] = roll; last.att = true; }
    if (pitch === pitch) { last[4] = pitch; last.att = true; }
    if (yaw === yaw) { last[5] = yaw; last.att = true; }
    this.sRec.push(r); this.sT.push(this.time);
    this.sX.push(last[6]); this.sY.push(last[2]); this.sZ.push(-last[7]);
    this.sR.push(angle16(last[3])); this.sP.push(angle16(last[4])); this.sH.push(angle16(last[5]));
  }

  global(b, s, e) {
    // 0,Event=Message|id|text   or   0,ReferenceTime=...,RecordingTime=...
    let i = s;
    while (i < e) {
      let j = i;
      while (j < e) { const c = b[j]; if (c === 92) { j += 2; continue; } if (c === 44) break; j++; }
      const eq = b.indexOf(61, i);
      if (eq > i && eq < j) {
        const k = decode(b, i, eq);
        const val = unescape(decode(b, eq + 1, j));
        if (k === "Event") this.event(val);
        else {
          const hk = k.charAt(0).toLowerCase() + k.slice(1);
          if (hk in this.header) this.header[hk] = val;
          else (this.header.extra || (this.header.extra = {}))[k] = val;
        }
      }
      i = j + 1;
    }
  }

  event(val) {
    const parts = val.split("|");
    const kind = parts[0];
    const ids = [];
    let text = "";
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i];
      if (i < parts.length - 1 || /^[0-9A-Fa-f]+$/.test(p)) {
        const id = parseInt(p, 16);
        if (Number.isFinite(id)) { ids.push(id); continue; }
      }
      text = p;
    }
    // resolve ids to the record live right now
    const recs = ids.map((id) => { const r = this.live.get(id); return r === undefined ? -1 : r; });
    this.events.push({ t: this.time, kind, ids, recs, text });
  }

  // ---- output ---------------------------------------------------------------------------------------------
  build() {
    const N = this.recId.length;
    const end = this.tMax === -Infinity ? 0 : this.tMax;
    const t1 = Float32Array.from(this.recT1, (v) => (v === v ? v : end));

    // counting sort of samples by record (stable, so time order is kept)
    const S = this.sRec.n;
    const rec = this.sRec.a;
    const count = new Uint32Array(N + 1);
    for (let i = 0; i < S; i++) count[rec[i] + 1]++;
    for (let r = 0; r < N; r++) count[r + 1] += count[r];
    const start = count.slice(0, N);
    const sampleCount = new Uint32Array(N);
    for (let r = 0; r < N; r++) sampleCount[r] = count[r + 1] - count[r];
    const order = new Uint32Array(S);
    const cursor = count.slice(0, N);
    for (let i = 0; i < S; i++) order[cursor[rec[i]]++] = i;
    const perm = (src, Type) => { const out = new Type(S); for (let i = 0; i < S; i++) out[i] = src[order[i]]; return out; };
    const samples = {
      t: perm(this.sT.a, Float32Array), x: perm(this.sX.a, Float32Array), y: perm(this.sY.a, Float32Array),
      z: perm(this.sZ.a, Float32Array), roll: perm(this.sR.a, Int16Array), pitch: perm(this.sP.a, Int16Array),
      yaw: perm(this.sH.a, Int16Array),
    };
    this.sRec = this.sT = this.sX = this.sY = this.sZ = this.sR = this.sP = this.sH = null; // free

    const channels = this.ch.map((c, i) => groupByRecord(N, c.rec.done(), { t: c.t.done(), v: c.v.done() }, CHANNELS[i]));
    const L = this.locks;
    const locks = groupByRecord(N, L.rec.done(), { t: L.t.done(), slot: L.slot.done(), target: L.target.done() }, "locks");

    return {
      header: this.header,
      tMin: this.tMin === Infinity ? 0 : this.tMin,
      tMax: end,
      lines: this.lineCount,
      bytes: this.bytesRead,
      objects: {
        count: N,
        id: Float64Array.from(this.recId),
        kind: Uint8Array.from(this.recKind),
        t0: Float32Array.from(this.recT0),
        t1,
        range: Float32Array.from(this.recRange),
        radius: Float32Array.from(this.recRadius),
        start, sampleCount,
        name: this.recName, type: this.recType, callSign: this.recCallSign, pilot: this.recPilot,
        coalition: this.recCoalition, color: this.recColor,
      },
      samples,
      channels,
      locks,
      events: this.events,
    };
  }
}

// group a (rec, ...) series by record: returns { start, count, ...arrays } with arrays permuted
function groupByRecord(N, rec, arrays, name) {
  const n = rec.length;
  const count = new Uint32Array(N + 1);
  for (let i = 0; i < n; i++) count[rec[i] + 1]++;
  for (let r = 0; r < N; r++) count[r + 1] += count[r];
  const start = count.slice(0, N);
  const cursor = count.slice(0, N);
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[cursor[rec[i]]++] = i;
  const out = { name, start, count: new Uint32Array(N) };
  for (let r = 0; r < N; r++) out.count[r] = count[r + 1] - count[r];
  for (const k in arrays) {
    const src = arrays[k];
    const dst = new src.constructor(n);
    for (let i = 0; i < n; i++) dst[i] = src[order[i]];
    out[k] = dst;
  }
  return out;
}

const NL = new Uint8Array([10]);
function concat(a, b) { const c = new Uint8Array(a.length + b.length); c.set(a); c.set(b, a.length); return c; }
// whether a property list [s, e) has a property starting with key (e.g. "T=")
function hasKey(b, s, e, key) {
  for (let i = s; i < e; i++) {
    if ((i === s || b[i - 1] === 44) && startsWith(b, i, e, key)) return true;
  }
  return false;
}
function startsWith(b, s, e, str) {
  if (e - s < str.length) return false;
  for (let i = 0; i < str.length; i++) if (b[s + i] !== str.charCodeAt(i)) return false;
  return true;
}

// Every typed array in a parse result, for zero-copy transfer to another thread.
export function transferables(result) {
  const out = [];
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    if (ArrayBuffer.isView(o)) { out.push(o.buffer); return; }
    if (Array.isArray(o)) { for (const v of o) if (v && typeof v === "object") walk(v); return; }
    for (const k in o) walk(o[k]);
  };
  walk(result.objects); walk(result.samples); walk(result.channels); walk(result.locks);
  return [...new Set(out)];
}
