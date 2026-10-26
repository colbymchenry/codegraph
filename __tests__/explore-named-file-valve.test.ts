/**
 * A file the query NAMED may draw on the call's unspent budget past the
 * `MAX_SHARE` valve — and only on budget no other file is owed.
 *
 * The valve caps any one file at 70% of the envelope, as a hedge against a
 * mis-ranked dominant file. It never redistributed: a clamped file's excess was
 * left unreserved, and the render loop's carry-forward only moves
 * reservations, so nothing could spend it. On express, "response.js res.send
 * res.json res.render res.redirect res.sendFile res.format" admits one file,
 * clamps it at 9,100 with 3,700 of the pool unreserved, and cut the named
 * `send` body at 55 of 97 lines in a 10.9K response to a 13K budget.
 *
 * Two halves, each with a fixture that goes red when that half is removed:
 *
 *  1. **Far from spent.** One file, five named functions whose bodies together
 *     overrun the valve but not the budget. Pre-change (and with either the
 *     allocator exemption or the render-loop extension removed): 3 of 5 bodies
 *     complete. With both: 5 of 5.
 *
 *  2. **Saturated.** The 24K tier, a dominant named file and a lower admitted
 *     file, the response at the inline cap. The extension must come out of
 *     SPARE budget only. Bounded by `fundedHeadroom` instead, the lower file
 *     was dropped whole; bounded by the render ceiling instead of the budget,
 *     it was cut to 74% of its reservation by the named file's render
 *     overshoot. Both variants were measured, and are what the assertions
 *     below exclude.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler, EXPLORE_ALLOCATION } from '../src/mcp/tools';
import type { ExploreDiagnosticReport } from '../src/mcp/explore-diagnostics';

interface Project { dir: string; cg: CodeGraph }

async function buildProject(files: Record<string, string>): Promise<Project> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-named-valve-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  const cg = CodeGraph.initSync(dir);
  await cg.indexAll();
  return { dir, cg };
}

function destroyProject(p?: Project): void {
  if (!p) return;
  p.cg.destroy();
  if (fs.existsSync(p.dir)) fs.rmSync(p.dir, { recursive: true, force: true });
}

async function explore(p: Project, query: string) {
  const sidecar = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-named-valve-diag-')), 'r.jsonl');
  const previous = process.env.CODEGRAPH_EXPLORE_DEBUG;
  process.env.CODEGRAPH_EXPLORE_DEBUG = sidecar;
  let text = '';
  try {
    const res = await new ToolHandler(p.cg).execute('codegraph_explore', { query });
    text = res.content?.[0]?.text ?? '';
  } finally {
    if (previous === undefined) delete process.env.CODEGRAPH_EXPLORE_DEBUG;
    else process.env.CODEGRAPH_EXPLORE_DEBUG = previous;
  }
  const lines = fs.readFileSync(sidecar, 'utf-8').trim().split('\n').filter(Boolean);
  fs.rmSync(path.dirname(sidecar), { recursive: true, force: true });
  const report = JSON.parse(lines[lines.length - 1]!) as ExploreDiagnosticReport;
  return { text, report, file: (fp: string) => report.files.find((f) => f.path === fp) };
}

/** Names whose whole definition in `file` did NOT reach the response. */
function incompleteBodies(p: Project, response: string, file: string, names: string[]): string[] {
  const sent = new Set<number>();
  let current: string | null = null;
  let inFence = false;
  for (const line of response.split('\n')) {
    const header = !inFence ? line.match(/^\*\*`([^`]+)`\*\*/) : null;
    if (header) { current = header[1]!; continue; }
    if (line.startsWith('```')) { inFence = !inFence; continue; }
    const m = inFence && current === file ? line.match(/^(\d+)\t/) : null;
    if (m) sent.add(Number(m[1]));
  }
  return names.filter((name) => {
    const node = p.cg.getNodesInFile(file).find((n) => n.name === name);
    expect(node, `${name} is not indexed in ${file}`).toBeDefined();
    for (let l = node!.startLine; l <= node!.endLine; l++) if (!sent.has(l)) return true;
    return false;
  });
}

