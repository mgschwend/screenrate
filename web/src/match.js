// Title matching, stop-list, on-screen context and frame voting. Pure logic (no DOM).
import { normalize } from './normalize.js';

export const DICE_MIN = 0.75;
export const CLEAR_WINNER_RATIO = 5;
const SERIES_TYPES = new Set(['tvSeries', 'tvMiniSeries']);

// UI chrome of streaming apps (EN/DE). Compared after normalize().
const STOP_PHRASES = [
  'continue watching', 'weiterschauen', 'weiter ansehen', 'top 10', 'top ten', 'my list', 'meine liste',
  'play', 'abspielen', 'wiedergeben', 'new episodes', 'neue folgen', 'neue folge', 'new episode',
  'netflix', 'disney', 'disney plus', 'disney+', 'prime video', 'prime', 'apple tv', 'apple tv+', 'hbo', 'hbo max',
  'max', 'sky', 'sky show', 'wow', 'paramount', 'paramount+', 'zattoo', 'srf', 'play suisse', 'youtube',
  'staffel', 'staffeln', 'season', 'seasons', 'series', 'serie', 'serien', 'tv shows', 'tv sendungen', 'shows',
  'film', 'filme', 'films', 'movies', 'movie', 'home', 'start', 'startseite', 'search', 'suche', 'suchen',
  'trending now', 'trending', 'popular', 'beliebt', 'beliebt auf netflix', 'popular on netflix', 'new', 'neu',
  'new on netflix', 'neu auf netflix', 'new and popular', 'neu und beliebt', 'neu und angesagt', 'new hot',
  'more info', 'weitere infos', 'mehr infos', 'mehr erfahren', 'info', 'details', 'trailer', 'trailers',
  'episodes', 'episode', 'folgen', 'folge', 'because you watched', 'weil du', 'recently added',
  'kurzlich hinzugefugt', 'neu hinzugefugt', 'only on netflix', 'nur auf netflix', 'recommended', 'empfohlen',
  'watch again', 'erneut ansehen', 'nochmal ansehen', 'kids', 'kinder', 'profile', 'profil', 'settings',
  'einstellungen', 'resume', 'fortsetzen', 'watch', 'ansehen', 'jetzt ansehen', 'watch now', 'hd', '4k', 'uhd',
  'hdr', 'dolby vision', 'dolby atmos', 'audio', 'untertitel', 'subtitles', 'audio and subtitles',
  'audio und untertitel', 'more like this', 'ahnliche titel', 'ahnliche inhalte', 'cast', 'besetzung', 'genres',
  'genre', 'comedy', 'komodie', 'drama', 'dramen', 'action', 'thriller', 'horror', 'documentary', 'documentaries',
  'dokumentation', 'dokumentationen', 'dokus', 'anime', 'krimi', 'krimis', 'romance', 'romantik', 'sci fi',
  'fantasy', 'family', 'familie', 'reality', 'stand up', 'limited series', 'miniserie', 'original', 'originals',
  'a netflix series', 'eine netflix serie', 'a netflix film', 'ein netflix film', 'n series', 'n film',
  'coming soon', 'demnachst', 'bald verfugbar', 'remind me', 'erinnern', 'my netflix', 'mein netflix',
  'games', 'spiele', 'live', 'live tv', 'browse', 'categories', 'kategorien', 'library', 'bibliothek',
  'watchlist', 'merkliste', 'downloads', 'download', 'rent', 'buy', 'leihen', 'kaufen', 'included with prime',
  'in prime enthalten', 'free', 'gratis', 'ad', 'ads', 'werbung', 'skip intro', 'intro uberspringen',
  'next episode', 'nachste folge', 'back', 'zuruck', 'ok', 'cancel', 'abbrechen', 'yes', 'no', 'ja', 'nein',
  'watched', 'you ve watched', 'trailers you ve watched', 'new season', 'neue staffel', 'new episodes weekly',
  'watch it again', 'nochmals ansehen', 'your next watch', 'today s top picks for you', 'we think you ll love these',
];
const STOP = new Set(STOP_PHRASES.map(normalize));
const STOP_PATTERNS = [
  /^\d+( \d+)*$/,                                        // pure numbers, "16", "2 3"
  /^(s|e|ep|st|staffel|season|folge|episode|teil|part|vol|volume) ?\d+( ?e ?\d+)?$/, // S1, S1 E3, Staffel 2
  /^\d+ ?(h|std|min|m|s)( ?\d+ ?(min|m))?$/,             // 1h 52m, 45 min
  /^\d+ (staffeln|seasons|folgen|episodes|teile|parts)$/, // 3 Staffeln
  /^top \d+/,                                            // Top 10 in Switzerland …
  /^(nr|no|number) \d+/,                                 // Nr. 3 in Filmen heute
  /^\d+ (match|matches|ubereinstimmung)$/,               // 98% Match → "98 match"
];

