import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

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
