---
name: forklift-doctor
description: Eight drift checks for a fork managed by forklift. Run from the target fork repository. Each check is a self-contained command with a pass criterion and exact remediation.
---
<!-- forklift v1 -->

# forklift-doctor

The `forklift doctor` CLI runs all eight checks against the fork repo you are standing in. Each check is a self-contained command with a pass criterion and exact remediation.

## Setup

```bash
cd "$(git rev-parse --show-toplevel)"
export FORKLIFT=<absolute path to the forklift checkout that contains this skill>
test -f .forklift/registry.yaml || echo "MISSING: .forklift/registry.yaml (run forklift-init)"
```

Registry-scoped checks (1-4, 6) read `.forklift/registry.yaml`. Harness checks (5, 7) additionally read `.forklift/harness.lock` (written by `forklift install`).

## Usage

```bash
bun "$FORKLIFT/bin/forklift" doctor                       # all checks, human output
bun "$FORKLIFT/bin/forklift" doctor --check 6             # one check
bun "$FORKLIFT/bin/forklift" doctor --check 1,2,6         # several
bun "$FORKLIFT/bin/forklift" doctor --check 1-8           # range (same as default)
bun "$FORKLIFT/bin/forklift" doctor --list                # print the check table, run nothing
bun "$FORKLIFT/bin/forklift" doctor --json                # {registry, checks: [{id,name,status,lines}], ok}
bun "$FORKLIFT/bin/forklift" doctor --registry .forklift/registry.yaml   # explicit path (default)
bun "$FORKLIFT/bin/forklift" doctor --help
```

The registry is validated against `schema/registry.schema.yaml` before any check runs; a schema error is a hard failure naming the registry. Human output is one block per check with its PASS/FAIL line and findings, then a final `doctor: N passed, M failed` summary; exit 0 only when every executed check passes. Check 7 derives the forklift root from the CLI's own location, so `FORKLIFT` is no longer required for it (still honored when set).

## Check reference

Run checks in order 1-8; 1-4 and 8 must pass before syncing, 5-6 before rebaselining, 7 any time. A script error (missing `harness` block, registry unparseable) is a hard failure with the setup remediation.

1. **Registry completeness** — no fork commit may touch a source path the registry does not claim. **PASS** = `PASS: registry covers every fork-touched source path (<range>)`. **FAIL** = one `UNREGISTERED` line per path (range `<upstream.remote>/<upstream.branch>..<fork.branch>`). **Remediation (per path):** find the owning feature with `git log --oneline -1 <upstream_branch> -- <path>` and `git log --oneline -1 <fork_branch> -- <path>`; then either register the path in an existing feature's `owned_paths`, add a new feature, add the file to `divergences` (take-upstream policy), or record a `removals` entry if the path is absent from the fork on purpose. A path covered by a `removals` entry counts as claimed: the fork deleted it on purpose, so it can never live in `owned_paths` (check 2 would report it stale). Re-run check 1 after every registry edit.

2. **Stale paths** — every `owned_paths` entry must exist on disk in the fork; a registered path with no file means prefer-ours resolutions on the next sync would resurrect deleted files. **PASS** = `PASS: all registered owned_paths exist`. **FAIL** = one `STALE` line per missing entry. **Remediation (per entry):** if the fork moved the file, update the registry path; if the fork deleted the file deliberately, drop the entry (or convert the feature to `divergences`/`removals` if the whole feature is gone). Never leave a `STALE` line: prefer-ours on a phantom path silently resurrects dead files.

3. **Feature coverage** — every feature that owns product behavior (matches `harness.checks.behavioral_source_regex`) must declare `protecting_tests` or a `coverage_exempt` reason. Draft features are reported, not enforced. **PASS** = `PASS: <n> behavioral feature(s) covered (exempt …, non-behavioral …, draft …)`. **FAIL** = one `UNCOVERED` line per feature. **Remediation:** add at least one test file (relative to repo root) to the feature's `protecting_tests`, or set `coverage_exempt: "<why no test can cover this>"` on the feature. A red test then acts as the feature-loss alarm across upstream refactors.

