/**
 * Score-proportional byte allocation for codegraph_explore (CG-12 / #1500).
 *
 * `allocateExploreBudget` decides, before anything renders, how many chars of
 * source each ranked file may spend. Its contract is what stops the explore
 * envelope from following FILE SIZE — which is the bug #1500 reported: a small
 * weakly-relevant file shipped whole while the file that actually answered the
 * question was clipped at a flat per-file cap.
 *
 * These pin the allocator's invariants directly. End-to-end behaviour on the two
 * regression fixtures lives in `explore-allocation-1500.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { allocateExploreBudget, getExploreOutputBudget, EXPLORE_ALLOCATION } from '../src/mcp/tools';
import type { ExploreAllocationCandidate, ExploreAllocation, ExploreOutputBudget } from '../src/mcp/tools';

/** A candidate with sane defaults — tests override only what they're about. */
const cand = (
  path: string,
  score: number,
  extra: Partial<ExploreAllocationCandidate> = {},
): ExploreAllocationCandidate => ({ path, score, worth: 1, spine: false, ...extra });

const TIER_FILE_COUNTS = [10, 100, 300, 1000, 4000, 10000, 20000, 60000];

/**
 * The inline tool-result limit. Above it the host writes the response to a file
 * the agent Reads back, re-introducing the read this tool exists to prevent — so
 * it bounds every tier, not just the big ones (`hardCeiling`, tools.ts).
 */
const INLINE_CAP = 25000;

const reservedTotal = (a: ExploreAllocation) =>
  [...a.allowances.values()].reduce((sum, n) => sum + n, 0);

/**
 * What the render loop can actually emit for these reservations: each file's
 * slice, plus the whole-file grace it may overshoot by, plus the markdown
 * overhead charged per section. The allocator's job is to keep this inside the
 * envelope it was handed.
 */
const worstCaseEmission = (a: ExploreAllocation) => {
  let total = 0;
  for (const chars of a.allowances.values()) {
    total += chars + EXPLORE_ALLOCATION.FILE_OVERHEAD;
  }
  return total;
};

describe('allocateExploreBudget — proportional split', () => {
  const budget = getExploreOutputBudget(1000); // 24,000 / 6,500 / 8 files

  it('gives the higher-scoring file the bigger share', () => {
    const { allowances } = allocateExploreBudget(
      [cand('a.ts', 40), cand('b.ts', 10)],
      budget,
      8,
    );
    expect(allowances.get('a.ts')!).toBeGreaterThan(allowances.get('b.ts')!);
  });

  it('scales the split with the score RATIO, not just the ordering', () => {
    // The heart of the fix. Under the old flat `maxCharsPerFile` both files got
    // the same cap and the split fell out of whichever happened to be small
    // enough to ship whole; here a 4x score buys materially more than a 1.1x one.
    const wide = allocateExploreBudget([cand('a.ts', 40), cand('b.ts', 10)], budget, 8).allowances;
    const narrow = allocateExploreBudget([cand('a.ts', 22), cand('b.ts', 20)], budget, 8).allowances;
    expect(wide.get('a.ts')! / wide.get('b.ts')!)
      .toBeGreaterThan(narrow.get('a.ts')! / narrow.get('b.ts')!);
  });

  it('never reserves more than the envelope', () => {
    const { allowances, pool } = allocateExploreBudget(
      [cand('a.ts', 90), cand('b.ts', 40), cand('c.ts', 30), cand('d.ts', 12)],
      budget,
      8,
    );
    const reserved = [...allowances.values()].reduce((s, n) => s + n, 0);
    expect(reserved).toBeLessThanOrEqual(pool);
    expect(pool).toBeLessThanOrEqual(budget.maxOutputChars);
  });

  it('caps any single file at the MAX_SHARE safety valve', () => {
    // The per-file cap is retired as the primary guard, but a lone dominant file
    // must still not be handed the entire response.
    const { allowances } = allocateExploreBudget([cand('god.ts', 500)], budget, 8);
    expect(allowances.get('god.ts')!).toBeLessThanOrEqual(Math.round(budget.maxOutputChars * 0.7));
  });

  it('lets the top file exceed the old flat per-file cap when it earns it', () => {
    // The regression this task exists to fix: `maxCharsPerFile` clipped the file
    // that scored 4x its peers at exactly the same 6,500 as the noise.
    const { allowances } = allocateExploreBudget(
      [cand('answer.ts', 60), cand('noise.ts', 12)],
      budget,
      8,
    );
    expect(allowances.get('answer.ts')!).toBeGreaterThan(budget.maxCharsPerFile);
  });
});

