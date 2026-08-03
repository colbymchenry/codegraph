/**
 * The dashboard's read API: one JSON endpoint per chart shape, all of them
 * scoped by the same `?from=&to=` range the picker drives.
 *
 * Rules this file keeps:
 * - **Rollups first.** Every panel is answered from `daily_*` / `machine_days`,
 *   which are kept forever. Only the activation funnel touches raw `events`,
 *   because "did this machine ever run an index" is not a daily aggregate — and
 *   that is also the only endpoint with a horizon (the retention window).
 * - **Parameterized, always.** No value from the query string is ever
 *   concatenated into SQL. Dimensions and metrics are looked up in the tables
 *   below and rejected with a 400 if they are not there, so even the column
 *   *names* a caller can reach are a closed set.
 * - **Chart-shaped.** Responses come back as `labels[] + datasets[]` so the
 *   frontend does no arithmetic; every response also carries `rows` in its
 *   natural shape, which is what the per-panel table view renders.
 * - **No Response objects.** Handlers return plain data and let src/index.ts
 *   apply the security headers, so there is exactly one place where headers on
 *   an authenticated response are decided.
 */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** A year of daily points is already more than the charts can draw legibly. */
const MAX_RANGE_DAYS = 366;
const DEFAULT_RANGE_DAYS = 30;

/**
 * Retention curve length. Two weeks covers the day-1 and day-7 cliffs where nearly
 * all churn happens, and matches the window the previous analytics dashboard drew,
 * so the numbers stay comparable across the cutover.
 */
const RETENTION_DAYS = 14;
/** Days a machine gets to run its first index before it counts as churned. */
const DEFAULT_ACTIVATION_WINDOW = 7;
const MAX_ACTIVATION_WINDOW = 30;

/** Bars past this fold into "Other" — see the note on `Other` in breakdown(). */
const DEFAULT_BREAKDOWN_LIMIT = 12;
const MAX_BREAKDOWN_LIMIT = 50;

/** Panels read at most every few minutes; the underlying data moves once a night. */
const CACHE_CONTROL = 'private, max-age=300';

export interface ApiResult {
  body: unknown;
  status?: number;
  /** Omitted ⇒ src/index.ts keeps its `no-store` default. */
  cacheControl?: string;
}

const fail = (error: string, status = 400): ApiResult => ({ body: { error }, status });

/**
 * `noUncheckedIndexedAccess` types every slot of a `batch()` result as possibly
 * undefined. These two keep that out of the query code, which reads better for
 * being about rows rather than about array bounds.
 */
const rowsOf = <T>(result: D1Result | undefined): T[] => (result?.results ?? []) as unknown as T[];
const firstOf = <T>(result: D1Result | undefined): T | undefined => rowsOf<T>(result)[0];

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

const utcDay = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

/** Rejects the wrong shape and impossible dates alike (`2026-02-31` round-trips as March). */
function isValidDay(day: string): boolean {
  if (!DAY_RE.test(day)) return false;
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) && utcDay(t) === day;
}

const dayMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);
const addDays = (day: string, delta: number): string => utcDay(dayMs(day) + delta * DAY_MS);
const daysApart = (from: string, to: string): number => Math.round((dayMs(to) - dayMs(from)) / DAY_MS);

export interface Range {
  from: string;
  to: string;
  /** Inclusive length. */
  days: number;
  /** The request asked for more than MAX_RANGE_DAYS and `from` was moved up. */
  clamped: boolean;
}

/**
 * The range every endpoint shares. Absent params default to the last 30 days
 * ending today so a bare `curl /api/summary` still answers something sensible;
 * the dashboard itself always sends both, anchored on /api/meta's latest day so
 * no chart ends on a day the nightly rollup has not written yet.
 */
