/**
 * codegraph telemetry ingest — telemetry.getcodegraph.com
 *
 * This file is public on purpose: it is the exact code that receives codegraph's
 * anonymous usage telemetry, so anyone can audit what is (and is not) stored.
 * The schema contract lives in docs/design/telemetry.md; the storage schema — the
 * complete list of what is kept — is migrations/0001_init.sql.
 *
 * Guarantees enforced here:
 * - strict allowlist: unknown events are dropped, unknown properties are stripped
 * - the client IP is never read, logged, or stored
 * - accepted events land in our own Cloudflare D1 database and are never forwarded
 *   to a third-party analytics vendor — this worker makes no outbound requests
 * - per-machine rate limiting, bounded body/batch sizes
 * - the write happens off the response path (ctx.waitUntil); bodies are never logged
 * - raw events expire: a nightly cron rolls each day up into anonymous daily counts
 *   and then deletes the rows behind it (rollup.ts)
 */

import { handleAdminRollup, retentionDays, runNightly } from './rollup';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_EVENTS_PER_BATCH = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Bare identifiers: tool/command/target/language names, versions.
const TOKEN_RE = /^[A-Za-z0-9_.:+-]+$/;
// Human-ish labels: MCP clientInfo names like "Claude Code", "cursor-vscode/1.2".
const LABEL_RE = /^[A-Za-z0-9_.:+/ @()-]+$/;

const infoText = (keepDays: number): string => `codegraph anonymous-telemetry ingest.

What gets collected (and what never does) is documented field-by-field:
https://github.com/colbymchenry/codegraph/blob/main/docs/design/telemetry.md
This endpoint's full source:
https://github.com/colbymchenry/codegraph/tree/main/telemetry-worker

Guarantees: no code, file paths, repo/file/symbol names, or query strings are ever
sent; the client IP is never read or stored; the machine ID is a random UUID the
client mints locally and can delete at any time. Accepted events are stored in our
own database on Cloudflare (D1) and are never forwarded to any third-party analytics
vendor. The stored schema is the complete list of what is kept:
https://github.com/colbymchenry/codegraph/blob/main/telemetry-worker/migrations/0001_init.sql

Individual events are deleted after ${keepDays} days. What outlives them: anonymous
daily totals (counts per day of things like operating system, version and language),
and which days each machine ID was active, so returning-user numbers survive. No event
details, and still nothing that identifies a person or a codebase.

Disable any time: codegraph telemetry off  |  CODEGRAPH_TELEMETRY=0  |  DO_NOT_TRACK=1
`;

type JsonObject = Record<string, unknown>;

/** Returns the sanitized value, or undefined to strip the property. */
type Sanitize = (v: unknown) => unknown;

const oneOf =
  (allowed: readonly string[]): Sanitize =>
  (v) =>
    typeof v === 'string' && allowed.includes(v) ? v : undefined;

const matching =
  (re: RegExp, maxLen: number): Sanitize =>
  (v) =>
    typeof v === 'string' && v.length > 0 && v.length <= maxLen && re.test(v) ? v : undefined;

const token = (maxLen: number): Sanitize => matching(TOKEN_RE, maxLen);
const label = (maxLen: number): Sanitize => matching(LABEL_RE, maxLen);

const tokenArray =
  (maxItems: number, maxLen: number): Sanitize =>
  (v) =>
    Array.isArray(v) &&
    v.length <= maxItems &&
    v.every((s) => typeof s === 'string' && s.length > 0 && s.length <= maxLen && TOKEN_RE.test(s))
      ? v
      : undefined;

const nonNegInt =
  (max: number): Sanitize =>
  (v) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : undefined;

/**
 * THE allowlist. This mirrors docs/design/telemetry.md exactly — changing one
 * without the other is a bug. Anything not listed here does not exist as far
 * as this endpoint is concerned.
 */
