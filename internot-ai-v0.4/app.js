// Internot AI — The Brain
// Everything here runs on the device. The only network call in this file is
// the optional one-time model download, which the user starts by hand.
import { Wllama } from './lib/wllama/index.js';
import { initMaps, mapShown } from './maps.js';
import { initMesh, meshShown } from './mesh.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MB = 1024 * 1024;
const MODEL_FILE = 'model.gguf';
const MAX_MODEL_BYTES = 2000 * MB; // browser limit for a single model file
const NATIVE = !!window.Capacitor;   // running inside the installed Android app
// Android app: the native engine uses all the fast processor cores. The web engine is the fallback.
const BRAIN = NATIVE ? window.capacitorExports?.registerPlugin?.('Brain') : null;

/* ---------- loader: the logo with a blinking exclamation mark ---------- */
let logoN = 2;
export function logoSVG(size, blink) {
  const id = 'lg' + logoN++;
  return `<svg class="logo${blink ? ' blink' : ''}" viewBox="0 0 512 512" width="${size}" height="${size}" aria-hidden="true"><mask id="${id}"><rect width="512" height="512" fill="#fff"/><rect x="206" width="100" height="512" fill="#000"/></mask><g mask="url(#${id})" fill="none" stroke="#d97757" stroke-width="42" stroke-linecap="round"><path d="M72 241A240 240 0 0 1 440 241"/><path d="M130 289A165 165 0 0 1 382 289"/><path d="M187 337A90 90 0 0 1 325 337"/></g><g class="bang" fill="#d97757"><rect x="228" y="100" width="56" height="236" rx="28"/><circle cx="256" cy="396" r="33"/></g></svg>`;
}
// Full-screen loader. loader('text') shows it, loader('text', 0.4) adds a progress bar, loader(null) hides it.
export function loader(text, frac) {
  const box = $('boot'); if (text == null) { box.hidden = true; return; }
  box.hidden = false; $('boot-text').textContent = text;
  $('boot-progress').hidden = frac == null; if (frac != null) $('boot-bar').style.width = Math.round(frac * 100) + '%';
}
window.internotLoader = loader;

const DEFAULTS = {
  cool: false, unload: true, gpu: false, max: 256, useDocs: false, temp: 0.6,
  system: 'You are The Brain, an offline assistant. Give short, clear answers. If you are not sure, say so.',
};
const COOL_BLOCK_TOKENS = 96;   // tokens generated between cool-down pauses
const COOL_PAUSE_MS = 2000;
const UNLOAD_AFTER_MS = 60000;

const state = {
  settings: { ...DEFAULTS }, messages: [], docs: [],
  modelMeta: null,      // { name, size } of the model stored on this device
  sessionBlob: null,    // model kept only for this session (when storage is unavailable)
  wllama: null, loaded: false, loading: null, generating: false, abort: null, hideTimer: null,
};

/* ---------- storage: private on-device folder (OPFS), falling back to memory ---------- */
let rootDir = null;
async function initStorage() {
  try { rootDir = await navigator.storage.getDirectory(); } catch { rootDir = null; }
  try { await navigator.storage.persist?.(); } catch {}
}
async function readJSON(name, fallback) {
  if (!rootDir) return fallback;
  try { const h = await rootDir.getFileHandle(name); return JSON.parse(await (await h.getFile()).text()); }
  catch { return fallback; }
}
async function writeJSON(name, value) {
  if (!rootDir) return;
  try {
    const h = await rootDir.getFileHandle(name, { create: true });
    const w = await h.createWritable(); await w.write(JSON.stringify(value)); await w.close();
  } catch (e) { console.warn('save failed', name, e); }
}
async function getStoredModel() {
  if (!rootDir) return null;
  try { return await (await rootDir.getFileHandle(MODEL_FILE)).getFile(); } catch { return null; }
}

/* ---------- status + helpers ---------- */
function setStatus(text, kind = '') { const el = $('status'); el.textContent = text; el.className = 'status ' + kind; $('brand-logo').classList.toggle('blink', kind === 'busy'); }
function fmtSize(bytes) { return bytes >= 1024 * MB ? (bytes / 1024 / MB).toFixed(2) + ' GB' : Math.round(bytes / MB) + ' MB'; }
function showProgress(frac) {
  $('progress').hidden = frac == null;
  if (frac != null) $('progress-bar').style.width = Math.round(frac * 100) + '%';
}

