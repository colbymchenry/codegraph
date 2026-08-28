/**
 * Background update-availability check for long-lived servers (#1243).
 *
 * The recommended MCP config launches the LOCAL `codegraph` binary, so the
 * server (and the prompt hook alongside it) silently stays on whatever version
 * was last manually upgraded — users discover the drift only when something
 * breaks. This module gives the running server *visibility* without changing
 * behavior: a non-blocking check against the latest GitHub release, surfaced
 * as a one-line notice (stderr log, MCP initialize instructions, and
 * `codegraph_status`) telling the user to run `codegraph upgrade`.
 *
 * Invariants (mirrors the telemetry module's contract):
 *   - Never stdout — stdio is the MCP protocol channel.
 *   - Never blocking: the network refresh is fire-and-forget; every reader
 *     (`getUpdateNotice`) is a cheap synchronous cache read, so the #172
 *     respond-fast handshake contract holds.
 *   - Fail silent: offline / rate-limited / disk-full all degrade to "no
 *     notice", never an error, never a retry loop.
 *   - Off is off: `CODEGRAPH_NO_UPDATE_CHECK` (dedicated) or `DO_NOT_TRACK`
 *     (broad don't-phone-home convention — set by e.g. the Pro container's
 *     data plane) suppresses the network call AND the notice entirely.
 *
 * The check itself reuses `resolveLatestVersion` — the GitHub release-redirect
 * trick with the API fallback — so version resolution can't drift from what
 * `codegraph upgrade` installs. Results are cached in `~/.codegraph/` (the
 * same global state dir telemetry and the daemon registry use) with a 24h TTL
 * on success and a 1h backoff after failure, shared across every proxy /
 * daemon process on the machine.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveLatestVersion, isUpdateAvailable, parseSemver } from './index';
import { CodeGraphPackageVersion } from '../mcp/version';

/** Re-check the release feed after this long (successful checks). */
export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
/** Back off this long after a failed check (offline, rate-limited). */
export const UPDATE_CHECK_FAILURE_BACKOFF_MS = 60 * 60 * 1000;
/** Short network budget — the refresh is background work, not a handshake. */
const UPDATE_CHECK_NETWORK_TIMEOUT_MS = 5000;

export interface UpdateCheckCacheFile {
  /** Last time a network check was attempted (ms epoch). */
  lastAttemptAt: number;
  /** Last time a network check succeeded (ms epoch). */
  lastSuccessAt?: number;
  /** Latest release tag from the last successful check (e.g. `v1.4.1`). */
  latest?: string;
}

export interface UpdateCheckDeps {
  /** Global state dir; defaults to ~/.codegraph. Tests inject a temp dir. */
  dir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  resolveLatest?: () => Promise<string>;
  currentVersion?: string;
}

interface ResolvedDeps {
  dir: string;
  env: NodeJS.ProcessEnv;
  now: () => number;
  resolveLatest: () => Promise<string>;
  currentVersion: string;
}

function resolveDeps(deps: UpdateCheckDeps = {}): ResolvedDeps {
  return {
    dir: deps.dir ?? path.join(os.homedir(), '.codegraph'),
    env: deps.env ?? process.env,
    now: deps.now ?? Date.now,
    resolveLatest:
      deps.resolveLatest ?? (() => resolveLatestVersion(undefined, UPDATE_CHECK_NETWORK_TIMEOUT_MS)),
    currentVersion: deps.currentVersion ?? CodeGraphPackageVersion,
  };
}

function envTruthy(raw: string | undefined): boolean {
  return raw !== undefined && raw !== '' && raw !== '0' && raw.toLowerCase() !== 'false';
}

/**
 * True when the update check must not run at all — no network call, no
 * notice. `DO_NOT_TRACK` uses the same truthiness the telemetry opt-out does.
 */
export function updateCheckDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envTruthy(env.CODEGRAPH_NO_UPDATE_CHECK) || envTruthy(env.DO_NOT_TRACK);
}

export function updateCheckCachePath(dir: string): string {
  return path.join(dir, 'update-check.json');
}

export function readUpdateCheckCache(dir: string): UpdateCheckCacheFile | null {
  try {
    const raw = fs.readFileSync(updateCheckCachePath(dir), 'utf8');
    const parsed = JSON.parse(raw) as UpdateCheckCacheFile;
    if (typeof parsed?.lastAttemptAt !== 'number') return null;
    return parsed;
  } catch {
    return null; // missing / torn / unparseable — same as no cache
  }
}

function writeUpdateCheckCache(dir: string, cache: UpdateCheckCacheFile): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(updateCheckCachePath(dir), JSON.stringify(cache));
  } catch {
    /* fail silent — a read-only home dir must not break the server */
  }
}

/**
 * Rebuild a canonical `vX.Y.Z[-pre]` tag from the PARSED semver fields, or
 * null when the input isn't version-shaped. The notice ends up inside the MCP
 * initialize instructions — agent-visible, system-prompt-adjacent text — and
 * the `latest` value arrives from a network redirect via an on-disk cache, so
 * only a reconstructed canonical string may ever be interpolated, never the
 * raw value. (`parseSemver`'s regex is not end-anchored: a value like
 * `1.2.3-x <arbitrary text>` parses "valid" while the raw string would carry
 * the trailing text straight into every session's instructions.)
 */
