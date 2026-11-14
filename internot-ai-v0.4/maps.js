// Internot AI — offline maps, routing and spoken navigation.
// The map is one file on the device. Position comes from the GPS chip. No network is used.
import { decodeImap, lonToX, latToY, PLACE_TYPES, RIVER } from './osmpbf.js';

const $ = (id) => document.getElementById(id);
const TWO32 = 4294967296, EARTH = 40075016.686;
const MAP_FILE = 'map.imap';
const SPEED = [100, 90, 80, 60, 50, 40, 30, 20, 20];            // km/h by road class
const ROAD_MINZ = [0, 0, 0, 8.5, 10, 11.5, 12.5, 14, 13];       // zoom at which each class appears
const ROAD_W = [5, 5, 4.5, 4, 3.4, 3, 2.6, 1.6, 1.3];
const ROAD_COL = ['#d97757', '#d97757', '#e39a7d', '#eebf9d', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#b7a685'];
const PLACE_MINZ = [0, 0, 10.5, 12.5, 12.5, 13.5, 14, 14, 14, 14.5, 15, 15, 15, 15];
const PLACE_RANK = [0, 1, 2, 4, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13];

const M = {
  root: null, map: null, mem: null, view: { cx: 0, cy: 0, z: 10 }, w: 0, h: 0,
  gps: null, watch: null, follow: false, start: null, dest: null, pick: null, route: null, nav: null,
  mute: false, raf: 0, spoken: [], wake: null, world: null,
};
window.internotMap = M;

/* ---------- geometry ---------- */
const mPerUnit = (y) => EARTH / TWO32 / Math.cosh(Math.PI * (1 - 2 * y / TWO32));
const upp = () => TWO32 / (256 * 2 ** M.view.z);                 // map units per screen pixel
const toSX = (x) => (x - M.view.cx) / upp() + M.w / 2;
const toSY = (y) => (y - M.view.cy) / upp() + M.h / 2;
const fromS = (sx, sy) => ({ x: M.view.cx + (sx - M.w / 2) * upp(), y: M.view.cy + (sy - M.h / 2) * upp() });
function metres(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by) * mPerUnit((ay + by) / 2); }
const nodeDist = (a, b) => { const m = M.map; return metres(m.X[a], m.Y[a], m.X[b], m.Y[b]); };
const bearing = (ax, ay, bx, by) => Math.atan2(bx - ax, -(by - ay)) * 180 / Math.PI;
const fmtDist = (m) => m < 995 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
const sayDist = (m) => m < 995 ? `${Math.max(10, Math.round(m / 10) * 10)} metres` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} kilometres`;
const fmtTime = (s) => { const min = Math.max(1, Math.round(s / 60)); return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`; };

/* ---------- loading ---------- */
function prepare(map) {
  const { N, W, X, Y, wayStart, wayNodes, wayClass, wayFlags } = map;
  const box = new Uint32Array(W * 4); const links = new Uint8Array(N); const out = new Uint32Array(N + 1);
  for (let w = 0; w < W; w++) {
    let x0 = TWO32, y0 = TWO32, x1 = 0, y1 = 0; const road = wayClass[w] < 20, one = wayFlags[w] & 1;
    for (let i = wayStart[w]; i < wayStart[w + 1]; i++) {
      const n = wayNodes[i]; if (X[n] < x0) x0 = X[n]; if (X[n] > x1) x1 = X[n]; if (Y[n] < y0) y0 = Y[n]; if (Y[n] > y1) y1 = Y[n];
      if (road && i > wayStart[w]) { const p = wayNodes[i - 1]; out[p]++; if (!one) out[n]++; if (links[p] < 255) links[p]++; if (links[n] < 255) links[n]++; }
    }
    box.set([x0, y0, x1, y1], w * 4);
  }
  const adjStart = new Uint32Array(N + 1); for (let i = 0; i < N; i++) adjStart[i + 1] = adjStart[i] + out[i];
  const E = adjStart[N]; const adjTo = new Uint32Array(E), adjWay = new Uint32Array(E); const fill = adjStart.slice(0, N);
  for (let w = 0; w < W; w++) {
    if (wayClass[w] >= 20) continue; const one = wayFlags[w] & 1;
    for (let i = wayStart[w] + 1; i < wayStart[w + 1]; i++) {
      const a = wayNodes[i - 1], b = wayNodes[i];
      adjTo[fill[a]] = b; adjWay[fill[a]++] = w; if (!one) { adjTo[fill[b]] = a; adjWay[fill[b]++] = w; }
    }
  }
  // grid of routable nodes, for snapping taps and GPS fixes to the road network
  const G = 256, [bx0, by0, bx1, by1] = map.bbox; const cw = Math.max(1, (bx1 - bx0 + 1) / G), ch = Math.max(1, (by1 - by0 + 1) / G);
  const cellOf = (n) => Math.min(G - 1, Math.floor((Y[n] - by0) / ch)) * G + Math.min(G - 1, Math.floor((X[n] - bx0) / cw));
  const cellStart = new Uint32Array(G * G + 1);
  for (let n = 0; n < N; n++) if (links[n]) cellStart[cellOf(n) + 1]++;
  for (let c = 0; c < G * G; c++) cellStart[c + 1] += cellStart[c];
  const cellNodes = new Uint32Array(cellStart[G * G]); const cf = cellStart.slice(0, G * G);
  for (let n = 0; n < N; n++) if (links[n]) cellNodes[cf[cellOf(n)]++] = n;
  const places = map.places.map(([t, name, x, y]) => ({ t, name, x, y, lower: name.toLowerCase() })).sort((a, b) => PLACE_RANK[a.t] - PLACE_RANK[b.t]);
  Object.assign(map, { box, links, adjStart, adjTo, adjWay, G, cw, ch, cellStart, cellNodes, placeList: places,
    g: new Float32Array(N), prev: new Int32Array(N), prevWay: new Uint32Array(N), mpuMin: Math.min(mPerUnit(by0), mPerUnit(by1)) });
  return map;
}