/* ---------- pre-flight memory check ---------- */
function preflight(sizeBytes) {
  if (sizeBytes > MAX_MODEL_BYTES) return { ok: false, reason: `This file is ${fmtSize(sizeBytes)}. Models must be under 2 GB to run here. Pick a smaller one (a "Q4" version of a 0.5B to 1.5B model works well).` };
  const ramGB = navigator.deviceMemory; // Chrome/Android only; capped at 8
  if (ramGB && sizeBytes * 2.2 > ramGB * 1024 * MB) return { ok: true, warn: `This phone reports about ${ramGB} GB of memory and the model is ${fmtSize(sizeBytes)}. It may be slow or close itself. A smaller model is safer.` };
  return { ok: true };
}

/* ---------- model: import, download, load, unload ---------- */
async function saveModelFromStream(stream, total, name) {
  if (!rootDir) throw new Error('This browser cannot store files for offline use.');
  const h = await rootDir.getFileHandle(MODEL_FILE + '.part', { create: true });
  const w = await h.createWritable();
  const reader = stream.getReader(); let done = 0;
  try {
    for (;;) {
      const { value, done: end } = await reader.read(); if (end) break;
      await w.write(value); done += value.byteLength;
      if (total) showProgress(done / total);
      setStatus(total ? `Saving model… ${Math.floor(done / total * 100)}% of ${fmtSize(total)}` : `Saving model… ${fmtSize(done)}`, 'busy');
    }
    await w.close();
  } catch (e) { try { await w.abort(); } catch {} throw e; }
  // Check it really is a GGUF file before replacing the current model.
  const part = await h.getFile();
  const magic = new TextDecoder().decode(await part.slice(0, 4).arrayBuffer());
  if (magic !== 'GGUF') { await rootDir.removeEntry(MODEL_FILE + '.part'); throw new Error('That is not a GGUF model file.'); }
  await unloadModel();
  try { await rootDir.removeEntry(MODEL_FILE); } catch {}
  if (h.move) await h.move(MODEL_FILE);
  else { // older browsers: copy then delete
    const dst = await (await rootDir.getFileHandle(MODEL_FILE, { create: true })).createWritable();
    await part.stream().pipeTo(dst); await rootDir.removeEntry(MODEL_FILE + '.part');
  }
  state.modelMeta = { name, size: done }; state.sessionBlob = null;
  await writeJSON('model.json', state.modelMeta);
}

async function importModel(file) {
  const check = preflight(file.size);
  if (!check.ok) return alertNote(check.reason);
  if (check.warn && !confirm(check.warn + '\n\nImport anyway?')) return;
  try {
    showProgress(0);
    await saveModelFromStream(file.stream(), file.size, file.name);
    setStatus('Model saved', 'ok');
  } catch (e) {
    // Could not persist (e.g. private browsing). Keep it for this session only.
    const magic = new TextDecoder().decode(await file.slice(0, 4).arrayBuffer());
    if (magic !== 'GGUF') { setStatus('Not a GGUF model file', 'err'); showProgress(null); return; }
    state.sessionBlob = file; state.modelMeta = { name: file.name, size: file.size, temporary: true };
    setStatus('Model ready for this session only', 'ok');
  }
  showProgress(null); renderModel();
}

async function downloadModel(url) {
  try {
    setStatus('Connecting…', 'busy'); showProgress(0);
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error('Download failed (' + res.status + ')');
    const total = Number(res.headers.get('content-length')) || 0;
    const check = preflight(total);
    if (!check.ok) throw new Error(check.reason);
    await saveModelFromStream(res.body, total, decodeURIComponent(url.split('/').pop().split('?')[0]));
    setStatus('Model saved', 'ok');
  } catch (e) { setStatus(e.message || 'Download failed', 'err'); }
  showProgress(null); renderModel();
}

