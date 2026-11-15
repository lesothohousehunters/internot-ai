// Only in the test build that runs on the emulator during the automatic build. Never shipped.
(async () => {
  const log = (k, v) => console.log('INTERNOT-TEST ' + k + ' ' + JSON.stringify(v));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name) => { log('shot', name); await wait(6000); };
  const tab = (v) => document.querySelector(`.tabs [data-view=${v}]`).click();
  window.addEventListener('error', (e) => log('jserror', e.message + ' @' + (e.filename || '').split('/').pop() + ':' + e.lineno));
  window.addEventListener('unhandledrejection', (e) => log('rejection', String(e.reason && e.reason.message || e.reason)));
  try {
    const brainPlugin = window.capacitorExports?.registerPlugin?.('Brain');
    try { log('brain-info', await brainPlugin.info()); } catch (e) { log('brain-info', { error: String(e && e.message || e) }); }
    log('env', { ua: navigator.userAgent, isolated: self.crossOriginIsolated, webSpeech: 'speechSynthesis' in window, cores: navigator.hardwareConcurrency, memory: navigator.deviceMemory, jspi: 'Suspending' in WebAssembly, core: !!window.capacitorExports, plugins: (window.Capacitor?.PluginHeaders || []).map((h) => h.name) });
    await shot('first-launch');
    for (let i = 0; i < 600 && !(window.internot && window.internotMap && window.internotMap.map && window.internotMesh); i++) await wait(500);
    log('map', { name: internotMap.map?.name, stub: !!internotMap.map?.stub, roads: internotMap.map?.W, world: !!internotMap.world });
    const t1 = performance.now(); for (let i = 0; i < 600 && internot.modelMeta && !internot.loaded; i++) await wait(500);
    log('model', { meta: internot.modelMeta, loaded: internot.loaded, loadMs: Math.round(performance.now() - t1), status: document.getElementById('status').textContent });
    await shot('brain-ready');
    const t0 = performance.now(); let first = null;
    document.getElementById('input').value = 'What is the capital of Lesotho?'; document.getElementById('composer').requestSubmit();
    for (let i = 0; i < 700; i++) { await wait(500); const m = internot.messages.at(-1); if (first == null && m && m.role === 'assistant' && m.content) first = performance.now() - t0; if (!internot.generating && i > 2) break; }
    const last = internot.messages.at(-1) || {};
    log('chat', { firstWordMs: first == null ? null : Math.round(first), totalMs: Math.round(performance.now() - t0), role: last.role, answer: (last.content || '').slice(0, 600), status: document.getElementById('status').textContent });
    await shot('brain-answer');
    log('engine', { native: !!internot.native, loadInfo: internot.loadInfo || null, stats: internot.lastStats || null });
    { const t2 = performance.now(); let f2 = null; document.getElementById('input').value = 'Name one mountain there.'; document.getElementById('composer').requestSubmit();
      for (let i = 0; i < 700; i++) { await wait(300); const m = internot.messages.at(-1); if (f2 == null && m && m.role === 'assistant' && m.content) f2 = performance.now() - t2; if (!internot.generating && i > 2) break; }
      log('chat2', { firstWordMs: f2 == null ? null : Math.round(f2), totalMs: Math.round(performance.now() - t2), answer: (internot.messages.at(-1)?.content || '').slice(0, 300), stats: internot.lastStats || null }); }
    tab('map'); await wait(1500);
    const find = (n) => internotMap.map.placeList.find((p) => p.lower === n); const a = find('maseru'), b = find('mafeteng');
    const ok = !!(a && b && internotMap.api.makeRoute(a, b)); if (ok) { internotMap.view.cx = (a.x + b.x) / 2; internotMap.view.cy = (a.y + b.y) / 2; internotMap.view.z = 9.5; internotMap.api.paint(); }
    log('route', { ok, km: internotMap.route && Math.round(internotMap.route.total / 1000), steps: internotMap.route && internotMap.route.steps.length });
    await shot('map-route');
    try { log('voice', await internotMap.api.speakTest('Route ready. Head south on Main South.')); } catch (e) { log('voice', { error: String(e && e.message || e) }); }
    // satellite pictures, Maseru close up
    if (find('maseru')) { internotMap.route = null; internotMap.view.cx = a.x; internotMap.view.cy = a.y; internotMap.view.z = 13; internotMap.api.setSat(true); await wait(4000); }
    log('sat', { local: internotMap.api.SAT.local, tiles: [...internotMap.api.SAT.tiles.values()].filter((t) => t.img).length });
    await shot('map-satellite');
    internotMap.api.setSat(false);
    // a location pasted from WhatsApp
    const box = document.getElementById('map-search'); box.value = 'https://maps.google.com/maps?q=-29.31678%2C27.48226&z=17&hl=en'; box.dispatchEvent(new Event('input'));
    await wait(400); document.querySelector('#map-results li')?.click(); await wait(1500);
    log('paste', { parsed: internotMap.api.parseLocation(box.value), sheet: document.getElementById('map-sheet').textContent.slice(0, 120) });
    await shot('map-pasted');
    document.querySelector('#map-sheet button:last-child')?.click();
    tab('mesh'); await wait(800);
    if (!internotMesh.S.me.name) { document.getElementById('mesh-name').value = 'Tester'; document.getElementById('mesh-name-save').click(); await wait(800); }
    document.getElementById('mesh-nearby').click(); await wait(9000);
    log('nearby', { plugin: !!internotMesh.NB.plugin, on: internotMesh.NB.on, note: internotMesh.NB.note });
    await shot('chat-nearby');
    // documents of every kind, added the way a person would
    tab('docs'); await wait(500);
    try {
      const names = await (await fetch('./testdocs/list.json')).json(); const dt = new DataTransfer();
      for (const n of names) { const b = await (await fetch('./testdocs/' + n)).blob(); dt.items.add(new File([b], n, { type: b.type })); }
      const input = document.getElementById('doc-file'); input.files = dt.files; const td = performance.now(); input.dispatchEvent(new Event('change'));
      for (let i = 0; i < 400; i++) { await wait(500); const st = document.getElementById('doc-status').textContent; if ((st.match(/: /g) || []).length >= names.length && !/Reading/.test(st)) break; }
      log('docs', { ms: Math.round(performance.now() - td), status: document.getElementById('doc-status').textContent, docs: internot.docs.map((d) => [d.title + '.' + d.kind, d.chars, !!d.thumb, d.chunks[0].slice(0, 50)]) });
    } catch (e) { log('docs', { error: String(e && e.stack || e) }); }
    await shot('docs');
    tab('model'); await shot('setup');
  } catch (e) { log('failed', String(e && e.stack || e)); }
  log('done', 1);
})();
