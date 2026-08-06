/**
 * Score-proportional explore allocation, end to end (CG-14 / epic CG-1 / #1500).
 *
 * `explore-proportional-allocation.test.ts` pins `allocateExploreBudget` in
 * isolation; `explore-allocation-1500.test.ts` pins the reporter's Go shape.
 * What is left — and what this file owns — is everything the allocator only
 * *promises*: the render loop has to spend those reservations, the hard ceiling
 * has to catch the overshoot, and a degenerate or diffuse result set has to come
 * back usable rather than empty. Each of those is invisible to a unit test,
 * because the failure mode is not an exception — it is a response the agent
 * quietly abandons in favour of Read.
 *
 * Two halves:
 *
 *  1. **The self-query fixture's shape.** CG-6 declared a second regression
 *     fixture beside payroll-go: this repo, asked "how does explore allocate its
 *     output budget across files", spending 63% of its envelope on
 *     `scripts/agent-eval/*.mjs` files that merely mention `explore` and
 *     `BUDGET`, while `src/mcp/tools.ts` — the file that actually answers — sat
 *     clipped at the flat `maxCharsPerFile`. That fixture reads THIS repo's live
 *     index, so it belongs to the out-of-band probe
 *     (`node scripts/agent-eval/probe-allocation.mjs self-query`) where its
 *     numbers can move with the repo. Reproduced here as a synthetic project so
 *     `npm test` owns the MECHANISM deterministically: a large relevant file, a
 *     small genuinely-relevant helper, and an incidental name-collision script.
 *
 *  2. **Degenerate and diffuse result sets.** One file, no files, all files
 *     scoring alike, a survey question. The proportional split divides by a total
 *     weight and concentrates on a leader — both of which have a degenerate case
 *     that ends in a division by zero or a starved response.
 *
 * Nothing here is platform-gated: fixtures are written through `path.join`, and
 * every path ASSERTED against is an indexed relative path, which extraction
 * normalizes to forward slashes on every platform (`normalizePath`, utils.ts).
 * A literal like `src/mcp/allocator.ts` is therefore correct on Windows too —
 * gate a new assertion with `it.runIf` only if it reaches for a real filesystem
 * path or a platform-specific separator.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler, getExploreOutputBudget, EXPLORE_ALLOCATION } from '../src/mcp/tools';
import { attributeSourceBytes } from '../src/mcp/explore-diagnostics';
import type { ExploreDiagnosticReport } from '../src/mcp/explore-diagnostics';

/** The host's inline tool-result limit — above it the response is externalized. */
const INLINE_CAP = 25000;

const DEBUG_ENV = 'CODEGRAPH_EXPLORE_DEBUG';

interface Project {
  dir: string;
  cg: CodeGraph;
  handler: ToolHandler;
}

/** Build + index a throwaway project from a `{ relPath: source }` map. */
async function buildProject(prefix: string, files: Record<string, string>): Promise<Project> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body.trimStart());
  }
  const cg = CodeGraph.initSync(dir);
  await cg.indexAll();
  return { dir, cg, handler: new ToolHandler(cg) };
}

function destroyProject(project?: Project): void {
  if (!project) return;
  project.cg.destroy();
  if (fs.existsSync(project.dir)) fs.rmSync(project.dir, { recursive: true, force: true });
}

/**
 * One explore call, reduced to what the allocation assertions need — plus the
 * CG-4 per-file diagnostic, which is where the SCORE and the RESERVATION live.
 * The instrument is observational (byte-identical output either way), so reading
 * it here measures the same response the agent would have received.
 */
async function explore(project: Project, query: string) {
  // Outside the project root on purpose: a sidecar written INTO the indexed tree
  // is a new file the watcher can pick up mid-suite.
  const sidecar = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-alloc-diag-')), 'report.jsonl');
  const previous = process.env[DEBUG_ENV];
  process.env[DEBUG_ENV] = sidecar;
  let result;
  try {
    result = await project.handler.execute('codegraph_explore', { query });
  } finally {
    if (previous === undefined) delete process.env[DEBUG_ENV];
    else process.env[DEBUG_ENV] = previous;
  }
  const text = result.content?.[0]?.text ?? '';
  const bytes = attributeSourceBytes(text);
  const lines = fs.existsSync(sidecar)
    ? fs.readFileSync(sidecar, 'utf-8').trim().split('\n').filter(Boolean)
    : [];
  const report = JSON.parse(lines[lines.length - 1]!) as ExploreDiagnosticReport;
  fs.rmSync(path.dirname(sidecar), { recursive: true, force: true });
  const fileOf = (file: string) => report.files.find((f) => f.path === file);
  return {
    text,
    bytes,
    report,
    isError: result.isError === true,
    /** Relevance score the ranking pass gave this file. */
    score: (file: string) => fileOf(file)?.score ?? 0,
    /** Chars of source the allocator RESERVED for it, before anything rendered. */
    allowance: (file: string) => fileOf(file)?.allowance ?? 0,
    /** Which render path the loop took: `whole`, `clusters`, `focused`, `skeleton`. */
    render: (file: string) => fileOf(file)?.render ?? null,
    /**
     * Rank the ranking pass gave it (1 = the file the response leads with, and
     * the first the render loop reaches). Read off the record rather than from
     * the position in `report.files`, which the report re-sorts by delivered
     * bytes for legibility.
     */
    rank: (file: string) => fileOf(file)?.rank ?? -1,
    /** Total source bytes delivered across every rendered file. */
    sourceTotal: () => [...bytes.values()].reduce((sum, n) => sum + n, 0),
    /** Fraction of the WHOLE response this file's source occupies. */
    share: (file: string) => (bytes.get(file) ?? 0) / (text.length || 1),
    shareUnder: (prefix: string) => {
      let total = 0;
      for (const [file, n] of bytes) if (file.startsWith(prefix)) total += n;
      return total / (text.length || 1);
    },
  };
}

