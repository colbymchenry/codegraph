/**
 * Cooperative-yield helper + the async contract of the main-thread resolution
 * spans it protects (#1091).
 *
 * Background: reference resolution and callback-edge synthesis run on the
 * indexer's MAIN thread. The #850 liveness watchdog SIGKILLs the process when
 * that thread doesn't turn its event loop within the timeout window, because its
 * heartbeat is a timer on that same thread. On a large repo those spans run for
 * minutes, so they must yield periodically or a VALID index gets killed. These
 * tests pin (a) the yielder's budget semantics and (b) that the three long spans
 * stayed `async` so they CAN yield — a revert to a synchronous version would
 * reintroduce the wedge, and the AsyncFunction assertions fail loudly if so.
 */
import { describe, it, expect } from 'vitest';
import { createYielder, DEFAULT_YIELD_BUDGET_MS } from '../src/resolution/cooperative-yield';
import { synthesizeCallbackEdges } from '../src/resolution/callback-synthesizer';
import { ReferenceResolver } from '../src/resolution/index';

/**
 * A `setImmediate` callback runs in the check phase — AFTER the microtask queue
 * drains. So if `await maybeYield()` did NOT cross a macrotask boundary (it was
 * under budget and returned a synchronously-resolved promise), a `setImmediate`
 * scheduled just before it has NOT fired yet. If it DID yield (awaited its own
 * `setImmediate`), the earlier `setImmediate` — queued first, FIFO — has fired.
 * This makes "did it yield?" a deterministic, non-timing assertion.
 */
async function yieldedDuring(maybeYield: () => Promise<void>): Promise<boolean> {
  let macrotaskRan = false;
  setImmediate(() => { macrotaskRan = true; });
  await maybeYield();
  return macrotaskRan;
}

describe('createYielder', () => {
  it('does not yield while under the time budget', async () => {
    const maybeYield = createYielder(100_000); // effectively never elapses in-test
    expect(await yieldedDuring(maybeYield)).toBe(false);
    // Repeated calls stay coalesced — still no macrotask boundary crossed.
    expect(await yieldedDuring(maybeYield)).toBe(false);
  });

  it('yields once the budget has elapsed, then resets', async () => {
    const maybeYield = createYielder(0); // 0ms budget → every checkpoint yields
    expect(await yieldedDuring(maybeYield)).toBe(true);
    // Reset: the next checkpoint also yields (budget is measured from the last
    // yield, and 0ms has "elapsed" again).
    expect(await yieldedDuring(maybeYield)).toBe(true);
  });

  it('yields after real wall-clock exceeds the budget', async () => {
    const maybeYield = createYielder(20);
    expect(await yieldedDuring(maybeYield)).toBe(false); // fresh — under budget
    const until = Date.now() + 35;
    while (Date.now() < until) { /* busy-wait past the 20ms budget */ }
    expect(await yieldedDuring(maybeYield)).toBe(true);
  });

  it('exposes a sane default budget under the watchdog heartbeat cadence', () => {
    // The watchdog writes a heartbeat every ~1s at minimum; the yield budget
    // must be well under that so a beat can always land between yields.
    expect(DEFAULT_YIELD_BUDGET_MS).toBeGreaterThan(0);
    expect(DEFAULT_YIELD_BUDGET_MS).toBeLessThan(1000);
  });
});

describe('main-thread resolution spans stay async (so they can yield) — #1091', () => {
  it('synthesizeCallbackEdges is an async function', () => {
    expect(synthesizeCallbackEdges.constructor.name).toBe('AsyncFunction');
  });

  it('resolveChainedCallsViaConformance is an async function', () => {
    expect(ReferenceResolver.prototype.resolveChainedCallsViaConformance.constructor.name).toBe('AsyncFunction');
  });

  it('resolveDeferredThisMemberRefs is an async function', () => {
    expect(ReferenceResolver.prototype.resolveDeferredThisMemberRefs.constructor.name).toBe('AsyncFunction');
  });

  it('resolveAndPersistBatched is an async function', () => {
    expect(ReferenceResolver.prototype.resolveAndPersistBatched.constructor.name).toBe('AsyncFunction');
  });
});
