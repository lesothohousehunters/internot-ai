// Internot AI — offline maps, routing and spoken navigation.
// The map is one file on the device. Position comes from the GPS chip. No network is used.
import { decodeImap, lonToX, latToY, PLACE_TYPES, RIVER } from './osmpbf.js';

const $ = (id) => document.getElementById(id);
const TWO32 = 4294967296, EARTH = 40075016.686;
const MAP_FILE = 'map.imap';
const SPEED = [100, 90, 80, 60, 50, 40, 30, 20, 20];            // km/h by road class
const ROAD_MINZ = [4.5, 4.5, 6, 8.5, 10.5, 12, 13, 14.5, 13.5];       // zoom at which each class appears
const ROAD_W = [5, 5, 4.5, 4, 3.4, 3, 2.6, 1.6, 1.3];
const ROAD_COL = ['#d97757', '#d97757', '#e39a7d', '#eebf9d', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#b7a685'];
const PLACE_MINZ = [0, 7, 10.5, 12.5, 12.5, 13.5, 14, 14, 14, 14.5, 15, 15, 15, 15];
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
const xToLon = (x) => x / TWO32 * 360 - 180, yToLat = (y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / TWO32))) * 180 / Math.PI;
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
const TTS = NATIVE ? window.capacitorExports?.registerPlugin?.('TextToSpeech') : null;
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