// ── 1. The self-query fixture's shape ───────────────────────────────────────

describe('#1500 fixture 2 — allocation followed FILE SIZE, not relevance', () => {
  /**
   * The three roles from the real fixture, at synthetic scale:
   *
   *  - `src/mcp/allocator.ts` — stands in for `src/mcp/tools.ts`. Carries the
   *    query's terms on real functions with real call edges, and is deliberately
   *    too big to ship whole, so under the old rule it was clipped at the flat
   *    `maxCharsPerFile` no matter how far it outscored its peers.
   *  - `src/util/budget-math.ts` — stands in for `src/resolution/memory-budget.ts`.
   *    Genuinely relevant (the allocator calls it) but scoring about half as
   *    well — and small enough to ship WHOLE, which under the old rule was worth
   *    more than being right.
   *  - `scripts/eval-harness.mjs` — stands in for `scripts/agent-eval/*.mjs`. Its
   *    only claim on the query is a file-scope `explore` and `BUDGET` that nothing
   *    reads: the incidental collision CG-10 demoted.
   *
   * Measured on this fixture, reverting the render loop to the pre-CG-12 rules
   * (`fileBudget = maxCharsPerFile`, whole-file bound `maxCharsPerFile * 3`)
   * reproduces the report exactly — and every gate below goes red:
   *
   * | file                    | score | pre-CG-12      | CG-12          |
   * |-------------------------|-------|----------------|----------------|
   * | `src/mcp/allocator.ts`  |  77.5 |  4,843 (39.7%) |  9,335 (80.1%) |
   * | `src/util/budget-math.ts` | 36.0 |  6,079 (49.8%) |  1,037 ( 8.9%) |
   *
   * The half-as-relevant file taking the larger share, purely on size, IS #1500.
   */
  const QUERY = 'how does explore allocate its output budget across files';
  const ALLOCATOR = 'src/mcp/allocator.ts';
  const HELPER = 'src/util/budget-math.ts';
  const INCIDENTAL = 'scripts/eval-harness.mjs';

  const allocatorPass = (index: number, name: string) => `
/** ${name}: one pass of the explore output split. */
export function ${name}(
  candidates: AllocationCandidate[],
  budget: ExploreOutputBudget,
): Map<string, number> {
  const allowances = new Map<string, number>();
  const pool = clampOutputBudget(budget.maxOutputChars - ${index} * 200);
  const total = candidates.reduce((sum, candidate) => sum + candidate.score, 0);
  if (total <= 0) {
    return allowances;
  }
  const floors = Math.min(pool, 700 * candidates.length);
  const remainder = budgetRemainderAfterFloors(pool, floors);
  for (const candidate of candidates) {
    const floor = Math.floor(floors / candidates.length);
    const proportional = splitOutputEvenly(remainder, total, candidate.score);
    const boosted = candidate.spine ? proportional * 2 : proportional;
    const share = Math.min(floor + boosted, budget.maxCharsPerFile * 3);
    if (share <= 0) {
      continue;
    }
    allowances.set(candidate.path, share);
  }
  return allowances;
}
`;

  /**
   * Neutral bulk for the helper file: real symbols that match NOTHING in the
   * query, so the file grows in BYTES without gaining relevance. That asymmetry
   * is the fixture — the real `memory-budget.ts` won 51% of the envelope against
   * a file scoring twice its score purely by being small enough to ship whole.
   */
  const helperFiller = (n: number) => `
export function normalizeLedgerRow${n}(row: string[], fallback: string): string[] {
  const trimmed = row.map((cell) => cell.trim()).filter((cell) => cell.length > 0);
  return trimmed.length > 0 ? trimmed : [fallback];
}
`;

  const ALLOCATOR_SOURCE = `
/** Explore budget allocation: splits the output envelope across relevant files. */
export interface ExploreOutputBudget {
  maxOutputChars: number;
  maxCharsPerFile: number;
  defaultMaxFiles: number;
}

export interface AllocationCandidate {
  path: string;
  score: number;
  spine: boolean;
}
${[
  'allocateExploreBudget',
  'reserveOutputPerFile',
  'distributeOutputBudget',
  'planExploreOutput',
  'spendExploreBudget',
  'balanceOutputAcrossFiles',
  'concentrateExploreOutput',
  'settleExploreAllocation',
  'apportionExploreBudget',
  'rationOutputAcrossFiles',
  'tallyExploreOutputBudget',
  'weighExploreAllocation',
].map((name, i) => allocatorPass(i + 1, name)).join('')}
import {
  clampOutputBudget,
  splitOutputEvenly,
  budgetRemainderAfterFloors,
} from '../util/budget-math';
`;

  let project: Project;
  let run: Awaited<ReturnType<typeof explore>>;

  beforeAll(async () => {
    project = await buildProject('codegraph-alloc-selfquery-', {
      [ALLOCATOR]: ALLOCATOR_SOURCE,
      [HELPER]: `
/** Budget arithmetic the explore output allocator leans on. */
export function clampOutputBudget(value: number): number {
  if (value < 0) return 0;
  return Math.floor(value);
}

export function splitOutputEvenly(pool: number, total: number, score: number): number {
  if (total <= 0) return 0;
  return Math.floor((pool * score) / total);
}

export function budgetRemainderAfterFloors(pool: number, floors: number): number {
  const remainder = pool - floors;
  return remainder > 0 ? remainder : 0;
}

export function splitBudgetAcrossFiles(pool: number, fileCount: number): number {
  return fileCount > 0 ? Math.floor(pool / fileCount) : pool;
}

export function describeOutputBudget(pool: number, perFile: number): string {
  return \`explore budget pool of \${pool} chars, \${perFile} per file\`;
}
${Array.from({ length: 22 }, (_, i) => helperFiller(i + 1)).join('')}`,
      [INCIDENTAL]: `
// Eval harness. Mentions explore and BUDGET incidentally; nothing here allocates.
const explore = 'explore';
const BUDGET = 24000;

export function runHarness(repo) {
  const rows = [];
  for (const line of repo.split('\\n')) {
    rows.push(line.trim());
  }
  return rows;
}

export function summarizeRun(rows) {
  return { count: rows.length, first: rows[0] };
}
`,
      'src/mcp/server.ts': `
import { allocateExploreBudget } from './allocator';

export function serve(candidates: any[]) {
  return allocateExploreBudget(candidates, { maxOutputChars: 13000, maxCharsPerFile: 3800, defaultMaxFiles: 4 });
}
`,
      'src/util/logger.ts': `
export function log(message: string): void {
  console.log(message);
}
`,
    });
    run = await explore(project, QUERY);
  }, 120_000);

  afterAll(() => destroyProject(project));

  describe('fixture shape', () => {
    it('indexes all three roles, so a zero share means demoted and not missing', () => {
      // Without this the incidental assertion below could pass vacuously — a file
      // that was never indexed also delivers 0 bytes.
      for (const rel of [ALLOCATOR, HELPER, INCIDENTAL]) {
        expect(project.cg.getFile(rel), `${rel} indexed`).toBeTruthy();
      }
    });

    it('sizes the two files so the size-driven render split actually bites', () => {
      // The mechanism the epic is about. The answer file must be too big to ship
      // whole (so the old flat cap clipped it), and the helper small enough that
      // shipping it whole was always affordable under the old `maxCharsPerFile * 3`
      // bound. Without that asymmetry the fixture stops reproducing anything.
      const budget = getExploreOutputBudget(project.cg.getFiles().length);
      const answer = fs.readFileSync(path.join(project.dir, ALLOCATOR), 'utf-8');
      const helper = fs.readFileSync(path.join(project.dir, HELPER), 'utf-8');
      expect(answer.split('\n').length).toBeGreaterThan(280);
      expect(answer.length).toBeGreaterThan(budget.maxCharsPerFile * 3);
      expect(helper.split('\n').length).toBeLessThan(220);
      expect(helper.length).toBeLessThan(budget.maxCharsPerFile * 3);
    });

    it('scores the answer file well above the helper it calls', () => {
      // The other half of the asymmetry: the reversal below only means something
      // if the file that used to WIN the envelope was the less relevant one.
      expect(run.score(ALLOCATOR)).toBeGreaterThan(run.score(HELPER) * 1.5);
    });
  });

  describe('budget allocation', () => {
    it('gives the file that answers the question the majority of the envelope', () => {
      // The epic's acceptance bar for this fixture: >50%, from 18.5% at baseline.
      // Pre-CG-12 this file took 39.7% — behind the helper it calls.
      expect(run.share(ALLOCATOR)).toBeGreaterThan(0.5);
    });

    it('lets the answer file spend multiples of the flat cap it used to be clipped at', () => {
      // The mechanism as a byte count rather than a share: this file is too big
      // to ship whole, so under the old rule its source was truncated at
      // `maxCharsPerFile` however far it outscored its peers. Its reservation is
      // now several times that cap. A build that re-imposes a flat per-file cap
      // fails HERE first — it delivered 4,843 against a 3,800 cap.
      const budget = getExploreOutputBudget(project.cg.getFiles().length);
      expect(run.bytes.get(ALLOCATOR) ?? 0).toBeGreaterThan(budget.maxCharsPerFile * 2);
    });

    it('stops the smaller file winning on size — it no longer ships whole', () => {
      // The reversal, from the other side. The helper scores about half the
      // answer file and is small enough that the old whole-file bound shipped it
      // ENTIRE (6,079 chars, 49.8% of the envelope — more than the file that
      // answered the question). It now clusters inside its proportional share.
      const helperSource = fs.readFileSync(path.join(project.dir, HELPER), 'utf-8');
      const delivered = run.bytes.get(HELPER) ?? 0;
      expect(delivered).toBeGreaterThan(0);
      expect(delivered).toBeLessThan(helperSource.length);
    });

    it('orders per-file shares by relevance, not by file size', () => {
      // Both files deliver — this is not concentration by elimination — but the
      // one that answers the question gets several times the bytes of the helper
      // it calls. Pre-CG-12 this ratio was 0.8, i.e. inverted.
      const answer = run.share(ALLOCATOR);
      const helper = run.share(HELPER);
      expect(helper).toBeGreaterThan(0);
      expect(answer).toBeGreaterThan(helper * 3);
    });

    it('spends nothing on the incidental name collision', () => {
      expect(run.bytes.get(INCIDENTAL) ?? 0).toBe(0);
      expect(run.shareUnder('scripts/')).toBe(0);
    });

    it('reserves in proportion to score, before anything renders', () => {
      // The reservations are the contract the render loop then spends. Asserting
      // them directly — not just the bytes that came out — separates "allocation
      // is proportional" from "the render loop happened to emit these sizes".
      const answerReserved = run.allowance(ALLOCATOR);
      const helperReserved = run.allowance(HELPER);
      expect(answerReserved).toBeGreaterThan(helperReserved);
      expect(answerReserved / helperReserved).toBeGreaterThan(run.score(ALLOCATOR) / run.score(HELPER) * 0.5);
      // Nothing is over-promised: the sum of reservations fits the pool, and the
      // pool fits the envelope. This is the invariant the whole epic rests on.
      expect(run.report.allocation.reserved).toBeLessThanOrEqual(run.report.allocation.pool);
      expect(run.report.allocation.pool).toBeLessThanOrEqual(run.report.budget.maxOutputChars);
    });

    it('keeps the response inside the hard ceiling and under the inline cap', () => {
      // Two different bounds, and it matters which is which. `maxOutputChars`
      // bounds the RESERVATIONS (asserted above); the RESPONSE is bounded by
      // `hardCeiling` — 1.5x the envelope, capped at 25K — because the render
      // loop is allowed a bounded overshoot for the whole-file grace and an
      // oversize first cluster. The 25K is the one that must never move: past it
      // the host writes the result to a file the agent Reads back.
      const budget = getExploreOutputBudget(project.cg.getFiles().length);
      const hardCeiling = Math.min(Math.round(budget.maxOutputChars * 1.5), INLINE_CAP);
      expect(run.text.length).toBeLessThanOrEqual(hardCeiling);
      expect(run.text.length).toBeLessThan(INLINE_CAP);
    });

    it('records the shape of the split so a regression is legible', () => {
      // Not a gate — a snapshot, so a change that shifts the split shows up in the
      // diff rather than silently flipping a threshold.
      expect({
        answerWinsEnvelope: run.share(ALLOCATOR) > run.share(HELPER),
        helperStillDelivers: (run.bytes.get(HELPER) ?? 0) > 0,
        incidentalDelivers: (run.bytes.get(INCIDENTAL) ?? 0) > 0,
      }).toEqual({
        answerWinsEnvelope: true,
        helperStillDelivers: true,
        incidentalDelivers: false,
      });
    });
  });
});

