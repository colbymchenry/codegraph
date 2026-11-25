#!/usr/bin/env bash
# Keep the codegraph CLI out of an eval arm, so the MCP server is the ONLY way
# the agent can reach codegraph. Sourced by run-all.sh and ab-new-vs-baseline.sh.
#
#   . "$HARNESS/no-cli-shim.sh"
#   cg_no_cli_setup "$OUT"       # -> sets $ARM_PATH and $ARM_SETTINGS
#   PATH="$ARM_PATH" claude … --settings "$ARM_SETTINGS"
#
# Why this exists, in both harnesses:
#
#   with/without (run-all.sh)  The without-arm gets an empty MCP config but still
#   has Bash, and the target repo carries the .codegraph/ index. Agents find that:
#   14 of 15 without-arm runs in one 7-repo pass ran `codegraph explore` through
#   Bash (one via `ls .codegraph && codegraph explore …`), so that arm was
#   measuring codegraph-over-CLI, not codegraph-absent.
#
#   new/baseline (ab-new-vs-baseline.sh)  Both arms are codegraph-on, so a CLI
#   call is not a with/without leak — it is an ATTRIBUTION leak, and it breaks all
#   three feedback metrics at once. Output that arrives through Bash is charged to
#   Bash (understating occupancy), and an explore issued through the CLI is not a
#   tool call at all, so it never reaches the sufficiency classifier or the
#   allocation parse. A run that shells out silently drops calls from the numbers.
#
# Two layers, because one was not enough:
#
#   1. PATH. The binary usually shares a directory with tools the run needs
#      (claude itself lives next to it here), so dropping the whole directory is
#      not an option. Substitute an equivalent directory IN PLACE: symlinks to
#      every entry except codegraph, keeping PATH order and precedence intact.
#   2. A PreToolUse hook. An agent denied `codegraph` ran
#      `find / -maxdepth 4 -iname "*codegraph*"`, found the binary, and invoked it
#      by ABSOLUTE PATH — so block the invocation itself. Written into the output
#      dir as a run artifact rather than a repo file, same as the MCP configs.
#
# Neither layer is a substitute for the counter: parse-run.mjs flags any Bash
# command that named codegraph, separating attempts it blocked (no output entered
# the window) from calls that RETURNED output. Prevention fails silently the next
# time the binary lands somewhere new; the counter does not.

# Command positions only: `grep codegraph x`, `ls .codegraph` and
# `which codegraph` are looking, not using, and pass through.
CG_CMD_RE='(^|[;&|(]|&&|\|\||\$\(|`)[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*[A-Za-z0-9_./~-]*codegraph([[:space:]]|$)'

cg_no_cli_setup() {
  local out="${1:?cg_no_cli_setup <out-dir>}"
  local shim="$out/nocg-bin"

  rm -rf "$shim"; mkdir -p "$shim"
  local built="" d e
  local IFS=:
  for d in $PATH; do
    [ -n "$d" ] || continue
    if [ -x "$d/codegraph" ]; then
      for e in "$d"/*; do
        [ "$(basename "$e")" = codegraph ] && continue
        ln -sf "$e" "$shim/" 2>/dev/null
      done
      d="$shim"
    fi
    built="${built:+$built:}$d"
  done
  unset IFS
  ARM_PATH="$built"

  if PATH="$ARM_PATH" command -v codegraph >/dev/null 2>&1; then
    echo "WARNING: 'codegraph' is still on the arm PATH — runs will be contaminated"
  fi
  for e in claude node; do
    PATH="$ARM_PATH" command -v "$e" >/dev/null || { echo "sanitized PATH lost '$e' — refusing to run"; return 1; }
  done

  command -v jq >/dev/null || { echo "jq is required for the CLI-block hook — install it or the arms will be contaminated"; return 1; }
  cat > "$out/no-cli-hook.sh" <<HOOK
#!/usr/bin/env bash
# Deny Bash invocations of the codegraph CLI so the MCP server stays the A/B's
# single variable. Looking for it is fine; running it is not.
set -uo pipefail
cmd="\$(cat | jq -r '.tool_input.command // empty' 2>/dev/null)"
if printf '%s' "\$cmd" | grep -Eq '$CG_CMD_RE'; then
  msg="The codegraph CLI is not available in this session. Answer using the tools you have."
  jq -n --arg m "\$msg" '{reason:\$m, hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:\$m}}'
fi
exit 0
HOOK
  chmod +x "$out/no-cli-hook.sh"
  cat > "$out/hook-settings.json" <<JSON
{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"bash $out/no-cli-hook.sh"}]}]}}
JSON
  ARM_SETTINGS="$out/hook-settings.json"

  # Prove the hook denies a real invocation and lets a mere mention through.
  cg_no_cli_probe() { printf '{"tool_input":{"command":%s}}' "$2" | bash "$1/no-cli-hook.sh" | grep -c deny; }
  [ "$(cg_no_cli_probe "$out" '"/Users/x/.local/bin/codegraph explore \"q\""')" = 1 ] || { echo "hook fails to block an absolute-path invocation"; return 1; }
  [ "$(cg_no_cli_probe "$out" '"grep -rn codegraph src/"')" = 0 ] || { echo "hook over-blocks a plain mention"; return 1; }
  return 0
}