// `sqlite_backend` (`native`/`wasm`) below is a LEGACY field: pre-schema-v2 clients
// (≤ June 2026) sent it, but node:sqlite is now the only backend so current clients
// omit it. Kept here so old clients' events still validate; safe to drop once their
// share is negligible. Never `required`.
const EVENTS: Record<string, { required: readonly string[]; props: Record<string, Sanitize> }> = {
  install: {
    required: ['scope', 'kind'],
    props: {
      targets: tokenArray(12, 24),
      scope: oneOf(['local', 'global']),
      kind: oneOf(['fresh', 'upgrade', 'reinstall']),
      sqlite_backend: oneOf(['native', 'wasm']),
    },
  },
  index: {
    required: [],
    props: {
      languages: tokenArray(32, 24),
      file_count_bucket: oneOf(['<100', '100-1k', '1k-10k', '10k+']),
      duration_bucket: oneOf(['<10s', '10-60s', '1-5m', '5m+']),
      sqlite_backend: oneOf(['native', 'wasm']),
    },
  },
  usage_rollup: {
    required: ['kind', 'name', 'count'],
    props: {
      kind: oneOf(['mcp_tool', 'cli_command']),
      name: token(64),
      count: nonNegInt(1_000_000),
      error_count: nonNegInt(1_000_000),
      client_name: label(64),
      client_version: label(32),
    },
  },
  uninstall: {
    required: [],
    props: { targets: tokenArray(12, 24) },
  },
};

/** Envelope fields shared by every event in a batch (sanitized, all optional). */
const ENVELOPE_PROPS: Record<string, Sanitize> = {
  codegraph_version: token(32),
  os: token(16),
  arch: token(16),
  node_major: nonNegInt(99),
  ci: (v) => (typeof v === 'boolean' ? v : undefined),
  schema_version: nonNegInt(99),
};

/**
 * One sanitized event, ready to become one `events` row. The envelope is NOT
 * folded in here: it is identical for every event in a batch and lands in its own
 * columns, so it is carried alongside (`common`) and bound at write time.
 */
interface StoredEvent {
  event: string;
  /** Clamped ISO 8601 UTC; absent when the client sent none or sent nonsense. */
  ts?: string;
  /** Event-specific props only — stored as the `props` JSON column. */
  props: JsonObject;
}

function clampTimestamp(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return undefined;
  const now = Date.now();
  // Rollups arrive up to a few days late (offline buffers); reject implausible times.
  if (t > now + 10 * 60_000 || t < now - 30 * 86_400_000) return undefined;
  return new Date(t).toISOString();
}

function sanitizeEvent(raw: unknown): StoredEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const e = raw as JsonObject;
  if (typeof e.event !== 'string') return null;
  const spec = EVENTS[e.event];
  if (!spec) return null;

  const rawProps = (typeof e.props === 'object' && e.props !== null ? e.props : {}) as JsonObject;
  const props: JsonObject = {};
  for (const [key, sanitize] of Object.entries(spec.props)) {
    const val = sanitize(rawProps[key]);
    if (val !== undefined) props[key] = val;
  }
  for (const req of spec.required) {
    if (!(req in props)) return null;
  }

  const out: StoredEvent = { event: e.event, props };
  const ts = clampTimestamp(e.ts);
  if (ts !== undefined) out.ts = ts;
  return out;
}

/**
 * Re-narrow a sanitized envelope value for binding. The ENVELOPE_PROPS sanitizers
 * already guarantee these types; these just turn "absent" into a NULL bind.
 */
const asText = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const asInt = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const asFlag = (v: unknown): number | null => (typeof v === 'boolean' ? (v ? 1 : 0) : null);