async function ensureLoaded() {
  if (state.loaded) return;
  if (state.loading) return state.loading;
  state.loading = (async () => {
    if (state.native) {
      if (!state.modelMeta) throw new Error('NO_MODEL');
      setStatus('Waking The Brain…', 'busy');
      const r = await BRAIN.load({ ctx: 2048 }); state.loadInfo = r; state.loaded = true;
      setStatus('Ready · offline', 'ok'); renderModel(); return;
    }
    const blob = state.sessionBlob || await getStoredModel();
    if (!blob) throw new Error('NO_MODEL');
    setStatus('Waking The Brain…', 'busy');
    state.wllama = new Wllama({ default: './lib/wllama/wllama.wasm' }, { suppressNativeLog: true, allowOffline: true });
    // Older phones: a second, slower build of the engine that the library switches to by itself when it has to.
    const at = (p) => new URL(p, location.href).href; state.wllama.setCompat({ worker: at('./lib/wllama/compat/wllama.js'), wasm: at('./lib/wllama/compat/wllama.wasm') });
    // Half the cores, at most four: the small cores on phone chips slow everything down when they join in.
    const cores = navigator.hardwareConcurrency || 4; const n_threads = Math.max(1, Math.min(4, cores > 4 ? cores >> 1 : cores));
    await state.wllama.loadModel([blob], { n_ctx: 2048, n_threads, n_gpu_layers: state.settings.gpu ? 99 : 0 });
    state.loaded = true;
    setStatus('Ready · offline', 'ok'); renderModel();
  })();
  try { await state.loading; }
  catch (e) { try { await state.wllama?.exit(); } catch {} state.wllama = null; throw e; }
  finally { state.loading = null; }
}

async function unloadModel() {
  if (state.native) { if (state.loaded) { try { await BRAIN.unload(); } catch {} } state.loaded = false; setStatus(state.modelMeta ? 'Asleep · memory freed' : 'No model yet'); renderModel(); return; }
  if (!state.wllama) return;
  try { await state.wllama.exit(); } catch {}
  state.wllama = null; state.loaded = false;
  setStatus(state.modelMeta ? 'Asleep · memory freed' : 'No model yet'); renderModel();
}
// Load the model before the first question, so the answer starts straight away.
function warmUp() { if (state.modelMeta && !state.loaded && !state.loading && !document.hidden) ensureLoaded().catch((e) => { console.warn('warm-up failed', e); setStatus('Tap Send to wake The Brain'); }); }

/* ---------- documents: chunk + keyword retrieval (no network, no embeddings) ---------- */
const STOP = new Set('the a an and or of to in on for with is are was were be been it this that as at by from not but if then so we you they he she i me my our your their what which who how why when where do does did can could will would should have has had about into over under than too very just also'.split(' '));
const words = (s) => (s.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []).filter((w) => !STOP.has(w));
function chunkText(text, size = 700, overlap = 120) {
  const clean = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim(); const out = [];
  for (let i = 0; i < clean.length; i += size - overlap) {
    let end = Math.min(clean.length, i + size);
    if (end < clean.length) { const cut = clean.lastIndexOf(' ', end); if (cut > i + size / 2) end = cut; }
    out.push(clean.slice(i, end).trim()); if (end >= clean.length) break;
  }
  return out.filter(Boolean);
}
function retrieve(query, k = 3) {
  const q = [...new Set(words(query))]; if (!q.length) return [];
  const all = state.docs.flatMap((d) => d.chunks.map((c) => ({ title: d.title, text: c, w: words(c) })));
  if (!all.length) return [];
  const avg = all.reduce((n, c) => n + c.w.length, 0) / all.length;
  const scored = all.map((c) => {
    let score = 0;
    for (const term of q) {
      const tf = c.w.filter((w) => w === term).length; if (!tf) continue;
      const df = all.filter((x) => x.w.includes(term)).length;
      const idf = Math.log(1 + (all.length - df + 0.5) / (df + 0.5));
      score += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * c.w.length / avg)); // BM25
    }
    return { ...c, score };
  }).filter((c) => c.score > 0).sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}
