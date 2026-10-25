/**
 * `codegraph --compact` flags and the `codegraph graph` call-chain command
 * (GitHub issue #500, items 3–4).
 *
 * Two layers:
 *  - unit tests for the compact formatters and the graph traversal in
 *    `src/graph/compact.ts` (cycles, depth limit, unknown symbol), driven
 *    through the public `CodeGraph` surface;
 *  - end-to-end CLI tests against the built binary, mirroring the pattern in
 *    `cli-query-command.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import {
  buildCallChain,
  formatCallChain,
  compactSymbolLabel,
  compactSymbolRelation,
} from '../src/graph/compact';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

/**
 * A tiny index scaffold:
 *
 *   a → b → { c → e, d }
 *   loop → loop (self-recursion / cycle)
 *
 * Depth from `a`: b at 1, c/d at 2, e at 3.
 */
function writeFixture(dir: string) {
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(
    path.join(dir, 'src/app.ts'),
    'export function a() { b(); }\n' +
      'export function b() { c(); d(); }\n' +
      'export function c() { e(); }\n' +
      'export function d() { }\n' +
      'export function e() { }\n' +
      'export function loop() { loop(); }\n',
  );
}

async function indexFixture(dir: string): Promise<void> {
  const cg = CodeGraph.initSync(dir);
  await cg.indexAll();
  cg.close();
}

function runCli(cwd: string, args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(
      process.execPath,
      [BIN, ...args, '-p', cwd],
      {
        encoding: 'utf-8',
        env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return { stdout, stderr: '', status: 0 };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    return {
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
      status: e.status ?? 1,
    };
  }
}

describe('compact formatters', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-compact-unit-'));
    writeFixture(tempDir);
    await indexFixture(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('compactSymbolLabel renders one dense "kind name (path:line)" line', async () => {
    const cg = await CodeGraph.open(tempDir);
    const node = cg.searchNodes('a', { limit: 1 })[0]!.node;
    expect(compactSymbolLabel(node)).toBe(`function a (src/app.ts:1)`);
    expect(compactSymbolLabel(node, false)).toBe(`a (src/app.ts:1)`);
    cg.close();
  });

  it('compactSymbolRelation returns the top dependency as a short suffix', async () => {
    const cg = await CodeGraph.open(tempDir);
    const nodeB = cg.searchNodes('b', { limit: 1 })[0]!.node;
    const rel = compactSymbolRelation(cg, [nodeB]);
    // b calls c and d; the top depends-on row is one of them.
    expect(rel).toMatch(/^calls: [cd]$/);
    cg.close();
  });
});

describe('buildCallChain / formatCallChain', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-graph-unit-'));
    writeFixture(tempDir);
    await indexFixture(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function nodeByName(name: string) {
    const cg = await CodeGraph.open(tempDir);
    const node = cg.searchNodes(name, { limit: 1 })[0]!.node;
    cg.close();
    return node;
  }

  async function treeFor(name: string, depth: number) {
    const cg = await CodeGraph.open(tempDir);
    const node = cg.searchNodes(name, { limit: 1 })[0]!.node;
    const tree = buildCallChain(cg, node, depth);
    cg.close();
    return formatCallChain(tree, { compact: true });
  }

  it('renders a call chain with branch glyphs and "calls →" edges', async () => {
    const cg = await CodeGraph.open(tempDir);
    const nodeA = cg.searchNodes('a', { limit: 1 })[0]!.node;
    const tree = buildCallChain(cg, nodeA, 2);
    const out = formatCallChain(tree, { compact: true });
    cg.close();

    expect(out).toContain('a (src/app.ts:1)');
    expect(out).toContain('└─ calls → b (src/app.ts:2)');
    expect(out).toContain('├─ calls → c (src/app.ts:3)');
    expect(out).toContain('└─ calls → d (src/app.ts:4)');
  });

  it('respects the depth limit', async () => {
    // depth 1: only b under a; c/d/e absent.
    expect(await treeFor('a', 1)).not.toContain('c (');
    expect(await treeFor('a', 1)).not.toContain('d (');
    expect(await treeFor('a', 1)).toContain('b (src/app.ts:2)');
    // depth 2: c and d appear, e does not.
    const d2 = await treeFor('a', 2);
    expect(d2).toContain('c (src/app.ts:3)');
    expect(d2).toContain('d (src/app.ts:4)');
    expect(d2).not.toContain('e (');
    // depth 3: e appears under c.
    expect(await treeFor('a', 3)).toContain('e (src/app.ts:5)');
  });

  it('marks cycles instead of recursing forever', async () => {
    const out = await treeFor('loop', 5);
    expect(out).toContain('loop (src/app.ts:6)');
    expect(out).toMatch(/calls → loop \(src\/app\.ts:6\) \(cycle\)/);
    // total lines stay bounded despite the self-recursion.
    expect(out.split('\n').length).toBeLessThanOrEqual(2);
  });

  it('default (non-compact) form keeps the kind in each label', async () => {
    const cg = await CodeGraph.open(tempDir);
    const nodeA = cg.searchNodes('a', { limit: 1 })[0]!.node;
    const tree = buildCallChain(cg, nodeA, 2);
    const out = formatCallChain(tree, { compact: false });
    cg.close();
    expect(out).toContain('function a (src/app.ts:1)');
    expect(out).toContain('calls → function b (src/app.ts:2)');
  });
});

describe('codegraph graph — CLI', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-graph-cli-'));
    writeFixture(tempDir);
    await indexFixture(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('prints a call-chain tree with --compact', () => {
    const { stdout, status } = runCli(tempDir, ['graph', 'a', '--depth', '2', '--compact']);
    expect(status).toBe(0);
    expect(stdout).toContain('a (src/app.ts:1)');
    expect(stdout).toContain('└─ calls → b (src/app.ts:2)');
    expect(stdout).toContain('├─ calls → c (src/app.ts:3)');
  });

  it('default form includes kinds and honors --depth', () => {
    const { stdout } = runCli(tempDir, ['graph', 'a', '--depth', '1']);
    expect(stdout).toContain('function a (src/app.ts:1)');
    expect(stdout).toContain('function b (src/app.ts:2)');
    expect(stdout).not.toContain('function c (');
  });

  it('marks cycles and terminates', () => {
    const { stdout, status } = runCli(tempDir, ['graph', 'loop', '--depth', '4', '--compact']);
    expect(status).toBe(0);
    expect(stdout).toMatch(/calls → loop \(src\/app\.ts:6\) \(cycle\)/);
    expect(stdout.split('\n').filter((l) => l.trim()).length).toBeLessThanOrEqual(2);
  });

  it('exits non-zero with a clear error when the symbol is unknown', () => {
    const { stderr, status } = runCli(tempDir, ['graph', 'nope']);
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/Symbol "nope" not found/);
  });
});

