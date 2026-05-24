import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    // Pass --liftoff-only to vitest fork workers so their parse-worker threads
    // inherit the flag. This prevents the V8 turboshaft Zone OOM that crashes
    // the process when tree-sitter grammars are compiled on Node >= 22.
    // (Worker threads can't receive V8 flags via execArgv directly — only the
    // parent fork process can, and threads inherit from it.)
    poolOptions: {
      forks: {
        execArgv: ['--liftoff-only'],
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
