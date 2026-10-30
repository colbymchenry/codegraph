/**
 * A symbol the query asks for renders even when it is too long for its file's
 * share of the answer, and the block says where it was cut (#2486).
 *
 * `shrinkCluster` keeps the first-ranked member of an oversize cluster however
 * big it is and lets the ceiling window it (CG-30). Among members of one
 * importance, the shorter span ranked first. So in a file that is one long
 * function plus the line that calls it,
 *
 *     def build_report(...):        # 200 statements, 15 KB
 *         ...
 *     if __name__ == '__main__':
 *         path = build_report()     # a search hit too: its signature names it
 *
 * the one-line `path` took that guarantee, the function then did not fit beside
 * it, and `codegraph_explore build_report` returned the file's last six lines,
 * under a header calling the block the verbatim source. Asking for the file by
 * path did the same. A body the window does cut now carries the line range and
 * the explore query that returns the rest, since asking for the symbol by name
 * again returns the same window.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

const STATEMENTS = 200;
const DEF = "def build_report(output_path: str = 'reports/report.pdf'):";

/** The issue's own reproducer, line for line. */
function reportSource(): string {
  return [
    '"""Generate the phase-1 validation report as PDF."""',
    'from reportlab.platypus import SimpleDocTemplate',
    '',
    '',
    DEF,
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

/**
 * The long function, then a 27-line function the search matches only through
 * its docstring. Not a fragment, so nothing but rank decides which of the two
 * the cluster keeps.
 */
function publishSource(): string {
  return [
    '"""Report generation."""',
    '',
    '',
    DEF,
    '    """Build the phase-1 validation report as a PDF."""',
    '    story = []',
    ...Array.from({ length: 260 }, (_, i) =>
      `    story.append(Paragraph(f'section ${i} of the report body', styles['BodyText']))`),
    '    return output_path',
    '',
    '',
    'def publish():',
    '    """Run build_report and copy the result where readers find it."""',
    '    target = build_report()',
    ...Array.from({ length: 24 }, (_, i) => `    print('publishing step ${i} of the release checklist', target)`),
    '    return target',
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

type Project = { dir: string; cg: CodeGraph };

async function project(files: Record<string, string>): Promise<Project> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-2486-'));
  for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), text);
  const cg = CodeGraph.initSync(dir);
  await cg.indexAll();
  return { dir, cg };
}

function destroy(p: Project | undefined): void {
  if (!p) return;
  p.cg.destroy();
  fs.rmSync(p.dir, { recursive: true, force: true });
}

/** A handler per call: a session that already holds a file's lines elides them. */
async function explore(p: Project, query: string): Promise<string> {
  const result = await new ToolHandler(p.cg).execute('codegraph_explore', { query });
  return result.content?.[0]?.text ?? '';
}

/** The `<n>\t<line>` form explore renders a source line in. */
const rendered = (n: number, line: string): string => `${n}\t${line}`;

describe('#2486 — the queried symbol renders when it alone overruns its file\'s budget', () => {
  let report: Project | undefined;
  let byName = '';
  // The default tool surface: a shell that exports an allowlist must not change what this asserts.
  const allowlist = process.env.CODEGRAPH_MCP_TOOLS;

  beforeAll(async () => {
    delete process.env.CODEGRAPH_MCP_TOOLS;
    report = await project({ 'report_gen.py': reportSource() });
    byName = await explore(report, 'build_report');
  }, 120_000);
  afterAll(() => {
    destroy(report);
    if (allowlist === undefined) delete process.env.CODEGRAPH_MCP_TOOLS;
    else process.env.CODEGRAPH_MCP_TOOLS = allowlist;
  });

  it('fixture shape: one function far bigger than the whole response budget, beside a one-line search hit', () => {
    const nodes = report!.cg.getNodesInFile('report_gen.py');
    const fn = nodes.find((n) => n.name === 'build_report' && n.kind === 'function')!;
    expect(fn.startLine).toBe(5);
    expect(fn.endLine).toBe(STATEMENTS + 10);
    expect(reportSource().length).toBeGreaterThan(13_000);
    // The search matches the variable through its signature, `= build_report()`.
    const hit = nodes.find((n) => n.name === 'path')!;
    expect(hit.startLine).toBe(hit.endLine);
    expect(hit.startLine - fn.endLine).toBeLessThan(7);
  });

  it('renders the definition and the head of its body, not the file tail', () => {
    expect(byName).toContain(rendered(5, DEF));
    expect(byName).toContain("section 0 of the report'");
    expect(byName.length).toBeLessThanOrEqual(19_500);
  });

  it('says inside the block where the body was cut, and that query returns the rest', async () => {
    const note = byName.match(/… lines (\d+)-(\d+) of `build_report` elided — codegraph_explore `(report_gen\.py:\d+-\d+)` returns them/);
    expect(note, 'no cut note in:\n' + byName.slice(-1500)).not.toBeNull();
    const [, from, to, followUp] = note!;
    expect(Number(to)).toBe(STATEMENTS + 10);
    // The note sits right after the last line shown.
    expect(byName).toContain(`${Number(from) - 1}\t`);
    expect(byName).not.toContain(`\n${from}\t`);
    const rest = await explore(report!, followUp!);
    expect(rest).toContain(rendered(Number(from), `    story.append(Paragraph(f'section ${Number(from) - 9} of the report', styles['BodyText']))`));
    expect(rest).toContain(rendered(STATEMENTS + 10, '    return output_path'));
  });

  it('names no follow-up tool the default surface does not list', () => {
    expect(byName).toContain('Some file sections were trimmed for size');
    expect(byName).not.toContain('codegraph_node');
  });

  it('a file asked for by path renders from its first definition, not its tail', async () => {
    const byPath = await explore(report!, 'report_gen.py');
    expect(byPath).toContain(rendered(5, DEF));
    expect(byPath).toContain("section 0 of the report'");
    expect(byPath).toContain('of `build_report` elided — codegraph_explore `report_gen.py:');
    expect(byPath.length).toBeLessThanOrEqual(19_500);
  });

  it('a query naming the one-liner too still renders the function', async () => {
    const both = await explore(report!, 'build_report path');
    expect(both).toContain(rendered(5, DEF));
    expect(both).toContain("section 0 of the report'");
  });

  it('still names codegraph_node when the tool is served', async () => {
    process.env.CODEGRAPH_MCP_TOOLS = 'explore,node';
    try {
      expect(await explore(report!, 'build_report')).toContain('(or `codegraph_node`)');
    } finally {
      delete process.env.CODEGRAPH_MCP_TOOLS;
    }
  });
});

describe('#2486 — a name the query spelled outranks a search hit of the same importance', () => {
  let publish: Project | undefined;
  afterAll(() => destroy(publish));

  it('renders the named function, not only the docstring match beside it', async () => {
    publish = await project({ 'report_gen.py': publishSource() });
    const text = await explore(publish, 'build_report');
    expect(text).toContain(rendered(4, DEF));
    expect(text).toContain("section 0 of the report body'");
    expect(text).toContain('of `build_report` elided — codegraph_explore `report_gen.py:');
  }, 120_000);
});

describe('#2486 — what the query did not ask for is left as it was', () => {
  let limits: Project | undefined;
  afterAll(() => destroy(limits));

  it('a one-line constant the query names renders without the long function beside it', async () => {
    limits = await project({ 'limits.py': limitsSource() });
    const text = await explore(limits, 'MAX_SECTIONS');
    expect(text).toContain(rendered(3, 'MAX_SECTIONS = 5'));
    expect(text).not.toContain('unrelated statement number 100');
  }, 120_000);
});