/* ---------- world base map (ships with the app) ---------- */
async function loadWorld() {
  try {
    const w = await (await fetch('./world.json')).json(); const k = TWO32 / w.grid; const path = new Path2D();
    for (const r of w.rings) { let x = r[0], y = r[1]; path.moveTo(x, y); for (let i = 2; i < r.length; i += 2) { x += r[i]; y += r[i + 1]; path.lineTo(x, y); } path.closePath(); }
    M.world = { grid: w.grid, path,
      countries: w.countries.map(([name, x, y, rank]) => ({ name, x: x * k, y: y * k, rank, lower: name.toLowerCase(), kind: 'country' })),
      cities: w.cities.map(([name, x, y, rank, country, cap]) => ({ name, x: x * k, y: y * k, rank, country, cap, lower: name.toLowerCase(), kind: 'city' })) };
    draw();
  } catch (e) { console.warn('world map unavailable', e); }
}
const cityMinZ = (c) => c.rank <= 1 ? 3 : c.rank <= 3 ? 4.5 : c.rank <= 5 ? 5.5 : c.rank <= 7 ? 6.5 : 7.5;
const inDetail = (p) => { const m = M.map; if (!m || m.stub) return false; const [a, b, c, d] = m.bbox; return p.x >= a && p.x <= c && p.y >= b && p.y <= d; };
function stubMap() {
  const e = () => new Uint32Array(0);
  return prepare({ stub: true, name: 'World', built: '', N: 0, W: 0, R: 0, X: e(), Y: e(), wayStart: new Uint32Array(1), wayNodes: e(), wayName: e(),
    wayClass: new Uint8Array(0), wayFlags: new Uint8Array(0), names: [], places: [], bbox: [0, 0, TWO32 - 1, TWO32 - 1] });
}
function showWorld() { M.map = stubMap(); M.view.cx = lonToX(22); M.view.cy = latToY(-8); M.view.z = 2.6; M.needFit = false; showMap(true); resize(); }

async function loadStored() {
  let buf = M.mem;
  if (!buf && M.root) { try { buf = await (await (await M.root.getFileHandle(MAP_FILE)).getFile()).arrayBuffer(); } catch { buf = null; } }
  if (!buf) return false;
  M.map = prepare(decodeImap(buf));
  const [x0, y0, x1, y1] = M.map.bbox; M.view.cx = (x0 + x1) / 2; M.view.cy = (y0 + y1) / 2;
  showMap(true); M.needFit = true; resize(); return true;
}

function setProgress(frac, label) {
  $('map-progress').hidden = frac == null;
  if (frac != null) { $('map-progress-bar').style.width = Math.round(frac * 100) + '%'; $('map-progress-label').textContent = label || ''; }
  window.internotLoader?.(frac == null ? null : (label || 'Preparing map') + '…', frac ?? undefined);
}
// A ready-made country map that ships with the app (inside the Android app, or beside the web app).
const BUILT_IN = './maps/lesotho.imap';
const NATIVE = !!window.Capacitor;
let builtIn = null;
function builtInAvailable() { return builtIn ||= fetch(BUILT_IN, { method: 'HEAD' }).then((r) => r.ok && !/html/.test(r.headers.get('content-type') || ''), () => false); }
async function useBuiltIn() {   // Android app: the file is already on the phone, so read it in place
  try { const r = await fetch(BUILT_IN); if (!r.ok) return false; const buf = await r.arrayBuffer(); decodeImap(buf); M.mem = buf; return await loadStored(); } catch (e) { console.warn('built-in map unreadable', e); M.mem = null; return false; }
}
async function getBuiltIn() {   // web app: one download, then kept on the device
  $('map-error').textContent = '';
  try {
    const r = await fetch(BUILT_IN); if (!r.ok || !r.body) throw new Error('The map could not be downloaded. Check the connection and try again.');
    const total = Number(r.headers.get('content-length')) || 0; const rd = r.body.getReader(); const parts = []; let n = 0;
    for (;;) { const { value, done } = await rd.read(); if (done) break; parts.push(value); n += value.byteLength; setProgress(total ? n / total * 0.9 : 0.5, 'Downloading map'); }
    await importMap(new File(parts, 'lesotho.imap'));
  } catch (e) { setProgress(null); $('map-error').textContent = e?.message || 'The map could not be downloaded.'; }
}
const niceName = (file) => { const b = file.replace(/\.(osm\.pbf|pbf|imap)$/i, '').replace(/-latest$|-\d{6}$/, '').replace(/[-_]+/g, ' ').trim(); return b ? b[0].toUpperCase() + b.slice(1) : 'Map'; };

