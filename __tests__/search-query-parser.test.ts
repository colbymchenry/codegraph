/**
 * Unit tests for the field-qualified query parser and bounded
 * edit distance — the two algorithms behind `kind:`/`lang:`/`path:`/
 * `name:` filtering and the fuzzy typo fallback.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { parseQuery, boundedEditDistance } from '../src/search/query-parser';

describe('parseQuery', () => {
  it('returns plain text for a query with no field prefixes', () => {
    const r = parseQuery('authenticate user');
    expect(r.text).toBe('authenticate user');
    expect(r.kinds).toEqual([]);
    expect(r.languages).toEqual([]);
    expect(r.pathFilters).toEqual([]);
    expect(r.nameFilters).toEqual([]);
  });

  it('extracts kind: filter and removes it from text', () => {
    const r = parseQuery('kind:function auth');
    expect(r.kinds).toEqual(['function']);
    expect(r.text).toBe('auth');
  });

  it('extracts lang: and language: as the same filter family', () => {
    const a = parseQuery('lang:typescript foo');
    const b = parseQuery('language:typescript foo');
    expect(a.languages).toEqual(['typescript']);
    expect(b.languages).toEqual(['typescript']);
  });

  it('handles multiple kind: filters as an OR set', () => {
    const r = parseQuery('kind:function kind:method auth');
    expect(r.kinds.sort()).toEqual(['function', 'method']);
  });

  it('extracts path: and name: as substring filters (kept verbatim)', () => {
    const r = parseQuery('path:src/api name:Handler');
    expect(r.pathFilters).toEqual(['src/api']);
    expect(r.nameFilters).toEqual(['Handler']);
  });

  it('preserves quoted spans as a single token (whitespace in path:)', () => {
    const r = parseQuery('path:"my dir/file" foo');
    expect(r.pathFilters).toEqual(['my dir/file']);
    expect(r.text).toBe('foo');
  });

  it('passes URL-like tokens through to text (does not match http: as a field)', () => {
    const r = parseQuery('http://example.com');
    expect(r.text).toBe('http://example.com');
    expect(r.kinds).toEqual([]);
  });

  it('passes empty-value tokens through as text (kind: → "kind:")', () => {
    const r = parseQuery('kind: foo');
    expect(r.kinds).toEqual([]);
    // The trailing-colon token comes back as plain text
    expect(r.text.includes('kind:')).toBe(true);
  });

  it('passes unknown field prefixes through as text (TODO: keeps the colon)', () => {
    const r = parseQuery('TODO: needs review');
    expect(r.text).toBe('TODO: needs review');
    expect(r.kinds).toEqual([]);
  });

  it('rejects unknown values for kind: (passes the whole token to text)', () => {
    const r = parseQuery('kind:invalid foo');
    // Invalid kind value falls back to text
    expect(r.kinds).toEqual([]);
    expect(r.text).toContain('kind:invalid');
  });

  it('handles all-filters-no-text query', () => {
    const r = parseQuery('kind:function lang:typescript');
    expect(r.kinds).toEqual(['function']);
    expect(r.languages).toEqual(['typescript']);
    expect(r.text).toBe('');
  });

  it('survives empty input', () => {
    const r = parseQuery('');
    expect(r.text).toBe('');
    expect(r.kinds).toEqual([]);
  });

  it('survives a very long input (no allocation explosion)', () => {
    const huge = 'foo '.repeat(5000); // 20k chars
    const r = parseQuery(huge);
    expect(r.text.length).toBeGreaterThan(0);
  });
});

describe('boundedEditDistance', () => {
  it('returns 0 for identical strings', () => {
    expect(boundedEditDistance('user', 'user', 2)).toBe(0);
  });

  it('returns 1 for a single substitution', () => {
    expect(boundedEditDistance('user', 'usar', 2)).toBe(1);
  });

  it('returns 1 for a single insertion', () => {
    expect(boundedEditDistance('user', 'users', 2)).toBe(1);
  });

  it('returns 1 for a single deletion', () => {
    expect(boundedEditDistance('users', 'user', 2)).toBe(1);
  });

  it('returns 2 for a transposition (two edits in basic Levenshtein)', () => {
    // 'aple' vs 'palp' would be 2; pick a clearer pair.
    // 'foo' vs 'fou': substitution + insertion = 2 if different lengths.
    expect(boundedEditDistance('confg', 'configX', 2)).toBe(2);
  });

  it('returns maxDist+1 when distance clearly exceeds budget', () => {
    expect(boundedEditDistance('foo', 'completely-different', 2)).toBe(3);
  });

  it('respects length-difference shortcut', () => {
    // |len(a) - len(b)| > maxDist must immediately be over budget
    expect(boundedEditDistance('a', 'aaaaaaa', 2)).toBe(3);
  });

  it('handles empty inputs', () => {
    expect(boundedEditDistance('', '', 2)).toBe(0);
    expect(boundedEditDistance('a', '', 2)).toBe(1);
    expect(boundedEditDistance('', 'abc', 2)).toBe(3);
  });

  it('is case-sensitive — caller must lowercase if case-insensitive match wanted', () => {
    expect(boundedEditDistance('Foo', 'foo', 2)).toBe(1);
  });

  it('early-exits when row min exceeds budget (correctness, not just perf)', () => {
    // 'aaaaa' vs 'bbbbb': distance is 5, well over budget 2
    expect(boundedEditDistance('aaaaa', 'bbbbb', 2)).toBe(3);
  });
});

describe('search hard filters precede candidate limits', () => {
  let root: string;
  let cg: CodeGraph;
  const names = (query: string, limit = 1) => cg.searchNodes(query, { limit, kinds: ['function'] }).map(r => r.node.name);

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-search-filter-'));
    const write = (file: string, source: string) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), source);
    };
    const filler = Array.from({ length: 120 }, (_, i) => [
      `export function authenticate${i}() { return ${i}; }`,
      `export function aaaNeedle${i}() { return ${i}; }`,
    ].join('\n'));
    // Distinct names with the same folded spelling occupy the fuzzy name cap.
    const variants = Array.from({ length: 64 }, (_, mask) => 'G' + [...'etUser'].map((c, i) =>
      mask & (1 << i) ? c.toUpperCase() : c.toLowerCase(),
    ).join(''));
    write('aaa/noise.ts', filler.join('\n') + '\nexport function authenticate() {}\n'
      + variants.map(n => `export function ${n}() {}`).join('\n'));
    write('product/handler.ts', [
      'export function authenticateUserHandler() {}',
      'export function zzNeedleHandler() {}',
      'export function zzzRareHandler() {}',
      'export function getUser() {}',
    ].join('\n'));
    write('Ünicode/handler.ts', 'export function Öffnen() {}');
    write('percent%/unit_/literal.ts', 'export function percent_name() {}');
    write('percentA/unitA/decoy.ts', 'export function percentAname() {}');
    cg = await CodeGraph.init(root, { index: true });
  });

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([1, 2, 10])('finds a selective FTS path/name hit with limit %i', limit => {
    expect(cg.getBackend()).toBe('node-sqlite');
    expect(names('authenticate path:product/', limit)).toEqual(['authenticateUserHandler']);
    expect(names('authenticate name:UserHandler', limit)).toEqual(['authenticateUserHandler']);
  });

  it('finds filter-only hits beyond the alphabetically first candidates', () => {
    expect(names('kind:function name:zzzRareHandler')).toEqual(['zzzRareHandler']);
    expect(names('kind:function path:product/', 10)).toHaveLength(4);
  });

  it('filters LIKE fallback before its limit', () => {
    expect(names('needle path:product/')).toEqual(['zzNeedleHandler']);
    expect(names('needle name:zzNeedleHandler')).toEqual(['zzNeedleHandler']);
  });

  it('filters fuzzy definitions before per-name and follow-up caps', () => {
    expect(names('getUsar path:product/')).toEqual(['getUser']);
    expect(names('getUsar name:getUser')).toHaveLength(1);
  });

  it('preserves Unicode case-insensitive literal substring matching', () => {
    expect(names('kind:function path:ünicode/ name:öffnen')).toEqual(['Öffnen']);
  });

  it('treats percent signs and underscores literally', () => {
    expect(names('kind:function path:percent%/ name:percent_')).toEqual(['percent_name']);
    expect(names('kind:function path:unit_/', 10)).toEqual(['percent_name']);
    expect(names('kind:function name:percent_', 10)).toEqual(['percent_name']);
  });

  it('ORs repeated filters within each family and ANDs the two families', () => {
    expect(names('kind:function path:product/ path:ünicode/ name:zzzRareHandler name:öffnen', 10).sort())
      .toEqual(['zzzRareHandler', 'Öffnen'].sort());
    expect(names('kind:function path:product/ name:öffnen', 10)).toEqual([]);
  });

  it('keeps exact matches first in unfiltered search and avoids supplement leakage', () => {
    expect(names('authenticate')).toEqual(['authenticate']);
    expect(names('authenticate path:product/')).toEqual(['authenticateUserHandler']);
    expect(names('authenticate path:absent/', 100)).toEqual([]);
    expect(names('authenticate name:NoSuchHandler', 100)).toEqual([]);
  });

  it('skips filtered candidates, rather than unrelated rows, for offset', () => {
    const all = cg.searchNodes('kind:function path:product/', { limit: 10 });
    const page = cg.searchNodes('kind:function path:product/', { limit: 1, offset: 1 });
    expect(page[0]!.node.id).toBe(all[1]!.node.id);
  });

  it('returns a real MCP match and success-shaped guidance only for an absent filter', async () => {
    const prior = process.env.CODEGRAPH_MCP_TOOLS;
    process.env.CODEGRAPH_MCP_TOOLS = 'search';
    const handler = new ToolHandler(cg);
    try {
      const result = await handler.execute('codegraph_search', { query: 'authenticate path:product/', limit: 1 });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result.content)).toContain('authenticateUserHandler');
      const absent = await handler.execute('codegraph_search', { query: 'authenticate path:absent/', limit: 1 });
      expect(absent.isError).not.toBe(true);
      expect(JSON.stringify(absent.content)).toContain('No results found');
    } finally {
      await handler.closeAll();
      if (prior === undefined) delete process.env.CODEGRAPH_MCP_TOOLS;
      else process.env.CODEGRAPH_MCP_TOOLS = prior;
    }
  });
});