describe('codegraph --compact on query/callers/callees/impact — CLI', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-compact-cli-'));
    writeFixture(tempDir);
    await indexFixture(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('query --compact prints one dense line per result', () => {
    const { stdout, status } = runCli(tempDir, ['query', 'b', '--compact']);
    expect(status).toBe(0);
    expect(stdout).toMatch(/^function b \(src\/app\.ts:\d+\)/m);
  });

  it('callees --compact prints one dense line per callee', () => {
    const { stdout, status } = runCli(tempDir, ['callees', 'a', '--compact']);
    expect(status).toBe(0);
    expect(stdout).toMatch(/^function b \(src\/app\.ts:\d+\)/m);
  });

  it('callers --compact prints one dense line per caller', () => {
    const { stdout, status } = runCli(tempDir, ['callers', 'c', '--compact']);
    expect(status).toBe(0);
    expect(stdout).toMatch(/^function b \(src\/app\.ts:\d+\)/m);
  });

  it('impact --compact prints one dense line per affected symbol', () => {
    // e ← c ← b ← a; at depth 2 from e: c (1) and b (2) surface.
    const { stdout, status } = runCli(tempDir, ['impact', 'e', '--depth', '2', '--compact']);
    expect(status).toBe(0);
    expect(stdout).toMatch(/^function e \(src\/app\.ts:\d+\)/m);
    expect(stdout).toMatch(/^function c \(src\/app\.ts:\d+\)/m);
    expect(stdout).toMatch(/^function b \(src\/app\.ts:\d+\)/m);
  });
});
