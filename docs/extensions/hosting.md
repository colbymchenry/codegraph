# Hosting the extension marketplace

Cloudflare is now the preferred hosted target. See [Cloudflare deployment and cost guidance](cloudflare-hosting.md). The Node/SQLite instructions below remain the portable backend reference; Vercel-specific instructions are historical alternatives, not the current delivery target.

This branch supplies a Node registry and browser frontend. It does not provision a host, disk, backup service, TLS endpoint or Vercel project. A running local server or temporary HTTPS tunnel is not a durable deployment.

## Persistence contract

Use Node 22.23.2 (the validated runtime), one dedicated persistent **local** filesystem volume, and one registry service. The volume must survive process replacement and application redeployment. Do not use a Vercel Function filesystem, a container writable layer, `/tmp`, or a network filesystem for the registry. SQLite WAL needs reliable local locking and flushes. Multiple processes on the same machine serialize writes with `BEGIN IMMEDIATE`; multi-host replication is not implemented.

The database holds publisher ownership, immutable version metadata, package bytes and replay nonces in the same transaction. Readers cannot see a listing without its artifact. WAL with `synchronous=FULL` requests durable commits. Process-kill tests exercise rollback and recovery; they do not prove hardware/power-loss guarantees of a future provider's disk.

`MARKETPLACE_DATA_DIR` must be an absolute path outside the application deployment. Initialization is explicit and refuses nonempty directories. Normal startup checks the volume marker, registry identity, schema, SQLite integrity and every package's identity/integrity/ownership. A missing or wrong volume fails startup rather than silently creating an empty catalog. Incomplete restore directories also fail closed. No endpoint exposes backup or administrative filesystem operations.

## Prepare and run

From the repository root, in a checkout of the desired commit:

```sh
npm ci --no-audit --no-fund
npm run build
npm run build --prefix marketplace
export MARKETPLACE_DATA_DIR=/absolute/persistent-volume/codegraph-registry
node marketplace/server/registry.cjs init
node marketplace/server/registry.cjs verify
HOST=127.0.0.1 PORT=8080 node marketplace/server/registry.cjs serve
```

Initialize **once**, on a dedicated writable directory owned by the service user. Record the returned registry ID separately. For a container or managed ingress, set `HOST=0.0.0.0` and restrict access using the host's ingress policy. An included TLS ingress/reverse proxy must forward the marketplace origin to this service; the service serves both frontend and API on one origin. Configure at least 13 MiB request bodies, health check `/api/health`, and forward the whole `/api/*` namespace. Do not enable cross-origin HTTP access to the local companion or change its origin/window checks. Keep the registry origin stable: publisher signing keys are browser-origin scoped.

`MARKETPLACE_OFFICIAL_ARTIFACT=/absolute/path/drupal.cgext` optionally seeds the official Drupal artifact. Identical repeated seeds are idempotent; a changed artifact under the same version or a conflicting publisher aborts startup. Community submissions cannot set official status. Back up publisher keys using the browser's key export; registry backup does not contain private publisher keys.

For redeployment, stop the old process gracefully, replace the application checkout/build, and start `serve` using the **same volume**. Never run `init` during startup or redeployment. The new process verifies the stored identity and artifacts. Schema 1 has no destructive migration. Preserve the old application image and a verified backup before any future schema migration.

## Backup and isolated restore

```sh
# Service may remain running; VACUUM INTO includes a consistent view of live WAL.
node marketplace/server/registry.cjs backup /absolute/backups/registry-unique-name

# Restore to a NEW dedicated directory; never overwrite a live DB or its WAL.
MARKETPLACE_DATA_DIR=/absolute/restore-lab/registry \
  node marketplace/server/registry.cjs restore /absolute/backups/registry-unique-name
MARKETPLACE_DATA_DIR=/absolute/restore-lab/registry \
  node marketplace/server/registry.cjs verify
MARKETPLACE_DATA_DIR=/absolute/restore-lab/registry PORT=8081 \
  node marketplace/server/registry.cjs serve
```

Backup consists of `registry.sqlite` and `backup.json` with a SHA-256 and release inventory. Snapshot bytes are flushed, verified and finalized before the manifest appears. Missing manifests and checksum/inventory mismatches reject restore. Restore verifies every immutable package and publisher before writing a new volume. Directory flush is available on POSIX; Windows flushes files but has no equivalent directory fsync here. If interrupted during backup/restore, preserve the incomplete directory for inspection and retry to a different new directory; it is never a ready volume.

The operator must schedule backups, copy **completed** backup directories to an independent durable location, define retention/RPO/RTO and periodically test isolated restores. This code does not claim an off-host backup destination or scheduler exists. A checksum detects corruption, not an attacker who controls both backup and manifest: restrict write access and retain a trusted external checksum. To cut over after a restore, stop writers, verify the replacement, then change the service's volume configuration; preserve the original until reviewed. Never restore over running data.

## Optional Vercel frontend

The persistent backend must already be reachable at a stable public HTTPS origin. The checked-in default gateway returns 503 without `MARKETPLACE_API_ORIGIN`; it is a configuration failure indicator, not a functioning marketplace. The legacy Function gateway is unsuitable for full-size artifacts because Vercel Functions cap request/response payloads at 4.5 MB. Use native external rewrites for the full 8 MiB package contract ([Vercel limits](https://vercel.com/docs/functions/limitations), [external rewrites](https://vercel.com/docs/routing/rewrites)).

Before deploying a preview, prepare an isolated copy of `marketplace/`, excluding `.data` and existing `dist`. Generate a new config outside the copy, then replace **the deployment copy's** `vercel.json`:

```sh
node marketplace/server/configure-vercel.cjs \
  https://your-persistent-registry.example /absolute/staging/vercel.generated.json
```

The generator requires an HTTPS origin with no credentials/path/query and sets `/api/:path*` to that fixed origin; browser calls and installer downloads retain the marketplace origin. Keep frontend build command `npm run build`, output `dist`, and project root the deployment copy. Use a preview deployment, not production. Confirm actual platform proxy limits with an 8 MiB package before claiming full hosted acceptance. The generator/config is tested locally; an actual Vercel deployment still requires available included resources and verification. Never deploy a static shell with a missing backend and call it ready.

## Reproduce validation

```sh
npx tsc
npm run build --prefix marketplace
node scripts/validation/marketplace-storage.cjs
npx vitest run __tests__/marketplace-storage.test.ts __tests__/extension-marketplace.test.ts
# Optional temporary PUBLIC HTTPS transport; only disposable fixtures are exposed.
REGISTRY_TEST_HTTPS=1 PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
  node scripts/validation/extensions-compatibility.cjs
REGISTRY_TEST_HTTPS=1 PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
  node scripts/validation/marketplace-browser.cjs
```

The HTTPS scripts require `cloudflared` and a local Chromium installation (`CHROME_PATH`). They preserve tunnel URLs, logs, screenshots and results, use normal TLS verification and browser security, and close the test tunnel afterward. These checks establish secure-origin browser-to-loopback behavior. They do not establish durable public service availability, disk persistence on a hosting provider, backups off the workspace, Safari/Firefox support or a Vercel deployment.
