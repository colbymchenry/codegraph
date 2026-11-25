/**
 * Conditions as a reader says them: the joins we add (`&&` between guards,
 * `||` between a link's scenarios, `!(…)` around a negated guard) become
 * and / or / not, the code inside a guard stays code, and a link with several
 * call sites is several scenarios with their shared clauses said once.
 */
import { describe, it, expect } from 'vitest';
import { clauseWords, clauses, restWords, scenarios, splitTop, whenWords } from '../ui/src/lib/conditions';

describe('conditions', () => {
  it('splits at the top level only, respecting brackets and strings', () => {
    expect(splitTop('a && (b || c) && "x && y" && d', ' && ')).toEqual(['a', '(b || c)', '"x && y"', 'd']);
    expect(splitTop('a && b || c && d', ' || ')).toEqual(['a && b', 'c && d']);
    expect(clauses('!busy && isCollected')).toEqual(['!busy', 'isCollected']);
    // A merged condition has no single innermost clause: it comes back whole.
    expect(clauses('a && b || c')).toEqual(['a && b || c']);
  });

  it('says NOT for our negations and leaves the code inside alone', () => {
    expect(clauseWords('!busy')).toBe('NOT busy');
    expect(clauseWords('!user?.organization_id')).toBe('NOT user?.organization_id');
    expect(clauseWords('!(isUploadInProgress || elapsed < 5000)')).toBe('NOT (isUploadInProgress || elapsed < 5000)');
    // `!(a) || b` is not a negated whole: untouched.
    expect(clauseWords('!(a) || b')).toBe('!(a) || b');
    expect(clauseWords('(!object?.id || !object?.name)')).toBe('(!object?.id || !object?.name)');
    expect(clauseWords('selectedDetectionItems.length === 1')).toBe('selectedDetectionItems.length === 1');
  });

  it('words a whole condition: AND within a scenario, OR between scenarios', () => {
    expect(whenWords('!(busy || late) && user?.organization_id && !object?.id')).toBe(
      'NOT (busy || late) AND user?.organization_id AND NOT object?.id'
    );
    expect(whenWords('!x && y || !x && !y')).toBe('NOT x AND y OR NOT x AND NOT y');
    // The same guard met twice along a chain is said once.
    expect(whenWords('ctl && !(!ctl || done) && !(!ctl || done) && ready')).toBe('ctl AND NOT (!ctl || done) AND ready');
    expect(scenarios([{ when: 'a && a && b' }]).common).toEqual(['a', 'b']);
    expect(whenWords('')).toBe('');
  });

  it('factors the clauses every scenario shares, and keeps each row’s own tail', () => {
    const sites = [
      { line: 248, when: '!(busy || late) && !user?.organization_id' },
      { line: 257, when: '!(busy || late) && user?.organization_id && (!object?.id || !object?.name)' },
      { line: 292, when: '!(busy || late) && user?.organization_id && !(!object?.id || !object?.name) && items.length === 1' },
      { line: 306, when: '!(busy || late) && user?.organization_id && !(!object?.id || !object?.name) && !items.length' },
    ];
    const sc = scenarios(sites);
    expect(sc.common).toEqual(['!(busy || late)']);
    expect(sc.rows.map((r) => r.rest)).toEqual([
      ['!user?.organization_id'],
      ['user?.organization_id', '(!object?.id || !object?.name)'],
      ['user?.organization_id', '!(!object?.id || !object?.name)', 'items.length === 1'],
      ['user?.organization_id', '!(!object?.id || !object?.name)', '!items.length'],
    ]);
    expect(restWords(sc.rows[0]!.rest, true)).toBe('AND NOT user?.organization_id');
    expect(restWords(sc.rows[2]!.rest, true)).toBe(
      'AND user?.organization_id AND NOT (!object?.id || !object?.name) AND items.length === 1'
    );
  });

  it('one site is one scenario with nothing left to say; no shared prefix says when', () => {
    expect(scenarios([{ when: 'a && b' }])).toEqual({ common: ['a', 'b'], rows: [{ site: { when: 'a && b' }, rest: [] }] });
    const sc = scenarios([{ when: 'a' }, { when: 'b' }, { when: '' }]);
    expect(sc.common).toEqual([]);
    expect(restWords(sc.rows[0]!.rest, false)).toBe('WHEN a');
    expect(restWords(sc.rows[2]!.rest, false)).toBe('always');
    expect(scenarios([])).toEqual({ common: [], rows: [] });
  });
});
