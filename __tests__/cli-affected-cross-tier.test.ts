/**
 * `codegraph affected` stops at a process boundary by default (#3320).
 *
 * The tier pass links a client's literal HTTP call onto the route that serves
 * it, a queue job onto its consumer, an event onto its handler. Those links are
 * real at runtime, but a test on the other side mocks that boundary: an
 * Angular service's spec stubs `HttpClient`, so a change to the Spring
 * controller doesn't affect it. Following them turned one backend change into
 * the whole frontend's test run. `affected` now leaves them out, and
 * `--cross-tier` follows them again. The library call keeps its answer unless
 * asked.
 *
 * Exercised end-to-end against the built binary.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function affected(cwd: string, ...args: string[]): string[] {
  const out = execFileSync(process.execPath, [BIN, 'affected', ...args, '--quiet', '-p', cwd], {
    encoding: 'utf-8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

describe('codegraph affected — links across a process boundary (#3320)', () => {
  let root: string;

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-affected-tier-')));
    const write = (rel: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    };
    write('package.json', JSON.stringify({ name: 'shop', dependencies: { express: '^4.0.0' } }));
    // The server: a route and its handler, with a test that calls the handler.
    write(
      'server/routes.js',
      "const app = require('express')()\n" +
        'function listItems (req, res) { res.json([]) }\n' +
        "app.get('/api/items', listItems)\n" +
        'module.exports = { listItems }\n',
    );
    write(
      'server/routes.test.js',
      "const { listItems } = require('./routes')\n" +
        "test('lists items', () => listItems({}, { json () {} }))\n",
    );
    // The client: a literal call to that route, with a test that calls the client.
    write('client/api.js', "export async function loadItems () { return fetch('/api/items') }\n");
    write(
      'client/api.test.js',
      "import { loadItems } from './api'\n" +
        "test('loads items', () => loadItems())\n",
    );
    const cg = CodeGraph.initSync(root);
    await cg.indexAll();
    cg.close();
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('selects only the server side for a server change by default', () => {
    expect(affected(root, 'server/routes.js')).toEqual(['server/routes.test.js']);
  });

  it('follows the client call to the route again with --cross-tier', () => {
    expect(affected(root, 'server/routes.js', '--cross-tier')).toEqual(['client/api.test.js', 'server/routes.test.js']);
  });

  it('keeps the library call\'s answer unless asked to skip tiers', async () => {
    const cg = await CodeGraph.open(root);
    try {
      expect(cg.getFileDependents('server/routes.js').sort()).toEqual(['client/api.js', 'server/routes.test.js']);
      expect(cg.getFileDependents('server/routes.js', { skipTiers: true })).toEqual(['server/routes.test.js']);
    } finally {
      cg.close();
    }
  });
});
