// HTTP layer: static app, login, the film database behind a session, and each user's data.
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import {
  SESSION_DAYS, cookieHeader, newToken, readCookie, readUsers, throttle, tokenHash, verifyPassword,
} from './auth.js';
import { parseRatings } from './csv.js';
import { tmdbProxy } from './tmdb.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};
const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; "
    + "img-src 'self' data: https://image.tmdb.org; connect-src 'self' https://image.tmdb.org; "
    + "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
const JSON_LIMIT = 256 * 1024, CSV_LIMIT = 5 * 1024 * 1024;
const TCONST = /^tt\d{1,12}$/;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readBody(req, limit) {
  return new Promise((done, fail) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { fail(new HttpError(413, 'Too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

async function readJson(req) {
  try { return JSON.parse(await readBody(req, JSON_LIMIT) || '{}'); } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'Invalid JSON');
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

/** Traefik appends the caller's address, so the last entry is the only one it vouches for. */
const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',').pop().trim();

/**
 * @param store   openStore() result
 * @param dataDir holds users.json, imdb.sqlite.gz, db-version.json
 * @param webDir  built app
 */
export function createApp({ store, dataDir, webDir, tmdbKey, secure = true, fetchImpl }) {
  const usersFile = join(dataDir, 'users.json');
  const dbFile = join(dataDir, 'imdb.sqlite.gz');
  const versionFile = join(dataDir, 'db-version.json');
  const web = resolve(webDir);
  const logins = throttle();
  const tmdb = tmdbProxy({ key: tmdbKey, fetchImpl });
  // verified for unknown usernames, so they take as long as known ones
  let decoyHash = null;
  const decoy = () => (decoyHash ??= Object.values(readUsers(usersFile))[0]);

  const sessionUser = (req) => {
    const token = readCookie(req.headers.cookie);
    return token ? store.sessionUser(tokenHash(token), SESSION_DAYS) : null;
  };
  const otherUsers = (user) => Object.keys(readUsers(usersFile)).filter((u) => u !== user);

  async function login(req, res) {
    const ip = clientIp(req);
    if (logins.blocked(ip)) return send(res, 429, { error: 'Too many attempts, wait a minute' });
    const { username, password } = await readJson(req);
    const name = String(username ?? '').trim().toLowerCase();
    const stored = readUsers(usersFile)[name];
    const ok = await verifyPassword(String(password ?? ''), stored ?? decoy()).catch(() => false);
    if (!stored || !ok) {
      logins.fail(ip);
      return send(res, 401, { error: 'Wrong username or password' });
    }
    logins.clear(ip);
    const token = newToken();
    store.addSession(tokenHash(token), name);
    send(res, 200, { user: name }, { 'Set-Cookie': cookieHeader(token, { secure }) });
  }

  function logout(req, res) {
    const token = readCookie(req.headers.cookie);
    if (token) store.dropSession(tokenHash(token));
    send(res, 200, {}, { 'Set-Cookie': cookieHeader('', { secure, maxAgeDays: 0 }) });
  }

  function sendDatabase(req, res) {
    if (!existsSync(dbFile)) return send(res, 404, { error: 'Database not uploaded yet' });
    const { size, mtimeMs } = statSync(dbFile);
    const etag = `"${size}-${Math.round(mtimeMs)}"`;
    const headers = { ETag: etag, 'Cache-Control': 'private, no-cache', 'Content-Type': 'application/gzip' };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    res.writeHead(200, { ...headers, 'Content-Length': size });
    createReadStream(dbFile).pipe(res);
  }

  /** Routes for logged-in users. Returns false if none matched. */
  async function api(req, res, user, path) {
    const { method } = req;
    const route = `${method} ${path}`;
    const one = path.match(/^\/api\/(ratings|watchlist)\/(tt\d+)$/);

    if (route === 'GET /api/me') return send(res, 200, { user, others: otherUsers(user), ratings: store.ratingCount(user) });
    if (route === 'GET /api/ratings') return send(res, 200, store.ratings(user));
    if (route === 'GET /api/ratings/shared') {
      return send(res, 200, otherUsers(user).map((name) => ({ user: name,
        ratings: store.ratings(name).map(({ tconst, rating }) => ({ tconst, rating })) })));
    }
    if (route === 'POST /api/ratings/import') {
      let parsed;
      try { parsed = parseRatings(await readBody(req, CSV_LIMIT)); } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(400, e.message);
      }
      const changed = store.importRatings(user, parsed.rows);
      return send(res, 200, { rows: parsed.rows.length, changed, skipped: parsed.skipped });
    }
    if (route === 'GET /api/watchlist') return send(res, 200, store.watchlist(user));
    if (route === 'POST /api/watchlist/import') {
      const body = await readJson(req);
      const rows = (Array.isArray(body) ? body : []).filter((r) => TCONST.test(r?.tconst));
      return send(res, 200, { rows: rows.length, added: store.importWatchlist(user, rows.map((r) => ({
        tconst: r.tconst, addedAt: Number.isFinite(r.addedAt) ? new Date(r.addedAt).toISOString() : null }))) });
    }
    if (route === 'GET /api/settings') return send(res, 200, store.settings(user));
    if (route === 'PUT /api/settings') {
      store.setSettings(user, await readJson(req));
      return send(res, 200, {});
    }
    if (one && one[1] === 'ratings') {
      if (method === 'DELETE') { store.deleteRating(user, one[2]); return send(res, 200, {}); }
      if (method === 'PUT') {
        const { rating } = await readJson(req);
        if (!Number.isInteger(rating) || rating < 1 || rating > 10) throw new HttpError(400, 'Rating must be 1 to 10');
        store.setRating(user, one[2], rating);
        return send(res, 200, {});
      }
    }
    if (one && one[1] === 'watchlist') {
      if (method === 'PUT') { store.addWatch(user, one[2]); return send(res, 200, {}); }
      if (method === 'DELETE') { store.removeWatch(user, one[2]); return send(res, 200, {}); }
    }
    if (method === 'GET' && path.startsWith('/api/tmdb/')) {
      const { status, body } = await tmdb(path.slice('/api/tmdb'.length));
      return send(res, status, body);
    }
    if (route === 'GET /data/imdb.sqlite.gz') return sendDatabase(req, res);
    if (route === 'GET /data/version') {
      if (!existsSync(versionFile)) return send(res, 404, { error: 'No database yet' });
      return send(res, 200, JSON.parse(readFileSync(versionFile, 'utf8')));
    }
    return false;
  }

  function serveStatic(res, path) {
    const file = resolve(web, `.${path === '/' ? '/index.html' : decodeURIComponent(path)}`);
    if ((file !== web && !file.startsWith(web + sep)) || !existsSync(file) || !statSync(file).isFile()) {
      return send(res, 404, { error: 'Not found' });
    }
    const hashed = path.startsWith('/assets/');
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...(path === '/sw.js' ? { 'Service-Worker-Allowed': '/' } : {}),
    });
    createReadStream(file).pipe(res);
  }

  return async function handle(req, res) {
    for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v);
    try {
      const path = new URL(req.url, 'http://x').pathname;
      if (path === '/healthz') return send(res, 200, { ok: true });

      const isPrivate = path.startsWith('/api/') || path.startsWith('/data/');
      if (!isPrivate) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
        return serveStatic(res, path);
      }
      // Writes only from our own pages. SameSite=Lax covers browsers; this is the second lock.
      const origin = req.headers.origin;
      if (req.method !== 'GET' && origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'Wrong origin' });

      if (req.method === 'POST' && path === '/api/login') return await login(req, res);
      if (req.method === 'POST' && path === '/api/logout') return logout(req, res);

      const user = sessionUser(req);
      if (!user) return send(res, 401, { error: 'Login required' });
      if (await api(req, res, user, path) === false) send(res, 404, { error: 'Not found' });
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: 'Server error' });
      else res.destroy();
    }
  };
}

