/**
 * The `codegraph ui` server's security boundary.
 *
 * Threat model, stated plainly: this process serves a browser-readable view of
 * the user's SOURCE CODE from a port on their machine. It binds loopback, so
 * nothing on the network can reach it. That leaves one realistic attack —
 * **DNS rebinding**: any page the user visits can point `evil.example` at
 * `127.0.0.1` and then have the browser issue same-origin requests to us. The
 * browser will happily connect; the only thing that distinguishes the attacker's
 * request from the viewer's own is the `Host` header, which the browser fills in
 * from the URL and script cannot forge.
 *
 * So the rules are:
 *
 * - **`Host` must be a loopback name** (`localhost`, `127.0.0.1`, `[::1]`) and,
 *   if it carries a port, that port must be ours. Anything else is 403.
 * - **`Origin`, when present, must be loopback too.** Belt and braces: absent on
 *   the viewer's own same-origin GETs, and present-and-foreign only on a
 *   cross-site request we want nothing to do with.
 * - **No CORS headers, ever.** Not adding `Access-Control-Allow-Origin` is what
 *   keeps a cross-origin reader from seeing a response body even if it does
 *   reach us. There is deliberately no way to turn this on.
 * - **GET/HEAD everywhere; POST/DELETE only under `/api/`, and only for a
 *   request that could not have been forged by a form.** See
 *   {@link isWriteRequest} below — the viewer went from a pure reader to one
 *   that saves trails into `.codegraph/ui/`, and that is the entire change to
 *   this boundary.
 * - **Every path resolves through {@link validatePathWithinRoot}** — the same
 *   chokepoint the MCP read sinks use, which catches `../` traversal AND
 *   in-tree symlinks pointing out of the root (#527).
 */

import * as fs from 'fs';
import * as path from 'path';
import { PathRefusalError } from '../errors';
import { validatePathWithinRoot, validateProjectPath } from '../utils';

export { PathRefusalError };

/**
 * Host names that mean "this machine". A browser only ever sends the bracketed
 * form for IPv6, but the raw form is accepted after brackets are stripped.
 */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1']);

/** Methods that answer anywhere: the viewer's assets and every read endpoint. */
export const READ_METHODS: readonly string[] = ['GET', 'HEAD'];

/**
 * Methods that answer under `/api/` only, and only for a request carrying
 * {@link WRITE_HEADER}. The viewer's one write is a saved trail.
 */
export const WRITE_METHODS: readonly string[] = ['POST', 'DELETE'];

/** HTTP methods the viewer server answers at all. Everything else is 405. */
export const ALLOWED_METHODS: readonly string[] = [...READ_METHODS, ...WRITE_METHODS];

/**
 * The header a write has to carry.
 *
 * Belt and braces behind the `Host` and `Origin` checks, and worth the two
 * lines because it fails *differently*: a custom request header cannot be sent
 * cross-origin without a CORS preflight, and this server answers no preflight
 * and sends no `Access-Control-*` header, so the browser never issues the real
 * request. That closes the one shape those checks lean on a header for — a
 * `<form method="post">` submitted from another page, which sends no `Origin`
 * in some older browsers and cannot set a custom header in any of them.
 */
export const WRITE_HEADER = 'x-codegraph-ui';

/** The content type a write body must declare. A form can send none of these. */
const WRITE_CONTENT_TYPE = 'application/json';

export function isWriteMethod(method: string): boolean {
  return WRITE_METHODS.includes(method);
}

/**
 * Whether a mutating request is one the viewer could have made.
 *
 * @param method     the request method, already known to be a write method
 * @param pathname   the raw request path
 * @param headers    `x-codegraph-ui` and, for a body-carrying method, `content-type`
 */
export function isWriteRequest(
  pathname: string,
  headers: { marker: string | undefined; contentType: string | undefined }
): { ok: true } | { ok: false; reason: string } {
  // Writes live under /api/ and nowhere else. The static side of this server
  // serves a built bundle; there is nothing there to POST to.
  if (pathname !== '/api' && !pathname.startsWith('/api/')) {
    return { ok: false, reason: 'Only the /api/ endpoints accept writes.' };
  }
  if (headers.marker === undefined || headers.marker.trim() === '') {
    return { ok: false, reason: `A write must carry the ${WRITE_HEADER} header.` };
  }
  if (headers.contentType !== undefined) {
    const type = headers.contentType.split(';')[0]?.trim().toLowerCase();
    if (type !== '' && type !== WRITE_CONTENT_TYPE) {
      return { ok: false, reason: `A write body must be ${WRITE_CONTENT_TYPE}.` };
    }
  }
  return { ok: true };
}

interface HostParts {
  hostname: string;
  /** `undefined` when the header carried no `:port` suffix. */
  port: number | undefined;
}

/**
 * Split a `Host` header into hostname and port, or `null` if it is malformed.
 *
 * An unbracketed IPv6 literal (`::1`) is malformed per RFC 7230 and is rejected
 * rather than guessed at — no browser produces one, so accepting it would only
 * widen the parser for an attacker's benefit.
 */
function splitHostPort(host: string): HostParts | null {
  const trimmed = host.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end < 0) return null;
    const port = parsePortSuffix(trimmed.slice(end + 1));
    if (port === null) return null;
    return { hostname: trimmed.slice(1, end), port };
  }

  const colon = trimmed.indexOf(':');
  if (colon === -1) return { hostname: trimmed, port: undefined };
  // A second colon without brackets is a bare IPv6 literal or junk.
  if (trimmed.indexOf(':', colon + 1) !== -1) return null;
  const port = parsePortSuffix(trimmed.slice(colon));
  if (port === null) return null;
  return { hostname: trimmed.slice(0, colon), port };
}

