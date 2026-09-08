#!/usr/bin/env bash
# End-to-end check of the nightly rollup + retention purge against a real
# `wrangler dev` and the local D1 state.
#
# Seeds three synthetic days of events straight into local D1 (the ingest path clamps
# client timestamps to the last 30 days, so backdating far enough to exercise the purge
# has to bypass it), drives the rollup through the admin endpoint and the cron handler,
# then inspects what actually landed against hand-computed numbers.
#
# What it pins:
#   * rollup numbers match the events they came from, including the two that are easy
#     to get wrong — usage_rollup SUMs its `count` prop, and array props unnest
#   * running a day twice changes nothing (idempotent upserts, no double counting)
#   * ?reset=1 drops stale rollup rows on a live day and REFUSES to blank a day whose
#     raw events are already purged
#   * the purge deletes only rows past the window, and leaves machine_days /
#     machine_first_seen alone
#   * /admin/rollup does not exist without ADMIN_TOKEN, and rejects a wrong one
#
# Re-runnable: it wipes its own synthetic days first, and they are chosen to sit
# outside the cron's 3-day lookback so the nightly run never rewrites them.
#
#   npm run smoke:rollup        # or: ROLLUP_PORT=8792 ./scripts/smoke-rollup.sh
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${ROLLUP_PORT:-8788}"
BASE="http://127.0.0.1:$PORT"
DB=codegraph-telemetry
TOKEN=smoke-admin-token
SEED_SQL=/tmp/cg-smoke-rollup-seed.sql
LOG=/tmp/cg-smoke-rollup.log

pass=0; fail=0
ok()   { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad()  { fail=$((fail + 1)); printf '  FAIL %s — expected %s, got %s\n' "$1" "$2" "$3"; }
is()   { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }

day_ago() { node -e 'console.log(new Date(Date.now()-process.argv[1]*864e5).toISOString().slice(0,10))' "$1"; }

# Synthetic days. MAIN/RESET sit inside the 90-day retention window but outside the
# cron's 3-day lookback; OLD sits past the window so the purge takes it.
DAY_MAIN=$(day_ago 40)
DAY_RESET=$(day_ago 41)
DAY_OLD=$(day_ago 200)
CUTOFF=$(day_ago 90)

# First column of the first row of a query against the LOCAL D1 state.
q() {
  npx wrangler d1 execute "$DB" --local --json --command "$1" 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const r=JSON.parse(s.slice(s.indexOf("[")))[0]?.results?.[0];
      console.log(r===undefined?"":String(Object.values(r)[0]));})'
}

# A daily_dim_counts cell as "count/machines" — "" when the row does not exist.
dim() { q "select count||'/'||machines from daily_dim_counts
             where day='$1' and event='$2' and dim='$3' and value='$4'"; }

# POST /admin/rollup, printing the HTTP status.
roll() { curl -s -o /dev/null -w '%{http_code}' -X POST -H "x-admin-token: $TOKEN" "$BASE/admin/rollup?$1"; }

boot() {  # extra wrangler dev args
  npx wrangler dev --port "$PORT" "$@" >"$LOG" 2>&1 &
  DEV_PID=$!
  trap 'kill "$DEV_PID" 2>/dev/null || true; wait "$DEV_PID" 2>/dev/null || true' EXIT
  local up=
  for _ in $(seq 1 60); do
    curl -sf -o /dev/null "$BASE/" && { up=1; break; }
    kill -0 "$DEV_PID" 2>/dev/null || { echo "wrangler dev died:"; cat "$LOG"; exit 1; }
    sleep 1
  done
  [ -n "$up" ] || { echo "worker never came up:"; cat "$LOG"; exit 1; }
  # If wrangler could not bind the port, something else answers every probe and the
  # whole run silently grades a different server. Check who picked up.
  case "$(curl -s "$BASE/")" in
    *'codegraph anonymous-telemetry ingest'*) : ;;
    *) echo "port $PORT is serving something else — set ROLLUP_PORT to a free one"; exit 1 ;;
  esac
}
shutdown() {
  kill "$DEV_PID" 2>/dev/null || true
  wait "$DEV_PID" 2>/dev/null || true
  trap - EXIT
  sleep 1   # let miniflare release the local sqlite file
}

# ---------------------------------------------------------------------------
# Seed
# ---------------------------------------------------------------------------
echo "applying migrations to local D1"
npx wrangler d1 migrations apply "$DB" --local >/dev/null 2>&1

