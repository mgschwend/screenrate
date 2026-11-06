// Taste profile: what someone rates above their own average, weighted by how often they've rated it.
const MIN_TITLES = 5;   // below this, a profile says nothing
const MIN_PER_ITEM = 2; // one film doesn't make a favourite
const SHOWN = 5;

function top(buckets, overall) {
  return [...buckets.entries()]
    .filter(([, s]) => s.n >= MIN_PER_ITEM)
    .map(([name, s]) => ({ name, score: (s.sum / s.n - overall + 0.25) * Math.sqrt(s.n) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, SHOWN)
    .map((x) => x.name);
}

/**
 * @param rows [{rating, year, genres: [name], people: [{role, name}]}]
 * @returns {{genres, directors, actors, decades}} lists of names, best first; empty until enough is rated
 */
export function buildTaste(rows) {
  const out = { genres: [], directors: [], actors: [], decades: [] };
  if (rows.length < MIN_TITLES) return out;
  const overall = rows.reduce((sum, r) => sum + r.rating, 0) / rows.length;
  const buckets = { genres: new Map(), directors: new Map(), actors: new Map(), decades: new Map() };
  const add = (map, name, rating) => {
    const s = map.get(name) ?? { n: 0, sum: 0 };
    s.n += 1; s.sum += rating;
    map.set(name, s);
  };
  for (const r of rows) {
    for (const g of r.genres) add(buckets.genres, g, r.rating);
    for (const p of r.people) {
      if (p.role === 'd') add(buckets.directors, p.name, r.rating);
      if (p.role === 'a') add(buckets.actors, p.name, r.rating);
    }
    if (r.year) add(buckets.decades, `${Math.floor(r.year / 10) * 10}s`, r.rating);
  }
  for (const key of Object.keys(out)) out[key] = top(buckets[key], overall);
  return out;
}