function parseRange(url: URL): Range | ApiResult {
  const rawTo = url.searchParams.get('to');
  const rawFrom = url.searchParams.get('from');

  if (rawTo !== null && !isValidDay(rawTo)) return fail('to must be YYYY-MM-DD');
  if (rawFrom !== null && !isValidDay(rawFrom)) return fail('from must be YYYY-MM-DD');

  const to = rawTo ?? utcDay(Date.now());
  const from = rawFrom ?? addDays(to, -(DEFAULT_RANGE_DAYS - 1));
  if (from > to) return fail('from must not be after to');

  const requested = daysApart(from, to) + 1;
  const clamped = requested > MAX_RANGE_DAYS;
  return {
    from: clamped ? addDays(to, -(MAX_RANGE_DAYS - 1)) : from,
    to,
    days: clamped ? MAX_RANGE_DAYS : requested,
    clamped,
  };
}

const isApiResult = (v: Range | ApiResult): v is ApiResult => 'body' in v;

/** Every day in the range, so a chart's x-axis has no holes where nothing happened. */
function dayList(range: Range): string[] {
  const days: string[] = [];
  for (let i = 0; i < range.days; i++) days.push(addDays(range.from, i));
  return days;
}

/** Turns day-keyed rows into a dense series aligned to `labels`. */
function densify(labels: string[], byDay: Map<string, number>): number[] {
  return labels.map((day) => byDay.get(day) ?? 0);
}

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

type Order = 'value_desc' | 'bucket' | 'version_desc';

interface DimSpec {
  /** Axis/legend label for the values of this dimension. */
  label: string;
  /** Which number the chart plots when the caller does not say. */
  metric: 'machines' | 'count';
  /**
   * Restrict to one event type. Set wherever the same dim is emitted by more
   * than one event and the panel means a specific one — `target` rides both
   * install and uninstall, and "AI agent targets" means the installs.
   */
  event?: string;
  order: Order;
  /** Fixed display order for bucket dims, whose meaning IS their order. */
  buckets?: readonly string[];
}

const FILE_COUNT_BUCKETS = ['<100', '100-1k', '1k-10k', '10k+'] as const;
const DURATION_BUCKETS = ['<10s', '10-60s', '1-5m', '5m+'] as const;

/**
 * The closed set of breakdowns. A dim not in here is a 400, which is what keeps
 * `?dim=` from being a way to ask the database questions of the caller's own design.
 * Values mirror the cron's dimension list (telemetry-worker/src/rollup.ts).
 */
const DIMS: Record<string, DimSpec> = {
  os: { label: 'Operating system', metric: 'machines', order: 'value_desc' },
  arch: { label: 'Architecture', metric: 'machines', order: 'value_desc' },
  codegraph_version: { label: 'Version', metric: 'machines', order: 'version_desc' },
  node_major: { label: 'Node major', metric: 'machines', order: 'version_desc' },
  language: { label: 'Language', metric: 'count', order: 'value_desc' },
  file_count_bucket: {
    label: 'Files in project',
    metric: 'count',
    order: 'bucket',
    buckets: FILE_COUNT_BUCKETS,
  },
  duration_bucket: {
    label: 'Indexing run length',
    metric: 'count',
    order: 'bucket',
    buckets: DURATION_BUCKETS,
  },
  target: { label: 'Agent target', metric: 'count', event: 'install', order: 'value_desc' },
  scope: { label: 'Install scope', metric: 'count', event: 'install', order: 'value_desc' },
  kind: { label: 'Install kind', metric: 'count', event: 'install', order: 'value_desc' },
  name: { label: 'Tool or command', metric: 'count', event: 'usage_rollup', order: 'value_desc' },
  client_name: { label: 'Agent', metric: 'count', event: 'usage_rollup', order: 'value_desc' },
  name_error: { label: 'Tool or command', metric: 'count', event: 'usage_rollup', order: 'value_desc' },
};

