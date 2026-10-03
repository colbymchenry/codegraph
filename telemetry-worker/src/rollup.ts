/**
 * codegraph telemetry — nightly rollup + raw-event retention purge.
 *
 * Public for the same reason the ingest path is: this is every read and every write
 * we make over the stored events, including the one that deletes them.
 *
 * Two jobs, both driven by the cron trigger in wrangler.jsonc (00:30 UTC daily):
 *
 * 1. ROLL UP the just-completed UTC day into `daily_machines`, `daily_event_counts`,
 *    `daily_dim_counts` and `machine_first_seen.first_index_day` — plus the two days
 *    before it, because clients buffer offline and ship completed-day rollups late, so
 *    a day keeps growing after it ends, plus any earlier day a failed run missed. Every
 *    write is an upsert that OVERWRITES the recomputed value rather than adding to it
 *    (or, for first_index_day, only ever lowers it), so re-running a day is a no-op
 *    and never double-counts.
 *
 * 2. PURGE raw `events` past the retention window, in bounded batches. Rollups are
 *    kept forever, so only ad-hoc drill-down has a horizon; `machine_days` and
 *    `machine_first_seen` are never purged, because retention cohorts need the full
 *    history and they are two orders of magnitude smaller than the raw rows.
 *
 * `POST /admin/rollup` re-runs a day (or a short range) on demand for backfill and
 * repair, guarded by the ADMIN_TOKEN secret. Like everything else here it makes no
 * outbound requests — the only thing this worker talks to is its own D1 database.
 */

/** Raw-event retention when RETENTION_DAYS is unset or nonsense. Storage-bound — see README. */
export const DEFAULT_RETENTION_DAYS = 90;
/** The just-completed day, plus the two before it (late offline buffers). */
export const ROLLUP_LOOKBACK_DAYS = 3;
/** Widest range one manual /admin/rollup call will attempt. */
export const MAX_MANUAL_DAYS = 31;
/** Most missed days one nightly run catches up on, newest first; the next night takes the rest. */
export const MAX_CATCHUP_DAYS = 31;

/** Rows per purge DELETE — bounded so one statement stays well inside D1's limits. */
const PURGE_BATCH_ROWS = 5_000;
/** Ceiling on one night's deletions (≈1.5 days of ingest at current volume). */
const PURGE_MAX_BATCHES = 60;

const DAY_MS = 86_400_000;

/** UTC YYYY-MM-DD — the key every event, rollup and chart is bucketed on. */
export function utcDay(atMs: number): string {
  return new Date(atMs).toISOString().slice(0, 10);
}

/** Rejects both the wrong shape and impossible dates (`2026-02-31` round-trips as `2026-03-03`). */
export function isValidDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) && utcDay(t) === day;
}

/** Configured retention, clamped to something sane; falls back to the default. */
export function retentionDays(env: Env): number {
  const raw = Number(env.RETENTION_DAYS);
  return Number.isInteger(raw) && raw >= 1 && raw <= 3650 ? raw : DEFAULT_RETENTION_DAYS;
}

/** Oldest day kept: everything strictly before this is purged. */
export function retentionCutoff(atMs: number, keepDays: number): string {
  return utcDay(atMs - keepDays * DAY_MS);
}

// ---------------------------------------------------------------------------
// The rollup statements
// ---------------------------------------------------------------------------
// One `INSERT … SELECT … ON CONFLICT DO UPDATE` per table or dimension: the whole
// aggregation happens inside D1, so a day rolls up in one round trip and no event
// row ever crosses the wire. Each takes exactly one bound parameter — the day.
//
// Lifecycle events (install / index / uninstall) are one `events` row each, so their
// volume is count(*). Usage is NOT in `events`: the ingest worker adds every
// usage_rollup counter into `usage_daily` (one row per machine × day × tool), so the
// usage figures are sums over that table — its `count` is calls, and counting its
// rows would report "machines that used the tool" instead.
//
// Adding a breakdown is a line in ROLLUP_STATEMENTS, never a migration — that is
// what the generic (dim, value) shape of daily_dim_counts buys.

/** Lifecycle events only; usage comes from `usage_daily`. */
const LIFECYCLE = ` AND e.event <> 'usage_rollup'`;

