// Query layer over the IMDb sqlite (no DOM; used by the app and by node tests).
// Wraps a @sqlite.org/sqlite-wasm oo1.DB.

const COLS = 't.tconst, t.type, t.title, t.originalTitle, t.year, t.rating, t.votes, t.normTitle, t.normOriginal';

export class TitleDb {
  constructor(db) { this.db = db; }

  /** Exact match on normTitle / normOriginal / DE-CH-AT aka. */
  exact(norm) {
    if (!norm) return [];
    return this.db.selectObjects(
      `SELECT ${COLS} FROM titles t WHERE t.normTitle = ?1 OR t.normOriginal = ?1
       UNION
       SELECT ${COLS} FROM akas a JOIN titles t ON t.tconst = a.tconst WHERE a.normTitle = ?1
       ORDER BY votes DESC LIMIT 25`, [norm]).map(plain);
  }

  /** FTS5 prefix match requiring every word ("dun* par* two*"). */
  prefix(norm, limit = 60, { loose = false } = {}) {
    let words = norm.split(' ').filter(Boolean);
    if (!words.length) return [];
    // loose: tolerate OCR errors at word ends ("inceptior" → "incep*", "breaklng" → "break*")
    if (loose === 'short') words = words.map((w) => w.slice(0, 2));
    else if (loose) words = words.map((w) => (w.length > 4 ? w.slice(0, Math.max(3, Math.ceil(w.length * 0.6))) : w));
    const q = words.map((w) => `"${w}"*`).join(' ');
    try {
      return this.db.selectObjects(
        `SELECT ${COLS} FROM titles_fts f JOIN titles t ON t.tconst = f.tconst
         WHERE titles_fts MATCH ? ORDER BY t.votes DESC LIMIT ?`, [q, limit]).map(plain);
    } catch {
      return [];
    }
  }

  /** Titles whose DE/CH/AT alias starts with `norm` (index range scan on akas.normTitle). */
  akaPrefix(norm, limit = 30) {
    if (!norm) return [];
    return this.db.selectObjects(
      `SELECT ${COLS}, a.title AS akaTitle FROM akas a JOIN titles t ON t.tconst = a.tconst
       WHERE a.normTitle >= ?1 AND a.normTitle < ?1 || '{' ORDER BY t.votes DESC LIMIT ?2`, [norm, limit]).map(plain);
  }

  /** Titles whose DE/CH/AT alias contains the phrase anywhere ("herr der ringe" → "der herr der ringe ..."). */
  akaContains(norm, limit = 30) {
    if (norm.length < 3) return [];
    return this.db.selectObjects(
      `SELECT ${COLS}, a.title AS akaTitle FROM akas a JOIN titles t ON t.tconst = a.tconst
       WHERE a.normTitle LIKE '%' || ?1 || '%' ORDER BY t.votes DESC LIMIT ?2`, [norm, limit]).map(plain);
  }

  get(tconst) {
    const r = this.db.selectObject(`SELECT ${COLS} FROM titles t WHERE t.tconst = ?`, [tconst]);
    if (!r) return null;
    const out = plain(r);
    try { out.genres = this.db.selectValue('SELECT genres FROM titles WHERE tconst = ?', [tconst]) || ''; } catch { /* old DB */ }
    return out;
  }

  /** Precomputed similar titles (scripts/add_similar.py), best first. [] if the DB predates that step. */
  similar(tconst, limit = 10) {
    let ids = [];
    try {
      const row = this.db.selectValue('SELECT others FROM similar WHERE id = ?', [Number(tconst.slice(2))]);
      if (row) ids = row.split(',').slice(0, limit).map((n) => `tt${n.padStart(7, '0')}`);
    } catch { return []; }
    if (!ids.length) return [];
    const rows = this.db.selectObjects(`SELECT ${COLS} FROM titles t WHERE t.tconst IN (${ids.map(() => '?').join(',')})`, ids).map(plain);
    const byId = new Map(rows.map((r) => [r.tconst, r]));
    return ids.map((i) => byId.get(i)).filter(Boolean);
  }

  /** Fallback when no precomputed list: most-voted titles sharing the first genre and type. */
  sameGenre(tconst, limit = 10) {
    try {
      const g = this.db.selectValue('SELECT genres FROM titles WHERE tconst = ?', [tconst]);
      const first = (g || '').split(',')[0];
      if (!first) return [];
      return this.db.selectObjects(
        `SELECT ${COLS} FROM titles t WHERE t.tconst != ?1 AND (',' || t.genres || ',') LIKE '%,' || ?2 || ',%'
           AND t.type = (SELECT type FROM titles WHERE tconst = ?1) ORDER BY t.votes DESC LIMIT ?3`, [tconst, first, limit]).map(plain);
    } catch { return []; }
  }

  hasSimilar() {
    try { return !!this.db.selectValue("SELECT 1 FROM sqlite_master WHERE name = 'similar'"); } catch { return false; }
  }

  meta() {
    const out = {};
    for (const { key, value } of this.db.selectObjects('SELECT key, value FROM meta')) out[key] = value;
    out.aka_count = String(this.db.selectValue('SELECT count(*) FROM akas'));
    return out;
  }
}

const plain = (r) => ({ ...r });
