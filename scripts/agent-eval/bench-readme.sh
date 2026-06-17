#!/usr/bin/env bash
# Re-run the README "Benchmark Results" A/B (with vs without codegraph) on the
# current build: the 7 README repos, same queries, RUNS per arm (default 4).
# Output → /tmp/ab-readme/<repo>/run<n>/run-headless-{with,without}.jsonl
# Aggregate with parse-bench-readme.mjs. Repos must be cloned + indexed under
# $CORPUS (default /tmp/codegraph-corpus) by the build under test.
set -uo pipefail
H="$(cd "$(dirname "$0")" && pwd)"
C="${CORPUS:-/tmp/codegraph-corpus}"
RUNS="${RUNS:-4}"
ROWS=(
"vscode|How does the extension host communicate with the main process?"
"excalidraw|How does Excalidraw render and update canvas elements?"
"django|How does Django's ORM build and execute a query from a QuerySet?"
"tokio|How does tokio schedule and run async tasks on its runtime?"
"okhttp|How does OkHttp process a request through its interceptor chain?"
"gin|How does gin route requests through its middleware chain?"
"alamofire|How does Alamofire build, send, and validate a request?"
)
echo "### README A/B START $(date) RUNS=$RUNS"
for row in "${ROWS[@]}"; do
  repo="${row%%|*}"; q="${row#*|}"
  echo "===== $repo ====="
  for run in $(seq 1 "$RUNS"); do
    AGENT_EVAL_OUT="/tmp/ab-readme/$repo/run$run" bash "$H/run-all.sh" "$C/$repo" "$q" headless 2>&1 | grep -E "exit [0-9]" || echo "  run$run: (no exit line)"
  done
done
echo "### README A/B DONE $(date)"
