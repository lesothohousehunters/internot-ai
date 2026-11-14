// Internot AI — turns an OpenStreetMap extract (.osm.pbf) into a compact offline map (.imap).
// Runs on the phone (inside a worker) and in Node (tools/build-map.mjs). No dependencies.

export const ROAD_CLASS = {
  motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4,
  unclassified: 5, road: 5, residential: 6, living_street: 6, service: 7, track: 8,
};
export const RIVER = 20;
export const PLACE_TYPES = ['city', 'town', 'village', 'hamlet', 'suburb', 'hospital', 'clinic', 'fuel', 'police', 'school', 'pharmacy', 'bank', 'marketplace', 'bus_station'];
const PLACE_TAG = new Set(['city', 'town', 'village', 'hamlet', 'suburb']);
const AMENITY_TAG = new Set(['hospital', 'clinic', 'fuel', 'police', 'school', 'pharmacy', 'bank', 'marketplace', 'bus_station']);
const TWO32 = 4294967296;

export const lonToX = (lon) => Math.min(TWO32 - 1, Math.max(0, Math.round((lon + 180) / 360 * TWO32)));
export const latToY = (lat) => {
  const r = lat * Math.PI / 180;
  return Math.min(TWO32 - 1, Math.max(0, Math.round((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2 * TWO32)));
};

/* ---------- minimal protobuf reader ---------- */
class PB {
  constructor(buf, pos = 0, end = buf.length) { this.b = buf; this.p = pos; this.e = end; this.field = 0; this.wire = 0; }
  varint() {
    const b = this.b; let p = this.p, r = 0, m = 1, c;
    do { c = b[p++]; r += (c & 0x7f) * m; m *= 128; } while (c & 0x80);
    this.p = p; return r;
  }
  svarint() { const v = this.varint(); return v % 2 ? -(v + 1) / 2 : v / 2; }
  next() { if (this.p >= this.e) return false; const t = this.varint(); this.field = Math.floor(t / 8); this.wire = t & 7; return true; }
  bytes() { const n = this.varint(); const s = this.b.subarray(this.p, this.p + n); this.p += n; return s; }
  sub() { const n = this.varint(); const r = new PB(this.b, this.p, this.p + n); this.p += n; return r; }
  skip() {
    if (this.wire === 0) this.varint(); else if (this.wire === 2) { const n = this.varint(); this.p += n; }
    else if (this.wire === 5) this.p += 4; else if (this.wire === 1) this.p += 8; else throw new Error('Bad map file');
  }
}

async function inflate(data) {
  const ds = new DecompressionStream('deflate');
  return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(ds)).arrayBuffer());
}

// reader: { size, read(offset, length) -> Promise<Uint8Array> }
async function* blocks(reader, onProgress) {
  let pos = 0;
  while (pos < reader.size) {
    const lenBuf = await reader.read(pos, 4); pos += 4;
    const hlen = new DataView(lenBuf.buffer, lenBuf.byteOffset, 4).getUint32(0);
    const hp = new PB(await reader.read(pos, hlen)); pos += hlen;
    let type = '', size = 0;
    while (hp.next()) { if (hp.field === 1) type = new TextDecoder().decode(hp.bytes()); else if (hp.field === 3) size = hp.varint(); else hp.skip(); }
    if (!size || size > 64 * 1024 * 1024) throw new Error('This is not an OpenStreetMap .osm.pbf file.');
    if (type === 'OSMData') {
      const bp = new PB(await reader.read(pos, size)); let raw = null, z = null;
      while (bp.next()) { if (bp.field === 1) raw = bp.bytes(); else if (bp.field === 3) z = bp.bytes(); else bp.skip(); }
      const data = raw || (z ? await inflate(z) : null);
      if (!data) throw new Error('This map file uses a compression the app cannot read.');
      yield parseBlock(data);
    } else if (type !== 'OSMHeader') throw new Error('This is not an OpenStreetMap .osm.pbf file.');
    pos += size; onProgress?.(pos / reader.size);
  }
}

