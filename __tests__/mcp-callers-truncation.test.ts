/**
 * The MCP `codegraph_callers` / `codegraph_callees` answers say when their
 * `limit` cut the list (#1639, #1674). A capped list with no marker reads as
 * the complete set, and an agent under-counts "who calls this" from it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

let tmpDir: string;
let cg: CodeGraph;
let handler: ToolHandler;

const text = async (tool: string, args: Record<string, unknown>): Promise<string> => {
  const res = await handler.execute(tool, args);
  return res.content?.[0]?.text ?? '';
};

const CALLERS = 25;

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1674-'));
  fs.mkdirSync(path.join(tmpDir, 'src'));
  // `warm` lives in a file of another name: one definition, the flat list.
  fs.writeFileSync(path.join(tmpDir, 'src', 'target.ts'), 'export function warm(n: number): number { return n; }\n');
  fs.writeFileSync(
    path.join(tmpDir, 'src', 'callers.ts'),
    "import { warm } from './target';\n" +
      Array.from({ length: CALLERS }, (_, i) => `export function caller${i}(): number { return warm(${i}); }`).join('\n') +
      '\n'
  );
  // `hot` shares its name with its file, so the answer groups per definition.
  fs.writeFileSync(path.join(tmpDir, 'src', 'hot.ts'), 'export function hot(n: number): number { return n; }\n');
  fs.writeFileSync(
    path.join(tmpDir, 'src', 'hot-callers.ts'),
    "import { hot } from './hot';\n" +
      Array.from({ length: CALLERS }, (_, i) => `export function hotCaller${i}(): number { return hot(${i}); }`).join('\n') +
      '\n'
  );
  fs.writeFileSync(
    path.join(tmpDir, 'src', 'fan.ts'),
    Array.from({ length: CALLERS }, (_, i) => `export function helper${i}(): number { return ${i}; }`).join('\n') +
      `\nexport function fanout(): number { return ${Array.from({ length: CALLERS }, (_, i) => `helper${i}()`).join(' + ')}; }\n`
  );
  cg = CodeGraph.initSync(tmpDir);
  await cg.indexAll();
  handler = new ToolHandler(cg);
});

afterAll(() => {
  cg.destroy();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('codegraph_callers truncation', () => {
  it('says how many callers the default limit hid', async () => {
    const out = await text('codegraph_callers', { symbol: 'warm' });
    // The importing file counts as a caller too, so the total is at least CALLERS.
    const m = out.match(/Showing 20 of (\d+) callers; pass `limit`/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(CALLERS);
    expect(out.match(/^- caller\d+ /gm)?.length).toBe(20);
  });

  it('is silent when the list is complete', async () => {
    const out = await text('codegraph_callers', { symbol: 'warm', limit: 100 });
    expect(out).not.toContain('Showing');
    expect(out.match(/^- caller\d+ /gm)?.length).toBe(CALLERS);
  });

  it('marks the cut inside each per-definition section too', async () => {
    const out = await text('codegraph_callers', { symbol: 'hot' });
    expect(out).toContain('distinct definitions');
    expect(out).toMatch(/- … \+\d+ more \(pass `limit` to widen\)/);
    expect(await text('codegraph_callers', { symbol: 'hot', limit: 100 })).not.toContain('more (pass');
  });
});

describe('codegraph_callees truncation', () => {
  it('says how many callees the default limit hid', async () => {
    const out = await text('codegraph_callees', { symbol: 'fanout' });
    const m = out.match(/Showing 20 of (\d+) callees; pass `limit`/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(CALLERS);
  });

  it('is silent when the list is complete', async () => {
    const out = await text('codegraph_callees', { symbol: 'fanout', limit: 100 });
    expect(out).not.toContain('Showing');
  });
});