async function importMap(file) {
  $('map-error').textContent = '';
  try {
    let buf; const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (head[0] === 73 && head[1] === 77 && head[2] === 65 && head[3] === 80) { setProgress(0.5, 'Copying map'); buf = await file.arrayBuffer(); }
    else {
      if (file.size > 400 * 1048576) throw new Error('This file is too large for a phone. Choose a single country or region under 400 MB.');
      buf = await new Promise((resolve, reject) => {
        const worker = new Worker('./map-worker.js', { type: 'module' });
        worker.onmessage = (e) => { if (e.data.progress != null) setProgress(e.data.progress, e.data.label); else { worker.terminate(); e.data.done ? resolve(e.data.done) : reject(new Error(e.data.error)); } };
        worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || 'Could not read the map file.')); };
        setProgress(0, 'Reading roads'); worker.postMessage({ file, name: niceName(file.name) });
      });
    }
    decodeImap(buf); // validate before saving
    setProgress(0.97, 'Saving map');
    let saved = false;
    if (M.root) { try { const h = await M.root.getFileHandle(MAP_FILE, { create: true }); const w = await h.createWritable(); await w.write(buf); await w.close(); saved = true; } catch (e) { console.warn('map not saved', e); } }
    M.mem = saved ? null : buf; clearRoute(); M.start = null; M.dest = null;
    M.map = null; if (saved) await loadStored(); else { M.mem = buf; await loadStored(); }
  } catch (e) { $('map-error').textContent = e?.message || 'Could not read that map file.'; }
  setProgress(null); renderMapInfo();
}

async function deleteMap() {
  endNav(); clearRoute(); M.map = null; M.mem = null; try { localStorage.setItem('noBuiltInMap', '1'); } catch {}
  try { await M.root?.removeEntry(MAP_FILE); } catch {}
  showWorld(); renderMapInfo();
}
function showMap() { $('map-wrap').hidden = false; }
function renderMapInfo() {
  const el = $('map-info'); if (!el) return;
  const real = M.map && !M.map.stub;
  el.textContent = real ? `${M.map.name} · ${M.map.W.toLocaleString()} roads · ${M.map.placeList.length.toLocaleString()} places · map data from ${M.map.built}` : 'World map only. Add a country map below for streets, villages and directions.';
  $('map-delete').hidden = !real; $('map-replace').hidden = true;
  builtInAvailable().then((ok) => { $('map-get').hidden = real || !ok; });
}

/* ---------- drawing ---------- */
function resize() {
  const wrap = $('map-wrap'); if (wrap.hidden) return; const c = $('map-canvas'); const r = wrap.getBoundingClientRect();
  if (!r.width || !r.height) return; const dpr = Math.min(2, window.devicePixelRatio || 1);
  M.w = r.width; M.h = r.height; c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); M.dpr = dpr;
  if (M.needFit && M.map) { const [x0, y0, x1, y1] = M.map.bbox; M.needFit = false; M.view.z = Math.min(16, Math.log2(Math.min(M.w / Math.max(1, x1 - x0), M.h / Math.max(1, y1 - y0)) * TWO32 / 256) - 0.3); }
  draw();
}
function draw() { if (!M.raf) M.raf = requestAnimationFrame(() => { M.raf = 0; paint(); }); }

