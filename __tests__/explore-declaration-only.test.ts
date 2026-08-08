/**
 * Regression gate for DECLARATION-ONLY files in explore ranking (task CG-28).
 *
 * A file that holds nothing but type declarations — an ambient `.d.ts`, vendored
 * typings, a `types.ts` of pure interfaces — cannot answer a FLOW question: no
 * bodies, no call edges, no behaviour. But the identifiers it declares are
 * exactly the generic ones a prose question uses (`Body`, `Message`,
 * `ImageMetadata`, `ReadableStream`), so on term overlap it out-scored the
 * implementation and took the envelope. Measured on this fixture before the fix:
 * rank #1 and 51% of delivered source on a prose flow query.
 *
 * CG-25 already covers the file that STARTED this — a Wrangler
 * `worker-configuration.d.ts`, which announces itself with a generated banner.
 * `docs/benchmarks/explore-declaration-only-cg28.md` has that measurement; the
 * banner alone is worth 15–46 points of envelope share. What it does not cover
 * is a declaration file with no banner at all, which is what this fixture's
 * `platform-shims.d.ts` is, and what the damping in `rankPenalty` addresses.
 *
 * Two claims, and BOTH have to hold — the counter-case is why the penalty is
 * guarded rather than flat:
 *
 *   1. a prose flow query must not let a declaration-only file outrank the
 *      implementation files that answer it;
 *   2. a query genuinely ABOUT a declared type must still reach the declaration
 *      at full weight.
 *
 * The suppression the issue explicitly forbids is also pinned: a damped file is
 * still a candidate and still named in the response, so one follow-up explore
 * fetches it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import type { ExploreDiagnosticReport, ExploreDiagnosticFile } from '../src/mcp/explore-diagnostics';

const FIXTURE_SRC = path.join(__dirname, 'fixtures', 'ambient-decls-ts');

/** Declaration-only, hand-written, NO generated banner — the surviving gap. */
const HANDWRITTEN_DECL = 'types/platform-shims.d.ts';
/** Declaration-only WITH a Wrangler banner — the CG-25 control in the same run. */
const GENERATED_DECL = 'types/worker-configuration.d.ts';
/** Declaration-only but IMPORTED by the storage layer — must never be damped. */
const SHARED_TYPES = 'src/storage/types.ts';

/** Prose, naming no symbol — the query shape that let the original file in. */
const FLOW_QUERY =
  'how does an upload request stream the file body to storage and record image metadata';
/** Prose that DOES name a declared type — the counter-case. */
const TYPE_QUERY = 'what does the UploadStorage interface declare for putting an object';

