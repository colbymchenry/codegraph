/**
 * Where the hotspot report's complexity numbers come from.
 *
 * The per-language node-type tables in `graph/hotspots.ts` are the one place in
 * this feature that depends on grammar spellings, and a wrong name fails
 * SILENTLY — it just counts fewer decisions. So every language is pinned here
 * against a fixture with a hand-counted number of decisions, and the counts are
 * the acceptance gate for those tables.
 *
 * What "a decision" means: one `if`/`elif`/`guard`, one `case`/`match` arm, one
 * `catch`, one loop, one ternary, and one logical `&&`/`||`/`and`/`or`/`??`. A
 * `switch` itself is not a decision — its arms are.
 */

import { describe, it, expect } from 'vitest';
import { decisionSites, scoreHotspot, rankHotspots, HOTSPOT_WEIGHTS, type HotspotRow } from '../src/graph/hotspots';
import { getParser, loadGrammarsForLanguages } from '../src/extraction/grammars';
async function parse(source: string, language: Language) {
  await loadGrammarsForLanguages([language]);
  return getParser(language)?.parse(source) ?? null;
}
import type { Language, Node } from '../src/types';

/** Each fixture's decisions are counted in the comment beside it. */
const FIXTURES: Array<{ language: Language; decisions: number; source: string }> = [
  {
    // if+&& (2), if+|| (2), case+default (2), catch (1), ternary (1)
    language: 'typescript',
    decisions: 8,
    source: `function f(a: number, b: boolean): number {
  if (a > 0 && b) return 1;
  if (a < 0 || b) return 2;
  switch (a) { case 1: return 3; default: return 4; }
  try { return 5; } catch { return 6; }
  return a === 1 ? 7 : 8;
}`,
  },
  {
    // if+and (2), elif+or (2), for (1), while (1), except (1), ternary (1)
    language: 'python',
    decisions: 8,
    source: `def f(a, b):
    if a and b:
        return 1
    elif a or b:
        return 2
    for x in a:
        pass
    while b:
        break
    try:
        pass
    except ValueError:
        pass
    return 1 if a else 2
`,
  },
  {
    // if+&& (2), case+default (2), catch (1), ternary (1)
    language: 'java',
    decisions: 6,
    source: `class A {
  int f(int a, boolean b) {
    if (a > 0 && b) return 1;
    switch (a) { case 1: return 2; default: return 3; }
    try { return 4; } catch (Exception e) { return 5; }
    return a > 0 ? 6 : 7;
  }
}`,
  },
  {
    // if+&& (2), case+default (2), catch (1), ternary (1)
    language: 'csharp',
    decisions: 6,
    source: `class A {
  int F(int a, bool b) {
    if (a > 0 && b) return 1;
    switch (a) { case 1: return 2; default: return 3; }
    try { return 4; } catch (Exception e) { return 5; }
    return a > 0 ? 6 : 7;
  }
}`,
  },
  {
    // if+&& (2), case+default (2), for (1)
    language: 'go',
    decisions: 5,
    source: `package main

func f(a int, b bool) int {
	if a > 0 && b {
		return 1
	}
	switch a {
	case 1:
		return 2
	default:
		return 3
	}
	for i := 0; i < 3; i++ {
		_ = i
	}
	return 0
}`,
  },
  {
    // if+&& (2), match arms (2), for (1), while (1), if (1)
    language: 'rust',
    decisions: 7,
    source: `fn f(a: i32, b: bool) -> i32 {
    if a > 0 && b { return 1; }
    match a { 1 => 2, _ => 3 }
    for _i in 0..3 { }
    while b { }
    if a > 0 { 1 } else { 2 }
}`,
  },
  {
    // if+&& (2), guard (1), case+default (2), for (1), ternary (1)
    language: 'swift',
    decisions: 7,
    source: `func f(a: Int, b: Bool) -> Int {
    if a > 0 && b { return 1 }
    guard b else { return 2 }
    switch a { case 1: return 3; default: return 4 }
    for _ in 0..<3 { }
    return a > 0 ? 7 : 8
}`,
  },
  {
    // if+&& (2), when entries (2), for (1), catch (1), if expression (1)
    language: 'kotlin',
    decisions: 7,
    source: `fun f(a: Int, b: Boolean): Int {
    if (a > 0 && b) return 1
    when (a) { 1 -> return 2; else -> return 3 }
    for (i in 0..3) { }
    try { return 4 } catch (e: Exception) { return 5 }
    return if (a > 0) 6 else 7
}`,
  },
];

