// "For you": titles similar to what you liked, minus what resembles what you disliked. On-device.

const LIKED = 8, DISLIKED = 5;
const weight = (rating) => (rating >= LIKED ? rating - 6.5 : rating <= DISLIKED ? rating - 6 : 0);

/**
 * @param rated     {tconst: rating}
 * @param similarOf tconst → similar tconsts, best first
 * @returns Map tconst → {score, seed} seed = the liked title that contributed most
 */
export function tasteScores(rated, similarOf) {
  const out = new Map();
  for (const [seed, rating] of Object.entries(rated)) {
    const w = weight(rating);
    if (!w) continue;
    similarOf(seed).forEach((id, rank) => {
      const add = w / (1 + rank * 0.15);
      const e = out.get(id) ?? { score: 0, seed: null, best: 0 };
      e.score += add;
      if (add > e.best) { e.best = add; e.seed = seed; }
      out.set(id, e);
    });
  }
  return out;
}

/**
 * Ranked suggestions for one or more people. With several, a title needs a positive score from
 * each of them who liked anything, so it suits everyone, and nobody has rated it yet.
 * @param people [{rated, name}]
 * @returns [{tconst, score, seed, name}]
 */
export function suggest(people, similarOf) {
  const seen = new Set(people.flatMap((p) => Object.keys(p.rated)));
  const taste = people.map((p) => ({ ...p, scores: tasteScores(p.rated, similarOf) }));
  const active = taste.filter((p) => [...p.scores.values()].some((e) => e.score > 0));
  const out = [];
  for (const id of new Set(active.flatMap((p) => [...p.scores.keys()]))) {
    if (seen.has(id)) continue;
    const parts = active.map((p) => ({ name: p.name, e: p.scores.get(id) }));
    const total = parts.reduce((sum, { e }) => sum + (e?.score ?? 0), 0);
    if (total <= 0 || parts.some(({ e }) => (e?.score ?? 0) < 0)) continue;
    const top = parts.filter(({ e }) => e).sort((a, b) => b.e.score - a.e.score)[0];
    out.push({ tconst: id, score: total, seed: top.e.seed, name: top.name, shared: parts.every(({ e }) => e?.score > 0) });
  }
  return out.sort((a, b) => Number(b.shared) - Number(a.shared) || b.score - a.score);
}

/** Add IMDb's opinion once titles are known, so a strong match isn't a weak film. */
export const finalScore = (s, imdbRating) => s.score + 0.5 * ((imdbRating ?? 6) - 7);
