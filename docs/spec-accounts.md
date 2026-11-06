# ScreenRate: accounts and personal data (draft spec)

Status: draft for discussion. Nothing here is built.

## Summary

Move ScreenRate from GitHub Pages to the VPS as **one small Node server with one SQLite file behind Caddy**.

- Two hard-coded users, Marc and Thomas, each with a password. This replaces the shared database passphrase.
- The film database stays on the device, so search stays instant and works offline.
- The server only does four things: login, handing out the database to logged-in users, storing personal data, and calling TMDB.
- GitHub Actions keeps doing the nightly build and uploads the result to the VPS. Nothing heavy runs on the VPS.
- Your IMDb ratings go in as a CSV drop in Settings, which enables a "For you" list.

## Why GitHub Pages isn't enough

Pages only serves static files, so it can't hold accounts or shared data. The app can save data in the browser, and the watchlist already works that way. That data stays on one device, though, and two people can't compare anything.

## Options compared

| Option | Good | Bad | Verdict |
|---|---|---|---|
| **A. Everything on the VPS** | One place, plain SQLite file, no secrets in the browser, already paid for | You own updates, TLS and backups (mostly automated) | **Recommended** |
| B. Cloudflare Worker + D1 + R2 | Free tier fits easily, no server to maintain | Three products to learn; password hashing is tight on the free plan | Good fallback if the VPS is weak |
| C. Pages + API on the VPS | Keeps Pages | Two hosts, cross-site login cookies are fragile on iPhone [assumption], database stays public and encrypted | No |
| D. PocketBase on the VPS | Login and storage out of the box | Gating the database file and proxying TMDB still need custom hooks; hook runtime and stability not confirmed | No |
| E. Browser only, no server | No backend at all | CSV per device, no sync, no comparing with Thomas, shared passphrase stays | Only if accounts get dropped |

Why not B by default: Workers cap PBKDF2 at 100,000 iterations, and one developer measured that at 10–30 ms against the free plan's 10 ms CPU limit. That's workable but fiddly, and you already have a VPS.

## Architecture

```
GitHub Actions (nightly, and on push to main)
  tests → build DB → similar → Netflix → gzip → upload to VPS
                                                    │ ssh (deploy user)
Phone / Mac ── HTTPS ── Caddy ── Node server ── app.sqlite (users' data)
                                     ├── /srv/screenrate/web     app files
                                     ├── /srv/screenrate/data    imdb.sqlite.gz
                                     └── TMDB (key stays on the server)
```

- **App files:** static and public. They contain no data and no secrets, so they don't need a login.
- **Film database:** only downloadable with a valid session. HTTPS replaces the AES encryption, which is removed.
- **Server:** Node with built-ins only (`node:http`, `node:sqlite`, `node:crypto`). `node:sqlite` is a release candidate in the current Node docs, so check it on the Node version we pick. Fallback is `better-sqlite3`.
- **Process and TLS:** systemd keeps Node running. Caddy renews certificates by itself and needs a domain pointing at the VPS with ports 80 and 443 open.

## Login

- **Users:** `users.json` on the VPS, never in the repo because the repo is public. It holds the two usernames and password hashes.
- **Passwords:** hashed with scrypt at OWASP's settings (N=2^17, r=8, p=1), using 128 MiB per login attempt. A small script sets or changes a password.
- **Usernames:** `marc` and `thomas`, not case-sensitive.
- **Sessions:** a random 32-byte token in a cookie, stored only as a hash on the server. Cookie flags: `HttpOnly`, `Secure`, `SameSite=Lax`. It lasts one year and renews with use. You stay logged in per device.
- **Brute force:** 5 failed attempts per minute per IP, then a pause.
- **Not included:** sign-up, password reset, email. A new user or a reset is a VPS command.

## Data model (`app.sqlite`)

```sql
sessions  (token_hash TEXT PRIMARY KEY, user TEXT, created_at, last_seen_at)
ratings   (user TEXT, tconst TEXT, rating INTEGER, rated_at TEXT,
           source TEXT,  -- 'imdb' or 'app'
           PRIMARY KEY (user, tconst))
watchlist (user TEXT, tconst TEXT, added_at TEXT, PRIMARY KEY (user, tconst))
settings  (user TEXT PRIMARY KEY, json TEXT)  -- region, filters
```

"Recently opened" stays on each device, because it isn't worth syncing.

## API

| Method and path | Purpose |
|---|---|
| `POST /api/login`, `POST /api/logout` | Session |
| `GET /api/me` | User, rating count, database version |
| `GET /data/version`, `GET /data/imdb.sqlite.gz` | Database, login required |
| `GET /api/ratings` | All of my ratings |
| `POST /api/ratings/import` | IMDb CSV, 5 MB limit |
| `PUT`/`DELETE /api/ratings/:tconst` | Rate in the app |
| `GET /api/watchlist`, `PUT`/`DELETE /api/watchlist/:tconst` | Watchlist |
| `GET`/`PUT /api/settings` | Region, filters |
| `GET /api/tmdb/...` | Only find, recommendations and watch providers, cached for a day |