async function addDoc(title, text, extra = {}) {
  text = text.trim(); if (!text) return;
  state.docs.push({ id: Date.now() + Math.random().toString(36).slice(2), title: title.trim() || 'Untitled', chars: text.length, chunks: chunkText(text), ...extra });
  await writeJSON('docs.json', state.docs); renderDocs();
}

/* ---------- chat ---------- */
function buildMessages(question) {
  let system = state.settings.system.trim();
  let sources = [];
  if (state.settings.useDocs) {
    const hits = retrieve(question);
    if (hits.length) {
      sources = [...new Set(hits.map((h) => h.title))];
      system += '\n\nUse these passages from the user\'s documents to answer. If the answer is not in them, say so.\n\n' +
        hits.map((h, i) => `[${i + 1}] ${h.title}:\n${h.text}`).join('\n\n');
    }
  }
  const history = state.messages.slice(-6).map(({ role, content }) => ({ role, content })); // keep the prompt small for small phones
  return { msgs: [{ role: 'system', content: system }, ...history], sources };
}

async function send(question) {
  if (state.generating) return;
  state.messages.push({ role: 'user', content: question }); renderMessages();
  const { msgs, sources } = buildMessages(question);
  const reply = { role: 'assistant', content: '', sources };
  state.generating = true; state.abort = new AbortController(); toggleBusy(true);
  try {
    await ensureLoaded();
    state.messages.push(reply); const bubble = renderMessages();
    const think = document.createElement('span'); think.className = 'think'; think.innerHTML = logoSVG(22, true) + 'Thinking…'; bubble.append(think);
    const maxTotal = Number(state.settings.max); let used = 0;
    if (state.native) {   // one call; the answer streams in piece by piece
      setStatus('Thinking…', 'busy'); const id = Math.random().toString(36).slice(2);
      state.onPiece = (p) => { if (p.id !== id) return; reply.content += p.text; think.remove(); bubble.firstChild.textContent = reply.content; scrollDown(); };
      state.abort.signal.addEventListener('abort', () => BRAIN.stop().catch(() => {}));
      try { state.lastStats = await BRAIN.generate({ messages: msgs, maxTokens: maxTotal, temperature: state.settings.temp, id }); }
      finally { state.onPiece = null; }
      if (state.abort.signal.aborted) throw Object.assign(new Error('stopped'), { name: 'AbortError' });
    }
    else for (;;) {
      const block = state.settings.cool ? Math.min(COOL_BLOCK_TOKENS, maxTotal - used) : maxTotal;
      // After a cool-down pause the partial answer is sent back so the model continues it.
      const req = reply.content ? [...msgs, { role: 'assistant', content: reply.content }] : msgs;
      setStatus('Thinking…', 'busy');
      let finish = null; const base = reply.content;
      for (let attempt = 0; ; attempt++) {
        try {
          const stream = await state.wllama.createChatCompletion({ messages: req, max_tokens: block, temperature: state.settings.temp, stream: true, abortSignal: state.abort.signal });
          let round = '';
          for await (const chunk of stream) {
            const c = chunk.choices?.[0]; if (!c) continue;
            if (c.delta?.content) {
              round += c.delta.content; used++;
              // Some models echo the partial answer back before continuing it; never show it twice.
              reply.content = round.startsWith(base) ? round : base.startsWith(round) ? base : base + round;
              think.remove(); bubble.firstChild.textContent = reply.content; scrollDown();
            }
            if (c.finish_reason) finish = c.finish_reason;
          }
          break;
        } catch (e) {
          // The engine occasionally drops a request. It stays usable, so repeat this block from where it began.
          if (state.abort.signal.aborted || e?.name === 'AbortError' || attempt >= 2) throw e;
          console.warn('retrying block', e); reply.content = base; bubble.firstChild.textContent = base;
        }
      }
      if (finish !== 'length' || used >= maxTotal || !state.settings.cool) break;
      setStatus('Cooling down…', 'busy'); await sleep(COOL_PAUSE_MS);
      if (state.abort.signal.aborted) break;
    }
    setStatus('Ready · offline', 'ok');
  } catch (e) {
    if (e?.message === 'NO_MODEL') { note('No model on this device yet. Open the Brain tab and import one.'); setStatus('No model yet'); }
    else if (e?.name === 'AbortError' || state.abort.signal.aborted) setStatus('Stopped', 'ok');
    else { console.error(e); note('The Brain could not finish: ' + (e?.message || e) + '. If this keeps happening, try a smaller model.'); setStatus('Error', 'err'); await unloadModel(); }
  }
  if (!reply.content) state.messages = state.messages.filter((m) => m !== reply);
  state.generating = false; state.abort = null; toggleBusy(false);
  renderMessages(); await writeJSON('chat.json', state.messages);
}

