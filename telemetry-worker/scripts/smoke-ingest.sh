#!/usr/bin/env bash
# End-to-end check of the ingest contract against a real `wrangler dev` + local D1.
#
# Boots the worker, POSTs a spread of good and bad batches, then shuts the worker
# down and inspects the rows that actually landed. Every request uses a fresh
# machine_id, so the script is re-runnable against a dirty local database and never
# trips the per-machine rate limit.
#
#   npm run db:migrate:local   # once
#   npm run smoke              # or: INGEST_PORT=8791 ./scripts/smoke-ingest.sh
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${INGEST_PORT:-8787}"
BASE="http://127.0.0.1:$PORT"
DB=codegraph-telemetry

pass=0; fail=0
ok()   { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad()  { fail=$((fail + 1)); printf '  FAIL %s — expected %s, got %s\n' "$1" "$2" "$3"; }
is()   { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }

uuid() { node -e 'console.log(crypto.randomUUID())'; }

# HTTP status of a POST /v1/events with the given body.
post() { curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/events" \
           -H 'content-type: application/json' --data-binary "$1"; }

# First column of the first row of a query against the LOCAL D1 state.
q() {
  npx wrangler d1 execute "$DB" --local --json --command "$1" 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const r=JSON.parse(s.slice(s.indexOf("[")))[0]?.results?.[0];
      console.log(r===undefined?"":String(Object.values(r)[0]));})'
}

# ---------------------------------------------------------------------------
# Boot
# ---------------------------------------------------------------------------
echo "applying migrations to local D1"
npx wrangler d1 migrations apply "$DB" --local >/dev/null 2>&1

echo "booting wrangler dev on :$PORT"
npx wrangler dev --port "$PORT" >/tmp/cg-smoke-ingest.log 2>&1 &
DEV_PID=$!
cleanup() { kill "$DEV_PID" 2>/dev/null || true; wait "$DEV_PID" 2>/dev/null || true; }
trap cleanup EXIT

for _ in $(seq 1 60); do
  curl -sf -o /dev/null "$BASE/" && break
  kill -0 "$DEV_PID" 2>/dev/null || { echo "wrangler dev died:"; cat /tmp/cg-smoke-ingest.log; exit 1; }
  sleep 1
done
curl -sf -o /dev/null "$BASE/" || { echo "worker never came up:"; cat /tmp/cg-smoke-ingest.log; exit 1; }

# ---------------------------------------------------------------------------
# Request contract
# ---------------------------------------------------------------------------
echo
echo "request contract"

INFO=$(curl -s "$BASE/")
case "$INFO" in *"codegraph anonymous-telemetry ingest"*) ok "GET / serves the info text";;
  *) bad "GET / serves the info text" "info text" "$INFO";; esac
case "$INFO" in *"never forwarded to any third-party analytics"*) ok "info text states the storage guarantee";;
  *) bad "info text states the storage guarantee" "the no-third-party sentence" "missing";; esac
# The guarantee above holds only while the worker makes no outbound request at all,
# so the only `fetch(` anywhere in the source may be the handler's own declaration.
is "worker source makes no outbound fetch" 0 \
   "$(grep -E 'fetch\(' src/*.ts | grep -vc 'async fetch(request' || true)"

is "unknown path → 404" 404 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/nope")"
is "GET /v1/events → 405" 405 "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/events")"
is "non-JSON body → 400" 400 "$(post 'not json')"
is "JSON array body → 400" 400 "$(post '[]')"
is "missing machine_id → 400" 400 "$(post '{"events":[]}')"
is "malformed machine_id → 400" 400 "$(post '{"machine_id":"nope","events":[]}')"
is "chunked (no length) → 411" 411 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/v1/events" \
     -H 'content-type: application/json' -H 'transfer-encoding: chunked' --data-binary '{"machine_id":"x"}')"
BIG=$(node -e 'process.stdout.write(JSON.stringify({machine_id:"00000000-0000-4000-8000-000000000000",pad:"x".repeat(70000),events:[]}))')
is "oversized body → 413" 413 "$(post "$BIG")"

# ---------------------------------------------------------------------------
# Accepted batches
# ---------------------------------------------------------------------------
echo
echo "ingest"

M_OK=$(uuid); M_DROP=$(uuid); M_CI=$(uuid); M_BACK=$(uuid); M_USE=$(uuid)
TODAY=$(date -u +%F)
# Client timestamps older than 30 days are rejected at ingest, so the dated events
# here are relative to today — fixed dates rot into "too old" a month after writing.
day_ago() { node -e 'console.log(new Date(Date.now()-process.argv[1]*864e5).toISOString().slice(0,10))' "$1"; }
RECENT_DAY=$(day_ago 2)
BACK_DAY=$(day_ago 9)

