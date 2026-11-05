// Optional posters via TMDB /find (user-supplied key; v3 api_key or v4 read token). App works without it.
import { settings, posterCache } from './store.js';

const IMG = 'https://image.tmdb.org/t/p/w185';
const inflight = new Map();

/** @returns {Promise<string|null>} poster URL, '' cached as "none", null when no key/failed. */
export function posterFor(tconst) {
  const cached = posterCache.get(tconst);
  if (cached !== undefined) return Promise.resolve(cached || null);
  const key = settings.get().tmdbKey.trim();
  if (!key) return Promise.resolve(null);
  if (inflight.has(tconst)) return inflight.get(tconst);

  const isBearer = key.length > 40; // v4 read access tokens are long JWTs
  const url = `https://api.themoviedb.org/3/find/${tconst}?external_source=imdb_id${isBearer ? '' : `&api_key=${encodeURIComponent(key)}`}`;
  const p = fetch(url, { headers: isBearer ? { Authorization: `Bearer ${key}` } : {}, referrerPolicy: 'no-referrer' })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`TMDB ${r.status}`))))
    .then((j) => {
      const hit = [...(j.movie_results || []), ...(j.tv_results || [])].find((x) => x.poster_path);
      const poster = hit ? IMG + hit.poster_path : '';
      posterCache.set(tconst, poster);
      return poster || null;
    })
    .catch(() => null)
    .finally(() => inflight.delete(tconst));
  inflight.set(tconst, p);
  return p;
}
