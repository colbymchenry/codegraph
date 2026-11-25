-- codegraph telemetry — initial schema (Cloudflare D1)
--
-- This file is public on purpose, like the rest of telemetry-worker/: it is the
-- complete list of everything codegraph's anonymous telemetry stores. If a column
-- is not here, it is not kept. The field-by-field contract it implements lives in
-- docs/design/telemetry.md (and, user-facing, in TELEMETRY.md).
--
-- Nothing in this database identifies a person or a codebase. No IP addresses (the
-- ingest worker never reads them), no file paths, no repo, file, or symbol names, no
-- query strings. `machine_id` is a random UUIDv4 the client mints locally and the user
-- can delete at any time (`codegraph telemetry off`, or remove ~/.codegraph/telemetry.json).
--
-- Shape: raw events + daily rollups.
--   * The ingest worker (`src/index.ts`) writes ONLY to `events`, `machine_days` and
--     `machine_first_seen`, off the response path.
--   * The nightly cron recomputes the `daily_*` rollups from `events` with idempotent
--     upserts, then purges raw `events` past the retention window.
--   * The admin dashboard reads rollups first and falls back to `events` only for the
--     activation funnel and ad-hoc drill-down (both bounded by the retention window).
--
-- Apply:  npm run db:migrate:local     (local .wrangler state)
--         npm run db:migrate           (remote codegraph-telemetry)

-- ---------------------------------------------------------------------------
-- Raw events
-- ---------------------------------------------------------------------------
-- One row per sanitized event accepted by POST /v1/events. Everything here has
-- already passed the worker's allowlist: unknown events dropped, unknown props
-- stripped, strings length- and charset-checked, timestamps clamped.
--
-- Deliberately NO `CHECK (event IN (...))` constraint: the worker's EVENTS allowlist
-- is the single source of truth, and the write path is fail-silent by design (a
-- rejected INSERT would lose data quietly rather than error visibly). Same reasoning
-- for `json_valid(props)` — the worker constructs that JSON itself.
CREATE TABLE events (
  -- rowid alias, no AUTOINCREMENT: ids are never referenced anywhere, and the
  -- retention purge only ever deletes the OLDEST rows, so max(id) never drops and
  -- ids stay monotonic in practice. Gives the purge a cheap keyset batch:
  --   DELETE FROM events WHERE id IN (SELECT id FROM events WHERE day < ? LIMIT 5000)
  id                INTEGER PRIMARY KEY,
  received_at       TEXT    NOT NULL,          -- ISO 8601 UTC, worker clock, always present
  ts                TEXT,                      -- ISO 8601 UTC client timestamp, already clamped
                                               -- by the worker (>10min future / >30d past rejected);
                                               -- NULL when the client sent none. For usage_rollup
                                               -- the client sets it to <rollup day>T12:00:00Z, so it
                                               -- attributes counters to the day they happened on.
  day               TEXT    NOT NULL,          -- UTC YYYY-MM-DD from substr(ts, 1, 10), else received_at.
                                               -- Every rollup and every chart is keyed on this.
  event             TEXT    NOT NULL,          -- install | index | usage_rollup | uninstall
  machine_id        TEXT    NOT NULL,          -- random UUIDv4, client-minted (never fingerprinted)
  -- Envelope, identical for every event in a batch. All nullable: the worker's
  -- sanitizer strips anything malformed rather than rejecting the batch, so an old
  -- or odd client shows up as NULLs instead of vanishing.
  codegraph_version TEXT,
  os                TEXT,                      -- process.platform: darwin | linux | win32 | …
  arch              TEXT,                      -- process.arch: arm64 | x64 | …
  node_major        INTEGER,
  ci                INTEGER,                   -- 0/1 from the client's `ci` boolean; NULL if absent.
                                               -- "Production users" = everything except ci = 1
                                               -- (NULL counts as production — see machine_days.prod).
  schema_version    INTEGER,
  props             TEXT    NOT NULL DEFAULT '{}'  -- JSON object of the sanitized event-specific props
);

