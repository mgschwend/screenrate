#!/usr/bin/env python3
"""
Add each title's original language to imdb.sqlite, from TMDB /find (ISO 639-1, e.g. "fr").

  titles.lang TEXT    NULL = unknown
  meta: lang_count

The first run looks up every title. That can outlast one build, so lookups stop at --max-seconds and the
next build carries on from the cache. Found languages never expire; titles TMDB doesn't know are retried
after RETRY_DAYS.

data/languages.json in the repo seeds the cache, so a first run done elsewhere doesn't have to be repeated.

Usage: TMDB_API_KEY=… python add_languages.py imdb.sqlite [--cache .tmdb_lang_cache.json] [--seed data/languages.json] [--max-seconds 3000]
Without a key the step logs and exits 0 (the app hides the language filter).
"""
import argparse, json, os, sqlite3, sys, time
from concurrent.futures import ThreadPoolExecutor, as_completed

from add_netflix import Tmdb, log

WORKERS = 16        # TMDB allows about 40 requests per second
RETRY_DAYS = 30
SAVE_EVERY = 5000


def language(tmdb, tconst):
    j = tmdb.get(f"/find/{tconst}", external_source="imdb_id") or {}
    hit = (j.get("movie_results") or j.get("tv_results") or [{}])[0]
    return hit.get("original_language") or ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("db")
    ap.add_argument("--cache", default=".tmdb_lang_cache.json")
    ap.add_argument("--seed", default="")
    ap.add_argument("--max-seconds", type=int, default=3000)
    args = ap.parse_args()
    key = os.environ.get("TMDB_API_KEY", "")
    if not key:
        log("TMDB_API_KEY not set: skipping original languages (app hides the language filter)")
        return 0
    t0 = time.time()
    tmdb = Tmdb(key)
    cache = {}  # tconst → language, or {"miss": unix time} when TMDB had none
    if os.path.exists(args.cache):
        with open(args.cache) as f:
            cache = json.load(f)
    if args.seed and os.path.exists(args.seed):
        with open(args.seed) as f:
            cache = {**json.load(f), **cache}

    def save():
        with open(args.cache + ".tmp", "w") as f:
            json.dump(cache, f)
        os.replace(args.cache + ".tmp", args.cache)

    con = sqlite3.connect(args.db)
    titles = [r[0] for r in con.execute("SELECT tconst FROM titles ORDER BY votes DESC")]
    retry_before = time.time() - RETRY_DAYS * 86400
    todo = [t for t in titles if t not in cache or (isinstance(cache[t], dict) and cache[t]["miss"] < retry_before)]
    log(f"{len(titles):,} titles, {len(cache):,} cached, {len(todo):,} to look up (most voted first)")

    done, missed, failed = 0, 0, 0
    with ThreadPoolExecutor(WORKERS) as ex:
        for start in range(0, len(todo), SAVE_EVERY):
            if time.time() - t0 > args.max_seconds:
                log(f"  ⚠ stopped at the {args.max_seconds}s limit, next build continues")
                break
            batch = todo[start:start + SAVE_EVERY]
            futures = {ex.submit(language, tmdb, t): t for t in batch}
            for fut in as_completed(futures):
                t = futures[fut]
                try:
                    lang = fut.result()
                except Exception:  # one bad answer shouldn't end the build; it's retried next time
                    failed += 1
                    continue
                cache[t] = lang if lang else {"miss": int(time.time())}
                missed += 0 if lang else 1
                done += 1
            save()
            log(f"  {done:,} looked up, {missed:,} unknown to TMDB, {failed:,} failed, {time.time() - t0:.0f}s")

    cols = [r[1] for r in con.execute("PRAGMA table_info(titles)")]
    if "lang" not in cols:
        con.execute("ALTER TABLE titles ADD COLUMN lang TEXT")
    con.executemany("UPDATE titles SET lang = ? WHERE tconst = ?",
                    [(cache[t], t) for t in titles if isinstance(cache.get(t), str)])
    n = con.execute("SELECT COUNT(*) FROM titles WHERE lang IS NOT NULL").fetchone()[0]
    con.execute("INSERT OR REPLACE INTO meta VALUES ('lang_count', ?)", (str(n),))
    con.commit()
    top = con.execute("SELECT lang, COUNT(*) FROM titles WHERE lang IS NOT NULL GROUP BY lang ORDER BY 2 DESC LIMIT 8").fetchall()
    con.execute("VACUUM"); con.close()
    save()
    log(f"done in {time.time() - t0:.0f}s: {n:,} of {len(titles):,} titles have a language; top {top}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