function parseBlock(data) {
  const p = new PB(data); const blk = { strings: [], groups: [], gran: 100, latOff: 0, lonOff: 0, _s: [] };
  while (p.next()) {
    if (p.field === 1) { const st = p.sub(); while (st.next()) { if (st.field === 1) blk.strings.push(st.bytes()); else st.skip(); } }
    else if (p.field === 2) blk.groups.push(p.sub());
    else if (p.field === 17) blk.gran = p.varint();
    else if (p.field === 19) blk.latOff = p.varint();
    else if (p.field === 20) blk.lonOff = p.varint();
    else p.skip();
  }
  return blk;
}
const dec = new TextDecoder();
const str = (blk, i) => (blk._s[i] ??= dec.decode(blk.strings[i]));
function tagIndex(blk, names) {
  const want = new Map(names.map((n) => [n, -1])); const enc = new TextEncoder();
  const targets = names.map((n) => enc.encode(n));
  blk.strings.forEach((s, i) => { for (let k = 0; k < targets.length; k++) { const t = targets[k]; if (s.length === t.length && s.every((c, j) => c === t[j])) want.set(names[k], i); } });
  return want;
}
function packed(p, signed, delta) {
  const s = p.sub(); const out = []; let acc = 0;
  while (s.p < s.e) { const v = signed ? s.svarint() : s.varint(); if (delta) { acc += v; out.push(acc); } else out.push(v); }
  return out;
}

/**
 * Convert an .osm.pbf into an .imap ArrayBuffer.
 * onProgress(fraction 0..1, label)
 */
