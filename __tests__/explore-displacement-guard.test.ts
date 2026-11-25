/**
 * Regression fixture for CG-31 — a clustered render may not spend a reservation
 * still owed to a file the loop has not reached.
 *
 * The allocator hands every admitted file a reservation (CG-12), and the render
 * loop then walks the files in rank order. Carry-forward slack lets a file spend
 * what the files ABOVE it left on the table, which is right; what was missing is
 * the other half — nothing was held back for the files BELOW it. The whole-file
 * BUY arm has always refused that trade (`owedBelow`, `tools.ts`); the cluster
 * path had no equivalent, so `fileBudget`/`SPINE_CEILING` read what was left
 * before the hard ceiling rather than what was still promised, and the first
 * oversize file could take the response.
 *
 * `__tests__/fixtures/displacement-ts/` reproduces it. Four pipeline stages
 * compete for one envelope; the first, `ingest.ts`, is a single ~20K function —
 * one cluster member far bigger than any reservation it can earn — so it takes
 * the bounded overshoot CG-30 left it. The fixture is padded to >500 indexed
 * files on purpose: the displacement only exists on the 24K tier, where the
 * reservations plus the response preamble genuinely saturate the hard ceiling.
 *
 * Measured against the pre-fix build (CG-30 landed, CG-31 not):
 *
 *   ingest.ts     9,301 chars emitted on a 6,289 spendable — then dropped whole
 *                 by the final ceiling, so it cost the response and delivered 0
 *   types.ts      skipped `budget-whole-file`
 *   sink.ts       skipped `budget-whole-file`
 *   delivered     3 of 6 admitted files, 14,908-char envelope
 *
 * With the guard: 6 of 6, 22,066-char envelope, and `ingest.ts` bounded to the
 * 4,913 that were actually still free.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import { attributeSourceBytes } from '../src/mcp/explore-diagnostics';
import type { ExploreDiagnosticReport, ExploreDiagnosticFile } from '../src/mcp/explore-diagnostics';

const FIXTURE_SRC = path.join(__dirname, 'fixtures', 'displacement-ts');

/**
 * Padding modules, written into the temp copy rather than checked in. The
 * output tier is chosen by INDEXED FILE COUNT, and the displacement this test
 * pins only exists at >=500 files (24K envelope against a 24.4K render ceiling
 * that also has to hold the response preamble). Below that the ceiling has
 * enough slack to absorb an overshoot and the bug is invisible.
 */
const FILLER_FILES = 520;

/** A symbol bag spanning all four stages — they compete for one envelope. */
const QUERY = 'ingestRecords normalizeRecords enrichRecords publishRecords';
/** One symbol, one file — the concentration case the guard must not flatten. */
const PRECISE_QUERY = 'ingestRecords';

/** The giant: one ~20K function, the file that used to take the response. */
const GIANT = 'src/pipeline/ingest.ts';
/** Ranked below the giant and dropped by it pre-fix. */
const STARVED = ['src/pipeline/types.ts', 'src/pipeline/sink.ts'];

interface Probe {
  response: string;
  report: ExploreDiagnosticReport;
  bytes: Map<string, number>;
}

