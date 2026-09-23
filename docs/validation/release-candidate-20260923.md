# Extension release candidate — 2026-09-23

Preparation only. Candidate implementation is `61e668e613f98f0c6a2ba662d953c3a75eb8822f` on [draft PR #1919](https://github.com/colbymchenry/codegraph/pull/1919), stacked on unchanged PR #1911. No merge, tag, publication, announcement or provider change occurred. The scoped candidate passes current Linux regression, affected native checks and combined exact-artifact acceptance. **Recommend maintainer review for the CLI extension release; do not publish these unversioned validation artifacts.** Version selection, review/merge approval and the versioned multi-platform release workflow remain separate gates.

The isolated branch is `candidate/extensions-release-20260923`, based on accepted extension PR #1911 at `59009c5c6c451f60c558007dbb4fc17fce9f5162`. The original worktree remains unchanged. npm baseline is the actual installed main/platform package 1.6.0 (gitHead `dfccdf62547fcd76d343344d823a0e1998d3a89f`), not merely its source tag. Saved registry integrity and tarballs identify that baseline. Current-source reproduction **or** npm reproduction suffices; both are not required.

## First-wave matrix

| Issue | Reproducing baseline and behavior | Reviewed integration | Candidate scope |
| --- | --- | --- | --- |
| #1902 | Accepted 59009c5: watcher/scoped edits write to the unlinked database; MCP catch-up misses live state | PR #1917,69f0b67/1488bdc (danusha2345) | Reopen is serialized with extension coordination/index mutex; widen the next sync after replacement and retain catch-up on failure. Six focused cases pass on Linux and macOS; Windows skips the POSIX replacement cases. Native evidence at 90516f8 is reused for unchanged engine bytes; repaired lifecycle fixture passes at 61e668e. |
| #1887 | Accepted compiled baseline: 150k-node interrupted secondary-index fixture,100ms real watchdog, killed at 1s progress cap | PR #1888,5115fe3 (Christopher Beaulieu / @cbeaulieu-gt) | Async open/reopen offloads secondary-index repair. Same100ms fixture passes. Not a default 60s capacity claim or all-migration latency guarantee. |
| #1895 | Accepted 59009c5 and Klaus's independent source/SQLite receipt: schema-less ancestor captures root discovery | PR #1913,870bd2a/74ba791/738b35a (danusha2345) | Empty/schema-less/foreign distinction, fail-open read-only inspection errors. Twelve source/current compiled CLI cases and the packed CLI boundary pass. |
| #1910 binary | Accepted 59009c5 and actual npm 1.6.0: small MPEG transport stream named.ts becomes a source record | PR #1914,1844aa5/10def05 (danusha2345) | Discovery, git/scoped sync and TypeScript-to-video conversion; legitimate source retained. Eight cases and same baseline probe pass. |
| #1910 size | Accepted 59009c5 and actual npm 1.6.0: over-limit1MiB+1 bytes fully read three times; pre-safeguard candidate also indexes growth after stat | PR #1915,228e03a/0593f9e (danusha2345), plus bounded descriptor reads | Source/extraction/resolution reads capped at1MiB+1 with file-size checks. Same no-full-read and growth probes pass; no multi-GB reproduction. |
| #1864 | Accepted 59009c5 and actual npm 1.6.0: unchanged calls repeat dominant aggregation | PR #1916,0483f89 (danusha2345), plus rollback-safe cache | Memoization per connection, conservative no-cache on runtimes without transaction status. Contributor integration initially cached rolled-back state; same SQLite rollback probe now passes. First-call and one-shot CLI costs remain. |

Original baseline watcher/root suite has14 failures/4 controls plus an unhandled closed-database rejection; it is not a clean certification run. Corrected post-integration watcher case pauses the actual orchestrator rather than asserting a mutex before the asynchronous extension guard enters it. The original 20ms watchdog experiment is invalid evidence for #1887: heartbeat cadence is at least 50ms. It and failed attempts remain retained; the 100ms before/after pair establishes the bounded recovery case.

## Security review #1367

| Finding | Current disposition | Boundary / remaining work |
| --- | --- | --- |
| Arbitrary indexed `projectPath` | Documented cross-project behavior; actual two-project handler test passes on all three platforms | This local process is not an MCP-roots sandbox. Restrict the OS/service account when repository isolation is required. A roots allowlist is a policy change, not silently imposed here. |
| External symlinks | Existing real source test confirms metadata can be indexed; full-source `getCode` blocks escape | Symbol/metadata disclosure remains possible. Do not describe untrusted indexing as isolated from readable external files. A default-policy change needs a separate compatibility decision for existing SDK layouts. |
| Missing installer checksums | Reproduced accepted shell installer accepting mismatched archive and npm fallback accepting absent manifest using harmless fixtures; fixed candidate probes pass | Shell/PowerShell/bundle-upgrade/fallback require one exact SHA256 entry before replacement. Manifest origin remains trusted; no artifact-attestation verification or independent publisher authentication is added. Native Windows PowerShell installer and full generated upgrade checks pass at 61e668e; the first run failed because Get-FileHash was unavailable, so the implementation now uses .NET SHA-256. |
| Windows version interpolation | Accepted source allows invalid suffix to reach inert cmd dispatch and script builder; candidate rejects in full | No exploit payload executed. Legitimate versions retained, bundle destination literals escaped. Native PowerShell execution passes, including a destination containing an apostrophe. |
| Picomatch 4.0.3 | Actual npm 1.6.0 emits inherited `function Object` and overlapping repeated alternatives; current 4.0.7 passes same bounded regex tests | Already fixed by current lockfile; minimum dependency range raised to4.0.7. Only 16-character strings matched, no DoS/load experiment. Cargo workspace patterns still reach this dependency. |

Both [extglob](https://github.com/micromatch/picomatch/security/advisories/GHSA-c2c7-rcm5-vvqj) and [POSIX class](https://github.com/micromatch/picomatch/security/advisories/GHSA-3v7f-55p6-f55p) advisories identify 4.0.4 as the patched 4.x floor (checked 2026-09-23). This is a targeted re-triage, not a complete security audit or closure of #1367.

## Release gates

| Surface | Required evidence / current limit |
| --- | --- |
| Runtime / SDK / author tools | Verified coherent final build, public types and actual packed SDK/author tests. Semantic/framework extensions only; no arbitrary-language grammar-provider claim. |
| Managed lifecycle | Final-source install/update/failure preservation/disable/remove; compiled workers, native paths and interruption recovery on Linux/Windows/macOS. |
| Official Drupal | Immutable 0.1.0/.1 hashes and representative earlier 28 links/four negatives/nine flows retained; affected candidate lifecycle and recovery checks pass as recorded below. Earlier corpus evidence is representative, not complete runtime semantics. |
| Archive + npm | Pack exact candidate with Node runtime, inspect schema/grammars/retained viewer assets, execute real archive and npm shim, prove both viewer aliases reject and companion remains available. |
| Deferred viewer | No ui/web registration; early rejection covers help/invocation before listener/browser/relaunch. UI source/assets stay packaged; component package not published. |
| Marketplace preview | Existing read-only hosted preview remains unchanged. Public source-admission backend staged/empty, general publication disabled. General marketplace launch is a separate gate, not a claim in this CLI candidate. |
| Semantic latency | Full candidate/global passes and graph replacement remain. Warm Pathauto/Commerce improvements have limited samples; core cold103.49→112.45s and higher RSS, historical22–30% overhead remain accepted limits. Shadow capture is NO-GO for production skipping. |
| Hosted operations / cost | Existing Paid preview $5 target conditional shared allowances; memory/concurrency/independent retention remain open. No new provider/load/restore tests or operational changes for this candidate. |
| Release approval | Current candidate regression/native/artifact evidence passed within the platform limits below; maintainer review, release version selection and publication approval remain separate. Historical 4577 Linux and native 162/165 do not certify this candidate. |

## Current validation results

All four Linux commands ran at `307a39957c4a929c374242cdbfbd496649f1ba7a` and exited zero. The raw reports independently cover every one of the **291 test files exactly once**; there are **4,620 passed, 192 skipped and zero failed tests**. [Linux run 35918620571](https://github.com/colbymchenry/codegraph/actions/runs/35918620571) and [native run 35918620624](https://github.com/colbymchenry/codegraph/actions/runs/35918620624) both completed successfully. These are source-suite results, not counts from historical extension acceptance.

| Current Linux shard | Passed | Skipped | Failed | Files | Seconds |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 1,687 | 63 | 0 | 73 | 102.454 |
| 2 | 1,168 | 56 | 0 | 73 | 93.402 |
| 3 | 874 | 2 | 0 | 73 | 131.011 |
| 4 | 891 | 71 | 0 | 72 | 85.782 |

Current native repairs: **Windows 103 passed / four platform skips; macOS 106 passed / one platform skip**. Both five-step commands passed build, focused tests, actual growth-race probe, installer archives and security-negative probes. Windows executes 16 installer/upgrade cases including real PowerShell; macOS executes 11 shell/Node cases. Windows file replacement semantics still skip the POSIX-specific inode-unlink cases, and macOS skips the Windows-only case.

Unchanged paths reuse individually passing steps from the first native run at `90516f8` and first Linux run at `36726ad`: **76 recovery cases per OS** (six semantic, 35 managed default-directory, 35 managed custom-directory), two compiled-worker checks and native paths. First native whole jobs failed, as detailed below; only their passing unchanged steps are reused. The source diff from `90516f8` to application `61e668e` changes the Windows upgrade checksum implementation plus test fixtures/workflow, so native upgrade evidence is superseded by the current passing run. No overlapping focused counts are added across runs.

The archive and npm checks are combined evidence: nine successful packaged stages from the first Linux run plus six current companion/compiled-correspondence checks, using the same archive SHA-256. The separate tarball verifier confirms npm SHA-1/SHA-512 integrity, exact declared file lists, platform payload correspondence to the archive, and public SDK declaration correspondence. The JSON ledger preserves each failed overall command as failed.

## Reproduction command index

Commands are recorded as arrays, with exact working directories, revision, dirty status, exit and duration in the JSON ledger. Paths below are relative to the isolated candidate. The bounded Linux source/npm-library probes use Node 22.23.2; the npm baseline loads the actual saved platform package bytes, not a Git source tag. Packed candidate entrypoint checks separately execute the bundled Node 24.16.0 runtime. Dirty pre-commit safeguard runs are identified as such, and final committed-source suites validate the same tests.

| Concern | Before receipt / command | After evidence |
| --- | --- | --- |
| #1902 and #1895 | `.qa/recovery/release-baseline-watcher-directory-second`: Vitest `watcher-replaced-db` + `schemaless-db-not-initialized`, accepted 59009c5 | Same files in current full Linux; unchanged passing native first-run cases; current close lifecycle fixture. Packed root-discovery stage adds actual CLI behavior. |
| #1887 | `release-watchdog-valid-before`: same `liveness-watchdog.test.ts -t "keeps interrupted"`, `RELEASE_BASELINE_DIST=../codegraph/dist` selecting accepted 59009c5 compiled engine | `release-watchdog-valid-after` and current full Linux/native first-run test. Before SIGKILL, after normal zero exit. |
| Both #1910 and scoped #1864 | `release-baseline-bounded` and `release-npm-bounded`: `node scripts/validation/release-first-wave.cjs <dist>` | `release-safeguards-bounded`, native first-run `first-wave`, current full Linux binary/bounded/cache suites. Three probe failures become three passes. |
| Rollback cache safeguard | `release-resume-contributor-bounded` / `release-cache-invalidation` at integrated contributor source | `release-safeguards-bounded` + `release-remaining-corrected`; current full suite includes same-/other-connection, rollback, replacement and extension graph commit/removal. |
| Size growth safeguard | `release-size-race-before-corrected`: actual growth after stat on integrated contributor source | `release-size-race-after`, current native `file-growth-race`; bounded-source suite includes sync growth and async descriptor race. |
| Checksum / invalid version | `release-security-before`: four inert/disposable security probes | `release-safeguards-security`, current native security and installer success/failure cases; current full upgrade/npm fallback suites. |
| Picomatch | `release-picomatch-npm-before`: real saved npm 1.6.0 dependency | `release-picomatch-current`, native first-run probe; current already-fixed dependency verified, floor raised without another parser implementation. |

The private archive retains baseline test copies, contributor metadata/patches, actual npm tarballs and all command bodies. Reviewable scripts are in `scripts/validation/release-*.cjs`, `docs/validation/release-*.{cjs,py}` and the named test files.

## Remaining release decisions

There is no remaining failing regression in this bounded first wave. This is not an assertion that all open issues are fixed or that all possible graph semantics are covered. Do not close #1864 or #1367 based on this report: one-shot CLI aggregation cost and the documented cross-project/symlink trust decisions remain.

The maintainer still needs to select the release version, review the stacked PRs, approve merge/publication and run the normal versioned artifact/signing/checksum workflow for every shipping platform. Only the exact Linux x64 archive/npm artifacts below were built and executed in this milestone. Native Windows/macOS source, installer and recovery proof does not substitute for testing their final shipping archives. No release date or public availability is promised.

General marketplace publication remains a separate **no-go** until the staged source-admission policy and operational decisions are reviewed. This does not block the tested trusted-package CLI/SDK lifecycle. Existing hosted memory/concurrency/retention and conditional $5 budget limits are unchanged.

## Proposed notes

The shortened Unreleased section in [CHANGELOG](../../CHANGELOG.md) is the draft. Detailed prior development and contributor credits remain in [history](../development/pre-release-history-20260923.md); viewer availability claims there are explicitly historical/deferred.

## Artifact and validation identities

Application source: `61e668e613f98f0c6a2ba662d953c3a75eb8822f`. The later `36726ad`, `bf81c39` and `307a399` commits change test helpers/workflows and expectations only. The archive was built at 36726ad on Ubuntu 24.04 and is reused verbatim for the final companion and compiled-byte comparison at 307a399. Native upgrade/installer changes were verified on Windows 2022 and macOS 15; Node 22.23.2 drives the source suites, while the actual Linux bundle contains Node 24.16.0.

| Unpublished artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Linux x64 archive | 59,028,989 | `c185309e52ab9e9498e9a8520db74b29573c8ba65ec7215377eacb515a56ae4d` |
| Main npm tarball | 416,325 | `31bcc842c4a07379d52abad1ca71af32dbb78a15a936cef2e46d9caab5d7414d` |
| Linux x64 npm platform tarball | 59,856,970 | `3222ce758ea5a1d388a001a3bd3e928c310341a24992bd7a4f5973c58b7335eb` |

These retain 1.6.0 metadata solely for disposable candidate validation. They are not the published 1.6.0 bytes and were not published. The maintainer must select the eventual release version and use the reviewed release workflow. This milestone certifies the tested Linux artifact and the stated native source/script boundaries, not six built/shipping platform archives.

The packed proof at 36726ad passed nine stages/33 commands: archive resources, actual archive and npm version/help plus rejection of both viewer aliases, schema-less ancestor behavior, public SDK and author CLI, graph-producing install/update, preservation after a failing update, and disable/enable/removal. Its last companion checkpoint failed because the helper searched for an unencoded localhost URL inside an encoded connection fragment. The current follow-up passes six checks to complete that checkpoint against the exact same archive and verifies compiled bytes and listener shutdown; this is combined evidence, not a claim that the first command exited0.

## Retained failures and verification limits

- Earlier restart attempts and tool143 exits have no invented completion receipts. The90516f8 archive survived: gzip/tar and1,099 compiled file hashes match the saved build, but its original build exit was not recorded. It is preserved separately and is not the final archive above.
- The initial native run35880834124 failed one close-race fixture on both platforms: close happened before the guarded async open started, leaving the test's unused fresh connection open. The repaired test waits for the actual open boundary. The macOS growth fixture missed canonical temporary paths; the corrected fixture must actually grow the file. Windows valid installs exposed missing Get-FileHash in the invoked PowerShell environment; .NET SHA-256 removes that dependency while mismatch/missing/duplicate/unlisted manifests still preserve existing files.
- Local package attempts timed out during compression and extraction; a local full shard ended with tool143 before a report. Read-only host inspection found no owned orphan to stop; observed host load43 on2 CPUs and574MiB available do not prove the cause of any earlier interruption. Shared services were not changed. Isolated GitHub Linux receipts replace the incomplete local acceptance attempts.
- The first isolated Linux shard passed1,686 tests and failed one old update-notice expectation. The new full-version parser rejects an entire tampered cache tag instead of extracting a version prefix. The updated test asserts rejection and retains a legitimate prerelease control;20 local update checks pass. No production code changed for this assertion correction.
- Earlier20ms watchdog results remain invalid for recovery attribution because the heartbeat minimum is50ms. Only the matched150k/100ms baseline-failure/candidate-pass pair supports the #1887 claim. It does not establish default-timeout performance on arbitrarily large databases.
- Native recovery/worker results at 90516f8 and Linux recovery/worker results at 36726ad are reused where source bytes are unchanged. Do not add overlapping focused counts across attempts or call a failed whole workflow green because individual steps passed.

The exact command receipts, complete logs, baseline npm registry metadata/tarball hashes, reviewed contributor patches and artifact file lists are indexed in the adjacent JSON ledger and the private recovery archive. No benchmark, hosted load/restore or shadow reuse experiment was repeated.

The second isolated attempt passed shard1 (1,687/63 skipped) and found one fixture failure in shard2 (1,167 passed/one failed/56 skipped): the failure hook still wrapped `readFileSync`, while the bounded reader uses descriptor opens. The hook now fails the actual `openSync` boundary; its unchanged assertions require an attempted failure, no newly indexed symbol, retained pending status and a successful retry. All13 cases in that file pass locally. The final full-suite attempt records every shard even when one fails so incomplete coverage cannot be mistaken for a complete run.

The tested archive uses the WASM extraction path, with no optional Rust native kernel prebuild included. Native source tests use Node 22.23.2; actual Linux archive/npm execution uses the bundled Node 24.16.0. Full-source hashes and command-level evidence delimit the reused checks.

## Evidence readback

Independent verification recomputed **738 source hashes, 1,096 final-archive compiled hashes, 1,070 raw-file hashes, 55 command receipt/log pairs and 750 nested subprocess log hashes**. The 55 completed command receipts include 35 zero exits and 20 nonzero exits (intentional before-failure evidence and retained failed attempts); eight started-only commands remain explicitly incomplete. The final four Linux receipts and both current native summaries pass independently of those earlier attempts.

The archive contains 1,096 compiled files, all matching the current CI build. The npm correspondence check verifies 255 public declaration files and 1,346 platform payload files against that archive. Local historical build leftovers are not used as shipping-artifact proof. The original accepted checkout and branch remain at `59009c5c6c451f60c558007dbb4fc17fce9f5162`.