describe('decision counting, pinned per language', () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.language}: ${fixture.decisions} decisions`, async () => {
      const tree = await parse(fixture.source, fixture.language);
      expect(tree, `${fixture.language} failed to parse`).not.toBeNull();
      try {
        const sites = decisionSites(tree!.rootNode, fixture.language);
        expect(sites).toHaveLength(fixture.decisions);
        // Every reported line must be a real line of the source.
        const lines = fixture.source.split('\n').length;
        for (const site of sites) {
          expect(site.line).toBeGreaterThanOrEqual(1);
          expect(site.line).toBeLessThanOrEqual(lines);
        }
      } finally {
        tree!.delete();
      }
    });
  }

  it('does not count a comparison or an arithmetic operator as a decision', async () => {
    const source = 'function g(a: number): number { return a > 1 ? a * 2 + a / 3 : 0; }\n';
    const tree = await parse(source, 'typescript');
    try {
      // One ternary, and nothing else: `>`, `*`, `+`, `/` are not decisions.
      expect(decisionSites(tree!.rootNode, 'typescript')).toHaveLength(1);
    } finally {
      tree!.delete();
    }
  });
});

function fakeNode(id: string, filePath: string, startLine: number): Node {
  return { id, filePath, startLine } as unknown as Node;
}

function row(overrides: Partial<HotspotRow> & { node: Node }): HotspotRow {
  return {
    complexity: 1,
    callerCount: 0,
    changed: false,
    hasTests: false,
    testFiles: [],
    score: 0,
    ...overrides,
  };
}

describe('hotspot scoring', () => {
  it('multiplies complexity by fan-in', () => {
    expect(scoreHotspot({ complexity: 10, callerCount: 3, changed: false, hasTests: false })).toBe(40);
  });

  it('raises the score for a changed symbol and lowers it for a tested one', () => {
    const base = scoreHotspot({ complexity: 10, callerCount: 0, changed: false, hasTests: false });
    const changed = scoreHotspot({ complexity: 10, callerCount: 0, changed: true, hasTests: false });
    const tested = scoreHotspot({ complexity: 10, callerCount: 0, changed: false, hasTests: true });
    expect(changed).toBe(base * HOTSPOT_WEIGHTS.changed);
    expect(tested).toBe(base * HOTSPOT_WEIGHTS.tested);
    expect(changed).toBeGreaterThan(base);
    expect(tested).toBeLessThan(base);
  });

  it('ranks by score and breaks ties deterministically', () => {
    const rows = [
      row({ node: fakeNode('b', 'src/z.ts', 5), score: 10 }),
      row({ node: fakeNode('a', 'src/a.ts', 9), score: 10 }),
      row({ node: fakeNode('c', 'src/a.ts', 2), score: 10 }),
      row({ node: fakeNode('d', 'src/a.ts', 2), score: 99 }),
    ];
    expect(rankHotspots(rows, 10).map((r) => r.node.id)).toEqual(['d', 'c', 'a', 'b']);
    // Same input in a different order gives the same ranking.
    expect(rankHotspots([...rows].reverse(), 10).map((r) => r.node.id)).toEqual(['d', 'c', 'a', 'b']);
  });

  it('caps the list and keeps the highest scores', () => {
    const rows = Array.from({ length: 5 }, (_, i) => row({ node: fakeNode(`n${i}`, 'src/a.ts', i), score: i }));
    expect(rankHotspots(rows, 2).map((r) => r.node.id)).toEqual(['n4', 'n3']);
  });
});