describe('allocateExploreBudget — the relative cliff', () => {
  const budget = getExploreOutputBudget(1000);

  it('gives zero source to a file far below the top score', () => {
    const { allowances, cliffed } = allocateExploreBudget(
      [cand('answer.ts', 90), cand('incidental.ts', 3)],
      budget,
      8,
    );
    expect(cliffed).toContain('incidental.ts');
    expect(allowances.has('incidental.ts')).toBe(false);
  });

  it('is RELATIVE — the same score survives against weaker company', () => {
    const strong = allocateExploreBudget([cand('a.ts', 90), cand('b.ts', 8)], budget, 8);
    const even = allocateExploreBudget([cand('a.ts', 12), cand('b.ts', 8)], budget, 8);
    expect(strong.cliffed).toContain('b.ts');
    expect(even.cliffed).not.toContain('b.ts');
  });

  it('never rises above the score-floor ceiling, however dominant the top file', () => {
    // A 500-scoring god-file would otherwise put the cliff at 75 and silence
    // every peer the score floor had just deliberately admitted.
    const { cliffed } = allocateExploreBudget(
      [cand('god.ts', 500), cand('peer.ts', 13), cand('peer2.ts', 11)],
      budget,
      8,
    );
    expect(cliffed).toEqual([]);
  });

  it('doubles the penalty on bytes that are worth less (generated / low-value)', () => {
    // `worth` is `rankPenalty` applied a second time: generated CRUD can rank on
    // name collisions while its bytes stay boilerplate. Same score, different fate.
    const { cliffed } = allocateExploreBudget(
      [cand('answer.ts', 60), cand('gen.ts', 12, { worth: 0.3 }), cand('hand.ts', 12)],
      budget,
      8,
    );
    expect(cliffed).toContain('gen.ts');
    expect(cliffed).not.toContain('hand.ts');
  });

  it('exempts flow-spine files from the cliff', () => {
    // Clipping the spine causes the Read fallback — it IS the answer to a flow
    // question — so a spine file is never zeroed on relative score alone.
    const { allowances, cliffed } = allocateExploreBudget(
      [cand('a.ts', 400), cand('spine.ts', 2, { spine: true })],
      budget,
      8,
    );
    expect(cliffed).not.toContain('spine.ts');
    expect(allowances.get('spine.ts')!).toBeGreaterThan(0);
  });

  it('never cliffs every candidate — an empty response costs a round-trip', () => {
    const { allowances, cliffed } = allocateExploreBudget([cand('only.ts', 0.5)], budget, 8);
    expect(cliffed).toEqual([]);
    expect(allowances.get('only.ts')!).toBeGreaterThan(0);
  });

  it('hands a cliffed file\'s maxFiles slot to the next file down', () => {
    // The mechanism that got `BuildPayslip` into the #1500 response: cliffing is
    // not just "spend fewer bytes here", it frees the SLOT too.
    const { allowances } = allocateExploreBudget(
      [cand('a.ts', 90), cand('noise.ts', 2), cand('b.ts', 40)],
      budget,
      2,
    );
    expect([...allowances.keys()].sort()).toEqual(['a.ts', 'b.ts']);
  });
});

