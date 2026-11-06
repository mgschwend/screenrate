#!/bin/sh
# Copy the newest app.sqlite backup to Cloudflare R2 and keep 30 days there.
# Uses the trailmap backup container for its aws tool and R2 key, so no second copy of the key exists.
# Objects go under screenrate/; trailmap's own pruning only touches its own prefix.
set -eu
CONTAINER=trailmap-staging-db-backup-1
cd /home/deploy/screenrate/data/backups
latest="$(ls -1 app-*.sqlite | tail -n 1)"
docker cp -q "$latest" "$CONTAINER:/tmp/screenrate-backup.sqlite"
docker exec -e NAME="$latest" -i "$CONTAINER" sh -s <<'REMOTE'
set -eu
export AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_KEY" AWS_DEFAULT_REGION=auto
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
s3() { aws --endpoint-url "$BACKUP_S3_ENDPOINT" s3 "$@"; }
base="s3://$BACKUP_S3_BUCKET/screenrate"
s3 cp --only-show-errors /tmp/screenrate-backup.sqlite "$base/$NAME"
rm -f /tmp/screenrate-backup.sqlite
cutoff="$(date -u -d "@$(( $(date -u +%s) - 30 * 86400 ))" +%Y-%m-%d)"
s3 ls "$base/" | awk '{print $NF}' | while read -r key; do
  day="$(echo "$key" | sed -n 's/^app-\(.*\)\.sqlite$/\1/p')"
  if [ -n "$day" ] && [ "$day" != "$cutoff" ] && [ "$(printf '%s\n%s\n' "$day" "$cutoff" | sort | head -n 1)" = "$day" ]; then
    s3 rm --only-show-errors "$base/$key"
  fi
done
REMOTE
echo "$(date -u +%FT%TZ) uploaded $latest"
