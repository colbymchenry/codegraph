<!-- forklift v1 -->
# forklift

Fork-sync harness for git forks. Extracted from `oh-wiblo-pi`'s `.omp/skills/sync-upstream/` harness, where a fork silently losing features on rebase was solved once; forklift makes that solution portable to any fork in the workspace — and ships it as a global binary so every fork in the workspace runs the same code instead of a copy.

A fork registers what it owns (`<repo>/.forklift/registry.yaml`), forklift turns that registration into agent-facing artifacts (`forklift render`, `forklift install`, `forklift check`), the lifted sync runner keeps a rebase from silently dropping fork features (`forklift sync` and its read-only entrypoints), and doctor procedures tell you when the registration has drifted from reality (`forklift doctor`).

**New here:** [`docs/quickstart.md`](docs/quickstart.md) — how to actually use this with an agent:
say what you want ("I just added a feature — make sure it survives the next sync"), and the
harness supplies the mechanics. The fork's own `AGENT.md` carries the same mapping, generated
into every fork.

`forklift install` also writes a **slash command per situation** into the agent's command
directory (`.omp/commands/`, and the other adapters' command dirs that exist):
`/forklift-bootstrap`, `/forklift-feature`, `/forklift-sync`, `/forklift-audit`,
`/forklift-rebuild`, plus `/forklift` — the router, for when the user describes a situation in
their own words. Each is a thin stub that names the intent and defers to the skill that carries
the procedure — one copy of the judgment, one word to type. The wording itself lives in
`templates/situations.yaml`: the single source the stubs and the `AGENT.md` playbook are derived
from.

## Colour

The CLI paints what it reports: `PASS` green, `FAIL` red, `WARN`/`DRIFT` yellow, section headers
dim, and the long steps — the rebase, the type check — run behind a spinner on stderr. Colour is
presentation only: the status keyword stays in the text, so `doctor --json` and a piped run read
exactly the bytes a skill was written against. `NO_COLOR=1` turns it off, `FORCE_COLOR=1` forces
it on when piping, and the CLI never asks a question — it is run by agents and by CI.

## Install

Global via npm (any prefix manager works — this is what the workspace uses):

```sh
mise use -g npm:@whiteblossom/forklift@0.6.0
```

From a checkout (Bun, no npm dependencies):

```sh
bun bin/forklift --help
```

Every command below runs as bare `forklift <cmd>` once installed.

## Commands

All ten commands resolve the registry from the cwd's `.forklift/registry.yaml` unless a `--registry`/`--target` flag says otherwise.

|Command|Does|Exit codes|
|---|---|---|
|`render`|Render the sync skill from template + registry, splice the fork-commits table into `harness.fork_doc`, write `AGENT.md`|0 ok, 1 render/validation failure, 2 usage|
|`install`|Write/refresh every artifact the registry feeds into the target's adapter dirs (skills, command stub, rules doc, checklist extension, `harness.lock`)|same|
|`check`|Recompute both render and install artifacts in memory and rewrite only what drifted — the drift detector for everything the harness writes|0 in sync, 1 drift repaired (or validation failure), 2 usage|
|`sync`|Rebase the fork onto upstream with the registry's pre-flight gates and verification suite (`--dry-run`, `--push`, `--continue`, `--revert`, `--verify`, `--status`, `--tag`, `--rebaseline`, `--rebaseline-only`, `--json`)|0 ok, 1 sync/validation failure, 2 usage|
|`status`|Last sync state + recent log entries|same as sync|
|`verify`|Standalone verification suite alone (conflict markers, symbol health, commit survival, protecting tests, feature coverage, import liveness, typecheck, deletion audit, native sentinel)|same as sync|
|`diff`|Preview what upstream will bring: hot spots, risk, conflicts|same as sync|
|`register`|Fold fork commits that touch unregistered paths into the registry (`--verbose`, `--accept`)|0 all covered, 1 unregistered found or unclassifiable, 2 usage|
|`reorg`|Rebuild the fork's history into one topical commit per registered feature — no patch replay, so no conflicts by construction. Triage report by default; `--rebuild` (with `--stay-on-wip`, `--overlays-from`, `--dump-conflicts`) rewrites history|0 ok, 1 aborted, 2 usage|
|`doctor`|The drift checks as commands with pass/fail criteria|0 all pass, 1 failures|

Exit-code convention everywhere: **0** ok, **1** validation/registry/sync failure, **2** usage. `sync --continue` adds: no rebase in progress → 1; residual conflict markers → 2; pre-continue gate failure → 2.

## Three layers

|Layer|What it is|Where|Change it when|
|---|---|---|---|
|**Data** — registry|What the fork owns: features, owned paths, divergences, removals, owned symbols, harness config, knowledge prose|`<repo>/.forklift/registry.yaml`, schema: `schema/registry.schema.yaml`|A feature lands, is dropped, or the repo's remotes/commands change|
|**Code** — render/install/sync|Deterministic template → artifact rendering, the lifted sync runner, drift detection. No judgment; byte-stable substitutions + the GENERATED tables|`templates/`, `lib/`|The artifact format or a sync gate changes|
|**Judgment** — skills|Agent-executable procedures: init (detect + draft), doctor (the drift checks)|`skills/`, workflow: `skills/forklift-maintain/SKILL.md`|A check proves wrong or slow; the workflow learns something new|

## What the harness writes

Forklift owns these generated artifacts; never hand-edit them (run the command, or `forklift check` to repair drift):

```text
<adapter skills dirs>/sync-upstream/SKILL.md    forklift render   (+ each adapter that already holds it)
AGENT.md                                       forklift render
<harness.fork_doc> fork-commits table          forklift render   (when render_fork_commits: true)
<rules dir>/<fork-short>-feature-registry.md   forklift install  (adapter dirs that exist)
<extensions dir>/<fork-short>-checklist.generated.ts  forklift install (when shared_files is set)
<adapter commands dirs>/forklift-*.md forklift install (one stub per situation)
<adapter commands dirs>/forklift.md forklift install (the router; one word to route by intent)
.forklift/harness.lock                         forklift install  (version stamp doctor check 7 reads)
```

The command stubs are thin: they name a situation, defer to the skill that carries the procedure,
and list the commands to run — one copy of the judgment, one word to type. They are
`/forklift-bootstrap`, `/forklift-feature`, `/forklift-sync`, `/forklift-audit` and
`/forklift-rebuild`. A stub the harness wrote under a retired name (`sync-upstream`) is removed on
the next install; a file without the harness stamp is never touched.

**Artifact ownership in two steps.** `forklift render` computes every render-owned artifact in memory (`RenderArtifact[]`) and writes it; `forklift install` additionally writes the artifacts that depend on *which adapter directories the target already has* (rules, checklist extension) plus the version lock. `forklift check` runs both builders against the same code paths and rewrites only what differs, so drift can never be "the checker and the writer disagree".

**Fork-owned artifact templates are rendered from your registry, not this repo's.** `harness.rules_advisory` is the body of your feature-registry rule (previously a hand-maintained copy in the tool dir), `harness.extension_advisory` the checklist extension's advisory comment, `harness.shared_files`/`src_paths`/`registry_path` fill the generated constants. That keeps one registry per fork and zero hand-copied files to forget.

## Registry layout

```yaml
generatedAt: 2026-09-30T00:00:00Z   # informational; harness.lock stamps its own install time
expected_fork_commit_count: 97       # commit-survival baseline (verify check 5)
features: [...]                      # what the fork owns
divergences: [...]                   # upstream-owned, take upstream
removals: [...]                      # deleted on purpose
owned_symbols: [...]                 # symbols grafted into shared files
harness:                             # every repo-specific value checks need
  version: 1
  fork: {name, short, remote, branch}
  upstream: {name, short, remote, branch}
  project: {languages, source_roots, test_globs, typecheck_command, test_command,
            lint_command, conflict_marker_globs, package_aliases}
  checks: {behavioral_source_regex, native_sentinel, footprint_baseline, ...}
  sync_command: "forklift sync"      # rendered into skill/command prose
  registry_path: ".forklift/registry.yaml"
  fork_doc: "docs/maintaining-<fork>-fork.md"
  render_fork_commits: true          # splice the fork-commits table during render
  shared_files: [...]                # files the fork adds symbols into upstream-owned
  src_paths: [...]                   # dirs the checklist extension audits commits in
  extension_advisory: "..."          # checklist extension's advisory comment
  rules_advisory: |                  # body of the generated feature-registry rule
    ...
knowledge: |                         # conflict semantics rendered into the skill
  decision tree, porting protocol, gotchas
```

Remotes and branches are data, never assumed: `oh-wiblo-pi` uses `origin`/`upstream` on `main`, `k8s_gateway` uses `malarinv`/`origin` on `master`.

## Workflows

1. **Bootstrap a fork** — `skills/forklift-init/SKILL.md`: detect remotes/branch/languages, draft a registry from fork commits (`status: draft` on every feature), run doctor for the migration worklist.
2. **Climb out from drift** — `skills/forklift-doctor/SKILL.md`: the drift checks (registry completeness, stale paths, feature coverage, import liveness, commit survival, deletion audit, version drift, upstream drift forecast), each a copy-pasteable command with pass/fail criteria.
3. **Sync** — `forklift sync` (the skill rendered by `forklift render` walks the same workflow): pre-flight gate, rebase, conflict protocol, post-sync verification, optional force-push and tag.
4. **Register new fork work** — `forklift register` (report), `forklift register --accept` (write) after a feature lands or a divergence appears.
5. **Rebuild history topically** — `forklift reorg` (triage report) before any rebase on a fork whose history is interleaved; `--rebuild` replays the final tree state per feature instead of patches.
6. **Day-to-day** — `skills/forklift-maintain/SKILL.md`: the operator loop (render → install → check → doctor → commit) framed for an agent maintaining its own fork.

## The rebaseline: the one step an agent used to do by hand

After every rebase the fork's `expected_fork_commit_count` has to be re-recorded, because the
rebaseline commit itself lands in the range the count describes. The count is self-referencing,
so the value that converges is the one measured *after* that commit exists — and a render that
lands in the same commit writes a fork-doc `Total` that is one behind. Agents got this wrong
often enough that the tool now owns it:

```bash
forklift sync --rebaseline        # after a rebase, before the push
forklift sync --rebaseline-only   # on its own: never fetches, never rebases
```

`--rebaseline` records the count the range will have, re-renders every artifact the registry
describes (the sync skill, `AGENT.md`, the fork-commits table in the fork doc), commits them as
one atomic commit, then renders once more and amends that commit so `Total` matches. It prints
the `Last Sync Point` values afterwards and exits without committing when the bookkeeping is
already converged.

**For an agent driving a sync:** run `forklift sync --rebaseline` instead of editing
`expected_fork_commit_count` and re-rendering by hand. The rendered skill's post-rebase
checklist says the same, and the maintain skill carries the manual recipe as the fallback for
a fork pinned to an older CLI.

## Tool adapters

`adapters/tools.yaml` declares where each agent tool keeps its skills and commands (`.pi`, `.omp`, `.claude`, `.cursor`, `.opencode`, `.github/prompts`) and, where the tool supports them, its rules dir and extensions dir. `forklift render` updates the rendered `sync-upstream` skill in the adapter skills dirs that already hold it; `forklift install` writes the static skills (init, doctor) and the command stub, plus the fork-owned rules doc and checklist extension into adapter dirs that already exist — always only into directories the target already has.

## Architecture

`docs/architecture.md` — the pipeline from registry to artifacts, what each command owns, the state machine `sync` implements across runs (interrupted/rebasing/verifying/completed), and how `reorg` reuses the same state as `sync` so `sync --revert` stays aware of a rebuild in flight.

`docs/quickstart.md` — the operator's view: how to use forklift with an agent, with a prompt per situation (bootstrap a fork, implement a feature, sync with upstream, audit, rebuild history).

## Verification status

Dogfooded into `oh-wiblo-pi` itself: the legacy `.omp/skills/sync-upstream/` layer was retired after the lift — rendered `SKILL.md` tables are byte-identical to the pre-lift generator's output, `bun check:ts` passes on the hand-written extension and its generated constants sibling, `forklift check` converges to zero drift, and `forklift doctor` reports 7/7 green on the post-cutover tree.

## Last Sync Point

Operators record the last successful sync of the fork this README ships with
here — the `sync-upstream` skill's post-rebase checklist points at this section
when the fork keeps no other maintenance doc:

- **Date:**
- **Upstream base:**
- **Notes:**
