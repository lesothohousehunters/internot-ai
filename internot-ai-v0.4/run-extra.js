// Run tab: personal records, badges and challenges, goals, and weekly/monthly/yearly totals.
// Everything is worked out from the activities saved on this phone.
import { R, settings, typeName, fmtKm, fmtClock, paceOrSpeed, paceUnit, stat, EFFORTS, TYPES } from './run.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const DAY = 864e5;
const dayKey = (t) => { const d = new Date(t); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };
export const weekStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };   // Monday
export const monthStart = (t) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };
const yearStart = (t) => new Date(new Date(t).getFullYear(), 0, 1).getTime();

/* ---------- personal records ---------- */
export function bestsOf(list, type) {
  const b = { longest: null, longestTime: null, climb: null, pace: null, speed: null, efforts: {} };
  for (const r of list) {
    if (r.type !== type) continue;
    if (!b.longest || r.dist > b.longest.v) b.longest = { v: r.dist, id: r.id };
    if (!b.longestTime || r.moving > b.longestTime.v) b.longestTime = { v: r.moving, id: r.id };
    if (r.gain >= 20 && (!b.climb || r.gain > b.climb.v)) b.climb = { v: r.gain, id: r.id };
    if (r.dist >= 1000 && r.pace && (!b.pace || r.pace < b.pace.v)) b.pace = { v: r.pace, id: r.id };
    if (r.maxSpeed && (!b.speed || r.maxSpeed > b.speed.v)) b.speed = { v: r.maxSpeed, id: r.id };
    for (const [D, t] of Object.entries(r.efforts || {})) if (!b.efforts[D] || t < b.efforts[D].v) b.efforts[D] = { v: t, id: r.id };
  }
  return b;
}
// What a new activity beats, compared with the earlier ones of the same type (none on the very first one).
export function newRecords(before, sum) {
  const old = before.filter((r) => r.type === sum.type); if (!old.length) return [];
  const b = bestsOf(old, sum.type), out = [];
  for (const [D, label] of EFFORTS.slice().reverse()) { const t = sum.efforts?.[D]; if (t && (!b.efforts[D] || t < b.efforts[D].v)) out.push({ key: 'e' + D, label: 'Fastest ' + label, value: fmtClock(t) }); }
  if (b.longest && sum.dist > b.longest.v) out.push({ key: 'longest', label: `Longest ${typeName(sum.type).toLowerCase()}`, value: fmtKm(sum.dist) + ' km' });
  if (sum.gain >= 20 && (!b.climb || sum.gain > b.climb.v)) out.push({ key: 'climb', label: 'Most climbing', value: sum.gain + ' m' });
  if (sum.dist >= 1000 && sum.pace && b.pace && sum.pace < b.pace.v) out.push({ key: 'pace', label: sum.type === 'cycle' ? 'Fastest average speed' : 'Fastest average pace', value: paceOrSpeed(sum.type, sum.pace) + ' ' + paceUnit(sum.type) });
  return out;
}