/* ---------- satellite pictures ---------- */
// Built in: the whole world from far out, and Lesotho closer in. Anything else is fetched when there is
// internet and kept on the phone, so places you have looked at once stay visible offline.
const SAT = { tiles: new Map(), local: null, remoteMax: 14, url: (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2016_3857/default/g/${z}/${y}/${x}.jpg` };
const SAT_CREDIT = 'Sentinel-2 cloudless – s2maps.eu by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016 & 2017)';
async function satInit() { try { const r = await fetch('./sat/index.json'); if (r.ok) { SAT.local = await r.json(); if (M.sat) draw(); } } catch {} }
function satLocal(z, x, y) {
  const L = SAT.local; if (!L) return false; if (z <= L.world) return true; if (z > L.max) return false; const n = 2 ** z, t = (v) => Math.floor(v / TWO32 * n);
  return x >= t(lonToX(L.box[0])) && x <= t(lonToX(L.box[2])) && y >= t(latToY(L.box[3])) && y <= t(latToY(L.box[1]));
}
const loadImg = (src) => new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = src; });
async function loadRemote(url) {
  let cache = null; try { cache = await caches.open('internot-sat'); const hit = await cache.match(url); if (hit) return await createImageBitmap(await hit.blob()); } catch {}
  if (!navigator.onLine) throw new Error('offline');
  const r = await fetch(url); if (!r.ok) throw new Error('no picture'); cache?.put(url, r.clone()).catch(() => {}); return createImageBitmap(await r.blob());
}
function satTile(z, x, y) {
  const key = z + '/' + x + '/' + y; let t = SAT.tiles.get(key);
  if (t) {
    if (t.state === 'missing' && navigator.onLine && Date.now() - t.at > 20000 && !satLocal(z, x, y)) SAT.tiles.delete(key);
    else { if (t.img) { SAT.tiles.delete(key); SAT.tiles.set(key, t); } return t; }
  }
  t = { state: 'loading', img: null, at: Date.now() }; SAT.tiles.set(key, t);
  const done = (img) => { t.img = img; t.state = img ? 'ready' : 'missing'; t.at = Date.now(); if (img && M.sat) draw();
    if (SAT.tiles.size > 240) for (const [k, v] of SAT.tiles) { if (SAT.tiles.size <= 180) break; if (v.state !== 'loading') { v.img?.close?.(); SAT.tiles.delete(k); } } };
  (satLocal(z, x, y) ? loadImg(`./sat/${z}/${x}/${y}.jpg`) : loadRemote(SAT.url(z, x, y))).then(done, () => done(null));
  return t;
}
function paintSat(ctx, u, z, ox, oy, x0, y0, x1, y1) {
  const zt = Math.max(0, Math.min(SAT.remoteMax, Math.round(z + 0.2))), n = 2 ** zt, span = TWO32 / n, px = span / u;
  const ax = Math.max(0, Math.floor(x0 / span)), bx = Math.min(n - 1, Math.floor(x1 / span)), ay = Math.max(0, Math.floor(y0 / span)), by = Math.min(n - 1, Math.floor(y1 / span));
  for (let ty = ay; ty <= by; ty++) for (let tx = ax; tx <= bx; tx++) {
    const dx = tx * px + ox, dy = ty * px + oy; const t = satTile(zt, tx, ty);
    if (t.img) { ctx.drawImage(t.img, dx, dy, px + 0.6, px + 0.6); continue; }
    for (let up = 1; up <= 9 && zt - up >= 0; up++) {   // until it arrives, show the nearest wider picture
      const p = satTile(zt - up, tx >> up, ty >> up); if (!p.img) continue;
      const k = 2 ** up, s = p.img.width / k; ctx.drawImage(p.img, (tx % k) * s, (ty % k) * s, s, s, dx, dy, px + 0.6, px + 0.6); break;
    }
  }
}
function setSat(on) {
  M.sat = on; try { localStorage.setItem('mapSat', on ? '1' : ''); } catch {}
  $('map-layer').textContent = on ? 'Map' : 'Sat'; $('map-layer').setAttribute('aria-label', on ? 'Show the street map' : 'Show satellite pictures');
  $('map-attrib').textContent = '© OpenStreetMap contributors · Natural Earth' + (on ? ' · ' + SAT_CREDIT : '');
  if (on && !navigator.onLine && M.view.z > (SAT.local ? SAT.local.max : 0) + 1.5) msg('Offline, satellite pictures are sharp for Lesotho and for places you looked at while online.');
  draw();
}

/* ---------- moving the view smoothly ---------- */
function flyTo(x, y, z, ms = 420) {
  cancelAnimationFrame(M.anim); const a = { ...M.view }, t0 = performance.now();
  const step = (now) => { const t = Math.min(1, (now - t0) / ms), e = 1 - (1 - t) ** 3; M.view.cx = a.cx + (x - a.cx) * e; M.view.cy = a.cy + (y - a.cy) * e; M.view.z = a.z + (z - a.z) * e; paint(); if (t < 1) M.anim = requestAnimationFrame(step); };
  M.anim = requestAnimationFrame(step);
}

/* ---------- a location pasted from WhatsApp, Google Maps or anywhere else ---------- */
export function parseLocation(text) {
  const t = String(text || '').trim(); if (t.length < 5) return null; const N = '(-?\\d{1,3}(?:\\.\\d+)?)';
  const ok = (lat, lon) => (Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (lat || lon) ? { lat, lon } : null);
  let m = new RegExp(`(?:[?&](?:q|query|ll|sll|daddr|destination|center|loc|coordinate)=(?:loc:)?|geo:|/@|/place/|/search/)${N}(?:,|%2C)\\+?\\s*${N}`, 'gi'); for (const g of t.matchAll(m)) { const r = ok(+g[1], +g[2]); if (r) return r; }
  m = /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/.exec(t); if (m) return ok(+m[1], +m[2]);
  m = /[?&]mlat=(-?\d+\.\d+)&mlon=(-?\d+\.\d+)/.exec(t) || /#map=\d+\/(-?\d+\.\d+)\/(-?\d+\.\d+)/.exec(t); if (m) return ok(+m[1], +m[2]);
  m = /(\d{1,2}(?:\.\d+)?)\s*°?\s*([NS])[\s,;]+(\d{1,3}(?:\.\d+)?)\s*°?\s*([EW])/i.exec(t); if (m) return ok(+m[1] * (/s/i.test(m[2]) ? -1 : 1), +m[3] * (/w/i.test(m[4]) ? -1 : 1));
  if (/goo\.gl|maps\.app/i.test(t)) return { short: true };
  // degrees, minutes and seconds, e.g. 29°18'36.0"S 27°29'00.0"E
  const dms = /(\d{1,3})\s*[°º]\s*(\d{1,2})\s*['′’]\s*(?:(\d{1,2}(?:\.\d+)?)\s*(?:["″”]|'')?)?\s*([NSEW])/gi; const parts = [...t.matchAll(dms)];
  if (parts.length >= 2) {
    const v = (p) => (+p[1] + +p[2] / 60 + (+p[3] || 0) / 3600) * (/[SW]/i.test(p[4]) ? -1 : 1);
    const la = parts.find((p) => /[NS]/i.test(p[4])), lo = parts.find((p) => /[EW]/i.test(p[4])); if (la && lo) return ok(v(la), v(lo));
  }
  m = /^\s*(-?\d{1,2}\.\d{2,})\s*[,;\s]\s*(-?\d{1,3}\.\d{2,})\s*$/.exec(t); if (m) return ok(+m[1], +m[2]);   // just two numbers
  m = /(?:^|[^\d.\-])(-?\d{1,2}\.\d{3,})\s*[,;\s]\s*(-?\d{1,3}\.\d{3,})(?![\d.])/.exec(t); if (m) return ok(+m[1], +m[2]);
  return null;
}
function goLocation(loc) {
  const x = lonToX(loc.lon), y = latToY(loc.lat); M.follow = false; $('map-results').hidden = true; $('map-search').blur();
  flyTo(x, y, Math.max(M.view.z, 15)); pickAt(x, y, 'Pasted location');
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0'; document.body.append(ta); ta.select(); let ok = false; try { ok = document.execCommand('copy'); } catch {} ta.remove(); return ok;
}

/* ---------- roads: drawn once into small square pictures (tiles), then reused while you move ---------- */
// Re-drawing every road on every frame is too slow on low-cost phones; placing ready pictures is fast.
const TILE = 256;
const RT = { cache: new Map(), map: null, res: Math.min(1.5, window.devicePixelRatio || 1), max: 72 };
function wayGrid(map) {
  const G = 128, [bx0, by0, bx1, by1] = map.bbox, cw = Math.max(1, (bx1 - bx0 + 1) / G), ch = Math.max(1, (by1 - by0 + 1) / G), { box, W } = map;
  const span = (w) => [Math.max(0, Math.min(G - 1, Math.floor((box[w * 4] - bx0) / cw))), Math.max(0, Math.min(G - 1, Math.floor((box[w * 4 + 2] - bx0) / cw))), Math.max(0, Math.min(G - 1, Math.floor((box[w * 4 + 1] - by0) / ch))), Math.max(0, Math.min(G - 1, Math.floor((box[w * 4 + 3] - by0) / ch)))];
  const start = new Uint32Array(G * G + 1);
  for (let w = 0; w < W; w++) { const [a, b, c, d] = span(w); for (let y = c; y <= d; y++) for (let x = a; x <= b; x++) start[y * G + x + 1]++; }
  for (let i = 0; i < G * G; i++) start[i + 1] += start[i];
  const items = new Uint32Array(start[G * G]), fill = start.slice(0, G * G);
  for (let w = 0; w < W; w++) { const [a, b, c, d] = span(w); for (let y = c; y <= d; y++) for (let x = a; x <= b; x++) items[fill[y * G + x]++] = w; }
  map.wg = { G, cw, ch, start, items, stamp: new Uint32Array(W), n: 0 };
}
function forWays(map, qx0, qy0, qx1, qy1, fn) {
  const g = map.wg, [bx0, by0] = map.bbox, G = g.G; if (++g.n === 0xffffffff) { g.stamp.fill(0); g.n = 1; }
  const a = Math.max(0, Math.floor((qx0 - bx0) / g.cw)), b = Math.min(G - 1, Math.floor((qx1 - bx0) / g.cw)), c = Math.max(0, Math.floor((qy0 - by0) / g.ch)), d = Math.min(G - 1, Math.floor((qy1 - by0) / g.ch));
  for (let y = c; y <= d; y++) for (let x = a; x <= b; x++) { const cell = y * G + x; for (let i = g.start[cell]; i < g.start[cell + 1]; i++) { const w = g.items[i]; if (g.stamp[w] !== g.n) { g.stamp[w] = g.n; fn(w); } } }
}
function renderTile(Z, tx, ty, sat) {
  const map = M.map, span = TWO32 / 2 ** Z, tu = span / TILE, X0 = tx * span, Y0 = ty * span, r = RT.res, { X, Y, wayStart, wayNodes, wayClass, box } = map;
  const cv = document.createElement('canvas'); cv.width = cv.height = Math.round(TILE * r); const g = cv.getContext('2d'); g.setTransform(r, 0, 0, r, 0, 0);
  const m = 14 * tu, paths = [], minSize = 1.5 * tu;
  forWays(map, X0 - m, Y0 - m, X0 + span + m, Y0 + span + m, (w) => {
    const cls = wayClass[w]; const slot = cls >= 20 ? 9 : cls;
    if (cls < 20 && Z + 0.25 < ROAD_MINZ[cls]) return; if (slot === 9 && (sat || Z < 9)) return;
    const b = w * 4; if (box[b] > X0 + span + m || box[b + 2] < X0 - m || box[b + 1] > Y0 + span + m || box[b + 3] < Y0 - m) return;
    if (cls > 3 && box[b + 2] - box[b] < minSize && box[b + 3] - box[b + 1] < minSize) return;
    const p = (paths[slot] ||= new Path2D()); let lx = 0, ly = 0, px = 0, py = 0, pen = false; const end = wayStart[w + 1], L = -64, R = TILE + 64;
    for (let i = wayStart[w]; i < end; i++) {
      const n = wayNodes[i]; const sx = (X[n] - X0) / tu, sy = (Y[n] - Y0) / tu;
      if (i === wayStart[w]) { px = sx; py = sy; continue; }
      if ((px < L && sx < L) || (px > R && sx > R) || (py < L && sy < L) || (py > R && sy > R)) { pen = false; px = sx; py = sy; continue; }   // this piece is outside the tile
      if (!pen) { p.moveTo(px, py); lx = px; ly = py; pen = true; }
      if (i === end - 1 || Math.abs(sx - lx) + Math.abs(sy - ly) > 1.2) { p.lineTo(sx, sy); lx = sx; ly = sy; }
      px = sx; py = sy;
    }
  });
  const k = Math.min(2.4, Math.max(0.28, 0.28 + (Z - 8) * 0.16)) * (sat ? 0.7 : 1), edge = k < 0.6 ? 0.9 : 1.6;
  g.lineCap = 'round'; g.lineJoin = 'round';
  if (paths[9]) { g.strokeStyle = '#9fc4e4'; g.lineWidth = 2.2 * k; g.stroke(paths[9]); }
  for (let cls = 7; cls >= 0; cls--) {          // casings first, so junctions join cleanly
    if (!paths[cls]) continue; g.strokeStyle = sat ? 'rgba(0,0,0,.45)' : cls <= 3 ? '#b9623f' : '#cdc6b4'; g.lineWidth = ROAD_W[cls] * k + edge; g.stroke(paths[cls]);
  }
  for (let cls = 8; cls >= 0; cls--) {
    if (!paths[cls]) continue; g.strokeStyle = !sat ? ROAD_COL[cls] : cls <= 3 ? '#ffd27a' : 'rgba(255,255,255,.85)'; g.lineWidth = ROAD_W[cls] * k;
    g.setLineDash(cls === 8 ? [5, 4] : []); g.stroke(paths[cls]);
  }
  return cv;
}
function paintRoads(ctx, u, z, x0, y0, x1, y1, sat) {
  const map = M.map; if (!map.W) return;
  if (RT.map !== map) { RT.cache.clear(); RT.map = map; wayGrid(map); }
  const Z = Math.max(0, Math.min(18, Math.round(z))), span = TWO32 / 2 ** Z, px = span / u, [bx0, by0, bx1, by1] = map.bbox;
  const ax = Math.floor(Math.max(x0, bx0) / span), bx = Math.floor(Math.min(x1, bx1) / span), ay = Math.floor(Math.max(y0, by0) / span), by = Math.floor(Math.min(y1, by1) / span);
  if (ax > bx || ay > by) return;
  const ox = M.w / 2 - M.view.cx / u, oy = M.h / 2 - M.view.cy / u, S = sat ? 1 : 0, t0 = performance.now(), cx = M.view.cx / span, cy = M.view.cy / span;
  const list = [];
  for (let ty = ay; ty <= by; ty++) for (let tx = ax; tx <= bx; tx++) list.push([tx, ty, (tx + 0.5 - cx) ** 2 + (ty + 0.5 - cy) ** 2]);
  list.sort((a, b) => a[2] - b[2]);   // the middle of the screen first
  let made = 0, more = false;
  for (const [tx, ty] of list) {
    const key = Z + '/' + tx + '/' + ty + '/' + S; let t = RT.cache.get(key);
    if (t) { RT.cache.delete(key); RT.cache.set(key, t); }
    else if (made === 0 || performance.now() - t0 < 10) { t = renderTile(Z, tx, ty, sat); made++; RT.cache.set(key, t); if (RT.cache.size > RT.max) RT.cache.delete(RT.cache.keys().next().value); }
    else more = true;
    const dx = Math.round(tx * px + ox), dy = Math.round(ty * px + oy), dw = Math.round((tx + 1) * px + ox) - dx, dh = Math.round((ty + 1) * px + oy) - dy;
    if (t) { ctx.drawImage(t, dx, dy, dw, dh); continue; }
    for (let up = 1; up <= 4 && Z - up >= 0; up++) {   // until it is ready, stretch a wider tile over the gap
      const p = RT.cache.get((Z - up) + '/' + (tx >> up) + '/' + (ty >> up) + '/' + S); if (!p) continue;
      const k = 2 ** up, s = p.width / k; ctx.drawImage(p, (tx % k) * s, (ty % k) * s, s, s, dx, dy, dw, dh); break;
    }
  }
  if (more) draw();
}

function paint() {
  const map = M.map, c = $('map-canvas'); if (!map || !M.w) return;
  const ctx = c.getContext('2d');
  // Start every frame from a blank, fully reset canvas (some phones otherwise keep the last picture underneath).
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.clearRect(0, 0, c.width, c.height);
  ctx.setTransform(M.dpr, 0, 0, M.dpr, 0, 0);
  const u = upp(), z = M.view.z, { X, Y } = map;
  const x0 = M.view.cx - M.w / 2 * u, x1 = M.view.cx + M.w / 2 * u, y0 = M.view.cy - M.h / 2 * u, y1 = M.view.cy + M.h / 2 * u;
  const ox = M.w / 2 - M.view.cx / u, oy = M.h / 2 - M.view.cy / u;
  const wd = M.world, sat = M.sat, sea = wd && z < 9 && !sat;
  ctx.fillStyle = sat ? '#1c2a33' : sea ? '#d3e3ee' : '#f3f0e7'; ctx.fillRect(0, 0, M.w, M.h);
  if (sat) paintSat(ctx, u, z, ox, oy, x0, y0, x1, y1);
  const halo = sat ? 'rgba(0,0,0,.72)' : 'rgba(243,240,231,.92)';
  if (wd && z < 10) {   // land and country borders, drawn from one cached outline (not needed at street level)
    const s = TWO32 / wd.grid / u; ctx.save(); ctx.setTransform(M.dpr * s, 0, 0, M.dpr * s, M.dpr * ox, M.dpr * oy);
    if (sea) { ctx.fillStyle = '#f3f0e7'; ctx.fill(wd.path); } ctx.lineWidth = 1.1 / s; ctx.strokeStyle = sat ? 'rgba(255,255,255,.6)' : '#bfb39a'; ctx.stroke(wd.path); ctx.restore();
  }
  paintRoads(ctx, u, z, x0, y0, x1, y1, sat);

  if (M.route) {   // pieces far off the screen are left out: huge numbers upset some phones' graphics chips
    const r = M.route; ctx.beginPath(); let px = 0, py = 0, pen = false; const L = -400, R = M.w + 400, T = -400, B = M.h + 400;
    for (let i = 0; i < r.nodes.length; i++) {
      const n = r.nodes[i]; const sx = X[n] / u + ox, sy = Y[n] / u + oy;
      if (!i) { px = sx; py = sy; continue; }
      if ((px < L && sx < L) || (px > R && sx > R) || (py < T && sy < T) || (py > B && sy > B)) pen = false;
      else { if (!pen) ctx.moveTo(px, py); ctx.lineTo(sx, sy); pen = true; }
      px = sx; py = sy;
    }
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
    ctx.strokeStyle = halo; ctx.lineWidth = 4; ctx.strokeText(p.name, tx, sy);
    ctx.fillStyle = sat ? '#fff' : poi ? '#7a4a36' : '#2b2a27'; ctx.fillText(p.name, tx, sy);
  }

  if (wd) {
    const label = (p, font, col) => {
      if (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) return; const sx = p.x / u + ox, sy = p.y / u + oy; ctx.font = font;
      const tw = ctx.measureText(p.name).width; const city = p.kind === 'city'; const tx = city ? sx + 7 : sx - tw / 2; const rect = [tx - 3, sy - 9, tx + tw + 3, sy + 9];
      if (used.some((q) => rect[0] < q[2] && rect[2] > q[0] && rect[1] < q[3] && rect[3] > q[1])) return; used.push(rect);
      if (city) { ctx.fillStyle = p.cap ? '#c15f3c' : '#6b6860'; ctx.beginPath(); ctx.arc(sx, sy, p.cap ? 3.5 : 2.5, 0, 7); ctx.fill(); }
      ctx.strokeStyle = halo; ctx.lineWidth = 4; ctx.strokeText(p.name, tx, sy); ctx.fillStyle = sat ? '#fff' : col; ctx.fillText(p.name, tx, sy);
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
    if (M.gps.heading != null) {   // a small arrow showing which way you are moving
      ctx.save(); ctx.translate(sx, sy); ctx.rotate(M.gps.heading); ctx.beginPath(); ctx.moveTo(0, -19); ctx.lineTo(7, -9); ctx.lineTo(-7, -9); ctx.closePath(); ctx.fillStyle = '#2f6fde'; ctx.fill(); ctx.restore();
    }
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
function hush() { try { if (TTS) TTS.stop().catch(() => {}); else speechSynthesis?.cancel(); } catch {} }
function speak(text) {
  M.spoken.push(text); if (M.mute) return;
  if (TTS) {   // Android app: the phone's own text-to-speech voice, which works with no internet
    TTS.speak({ text, lang: 'en-US', rate: 0.95, queueStrategy: 1 }).catch((e) => { console.warn('voice failed', e); if (!M.voiceWarned) { M.voiceWarned = true; msg('Voice is not available. Switch on a text-to-speech voice in the phone settings.'); } });
    return;
  }
  if (!('speechSynthesis' in window)) return;
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
  if (!M.route) return; if (M.route.total < 40) { msg('You are already at this place.'); return; } ensureGps(); msg('');
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
  if (M.nav) { sheet.hidden = false; row.append(button('End navigation', 'danger', () => endNav(false)), button(M.mute ? 'Voice off' : 'Voice on', '', () => { M.mute = !M.mute; if (M.mute) hush(); renderSheet(); }));
    if (!M.follow) row.append(button('Re-centre', 'primary', () => { M.follow = true; if (M.gps) flyTo(M.gps.x, M.gps.y, Math.max(M.view.z, 16)); renderSheet(); }));
    sheet.append(row); return; }
  if (M.route) {
    const r = M.route; title.textContent = `${fmtDist(r.total)} · ${fmtTime(r.secs)}`;
    row.append(button('Start', 'primary', startNav), button('Clear', '', () => { clearRoute(); M.dest = null; M.start = null; M.pick = null; renderSheet(); draw(); }));
    const list = document.createElement('ol'); list.className = 'steps';
    r.steps.forEach((st, i) => { const li = document.createElement('li'); li.textContent = st.text; if (i < r.steps.length - 1) { const sm = document.createElement('small'); sm.textContent = fmtDist(r.steps[i + 1].s - st.s); li.append(sm); } list.append(li); });
    const det = document.createElement('details'); const sum = document.createElement('summary'); sum.textContent = `${r.steps.length} steps`; det.append(sum, list);
    sheet.append(title, row, det); sheet.hidden = false; return;
  }
  if (M.pick) {
    title.textContent = M.pick.label; const lat = yToLat(M.pick.y).toFixed(5), lon = xToLon(M.pick.x).toFixed(5);
    const sub = document.createElement('small'); sub.className = 'sheet-sub'; sub.textContent = `${lat}, ${lon}`; title.append(sub);
    row.append(button('Directions to here', 'primary', () => { M.dest = { x: M.pick.x, y: M.pick.y }; directions(); }),
      button('Start from here', '', () => { M.start = { x: M.pick.x, y: M.pick.y }; M.pick = null; msg('Start point set. Now tap your destination.'); if (M.dest) directions(); else { renderSheet(); draw(); } }),
      button('Copy location', '', async () => msg((await copyText(`https://maps.google.com/?q=${lat},${lon}`)) ? 'Location copied. Paste it into WhatsApp or an SMS.' : 'Could not copy on this phone.')),
      button('✕', '', () => { M.pick = null; renderSheet(); draw(); }));
    sheet.append(title, row); sheet.hidden = false; return;
  }
  sheet.hidden = true;
}