describe('CG-31 — the cluster path holds back what is still owed below it', () => {
  let testDir: string;
  let cg: CodeGraph;
  let spread: Probe;
  let precise: Probe;

  const fileOf = (probe: Probe, p: string): ExploreDiagnosticFile => {
    const rec = probe.report.files.find((f) => f.path === p);
    if (!rec) throw new Error(`${p} absent from the diagnostic report`);
    return rec;
  };
  /** Admitted = the allocator reserved bytes for it. */
  const admitted = (probe: Probe): ExploreDiagnosticFile[] =>
    probe.report.files.filter((f) => (f.allowance ?? 0) > 0);

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cg31-'));
    fs.cpSync(FIXTURE_SRC, testDir, { recursive: true });
    fs.rmSync(path.join(testDir, '.codegraph'), { recursive: true, force: true });

    const filler = path.join(testDir, 'src', 'generated');
    fs.mkdirSync(filler, { recursive: true });
    for (let i = 0; i < FILLER_FILES; i++) {
      // Deterministic, unrelated to the query — these pad the file count, they
      // must never rank.
      fs.writeFileSync(
        path.join(filler, `unit${i}.ts`),
        `export const seed${i} = ${i};\n`
        + `export function widget${i}(n: number): number {\n  return n * ${i + 1} + seed${i};\n}\n`,
      );
    }

    cg = CodeGraph.initSync(testDir);
    await cg.indexAll();

    // The per-file bounds are only observable through the diagnostic sidecar.
    const sidecar = path.join(testDir, 'explore-diag.jsonl');
    const previous = process.env.CODEGRAPH_EXPLORE_DEBUG;
    process.env.CODEGRAPH_EXPLORE_DEBUG = sidecar;
    const run = async (handler: ToolHandler, query: string): Promise<Probe> => {
      const result = await handler.execute('codegraph_explore', { query });
      const response = result.content?.[0]?.text ?? '';
      const written = fs.readFileSync(sidecar, 'utf-8').trim().split('\n').filter(Boolean);
      return {
        response,
        report: JSON.parse(written[written.length - 1]!) as ExploreDiagnosticReport,
        bytes: attributeSourceBytes(response),
      };
    };
    try {
      const handler = new ToolHandler(cg);
      spread = await run(handler, QUERY);
      precise = await run(handler, PRECISE_QUERY);
    } finally {
      if (previous === undefined) delete process.env.CODEGRAPH_EXPLORE_DEBUG;
      else process.env.CODEGRAPH_EXPLORE_DEBUG = previous;
    }
  }, 180_000);

  afterAll(() => {
    if (cg) cg.destroy();
    if (testDir && fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  // ── Fixture shape — if these rot, the gate below means nothing ─────────────

  describe('fixture shape', () => {
    it('sits on the 24K tier, where the reservations saturate the ceiling', () => {
      expect(cg.getStats().fileCount).toBeGreaterThanOrEqual(500);
      expect(spread.report.budget.maxOutputChars).toBe(24000);
    });

    it('admits every stage file, so there is something to displace', () => {
      const paths = admitted(spread).map((f) => f.path);
      expect(paths).toContain(GIANT);
      for (const p of STARVED) expect(paths).toContain(p);
      expect(paths.length).toBeGreaterThanOrEqual(5);
    });

    it('renders the giant through the CLUSTER path, over its reservation', () => {
      const rec = fileOf(spread, GIANT);
      expect(rec.render).toBe('clusters');
      // One member bigger than anything it can earn beside its siblings — the
      // shape that makes the bounded overshoot fire at all.
      const source = fs.readFileSync(path.join(testDir, GIANT), 'utf-8');
      expect(source.length).toBeGreaterThan((rec.spendable ?? 0) * 2);
      // And the guard actually bit — a vacuous pass here would hide a
      // regression. Measured against the bounded overshoot a cluster's top
      // member may otherwise take (1.5x, CG-30), which is what it refused.
      expect(rec.funded).not.toBeNull();
      expect(rec.funded!).toBeLessThan(Math.round(rec.spendable! * 1.5));
    });
  });

  // ── The gate ──────────────────────────────────────────────────────────────

  describe('displacement refusal', () => {
    it('CG-31 GATE: no clustered file emits past what was still free to spend', () => {
      for (const probe of [spread, precise]) {
        const over = probe.report.files
          .filter((f) => f.render === 'clusters' && f.funded !== null)
          // +1 for the render loop's own rounding on the windowed cut.
          .filter((f) => f.emittedChars > f.funded! + 1)
          .map((f) => `${f.path}: ${f.emittedChars} of ${f.funded}`);
        expect(over).toEqual([]);
      }
    });

    it('CG-31 GATE: every admitted file below the top one is delivered', () => {
      // Pre-fix: 3 of 6 — `ingest.ts` overshot, was itself cut by the final
      // ceiling, and took `types.ts` + `sink.ts` down with it.
      for (const rec of admitted(spread)) {
        expect(rec.skipped, `${rec.path} skipped`).toBeNull();
        expect(spread.bytes.get(rec.path) ?? 0, `${rec.path} bytes`).toBeGreaterThan(0);
      }
      for (const p of STARVED) expect(spread.bytes.get(p) ?? 0).toBeGreaterThan(0);
    });

    it('the guard is symmetric — it is about ORDER, not rank', () => {
      // Nothing here protects rank #1 specifically: the LAST admitted file, the
      // only one with no reservation owed below it, is delivered too.
      const files = admitted(spread);
      const last = files[files.length - 1]!;
      expect(last.skipped).toBeNull();
      expect(spread.bytes.get(last.path) ?? 0).toBeGreaterThan(0);
      // And the last file is never itself cut by the guard — nothing is owed
      // below it, so `funded` may not sit under its own reservation.
      expect(last.funded!).toBeGreaterThanOrEqual(Math.min(last.allowance!, last.emittedChars));
    });

    it('a kept promise is not a displacement — no file is cut below its reservation', () => {
      for (const probe of [spread, precise]) {
        for (const rec of admitted(probe)) {
          if (rec.funded === null) continue;
          expect(rec.funded, rec.path).toBeGreaterThanOrEqual(
            Math.min(rec.allowance!, rec.emittedChars));
        }
      }
    });

    it('nothing is lost to the hard ceiling — the epilogue is cut before a section', () => {
      // A section thrown away by the final truncation is the same starvation
      // arriving after the guard has done its work: the bytes were held back
      // for that file and then nobody received them.
      for (const probe of [spread, precise]) {
        expect(probe.report.files.filter((f) => f.render === 'dropped')).toEqual([]);
      }
    });

    it('keeps the response inside the hard ceiling', () => {
      for (const probe of [spread, precise]) {
        expect(probe.report.envelope.chars).toBeLessThanOrEqual(probe.report.budget.hardCeiling);
      }
    });
  });

  // ── The thing the guard must NOT become ───────────────────────────────────

  describe('concentration survives', () => {
    it('a precise symbol query still puts the most source in the named file', () => {
      const mine = precise.bytes.get(GIANT) ?? 0;
      const others = [...precise.bytes.entries()].filter(([p]) => p !== GIANT);
      expect(mine).toBeGreaterThan(0);
      for (const [p, n] of others) {
        expect(mine, `${GIANT} vs ${p}`).toBeGreaterThan(n);
      }
      // Not a forced even split: the named file takes a clear plurality.
      const total = [...precise.bytes.values()].reduce((s, n) => s + n, 0);
      expect(mine / total).toBeGreaterThan(1 / precise.bytes.size);
    });

    it('the named file still outspends what it would get from an even split', () => {
      const rec = fileOf(precise, GIANT);
      const even = precise.report.budget.maxOutputChars / admitted(precise).length;
      expect(rec.emittedChars).toBeGreaterThan(even);
    });
  });
});
