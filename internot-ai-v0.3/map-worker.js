// Converts an OpenStreetMap .osm.pbf into Internot's map format without freezing the screen.
import { convertPbf } from './osmpbf.js';

self.onmessage = async (e) => {
  const { file, name } = e.data;
  try {
    const reader = { size: file.size, read: async (o, n) => new Uint8Array(await file.slice(o, o + n).arrayBuffer()) };
    let last = 0;
    const buf = await convertPbf(reader, name, (f, label) => { const now = Date.now(); if (now - last > 150) { last = now; self.postMessage({ progress: f, label }); } });
    self.postMessage({ done: buf }, [buf]);
  } catch (err) { self.postMessage({ error: err?.message || String(err) }); }
};
