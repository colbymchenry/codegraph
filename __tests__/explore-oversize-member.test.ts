/**
 * Regression fixture for CG-30 — a cluster's top member may not overshoot the
 * file's budget without bound.
 *
 * `shrinkCluster` keeps the highest-importance member of an oversize cluster
 * WHOLE, deliberately: an empty file section sends the agent to Read, which is
 * the outcome explore exists to prevent. What it lacked was a bound. On the
 * originating repo one file emitted 22,376 chars against a 9,181-char
 * reservation — 2.44x — past both the per-file budget and the spine ceiling,
 * because its top member alone was that big. The overshoot is what collapses
 * `headroom` for every file ranked below it (CG-31), and it has a second face:
 * a member too big for the whole response ceiling makes the file drop out
 * entirely rather than render short.
 *
 * `__tests__/fixtures/oversize-member-ts/` reproduces both permanently. Three
 * report builders compete for one envelope, each a single long function far
 * bigger than any reservation it can earn beside its siblings. Measured against
 * the pre-fix build, this fixture produced:
 *
 *   monthly.ts    12,391 chars emitted on a 3,334 budget  (3.7x)
 *   quarterly.ts  dropped entirely — no headroom left     (the CG-31 half)
 *
 * The gate below is that both are now bounded AND delivered: the bound cuts the
 * overshoot, and cutting the overshoot is what buys back the starved file.
 *
 * Measured against `spendable`, not `reserved`: the render paths bound
 * themselves by the reservation PLUS whatever slack the files above left on the
 * table, so a file legitimately spending inherited slack is not an overshoot.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import { attributeSourceBytes } from '../src/mcp/explore-diagnostics';
import type { ExploreDiagnosticReport, ExploreDiagnosticFile } from '../src/mcp/explore-diagnostics';

const FIXTURE_SRC = path.join(__dirname, 'fixtures', 'oversize-member-ts');

/** A symbol bag spanning the three builders — the sibling files compete. */
const QUERY = 'buildMonthlyReport buildWeeklyReport buildQuarterlyReport formatReportRow persistReport';

/** The giant: one ~24K function, far past the whole-response ceiling. */
const GIANT = 'src/report/monthly.ts';
/** Mid-size: one ~11K function — the file the giant's overshoot used to starve. */
const STARVED = 'src/report/quarterly.ts';

/** The bound: 1.5x, the same multiple the spine ceiling already draws. */
const OVERSHOOT_FACTOR = 1.5;

