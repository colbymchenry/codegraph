---
name: publish
description: Publishes a new minor or major release of this npm package (codegraph). Reads the latest version from npm, generates a user-perspective CHANGELOG entry from commits since the last tag, bumps package.json, publishes to npm, and creates the matching GitHub release. Use when the user runs /publish or asks to cut, ship, or publish a release / new version.
---

# Publish a release

Cut a **minor or major** release: generate the changelog, bump, publish to npm, and create the GitHub release. Patch releases are intentionally not offered here.

This skill performs the actual publish (npm publish, git push, GitHub release) — that is the whole point of invoking it, so the general "hand the user the commands" rule does **not** apply inside `/publish`. The **confirmation gate in Step 5 is the safeguard**: never run a step past it without explicit approval.

Run from the repo root.

## Workflow

Copy this checklist and work through it in order:

```
- [ ] 1. Preflight: branch, sync, auth
- [ ] 2. Read base version from npm, compute candidates
- [ ] 3. Ask the user: minor or major
- [ ] 4. Generate the CHANGELOG entry from commits since the last tag
- [ ] 5. CONFIRMATION GATE — show changelog + plan, get explicit approval
- [ ] 6. Write CHANGELOG.md, bump, build
- [ ] 7. Commit + push
- [ ] 8. npm publish
- [ ] 9. scripts/release.sh (GitHub release)
- [ ] 10. Verify on the npm registry
```

### Step 1 — Preflight

```bash
git rev-parse --abbrev-ref HEAD   # expect: main
git fetch origin
git status --porcelain            # working tree should be clean
git rev-list --left-right --count origin/main...HEAD   # "<behind> <ahead>"
npm whoami                        # npm auth (publish will fail without it)
gh auth status                    # gh auth (release.sh needs it)
```

- If not on `main`, stop and ask the user to confirm releasing from this branch.
- If behind origin, `git pull --ff-only` so the final push is a fast-forward.
- If the tree has **unrelated** uncommitted changes, stop and ask — the release commit only stages 3 files, but a dirty tree usually means something's mid-flight.
- If `npm whoami` or `gh auth status` fails, stop and tell the user to authenticate.

### Step 2 — Base version + candidates

The latest **published** version is the source of truth, not local `package.json`.

```bash
PKG=$(node -p "require('./package.json').name")
BASE=$(npm view "$PKG" version)
node -e "const [a,b]=process.argv[1].split('.').map(Number);console.log('minor ->',a+'.'+(b+1)+'.0');console.log('major ->',(a+1)+'.0.0')" "$BASE"
```

Note if local `package.json` differs from `BASE` (an unpublished bump) — surface it, but still base the new version on npm.

### Step 3 — Ask minor or major

Use the **AskUserQuestion** tool with the two computed candidates as options (show the resulting version in each label, e.g. "minor → 0.8.0"). Set the new version from the answer.

### Step 4 — Generate the changelog entry

```bash
LAST=$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null)
git log --no-merges "${LAST}..HEAD" --pretty=format:'%h %s'
```

Read the commit subjects; for any whose user impact is unclear, inspect the diff (`git show <hash>` or `git diff "${LAST}..HEAD" -- <path>`). Then **write the entry yourself** following the repo's conventions in `CLAUDE.md` → "Writing changelog entries":

- Header: `## [X.Y.Z] - YYYY-MM-DD` (get the date with `date +%F`).
- Group under `### Added`, `### Changed`, `### Fixed`, `### Removed`, `### Deprecated`, `### Security` — **omit empty sections**.
- Write from the **user's perspective** (observable capability/symptom), not the implementation. Collapse noisy commits ("fix typo", "address review") into the feature they belong to or drop them.
- Plan the bottom link reference: `[X.Y.Z]: https://github.com/colbymchenry/codegraph/releases/tag/vX.Y.Z`.

Do not write to any file yet — draft it for review first.

### Step 5 — CONFIRMATION GATE

Show the user, in chat:
1. The new version (`BASE` → `X.Y.Z`, minor/major).
2. The full drafted changelog entry.
3. The exact actions Steps 6–9 will take (commit + push + npm publish + GitHub release).

Then **STOP**. Proceed only on explicit approval ("yes" / "proceed"). If the user requests prose changes, revise the draft and re-show. Do not run any command below until approved.

### Step 6 — Write changelog, bump, build

1. Use the **Edit** tool to insert the drafted `## [X.Y.Z]` block at the **top** of `CHANGELOG.md` (under the intro, above the previous version), and add the link reference with the other `[x.y.z]:` links at the bottom.
2. Bump (also updates `package-lock.json`; `--allow-same-version` keeps re-runs safe):
   ```bash
   npm version X.Y.Z --no-git-tag-version --allow-same-version
   ```
3. Build (fail fast before any push/publish):
   ```bash
   npm run build
   ```

### Step 7 — Commit + push

`release.sh` tags HEAD, so the bump must be committed first.

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "release: X.Y.Z"
git push
```

### Step 8 — Publish to npm

```bash
npm publish --access public
```

### Step 9 — GitHub release

`scripts/release.sh` reads the `## [X.Y.Z]` block from CHANGELOG.md, tags `vX.Y.Z`, pushes the tag, and creates the GitHub release. It is idempotent.

```bash
./scripts/release.sh
```

### Step 10 — Verify

Confirm against the **registry**, not the website (the website caches):

```bash
npm view "$PKG" version   # must equal X.Y.Z
```

Report the release URL (`scripts/release.sh` prints it) and the published version.

## If something fails midway

Re-running is safe: `npm version --allow-same-version` no-ops if already bumped, `git commit` skips if nothing's staged (check `git diff --cached --quiet`), `git push` no-ops if up to date, and `scripts/release.sh` skips tag/release steps already done. Re-run from the failed step.
