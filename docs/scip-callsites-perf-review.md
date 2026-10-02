# SCIP explore call-sites perf — review write-up

**Branch:** `scip` (uncommitted WIP as of 2026-10-02)  
**Scope:** Latency fixes for `codegraph_explore`’s **Call sites** section (`src/scip/callsites.ts`) — P0/P1 from the profiled hotspot report.  
**Not in this change:** P2/P3 (`snapshotHashes` from DB, batched `indexedHashes`) — still disk/point-query; baselined only.  
**Status:** Unit tests green; vscode + Playwright A/B verified. **No commit yet.**

Companion profile notes: [`docs/scip-perf-hotspots.md`](scip-perf-hotspots.md).  
Raw timings: `scripts/scip-eval/results/verify-callsites-vscode.json`, `verify-callsites-rest.json`, `verify-explore-live.json`.

This note is for reviewers: *why*, *what*, *how to check*, and *what to watch*.

---

## Executive summary

Explore’s “Call sites of X” footnote was fine on small fixtures and **catastrophic on vscode** for common short names (`add`, `toString`): one correlated SQL subquery could take **~100 seconds**, so an explore answer stalled before source even rendered.

Three changes in one file (`src/scip/callsites.ts`), plus tests:

| # | Change | Effect |
|---|--------|--------|
| **P0** | Replace unresolved `NOT EXISTS` with a JS `Set` anti-join | vscode `DisposableStore::add`: **~97 s → ~88 ms**, same count (**4663**) |
| **P1a** | ~~Compact-first listing when site count would blow the char budget~~ Since replaced: the detailed list is built until it passes the budget, then compact (exact; no 90-chars-per-site guess) | Skip reading caller files only to discard them (vscode: **76 reads / ~1.8 MB** avoided on `add`) |
| **P1b** | Same-name “other calls” aggregated in SQL with stale/silent excluded | ~~Same groups as before; vscode `URI::toString` **~6.3 → ~2.8 ms**~~ HEAD already grouped in SQL: re-timed on vscode `DisposableStore::add`, 3 ms before and after. The change is correctness (stale/silent not verified), not speed |
| Correctness | “Compiler-verified” uses `scipVerdict`, not bare `provenance === 'scip'` | Stale/silent scip edges show as unverified (aligned with Flow/trail) |

End-to-end: `ToolHandler.execute('codegraph_explore', …)` on vscode for `DisposableStore.add` returns the section (compact + other-calls + **4663** unresolved) in **~1.6 s** median (warm). Pre-fix, unresolved alone was ~97 s.

---

## Motivation (measured, not guessed)

Profiled on a full vscode SCIP index (~14k files, ~729k `unresolved_refs`, `DisposableStore::add` with **28,123** call sites):

| Piece | Old cost | Why |
|--------|----------|-----|
| Unresolved “other calls” footnote | **~102 s** | Correlated `NOT EXISTS`: for each failed `name_tail='add'` row (~21k), re-probe whether `t` already has a call edge on that file/line |
| Detailed-then-compact listing | Tens of ms + disk | Always `readFileSync` every unique caller file for line text, then throw away the detailed form when `> 8000` chars |
| Other-calls grouping | Up to ~60 ms on hot names | Load every same-name edge into JS, then `Map` group (later already partly SQL; verified count was `SUM(provenance='scip')` only) |

EXPLAIN confirmed this is an **algorithm** problem, not a missing index: `idx_unresolved_failed_tail` is used; the nested edge probe per row is the killer.

---

## Change 1 — P0: `countUnresolvedOtherCalls` (Set anti-join)

### Before

```sql
SELECT COUNT(*) FROM unresolved_refs u
WHERE … name_tail = ? AND NOT EXISTS (
  SELECT 1 FROM edges e JOIN nodes s …
  WHERE e.target = ? AND e.line = u.line AND s.file_path = u.file_path)
```

Per failed unresolved row → nested plan into `t`’s call edges.

### After

1. Load `t`’s call sites once → `Set` of `file\0line`.
2. Scan failed unresolved rows for `name_tail = t.name`.
3. Count rows whose key is **not** in the set.

Exported as `countUnresolvedOtherCalls` for tests and profiling. `otherCalls` calls it for the footnote.

### Semantics

Same exclusion as the old SQL: a failed ref on a line where `t` already has a `calls` edge is **not** counted (those sites are already in the call-sites list).

### Review focus

- Key format (`file\0line`) must match both queries’ `file_path` / `line` types.
- Still two full scans (sites of `t` + failed unresolved for the name). Acceptable vs correlated; a TEMP table anti-join was ~59 ms in an earlier probe — Set path landed at ~88 ms on the same target and stays **read-only** (no temp writes on a possibly read-only explore DB).

---

## Change 2 — P1a: compact-first listing

### Before

Always build the detailed listing (with line text → file reads), then if `join.length > MAX_DETAILED_CHARS` (8000), rebuild compact.

### After

Heuristic: if `shown.length * DETAILED_CHARS_PER_SITE > MAX_DETAILED_CHARS` (`90` chars/site), emit **compact first** and never call `lineText` / `readFileSync`.

Fallback unchanged: if the heuristic says “detailed” but the real detailed string still exceeds 8000, fall back to compact (same as before).

### Review focus

- `90` is a rough constant from profiling — false negatives mean one wasted detailed build (old behavior); false positives mean compact when detailed might have fit (rare for mega-targets capped at `MAX_SITES=1000`).
- Compact marks unverified lines with `?`, detailed with `[unverified]` — now driven by `compilerVerified` / `ok[i]`, not `provenance === 'scip'`.

