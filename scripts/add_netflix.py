#!/usr/bin/env python3
"""
Add Netflix availability per country to imdb.sqlite, from TMDB watch-provider data (source: JustWatch).

For each region: TMDB /discover (movie + tv) filtered to the Netflix provider(s) with flatrate/ads
monetization → TMDB ids → IMDb ids via /external_ids (cached across runs) → table:
  netflix(region TEXT, id INTEGER, PRIMARY KEY(region, id))   id = numeric part of tconst
meta: netflix_regions = "CH,…", netflix_<REGION>_count, netflix_built_at

Needs TMDB_API_KEY (v3 key or v4 read token). Without it the step logs and exits 0 (app hides Netflix UI).
Attribution required wherever shown: "Streaming data: JustWatch (via TMDB)".

Usage: TMDB_API_KEY=… python add_netflix.py imdb.sqlite --regions CH [--map-cache .tmdb_imdb_map.json]
"""
import argparse, json, os, sqlite3, sys, time, urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

API = "https://api.themoviedb.org/3"
MAX_PAGES = 500        # TMDB discover stops at page 500
WORKERS = 8
SAMPLE = 15            # unmatched titles named in the log, most popular first


def log(msg): print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


class Tmdb:
    def __init__(self, key):
        self.key = key.strip()
        self.bearer = len(self.key) > 40

    def get(self, path, **params):
        if not self.bearer:
            params["api_key"] = self.key
        url = f"{API}{path}?{urllib.parse.urlencode(params)}"
        headers = {"Accept": "application/json"}
        if self.bearer:
            headers["Authorization"] = f"Bearer {self.key}"
        for attempt in range(6):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as r:
                    return json.load(r)
            except urllib.error.HTTPError as e:
                if e.code == 429 or e.code >= 500:
                    time.sleep(float(e.headers.get("Retry-After", 1 + attempt)))
                    continue
                if e.code == 404:
                    return None
                raise
            except (urllib.error.URLError, TimeoutError):
                time.sleep(1 + attempt)
        raise RuntimeError(f"TMDB request kept failing: {path}")


def netflix_provider_ids(tmdb, media, region):
    j = tmdb.get(f"/watch/providers/{media}", watch_region=region)
    return [p["provider_id"] for p in j.get("results", []) if p["provider_name"].lower().startswith("netflix")]


def discover_titles(tmdb, media, region, providers):
    """{tmdb id: title}, most popular first."""
    params = dict(watch_region=region, with_watch_providers="|".join(map(str, providers)),
                  with_watch_monetization_types="flatrate|ads", sort_by="popularity.desc", page=1)
    first = tmdb.get(f"/discover/{media}", **params)
    pages = min(first.get("total_pages", 1), MAX_PAGES)
    titles = {}
    def add(j):
        for r in (j or {}).get("results", []):
            titles.setdefault(r["id"], r.get("title") or r.get("name") or "?")
    add(first)
    with ThreadPoolExecutor(WORKERS) as ex:
        for j in ex.map(lambda p: tmdb.get(f"/discover/{media}", **{**params, "page": p}), range(2, pages + 1)):
            add(j)
    if first.get("total_pages", 1) > MAX_PAGES:
        log(f"  ⚠ {media}/{region}: {first['total_pages']} pages, only the first {MAX_PAGES} are reachable")
    return titles


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("db")
    ap.add_argument("--regions", default="CH")
    ap.add_argument("--map-cache", default=".tmdb_imdb_map.json")
    args = ap.parse_args()
    key = os.environ.get("TMDB_API_KEY", "")
    if not key:
        log("TMDB_API_KEY not set: skipping Netflix availability (app hides the Netflix UI)")
        return 0
    t0 = time.time()
    tmdb = Tmdb(key)
    regions = [r.strip().upper() for r in args.regions.split(",") if r.strip()]

    cache = {}
    if os.path.exists(args.map_cache):
        with open(args.map_cache) as f:
            cache = json.load(f)
    log(f"{len(cache):,} cached TMDB→IMDb mappings")

    con = sqlite3.connect(args.db)
    known = {r[0] for r in con.execute("SELECT CAST(substr(tconst, 3) AS INTEGER) FROM titles")}
    con.execute("DROP TABLE IF EXISTS netflix")
    con.execute("CREATE TABLE netflix (region TEXT NOT NULL, id INTEGER NOT NULL, PRIMARY KEY (region, id)) WITHOUT ROWID")

    for region in regions:
        found = set()
        for media in ("movie", "tv"):
            providers = netflix_provider_ids(tmdb, media, region)
            if not providers:
                log(f"  {region}/{media}: no Netflix provider listed"); continue
            ids = discover_titles(tmdb, media, region, providers)
            missing = [i for i in ids if f"{media}:{i}" not in cache]
            log(f"  {region}/{media}: {len(ids):,} on Netflix (providers {providers}), {len(missing):,} new id lookups")
            def lookup(i):
                j = tmdb.get(f"/{media}/{i}/external_ids") or {}
                return i, j.get("imdb_id") or ""
            with ThreadPoolExecutor(WORKERS) as ex:
                for i, imdb in ex.map(lookup, missing):
                    cache[f"{media}:{i}"] = imdb
            no_imdb, not_local, matched = [], [], 0
            for i, name in ids.items():
                imdb = cache.get(f"{media}:{i}", "")
                if not imdb.startswith("tt"):
                    no_imdb.append(name)
                elif int(imdb[2:]) in known:
                    found.add(int(imdb[2:])); matched += 1
                else:
                    not_local.append(f"{name} ({imdb})")
            log(f"  {region}/{media}: {matched:,} matched, {len(no_imdb):,} without IMDb id, {len(not_local):,} not in the local DB")
            log(f"    most popular without IMDb id: {'; '.join(no_imdb[:SAMPLE]) or '-'}")
            log(f"    most popular not in the local DB: {'; '.join(not_local[:SAMPLE]) or '-'}")
        con.executemany("INSERT OR IGNORE INTO netflix VALUES (?, ?)", [(region, i) for i in sorted(found)])
        con.execute("INSERT OR REPLACE INTO meta VALUES (?, ?)", (f"netflix_{region}_count", str(len(found))))
        log(f"  {region}: {len(found):,} Netflix titles matched to the local DB")

    con.execute("INSERT OR REPLACE INTO meta VALUES ('netflix_regions', ?)", (",".join(regions),))
    con.execute("INSERT OR REPLACE INTO meta VALUES ('netflix_built_at', datetime('now'))")
    con.commit(); con.execute("VACUUM"); con.close()
    with open(args.map_cache, "w") as f:
        json.dump(cache, f)
    log(f"done in {time.time() - t0:.0f}s, {os.path.getsize(args.db) / 1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
