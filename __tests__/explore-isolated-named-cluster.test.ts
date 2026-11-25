/**
 * Regression gate: a cluster holding only a named function must not lose its
 * file's budget to the incidental members of a cluster ranked above it.
 *
 * `handleExplore` ranks a file's clusters spine first, then by max importance,
 * then by DENSITY — summed member importance over span. Density counts every
 * member, so a named function (importance 10) with unrelated helpers merged
 * around it scores the helpers' definitions (1) and their edge lines (2) too,
 * and outranks a cluster holding the same kind of named function alone. Taken
 * whole, the higher clusters then spent the reservation on the helpers, and the
 * isolated named function below them rendered nothing: the query named five
 * functions and got two to four of them back, depending on the build.
 *
 * The fixture is that shape and nothing else: one file, five independent
 * exported functions the query names, three unrelated `headerSlotN` helpers
 * between each pair, and ~45 more helpers after them. Three controls pin that the
 * gate measures the ordering and not the budget:
 *
 *   - the same five functions CONTIGUOUS all render whole under the same
 *     reservation, so the budget holds the named bodies;
 *   - their rendered cost is well under the reservation, and the file is far
 *     over it, so something has to be dropped and it need not be a named body;
 *   - a query naming only `renderView` still renders the helpers merged around
 *     it: with nothing named below a cluster, its incidental context stays.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import type { ExploreDiagnosticReport } from '../src/mcp/explore-diagnostics';

const TARGET = 'lib/response.ts';
const NAMED = ['sendBody', 'sendJson', 'renderView', 'redirectTo', 'sendFileStream'];
const QUERY = NAMED.join(' ');
/** Statements per named body: 26 lines with the signature and closing brace. */
const BODY_STATEMENTS = 24;
const HELPERS_BETWEEN = 3;
const HELPERS_AFTER = 45;

/**
 * `lib/response.ts`. The helpers are the filler: never named, never called by a
 * named function, and wide enough that the named functions plus the helpers
 * merged around them overrun the file's reservation both at the 9,100-char
 * `MAX_SHARE` valve and at the ~12,800 a file the query named gets when the
 * valve is lifted for it — so the gate stays red without the fix either way.
 */
function responseSource(interleave: boolean): string {
  const out: string[] = [
    'export interface Res {',
    '  body: string[];',
    '  setHeader(name: string, value: string): void;',
    '}',
    '',
  ];
  let slot = 0;
  const helper = (): void => {
    slot++;
    out.push(`export function headerSlot${slot}(res: Res, value: string): void {`);
    for (let k = 0; k < 6; k++) {
      out.push(`  res.setHeader('x-slot-${slot}-${k}', \`max-age=31536000; includeSubDomains; preload; `
        + `report-uri=https://reports.example.test/csp/slot-${slot}/${k}?format=json&v=\${value}\`);`);
    }
    out.push('}', '');
  };
  NAMED.forEach((name, i) => {
    out.push(`export function ${name}(res: Res, payload: string): void {`);
    for (let k = 0; k < BODY_STATEMENTS; k++) out.push(`  res.body.push('${name}:${k}:' + payload);`);
    out.push('}', '');
    if (interleave && i < NAMED.length - 1) for (let h = 0; h < HELPERS_BETWEEN; h++) helper();
  });
  for (let h = 0; h < HELPERS_AFTER; h++) helper();
  return out.join('\n');
}

interface Run {
  dir: string;
  cg: CodeGraph;
  response: string;
  report: ExploreDiagnosticReport;
}

async function runExplore(interleave: boolean, query: string): Promise<Run> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-isolated-named-'));
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, TARGET), responseSource(interleave));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"isolated-named","version":"1.0.0"}\n');
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

/** Every `<n>\t<text>` line number the response sent. The fixture has one file. */
function renderedLines(response: string): Set<number> {
  const out = new Set<number>();
  for (const m of response.matchAll(/^(\d+)\t/gm)) out.add(Number(m[1]));
  return out;
}

function defOf(run: Run, name: string) {
  const node = run.cg.getNodesInFile(TARGET).find((n) => n.name === name && n.kind === 'function');
  expect(node, `${name} is not indexed in ${TARGET}`).toBeDefined();
  return node!;
}

/** Lines of `name`'s body the response carries, out of its full span. */
function coverage(run: Run, name: string): { got: number; of: number } {
  const node = defOf(run, name);
  const lines = renderedLines(run.response);
  let got = 0;
  for (let ln = node.startLine; ln <= node.endLine; ln++) if (lines.has(ln)) got++;
  return { got, of: node.endLine - node.startLine + 1 };
}

function targetFile(run: Run): ExploreDiagnosticReport['files'][number] {
  const file = run.report.files.find((f) => f.path === TARGET);
  expect(file, `${TARGET} is not among the ranked candidates`).toBeDefined();
  return file!;
}