function pickAt(x, y, label) {
  if (M.nav) return;
  if (!label) {
    const u = upp(); let best = null, bd = 30 * u;
    if (M.gps && Math.hypot(M.gps.x - x, M.gps.y - y) < 24 * u) best = { x: M.gps.x, y: M.gps.y, name: 'My location' }; else
    for (const p of M.map.placeList) { if (M.view.z < PLACE_MINZ[p.t]) continue; const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = p; } }
    if (!best && M.world) for (const p of M.world.cities) { if (M.view.z < cityMinZ(p)) continue; const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = p; } }
    if (best) { x = best.x; y = best.y; label = best.name; } else label = 'Dropped pin';
  }
  clearRoute(); M.dest = null; M.pick = { x, y, label }; renderSheet(); draw();
}

/* ---------- search ---------- */
function search(q) {
  const box = $('map-results'); box.textContent = ''; const loc = parseLocation(q); q = q.trim().toLowerCase(); if (q.length < 2 || !M.map) { box.hidden = true; return; }
  if (loc) {
    const li = document.createElement('li'); box.append(li); box.hidden = false;
    if (loc.short) { li.className = 'none'; li.textContent = 'This is a short link, which only opens with internet. Ask for the location pin or the coordinates instead.'; return; }
    li.textContent = 'Go to this location'; const sm = document.createElement('small'); sm.textContent = `${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}`; li.append(sm); li.onclick = () => goLocation(loc); return;
  }
  const hits = M.map.placeList.filter((p) => p.lower.includes(q)).sort((a, b) => (b.lower.startsWith(q) - a.lower.startsWith(q)) || (PLACE_RANK[a.t] - PLACE_RANK[b.t])).slice(0, 12);
  if (M.world && hits.length < 12) {   // then countries and cities of the world
    const rank = (a, b) => (b.lower.startsWith(q) - a.lower.startsWith(q)) || (a.rank - b.rank);
    for (const p of [...M.world.countries.filter((c) => c.lower.includes(q)).sort(rank), ...M.world.cities.filter((c) => c.lower.includes(q) && !inDetail(c)).sort(rank)].slice(0, 12 - hits.length)) hits.push(p);
  }
  for (const p of hits) {
    const li = document.createElement('li'); li.textContent = p.name; const sm = document.createElement('small'); sm.textContent = p.kind === 'country' ? 'country' : p.kind ? (p.cap ? 'capital · ' : 'city · ') + p.country : PLACE_TYPES[p.t].replace('_', ' '); li.append(sm);
    li.onclick = () => { box.hidden = true; $('map-search').value = p.name; $('map-search').blur(); M.follow = false; flyTo(p.x, p.y, p.kind === 'country' ? 5 : p.kind ? 9 : Math.max(M.view.z, p.t <= 1 ? 13 : 15.5)); pickAt(p.x, p.y, p.name); };
    box.append(li);
  }
  if (!hits.length) { const li = document.createElement('li'); li.textContent = 'No place with that name on this map'; li.className = 'none'; box.append(li); }
  box.hidden = false;
}

