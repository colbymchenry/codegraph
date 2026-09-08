import { svelte, vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineWorkspace } from 'vitest/config';

/**
 * Two projects, one command (`npm test` still runs everything).
 *
 * The split exists because of exactly one suite. `ui-package.test.ts` mounts
 * `@colbymchenry/codegraph-ui`'s components against a mock adapter (task
 * CG-61), and to do that it needs three things the engine's suites must never
 * see:
 *
 *   - the **Svelte plugin**, to compile `.svelte` and `.svelte.ts` modules;
 *   - **jsdom**, because a component without a document is not a render;
 *   - `resolve.conditions: ['browser']`, so `svelte` resolves to its client
 *     build rather than its server one (`mount()` throws on the server).
 *
 * That last one is why this is a workspace rather than one config with a
 * couple of extra fields. `browser` is a package-resolution condition, not a
 * test setting: applied globally it would also hand the engine's suites the
 * browser builds of `web-tree-sitter` and friends, and the failures that
 * causes look nothing like their cause.
 *
 * The engine project `extends` the shared base, so the env vars and Node guard
 * in `vitest.config.mts` still apply to every engine test. The ui project does
 * not — see the note on it.
 */
export default defineWorkspace([
  {
    extends: './vitest.config.mts',
    test: {
      name: 'engine',
      include: ['__tests__/**/*.test.ts'],
      exclude: ['**/node_modules/**', '**/dist/**', '__tests__/ui-package.test.ts'],
    },
  },
  {
    // Deliberately NOT `extends`: a workspace project CONCATENATES the base's
    // `include` with its own, so extending here would run all 200-odd engine
    // suites a second time inside jsdom (and two of them fail there, for
    // reasons that have nothing to do with anything). This project stands
    // alone, and it needs none of the base's spawn-related env anyway.
    plugins: [
      // The same preprocessor `ui/svelte.config.js` builds with, so the test
      // compiles what the package ships.
      svelte({ preprocess: vitePreprocess() }),
    ],
    resolve: { conditions: ['browser'] },
    test: {
      name: 'ui',
      globals: true,
      include: ['__tests__/ui-package.test.ts'],
      environment: 'jsdom',
      server: {
        deps: {
          // `@xyflow/svelte` ships uncompiled `.svelte` files, so it has to go
          // through the plugin above rather than be externalised to Node,
          // which has no idea what a `.svelte` file is.
          inline: [/@xyflow\/svelte/],
        },
      },
    },
  },
]);