/* ---------- rendering ---------- */
function scrollDown() { const m = $('messages'); m.scrollTop = m.scrollHeight; }
function note(text) { state.messages.push({ role: 'note', content: text }); renderMessages(); }
function alertNote(text) { setStatus('Cannot use that file', 'err'); alert(text); }
function toggleBusy(busy) { $('send').hidden = busy; $('stop').hidden = !busy; }
function renderMessages() {
  const box = $('messages'); box.textContent = ''; let last = null;
  if (!state.messages.length) {
    const e = document.createElement('div'); e.className = 'empty';
    e.innerHTML = '<h1>The Brain</h1><p>An assistant that runs on this device. No data, no airtime, no server.</p>';
    box.append(e); return null;
  }
  for (const m of state.messages) {
    const el = document.createElement('div'); el.className = 'msg ' + m.role;
    el.append(document.createTextNode(m.content));
    if (m.sources?.length) { const s = document.createElement('span'); s.className = 'sources'; s.textContent = 'From: ' + m.sources.join(', '); el.append(s); }
    box.append(el); last = el;
  }
  scrollDown(); return last;
}
function renderDocs() {
  const list = $('doc-list'); list.textContent = '';
  for (const d of state.docs) {
    const li = document.createElement('li'); const info = document.createElement('div'); info.className = 'doc-info';
    if (d.thumb) { const im = document.createElement('img'); im.className = 'doc-thumb'; im.src = d.thumb; im.alt = ''; li.append(im); }
    else { const ic = document.createElement('span'); ic.className = 'doc-kind'; ic.textContent = (d.kind || 'text').slice(0, 4).toUpperCase(); li.append(ic); }
    info.append(document.createTextNode(d.title)); const sm = document.createElement('small');
    sm.textContent = `${d.chars.toLocaleString()} characters · ${d.chunks.length} passages`; info.append(sm);
    const peek = document.createElement('details'); const su = document.createElement('summary'); su.textContent = 'Show text'; const pre = document.createElement('p'); pre.className = 'doc-peek';
    peek.ontoggle = () => { if (peek.open && !pre.textContent) pre.textContent = d.chunks.slice(0, 4).join('\n…\n').slice(0, 2400); }; peek.append(su, pre); info.append(peek);
    const del = document.createElement('button'); del.className = 'danger'; del.textContent = 'Remove';
    del.onclick = async () => { state.docs = state.docs.filter((x) => x.id !== d.id); await writeJSON('docs.json', state.docs); renderDocs(); };
    li.append(info, del); list.append(li);
  }
}
function renderModel() {
  const m = state.modelMeta; const info = $('model-info'); info.textContent = '';
  if (!m) info.textContent = 'No model on this device yet.';
  else {
    info.textContent = m.name; const sm = document.createElement('small');
    sm.textContent = `${fmtSize(m.size)} · ${state.loaded ? 'awake (in memory)' : 'asleep'}${m.temporary ? ' · this session only' : ''}`; info.append(sm);
  }
  $('model-unload').hidden = !state.loaded; $('model-delete').hidden = !m;
}
function renderDevice() {
  const rows = [
    ['Memory', navigator.deviceMemory ? `about ${navigator.deviceMemory} GB` : 'not reported by this browser'],
    ['Processor cores', String(navigator.hardwareConcurrency || '?')],
    state.native ? ['AI engine', `native, ${state.native.threads} of ${state.native.cores} cores`] : ['AI engine', self.crossOriginIsolated ? 'web, several cores' : NATIVE ? 'web, one core (slower)' : 'web, one core — reopen the app once for more'],
    ['Offline storage', rootDir ? 'available' : 'not available (private tab?)'],
    ['Works offline', NATIVE || navigator.serviceWorker?.controller ? 'yes' : 'after next reopen'],
  ];
  const box = $('device'); box.textContent = '';
  for (const [k, v] of rows) { const d = document.createElement('div'); const a = document.createElement('span'); a.textContent = k; const b = document.createElement('span'); b.textContent = v; d.append(a, b); box.append(d); }
}
function applySettingsToUI() {
  const s = state.settings;
  $('set-cool').checked = s.cool; $('set-unload').checked = s.unload; $('set-gpu').checked = s.gpu;
  $('set-max').value = String(s.max); $('set-system').value = s.system; $('use-docs').checked = s.useDocs;
}
async function saveSettings() {
  const s = state.settings;
  s.cool = $('set-cool').checked; s.unload = $('set-unload').checked; s.gpu = $('set-gpu').checked;
  s.max = Number($('set-max').value); s.system = $('set-system').value; s.useDocs = $('use-docs').checked;
  await writeJSON('settings.json', s);
}

