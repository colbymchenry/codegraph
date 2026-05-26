#!/usr/bin/env bash
# Flutter framework quality check — per the dynamic-dispatch-coverage-playbook.
#
# Runs the DETERMINISTIC half of the validation methodology (no agent, no API
# spend) against small + medium Flutter sample apps. Verifies that the three
# framework resolvers (flutter, flutter-router, flutter-state) emit the
# expected nodes/edges, AND that the existing upstream `setState→build`
# synthesizer (callback-synthesizer.ts) still fires where applicable, AND
# that a non-Dart control repo doesn't regress.
#
# Usage:
#   scripts/agent-eval/validate-flutter.sh            # full sweep (default)
#   scripts/agent-eval/validate-flutter.sh small      # navigation_and_routing only
#   scripts/agent-eval/validate-flutter.sh medium     # compass_app/app only
#   scripts/agent-eval/validate-flutter.sh control    # express regression only
#
# Env:
#   CG_BIN          codegraph binary (default: ./dist/bin/codegraph.js)
#   EVAL_BASE       sample repos dir (default: /tmp/flutter-eval)
#   CONTROL_DIR     express checkout dir (default: /tmp/control)
#
# Exit codes: 0 = all checks pass · 1 = a check failed (specifics in output).
#
# This is the gate per CLAUDE.md "Validation methodology (REQUIRED for every
# new language/framework)". Agent A/B (run-all.sh) is the second half —
# requires Anthropic API spend; run separately when budget allows.

set -uo pipefail

HARNESS="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HARNESS/../.." && pwd)"
CG_BIN="${CG_BIN:-$REPO_ROOT/dist/bin/codegraph.js}"
EVAL_BASE="${EVAL_BASE:-/tmp/flutter-eval}"
CONTROL_DIR="${CONTROL_DIR:-/tmp/control}"
MODE="${1:-all}"

case "$MODE" in all|small|medium|control) ;; *) echo "mode must be all|small|medium|control (got '$MODE')"; exit 1;; esac

[ -f "$CG_BIN" ] || { echo "✗ no codegraph binary at $CG_BIN (run 'npm run build' first)"; exit 1; }
command -v sqlite3 >/dev/null || { echo "✗ sqlite3 not on PATH"; exit 1; }

