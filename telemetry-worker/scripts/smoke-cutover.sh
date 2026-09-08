#!/usr/bin/env bash
# The cutover gate (CG-14): drives the WHOLE chain the way production will run it —
# a client POSTs a batch, the ingest worker writes D1, the nightly rollup aggregates,
# and the dashboard reads the numbers back out.
#
# Every other suite tests one link. smoke-ingest.sh stops at the `events` table,
# smoke-rollup.sh hand-checks the rollup SQL, and smoke-api.sh reads a fixture that
# was written by hand rather than by the cron. That leaves exactly the seam this
# cutover turns on unverified: the dimension names the rollup WRITES versus the ones
# the dashboard READS. Those two lists live in different workers on different
# branches, and a mismatch is silent — no error, no failed request, just a panel that
# renders zero forever. Catching that after cutover means a day of lost telemetry;
# catching it here costs a minute.
#
# Both workers declare the same D1 `database_id`, so pointing them at one
# `--persist-to` directory gives them literally the same local SQLite file. The state
# is a fresh mktemp each run, so every expected number below is exact rather than a
# lower bound.
#
#   npm run smoke:cutover
#
# Expected numbers are derived from THE_BATCH below and nothing else; see the table
# in that comment block.
set -uo pipefail

cd "$(dirname "$0")/.."
WORKER_DIR="$PWD"
DASH_DIR="$(cd .. && pwd)/telemetry-dashboard"

[ -d "$DASH_DIR" ] || { echo "cannot find telemetry-dashboard/ next to telemetry-worker/"; exit 1; }

INGEST_PORT="${CUTOVER_INGEST_PORT:-8795}"
DASH_PORT="${CUTOVER_DASH_PORT:-8796}"
INGEST="http://127.0.0.1:$INGEST_PORT"
DASH="http://127.0.0.1:$DASH_PORT"

# Test-only credentials. The point is to exercise the wiring, not to keep a secret.
ADMIN_TOKEN=cutover-admin-token
DASH_PASSWORD=cutover-dashboard-password
SESSION_SECRET=cutover-session-secret

STATE="$(mktemp -d -t cg-cutover-state)"
JAR="$(mktemp -t cg-cutover-jar)"
ILOG=/tmp/cg-cutover-ingest.log
DLOG=/tmp/cg-cutover-dash.log

pass=0; fail=0
ok()  { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s — expected %s, got %s\n' "$1" "$2" "$3"; }
is()  { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }

DEV_PID=""
stop_dev() {
  [ -n "$DEV_PID" ] || return 0
  kill "$DEV_PID" 2>/dev/null
  wait "$DEV_PID" 2>/dev/null
  DEV_PID=""
}
cleanup() { stop_dev; rm -rf "$STATE" "$JAR"; }
trap cleanup EXIT

# Boot a worker in <dir> on <port> against the SHARED state, wait for <readyurl>.
boot() { # boot <dir> <port> <readyurl> <log> [extra wrangler args...]
  local dir="$1" port="$2" ready="$3" log="$4"; shift 4
  ( cd "$dir" && exec npx wrangler dev --port "$port" --ip 127.0.0.1 \
      --persist-to "$STATE" "$@" ) >"$log" 2>&1 &
  DEV_PID=$!
  for _ in $(seq 1 90); do
    curl -sf -o /dev/null "$ready" && return 0
    kill -0 "$DEV_PID" 2>/dev/null || break
    sleep 1
  done
  echo "worker in $dir never came up on :$port — log follows"; cat "$log"; exit 1
}

# Resolve a dotted path through a JSON document. Numeric segments index arrays.
jget() {
  node -e '
    let v = JSON.parse(process.argv[1]);
    for (const k of process.argv[2].split(".")) v = v?.[k];
    console.log(v === undefined ? "<missing>" : typeof v === "object" && v !== null ? JSON.stringify(v) : String(v));
  ' "$1" "$2"
}

day_ago() { node -e 'console.log(new Date(Date.now()-process.argv[1]*864e5).toISOString().slice(0,10))' "$1"; }

# Inside the ingest clamp window (30 days) and outside the cron's 3-day lookback.
DAY="$(day_ago 5)"
RANGE="from=$DAY&to=$DAY"

# ---------------------------------------------------------------------------
# THE_BATCH — three machines, one day. Everything asserted below follows from here.
#
#   machine  os      arch   node  version  ci     events
#   m1       darwin  arm64  22    1.5.0    false  install(local/fresh, [claude,cursor])
#                                                 index([typescript,python], 100-1k, 10-60s)
#                                                 usage_rollup(codegraph_explore x12, Claude Code)
#   m2       linux   x64    20    1.5.0    false  install(global/upgrade, [codex])
#                                                 index([typescript], 1k-10k, 1-5m)
#                                                 usage_rollup(codegraph_explore x8, Codex CLI)
#   m3       linux   arm64  22    1.4.1    TRUE   index([go], <100, <10s)
#                                                 uninstall([claude])
#
# The three deliberate traps:
#   * m3 is ci=true, so it counts as active but NOT as a production user.
#   * tool_calls must SUM the `count` prop (12 + 8 = 20), not count the 2 rows.
#   * m3's uninstall carries targets=[claude], so a `target` breakdown that forgets
#     to scope by event would report claude twice.
# ---------------------------------------------------------------------------
M1=11111111-1111-4111-8111-111111111111
M2=22222222-2222-4222-8222-222222222222
M3=33333333-3333-4333-8333-333333333333

post_batch() { # post_batch <json>
  curl -s -o /dev/null -w '%{http_code}' -X POST "$INGEST/v1/events" \
    -H 'content-type: application/json' --data-binary "$1"
}

batch() { # batch <machine> <os> <arch> <node> <version> <ci> <events-json>
  node -e '
    const [m, os, arch, node_major, v, ci, events, day] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({
      machine_id: m, codegraph_version: v, os, arch,
      node_major: Number(node_major), ci: ci === "true", schema_version: 1,
      events: JSON.parse(events).map((e) => ({ ...e, ts: `${day}T12:00:00Z` })),
    }));
  ' "$@" "$DAY"
}

