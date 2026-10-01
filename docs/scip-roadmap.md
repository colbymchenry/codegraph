# codegraph-scip roadmap

Status: planned, not started. Decided 2026-10-01. For what is already built, see [`FORK.md`](../FORK.md).

**Goal:** an accurate, fresh, compiler-verified call graph that measurably helps agents, on any machine, without hand-holding.

**Where it stands:** recall 98–100% at 100% precision (TS/Python/Go), 99% recall at 99% precision (Rust). Re-indexing only changed files works for tsgo and Python, and a patch produces a graph identical to a full rebuild. Remaining problems:
- ~11% of call edges are still unverified (vscode 99.8k of 915k);
- a small edit costs ~40 s on vscode (~20 s patching the index, ~20 s merging);
- a first index costs ~4 min and ~10 GB of RAM;
- nobody has measured whether agents actually answer better;
- maintenance and setup are still manual.

## Decisions

| Question | Decision |
|---|---|
| Keep supporting scip-typescript now that tsgo is preferred? | **Yes.** Project-level patching (2.4) and plain-JS coverage (4.6) are in scope for it. |
| Accept larger tsgo indexes (~101 → ~120 MB on vscode) for one splice rule? | **Yes** (1.1). |
| When to run the agent eval? | **After the fix phases** (Phase 6 follows 0–5). |
| Fixed patch caps or per-unit cost estimates (2.2)? | **Measured cost, with a hard cap.** Patch when the estimated patch time is under half of the last full run's time (recorded in the index metadata); never past 500 files. |
| May the fork publish its own GitHub releases (7.4)? | **Not yet.** 7.4 is deferred; install stays local (build the bundle, re-link). |

## Rules every indexer's output must meet

Once these hold, the shared core needs no per-indexer special cases:

1. **Every document defines everything its file declares.**
2. **Paths are made relative to the repo whenever an index is read.**
3. **Symbol names don't change when other code is edited.** Each indexer declares this.

A language adapter (`IndexerSpec`) then only declares its capabilities: detection, command, how it splits runs, its smallest re-indexable unit with a rough cost, and its literal rules. Indexers differ legitimately in granularity and cost; the core treats them the same.

| Indexer | Smallest unit | Names survive edits | Defines all it declares | Patchable |
|---|---|---|---|---|
| tsgo-index | file (`--only`) | yes | partial runs only (fixed by 1.1) | yes |
| scip-typescript | project (tsconfig) | yes | yes | planned (2.4) |
| scip-python | directory (`--target-only`; ~10–15 s per run) | yes | yes | yes |
| scip-go | package (`index ./pkg/...`) | yes | yes | planned (2.3) |
| rust-analyzer | whole workspace only | mostly (nested `fn imp` collide) | yes | no; always a full run |

## Phase 0: housekeeping

| # | Task | Why | How | Check |
|---|---|---|---|---|
| 0.1 | **Done.** One re-index per repo at a time | Upstream's writer lock already allows one watcher (so one background scheduler) per project, but a CLI `scip index` / `import` could still run beside it: two full indexers, ~16 GB on vscode | `tryReindexLock` (`.codegraph/scip/reindex.lock`, upstream's `FileLock`) around indexers + merge; the scheduler skips and retries when idle, the CLI fails with a message | Test: two schedulers on one repo, only one runs; a dead holder's lock is taken over |
| 0.2 | **Done.** Take TypeScript 7.1 out of global npm | The global `tsc` is currently a 7.1 nightly | `npm i --prefix ~/.codegraph/tools`, a folder `findTsgo` searches after the project's `node_modules`; then `npm rm -g typescript` | `tsc` back to the user's own; tsgo still found |
| 0.3 | **Done.** Remove old bundle versions on install | 285 MB per bundle in `~/.codegraph/versions` | `install.sh` takes `CODEGRAPH_ARCHIVE` (a local bundle), so the fork installs through upstream's link-and-prune | One directory left |
| 0.4 | **Done** (vscode, Playwright not rerun yet). Reproducible benchmarks | The corpora and baselines lived in a job's temp folder | `scripts/scip-eval/corpora.sh`: clone pinned commits (vscode 73d5322b, Playwright a8c1a59, Django 026b005, cobra adbc881, ripgrep 3fce3b5), index, run the evals | A rerun matches FORK.md's tables |

## Phase 1: make the core consistent (no behaviour change)

| # | Task | How | Check |
|---|---|---|---|
| 1.1 | tsgo defines everything it declares, in full runs too | Always collect declarations (today only in `--only` runs) | Index size recorded; vscode merge identical edge for edge |
| 1.2 | Rebase paths whenever an index is read | Move the rebasing out of `patchIndex` into the reader; it also fixes `scip import` of a subfolder-rooted index | Existing tests; a new import test with a subfolder-rooted index |
| 1.3 | Simplify the splice | With 1.1, replace whole documents and drop the "add missing definitions" step | Patch equals full: 0 differences on vscode and Django |

## Phase 2: one shared planner for re-indexing changed files

