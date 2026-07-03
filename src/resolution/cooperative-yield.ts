/**
 * Cooperative yielding for long synchronous resolution spans.
 *
 * Reference resolution and callback-edge synthesis run on the indexer's MAIN
 * thread — unlike parsing, which is off-thread in the parse worker. The #850
 * liveness watchdog (armed on `index`/`init` since #999) SIGKILLs the process
 * when that thread doesn't turn its event loop for the timeout window (default
 * 60s), because its heartbeat is a `setInterval` on that same thread. On a large
 * repo, resolving refs + synthesizing dynamic-dispatch edges legitimately runs
 * for minutes, so a span that never yields starves the heartbeat and the
 * watchdog kills a VALID, in-progress index — the exact symptom of #1091 (the
 * progress bar freezes at wherever it last rendered — 88% / 100% — then the
 * process is killed).
 *
 * `createYielder` returns a `maybeYield()` that yields (via `setImmediate`) only
 * once more than `budgetMs` of wall-clock has elapsed since the last yield, so
 * fast repos pay essentially nothing while slow ones give the heartbeat a
 * regular window to fire. Call it at natural boundaries in a long loop (between
 * batches, between synthesis passes).
 *
 * This does NOT weaken the watchdog. A genuinely wedged loop — an infinite or
 * non-terminating span, the case the watchdog exists to catch — never reaches a
 * yield point, so the heartbeat still stops and the SIGKILL still fires. We only
 * stop killing work that is demonstrably making progress.
 */

/** Yield when more than `budgetMs` of wall-clock has passed since the last yield. */
export type MaybeYield = () => Promise<void>;

/** Default budget: well under the watchdog's minimum heartbeat cadence (~1s), so
 * a heartbeat byte always has a chance to land between yields. */
export const DEFAULT_YIELD_BUDGET_MS = 250;

export function createYielder(budgetMs: number = DEFAULT_YIELD_BUDGET_MS): MaybeYield {
  let last = Date.now();
  return async function maybeYield(): Promise<void> {
    if (Date.now() - last < budgetMs) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    last = Date.now();
  };
}