// ── 1b. CG-21: a reservation below the file's size must not lose its bytes ──

/**
 * The shape CG-15's agent A/B found in the wild, and the one thing the suite
 * above could not catch: a file whose reservation lands BELOW its own size.
 *
 * Express, `lib/utils.js` (5,293 B), the top-ranked file for
 * "res.send Content-Type ETag generateETag setETag":
 *
 * | | baseline | CG-12 |
 * |---|---|---|
 * | delivered | 6,380 (46.1%) whole | **583 (7.7%) cluster stub** |
 * | source envelope (13,000 budget) | 13,849 | **9,241** |
 *
 * It was reserved 3,870 and spent 583. The whole-file grace bound
 * (`allowance + min(800, allowance * 0.15)` = 4,450) sits just under the file,
 * so the whole-file render is declined; the fallback cluster render has three
 * matched symbols to work with and emits a stub. The other 3,287 chars were
 * neither delivered nor redistributed — **the pool shrank by a third against an
 * unchanged budget**, and the agent Read the file back four times.
 *
 * Everything about that is invisible to the fixtures above, and to the payroll
 * one: both SATURATE (`[over budget] [TRUNCATED]`, 23,599 of a 23,600 pool),
 * so there is no unspent reservation to lose. This fixture is built to sit in
 * the gap instead — a mid-sized top-ranked file with a THIN matched-symbol set,
 * sized just above its reservation — which is the combination that has to hold
 * for the defect to reproduce, and is why it shipped.
 *
 * The `fixture shape` block below is load-bearing, not scaffolding: every gate
 * here passes vacuously if the target ever drifts small enough for the grace
 * bound to cover it, so the window `0.6 × size <= reservation < size` is
 * asserted directly.
 */