# Three valid events + one unknown event + unknown/malformed props that must be stripped.
is "valid batch → 204" 204 "$(post "$(node -e '
const [m, day] = process.argv.slice(1);
process.stdout.write(JSON.stringify({
  machine_id: m, codegraph_version: "1.5.0", os: "darwin", arch: "arm64",
  node_major: 22, ci: false, schema_version: 1, secret_field: "must not be stored",
  events: [
    { event: "install", ts: `${day}T10:00:00Z`,
      props: { scope: "local", kind: "fresh", targets: ["claude", "cursor"], nope: "strip me" } },
    { event: "index", ts: `${day}T10:01:00Z`,
      props: { languages: ["typescript"], file_count_bucket: "100-1k",
               duration_bucket: "bogus-bucket", repo_path: "/Users/someone/secret" } },
    { event: "usage_rollup",
      props: { kind: "mcp_tool", name: "codegraph_explore", count: 12, client_name: "Claude Code" } },
    { event: "not_an_event", props: { count: 1 } },
  ],
}));' "$M_OK" "$RECENT_DAY")")"

# Nothing survives the allowlist: unknown event + usage_rollup missing required props.
is "all-dropped batch → 204" 204 "$(post "$(node -e '
const [m] = process.argv.slice(1);
process.stdout.write(JSON.stringify({ machine_id: m, os: "linux", events: [
  { event: "made_up" },
  { event: "usage_rollup", props: { kind: "mcp_tool" } },
  { event: "install", props: { scope: "local" } },
]}));' "$M_DROP")")"

# Usage counters ADD into one row per machine × day × tool — what old clients send
# is the same `count: 1` line once per process, many times over. Two batches: the
# first repeats one counter three times (one of them an error) beside a second tool,
# the second sends the first counter again.
USAGE_A=$(node -e '
const [m] = process.argv.slice(1);
const explore = (errors) => ({ event: "usage_rollup",
  props: { kind: "mcp_tool", name: "codegraph_explore", count: 1, error_count: errors, client_name: "Claude Code" } });
process.stdout.write(JSON.stringify({ machine_id: m, os: "darwin", events: [
  explore(0), explore(1), explore(0),
  { event: "usage_rollup", props: { kind: "cli_command", name: "index", count: 2, error_count: 0 } },
]}));' "$M_USE")
USAGE_B=$(node -e '
const [m] = process.argv.slice(1);
process.stdout.write(JSON.stringify({ machine_id: m, os: "darwin", events: [
  { event: "usage_rollup", props: { kind: "mcp_tool", name: "codegraph_explore", count: 1, error_count: 0, client_name: "Claude Code" } },
]}));' "$M_USE")
is "usage batch → 204" 204 "$(post "$USAGE_A")"
is "the same counter again → 204" 204 "$(post "$USAGE_B")"

# NOTE: build every body into a variable first. Escaped quotes nested inside
# "$(post "…\"…\"…")" break out of the quoting context and get brace-expanded.
index_batch() {  # <machine_id> [ci] [ts]
  node -e 'const [m, ci, ts] = process.argv.slice(1);
    const e = { event: "index", props: {} };
    if (ts) e.ts = ts;
    const b = { machine_id: m, os: "linux", events: [e] };
    if (ci) b.ci = ci === "true";
    process.stdout.write(JSON.stringify(b));' "$@"
}

# ci = true, then a non-CI batch for the same machine/day: prod must flip 0 → 1.
CI_ON=$(index_batch "$M_CI" true); CI_OFF=$(index_batch "$M_CI" false)
is "ci batch → 204" 204 "$(post "$CI_ON")"
is "same machine, non-ci → 204" 204 "$(post "$CI_OFF")"

# A late offline buffer arriving second must move first_day EARLIER, never later.
RECENT=$(index_batch "$M_BACK" "" "${RECENT_DAY}T09:00:00Z")
BACKDATED=$(index_batch "$M_BACK" "" "${BACK_DAY}T09:00:00Z")
is "recent batch → 204" 204 "$(post "$RECENT")"
is "backdated batch → 204" 204 "$(post "$BACKDATED")"

sleep 2          # let the ctx.waitUntil writes drain
cleanup; trap - EXIT
sleep 1          # and let miniflare release the local sqlite file

# ---------------------------------------------------------------------------
# What actually got stored
# ---------------------------------------------------------------------------
echo
echo "stored rows"

is "lifecycle events land in events (usage and the unknown event do not)" 2 \
   "$(q "select count(*) from events where machine_id='$M_OK'")"
is "the usage counter lands in usage_daily" "codegraph_explore|mcp_tool|12|0|Claude Code" \
   "$(q "select name||'|'||kind||'|'||count||'|'||error_count||'|'||client_name from usage_daily where machine_id='$M_OK'")"
is "…carrying the batch's envelope" "1.5.0|darwin|arm64|22" \
   "$(q "select codegraph_version||'|'||os||'|'||arch||'|'||node_major from usage_daily where machine_id='$M_OK'")"
is "all-dropped batch stored nothing" 0 "$(q "select count(*) from events where machine_id='$M_DROP'")"
is "…and no machine_days row for it" 0 "$(q "select count(*) from machine_days where machine_id='$M_DROP'")"
is "envelope columns land in their own columns" "darwin|arm64|22|0|1.5.0" \
   "$(q "select os||'|'||arch||'|'||node_major||'|'||ci||'|'||codegraph_version from events where machine_id='$M_OK' limit 1")"
is "day derived from the client ts" "$RECENT_DAY" \
   "$(q "select day from events where machine_id='$M_OK' and event='install'")"
is "day falls back to received_at when ts is absent" "$TODAY" \
   "$(q "select day from usage_daily where machine_id='$M_OK'")"
is "ts is NULL when the client sent none" 1 \
   "$(q "select ts is null from events where machine_id='$M_CI' limit 1")"
is "allowlisted props stored" "local|fresh|2" \
   "$(q "select json_extract(props,'\$.scope')||'|'||json_extract(props,'\$.kind')||'|'||json_array_length(props,'\$.targets') from events where machine_id='$M_OK' and event='install'")"
is "unknown prop stripped" 0 \
   "$(q "select count(*) from events where machine_id='$M_OK' and props like '%strip me%'")"
is "malformed enum prop stripped" 0 \
   "$(q "select count(*) from events where machine_id='$M_OK' and props like '%bogus-bucket%'")"
is "path-shaped prop stripped" 0 \
   "$(q "select count(*) from events where machine_id='$M_OK' and props like '%/Users/%'")"
is "unknown envelope field stored nowhere" 0 \
   "$(q "select count(*) from events where props like '%must not be stored%'")"

# The valid batch mixes ts-dated events ($RECENT_DAY) with an undated rollup (today),
# so it legitimately spans two days and must produce a machine_days row for each.
is "machine_days: one row per distinct day in the batch" 2 \
   "$(q "select count(*) from machine_days where machine_id='$M_OK'")"
is "machine_days: non-ci machine is production" 1 \
   "$(q "select min(prod) from machine_days where machine_id='$M_OK'")"
is "machine_days: a later non-ci batch flips the day to production" 1 \
   "$(q "select prod from machine_days where machine_id='$M_CI'")"
is "machine_days: each backdated batch gets its own day" "$BACK_DAY,$RECENT_DAY" \
   "$(q "select group_concat(day) from (select day from machine_days where machine_id='$M_BACK' order by day)")"

is "machine_first_seen recorded" "$RECENT_DAY" "$(q "select first_day from machine_first_seen where machine_id='$M_OK'")"
is "machine_first_seen only moves earlier" "$BACK_DAY" \
   "$(q "select first_day from machine_first_seen where machine_id='$M_BACK'")"
# The activation funnel's input is kept here too, not only by the nightly rollup: an
# index run that uploads after the cron stopped re-rolling its day must still count.
is "first_index_day recorded as the index run is stored" "$RECENT_DAY" \
   "$(q "select first_index_day from machine_first_seen where machine_id='$M_OK'")"
is "first_index_day only moves earlier, like first_day" "$BACK_DAY" \
   "$(q "select first_index_day from machine_first_seen where machine_id='$M_BACK'")"
is "a machine that never sent an index run has none" "null" \
   "$(q "select coalesce(first_index_day, 'null') from machine_first_seen where machine_id='$M_USE'")"

echo
echo "usage counters add up instead of piling up"
is "no usage row ever lands in events" 0 "$(q "select count(*) from events where event='usage_rollup' and machine_id='$M_USE'")"
is "one row per tool, however many uploads" 2 "$(q "select count(*) from usage_daily where machine_id='$M_USE'")"
is "repeats within a batch and across batches are summed" "4/1" \
   "$(q "select count||'/'||error_count from usage_daily where machine_id='$M_USE' and name='codegraph_explore'")"
is "…and a different tool keeps its own count" "2/0" \
   "$(q "select count||'/'||error_count from usage_daily where machine_id='$M_USE' and name='index'")"
is "an absent client name is stored as empty, not NULL (it is part of the key)" "" \
   "$(q "select client_name from usage_daily where machine_id='$M_USE' and name='index'")"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
