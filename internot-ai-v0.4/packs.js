// Internot AI — maps and AI models after install, and sharing them with no data.
// Downloads continue where they stopped and are checked (size and SHA-256) before use.
// Files can also come from a memory card, a USB stick, the downloads page or another phone.
import { importMap } from './maps.js';

const $ = (id) => document.getElementById(id);
const NATIVE = !!window.Capacitor;
const reg = (n) => (NATIVE ? window.capacitorExports?.registerPlugin?.(n) : null);
const PACKS = reg('Packs'), NEARBY = reg('Nearby');
const SITE = 'https://lesothohousehunters.github.io/internot-ai/';
const GB = 1e9;
const fmt = (b) => (b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : Math.max(1, Math.round(b / 1048576)) + ' MB');
let H = null;                       // hooks from app.js
const P = { catalog: null, device: {}, jobs: new Map(), have: new Map(), partial: new Map(), unlocked: new Map() };

/* ---------- the list of maps and models ---------- */
async function loadCatalog() {
  let local = null, online = null;
  try { local = await (await fetch('./packs.json')).json(); } catch {}
  try { const r = await fetch(SITE + 'internot-ai-v0.4/packs.json', { cache: 'no-store', signal: AbortSignal.timeout(8000) }); if (r.ok) online = await r.json(); } catch {}
  const c = online && (!local || (online.updated || '') >= (local.updated || '')) ? online : local;
  P.catalog = c || { maps: [], models: [] };
  try { if (online) localStorage.setItem('packsCatalog', JSON.stringify(online)); else if (!local) P.catalog = JSON.parse(localStorage.getItem('packsCatalog')) || P.catalog; } catch {}
}
function paidPacks() { try { return (JSON.parse(localStorage.getItem('content') || '{}').packs || []).map((p) => ({ ...p, paid: true })); } catch { return []; } }
const allPacks = () => [
  ...(P.catalog.models || []).map((m) => ({ ...m, kind: 'model' })),
  ...(P.catalog.maps || []).map((m) => ({ ...m, kind: 'map' })),
  ...paidPacks().filter((p) => !(P.catalog.models || []).concat(P.catalog.maps || []).some((x) => x.id === p.id)),
].map((p) => ({ ...p, ...(P.unlocked.get(p.id) || {}) }));

/* ---------- this phone ---------- */
async function readDevice() {
  const d = {};
  if (PACKS) { try { const i = await PACKS.info(); d.ram = i.ram; d.free = i.free; } catch {} }
  if (!d.ram && navigator.deviceMemory) d.ram = navigator.deviceMemory * GB;
  if (!d.free) { try { const e = await navigator.storage.estimate(); d.free = e.quota - e.usage; } catch {} }
  P.device = d;
}
const fits = (m) => !P.device.ram || P.device.ram >= (m.ram || 0) * GB * 0.9;
function suggested() {   // the biggest model this phone's memory can hold
  const ok = (P.catalog.models || []).filter((m) => fits(m) && (NATIVE || !m.nativeOnly)).sort((a, b) => (b.ram || 0) - (a.ram || 0));
  return ok[0]?.id || (P.catalog.models || [])[0]?.id;
}

/* ---------- streaming SHA-256 (web app; the Android app checks natively) ---------- */
const K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
export function sha256() {
  const h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const w = new Uint32Array(64), buf = new Uint8Array(64); let fill = 0, len = 0;
  const block = (b, o) => {
    for (let i = 0; i < 16; i++) w[i] = (b[o + 4 * i] << 24) | (b[o + 4 * i + 1] << 16) | (b[o + 4 * i + 2] << 8) | b[o + 4 * i + 3];
    for (let i = 16; i < 64; i++) { const x = w[i - 15], y = w[i - 2]; w[i] = (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) + w[i - 7] + (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)) + w[i - 16]; }
    let [a, bb, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += bb; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  };
  return {
    update(d) { len += d.length; let i = 0; if (fill) { const n = Math.min(64 - fill, d.length); buf.set(d.subarray(0, n), fill); fill += n; i = n; if (fill === 64) { block(buf, 0); fill = 0; } }
      for (; i + 64 <= d.length; i += 64) block(d, i); if (i < d.length) { buf.set(d.subarray(i), 0); fill = d.length - i; } },
    hex() { const bits = len * 8; const pad = new Uint8Array(((fill < 56 ? 56 : 120) - fill) + 8); pad[0] = 0x80; const dv = new DataView(pad.buffer); dv.setUint32(pad.length - 8, Math.floor(bits / 4294967296)); dv.setUint32(pad.length - 4, bits >>> 0); this.update(pad); return [...h].map((x) => x.toString(16).padStart(8, '0')).join(''); },
  };
}

