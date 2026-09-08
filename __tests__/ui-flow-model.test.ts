/**
 * The Flow strip's geometry (CG-50) — `ui/src/lib/flow-model.ts`.
 *
 * Pure functions, no browser: this is where the strip's two load-bearing claims
 * are checked. That a card's height is ARITHMETIC (the CSS pins the same
 * number, so an arrow lands where the layout said it would), and that a column
 * is a card's LONGEST distance from a start (so two routes that rejoin do so in
 * the same column, and nothing is ever drawn left of something that calls it).
 *
 * The endpoint that feeds it is tested against a real index in
 * `ui-flow-api.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  buildFlowLayout,
  cardHeight,
  dashFor,
  labelLinesFor,
  lineLabelFor,
  CARD_WIDTH,
  CODE_LINE_HEIGHT,
  CODE_PADDING,
  COLUMN_PITCH,
  HEADER_HEIGHT,
  LABEL_MAX_CHARS,
  LINK_WIDTH,
  NO_SOURCE_HEIGHT,
  PADDING,
  ROW_GAP,
  capId,
  endCapHeight,
  endCapText,
  END_CAP_DASH,
  END_CAP_WIDTH,
} from '../ui/src/lib/flow-model';
import type {
  WireFlow,
  WireFlowBoundary,
  WireFlowEdge,
  WireFlowHop,
  WireNodeRef,
} from '../ui/src/lib/api';

/* ------------------------------------------------------------- builders -- */

function edge(over: Partial<WireFlowEdge> = {}): WireFlowEdge {
  return {
    kind: 'calls',
    label: 'calls',
    upward: false,
    uncertain: false,
    synthesized: false,
    ...over,
  };
}

function hop(name: string, opts: { lines?: number; edge?: WireFlowEdge | null } = {}): WireFlowHop {
  const lines = opts.lines ?? 7;
  return {
    node: {
      id: `method:${name}`,
      kind: 'method',
      name,
      qualifiedName: name,
      file: `src/${name}.ts`,
      line: 10,
      endLine: 40,
      language: 'typescript',
      test: false,
    },
    edge: opts.edge === undefined ? edge() : opts.edge,
    callRef: null,
    source:
      lines === 0
        ? null
        : {
            file: `src/${name}.ts`,
            language: 'typescript',
            from: 7,
            to: 6 + lines,
            lines: Array.from({ length: lines }, (_, i) => `line ${i}`),
            drift: false,
          },
  };
}

function flow(
  id: string,
  names: string[],
  extra: { boundary?: WireFlowBoundary | null; partial?: boolean } = {}
): WireFlow {
  return {
    id,
    label: `${names[0]} → ${names[names.length - 1]}`,
    hops: names.map((name, i) => hop(name, { edge: i === 0 ? null : edge() })),
    boundary: extra.boundary ?? null,
    partial: extra.partial === true,
  };
}

function ref(name: string): WireNodeRef {
  return {
    id: `method:${name}`,
    kind: 'method',
    name,
    qualifiedName: name,
    file: `src/${name}.ts`,
    line: 10,
    endLine: 40,
    language: 'typescript',
    test: false,
  };
}

function boundary(over: Partial<WireFlowBoundary> = {}): WireFlowBoundary {
  return {
    node: ref('routeAny'),
    sites: [
      {
        form: 'computed-call',
        label: 'computed member call',
        snippet: "return table[name](payload);",
        line: 61,
        key: 'save',
        keyIsType: false,
        moreSites: 0,
        candidates: [{ node: ref('onSave'), display: 'onSave', named: true }],
        candidateNote: null,
      },
    ],
    uncertain: { total: 0, shown: 0, truncated: false, items: [] },
    further: { total: 0, shown: 0, truncated: false, items: [] },
    missed: [ref('onSave')],
    ...over,
  };
}

/* ---------------------------------------------------------------- tests -- */

