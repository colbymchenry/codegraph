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
| TS/JS | preferred: `npm i -g typescript@next` (≥ 7.1, see below); else `npm i -g @sourcegraph/scip-typescript` | `tsconfig.json`, `jsconfig.json`, `package.json` |
| Python | `npm i -g @sourcegraph/scip-python` | `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt` |
| Go | `go install github.com/scip-code/scip-go/cmd/scip-go@latest` (packages must build) | `go.mod` |
| Rust | `rustup component add rust-analyzer` (uses its `scip` subcommand; needs `cargo`) | `Cargo.toml` |

To run one through `npx` instead, put this in `codegraph.json`:

```json
{ "scip": { "python": { "cmd": "npx", "args": ["-y", "@sourcegraph/scip-python", "{args}"] } } }
```

`"python": false` disables a language. `cmd`, `args` and `env` replace the defaults. In `args`, `{args}` splices in the adapter's own arguments and `{out}` is the output path.

**TS/JS with tsgo.** When TypeScript ≥ 7.1 (the native compiler) is installed, in the project's `node_modules` or the global npm root, `scip index` uses it instead of scip-typescript, through its API (`typescript/unstable/sync`). The indexer is `src/scip/indexers/tsgo-index.ts`, run as `node dist/scip/indexers/tsgo-index.js`:
- It opens every `tsconfig.json` / `jsconfig.json` project, heaviest first, one at a time in one process. A file is indexed by the first project that loads it.
- It writes only what the merge reads: a reference at the callee name of every call and `new`, and a definition for every callee the project declares. A symbol is named after its first declaration (`` `file`/node-index/Name ``). So an overload maps to its first signature, and a declaration seen from two projects is one symbol.
- A call on a union- or intersection-typed receiver (`a.equals(b)` with `a: A | B`) targets every member's method.
- A project that fails to open is a warning; its files stay heuristic-only.
- Needs Node ≥ 20.19 / 22.12, because it `require()`s the ES-module API. Setting `scip.typescript.cmd` (or `args`) in `codegraph.json` forces scip-typescript.
- The API is marked unstable. The indexer checks for the exports it uses and fails with a clear message if they change. CI pins the nightly it was written against (`.github/workflows/scip-ci.yml`).

On vscode (94 projects, 13.8k files) it indexes in 66 s instead of scip-typescript's 361 s, and writes a 101 MB index instead of 176 MB. Peak memory is 7.7 GB for tsgo plus 2.1 GB for Node. Accuracy is at least scip-typescript's (see the eval below).