function paint() {
  const map = M.map, c = $('map-canvas'); if (!map || !M.w) return;
  const ctx = c.getContext('2d'); ctx.setTransform(M.dpr, 0, 0, M.dpr, 0, 0);
  const u = upp(), z = M.view.z, { X, Y, wayStart, wayNodes, wayClass, box, W } = map;
  const x0 = M.view.cx - M.w / 2 * u, x1 = M.view.cx + M.w / 2 * u, y0 = M.view.cy - M.h / 2 * u, y1 = M.view.cy + M.h / 2 * u;
  const ox = M.w / 2 - M.view.cx / u, oy = M.h / 2 - M.view.cy / u;
  const wd = M.world, sea = wd && z < 9; ctx.fillStyle = sea ? '#d3e3ee' : '#f3f0e7';   // zoomed in, the sea fill is skipped: it is not accurate enough at street level ctx.fillRect(0, 0, M.w, M.h);
  if (wd) {   // land and country borders, drawn from one cached outline
    const s = TWO32 / wd.grid / u; ctx.save(); ctx.setTransform(M.dpr * s, 0, 0, M.dpr * s, M.dpr * ox, M.dpr * oy);
    if (sea) { ctx.fillStyle = '#f3f0e7'; ctx.fill(wd.path); } ctx.lineWidth = 1.1 / s; ctx.strokeStyle = '#bfb39a'; ctx.stroke(wd.path); ctx.restore();
  }
  const paths = []; const minSize = 1.5 * u;
  for (let w = 0; w < W; w++) {
    const cls = wayClass[w]; const slot = cls >= 20 ? 9 : cls;
    if (cls < 20 && z < ROAD_MINZ[cls]) continue;
    const b = w * 4; if (box[b] > x1 || box[b + 2] < x0 || box[b + 1] > y1 || box[b + 3] < y0) continue;
    if (cls > 3 && box[b + 2] - box[b] < minSize && box[b + 3] - box[b + 1] < minSize) continue;
    const p = (paths[slot] ||= new Path2D()); let lx = -1e9, ly = -1e9; const end = wayStart[w + 1];
    for (let i = wayStart[w]; i < end; i++) {
      const n = wayNodes[i]; const sx = X[n] / u + ox, sy = Y[n] / u + oy;
      if (i === wayStart[w]) { p.moveTo(sx, sy); lx = sx; ly = sy; }
      else if (i === end - 1 || Math.abs(sx - lx) + Math.abs(sy - ly) > 1.5) { p.lineTo(sx, sy); lx = sx; ly = sy; }
    }
  }
  const k = Math.min(2.4, Math.max(0.5, 0.5 + (z - 10) * 0.2));
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (paths[9]) { ctx.strokeStyle = '#9fc4e4'; ctx.lineWidth = 2.2 * k; ctx.stroke(paths[9]); }
  for (let cls = 8; cls >= 0; cls--) {          // casings first, so junctions join cleanly
    if (!paths[cls] || cls === 8) continue; ctx.strokeStyle = cls <= 3 ? '#b9623f' : '#cdc6b4'; ctx.lineWidth = ROAD_W[cls] * k + 1.6; ctx.stroke(paths[cls]);
  }
  for (let cls = 8; cls >= 0; cls--) {
    if (!paths[cls]) continue; ctx.strokeStyle = ROAD_COL[cls]; ctx.lineWidth = ROAD_W[cls] * k;
    ctx.setLineDash(cls === 8 ? [5, 4] : []); ctx.stroke(paths[cls]);
  }
  ctx.setLineDash([]);

  if (M.route) {
    const r = M.route; ctx.beginPath();
    for (let i = 0; i < r.nodes.length; i++) { const n = r.nodes[i]; const sx = X[n] / u + ox, sy = Y[n] / u + oy; i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); }
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 9; ctx.stroke(); ctx.strokeStyle = '#2f6fde'; ctx.lineWidth = 5.5; ctx.stroke();
  }

  // place names
  const used = []; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  for (const p of map.placeList) {
    if (z < PLACE_MINZ[p.t]) continue; if (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue; if (used.length > 70) break;
    const sx = p.x / u + ox, sy = p.y / u + oy; const big = p.t <= 1; const poi = p.t >= 5;
    ctx.font = `${big ? '600 15px' : p.t === 2 ? '500 13px' : '12px'} system-ui, sans-serif`;
    const tw = ctx.measureText(p.name).width; const tx = poi ? sx + 8 : sx - tw / 2; const rect = [tx - 3, sy - 9, tx + tw + 3, sy + 9];
    if (used.some((q) => rect[0] < q[2] && rect[2] > q[0] && rect[1] < q[3] && rect[3] > q[1])) continue; used.push(rect);
    if (poi) { ctx.fillStyle = '#c15f3c'; ctx.beginPath(); ctx.arc(sx, sy, 3.5, 0, 7); ctx.fill(); }
    ctx.strokeStyle = 'rgba(243,240,231,.92)'; ctx.lineWidth = 4; ctx.strokeText(p.name, tx, sy);
    ctx.fillStyle = poi ? '#7a4a36' : '#2b2a27'; ctx.fillText(p.name, tx, sy);
  }

  if (wd) {
    const label = (p, font, col) => {
      if (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) return; const sx = p.x / u + ox, sy = p.y / u + oy; ctx.font = font;
      const tw = ctx.measureText(p.name).width; const city = p.kind === 'city'; const tx = city ? sx + 7 : sx - tw / 2; const rect = [tx - 3, sy - 9, tx + tw + 3, sy + 9];
      if (used.some((q) => rect[0] < q[2] && rect[2] > q[0] && rect[1] < q[3] && rect[3] > q[1])) return; used.push(rect);
      if (city) { ctx.fillStyle = p.cap ? '#c15f3c' : '#6b6860'; ctx.beginPath(); ctx.arc(sx, sy, p.cap ? 3.5 : 2.5, 0, 7); ctx.fill(); }
      ctx.strokeStyle = 'rgba(243,240,231,.92)'; ctx.lineWidth = 4; ctx.strokeText(p.name, tx, sy); ctx.fillStyle = col; ctx.fillText(p.name, tx, sy);
    };
    if (z < 7.5) for (const c of wd.countries) { if (c.rank <= z + 0.5 && used.length < 60) label(c, '600 13px system-ui, sans-serif', '#7a4a36'); }
    for (const c of wd.cities) { if (z >= cityMinZ(c) && used.length < 90 && !inDetail(c)) label(c, '12px system-ui, sans-serif', '#2b2a27'); }
  }

  const dot = (pt, fill, ring, r = 8) => { const sx = toSX(pt.x), sy = toSY(pt.y); ctx.beginPath(); ctx.arc(sx, sy, r, 0, 7); ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = ring; ctx.stroke(); };
  if (M.start) dot(M.start, '#ffffff', '#1f1e1d', 7);
  if (M.pick && !M.route) dot(M.pick, '#c15f3c', '#ffffff', 8);
  if (M.dest) dot(M.dest, '#1f1e1d', '#ffffff', 9);
  if (M.gps) {
    const sx = toSX(M.gps.x), sy = toSY(M.gps.y); const rad = Math.min(200, (M.gps.acc || 0) / mPerUnit(M.gps.y) / u);
    if (rad > 12) { ctx.beginPath(); ctx.arc(sx, sy, rad, 0, 7); ctx.fillStyle = 'rgba(47,111,222,.12)'; ctx.fill(); }
    dot(M.gps, '#2f6fde', '#ffffff', 8);
  }
}