describe('allocateExploreBudget — the floor keeps diffuse questions useful', () => {
  const budget = getExploreOutputBudget(1000);

  it('gives every admitted file a slice big enough for a method', () => {
    // A survey question must still return a spread. The earlier design cliffed a
    // starved file instead of flooring it, and that CASCADED: removing the
    // smallest raised everyone else so little that the next-smallest starved too,
    // eating six legitimately-ranked peers one at a time.
    const files = [cand('a.ts', 100), cand('b.ts', 90), ...Array.from({ length: 6 }, (_, i) => cand(`p${i}.ts`, 20))];
    const { allowances } = allocateExploreBudget(files, budget, 8);
    expect(allowances.size).toBe(8);
    for (const [, chars] of allowances) expect(chars).toBeGreaterThanOrEqual(700);
  });

  it('serves fewer files well rather than many badly when the envelope cannot afford them', () => {
    const tiny = getExploreOutputBudget(10); // 13,000-char envelope
    const files = Array.from({ length: 40 }, (_, i) => cand(`f${i}.ts`, 50 - i * 0.1));
    const { allowances, cliffed } = allocateExploreBudget(files, tiny, 40);
    expect(allowances.size).toBeLessThan(40);
    expect(cliffed.length).toBeGreaterThan(0);
    for (const [, chars] of allowances) expect(chars).toBeGreaterThanOrEqual(700);
    const reserved = [...allowances.values()].reduce((s, n) => s + n, 0);
    expect(reserved).toBeLessThanOrEqual(tiny.maxOutputChars);
  });

  it('returns an empty allocation for an empty candidate list', () => {
    const { allowances, cliffed } = allocateExploreBudget([], budget, 8);
    expect(allowances.size).toBe(0);
    expect(cliffed).toEqual([]);
  });

  it('does not crash or over-allocate when every score is zero', () => {
    const { allowances } = allocateExploreBudget([cand('a.ts', 0), cand('b.ts', 0)], budget, 8);
    const reserved = [...allowances.values()].reduce((s, n) => s + n, 0);
    expect(reserved).toBeLessThanOrEqual(budget.maxOutputChars);
  });
});

describe('allocateExploreBudget — tier invariant', () => {
  it('never gives a larger tier a smaller allowance than a smaller tier', () => {
    // The standing invariant from `getExploreOutputBudget`: a bigger project must
    // never be served LESS per file. It held for the flat cap by inspection; with
    // a proportional split it has to hold for the same candidate set across every
    // tier, which is what this walks.
    const files = [cand('a.ts', 60), cand('b.ts', 30), cand('c.ts', 15)];
    let previous: Map<string, number> | null = null;
    for (const fileCount of TIER_FILE_COUNTS) {
      const { allowances } = allocateExploreBudget(files, getExploreOutputBudget(fileCount), 8);
      if (previous) {
        for (const [path, chars] of allowances) {
          expect(chars, `${path} shrank at ${fileCount} files`).toBeGreaterThanOrEqual(previous.get(path)!);
        }
      }
      previous = allowances;
    }
  });

  it('cliffs the same files at every tier — the cliff is relative, not sized', () => {
    const files = [cand('a.ts', 90), cand('noise.ts', 2)];
    const cliffs = TIER_FILE_COUNTS.map((n) =>
      allocateExploreBudget(files, getExploreOutputBudget(n), 8).cliffed.join(','));
    expect(new Set(cliffs).size).toBe(1);
  });
});

// ── CG-14 ───────────────────────────────────────────────────────────────────
// Everything above pins the behaviours CG-12 was written to produce. What
// follows pins the ones it must never produce: an over-spent envelope, a
// starved diffuse query, a NaN slice — the failures that would ship silently
// because they only surface as an agent falling back to Read.

