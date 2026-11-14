// Internot AI — Inter-Chat: phone-to-phone messages with no internet and no server.
// Phones link directly over a shared Wi-Fi network or hotspot (WebRTC, paired by QR code).
// Every message is encrypted for its recipient, and linked phones pass messages along for each other.

const $ = (id) => document.getElementById(id);
const enc = new TextEncoder(), dec = new TextDecoder();
const MAX_FILE = 3 * 1024 * 1024, FRAG = 48000, TTL = 6;

const S = {
  root: null, me: null, priv: null, contacts: new Map(), msgs: [], links: new Map(), routes: new Map(),
  seen: new Set(), keys: new Map(), pending: null, open: null, unread: new Map(), onUnread: null, saveT: 0, stream: null, scanT: 0,
};

/* ---------- small helpers ---------- */
const b64u = (bytes) => { let s = ''; const b = new Uint8Array(bytes); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const b64 = (bytes) => { const s = b64u(bytes).replace(/-/g, '+').replace(/_/g, '/'); return s + '='.repeat((4 - s.length % 4) % 4); };
const unb64u = (s) => { const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/')); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
const rid = (n = 9) => b64u(crypto.getRandomValues(new Uint8Array(n)));
const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
const pack = async (text) => b64u(await pipe(enc.encode(text), new CompressionStream('deflate-raw')));
const unpack = async (code) => dec.decode(await pipe(unb64u(code), new DecompressionStream('deflate-raw')));
const idOf = async (pub) => b64u(await crypto.subtle.digest('SHA-256', unb64u(pub))).slice(0, 16);

async function readJSON(name, fallback) { if (!S.root) return fallback; try { return JSON.parse(await (await (await S.root.getFileHandle(name)).getFile()).text()); } catch { return fallback; } }
async function writeJSON(name, value) { if (!S.root) return; try { const h = await S.root.getFileHandle(name, { create: true }); const w = await h.createWritable(); await w.write(JSON.stringify(value)); await w.close(); } catch (e) { console.warn('save failed', name, e); } }
function save() { clearTimeout(S.saveT); S.saveT = setTimeout(() => writeJSON('mesh.json', { contacts: [...S.contacts.values()], msgs: S.msgs.slice(-500) }), 300); }

/* ---------- identity and encryption ---------- */
async function loadIdentity() {
  let me = await readJSON('mesh-id.json', null);
  if (!me) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
    const pub = b64u(await crypto.subtle.exportKey('raw', kp.publicKey));
    me = { id: await idOf(pub), pub, jwk: await crypto.subtle.exportKey('jwk', kp.privateKey), name: '' };
    await writeJSON('mesh-id.json', me);
  }
  S.me = me; S.priv = await crypto.subtle.importKey('jwk', me.jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
}
async function keyFor(pub) {
  let k = S.keys.get(pub);
  if (!k) { const theirs = await crypto.subtle.importKey('raw', unb64u(pub), { name: 'ECDH', namedCurve: 'P-256' }, false, []); k = await crypto.subtle.deriveKey({ name: 'ECDH', public: theirs }, S.priv, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); S.keys.set(pub, k); }
  return k;
}
async function seal(msg, contact) {
  const iv = crypto.getRandomValues(new Uint8Array(12)); const aad = enc.encode(msg.mid + S.me.id + contact.id);
  const body = { text: msg.text || '', ts: msg.ts, name: S.me.name, file: msg.file || null };
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, await keyFor(contact.pub), enc.encode(JSON.stringify(body)));
  return { t: 'm', mid: msg.mid, from: S.me.id, to: contact.id, ttl: TTL, pub: S.me.pub, iv: b64u(iv), ct: b64u(ct) };
}
async function unseal(env) {
  if (await idOf(env.pub) !== env.from) throw new Error('sender mismatch');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(env.iv), additionalData: enc.encode(env.mid + env.from + env.to) }, await keyFor(env.pub), unb64u(env.ct));
  return JSON.parse(dec.decode(plain));
}

