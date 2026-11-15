// Full Android app, first launch: unpack the AI model that ships inside the app into app storage.
// Runs before the app starts; the app waits for window.internotSetup.
window.internotSetup = (async () => {
  // Native engine: the model is copied once from inside the app to the app's own storage.
  const brain = window.Capacitor && window.capacitorExports?.registerPlugin?.('Brain');
  if (brain) {
    try {
      const info = await brain.info();
      if (info.available && info.bundled) {
        if (info.model || localStorage.getItem('bundledNative')) return;
        const text = document.getElementById('boot-text'), bar = document.getElementById('boot-bar'); document.getElementById('boot-progress').hidden = false;
        text.textContent = 'Getting the AI model ready. One time only, no internet used.';
        const h = await brain.addListener('progress', (p) => { if (p.total > 0) bar.style.width = Math.min(100, p.done / p.total * 100) + '%'; });
        try { await brain.prepareBundled(); localStorage.setItem('bundledNative', '1'); } finally { h.remove?.(); document.getElementById('boot-progress').hidden = true; }
        return;
      }
    } catch (e) { console.warn('native setup failed, using the web engine', e); }
  }
  let list; try { const r = await fetch('./bundled/list.json'); if (!r.ok) return; list = await r.json(); } catch { return; }
  const root = await navigator.storage.getDirectory();
  const read = async (n) => { try { return JSON.parse(await (await (await root.getFileHandle(n)).getFile()).text()); } catch { return null; } };
  const write = async (n, v) => { const w = await (await root.getFileHandle(n, { create: true })).createWritable(); await w.write(JSON.stringify(v)); await w.close(); };
  const done = (await read('bundled.json')) || {};
  const jobs = list.filter((j) => !done[j.to]); if (!jobs.length) return;
  const text = document.getElementById('boot-text'), bar = document.getElementById('boot-bar');
  document.getElementById('boot-progress').hidden = false;
  try {
    for (const j of jobs) {
      text.textContent = 'Getting the ' + j.label + ' ready. One time only, no internet used.';
      const res = await fetch('./bundled/' + j.file); if (!res.ok || !res.body) throw new Error(j.file + ' missing');
      const w = await (await root.getFileHandle(j.to, { create: true })).createWritable(); const rd = res.body.getReader(); let n = 0;
      for (;;) { const { value, done: end } = await rd.read(); if (end) break; await w.write(value); n += value.byteLength; bar.style.width = Math.min(100, n / j.size * 100) + '%'; }
      await w.close(); if (n !== j.size) throw new Error(j.file + ' incomplete');
      if (j.meta) await write(j.meta, { name: j.name, size: n });
      done[j.to] = true; await write('bundled.json', done);
    }
  } catch (e) { text.textContent = 'Setup could not finish (' + e.message + '). Free some storage and reopen the app.'; await new Promise((r) => setTimeout(r, 6000)); }
  document.getElementById('boot-progress').hidden = true;
})();
