# Cloudflare marketplace preview

Cloudflare is the preferred hosted target. The existing Node/SQLite service remains a portable reference implementation; it is not the Worker runtime. A dedicated Workers/D1/private-R2 preview is deployed at https://codegraph-marketplace-preview.colby-7d9.workers.dev on the account’s existing Workers Paid plan. R2 Standard activation was separately approved; no plan upgrade was made. See the [dated hosted acceptance report](../validation/extensions-cloudflare-hosted-20260922.md) for exact deployed versions, resource inventory, proof and remaining limits. `marketplace.getcodegraph.com` is proposed, not configured. Do not provision a Vercel marketplace for this delivery.

## Architecture and publication contract

`marketplace/cloudflare/worker.ts` uses Workers Web Crypto and the same portable package validator as the managed installer. The public frontend is served as Workers Static Assets; `/api/*` invokes the Worker. `_headers` preserves the browser security policy on assets, and the API applies it independently. No CORS wildcard, local-companion policy changes, native SQLite imports, Node filesystem calls, package execution or install scripts exist in the Worker bundle.

D1 holds registry identity/schema, publisher ownership, immutable releases and replay nonces. R2 holds private content-addressed objects at `packages/sha256/<SHA-256>`. Public buckets, direct object writes and object lifecycle deletion must remain disabled. The only public download is an existing D1 release; it verifies the actual R2 bytes before returning them. The managed installer independently revalidates identity, compatibility and integrity.

Publication validates P-256 signatures (SPKI publisher IDs match Node), timestamp, fields, paths and the full package. It then conditionally writes the immutable R2 object with a checksum and `If-None-Match: *`. Only after that succeeds does one transactional D1 batch claim/check ownership and insert release plus replay nonce. Database uniqueness and ownership triggers resolve concurrent publishers. A failure before D1 commit exposes no release; a response lost after commit leaves a valid immutable release, discoverable by refreshing the catalog. Retrying a committed nonce/version fails clearly. Uncommitted R2 objects can remain after failure; they are never listed or downloadable. There is deliberately no online orphan collector that could race a publication. Cleanup needs a separate maintenance procedure with writers stopped and a verified catalog snapshot.

This is staged publication, not a distributed transaction or a guarantee against an administrator deleting an object. Missing/corrupt storage fails downloads with an actionable 503. Reads use primary D1 bindings without replicas/cache. The preview caps the catalog at 1,000 releases to bound the existing array-based catalog protocol. Publication is disabled by default. An indexed D1 rate bucket permits 10 submissions per IP per minute; it mitigates abuse but is not a spending cap. Expired nonces are removed only after the signed-request validity window.

## Local runtime and validation

From the repository root, with Node 22.23.2:

```sh
npm ci --no-audit --no-fund
npx tsc
npm ci --prefix marketplace/cloudflare --no-audit --no-fund
npm run build --prefix marketplace/cloudflare
npm test --prefix marketplace/cloudflare
(cd marketplace/cloudflare && node ops-test.mjs)
CLOUDFLARE_REGISTRY=1 PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
  node scripts/validation/extensions-compatibility.cjs
CLOUDFLARE_REGISTRY=1 PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
  node scripts/validation/marketplace-browser.cjs
```

The exact Wrangler/Miniflare/workerd versions are pinned in the separate lockfile. Current Wrangler uses Miniflare 5 alpha; the local adapter uses its documented v4-options converter and explicit `resourcePersistencePath`. Default test state is disposable. Production configuration points to `worker.ts`; only `test-worker.ts` accepts failure/kill controls. Tests exercise real local D1/R2 bindings, Web Crypto, HTTP and test-owned subprocess kills, not JavaScript storage mocks. Static assets in integration tests are delivered through a local binding; Wrangler dry run validates bundling and asset/binding configuration; actual platform routing is covered separately by the hosted acceptance.

For a retained local rehearsal (no Cloudflare account needed):