export async function convertPbf(reader, name, onProgress) {
  const names = ['']; const nameIdx = new Map([['', 0]]);
  const intern = (s) => { let i = nameIdx.get(s); if (i === undefined) { i = names.length; names.push(s); nameIdx.set(s, i); } return i; };
  const wayClass = [], wayFlags = [], wayName = [], wayStart = [0]; let refs = new Float64Array(1 << 20), nRefs = 0;
  const pushRef = (id) => { if (nRefs === refs.length) { const g = new Float64Array(refs.length * 2); g.set(refs); refs = g; } refs[nRefs++] = id; };
  const places = [];      // [type, name, x, y]
  const areaPois = [];    // { type, name, ref }

  // Pass 1: roads, rivers and named places drawn as areas.
  for await (const blk of blocks(reader, (f) => onProgress?.(f * 0.45, 'Reading roads'))) {
    const t = tagIndex(blk, ['highway', 'waterway', 'name', 'oneway', 'junction', 'amenity']);
    for (const g of blk.groups) {
      while (g.next()) {
        if (g.field !== 3) { g.skip(); continue; }
        const w = g.sub(); let keys = [], vals = [], r = null;
        while (w.next()) { if (w.field === 2) keys = packed(w, false, false); else if (w.field === 3) vals = packed(w, false, false); else if (w.field === 8) r = packed(w, true, true); else w.skip(); }
        if (!r || r.length < 2 || !keys.length) continue;
        let hw = null, ww = null, nm = '', ow = null, jn = null, am = null;
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i];
          if (k === t.get('highway')) hw = str(blk, vals[i]); else if (k === t.get('waterway')) ww = str(blk, vals[i]);
          else if (k === t.get('name')) nm = str(blk, vals[i]); else if (k === t.get('oneway')) ow = str(blk, vals[i]);
          else if (k === t.get('junction')) jn = str(blk, vals[i]); else if (k === t.get('amenity')) am = str(blk, vals[i]);
        }
        if (am && nm && AMENITY_TAG.has(am)) { areaPois.push({ type: PLACE_TYPES.indexOf(am), name: nm, ref: r[0] }); pushRef(r[0]); wayClass.push(255); wayFlags.push(0); wayName.push(0); wayStart.push(nRefs); }
        let cls = -1;
        if (hw) { cls = ROAD_CLASS[hw.endsWith('_link') ? hw.slice(0, -5) : hw] ?? -1; } else if (ww === 'river' || ww === 'canal') cls = RIVER;
        if (cls < 0) continue;
        let flags = 0; const round = jn === 'roundabout' || jn === 'circular';
        if (cls !== RIVER) {
          if (ow === '-1') { r.reverse(); flags |= 1; }
          else if (ow === 'yes' || ow === 'true' || ow === '1' || round || (hw === 'motorway' && ow !== 'no')) flags |= 1;
          if (round) flags |= 2;
        }
        for (const id of r) pushRef(id);
        wayClass.push(cls); wayFlags.push(flags); wayName.push(intern(nm)); wayStart.push(nRefs);
      }
    }
  }
  if (!wayClass.some((c) => c < 20)) throw new Error('No roads were found in this file.');

  // Sorted list of the node ids we need.
  const sorted = refs.slice(0, nRefs).sort(); let N = 0;
  for (let i = 0; i < sorted.length; i++) if (i === 0 || sorted[i] !== sorted[i - 1]) sorted[N++] = sorted[i];
  const needed = sorted.subarray(0, N); const X = new Uint32Array(N), Y = new Uint32Array(N); const have = new Uint8Array(N);
  const find = (id) => { let lo = 0, hi = N - 1; while (lo <= hi) { const m = (lo + hi) >> 1; const v = needed[m]; if (v === id) return m; if (v < id) lo = m + 1; else hi = m - 1; } return -1; };

  // Pass 2: coordinates for those nodes, plus named places.
  for await (const blk of blocks(reader, (f) => onProgress?.(0.45 + f * 0.45, 'Reading places'))) {
    const t = tagIndex(blk, ['place', 'amenity', 'name']);
    const coord = (lat, lon) => [lonToX(1e-9 * (blk.lonOff + blk.gran * lon)), latToY(1e-9 * (blk.latOff + blk.gran * lat))];
    const tagged = (kv) => {  // kv: array of [keyIdx, valIdx]
      let pl = null, am = null, nm = null;
      for (const [k, v] of kv) { if (k === t.get('place')) pl = str(blk, v); else if (k === t.get('amenity')) am = str(blk, v); else if (k === t.get('name')) nm = str(blk, v); }
      if (!nm) return -1;
      if (pl && PLACE_TAG.has(pl)) return [PLACE_TYPES.indexOf(pl), nm];
      if (am && AMENITY_TAG.has(am)) return [PLACE_TYPES.indexOf(am), nm];
      return -1;
    };
    for (const g of blk.groups) {
      while (g.next()) {
        if (g.field === 2) {
          const d = g.sub(); let ids = [], lats = [], lons = [], kv = [];
          while (d.next()) { if (d.field === 1) ids = packed(d, true, true); else if (d.field === 8) lats = packed(d, true, true); else if (d.field === 9) lons = packed(d, true, true); else if (d.field === 10) kv = packed(d, false, false); else d.skip(); }
          let q = 0, hint = 0;
          for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            while (hint < N && needed[hint] < id) hint++;
            const at = hint < N && needed[hint] === id ? hint : (hint > 0 && needed[hint - 1] > id ? find(id) : -1);
            if (at >= 0) { const c = coord(lats[i], lons[i]); X[at] = c[0]; Y[at] = c[1]; have[at] = 1; }
            if (kv.length) {
              const pairs = []; while (q < kv.length && kv[q] !== 0) { pairs.push([kv[q], kv[q + 1]]); q += 2; } q++;
              if (pairs.length) { const p = tagged(pairs); if (p !== -1) { const c = coord(lats[i], lons[i]); places.push([p[0], p[1], c[0], c[1]]); } }
            }
          }
        } else if (g.field === 1) {
          const n = g.sub(); let id = 0, lat = 0, lon = 0, keys = [], vals = [];
          while (n.next()) { if (n.field === 1) id = n.svarint(); else if (n.field === 8) lat = n.svarint(); else if (n.field === 9) lon = n.svarint(); else if (n.field === 2) keys = packed(n, false, false); else if (n.field === 3) vals = packed(n, false, false); else n.skip(); }
          const at = find(id); const c = coord(lat, lon);
          if (at >= 0) { X[at] = c[0]; Y[at] = c[1]; have[at] = 1; }
          if (keys.length) { const p = tagged(keys.map((k, i) => [k, vals[i]])); if (p !== -1) places.push([p[0], p[1], c[0], c[1]]); }
        } else g.skip();
      }
    }
  }
  onProgress?.(0.92, 'Building map');

  // Ways -> node indices. Drop ways that point at nodes missing from the extract.
  const oClass = [], oFlags = [], oName = [], oStart = [0]; const oNodes = new Uint32Array(nRefs); let o = 0;
  for (let w = 0; w < wayClass.length; w++) {
    const a = wayStart[w], b = wayStart[w + 1];
    if (wayClass[w] === 255) continue;
    const begin = o; let ok = true;
    for (let i = a; i < b; i++) { const at = find(refs[i]); if (at < 0 || !have[at]) { ok = false; break; } oNodes[o++] = at; }
    if (!ok || o - begin < 2) { o = begin; continue; }
    oClass.push(wayClass[w]); oFlags.push(wayFlags[w]); oName.push(wayName[w]); oStart.push(o);
  }
  for (const p of areaPois) { const at = find(p.ref); if (at >= 0 && have[at]) places.push([p.type, p.name, X[at], Y[at]]); }

  let minX = TWO32, minY = TWO32, maxX = 0, maxY = 0;
  for (let i = 0; i < o; i++) { const n = oNodes[i]; if (X[n] < minX) minX = X[n]; if (X[n] > maxX) maxX = X[n]; if (Y[n] < minY) minY = Y[n]; if (Y[n] > maxY) maxY = Y[n]; }
  return encodeImap({ name, N, X, Y, W: oClass.length, wayStart: Uint32Array.from(oStart), wayNodes: oNodes.subarray(0, o), wayName: Uint32Array.from(oName), wayClass: Uint8Array.from(oClass), wayFlags: Uint8Array.from(oFlags), names, places, bbox: [minX, minY, maxX, maxY] });
}

