# SCIP WIP — Clean Code / ownership review

**Branch:** `scip` (uncommitted WIP as of 2026-10-02)  
**Companion:** [scip-architecture-fixes-review.md](./scip-architecture-fixes-review.md) — *what* changed and *how to verify* behavior.  
**This note:** *whether* module boundaries and naming match changeability — Robert C. Martin vocabulary applied critically (no line-count dogma, no layer cosplay).

**Audience:** Reviewers who already understand orphan heal, meta helpers, and explore call-sites; they want a second lens on maintainability before merge.

**Out of scope here:** Perf eval JSON under `scripts/scip-eval/results/`, `.cursor/hooks/`, and whether to commit (maintainer decision).

---

> **Reconciled 2026-10-02:** Concern A (mode flag) → split into `runFull` / `runPatch`; Concern B (duplicate compact listing) → one builder with an exact budget cut-off; Concern C (verified rule spelled three ways) → `edgeFlag` in `store.ts`; Soft note on `reindex.ts` merge errors → it was an unhandled rejection (crash), now caught and logged. See [scip-architecture-fixes-review.md](./scip-architecture-fixes-review.md).

## Verdict (one paragraph)

The delta **mostly improves ownership**: one place owns “a re-index round completes with merge,” meta transitions live with on-disk SCIP state, and “compiler-verified” is one rule across explore, status, and call-sites. That is real SRP and removes divergent-change smells. The main **Clean Code concern** is `runIndexerPool(..., mode: 'full' | 'patch')` — two different failure/concurrency policies folded into one function with a mode flag; the next patch-only or full-only fix risks shotgun surgery. Secondary: duplicated compact-listing logic in `callsites.ts`, and three spellings of the same verified-edge rule (JS verdict vs SQL fragments). **Recommend:** merge the behavioral work; schedule a small follow-up to split or de-flag the indexer pool unless the team explicitly accepts the coupling.

---

## What improved (keep these)

### 1. `reindexRound` — single owner for “produce then merge”

**Concept:** A round must not leave an installed index unmerged because a later language failed.

**Before:** CLI and the watch scheduler each inlined produce loops and called `mergeInstalled` with slightly different error handling.

**After:** `src/scip/round.ts` owns the sequence; callers own locks, logging, and exit codes.

**Why this is clean:** One reason to change “round completeness.” `first-index.ts` correctly **does not** use `reindexRound` — overlapped start/finish is a different use case; forcing it into the round helper would be the wrong abstraction (OCP at a real variation point, not invented).

**Review:** [ ] CLI and `ScipReindexScheduler` both delegate to `reindexRound` without re-merging elsewhere.

---

### 2. `store.ts` — meta lifecycle and freshness gate inputs

**Concept:** What `.meta.json` means after full run, patch, import, install, and merge.

**Moved inward:** `metaAfterFull`, `metaAfterPatch`, `metaAfterImport`, `patchDriftExceeded`, `nextPatchRatio`, `mergedAt`, `needsMerge`, `markMerged`, `SILENT_EDGE` / `STALE_EDGE` with `COALESCE`.

**Why this is clean:** Produce and import were repeating planner fields; that was **divergent change** waiting to happen (import wiping patch gates was the concrete bug). Persistence + freshness comparisons belong in the module that already documents disk layout (`store.ts` header).

**Review:** [ ] No new ad-hoc `ScipMeta` literals in `produce.ts` / `index.ts` beyond the helpers.

---

### 3. One “verified” policy for agent-facing surfaces

**Concept:** An edge is compiler-verified only if `scipVerdict` says so (not stale, not silent).

**Wiring:** `callsites.ts` (`compilerVerified`), `index.ts` (`scipStatus`), explore Flow/trail notes (`notes.ts`).

**Why this is clean:** Policy is inward (verdict function + SQL mirrors); MCP formatting stays a thin consumer. Aligning explore call-sites with Flow resolution (`tools.ts`: Flow first, shared `ids`) fixes **two naming policies** for one user-visible answer.

**Review:** [ ] Stale plant still flips explore marking and status buckets (see architecture doc Theme 4–5).

---

## Concerns (actionable for reviewers)

### A. `runIndexerPool` mode flag — mixed reasons to change

| Policy | Full run | Patch run |
|--------|----------|-----------|
| On run failure | Retry via `fallback`; collect partial failures | First failure → abort patch (`failed`) |
| Concurrency | Heavy serial, then light pool | All-light pool or serial |
| Warnings | Per-label decoration | Pass-through from runs |
| `after` hook | Waits before timing | N/A |

**Smell:** Boolean/mode soup — full and patch share `runOnce` and spawn mechanics but **not** failure semantics. A patch concurrency tweak can regress full fallback behavior without a test naming the mode.

**Options (pick one in follow-up, not blocking behavior review):**

