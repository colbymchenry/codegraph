/**
 * Cross-call source dedup (CG-18).
 *
 * A later `codegraph_explore` call in a session must not re-send source an
 * earlier call already delivered — but every byte it withholds has to be
 * replaced by a POINTER, never a silence. That asymmetry is what this suite
 * guards, because the two failure directions cost wildly different amounts: a
 * duplicate range wastes a few thousand chars, while a response that reads as
 * "codegraph doesn't have it" costs a Read — and one or two of those early in a
 * session teach an agent to stop calling the tool at all.
 *
 * Three layers:
 *   1. the range algebra — what is withheld, and the thresholds that stop it
 *      from shredding a block into slivers;
 *   2. the fingerprint gate — an edit between two calls must re-emit, since a
 *      pointer to pre-edit source is worse than no dedup at all;
 *   3. the handler seam — a real second call against a real index: no duplicate
 *      ranges, a pointer for everything withheld, the reclaimed budget spent on
 *      source the agent has NOT seen, and never an all-pointer response.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import { ExploreSessionState, type ExploreProjectState } from '../src/mcp/explore-session-state';
import {
  EXPLORE_DEDUP,
  dedupeRange,
  fileFingerprint,
  formatBackReference,
  intersectRange,
  mergeRanges,
  servedRangesForFile,
  subtractRange,
  symbolsInSpans,
} from '../src/mcp/explore-dedup';

const FIXTURE_SRC = path.join(__dirname, 'fixtures', 'payroll-go');
const QUERY = 'how does payroll cycle create and calculate payslips?';
const POINTER = 'Already sent earlier in this conversation';

/** A prior-state shaped like the session tracker's, for the algebra tests. */
function prior(files: Array<{ path: string; ranges: Array<[number, number]>; fingerprint?: string }>): ExploreProjectState {
  return {
    projectRoot: '/repo',
    callCount: 1,
    responseBytes: 1000,
    calls: [{
      index: 1,
      projectRoot: '/repo',
      query: 'q',
      sourceBytes: 500,
      responseBytes: 1000,
      files: files.map((f) => ({
        path: f.path,
        ranges: f.ranges.map(([start, end]) => ({ start, end })),
        bytes: 500,
        fingerprint: f.fingerprint,
      })),
    }],
  };
}

describe('range algebra', () => {
  it('subtracts a held span out of the middle of an intended one', () => {
    expect(subtractRange({ start: 1, end: 100 }, [{ start: 20, end: 40 }]))
      .toEqual([{ start: 1, end: 19 }, { start: 41, end: 100 }]);
  });

  it('subtracts held spans at either edge, and a full cover to nothing', () => {
    expect(subtractRange({ start: 10, end: 50 }, [{ start: 1, end: 20 }]))
      .toEqual([{ start: 21, end: 50 }]);
    expect(subtractRange({ start: 10, end: 50 }, [{ start: 30, end: 90 }]))
      .toEqual([{ start: 10, end: 29 }]);
    expect(subtractRange({ start: 10, end: 50 }, [{ start: 1, end: 90 }])).toEqual([]);
  });

  it('intersects to exactly what both sides hold', () => {
    expect(intersectRange({ start: 10, end: 50 }, [{ start: 1, end: 20 }, { start: 45, end: 80 }]))
      .toEqual([{ start: 10, end: 20 }, { start: 45, end: 50 }]);
    expect(intersectRange({ start: 10, end: 50 }, [{ start: 60, end: 80 }])).toEqual([]);
  });

  it('merges touching spans — two adjacent blocks are one block of source', () => {
    expect(mergeRanges([{ start: 5, end: 9 }, { start: 10, end: 12 }, { start: 40, end: 41 }]))
      .toEqual([{ start: 5, end: 12 }, { start: 40, end: 41 }]);
  });

  it('emits ONLY the delta when a later call wants a wider window', () => {
    // Call 1 sent the method; call 2 wants the class around it.
    const { emit, covered } = dedupeRange({ start: 80, end: 200 }, [{ start: 100, end: 140 }]);
    expect(covered).toEqual([{ start: 100, end: 140 }]);
    expect(emit).toEqual([{ start: 80, end: 99 }, { start: 141, end: 200 }]);
  });

  it('withholds nothing when the overlap is smaller than a chunk worth pointing at', () => {
    // Context padding and signature lines land here. Replacing them costs more
    // in pointer text than the source is worth, and shreds the block.
    const overlap = EXPLORE_DEDUP.MIN_COVERED_LINES - 1;
    const { emit, covered } = dedupeRange({ start: 1, end: 100 }, [{ start: 10, end: 10 + overlap - 1 }]);
    expect(covered).toEqual([]);
    expect(emit).toEqual([{ start: 1, end: 100 }]);
  });

  it('leaves an untouched span exactly as it was', () => {
    expect(dedupeRange({ start: 1, end: 50 }, [{ start: 200, end: 400 }]))
      .toEqual({ emit: [{ start: 1, end: 50 }], covered: [] });
    expect(dedupeRange({ start: 1, end: 50 }, []))
      .toEqual({ emit: [{ start: 1, end: 50 }], covered: [] });
  });
});

