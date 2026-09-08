-- Seed data for the dashboard's local checks: 12 machines over 10 days
-- (2026-07-01 … 2026-07-10), small enough that every number on every panel can
-- be worked out by hand from the events below and checked against the API.
--
--   npm run seed        (writes the LOCAL .wrangler D1 — never the remote one)
--
-- Only the raw `events` rows are hand-authored. `machine_days`,
-- `machine_first_seen` and the three `daily_*` rollups are DERIVED from them at
-- the bottom of this file by the same aggregations the writers use in
-- telemetry-worker/ (the ingest path and the nightly cron respectively), so the
-- fixture can never drift into a state production could not produce.
--
-- The machines, and what each one does:
--
--   id   first  os      arch   ver    ci  installs  indexes on          uninstalls
--   m01  07-01  darwin  arm64  1.4.0  0   local     07-01, 07-02, 07-04
--   m02  07-01  darwin  arm64  1.4.0  0   global    07-01
--   m03  07-01  linux   x64    1.4.0  0   local     07-03
--   m04  07-01  win32   x64    1.4.0  0   local     never               07-06
--   m05  07-02  darwin  arm64  1.4.0  0   local     07-02
--   m06  07-02  linux   x64    1.4.1  0   local     never               07-07
--   m07  07-03  darwin  x64    1.4.1  0   local     07-03
--   m08  07-05  linux   arm64  1.5.0  0   global    07-06
--   m09  07-05  win32   x64    1.5.0  0   local     07-05, 07-07
--   m10  07-08  darwin  arm64  1.5.0  0   local     07-08
--   m11  07-09  linux   x64    1.5.0  0   local     07-10
--   m12  07-09  linux   x64    1.5.0  1   global    07-09              (CI runner)
--
-- m04 and m06 never index: they are the two machines the activation funnel is
-- supposed to lose (12 installs → 10 activated → 83.3%). m12 is the one CI
-- machine, so "production users" is 11 where "active machines" is 12.

DELETE FROM daily_dim_counts;
DELETE FROM daily_event_counts;
DELETE FROM daily_machines;
DELETE FROM machine_days;
DELETE FROM machine_first_seen;
DELETE FROM events;

-- ---------------------------------------------------------------------------
-- install — 12, one per machine on its first day
-- ---------------------------------------------------------------------------
INSERT INTO events (received_at, ts, day, event, machine_id, codegraph_version, os, arch, node_major, ci, schema_version, props)
VALUES
 ('2026-07-01T09:00:00Z','2026-07-01T09:00:00Z','2026-07-01','install','00000000-0000-4000-8000-000000000001','1.4.0','darwin','arm64',22,0,2,'{"scope":"local","kind":"fresh","targets":["claude","cursor"]}'),
 ('2026-07-01T09:05:00Z','2026-07-01T09:05:00Z','2026-07-01','install','00000000-0000-4000-8000-000000000002','1.4.0','darwin','arm64',22,0,2,'{"scope":"global","kind":"fresh","targets":["claude"]}'),
 ('2026-07-01T10:00:00Z','2026-07-01T10:00:00Z','2026-07-01','install','00000000-0000-4000-8000-000000000003','1.4.0','linux','x64',20,0,2,'{"scope":"local","kind":"fresh","targets":["codex"]}'),
 ('2026-07-01T11:00:00Z','2026-07-01T11:00:00Z','2026-07-01','install','00000000-0000-4000-8000-000000000004','1.4.0','win32','x64',22,0,2,'{"scope":"local","kind":"fresh","targets":["claude","opencode"]}'),
 ('2026-07-02T09:00:00Z','2026-07-02T09:00:00Z','2026-07-02','install','00000000-0000-4000-8000-000000000005','1.4.0','darwin','arm64',22,0,2,'{"scope":"local","kind":"fresh","targets":["claude"]}'),
 ('2026-07-02T14:00:00Z','2026-07-02T14:00:00Z','2026-07-02','install','00000000-0000-4000-8000-000000000006','1.4.1','linux','x64',20,0,2,'{"scope":"local","kind":"fresh","targets":["cursor"]}'),
 ('2026-07-03T08:00:00Z','2026-07-03T08:00:00Z','2026-07-03','install','00000000-0000-4000-8000-000000000007','1.4.1','darwin','x64',22,0,2,'{"scope":"local","kind":"upgrade","targets":["claude"]}'),
 ('2026-07-05T08:00:00Z','2026-07-05T08:00:00Z','2026-07-05','install','00000000-0000-4000-8000-000000000008','1.5.0','linux','arm64',22,0,2,'{"scope":"global","kind":"fresh","targets":["claude","codex"]}'),
 ('2026-07-05T09:00:00Z','2026-07-05T09:00:00Z','2026-07-05','install','00000000-0000-4000-8000-000000000009','1.5.0','win32','x64',22,0,2,'{"scope":"local","kind":"fresh","targets":["claude"]}'),
 ('2026-07-08T08:00:00Z','2026-07-08T08:00:00Z','2026-07-08','install','00000000-0000-4000-8000-000000000010','1.5.0','darwin','arm64',22,0,2,'{"scope":"local","kind":"fresh","targets":["cursor"]}'),
 ('2026-07-09T08:00:00Z','2026-07-09T08:00:00Z','2026-07-09','install','00000000-0000-4000-8000-000000000011','1.5.0','linux','x64',22,0,2,'{"scope":"local","kind":"fresh","targets":["claude"]}'),
 ('2026-07-09T08:30:00Z','2026-07-09T08:30:00Z','2026-07-09','install','00000000-0000-4000-8000-000000000012','1.5.0','linux','x64',22,1,2,'{"scope":"global","kind":"fresh","targets":["claude"]}');

