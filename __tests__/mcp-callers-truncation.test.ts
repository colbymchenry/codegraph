/**
 * The MCP `codegraph_callers` / `codegraph_callees` answers say when their
 * `limit` cut the list (#1639, #1674). A capped list with no marker reads as
 * the complete set, and an agent under-counts "who calls this" from it.
 * `offset` pages past the limit.
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
  // Two real `hot` functions exercise per-definition truncation. A filename
  // is not an overload of its exact-named function (#1809).
  fs.writeFileSync(path.join(tmpDir, 'src', 'hot.ts'), 'export function hot(n: number): number { return n; }\n');
  fs.writeFileSync(
    path.join(tmpDir, 'src', 'hot-callers.ts'),
    "import { hot } from './hot';\n" +
      Array.from({ length: CALLERS }, (_, i) => `export function hotCaller${i}(): number { return hot(${i}); }`).join('\n') +
      '\n'
  );
  fs.writeFileSync(path.join(tmpDir, 'src', 'other-hot.ts'), 'export function hot(n: number): number { return n + 1; }\n');
  fs.writeFileSync(path.join(tmpDir, 'src', 'other-hot-callers.ts'),
    "import { hot } from './other-hot';\n" +
    Array.from({ length: CALLERS }, (_, i) => `export function otherHotCaller${i}(): number { return hot(${i}); }`).join('\n') + '\n');
  fs.writeFileSync(
    path.join(tmpDir, 'src', 'fan.ts'),
    Array.from({ length: CALLERS }, (_, i) => `export function helper${i}(): number { return ${i}; }`).join('\n') +
      `\nexport function fanout(): number { return ${Array.from({ length: CALLERS }, (_, i) => `helper${i}()`).join(' + ')}; }\n`
  );
  // Two real `spread` functions exercise per-definition callee paging.
  for (const [file, prefix] of [['spread.ts', 'spreadHelper'], ['other-spread.ts', 'otherSpreadHelper']] as const) {
    fs.writeFileSync(
      path.join(tmpDir, 'src', file),
      Array.from({ length: CALLERS }, (_, i) => `export function ${prefix}${i}(): number { return ${i}; }`).join('\n') +
        `\nexport function spread(): number { return ${Array.from({ length: CALLERS }, (_, i) => `${prefix}${i}()`).join(' + ')}; }\n`
    );
  }
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
    expect(out).toContain('2 distinct definitions');
    expect(out.match(/- … \+\d+ more \(pass `limit` to widen, or `offset: 20` for the next page\)/g)).toHaveLength(2);
    expect(await text('codegraph_callers', { symbol: 'hot', limit: 100 })).not.toContain('more (pass');
  });
});

const names = (out: string) => out.match(/^- caller\d+ /gm) ?? [];

/** The entry rows of each per-definition section, keyed by its heading. */
const sections = (out: string, row: RegExp): Map<string, string[]> => {
  const map = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of out.split('\n')) {
    if (line.startsWith('**') && !line.includes('distinct definitions')) map.set(line, (current = []));
    else if (current && row.test(line)) current.push(line);
  }
  return map;
};

describe('codegraph_callers paging', () => {
  it('says which offset shows the next page', async () => {
    const out = await text('codegraph_callers', { symbol: 'warm' });
    expect(out).toMatch(/pass `limit` \(up to 100\) to widen, or `offset: 20` for the next page/);
  });

  it('lists the rest from the offset, without repeating the first page', async () => {
    const first = names(await text('codegraph_callers', { symbol: 'warm' }));
    const out = await text('codegraph_callers', { symbol: 'warm', offset: 20 });
    const second = names(out);
    expect(second.length).toBeGreaterThan(0);
    expect(second.filter((n) => first.includes(n))).toEqual([]);
    expect(new Set([...first, ...second]).size).toBe(CALLERS);
    const m = out.match(/Showing callers 21-(\d+) of (\d+)\./);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(m![2]);
  });

  it('pages a long list in steps of limit', async () => {
    const all = names(await text('codegraph_callers', { symbol: 'warm', limit: 100 }));
    const out = await text('codegraph_callers', { symbol: 'warm', offset: 5, limit: 5 });
    expect(names(out)).toEqual(all.slice(5, 10));
    expect(out).toMatch(/Showing callers 6-10 of \d+; pass `offset: 10` for the next page\./);
  });

  it('says so when the offset is past the end', async () => {
    const out = await text('codegraph_callers', { symbol: 'warm', offset: 1000 });
    expect(names(out)).toEqual([]);
    expect(out).toMatch(/No callers at offset 1000; there are \d+\./);
  });

  it('pages each per-definition section', async () => {
    const row = /^- (other)?[hH]otCaller\d+ /;
    const all = sections(await text('codegraph_callers', { symbol: 'hot', limit: 100 }), row);
    const out = await text('codegraph_callers', { symbol: 'hot', offset: 20 });
    expect(out.match(/^- \(21-\d+ of \d+\)$/gm)).toHaveLength(2);
    const paged = sections(out, row);
    expect([...paged.keys()]).toEqual([...all.keys()]);
    for (const [heading, rows] of all) expect(paged.get(heading)).toEqual(rows.slice(20));
  });

  it('floors a fractional limit', async () => {
    const out = await text('codegraph_callers', { symbol: 'warm', offset: 10, limit: 2.5 });
    expect(names(out)).toHaveLength(2);
    expect(out).toMatch(/Showing callers 11-12 of \d+; pass `offset: 12` for the next page\./);
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

  it('lists the rest from the offset', async () => {
    const all = (await text('codegraph_callees', { symbol: 'fanout', limit: 100 })).match(/^- helper\d+ /gm) ?? [];
    expect(new Set(all).size).toBe(CALLERS);
    const out = await text('codegraph_callees', { symbol: 'fanout', offset: 20 });
    expect(out.match(/^- helper\d+ /gm)).toEqual(all.slice(20));
    expect(out).toContain(`Showing callees 21-${CALLERS} of ${CALLERS}.`);
  });

  it('pages each per-definition section', async () => {
    const row = /^- (other)?[sS]preadHelper\d+ /;
    const all = sections(await text('codegraph_callees', { symbol: 'spread', limit: 100 }), row);
    expect(all.size).toBe(2);
    const out = await text('codegraph_callees', { symbol: 'spread', offset: 20 });
    expect(out.match(/^- \(21-25 of 25\)$/gm)).toHaveLength(2);
    const paged = sections(out, row);
    for (const [heading, rows] of all) {
      expect(rows).toHaveLength(CALLERS);
      expect(paged.get(heading)).toEqual(rows.slice(20));
    }
  });
});
