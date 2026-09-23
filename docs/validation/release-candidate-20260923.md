# Extension release candidate — 2026-09-23

Preparation only. No merge, tag, npm/GitHub release, announcement or provider change is authorized or performed. Candidate validation is in progress; final identities, receipts and recommendation will be added after it completes.

The isolated branch is `candidate/extensions-release-20260923`, based on accepted extension PR1911 at `59009c5c6c451f60c558007dbb4fc17fce9f5162`. The original worktree remains unchanged. npm baseline is the actual installed main/platform package 1.6.0 (gitHead `dfccdf62547fcd76d343344d823a0e1998d3a89f`), not merely its source tag. Saved registry integrity and tarballs identify that baseline. Current-source reproduction **or** npm reproduction suffices; both are not required.

## First-wave matrix

| Issue | Reproducing baseline and behavior | Reviewed integration | Candidate scope |
| --- | --- | --- | --- |
| #1902 | Accepted59009c5: watcher/scoped edits write to the unlinked database; MCP catch-up misses live state | PR1917,69f0b67/1488bdc (Christopher Beaulieu) | Reopen is serialized with extension coordination/index mutex; widen the next sync after replacement and retain catch-up on failure. Six focused cases pass; final candidate/native pending. |
| #1887 | Accepted compiled baseline:150k-node interrupted secondary-index fixture,100ms real watchdog, killed at1s progress cap | PR1888,5115fe3 (Christopher Beaulieu) | Async open/reopen offloads secondary-index repair. Same100ms fixture passes. Not a default60s capacity claim or all-migration latency guarantee. |
| #1895 | Accepted59009c5 and Klaus's independent source/SQLite receipt: schema-less ancestor captures root discovery | PR1913,870bd2a/74ba791/738b35a (danusha2345) | Empty/schema-less/foreign distinction, fail-open read-only inspection errors. Twelve source/current compiled CLI cases pass; packed CLI pending. |
| #1910 binary | Accepted59009c5 and actual npm1.6.0: small MPEG transport stream named.ts becomes a source record | PR1914,1844aa5/10def05 (danusha2345) | Discovery, git/scoped sync and TypeScript-to-video conversion; legitimate source retained. Eight cases and same baseline probe pass. |
| #1910 size | Accepted59009c5 and actual npm1.6.0: over-limit1MiB+1 bytes fully read three times; pre-safeguard candidate also indexes growth after stat | PR1915,228e03a/0593f9e (danusha2345), plus bounded descriptor reads | Source/extraction/resolution reads capped at1MiB+1 with file-size checks. Same no-full-read and growth probes pass; no multi-GB reproduction. |
| #1864 | Accepted59009c5 and actual npm1.6.0: unchanged calls repeat dominant aggregation | PR1916,0483f89 (danusha2345), plus rollback-safe cache | Memoization per connection, conservative no-cache on runtimes without transaction status. Contributor integration initially cached rolled-back state; same SQLite rollback probe now passes. First-call and one-shot CLI costs remain. |

Original baseline watcher/root suite has14 failures/4 controls plus an unhandled closed-database rejection; it is not a clean certification run. Corrected post-integration watcher case pauses the actual orchestrator rather than asserting a mutex before the asynchronous extension guard enters it. The original20ms watchdog experiment is invalid evidence for #1887: heartbeat cadence is at least50ms. It and failed attempts remain retained; the100ms before/after pair establishes the bounded recovery case.

## Security review #1367

| Finding | Current disposition | Boundary / remaining work |
| --- | --- | --- |
| Arbitrary indexed `projectPath` | Documented cross-project behavior; dedicated real two-project handler test pending final result | This local process is not an MCP-roots sandbox. Restrict the OS/service account when repository isolation is required. A roots allowlist is a policy change, not silently imposed here. |
| External symlinks | Existing real source test confirms metadata can be indexed; full-source `getCode` blocks escape | Symbol/metadata disclosure remains possible. Do not describe untrusted indexing as isolated from readable external files. A default-policy change needs a separate compatibility decision for existing SDK layouts. |
| Missing installer checksums | Reproduced accepted shell installer accepting mismatched archive and npm fallback accepting absent manifest using harmless fixtures; fixed candidate probes pass | Shell/PowerShell/bundle-upgrade/fallback require one exact SHA256 entry before replacement. Manifest origin remains trusted; no artifact-attestation verification or independent publisher authentication is added. Native PowerShell checks pending. |
| Windows version interpolation | Accepted source allows invalid suffix to reach inert cmd dispatch and script builder; candidate rejects in full | No exploit payload executed. Legitimate versions retained, bundle destination literals escaped. Native PowerShell execution pending. |
| Picomatch4.0.3 | Actual npm1.6.0 emits inherited `function Object` and overlapping repeated alternatives; current4.0.7 passes same bounded regex tests | Already fixed by current lockfile; minimum dependency range raised to4.0.7. Only16-character strings matched, no DoS/load experiment. Cargo workspace patterns still reach this dependency. |

Both [extglob](https://github.com/micromatch/picomatch/security/advisories/GHSA-c2c7-rcm5-vvqj) and [POSIX class](https://github.com/micromatch/picomatch/security/advisories/GHSA-3v7f-55p6-f55p) advisories identify4.0.4 as the patched4.x floor (checked2026-09-23). This is a targeted re-triage, not a complete security audit or closure of #1367.

## Release gates

| Surface | Required evidence / current limit |
| --- | --- |
| Runtime / SDK / author tools | Coherent final build, public types and actual packed SDK/author tests. Semantic/framework extensions only; no arbitrary-language grammar-provider claim. |
| Managed lifecycle | Final-source install/update/failure preservation/disable/remove; compiled workers, native paths and interruption recovery on Linux/Windows/macOS. |
| Official Drupal | Immutable0.1.0/.1 hashes and representative earlier28 links/four negatives/nine flows retained; affected final lifecycle checks required. Earlier corpus evidence is representative, not complete runtime semantics. |
| Archive + npm | Pack exact candidate with Node runtime, inspect schema/grammars/retained viewer assets, execute real archive and npm shim, prove both viewer aliases reject and companion remains available. |
| Deferred viewer | No ui/web registration; early rejection covers help/invocation before listener/browser/relaunch. UI source/assets stay packaged; component package not published. |
| Marketplace preview | Existing read-only hosted preview remains unchanged. Public source-admission backend staged/empty, general publication disabled. General marketplace launch is a separate gate, not a claim in this CLI candidate. |
| Semantic latency | Full candidate/global passes and graph replacement remain. Warm Pathauto/Commerce improvements have limited samples; core cold103.49→112.45s and higher RSS, historical22–30% overhead remain accepted limits. Shadow capture is NO-GO for production skipping. |
| Hosted operations / cost | Existing Paid preview$5 target conditional shared allowances; memory/concurrency/independent retention remain open. No new provider/load/restore tests or operational changes for this candidate. |
| Release approval | Current candidate full regression/native/artifact evidence must finish; maintainer review and publication approval remain separate. Historical4577 Linux and native162/165 do not certify this candidate. |

## Proposed notes

The shortened Unreleased section in [CHANGELOG](../../CHANGELOG.md) is the draft. Detailed prior development and contributor credits remain in [history](../development/pre-release-history-20260923.md); viewer availability claims there are explicitly historical/deferred.
