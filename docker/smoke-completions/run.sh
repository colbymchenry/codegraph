#!/usr/bin/env bash
# Container entrypoint. Installs the codegraph tarball mounted at
# /pkg.tgz, installs completions for each shell to its standard
# location, then runs the per-shell assertions.
set -euo pipefail

if [[ ! -f /pkg.tgz ]]; then
  echo "smoke: /pkg.tgz not found. Mount the npm-pack tarball: docker run -v \$PWD/pkg.tgz:/pkg.tgz:ro …" >&2
  exit 2
fi

echo "smoke: installing codegraph from /pkg.tgz"
npm install -g /pkg.tgz >/dev/null

echo "smoke: generating + installing completion scripts"
codegraph completions zsh  --install >/dev/null
codegraph completions bash --install >/dev/null
codegraph completions fish --install >/dev/null

# Quick sanity: the files actually landed where the installer says.
for f in "$HOME/.zsh/completions/_codegraph" \
         "$HOME/.local/share/bash-completion/completions/codegraph" \
         "$HOME/.config/fish/completions/codegraph.fish"; do
  [[ -s "$f" ]] || { echo "smoke: FAIL — expected file missing or empty: $f" >&2; exit 1; }
done

echo "smoke: running bash assertions"
/smoke/test-bash.sh

echo "smoke: running fish assertions"
/smoke/test-fish.sh

echo "smoke: running zsh assertions"
/smoke/test-zsh.sh

echo "smoke: zsh bash fish OK"
