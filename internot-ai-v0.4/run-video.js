// Run tab: 3D replay of an activity and the video made from it (all on the phone, no internet).
// The route is drawn over the roads of the offline map, or over the offline satellite pictures; photos taken on the way
// pop up where they were taken; it opens with a title card and ends with the highlights.
import { R, settings, saveSettings, typeName, fmtKm, fmtClock, fmtPace, paceOrSpeed, paceUnit, privatePts, photoURL, shareFile, kcal } from './run.js';

const $ = (id) => document.getElementById(id);
const RAD = Math.PI / 180;
export const THEMES = {
  orange: { route: '#d97757', wall: '217,119,87', sky: ['#f6f3ea', '#e4ddcc'], ground: 'rgba(232,226,210,.95)', grid: 'rgba(120,110,90,.18)', road: 'rgba(120,110,92,.7)', major: 'rgba(217,119,87,.75)', hud: 'rgba(31,30,29,.84)', ink: '#1f1e1d', me: '#2f6fde' },
  blue: { route: '#2f6fde', wall: '47,111,222', sky: ['#eef4fb', '#d6e2f0'], ground: 'rgba(225,233,242,.95)', grid: 'rgba(60,90,130,.16)', road: 'rgba(80,100,130,.6)', major: 'rgba(47,111,222,.6)', hud: 'rgba(16,32,58,.86)', ink: '#10203a', me: '#d97757' },
  green: { route: '#2f8a46', wall: '47,138,70', sky: ['#eef6ec', '#d8e8d2'], ground: 'rgba(222,236,216,.95)', grid: 'rgba(60,110,60,.16)', road: 'rgba(80,110,80,.6)', major: 'rgba(47,138,70,.6)', hud: 'rgba(20,48,26,.86)', ink: '#14301a', me: '#d97757' },
  purple: { route: '#8a4fd1', wall: '138,79,209', sky: ['#f3eefb', '#e1d6f0'], ground: 'rgba(234,227,244,.95)', grid: 'rgba(100,70,140,.16)', road: 'rgba(110,90,140,.6)', major: 'rgba(138,79,209,.6)', hud: 'rgba(40,20,64,.86)', ink: '#281440', me: '#2f8a46' },
  night: { route: '#ffb547', wall: '255,181,71', sky: ['#10131c', '#1d2333'], ground: 'rgba(32,38,52,.96)', grid: 'rgba(255,255,255,.08)', road: 'rgba(200,210,230,.45)', major: 'rgba(255,181,71,.55)', hud: 'rgba(0,0,0,.62)', ink: '#f3f1ea', me: '#7fd1ff' },
};
export const SHAPES = { tall: [720, 1280], wide: [1280, 720], square: [960, 960] };
const INTRO = 2200, OUTRO = 3600, PHOTO = 2400;

/* ---------- the scene: metres east/north of the middle, height above the lowest point ---------- */
async function scene(run, a) {
  const keep = []; const shared = new Set(privatePts(a.clean)); a.clean.forEach((p, i) => { if (shared.has(p)) keep.push(i); });
  if (keep.length < 2) return null;
  const Pp = keep.map((i) => a.clean[i]); let la = 0, lo = 0; for (const p of Pp) { la += p[1]; lo += p[2]; } la /= Pp.length; lo /= Pp.length;
  const k = 111320 * Math.cos(la * RAD), M = 110540;
  const xy = Pp.map((p) => [(p[2] - lo) * k, (p[1] - la) * M]);
  let ext = 30; for (const [x, y] of xy) ext = Math.max(ext, Math.abs(x), Math.abs(y));
  const alt = a.alt ? keep.map((i) => a.alt[i]) : null, lowA = alt ? Math.min(...alt.filter((v) => v != null)) : 0, highA = alt ? Math.max(...alt.filter((v) => v != null)) : 0;
  const relief = alt ? Math.max(1, highA - lowA) : 0, ex = relief ? Math.min(8, Math.max(1.5, (ext * 0.35) / relief)) : 1;
  const z = keep.map((i, j) => (alt && alt[j] != null ? (alt[j] - lowA) * ex : 0));
  const G = ext * 1.25;
  let roads = [];
  try {
    const dl = G / M, dn = G / k;
    roads = (window.internotMap?.api?.roadsNear?.(la - dl, lo - dn, la + dl, lo + dn, 3000) || []).map((r) => ({ cls: r.cls, pts: r.pts.map(([y, x]) => [(x - lo) * k, (y - la) * M]) }));
  } catch {}
  // photos: placed at the nearest shared point of the route (a photo inside the privacy zone is left out)
  const photos = [];
  for (const ph of (run.photos || []).slice(0, 8)) {
    if (ph.lat == null) continue; let best = -1, bd = Infinity;
    Pp.forEach((p, j) => { const d = (p[1] - ph.lat) ** 2 + ((p[2] - ph.lon) * Math.cos(la * RAD)) ** 2; if (d < bd) { bd = d; best = j; } });
    if (best < 0 || Math.sqrt(bd) * 111320 > 300) continue;
    try { const u = await photoURL(ph.name); if (!u) continue; const img = await createImageBitmap(await (await fetch(u)).blob()); photos.push({ j: best, img, t: ph.t }); } catch {}
  }
  photos.sort((p, q) => p.j - q.j);
  return { run, a, keep, xy, z, ext, ex, G, la, lo, k, M, roads, photos, cum: keep.map((i) => a.cum[i]), tim: keep.map((i) => a.tim[i]), alt, type: run.type, start: run.start, records: run.records || [] };
}