/* ---------- badges ---------- */
// Each test walks the activities from oldest to newest and returns the time the badge was earned (or null) and progress.
const chrono = (list) => list.slice().sort((a, b) => a.start - b.start);
const single = (min, type) => (list) => { const hit = chrono(list).find((r) => r.dist >= min && (!type || r.type === type)); const best = Math.max(0, ...list.filter((r) => !type || r.type === type).map((r) => r.dist)); return { at: hit ? hit.start : null, have: best, need: min, unit: 'km' }; };
const total = (key, min, unit) => (list) => { let s = 0, at = null; for (const r of chrono(list)) { s += r[key] || 0; if (at == null && s >= min) at = r.start; } return { at, have: s, need: min, unit }; };
const count = (min) => (list) => { const c = chrono(list); return { at: c.length >= min ? c[min - 1].start : null, have: c.length, need: min, unit: '' }; };
function streak(list) {   // 7 days in a row with an activity
  const days = [...new Set(chrono(list).map((r) => { const d = new Date(r.start); d.setHours(12, 0, 0, 0); return d.getTime(); }))].sort((a, b) => a - b);
  let run = 0, best = 0, at = null;
  for (let i = 0; i < days.length; i++) { run = i && Math.round((days[i] - days[i - 1]) / DAY) === 1 ? run + 1 : 1; best = Math.max(best, run); if (at == null && run >= 7) at = days[i]; }
  return { at, have: best, need: 7, unit: 'days' };
}
function weeks(list) {   // active in 4 weeks in a row
  const ws = [...new Set(chrono(list).map((r) => weekStart(r.start)))].sort((a, b) => a - b);
  let run = 0, best = 0, at = null;
  for (let i = 0; i < ws.length; i++) { run = i && Math.round((ws[i] - ws[i - 1]) / (7 * DAY)) === 1 ? run + 1 : 1; best = Math.max(best, run); if (at == null && run >= 4) at = ws[i]; }
  return { at, have: best, need: 4, unit: 'weeks' };
}
function month50(list) {   // 50 km in one calendar month
  const m = new Map(); let at = null, best = 0;
  for (const r of chrono(list)) { const k = monthStart(r.start), s = (m.get(k) || 0) + r.dist; m.set(k, s); best = Math.max(best, s); if (at == null && s >= 50000) at = r.start; }
  return { at, have: best, need: 50000, unit: 'km' };
}
const early = (list) => { const hit = chrono(list).find((r) => new Date(r.start).getHours() < 6); return { at: hit ? hit.start : null, have: hit ? 1 : 0, need: 1, unit: '' }; };
const photo = (list) => { const hit = chrono(list).find((r) => r.photos > 0); return { at: hit ? hit.start : null, have: hit ? 1 : 0, need: 1, unit: '' }; };
export const BADGES = [
  { id: 'first', icon: '👟', name: 'First steps', desc: 'Save your first activity', test: count(1) },
  { id: 'k5', icon: '5️⃣', name: '5 km', desc: 'Cover 5 km in one activity', test: single(5000) },
  { id: 'k10', icon: '🔟', name: '10 km', desc: 'Cover 10 km in one activity', test: single(10000) },
  { id: 'half', icon: '🥈', name: 'Half marathon', desc: 'Run 21.1 km in one run', test: single(21097.5, 'run') },
  { id: 'full', icon: '🥇', name: 'Marathon', desc: 'Run 42.2 km in one run', test: single(42195, 'run') },
  { id: 'ride50', icon: '🚲', name: 'Long ride', desc: 'Ride 50 km in one ride', test: single(50000, 'cycle') },
  { id: 'n10', icon: '🔁', name: 'Regular', desc: 'Save 10 activities', test: count(10) },
  { id: 'n50', icon: '💪', name: 'Committed', desc: 'Save 50 activities', test: count(50) },
  { id: 't100', icon: '💯', name: '100 km', desc: 'Cover 100 km in total', test: total('dist', 100000, 'km') },
  { id: 't500', icon: '🛣️', name: '500 km', desc: 'Cover 500 km in total', test: total('dist', 500000, 'km') },
  { id: 't1000', icon: '🌍', name: '1,000 km', desc: 'Cover 1,000 km in total', test: total('dist', 1000000, 'km') },
  { id: 'c1000', icon: '⛰️', name: 'Climber', desc: 'Climb 1,000 m in total', test: total('gain', 1000, 'm') },
  { id: 'c3482', icon: '🏔️', name: 'Thabana Ntlenyana', desc: 'Climb 3,482 m in total, the height of Lesotho\'s highest mountain', test: total('gain', 3482, 'm') },
  { id: 'streak7', icon: '🔥', name: 'Seven days', desc: 'Be active 7 days in a row', test: streak },
  { id: 'weeks4', icon: '📅', name: 'Four weeks', desc: 'Be active in 4 weeks in a row', test: weeks },
  { id: 'month50', icon: '🗓️', name: '50 km month', desc: 'Cover 50 km in one calendar month', test: month50 },
  { id: 'early', icon: '🌅', name: 'Early bird', desc: 'Start an activity before 6 in the morning', test: early },
  { id: 'photo', icon: '📷', name: 'Photographer', desc: 'Take a photo during an activity', test: photo },
];
export function earnedBadges(list) { const out = []; for (const b of BADGES) { const r = b.test(list); if (r.at != null) out.push({ ...b, at: r.at }); } return out; }

/* ---------- goals (home screen) ---------- */
const sumSince = (from, to = Infinity) => R.list.filter((r) => r.start >= from && r.start < to);
function bar(label, have, need) {
  const p = need ? Math.min(1, have / need) : 0;
  return `<div class="run-goal"><div class="run-goal-top"><span>${label}</span><b>${fmtKm(have)}${need ? ' of ' + (need / 1000).toFixed(need % 1000 ? 1 : 0) : ''} km</b></div>${need ? `<div class="run-goalbar"><i style="width:${(p * 100).toFixed(1)}%"></i></div>` : ''}</div>`;
}
export function renderGoals() {
  const box = $('run-goals'); if (!box) return; const s = settings(), now = Date.now();
  const w = sumSince(weekStart(now)), m = sumSince(monthStart(now));
  const wd = w.reduce((a, r) => a + r.dist, 0), md = m.reduce((a, r) => a + r.dist, 0);
  box.innerHTML = bar('This week', wd, (+s.weekGoal || 0) * 1000) + bar('This month', md, (+s.monthGoal || 0) * 1000) +
    (!s.weekGoal && !s.monthGoal ? '<p class="hint">Set a weekly or monthly goal under Settings.</p>' : '');
}

