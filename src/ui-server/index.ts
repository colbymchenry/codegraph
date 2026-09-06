/**
 * The `codegraph ui` server.
 *
 * A loopback-only `node:http` server that hands the browser the built viewer
 * (`dist/viewer/`) and, through the JSON API mounted on the `api` seam below
 * (`./api`), a view of one indexed project. No framework, no new dependency: it
 * answers GET, serves files, and refuses everything else.
 *
 * It is a reader with one exception, added deliberately and scoped as narrowly
 * as it could be: `POST`/`DELETE /api/trails` saves and removes the reader's own
 * named trails, as JSON files under `.codegraph/ui/trails/`. Nothing else it
 * serves has a side effect, no other path accepts a write, and `--read-only`
 * turns even that one off. See `security.ts` for what a write has to carry.
 *
 * The interesting part is not the routing, it is the boundary in `security.ts`.
 * Read that first.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { resolveViewerDir } from './assets';
import {
  ALLOWED_METHODS,
  READ_METHODS,
  WRITE_HEADER,
  isAllowedHost,
  isAllowedOrigin,
  isSafeRequestPath,
  isWriteMethod,
  isWriteRequest,
  resolveStaticAsset,
} from './security';
import { sendFile, sendJson, sendText, shouldFallBackToIndex } from './static';
import { DEFAULT_PORT_ATTEMPTS, DEFAULT_UI_PORT, LOOPBACK_ADDRESS } from './constants';

export { ViewerMissingError } from './assets';
export {
  BROWSER_ENV,
  DEFAULT_PORT_ATTEMPTS,
  DEFAULT_UI_PORT,
  LOOPBACK_ADDRESS,
  VIEWER_PATH_ENV,
} from './constants';
export {
  ALLOWED_METHODS,
  READ_METHODS,
  WRITE_HEADER,
  WRITE_METHODS,
  PathRefusalError,
  isAllowedHost,
  isAllowedOrigin,
  isSafeRequestPath,
  isWriteMethod,
  isWriteRequest,
  resolveProjectFile,
  resolveStaticAsset,
} from './security';
export { browserOpenCommand, openBrowser } from './open-browser';
export { contentTypeFor, cacheControlFor } from './static';
export { createGraphApi, GraphSession, ApiError } from './api';
export type { GraphApi, GraphApiOptions } from './api';


/**
 * Everything a request handler needs, already validated.
 */
export interface UiRequestContext {
  /** Percent-decoded path portion of the request URL, always starting with `/`. */
  pathname: string;
  /** Parsed query string. */
  query: URLSearchParams;
  /** Absolute path of the indexed project this server is reading. */
  projectRoot: string;
  /**
   * The request method. `GET` or `HEAD` for every read; `POST` or `DELETE`
   * only for a request that already passed {@link isWriteRequest}, which is
   * `/api/trails` and nothing else.
   */
  method: string;
}

/**
 * A handler mounted under `/api/`. Returns `true` when it answered the request
 * (i.e. wrote a response), `false` to fall through to a 404.
 *
 * This is the seam the JSON API plugs into. Everything it reads out of — or
 * writes into — the user's repository must go through `resolveProjectFile`;
 * see `security.ts`.
 */
export type UiApiHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: UiRequestContext
) => boolean | Promise<boolean>;

export interface UiServerOptions {
  /** Absolute path of the indexed project to read. */
  projectRoot: string;
  /**
   * Port to bind. `0` lets the OS choose. Defaults to {@link DEFAULT_UI_PORT}.
   */
  port?: number;
  /**
   * Try the next port when the requested one is taken (default `true`).
   *
   * The CLI turns this OFF for an explicit `--port`: a scripted invocation that
   * silently lands somewhere else is worse than one that says the port is busy.
   */
  portFallback?: boolean;
  /** How many ports to try in total. Defaults to {@link DEFAULT_PORT_ATTEMPTS}. */
  maxPortAttempts?: number;
  /** Directory of built viewer assets. Defaults to the shipped `dist/viewer/`. */
  viewerDir?: string;
  /** Optional read-only JSON API mounted under `/api/`. */
  api?: UiApiHandler;
}

export interface UiServerHandle {
  /** The port actually bound (may differ from the requested one — see fallback). */
  port: number;
  /** The URL to open. */
  url: string;
  /** Directory being served as the viewer. */
  viewerDir: string;
  /** The underlying server, for tests and for callers that want raw events. */
  server: http.Server;
  /** Stop listening and drop live connections. Idempotent. */
  close(): Promise<void>;
}