describe('cardHeight', () => {
  it('is the header plus one row per source line', () => {
    expect(cardHeight(hop('a', { lines: 7 }))).toBe(HEADER_HEIGHT + 7 * CODE_LINE_HEIGHT + CODE_PADDING);
    expect(cardHeight(hop('a', { lines: 1 }))).toBe(HEADER_HEIGHT + CODE_LINE_HEIGHT + CODE_PADDING);
  });

  it('gives a card with no source the height of the sentence that replaces it', () => {
    expect(cardHeight(hop('a', { lines: 0 }))).toBe(HEADER_HEIGHT + NO_SOURCE_HEIGHT);
  });
});

describe('dashFor', () => {
  it('marks a synthesized hop `5 3` and an uncertain one `2 3`', () => {
    expect(dashFor(edge({ synthesized: true }))).toBe('5 3');
    expect(dashFor(edge({ uncertain: true }))).toBe('2 3');
    expect(dashFor(edge())).toBeNull();
  });

  it('lets the synthesized pattern win, because it is the stronger claim', () => {
    // A dynamic-dispatch bridge that also scored low confidence is still first
    // and foremost a bridge: "we inferred this hop" is what a reader has to see.
    expect(dashFor(edge({ synthesized: true, uncertain: true }))).toBe('5 3');
  });
});

describe('labelLinesFor', () => {
  it('leaves an ordinary call as one word', () => {
    expect(labelLinesFor(edge())).toEqual(['calls']);
  });

  it('stacks a synthesized label and shortens the wiring site to a basename', () => {
    expect(
      labelLinesFor(
        edge({ synthesized: true, label: 'via callback · registered at src/deep/nested/wire.ts:88' })
      )
    ).toEqual(['via callback', 'registered at wire.ts:88']);
  });

  it('cuts anything still too wide for an 86px connector', () => {
    const lines = labelLinesFor(edge({ label: 'via an extraordinarily long mechanism name' }));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.length).toBe(LABEL_MAX_CHARS);
    expect(lines[0]!.endsWith('…')).toBe(true);
  });
});

describe('lineLabelFor', () => {
  it('prints the recorded line, and nothing when there is none', () => {
    expect(lineLabelFor(edge({ line: 2029 }))).toBe('line 2029');
    expect(lineLabelFor(edge())).toBeNull();
    expect(lineLabelFor(edge({ line: 0 }))).toBeNull();
  });
});