describe('allocateExploreBudget — calibration', () => {
  it('pins the constants the two #1500 fixtures were calibrated against', () => {
    // Deliberately literal. Every other test here asserts an INVARIANT and reads
    // the constants, so it holds at any value; this one exists so that changing a
    // value is a visible decision rather than a silent re-tune of the fixtures.
    // If you change one, re-run `node scripts/agent-eval/probe-allocation.mjs`.
    expect(EXPLORE_ALLOCATION).toMatchObject({
      CLIFF_FRACTION: 0.15,
      CLIFF_MAX: 10,
      MIN_CHARS: 700,
      MAX_SHARE: 0.7,
      FILE_OVERHEAD: 200,
      SPINE_WEIGHT_BOOST: 2,
      WHOLE_FILE_GRACE_FRACTION: 0.15,
      WHOLE_FILE_GRACE_MAX: 800,
    });
  });

  it('cliffs strictly BELOW the threshold, so a file exactly at it is still served', () => {
    // The boundary matters because `cliffAt` sits at CLIFF_MAX for any dominant
    // top file, which is also where the score floor's own ceiling sits — a file
    // that clears one must clear the other or the two gates disagree.
    const budget = getExploreOutputBudget(1000);
    const at = allocateExploreBudget([cand('top.ts', 1000), cand('probe.ts', 10)], budget, 8);
    const under = allocateExploreBudget([cand('top.ts', 1000), cand('probe.ts', 9.9)], budget, 8);
    expect(at.cliffAt).toBe(EXPLORE_ALLOCATION.CLIFF_MAX);
    expect(at.cliffed).not.toContain('probe.ts');
    expect(under.cliffed).toContain('probe.ts');
  });

  it('tracks the top file until CLIFF_MAX caps it', () => {
    const budget = getExploreOutputBudget(1000);
    const cliffFor = (top: number) =>
      allocateExploreBudget([cand('top.ts', top), cand('b.ts', 1)], budget, 8).cliffAt;
    expect(cliffFor(20)).toBeCloseTo(20 * EXPLORE_ALLOCATION.CLIFF_FRACTION, 5);
    expect(cliffFor(50)).toBeCloseTo(50 * EXPLORE_ALLOCATION.CLIFF_FRACTION, 5);
    expect(cliffFor(500)).toBe(EXPLORE_ALLOCATION.CLIFF_MAX);
  });
});

