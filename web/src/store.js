// Local state. Ratings, watchlist and settings live on the server with a copy here for offline reading;
// changes need a connection. History and poster URLs stay on each device.
import { api } from './api.js';

const K = {
  history: 'screenrate.history',
  watchlist: 'screenrate.watchlist',
  settings: 'screenrate.settings',
  posters: 'screenrate.posters',
  ratings: 'screenrate.ratings',
  shared: 'screenrate.shared',
  account: 'screenrate.account',
  skipped: 'screenrate.skipped',
};
const HISTORY_MAX = 100;

const read = (k, fallback) => {
  try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; }
};
const write = (k, v) => localStorage.setItem(k, JSON.stringify(v));

export const account = {
  get: () => read(K.account, null), // {user, others}
  set: (value) => write(K.account, value),
};

const SETTINGS_DEFAULTS = {
  region: 'CH', netflixOnly: false, forYouNetflix: false, withOthers: false,
  discover: { mode: 'gems', type: '', genre: '', netflix: true },
};
export const settings = {
  get() { return { ...SETTINGS_DEFAULTS, ...read(K.settings, {}) }; },
  set(patch) {
    const next = { ...this.get(), ...patch };
    write(K.settings, next);
    api.saveSettings(next).catch(() => {}); // kept locally; the next change or sync carries it over
  },
  async sync() { write(K.settings, { ...this.get(), ...await api.settings() }); },
};

/** Recently opened titles: {tconst, title, year, type, rating, at}. Deduped, newest last. */
export const history = {
  all() {
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

/** Watchlist rows: {tconst, addedAt}, newest first. */
export const watchlist = {
  all() { return read(K.watchlist, []); },
  has(tconst) { return this.all().some((w) => w.tconst === tconst); },
  async add(tconst) {
    await api.addWatch(tconst);
    write(K.watchlist, [{ tconst, addedAt: new Date().toISOString() }, ...this.all().filter((w) => w.tconst !== tconst)]);
  },
  async remove(tconst) {
    await api.removeWatch(tconst);
    write(K.watchlist, this.all().filter((w) => w.tconst !== tconst));
  },
  async sync() { write(K.watchlist, await api.watchlist()); },
};

/** My ratings: {tconst: rating}. */
export const ratings = {
  all() { return read(K.ratings, {}); },
  get(tconst) { return this.all()[tconst]; },
  count() { return Object.keys(this.all()).length; },
  async set(tconst, rating) {
    await api.setRating(tconst, rating);
    write(K.ratings, { ...this.all(), [tconst]: rating });
  },
  async clear(tconst) {
    await api.deleteRating(tconst);
    const { [tconst]: _, ...rest } = this.all();
    write(K.ratings, rest);
  },
  async sync() { write(K.ratings, Object.fromEntries((await api.ratings()).map((r) => [r.tconst, r.rating]))); },
};

/** The other user's ratings: [{user, ratings: {tconst: rating}}]. */
export const shared = {
  all() { return read(K.shared, []); },
  of(tconst) {
    return this.all().filter((o) => o.ratings[tconst]).map((o) => ({ user: o.user, rating: o.ratings[tconst] }));
  },
  async sync() {
    const list = await api.sharedRatings();
    write(K.shared, list.map(({ user, ratings: rows }) => ({ user, ratings: Object.fromEntries(rows.map((r) => [r.tconst, r.rating])) })));
  },
};

/** Titles passed over as "Not seen" in quick rating, so they don't come back on this device. */
export const skipped = {
  all() { return new Set(read(K.skipped, [])); },
  add(tconst) { write(K.skipped, [...this.all(), tconst]); },
};

export const posterCache = {
  get(tconst) { return read(K.posters, {})[tconst]; },
  set(tconst, url) { write(K.posters, { ...read(K.posters, {}), [tconst]: url }); },
};

/** Remove everything personal from this device. Posters aren't personal, and history goes with the user. */
export function clearAccount() {
  for (const key of [K.account, K.watchlist, K.settings, K.ratings, K.shared, K.history, K.skipped]) localStorage.removeItem(key);
}