describe('CG-30 — an oversize cluster member is bounded, not unbounded', () => {
  let testDir: string;
  let cg: CodeGraph;
  let response: string;
  let report: ExploreDiagnosticReport;
  let bytes: Map<string, number>;

  const fileOf = (p: string): ExploreDiagnosticFile => {
    const rec = report.files.find((f) => f.path === p);
    if (!rec) throw new Error(`${p} absent from the diagnostic report`);
    return rec;
  };
  /** What the render paths actually bound themselves by. */
  const budgetOf = (rec: ExploreDiagnosticFile): number => rec.spendable ?? rec.allowance ?? 0;

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cg30-'));
    fs.cpSync(FIXTURE_SRC, testDir, { recursive: true });
    fs.rmSync(path.join(testDir, '.codegraph'), { recursive: true, force: true });

    cg = CodeGraph.initSync(testDir);
    await cg.indexAll();

    // The per-file budget is only observable through the diagnostic sidecar, and
    // the whole gate is "emitted vs what the file was allowed to spend".
    const sidecar = path.join(testDir, 'explore-diag.jsonl');
    const previous = process.env.CODEGRAPH_EXPLORE_DEBUG;
    process.env.CODEGRAPH_EXPLORE_DEBUG = sidecar;
    try {
      const handler = new ToolHandler(cg);
      const result = await handler.execute('codegraph_explore', { query: QUERY });
      response = result.content?.[0]?.text ?? '';
    } finally {
      if (previous === undefined) delete process.env.CODEGRAPH_EXPLORE_DEBUG;
      else process.env.CODEGRAPH_EXPLORE_DEBUG = previous;
    }
    const written = fs.readFileSync(sidecar, 'utf-8').trim().split('\n').filter(Boolean);
    report = JSON.parse(written[written.length - 1]!) as ExploreDiagnosticReport;
    bytes = attributeSourceBytes(response);
  }, 120_000);

  afterAll(() => {
    if (cg) cg.destroy();
    if (testDir && fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  // ── Fixture shape — if these rot, the gate below means nothing ─────────────

  describe('fixture shape', () => {
    it('holds single members far bigger than any budget they can earn', () => {
      for (const file of [GIANT, STARVED]) {
        const source = fs.readFileSync(path.join(testDir, file), 'utf-8');
        const top = cg.getNodesInFile(file)
          .filter((n) => n.kind === 'function')
          .sort((a, b) => (b.endLine - b.startLine) - (a.endLine - a.startLine))[0];
        expect(top, `${file} has no function node`).toBeDefined();
        // One symbol, most of the file — the "top member alone is oversize" shape.
        expect(top!.endLine - top!.startLine).toBeGreaterThan(180);
        expect(source.length).toBeGreaterThan(budgetOf(fileOf(file)) * 2);
      }
    });

    it('is too long to ship whole, so both render through the cluster path', () => {
      for (const file of [GIANT, STARVED]) {
        const lineCount = fs.readFileSync(path.join(testDir, file), 'utf-8').split('\n').length;
        // Past WHOLE_FILE_MAX_LINES (220 for a non-central file), so the
        // whole-file paths — grace and buy — cannot claim it.
        expect(lineCount, file).toBeGreaterThan(220);
        expect(fileOf(file).render, file).toBe('clusters');
      }
    });
  });

  // ── The gate ──────────────────────────────────────────────────────────────

  describe('bounded overshoot', () => {
    it('CG-30 GATE: the giant no longer emits a multiple of its budget', () => {
      const rec = fileOf(GIANT);
      // Pre-fix this file emitted 12,391 on a 3,334 budget (3.7x).
      expect(rec.emittedChars).toBeLessThanOrEqual(
        Math.round(budgetOf(rec) * OVERSHOOT_FACTOR) + 1);
    });

    it('CG-30 GATE: no clustered file emits past 1.5x what it may spend', () => {
      const over = report.files
        .filter((f) => f.render === 'clusters' && budgetOf(f) > 0)
        .filter((f) => f.emittedChars > Math.round(budgetOf(f) * OVERSHOOT_FACTOR) + 1)
        .map((f) => `${f.path}: ${f.emittedChars} of ${budgetOf(f)}`);
      expect(over).toEqual([]);
    });

    it('CG-31: the file the overshoot used to starve is delivered', () => {
      // Pre-fix: dropped with skip reason `budget-clusters` — the giant above it
      // had already spent the headroom this file needed.
      expect(fileOf(STARVED).skipped).toBeNull();
      expect(bytes.get(STARVED) ?? 0).toBeGreaterThan(0);
    });

    it('never emits an empty section — the invariant the old rule protected', () => {
      for (const rec of report.files) {
        if (rec.render !== 'clusters') continue;
        expect(rec.emittedChars, rec.path).toBeGreaterThan(0);
      }
      // And the windowed file still leads with the symbol the query named.
      expect(response).toContain('export function buildMonthlyReport');
    });

    it('cuts on whole lines — a body is never sliced mid-line', () => {
      const source = fs.readFileSync(path.join(testDir, GIANT), 'utf-8').split('\n');
      const numbered = response
        .split('\n')
        .map((l) => /^(\d+)\t(.*)$/.exec(l))
        .filter((m): m is RegExpExecArray => m !== null)
        .filter((m) => Number(m[1]) >= 1 && Number(m[1]) <= source.length);
      const matching = numbered.filter((m) => source[Number(m[1]) - 1] === m[2]);
      // Every line the response numbers for this file is that whole source line.
      expect(matching.length).toBeGreaterThan(20);
    });

    it('reports the cut rather than presenting a window as the whole file', () => {
      expect(fileOf(GIANT).clipped).toBe(true);
    });

    it('keeps the response inside the hard ceiling', () => {
      expect(report.envelope.chars).toBeLessThanOrEqual(report.budget.hardCeiling);
    });
  });
});
