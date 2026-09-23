# Marketplace budget and source policy

The September 23 target is **$5/month for CodeGraph**, with 500–1,000 package downloads/day and few uploads. Keep the existing Workers Paid + D1 + private R2 design for this preview. No new subscription, migration, paid logging, alert, scheduler or notification has been enabled. The $5 is a planning target, not a hard cap or a promise about the shared account invoice.

## Cost fit

Thirty-day model: 15,000 or 30,000 installs/downloads; one separate source inspection per download; six catalog/detail/compatibility API calls and four HTML/JS/CSS calls conservatively charged as Worker invocations per download; 30 uploads at the full 8 MiB maximum. No cache credit. Source-file paging and downloading an already inspected Blob are client-only. Reopening inspection can fetch again. A companion's frequent local status polling is local; repeated catalog refreshes must be counted if usage differs. This is deliberately a read-heavy allowance, not a measured traffic distribution.

| Monthly measure | 500 downloads/day | 1,000 downloads/day |
|---|---:|---:|
| Package + source fetches | 30,000 | 60,000 |
| Worker requests, including assets | 180,030 | 360,030 |
| Projected CPU-ms | 1,721,370 | 3,431,370 |
| Included request budget used | 1.80% | 3.60% |
| Included CPU budget used | 5.74% | 11.44% |
| R2 Class B reads, including upload verification allowance | 30,030 | 60,030 |
| New R2 Class A writes | 30 | 30 |
| Max package transfer, decimal GB | 251.66 | 503.32 |

CPU inputs: 26 ms per package fetch (largest of three previous deployed 8 MiB samples); 9 ms per metadata read (largest captured); 379 ms per upload (one previous sample). Assets use an explicit 2 ms upper-planning allowance, not a new measurement. The deployed config runs the Worker first only for `/api/*`; successful direct assets are free, so counting all four overstates this part. `node scripts/validation/marketplace-budget.cjs` saves the arithmetic, assumptions and D1 bounds. Actual workload, catalogs and concurrency can differ. No large upload was repeated on the provider for this estimate.

[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) currently includes 10 million requests and 30 million CPU-ms in the existing $5 base; excess usage is $0.30/million requests and $0.02/million CPU-ms. With sufficient shared allowances remaining, this marketplace's projected request/CPU usage adds **$0 overage** and fits the $5 base. If those allowances were already exhausted by other applications, this modeled Worker workload alone adds approximately $0.0884 / $0.1766, before storage and other services. These are projections, not invoice quotes.

