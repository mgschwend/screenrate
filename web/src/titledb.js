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
  similar(tconst, limit = 12) {
    let ids = [], why = [];
    const id = Number(tconst.slice(2));
    try {
      const row = this.db.selectObject('SELECT others, why FROM similar WHERE id = ?', [id]);
      if (row) { ids = row.others.split(','); why = row.why.split(','); }
    } catch {
      try { // DB built before reasons existed
        ids = (this.db.selectValue('SELECT others FROM similar WHERE id = ?', [id]) || '').split(',').filter(Boolean);
      } catch { return []; }
    }
    ids = ids.slice(0, limit).map((n) => `tt${n.padStart(7, '0')}`);
    if (!ids.length) return [];
    const rows = this.db.selectObjects(`SELECT ${COLS} FROM titles t WHERE t.tconst IN (${ids.map(() => '?').join(',')})`, ids).map(plain);
    const byId = new Map(rows.map((r) => [r.tconst, r]));
    return ids.map((i, n) => {
      const t = byId.get(i);
      return t && { ...t, why: this.#reason(why[n]) };
    }).filter(Boolean);
  }

  /** "d12" → "Dir. Christopher Nolan" (see scripts/add_similar.py). */
  #reason(code) {
    if (!code) return '';
    const name = this.db.selectValue('SELECT name FROM people WHERE id = ?', [Number(code.slice(1))]);
    if (!name) return '';
    return `${{ d: 'Dir.', w: 'Writer', a: 'With' }[code[0]]} ${name}`;
  }

  /** Fallback when no precomputed list: most-voted titles sharing the first genre and type. */
  sameGenre(tconst, limit = 12) {
    try {
      const g = this.db.selectValue('SELECT genres FROM titles WHERE tconst = ?', [tconst]);
      const first = (g || '').split(',')[0];
      if (!first) return [];
      return this.db.selectObjects(
        `SELECT ${COLS} FROM titles t WHERE t.tconst != ?1 AND (',' || t.genres || ',') LIKE '%,' || ?2 || ',%'
           AND t.type = (SELECT type FROM titles WHERE tconst = ?1) ORDER BY t.votes DESC LIMIT ?3`, [tconst, first, limit])
        .map((t) => ({ ...plain(t), why: `Also ${first}` }));
    } catch { return []; }
  }

  /** Regions with precomputed Netflix data (scripts/add_netflix.py), e.g. ['CH']; [] if none. */
  netflixRegions() {
    try { return (this.db.selectValue("SELECT value FROM meta WHERE key = 'netflix_regions'") || '').split(',').filter(Boolean); }
    catch { return []; }
  }

  /** Set of tconsts on Netflix (subscription) in `region`. */
  netflixSet(region) {
    try {
      return new Set(this.db.selectValues('SELECT id FROM netflix WHERE region = ?', [region])
        .map((n) => `tt${String(n).padStart(7, '0')}`));
    } catch { return new Set(); }
  }

  /** Similar ids only, best first: cheap enough to run over all of someone's ratings. */
  similarIds(tconst) {
    try {
      const row = this.db.selectValue('SELECT others FROM similar WHERE id = ?', [Number(tconst.slice(2))]);
      return row ? row.split(',').map((n) => `tt${n.padStart(7, '0')}`) : [];
    } catch { return []; }
  }

  /** Rows for many ids, in no particular order. */
  many(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      out.push(...this.db.selectObjects(`SELECT ${COLS} FROM titles t WHERE t.tconst IN (${part.map(() => '?').join(',')})`, part).map(plain));
    }
    return out;
  }

  /** Most-voted titles overall, for quick rating. */
  popular(limit = 500) {
    return this.db.selectObjects(`SELECT ${COLS} FROM titles t ORDER BY t.votes DESC LIMIT ?`, [limit]).map(plain);
  }

  /** Every genre in the database, A to Z. */
  genres() {
    try {
      const seen = new Set();
      for (const list of this.db.selectValues("SELECT DISTINCT genres FROM titles WHERE genres != ''")) {
        for (const g of list.split(',')) seen.add(g);
      }
      return [...seen].sort();
    } catch { return []; }
  }

  /** Who made these titles and their genres, for the taste profile. Skips ids missing from the database. */
  tasteRows(ids) {
    const rows = [];
    try {
      for (let i = 0; i < ids.length; i += 500) {
        const part = ids.slice(i, i + 500);
        rows.push(...this.db.selectObjects(`SELECT t.tconst, t.year, t.genres, p.people FROM titles t
          LEFT JOIN title_people p ON p.id = CAST(substr(t.tconst, 3) AS INTEGER)
          WHERE t.tconst IN (${part.map(() => '?').join(',')})`, part));
      }
      const codes = [...new Set(rows.flatMap((r) => (r.people || '').split(',').filter(Boolean).map((c) => Number(c.slice(1)))))];
      const names = new Map();
      for (let i = 0; i < codes.length; i += 500) {
        const part = codes.slice(i, i + 500);
        for (const p of this.db.selectObjects(`SELECT id, name FROM people WHERE id IN (${part.map(() => '?').join(',')})`, part)) names.set(p.id, p.name);
      }
      return rows.map((r) => ({
        tconst: r.tconst, year: r.year, genres: (r.genres || '').split(',').filter(Boolean),
        people: (r.people || '').split(',').filter(Boolean).map((c) => ({ role: c[0], name: names.get(Number(c.slice(1))) })).filter((p) => p.name),
      }));
    } catch { return []; } // database built before credits existed
  }

  /**
   * Where a title stands among its genre and kind. Takes the genre it does best in, among genres
   * big enough for a percentage to mean something.
   * @returns {{pct, genre, kind}|null} pct 3 = top 3%
   */
  ratingContext(tconst, minTitles = 100) {
    try {
      const t = this.db.selectObject('SELECT type, rating, genres FROM titles WHERE tconst = ?', [tconst]);
      const genres = (t?.genres || '').split(',').filter(Boolean);
      const film = t?.type === 'movie';
      let best = null;
      for (const genre of genres) {
        const row = this.db.selectObject(`SELECT COUNT(*) AS total, SUM(rating > ?) AS better FROM titles
          WHERE (',' || genres || ',') LIKE ? AND (type = 'movie') = ?`, [t.rating, `%,${genre},%`, film ? 1 : 0]);
        if (row.total < minTitles) continue;
        const pct = Math.max(1, Math.ceil(((row.better + 1) / row.total) * 100));
        if (!best || pct < best.pct) best = { pct, genre, kind: film ? 'films' : 'series' };
      }
      return best;
    } catch { return null; }
  }

  /**
   * Browse by quality rather than by name.
   * mode: 'gems' well rated but not widely known | 'top' best rated with many votes | 'new' recent and good
   * type: '' | 'film' | 'series'; genre: '' or an IMDb genre; region: only titles on Netflix there
   * Best first, by rating; `year` is passed in so "recent" is testable.
   */
  discover({ mode = 'gems', type = '', genre = '', region = null, limit = 300, year = new Date().getFullYear() } = {}) {
    const where = [], args = [];
    if (region) args.push(region);
    if (mode === 'gems') {
      where.push('t.rating >= 7.5', 't.votes BETWEEN 25000 AND 200000');
      if (genre !== 'Animation') where.push("(',' || t.genres || ',') NOT LIKE '%,Animation,%'");
    }
    if (mode === 'top') where.push('t.votes >= 50000');
    if (mode === 'new') { where.push('t.year >= ?', 't.rating >= 6.8', 't.votes >= 2000'); args.push(year - 2); }
    if (type === 'film') where.push("t.type = 'movie'");
    if (type === 'series') where.push("t.type != 'movie'");
    if (genre) { where.push("(',' || t.genres || ',') LIKE ?"); args.push(`%,${genre},%`); }
    const join = region ? "JOIN netflix n ON t.tconst = 'tt' || printf('%07d', n.id) AND n.region = ?" : '';
    const rows = this.db.selectObjects(`SELECT ${COLS} FROM titles t ${join} WHERE ${where.join(' AND ')}
      ORDER BY t.rating DESC, t.votes DESC LIMIT ?`, [...args, mode === 'gems' ? Math.max(limit, 2000) : limit]).map(plain);
    if (mode !== 'gems') return rows;
    // Fan favourites with few voters rate very high; more votes count as more proof.
    const score = (t) => t.rating + 0.5 * Math.log10(t.votes);
    return rows.sort((a, b) => score(b) - score(a)).slice(0, limit);
  }

  /** Most-voted titles on Netflix in `region`, for browsing without a search term. */
  netflixTop(region, limit = 50) {
    try {
      return this.db.selectObjects(
        `SELECT ${COLS} FROM netflix n JOIN titles t ON t.tconst = 'tt' || printf('%07d', n.id)
           WHERE n.region = ? ORDER BY t.votes DESC LIMIT ?`, [region, limit]).map(plain);
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
