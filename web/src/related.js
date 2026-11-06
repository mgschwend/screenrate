// "More like this": TMDB recommendations and local similar titles as one list.
export const MIN_RATING = 6.5;
const FANS = 'Fans also liked';

/** Titles rated below this are not suggested for `rating`. */
export const ratingFloor = (rating) => Math.min(MIN_RATING, (rating ?? MIN_RATING) - 0.5);

/**
 * Titles in both lists come first (two independent signals), then the two lists take turns.
 * Reasons come from the local list, which knows who the titles share.
 */
export function mergeRelated(recs, similar, rating) {
  const local = new Map(similar.map((t) => [t.tconst, t]));
  const inRecs = new Set(recs.map((t) => t.tconst));
  const both = recs.filter((t) => local.has(t.tconst)).map((t) => local.get(t.tconst));
  const a = recs.filter((t) => !local.has(t.tconst)).map((t) => ({ ...t, why: FANS }));
  const b = similar.filter((t) => !inRecs.has(t.tconst));
  const turns = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) turns.push(a[i], b[i]);
  const floor = ratingFloor(rating);
  return [...both, ...turns].filter((t) => t && (t.rating ?? 0) >= floor);
}
