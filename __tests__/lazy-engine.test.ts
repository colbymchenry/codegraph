/**
 * A command that only reads an index doesn't load the code that writes one.
 *
 * Extraction and resolution are about 90% of the code, and loading them took
 * most of a `codegraph callers` run. `src/index.ts` now reaches them through
 * `src/lazy-engine.ts`, which vitest swaps for an eager stand-in, so these tests
 * run the real one: the built CLI and the built library, in child processes.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { CodeGraph } from '../src';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';

const DIST = path.resolve(__dirname, '../dist');
const BIN = path.join(DIST, 'bin', 'codegraph.js');
const ENGINE_FILES = ['extraction/index.js', 'extraction/tree-sitter.js', 'resolution/index.js', 'resolution/name-matcher.js', 'sync/watcher.js'];

const env = { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' };

function node(args: string[], cwd: string): string {
  return execFileSync(process.execPath, [...WASM_RUNTIME_FLAGS, ...args], {
    cwd,
    encoding: 'utf-8',
    env,
    stdio: ['ignore', 'pipe', 'ignore'], // drop stderr (SQLite experimental warning)
  });
}

describe('the engine stays unloaded until something needs it', () => {
  let root: string;
  let dir: string;
  let hook: string;
  let loadedList: string;

  /** Run the built CLI, and list the files of dist/ it loaded. */
  function cli(args: string[]): { stdout: string; loaded: string[] } {
    const stdout = node(['--require', hook, BIN, ...args], dir);
    const files = JSON.parse(fs.readFileSync(loadedList, 'utf-8')) as string[];
    return {
      stdout,
      loaded: files.filter((f) => f.startsWith(DIST)).map((f) => path.relative(DIST, f).split(path.sep).join('/')),
    };
  }

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-lazy-engine-'));
    dir = path.join(root, 'project');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/auth.ts'), 'export function parseToken(t: string) { return t.trim(); }\n');
    fs.writeFileSync(
      path.join(dir, 'src/login.ts'),
      "import { parseToken } from './auth';\nexport function login(t: string) { return parseToken(t); }\n",
    );
    const cg = await CodeGraph.init(dir, { index: true });
    cg.destroy();

    loadedList = path.join(root, 'loaded.json');
    hook = path.join(root, 'hook.cjs');
    fs.writeFileSync(
      hook,
      `process.on('exit', () => require('fs').writeFileSync(${JSON.stringify(loadedList)}, JSON.stringify(Object.keys(require.cache))));\n`,
    );
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['callers', ['callers', 'parseToken', '-p', '.'], 'login'],
    ['query', ['query', 'parseToken', '-p', '.'], 'parseToken'],
  ])('`codegraph %s` answers without it', (_name, args, expected) => {
    const { stdout, loaded } = cli(args);
    expect(stdout).toContain(expected);
    expect(loaded).toContain('index.js');
    expect(loaded.filter((f) => ENGINE_FILES.includes(f))).toEqual([]);
  });

  it('`codegraph status` loads it for what only the engine can answer', () => {
    const { stdout, loaded } = cli(['status', dir]);
    expect(stdout).toContain('Index Statistics');
    expect(stdout).not.toContain('Pending Changes');
    expect(loaded).toContain('extraction/index.js');
  });

  it('`codegraph sync` writes through it', () => {
    fs.writeFileSync(path.join(dir, 'src/auth.ts'), 'export function parseToken(t: string) { return t; }\nexport function freshName() {}\n');
    const { loaded } = cli(['sync', dir]);
    expect(loaded).toContain('extraction/index.js');
    expect(cli(['query', 'freshName', '-p', '.']).stdout).toContain('freshName');
  });

  it('the library still exports everything, and loads the engine only for a name that needs it', () => {
    const script = `
      const lib = require(${JSON.stringify(path.join(DIST, 'index.js'))});
      const loaded = (f) => Object.keys(require.cache).some((k) => k.endsWith(require('path').join(...f.split('/'))));
      const before = loaded('extraction/tree-sitter.js') || loaded('mcp/index.js');
      const names = ['CodeGraph', 'MCPServer', 'FileWatcher', 'LockUnavailableError', 'initGrammars', 'detectLanguage', 'loadAllGrammars'];
      const missing = names.filter((n) => !Object.keys(lib).includes(n));
      const stillLazy = !loaded('extraction/tree-sitter.js');
      const server = typeof lib.MCPServer;
      const watcher = typeof lib.FileWatcher;
      const sync = require(${JSON.stringify(path.join(DIST, 'sync', 'index.js'))});
      const sameError = lib.LockUnavailableError === sync.LockUnavailableError;
      console.log(JSON.stringify({ before, missing, stillLazy, server, watcher, sameError }));
    `;
    expect(JSON.parse(node(['-e', script], dir))).toEqual({
      before: false,
      missing: [],
      stillLazy: true,
      server: 'function',
      watcher: 'function',
      sameError: true,
    });
  });

  it('an ES module can import the lazy names by name', () => {
    const url = pathToFileURL(path.join(DIST, 'index.js')).href;
    const script = `import { FileWatcher, MCPServer, LockUnavailableError } from ${JSON.stringify(url)};
      console.log(typeof FileWatcher, typeof MCPServer, typeof LockUnavailableError);`;
    expect(node(['--input-type=module', '-e', script], dir).trim()).toBe('function function function');
  });
});
