# Managed extension process-death recovery — 2026-09-22

This increment extends draft PR #1911 on `feature/extensions-author-kit-20260922`.
Source tested: `9ab6959d26fc8b1deddecbb136f08e109505e055` (implementation checkpoints
`e7f89a4`, `4c13016`, `9ab6959`). This is Linux/local acceptance, not a release or
hosted CI result. The final evidence commit changes documentation only.

## Recovery contract

A checksummed, atomically written and fsynced transaction record captures the
previous/proposed config and trust before mutation. Immutable package staging
is recorded too. The candidate graph replaces the active graph in one SQLite
transaction, with the lifecycle transaction ID committed in that same transaction.
A fresh process uses that marker to roll back an uncommitted change or complete
a committed one. Recovery itself is repeatable after interruption and evaluates
no extension modules. Package identity/version/trust is checked before clearing
the journal; candidate config/trust is checked again before graph commit.

A dedicated SQLite `BEGIN IMMEDIATE` coordinates managed operations and normal
index/sync/init/recreate writers for their full run. Kernel-released ownership
survives neither a dead process nor PID reuse; timestamps do not authorize
stealing a lock. Legacy live/ambiguous PID owners and torn records fail closed.
Legacy graph owners are checked before reaching the older file-lock helper, so
its age-based behavior cannot override a live owner on these guarded paths.

Fresh CodeGraph open/read/index, CLI status, extension list/status and subsequent
lifecycle operations reconcile pending state. Explicit `extensions recover` is
also available. A companion status conflict returns an actionable error instead
of ready. A long-lived graph reader clears cached nodes when another process's
lifecycle commit marker changes.

Only the transaction's plugin fields and changed trust entries are reconciled;
unrelated config/trust edits and other files survive. Conflicting plugin edits,
index-affecting settings, changed package bytes, or damaged journals block with
repair instructions and retain evidence. The operator preserves their edit,
restores the indicated side, recovers, then reapplies/reindexes. New package and
candidate files from a rollback are removed; previously present package caches
are retained. A first install without a prior database returns to uninitialized
when its graph has not committed.

## Real process-kill matrix

`RECOVERY_OUTPUT=.qa/recovery/process-recovery-final node scripts/validation/extensions-recovery.cjs`
exited **0** in **108.392 seconds** at the tested source. **35 matrix cases passed**.
The harness created disposable Python projects and killed only subprocesses it
spawned; it never killed a shared service. Fresh processes checked actual SQLite
route contributions, config bytes, installed package version/digest/trust,
transaction/staging cleanup, and preservation of an unrelated file.

| Operations | Kill boundary | Required result | Cases |
| --- | --- | --- | ---: |
| Install, update, enable, disable, remove | Journal prepared; config written; inside graph transaction before commit | Restore previous settings, trust and graph | 15 |
| Same five operations | After graph commit, before cleanup/ready | Complete new settings, trust and graph | 5 |
| Update | Package ready; trust written | Roll back, remove newly staged package/trust | 2 |
| First install into an uninitialized project | Before graph commit | Fresh real CLI status reports uninitialized | 1 |
| Recovery itself | After recovered config, before remaining cleanup | Second fresh recovery finishes idempotently | 1 |
| Live aged owner | Paused after config change | Concurrent install, open/read, index all rejected; owner not stolen | 1 |
| Reused/legacy PID owners | Current SQLite ownership vs plain PID | Current orphan reclaimed despite reused/live PID; legacy live blocks, dead reclaims | 1 |
| Invalid/torn journal/owner | Damaged persisted records | No guessing or overwrites; verified journal restores recoverability | 1 |
| Unrelated config/trust edits | Before and after graph commit | Preserve edits and reconcile lifecycle fields | 2 |
| Conflicting plugin edit | Before and after graph commit | Preserve bytes, actionable failure, recovery after operator repair | 2 |
| Aged/torn legacy graph lock | Before next writer | Live PID protected regardless of age; unknown owner blocked | 1 |
| Changed indexing rule | After config change | Preserve edit; require explicit reconciliation | 1 |
| Tampered installed package | After graph commit | Refuse recovery until recorded bytes restored | 1 |
| Long-lived reader | Another process recovers committed update | Cached old route becomes new route without reopening reader | 1 |