/* ---------- snapping and routing ---------- */
function nearestNode(x, y) {
  const m = M.map, { G, cw, ch, cellStart, cellNodes, X, Y } = m; const [bx0, by0] = m.bbox;
  const cx = Math.min(G - 1, Math.max(0, Math.floor((x - bx0) / cw))), cy = Math.min(G - 1, Math.max(0, Math.floor((y - by0) / ch)));
  let best = -1, bd = Infinity;
  for (let r = 0; r < G; r++) {
    for (let j = cy - r; j <= cy + r; j++) {
      if (j < 0 || j >= G) continue;
      for (let i = cx - r; i <= cx + r; i++) {
        if (i < 0 || i >= G || (Math.abs(i - cx) !== r && Math.abs(j - cy) !== r)) continue;
        const c = j * G + i;
        for (let q = cellStart[c]; q < cellStart[c + 1]; q++) { const n = cellNodes[q]; const d = (X[n] - x) ** 2 + (Y[n] - y) ** 2; if (d < bd) { bd = d; best = n; } }
      }
    }
    if (best >= 0 && Math.sqrt(bd) <= r * Math.min(cw, ch)) break;   // nothing in a wider ring can be closer
  }
  return best;
}

function astar(src, dst) {
  const m = M.map, { X, Y, adjStart, adjTo, adjWay, wayClass, g, prev, prevWay } = m;
  g.fill(Infinity); prev.fill(-1);
  const hx = X[dst], hy = Y[dst], hk = m.mpuMin / (100 / 3.6); const h = (n) => Math.hypot(X[n] - hx, Y[n] - hy) * hk;
  let cap = 1024, size = 0, keys = new Float64Array(cap), ids = new Int32Array(cap);
  const push = (key, id) => {
    if (size === cap) { cap *= 2; const k2 = new Float64Array(cap), i2 = new Int32Array(cap); k2.set(keys); i2.set(ids); keys = k2; ids = i2; }
    let i = size++; while (i > 0) { const p = (i - 1) >> 1; if (keys[p] <= key) break; keys[i] = keys[p]; ids[i] = ids[p]; i = p; } keys[i] = key; ids[i] = id;
  };
  const pop = () => {
    const top = ids[0]; const key = keys[--size], id = ids[size]; let i = 0;
    for (;;) { let c = 2 * i + 1; if (c >= size) break; if (c + 1 < size && keys[c + 1] < keys[c]) c++; if (keys[c] >= key) break; keys[i] = keys[c]; ids[i] = ids[c]; i = c; }
    keys[i] = key; ids[i] = id; return top;
  };
  g[src] = 0; push(h(src), src);
  while (size) {
    const fTop = keys[0]; const n = pop(); if (n === dst) break; if (fTop > g[n] + h(n) + 1e-3) continue;   // stale entry
    for (let e = adjStart[n]; e < adjStart[n + 1]; e++) {
      const t = adjTo[e], w = adjWay[e]; const cost = g[n] + nodeDist(n, t) / (SPEED[wayClass[w]] / 3.6);
      if (cost < g[t]) { g[t] = cost; prev[t] = n; prevWay[t] = w; push(cost + h(t), t); }
    }
  }
  if (src !== dst && prev[dst] < 0) return null;
  const nodes = [], ways = []; for (let n = dst; n !== src; n = prev[n]) { nodes.push(n); ways.push(prevWay[n]); } nodes.push(src);
  nodes.reverse(); ways.reverse(); return { nodes, ways, secs: g[dst] };
}

function buildRoute(path) {
  const m = M.map, { X, Y, wayName, wayFlags, names, links, adjStart, adjWay } = m; const { nodes, ways } = path; const n = nodes.length;
  const cum = new Float64Array(n); for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + nodeDist(nodes[i - 1], nodes[i]);
  const nameOf = (seg) => names[wayName[ways[seg]]] || ''; const round = (seg) => (wayFlags[ways[seg]] & 2) !== 0;
  const bIn = (i) => { let j = i - 1; while (j > 0 && cum[i] - cum[j] < 20) j--; return bearing(X[nodes[j]], Y[nodes[j]], X[nodes[i]], Y[nodes[i]]); };
  const bOut = (i) => { let j = i + 1; while (j < n - 1 && cum[j] - cum[i] < 20) j++; return bearing(X[nodes[i]], Y[nodes[i]], X[nodes[j]], Y[nodes[j]]); };
  const steps = []; if (n < 2) return { nodes, ways, cum, total: 0, secs: 0, steps: [{ i: 0, s: 0, text: 'You are already there' }] };
  const dir = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(((bOut(0) + 360) % 360) / 45) % 8];
  steps.push({ i: 0, s: 0, text: `Head ${dir}${nameOf(0) ? ' on ' + nameOf(0) : ''}` });
  for (let i = 1; i < n - 1; i++) {
    const segIn = i - 1, segOut = i;
    if (round(segOut)) {
      if (round(segIn)) continue;
      let exits = 0, j = i + 1;
      for (; j < n - 1 && round(j); j++) { for (let e = adjStart[nodes[j]]; e < adjStart[nodes[j] + 1]; e++) if (!(wayFlags[adjWay[e]] & 2)) { exits++; break; } }
      exits++; const onto = j < n - 1 ? nameOf(j) : '';
      steps.push({ i, s: cum[i], text: `At the roundabout, take exit ${exits}${onto ? ' onto ' + onto : ''}` }); continue;
    }
    if (round(segIn)) continue;
    let a = bOut(i) - bIn(i); a = ((a + 540) % 360) - 180; const abs = Math.abs(a); const side = a > 0 ? 'right' : 'left';
    const to = nameOf(segOut), onto = to ? ' onto ' + to : '';
    if (links[nodes[i]] <= 2 && !(abs >= 55 && to !== nameOf(segIn))) continue;   // a bend in the same road, not a junction
    if (abs >= 165) steps.push({ i, s: cum[i], text: 'Make a U-turn' + onto });
    else if (abs >= 120) steps.push({ i, s: cum[i], text: `Turn sharp ${side}${onto}` });
    else if (abs >= 55) steps.push({ i, s: cum[i], text: `Turn ${side}${onto}` });
    else if (abs >= 30) steps.push({ i, s: cum[i], text: `Keep ${side}${onto}` });
    else if (to && to !== nameOf(segIn)) steps.push({ i, s: cum[i], text: `Continue onto ${to}` });
  }
  steps.push({ i: n - 1, s: cum[n - 1], text: 'Arrive at your destination' });
  return { nodes, ways, cum, total: cum[n - 1], secs: path.secs, steps };
}