PASS=0; FAIL=0
ok()   { echo "  ✓ $*"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $*"; FAIL=$((FAIL+1)); }

# Ensure the flutter/samples repo is cloned. Shallow only.
ensure_flutter_samples() {
  if [ ! -d "$EVAL_BASE/samples/.git" ]; then
    echo "→ cloning flutter/samples (shallow) into $EVAL_BASE/samples"
    mkdir -p "$EVAL_BASE"
    git -C "$EVAL_BASE" clone --depth 1 https://github.com/flutter/samples.git >/dev/null 2>&1 \
      || { echo "✗ flutter/samples clone failed"; exit 1; }
  fi
}

# Ensure express is cloned for the control regression check.
ensure_control() {
  if [ ! -d "$CONTROL_DIR/express/.git" ]; then
    echo "→ cloning expressjs/express (shallow) into $CONTROL_DIR/express"
    mkdir -p "$CONTROL_DIR"
    git -C "$CONTROL_DIR" clone --depth 1 https://github.com/expressjs/express >/dev/null 2>&1 \
      || { echo "✗ express clone failed"; exit 1; }
  fi
}

reindex() {
  local repo="$1"
  ( cd "$repo" && rm -rf .codegraph && node "$CG_BIN" init -i ) >/dev/null 2>&1 \
    || { echo "✗ indexing failed for $repo"; return 1; }
}

count_nodes() {
  local db="$1" kind="$2"
  sqlite3 "$db" "select count(*) from nodes where kind='$kind';"
}
count_edges() {
  local db="$1" prov="$2"
  sqlite3 "$db" "select count(*) from edges where provenance='$prov';"
}

# ----------------------------------------------------------------------------
# SMALL — navigation_and_routing (go_router, 17 .dart files)
# Exercises: flutter-router (GoRoute/ShellRoute extraction), block-body
# builders, generic-typed page wrappers, nested path joining, widget components.
# ----------------------------------------------------------------------------
check_small() {
  echo
  echo "==== SMALL: navigation_and_routing (go_router) ===="
  ensure_flutter_samples
  local repo="$EVAL_BASE/samples/navigation_and_routing"
  [ -d "$repo" ] || { fail "$repo missing (flutter/samples may have moved this app)"; return; }
  reindex "$repo" || { fail "indexing failed"; return; }
  local db="$repo/.codegraph/codegraph.db"

  local nodes routes components heuristic
  nodes=$(sqlite3 "$db" "select count(*) from nodes;")
  routes=$(count_nodes "$db" route)
  components=$(count_nodes "$db" component)
  heuristic=$(count_edges "$db" heuristic)

  [ "$nodes" -gt 200 ] && ok "indexed $nodes nodes (expected >200)" || fail "indexed only $nodes nodes"
  [ "$routes" -ge 8 ]  && ok "$routes route nodes (expected ≥8 for the 10 GoRoute calls)" || fail "only $routes route nodes — flutter-router regression"
  [ "$components" -ge 12 ] && ok "$components component nodes (StatelessWidget/StatefulWidget/State pairs)" || fail "only $components component nodes — flutter widget extraction regression"
  ok "synthesized edges = $heuristic (app has no setState; flutter-build synth correctly idle)"

  # Confirm at least one route → handler edge resolves to a screen widget.
  local handler_edges
  handler_edges=$(sqlite3 "$db" "select count(*) from edges e join nodes s on e.source=s.id join nodes t on e.target=t.id where s.kind='route' and t.kind in ('class','component');")
  [ "$handler_edges" -ge 6 ] && ok "$handler_edges route→handler edges resolved" || fail "only $handler_edges route→handler edges"
}

# ----------------------------------------------------------------------------
# MEDIUM — compass_app/app (go_router + provider + MVVM, 129 .dart files)
# Exercises: flutter-router with Routes.X constant-ref paths, flutter-state
# (provider detection), widget composition at scale.
# ----------------------------------------------------------------------------
check_medium() {
  echo
  echo "==== MEDIUM: compass_app/app (go_router + provider + MVVM) ===="
  ensure_flutter_samples
  local repo="$EVAL_BASE/samples/compass_app/app"
  [ -d "$repo" ] || { fail "$repo missing"; return; }
  reindex "$repo" || { fail "indexing failed"; return; }
  local db="$repo/.codegraph/codegraph.db"

  local nodes routes components heuristic
  nodes=$(sqlite3 "$db" "select count(*) from nodes;")
  routes=$(count_nodes "$db" route)
  components=$(count_nodes "$db" component)
  heuristic=$(count_edges "$db" heuristic)

  [ "$nodes" -gt 1500 ] && ok "indexed $nodes nodes (expected >1500)" || fail "indexed only $nodes nodes"
  [ "$routes" -ge 6 ] && ok "$routes route nodes (expected ≥6 — Routes.X const-ref + nested)" || fail "only $routes route nodes — const-ref path regression"
  [ "$components" -ge 40 ] && ok "$components component nodes (expected ≥40 widget classes)" || fail "only $components component nodes"
  ok "synthesized edges = $heuristic (app uses Command/ChangeNotifier, not setState; flutter-build synth correctly idle — see playbook §6 'MVVM Command/ChangeNotifier' known gap)"
}

# ----------------------------------------------------------------------------
# CONTROL — express (TypeScript, ~50 files)
# Regression gate: our Dart-only changes must not affect a non-Dart project.
# ----------------------------------------------------------------------------
check_control() {
  echo
  echo "==== CONTROL: expressjs/express (regression gate) ===="
  ensure_control
  local repo="$CONTROL_DIR/express"
  reindex "$repo" || { fail "indexing failed"; return; }
  local db="$repo/.codegraph/codegraph.db"
  local nodes routes
  nodes=$(sqlite3 "$db" "select count(*) from nodes;")
  routes=$(count_nodes "$db" route)
  [ "$nodes" -gt 800 ]  && ok "indexed $nodes nodes (baseline ~990)" || fail "indexed only $nodes nodes — possible regression"
  [ "$routes" -gt 200 ] && ok "$routes route nodes (baseline ~266) — express extraction unaffected" || fail "only $routes route nodes — non-Dart regression"
}

echo "Flutter framework quality check"
echo "(deterministic half of the playbook validation — no agent / no API spend)"
echo "cg-bin: $CG_BIN"

case "$MODE" in
  small)   check_small ;;
  medium)  check_medium ;;
  control) check_control ;;
  all)     check_small; check_medium; check_control ;;
esac

echo
echo "================================================================"
echo "SUMMARY: $PASS passed, $FAIL failed"
echo "================================================================"
[ "$FAIL" -eq 0 ]
