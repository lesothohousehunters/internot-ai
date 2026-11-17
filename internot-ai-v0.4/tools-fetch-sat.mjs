#!/usr/bin/env node
// Downloads the satellite pictures that ship inside the app: the whole world from far out, and one
// country closer in.   node tools-fetch-sat.mjs <out-folder> [name minLon minLat maxLon maxLat maxZoom]
// Source: Sentinel-2 cloudless 2016 by EOX IT Services GmbH (CC BY 4.0), https://s2maps.eu
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
const [, , out, name = 'Lesotho', a = '26.9', b = '-30.75', c = '29.6', d = '-28.5', maxZ = '12'] = process.argv;
const box = [+a, +b, +c, +d], world = 4, max = +maxZ, TWO32 = 4294967296;
const lonToX = (lon) => Math.min(TWO32 - 1, Math.max(0, Math.round((lon + 180) / 360 * TWO32)));
const latToY = (lat) => { const s = Math.sin(lat * Math.PI / 180); return Math.min(TWO32 - 1, Math.max(0, Math.round((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TWO32))); };
// Only the 2016 pictures: free to use with credit, also commercially (CC BY 4.0). Later years are non-commercial only, so they are never used.
const LAYERS = [['s2cloudless_3857', '2016'], ['s2cloudless-2016_3857', '2016']];
let layer = LAYERS[0][0], year = LAYERS[0][1];
const url = (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/${layer}/default/g/${z}/${y}/${x}.jpg`;
const get = (u) => fetch(u, { signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'internot-ai-build (open source offline map app)' } });
{ const n = 2 ** 12, px = Math.floor((((+a + +c) / 2) + 180) / 360 * n), lat = ((+b + +d) / 2) * Math.PI / 180, py = Math.floor((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2 * n); let found = false;
  for (const [l, y] of LAYERS) { layer = l; try { const r = await get(url(12, px, py)); console.log(`probe ${l}: HTTP ${r.status}`); if (r.ok && (await r.arrayBuffer()).byteLength > 500) { year = y; found = true; break; } } catch (e) { console.log(`probe ${l}: ${e.message}`); } }
  if (!found) { console.error('no satellite layer answered'); process.exit(1); } console.log(`using ${layer} (${year})`); }
const jobs = [];
for (let z = 0; z <= max; z++) {
  const n = 2 ** z, t = (v) => Math.floor(v / TWO32 * n);
  const [x0, x1, y0, y1] = z <= world ? [0, n - 1, 0, n - 1] : [t(lonToX(box[0])), t(lonToX(box[2])), t(latToY(box[3])), t(latToY(box[1]))];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push([z, x, y]);
}
console.log(`${jobs.length} pictures to fetch`);
let done = 0, failed = 0, bytes = 0;
async function worker() {
  for (let job; (job = jobs.pop());) {
    const [z, x, y] = job; let ok = false;
    for (let tries = 0; tries < 3 && !ok; tries++) {
      try {
        const r = await get(url(z, x, y)); if (!r.ok) throw new Error('HTTP ' + r.status);
        const buf = Buffer.from(await r.arrayBuffer()); if (buf.length < 200) throw new Error('empty');
        mkdirSync(`${out}/${z}/${x}`, { recursive: true }); writeFileSync(`${out}/${z}/${x}/${y}.jpg`, buf); bytes += buf.length; ok = true;
      } catch (e) { if (tries === 2) { failed++; if (failed < 6) console.log(`failed ${z}/${x}/${y}: ${e.message}`); } else await new Promise((r) => setTimeout(r, 800)); }
    }
    if (++done % 200 === 0) console.log(`${done} done`);
  }
}
await Promise.all(Array.from({ length: 6 }, worker));
if (failed > done * 0.03) { rmSync(out, { recursive: true, force: true }); console.error(`too many failures (${failed}), nothing kept`); process.exit(1); }
writeFileSync(`${out}/index.json`, JSON.stringify({ name, box, world, max, count: done - failed, layer, year }));
console.log(`${done - failed} pictures, ${(bytes / 1048576).toFixed(1)} MB`);
