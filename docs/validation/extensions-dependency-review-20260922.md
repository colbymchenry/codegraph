# Semantic dependency contract review — 2026-09-22

The recommendation is an **internal shadow recorder for one host-owned edge-only
adapter**, followed by a separate decision before skipping callbacks. Capture must
include negative reads and predicate membership; a declared “deterministic” API-v1
plugin cannot safely opt itself into reuse. The production engine, public API, schemas
and immutable Drupal 0.1.0/0.1.1 packages are unchanged.

Read the [decision and proposed contract](../design/semantic-dependency-contract.md),
[executable model](dependency-review/model.cjs), [driver](dependency-review/run.cjs)
and [source/receipt ledger](extensions-dependency-review-20260922.json).

## New validation

Tested review source: `57f332dbb70dbbaf2a45fc2f6bf8fdd76c11f46a` (clean checkout).
Accepted application remains `7575dcc71e4524c660aff06486ebc007cca290b9`;
accepted previous full validation checkout is `e0885ee750ffc99bfb304906bed25966cdac6fb7`.
All changes since accepted head `b04cf479375b955d58dfed69d9211e43baecdf54` are under
`docs/`. Executable review files are validation-only, not merely prose.

Final command, from repository root:

```sh
python3 ../run-check.py dependency-review-final \
  node docs/validation/dependency-review/run.cjs .qa/dependency-review/final
```

Exit **0**, **42 grouped checks**, Linux x64 / Node 22.23.2, 6.650 s total harness time.
This duration is not a performance benchmark or claimed update speedup.
Receipt: `.qa/recovery/dependency-review-final.json`; complete log: matching `.log`.
Self-copies of the two executable files match the tested commit. All results, input
hashes, full Drupal snapshots, read traces and outputs are retained under
`.qa/dependency-review/final/`; hashes and result bodies are in the ledger.

| Evidence | Result and scope |
|---|---|
| Four deliberate positive-read-only counterexamples | Expected stale outputs reproduced for missing symbol appearance, missing file appearance, query ambiguity and new indexed registration membership. Full read sets corrected all four |
| Generic, author and rule-model cases (29 more; 33 model checks total) | Actual generic callback bytes extracted from the existing TypeScript fixture; actual generated author detect/resolve callback. Rule fixtures cover directories, derived edge membership, ordering, ownership, options/config/project/package identity, unsupported-read fallback, failure/retry and cold cache. These are in-memory model assertions |
| Real unrestricted-hook counterexample (included above) | Exact existing `require('fs')` cross-file hook changed output with no captured reads. Falsely declaring it safe produced stale output; explicit legacy mode reevaluated the whole schedule |
| Nine Drupal reference states | Unmodified immutable 0.1.1 artifact installed using the current managed installer into a disposable four-file Pathauto subset. Modeled outputs equal uncached actual Drupal callback outputs **and actual managed-engine SQLite contributions** after each full candidate evaluation |
| Existing application evidence | Reused at original revisions; no new Linux full suite, native suite, browser or hosted run triggered for this docs-only review |

“42 checks” counts named scenarios, not 42 integrated engine tests. The model-only
reset/failure assertions do not certify process-death recovery, persistent cache
recovery, watcher behavior or arbitrary plugin determinism.

### Actual Drupal reference states

Source is Pathauto revision `b97aadf47a37cff25f7d6105c3dade6778fccb47`, obtained with
`git show <pin>:<path>`, not from modified working-tree files. The four original files
are `composer.json`, `pathauto.routing.yml`, `src/Form/PathautoSettingsForm.php` and
`src/Form/PathautoBulkUpdateForm.php`; exact hashes are recorded. Mutations stay in a
test-owned temporary project, removed afterward. No original corpus graph is touched.

| State | Actual Drupal edges | Settings route target |
|---|---:|---|
| Settings form missing | 1 | unresolved |
| Settings form appears | 2 | SettingsForm buildForm |
| Duplicate settings class appears | 1 | ambiguous, unresolved |
| Duplicate removed | 2 | SettingsForm buildForm |
| YAML `_form` retargeted | 2 | BulkUpdateForm buildForm |
| Bulk target renamed | 2 | buildForm in renamed file; new endpoint identity |
| Bulk target deleted | 0 | unresolved |
| Bulk target restored | 2 | BulkUpdateForm buildForm |
| Composer changed to non-Drupal | 0 | extension route nodes also absent |

