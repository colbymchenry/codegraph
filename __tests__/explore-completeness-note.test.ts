/**
 * The completeness note at the end of a codegraph_explore response claims
 * "complete" only for sections that are.
 *
 * On the tiers with `includeCompletenessSignal` (>= 500 indexed files) every
 * response used to end with "Complete source for N files is included above —
 * do NOT re-read them", whatever the render had cut. That is how a 62-line
 * slice of vscode's 968-line `rpcProtocol.ts` was presented as complete: the
 * oversize-spine window elided most of the file, and until #2068 it did not
 * even set the trim flag the small tiers' note keys off. The same line also
 * said "Reserve Read for a single specific line range", and explore output must
 * never tell the agent to Read (AGENTS.md).
 *
 * The fixture reproduces that shape: a flow whose spine runs through one long
 * method, which the render windows to its head plus the next-hop call site.
 * The large-tier test fails without the measured check; the small-tier one
 * pins that the two tiers agree.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ExploreSessionState } from '../src/mcp/explore-session-state';
import {
  EXPLORE_FALLBACK_NOTES,
  ToolHandler,
  elidedWantedSpans,
  exploreCompletenessNotes,
  fitExploreEpilogue,
  shortestUniqueSuffixes,
  type ExploreWantedSpan,
} from '../src/mcp/tools';

const span = (
  name: string, start: number, end: number, importance = 1, spine = false, kind = 'method',
): ExploreWantedSpan => ({ name, kind, start, end, importance, spine });

/** The note this change replaced, for the size bound. */
const OLD_NOTE = '> **Complete source for 8 files is included above — do NOT re-read them.** If your question also needs files/symbols listed under "Not shown above" (or any area this call didn\'t cover), make ANOTHER codegraph_explore targeting those names — it returns the same source with line numbers and is cheaper and more complete than reading. Reserve Read for a single specific line range explore can\'t surface.';

/**
 * Anything that offers Read as a way forward. "treat it as already Read" is the
 * guarantee and "do not Read a file shown here" a prohibition — neither is an offer.
 */
const OFFERS_READ = /Reserve Read|use Read|Read for |fall back to Read/;
/** What follows the last source fence: the epilogue this change rewrote. */
const epilogueOf = (text: string): string => text.slice(text.lastIndexOf('```') + 3);

describe('elidedWantedSpans — judged on what was sent', () => {
  it('a span inside what was delivered is complete; one past its edge is not', () => {
    const elided = elidedWantedSpans(
      [span('inside', 10, 20), span('straddles', 25, 60), span('absent', 90, 95)],
      [{ start: 1, end: 40 }],
    );
    expect(elided.map((e) => e.name)).toEqual(['straddles', 'absent']);
  });

  it('counts a back-referenced span, and joins adjacent ranges', () => {
    // Lines 1–30 sent now, 31–50 held from an earlier call: one continuous copy.
    const elided = elidedWantedSpans([span('whole', 5, 45)], [{ start: 1, end: 30 }, { start: 31, end: 50 }]);
    expect(elided).toEqual([]);
  });

  it('orders the spine first, then importance, then source order', () => {
    const elided = elidedWantedSpans(
      [span('late', 80, 81, 9), span('peripheral', 5, 6, 1), span('flow', 50, 60, 3, true), span('early', 40, 41, 9)],
      [],
    );
    expect(elided.map((e) => e.name)).toEqual(['flow', 'early', 'late', 'peripheral']);
  });

  it('skips spans with no usable line range', () => {
    expect(elidedWantedSpans([span('zero', 0, 0), span('inverted', 9, 3)], [])).toEqual([]);
  });
});