# ---------------------------------------------------------------------------
echo "cutover chain: client → ingest worker → D1 → rollup → dashboard"
echo
echo "migrating the shared local D1 state"
( cd "$WORKER_DIR" && npx wrangler d1 migrations apply codegraph-telemetry \
    --local --persist-to "$STATE" ) >/tmp/cg-cutover-migrate.log 2>&1 ||
  { echo "migration failed:"; cat /tmp/cg-cutover-migrate.log; exit 1; }

echo "booting the ingest worker on :$INGEST_PORT"
boot "$WORKER_DIR" "$INGEST_PORT" "$INGEST/" "$ILOG" --var "ADMIN_TOKEN:$ADMIN_TOKEN"

echo
echo "ingest accepts the batch"
is "m1 batch → 204" 204 "$(post_batch "$(batch "$M1" darwin arm64 22 1.5.0 false '[
  {"event":"install","props":{"scope":"local","kind":"fresh","targets":["claude","cursor"]}},
  {"event":"index","props":{"languages":["typescript","python"],"file_count_bucket":"100-1k","duration_bucket":"10-60s"}},
  {"event":"usage_rollup","props":{"kind":"mcp_tool","name":"codegraph_explore","count":12,"client_name":"Claude Code"}}
]')")"
is "m2 batch → 204" 204 "$(post_batch "$(batch "$M2" linux x64 20 1.5.0 false '[
  {"event":"install","props":{"scope":"global","kind":"upgrade","targets":["codex"]}},
  {"event":"index","props":{"languages":["typescript"],"file_count_bucket":"1k-10k","duration_bucket":"1-5m"}},
  {"event":"usage_rollup","props":{"kind":"mcp_tool","name":"codegraph_explore","count":8,"client_name":"Codex CLI"}}
]')")"
is "m3 (ci) batch → 204" 204 "$(post_batch "$(batch "$M3" linux arm64 22 1.4.1 true '[
  {"event":"index","props":{"languages":["go"],"file_count_bucket":"<100","duration_bucket":"<10s"}},
  {"event":"uninstall","props":{"targets":["claude"]}}
]')")"

sleep 2   # let the ctx.waitUntil writes drain before rolling up

echo
echo "the nightly rollup aggregates the day"
ROLL=$(curl -s -X POST -H "x-admin-token: $ADMIN_TOKEN" "$INGEST/admin/rollup?day=$DAY")
is "POST /admin/rollup → ok" true "$(jget "$ROLL" ok)"
is "rollup wrote rows" true "$(node -e 'process.stdout.write(String((JSON.parse(process.argv[1]).rows ?? 0) > 0))' "$ROLL")"

stop_dev   # free the D1 lock before the dashboard opens the same file

echo
echo "booting the dashboard on :$DASH_PORT against the same D1"
( cd "$DASH_DIR" && npm run --silent vendor ) >/dev/null 2>&1
boot "$DASH_DIR" "$DASH_PORT" "$DASH/robots.txt" "$DLOG" \
  --var "ADMIN_PASSWORD:$DASH_PASSWORD" --var "SESSION_SECRET:$SESSION_SECRET"

curl -s -o /dev/null -c "$JAR" -X POST "$DASH/login" --data-urlencode "password=$DASH_PASSWORD"
api() { curl -s -b "$JAR" "$DASH/api/$1"; }
is "dashboard session established" 200 "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$DASH/api/health")"

# --- the big numbers -------------------------------------------------------
echo
echo "summary panel reads back what was ingested"
S=$(api "summary?$RANGE")
is "production users (ci machine excluded)" 2 "$(jget "$S" production_users)"
is "active machines"                        3 "$(jget "$S" active_machines)"
is "new machines"                           3 "$(jget "$S" new_machines)"
is "installs"                               2 "$(jget "$S" installs)"
is "uninstalls"                             1 "$(jget "$S" uninstalls)"
is "indexing runs"                          3 "$(jget "$S" index_runs)"
is "tool calls SUM the count prop (12+8)"  20 "$(jget "$S" tool_calls)"