-- (day, event) subsumes a plain (day) index — SQLite uses the leading-column prefix —
-- so this pair covers day-range scans, per-event day-range scans AND the retention
-- purge with one fewer index than listing them separately. That matters: D1 bills an
-- extra row write per index touched, so every index on this table costs ~97k
-- writes/day. Do not add a third without re-checking the volume note below.
CREATE INDEX events_day_event ON events (day, event);
-- Ad-hoc per-machine drill-down and the activation funnel (install → first index).
CREATE INDEX events_machine_day ON events (machine_id, day);

-- ---------------------------------------------------------------------------
-- Rollups — written by the nightly cron, read by the dashboard
-- ---------------------------------------------------------------------------
-- Rollups are kept FOREVER (they are tiny); raw `events` are purged. So any number a
-- chart needs long-term has to be recoverable from these tables alone — that is why
-- the distinct-machine columns exist alongside the event counts.

-- Daily unique machines.
-- Serves: "Daily Production Users" line; the machine denominator on daily panels.
-- `prod_machines` excludes ci = 1 (CI runners), matching the dashboard's
-- "Production Users" framing. NOTE: these are per-day distinct counts and CANNOT be
-- summed across a range — a range-wide distinct count comes from `machine_days`.
CREATE TABLE daily_machines (
  day           TEXT    PRIMARY KEY,
  machines      INTEGER NOT NULL DEFAULT 0,
  prod_machines INTEGER NOT NULL DEFAULT 0
);

-- Daily event volume per event type.
-- Serves: "Install" / "Uninstall" big numbers; "Installs vs uninstalls over time";
--         "New installs (daily)"; the runs series of "Daily indexing activity".
-- `count` is a row count for install/index/uninstall, but for usage_rollup it is the
-- SUM of the events' `count` prop (the client pre-aggregates locally, so one row can
-- represent hundreds of tool calls). `machines` is the distinct machines that emitted
-- that event that day — the "active users" series of "Daily indexing activity", which
-- is unrecoverable once the raw rows are purged.
CREATE TABLE daily_event_counts (
  day      TEXT    NOT NULL,
  event    TEXT    NOT NULL,
  count    INTEGER NOT NULL DEFAULT 0,
  machines INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, event)
) WITHOUT ROWID;

-- One generic (dimension, value) table behind every bar and pie on the dashboard,
-- so a new breakdown is a cron change, never a migration.
-- Serves, by `dim`:
--   os                 → "Users by operating system" (pie)
--   arch               → arch mix
--   codegraph_version  → "Users by app version" (bar)
--   node_major         → Node version mix
--   language           → "Most-indexed programming languages" (bar; unnested from index.languages)
--   file_count_bucket  → "Codebase size (files per project)" (bar)
--   duration_bucket    → "Session run length" (pie) and "Indexing speed" (bar),
--                        plus "indexing duration buckets over time" (stacked line)
--   target             → "AI Agent Targets" (bar; unnested from install.targets / uninstall.targets)
--   scope              → install local vs global
--   kind               → install fresh / upgrade / reinstall
--   name               → usage by MCP tool / CLI command (incl. prompt-hook-gate-* outcomes)
--   client_name        → usage by agent (Claude Code, Cursor, …), from MCP clientInfo
-- `event` is kept in the key so the same dim can be sliced per event type (e.g. os for
-- install vs os for index). `count` is event volume (SUM of the usage_rollup `count`
-- prop where applicable); `machines` is distinct machines — the honest number for the
-- "users by …" panels, which are machine counts, not event counts.
CREATE TABLE daily_dim_counts (
  day      TEXT    NOT NULL,
  event    TEXT    NOT NULL,
  dim      TEXT    NOT NULL,
  value    TEXT    NOT NULL,
  count    INTEGER NOT NULL DEFAULT 0,
  machines INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, event, dim, value)
) WITHOUT ROWID;

