// Search-as-you-type over the local IMDb DB.
import { normalize } from './normalize.js';
import { dice } from './match.js';

export const MIN_CHARS = 2;

/**
 * Ranked results for a typed query:
 *   0) exact title / original / DE-CH-AT alias
 *   1) title (or alias) starts with the query
 *   2) every word matches as a prefix ("dun par" → Dune: Part Two)
 *   3) typo fallback (loose prefix + Dice ≥ 0.6) only when nothing else matched
 * Within a group: most IMDb votes first.
 * @returns [{tconst, title, year, type, rating, votes, originalTitle, akaTitle?}] — akaTitle only when it differs
 */
export function searchTitles(tdb, query, limit = 30) {
  const norm = normalize(query);
  if (norm.replace(/ /g, '').length < MIN_CHARS) return [];

  const best = new Map(); // tconst → row with lowest group
  const add = (rows, groupOf) => {
    for (const r of rows) {
      const g = groupOf(r);
      const prev = best.get(r.tconst);
      if (!prev || g < prev.group) best.set(r.tconst, { ...r, group: g, akaTitle: r.akaTitle ?? prev?.akaTitle });
      else if (!prev.akaTitle && r.akaTitle) prev.akaTitle = r.akaTitle;
    }
  };
  const starts = (r) => r.normTitle.startsWith(norm) || (r.normOriginal || '').startsWith(norm);

  add(tdb.exact(norm), () => 0);
  add(tdb.akaPrefix(norm, 40), (r) => (normalize(r.akaTitle) === norm ? 0 : 1));
  add(tdb.prefix(norm, 80), (r) => (r.normTitle === norm || r.normOriginal === norm ? 0 : starts(r) ? 1 : 2));
  add(tdb.akaContains(norm, 30), () => 2);

  if (!best.size && norm.replace(/ /g, '').length >= 4) {
    // typos: widen word prefixes ("brakin bad" → "brak* bad*", then "br* ba*"), keep only similar titles
    for (const loose of ['ratio', 'short']) {
      add(tdb.prefix(norm, 300, { loose })
        .map((r) => ({ ...r, score: Math.max(dice(norm, r.normTitle), r.normOriginal ? dice(norm, r.normOriginal) : 0) }))
        .filter((r) => r.score >= 0.6), () => 3);
      if (best.size) break;
    }
  }

  return [...best.values()]
    .sort((a, b) => a.group - b.group || b.votes - a.votes)
    .slice(0, limit)
    .map((r) => (r.akaTitle && normalize(r.akaTitle) === r.normTitle ? { ...r, akaTitle: undefined } : r));
}