/** Newest first, numerically per segment, so 1.10.0 sorts above 1.9.0. */
function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split(/[.-]/);
  const pb = b.split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i]);
    const nb = Number(pb[i]);
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return nb - na;
    } else {
      const sa = pa[i] ?? '';
      const sb = pb[i] ?? '';
      if (sa !== sb) return sb.localeCompare(sa);
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// /api/meta
// ---------------------------------------------------------------------------

interface MetaRow {
  latest_rollup_day: string | null;
  earliest_rollup_day: string | null;
  latest_active_day: string | null;
  earliest_active_day: string | null;
  earliest_raw_day: string | null;
  latest_raw_day: string | null;
}

/**
 * What the picker anchors on. The dashboard asks for this first and ends every
 * default range on `latest_day`, because the nightly cron has not rolled up
 * today yet — anchoring on the wall clock would put a phantom zero on the right
 * edge of every line chart.
 */
async function meta(env: Env): Promise<ApiResult> {
  const row = await env.DB.prepare(
    `SELECT (SELECT max(day) FROM daily_event_counts) AS latest_rollup_day,
            (SELECT min(day) FROM daily_event_counts) AS earliest_rollup_day,
            (SELECT max(day) FROM machine_days)       AS latest_active_day,
            (SELECT min(day) FROM machine_days)       AS earliest_active_day,
            (SELECT min(day) FROM events)             AS earliest_raw_day,
            (SELECT max(day) FROM events)             AS latest_raw_day`,
  ).first<MetaRow>();

  const latest = row?.latest_rollup_day ?? row?.latest_active_day ?? null;
  const earliest = row?.earliest_rollup_day ?? row?.earliest_active_day ?? null;
  return {
    body: {
      latest_day: latest,
      earliest_day: earliest,
      latest_rollup_day: row?.latest_rollup_day ?? null,
      latest_active_day: row?.latest_active_day ?? null,
      /** Below this day the activation funnel is blind — raw events are purged. */
      earliest_raw_day: row?.earliest_raw_day ?? null,
      latest_raw_day: row?.latest_raw_day ?? null,
      max_range_days: MAX_RANGE_DAYS,
      retention_days: RETENTION_DAYS,
      generated_at: new Date().toISOString(),
    },
    cacheControl: CACHE_CONTROL,
  };
}

// ---------------------------------------------------------------------------
// /api/summary — the big numbers
// ---------------------------------------------------------------------------

/**
 * One D1 batch, one round trip. Distinct-machine numbers come from
 * `machine_days` rather than by summing `daily_machines`: a machine active on
 * five days is one user, and summing the daily counts would call it five.
 */
async function summary(env: Env, range: Range): Promise<ApiResult> {
  const { from, to } = range;
  const batch = await env.DB.batch([
    env.DB.prepare(
      `SELECT count(DISTINCT machine_id) AS n FROM machine_days
        WHERE day BETWEEN ? AND ? AND prod = 1`,
    ).bind(from, to),
    env.DB.prepare(
      `SELECT count(DISTINCT machine_id) AS n FROM machine_days WHERE day BETWEEN ? AND ?`,
    ).bind(from, to),
    env.DB.prepare(
      `SELECT count(*) AS n FROM machine_first_seen WHERE first_day BETWEEN ? AND ?`,
    ).bind(from, to),
    env.DB.prepare(
      `SELECT event, sum(count) AS events, sum(machines) AS machines
         FROM daily_event_counts WHERE day BETWEEN ? AND ? GROUP BY event`,
    ).bind(from, to),
  ]);

  const byEvent = new Map<string, number>();
  for (const row of rowsOf<{ event: string; events: number }>(batch[3])) {
    byEvent.set(row.event, row.events ?? 0);
  }
  const eventCount = (name: string): number => byEvent.get(name) ?? 0;

  return {
    body: {
      range,
      production_users: firstOf<{ n: number }>(batch[0])?.n ?? 0,
      active_machines: firstOf<{ n: number }>(batch[1])?.n ?? 0,
      new_machines: firstOf<{ n: number }>(batch[2])?.n ?? 0,
      installs: eventCount('install'),
      uninstalls: eventCount('uninstall'),
      index_runs: eventCount('index'),
      tool_calls: eventCount('usage_rollup'),
    },
    cacheControl: CACHE_CONTROL,
  };
}

// ---------------------------------------------------------------------------
// /api/timeseries — the line charts
// ---------------------------------------------------------------------------

interface DayValueRow {
  day: string;
  a: number | null;
  b: number | null;
}

interface SeriesSpec {
  title: string;
  /** Series labels, in the order their data lands in `datasets`. */
  labels: [string] | [string, string];
  sql: string;
  binds: (range: Range) => (string | number)[];
}

/**
 * Every metric here reads a rollup table, so a line stays correct for days whose
 * raw events are long gone. Each query returns (day, a[, b]) and is densified
 * against the full day list, because a day with no rows means zero, not a gap.
 */
const SERIES: Record<string, SeriesSpec> = {
  installs_uninstalls: {
    title: 'Installs and uninstalls',
    labels: ['Installs', 'Uninstalls'],
    sql: `SELECT day,
                 sum(CASE WHEN event = 'install'   THEN count ELSE 0 END) AS a,
                 sum(CASE WHEN event = 'uninstall' THEN count ELSE 0 END) AS b
            FROM daily_event_counts
           WHERE day BETWEEN ? AND ? AND event IN ('install', 'uninstall')
           GROUP BY day`,
    binds: (r) => [r.from, r.to],
  },
  new_installs: {
    title: 'New installs',
    labels: ['New machines'],
    sql: `SELECT first_day AS day, count(*) AS a, NULL AS b
            FROM machine_first_seen
           WHERE first_day BETWEEN ? AND ?
           GROUP BY first_day`,
    binds: (r) => [r.from, r.to],
  },
  production_users: {
    title: 'Daily production users',
    labels: ['Production users'],
    sql: `SELECT day, prod_machines AS a, NULL AS b
            FROM daily_machines WHERE day BETWEEN ? AND ?`,
    binds: (r) => [r.from, r.to],
  },
  indexing_activity: {
    title: 'Daily indexing activity',
    labels: ['Indexing runs', 'Machines indexing'],
    sql: `SELECT day, count AS a, machines AS b
            FROM daily_event_counts
           WHERE day BETWEEN ? AND ? AND event = 'index'`,
    binds: (r) => [r.from, r.to],
  },
  tool_calls: {
    title: 'Daily tool and command calls',
    labels: ['Calls', 'Machines'],
    sql: `SELECT day, count AS a, machines AS b
            FROM daily_event_counts
           WHERE day BETWEEN ? AND ? AND event = 'usage_rollup'`,
    binds: (r) => [r.from, r.to],
  },
};

async function timeseries(env: Env, url: URL, range: Range): Promise<ApiResult> {
  const metric = url.searchParams.get('metric') ?? 'installs_uninstalls';

  // The one metric whose series are data-driven rather than fixed: one line per
  // duration bucket, in bucket order (an ordered scale, so the order is meaning).
  if (metric === 'duration_buckets') return durationBucketSeries(env, range);

  const spec = SERIES[metric];
  if (!spec) {
    return fail(`unknown metric — one of: ${[...Object.keys(SERIES), 'duration_buckets'].join(', ')}`);
  }

  const { results } = await env.DB.prepare(spec.sql)
    .bind(...spec.binds(range))
    .all<DayValueRow>();

  const labels = dayList(range);
  const a = new Map<string, number>();
  const b = new Map<string, number>();
  for (const row of results) {
    a.set(row.day, row.a ?? 0);
    b.set(row.day, row.b ?? 0);
  }

  const datasets = [{ label: spec.labels[0], data: densify(labels, a) }];
  if (spec.labels.length === 2) datasets.push({ label: spec.labels[1], data: densify(labels, b) });

  return {
    body: {
      range,
      metric,
      title: spec.title,
      labels,
      datasets,
      rows: labels.map((day, i) => ({
        day,
        ...Object.fromEntries(datasets.map((d) => [d.label, d.data[i] ?? 0])),
      })),
    },
    cacheControl: CACHE_CONTROL,
  };
}

/** "Session run length over time": one series per duration bucket, bucket-ordered. */
async function durationBucketSeries(env: Env, range: Range): Promise<ApiResult> {
  const { results } = await env.DB.prepare(
    `SELECT day, value, sum(count) AS n
       FROM daily_dim_counts
      WHERE dim = 'duration_bucket' AND event = 'index' AND day BETWEEN ? AND ?
      GROUP BY day, value`,
  )
    .bind(range.from, range.to)
    .all<{ day: string; value: string; n: number }>();

  const labels = dayList(range);
  const perBucket = new Map<string, Map<string, number>>();
  for (const row of results) {
    let series = perBucket.get(row.value);
    if (!series) perBucket.set(row.value, (series = new Map()));
    series.set(row.day, row.n ?? 0);
  }

  // Fixed buckets first and always present (a bucket with no runs is a real zero,
  // and dropping it would silently renumber the ordinal colour ramp); anything
  // unexpected from an older client is appended rather than hidden.
  const extra = [...perBucket.keys()].filter((v) => !DURATION_BUCKETS.includes(v as never)).sort();
  const order = [...DURATION_BUCKETS, ...extra];

  const datasets = order.map((bucket) => ({
    label: bucket,
    data: densify(labels, perBucket.get(bucket) ?? new Map()),
  }));

  return {
    body: {
      range,
      metric: 'duration_buckets',
      title: 'Indexing run length over time',
      labels,
      datasets,
      rows: labels.map((day, i) => ({
        day,
        ...Object.fromEntries(datasets.map((d) => [d.label, d.data[i] ?? 0])),
      })),
    },
    cacheControl: CACHE_CONTROL,
  };
}

// ---------------------------------------------------------------------------
// /api/breakdown — the bars and pies
// ---------------------------------------------------------------------------

interface BreakdownRow {
  value: string;
  count: number;
  machines: number;
}

/**
 * Sums one dimension over the range.
 *
 * On the `machines` metric: `daily_dim_counts.machines` is per day, so summing
 * it over a range gives **machine-days**, not distinct machines — a machine
 * seen on ten days counts ten times. A range-wide distinct count per dimension
 * value is not recoverable from the rollups at all (it would need the raw
 * events, which are purged), so rather than quietly presenting one as the
 * other, the number is honestly named machine-days everywhere it appears, and
 * the panels that use it are share-of-total panels where the distinction does
 * not move the shape.
 *
 * The inner `max(machines)` is the other half of that honesty: the same machine
 * emits install *and* index *and* usage_rollup on one day, each carrying `os`,
 * so summing `machines` across event types would triple-count it. Taking the
 * largest single-event count for the day is the closest lower bound the rollups
 * can give. When a dim belongs to exactly one event (or `?event=` pins it) the
 * `max` is over a single row and the question does not arise.
 */
async function breakdown(env: Env, url: URL, range: Range): Promise<ApiResult> {
  const dim = url.searchParams.get('dim') ?? '';
  const spec = DIMS[dim];
  if (!spec) return fail(`unknown dim — one of: ${Object.keys(DIMS).join(', ')}`);

  const requestedMetric = url.searchParams.get('metric');
  if (requestedMetric !== null && requestedMetric !== 'count' && requestedMetric !== 'machines') {
    return fail('metric must be count or machines');
  }
  const metric = requestedMetric ?? spec.metric;

  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit === null ? DEFAULT_BREAKDOWN_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BREAKDOWN_LIMIT) {
    return fail(`limit must be an integer between 1 and ${MAX_BREAKDOWN_LIMIT}`);
  }

  const event = url.searchParams.get('event') ?? spec.event ?? null;
  if (event !== null && !/^[a-z_]{1,32}$/.test(event)) return fail('event must be a bare event name');

  const binds: (string | number)[] = [dim, range.from, range.to];
  if (event !== null) binds.push(event);

  const { results } = await env.DB.prepare(
    `SELECT value, sum(day_count) AS count, sum(day_machines) AS machines
       FROM (SELECT day, value, sum(count) AS day_count, max(machines) AS day_machines
               FROM daily_dim_counts
              WHERE dim = ? AND day BETWEEN ? AND ?${event !== null ? ' AND event = ?' : ''}
              GROUP BY day, value)
      GROUP BY value`,
  )
    .bind(...binds)
    .all<BreakdownRow>();

  const rows = results.map((r) => ({
    value: r.value,
    count: r.count ?? 0,
    machines: r.machines ?? 0,
  }));

  const pick = (r: BreakdownRow): number => (metric === 'machines' ? r.machines : r.count);

  let ordered: BreakdownRow[];
  let truncated = false;
  if (spec.order === 'bucket' && spec.buckets) {
    // An ordered scale: the buckets keep their own order and all of them show,
    // including empty ones, so the ordinal colour ramp always means the same thing.
    const found = new Map(rows.map((r) => [r.value, r]));
    const extra = rows.filter((r) => !spec.buckets?.includes(r.value)).sort((x, y) => pick(y) - pick(x));
    ordered = [
      ...spec.buckets.map((b) => found.get(b) ?? { value: b, count: 0, machines: 0 }),
      ...extra,
    ];
  } else {
    const sorted = [...rows].sort(
      spec.order === 'version_desc'
        ? (x, y) => compareVersionsDesc(x.value, y.value)
        : (x, y) => pick(y) - pick(x) || x.value.localeCompare(y.value),
    );
    if (sorted.length > limit) {
      // Fold rather than truncate: a chopped bar chart quietly changes what the
      // total means, and "Other" keeps the panel's total honest.
      const head = sorted.slice(0, limit);
      const tail = sorted.slice(limit);
      ordered = [
        ...head,
        {
          value: 'Other',
          count: tail.reduce((n, r) => n + r.count, 0),
          machines: tail.reduce((n, r) => n + r.machines, 0),
        },
      ];
      truncated = true;
    } else {
      ordered = sorted;
    }
  }

  const data = ordered.map(pick);
  return {
    body: {
      range,
      dim,
      event,
      metric,
      title: spec.label,
      labels: ordered.map((r) => r.value),
      datasets: [{ label: metric === 'machines' ? 'Machine-days' : 'Events', data }],
      rows: ordered,
      total: data.reduce((n, v) => n + v, 0),
      /** True when the tail was folded into an "Other" bar. */
      truncated,
    },
    cacheControl: CACHE_CONTROL,
  };
}

