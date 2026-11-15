// Internot AI — reads the text out of almost any file, on the device, with no internet.
// Text files, web pages, Word / PowerPoint / Excel / OpenDocument / EPUB, RTF, PDF, and photos (the text in them).
const at = (p) => new URL(p, location.href).href;
const scripts = new Map();
const loadScript = (src) => scripts.get(src) || scripts.set(src, new Promise((ok, bad) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => { scripts.delete(src); bad(new Error('A part of the app needed for this kind of file is missing.')); }; document.head.append(s); })).get(src);
const tidy = (t) => t.replace(/\r/g, '').replace(/[ \t ]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const unent = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()] ?? m);
const xmlText = (xml, breaks, tabs) => unent(xml.replace(breaks, '\n').replace(tabs || /$^/, '\t').replace(/<[^>]+>/g, ''));
const html = (s) => tidy(unent(s.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ').replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d|\/title)\b[^>]*>/gi, '\n').replace(/<\/t[dh]>/gi, '\t').replace(/<[^>]+>/g, '')));

/* ---------- zip (Word, Excel, PowerPoint, OpenDocument and EPUB files are zip folders) ---------- */
async function unzip(buf) {
  const v = new DataView(buf), u8 = new Uint8Array(buf); let e = buf.byteLength - 22;
  while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('not a zip');
  const files = new Map(); let p = v.getUint32(e + 16, true); const n = v.getUint16(e + 10, true); const dec = new TextDecoder();
  for (let i = 0; i < n && v.getUint32(p, true) === 0x02014b50; i++) {
    const method = v.getUint16(p + 10, true), size = v.getUint32(p + 20, true), nl = v.getUint16(p + 28, true), xl = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true), off = v.getUint32(p + 42, true);
    files.set(dec.decode(u8.subarray(p + 46, p + 46 + nl)), { method, size, off }); p += 46 + nl + xl + cl;
  }
  const read = async (name) => {
    const f = files.get(name); if (!f) return '';
    const start = f.off + 30 + v.getUint16(f.off + 26, true) + v.getUint16(f.off + 28, true); const raw = u8.subarray(start, start + f.size);
    if (f.method === 0) return dec.decode(raw);
    if (f.method !== 8) return '';
    return new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
  };
  return { names: [...files.keys()], read };
}
const byNumber = (a, b) => (+(a.match(/(\d+)\D*$/) || [0, 0])[1]) - (+(b.match(/(\d+)\D*$/) || [0, 0])[1]);
async function office(buf) {
  const z = await unzip(buf); const has = (n) => z.names.includes(n); const out = [];
  if (has('word/document.xml')) return tidy(xmlText(await z.read('word/document.xml'), /<\/w:p>|<w:br\b[^>]*>/g, /<w:tab\b[^>]*>/g));
  const slides = z.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(byNumber);
  if (slides.length) { for (const [i, n] of slides.entries()) out.push(`Slide ${i + 1}\n` + xmlText(await z.read(n), /<\/a:p>/g)); return tidy(out.join('\n\n')); }
  const sheets = z.names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort(byNumber);
  if (sheets.length) {
    const shared = [...(await z.read('xl/sharedStrings.xml')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => xmlText(m[1], /$^/));
    for (const n of sheets) for (const row of (await z.read(n)).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [...row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((c) => { const val = (c[2] || '').match(/<v>([\s\S]*?)<\/v>/); return /t="s"/.test(c[1]) && val ? shared[+val[1]] ?? '' : val ? unent(val[1]) : xmlText(c[2] || '', /$^/); });
      if (cells.some((c) => c)) out.push(cells.join('\t'));
    }
    return tidy(out.join('\n'));
  }
  if (has('content.xml')) return tidy(xmlText(await z.read('content.xml'), /<\/text:p>|<\/text:h>|<text:line-break\/>/g, /<text:tab\/>|<\/table:table-cell>/g));
  const pages = z.names.filter((n) => /\.x?html?$/i.test(n)).sort();
  if (pages.length) { for (const n of pages) out.push(html(await z.read(n))); return tidy(out.join('\n\n')); }
  throw new Error('nothing readable inside');
}

/* ---------- RTF ---------- */
function rtf(s) {
  const SKIP = /^(fonttbl|colortbl|stylesheet|info|pict|object|header|footer|footnote|themedata|datastore|generator|listtable|listoverridetable|rsidtbl|xmlnstbl|latentstyles)$/;
  let out = '', skip = false; const stack = []; const cp = new TextDecoder('windows-1252');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') { stack.push(skip); if (s[i + 1] === '\\' && s[i + 2] === '*') skip = true; }
    else if (ch === '}') skip = stack.pop() ?? false;
    else if (ch === '\\') {
      const m = /^\\([a-z]+)(-?\d+)? ?|^\\'([0-9a-f]{2})|^\\([^a-z])/i.exec(s.slice(i, i + 40)); if (!m) continue; i += m[0].length - 1;
      if (m[1]) { if (SKIP.test(m[1])) skip = true; if (skip) continue; if (m[1] === 'par' || m[1] === 'line') out += '\n'; else if (m[1] === 'tab') out += '\t'; else if (m[1] === 'u' && m[2]) { out += String.fromCharCode((+m[2] + 65536) % 65536); if (s[i + 1] === '?') i++; } }
      else if (!skip) out += m[3] ? cp.decode(new Uint8Array([parseInt(m[3], 16)])) : /[{}\\]/.test(m[4]) ? m[4] : '';
    } else if (!skip && ch !== '\n' && ch !== '\r') out += ch;
  }
  return tidy(out);
}

/* ---------- old Word files (.doc, Word 97–2003) ---------- */
// They are "compound files": a small file system inside one file. The text sits in the WordDocument
// stream, and the table stream says which byte ranges hold it and how it is encoded.
function cfb(buf) {
  const v = new DataView(buf); if (v.getUint32(0, true) !== 0xe011cfd0) throw new Error('not a compound file');
  const ss = 1 << v.getUint16(0x1e, true), ms = 1 << v.getUint16(0x20, true), cutoff = v.getUint32(0x38, true);
  const sec = (id) => (id + 1) * ss, fatSecs = []; for (let i = 0; i < 109; i++) { const s = v.getInt32(0x4c + i * 4, true); if (s >= 0) fatSecs.push(s); }
  for (let d = v.getInt32(0x44, true), n = 0; d >= 0 && n < 1000; n++) { for (let i = 0; i < ss / 4 - 1; i++) { const s = v.getInt32(sec(d) + i * 4, true); if (s >= 0) fatSecs.push(s); } d = v.getInt32(sec(d) + ss - 4, true); }
  const fat = []; for (const s of fatSecs) for (let i = 0; i < ss / 4; i++) fat.push(v.getInt32(sec(s) + i * 4, true));
  const chain = (start, size) => { const out = new Uint8Array(size); let id = start, at = 0; for (let n = 0; id >= 0 && at < size && n < fat.length; n++) { const len = Math.min(ss, size - at); out.set(new Uint8Array(buf, sec(id), len), at); at += len; id = fat[id]; } return out; };
  const dirStart = v.getInt32(0x30, true); const dirs = []; const dirBytes = chain(dirStart, ss * 512); const dv = new DataView(dirBytes.buffer);
  for (let o = 0; o + 128 <= dirBytes.length; o += 128) { const nl = dv.getUint16(o + 0x40, true); if (!nl) continue; let name = ''; for (let i = 0; i < nl / 2 - 1; i++) name += String.fromCharCode(dv.getUint16(o + i * 2, true)); dirs.push({ name, type: dirBytes[o + 0x42], start: dv.getInt32(o + 0x74, true), size: dv.getUint32(o + 0x78, true) }); }
  const root = dirs.find((d) => d.type === 5); const mini = root ? chain(root.start, root.size) : new Uint8Array(0);
  const minifat = []; { const mf = chain(v.getInt32(0x3c, true), v.getUint32(0x40, true) * ss); const mv = new DataView(mf.buffer); for (let i = 0; i + 4 <= mf.length; i += 4) minifat.push(mv.getInt32(i, true)); }
  return (name) => {
    const d = dirs.find((x) => x.name === name && x.type === 2); if (!d) return null;
    if (d.size >= cutoff) return chain(d.start, d.size);
    const out = new Uint8Array(d.size); let id = d.start, at = 0; for (let n = 0; id >= 0 && at < d.size && n < minifat.length + 1; n++) { const len = Math.min(ms, d.size - at); out.set(mini.subarray(id * ms, id * ms + len), at); at += len; id = minifat[id]; } return out;
  };
}
function wordDoc(buf) {
  const stream = cfb(buf); const wd = stream('WordDocument'); if (!wd) throw new Error('not a Word file');
  const w = new DataView(wd.buffer, wd.byteOffset, wd.byteLength); if (w.getUint16(0, true) !== 0xa5ec) throw new Error('not a Word file');
  const table = stream(w.getUint16(0x0a, true) & 0x0200 ? '1Table' : '0Table'); if (!table) throw new Error('no table');
  const csw = w.getUint16(32, true), lw = 34 + csw * 2 + 2, cslw = w.getUint16(34 + csw * 2, true), fc = lw + cslw * 4 + 2;
  const ccpText = w.getInt32(lw + 12, true), fcClx = w.getUint32(fc + 33 * 8, true), lcbClx = w.getUint32(fc + 33 * 8 + 4, true);
  const t = new DataView(table.buffer, table.byteOffset, table.byteLength); let p = fcClx; const end = fcClx + lcbClx;
  while (p < end && table[p] === 1) p += 3 + t.getUint16(p + 1, true);   // skip formatting entries
  if (table[p] !== 2) throw new Error('no text table'); const lcb = t.getUint32(p + 1, true); p += 5; const n = (lcb - 4) / 12;
  const cp = (i) => t.getUint32(p + i * 4, true), pcd = (i) => p + (n + 1) * 4 + i * 8; let text = ''; const cp1252 = new TextDecoder('windows-1252'), u16 = new TextDecoder('utf-16le');
  for (let i = 0; i < n && cp(i) < ccpText; i++) {
    const len = Math.min(cp(i + 1), ccpText) - cp(i); let f = t.getUint32(pcd(i) + 2, true);
    if (f & 0x40000000) { f = (f & ~0x40000000) / 2; text += cp1252.decode(wd.subarray(f, f + len)); } else text += u16.decode(wd.subarray(f, f + len * 2));
  }
  // fields: keep the shown result, drop the hidden instruction; then turn Word's control marks into plain text
  let out = ''; const skip = []; for (const ch of text) { const c = ch.charCodeAt(0);
    if (c === 0x13) { skip.push(true); continue; } if (c === 0x14) { skip[skip.length - 1] = false; continue; } if (c === 0x15) { skip.pop(); continue; }
    if (skip.some((x) => x)) continue; out += c === 13 || c === 11 || c === 12 ? '\n' : c === 7 ? '\t' : c < 32 && c !== 9 ? '' : ch; }
  return tidy(out);
}

/* ---------- anything else: keep whatever looks like words ---------- */
function strings(buf) {
  const u8 = new Uint8Array(buf.slice(0, 8 * 1024 * 1024)); const ok = (c) => (c >= 32 && c < 127) || c === 9 || c === 10 || c === 13;
  const grab = (step) => { const runs = []; let run = '';
    for (let i = 0; i + step - 1 < u8.length; i += step) { const c = u8[i]; if (ok(c) && (step === 1 || u8[i + 1] === 0)) run += String.fromCharCode(c); else { if (run.length >= 5) runs.push(run); run = ''; } }
    if (run.length >= 5) runs.push(run); return runs.filter((r) => (r.match(/[a-z]/gi) || []).length > r.length * 0.6 && / /.test(r)); };
  const a = grab(1), b = grab(2); const best = b.join('').length > a.join('').length ? b : a;
  return tidy(best.join('\n'));
}

/* ---------- PDF ---------- */
async function pdf(file, say) {
  await loadScript(at('./lib/pdfjs/pdf.min.js')); const lib = window.pdfjsLib; lib.GlobalWorkerOptions.workerSrc = at('./lib/pdfjs/pdf.worker.min.js');
  const doc = await lib.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false }).promise; const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    say(`Reading page ${i} of ${doc.numPages}`); const page = await doc.getPage(i); const tc = await page.getTextContent(); let line = '', y = null, text = '';
    for (const it of tc.items) { const ty = it.transform ? it.transform[5] : y; if (y !== null && Math.abs(ty - y) > 2) { text += line + '\n'; line = ''; } line += it.str; if (it.hasEOL) { text += line + '\n'; line = ''; } y = ty; }
    out.push(text + line);
  }
  let text = tidy(out.join('\n\n'));
  if (text.length < 25 * doc.numPages) {   // a scanned PDF: pages are pictures, so read them like photos
    const pages = Math.min(doc.numPages, 12); out.length = 0;
    for (let i = 1; i <= pages; i++) {
      say(`Reading scanned page ${i} of ${pages}`); const page = await doc.getPage(i); const vp = page.getViewport({ scale: 2 });
      const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height; await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      out.push(await ocrCanvas(c, () => {}));
    }
    text = tidy(out.join('\n\n'));
  }
  return text;
}