Each state checks the full returned Drupal edge set, endpoint identity, metadata,
line and provenance against SQLite, plus exact expected edge count and settings
target. The unsupported `_entity_form` route remains without a handler link. The
last state explicitly proves `composer.json` is **not** in indexed file membership;
its bytes still control detection. Captured read counts are 6, 8, 10, 8, 8, 8, 6, 8,
2. This is a route/detection subset, not new whole-Drupal accuracy certification.

The engine still performs global evaluation. The model consumes the real engine's
nodes, source and indexed-file list afterward; no production cache is exercised.
The generic/author callback comparisons similarly establish representative behavior,
not a complete implementation of `ResolutionContext` or capability isolation.

## Failures retained

1. `dependency-review-first`: exit 1 after 28 model checks. The new harness mistakenly
   decoded the artifact's UTF-8 entry as base64. Fixed to use the existing package
   validator and UTF-8 format. No package bytes changed.
2. `dependency-review-second`: exit 1 after 35 checks. The harness required a route
   node after deliberately disabling Drupal detection. Corrected to assert absence
   of all contributed nodes in that explicit state; additionally restored the target
   first so composer detection must remove **two real edges**, not just preserve zero.
3. `dependency-review-third`: exit 0, 41 checks on the precommit harness. Added a
   project-identity check and immutable source copies before the final committed run.
   Only the final run supplies the 42-check count. All initial receipt bodies and
   logs remain available; early dirty harness states were not separately committed.

## Reproduce without the workspace wrapper

Use this preview checkout's built `dist` (build from this branch if unavailable) and
installed dependencies. The driver needs a local Pathauto Git clone containing the
pin above; it reads the pin directly and writes only a new temporary project and output.

```sh
PATHAUTO_CORPUS=/absolute/path/to/pathauto \
  node docs/validation/dependency-review/run.cjs /absolute/path/to/new-evidence-directory
```

The driver guards the reviewed Drupal 0.1.1 artifact SHA256
`e5ed73bee51524585e4f4da1d5017fdee3037a3fa71d8f08edab6c318fedc59a`.
The unchanged 0.1.0 hash is
`e5015747d02fe50d6af607b6c44f1db9cf7969a0070866ed03c7643377a459c8`.
Use a new output directory so older attempts remain intact. No network, registry,
credentials, remote import or hosting resource is needed to run this proof.

## Decision limits and remaining gates

The proposed view must close ambient I/O, capture empty/predicate results, preserve
stage snapshots and registry merge order, and publish graph plus trace generation
only after a successful candidate commit. Unknown/untrusted operations require the
global fallback; caught errors cannot erase taint. Extraction/postExtract caching,
cycle/fixed-point behavior, persistent read sets and graph storage deltas are deferred.
Whole-pass Drupal capture is broad and likely invalidates frequently. No new update
latency reduction is demonstrated by these model counts.

The [accepted semantic-update report](extensions-semantic-update-20260922.md) remains
the application validation: **4,577 Linux passes / 192 skips / 284 files once** at
`e0885ee`; [native run 35744283425](https://github.com/colbymchenry/codegraph/actions/runs/35744283425)
at `7575dcc` passed Windows 162 focused/four skips and macOS 165/one, including the
accepted recovery coverage. Those results are reused, not a new current-head run.
The latest remote runs were inspected before this review; no rerun was needed.

Accepted performance is still mixed: limited warm comment-edit/retarget medians
roughly 22% lower Pathauto and 26% lower Commerce; core cold 103.494 → 112.452 s
and higher RSS. Global candidate/database work remains. Historical 22–30% rebuild
overhead, unfavorable diagnostics, and the non-reproduced failed-reference polling
suspicion retain their original scope.

Next bounded step: internal shadow capture with full-oracle comparison for one
host-owned edge-only adapter, before deciding whether to implement selective reuse.
Cloudflare account/zone/resources, stable Worker HTTPS, provider persistence/backup
and deployed Free-plan CPU suitability remain unverified; proposed
`marketplace.getcodegraph.com` is unconfigured. No desktop, hosting, public API,
production deployment, merge, release or package publication occurred.