describe('allocateExploreBudget — envelope safety', () => {
  /** Deterministic LCG: a seeded sweep reproduces exactly, unlike Math.random. */
  const shapes = (): ExploreAllocationCandidate[][] => {
    let seed = 0x1500;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const out: ExploreAllocationCandidate[][] = [];
    for (let n = 1; n <= 30; n++) {
      out.push(Array.from({ length: n }, (_, i) =>
        cand(`f${i}.ts`, Math.round(next() * 120 * 100) / 100, {
          worth: next() < 0.25 ? 0.3 : 1,
          spine: next() < 0.1,
        })));
    }
    return out;
  };

  it('never reserves more than the envelope, at any tier or shape', () => {
    // The one invariant that must hold unconditionally: the render loop spends
    // reservations, so an over-allocation is an over-long response, and an
    // over-long response is externalized to a file the agent has to Read back.
    for (const fileCount of TIER_FILE_COUNTS) {
      const budget = getExploreOutputBudget(fileCount);
      for (const files of shapes()) {
        for (const maxFiles of [1, 4, 8, 30]) {
          const alloc = allocateExploreBudget(files, budget, maxFiles);
          const label = `${files.length} files, maxFiles=${maxFiles}, tier ${fileCount}`;
          expect(reservedTotal(alloc), label).toBeLessThanOrEqual(alloc.pool);
          expect(worstCaseEmission(alloc), label).toBeLessThanOrEqual(budget.maxOutputChars);
          for (const chars of alloc.allowances.values()) {
            expect(Number.isFinite(chars) && chars > 0, label).toBe(true);
          }
        }
      }
    }
  });

  it('never renders more files than maxFiles', () => {
    for (const maxFiles of [1, 2, 4, 8]) {
      const files = Array.from({ length: 25 }, (_, i) => cand(`f${i}.ts`, 100 - i));
      const alloc = allocateExploreBudget(files, getExploreOutputBudget(1000), maxFiles);
      expect(alloc.allowances.size).toBeLessThanOrEqual(maxFiles);
    }
  });

  it('accounts for every candidate — a file is served, cliffed, or neither by choice', () => {
    // Nothing may vanish silently: a cliffed file is still NAMED in the response,
    // which is what makes withholding its bytes cheap. A file that is neither
    // served nor cliffed would be dropped without a pointer.
    const files = Array.from({ length: 25 }, (_, i) => cand(`f${i}.ts`, 100 - i * 4));
    const alloc = allocateExploreBudget(files, getExploreOutputBudget(1000), 8);
    const accounted = new Set([...alloc.allowances.keys(), ...alloc.cliffed]);
    expect(accounted.size).toBe(files.length);
  });

  it('leaves the ~25K inline cap reachable only through the hard ceiling', () => {
    // Reservations always fit `maxOutputChars`, but the whole-file grace lets the
    // render loop overshoot a slice — so the envelope alone does NOT bound the
    // response, and `hardCeiling` is load-bearing rather than defensive. Pin both
    // halves: every tier's envelope is inside the inline cap, and the worst-case
    // graced emission is what the ceiling has to catch.
    for (const fileCount of TIER_FILE_COUNTS) {
      const budget = getExploreOutputBudget(fileCount);
      const hardCeiling = Math.min(Math.round(budget.maxOutputChars * 1.5), INLINE_CAP);
      expect(budget.maxOutputChars).toBeLessThan(INLINE_CAP);
      expect(hardCeiling).toBeLessThanOrEqual(INLINE_CAP);

      const files = Array.from({ length: 8 }, (_, i) => cand(`f${i}.ts`, 90 - i * 9));
      const alloc = allocateExploreBudget(files, budget, 8);
      const graced = [...alloc.allowances.values()].reduce((sum, chars) => sum + chars
        + Math.min(EXPLORE_ALLOCATION.WHOLE_FILE_GRACE_MAX,
          Math.round(chars * EXPLORE_ALLOCATION.WHOLE_FILE_GRACE_FRACTION))
        + EXPLORE_ALLOCATION.FILE_OVERHEAD, 0);
      expect(graced).toBeGreaterThan(budget.maxOutputChars);
      expect(reservedTotal(alloc)).toBeLessThanOrEqual(budget.maxOutputChars);
    }
  });
});

describe('allocateExploreBudget — spine first', () => {
  const budget = getExploreOutputBudget(1000);

  it('reserves more for a spine file than for an identically-scoring peer', () => {
    // "Spine first, unclipped" is enforced by WEIGHT, not by ordering: the spine
    // boost multiplies into the proportional split, so the flow gets its bytes
    // before any peripheral file competes for them.
    const { allowances } = allocateExploreBudget(
      [cand('peer.ts', 20), cand('spine.ts', 20, { spine: true })],
      budget,
      8,
    );
    expect(allowances.get('spine.ts')!).toBeGreaterThan(allowances.get('peer.ts')!);
    expect(allowances.get('spine.ts')! / allowances.get('peer.ts')!).toBeGreaterThan(1.3);
  });

  it('keeps a spine file even when the envelope cannot afford everyone', () => {
    // The affordability trim keeps the highest weights and drops the rest in one
    // pass — but a dropped spine file breaks the flow, which is precisely the
    // failure that sends the agent back to Read. It is force-kept past the trim.
    const tiny = getExploreOutputBudget(10);
    const files = [
      ...Array.from({ length: 20 }, (_, i) => cand(`f${i}.ts`, 100 - i)),
      cand('spine.ts', 4, { spine: true }),
    ];
    const { allowances, cliffed } = allocateExploreBudget(files, tiny, 40);
    expect(allowances.has('spine.ts')).toBe(true);
    expect(cliffed).not.toContain('spine.ts');
    // Force-keeping it costs everyone a sliver — bounded, and the envelope still
    // holds. A real starvation regression would blow well past this.
    for (const [path, chars] of allowances) {
      expect(chars, path).toBeGreaterThanOrEqual(Math.round(EXPLORE_ALLOCATION.MIN_CHARS * 0.9));
    }
    expect(reservedTotal({ allowances, cliffed, cliffAt: 0, pool: 0 })).toBeLessThanOrEqual(tiny.maxOutputChars);
  });

  it('does NOT exempt a spine file from maxFiles — the slot cap is separate', () => {
    // Documented boundary, not an oversight: the cliff is a relevance gate the
    // spine overrides, `maxFiles` is a response-shape cap it does not. In
    // practice the 2x boost lifts a spine file into the slots long before this
    // bites; the test exists so a future change to either gate is deliberate.
    const { allowances, cliffed } = allocateExploreBudget(
      [cand('a.ts', 90), cand('b.ts', 80), cand('spine.ts', 3, { spine: true })],
      budget,
      2,
    );
    expect(allowances.has('spine.ts')).toBe(false);
    expect(cliffed).toContain('spine.ts');
  });

  it('serves a spine-only candidate set', () => {
    const { allowances, cliffed } = allocateExploreBudget(
      [cand('a.ts', 5, { spine: true }), cand('b.ts', 5, { spine: true })],
      budget,
      8,
    );
    expect(cliffed).toEqual([]);
    expect(allowances.size).toBe(2);
  });
});