// ---------------------------------------------------------------------------
// /api/activation — install → first index
// ---------------------------------------------------------------------------

interface ActivationRow {
  day: string;
  installs: number;
  activated: number;
}

/**
 * Of the machines whose FIRST day falls in the range, how many ran an index
 * within `window` days of it.
 *
 * The cohort key is `machine_first_seen`, not install events: a machine that
 * reinstalls does not re-enter the funnel, which is what makes this a
 * conversion rate rather than an install-event ratio.
 *
 * The LEFT JOIN rides events_machine_day (machine_id, day) and `count(DISTINCT)`
 * absorbs the fan-out from a machine that indexed many times. This is the one
 * endpoint that reads raw `events`, so it is bounded by the retention window —
 * `raw_events_from` tells the caller where the data actually starts, and the UI
 * says so rather than drawing a cliff and calling it a drop in conversion.
 */
async function activation(env: Env, url: URL, range: Range): Promise<ApiResult> {
  const rawWindow = url.searchParams.get('window');
  const window = rawWindow === null ? DEFAULT_ACTIVATION_WINDOW : Number(rawWindow);
  if (!Number.isInteger(window) || window < 1 || window > MAX_ACTIVATION_WINDOW) {
    return fail(`window must be an integer between 1 and ${MAX_ACTIVATION_WINDOW}`);
  }

  const batch = await env.DB.batch([
    env.DB.prepare(
      `SELECT f.first_day AS day,
              count(DISTINCT f.machine_id) AS installs,
              count(DISTINCT CASE WHEN e.machine_id IS NOT NULL THEN f.machine_id END) AS activated
         FROM machine_first_seen f
         LEFT JOIN events e
                ON e.machine_id = f.machine_id
               AND e.event = 'index'
               AND e.day >= f.first_day
               AND e.day <= date(f.first_day, ?)
        WHERE f.first_day BETWEEN ? AND ?
        GROUP BY f.first_day`,
      // A bound modifier string, built from an integer this function validated —
      // date() takes the modifier as data, so nothing is concatenated into SQL.
    ).bind(`+${window} days`, range.from, range.to),
    env.DB.prepare(`SELECT min(day) AS raw_from, max(day) AS raw_to FROM events`),
  ]);

  const rows = rowsOf<ActivationRow>(batch[0]);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const labels = dayList(range);

  const installs = rows.reduce((n, r) => n + (r.installs ?? 0), 0);
  const activated = rows.reduce((n, r) => n + (r.activated ?? 0), 0);

  // Cohorts younger than the window have not finished converting yet, so their
  // rate is a floor, not a result. Marked rather than dropped: hiding the last
  // week of a conversion chart is its own kind of lie.
  const boundsRow = firstOf<{ raw_from: string | null; raw_to: string | null }>(batch[1]);
  const latestRaw = boundsRow?.raw_to ?? utcDay(Date.now());
  const incompleteFrom = addDays(latestRaw, -(window - 1));

  const detail = labels.map((day) => {
    const row = byDay.get(day);
    const dayInstalls = row?.installs ?? 0;
    const dayActivated = row?.activated ?? 0;
    return {
      day,
      installs: dayInstalls,
      activated: dayActivated,
      rate: dayInstalls > 0 ? dayActivated / dayInstalls : null,
      complete: day < incompleteFrom,
    };
  });

  return {
    body: {
      range,
      window_days: window,
      installs,
      activated,
      dropped: installs - activated,
      rate: installs > 0 ? activated / installs : null,
      /** Cohorts from this day on have not had the full window to convert. */
      incomplete_from: incompleteFrom,
      /** Raw events start here; a range reaching further back under-counts. */
      raw_events_from: boundsRow?.raw_from ?? null,
      labels,
      datasets: [
        {
          label: 'Activation rate',
          data: detail.map((d) => (d.rate === null ? null : Math.round(d.rate * 1000) / 10)),
        },
      ],
      rows: detail,
    },
    cacheControl: CACHE_CONTROL,
  };
}