/* ---------- satellite pictures under the route (from the offline pictures; nothing is downloaded when offline) ---------- */
const lon2x = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const lat2y = (lat, z) => ((1 - Math.log(Math.tan(lat * RAD) + 1 / Math.cos(lat * RAD)) / Math.PI) / 2) * 2 ** z;
const x2lon = (x, z) => (x / 2 ** z) * 360 - 180;
const y2lat = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z)));
async function satGround(S) {
  const api = window.internotMap?.api; if (!api?.satTile) return null;
  const { la, lo, k, M, G } = S, lat0 = la - G / M, lat1 = la + G / M, lon0 = lo - G / k, lon1 = lo + G / k;
  let z = Math.round(Math.log2((40075016.686 * Math.cos(la * RAD) * 4) / (2 * G))); z = Math.max(3, Math.min(16, z));
  const box = api.satLocalBox?.(), inside = box && lon0 >= box.box[0] && lon1 <= box.box[2] && lat0 >= box.box[1] && lat1 <= box.box[3];
  const maxZ = inside ? box.max : navigator.onLine ? 14 : box ? box.world : 4; z = Math.min(z, maxZ);
  let tx0, tx1, ty0, ty1;
  for (;;) { tx0 = Math.floor(lon2x(lon0, z)); tx1 = Math.floor(lon2x(lon1, z)); ty0 = Math.floor(lat2y(lat1, z)); ty1 = Math.floor(lat2y(lat0, z)); if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= 36 || z <= 3) break; z--; }
  const tiles = []; for (let x = tx0; x <= tx1; x++) for (let y = ty0; y <= ty1; y++) tiles.push([x, y, api.satTile(z, x, y)]);
  for (let i = 0; i < 40 && tiles.some(([, , t]) => t.state === 'loading'); i++) await new Promise((r) => setTimeout(r, 200));
  const TS = 1024, tex = document.createElement('canvas'); tex.width = tex.height = TS; const g = tex.getContext('2d'); let n = 0;
  g.fillStyle = '#7d8a6a'; g.fillRect(0, 0, TS, TS);
  for (const [x, y, t] of tiles) {
    if (!t.img) continue; n++;
    const a0 = x2lon(x, z), a1 = x2lon(x + 1, z), b1 = y2lat(y, z) / RAD, b0 = y2lat(y + 1, z) / RAD;
    const u0 = ((a0 - lon0) / (lon1 - lon0)) * TS, u1 = ((a1 - lon0) / (lon1 - lon0)) * TS, v0 = ((lat1 - b1) / (lat1 - lat0)) * TS, v1 = ((lat1 - b0) / (lat1 - lat0)) * TS;
    try { g.drawImage(t.img, u0, v0, u1 - u0 + 0.5, v1 - v0 + 0.5); } catch { n--; }
  }
  return n ? { tex, zoom: z, tiles: n, of: tiles.length } : null;
}
function texTri(g, img, s, t) {   // draws one triangle of the picture, stretched to the screen triangle s
  const [[x0, y0], [x1, y1], [x2, y2]] = s, [[u0, v0], [u1, v1], [u2, v2]] = t;
  const det = u0 * (v1 - v2) + u1 * (v2 - v0) + u2 * (v0 - v1); if (!det) return;
  const cx = (x0 + x1 + x2) / 3, cy = (y0 + y1 + y2) / 3, grow = (x, y) => { const dx = x - cx, dy = y - cy, l = Math.hypot(dx, dy) || 1; return [x + (dx / l) * 0.7, y + (dy / l) * 0.7]; };
  g.save(); g.beginPath(); const a = grow(x0, y0), b = grow(x1, y1), c = grow(x2, y2); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.lineTo(c[0], c[1]); g.closePath(); g.clip();
  const m11 = (x0 * (v1 - v2) + x1 * (v2 - v0) + x2 * (v0 - v1)) / det, m21 = (u0 * (x1 - x2) + u1 * (x2 - x0) + u2 * (x0 - x1)) / det;
  const dx = (u0 * (v1 * x2 - v2 * x1) + u1 * (v2 * x0 - v0 * x2) + u2 * (v0 * x1 - v1 * x0)) / det;
  const m12 = (y0 * (v1 - v2) + y1 * (v2 - v0) + y2 * (v0 - v1)) / det, m22 = (u0 * (y1 - y2) + u1 * (y2 - y0) + u2 * (y0 - y1)) / det;
  const dy = (u0 * (v1 * y2 - v2 * y1) + u1 * (v2 * y0 - v0 * y2) + u2 * (v0 * y1 - v1 * y0)) / det;
  g.transform(m11, m12, m21, m22, dx, dy); g.drawImage(img, 0, 0); g.restore();
}

