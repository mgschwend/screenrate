# ScreenRate

Private PWA: point the phone camera at the TV (Netflix, Disney+, …), recognise the
movie/series titles on screen and overlay their IMDb rating on the camera image.
History list and watchlist. Fully on-device: no server, no accounts.
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
- **OCR.** PaddleOCR runs through `ppu-paddle-ocr` and `onnxruntime-web` in a Web Worker. It uses WebGPU and falls back to WASM. It returns text lines with bounding boxes.
- **Matching.** OCR text goes through `normalize()`, which is identical in Python and JS. Parity is tested in `web/test/normalize.test.js`. Lookup order:
  1. Exact `normTitle`, `normOriginal` or `akas.normTitle` match.
  2. Otherwise, an FTS prefix match on all words, keeping only results with bigram Dice similarity ≥ 0.75.

  Candidates are ranked by votes, highest first.
- **Frame pipeline.** The app scans at about 2–4 fps:
  - Each frame is downscaled to 960 px, converted to grayscale, inverted and thresholded.
  - A frame is skipped when its 32×32 thumbnail barely differs from the previous one.
  - A title must appear in at least 2 frames before it is shown.
  - A stop-list drops UI chrome.
- **Disambiguation.** The app tries these in order:
  1. Pick a clear winner when it has at least 5× the votes of the runner-up.
  2. Use a year or "Season/Staffel" read near the title.
  3. Show a "?" badge that opens a picker.

  Choices the user makes are remembered in `localStorage` (normTitle → tconst).
- **Posters (optional).** Fetched from TMDB `/find/{tconst}` when the user supplies an API key in settings.
- **Offline.** `web/sw-template.js` becomes `sw.js` at build time. The service worker precaches the app shell and runtime-caches the OCR models (Hugging Face), the onnxruntime wasm (jsDelivr) and TMDB posters.
- **Debugging.** The text field runs the same matching pipeline as the camera. In the console, `screenrate.snapshotFrom(canvas)` runs OCR on any image.
- **UI.** The app has two states:
  - **Scanning:** live AR badges on the camera image, with the history list below.
  - **Paused:** the last frame is frozen with its badges still tappable.

  It also has a detail sheet, a snapshot mode, a watchlist and settings.

## Layout

```
scripts/build_imdb_db.py   IMDb TSV → imdb.sqlite
scripts/encrypt_db.py      imdb.sqlite → imdb.sqlite.enc (and --decrypt)
web/src/main.js            app state machine (idle/scanning/paused), camera loop, snapshot
web/src/match.js           stop-list, Dice, resolve/disambiguation, context, phrases, voting
web/src/titledb.js         SQL queries (exact / FTS5 prefix)
web/src/dataload.js        cache → decrypt → sqlite; key storage
web/src/frame.js           frame diff + TV preprocessing
web/src/ocr*.js            PaddleOCR worker + client
web/src/overlay.js         AR badges on canvas
web/src/ui.js, store.js, tmdb.js  sheet/lists, localStorage, posters
web/                       Vite + vanilla JS PWA
.github/workflows/pages.yml  build data + web, deploy to Pages
                             (on push to main, weekly on Mondays, or manually)
```

## Setup

```bash
gh secret set DB_PASSPHRASE -R mgschwend/screenrate   # prompts; choose a long passphrase
```

Local build:

```bash
pip install pandas cryptography
python scripts/build_imdb_db.py --akas
DB_PASSPHRASE=… python scripts/encrypt_db.py imdb.sqlite web/public/imdb.sqlite.enc
cd web && npm install && npm run dev
```

Tests:

```bash
cd web && npm test
```

Information courtesy of IMDb (https://www.imdb.com). Used with permission.
Personal, non-commercial use only.