function clearRoute() { M.route = null; }

// Start routing from the end of the nearest road segment that lies ahead of the traveller.
function snapOrigin(p) {
  const m = M.map, { X, Y, adjStart, adjTo, adjWay } = m; const n = nearestNode(p.x, p.y); if (n < 0) return { node: n };
  let best = { node: n }, bd = Infinity;
  for (let e = adjStart[n]; e < adjStart[n + 1]; e++) {
    const t = adjTo[e]; const dx = X[t] - X[n], dy = Y[t] - Y[n]; const len2 = dx * dx + dy * dy; if (!len2) continue;
    const k = Math.min(1, Math.max(0, ((p.x - X[n]) * dx + (p.y - Y[n]) * dy) / len2)); const d = Math.hypot(p.x - (X[n] + k * dx), p.y - (Y[n] + k * dy));
    if (d < bd) { bd = d; const ahead = p.heading == null ? k > 0.5 : (dx * Math.sin(p.heading) - dy * Math.cos(p.heading)) > 0; best = k <= 0.02 ? { node: n } : ahead ? { node: t, from: n, way: adjWay[e] } : (m.wayFlags[adjWay[e]] & 1) ? { node: n } : { node: n, from: t, way: adjWay[e] }; }
  }
  return best;
}

function makeRoute(from, to) {
  if (!M.map) return false;
  const o = from === M.gps ? snapOrigin(from) : { node: nearestNode(from.x, from.y) }; const a = o.node, b = nearestNode(to.x, to.y); if (a < 0 || b < 0) return false;
  const path = astar(a, b); if (!path) return false;
  if (o.from != null && path.nodes[1] !== o.from) { path.nodes.unshift(o.from); path.ways.unshift(o.way); }   // keep the stretch the traveller is on
  M.route = buildRoute(path); return true;
}

/* ---------- GPS and navigation ---------- */
function speak(text) {
  M.spoken.push(text);
  if (M.mute || !('speechSynthesis' in window)) return;
  try { const u = new SpeechSynthesisUtterance(text); u.lang = 'en'; u.rate = 0.95; speechSynthesis.speak(u); } catch {}
}
function ensureGps() {
  if (M.watch != null || !navigator.geolocation) return;
  M.watch = navigator.geolocation.watchPosition(onGps, (err) => { if (err.code === 1) { msg('Location permission is off. Allow location for this app to see where you are.'); navigator.geolocation.clearWatch(M.watch); M.watch = null; } },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 60000 });
}
function onGps(pos) {
  const first = !M.gps;
  const old = M.gps, x = lonToX(pos.coords.longitude), y = latToY(pos.coords.latitude);
  const movedM = old ? metres(old.x, old.y, x, y) : 0;
  M.gps = { x, y, acc: pos.coords.accuracy || 0, heading: movedM > 4 ? Math.atan2(x - old.x, -(y - old.y)) : old?.heading ?? null };
  if (M.waitingRoute && M.dest) { M.waitingRoute = false; msg(''); directions(); }
  if (M.wantLocate) msg('');
  if (M.nav) track();
  if (M.follow || (first && M.wantLocate)) { M.view.cx = M.gps.x; M.view.cy = M.gps.y; if (M.view.z < 15) M.view.z = 16; M.wantLocate = false; }
  draw();
}

function track() {
  const r = M.route, nav = M.nav, m = M.map, { X, Y } = m; const g = M.gps; const n = r.nodes.length;
  const scan = (lo, hi) => {
    let best = { d: Infinity, k: lo, t: 0 };
    for (let k = lo; k <= hi; k++) {
      const ax = X[r.nodes[k]], ay = Y[r.nodes[k]], bx = X[r.nodes[k + 1]], by = Y[r.nodes[k + 1]]; const dx = bx - ax, dy = by - ay; const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.min(1, Math.max(0, ((g.x - ax) * dx + (g.y - ay) * dy) / len2)) : 0;
      const d = metres(g.x, g.y, ax + t * dx, ay + t * dy); if (d < best.d) best = { d, k, t };
    }
    return best;
  };
  if (n < 2) return;
  let hit = scan(Math.max(0, nav.k - 3), Math.min(n - 2, nav.k + 80)); if (hit.d > 80) hit = scan(0, n - 2);
  nav.k = hit.k; const s = r.cum[hit.k] + hit.t * (r.cum[hit.k + 1] - r.cum[hit.k]);
  if (hit.d > 50 && g.acc < 60) { if (++nav.off >= 3) { nav.off = 0; speak('Rerouting'); if (makeRoute(g, M.dest)) { nav.k = 0; nav.said.clear(); renderSheet(); return track(); } } } else nav.off = 0;
  let si = r.steps.findIndex((st, idx) => idx > 0 && st.s > s + 5); if (si < 0) si = r.steps.length - 1;
  const step = r.steps[si], dist = Math.max(0, step.s - s), last = si === r.steps.length - 1;
  const gap = step.s - r.steps[si - 1].s; const lower = step.text[0].toLowerCase() + step.text.slice(1);
  if (last && dist <= 30) { speak('You have arrived at your destination'); return endNav(true); }
  if (!last && dist <= 320 && dist > 120 && gap >= 450 && !nav.said.has(si + 'f')) { nav.said.add(si + 'f'); speak(`In ${sayDist(dist)}, ${lower}`); }
  if (!last && dist <= 45 && !nav.said.has(si + 'n')) { nav.said.add(si + 'n'); speak(step.text); }
  const left = r.total - s;
  $('nav-next').textContent = step.text; $('nav-dist').textContent = fmtDist(dist);
  $('nav-left').textContent = `${fmtDist(left)} · ${fmtTime(r.secs * left / Math.max(1, r.total))} left`;
}

