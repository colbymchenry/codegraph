# Haskell implementation audit — 2026-09-13

This audit covers the Haskell implementation on `feat/haskell-support-clean`,
starting at `ea617418b134090b2b902d0547c5ae887511faf6` (package version 1.6.0),
and the corrections described below. Extraction, lexical and import
resolution, record fields, graph retrieval, incremental invalidation, grammar
packaging, and regression coverage were reviewed. This is a correctness audit
and deterministic corpus comparison, not an agent A/B benchmark.

The first comparison below predates integration of the remote PR head
`609468ed0a63037c5e608a17478c6f7447a0cccc`. The final re-audit section records
validation after incorporating its 61 additional commits and the two further
defects found during independent review.

## Reproduced defects and corrections

- Applied deriving classes such as `C Int` contributed false `implements` edges
  to their arguments. Extraction now shares the existing class-head traversal.
- Bindings inside nested expressions could suppress later external references.
  Binding collection now traverses declaration containers only.
- A unique `let` or `where` helper could capture references outside its actual
  scope. Persisted ranges now include columns; resolution checks visibility
  before ranking and chooses the innermost scope. Ordinary `do`, `rec`, and `mdo`
  retain their different recursive scopes.
- An old inline-text heuristic mistook `let` in an argument or string literal
  for a scope boundary even when precise ranges existed. New indexes now use
  those ranges; the heuristic remains a compatibility fallback for old indexes.
- Pattern-synonym matchers and builders bypassed the full language visitor,
  dropping local helper definitions and treating quotations as runtime calls.
  They now use the full visitor under the existing pattern scope, preserving
  executable splices and the correct caller attribution.
- A module declaration incorrectly took precedence over an imported namesake.
  Such ambiguities now remain unresolved. Module-level resolutions retain their
  dependency on the import namespace so export changes also invalidate them.
- Repeated fields in constructors of the same data type became separate
  selectors. They now share one selector per type, while distinct types retain
  distinct fields.
- Record construction labels could point to an unrelated namesake or disappear
  as ambiguous. An explicit constructor now supplies the owning type, with
  import/export visibility checked independently. This proof survives sync.
- Topology invalidation loaded every Haskell node and its outgoing edges,
  deleting and reinserting unrelated rows. A filtered SQL query now selects
  replay candidates; batched deletion preserves unrelated edge rows and metadata.
- Repeated Haskell containment, record-owner, and import-conflict lookups now
  use bounded caches scoped to a resolution pass. Cache hits reconstruct the
  original reference at each call site, preserving distinct owners and positions;
  cache clearing remains covered by export-change regressions.

The extraction revision is 28 so existing indexes can be identified as needing
a rebuild. Package and release versions are unchanged.

## Initial incremental performance

On the same Mac with no concurrent audit workload, each build received three
scoped updates that added one exported binding to `libs/racommon/src/TT/Hash.hs`.
The original file was restored and synced between samples. Timings measure the
complete awaited `CodeGraph.sync`, with the invalidation phase measured separately;
restoration time is excluded.

| Measurement | Original build | Corrected build, before caches | Corrected build with caches |
|---|---:|---:|---:|
| Full sync, median | 2,273 ms | 2,740 ms | 2,282 ms |
| Full sync, range | 2,244–3,026 ms | 2,507–3,217 ms | 2,267–2,728 ms |
| Invalidation, median | 791 ms | 617 ms | 538 ms |
| Edges faithfully replayed per update | 32,057 | 49,830 | 49,830 |

The cache change removes the intermediate slowdown while doing the broader
replay required for correctness. Full-sync latency is effectively unchanged in
this sample; the invalidation phase improves by about 32%. This is not a claim
of a 32% improvement in overall sync or autonomous-agent latency. A fresh final
ra index took 4.86 seconds in one isolated run; no full-index speedup is claimed.
The caches preserve exactly the pre-cache corrected graph fingerprints and
retrieval chains on all four repositories. No pending reference remains after
resolution in any of those indexes; unresolved external or unsupported names
remain explicitly marked as failed resolutions.

## Initial real-repository comparison

Each arm used a separate source copy and a fresh index built by that arm's
binary. The original `ra-monorepo` checkout and its configuration were unchanged.
All four repositories indexed with zero file errors. A no-change sync preserved
the complete node/edge fingerprints in both arms for each repository.

| Repository | Revision | Indexed files | Nodes before → after | Edges before → after |
|---|---|---:|---:|---:|
| ra-monorepo | `71ea9e199bd93892180b0fa80bf37aa3cb0da04c` | 1,425 (1,415 Haskell) | 46,021 → 45,974 | 94,375 → 96,642 |
| xmonad v0.18.1 | `1a875b3413e72a766ce2b1d4c39b8f796c1ac311` | 40 | 1,075 → 1,075 | 3,198 → 3,228 |
| pandoc 3.11 | `b913622e1ff87c69ab8b1a606577122e220925cd` | 600 | 18,493 → 18,493 | 67,892 → 67,883 |
| haskell-language-server | `c98343b869786994a0ece7830910551bd8a0c195` | 1,587 | 21,423 → 21,410 | 44,399 → 44,470 |

In ra-monorepo, 28 groups of repeated record fields accounted for all 47 removed
nodes; no duplicate field group remains. The semantic edge comparison found
407 removed references, one removed call, seven removed `implements` edges, and
2,729 added references. These are changes in attribution and coverage, not an
accuracy percentage. Representative checks confirmed that construction labels
select the local or imported type actually named, deriving arguments no longer
become implemented classes, and a record-wildcard local binding no longer calls
an unrelated selector.

## Initial retrieval checks

Each query used a fresh tool handler. All three ra-monorepo chains are returned
in the Flow section of one `codegraph_explore` call, before and after:

