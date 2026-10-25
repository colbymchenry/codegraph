/**
 * Shared thread budget — one user-facing ceiling on CodeGraph's worker threads
 * (issue #2527).
 *
 * Why this exists: CodeGraph runs several independently-sized worker pools —
 * the parse pool (`extraction/parse-pool`), the resolution pool
 * (`resolution/resolver-pool`) and the query pool (`mcp/query-pool`) — and each
 * one sized itself from the core count on its own. Each pool alone is polite
 * (it leaves a core for the main thread), but their sizes add up: a long-lived
 * MCP server keeps its query pool live while a watcher sync builds the parse
 * and resolution pools, and on a machine whose cores are already spoken for
 * that total can occupy every core and leave the desktop unresponsive.
 *
 * This module is the single place that decides how many worker threads may be
 * live at once, and is the allocator the pools draw on when they are built.
 *
 * Precedence for the limit (highest first):
 *   1. `--threads <n>` on the CLI (index / init / sync)
 *   2. `maxThreads` in the project's `codegraph.json`
 *   3. `CODEGRAPH_MAX_THREADS` in the environment
 *   4. default — `cores - 2` so the main thread and the OS always keep room,
 *      never below the constructing pool's own un-capped size.
 *
 * The ceiling applies to the pools that are alive *together*, not to a fixed
 * three-way split: an `index` run never builds a query pool, and its parse pool
 * is torn down before resolution starts, so a fixed split would silently halve
 * throughput for no reason. Each pool leases the slots it needs — the batch
 * pools when they are constructed, the query pool one per worker as it grows —
 * and returns them when those workers go away. The sum of the live leases can
 * never exceed the limit.
 *
 * Everything here is pure and synchronous so it can be unit-tested without
 * spawning a worker or touching the database.
 */

import * as os from 'os';
import { loadMaxThreads } from './project-config';

/** Where a resolved thread limit came from — printed in verbose mode. */
export type ThreadBudgetSource = 'flag' | 'config' | 'env' | 'default';

/** Worker pools that can be constructed in one process. */
export type PoolName = 'parse' | 'query' | 'resolve';

export interface ThreadLimitInput {
  /** `--threads <n>` from the CLI. Highest precedence. */
  cliThreads?: number | string | undefined;
  /** `maxThreads` from the project's `codegraph.json`. */
  configMaxThreads?: number | undefined;
  /** `CODEGRAPH_MAX_THREADS` from the environment. */
  envMaxThreads?: string | undefined;
  /** `os.availableParallelism()` for the process. */
  availableParallelism: number;
  /**
   * Floor for the DEFAULT only. A pool's own un-capped request, so that
   * applying the shared budget can never take a pool below the size it gets
   * today on a small machine. Explicit limits (`--threads`, `maxThreads`,
   * `CODEGRAPH_MAX_THREADS`) are absolute and ignore this — the user asked for
   * a cap, so they get the cap.
   */
  minimum?: number | undefined;
}

export interface ThreadLimit {
  /** Total worker threads allowed across every pool in the run. Always ≥ 1. */
  readonly total: number;
  /** Which input produced it (for logging). */
  readonly source: ThreadBudgetSource;
}

/**
 * Slots reserved by one pool, released when that pool is destroyed.
 *
 * Every pool hands its lease back in `destroy()`, so a run that builds pools
 * one after another (parse, then resolution) — or a long-lived server that
 * retires and recreates one — never drains the budget it is drawing on.
 */
export interface ThreadLease {
  /** Slots this pool may use. */
  readonly size: number;
  /** Return the slots. Idempotent: a second call is a no-op. */
  release(): void;
}

/**
 * Cores kept free of worker threads by the default. Two, not one: the main
 * thread does real work during indexing (SQLite writes, the store worker) and
 * the OS still needs somewhere to run — one spare core on a many-core box was
 * not enough to keep a full index responsive.
 */
export const DEFAULT_HEADROOM_CORES = 2;

/**
 * Parse a user-supplied thread count. Accepts a number or the string form a
 * CLI flag / env var delivers. Anything that is not a positive integer is
 * ignored so the next source in the precedence chain wins — a typo must never
 * silently disable pooling or blow the budget up.
 */
function toPositiveInt(value: number | string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return undefined;
  return n;
}

/**
 * Resolve the total worker-thread limit for a run.
 *
 * The default leaves headroom: `max(minimum, cores - DEFAULT_HEADROOM_CORES)`.
 * The `minimum` term matters on small machines. The parse pool is documented to
 * floor at 2 workers because 1 worker measured 34% slower than the old
 * oversubscribed pool on a 2-core envelope — so the default budget must never
 * be the thing that shrinks a pool below its own default. It only ever caps the
 * COMBINED total of the pools that share a run.
 */
export function resolveThreadLimit(input: ThreadLimitInput): ThreadLimit {
  const cores = Math.max(1, Math.floor(input.availableParallelism) || 1);

  const fromFlag = toPositiveInt(input.cliThreads);
  if (fromFlag !== undefined) return { total: fromFlag, source: 'flag' };

  const fromConfig = toPositiveInt(input.configMaxThreads);
  if (fromConfig !== undefined) return { total: fromConfig, source: 'config' };

  const fromEnv = toPositiveInt(input.envMaxThreads);
  if (fromEnv !== undefined) return { total: fromEnv, source: 'env' };

  const floor = toPositiveInt(input.minimum) ?? 1;
  return {
    total: Math.max(floor, cores - DEFAULT_HEADROOM_CORES),
    source: 'default',
  };
}

