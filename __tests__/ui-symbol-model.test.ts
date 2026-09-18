/**
 * The Symbol view's decisions, without a browser (CG-44).
 *
 * Everything the screen does that could be wrong rather than merely ugly lives
 * in `ui/src/lib/` as plain functions over the `/api/node` payload: which lines
 * survive into a windowed body, which identifier a call-site link lands on,
 * which callers fold away, which reference is a guess. Those are the parts
 * worth pinning — the geometry that needs a real layout (row placement,
 * connector paths) is verified against a running viewer instead.
 */

import { describe, it, expect } from 'vitest';
import {
  assignRefs,
  buildCalleeRail,
  buildCallerRail,
  buildCodeBlock,
  buildOutline,
  edgeWord,
  graphCallLines,
  kindPhrase,
  refsByLine,
  showsBody,
  synthesizedBy,
  FULL_BODY_LINES,
  HEAD_LINES,
  type LineRef,
} from '../ui/src/lib/symbol-model';
import { decodeLine, plainLine, tokensByLine } from '../ui/src/lib/highlight';
import type { WireRelation, WireSymbolPayload } from '../ui/src/lib/api';

/* ------------------------------------------------------------- fixtures -- */

function nodeRef(over: Partial<WireSymbolPayload['node']> = {}): any {
  return {
    id: 'method:a',
    kind: 'method',
    name: 'load',
    qualifiedName: 'Service::load',
    file: 'src/service.ts',
    line: 10,
    endLine: 20,
    language: 'typescript',
    test: false,
    ...over,
  };
}

function relation(over: Partial<WireRelation> & { node?: any } = {}): WireRelation {
  const { node, ...rest } = over;
  const lines = rest.lines ?? [12];
  return {
    edgeKinds: ['calls'],
    edges: lines.map((line) => ({ kind: 'calls' as const, line, col: 4 })),
    edgeCount: lines.length,
    lines,
    confidence: 0.9,
    uncertain: false,
    synthesized: false,
    ...rest,
    node: nodeRef(node),
  } as WireRelation;
}

function payload(over: Partial<WireSymbolPayload> = {}): WireSymbolPayload {
  return {
    node: { ...nodeRef(), startColumn: 2, endColumn: 3, lines: 11 },
    ancestors: [],
    members: { total: 0, shown: 0, truncated: false, items: [] },
    incoming: { total: 0, shown: 0, truncated: false, items: [] },
    outgoing: { total: 0, shown: 0, truncated: false, items: [] },
    typesUsed: [],
    counts: { callers: 0, callees: 0, typesUsed: 0, fanIn: 0, fanOut: 0, members: 0, hub: false },
    tests: { reached: false, hops: null, fileCount: 0, files: [], exhaustive: true, hopsSearched: 3 },
    outsideIndex: { total: 0, byKind: {}, samples: [] },
    blast: null,
    drift: false,
    ...over,
  } as WireSymbolPayload;
}

const body = (count: number, from = 1): string[] =>
  Array.from({ length: count }, (_, i) => `line ${from + i}`);

/* ---------------------------------------------------------------- words -- */

describe('edge wording', () => {
  it('names the relationships that are not a plain call, and leaves calls unlabelled', () => {
    // Labelling every row "calls" is noise that hides the rows where the
    // relationship is something else.
    expect(edgeWord({ kind: 'calls' })).toBe('');
    expect(edgeWord({ kind: 'instantiates' })).toBe('creates');
    expect(edgeWord({ kind: 'references' })).toBe('uses type');
    expect(edgeWord({ kind: 'references', valueRef: true })).toBe('passes as value');
    expect(edgeWord({ kind: 'implements' })).toBe('implements');
  });

  it('names the synthesizer behind a heuristic edge, and nothing for a parsed one', () => {
    const parsed = relation();
    expect(synthesizedBy(parsed)).toBeNull();

    const synthesized = {
      ...parsed,
      synthesized: true,
      edges: [{ kind: 'calls', line: 12, provenance: 'heuristic', synthesizedBy: 'react-render' }],
    } as WireRelation;
    expect(synthesizedBy(synthesized)).toBe('react-render');
  });

  it('falls back to a truthful placeholder when the synthesizer did not name itself', () => {
    const synthesized = {
      ...relation(),
      synthesized: true,
      edges: [{ kind: 'calls', line: 12, provenance: 'heuristic' }],
    } as WireRelation;
    expect(synthesizedBy(synthesized)).toBe('synthesized');
  });
});

