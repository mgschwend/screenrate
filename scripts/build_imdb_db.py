#!/usr/bin/env python3
"""
Build a compact imdb.sqlite for the TV-screen movie scanner app.
Usage:  pip install pandas
        python build_imdb_db.py [--min-votes 1000] [--out imdb.sqlite] [--akas]
Data: https://datasets.imdbws.com/  (personal / non-commercial use only)
"""
import argparse, os, re, sqlite3, sys, time, unicodedata, urllib.request
import pandas as pd

BASE = "https://datasets.imdbws.com/"
FILES = {"basics": "title.basics.tsv.gz", "ratings": "title.ratings.tsv.gz", "akas": "title.akas.tsv.gz"}
KEEP_TYPES = {"movie", "tvSeries", "tvMiniSeries"}
AKA_REGIONS = {"DE", "CH", "AT"}

def log(msg): print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)

def download(name, cache_dir):
    os.makedirs(cache_dir, exist_ok=True)
    path = os.path.join(cache_dir, FILES[name])
    if os.path.exists(path):
        log(f"using cached {path}"); return path
    log(f"downloading {FILES[name]} …")
    urllib.request.urlretrieve(BASE + FILES[name], path)
    return path

def normalize(title: str) -> str:
    """Must be mirrored 1:1 in the app (web/normalize.js)."""
    if not isinstance(title, str): return ""
    t = unicodedata.normalize("NFKD", title)
    t = "".join(c for c in t if not unicodedata.combining(c))
    t = t.lower().replace("&", " and ")
    t = re.sub(r"[^a-z0-9]+", " ", t)
    return t.strip()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-votes", type=int, default=1000)
    ap.add_argument("--out", default="imdb.sqlite")
    ap.add_argument("--cache", default=".imdb_cache")
    ap.add_argument("--akas", action="store_true", help="also import DE/CH/AT titles")
    args = ap.parse_args()
    t0 = time.time()

    r_path = download("ratings", args.cache)
    log("reading ratings …")
    ratings = pd.read_csv(r_path, sep="\t", na_values="\\N",
                          dtype={"tconst": str, "averageRating": float, "numVotes": "Int64"})
    ratings = ratings[ratings.numVotes >= args.min_votes]
    log(f"  {len(ratings):,} titles with >= {args.min_votes} votes")

    b_path = download("basics", args.cache)
    log("reading basics (slow) …")
    usecols = ["tconst", "titleType", "primaryTitle", "originalTitle", "startYear"]
    chunks = []
    for chunk in pd.read_csv(b_path, sep="\t", na_values="\\N", usecols=usecols,
                             dtype=str, chunksize=1_000_000, quoting=3):
        chunk = chunk[chunk.titleType.isin(KEEP_TYPES)]
        chunk = chunk[chunk.tconst.isin(ratings.tconst)]
        chunks.append(chunk)
    basics = pd.concat(chunks, ignore_index=True); del chunks
    log(f"  {len(basics):,} movies/series after filtering")

    df = basics.merge(ratings, on="tconst", how="inner")
    df["startYear"] = pd.to_numeric(df.startYear, errors="coerce").astype("Int64")
    df["normTitle"] = df.primaryTitle.map(normalize)
    df["normOriginal"] = df.originalTitle.map(normalize)
    df = df.rename(columns={"titleType": "type", "primaryTitle": "title", "startYear": "year",
                            "averageRating": "rating", "numVotes": "votes"})
    df = df[["tconst", "type", "title", "originalTitle", "year", "rating", "votes", "normTitle", "normOriginal"]]

    akas = None
    if args.akas:
        a_path = download("akas", args.cache)
        log("reading akas (big, filtering to DE/CH/AT) …")
        keep = set(df.tconst); parts = []
        for chunk in pd.read_csv(a_path, sep="\t", na_values="\\N", usecols=["titleId", "title", "region"],
                                 dtype=str, chunksize=2_000_000, quoting=3):
            parts.append(chunk[chunk.region.isin(AKA_REGIONS) & chunk.titleId.isin(keep)])
        akas = pd.concat(parts, ignore_index=True).rename(columns={"titleId": "tconst"})
        akas["normTitle"] = akas.title.map(normalize)
        akas = akas.drop_duplicates(["tconst", "normTitle"])
        akas = akas[akas.normTitle != ""]
        log(f"  {len(akas):,} German-region aliases")

    if os.path.exists(args.out): os.remove(args.out)
    log(f"writing {args.out} …")
    con = sqlite3.connect(args.out)
    con.executescript("""
        CREATE TABLE titles (tconst TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL,
            originalTitle TEXT, year INTEGER, rating REAL NOT NULL, votes INTEGER NOT NULL,
            normTitle TEXT NOT NULL, normOriginal TEXT);
        CREATE TABLE akas (tconst TEXT NOT NULL REFERENCES titles(tconst), title TEXT NOT NULL,
            region TEXT, normTitle TEXT NOT NULL);
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    """)
    df.to_sql("titles", con, if_exists="append", index=False)
    if akas is not None:
        akas[["tconst", "title", "region", "normTitle"]].to_sql("akas", con, if_exists="append", index=False)
    con.executescript("""
        CREATE INDEX idx_titles_norm ON titles(normTitle);
        CREATE INDEX idx_titles_normorig ON titles(normOriginal);
        CREATE INDEX idx_titles_votes ON titles(votes DESC);
        CREATE INDEX idx_akas_norm ON akas(normTitle);
        CREATE VIRTUAL TABLE titles_fts USING fts5(normTitle, normOriginal, tconst UNINDEXED, tokenize='unicode61');
        INSERT INTO titles_fts(normTitle, normOriginal, tconst) SELECT normTitle, normOriginal, tconst FROM titles;
    """)
    con.execute("INSERT INTO meta VALUES ('built_at', datetime('now'))")
    con.execute("INSERT INTO meta VALUES ('min_votes', ?)", (str(args.min_votes),))
    con.execute("INSERT INTO meta VALUES ('title_count', ?)", (str(len(df)),))
    con.commit(); con.execute("VACUUM"); con.close()
    log(f"done: {len(df):,} titles, {os.path.getsize(args.out)/1e6:.1f} MB, {time.time()-t0:.0f}s")

    con = sqlite3.connect(args.out)
    for q in ("heat", "dune", "the godfather", "the batman"):
        print(f"  {q!r:16} ->", con.execute(
            "SELECT title, year, rating, votes FROM titles WHERE normTitle=? ORDER BY votes DESC LIMIT 3", (q,)).fetchall())
    con.close()

if __name__ == "__main__":
    sys.exit(main())
