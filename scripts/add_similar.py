#!/usr/bin/env python3
"""
Add genres and precomputed "similar titles" to an imdb.sqlite built by build_imdb_db.py.

Similarity = shared people (director 3, writer 2, lead actors 1.5 / supporting 1) + genre overlap
(Jaccard × 2) + same type (film/series) 0.5 + a small popularity prior + rating. Titles rated below
min(MIN_RATING, the title's own rating - 0.5) are dropped, so a good film only suggests good films.
Top SIMILAR_K per title.

Tables added:
  titles.genres  TEXT        e.g. "Action,Adventure,Drama"
  similar(id INTEGER PRIMARY KEY, others TEXT, why TEXT)
      id = numeric part of tconst (tt0113277 → 113277); others = comma-separated ids, best first;
      why = aligned with others: strongest shared person as role + people.id, e.g. "d12,a7" (d/w/a).
  people(id INTEGER PRIMARY KEY, name TEXT)
  title_people(id INTEGER PRIMARY KEY, people TEXT)
      who made a title: role + people.id, comma-separated, e.g. "d12,w3,a7". Directors, writers, two lead actors.

Usage:  pip install pandas numpy
        python add_similar.py imdb.sqlite [--cache .imdb_cache]
Data: https://datasets.imdbws.com/  (personal / non-commercial use only)
"""
import argparse, os, sqlite3, sys, time, urllib.request
import numpy as np
import pandas as pd

BASE = "https://datasets.imdbws.com/"
FILES = {"basics": "title.basics.tsv.gz", "principals": "title.principals.tsv.gz", "names": "name.basics.tsv.gz"}
SIMILAR_K = 12
MIN_RATING = 6.5
RATING_WEIGHT = 0.4
MAX_TITLES_PER_PERSON = 60          # cap prolific people (keeps pair count bounded)
CATEGORY_WEIGHT = {"director": 3.0, "writer": 2.0}
LEAD_ACTOR_WEIGHT, ACTOR_WEIGHT, MAX_ACTOR_ORDERING = 1.5, 1.0, 5
MAX_CREDITS_PER_TITLE = 6


def log(msg): print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def download(name, cache_dir):
    os.makedirs(cache_dir, exist_ok=True)
    path = os.path.join(cache_dir, FILES[name])
    if os.path.exists(path):
        log(f"using cached {path}"); return path
    log(f"downloading {FILES[name]} …")
    urllib.request.urlretrieve(BASE + FILES[name], path)
    return path