// ── 1. Far from spent ───────────────────────────────────────────────────────

describe('a named file far from its budget draws past the valve', () => {
  const FILE = 'lib/response.ts';
  const NAMED = ['sendBody', 'sendJson', 'renderView', 'redirectTo', 'sendFileStream'];

  /** Five independent named functions, then unrelated header helpers. */
  function responseSource(): string {
    const L = ['export interface Res { headers: Record<string, string>; body: string[]; status: number }', ''];
    for (const n of NAMED) {
      L.push(`export function ${n}(res: Res, payload: unknown): Res {`);
      for (let i = 0; i < 33; i++) L.push(`  res.body.push(String(payload ?? '').slice(${i}, ${i + 7}) + '${n}:${i}');`);
      L.push('  return res;', '}', '');
    }
    for (let i = 0; i < 60; i++) {
      L.push(`export function headerSlot${i}(res: Res, value: string): Res {`);
      for (let k = 0; k < 6; k++) L.push(`  res.headers['x-slot-${i}-${k}'] = value.slice(${k}, ${k + 3});`);
      L.push('  return res;', '}', '');
    }
    return L.join('\n');
  }

  let p: Project;
  let r: Awaited<ReturnType<typeof explore>>;

  beforeAll(async () => {
    p = await buildProject({ [FILE]: responseSource() });
    r = await explore(p, NAMED.join(' '));
  }, 120_000);
  afterAll(() => destroyProject(p));

  it('fixture shape: the named bodies overrun the valve, not the budget', () => {
    const valve = Math.round(r.report.budget.maxOutputChars * EXPLORE_ALLOCATION.MAX_SHARE);
    const source = fs.readFileSync(path.join(p.dir, FILE), 'utf-8').split('\n');
    const bodies = NAMED.map((name) => p.cg.getNodesInFile(FILE).find((n) => n.name === name)!)
      .reduce((sum, n) => sum + source.slice(n.startLine - 1, n.endLine).join('\n').length, 0);
    expect(r.report.budget.maxOutputChars).toBe(13000);
    expect(bodies).toBeGreaterThan(valve);
    expect(bodies).toBeLessThan(r.report.budget.maxOutputChars);
    // No flow among them: the spine's own 1.5x overshoot is not what pays here.
    expect(r.file(FILE)?.spine).toBe(false);
  });

  it('may spend past the valve', () => {
    const valve = Math.round(r.report.budget.maxOutputChars * EXPLORE_ALLOCATION.MAX_SHARE);
    expect(r.file(FILE)?.spendable ?? 0).toBeGreaterThan(valve);
  });

  it('returns every named body', () => {
    expect(incompleteBodies(p, r.text, FILE, NAMED)).toEqual([]);
  });

  it('stays inside the response ceiling', () => {
    expect(r.report.envelope.chars).toBeLessThanOrEqual(r.report.budget.hardCeiling);
  });
});

// ── 2. Saturated ────────────────────────────────────────────────────────────