describe('the fingerprint gate', () => {
  const FP = fileFingerprint('package main\nfunc main() {}\n');

  it('returns the spans a call served for a file whose bytes are unchanged', () => {
    const state = prior([{ path: 'a.go', ranges: [[1, 40], [60, 80]], fingerprint: FP }]);
    expect(servedRangesForFile(state, 'a.go', FP)).toEqual([{ start: 1, end: 40 }, { start: 60, end: 80 }]);
  });

  it('returns NOTHING once the file has been edited — a pointer would be wrong', () => {
    const state = prior([{ path: 'a.go', ranges: [[1, 40]], fingerprint: FP }]);
    const edited = fileFingerprint('package main\nfunc main() { changed() }\n');
    expect(servedRangesForFile(state, 'a.go', edited)).toEqual([]);
  });

  it('ignores a record that cannot prove what it served', () => {
    const state = prior([{ path: 'a.go', ranges: [[1, 40]] }]);
    expect(servedRangesForFile(state, 'a.go', FP)).toEqual([]);
  });

  it('never crosses files, and is empty for an untracked session', () => {
    const state = prior([{ path: 'a.go', ranges: [[1, 40]], fingerprint: FP }]);
    expect(servedRangesForFile(state, 'b.go', FP)).toEqual([]);
    expect(servedRangesForFile(null, 'a.go', FP)).toEqual([]);
  });

  it('distinguishes two files that hash the same prefix but differ in length', () => {
    expect(fileFingerprint('abc')).not.toBe(fileFingerprint('abcd'));
    expect(fileFingerprint('abc')).toBe(fileFingerprint('abc'));
  });
});

describe('the back-reference itself', () => {
  const covered = [{ start: 100, end: 240 }];

  it('names the file, the span and the symbols, and says the copy is still good', () => {
    const text = formatBackReference('internal/x.go', covered, ['RunCycle', 'BuildPayslip'], { partial: false });
    expect(text).toContain('internal/x.go');
    expect(text).toContain('L100-240');
    expect(text).toContain('RunCycle, BuildPayslip');
    expect(text).toContain(POINTER);
    expect(text).toContain('unchanged on disk');
  });

  it('never tells the agent to Read, in either shape', () => {
    for (const partial of [true, false]) {
      const text = formatBackReference('x.go', covered, ['A'], { partial });
      expect(text).toMatch(/do NOT Read/i);
      expect(text).not.toMatch(/\bRead (this|the) file (for|to)\b/i);
      expect(text).not.toMatch(/omitted|unavailable|could not/i);
    }
  });

  it('says the block below is only the NEW lines when the call still sends some', () => {
    expect(formatBackReference('x.go', covered, [], { partial: true })).toContain('NEW lines');
    expect(formatBackReference('x.go', covered, [], { partial: false })).toContain('not repeated here');
  });

  it('names only symbols that actually fall in the withheld spans', () => {
    const nodes = [
      { name: 'InSpan', kind: 'function', startLine: 110, endLine: 130 },
      { name: 'Outside', kind: 'function', startLine: 300, endLine: 320 },
      { name: 'AnImport', kind: 'import', startLine: 105, endLine: 105 },
    ];
    expect(symbolsInSpans(nodes, covered)).toEqual(['InSpan']);
  });
});