const DIM_CONFLICT = `ON CONFLICT (day, event, dim, value) DO UPDATE
     SET count = excluded.count, machines = excluded.machines`;

const prop = (name: string): string => `json_extract(e.props, '$.${name}')`;
const quoted = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(', ');
const onlyEvents = (...events: readonly string[]): string => ` AND e.event IN (${quoted(events)})`;

/** One dimension whose value is a scalar column or a scalar prop. */
function dimStatement(dim: string, value: string, where = LIFECYCLE): string {
  return `INSERT INTO daily_dim_counts (day, event, dim, value, count, machines)
   SELECT e.day, e.event, '${dim}', CAST(${value} AS TEXT), count(*), count(DISTINCT e.machine_id)
     FROM events e
    WHERE e.day = ? AND ${value} IS NOT NULL AND ${value} <> ''${where}
    GROUP BY e.day, e.event, ${value}
   ${DIM_CONFLICT}`;
}

/**
 * One usage dimension, from a `usage_daily` column. Absent values are stored as ''
 * (they are part of the primary key), so '' is what gets skipped. `where` narrows
 * the rows further — name_error keeps only counters that saw an error.
 */
function usageDimStatement(dim: string, column: string, total = 'count', where = ''): string {
  return `INSERT INTO daily_dim_counts (day, event, dim, value, count, machines)
   SELECT day, 'usage_rollup', '${dim}', ${column}, sum(${total}), count(DISTINCT machine_id)
     FROM usage_daily
    WHERE day = ? AND ${column} <> ''${where}
    GROUP BY day, ${column}
   ${DIM_CONFLICT}`;
}

/**
 * One dimension unnested from a JSON array prop — one row per element, so an index
 * of a TypeScript+Go repo counts once under each language. `json_each` over a path
 * the props do not have yields no rows, which is exactly the wanted behaviour for
 * events that omit the array.
 */
function arrayDimStatement(dim: string, path: string, events: readonly string[]): string {
  return `INSERT INTO daily_dim_counts (day, event, dim, value, count, machines)
   SELECT e.day, e.event, '${dim}', CAST(j.value AS TEXT), count(*), count(DISTINCT e.machine_id)
     FROM events e, json_each(e.props, '${path}') j
    WHERE e.day = ? AND e.event IN (${quoted(events)}) AND j.value <> ''
    GROUP BY e.day, e.event, j.value
   ${DIM_CONFLICT}`;
}

/**
 * Rebuilt from `machine_days`, not from `events`: that table is never purged, so this
 * number stays right for days whose raw rows are long gone. `prod` is already the
 * per-machine-day maximum the ingest path maintains (0 only if every event that
 * machine sent that day carried ci = 1).
 *
 * So this is also the one rollup that can still be rebuilt for a day whose raw events
 * are long gone.
 */
const DAILY_MACHINES = `INSERT INTO daily_machines (day, machines, prod_machines)
   SELECT day, count(*), coalesce(sum(prod), 0) FROM machine_days WHERE day = ? GROUP BY day
   ON CONFLICT (day) DO UPDATE
     SET machines = excluded.machines, prod_machines = excluded.prod_machines`;

/**
 * The activation funnel's input: each machine's first index day, lowered to this day
 * if the machine indexed on it and has no earlier index on record. The dashboard reads
 * it straight off `machine_first_seen`, which keeps the funnel off raw `events` (a
 * cohort join there took most of a minute per week of cohorts) and past the purge.
 *
 * Only rows that actually move are written, so re-running a day is free. `?1` is the
 * day — still the one bound parameter, used three times.
 */
const FIRST_INDEX_DAY = `UPDATE machine_first_seen
   SET first_index_day = ?1
 WHERE (first_index_day IS NULL OR first_index_day > ?1)
   AND machine_id IN (SELECT machine_id FROM events WHERE day = ?1 AND event = 'index')`;

