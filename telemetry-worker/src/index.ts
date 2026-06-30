/**
 * codegraph telemetry ingest — telemetry.getcodegraph.com
 *
 * This file is public on purpose: it is the exact code that receives codegraph's
 * anonymous usage telemetry, so anyone can audit what is (and is not) stored.
 * The schema contract lives in docs/design/telemetry.md.
 *
 * Guarantees enforced here:
 * - strict allowlist: unknown events are dropped, unknown properties are stripped
 * - the client IP is never read, logged, or forwarded
 * - per-machine rate limiting, bounded body/batch sizes
 * - forwarding happens off the response path (ctx.waitUntil); bodies are never logged
 */

const MAX_BODY_BYTES = 64 * 1024;
const MAX_EVENTS_PER_BATCH = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Bare identifiers: tool/command/target/language names, versions.
const TOKEN_RE = /^[A-Za-z0-9_.:+-]+$/;
// Human-ish labels: MCP clientInfo names like "Claude Code", "cursor-vscode/1.2".
const LABEL_RE = /^[A-Za-z0-9_.:+/ @()-]+$/;

const INFO_TEXT = `codegraph anonymous-telemetry ingest.

What gets collected (and what never does) is documented field-by-field:
https://github.com/colbymchenry/codegraph/blob/main/docs/design/telemetry.md
This endpoint's full source:
https://github.com/colbymchenry/codegraph/tree/main/telemetry-worker

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

interface PostHogEvent {
  event: string;
  distinct_id: string;
  timestamp?: string;
  properties: JsonObject;
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

function sanitizeEvent(raw: unknown, machineId: string, common: JsonObject): PostHogEvent | null {
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

  const out: PostHogEvent = {
    event: e.event,
    distinct_id: machineId,
    properties: {
      ...props,
      ...common,
      // Anonymous events: no person profiles, no geo enrichment.
      $process_person_profile: false,
      $geoip_disable: true,
      $lib: 'codegraph-telemetry-worker',
    },
  };
  const ts = clampTimestamp(e.ts);
  if (ts !== undefined) out.timestamp = ts;
  return out;
}

async function forwardToPostHog(env: Env, batch: PostHogEvent[]): Promise<void> {
  try {
    const res = await fetch(`${env.POSTHOG_HOST}/batch/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: env.POSTHOG_KEY, batch }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.error(JSON.stringify({ msg: 'posthog forward failed', status: res.status, events: batch.length }));
    }
  } catch (err) {
    console.error(JSON.stringify({ msg: 'posthog forward error', err: String(err), events: batch.length }));
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (request.method === 'GET' && url.pathname === '/') {
        return new Response(INFO_TEXT, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
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
      const batch: PostHogEvent[] = [];
      for (const raw of rawEvents) {
        const sanitized = sanitizeEvent(raw, machineId, common);
        if (sanitized) batch.push(sanitized);
      }

      if (batch.length > 0) {
        ctx.waitUntil(forwardToPostHog(env, batch));
      }
      // Accepted (including "everything was dropped by the allowlist") — the
      // client treats every response as final and never retries.
      return new Response(null, { status: 204 });
    } catch (err) {
      console.error(JSON.stringify({ msg: 'unhandled error', err: String(err) }));
      return new Response('internal error\n', { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
