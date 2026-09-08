import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// The viewer is emitted straight into the engine's `dist/` tree so it ships
// with everything else: `build-bundle.sh` copies `dist` wholesale and
// `pack-npm.sh` packs that bundle, so nothing extra has to be taught about it.
//
// NOT `dist/ui` — that name is already taken. `src/ui/` is the engine's
// TERMINAL ui (shimmer progress + its worker) and tsc compiles it to
// `dist/ui/`, so emitting here would both clobber it (emptyOutDir) and, worse,
// leave the CLI serving compiled engine internals as static files.
//
// `fileURLToPath` (not a bare '../dist/viewer') keeps this a native path on
// Windows, where Rollup resolves outDir against the platform separator.
const outDir = fileURLToPath(new URL('../dist/viewer', import.meta.url));

export default defineConfig(({ command }) => {
  // `vite build` does NOT override an ambient NODE_ENV, and Svelte compiles in
  // dev mode when it sees one — a shell (or a CI runner) with
  // NODE_ENV=development silently ships a viewer carrying Svelte's dev-only
  // runtime checks: ~13 kB larger, slower, and warning in the user's console.
  // A release artifact must not depend on the machine that built it.
  if (command === 'build') process.env.NODE_ENV = 'production';

  return {
    plugins: [svelte()],
    // Relative asset URLs: the CLI serves this at '/', but a relative base also
    // survives being opened from the filesystem or mounted under a sub-path.
    base: './',
    build: {
      // Scoped to dist/viewer — `emptyOutDir` must never be allowed to widen
      // to dist/, which holds the compiled engine tsc wrote moments earlier.
      outDir,
      emptyOutDir: true,
      target: 'es2022',
      // A localhost reader has the sources on disk already; sourcemaps would
      // double the bundle in every platform archive for no one's benefit.
      sourcemap: false,
      chunkSizeWarningLimit: 1024,
    },
    server: {
      host: '127.0.0.1',
      port: 5174,
    },
  };
});