describe('CG-21 — a reservation under the file size still buys the file', () => {
  // Names two symbols that live in ONE mid-sized file (the named-seed tier is
  // what puts it at rank 0) while the rest of the terms pull in its peers, so
  // the proportional split hands the target well under its own size.
  const QUERY = 'generateEtag compileEtag send response body';
  const TARGET = 'src/http/etag.ts';
  const RESPONSE = 'src/http/response.ts';
  const APPLICATION = 'src/http/application.ts';

  /**
   * Bulk for the target: real, extractable symbols that match NOTHING in the
   * query. They make the file BIG without making it more relevant — which is
   * precisely how a file ends up reserved less than it is worth in bytes. Kept
   * dense (4 lines each) so the file stays well inside `WHOLE_FILE_MAX_LINES`
   * and the byte bound is the only thing that can decline the whole render.
   */
  const inertFiller = (n: number) => `
export function normalizeLedgerRow${n}(row: string[], fallback: string, separator: string): string[] {
  const trimmed = row.map((cell) => cell.trim()).filter((cell) => cell.length > 0 && cell !== separator);
  return trimmed.length > 0 ? trimmed : [fallback, separator, String(trimmed.length), 'ledger-row-${n}'];
}
`;

  /**
   * The matched-symbol set, deliberately THIN and small. This is the second
   * half of the shape: with only these two tiny functions to cluster around,
   * the fallback render emits a few hundred chars and abandons the rest of the
   * reservation. A file with a fat matched set would spend its allowance the
   * ordinary way and never expose the bug.
   */
  const TARGET_SOURCE = `
/** ETag helpers. */
export function generateEtag(body: string): string {
  return '"' + body.length.toString(16) + '"';
}

export function compileEtag(setting: string): (body: string) => string {
  return setting === 'strong' ? generateEtag : (body: string) => 'W/' + generateEtag(body);
}
${Array.from({ length: 27 }, (_, i) => inertFiller(i + 1)).join('')}`;

  const responseMethod = (name: string) => `
  public ${name}(body: string): string {
    const etag = compileEtag(this.etagSetting)(body);
    this.headers.set('etag', etag);
    return body;
  }
`;

  const RESPONSE_SOURCE = `
import { compileEtag } from './etag';

/** The response object: sends a body and negotiates its representation. */
export class ServerResponse {
  private headers = new Map<string, string>();
  private etagSetting = 'strong';
${[
  'send',
  'sendBody',
  'sendResponse',
  'writeBody',
  'endResponse',
  'json',
  'setResponseBody',
  'flushResponseBody',
].map(responseMethod).join('')}
}
`;

  let project: Project;
  let run: Awaited<ReturnType<typeof explore>>;
  let targetSize = 0;

  beforeAll(async () => {
    project = await buildProject('codegraph-alloc-cg21-', {
      [TARGET]: TARGET_SOURCE,
      [RESPONSE]: RESPONSE_SOURCE,
      [APPLICATION]: `
import { ServerResponse } from './response';

/** The application: routes a request and hands the response its body. */
export class Application {
  private routes = new Map<string, (res: ServerResponse) => string>();

  public handleRequest(path: string, res: ServerResponse, body: string): string {
    const route = this.routes.get(path);
    return route ? route(res) : res.send(body);
  }

  public registerResponseRoute(path: string, handler: (res: ServerResponse) => string): void {
    this.routes.set(path, handler);
  }
}
`,
      'src/http/request.ts': `
/** The request object: carries the inbound body. */
export class ServerRequest {
  public constructor(public readonly body: string) {}

  public freshResponseBody(): string {
    return this.body.trim();
  }
}
`,
      'src/util/logger.ts': `
export function log(message: string): void {
  console.log(message);
}
`,
    });
    targetSize = fs.readFileSync(path.join(project.dir, TARGET), 'utf-8').length;
    run = await explore(project, QUERY);
  }, 120_000);

  afterAll(() => destroyProject(project));

  describe('fixture shape', () => {
    it('ranks the target first, on a matched set of only two symbols', () => {
      // Rank 0 is what makes the loss expensive: this is the file the response
      // leads with, and the one the agent Reads back when it arrives as a stub.
      expect(run.rank(TARGET)).toBe(1);
    });

    it('sizes the target ABOVE its reservation but inside the buy window', () => {
      // The whole assertion set below is vacuous outside this window, so it is
      // pinned here rather than assumed:
      //   reservation >= size  → the grace bound already covers it, and the
      //                          buy rule is never consulted (express's other
      //                          three queries look like this).
      //   reservation < 0.6×size → the shortfall is real, clustering is the
      //                          right answer, and the carry-forward — not the
      //                          buy rule — is what conserves the bytes.
      const reserved = run.allowance(TARGET);
      expect(reserved).toBeGreaterThan(0);
      expect(reserved).toBeLessThan(targetSize);
      expect(reserved / targetSize).toBeGreaterThanOrEqual(EXPLORE_ALLOCATION.WHOLE_FILE_BUY_FRACTION);
      // ...and specifically OUTSIDE the grace bound, which is the pre-CG-21
      // rule. If grace alone could carry it, this fixture proves nothing.
      const graceBound = reserved + Math.min(
        EXPLORE_ALLOCATION.WHOLE_FILE_GRACE_MAX,
        Math.round(reserved * EXPLORE_ALLOCATION.WHOLE_FILE_GRACE_FRACTION),
      );
      expect(targetSize).toBeGreaterThan(graceBound);
    });

    it('keeps the target inside the whole-file LINE bound, so only bytes can gate it', () => {
      // `WHOLE_FILE_MAX_LINES` (220 for a non-central file) is a separate gate
      // that also declines a whole render. If the fixture ever crossed it the
      // suite would go red for the wrong reason — and, worse, a genuine
      // regression in the BYTE bound would be masked by it.
      const lines = fs.readFileSync(path.join(project.dir, TARGET), 'utf-8').split('\n').length;
      expect(lines).toBeLessThanOrEqual(220);
    });
  });

  describe('the reservation is spent', () => {
    it('delivers the target WHOLE rather than as a cluster stub', () => {
      // The headline. Pre-CG-21 this file rendered `clusters` and emitted a few
      // hundred chars against a multi-thousand-char reservation.
      expect(run.render(TARGET)).toBe('whole');
    });

    it('spends more than the reservation, not a fraction of it', () => {
      // Stated as bytes so it bites independently of the render-mode label: a
      // build that renamed the whole path but still emitted a stub fails here.
      // Express: 583 delivered against 3,870 reserved.
      const delivered = run.bytes.get(TARGET) ?? 0;
      expect(delivered).toBeGreaterThanOrEqual(targetSize);
      expect(delivered).toBeGreaterThan(run.allowance(TARGET));
    });

    it('leaves no rendered file both under its reservation and short of content', () => {
      // The defect stated as an invariant, which is what makes it general rather
      // than a re-assertion of the case above: a rendered file either SPENDS what
      // it was promised, or it ran out of file. Express's `lib/utils.js` did
      // neither — 583 delivered, 3,870 promised, 5,293 bytes of file sitting
      // there — and the difference was dropped rather than redistributed, which
      // is why the source envelope fell 13,849 → 9,241 on an unchanged budget.
      //
      // `response.ts` is the case the naive "spend the whole pool" version of
      // this test gets wrong: it delivers 1,635 of a 5,292 reservation and that
      // is CORRECT — the file is only 1,635 bytes. A pool cannot be spent past
      // the content that exists to fill it.
      for (const f of run.report.files) {
        if (!f.render || (f.emittedChars ?? 0) === 0) continue;
        const size = fs.readFileSync(path.join(project.dir, f.path), 'utf-8').length;
        expect(f.emittedChars, `${f.path} spent its reservation or ran out of file`)
          .toBeGreaterThanOrEqual(Math.min(f.allowance ?? 0, size));
      }
    });

    it('holds the hard ceiling while doing it', () => {
      // The buy rule spends MORE than the reservation, so the bound that stops
      // it running away has to be re-proved here and not inherited: the
      // overshoot pool is finite, and the 25K inline cap is absolute — past it
      // the host writes the result to a file the agent Reads back.
      const budget = getExploreOutputBudget(project.cg.getFiles().length);
      const hardCeiling = Math.min(Math.round(budget.maxOutputChars * 1.5), INLINE_CAP);
      expect(run.text.length).toBeLessThanOrEqual(hardCeiling);
      expect(run.text.length).toBeLessThan(INLINE_CAP);
    });

    it('still serves the peers — concentration, not a single-file response', () => {
      // The over-correction control for this fixture. Buying the target whole
      // must not eat the files below it: that is the trade the shared overshoot
      // pool refuses (it dropped `payslip_builder.go` when funding was per-file).
      const peers = [RESPONSE, APPLICATION].filter((f) => (run.bytes.get(f) ?? 0) > 0);
      expect(peers.length).toBeGreaterThan(0);
    });
  });
});