export function canonicalVersionTag(v: string): string | null {
  const s = parseSemver(v);
  if (!s) return null;
  return `v${s.major}.${s.minor}.${s.patch}${s.pre ? `-${s.pre}` : ''}`;
}

/** One user-facing sentence; every surface (stderr, instructions, status) shows this. */
export function formatUpdateNotice(current: string, latest: string): string {
  return (
    `CodeGraph ${latest} is available (this server is running ` +
    `${current}). Update with \`codegraph upgrade\`.`
  );
}

function noticeFrom(cache: UpdateCheckCacheFile | null, d: ResolvedDeps): string | null {
  if (!cache?.latest) return null;
  // A dev build whose package.json couldn't be read reports the sentinel
  // version; any comparison against it would always claim an update.
  if (d.currentVersion === '0.0.0-unknown') return null;
  // Canonicalize BOTH sides before comparing or rendering — a non-semver
  // `latest` (garbage redirect, tampered cache) yields no notice at all
  // rather than flowing into agent-visible text.
  const latest = canonicalVersionTag(cache.latest);
  const current = canonicalVersionTag(d.currentVersion);
  if (!latest || !current) return null;
  return isUpdateAvailable(current, latest) ? formatUpdateNotice(current, latest) : null;
}

function cacheIsFresh(cache: UpdateCheckCacheFile | null, nowMs: number): boolean {
  if (!cache) return false;
  if (cache.lastSuccessAt !== undefined && nowMs - cache.lastSuccessAt < UPDATE_CHECK_TTL_MS) {
    return true;
  }
  // No recent success: only the failure backoff holds the network call off.
  return nowMs - cache.lastAttemptAt < UPDATE_CHECK_FAILURE_BACKOFF_MS;
}

/**
 * Ensure the on-disk cache is fresh (hitting the network only past the TTL /
 * backoff) and return the current notice, or null. Never throws.
 */
export async function refreshUpdateCheck(deps: UpdateCheckDeps = {}): Promise<string | null> {
  const d = resolveDeps(deps);
  if (updateCheckDisabled(d.env)) return null;

  const cached = readUpdateCheckCache(d.dir);
  const nowMs = d.now();
  if (cacheIsFresh(cached, nowMs)) return noticeFrom(cached, d);

  try {
    const latest = canonicalVersionTag(await d.resolveLatest());
    // A response that isn't version-shaped is a failure, not a result —
    // fall through to the backoff path and keep the previous known-good tag.
    if (!latest) throw new Error('release feed returned a non-version tag');
    const next: UpdateCheckCacheFile = { lastAttemptAt: nowMs, lastSuccessAt: nowMs, latest };
    writeUpdateCheckCache(d.dir, next);
    return noticeFrom(next, d);
  } catch {
    // Record the attempt (starts the backoff) but KEEP the previous latest —
    // a transient outage must not hide an already-known update.
    const next: UpdateCheckCacheFile = {
      lastAttemptAt: nowMs,
      lastSuccessAt: cached?.lastSuccessAt,
      latest: cached?.latest,
    };
    writeUpdateCheckCache(d.dir, next);
    return noticeFrom(next, d);
  }
}

// Per-process memo so the sync read path (MCP initialize, codegraph_status)
// touches the disk at most once a minute, not once per handshake.
const NOTICE_MEMO_TTL_MS = 60 * 1000;
let noticeMemo: { at: number; value: string | null } | null = null;

/**
 * The current update notice from the on-disk cache — synchronous and cheap
 * (memoized disk read), safe on the initialize respond-fast path. When the
 * cache has gone stale (e.g. a daemon that has been up for weeks), kicks a
 * background refresh so the NEXT reader sees a current answer; this call
 * still returns immediately from the stale cache.
 */
export function getUpdateNotice(deps: UpdateCheckDeps = {}): string | null {
  const d = resolveDeps(deps);
  if (updateCheckDisabled(d.env)) return null;

  const useMemo = deps.dir === undefined && deps.now === undefined;
  const nowMs = d.now();
  if (useMemo && noticeMemo && nowMs - noticeMemo.at < NOTICE_MEMO_TTL_MS) {
    return noticeMemo.value;
  }

  const cached = readUpdateCheckCache(d.dir);
  if (!cacheIsFresh(cached, nowMs)) {
    void refreshUpdateCheck(deps).catch(() => { /* fail silent */ });
  }
  const value = noticeFrom(cached, d);
  if (useMemo) noticeMemo = { at: nowMs, value };
  return value;
}

/** Test hook: clear the per-process memo. */
export function resetUpdateNoticeMemo(): void {
  noticeMemo = null;
}

/**
 * Fire-and-forget entry point for server startup: refresh the cache in the
 * background and, if an update is available, emit ONE stderr line (stderr is
 * the MCP-safe channel; hosts surface it in their server logs). Never throws,
 * never blocks, never writes stdout.
 */
export function checkForUpdateInBackground(
  deps: UpdateCheckDeps = {},
  log: (line: string) => void = (line) => process.stderr.write(line),
): void {
  refreshUpdateCheck(deps)
    .then((notice) => {
      // The shared notice sentence starts with "CodeGraph …"; drop the word
      // after the log tag so the line doesn't read "[CodeGraph] CodeGraph …".
      if (notice) log(`[CodeGraph] ${notice.replace(/^CodeGraph /, '')}\n`);
    })
    .catch(() => { /* fail silent */ });
}