/* ---------- pictures: read the text in them ---------- */
let ocrWorker = null, ocrSay = () => {}, ocrIdle = 0;
async function ocrCanvas(canvas, say) {
  await loadScript(at('./lib/ocr/tesseract.min.js')); ocrSay = say; clearTimeout(ocrIdle);
  ocrWorker ||= await window.Tesseract.createWorker('eng', 1, { workerPath: at('./lib/ocr/worker.min.js'), corePath: at('./lib/ocr/'), langPath: at('./lib/ocr/'), gzip: true, cacheMethod: 'none',
    logger: (m) => { if (m.status === 'recognizing text') ocrSay(`Reading the picture… ${Math.round(m.progress * 100)}%`); } });
  const { data } = await ocrWorker.recognize(canvas);
  ocrIdle = setTimeout(() => { ocrWorker?.terminate(); ocrWorker = null; }, 60000);   // free the memory when not in use
  return tidy(data.text || '');
}
async function picture(file, say) {
  say('Opening the picture…'); const bmp = await createImageBitmap(file); const k = Math.min(1, 2200 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.();
  return ocrCanvas(c, say);
}

const PLAIN = /\.(txt|md|markdown|csv|tsv|json|xml|log|srt|vtt|ini|ya?ml|tex|py|js|ts|java|c|cpp|h|css|sql|sh|bat)$/;
export async function readDoc(file, say = () => {}) {
  const name = file.name.toLowerCase(), type = file.type || '';
  if (type.startsWith('audio/') || type.startsWith('video/')) throw new Error('Sound and video files cannot be read.');
  if (type.startsWith('image/') || /\.(png|jpe?g|webp|bmp|gif)$/.test(name)) return picture(file, say);
  if (type === 'application/pdf' || name.endsWith('.pdf')) return pdf(file, say);
  if (/\.(x?html?)$/.test(name) || type === 'text/html') return html(await file.text());
  if (name.endsWith('.rtf') || type.includes('rtf')) return rtf(await file.text());
  if (type.startsWith('text/') || PLAIN.test(name)) return tidy(await file.text());
  const buf = await file.arrayBuffer();
  if (new DataView(buf).byteLength > 8 && new DataView(buf).getUint32(0, true) === 0xe011cfd0) { try { const t = wordDoc(buf); if (t.replace(/\s/g, '').length > 3) return t; } catch (e) { console.warn('old Word reader', e); } }
  try { return await office(buf); } catch {}
  return strings(buf);
}

// A small picture to show in the list: for photos, and for the first page of a PDF.
export async function thumbOf(file) {
  try {
    const name = file.name.toLowerCase(); let src;
    if ((file.type || '').startsWith('image/') || /\.(png|jpe?g|webp|bmp|gif)$/.test(name)) src = await createImageBitmap(file);
    else if (file.type === 'application/pdf' || name.endsWith('.pdf')) {
      await loadScript(at('./lib/pdfjs/pdf.min.js')); const lib = window.pdfjsLib; lib.GlobalWorkerOptions.workerSrc = at('./lib/pdfjs/pdf.worker.min.js');
      const page = await (await lib.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false }).promise).getPage(1); const vp = page.getViewport({ scale: 0.5 });
      src = document.createElement('canvas'); src.width = vp.width; src.height = vp.height; await page.render({ canvasContext: src.getContext('2d'), viewport: vp }).promise;
    } else return null;
    const k = Math.min(1, 240 / Math.max(src.width, src.height)), c = document.createElement('canvas'); c.width = Math.max(1, Math.round(src.width * k)); c.height = Math.max(1, Math.round(src.height * k));
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(src, 0, 0, c.width, c.height); src.close?.();
    return c.toDataURL('image/jpeg', 0.72);
  } catch { return null; }
}