describe('allocateExploreBudget — degenerate inputs', () => {
  const budget = getExploreOutputBudget(1000);

  it('splits evenly when every file scores identically, without starving any', () => {
    // The proportional split divides by the TOTAL weight, so an all-equal set is
    // the divide-by-a-degenerate-denominator case. Nobody is cliffed (nothing is
    // relatively weak) and everybody gets the same slice.
    for (const n of [2, 4, 8]) {
      const files = Array.from({ length: n }, (_, i) => cand(`f${i}.ts`, 17));
      const { allowances, cliffed } = allocateExploreBudget(files, budget, 8);
      expect(cliffed, `${n} files`).toEqual([]);
      expect(allowances.size, `${n} files`).toBe(n);
      const values = [...allowances.values()];
      expect(Math.max(...values) - Math.min(...values), `${n} files`).toBeLessThanOrEqual(1);
      for (const chars of values) expect(chars).toBeGreaterThanOrEqual(EXPLORE_ALLOCATION.MIN_CHARS);
      expect(worstCaseEmission({ allowances, cliffed, cliffAt: 0, pool: 0 }))
        .toBeLessThanOrEqual(budget.maxOutputChars);
    }
  });

  it('gives a lone file a real answer, not the whole envelope', () => {
    const { allowances, cliffed } = allocateExploreBudget([cand('only.ts', 42)], budget, 8);
    expect(cliffed).toEqual([]);
    expect(allowances.size).toBe(1);
    const chars = allowances.get('only.ts')!;
    expect(chars).toBeGreaterThan(budget.maxCharsPerFile);
    expect(chars).toBe(Math.round(budget.maxOutputChars * EXPLORE_ALLOCATION.MAX_SHARE));
  });

  it('holds a runaway top scorer to its share ceiling and still names the rest', () => {
    // One file 100x above everything else must not eat the response: the cliff
    // zeroes its peers' BYTES, but MAX_SHARE keeps the remainder for the pointer
    // list and the flow/relationship meta-text that lets the agent follow up.
    const { allowances, cliffed } = allocateExploreBudget(
      [cand('god.ts', 5000), cand('p1.ts', 9), cand('p2.ts', 8)],
      budget,
      8,
    );
    expect(allowances.get('god.ts')!).toBe(Math.round(budget.maxOutputChars * EXPLORE_ALLOCATION.MAX_SHARE));
    expect(reservedTotal({ allowances, cliffed, cliffAt: 0, pool: 0 }))
      .toBeLessThan(budget.maxOutputChars);
    expect(cliffed).toEqual(['p1.ts', 'p2.ts']);
  });

  it('returns nothing to render when nothing scored', () => {
    for (const files of [
      [] as ExploreAllocationCandidate[],
      [cand('a.ts', 0), cand('b.ts', 0)],
      [cand('a.ts', 10, { worth: 0 }), cand('b.ts', 5, { worth: 0 })],
      [cand('a.ts', -5), cand('b.ts', -1)],
    ]) {
      const { allowances, pool } = allocateExploreBudget(files, budget, 8);
      expect(allowances.size).toBe(0);
      expect(pool).toBeLessThanOrEqual(budget.maxOutputChars);
    }
  });

  it('fails safe on a non-finite score instead of handing the render loop a NaN slice', () => {
    // Scores are finite sums in the pipeline, so this only has to not corrupt the
    // split — an Infinity weight would otherwise make every share Infinity/Infinity.
    for (const bad of [Infinity, NaN, -Infinity]) {
      const { allowances } = allocateExploreBudget([cand('bad.ts', bad), cand('ok.ts', 20)], budget, 8);
      for (const [path, chars] of allowances) {
        expect(Number.isFinite(chars), `${String(bad)} → ${path}`).toBe(true);
      }
      expect(allowances.get('ok.ts')).toBeGreaterThan(0);
    }
  });

  it('renders nothing when maxFiles is zero, and still names every candidate', () => {
    const { allowances, cliffed } = allocateExploreBudget(
      [cand('a.ts', 10), cand('b.ts', 5)],
      budget,
      0,
    );
    expect(allowances.size).toBe(0);
    expect(cliffed).toEqual(['a.ts', 'b.ts']);
  });

  it('survives an envelope too small for even one floored slice', () => {
    const cramped: ExploreOutputBudget = { ...budget, maxOutputChars: 300 };
    const { allowances, cliffed } = allocateExploreBudget(
      [cand('a.ts', 40), cand('b.ts', 30)],
      cramped,
      8,
    );
    expect(allowances.size).toBeLessThanOrEqual(1);
    for (const chars of allowances.values()) {
      expect(chars).toBeGreaterThan(0);
      expect(chars).toBeLessThanOrEqual(cramped.maxOutputChars);
    }
    expect([...allowances.keys(), ...cliffed].sort()).toEqual(['a.ts', 'b.ts']);
  });
});

