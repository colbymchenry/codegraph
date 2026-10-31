/**
 * Loads `./engine` on first use.
 *
 * Reading an index needs the database and the graph layers, a small part of
 * the code. Extraction, resolution and everything they pull in are about 90%
 * of it, and loading them took most of a `codegraph callers` run. `require()`
 * is sync and cached on the CommonJS build, so `src/index.ts` can reach them at
 * the moment it needs them, from sync and async code alike.
 *
 * vitest's module transform can't service a lazy `require` of a `.ts` file (see
 * `loadCodeGraphForTests` in `mcp/tools.ts`), so the suite replaces this file
 * with `__tests__/lazy-engine-eager.ts`, which imports the same modules up
 * front: an alias in `vitest.config.mts`. `__tests__/lazy-engine.test.ts` runs
 * this one, through the built CLI.
 */

import type * as Engine from './engine';

let loaded: typeof Engine | undefined;

export function engine(): typeof Engine {
  return (loaded ??= require('./engine') as typeof Engine);
}

// The two classes of the public API that live in the lazy half. `export { X }
// from` compiles to a `require` at load, so `src/index.ts` re-exports these
// instead, and they resolve when a consumer first reads them.
export declare const FileWatcher: typeof Engine.FileWatcher;
export type FileWatcher = Engine.FileWatcher;
export declare const MCPServer: typeof import('./mcp').MCPServer;
export type MCPServer = import('./mcp').MCPServer;

Object.defineProperty(exports, 'FileWatcher', {
  enumerable: true,
  get: () => engine().FileWatcher,
});
Object.defineProperty(exports, 'MCPServer', {
  enumerable: true,
  get: () => (require('./mcp') as typeof import('./mcp')).MCPServer,
});
