# Faster resolution workers: algorithmic options

**Status:** plan, nothing built (beyond the `receiverNodes` memo noted below). Measured 2026-10-02 on the vscode copy (14,858 files, ~499k nodes, 2,058,339 edges, ~2.2M refs, 777,575 left failed), Node 22.23.3.
**Follows:** [2026-10-02-build-write-pipeline.md](2026-10-02-build-write-pipeline.md) — that round showed the resolver **workers** set the batch loop's pace, not the main thread.
**Scope:** upstream code (`src/resolution/`, `src/db/queries.ts`). Every change below except D must keep the graph identical.

## Invariant and how to check it

- Edge fingerprint after a full `codegraph index` of the vscode copy: **`207cd0ec5665767f`**, 2,058,339 edges (`edge-fp.js` — sha256 over every edge column, ordered). Playwright copy: `5c62aebe4099fa5b`, 224,850 edges.
- Wall time varies ±7 s between runs (and ~15% when the desktop is busy — a Chrome tab at 35% CPU slowed every category in one run). Judge by the profile categories over ≥3 runs, not by one wall time.
- Lesson already paid for twice: an isolated number is not a build number (plan D in the previous doc; the "early fail" below).

## Where worker time goes

Worker CPU ~207–217 s per vscode build (6 workers). By outcome (`CODEGRAPH_RESOLVE_PROFILE=1`):

| outcome | CPU | refs | per ref |
|---|---|---|---|
| fail:calls (no edge) | 84.9 s | 559,574 | 152 µs |
| instance-method | 36.8 s | 219,353 | 168 µs |
| exact-match | 31.6 s | 387,442 | 82 µs |
| import | 31.3 s | 669,319 | 47 µs |
| qualified-name | 14.3 s | 135,156 | 106 µs |

Failed TS calls by shape (`[failed-call]` lines, same switch):

| shape | CPU | refs | per ref |
|---|---|---|---|
| `R.m` | 56.2 s | 273,737 | 205 µs |
| `this.x.m` | 18.1 s | 55,807 | 324 µs |
| bare `f()` | 14.3 s | 103,871 | 138 µs |
| `f().m` chains | 1.5 s | 38,496 | 38 µs |
| `R.a.b` | 0.5 s | 59,955 | 9 µs |

Top receiver: `assert` 14.2 s / 88k refs (before the memo below), then a long tail (`test` 3.6 s, `Promise` 2.3 s, `dispose` 1.8 s at 2 ms/ref, …).

By stage (`CODEGRAPH_RESOLVE_PROFILE=2`), failing calls spend it in the name matcher: `nameMatch` miss 79 s, of which `methodCall` 53 s, `mc-infer` 20 s, `qualifiedName` 18 s, `mc-literal` 12 s, `exactName` 11 s.

CPU profiles of 20k failed refs per shape in a warm resolver (`rootbench.js` + `--cpu-prof`):

| | bare `f()` | `this.x.m` | `assert.m` (before memo) |
|---|---|---|---|
| SQLite rows (`all` + `rowToNode`) | 34% | 30% | 17% |
| `getNodesByName` (incl.) | 16% | 11% | — |
| `inferLocalReceiverType` (incl.) | 11% | 26% | — |
| ↳ `enclosingScopeStartLine` | — | 12% (its `getNodesInFile` SQL) | — |
| `matchByQualifiedName` (incl.) | 7% | 10% | — |
| `isMethodOwnerKind` filters | — | — | 15% |
| GC | 9% | 9% | 7% |

## Already done (uncommitted at the time of writing)

- **`receiverNodes(name)`** in `name-matcher.ts`: a receiver's method-owner types and its constant/variable holders by file, computed once per name instead of refiltering `getNodesByName(receiver)` for every call (`assert` is an `import` node in 2,653 files). Micro-bench 76 → 25 µs per failed `assert.*` ref; vscode build `assert` 14.2 → 5.1 s CPU, `R.m` 56.2 → 45.4 s; graph identical.
- **`[failed-call]` profile lines** under `CODEGRAPH_RESOLVE_PROFILE`: failed-call cost by receiver root and name shape.