```sh
cd marketplace/cloudflare
node ops.mjs serve /absolute/lab/registry
node ops.mjs backup /absolute/lab/registry /absolute/backups/unique-snapshot
node ops.mjs restore /absolute/new-lab/registry /absolute/backups/unique-snapshot
```

Stop the rehearsal server before using the operator CLI on that same local state. Backup refuses missing or uninitialized source state and never silently migrates an empty source into a successful snapshot. The binding-level backup reads identity/owners/releases/nonces in one D1 batch snapshot, then copies immutable R2 bytes. A completion manifest is written last. Restore verifies checksums, manifest/package/ownership correspondence, refuses an occupied target, copies objects first and publishes metadata in one D1 batch. Partial restores remain detached and must be retried into a new destination. Backups contain public packages and metadata, not publisher private keys. Protect the independent checksum against tampering; checksums alone are not authentication. Local process-kill proof does not establish provider disk/power-loss or off-host retention guarantees.

## Prepare deployment after access is verified

Required capabilities: authenticated Cloudflare account inventory, permission to deploy a preview Worker, an existing authorized D1 database and private R2 Standard bucket (or explicit approval to activate/create them), and authority for the selected hostname if attaching it. A browser login does not by itself authenticate Wrangler. Use the official `wrangler whoami` read; do not copy tokens into chat or inspect credential files. Do not use temporary accounts to bypass pending access.

1. Inspect account/plan, D1/R2 inventory, existing Workers and `getcodegraph.com` zone ownership. Confirm included allowances and whether R2 activation requires billing. No paid upgrade, card entry, R2 activation, DNS or domain change is authorized by this guide.
2. Copy `wrangler.jsonc` to a private deployment config beside it. Replace the placeholder D1 ID and bucket name with the verified preview resources and set the verified account ID. Keep `PUBLISHING_ENABLED=false` until storage, budget and runtime checks complete. Keep the initial `workers.dev` preview; attach a custom domain only with authorization. Do not run a deploy against the checked-in placeholder config.
3. Apply `migrations/0001_registry.sql` to the dedicated empty preview D1 using `wrangler d1 migrations apply DB --remote --config wrangler.deploy.json`. Existing registry data must never be reset. Both migrations have now been applied to the isolated preview. The combined Wrangler migration endpoint returned `SQLITE_ERROR: incomplete input`; the supported OAuth operator below applied the same unmodified statements transactionally with a migration ledger. Do not reset data after a migration error: inspect the actual schema first.
4. Check `wrangler deploy --dry-run --config wrangler.deploy.json`, then deploy that exact config without `--dry-run` only once resource access/authorization are verified. Explicit real resource IDs/names are required for every storage binding; do not accept automatic provisioning prompts. The build bundles semver and shared validation; D1/R2 storage outlives Worker code replacement.
5. Verify `/api/health`, exact deployed source, asset CSP and private bucket access. Enable publication only after measuring actual deployed CPU/memory and confirming usage controls. Publish disposable preview versions, replace the Worker code while keeping bindings, and verify unchanged identity, ownership and byte-identical downloads. Repeat browser signed publication, compatible one-Install into a separate Python project, actual graph refresh, update/disable/remove and origin/window/outage checks over the stable HTTPS origin.

The community publish API assigns `official=false` and rejects explicit official/publisher-identity spoof fields. The [trusted Drupal operator](official-drupal-import.md) now supplies a reviewed pinned-artifact plan/apply command, with exact registry identity, immutable publication and safe repeat operations. Apply migration `0002_official_operator.sql` after `0001_registry.sql` before using that command. There is no unauthenticated official/admin endpoint. The supported OAuth binding operator was exercised against the dedicated provider resources; the local Node service's optional official seed is unchanged.

## Supported OAuth operator and provider snapshots

`hosted-ops.mjs` uses supported Wrangler `getPlatformProxy({remoteBindings:true})`. D1/R2 operations run against the explicitly configured provider resources, while the operator process runs locally. It never reads or copies OAuth credentials, and adds no public admin endpoint. It verifies an exact config digest, account/resource identities, publishing-disabled state and live deployed bindings before normal operations. Use `remote:true` on both bindings, no routes, and dedicated preview names. The private config must be JSON, beside `wrangler.jsonc` so relative paths remain correct.

