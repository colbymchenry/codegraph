/**
 * What a saved trail's row says, without a browser (CG-60).
 *
 * The endpoint's own behaviour is pinned in `ui-trails.test.ts` against a real
 * index; this is the wording layer, and the rule it exists to protect is that
 * **a trail that has decayed never reads as intact**. A saved trail is somebody's
 * explanation of a codebase that has since moved underneath it, and a row that
 * prints "6 hops" while two of them are gone is a lie by omission at exactly the
 * moment the trail needs fixing.
 */

import { describe, it, expect } from 'vitest';
import {
  hopStatusWord,
  isOpenable,
  replacedTrail,
  trailDecay,
  trailExport,
  trailMeta,
  trailNameProblem,
  trailOpens,
  trailTitle,
} from '../ui/src/lib/trails-model';
import type { WireTrail, WireTrailHop, WireTrailHopStatus } from '../ui/src/lib/wire';

function hop(
  name: string,
  status: WireTrailHopStatus = 'ok',
  dir: WireTrailHop['dir'] = 'down'
): WireTrailHop {
  const alive = status !== 'missing';
  return {
    dir,
    name,
    qualifiedName: name,
    kind: 'function',
    savedFile: 'src/a.ts',
    savedLine: 10,
    status,
    id: alive ? `function:${name}` : null,
    file: alive ? 'src/a.ts' : null,
    line: alive ? 10 : null,
    note: status === 'ok' ? null : `${name} ${status}`,
  };
}

function trail(hops: WireTrailHop[], over: Partial<WireTrail> = {}): WireTrail {
  const resolved = hops.filter((h) => h.id !== null);
  return {
    id: 'a-walk',
    name: 'A walk',
    note: '',
    author: 'Ada',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    hops,
    resolved: resolved.length,
    intact: hops.every((h) => h.status === 'ok'),
    encoded: resolved.length > 0 ? resolved.map((h) => `d${h.id}`).join(',') : null,
    openFrom: 1,
    openCount: resolved.length,
    openId: resolved.length > 0 ? (resolved[resolved.length - 1] as WireTrailHop).id : null,
    ...over,
  };
}

describe('trailMeta', () => {
  it('reports the SAVED length, whatever became of the hops', () => {
    const decayed = trail([hop('a', 'ok', 'start'), hop('b', 'missing'), hop('c')]);
    expect(trailMeta(decayed)).toBe('3 hops · Ada');
  });

  it('drops the author when there is not one', () => {
    expect(trailMeta(trail([hop('a', 'ok', 'start')], { author: '' }))).toBe('1 hop');
  });
});

describe('trailDecay', () => {
  it('is null for a trail nothing has happened to', () => {
    expect(trailDecay(trail([hop('a', 'ok', 'start'), hop('b')]))).toBeNull();
  });

  it('warns about hops that are gone, naming them', () => {
    const decay = trailDecay(trail([hop('a', 'ok', 'start'), hop('gone', 'missing')]));
    expect(decay?.tone).toBe('warn');
    expect(decay?.text).toContain('1 hop moved or renamed');
    expect(decay?.text).toContain('gone');
  });

  it('caps how many it names', () => {
    const hops = ['a', 'b', 'c', 'd', 'e'].map((n) => hop(n, 'missing'));
    const decay = trailDecay(trail(hops));
    expect(decay?.text).toContain('and 2 more');
  });

  it('notes a move without warning about it — a moved hop still opens', () => {
    const decay = trailDecay(trail([hop('a', 'ok', 'start'), hop('b', 'moved')]));
    expect(decay?.tone).toBe('note');
    expect(decay?.text).toContain('moved to another file');
  });

  it('puts a missing hop ahead of a merely moved one', () => {
    const decay = trailDecay(trail([hop('m', 'moved'), hop('g', 'missing')]));
    expect(decay?.text).toContain('moved or renamed');
  });

  it('warns about an ambiguous hop — the trail may no longer mean what it said', () => {
    const decay = trailDecay(trail([hop('a', 'ok', 'start'), hop('b', 'ambiguous')]));
    expect(decay?.tone).toBe('warn');
    expect(decay?.text).toContain('more than one symbol');
  });
});

describe('trailOpens', () => {
  it('says nothing when the whole trail opens', () => {
    expect(trailOpens(trail([hop('a', 'ok', 'start'), hop('b')]))).toBeNull();
  });

  it('names the range when only part of it does', () => {
    const partial = trail([hop('a'), hop('b'), hop('c')], {
      openFrom: 2,
      openCount: 2,
    });
    expect(trailOpens(partial)).toBe('Opens hops 2–3 of 3.');
  });

  it('says so plainly when nothing resolves', () => {
    const dead = trail([hop('a', 'missing')], { encoded: null, openCount: 0, openId: null });
    expect(trailOpens(dead)).toContain('None of this trail resolves');
    expect(isOpenable(dead)).toBe(false);
  });
});

describe('trailTitle', () => {
  it('draws the whole walk with its arrows, and when it was saved', () => {
    const walked = trail([hop('a', 'ok', 'start'), hop('b', 'ok', 'down'), hop('c', 'ok', 'up')]);
    expect(trailTitle(walked)).toBe('a → b ← c — saved 2026-08-02');
  });
});

describe('saving', () => {
  it('refuses an empty or over-long name before the round-trip', () => {
    expect(trailNameProblem('   ', 120)).toContain('name');
    expect(trailNameProblem('x'.repeat(121), 120)).toContain('too long');
    expect(trailNameProblem('ok', 120)).toBeNull();
  });

  it('spots the trail a name would replace, whitespace and all', () => {
    const list = [trail([hop('a', 'ok', 'start')], { name: 'A walk' })];
    expect(replacedTrail('  A   walk  ', list)?.name).toBe('A walk');
    expect(replacedTrail('Another walk', list)).toBeNull();
  });
});

describe('trailExport', () => {
  it('exports the SAVED identity of each hop, not today’s resolution', () => {
    const moved = trail([hop('a', 'ok', 'start'), hop('b', 'moved')]);
    const raw = JSON.parse(trailExport(moved));
    expect(raw.version).toBe(1);
    // `savedFile`, so dropping the file into another checkout re-runs the same
    // resolution rather than baking this index's answer in.
    expect(raw.hops[1].file).toBe('src/a.ts');
    expect(raw.hops[1].qualifiedName).toBe('b');
    expect(raw.hops.map((h: { dir: string }) => h.dir)).toEqual(['start', 'down']);
  });

  it('survives a hop with no id at all', () => {
    const raw = JSON.parse(trailExport(trail([hop('gone', 'missing')])));
    expect(raw.hops[0].id).toBe('');
  });
});

describe('hopStatusWord', () => {
  it('has a word for every status', () => {
    for (const status of ['ok', 'moved', 'ambiguous', 'missing'] as const) {
      expect(hopStatusWord(status)).toBeTruthy();
    }
  });
});