## Options

### A — compute filtered name lists once per name (exact, small)

**Problem.** 19 of the matcher's 35 `getNodesByName(…)` call sites filter the full list per ref with a predicate that depends only on the name, kind, language or file — so a common name (`add`, `dispose`, `test`) costs thousands of node checks on every call.

**Design.** Generalize `receiverNodes`: per-context, per-name views built in one pass in `getNodesByName` order, cleared in `clearNameMatcherMemos`. Candidates:
- `matchByQualifiedName` partial pass: `getNodesByName(lastName).filter(qn.endsWith(referenceName))` — key by `referenceName` (+ the `calls` config-key filter).
- `matchTsThisFieldCall`: `owners` (class/component, language family), `holders` (constant/variable), `declared` (methods whose qualified name ends `Type::method`) — key by name, family, and type+method.
- The remaining sites: audit each; only memo a predicate that reads nothing but the node and the name/file.

**Must verify.** Order preserved (`filter` keeps order; `preferCallSiteFile` is applied after, unchanged). No caller mutates a returned array (the memo hands out shared arrays). Memory: views are subsets of `getNodesByName` results the LRU already held.

**Expected:** 5–10% of worker CPU. **Test:** fingerprint on vscode + Playwright; micro-bench per shape before/after.

### B — per-file scope index for receiver inference (exact, small)

**Problem.** `inferLocalReceiverType` calls `enclosingScopeStartLine` for every inferred receiver: it walks every node in the file (`getNodesInFile` → `SELECT *` with docstrings and signatures, then `rowToNode`) to find the tightest function/method containing the call line.

**Design.** Per file, once: a narrow query (`kind, language, start_line, end_line` of functions/methods), sorted by start line. Lookup: binary-search the last start ≤ line, walk backward to the first entry whose end ≥ line — that is the maximum start among containing scopes, i.e. today's answer. Keep the per-language filter.

**Must verify.** Same tie behaviour as today's `n.startLine >= start` (equal starts: today the later-iterated node wins; with equal start lines the returned value is the same line, so the result is identical). Files where `getNodesInFile` is still needed by other strategies keep that cache — this only removes the dependency from the inference path.

**Expected:** ~5–10% on `this.x.m` / `R.m`. **Test:** fingerprint; unit test for nested functions (inner wins), arrow functions not extracted as nodes (outer wins, as today).

### C — shared columnar node index across workers (exact, large)

**Problem.** ~30% of failing-ref CPU is SQLite row reads (`getNodesByName`, `getNodesInFile`, `getNodesByQualifiedName`) — first touches, so larger LRU caches change nothing (measured at 5k/20k/50k entries: identical). Each of the 6 workers pays them separately, and materialized rows feed the 9% GC.

**Design.** After parsing (nodes are immutable during resolution — only edges and refs change), the main thread builds one index in `SharedArrayBuffer`s:
- string tables interned to integer ids: names, file paths, qualified names;
- node columns as typed arrays: id index, kind, language, file id, start/end line, name id, qualified-name id;
- CSR lookups: name id → node rows, file id → node rows, qualified-name id → node rows, each in the same order the SQL query returns (`getNodesByName`'s and `getNodesByFile`'s `ORDER BY`).

Workers receive the buffers at `open` and answer `getNodesByName` / `getNodesInFile` / `getNodesByQualifiedName` from slices, constructing light `Node` objects; a strategy that reads `signature`, `docstring`, `decorators`, `returnType` … gets them from a lazy by-id row fetch (or those columns are added to the index if most strategies need them — measure first).

**Must verify.** Row order identical to the SQL paths (first-wins semantics everywhere); every `Node` field a resolution strategy reads is either in the index or fetched; memory for vscode (estimate 60–100 MB once, vs 6 per-worker caches); build cost of the index on the main thread (one table scan — must stay well under what it saves); the WAL valve and connection recycling no longer matter for these reads.

