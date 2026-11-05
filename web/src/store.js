// localStorage-backed state: history, watchlist, remembered choices, settings, poster cache.
const K = {
  history: 'screenrate.history',
  watchlist: 'screenrate.watchlist',
  remembered: 'screenrate.remembered',
  settings: 'screenrate.settings',
  posters: 'screenrate.posters',
};
const HISTORY_MAX = 500;

const read = (k, fallback) => {
  try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; }
};
const write = (k, v) => localStorage.setItem(k, JSON.stringify(v));

export const settings = {
  defaults: { tmdbKey: '', fps: 3, preprocess: true, minConfidence: 0.6 },
  get() { return { ...this.defaults, ...read(K.settings, {}) }; },
  set(patch) { write(K.settings, { ...this.get(), ...patch }); },
};

export const remembered = {
  all() { return read(K.remembered, {}); },
  set(norm, tconst) { write(K.remembered, { ...this.all(), [norm]: tconst }); },
  clear() { localStorage.removeItem(K.remembered); },
};

/** History rows: {id, norm, tconst|null, title, year, rating, at}. Append-only; rows update in place. */
export const history = {
  all() { return read(K.history, []); },
  add(row) {
    const rows = this.all();
    rows.push({ id: crypto.randomUUID(), at: Date.now(), ...row });
    write(K.history, rows.slice(-HISTORY_MAX));
    return rows[rows.length - 1];
  },
  update(id, patch) {
    const rows = this.all();
    const r = rows.find((x) => x.id === id);
    if (r) Object.assign(r, patch);
    write(K.history, rows);
    return r;
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
