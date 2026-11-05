// Optional TMDB extras (user-supplied key; v3 api_key or v4 read token): posters + recommendations.
// The app works fully without a key.
import { settings, posterCache } from './store.js';
import { normalize } from './normalize.js';

const IMG = 'https://image.tmdb.org/t/p/w185';
const findCache = new Map(); // tconst → Promise<{id, media, poster}|null>
const recCache = new Map();  // tconst → Promise<rows>

function key() { return settings.get().tmdbKey.trim(); }

function api(path) {
  const k = key();
  const bearer = k.length > 40; // v4 read access tokens are long JWTs
  const sep = path.includes('?') ? '&' : '?';
  const url = `https://api.themoviedb.org/3${path}${bearer ? '' : `${sep}api_key=${encodeURIComponent(k)}`}`;
  return fetch(url, { headers: bearer ? { Authorization: `Bearer ${k}` } : {}, referrerPolicy: 'no-referrer' })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`TMDB ${r.status}`))));
}

/** TMDB entry for an IMDb id via /find. */
function find(tconst) {
  if (!findCache.has(tconst)) {
    findCache.set(tconst, api(`/find/${tconst}?external_source=imdb_id`).then((j) => {
      const m = j.movie_results?.[0], tv = j.tv_results?.[0];
      const hit = m ? { ...m, media: 'movie' } : tv ? { ...tv, media: 'tv' } : null;
      const poster = hit?.poster_path ? IMG + hit.poster_path : '';
      posterCache.set(tconst, poster);
      return hit && { id: hit.id, media: hit.media, poster };
    }).catch(() => { findCache.delete(tconst); return null; }));
  }
  return findCache.get(tconst);
}

/** @returns {Promise<string|null>} poster URL or null (no key / none / failed). */
export async function posterFor(tconst) {
  const cached = posterCache.get(tconst);
  if (cached !== undefined) return cached || null;
  if (!key()) return null;
  return (await find(tconst))?.poster || null;
}

/**
 * TMDB "people also liked" recommendations, mapped back to local IMDb titles (exact title + year ±1)
 * so every entry has an IMDb rating. [] without a key.
 */
export function recommendationsFor(tdb, tconst, limit = 10) {
  if (!key()) return Promise.resolve([]);
  if (!recCache.has(tconst)) {
    recCache.set(tconst, (async () => {
      const f = await find(tconst);
      if (!f) return [];
      const j = await api(`/${f.media}/${f.id}/recommendations`);
      const out = [];
      for (const r of j.results || []) {
        const title = r.title || r.name, date = r.release_date || r.first_air_date || '';
        const year = Number(date.slice(0, 4)) || null;
        const local = tdb.exact(normalize(title)).find((t) => !year || !t.year || Math.abs(t.year - year) <= 1);
        if (local && local.tconst !== tconst && !out.some((o) => o.tconst === local.tconst)) {
          if (r.poster_path) posterCache.set(local.tconst, IMG + r.poster_path);
          out.push(local);
        }
        if (out.length >= limit) break;
      }
      return out;
    })().catch(() => { recCache.delete(tconst); return []; }));
  }
  return recCache.get(tconst);
}

/**
 * Live streaming availability for one title in `region` (TMDB watch providers, data by JustWatch).
 * @returns {Promise<{flatrate: string[], netflix: boolean, link: string}|null>} null without key / not found.
 */
export async function providersFor(tconst, region) {
  if (!key()) return null;
  try {
    const f = await find(tconst);
    if (!f) return null;
    const j = await api(`/${f.media}/${f.id}/watch/providers`);
    const r = j.results?.[region];
    const flatrate = [...(r?.flatrate || []), ...(r?.ads || [])].map((p) => p.provider_name);
    const unique = [...new Set(flatrate)];
    return { flatrate: unique, netflix: unique.some((n) => /^netflix/i.test(n)), link: r?.link || '' };
  } catch { return null; }
}