describe('shortestUniqueSuffixes', () => {
  it('uses the basename unless another path ends with it', () => {
    const labels = shortestUniqueSuffixes([
      'src/vs/workbench/api/common/extHostExtensionService.ts',
      'src/vs/workbench/api/node/extHostExtensionService.ts',
      'src/vs/workbench/services/extensions/common/rpcProtocol.ts',
    ]);
    expect(labels.get('src/vs/workbench/api/common/extHostExtensionService.ts')).toBe('common/extHostExtensionService.ts');
    expect(labels.get('src/vs/workbench/api/node/extHostExtensionService.ts')).toBe('node/extHostExtensionService.ts');
    expect(labels.get('src/vs/workbench/services/extensions/common/rpcProtocol.ts')).toBe('rpcProtocol.ts');
  });

  it('falls back to the whole path when one path is a suffix of another', () => {
    const labels = shortestUniqueSuffixes(['a/b.ts', 'x/a/b.ts']);
    expect(labels.get('a/b.ts')).toBe('a/b.ts');
    expect(labels.get('x/a/b.ts')).toBe('x/a/b.ts');
  });
});

describe('exploreCompletenessNotes', () => {
  it('claims complete source only when nothing was trimmed, and never offers Read', () => {
    const notes = exploreCompletenessNotes(4, [], ['a.ts', 'b.ts']);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('Complete source for 4 files');
    expect(notes[0]).not.toMatch(OFFERS_READ);
  });

  it('a trimmed response keeps the already-Read guarantee, names the files and the elided symbols', () => {
    const trimmed = [
      {
        filePath: 'src/vs/workbench/services/extensions/common/rpcProtocol.ts',
        elided: [
          span('_receiveOneMessage', 280, 357, 9, true),
          span('RPCProtocol', 200, 900, 9, false, 'class'), // a container is no follow-up target
          span('serializeRequest', 700, 720, 9),
          span('helperNobodyAskedFor', 10, 12, 1),
        ],
      },
    ];
    const notes = exploreCompletenessNotes(3, trimmed, ['src/vs/workbench/services/extensions/common/rpcProtocol.ts', 'src/a.ts']);
    for (const note of notes) {
      expect(note).not.toContain('Complete source');
      expect(note).toContain('Verbatim source for 3 files');
      expect(note).toContain('treat it as already Read');
      expect(note).toContain('codegraph_explore');
      expect(note).not.toMatch(OFFERS_READ);
    }
    expect(notes[0]).toContain('`rpcProtocol.ts`');
    expect(notes[0]).toContain('`_receiveOneMessage`, `serializeRequest`');
    expect(notes[0]).not.toContain('`RPCProtocol`');
    expect(notes[0]).not.toContain('helperNobodyAskedFor');
  });

  it('counts files in words that read right for one and for none', () => {
    const t = [{ filePath: 'a.ts', elided: [span('f', 1, 9, 9)] }];
    expect(exploreCompletenessNotes(1, [], ['a.ts'])[0]).toContain('Complete source for 1 file is included');
    expect(exploreCompletenessNotes(1, t, ['a.ts'])[0]).toContain('Verbatim source for 1 file is included');
    // Every section held from an earlier call: no "0 files" beside a note about what was shown.
    for (const note of exploreCompletenessNotes(0, t, ['a.ts'])) {
      expect(note).not.toMatch(/\b0 files?\b/);
      expect(note).toContain('Verbatim source for these files');
    }
  });

  it('labels a trimmed file apart from a same-named file the pointer list names', () => {
    const trimmed = [{ filePath: 'src/common/rpcProtocol.ts', elided: [span('f', 1, 9, 9)] }];
    const [note] = exploreCompletenessNotes(1, trimmed, ['src/common/rpcProtocol.ts', 'src/node/rpcProtocol.ts']);
    expect(note).toContain('`common/rpcProtocol.ts`');
  });

  it('offers an elided method as Owner.member, so an overloaded name reaches the one that was cut', () => {
    const q = (s: ExploreWantedSpan, qualifiedName: string): ExploreWantedSpan => ({ ...s, qualifiedName });
    const trimmed = [{
      filePath: 'django/db/models/sql/compiler.py',
      elided: [
        q(span('as_sql', 776, 1003, 9, true), 'SQLCompiler::as_sql'),
        q(span('PLUGIN_ID', 5, 5, 9, false, 'method'), 'org.lamport.tla::HelpActivator::PLUGIN_ID'),
        q(span('inner', 40, 44, 9, false, 'function'), 'Outer::run::inner'), // a local function keeps its bare name
        q(span('odd', 50, 52, 9), 'src/a.py::odd'), // a path is no owner
      ],
    }];
    const [note] = exploreCompletenessNotes(1, trimmed, ['django/db/models/sql/compiler.py']);
    expect(note).toContain('(e.g. `SQLCompiler.as_sql`, `HelpActivator.PLUGIN_ID`, `inner`, `odd`)');
  });

  it('offers candidates from most to least specific, the last no longer than the note it replaced', () => {
    const trimmed = ['a', 'b', 'c', 'd', 'e'].map((n) => ({
      filePath: `packages/${n}/src/deeply/nested/${n}Service.ts`,
      elided: [span(`${n}Handler`, 10, 90, 9)],
    }));
    const notes = exploreCompletenessNotes(8, trimmed, trimmed.map((t) => t.filePath));
    expect(notes).toHaveLength(3);
    for (let i = 1; i < notes.length; i++) expect(notes[i]!.length).toBeLessThan(notes[i - 1]!.length);
    // Three files named, the rest counted.
    expect(notes[1]).toContain('`aService.ts`, `bService.ts`, `cService.ts` +2 more');
    // The last resort names nothing, so wherever the old note fit, it fits.
    expect(notes[2]).not.toContain('Service.ts');
    expect(notes[2]!.length).toBeLessThan(OLD_NOTE.length);
  });
});