-- ---------------------------------------------------------------------------
-- index — 13 runs
--   languages        typescript 7 · javascript 2 · python 2 · go 2 · rust 2 · csharp 2 · java 1  (18 rows)
--   file_count_bucket  <100 2 · 100-1k 5 · 1k-10k 4 · 10k+ 2
--   duration_bucket    <10s 5 · 10-60s 4 · 1-5m 2 · 5m+ 2
-- ---------------------------------------------------------------------------
INSERT INTO events (received_at, ts, day, event, machine_id, codegraph_version, os, arch, node_major, ci, schema_version, props)
VALUES
 ('2026-07-01T09:10:00Z','2026-07-01T09:10:00Z','2026-07-01','index','00000000-0000-4000-8000-000000000001','1.4.0','darwin','arm64',22,0,2,'{"languages":["typescript","javascript"],"file_count_bucket":"100-1k","duration_bucket":"<10s"}'),
 ('2026-07-01T09:20:00Z','2026-07-01T09:20:00Z','2026-07-01','index','00000000-0000-4000-8000-000000000002','1.4.0','darwin','arm64',22,0,2,'{"languages":["typescript"],"file_count_bucket":"<100","duration_bucket":"<10s"}'),
 ('2026-07-02T10:00:00Z','2026-07-02T10:00:00Z','2026-07-02','index','00000000-0000-4000-8000-000000000001','1.4.0','darwin','arm64',22,0,2,'{"languages":["typescript","javascript"],"file_count_bucket":"100-1k","duration_bucket":"10-60s"}'),
 ('2026-07-02T11:00:00Z','2026-07-02T11:00:00Z','2026-07-02','index','00000000-0000-4000-8000-000000000005','1.4.0','darwin','arm64',22,0,2,'{"languages":["python"],"file_count_bucket":"1k-10k","duration_bucket":"10-60s"}'),
 ('2026-07-03T09:00:00Z','2026-07-03T09:00:00Z','2026-07-03','index','00000000-0000-4000-8000-000000000003','1.4.0','linux','x64',20,0,2,'{"languages":["go"],"file_count_bucket":"100-1k","duration_bucket":"<10s"}'),
 ('2026-07-03T10:00:00Z','2026-07-03T10:00:00Z','2026-07-03','index','00000000-0000-4000-8000-000000000007','1.4.1','darwin','x64',22,0,2,'{"languages":["typescript","rust"],"file_count_bucket":"10k+","duration_bucket":"5m+"}'),
 ('2026-07-04T10:00:00Z','2026-07-04T10:00:00Z','2026-07-04','index','00000000-0000-4000-8000-000000000001','1.4.0','darwin','arm64',22,0,2,'{"languages":["typescript"],"file_count_bucket":"100-1k","duration_bucket":"<10s"}'),
 ('2026-07-05T09:30:00Z','2026-07-05T09:30:00Z','2026-07-05','index','00000000-0000-4000-8000-000000000009','1.5.0','win32','x64',22,0,2,'{"languages":["csharp"],"file_count_bucket":"1k-10k","duration_bucket":"1-5m"}'),
 ('2026-07-06T09:00:00Z','2026-07-06T09:00:00Z','2026-07-06','index','00000000-0000-4000-8000-000000000008','1.5.0','linux','arm64',22,0,2,'{"languages":["rust","go"],"file_count_bucket":"1k-10k","duration_bucket":"1-5m"}'),
 ('2026-07-07T09:00:00Z','2026-07-07T09:00:00Z','2026-07-07','index','00000000-0000-4000-8000-000000000009','1.5.0','win32','x64',22,0,2,'{"languages":["csharp"],"file_count_bucket":"1k-10k","duration_bucket":"10-60s"}'),
 ('2026-07-08T08:10:00Z','2026-07-08T08:10:00Z','2026-07-08','index','00000000-0000-4000-8000-000000000010','1.5.0','darwin','arm64',22,0,2,'{"languages":["typescript"],"file_count_bucket":"<100","duration_bucket":"<10s"}'),
 ('2026-07-09T09:00:00Z','2026-07-09T09:00:00Z','2026-07-09','index','00000000-0000-4000-8000-000000000012','1.5.0','linux','x64',22,1,2,'{"languages":["java"],"file_count_bucket":"10k+","duration_bucket":"5m+"}'),
 ('2026-07-10T09:00:00Z','2026-07-10T09:00:00Z','2026-07-10','index','00000000-0000-4000-8000-000000000011','1.5.0','linux','x64',22,0,2,'{"languages":["python","typescript"],"file_count_bucket":"100-1k","duration_bucket":"10-60s"}');

