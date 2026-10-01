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
| Accept larger tsgo indexes (~101 → ~120 MB on vscode) for one splice rule? | **Yes** (1.1). Measured: 144 → 178 MB, tsgo 75 → 82 s, merge 23 → 26 s. |
| When to run the agent eval? | **After the fix phases** (Phase 6 follows 0–5). |
| Fixed patch caps or per-unit cost estimates (2.2)? | **Measured cost, with a hard cap.** Patch when the estimated patch time is under half of the last full run's time (recorded in the index metadata); never past 500 files. |
| May the fork publish its own GitHub releases (7.4)? | **Not yet.** 7.4 is deferred; install stays local (build the bundle, re-link). |

## Rules every indexer's output must meet

Once these hold, the shared core needs no per-indexer special cases:

1. **Every document defines everything its file declares** that another file can call (a function-local is reachable only from its own file, which is re-indexed whenever it changes).
2. **Paths are made relative to the repo whenever an index is read.**
3. **Symbol names don't change when other code is edited.** Each indexer declares this.

A language adapter (`IndexerSpec`) then only declares its capabilities: detection, command, how it splits runs, its smallest re-indexable unit with a rough cost, and its literal rules. Indexers differ legitimately in granularity and cost; the core treats them the same.

| Indexer | Smallest unit | Names survive edits | Defines all it declares | Patchable |
|---|---|---|---|---|
| tsgo-index | file (`--only`) | yes | yes (1.1) | yes |
| scip-typescript | project (tsconfig) | yes | yes | yes |
| scip-python | directory (`--target-only`; ~10–15 s per run) | yes | yes | yes |
| scip-go | package (`index ./pkg`), per module | no: an interface method is `#m.` or `#m().` by what the run indexed (the merge reads the defined twin) | yes | yes |
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
| 1.1 | **Done.** tsgo defines everything it declares, in full runs too | Always collect declarations outside function bodies (before: only in `--only` runs). Locals too would double the index (307 MB) and tsgo time (138 s) for nothing | vscode: 144 → 178 MB, 75 → 82 s; graph identical (0 of 2,081,375 edges differ) |
| 1.2 | **Done.** Rebase paths whenever an index is read | Move the rebasing out of `patchIndex` into the reader; it also fixes `scip import` of a subfolder-rooted index | Existing tests; a new import test with a subfolder-rooted index |
| 1.3 | **Done.** Simplify the splice | With 1.1, replace whole documents and drop the "add missing definitions" step | Patch equals full, with a new call into a function nothing called before: 0 of 2,081,396 edges differ on vscode (patch 47 s vs full 105 s), 0 of 216,198 on Django (42 s vs 98 s) |

## Phase 2: one shared planner for re-indexing changed files

| # | Task | How | Check |
|---|---|---|---|
| 2.1 | **Done.** Indexers declare a re-index unit | `unitOf(file)` (file, directory, package, project or workspace), `runsFor(units)`, rough cost per unit | Unit tests per indexer |
| 2.2 | **Done.** Decide patch vs full in one place | The planner maps changed files plus importers to units. Each adapter declares a cost per unit (tsgo ~0.1 s per file, scip-python ~15 s per directory, scip-go per package, measured in 2.3); the index metadata records the last full run's duration. Patch when units × cost < ½ × last full run, never past 500 files | tsgo and Python patch the vscode/Django edits as today; a change too big for a patch falls back to a full run |
| 2.3 | **Done.** Go patching | Unit = package: `scip-go index ./pkg/... --output …` | golang/tools (3 modules, 1,392 docs): 2 packages patched in 1.5 s vs 8.5–25.9 s full; patch equals full (97,901 edges) |
| 2.4 | **Done.** scip-typescript patching | Unit = tsconfig project; small projects take seconds, vscode's `src/` doesn't, so that one stays a full run | vscode, edit in `extensions/simple-browser`: 1 project patched in 36 s vs a 383 s full run; patch equals full (2,047,161 edges) |
| 2.5 | **Done.** Patch-equals-full as a permanent check | `scripts/scip-eval/patch-equivalence.sh`: patch → full rebuild → diff, after editing a corpus | It found scip-go's twin names on golang/tools; the CI form is the tsgo fixture test |

Rust stays full-only: rust-analyzer can only index the whole workspace (ripgrep takes ~13 s).

## Phase 3: freshness (incremental merge)

| # | Task | How | Check |
|---|---|---|---|
| 3.1 | **Done.** Merge only what changed | Re-judge call sites in re-indexed files, plus sites elsewhere that call into them (found from the installed index); reconcile only edges touching those files | Patch equals full (vscode 0 of 2,081,396 edges differ, Django 0 of 216,198); vscode 28-file edit: merge 20.6 → 6.0 s, total 47 → 34 s (27 s of it tsgo re-indexing); Django merge 2.0 → 0.6 s |

