# codegraph telemetry ingest worker

The first-party endpoint behind `telemetry.getcodegraph.com`. This directory is in the
public repo **on purpose**: it is the exact code that receives codegraph's anonymous usage
telemetry, so anyone can audit what is stored. The schema contract (every event, every
field, and everything that is never collected) is in
[`docs/design/telemetry.md`](../docs/design/telemetry.md).

What it does, in one breath: validates incoming batches against a strict allowlist (unknown
events dropped, unknown properties stripped), never reads or stores the client IP,
rate-limits per machine ID, and writes the survivors to our own D1 database off the response
path. A nightly cron rolls each finished day up into anonymous daily counts and deletes the
raw rows behind it. It makes no outbound requests — nothing is forwarded to a third-party
analytics vendor. It ships nowhere with the npm package — the engine's `files` allowlist
excludes it.

## Endpoint contract

- `POST /v1/events` — JSON body: envelope (`machine_id` UUID, `codegraph_version`, `os`,
  `arch`, `node_major`, `ci`, `schema_version`) + `events: [{event, ts?, props?}]`.
  Responds `204` when accepted (including events dropped by the allowlist), honest `4xx`
  for malformed/oversized/rate-limited requests. Clients treat every response as final —
  no retries.
- `GET /` — plain-text pointer to the docs and the off-switches.
- `POST /admin/rollup` — manual rollup trigger, see below. `404` unless `ADMIN_TOKEN` is set.

## Storage (Cloudflare D1)

Telemetry is stored in the `codegraph-telemetry` D1 database on the same account, bound as
`env.DB` — this database is the only place accepted events go. Each request's surviving
events are written in a single `batch()` (one implicit transaction) under `ctx.waitUntil`,
so the write is off the response path. It is deliberately **fail-silent**: a D1 error is
logged to Workers Logs (counts only, never the payload) and the client still gets its `204`,
because clients never retry — losing a datapoint beats losing availability. Alongside the
raw rows, the worker upserts `machine_days` and `machine_first_seen`; when a batch is emptied
by the allowlist, nothing at all is written, so those tables only ever describe stored events.

The complete schema is [`migrations/0001_init.sql`](migrations/0001_init.sql) —
checked in for the same reason this worker's source is public: it is the entire list of what
gets kept, with a comment on every column and on which dashboard chart each rollup table
serves. Shape: raw sanitized `events`, `daily_*` rollups recomputed nightly, and
`machine_days` / `machine_first_seen` for retention cohorts. The dashboard reads rollups; raw
events exist for drill-down and are purged past the retention window.

```bash
npm run db:migrate:local     # apply to the local .wrangler state (offline, no account needed)
npm run db:migrate           # apply to the remote codegraph-telemetry database
npm run db:migrations        # which migrations are applied remotely
npm run db:sql "select count(*) from events"
```

Both applies bootstrap from empty and are a no-op when already current. A schema change is a
new numbered file (`npx wrangler d1 migrations create codegraph-telemetry <name>`) — never an
edit to a migration that has been applied.

Volume, at ~97k accepted POSTs/day: ≈30M D1 row writes/month against the 50M included on
Workers Paid, plus roughly as much again once the purge reaches steady state — a delete bills
like an insert, and at steady state every row written is eventually deleted, so budget ≈48M.
D1 bills a row write per index touched on top of the table row, which is why `events` carries
only two indexes; dropping `events_machine_day` is the first lever if that gets tight. Storage
is the other constraint, and it is what sets the window: raw events grow ≈74 MB/day, so 90 days
lands at ≈6.7 GB against D1's 10 GB per-database cap, while 180 days would exceed it. Full
arithmetic and the remaining levers are in the migration's footer comment.

## Rollups & retention (nightly cron)

`src/rollup.ts` runs on a Cron Trigger at **00:30 UTC** and does two things.

**Rolls up** the day that just ended into `daily_machines`, `daily_event_counts` and
`daily_dim_counts`, then re-runs the two days before it — offline clients ship completed-day
rollups late, so a day keeps growing after it ends. The aggregation is one
`INSERT … SELECT … ON CONFLICT DO UPDATE` per table or dimension, so it happens inside D1 and
no event row crosses the wire. Every write overwrites the recomputed value rather than adding
to it: **re-running a day is a no-op, never a double count.** Two things the SQL is careful
about — a `usage_rollup` row is a counter the client pre-aggregated, so its `count` prop is
summed rather than the rows counted; and `index.languages` / `install.targets` are unnested
with `json_each`, one row per element. Adding a breakdown is a line in `ROLLUP_STATEMENTS`,
never a migration — that is what the generic `(dim, value)` shape buys.