// ---------------------------------------------------------------------------
// /api/retention — day 0–14 cohort curve
// ---------------------------------------------------------------------------

/**
 * For machines first seen in the range, the share still active k days later.
 *
 * Read entirely off `machine_days` + `machine_first_seen`, neither of which the
 * retention purge touches, so this answers for any range in history.
 *
 * The denominator is per-k, not the whole cohort: a machine first seen
 * yesterday cannot have a day-7 data point, and dividing by it anyway would
 * bend every recent cohort's curve toward zero. So day k is measured only over
 * the machines that have actually had k days to come back — `eligible[k]`. The
 * numerator needs no matching filter, since a machine with fewer than k days
 * elapsed contributes zero to day k by construction.
 */
async function retention(env: Env, range: Range): Promise<ApiResult> {
  const batch = await env.DB.batch([
    env.DB.prepare(
      `SELECT CAST(julianday(d.day) - julianday(f.first_day) AS INTEGER) AS k,
              count(DISTINCT d.machine_id) AS machines
         FROM machine_first_seen f
         JOIN machine_days d ON d.machine_id = f.machine_id
        WHERE f.first_day BETWEEN ? AND ?
          AND d.day >= f.first_day
          AND d.day <= date(f.first_day, ?)
        GROUP BY k`,
    ).bind(range.from, range.to, `+${RETENTION_DAYS} days`),
    env.DB.prepare(
      `SELECT first_day AS day, count(*) AS machines
         FROM machine_first_seen WHERE first_day BETWEEN ? AND ? GROUP BY first_day`,
    ).bind(range.from, range.to),
    env.DB.prepare(`SELECT max(day) AS day FROM machine_days`),
  ]);

  const retained = new Map(
    rowsOf<{ k: number; machines: number }>(batch[0]).map((r) => [r.k, r.machines ?? 0]),
  );
  const cohortDays = rowsOf<{ day: string; machines: number }>(batch[1]);
  const cohortSize = cohortDays.reduce((n, r) => n + (r.machines ?? 0), 0);
  const latestDay = firstOf<{ day: string | null }>(batch[2])?.day ?? utcDay(Date.now());

  const rows = [];
  for (let k = 0; k <= RETENTION_DAYS; k++) {
    // Machines whose first day is early enough that day k has already happened.
    const cutoff = addDays(latestDay, -k);
    const eligible = cohortDays.reduce((n, r) => (r.day <= cutoff ? n + (r.machines ?? 0) : n), 0);
    const back = retained.get(k) ?? 0;
    rows.push({
      day: k,
      eligible,
      retained: back,
      rate: eligible > 0 ? back / eligible : null,
    });
  }

  return {
    body: {
      range,
      cohort: cohortSize,
      window_days: RETENTION_DAYS,
      labels: rows.map((r) => `Day ${r.day}`),
      datasets: [
        {
          label: 'Retained',
          data: rows.map((r) => (r.rate === null ? null : Math.round(r.rate * 1000) / 10)),
        },
      ],
      rows,
    },
    cacheControl: CACHE_CONTROL,
  };
}

