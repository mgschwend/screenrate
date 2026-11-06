// Calls to our own server. A 401 means the session is gone; a thrown TypeError means no connection.
export class LoginRequired extends Error {
  code = 'NO_SESSION';
}

async function call(path, { method = 'GET', json, body, headers } = {}) {
  const res = await fetch(new URL(path, document.baseURI), {
    method,
    headers: { ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: json !== undefined ? JSON.stringify(json) : body,
  });
  if (res.status === 401 && path !== 'api/login') throw new LoginRequired('Login required');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

export const api = {
  login: (username, password) => call('api/login', { method: 'POST', json: { username, password } }),
  logout: () => call('api/logout', { method: 'POST' }),
  me: () => call('api/me'),
  version: () => call('data/version'),
  ratings: () => call('api/ratings'),
  sharedRatings: () => call('api/ratings/shared'),
  setRating: (tconst, rating) => call(`api/ratings/${tconst}`, { method: 'PUT', json: { rating } }),
  deleteRating: (tconst) => call(`api/ratings/${tconst}`, { method: 'DELETE' }),
  importRatings: (csv) => call('api/ratings/import', { method: 'POST', body: csv, headers: { 'Content-Type': 'text/csv' } }),
  watchlist: () => call('api/watchlist'),
  addWatch: (tconst) => call(`api/watchlist/${tconst}`, { method: 'PUT' }),
  removeWatch: (tconst) => call(`api/watchlist/${tconst}`, { method: 'DELETE' }),
  importWatchlist: (rows) => call('api/watchlist/import', { method: 'POST', json: rows }),
  settings: () => call('api/settings'),
  saveSettings: (value) => call('api/settings', { method: 'PUT', json: value }),
};