4. **Import liveness** — every JS/TS owned source must be imported by at least one file outside its own `owned_paths`, unless exempted; this catches a feature that kept its file but lost its `import "./pi"` wiring. **PASS** = `PASS: <n> owned source bucket(s), all imported` (or `SKIPPED:` when the registry owns no JS/TS sources — import liveness cannot apply). **FAIL** = one `ORPHAN` line per unimported source. **Remediation (per orphan):** (a) the importer was lost - restore the wiring (re-add the import side effect); (b) the source is a legitimate entrypoint / runtime-discovered plugin / spawned script with no static importer - add `liveness_exempt: "<reason>"` to its feature; (c) the path is wrong - fix the registry. Scope note: this check understands JS/TS import graphs; non-JS owned paths are skipped by design, so languages without quote-resolved imports need `liveness_exempt` instead.

5. **Commit survival** — the fork's commit count must equal `expected_fork_commit_count`; drift means commits were dropped or added since the last verified rebuild/rebase. **PASS** = `PASS: expected=N actual=N`. **FAIL** = `DRIFT:` line with both numbers. **Remediation:** confirm the delta with `git log --oneline <upstream_remote>/<upstream_branch>..<fork_branch>` (the same local-branch range this check uses) - dropped commits must be recovered (re-registered or cherry-picked), deliberate additions recorded. Only then update `expected_fork_commit_count` and re-run this check.

6. **Deletion audit** — a path still registered under `owned_paths` that exists in upstream history but not at the current upstream tip means the next rebase would delete it; never-existed paths (fork-new files) are informational. A path the fork keeps as a deliberate port can be acknowledged: add it to the owning feature's `upstream_deleted_paths` (`path` required; `upstream_removed_in`, `note` optional provenance) and check 6 downgrades it to an informational `PORT (acknowledged) <path> | <feature>` line instead of failing. **PASS** = `PASS: no registered path deleted upstream (checked …, fork-new …)`. **FAIL** = one `DELETED-UPSTREAM` line per unacknowledged path. **Remediation (per path):** the porting protocol - upstream deleted it, the fork still needs it, so the rebase will drop it. Options: keep the fork copy and acknowledge it via `upstream_deleted_paths`, absorb the upstream replacement (update registry to the new upstream path), or drop the feature if upstream retired it deliberately. Resolve every line before syncing.

7. **Version drift** — `harness.lock` is the authority on the installed template version; every stamped install must match it, and the registry's `harness.version` must match the lock. **PASS** = `PASS: <n> stamped install(s) match harness.lock v<n>` (either all stamps match, or the target has no installs). **FAIL** = a `DRIFT` line naming file + expected/actual, or a registry/lock mismatch, or a missing lock. **Remediation:** version drift means the harness moved without reinstalling - re-run `forklift render` and then `forklift install` in the target repo to restamp, or set `harness.version` in the registry back if it was edited by hand. Never edit a stamp line directly.

8. **Upstream drift forecast** — upstream-changed files since the merge-base that intersect fork-owned paths, ranked by resolution policy and gated on protecting_tests. **PASS** = `PASS: conflict surface <n> upstream-changed file(s) (graft <g>, prefer-ours <o>, take-upstream <u>, unrelated <r>) - all gated`; when upstream has not moved: `PASS: no upstream drift since merge-base <sha8>`; when there is no merge base: `FAIL: no merge base between <fork.branch> and <up> (fetch <upstream.remote> first)`. **FAIL** = `FAIL: <k> conflict-surface file(s) belong to feature(s) with no protecting_tests (…)` plus one `  UNGATED <path> | <feature>` per ungated surface file. **Surface lines** = `  GRAFT <path> | <feature> | structural|whitespace-only` (file carries `owned_symbols` — MERGE PATH), `  OURS <path> | <feature> | structural|whitespace-only` (file in a feature's `owned_paths` — prefer ours), `  UPSTREAM <path> | take upstream` (in `divergences`), plus `  DRAFT (reported only) <feature>` for draft features. **INFO line** = `  INFO: harness.checks.semantic_drift is unset - the Conflict Walk renders git-only; set {tool: difftastic} (mise: "github:Wilfred/difftastic") when difftastic can be installed on this fork`. Never a failure: it asks the operator to add `"github:Wilfred/difftastic" = "latest"` to the fork's `mise.toml` `[tools]`, run `mise install`, set the registry key, and re-render — the alternative (difftastic uninstallable) is a legitimate answer. **Remediation (per UNGATED):** add `protecting_tests` (or a `coverage_exempt` reason) to the named feature before syncing, so the resolution has a gate; if the surface is larger than the sync can absorb, shrink contact surface per the skill's § Guidelines. Re-run `forklift doctor --check 8`.