describe('kindPhrase', () => {
  it('reads the modifiers a reader acts on, and stays silent about the default ones', () => {
    expect(kindPhrase({ kind: 'method', async: true })).toBe('method · async');
    expect(kindPhrase({ kind: 'type_alias' })).toBe('type');
    expect(kindPhrase({ kind: 'method', visibility: 'public' })).toBe('method');
    expect(kindPhrase({ kind: 'method', static: true, visibility: 'private' })).toBe(
      'method · static · private'
    );
  });
});

/* -------------------------------------------------------------- windows -- */

describe('buildCodeBlock', () => {
  it('shows a body of 260 lines or fewer whole, with no gaps', () => {
    const block = buildCodeBlock(1, body(FULL_BODY_LINES), [5, 200]);
    expect(block.whole).toBe(true);
    expect(block.windows).toHaveLength(1);
    expect(block.windows[0]?.start).toBe(1);
    expect(block.windows[0]?.lines).toHaveLength(FULL_BODY_LINES);
    expect(block.gapsAfter).toEqual([]);
    expect(block.tailGap).toBe(0);
  });

  it('keeps the head plus a window round every call site once the body is longer', () => {
    // One call, far past the head: head + one ±4 window, one gap between them.
    const block = buildCodeBlock(1, body(400), [300]);
    expect(block.whole).toBe(false);
    expect(block.windows).toHaveLength(2);
    expect(block.windows[0]).toMatchObject({ start: 1 });
    expect(block.windows[0]?.lines).toHaveLength(HEAD_LINES);
    expect(block.windows[1]?.start).toBe(296);
    expect(block.windows[1]?.lines).toHaveLength(9);
    expect(block.gapsAfter).toEqual([215]);
    // 400 − 304 lines never reached the screen, and the block says how many.
    expect(block.tailGap).toBe(96);
  });

  it('merges windows that all but touch, rather than drawing a one-line gap', () => {
    const block = buildCodeBlock(1, body(400), [300, 310]);
    // 296–304 and 306–314 are two apart: one window, no gap row between them.
    expect(block.windows).toHaveLength(2);
    expect(block.windows[1]).toMatchObject({ start: 296 });
    expect(block.windows[1]?.lines).toHaveLength(19);
    expect(block.gapsAfter).toEqual([215]);
  });

  it('ignores call sites already inside the head', () => {
    const block = buildCodeBlock(1, body(400), [3, 40]);
    expect(block.windows).toHaveLength(1);
    expect(block.windows[0]?.lines).toHaveLength(HEAD_LINES);
    expect(block.tailGap).toBe(320);
  });

  it("numbers windows from the symbol's real first line, not from one", () => {
    const block = buildCodeBlock(778, body(400, 778), [1000]);
    expect(block.windows[0]?.start).toBe(778);
    expect(block.windows[1]?.start).toBe(996);
    expect(block.windows[1]?.lines[0]).toBe('line 996');
  });

  it('never runs a window past the end of the body', () => {
    const block = buildCodeBlock(1, body(400), [399]);
    const last = block.windows[block.windows.length - 1];
    expect((last?.start ?? 0) + (last?.lines.length ?? 0) - 1).toBe(400);
    expect(block.tailGap).toBe(0);
  });

  it('windows only on edges that reach the graph, not on unresolved references', () => {
    // A function calling `console.log` 200 times would otherwise window around
    // nearly every line, and the head-plus-windows rule would buy nothing.
    const view = payload({
      outgoing: { total: 1, shown: 1, truncated: false, items: [relation({ lines: [300] })] },
      outsideIndex: {
        total: 1,
        byKind: { calls: 1 },
        samples: [{ name: 'console.log', kind: 'calls', line: 350, col: 4 }],
      },
    });
    expect(graphCallLines(view)).toEqual([300]);
    expect(refsByLine(view).has(350)).toBe(true);
  });
});

/* ----------------------------------------------------------------- refs -- */

