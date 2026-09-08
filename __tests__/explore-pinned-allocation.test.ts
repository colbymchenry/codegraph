/**
 * Pinned files in `allocateExploreBudget` (see query-paths.ts): a file the
 * query named by PATH must survive every allocation guard. Its score is
 * whatever the path-stripped query happened to match — for a pure-path query,
 * nearly nothing — so without the pinned floor the proportional split would
 * fund the one file the agent explicitly asked for worst of all, and the
 * cliff would zero it outright.
 */
import { describe, it, expect } from 'vitest';
import { allocateExploreBudget, getExploreOutputBudget, EXPLORE_ALLOCATION } from '../src/mcp/tools';
import type { ExploreAllocationCandidate } from '../src/mcp/tools';

const cand = (
  path: string,
  score: number,
  extra: Partial<ExploreAllocationCandidate> = {},
): ExploreAllocationCandidate => ({ path, score, worth: 1, spine: false, ...extra });

const budget = getExploreOutputBudget(1000);

describe('allocateExploreBudget — pinned files', () => {
  it('never cliffs a pinned file, however low it scores', () => {
    const { allowances, cliffed } = allocateExploreBudget(
      [
        cand('pinned.svelte', 0.1, { pinned: true }),
        cand('hub.ts', 200),
        cand('noise.ts', 0.1),
      ],
      budget,
      8,
    );
    expect(cliffed).toContain('noise.ts');
    expect(cliffed).not.toContain('pinned.svelte');
    expect(allowances.has('pinned.svelte')).toBe(true);
  });

  it('funds a pinned file at least as well as the strongest candidate', () => {
    const { allowances } = allocateExploreBudget(
      [
        cand('pinned.svelte', 0.5, { pinned: true }),
        cand('hub.ts', 300),
        cand('helper.ts', 40),
      ],
      budget,
      8,
    );
    expect(allowances.get('pinned.svelte')!).toBeGreaterThanOrEqual(allowances.get('hub.ts')!);
    expect(allowances.get('pinned.svelte')!).toBeGreaterThan(allowances.get('helper.ts')!);
  });

  it('keeps pinned files through the affordability trim', () => {
    // Smallest tier: affordable = floor(13000 / (MIN_CHARS + FILE_OVERHEAD)) = 14
    // slots. 18 equal-weight candidates admitted → the trim must cut 4. The
    // pinned file sits last with a TIED weight (the pinned floor lifts it to
    // the top weight), so the stable by-weight sort would slice it off — only
    // the explicit spine/pinned keep saves it.
    const tiny = getExploreOutputBudget(10);
    const fleet = Array.from({ length: 17 }, (_, i) => cand(`f${i}.ts`, 100));
    fleet.push(cand('pinned.svelte', 0.1, { pinned: true }));
    const { allowances, cliffed } = allocateExploreBudget(fleet, tiny, 18);
    expect(allowances.has('pinned.svelte')).toBe(true);
    expect(cliffed).not.toContain('pinned.svelte');
    expect(allowances.size).toBeLessThan(18);
  });

  it('an all-pinned zero-score call still allocates (pure-path query)', () => {
    const { allowances, pool } = allocateExploreBudget(
      [cand('a.svelte', 0, { pinned: true }), cand('b.svelte', 0, { pinned: true })],
      budget,
      8,
    );
    expect(pool).toBeGreaterThan(0);
    expect(allowances.get('a.svelte')!).toBeGreaterThanOrEqual(EXPLORE_ALLOCATION.MIN_CHARS);
    expect(allowances.get('b.svelte')!).toBeGreaterThanOrEqual(EXPLORE_ALLOCATION.MIN_CHARS);
  });

  it('unpinned behavior is unchanged when no candidate is pinned', () => {
    const before = allocateExploreBudget(
      [cand('a.ts', 40), cand('b.ts', 10)], budget, 8,
    );
    expect(before.allowances.get('a.ts')!).toBeGreaterThan(before.allowances.get('b.ts')!);
  });
});