/* ---------- one frame ---------- */
function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
function render(g, w, h, S, frac, angle, th, sat) {
  const { xy, z, ext, roads, G } = S, n = xy.length, U = Math.min(w, h) / 400;
  const tilt = 0.62, cosA = Math.cos(angle), sinA = Math.sin(angle), cosT = Math.cos(tilt), sinT = Math.sin(tilt);
  const dist = ext * 2.9, f = Math.min(w, h) * 1.25, cyy = h * (w > h ? 0.52 : 0.5);
  const proj = (x, y, zz) => {   // the camera circles the route, looking down at it
    const rx = x * cosA - y * sinA, ry = x * sinA + y * cosA;
    const depth = ry * cosT - zz * sinT + dist, up = ry * sinT + zz * cosT;
    const s = f / Math.max(depth, ext * 0.2); return [w / 2 + rx * s, cyy - up * s];
  };
  const sky = g.createLinearGradient(0, 0, 0, h); sky.addColorStop(0, th.sky[0]); sky.addColorStop(1, th.sky[1]); g.fillStyle = sky; g.fillRect(0, 0, w, h);
  if (sat) {   // satellite ground, cut into small triangles so it follows the perspective
    const N = 8, TS = sat.tex.width;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const xa = -G + (2 * G * i) / N, xb = -G + (2 * G * (i + 1)) / N, ya = -G + (2 * G * j) / N, yb = -G + (2 * G * (j + 1)) / N;
      const T = (x, y) => [((x + G) / (2 * G)) * TS, ((G - y) / (2 * G)) * TS];
      const p00 = proj(xa, ya, 0), p10 = proj(xb, ya, 0), p01 = proj(xa, yb, 0), p11 = proj(xb, yb, 0);
      texTri(g, sat.tex, [p00, p10, p11], [T(xa, ya), T(xb, ya), T(xb, yb)]); texTri(g, sat.tex, [p00, p11, p01], [T(xa, ya), T(xb, yb), T(xa, yb)]);
    }
  } else {
    const corners = [[-G, -G], [G, -G], [G, G], [-G, G]].map(([x, y]) => proj(x, y, 0));
    g.beginPath(); corners.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fillStyle = th.ground; g.fill();
    g.lineWidth = 1; g.strokeStyle = th.grid;
    for (let i = -4; i <= 4; i++) { const t = (G * i) / 4; let p = proj(-G, t, 0), q = proj(G, t, 0); g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]); g.stroke(); p = proj(t, -G, 0); q = proj(t, G, 0); g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]); g.stroke(); }
    g.lineJoin = g.lineCap = 'round';
    for (const r of roads) {
      g.beginPath(); let on = false;
      for (const [x, y] of r.pts) { if (Math.abs(x) > G || Math.abs(y) > G) { on = false; continue; } const [sx, sy] = proj(x, y, 0); if (on) g.lineTo(sx, sy); else g.moveTo(sx, sy); on = true; }
      g.strokeStyle = r.cls <= 3 ? th.major : th.road; g.lineWidth = (r.cls <= 3 ? 2.6 : 1.6) * U * 0.9; g.stroke();
    }
  }
  const Pt = xy.map(([x, y], i) => proj(x, y, z[i])), F = xy.map(([x, y]) => proj(x, y, 0)), cut = Math.max(1, Math.min(n - 1, Math.round(frac * (n - 1))));
  g.lineJoin = g.lineCap = 'round';
  g.beginPath(); F.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.strokeStyle = 'rgba(40,30,20,.25)'; g.lineWidth = 3 * U; g.stroke();
  for (let i = 1; i < n; i++) {   // a see-through wall from the ground up to the route shows the height
    g.beginPath(); g.moveTo(F[i - 1][0], F[i - 1][1]); g.lineTo(Pt[i - 1][0], Pt[i - 1][1]); g.lineTo(Pt[i][0], Pt[i][1]); g.lineTo(F[i][0], F[i][1]); g.closePath();
    g.fillStyle = i <= cut ? `rgba(${th.wall},.3)` : 'rgba(160,150,130,.12)'; g.fill();
  }
  g.beginPath(); Pt.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 3 * U; g.stroke();
  g.beginPath(); for (let i = 0; i <= cut; i++) (i ? g.lineTo(Pt[i][0], Pt[i][1]) : g.moveTo(Pt[i][0], Pt[i][1])); g.strokeStyle = '#ffffff'; g.lineWidth = 7 * U; g.stroke(); g.strokeStyle = th.route; g.lineWidth = 4.5 * U; g.stroke();
  const pin = (p, col, r) => { g.beginPath(); g.arc(p[0], p[1], r * U, 0, 7); g.fillStyle = col; g.fill(); g.lineWidth = 2.5 * U; g.strokeStyle = '#fff'; g.stroke(); };
  for (const ph of S.photos) { const p = Pt[ph.j]; g.fillStyle = '#fff'; g.beginPath(); g.arc(p[0], p[1], 7 * U, 0, 7); g.fill(); g.fillStyle = th.ink; g.font = `${9 * U}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('📷', p[0], p[1]); g.textBaseline = 'alphabetic'; }
  pin(Pt[0], '#3f9b4f', 6); if (frac >= 1) pin(Pt[n - 1], '#1f1e1d', 6);
  const me = Pt[cut]; g.beginPath(); g.moveTo(me[0], me[1]); g.lineTo(F[cut][0], F[cut][1]); g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = 1.5 * U; g.stroke(); pin(me, th.me, 8);
  // numbers at this moment
  const d = S.cum[cut], t = S.tim[cut], el = S.alt ? S.alt[cut] : null;
  const bw = Math.min(w - 24 * U, 380 * U), bh = 62 * U, bx = (w - bw) / 2, by = h - bh - 14 * U;
  g.fillStyle = th.hud; roundRect(g, bx, by, bw, bh, 12 * U); g.fill();
  const cols = [[fmtKm(d), 'km'], [fmtClock(t), 'time'], [paceOrSpeed(S.type, d > 50 ? t / (d / 1000) : null), S.type === 'cycle' ? 'km/h' : 'pace /km'], el != null ? [Math.round(el), 'm high'] : [S.a.gain, 'm climbed']];
  g.textAlign = 'left';
  cols.forEach(([v, l], i) => { const x = bx + 14 * U + (i * (bw - 20 * U)) / 4; g.fillStyle = '#fff'; g.font = `600 ${19 * U}px system-ui, sans-serif`; g.fillText(String(v), x, by + 30 * U); g.font = `${11 * U}px system-ui, sans-serif`; g.fillStyle = 'rgba(255,255,255,.72)'; g.fillText(l, x, by + 48 * U); });
  g.textAlign = 'right'; g.fillStyle = sat ? '#fff' : th.ink; g.font = `600 ${13 * U}px system-ui, sans-serif`; g.fillText('Internot AI', w - 14 * U, 24 * U);
  g.font = `${11 * U}px system-ui, sans-serif`; g.fillText(`${typeName(S.type)} · ${new Date(S.start).toLocaleDateString()}${S.ex > 1.05 ? ` · height ×${S.ex.toFixed(1)}` : ''}`, w - 14 * U, 40 * U);
  if (sat) { g.font = `${9 * U}px system-ui, sans-serif`; g.fillText('Sentinel-2 cloudless 2016 by EOX', w - 14 * U, 54 * U); }
}
function card(g, w, h, th, alpha, lines) {   // a centred panel with a title and lines of text
  const U = Math.min(w, h) / 400, bw = Math.min(w - 40 * U, 340 * U), lh = 26 * U, bh = 70 * U + lines.length * lh, bx = (w - bw) / 2, by = (h - bh) / 2;
  g.save(); g.globalAlpha = alpha; g.fillStyle = th.hud; roundRect(g, bx, by, bw, bh, 16 * U); g.fill();
  g.textAlign = 'center'; g.fillStyle = '#fff'; g.font = `600 ${20 * U}px system-ui, sans-serif`; g.fillText(lines.title.slice(0, 32), w / 2, by + 38 * U);
  g.font = `${14 * U}px system-ui, sans-serif`; lines.forEach((l, i) => { g.fillStyle = i === 0 && lines.sub ? 'rgba(255,255,255,.75)' : '#fff'; g.fillText(l, w / 2, by + 68 * U + i * lh); });
  g.restore();
}
function photoCard(g, w, h, img, alpha, U) {
  const k = Math.min((w * 0.82) / img.width, (h * 0.58) / img.height), iw = img.width * k, ih = img.height * k, x = (w - iw) / 2, y = (h - ih) / 2 - 20 * U;
  g.save(); g.globalAlpha = alpha; g.fillStyle = '#fff'; roundRect(g, x - 8 * U, y - 8 * U, iw + 16 * U, ih + 16 * U, 10 * U); g.fill(); g.drawImage(img, x, y, iw, ih); g.restore();
}

/* ---------- timing: title card, replay with photo stops, highlights ---------- */
function schedule(S, lengthS) {
  const total = Math.max(12000, lengthS * 1000), stops = S.photos.length * PHOTO, move = Math.max(6000, total - INTRO - OUTRO - stops);
  return { move, total: INTRO + move + stops + OUTRO };
}
function stateAt(S, sch, t) {   // what to show at t milliseconds
  if (t < INTRO) return { frac: 0, intro: Math.max(0, Math.min(1, t / 400, (INTRO - t) / 400)) };
  const tt = t - INTRO, n1 = Math.max(1, S.xy.length - 1); let paused = 0;
  for (const ph of S.photos) {   // the replay stops for each photo
    const at = (ph.j / n1) * sch.move + paused; if (tt < at) break;
    if (tt < at + PHOTO) { const k = tt - at; return { frac: ph.j / n1, photo: ph, pa: Math.max(0, Math.min(1, k / 300, (PHOTO - k) / 300)) }; }
    paused += PHOTO;
  }
  const m = tt - paused; if (m < sch.move) return { frac: m / sch.move };
  return { frac: 1, outro: Math.max(0, Math.min(1, (m - sch.move) / 400)) };
}
function highlights(S) {
  const a = S.a, w = settings().weight, lines = [`${fmtKm(a.dist)} km · ${fmtClock(a.moving)}`, `${S.type === 'cycle' ? 'Average speed' : 'Average pace'} ${paceOrSpeed(S.type, a.pace)} ${paceUnit(S.type)}`, `Climbed ${a.gain} m · top speed ${a.maxSpeed.toFixed(1)} km/h`];
  if (a.best && S.type !== 'cycle') lines.push(`Fastest km ${fmtPace(a.best)}`);
  const kc = kcal(a, S.type, w); if (kc) lines.push(`About ${kc} kcal`);
  for (const r of S.records.slice(0, 2)) lines.push(`🏅 ${r.label}: ${r.value}`);
  lines.title = 'Highlights'; return lines;
}
function drawAt(g, w, h, S, sch, t, th, sat) {
  const st = stateAt(S, sch, t), U = Math.min(w, h) / 400;
  render(g, w, h, S, st.frac, -0.6 + st.frac * 1.6, th, sat);
  if (st.intro) { const l = [`${typeName(S.type)} · ${new Date(S.start).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`, `${fmtKm(S.a.dist)} km`]; l.title = S.run.title || typeName(S.type); l.sub = true; card(g, w, h, th, st.intro, l); }
  if (st.photo) photoCard(g, w, h, st.photo.img, st.pa, U);
  if (st.outro != null) card(g, w, h, th, st.outro, highlights(S));
  return st;
}

/* ---------- screen ---------- */
async function build() {
  const o = R.open; if (!o) return null; const v = settings().video;
  $('run-3d-note').textContent = v.ground === 'satellite' ? 'Getting the satellite pictures…' : '';
  const S = await scene(o.run, o.a); if (!S) { $('run-3d-note').textContent = 'The whole route is inside your privacy zone, so there is nothing to show. Change it under Settings.'; return null; }
  S.sat = v.ground === 'satellite' ? await satGround(S) : null;
  $('run-3d-note').textContent = v.ground === 'satellite' && !S.sat ? 'Satellite pictures for this place are not on the phone. Showing the map instead.' : settings().privacy ? 'Your privacy zone is left out of the replay.' : '';
  R.scene = S; return S;
}
export async function open3d() {
  const o = R.open; if (!o || o.a.n < 2) return;
  const v = settings().video; $('run-v-shape').value = v.shape; $('run-v-style').value = v.style; $('run-v-ground').value = v.ground; $('run-v-length').value = String(v.length);
  $('run-3d').hidden = false; const S = await build(); if (S) play3d();
}
export function play3d(record) {
  stop3d(true); const c = $('run-3d-canvas'), S = R.scene; if (!S) return Promise.resolve();
  const v = settings().video, [w, h] = SHAPES[v.shape] || SHAPES.tall, th = THEMES[v.style] || THEMES.orange, sch = schedule(S, +v.length || 30);
  c.width = w; c.height = h; const g = c.getContext('2d');
  R.videoInfo = { w, h, ground: S.sat ? 'satellite' : 'map', satTiles: S.sat ? S.sat.tiles : 0, photos: S.photos.length, ms: sch.total, style: v.style };
  const t0 = performance.now();
  return new Promise((done) => {
    const frame = (now) => {
      const t = now - t0; drawAt(g, w, h, S, sch, Math.min(t, sch.total), th, S.sat);
      if (t < sch.total) R.anim = requestAnimationFrame(frame); else { R.anim = null; R.played = (R.played || 0) + 1; done(); }
    };
    R.anim = requestAnimationFrame(frame); R.animDone = done;
  });
}
export function stop3d(keepOpen) { if (R.anim) cancelAnimationFrame(R.anim); R.anim = null; R.animDone?.(); R.animDone = null; if (!keepOpen && $('run-3d')) $('run-3d').hidden = true; }
export async function saveVideo() {
  const c = $('run-3d-canvas'), btn = $('run-3d-video'), note = $('run-3d-note');
  if (!R.scene) return;
  if (!c.captureStream || !window.MediaRecorder) { note.textContent = 'This phone cannot make videos here. Use the phone\'s screen recorder while the replay plays.'; return; }
  const type = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
  if (!type) { note.textContent = 'This phone cannot make videos here. Use the phone\'s screen recorder while the replay plays.'; return; }
  const secs = Math.round(schedule(R.scene, +settings().video.length || 30).total / 1000);
  btn.disabled = true; note.textContent = `Making the video… keep this screen open (about ${secs} seconds).`;
  const stream = c.captureStream(30), rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 3000000 }), parts = [];
  rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
  const stopped = new Promise((r) => (rec.onstop = r)); rec.start(500);
  await play3d(true); rec.stop(); await stopped; stream.getTracks().forEach((t) => t.stop());
  const blob = new Blob(parts, { type: type.split(';')[0] }), ext = type.startsWith('video/mp4') ? 'mp4' : 'webm';
  const name = `internot-${R.open?.run.type || 'run'}-${new Date(R.scene.start).toISOString().slice(0, 10)}.${ext}`;
  R.lastVideo = { bytes: blob.size, type: blob.type, name, ...R.videoInfo };
  try { await shareFile(blob, name, 'Share your video'); note.textContent = `Video ready (${(blob.size / 1048576).toFixed(1)} MB). Choose where to save or send it.`; }
  catch (e) { note.textContent = 'Could not save the video: ' + (e?.message || e); }
  btn.disabled = false; play3d();
}
export function initVideo() {
  $('run-3d-close').onclick = () => stop3d(); $('run-3d-play').onclick = () => play3d(); $('run-3d-video').onclick = saveVideo;
  const change = async () => {
    const video = { shape: $('run-v-shape').value, style: $('run-v-style').value, ground: $('run-v-ground').value, length: +$('run-v-length').value };
    const groundChanged = video.ground !== settings().video.ground; saveSettings({ video });
    if (groundChanged || !R.scene) await build(); if (R.scene) play3d();
  };
  for (const id of ['run-v-shape', 'run-v-style', 'run-v-ground', 'run-v-length']) $(id).onchange = change;
}
