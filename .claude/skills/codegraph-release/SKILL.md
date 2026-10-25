---
name: codegraph-release
description: Use when writing or editing CHANGELOG.md entries, describing or preparing a release, or working with the release workflow, version bumps, npm publishing or tags.
---

# Releases

Released to npm and mirrored as [GitHub Releases](https://github.com/colbymchenry/codegraph/releases). `CHANGELOG.md` is the source of truth; GitHub Release notes are extracted from it.

## Writing changelog entries

**Default: write entries under `## [Unreleased]`** — that's the section reserved for work landing between releases. **Don't pre-create a `## [X.Y.Z]` block** for the next release: the Release workflow's first step is `scripts/prepare-release.mjs`, which automatically promotes everything under `[Unreleased]` into a new `## [X.Y.Z] - <YYYY-MM-DD>` block at release time (or merges into a pre-existing `[X.Y.Z]` block if one exists — but you don't need one). Pre-staging is what caused the v0.9.5 sparse-release-notes incident: a sparse `[0.9.5]` block hand-added before the rest of the work landed got picked by the extractor over the much-larger `[Unreleased]` section above it. Don't do that.

Formatting rules for any entry (anywhere — `[Unreleased]` or otherwise):

1. **Write friendly, user-facing notes — not engineer-facing ones.** Group under `### New Features` and `### Fixes` (sentence-case). Surface `### Breaking Changes` and `### Security` as their own sections **only when the release has them**; fold improvement-flavored changes into New Features. Omit empty sections. (This replaces the old Keep-a-Changelog `Added/Changed/Fixed/Removed/Deprecated` grouping: the GitHub Release page extracts each version block **verbatim** via `scripts/extract-release-notes.mjs`, and the old dense, implementation-focused entries rendered as an unreadable wall of text — so the whole CHANGELOG was rewritten to this format and every published release re-noted to match.)
2. **One plain-language sentence per bullet:** what changed and why it matters to a user. Lead with the capability, or with the symptom that's now fixed.
3. **Strip the internals.** No internal file paths (`src/...`), no internal symbol / function / class names, no benchmark numbers / percentages / node-or-edge counts. **Keep:** language & framework names (Go, Spring, NestJS, …), things a user types or sets (`codegraph install`, `codegraph_explore`, the `CODEGRAPH_*` env vars), agent / IDE names (Claude Code, Cursor, opencode, Kiro, …), and a brief `Thanks @user` when a contributor is credited.
4. Issue / PR references in entries are by number (`(#403)` etc.); the GitHub renderer auto-links them in the published release notes.
5. **Don't add a `[X.Y.Z]: https://...` link reference yourself** — `prepare-release.mjs` appends it automatically when it promotes the version (idempotent: a re-run is a no-op if it already exists).
6. **Every release opens with a `### Highlights` block — the only part most people read.** At most ~8 one-line bullets, in plain language for someone who doesn't read code, ordered by what a typical user notices first (new agent/IDE support and setup changes, then answer quality, then reliability), plus a one-sentence upgrade note when a re-index is needed. Write or refresh it in `[Unreleased]` when a release is being prepared — not per PR — and keep the detailed `### New Features` / `### Fixes` entries below it. When `### Fixes` grows past ~15 entries, group them under `####` sub-headings (`Better answers from codegraph_explore`, `Finding your project, live updates, and the CLI`, `Indexing reliability and disk usage`, `Language and framework accuracy`) so a skimmer can find their area.

Multi-word headings like `### New Features` are safe on the normal release path: `prepare-release.mjs` **Case A** moves the whole `[Unreleased]` body verbatim into `[X.Y.Z]`. (Only its rarely-used **Case B** *merge* splits sub-sections with a single-word `^### (\w+)$` regex that wouldn't match them — and Case B fires only if a `[X.Y.Z]` block was pre-created, which rule above already forbids.)

## Release flow (the user runs these)

Releases are built and published by the **GitHub Actions "Release" workflow**
(`.github/workflows/release.yml`). It runs `scripts/prepare-release.mjs` to
promote `[Unreleased]` into `[<version>]` (and auto-commit + push that
CHANGELOG change back to `main` so on-disk truth matches the published
notes), then bundles a Node runtime per platform (`scripts/build-bundle.sh`)
and publishes both the GitHub Release and the npm thin-installer
(`scripts/pack-npm.sh`: a shim package + per-platform packages).
Publishing manually is **wrong** now — a plain `npm publish` ships the root
package (non-bundled), which breaks anyone on Node < 22.5.

**Claude does NOT bump the version unless explicitly asked.** The maintainer
typically does it themselves — often by editing `package.json` directly via
the GitHub web UI. Don't proactively commit a version bump as part of
unrelated work, and don't propose one when summarizing a PR.

When the maintainer DOES bump the version, the only edit strictly required is
to `package.json` — the workflow's "Sync package-lock.json" step detects a
mismatch between `package.json` and `package-lock.json`, runs
`npm install --package-lock-only --ignore-scripts` to rewrite the lock file's
version fields (top-level + `packages.""`), and auto-commits + pushes the
result back to `main` with `[skip ci]`. So a GitHub-web-UI single-file edit to
`package.json` is enough to kick off a clean release. (If they edit both files
locally, that's fine too — the sync step no-ops.) Bump `ui/package.json` to the
same version in that change: the component library is versioned with the
engine, `ui-package.test.ts` pins it, and the workflow does not sync it — the
1.6.1 bump left `main` red on exactly that.

Once `package.json` is at the target version on `main`, trigger
**Actions → Release → Run workflow** (on `main`). The workflow:

1. Syncs `package-lock.json` to `package.json`'s version if they've drifted; commits + pushes that change.
2. Runs `prepare-release.mjs <X.Y.Z>` → promotes `[Unreleased]` → `[X.Y.Z] - <today>` in `CHANGELOG.md`, appends the link reference, commits + pushes the move with `[skip ci]`.
3. Builds every platform bundle on one runner, generates `SHA256SUMS`.
4. Creates the GitHub Release with notes from the freshly-promoted `[X.Y.Z]` block.
5. Publishes the npm shim + per-platform packages. Requires the `NPM_TOKEN` repo secret.
