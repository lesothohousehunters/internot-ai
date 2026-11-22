// Run and walk: records a route with the phone's GPS (no internet), shows distance, time, pace, splits and
// climbing, keeps a history on this device, shows a run on the offline map, and plays it back in 3D,
// with a video to save or share. In the Android app the recording carries on with the screen off.
const $ = (id) => document.getElementById(id);
const RUN = window.Capacitor ? window.capacitorExports?.registerPlugin?.('Run') : null;
const R = { root: null, list: [], live: null, timer: 0, poll: 0, watch: null, lock: null, open: null, type: 'run', anim: null };

/* ---------- numbers ---------- */
const RAD = Math.PI / 180;
export function hav(a, b) {   // metres between two [lat, lon]
  const dLat = (b[0] - a[0]) * RAD, dLon = (b[1] - a[1]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}
export const fmtClock = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
export const fmtPace = (secPerKm) => (!secPerKm || !isFinite(secPerKm) || secPerKm > 5999 ? '–' : fmtClock(secPerKm));
const fmtKm = (m) => (m / 1000).toFixed(2);

// One fix: [time ms, lat, lon, altitude m (-9999 = none), accuracy m (-1 = none), speed m/s, segment]
export function analyse(raw, type = 'run') {
  const maxSpeed = type === 'walk' ? 4 : 12;   // faster than this between two fixes is a GPS jump, not you
  const pts = [];
  for (const p of raw) {
    if (p[4] > 40) continue;   // poor fix
    const prev = pts[pts.length - 1];
    if (prev && prev[6] === p[6]) {
      const dt = (p[0] - prev[0]) / 1000; if (dt <= 0) continue;
      if (hav([prev[1], prev[2]], [p[1], p[2]]) / dt > maxSpeed) continue;
    }
    pts.push(p);
  }
  let dist = 0, moving = 0; const cum = [0], tim = [0];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (a[6] === b[6]) { dist += hav([a[1], a[2]], [b[1], b[2]]); moving += Math.min(60, (b[0] - a[0]) / 1000); }
    cum.push(dist); tim.push(moving);
  }
  // climbing: smoothed altitude, and only rises of 3 m or more count (GPS height wobbles)
  const alt = pts.map((p) => (p[3] > -9000 ? p[3] : null)); const has = alt.filter((a) => a != null).length > pts.length * 0.5;
  const smooth = []; let gain = 0, loss = 0, lo = Infinity, hi = -Infinity;
  if (has) {
    for (let i = 0; i < pts.length; i++) { let s = 0, n = 0; for (let j = Math.max(0, i - 3); j <= Math.min(pts.length - 1, i + 3); j++) if (alt[j] != null) { s += alt[j]; n++; } smooth.push(n ? s / n : null); }
    let ref = smooth.find((a) => a != null);
    for (const a of smooth) { if (a == null) continue; lo = Math.min(lo, a); hi = Math.max(hi, a); if (a - ref >= 3) { gain += a - ref; ref = a; } else if (ref - a >= 3) { loss += ref - a; ref = a; } }
  }
  // kilometre splits, the time at each whole kilometre found between two fixes
  const splits = []; let lastT = 0, lastAlt = has ? smooth[0] : null, k = 1;
  for (let i = 1; i < pts.length && dist >= 1000; i++) {
    while (cum[i] >= k * 1000) {
      const f = (k * 1000 - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1), t = tim[i - 1] + f * (tim[i] - tim[i - 1]);
      const al = has && smooth[i] != null ? smooth[i] : null;
      splits.push({ km: k, time: t - lastT, climb: al != null && lastAlt != null ? Math.round(al - lastAlt) : null }); lastT = t; lastAlt = al; k++;
    }
  }
  const rest = dist - (k - 1) * 1000; if (splits.length && rest >= 100) splits.push({ km: +(dist / 1000).toFixed(2), time: moving - lastT, part: rest, climb: null });
  const elapsed = pts.length ? (pts[pts.length - 1][0] - pts[0][0]) / 1000 : 0;
  let best = null; for (const s of splits) if (!s.part && (best == null || s.time < best)) best = s.time;
  return {
    dist, moving, elapsed, pace: dist > 50 ? moving / (dist / 1000) : null, speed: moving > 0 ? dist / moving * 3.6 : 0,
    gain: Math.round(gain), loss: Math.round(loss), low: has ? Math.round(lo) : null, high: has ? Math.round(hi) : null, best,
    splits, n: pts.length, clean: pts, cum, tim, alt: has ? smooth : null,
  };
}
const nowPace = (pts) => {   // pace over the last 30 seconds or so
  const end = pts[pts.length - 1]; if (!end) return null; let d = 0, i = pts.length - 1;
  while (i > 0 && end[0] - pts[i - 1][0] <= 30000 && pts[i - 1][6] === end[6]) { d += hav([pts[i - 1][1], pts[i - 1][2]], [pts[i][1], pts[i][2]]); i--; }
  const t = (end[0] - pts[i][0]) / 1000; return d > 15 && t > 5 ? t / (d / 1000) : null;
};