const ROLLUP_STATEMENTS: readonly string[] = [
  DAILY_MACHINES,
  FIRST_INDEX_DAY,

  `INSERT INTO daily_event_counts (day, event, count, machines)
   SELECT e.day, e.event, count(*), count(DISTINCT e.machine_id)
     FROM events e
    WHERE e.day = ?${LIFECYCLE}
    GROUP BY e.day, e.event
   ON CONFLICT (day, event) DO UPDATE
     SET count = excluded.count, machines = excluded.machines`,
  `INSERT INTO daily_event_counts (day, event, count, machines)
   SELECT day, 'usage_rollup', sum(count), count(DISTINCT machine_id)
     FROM usage_daily
    WHERE day = ?
    GROUP BY day
   ON CONFLICT (day, event) DO UPDATE
     SET count = excluded.count, machines = excluded.machines`,

  // Envelope dimensions — every event type carries them.
  dimStatement('os', 'e.os'),
  dimStatement('arch', 'e.arch'),
  dimStatement('codegraph_version', 'e.codegraph_version'),
  dimStatement('node_major', 'e.node_major'),
  usageDimStatement('os', 'os'),
  usageDimStatement('arch', 'arch'),
  usageDimStatement('codegraph_version', 'codegraph_version'),
  usageDimStatement('node_major', 'node_major'),

  // Event-specific scalar props.
  dimStatement('file_count_bucket', prop('file_count_bucket'), onlyEvents('index')),
  dimStatement('duration_bucket', prop('duration_bucket'), onlyEvents('index')),
  dimStatement('scope', prop('scope'), onlyEvents('install')),
  // `kind` is fresh/upgrade/reinstall on install and mcp_tool/cli_command on
  // usage_rollup; `event` is part of the primary key, so both live here without colliding.
  dimStatement('kind', prop('kind'), onlyEvents('install')),
  usageDimStatement('kind', 'kind'),
  usageDimStatement('name', 'name'),
  usageDimStatement('client_name', 'client_name'),

  // Array props.
  arrayDimStatement('language', '$.languages', ['index']),
  arrayDimStatement('target', '$.targets', ['install', 'uninstall']),

  // Errors per tool/command. Not in the migration's documented dim list because dims
  // are a cron concern rather than a schema one, but rolled up because it is the one
  // usage number that is gone for good after the purge. Only counters with at least
  // one error count, so `count` is errors and `machines` is the machines that saw one
  // — NOT the machines that ran the tool (that is the `name` dim).
  usageDimStatement('name_error', 'name', 'error_count', ' AND error_count > 0'),
];

/** Rollup tables derived from raw `events` / `usage_daily` — the ones `reset` wipes before recomputing. */
const EVENT_DERIVED_TABLES = ['daily_event_counts', 'daily_dim_counts'] as const;

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

export interface DayResult {
  day: string;
  /** Rollup rows written for the day. */
  rows: number;
  /** Day is past the retention window — a `reset` on it is ignored (see below). */
  pastRetention: boolean;
}

/**
 * Recompute every rollup for one UTC day. One D1 `batch()` = one implicit
 * transaction, so a day is either fully recomputed or not touched at all.
 *
 * Plain (upsert-only) runs are safe on any day: a day whose raw events are already
 * purged selects nothing, so nothing is written and the rollups it earned while the
 * events were still around survive untouched. That is what keeps rollups permanent.
 *
 * `reset` drops the day's event-derived rollup rows first instead of upserting over
 * them — repair for when the dimension list itself changes and a value that no longer
 * exists would otherwise linger. It is IGNORED past the retention window, where it
 * would delete rows and then find no events to rebuild them from: silently blanking a
 * real day is the one irreversible thing this file could do.
 */
export async function rollupDay(
  env: Env,
  day: string,
  opts: { cutoff: string; reset?: boolean },
): Promise<DayResult> {
  const pastRetention = day < opts.cutoff;
  await foldLegacyUsage(env, day);
  const statements: D1PreparedStatement[] = [];

  if (opts.reset && !pastRetention) {
    for (const table of EVENT_DERIVED_TABLES) {
      statements.push(env.DB.prepare(`DELETE FROM ${table} WHERE day = ?`).bind(day));
    }
  }
  for (const sql of ROLLUP_STATEMENTS) {
    statements.push(env.DB.prepare(sql).bind(day));
  }

  const results = await env.DB.batch(statements);
  const rows = results.reduce((total, r) => total + (r.meta?.changes ?? 0), 0);
  return { day, rows, pastRetention };
}

