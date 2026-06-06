#!/usr/bin/env bash
# PreToolUse hook (experiment): deny Read of codegraph-indexed source files and
# steer the agent to codegraph_explore/codegraph_node instead. Tests whether
# codegraph can FULLY replace Read for code-understanding once the escape hatch
# is removed. Non-source reads (config, .env, markdown, new files) pass through.
#
# Wire via:  claude ... --settings scripts/agent-eval/hook-settings.json
set -uo pipefail
input="$(cat)"
fp="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"

case "$fp" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.py|*.go|*.rs|*.java|*.rb|*.php|*.swift|*.kt|*.kts|*.c|*.cc|*.cpp|*.h|*.hpp|*.cs|*.lua|*.vue|*.svelte)
    msg="Read is disabled for source files in this session — codegraph already has this file indexed (with line numbers, kept in sync on every change). Use codegraph_explore (several related symbols at once) or codegraph_node (one symbol's full source). If a symbol you need wasn't in a prior explore, run ANOTHER codegraph_explore with its exact name instead of reading the file."
    jq -n --arg m "$msg" '{reason:$m, hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$m}}'
    exit 0
    ;;
esac
exit 0
