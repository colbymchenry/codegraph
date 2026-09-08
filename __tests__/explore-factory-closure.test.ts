/**
 * Regression gate for the FACTORY-CLOSURE file shape (task CG-27).
 *
 * A `createFoo()` that returns an object of closures spans almost all of its
 * file, so its indexed range is an ENVELOPE around every symbol the query
 * actually wants. Svelte 5 rune stores, React custom-hook modules, IIFE
 * module-pattern JS and Zustand's `create((set, get) => ({ … }))` are all
 * written this way, so it is a shape rather than a one-repo quirk.
 *
 * CG-27 asked whether the >50%-of-file envelope drop — which fires for `class`,
 * `struct`, `interface` and friends but not for `function`/`method` — should be
 * extended to cover it. **Measured, it should not**, and the issue was closed as
 * obsolete: `docs/benchmarks/explore-factory-closure-cg27.md` has the numbers.
 * Two independent mechanisms already absorb the shape:
 *
 *   - `shrinkCluster` orders members by (importance desc, SIZE ASC) and refuses
 *     any member that overruns the cap once something is kept, so a file-spanning
 *     member is only ever selected when it is the sole member of the top
 *     importance tier;
 *   - when it IS selected, CG-30 windows it on whole lines rather than emitting
 *     it whole, so the file still delivers bounded, readable source.
 *
 * Dropping the range instead SPLITS the file into several clusters, and only the
 * first-chosen cluster may be shrunk — measured, a trivial 7-line cluster won the
 * density tiebreak and the answer-bearing cluster was dropped whole, taking the
 * rank-#1 file from 7,539 chars and 7 of 11 inner definitions to 397 and none.
 *
 * So this file pins the OUTCOME, not the mechanism: whatever future work does to
 * clustering, a factory-closure file must keep delivering the closures inside it
 * — that is what stops the agent Reading the file back.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import type { ExploreDiagnosticReport } from '../src/mcp/explore-diagnostics';

const FIXTURE_SRC = path.join(__dirname, 'fixtures', 'factory-closure-ts');

/** The factory file, and the closure factory whose body is nearly all of it. */
const TARGET = 'src/stores/dashboard-store.ts';
const FACTORY = 'createDashboardStore';
/** Prose the way a newcomer asks it, naming two of the closures inside. */
const QUERY = 'how does the dashboard store refresh its metrics and apply a filter';

describe('CG-27 — a factory-closure file delivers the closures inside it', () => {
  let testDir: string;
  let cg: CodeGraph;
  let response: string;
  let report: ExploreDiagnosticReport;
  /** Source lines of TARGET the response actually carried. */
  let delivered: Set<number>;
  let sourceLines: string[];

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cg27-'));
    fs.cpSync(FIXTURE_SRC, testDir, { recursive: true });
    fs.rmSync(path.join(testDir, '.codegraph'), { recursive: true, force: true });

    cg = CodeGraph.initSync(testDir);
    await cg.indexAll();

    const sidecar = path.join(testDir, 'explore-diag.jsonl');
    const previous = process.env.CODEGRAPH_EXPLORE_DEBUG;
    process.env.CODEGRAPH_EXPLORE_DEBUG = sidecar;
    try {
      response = (await new ToolHandler(cg).execute('codegraph_explore', { query: QUERY }))
        .content?.[0]?.text ?? '';
    } finally {
      if (previous === undefined) delete process.env.CODEGRAPH_EXPLORE_DEBUG;
      else process.env.CODEGRAPH_EXPLORE_DEBUG = previous;
    }
    const written = fs.readFileSync(sidecar, 'utf-8').trim().split('\n').filter(Boolean);
    report = JSON.parse(written[written.length - 1]!) as ExploreDiagnosticReport;

    // A line counts as delivered only when the response numbers it AND the text
    // matches that source line — a line number quoted in prose must not count.
    sourceLines = fs.readFileSync(path.join(testDir, TARGET), 'utf-8').split('\n');
    delivered = new Set();
    for (const line of response.split('\n')) {
      const m = /^(\d+)\t(.*)$/.exec(line);
      if (!m) continue;
      const n = Number(m[1]);
      if (n >= 1 && n <= sourceLines.length && sourceLines[n - 1] === m[2]) delivered.add(n);
    }
  }, 120_000);

  afterAll(() => {
    if (cg) cg.destroy();
    if (testDir && fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  /** The closures defined inside the factory, straight from the index. */
  const innerClosures = () => {
    const nodes = cg.getNodesInFile(TARGET);
    const factory = nodes.find((n) => n.name === FACTORY)!;
    return nodes.filter((n) => (n.kind === 'function' || n.kind === 'method')
      && n.name !== FACTORY
      && n.startLine > factory.startLine && n.endLine <= factory.endLine);
  };

  describe('fixture shape — if this rots, the gate below means nothing', () => {
    it('holds one symbol spanning most of the file, with closures inside it', () => {
      const factory = cg.getNodesInFile(TARGET).find((n) => n.name === FACTORY);
      expect(factory, `${TARGET} has no ${FACTORY} node`).toBeDefined();
      // The envelope condition the >50% drop tests for — and `function`, the kind
      // that drop does not cover.
      expect(factory!.kind).toBe('function');
      expect(factory!.endLine - factory!.startLine + 1)
        .toBeGreaterThan(sourceLines.length * 0.5);
      expect(innerClosures().length).toBeGreaterThanOrEqual(8);
    });

    it('is too long to ship whole, so it renders through the cluster path', () => {
      // Past WHOLE_FILE_MAX_LINES (220 for a non-central file): the whole-file
      // grace and buy arms cannot claim it, so the envelope actually matters.
      expect(sourceLines.length).toBeGreaterThan(220);
      expect(report.files.find((f) => f.path === TARGET)?.render).toBe('clusters');
    });
  });

  describe('the gate', () => {
    it('delivers the closures the query named, not just the factory head', () => {
      const inner = innerClosures();
      for (const name of ['refreshMetrics', 'applyFilter']) {
        const node = inner.find((n) => n.name === name)!;
        expect(node, `${name} is not an inner closure any more`).toBeDefined();
        expect(delivered.has(node.startLine), `${name} definition line not delivered`).toBe(true);
      }
    });

    it('delivers most of the closures, spread across the file', () => {
      const inner = innerClosures();
      const hit = inner.filter((n) => delivered.has(n.startLine));
      // Measured on the `feature/CG-24` tip: 7 of 11. The bar is half, so ordinary
      // budget movement does not fail the suite, but losing the closures does.
      expect(hit.length).toBeGreaterThanOrEqual(Math.ceil(inner.length / 2));
      // Not one contiguous head window off the top of the factory: the whole
      // point is that selection reaches symbols deep in the body.
      const last = inner[inner.length - 1]!;
      const deepest = Math.max(...hit.map((n) => n.startLine));
      expect(deepest).toBeGreaterThan((last.startLine + inner[0]!.startLine) / 2);
    });

    it('never renders an empty section for the file', () => {
      const rec = report.files.find((f) => f.path === TARGET)!;
      expect(rec.emittedChars).toBeGreaterThan(0);
      expect(delivered.size).toBeGreaterThan(20);
    });

    it('keeps the response inside the hard ceiling', () => {
      expect(report.envelope.chars).toBeLessThanOrEqual(report.budget.hardCeiling);
    });
  });
});