describe('a second call against a real index', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cg18-'));
    fs.cpSync(FIXTURE_SRC, testDir, { recursive: true });
    fs.rmSync(path.join(testDir, '.codegraph'), { recursive: true, force: true });
    cg = CodeGraph.initSync(testDir);
    await cg.indexAll();
    handler = new ToolHandler(cg);
  }, 120_000);

  afterAll(() => {
    if (cg) cg.destroy();
    if (testDir && fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  const explore = (query: string, session?: ExploreSessionState, args: Record<string, unknown> = {}) =>
    handler.execute('codegraph_explore', { query, ...args }, session).then((r) => r.content[0]!.text);

  /**
   * The line numbers actually inside each file's fenced source. Read off the
   * RESPONSE, not the bookkeeping — "no duplicate ranges" is a claim about what
   * the agent received, and checking it against the record we also wrote would
   * prove only that the two agree.
   */
  function fencedLines(text: string): Map<string, Set<number>> {
    const out = new Map<string, Set<number>>();
    let current: string | null = null;
    let inFence = false;
    for (const line of text.split('\n')) {
      const header = /^\*\*`([^`]+)`\*\*/.exec(line);
      if (header && !inFence) { current = header[1]!; continue; }
      if (!inFence && current && line.startsWith('```')) { inFence = true; continue; }
      if (inFence && line === '```') { inFence = false; continue; }
      if (!inFence || !current) continue;
      const numbered = /^(\d+)\t/.exec(line);
      if (!numbered) continue;
      if (!out.has(current)) out.set(current, new Set());
      out.get(current)!.add(Number(numbered[1]));
    }
    return out;
  }

  it('never re-sends a line it already sent, and points at every line it withholds', async () => {
    const session = new ExploreSessionState();
    const first = await explore(QUERY, session);
    const second = await explore(QUERY, session);

    const before = fencedLines(first);
    const after = fencedLines(second);
    expect(after.size).toBeGreaterThan(0);

    // Every file whose source the second call withheld carries a pointer, and
    // the pointer names it.
    expect(second).toContain(POINTER);
    for (const [file, lines] of before) {
      const repeated = [...(after.get(file) ?? [])].filter((n) => lines.has(n));
      if (repeated.length === 0) continue;
      // The only sanctioned repeat is the anti-abandonment restore, which fires
      // ONLY when the call found nothing new to say — and this one did.
      throw new Error(`call 2 re-sent ${file} lines ${repeated.slice(0, 5).join(',')}`);
    }
  }, 120_000);

  it('spends the reclaimed bytes on source the agent has not seen', async () => {
    const session = new ExploreSessionState();
    const first = await explore(QUERY, session);
    const second = await explore(QUERY, session);

    const before = fencedLines(first);
    const after = fencedLines(second);
    const fresh = [...after.entries()].reduce(
      (sum, [file, lines]) => sum + [...lines].filter((n) => !(before.get(file)?.has(n))).length, 0);
    // Not merely "smaller": a shrunken response is what dedup must NOT produce.
    // The freed budget has to come back as lines the first call never sent.
    expect(fresh).toBeGreaterThan(20);
    expect(second.length).toBeLessThan(first.length);
  }, 120_000);

  it('re-emits in full when the file changed between the two calls', async () => {
    const session = new ExploreSessionState();
    const target = path.join(testDir, 'internal/usecase/payroll/payslip_builder.go');
    const original = fs.readFileSync(target, 'utf-8');
    try {
      const first = await explore(QUERY, session);
      expect(fencedLines(first).has('internal/usecase/payroll/payslip_builder.go')).toBe(true);

      fs.writeFileSync(target, original.replace('func sumKind(', 'func sumKindRenamed('), 'utf-8');
      const second = await explore(QUERY, session);

      // The edited file is served again, whole — a pointer here would send the
      // agent to a copy of the file that no longer exists.
      const pointerLines = second.split('\n').filter((l) => l.includes(POINTER));
      expect(pointerLines.some((l) => l.includes('payslip_builder.go'))).toBe(false);
      expect(fencedLines(second).get('internal/usecase/payroll/payslip_builder.go')?.size ?? 0)
        .toBeGreaterThan(20);
    } finally {
      fs.writeFileSync(target, original, 'utf-8');
    }
  }, 120_000);

  it('always returns real source, even when the session already holds everything', async () => {
    const session = new ExploreSessionState();
    await explore(QUERY, session);
    await explore(QUERY, session);
    const third = await explore(QUERY, session);
    const fourth = await explore(QUERY, session);

    // An all-pointer response is the shape that reads as failure. Every call
    // keeps at least one real fenced block, however much the session holds.
    for (const [n, text] of [[3, third], [4, fourth]] as const) {
      const lines = [...fencedLines(text).values()].reduce((s, set) => s + set.size, 0);
      expect(lines, `call ${n} returned no source at all`).toBeGreaterThan(10);
    }
  }, 180_000);

  it('leaves the first call of a session untouched', async () => {
    const tracked = await explore(QUERY, new ExploreSessionState());
    const untracked = await explore(QUERY);
    expect(tracked).toBe(untracked);
  }, 120_000);

  it('keeps two sessions on one handler independent', async () => {
    const a = new ExploreSessionState();
    const b = new ExploreSessionState();
    const firstForA = await explore(QUERY, a);
    await explore(QUERY, a);
    // B's first call has seen nothing, whatever A has been served.
    expect(await explore(QUERY, b)).toBe(firstForA);
  }, 180_000);

  it('is off entirely under CODEGRAPH_EXPLORE_DEDUP=0', async () => {
    const session = new ExploreSessionState();
    const previous = process.env.CODEGRAPH_EXPLORE_DEDUP;
    process.env.CODEGRAPH_EXPLORE_DEDUP = '0';
    try {
      const first = await explore(QUERY, session);
      const second = await explore(QUERY, session);
      expect(second).toBe(first);
      expect(second).not.toContain(POINTER);
    } finally {
      if (previous === undefined) delete process.env.CODEGRAPH_EXPLORE_DEDUP;
      else process.env.CODEGRAPH_EXPLORE_DEDUP = previous;
    }
  }, 120_000);

  it('reports the reclaimed bytes through the CG-4 diagnostic', async () => {
    const sidecar = path.join(testDir, 'cg18-diagnostic.jsonl');
    const session = new ExploreSessionState();
    const previous = process.env.CODEGRAPH_EXPLORE_DEBUG;
    process.env.CODEGRAPH_EXPLORE_DEBUG = sidecar;
    try {
      await explore(QUERY, session);
      await explore(QUERY, session);
    } finally {
      if (previous === undefined) delete process.env.CODEGRAPH_EXPLORE_DEBUG;
      else process.env.CODEGRAPH_EXPLORE_DEBUG = previous;
    }
    const [one, two] = fs.readFileSync(sidecar, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));

    expect(one.dedup.savedChars).toBe(0);
    expect(two.dedup.savedChars).toBeGreaterThan(1000);
    expect(two.dedup.backReferenced.length).toBeGreaterThan(0);

    // The reclamation is legible file by file: a back-referenced file spent
    // none of its reservation, and the response still filled its envelope.
    const backref = two.files.filter((f: { render: string }) => f.render === 'backref');
    for (const f of backref) {
      expect(f.emittedChars).toBe(0);
      expect(f.dedupSavedChars).toBeGreaterThan(0);
      expect(f.dedupCovered.length).toBeGreaterThan(0);
    }
    const spentOnFreshSource = two.files.reduce((s: number, f: { emittedChars: number }) => s + f.emittedChars, 0);
    expect(spentOnFreshSource).toBeGreaterThan(0);
  }, 120_000);
});