| # | Task | How | Check |
|---|---|---|---|
| 2.1 | Indexers declare a re-index unit | `unitOf(file)` (file, directory, package, project or workspace), `runsFor(units)`, rough cost per unit | Unit tests per indexer |
| 2.2 | Decide patch vs full in one place | The planner maps changed files plus importers to units. Each adapter declares a cost per unit (tsgo ~0.1 s per file, scip-python ~15 s per directory, scip-go per package, measured in 2.3); the index metadata records the last full run's duration. Patch when units × cost < ½ × last full run, never past 500 files | tsgo and Python patch the vscode/Django edits as today; a change too big for a patch falls back to a full run |
| 2.3 | Go patching | Unit = package: `scip-go index ./pkg/... --output …` | Patch equals full on cobra and one larger Go repo; time measured |
| 2.4 | scip-typescript patching | Unit = tsconfig project; small projects take seconds, vscode's `src/` doesn't, so that one stays a full run | Patch equals full on vscode with an edit in a small project |
| 2.5 | Patch-equals-full as a permanent check | `scripts/scip-eval/patch-equivalence.ts`: edit → patch → full rebuild → diff, per language corpus | Runs in CI on the small fixtures |

Rust stays full-only: rust-analyzer can only index the whole workspace (ripgrep takes ~13 s).

## Phase 3: freshness (incremental merge)

| # | Task | How | Check |
|---|---|---|---|
| 3.1 | Merge only what changed | Re-judge call sites in re-indexed files, plus sites elsewhere that call into them (found from the installed index); reconcile only edges touching those files | Patch equals full; vscode small edit from ~40 s to ~25 s |

Deferred:
- **A tsgo process kept running between edits.** Updates would cost milliseconds, but it holds ~8 GB for vscode; only worth it as an opt-in for one big repo.
- **Verifying edges only when queried.** It changes the product, and the eval and regression guard would no longer apply.

## Phase 4: coverage (the ~11% unverified)

| # | Task | How | Check |
|---|---|---|---|
| 4.1 | Break unverified edges down by cause | Per corpus: target in an oversize file, missing dependency, untyped call site, no matching node | A table in FORK.md; it decides the order of 4.2–4.6 |
| 4.2 | Oversize declaration files | Let codegraph index declaration-only `.d.ts` over the 1 MB limit, or have the merge create nodes for their definitions | Playwright: unverified edges and dispatch edges fall |
| 4.3 | Missing-dependency warning | A lockfile present but no `node_modules` / venv → "run `npm ci` / create the venv" | Shown on Django and on a Playwright copy without `npm ci` |
| 4.4 | Verify `references` edges | Same site machinery, for type references (vscode: 72k method → interface) | New eval rows; precision ≥ 95% |
| 4.5 | Rust trait edges | Find `impl Trait for X` in the source and check both names against the index's definitions; generic impls stay unverified. Ask upstream to emit relationships and unique nested-function names | ripgrep and the fixture: trait edges verified |
| 4.6 | Plain JS without a tsconfig | Give tsgo-index an inferred-project mode (scip-typescript keeps `--infer-tsconfig`) | Django's JS indexed by tsgo |

## Phase 5: first index (time and memory)

| # | Task | How | Check |
|---|---|---|---|
| 5.1 | Overlap the indexer with codegraph's tree-sitter pass | Start the indexer while codegraph extracts; snapshot hashes after extraction; merge at the end | vscode first index from ~3m50s to ~2m50s |
| 5.2 | Merge in chunks | Sites and writes by file group instead of all at once | vscode merge memory below ~3.8 GB; same graph |

## Phase 6: measurement (after the fixes)

| # | Task | How | Check |
|---|---|---|---|
| 6.1 | Agent eval | Upstream's `scripts/agent-eval`: regular vs fork on "who calls X / change X safely" tasks; correctness, tokens, tool calls | A decision on 6.2 |
| 6.2 | Show verification in answers (if 6.1 supports it) | `explore` / `callers` list compiler-verified callers first and mark the rest | Re-measured by 6.1 |
| 6.3 | Eval coverage | Extend `compare.ts` to type edges, interface calls and `instantiates` | New gate rows in FORK.md |

## Phase 7: maintenance and distribution

| # | Task | How | Check |
|---|---|---|---|
| 7.1 | TypeScript 7.1 stable | When it ships: re-pin CI and the tool folder, rerun the evals | Evals unchanged |
| 7.2 | Upstream health | Run upstream's suite on `scip`; rebase per upstream release (only 3 upstream files touched) | Suite green |
| 7.3 | Multi-OS | CI matrix (Linux/macOS/Windows) for the SCIP suite; fix tsgo-index's `/`-only paths; build every platform's bundle | Green on all three |
| 7.4 | Releases and upgrade (**deferred**: no releases yet) | Later: CI builds bundles (with the native kernel) on tag, and `codegraph upgrade` installs from the fork's release | — |

## Order

1. **Phase 0:** cheap, and 0.1 prevents running out of memory.
2. **Phase 1:** simplifies everything after it.
3. **Phase 3:** the biggest freshness win.
4. **4.1, then 4.2:** the biggest accuracy win; 4.1 decides the rest of Phase 4.
5. **Phase 2**, including Go (2.3) and scip-typescript (2.4).
6. **The rest of Phase 4.**
7. **Phase 5.**
8. **Phase 6:** the agent eval, then 6.2 and 6.3.
9. **Phase 7.** 7.1 whenever TypeScript 7.1 ships; 7.2 at each upstream release; 7.4 when releases are wanted.
