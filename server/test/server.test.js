import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createApp } from '../app.js';
import { openStore } from '../store.js';
import { hashPassword, throttle, verifyPassword } from '../auth.js';
import { parseRatings } from '../csv.js';

const CSV = `Const,Your Rating,Date Rated,Title,Original Title,URL,Title Type,IMDb Rating,Runtime (mins),Year,Genres,Num Votes,Release Date,Directors
tt31709373,9,2026-11-05,"How to Get to Heaven, from Belfast","How to Get to Heaven from Belfast",https://www.imdb.com/title/tt31709373,Fernsehserie,7.3,50,2026,"Komödie, Thriller",16241,"2026-02-12",
`;

let dir, store, server, base, tmdbCalls;
const jar = {};

async function call(who, method, path, body, headers = {}) {
  const isText = typeof body === 'string';
  const res = await fetch(base + path, {
    method,
    headers: { ...(jar[who] ? { cookie: jar[who] } : {}), ...(body && !isText ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : isText ? body : JSON.stringify(body),
  });
  const set = res.headers.get('set-cookie');
  if (set) jar[who] = set.split(';')[0];
  return res;
}
const json = async (...a) => (await call(...a)).json();

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sr-'));
  const web = join(dir, 'web');
  mkdirSync(join(web, 'assets'), { recursive: true });
  writeFileSync(join(web, 'index.html'), '<title>app</title>');
  writeFileSync(join(web, 'assets', 'a-123.js'), 'ok');
  writeFileSync(join(dir, 'secret.txt'), 'nope');
  writeFileSync(join(dir, 'imdb.sqlite.gz'), gzipSync('database bytes'));
  writeFileSync(join(dir, 'db-version.json'), '{"built_at":"2026-11-06 10:00:00"}');
  const n = 2 ** 10; // low cost keeps the tests fast
  writeFileSync(join(dir, 'users.json'), JSON.stringify({
    marc: await hashPassword('correct horse', { n }), Thomas: await hashPassword('battery staple', { n }),
  }));
  store = openStore(join(dir, 'app.sqlite'));
  tmdbCalls = [];
  const fetchImpl = async (url, opts) => {
    tmdbCalls.push({ url, opts });
    return new Response(JSON.stringify({ movie_results: [{ id: 1 }] }), { status: 200 });
  };
  const handle = createApp({ store, dataDir: dir, webDir: web, tmdbKey: 'k'.repeat(32), secure: false, fetchImpl });
  server = createServer(handle);
  await new Promise((ok) => { server.listen(0, '127.0.0.1', ok); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections(); server.close(); store.close(); });

test('app files are public, private paths are not', async () => {
  assert.equal((await call('anon', 'GET', '/')).status, 200);
  assert.match((await call('anon', 'GET', '/assets/a-123.js')).headers.get('cache-control'), /immutable/);
  for (const path of ['/data/imdb.sqlite.gz', '/data/version', '/api/me', '/api/ratings', '/api/tmdb/find/tt1']) {
    assert.equal((await call('anon', 'GET', path)).status, 401, path);
  }
});

test('static files cannot escape the web folder', async () => {
  for (const path of ['/..%2fsecret.txt', '/%2e%2e/secret.txt', '/..%2fusers.json']) {
    assert.equal((await call('anon', 'GET', path)).status, 404, path);
  }
});

test('login checks the password and ignores username case', async () => {
  assert.equal((await call('x', 'POST', '/api/login', { username: 'marc', password: 'wrong' })).status, 401);
  assert.equal((await call('x', 'POST', '/api/login', { username: 'nobody', password: 'wrong' })).status, 401);
  const res = await call('marc', 'POST', '/api/login', { username: 'Marc', password: 'correct horse' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  assert.deepEqual(await json('marc', 'GET', '/api/me'), { user: 'marc', others: ['thomas'], ratings: 0 });
  await call('thomas', 'POST', '/api/login', { username: 'thomas', password: 'battery staple' });
  assert.equal((await json('thomas', 'GET', '/api/me')).user, 'thomas');
});

test('the database needs a session and supports revalidation', async () => {
  const res = await call('marc', 'GET', '/data/imdb.sqlite.gz');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/gzip');
  assert.equal((await call('marc', 'GET', '/data/imdb.sqlite.gz', undefined, { 'if-none-match': res.headers.get('etag') })).status, 304);
  assert.equal((await json('marc', 'GET', '/data/version')).built_at, '2026-11-06 10:00:00');
});

test('CSV import reads the real IMDb format and keeps newer app ratings', async () => {
  assert.deepEqual(await json('marc', 'POST', '/api/ratings/import', CSV), { rows: 1, changed: 1, skipped: 0 });
  assert.deepEqual((await json('marc', 'GET', '/api/ratings'))[0],
    { tconst: 'tt31709373', rating: 9, ratedAt: '2026-11-05', source: 'imdb' });
  assert.equal((await call('marc', 'POST', '/api/ratings/import', 'a,b\n1,2')).status, 400);

  await call('marc', 'PUT', '/api/ratings/tt31709373', { rating: 4 });
  assert.equal((await json('marc', 'POST', '/api/ratings/import', CSV)).changed, 0);
  assert.equal((await json('marc', 'GET', '/api/ratings'))[0].rating, 4);
  assert.equal((await json('marc', 'GET', '/api/me')).ratings, 1);
  assert.equal((await call('marc', 'PUT', '/api/ratings/tt1', { rating: 11 })).status, 400);
});

test('users see each other\'s ratings only through the shared view', async () => {
  assert.deepEqual(await json('thomas', 'GET', '/api/ratings'), []);
  assert.deepEqual(await json('thomas', 'GET', '/api/ratings/shared'),
    [{ user: 'marc', ratings: [{ tconst: 'tt31709373', rating: 4 }] }]);
  await call('marc', 'PUT', '/api/watchlist/tt1');
  assert.deepEqual(await json('thomas', 'GET', '/api/watchlist'), []);
});

test('watchlist and settings round trip', async () => {
  await call('marc', 'PUT', '/api/watchlist/tt2');
  await call('marc', 'DELETE', '/api/watchlist/tt1');
  assert.deepEqual((await json('marc', 'GET', '/api/watchlist')).map((w) => w.tconst), ['tt2']);
  assert.deepEqual(await json('marc', 'POST', '/api/watchlist/import',
    [{ tconst: 'tt3', addedAt: 1700000000000 }, { tconst: 'bad' }, { tconst: 'tt2' }]), { rows: 2, added: 1 });
  await call('marc', 'PUT', '/api/settings', { region: 'CH' });
  assert.deepEqual(await json('marc', 'GET', '/api/settings'), { region: 'CH' });
});

test('TMDB: allowed paths only, cached, key never returned', async () => {
  assert.equal((await call('marc', 'GET', '/api/tmdb/account')).status, 404);
  assert.equal((await call('marc', 'GET', '/api/tmdb/movie/1/credits')).status, 404);
  const body = await (await call('marc', 'GET', '/api/tmdb/find/tt1375666')).text();
  await call('marc', 'GET', '/api/tmdb/find/tt1375666');
  assert.equal(tmdbCalls.length, 1);
  assert.match(tmdbCalls[0].url, /external_source=imdb_id/);
  assert.ok(!body.includes('kkkk'));
});

test('writes from another site are refused', async () => {
  assert.equal((await call('marc', 'PUT', '/api/ratings/tt9', { rating: 5 }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('marc', 'PUT', '/api/ratings/tt9', { rating: 5 }, { origin: base })).status, 200);
});

test('logout ends the session on the server', async () => {
  const cookie = jar.thomas;
  await call('thomas', 'POST', '/api/logout');
  assert.equal((await call('old', 'GET', '/api/me', undefined, { cookie })).status, 401);
});

test('password hashes verify, and repeated failures block', async () => {
  const hash = await hashPassword('secret word', { n: 2 ** 10 });
  assert.ok(await verifyPassword('secret word', hash));
  assert.ok(!await verifyPassword('other', hash));
  let t = 0;
  const limit = throttle({ limit: 2, windowMs: 100, now: () => t });
  limit.fail('ip'); limit.fail('ip');
  assert.ok(limit.blocked('ip'));
  t = 200;
  assert.ok(!limit.blocked('ip'));
});

test('login is limited per address', async () => {
  const body = { username: 'marc', password: 'wrong' };
  const headers = { 'x-forwarded-for': '203.0.113.9' };
  for (let i = 0; i < 5; i++) assert.equal((await call('y', 'POST', '/api/login', body, headers)).status, 401);
  assert.equal((await call('y', 'POST', '/api/login', body, headers)).status, 429);
});

test('CSV parser handles quotes, BOM and bad rows', () => {
  const { rows, skipped } = parseRatings('﻿Const,Your Rating,Date Rated\r\ntt1,8,2020-01-02\r\nxx,8,\r\ntt2,99,\r\n"tt3",10,\r\n');
  assert.deepEqual(rows, [{ tconst: 'tt1', rating: 8, ratedAt: '2020-01-02' }, { tconst: 'tt3', rating: 10, ratedAt: null }]);
  assert.equal(skipped, 2);
});

test('backups run once a day and keep seven', () => {
  let day = 1;
  const s = openStore(':memory:', { now: () => `2026-01-${String(day).padStart(2, '0')}T00:00:00Z` });
  const dirB = join(dir, 'b');
  assert.ok(s.backup(dirB));
  assert.ok(!s.backup(dirB));
  for (day = 2; day <= 10; day++) s.backup(dirB);
  s.close();
  assert.equal(readdirSync(dirB).length, 7);
});
