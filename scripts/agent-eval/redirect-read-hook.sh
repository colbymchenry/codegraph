#!/usr/bin/env bash
# PreToolUse(Read) REDIRECT hook — prototype for A/B (P1: get agents off Read and
# onto codegraph_node during implementation, not just for Q&A).
#
# When the agent Reads a SOURCE file, deny it and steer to codegraph_node's
# file-view, which (as of the Lever-1 change) returns the WHOLE file verbatim
# WITH line numbers — imports, top-level code, comments and all — PLUS the file's
# blast radius, in one call. That output is a strict superset of Read, so the
# redirect is lossless: the agent loses nothing by taking it, and gains who-
# depends-on-this for the edit it's about to make.
#
# Differs from block-read-hook.sh (which steers to explore/node-by-symbol): this
# names the FILE-VIEW path explicitly (file:"<base>" + includeCode:true), the
# 1:1 Read replacement we're trying to get picked during implementation.
#
# Non-source files (configs, docs, lockfiles, .env) pass through to a real Read.
# A redirect to a file codegraph hasn't indexed SELF-CORRECTS: the file-view
# replies "No indexed file matches … Read it directly", so a just-created file
# never dead-ends — the agent Reads it on the next turn.
#
# Wire via:  claude ... --settings <settings-with-this-as-PreToolUse(Read)>
# Eval artifact only. The production version is an indexed-aware `codegraph`
# subcommand (cross-platform — no bash/jq — and queries the index so it never
# bounces a new/un-indexed file), wired opt-in by the installer.
set -uo pipefail
input="$(cat)"
fp="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"
[ -n "$fp" ] || exit 0
base="$(basename "$fp")"

case "$fp" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.py|*.go|*.rs|*.java|*.rb|*.php|*.swift|*.kt|*.kts|*.scala|*.c|*.cc|*.cpp|*.h|*.hpp|*.cs|*.lua|*.vue|*.svelte|*.m|*.mm)
    msg="codegraph has this file indexed (kept in sync on every edit). Call codegraph_node with file:\"$base\" and includeCode:true instead of Read — it returns the WHOLE file verbatim WITH line numbers (imports, top-level code and all — safe to base an Edit on) PLUS which files depend on it, in one call. Treat its output as already-Read; do not Read this file. (If it answers that the file isn't indexed — e.g. you just created it — then Read it directly.)"
    jq -n --arg m "$msg" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$m}}'
    exit 0
    ;;
esac
exit 0