echo "seeding $DAY_MAIN / $DAY_RESET / $DAY_OLD"
node -e '
const [main, reset, old, seedFile] = process.argv.slice(1);
const sq = (v) => `'"'"'${String(v).replace(/'"'"'/g, "'"'"''"'"'")}'"'"'`;
const M = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222",
           "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444",
           "99999999-9999-4999-8999-999999999999"];
const out = [];

// Re-runnable: every table this script touches, scoped to its own synthetic days.
for (const t of ["events", "daily_event_counts", "daily_dim_counts", "daily_machines", "machine_days"]) {
  out.push(`DELETE FROM ${t} WHERE day IN (${[main, reset, old].map(sq).join(", ")});`);
}
out.push(`DELETE FROM machine_first_seen WHERE machine_id IN (${M.map(sq).join(", ")});`);

// day, machine, event, os, arch, version, node_major, ci, props
const rows = [
  [main, M[0], "install",      "darwin", "arm64", "1.5.0", 22, 0, {targets:["claude","cursor"], scope:"local", kind:"fresh"}],
  [main, M[0], "index",        "darwin", "arm64", "1.5.0", 22, 0, {languages:["typescript","go"], file_count_bucket:"100-1k", duration_bucket:"10-60s"}],
  [main, M[0], "usage_rollup", "darwin", "arm64", "1.5.0", 22, 0, {kind:"mcp_tool", name:"codegraph_explore", count:10, error_count:2, client_name:"Claude Code"}],
  [main, M[1], "index",        "darwin", "x64",   "1.5.0", 20, 0, {languages:["typescript"], file_count_bucket:"1k-10k", duration_bucket:"10-60s"}],
  [main, M[1], "usage_rollup", "darwin", "x64",   "1.5.0", 20, 0, {kind:"mcp_tool", name:"codegraph_explore", count:5, error_count:0, client_name:"Cursor"}],
  [main, M[2], "install",      "linux",  "x64",   "1.4.1", 22, 1, {targets:["claude"], scope:"global", kind:"upgrade"}],
  [main, M[2], "uninstall",    "linux",  "x64",   "1.4.1", 22, 1, {targets:["claude"]}],
  [reset, M[3], "index",       "darwin", "arm64", "1.5.0", 22, 0, {languages:["python"], file_count_bucket:"<100", duration_bucket:"<10s"}],
  [old,  M[4], "install",      "linux",  "x64",   "1.0.0", 20, 0, {targets:["codex"], scope:"local", kind:"fresh"}],
  [old,  M[4], "index",        "linux",  "x64",   "1.0.0", 20, 0, {languages:["rust"], file_count_bucket:"<100", duration_bucket:"<10s"}],
];
for (const [day, m, event, os, arch, version, node, ci, props] of rows) {
  out.push(`INSERT INTO events (received_at, ts, day, event, machine_id, codegraph_version, os, arch, node_major, ci, schema_version, props)
    VALUES (${sq(day + "T12:00:00.000Z")}, ${sq(day + "T12:00:00.000Z")}, ${sq(day)}, ${sq(event)}, ${sq(m)},
            ${sq(version)}, ${sq(os)}, ${sq(arch)}, ${node}, ${ci}, 1, ${sq(JSON.stringify(props))});`);
}

// What the ingest path would have written alongside those events.
for (const [m, day, prod] of [[M[0], main, 1], [M[1], main, 1], [M[2], main, 0], [M[3], reset, 1], [M[4], old, 1]]) {
  out.push(`INSERT INTO machine_days (machine_id, day, prod) VALUES (${sq(m)}, ${sq(day)}, ${prod});`);
  out.push(`INSERT INTO machine_first_seen (machine_id, first_day) VALUES (${sq(m)}, ${sq(day)})
              ON CONFLICT (machine_id) DO UPDATE SET first_day = min(machine_first_seen.first_day, excluded.first_day);`);
}

// A rollup row from a dimension that no longer exists — only ?reset=1 should clear it.
out.push(`INSERT INTO daily_dim_counts (day, event, dim, value, count, machines)
            VALUES (${sq(reset)}, ${sq("index")}, ${sq("obsolete_dim")}, ${sq("stale")}, 99, 99);`);

require("fs").writeFileSync(seedFile, out.join("\n"));
' "$DAY_MAIN" "$DAY_RESET" "$DAY_OLD" "$SEED_SQL"
npx wrangler d1 execute "$DB" --local --file "$SEED_SQL" >/dev/null

