// Internot AI — the only parts that talk to the Internot server, and only when the phone is online.
//  • Anonymous count: only if the person said Yes. A random id this app makes for itself, the app version,
//    phone or web, language and region setting, and how often each advert was shown. No name, number or location.
//  • Adverts and update notices: fetched when online (no id is sent), kept for offline use.
//  • Unlock codes for paid packs.
// Everything else in the app works the same with No, or with no internet at all.
export const SERVER = 'https://internot-server.onrender.com';
export const APP_VERSION = '0.11.0';
const $ = (id) => document.getElementById(id);
const NATIVE = !!window.Capacitor;
const ls = { get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
const HOUR = 3600e3;

const choice = () => ls.get('countChoice');   // 'yes', 'no' or null (not asked yet)
function deviceId() {
  let id = ls.get('deviceId');
  if (!id) { const b = new Uint8Array(16); crypto.getRandomValues(b); id = [...b].map((x) => x.toString(16).padStart(2, '0')).join(''); ls.set('deviceId', id); }
  return id;
}
const region = () => { try { return (new Intl.Locale(navigator.language).region || '').slice(0, 2) || null; } catch { return null; } };
const newer = (a, b) => { const p = (v) => String(v || '0').split('.').map((n) => parseInt(n, 10) || 0); const x = p(a), y = p(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };

async function call(path, body) {
  const r = await fetch(SERVER + path, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const out = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(out.error || 'server error ' + r.status), { status: r.status }); return out;
}

/* ---------- the question, asked once ---------- */
function ask() {
  const box = $('consent'); if (!box || choice()) return;
  box.hidden = false;
  $('consent-yes').onclick = () => decide('yes'); $('consent-no').onclick = () => decide('no');
}
function decide(v) { ls.set('countChoice', v); $('consent').hidden = true; $('set-count').checked = v === 'yes'; if (v === 'yes') ping(true); else { try { localStorage.removeItem('deviceId'); localStorage.removeItem('adViews'); } catch {} } }

/* ---------- anonymous count, at most once a day ---------- */
async function ping(force) {
  if (choice() !== 'yes' || !navigator.onLine) return { skipped: true };
  if (!force && Date.now() - Number(ls.get('lastPing', 0)) < 20 * HOUR) return { skipped: true };
  let views = {}; try { views = JSON.parse(ls.get('adViews', '{}')); } catch {}
  try {
    await call('/v1/ping', { id: deviceId(), version: APP_VERSION, platform: NATIVE ? 'android' : 'web', country: region(), lang: (navigator.language || '').slice(0, 10), views });
    ls.set('lastPing', String(Date.now())); ls.set('adViews', '{}'); return { ok: true };
  } catch (e) { return { error: e.message }; }
}

/* ---------- adverts and update notices ---------- */
async function fetchContent(force) {
  if (!navigator.onLine) return null;
  if (!force && Date.now() - Number(ls.get('lastContent', 0)) < 6 * HOUR) return null;
  try { const c = await call('/v1/content'); ls.set('content', JSON.stringify(c)); ls.set('lastContent', String(Date.now())); window.dispatchEvent(new Event('internot-content')); return c; }
  catch (e) { return { error: e.message }; }
}
const cached = () => { try { return JSON.parse(ls.get('content', '{}')); } catch { return {}; } };
function countView(id) { if (choice() !== 'yes') return; let v = {}; try { v = JSON.parse(ls.get('adViews', '{}')); } catch {} v[id] = (v[id] || 0) + 1; ls.set('adViews', JSON.stringify(v)); }

function showNotice(c = cached()) {
  const el = $('notice'); if (!el) return; el.textContent = ''; el.hidden = true;
  const now = Date.now(), closed = (k) => Number(ls.get('closed-' + k, 0)) > now;
  const add = (kind, key, title, body, link, img) => {
    el.className = 'notice ' + kind; el.hidden = false;
    if (img) { const im = document.createElement('img'); im.src = img; im.alt = ''; im.onerror = () => im.remove(); el.append(im); }
    const t = document.createElement('div'); const b = document.createElement('b'); b.textContent = title; t.append(b);
    if (kind === 'ad') { const s = document.createElement('small'); s.textContent = 'Sponsored'; t.prepend(s); }
    if (body) { const p = document.createElement('span'); p.textContent = ' ' + body; t.append(p); }
    if (link) { const a = document.createElement('a'); a.href = link; a.target = '_blank'; a.rel = 'noopener'; a.textContent = kind === 'update' ? 'Get it' : 'Open'; t.append(' ', a); }
    const x = document.createElement('button'); x.type = 'button'; x.setAttribute('aria-label', 'Close'); x.textContent = '✕';
    x.onclick = () => { ls.set('closed-' + key, String(now + (kind === 'update' ? 72 : 24) * HOUR)); showNotice(); };
    el.append(t, x);
  };
  const up = c.update;
  if (up && newer(up.version, APP_VERSION) && !closed('update-' + up.version)) return add('update', 'update-' + up.version, `Version ${up.version} is available.`, up.notes || '', up.url);
  const ads = (c.ads || []).filter((a) => !closed('ad-' + a.id) && (!a.ends_at || Date.parse(a.ends_at) > now));
  if (!ads.length) return;
  const a = ads[Math.floor(Math.random() * ads.length)];
  add('ad', 'ad-' + a.id, a.title, a.body, a.link_url, a.image_url); countView(a.id);
}

/* ---------- paid packs ---------- */
async function redeem(code, pack) {
  if (!navigator.onLine) throw new Error('Unlocking needs the internet once. Connect, then try again.');
  try { return await call('/v1/redeem', { code, pack }); }
  catch (e) { throw new Error(e.status === 404 || e.status === 400 ? 'That code is not valid for this pack.' : e.status === 409 ? 'That code has already been used.' : 'Could not reach the Internot server. Try again later.'); }
}

export async function initOnline() {
  const box = $('set-count'); if (box) { box.checked = choice() === 'yes'; box.onchange = () => decide(box.checked ? 'yes' : 'no'); }
  showNotice(); ask();
  const go = async () => { await fetchContent(); showNotice(); await ping(); };
  window.addEventListener('online', go); setTimeout(go, 4000);
  window.internotOnline = { ping, fetchContent, showNotice, redeem, decide, choice };
}