// ---------------------------------------------------------------------------
// Legacy usage rows
// ---------------------------------------------------------------------------
// Before migrations/0003, every usage_rollup event was its own `events` row — about
// 3.8M a day by August 2026, because clients upload a counter per process rather
// than per day, and enough to fill the database. These statements fold one day's
// worth of those rows into `usage_daily`, adding counts the same way the ingest path
// does, and delete them in the same transaction, so a count is never in both places
// and never in neither. rollupDay runs it first, which makes re-running the rollup
// over old days the whole migration; once a day has no legacy rows left it costs
// one indexed probe.

/** Rows folded per transaction — bounded so one GROUP BY + DELETE stays well inside D1's limits. */
const LEGACY_CHUNK_ROWS = 50_000;
/** Ceiling per day (the worst day on record had ~3.9M rows). */
const LEGACY_MAX_CHUNKS = 200;

const LEGACY_FOLD = `INSERT INTO usage_daily (
    day, machine_id, kind, name, client_name, client_version,
    codegraph_version, os, arch, node_major, count, error_count)
  SELECT day, machine_id,
         coalesce(json_extract(props, '$.kind'), ''),
         coalesce(json_extract(props, '$.name'), ''),
         coalesce(json_extract(props, '$.client_name'), ''),
         coalesce(json_extract(props, '$.client_version'), ''),
         coalesce(codegraph_version, ''), coalesce(os, ''), coalesce(arch, ''),
         coalesce(CAST(node_major AS TEXT), ''),
         sum(coalesce(json_extract(props, '$.count'), 0)),
         sum(coalesce(json_extract(props, '$.error_count'), 0))
    FROM events
   WHERE day = ?1 AND event = 'usage_rollup' AND id < ?2
   GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
  ON CONFLICT (day, machine_id, kind, name, client_name, client_version, codegraph_version, os, arch, node_major)
  DO UPDATE SET count = usage_daily.count + excluded.count,
                error_count = usage_daily.error_count + excluded.error_count`;

const LEGACY_DELETE = `DELETE FROM events WHERE day = ?1 AND event = 'usage_rollup' AND id < ?2`;

/** Folds any legacy usage rows for `day` into usage_daily. Returns how many rows it moved. */
export async function foldLegacyUsage(env: Env, day: string): Promise<number> {
  const any = await env.DB.prepare(`SELECT 1 AS hit FROM events WHERE day = ? AND event = 'usage_rollup' LIMIT 1`)
    .bind(day)
    .first<{ hit: number }>();
  if (!any) return 0;

  let moved = 0;
  for (let chunk = 0; chunk < LEGACY_MAX_CHUNKS; chunk++) {
    // Always the oldest remaining rows: everything below the next chunk's first id.
    // Rows folded by earlier chunks are gone, so there is no cursor to carry.
    const next = await env.DB.prepare(
      `SELECT id FROM events WHERE day = ? AND event = 'usage_rollup' ORDER BY id LIMIT 1 OFFSET ${LEGACY_CHUNK_ROWS}`,
    )
      .bind(day)
      .first<{ id: number }>();
    const below = next?.id ?? Number.MAX_SAFE_INTEGER;
    const [, deleted] = await env.DB.batch([
      env.DB.prepare(LEGACY_FOLD).bind(day, below),
      env.DB.prepare(LEGACY_DELETE).bind(day, below),
    ]);
    moved += deleted?.meta?.changes ?? 0;
    if (!next) return moved;
  }
  throw new Error(`legacy usage fold for ${day} did not finish within ${LEGACY_MAX_CHUNKS} chunks`);
}

export interface PurgeResult {
  /** Everything strictly before this day was deleted. */
  cutoff: string;
  deleted: number;
  /** usage_daily rows past the window — per-machine counters, so they expire with the events. */
  usageDeleted: number;
  batches: number;
  /** Hit the per-run batch ceiling — more rows are still due, next run takes them. */
  capped: boolean;
}