describe('CG-28 — a declaration-only file does not outrank implementation on a flow query', () => {
  let testDir: string;
  let cg: CodeGraph;
  let sidecar: string;

  /** One explore call; returns its diagnostic report plus the response text. */
  const explore = async (query: string): Promise<{ report: ExploreDiagnosticReport; text: string }> => {
    fs.rmSync(sidecar, { force: true });
    const previous = process.env.CODEGRAPH_EXPLORE_DEBUG;
    process.env.CODEGRAPH_EXPLORE_DEBUG = sidecar;
    let text: string;
    try {
      text = (await new ToolHandler(cg).execute('codegraph_explore', { query })).content?.[0]?.text ?? '';
    } finally {
      if (previous === undefined) delete process.env.CODEGRAPH_EXPLORE_DEBUG;
      else process.env.CODEGRAPH_EXPLORE_DEBUG = previous;
    }
    const written = fs.readFileSync(sidecar, 'utf-8').trim().split('\n').filter(Boolean);
    return { report: JSON.parse(written[written.length - 1]!) as ExploreDiagnosticReport, text };
  };

  const fileOf = (report: ExploreDiagnosticReport, p: string): ExploreDiagnosticFile | undefined =>
    report.files.find((f) => f.path === p);

  let flow: { report: ExploreDiagnosticReport; text: string };
  let typed: { report: ExploreDiagnosticReport; text: string };

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cg28-'));
    fs.cpSync(FIXTURE_SRC, testDir, { recursive: true });
    fs.rmSync(path.join(testDir, '.codegraph'), { recursive: true, force: true });
    sidecar = path.join(testDir, 'explore-diag.jsonl');

    cg = CodeGraph.initSync(testDir);
    await cg.indexAll();

    flow = await explore(FLOW_QUERY);
    typed = await explore(TYPE_QUERY);
  }, 120_000);

  afterAll(() => {
    if (cg) cg.destroy();
    if (testDir && fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('fixture shape — if this rots, the gate below means nothing', () => {
    it('holds two declaration-only files that differ only in the banner', () => {
      for (const p of [HANDWRITTEN_DECL, GENERATED_DECL]) {
        const nodes = cg.getNodesInFile(p).filter((n) => n.kind !== 'file' && n.kind !== 'import');
        expect(nodes.length, `${p} declares nothing`).toBeGreaterThan(10);
        // Every symbol type-level, nothing with a body — the structural test the
        // penalty keys on. A `function`/`class` creeping in would silently exempt
        // the file and make every assertion below vacuous.
        expect(nodes.every((n) => n.kind === 'interface' || n.kind === 'type_alias'), `${p} has a non-type symbol`).toBe(true);
      }
      // Only one of them announces itself, so the CG-25 penalty is the ONLY
      // difference between the two — that is what makes them comparable.
      expect(cg.getFile(GENERATED_DECL)?.generated).toBe(true);
      expect(cg.getFile(HANDWRITTEN_DECL)?.generated).toBeFalsy();
    });

    it('holds a pure-type module the code IMPORTS, as the safety control', () => {
      // Identical to the ambient files on kinds and bodies; different only in
      // that the storage layer is typed by it. This is the shape the penalty
      // must NOT catch — a `types.ts` the codebase depends on is part of the
      // structure of any answer about that code.
      const nodes = cg.getNodesInFile(SHARED_TYPES).filter((n) => n.kind !== 'file' && n.kind !== 'import');
      expect(nodes.length).toBeGreaterThan(0);
      expect(nodes.every((n) => n.kind === 'interface' || n.kind === 'type_alias')).toBe(true);
      expect(cg.getFile(SHARED_TYPES)?.generated).toBeFalsy();
    });

    it('holds implementation files that DO answer the flow question', () => {
      for (const p of ['src/routes/upload.ts', 'src/storage/stream.ts', 'src/storage/metadata.ts']) {
        expect(cg.getNodesInFile(p).some((n) => n.kind === 'function'), `${p} has no functions`).toBe(true);
      }
    });
  });

  describe('the gate — a prose flow query', () => {
    it('damps the un-bannered declaration file rather than letting it rank free', () => {
      const rec = fileOf(flow.report, HANDWRITTEN_DECL);
      expect(rec, 'the declaration file is not even a candidate — fixture drifted').toBeDefined();
      expect(rec!.ambientDeclaration).toBe(true);
      expect(rec!.penalty).toBeLessThan(1);
    });

    it('does not let it outrank the implementation files', () => {
      const decl = fileOf(flow.report, HANDWRITTEN_DECL)!;
      const impl = flow.report.files.filter((f) => f.path.startsWith('src/') && f.finalChars > 0);
      expect(impl.length, 'no implementation file delivered anything').toBeGreaterThanOrEqual(2);
      // Measured before the fix: the declaration file was rank #1 with score 53
      // against the best implementation file's 34. The bar is that at least one
      // implementation file now ranks above it — ordinary budget movement must
      // not fail the suite, but the inversion coming back must.
      expect(impl.some((f) => f.rank < decl.rank), 'declaration file still ranks first').toBe(true);
    });

    it('still names it in the response, so one follow-up call fetches it', () => {
      // The issue forbids suppression: a damped file must remain reachable.
      expect(flow.text).toContain(HANDWRITTEN_DECL);
    });

    it('leaves the implementation files at full weight', () => {
      for (const f of flow.report.files.filter((x) => x.path.startsWith('src/'))) {
        expect(f.ambientDeclaration, `${f.path} was misread as an ambient declaration`).toBe(false);
        expect(f.penalty).toBe(1);
      }
    });

    it('does not damp a pure-type module the codebase imports', () => {
      // The condition that keeps this narrow enough to be safe. Without it the
      // same rule demotes `displacement-ts`'s pipeline `types.ts` — pure
      // interfaces, but 13 inbound imports — and breaks the CG-31 gate.
      const rec = flow.report.files.find((f) => f.path === SHARED_TYPES);
      if (rec) {
        expect(rec.ambientDeclaration, `${SHARED_TYPES} was flagged ambient`).toBe(false);
        expect(rec.penalty).toBe(1);
      }
      // Independent of whether this query ranked it: the predicate itself must
      // separate the two shapes.
      const isAmbient = cg.ambientDeclarationFilePredicate([SHARED_TYPES, HANDWRITTEN_DECL]);
      expect(isAmbient(SHARED_TYPES)).toBe(false);
      expect(isAmbient(HANDWRITTEN_DECL)).toBe(true);
    });
  });

  describe('the counter-case — a query that NAMES a declared type', () => {
    it('reaches the declaration at full weight, undamped', () => {
      const rec = fileOf(typed.report, HANDWRITTEN_DECL);
      expect(rec, 'the named type\'s file is not a candidate').toBeDefined();
      expect(rec!.ambientDeclaration).toBe(true);
      // Detected as declaration-only, but EXEMPT — the query asked for it.
      expect(rec!.penalty).toBe(1);
    });

    it('ranks it first and delivers its source', () => {
      const rec = fileOf(typed.report, HANDWRITTEN_DECL)!;
      expect(rec.rank).toBe(1);
      expect(rec.finalChars).toBeGreaterThan(0);
    });
  });

  describe('the two penalties do not stack', () => {
    it('charges a generated declaration file once, at the stronger rate', () => {
      // A file that is BOTH generated and declaration-only has ONE property two
      // signals happen to see. Penalising twice (0.3 * 0.5 = 0.15) is how a file
      // gets cliffed out of answers where it is genuinely relevant.
      const rec = flow.report.files.find((f) => f.generated && f.ambientDeclaration);
      if (!rec) return; // not a candidate for this query — nothing to assert
      expect(rec.penalty).toBeGreaterThanOrEqual(0.3);
    });
  });
});
