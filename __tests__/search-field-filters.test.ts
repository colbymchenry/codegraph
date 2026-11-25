/**
 * `path:` and `name:` are hard filters on a search (see query-parser.ts): they
 * narrow the result set, and the search ranks within it. They used to be
 * applied only after every candidate source had cut its rows to the limit, so
 * whenever more than `limit` symbols outside the filters ranked first, the
 * match the filters asked for was never shown, and only a much larger limit
 * found it (#2254).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { ToolHandler } from '../src/mcp/tools';

const KELVIN = 'Kelvin';

describe('search path: and name: filters apply before the limit (#2254)', () => {
  let root: string;
  let cg: CodeGraph;
  const names = (query: string, limit: number, offset?: number): string[] =>
    cg.searchNodes(query, { limit, offset }).map((r) => r.node.name);

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'search-field-filters-'));
    const write = (file: string, source: string): void => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), source + '\n');
    };
    // Outside product/: more symbols than any limit below, each ranked ahead
    // of product/'s by the source that finds it. FTS and LIKE rank the 120
    // `authenticate…` and `aaaNeedle…` names first, a filter-only search
    // orders by name, and the fuzzy fallback meets the 64 `getUser` spellings
    // (each as far from "getUsar" as `getUser` is) before `getUser` itself.
    const getUserSpellings = Array.from({ length: 64 }, (_, mask) =>
      'G' + [...'etUser'].map((c, i) => (mask & (1 << i) ? c.toUpperCase() : c.toLowerCase())).join(''),
    );
    write('aaa/noise.ts', [
      ...Array.from({ length: 120 }, (_, i) => `export function authenticate${i}(): number { return ${i}; }`),
      'export function authenticate(): void {}',
      ...Array.from({ length: 120 }, (_, i) => `export function aaaNeedle${i}(): number { return ${i}; }`),
      ...getUserSpellings.map((name) => `export function ${name}(): void {}`),
      // Non-ASCII names, which reach the filters' JavaScript test whatever the
      // filter says; ordered by name, they come ahead of the Kelvin sign below.
      ...Array.from({ length: 6 }, (_, i) => `export function Ärger${i}(): void {}`),
    ].join('\n'));
    write('product/handler.ts', [
      'export function authenticateUserHandler(): void {}',
      'export function zzNeedleHandler(): void {}',
      'export function zzzRareHandler(): void {}',
      'export function getUser(): void {}',
    ].join('\n'));
    // Non-ASCII case, which SQLite's lower() and LIKE do not fold. The Kelvin
    // sign (U+212A) lowercases to an ASCII "k", so `name:kelvin` matches it.
    write('Ünicode/straße.ts', 'export function Öffnen(): void {}');
    write('Ünicode/kelvin.ts', `export function ${KELVIN}(): void {}`);
    // `%` and `_` are literal in a filter: LIKE would let these decoys match.
    write('percent%/under_score/literal.ts', 'export function percent_name(): void {}');
    write('percentX/underXscore/decoy.ts', 'export function percentXname(): void {}');
    cg = await CodeGraph.init(root, { index: true });
  });

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([1, 2, 10])('finds what the filters ask for at limit %i, whichever source finds it', (limit) => {
    // Full-text search.
    expect(names('authenticate path:product/', limit)).toEqual(['authenticateUserHandler']);
    expect(names('authenticate name:userhandler', limit)).toEqual(['authenticateUserHandler']);
    // Substring search, when the full-text search finds nothing.
    expect(names('needle path:product/', limit)).toEqual(['zzNeedleHandler']);
    // The typo fallback.
    expect(names('getUsar path:product/', limit)).toEqual(['getUser']);
    // Filters alone, with no words to search for.
    expect(names('kind:function name:zzzRareHandler', limit)).toEqual(['zzzRareHandler']);
  });

  it('pages with an offset through what the filters let through', () => {
    const all = names('kind:function path:product/', 10);
    expect([...all].sort()).toEqual(['authenticateUserHandler', 'getUser', 'zzNeedleHandler', 'zzzRareHandler']);
    const pages = [0, 1, 2, 3].map((offset) => names('kind:function path:product/', 1, offset));
    expect(pages.every((page) => page.length === 1)).toBe(true);
    expect(pages.flat().sort()).toEqual([...all].sort());
    expect(names('kind:function path:product/', 1, 4)).toEqual([]);
    // A search by kind alone pages too; before, every offset gave the first page.
    expect(names('kind:function', 1, 1)).not.toEqual(names('kind:function', 1, 0));
  });

  it('matches non-ASCII case-insensitively and takes % and _ literally', () => {
    expect(names('kind:function path:ünicode/ name:öffnen', 10)).toEqual(['Öffnen']);
    expect(names('kind:function name:kelvin', 1)).toEqual([KELVIN]);
    expect(names('kind:function path:percent%/', 10)).toEqual(['percent_name']);
    expect(names('kind:function path:under_score/', 10)).toEqual(['percent_name']);
    expect(names('kind:function name:percent_', 10)).toEqual(['percent_name']);
  });

  it('ORs the values of one filter and ANDs path: with name:', () => {
    expect(names('kind:function path:product/ path:ünicode/ name:zzzrare name:öffnen', 10).sort())
      .toEqual(['zzzRareHandler', 'Öffnen'].sort());
    expect(names('kind:function path:product/ name:öffnen', 10)).toEqual([]);
  });

  it('returns nothing when nothing passes the filters, at any limit', () => {
    // Filters no symbol passes at all.
    expect(names('authenticate path:absent/', 100)).toEqual([]);
    expect(names('authenticate name:nosuchhandler', 100)).toEqual([]);
    expect(names('kind:function path:absent/', 100)).toEqual([]);
    // Filters some symbols pass, though none the words find: every source runs.
    expect(names('authenticate path:ünicode/', 100)).toEqual([]);
    expect(names('authenticate name:öffnen', 100)).toEqual([]);
    expect(names('needle path:percent%/', 100)).toEqual([]);
    expect(names('getUsar path:percent%/', 100)).toEqual([]);
  });

  it('leaves a search without these filters as it was', () => {
    expect(names('authenticate', 3)).toEqual(['authenticate', 'authenticate0', 'authenticate1']);
  });

  it('codegraph_search shows the match at limit 1 instead of "No results found"', async () => {
    const handler = new ToolHandler(cg);
    try {
      const found = await handler.execute('codegraph_search', { query: 'authenticate path:product/', limit: 1 });
      expect(found.isError).not.toBe(true);
      expect(JSON.stringify(found.content)).toContain('authenticateUserHandler');
      const absent = await handler.execute('codegraph_search', { query: 'authenticate path:absent/', limit: 1 });
      expect(absent.isError).not.toBe(true);
      expect(JSON.stringify(absent.content)).toContain('No results found');
    } finally {
      await handler.closeAll();
    }
  });
});