/**
 * Delete raw events older than the window, oldest first, in bounded batches, then
 * the usage counters older than it, a day per statement (`usage_daily` is keyed by
 * day first, so each is one primary-key range). `id` is a rowid alias and the purge
 * only ever removes the oldest rows, so the keyset subquery stays a cheap index range
 * scan on (day, event).
 */
export async function purgeOldEvents(env: Env, cutoff: string): Promise<PurgeResult> {
  const del = env.DB.prepare(
    `DELETE FROM events WHERE id IN (SELECT id FROM events WHERE day < ? LIMIT ${PURGE_BATCH_ROWS})`,
  );
  let deleted = 0;
  let batches = 0;
  let capped = true;
  while (batches < PURGE_MAX_BATCHES) {
    batches++;
    const { meta } = await del.bind(cutoff).run();
    const removed = meta?.changes ?? 0;
    deleted += removed;
    if (removed < PURGE_BATCH_ROWS) {
      capped = false;
      break;
    }
  }

  const delUsageDay = env.DB.prepare(
    `DELETE FROM usage_daily WHERE day = (SELECT min(day) FROM usage_daily WHERE day < ?)`,
  );
  let usageDeleted = 0;
  for (let day = 0; day < PURGE_MAX_BATCHES; day++) {
    const { meta } = await delUsageDay.bind(cutoff).run();
    const removed = meta?.changes ?? 0;
    if (removed === 0) break;
    usageDeleted += removed;
  }
  return { cutoff, deleted, usageDeleted, batches, capped };
}

/**
 * Days that saw activity but never got a rollup: the nights a run failed, or the
 * database refused writes. Every active day has `machine_days` rows and every
 * rolled-up day has a `daily_machines` row, so the difference is exactly the missed
 * days — a day nobody was active on is in neither, and needs nothing.
 *
 * Without this, the cron only ever looks three days back, so one bad week leaves a
 * permanent hole that someone has to notice and backfill by hand. Bounded below by
 * the retention cutoff, past which the raw events are gone and there is nothing left
 * to roll up.
 */
