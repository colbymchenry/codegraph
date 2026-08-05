#!/usr/bin/env bash
# Loads scripts/fixture.sql into the LOCAL .wrangler D1 (never the remote one:
# --local is on every command here, and nothing in this repo writes production).
#
# The schema comes from the writer, telemetry-worker/migrations/, because that
# is where it belongs — D1 is read-only from this worker.
#
#   ./scripts/seed-fixture.sh      (or: npm run seed)
set -uo pipefail

cd "$(dirname "$0")/.."

DB=codegraph-telemetry
MIGRATION=../telemetry-worker/migrations/0001_init.sql

if [[ ! -f "$MIGRATION" ]]; then
  echo "seed: cannot find $MIGRATION — run this from a full checkout" >&2
  exit 1
fi

# The migration is plain CREATE TABLE, so a second run fails on "table already
# exists". That is the expected steady state here, hence the swallowed output —
# the fixture load below is the step whose failure actually matters.
npx wrangler d1 execute "$DB" --local --file="$MIGRATION" >/dev/null 2>&1

if ! npx wrangler d1 execute "$DB" --local --file=scripts/fixture.sql >/dev/null; then
  echo "seed: loading scripts/fixture.sql failed" >&2
  exit 1
fi

echo "seed: fixture loaded into the local $DB (12 machines, 2026-07-01 … 2026-07-10)"
