#!/usr/bin/env node
// Optional: build a map file on a computer instead of on the phone.
//   node tools-build-map.mjs lesotho-latest.osm.pbf lesotho.imap "Lesotho"
import { open, writeFile } from 'node:fs/promises';
import { convertPbf } from './osmpbf.js';
const [, , input, output, name = 'Map'] = process.argv;
if (!input || !output) { console.error('usage: node tools-build-map.mjs input.osm.pbf output.imap "Name"'); process.exit(1); }
const fh = await open(input); const { size } = await fh.stat();
const reader = { size, read: async (o, n) => { const b = Buffer.alloc(n); await fh.read(b, 0, n, o); return new Uint8Array(b.buffer, b.byteOffset, n); } };
let last = '';
const buf = await convertPbf(reader, name, (f, label) => { const s = `${label} ${Math.round(f * 100)}%`; if (s !== last) { last = s; process.stdout.write('\r' + s + '   '); } });
await fh.close(); await writeFile(output, new Uint8Array(buf));
console.log(`\nWrote ${output} (${(buf.byteLength / 1048576).toFixed(1)} MB)`);
