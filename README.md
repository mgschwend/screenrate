# ScreenRate

Private PWA for two people: search any film or series and see its IMDb rating, whether it's on
Netflix Switzerland, what's like it, and what you'd probably enjoy next.

Runs at https://movies.localtrails.ch. The design is in [docs/spec-accounts.md](docs/spec-accounts.md),
and running it on the VPS is in [deploy/README.md](deploy/README.md).

## How it works

- **Film database.** CI filters the IMDb datasets into a SQLite file (about 62k titles with at least 1000 votes, plus German titles), adds similar titles, and adds Netflix CH availability from TMDB/JustWatch. It runs nightly and on every push to `main`.
- **On the device.** The app downloads that file after login and opens it with SQLite WASM, in memory. Search, detail pages and suggestions run there, so they're instant and work offline.
- **On the server.** A small Node server with no dependencies, storing data in SQLite. It handles login, serves the database to logged-in users, stores ratings, watchlist and settings, and proxies TMDB so the key stays private.
- **For you.** Runs on the device: titles similar to what you rated highly, minus what resembles what you rated low. "With Thomas" or "With Marc" combines both tastes and leaves out anything either has seen.

## Layout

```
scripts/build_imdb_db.py   IMDb datasets → imdb.sqlite
scripts/add_similar.py     genres, similar titles and why they match
scripts/add_netflix.py     Netflix availability per region
server/                    Node server (app.js routes, auth.js, store.js, csv.js, tmdb.js)
server/set-password.js     set or change a password
web/                       the PWA (Vite, vanilla JS)
deploy/                    compose file, CI's upload script, VPS guide
.github/workflows/         nightly build and deploy
```

## Development

```bash
cd server && npm test
```

```bash
cd web && npm ci && PYTHON=python3 npm test
```

To run it locally, build the app, then start the server with a data folder containing `users.json`, `imdb.sqlite.gz` and `db-version.json`:

```bash
cd web && npm run build
```

```bash
cd server && DATA_DIR=/path/to/data WEB_DIR=../web/dist INSECURE_COOKIES=1 PORT=8787 npm start
```

Only ever set `INSECURE_COOKIES` on localhost. Create local users with `node set-password.js marc /path/to/data/users.json`.

## Credits and licence

Information courtesy of IMDb (https://www.imdb.com). Used with permission. Personal, non-commercial use only.
Streaming data: JustWatch (via TMDB). This product uses the TMDB API but is not endorsed or certified by TMDB.