/* ---------- touch ---------- */
function wireCanvas() {
  const c = $('map-canvas'); const pts = new Map(); let moved = 0, downAt = 0, pinch = 0, mid = null, lastTap = 0, tapTimer = 0, vel = { x: 0, y: 0, t: 0 }, fling = 0;
  const clampZ = (z) => Math.min(19, Math.max(1.5, z));
  const anchor = (sx, sy, w) => { M.view.cx = w.x - (sx - M.w / 2) * upp(); M.view.cy = w.y - (sy - M.h / 2) * upp(); };
  const zoomAt = (sx, sy, dz) => { const w = fromS(sx, sy); M.view.z = clampZ(M.view.z + dz); anchor(sx, sy, w); draw(); };
  const glideZoom = (sx, sy, dz) => {   // zoom smoothly, keeping the touched point where it is
    const w = fromS(sx, sy), z0 = M.view.z, z1 = clampZ(z0 + dz), t0 = performance.now(); cancelAnimationFrame(M.anim);
    const step = (now) => { const t = Math.min(1, (now - t0) / 220); M.view.z = z0 + (z1 - z0) * (1 - (1 - t) ** 3); anchor(sx, sy, w); paint(); if (t < 1) M.anim = requestAnimationFrame(step); };
    M.anim = requestAnimationFrame(step);
  };
  const unfollow = () => { if (!M.follow) return; M.follow = false; $('map-locate').classList.remove('on'); if (M.nav) renderSheet(); };
  const local = (e) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  c.addEventListener('pointerdown', (e) => {
    cancelAnimationFrame(M.anim); cancelAnimationFrame(fling); try { c.setPointerCapture(e.pointerId); } catch {} pts.set(e.pointerId, local(e));
    if (pts.size === 1) { moved = 0; downAt = Date.now(); vel = { x: 0, y: 0, t: performance.now() }; } pinch = 0; mid = null;
  });
  c.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return; const prev = pts.get(e.pointerId), cur = local(e); pts.set(e.pointerId, cur);
    if (pts.size === 1) {
      const dx = cur.x - prev.x, dy = cur.y - prev.y; moved += Math.abs(dx) + Math.abs(dy); if (moved <= 6) return;
      unfollow(); M.view.cx -= dx * upp(); M.view.cy -= dy * upp(); const now = performance.now(), dt = Math.max(1, now - vel.t);
      vel = { x: 0.6 * dx / dt + 0.4 * vel.x, y: 0.6 * dy / dt + 0.4 * vel.y, t: now }; draw();
    } else if (pts.size === 2) {   // two fingers: zoom around the point between them, and move with it
      const [a, b] = [...pts.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y), m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (pinch && mid) { M.view.cx -= (m.x - mid.x) * upp(); M.view.cy -= (m.y - mid.y) * upp(); zoomAt(m.x, m.y, Math.log2(d / pinch)); }
      pinch = d; mid = m; moved = 9999; unfollow();
    }
  });
  const up = (e) => {
    if (!pts.has(e.pointerId)) return; const p = pts.get(e.pointerId); pts.delete(e.pointerId); pinch = 0; mid = null; if (pts.size) return;
    if (moved > 6) {   // let the map keep sliding a little after a quick swipe
      let vx = vel.x, vy = vel.y, last = performance.now(); if (moved >= 9999 || last - vel.t > 90 || Math.hypot(vx, vy) < 0.25) return;
      const slide = (now) => { const dt = Math.min(40, now - last); last = now; M.view.cx -= vx * dt * upp(); M.view.cy -= vy * dt * upp(); const f = 0.995 ** dt; vx *= f; vy *= f; paint(); if (Math.hypot(vx, vy) > 0.03) fling = requestAnimationFrame(slide); };
      fling = requestAnimationFrame(slide); return;
    }
    if (!M.map) return; const now = Date.now();
    if (now - lastTap < 300) { clearTimeout(tapTimer); lastTap = 0; glideZoom(p.x, p.y, 1); return; }   // double tap: zoom in
    lastTap = now; const w = fromS(p.x, p.y); tapTimer = setTimeout(() => pickAt(w.x, w.y), 260);
  };
  c.addEventListener('pointerup', up); c.addEventListener('pointercancel', (e) => { pts.delete(e.pointerId); pinch = 0; mid = null; });
  c.addEventListener('wheel', (e) => { e.preventDefault(); const p = local(e); zoomAt(p.x, p.y, -e.deltaY / 300); }, { passive: false });
  $('map-zoom-in').onclick = () => glideZoom(M.w / 2, M.h / 2, 1); $('map-zoom-out').onclick = () => glideZoom(M.w / 2, M.h / 2, -1);
  $('map-locate').onclick = () => { ensureGps(); if (M.gps) { M.follow = true; $('map-locate').classList.add('on'); flyTo(M.gps.x, M.gps.y, Math.max(M.view.z, 16)); if (M.nav) renderSheet(); } else { M.wantLocate = true; msg('Looking for GPS… This can take a minute outdoors with no data.'); } };
  $('map-layer').onclick = () => setSat(!M.sat);
  $('map-paste').onclick = async () => {
    let t = ''; try { t = await navigator.clipboard.readText(); } catch { msg('Press and hold in the search box, then choose Paste.'); $('map-search').focus(); return; }
    $('map-search').value = t; const loc = parseLocation(t); if (loc && !loc.short) goLocation(loc); else { search(t); if (!loc) msg('No location was found in what you copied.'); }
  };
  $('map-search').addEventListener('paste', () => setTimeout(() => { const loc = parseLocation($('map-search').value); if (loc && !loc.short) goLocation(loc); }, 0));
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
  loadWorld(); satInit(); let sat = false; try { sat = !!localStorage.getItem('mapSat'); } catch {} if (sat) setSat(true);
  renderMapInfo();
}
M.api = { parseLocation, setSat, SAT, makeRoute, nearestNode, pickAt, directions, startNav, endNav, paint };
M.api.speakTest = async (text) => { if (!TTS) return { native: false, web: 'speechSynthesis' in window }; const l = await TTS.getSupportedLanguages().catch((e) => ({ error: String(e) })); const said = await Promise.race([TTS.speak({ text, lang: 'en-US' }).then(() => 'spoken', (e) => 'failed: ' + (e?.message || e)), new Promise((r) => setTimeout(() => r('timeout'), 9000))]); return { native: true, languages: l.languages ? l.languages.length : l, said }; };
export const mapShown = () => resize();