describe('assignRefs', () => {
  const toks = (line: string) => plainLine(line);
  const ref = (over: Partial<LineRef>): LineRef => ({
    ident: 'withLock',
    col: null,
    targetId: 'method:x',
    uncertain: false,
    outside: false,
    title: '',
    ...over,
  });

  it('marks the callee, not the receiver the column actually points at', () => {
    // The recorded column is the start of the calling EXPRESSION, so an exact
    // hit is the exception: `this` sits at column 11, `withLock` at 27.
    const line = '    return this.indexMutex.withLock(async () => {';
    const tokens = toks(line);
    const claimed = assignRefs(tokens, [ref({ col: 11 })]);
    const [index] = [...claimed.keys()];
    expect(tokens[index as number]?.text).toBe('withLock');
  });

  it('prefers the token the column lands inside when there is one', () => {
    const line = 'render(); render();';
    const tokens = toks(line);
    const second = line.lastIndexOf('render');
    const claimed = assignRefs(tokens, [ref({ ident: 'render', col: second })]);
    const [index] = [...claimed.keys()];
    expect(tokens[index as number]?.col).toBe(second);
  });

  it('gives two refs to the same name two different tokens', () => {
    const tokens = toks('render(); render();');
    const claimed = assignRefs(tokens, [
      ref({ ident: 'render', col: null, targetId: 'a' }),
      ref({ ident: 'render', col: null, targetId: 'b' }),
    ]);
    expect(claimed.size).toBe(2);
    expect(new Set([...claimed.values()].map((r) => r.targetId))).toEqual(new Set(['a', 'b']));
  });

  it('claims nothing when the identifier is not on the line', () => {
    // Better a missing link than an accent underline on the wrong word.
    expect(assignRefs(toks('return 1;'), [ref({ ident: 'nowhere' })]).size).toBe(0);
  });

  it('never marks a word inside a comment or a string as a call site', () => {
    // The classification comes from the server's grammar; what this pins is
    // that the overlay respects it. Anything else — a keyword, a type name a
    // grammar happened to scope as `storage.type` — stays claimable, because a
    // grammar's opinion about a scope name must not decide what navigates.
    const comment = [
      { cls: 'comment', text: '// call render here', col: 0 },
    ];
    expect(assignRefs(comment, [ref({ ident: 'render' })]).size).toBe(0);

    const string = [
      { cls: 'keyword', text: 'const', col: 0 },
      { cls: 'other', text: ' s = ', col: 5 },
      { cls: 'string', text: '"render"', col: 10 },
      { cls: 'other', text: ';', col: 18 },
    ];
    expect(assignRefs(string, [ref({ ident: 'render' })]).size).toBe(0);
  });

  it('still claims an identifier a grammar classified as something else', () => {
    // Go scopes `string` as storage.type; Java does the same to a declared
    // type name. A link that disappeared over that would be a highlighting
    // change silently breaking navigation.
    const tokens = [
      { cls: 'keyword', text: 'Duration', col: 0 },
      { cls: 'other', text: '.Since(t)', col: 8 },
    ];
    const claimed = assignRefs(tokens, [ref({ ident: 'Duration', col: 0 })]);
    expect(claimed.size).toBe(1);
    expect(tokens[[...claimed.keys()][0] as number]?.text).toBe('Duration');
  });
});

describe('refsByLine', () => {
  it('carries type references too, so a line that only names a type gets its port', () => {
    const view = payload({
      typesUsed: [relation({ node: { id: 'interface:c', kind: 'interface', name: 'Config' }, lines: [11] })],
    });
    const refs = refsByLine(view);
    expect(refs.get(11)?.[0]).toMatchObject({ ident: 'Config', outside: false });
  });

  it('uses the last segment of a qualified name — that is what is in the source', () => {
    const view = payload({
      outgoing: {
        total: 1,
        shown: 1,
        truncated: false,
        items: [relation({ node: { id: 'm:1', name: 'Cache.read' }, lines: [12] })],
      },
    });
    expect(refsByLine(view).get(12)?.[0]?.ident).toBe('read');
  });

  it('drops an unresolved "name" that is not an identifier at all', () => {
    // The resolver's samples are raw bookkeeping; a captured arrow function
    // cannot be found in the line, and searching for it would claim the wrong
    // token.
    const view = payload({
      outsideIndex: {
        total: 2,
        byKind: { calls: 2 },
        samples: [
          { name: '(() => {\n  return t', kind: 'calls', line: 12, col: 0 },
          { name: 'this.db', kind: 'function_ref', line: 13, col: 4 },
        ],
      },
    });
    const refs = refsByLine(view);
    expect(refs.has(12)).toBe(false);
    // `this.db` reduces to `db`, which IS in the line — kept, and marked as
    // outside the index so it renders as text rather than a link.
    expect(refs.get(13)?.[0]).toMatchObject({ ident: 'db', outside: true, targetId: null });
  });
});