describe('EXPLORE_FALLBACK_NOTES', () => {
  it.each(Object.entries(EXPLORE_FALLBACK_NOTES))('%s: the trimmed wording drops "complete" and is no longer', (_kind, note) => {
    // The epilogue floor and the cut note's fit test are sized before the render
    // knows which wording it needs.
    expect(note.trimmed.length).toBeLessThanOrEqual(note.complete.length);
    expect(note.complete).toContain('complete and verbatim');
    expect(note.trimmed).not.toMatch(/\bcomplete\b/);
    expect(note.trimmed).toContain('treat it as already Read');
    for (const text of [note.complete, note.trimmed]) {
      expect(text).toContain('codegraph_explore');
      expect(text).not.toMatch(OFFERS_READ);
    }
  });
});

describe('fitExploreEpilogue — the note and the pointer list share what is left', () => {
  const cost = (b: readonly string[]) => b.reduce((n, l) => n + l.length + 1, 0);
  const entries = ['a', 'b', 'c', 'd', 'e'].map((n) => `- src/${n}/${n.repeat(40)}.ts: ${n}Handler:10, ${n}Helper:40`);
  const note = (len: number) => ['', '---', `> ${'x'.repeat(len)}`];
  const names = note(470);
  const files = note(390);
  const generic = note(330);
  const fit = (room: number, noteCandidates: string[][], noteYields: boolean) =>
    fitExploreEpilogue({ room, noteCandidates, noteYields, pointerEntries: entries, pointerOmitted: 20 });
  const entriesIn = (block: readonly string[]) => block.filter((l) => l.startsWith('- src/')).length;
  /** Room for exactly `k` pointer entries (header, entries and tail) beside `withNote`. */
  const roomFor = (k: number, withNote: readonly string[] = []) => {
    const full = fit(1e6, [], false).pointers;
    const header = full.slice(0, 2);
    return cost(withNote) + cost([...header, ...entries.slice(0, k), `- ... and ${entries.length - k + 20} more files`]);
  };

  it('a complete-source note keeps its precedence over the pointer list', () => {
    const complete = note(330);
    const r = fit(cost(complete) + 20, [complete], false);
    expect(r.note).toEqual(complete);
    expect(r.pointers).toEqual([]);
  });

  it('a trimmed note leaves the pointer list its first entry', () => {
    // The generic note fits alone, but not beside the list's first entry.
    const room = cost(generic) + 20;
    expect(room).toBeLessThan(roomFor(1, generic));
    const r = fit(room, [names, files, generic], true);
    expect(r.note).toEqual([]);
    expect(entriesIn(r.pointers)).toBeGreaterThanOrEqual(1);
  });

  it("a trimmed note's detail never costs a pointer entry", () => {
    // Beside the generic note three entries fit; beside the named one, fewer.
    const room = roomFor(3, generic);
    const r = fit(room, [names, files, generic], true);
    expect(r.note).toEqual(generic);
    expect(entriesIn(r.pointers)).toBe(3);
  });

  it('takes the most specific note when it costs no entry', () => {
    const r = fit(roomFor(5, names), [names, files, generic], true);
    expect(r.note).toEqual(names);
    expect(entriesIn(r.pointers)).toBe(5);
  });

  it('with no pointer list, takes the most specific note that fits', () => {
    const r = fitExploreEpilogue({
      room: cost(files) + 10, noteCandidates: [names, files, generic], noteYields: true, pointerEntries: [], pointerOmitted: 0,
    });
    expect(r.note).toEqual(files);
    expect(r.pointers).toEqual([]);
  });
});