// ---------------------------------------------------------------------------
// /api/health — liveness, and the only endpoint that is not range-scoped
// ---------------------------------------------------------------------------

async function health(env: Env): Promise<ApiResult> {
  try {
    const batch = await env.DB.batch<{ day: string | null }>([
      env.DB.prepare('SELECT max(day) AS day FROM events'),
      env.DB.prepare('SELECT max(day) AS day FROM daily_machines'),
    ]);
    return {
      body: {
        ok: true,
        database: {
          latest_event_day: batch[0]?.results[0]?.day ?? null,
          latest_rollup_day: batch[1]?.results[0]?.day ?? null,
        },
      },
    };
  } catch (err) {
    console.error(JSON.stringify({ msg: 'health query failed', err: String(err) }));
    return { body: { ok: false, error: 'database unavailable' }, status: 503 };
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Called only for an authenticated GET — src/index.ts owns the session gate and
 * turns what comes back into a Response.
 */
export async function handleApi(env: Env, url: URL): Promise<ApiResult> {
  if (url.pathname === '/api/session') return { body: { authenticated: true } };
  if (url.pathname === '/api/health') return health(env);
  if (url.pathname === '/api/meta') return meta(env);

  const ranged = new Set(['/api/summary', '/api/timeseries', '/api/breakdown', '/api/activation', '/api/retention']);
  if (!ranged.has(url.pathname)) return fail('not found', 404);

  const range = parseRange(url);
  if (isApiResult(range)) return range;

  try {
    switch (url.pathname) {
      case '/api/summary':
        return await summary(env, range);
      case '/api/timeseries':
        return await timeseries(env, url, range);
      case '/api/breakdown':
        return await breakdown(env, url, range);
      case '/api/activation':
        return await activation(env, url, range);
      case '/api/retention':
        return await retention(env, range);
      default:
        return fail('not found', 404);
    }
  } catch (err) {
    // The query failed, not the caller. Log the cause, tell the page something
    // it can put in the panel, and let the other panels carry on.
    console.error(JSON.stringify({ msg: 'api query failed', path: url.pathname, err: String(err) }));
    return { body: { error: 'query failed' }, status: 503 };
  }
}
