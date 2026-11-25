#!/usr/bin/env bash
# Headless Claude Code run against a repo with codegraph MCP, capturing the
# full stream-json so we can see tool calls + token usage. Complements the
# interactive itrun.sh: headless gives a clean per-tool breakdown + exact
# tokens/cost, but defaults to the general-purpose subagent (not Explore).
# To force the Explore path, ask for it in the prompt.
#
# Usage: run-agent.sh <repo-path> <label> "<prompt>"
# Env: AGENT_EVAL_OUT (default /tmp/agent-eval), CG_BIN (codegraph dist binary)
set -uo pipefail

REPO="$1"; LABEL="$2"; PROMPT="$3"
CG_BIN="${CG_BIN:-$(command -v codegraph || echo /usr/local/bin/codegraph)}"
OUT_DIR="${AGENT_EVAL_OUT:-/tmp/agent-eval}"; mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/run-${LABEL}.jsonl"

MCP_CONFIG=$(cat <<JSON
{"mcpServers":{"codegraph":{"command":"${CG_BIN}","args":["serve","--mcp","--path","${REPO}"]}}}
JSON
)

echo "→ running [$LABEL] in $REPO"
cd "$REPO" || exit 1

claude -p "$PROMPT" \
  --output-format stream-json --verbose \
  --permission-mode bypassPermissions \
  --model "${MODEL:-sonnet}" --effort "${EFFORT:-high}" \
  --max-budget-usd 2 \
  --strict-mcp-config --mcp-config "$MCP_CONFIG" \
  > "$OUT" 2>"$OUT_DIR/run-${LABEL}.err"

echo "exit: $? | wrote $OUT ($(wc -l < "$OUT") lines)"
node "$(cd "$(dirname "$0")" && pwd)/parse-run.mjs" "$OUT" 2>/dev/null || true
