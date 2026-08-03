#!/usr/bin/env bash
# End-to-end check of the chart API against the committed fixture.
#
# Every expected number below is worked out by hand from scripts/fixture.sql —
# the header comment there lists all twelve machines and what each one does — so
# a failure here means the SQL changed its mind, not that a golden file drifted.
#
#   ./scripts/smoke-api.sh          (or: npm run smoke:api)
set -uo pipefail

cd "$(dirname "$0")/.."

# Deliberately NOT $PORT — see smoke-auth.sh.
DASH_PORT="${DASH_PORT:-8789}"
BASE="http://127.0.0.1:${DASH_PORT}"
PASSWORD="$(grep '^ADMIN_PASSWORD=' .dev.vars | cut -d'"' -f2)"
JAR="$(mktemp -t cg-api-jar)"
LOG="$(mktemp -t cg-api-log)"
PASS=0
FAIL=0

# The fixture's own window. Every assertion is scoped to it, so a later fixture
# row outside these days cannot silently change an expected number.
FROM=2026-07-01
TO=2026-07-10
RANGE="from=$FROM&to=$TO"

cleanup() {
  [[ -n "${DEV_PID:-}" ]] && kill "$DEV_PID" 2>/dev/null
  rm -f "$JAR" "$LOG"
}
trap cleanup EXIT

status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
get() { curl -s -b "$JAR" "$BASE$1"; }

# Resolves a dotted path through the JSON. Numeric segments index arrays, so
# `datasets.0.data` works. Node rather than jq: this is a Node project, jq is not.
jget() {
  node -e '
    let v = JSON.parse(process.argv[1]);
    for (const key of process.argv[2].split(".")) v = v?.[key];
    console.log(v === undefined ? "<missing>" : typeof v === "object" && v !== null ? JSON.stringify(v) : String(v));
  ' "$1" "$2"
}

check() { # check <description> <expected> <actual>
  if [[ "$2" == "$3" ]]; then
    printf '  ok    %s\n' "$1"
    PASS=$((PASS + 1))
  else
    printf '  FAIL  %s (expected %s, got %s)\n' "$1" "$2" "$3"
    FAIL=$((FAIL + 1))
  fi
}

field() { # field <description> <path> <expected> <json>
  check "$1" "$3" "$(jget "$4" "$2")"
}

echo "Seeding the local D1 fixture…"
./scripts/seed-fixture.sh || exit 1

echo "Starting wrangler dev on :${DASH_PORT}…"
npx wrangler dev --port "$DASH_PORT" --ip 127.0.0.1 >"$LOG" 2>&1 &
DEV_PID=$!
READY=""
for _ in $(seq 1 90); do
  if [[ "$(curl -s "$BASE/robots.txt")" == "User-agent: *"* ]]; then READY=1; break; fi
  sleep 1
done
if [[ -z "$READY" ]]; then
  echo "wrangler dev never came up on :${DASH_PORT} — log follows"
  cat "$LOG"
  exit 1
fi

echo
echo "The gate still holds on every new endpoint"
for path in summary meta timeseries breakdown activation retention; do
  check "GET /api/$path without a cookie → 401" 401 "$(status "$BASE/api/$path")"
done

curl -s -o /dev/null -c "$JAR" -X POST -d "password=$PASSWORD" "$BASE/login"
check "signed in" 200 "$(status -b "$JAR" "$BASE/api/session")"

echo
echo "Caching"
check "chart data is privately cacheable" "private, max-age=300" \
  "$(curl -sD - -o /dev/null -b "$JAR" "$BASE/api/summary" | grep -i '^cache-control:' | cut -d' ' -f2- | tr -d '\r')"
check "health stays uncached" "no-store" \
  "$(curl -sD - -o /dev/null -b "$JAR" "$BASE/api/health" | grep -i '^cache-control:' | cut -d' ' -f2- | tr -d '\r')"

echo
echo "/api/meta — what the range picker anchors on"
META="$(get "/api/meta")"
field "latest day"        latest_day       2026-07-10 "$META"
field "earliest day"      earliest_day     2026-07-01 "$META"
field "raw events start"  earliest_raw_day 2026-07-01 "$META"
field "retention window"  retention_days   14         "$META"

echo
echo "/api/summary — the big numbers (12 machines, one of them CI)"
SUMMARY="$(get "/api/summary?$RANGE")"
field "production users (m12 is CI)" production_users 11 "$SUMMARY"
field "active machines"              active_machines  12 "$SUMMARY"
field "new machines"                 new_machines     12 "$SUMMARY"
field "installs"                     installs         12 "$SUMMARY"
field "uninstalls"                   uninstalls        2 "$SUMMARY"
field "indexing runs"                index_runs       13 "$SUMMARY"
field "tool calls (SUM of count)"    tool_calls       85 "$SUMMARY"
field "range echoed back"            range.days       10 "$SUMMARY"