/**
 * Response headers sent on EVERY response.
 *
 * `frame-ancestors`/`X-Frame-Options` stop another page from framing the viewer
 * and reading it by overlay; `nosniff` stops an asset with a surprising
 * extension from being executed as script; the CSP pins every resource to this
 * origin, so a future viewer change cannot start phoning out with what it read.
 * `style-src` keeps `'unsafe-inline'` because the syntax highlighter emits
 * inline `style=` attributes on code spans.
 *
 * Note what is NOT here: any `Access-Control-*` header. Their absence is what
 * makes a cross-origin read of a response body impossible even if a request
 * somehow gets past the `Host` check.
 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
};

/**
 * Start the viewer server.
 *
 * Resolves once the socket is bound, so the caller can print a URL that is
 * already answering.
 */
export async function startUiServer(options: UiServerOptions): Promise<UiServerHandle> {
  // realpath, not just resolve: `resolveStaticAsset` hands back realpaths (the
  // symlink check in `validatePathWithinRoot` resolves them), so a viewerDir
  // that still holds a symlink — every macOS `/var/folders` temp dir, plenty of
  // package managers — would make `path.relative` between the two nonsense, and
  // the cache policy that keys off it silently wrong.
  const viewerDir = options.viewerDir ? realpath(options.viewerDir) : resolveViewerDir();
  const projectRoot = path.resolve(options.projectRoot);
  const indexHtml = path.join(viewerDir, 'index.html');

  // The bound port is needed by the Host check, but is only known after listen.
  // Captured by reference so the handler always sees the real value.
  let boundPort = 0;

  const server = http.createServer((req, res) => {
    handleRequest(req, res, {
      viewerDir,
      indexHtml,
      projectRoot,
      api: options.api,
      port: () => boundPort,
    }).catch(() => {
      // handleRequest already answers every error it can; reaching here means
      // the socket itself is gone. Never let it become an unhandled rejection,
      // which the CLI's fatal handlers would turn into a process exit.
      if (!res.writableEnded) res.destroy();
    });
  });

  // A browser holds keep-alive sockets open; without this, `close()` would wait
  // for them and Ctrl-C would appear to hang.
  server.keepAliveTimeout = 5_000;

  boundPort = await listenWithFallback(server, {
    port: options.port ?? DEFAULT_UI_PORT,
    fallback: options.portFallback ?? true,
    attempts: options.maxPortAttempts ?? DEFAULT_PORT_ATTEMPTS,
  });

  let closed = false;
  return {
    port: boundPort,
    url: `http://${LOOPBACK_ADDRESS}:${boundPort}`,
    viewerDir,
    server,
    close(): Promise<void> {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}

interface HandlerDeps {
  viewerDir: string;
  indexHtml: string;
  projectRoot: string;
  api: UiApiHandler | undefined;
  port: () => number;
}

/**
 * One request, start to finish. Order matters: the cheap refusals (method,
 * `Host`, `Origin`) run before anything touches the filesystem.
 */
async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: HandlerDeps
): Promise<void> {
  const method = req.method ?? 'GET';
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(name, value);
  }

  if (!ALLOWED_METHODS.includes(method)) {
    res.setHeader('Allow', ALLOWED_METHODS.join(', '));
    sendText(res, 405, `codegraph ui does not answer ${method}.`, method);
    return;
  }

  const port = deps.port();
  if (!isAllowedHost(req.headers.host, port)) {
    // The DNS-rebinding refusal. Say why, since a human hitting this through a
    // proxy or a container hostname needs to know what to change.
    sendText(
      res,
      403,
      'Refused: codegraph ui only answers requests addressed to this machine ' +
        `(localhost, 127.0.0.1 or [::1] on port ${port}).\n` +
        `This request said Host: ${forEcho(req.headers.host)}`,
      method
    );
    return;
  }

  if (!isAllowedOrigin(readHeader(req, 'origin'), port)) {
    sendText(res, 403, 'Refused: cross-origin requests are not served.', method);
    return;
  }

  // Checked on the RAW url, before WHATWG parsing folds `..` segments away.
  const rawPath = (req.url ?? '/').split(/[?#]/)[0] ?? '/';
  // The `/api/` namespace answers JSON for EVERY outcome, refusals included:
  // the viewer parses these responses, and a text/plain body here would surface
  // as a parse error instead of the refusal it actually is.
  const jsonNamespace = rawPath === '/api' || rawPath.startsWith('/api/');

  // The one place this server stops being a pure reader. A write has to be
  // under /api/ and carry the marker header — see `isWriteRequest` for what
  // that closes that Host and Origin do not.
  if (isWriteMethod(method)) {
    const verdict = isWriteRequest(rawPath, {
      marker: readHeader(req, WRITE_HEADER),
      contentType: readHeader(req, 'content-type'),
    });
    if (!verdict.ok) {
      if (!jsonNamespace) res.setHeader('Allow', READ_METHODS.join(', '));
      const body = `Refused: ${verdict.reason}`;
      if (jsonNamespace) sendJson(res, 403, { error: body, code: 'refused' }, method);
      else sendText(res, 405, body, method);
      return;
    }
  }

  if (!isSafeRequestPath(rawPath)) {
    if (jsonNamespace) {
      sendJson(res, 404, { error: 'Not found', code: 'not-found' }, method);
    } else {
      sendText(res, 404, 'Not found', method);
    }
    return;
  }

  let url: URL;
  try {
    url = new URL(req.url ?? '/', `http://${LOOPBACK_ADDRESS}:${port}`);
  } catch {
    sendText(res, 400, 'Bad request URL.', method);
    return;
  }

  // `/api/` is reserved — it must 404 as JSON rather than fall through to the
  // SPA, or a typo'd endpoint returns 200 + HTML and the viewer parses the app
  // shell as a payload.
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    const ctx: UiRequestContext = {
      pathname: safeDecode(url.pathname),
      query: url.searchParams,
      projectRoot: deps.projectRoot,
      method,
    };
    if (deps.api) {
      try {
        if (await deps.api(req, res, ctx)) return;
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) }, method);
        } else {
          res.destroy();
        }
        return;
      }
    }
    if (!res.headersSent) sendJson(res, 404, { error: `No such endpoint: ${url.pathname}` }, method);
    return;
  }

  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = resolveStaticAsset(deps.viewerDir, requested);
  if (file) {
    sendFile(res, file, { rootDir: deps.viewerDir, method });
    return;
  }

  if (shouldFallBackToIndex(url.pathname)) {
    sendFile(res, deps.indexHtml, { rootDir: deps.viewerDir, method });
    return;
  }

  sendText(res, 404, 'Not found', method);
}