Deferred:
- **A tsgo process kept running between edits.** Updates would cost milliseconds, but it holds ~8 GB for vscode; only worth it as an opt-in for one big repo.
- **Verifying edges only when queried.** It changes the product, and the eval and regression guard would no longer apply.

## Phase 4: coverage (the unverified edges)

Ordered by 4.1's measurement (FORK.md, "Why edges stay unverified"). Untyped call sites ("no reference": vscode 36%, Django 91%) have no fix in the merge; the compiler resolved nothing there.

| # | Task | How | Check |
|---|---|---|---|
| 4.1 | **Done.** Break unverified edges down by cause | `scripts/scip-eval/unverified.ts`, six corpora | The table in FORK.md |
| 4.2 | **Done.** Overloaded functions | tsgo and scip-typescript define an overloaded function at its first signature; codegraph's node is the implementation. Map a definition no node contains to the file's only node of that name and kind starting after it | vscode "target without node" 51,798 → 1,955 (with a lookup fix for methods named `toString` & co.); unverified 12.9% → 7.1%; eval unchanged |
| 4.3 | **Done.** Files no project owns | TS/JS files outside every `tsconfig.json`: tsgo-index indexes them in an inferred project (also plain JS without any tsconfig). Language roots below the repo root: detect `Cargo.toml` / `go.mod` / `pyproject.toml` in subfolders | No document: vscode 14,839 → 293, Playwright 19,796 → 359, codegraph 23,218 → 1,169; unverified Playwright 30.2 → 14.3%, codegraph 68.4 → 5.3%, vscode 7.1 → 6.3%; Django's JS indexed; eval unchanged |
| 4.4 | **Done.** Rust call sites | `Ok(…)` / `Some(…)` / tuple-struct constructors: rust-analyzer names a type, the heuristic records a call; key them both ways. Multi-line chains: match a call within its expression's lines, not only the first | ripgrep: unverified 2,460 → 118 (19.1% → 1.1%); eval unchanged (graph judged at codegraph's line) |
| 4.5 | **Done.** Verify `references` edges | Judged at their own site (file, line, name), verified or deleted, never inserted. Compaction keeps references only at codegraph's reference sites; tsgo-index resolves just those lines (`--refs`) | `scripts/scip-eval/references.ts`, rows in `corpora.sh`: precision Playwright 91.4% → 97.5% (2,358 deleted, none judged right), codegraph 99.2% → 99.6%; index +40% on Playwright; eval unchanged. vscode not measured |
| 4.6 | **Done** (minus the upstream ask). Rust trait edges | `impl Trait for X {` headers (`rust.ts implHeader`): compaction keeps their type references, the merge judges them as X's `implements` edge at the header's line; generic impls stay unverified. Still open: ask rust-analyzer to emit relationships and unique nested-function names (an outside action, left to the maintainer) | ripgrep: 125 / 125 `implements` verified; fixture: `Invoice`/`Order` → `Pricer`; eval unchanged |
| 4.7 | **Done.** Missing-dependency warning | A lockfile but no `node_modules` → its install command (`npm ci`, `pnpm install`, …); no venv → the command that builds one from `uv.lock` / `poetry.lock` / `requirements.txt` / `pyproject.toml` | Django: "pyproject.toml found: run `python -m venv .venv && .venv/bin/pip install -e .`"; a Playwright copy without `node_modules`: "package-lock.json but no node_modules … run `npm ci`" |
| 4.8 | **Deferred.** Oversize declaration files | Let codegraph index declaration-only `.d.ts` over the 1 MB limit, or have the merge create nodes for their definitions. Measured small: Playwright 709 edges. The limit is read at six upstream call sites (extraction ×2, resolution, MCP freshness, the oversize hash stamp the hash gate shares), so a per-path limit is a core divergence that every upstream merge would carry; not worth 709 edges. Revisit if a corpus shows more | Playwright: those 709 fall |

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
4. **4.1 (done), then 4.2:** overloaded functions are the largest measured cause (vscode 45% of unverified).
5. **Phase 2**, including Go (2.3) and scip-typescript (2.4).
6. **The rest of Phase 4.**
7. **Phase 5.**
8. **Phase 6:** the agent eval, then 6.2 and 6.3.
9. **Phase 7.** 7.1 whenever TypeScript 7.1 ships; 7.2 at each upstream release; 7.4 when releases are wanted.
