# SCIP hotspots — profiled report

**Date:** 2026-10-02  
**Method:** static review → A/B microbench + Node CPU profile  
**Harness:** `scripts/scip-eval/profile-hotspots.js`  
**Raw data:** `scripts/scip-eval/results/perf-hotspots-*.json`  
**Runtime:** Node v22.23.3 (`~/.local/opt`), **warm page cache** (no `drop_caches`)

## Verdict

**vscode is measured.** The P0 is no longer “~195 ms on Django” — on vscode, `otherCalls`’s unresolved `NOT EXISTS` query is **seconds to ~102 seconds** for common short names. That alone can dominate an explore answer.

| Priority | Fix | Evidence | Ship? |
|---|---|---|---|
| **P0** | Rewrite `otherCalls` unresolved query (temp site-lines or drop exclusion) | vscode `add`: **~102 s → ~59 ms** (same answer); plan is correlated per-row edge probe | **Yes — critical** |
| **P1** | ~~SQL `GROUP BY` for other-call aggregates~~ | ~~vscode `toString`: JS agg **60 ms** / 3289 rows → SQL **1.6 ms**; PW/Django ~10×~~ The JS-aggregate baseline was older code: HEAD (`2292ec0e`) already grouped in SQL | ~~**Yes**~~ already shipped |
| **P1** | Call-sites compact-first | vscode `Disposable::_register`: **14 → 7 ms**; PW/Django **6–15 → ~1 ms** | **Yes** |
| **P2** | `snapshotHashes` from DB | vscode: **259 → 5.4 ms** (−173 MB reads) | **Yes** |
| **P2** | Merge chunk I/O awareness | vscode: decode **~1.1 s**, `referenceSites` **~1 s**, `heuristicSites`/1k files **~0.6 s** | Measure in full pass; not explore-blocking |
| **P3** | Batch / full-scan `indexedHashes` | vscode: **38 → 13 ms** | Optional |

## Corpora measured

| Corpus | Path | Files | SCIP call edges | unresolved_refs |
|---|---|---|---|---|
| codegraph-scip | this repo | 988 | ~20.5k | — |
| Playwright | `~/.cache/codegraph-scip-eval/playwright` | 1678 | 96.8k | 106k |
| Django | `~/.cache/codegraph-scip-eval/django` | 3017 | 48.0k | 128k |
| **vscode** | `~/.claude/jobs/1cd92c93/tmp/vscode` | **14,858** | **705k** | **729k** |

vscode index: scip-typescript, 14,008 TS meta hashes, `fullRunMs` ≈ 356 s, DB 1.9 GB, `.scip` 191 MB.

## vscode — headline numbers

### Snapshot hashes
| Mode | Median ms | I/O |
|---|---|---|
| Disk (current) | **259** | 14,093 reads / **173 MB** |
| DB `content_hash` | **5.4** | 0 |
| **Save** | **254 ms** | |

### indexedHashes (14,096 paths)
| Mode | Median ms |
|---|---|
| Point gets | 37.9 |
| Batched IN | 23.5 |
| Full scan | **13.1** |

### Call-sites compact-first (MAX_SITES=1000 cap)
| Target | Sites | Files read | Detailed ms | Compact ms | Discarded |
|---|---|---|---|---|---|
| `DisposableStore::add` | 28,123 | 76 | 12.4 | 6.6 | yes |
| `localize` | 25,780 | 59 | 18.6 | 14.1 | yes |
| `Disposable::_register` | 14,632 | 123 | 14.2 | 6.9 | yes |

(Detailed path only reads files for the first 1000 sites; still discarded afterward.)

### otherCalls breakdown (the vscode story)

| Symbol | Sites | failed name matches | JS agg ms / rows | SQL ms | **Unresolved NOT EXISTS ms** |
|---|---|---|---|---|---|
| `DisposableStore::add` | 28,123 | **21,590** | 7.8 / 2281 | 1.4 | **101,894 (~102 s)** |
| `localize` | 25,780 | 37 | 3.9 / 276 | 0.2 | **528** |
| `Disposable::_register` | 14,632 | 1,837 | 3.6 / 1259 | 0.4 | **14,499 (~14.5 s)** |
| `URI::toString` | 12,627 | **14,720** | **60.4 / 3289** | 1.6 | **13,288 (~13.3 s)** |

Cost tracks `failedName` count × correlated probe into edges. Common short names (`add`, `toString`) are catastrophic on vscode’s 729k-row `unresolved_refs` table.

Also: full `referenceSites` scan on vscode took **~952 ms** (287k rows) — produce-path context, not explore.

## Playwright / Django (earlier)

### Snapshot
| Corpus | Disk ms | DB ms |
|---|---|---|
| Playwright | 31.7 | 0.39 |
| Django | 44.1 | 1.02 |

