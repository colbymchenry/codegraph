#!/usr/bin/env bash
# Re-runs the nightly rollup over a range of days against the DEPLOYED ingest worker,
# one day per request. Each day: legacy usage rows still in `events` are folded into
# `usage_daily`, `first_index_day` is set, and the day's rollups are recomputed. All of
# it is idempotent, so a range can be repeated or overlapped safely.
#
#   ./scripts/backfill-rollup.sh 2026-07-04 2026-10-02 [token-file]
#
# The admin token comes from the token file when one is given, else from $ADMIN_TOKEN.
# Stops at the first day that does not answer 200, so a rerun can start from there.
set -euo pipefail

FROM=${1:?usage: backfill-rollup.sh FROM_DAY TO_DAY [TOKEN_FILE]}
TO=${2:?usage: backfill-rollup.sh FROM_DAY TO_DAY [TOKEN_FILE]}
if [ -n "${3:-}" ]; then ADMIN_TOKEN=$(tr -d '\n' < "$3"); fi
: "${ADMIN_TOKEN:?set ADMIN_TOKEN or pass a token file}"
BASE="${ROLLUP_BASE:-https://telemetry.getcodegraph.com}"

days=$(node -e '
const [from, to] = process.argv.slice(1);
for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 864e5)
  console.log(new Date(t).toISOString().slice(0, 10));' "$FROM" "$TO")

for day in $days; do
  started=$(date +%s)
  # A day with millions of legacy rows takes minutes; never let one hang forever.
  response=$(curl -sS --max-time 1800 -X POST -H "x-admin-token: $ADMIN_TOKEN" \
    -w $'\n%{http_code}' "$BASE/admin/rollup?day=$day") || { echo "$day request failed"; exit 1; }
  code=${response##*$'\n'}
  body=${response%$'\n'*}
  printf '%s %s %ss %s\n' "$day" "$code" "$(( $(date +%s) - started ))" "$body"
  [ "$code" = 200 ] || { echo "stopping at $day"; exit 1; }
done