/**
 * Parse the `:1234` tail of a `Host` header.
 *
 * @returns the port, `undefined` for an empty suffix, or `null` when the suffix
 *   is present but not a plain port number.
 */
function parsePortSuffix(suffix: string): number | undefined | null {
  if (suffix === '') return undefined;
  if (!suffix.startsWith(':')) return null;
  const digits = suffix.slice(1);
  if (!/^\d{1,5}$/.test(digits)) return null;
  const port = Number(digits);
  return port >= 0 && port <= 65535 ? port : null;
}

/**
 * Whether a request's `Host` header names this loopback server.
 *
 * A missing `Host` is rejected: HTTP/1.1 requires it, and the one client that
 * may legally omit it (HTTP/1.0) is not a browser we need to serve.
 */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (typeof host !== 'string') return false;
  const parts = splitHostPort(host);
  if (!parts) return false;
  if (!LOOPBACK_HOSTNAMES.has(parts.hostname.toLowerCase())) return false;
  return parts.port === undefined || parts.port === port;
}

/**
 * Whether a request's `Origin` header is acceptable.
 *
 * An ABSENT `Origin` is allowed — browsers omit it on same-origin GETs, which
 * is every request the viewer makes. A present one must be loopback-on-our-port;
 * the literal `null` origin (sandboxed iframe, `file://` page) is refused.
 */
export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true;
  const trimmed = origin.trim();
  if (trimmed === '') return true;
  if (trimmed === 'null') return false;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  // WHATWG keeps IPv6 hostnames bracketed; the allowlist stores them bare.
  const hostname = url.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (!LOOPBACK_HOSTNAMES.has(hostname)) return false;
  return url.port === '' || Number(url.port) === port;
}

/**
 * Whether a raw request path is worth resolving at all.
 *
 * Rejects any `..` segment outright rather than letting containment sort it
 * out later. Containment WOULD catch it — but the SPA fallback sits behind
 * containment, so `GET /../../etc/passwd` would otherwise be answered with the
 * app shell (a 200) instead of the 404 a traversal attempt deserves. Nothing
 * outside the root leaks either way; this just stops the server from
 * pretending a hostile path was an ordinary route.
 *
 * Takes the RAW path from `req.url`, before WHATWG URL parsing folds `..`
 * segments away — that folding is what would hide the attempt.
 */
export function isSafeRequestPath(rawPath: string): boolean {
  const decoded = decodePath(rawPath);
  if (decoded === null) return false;
  return !decoded.split('/').includes('..');
}

/**
 * Resolve a request path to a file inside the static asset root.
 *
 * Returns the absolute path, or `null` for anything that is not a readable file
 * inside `rootDir` — a traversal attempt, a symlink escape, a directory, a
 * missing file. Callers turn `null` into a 404 (never a 403): telling a prober
 * which of those it hit is free information.
 *
 * Percent-decoding happens HERE, before containment is checked, so an encoded
 * `..%2f` is caught by the same guard as a literal `../`.
 */
export function resolveStaticAsset(rootDir: string, urlPath: string): string | null {
  const decoded = decodePath(urlPath);
  if (decoded === null) return null;

  const relative = decoded.replace(/^\/+/, '');
  const absolute = validatePathWithinRoot(rootDir, relative);
  if (!absolute) return null;

  try {
    return fs.statSync(absolute).isFile() ? absolute : null;
  } catch {
    return null;
  }
}

/**
 * Percent-decode a URL path and reject the encodings that only ever show up in
 * an attack: NUL (truncates a path in some syscalls), other C0 control bytes,
 * and backslashes (a separator on Windows, a legal filename character on POSIX
 * — treating it as a separator everywhere is the safe direction, and no built
 * asset name contains one).
 *
 * @returns the decoded path, or `null` if it is unusable.
 */
function decodePath(urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // malformed percent-encoding
  }
  // eslint-disable-next-line no-control-regex -- rejecting raw control bytes IS the point
  if (/[\x00-\x1f\x7f\\]/.test(decoded)) return null;
  return decoded;
}

/**
 * Resolve a project-relative source path to an absolute path that is safe to
 * read and hand to the browser.
 *
 * This is the single read chokepoint for anything served OUT OF THE USER'S
 * REPOSITORY (as opposed to the viewer's own bundled assets). The JSON API
 * built on top of this server must route every file read through it — that is
 * what keeps `/api/source?path=../../.ssh/id_rsa` from being a credential leak
 * over a port the user opened to read their own code.
 *
 * @throws {PathRefusalError} when the root is a sensitive system directory, or
 *   the path escapes the root by traversal or symlink.
 */
export function resolveProjectFile(projectRoot: string, relativePath: string): string {
  if (typeof relativePath !== 'string' || relativePath.trim() === '') {
    throw new PathRefusalError('No file path was given.');
  }
  const decoded = decodePath(relativePath);
  if (decoded === null) {
    throw new PathRefusalError(`Refusing to read an unusable path: ${relativePath}`);
  }

  // Sensitive-directory refusal, same list the MCP entry points use. Checked on
  // the ROOT rather than the leaf: a root of `/etc` makes every path under it
  // sensitive, and a leaf check would have to enumerate the world.
  const rootError = validateProjectPath(projectRoot);
  if (rootError) throw new PathRefusalError(rootError);

  if (path.isAbsolute(decoded)) {
    throw new PathRefusalError(`Refusing to read an absolute path: ${decoded}`);
  }

  const absolute = validatePathWithinRoot(projectRoot, decoded);
  if (!absolute) {
    throw new PathRefusalError(`Refusing to read a path outside the project: ${decoded}`);
  }
  return absolute;
}
