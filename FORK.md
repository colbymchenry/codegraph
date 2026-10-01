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
- `install.sh`: `CODEGRAPH_ARCHIVE`, to install a locally built bundle

Everything else is new, under `src/scip/`, `__tests__/scip/`, `__tests__/fixtures/scip-ts/` and `scripts/scip-eval/`.

## Installing it as `codegraph`

Build a self-contained bundle with upstream's recipe ([`BUNDLING.md`](BUNDLING.md)): vendored Node 24 plus the native extraction kernel. It runs whatever Node the machine has, including 25+, which the plain build refuses. Then install it with upstream's `install.sh`, which links it and removes older versions:

```sh
scripts/build-kernel.sh                      # native kernel (cargo); without it the bundle falls back to the slower wasm path
scripts/build-bundle.sh linux-x64            # -> release/codegraph-linux-x64.tar.gz
CODEGRAPH_ARCHIVE=release/codegraph-linux-x64.tar.gz \
CODEGRAPH_VERSION="v$(node -p "require('./package.json').version")-scip.$(git rev-parse --short HEAD)" sh install.sh
```

MCP clients that launch `codegraph` pick it up on restart. To go back to the npm install: `ln -sfn ../lib/node_modules/@colbymchenry/codegraph/npm-shim.js ~/.local/bin/codegraph`, or run `npm i -g @colbymchenry/codegraph`, which re-links it (so does any `npm update -g`).

## Using it

```sh
codegraph scip index            # run each detected language's indexer (must be on PATH), then merge
codegraph scip import out.scip  # install an index built elsewhere, then merge
codegraph scip status
```

Indexers are never auto-installed:

| language | indexer | detected by |
|---|---|---|
| TS/JS | preferred: `npm i --prefix ~/.codegraph/tools typescript@next` (≥ 7.1, see below); else `npm i -g @sourcegraph/scip-typescript` | `tsconfig.json`, `jsconfig.json`, `package.json` |
| Python | `npm i -g @sourcegraph/scip-python` | `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt` |
| Go | `go install github.com/scip-code/scip-go/cmd/scip-go@latest` (packages must build) | `go.mod` |
| Rust | `rustup component add rust-analyzer` (uses its `scip` subcommand; needs `cargo`) | `Cargo.toml` |

To run one through `npx` instead, put this in `codegraph.json`:

```json
{ "scip": { "python": { "cmd": "npx", "args": ["-y", "@sourcegraph/scip-python", "{args}"] } } }
```

`"python": false` disables a language. `cmd`, `args` and `env` replace the defaults. In `args`, `{args}` splices in the adapter's own arguments and `{out}` is the output path.