def tid(tconst: pd.Series) -> pd.Series:
    return tconst.str.slice(2).astype(np.int64)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("db")
    ap.add_argument("--cache", default=".imdb_cache")
    args = ap.parse_args()
    t0 = time.time()

    con = sqlite3.connect(args.db)
    titles = pd.read_sql("SELECT tconst, type, votes, rating FROM titles", con)
    titles["id"] = tid(titles.tconst)
    keep = set(titles.tconst)
    log(f"{len(titles):,} titles in {args.db}")

    # ---- genres ----
    b_path = download("basics", args.cache)
    log("reading genres …")
    parts = []
    for chunk in pd.read_csv(b_path, sep="\t", na_values="\\N", usecols=["tconst", "genres"],
                             dtype=str, chunksize=1_000_000, quoting=3):
        parts.append(chunk[chunk.tconst.isin(keep)])
    genres = pd.concat(parts, ignore_index=True).fillna({"genres": ""})
    cols = [r[1] for r in con.execute("PRAGMA table_info(titles)")]
    if "genres" not in cols:
        con.execute("ALTER TABLE titles ADD COLUMN genres TEXT")
    con.executemany("UPDATE titles SET genres = ? WHERE tconst = ?", genres[["genres", "tconst"]].itertuples(index=False))
    con.commit()
    titles = titles.merge(genres, on="tconst", how="left").fillna({"genres": ""})
    all_genres = sorted({g for s in titles.genres for g in s.split(",") if g})
    gbit = {g: 1 << i for i, g in enumerate(all_genres)}
    titles["gmask"] = [sum(gbit[g] for g in s.split(",") if g) for s in titles.genres]
    log(f"  genres for {len(genres):,} titles ({len(all_genres)} distinct)")

    # ---- principals → weighted person/title links ----
    p_path = download("principals", args.cache)
    log("reading principals (big) …")
    parts = []
    for chunk in pd.read_csv(p_path, sep="\t", na_values="\\N", usecols=["tconst", "ordering", "nconst", "category"],
                             dtype=str, chunksize=2_000_000, quoting=3):
        chunk = chunk[chunk.tconst.isin(keep) & chunk.category.isin({"director", "writer", "actor", "actress"})]
        parts.append(chunk)
    p = pd.concat(parts, ignore_index=True)
    p["ordering"] = pd.to_numeric(p.ordering, errors="coerce").fillna(99).astype(int)
    actor = p.category.isin({"actor", "actress"})
    p = p[~actor | (p.ordering <= MAX_ACTOR_ORDERING)].copy()
    p["w"] = p.category.map(CATEGORY_WEIGHT).fillna(0.0)
    p.loc[actor & (p.ordering <= 2), "w"] = LEAD_ACTOR_WEIGHT
    p.loc[actor & (p.ordering > 2), "w"] = ACTOR_WEIGHT
    p = p.groupby(["tconst", "nconst"], as_index=False).w.max()   # one link per person/title (strongest role)
    p["id"] = tid(p.tconst)
    # Credits for the taste profile: taken before the per-person cap, which would hide prolific people.
    credits = p[p.w >= LEAD_ACTOR_WEIGHT].sort_values(["id", "w"], ascending=[True, False]).groupby("id").head(MAX_CREDITS_PER_TITLE)
    credits = credits.assign(role=np.select([credits.w >= CATEGORY_WEIGHT["director"], credits.w >= CATEGORY_WEIGHT["writer"]], ["d", "w"], "a"))
    p = p.merge(titles[["id", "votes"]], on="id")
    p = p.sort_values("votes", ascending=False).groupby("nconst").head(MAX_TITLES_PER_PERSON)
    person_cat = p.nconst.astype("category")
    nconsts = person_cat.cat.categories
    p["person"] = person_cat.cat.codes.astype(np.int32)
    p = p[["person", "id", "w"]]
    log(f"  {len(p):,} person–title links")

    # ---- candidate pairs via shared people ----
    log("scoring pairs …")
    pairs = p.merge(p, on="person", suffixes=("_a", "_b"))
    pairs = pairs[pairs.id_a != pairs.id_b]
    pairs["s"] = np.minimum(pairs.w_a, pairs.w_b)
    strongest = pairs.loc[pairs.groupby(["id_a", "id_b"]).s.idxmax(), ["id_a", "id_b", "person", "s"]]
    strongest = strongest.rename(columns={"s": "person_s"})
    pairs = pairs.groupby(["id_a", "id_b"], as_index=False).s.sum()
    log(f"  {len(pairs):,} candidate pairs")

    info = titles.set_index("id")[["gmask", "type", "votes", "rating"]]
    ga = info.gmask.reindex(pairs.id_a).to_numpy(np.int64)
    gb = info.gmask.reindex(pairs.id_b).to_numpy(np.int64)
    inter = np.array([bin(x).count("1") for x in (ga & gb)], dtype=np.float32)
    union = np.array([bin(x).count("1") for x in (ga | gb)], dtype=np.float32)
    jaccard = np.divide(inter, union, out=np.zeros_like(inter), where=union > 0)
    same_type = (info.type.reindex(pairs.id_a).to_numpy() == info.type.reindex(pairs.id_b).to_numpy()).astype(np.float32)
    prior = np.log10(info.votes.reindex(pairs.id_b).to_numpy(np.float64)) * 0.15
    rating_a = info.rating.reindex(pairs.id_a).to_numpy(np.float64)
    rating_b = info.rating.reindex(pairs.id_b).to_numpy(np.float64)
    pairs["score"] = pairs.s.to_numpy() + 2.0 * jaccard + 0.5 * same_type + prior + RATING_WEIGHT * (rating_b - 7)
    pairs = pairs[rating_b >= np.minimum(MIN_RATING, rating_a - 0.5)]
    log(f"  {len(pairs):,} pairs above the rating floor")

    top = pairs.sort_values(["id_a", "score"], ascending=[True, False]).groupby("id_a").head(SIMILAR_K)
    top = top.merge(strongest, on=["id_a", "id_b"], how="left")

    # ---- why: the strongest shared person, by name ----
    want = set(nconsts[np.sort(top.person.unique())]) | set(credits.nconst)
    log(f"reading names of {len(want):,} people …")
    names = {}
    for chunk in pd.read_csv(download("names", args.cache), sep="\t", na_values="\\N", usecols=["nconst", "primaryName"],
                             dtype=str, chunksize=2_000_000, quoting=3):
        chunk = chunk[chunk.nconst.isin(want)]
        names.update(zip(chunk.nconst, chunk.primaryName))
    people = {nconst: i for i, nconst in enumerate(sorted(want))}
    role = np.select([top.person_s >= CATEGORY_WEIGHT["director"], top.person_s >= CATEGORY_WEIGHT["writer"]], ["d", "w"], "a")
    top["why"] = [f"{r}{people[nconsts[c]]}" for r, c in zip(role, top.person)]
    made_by = credits.assign(code=[f"{r}{people[n]}" for r, n in zip(credits.role, credits.nconst)]).groupby("id", sort=False).code.apply(",".join)
    agg = top.groupby("id_a", sort=False).agg(others=("id_b", lambda s: ",".join(map(str, s))), why=("why", ",".join)).reset_index()

    con.execute("DROP TABLE IF EXISTS similar")
    con.execute("DROP TABLE IF EXISTS people")
    con.execute("DROP TABLE IF EXISTS title_people")
    con.execute("CREATE TABLE similar (id INTEGER PRIMARY KEY, others TEXT NOT NULL, why TEXT NOT NULL)")
    con.execute("CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
    con.executemany("INSERT INTO similar VALUES (?, ?, ?)", agg.itertuples(index=False))
    con.execute("CREATE TABLE title_people (id INTEGER PRIMARY KEY, people TEXT NOT NULL)")
    con.executemany("INSERT INTO people VALUES (?, ?)", [(i, names.get(n) or "") for n, i in people.items()])
    con.executemany("INSERT INTO title_people VALUES (?, ?)", [(int(i), code) for i, code in made_by.items()])
    con.execute("INSERT OR REPLACE INTO meta VALUES ('similar_count', ?)", (str(len(agg)),))
    con.commit(); con.execute("VACUUM"); con.close()
    log(f"done: similar lists for {len(agg):,} titles, {os.path.getsize(args.db)/1e6:.1f} MB, {time.time()-t0:.0f}s")

    con = sqlite3.connect(args.db)
    names = dict(con.execute("SELECT CAST(substr(tconst, 3) AS INTEGER), title || ' (' || year || ')' FROM titles"))
    for tc in ("tt1160419", "tt0068646", "tt0903747", "tt0099785"):
        row = con.execute("SELECT others FROM similar WHERE id = ?", (int(tc[2:]),)).fetchone()
        sims = [names.get(int(x), x) for x in row[0].split(",")][:6] if row else []
        print(f"  {names.get(int(tc[2:]))} → {sims}")
    con.close()


if __name__ == "__main__":
    sys.exit(main())