-- Cross-event slices of one dimension over a date range ("languages, all events, last 30d").
CREATE INDEX daily_dim_counts_dim_day ON daily_dim_counts (dim, day);

-- First day a machine was ever seen.
-- Serves: "New installs over time"; the denominator of the install → first-use
--         activation funnel; the cohort key for retention.
-- Written by the ingest worker on every batch (upsert keeps the MINIMUM day, so a
-- late-arriving offline buffer can move a machine's first day earlier but never later).
CREATE TABLE machine_first_seen (
  machine_id TEXT PRIMARY KEY,
  first_day  TEXT NOT NULL
);

-- Cohort scans: "machines first seen between X and Y".
CREATE INDEX machine_first_seen_day ON machine_first_seen (first_day);

-- Machine × day activity matrix — the only table that can answer "distinct machines
-- over a RANGE" (daily rollups can't: summing them double-counts returning machines).
-- Serves: "Daily retention cohorts" (day 0–14 curve, joined to machine_first_seen);
--         the "Production Users" big number over the picker's range;
--         active-machine lines beyond the raw-event retention window.
-- `prod` is 0 only if EVERY event that machine sent that day carried ci = 1; a missing
-- `ci` counts as production. Kept per (machine, day) rather than as a per-machine flag
-- because the same install can run inside and outside CI on different days.
-- ~10k rows/day at current volume — WITHOUT ROWID keeps it compact (the PK is the table).
-- NOT purged by the retention job: retention cohorts need the full history.
CREATE TABLE machine_days (
  machine_id TEXT    NOT NULL,
  day        TEXT    NOT NULL,
  prod       INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (machine_id, day)
) WITHOUT ROWID;

-- Day-keyed scans ("distinct machines active in this range").
CREATE INDEX machine_days_day ON machine_days (day);

-- ---------------------------------------------------------------------------
-- Volume & storage sanity check (Workers Paid, limits as of 2026-07)
-- ---------------------------------------------------------------------------
-- Included per month: 50M rows written, 25B rows read, 5 GB storage
-- (then $0.75/GB-mo). Hard cap: 10 GB per database.
--
-- Current ingest is ~97k accepted POSTs/day. D1 counts one row write PER INDEX
-- touched in addition to the table row, so with ~2 events per request:
--
--   events        97k × 2 × (1 table + 2 indexes) ≈ 0.6M writes/day
--   machine_days  97k × (1 table + 1 index)       ≈ 0.2M writes/day
--   first_seen    97k × (1 table + 1 index)       ≈ 0.2M writes/day
--   rollup cron   ~1k rows/day                      negligible
--                                                 ─────────────────
--                                                 ≈ 1.0M writes/day ≈ 30M/month
--
-- Comfortably inside the 50M included, with ~1.6× headroom. (The epic's "~10M/month"
-- estimate predates counting index writes; the arithmetic above is the one to trust.)
-- Reads are trivial: the dashboard hits rollups, ~thousands of rows per page load.
--
-- STORAGE is the tighter constraint, and it decides the retention window. A raw event
-- row is ~250 B plus ~130 B of index entries, so ~74 MB/day:
--
--   90-day retention  ≈ 6.7 GB   under the 10 GB cap, ~$1.30/mo over the 5 GB included
--   180-day retention ≈ 13 GB    EXCEEDS the 10 GB per-database cap
--
-- So the retention job should start at 90 days, not 180 — and the real row size must be
-- measured after cutover (`SELECT count(*), sum(length(props)) FROM events`) before
-- widening it. Rollups are kept forever regardless, so shortening the raw window costs
-- ad-hoc drill-back, never a chart. If writes or storage ever get tight, the levers, in
-- order: drop events_machine_day (drill-down only), move the machine_first_seen upsert
-- off the hot path into the nightly cron, then store timestamps as INTEGER epoch ms.
