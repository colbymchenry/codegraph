# codegraph telemetry dashboard

The private admin view behind `stats.getcodegraph.com`. Its sibling
[`telemetry-worker/`](../telemetry-worker/) writes anonymous usage events into a D1 database;
this worker reads them back and draws the charts. Two people use it, so the auth is
deliberately the simplest thing that is actually safe: one shared password in a secret, and
a long-lived signed cookie.

This directory is in the public repo for the same reason the ingest worker is — the code
that touches telemetry should be readable by the people it collects from. Nothing secret
lives here: the password and the cookie-signing key are deployment secrets, and the D1
database ID is an identifier, not a credential.

## What is gated

Everything except the login page and `robots.txt`. `assets.run_worker_first` is `true` in
`wrangler.jsonc`, so Cloudflare hands *every* request to `src/index.ts` before the static
asset server sees it — the dashboard HTML, its JS, its CSS and the chart library are all
behind the session check, and a request without a valid cookie gets a redirect (pages) or a
`401` (`/api/*`). The login page is rendered inline by the worker rather than served from
`public/`, so the asset directory needs no "is this file public?" judgement calls.

| Route | Auth | Notes |
|---|---|---|
| `GET /login` | public | Password form. Redirects to `/` if already signed in. |
| `POST /login` | public | Rate-limited per IP; sets the session cookie on success. |
| `POST /logout` | public | Clears the cookie. |
| `GET /robots.txt` | public | `Disallow: /`. |
| `GET /api/*` | required | JSON. `401` without a session. See the API below. |
| everything else | required | Static assets from `public/`. `302 /login` without a session. |

## The API

Every endpoint is `GET`, session-gated, and scoped by `?from=YYYY-MM-DD&to=YYYY-MM-DD`
(inclusive, UTC days). Ranges wider than 366 days are clamped and say so in
`range.clamped`. Responses come back Chart.js-shaped — `labels[] + datasets[]` — plus a
`rows[]` in the data's natural shape, which is what each panel's "Show numbers" table
renders. Bad input is a `400` with a message, never a guess. Chart data carries
`Cache-Control: private, max-age=300`.

| Endpoint | Answers |
|---|---|
| `/api/meta` | The days data actually exists for. The picker anchors its presets on `latest_day` so no chart ends on a day the nightly rollup has not written yet. |
| `/api/summary` | Big numbers: production users, active machines, new machines, installs, uninstalls, indexing runs, tool calls. |
| `/api/timeseries?metric=` | `installs_uninstalls`, `new_installs`, `production_users`, `indexing_activity`, `tool_calls`, `duration_buckets`. One dense point per day — a day with nothing is a zero, not a gap. |
| `/api/breakdown?dim=` | `os`, `arch`, `codegraph_version`, `node_major`, `language`, `file_count_bucket`, `duration_bucket`, `target`, `scope`, `kind`, `name`, `client_name`, `name_error`. Optional `&event=`, `&metric=count\|machines`, `&limit=`. |
| `/api/activation?window=7` | Install → first index funnel, plus the daily rate. |
| `/api/retention` | Day 0–14 cohort curve for machines first seen in the range. |
| `/api/health` | Liveness plus the latest event/rollup day. Uncached. |

Everything reads the `daily_*` rollups and `machine_days`, which are kept forever, so a
chart stays correct for days whose raw events have been purged. `/api/activation` is the
one exception — "did this machine ever run an index" is not a daily aggregate — so it
reads raw `events` and is bounded by the ingest worker's retention window. It reports
`raw_events_from` for that reason.

### Two numbers that are easy to misread

Both are labelled honestly in the UI rather than rounded off into something friendlier:

- **Machine-days, not users.** `daily_dim_counts.machines` is per day, so summing it over
  a range counts a machine once per day it was active. A range-wide distinct count per
  dimension value is not recoverable from the rollups at all, so the panels that use it
  say "machine-days" and are share-of-total panels where the distinction does not move the
  shape. Where a dimension rides several event types, the per-day figure is the largest
  single-event count rather than their sum, so one machine's install + index + usage on
  one day is not counted three times.
- **Recent cohorts have not finished converting.** A machine that installed yesterday has
  not had seven days to run an index, so the tail of the activation curve is a floor, not
  a result. The API marks those days (`complete: false`, `incomplete_from`) and the panel
  says so instead of drawing a cliff and calling it a drop in conversion. Retention does
  the same thing with a per-day denominator: day *k* is measured only over the machines
  that have actually had *k* days to come back.

## How the session works

- The password is compared in constant time, over SHA-256 digests so the operands are always
  the same length and nothing about the secret leaks through timing.
- The cookie is a signed assertion — `base64url(payload).base64url(HMAC-SHA256)` — not a
  lookup key. There is no session store; a tampered payload fails the signature check.
- `HttpOnly; Secure; SameSite=Lax; Path=/`, `Max-Age` one year. You sign in once per browser
  and it survives restarts.
- The payload carries a fingerprint of the password it was minted against, so
  **rotating `ADMIN_PASSWORD` signs everyone out** — that is the revocation story.
- Login attempts are capped at 5/min per IP. Unlike the ingest worker, which never reads the
  client IP at all, this one does — solely as a rate-limit key, never stored or logged.

## Deploy