The TMDB key lives only on the server. That also solves "don't type the key in the app": the Settings field goes away. Poster images still load directly from TMDB.

## IMDb ratings import

1. Export your ratings on IMDb and download the CSV.
2. Drop it in Settings.
3. The server reads columns by header name. It needs only `Const` and `Your Rating`; `Date Rated` is used if present.
4. Re-importing is safe. It updates existing rows but doesn't overwrite a newer rating made in the app.
5. Titles missing from the film database are kept, because they may appear later.
6. The app reports what happened, for example "1,204 ratings, 37 not in the database".

⚠ The column names come from third-party pages, not from IMDb. We need one real export to confirm them. Ratings can't be written back to IMDb, so an app rating stays in ScreenRate.

## What this unlocks

All of this runs on the device, using the film database plus your ratings.

- **Your rating everywhere:** a "Seen, 8/10" mark on rows and cards.
- **Hide what you've seen:** in More like this, and later in Discover.
- **For you:**
  1. Take titles you rated 8 or more as seeds.
  2. Add up their similar lists.
  3. Subtract anything similar to titles you rated 5 or less.
  4. Remove seen titles.
  5. Rank by that score plus IMDb rating, optionally only on Netflix CH.
- **Taste profile:** favourite genres, directors and actors. This needs a bigger build, because the database only stores the strongest shared person per suggestion.
- **Movie night, later:** titles neither of you has seen that fit both tastes and are on Netflix. This needs each of you to be able to read the other's ratings.

## Offline behaviour

- The app and database stay cached on the device, so search and detail pages work offline.
- Your ratings and watchlist are also kept in a local copy, refreshed on open.
- Changes need a connection. Offline, the app says so; there's no sync queue at first.
- Live Netflix checks, recommendations and posters that aren't cached need a connection.

## Deploy and operations

- **Upload:** a restricted `deploy` SSH user that can only write to `/srv/screenrate`. The key is a GitHub secret. The database file is replaced in one atomic step.
- **Server basics:** firewall allowing 22, 80 and 443, SSH keys only, automatic security updates.
- **Backups:** a nightly SQLite backup, keeping 7 days, copied off the VPS. Ratings can be re-imported, but the watchlist and app ratings can't.
- **Monitoring:** GitHub's failed-run email covers builds. A free uptime check is optional.
- **Resources:** about 1 GB of RAM should be plenty, because the server only serves files and small queries [assumption].

## Licensing

IMDb allows "personal and non-commercial" use, and forbids republishing or repurposing the data except for individual personal use. It can withdraw permission at any time.

⚠ A login keeps the data private, which helps, but serving it to a second person is a grey area. Thomas using it is your decision. The IMDb credit stays, and so do the JustWatch and TMDB credits.

## Moving over

| Prod question | Answer |
|---|---|
| Expected outage | 0: the old site keeps running until the new one is confirmed |
| Who is affected | Marc and Thomas. Each must add the new address to the Home Screen and log in once |
| Rollback | Keep GitHub Pages running for two weeks, and go back to the old address |
| Rehearsed | Not yet. The new address is the rehearsal; test on the real iPhone before switching off Pages |

⚠ The watchlist is tied to the old address, so it won't move by itself. Add an "Export watchlist" button to the old app first, and an import in the new one.

After two stable weeks, turn off Pages, remove the encryption step, and delete the `DB_PASSPHRASE` repo secret. `TMDB_API_KEY` stays as a repo secret because the Netflix build needs it, and the server gets its own copy.

## Build order

1. **VPS base:** domain, Caddy, deploy user, app and database upload from CI.
2. **Login:** server, users, sessions, gated database download, TMDB proxy.
3. **Personal data:** watchlist on the server, watchlist move, settings.
4. **Ratings:** CSV import and rating marks.
5. **For you:** the list, hiding seen titles, then Discover.
6. **Switch over:** test on iPhone, then retire Pages.

Steps 1–3 replace what exists. Steps 4–5 are the new value.

## Open questions

1. VPS details: provider, RAM, operating system, and what else runs on it.
2. Which domain or subdomain to use.
3. Should Marc and Thomas see each other's ratings? This is needed for Movie night.
4. One real IMDb ratings CSV, to confirm the columns.
5. Is it fine for Thomas to use the app, given the licence wording?

## Sources

- [IMDb non-commercial datasets](https://data.imdb.com/non-commercial-datasets/)
- [IMDb: using data in software](https://help.imdb.com/article/imdb/general-information/can-i-use-imdb-data-in-my-software/G5JTRESSHJBBHTGX)
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [workerd issue on the PBKDF2 limit](https://github.com/cloudflare/workerd/issues/1346)
- [Node.js `node:sqlite`](https://nodejs.org/api/sqlite.html)
- [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https)
- [WebKit on storage limits](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)