/* ---------------------------------------------------------------- rails -- */

describe('buildCallerRail', () => {
  const caller = (over: { id: string; file: string; test?: boolean; uncertain?: boolean; edges?: number }) =>
    ({
      ...relation({ lines: [4657] }),
      node: {
        ...nodeRef({ id: over.id, file: over.file, name: over.id }),
        test: over.test ?? false,
      },
      edgeCount: over.edges ?? 1,
      uncertain: over.uncertain ?? false,
    }) as WireRelation;

  it("puts the symbol's own file first and groups the rest by path", () => {
    const view = payload({
      node: { ...nodeRef({ file: 'src/service.ts' }), startColumn: 0, endColumn: 0, lines: 11 },
      incoming: {
        total: 3,
        shown: 3,
        truncated: false,
        items: [
          caller({ id: 'z', file: 'src/z.ts' }),
          caller({ id: 'a', file: 'src/a.ts' }),
          caller({ id: 'own', file: 'src/service.ts' }),
        ],
      },
    });
    const rail = buildCallerRail(view);
    expect(rail.groups.map((g) => g.file)).toEqual(['src/service.ts', 'src/a.ts', 'src/z.ts']);
    expect(rail.groups[0]?.same).toBe(true);
    expect(rail.groups[1]?.same).toBe(false);
  });

  it('folds test callers away with their call and file counts intact', () => {
    const view = payload({
      incoming: {
        total: 3,
        shown: 3,
        truncated: false,
        items: [
          caller({ id: 'prod', file: 'src/a.ts' }),
          caller({ id: 't1', file: '__tests__/a.test.ts', test: true, edges: 4 }),
          caller({ id: 't2', file: '__tests__/b.test.ts', test: true, edges: 2 }),
        ],
      },
    });
    const rail = buildCallerRail(view);
    expect(rail.groups).toHaveLength(1);
    expect(rail.tests.rows).toHaveLength(2);
    expect(rail.tests.calls).toBe(6);
    expect(rail.tests.files).toEqual(['__tests__/a.test.ts', '__tests__/b.test.ts']);
    // The header count stays the real one — nothing is silently dropped.
    expect(rail.total).toBe(3);
  });

  it('folds an uncertain test caller as uncertain, not as a test', () => {
    // Uncertainty is a claim about the EDGE. Filing it under "tests" would
    // present a name-only guess as an established call.
    const view = payload({
      incoming: {
        total: 1,
        shown: 1,
        truncated: false,
        items: [caller({ id: 'g', file: '__tests__/a.test.ts', test: true, uncertain: true })],
      },
    });
    const rail = buildCallerRail(view);
    expect(rail.uncertain).toHaveLength(1);
    expect(rail.tests.rows).toHaveLength(0);
    expect(rail.groups).toHaveLength(0);
  });

  it('reports the callers the API had to cap away', () => {
    const view = payload({
      incoming: { total: 545, shown: 1, truncated: true, items: [caller({ id: 'a', file: 'src/a.ts' })] },
    });
    expect(buildCallerRail(view).hiddenGroups).toBe(544);
  });
});

describe('buildCalleeRail', () => {
  it('anchors each row to its first call site and folds the guesses to the bottom', () => {
    const view = payload({
      outgoing: {
        total: 2,
        shown: 2,
        truncated: false,
        items: [
          relation({ node: { id: 'sure' }, lines: [12, 18] }),
          { ...relation({ node: { id: 'guess' }, lines: [15] }), uncertain: true, confidence: 0.4 },
        ],
      },
    });
    const rail = buildCalleeRail(view);
    expect(rail.rows).toHaveLength(1);
    expect(rail.rows[0]?.anchor).toBe(12);
    expect(rail.rows[0]?.lines).toEqual([12, 18]);
    expect(rail.uncertain).toHaveLength(1);
  });

  it('separates calls that leave the index from type references that do', () => {
    const view = payload({
      outsideIndex: { total: 24, byKind: { calls: 21, references: 2, function_ref: 1 }, samples: [] },
    });
    const rail = buildCalleeRail(view);
    expect(rail.outsideCalls).toBe(22);
    expect(rail.outsideTypeRefs).toBe(2);
  });

  it('leaves a row with no recorded line unanchored rather than guessing a height', () => {
    const view = payload({
      outgoing: {
        total: 1,
        shown: 1,
        truncated: false,
        items: [{ ...relation({ lines: [] }), lines: [], edges: [] } as WireRelation],
      },
    });
    expect(buildCalleeRail(view).rows[0]?.anchor).toBeNull();
  });
});