/* ---------- downloading ---------- */
function setJob(id, j) { if (j) P.jobs.set(id, j); else P.jobs.delete(id); render(); }
const status = (t, err) => { const el = $('pack-status'); el.textContent = t || ''; el.classList.toggle('err', !!err); };

async function webPartial(file) { try { return (await (await H.rootDir.getFileHandle('dl-' + file + '.part')).getFile()).size; } catch { return 0; } }

async function webDownload(p, job) {   // web app: into the browser's private storage, continuing a partial file
  const root = H.rootDir; if (!root) throw new Error('This browser cannot store files for offline use.');
  const name = 'dl-' + p.file + '.part', h = await root.getFileHandle(name, { create: true });
  let have = (await h.getFile()).size; if (p.size && have > p.size) have = 0;
  if (!p.size || have < p.size) {
    const res = await fetch(p.url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal: job.abort.signal });
    if (!res.ok || !res.body) throw new Error('Download failed (' + res.status + ')');
    if (res.status !== 206) have = 0;
    const w = await h.createWritable({ keepExistingData: have > 0 }); if (have) await w.seek(have);
    const rd = res.body.getReader();
    try { for (;;) { const { value, done } = await rd.read(); if (done) break; await w.write(value); have += value.byteLength; job.done = have; job.total = p.size; job.phase = 'download'; render(); } }
    finally { await w.close(); }
  }
  const f = await h.getFile(); if (p.size && f.size !== p.size) throw new Error('The file is incomplete. Tap Continue.');
  if (p.sha256) {
    job.phase = 'checking'; job.done = 0; const s = sha256(), rd = f.stream().getReader();
    for (;;) { const { value, done } = await rd.read(); if (done) break; s.update(value); job.done += value.byteLength; if (job.done % (64 << 20) < value.byteLength) render(); }
    if (s.hex() !== p.sha256.toLowerCase()) { await root.removeEntry(name); throw new Error('The file was damaged on the way and was removed. Please download it again.'); }
  }
  return h;
}

async function get(p) {
  if (P.jobs.has(p.id)) return;
  if (p.paid && !p.url) {   // paid pack: the code bought from Internot unlocks the download
    const code = prompt(`${p.name} costs ${p.price || 'a fee'}. Enter the unlock code you received after paying:`); if (!code) return;
    try { const u = await window.internotOnline.redeem(code.trim(), p.id); P.unlocked.set(p.id, u); Object.assign(p, u); } catch (e) { status(e.message, true); return; }
  }
  if (p.kind === 'model' && P.device.ram && !fits(p) && !confirm(`This model needs a phone with about ${p.ram} GB of memory. This phone has ${fmt(P.device.ram)}. It may be very slow or close itself. Download anyway?`)) return;
  if (P.device.free && p.size && P.device.free < p.size + 100e6 && !confirm(`This needs ${fmt(p.size)} of free space and the phone has ${fmt(P.device.free)}. Try anyway?`)) return;
  const job = { phase: 'download', done: 0, total: p.size, abort: new AbortController() }; setJob(p.id, job); status('');
  try {
    if (PACKS) {
      const r = await PACKS.download({ id: p.id, url: p.url, file: p.file, size: p.size || -1, sha256: p.sha256 || '' });
      job.phase = 'installing'; render();
      await install(p.kind, r.path, p.name);
    } else if (p.kind === 'model') {
      if (p.nativeOnly) throw new Error('This model is only for the Android app.');
      const h = await webDownload(p, job); job.phase = 'installing'; render(); await H.adoptModel(h, p.name, p.size); H.setStatus('Model saved', 'ok');
    } else {
      const src = p.site ? new URL('../' + p.site, location.href).href : p.url; let res = null;
      try { res = await fetch(src, { signal: job.abort.signal }); } catch {}
      if (!res || !res.ok) { window.open(p.url, '_blank'); throw new Error('Your browser is downloading the file instead. When it finishes, tap “Import a file” and choose it.'); }
      await importMap(new File([await res.blob()], p.file));
    }
    status(`${p.name} is ready.`); P.have.set(p.id, true);
  } catch (e) {
    const m = e?.message || String(e);
    status(m === 'paused' || e?.name === 'AbortError' ? `${p.name} paused. Tap Continue to carry on.` : m, !(m === 'paused' || e?.name === 'AbortError'));
  }
  setJob(p.id, null); refreshHave();
}
function pause(p) { const j = P.jobs.get(p.id); if (!j) return; j.abort.abort(); PACKS?.cancel({ id: p.id }); }

