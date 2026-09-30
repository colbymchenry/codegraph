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

To run one through `npx` instead, put this in `codegraph.json`:

```json
{ "scip": { "python": { "cmd": "npx", "args": ["-y", "@sourcegraph/scip-python", "{args}"] } } }
```

`"python": false` disables a language. `cmd`, `args` and `env` replace the defaults. In `args`, `{args}` splices in the adapter's own arguments and `{out}` is the output path.

**Python environments.** A `.venv/` or `venv/` (with `pyvenv.cfg`) is activated for the indexer (`VIRTUAL_ENV`, `PATH`). Its packages are passed to scip-python as an `--environment` manifest read from `*.dist-info/RECORD`, so uv venvs without `pip` work. Without a venv the manifest is empty and `scip index` warns. Project code still resolves; calls into dependencies don't.

After a project opts in with `scip index`, the MCP server (and anything else that `watch`es) re-indexes on its own. That happens 60 s after the last synced edit, at most every 10 min, niced. A new index replaces the old one only when its count of resolved calls (calls and instantiations of project symbols; imports and type references don't count) dropped by no more than 20%. Otherwise the old index stays and the reason is logged.

## How edges are decided

Call sites are keyed by (caller node, line, callee name, kind), as in the POC.

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
- `new X()` (TS, via scip-typescript's `` `<constructor>` `` symbol) and Python's `X()` (a class symbol followed by `(`) → `instantiates`, matching codegraph's own edge kind.
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
| Python | Django (`bench-corpus/arm_grep` @ 026b005, 2,928 docs, no venv) | 1 | 99% / 10% | 78% / 82% | **100% / 100%** | 98.5 s + 3.1 s |
| Python | same | 2 | 100% / 24% | 75% / 96% | **100% / 100%** | |

On codegraph's own `src/`, the merge verified 6,826 edges, removed 102 wrong ones and added 832 missing ones. On Django it verified 46,577, removed 11,426 wrong ones and added 22,476, of which 8,929 were `instantiates`. After the merge `django.urls.base.reverse` has 1,267 caller edges from 867 distinct callers, up from 1, matching the POC.

`--rg-type py --prefix django/` for Python.

## Status

- Phase 0 (fork setup): done, except the release script (see the job report).
- Phase 1 (core + TS/JS): done.
- Phase 2 (Python): done.
- Next: Go (Phase 3, scip-go, eval on spf13/cobra), Rust (Phase 4), then `implements`/`extends`/`references`.
