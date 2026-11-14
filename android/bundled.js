// First launch of the full APK: unpack the AI model and map that ship inside the app.
(async () => {
  let list; try { const r = await fetch('./bundled/list.json'); if (!r.ok) return; list = await r.json(); } catch { return; }
  const root = await navigator.storage.getDirectory();
  const read = async (n) => { try { return JSON.parse(await (await (await root.getFileHandle(n)).getFile()).text()); } catch { return null; } };
  const write = async (n, v) => { const w = await (await root.getFileHandle(n, { create: true })).createWritable(); await w.write(JSON.stringify(v)); await w.close(); };
  const done = (await read('bundled.json')) || {};
  const jobs = list.filter((j) => !done[j.to]); if (!jobs.length) return;
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;inset:0;z-index:99;background:#f0eee6;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;text-align:center;font:17px system-ui';
  box.innerHTML = '<img src="icon.svg" width="72" height="72" alt=""><b style="font-size:22px">Setting up Internot AI</b><div id="b-what"></div><div style="width:240px;height:8px;background:#e8e4d8;border-radius:9px;overflow:hidden"><div id="b-bar" style="height:100%;width:0;background:#d97757"></div></div><small style="color:#6b6860">One time only. No internet is used.</small>';
  document.body.append(box);
  try {
    for (const j of jobs) {
      box.querySelector('#b-what').textContent = 'Unpacking the ' + j.label + '…';
      const res = await fetch('./bundled/' + j.file); if (!res.ok || !res.body) throw new Error(j.file + ' missing');
      const w = await (await root.getFileHandle(j.to, { create: true })).createWritable(); const rd = res.body.getReader(); let n = 0;
      for (;;) { const { value, done: end } = await rd.read(); if (end) break; await w.write(value); n += value.byteLength; box.querySelector('#b-bar').style.width = Math.min(100, n / j.size * 100) + '%'; }
      await w.close(); if (n !== j.size) throw new Error(j.file + ' incomplete');
      if (j.meta) await write(j.meta, { name: j.name, size: n });
      done[j.to] = true; await write('bundled.json', done);
    }
    location.reload();
  } catch (e) { box.querySelector('#b-what').textContent = 'Setup could not finish (' + e.message + '). Free some storage and reopen the app.'; }
})();