[R2 Standard](https://developers.cloudflare.com/r2/pricing/) includes 10 GB-month, 1 million Class A and 10 million Class B operations; egress is free. Main + restore currently contain 17,484,420 package bytes. Thirty additional maximum-size packages add 251,658,240 bytes: total 269,142,660 bytes before new backups. Beyond included usage, rates are $0.015/GB-month, $4.50/million A and $0.36/million B; billing units round up. Crossing an exhausted operation allowance can therefore add a whole billing unit even with few uploads. Do not quote fractional R2 cents as an exact invoice. This month's growth is not an indefinite storage cap.

[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) includes 25 billion read rows, 50 million write rows and 5 GB across the account on Paid. The model bounds metadata reads against both the current 17 releases and the existing 1,000-release cap. The preview databases were 94,208 bytes each at the accepted readback. **Unrelated telemetry already occupied roughly 10 GB at that readback**, so an account-total $5 promise would be unsound even if marketplace queries fit. We did not inspect or change that database or fetch an invoice. Account usage, rounding, taxes, other applications, backups and logging remain separate. Additional retention is not silently free.

The already-enabled Workers observability setting is unchanged. [Workers Logs pricing](https://developers.cloudflare.com/workers/platform/pricing/#workers-logs) includes 20 million events/month on Paid, then $0.60/million. A one-event-per-modeled-request allowance is 180,030–360,030 events (under 2% of that allowance); actual extra console/error events and unrelated services can raise it. No Logpush, retention upgrade or new logging service was enabled.

## Controls prepared, not account changes

- Keep `PUBLISHING_ENABLED=false`. Any separately authorized acceptance uses the existing absolute `PUBLISHING_UNTIL` deadline and an explicit close. Future publication also requires the reviewed source policy below. An allowlist is not a billing cap.
- Retain the existing `limits.cpu_ms=1000`, 8 MiB package / 12 MiB signed envelope, 256-file bound and 10 submissions/IP/minute. The CPU cap covered the measured 379 ms upload but is per invocation; request volume can still accumulate charges. IP limits do not prevent distributed abuse. No new rate-limit product is proposed.
- Proposed owner-only alert: **Manage Account → Billing → Billable Usage → Create budget alert**, name `CodeGraph shared-account overage warning`, threshold **$1 usage-based spend**, recipient **Colby's approved account email only**, description `Warn about variable charges beyond recurring subscriptions; includes unrelated account workloads`. This is an initial warning at the first additional dollar, not a $5 invoice cap. The recurring Workers fee is separate. [Budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/) are informational, account-wide and reset each billing cycle. No notification was created or sent; Klaus/Colby must approve account settings and recipient before applying.
- Before general publication, inspect existing account Billable Usage and any alerts; avoid duplicate alerts. Review marketplace request/CPU and D1/R2 usage manually at 50% and 80% of shared included allowances (5M/8M Worker requests, 15M/24M CPU-ms, 5/8 GB-month R2, 0.5M/0.8M A, 5M/8M B). These are review thresholds, not newly installed automated notifications. If $5 must be inviolable, this pay-as-you-go architecture cannot certify it.
- The preview runs the Worker first for `/api/*`; directly served assets can be free. The model conservatively counts all four assets anyway. Existing observability settings remain unchanged; no paid caching/logging product is added. Usage alert latency and unknown shared usage preclude a hard cap.

## Exact source inspection

Every detail page has **View selected version source**, available before connection or installation. It downloads the selected immutable `.cgext`, checks SHA-256 and id/version, rejects unsafe paths, oversized/invalid content and excessive files, then displays the manifest and every bundled file using `textContent`. HTML/JavaScript are never evaluated for display. Large files are paged; full files download as `.txt`, and the verified original package can be downloaded without another network fetch.

Inspection pins id/version/digest in that page session. Connecting a destination, changing compatibility or refreshing a catalog must not silently switch a reviewed install/update. A pending/failed/stale review blocks that action until the new selection is inspected. The existing trusted installer revalidates package integrity and selected version again. Navigation reload starts a new review session; this is not a persistent approval or security certificate. Files inside the package are visible, including bundled dependencies; unrestricted v1 runtime code could still read files, use the network or dynamically load other code. Source availability does not certify safe behavior.

Older immutable entries retain their original data. Their packaged bytes can be verified, while repository correspondence is explicitly **unverified under the current source policy**. Historical official provenance is shown as historical. No old package/listing is rewritten and no live fixture is deleted.

## Future hosted publication contract

The Cloudflare production Worker compiles `marketplace/source-reviews.json`, initially empty. A new signed submission must include canonical `source=https://github.com/owner/repo`, a full `sourceRevision` commit SHA and safe `sourcePath` to a **committed `.cgext` with identical bytes**. Approval also binds the exact publisher SPKI identity, extension id, semantic version and package SHA. Client-supplied `sourceReview`, official status or provenance is rejected. The server adds its trusted proof only after successful matching. R2/ownership/version/signature rules are unchanged. New official policy entries require the same proof; only the two exact historical Drupal hashes are grandfathered without relabeling them.

A public URL alone, branch/tag, private/unavailable repository, another version, unrelated artifact, changed digest or different publisher is insufficient. The narrow first contract deliberately requires the packaged runtime code itself to be committed, so bundled/transpiled dependencies can be compared byte for byte. It does **not** prove a build from a separate original TypeScript repository, establish code authorship, license compliance, benign intent or continuing repository availability. Public checks are made at the recorded review time; a repository can later disappear. The immutable registry package remains inspectable. Refresh the public check just before authorizing publication, and keep the reviewed code/release decision separate from the byte-match result.

Prepare a review (read-only; no login or build):

```sh
node marketplace/cloudflare/review-source.mjs \
  ./extension.cgext https://github.com/owner/repo FULL_40_CHARACTER_COMMIT \
  packages/extension.cgext PUBLISHER_SPKI_SHA256 ./source-review.json
```

The tool uses unauthenticated requests only to fixed GitHub API/raw hosts, rejects redirects, bounds each response and applies timeouts. It checks public repository identity, exact commit and full artifact equality. It does not run package scripts, install dependencies, execute code or fetch arbitrary publisher URLs. GitHub outage/rate limits fail review rather than falling back to a URL claim. Review the generated record and add it to the checked-in policy in a normal code review. The operator must check provenance and code independently, then build/review a deployment before opening publication. The command itself cannot grant publication or official status. An operator can change trusted policy code, so this is an explicit trusted admission process, not self-attestation.

This gate targets the hosted Cloudflare registry. The portable Node backend remains a local authoring/legacy acceptance service and does not enforce this new policy; **do not expose its publisher endpoint as a substitute production registry**. Its migration is a separate prerequisite if chosen for hosting. Existing fixture tests explicitly simulate operator source approvals inside the isolated test Worker; production ignores those bindings. Source-policy tests separately exercise explicit positive/negative records. No public admin/fetch endpoint was introduced.

## $0 fallback and remaining decisions

If the $5 target becomes a strict zero-cost requirement, a separately approved alternative is a reviewed static catalog and `.cgext` files on [Cloudflare static assets](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) or [GitHub release assets](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases). Direct static requests have no Worker CPU; source-backed review occurs before catalog generation. That trades immediate self-service publication for a review/build workflow and must verify static per-file limits and aggregate deployment limits. It is a documented fallback, not a parallel migration or authorization to create a release.

Keep this existing Paid preview for the modeled traffic if the shared-account usage review supports it. General publication remains closed. Peak memory/concurrency, independent backup retention/RPO/RTO, pagination beyond 1,000 entries, fixture cleanup, custom domain and release/distribution policy remain open. No selective semantic skipping is enabled and the earlier no-go remains.