/* ---------- records and badges screen ---------- */
export function renderRecords() {
  const box = $('run-r-body'); if (!box) return; let html = '';
  const now = Date.now(), monthKm = sumSince(monthStart(now)).reduce((a, r) => a + r.dist, 0), weekDays = new Set(sumSince(weekStart(now)).map((r) => dayKey(r.start))).size;
  const ch = (name, have, need, txt) => `<div class="run-goal"><div class="run-goal-top"><span>${name}</span><b>${txt}</b></div><div class="run-goalbar"><i style="width:${Math.min(100, (have / need) * 100).toFixed(1)}%"></i></div></div>`;
  html += '<h2>Challenges</h2>' + ch('This month: cover 50 km', monthKm, 50000, `${fmtKm(monthKm)} of 50 km`) + ch('This week: be active on 3 days', weekDays, 3, `${weekDays} of 3 days`);
  for (const type of Object.keys(TYPES)) {
    const b = bestsOf(R.list, type); if (!b.longest) continue;
    const link = (x, text) => `<button type="button" class="linklike" data-open="${x.id}">${text}</button>`;
    let rows = '';
    for (const [D, label] of EFFORTS) if (b.efforts[D]) rows += `<tr><td>Fastest ${label}</td><td>${link(b.efforts[D], fmtClock(b.efforts[D].v))}</td></tr>`;
    rows += `<tr><td>Longest</td><td>${link(b.longest, fmtKm(b.longest.v) + ' km')}</td></tr><tr><td>Longest time</td><td>${link(b.longestTime, fmtClock(b.longestTime.v))}</td></tr>`;
    if (b.pace) rows += `<tr><td>${type === 'cycle' ? 'Fastest average speed' : 'Fastest average pace'} (1 km or more)</td><td>${link(b.pace, paceOrSpeed(type, b.pace.v) + ' ' + paceUnit(type))}</td></tr>`;
    if (b.climb) rows += `<tr><td>Most climbing</td><td>${link(b.climb, b.climb.v + ' m')}</td></tr>`;
    if (b.speed) rows += `<tr><td>Top speed</td><td>${link(b.speed, b.speed.v.toFixed(1) + ' km/h')}</td></tr>`;
    // race times you could reach, from your best 5 km or 10 km (Riegel's formula: time grows with distance to the power 1.06)
    let pred = '';
    if (type === 'run') { const base = b.efforts[10000] ? [10000, b.efforts[10000].v] : b.efforts[5000] ? [5000, b.efforts[5000].v] : null;
      if (base) pred = '<p class="hint">Race predictions from your best ' + (base[0] / 1000) + ' km: ' + [[5000, '5 km'], [10000, '10 km'], [21097.5, 'half marathon'], [42195, 'marathon']].filter(([d]) => d !== base[0]).map(([d, l]) => `${l} ${fmtClock(base[1] * (d / base[0]) ** 1.06)}`).join(' · ') + '. A guide only.</p>'; }
    html += `<h2>${typeName(type)} records</h2><div class="run-splits"><table><tbody>${rows}</tbody></table></div>${pred}`;
  }
  const got = new Map(earnedBadges(R.list).map((b) => [b.id, b.at]));
  html += `<h2>Badges · ${got.size} of ${BADGES.length}</h2><div class="run-badges">` + BADGES.map((b) => {
    const at = got.get(b.id), t = b.test(R.list), num = (v) => Math.round(v).toLocaleString('en-US'), km1 = (m) => (m % 1000 ? (m / 1000).toFixed(1) : num(m / 1000));
    const prog = at ? '' : t.need > 1 ? ` · ${t.unit === 'km' ? (t.have / 1000).toFixed(1) + ' of ' + km1(t.need) + ' km' : num(t.have) + ' of ' + num(t.need) + (t.unit ? ' ' + t.unit : '')}` : '';
    return `<div class="run-badge${at ? ' got' : ''}"><span class="run-badge-i">${b.icon}</span><b>${esc(b.name)}</b><small>${esc(b.desc)}${at ? ' · ' + new Date(at).toLocaleDateString() : prog}</small></div>`;
  }).join('') + '</div>';
  if (!R.list.length) html += '<p class="hint">Records appear after your first saved activity.</p>';
  box.innerHTML = html;
  for (const el of box.querySelectorAll('[data-open]')) el.onclick = () => window.internotRun.openRun(el.dataset.open);
}

