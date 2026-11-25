/**
 * `codegraph callers` lists every place a caller calls the symbol, and a
 * symbol that calls itself among its callers (#2909).
 *
 * Callers kept one row per caller (#1086), with the caller's first edge only,
 * and left the symbol itself out, so a method called on two lines of `build`
 * showed one, and a recursive call none at all, though the index stores them
 * and each is a line to edit when the symbol changes. The rows stay one per
 * caller; the sites go inside the row: `src/report.ts:9, 10`. The CLI, the
 * codegraph_callers / codegraph_callees tools and codegraph_node's trail read
 * them from one place, `getCallSites`, while `getCallers` / `getCallees`, which
 * ranking and the flow and impact walks use, read as they did.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { ToolHandler } from '../src/mcp/tools';
import type { Node } from '../src/types';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
const BUSY = 30;

let root = '';
let cg: CodeGraph;
let handler: ToolHandler;

const files: Record<string, string> = {
  // The issue's example, with the recursion written `this.walk()`.
  'src/report.ts': [
    'export class Logger {',
    '  log(message: string): void {}',
    '}',
    '',
    'export class Report {',
    '  constructor(private readonly logger: Logger) {}',
    '',
    '  build(): void {',
    "    this.logger.log('start');",
    "    this.logger.log('end');",
    '  }',
    '}',
    '',
    'export class TreeNode {',
    '  children: TreeNode[] = [];',
    '',
    '  walk(): void {',
    '    this.walk();',
    '  }',
    '}',
    '',
  ].join('\n'),
  'src/once.ts': [
    "import { Logger } from './report';",
    '',
    'export function once(logger: Logger): void {',
    "  logger.log('only');",
    '}',
    '',
  ].join('\n'),
  'src/math.ts': [
    'export function factorial(n: number): number {',
    '  return n <= 1 ? 1 : n * factorial(n - 1);',
    '}',
    '',
    'export function tally(): number {',
    '  return factorial(3) + factorial(4);',
    '}',
    '',
  ].join('\n'),
  // A caller with more call sites than any list shows.
  'src/busy.ts': [
    "import { Logger } from './report';",
    '',
    'export function busy(logger: Logger): void {',
    ...Array.from({ length: BUSY }, (_, i) => `  logger.log('${i}');`),
    '}',
    '',
  ].join('\n'),
};

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-call-sites-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
  handler = new ToolHandler(cg);
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function named(name: string, file: string): Node {
  const node = cg.getNodesInFile(file).find((n) => n.name === name);
  expect(node, `${file}:${name}`).toBeDefined();
  return node!;
}

function cli(...args: string[]): string {
  const result = spawnSync(process.execPath, [BIN, ...args, '-p', root], {
    encoding: 'utf-8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', NO_COLOR: '1', DO_NOT_TRACK: '1', CODEGRAPH_TELEMETRY: '0' },
    timeout: 60_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

async function tool(name: string, args: Record<string, unknown>): Promise<string> {
  const res = await handler.execute(name, args);
  return res.content?.[0]?.text ?? '';
}

describe('call sites of a symbol (#2909)', () => {
  it('keeps one row per caller with every site in it', () => {
    const rows = cg.getCallSites(named('log', 'src/report.ts').id, 'callers');
    const build = rows.filter((row) => row.node.name === 'build');
    expect(build).toHaveLength(1);
    expect(build[0]!.edges.map((e) => e.line)).toEqual([9, 10]);
    expect(build[0]!.recursive).toBe(false);
    expect(rows.find((row) => row.node.name === 'once')!.edges.map((e) => e.line)).toEqual([4]);
  });

  it('lists a symbol that calls itself as its own caller and callee', () => {
    for (const [name, file, line] of [['walk', 'src/report.ts', 18], ['factorial', 'src/math.ts', 2]] as const) {
      const node = named(name, file);
      for (const direction of ['callers', 'callees'] as const) {
        const self = cg.getCallSites(node.id, direction).filter((row) => row.node.id === node.id);
        expect(self, `${name} ${direction}`).toHaveLength(1);
        expect(self[0]!.recursive).toBe(true);
        expect(self[0]!.edges.map((e) => e.line)).toEqual([line]);
      }
    }
  });

  it('leaves getCallers and getCallees as they were: the first edge, never the symbol itself', () => {
    for (const node of cg.getNodesByKind('method').concat(cg.getNodesByKind('function'))) {
      for (const direction of ['callers', 'callees'] as const) {
        const before = (direction === 'callers' ? cg.getCallers(node.id) : cg.getCallees(node.id))
          .map((c) => [c.node.id, c.edge.line, c.edge.kind]);
        const now = cg.getCallSites(node.id, direction)
          .filter((row) => !row.recursive)
          .map((row) => [row.node.id, row.edges[0]!.line, row.edges[0]!.kind]);
        expect(now, `${node.name} ${direction}`).toEqual(before);
      }
    }
  });
});

describe('codegraph callers / callees', () => {
  it('prints a caller at the lines it calls from, and a recursive one as calling itself', () => {
    const text = cli('callers', 'Logger.log');
    expect(text).toMatch(/method\s+build\n\s+src\/report\.ts:9, 10\n/);
    expect(text).toMatch(/function\s+once\n\s+src\/once\.ts:4\n/);
    expect(text.match(/\bbuild\b/g)).toHaveLength(1);
    const walk = cli('callers', 'TreeNode.walk');
    expect(walk).toMatch(/method\s+walk \(calls itself\)\n\s+src\/report\.ts:18\n/);
    // Callees keep the callee's own line: where a call leads.
    expect(cli('callees', 'tally')).toMatch(/function\s+factorial\n\s+src\/math\.ts:1\n/);
  });

  it('caps one caller at ten sites in text, and lists them all in JSON', () => {
    expect(cli('callers', 'Logger.log')).toMatch(/function\s+busy\n\s+src\/busy\.ts:4, 5, 6, 7, 8, 9, 10, 11, 12, 13, \+20 more\n/);
    const out = JSON.parse(cli('callers', 'Logger.log', '--json'));
    const busy = out.definitions[0].callers.find((row: { name: string }) => row.name === 'busy');
    expect(busy.lines).toEqual(Array.from({ length: BUSY }, (_, i) => 4 + i));
    expect(busy.recursive).toBe(false);
    const build = out.callers.find((row: { name: string }) => row.name === 'build');
    expect(build).toMatchObject({ lines: [9, 10], recursive: false });
    const buildId = out.definitions[0].callers.find((row: { name: string }) => row.name === 'build').id;
    expect(out.definitions[0].edges.filter((e: { source: string }) => e.source === buildId).map((e: { line: number }) => e.line))
      .toEqual([9, 10]);
    const walk = JSON.parse(cli('callers', 'TreeNode.walk', '--json'));
    expect(walk.callers).toEqual([expect.objectContaining({ name: 'walk', lines: [18], recursive: true })]);
  });
});

describe('codegraph_callers / codegraph_callees and the codegraph_node trail', () => {
  it('lists every site of a caller, capped, and a recursive call', async () => {
    const callers = await tool('codegraph_callers', { symbol: 'Logger.log' });
    expect(callers).toContain('- build (method) - src/report.ts:9, 10');
    expect(callers).toContain('- once (function) - src/once.ts:4');
    expect(callers).toContain('- busy (function) - src/busy.ts:4, 5, 6, 7, 8, 9, 10, 11, 12, 13, +20 more');
    expect(await tool('codegraph_callers', { symbol: 'factorial' })).toContain('- factorial (function) - src/math.ts:2 — calls itself');
    expect(await tool('codegraph_callees', { symbol: 'factorial' })).toContain('- factorial (function) - src/math.ts:1 — calls itself');
  });

  it('shows callers in the trail at their sites, three at most, and the recursion once', async () => {
    const log = await tool('codegraph_node', { symbol: 'Logger.log' });
    expect(log).toMatch(/\*\*Called by ←\*\* .*build \(src\/report\.ts:9, 10\)/);
    expect(log).toContain('busy (src/busy.ts:4, 5, 6, +27 more)');
    const factorial = await tool('codegraph_node', { symbol: 'factorial' });
    expect(factorial).toMatch(/\*\*Called by ←\*\* .*factorial \(src\/math\.ts:2, calls itself\)/);
    expect(factorial).toContain('tally (src/math.ts:6)');
    expect(factorial).not.toMatch(/\*\*Calls →\*\*.*factorial/);
  });
});
