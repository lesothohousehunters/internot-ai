// Internot AI server — anonymous device counts, adverts, update notices, paid packs with unlock codes,
// and an admin page (/admin) with the numbers for sponsors.
// Runs on Render (free web service) with a Neon Postgres database.
//   DATABASE_URL  Neon connection string (postgresql://...?sslmode=require)
//   ADMIN_TOKEN   long random secret for the admin endpoints
//   PORT          set by Render
// No IP addresses, names, phone numbers or locations are stored: only a random id the app makes for itself.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import pg from 'pg';

const ADMIN_PAGE = fs.readFileSync(new URL('./admin.html', import.meta.url));

const SCHEMA = `
create table if not exists devices (
  id text primary key, first_seen timestamptz not null default now(), last_seen timestamptz not null default now(),
  app_version text, platform text, country text, lang text, pings integer not null default 1);
create table if not exists daily_active (day date not null, device_id text not null, primary key (day, device_id));
create table if not exists ads (
  id serial primary key, title text not null, body text not null default '', image_url text, link_url text,
  starts_at timestamptz, ends_at timestamptz, active boolean not null default true, created_at timestamptz not null default now());
create table if not exists ad_views (day date not null, ad_id integer not null, views integer not null default 0, primary key (day, ad_id));
create table if not exists app_update (id integer primary key, version text not null, url text, notes text, updated_at timestamptz not null default now());
create table if not exists packs (
  id text primary key, kind text not null, name text not null, price text, url text not null, sha256 text, size bigint,
  active boolean not null default true, created_at timestamptz not null default now());
create table if not exists codes (
  code text primary key, pack_id text not null references packs(id) on delete cascade, uses_left integer not null default 1,
  used integer not null default 0, note text, created_at timestamptz not null default now(), last_used timestamptz);
`;

const ID = /^[A-Za-z0-9-]{16,64}$/;
const short = (v, n = 40) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
const PACK_ID = /^[a-z0-9-]{2,40}$/;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O or 1/I, easy to read out over the phone
const normCode = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 32);
const newCode = () => { const b = crypto.randomBytes(12); let s = ''; for (let i = 0; i < 12; i++) s += CODE_CHARS[b[i] % 32]; return s; };
const showCode = (c) => c.replace(/(.{4})(?=.)/g, '$1-');
const httpUrl = (v) => (typeof v === 'string' && /^https?:\/\/\S+$/i.test(v) ? v.slice(0, 500) : null);