echo
echo "/api/timeseries — one dense point per day, zeros where nothing happened"
TS="$(get "/api/timeseries?metric=installs_uninstalls&$RANGE")"
field "10 labels"      labels.0        2026-07-01                 "$TS"
field "installs"       datasets.0.data '[4,2,1,0,2,0,0,1,2,0]'    "$TS"
field "uninstalls"     datasets.1.data '[0,0,0,0,0,1,1,0,0,0]'    "$TS"
field "legend labels"  datasets.1.label Uninstalls                "$TS"

TS="$(get "/api/timeseries?metric=new_installs&$RANGE")"
field "new installs by first-seen day" datasets.0.data '[4,2,1,0,2,0,0,1,2,0]' "$TS"

TS="$(get "/api/timeseries?metric=production_users&$RANGE")"
field "daily production users" datasets.0.data '[4,3,4,1,2,3,2,1,1,1]' "$TS"

TS="$(get "/api/timeseries?metric=indexing_activity&$RANGE")"
field "indexing runs"     datasets.0.data '[2,2,2,1,1,1,1,1,1,1]' "$TS"
field "machines indexing" datasets.1.data '[2,2,2,1,1,1,1,1,1,1]' "$TS"

TS="$(get "/api/timeseries?metric=tool_calls&$RANGE")"
field "calls per day"     datasets.0.data '[0,40,28,0,0,12,0,0,0,5]' "$TS"
field "machines per day"  datasets.1.data '[0,1,2,0,0,1,0,0,0,1]'    "$TS"

TS="$(get "/api/timeseries?metric=duration_buckets&$RANGE")"
field "bucket order is the scale" datasets.0.label '<10s'                  "$TS"
field "…and ends at the longest"  datasets.3.label '5m+'                   "$TS"
field "<10s over time"            datasets.0.data  '[2,0,1,1,0,0,0,1,0,0]' "$TS"
field "10-60s over time"          datasets.1.data  '[0,2,0,0,0,0,1,0,0,1]' "$TS"
field "1-5m over time"            datasets.2.data  '[0,0,0,0,1,1,0,0,0,0]' "$TS"
field "5m+ over time"             datasets.3.data  '[0,0,1,0,0,0,0,0,1,0]' "$TS"

echo
echo "/api/breakdown — bars and pies"
# machine-days, taking the largest per-event count per day so one machine's
# install + index + usage_rollup on one day is not counted three times.
BD="$(get "/api/breakdown?dim=os&$RANGE")"
field "os labels"        labels          '["linux","darwin","win32"]' "$BD"
field "os machine-days"  datasets.0.data '[9,8,4]'                    "$BD"
field "os metric named"  datasets.0.label 'Machine-days'              "$BD"
field "os total"         total           21                           "$BD"

BD="$(get "/api/breakdown?dim=os&metric=count&$RANGE")"
field "os by events sums every event" total 112 "$BD"

BD="$(get "/api/breakdown?dim=language&$RANGE")"
field "languages, most-indexed first" labels '["typescript","csharp","go","javascript","python","rust","java"]' "$BD"
field "language counts"               datasets.0.data '[7,2,2,2,2,2,1]' "$BD"
field "language rows total"           total 18 "$BD"

BD="$(get "/api/breakdown?dim=file_count_bucket&$RANGE")"
field "codebase size keeps bucket order" labels '["<100","100-1k","1k-10k","10k+"]' "$BD"
field "codebase size counts"             datasets.0.data '[2,5,4,2]' "$BD"

BD="$(get "/api/breakdown?dim=duration_bucket&$RANGE")"
field "run length keeps bucket order" labels '["<10s","10-60s","1-5m","5m+"]' "$BD"
field "run length counts"             datasets.0.data '[5,4,2,2]' "$BD"
field "run length total = index runs" total 13 "$BD"

BD="$(get "/api/breakdown?dim=target&$RANGE")"
field "agent targets are the installs" event install "$BD"
field "agent target labels" labels '["claude","cursor","codex","opencode"]' "$BD"
field "agent target counts" datasets.0.data '[9,3,2,1]' "$BD"

BD="$(get "/api/breakdown?dim=codegraph_version&$RANGE")"
field "versions sort newest first" labels '["1.5.0","1.4.1","1.4.0"]' "$BD"
field "version machine-days"       datasets.0.data '[8,3,10]' "$BD"

BD="$(get "/api/breakdown?dim=name&$RANGE")"
field "tool names by call volume" labels '["codegraph_explore","index"]' "$BD"
field "tool call counts"          datasets.0.data '[82,3]' "$BD"

BD="$(get "/api/breakdown?dim=client_name&$RANGE")"
field "agents by call volume" labels '["Claude Code","Cursor"]' "$BD"
field "agent call counts"     datasets.0.data '[70,12]' "$BD"

