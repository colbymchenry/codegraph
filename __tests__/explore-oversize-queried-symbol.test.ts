/**
 * A symbol the query asked for must render even when it alone overruns its
 * file's budget (#2486).
 *
 * `shrinkCluster` keeps the most important member of an oversize cluster even
 * if that member alone is too big — it is then windowed to the ceiling (CG-30)
 * rather than dropped. Which member is "the most important" was settled, among
 * members of equal importance, by the shorter span. So in a file that is one
 * long function plus the line that calls it,
 *
 *     def build_report(...):        # 200 statements, 15 KB
 *         ...
 *     if __name__ == '__main__':
 *         path = build_report()     # an entry point too: it matches the name
 *
 * the one-line `path` took the guarantee, the function then no longer fit, and
 * `codegraph_explore build_report` returned the last six lines of the file with
 * no line of `build_report` in them — under a header calling the block the
 * verbatim source. Asking for the file by path gave the same six lines.
 *
 * The exception that stays: a one-line symbol the query asked for, beside a
 * long function it did not, still renders alone.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

const STATEMENTS = 200;

function reportSource(): string {
  return [
    '"""Generate the phase-1 validation report as PDF."""',
    'from reportlab.platypus import SimpleDocTemplate',
    '',
    '',
    "def build_report(output_path: str = 'reports/report.pdf'):",
    '    """Build the phase-1 validation report as a PDF."""',
    '    doc = SimpleDocTemplate(output_path)',
    '    story = []',
    ...Array.from({ length: STATEMENTS }, (_, i) =>
      `    story.append(Paragraph(f'section ${i} of the report', styles['BodyText']))`),
    '    doc.build(story)',
    '    return output_path',
    '',
    '',
    "if __name__ == '__main__':",
    '    path = build_report()',
    '    print(path)',
    '',
  ].join('\n');
}

/** A constant the query can name, right above a long function that has nothing to do with it. */
function limitsSource(): string {
  return [
    '"""Limits for the report."""',
    '',
    'MAX_SECTIONS = 5',
    '',
    'def render_everything(doc):',
    ...Array.from({ length: STATEMENTS }, (_, i) =>
      `    doc.write(f'unrelated statement number ${i} of the long neighbour function')`),
    '    return doc',
    '',
  ].join('\n');
}

describe('#2486 — a queried symbol too big for its file\'s budget still renders', () => {
  let testDir: string;
  let cg: CodeGraph;
  let response: string;
  let explore: (query: string) => Promise<string>;

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-2486-'));
    fs.writeFileSync(path.join(testDir, 'report_gen.py'), reportSource());
    fs.writeFileSync(path.join(testDir, 'limits.py'), limitsSource());
    cg = CodeGraph.initSync(testDir);
    await cg.indexAll();
    // A handler per call: a session that already holds a file's lines elides them.
    explore = async (query) =>
      (await new ToolHandler(cg).execute('codegraph_explore', { query })).content?.[0]?.text ?? '';
    response = await explore('build_report');
  }, 120_000);

  afterAll(() => {
    if (cg) cg.destroy();
    if (testDir && fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('fixture shape: the function alone is bigger than the whole response budget', () => {
    const fn = cg.getNodesInFile('report_gen.py').find((n) => n.name === 'build_report' && n.kind === 'function')!;
    expect(fn.startLine).toBe(5);
    expect(fn.endLine - fn.startLine + 1).toBeGreaterThan(STATEMENTS);
    expect(reportSource().length).toBeGreaterThan(13_000);
  });

  it('renders the definition and the start of its body, not only the file tail', () => {
    expect(response).toContain("def build_report(output_path: str = 'reports/report.pdf'):");
    expect(response).toContain('doc = SimpleDocTemplate(output_path)');
    expect(response).toContain('section 0 of the report');
  });

  it('still shows the call site, and says the body was cut', () => {
    expect(response).toContain('path = build_report()');
    expect(response).toContain('Some file sections were trimmed for size');
  });

  it('stays inside the response ceiling', () => {
    // The <150-file tier: 13,000 budget, hard ceiling 1.5x.
    expect(response.length).toBeLessThanOrEqual(19_500);
  });

  it('a file asked for by path renders from its first definition, not its tail', async () => {
    const byPath = await explore('report_gen.py');
    expect(byPath).toContain("def build_report(output_path: str = 'reports/report.pdf'):");
    expect(byPath).toContain('section 0 of the report');
    expect(byPath.length).toBeLessThanOrEqual(19_500);
  });

  it('a one-line symbol the query asked for still renders without its long neighbour', async () => {
    const constant = await explore('MAX_SECTIONS');
    expect(constant).toContain('MAX_SECTIONS = 5');
    expect(constant).not.toContain('unrelated statement number 100');
  });
});
