// Passwords (scrypt at OWASP settings), sessions and login throttling. Node built-ins only.
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';

const scrypt = promisify(scryptCb);
const N = 2 ** 17, R = 8, P = 1, KEY_LEN = 32;
const MAXMEM = 256 * 1024 * 1024; // scrypt needs 128 MiB at these settings

export const COOKIE = 'sr_session';
export const SESSION_DAYS = 365;

export async function hashPassword(password, { n = N } = {}) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LEN, { N: n, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${n}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [kind, n, r, p, salt, hash] = String(stored).split('$');
  if (kind !== 'scrypt') return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(password, Buffer.from(salt, 'base64'), want.length,
    { N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM });
  return timingSafeEqual(got, want);
}

/** { username: hash } from users.json; read per login, so a password change needs no restart. */
export function readUsers(file) {
  const users = JSON.parse(readFileSync(file, 'utf8'));
  return Object.fromEntries(Object.entries(users).map(([name, hash]) => [name.toLowerCase(), hash]));
}

export const newToken = () => randomBytes(32).toString('base64url');
export const tokenHash = (token) => createHash('sha256').update(token).digest('hex');

export function cookieHeader(token, { secure, maxAgeDays = SESSION_DAYS }) {
  return [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeDays * 86400}`,
    ...(secure ? ['Secure'] : [])].join('; ');
}

export function readCookie(header, name = COOKIE) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** At most `limit` failures per key per window; a success clears the key. */
export function throttle({ limit = 5, windowMs = 60_000, now = Date.now } = {}) {
  const seen = new Map();
  const live = (key) => {
    const e = seen.get(key);
    if (e && now() - e.start > windowMs) { seen.delete(key); return null; }
    return e;
  };
  return {
    blocked: (key) => (live(key)?.count ?? 0) >= limit,
    fail(key) {
      const e = live(key) ?? { start: now(), count: 0 };
      e.count += 1;
      seen.set(key, e);
      if (seen.size > 10_000) seen.delete(seen.keys().next().value);
    },
    clear: (key) => seen.delete(key),
  };
}
