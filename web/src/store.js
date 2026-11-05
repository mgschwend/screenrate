// localStorage-backed state: history, watchlist, remembered choices, settings, poster cache.
const K = {
  history: 'screenrate.history',
  watchlist: 'screenrate.watchlist',
  settings: 'screenrate.settings',
  posters: 'screenrate.posters',
};
const HISTORY_MAX = 100;

const read = (k, fallback) => {
  try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; }
};
const write = (k, v) => localStorage.setItem(k, JSON.stringify(v));

const SETTINGS_SCHEMA = 3;
export const settings = {
  defaults: { tmdbKey: '', region: 'CH', netflixOnly: false, schema: SETTINGS_SCHEMA },
  get() {
    const stored = read(K.settings, {});
    if (stored.schema !== SETTINGS_SCHEMA) { // migrate: keep only what still exists
      const migrated = { ...this.defaults, tmdbKey: stored.tmdbKey || '' };
      write(K.settings, migrated);
      return migrated;
    }
    return { ...this.defaults, ...stored };
  },
  set(patch) { write(K.settings, { ...this.get(), ...patch }); },
};

/** Recently opened titles: {tconst, title, year, type, rating, at}. Deduped, newest last. */
export const history = {
  all() { // newest last; dedupe (older app versions stored repeats)
    const rows = read(K.history, []).filter((r) => r.tconst);
    const seen = new Set();
    return rows.reverse().filter((r) => !seen.has(r.tconst) && seen.add(r.tconst)).reverse();
  },
  add(t) {
    const rows = this.all().filter((r) => r.tconst !== t.tconst);
    rows.push({ tconst: t.tconst, title: t.title, year: t.year, type: t.type, rating: t.rating, at: Date.now() });
    write(K.history, rows.slice(-HISTORY_MAX));
  },
  clear() { localStorage.removeItem(K.history); },
};

/** Watchlist rows: {tconst, title, year, rating, addedAt}. Newest first. */
export const watchlist = {
  all() { return read(K.watchlist, []); },
  has(tconst) { return this.all().some((w) => w.tconst === tconst); },
  add(t) {
    if (this.has(t.tconst)) return;
    write(K.watchlist, [{ tconst: t.tconst, title: t.title, year: t.year, rating: t.rating, addedAt: Date.now() },
      ...this.all()]);
  },
  remove(tconst) { write(K.watchlist, this.all().filter((w) => w.tconst !== tconst)); },
  restore(row) { write(K.watchlist, [row, ...this.all().filter((w) => w.tconst !== row.tconst)]); },
};

export const posterCache = {
  get(tconst) { return read(K.posters, {})[tconst]; },
  set(tconst, url) { write(K.posters, { ...read(K.posters, {}), [tconst]: url }); },
  clear() { localStorage.removeItem(K.posters); },
};