/* ---------- links ---------- */
const newPc = () => new RTCPeerConnection({ iceServers: [] });
const gathered = (pc) => new Promise((res) => {
  if (pc.iceGatheringState === 'complete') return res(); const t = setTimeout(res, 4000);
  pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
});
const sendHello = (link, re) => sendFrame(link, { t: 'hello', id: S.me.id, name: S.me.name, pub: S.me.pub, re: !!re });
function attach(pc, dc) {
  const link = { pc, dc, id: null, frags: new Map(), q: Promise.resolve() };
  // A greeting can be lost if it is sent the instant a channel opens, so each side repeats it until the other answers.
  const hello = () => { if (link.greeted) return; link.greeted = true; let tries = 0;
    const again = () => { if (link.dead || link.id || tries++ > 6) return; sendHello(link); setTimeout(again, 1200); }; again(); };
  dc.onopen = hello; if (dc.readyState === 'open') hello();      // an incoming channel can already be open when it is handed over
  dc.onmessage = (e) => onFrame(link, e.data).catch((err) => console.warn('bad frame', err));
  const gone = (why) => { console.debug('link dropped:', why); dropLink(link); }; dc.onclose = () => gone('channel closed');
  pc.addEventListener('connectionstatechange', () => {
    const st = pc.connectionState; clearTimeout(link.lostT);
    if (st === 'failed' || st === 'closed') gone(st);
    else if (st === 'disconnected') link.lostT = setTimeout(() => { if (pc.connectionState !== 'connected') gone('lost'); }, 8000);   // a short drop-out can recover
  });
  return link;
}
export async function makeOffer() {
  try { S.pending?.close(); } catch {} const pc = newPc(); attach(pc, pc.createDataChannel('internot'));
  await pc.setLocalDescription(await pc.createOffer()); await gathered(pc); S.pending = pc; S.lastPc = pc;
  return 'IN1O' + await pack(pc.localDescription.sdp);
}
export async function acceptOffer(code) {
  const pc = newPc(); S.lastPc = pc; pc.ondatachannel = (e) => attach(pc, e.channel);
  await pc.setRemoteDescription({ type: 'offer', sdp: await unpack(code.slice(4)) });
  await pc.setLocalDescription(await pc.createAnswer()); await gathered(pc);
  return 'IN1A' + await pack(pc.localDescription.sdp);
}
export async function acceptAnswer(code) {
  if (!S.pending) throw new Error('Show your own code first, then scan the reply.');
  await S.pending.setRemoteDescription({ type: 'answer', sdp: await unpack(code.slice(4)) }); S.pending = null;
}
/* ---------- nearby links: Bluetooth and Wi-Fi, found automatically (Android app only) ---------- */
const NB = { plugin: window.Capacitor ? window.capacitorExports?.registerPlugin?.('Nearby') : null, on: false, wired: false, links: new Map(), parts: new Map(), note: '' };
function nbLink(ep) {
  const dc = { readyState: 'open', bufferedAmount: 0,
    send(s) { const n = Math.ceil(s.length / 9000) || 1, k = rid(4); for (let i = 0; i < n; i++) NB.plugin.send({ endpoint: ep, data: `${k}|${i}|${n}|${s.slice(i * 9000, (i + 1) * 9000)}` }).catch((e) => console.warn('nearby send failed', e)); },
    close() { if (this.readyState === 'closed') return; this.readyState = 'closed'; NB.links.delete(ep); NB.plugin.disconnect({ endpoint: ep }).catch(() => {}); } };
  const link = attach({ connectionState: 'connected', addEventListener() {}, close() {} }, dc); link.nearby = ep; NB.links.set(ep, link); return link;
}
function nbData(ep, raw) {   // one message can arrive in several pieces: Bluetooth packets are small
  const link = NB.links.get(ep); if (!link) return; const a = raw.indexOf('|'), b = raw.indexOf('|', a + 1), c = raw.indexOf('|', b + 1); if (c < 0) return;
  const k = ep + raw.slice(0, a), i = +raw.slice(a + 1, b), n = +raw.slice(b + 1, c), d = raw.slice(c + 1); let full = d;
  if (n > 1) { if (!(n <= 64)) return; const p = NB.parts.get(k) || { got: 0, d: new Array(n) }; NB.parts.set(k, p); if (p.d[i] === undefined) { p.d[i] = d; p.got++; } if (p.got < n) return; NB.parts.delete(k); full = p.d.join(''); }
  link.dc.onmessage?.({ data: full });
}
async function nbStart() {
  if (!NB.plugin || NB.on || !S.me?.name) return;
  if (!NB.wired) { NB.wired = true;
    NB.plugin.addListener('connected', (e) => { nbLink(e.endpoint); render(); });
    NB.plugin.addListener('disconnected', (e) => { const l = NB.links.get(e.endpoint); NB.links.delete(e.endpoint); if (l) dropLink(l); render(); });
    NB.plugin.addListener('data', (e) => nbData(e.endpoint, e.data));
  }
  try { await NB.plugin.start({ name: S.me.name }); NB.on = true; NB.note = ''; try { localStorage.setItem('nearby', '1'); } catch {} }
  catch (e) { NB.note = e?.message || 'Nearby linking is not available on this phone.'; }
  render();
}
async function nbStop() { NB.on = false; try { localStorage.removeItem('nearby'); } catch {} for (const l of [...NB.links.values()]) dropLink(l); try { await NB.plugin.stop(); } catch {} render(); }

