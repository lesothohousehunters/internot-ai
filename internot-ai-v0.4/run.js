// Run, walk, hike and ride: records a route with the phone's GPS (no internet), shows distance, time, pace,
// splits, climbing, calories and speed, keeps a history on this device with records, badges, goals and totals,
// takes photos along the way, shows routes on the offline map, and plays an activity back in 3D as a video.
// In the Android app the recording and the voice coach carry on with the screen off.
import { initExtra, bestsOf, newRecords, earnedBadges, renderGoals, renderRecords, renderTotals, BADGES } from './run-extra.js';
import { open3d, stop3d, play3d, saveVideo, initVideo } from './run-video.js';

const $ = (id) => document.getElementById(id);
export const RUN = window.Capacitor ? window.capacitorExports?.registerPlugin?.('Run') : null;
export const R = { root: null, list: [], live: null, timer: 0, poll: 0, watch: null, lock: null, open: null, type: 'run', anim: null };

/* ---------- activity types ---------- */
// max: faster than this between two fixes is a GPS jump, not you (m/s). still: slower than this over 10 seconds counts as standing still.
export const TYPES = {
  run: { name: 'Run', max: 12, still: 0.5, verb: 'run' },
  walk: { name: 'Walk', max: 4, still: 0.25, verb: 'walk' },
  hike: { name: 'Hike', max: 4, still: 0.2, verb: 'hike' },
  cycle: { name: 'Ride', max: 30, still: 1, verb: 'ride' },
};
export const typeName = (t) => (TYPES[t] || TYPES.run).name;

/* ---------- settings (kept on this phone) ---------- */
const DEFAULTS = { weight: 70, height: 170, voice: true, every: '1000', autoPause: true, weekGoal: 0, monthGoal: 0, privacy: null,
  video: { shape: 'tall', style: 'orange', ground: 'map', length: 30 } };
export function settings() { try { const s = JSON.parse(localStorage.getItem('runSettings') || '{}'); return { ...DEFAULTS, ...s, video: { ...DEFAULTS.video, ...(s.video || {}) } }; } catch { return { ...DEFAULTS }; } }
export function saveSettings(patch) { const s = { ...settings(), ...patch }; try { localStorage.setItem('runSettings', JSON.stringify(s)); } catch {} return s; }

/* ---------- numbers ---------- */
const RAD = Math.PI / 180;
export function hav(a, b) {   // metres between two [lat, lon]
  const dLat = (b[0] - a[0]) * RAD, dLon = (b[1] - a[1]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}
export const fmtClock = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
export const fmtPace = (secPerKm) => (!secPerKm || !isFinite(secPerKm) || secPerKm > 5999 ? '–' : fmtClock(secPerKm));
export const fmtKm = (m) => (m / 1000).toFixed(2);
export const EFFORTS = [[1000, '1 km'], [5000, '5 km'], [10000, '10 km'], [21097.5, 'Half marathon'], [42195, 'Marathon']];
const P = (p) => [p[1], p[2]];

// One fix: [time ms, lat, lon, altitude m (-9999 = none), accuracy m (-1 = none), speed m/s, segment]
export function analyse(raw, type = 'run', opt = {}) {
  const T = TYPES[type] || TYPES.run, still = opt.autoPause === false ? 0 : T.still;
  const pts = [];
  for (const p of raw) {
    if (p[4] > 40) continue;   // poor fix
    const prev = pts[pts.length - 1];
    if (prev && prev[6] === p[6]) {
      const dt = (p[0] - prev[0]) / 1000; if (dt <= 0) continue;
      if (hav(P(prev), P(p)) / dt > T.max) continue;
    }
    pts.push(p);
  }
  // distance and moving time; standing still (less than `still` m/s over the last 10 seconds) is left out: auto-pause
  let dist = 0, moving = 0, w0 = 0, maxSpeed = 0; const cum = [0], tim = [0], spd = [null], mov = [false];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (a[6] !== b[6]) { w0 = i; cum.push(dist); tim.push(moving); spd.push(null); mov.push(false); continue; }
    while (w0 < i - 1 && b[0] - pts[w0 + 1][0] >= 10000) w0++;
    const span = (b[0] - pts[w0][0]) / 1000, v = span > 0 ? hav(P(pts[w0]), P(b)) / span : 0;
    const moved = span < 3 || v >= still;
    if (moved) { dist += hav(P(a), P(b)); moving += Math.min(60, (b[0] - a[0]) / 1000); }
    if (span >= 5 && moved) maxSpeed = Math.max(maxSpeed, v);
    cum.push(dist); tim.push(moving); spd.push(span >= 3 ? v : null); mov.push(moved);
  }
  // climbing: smoothed altitude, and only rises of 3 m or more count (GPS height wobbles)
  const alt = pts.map((p) => (p[3] > -9000 ? p[3] : null)); const has = pts.length > 1 && alt.filter((a) => a != null).length > pts.length * 0.5;
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
  // best efforts: the fastest stretch of 1 km, 5 km, ... inside this activity
  const efforts = {};
  for (const [D] of EFFORTS) {
    if (dist < D) continue; let i = 0, fast = Infinity;
    for (let j = 1; j < cum.length; j++) {
      while (i < j - 1 && cum[j] - cum[i + 1] >= D) i++;
      const d = cum[j] - cum[i]; if (d >= D) fast = Math.min(fast, (tim[j] - tim[i]) * (D / d));
    }
    if (isFinite(fast)) efforts[D] = Math.round(fast);
  }
  return {
    dist, moving, elapsed, pace: dist > 50 ? moving / (dist / 1000) : null, speed: moving > 0 ? dist / moving * 3.6 : 0, maxSpeed: maxSpeed * 3.6,
    gain: Math.round(gain), loss: Math.round(loss), low: has ? Math.round(lo) : null, high: has ? Math.round(hi) : null, best, efforts,
    splits, n: pts.length, clean: pts, cum, tim, spd, mov, alt: has ? smooth : null,
  };
}
// Calories, worked out from speed, climbing and body weight (ACSM walking and running formulas; cycling by speed).
export function kcal(a, type, weight) {
  const hours = a.moving / 3600; if (!hours || !weight) return 0;
  const S = (a.dist / a.moving) * 60, G = a.dist > 0 ? Math.min(0.3, a.gain / a.dist) : 0;   // metres a minute, uphill grade
  let met;
  if (type === 'cycle') { const k = a.speed; met = k < 16 ? 4 : k < 19 ? 6.8 : k < 22 ? 8 : k < 25 ? 10 : 12; }
  else if (type === 'run') met = (0.2 * S + 0.9 * S * G + 3.5) / 3.5;
  else met = (0.1 * S + 1.8 * S * G + 3.5) / 3.5;
  return Math.round(met * weight * hours);
}
const nowPace = (pts) => {   // pace over the last 30 seconds or so
  const end = pts[pts.length - 1]; if (!end) return null; let d = 0, i = pts.length - 1;
  while (i > 0 && end[0] - pts[i - 1][0] <= 30000 && pts[i - 1][6] === end[6]) { d += hav(P(pts[i - 1]), P(pts[i])); i--; }
  const t = (end[0] - pts[i][0]) / 1000; return d > 15 && t > 5 ? t / (d / 1000) : null;
};
const isCycle = (t) => t === 'cycle';
export const paceOrSpeed = (type, secPerKm) => (isCycle(type) ? (secPerKm ? (3600 / secPerKm).toFixed(1) : '–') : fmtPace(secPerKm));
export const paceUnit = (type) => (isCycle(type) ? 'km/h' : '/km');

