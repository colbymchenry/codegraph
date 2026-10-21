/**
 * The self-hosted telemetry services — `telemetry-worker/` (ingest + nightly rollup)
 * and `telemetry-dashboard/` (the read API) — run against the checked-in D1
 * migrations in an in-memory node:sqlite database (#2333).
 *
 * D1 is SQLite, so every statement here is the SQL production runs. The one stand-in
 * is a thin adapter giving node:sqlite D1's prepare/bind/first/all/run/batch shape,
 * with `batch()` as one transaction the way D1 runs it. No wrangler, no workerd, no
 * network: the end-to-end versions of these checks are the packages' own smoke
 * suites (`npm run smoke`, `smoke:rollup`, `smoke:cutover`, `smoke:api`), which boot
 * `wrangler dev`.
 *
 *   npx vitest run __tests__/telemetry-services.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import worker from '../telemetry-worker/src/index';
import { runNightly } from '../telemetry-worker/src/rollup';
import { handleApi } from '../telemetry-dashboard/src/api';

let nodeSqlite: typeof import('node:sqlite') | null = null;
try {
  nodeSqlite = require('node:sqlite') as typeof import('node:sqlite');
} catch {
  /* Node < 22.5 — skipped below */
}

const MIGRATIONS = path.join(__dirname, '..', 'telemetry-worker', 'migrations');
const MINUTE = 60_000;
/** Cloudflare ends a Cron Trigger invocation after 15 minutes of wall-clock time. */
const CRON_LIMIT_MS = 15 * MINUTE;

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// D1 over node:sqlite
// ---------------------------------------------------------------------------

/** Binds integral numbers as INTEGER, as D1 does (node:sqlite would bind them as REAL). */
const bindable = (v: unknown): unknown => (typeof v === 'number' && Number.isInteger(v) ? BigInt(v) : v);

class SqliteD1Statement {
  constructor(
    private readonly d1: SqliteD1,
    readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]): SqliteD1Statement {
    return new SqliteD1Statement(this.d1, this.sql, params);
  }

  execute(): { success: true; results: Row[]; meta: { changes: number } } {
    this.d1.onStatement?.(this.sql);
    const stmt = this.d1.db.prepare(this.sql);
    const params = this.params.map(bindable) as never[];
    if (/^\s*(SELECT|WITH)\b/i.test(this.sql)) {
      return { success: true, results: stmt.all(...params) as Row[], meta: { changes: 0 } };
    }
    const info = stmt.run(...params);
    return { success: true, results: [], meta: { changes: Number(info.changes) } };
  }

  async first<T>(): Promise<T | null> {
    return (this.execute().results[0] as T | undefined) ?? null;
  }

  async all(): Promise<ReturnType<SqliteD1Statement['execute']>> {
    return this.execute();
  }

  async run(): Promise<ReturnType<SqliteD1Statement['execute']>> {
    return this.execute();
  }
}

class SqliteD1 {
  /** Runs before every statement — the cron tests use it to model elapsed wall-clock time. */
  onStatement: ((sql: string) => void) | null = null;

  constructor(readonly db: import('node:sqlite').DatabaseSync) {}

  prepare(sql: string): SqliteD1Statement {
    return new SqliteD1Statement(this, sql);
  }