# ---------------------------------------------------------------------------
# The admin route does not exist without a token
# ---------------------------------------------------------------------------
echo
echo "admin route, no ADMIN_TOKEN configured"
boot
is "POST /admin/rollup → 404" 404 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/admin/rollup")"
is "…even with a token header" 404 \
   "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "x-admin-token: $TOKEN" "$BASE/admin/rollup")"
shutdown

# ---------------------------------------------------------------------------
# Drive the rollup
# ---------------------------------------------------------------------------
echo
echo "admin route, ADMIN_TOKEN configured"
boot --test-scheduled --var "ADMIN_TOKEN:$TOKEN"

is "no token → 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/admin/rollup")"
is "wrong token → 401" 401 \
   "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'x-admin-token: nope' "$BASE/admin/rollup")"
is "GET → 405" 405 "$(curl -s -o /dev/null -w '%{http_code}' -H "x-admin-token: $TOKEN" "$BASE/admin/rollup")"
is "impossible day → 400" 400 "$(roll 'day=2026-02-31')"
is "malformed day → 400" 400 "$(roll 'day=yesterday')"
is "days out of range → 400" 400 "$(roll "day=$DAY_MAIN&days=99")"

echo
echo "rollup"
is "rollup $DAY_MAIN → 200" 200 "$(roll "day=$DAY_MAIN")"
is "rollup $DAY_MAIN again → 200" 200 "$(roll "day=$DAY_MAIN")"
is "rollup $DAY_OLD, whose events are still there → 200" 200 "$(roll "day=$DAY_OLD")"
is "rollup $DAY_RESET with reset → 200" 200 "$(roll "day=$DAY_RESET&reset=1")"

# The cron body: rolls up the last three days and purges everything past the window.
is "cron trigger → 200" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/__scheduled?cron=30+0+*+*+*")"
sleep 2

# Rolling a purged day with reset=1 must NOT blank the rollups it already has: past
# the window the reset is ignored, so the delete-then-rebuild can't find zero events.
is "rollup $DAY_OLD after the purge, with reset → 200" 200 "$(roll "day=$DAY_OLD&reset=1")"
is "…and reports the reset it refused to run" "[\"$DAY_OLD\"]" \
   "$(curl -s -X POST -H "x-admin-token: $TOKEN" "$BASE/admin/rollup?day=$DAY_OLD&reset=1" |
      node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(JSON.parse(s).reset_ignored)))')"

shutdown

# ---------------------------------------------------------------------------
# What actually landed — every number below is hand-computed from the seed above
# ---------------------------------------------------------------------------
echo
echo "daily_machines"
is "3 machines, 2 of them production (one is ci)" "3/2" \
   "$(q "select machines||'/'||prod_machines from daily_machines where day='$DAY_MAIN'")"

echo
echo "daily_event_counts"
is "install: 2 events from 2 machines" "2/2" \
   "$(q "select count||'/'||machines from daily_event_counts where day='$DAY_MAIN' and event='install'")"
is "index: 2 events from 2 machines" "2/2" \
   "$(q "select count||'/'||machines from daily_event_counts where day='$DAY_MAIN' and event='index'")"
is "uninstall: 1 event from 1 machine" "1/1" \
   "$(q "select count||'/'||machines from daily_event_counts where day='$DAY_MAIN' and event='uninstall'")"
# The one that is easy to get wrong: 2 rows carrying count 10 and 5 is 15 tool calls.
is "usage_rollup: SUMs the count prop (10+5), not the rows" "15/2" \
   "$(q "select count||'/'||machines from daily_event_counts where day='$DAY_MAIN' and event='usage_rollup'")"
is "one row per event type" 4 "$(q "select count(*) from daily_event_counts where day='$DAY_MAIN'")"