The matrix has **103 child receipts**: 35 intentional SIGKILLs, 56 exit-0 runs,
and 12 expected exit-1 rejection cases. Those rejections are acceptance checks,
not unhandled failures. Every normal lifecycle matrix row includes a repeated
recovery check. Raw child logs and per-command exit/signal/hash records are in
`.qa/recovery/process-recovery-final/`; their hashes and the matrix are preserved
in the companion JSON evidence ledger.

## Other validation

At `9ab6959`, the engine/UI build exited 0 (33.999 seconds); the focused
regression passed **157 tests across 15 files**, with **1 Windows-only database
replacement case skipped**, exit 0 (56.356 seconds). This includes installer,
compatibility, author harness, SDK, status, sync, database replacement,
concurrent reads, and watcher tests. Both compiled-worker lifecycle/isolation
and failed parse/resolver update rollback tests passed, exit 0 (7.902 seconds).
The browser/headless compatibility run passed **9 checks and 12 CLI receipts**,
exit 0 (25.563 seconds). The publisher/lifecycle/origin/window browser regression
passed **11 checks**, exit 0 (14.125 seconds), with no page errors. The current
[installed-state capture](extensions-process-recovery-20260922/desktop-installed.png)
was inspected: selected 1.10.0, CodeGraph 1.6.0/API 1, destination and successful
graph refresh are visible. These preserve immutable ownership/signature checks,
exact pins/preview handling, automatic no-downgrade, and rollback behavior.

The [JSON ledger](extensions-process-recovery-20260922.json) records exact
commands, exits, source/compiled hashes, raw-log hashes, all child receipts,
compatibility receipts and the recovery matrix. No final-source check failed.

The earlier 110-test focused pass at `4c13016` is retained separately. The first 31-case kill
pass preceded the extra trust/config/cache/legacy-lock checks. Two initial build
failures were TypeScript syntax mistakes in guard insertion; their failed
receipts are retained rather than presented as passing runs.

Reproduce the committed harnesses after `npm ci` and `npm run build`:

```sh
node scripts/validation/extensions-recovery.cjs
node --test scripts/validation/extensions-runtime.test.cjs
PLAYWRIGHT_MODULE=/path/to/playwright node scripts/validation/extensions-compatibility.cjs
PLAYWRIGHT_MODULE=/path/to/playwright node scripts/validation/marketplace-browser.cjs
```

Browser harnesses require local Chrome and Playwright; output-directory overrides
and the exact regression/build commands are preserved in the evidence JSON.
The compiled harness forces bounded workers and uses fresh subprocesses.

## Limits and remaining gates

Validated on Linux x86_64, Node 22.23.2, local filesystem/SQLite only. No actual
Windows/macOS, power-loss simulation, network-filesystem locking, mixed older
writers bypassing the coordinator, raw database edits, deliberate deletion of
coordination files, or concurrent project destruction is claimed. Corrupt
journals need a verified backup/manual repair; PID-only live ambiguity is not
resolved by guessing. No automatic deletion of all older immutable packages.

The historical full suite (4,545 passed / 192 skipped at `07b0a10`) predates the
author/compatibility/recovery increments and is **not** current whole-suite
proof. Unaffected Drupal extraction/flow/determinism/incremental evidence is
reused without a corpus rerun. Historical Drupal rebuild overhead remains
**22–30% versus built-in**, with limited samples; it is not a fresh performance
measurement of these guards or exhaustive framework coverage. Agent A/B remains
outside the authorized scope.

Next bounded step: native Windows/macOS lifecycle and recovery validation.
Hosted HTTPS acceptance, durable registry/artifact storage/backups and Vercel
integration, plus broader Drupal/performance review remain open. Local recovery
is reviewable; full product completion, hosted preview readiness and release are
not claimed. No merge, production deployment, npm release, paid resources,
contributor announcements or extra model sessions were used. These tests concern
installer process death, not the unknown cause of earlier Hoblets task interruptions.
