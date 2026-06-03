#!/usr/bin/env bash
# One README repo, WITH-codegraph only, N runs. Each run appends a why-Read
# diagnostic so the agent explains any Read/Grep. (The WITHOUT baseline is
# codegraph-independent and already in the README — no point re-running it.)
# Output -> /tmp/ab-why/<repo>/with<n>.jsonl
# Usage: bench-why-repo.sh <repo-path> "<query>" [N]
set -uo pipefail
REPO="$1"; Q="$2"; N="${3:-4}"
NAME="$(basename "$REPO")"
CG="/Users/colby/Development/Personal/codegraph/dist/bin/codegraph.js"
OUT="/tmp/ab-why/$NAME"; mkdir -p "$OUT"
WHY=$'\n\nIMPORTANT — diagnostic: if you use the Read or Grep tool at ANY point, for EACH such call explain why codegraph_explore / codegraph_node did not already give you what you needed. End your entire answer with a section titled exactly "## Why I read" listing every Read and Grep you made and the precise reason codegraph fell short for it. If you used neither, write "## Why I read" then "none — codegraph was sufficient."'
printf '{"mcpServers":{"codegraph":{"command":"%s","args":["serve","--mcp","--path","%s"]}}}' "$CG" "$REPO" > "$OUT/cg.json"

for i in $(seq 1 "$N"); do
  pkill -f "serve --mcp" 2>/dev/null; sleep 1; rm -f "$REPO/.codegraph/daemon.sock"
  ( cd "$REPO" && claude -p "$Q$WHY" --output-format stream-json --verbose \
      --permission-mode bypassPermissions --model opus --effort "${EFFORT:-high}" --max-budget-usd 4 \
      --strict-mcp-config --mcp-config "$OUT/cg.json" > "$OUT/with$i.jsonl" 2>"$OUT/with$i.err" )
  echo "WITH run $i: exit $? ($(wc -l < "$OUT/with$i.jsonl" | tr -d ' ') lines)"
done
echo "DONE $NAME"