-- ---------------------------------------------------------------------------
-- uninstall — 2
-- ---------------------------------------------------------------------------
INSERT INTO events (received_at, ts, day, event, machine_id, codegraph_version, os, arch, node_major, ci, schema_version, props)
VALUES
 ('2026-07-06T12:00:00Z','2026-07-06T12:00:00Z','2026-07-06','uninstall','00000000-0000-4000-8000-000000000004','1.4.0','win32','x64',22,0,2,'{"targets":["claude","opencode"]}'),
 ('2026-07-07T12:00:00Z','2026-07-07T12:00:00Z','2026-07-07','uninstall','00000000-0000-4000-8000-000000000006','1.4.1','linux','x64',20,0,2,'{"targets":["cursor"]}');

-- ---------------------------------------------------------------------------
-- usage_rollup — 5 rows, 85 calls (the `count` prop is summed, never the rows)
--   codegraph_explore 82 · index 3   |   Claude Code 70 · Cursor 12
-- ---------------------------------------------------------------------------
INSERT INTO events (received_at, ts, day, event, machine_id, codegraph_version, os, arch, node_major, ci, schema_version, props)
VALUES
 ('2026-07-03T02:00:00Z','2026-07-02T12:00:00Z','2026-07-02','usage_rollup','00000000-0000-4000-8000-000000000001','1.4.0','darwin','arm64',22,0,2,'{"kind":"mcp_tool","name":"codegraph_explore","count":40,"error_count":1,"client_name":"Claude Code"}'),
 ('2026-07-04T02:00:00Z','2026-07-03T12:00:00Z','2026-07-03','usage_rollup','00000000-0000-4000-8000-000000000001','1.4.0','darwin','arm64',22,0,2,'{"kind":"mcp_tool","name":"codegraph_explore","count":25,"client_name":"Claude Code"}'),
 ('2026-07-04T02:00:00Z','2026-07-03T12:00:00Z','2026-07-03','usage_rollup','00000000-0000-4000-8000-000000000005','1.4.0','darwin','arm64',22,0,2,'{"kind":"cli_command","name":"index","count":3}'),
 ('2026-07-07T02:00:00Z','2026-07-06T12:00:00Z','2026-07-06','usage_rollup','00000000-0000-4000-8000-000000000009','1.5.0','win32','x64',22,0,2,'{"kind":"mcp_tool","name":"codegraph_explore","count":12,"client_name":"Cursor"}'),
 ('2026-07-11T02:00:00Z','2026-07-10T12:00:00Z','2026-07-10','usage_rollup','00000000-0000-4000-8000-000000000011','1.5.0','linux','x64',22,0,2,'{"kind":"mcp_tool","name":"codegraph_explore","count":5,"client_name":"Claude Code"}');

