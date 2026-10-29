/**
 * #2909: a caller that calls a symbol more than once is still one row, and the
 * row carries every call site. A function that calls itself is a caller too.
 * The issue's repro (Logger/Report) has two sites in `build`; the recursion is
 * written through `this` because a call on a `for…of` element (`child.walk()`)
 * is a separate receiver-type gap, not part of this traversal fix.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

let projectRoot: string;
let cg: CodeGraph;

function runCli(args: string[]): string {
  const result = spawnSync(process.execPath, [BIN, ...args, '-p', projectRoot], {
    encoding: 'utf-8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', NO_COLOR: '1' },
    timeout: 30_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

function json(args: string[]): any {
  return JSON.parse(runCli([...args, '--json']));
}

function nodeId(name: string): string {
  const node = cg.getNodesByName(name).find((n) => n.filePath === 'src/report.ts');
  expect(node, name).toBeDefined();
  return node!.id;
}

beforeAll(async () => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-2909-'));
  fs.mkdirSync(path.join(projectRoot, 'src'));
  fs.writeFileSync(path.join(projectRoot, 'src', 'report.ts'), [
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
  ].join('\n'));
  // A single-site caller: its row must look exactly as it did before #2909.
  fs.writeFileSync(path.join(projectRoot, 'src', 'once.ts'), [
    "import { Logger } from './report';",
    '',
    'export function once(logger: Logger): void {',
    "  logger.log('only');",
    '}',
    '',
  ].join('\n'));

  cg = CodeGraph.initSync(projectRoot);
  await cg.indexAll();
}, 30_000);

afterAll(() => {
  cg?.close();
  if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe('getCallers / getCallees call sites (#2909)', () => {
  it('keeps one row per caller and carries every call site', () => {
    const rows = cg.getCallers(nodeId('log'));
    const build = rows.filter((row) => row.node.name === 'build');
    expect(build).toHaveLength(1);
    expect(build[0]!.edges.map((edge) => edge.line)).toEqual([9, 10]);
    // Single-edge consumers still get the first site.
    expect(build[0]!.edge.line).toBe(9);
  });

  it('lists a recursive call as a row of the symbol itself', () => {
    const walkId = nodeId('walk');
    const rows = cg.getCallers(walkId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.node.id).toBe(walkId);
    expect(rows[0]!.edges).toEqual([
      expect.objectContaining({ source: walkId, target: walkId, kind: 'calls', line: 18 }),
    ]);
  });

  it('leaves a single-site caller exactly as before', () => {
    const once = cg.getCallers(nodeId('log')).filter((row) => row.node.name === 'once');
    expect(once).toHaveLength(1);
    expect(once[0]!.edges.map((edge) => edge.line)).toEqual([4]);
  });

  it('carries every call site and the recursive call for callees too', () => {
    const build = cg.getCallees(nodeId('build')).filter((row) => row.node.name === 'log');
    expect(build).toHaveLength(1);
    expect(build[0]!.edges.map((edge) => edge.line)).toEqual([9, 10]);

    const walkId = nodeId('walk');
    const recursive = cg.getCallees(walkId);
    expect(recursive).toHaveLength(1);
    expect(recursive[0]!.node.id).toBe(walkId);
    expect(recursive[0]!.edges[0]).toMatchObject({ source: walkId, target: walkId, line: 18 });
  });
});

describe('CLI callers output (#2909)', () => {
  it('emits every call site inside the caller row in JSON', () => {
    const out = json(['callers', 'Logger.log']);
    const rows = out.definitions[0].callers;
    expect(rows.filter((row: any) => row.name === 'build')).toHaveLength(1);
    expect(rows.find((row: any) => row.name === 'build').edges.map((edge: any) => edge.line)).toEqual([9, 10]);
    expect(out.definitions[0].edges.map((edge: any) => edge.line)).toEqual([4, 9, 10]);
    expect(out.callers.find((row: any) => row.name === 'build').edges.map((edge: any) => edge.line)).toEqual([9, 10]);
  });

  it('renders all call sites on the caller row in text', () => {
    const text = runCli(['callers', 'Logger.log']);
    expect(text).toMatch(/method\s+build\n\s+src\/report\.ts:9,10/);
    // One row for the caller, not one per call site.
    expect(text.match(/\bbuild\b/g)).toHaveLength(1);
  });

  it('lists and flags a recursive caller in JSON and text', () => {
    const out = json(['callers', 'TreeNode.walk']);
    expect(out.callers).toHaveLength(1);
    expect(out.callers[0].name).toBe('walk');
    expect(out.callers[0].edges[0]).toMatchObject({ line: 18 });
    expect(out.callers[0].edges[0].source).toBe(out.callers[0].edges[0].target);

    const text = runCli(['callers', 'TreeNode.walk']);
    expect(text).toContain('walk (recursive)');
    expect(text).toContain('src/report.ts:18');
  });
});