describe('an isolated named cluster keeps its share of the file budget', () => {
  let run: Run;
  let contiguous: Run;

  beforeAll(async () => {
    run = await runExplore(true, QUERY);
    contiguous = await runExplore(false, QUERY);
  }, 120_000);

  afterAll(() => {
    teardown(run);
    teardown(contiguous);
  });

  describe('fixture shape — if this rots, the gate below means nothing', () => {
    it('puts unrelated helpers between every pair of named functions', () => {
      const helpers = run.cg.getNodesInFile(TARGET)
        .filter((n) => n.kind === 'function' && n.name.startsWith('headerSlot'));
      for (let i = 0; i + 1 < NAMED.length; i++) {
        const above = defOf(run, NAMED[i]!);
        const below = defOf(run, NAMED[i + 1]!);
        const between = helpers.filter((h) => h.startLine > above.endLine && h.endLine < below.startLine);
        expect(between.length, `${NAMED[i]} → ${NAMED[i + 1]}`).toBe(HELPERS_BETWEEN);
      }
    });

    it('names functions that do not call each other, so no call path ranks one first', () => {
      const ids = new Set(NAMED.map((name) => defOf(run, name).id));
      for (const name of NAMED) {
        const reaches = run.cg.getCallees(defOf(run, name).id).filter(({ node }) => ids.has(node.id));
        expect(reaches, name).toHaveLength(0);
      }
    });

    it('clusters a file far bigger than its reservation', () => {
      const file = targetFile(run);
      expect(file.render).toBe('clusters');
      expect(file.clipped).toBe(true);
      const size = fs.readFileSync(path.join(run.dir, TARGET), 'utf-8').length;
      expect(size).toBeGreaterThan(3 * file.allowance!);
    });

    it('holds the named bodies well inside that reservation', () => {
      // What the five bodies cost rendered: their lines, the three lines of
      // context padding on each side, and the `<n>\t` line-number prefix.
      const lines = fs.readFileSync(path.join(run.dir, TARGET), 'utf-8').split('\n');
      let cost = 0;
      for (const name of NAMED) {
        const node = defOf(run, name);
        for (let ln = node.startLine - 3; ln <= node.endLine + 3; ln++) {
          cost += (lines[ln - 1] ?? '').length + String(ln).length + 2;
        }
      }
      expect(cost).toBeLessThan(0.9 * targetFile(run).allowance!);
    });

    it('renders every named body whole when the same functions sit together', () => {
      expect(targetFile(contiguous).allowance).toBe(targetFile(run).allowance);
      for (const name of NAMED) {
        const { got, of } = coverage(contiguous, name);
        expect(got, `${name} (contiguous)`).toBe(of);
      }
    });
  });

  describe('the gate', () => {
    it('renders every named body whole with helpers between them', () => {
      for (const name of NAMED) {
        const { got, of } = coverage(run, name);
        expect(got, `${name}: ${got}/${of} lines`).toBe(of);
      }
    });

    it('keeps the response inside the hard ceiling', () => {
      expect(run.report.envelope.chars).toBeLessThanOrEqual(run.report.budget.hardCeiling);
    });
  });
});

/**
 * The same rule inside one cluster. A cluster taken after the first is bounded
 * by its room exactly, and its member shrink estimated on raw source, which runs
 * well under the rendered size: it kept the helpers merged above `renderView`,
 * overran the room, and the window back to it cut in source order — through the
 * last lines of `renderView`, the body the query named.
 */
describe('a named body in a later cluster is not trimmed for the helpers above it', () => {
  let run: Run;

  beforeAll(async () => {
    run = await runExplore(true, 'renderView redirectTo');
  }, 120_000);

  afterAll(() => teardown(run));

  it('renders both named bodies whole', () => {
    for (const name of ['renderView', 'redirectTo']) {
      const { got, of } = coverage(run, name);
      expect(got, `${name}: ${got}/${of} lines`).toBe(of);
    }
  });

  it('keeps the response inside the hard ceiling', () => {
    expect(run.report.envelope.chars).toBeLessThanOrEqual(run.report.budget.hardCeiling);
  });
});

describe('a named cluster with nothing named below it keeps its incidental context', () => {
  let run: Run;

  beforeAll(async () => {
    run = await runExplore(true, 'renderView');
  }, 120_000);

  afterAll(() => teardown(run));

  it('renders the helper merged in above renderView, not just renderView', () => {
    const view = coverage(run, 'renderView');
    expect(view.got).toBe(view.of);
    const target = defOf(run, 'renderView');
    const above = run.cg.getNodesInFile(TARGET)
      .filter((n) => n.kind === 'function' && n.name.startsWith('headerSlot') && n.endLine < target.startLine)
      .sort((a, b) => b.endLine - a.endLine)[0]!;
    const { got, of } = coverage(run, above.name);
    expect(got, `${above.name}: ${got}/${of} lines`).toBe(of);
  });
});
