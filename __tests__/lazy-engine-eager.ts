/**
 * What `src/lazy-engine.ts` is under vitest, by the alias in `vitest.config.mts`.
 * The suite's module transform can't service that file's `require` of a `.ts`
 * module, so this imports the same modules up front, which also keeps every
 * `vi.mock` of an engine module working. `lazy-engine.test.ts` covers the real
 * file through the built CLI.
 */

import * as Engine from '../src/engine';

export { FileWatcher } from '../src/sync/watcher';
export { MCPServer } from '../src/mcp';

export function engine(): typeof Engine {
  return Engine;
}