---

## Change 3 — P1b: other-calls SQL + verified CASE

Same-name edges are still `GROUP BY qualified_name, file_path` in SQL (that part already existed). The verified bucket now approximates `scipVerdict`:

```sql
SUM(CASE WHEN e.provenance = 'scip'
  AND COALESCE(e.metadata, '') NOT LIKE '%"scipSilent":true%'
  AND COALESCE(e.metadata, '') NOT LIKE '%"scipStale":true%'
  THEN 1 ELSE 0 END)
```

Matches the fork’s `SILENT_EDGE` / `STALE_EDGE` LIKE shape (json_set without spaces). Footnote still labels a group “compiler-verified” only when `verified === n`.

### Review focus

- LIKE is not a full JSON parse — same trade-off as status SQL elsewhere. Site-level listing uses real `scipVerdict` via `compilerVerified`.
- Playwright A/B: group **multisets** match JS aggregation; top-5 **order** can differ on ties until `ORDER BY n, qn, file` — footnote only shows top 5 by count, so tie order among equal `n` is cosmetic.

---

## Change 4 — Correctness: `compilerVerified`

Call-site counts and marks use `scipVerdict` (via `compilerVerified`), not `provenance === 'scip'`. Stale edges keep `provenance: 'scip'` in the DB; Flow already treated them as unverified — the list was lying.

New test: plant `scipStale` on a fixture edge → header shows “N not (marked)” and the line gets `[unverified]`.

---

## Tests added

| Test | File |
|------|------|
| Stale scip edge marked unverified in explore text | `__tests__/scip/callsites.test.ts` |
| `countUnresolvedOtherCalls` ≡ old correlated `NOT EXISTS` on fixture | same |

Existing call-sites explore tests still pass (compact path, file disambiguation, other-calls wording).

---

## Verification evidence (what we actually ran)

### Automated

```text
npx vitest run __tests__/scip/callsites.test.ts   # 5/5
npx vitest run __tests__/scip/callsites.test.ts \
  __tests__/scip/produce.test.ts \
  __tests__/scip/merge.test.ts                    # 34/34
```

Node: `~/.local/opt/node-v22.23.3-linux-x64`.

### vscode A/B — `DisposableStore::add` (`src/vs/base/common/lifecycle.ts`)

| Metric | Old | New |
|--------|-----|-----|
| Unresolved count | 4663 | **4663** (match) |
| Unresolved time | **96.6 s** (re-timed) / ~102 s prior | **~88 ms** median (~1096×) |
| `callSitesSection` alone | dominated by unresolved | **~156 ms**, compact + footnote |

### vscode — other P1 checks

| Check | Result |
|-------|--------|
| SQL vs JS other-calls groups (`URI::toString`) | 137 groups, top5 identical; ~2.2× faster |
| Compact-first I/O (`add`) | 76 reads / 1.8 MB avoided vs detailed-then-discard |
| Multi-symbol section (add + localize + `_register`) | 3 sections, ~391 ms |

### Playwright — `Page::evaluate`

Compact + other-calls; unresolved **470 / ~2.9 ms**; section **~8.7 ms**. Group multiset equal to JS agg.

### Live explore path

`CodeGraph.open` + `ToolHandler.execute('codegraph_explore')` (same handler MCP uses):

- Header: `28123: 28122 compiler-verified, 1 not (marked)`
- Compact + other-calls + unresolved **4663**
- Median **~1.62 s** warm (3 runs)

Cursor’s `user-codegraph` MCP server **timed out** in-session — live MCP socket not verified; ToolHandler path is.

### Explicitly **not** done here

| Item | Status |
|------|--------|
| P2 `snapshotHashes` ← DB | Still `readHashed` per file (~408 ms / ~172 MB on vscode warm) |
| P3 batched/`IN` `indexedHashes` | Still per-path (~36 ms vs ~14 ms full-scan baseline) |
| Cold page cache | Not measured |
| Commit / PR | Not created |

---

## Pseudocode (shipped unresolved path)

```
countUnresolvedOtherCalls(db, t):
  siteLines = empty Set
  for each (file, line) in calls targeting t:
    siteLines.add(file + "\0" + line)
  n = 0
  for each failed unresolved call with name_tail = t.name:
    if (file + "\0" + line) not in siteLines:
      n++
  return n
```

---

## Suggested reviewer checklist

1. Read `countUnresolvedOtherCalls` and confirm exclusion matches the old `NOT EXISTS` (test pins fixture; vscode A/B pinned 4663).
2. Confirm compact-first cannot skip detailed listing for small symbols (`shown * 90 ≤ 8000` still detailed).
3. Confirm stale/silent handling: site list via `scipVerdict`; other-calls footnote via LIKE CASE — intentional split.
4. Do **not** expect P2/P3 hash-path changes in this diff — out of scope.
5. Optional re-check: open vscode index, run explore for `DisposableStore.add callers src/vs/base/common/lifecycle.ts`, expect compact list in &lt; few seconds, not ~100 s.

---

## Files touched

| Path | Role |
|------|------|
| `src/scip/callsites.ts` | All behavioral changes |
| `__tests__/scip/callsites.test.ts` | Stale mark + unresolved equivalence |
| `docs/scip-perf-hotspots.md` | Prior profile report (context; not required for merge) |
| `scripts/scip-eval/results/verify-*.json` | Local evidence dumps (optional to commit) |
| `scripts/scip-eval/profile-*.js` | Profilers used to find P0 (optional) |