function dropLink(link) {
  if (link.dead) return; link.dead = true; try { link.dc.close(); link.pc.close(); } catch {}
  if (link.id && S.links.get(link.id) === link) {
    S.links.delete(link.id); const lost = [link.id]; for (const [id, r] of S.routes) if (r.via === link.id) { S.routes.delete(id); lost.push(id); }
    flood({ t: 'gone', ids: lost });          // tell the others these people can no longer be reached through this phone
  }
  render();
}
function sendFrame(link, obj) {
  link.q = link.q.then(async () => {
    if (link.dead || link.dc.readyState !== 'open') return; const s = JSON.stringify(obj);
    if (s.length <= FRAG) return link.dc.send(s);
    const fid = rid(6), n = Math.ceil(s.length / FRAG);
    for (let i = 0; i < n; i++) {
      while (link.dc.bufferedAmount > 1 << 20) await new Promise((r) => setTimeout(r, 30));
      if (link.dc.readyState !== 'open') return; link.dc.send(JSON.stringify({ t: 'frag', fid, i, n, d: s.slice(i * FRAG, (i + 1) * FRAG) }));
    }
  }).catch((e) => console.warn('send failed', e));
  return link.q;
}
function flood(obj, except) { for (const [id, link] of S.links) if (id !== except) sendFrame(link, obj); }

async function onFrame(link, raw) {
  let f = JSON.parse(raw);
  if (f.t === 'frag') {
    if (!(f.n > 0 && f.n <= 200)) return; let parts = link.frags.get(f.fid); if (!parts) { parts = { got: 0, d: new Array(f.n) }; link.frags.set(f.fid, parts); }
    if (parts.d[f.i] === undefined) { parts.d[f.i] = f.d; parts.got++; } if (parts.got < f.n) return;
    link.frags.delete(f.fid); f = JSON.parse(parts.d.join(''));
  }
  if (f.t === 'hello') {
    if (typeof f.pub !== 'string' || await idOf(f.pub) !== f.id || f.id === S.me.id) return dropLink(link);
    if (!f.re) sendHello(link, true);          // answer every first greeting, so the other side is sure to have ours
    if (link.id) return;
    const old = S.links.get(f.id); if (old && old !== link) dropLink(old);
    link.id = f.id; S.links.set(f.id, link); S.routes.delete(f.id); learn(f);
    const known = [...S.contacts.values()].filter((c) => c.id !== f.id && reach(c.id) !== 'none').map((c) => ({ id: c.id, name: c.name, pub: c.pub, hops: S.links.has(c.id) ? 1 : S.routes.get(c.id).hops }));
    if (known.length) sendFrame(link, { t: 'cards', list: known });
    flood({ t: 'cards', list: [{ id: f.id, name: f.name, pub: f.pub, hops: 1 }] }, f.id);
    linked(f); resend(); render(); return;
  }
  if (!link.id) return;                        // nothing else is accepted before the hello
  if (f.t === 'cards' && Array.isArray(f.list)) {
    const fresh = [];
    for (const c of f.list.slice(0, 200)) {
      if (!c || c.id === S.me.id || typeof c.pub !== 'string' || await idOf(c.pub) !== c.id) continue; const hops = (c.hops | 0) + 1; if (hops > TTL) continue;
      learn(c); if (S.links.has(c.id)) continue; const r = S.routes.get(c.id);
      if (!r || r.hops > hops) { S.routes.set(c.id, { via: link.id, hops }); fresh.push({ id: c.id, name: c.name, pub: c.pub, hops }); }
    }
    if (fresh.length) { flood({ t: 'cards', list: fresh }, link.id); resend(); render(); } return;
  }
  if (f.t === 'gone' && Array.isArray(f.ids)) {
    const lost = []; for (const id of f.ids.slice(0, 200)) { const r = S.routes.get(id); if (r && r.via === link.id) { S.routes.delete(id); lost.push(id); } }
    if (lost.length) { flood({ t: 'gone', ids: lost }, link.id); render(); } return;
  }
  if (f.t === 'm') {
    if (f.to === S.me.id) {
      if (S.seen.has(f.mid)) return flood({ t: 'a', aid: rid(6), mid: f.mid, from: S.me.id, to: f.from, ttl: TTL });   // sender may have missed our receipt
      S.seen.add(f.mid); const body = await unseal(f); learn({ id: f.from, name: body.name, pub: f.pub });
      S.msgs.push({ mid: f.mid, peer: f.from, out: false, text: String(body.text || ''), file: body.file || null, ts: body.ts || Date.now(), status: 'received' });
      flood({ t: 'a', aid: rid(6), mid: f.mid, from: S.me.id, to: f.from, ttl: TTL });
      if (S.open !== f.from || document.hidden || !$('view-mesh').classList.contains('active')) S.unread.set(f.from, (S.unread.get(f.from) || 0) + 1);
      save(); render(); return;
    }
    if (S.seen.has(f.mid)) return; S.seen.add(f.mid);
    if (f.ttl > 0) flood({ ...f, ttl: f.ttl - 1 }, link.id); return;
  }
  if (f.t === 'a') {
    if (S.seen.has('a' + f.aid)) return; S.seen.add('a' + f.aid);
    if (f.to === S.me.id) { const m = S.msgs.find((x) => x.out && x.mid === f.mid && x.peer === f.from); if (m && m.status !== 'delivered') { m.status = 'delivered'; save(); render(); } }
    else if (f.ttl > 0) flood({ ...f, ttl: f.ttl - 1 }, link.id);
  }
}
function learn(c) {
  const old = S.contacts.get(c.id); const name = String(c.name || old?.name || 'Phone ' + c.id.slice(0, 4)).slice(0, 40);
  if (!old || old.name !== name) { S.contacts.set(c.id, { id: c.id, name, pub: c.pub }); save(); }
}
const reach = (id) => S.links.has(id) ? 'direct' : S.routes.has(id) ? 'mesh' : 'none';

