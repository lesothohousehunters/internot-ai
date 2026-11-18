// Build step: writes internot-ai-v0.4/packs.json, the list of maps and AI models the app and the downloads
// page offer, with each file's exact size and SHA-256. Prints the map files that must be (re)uploaded.
//   node android/make-packs.mjs <out packs.json> <release download url> <map.imap>...
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const [out, release, ...mapFiles] = process.argv.slice(2);
const old = (() => { try { return JSON.parse(fs.readFileSync(out, 'utf8')); } catch { return {}; } })();
const REPO = 'https://github.com/lesothohousehunters/internot-ai/releases/latest/download/';

const MODELS = [
  { id: 'model-small', tier: 'Small', name: 'Qwen2.5 0.5B', repo: 'bartowski/Qwen2.5-0.5B-Instruct-GGUF', file: 'Qwen2.5-0.5B-Instruct-Q4_K_M.gguf', ram: 2, licence: 'Apache 2.0', note: 'Fastest, but makes the most mistakes' },
  { id: 'model-medium', tier: 'Medium', name: 'Qwen2.5 1.5B', repo: 'bartowski/Qwen2.5-1.5B-Instruct-GGUF', file: 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf', ram: 3, licence: 'Apache 2.0', note: 'The one built into the full app' },
  { id: 'model-large', tier: 'Large', name: 'Qwen3 4B', repo: 'unsloth/Qwen3-4B-Instruct-2507-GGUF', file: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf', ram: 6, licence: 'Apache 2.0', nativeOnly: true, note: 'Most accurate, slowest' },
];

async function hfInfo(m) {   // exact size and SHA-256 from Hugging Face
  const url = `https://huggingface.co/${m.repo}/resolve/main/${m.file}`;
  try {
    const r = await fetch(`https://huggingface.co/api/models/${m.repo}/paths-info/main`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths: [m.file], expand: true }) });
    const j = await r.json(); const e = Array.isArray(j) && j[0];
    if (e && e.lfs && e.lfs.oid) return { url, size: e.lfs.size || e.size, sha256: e.lfs.oid };
  } catch (e) { console.error('paths-info failed for', m.file, e.message); }
  const r = await fetch(url, { method: 'HEAD', redirect: 'manual' });
  const size = Number(r.headers.get('x-linked-size')), sha = (r.headers.get('x-linked-etag') || '').replace(/"/g, '');
  if (!size || !/^[0-9a-f]{64}$/.test(sha)) throw new Error(`no size or SHA-256 for ${m.repo}/${m.file} (HTTP ${r.status})`);
  return { url, size, sha256: sha };
}

function mapInfo(f) {
  const b = fs.readFileSync(f); const h = JSON.parse(b.subarray(12, 12 + b.readUInt32LE(8)).toString());
  const file = path.basename(f);
  return { id: 'map-' + file.replace(/\.imap$/, ''), name: h.name, file, url: release + file, size: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex'), bbox: h.bbox, houses: h.B || 0, built: h.built,
    ...(file === 'lesotho.imap' ? { site: 'internot-ai-v0.4/maps/lesotho.imap' } : {}) };
}

const maps = mapFiles.filter((f) => fs.existsSync(f)).map(mapInfo);
const models = [];
for (const m of MODELS) { const { repo, ...rest } = m; models.push({ ...rest, ...(await hfInfo(m)) }); }
const packs = {
  updated: new Date().toISOString(),
  apps: [
    { id: 'app-lite', name: 'Internot AI for Android (light)', url: REPO + 'internot-ai.apk', note: 'About 150 MB. Lesotho map inside; get other maps and an AI model in the app.' },
    { id: 'app-full', name: 'Internot AI for Android (full)', url: REPO + 'internot-ai-full.apk', note: 'About 1.3 GB. AI model and the Lesotho, South Africa and Botswana maps inside.' },
    { id: 'app-web', name: 'Internot AI in the browser (iPhone, computer, any phone)', url: 'https://lesothohousehunters.github.io/internot-ai/internot-ai-v0.4/', note: 'Open once online, then it works offline.' },
  ],
  maps, models,
};
const same = (a, b) => JSON.stringify({ ...a, updated: 0 }) === JSON.stringify({ ...b, updated: 0 });
if (!same(packs, old)) fs.writeFileSync(out, JSON.stringify(packs, null, 1) + '\n');
const oldSha = new Map((old.maps || []).map((m) => [m.file, m.sha256]));
const assets = new Set((process.env.RELEASE_ASSETS || '').split(/\s+/).filter(Boolean));
const upload = maps.filter((m) => oldSha.get(m.file) !== m.sha256 || !assets.has(m.file)).map((m) => m.file);
console.error(JSON.stringify({ maps: maps.map((m) => [m.file, m.size]), models: models.map((m) => [m.file, m.size, m.sha256.slice(0, 12)]), upload }));
console.log(upload.join(' '));