async function install(kind, path, name) {
  if (kind === 'model') { await H.unloadModel(); await PACKS.install({ kind, path, name }); await H.refreshModel(); H.setStatus('Model saved', 'ok'); return; }
  const m = await PACKS.install({ kind: 'map', path, name });
  const api = window.internotMap.api; api.addMaps([m]); const b = api.builtIns().find((x) => x.file === m.file); if (b) await api.switchBuiltIn(b);
}

/* ---------- import from a memory card, USB stick, the downloads page or a received file ---------- */
async function importFile() {
  if (!PACKS) { $('pack-import-file').click(); return; }
  status('Choose a map (.imap) or an AI model (.gguf)…');
  try {
    await H.unloadModel(); window.internotLoader?.('Copying the file. Large models take a minute or two.');
    const r = await PACKS.importFile();
    if (r.kind === 'model') { await H.refreshModel(); status(`AI model “${r.name}” is ready.`); }
    else { const api = window.internotMap.api; api.addMaps([r]); const b = api.builtIns().find((x) => x.file === r.file); if (b) await api.switchBuiltIn(b); status(`${r.name} map is ready. Pick it under Maps above.`); }
  } catch (e) { status(e?.message === 'cancelled' ? '' : e?.message || 'Could not use that file.', e?.message !== 'cancelled'); }
  window.internotLoader?.(null); refreshHave();
}
async function webImport(f) {
  if (/\.gguf$/i.test(f.name)) await H.importModel(f);
  else if (/\.(imap|pbf)$/i.test(f.name)) await importMap(f);
  else status('This file is not a map (.imap, .pbf) or an AI model (.gguf).', true);
}

/* ---------- which packs are already on this phone ---------- */
async function refreshHave() {
  P.have.clear(); const api = window.internotMap?.api; const files = new Set((api?.builtIns() || []).map((b) => b.file));
  const model = (await H.native()) ? (await H.BRAIN.info().catch(() => ({}))).model : window.internot?.modelMeta;
  for (const p of allPacks()) {
    if (p.kind === 'map' && files.has(p.file) && NATIVE) P.have.set(p.id, true);
    if (p.kind === 'map' && !NATIVE && window.internotMap?.map?.name === p.name) P.have.set(p.id, true);
    if (p.kind === 'model' && model && (model.name === p.name || model.size === p.size)) P.have.set(p.id, true);
  }
  for (const p of allPacks()) {
    if (P.jobs.has(p.id) || !p.file) continue;
    let n = 0; if (PACKS) { try { n = (await PACKS.partial({ file: p.file })).bytes; } catch {} } else n = await webPartial(p.file);
    if (n) P.partial.set(p.id, n); else P.partial.delete(p.id);
  }
  render();
}