**TS/JS with tsgo.** When TypeScript ≥ 7.1 (the native compiler) is installed, in the project's `node_modules`, `~/.codegraph/tools/node_modules` (keeps a pre-release out of your global `tsc`) or the global npm root, `scip index` uses it instead of scip-typescript, through its API (`typescript/unstable/sync`). The indexer is `src/scip/indexers/tsgo-index.ts`, run as `node dist/scip/indexers/tsgo-index.js`:
- It opens every `tsconfig.json` / `jsconfig.json` project, one at a time in one process. A file is indexed by the **deepest project containing it**, whose own `paths`/options resolve its imports. (Playwright's root `tsconfig.json` has no `include`, so it claims `tests/` too, but only `tests/tsconfig.json` maps what those files import.) A file its owner never loads goes to the first project that does.
- It writes only what the merge reads: a reference at the callee name of every call and `new`, and a definition for every declaration another file can call (everything outside function bodies), so a patch can replace one file's document while the others still resolve into it. A symbol is named after its first declaration's file and container chain (`` `file`/Outer#name(). ``), falling back to its node index when two declarations share a name. Names survive edits elsewhere in the file, an overload maps to its first signature, and a declaration seen from two projects is one symbol.
- A call on a union- or intersection-typed receiver (`a.equals(b)` with `a: A | B`) targets every member's method.
- A project that fails to open is a warning; its files stay heuristic-only.
- Needs Node ≥ 20.19 / 22.12, because it `require()`s the ES-module API. Setting `scip.typescript.cmd` (or `args`) in `codegraph.json` forces scip-typescript. So does a repo without any `tsconfig.json` / `jsconfig.json`, since there is no project to open; scip-typescript infers one.
- An older TypeScript is just not a candidate. A TypeScript ≥ 7.1 that can't be used (unreadable `package.json`, no `dist/api`, a Node too old to load it) falls back to scip-typescript **with a warning** saying why.
- The API is marked unstable. The indexer checks for the exports it uses and fails with a clear message if they change. CI pins the nightly it was written against (`.github/workflows/scip-ci.yml`).

On vscode (94 projects, 13.8k files) it indexes in 82 s instead of scip-typescript's 361 s, and writes a 178 MB index (scip-typescript: 176 MB). Before every callable declaration was defined it was 75 s and 144 MB; peak memory was 7.7 GB for tsgo plus 2.1 GB for Node. Accuracy is at least scip-typescript's (see the eval below).

**TS/JS monorepos with scip-typescript.** A repo with several projects (a `tsconfig.json` / `jsconfig.json` per package, as in vscode's `src/` plus one per extension) is **split by project size**. Projects and their source-file counts come from one `git ls-files` (or a tree walk outside git; `node_modules` is ignored); each file counts once, for its deepest project. scip-typescript holds a project's whole type-checked program in memory, so one process over everything runs out of heap on a large monorepo, while a process per project pays TypeScript's start-up cost dozens of times.
- A **heavy** project (≥1,500 source files) runs alone, with a Node heap of 60% of physical memory. vscode's `src/` needs over 6 GB.
- **Light** projects are packed into batches of up to 1,500 files or 16 projects, one process per batch with a 3 GB heap. Batches run in parallel: up to 4, at most half the cores, as many as 60% of memory holds.
- A batch that fails is **retried one project at a time**, so one broken project doesn't cost its batch-mates.
- A project that still fails is reported as a warning, and its files stay heuristic-only. The run fails only if everything fails.
- `NODE_OPTIONS` with a heap, or `scip.typescript.env`, overrides the heap defaults. `{args}` / `{out}` in an override apply per run.

**Compact indexes.** Parts are combined through a compaction pass (`src/scip/compact.ts`) before install. It keeps definitions of callables and types, and references that read as a call, `new` or struct literal. Locals, parameters, type annotations and imports are dropped. On vscode the index went from 1,103 MB to 176 MB, and the merge's decode from 6.5 s to 0.9 s. The result is still a standard SCIP file. The merge re-checks every call shape against the (hash-gated, identical) source, so compaction changes size and speed, never an outcome. `scip import` compacts too.

**Python environments.** A `.venv/` or `venv/` (with `pyvenv.cfg`) is activated for the indexer (`VIRTUAL_ENV`, `PATH`). Its packages are passed to scip-python as an `--environment` manifest read from `*.dist-info/RECORD`, so uv venvs without `pip` work. Without a venv the manifest is empty and `scip index` warns. Project code still resolves; calls into dependencies don't.

After a project opts in with `scip index`, the MCP server (and anything else that `watch`es) re-indexes on its own, niced, 60 s after the last synced edit.

**Incremental (tsgo, scip-python).** A tsgo- or scip-python-built index is patched rather than rebuilt (`produce.ts` `incrementalPlan`). The files whose codegraph hash differs from the snapshot are re-indexed, together with every file that imports one of them, since their calls into it may now resolve differently. Their documents are spliced into the installed index, and deleted files drop out.
- **Why splicing works:** a tsgo symbol is named by its file and enclosing declarations (`` `src/a.ts`/Impl#run(). ``), not by node index, so an untouched file's references still link up after an edit elsewhere. The suffix comes from the declaration's kind, so a method reached through a union is still `().`.
- **Definitions:** every document, from a full run or a partial one, defines everything another file can call. So the splice only replaces the plan's documents: a changed file that starts calling a function nothing called before finds it already defined in the untouched file's document.
- **How each adapter patches (`IndexerSpec.patch`):**
  - tsgo runs once with `tsgo-index --only`.
  - scip-python runs once per changed file's directory with `--target-only`. Its paths are relative to that target; every index is rebased onto the project through its own `projectRoot` when read (`reader.ts`). A file passed as the target is left out of its own output, which is why the directory is the target.
- **Merge:** after patches only, the merge re-judges just the sites a patch can change (`MergeScope`): those in the patched files, in stale files, and in every file calling into them (by a reference to what the patched documents defined, before or after, or by an edge into them). Definitions, implementations and the hash gate are still read whole, so verdicts match a full merge. vscode, 28-file edit: merge 20.6 s → 6.0 s (91 documents re-judged), patch 47 s → 34 s; Django: 2.0 s → 0.6 s. Both equal a full rebuild edge for edge.
- **Fallbacks:** more than 500 files (8 for Python), or an index from a tool the language can't patch (for example scip-typescript), means a full run. Deeper effects (a type changing two imports away) wait for the next full run.
- **Timing:** a patch may run every minute; a full rebuild at most every 10 minutes. `codegraph scip index --changed` does the same by hand, and prints *up to date* when nothing changed.
- **On vscode:** an edit to a service file meant re-indexing 15 files, about 20 s instead of about 70 s (40 s instead of 95 s with the merge). The resulting graph was edge-for-edge identical to a full rebuild of the same state (933,950 edges, 0 differences).
- **On Django:** an edit to `django/utils/timesince.py` meant re-indexing 3 files in 26 s instead of 95 s. The result was identical to a full rebuild (120,486 edges, 0 differences).

**Why Python full runs stay ~90 s on Django.**
- **No faster checker emits SCIP:** neither pyrefly nor ty, the Rust-based checkers, does yet.
- **Splitting doesn't help:** scip-python spends ~10–15 s building the whole program whatever the target, and `--target-only` emits documents for the target's import closure too. Indexing `tests/` alone took 78 s, and a 3-way parallel split of the repo took 78 s against 84 s for one run.

So the speed-up for Python is patching, not a faster full run. A new index replaces the old one only when its count of resolved calls (calls and instantiations of project symbols; imports and type references don't count) dropped by no more than 20%. Otherwise the old index stays and the reason is logged.

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
- A called value (`term`) maps to a function node, or to the constant/variable node codegraph keeps for `export const expect: Expect<…>`. codegraph's own edges already target such nodes. On Playwright this let the compiler judge about 20k heuristic `expect()`/`test()` edges; 4,952 of them had pointed at an unrelated package's `expect`.
- A file over codegraph's size limit (1 MB, e.g. a generated `types.d.ts`) has no nodes, so it's skipped like any file codegraph doesn't index, not reported as stale. Its definitions still make calls into it *unknown* rather than external.
- `new X()` (TS, via scip-typescript's `` `<constructor>` `` symbol) and Python's `X()` (a class symbol followed by `(`) → `instantiates`, matching codegraph's own edge kind. So are Go composite literals (`&X{…}`, `X[T]{…}`) and Rust struct literals (`X { … }`). Go excludes slice/map element types and return types before a body. Rust excludes `impl`/`where` headers, `-> X {`, and destructuring patterns.
- An overloaded method is one SCIP symbol defined at every signature, but codegraph has a node per signature. The symbol maps to the **first** signature, which is where the heuristic's edges point, so they verify instead of moving. On vscode this turned about 16.5k "replaced" edges into agreements. Overloads share a qualified name. When one symbol is defined at nodes with **different** qualified names, it is left unjudged: no edge is verified, moved or added through it. rust-analyzer does this, naming every nested `fn imp` in a module `module/imp()`, and first-wins sent all four of ripgrep's `pathutil.rs` `imp()` calls to the first one.
- With tsgo, an object-literal method *definition* that implements an interface (`{ listen(e) { … } }`) is not a call. scip-typescript records it as a reference to the interface method, so the merge used to add a `calls` edge for it.
- Protobuf is read and written by a small hand-written codec (`src/scip/reader.ts`) instead of `@bufbuild/protobuf` plus codegen. The fork adds no runtime dependency. It accepts both the legacy `int32` ranges and the typed ranges, and streams documents one at a time.

### Types and calls through interfaces

Indexers record implementation relationships: class → base class or interface, and method → the method it implements or overrides. scip-typescript, scip-python and scip-go emit them, and tsgo-index computes them from heritage clauses, following inherited members through base types. rust-analyzer emits none, so Rust gets neither of the uses below.

- **`implements` / `extends` edges** are judged like call sites. They are keyed at the type's own line (where codegraph puts them) under one kind, `inherits`, since codegraph and the compiler may label the same base differently. The inserted kind comes from the node kinds: a class/struct → interface/trait `implements`, anything else `extends`. codegraph's own synthesized Go `implements` edges are left alone and not duplicated. In tsgo-index a type symbol is named after its class/interface declaration, not a value merged into it. Otherwise vscode's `const IFoo = createDecorator<IFoo>()` beside `interface IFoo` would leave most of its `implements` edges unjudged.
- **Calls through an interface that has no node.** An example is the target declared in a file over codegraph's size limit, such as Playwright's generated `types.d.ts`. A heuristic edge to a method that (transitively) implements the compiler's target is verified with `metadata.scipDispatch`, and MCP reads it as *compiler-verified, through the interface it implements*. A same-named method that doesn't implement it stays unverified. Nothing is deleted on the strength of an implementation set, since structural typing makes such sets incomplete. When the interface method *does* have a node, the compiler's caller → interface edge still wins, as before.

| corpus | `implements`/`extends` compiler-backed | left heuristic | calls verified through an interface | unverified call edges |
|---|---|---|---|---|
| Playwright | 164 / 337 | 16 | 15,130 | 29,629 → 14,682 |
| vscode | 5,875 / 10,293 | 146 / 104 | 779 | 100,429 → 99,770 |
| Django | – / 8,229 | – / 933 | 44 | |

The eval gates are unchanged on all four languages.

MCP output: Flow steps read `↓ calls (compiler-verified)` or `(unverified: …)`. Trail entries get ` [unverified]`.

### Why edges stay unverified

`scripts/scip-eval/unverified.ts <repo>` replays the merge's site extraction and gives each heuristic call edge that SCIP left unjudged one cause. Measured 2026-10-01 (raw output with examples and top targets: `scripts/scip-eval/results/unverified-*.json`):

| corpus | unverified / call edges | target without node | no reference | no document | not a call to SCIP | later line | target outside graph |
|---|---|---|---|---|---|---|---|
| vscode | 114,524 / 888,110 (12.9%) | **51,798 (45%)** | 41,696 (36%) | 14,839 (13%) | 5,893 (5%) | 298 | 0 |
| Playwright | 34,469 / 114,221 (30.2%) | 40 | 11,135 (32%) | **19,796 (57%)** | 2,375 (7%) | 414 | 709 (2%) |
| codegraph | 23,532 / 34,379 (68.4%) | 2 | 62 | **23,218 (99%)** | 142 | 108 | 0 |
| Django | 32,823 / 111,323 (29.5%) | 241 | **29,998 (91%)** | 453 | 2,021 (6%) | 110 | 0 |
| cobra | 49 / 2,688 (1.8%) | 5 | 37 | 2 | 5 | 0 | 0 |
| ripgrep | 2,460 / 12,860 (19.1%) | 46 | 120 | 14 | **1,321 (54%)** | **959 (39%)** | 0 |

- **Target without node:** SCIP resolved the call to a project definition that maps to no node. In vscode it was almost all **overloaded functions**: tsgo (like scip-typescript) defines one at its first signature, codegraph's node is the implementation further down (`localize` alone: 25,762 edges). Fixed (roadmap 4.2): a definition no node contains maps to the file's only node of that name and kind starting below it. Tracing the rest found a lookup bug: every method named like an `Object.prototype` member (`toString`, `valueOf`, …) never mapped, in any language.

  After both, vscode: **64,103 unverified (7.1%, from 12.9%)**; target without node 51,798 → 1,955; the merge removed 3,260 wrong heuristic edges (mostly `toString` calls aimed at a same-named class in another copy of the file) and added 15,373 missing ones. Eval gates unchanged on all corpora.
- **No reference:** SCIP resolved nothing at the call: an untyped receiver (most of Django: `self.apps.check_models_ready()`), an `any`, an unresolved import. Some of these heuristic edges are wrong guesses (`self.label.title()` → `defaultfilters.title`) that the merge can't judge.
- **No document:** no index covers the caller's file. TS files no `tsconfig.json` includes (vscode `extensions/copilot`: 8,009; codegraph `__tests__`), a language root below the repo root that detection misses (vscode's Rust `cli/`: 3,201; codegraph's `codegraph-kernel/`: 3,709), and vendored JS (Playwright `tests/assets`: 17,343).
- **Not a call to SCIP / later line (Rust):** rust-analyzer names `Ok(…)`, `Some(…)` and tuple-struct constructors as types, so the merge keys them as instantiations while the heuristic edge is a call; and in a multi-line chain codegraph puts the call on the chain's first line, SCIP on the method name's.
- **Target outside graph:** a definition in a file codegraph has no nodes for. Only Playwright's `types.d.ts` (over the 1 MB limit): 709 edges.

## Eval gate

```sh
scripts/scip-eval/corpora.sh                      # codegraph, Django, cobra, ripgrep at their pinned commits; add playwright / vscode by name
npx tsx scripts/scip-eval/compare.ts <repo> <index.scip> <heuristic.db> <merged.db> --random 50 --seed 1 --prefix src/ --rg-type ts
```

`corpora.sh` clones, indexes with this checkout, and runs `compare.ts` per seed (corpora and pins are listed in the script). A rerun on 2026-10-01 reproduced every row below.

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
| Rust | BurntSushi/ripgrep @ 3fce3b5 (104 docs) | 1 | 100% / 7% | 37% / 83% | **99% / 99%**⁴ | 12.6 s + 1.0 s |
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

### Fork vs regular codegraph, from scratch

Regular: `npx @colbymchenry/codegraph@1.6.1 init`. Fork: `codegraph init` (the same tree-sitter indexer), then `codegraph scip index` with tsgo. Accuracy is judged by scip-typescript's index, over 50 random functions/methods per seed.

| | vscode, regular | vscode, fork | Playwright¹, regular | Playwright¹, fork |
|---|---|---|---|---|
| time | 2m06s | 2m20s + 1m31s = 3m51s | 18 s | 16 s + 8.7 s = 25 s |
| `.codegraph` size | 1,769 MB | 1,975 MB | 193 MB | 213 MB |
| call/instantiate edges | 804k | 915k | 99k | 116k |
| compiler-verified | – | 773k (84%) | – | 65k (56%) |
| wrong edges removed / missing added | – | 90k / 201k | – | 7.5k / 23.7k |
| recall, seeds 1 / 2 | 82% / 74% | **100% / 98%** | 6% / 54%² | **100% / 100%** |
| precision, seeds 1 / 2 | 93% / 94% | **100% / 100%** | 67% / 74%² | **97% / 85%**³ |

¹ microsoft/playwright @ a8c1a59 (1,588 TS/JS files, 648k lines, 6 projects), after `npm ci --ignore-scripts`. It was not used during development. Targets are from `packages/`; on `tests/` targets both seeds score 100% / 100% (regular: 78–96% / 100%).
² Seed 1's truth is dominated by one target: `GenericAssertions::toBe` accounts for 4,968 of its 5,490 call lines.
³ The remaining "wrong" lines are calls typed against the public `Page` interface in `types/types.d.ts`. That file is over codegraph's size limit and has no nodes, so the heuristic's edge to the implementation (`client/page.ts`) stays, and the judge scores it wrong. Regular codegraph gets the same lines wrong (172 of them for seed 1).

The tree-sitter step is the same code in both builds. The regular build alone took 13.5–19.0 s across three Playwright runs, so the difference between the two columns is within run-to-run variation. vscode had one run each.

⁴ The eval's truth comes from the same colliding symbol. It counts `pathutil.rs`'s three other `imp()` calls as calls to the target `file_name::imp`, and the merge now correctly declines to link them. Before the collision rule it scored 100% by linking all four calls to one `imp`. The Python, Go, Rust and TS rows were re-run after `c0993ab` and the collision rule; the rest are unchanged.

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
- Incremental reindex for tsgo and scip-python indexes: done.
- Phase 5: `implements`/`extends` and calls through interfaces from SCIP relationships: done (Rust excluded: rust-analyzer emits no relationships). `references` edges were not needed for the gaps found and are not done.
- Next: [`docs/scip-roadmap.md`](docs/scip-roadmap.md).