Prereqs: the `getcodegraph.com` zone on the deploying Cloudflare account (the custom domain
auto-provisions DNS + cert), and the D1 database from `telemetry-worker/` already created.

```bash
cd telemetry-dashboard
npm install
npx wrangler login                      # once

npx wrangler secret put ADMIN_PASSWORD  # the shared password
npx wrangler secret put SESSION_SECRET  # cookie-signing key, e.g. `openssl rand -base64 48`

npm run deploy
```

Both secrets are required — the worker refuses every request if either is missing, so a
half-configured deployment fails closed rather than becoming an open dashboard.

Rotating either one is a `wrangler secret put` away. Rotating `SESSION_SECRET` invalidates
outstanding cookies too, and is the right move if you think one leaked.

Migrations belong to the writer, not to this worker: apply schema changes from
`telemetry-worker/` (`npm run db:migrate`). D1 is read-only here.

## Local dev & checks

```bash
cp .dev.vars.example .dev.vars   # placeholder secrets; also feeds `wrangler types`
npm run check                    # vendor + wrangler types + tsc --noEmit + deploy --dry-run
npm run seed                     # load scripts/fixture.sql into the LOCAL D1
npm run dev                      # http://localhost:8787

npm run smoke:auth               # the auth gate            (54 assertions)
npm run smoke:api                # the SQL and its numbers  (98 assertions)
npm run smoke:render             # the panels, in a browser (79 assertions)
```

Each suite starts its own throwaway `wrangler dev` on its own port and cleans up after
itself, so they can be run in any order (`DASH_PORT` overrides the port).

**`smoke-auth.sh`** is the regression net for the gate: unauthenticated requests reach
nothing (pages, API *and* static assets), the cookie is persistent and correctly flagged,
flipped/truncated/forged cookies are all rejected, brute force is capped, and rotating the
password invalidates existing sessions. Run it after touching `src/auth.ts` or the route
table in `src/index.ts`.

**`smoke-api.sh`** checks every endpoint against `scripts/fixture.sql` — twelve machines
over ten days, listed machine by machine in that file's header, small enough that every
expected number was worked out by hand rather than recorded from a passing run. It also
covers the boring half: bad dims, malformed dates, backwards ranges and over-wide ranges.

**`render-check.mjs`** loads the real page in whatever Chromium is already on the machine
(over the DevTools protocol — no new dependency; it *skips* if there is no browser) and
reads the live Chart.js instance behind each canvas, comparing what every panel plotted
against the same endpoint fetched from Node. That is what catches a panel wired to the
wrong dimension, which neither of the other two suites can see. It also drives the range
picker and asserts a clean console, so a CSP regression fails the build.
`RENDER_SHOT=/tmp/dash.png npm run smoke:render` writes a full-page screenshot — the only
way to check the things assertions cannot, like label collisions.

## Frontend

Plain static files in `public/` — one HTML page, ES modules, no framework, no build step.

| File | Holds |
|---|---|
| `index.html` | The shell: masthead, the one filter row, an empty grid. |
| `panels.js` | The panel registry — data in, chart config out, no DOM. Adding a panel is one entry. |
| `theme.js` | Palette, formatters, and the Chart.js defaults every panel inherits. |
| `app.js` | The page: range picker, one fetch per panel, loading/empty/error states. |

The split is what lets `render-check.mjs` import the *same* registry the browser just
rendered from, so its expectations cannot drift from the panels under test.

Panels fail alone: each fetches, draws and reports independently, so a failed query leaves
the other eighteen on screen. There is no client-side cache — the only reuse is
deduplicating identical URLs within a single render (four stat tiles share one
`/api/summary`), and that map is discarded afterwards, so refresh really does re-ask.
A refetch dims the previous render rather than tearing it down, so nothing jumps. Every
chart has a "Show numbers" table twin, which is what keeps a value from being reachable
only by hovering.

### Colours

Two scales, both run through the data-viz validator against this dashboard's actual chart
surface (`#ffffff`, the panel fill) rather than picked by eye — the exact results are
recorded at the top of `theme.js`:

- **Categorical** `#a8342a #2a6f9e #17916a #c98500` — identity (which series). Slot 1 is
  the brand oxblood stepped up into the legible lightness band. Clears every gate
  including all-pairs colour-vision separation, with no contrast relief needed.
- **Ordinal** `#d99a90 #c26a5c #a3423a #7a201a` — one hue, light to dark, for scales whose
  order *is* their meaning (run length, codebase size), so the ordering is visible in the
  colour instead of needing the legend.

Nominal bars all take slot 1: colouring them by value would spend the identity channel
re-encoding what bar length already shows. If you change a hex, re-run the validator — the
red/green pair that "looks fine" is the one that collapses under deuteranopia.
Workers Static Assets serves them verbatim, so third-party libraries are copied out of
`node_modules` into `public/vendor/` by `npm run vendor` (wired into `dev` and `deploy`).
That keeps the version pinned by the lockfile, avoids a third-party origin at runtime, and
lets the CSP stay `script-src 'self'`. `public/vendor/` is gitignored — it is build output.

Visual conventions follow the rest of codegraph: flat and editorial, square corners, hairline
rules, sentence-case headings, one oxblood accent, no tiny all-caps tracked labels.