/* ---------- drawing the list ---------- */
function render() {
  const list = $('pack-list'); if (!list || !P.catalog) return; list.textContent = '';
  const d = P.device, best = suggested();
  $('pack-device').textContent = `This phone: ${d.ram ? fmt(d.ram) + ' memory' : 'memory not reported'}${d.free ? ' · ' + fmt(d.free) + ' free' : ''}.`;
  let group = '';
  for (const p of allPacks()) {
    const g = p.kind === 'model' ? 'AI models' : 'Country maps'; if (g !== group) { group = g; const h = document.createElement('li'); h.className = 'pack-group'; h.textContent = g; list.append(h); }
    const li = document.createElement('li'), info = document.createElement('div'); info.className = 'doc-info';
    const title = document.createElement('b'); title.textContent = (p.tier ? p.tier + ' · ' : '') + p.name; info.append(title);
    if (p.id === best && p.kind === 'model') { const t = document.createElement('span'); t.className = 'pack-tag'; t.textContent = 'Suggested for this phone'; info.append(t); }
    const sm = document.createElement('small'); const job = P.jobs.get(p.id);
    const bits = [p.size ? fmt(p.size) : '', p.kind === 'model' && p.ram ? `phones with ${p.ram} GB+ memory` : '', p.houses ? `${Number(p.houses).toLocaleString()} houses` : '', p.paid ? (p.price || 'paid') : ''].filter(Boolean);
    if (p.note) bits.push(p.note);
    if (p.kind === 'model' && p.nativeOnly && !NATIVE) bits.push('Android app only');
    sm.textContent = bits.join(' · '); info.append(sm);
    const st = document.createElement('small');
    if (job) { const f = job.total ? job.done / job.total : 0; st.textContent = job.phase === 'checking' ? `Checking the file… ${Math.round(f * 100)}%` : job.phase === 'installing' ? 'Putting it in place…' : job.phase === 'retry' ? `Connection lost, trying again… ${Math.round(f * 100)}%` : `Downloading… ${fmt(job.done)} of ${p.size ? fmt(p.size) : '?'} (${Math.round(f * 100)}%)`;
      const bar = document.createElement('div'); bar.className = 'progress'; const fillEl = document.createElement('div'); fillEl.style.width = Math.round(f * 100) + '%'; bar.append(fillEl); info.append(st, bar); }
    else if (P.have.get(p.id)) { st.textContent = 'On this phone'; info.append(st); }
    else if (P.partial.get(p.id)) { st.textContent = `${fmt(P.partial.get(p.id))} of ${p.size ? fmt(p.size) : '?'} already downloaded`; info.append(st); }
    const btns = document.createElement('div'); btns.className = 'row';
    const b = document.createElement('button'); b.type = 'button';
    if (job) { b.textContent = 'Pause'; b.onclick = () => pause(p); b.disabled = job.phase !== 'download' && job.phase !== 'retry'; }
    else if (P.have.get(p.id)) { b.textContent = p.kind === 'map' && NATIVE ? 'Open' : 'Get again'; b.onclick = () => (p.kind === 'map' && NATIVE ? openMap(p) : get(p)); }
    else { b.textContent = P.partial.get(p.id) ? 'Continue' : p.paid && !p.url ? 'Unlock' : 'Get'; b.className = 'primary'; b.onclick = () => get(p); b.disabled = p.kind === 'model' && p.nativeOnly && !NATIVE; }
    btns.append(b);
    if (!job && NATIVE && p.kind === 'map' && P.have.get(p.id) && window.internotMap.api.builtIns().find((x) => x.file === p.file)?.url) {
      const del = document.createElement('button'); del.type = 'button'; del.className = 'danger'; del.textContent = 'Remove';
      del.onclick = async () => { if (!confirm(`Remove the ${p.name} map from this phone?`)) return; if (window.internotMap.api.current() === p.file) await window.internotMap.api.switchBuiltIn(window.internotMap.api.builtIns()[0]); await PACKS.remove({ file: p.file }); window.internotMap.api.removeMap(p.file); refreshHave(); };
      btns.append(del);
    }
    li.append(info, btns); list.append(li);
  }
}
async function openMap(p) { const api = window.internotMap.api; const b = api.builtIns().find((x) => x.file === p.file); if (b) { await api.switchBuiltIn(b); document.querySelector('.tabs [data-view=map]')?.click(); } }

