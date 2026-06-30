#!/usr/bin/env bash
# Drive the tool-surface ablation across the chosen repos × arms (A–E).
# Arms A–D ask the canonical FLOW question; arm E asks a NON-flow survey
# question (the control probe — should degrade without explore+context).
# Output: /tmp/arms/<repo>/<arm>-r<n>.jsonl  (parse with parse-arms.mjs).
set -uo pipefail
HARNESS="$(cd "$(dirname "$0")" && pwd)"
RUNS="${RUNS:-2}"
C="${CORPUS:-/tmp/codegraph-corpus}"
NFQ='What are the main modules/components of this codebase and what does each one do? Give an overview of how it is organized.'

# repo-path|flow-question  (2 small, 2 medium, 2 large — spans the size range)
ROWS=(
"$C/flutter-samples/add_to_app/books/flutter_module_books|How does the books UI build and what child widgets does it show?"
"$C/aspnet-realworld|How is creating an article handled? Trace the controller to the service."
"$C/spring-mall|How is a product-list request handled? Trace the controller to the service."
"$C/vapor-spi|How is a package-show request handled? Name the route and controller."
"$C/excalidraw|How does updating an element re-render the canvas on screen? Trace the flow."
"$C/spring-halo|How is publishing a post handled? Trace the controller to the service."
)

echo "### ARMS MATRIX START $(date) RUNS=$RUNS"
for row in "${ROWS[@]}"; do
  repo="${row%%|*}"; q="${row#*|}"
  for arm in A B C D; do
    for r in $(seq 1 "$RUNS"); do
      bash "$HARNESS/run-arms.sh" "$repo" "$q" "$arm" "$r"
    done
  done
done
# E: non-flow control probe on two repos (must degrade without explore+context)
for repo in "$C/excalidraw" "$C/spring-mall"; do
  for r in $(seq 1 "$RUNS"); do
    bash "$HARNESS/run-arms.sh" "$repo" "$NFQ" E "$r"
  done
done
echo "### ARMS MATRIX COMPLETE $(date)"
