// Fetch the film database (login required) → keep the gzip in Cache Storage → open it in memory.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { LoginRequired } from './api.js';
import { TitleDb } from './titledb.js';

export const DB_URL = new URL('data/imdb.sqlite.gz', document.baseURI).href;
const DATA_CACHE = 'screenrate-data';

async function gzipBytes({ force = false, onProgress } = {}) {
  const cache = await caches.open(DATA_CACHE);
  const hit = !force && await cache.match(DB_URL);
  if (hit) return hit.arrayBuffer();
  const net = await fetch(DB_URL, { cache: 'no-store' });
  if (net.status === 401) throw new LoginRequired('Login required');
  if (!net.ok) throw new Error(`Download failed (HTTP ${net.status})`);
  const buf = await readWithProgress(net, onProgress);
  await cache.put(DB_URL, new Response(buf, { headers: { 'content-type': 'application/gzip' } }));
  return buf;
}

async function readWithProgress(res, onProgress) {
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !onProgress) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    onProgress(got, total);
  }
  const out = new Uint8Array(got); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out.buffer;
}

async function gunzip(buf) {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

let sqlite3Promise;
function sqlite3() {
  sqlite3Promise ||= sqlite3InitModule({ print: () => {}, printErr: () => {} });
  return sqlite3Promise;
}

function openBytes(sqlite, bytes) {
  const p = sqlite.wasm.allocFromTypedArray(bytes);
  const db = new sqlite.oo1.DB();
  const rc = sqlite.capi.sqlite3_deserialize(db.pointer, 'main', p, bytes.length, bytes.length,
    sqlite.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite.capi.SQLITE_DESERIALIZE_READONLY);
  if (rc) throw new Error(`sqlite3_deserialize failed (${rc})`);
  return new TitleDb(db);
}

/** Open the DB. Throws LoginRequired when there's no cached copy and no session. */
export async function openDatabase({ force = false, onProgress } = {}) {
  const [gz, sqlite] = await Promise.all([gzipBytes({ force, onProgress }), sqlite3()]);
  return openBytes(sqlite, await gunzip(gz));
}

export const forgetDatabase = async () => { await caches.delete(DATA_CACHE); };