/* ---------- sharing with no data ---------- */
const shareStatus = (t, err) => { const el = $('share-status'); el.textContent = t || ''; el.classList.toggle('err', !!err); };
async function share(what) {
  if (!PACKS) {   // web app: share the link to the app
    const url = SITE; try { if (navigator.share) await navigator.share({ title: 'Internot AI', url }); else { await navigator.clipboard.writeText(url); shareStatus('Link copied.'); } } catch {} return;
  }
  const file = what === 'map' ? window.internotMap.api.current() : '';
  if (what === 'map' && !file) { shareStatus('Open a country map first (Maps, or pick one above).', true); return; }
  shareStatus(what === 'app' ? 'Preparing the app file…' : 'Opening the share menu…');
  try { await PACKS.share({ what, file }); shareStatus('Choose Quick Share (Nearby Share) or Bluetooth. The other phone accepts, then opens the file, or uses “Import a file” in Internot AI.'); }
  catch (e) { shareStatus(e?.message || 'Could not share.', true); }
}
async function showPeers() {
  const ul = $('share-peers'); ul.textContent = '';
  let r = { peers: [] }; try { r = await NEARBY.peers(); } catch {}
  if (!r.peers.length) { shareStatus('No linked phone yet. On both phones open Chat and tap “Find nearby phones”, then try again.', true); return; }
  shareStatus('');
  for (const peer of r.peers) {
    const li = document.createElement('li'); const n = document.createElement('div'); n.textContent = peer.name;
    const b = document.createElement('button'); b.type = 'button'; b.className = 'primary'; b.textContent = 'Send';
    b.onclick = () => sendTo(peer); li.append(n, b); ul.append(li);
  }
}
async function sendTo(peer) {
  const what = $('share-what').value, file = what === 'map' ? window.internotMap.api.current() : '';
  if (what === 'map' && !file) { shareStatus('Open a country map first.', true); return; }
  try {
    shareStatus('Getting the file ready…'); const f = await PACKS.pathFor({ what, file });
    const name = what === 'model' ? (window.internot?.modelMeta?.name || 'AI model') : (window.internotMap.api.builtIns().find((b) => b.file === file)?.name || file);
    await NEARBY.sendFile({ endpoint: peer.endpoint, path: f.path, kind: what, name, file: what === 'model' ? 'model.gguf' : file });
    shareStatus(`Waiting for ${peer.name} to accept ${name} (${fmt(f.size)})…`);
  } catch (e) { shareStatus(e?.message || 'Could not send.', true); }
}
function wireNearbyFiles() {
  NEARBY.addListener('fileOffer', async (o) => {
    const yes = confirm(`${o.from || 'A linked phone'} wants to send you ${o.kind === 'model' ? 'the AI model' : 'the map'} “${o.name}” (${fmt(o.size)}). It may replace ${o.kind === 'model' ? 'your AI model' : 'nothing; it is added to your maps'}. Accept?`);
    if (yes && P.device.free && P.device.free < o.size + 100e6) { alert('There is not enough free space on this phone.'); await NEARBY.answerFile({ id: o.id, endpoint: o.endpoint, accept: false }); return; }
    await NEARBY.answerFile({ id: o.id, endpoint: o.endpoint, accept: yes });
    if (yes) shareStatus(`Receiving ${o.name}…`);
  });
  NEARBY.addListener('fileProgress', async (e) => {
    if (e.phase === 'moving') shareStatus(`${e.dir === 'in' ? 'Receiving' : 'Sending'}… ${fmt(e.done)} of ${fmt(e.total)}`);
    else if (e.phase === 'sent') shareStatus('Sent.');
    else if (e.phase === 'declined') shareStatus('The other phone said no.', true);
    else if (e.phase === 'failed') shareStatus('The transfer stopped. Keep the phones close together and try again.', true);
    else if (e.phase === 'received') {
      try { await install(e.kind, e.path, e.name); shareStatus(`${e.name} received and ready.`); } catch (err) { shareStatus(err?.message || 'The received file could not be used.', true); }
      refreshHave();
    }
  });
}

export async function initPacks(hooks) {
  H = hooks;
  await Promise.all([loadCatalog(), readDevice()]);
  if (PACKS) PACKS.addListener('progress', (e) => { const j = P.jobs.get(e.id); if (!j) return; j.phase = e.phase; j.done = e.done; if (e.total > 0) j.total = e.total; render(); });
  $('pack-import').onclick = importFile;
  $('pack-import-file').onchange = async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) { await webImport(f); refreshHave(); } };
  $('share-app').onclick = () => share('app');
  $('share-map').onclick = () => share('map'); $('share-model').onclick = () => share('model');
  $('share-map').hidden = !PACKS; $('share-model').hidden = !PACKS;
  if (NEARBY) { $('share-nearby-box').hidden = false; $('share-peers-btn').onclick = showPeers; wireNearbyFiles(); }
  window.addEventListener('internot-content', () => refreshHave());
  document.querySelector('.tabs [data-view=model]')?.addEventListener('click', () => { readDevice().then(refreshHave); });
  await refreshHave();
  window.internotPacks = { P, get, pause, install, allPacks, suggested, refreshHave, sha256 };
}
