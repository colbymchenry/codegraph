# `query` startup: the lazy `MCPServer` re-export

`codegraph query` used to pay for the whole MCP server module graph — daemon,
proxy, engine, session, writer-lock, the 8.3k-line `tools` module — at
startup, because the package entry re-exported `MCPServer` statically and the
CLI's `query` command loads that entry through `loadCodeGraph()`. The query
command never touches the MCP server. This change makes the re-export lazy,
which removes the server graph from every non-MCP code path.

Branch: `perf/query-startup-lazy-load` (base `main` @
`69af19ace270f2e940444d514de6dde971df12df`).

## Background

Profiling of `codegraph query` startup showed ~88% of the time in module
loading, dominated by `stat` calls (2446/3089 samples ≈ 79%, largest single
stack only 6.8%) — i.e. the cost of resolving a large `require()` graph, not
any one hot module. The root cause is `src/index.ts`'s top-level import graph
(`extraction` with tree-sitter and every grammar, `resolution`, `mcp`,
`context`, `sync`), which `loadCodeGraph()` turns into the price of admission
for `query` and every other library command.

Mechanically deferring all of those symbols is risky — they appear at ~52
usage points inside `src/index.ts` alone. The heavy imports differ sharply in
how many of those usage points they have:

| Import in `src/index.ts` | Usage points in the file | Marginal `require()` cost inside the entry* |
|---|---|---|
| `./mcp` (the `MCPServer` re-export) | **0 call sites** (one re-export line) | min −185 ms / p50 −296 ms |
| `./context` | 2 | no measurable win (within run-to-run noise) |
| `./sync` | ~8 (type uses + `new FileWatcher` + 3 `LockUnavailableError` throws) | no measurable win (within run-to-run noise) |
| `./extraction` | ~19 | min −22 ms / p50 −115 ms |
| `./resolution` | ~29 | min −119 ms / p50 −363 ms |

\* Measured on this machine by replacing one `require()` at a time in the
built `dist/index.js` with a lazy proxy and timing `require('dist/index.js')`
cold (9 runs each, module caches cleared between runs). The container is
shared, so the smaller deltas are approximate; `./mcp` is re-confirmed
end-to-end by the benchmarks below.

`./mcp` is the heavy import with the fewest usage points **and** the largest
safe win: `resolution` is comparable on time but is exactly the
mechanical-lazy-loading hazard above, and `context`/`sync` are small enough
that deferring them bought nothing measurable.
`src/bin/codegraph.ts`'s eager imports were measured too — every one of them
resolves in 2–11 ms (they are type-light or dependency-free by design), so
there was nothing worth deferring there.

## What changed

- **`src/index.ts`** — `export { MCPServer } from './mcp'` becomes a lazy
  re-export: an `export const` placeholder keeps the export's type surface,
  and a CommonJS `exports` getter loads `./mcp` on first access. The getter is
  deliberately written in the exact shape `tsc` emits for a static re-export,
  because CommonJS named-export detection (cjs-module-lexer) recognizes
  nothing else — an arrow-function getter, or the same getter nested in a
  block, silently breaks `import { MCPServer } from 'codegraph'` from ESM.
  `mcp/version` stays eagerly imported: it is dependency-free by design and
  `indexAll()` records the package version into the index.
- **`__tests__/lazy-mcp-export.test.ts`** — locks the contract (below). Both
  laziness tests fail against the pre-change build; the ESM-export test passes
  against both, as a regression guard for the cjs-module-lexer shape.
- **`docs/benchmarks/query-startup-lazy-mcp.md`** (this file) and a CHANGELOG
  entry.

Nothing else changes: `codegraph serve` and the daemon already reached the
server through `await import('../mcp/index')`, and no internal code path used
the re-export.

## Behaviour preserved

| Surface | Before | After |
|---|---|---|
| `require('@colbymchenry/codegraph').MCPServer` | the class | the same class (identity with `require('…/dist/mcp')` is `true`) |
| `new MCPServer(path)` / `instanceof` | works | works |
| `import { MCPServer } from 'codegraph'` (ESM→CJS) | works | works |
| `MCPServer` as a type (`let s: MCPServer`) | works | works (`export type MCPServer`) |
| Other named exports, default export | unchanged | unchanged |
| `dist/index.d.ts` | `export { MCPServer } from './mcp'` | `export declare const MCPServer: typeof import('./mcp').MCPServer` + `export type MCPServer = import('./mcp').MCPServer` — same value and type meanings |