/**
 * The other half of CG-21, and the half the whole-file buy rule cannot reach.
 *
 * Buying the file whole only helps when the reservation has already covered
 * most of it. Below that the shortfall is real — the file is several times its
 * reservation, and clustering IS the right render — but the bytes it cannot
 * spend still must not evaporate. Express, query "compileETag req.fresh":
 * `lib/utils.js` was reserved 3,809 and spent 791; the 3,018 chars it left had
 * to reach `lib/response.js` below it, which delivered 4,650 on a 1,895
 * reservation.
 *
 * So this fixture is deliberately the INVERSE of the one above: the leading
 * file is far too big for the buy rule to fire, and the assertion is on the
 * file BELOW it. Without this, `allowance = reserved` — the whole carry-forward
 * deleted — passes every other test in this file.
 */
describe('CG-21 — an unspendable reservation flows to the next file down', () => {
  // Names three tiny callables that all live in the SPRAWL file — the named-seed
  // tier is what puts a file with almost no matched content at rank 1 — plus one
  // term the absorber's methods carry, so it ranks second rather than cliffing.
  const QUERY = 'renderStaticScene renderInteractiveScene renderNewElementScene paintSceneLayer';
  // Rank 1: a huge file the query names two symbols in. Its reservation cannot
  // approach its size, so it clusters — and clusters thinly, because those two
  // symbols are all it matched.
  const SPRAWL = 'src/scene/sprawl.ts';
  // Rank 2: dense with matched symbols and bigger than any share it can be
  // reserved, so it will absorb whatever the file above it leaves.
  const ABSORBER = 'src/render/absorber.ts';

  const inertBulk = (n: number) => `
export function reconcileLedgerEntry${n}(rows: string[], fallback: string, separator: string): string[] {
  const trimmed = rows.map((cell) => cell.trim()).filter((cell) => cell.length > 0 && cell !== separator);
  return trimmed.length > 0 ? trimmed : [fallback, separator, String(trimmed.length), 'entry-${n}'];
}
`;

  // Long ENOUGH, in lines, that the absorber cannot ship whole (220 lines is the
  // other whole-file gate). That matters: a file that renders whole ignores the
  // per-file budget entirely, and this fixture is about a budget being spent.
  const matchedPaint = (n: number) => `
  public paintSceneLayer${n}(canvas: string, scene: string, element: string): string {
    const appState = this.appState.get('layer${n}') ?? scene;
    const painted = canvas + '|' + appState + '|' + element;
    const stamped = painted + '|layer-${n}';
    const merged = stamped + '|' + scene + '|' + element;
    const settled = merged.split('|').filter((part) => part.length > 0).join('|');
    this.appState.set('layer${n}', settled);
    if (settled.length === 0) {
      return this.paint(scene, scene);
    }
    return this.paint(settled, scene);
  }
`;

  let project: Project;
  let run: Awaited<ReturnType<typeof explore>>;

  beforeAll(async () => {
    project = await buildProject('codegraph-alloc-cg21-carry-', {
      [SPRAWL]: `
import { Absorber } from '../render/absorber';

/** Scene sprawl: three one-line answers buried in a very large file. */
export function renderStaticScene(scene: string): string {
  return new Absorber().paint(scene, scene);
}

export function renderInteractiveScene(scene: string): string {
  return new Absorber().paint(scene, scene + ':interactive');
}

export function renderNewElementScene(scene: string): string {
  return new Absorber().paint(scene, scene + ':new-element');
}
${Array.from({ length: 90 }, (_, i) => inertBulk(i + 1)).join('')}`,
      [ABSORBER]: `
/** The renderer: many matched paint passes, all of them wanted. */
export class Absorber {
  private appState = new Map<string, string>();

  public paint(element: string, scene: string): string {
    return element + '|' + scene;
  }
${Array.from({ length: 20 }, (_, i) => matchedPaint(i + 1)).join('')}
}
${/* Inert tail: pushes the absorber FAR past its reservation so the whole-file
      buy rule cannot fire on it either. Without this the absorber ships whole
      and the fixture measures the buy rule a second time instead of the
      carry-forward — which is exactly how it read on the first attempt. */
  Array.from({ length: 40 }, (_, i) => inertBulk(100 + i)).join('')}`,
      'src/util/logger.ts': `
export function log(message: string): void {
  console.log(message);
}
`,
    });
    run = await explore(project, QUERY);
  }, 120_000);

  afterAll(() => destroyProject(project));

  it('leaves the leading file unable to spend its reservation', () => {
    // The precondition. If the sprawl file ever spends its share, there is no
    // slack, and the assertion below passes for no reason at all.
    const spent = run.bytes.get(SPRAWL) ?? 0;
    expect(spent).toBeGreaterThan(0);
    expect(spent).toBeLessThan(run.allowance(SPRAWL));
    // ...and it is out of reach of the buy rule, so this is genuinely the
    // carry-forward's case and not a second test of the fixture above.
    const size = fs.readFileSync(path.join(project.dir, SPRAWL), 'utf-8').length;
    expect(run.allowance(SPRAWL) / size).toBeLessThan(EXPLORE_ALLOCATION.WHOLE_FILE_BUY_FRACTION);
  });

  it('hands the shortfall to the file below, which spends past its own reservation', () => {
    // The lever. Measured both ways on this fixture: with the carry-forward the
    // absorber delivers 9,297 against a 7,455 reservation; with
    // `allowance = reserved` it delivers 7,479 — its reservation and nothing
    // more, while the sprawl file's 4,408 unspent chars are dropped.
    //
    // The 1.1 margin is not padding. A cluster section can land a few chars over
    // the budget it was selected against (whole symbol ranges, never sliced
    // mid-method), so "delivered > reserved" alone is true by ~24 chars even on
    // the mutated build — a test that passes on the defect.
    const delivered = run.bytes.get(ABSORBER) ?? 0;
    expect(delivered).toBeGreaterThan(Math.round(run.allowance(ABSORBER) * 1.1));
  });

  it('keeps the shortfall in the envelope instead of dropping it', () => {
    // The same lever read off the response as a whole, which is the form the
    // user actually feels: express's source envelope fell 13,849 → 9,241 on an
    // unchanged 13,000 budget because nothing picked up what `lib/utils.js`
    // could not spend. Here: 10,033 delivered with the carry-forward, 8,215
    // without.
    //
    // Stated against what a no-carry build could produce — the leader's actual
    // spend plus the absorber's own reservation — so it stays a statement about
    // the mechanism rather than a hard-coded byte count.
    const noCarryCeiling = (run.bytes.get(SPRAWL) ?? 0) + Math.round(run.allowance(ABSORBER) * 1.05);
    expect(run.sourceTotal()).toBeGreaterThan(noCarryCeiling);
  });

  it('bounds the borrowing — slack concentrates, it does not consume', () => {
    // Carried slack is clamped to `MAX_SHARE` of the envelope, so an
    // under-spending leader cannot hand the file below it the whole response.
    // The bound is stated WITH the spine allowance (`SPINE_CEILING`, 1.5x)
    // folded in: a flow-path cluster is deliberately allowed past the per-file
    // share, and that predates CG-21 — writing the tighter bound here would
    // make this test fail on a build with no defect in it.
    const budget = getExploreOutputBudget(project.cg.getFiles().length);
    const clamp = Math.max(
      run.allowance(ABSORBER),
      Math.round(budget.maxOutputChars * EXPLORE_ALLOCATION.MAX_SHARE),
    );
    expect(run.bytes.get(ABSORBER) ?? 0).toBeLessThanOrEqual(Math.round(clamp * 1.5));
    // The anti-starvation half, and the one that would actually bite: the file
    // that lent the slack still gets rendered.
    expect(run.bytes.get(SPRAWL) ?? 0).toBeGreaterThan(0);
    expect(run.text.length).toBeLessThan(INLINE_CAP);
  });
});

