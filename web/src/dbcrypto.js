// Decrypts imdb.sqlite.enc produced by scripts/encrypt_db.py — keep in sync.
// Layout: "SRDB" | version(1) | iv(12) | AES-256-GCM(gzip(sqlite)) ; AAD = first 5 bytes.
const MAGIC = [0x53, 0x52, 0x44, 0x42]; // "SRDB"
const VERSION = 1;
const SALT = 'screenrate/imdb-db/v1';
const ITERATIONS = 600_000;

/** Derive the AES key from the passphrase (non-extractable; can be stored in IndexedDB). */
export async function deriveKey(passphrase) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(SALT), iterations: ITERATIONS },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}

/** @returns {Promise<Uint8Array>} raw sqlite bytes; throws on wrong key or corrupt file. */
export async function decryptDb(buffer, key) {
  const u8 = new Uint8Array(buffer);
  if (u8.length < 17 + 16 || MAGIC.some((b, i) => u8[i] !== b) || u8[4] !== VERSION) {
    throw new Error('Not a ScreenRate encrypted DB (bad magic/version)');
  }
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: u8.subarray(5, 17), additionalData: u8.subarray(0, 5) },
    key, u8.subarray(17));
  const stream = new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
