/**
 * The `MCPServer` re-export of `src/index.ts` is lazy (perf/query-startup-lazy-load).
 *
 * The old `export { MCPServer } from './mcp'` pulled the whole MCP module
 * graph — daemon, proxy, engine, session, writer-lock, tools — into every
 * consumer of the package entry the moment it was required. The CLI's
 * `query` reaches that entry through `loadCodeGraph()` and never touches the
 * MCP server, so it paid for all of it at startup. See
 * docs/benchmarks/query-startup-lazy-mcp.md for the before/after numbers.
 *
 * The contract these tests lock in:
 *
 * 1. Requiring the built entry loads no `dist/mcp` module beyond the
 *    dependency-free `mcp/version`.
 * 2. Touching `MCPServer` loads `./mcp` on demand and yields exactly the
 *    class `./mcp` exports (same identity, same constructor behaviour).
 * 3. `import { MCPServer } from 'codegraph'` keeps working from ESM — the
 *    lazy getter is deliberately written in the shape `tsc` emits for a
 *    static re-export, because CommonJS named-export detection
 *    (cjs-module-lexer) recognizes nothing else.
 * 4. `codegraph query` — the command this optimization is for — runs its
 *    whole startup without loading the MCP server graph.
 *
 * The CLI entry itself eagerly imports a handful of small `mcp/*` support
 * modules for its supervision/handshake plumbing (see `src/bin/codegraph.ts`):
 * those are unchanged by this work and are not part of the MCP server graph
 * that `src/index.ts` used to pull in.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'dist', 'index.js');
const BIN = path.join(ROOT, 'dist', 'bin', 'codegraph.js');

/**
 * The `mcp/*` modules `src/bin/codegraph.ts` loads for supervision and the
 * daemon handshake, independently of `src/index.ts`. Everything else under
 * `mcp/` — `index.js`, `tools.js`, `engine.js`, `session.js`, `proxy.js`,
 * `daemon.js`, `transport.js`, … — is the server graph `query` must not load.
 */
const CLI_SUPPORT_MCP_MODULES = new Set([
  'mcp/daemon-paths.js',
  'mcp/daemon-registry.js',
  'mcp/early-ppid.js',
  'mcp/liveness-watchdog.js',
  'mcp/ppid-watchdog.js',
  'mcp/process-identity.js',
  'mcp/version.js',
  'mcp/writer-lock.js',
]);

/**
 * JS that prints `require.cache`'s `dist/mcp` modules as `mcp/<file>` names.
 * The path match and the normalization are separator-agnostic (Windows uses
 * backslashes).
 */
const mcpModulesScript = `Object.keys(require.cache)
  .filter((m) => /[\\\\/]dist[\\\\/]mcp[\\\\/]/.test(m))
  .map((m) => m.replace(/^.*[\\\\/]dist[\\\\/]mcp[\\\\/]/, 'mcp/'))
  .sort()`;

function node(script: string, extraArgs: string[] = []): string {
  const r = spawnSync(process.execPath, [...extraArgs, '-e', script], {
    cwd: ROOT,
    encoding: 'utf-8',
    env: { ...process.env, CODEGRAPH_TELEMETRY: '0' },
  });
  if (r.status !== 0) {
    throw new Error(`node ${extraArgs.join(' ')} exited ${r.status}: ${(r.stdout ?? '') + (r.stderr ?? '')}`);
  }
  return (r.stdout ?? '').trim();
}