/** Granted size per pool, for verbose startup logging. */
export interface PoolSizes {
  parse: number;
  query: number;
  resolve: number;
}

/**
 * One-line summary of the resolved sizes for `--verbose` startup logging, e.g.
 *
 *   threads: parse=8 query=0 resolve=6 (14 of 16; source=default, 18 cores)
 */
export function describeThreadBudget(
  limit: ThreadLimit,
  sizes: PoolSizes,
  opts: { cores: number; pools?: PoolName[] },
): string {
  const pools = opts.pools ?? (Object.keys(sizes) as PoolName[]).filter((n) => sizes[n] > 0);
  const parts = pools.map((name) => `${name}=${sizes[name]}`);
  const used = pools.reduce((sum, name) => sum + sizes[name], 0);
  return (
    `threads: ${parts.join(' ')} (${used} of ${limit.total}; ` +
    `source=${limit.source}, ${opts.cores} cores)`
  );
}

/**
 * Live allocator — the mechanism that makes one limit apply "across all pools
 * together" (issue #2527's wording).
 *
 * Each pool claims its slots when it needs them and hands them back when its
 * workers go away, so the ceiling holds for whatever combination of pools a run
 * actually builds. An index run claims parse then resolve; a serving run claims
 * one query slot per live worker. No pool can push the total past the limit,
 * and a released slot is immediately available to the next pool.
 */
export class ThreadBudget {
  private used = 0;

  constructor(readonly limit: ThreadLimit) {}

  /** Slots currently held by live pools. */
  get claimed(): number {
    return this.used;
  }

  /** Slots still available. */
  get remaining(): number {
    return Math.max(0, this.limit.total - this.used);
  }

  /**
   * Claim up to `wanted` worker threads. Returns the number this pool may use,
   * clamped to the budget and never negative.
   */
  claim(wanted: number): number {
    const request = Math.max(0, Math.floor(wanted) || 0);
    const granted = Math.min(request, this.remaining);
    this.used += granted;
    return granted;
  }

  /**
   * Reserve up to `wanted` worker threads for one pool and return its lease.
   * The pool releases the lease in `destroy()`; without that, every pool built
   * later in the process would see a drained budget (issue #2527's first
   * regression: a second MCP engine sized its query pool to zero).
   */
  lease(wanted: number): ThreadLease {
    const size = this.claim(wanted);
    let released = false;
    return {
      size,
      release: () => {
        if (released) return;
        released = true;
        this.release(size);
      },
    };
  }

  /** Return slots held by a pool that has gone away. */
  release(granted: number): void {
    this.used = Math.max(0, this.used - Math.max(0, Math.floor(granted) || 0));
  }
}

/**
 * Resolve the limit for a project run, folding in all three user-facing knobs.
 *
 * `cliThreads` is published by the CLI as `CODEGRAPH_CLI_THREADS` (the `--threads`
 * flag); `codegraph.json`'s `maxThreads` is read from the project root; the
 * `CODEGRAPH_MAX_THREADS` env var is the escape hatch that needs no file or flag
 * change. Kept in one place so the parse, resolution and query pools cannot
 * disagree about the budget.
 */
export function resolveProjectThreadLimit(opts: {
  projectRoot?: string | undefined;
  availableParallelism: number;
  /** Pool's own un-capped request — floor for the default only (see above). */
  minimum?: number | undefined;
  /** Test seam: read the project config without touching the mtime cache. */
  configMaxThreads?: number | undefined;
}): ThreadLimit {
  const configMaxThreads =
    opts.configMaxThreads ?? readProjectMaxThreads(opts.projectRoot);
  return resolveThreadLimit({
    cliThreads: process.env.CODEGRAPH_CLI_THREADS,
    configMaxThreads,
    envMaxThreads: process.env.CODEGRAPH_MAX_THREADS,
    availableParallelism: opts.availableParallelism,
    minimum: opts.minimum,
  });
}

/**
 * `maxThreads` from `codegraph.json`, if the project has one and it is valid.
 * A missing or malformed value is ignored rather than fatal — consistent with
 * the rest of the project config, where an unparseable file must never break
 * indexing.
 */
function readProjectMaxThreads(projectRoot: string | undefined): number | undefined {
  return projectRoot ? loadMaxThreads(projectRoot) : undefined;
}

/**
 * Run-scoped budget.
 *
 * The parse and resolution pools are built by different subsystems that never
 * see each other (ExtractionOrchestrator then ReferenceResolver), and a
 * long-lived MCP server keeps a query pool live across both. Passing a budget
 * object through every call graph would thread a new parameter through the
 * whole pipeline for one number, so the budget is held here for the duration of
 * the process — the same process-scoped shape the pools already use when they
 * read `CODEGRAPH_*` straight off `process.env`.
 *
 * First caller wins on the limit; `resetThreadBudget()` ends the run. Tests call
 * the reset in `afterEach` so runs cannot leak into each other.
 */
let currentBudget: ThreadBudget | undefined;

export function threadBudget(limit?: ThreadLimit): ThreadBudget {
  if (!currentBudget) {
    currentBudget = new ThreadBudget(
      limit ?? resolveProjectThreadLimit({ availableParallelism: defaultParallelism() }),
    );
  }
  return currentBudget;
}

export function resetThreadBudget(): void {
  currentBudget = undefined;
}

function defaultParallelism(): number {
  try {
    return os.availableParallelism();
  } catch {
    return 1;
  }
}