BD="$(get "/api/breakdown?dim=kind&$RANGE")"
field "install kinds" labels '["fresh","upgrade"]' "$BD"
field "install kind counts" datasets.0.data '[11,1]' "$BD"

BD="$(get "/api/breakdown?dim=scope&$RANGE")"
field "install scopes" datasets.0.data '[9,3]' "$BD"

BD="$(get "/api/breakdown?dim=name_error&$RANGE")"
field "errors by tool" datasets.0.data '[1]' "$BD"

BD="$(get "/api/breakdown?dim=language&limit=2&$RANGE")"
field "the tail folds into Other, never truncates" labels '["typescript","csharp","Other"]' "$BD"
field "Other keeps the total honest" total 18 "$BD"
field "truncation is declared"       truncated true "$BD"

echo
echo "/api/activation — install → first index within 7 days"
ACT="$(get "/api/activation?$RANGE")"
field "cohort is every machine first seen" installs  12 "$ACT"
field "m04 and m06 never indexed"          activated 10 "$ACT"
field "…so two dropped"                    dropped    2 "$ACT"
field "window"                             window_days 7 "$ACT"
field "daily rate, null where no cohort"   datasets.0.data '[75,50,100,null,100,null,null,100,100,null]' "$ACT"
field "recent cohorts flagged incomplete"  incomplete_from 2026-07-04 "$ACT"
field "…and the completed ones are not"    rows.2.complete true "$ACT"
field "…while the last week is"            rows.8.complete false "$ACT"

# Narrowing the window drops m03 alone: it installed on 07-01 and did not index
# until 07-03. Everyone else who ever indexed did it on day 0 or day 1.
ACT="$(get "/api/activation?window=1&$RANGE")"
field "a 1-day window converts fewer" activated 9 "$ACT"

echo
echo "/api/retention — day 0–14, denominator per day"
RET="$(get "/api/retention?$RANGE")"
field "cohort size"     cohort 12 "$RET"
field "15 points"       labels.14 'Day 14' "$RET"
# Day 2 divides by 10, not 12: m11/m12 arrived on 07-09 and cannot have a day-2
# data point yet. Day 10+ is null — nobody in the cohort is old enough at all.
field "retention curve" datasets.0.data \
  '[100,41.7,30,11.1,0,22.2,0,0,0,0,null,null,null,null,null]' "$RET"
field "day 2 eligible excludes the newest cohorts" rows.2.eligible 10 "$RET"
field "day 10 has nobody old enough"               rows.10.eligible 0 "$RET"

echo
echo "Bad input is rejected, never guessed at"
check "unknown dim → 400"        400 "$(status -b "$JAR" "$BASE/api/breakdown?dim=machine_id")"
check "missing dim → 400"        400 "$(status -b "$JAR" "$BASE/api/breakdown")"
check "unknown metric → 400"     400 "$(status -b "$JAR" "$BASE/api/breakdown?dim=os&metric=secrets")"
check "unknown series → 400"     400 "$(status -b "$JAR" "$BASE/api/timeseries?metric=everything")"
check "limit out of range → 400" 400 "$(status -b "$JAR" "$BASE/api/breakdown?dim=os&limit=0")"
check "impossible date → 400"    400 "$(status -b "$JAR" "$BASE/api/summary?from=2026-02-31&to=2026-07-10")"
check "malformed date → 400"     400 "$(status -b "$JAR" "$BASE/api/summary?from=yesterday")"
check "backwards range → 400"    400 "$(status -b "$JAR" "$BASE/api/summary?from=2026-07-10&to=2026-07-01")"
check "window out of range → 400" 400 "$(status -b "$JAR" "$BASE/api/activation?window=99")"
check "unknown endpoint → 404"   404 "$(status -b "$JAR" "$BASE/api/everything")"
check "event name is a closed shape → 400" 400 \
  "$(status -b "$JAR" "$BASE/api/breakdown?dim=os&event=install%27%20OR%201=1")"

CLAMPED="$(get "/api/breakdown?dim=os&from=2019-01-01&to=$TO")"
field "a decade-wide range clamps to a year" range.days 366  "$CLAMPED"
field "…and says so"                         range.clamped true "$CLAMPED"
field "…kept against the recent end"         range.from 2025-07-10 "$CLAMPED"

echo
echo "An empty range renders as empty, not as an error"
EMPTY="$(get "/api/summary?from=2025-01-01&to=2025-01-07")"
field "no machines"     production_users 0 "$EMPTY"
field "no installs"     installs 0 "$EMPTY"
EMPTY="$(get "/api/breakdown?dim=os&from=2025-01-01&to=2025-01-07")"
field "no bars"         labels '[]' "$EMPTY"
EMPTY="$(get "/api/timeseries?metric=production_users&from=2025-01-01&to=2025-01-03")"
field "still a dense axis" datasets.0.data '[0,0,0]' "$EMPTY"

echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
