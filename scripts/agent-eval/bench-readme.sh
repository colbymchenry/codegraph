#!/usr/bin/env bash
# Re-run the README "Benchmark Results" A/B (with vs without codegraph) on the
# current build: the 7 README repos, same queries, RUNS per arm (default 4).
# Output → /tmp/ab-readme/<repo>/run<n>/run-headless-{with,without}[.tN].jsonl
# Aggregate with parse-bench-readme.mjs. Repos must be cloned + indexed under
# $CORPUS (default /tmp/codegraph-corpus) by the build under test.
#
# Each row is a THREE-TURN session: the README question, then two follow-ups
# that stay inside the same flow. Turns 2-3 are where residual context occupancy
# is actually charged — the first answer's tool output is still in the window,
# so the arms diverge on how much headroom each left behind. CG_TURNS=1 runs the
# README question alone (the original single-question A/B).
set -uo pipefail
H="$(cd "$(dirname "$0")" && pwd)"
C="${CORPUS:-/tmp/codegraph-corpus}"
RUNS="${RUNS:-4}"
RUN_FROM="${RUN_FROM:-1}"   # extend an existing pass: RUN_FROM=3 RUNS=3 adds run3 only
TURNS="${CG_TURNS:-3}"
ROWS=(
"vscode|How does the extension host communicate with the main process?|Where in that path would a message be dropped if the extension host crashes?|What would I need to change to add a new message type to that protocol?"
"excalidraw|How does Excalidraw render and update canvas elements?|Which part of that path decides whether a full re-render happens or an incremental one?|If I added a new element type, what in that render path would need to change?"
"django|How does Django's ORM build and execute a query from a QuerySet?|Where in that path is the SQL actually compiled into a string?|What would I change to add a new lookup type to that pipeline?"
"tokio|How does tokio schedule and run async tasks on its runtime?|Where does a task move between the local and the global queue in that path?|What in that path would I touch to add a per-task instrumentation hook?"
"okhttp|How does OkHttp process a request through its interceptor chain?|Where in that chain is the connection actually acquired?|What would I change to add a new interceptor stage before the cache?"
"gin|How does gin route requests through its middleware chain?|Where is the 404 / no-route case handled in that same chain?|What would I change to add a per-route middleware that runs before the global ones?"
"alamofire|How does Alamofire build, send, and validate a request?|Where does retry / interceptor logic hook into that path?|What would I change to add a new validation step to it?"
)
echo "### README A/B START $(date) RUNS=$RUN_FROM..$RUNS TURNS=$TURNS"
for row in "${ROWS[@]}"; do
  repo="${row%%|*}"; rest="${row#*|}"
  # Take the first $TURNS questions and join them with "||" for run-all.sh.
  q=""; n=0
  while [ "$n" -lt "$TURNS" ] && [ -n "$rest" ]; do
    part="${rest%%|*}"
    if [ "$rest" = "$part" ]; then rest=""; else rest="${rest#*|}"; fi
    [ -n "$q" ] && q="$q||"
    q="$q$part"; n=$((n + 1))
  done
  echo "===== $repo ($n turns) ====="
  for run in $(seq "$RUN_FROM" "$RUNS"); do
    out="/tmp/ab-readme/$repo/run$run"
    mkdir -p "$out"
    AGENT_EVAL_OUT="$out" bash "$H/run-all.sh" "$C/$repo" "$q" headless > "$out/console.log" 2>&1
    grep -E "^exit [0-9]" "$out/console.log" | sed 's/^/  /' || echo "  run$run: (no exit line)"
    grep -E "codegraph +[0-9,]+ tok|→ file-access" "$out/console.log" | sed 's/^/  /' || true
  done
done
echo "### README A/B DONE $(date)"