/* ---------- privacy zone: parts of a route inside it are left out of anything shared ---------- */
export function privatePts(pts) {
  const z = settings().privacy; if (!z) return pts;
  return pts.filter((p) => hav([z.lat, z.lon], P(p)) > z.r);
}

/* ---------- saved runs and photos (a private folder on this device) ---------- */
export async function readJSON(name, fallback) { try { const h = await R.root.getFileHandle(name); return JSON.parse(await (await h.getFile()).text()); } catch { return fallback; } }
export async function writeJSON(name, v) { if (!R.root) return; const h = await R.root.getFileHandle(name, { create: true }); const w = await h.createWritable(); await w.write(JSON.stringify(v)); await w.close(); }
async function writeBlob(name, blob) { const h = await R.root.getFileHandle(name, { create: true }); const w = await h.createWritable(); await w.write(blob); await w.close(); }
export async function readBlob(name) { try { return await (await R.root.getFileHandle(name)).getFile(); } catch { return null; } }
const saveList = () => writeJSON('runs.json', R.list);
export const loadRun = (id) => readJSON('run-' + id + '.json', null);
const saveRun = (run) => writeJSON('run-' + run.id + '.json', run);
async function shrinkPhoto(file) {   // photos are kept at most 1280 pixels across
  const img = await createImageBitmap(file); const k = Math.min(1, 1280 / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); img.close?.();
  return new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.82));
}
export async function shareFile(blob, name, title) {   // the phone's share menu (save, WhatsApp, Quick Share...), or a download on the web
  if (RUN) {
    const data = await new Promise((ok, bad) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(',')[1]); fr.onerror = bad; fr.readAsDataURL(blob); });
    return RUN.shareVideo({ data, name, type: blob.type, title });
  }
  const u = URL.createObjectURL(blob), l = document.createElement('a'); l.href = u; l.download = name; document.body.append(l); l.click(); l.remove(); setTimeout(() => URL.revokeObjectURL(u), 30000);
}
const speak = (text) => { try { window.internotMap?.api?.speak?.(text); } catch {} };
const sayKm = (m) => { const k = m / 1000; return (Math.abs(k - Math.round(k)) < 0.005 ? String(Math.round(k)) : k.toFixed(1)) + (Math.round(k * 100) === 100 ? ' kilometre' : ' kilometres'); };
const sayClock = (s) => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return [h && `${h} hour${h > 1 ? 's' : ''}`, (m || h) && `${m} minute${m !== 1 ? 's' : ''}`, !h && `${x} second${x !== 1 ? 's' : ''}`].filter(Boolean).join(' '); };

