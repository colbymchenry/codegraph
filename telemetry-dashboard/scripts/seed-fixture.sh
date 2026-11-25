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
MIGRATIONS=../telemetry-worker/migrations

if [[ ! -f "$MIGRATIONS/0001_init.sql" ]]; then
  echo "seed: cannot find $MIGRATIONS — run this from a full checkout" >&2
  exit 1
fi

# Applied in order, each as a plain file. A second run fails every one of them
# ("table already exists", "duplicate column") — the expected steady state here,
# hence the swallowed output. The fixture load below is the step whose failure
# actually matters, and it fails loudly if a migration is missing.
for migration in "$MIGRATIONS"/*.sql; do
  npx wrangler d1 execute "$DB" --local --file="$migration" >/dev/null 2>&1
done

if ! npx wrangler d1 execute "$DB" --local --file=scripts/fixture.sql >/dev/null; then
  echo "seed: loading scripts/fixture.sql failed" >&2
  exit 1
fi

echo "seed: fixture loaded into the local $DB (12 machines, 2026-07-01 … 2026-07-10)"