**Expected:** most of the 30% SQLite share plus part of GC — ~40–50 s of worker CPU, ~6–8 s of wall. **Test:** fingerprint on vscode, Playwright, and a Python/Go/Java repo (other languages' strategies read other fields); memory high-water in the build.

### D — receiver types from the AST at parse time (changes the graph)

**Problem.** Receiver typing re-derives at resolution time, by regex over source lines, what the parser already saw: `inferLocalReceiverType`'s backward line scans (`matchLine`), `tsFieldDeclaration`'s class-line regexes, file reads. That is ~25–35% of the CPU on `R.m` / `this.x.m`, and the resolved `instance-method` path (43 s) runs the same code.

**Design.** Extractors emit a receiver-type hint per member call (local declaration type, `new X()` initializer, class field / constructor-parameter property type) into a new `unresolved_refs` column; the matcher uses it before (or instead of) the line scan. Parse workers are ~65% idle, so the extra work there is close to free.

**Not graph-identical:** AST typing differs from regex typing (better, in general). Needs an extraction-version bump, per-language work, and the agent/eval validation in AGENTS.md — a quality project with a speed side effect, not a speed-up.

## Rejected (with evidence)

- **Cache results per (function, name) or (file, name).** Resolution reads the ref's line/column in 85 places (backward declaration scans, scope checks, the source at the column). 53% of failed calls repeat per (function, name), but caching them is not exact.
- **Early fail for member calls on out-of-repo receivers** (`assert.*`, `Promise.*`, test globals) before name matching. Built and measured, reverted: vscode lost 60 edges (the matcher's qualified-name and type-receiver strategies run before its own imported-receiver rule and bind vendored/declared copies — `URI.file` from `vscode-uri` → copilot's vendored `URI`, `Uri.parse` → `monaco.d.ts`); narrowed, still −2 edges, and no CPU saved (many `assert` bindings are dynamic `await import('node:assert')`, so the import check never fired).
- **Bigger resolver LRU caches** (`CODEGRAPH_RESOLVER_CACHE_SIZE`): no change at 5k/20k/50k.
- **Pull-based chunk dispatch** (workers ask the main thread for the next chunk): no gain — the main thread is often inside a synchronous insert. A variant where workers pull from SQLite through an `Atomics` cursor is untested.
- **Postgres / DuckDB.** Postgres adds a server and a round trip per MCP query (codegraph is local-first, one file per project, sub-ms reads); DuckDB is analytic — weak at the point lookups and row-level deletes/updates resolution and MCP rely on, still one writer, and a native binding (the project ships `node:sqlite`, no native build). Ceiling either way ~15–30 s of the ~70 s of SQLite work in a build.
- **A Go/Rust rewrite of resolution.** Would speed the workers' logic (estimated 2–5×), but the main thread's SQLite writes and the load imbalance stay, so ~10–15% of the build at best — while every upstream resolver change would need re-porting with an identical graph. If ever, port one measured hot function into the existing `codegraph-kernel` crate.

## Ceiling

The batch loop is ~47 s and cannot drop below the main thread's ~33 s of SQLite work (inserts ~17–19 s, reads ~7 s, deletes/marks ~6 s). A + B + C together: estimated **~8–12 s** off the vscode build. Lower needs a cheaper writer (integer node ids in the schema, or sharded writes — previous plan).

## Order

1. A, then B — small, exact, fingerprint-checkable; measure after each (≥3 runs).
2. Re-profile. C only if workers are still the critical path (`[batch-timing]`: main thread waiting on workers).
3. D as its own quality project, if wanted.

## Tools (job scratch, copy before relying on them)

`~/.claude/jobs/1cd92c93/tmp/`:
- `edge-fp.js <db>` — edge fingerprint.
- `rootbench.js <root> '<glob>' [n]` — re-resolve n failed `calls` refs matching a name glob in a warm resolver from `dist/`; prints µs/ref, the first ref's import binding, and the profile under `CODEGRAPH_RESOLVE_PROFILE`.
- `cpuprof-top.js <file.cpuprofile> [n]` — self and inclusive time per function.
- `chunk-tl.js` / `chunk-cf.js` — per-batch worker timeline and counterfactual chunk assignment from `[chunk]` lines.