**Purges** raw `events` older than `RETENTION_DAYS` (90, a var in `wrangler.jsonc`) in bounded
`DELETE` batches, and logs one line of counts. `machine_days` and `machine_first_seen` are
never purged — retention cohorts need the full history and they are two orders of magnitude
smaller. Rollups are kept forever, so shortening the window costs ad-hoc drill-back, never a
chart.

Backfill or repair without a redeploy, guarded by the `ADMIN_TOKEN` secret:

```bash
curl -X POST -H "x-admin-token: $ADMIN_TOKEN" \
  'https://telemetry.getcodegraph.com/admin/rollup?day=2026-07-27'          # one day
curl -X POST -H "x-admin-token: $ADMIN_TOKEN" \
  'https://telemetry.getcodegraph.com/admin/rollup?day=2026-07-27&days=14'  # the 14 days ending there
```

`&reset=1` drops the day's rollup rows before recomputing, for when the dimension list itself
changed and a value that no longer exists would otherwise linger. It is ignored past the
retention window, where it would delete rows and then find no events to rebuild them from —
the response says which days it refused. Keep manual ranges to a few days at production volume;
each day is a full scan of that day's events, and the request has a wall-clock budget.

## Deploy

Prereqs: the `getcodegraph.com` zone on the deploying Cloudflare account (the custom
domain route auto-provisions DNS + cert), wrangler ≥ 4.36 (the `ratelimits` binding).

```bash
cd telemetry-worker
npm install
npx wrangler login     # once
npm run db:migrate     # bring the D1 schema up to date FIRST — the worker writes on deploy
npm run deploy
npx wrangler secret put ADMIN_TOKEN   # optional, see below
```

The worker holds no API keys — it talks to nothing but its own bound D1 database. The one
secret is `ADMIN_TOKEN`, which enables `POST /admin/rollup`; leave it unset and that route
does not exist. Generate one with `openssl rand -hex 32`, and note that rotating it takes
effect on the next request.

## Cutover from PostHog (one-time)

The replacement of PostHog by this worker's own D1 storage. It is a **hard cutover with no
backfill** — PostHog history is disposable, and the new charts start from an empty database.
**Clients are unaffected at every step:** they keep POSTing to `telemetry.getcodegraph.com`
and every response shape is unchanged, so no client can tell which storage backend is live.

The one-way door is step 6. Everything before it is reversible with `npx wrangler rollback`,
which is why the PostHog key stays put until the new path has proven itself for a day.

**Before you start:** `npm run smoke:cutover`. It runs the whole chain locally — a client
batch through the ingest worker into D1, the nightly rollup over it, then the dashboard
reading the numbers back — and is the only check that covers the seam between the two
workers. They are separate deployments that agree on a list of dimension names by
convention alone, and a mismatch there is silent: no error, no failed request, just a panel
that reads zero forever.