export async function send(to, text, file) {
  const contact = S.contacts.get(to); if (!contact) throw new Error('Unknown contact');
  const msg = { mid: rid(), peer: to, out: true, text: text || '', file: file || null, ts: Date.now(), status: 'waiting' };
  S.msgs.push(msg); S.seen.add(msg.mid);
  if (S.links.size) { flood(await seal(msg, contact)); if (reach(to) !== 'none') msg.status = 'sent'; }
  save(); render(); return msg.mid;
}
async function resend() {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const m of S.msgs) {
    if (!m.out || m.status === 'delivered' || m.ts < cutoff || !S.links.size) continue; const c = S.contacts.get(m.peer); if (!c) continue;
    flood(await seal(m, c)); if (m.status === 'waiting' && reach(m.peer) !== 'none') m.status = 'sent';
  }
  save();
}

/* ---------- QR codes ---------- */
export function drawQR(canvas, text) {
  const qr = window.qrcode(0, 'L'); qr.addData(text, 'Byte'); qr.make(); const n = qr.getModuleCount(), quiet = 4;
  const px = Math.max(2, Math.floor(Math.min(360, canvas.parentElement?.clientWidth || 320) * (window.devicePixelRatio > 1 ? 2 : 1) / (n + quiet * 2)));
  canvas.width = canvas.height = px * (n + quiet * 2); const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * px, (r + quiet) * px, px, px);
}
let jsqrLoading = null;
const loadJsQR = () => (jsqrLoading ||= new Promise((res, rej) => { const s = document.createElement('script'); s.src = './lib/jsqr.js'; s.onload = res; s.onerror = rej; document.head.append(s); }));
// Reads a QR code from a video frame or canvas. Uses the phone's built-in reader when there is one.
export async function readQR(source) {
  const w = source.videoWidth || source.width, h = source.videoHeight || source.height; if (!w || !h) return null;
  if ('BarcodeDetector' in window && !S.forceJsQR) { try { const hit = (await new BarcodeDetector({ formats: ['qr_code'] }).detect(source))[0]; if (hit) return hit.rawValue; return null; } catch { /* fall through */ } }
  await loadJsQR(); const c = (S.scanCanvas ||= document.createElement('canvas')); const k = Math.min(1, 900 / Math.max(w, h)); c.width = Math.round(w * k); c.height = Math.round(h * k);
  const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(source, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height); return window.jsQR(d.data, d.width, d.height)?.data || null;
}

