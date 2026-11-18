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
    // the anonymous-count question, asked once on first launch
    for (let i = 0; i < 40 && document.getElementById('consent')?.hidden !== false; i++) await wait(500);
    log('consent', { shown: document.getElementById('consent')?.hidden === false, text: (document.querySelector('#consent b') || {}).textContent });
    await shot('consent');
    document.getElementById('consent-no')?.click(); await wait(500);
    log('consent-no', { choice: localStorage.getItem('countChoice'), id: localStorage.getItem('deviceId'), hidden: document.getElementById('consent').hidden });
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
    // houses close up, and the map turned with two fingers
    log('houses', { count: internotMap.map.houses ? internotMap.map.houses.B : 0, maps: internotMap.api.builtIns().map((m) => m.name) });
    if (a) { internotMap.view.cx = a.x; internotMap.view.cy = a.y; internotMap.view.z = 17.5; internotMap.api.paint(); await wait(2500); internotMap.api.paint(); }
    await shot('map-houses');
    internotMap.view.rot = 0.55; internotMap.api.paint(); await wait(2500); internotMap.api.paint(); await shot('map-turned'); internotMap.view.rot = 0;
    // the other built-in country maps
    for (const [file, from, to] of [['south-africa.imap', 'maseru', 'bloemfontein'], ['botswana.imap', 'gaborone', 'francistown']]) {
      const m = internotMap.api.builtIns().find((x) => x.file === file); if (!m) { log('country', { file, missing: true }); continue; }
      const t0 = performance.now(); const opened = await internotMap.api.switchBuiltIn(m); const ms = Math.round(performance.now() - t0);
      const p = find(from), q = find(to); const routed = !!(p && q && internotMap.api.makeRoute(p, q));
      if (routed) { internotMap.view.cx = (p.x + q.x) / 2; internotMap.view.cy = (p.y + q.y) / 2; internotMap.view.z = 7.5; internotMap.api.paint(); }
      log('country', { file, opened, ms, name: internotMap.map.name, roads: internotMap.map.W, houses: internotMap.map.houses ? internotMap.map.houses.B : 0, from: !!p, to: !!q, routed, km: internotMap.route && Math.round(internotMap.route.total / 1000) });
      await wait(1500); await shot('map-' + file.split('.')[0]); internotMap.route = null;
    }
    { const l = internotMap.api.builtIns()[0]; if (l) await internotMap.api.switchBuiltIn(l); }
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
    // maps and AI models after install
    window.confirm = () => true; window.alert = () => {}; window.prompt = () => null;
    const PK = window.internotPacks, Packs = window.capacitorExports.registerPlugin('Packs');
    const ask = async (q) => { const t = performance.now(); let f = null; document.getElementById('input').value = q; document.getElementById('composer').requestSubmit();
      for (let i = 0; i < 1500; i++) { await wait(400); const m = internot.messages.at(-1); if (f == null && m && m.role === 'assistant' && m.content) f = performance.now() - t; if (!internot.generating && i > 2) break; }
      return { q, firstWordMs: f == null ? null : Math.round(f), totalMs: Math.round(performance.now() - t), answer: (internot.messages.at(-1)?.content || '').slice(0, 400), stats: internot.lastStats || null }; };
    log('packs', { list: PK.allPacks().map((p) => [p.id, p.size, !!p.sha256, p.url && p.url.slice(0, 60)]), device: PK.P.device, suggested: PK.suggested(), have: [...PK.P.have.keys()] });
    document.getElementById('pack-list').scrollIntoView(); await shot('setup-packs');
    { const m = PK.allPacks().find((p) => p.id === 'map-lesotho'); const t = performance.now(); await PK.get(m);
      const i = await Packs.info(); const got = (i.maps || []).find((x) => x.file === 'lesotho.imap'); let head = null;
      if (got) { const b = await (await fetch(window.Capacitor.convertFileSrc(got.path))).arrayBuffer(); head = [String.fromCharCode(...new Uint8Array(b, 0, 4)), b.byteLength]; }
      log('map-download', { ms: Math.round(performance.now() - t), status: document.getElementById('pack-status').textContent, saved: got || null, read: head }); }
    const small = PK.allPacks().find((p) => p.id === 'model-small');
    if (small) {
      const t = performance.now(); const g = PK.get(small); let paused = false;
      for (let i = 0; i < 1200; i++) { await wait(250); const j = PK.P.jobs.get(small.id); if (j && j.done > small.size * 0.3) { PK.pause(small); paused = true; break; } if (!j && i > 8) break; }
      await g; const part = (await Packs.partial({ file: small.file })).bytes;
      log('model-pause', { paused, part, of: small.size, status: document.getElementById('pack-status').textContent });
      document.getElementById('pack-list').scrollIntoView(); await shot('setup-paused');
      await PK.get(small);
      log('model-resume', { ms: Math.round(performance.now() - t), status: document.getElementById('pack-status').textContent, model: internot.modelMeta });
      tab('chat'); log('chat-small', await ask('What is the capital of Lesotho?'));
      tab('model'); await wait(500);
    }
    const large = PK.allPacks().find((p) => p.id === 'model-large');
    if (large) {
      const t = performance.now(); await PK.get(large);
      log('model-large', { ms: Math.round(performance.now() - t), status: document.getElementById('pack-status').textContent, model: internot.modelMeta });
      tab('chat'); internot.messages = [];
      log('chat-large-1', await ask('What is the capital of Lesotho?'));
      log('chat-large-2', await ask('What is the highest mountain in Lesotho?'));
      log('chat-large-3', await ask('Which country surrounds Lesotho?'));
      await shot('brain-large');
    }
    // the anonymous count and the server (not online yet during the test)
    window.internotOnline.decide('yes');
    log('count', { choice: localStorage.getItem('countChoice'), idLength: (localStorage.getItem('deviceId') || '').length, ping: await window.internotOnline.ping(true), content: await window.internotOnline.fetchContent(true) });
    window.internotOnline.decide('no');
    localStorage.setItem('content', JSON.stringify({ ads: [{ id: 1, title: 'Maluti Lodge', body: 'Rooms from M450 a night. Show this app for 10% off.', link_url: 'https://example.com' }] }));
    tab('chat'); window.internotOnline.showNotice(); await wait(500);
    log('advert', { shown: !document.getElementById('notice').hidden, text: document.getElementById('notice').textContent });
    await shot('advert');
    localStorage.setItem('content', JSON.stringify({ update: { version: '9.9.9', notes: 'Faster maps.', url: 'https://example.com' } })); window.internotOnline.showNotice(); await wait(300);
    log('update', { text: document.getElementById('notice').textContent }); await shot('update-notice');
    localStorage.removeItem('content'); window.internotOnline.showNotice();
    // sharing with no data
    try { log('peers', await window.capacitorExports.registerPlugin('Nearby').peers()); } catch (e) { log('peers', { error: String(e && e.message || e) }); }
    try { log('share-path', await Packs.pathFor({ what: 'map', file: 'botswana.imap' })); } catch (e) { log('share-path', { error: String(e && e.message || e) }); }
    tab('model'); await wait(300); document.getElementById('share-app').click(); await wait(8000);
    log('share', { status: document.getElementById('share-status').textContent });
    await shot('share-sheet');
  } catch (e) { log('failed', String(e && e.stack || e)); }
  log('done', 1);
})();
