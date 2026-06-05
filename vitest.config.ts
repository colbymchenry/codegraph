import { defineConfig } from 'vitest/config';

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
    env: { CODEGRAPH_ALLOW_UNSAFE_NODE: '1' },
    /**
     * Keep tree-sitter grammar compilation off V8's turboshaft optimizing
     * tier inside test workers, exactly as every production launch path does
     * (see src/extraction/wasm-runtime-flags.ts, issues #293/#298). Without
     * it, suites that load many grammars (extraction.test.ts loads ALL of
     * them in beforeAll) can abort the worker with the turboshaft Zone OOM —
     * observed reliably on an arm64 Mac with Node 24: the worker dies mid-
     * file and the remaining tests silently never run ("Worker exited
     * unexpectedly", ~90 tests vanish from the count). The flag must be on
     * the node command line, so it has to go through execArgv — NODE_OPTIONS
     * disallows it and runtime v8.setFlagsFromString is too late.
     */
    poolOptions: {
      forks: { execArgv: ['--liftoff-only'] },
      threads: { execArgv: ['--liftoff-only'] },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
