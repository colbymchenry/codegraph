# Trusted official Drupal import

The Cloudflare registry's public `/api/publish` endpoint cannot assign official status or a publisher identity. Community signatures identify their own publishers. The trusted operator command below is the only supplied path for the reviewed Drupal package; it does not add an administrative HTTP endpoint.

## Trust and immutable publication

`marketplace/cloudflare/official-policy.json` is a reviewed allowlist, committed alongside the operator. It pins Drupal `0.1.0`, package name, exact 289,167-byte artifact SHA-256, bundled entry hash, source repository/revision/path/hash and official metadata. The trusted identity is `publisherId: codegraph`, display name `CodeGraph`; it is distinct from the 64-hex SPKI identities assigned by community signatures. The policy is an operator trust decision anchored in reviewed source, **not a claim of a new signed upstream release**. Changing the policy requires review and a new immutable version when bytes change.

Artifact provenance: `dist/extensions/drupal.cgext` SHA-256 `e5015747d02fe50d6af607b6c44f1db9cf7969a0070866ed03c7643377a459c8`; source `extensions/drupal/index.cjs` at `37d4dd837120c1d56316c3cc65b6587b743a9112`. The existing `node scripts/build-extensions.mjs` build is reproducible with repository-locked dependencies. The command validates the complete artifact, supported extension API and the target engine version before any write, then enforces the pinned identity/integrity/entry provenance.

Each plan includes an explicit registry identity and destination. `apply` requires the SHA-256 of the exact reviewed plan and validates its fields against the policy again. A different registry, unsupported engine, malformed artifact, changed plan, unexpected package or digest mismatch fails without publication. Plans and receipts contain public metadata and paths; credentials are never placed in either.

R2 uses conditional content-addressed creation and byte verification. Migration `0002_official_operator.sql` makes ownership claim part of the release INSERT's SQLite trigger, so the **single D1 statement** commits both or neither. Community publication retains its existing batch transaction. Existing ownership is never taken over, existing versions never overwritten. An identical repeat verifies stored bytes and returns the original listing unchanged, including its publication timestamp. A concurrent identical import is also safe. A failure can leave an unlisted R2 orphan; retry uses the same verified bytes. A damaged existing object is reported for operator repair, never silently overwritten. Keep migration/schema changes and Worker rebinding stopped during an import.

Official provenance stays inside immutable release metadata. Backup/restore validates the approved policy and preserves identity, provenance and byte integrity. Keep historical approved policy entries to restore older official releases. Existing community-only snapshots remain supported. Checksums are not an authenticated backup signature; protect the trusted snapshot manifest independently.

## Local rehearsal

Use only a disposable or explicitly selected local registry, and stop its server before operator commands use the same persisted state. From the repository root:

```sh
npm ci --no-audit --no-fund
npx tsc
node scripts/build-extensions.mjs
npm ci --prefix marketplace/cloudflare --no-audit --no-fund
npm run build --prefix marketplace/cloudflare
cd marketplace/cloudflare
node ops.mjs serve /absolute/preview-registry
```

The local runtime initializes migrations 0001 and 0002. Stop that rehearsal server, then:

```sh
node official-cli.mjs inspect-local /absolute/preview-registry > /absolute/target.json
node official-cli.mjs plan /absolute/target.json /absolute/codegraph/dist/extensions/drupal.cgext /absolute/new-plan.json
```

Review `new-plan.json`: registry ID, absolute state path, target engine version, artifact path/digest, source revision, publisher, official flag and listing. The plan command prints its SHA-256. Apply that exact plan using the printed digest:

```sh
node official-cli.mjs apply /absolute/new-plan.json --confirm-plan-sha256 REVIEWED_SHA256
node ops.mjs serve /absolute/preview-registry
```

A second apply returns `unchanged` only if all immutable metadata and actual object bytes still agree. `inspect-local` refuses an absent/uninitialized registry; it never provisions remote resources. For an existing local rehearsal made before migration 0002, start/stop the updated `ops.mjs serve` once before import. This helper automatically migrates only its explicit local state.

## Remote preparation and execution — not yet exercised against an account

