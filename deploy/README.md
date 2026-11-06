# Running ScreenRate on the VPS

The app runs at `https://movies.localtrails.ch` from `/home/deploy/screenrate`, next to the trailmap
staging stack. It uses that stack's Traefik and nothing else from it.

```
/home/deploy/screenrate
├── compose.yml        copied in by each deploy
├── .env               TMDB_API_KEY=… (chmod 600)
├── receive.sh         run by CI's SSH key, nothing else
├── current → releases/…   code and app files
├── releases/          the last three versions
└── data/              app.sqlite, users.json, imdb.sqlite.gz, backups/
```

## First setup

1. **DNS:** in Cloudflare, add `movies.localtrails.ch`, type `A`, value `77.42.39.59`, **DNS only**.
2. **Folder**, on the VPS:

   ```bash
   mkdir -p ~/screenrate/data ~/screenrate/releases
   ```

   Copy `deploy/receive.sh` to `~/screenrate/receive.sh`, make it executable, and create `~/screenrate/.env`
   with `TMDB_API_KEY=…` (`chmod 600`).
3. **CI key**, on your Mac:

   ```bash
   ssh-keygen -t ed25519 -N '' -C screenrate-ci -f /tmp/screenrate-ci
   ```

   On the VPS, add one line to `~/.ssh/authorized_keys`:

   ```
   restrict,command="/home/deploy/screenrate/receive.sh" ssh-ed25519 AAAA… screenrate-ci
   ```

   `restrict` matters: the `deploy` user has sudo and Docker, so this key must be able to run this one script only.

   Then store the private key and host key as repo secrets, and delete the local copy:

   ```bash
   gh secret set VPS_DEPLOY_KEY -R mgschwend/screenrate < /tmp/screenrate-ci
   ```

   ```bash
   ssh-keyscan -t ed25519 77.42.39.59 | gh secret set VPS_KNOWN_HOSTS -R mgschwend/screenrate
   ```

   ```bash
   rm /tmp/screenrate-ci /tmp/screenrate-ci.pub
   ```
4. **First deploy:** run the workflow **Build data + deploy to VPS**.
5. **Passwords**, on the VPS, after the first deploy. The password is typed, not shown, and only its hash is stored:

   ```bash
   cd ~/screenrate
   ```

   ```bash
   docker compose exec app node set-password.js marc
   ```

   ```bash
   docker compose exec app node set-password.js thomas
   ```

## Everyday

- **Change a password:** run `set-password.js` again. It takes effect at once. Existing sessions stay logged in.
- **Logs:** `docker compose logs -f app`
- **Stop it completely:** `docker compose down`. This leaves trailmap and the data alone.
- **Backups:** the server writes one copy of `app.sqlite` per day to `data/backups/` and keeps seven.
  They stay on this machine, so copy them elsewhere if the VPS itself is a risk.
