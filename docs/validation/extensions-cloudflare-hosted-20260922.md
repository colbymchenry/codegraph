# Cloudflare hosted preview acceptance — 2026-09-22

The dedicated [marketplace preview](https://codegraph-marketplace-preview.colby-7d9.workers.dev) now serves the actual frontend and API on Cloudflare Workers, backed by D1 and private R2. Official Drupal and community browser/CLI installation reached real local graphs over this stable HTTPS origin. Provider redeployment and a separate restore retained every release, owner and package. **Publishing is disabled on both endpoints.** This is a bounded preview acceptance, not a production release or a Free-plan certification.

The account already had Workers Paid. R2 Standard activation was separately approved and completed before this task. Supported Wrangler OAuth was reused without reading/copying credentials or touching the human browser. Only dedicated preview/restore resources were created. Existing telemetry/AI services, billing plan and DNS were not changed. `marketplace.getcodegraph.com` remains unconfigured.

## Revisions and implementation

Same draft [PR #1911](https://github.com/colbymchenry/codegraph/pull/1911). Worker source: `384daf329ff00c4bfb7bf874ea414f4f3cd121b1`; final operator: `c9b63f561099c08f74ed4b79ce8cd7f2b783f72c`; browser driver correction: `2b9ec85df61acabd21a29a47daf1b4b78bcd0a78`; read-only inventory source: `ad09aa5` (its previously exercised bytes are unchanged). Later changes are documentation, receipts and screenshots.

- `hosted-ops.mjs` uses supported Wrangler remote D1/R2 bindings with reviewed config/plan digests. It verifies the latest actual deployment's exact bindings and disabled-publication state. The provider's deployment list was observed oldest-first: sorting timestamps now prevents incorrectly admitting an old disabled deployment while a newer one permits publishing. Invalid/tied timestamps fail closed. A real active-window inspection was rejected before binding operations.
- Official import reuses the existing pinned policy/provenance, conditional R2 object creation and atomic D1 ownership/release contract. No admin HTTP endpoint or separate S3 credential was added. Repeating the reviewed Drupal plan returned `unchanged` with the original timestamp and bytes.
- Optional `PUBLISHING_UNTIL` makes a controlled publication window expire without another deployment; missing deadline preserves existing local fixture behavior. Health and POST share the same fail-closed deadline check. The actual hosted window used a UTC deadline, then was explicitly closed early.
- `hosted-inventory.mjs` is read-only. It verifies referenced object sizes and reports all keys/bytes/orphans, independently of delayed bucket analytics.

The installed engine remains `7575dcc71e4524c660aff06486ebc007cca290b9`. Of the accepted semantic-update ledger, 25 source hashes and 12 compiled hashes still match; the two expected differences are documentation (`CHANGELOG.md`) and the Cloudflare Worker build. Engine/native/plugin source and both immutable Drupal packages are unchanged. Prior Linux **4,577 passed / 192 skipped / 284 files once**, Windows **162 / 4 skipped**, macOS **165 / 1 skipped**, and their recovery evidence remain at their original revisions. They were not rerun or presented as current-head CI. Automatic unrelated workflows were skipped for these hosting commits; affected runtime and real provider checks below were run explicitly.

## Actual deployment and storage

| Purpose | Worker version | State |
|---|---|---|
| Initial official import/browser | `ebd52779-28fc-4acb-9cfe-91c1e7bd1778` | Publishing disabled |
| Bounded community/8 MiB acceptance | `3340394e-3bb7-4137-89ea-f38fd4de8d23` | Enabled 21:16–21:24 UTC; deadline 21:45:33 UTC |
| Explicit close | `e5a0285b-250f-4254-907a-d3f37d4ed7cf` | Disabled |
| Final replacement | `c0bdbbac-adcf-4609-aaf3-a69a380f3422` | Disabled, 100% deployment |
| Separate restored preview | `15440b95-30e9-440e-bd82-d9a42d416a35` | Disabled; no main-origin cutover |

Main resources are `codegraph-marketplace-preview` / `codegraph-marketplace-preview-packages`. Restore resources are `codegraph-marketplace-preview-restore-20260922` / `codegraph-marketplace-preview-restore-20260922-packages`. Both databases are in WNAM, with read replication disabled. Both R2 buckets use Standard storage and have public `r2.dev` access disabled. The separate [restored endpoint](https://codegraph-marketplace-preview-restore-20260922.colby-7d9.workers.dev) serves verified restored bytes through its Worker. No public bucket, custom domain, lifecycle deletion, automatic cleanup or cutover was installed.

The private `wrangler.deploy.json`, `wrangler.window.json`, `wrangler.restore.json` and `../cloudflare-hosted-resources-20260922.json` retain actual account/resource IDs and config digests. These contain no credentials. Configured CPU limit is **1,000 ms/request**, unchanged across accepted versions. Actual bindings, limits and version IDs were read back using supported CLI tools. The checked-in placeholder config was never deployed.

## Acceptance results

| Check | Result and scope |
|---|---|
| Local real Worker runtime | **21 passed**, including immutable ownership, failure boundaries, process kills, backups, 8 MiB bytes and rate limits; final source `384daf3` |
| Publication deadline | **4 passed**: future, expired, malformed, and live expiration without restart |
| Operator guards | **18 passed**; plus actual active-window refusal and successful disabled-target admission |
| Official Drupal HTTPS browser | **8 grouped checkpoints passed**, repeated after final redeployment |
| Generated community compatibility | **10 passed**, **14 CLI commands**, including generated starter test/pack |
| Community publisher/browser | **15 passed**, including real signing, ownership/signature/package failures, graph lifecycle, wrong origin/window and closed companion |
| Provider package/security | 11 saved HTTP responses from interrupted command independently verified; continuation passed concurrent ownership winner and final immutable byte checks |
| Provider redeploy/restore | All **17 releases**, **8 owners**, registry identity, recent nonces and **17 objects / 8,742,210 bytes** match across all three snapshots and HTTPS readbacks |

The official test exported pinned Pathauto `b97aadf47a37cff25f7d6105c3dade6778fccb47` into a separate owned directory. One connection and one Install selected official CodeGraph Drupal 0.1.1. Four exact SQLite links were asserted: settings route to form handler, bulk route to form handler, punctuation hook, and generator-to-cleaner injection. Disable/remove cleared contributions; enable restored them. Malformed/incompatible installs and test-injected downloaded-byte corruption preserved the working graph. The transport corruption was injected in the owned test client after downloading the real artifact; provider objects were not tampered with.

Compatibility published semantic versions out of publication order. The actual engine chose stable 1.10.0 over incompatible 9.0.0 and a preview; browser and CLI agreed. Explicit pins, preview opt-in, no-compatible selection, downgrade refusal, broken update rollback, successful update, exact URL/file semantics and cleanup passed. The generated extension produced its real Python event-to-handler edge. The separate publisher test used real browser signatures and actual postMessage boundaries. Its outage case intentionally aborted the owned browser request; the provider remained running. Earlier local stopped-service proof is retained separately.

The test catalog intentionally retains failed-attempt fixtures, incompatible versions and broken update fixtures; they are acceptance data, not recommendations. No resource or release was deleted to clean up the evidence.

[Desktop official proof](images/cloudflare-hosted-20260922/drupal-desktop.png) · [Mobile official proof](images/cloudflare-hosted-20260922/drupal-mobile.png) · [Compatible installation](images/cloudflare-hosted-20260922/compatible-desktop.png) · [Community cleanup](images/cloudflare-hosted-20260922/community-mobile.png). Captures were inspected. Desktop official capture shows installed 0.1.1 while compatibility refresh is pending; mobile capture shows selected and installed 0.1.1 explicitly.

## Provider persistence and backup

Publishing and operator writers were stopped before the snapshot. `backupRegistry` read all four metadata tables in one D1 batch, fetched each immutable referenced R2 object, validated package/identity/ownership/provenance and wrote `complete.json` last. Each snapshot was rechecked independently against its manifest and every object hash/size.

| Snapshot | `snapshot.json` SHA-256 |
|---|---|
| Before replacement | `d38e6451c183b2be450563efe727b9fdde9ca7661036facb9abc349883f9a207` |
| After replacement | `1f2b3c74f4fee2ebed93219a422950be9740ceb9fc5d6bddbdbbd97713b4ab2f` |
| Re-export from restored pair | `85cb4da7982f4095433c55cc83957454dfe781b3d653b38bd6410831ea6c1635` |

Snapshot hashes differ because creation times differ; **all table bodies and object bytes are identical**. Restore used a newly created/migrated pair, verified the restore Worker was absent, refused live/occupied targets, uploaded bytes first and committed metadata in one D1 batch. Only after success was its read-only Worker deployed. Every version was then downloaded through both HTTPS endpoints and compared with the original reference. Binding inventories found no orphan objects in either bucket.

Copies remain under `.qa/hosted/backups/` and in the private recovery archive. The restored provider pair is independent of the live bindings but is in the same account. This is not off-account disaster recovery. Independent off-site retention, automated backup scheduling, RPO/RTO and an approved teardown policy remain open. Seven daily/four weekly snapshots are a documented proposal only.

## Deployed CPU, memory observations and cost limits

Actual provider trace fields were captured, then filtered to remove request headers/IP/TLS metadata. The final captured window has **262 invocations**, **1,168 total CPU-ms**, zero execution exceptions and all `outcome=ok`. HTTP outcomes include expected 400/403/503 validation/disabled responses; “ok” does not mean every request was accepted. This sample is not complete account usage or a load test.

| Operation | CPU measurement |
|---|---|
| Accepted 8,388,608-byte signed publication | **379 ms**, one sample; 1,435 ms provider wall time |
| Three immediate full package downloads | **22 / 26 / 20 ms**, all hashes/lengths equal |
| Oversized-by-one-byte rejection | **197 ms**, one sample |
| Small accepted publications captured | **5–10 ms**, eight samples, median 8 ms |
| Catalog/detail reads captured | **0–9 ms**, 182 samples, median 1 ms |

These Paid-plan measurements exceed the [Free 10 ms CPU limit](https://developers.cloudflare.com/workers/platform/limits/) for the full package contract. **Do not select Free for this implementation based on this proof.** No Free deployment or plan change was attempted. The 1,000 ms configured cap comfortably covered these samples, not arbitrary sustained traffic.

The actual trace exposes CPU/wall/outcome, **not a heap high-water measurement**. No sampled `exceededMemory` event occurred. The platform's 128 MB per-isolate limit is not measured consumption; concurrent large uploads/downloads and memory headroom remain unverified. A precise deployed peak-memory result could not be obtained through the available supported trace interface.

Dedicated D1 readback: 94,208 bytes each; main 24h counters reported 1,750 rows read / 217 written, restored 222 / 146 at observation time. R2 CLI analytics lagged and reported zero objects/bytes, despite strongly consistent binding lists and successful byte reads showing 17 objects / 8,742,210 bytes each. Delayed counters were retained, not substituted for evidence.

The existing [Workers Paid plan](https://developers.cloudflare.com/workers/platform/pricing/) has a $5 monthly minimum plus applicable overages; no incremental zero-cost promise is made. [D1](https://developers.cloudflare.com/d1/platform/pricing/) and [R2](https://developers.cloudflare.com/r2/pricing/) allowances and charges are account-wide. Existing telemetry storage/other apps, backup copies, logs, verification requests and abuse count. Rate limits and a per-request CPU cap are not a hard spending cap. The measured sample and small inventory do not forecast monthly demand. No additional billing activation or subscription change occurred in this task.

## Retained failures and interruptions

- Combined Wrangler migration apply returned `SQLITE_ERROR: incomplete input`. Actual schema inspection showed only the migration ledger; the same unchanged migration statements subsequently passed via supported remote D1 transactional batches. No reset or weakened SQL was used.
- Remote-binding setup initially attempted a registry directory outside this sandbox. Required permitted retries are preserved. Both documented registry-path variables now point to the owned workspace; credentials were never inspected. A pre-migration read correctly failed for absent schema.
- First dry run used an incorrect output directory; the corrected absolute directory passed. One read accidentally used an incorrect version ID and returned not-found; the actual deployment ID was then read back. Neither changed provider state.
- Two hosted browser harness attempts failed (detail-page project selector, then duplicate catalog links). Both remain in receipts/screenshots; final selectors passed with a new immutable fixture ID. No application assertion was weakened.
- The original package command was terminated by the tool with exit **143**, cause unknown, after 11 completed response receipts. It has no final command receipt. The explicit continuation verified every saved status/error/hash, finished the missing concurrent claim check and re-read original bytes. No uninterrupted pass is claimed and the large upload was not repeated.
- The first tail was intentionally stopped; a second tail ended with tool **143**, cause unknown; the final tail was intentionally stopped with **130** after capture. An early operator inspection was stopped after its registry-path failure. Started receipts and raw logs remain. Expected not-found/active-publishing refusals are distinct from test failures.
- The evidence-builder first attempt had a local `Path` naming error after its assertions; fixed without changing provider state. Both historical core/previous Linux interruptions remain documented in their original reports.

The [JSON ledger](extensions-cloudflare-hosted-20260922.json) pins source/build hashes, exact command bodies/exits, raw files, config digests, provider versions, results and snapshots. Raw tail data is not published; raw tail evidence is private, and Wrangler auth/debug/dev-registry files are excluded from the recovery archive. No merge, release or npm publication occurred.

## Decision and remaining gates

**Pass for a dedicated read-only hosted preview on the existing Paid plan.** Stable Worker HTTPS, real local graph installation, immutable ownership, provider redeployment and detached backup/restore have actual evidence. General publication remains disabled.

Before production or broader traffic: establish memory/concurrency headroom and account usage alerting, independent backup retention/RPO/RTO, catalog pagination beyond the 1,000-release preview cap, authorized fixture cleanup and release/distribution policy. Custom domain is separate authorization. No selective semantic skipping is enabled: the accepted shadow no-go and its metadata/lifecycle/economics gaps remain. Global graph costs, mixed warm/cold results, higher core RSS and historical 22–30% Drupal rebuild overhead remain in the prior reports. Product completion remains partial.
