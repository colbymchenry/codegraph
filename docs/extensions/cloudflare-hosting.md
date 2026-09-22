# Cloudflare marketplace preview

Cloudflare is the preferred hosted target. The existing Node/SQLite service remains a portable reference implementation; it is not the Worker runtime. No Cloudflare account, resources, hostname, deployment or plan has been verified by this increment. `marketplace.getcodegraph.com` is proposed, not configured. Do not provision a Vercel marketplace for this delivery.

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

The exact Wrangler/Miniflare/workerd versions are pinned in the separate lockfile. Current Wrangler uses Miniflare 5 alpha; the local adapter uses its documented v4-options converter and explicit `resourcePersistencePath`. Default test state is disposable. Production configuration points to `worker.ts`; only `test-worker.ts` accepts failure/kill controls. Tests exercise real local D1/R2 bindings, Web Crypto, HTTP and test-owned subprocess kills, not JavaScript storage mocks. Static assets in integration tests are delivered through a local binding; the actual platform asset routing is separately checked by a Wrangler dry run and still needs hosted verification.

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
3. Apply `migrations/0001_registry.sql` to the dedicated empty preview D1 using `wrangler d1 migrations apply DB --remote --config wrangler.deploy.json`. Existing registry data must never be reset. No migration/provision/deploy has been run remotely by this increment.
4. Check `wrangler deploy --dry-run --config wrangler.deploy.json --experimental-provision=false --experimental-auto-create=false`, then deploy the reviewed preview using the same flags without `--dry-run` only once resource access/authorization are verified. Automatic resource creation is disabled. The build bundles semver and shared validation; D1/R2 storage outlives Worker code replacement.
5. Verify `/api/health`, exact deployed source, asset CSP and private bucket access. Enable publication only after measuring actual deployed CPU/memory and confirming usage controls. Publish disposable preview versions, replace the Worker code while keeping bindings, and verify unchanged identity, ownership and byte-identical downloads. Repeat browser signed publication, compatible one-Install into a separate Python project, actual graph refresh, update/disable/remove and origin/window/outage checks over the stable HTTPS origin.

The community publish API always assigns `official=false`. An official Drupal listing must use a separately reviewed operator import; this Worker increment does not expose an unauthenticated official-seed endpoint. The existing local Node service's optional official seed is unchanged.

## Remote backups and isolated restore

A D1 Time Travel restore alone does not restore R2. Keep immutable objects and no expiration rules, and create an independent archive containing **both** metadata and all referenced objects. The binding-level format/tool is a local rehearsal; remote operator steps require authenticated Wrangler and are not claimed tested against a Cloudflare account:

1. Export a consistent D1 SQL snapshot: `wrangler d1 export DB --remote --config wrangler.deploy.json --output /absolute/new-backup/registry.sql`.
2. Export the release object-key/hash/size inventory from that snapshot. With writes stopped, a D1 `SELECT object_key,integrity,size FROM releases` through `wrangler d1 execute DB --remote --json --command ...` also matches it. Do not combine unrelated snapshots. Fetch each private object using `wrangler r2 object get BUCKET/KEY --remote --file /absolute/new-backup/objects/HASH --config wrangler.deploy.json`. Verify SHA-256/size/package identity for every row, then write the archive manifest last. Copy the completed archive and a trusted checksum to an independent destination; define retention and recovery objectives.
3. Restore exclusively into a **new, detached, empty** D1/R2 pair with no serving Worker or writers. Verify the archive before writes; upload each verified object first with `wrangler r2 object put ... --remote --file ...`, then import the metadata SQL with `wrangler d1 execute DB --remote --file ...`. Never run restore SQL on the live database. Keep the pair detached if any import is incomplete.
4. Bind a separate read-only preview Worker to the restored pair and verify every listed artifact, identity and owner before cutover. Do not attach the original public domain until the operator approves a cutover. Provider backup, restore, retention and redeploy acceptance remain open until these commands actually run on verified resources.

## Costs and limits: planning assumptions, not a bill estimate

Sources checked September 22, 2026: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/). Account-wide usage by other applications must be included.

Workers Free allows 100,000 dynamic requests/day and 10 ms CPU per invocation; static asset requests bypassing the Worker are free. Memory is 128 MB per isolate. Workers Paid starts at $5/month and includes 10 million requests and 30 million CPU-ms/month, with request/CPU overages. It is not an all-in marketplace price. No paid plan has been selected or activated.

D1 Free includes 5 million rows read/day, 100,000 rows written/day and 5 GB total storage (500 MB per database). R2 Standard includes 10 GB-month, 1 million Class A and 10 million Class B operations/month. Beyond included R2 usage, Standard storage is $0.015/GB-month, Class A $4.50/million and Class B $0.36/million; egress is free. Backups, orphan objects, repeated checks and abuse consume storage/operations too. Free allowances do not authorize billable activation or guarantee a zero bill.

Illustrative small preview, **not measured demand**: 100 extensions × 3 releases × 500 KiB ≈ 146 MiB of packages; seven full independent copies add ≈ 1 GiB. At 4,000 catalog queries/day scanning 300 rows plus 1,000 downloads/day, catalog reads are approximately 1.2 million rows/day; downloads add small indexed lookups. About 30,000 monthly object downloads and 300 daily backup reads remain below R2 read allowances. Twenty publications/day write tens to hundreds of metadata rows, plus rate/replay maintenance. This scenario fits request/row/storage allowances in isolation; it does **not** establish CPU eligibility.

The 8 MiB package contract has a 12 MiB signed JSON/base64 envelope. Package/signature verification and hashing may exceed the Free 10 ms CPU budget, and concurrent large requests may pressure 128 MB memory. Local wall time includes I/O and is **not Cloudflare CPU billing evidence**. Measure representative and maximum-size deployed requests before choosing a plan; if Free cannot support the contract, return the measured limit and a priced option for approval rather than silently lowering the size limit or enabling a paid plan. D1 stores only bounded metadata, avoiding its 2 MB row limit. The 1,000-release preview cap requires a catalog-pagination redesign before larger scale.

No hosted HTTPS, provider persistence, custom domain, cost ceiling, power-loss, multi-region behavior or production readiness is claimed by local runtime tests. Broader Drupal coverage/performance review remains separate; historical measured rebuild overhead is 22–30% with limited samples.