describe('buildFlowLayout — one path', () => {
  const single = flow('f1', ['a', 'b', 'c']);

  it('puts one card per column, left to right, at the spec pitch', () => {
    const layout = buildFlowLayout([single], 'f1');
    expect(layout.cards.map((c) => c.hop.node.name)).toEqual(['a', 'b', 'c']);
    expect(layout.cards.map((c) => c.column)).toEqual([0, 1, 2]);
    expect(layout.cards.map((c) => c.x)).toEqual([PADDING, PADDING + COLUMN_PITCH, PADDING + 2 * COLUMN_PITCH]);
    expect(COLUMN_PITCH).toBe(CARD_WIDTH + LINK_WIDTH);
  });

  it('places every card on one row and numbers its step on the active flow', () => {
    const layout = buildFlowLayout([single], 'f1');
    expect(new Set(layout.cards.map((c) => c.y)).size).toBe(1);
    expect(layout.cards.map((c) => c.step)).toEqual([0, 1, 2]);
  });

  it('links consecutive cards and nothing else', () => {
    const layout = buildFlowLayout([single], 'f1');
    expect(layout.links.map((l) => [l.source, l.target])).toEqual([
      ['method:a', 'method:b'],
      ['method:b', 'method:c'],
    ]);
  });

  it('sizes the canvas to the cards it drew', () => {
    const layout = buildFlowLayout([single], 'f1');
    expect(layout.columns).toBe(3);
    expect(layout.gaps).toEqual([LINK_WIDTH, LINK_WIDTH]);
    expect(layout.width).toBe(PADDING * 2 + 3 * CARD_WIDTH + 2 * LINK_WIDTH);
    expect(layout.height).toBe(PADDING * 2 + cardHeight(single.hops[0] as WireFlowHop));
  });

  it('widens the gap a long synthesized label has to fit into', () => {
    // 86px holds `calls`; it does not hold `registered at App.tsx:3764`, which
    // at a fixed pitch ran under the source of the card it was explaining.
    const wired: WireFlow = {
      id: 'f1',
      label: 'a → b',
      hops: [
        hop('a', { edge: null }),
        hop('b', {
          edge: edge({
            synthesized: true,
            line: 5337,
            label: 'via callback · onUpdate · registered at src/app/App.tsx:3764',
          }),
        }),
      ],
    };
    const layout = buildFlowLayout([wired], 'f1');
    expect(layout.gaps[0]).toBeGreaterThan(LINK_WIDTH);
    // Wide enough for the widest line it has to hold.
    const widest = Math.max(...(layout.links[0]?.labelLines ?? []).map((l) => l.length));
    expect(layout.gaps[0]).toBeGreaterThanOrEqual(widest * 6.65);
    // …and the second card starts past it, so nothing is drawn over the label.
    expect(layout.cards[1]?.x).toBe(PADDING + CARD_WIDTH + (layout.gaps[0] as number));
  });

  it('answers an empty picture for no flows at all', () => {
    expect(buildFlowLayout([], null)).toEqual({
      cards: [],
      endCaps: [],
      links: [],
      width: 0,
      height: 0,
      columns: 0,
      gaps: [],
    });
  });
});

describe('buildFlowLayout — two paths that merge', () => {
  // a → b → d and a → c → d: the same start, the same end, different middles.
  const left = flow('f1', ['a', 'b', 'd']);
  const right = flow('f2', ['a', 'c', 'd']);

  it('draws one DAG, not two strips', () => {
    const layout = buildFlowLayout([left, right], 'f1');
    expect(layout.cards).toHaveLength(4);
    expect(layout.links).toHaveLength(4);
    expect(layout.columns).toBe(3);
  });

  it('rejoins the shared cards in one column and stacks the branch', () => {
    const layout = buildFlowLayout([left, right], 'f1');
    const at = (name: string) => layout.cards.find((c) => c.hop.node.name === name)!;
    expect(at('a').column).toBe(0);
    expect(at('d').column).toBe(2);
    expect(at('b').column).toBe(1);
    expect(at('c').column).toBe(1);
    // Same column, different rows, exactly one gap apart.
    expect(at('c').y - at('b').y).toBe(at('b').height + ROW_GAP);
  });

  it('records which paths a shared card and a branch link belong to', () => {
    const layout = buildFlowLayout([left, right], 'f1');
    const at = (name: string) => layout.cards.find((c) => c.hop.node.name === name)!;
    expect(at('a').flows).toEqual(['f1', 'f2']);
    expect(at('b').flows).toEqual(['f1']);
    expect(at('c').flows).toEqual(['f2']);
    expect(layout.links.find((l) => l.target === 'method:c')!.flows).toEqual(['f2']);
  });

  it('marks the picked path, and only the picked path, with a step', () => {
    const picked = buildFlowLayout([left, right], 'f2');
    const at = (name: string) => picked.cards.find((c) => c.hop.node.name === name)!;
    expect(at('c').step).toBe(1);
    expect(at('b').step).toBe(-1);
    // …and the picked path is the one drawn along the top of its columns.
    expect(at('c').y).toBeLessThan(at('b').y);
  });
});