async function missedDays(env: Env, cutoff: string, before: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT day FROM machine_days
      WHERE day >= ? AND day < ?
        AND day NOT IN (SELECT day FROM daily_machines)
      ORDER BY day DESC
      LIMIT ${MAX_CATCHUP_DAYS}`,
  )
    .bind(cutoff, before)
    .all<{ day: string }>();
  return results.map((r) => r.day);
}

/**
 * The cron body: roll up the completed day and the two before it, catch up any
 * earlier day a past run missed, then purge.
 *
 * Logs one line of counts — never a day's contents, never a machine id. Throws if
 * anything failed so the invocation is marked failed (and retried) rather than
 * quietly skipping a day; every write here is idempotent, so a retry is safe.
 */
export async function runNightly(env: Env, atMs: number): Promise<void> {
  const started = Date.now();
  const keepDays = retentionDays(env);
  const cutoff = retentionCutoff(atMs, keepDays);

  const days: string[] = [];
  for (let back = 1; back <= ROLLUP_LOOKBACK_DAYS; back++) days.push(utcDay(atMs - back * DAY_MS));

  // A failure to find the missed days must not cost tonight's regular rollup.
  let caughtUp = 0;
  try {
    const missed = await missedDays(env, cutoff, days[days.length - 1] ?? utcDay(atMs));
    days.push(...missed);
    caughtUp = missed.length;
  } catch (err) {
    console.error(JSON.stringify({ msg: 'missed-day scan failed', err: String(err) }));
  }

  const rolled: string[] = [];
  const failed: string[] = [];
  let rows = 0;
  for (const day of days) {
    try {
      rows += (await rollupDay(env, day, { cutoff })).rows;
      rolled.push(day);
    } catch (err) {
      failed.push(day);
      console.error(JSON.stringify({ msg: 'rollup day failed', day, err: String(err) }));
    }
  }

  let purge: PurgeResult | null = null;
  try {
    purge = await purgeOldEvents(env, cutoff);
  } catch (err) {
    console.error(JSON.stringify({ msg: 'purge failed', cutoff, err: String(err) }));
  }

  console.log(
    JSON.stringify({
      msg: 'nightly rollup',
      days: rolled,
      caught_up: caughtUp,
      rows,
      failed: failed.length,
      retention_days: keepDays,
      purged_before: cutoff,
      purged: purge?.deleted ?? null,
      usage_purged: purge?.usageDeleted ?? null,
      purge_batches: purge?.batches ?? null,
      purge_capped: purge?.capped ?? null,
      ms: Date.now() - started,
    }),
  );

  if (failed.length > 0 || purge === null) {
    throw new Error(`nightly rollup incomplete: ${failed.length} day(s) failed, purge ${purge ? 'ok' : 'failed'}`);
  }
}

// ---------------------------------------------------------------------------
// POST /admin/rollup — manual backfill / repair
// ---------------------------------------------------------------------------

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/** Constant-time over digests, so neither the length nor a prefix of the token leaks. */
async function tokenMatches(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/**
 * `POST /admin/rollup?day=YYYY-MM-DD[&days=N][&reset=1]`, header `x-admin-token`.
 *
 * Re-runs the rollup for `day` (default: yesterday), or for the `N` days ending on it.
 * Exists so a backfill or a repair never needs a redeploy. It only ever recomputes
 * aggregates from stored rows — there is no path here that deletes raw events; the
 * purge runs on the cron and nowhere else.
 */
export async function handleAdminRollup(request: Request, env: Env, url: URL): Promise<Response> {
  // No secret configured ⇒ no admin surface at all, and nothing that hints there is one.
  const expected = env.ADMIN_TOKEN;
  if (typeof expected !== 'string' || expected.length === 0) {
    return new Response('not found\n', { status: 404 });
  }
  if (request.method !== 'POST') {
    return new Response('method not allowed\n', { status: 405, headers: { allow: 'POST' } });
  }

  if (!(await tokenMatches(request.headers.get('x-admin-token') ?? '', expected))) {
    // Cap how fast the token can be guessed at. Only failures spend the budget, so a
    // chunked backfill loop is never throttled. Best-effort and fails open like the
    // ingest limiter — the token itself is the guard, this only slows a guesser down.
    try {
      const { success } = await env.ADMIN_RATE_LIMITER.limit({ key: 'admin' });
      if (!success) return new Response('rate limited\n', { status: 429 });
    } catch (err) {
      console.error(JSON.stringify({ msg: 'rate limiter unavailable', err: String(err) }));
    }
    return new Response('unauthorized\n', { status: 401 });
  }

  const now = Date.now();
  const day = url.searchParams.get('day') ?? utcDay(now - DAY_MS);
  if (!isValidDay(day)) return json({ error: 'day must be YYYY-MM-DD' }, 400);

  const requested = url.searchParams.get('days');
  const span = requested === null ? 1 : Number(requested);
  if (!Number.isInteger(span) || span < 1 || span > MAX_MANUAL_DAYS) {
    return json({ error: `days must be an integer between 1 and ${MAX_MANUAL_DAYS}` }, 400);
  }

  const reset = url.searchParams.get('reset') === '1';
  const cutoff = retentionCutoff(now, retentionDays(env));
  const endMs = Date.parse(`${day}T00:00:00Z`);

  const days: DayResult[] = [];
  try {
    for (let back = span - 1; back >= 0; back--) {
      days.push(await rollupDay(env, utcDay(endMs - back * DAY_MS), { cutoff, reset }));
    }
  } catch (err) {
    console.error(JSON.stringify({ msg: 'manual rollup failed', through: day, err: String(err) }));
    return json({ error: 'rollup failed', through: day, completed: days }, 500);
  }

  const rows = days.reduce((total, d) => total + d.rows, 0);
  // A day past the window kept its rollups but ignored the reset — say so rather than
  // reporting a repair that did not happen.
  const resetIgnored = reset ? days.filter((d) => d.pastRetention).map((d) => d.day) : [];
  console.log(
    JSON.stringify({
      msg: 'manual rollup',
      through: day,
      days: span,
      reset,
      reset_ignored: resetIgnored.length,
      rows,
      ms: Date.now() - now,
    }),
  );
  return json({ ok: true, through: day, retention_cutoff: cutoff, rows, reset_ignored: resetIgnored, days });
}
