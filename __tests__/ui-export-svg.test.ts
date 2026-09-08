/**
 * The SVG exporter (CG-55) — `ui/src/lib/export-svg.ts`.
 *
 * The export exists to leave the app, so the properties worth pinning are the
 * ones a reader on the other side depends on:
 *
 * - it is **well-formed XML**, or GitHub's sanitiser drops it and the reader
 *   sees a broken-image icon with no explanation;
 * - it carries the **light** tokens whatever the viewer was set to, because a
 *   dark image on a white comment background reads as a mistake;
 * - it says the **same thing the screen does** — same cards, same hops, same
 *   dashed hops, same hidden thin links — because the whole point of exporting
 *   from the layout object rather than the DOM is that the two cannot diverge;
 * - it fits the drawing, with nothing running off the edge of the canvas.
 *
 * Everything here is pure. The raster step needs a browser and is verified
 * over CDP against a live `codegraph ui`.
 */

import { describe, it, expect } from 'vitest';
import {
  EXPORT_COLORS,
  EXPORT_PADDING,
  MARK_TEXT,
  capRows,
  esc,
  exportFilename,
  flowSvg,
  mapSvg,
  truncate,
  wrapText,
} from '../ui/src/lib/export-svg';
import { buildFlowLayout } from '../ui/src/lib/flow-model';
import { buildMapLayout } from '../ui/src/lib/map-model';
import type {
  WireFlow,
  WireFlowBoundary,
  WireFlowEdge,
  WireFlowHop,
  WireMapLink,
  WireMapModule,
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
    line: 42,
    ...over,
  };
}

function ref(name: string): WireNodeRef {
  return {
    id: `method:${name}`,
    kind: 'method',
    name,
    qualifiedName: name,
    file: `src/deep/${name}.ts`,
    line: 10,
    endLine: 40,
    language: 'typescript',
    test: false,
  };
}

function hop(
  name: string,
  opts: { lines?: string[]; edge?: WireFlowEdge | null; callLine?: number } = {}
): WireFlowHop {
  const lines = opts.lines ?? ['  const a = 1;', '  return other(a);'];
  return {
    node: ref(name),
    edge: opts.edge === undefined ? edge() : opts.edge,
    callRef:
      opts.callLine === undefined
        ? null
        : { line: opts.callLine, col: 9, name: 'other', targetId: 'method:other', backwards: false },
    source: {
      file: `src/deep/${name}.ts`,
      language: 'typescript',
      from: 7,
      to: 6 + lines.length,
      lines,
      drift: false,
    },
  };
}

function flow(id: string, names: string[], over: Partial<WireFlow> = {}): WireFlow {
  return {
    id,
    label: `${names[0]} → ${names[names.length - 1]}`,
    hops: names.map((name, i) =>
      hop(name, { edge: i === 0 ? null : edge(), callLine: i === 0 ? 8 : undefined })
    ),
    boundary: null,
    partial: false,
    ...over,
  };
}

