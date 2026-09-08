/**
 * Regression fixture for CG-26 — the end-to-end reservation invariant.
 *
 *   Every admitted file receives at least its reservation before any file draws
 *   on carry-forward slack.
 *
 * CG-30 bounded how far an oversize cluster member may overshoot and CG-31 gave
 * the cluster path a displacement guard. This pins the invariant they jointly
 * satisfy across EVERY render path — cluster, whole-file grace, whole-file BUY —
 * and in BOTH directions: the top-ranked file when the files below it overspend,
 * and an admitted lower-ranked file when the top one does.
 *
 * Two things CG-26 fixed are pinned here because nothing else can see them:
 *
 *   - The whole-file arms were fit-tested against raw room before the ceiling,
 *     never against what was still owed below. A grace-sized file could take a
 *     pending file's reservation on its way to the ceiling; okhttp's
 *     `CallServerInterceptor.kt` shipped 8,499 chars on a 5,964 funded ceiling
 *     and the rank-6 file below it delivered nothing.
 *   - Every section was charged a flat 200 chars of overhead while a real header
 *     runs 300–500. The loop believed it had room it did not have (okhttp
 *     rendered 26,601 chars against a 24,400 ceiling), so the final truncation
 *     threw a fully-rendered section away — the same starvation, arriving after
 *     the guard had done its work.
 *
 * Shares the `displacement-ts` fixture: four pipeline stages competing for one
 * envelope, the first a single ~20K function, padded past 500 indexed files so
 * the response sits on the 24K tier where reservations genuinely saturate the
 * ceiling.
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
const FILLER_FILES = 520;

/** The giant: one ~20K function. Ranks #1 under the spread query. */
const GIANT = 'src/pipeline/ingest.ts';

/**
 * Three shapes, so the invariant is tested from both sides:
 *   spread   — every stage named; the giant ranks #1 and overspends downwards.
 *   tail     — the stages BELOW the giant named; something small ranks #1 while
 *              the giant competes from underneath. This is the direction CG-31's
 *              fixture could not reach.
 *   precise  — one symbol. The concentration case the guard must not flatten.
 */
const QUERIES = {
  spread: 'ingestRecords normalizeRecords enrichRecords publishRecords',
  tail: 'publishRecords sinkRecord PipelineRecord ingestRecords',
  precise: 'ingestRecords',
} as const;
type Shape = keyof typeof QUERIES;

interface Probe {
  response: string;
  report: ExploreDiagnosticReport;
  bytes: Map<string, number>;
}

