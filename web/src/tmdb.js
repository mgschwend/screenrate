// TMDB extras, through our server so the key stays there: posters, recommendations, live streaming data.
// Everything here is optional: a failure just leaves that part out.
import { posterCache } from './store.js';
import { normalize } from './normalize.js';

const IMG = 'https://image.tmdb.org/t/p/w185';
const findCache = new Map(); // tconst → Promise<{id, media, poster}|null>
const recCache = new Map();  // tconst → Promise<rows>

function api(path) {
  return fetch(new URL(`api/tmdb${path}`, document.baseURI))
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`TMDB ${r.status}`))));
}

/** TMDB entry for an IMDb id via /find. */
function find(tconst) {
  if (!findCache.has(tconst)) {
    findCache.set(tconst, api(`/find/${tconst}`).then((j) => {
      const m = j.movie_results?.[0], tv = j.tv_results?.[0];
      const hit = m ? { ...m, media: 'movie' } : tv ? { ...tv, media: 'tv' } : null;
      const poster = hit?.poster_path ? IMG + hit.poster_path : '';
      posterCache.set(tconst, poster);
      return hit && { id: hit.id, media: hit.media, poster };
    }).catch(() => { findCache.delete(tconst); return null; }));
  }
  return findCache.get(tconst);
}

/** @returns {Promise<string|null>} poster URL or null (none / failed). */
export async function posterFor(tconst) {
  const cached = posterCache.get(tconst);
  if (cached !== undefined) return cached || null;
  return (await find(tconst))?.poster || null;
}

/**
 * TMDB "people also liked" recommendations, mapped back to local IMDb titles (exact title + year ±1)
 * so every entry has an IMDb rating.
 */
export function recommendationsFor(tdb, tconst, limit = 10) {
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
 * @returns {Promise<{flatrate: string[], netflix: boolean, link: string}|null>} null when not found or offline.
 */
export async function providersFor(tconst, region) {
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