### Call-sites
| Target | Sites | Detailed → compact |
|---|---|---|
| PW `Page::evaluate` | 2150 | 6.3 → 1.4 ms |
| DJ `assertRaisesMessage` | 2352 | 15.2 → 1.4 ms |

### otherCalls
| Symbol | Unresolved ms | JS agg → SQL |
|---|---|---|
| DJ `Client::get` | **~195** | 3.3 → 0.42 |
| PW `Page::evaluate` | 0.22 | 4.1 → 0.42 |

## Ship order (final)

1. **P0:** Kill or rewrite `otherCalls` unresolved `NOT EXISTS` (vscode: up to **~102 s**). Prefer the measured **temp site-lines** plan (~59 ms) or drop the exclusion / footnote under budget.  
2. **P1:** SQL `GROUP BY … LIMIT 5` for same-name aggregates.  
3. **P1:** Compact-first call-site listing when over budget.  
4. **P2:** `snapshotHashes` ← DB hashes (~250 ms on vscode).  
5. **P2/P3:** Watch merge chunk costs (`heuristicSites` ~0.6 s / 1k files; decode ~1.1 s) when tuning merge — not explore-blocking.  
6. **P3:** `indexedHashes` full scan (~25 ms on vscode).

## Deeper dig (vscode, beyond the original four)

Harness: `scripts/scip-eval/profile-deeper.js` → `results/perf-deeper-vscode.json`.

### Why the unresolved query is O(disaster)

`EXPLAIN QUERY PLAN` for the current SQL:

1. `SEARCH unresolved_refs` via `idx_unresolved_failed_tail(name_tail=?)` — fine.  
2. **For every matching row:** correlated subquery  
   `SEARCH edges USING idx_edges_target_kind(target=? AND kind=?)` + node lookup.

So cost ≈ `failedNameMatches × (work to scan that target’s call edges)`.  
For `DisposableStore::add`: **21,590** failed `add` tails × probes into **~28k** call edges → **~102 s**.

Worst failed `name_tail` counts on vscode (amplifiers):

| name_tail | failed call unresolved rows |
|---|---|
| `strictEqual` | 41,900 |
| `test` | 32,804 |
| `deepStrictEqual` | 28,788 |
| `push` | 25,402 |
| `add` | 21,590 |
| `get` | 19,206 |
| `toString` | 14,720 |

Any explore that co-names these (or lists call sites for a symbol with that short name) trips the bomb.

### Proven cheaper unresolved alternatives (same target `add`)

| Approach | Median ms | Result |
|---|---|---|
| Current correlated `NOT EXISTS` | **~101,894** | 4,663 (earlier run) |
| `COUNT(*)` failed by `name_tail` only (no exclusion) | **13** | 21,590 (upper bound) |
| Materialize this target’s `(file,line)` call sites into a TEMP table + indexed anti-join | **59** | 4,663 |

→ **~1,700×** faster with equivalent exclusion semantics (temp site-lines).

### Other vscode surfaces (not explore-P0, but real)

| Surface | Median ms | Notes |
|---|---|---|
| Full `referenceSites` join | **~1,000** | 287k rows — once per produce language |
| `loadScipIndex` typescript.scip (191 MB) | **~1,130** | merge decode phase |
| `heuristicSites` over 1,000 files | **~640** | per merge chunk (chunk size 1000) |
| `bySource` silent-flag query × 1,000 files | **~96** | merge pattern; acceptable |
| `callSitesSection('localize')` end-to-end | **~491** | dominated by unresolved (~528 ms for that name) |
| `sitesOf` for mega-targets | **~40–60** | loads all call rows (28k); secondary vs unresolved |

### Index inventory note

`unresolved_refs` already has `idx_unresolved_failed_tail`. Adding another index **does not** fix the correlated plan — the algorithm must change (temp set / skip exclusion / precompute).

## Reproduce

```bash
NODE=~/.local/opt/node-v22.23.3-linux-x64/bin/node
VS=~/.claude/jobs/1cd92c93/tmp/vscode   # or your vscode checkout with .codegraph/

$NODE scripts/scip-eval/profile-hotspots.js "$VS" \
  > scripts/scip-eval/results/perf-hotspots-vscode.json

$NODE scripts/scip-eval/profile-deeper.js "$VS" \
  > scripts/scip-eval/results/perf-deeper-vscode.json
```

## Limits

- Warm cache only.  
- Unresolved timings for catastrophic names are **single-shot** (too expensive to median).  
- Compact-first savings understate first-cold explore (file cache already warm after snapshot bench).
- Merge-phase numbers above are **microbenches of pieces**, not a full `runScipPass` wall clock (FORK.md still quotes ~27 s chunked merge).
