import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { WASM_RUNTIME_FLAGS } from './src/extraction/wasm-runtime-flags';

/**
 * One process, two Vitest projects. The engine stays in Node; the UI package
 * test alone gets Svelte compilation, jsdom and browser resolution conditions.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    /**
     * Several MCP integration tests (mcp-daemon, mcp-initialize, mcp-ppid-watchdog,
     * mcp-roots) spawn `dist/bin/codegraph.js serve --mcp` with `process.execPath`
     * and rely on the child inheriting `process.env`. On a Node >= 25 dev machine
     * the CLI's hard-block (src/bin/codegraph.ts) would otherwise exit the child
     * before it ever responds, so every spawn-based test times out — see #478.
     *
     * Setting the override here keeps the CLI's runtime guard intact for end
     * users (it's still enforced when `codegraph` is invoked directly) while
     * letting the test suite run on whatever Node the contributor happens to
     * have installed. CI on Node 22/23 is unaffected — the guard doesn't fire
     * there, so the variable is a no-op.
     */
    env: {
      CODEGRAPH_ALLOW_UNSAFE_NODE: '1',
      /**
       * The suite spawns real CLI/MCP processes; without this they would write
       * telemetry state into the contributor's real ~/.codegraph and count test
       * tool calls as real usage. The telemetry unit tests are unaffected —
       * they inject their own `env` via the Telemetry constructor.
       */
      CODEGRAPH_TELEMETRY: '0',
    },
    /**
     * The same V8 flags every real launch path passes (the bundled launcher,
     * the CLI's self re-exec, refresh-launcher): keep tree-sitter grammar
     * compilation on the Liftoff baseline tier. Without them a pool worker
     * runs the grammars on the turboshaft optimizing tier, and once enough
     * parses have warmed a grammar function up, its background tier-up job
     * exhausts a compiler Zone and aborts the worker — `Fatal process out of
     * memory: Zone`, surfaced by vitest only as "Worker exited unexpectedly"
     * with the rest of the file's tests silently unrun (#1779, #1883; the
     * product-side story is in wasm-runtime-flags.ts, #293/#298). V8 flags are
     * process-global, so the parse worker threads a test spawns are covered
     * too. Vitest 4 reads `test.execArgv`; the 2.x `poolOptions.forks.execArgv`
     * is silently ignored here. The engine project inherits it via `extends`.
     */
    execArgv: [...WASM_RUNTIME_FLAGS],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'engine',
          include: ['__tests__/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', '__tests__/ui-package.test.ts'],
        },
      },
      {
        // Browser package resolution must not leak into the engine project:
        // web-tree-sitter and other dual packages would resolve differently.
        extends: false,
        plugins: [svelte({ configFile: 'ui/svelte.config.js' })],
        resolve: { conditions: ['browser'] },
        test: {
          name: 'ui',
          globals: true,
          include: ['__tests__/ui-package.test.ts'],
          environment: 'jsdom',
          server: {
            deps: {
              // @xyflow/svelte ships source .svelte files that Node cannot load.
              inline: [/@xyflow\/svelte/],
            },
          },
        },
      },
    ],
  },
});
