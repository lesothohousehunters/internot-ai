#!/usr/bin/env node
// Builds world.json, the small world base map that ships inside the app.
//   node tools-build-world.mjs countries.geojson places.geojson world.json
// Source: Natural Earth (public domain), 1:50m countries and populated places.
import { readFileSync, writeFileSync } from 'node:fs';
const [, , cFile, pFile, out] = process.argv;
const G = 65536;
const gx = (lon) => Math.round((lon + 180) / 360 * G);
const gy = (lat) => { const s = Math.sin(Math.max(-85, Math.min(85, lat)) * Math.PI / 180); return Math.round((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * G); };
const rings = [], countries = [];
for (const f of JSON.parse(readFileSync(cFile, 'utf8')).features) {
  const p = f.properties, g = f.geometry; if (!g) continue;
  for (const poly of g.type === 'Polygon' ? [g.coordinates] : g.coordinates) {
    const ring = poly[0]; const flat = []; let lx = null, ly = null, x0 = G, x1 = 0, y0 = G, y1 = 0;
    for (const [lon, lat] of ring) {
      const x = gx(lon), y = gy(lat); if (x === lx && y === ly) continue;
      flat.push(lx == null ? x : x - lx, ly == null ? y : y - ly); lx = x; ly = y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (flat.length >= 8 && (x1 - x0 > 2 || y1 - y0 > 2)) rings.push(flat);
  }
  if (p.NAME && p.LABEL_X != null) countries.push([p.NAME, gx(p.LABEL_X), gy(p.LABEL_Y), p.LABELRANK || 6]);
}
const cities = JSON.parse(readFileSync(pFile, 'utf8')).features.map((f) => f.properties)
  .filter((p) => p.name).sort((a, b) => a.scalerank - b.scalerank || b.pop_max - a.pop_max)
  .map((p) => [p.name, gx(p.longitude), gy(p.latitude), p.scalerank, p.adm0name || '', p.adm0cap ? 1 : 0]);
writeFileSync(out, JSON.stringify({ v: 1, grid: G, rings, countries, cities }));
console.log(`world.json: ${rings.length} outlines, ${countries.length} countries, ${cities.length} cities`);
