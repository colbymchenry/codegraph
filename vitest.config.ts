import { defineConfig } from 'vitest/config';

const NODE_MAJOR = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);

// The V8 turboshaft WASM Zone OOM bug that crashes tree-sitter grammar
// compilation exists in Node 22–25.x. Node 26+ fixes it; forcing
// --liftoff-only on Node 26 Windows is empirically tied to a fork-worker
// teardown crash in tinypool, so only apply the flag where it's needed.
const NEEDS_LIFTOFF_ONLY = NODE_MAJOR >= 22 && NODE_MAJOR <= 25;

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    poolOptions: {
      forks: {
        execArgv: NEEDS_LIFTOFF_ONLY ? ['--liftoff-only'] : [],
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