// ── 2. Degenerate and diffuse result sets ───────────────────────────────────

describe('allocation on degenerate result sets', () => {
  let project: Project;

  beforeAll(async () => {
    // Four modules that are deliberate COPIES of each other, plus one unrelated
    // file. Copies are the pathological input for a proportional split: every
    // candidate carries the same weight, so the split divides by a denominator
    // that is entirely made of ties.
    const twin = (n: number) => `
export class InventoryLedger${n} {
  private rows: number[] = [];

  public recordInventoryMovement(quantity: number): void {
    this.rows.push(quantity);
  }

  public settleInventoryLedger(): number {
    return this.rows.reduce((sum, row) => sum + row, 0);
  }
}
`;
    project = await buildProject('codegraph-alloc-degenerate-', {
      'src/ledger/one.ts': twin(1),
      'src/ledger/two.ts': twin(2),
      'src/ledger/three.ts': twin(3),
      'src/ledger/four.ts': twin(4),
      'src/unrelated/colors.ts': `
export const PALETTE = ['oxblood', 'paper', 'ink'];

export function pickPaletteEntry(index: number): string {
  return PALETTE[index % PALETTE.length]!;
}
`,
    });
  }, 120_000);

  afterAll(() => destroyProject(project));

  it('does not starve anyone when every file scores identically', async () => {
    // The all-ties case, end to end: no division by zero, nobody cliffed for
    // being relatively weak (nothing IS relatively weak), and no single copy
    // sweeping the envelope on an arbitrary tiebreak.
    const run = await explore(project, 'how does the inventory ledger record and settle movements');
    expect(run.isError).toBe(false);
    const ledger = [...run.bytes].filter(([file]) => file.startsWith('src/ledger/'));
    expect(ledger.length).toBeGreaterThanOrEqual(2);
    const shares = ledger.map(([, n]) => n);
    expect(Math.max(...shares) / Math.min(...shares)).toBeLessThan(3);
    for (const [file, n] of ledger) {
      expect(n, `${file} starved`).toBeGreaterThan(0);
    }
    // The reservations behind those bytes divided cleanly too.
    expect(run.report.allocation.reserved).toBeLessThanOrEqual(run.report.allocation.pool);
  });

  it('answers a single-file question without over-spending the envelope on it', async () => {
    const run = await explore(project, 'pickPaletteEntry');
    expect(run.isError).toBe(false);
    expect(run.bytes.get('src/unrelated/colors.ts') ?? 0).toBeGreaterThan(0);
    const budget = getExploreOutputBudget(project.cg.getFiles().length);
    // One dominant file still cannot exceed the share ceiling, and the response
    // as a whole still fits the envelope's hard ceiling.
    expect(run.bytes.get('src/unrelated/colors.ts')!)
      .toBeLessThanOrEqual(Math.round(budget.maxOutputChars * EXPLORE_ALLOCATION.MAX_SHARE));
    expect(run.text.length).toBeLessThan(INLINE_CAP);
  });

  it('returns guidance rather than an error when nothing matches', async () => {
    // An `isError` response teaches the agent to abandon codegraph for the rest
    // of the session, so a zero-result allocation must stay success-shaped.
    const run = await explore(project, 'quantumFluxCapacitorHandshake');
    expect(run.isError).toBe(false);
    expect(run.text.length).toBeGreaterThan(0);
    expect(run.bytes.size).toBe(0);
  });
});