const pad4 = (n) => (n + 3) & ~3;

export function encodeImap(m) {
  const header = new TextEncoder().encode(JSON.stringify({ v: 1, name: m.name, built: new Date().toISOString().slice(0, 10), bbox: m.bbox, N: m.N, W: m.W, R: m.wayNodes.length, names: m.names, places: m.places }));
  const hl = pad4(header.length); const R = m.wayNodes.length;
  const total = 12 + hl + 4 * (m.N * 2 + (m.W + 1) + R + m.W) + pad4(m.W) * 2;
  const buf = new ArrayBuffer(total); const u8 = new Uint8Array(buf); const dv = new DataView(buf);
  u8.set([73, 77, 65, 80]); dv.setUint32(4, 1, true); dv.setUint32(8, hl, true); u8.set(header, 12);
  for (let i = header.length; i < hl; i++) u8[12 + i] = 32;
  let off = 12 + hl;
  const put32 = (arr) => { new Uint32Array(buf, off, arr.length).set(arr); off += arr.length * 4; };
  put32(m.X); put32(m.Y); put32(m.wayStart); put32(m.wayNodes); put32(m.wayName);
  u8.set(m.wayClass, off); off += pad4(m.W); u8.set(m.wayFlags, off);
  return buf;
}

export function decodeImap(buf) {
  const u8 = new Uint8Array(buf); const dv = new DataView(buf);
  if (u8[0] !== 73 || u8[1] !== 77 || u8[2] !== 65 || u8[3] !== 80 || dv.getUint32(4, true) !== 1) throw new Error('This is not an Internot map file.');
  const hl = dv.getUint32(8, true); const h = JSON.parse(new TextDecoder().decode(u8.subarray(12, 12 + hl)));
  let off = 12 + hl; const get32 = (n) => { const a = new Uint32Array(buf, off, n); off += n * 4; return a; };
  const X = get32(h.N), Y = get32(h.N), wayStart = get32(h.W + 1), wayNodes = get32(h.R), wayName = get32(h.W);
  const wayClass = new Uint8Array(buf, off, h.W); off += pad4(h.W); const wayFlags = new Uint8Array(buf, off, h.W);
  return { ...h, X, Y, wayStart, wayNodes, wayName, wayClass, wayFlags };
}
