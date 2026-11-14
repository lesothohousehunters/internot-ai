// Internot AI — The Brain (v0.1)
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

const DEFAULTS = {
  cool: true, unload: true, gpu: false, max: 512, useDocs: false, temp: 0.6,
  system: 'You are The Brain, a helpful offline assistant inside Internot AI. Answer clearly and briefly. If you are not sure, say so.',
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
function setStatus(text, kind = '') { const el = $('status'); el.textContent = text; el.className = 'status ' + kind; }
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
      setStatus(`Saving model… ${fmtSize(done)}`, 'busy');
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
    const blob = state.sessionBlob || await getStoredModel();
    if (!blob) throw new Error('NO_MODEL');
    setStatus('Waking The Brain…', 'busy');
    state.wllama = new Wllama({ default: './lib/wllama/wllama.wasm' }, { suppressNativeLog: true, allowOffline: true });
    await state.wllama.loadModel([blob], { n_ctx: 4096, n_gpu_layers: state.settings.gpu ? 99 : 0 });
    state.loaded = true;
    setStatus('Ready · offline', 'ok'); renderModel();
  })();
  try { await state.loading; }
  catch (e) { try { await state.wllama?.exit(); } catch {} state.wllama = null; throw e; }
  finally { state.loading = null; }
}

async function unloadModel() {
  if (!state.wllama) return;
  try { await state.wllama.exit(); } catch {}
  state.wllama = null; state.loaded = false;
  setStatus(state.modelMeta ? 'Asleep · memory freed' : 'No model yet'); renderModel();
}

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
async function addDoc(title, text) {
  text = text.trim(); if (!text) return;
  state.docs.push({ id: Date.now() + Math.random().toString(36).slice(2), title: title.trim() || 'Untitled', chars: text.length, chunks: chunkText(text) });
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
  const history = state.messages.slice(-8).map(({ role, content }) => ({ role, content })); // keep the prompt small for small phones
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
    const maxTotal = Number(state.settings.max); let used = 0;
    for (;;) {
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
              bubble.firstChild.textContent = reply.content; scrollDown();
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
    const li = document.createElement('li'); const info = document.createElement('div');
    info.textContent = d.title; const sm = document.createElement('small');
    sm.textContent = `${d.chars.toLocaleString()} characters · ${d.chunks.length} passages`; info.append(sm);
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
    ['Fast mode (multi-thread)', self.crossOriginIsolated ? 'on' : 'off — reopen the app once to switch on'],
    ['Offline storage', rootDir ? 'available' : 'not available (private tab?)'],
    ['Works offline', navigator.serviceWorker?.controller ? 'yes' : 'after next reopen'],
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

  $('model-file').onchange = async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) await importModel(f); };
  $('model-download').onclick = () => { const u = $('model-url').value.trim(); if (u) downloadModel(u); };
  $('model-unload').onclick = unloadModel;
  $('model-delete').onclick = async () => {
    if (!confirm('Delete the model from this device?')) return;
    await unloadModel(); try { await rootDir?.removeEntry(MODEL_FILE); await rootDir?.removeEntry('model.json'); } catch {}
    state.modelMeta = null; state.sessionBlob = null; setStatus('No model yet'); renderModel();
  };

  $('doc-save').onclick = async () => { await addDoc($('doc-title').value, $('doc-text').value); $('doc-title').value = ''; $('doc-text').value = ''; };
  $('doc-file').onchange = async (e) => { for (const f of e.target.files) await addDoc(f.name.replace(/\.[^.]+$/, ''), await f.text()); e.target.value = ''; };

  ['set-cool', 'set-unload', 'set-gpu', 'set-max', 'set-system', 'use-docs'].forEach((id) => $(id).onchange = saveSettings);
  $('clear-chat').onclick = async () => { if (!confirm('Clear the chat history on this device?')) return; state.messages = []; renderMessages(); await writeJSON('chat.json', []); };

  // Memory guardrail: free the model after the app has been in the background for a minute.
  document.addEventListener('visibilitychange', () => {
    clearTimeout(state.hideTimer);
    if (document.hidden && state.settings.unload) state.hideTimer = setTimeout(() => { if (document.hidden && !state.generating && !state.loading) unloadModel(); }, UNLOAD_AFTER_MS);
  });
}

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('./sw.js');
    await navigator.serviceWorker.ready;
    // First visit: reload once so the page is served with the headers that switch on fast mode.
    if (!self.crossOriginIsolated && !sessionStorage.getItem('reloaded')) { sessionStorage.setItem('reloaded', '1'); location.reload(); }
  } catch (e) { console.warn('offline mode unavailable', e); }
}

(async function start() {
  await initStorage();
  state.settings = { ...DEFAULTS, ...(await readJSON('settings.json', {})) };
  state.messages = (await readJSON('chat.json', [])).filter((m) => m.role !== 'note');
  state.docs = await readJSON('docs.json', []);
  const stored = await getStoredModel();
  if (stored) state.modelMeta = (await readJSON('model.json', null)) || { name: MODEL_FILE, size: stored.size };
  wire(); applySettingsToUI(); renderMessages(); renderDocs(); renderModel(); renderDevice();
  setStatus(state.modelMeta ? 'Asleep · tap Send to wake' : 'No model yet');
  window.internot = state; // handy when debugging
  initMaps(rootDir).catch((e) => console.error('maps failed to start', e));
  initMesh(rootDir, (n) => { const b = $('mesh-badge'); b.hidden = !n; b.textContent = n || ''; }).catch((e) => console.error('chat failed to start', e));
  registerSW();
})();