No remote import has been performed. Klaus owns account access. A browser login does not establish API credentials or permission to activate resources. Do not deploy/create resources, edit DNS, enable billing or run these remote writes until the actual account, included resources, permissions and approved target have been verified.

1. Verify the preview Worker, private R2 Standard bucket and D1 database belong to the intended account. Apply **both migrations** to the authorized preview using `wrangler d1 migrations apply DB --remote --config wrangler.deploy.json`. Back up existing data first; do not reset the database. Obtain the actual registry ID with `wrangler d1 execute DB --remote --config wrangler.deploy.json --command "SELECT value FROM registry_meta WHERE key='id'"`. No such command was executed remotely during local acceptance.
2. Create a private target JSON containing only public resource identifiers:

```json
{
  "mode": "remote",
  "accountId": "VERIFIED_32_HEX_ACCOUNT_ID",
  "databaseId": "VERIFIED_D1_UUID",
  "bucket": "verified-private-bucket",
  "workerName": "verified-preview-worker",
  "registryId": "VERIFIED_32_HEX_REGISTRY_ID",
  "engineVersion": "1.6.0"
}
```

3. Prepare/review a plan with the same `official-cli.mjs plan` command. No network request or credential read occurs while planning. The target engine must be the reviewed supported engine, not an arbitrary compatibility bypass.
4. In the trusted operator environment, configure `CLOUDFLARE_API_TOKEN` privately with the needed D1 query/write and Worker-settings read permissions, and bucket-scoped S3 credentials in `CODEGRAPH_R2_ACCESS_KEY_ID` / `CODEGRAPH_R2_SECRET_ACCESS_KEY`. The command reads these only for explicitly confirmed remote application. Do not put values in arguments, plans, logs, source control or chat. Wrangler browser/OAuth login alone is not automatically these permissions; no token creation or credential inspection is part of this milestone.
5. Run the same `apply PLAN --confirm-plan-sha256 HASH`. Before any data write, it reads authenticated Worker settings and requires `DB` and `PACKAGES` to match the target D1 ID and R2 bucket. It then verifies D1 registry identity/schema. The adapter uses the Cloudflare D1 query API and signed R2 S3 GET/conditional PUT (`If-None-Match: *`) on fixed account endpoints, with no arbitrary endpoint or unauthenticated admin route. It does not provision resources, change bindings or auto-migrate remote databases.
6. Preserve the JSON receipt and verify official catalog/detail/filter, exact download bytes and compatible one-Install/graph/manage behavior on the actual stable HTTPS origin. Repeat provider redeployment/backup/restore acceptance independently before claiming durable delivery.

The remote HTTP request contract and binding mismatch were checked with a test transport, **not a live provider account**. Actual auth scopes, deployed binding shape, S3 condition handling, regional endpoints and provider limits still require verification. This adapter currently targets default R2 account endpoints; jurisdiction-specific endpoints require a reviewed configuration change. See [Worker settings API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/settings/methods/get/), [D1 query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/), and [R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/).

## Executable acceptance

```sh
(cd marketplace/cloudflare && node official-test.mjs)
PLAYWRIGHT_MODULE=/absolute/path/to/playwright PATHAUTO_CORPUS=/absolute/pinned/pathauto \
  node scripts/validation/cloudflare-official-drupal.cjs
```

The browser test exports clean Pathauto source at `b97aadf47a37cff25f7d6105c3dade6778fccb47` into a disposable project. It uses the real CLI and local workerd/D1/R2, connects the browser once, clicks Install once, and verifies two route handlers, one hook and one service injection in actual SQLite. It proves malformed/incompatible/tampered failure preservation, disable/enable/remove cleanup, official catalog/detail/filter, and desktop/mobile layout. It does not modify the source corpus or rerun the larger corpus benchmark.

[Hosting/cost limits](cloudflare-hosting.md) remain unchanged: no durable Cloudflare URL, provider persistence, remote backup proof or Free-plan CPU fit is established. `marketplace.getcodegraph.com` remains proposed. Broader Drupal accuracy/performance review and current integrated full regression remain later milestones; historical measured overhead is 22–30%.