describe('endCapText', () => {
  it('names the form, keeps the key and counts the candidates', () => {
    const text = endCapText(boundary());
    expect(text.intro).toContain('routeAny');
    expect(text.sites[0].headline).toBe('computed member call at line 61');
    expect(text.sites[0].key).toBe('save');
    expect(text.sites[0].candidateHeading).toBe('1 candidate target \u203a');
    expect(text.quiet).toBeNull();
    expect(text.missed).toContain('onSave');
  });

  it('says the key is a runtime value rather than leaving the line blank', () => {
    const b = boundary();
    b.sites[0]!.key = null;
    b.sites[0]!.candidates = [];
    const text = endCapText(b);
    expect(text.sites[0].key).toBeNull();
    expect(text.sites[0].notes).toContain('the key is a runtime value');
    expect(text.sites[0].candidateHeading).toBeNull();
  });

  it('admits when the detector found nothing rather than implying a cause', () => {
    const text = endCapText(boundary({ sites: [] }));
    expect(text.quiet).toMatch(/No dynamic-dispatch site/);
    expect(text.sites).toEqual([]);
  });

  it('leads with the unfollowed name-only matches and their confidence', () => {
    const text = endCapText(
      boundary({
        uncertain: {
          total: 3,
          shown: 2,
          truncated: true,
          items: [
            { node: ref('save'), line: 61, confidence: 0.4 },
            { node: ref('store'), line: 62, confidence: 0.35 },
          ],
        },
      })
    );
    // The count is the TRUE total, not the length of the visible list.
    expect(text.uncertainHeading).toBe('3 name-only matches not followed (confidence < 0.6)');
    expect(text.uncertain).toHaveLength(2);
  });

  it('counts further resolved calls in the plural the number actually needs', () => {
    const one = endCapText(
      boundary({ further: { total: 1, shown: 1, truncated: false, items: [] } })
    );
    expect(one.further).toContain('1 further resolved call ');
    const many = endCapText(
      boundary({ further: { total: 4, shown: 0, truncated: true, items: [] } })
    );
    expect(many.further).toContain('4 further resolved calls ');
  });
});

describe('endCapHeight', () => {
  it('grows with what the cap has to say', () => {
    const bare = endCapHeight(boundary({ sites: [], missed: [] }));
    const full = endCapHeight(
      boundary({
        uncertain: {
          total: 2,
          shown: 2,
          truncated: false,
          items: [
            { node: ref('save'), line: 61, confidence: 0.4 },
            { node: ref('store'), line: 62, confidence: 0.3 },
          ],
        },
        further: { total: 5, shown: 0, truncated: true, items: [] },
      })
    );
    expect(full).toBeGreaterThan(bare);
  });

  it('is a whole number, because it is a pixel', () => {
    expect(Number.isInteger(endCapHeight(boundary()))).toBe(true);
  });
});