/* ---------- saved runs (a private folder on this device) ---------- */
async function readJSON(name, fallback) { try { const h = await R.root.getFileHandle(name); return JSON.parse(await (await h.getFile()).text()); } catch { return fallback; } }
async function writeJSON(name, v) { if (!R.root) return; const h = await R.root.getFileHandle(name, { create: true }); const w = await h.createWritable(); await w.write(JSON.stringify(v)); await w.close(); }
const saveList = () => writeJSON('runs.json', R.list);

/* ---------- recording ---------- */
const setLive = (patch) => { R.live = R.live ? { ...R.live, ...patch } : patch; try { if (R.live) localStorage.setItem('runLive', JSON.stringify({ type: R.live.type, start: R.live.start, state: R.live.state })); else localStorage.removeItem('runLive'); } catch {} };
async function lockScreen(on) {   // web app only: the screen has to stay on for the browser to keep the GPS
  try { if (on && !R.lock && navigator.wakeLock) R.lock = await navigator.wakeLock.request('screen'); if (!on && R.lock) { await R.lock.release(); R.lock = null; } } catch {}
}
function webWatch(on) {
  if (!on) { if (R.watch != null) navigator.geolocation.clearWatch(R.watch); R.watch = null; return; }
  if (R.watch != null || !navigator.geolocation) return;
  R.watch = navigator.geolocation.watchPosition((pos) => {
    const L = R.live; if (!L) return; const c = pos.coords; L.acc = c.accuracy; L.lastFix = Date.now(); L.err = '';
    if (L.state !== 'on') return;
    L.pts.push([pos.timestamp || Date.now(), c.latitude, c.longitude, c.altitude == null ? -9999 : c.altitude, c.accuracy ?? -1, c.speed ?? -1, L.seg]);
    if (L.pts.length % 15 === 0) writeJSON('run-current.json', L).catch(() => {});
  }, (e) => { if (R.live) R.live.err = e.code === 1 ? 'Allow location for this page to record a run.' : ''; renderLive(); }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}
async function pull() {   // new fixes from the recorder
  const L = R.live; if (!L) return;
  if (RUN) {
    try {
      const r = await RUN.points({ from: L.pts.length }); for (const p of r.points) L.pts.push(p);
      const s = await RUN.status(); L.acc = s.accuracy; L.lastFix = s.lastFix; L.err = s.error || (!s.gps ? 'Location (GPS) is switched off.' : '');
    } catch (e) { L.err = String(e?.message || e); }
  }
  renderLive();
}
async function start() {
  if (R.live) return;
  setLive({ type: R.type, start: Date.now(), state: 'on', pts: [], seg: 0, acc: -1, err: '' });
  if (RUN) {
    try { await RUN.start({ keep: false }); }
    catch (e) { R.live = null; setLive(null); renderLive(String(e?.message || e)); return; }
  } else { if (!navigator.geolocation) { R.live = null; setLive(null); renderLive('This browser has no GPS. Use the Android app.'); return; } webWatch(true); lockScreen(true); }
  startTimers(); renderLive();
}
function startTimers() { clearInterval(R.timer); clearInterval(R.poll); R.timer = setInterval(renderLive, 1000); R.poll = setInterval(pull, 2000); pull(); }
async function pause() {
  const L = R.live; if (!L) return;
  if (L.state === 'on') { setLive({ state: 'paused' }); if (RUN) await RUN.pause().catch(() => {}); }
  else { setLive({ state: 'on', seg: L.seg + 1 }); if (RUN) await RUN.resume().catch(() => {}); }
  renderLive();
}
async function finish() {
  const L = R.live; if (!L) return;
  await pull(); clearInterval(R.timer); clearInterval(R.poll);
  if (RUN) await RUN.stop().catch(() => {}); else { webWatch(false); lockScreen(false); }
  const a = analyse(L.pts, L.type);
  if (a.n < 2 || a.dist < 20) {
    if (!confirm('Too little was recorded to save (no GPS fix, or you did not move). Throw it away?')) { startTimers(); if (RUN) await RUN.start({ keep: true }).catch(() => {}); else { webWatch(true); lockScreen(true); } return; }
  } else {
    const id = String(L.start);
    await writeJSON('run-' + id + '.json', { id, type: L.type, start: L.start, pts: L.pts });
    R.list.unshift({ id, type: L.type, start: L.start, dist: Math.round(a.dist), moving: Math.round(a.moving), gain: a.gain, pace: a.pace });
    await saveList();
  }
  if (RUN) await RUN.clear().catch(() => {});
  try { await R.root?.removeEntry('run-current.json'); } catch {}
  const id = String(L.start); R.live = null; setLive(null); renderLive(); renderList();
  if (R.list[0]?.id === id) openRun(id);
}
async function recover() {   // the app was closed during a run: carry on with what was recorded
  let saved = null; try { saved = JSON.parse(localStorage.getItem('runLive') || 'null'); } catch {}
  if (!saved) return;
  if (RUN) {
    const s = await RUN.status().catch(() => null); if (!s) return;
    if (!s.running && !s.count) { localStorage.removeItem('runLive'); return; }
    R.live = { ...saved, pts: [], seg: 0, acc: -1, err: '' };
    if (!s.running) { await RUN.start({ keep: true }).catch(() => {}); if (saved.state === 'paused') await RUN.pause().catch(() => {}); }
    else R.live.state = s.paused ? 'paused' : 'on';
    await pull(); R.live.seg = R.live.pts.length ? R.live.pts[R.live.pts.length - 1][6] : 0;
  } else {
    const cur = await readJSON('run-current.json', null); if (!cur) { localStorage.removeItem('runLive'); return; }
    R.live = { ...cur, state: 'paused', seg: (cur.seg || 0) + 1 }; webWatch(true); lockScreen(true);
  }
  startTimers(); renderLive();
}

/* ---------- screens ---------- */
function stat(label, value, unit = '') { return `<div class="run-stat"><b>${value}</b>${unit ? `<i>${unit}</i>` : ''}<small>${label}</small></div>`; }
function renderLive(errText) {
  const L = R.live, box = $('run-live-stats'); if (!box) return;
  $('run-type').hidden = !!L;
  $('run-start').hidden = !!L; $('run-pause').hidden = !L; $('run-finish').hidden = !L;
  $('run-history-box').hidden = !!L;
  if (!L) {
    box.innerHTML = stat('kilometres', '0.00') + stat('time', '0:00') + stat('average pace', '–', '/km') + stat('climbed', '0', 'm');
    $('run-gps').textContent = errText || (RUN ? 'Uses GPS only: no internet, no airtime. Recording carries on with the screen off.' : 'Uses GPS only, no internet. Keep this page open and the screen on while recording.');
    $('run-gps').className = 'hint' + (errText ? ' err' : ''); drawTrace(null); return;
  }
  const a = analyse(L.pts, L.type);
  const elapsed = L.state === 'on' || !L.pts.length ? a.moving + (L.state === 'on' && L.pts.length ? Math.max(0, (Date.now() - L.pts[L.pts.length - 1][0]) / 1000) : 0) : a.moving;
  box.innerHTML = stat('kilometres', fmtKm(a.dist)) + stat('time', fmtClock(L.pts.length ? elapsed : (Date.now() - L.start) / 1000)) +
    stat('average pace', fmtPace(a.pace), '/km') + stat('pace now', fmtPace(nowPace(a.clean)), '/km') + stat('climbed', a.gain, 'm') + stat(a.alt ? 'height' : 'fixes', a.alt ? Math.round(a.alt[a.alt.length - 1] ?? 0) : a.n, a.alt ? 'm' : '');
  $('run-pause').textContent = L.state === 'on' ? 'Pause' : 'Resume';
  const fresh = L.lastFix && Date.now() - L.lastFix < 10000;
  $('run-gps').className = 'hint' + (L.err ? ' err' : '');
  $('run-gps').textContent = L.err || (L.state === 'paused' ? 'Paused. Distance is not counted until you press Resume.' : !fresh ? 'Waiting for GPS… Stand outside with a clear view of the sky.' : `Recording · GPS accurate to about ${Math.round(L.acc)} m`);
  drawTrace(a.clean);
}
function drawTrace(pts) {   // the live route, a simple line that fills the box
  const c = $('run-trace'); if (!c) return; const w = c.clientWidth, h = c.clientHeight; if (!w) return;
  const dpr = window.devicePixelRatio || 1; c.width = w * dpr; c.height = h * dpr; const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  if (!pts || pts.length < 2) { g.fillStyle = '#6b6860'; g.font = '14px system-ui, sans-serif'; g.textAlign = 'center'; g.fillText('Your route will appear here', w / 2, h / 2); return; }
  const P = project2d(pts, w, h, 18); g.lineJoin = g.lineCap = 'round';
  g.beginPath(); P.forEach(([x, y], i) => (i && pts[i][6] === pts[i - 1][6] ? g.lineTo(x, y) : g.moveTo(x, y))); g.strokeStyle = '#d97757'; g.lineWidth = 4; g.stroke();
  const [sx, sy] = P[0], [ex, ey] = P[P.length - 1];
  g.fillStyle = '#3f9b4f'; g.beginPath(); g.arc(sx, sy, 5, 0, 7); g.fill(); g.fillStyle = '#2f6fde'; g.beginPath(); g.arc(ex, ey, 6, 0, 7); g.fill();
}
function project2d(pts, w, h, pad) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (const p of pts) { a = Math.min(a, p[1]); c = Math.max(c, p[1]); b = Math.min(b, p[2]); d = Math.max(d, p[2]); }
  const k = Math.cos(((a + c) / 2) * RAD), sx = (d - b) * k || 1e-9, sy = (c - a) || 1e-9, s = Math.min((w - 2 * pad) / sx, (h - 2 * pad) / sy);
  const ox = (w - sx * s) / 2, oy = (h - sy * s) / 2; return pts.map((p) => [ox + (p[2] - b) * k * s, h - oy - (p[1] - a) * s]);
}
const when = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const typeName = (t) => (t === 'walk' ? 'Walk' : 'Run');
function renderList() {
  const ul = $('run-list'); if (!ul) return; ul.textContent = '';
  $('run-empty').hidden = !!R.list.length;
  let week = 0; const since = Date.now() - 7 * 864e5; for (const r of R.list) if (r.start >= since) week += r.dist;
  $('run-week').textContent = R.list.length ? `Last 7 days: ${fmtKm(week)} km · ${R.list.length} saved` : '';
  for (const r of R.list) {
    const li = document.createElement('li'); li.className = 'run-item'; li.tabIndex = 0;
    li.innerHTML = `<span><b>${typeName(r.type)} · ${fmtKm(r.dist)} km</b><small>${when(r.start)}</small></span><span class="run-item-n">${fmtClock(r.moving)}<small>${fmtPace(r.pace)} /km · ↑${r.gain} m</small></span>`;
    li.onclick = () => openRun(r.id); ul.append(li);
  }
}
async function openRun(id) {
  const run = await readJSON('run-' + id + '.json', null); if (!run) return;
  const a = analyse(run.pts, run.type); R.open = { run, a };
  $('run-home').hidden = true; $('run-detail').hidden = false; $('view-run').scrollTop = 0;
  $('run-d-title').textContent = `${typeName(run.type)} · ${when(run.start)}`;
  $('run-d-stats').innerHTML = stat('kilometres', fmtKm(a.dist)) + stat('moving time', fmtClock(a.moving)) + stat('average pace', fmtPace(a.pace), '/km') +
    stat('average speed', a.speed.toFixed(1), 'km/h') + stat('climbed', a.gain, 'm') + stat('descended', a.loss, 'm') +
    (a.best ? stat('fastest km', fmtPace(a.best), '') : '') + (a.alt ? stat('highest point', a.high, 'm') : '') + stat('total time', fmtClock(a.elapsed));
  const sp = $('run-d-splits');
  sp.innerHTML = a.splits.length ? '<table><thead><tr><th>km</th><th>Time</th><th>Pace /km</th><th>Climb</th></tr></thead><tbody>' + a.splits.map((s) =>
    `<tr${s.time === a.best ? ' class="best"' : ''}><td>${s.part ? s.km : s.km}</td><td>${fmtClock(s.time)}</td><td>${fmtPace(s.part ? s.time / (s.part / 1000) : s.time)}</td><td>${s.climb == null ? '' : (s.climb > 0 ? '+' : '') + s.climb + ' m'}</td></tr>`).join('') + '</tbody></table>'
    : '<p class="hint">Splits appear after the first kilometre.</p>';
  $('run-d-profile-box').hidden = !a.alt;
  requestAnimationFrame(() => { drawProfile(a); drawTraceInto($('run-d-trace'), a.clean); });
}
function drawTraceInto(c, pts) { const keep = $('run-trace'); c.id = 'run-trace'; keep.id = 'run-trace-live'; drawTrace(pts); c.id = 'run-d-trace'; keep.id = 'run-trace'; }
function drawProfile(a) {
  const c = $('run-d-profile'); if (!a.alt || !c.clientWidth) return; const w = c.clientWidth, h = c.clientHeight, dpr = window.devicePixelRatio || 1;
  c.width = w * dpr; c.height = h * dpr; const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  const lo = a.low - 2, hi = Math.max(a.high + 2, lo + 10), L = 50, B = 18, T = 6, X = (d) => L + (d / (a.dist || 1)) * (w - L - 6), Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (h - T - B);
  g.beginPath(); g.moveTo(X(0), h - B); a.alt.forEach((v, i) => v != null && g.lineTo(X(a.cum[i]), Y(v))); g.lineTo(X(a.dist), h - B); g.closePath(); g.fillStyle = 'rgba(217,119,87,.25)'; g.fill();
  g.beginPath(); a.alt.forEach((v, i) => v != null && (i ? g.lineTo(X(a.cum[i]), Y(v)) : g.moveTo(X(a.cum[i]), Y(v)))); g.strokeStyle = '#c15f3c'; g.lineWidth = 2; g.stroke();
  g.fillStyle = '#6b6860'; g.font = '11px system-ui, sans-serif'; g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText(Math.round(hi) + ' m', L - 4, Y(hi)); g.fillText(Math.round(lo) + ' m', L - 4, Y(lo));
  g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.fillText('0', X(0), h - 4); g.fillText(fmtKm(a.dist) + ' km', X(a.dist) - 20, h - 4);
}
function closeRun() { R.open = null; stop3d(); $('run-detail').hidden = true; $('run-home').hidden = false; }
async function deleteRun() {
  const o = R.open; if (!o || !confirm('Delete this ' + typeName(o.run.type).toLowerCase() + '? This cannot be undone.')) return;
  try { await R.root.removeEntry('run-' + o.run.id + '.json'); } catch {}
  R.list = R.list.filter((r) => r.id !== o.run.id); await saveList(); renderList(); closeRun();
}
function showOnMap() {
  const o = R.open; if (!o) return; document.querySelector('.tabs [data-view=map]').click();
  const pts = o.a.clean.map((p) => [p[1], p[2]]);
  setTimeout(() => { window.internotMap?.api?.setTrack(pts); mapChip(true); }, 120);
}
function mapChip(on) {
  let chip = $('run-map-chip'); const wrap = $('map-wrap');
  if (!on) { chip?.remove(); window.internotMap?.api?.setTrack(null); return; }
  if (!chip && wrap) { chip = document.createElement('button'); chip.id = 'run-map-chip'; chip.type = 'button'; chip.className = 'run-map-chip'; chip.textContent = 'Hide run route ✕'; chip.onclick = () => mapChip(false); wrap.append(chip); }
}

