# ScreenRate

Private PWA: type a film or series title and see IMDb ratings live as you type, with
an IMDb link per result. The detail page proposes similar titles, and there is a watchlist.
Fully on-device: no server, no accounts.

> **Pivot (2026-11-05).** The camera/OCR scanner was removed. On real Netflix screens the titles are
> logo artwork that on-device OCR can't read, and scanning felt awkward. Search replaces it.
Deployed to GitHub Pages: https://mgschwend.github.io/screenrate/

## Architecture

- **Data.** IMDb non-commercial datasets are filtered into `imdb.sqlite` (~22 MB, about 62k titles with ≥ 1000 votes, plus about 55k DE/CH/AT aliases) by `scripts/build_imdb_db.py` in CI. It has these tables:
  - `titles`
  - `akas`, the DE/CH/AT titles
  - `titles_fts`, an FTS5 index
  - `meta`
- **Encryption.** IMDb data is licensed for *individual personal use*, so the
  published file is encrypted. `scripts/encrypt_db.py` gzips the file, then encrypts it with AES-256-GCM. The key is derived with PBKDF2-SHA256 from the `DB_PASSPHRASE` repo secret, at 600k iterations with a fixed salt. The output is `imdb.sqlite.enc`, about 10 MB. The app asks for the passphrase once, decrypts with WebCrypto (`web/src/dbcrypto.js`) and keeps only a non-extractable key on the device. The repo, the Pages site and the CI artifacts only ever hold ciphertext.
- **Loading.** The app loads the database with the official SQLite WASM build (`@sqlite.org/sqlite-wasm`), deserialized in memory, and caches the encrypted file in Cache Storage. The "Update data" button drops the cache entry and fetches the file again. sql.js was the original plan, but its standard build has no FTS5, which `titles_fts` needs.
- **Search.** `web/src/search.js` ranks results in four groups:
  1. Exact title, original title or DE/CH/AT alias.
  2. Title or alias starts with the query.
  3. Every word matches as a prefix (FTS5).
  4. Typo fallback (looser prefixes plus Dice ≥ 0.6), used only when nothing else matched.

  Within each group, more IMDb votes ranks higher. Queries take about 10 ms.
- **Similar titles.** `scripts/add_similar.py` runs in CI and adds `titles.genres` plus a `similar` table with the top 10 titles per film. The score combines shared directors (weight 3), writers (2) and lead cast (1–1.5), genre overlap and a small popularity prior. If a title has no list, the app falls back to the most-voted titles of the same genre. With a TMDB key, TMDB recommendations appear on top, each mapped back to a local IMDb rating.
- **Netflix availability.** `scripts/add_netflix.py` runs nightly in CI using the `TMDB_API_KEY` repo secret. It pulls the Netflix catalogue for each region (currently CH) from TMDB `/discover`, where the data comes from JustWatch. It maps the results to IMDb ids via `/external_ids`, with the id map kept in the Actions cache, and stores them in the `netflix` table. The app then shows an **N** badge on results and similar titles, offers a "Netflix only" filter, and shows the status on the detail page. With a TMDB key on the phone, the detail page also runs a live check listing every subscription service. Without the secret, the step is skipped and the Netflix UI is hidden. Attribution "Streaming data: JustWatch (via TMDB)" is shown wherever availability appears.
- **Data updates.** CI also publishes `db-version.json`, which contains only the build timestamp. When it changes, the app quietly downloads the new DB.
- **Posters (optional).** Fetched from TMDB `/find/{tconst}` when you supply your own key in Settings.
- **Offline.** The service worker precaches the app shell; posters are runtime-cached.

## Layout

```
scripts/build_imdb_db.py   IMDb TSV → imdb.sqlite
scripts/encrypt_db.py      imdb.sqlite → imdb.sqlite.enc (and --decrypt)
scripts/add_similar.py     genres + similar titles (IMDb principals)
scripts/add_netflix.py     Netflix availability per region (TMDB / JustWatch)
web/src/main.js            boot/unlock, live search, detail, settings
web/src/search.js          ranked search-as-you-type
web/src/match.js           normalize helpers, Dice, title resolution (used by search fallback)
web/src/titledb.js         SQL queries (exact / FTS5 prefix / aliases / similar)
web/src/dataload.js        cache → decrypt → sqlite; key storage
web/src/ui.js, store.js, tmdb.js  rows/sheet, localStorage, TMDB posters + recommendations
web/                       Vite + vanilla JS PWA
.github/workflows/pages.yml  build data + web, deploy to Pages
                             (on push to main, nightly, or manually)
```

## Setup

```bash
gh secret set DB_PASSPHRASE -R mgschwend/screenrate   # prompts; choose a long passphrase
gh secret set TMDB_API_KEY -R mgschwend/screenrate    # prompts; enables Netflix availability
```

Local build:

```bash
pip install pandas numpy cryptography
python scripts/build_imdb_db.py --akas
python scripts/add_similar.py imdb.sqlite
TMDB_API_KEY=… python scripts/add_netflix.py imdb.sqlite --regions CH
DB_PASSPHRASE=… python scripts/encrypt_db.py imdb.sqlite web/public/imdb.sqlite.enc
cd web && npm install && npm run dev
```

Tests:

```bash
cd web && npm test
```

Information courtesy of IMDb (https://www.imdb.com). Used with permission.
Personal, non-commercial use only.