/* ---------- recording ---------- */
const GOALS = { none: [0, 0], d3: [3000, 0], d5: [5000, 0], d10: [10000, 0], d21: [21097.5, 0], d42: [42195, 0], t30: [0, 1800], t60: [0, 3600] };
function coachFor(type, goal) {   // what the voice coach says, and when (spoken by the phone, also with the screen off)
  const s = settings(); const [goalM, goalS] = GOALS[goal] || [0, 0];
  if (!s.voice) return null;
  const every = String(s.every), T = TYPES[type] || TYPES.run;
  return { everyM: every.startsWith('t') ? 0 : +every, everyS: every.startsWith('t') ? +every.slice(1) : 0, pace: type !== 'cycle', goalM, goalS,
    maxSpeed: T.max, still: s.autoPause ? T.still : 0, hello: `Starting your ${T.verb}. Have a good one!` };
}
const setLive = (patch) => {
  R.live = R.live ? { ...R.live, ...patch } : patch;
  try { if (R.live) localStorage.setItem('runLive', JSON.stringify({ type: R.live.type, start: R.live.start, state: R.live.state, goal: R.live.goal, photos: R.live.photos || [] })); else localStorage.removeItem('runLive'); } catch {}
};
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
function webCoach(a) {   // the web app speaks for itself (the Android app's recorder does this natively)
  const L = R.live, c = L?.coach; if (RUN || !c) return; const st = L.coachState || (L.coachState = { next: 0, half: false, goal: false });
  const mark = c.everyM ? a.dist : c.everyS ? a.moving : 0, step = c.everyM || c.everyS;
  if (step && mark >= (st.next || step)) { st.next = (Math.floor(mark / step) + 1) * step; speak(`${sayKm(Math.floor(a.dist / 10) * 10)}. Time ${sayClock(a.moving)}.` + (c.pace && a.pace && a.pace <= 3600 ? ` Average pace ${Math.floor(Math.round(a.pace) / 60)} ${String(Math.round(a.pace) % 60).padStart(2, '0')} per kilometre.` : '')); }
  const prog = c.goalM ? a.dist / c.goalM : c.goalS ? a.moving / c.goalS : 0;
  if (prog >= 0.5 && !st.half) { st.half = true; speak('Halfway to your goal.'); }
  if (prog >= 1 && !st.goal) { st.goal = true; speak('Goal reached. Well done!'); }
}
async function pull() {   // new fixes from the recorder
  const L = R.live; if (!L) return;
  if (RUN) {
    try {
      const r = await RUN.points({ from: L.pts.length }); for (const p of r.points) L.pts.push(p);
      const s = await RUN.status(); L.acc = s.accuracy; L.lastFix = s.lastFix; L.said = s.said; L.err = s.error || (!s.gps ? 'Location (GPS) is switched off.' : '');
    } catch (e) { L.err = String(e?.message || e); }
  }
  renderLive();
}
async function start() {
  if (R.live) return;
  const goal = $('run-goal')?.value || 'none', coach = coachFor(R.type, goal);
  setLive({ type: R.type, start: Date.now(), state: 'on', pts: [], seg: 0, acc: -1, err: '', goal, photos: [], coach });
  if (RUN) {
    try { await RUN.start({ keep: false, coach }); }
    catch (e) { R.live = null; setLive(null); renderLive(String(e?.message || e)); return; }
  } else {
    if (!navigator.geolocation) { R.live = null; setLive(null); renderLive('This browser has no GPS. Use the Android app.'); return; }
    webWatch(true); lockScreen(true); if (coach?.hello) speak(coach.hello);
  }
  startTimers(); renderLive();
}
function startTimers() { clearInterval(R.timer); clearInterval(R.poll); R.timer = setInterval(renderLive, 1000); R.poll = setInterval(pull, 2000); pull(); }
async function pause() {
  const L = R.live; if (!L) return;
  if (L.state === 'on') { setLive({ state: 'paused' }); if (RUN) await RUN.pause().catch(() => {}); else if (L.coach) speak('Paused.'); }
  else { setLive({ state: 'on', seg: L.seg + 1 }); if (RUN) await RUN.resume().catch(() => {}); else if (L.coach) speak('Resumed.'); }
  renderLive();
}
async function takePhoto(files) {   // photos taken during the activity are placed where you were
  const L = R.live; if (!L || !files?.length) return;
  for (const f of files) {
    try {
      const last = L.pts[L.pts.length - 1], n = (L.photos || []).length, name = `run-photo-${L.start}-${n}.jpg`;
      await writeBlob(name, await shrinkPhoto(f));
      setLive({ photos: [...(L.photos || []), { name, t: Date.now(), lat: last ? last[1] : null, lon: last ? last[2] : null }] });
    } catch (e) { R.live.err = 'Could not keep the photo: ' + (e?.message || e); }
  }
  renderLive();
}
export function summaryOf(run, a) {
  const w = settings().weight;
  return { id: run.id, type: run.type, start: run.start, title: run.title || '', dist: Math.round(a.dist), moving: Math.round(a.moving), gain: a.gain, pace: a.pace,
    maxSpeed: +a.maxSpeed.toFixed(1), kcal: kcal(a, run.type, w), efforts: a.efforts, photos: (run.photos || []).length };
}
async function finish() {
  const L = R.live; if (!L) return;
  await pull(); clearInterval(R.timer); clearInterval(R.poll);
  if (RUN) await RUN.stop().catch(() => {}); else { webWatch(false); lockScreen(false); }
  const a = analyse(L.pts, L.type, settings());
  if (a.n < 2 || a.dist < 20) {
    if (!confirm('Too little was recorded to save (no GPS fix, or you did not move). Throw it away?')) { startTimers(); if (RUN) await RUN.start({ keep: true, coach: L.coach }).catch(() => {}); else { webWatch(true); lockScreen(true); } return; }
    for (const p of L.photos || []) try { await R.root.removeEntry(p.name); } catch {}
  } else {
    const id = String(L.start), run = { id, type: L.type, start: L.start, pts: L.pts, photos: L.photos || [], goal: L.goal, title: '', note: '' };
    const sum = summaryOf(run, a), before = R.list.slice(), badgesBefore = new Set(earnedBadges(before).map((b) => b.id));
    run.records = newRecords(before, sum); run.badges = earnedBadges([sum, ...before]).filter((b) => !badgesBefore.has(b.id)).map((b) => b.id);
    await saveRun(run); R.list.unshift(sum); await saveList();
    speak(`${typeName(L.type)} saved. ${sayKm(a.dist)} in ${sayClock(a.moving)}.` + (run.records.length ? ` New personal record: ${run.records[0].label}.` : '') + (run.badges.length ? ' You earned a new badge.' : ''));
  }
  if (RUN) await RUN.clear().catch(() => {});
  try { await R.root?.removeEntry('run-current.json'); } catch {}
  const id = String(L.start); R.live = null; setLive(null); renderLive(); renderHome();
  if (R.list[0]?.id === id) openRun(id);
}
async function recover() {   // the app was closed during an activity: carry on with what was recorded
  let saved = null; try { saved = JSON.parse(localStorage.getItem('runLive') || 'null'); } catch {}
  if (!saved) return;
  const coach = coachFor(saved.type, saved.goal);
  if (RUN) {
    const s = await RUN.status().catch(() => null); if (!s) return;
    if (!s.running && !s.count) { localStorage.removeItem('runLive'); return; }
    R.live = { ...saved, pts: [], seg: 0, acc: -1, err: '', coach };
    if (!s.running) { await RUN.start({ keep: true, coach }).catch(() => {}); if (saved.state === 'paused') await RUN.pause().catch(() => {}); }
    else R.live.state = s.paused ? 'paused' : 'on';
    await pull(); R.live.seg = R.live.pts.length ? R.live.pts[R.live.pts.length - 1][6] : 0;
  } else {
    const cur = await readJSON('run-current.json', null); if (!cur) { localStorage.removeItem('runLive'); return; }
    R.live = { ...cur, photos: saved.photos || cur.photos || [], state: 'paused', seg: (cur.seg || 0) + 1, coach }; webWatch(true); lockScreen(true);
  }
  startTimers(); renderLive();
}