/* ---------- linking screen ---------- */
function linkStatus(text, err) { const el = $('link-status'); el.textContent = text; el.className = 'hint' + (err ? ' err' : ''); }
function showCode(code) { $('link-qr-box').hidden = false; drawQR($('link-qr'), code); $('link-code').value = code; }
function stopScan() { clearTimeout(S.scanT); S.stream?.getTracks().forEach((t) => t.stop()); S.stream = null; $('link-video').hidden = true; }
async function startScan() {
  stopScan(); $('link-qr-box').hidden = true;
  try { S.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }); }
  catch { return linkStatus('The camera is not available. Paste the other phone’s code in the box below instead.', true); }
  const v = $('link-video'); v.srcObject = S.stream; v.hidden = false; await v.play().catch(() => {}); linkStatus('Point the camera at the code on the other phone.');
  const tick = async () => { if (!S.stream) return; let code = null; try { code = await readQR(v); } catch {} if (code && /^IN1[OA]/.test(code)) { stopScan(); return useCode(code); } S.scanT = setTimeout(tick, 250); };
  tick();
}
async function useCode(code) {
  code = code.trim();
  try {
    if (code.startsWith('IN1O')) { linkStatus('Making a reply code…'); showCode(await acceptOffer(code)); linkStatus('Now show this reply code to the first phone and let it scan.'); }
    else if (code.startsWith('IN1A')) { await acceptAnswer(code); $('link-qr-box').hidden = true; linkStatus('Connecting…'); setTimeout(() => { if (!$('mesh-link').hidden && $('link-status').textContent === 'Connecting…') linkStatus('Still not connected. Check that both phones are on the same Wi‑Fi or hotspot, then start again.', true); }, 12000); }
    else linkStatus('That is not an Internot link code.', true);
  } catch (e) { linkStatus(e?.message || 'That code could not be used. Start again.', true); }
}
function openLink() { $('mesh-link').hidden = false; $('link-qr-box').hidden = true; $('link-paste').value = ''; linkStatus('Phone 1 taps “Show my code”. Phone 2 taps “Scan a code”.'); }
function closeLink() { stopScan(); $('mesh-link').hidden = true; }
function linked(peer) { if (!$('mesh-link').hidden) closeLink(); toast(`Linked with ${S.contacts.get(peer.id)?.name || 'a phone'}`); }
function toast(text) { const t = $('mesh-toast'); t.textContent = text; t.hidden = false; clearTimeout(S.toastT); S.toastT = setTimeout(() => { t.hidden = true; }, 3500); }

