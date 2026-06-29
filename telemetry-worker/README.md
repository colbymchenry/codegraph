# codegraph telemetry ingest worker

The first-party endpoint behind `telemetry.getcodegraph.com`. This directory is in the
public repo **on purpose**: it is the exact code that receives codegraph's anonymous usage
telemetry, so anyone can audit what is stored. The schema contract (every event, every
field, and everything that is never collected) is in
[`docs/design/telemetry.md`](../docs/design/telemetry.md).

What it does, in one breath: validates incoming batches against a strict allowlist (unknown
events dropped, unknown properties stripped), never reads or forwards the client IP,
rate-limits per machine ID, and forwards to PostHog off the response path. It ships nowhere
with the npm package — the engine's `files` allowlist excludes it.

## Endpoint contract

- `POST /v1/events` — JSON body: envelope (`machine_id` UUID, `codegraph_version`, `os`,
  `arch`, `node_major`, `ci`, `schema_version`) + `events: [{event, ts?, props?}]`.
  Responds `204` when accepted (including events dropped by the allowlist), honest `4xx`
  for malformed/oversized/rate-limited requests. Clients treat every response as final —
  no retries.
- `GET /` — plain-text pointer to the docs and the off-switches.

## Deploy

Prereqs: the `getcodegraph.com` zone on the deploying Cloudflare account (the custom
domain route auto-provisions DNS + cert), wrangler ≥ 4.36 (the `ratelimits` binding).

```bash
cd telemetry-worker
npm install
npx wrangler login                      # once
npx wrangler secret put POSTHOG_KEY     # the phc_… project write key — never committed
npm run deploy
```

The PostHog project itself must have **"Discard client IP data"** enabled — defense in
depth on top of this worker never forwarding IPs (`$geoip_disable` is also set per event).

## Local dev & checks

```bash
cp .dev.vars.example .dev.vars   # placeholder key; also feeds `wrangler types`
npm run check                    # wrangler types + tsc --noEmit + deploy --dry-run
npm run dev                      # http://localhost:8787

curl -i localhost:8787/v1/events -H 'content-type: application/json' -d '{
  "machine_id": "00000000-0000-4000-8000-000000000000",
  "codegraph_version": "0.9.9", "os": "darwin", "arch": "arm64",
  "node_major": 22, "ci": false, "schema_version": 1,
  "events": [{ "event": "usage_rollup",
               "props": { "kind": "mcp_tool", "name": "codegraph_explore",
                          "count": 12, "error_count": 0, "client_name": "Claude Code" } }]
}'
```

## Changing the schema

The allowlist in `src/index.ts` mirrors `docs/design/telemetry.md` (and the user-facing
`TELEMETRY.md`). A field is added by one PR touching all of them together — that is the
whole point of the design.