/** `path.resolve` + symlink resolution, falling back when the path is missing. */
function realpath(dir: string): string {
  const resolved = path.resolve(dir);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Bound and de-fang an attacker-supplied header before echoing it back.
 *
 * The refused `Host` is worth showing — a human hitting this through a proxy or
 * a container hostname needs to know what was actually sent. But it is
 * attacker-chosen text, so it goes out truncated and stripped of control bytes.
 * (The response is `text/plain` + `nosniff`, so there is nothing to inject
 * into; this is belt and braces.)
 */
function forEcho(value: string | undefined): string {
  if (!value) return '(none)';
  // eslint-disable-next-line no-control-regex -- stripping raw control bytes IS the point
  const clean = value.replace(/[\x00-\x1f\x7f]/g, '?');
  return clean.length > 100 ? `${clean.slice(0, 100)}…` : clean;
}

/** Read a header as a single string (node gives arrays for some headers). */
function readHeader(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/** Percent-decode for display; the raw value is used for anything security-relevant. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Bind the first free port at or after `port`, on loopback only.
 *
 * Only `EADDRINUSE` advances to the next port — a permission failure or a bad
 * address will not get better one port over, and retrying twenty times would
 * only bury the real error.
 */
async function listenWithFallback(
  server: http.Server,
  opts: { port: number; fallback: boolean; attempts: number }
): Promise<number> {
  // Port 0 means "any free port", so there is nothing to fall back from.
  const attempts = opts.port === 0 || !opts.fallback ? 1 : Math.max(1, opts.attempts);

  for (let i = 0; i < attempts; i++) {
    const candidate = opts.port === 0 ? 0 : opts.port + i;
    try {
      await listenOnce(server, candidate);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('The UI server bound to an unexpected address.');
      }
      return address.port;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' || i === attempts - 1) {
        throw describeBindFailure(err, candidate, opts);
      }
    }
  }
  /* istanbul ignore next — the loop either returns or throws */
  throw new Error('The UI server could not bind a port.');
}

/**
 * One `listen()` attempt, with both outcomes as a promise.
 *
 * The same `http.Server` is reused across attempts: a `listen()` that failed
 * with EADDRINUSE never took a handle, so it can be listened on again directly
 * (verified on Node 20 and 22 — `server.listening` is still `false` afterwards,
 * and `close()` on a never-listening server would itself throw).
 */
function listenOnce(server: http.Server, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, LOOPBACK_ADDRESS);
  });
}

/** Turn a bind failure into something a user can act on. */
function describeBindFailure(
  err: unknown,
  port: number,
  opts: { port: number; fallback: boolean; attempts: number }
): Error {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'EADDRINUSE') {
    return opts.fallback
      ? new Error(
          `Ports ${opts.port}–${port} are all in use. Free one, or pick another with --port.`
        )
      : new Error(`Port ${port} is already in use. Pick another with --port, or omit --port to let CodeGraph find a free one.`);
  }
  if (code === 'EACCES') {
    return new Error(`Not allowed to listen on port ${port}. Ports below 1024 usually need elevated privileges — pick a higher one with --port.`);
  }
  return err instanceof Error ? err : new Error(String(err));
}