/* ---------- screens ---------- */
const STATUS = { waiting: 'waiting for a link', sent: 'sent', delivered: 'delivered ✓' };
function render() {
  if (!S.me) return; const total = [...S.unread.values()].reduce((a, b) => a + b, 0); S.onUnread?.(total);
  $('mesh-setup').hidden = !!S.me.name; $('mesh-home').hidden = !S.me.name || !!S.open; $('mesh-convo').hidden = !S.open;
  if (!S.me.name) return;
  $('mesh-me').textContent = `${S.me.name} · ${S.links.size === 0 ? 'no phones linked' : S.links.size === 1 ? '1 phone linked' : S.links.size + ' phones linked'}`;
  $('mesh-nearby-box').hidden = !NB.plugin; $('mesh-nearby').textContent = NB.on ? 'Stop nearby linking' : 'Find nearby phones';
  $('mesh-nearby-note').textContent = NB.note || (NB.on ? `Looking for phones nearby that have Internot AI open. ${NB.links.size} linked this way.` : 'Links by itself with phones close by, over Bluetooth or shared Wi‑Fi. No internet and no codes.');
  const list = $('mesh-people'); list.textContent = '';
  const people = [...S.contacts.values()].sort((a, b) => (reach(b.id) !== 'none') - (reach(a.id) !== 'none') || a.name.localeCompare(b.name));
  for (const c of people) {
    const li = document.createElement('li'); li.tabIndex = 0; const info = document.createElement('div'); info.textContent = c.name; const sm = document.createElement('small'); const r = reach(c.id);
    sm.textContent = r === 'direct' ? 'linked to this phone' : r === 'mesh' ? `reachable through ${S.contacts.get(S.routes.get(c.id).via)?.name || 'another phone'}` : 'not reachable right now'; sm.className = r === 'none' ? '' : 'on'; info.append(sm);
    li.append(info); const n = S.unread.get(c.id); if (n) { const b = document.createElement('span'); b.className = 'badge'; b.textContent = n; li.append(b); }
    li.onclick = () => { S.open = c.id; S.unread.delete(c.id); render(); }; list.append(li);
  }
  $('mesh-none').hidden = people.length > 0;
  if (S.open) {
    const c = S.contacts.get(S.open); const r = reach(S.open); $('mesh-title').textContent = c?.name || 'Chat';
    $('mesh-sub').textContent = r === 'direct' ? 'Linked · encrypted' : r === 'mesh' ? 'Through the mesh · encrypted' : 'Not reachable. Messages wait on this phone.';
    const box = $('mesh-msgs'); box.textContent = '';
    for (const m of S.msgs.filter((x) => x.peer === S.open)) {
      const el = document.createElement('div'); el.className = 'msg mesh ' + (m.out ? 'out' : 'in');
      if (m.file) {
        const url = `data:${m.file.type || 'application/octet-stream'};base64,${m.file.data}`;
        if ((m.file.type || '').startsWith('image/')) { const img = document.createElement('img'); img.src = url; img.alt = m.file.name; el.append(img); }
        else { const a = document.createElement('a'); a.href = url; a.download = m.file.name; a.textContent = `📎 ${m.file.name}`; el.append(a); }
      }
      if (m.text) el.append(document.createTextNode(m.text));
      const meta = document.createElement('small'); meta.textContent = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + (m.out ? ' · ' + STATUS[m.status] : ''); el.append(meta); box.append(el);
    }
    box.scrollTop = box.scrollHeight;
  }
}

function wire() {
  $('mesh-name-save').onclick = async () => { const n = $('mesh-name').value.trim().slice(0, 40); if (!n) return; S.me.name = n; await writeJSON('mesh-id.json', S.me); render(); };
  $('mesh-link-open').onclick = openLink; $('link-close').onclick = closeLink;
  $('mesh-nearby').onclick = () => (NB.on ? nbStop() : nbStart());
  $('link-show').onclick = async () => { stopScan(); linkStatus('Making your code…'); try { showCode(await makeOffer()); linkStatus('Let the other phone scan this. Then tap “Scan a code” here to read its reply.'); } catch (e) { linkStatus('Could not make a code on this phone: ' + (e?.message || e), true); } };
  $('link-scan').onclick = startScan;
  $('link-use').onclick = () => { stopScan(); useCode($('link-paste').value); };
  $('link-copy').onclick = async () => { try { await navigator.clipboard.writeText($('link-code').value); linkStatus('Code copied.'); } catch { $('link-code').select(); } };
  $('mesh-back').onclick = () => { S.open = null; render(); };
  $('mesh-form').onsubmit = async (e) => { e.preventDefault(); const t = $('mesh-input').value.trim(); if (!t || !S.open) return; $('mesh-input').value = ''; await send(S.open, t); };
  $('mesh-attach').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f || !S.open) return;
    if (f.size > MAX_FILE) return toast('That file is too large. The limit is 3 MB.');
    await send(S.open, '', { name: f.name, type: f.type, size: f.size, data: b64(await f.arrayBuffer()) });
  };
}

export async function initMesh(root, onUnread) {
  S.root = root; S.onUnread = onUnread;
  if (!window.RTCPeerConnection || !crypto?.subtle) { $('mesh-setup').hidden = true; $('mesh-unsupported').hidden = false; return; }
  await loadIdentity();
  const saved = await readJSON('mesh.json', { contacts: [], msgs: [] });
  for (const c of saved.contacts) S.contacts.set(c.id, c);
  S.msgs = saved.msgs; for (const m of S.msgs) S.seen.add(m.mid);
  wire(); render();
  window.internotMesh = { S, NB, makeOffer, acceptOffer, acceptAnswer, send, drawQR, readQR, reach, nbLink, nbData };
  let auto = false; try { auto = !!localStorage.getItem('nearby'); } catch {}
  if (auto) nbStart();
}
export const meshShown = () => { if (S.open) { S.unread.delete(S.open); } render(); };
