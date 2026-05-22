#!/usr/bin/env bash
# Drive an INTERACTIVE Claude Code session in tmux, send a prompt, wait for the
# agent to finish, then print the tool-call breakdown from the session logs.
#
# Why interactive (not `claude -p`): headless print-mode picks the
# general-purpose subagent, while real interactive sessions delegate to the
# Explore subagent (or drive codegraph from the main thread). Only the
# interactive TUI reproduces the behavior users actually see. (Idle-detection
# technique borrowed from devpit's WaitForIdle.)
#
# Usage: itrun.sh <repo-path> <label> "<prompt>"
# Output dir: $AGENT_EVAL_OUT (default /tmp/agent-eval)
# Requires: tmux 3.0+, a logged-in `claude` CLI, codegraph MCP configured.
set -uo pipefail
REPO="$1"; LABEL="$2"; PROMPT="$3"
SESSION="cgt_${LABEL}"
OUT_DIR="${AGENT_EVAL_OUT:-/tmp/agent-eval}"; mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/itrun-${LABEL}.txt"
HERE="$(cd "$(dirname "$0")" && pwd)"

cap() { tmux capture-pane -p -t "$SESSION" -S -40; }

tmux kill-session -t "$SESSION" 2>/dev/null

# Wide pane so the TUI doesn't hard-wrap tool lines.
tmux new-session -d -s "$SESSION" -x 230 -y 60
tmux send-keys -t "$SESSION" "cd $REPO && claude --dangerously-skip-permissions ${CLAUDE_EXTRA_ARGS:-}" Enter

# Wait for the ❯ prompt (claude drew its UI), up to 60s. NOTE: ❯ appears on the
# welcome screen seconds before the input actually accepts keystrokes, so this is
# necessary but NOT sufficient — the type-and-verify loop below is what proves
# the input is live.
ready=0
for _ in $(seq 1 120); do
  cap | grep -q "❯" && { ready=1; break; }
  sleep 0.5
done
[ "$ready" = 1 ] || { echo "claude never drew its UI"; cap; tmux kill-session -t "$SESSION" 2>/dev/null; exit 1; }

# Accept the per-folder "Is this a project you trust?" dialog if it shows (first
# time claude opens a given repo). Option 1 ("Yes, I trust this folder") is
# pre-selected, so Enter accepts. This dialog also contains ❯, so it must be
# cleared before the type-and-verify loop or keystrokes land on the menu.
for _ in $(seq 1 20); do
  cap | grep -q "trust this folder" || break
  tmux send-keys -t "$SESSION" Enter
  sleep 1
done

# Type-and-verify: send the prompt, confirm a distinctive chunk of it actually
# landed in the input box, retry if it didn't (handles the early-❯ race where
# the welcome screen shows the prompt glyph but MCP init is still eating keys).
needle="${PROMPT:0:24}"
typed=0
for _ in $(seq 1 30); do
  tmux send-keys -l -t "$SESSION" "$PROMPT"
  sleep 1
  if cap | grep -Fq "$needle"; then typed=1; break; fi
  # Clear whatever partial text may have landed, then retry.
  tmux send-keys -t "$SESSION" C-u
  sleep 1
done
[ "$typed" = 1 ] || { echo "prompt never landed in the input box"; cap; tmux kill-session -t "$SESSION" 2>/dev/null; exit 1; }
sleep 0.5
tmux send-keys -t "$SESSION" Enter

# Busy signals. The robust one is the spinner's elapsed-time-in-parens, which
# EVERY working state shows — both the pre-stream thinking phase
# "(8s · thinking with max effort)" and the streaming phase
# "(24s · ↑ 2.5k tokens · …)", and it survives the 32s→"1m 3s" rollover. We OR
# in the token arrows, "esc to interrupt", and "Initializing" as belt-and-braces
# (some TUI versions/states show one but not the others).
BUSY_RE='esc to interrupt|↓ [0-9]|↑ [0-9]|Initializing|\(([0-9]+m )?[0-9]+s ·'

# Wait for work to START (busy indicator appears), up to 60s. If it never starts,
# fail loudly rather than silently reporting an empty run.
started=0
for _ in $(seq 1 120); do
  cap | grep -qE "$BUSY_RE" && { started=1; break; }
  sleep 0.5
done
[ "$started" = 1 ] || { echo "agent never started working"; cap; tmux kill-session -t "$SESSION" 2>/dev/null; exit 1; }

# Poll for idle: not busy AND ❯ present, for 10 consecutive polls (~5s) to ride
# out mid-conversation thinking gaps that briefly drop the spinner. Up to ~15min.
consec=0
for _ in $(seq 1 1800); do
  pane=$(cap)
  if echo "$pane" | grep -qE "$BUSY_RE"; then
    consec=0
  elif echo "$pane" | grep -q "❯"; then
    consec=$((consec+1)); [ "$consec" -ge 10 ] && break
  else
    consec=0
  fi
  sleep 0.5
done
sleep 1

tmux capture-pane -p -t "$SESSION" -S - > "$OUT"
echo "captured $(wc -l < "$OUT") lines -> $OUT"
grep -oE "Done \([^)]*\)" "$OUT" | tail -1
grep -oE "[0-9.]+k?/[0-9.]+M" "$OUT" | tail -1 | sed 's/^/Context /'
tmux kill-session -t "$SESSION" 2>/dev/null

# Clean tool breakdown from the session logs (main + subagents).
node "$HERE/parse-session.mjs" "$REPO" 2>/dev/null || true