/* -------------------------------------------------------------- outline -- */

describe('members outline', () => {
  it('dims data members and indents the ones nested a level deeper', () => {
    const view = payload({
      members: {
        total: 2,
        shown: 2,
        truncated: false,
        items: [
          { ...nodeRef({ kind: 'property', name: 'store' }), parentId: 'x', depth: 1, fanIn: 1, fanOut: 0 },
          { ...nodeRef({ kind: 'method', name: 'read' }), parentId: 'y', depth: 2, fanIn: 3, fanOut: 5 },
        ] as any,
      },
    });
    const rows = buildOutline(view);
    expect(rows[0]).toMatchObject({ dimmed: true, nested: false });
    expect(rows[1]).toMatchObject({ dimmed: false, nested: true });
  });
});

describe('showsBody', () => {
  it("swaps a large container's body for its outline, and keeps a large function's", () => {
    expect(showsBody('class', 700)).toBe(false);
    expect(showsBody('file', 2000)).toBe(false);
    expect(showsBody('class', 40)).toBe(true);
    // A 700-line function IS its body — there is no outline to show instead.
    expect(showsBody('function', 700)).toBe(true);
    expect(showsBody('method', 259)).toBe(true);
  });
});

/* ---------------------------------------------------------------- lexer -- */

describe('client-side token decoding', () => {
  // The classification itself is the server's job (`src/ui-server/highlight/`,
  // the engine's own tree-sitter parse); what is worth pinning here is the decoding — the
  // columns the call-site overlay matches against, and the plain fallback that
  // has to keep links working when no grammar covers a file.
  const CLASSES = ['other', 'ident', 'comment', 'string', 'keyword', 'number'];

  it('resolves class ids through the payload table', () => {
    const tokens = decodeLine(
      [
        [4, 'const'],
        [0, ' '],
        [1, 'x'],
        [0, ' = '],
        [5, '1'],
        [0, '; '],
        [2, '// note'],
      ],
      CLASSES
    );
    expect(tokens.map((t) => `${t.cls}:${t.text}`)).toEqual([
      'keyword:const',
      'other: ',
      'ident:x',
      'other: = ',
      'number:1',
      'other:; ',
      'comment:// note',
    ]);
  });

  it('derives each column from the running text, which is how a ref finds its identifier', () => {
    const tokens = decodeLine(
      [
        [0, '  '],
        [4, 'return'],
        [0, ' '],
        [1, 'render'],
        [0, '();'],
      ],
      CLASSES
    );
    expect(tokens.find((t) => t.text === 'render')?.col).toBe('  return '.length);
    expect(tokens.at(-1)?.col).toBe('  return render'.length);
  });

  it('treats an unknown class id as unstyled rather than throwing', () => {
    expect(decodeLine([[99, 'x']], CLASSES)[0]?.cls).toBe('other');
  });

  it('splits identifiers even with no grammar, so the links still land', () => {
    expect(plainLine('  return this.mutex.withLock();').map((t) => `${t.cls}:${t.text}`)).toEqual([
      'other:  ',
      'ident:return',
      'other: ',
      'ident:this',
      'other:.',
      'ident:mutex',
      'other:.',
      'ident:withLock',
      'other:();',
    ]);
  });

  it('splits non-ASCII identifiers, because a symbol name can be one', () => {
    expect(plainLine('取得データ()').map((t) => t.cls)).toEqual(['ident', 'other']);
  });

  it('keys a slice by real file line, not by offset into the slice', () => {
    const byLine = tokensByLine(['a();', 'b();'], 120, {
      engine: 'tree-sitter',
      grammar: 'typescript',
      classes: CLASSES,
      lines: [
        [
          [1, 'a'],
          [0, '();'],
        ],
        [
          [1, 'b'],
          [0, '();'],
        ],
      ],
    });
    expect([...byLine.keys()]).toEqual([120, 121]);
    expect(byLine.get(121)?.[0]?.text).toBe('b');
  });

  it('falls back per line when the payload carries no highlight block at all', () => {
    const byLine = tokensByLine(['render();'], 5, undefined);
    expect(byLine.get(5)?.map((t) => t.cls)).toEqual(['ident', 'other']);
  });
});