/* ---------- screens ---------- */
export function stat(label, value, unit = '') { return `<div class="run-stat"><b>${value}</b>${unit ? `<i>${unit}</i>` : ''}<small>${label}</small></div>`; }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const titleOf = (r) => r.title || `${typeName(r.type)} · ${when(r.start)}`;
function renderLive(errText) {
  const L = R.live, box = $('run-live-stats'); if (!box) return;
  $('run-setup').hidden = !!L;
  $('run-start').hidden = !!L; $('run-pause').hidden = !L; $('run-finish').hidden = !L; $('run-photo').hidden = !L;
  $('run-history-box').hidden = !!L; $('run-goalbar').hidden = true;
  if (!L) {
    box.innerHTML = stat('kilometres', '0.00') + stat('time', '0:00') + stat(isCycle(R.type) ? 'average speed' : 'average pace', '–', paceUnit(R.type)) + stat('climbed', '0', 'm');
    $('run-gps').textContent = errText || (RUN ? 'Uses GPS only: no internet, no airtime. Recording and the voice coach carry on with the screen off.' : 'Uses GPS only, no internet. Keep this page open and the screen on while recording.');
    $('run-gps').className = 'hint' + (errText ? ' err' : ''); drawTrace($('run-trace'), null); return;
  }
  const s = settings(), a = analyse(L.pts, L.type, s); webCoach(a);
  const last = L.pts[L.pts.length - 1], growing = L.state === 'on' && last && a.mov[a.mov.length - 1];
  const time = a.moving + (growing ? Math.max(0, Math.min(5, (Date.now() - last[0]) / 1000)) : 0);
  const stillNow = L.state === 'on' && a.n > 3 && a.mov[a.mov.length - 1] === false && s.autoPause;
  box.innerHTML = stat('kilometres', fmtKm(a.dist)) + stat('time', fmtClock(L.pts.length ? time : 0)) +
    stat(isCycle(L.type) ? 'average speed' : 'average pace', paceOrSpeed(L.type, a.pace), paceUnit(L.type)) + stat(isCycle(L.type) ? 'speed now' : 'pace now', paceOrSpeed(L.type, nowPace(a.clean)), paceUnit(L.type)) +
    stat('climbed', a.gain, 'm') + stat('calories (about)', kcal(a, L.type, s.weight), 'kcal');
  $('run-pause').textContent = L.state === 'on' ? 'Pause' : 'Resume';
  const [goalM, goalS] = GOALS[L.goal] || [0, 0];
  if (goalM || goalS) { const p = Math.min(1, goalM ? a.dist / goalM : a.moving / goalS); $('run-goalbar').hidden = false; $('run-goalbar-fill').style.width = (p * 100).toFixed(1) + '%'; $('run-goalbar-text').textContent = `Goal ${goalM ? sayKm(goalM).replace('kilometres', 'km').replace('kilometre', 'km') : fmtClock(goalS)} · ${Math.round(p * 100)}%`; }
  const fresh = L.lastFix && Date.now() - L.lastFix < 10000;
  $('run-gps').className = 'hint' + (L.err ? ' err' : '');
  $('run-gps').textContent = L.err || (L.state === 'paused' ? 'Paused. Distance is not counted until you press Resume.' : !fresh ? 'Waiting for GPS… Stand outside with a clear view of the sky.'
    : stillNow ? 'Auto-paused while you stand still. Start moving to carry on.' : `Recording · GPS accurate to about ${Math.round(L.acc)} m` + ((L.photos || []).length ? ` · ${(L.photos || []).length} photo${L.photos.length > 1 ? 's' : ''}` : ''));
  drawTrace($('run-trace'), a.clean, L.photos);
}
export function drawTrace(c, pts, photos) {   // a route as a simple line that fills the box
  if (!c) return; const w = c.clientWidth, h = c.clientHeight; if (!w) return;
  const dpr = window.devicePixelRatio || 1; c.width = w * dpr; c.height = h * dpr; const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  if (!pts || pts.length < 2) { g.fillStyle = '#6b6860'; g.font = '14px system-ui, sans-serif'; g.textAlign = 'center'; g.fillText('Your route will appear here', w / 2, h / 2); return; }
  const pr = projector(pts, w, h, 18), Q = pts.map(pr); g.lineJoin = g.lineCap = 'round';
  g.beginPath(); Q.forEach(([x, y], i) => (i && pts[i][6] === pts[i - 1][6] ? g.lineTo(x, y) : g.moveTo(x, y))); g.strokeStyle = '#d97757'; g.lineWidth = 4; g.stroke();
  const [sx, sy] = Q[0], [ex, ey] = Q[Q.length - 1];
  g.fillStyle = '#3f9b4f'; g.beginPath(); g.arc(sx, sy, 5, 0, 7); g.fill(); g.fillStyle = '#2f6fde'; g.beginPath(); g.arc(ex, ey, 6, 0, 7); g.fill();
  for (const ph of photos || []) if (ph.lat != null) { const [x, y] = pr([0, ph.lat, ph.lon]); g.fillStyle = '#fff'; g.strokeStyle = '#1f1e1d'; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 6, 0, 7); g.fill(); g.stroke(); }
}
export function projector(pts, w, h, pad) {   // [.., lat, lon] → [x, y] in a w × h box, north up
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (const p of pts) { a = Math.min(a, p[1]); c = Math.max(c, p[1]); b = Math.min(b, p[2]); d = Math.max(d, p[2]); }
  const k = Math.cos(((a + c) / 2) * RAD), sx = (d - b) * k || 1e-9, sy = (c - a) || 1e-9, s = Math.min((w - 2 * pad) / sx, (h - 2 * pad) / sy);
  const ox = (w - sx * s) / 2, oy = (h - sy * s) / 2; return (p) => [ox + (p[2] - b) * k * s, h - oy - (p[1] - a) * s];
}
export const when = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
function renderHome() {
  const ul = $('run-list'); if (!ul) return; ul.textContent = '';
  $('run-empty').hidden = !!R.list.length;
  renderGoals();
  for (const r of R.list) {
    const li = document.createElement('li'); li.className = 'run-item'; li.tabIndex = 0;
    li.innerHTML = `<span><b>${esc(titleOf(r))}</b><small>${typeName(r.type)} · ${fmtKm(r.dist)} km${r.title ? ' · ' + when(r.start) : ''}${r.photos ? ` · ${r.photos} photo${r.photos > 1 ? 's' : ''}` : ''}</small></span><span class="run-item-n">${fmtClock(r.moving)}<small>${paceOrSpeed(r.type, r.pace)} ${paceUnit(r.type)} · ↑${r.gain} m</small></span>`;
    li.onclick = () => openRun(r.id); ul.append(li);
  }
}
export function showPage(name) {   // home, detail, records, totals, settings
  for (const p of ['home', 'detail', 'records', 'totals', 'settings']) { const el = $('run-' + p); if (el) el.hidden = p !== name; }
  $('view-run').scrollTop = 0;
}
async function openRun(id) {
  const run = await loadRun(id); if (!run) return;
  const s = settings(), a = analyse(run.pts, run.type, s); R.open = { run, a };
  showPage('detail');
  $('run-d-title').textContent = titleOf(run);
  $('run-d-name').value = run.title || ''; $('run-d-note').value = run.note || '';
  const cyc = isCycle(run.type), sum = summaryOf(run, a);
  $('run-d-stats').innerHTML = stat('kilometres', fmtKm(a.dist)) + stat('moving time', fmtClock(a.moving)) + stat(cyc ? 'average speed' : 'average pace', paceOrSpeed(run.type, a.pace), paceUnit(run.type)) +
    stat(cyc ? 'average pace' : 'average speed', cyc ? fmtPace(a.pace) : a.speed.toFixed(1), cyc ? '/km' : 'km/h') + stat('top speed', a.maxSpeed.toFixed(1), 'km/h') + stat('climbed', a.gain, 'm') + stat('descended', a.loss, 'm') +
    (a.best ? stat('fastest km', fmtPace(a.best), '') : '') + (a.alt ? stat('highest point', a.high, 'm') : '') + stat('calories (about)', sum.kcal, 'kcal') + stat('total time', fmtClock(a.elapsed));
  const recs = run.records || [], bad = (run.badges || []).map((id) => BADGES.find((b) => b.id === id)).filter(Boolean);
  $('run-d-awards').hidden = !recs.length && !bad.length;
  $('run-d-awards').innerHTML = recs.map((r) => `<div class="run-award">🏅 New record: <b>${esc(r.label)}</b> ${esc(r.value)}</div>`).join('') + bad.map((b) => `<div class="run-award">${b.icon} New badge: <b>${esc(b.name)}</b></div>`).join('');
  const ef = Object.entries(a.efforts); $('run-d-efforts').hidden = !ef.length;
  $('run-d-efforts').innerHTML = ef.length ? '<h2>Best efforts</h2><div class="run-stats">' + ef.map(([D, t]) => stat(EFFORTS.find((e) => e[0] === +D)[1], fmtClock(t))).join('') + '</div>' : '';
  const sp = $('run-d-splits');
  sp.innerHTML = a.splits.length ? '<table><thead><tr><th>km</th><th>Time</th><th>' + (cyc ? 'Speed km/h' : 'Pace /km') + '</th><th>Climb</th></tr></thead><tbody>' + a.splits.map((x) => {
    const per = x.part ? x.time / (x.part / 1000) : x.time;
    return `<tr${x.time === a.best ? ' class="best"' : ''}><td>${x.km}</td><td>${fmtClock(x.time)}</td><td>${paceOrSpeed(run.type, per)}</td><td>${x.climb == null ? '' : (x.climb > 0 ? '+' : '') + x.climb + ' m'}</td></tr>`;
  }).join('') + '</tbody></table>' : '<p class="hint">Splits appear after the first kilometre.</p>';
  $('run-d-profile-box').hidden = !a.alt;
  renderPhotos();
  requestAnimationFrame(() => { drawProfile(a); drawSpeed(a, run.type); drawTrace($('run-d-trace'), a.clean, run.photos); });
}
function chart(c, a, values, fmt, color) {   // a line chart along the distance
  if (!c || !c.clientWidth) return; const w = c.clientWidth, h = c.clientHeight, dpr = window.devicePixelRatio || 1;
  c.width = w * dpr; c.height = h * dpr; const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  const vs = values.filter((v) => v != null); if (vs.length < 2) return;
  let lo = Math.min(...vs), hi = Math.max(...vs); if (hi - lo < 1e-6) { hi += 1; lo -= 1; } const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const L = 50, B = 18, T = 6, X = (d) => L + (d / (a.dist || 1)) * (w - L - 6), Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (h - T - B);
  g.beginPath(); g.moveTo(X(0), h - B); values.forEach((v, i) => v != null && g.lineTo(X(a.cum[i]), Y(v))); g.lineTo(X(a.dist), h - B); g.closePath(); g.fillStyle = color + '40'; g.fill();
  g.beginPath(); let on = false; values.forEach((v, i) => { if (v == null) { on = false; return; } if (on) g.lineTo(X(a.cum[i]), Y(v)); else g.moveTo(X(a.cum[i]), Y(v)); on = true; }); g.strokeStyle = color; g.lineWidth = 2; g.stroke();
  g.fillStyle = '#6b6860'; g.font = '11px system-ui, sans-serif'; g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText(fmt(hi - pad), L - 4, Y(hi - pad)); g.fillText(fmt(lo + pad), L - 4, Y(lo + pad));
  g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.fillText('0', X(0), h - 4); g.fillText(fmtKm(a.dist) + ' km', X(a.dist) - 20, h - 4);
}
function drawProfile(a) { if (a.alt) chart($('run-d-profile'), a, a.alt, (v) => Math.round(v) + ' m', '#c15f3c'); }
function drawSpeed(a, type) {   // speed in km/h, smoothed over about 10 seconds; only while moving
  const v = a.spd.map((s, i) => (s == null || !a.mov[i] ? null : s * 3.6));
  $('run-d-speed-box').hidden = v.filter((x) => x != null).length < 2; chart($('run-d-speed'), a, v, (x) => x.toFixed(1), '#2f6fde');
  $('run-d-speed-title').textContent = isCycle(type) ? 'Speed (km/h)' : 'Speed (km/h)';
}
export function closeRun() { R.open = null; stop3d(); showPage('home'); }
async function deleteRun() {
  const o = R.open; if (!o || !confirm('Delete this ' + typeName(o.run.type).toLowerCase() + ' and its photos? This cannot be undone.')) return;
  try { await R.root.removeEntry('run-' + o.run.id + '.json'); } catch {}
  for (const p of o.run.photos || []) try { await R.root.removeEntry(p.name); } catch {}
  R.list = R.list.filter((r) => r.id !== o.run.id); await saveList(); renderHome(); closeRun();
}
async function saveText() {   // title and notes
  const o = R.open; if (!o) return; o.run.title = $('run-d-name').value.trim().slice(0, 80); o.run.note = $('run-d-note').value.slice(0, 2000);
  await saveRun(o.run); const i = R.list.findIndex((r) => r.id === o.run.id); if (i >= 0) { R.list[i].title = o.run.title; await saveList(); }
  $('run-d-title').textContent = titleOf(o.run); renderHome();
}
export function showOnMap() {
  const o = R.open; if (!o) return; document.querySelector('.tabs [data-view=map]').click();
  const pts = o.a.clean.map(P);
  setTimeout(() => { window.internotMap?.api?.setTrack(pts); mapChip(true, 'Hide route ✕'); }, 120);
}
async function memoryMap() {   // every saved activity on the offline map
  const tracks = [];
  for (const r of R.list) { const run = await loadRun(r.id); if (!run) continue; const a = analyse(run.pts, run.type, settings()), step = Math.max(1, Math.floor(a.clean.length / 400)); tracks.push(a.clean.filter((_, i) => i % step === 0 || i === a.clean.length - 1).map(P)); }
  if (!tracks.length) { alert('No saved activities yet.'); return; }
  document.querySelector('.tabs [data-view=map]').click();
  setTimeout(() => { window.internotMap?.api?.setTracks(tracks); mapChip(true, `${tracks.length} route${tracks.length > 1 ? 's' : ''} · Hide ✕`); }, 120);
  R.memory = tracks.length;
}
export function mapChip(on, text) {
  let chip = $('run-map-chip'); const wrap = $('map-wrap');
  if (!on) { chip?.remove(); window.internotMap?.api?.setTrack(null); return; }
  if (!chip && wrap) { chip = document.createElement('button'); chip.id = 'run-map-chip'; chip.type = 'button'; chip.className = 'run-map-chip'; chip.onclick = () => mapChip(false); wrap.append(chip); }
  if (chip) chip.textContent = text || 'Hide route ✕';
}