describe('CG-26 — no admitted file is starved, on any render path', () => {
  let testDir: string;
  let cg: CodeGraph;
  const probes = {} as Record<Shape, Probe>;

  /** Admitted = the allocator reserved bytes for it. */
  const admitted = (probe: Probe): ExploreDiagnosticFile[] =>
    probe.report.files.filter((f) => (f.allowance ?? 0) > 0);
  const all = (): Probe[] => Object.values(probes);

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cg26-'));
    fs.cpSync(FIXTURE_SRC, testDir, { recursive: true });
    fs.rmSync(path.join(testDir, '.codegraph'), { recursive: true, force: true });

    const filler = path.join(testDir, 'src', 'generated');
    fs.mkdirSync(filler, { recursive: true });
    for (let i = 0; i < FILLER_FILES; i++) {
      fs.writeFileSync(
        path.join(filler, `unit${i}.ts`),
        `export const seed${i} = ${i};\n`
        + `export function widget${i}(n: number): number {\n  return n * ${i + 1} + seed${i};\n}\n`,
      );
    }

    cg = CodeGraph.initSync(testDir);
    await cg.indexAll();

    const sidecar = path.join(testDir, 'explore-diag.jsonl');
    const previous = process.env.CODEGRAPH_EXPLORE_DEBUG;
    process.env.CODEGRAPH_EXPLORE_DEBUG = sidecar;
    try {
      const handler = new ToolHandler(cg);
      for (const [shape, query] of Object.entries(QUERIES) as [Shape, string][]) {
        const result = await handler.execute('codegraph_explore', { query });
        const response = result.content?.[0]?.text ?? '';
        const written = fs.readFileSync(sidecar, 'utf-8').trim().split('\n').filter(Boolean);
        probes[shape] = {
          response,
          report: JSON.parse(written[written.length - 1]!) as ExploreDiagnosticReport,
          bytes: attributeSourceBytes(response),
        };
      }
    } finally {
      if (previous === undefined) delete process.env.CODEGRAPH_EXPLORE_DEBUG;
      else process.env.CODEGRAPH_EXPLORE_DEBUG = previous;
    }
  }, 180_000);

  afterAll(() => {
    if (cg) cg.destroy();
    if (testDir && fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  // ── Fixture shape — if these rot, the gates below mean nothing ─────────────

  describe('fixture shape', () => {
    it('sits on the 24K tier, where the reservations saturate the ceiling', () => {
      expect(cg.getStats().fileCount).toBeGreaterThanOrEqual(500);
      for (const probe of all()) expect(probe.report.budget.maxOutputChars).toBe(24000);
    });

    it('exercises both directions — the giant ranks #1 in one shape and lower in another', () => {
      // Which shape puts it where is the ranker's business and may move; that
      // it lands on BOTH sides across the three is what makes the gates below
      // test the invariant rather than one arrangement of it.
      const ranks = all().map((p) => p.report.files.find((f) => f.path === GIANT)?.rank ?? -1);
      expect(ranks).toContain(1);
      expect(ranks.some((r) => r > 1)).toBe(true);
    });

    it('exercises both render paths — something ships whole, something clusters', () => {
      const modes = new Set(all().flatMap((p) => p.report.files.map((f) => f.render)));
      expect(modes).toContain('clusters');
      expect(modes).toContain('whole');
    });
  });

  // ── The invariant ─────────────────────────────────────────────────────────

  describe('the reservation invariant', () => {
    it('CG-26 GATE: no file on ANY render path emits past what was still free', () => {
      // CG-31 pinned this for `clusters` only. The whole-file arms were fit-
      // tested against `renderCeiling - totalChars`, which is everyone's room,
      // not this file's — so a whole render could spend a reservation the loop
      // had already promised further down.
      for (const [shape, probe] of Object.entries(probes) as [Shape, Probe][]) {
        const over = probe.report.files
          .filter((f) => f.render !== null && f.render !== 'dropped' && f.funded !== null)
          // +1 for the render loop's own rounding on a windowed cut.
          .filter((f) => f.emittedChars > f.funded! + 1)
          .map((f) => `${shape}/${f.path}: ${f.emittedChars} emitted of ${f.funded} funded (${f.render})`);
        expect(over).toEqual([]);
      }
    });

    it('CG-26 GATE: every admitted file is delivered, whatever its rank', () => {
      for (const [shape, probe] of Object.entries(probes) as [Shape, Probe][]) {
        for (const rec of admitted(probe)) {
          expect(rec.skipped, `${shape}/${rec.path} skipped`).toBeNull();
          expect(probe.bytes.get(rec.path) ?? 0, `${shape}/${rec.path} bytes`).toBeGreaterThan(0);
        }
      }
    });

    it('CG-26 GATE: the rank-#1 file gets its reservation even when a file below overspends', () => {
      // The direction CG-31's fixture could not reach: under `tail` the giant
      // ranks below a small file and draws far past its own reservation from
      // carry-forward slack. Rank #1 must still receive what it was promised
      // (or its whole file, if that is less).
      for (const [shape, probe] of Object.entries(probes) as [Shape, Probe][]) {
        const top = admitted(probe).sort((a, b) => a.rank - b.rank)[0];
        if (!top) continue;
        const onDisk = fs.statSync(path.join(testDir, top.path)).size;
        expect(probe.bytes.get(top.path) ?? 0, `${shape}/${top.path}`)
          .toBeGreaterThanOrEqual(Math.min(top.allowance!, onDisk) * 0.9);
      }
    });

    it('and the gate above is not vacuous — a lower-ranked file does overspend', () => {
      const overspenders = (probe: Probe) => admitted(probe)
        .filter((f) => f.rank > 1 && f.emittedChars > f.allowance!);
      expect(overspenders(probes.tail).length).toBeGreaterThan(0);
    });
  });

  // ── What the ceiling must no longer do ────────────────────────────────────

  describe('the hard ceiling never throws a rendered section away', () => {
    it('the render loop spends what it counts — nothing is allocated past the ceiling', () => {
      // Sections used to be charged a flat 200 chars against a header that runs
      // 300–500, so the loop over-filled and the final truncation dropped whole
      // sections. `allocatedChars` is the pre-truncation length: it staying
      // under the ceiling IS the accounting being exact.
      for (const [shape, probe] of Object.entries(probes) as [Shape, Probe][]) {
        expect(probe.report.envelope.allocatedChars, shape)
          .toBeLessThanOrEqual(probe.report.budget.hardCeiling);
        expect(probe.report.envelope.truncated, shape).toBe(false);
      }
    });

    it('no file is rendered and then dropped', () => {
      for (const probe of all()) {
        expect(probe.report.files.filter((f) => f.render === 'dropped')).toEqual([]);
      }
    });

    it('keeps the response inside the hard ceiling', () => {
      for (const probe of all()) {
        expect(probe.report.envelope.chars).toBeLessThanOrEqual(probe.report.budget.hardCeiling);
      }
    });
  });

  // ── The epilogue is budgeted, not discarded ───────────────────────────────

  describe('the epilogue the loop budgeted for is the epilogue it emits', () => {
    it('a response that withheld files still says so, and says to explore not Read', () => {
      // The flat 600-char margin was neither the epilogue's size nor a bound on
      // it, so a saturated response shipped with no pointer list and no
      // reminders at all. Whatever else is traded away, the agent must be told
      // an uncovered area exists and that another explore reaches it.
      for (const [shape, probe] of Object.entries(probes) as [Shape, Probe][]) {
        const withheld = probe.report.files.some(
          (f) => f.render === null || (probe.bytes.get(f.path) ?? 0) === 0);
        if (!withheld) continue;
        expect(
          /Not shown above|omitted for size|codegraph_explore/.test(probe.response),
          `${shape} withheld files without saying where to look`,
        ).toBe(true);
      }
    });

    it('never steers the agent to Read', () => {
      for (const probe of all()) {
        expect(/use (the )?Read|fall back to Read(?!ing those files)/i.test(probe.response)).toBe(false);
      }
    });
  });

  // ── The thing the invariant must NOT become ───────────────────────────────

  describe('concentration survives', () => {
    it('a precise symbol query still puts the most source in the named file', () => {
      const mine = probes.precise.bytes.get(GIANT) ?? 0;
      expect(mine).toBeGreaterThan(0);
      for (const [p, n] of probes.precise.bytes) {
        if (p === GIANT) continue;
        expect(mine, `${GIANT} vs ${p}`).toBeGreaterThan(n);
      }
    });

    it('is not an even split — the named file outspends its equal share', () => {
      const rec = probes.precise.report.files.find((f) => f.path === GIANT)!;
      const even = probes.precise.report.budget.maxOutputChars / admitted(probes.precise).length;
      expect(rec.emittedChars).toBeGreaterThan(even);
    });
  });
});
