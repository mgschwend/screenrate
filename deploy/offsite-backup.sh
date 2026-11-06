#!/bin/sh
# Copy the newest app.sqlite backup to Cloudflare R2 and keep 30 days there.
# backup.env (chmod 600) holds AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, R2_ENDPOINT and R2_BUCKET.
set -eu
cd /home/deploy/screenrate
latest="$(ls -1 data/backups/app-*.sqlite | tail -n 1)"
docker run --rm -i --env-file backup.env -e NAME="$(basename "$latest")" \
  -e AWS_DEFAULT_REGION=auto -e AWS_REQUEST_CHECKSUM_CALCULATION=when_required -e AWS_RESPONSE_CHECKSUM_VALIDATION=when_required \
  -v "$PWD/data/backups:/backups:ro" --entrypoint sh amazon/aws-cli -s <<'REMOTE'
set -eu
s3() { aws --endpoint-url "$R2_ENDPOINT" s3 "$@"; }
base="s3://$R2_BUCKET/screenrate"
s3 cp --only-show-errors "/backups/$NAME" "$base/$NAME"
cutoff="$(date -u -d "@$(( $(date -u +%s) - 30 * 86400 ))" +%Y-%m-%d)"
s3 ls "$base/" | awk '{print $NF}' | while read -r key; do
  day="$(echo "$key" | sed -n 's/^app-\(.*\)\.sqlite$/\1/p')"
  if [ -n "$day" ] && [ "$day" != "$cutoff" ] && [ "$(printf '%s\n%s\n' "$day" "$cutoff" | sort | head -n 1)" = "$day" ]; then
    s3 rm --only-show-errors "$base/$key"
  fi
done
s3 ls "$base/$NAME"
REMOTE
echo "$(date -u +%FT%TZ) uploaded $latest"