-- ---------------------------------------------------------------------------
-- Derived: what the ingest worker writes on every batch
-- ---------------------------------------------------------------------------
-- prod is 0 only when EVERY event a machine sent that day carried ci = 1, which
-- is what makes m12 the only non-production machine-day.
INSERT INTO machine_days (machine_id, day, prod)
SELECT machine_id, day, max(CASE WHEN ci = 1 THEN 0 ELSE 1 END) FROM events GROUP BY machine_id, day;

INSERT INTO machine_first_seen (machine_id, first_day)
SELECT machine_id, min(day) FROM events GROUP BY machine_id;

-- ---------------------------------------------------------------------------
-- Derived: what the nightly cron writes
-- ---------------------------------------------------------------------------
-- These mirror ROLLUP_STATEMENTS in telemetry-worker/src/rollup.ts, with the
-- single-day filter dropped so one pass seeds the whole fixture range.

INSERT INTO daily_machines (day, machines, prod_machines)
SELECT day, count(*), coalesce(sum(prod), 0) FROM machine_days GROUP BY day;

INSERT INTO daily_event_counts (day, event, count, machines)
SELECT day, event,
       CASE WHEN event = 'usage_rollup'
            THEN sum(coalesce(json_extract(props, '$.count'), 0))
            ELSE count(*) END,
       count(DISTINCT machine_id)
  FROM events GROUP BY day, event;

-- Envelope dimensions — carried by every event.
INSERT INTO daily_dim_counts (day, event, dim, value, count, machines)
SELECT day, event, 'os', CAST(os AS TEXT),
       CASE WHEN event = 'usage_rollup' THEN sum(coalesce(json_extract(props, '$.count'), 0)) ELSE count(*) END,
       count(DISTINCT machine_id)
  FROM events WHERE os IS NOT NULL AND os <> '' GROUP BY day, event, os;

INSERT INTO daily_dim_counts (day, event, dim, value, count, machines)
SELECT day, event, 'arch', CAST(arch AS TEXT),
       CASE WHEN event = 'usage_rollup' THEN sum(coalesce(json_extract(props, '$.count'), 0)) ELSE count(*) END,
       count(DISTINCT machine_id)
  FROM events WHERE arch IS NOT NULL AND arch <> '' GROUP BY day, event, arch;

INSERT INTO daily_dim_counts (day, event, dim, value, count, machines)
SELECT day, event, 'codegraph_version', CAST(codegraph_version AS TEXT),
       CASE WHEN event = 'usage_rollup' THEN sum(coalesce(json_extract(props, '$.count'), 0)) ELSE count(*) END,
       count(DISTINCT machine_id)
  FROM events WHERE codegraph_version IS NOT NULL AND codegraph_version <> '' GROUP BY day, event, codegraph_version;

INSERT INTO daily_dim_counts (day, event, dim, value, count, machines)
SELECT day, event, 'node_major', CAST(node_major AS TEXT),
       CASE WHEN event = 'usage_rollup' THEN sum(coalesce(json_extract(props, '$.count'), 0)) ELSE count(*) END,
       count(DISTINCT machine_id)
  FROM events WHERE node_major IS NOT NULL GROUP BY day, event, node_major;