describe('a named file on a saturated response takes nothing a lower file is owed', () => {
  const NAMED_FILE = 'src/store/query.ts';
  const LOWER = 'src/admin/listFilter.ts';
  const METHODS = ['filter', 'exclude', 'annotate', 'orderBy', 'distinct', 'values', 'only', 'defer'];

  /** A QuerySet whose named methods are interleaved with unrelated cache slots. */
  function querySource(): string {
    const L = [
      'export class QuerySet {',
      '  steps: Array<{ op: string; at: number; arg: unknown }> = [];',
      '',
      '  chain(op: string): QuerySet {',
      '    const next = new QuerySet();',
      '    next.steps = [...this.steps];',
      '    return next;',
      '  }',
    ];
    let slot = 0;
    const cacheSlot = () => {
      const i = slot++;
      L.push('', `  cacheSlot${i}(key: string): string {`);
      for (let k = 0; k < 8; k++) L.push(`    key = key.padStart(${k + (i % 7)}, '${String.fromCharCode(97 + ((i + k) % 26))}');`);
      L.push('    return key;', '  }');
    };
    for (const name of METHODS) {
      L.push('', `  ${name}(...args: unknown[]): QuerySet {`, `    const clone = this.chain('${name}');`);
      for (let i = 0; i < 40; i++) L.push(`    clone.steps.push({ op: '${name}', at: ${i}, arg: args[${i % 3}] ?? null });`);
      L.push('    return clone;', '  }');
      cacheSlot();
      cacheSlot();
    }
    while (slot < 70) cacheSlot();
    L.push('}');
    return L.join('\n') + '\n';
  }

  function listFilterSource(): string {
    return [
      'import { QuerySet } from "../store/query";',
      '',
      'export class ListFilter {',
      '  constructor(private readonly field: string) {}',
      '',
      '  queryset(qs: QuerySet, params: Record<string, string>): QuerySet {',
      ...Array.from({ length: 30 }, (_, i) => `    if (params['p${i}']) qs = qs.filter(this.field, params['p${i}'], ${i});`),
      '    return qs.distinct();',
      '  }',
      '}',
      '',
    ].join('\n');
  }

  let p: Project;
  let r: Awaited<ReturnType<typeof explore>>;

  beforeAll(async () => {
    const files: Record<string, string> = { [NAMED_FILE]: querySource(), [LOWER]: listFilterSource() };
    // Into the >=500-file tier: at 13K the ceiling sits 50% over the budget
    // and a lower file always has room; at 24K it sits 4% over, as on django.
    for (let i = 0; i < 520; i++) files[`src/pad/pad${i}.ts`] = `export const pad${i} = ${i};\n`;
    p = await buildProject(files);
    r = await explore(p, METHODS.map((m) => `QuerySet.${m}`).join(' '));
  }, 120_000);
  afterAll(() => destroyProject(p));

  it('fixture shape: the 24K tier, a lower file with a reservation', () => {
    expect(r.report.budget.maxOutputChars).toBe(24000);
    expect(r.file(LOWER)?.allowance ?? 0).toBeGreaterThan(EXPLORE_ALLOCATION.MIN_CHARS);
  });

  it('still extends the named file past the valve, into a saturated response — the guard is not vacuous', () => {
    const valve = Math.round(r.report.budget.maxOutputChars * EXPLORE_ALLOCATION.MAX_SHARE);
    expect(r.file(NAMED_FILE)?.spendable ?? 0).toBeGreaterThan(valve);
    expect(r.report.envelope.chars).toBeGreaterThan(r.report.budget.maxOutputChars);
  });

  it('delivers the lower file at least its reservation', () => {
    const lower = r.file(LOWER);
    expect(lower?.skipped ?? null).toBeNull();
    // Funded in full: the named file above took nothing the lower file is owed.
    expect(lower?.funded ?? 0).toBeGreaterThanOrEqual(lower?.allowance ?? Infinity);
    // And delivered in full, to the line: a render stops at the last WHOLE line
    // that fits (#2062), so it may come in under its reservation by less than
    // one line, never by more. More is the final ceiling fit taking source to
    // pay for a header that ran past its estimate — 922 of 1,031 here, once an
    // exact target's overshoot (#2063) spent the named file to its funded line.
    const oneLine = Math.max(...listFilterSource().split('\n').map((l, i) => l.length + String(i + 1).length + 2));
    expect(lower?.emittedChars ?? 0).toBeGreaterThan((lower?.allowance ?? Infinity) - oneLine);
  });

  it('stays inside the inline cap', () => {
    expect(r.text.length).toBeLessThanOrEqual(25000);
  });
});