export const MAX_WORDS = 7;

/** Should this OCR string be ignored before any DB lookup? (`norm` = normalize(raw)). */
export function isStop(norm) {
  if (!norm || norm.replace(/ /g, '').length < 3) return true; // "ed", "Mo": too short for noisy OCR
  if (norm.split(' ').length > MAX_WORDS) return true; // descriptions, synopses
  if (STOP.has(norm)) return true;
  return STOP_PATTERNS.some((re) => re.test(norm));
}

/** Sørensen–Dice coefficient over character bigrams (spaces ignored). */
export function dice(a, b) {
  a = a.replace(/ /g, ''); b = b.replace(/ /g, '');
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) || 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const n = grams.get(g);
    if (n) { hits++; grams.set(g, n - 1); }
  }
  return (2 * hits) / (a.length - 1 + b.length - 1);
}

/** Exact lookup, else FTS prefix match filtered by Dice ≥ DICE_MIN. Sorted by votes DESC. */
export function findCandidates(tdb, norm) {
  const exact = tdb.exact(norm);
  if (exact.length) return { candidates: exact, how: 'exact' };
  const score = (rows, q = norm) => rows
    .map((c) => ({ ...c, score: Math.max(dice(q, c.normTitle), c.normOriginal ? dice(q, c.normOriginal) : 0) }))
    .filter((c) => c.score >= DICE_MIN)
    .sort((x, y) => y.votes - x.votes);
  if (norm.replace(/ /g, '').length < 5) return { candidates: [], how: 'none' }; // fuzzy on 3–4 letters = noise ("w ha" → "Wham!")
  let fuzzy = score(tdb.prefix(norm));
  if (!fuzzy.length && norm.replace(/ /g, '').length >= 5) fuzzy = score(tdb.prefix(norm, 200, { loose: true }));
  if (!fuzzy.length && norm.replace(/ /g, '').length >= 4) {
    // typical OCR glyph confusions; similarity is still scored against what was actually read
    for (const v of ocrVariants(norm)) {
      const exact = tdb.exact(v);
      if (exact.length) { fuzzy = exact; break; }
      fuzzy = score(tdb.prefix(v, 200, { loose: true }), v);
      if (fuzzy.length) break;
    }
  }
  return { candidates: fuzzy, how: fuzzy.length ? 'fuzzy' : 'none' };
}

const OCR_SWAPS = [['l', 'i'], ['1', 'i'], ['i', 'l'], ['1', 'l'], ['rn', 'm'], ['0', 'o'], ['5', 's'], ['q', 'g'],
  ['vv', 'w'], ['o', 'c'], ['c', 'o'], ['e', 'c'], ['c', 'e'], ['u', 'v'], ['v', 'u']];
const MAX_VARIANTS = 40;
/** Single-substitution variants (one confusable glyph fixed at a time), most common confusions first. */
export function ocrVariants(norm) {
  const out = new Set();
  for (const [from, to] of OCR_SWAPS) {
    for (let i = norm.indexOf(from); i !== -1 && out.size < MAX_VARIANTS; i = norm.indexOf(from, i + 1)) {
      out.add(norm.slice(0, i) + to + norm.slice(i + from.length));
    }
  }
  return [...out];
}

/**
 * Resolve an OCR'd title to a decision.
 * @param context {year?: number, series?: boolean} from text near the title on screen
 * @param remembered {Record<norm, tconst>} user choices, applied before any ranking
 * @returns null (no candidates) | {norm, candidates, winner|null, ambiguous, alternatives, how}
 */
