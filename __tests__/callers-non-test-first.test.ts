/**
 * `codegraph callers` and codegraph_callers list callers outside tests before
 * tests. Callers come back in id order, so for a symbol called mostly from
 * tests the default limit of 20 could show only tests while the one caller
 * that runs in production sat past the cut. An agent then read the page as
 * the answer and said nothing outside tests calls the symbol.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { nonTestFirst } from '../src/graph/call-sites';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
const TESTS = 40;

let root = '';
let cg: CodeGraph;
let handler: ToolHandler;

const files: Record<string, string> = {
  'src/stock.ts': 'export function refreshStock(): number {\n  return 1;\n}\n',
  'src/jobs.ts': "import { refreshStock } from './stock';\n\nexport function nightlyJob(): void {\n  refreshStock();\n}\n",
  'tests/stock.test.ts':
    "import { refreshStock } from '../src/stock';\n\n" +
    Array.from({ length: TESTS }, (_, i) => `export function testRefresh${i}(): boolean {\n  return refreshStock() === 1;\n}\n`).join('\n'),
};

const isTestRow = (row: string) => row.includes('tests/stock.test.ts');

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-callers-non-test-first-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  cg = CodeGraph.initSync(root);
  await cg.indexAll();
  handler = new ToolHandler(cg);
});

afterAll(() => {
  cg?.destroy();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('callers outside tests come first', () => {
  it('needs the reordering: in id order the production caller is past the default limit', () => {
    const target = cg.searchNodes('refreshStock', { limit: 5 }).find((m) => m.node.name === 'refreshStock' && m.node.kind === 'function')!.node;
    const names = cg.getCallSites(target.id, 'callers').map((row) => row.node.name);
    expect(names.length).toBeGreaterThan(TESTS);
    expect(names.indexOf('nightlyJob')).toBeGreaterThanOrEqual(20);
  });

  it('codegraph_callers shows the production caller within the default limit, before every test', async () => {
    const out = (await handler.execute('codegraph_callers', { symbol: 'refreshStock' })).content?.[0]?.text ?? '';
    const rows = out.split('\n').filter((line) => line.startsWith('- '));
    expect(rows).toHaveLength(20);
    expect(out).toMatch(/Showing 20 of \d+ callers/);
    const firstTest = rows.findIndex(isTestRow);
    const job = rows.findIndex((row) => row.startsWith('- nightlyJob '));
    expect(job).toBeGreaterThanOrEqual(0);
    expect(job).toBeLessThan(firstTest);
    expect(rows.slice(firstTest).every(isTestRow)).toBe(true);
  });

  it('`codegraph callers` does the same, in text and JSON', () => {
    const json = spawnSync(process.execPath, [BIN, 'callers', 'refreshStock', '--json', '-p', root], { encoding: 'utf-8' });
    expect(json.status).toBe(0);
    const parsed = JSON.parse(json.stdout) as { callers: { name: string; filePath: string }[]; truncated: boolean };
    expect(parsed.truncated).toBe(true);
    const paths = parsed.callers.map((c) => c.filePath);
    expect(parsed.callers.map((c) => c.name)).toContain('nightlyJob');
    expect(paths.findIndex((p) => p.startsWith('tests/'))).toBe(paths.filter((p) => !p.startsWith('tests/')).length);

    const text = spawnSync(process.execPath, [BIN, 'callers', 'refreshStock', '-p', root], { encoding: 'utf-8', env: { ...process.env, NO_COLOR: '1' } });
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('nightlyJob');
  });

  it('keeps each half in its own order', () => {
    expect(nonTestFirst([1, 2, 3, 4, 5, 6], (n) => n % 2 === 0)).toEqual([1, 3, 5, 2, 4, 6]);
    expect(nonTestFirst([], () => true)).toEqual([]);
  });
});
