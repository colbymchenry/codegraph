#!/usr/bin/env bash
# Tag the current commit with the version in package.json and publish a
# matching GitHub Release whose body is the corresponding CHANGELOG.md entry.
#
# Run AFTER you have:
#   - bumped package.json
#   - added a `## [X.Y.Z] - YYYY-MM-DD` block at the top of CHANGELOG.md
#   - committed, pushed to origin, and run `npm publish`
#
# Idempotent: safe to re-run after a partial failure. Skips steps that are
# already done (tag created, tag pushed, release published).
#
# Usage: ./scripts/release.sh

set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"

REPO=$(git remote get-url origin | sed -E 's|.*github\.com[:/]||; s|\.git$||')
if [ -z "${REPO}" ]; then
  echo "error: could not derive owner/repo from origin remote URL" >&2
  exit 1
fi

if ! grep -q "^## \[${VERSION}\]" CHANGELOG.md; then
  echo "error: no '## [${VERSION}]' entry found in CHANGELOG.md" >&2
  exit 1
fi

# Extract notes with paragraph unwrapping — GitHub Releases render with
# GFM hard-breaks, so the CHANGELOG's hard-wrapped lines would show as
# visible `<br>` breaks otherwise. The helper joins continuation lines
# into a single line per bullet.
NOTES=$(node scripts/extract-release-notes.mjs "${VERSION}")

if [ -z "${NOTES}" ]; then
  echo "error: failed to extract changelog notes for ${VERSION}" >&2
  exit 1
fi

if git rev-parse "${TAG}" >/dev/null 2>&1; then
  echo "✓ tag ${TAG} already exists locally"
else
  echo "→ tagging ${TAG}"
  git tag "${TAG}"
fi

if git ls-remote --exit-code --tags origin "${TAG}" >/dev/null 2>&1; then
  echo "✓ tag ${TAG} already on origin"
else
  echo "→ pushing ${TAG} to origin"
  git push origin "${TAG}"
fi

if gh release view "${TAG}" --repo "${REPO}" >/dev/null 2>&1; then
  echo "✓ release ${TAG} already published"
else
  echo "→ creating GitHub Release ${TAG} on ${REPO}"
  gh release create "${TAG}" \
    --repo "${REPO}" \
    --title "${TAG}" \
    --notes "${NOTES}"
fi

echo "done: https://github.com/${REPO}/releases/tag/${TAG}"
