# SCIP architecture fixes — review write-up

**Branch:** `scip` (uncommitted WIP as of 2026-10-02)  
**Scope:** Architecture / correctness follow-ups after the thermo-nuclear + sniff-detective review — not a release.  
**Status:** Unit tests green (`__tests__/scip/`, including new `round.test.ts`); live-verified on codegraph, cobra, playwright, django, ripgrep. **No commit yet** (maintainer request).

This note is for reviewers. It groups *why* each change exists, *what* moved, and *how to check* it. Omit `scripts/scip-eval/results/**` and `.cursor/hooks/**` from review focus — those are local eval / hook noise.

> **Reconciled 2026-10-02 (Claude Code review + follow-up fixes).** Wrong claims are struck through below with the correction beside them. What changed after this write-up:
> - **Bug — orphan + scoped merge:** a patch on top of an install never merged returned a scope; the scoped merge then stamped every index merged without judging the unmerged documents. Fixed in `patchIndex` (`isMerged(previous)` → no scope → full merge); test in `round.test.ts`.
> - **Bug — background merge failure:** `reindex.ts` lost its catch around the merge; a throw was an unhandled rejection in the MCP server. Fixed in `runOnce`; test in `reindex.test.ts`.
> - **Bug — merge after `codegraph index`:** ran in process on the main thread (vscode: killed by the #850 watchdog, 0 files merged) and before `ANALYZE` (no planner stats: Playwright merge >2 min instead of 6 s). Now `mergePass` (worker thread) after maintenance; a rebuild clears merge stamps (`mergeRebuiltGraph`). vscode full index with SCIP: 162 s, 13,519/14,008 merged.
> - `runIndexerPool(mode)` split into `runFull` / `runPatch` (shared `runOnce`, `inPool`); the deleted explanatory comments restored.
> - Call-site listing: the `DETAILED_CHARS_PER_SITE` guess replaced by building the detailed list until it passes `MAX_DETAILED_CHARS` (exact, reads files only up to the limit); one compact builder. Unresolved count takes the sites already loaded (vscode `add`: section 157 → 132 ms).
> - `edgeFlag(flag, column)` in `store.ts` is the one spelling of the silent/stale SQL rule; `otherCalls` uses it.
> - Watcher: the per-save wait is chosen from the metas (`patchDriftExceeded`), not the full plan (vscode ~45 → 9 ms per save).

**Ownership / maintainability lens:** [scip-clean-code-review.md](./scip-clean-code-review.md) (SRP, mode-flag concern on `runIndexerPool`, follow-up recommendations).

---

## Executive summary

Five themes landed together:

1. **Orphan-install heal** — an index can sit on disk after `installIndex` if merge never runs; the next round must still merge it (`mergedAt` / `needsMerge` / `reindexRound`).
2. **ScipMeta transitions** — full / patch / import write planner fields through one set of helpers so import cannot wipe `patchRatio` / `fullRunMs`.
3. ~~**Shared indexer pool** — full and patch produce paths share `runIndexerPool`.~~ Since split back into `runFull` / `runPatch` sharing `runOnce` (the mode flag mixed two failure policies).
4. **Explore call-sites ↔ Flow** — same named-symbol resolution; “verified” means `scipVerdict`, not bare `provenance === 'scip'`.
5. **Status counts ↔ verdict** — `scipStatus` excludes stale/silent; `COALESCE(metadata,'')` so SQLite `NULL LIKE` does not drop null-metadata SCIP edges from the verified bucket.

---

## Theme 1 — Orphan install / merge skip

### Problem

`installIndex` wrote `.scip` + meta, then a later language throw / crash / early return could skip merge. The next `scip index --changed` saw “up to date” and **never merged**, leaving the graph without compiler edges for that install.

### Design

| Piece | Role |
|--------|------|
| `ScipMeta.mergedAt` | Wall time of last successful merge of this install |
| `installIndex` | Always strips `mergedAt` (install ≠ merged) |
| `markMerged` | Set after a successful pass over that lang’s index |
| `needsMerge(root)` | Any index with missing `mergedAt` or `producedAt > mergedAt` |
| `mergeInstalled` | Runs if this round installed **or** `needsMerge` — even when every produce is “current” |
| `reindexRound` | Produce all langs (catch failures), then **always** `mergeInstalled` |

**Scoped vs full merge (subtle):** when this round’s installs are all patches, keep a **file/symbol scope**. When there is a full rebuild, or orphan heal with **no** installs this round (`pending && scopes.length === 0`), do a **full** merge. ~~Do **not** require `!pending` for scoped merge — every install clears `mergedAt`, so pending is expected after a successful patch install.~~ **Wrong:** when the index under a patch was never merged, the scope stamped it merged unjudged. A patch now returns no scope (full merge) unless `isMerged(previous)`.

### Files

- New: `src/scip/round.ts`, `__tests__/scip/round.test.ts`
- Wired: `src/scip/cli.ts`, `src/scip/reindex.ts` (watch background reindex)
- `src/scip/first-index.ts` — still uses overlapped produce for `init --scip`; merge path shares `mergeInstalled`
- `src/scip/index.ts` — `mergeInstalled`, `markMerged` after pass
- `src/scip/store.ts` — `mergedAt`, `needsMerge`, `markMerged`

### Review checklist

- [ ] Crash between install and merge → next `--changed` prints documents merged and sets `mergedAt`
- [ ] Multi-lang: TS succeeds, Python fails → TS edges still merged; `needsMerge` false afterward
- [ ] Patch-only round still gets a **scoped** merge (not forced full solely because pending)

---

## Theme 2 — ScipMeta helpers

### Problem

Ad-hoc meta objects at full / patch / import sites drifted. Notably, **import** could drop `patchRatio` / `fullRunMs` / `patches`, disabling the half-full-run gate silently.

### Design

Central transitions in `store.ts`:

- `metaAfterFull(previous, fields)` — new full baseline; keep `patchRatio` only if same tool
- `metaAfterPatch(previous, fields)` — bump `patches`, optionally recalibrate `patchRatio` when plan units match
- `metaAfterImport(previous, fields)` — same-tool planner fields carry over
- `nextPatchRatio` / `patchDriftExceeded` / `MAX_PATCHES` / `MAX_PATCH_AGE_MS` — moved next to the meta they govern

Call sites: `produce.ts` (full + patch), `importScipFile` in `index.ts`.

### Review checklist

- [ ] Import of same tool preserves `patchRatio` / `fullRunMs` / `patches`
- [ ] Tool change on full/import clears planner fields that belong to the old tool
- [ ] `__tests__/scip/produce.test.ts` covers the transitions you care about

---

## Theme 3 — Shared `runIndexerPool`

### Problem

Full and patch paths duplicated pool / concurrency / nice / abort wiring.

### Design

~~`runIndexerPool(...)` in `produce.ts` used by both full and patch. Indexer adapters (`typescript.ts`, `tsgo-index.ts`) only needed tiny signature alignment where they plug into the pool.~~ **Correction:** the adapter change is a shared `SOURCE` regex exported from `typescript.ts`, unrelated to the pool; the pool itself is now `runFull` / `runPatch`.

### Review checklist

- [ ] Abort mid-pool still fails cleanly on both full and patch
- [ ] No behavioral change to which files enter a patch vs full run

---

## Theme 4 — Explore call-sites

### Problems

1. Call-sites treated `provenance === 'scip'` as verified — **stale** edges keep that provenance, so explore could vouch for demoted edges.
2. Call-sites re-lexed the query; Flow used `resolveNamedSymbolFlow` — two naming policies.
3. Large targets (Playwright `toBe`, vscode) built a detailed listing (reading hundreds of caller files) only to discard it for the compact form.

### Design

| Change | Where |
|--------|--------|
| `compilerVerified` → `scipVerdict(...) === 'verified'` | `callsites.ts` |
| Explore builds Flow **first**, passes `exactNodeIds ∪ flow.namedNodeIds` into call-sites | `tools.ts` |
| Type.method co-name supplement + file-token filter retained | `callsites.ts` `targets()` |
| Estimate detailed size (`DETAILED_CHARS_PER_SITE`); compact path first when over budget | `callsites.ts` |

### Review checklist

- [ ] Plant `scipStale` on a call edge → explore marks `[unverified]`; status stale +1 / scip −1
- [ ] Query naming both type and method still surfaces the right overload (bench T2 / file filter)
- [ ] `__tests__/scip/callsites.test.ts` green

---

## Theme 5 — `scipStatus` aligned with `scipVerdict`

### Problems

1. Verified count was `COUNT(provenance = 'scip')`, including stale (and not matching explore).
2. ~~Flag predicates used bare `metadata LIKE …`. In SQLite, `NULL LIKE x` is NULL; `NOT NULL` is NULL → **null-metadata SCIP edges were excluded from verified** and also not stale.~~ **Correction:** the committed code (HEAD) counted `provenance = 'scip'` with no `NOT (…)`, so it never had this bug; it appeared in this WIP's first `NOT (metadata LIKE …)` version and was fixed in the same WIP. The table below compares two WIP states. Against HEAD the real change is that stale edges no longer count as verified (Playwright: −80).

Live impact (playwright eval cache, before → after COALESCE):

| Bucket | Before | After |
|--------|--------|-------|
| compiler-verified | 100 999 | 125 455 |
| stale | 80 | 80 |
| silent | 16 982 | 16 982 |

### Design

- `SILENT_EDGE` / `STALE_EDGE` = `COALESCE(metadata,'') LIKE '%"scipX":true%'`
- `scipStatus.edges.scip` = provenance scip ∧ ¬silent ∧ ¬stale
- Partial index `scip_silent_edges` recreated when old definition lacks `COALESCE` (planner match)

### Review checklist

- [ ] `status.scip + status.stale === COUNT(provenance = 'scip')` on corpora with null-meta edges (playwright)
- [ ] Merge test: null-metadata scip edges count as verified
- [ ] Silent partial index still used (`EXPLAIN QUERY PLAN` in merge test)

---

## File map (review focus)

| Path | Change |
|------|--------|
| `src/scip/round.ts` | **New** — produce-all-then-merge round |
| `src/scip/store.ts` | `mergedAt`, meta helpers, COALESCE predicates, index migrate |
| `src/scip/index.ts` | `mergeInstalled` pending, `markMerged`, import meta, status SQL |
| `src/scip/produce.ts` | meta helpers + `runIndexerPool` |
| `src/scip/cli.ts` / `reindex.ts` / `first-index.ts` | Callers of round / merge |
| `src/scip/callsites.ts` | Verdict, shared targets, compact-first |
| `src/mcp/tools.ts` | Flow before call-sites; shared ids |
| `src/scip/indexers/typescript.ts`, `tsgo-index.ts` | Pool wiring |
| `__tests__/scip/round.test.ts` | **New** — multi-lang fail + orphan heal |
| `__tests__/scip/merge.test.ts` | Status partition + null-meta |
| `__tests__/scip/callsites.test.ts`, `produce.test.ts` | Coverage for above |
| `scripts/scip-eval/verify-on-repo.js` | **New** (local) — corpus probe; optional to keep |

**Usually out of scope for this review:** `docs/scip-perf-hotspots.md`, `scripts/scip-eval/profile-*.js`, `scripts/scip-eval/results/*`, `.cursor/hooks/*`, `AGENTS.md` preference stubs (unless you want those folded in).

---

## Verification already run

Commands used Node **22** from `~/.local/opt/node-v22.23.3-linux-x64` (Node 26 warned; node-24 not present locally).

| Check | Result |
|-------|--------|
| `npx vitest run __tests__/scip/merge.test.ts` | 21 passed |
| Broader `__tests__/scip/` (earlier in session) | 103 passed (pre–null-meta test; re-run full suite before merge) |
| Live: codegraph, cobra | Orphan heal + call-sites + status plant |
| Live: playwright, django, ripgrep | probe **PASS**, orphan **PASS** after COALESCE fix |

Probe script checks: call-sites section present → plant verified edge stale → status Δ → explore `[unverified]` → strip `mergedAt` → `scip index --lang … --changed` merges and restores `mergedAt`.

---

## Pseudocode (behavior contracts)

```
reindexRound(langs):
  results = []
  for lang in langs:
    try results += produceIndex(lang)
    catch results += failed(lang)
  if aborted: return results, null
  return results, mergeInstalled(results)

mergeInstalled(results):
  scopes = install scopes from results
  pending = needsMerge(root)   # missing mergedAt or producedAt > mergedAt
  if no scopes and not pending: return null
  scope = join(scopes) if all installs were patches else full
  run merge; markMerged(each index)

installIndex(meta):
  write scip bytes
  write meta WITHOUT mergedAt

scipStatus.verified:
  provenance = scip
  AND NOT COALESCE(metadata,'') LIKE '%scipSilent%:true%'
  AND NOT COALESCE(metadata,'') LIKE '%scipStale%:true%'

explore:
  flow = buildFlowFromNamedSymbols(query)
  callSites(exactIds ∪ flow.namedNodeIds)
  mark site verified iff scipVerdict === verified
```

---

## Known follow-ups (not in this WIP)

- H4 / H5 / silent-edge vs loose `LIKE` in merge maintenance (deferred from earlier review)
- Whether to keep or delete `scripts/scip-eval/verify-on-repo.js`
- Re-run full `__tests__/scip/` after the COALESCE + null-meta test before committing
- Commit when maintainer asks (still outstanding)

---

## Suggested review order

1. `store.ts` meta + `mergedAt` / COALESCE (contracts)
2. `round.ts` + `mergeInstalled` (orphan heal + scope rule)
3. `callsites.ts` + `tools.ts` explore ordering
4. Tests in `round.test.ts` / merge status tests
5. Spot-check live corpus numbers only if status SQL still looks wrong
