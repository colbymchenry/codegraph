/**
 * codegraph telemetry dashboard — stats.getcodegraph.com
 *
 * The private counterpart to `telemetry-worker/`: that one writes events into
 * D1, this one reads them back for the two people who look at the numbers.
 *
 * Everything is deny-by-default. `assets.run_worker_first` is `true` in
 * wrangler.jsonc, so the static-asset server never sees a request this file has
 * not already authorised — the only unauthenticated surface is the login page,
 * which the worker renders inline, and robots.txt.
 *
 * D1 is read-only here. Writes belong to the ingest worker's cron.
 */

import { handleApi } from './api';
import {
  checkPassword,
  clearedSessionCookie,
  hasValidSession,
  isSameOriginPost,
  issueSession,
  sessionCookie,
} from './auth';
import { renderLoginPage } from './login-page';

const MAX_LOGIN_BODY_BYTES = 4 * 1024;

const ROBOTS_TXT = 'User-agent: *\nDisallow: /\n';

/**
 * Security headers for every response. `styleNonce` is only passed for the
 * inline-styled login page; asset-served pages link a stylesheet instead.
 */
function securityHeaders(styleNonce?: string): Record<string, string> {
  const styleSrc = styleNonce ? `'self' 'nonce-${styleNonce}'` : "'self'";
  return {
    'content-security-policy': [
      "default-src 'none'",
      "script-src 'self'",
      `style-src ${styleSrc}`,
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "form-action 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
  };
}

function withSecurityHeaders(response: Response, styleNonce?: string): Response {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(securityHeaders(styleNonce))) {
    out.headers.set(name, value);
  }
  return out;
}

/**
 * Builds the response headers. Extras go through `new Headers(...)` rather than
 * an object spread: spreading a `Headers` instance silently yields `{}`, and
 * losing a `set-cookie` that way would be a very quiet bug.
 */
function headersWith(defaults: Record<string, string>, extra?: HeadersInit): Headers {
  const headers = new Headers(defaults);
  if (extra) {
    for (const [name, value] of new Headers(extra)) headers.set(name, value);
  }
  return headers;
}

function html(body: string, init: ResponseInit & { nonce?: string } = {}): Response {
  const { nonce, headers, ...rest } = init;
  return withSecurityHeaders(
    new Response(body, {
      ...rest,
      headers: headersWith(
        {
          'content-type': 'text/html; charset=utf-8',
          // Never let a page render from cache after sign-out.
          'cache-control': 'no-store',
        },
        headers,
      ),
    }),
    nonce,
  );
}

