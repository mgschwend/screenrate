#!/bin/sh
# The only thing CI's SSH key may run (forced command in authorized_keys).
# Reads a tar.gz from stdin with web/, server/, compose.yml, data/imdb.sqlite.gz and data/db-version.json,
# then swaps it in. If the new version doesn't come up healthy, it returns to the previous one.
set -eu
umask 027
cd /home/deploy/screenrate

release="releases/$(date -u +%Y%m%d-%H%M%S)"
mkdir -p "$release" data
tar -xzf - -C "$release" --no-same-owner
test -f "$release/server/index.js"
test -f "$release/web/index.html"

previous="$(readlink current 2>/dev/null || true)"
point() { ln -sfn "$1" current.new && mv -T current.new current; }
point "$release"
cp "$release/compose.yml" compose.yml

if ! docker compose up -d --force-recreate --wait --wait-timeout 40; then
  echo "New version failed its health check" >&2
  if [ -n "$previous" ]; then
    point "$previous"
    docker compose up -d --force-recreate --wait --wait-timeout 40 || true
  fi
  exit 1
fi

# Database last, so it's only replaced once the new server runs. mv keeps each swap atomic.
mv -f "$release/data/imdb.sqlite.gz" data/imdb.sqlite.gz
mv -f "$release/data/db-version.json" data/db-version.json
rmdir "$release/data"

ls -1dt releases/* | tail -n +4 | xargs -r rm -rf
echo "Deployed $release"
