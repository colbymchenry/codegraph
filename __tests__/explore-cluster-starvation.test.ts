/**
 * Regression gate for CLUSTER-LEVEL STARVATION inside one file (task CG-36).
 *
 * A file's ranked clusters used to be all-or-nothing past the first one: the
 * top-ranked cluster was taken (shrunk to fit if it had to be), and every
 * cluster below it was rendered whole and then either fit the remainder or was
 * dropped entirely. On a file whose top-ranked cluster is TRIVIAL that discards
 * the answer — django's `db/models/sql/query.py` kept a 22-line glue cluster and
 * dropped the 624-line `Query` body beneath it, spending 1,923 of a 7,947
 * reservation, and okhttp's `RealInterceptorChain.kt` did the same behind its
 * import header.
 *
 * What makes it hard to see is that the response stays FULL: the unspent
 * reservation carries forward exactly as designed, so a lower-scoring file takes
 * the bytes and every envelope-share measure still looks healthy. The gate is
 * therefore per-file spend, not share.
 *
 * Two fixtures, pulling in opposite directions — read them together:
 *
 *   - `starved-cluster-ts` is the defect. Its answer-bearing cluster must be
 *     SHRUNK into whatever the trivial cluster left, not dropped.
 *   - `dense-header-ts` is the Session.swift shape that cluster ranking puts
 *     importance ahead of density FOR. Its query's methods sit ~200 lines under
 *     a dense property list, and they must keep winning the budget. Any future
 *     rework of selection or shrinking has to satisfy both.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import type { ExploreDiagnosticReport } from '../src/mcp/explore-diagnostics';

interface Run {
  dir: string;
  cg: CodeGraph;
  response: string;
  report: ExploreDiagnosticReport;
}

/** Copy a fixture tree to a temp dir, index it, and run one explore call. */
async function runFixture(fixture: string, query: string): Promise<Run> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cg36-'));
  fs.cpSync(path.join(__dirname, 'fixtures', fixture), dir, { recursive: true });
  fs.rmSync(path.join(dir, '.codegraph'), { recursive: true, force: true });

  const cg = CodeGraph.initSync(dir);
  await cg.indexAll();

  const sidecar = path.join(dir, 'explore-diag.jsonl');
  const previous = process.env.CODEGRAPH_EXPLORE_DEBUG;
  process.env.CODEGRAPH_EXPLORE_DEBUG = sidecar;
  let response: string;
  try {
    response = (await new ToolHandler(cg).execute('codegraph_explore', { query }))
      .content?.[0]?.text ?? '';
  } finally {
    if (previous === undefined) delete process.env.CODEGRAPH_EXPLORE_DEBUG;
    else process.env.CODEGRAPH_EXPLORE_DEBUG = previous;
  }
  const written = fs.readFileSync(sidecar, 'utf-8').trim().split('\n').filter(Boolean);
  return { dir, cg, response, report: JSON.parse(written[written.length - 1]!) };
}

function teardown(run: Run | undefined): void {
  if (!run) return;
  run.cg.destroy();
  if (fs.existsSync(run.dir)) fs.rmSync(run.dir, { recursive: true, force: true });
}

describe('CG-36 — a trivial cluster must not starve the answer-bearing one', () => {
  const TARGET = 'src/pipeline/chain.ts';
  const QUERY = 'how does a request travel from sendRequest to the socket';
  let run: Run;
  let target: ExploreDiagnosticReport['files'][number];

  beforeAll(async () => {
    run = await runFixture('starved-cluster-ts', QUERY);
    target = run.report.files.find((f) => f.path === TARGET)!;
  }, 120_000);

  afterAll(() => teardown(run));

  describe('fixture shape — if this rots, the gate below means nothing', () => {
    it('renders through the cluster path, with the answer past the trivial helper', () => {
      expect(target, `${TARGET} is not among the ranked candidates`).toBeDefined();
      expect(target.render).toBe('clusters');
      // The helper the entry point calls directly, and the class it does not.
      const nodes = run.cg.getNodesInFile(TARGET);
      const helper = nodes.find((n) => n.name === 'describeChain')!;
      const proceed = nodes.find((n) => n.name === 'proceed')!;
      expect(helper).toBeDefined();
      expect(proceed).toBeDefined();
      // Far enough apart to cluster separately at any gap threshold we ship.
      expect(proceed.startLine - helper.endLine).toBeGreaterThan(20);
    });

    it('reserves the file the largest share, so an unspent share is a defect', () => {
      expect(target.allowance ?? 0).toBeGreaterThan(4000);
      const others = run.report.files.filter((f) => f.path !== TARGET);
      for (const f of others) expect(f.allowance ?? 0).toBeLessThan(target.allowance!);
    });
  });

  describe('the gate', () => {
    it('spends most of the reservation it was given', () => {
      // 28.8% on the CG-24 epic tip, 131% (its reservation plus carry-forward
      // slack it can now actually use) with the fix. The bar is deliberately
      // well below both so ordinary budget movement does not fail the suite.
      expect(target.finalChars / target.allowance!).toBeGreaterThan(0.6);
    });

    it('delivers the flow the query asked about, not just the helper beside it', () => {
      // Both ends of the in-file flow, in the cluster that used to be dropped.
      expect(run.response).toContain('async proceed(request: PipelineRequest)');
      expect(run.response).toContain('private async writeAndRead(request: PipelineRequest)');
    });

    it('keeps the response inside the hard ceiling', () => {
      expect(run.report.envelope.chars).toBeLessThanOrEqual(run.report.budget.hardCeiling);
    });
  });
});

describe('CG-36 — a dense declaration block must not bury the query\'s methods', () => {
  const TARGET = 'src/net/session.ts';
  const QUERY = 'how does perform create a URLRequest and start the task';
  let run: Run;
  let target: ExploreDiagnosticReport['files'][number];

  beforeAll(async () => {
    run = await runFixture('dense-header-ts', QUERY);
    target = run.report.files.find((f) => f.path === TARGET)!;
  }, 120_000);

  afterAll(() => teardown(run));

  describe('fixture shape — if this rots, the gate below means nothing', () => {
    it('has a dense low-importance header and the named methods far below it', () => {
      expect(target, `${TARGET} is not among the ranked candidates`).toBeDefined();
      expect(target.render).toBe('clusters');
      const nodes = run.cg.getNodesInFile(TARGET);
      const perform = nodes.find((n) => n.name === 'perform')!;
      expect(perform).toBeDefined();
      // The header block: many adjacent declarations above the first named
      // method, which is what makes it the densest region of the file.
      const above = nodes.filter((n) => n.endLine < perform.startLine
        && (n.kind === 'property' || n.kind === 'field' || n.kind === 'method'));
      expect(above.length).toBeGreaterThan(20);
      expect(perform.startLine).toBeGreaterThan(150);
    });
  });

  describe('the gate', () => {
    it('delivers all three methods the query named', () => {
      expect(run.response).toContain('async perform(url: string, method: string');
      expect(run.response).toContain('didCreateURLRequest(request: URLRequest)');
      expect(run.response).toContain('task(request: URLRequest, identifier: number)');
    });

    it('spends the file\'s reservation on them', () => {
      expect(target.finalChars / target.allowance!).toBeGreaterThan(0.6);
    });

    it('keeps the response inside the hard ceiling', () => {
      expect(run.report.envelope.chars).toBeLessThanOrEqual(run.report.budget.hardCeiling);
    });
  });
});