echo
echo "daily_dim_counts"
is "os / index / darwin" "2/2" "$(dim "$DAY_MAIN" index os darwin)"
is "os / usage_rollup / darwin sums counts" "15/2" "$(dim "$DAY_MAIN" usage_rollup os darwin)"
is "arch / uninstall / x64" "1/1" "$(dim "$DAY_MAIN" uninstall arch x64)"
is "codegraph_version / index / 1.5.0" "2/2" "$(dim "$DAY_MAIN" index codegraph_version 1.5.0)"
is "node_major / install / 22 (stored as text)" "2/2" "$(dim "$DAY_MAIN" install node_major 22)"
is "file_count_bucket / index / 100-1k" "1/1" "$(dim "$DAY_MAIN" index file_count_bucket 100-1k)"
is "duration_bucket / index / 10-60s" "2/2" "$(dim "$DAY_MAIN" index duration_bucket 10-60s)"
is "scope / install / global" "1/1" "$(dim "$DAY_MAIN" install scope global)"
is "kind / install / fresh" "1/1" "$(dim "$DAY_MAIN" install kind fresh)"
is "kind / usage_rollup / mcp_tool (same dim, other event)" "15/2" "$(dim "$DAY_MAIN" usage_rollup kind mcp_tool)"
is "name / usage_rollup / codegraph_explore" "15/2" "$(dim "$DAY_MAIN" usage_rollup name codegraph_explore)"
is "client_name / usage_rollup / Claude Code" "10/1" "$(dim "$DAY_MAIN" usage_rollup client_name 'Claude Code')"
# languages and targets are JSON arrays: one row per element, counted once per event.
is "language / index / typescript (unnested, 2 events)" "2/2" "$(dim "$DAY_MAIN" index language typescript)"
is "language / index / go (unnested, 1 event)" "1/1" "$(dim "$DAY_MAIN" index language go)"
is "target / install / claude (unnested, 2 events)" "2/2" "$(dim "$DAY_MAIN" install target claude)"
is "target / install / cursor" "1/1" "$(dim "$DAY_MAIN" install target cursor)"
is "target / uninstall / claude" "1/1" "$(dim "$DAY_MAIN" uninstall target claude)"
# Only groups with at least one error are stored, so machines = machines that saw one.
is "name_error / usage_rollup / codegraph_explore" "2/1" "$(dim "$DAY_MAIN" usage_rollup name_error codegraph_explore)"
is "no dimension row for a machine with no errors" "" "$(dim "$DAY_MAIN" usage_rollup name_error nothing)"
is "40 dimension rows in total (no strays, no doubles)" 40 \
   "$(q "select count(*) from daily_dim_counts where day='$DAY_MAIN'")"

# Independent of the hand-computed numbers: recompute two of them straight off `events`.
echo
echo "cross-check against the raw events"
is "machines matches count(distinct machine_id)" \
   "$(q "select count(distinct machine_id) from events where day='$DAY_MAIN' and event='index'")" \
   "$(q "select machines from daily_event_counts where day='$DAY_MAIN' and event='index'")"
is "usage count matches sum(props.count)" \
   "$(q "select sum(json_extract(props,'\$.count')) from events where day='$DAY_MAIN' and event='usage_rollup'")" \
   "$(q "select count from daily_event_counts where day='$DAY_MAIN' and event='usage_rollup'")"

echo
echo "reset"
is "?reset=1 drops a rollup row whose dimension no longer exists" 0 \
   "$(q "select count(*) from daily_dim_counts where day='$DAY_RESET' and dim='obsolete_dim'")"
is "…and recomputes the day correctly" "1/1" "$(dim "$DAY_RESET" index language python)"
is "…leaving exactly the 7 dimensions that day has" 7 \
   "$(q "select count(*) from daily_dim_counts where day='$DAY_RESET'")"

echo
echo "retention purge"
is "raw events past the window are gone" 0 "$(q "select count(*) from events where day='$DAY_OLD'")"
is "nothing older than the cutoff survives" 0 "$(q "select count(*) from events where day<'$CUTOFF'")"
is "events inside the window are untouched" 7 "$(q "select count(*) from events where day='$DAY_MAIN'")"
is "machine_days is NOT purged (retention cohorts need it)" 1 \
   "$(q "select count(*) from machine_days where day='$DAY_OLD'")"
is "machine_first_seen is NOT purged" "$DAY_OLD" \
   "$(q "select first_day from machine_first_seen where machine_id='99999999-9999-4999-8999-999999999999'")"

echo
echo "rollups outlive the events they came from"
is "daily_event_counts survives the purge" "1/1" \
   "$(q "select count||'/'||machines from daily_event_counts where day='$DAY_OLD' and event='index'")"
is "daily_dim_counts survives the purge" "1/1" "$(dim "$DAY_OLD" index language rust)"
is "…all 14 rows of it, even after a reset run over the purged day" 14 \
   "$(q "select count(*) from daily_dim_counts where day='$DAY_OLD'")"
is "daily_machines is still rebuilt for a purged day (machine_days survives)" "1/1" \
   "$(q "select machines||'/'||prod_machines from daily_machines where day='$DAY_OLD'")"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
