/**
 * Loads the framework resolvers on first use.
 *
 * Extraction asks them for a file only in a project that uses a framework, and
 * they bring most of the resolver with them: of the 137 modules a parse worker
 * loaded, 71 came from here, and in a project with no framework every worker
 * loaded them for nothing. `require()` is sync and cached on the CommonJS build.
 *
 * vitest's module transform can't service a lazy `require` of a `.ts` file, so
 * the suite replaces this file with `__tests__/lazy-frameworks-eager.ts`, as it
 * does `lazy-engine.ts`.
 */

import type * as Frameworks from '../resolution/frameworks';

let loaded: typeof Frameworks | undefined;

export function frameworks(): typeof Frameworks {
  return (loaded ??= require('../resolution/frameworks') as typeof Frameworks);
}
