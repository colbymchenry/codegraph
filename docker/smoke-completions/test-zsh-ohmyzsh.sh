#!/usr/bin/env bash
# Tier-1 zsh detection check. Creates a fake oh-my-zsh layout (just an
# empty $ZSH dir), re-runs `codegraph completions zsh --install`, and
# asserts the file lands in $ZSH/completions/ — proving the detection
# picks the oh-my-zsh path over the ~/.zsh fallback.
set -euo pipefail

FAKE_ZSH="$HOME/.oh-my-zsh-fake"
mkdir -p "$FAKE_ZSH"

# Re-install with $ZSH set. We don't want to disturb the existing
# tier-3 install at ~/.zsh/completions/_codegraph (the prior test
# asserted it landed there), so this is a strict additive check.
ZSH="$FAKE_ZSH" codegraph completions zsh --install >/tmp/ohmyzsh-install.out

target="$FAKE_ZSH/completions/_codegraph"
if [[ ! -s "$target" ]]; then
  echo "FAIL [zsh:tier-1]: expected oh-my-zsh tier to write $target" >&2
  echo "--- installer output ---" >&2
  cat /tmp/ohmyzsh-install.out >&2
  exit 1
fi

# The installer message should report the oh-my-zsh source.
if ! grep -q "oh-my-zsh" /tmp/ohmyzsh-install.out; then
  echo "FAIL [zsh:tier-1]: installer didn't report oh-my-zsh as detected source" >&2
  cat /tmp/ohmyzsh-install.out >&2
  exit 1
fi

# Cleanup so subsequent test runs in the same image don't leak state.
rm -rf "$FAKE_ZSH"

echo "zsh oh-my-zsh tier OK"