/* ---------- 3D replay ---------- */
function scene(a) {   // metres east/north of the middle, height above the lowest point
  const P = a.clean; let la = 0, lo = 0; for (const p of P) { la += p[1]; lo += p[2]; } la /= P.length; lo /= P.length;
  const k = 111320 * Math.cos(la * RAD), M = 110540;
  const xy = P.map((p) => [(p[2] - lo) * k, (p[1] - la) * M]);
  let ext = 1; for (const [x, y] of xy) ext = Math.max(ext, Math.abs(x), Math.abs(y));
  const relief = a.alt ? Math.max(1, a.high - a.low) : 0, ex = relief ? Math.min(8, Math.max(1.5, (ext * 0.35) / relief)) : 1;
  const z = P.map((p, i) => (a.alt && a.alt[i] != null ? (a.alt[i] - a.low) * ex : 0));
  let roads = [];
  try {
    const pad = 0.25; let a0 = Infinity, b0 = Infinity, a1 = -Infinity, b1 = -Infinity; for (const p of P) { a0 = Math.min(a0, p[1]); a1 = Math.max(a1, p[1]); b0 = Math.min(b0, p[2]); b1 = Math.max(b1, p[2]); }
    const dl = (a1 - a0) * pad + 0.002, dn = (b1 - b0) * pad + 0.002;
    roads = (window.internotMap?.api?.roadsNear?.(a0 - dl, b0 - dn, a1 + dl, b1 + dn, 2500) || []).map((r) => ({ cls: r.cls, pts: r.pts.map(([y, x]) => [(x - lo) * k, (y - la) * M]) }));
  } catch {}
  return { xy, z, ext, ex, roads, a };
}
function render3d(g, w, h, S, frac, angle) {
  const { xy, z, ext, roads, a } = S, n = xy.length;
  const tilt = 0.62, cosA = Math.cos(angle), sinA = Math.sin(angle), cosT = Math.cos(tilt), sinT = Math.sin(tilt);
  const dist = ext * 2.9, f = Math.min(w, h) * 1.25;
  const proj = (x, y, zz) => {   // camera circles the route, looking down at it
    const rx = x * cosA - y * sinA, ry = x * sinA + y * cosA;   // turn
    const depth = ry * cosT - zz * sinT + dist, up = ry * sinT + zz * cosT;   // tilt
    const s = f / Math.max(depth, ext * 0.2); return [w / 2 + rx * s, h * 0.56 - up * s, depth];
  };
  const sky = g.createLinearGradient(0, 0, 0, h); sky.addColorStop(0, '#f6f3ea'); sky.addColorStop(1, '#e4ddcc'); g.fillStyle = sky; g.fillRect(0, 0, w, h);
  // ground: a square with a grid
  const G = ext * 1.25; g.lineWidth = 1; g.strokeStyle = 'rgba(120,110,90,.18)';
  const corners = [[-G, -G], [G, -G], [G, G], [-G, G]].map(([x, y]) => proj(x, y, 0));
  g.beginPath(); corners.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fillStyle = 'rgba(232,226,210,.9)'; g.fill();
  for (let i = -4; i <= 4; i++) { const t = (G * i) / 4; let p = proj(-G, t, 0), q = proj(G, t, 0); g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]); g.stroke(); p = proj(t, -G, 0); q = proj(t, G, 0); g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]); g.stroke(); }
  // roads from the offline map, flat on the ground
  g.lineJoin = g.lineCap = 'round';
  for (const r of roads) {
    g.beginPath(); let on = false;
    for (const [x, y] of r.pts) { if (Math.abs(x) > G || Math.abs(y) > G) { on = false; continue; } const [sx, sy] = proj(x, y, 0); if (on) g.lineTo(sx, sy); else g.moveTo(sx, sy); on = true; }
    g.strokeStyle = r.cls <= 3 ? 'rgba(217,119,87,.7)' : 'rgba(120,110,92,.7)'; g.lineWidth = r.cls <= 3 ? 2.6 : 1.6; g.stroke();
  }
  const P = xy.map(([x, y], i) => proj(x, y, z[i])), F = xy.map(([x, y]) => proj(x, y, 0)), cut = Math.max(1, Math.round(frac * (n - 1)));
  // shadow on the ground, then a see-through wall from the ground up to the route
  g.beginPath(); F.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.strokeStyle = 'rgba(60,50,40,.22)'; g.lineWidth = 3; g.stroke();
  for (let i = 1; i < n; i++) {
    const done = i <= cut; g.beginPath(); g.moveTo(F[i - 1][0], F[i - 1][1]); g.lineTo(P[i - 1][0], P[i - 1][1]); g.lineTo(P[i][0], P[i][1]); g.lineTo(F[i][0], F[i][1]); g.closePath();
    g.fillStyle = done ? 'rgba(217,119,87,.28)' : 'rgba(160,150,130,.12)'; g.fill();
  }
  g.beginPath(); P.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.strokeStyle = 'rgba(120,110,95,.55)'; g.lineWidth = 3; g.stroke();
  g.beginPath(); for (let i = 0; i <= cut; i++) (i ? g.lineTo(P[i][0], P[i][1]) : g.moveTo(P[i][0], P[i][1])); g.strokeStyle = '#ffffff'; g.lineWidth = 7; g.stroke(); g.strokeStyle = '#d97757'; g.lineWidth = 4.5; g.stroke();
  const pin = (p, col, r) => { g.beginPath(); g.arc(p[0], p[1], r, 0, 7); g.fillStyle = col; g.fill(); g.lineWidth = 2.5; g.strokeStyle = '#fff'; g.stroke(); };
  pin(P[0], '#3f9b4f', 6); if (frac >= 1) pin(P[n - 1], '#1f1e1d', 6);
  const me = P[cut]; g.beginPath(); g.moveTo(me[0], me[1]); g.lineTo(F[cut][0], F[cut][1]); g.strokeStyle = 'rgba(47,111,222,.5)'; g.lineWidth = 1.5; g.stroke(); pin(me, '#2f6fde', 8);
  // numbers at this moment of the run
  const d = a.cum[cut], t = a.tim[cut], el = a.alt ? a.alt[cut] : null;
  g.fillStyle = 'rgba(31,30,29,.82)'; const bw = Math.min(w - 24, 340); roundRect(g, 12, h - 74, bw, 62, 12); g.fill();
  g.fillStyle = '#fff'; g.textBaseline = 'alphabetic'; g.textAlign = 'left';
  const cols = [[fmtKm(d), 'km'], [fmtClock(t), 'time'], [fmtPace(d > 50 ? t / (d / 1000) : null), 'pace /km'], el != null ? [Math.round(el), 'm high'] : [S.a.gain, 'm climbed']];
  cols.forEach(([v, l], i) => { const x = 24 + (i * (bw - 24)) / 4; g.font = '600 19px system-ui, sans-serif'; g.fillText(String(v), x, h - 44); g.font = '11px system-ui, sans-serif'; g.fillStyle = 'rgba(255,255,255,.7)'; g.fillText(l, x, h - 26); g.fillStyle = '#fff'; });
  g.textAlign = 'right'; g.fillStyle = 'rgba(31,30,29,.7)'; g.font = '600 13px system-ui, sans-serif'; g.fillText('Internot AI', w - 14, 24); g.font = '11px system-ui, sans-serif';
  g.fillText(`${typeName(S.type)} · ${new Date(S.start).toLocaleDateString()}${S.ex > 1.05 ? ` · height ×${S.ex.toFixed(1)}` : ''}`, w - 14, 40);
}
function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
const PLAY_MS = 14000;
function open3d() {
  const o = R.open; if (!o || o.a.n < 2) return;
  const S = scene(o.a); S.type = o.run.type; S.start = o.run.start; R.scene = S;
  $('run-3d').hidden = false; play3d();
}
function play3d(record) {
  stop3d(true); const c = $('run-3d-canvas'), S = R.scene; if (!S) return Promise.resolve();
  const w = record ? 720 : c.clientWidth, h = record ? 960 : c.clientHeight, dpr = record ? 1 : window.devicePixelRatio || 1;
  c.width = w * dpr; c.height = h * dpr; const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const t0 = performance.now(), a0 = -0.6;
  return new Promise((done) => {
    const frame = (now) => {
      const p = Math.min(1, (now - t0) / PLAY_MS), ease = p < 1 ? p : 1;
      render3d(g, w, h, S, ease, a0 + ease * 1.6);
      if (p < 1 || now - t0 < PLAY_MS + 1500) R.anim = requestAnimationFrame(frame); else { R.anim = null; R.played = (R.played || 0) + 1; done(); }
    };
    R.anim = requestAnimationFrame(frame); R.animDone = done;
  });
}
function stop3d(keepOpen) { if (R.anim) cancelAnimationFrame(R.anim); R.anim = null; R.animDone?.(); R.animDone = null; if (!keepOpen) $('run-3d') && ($('run-3d').hidden = true); }
async function saveVideo() {
  const c = $('run-3d-canvas'), btn = $('run-3d-video'), note = $('run-3d-note');
  if (!c.captureStream || !window.MediaRecorder) { note.textContent = 'This phone cannot make videos here. Use the phone\'s screen recorder while the replay plays.'; return; }
  const type = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
  if (!type) { note.textContent = 'This phone cannot make videos here. Use the phone\'s screen recorder while the replay plays.'; return; }
  btn.disabled = true; note.textContent = 'Making the video… keep this screen open (about 16 seconds).';
  const stream = c.captureStream(30), rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 2500000 }), parts = [];
  rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
  const stopped = new Promise((r) => (rec.onstop = r)); rec.start(500);
  await play3d(true); rec.stop(); await stopped; stream.getTracks().forEach((t) => t.stop());
  const blob = new Blob(parts, { type: type.split(';')[0] }), ext = type.startsWith('video/mp4') ? 'mp4' : 'webm';
  const name = `internot-${R.open?.run.type || 'run'}-${new Date(R.scene.start).toISOString().slice(0, 10)}.${ext}`;
  R.lastVideo = { bytes: blob.size, type: blob.type, name };
  try {
    if (RUN) {
      const data = await new Promise((ok, bad) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(',')[1]); fr.onerror = bad; fr.readAsDataURL(blob); });
      await RUN.shareVideo({ data, name, type: blob.type }); note.textContent = `Video ready (${(blob.size / 1048576).toFixed(1)} MB). Choose where to save or send it.`;
    } else {
      const u = URL.createObjectURL(blob), l = document.createElement('a'); l.href = u; l.download = name; document.body.append(l); l.click(); l.remove(); setTimeout(() => URL.revokeObjectURL(u), 30000);
      note.textContent = `Video saved (${(blob.size / 1048576).toFixed(1)} MB).`;
    }
  } catch (e) { note.textContent = 'Could not save the video: ' + (e?.message || e); }
  btn.disabled = false; play3d();
}