async function startNav() {
  if (!M.route) return; ensureGps(); msg('');
  M.nav = { k: 0, off: 0, said: new Set() }; M.follow = true; $('nav-banner').hidden = false; $('map-search-box').hidden = true;
  const r = M.route; $('nav-next').textContent = r.steps[0].text; $('nav-dist').textContent = ''; $('nav-left').textContent = `${fmtDist(r.total)} · ${fmtTime(r.secs)} left`;
  speak(`Route ready. ${sayDist(r.total)}, about ${fmtTime(r.secs).replace('min', 'minutes').replace(' h', ' hours')}. ${r.steps[0].text}.`);
  try { M.wake = await navigator.wakeLock?.request('screen'); } catch {}
  if (M.gps) { M.view.cx = M.gps.x; M.view.cy = M.gps.y; if (M.view.z < 15) M.view.z = 16; track(); }
  renderSheet(); draw();
}
function endNav(arrived) {
  if (!M.nav) return; M.nav = null; M.follow = false; $('nav-banner').hidden = true; $('map-search-box').hidden = false;
  try { M.wake?.release(); } catch {} M.wake = null;
  if (arrived) { clearRoute(); M.dest = null; M.start = null; msg('You have arrived.'); }
  renderSheet(); draw();
}

/* ---------- sheet (bottom panel) ---------- */
function msg(text) { const el = $('map-msg'); el.textContent = text; el.hidden = !text; clearTimeout(M.msgT); if (text) M.msgT = setTimeout(() => { el.hidden = true; }, 6000); }
function button(label, cls, fn) { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; if (cls) b.className = cls; b.onclick = fn; return b; }

function directions() {
  if (M.map.stub) { msg('Directions need a country street map. Add one under Setup.'); return; }
  const from = M.start || M.gps;
  if (!from) { M.waitingRoute = true; ensureGps(); msg('Waiting for GPS… Or tap where you are and choose “Start from here”.'); renderSheet(); return; }
  if (!makeRoute(from, M.dest)) { clearRoute(); msg(M.map.stub ? 'Directions need a country street map. Add one under Setup.' : 'No road route was found between these two points. Directions work inside ' + M.map.name + '.'); }
  renderSheet(); draw();
}

function renderSheet() {
  const sheet = $('map-sheet'); sheet.textContent = ''; const row = document.createElement('div'); row.className = 'row wrap';
  const title = document.createElement('div'); title.className = 'sheet-title';
  if (M.nav) { sheet.hidden = false; row.append(button('End navigation', 'danger', () => endNav(false)), button(M.mute ? 'Voice off' : 'Voice on', '', () => { M.mute = !M.mute; if (M.mute) speechSynthesis?.cancel(); renderSheet(); })); sheet.append(row); return; }
  if (M.route) {
    const r = M.route; title.textContent = `${fmtDist(r.total)} · ${fmtTime(r.secs)}`;
    row.append(button('Start', 'primary', startNav), button('Clear', '', () => { clearRoute(); M.dest = null; M.start = null; M.pick = null; renderSheet(); draw(); }));
    const list = document.createElement('ol'); list.className = 'steps';
    r.steps.forEach((st, i) => { const li = document.createElement('li'); li.textContent = st.text; if (i < r.steps.length - 1) { const sm = document.createElement('small'); sm.textContent = fmtDist(r.steps[i + 1].s - st.s); li.append(sm); } list.append(li); });
    const det = document.createElement('details'); const sum = document.createElement('summary'); sum.textContent = `${r.steps.length} steps`; det.append(sum, list);
    sheet.append(title, row, det); sheet.hidden = false; return;
  }
  if (M.pick) {
    title.textContent = M.pick.label;
    row.append(button('Directions to here', 'primary', () => { M.dest = { x: M.pick.x, y: M.pick.y }; directions(); }),
      button('Start from here', '', () => { M.start = { x: M.pick.x, y: M.pick.y }; M.pick = null; msg('Start point set. Now tap your destination.'); if (M.dest) directions(); else { renderSheet(); draw(); } }),
      button('✕', '', () => { M.pick = null; renderSheet(); draw(); }));
    sheet.append(title, row); sheet.hidden = false; return;
  }
  sheet.hidden = true;
}

function pickAt(x, y, label) {
  if (M.nav) return;
  if (!label) {
    const u = upp(); let best = null, bd = 30 * u;
    for (const p of M.map.placeList) { if (M.view.z < PLACE_MINZ[p.t]) continue; const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = p; } }
    if (!best && M.world) for (const p of M.world.cities) { if (M.view.z < cityMinZ(p)) continue; const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = p; } }
    if (best) { x = best.x; y = best.y; label = best.name; } else label = 'Dropped pin';
  }
  clearRoute(); M.dest = null; M.pick = { x, y, label }; renderSheet(); draw();
}