  async batch(statements: SqliteD1Statement[]): Promise<ReturnType<SqliteD1Statement['execute']>[]> {
    this.db.exec('BEGIN');
    try {
      const results = statements.map((s) => s.execute());
      this.db.exec('COMMIT');
      return results;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

describe.skipIf(!nodeSqlite)('telemetry services against the D1 schema (#2333)', () => {
  let db: import('node:sqlite').DatabaseSync;
  let d1: SqliteD1;
  let env: never;
  let logged: Row[];

  const at = (iso: string): void => {
    vi.setSystemTime(new Date(iso));
  };

  const one = (sql: string, ...params: unknown[]): Row | undefined =>
    db.prepare(sql).get(...(params.map(bindable) as never[])) as Row | undefined;

  /** POST /v1/events the way a client does, then wait for the off-response-path write. */
  async function post(machineId: string, events: Row[]): Promise<number> {
    const body = JSON.stringify({
      machine_id: machineId,
      codegraph_version: '1.6.2',
      os: 'linux',
      arch: 'x64',
      node_major: 22,
      ci: false,
      schema_version: 2,
      events,
    });
    const pending: Promise<unknown>[] = [];
    const request = new Request('https://telemetry.test/v1/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
      body,
    });
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {} };
    const response = await worker.fetch(request as never, env, ctx as never);
    await Promise.all(pending);
    return response.status;
  }

  /** GET one dashboard endpoint, as the signed-in page does. */
  async function api(pathAndQuery: string): Promise<Row> {
    const result = await handleApi(env, new URL(`https://stats.test${pathAndQuery}`));
    expect(result.status ?? 200).toBe(200);
    return result.body as Row;
  }

  /**
   * One cron invocation at `iso`. `chunkMs` is the wall-clock time each legacy-usage
   * fold chunk is charged; a statement that starts after Cloudflare's 15-minute limit
   * throws, the way the runtime ends the invocation there.
   */
  async function nightly(iso: string, chunkMs = 0): Promise<{ latestStartMs: number; summary: Row | undefined }> {
    at(iso);
    const started = Date.now();
    let latestStartMs = 0;
    d1.onStatement = (sql) => {
      const elapsed = Date.now() - started;
      if (elapsed > CRON_LIMIT_MS) {
        throw new Error(`statement started ${elapsed / MINUTE} min into the cron run — past the 15-minute limit`);
      }
      latestStartMs = Math.max(latestStartMs, elapsed);
      if (/INSERT INTO usage_daily/.test(sql) && /FROM events/.test(sql)) vi.setSystemTime(Date.now() + chunkMs);
    };
    const before = logged.length;
    try {
      await runNightly(env, Date.parse(iso));
    } finally {
      d1.onStatement = null;
    }
    const summary = logged.slice(before).find((line) => line.msg === 'nightly rollup');
    return { latestStartMs, summary };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    db = new nodeSqlite!.DatabaseSync(':memory:');
    for (const file of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
      db.exec(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8'));
    }
    d1 = new SqliteD1(db);
    env = {
      DB: d1,
      RETENTION_DAYS: 90,
      MACHINE_RATE_LIMITER: { limit: async () => ({ success: true }) },
      ADMIN_RATE_LIMITER: { limit: async () => ({ success: true }) },
    } as never;
    logged = [];
    const capture = (line: unknown): void => {
      try {
        logged.push(JSON.parse(String(line)) as Row);
      } catch {
        /* not one of the worker's JSON lines */
      }
    };
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.spyOn(console, 'error').mockImplementation(capture);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    db.close();
  });

  const M1 = '00000000-0000-4000-8000-000000000001';
  const M2 = '00000000-0000-4000-8000-000000000002';
  const M3 = '00000000-0000-4000-8000-000000000003';
  const install = (ts: string): Row => ({ event: 'install', ts, props: { scope: 'local', kind: 'fresh' } });
  const index = (ts: string): Row => ({ event: 'index', ts, props: { languages: ['typescript'] } });
  const usage = (day: string, count: number): Row => ({
    event: 'usage_rollup',
    ts: `${day}T12:00:00.000Z`,
    props: { kind: 'mcp_tool', name: 'codegraph_explore', count, client_name: 'Claude Code' },
  });

  // -------------------------------------------------------------------------
  // 1. Activation counts an index run that uploads late
  // -------------------------------------------------------------------------

  describe('a late index upload', () => {
    it('counts toward activation even when it arrives after the nightly run stopped revisiting its day', async () => {
      // Sep 25: the machine installs. Its index run fails to upload and stays in the
      // client's queue, keeping its original timestamp.
      at('2026-09-25T15:00:00Z');
      expect(await post(M1, [install('2026-09-25T14:00:00Z')])).toBe(204);
      await nightly('2026-09-26T00:30:00Z');

      // Oct 3: the queued index run finally goes out — eight days late, inside the
      // 30 days ingest accepts, but long past the three days each nightly run re-rolls.
      at('2026-10-03T10:00:00Z');
      expect(await post(M1, [index('2026-09-25T14:05:00Z')])).toBe(204);
      // Someone else's activity, so the rollup's coverage moves past the cohort's window.
      expect(await post(M2, [install('2026-10-03T09:00:00Z')])).toBe(204);
      await nightly('2026-10-04T00:30:00Z');

      at('2026-10-04T08:00:00Z');
      const funnel = await api('/api/activation?from=2026-09-25&to=2026-09-25&window=7');
      expect(funnel).toMatchObject({ installs: 1, activated: 1, dropped: 0, covered_through: '2026-10-03' });
      expect(one('SELECT first_day, first_index_day FROM machine_first_seen WHERE machine_id = ?', M1)).toEqual({
        first_day: '2026-09-25',
        first_index_day: '2026-09-25',
      });
    });

    it('is applied as it is stored, and only ever moves the first index day earlier', async () => {
      const firstSeen = (machineId: string): Row | undefined =>
        one('SELECT first_day, first_index_day FROM machine_first_seen WHERE machine_id = ?', machineId);

      at('2026-10-03T10:00:00Z');
      // A batch without an index run says nothing about indexing.
      expect(await post(M1, [install('2026-10-02T10:00:00Z')])).toBe(204);
      expect(await post(M1, [usage('2026-10-01', 4)])).toBe(204);
      expect(firstSeen(M1)).toEqual({ first_day: '2026-10-01', first_index_day: null });

      // The earliest index run in a batch wins, with no rollup involved.
      expect(await post(M1, [index('2026-10-03T09:00:00Z'), index('2026-10-02T11:00:00Z')])).toBe(204);
      expect(firstSeen(M1)).toEqual({ first_day: '2026-10-01', first_index_day: '2026-10-02' });

      // A later index run leaves it alone; a backdated one lowers it, and first_day with it.
      expect(await post(M1, [index('2026-10-03T09:30:00Z')])).toBe(204);
      expect(firstSeen(M1)).toEqual({ first_day: '2026-10-01', first_index_day: '2026-10-02' });
      expect(await post(M1, [index('2026-09-20T08:00:00Z')])).toBe(204);
      expect(firstSeen(M1)).toEqual({ first_day: '2026-09-20', first_index_day: '2026-09-20' });

      // A machine whose very first batch carries an index run.
      expect(await post(M2, [install('2026-10-03T08:00:00Z'), index('2026-10-03T08:01:00Z')])).toBe(204);
      expect(firstSeen(M2)).toEqual({ first_day: '2026-10-03', first_index_day: '2026-10-03' });

      // The nightly rollup agrees with what ingest already wrote.
      await nightly('2026-10-04T00:30:00Z');
      expect(firstSeen(M1)).toEqual({ first_day: '2026-09-20', first_index_day: '2026-09-20' });
      expect(firstSeen(M2)).toEqual({ first_day: '2026-10-03', first_index_day: '2026-10-03' });
    });
  });

  // -------------------------------------------------------------------------
  // 2. Usage-only days are not a stalled ingest
  // -------------------------------------------------------------------------

  describe('the stalled-ingest flag', () => {
    it('counts usage counters as ingest that is still storing', async () => {
      // The last lifecycle event is Sep 25; after that only usage counters arrive.
      at('2026-09-25T15:00:00Z');
      expect(await post(M1, [install('2026-09-25T14:00:00Z')])).toBe(204);
      // Clients upload a day's counters only once it is over: Oct 3's arrive on Oct 4.
      at('2026-10-04T06:00:00Z');
      expect(await post(M2, [usage('2026-10-03', 12)])).toBe(204);

      at('2026-10-04T08:00:00Z');
      const meta = await api('/api/meta');
      expect(meta).toMatchObject({ latest_raw_day: '2026-09-25', latest_ingest_day: '2026-10-03', ingest_stalled: false });

      // Just past midnight nobody has sent Oct 4's counters yet; that is not a stall.
      at('2026-10-05T00:10:00Z');
      expect(await api('/api/meta')).toMatchObject({ ingest_stalled: false });

      // A whole day later with nothing stored at all, it is — and the banner date is
      // the last day anything was stored, not the last lifecycle event.
      at('2026-10-06T08:00:00Z');
      expect(await api('/api/meta')).toMatchObject({ latest_ingest_day: '2026-10-03', ingest_stalled: true });
    });

    it('still reports a stall when nothing at all has arrived, and not on an empty database', async () => {
      at('2026-10-04T08:00:00Z');
      expect(await api('/api/meta')).toMatchObject({ latest_ingest_day: null, ingest_stalled: false });

      at('2026-09-25T15:00:00Z');
      expect(await post(M1, [install('2026-09-25T14:00:00Z')])).toBe(204);
      at('2026-10-04T08:00:00Z');
      expect(await api('/api/meta')).toMatchObject({ latest_ingest_day: '2026-09-25', ingest_stalled: true });

      // A lifecycle event from yesterday is fresh, as before.
      expect(await post(M1, [index('2026-10-03T22:00:00Z')])).toBe(204);
      expect(await api('/api/meta')).toMatchObject({ latest_ingest_day: '2026-10-03', ingest_stalled: false });
    });
  });

  // -------------------------------------------------------------------------
  // 3. A long catch-up stays inside the cron's wall-clock limit, and the purge runs
  // -------------------------------------------------------------------------

  describe('the nightly run under a catch-up backlog', () => {
    /** The rollup folds legacy usage rows 50,000 per transaction (rollup.ts, LEGACY_CHUNK_ROWS). */
    const CHUNK_ROWS = 50_000;
    /**
     * Each fold chunk is charged 4 minutes, so a backlog of legacy-heavy days costs
     * several minutes apiece, as it did in production. The six missed days below hold
     * seven chunks: 28 minutes of folding, against a 15-minute limit.
     */
    const CHUNK_MS = 4 * MINUTE;
    const NIGHT_1 = '2026-10-05T00:30:00Z';
    /** Missed days, newest first — the order catch-up takes them in. Sep 21 needs two chunks. */
    const MISSED = ['2026-09-23', '2026-09-22', '2026-09-21', '2026-09-20', '2026-09-19', '2026-09-18'];
    const LEGACY_ROWS: Record<string, number> = Object.fromEntries(
      MISSED.map((day) => [day, day === '2026-09-21' ? CHUNK_ROWS + 3 : 3]),
    );
    const PAST_WINDOW = '2026-06-01';

    /** Legacy rows as they were stored before migrations/0003: one `events` row per upload, count 1. */
    function seedLegacyDay(day: string, rows: number): void {
      db.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
         INSERT INTO events (received_at, ts, day, event, machine_id, codegraph_version, os, arch,
                             node_major, ci, schema_version, props)
         SELECT ?2 || 'T13:00:00.000Z', ?2 || 'T12:00:00.000Z', ?2, 'usage_rollup',
                '00000000-0000-4000-8000-00000000010' || ((i - 1) % 5), '1.5.0', 'linux', 'x64', 22, 0, 1,
                '{"kind":"mcp_tool","name":"codegraph_explore","count":1,"error_count":0,"client_name":"Claude Code"}'
           FROM n`,
      ).run(BigInt(rows), day);
      for (let m = 0; m < Math.min(rows, 5); m++) {
        const machine = `00000000-0000-4000-8000-00000000010${m}`;
        db.prepare('INSERT INTO machine_days (machine_id, day, prod) VALUES (?, ?, 1)').run(machine, day);
        db.prepare(
          `INSERT INTO machine_first_seen (machine_id, first_day) VALUES (?, ?)
             ON CONFLICT (machine_id) DO UPDATE SET first_day = min(first_day, excluded.first_day)`,
        ).run(machine, day);
      }
    }

    /** Where each seeded usage count sits right now, and whether the day has been rolled up. */
    function ledger(day: string) {
      const folded = Number(one('SELECT coalesce(sum(count), 0) AS n FROM usage_daily WHERE day = ?', day)?.n);
      const unfolded = Number(
        one(
          `SELECT coalesce(sum(json_extract(props, '$.count')), 0) AS n FROM events
            WHERE day = ? AND event = 'usage_rollup'`,
          day,
        )?.n,
      );
      const rolledUsage = one(`SELECT count FROM daily_event_counts WHERE day = ? AND event = 'usage_rollup'`, day);
      const rolledUp = one('SELECT machines FROM daily_machines WHERE day = ?', day) !== undefined;
      return { folded, unfolded, rolledUsage: rolledUsage ? Number(rolledUsage.count) : null, rolledUp };
    }

    function expectConsistent(): void {
      for (const day of MISSED) {
        const l = ledger(day);
        // Nothing lost and nothing counted twice, however far the fold got.
        expect(l.folded + l.unfolded, day).toBe(LEGACY_ROWS[day]);
        if (l.rolledUp) {
          expect(l, day).toMatchObject({ unfolded: 0, rolledUsage: LEGACY_ROWS[day] });
        } else {
          // A day whose fold did not finish gets no rollup at all, so it stays "missed".
          expect(l.rolledUsage, day).toBeNull();
        }
      }
    }

    beforeEach(() => {
      for (const day of MISSED) seedLegacyDay(day, LEGACY_ROWS[day]!);
      // Past the 90-day window: the purge must take these.
      db.prepare(
        `INSERT INTO events (received_at, ts, day, event, machine_id, props)
         VALUES ('2026-06-01T10:00:00.000Z', NULL, ?1, 'install', ?2, '{}')`,
      ).run(PAST_WINDOW, M3);
      db.prepare(
        `INSERT INTO usage_daily (day, machine_id, kind, name, count) VALUES (?, ?, 'cli_command', 'index', 2)`,
      ).run(PAST_WINDOW, M3);
    });

    it('purges on schedule, stops before the limit, and resumes the backlog the next nights', async () => {
      // The three days the run re-rolls every night have ordinary, current traffic.
      at('2026-10-04T12:00:00Z');
      expect(await post(M1, [install('2026-10-04T11:00:00Z'), usage('2026-10-03', 5)])).toBe(204);
      expect(await post(M2, [index('2026-10-02T11:00:00Z')])).toBe(204);

      const first = await nightly(NIGHT_1, CHUNK_MS);
      expect(first.latestStartMs).toBeLessThanOrEqual(CRON_LIMIT_MS);
      // The purge ran, and the summary line was written.
      expect(one('SELECT count(*) AS n FROM events WHERE day < ?', '2026-07-07')?.n).toBe(0);
      expect(one('SELECT count(*) AS n FROM usage_daily WHERE day < ?', '2026-07-07')?.n).toBe(0);
      expect(first.summary).toMatchObject({ purged: 1, usage_purged: 1, failed: 0 });
      // Tonight's regular days were rolled up first.
      for (const day of ['2026-10-04', '2026-10-03', '2026-10-02']) {
        expect(one('SELECT machines FROM daily_machines WHERE day = ?', day), day).toEqual({ machines: 1 });
      }
      // The backlog did not fit: Sep 21 was left part-folded and un-rolled, the rest untouched.
      expect(ledger('2026-09-21')).toMatchObject({ folded: CHUNK_ROWS, unfolded: 3, rolledUp: false });
      expect(MISSED.filter((day) => !ledger(day).rolledUp)).toEqual(MISSED.slice(2));
      expect(first.summary).toMatchObject({ caught_up: 2, deferred: 4 });
      expectConsistent();

      // The next nights pick up exactly where this one stopped.
      let nights = 1;
      for (let day = 6; MISSED.some((d) => !ledger(d).rolledUp) && nights < 5; day++, nights++) {
        const night = await nightly(`2026-10-0${day}T00:30:00Z`, CHUNK_MS);
        expect(night.latestStartMs).toBeLessThanOrEqual(CRON_LIMIT_MS);
        expect(night.summary).toMatchObject({ failed: 0 });
        expectConsistent();
      }
      expect(nights).toBe(3);
      for (const day of MISSED) expect(ledger(day), day).toMatchObject({ unfolded: 0, rolledUp: true });
    });
  });
});
