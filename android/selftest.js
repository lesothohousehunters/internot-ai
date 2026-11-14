// Only in the test build that runs on the emulator during the automatic build. Never shipped.
(async () => {
  const log = (k, v) => console.log('INTERNOT-TEST ' + k + ' ' + JSON.stringify(v));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name) => { log('shot', name); await wait(6000); };
  const tab = (v) => document.querySelector(`.tabs [data-view=${v}]`).click();
  window.addEventListener('error', (e) => log('jserror', e.message + ' @' + (e.filename || '').split('/').pop() + ':' + e.lineno));
  window.addEventListener('unhandledrejection', (e) => log('rejection', String(e.reason && e.reason.message || e.reason)));
  try {
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
    tab('map'); await wait(1500);
    const find = (n) => internotMap.map.placeList.find((p) => p.lower === n); const a = find('maseru'), b = find('mafeteng');
    const ok = !!(a && b && internotMap.api.makeRoute(a, b)); if (ok) { internotMap.view.cx = (a.x + b.x) / 2; internotMap.view.cy = (a.y + b.y) / 2; internotMap.view.z = 9.5; internotMap.api.paint(); }
    log('route', { ok, km: internotMap.route && Math.round(internotMap.route.total / 1000), steps: internotMap.route && internotMap.route.steps.length });
    await shot('map-route');
    try { log('voice', await internotMap.api.speakTest('Route ready. Head south on Main South.')); } catch (e) { log('voice', { error: String(e && e.message || e) }); }
    tab('mesh'); await wait(800);
    if (!internotMesh.S.me.name) { document.getElementById('mesh-name').value = 'Tester'; document.getElementById('mesh-name-save').click(); await wait(800); }
    document.getElementById('mesh-nearby').click(); await wait(9000);
    log('nearby', { plugin: !!internotMesh.NB.plugin, on: internotMesh.NB.on, note: internotMesh.NB.note });
    await shot('chat-nearby');
    tab('model'); await shot('setup');
  } catch (e) { log('failed', String(e && e.stack || e)); }
  log('done', 1);
})();