describe('buildFlowLayout — the end cap', () => {
  it('places the cap one column past the symbol the path stopped at', () => {
    const f = flow('f1', ['alpha', 'routeAny'], { boundary: boundary() });
    const layout = buildFlowLayout([f], 'f1');
    expect(layout.endCaps).toHaveLength(1);
    const cap = layout.endCaps[0]!;
    expect(cap.id).toBe(capId('method:routeAny'));
    expect(cap.anchorId).toBe('method:routeAny');
    expect(cap.column).toBe(1 + 1);
    expect(cap.width).toBe(END_CAP_WIDTH);
    expect(layout.columns).toBe(3);
    // The card the cap hangs off is tinted at the dispatch line.
    expect(layout.cards.find((c) => c.id === 'method:routeAny')!.stopLine).toBe(61);
    expect(layout.cards.find((c) => c.id === 'method:alpha')!.stopLine).toBeNull();
  });

  it('joins it with a dotted link that carries no arrow and no edge', () => {
    const layout = buildFlowLayout([flow('f1', ['alpha', 'routeAny'], { boundary: boundary() })], 'f1');
    const link = layout.links.find((l) => l.cap);
    expect(link).toBeDefined();
    expect(link!.edge).toBeNull();
    expect(link!.dash).toBe(END_CAP_DASH);
    expect(link!.label).toBe('end of static path');
    expect(link!.labelLines.join(' ')).toBe('end of static path');
    expect(link!.lineLabel).toBeNull();
  });

  it('draws no cap for a flow that reached what it was asked for', () => {
    const layout = buildFlowLayout([flow('f1', ['alpha', 'beta'])], 'f1');
    expect(layout.endCaps).toEqual([]);
    expect(layout.links.every((l) => !l.cap)).toBe(true);
  });

  it('draws ONE cap when two paths run out at the same symbol', () => {
    const a = flow('a', ['alpha', 'routeAny'], { boundary: boundary() });
    const b = flow('b', ['gamma', 'routeAny'], { boundary: boundary() });
    const layout = buildFlowLayout([a, b], 'a');
    expect(layout.endCaps).toHaveLength(1);
    expect(layout.endCaps[0]!.flows.sort()).toEqual(['a', 'b']);
  });

  it('leaves room for a cap wider or narrower than a card', () => {
    const layout = buildFlowLayout([flow('f1', ['alpha', 'routeAny'], { boundary: boundary() })], 'f1');
    const cap = layout.endCaps[0]!;
    // The canvas is wide enough to hold the cap, not just the cards.
    expect(layout.width).toBe(cap.x + cap.width + PADDING);
    // And the cap starts one gap past the card it hangs off.
    const anchor = layout.cards.find((c) => c.id === 'method:routeAny')!;
    expect(cap.x).toBe(anchor.x + CARD_WIDTH + LINK_WIDTH);
  });

  it('ignores a boundary whose symbol is not on screen', () => {
    const orphan = boundary({ node: ref('nowhere') });
    const layout = buildFlowLayout([flow('f1', ['alpha', 'beta'], { boundary: orphan })], 'f1');
    expect(layout.endCaps).toEqual([]);
  });
});

describe('buildFlowLayout — awkward shapes', () => {
  it('never draws a card left of something that calls it, on a long merge', () => {
    // a → b → c → d and a → d: `d`'s column must come from the LONGEST route,
    // or the short path would drag it back on top of `b`.
    const long = flow('f1', ['a', 'b', 'c', 'd']);
    const short = flow('f2', ['a', 'd']);
    const layout = buildFlowLayout([long, short], 'f1');
    const at = (name: string) => layout.cards.find((c) => c.hop.node.name === name)!;
    expect(at('d').column).toBe(3);
    for (const link of layout.links) {
      const from = layout.cards.find((c) => c.id === link.source)!;
      const to = layout.cards.find((c) => c.id === link.target)!;
      expect(to.column).toBeGreaterThan(from.column);
    }
  });

  it('still draws every card when a flow calls back into itself', () => {
    // a → b → a: a real shape (recursion through a helper) and one with no
    // topological order. Nothing may vanish.
    const cyclic: WireFlow = {
      id: 'f1',
      label: 'a → a',
      hops: [hop('a', { edge: null }), hop('b'), { ...hop('a'), edge: edge() }],
    };
    const layout = buildFlowLayout([cyclic], 'f1');
    expect(layout.cards.map((c) => c.hop.node.name).sort()).toEqual(['a', 'b']);
    expect(layout.links).toHaveLength(2);
    expect(layout.cards.every((c) => Number.isFinite(c.x) && Number.isFinite(c.y))).toBe(true);
  });

  it('centres a short column against a tall one', () => {
    const tall = flow('f1', ['a', 'b', 'd']);
    const alt = flow('f2', ['a', 'c', 'd']);
    const layout = buildFlowLayout([tall, alt], 'f1');
    const at = (name: string) => layout.cards.find((c) => c.hop.node.name === name)!;
    const columnMiddle = (name: string) => at(name).y + at(name).height / 2;
    // `a` is alone in its column; `b`/`c` share the next one. Their midpoints line up.
    expect(columnMiddle('a')).toBeCloseTo((at('b').y + at('c').y + at('c').height) / 2, 5);
  });
});
