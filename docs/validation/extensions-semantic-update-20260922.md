# Semantic update correctness and latency — September 22, 2026

The engine now reuses unchanged **core parser results** within a long-lived graph instance, while rerunning every framework hook, global resolver and semantic pass against a fresh candidate. Graph replacement and its FTS/secondary-index rebuild remain one SQLite transaction. This reduces measured warm update latency on the small and medium corpora; large Drupal updates remain expensive. It is not fine-grained semantic invalidation or an incremental database update.

Application source: `7575dcc71e4524c660aff06486ebc007cca290b9`. Final local test checkout: `e0885ee750ffc99bfb304906bed25966cdac6fb7`; its only delta is a main-thread guard in an executable validation helper under docs/. This is a test change, not prose or an application change. Native tests run the application SHA directly. The later evidence commit adds the report, ledger, screenshots and a byte-identical copy of the tested continuation helper. It makes no application changes. Same [draft PR #1911](https://github.com/colbymchenry/codegraph/pull/1911); no deployment, merge, package publication or remote registry writes.

## Implementation and safety

- Per-instance content/path/language/environment keyed cache stores only extraction before framework hooks. Its 128 MiB budget estimates serialized payload; it is not a JavaScript heap cap. Cache misses, errors, renames, oversized working sets and new processes use ordinary parsing. Closing the graph clears the cache. Framework and semantic outputs are never cached or inferred to be file-local.
- All global work still runs in the original insertion order. `CODEGRAPH_NO_SEMANTIC_REUSE=1` disables parser reuse; `CODEGRAPH_NO_SEMANTIC_BULK=1` restores per-row index maintenance. The disabled path passes the same exact route and cold-reference assertions.
- Indexed source/config/ignore inputs are observed before and after candidate evaluation. An observed change rejects the candidate and preserves the prior graph. This is not a filesystem lock or a snapshot guarantee for arbitrary external plugin I/O or writes after the last observation. Plugin configuration is stamped from the options actually loaded: a later edit during the SQLite copy stays dirty for the next sync.
- Built-in non-unique secondary indexes and FTS triggers are rebuilt **inside** the existing graph transaction. Primary/unique constraints and custom indexes remain. An explicit checksummed candidate record allows fresh-process cleanup after death. The OS-released SQLite coordinator is authoritative; PID age is not used to steal ownership. An invalid record blocks with an actionable error. A commit marker invalidates long-lived reader caches.
- No author API or Drupal package changes. Immutable 0.1.0 remains SHA256 `e5015747d02fe50d6af607b6c44f1db9cf7969a0070866ed03c7643377a459c8`; 0.1.1 remains `e5ed73bee51524585e4f4da1d5017fdee3037a3fa71d8f08edab6c318fedc59a`.

[Design and conservative fallback](../design/semantic-update-reuse.md). All source/compiled hashes, commands, receipts, failures and raw inventories are in the [evidence ledger](extensions-semantic-update-20260922.json).

## Measurements

Same pinned copies and exclusions as the accepted [Drupal review](extensions-drupal-review-20260922.md): Pathauto `b97aadf47a37cff25f7d6105c3dade6778fccb47`, Commerce `643bb39620c083f6d52acd41c8170d7f34b40e1c`, Drupal `eaba66f418831210acc6bc5b49c61d171853455b` (excluding `**/tests/**`), Express `9a34acf03cb818ff3f8bc40e44176e277a25cbb9`. Node 22.23.2/Linux x64; two parse workers, zero resolver workers, telemetry disabled. Operations run sequentially without another local validation workload; the shared host is not controlled. Baselines execute the accepted compiled engine before the first new build (the baseline `dist/index.js` hash matches the previous ledger), even where a receipt records dirty new source. Final application binaries remain fixed at `7575dcc` throughout the final measurements.

Wall time covers the awaited update, not the shorter parse-only `IndexResult.durationMs`. CPU is process user+system time; RSS is the process high-water mark, cumulative across a sequence, not an isolated per-operation allocation. Canonical snapshot verification runs between operations; RSS includes that harness, cached data and SQLite, so it cannot isolate cache allocation. The recorded ordinary edit appends a comment to an existing source file; it does not benchmark every kind of symbol/body edit. Metadata retarget changes a real graph link, while add/delete/rename are separately checked. First changes/new instances are cold; subsequent operations reuse the cache. Files still scanned/read and framework hooks still evaluated are not falsely counted as reparses: diagnostics distinguish core hits/misses from progress.

| Operation | Before/after samples | Before median s | After median s | Wall change |
|---|---:|---:|---:|---:|
| Pathauto ordinary edit | 3/3 | 1.863 | 1.456 | -21.8% |
| Pathauto metadata retarget | 3/3 | 1.725 | 1.337 | -22.5% |
| Commerce ordinary edit | 1/3 | 13.412 | 9.862 | -26.5% |
| Commerce metadata retarget | 1/3 | 13.692 | 10.112 | -26.1% |
| Core first/cold ordinary edit | 1/1 | 103.494 | 112.452 | +8.7% |
| Core warm explicit unchanged indexFiles | 1/1 | 142.963 | 126.710 | -11.4% |
| Core warm source restoration | 1/1 | 139.546 | 128.111 | -8.2% |

A warm single-file fixture edit reuses 90 core parses and reparses one in Pathauto, and reuses 1,231/reparses one in Commerce. Framework hooks and all global passes still rerun. Pathauto has three before/after samples; Commerce has only one baseline and three after samples. Each core comparison has one sample per operation/arm. These are descriptive observations, not a performance guarantee or statistical speedup claim. Core cold latency and memory increase; warm savings do not remove global resolution/store cost. The resumed core sequence below is a correctness/per-operation observation, not an additional matched baseline cohort.

| Sample | Wall seconds (all samples) | CPU seconds | RSS high-water KiB |
|---|---|---|---|
| pathauto ordinary before | 1.871, 1.736, 1.863 | 2.776, 2.619, 2.723 | 241228, 253080, 262976 |
| pathauto ordinary after | 1.456, 1.466, 1.401 | 2.036, 2.008, 1.931 | 241072, 257408, 263308 |
| pathauto metadata before | 1.716, 1.725, 1.733 | 2.578, 2.631, 2.820 | 245704, 260136, 262976 |
| pathauto metadata after | 1.341, 1.337, 1.336 | 1.907, 1.863, 2.005 | 242144, 257408, 263308 |
| commerce ordinary before | 13.412 | 19.359 | 540448 |
| commerce ordinary after | 10.014, 9.624, 9.862 | 13.084, 12.763, 13.058 | 528268, 580988, 605412 |
| commerce metadata before | 13.692 | 19.768 | 577080 |
| commerce metadata after | 10.112, 9.852, 10.344 | 13.280, 12.975, 13.799 | 560172, 596100, 605412 |
| Core ordinary before | 103.494 | 117.852 | 982024 |
| Core indexFiles-unchanged before | 142.963 | 121.344 | 1008684 |
| Core restore before | 139.546 | 119.744 | 1008684 |
| Core ordinary after | 112.452 | 120.418 | 1063388 |
| Core indexFiles-unchanged after | 126.710 | 81.476 | 1162416 |
| Core restore after | 128.111 | 83.240 | 1162416 |

Core continuation segments, measured separately after the interruption and not used as matched before/after latency samples (reuse/parse counts exclude the unchanged oversize `.phpstan-baseline.php`, which the engine deliberately skips):

| Operation | Wall s | CPU s | Core reused/parsed |
|---|---:|---:|---|
| resume-warmup-add-source | 86.672 | 119.013 | 0/6730 |
| rename | 91.015 | 81.227 | 6729/1 |
| delete-source | 94.372 | 81.813 | 6729/0 |
| resume-warmup-delete-source | 90.348 | 117.652 | 0/6729 |
| indexFiles | 83.620 | 77.807 | 6728/1 |
| indexFiles-unchanged | 80.828 | 76.017 | 6729/0 |
| full-equivalence | 86.428 | 117.735 | 0/6729 |
| remove-fixture | 85.717 | 80.976 | 6727/0 |
| final-no-change | 4.930 | 4.093 | none |

The suspected repeat rebuild from stable unresolved references **did not reproduce**. `getUnresolvedReferencesCount()` counts pending records, not failed records. The graphs retain 3,068/27,662/71,791 failed references and zero pending references; unchanged polls do not create a candidate or parse files. Core before/after poll arrays, including slower post-update polls, are retained in the ledger. No no-change bug fix or polling speedup is claimed. Explicit unchanged `indexFiles` still conservatively evaluates a global candidate.

Earlier cache-only and FTS-only attempts are retained and unfavorable: core warm restoration was 165.83 s and 153.61 s versus the 139.55 s baseline. Profiling exposed graph-copy/index maintenance costs, leading to the atomic secondary-index bulk replacement. This does not establish that all future updates improve. Estimated cache payload and higher process RSS remain part of the cost.

Historical **22–30% external rebuild overhead** remains observed evidence. The preceding review's 24 full-rebuild samples (wall +3.5% Pathauto/+7.9% Commerce/+0.02% core, core CPU +9.5%) compare built-in versus external graphs; they are a different workload from the before/after update comparison here. Unfavorable Drupal callback-only measurements remain unchanged. No universal zero-regression or speedup claim is made.

## Correctness and recovery

- Final Pathauto and Commerce sequences match all 20 and 12 shared baseline canonical graph states respectively. Each has 14 exact committed route-to-handler assertions. The original core sequence was interrupted after five completed rows and four exact route assertions, with no final exit receipt; it is neither a completed pass nor an assertion failure. Supported recovery verified the last completed graph and removed its orphan candidate. Three fresh-process continuation segments (each with explicit cache warm-up where needed) have 9 route/cleanup assertions, match the cold reference and return to the original graph. No partial timings are spliced into a claimed uninterrupted warm sequence. Add/delete/rename, metadata retarget between untouched endpoints, scoped sync and explicit `indexFiles` are included. Canonical comparisons remove node timestamps and physical edge IDs, not semantic fields.
- The generic Python author fixture changes metadata read by a framework hook in a different file. It checks global reruns despite a core cache hit, project isolation, actual pass failure/retry, source changes during evaluation, config edits during graph copy, cold equivalence and unchanged polling. It permanently retains an unresolved call. The Express/no-extension control also passes cold-reference and original-state restoration.
- Current pinned-corpus probes retain **28 individually grounded links, four negative cases and nine explore flows**, with no duplicate extension edges. These certify explicit cases, not every graph edge or complete Drupal precision/recall.
- Six new recovery cases per tested OS: SIGKILL/Windows process termination at candidate-ready, pre-commit, during index replacement, after graph copying before commit, and after commit; plus malformed-record refusal. Each boundary checks actual SQLite old/new edges, FTS content, custom index/schema preservation, concurrent writer exclusion, a reader kept open across recovery, fresh/repeated cleanup, retry, configuration and unrelated-file preservation. Only test-owned children/disposable projects are killed. These are process-death tests, not power-loss durability certification.
- Current Linux additionally repeats the existing 35 managed lifecycle recovery cases in both default and custom data directories, and both compiled-worker tests. The official Worker browser check exercises local workerd/D1/R2 -> reviewed Drupal 0.1.1 -> one connection/Install -> four asserted Pathauto links; failure preservation, disable/enable/remove and another-project isolation pass. Existing Worker storage/operator tests are reused from the accepted review because their source is unchanged; no current rerun is implied.

## Integrated validation

The final Linux shard results are:

| Shard | Passed | Skipped | Exit |
|---|---:|---:|---:|
| 1 | 1696 | 63 | 0 |
| 2 | 1133 | 56 | 0 |
| 3 | 857 | 17 | 0 |
| 4 | 891 | 56 | 0 |

- **Current full Linux: 4,577 passed, 192 skipped, 0 failed**, all **284 files exactly once** across four zero-exit durable shards. This supersedes the prior 4,574-pass suite for these core changes. Final shard receipts and raw Vitest results are preserved.
- [Native run 35744283425](https://github.com/colbymchenry/codegraph/actions/runs/35744283425), application `7575dcc`: Windows 2022 x64 **162 focused passed/four skips**; macOS 15 ARM64 **165/one skip**. All 14 steps per OS pass, including **76 recovery cases per OS** (70 managed + six new semantic cases), compiled workers, native paths, author, compatibility and browser checks. Exact platform, commands, exits, summaries and artifact hashes are included. Earlier native runs remain separately recorded.
- The current local official browser run has eight grouped checkpoints, certifying four named graph links. Inspected [desktop](extensions-semantic-update-20260922/desktop-installed.png) and [mobile](extensions-semantic-update-20260922/mobile-official.png) captures show the official installed version, selected destination and graph-refresh confirmation. Author/compatibility/browser native checks use the portable Node backend; official local Worker acceptance is separate. None proves deployed Cloudflare behavior.
- Early fixture/assertion-harness errors and failed attempts remain in the ledger. The preload assertion helper initially ran in worker threads without CLI arguments; the final helper runs only on the main thread. Owned fixtures were removed and original graph hashes verified before rerunning. A continuation helper initially looked up the route's machine name rather than its literal route name; that helper failure and corrected source are also preserved. No application assertion was relaxed. The original core sequence has no final receipt after the service interruption; its cause is unconfirmed. The first Linux shard attempt also ended with tool exit 143 before a runner receipt or Vitest JSON result; its original log/start record and tool outcome are retained under `linux/interrupted-shard-1-attempt1`. Only unfinished work was retried. Final accepted commands complete with zero exits.

## Reproducing the checks

Use a disposable copy of the pinned corpus with the reviewed 0.1.1 extension installed; never run the mutation benchmark on a user's working project. Exact project preparation and all observed commands remain in the preceding Drupal review and this ledger. The full benchmark is the normal entry point; the continuation helper only applies to the specifically recorded interrupted fixture.

```sh
npm run build
node --require ./docs/validation/semantic-update-assert.cjs scripts/validation/semantic-update-sample.cjs /absolute/disposable/drupal-project /absolute/new-result.json 3
node scripts/validation/drupal-review-probes.cjs drupal /absolute/disposable/drupal-project /absolute/probes.json
SEMANTIC_RECOVERY_OUTPUT=.qa/new-semantic-kills node scripts/validation/semantic-update-recovery.cjs
RECOVERY_OUTPUT=.qa/new-managed-kills node scripts/validation/extensions-recovery.cjs
CODEGRAPH_DIR=.codegraph-custom RECOVERY_OUTPUT=.qa/new-custom-kills node scripts/validation/extensions-recovery.cjs
node --test scripts/validation/extensions-runtime.test.cjs
node node_modules/vitest/vitest.mjs run --shard=1/4 --maxWorkers=2 --minWorkers=1 --reporter=default --reporter=json --outputFile.json=.qa/new-shard-1.json
```

Repeat the last command with shards 2/4, 3/4 and 4/4 and separate output names; compare their file lists for complete, exactly-once coverage. The recorded runner also saves command exit status and log hashes. Native job receipts include dependency/browser installation and the exact 14 test steps; no local simulation substitutes for the actual OS runs.

## Limits and next bounded step

API v1 permits arbitrary whole-graph hooks and reads. The safe current optimization reuses pure parser output; every update still builds and atomically replaces a complete candidate. A fresh CLI stays cold and core updates still take roughly minutes. Cache memory, source observation and global resolution/storage costs are explicit. No persistent cache, fine-grained dependency tracking, package change or public API break is introduced.

A next design review can define an **additive, opt-in dependency contract** for deterministic passes: track file reads and symbol queries including missing targets, declare hook purity and retain global fallback for legacy or untracked I/O. Only after equivalence/recovery evidence should such a contract drive selective invalidation. Efficient fine-grained semantic updates remain open; this milestone does not relabel a full rebuild as incremental.

Cloudflare account/plan/resources, stable Worker HTTPS, provider redeploy persistence, remote backup/restore/retention and deployed Free-plan CPU fit remain unverified. Proposed `marketplace.getcodegraph.com` remains unconfigured. The prior passing Node HTTPS evidence covers a separate backend and older source; no current-head all-green hosted CI or Worker hosting claim is made. Other OS/browser combinations and unsupported dynamic Drupal forms remain outside certified coverage. Product remains incomplete.