/* ---------- search ---------- */
function search(q) {
  const box = $('map-results'); box.textContent = ''; q = q.trim().toLowerCase(); if (q.length < 2 || !M.map) { box.hidden = true; return; }
  const hits = M.map.placeList.filter((p) => p.lower.includes(q)).sort((a, b) => (b.lower.startsWith(q) - a.lower.startsWith(q)) || (PLACE_RANK[a.t] - PLACE_RANK[b.t])).slice(0, 12);
  if (M.world && hits.length < 12) {   // then countries and cities of the world
    const rank = (a, b) => (b.lower.startsWith(q) - a.lower.startsWith(q)) || (a.rank - b.rank);
    for (const p of [...M.world.countries.filter((c) => c.lower.includes(q)).sort(rank), ...M.world.cities.filter((c) => c.lower.includes(q) && !inDetail(c)).sort(rank)].slice(0, 12 - hits.length)) hits.push(p);
  }
  for (const p of hits) {
    const li = document.createElement('li'); li.textContent = p.name; const sm = document.createElement('small'); sm.textContent = p.kind === 'country' ? 'country' : p.kind ? (p.cap ? 'capital · ' : 'city · ') + p.country : PLACE_TYPES[p.t].replace('_', ' '); li.append(sm);
    li.onclick = () => { box.hidden = true; $('map-search').value = p.name; $('map-search').blur(); M.follow = false; M.view.cx = p.x; M.view.cy = p.y; M.view.z = p.kind === 'country' ? 5 : p.kind ? 9 : Math.max(M.view.z, p.t <= 1 ? 13 : 15.5); pickAt(p.x, p.y, p.name); };
    box.append(li);
  }
  if (!hits.length) { const li = document.createElement('li'); li.textContent = 'No place with that name on this map'; li.className = 'none'; box.append(li); }
  box.hidden = false;
}

/* ---------- touch ---------- */
function wireCanvas() {
  const c = $('map-canvas'); const pts = new Map(); let moved = 0, downAt = 0, pinch = 0;
  const zoomAt = (sx, sy, dz) => { const before = fromS(sx, sy); M.view.z = Math.min(19, Math.max(1.5, M.view.z + dz)); const after = fromS(sx, sy); M.view.cx += before.x - after.x; M.view.cy += before.y - after.y; draw(); };
  const local = (e) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  c.addEventListener('pointerdown', (e) => { c.setPointerCapture(e.pointerId); pts.set(e.pointerId, local(e)); if (pts.size === 1) { moved = 0; downAt = Date.now(); } pinch = 0; });
  c.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return; const prev = pts.get(e.pointerId), cur = local(e); pts.set(e.pointerId, cur);
    if (pts.size === 1) { const dx = cur.x - prev.x, dy = cur.y - prev.y; moved += Math.abs(dx) + Math.abs(dy); if (moved > 6) { M.follow = false; M.view.cx -= dx * upp(); M.view.cy -= dy * upp(); draw(); } }
    else if (pts.size === 2) { const [a, b] = [...pts.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y); if (pinch) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, Math.log2(d / pinch)); pinch = d; moved = 99; }
  });
  const up = (e) => { if (!pts.has(e.pointerId)) return; const p = pts.get(e.pointerId); pts.delete(e.pointerId); pinch = 0; if (!pts.size && moved <= 6 && Date.now() - downAt < 500 && M.map) { const w = fromS(p.x, p.y); pickAt(w.x, w.y); } };
  c.addEventListener('pointerup', up); c.addEventListener('pointercancel', (e) => { pts.delete(e.pointerId); pinch = 0; });
  c.addEventListener('wheel', (e) => { e.preventDefault(); const p = local(e); zoomAt(p.x, p.y, -e.deltaY / 300); }, { passive: false });
  $('map-zoom-in').onclick = () => zoomAt(M.w / 2, M.h / 2, 1); $('map-zoom-out').onclick = () => zoomAt(M.w / 2, M.h / 2, -1);
  $('map-locate').onclick = () => { ensureGps(); if (M.gps) { M.follow = true; M.view.cx = M.gps.x; M.view.cy = M.gps.y; if (M.view.z < 15) M.view.z = 16; draw(); } else { M.wantLocate = true; msg('Looking for GPS… This can take a minute outdoors with no data.'); } };
  $('map-search').oninput = (e) => search(e.target.value);
  new ResizeObserver(resize).observe($('map-wrap'));
}

export async function initMaps(root) {
  M.root = root; wireCanvas();
  const onFile = async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) await importMap(f); };
  $('map-file').onchange = onFile; $('map-file-2').onchange = onFile;
  $('map-delete').onclick = () => { if (confirm('Delete the map from this device?')) deleteMap(); };
  let ok = false; try { ok = await loadStored(); } catch (e) { console.warn('stored map unreadable', e); }
  let off = false; try { off = !!localStorage.getItem('noBuiltInMap'); } catch {}
  if (!ok && NATIVE && !off) ok = await useBuiltIn();
  if (!ok) showWorld();
  $('map-get').onclick = () => { try { localStorage.removeItem('noBuiltInMap'); } catch {} return NATIVE ? useBuiltIn().then(renderMapInfo) : getBuiltIn(); };
  loadWorld();
  renderMapInfo();
}
M.api = { makeRoute, nearestNode, pickAt, directions, startNav, endNav, paint };
export const mapShown = () => resize();