1. `executeScheduledCommandsForever executeSystemCommand updateCommandResult updateResult`
2. `Uas.Scheduler.schedule Uas.Command.executeAction executeAction'`
3. `redeemMagicLoginHandler redeemMagicLogin selectMagicLoginToken`

The nine control queries preserve the same chains before and after:

| Repository | Query | Observed boundary |
|---|---|---|
| xmonad | `manage float windows` | `manage → windows`; no complete three-symbol chain |
| xmonad | `kill withFocused killWindow` | No chain in either arm |
| xmonad | `refresh windows modifyWindowSet` | No chain in either arm |
| pandoc | `readMarkdown readWithM parseMarkdown` | `readMarkdown → readWithM`; no further named hop |
| pandoc | `writeHtml5 writeHtml' pandocToHtml` | Complete three-symbol chain |
| pandoc | `writeLaTeX pandocToLaTeX blockListToLaTeX` | Complete three-symbol chain |
| HLS | `Ide.Main.defaultMain runLspMode Development.IDE.Main.defaultMain` | Complete chain between the two distinct entrypoints |
| HLS | `getIdeas moduleEx getParsedModuleWithComments` | Complete three-symbol chain |
| HLS | `hover request logAndRunRequest getAtPoint` | Stops at `logAndRunRequest`; no call-through proof to `getAtPoint` |

These probes do not establish zero Read/Grep behavior by an autonomous agent.
The headless harness requires the unavailable `claude` executable for the
prescribed Sonnet/high arms. No substitute model, cost claim, or A/B speedup is
reported. Higher-order call-through, record updates without a known constructor,
and type-directed dispatch retain coverage limits.

## Initial validation before remote integration

- Full build on macOS Node 24.18.0 and Linux Node 22, including bundled grammars,
  Haskell license notice, and viewer assets.
- macOS: 4,254 passed, 188 skipped; 227 passing suites and 16 skipped suites.
- Linux Docker (`node:22-bookworm`, `docker run --rm --init`): 4,254 passed,
  188 skipped; the same suite totals.
- 164 Haskell tests pass, including 12 new regressions.
- Three scoped export changes followed by restoration of the original source
  returned ra-monorepo to exactly the same node and edge fingerprints in each
  arm; no accumulated nodes, edges, or changed attribution remained.
- One first macOS run encountered an `ENOTEMPTY` during the watcher test's
  temporary-directory cleanup under concurrent workloads. Its 35-test suite
  passed on retry, followed by a clean complete-suite rerun.
- Windows was not run; no Windows-specific change is included.

Commands: `npm run build`, `npm test -- --maxWorkers=4 --minWorkers=1`, and
`npx vitest run __tests__/haskell*.test.ts`. Local raw reports, graph fingerprints,
source-free edge deltas, probe scripts, and build/test logs are retained under
`/tmp/codegraph-audit-20260913/`.

## Final re-audit after remote integration

The branch was fast-forwarded to PR head
`609468ed0a63037c5e608a17478c6f7447a0cccc` before applying these corrections.
Independent extraction, resolution, and DB/sync reviews checked the merged
implementation, including upstream alias resolution, target-kind filtering,
orphan-reference recovery, and WAL transaction boundaries. The inline `let`
and pattern-synonym defects above were found and fixed during this second review.

Both builds passed, including grammar/license/viewer checks. `npm pack --dry-run`
also passed; the inspected package includes the Haskell grammar, its license,
the SQLite schema, and the viewer entrypoint. No package version was changed.

| Final suite | Passed | Failed | Skipped |
|---|---:|---:|---:|
| macOS, Node 24.18.0 | 4,625 | 14 | 192 |
| Linux Docker, Node 22 | 4,627 | 12 | 192 |

All **168 Haskell tests pass on both platforms**, including 16 new regressions
relative to the remote PR head. The full suite is not green: the failing cases
are outside Haskell and reproduce on upstream parent
`3ed73bc127323e63153bf6ec8354afa82ce36aaf`. The affected suites cover installer
configuration (two macOS-only failures in this environment), caller truncation,
Next.js, object-literal methods, React Native, and the three Steps API suites.
Their test names were compared against isolated baseline checkouts. No new
persistent failure was found. The first concurrent macOS run additionally hit
a daemon shutdown timeout; a complete rerun passed that test and retained
exactly the 14 baseline failures.

Fresh, separate indexes were rebuilt for all four pinned source revisions:

| Repository | Files | Nodes at PR head → corrected | Edges at PR head → corrected |
|---|---:|---:|---:|
| ra-monorepo | 1,425 | 46,021 → 45,974 | 94,374 → 96,641 |
| xmonad | 40 | 1,075 → 1,075 | 3,198 → 3,228 |
| pandoc | 600 | 18,498 → 18,498 | 67,867 → 67,858 |
| HLS | 1,587 | 22,141 → 22,128 | 45,117 → 45,188 |

Each index reports zero failed files, no pending references, and an identical
node/edge fingerprint after a no-change sync. The updated upstream engine
reports two parse warnings for existing HLS fixtures (`ExplicitBreakFile.expected.hs`
and `CppExportInclude.h`), identically in both arms. The other repositories
report no file warnings.

Three scoped export edits followed by restoration were also replayed against
both new ra-monorepo indexes. After all six syncs, the source bytes and complete
node/edge fingerprints exactly matched their starting state in each arm.

All 12 queries preserve their chains against the remote PR head, and all three
ra-monorepo queries still complete in one explore call. The updated upstream
lookup returns only `request → logAndRunRequest` for the HLS hover query in both
new arms; it still does not prove the higher-order hop to `getAtPoint`.
The original checkout of ra-monorepo remains untouched. The Sonnet A/B limitation
described above still applies.
