/**
 * What `src/extraction/lazy-frameworks.ts` is under vitest, by the alias in
 * `vitest.config.mts`: its `require` of a `.ts` module is one the suite's module
 * transform can't service.
 */

import * as Frameworks from '../src/resolution/frameworks';

export function frameworks(): typeof Frameworks {
  return Frameworks;
}
