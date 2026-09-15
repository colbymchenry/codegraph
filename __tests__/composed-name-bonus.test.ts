/**
 * The two exact-name discounts compose, and the composition has to keep the
 * same invariant each one pins alone: an exact name the user typed never loses
 * to a mere prefix match.
 *
 * #1462 (corpus-frequency discount) and #1463 (de-prioritized-path damping)
 * each clear that bound in isolation — `80 * 0.6 = 48 > 40` and
 * `80 * 0.75 - 15 = 45 > 40` — but each suite pins its invariant with the other
 * lever off. Multiplied, a name that is both corpus-common AND inside a
 * de-prioritized tree lands at `80 * 0.6 * 0.75 - 15 = 21`, well under the
 * prefix arm's supremum of 40. Neither existing test can see it.
 *
 * The general condition, with the -15 path penalty a de-prioritized node also
 * carries: `80 * combined - 15 > 40`, i.e. `combined > 55/80 = 0.6875`.
 */
import { describe, it, expect } from 'vitest';
import {
  nameMatchBonus,
  nameMatchIdfScale,
  combinedExactNameScale,
  NAME_MATCH_IDF_FLOOR,
  COMBINED_EXACT_NAME_FLOOR,
  type NameCorpusStats,
} from '../src/search/query-utils';
import { DEPRIORITIZED_NAME_BONUS_SCALE } from '../src/db/queries';

/** The prefix arm is `round(10 + 30 * ratio)`, so 40 is its supremum. */
const PREFIX_ARM_SUPREMUM = 40;
/** A de-prioritized path also takes the flat path penalty. */
const PATH_PENALTY = 15;
/** `80 * s - 15 > 40` → `s > 55/80`. */
const REQUIRED_COMBINED_SCALE = (PREFIX_ARM_SUPREMUM + PATH_PENALTY) / 80;

/** A corpus where `name` is shared by `df` of `total` nodes. */
function corpusWith(name: string, df: number, total: number): NameCorpusStats {
  return {
    total,
    countForName: (n: string): number => (n.toLowerCase() === name.toLowerCase() ? df : 1),
  };
}

describe('the two exact-name discounts compose (#1462 + #1463)', () => {
  it('states the bound the composition has to clear', () => {
    expect(REQUIRED_COMBINED_SCALE).toBeCloseTo(0.6875, 6);
  });

  it('regression: the naive product falls under the bound', () => {
    // Not how the code composes them — asserted so the failure this test was
    // written for stays visible, and nobody reintroduces the multiplication.
    const product = NAME_MATCH_IDF_FLOOR * DEPRIORITIZED_NAME_BONUS_SCALE;
    expect(product).toBeLessThan(REQUIRED_COMBINED_SCALE);
    expect(80 * product - PATH_PENALTY).toBeLessThan(PREFIX_ARM_SUPREMUM);
  });

  it('the combined floor clears the bound at the worst case of both levers', () => {
    expect(COMBINED_EXACT_NAME_FLOOR).toBeGreaterThan(REQUIRED_COMBINED_SCALE);
    const worst = combinedExactNameScale(NAME_MATCH_IDF_FLOOR, true);
    expect(Math.round(80 * worst) - PATH_PENALTY).toBeGreaterThan(PREFIX_ARM_SUPREMUM);
  });

  it('a de-prioritized, corpus-common exact name still beats a prefix match', () => {
    // `child` shared by 400 of 60k nodes drives the IDF scale to its floor, and
    // the node also sits in a de-prioritized tree. It must still outrank the
    // prefix match `children`, after the -15 the de-prioritized path takes.
    const corpus = corpusWith('child', 400, 60_000);
    expect(nameMatchIdfScale(400, 60_000)).toBeCloseTo(NAME_MATCH_IDF_FLOOR, 6);

    const exactDeprioritized = nameMatchBonus('child', 'child', corpus, true) - PATH_PENALTY;
    const prefix = nameMatchBonus('children', 'child', corpus, false);

    expect(prefix).toBeLessThanOrEqual(PREFIX_ARM_SUPREMUM);
    expect(exactDeprioritized).toBeGreaterThan(prefix);
  });

  it('neither lever alone is weakened by the fix', () => {
    const corpus = corpusWith('child', 400, 60_000);
    // #1462 in isolation: corpus-common, not de-prioritized. No path penalty.
    expect(nameMatchBonus('child', 'child', corpus, false)).toBeGreaterThan(PREFIX_ARM_SUPREMUM);
    // #1463 in isolation: de-prioritized, but a rare name.
    const rare = corpusWith('nothingElse', 1, 60_000);
    expect(nameMatchBonus('child', 'child', rare, true) - PATH_PENALTY).toBeGreaterThan(
      PREFIX_ARM_SUPREMUM,
    );
  });

  it('still discounts: a common de-prioritized name ranks below a rare one', () => {
    const common = corpusWith('child', 400, 60_000);
    const rare = corpusWith('nothingElse', 1, 60_000);
    expect(nameMatchBonus('child', 'child', common, true)).toBeLessThan(
      nameMatchBonus('child', 'child', rare, true),
    );
  });

  it('leaves the undiscounted path alone when no corpus is supplied', () => {
    expect(nameMatchBonus('child', 'child')).toBe(80);
    expect(nameMatchBonus('child', 'child', undefined, true)).toBe(
      Math.round(80 * DEPRIORITIZED_NAME_BONUS_SCALE),
    );
  });

  it('does not touch the prefix or substring arms', () => {
    const corpus = corpusWith('children', 400, 60_000);
    // Prefix arm is length-scaled and small; the discount never applied to it.
    expect(nameMatchBonus('children', 'child', corpus, false)).toBe(
      nameMatchBonus('children', 'child', undefined, false),
    );
  });
});