From repository root, after normal supported Wrangler authentication and authorized resource inspection:

```sh
export CLOUDFLARE_ACCOUNT_ID=VERIFIED_ACCOUNT_ID
export WRANGLER_LOG_PATH="$PWD/.qa/hosted/wrangler"
export WRANGLER_REGISTRY_PATH="$PWD/.qa/hosted/dev-registry"
export MINIFLARE_REGISTRY_PATH="$WRANGLER_REGISTRY_PATH"
sha256sum marketplace/cloudflare/wrangler.deploy.json
node marketplace/cloudflare/hosted-ops.mjs inspect marketplace/cloudflare/wrangler.deploy.json REVIEWED_CONFIG_SHA
node marketplace/cloudflare/hosted-ops.mjs migrate marketplace/cloudflare/wrangler.deploy.json REVIEWED_CONFIG_SHA
node marketplace/cloudflare/hosted-ops.mjs apply marketplace/cloudflare/wrangler.deploy.json REVIEWED_CONFIG_SHA /absolute/plan.json REVIEWED_PLAN_SHA
node marketplace/cloudflare/hosted-ops.mjs backup marketplace/cloudflare/wrangler.deploy.json REVIEWED_CONFIG_SHA /absolute/new-snapshot
```

Keep publication disabled and deployment/migration/import writers stopped for backup. One D1 batch captures identity, ownership, releases and recent nonces; every referenced immutable R2 object is copied and verified. `complete.json` is written last and pins `snapshot.json`; each release pins its package hash/size/identity. Rate counters are ephemeral and intentionally omitted. Unreferenced failed-upload objects are not part of a registry snapshot. An occupied snapshot path is refused. D1 Time Travel alone is not an R2 backup.

Create a **new authorized detached** D1/R2 pair and config named `codegraph-marketplace-preview-restore-...`; verify no Worker deployment exists under that name. Then:

```sh
node marketplace/cloudflare/hosted-ops.mjs migrate marketplace/cloudflare/wrangler.restore.json REVIEWED_RESTORE_CONFIG_SHA --detached
node marketplace/cloudflare/hosted-ops.mjs restore marketplace/cloudflare/wrangler.restore.json REVIEWED_RESTORE_CONFIG_SHA /absolute/completed-snapshot --detached
```

Restore validates all bytes and metadata before upload, refuses occupied D1/R2, writes objects first and then commits metadata in one D1 batch. A failed partial restore stays detached; retry into a new destination, never reset live storage. Only after success deploy a separate read-only Worker bound to the restored pair and verify all releases plus identity/ownership against the snapshot. No original hostname cutover is implied. Preserve source/version/config and snapshot checksums separately from the backup bytes.

For a controlled publication test, add `PUBLISHING_ENABLED="true"` and `PUBLISHING_UNTIL="ABSOLUTE_UTC_ISO_DEADLINE"` to a reviewed temporary config. Health and POST both fail closed at expiry or for an invalid deadline. Hosted tests must always set the deadline; omission retains the existing local fixture behavior. Redeploy the original `false` config immediately after acceptance, verify health and a rejected POST, then take the backup. The deadline is a publication control, not a spending cap or a global writer lock.

Retain the provider restore pair and completed snapshot for review; no automatic deletion, scheduled backup or cutover is installed. Proposed operator retention: seven daily and four weekly complete snapshots, with a checksum verified at an independent approved destination. This proposal has not been scheduled, and the workspace snapshot is not evidence of off-site disaster recovery. Define RPO/RTO and approve cleanup separately.

## Costs and limits: planning assumptions, not a bill estimate

Sources checked September 22, 2026: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/). Account-wide usage by other applications must be included.