| Option | Shape | Tradeoff |
|--------|--------|----------|
| **A (recommended)** | `runFullIndexerPool` + `runPatchIndexerPool` sharing private `attemptRun` / `runOnce` | Slightly more surface; policies isolated |
| **B** | Keep one pool; inject small strategy objects for failure/concurrency | Heavier if only two modes ever exist |

**Review:** [ ] Team accepts mode flag as intentional coupling **or** opens a small refactor issue before the next indexer change.

---

### B. Duplicate compact listing in `callSitesSection`

When detailed output would exceed `MAX_DETAILED_CHARS`, the “lines per file” block is built in two places: early estimate path and post-detailed fallback.

**Smell:** Shotgun surgery inside one long but coherent function — not “too many lines,” but **two homes for one format**.

**Minimal fix:** Local helper, e.g. `appendCompactByFile(lines, shown, ok, unverified)` — no new module.

**Review:** [ ] Optional nit; safe to defer if call-sites output format is stable.

---

### C. Verified rule encoded three ways

1. `scipVerdict(edge)` in `notes.ts` (JS)
2. `SILENT_EDGE` / `STALE_EDGE` in `store.ts` (SQL)
3. Inline `COALESCE` + `LIKE` in `otherCalls` aggregation (`callsites.ts`)

**Smell:** Same invariant, three spellings — next metadata flag risks updating one path only.

**Minimal fix:** Reuse `SILENT_EDGE` / `STALE_EDGE` (or a shared SQL fragment export) in `otherCalls`; keep JS verdict as the semantic source of truth for non-SQL callers.

**Review:** [ ] `otherCalls` SQL matches status/explore semantics on a corpus with silent edges.

---

### D. Soft notes (document, don’t “Clean” for sport)

| Item | Judgment |
|------|----------|
| `produce.ts` re-exports `MAX_PATCHES`, `nextPatchRatio` from `store` | Compatibility facade — fine until imports settle on `store` |
| `store.ts` ~330 lines | Large but honestly named; splitting `meta.ts` without a second consumer is folder theater |
| `reindex.ts` merge errors | Behavior change vs old try/catch around merge only — confirm scheduler should not swallow merge failures silently |

---

## SOLID checklist (touched code only)

| Principle | Assessment |
|-----------|------------|
| **SRP** | Improved for round + meta; weakened for dual-mode pool |
| **OCP** | Good: `first-index` vs `reindexRound` respects real variation |
| **LSP** | N/A (no new subtypes) |
| **ISP** | N/A (no fat interfaces added) |
| **DIP** | No one-impl interfaces — good; do not add a “IndexerPoolStrategy” port unless a third mode appears |

**Dependency direction:** SCIP policy (`store`, `notes`, merge gate in `index.ts`) does not import MCP; `tools.ts` depends on SCIP adapters (`callSitesSection`) — arrows point correctly for a fork seam.

---

## Suggested review order (ownership lens)

1. **`round.ts`** — Is this the only orchestration entry for CLI + watcher? Any duplicate merge calls?
2. **`store.ts`** — Meta helpers + `mergedAt`; are install/merge transitions impossible to express wrong at call sites?
3. **`produce.ts`** — Read `runIndexerPool` with the mode table above; would you split it on the next touch?
4. **`callsites.ts`** — Verdict + perf paths; spot duplicate compact block
5. **`tools.ts`** — Explore ordering: Flow before call-sites, shared ids (no re-lex policy)
6. **Tests** — `round.test.ts` encodes round contract; architecture doc lists the rest

---

## Tests that anchor ownership (not exhaustive)

| Test file | Contract owned |
|-----------|----------------|
| `__tests__/scip/round.test.ts` | Later lang fail still merges earlier; orphan heal on `--changed` current |
| `__tests__/scip/merge.test.ts` | Status partition, null-metadata verified, index COALESCE migrate |
| `__tests__/scip/produce.test.ts` | Meta transitions, patch drift |
| `__tests__/scip/callsites.test.ts` | Verdict marking, target ids |

Re-run full `npx vitest run __tests__/scip/` before merge (see architecture doc verification table).

---

## Decision for maintainers (optional follow-up PR)

**Question:** Split `runIndexerPool` mode flag — **Option A** (two named pools + shared run helper) vs **Option B** (strategies) vs **accept** (document coupling in `produce.ts` header)?

**Recommendation:** Option A when the next indexer concurrency or patch-failure change lands; not required to ship orphan heal / meta / explore fixes.

---

## References

- Fork convention: [FORK.md](../FORK.md)
- Behavior + verification: [scip-architecture-fixes-review.md](./scip-architecture-fixes-review.md)
- Agent retrieval seam (upstream): `src/mcp/tools.ts` explore budgets — unchanged by this review except call-site id wiring