One documented caveat: the lazy getter resolves `./mcp` through CommonJS
`require()`, which exists in the built package (the only form npm ships).
When the *source* is loaded by a test runner such as vitest there is no CJS
resolution for `./mcp`, so source-level consumers should import the server
from `../src/mcp` directly. No test in the suite touches `MCPServer` through
`src/index.ts`; the error message says exactly this.

## Benchmarks

Workload (identical for both builds): a 5-file / 50-node TypeScript fixture
project, indexed once, then `codegraph query "Handler" --json --path <proj>`
with `CODEGRAPH_TELEMETRY=0`. Node v22.23.1, Linux x64. Runs alternate
before/after in 3 blocks × 10 runs per configuration (`bench-ab.sh`), so slow
drift on the shared machine hits both builds equally. Two configurations are
reported because the CLI re-executes itself when WASM runtime flags are
missing: **shipped** is what a user gets; **no-relaunch** sets
`CODEGRAPH_WASM_RELAUNCHED=1` (and `CODEGRAPH_NO_DAEMON=1`) to measure a
single process.

### Wall time — `codegraph query "Handler" --json`, 30 runs per build

| Configuration | Build | min | p50 | mean | max |
|---|---|---|---|---|---|
| shipped | before | 3179 ms | 3424 ms | 3454 ms | 4030 ms |
| shipped | after | 2588 ms | 2970 ms | 2957 ms | 3413 ms |
| no-relaunch | before | 2525 ms | 3033 ms | 3026 ms | 3424 ms |
| no-relaunch | after | 2143 ms | 2581 ms | 2538 ms | 2977 ms |

Mean delta: **shipped −496 ms (14.4% faster)**, no-relaunch −488 ms (16.1%
faster). The win survives the self-relaunch because the re-exec'd child pays
the same `loadCodeGraph()` cost the single-process run does.

### Module graph

| | before | after |
|---|---|---|
| modules loaded by `codegraph query` (single process) | 252 | 227 (−25) |
| of which `dist/mcp/*` | 26 (whole server graph) | 8 (the CLI's own support modules) |
| modules loaded by `require('dist/index.js')` | 236 (26 `mcp/*`) | 199 (1 `mcp/*`: `version`) |

The remaining eight `mcp/*` modules of a CLI run are the small support files
`src/bin/codegraph.ts` imports for supervision and the daemon handshake —
they load with or without this change and are listed in
`__tests__/lazy-mcp-export.test.ts`.

### Library entry load — `require('dist/index.js')`, cold module cache

3 batches × 7 runs per build, module cache cleared between runs:

| Build | min (per batch) | p50 (per batch) |
|---|---|---|
| before | 1494–1542 ms | 1918–1970 ms |
| after | 1277–1393 ms | 1452–1633 ms |

That is the cost `loadCodeGraph()` adds to every library-backed CLI command,
and where the `query` wall-time delta comes from.

## Verification

- `npx tsc --noEmit` — clean.
- `npm run build` — clean (`dist/index.js`, `dist/index.d.ts` checked by hand
  and by the tests).
- Tests — the suites covering this change are green: `lazy-mcp-export` (3/3),
  `default-export-declaration` (which loads `src/index.ts` heavily) and
  `cli-index-explicit-path` (spawns the built CLI) — 12/12 in one run. The
  full `npm test` run was started but did not finish within the session
  (single-worker run over 200+ suites on a shared container; killed after
  ~25 minutes without completing) — the remaining suites are untouched by
  this change and only read `dist/` or `src/` the same way the passing ones
  do.
- `__tests__/lazy-mcp-export.test.ts` — 3 tests; the two laziness tests fail
  when run against a build of the pre-change source, confirming they pin the
  optimization rather than passing vacuously.

## Limits and follow-ups

- `resolution` (29 usage points) and `extraction` (~19) remain eager. On this
  measurement `resolution` alone is worth a comparable amount of time
  (`min` −119 ms / `p50` −363 ms inside the entry), so deferring the
  search-only path from them is the next lever — but it means touching those
  ~48 usage points (or restructuring `searchNodes` away from the facade),
  which is deliberately out of scope for a minimal, behaviour-preserving
  change.
- The small `mcp/*` support modules the CLI entry imports for supervision and
  the daemon handshake (`early-ppid`, `ppid-watchdog`, `liveness-watchdog`,
  `writer-lock`, `daemon-paths`, `daemon-registry`, `process-identity`) are
  unchanged and still load for every command — they are a handful of small,
  dependency-light files and were never part of the problem.
- Dependency upgrades are covered by PR #2885; `mcp/query-pool` workers
  (#2862) and `init` (#2888) are separate efforts — nothing here touches
  them.