-- Event-specific scalar props.
INSERT INTO daily_dim_counts (day, event, dim, value, count, machines)
SELECT day, event, 'file_count_bucket', CAST(json_extract(props, '$.file_count_bucket') AS TEXT), count(*), count(DISTINCT machine_id)
  FROM events WHERE event = 'index' AND json_extract(props, '$.file_count_bucket') IS NOT NULL
 GROUP BY day, event, json_extract(props, '$.file_count_bucket');

INSERT INTO daily_dim_counts (day, event, dim, value, count, machines)
SELECT day, event, 'duration_bucket', CAST(json_extract(props, '$.duration_bucket') AS TEXT), count(*), count(DISTINCT machine_id)
  FROM events WHERE event = 'index' AND json_extract(props, '$.duration_bucket') IS NOT NULL
 GROUP BY day, event, json_extract(props, '$.duration_bucket');

INSERT INTO daily_dim_counts (day, event, dim, value, count, machines)
SELECT day, event, 'scope', CAST(json_extract(props, '$.scope') AS TEXT), count(*), count(DISTINCT machine_id)
  FROM events WHERE event = 'install' AND json_extract(props, '$.scope') IS NOT NULL
 GROUP BY day, event, json_extract(props, '$.scope');

INSERT INTO daily_dim_counts (day, event, dim, value, count, machines)
SELECT day, event, 'kind', CAST(json_extract(props, '$.kind') AS TEXT),
       CASE WHEN event = 'usage_rollup' THEN sum(coalesce(json_extract(props, '$.count'), 0)) ELSE count(*) END,
       count(DISTINCT machine_id)
  FROM events WHERE event IN ('install', 'usage_rollup') AND json_extract(props, '$.kind') IS NOT NULL
 GROUP BY day, event, json_extract(props, '$.kind');

INSERT INTO daily_dim_counts (day, event, dim, value, count, machines)
SELECT day, event, 'name', CAST(json_extract(props, '$.name') AS TEXT),
       sum(coalesce(json_extract(props, '$.count'), 0)), count(DISTINCT machine_id)
  FROM events WHERE event = 'usage_rollup' AND json_extract(props, '$.name') IS NOT NULL
 GROUP BY day, event, json_extract(props, '$.name');

INSERT INTO daily_dim_counts (day, event, dim, value, count, machines)
SELECT day, event, 'client_name', CAST(json_extract(props, '$.client_name') AS TEXT),
       sum(coalesce(json_extract(props, '$.count'), 0)), count(DISTINCT machine_id)
  FROM events WHERE event = 'usage_rollup' AND json_extract(props, '$.client_name') IS NOT NULL
 GROUP BY day, event, json_extract(props, '$.client_name');

-- Array props — one row per element, so a TypeScript+Go repo counts under both.
INSERT INTO daily_dim_counts (day, event, dim, value, count, machines)
SELECT e.day, e.event, 'language', CAST(j.value AS TEXT), count(*), count(DISTINCT e.machine_id)
  FROM events e, json_each(e.props, '$.languages') j
 WHERE e.event = 'index' AND j.value <> ''
 GROUP BY e.day, e.event, j.value;

INSERT INTO daily_dim_counts (day, event, dim, value, count, machines)
SELECT e.day, e.event, 'target', CAST(j.value AS TEXT), count(*), count(DISTINCT e.machine_id)
  FROM events e, json_each(e.props, '$.targets') j
 WHERE e.event IN ('install', 'uninstall') AND j.value <> ''
 GROUP BY e.day, e.event, j.value;

-- Errors per tool: count is errors, machines is the machines that saw one.
INSERT INTO daily_dim_counts (day, event, dim, value, count, machines)
SELECT day, event, 'name_error', CAST(json_extract(props, '$.name') AS TEXT),
       sum(json_extract(props, '$.error_count')), count(DISTINCT machine_id)
  FROM events
 WHERE event = 'usage_rollup' AND json_extract(props, '$.name') IS NOT NULL
   AND coalesce(json_extract(props, '$.error_count'), 0) > 0
 GROUP BY day, event, json_extract(props, '$.name');
