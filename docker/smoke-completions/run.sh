#!/usr/bin/env bash
# Container entrypoint. Installs the codegraph tarball mounted at
# /pkg.tgz, exercises `codegraph completions <shell> --install` for
# each shell, then runs the per-shell assertions against the path the
# installer actually wrote to (varies by tier — see install.ts).
set -euo pipefail

if [[ ! -f /pkg.tgz ]]; then
  echo "smoke: /pkg.tgz not found. Mount the npm-pack tarball: docker run -v \$PWD/pkg.tgz:/pkg.tgz:ro …" >&2
  exit 2
fi

echo "smoke: installing codegraph from /pkg.tgz"
npm install -g /pkg.tgz >/dev/null

# Capture the absolute install path from each installer run. The line
# we want is "✓ Installed <shell> completions to <path>". Strip ANSI
# color so the parse is stable across terminal types.
strip_ansi() { sed 's/\x1b\[[0-9;]*m//g'; }

install_and_capture() {
  local shell=$1
  local out
  out=$(codegraph completions "$shell" --install 2>&1 | strip_ansi)
  # Mirror the installer's output to stderr so it's visible in logs
  # without polluting stdout, which the caller captures into a variable.
  echo "$out" >&2
  local p
  p=$(echo "$out" | grep -E "Installed .* completions to " | sed 's/.* to //' | head -1)
  if [[ -z "$p" || ! -s "$p" ]]; then
    echo "smoke: FAIL — couldn't determine install path or file empty for $shell" >&2
    exit 1
  fi
  printf '%s' "$p"
}

echo "smoke: installing completions (auto-detected tier per shell)"
ZSH_PATH=$(install_and_capture zsh)
BASH_PATH=$(install_and_capture bash)
FISH_PATH=$(install_and_capture fish)
PS_PATH=$(install_and_capture powershell)
export ZSH_PATH BASH_PATH FISH_PATH PS_PATH

# The PowerShell profile must contain our dot-source line.
PS_PROFILE="$HOME/.config/powershell/Microsoft.PowerShell_profile.ps1"
if ! grep -q "codegraph completions" "$PS_PROFILE"; then
  echo "smoke: FAIL — $PS_PROFILE missing the dot-source line" >&2
  exit 1
fi

echo "smoke: running bash assertions"
/smoke/test-bash.sh

echo "smoke: running fish assertions"
/smoke/test-fish.sh

echo "smoke: running zsh assertions"
/smoke/test-zsh.sh

echo "smoke: running powershell assertions"
/smoke/test-powershell.sh

# Tier 1 zsh detection (oh-my-zsh): create a fake $ZSH dir, re-install,
# assert the file lands in $ZSH/completions instead of wherever the
# default install went.
echo "smoke: running zsh oh-my-zsh tier check"
/smoke/test-zsh-ohmyzsh.sh

# Idempotency: re-running --install for powershell must NOT duplicate
# the dot-source line.
echo "smoke: powershell install idempotency check"
before=$(grep -c "codegraph completions" "$PS_PROFILE" || echo 0)
codegraph completions powershell --install >/dev/null
after=$(grep -c "codegraph completions" "$PS_PROFILE" || echo 0)
if [[ "$before" != "$after" ]]; then
  echo "smoke: FAIL — powershell --install duplicated profile line ($before → $after)" >&2
  exit 1
fi

# Graceful no-op for unknown shells.
echo "smoke: unsupported shell check"
if codegraph completions nushell 2>/tmp/nu.err; then
  echo "smoke: FAIL — unknown shell should error out, exited 0" >&2
  exit 1
fi
if ! grep -q "Unsupported shell" /tmp/nu.err; then
  echo "smoke: FAIL — unknown shell error doesn't mention 'Unsupported shell'" >&2
  cat /tmp/nu.err >&2
  exit 1
fi

echo "smoke: zsh bash fish powershell OK"