/* ---------- totals screen ---------- */
let period = 'week';
export function renderTotals() {
  const box = $('run-t-body'); if (!box) return; const now = Date.now();
  for (const p of ['week', 'month', 'year', 'all']) $('run-t-' + p)?.classList.toggle('on', p === period);
  const from = period === 'week' ? weekStart(now) : period === 'month' ? monthStart(now) : period === 'year' ? yearStart(now) : 0;
  const list = sumSince(from), add = (k) => list.reduce((a, r) => a + (r[k] || 0), 0);
  const byType = Object.keys(TYPES).map((t) => [t, list.filter((r) => r.type === t)]).filter(([, l]) => l.length);
  box.innerHTML = '<div class="run-stats">' + stat('kilometres', fmtKm(add('dist'))) + stat('moving time', fmtClock(add('moving'))) + stat('activities', list.length) + stat('climbed', add('gain'), 'm') + stat('calories (about)', add('kcal'), 'kcal') + '</div>' +
    (byType.length ? '<p class="hint">' + byType.map(([t, l]) => `${typeName(t)}: ${l.length} · ${fmtKm(l.reduce((a, r) => a + r.dist, 0))} km`).join(' · ') + '</p>' : '');
  // bars: the last 12 weeks, the last 12 months, or per year
  const buckets = [];
  if (period === 'week') for (let i = 11; i >= 0; i--) { const s = weekStart(now) - i * 7 * DAY; buckets.push([s, s + 7 * DAY, new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })]); }
  else if (period === 'month' || period === 'year') for (let i = 11; i >= 0; i--) { const d = new Date(now); const s = new Date(d.getFullYear(), d.getMonth() - i, 1).getTime(), e = new Date(d.getFullYear(), d.getMonth() - i + 1, 1).getTime(); buckets.push([s, e, new Date(s).toLocaleDateString(undefined, { month: 'short' })]); }
  else { const y0 = R.list.length ? new Date(Math.min(...R.list.map((r) => r.start))).getFullYear() : new Date(now).getFullYear(), y1 = new Date(now).getFullYear(); for (let y = Math.max(y0, y1 - 9); y <= y1; y++) buckets.push([new Date(y, 0, 1).getTime(), new Date(y + 1, 0, 1).getTime(), String(y)]); }
  const vals = buckets.map(([s, e]) => R.list.filter((r) => r.start >= s && r.start < e).reduce((a, r) => a + r.dist, 0) / 1000);
  R.totalsBars = vals;
  requestAnimationFrame(() => drawBars($('run-t-chart'), vals, buckets.map((b) => b[2])));
}
function drawBars(c, vals, labels) {
  if (!c || !c.clientWidth) return; const w = c.clientWidth, h = c.clientHeight, dpr = window.devicePixelRatio || 1;
  c.width = w * dpr; c.height = h * dpr; const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  const max = Math.max(1, ...vals), B = 30, T = 18, bw = (w - 16) / vals.length;
  g.font = '10px system-ui, sans-serif'; g.textAlign = 'center';
  vals.forEach((v, i) => {
    const x = 8 + i * bw, bh = (v / max) * (h - B - T);
    g.fillStyle = i === vals.length - 1 ? '#c15f3c' : '#d97757aa'; g.fillRect(x + bw * 0.15, h - B - bh, bw * 0.7, Math.max(v > 0 ? 2 : 0, bh));
    g.fillStyle = '#6b6860'; if (vals.length <= 12 || i % 2 === 0) g.fillText(labels[i], x + bw / 2, h - B + 14);
    if (v > 0) { g.fillStyle = '#1f1e1d'; g.fillText(v >= 100 ? Math.round(v) : v.toFixed(1), x + bw / 2, h - B - bh - 4); }
  });
  g.textAlign = 'left'; g.fillStyle = '#6b6860'; g.fillText('km', 8, 11);
}
export function initExtra() {
  for (const p of ['week', 'month', 'year', 'all']) { const b = $('run-t-' + p); if (b) b.onclick = () => { period = p; renderTotals(); }; }
}