const INSERT_EVENT = `INSERT INTO events (
  received_at, ts, day, event, machine_id,
  codegraph_version, os, arch, node_major, ci, schema_version, props
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// prod = 0 only if EVERY event this machine sent that day carried ci = 1, so a later
// non-CI batch flips the day to production and never back (max, not overwrite).
const UPSERT_MACHINE_DAY = `INSERT INTO machine_days (machine_id, day, prod) VALUES (?, ?, ?)
  ON CONFLICT (machine_id, day) DO UPDATE SET prod = max(machine_days.prod, excluded.prod)`;

// A late-arriving offline buffer can move a machine's first day earlier, never later.
const UPSERT_FIRST_SEEN = `INSERT INTO machine_first_seen (machine_id, first_day) VALUES (?, ?)
  ON CONFLICT (machine_id) DO UPDATE SET first_day = min(machine_first_seen.first_day, excluded.first_day)`;

/**
 * Persist a sanitized batch: one `events` row per event, plus the machine×day and
 * first-seen bookkeeping the dashboard's retention/activation panels need. One D1
 * `batch()` = one implicit transaction = one round trip.
 *
 * Fail-silent by design: the client treats every response as final and never retries,
 * so a failed write loses a datapoint rather than costing availability. The error is
 * logged (Workers Logs) with counts only — never the payload.
 */
async function writeToD1(
  env: Env,
  machineId: string,
  common: JsonObject,
  batch: StoredEvent[],
): Promise<void> {
  try {
    const receivedAt = new Date().toISOString();
    const insertEvent = env.DB.prepare(INSERT_EVENT);
    const stmts: D1PreparedStatement[] = [];
    // Envelope columns are identical for every row in the batch.
    const envelopeCols = [
      asText(common.codegraph_version),
      asText(common.os),
      asText(common.arch),
      asInt(common.node_major),
      asFlag(common.ci),
      asInt(common.schema_version),
    ] as const;
    // A batch can span days (offline buffers hold completed-day rollups), so
    // machine_days gets one row per distinct day rather than one per batch.
    const days = new Set<string>();

    for (const e of batch) {
      const day = (e.ts ?? receivedAt).slice(0, 10);
      days.add(day);
      stmts.push(
        insertEvent.bind(
          receivedAt,
          e.ts ?? null,
          day,
          e.event,
          machineId,
          ...envelopeCols,
          JSON.stringify(e.props),
        ),
      );
    }

    const prod = common.ci === true ? 0 : 1;
    const upsertDay = env.DB.prepare(UPSERT_MACHINE_DAY);
    for (const day of days) stmts.push(upsertDay.bind(machineId, day, prod));

    const firstDay = [...days].sort()[0];
    if (firstDay !== undefined) {
      stmts.push(env.DB.prepare(UPSERT_FIRST_SEEN).bind(machineId, firstDay));
    }

    await env.DB.batch(stmts);
  } catch (err) {
    console.error(JSON.stringify({ msg: 'd1 write failed', err: String(err), events: batch.length }));
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (request.method === 'GET' && url.pathname === '/') {
        return new Response(infoText(retentionDays(env)), {
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      }
      // Backfill/repair for the nightly rollup. 404s unless ADMIN_TOKEN is configured.
      if (url.pathname === '/admin/rollup') {
        return await handleAdminRollup(request, env, url);
      }
      if (url.pathname !== '/v1/events') {
        return new Response('not found\n', { status: 404 });
      }
      if (request.method !== 'POST') {
        return new Response('method not allowed\n', { status: 405, headers: { allow: 'POST' } });
      }

      const contentLength = Number(request.headers.get('content-length'));
      if (!Number.isFinite(contentLength) || contentLength <= 0) {
        return new Response('length required\n', { status: 411 });
      }
      if (contentLength > MAX_BODY_BYTES) {
        return new Response('payload too large\n', { status: 413 });
      }

      let body: JsonObject;
      try {
        const text = await request.text();
        if (text.length > MAX_BODY_BYTES) return new Response('payload too large\n', { status: 413 });
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return new Response('bad request\n', { status: 400 });
        }
        body = parsed as JsonObject;
      } catch {
        return new Response('bad request\n', { status: 400 });
      }

      const machineId = body.machine_id;
      if (typeof machineId !== 'string' || !UUID_RE.test(machineId)) {
        return new Response('bad request\n', { status: 400 });
      }

      // Best-effort rate limit; fails open — losing a data point beats losing availability.
      try {
        const { success } = await env.MACHINE_RATE_LIMITER.limit({ key: machineId });
        if (!success) return new Response('rate limited\n', { status: 429 });
      } catch (err) {
        console.error(JSON.stringify({ msg: 'rate limiter unavailable', err: String(err) }));
      }

      const common: JsonObject = {};
      for (const [key, sanitize] of Object.entries(ENVELOPE_PROPS)) {
        const val = sanitize(body[key]);
        if (val !== undefined) common[key] = val;
      }

      const rawEvents = Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTS_PER_BATCH) : [];
      const batch: StoredEvent[] = [];
      for (const raw of rawEvents) {
        const sanitized = sanitizeEvent(raw);
        if (sanitized) batch.push(sanitized);
      }

      // Nothing survived the allowlist ⇒ nothing is written at all, not even the
      // machine×day bookkeeping: those tables must only ever describe stored events.
      if (batch.length > 0) {
        ctx.waitUntil(writeToD1(env, machineId, common, batch));
      }
      // Accepted (including "everything was dropped by the allowlist") — the
      // client treats every response as final and never retries.
      return new Response(null, { status: 204 });
    } catch (err) {
      console.error(JSON.stringify({ msg: 'unhandled error', err: String(err) }));
      return new Response('internal error\n', { status: 500 });
    }
  },

  /**
   * Nightly (00:30 UTC, see wrangler.jsonc): roll the completed day up into the
   * daily_* tables and purge raw events past the retention window. Awaited rather
   * than backgrounded so a failure marks the cron run failed — everything it does is
   * an idempotent upsert or a bounded delete, so the retry is safe.
   */
  async scheduled(event, env): Promise<void> {
    await runNightly(env, event.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