describe('codegraph_explore — the note follows what the render cut', () => {
  let dir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  // Long enough that no tier ships the file whole, and past the 200-line
  // oversize-spine threshold, so the render windows `runPipeline` to its head
  // plus the `stepNext` call site.
  const FILLER = 360;
  const CALL_AT = 180;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-completeness-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"cg-completeness","version":"1.0.0"}\n');
    const src = path.join(dir, 'src');
    fs.mkdirSync(src);
    const body: string[] = [
      "import { stepNext } from './step';",
      '',
      'export function runPipeline(input: number): number {',
      '  let acc = input;',
    ];
    for (let i = 0; i < FILLER; i++) {
      if (i === CALL_AT) body.push('  acc = stepNext(acc);');
      body.push(`  acc = acc + ${i}; // pipeline stage ${i}`);
    }
    body.push('  const PIPELINE_TAIL_MARKER = acc;', '  return PIPELINE_TAIL_MARKER;', '}', '');
    fs.writeFileSync(path.join(src, 'pipeline.ts'), body.join('\n'));
    // Three hops, because the flow only has a spine (and so a call site to
    // window to) for a chain of three or more.
    fs.writeFileSync(
      path.join(src, 'step.ts'),
      "import { finalizeStep } from './finalize';\n\nexport function stepNext(v: number): number {\n  return finalizeStep(v * 2);\n}\n",
    );
    fs.writeFileSync(path.join(src, 'finalize.ts'), 'export function finalizeStep(v: number): number {\n  return v + 1;\n}\n');
    // A second, small flow that renders whole: nothing to trim.
    fs.writeFileSync(
      path.join(src, 'format.ts'),
      "import { padValue } from './pad';\n\nexport function formatValue(v: number): string {\n  return padValue(String(v));\n}\n",
    );
    fs.writeFileSync(path.join(src, 'pad.ts'), "export function padValue(s: string): string {\n  return s.padStart(8, ' ');\n}\n");

    cg = CodeGraph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  }, 120_000);

  afterAll(() => {
    cg?.destroy();
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const explore = async (query: string, fileCount?: number): Promise<string> => {
    const spy = fileCount === undefined
      ? null
      : vi.spyOn(cg, 'getStats').mockReturnValue({ fileCount, nodeCount: 50 } as ReturnType<CodeGraph['getStats']>);
    try {
      const result = await handler.execute('codegraph_explore', { query });
      return result.content?.[0]?.text ?? '';
    } finally {
      spy?.mockRestore();
    }
  };

  it('large tier: a windowed spine method is reported trimmed, not complete', async () => {
    const text = await explore('runPipeline stepNext finalizeStep', 1000);
    // The fixture does what it is for: the method is windowed, so its tail is not in the response.
    expect(text).toContain('src/pipeline.ts');
    expect(text).toContain('stepNext(acc)');
    expect(text).not.toContain('PIPELINE_TAIL_MARKER');

    expect(text).not.toContain('Complete source for');
    expect(text).toContain('Verbatim source for');
    expect(text).toContain('treat it as already Read');
    expect(text).toMatch(/Trimmed for size: `pipeline\.ts`|Some sections were trimmed for size/);
    expect(epilogueOf(text)).not.toMatch(OFFERS_READ);
  });

  it('small tier: the same cut gets the trimmed note', async () => {
    const text = await explore('runPipeline stepNext finalizeStep');
    expect(text).not.toContain('PIPELINE_TAIL_MARKER');
    expect(text).toContain('Some file sections were trimmed for size');
  });

  it('large tier: complete sections are still called complete, without the Read escape hatch', async () => {
    const text = await explore('formatValue padValue', 1000);
    expect(text).toContain('src/format.ts');
    expect(text).toContain('src/pad.ts');
    expect(text).toMatch(/Complete source for \d+ files is included above/);
    expect(text).not.toContain('Verbatim source for');
    expect(epilogueOf(text)).not.toMatch(OFFERS_READ);
  });

  it('small tier: complete sections get no trimmed note', async () => {
    const text = await explore('formatValue padValue');
    expect(text).not.toContain('trimmed for size');
  });
});