/* ---------- start ---------- */
export async function initRun(root) {
  R.root = root;
  R.list = await readJSON('runs.json', []);
  $('run-type-run').onclick = () => { R.type = 'run'; $('run-type-run').classList.add('on'); $('run-type-walk').classList.remove('on'); };
  $('run-type-walk').onclick = () => { R.type = 'walk'; $('run-type-walk').classList.add('on'); $('run-type-run').classList.remove('on'); };
  $('run-start').onclick = start; $('run-pause').onclick = pause;
  $('run-finish').onclick = () => { if (confirm('Finish and save this ' + typeName(R.live?.type).toLowerCase() + '?')) finish(); };
  $('run-d-back').onclick = closeRun; $('run-d-delete').onclick = deleteRun; $('run-d-map').onclick = showOnMap; $('run-d-3d').onclick = open3d;
  $('run-3d-close').onclick = () => stop3d(); $('run-3d-play').onclick = () => play3d(); $('run-3d-video').onclick = saveVideo;
  document.querySelector('.tabs [data-view=run]')?.addEventListener('click', () => requestAnimationFrame(() => { renderLive(); if (R.open) { drawProfile(R.open.a); drawTraceInto($('run-d-trace'), R.open.a.clean); } }));
  document.addEventListener('visibilitychange', () => { if (!document.hidden && R.live) pull(); });
  renderLive(); renderList(); await recover();
  window.internotRun = { R, analyse, start, pause, finish, openRun, open3d, play3d, saveVideo, showOnMap, mapChip, closeRun };
}