describe('the lazy MCPServer re-export of the package entry', () => {
  it('loads no MCP server module until MCPServer is touched, then resolves to the real class', () => {
    const out = node(`
      const entry = require(${JSON.stringify(ENTRY)});
      const mods = () => ${mcpModulesScript};
      const before = mods();
      // The export is listed before it is ever read.
      const listed = Object.keys(entry).includes('MCPServer');
      const after = mods();
      const Server = entry.MCPServer;
      const loaded = mods();
      const identity = Server === require(${JSON.stringify(path.join(ROOT, 'dist', 'mcp', 'index.js'))}).MCPServer;
      const instance = new Server('/tmp/lazy-mcp-export');
      console.log(JSON.stringify({ before, listed, after, loaded, identity,
        construct: instance instanceof Server,
        name: Server.name,
        surface: ['default', 'CodeGraph', 'QueryBuilder', 'initGrammars', 'FileWatcher', 'LockUnavailableError', 'Mutex']
          .every((k) => typeof entry[k] === 'function') }));
    `);
    const r = JSON.parse(out);
    // (1) Nothing from the MCP server graph at load time — at most the
    // dependency-free mcp/version, which this entry imports eagerly on
    // purpose.
    expect(r.before.length).toBeLessThanOrEqual(1);
    expect(r.before.every((m: string) => m.endsWith('mcp/version.js'))).toBe(true);
    // Listing the export does not trigger the load.
    expect(r.listed).toBe(true);
    expect(r.after).toEqual(r.before);
    // (2) First access loads ./mcp and is the real class.
    expect(r.loaded.length).toBeGreaterThan(5);
    expect(r.identity).toBe(true);
    expect(r.construct).toBe(true);
    expect(r.name).toBe('MCPServer');
    // The rest of the export surface is untouched.
    expect(r.surface).toBe(true);
  });

  it('keeps the ESM named export working', () => {
    const out = node(`
      import { MCPServer, CodeGraph } from ${JSON.stringify(ENTRY)};
      const instance = new MCPServer('/tmp/lazy-mcp-export-esm');
      console.log(JSON.stringify({
        type: typeof MCPServer,
        name: MCPServer.name,
        construct: instance instanceof MCPServer,
        codegraph: typeof CodeGraph,
      }));
    `, ['--input-type=module']);
    const r = JSON.parse(out);
    expect(r.type).toBe('function');
    expect(r.name).toBe('MCPServer');
    expect(r.construct).toBe(true);
    expect(r.codegraph).toBe('function');
  });

  describe('codegraph query', () => {
    let root: string;

    beforeAll(async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-lazy-mcp-'));
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'src', 'handler.ts'),
        'export function handleEvent(event: string): string {\n  return event;\n}\n',
      );
      const cg = await CodeGraph.init(root, { index: true });
      cg.close();
    });

    afterAll(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('never loads the MCP server graph while starting up and searching', () => {
      // The preload dumps require.cache's dist/mcp modules at exit. The CLI
      // re-executes itself when WASM runtime flags are missing, and the
      // re-exec'd child would not carry the preload — skip the relaunch so
      // the probe observes the process that actually runs the query (the
      // same env the other CLI suites pass).
      const probe = path.join(root, 'module-probe.cjs');
      fs.writeFileSync(
        probe,
        `const fs = require('fs');
process.on('exit', () => {
  const mods = ${mcpModulesScript};
  fs.writeFileSync(process.env.CG_MODULE_PROBE_OUT, JSON.stringify(mods));
});
`,
      );
      const probeOut = path.join(root, 'module-probe.json');
      const r = spawnSync(process.execPath, ['-r', probe, BIN, 'query', 'handleEvent', '--json', '--path', root], {
        cwd: ROOT,
        encoding: 'utf-8',
        env: {
          ...process.env,
          CODEGRAPH_TELEMETRY: '0',
          CODEGRAPH_WASM_RELAUNCHED: '1',
          CODEGRAPH_NO_DAEMON: '1',
          CG_MODULE_PROBE_OUT: probeOut,
        },
      });
      expect(r.status).toBe(0);
      // The search really ran through the library entry.
      expect((r.stdout ?? '')).toContain('handleEvent');
      const loaded: string[] = JSON.parse(fs.readFileSync(probeOut, 'utf-8'));
      expect(loaded.every((m) => CLI_SUPPORT_MCP_MODULES.has(m))).toBe(true);
      expect(loaded).not.toContain('mcp/index.js');
      expect(loaded).not.toContain('mcp/tools.js');
    });
  });
});