export function createServer(pool, { adminToken = process.env.ADMIN_TOKEN, now = () => new Date() } = {}) {
  const q = (text, params) => pool.query(text, params);
  const hits = new Map();   // requests per minute per caller, kept in memory only
  const limited = (req) => {
    const key = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0];
    const minute = Math.floor(Date.now() / 60000); const h = hits.get(key);
    if (!h || h.m !== minute) { hits.set(key, { m: minute, n: 1 }); if (hits.size > 5000) hits.clear(); return false; }
    return ++h.n > 120;
  };
  const send = (res, code, body, type) => {
    if (type) { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-frame-options': 'DENY' }); return res.end(body); }
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS', 'cache-control': 'no-store' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const readBody = (req) => new Promise((ok, bad) => {
    let size = 0; const parts = [];
    req.on('data', (c) => { size += c.length; if (size <= 64 * 1024) parts.push(c); });
    req.on('end', () => { if (size > 64 * 1024) return bad(Object.assign(new Error('too large'), { code: 413 })); if (!parts.length) return ok({}); try { ok(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch { bad(Object.assign(new Error('not JSON'), { code: 400 })); } });
    req.on('error', bad);
  });
  const isAdmin = (req) => !!adminToken && adminToken.length >= 16 && req.headers.authorization === 'Bearer ' + adminToken;
  const today = () => now().toISOString().slice(0, 10);

  const routes = {
    'GET /': async () => [200, { name: 'Internot AI server', ok: true }],
    'GET /health': async () => { await q('select 1'); return [200, { ok: true, db: true }]; },

    // The app, when online: "this phone has the app". Optional: how often each advert was shown since last time.
    'POST /v1/ping': async (req, b) => {
      if (!ID.test(String(b.id || ''))) return [400, { error: 'id must be the random id the app made (16-64 letters, digits or dashes)' }];
      const v = [b.id, short(b.version, 20), short(b.platform, 20), short(b.country, 2)?.toUpperCase() || null, short(b.lang, 10)];
      await q(`insert into devices (id, app_version, platform, country, lang) values ($1, $2, $3, $4, $5)
               on conflict (id) do update set last_seen = now(), pings = devices.pings + 1,
               app_version = coalesce($2, devices.app_version), platform = coalesce($3, devices.platform),
               country = coalesce($4, devices.country), lang = coalesce($5, devices.lang)`, v);
      await q('insert into daily_active (day, device_id) values ($1, $2) on conflict do nothing', [today(), b.id]);
      if (b.views && typeof b.views === 'object') for (const [ad, n] of Object.entries(b.views).slice(0, 50)) {
        const id = Number(ad), c = Math.min(10000, Math.max(0, Math.floor(Number(n) || 0))); if (!Number.isInteger(id) || id <= 0 || !c) continue;
        await q('insert into ad_views (day, ad_id, views) values ($1, $2, $3) on conflict (day, ad_id) do update set views = ad_views.views + $3', [today(), id, c]);
      }
      return [200, { ok: true }];
    },

    // The app, when online: adverts to show (kept on the phone for offline use) and the newest version.
    'GET /v1/content': async () => {
      const ads = (await q(`select id, title, body, image_url, link_url, ends_at from ads where active
                            and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now()) order by id desc limit 20`)).rows;
      const up = (await q('select version, url, notes, updated_at from app_update where id = 1')).rows[0] || null;
      const packs = (await q(`select id, kind, name, price, size from packs where active order by kind, name`)).rows.map((p) => ({ ...p, size: p.size == null ? null : Number(p.size) }));
      return [200, { ads, update: up, packs, fetched: now().toISOString() }];
    },

    // The app: an unlock code bought for a paid pack. Gives the download address once the code checks out.
    'POST /v1/redeem': async (req, b) => {
      const code = normCode(b.code), pack = String(b.pack || '');
      if (code.length < 8 || !PACK_ID.test(pack)) return [400, { error: 'code and pack are needed' }];
      const r = await q(`update codes set uses_left = uses_left - 1, used = used + 1, last_used = now()
                         where code = $1 and pack_id = $2 and uses_left > 0 returning pack_id`, [code, pack]);
      if (!r.rowCount) {
        const known = (await q('select 1 from codes where code = $1 and pack_id = $2', [code, pack])).rowCount;
        return known ? [409, { error: 'this code has already been used' }] : [404, { error: 'unknown code' }];
      }
      const p = (await q('select id, kind, name, url, sha256, size from packs where id = $1', [pack])).rows[0];
      return [200, { ...p, size: p.size == null ? null : Number(p.size) }];
    },

    // Admin: numbers for sponsors and funders.
    'GET /v1/stats': async (req) => {
      if (!isAdmin(req)) return [401, { error: 'admin token needed' }];
      const one = async (sql, p) => (await q(sql, p)).rows;
      const [tot] = await one(`select count(*)::int as devices,
        count(*) filter (where last_seen > now() - interval '1 day')::int as active_1d,
        count(*) filter (where last_seen > now() - interval '7 days')::int as active_7d,
        count(*) filter (where last_seen > now() - interval '30 days')::int as active_30d,
        count(*) filter (where first_seen > now() - interval '7 days')::int as new_7d from devices`);
      return [200, {
        ...tot,
        by_platform: await one('select coalesce(platform, \'unknown\') as platform, count(*)::int as devices from devices group by 1 order by 2 desc'),
        by_version: await one('select coalesce(app_version, \'unknown\') as version, count(*)::int as devices from devices group by 1 order by 2 desc limit 20'),
        by_country: await one('select coalesce(country, \'??\') as country, count(*)::int as devices from devices group by 1 order by 2 desc limit 50'),
        daily_active: await one("select to_char(day, 'YYYY-MM-DD') as day, count(*)::int as devices from daily_active where day > current_date - 30 group by 1 order by 1"),
        ad_views: await one('select ad_id, sum(views)::int as views from ad_views group by 1 order by 1'),
        ad_views_daily: await one("select ad_id, to_char(day, 'YYYY-MM-DD') as day, views from ad_views where day > current_date - 60 order by 1, 2"),
        packs_sold: await one('select p.id, p.name, p.price, coalesce(sum(c.used), 0)::int as unlocked, coalesce(sum(c.uses_left), 0)::int as codes_left from packs p left join codes c on c.pack_id = p.id group by 1, 2, 3 order by 1'),
      }];
    },

    'GET /v1/ads': async (req) => (isAdmin(req) ? [200, { ads: (await q('select * from ads order by id desc')).rows }] : [401, { error: 'admin token needed' }]),
    'POST /v1/ads': async (req, b) => {
      if (!isAdmin(req)) return [401, { error: 'admin token needed' }];
      const title = short(b.title, 80); if (!title) return [400, { error: 'title is required' }];
      const r = await q(`insert into ads (title, body, image_url, link_url, starts_at, ends_at, active) values ($1, $2, $3, $4, $5, $6, $7) returning *`,
        [title, short(b.body, 400) || '', httpUrl(b.image_url), httpUrl(b.link_url), b.starts_at || null, b.ends_at || null, b.active !== false]);
      return [201, r.rows[0]];
    },
    'GET /v1/packs': async (req) => (isAdmin(req) ? [200, { packs: (await q('select * from packs order by kind, id')).rows.map((p) => ({ ...p, size: p.size == null ? null : Number(p.size) })) }] : [401, { error: 'admin token needed' }]),
    'POST /v1/codes': async (req, b) => {
      if (!isAdmin(req)) return [401, { error: 'admin token needed' }];
      const pack = String(b.pack || ''); const count = Math.min(500, Math.max(1, Math.floor(Number(b.count) || 1))); const uses = Math.min(10, Math.max(1, Math.floor(Number(b.uses) || 1)));
      if (!(await q('select 1 from packs where id = $1', [pack])).rowCount) return [404, { error: 'no such pack' }];
      const out = [];
      while (out.length < count) { const c = newCode(); const r = await q('insert into codes (code, pack_id, uses_left, note) values ($1, $2, $3, $4) on conflict do nothing', [c, pack, uses, short(b.note, 80)]); if (r.rowCount) out.push(showCode(c)); }
      return [201, { pack, uses, codes: out }];
    },
    'GET /v1/codes': async (req) => {
      if (!isAdmin(req)) return [401, { error: 'admin token needed' }];
      const pack = new URL(req.url, 'http://x').searchParams.get('pack');
      const r = await q(`select code, pack_id, uses_left, used, note, created_at, last_used from codes ${pack ? 'where pack_id = $1' : ''} order by created_at desc limit 1000`, pack ? [pack] : []);
      return [200, { codes: r.rows.map((c) => ({ ...c, code: showCode(c.code) })) }];
    },
    'GET /admin': async () => [200, ADMIN_PAGE, 'text/html; charset=utf-8'],
    'PUT /v1/update': async (req, b) => {
      if (!isAdmin(req)) return [401, { error: 'admin token needed' }];
      const version = short(b.version, 20); if (!version) return [400, { error: 'version is required' }];
      const r = await q(`insert into app_update (id, version, url, notes) values (1, $1, $2, $3)
                         on conflict (id) do update set version = $1, url = $2, notes = $3, updated_at = now() returning *`, [version, httpUrl(b.url), short(b.notes, 1000)]);
      return [200, r.rows[0]];
    },
  };

  const packRoute = async (method, id, req, b) => {   // PUT or DELETE /v1/packs/:id
    if (!isAdmin(req)) return [401, { error: 'admin token needed' }];
    if (!PACK_ID.test(id)) return [400, { error: 'pack id: 2-40 small letters, digits or dashes' }];
    if (method === 'DELETE') { const r = await q('delete from packs where id = $1', [id]); return r.rowCount ? [200, { ok: true }] : [404, { error: 'no such pack' }]; }
    const kind = b.kind === 'model' || b.kind === 'map' ? b.kind : null; const name = short(b.name, 80); const url = httpUrl(b.url);
    if (!kind || !name || !url) return [400, { error: 'kind (model or map), name and url are required' }];
    const sha = typeof b.sha256 === 'string' && /^[0-9a-fA-F]{64}$/.test(b.sha256) ? b.sha256.toLowerCase() : null;
    const size = Number.isFinite(Number(b.size)) && Number(b.size) > 0 ? Math.floor(Number(b.size)) : null;
    const r = await q(`insert into packs (id, kind, name, price, url, sha256, size, active) values ($1, $2, $3, $4, $5, $6, $7, $8)
                       on conflict (id) do update set kind = $2, name = $3, price = $4, url = $5, sha256 = $6, size = $7, active = $8 returning *`,
      [id, kind, name, short(b.price, 20), url, sha, size, b.active !== false]);
    return [200, { ...r.rows[0], size: r.rows[0].size == null ? null : Number(r.rows[0].size) }];
  };

  const adRoute = async (method, id, req, b) => {   // PATCH or DELETE /v1/ads/:id
    if (!isAdmin(req)) return [401, { error: 'admin token needed' }];
    if (method === 'DELETE') { const r = await q('delete from ads where id = $1', [id]); return r.rowCount ? [200, { ok: true }] : [404, { error: 'no such advert' }]; }
    const cur = (await q('select * from ads where id = $1', [id])).rows[0]; if (!cur) return [404, { error: 'no such advert' }];
    const n = { ...cur };
    if ('title' in b) n.title = short(b.title, 80) || cur.title; if ('body' in b) n.body = short(b.body, 400) || '';
    if ('image_url' in b) n.image_url = httpUrl(b.image_url); if ('link_url' in b) n.link_url = httpUrl(b.link_url);
    if ('starts_at' in b) n.starts_at = b.starts_at || null; if ('ends_at' in b) n.ends_at = b.ends_at || null; if ('active' in b) n.active = !!b.active;
    const r = await q('update ads set title=$2, body=$3, image_url=$4, link_url=$5, starts_at=$6, ends_at=$7, active=$8 where id=$1 returning *',
      [id, n.title, n.body, n.image_url, n.link_url, n.starts_at, n.ends_at, n.active]);
    return [200, r.rows[0]];
  };

  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') return send(res, 204);
      if (limited(req)) return send(res, 429, { error: 'too many requests, try again in a minute' });
      const path = new URL(req.url, 'http://x').pathname.replace(/\/+$/, '') || '/';
      const body = req.method === 'GET' ? {} : await readBody(req);
      const m = /^\/v1\/ads\/(\d+)$/.exec(path), pm = /^\/v1\/packs\/([^/]+)$/.exec(path);
      const fn = routes[`${req.method} ${path}`];
      const [code, out, type] = m && (req.method === 'PATCH' || req.method === 'DELETE') ? await adRoute(req.method, Number(m[1]), req, body)
        : pm && (req.method === 'PUT' || req.method === 'DELETE') ? await packRoute(req.method, decodeURIComponent(pm[1]), req, body)
        : fn ? await fn(req, body) : [404, { error: 'not found' }];
      send(res, code, out, type);
    } catch (e) {
      if (e.code === 413 || e.code === 400) return send(res, e.code, { error: e.message });
      console.error(e); send(res, 500, { error: 'server error' });
    }
  });
}

export async function migrate(pool) { await pool.query(SCHEMA); }

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set (copy it from the Neon dashboard).'); process.exit(1); }
  if (!process.env.ADMIN_TOKEN || process.env.ADMIN_TOKEN.length < 16) console.warn('ADMIN_TOKEN is missing or shorter than 16 characters: admin endpoints are switched off.');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: true }, max: 5, idleTimeoutMillis: 30000 });
  await migrate(pool);
  const port = Number(process.env.PORT) || 10000;
  createServer(pool).listen(port, () => console.log(`Internot server listening on ${port}`));
}
