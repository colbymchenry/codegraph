/**
 * How the JSON API answers — success, refusal, and every failure in between.
 *
 * The viewer is the only client, and it runs on the same machine as the index,
 * so an error here is a message to a developer looking at their own project,
 * not information to withhold from a prober. Every failure therefore says what
 * went wrong and — where there is one — what to do about it, exactly the way
 * the CLI and the MCP tools do. What it never does is leak a stack trace.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { sendJson } from '../static';

/**
 * Machine-readable failure reasons. The viewer switches on these rather than
 * on prose, so renaming a message never breaks a screen.
 */
export type ApiErrorCode =
  | 'bad-request'
  | 'not-found'
  | 'refused'
  | 'no-index'
  | 'index-unusable'
  | 'internal';

const STATUS: Record<ApiErrorCode, number> = {
  'bad-request': 400,
  'not-found': 404,
  // A path refusal, not an authentication failure — the request asked for
  // something outside the project (traversal, an absolute path, a sensitive
  // directory) and there is no version of it we would serve.
  refused: 403,
  // The index is missing or unusable. 503 rather than 404: the endpoint is
  // real, the data behind it is not there *yet* — `codegraph init` fixes it.
  'no-index': 503,
  'index-unusable': 503,
  internal: 500,
};

/** An error that already carries a user-facing message and a status. */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  /** Optional second line: what the user can do about it. */
  readonly hint: string | undefined;

  constructor(code: ApiErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.hint = hint;
  }
}

export function badRequest(message: string, hint?: string): ApiError {
  return new ApiError('bad-request', message, hint);
}

export function notFound(message: string, hint?: string): ApiError {
  return new ApiError('not-found', message, hint);
}

/** Send a successful payload. */
export function ok(res: ServerResponse, payload: unknown, method: string): true {
  sendJson(res, 200, payload, method);
  return true;
}

/** Send a failure. Anything that is not an {@link ApiError} becomes a 500. */
export function fail(res: ServerResponse, err: unknown, method: string): true {
  if (err instanceof ApiError) {
    const body: { error: string; code: ApiErrorCode; hint?: string } = {
      error: err.message,
      code: err.code,
    };
    if (err.hint) body.hint = err.hint;
    sendJson(res, STATUS[err.code], body, method);
    return true;
  }
  sendJson(
    res,
    500,
    {
      error: err instanceof Error ? err.message : String(err),
      code: 'internal' satisfies ApiErrorCode,
    },
    method
  );
  return true;
}

// =============================================================================
// Request bodies
// =============================================================================

/**
 * Bytes a request body may carry.
 *
 * The only body this server reads is a saved trail: a name and up to 64 node
 * ids. 64 KB is generous for that and small enough that a runaway client cannot
 * make the process hold a megabyte per socket.
 */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * Read a request body as JSON.
 *
 * Counts BYTES, not characters, and stops at the cap by destroying the socket
 * rather than draining a body nobody is going to parse — a `Content-Length`
 * header is a claim, and the only limit that holds is the one applied to what
 * actually arrives.
 *
 * @throws {ApiError} `bad-request` for a body that is too large or is not JSON.
 */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        throw badRequest(`That request body is too large (max ${MAX_BODY_BYTES} bytes).`);
      }
      chunks.push(buf);
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw badRequest('That request body could not be read.');
  }
  if (size === 0) throw badRequest('That request needs a JSON body.');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown;
  } catch {
    throw badRequest('That request body is not valid JSON.');
  }
}

// =============================================================================
// Query parameters
// =============================================================================

/** A required, non-empty string parameter. */
export function requiredParam(query: URLSearchParams, name: string): string {
  const raw = query.get(name);
  if (raw === null || raw.trim() === '') {
    throw badRequest(`Missing required parameter "${name}".`);
  }
  return raw;
}

/**
 * A bounded integer parameter.
 *
 * Out-of-range values are an error rather than silently clamped: a viewer
 * asking for line 10 000 000 of a 200-line file has a bug, and answering it
 * with line 200 would hide that.
 */
export function intParam(
  query: URLSearchParams,
  name: string,
  opts: { min: number; max: number; default?: number }
): number {
  const raw = query.get(name);
  if (raw === null || raw.trim() === '') {
    if (opts.default !== undefined) return opts.default;
    throw badRequest(`Missing required parameter "${name}".`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < opts.min || value > opts.max) {
    throw badRequest(
      `Parameter "${name}" must be a whole number between ${opts.min} and ${opts.max} (got "${raw}").`
    );
  }
  return value;
}

/**
 * Free-form text input, bounded.
 *
 * The same reasoning as the MCP tools' input ceiling: a huge string is never a
 * real query, and letting one through means a full-table LIKE scan or an FTS5
 * parse over megabytes.
 */
export const MAX_QUERY_LENGTH = 2_000;

export function textParam(query: URLSearchParams, name: string): string {
  const raw = requiredParam(query, name);
  return boundLength(raw, name);
}

/**
 * Text that must be PRESENT but may be empty — a search box the user has
 * cleared. Absent is still an error; empty is a legitimate state.
 */
export function optionalTextParam(query: URLSearchParams, name: string): string {
  const raw = query.get(name);
  if (raw === null) throw badRequest(`Missing required parameter "${name}".`);
  return boundLength(raw, name);
}

function boundLength(raw: string, name: string): string {
  if (raw.length > MAX_QUERY_LENGTH) {
    throw badRequest(`Parameter "${name}" is too long (max ${MAX_QUERY_LENGTH} characters).`);
  }
  return raw;
}
