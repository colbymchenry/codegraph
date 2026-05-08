/**
 * Unit tests for the field-qualified query parser and bounded
 * edit distance — the two algorithms behind `kind:`/`lang:`/`path:`/
 * `name:` filtering and the fuzzy typo fallback.
 */

import { describe, it, expect } from 'vitest';
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