function json(body: unknown, init: ResponseInit = {}): Response {
  const { headers, ...rest } = init;
  return withSecurityHeaders(
    new Response(JSON.stringify(body), {
      ...rest,
      headers: headersWith(
        {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
        headers,
      ),
    }),
  );
}

function redirect(location: string, init: ResponseInit = {}): Response {
  const { headers, status, ...rest } = init;
  return withSecurityHeaders(
    new Response(null, {
      ...rest,
      status: status ?? 302,
      headers: headersWith({ location, 'cache-control': 'no-store' }, headers),
    }),
  );
}

/**
 * Only same-origin absolute paths survive, so `?next=` can never become an open
 * redirect. `//evil.example` and `/\evil.example` are protocol-relative URLs in
 * a browser, not paths — hence the second character check.
 */
function safeNextPath(candidate: string | null): string {
  if (!candidate || !candidate.startsWith('/')) return '/';
  if (candidate.startsWith('//') || candidate.startsWith('/\\')) return '/';
  return candidate;
}

function loginRedirect(url: URL): Response {
  const next = `${url.pathname}${url.search}`;
  const target = next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`;
  return redirect(target);
}

function nonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Best-effort brute-force cap on the shared password, keyed by client IP. */
async function loginRateLimitOk(env: Env, request: Request): Promise<boolean> {
  // Note for auditors: unlike the ingest worker — which never reads the client
  // IP — this admin login does, purely as a rate-limit key. It is not stored,
  // logged or forwarded anywhere.
  const key = request.headers.get('cf-connecting-ip') ?? 'unknown';
  try {
    const { success } = await env.LOGIN_RATE_LIMITER.limit({ key });
    return success;
  } catch (err) {
    // Fail open: a rate-limiter outage must not lock the maintainer out, and
    // the password is still required either way.
    console.error(JSON.stringify({ msg: 'login rate limiter unavailable', err: String(err) }));
    return true;
  }
}

async function handleLoginPage(env: Env, request: Request, url: URL): Promise<Response> {
  const next = safeNextPath(url.searchParams.get('next'));
  if (await hasValidSession(env, request)) return redirect(next);
  const styleNonce = nonce();
  return html(renderLoginPage({ next, nonce: styleNonce }), { nonce: styleNonce });
}

async function handleLoginSubmit(env: Env, request: Request): Promise<Response> {
  if (!isSameOriginPost(request)) {
    return new Response('bad request\n', { status: 400 });
  }

  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_LOGIN_BODY_BYTES) {
    return new Response('payload too large\n', { status: 413 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return new Response('bad request\n', { status: 400 });
  }

  const next = safeNextPath(String(form.get('next') ?? '/'));
  const password = form.get('password');
  const styleNonce = nonce();
  const fail = (error: string, status: number): Response =>
    html(renderLoginPage({ next, error, nonce: styleNonce }), { status, nonce: styleNonce });

  if (!(await loginRateLimitOk(env, request))) {
    return fail('Too many attempts. Wait a minute and try again.', 429);
  }
  if (typeof password !== 'string' || password.length === 0) {
    return fail('Enter the password to continue.', 400);
  }
  if (!(await checkPassword(env, password))) {
    return fail('That password is not right.', 401);
  }

  return redirect(next, { headers: { 'set-cookie': sessionCookie(await issueSession(env)) } });
}

/**
 * The chart endpoints live in src/api.ts and return data, not responses, so this
 * file stays the single place that decides headers on an authenticated reply.
 * Everything under `/api/` is behind the same session check as the pages.
 */
async function apiResponse(env: Env, url: URL): Promise<Response> {
  const result = await handleApi(env, url);
  return json(result.body, {
    status: result.status,
    // Chart data is daily-granular, so a few minutes in the browser's private
    // cache saves D1 a round of identical queries on every panel re-render.
    // Anything without an explicit lifetime keeps the no-store default.
    headers: result.cacheControl ? { 'cache-control': result.cacheControl } : undefined,
  });
}

/** Gated static assets: the dashboard shell, its JS, its CSS, the chart library. */
async function serveAsset(env: Env, request: Request): Promise<Response> {
  const asset = await env.ASSETS.fetch(request);
  const out = withSecurityHeaders(asset);
  // Behind a session, so it must never land in a shared cache.
  out.headers.set('cache-control', 'private, no-cache');
  out.headers.set('vary', 'cookie');
  return out;
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const method = request.method;
      const isRead = method === 'GET' || method === 'HEAD';

      // --- unauthenticated surface: exactly these three routes ---------------
      if (isRead && url.pathname === '/robots.txt') {
        return new Response(ROBOTS_TXT, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
      if (url.pathname === '/login') {
        if (isRead) return await handleLoginPage(env, request, url);
        if (method === 'POST') return await handleLoginSubmit(env, request);
        return new Response('method not allowed\n', { status: 405, headers: { allow: 'GET, POST' } });
      }
      if (url.pathname === '/logout') {
        if (method !== 'POST') {
          return new Response('method not allowed\n', { status: 405, headers: { allow: 'POST' } });
        }
        if (!isSameOriginPost(request)) return new Response('bad request\n', { status: 400 });
        return redirect('/login', { headers: { 'set-cookie': clearedSessionCookie() } });
      }

      // --- everything else needs a session -----------------------------------
      const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
      if (!(await hasValidSession(env, request))) {
        return isApi ? json({ error: 'unauthorized' }, { status: 401 }) : loginRedirect(url);
      }

      if (isApi) {
        if (!isRead) {
          return json({ error: 'method not allowed' }, { status: 405, headers: { allow: 'GET' } });
        }
        return await apiResponse(env, url);
      }

      if (!isRead) {
        return new Response('method not allowed\n', { status: 405, headers: { allow: 'GET' } });
      }
      return await serveAsset(env, request);
    } catch (err) {
      console.error(JSON.stringify({ msg: 'unhandled error', err: String(err) }));
      return new Response('internal error\n', { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
