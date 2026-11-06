// TMDB calls go through the server so the key never reaches a browser. Only three read-only paths
// pass, and answers are cached for a day. Data must keep the "JustWatch (via TMDB)" credit in the app.
const ALLOWED = [
  /^\/find\/tt\d+$/,
  /^\/(movie|tv)\/\d+\/recommendations$/,
  /^\/(movie|tv)\/\d+\/watch\/providers$/,
];
const DAY = 86_400_000;
const MAX_ENTRIES = 20_000;

export function tmdbProxy({ key, fetchImpl = fetch, base = 'https://api.themoviedb.org/3', now = Date.now }) {
  const cache = new Map();
  const bearer = (key || '').length > 40;

  return async function proxy(path) {
    if (!ALLOWED.some((re) => re.test(path))) return { status: 404, body: { error: 'Not allowed' } };
    if (!key) return { status: 503, body: { error: 'TMDB is not configured' } };
    const hit = cache.get(path);
    if (hit && now() - hit.at < DAY) return { status: 200, body: hit.body };

    const params = new URLSearchParams();
    if (path.startsWith('/find/')) params.set('external_source', 'imdb_id');
    if (!bearer) params.set('api_key', key);
    const qs = params.size ? `?${params}` : '';
    let res;
    try {
      res = await fetchImpl(`${base}${path}${qs}`, {
        headers: { Accept: 'application/json', ...(bearer ? { Authorization: `Bearer ${key}` } : {}) },
        signal: AbortSignal.timeout(8000),
      });
    } catch { return { status: 502, body: { error: 'TMDB did not answer' } }; }
    if (!res.ok) return { status: res.status === 404 ? 404 : 502, body: { error: `TMDB answered ${res.status}` } };
    const body = await res.json();
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(path, { at: now(), body });
    return { status: 200, body };
  };
}