/* ---------- photos on a saved activity ---------- */
const urls = new Map();
export async function photoURL(name) { if (urls.has(name)) return urls.get(name); const b = await readBlob(name); if (!b) return null; const u = URL.createObjectURL(b); urls.set(name, u); return u; }
async function renderPhotos() {
  const o = R.open, box = $('run-d-photos'); if (!o || !box) return; box.textContent = '';
  for (const [i, p] of (o.run.photos || []).entries()) {
    const u = await photoURL(p.name); if (!u) continue;
    const b = document.createElement('button'); b.type = 'button'; b.className = 'run-thumb'; b.setAttribute('aria-label', 'Photo ' + (i + 1));
    b.innerHTML = `<img alt="" src="${u}">`; b.onclick = () => viewPhoto(i); box.append(b);
  }
  $('run-d-photos-empty').hidden = !!(o.run.photos || []).length;
}
async function addPhotos(files) {   // from the gallery: placed where you were when the photo was taken, if it was during the activity
  const o = R.open; if (!o || !files?.length) return; const pts = o.a.clean, t0 = pts[0]?.[0] ?? o.run.start, t1 = pts[pts.length - 1]?.[0] ?? t0;
  for (const f of files) {
    try {
      const n = (o.run.photos || []).length, name = `run-photo-${o.run.id}-${n}-${Date.now() % 100000}.jpg`; await writeBlob(name, await shrinkPhoto(f));
      const t = f.lastModified >= t0 - 300000 && f.lastModified <= t1 + 300000 ? f.lastModified : t1; let best = pts[pts.length - 1];
      for (const p of pts) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
      (o.run.photos ||= []).push({ name, t, lat: best ? best[1] : null, lon: best ? best[2] : null });
    } catch (e) { alert('Could not add the photo: ' + (e?.message || e)); }
  }
  o.run.photos.sort((x, y) => x.t - y.t); await saveRun(o.run);
  const i = R.list.findIndex((r) => r.id === o.run.id); if (i >= 0) { R.list[i].photos = o.run.photos.length; await saveList(); }
  renderPhotos(); renderHome(); drawTrace($('run-d-trace'), o.a.clean, o.run.photos);
}
async function viewPhoto(i) {
  const o = R.open, p = o?.run.photos?.[i]; if (!p) return; R.photoIndex = i;
  $('run-photo-img').src = await photoURL(p.name) || ''; $('run-photo-view').hidden = false;
  $('run-photo-cap').textContent = `Photo ${i + 1} of ${o.run.photos.length} · ${new Date(p.t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}
async function deletePhoto() {
  const o = R.open, i = R.photoIndex, p = o?.run.photos?.[i]; if (!p || !confirm('Delete this photo?')) return;
  try { await R.root.removeEntry(p.name); } catch {} o.run.photos.splice(i, 1); await saveRun(o.run);
  const k = R.list.findIndex((r) => r.id === o.run.id); if (k >= 0) { R.list[k].photos = o.run.photos.length; await saveList(); }
  $('run-photo-view').hidden = true; renderPhotos(); renderHome(); drawTrace($('run-d-trace'), o.a.clean, o.run.photos);
}

/* ---------- a picture of the activity to share ---------- */
async function shareImage() {
  const o = R.open; if (!o) return; const W = 1080, H = 1350, c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  g.fillStyle = '#f6f3ea'; g.fillRect(0, 0, W, H);
  const pts = privatePts(o.a.clean);
  if (pts.length > 1) {
    const pr = projector(pts, W - 120, 700, 30), Q = pts.map(pr); g.save(); g.translate(60, 230);
    g.lineJoin = g.lineCap = 'round'; g.beginPath(); Q.forEach(([x, y], i) => (i && pts[i][6] === pts[i - 1][6] ? g.lineTo(x, y) : g.moveTo(x, y))); g.strokeStyle = '#fff'; g.lineWidth = 18; g.stroke(); g.strokeStyle = '#d97757'; g.lineWidth = 10; g.stroke(); g.restore();
  }
  g.fillStyle = '#1f1e1d'; g.font = '600 52px system-ui, sans-serif'; g.fillText(titleOf(o.run).slice(0, 34), 60, 110);
  g.fillStyle = '#6b6860'; g.font = '32px system-ui, sans-serif'; g.fillText(`${typeName(o.run.type)} · ${new Date(o.run.start).toLocaleDateString()}`, 60, 165);
  const a = o.a, cols = [[fmtKm(a.dist), 'km'], [fmtClock(a.moving), 'time'], [paceOrSpeed(o.run.type, a.pace), paceUnit(o.run.type)], [String(a.gain), 'm climbed']];
  cols.forEach(([v, l], i) => { const x = 60 + i * 250; g.fillStyle = '#1f1e1d'; g.font = '600 60px system-ui, sans-serif'; g.fillText(v, x, 1050); g.fillStyle = '#6b6860'; g.font = '30px system-ui, sans-serif'; g.fillText(l, x, 1095); });
  g.fillStyle = '#c15f3c'; g.font = '600 34px system-ui, sans-serif'; g.fillText('Internot AI', 60, H - 80); g.fillStyle = '#6b6860'; g.font = '26px system-ui, sans-serif'; g.fillText('Recorded offline · © OpenStreetMap contributors', 60, H - 40);
  const blob = await new Promise((ok) => c.toBlob(ok, 'image/png')); R.lastImage = { bytes: blob.size };
  try { await shareFile(blob, `internot-${o.run.type}-${new Date(o.run.start).toISOString().slice(0, 10)}.png`, 'Share your activity'); } catch (e) { alert('Could not share: ' + (e?.message || e)); }
}

/* ---------- settings screen ---------- */
function bmiText(w, h) { if (!w || !h) return ''; const b = w / (h / 100) ** 2; const cat = b < 18.5 ? 'underweight' : b < 25 ? 'healthy weight' : b < 30 ? 'overweight' : 'obese'; return `BMI ${b.toFixed(1)} · ${cat} (adult range)`; }
function renderSettings() {
  const s = settings();
  $('run-s-weight').value = s.weight || ''; $('run-s-height').value = s.height || ''; $('run-s-bmi').textContent = bmiText(+s.weight, +s.height);
  $('run-s-voice').checked = !!s.voice; $('run-s-every').value = String(s.every); $('run-s-auto').checked = !!s.autoPause;
  $('run-s-week').value = s.weekGoal || ''; $('run-s-month').value = s.monthGoal || '';
  $('run-s-zone').textContent = s.privacy ? `On: within ${s.privacy.r} m of the place you set, the route is left out of shared videos and pictures.` : 'Off.';
  $('run-s-zone-r').value = String(s.privacy?.r || 300); $('run-s-zone-clear').hidden = !s.privacy;
}
function saveSettingsForm() {
  const num = (id) => { const v = parseFloat($(id).value); return isFinite(v) && v > 0 ? v : 0; };
  saveSettings({ weight: num('run-s-weight') || DEFAULTS.weight, height: num('run-s-height') || DEFAULTS.height, voice: $('run-s-voice').checked, every: $('run-s-every').value,
    autoPause: $('run-s-auto').checked, weekGoal: num('run-s-week'), monthGoal: num('run-s-month') });
  renderSettings(); renderGoals();
}
async function setZone(fromLast) {
  const r = +$('run-s-zone-r').value || 300;
  if (fromLast) { const first = R.list[R.list.length ? 0 : -1]; const run = first && await loadRun(first.id); const p = run?.pts?.[0]; if (!p) { alert('No saved activity yet.'); return; } saveSettings({ privacy: { lat: p[1], lon: p[2], r } }); renderSettings(); return; }
  if (!navigator.geolocation) { alert('No GPS here.'); return; }
  $('run-s-zone').textContent = 'Finding where you are…';
  navigator.geolocation.getCurrentPosition((pos) => { saveSettings({ privacy: { lat: pos.coords.latitude, lon: pos.coords.longitude, r } }); renderSettings(); },
    () => { $('run-s-zone').textContent = 'Could not find where you are. Go outside, or use the start of your last activity.'; }, { enableHighAccuracy: true, timeout: 30000 });
}

/* ---------- start ---------- */
function pickType(t) { R.type = t; for (const k of Object.keys(TYPES)) $('run-type-' + k)?.classList.toggle('on', k === t); renderLive(); }
export async function initRun(root) {
  R.root = root;
  R.list = await readJSON('runs.json', []);
  for (const k of Object.keys(TYPES)) { const b = $('run-type-' + k); if (b) b.onclick = () => pickType(k); }
  $('run-start').onclick = start; $('run-pause').onclick = pause;
  $('run-photo-file').onchange = (e) => { takePhoto([...e.target.files]); e.target.value = ''; };
  $('run-finish').onclick = () => { if (confirm('Finish and save this ' + typeName(R.live?.type).toLowerCase() + '?')) finish(); };
  $('run-d-back').onclick = closeRun; $('run-d-delete').onclick = deleteRun; $('run-d-map').onclick = showOnMap; $('run-d-3d').onclick = () => open3d();
  $('run-d-share').onclick = shareImage; $('run-d-name').onchange = saveText; $('run-d-note').onchange = saveText;
  $('run-d-addphoto').onchange = (e) => { addPhotos([...e.target.files]); e.target.value = ''; };
  $('run-photo-close').onclick = () => { $('run-photo-view').hidden = true; }; $('run-photo-delete').onclick = deletePhoto;
  $('run-go-records').onclick = () => { renderRecords(); showPage('records'); }; $('run-go-totals').onclick = () => { showPage('totals'); renderTotals(); };
  $('run-go-memory').onclick = memoryMap; $('run-go-settings').onclick = () => { renderSettings(); showPage('settings'); };
  for (const id of ['run-r-back', 'run-t-back', 'run-s-back']) $(id).onclick = () => showPage('home');
  for (const id of ['run-s-weight', 'run-s-height', 'run-s-voice', 'run-s-every', 'run-s-auto', 'run-s-week', 'run-s-month']) $(id).onchange = saveSettingsForm;
  $('run-s-zone-here').onclick = () => setZone(false); $('run-s-zone-last').onclick = () => setZone(true);
  $('run-s-zone-clear').onclick = () => { saveSettings({ privacy: null }); renderSettings(); };
  $('run-s-zone-r').onchange = () => { const s = settings(); if (s.privacy) { saveSettings({ privacy: { ...s.privacy, r: +$('run-s-zone-r').value } }); renderSettings(); } };
  initExtra(); initVideo();
  document.querySelector('.tabs [data-view=run]')?.addEventListener('click', () => requestAnimationFrame(() => { renderLive(); if (R.open) { drawProfile(R.open.a); drawSpeed(R.open.a, R.open.run.type); drawTrace($('run-d-trace'), R.open.a.clean, R.open.run.photos); } }));
  document.addEventListener('visibilitychange', () => { if (!document.hidden && R.live) pull(); });
  renderLive(); renderHome(); await recover();
  window.internotRun = { R, analyse, kcal, settings, saveSettings, start, pause, finish, openRun, open3d, play3d, saveVideo, showOnMap, mapChip, closeRun, memoryMap, shareImage, addPhotos, takePhoto, privatePts, bestsOf, newRecords, earnedBadges, renderRecords, renderTotals, showPage, pickType };
}