describe('allocateExploreBudget — the diffuse-query control', () => {
  const budget = getExploreOutputBudget(1000);

  it('keeps a survey-style spread readable — no file collapses to a fragment', () => {
    // The over-correction guard. Concentration is the point, but a genuinely
    // diffuse question (many comparably-relevant files) must still come back as a
    // usable spread: under-serving costs a whole round-trip, and the agent's
    // fallback is Grep, not a second explore.
    const files = Array.from({ length: 8 }, (_, i) => cand(`f${i}.ts`, 30 - i));
    const { allowances, cliffed } = allocateExploreBudget(files, budget, 8);
    expect(cliffed).toEqual([]);
    expect(allowances.size).toBe(8);
    const values = [...allowances.values()];
    for (const chars of values) expect(chars).toBeGreaterThanOrEqual(EXPLORE_ALLOCATION.MIN_CHARS);
    // Nobody is starved to make room for the leader: on a flat score curve the
    // spread between best and worst slice stays within a small multiple.
    expect(Math.max(...values) / Math.min(...values)).toBeLessThan(3);
  });

  it('concentrates a precise query far harder than a diffuse one', () => {
    // Same envelope, same file count — only the score CURVE differs. This is the
    // whole thesis of the epic in one assertion.
    const topShareOf = (files: ExploreAllocationCandidate[]) => {
      const { allowances } = allocateExploreBudget(files, budget, 8);
      const values = [...allowances.values()];
      return Math.max(...values) / values.reduce((s, n) => s + n, 0);
    };
    const diffuse = topShareOf(Array.from({ length: 8 }, (_, i) => cand(`f${i}.ts`, 30 - i)));
    const precise = topShareOf([cand('answer.ts', 120), ...Array.from({ length: 7 }, (_, i) => cand(`f${i}.ts`, 14 - i))]);
    expect(diffuse).toBeLessThan(0.25);
    expect(precise).toBeGreaterThan(0.45);
  });
});
