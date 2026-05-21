#!/usr/bin/env bash
# Host wrapper for the completion smoke test. Builds, packs, runs the
# image. Idempotent — cleans up the tarball on exit.
set -euo pipefail

cd "$(dirname "$0")/../.."

echo "smoke: building dist/"
npm run build >/dev/null

echo "smoke: packing"
PKG=$(npm pack --silent)
trap 'rm -f "$PKG"' EXIT

echo "smoke: building image"
docker build --quiet -t codegraph-smoke docker/smoke-completions >/dev/null

echo "smoke: running container"
docker run --rm \
  -v "$PWD/$PKG:/pkg.tgz:ro" \
  codegraph-smoke
