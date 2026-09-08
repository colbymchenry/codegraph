/**
 * Static file serving for the viewer's own bundle (`dist/viewer/`).
 *
 * Deliberately small: a MIME table, a stream, and the SPA fallback. Everything
 * that decides WHETHER a path may be read lives in `security.ts`.
 */

import * as fs from 'fs';
import type { ServerResponse } from 'http';
import * as path from 'path';

/**
 * Content types for everything the Vite build emits, plus the handful of things
 * a future viewer asset might be. Unknown extensions fall back to
 * `application/octet-stream`, which — with `X-Content-Type-Options: nosniff` —
 * a browser will download rather than execute.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
};

/** The content type to send for a file, by extension. */
export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Cache policy.
 *
 * Vite content-hashes everything under `assets/`, so those are immutable for a
 * year — a reload of the viewer refetches nothing, and an upgraded CodeGraph
 * changes the hash and therefore the URL. `index.html` names those hashes, so
 * it must never be cached.
 */
export function cacheControlFor(relativePath: string): string {
  const normalized = relativePath.split(path.sep).join('/');
  return normalized.startsWith('assets/')
    ? 'public, max-age=31536000, immutable'
    : 'no-store';
}

/**
 * Stream a file as the response body.
 *
 * `HEAD` gets identical headers and no body — it is a GET whose body the client
 * asked us to skip, which keeps it read-only by construction.
 */
export function sendFile(
  res: ServerResponse,
  absolutePath: string,
  options: { rootDir: string; method: string; extraHeaders?: Record<string, string> }
): void {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(absolutePath);
  } catch {
    sendText(res, 404, 'Not found', options.method);
    return;
  }

  const relative = path.relative(options.rootDir, absolutePath);
  res.writeHead(200, {
    'Content-Type': contentTypeFor(absolutePath),
    'Content-Length': String(stats.size),
    'Cache-Control': cacheControlFor(relative),
    'Last-Modified': stats.mtime.toUTCString(),
    ...options.extraHeaders,
  });

  if (options.method === 'HEAD') {
    res.end();
    return;
  }

  const stream = fs.createReadStream(absolutePath);
  stream.on('error', () => {
    // Headers are already out, so there is no status left to change: drop the
    // connection so the client sees a truncated body rather than a silent lie.
    res.destroy();
  });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

/** Send a plain-text status response (the error path for a browser or curl). */
export function sendText(res: ServerResponse, status: number, message: string, method: string): void {
  const body = Buffer.from(message.endsWith('\n') ? message : `${message}\n`, 'utf-8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(body.byteLength),
    'Cache-Control': 'no-store',
  });
  res.end(method === 'HEAD' ? undefined : body);
}

/** Send a JSON response. Used for `/api/*`, which must never get HTML back. */
export function sendJson(res: ServerResponse, status: number, payload: unknown, method: string): void {
  const body = Buffer.from(JSON.stringify(payload), 'utf-8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.byteLength),
    'Cache-Control': 'no-store',
  });
  res.end(method === 'HEAD' ? undefined : body);
}

/**
 * Whether a request path should fall back to `index.html` when no file matches.
 *
 * The viewer is hash-routed (`/#/s/<id>`), so in practice only `/` is ever
 * requested — but a bookmarked or hand-typed `/anything` should still open the
 * app rather than a 404 page. A path that names a FILE (has an extension) never
 * falls back: answering `/assets/index-abc123.js` with HTML would hand the
 * browser a script that is not a script, and hide a genuinely missing asset
 * behind a page that looks like it loaded.
 */
export function shouldFallBackToIndex(pathname: string): boolean {
  return path.extname(pathname) === '';
}