/* ---------- wiring ---------- */
function wire() {
  document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + b.dataset.view));
    if (b.dataset.view === 'model') renderDevice();
    if (b.dataset.view === 'map') mapShown();
    if (b.dataset.view === 'mesh') meshShown();
  });
  const input = $('input');
  input.oninput = () => { input.style.height = 'auto'; input.style.height = input.scrollHeight + 'px'; };
  input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); $('composer').requestSubmit(); } };
  $('composer').onsubmit = (e) => { e.preventDefault(); const q = input.value.trim(); if (!q || state.generating) return; input.value = ''; input.style.height = 'auto'; send(q); };
  $('stop').onclick = () => state.abort?.abort();

  $('model-file').parentElement.addEventListener('click', async (e) => {   // native engine: the phone's own file picker copies the model in
    if (!state.native) return; e.preventDefault();
    try { setStatus('Copying model…', 'busy'); loader('Copying the model. This takes a minute.'); const m = await BRAIN.pickModel(); await unloadModel(); state.modelMeta = m; setStatus('Model saved', 'ok'); }
    catch (err) { setStatus(err?.message === 'cancelled' ? 'Ready' : (err?.message || 'Could not copy the model'), err?.message === 'cancelled' ? '' : 'err'); }
    loader(null); renderModel();
  });
  $('model-file').onchange = async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) await importModel(f); };
  $('model-download').onclick = () => { const u = $('model-url').value.trim(); if (u) downloadModel(u); };
  $('model-unload').onclick = unloadModel;
  $('model-delete').onclick = async () => {
    if (!confirm('Delete the model from this device?')) return;
    await unloadModel(); if (state.native) { try { await BRAIN.deleteModel(); } catch {} } try { await rootDir?.removeEntry(MODEL_FILE); await rootDir?.removeEntry('model.json'); } catch {}
    state.modelMeta = null; state.sessionBlob = null; setStatus('No model yet'); renderModel();
  };

  $('doc-save').onclick = async () => { await addDoc($('doc-title').value, $('doc-text').value); $('doc-title').value = ''; $('doc-text').value = ''; };
  $('doc-file').onchange = async (e) => {
    const { readDoc, thumbOf } = await import('./docs-read.js'); const st = $('doc-status'); const notes = [];
    for (const f of e.target.files) {
      try { st.textContent = `Reading ${f.name}…`; const text = (await readDoc(f, (t) => { st.textContent = `${f.name}: ${t}`; })).slice(0, 600000);
        if (text.replace(/\s/g, '').length < 12) notes.push(`${f.name}: no readable text was found.`); else { await addDoc(f.name.replace(/\.[^.]+$/, ''), text, { thumb: await thumbOf(f), kind: (f.name.match(/\.([a-z0-9]{1,5})$/i) || [, 'text'])[1].toLowerCase() }); notes.push(`${f.name}: added.`); } }
      catch (err) { console.warn('document unreadable', err); notes.push(`${f.name}: ${err?.message || 'could not be read'}`); }
    }
    st.textContent = notes.join(' '); e.target.value = '';
  };

  ['set-cool', 'set-unload', 'set-gpu', 'set-max', 'set-system', 'use-docs'].forEach((id) => $(id).onchange = saveSettings);
  $('clear-chat').onclick = async () => { if (!confirm('Clear the chat history on this device?')) return; state.messages = []; renderMessages(); await writeJSON('chat.json', []); };

  // Memory guardrail: free the model after the app has been in the background for a minute.
  document.addEventListener('visibilitychange', () => {
    clearTimeout(state.hideTimer);
    if (!document.hidden) warmUp();
    if (document.hidden && state.settings.unload) state.hideTimer = setTimeout(() => { if (document.hidden && !state.generating && !state.loading) unloadModel(); }, UNLOAD_AFTER_MS);
  });
}

