# codegraph-scip

A private fork of [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph). It merges
compiler-grade call edges from [SCIP](https://github.com/sourcegraph/scip) indexers into codegraph's
graph. codegraph's heuristic resolver still handles everything an indexer can't see.

Origin: the POC in `dotclaude` → `research/2026-09-30-scip-codegraph-poc/` (branch `worktree-scip-codegraph-poc`),
including `FORK-PLAN.md`. On Django, the POC took "who calls X" recall from 47–60% to 99%, at 99–100% precision.

## Branches

| ref | what |
|---|---|
| `main`, tags `vX.Y.Z` | mirror of upstream (`git fetch upstream && git push origin 'refs/remotes/upstream/*:refs/heads/*' --tags`) |
| `scip` | the fork: rebased onto each upstream release tag |
| tags `vX.Y.Z-scip.N` | fork releases |

Upstream's `Release` and `Deploy site` workflows are disabled on this repo. Only `scip CI` runs here.

**Rebase onto a new upstream release:** `git fetch upstream --tags && git rebase vX.Y.Z scip`.
Then run the SCIP suite, the upstream suite and the eval gate (below) before cutting `-scip.N`.
Upstream files the fork touches (keep these hunks small):

- `src/index.ts`: the `runScipPass` hook in `indexAll`, the `onSynced` hook in `sync`, the reindex scheduler in `watch`/`unwatch`, and `scipReadDb`/`scipWrite`
- `src/bin/codegraph.ts`: `registerScipCommands`, the update-check default, and the `upgrade` refusal
- `src/mcp/tools.ts`: `scipFlowNote` and `scipTrailNote`

Everything else is new, under `src/scip/`, `__tests__/scip/`, `__tests__/fixtures/scip-ts/` and `scripts/scip-eval/`.

## Using it

```sh
codegraph scip index            # run each detected language's indexer (must be on PATH), then merge
codegraph scip import out.scip  # install an index built elsewhere, then merge
codegraph scip status
```

Indexers are never auto-installed:

| language | indexer | detected by |
|---|---|---|
| TS/JS | `npm i -g @sourcegraph/scip-typescript` | `tsconfig.json`, `jsconfig.json`, `package.json` |
| Python | `npm i -g @sourcegraph/scip-python` | `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt` |
| Go | `go install github.com/scip-code/scip-go/cmd/scip-go@latest` (packages must build) | `go.mod` |
| Rust | `rustup component add rust-analyzer` (uses its `scip` subcommand; needs `cargo`) | `Cargo.toml` |

To run one through `npx` instead, put this in `codegraph.json`:

```json
{ "scip": { "python": { "cmd": "npx", "args": ["-y", "@sourcegraph/scip-python", "{args}"] } } }
```

`"python": false` disables a language. `cmd`, `args` and `env` replace the defaults. In `args`, `{args}` splices in the adapter's own arguments and `{out}` is the output path.

**TS/JS monorepos.** A repo with several projects (a `tsconfig.json` / `jsconfig.json` per package, as in vscode's `src/` plus one per extension) is indexed **one project per process**. Projects are found with `git ls-files`, or by walking the tree outside git; `node_modules` is ignored. The outputs are concatenated; SCIP `Index` messages concatenate into one valid index. scip-typescript holds each project's whole type-checked program in memory, so one process over all of them runs out of heap on large monorepos. Split, peak memory is the largest single project. A project that fails (e.g. a test fixture with a broken tsconfig) is reported as a warning and its files stay heuristic-only. The run fails only if every project fails. The indexer's Node heap defaults to 60% of physical memory (vscode's `src/` alone needs over 6 GB) unless `NODE_OPTIONS` sets one; `scip.typescript.env` overrides it. `{args}` / `{out}` in an override apply per project.

**Python environments.** A `.venv/` or `venv/` (with `pyvenv.cfg`) is activated for the indexer (`VIRTUAL_ENV`, `PATH`). Its packages are passed to scip-python as an `--environment` manifest read from `*.dist-info/RECORD`, so uv venvs without `pip` work. Without a venv the manifest is empty and `scip index` warns. Project code still resolves; calls into dependencies don't.

After a project opts in with `scip index`, the MCP server (and anything else that `watch`es) re-indexes on its own. That happens 60 s after the last synced edit, at most every 10 min, niced. A new index replaces the old one only when its count of resolved calls (calls and instantiations of project symbols; imports and type references don't count) dropped by no more than 20%. Otherwise the old index stays and the reason is logged.

## How edges are decided

Call sites are keyed by (caller node, line, callee name, kind), as in the POC. The caller comes from **codegraph's own node spans**, not SCIP's ranges. That is the narrowest enclosing function or method, unless a class defined inside it is narrower. Failing that it is the narrowest enclosing container node (the kinds are listed in `CONTAINER_KINDS` in `src/scip/sites.ts`), and failing that the file. This is the same caller codegraph's extractors record, so decorators belong to the class, calls in a local class body to that class, and top-level code to the file. An earlier version used SCIP's definition ranges, which include decorators. It disagreed with the heuristic's caller on thousands of Django sites and produced parallel edges.

| case | action |
|---|---|
| agree | heuristic edge → `provenance='scip'` |
| conflict (incl. SCIP → stdlib/dependency) | compiler wins: heuristic edge deleted, SCIP target inserted |
| SCIP-only | inserted as `provenance='scip'` (nothing to link if the target is external) |
| heuristic-only in a file SCIP covers | kept, `metadata.scipSilent = true` → shown as *unverified* |
| SCIP edge into or out of a file edited since the index | `metadata.scipStale = true` until the next reindex |

The **hash gate** decides whether a document is used. It is used only when three hashes are equal: the file's content hash when the indexer started, `files.content_hash`, and the file on disk. `scip import` has no indexer start to snapshot, so the index file's mtime stands in for it: a source modified after the index was written is left to the heuristic until a reindex. Copy an index with its mtime intact (`cp -p`), or the copy time becomes the build time. Synthesized dynamic-dispatch edges (`provenance='heuristic'`) are never touched.

Differences from the POC:

- A target that the index *defines* but that has no codegraph node (or sits in a stale document) is **unknown**, not external. It never deletes a heuristic edge.
- Callable-ness comes from the mapped node kind, not the symbol suffix. This lets TS `const f = () => …` count.
- `new X()` (TS, via scip-typescript's `` `<constructor>` `` symbol) and Python's `X()` (a class symbol followed by `(`) → `instantiates`, matching codegraph's own edge kind. So are Go composite literals (`&X{…}`, `X[T]{…}`) and Rust struct literals (`X { … }`). Go excludes slice/map element types and return types before a body. Rust excludes `impl`/`where` headers, `-> X {`, and destructuring patterns.
- Protobuf is decoded by a ~250-line reader (`src/scip/reader.ts`) instead of `@bufbuild/protobuf` plus codegen. The fork adds no runtime dependency. It accepts both the legacy `int32` ranges and the typed ranges.

MCP output: Flow steps read `↓ calls (compiler-verified)` or `(unverified: …)`. Trail entries get ` [unverified]`.

## Eval gate

```sh
npx tsx scripts/scip-eval/compare.ts <repo> <index.scip> <heuristic.db> <merged.db> --random 50 --seed 1 --prefix src/ --rg-type ts
```

Pass bar per language (2 seeds × 50 random targets): precision ≥ 95%, recall ≥ codegraph-only, import ≤ 30 s.

| language | corpus | seed | grep naive R / P | codegraph R / P | codegraph+SCIP R / P | index + merge |
|---|---|---|---|---|---|---|
| TS | codegraph v1.6.1 `src/` (250 docs) | 1 | 100% / 44% | 90% / 100% | **100% / 100%** | 7.5 s + 0.5 s |
| TS | same | 2 | 100% / 56% | 90% / 100% | **100% / 100%** | |
| Python | Django (`bench-corpus/arm_grep` @ 026b005, 2,928 docs, no venv) | 1 | 99% / 10% | 78% / 82% | **100% / 100%** | 98.5 s + 3.6 s |
| Python | same | 2 | 100% / 24% | 75% / 96% | **100% / 100%** | |
| Go | spf13/cobra @ adbc881 (37 docs) | 1 | 100% / 87% | 100% / 99% | **100% / 100%** | 6.5 s + 0.2 s |
| Go | same | 2 | 100% / 98% | 100% / 99% | **100% / 100%** | |
| Rust | BurntSushi/ripgrep @ 3fce3b5 (104 docs) | 1 | 100% / 7% | 37% / 83% | **100% / 99%** | 12.6 s + 1.0 s |
| Rust | same | 2 | 100% / 22% | 20% / 73% | **100% / 99%** | |

Raw per-seed output (`compare.ts --json`): [`scripts/scip-eval/results/`](scripts/scip-eval/results/). Indexers used: scip-typescript 0.4.0, scip-python 0.6.6, scip-go 0.2.7, rust-analyzer 2026-09-28. Flags: `--rg-type py --prefix django/`, `--rg-type go`, `--rg-type rust`.

| corpus | heuristic edges verified | wrong removed | missing added | left unverified |
|---|---|---|---|---|
| codegraph `src/` | 8,417 | 127 | 647 | 1,389 |
| Django | 53,139 | 12,035 | 23,904 | 33,601 |
| cobra | 2,637 | 160 | 1 | 48 |
| ripgrep | 4,447 | 1,080 | 5,957 | 2,442 |

After the merge, `django.urls.base.reverse` has 1,267 caller edges from 867 distinct callers, up from 1, matching the POC.

The Django codegraph-only baseline (75–78% recall) is higher than the POC's 47–60%, for three reasons:
- The targets differ. `compare.ts` samples with a seeded mulberry32, the POC with Python's `random`, so seed 1 does not pick the same 50 callables.
- The heuristic here is upstream v1.6.1, where the POC used v1.6.0.
- The POC's hand-picked targets were deliberately chosen from its conflict samples.

The merged result reproduces the POC: 100%/100% here, 99%/100% there. On cobra, the removed edges are the heuristic linking `buf.String()` / `bv.String()` to a test type's `String`, and pflag's `FlagSet.HasFlags` to `Command.HasFlags`. On ripgrep they include `Vec::new()` → a project `new` and `.push()` → a project `push`.

Known residue: ripgrep's multi-line `const X: T = T { … }` items. codegraph attributes their calls to a variable node whose span is one line, so 18 sites get a parallel file-level SCIP edge. Rust tests defined through macros (`rgtest!(name, |…| {…})`) have no function node, so their calls are attributed to the file. This matches codegraph's convention for top-level code; the heuristic has no edges there at all.

## Status

- Phase 0 (fork setup): done, except the release script (see the job report).
- Phase 1 (core + TS/JS): done.
- Phase 2 (Python): done.
- Phase 3 (Go) and Phase 4 (Rust): done.
- Next: Phase 5, `implements`/`extends` from SCIP relationships, and `references`.