describe('codegraph_explore — a dedup remainder folded into the back-reference is not delivered', () => {
  let dir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;
  let previousDedup: string | undefined;

  beforeAll(async () => {
    previousDedup = process.env.CODEGRAPH_EXPLORE_DEDUP;
    process.env.CODEGRAPH_EXPLORE_DEDUP = '1';
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-completeness-fold-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"cg-completeness-fold","version":"1.0.0"}\n');
    const src = path.join(dir, 'src');
    fs.mkdirSync(src);
    // `loadLedger`, then a tiny unrelated `tinyTail` just below it, then filler far
    // away so no tier ships the file whole. The first call sends `loadLedger` and
    // its padding; the second adds `tinyTail`, whose few lines are the remainder
    // dedup folds into the "Already sent" pointer instead of fencing them.
    const body: string[] = ['export function loadLedger(rows: number[]): number {', '  let total = 0;'];
    for (let i = 0; i < 30; i++) body.push(`  total += rows[${i}] ?? ${i};`);
    // Past the first call's 3 lines of padding, inside the cluster gap.
    body.push('  return total;', '}', '', '//', '//', '//', 'export const tinyTail = (): number => 7;', '');
    for (let i = 0; i < 40; i++) {
      body.push(`export function farFiller${i}(x: number): number {`);
      for (let j = 0; j < 5; j++) body.push(`  x = x * ${j + 2} + ${i};`);
      body.push('  return x;', '}', '');
    }
    fs.writeFileSync(path.join(src, 'ledger.ts'), body.join('\n'));
    cg = CodeGraph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  }, 120_000);

  afterAll(() => {
    if (previousDedup === undefined) delete process.env.CODEGRAPH_EXPLORE_DEDUP;
    else process.env.CODEGRAPH_EXPLORE_DEDUP = previousDedup;
    cg?.destroy();
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not call the file complete when the folded lines were never sent', async () => {
    const spy = vi.spyOn(cg, 'getStats').mockReturnValue({ fileCount: 1000, nodeCount: 50 } as ReturnType<CodeGraph['getStats']>);
    try {
      const session = new ExploreSessionState();
      const run = (query: string) =>
        handler.execute('codegraph_explore', { query }, session).then((r) => r.content?.[0]?.text ?? '');
      const first = await run('loadLedger');
      expect(first).toContain('loadLedger');
      expect(first).not.toContain('tinyTail = ()');
      const second = await run('loadLedger tinyTail');
      // The fixture reaches the fold: the section is a pointer, and `tinyTail`'s
      // source is in neither response.
      expect(second).toContain('Already sent earlier in this conversation');
      expect(second).not.toContain('tinyTail = ()');
      expect(second).not.toContain('Complete source for');
      expect(second).toContain('Trimmed for size: `ledger.ts`');
    } finally {
      spy.mockRestore();
    }
  });
});