# --- every dimension the dashboard offers ----------------------------------
# This is the actual point of the suite: each of these is a distinct string that
# must match between rollup.ts and api.ts's DIMS registry. An empty `labels` means
# the dashboard is asking for a dimension the cron never writes.
echo
echo "every breakdown dimension resolves against the cron's output"
bd() { # bd <desc> <query> <expected-labels-json> <expected-data-json>
  local body; body=$(api "breakdown?$RANGE&$2")
  is "$1 — labels" "$3" "$(jget "$body" labels)"
  is "$1 — data"   "$4" "$(jget "$body" datasets.0.data)"
}
bd "os"                "dim=os"                '["linux","darwin"]'          '[2,1]'
bd "arch"              "dim=arch"              '["arm64","x64"]'             '[2,1]'
bd "version"           "dim=codegraph_version" '["1.5.0","1.4.1"]'           '[2,1]'
bd "node major"        "dim=node_major"        '["22","20"]'                 '[2,1]'
bd "language"          "dim=language"          '["typescript","go","python"]' '[2,1,1]'
bd "files in project"  "dim=file_count_bucket" '["<100","100-1k","1k-10k","10k+"]' '[1,1,1,0]'
bd "run length"        "dim=duration_bucket"   '["<10s","10-60s","1-5m","5m+"]'    '[1,1,1,0]'
bd "install scope"     "dim=scope"             '["global","local"]'          '[1,1]'
bd "install kind"      "dim=kind"              '["fresh","upgrade"]'         '[1,1]'
bd "tool name"         "dim=name"              '["codegraph_explore"]'       '[20]'
bd "agent"             "dim=client_name"       '["Claude Code","Codex CLI"]' '[12,8]'

# The trap: `target` defaults to event=install, so the uninstall's own claude target
# must NOT be folded in — and must still be reachable by asking for it explicitly.
bd "agent target (install-scoped)" "dim=target" '["claude","codex","cursor"]' '[1,1,1]'
bd "agent target (uninstall)" "dim=target&event=uninstall" '["claude"]' '[1]'

# --- the remaining panels --------------------------------------------------
echo
echo "the timeseries and funnel panels see the day"
# Every entry in api.ts's SERIES registry — each one reads a different rollup table,
# so this is the second half of the write-vs-read seam the breakdowns cover above.
ts() { # ts <desc> <metric> <series-0> [series-1]
  local body; body=$(api "timeseries?$RANGE&metric=$2")
  is "$1 — day"      "[\"$DAY\"]" "$(jget "$body" labels)"
  is "$1 — series"   "$3"         "$(jget "$body" datasets.0.data)"
  [ $# -ge 4 ] && is "$1 — second series" "$4" "$(jget "$body" datasets.1.data)"
}
ts "installs and uninstalls" installs_uninstalls '[2]' '[1]'
ts "new installs"            new_installs        '[3]'
ts "production users"        production_users    '[2]'
ts "indexing activity"       indexing_activity   '[3]' '[3]'
ts "tool calls (sums the prop)" tool_calls       '[20]' '[2]'

MET=$(api "meta")
is "meta anchors on the rolled-up day" "$DAY" "$(jget "$MET" latest_day)"
is "meta reports the rollup ran"       "$DAY" "$(jget "$MET" latest_rollup_day)"

# The funnel is the one panel that reads RAW events rather than a rollup, so it is
# also the one the retention purge can blind — worth pinning that it works today.
#
# Its denominator is FIRST-SEEN MACHINES, not `install` events (api.ts: "a machine
# that reinstalls does not re-enter the funnel"). m3 is the discriminator: it never
# sent an install event, but it is new and it indexed, so it belongs in both legs.
# Reading 2 here would mean the funnel had quietly become an install-event ratio.
ACT=$(api "activation?$RANGE&window=1")
is "funnel counts new machines, not install events" 3 "$(jget "$ACT" installs)"
is "all three indexed within the window"            3 "$(jget "$ACT" activated)"
is "nobody dropped out"                             0 "$(jget "$ACT" dropped)"
is "raw-event floor is reported to the caller" "$DAY" "$(jget "$ACT" raw_events_from)"

is "retention endpoint answers" 200 \
   "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$DASH/api/retention?$RANGE")"

# --- the guarantee the cutover is selling ----------------------------------
echo
echo "the no-third-party guarantee still holds"
is "ingest worker makes no outbound fetch" 0 \
   "$(grep -E 'fetch\(' "$WORKER_DIR"/src/*.ts | grep -vc 'async fetch(request' || true)"
is "ingest worker names no third-party analytics endpoint" 0 \
   "$(grep -rEil 'https?://[a-z0-9.-]+/(batch|capture|collect|track|ingest)' \
        "$WORKER_DIR"/src "$WORKER_DIR"/wrangler.jsonc 2>/dev/null | wc -l | tr -d ' ')"

echo
if [ "$fail" -eq 0 ]; then
  echo "$pass passed, 0 failed — the chain is whole; safe to cut over"
else
  echo "$pass passed, $fail failed"
fi
[ "$fail" -eq 0 ]
