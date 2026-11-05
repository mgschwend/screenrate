// Fetch (Cache Storage) → decrypt (WebCrypto) → open (sqlite-wasm, in memory).
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { deriveKey, decryptDb } from './dbcrypto.js';
import { TitleDb } from './titledb.js';

export const DB_URL = new URL('imdb.sqlite.enc', document.baseURI).href;
const DATA_CACHE = 'screenrate-data';
const IDB_NAME = 'screenrate';
const KEY_ID = 'dbkey';
const PASS_FALLBACK = 'screenrate.passphrase'; // only if this browser cannot store CryptoKey in IndexedDB

// ---- key storage (non-extractable CryptoKey in IndexedDB) ----
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(IDB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(key) {
  const db = await idb();
  return new Promise((res, rej) => {
    const r = db.transaction('kv').objectStore('kv').get(key);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbSet(key, value) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    value === undefined ? tx.objectStore('kv').delete(key) : tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}

export async function storedKey() {
  try {
    const k = await idbGet(KEY_ID);
    if (k) return k;
  } catch { /* fall through */ }
  const p = localStorage.getItem(PASS_FALLBACK);
  return p ? deriveKey(p) : null;
}

async function storeKey(key, passphrase) {
  try { await idbSet(KEY_ID, key); return; } catch { /* CryptoKey not cloneable here */ }
  localStorage.setItem(PASS_FALLBACK, passphrase);
}

export async function forgetKey() {
  try { await idbSet(KEY_ID, undefined); } catch { /* ignore */ }
  localStorage.removeItem(PASS_FALLBACK);
}

// ---- encrypted file in Cache Storage ----
async function encryptedBytes({ force = false, onProgress } = {}) {
  const cache = await caches.open(DATA_CACHE);
  if (force) await cache.delete(DB_URL);
  let res = await cache.match(DB_URL);
  if (!res) {
    const net = await fetch(DB_URL, { cache: 'no-store' });
    if (!net.ok) throw new Error(`Download failed (HTTP ${net.status})`);
    const buf = await readWithProgress(net, onProgress);
    await cache.put(DB_URL, new Response(buf, { headers: { 'content-type': 'application/octet-stream' } }));
    return buf;
  }
  return res.arrayBuffer();
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

// ---- sqlite ----
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

/**
 * Open the DB. With `passphrase`, derives + stores a new key; otherwise uses the stored key.
 * Throws {code:'NO_KEY'} when nothing is stored, {code:'BAD_KEY'} when decryption fails.
 */
export async function openDatabase({ passphrase, force = false, onProgress } = {}) {
  let key = passphrase ? await deriveKey(passphrase) : await storedKey();
  if (!key) throw Object.assign(new Error('Passphrase needed'), { code: 'NO_KEY' });
  const [enc, sqlite] = await Promise.all([encryptedBytes({ force, onProgress }), sqlite3()]);
  let bytes;
  try {
    bytes = await decryptDb(enc, key);
  } catch {
    throw Object.assign(new Error('Wrong passphrase'), { code: 'BAD_KEY' });
  }
  if (passphrase) await storeKey(key, passphrase);
  return openBytes(sqlite, bytes);
}
