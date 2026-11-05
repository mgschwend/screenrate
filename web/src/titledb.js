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
    if (loose) words = words.map((w) => (w.length > 4 ? w.slice(0, Math.max(3, Math.ceil(w.length * 0.6))) : w));
    const q = words.map((w) => `"${w}"*`).join(' ');
    try {
      return this.db.selectObjects(
        `SELECT ${COLS} FROM titles_fts f JOIN titles t ON t.tconst = f.tconst
         WHERE titles_fts MATCH ? ORDER BY t.votes DESC LIMIT ?`, [q, limit]).map(plain);
    } catch {
      return [];
    }
  }

  get(tconst) {
    const r = this.db.selectObject(`SELECT ${COLS} FROM titles t WHERE t.tconst = ?`, [tconst]);
    return r ? plain(r) : null;
  }

  meta() {
    const out = {};
    for (const { key, value } of this.db.selectObjects('SELECT key, value FROM meta')) out[key] = value;
    out.aka_count = String(this.db.selectValue('SELECT count(*) FROM akas'));
    return out;
  }
}

const plain = (r) => ({ ...r });
