-- codegraph telemetry — usage counters, one row per machine × day × tool.
--
-- `usage_rollup` events were stored one row per event in `events`. The client was
-- meant to send one pre-aggregated counter per machine × day × tool, but it only
-- aggregates within a single process: every short-lived codegraph process (each
-- `serve` launch, CLI command or prompt hook) uploads its own `count: 1` line. By
-- 2026-08-10 that was ~3.8M rows a day, 98% of the database, and the database hit
-- D1's 10 GB cap — from 2026-08-11 nearly every write failed and was lost.
--
-- This table makes storage independent of how a client batches: the ingest worker
-- ADDS each counter into the row for its key instead of inserting a new row, so a
-- machine that uploads the same counter 80,000 times still owns one row. Same
-- fields as the `usage_rollup` props plus the envelope the rollup breaks down by;
-- nothing new is collected.
--
-- Every key column is NOT NULL with '' for "absent": a primary key treats NULLs as
-- distinct, which would quietly turn the upsert back into an insert. The envelope
-- columns are in the key so a machine that upgrades mid-day keeps exact per-version
-- counts. Purged at the same retention window as `events`.
CREATE TABLE usage_daily (
  day               TEXT    NOT NULL,          -- UTC YYYY-MM-DD the counts belong to
  machine_id        TEXT    NOT NULL,          -- random UUIDv4, client-minted
  kind              TEXT    NOT NULL,          -- mcp_tool | cli_command
  name              TEXT    NOT NULL,          -- tool or command name
  client_name       TEXT    NOT NULL DEFAULT '',
  client_version    TEXT    NOT NULL DEFAULT '',
  codegraph_version TEXT    NOT NULL DEFAULT '',
  os                TEXT    NOT NULL DEFAULT '',
  arch              TEXT    NOT NULL DEFAULT '',
  node_major        TEXT    NOT NULL DEFAULT '',
  count             INTEGER NOT NULL DEFAULT 0,   -- calls
  error_count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, machine_id, kind, name, client_name, client_version,
               codegraph_version, os, arch, node_major)
) WITHOUT ROWID;