1. **Put the account on Workers Paid (~$5/mo).** Ingest already runs ~97k requests/day
   against the free plan's 100k/day cap, so this is overdue independently of D1 — and the
   included D1 quota (5 GB storage, 50M row writes/mo) comes with it. The volume arithmetic
   is under [Storage](#storage-cloudflare-d1); at ~97k POSTs/day it fits, with the retention
   window sized to the 10 GB per-database cap.

2. **Bring the production database up to schema.** `codegraph-telemetry`
   (`5ed36dfb-d2d7-4e35-9e63-a1b99d0b1ed3`) already exists on the account and is bound in
   `wrangler.jsonc`; this only applies migrations, and is a no-op if it is already current.

   ```bash
   cd telemetry-worker
   npm run db:migrate          # remote; bootstraps from empty
   npm run db:migrations       # confirm 0001_init is listed as applied
   ```

3. **Deploy, and note the version you are leaving.** Print the deployment list first — the
   id at the top is your rollback target for the next 24 hours.

   ```bash
   npx wrangler deployments list      # record the current version id
   npm run deploy
   npx wrangler secret put ADMIN_TOKEN   # if not already set; enables manual rollups
   ```

4. **Watch for 24 hours before trusting it.** The number that matters is the daily ingest
   rate: it should track the ~95–97k/day PostHog was seeing. A materially lower number means
   events are being dropped somewhere between the client and the table — a schema or binding
   mistake, not a real change in usage.

   ```bash
   npm run db:sql "select count(*) as rows, max(received_at) as newest from events"
   npm run db:sql "select day, count(*) from events group by day order by day desc limit 3"
   ```

   `max(received_at)` should be seconds old at any time of day. Watch Workers Logs
   (`npx wrangler tail`) alongside it for a non-zero error rate — the D1 write is deliberately
   fail-silent, so a broken write shows up as a log line and a flat row count, never as a
   failing request.

   **If anything looks wrong, stop here and `npx wrangler rollback [version-id]`.** PostHog is
   still live and still holds the key, so rolling back restores the old behaviour completely.

5. **Verify the nightly rollup and the dashboard.** After the first 00:30 UTC cron has run,
   the completed day must be present in the rollup tables — the dashboard reads those, not raw
   events, so an empty rollup is an empty dashboard even with ingest working perfectly.

   ```bash
   npm run db:sql "select day, machines, prod_machines from daily_machines order by day desc limit 3"
   npm run db:sql "select day, event, count from daily_event_counts order by day desc limit 10"
   ```

   Then open the dashboard (`stats.getcodegraph.com`, see
   [`../telemetry-dashboard/README.md`](../telemetry-dashboard/README.md)) and confirm the
   panels render live numbers rather than empty states. If the cron did not fire, roll the day
   up by hand with `POST /admin/rollup?day=…` above rather than waiting another 24 hours.

6. **Only now, retire PostHog.** Past this point the previous worker version can still be
   rolled back, but it will have no key to forward with — this is the step that makes the
   cutover final.

   ```bash
   npx wrangler secret delete POSTHOG_KEY   # the last vendor credential on the account
   npx wrangler secret list                 # confirm ADMIN_TOKEN is the only secret left
   ```

   Then cancel the subscription and delete the project.

7. **Delete this section.** The forwarding code and the `POSTHOG_HOST` var left the repo with
   the D1 rewrite, and `npm run smoke:cutover` asserts on every run that the worker's source
   and config reference no analytics vendor and make no outbound request at all. This runbook
   is the last place the old vendor is named anywhere in the repository, so once step 6 is
   done:

   ```bash
   grep -ri posthog . --exclude-dir=node_modules --exclude-dir=.git
   ```

   returning nothing is the check that the cutover is complete — and deleting these steps is
   what makes it pass. Keep them until then: every step above is reversible, and a rollback
   is useless if its instructions have already been deleted.

## Local dev & checks

```bash
npm run check                # wrangler types + tsc --noEmit + deploy --dry-run
npm run db:migrate:local     # once, so `wrangler dev` has tables to write to
npm run dev                  # http://localhost:8787 (local D1 in .wrangler/)
npm run smoke                # end-to-end: boots `wrangler dev`, POSTs, asserts stored rows
npm run smoke:rollup         # end-to-end: seeds synthetic days, rolls them up, purges,
                             # asserts every number against hand-computed values
npm run smoke:cutover        # the whole chain: a client batch → D1 → rollup → the dashboard
                             # API reads it back. Boots BOTH workers against one shared local
                             # D1, so it is the only check that covers the seam between them.

curl -i localhost:8787/v1/events -H 'content-type: application/json' -d '{
  "machine_id": "00000000-0000-4000-8000-000000000000",
  "codegraph_version": "0.9.9", "os": "darwin", "arch": "arm64",
  "node_major": 22, "ci": false, "schema_version": 1,
  "events": [{ "event": "usage_rollup",
               "props": { "kind": "mcp_tool", "name": "codegraph_explore",
                          "count": 12, "error_count": 0, "client_name": "Claude Code" } }]
}'

npx wrangler d1 execute codegraph-telemetry --local \
  --command "select day, event, machine_id, props from events order by id desc limit 5"
```

To drive the cron body by hand, run `wrangler dev --test-scheduled` and hit
`localhost:8787/__scheduled?cron=30+0+*+*+*`. For `POST /admin/rollup` locally, copy
`.dev.vars.example` to `.dev.vars` — without an `ADMIN_TOKEN` the route 404s, exactly as a
deploy that never set the secret does.

## Changing the schema

The allowlist in `src/index.ts` mirrors `docs/design/telemetry.md` (and the user-facing
`TELEMETRY.md`). A field is added by one PR touching all of them together — that is the
whole point of the design.