Workers Free allows 100,000 dynamic requests/day and 10 ms CPU per invocation; static asset requests bypassing the Worker are free. Memory is 128 MB per isolate. Workers Paid starts at $5/month and includes 10 million requests and 30 million CPU-ms/month, with request/CPU overages. It is not an all-in marketplace price. The actual account already had Workers Paid active. This milestone did not select or upgrade that plan.

D1 Free includes 5 million rows read/day, 100,000 rows written/day and 5 GB total storage (500 MB per database). R2 Standard includes 10 GB-month, 1 million Class A and 10 million Class B operations/month. Beyond included R2 usage, Standard storage is $0.015/GB-month, Class A $4.50/million and Class B $0.36/million; egress is free. Backups, orphan objects, repeated checks and abuse consume storage/operations too. Free allowances do not authorize billable activation or guarantee a zero bill.

Illustrative small preview, **not measured demand**: 100 extensions × 3 releases × 500 KiB ≈ 146 MiB of packages; seven full independent copies add ≈ 1 GiB. At 4,000 catalog queries/day scanning 300 rows plus 1,000 downloads/day, catalog reads are approximately 1.2 million rows/day; downloads add small indexed lookups. About 30,000 monthly object downloads and 300 daily backup reads remain below R2 read allowances. Twenty publications/day write tens to hundreds of metadata rows, plus rate/replay maintenance. This scenario fits request/row/storage allowances in isolation; it does **not** establish CPU eligibility.

The 8 MiB package contract has a 12 MiB signed JSON/base64 envelope. Package/signature verification and hashing may exceed the Free 10 ms CPU budget, and concurrent large requests may pressure 128 MB memory. Local wall time includes I/O and is **not Cloudflare CPU billing evidence**. Measure representative and maximum-size deployed requests before choosing a plan; if Free cannot support the contract, return the measured limit and a priced option for approval rather than silently lowering the size limit or enabling a paid plan. D1 stores only bounded metadata, avoiding its 2 MB row limit. The 1,000-release preview cap requires a catalog-pagination redesign before larger scale.

Local runtime tests alone do not establish hosted behavior. The dated hosted report records actual HTTPS and provider persistence separately. Custom domain, hard cost ceiling, provider power-loss, multi-region behavior and production readiness remain outside that proof. Broader Drupal coverage/performance review remains separate; historical measured rebuild overhead is 22–30% with limited samples.

## Current preview and measured limits

The main preview and separate restored preview both have publication disabled. They retain official Drupal 0.1.1 plus clearly labeled acceptance fixtures (including deliberately incompatible/broken versions); do not recommend those fixtures for real projects. No cleanup, DNS cutover or custom-domain attachment was performed.

Use this branch’s built CLI to connect an explicitly selected local project, keeping the process running:

```sh
node dist/bin/codegraph.js extensions connect /absolute/project --marketplace https://codegraph-marketplace-preview.colby-7d9.workers.dev
```

Open the printed connection link, allow the local companion once, select the destination and review the publisher before Install. The browser never receives a filesystem API. Stopping the companion disconnects it. The published npm release is not claimed to include this draft branch.

Actual Paid-plan CPU measured on one accepted 8 MiB signed publication was **379 ms**; three full downloads measured **22, 26 and 20 ms**. These samples exceed the Free 10 ms budget: do not target Free for the full current contract. The configured preview cap is 1,000 CPU-ms/request; no plan upgrade was made. The 262-event final trace recorded no execution exceptions or `exceededMemory` outcomes, but exposes no heap high-water mark. Peak memory and concurrent large-request headroom remain unmeasured; 128 MB is a per-isolate platform limit, not measured consumption. These modest tests are not a load or cost guarantee.

Provider D1 readback reported 94,208 bytes for each dedicated database. Actual R2 binding lists found 17 objects / 8,742,210 bytes per bucket, with no orphans. CLI bucket analytics still reported zero objects/bytes at readback, so those delayed counters were not used as storage proof. Account-wide Workers/D1/R2 usage and billing remain independent of these fixture counts. Logs, backups and repeated verification also consume allowances.
