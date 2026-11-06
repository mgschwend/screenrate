// app.sqlite: sessions and each user's ratings, watchlist and settings.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS ratings (user TEXT NOT NULL, tconst TEXT NOT NULL, rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 10),
    rated_at TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('imdb', 'app')), PRIMARY KEY (user, tconst)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS watchlist (user TEXT NOT NULL, tconst TEXT NOT NULL, added_at TEXT NOT NULL, PRIMARY KEY (user, tconst)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS settings (user TEXT PRIMARY KEY, json TEXT NOT NULL);`;

export function openStore(path, { now = () => new Date().toISOString() } = {}) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  const q = (sql) => db.prepare(sql);

  const tx = (fn) => {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  const upsertImport = q(`INSERT INTO ratings VALUES (?, ?, ?, ?, 'imdb')
    ON CONFLICT (user, tconst) DO UPDATE SET rating = excluded.rating, rated_at = excluded.rated_at, source = 'imdb'
    WHERE ratings.source = 'imdb' OR excluded.rated_at > ratings.rated_at`);

  return {
    db,
    close: () => db.close(),

    // ---- sessions ----
    addSession(hash, user) { const t = now(); q('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(hash, user, t, t); },
    dropSession(hash) { q('DELETE FROM sessions WHERE token_hash = ?').run(hash); },
    /** User of a live session, renewing it at most once a day. */
    sessionUser(hash, maxAgeDays) {
      const row = q('SELECT user, last_seen_at FROM sessions WHERE token_hash = ?').get(hash);
      if (!row) return null;
      const age = (new Date(now()) - new Date(row.last_seen_at)) / 86_400_000;
      if (age > maxAgeDays) { this.dropSession(hash); return null; }
      if (age > 1) q('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(now(), hash);
      return row.user;
    },

    // ---- ratings ----
    ratings: (user) => q('SELECT tconst, rating, rated_at AS ratedAt, source FROM ratings WHERE user = ?').all(user),
    ratingCount: (user) => q('SELECT COUNT(*) AS n FROM ratings WHERE user = ?').get(user).n,
    setRating(user, tconst, rating) {
      q(`INSERT INTO ratings VALUES (?, ?, ?, ?, 'app') ON CONFLICT (user, tconst)
         DO UPDATE SET rating = excluded.rating, rated_at = excluded.rated_at, source = 'app'`).run(user, tconst, rating, now());
    },
    deleteRating(user, tconst) { q('DELETE FROM ratings WHERE user = ? AND tconst = ?').run(user, tconst); },
    /** IMDb rows win over older ratings, but never over a newer rating made in the app. */
    importRatings(user, rows) {
      const stamp = now().slice(0, 10);
      return tx(() => rows.reduce((n, r) => n + Number(upsertImport.run(user, r.tconst, r.rating, r.ratedAt || stamp).changes), 0));
    },

    // ---- watchlist ----
    watchlist: (user) => q('SELECT tconst, added_at AS addedAt FROM watchlist WHERE user = ? ORDER BY added_at DESC').all(user),
    addWatch(user, tconst, addedAt) { q('INSERT OR IGNORE INTO watchlist VALUES (?, ?, ?)').run(user, tconst, addedAt || now()); },
    removeWatch(user, tconst) { q('DELETE FROM watchlist WHERE user = ? AND tconst = ?').run(user, tconst); },
    importWatchlist(user, rows) {
      const add = q('INSERT OR IGNORE INTO watchlist VALUES (?, ?, ?)');
      return tx(() => rows.reduce((n, r) => n + Number(add.run(user, r.tconst, r.addedAt || now()).changes), 0));
    },

    // ---- settings ----
    settings(user) { return JSON.parse(q('SELECT json FROM settings WHERE user = ?').get(user)?.json ?? '{}'); },
    setSettings(user, value) {
      q('INSERT INTO settings VALUES (?, ?) ON CONFLICT (user) DO UPDATE SET json = excluded.json').run(user, JSON.stringify(value));
    },

    /** One consistent copy per day in `dir`, keeping the newest `keep`. */
    backup(dir, keep = 7) {
      mkdirSync(dir, { recursive: true });
      const name = `app-${now().slice(0, 10)}.sqlite`;
      if (readdirSync(dir).includes(name)) return false;
      q('VACUUM INTO ?').run(join(dir, name));
      for (const old of readdirSync(dir).filter((f) => /^app-.*\.sqlite$/.test(f)).sort().reverse().slice(keep)) rmSync(join(dir, old));
      return true;
    },
  };
}
