// Internot AI server — anonymous device counts, adverts and update notices.
// Runs on Render (free web service) with a Neon Postgres database.
//   DATABASE_URL  Neon connection string (postgresql://...?sslmode=require)
//   ADMIN_TOKEN   long random secret for the admin endpoints
//   PORT          set by Render
// No IP addresses, names, phone numbers or locations are stored: only a random id the app makes for itself.
import http from 'node:http';
import pg from 'pg';

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
`;

const ID = /^[A-Za-z0-9-]{16,64}$/;
const short = (v, n = 40) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
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
  const send = (res, code, body) => {
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
      return [200, { ads, update: up, fetched: now().toISOString() }];
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
    'PUT /v1/update': async (req, b) => {
      if (!isAdmin(req)) return [401, { error: 'admin token needed' }];
      const version = short(b.version, 20); if (!version) return [400, { error: 'version is required' }];
      const r = await q(`insert into app_update (id, version, url, notes) values (1, $1, $2, $3)
                         on conflict (id) do update set version = $1, url = $2, notes = $3, updated_at = now() returning *`, [version, httpUrl(b.url), short(b.notes, 1000)]);
      return [200, r.rows[0]];
    },
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
      const m = /^\/v1\/ads\/(\d+)$/.exec(path);
      const fn = routes[`${req.method} ${path}`];
      const [code, out] = m && (req.method === 'PATCH' || req.method === 'DELETE') ? await adRoute(req.method, Number(m[1]), req, body)
        : fn ? await fn(req, body) : [404, { error: 'not found' }];
      send(res, code, out);
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