async function registerSW() {
  if (NATIVE || !('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('./sw.js');
    await navigator.serviceWorker.ready;
    // First visit: reload once so the page is served with the headers that switch on fast mode.
    if (!self.crossOriginIsolated && !sessionStorage.getItem('reloaded')) { sessionStorage.setItem('reloaded', '1'); location.reload(); }
  } catch (e) { console.warn('offline mode unavailable', e); }
}

(async function start() {
  try { await window.internotSetup; } catch {}   // full Android app: first-launch unpacking of the built-in model
  await initStorage();
  state.settings = { ...DEFAULTS, ...(await readJSON('settings.json', {})) };
  state.messages = (await readJSON('chat.json', [])).filter((m) => m.role !== 'note');
  state.docs = await readJSON('docs.json', []);
  if (BRAIN) { try { const i = await BRAIN.info(); if (i.available) { state.native = i; state.modelMeta = i.model || null; BRAIN.addListener('progress', (p) => loader('Copying the model…', p.total > 0 ? p.done / p.total : undefined)); BRAIN.addListener('piece', (p) => state.onPiece?.(p)); } } catch (e) { console.warn('native engine unavailable', e); } }
  if (!state.native) { const stored = await getStoredModel(); if (stored) state.modelMeta = (await readJSON('model.json', null)) || { name: MODEL_FILE, size: stored.size }; }
  else { $('model-download').closest('details').hidden = true; try { await rootDir?.removeEntry(MODEL_FILE); } catch {} }   // a web-engine copy is no longer needed
  wire(); applySettingsToUI(); renderMessages(); renderDocs(); renderModel(); renderDevice();
  setStatus(state.modelMeta ? 'Waking The Brain…' : 'No model yet', state.modelMeta ? 'busy' : '');
  window.internot = state; // handy when debugging
  initMaps(rootDir).catch((e) => console.error('maps failed to start', e));
  initMesh(rootDir, (n) => { const b = $('mesh-badge'); b.hidden = !n; b.textContent = n || ''; }).catch((e) => console.error('chat failed to start', e));
  // Maps and models after install, sharing with no data, and the optional server (adverts, update notices, count).
  const hooks = { BRAIN, rootDir, setStatus, unloadModel, importModel, native: () => !!state.native,
    refreshModel: async () => { if (state.native) { try { state.modelMeta = (await BRAIN.info()).model || null; } catch {} } renderModel(); },
    adoptModel: async (handle, name, size) => {   // web app: a finished download becomes the model, without copying it again
      await unloadModel(); try { await rootDir.removeEntry(MODEL_FILE); } catch {}
      if (handle.move) await handle.move(MODEL_FILE); else { const dst = await (await rootDir.getFileHandle(MODEL_FILE, { create: true })).createWritable(); await (await handle.getFile()).stream().pipeTo(dst); await rootDir.removeEntry(handle.name); }
      state.modelMeta = { name, size }; state.sessionBlob = null; await writeJSON('model.json', state.modelMeta); renderModel(); } };
  import('./packs.js').then((m) => m.initPacks(hooks)).catch((e) => console.error('downloads failed to start', e));
  import('./online.js').then((m) => m.initOnline()).catch((e) => console.error('online features failed to start', e));
  registerSW();
  loader(null);
  setTimeout(warmUp, 300);
})();
