#!/usr/bin/env zsh
# Zsh completion smoke. zsh has no `complete -C` equivalent, and full
# completion output requires `_main_complete` running under a real ZLE
# widget context (which scripts can't manufacture — `_values` /
# `_arguments` short-circuit on missing `$compstate` / `$state` and a
# `compadd` shim captures nothing). PTY + expect is the only way to
# drive the full path, and that's too flaky for CI.
#
# We do the next-best thing: structural assertions that catch the
# common failure modes (script doesn't parse, file body crashed mid-way,
# helpers not defined). The deep-`_arguments` gap is documented in
# README.md and matches what clap_complete / oclif / Commander.js
# itself ship for zsh.
set -e

declare -i fail=0

# 1. Syntax check.
zsh -n "${ZSH_PATH:-$HOME/.zsh/completions/_codegraph}" || { echo "FAIL [zsh:syntax]" >&2; exit 1; }

# 2. compinit must load the file as an autoloadable function. Add the
#    install dir to $fpath — for tier-2 installs into
#    /usr/local/share/zsh/site-functions this is a no-op (already there);
#    for tier-3 (~/.zsh/completions fallback) it's required.
fpath=("${ZSH_PATH:A:h}" $fpath)
autoload -Uz compinit
# -u: don't bail on insecure dirs (container HOME is owned by root, fine)
# -d: per-run dump in /tmp so we don't pollute HOME
compinit -u -d /tmp/.zcompdump-smoke

# `whence -w` prints "name: function" or "name: autoload" for loaded
# completion functions; "none" means not registered.
whence_kind=$(whence -w _codegraph 2>/dev/null || echo "_codegraph: none")
case "$whence_kind" in
  *": function"|*": autoload") ;;
  *) echo "FAIL [zsh:autoload]: _codegraph not registered (whence: $whence_kind)" >&2; fail=1 ;;
esac

# 3. Force the autoload to actually source the file. We invoke
# `_codegraph` directly; this errors because `_arguments` isn't in a
# real completion context, but the side effect is the file body runs
# and defines the per-subcommand helpers. Discard the expected error.
_codegraph >/dev/null 2>&1 || true

# Spot-check a representative cross-section: one helper from each
# emitted class (no-args, with-args, dispatcher). If any of these
# isn't defined, the file body crashed partway through and the
# generated script is broken.
for helper in _codegraph_init _codegraph_query _codegraph_commands _codegraph_dispatch; do
  if ! typeset -f "$helper" >/dev/null 2>&1; then
    echo "FAIL [zsh:helper-defined]: $helper not defined after autoload" >&2
    fail=1
  fi
done

exit $fail