function boundary(over: Partial<WireFlowBoundary> = {}): WireFlowBoundary {
  return {
    node: ref('routeAny'),
    sites: [
      {
        form: 'computed-call',
        label: 'computed member call',
        snippet: 'return table[name](payload);',
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
    missed: [],
    ...over,
  };
}

function mod(id: string, over: Partial<WireMapModule> = {}): WireMapModule {
  return {
    id,
    label: id.slice(id.lastIndexOf('/') + 1) || id,
    files: over.files ?? 3,
    symbols: over.symbols ?? 30,
    languages: over.languages ?? [{ language: 'typescript', files: 3 }],
    test: over.test ?? false,
    facade: over.facade ?? false,
    fileList: over.fileList ?? { total: 3, shown: 3, truncated: false, items: [] },
  };
}

function link(source: string, target: string, count: number, declared = count): WireMapLink {
  return { source, target, count, declared, byKind: [{ kind: 'calls', count }], topPairs: [] };
}

/* ------------------------------------------------------------ utilities -- */

/**
 * Parse the SVG the way a consumer does.
 *
 * `DOMParser` is not in Node, so this is a hand-rolled well-formedness check:
 * every tag balanced, every attribute quoted, no stray `<` or `&` in text. That
 * is exactly the class of bug an un-escaped symbol name (`Map<K,V>`, `a && b`)
 * would introduce, and it is the one that makes GitHub refuse the file.
 */
function assertWellFormed(svg: string): void {
  const stack: string[] = [];
  const tag = /<(\/?)([a-zA-Z:]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let at = 0;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(svg)) !== null) {
    const between = svg.slice(at, match.index);
    expect(between, `unescaped < or & in text: ${JSON.stringify(between)}`).not.toMatch(
      /[<]|&(?!(amp|lt|gt|quot|apos|#\d+);)/
    );
    at = match.index + match[0].length;
    const [, closing, name, attrs, selfClosing] = match;
    // Every attribute is name="value" with a balanced pair of quotes.
    const quotes = (attrs as string).split('"').length - 1;
    expect(quotes % 2, `unbalanced quotes in <${name} ${attrs}>`).toBe(0);
    if (closing === '/') {
      expect(stack.pop(), 'closing tag with no opener').toBe(name);
    } else if (selfClosing !== '/') {
      stack.push(name as string);
    }
  }
  expect(stack, 'unclosed tags').toEqual([]);
}

function viewBox(svg: string): { width: number; height: number } {
  const box = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(svg);
  expect(box, 'no viewBox').toBeTruthy();
  return { width: Number(box![1]), height: Number(box![2]) };
}

function rootSize(svg: string): { width: number; height: number } {
  const w = /<svg[^>]*\bwidth="(\d+)"/.exec(svg);
  const h = /<svg[^>]*\bheight="(\d+)"/.exec(svg);
  return { width: Number(w![1]), height: Number(h![1]) };
}

/** Every x/y coordinate that appears on a drawn element, for a bounds check. */
function coords(svg: string): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  const re = /x="(-?\d+(?:\.\d+)?)"\s+y="(-?\d+(?:\.\d+)?)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg)) !== null) out.push({ x: Number(m[1]), y: Number(m[2]) });
  return out;
}

/* ------------------------------------------------------------ primitives -- */

describe('esc', () => {
  it('escapes everything XML would choke on', () => {
    expect(esc('Map<K, V> & "co"')).toBe('Map&lt;K, V&gt; &amp; &quot;co&quot;');
  });
});

describe('truncate', () => {
  it('leaves a string that fits alone, and ellipses one that does not', () => {
    expect(truncate('short', 400, 12)).toBe('short');
    // 12px mono advances at 7.2px, so 36px holds five characters.
    expect(truncate('abcdefgh', 36, 12)).toBe('abcd…');
  });

  it('does not emit a lone ellipsis when there is no room at all', () => {
    expect(truncate('abcdefgh', 7, 12)).toBe('');
  });
});

describe('wrapText', () => {
  it('breaks on words, never mid-word', () => {
    expect(wrapText('the quick brown fox jumps over', 12)).toEqual([
      'the quick',
      'brown fox',
      'jumps over',
    ]);
  });

  it('keeps an over-long word on its own line rather than losing it', () => {
    expect(wrapText('aa supercalifragilistic bb', 8)).toEqual(['aa', 'supercalifragilistic', 'bb']);
  });
});

describe('exportFilename', () => {
  it('slugs a flow label into something a filesystem accepts', () => {
    expect(exportFilename('flow', 'execute → getFile')).toBe('codegraph-flow-execute-getfile');
    expect(exportFilename('map', 'src/')).toBe('codegraph-map-src');
    expect(exportFilename('map', '')).toBe('codegraph-map');
  });
});

/* ------------------------------------------------------------ flow strip -- */

describe('flowSvg', () => {
  const layout = buildFlowLayout([flow('f1', ['execute', 'openFile', 'rowToFileRecord'])], 'f1');

  it('is well-formed XML with a viewBox and the mark', () => {
    const svg = flowSvg(layout);
    assertWellFormed(svg);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    expect(svg).toContain(`>${MARK_TEXT}</text>`);
  });

  it('paints the light paper whatever the viewer was set to', () => {
    const svg = flowSvg(layout);
    expect(svg).toContain(`fill="${EXPORT_COLORS.paper}"`);
    expect(svg).toContain(EXPORT_COLORS.ink);
    // No token from the dark set appears anywhere in the file: dark paper,
    // dark ink, dark accent. An export follows the reader's page, not ours.
    for (const dark of ['#1c1a14', '#f3f1ea', '#d48b96', '#34322a']) {
      expect(svg, dark).not.toContain(dark);
    }
  });

  it('names every hop on the strip, once each', () => {
    const svg = flowSvg(layout);
    for (const name of ['execute', 'openFile', 'rowToFileRecord']) {
      expect(svg.split(`>${name}<`).length - 1, name).toBe(1);
    }
  });

  it('keeps fonts as stacks and embeds nothing', () => {
    const svg = flowSvg(layout);
    expect(svg).toContain("'IBM Plex Mono'");
    expect(svg).not.toContain('@font-face');
    expect(svg).not.toContain('base64');
  });

  it('scales only the root size — the geometry is identical', () => {
    const one = flowSvg(layout, { scale: 1 });
    const two = flowSvg(layout, { scale: 2 });
    expect(viewBox(two)).toEqual(viewBox(one));
    expect(rootSize(two).width).toBe(rootSize(one).width * 2);
    expect(rootSize(two).height).toBe(rootSize(one).height * 2);
    // Same drawing, two envelopes: everything between the root tags matches.
    expect(two.slice(two.indexOf('\n'))).toBe(one.slice(one.indexOf('\n')));
  });

  it('fits the drawing inside the canvas with the padding on every side', () => {
    const svg = flowSvg(layout);
    const box = viewBox(svg);
    const cards = layout.cards;
    const spanX = Math.max(...cards.map((c) => c.x + c.width)) - Math.min(...cards.map((c) => c.x));
    expect(box.width).toBeGreaterThanOrEqual(spanX + EXPORT_PADDING * 2);
    for (const { x, y } of coords(svg)) {
      expect(x).toBeGreaterThanOrEqual(-1);
      expect(y).toBeGreaterThanOrEqual(-1);
    }
  });

  it('carries the edge label and the line the call was recorded at', () => {
    const svg = flowSvg(layout);
    expect(svg).toContain('>calls</text>');
    expect(svg).toContain('>line 42</text>');
  });

  it('dashes a synthesized hop exactly as the strip does', () => {
    const synthesized = flow('f2', ['a', 'b']);
    synthesized.hops[1]!.edge = edge({
      synthesized: true,
      label: 'via callback · registered at src/wire.ts:88',
    });
    const svg = flowSvg(buildFlowLayout([synthesized], 'f2'));
    expect(svg).toContain('stroke-dasharray="5 3"');
    // The wiring site is the evidence for a hop nobody can see in the source.
    expect(svg).toContain('wire.ts:88');
  });

  it('tints the call line and underlines the identifier the graph resolved', () => {
    const one = flow('f3', ['execute', 'other']);
    one.hops[0]!.callRef = {
      line: 8,
      col: 9,
      name: 'other',
      targetId: 'method:other',
      backwards: false,
    };
    const svg = flowSvg(buildFlowLayout([one], 'f3'));
    expect(svg).toContain(`fill="${EXPORT_COLORS.accentSoft}"`);
    expect(svg).toContain(`<tspan fill="${EXPORT_COLORS.accent}">other</tspan>`);
    expect(svg).toContain(`stroke="${EXPORT_COLORS.accentLine}"`);
  });

  it('preserves the indentation of every source line', () => {
    const svg = flowSvg(layout);
    expect(svg).toContain('xml:space="preserve"');
    expect(svg).toContain('<tspan>  </tspan>');
  });

  it('escapes source that would otherwise break the document', () => {
    const nasty = flow('f4', ['render']);
    nasty.hops[0]!.source!.lines = ['const x = a < b && c > d;', 'type T = Map<K, "v">;'];
    const svg = flowSvg(buildFlowLayout([nasty], 'f4'));
    assertWellFormed(svg);
    expect(svg).toContain('&lt;');
    expect(svg).toContain('&amp;&amp;');
  });

  it('draws the end cap dashed, with the site, the key and the candidate', () => {
    const capped = flow('f5', ['dispatch'], { boundary: null });
    capped.boundary = boundary({ node: capped.hops[0]!.node });
    const svg = flowSvg(buildFlowLayout([capped], 'f5'));
    expect(svg).toContain('Where the graph stops.');
    expect(svg).toContain('computed member call at line 61');
    expect(svg).toContain('>key save</text>');
    expect(svg).toContain('1 candidate target');
    // The dotted link into a cap, and the cap's own dashed border.
    expect(svg).toContain('stroke-dasharray="2 4"');
    expect(svg).toContain('>end of</text>');
    // …and no arrowhead on it: the absence of a continuation is the finding.
    expect(svg.match(/<polygon/g)).toBeNull();
  });

  it('gives the cap room for the lines it really wraps to', () => {
    const long = boundary({
      sites: [
        {
          form: 'computed-call',
          label: 'reflective invoke through a registry of handlers',
          snippet: 'x',
          line: 61,
          key: null,
          keyIsType: false,
          moreSites: 3,
          candidates: [],
          candidateNote: 'the key is too generic to shortlist against',
        },
      ],
    });
    const rows = capRows({
      id: 'cap:x',
      anchorId: 'x',
      boundary: long,
      x: 0,
      y: 0,
      width: 240,
      height: 10,
      flows: ['f'],
    });
    // Every row is inside the cap's own text column…
    for (const row of rows.rows) expect(row.text.length).toBeLessThanOrEqual(32);
    // …and the height accounts for all of them.
    expect(rows.height).toBeGreaterThan(rows.rows.length * 15);
  });

  it('dims the paths that are not the picked one when several are drawn', () => {
    const both = [flow('a', ['start', 'left', 'end']), flow('b', ['start', 'right', 'end'])];
    const svg = flowSvg(buildFlowLayout(both, 'a'), { activeFlowId: 'a', showAll: true });
    expect(svg).toContain('opacity="0.4"');
    // The picked path keeps the accent border; the other does not.
    expect(svg).toContain(`stroke="${EXPORT_COLORS.accent}"`);
    expect(svg).toContain('>right</text>');
  });

  it('writes the caption next to the mark', () => {
    const svg = flowSvg(layout, { caption: 'execute → rowToFileRecord · 3 hops' });
    expect(svg).toContain('execute → rowToFileRecord · 3 hops');
    assertWellFormed(svg);
  });
});

/* -------------------------------------------------------------------- map -- */

describe('mapSvg', () => {
  const payload = {
    modules: [
      mod('src/bin'),
      mod('src/mcp'),
      mod('src/db', { symbols: 1218, files: 54 }),
      mod('__tests__', { test: true }),
    ],
    links: [
      link('src/bin', 'src/mcp', 30),
      link('src/mcp', 'src/db', 22),
      link('src/bin', 'src/db', 2),
      link('__tests__', 'src/db', 40),
    ],
  };
  const layout = buildMapLayout(payload, { includeTests: false });

  it('is well-formed, light, and marked', () => {
    const svg = mapSvg(layout);
    assertWellFormed(svg);
    expect(svg).toContain(`fill="${EXPORT_COLORS.paper}"`);
    expect(svg).toContain(`>${MARK_TEXT}</text>`);
  });

  it('draws every module box with its name and its counts', () => {
    const svg = mapSvg(layout);
    expect(svg).toContain('>src/bin</text>');
    expect(svg).toContain('>src/db</text>');
    expect(svg).toContain('>1218 symbols · 54 files</text>');
    // Tests were filtered out of the layout, so they are not in the image.
    expect(svg).not.toContain('>__tests__</text>');
  });

  it('names the top and bottom bands', () => {
    const svg = mapSvg(layout);
    expect(svg).toContain('>entry points</text>');
    expect(svg).toContain('>foundations — depend on nothing below</text>');
  });

  it('hides the same thin links the canvas hides', () => {
    const svg = mapSvg(layout);
    // src/bin → src/db carries 2, under MIN_WEIGHT: one path per visible link
    // plus one per layer rule is not a count worth asserting, so check the
    // stroke widths instead — a hidden link contributes none.
    const drawn = svg.match(/<path /g)?.length ?? 0;
    expect(drawn).toBe(layout.edges.filter((e) => !e.thin && !e.back).length);
  });

  it('brings a selected module’s thin links out, as the canvas does', () => {
    const svg = mapSvg(layout, { selected: 'src/bin' });
    const drawn = svg.match(/<path /g)?.length ?? 0;
    expect(drawn).toBe(
      layout.edges.filter((e) => e.source === 'src/bin' || e.target === 'src/bin').length
    );
  });

  it('dims a module the selection does not touch, and only that one', () => {
    // src/bin reaches both other modules, so a fixture needs a fourth module
    // standing apart before dimming has anything to say.
    const apart = buildMapLayout(
      { modules: [...payload.modules, mod('site')], links: payload.links },
      { includeTests: false }
    );
    const svg = mapSvg(apart, { selected: 'src/bin' });
    // Exactly one box goes grey: its rule and its two lines of text.
    expect(svg.split(`stroke="${EXPORT_COLORS.ink4}"`).length - 1).toBe(1);
    expect(svg.split(`fill="${EXPORT_COLORS.ink4}"`).length - 1).toBe(2);
  });

  it('scales the root only', () => {
    const one = mapSvg(layout, { scale: 1 });
    const two = mapSvg(layout, { scale: 2 });
    expect(viewBox(two)).toEqual(viewBox(one));
    expect(rootSize(two).width).toBe(rootSize(one).width * 2);
  });

  it('keeps every drawn coordinate inside the canvas', () => {
    const svg = mapSvg(layout);
    const box = viewBox(svg);
    for (const { x, y } of coords(svg)) {
      expect(x).toBeGreaterThanOrEqual(-1);
      expect(y).toBeGreaterThanOrEqual(-1);
      expect(x).toBeLessThanOrEqual(box.width + 1);
      expect(y).toBeLessThanOrEqual(box.height + 1);
    }
    // Layer rules are the one thing that spans the whole picture, and the one
    // that used to run off the right-hand edge: they follow the boxes, not the
    // canvas' own padded width.
    const rules = [...svg.matchAll(/x1="(-?[\d.]+)"[^>]*x2="(-?[\d.]+)"/g)];
    expect(rules.length).toBeGreaterThan(0);
    for (const [, x1, x2] of rules) {
      expect(Number(x1)).toBeGreaterThanOrEqual(0);
      expect(Number(x2)).toBeLessThanOrEqual(box.width);
    }
  });

  it('marks a test module dashed when it is included', () => {
    const withTests = buildMapLayout(payload, { includeTests: true });
    const svg = mapSvg(withTests);
    expect(svg).toContain('>__tests__</text>');
    expect(svg).toContain('stroke-dasharray="4 3"');
  });

  it('survives a module id that needs escaping', () => {
    const odd = buildMapLayout(
      { modules: [mod('src/<odd> & co'), mod('src/db')], links: [link('src/<odd> & co', 'src/db', 9)] },
      { includeTests: false }
    );
    const svg = mapSvg(odd);
    assertWellFormed(svg);
    expect(svg).toContain('&lt;odd&gt; &amp; co');
  });
});