describe('the diffuse-query control', () => {
  let project: Project;

  beforeAll(async () => {
    // Six genuinely distinct subsystems, each a legitimate partial answer to a
    // survey question. Concentration is the epic's goal, but over-correcting here
    // costs a round-trip: the agent's fallback for an under-served survey is
    // Grep, not a second explore.
    const subsystem = (name: string, verb: string) => `
export interface ${name}Options {
  retries: number;
}

export class ${name}Service {
  constructor(private readonly options: ${name}Options) {}

  public ${verb}Request(payload: string): string {
    return this.describe${name}() + ':' + payload;
  }

  public describe${name}(): string {
    return '${name} with ' + this.options.retries + ' retries';
  }
}
`;
    project = await buildProject('codegraph-alloc-diffuse-', {
      'src/services/auth.ts': subsystem('Auth', 'authorize'),
      'src/services/billing.ts': subsystem('Billing', 'charge'),
      'src/services/search.ts': subsystem('Search', 'query'),
      'src/services/notify.ts': subsystem('Notify', 'publish'),
      'src/services/report.ts': subsystem('Report', 'render'),
      'src/services/audit.ts': subsystem('Audit', 'record'),
    });
  }, 120_000);

  afterAll(() => destroyProject(project));

  it('still returns a spread for a survey-style question', async () => {
    // The over-correction guard for CG-10's floor and CG-12's cliff together: a
    // question with no single right answer must come back as several usable
    // sections, not one file plus a pointer list.
    const run = await explore(project, 'what services does this project expose and what does each one do');
    expect(run.isError).toBe(false);
    const services = [...run.bytes].filter(([file]) => file.startsWith('src/services/'));
    expect(services.length).toBeGreaterThanOrEqual(3);
    const total = services.reduce((sum, [, n]) => sum + n, 0);
    expect(total).toBeGreaterThan(0);
    for (const [file, n] of services) {
      // Nobody is reduced to a fragment, and nobody swallows the response.
      expect(n, `${file} fragment`).toBeGreaterThan(200);
      expect(n / total, `${file} hogged the envelope`).toBeLessThan(0.8);
    }
  });

  it('names whatever it could not show, so the spread stays completable', async () => {
    const run = await explore(project, 'what services does this project expose and what does each one do');
    const shown = [...run.bytes.keys()].filter((f) => f.startsWith('src/services/'));
    const missing = ['auth', 'billing', 'search', 'notify', 'report', 'audit']
      .map((n) => `src/services/${n}.ts`)
      .filter((f) => !shown.includes(f));
    for (const file of missing) {
      expect(run.text, `${file} dropped without a pointer`).toContain(file);
    }
  });
});