export function resolve(tdb, raw, { context = {}, remembered = {} } = {}) {
  const norm = normalize(raw);
  if (isStop(norm)) return null;
  let { candidates, how } = findCandidates(tdb, norm);

  const chosen = remembered[norm] && (candidates.find((c) => c.tconst === remembered[norm]) || tdb.get(remembered[norm]));
  if (chosen) {
    if (!candidates.some((c) => c.tconst === chosen.tconst)) candidates = [chosen, ...candidates];
    return { norm, candidates, winner: chosen, ambiguous: false, alternatives: candidates.length - 1, how: 'remembered' };
  }
  if (!candidates.length) return null;

  let pool = candidates;
  if (context.series !== undefined) {
    const f = pool.filter((c) => SERIES_TYPES.has(c.type) === context.series);
    if (f.length) pool = f;
  }
  if (context.year) {
    const f = pool.filter((c) => c.year === context.year);
    if (f.length) pool = f;
  }

  const [top, second] = pool;
  const clear = !second || top.votes >= CLEAR_WINNER_RATIO * second.votes;
  return {
    norm, candidates, how,
    winner: clear ? top : null,
    ambiguous: !clear,
    alternatives: candidates.length - 1,
  };
}

const YEAR_RE = /\b(19[2-9]\d|20[0-4]\d)\b/;
const SERIES_RE = /\b(staffel|staffeln|season|seasons|folge|folgen|episode|episodes|serie|series|miniserie|limited series)\b/;

/** Year / series hints from OCR lines located near `item.box` (below or beside the title). */
export function contextFor(item, items) {
  const b = item.box, h = Math.max(b.height, 8);
  const ctx = {};
  for (const o of items) {
    if (o === item) continue;
    const ob = o.box;
    const cx = ob.x + ob.width / 2, cy = ob.y + ob.height / 2;
    const near = cx >= b.x - b.width * 0.5 && cx <= b.x + b.width * 1.8
      && cy >= b.y - 2 * h && cy <= b.y + b.height + 5 * h;
    if (!near) continue;
    const y = o.text.match(YEAR_RE);
    if (y && !ctx.year) ctx.year = Number(y[1]);
    if (SERIES_RE.test(normalize(o.text))) ctx.series = true;
  }
  return ctx;
}

/**
 * Merge OCR boxes that sit on the same row and touch horizontally into one phrase.
 * Returns phrases with `parts` (the source items); single boxes are phrases too.
 */
export function phrases(items) {
  const sorted = [...items].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const rows = [];
  for (const it of sorted) {
    const cy = it.box.y + it.box.height / 2;
    const row = rows.find((r) => Math.abs(r.cy - cy) < Math.max(r.h, it.box.height) * 0.5);
    if (row) row.items.push(it); else rows.push({ cy, h: it.box.height, items: [it] });
  }
  const out = [];
  for (const r of rows) {
    r.items.sort((a, b) => a.box.x - b.box.x);
    let cur = null;
    for (const it of r.items) {
      const gap = cur ? it.box.x - (cur.box.x + cur.box.width) : Infinity;
      if (cur && gap < Math.max(cur.box.height, it.box.height) * 1.2) {
        const x2 = Math.max(cur.box.x + cur.box.width, it.box.x + it.box.width);
        const y1 = Math.min(cur.box.y, it.box.y);
        const y2 = Math.max(cur.box.y + cur.box.height, it.box.y + it.box.height);
        cur = { text: `${cur.text} ${it.text}`, box: { x: cur.box.x, y: y1, width: x2 - cur.box.x, height: y2 - y1 },
                confidence: Math.min(cur.confidence, it.confidence), parts: [...cur.parts, it] };
      } else {
        if (cur) out.push(cur);
        cur = { ...it, parts: [it] };
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

/** A title must be seen in ≥ minFrames distinct frames (within `window` frames) before it is shown. */
export class Voter {
  constructor(minFrames = 2, window = 8) { this.min = minFrames; this.window = window; this.seen = new Map(); }
  observe(frameNo, keys) {
    for (const k of new Set(keys)) {
      const s = this.seen.get(k);
      if (s && s.last !== frameNo) { s.count++; s.last = frameNo; }
      else if (!s) this.seen.set(k, { count: 1, last: frameNo });
    }
    for (const [k, s] of this.seen) if (frameNo - s.last > this.window) this.seen.delete(k);
  }
  confirmed(k) { return (this.seen.get(k)?.count || 0) >= this.min; }
  reset() { this.seen.clear(); }
}

export const SERIES = SERIES_TYPES;