**TS/JS monorepos with scip-typescript.** A repo with several projects (a `tsconfig.json` / `jsconfig.json` per package, as in vscode's `src/` plus one per extension) is **split by project size**. Projects and their source-file counts come from one `git ls-files` (or a tree walk outside git; `node_modules` is ignored); each file counts once, for its deepest project. scip-typescript holds a project's whole type-checked program in memory, so one process over everything runs out of heap on a large monorepo, while a process per project pays TypeScript's start-up cost dozens of times.
- A **heavy** project (≥1,500 source files) runs alone, with a Node heap of 60% of physical memory. vscode's `src/` needs over 6 GB.
- **Light** projects are packed into batches of up to 1,500 files or 16 projects, one process per batch with a 3 GB heap. Batches run in parallel: up to 4, at most half the cores, as many as 60% of memory holds.
- A batch that fails is **retried one project at a time**, so one broken project doesn't cost its batch-mates.
- A project that still fails is reported as a warning, and its files stay heuristic-only. The run fails only if everything fails.
- `NODE_OPTIONS` with a heap, or `scip.typescript.env`, overrides the heap defaults. `{args}` / `{out}` in an override apply per run.

**Compact indexes.** Parts are combined through a compaction pass (`src/scip/compact.ts`) before install. It keeps definitions of callables and types, and references that read as a call, `new` or struct literal. Locals, parameters, type annotations and imports are dropped. On vscode the index went from 1,103 MB to 176 MB, and the merge's decode from 6.5 s to 0.9 s. The result is still a standard SCIP file. The merge re-checks every call shape against the (hash-gated, identical) source, so compaction changes size and speed, never an outcome. `scip import` compacts too.

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
- An overloaded method is one SCIP symbol defined at every signature, but codegraph has a node per signature. The symbol maps to the **first** signature, which is where the heuristic's edges point, so they verify instead of moving. On vscode this turned about 16.5k "replaced" edges into agreements.
- With tsgo, an object-literal method *definition* that implements an interface (`{ listen(e) { … } }`) is not a call. scip-typescript records it as a reference to the interface method, so the merge used to add a `calls` edge for it.
- Protobuf is read and written by a small hand-written codec (`src/scip/reader.ts`) instead of `@bufbuild/protobuf` plus codegen. The fork adds no runtime dependency. It accepts both the legacy `int32` ranges and the typed ranges, and streams documents one at a time.

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
| TS (tsgo) | same, judged by scip-typescript's index | 1 | 100% / 44% | 90% / 100% | **100% / 100%** | 1.4 s + 0.3 s |
| TS (tsgo) | same | 2 | 100% / 56% | 90% / 100% | **100% / 100%** | |
| Python | Django (`bench-corpus/arm_grep` @ 026b005, 2,928 docs, no venv) | 1 | 99% / 10% | 78% / 82% | **100% / 100%** | 98.5 s + 3.6 s |
| Python | same | 2 | 100% / 24% | 75% / 96% | **100% / 100%** | |
| Go | spf13/cobra @ adbc881 (37 docs) | 1 | 100% / 87% | 100% / 99% | **100% / 100%** | 6.5 s + 0.2 s |
| Go | same | 2 | 100% / 98% | 100% / 99% | **100% / 100%** | |
| Rust | BurntSushi/ripgrep @ 3fce3b5 (104 docs) | 1 | 100% / 7% | 37% / 83% | **100% / 99%** | 12.6 s + 1.0 s |
| Rust | same | 2 | 100% / 22% | 20% / 73% | **100% / 99%** | |

The tsgo rows are judged by **scip-typescript's** index. An index can't be checked against itself, and this gives an independent compiler's view. Judged by its own index, tsgo also scores 100% / 100% on both seeds.

**Large repo: vscode** @ 73d5322b (14,054 TS files, 4.4M lines, 94 projects), on a 16 GB / 16-thread machine:

| pipeline | build | index size | merge | total |
|---|---|---|---|---|
| codegraph 1.6.1 alone (tree-sitter) | 2m09s | – | – | 2m09s |
| + scip-typescript, one process per project (first version) | 9m56s | 1,103 MB | 67 s | 11m05s |
| + scip-typescript, batched + compacted | 6m01s | 176 MB | 25.6 s | 6m28s |
| + **tsgo** | **66.5 s** | **101 MB** | **22.8 s** | **1m30s** |

(SCIP build and merge times come on top of the 2m09s codegraph index.)

Seeds 1 and 2, judged by scip-typescript's index:

| method | seed 1 R / P | seed 2 R / P |
|---|---|---|
| codegraph only | 82% / 93% | 74% / 94% |
| + scip-typescript | 100% / 100% | 100% / 100% |
| + tsgo | 100% / 100% | 98% / 100% |

tsgo's 13 seed-2 "misses" are all object-literal method definitions that scip-typescript counts as calls (see above), so the gap is scip-typescript's error. On the graph, tsgo verified 557k heuristic edges where scip-typescript verified 540k, and left 112k unverified instead of 130k.

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
- TS/JS via tsgo (TypeScript ≥ 7.1): done; preferred over scip-typescript when installed.
- Next: Phase 5, `implements`/`extends` from SCIP relationships, and `references`.
