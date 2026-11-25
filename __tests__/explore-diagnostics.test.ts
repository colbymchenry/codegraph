/**
 * Per-file allocation diagnostic for codegraph_explore (CG-4).
 *
 * The instrument ships in the product binary, so the load-bearing property is
 * NOT what it reports — it's that it reports NOTHING unless asked. An explore
 * response is the agent's context; a diagnostic that perturbs it by one byte
 * invalidates every A/B measurement taken with it on, which is the exact thing
 * the rest of the budget-allocation work depends on.
 *
 * So the first block pins byte-identical output across on/off, and only then
 * do we assert the report's shape and internal consistency.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ToolHandler } from '../src/mcp/tools';
import { attributeSourceBytes } from '../src/mcp/explore-diagnostics';
import CodeGraph from '../src/index';

const DEBUG_ENV = 'CODEGRAPH_EXPLORE_DEBUG';

/** Restore the env var to "unset" — `delete` matters; '' is a distinct case. */
function clearDebugEnv(): void {
  delete process.env[DEBUG_ENV];
}

describe('attributeSourceBytes', () => {
  it('attributes a fenced block to the file section header above it', () => {
    const text = [
      '**Exploration: x**',
      '',
      '**`src/a.ts`** — foo(function)',
      '',
      '```typescript',
      '1\tconst a = 1;',
      '2\tconst b = 2;',
      '```',
      '',
      '**`src/b.ts`** — bar(function)',
      '',
      '```typescript',
      '1\tconst c = 3;',
      '```',
      '',
    ].join('\n');
    const bytes = attributeSourceBytes(text);
    expect(bytes.get('src/a.ts')).toBe('1\tconst a = 1;\n2\tconst b = 2;'.length);
    expect(bytes.get('src/b.ts')).toBe('1\tconst c = 3;'.length);
  });

  it('sums multiple fenced blocks under one file header', () => {
    const text = [
      '**`src/a.ts`** — foo(function)',
      '',
      '```ts',
      'aa',
      '```',
      '',
      '```ts',
      'bbb',
      '```',
    ].join('\n');
    expect(attributeSourceBytes(text).get('src/a.ts')).toBe('aa'.length + 'bbb'.length);
  });

  it('counts an unterminated block — the ceiling can cut mid-fence', () => {
    const text = ['**`src/a.ts`** — foo(function)', '', '```ts', 'x'.repeat(40)].join('\n');
    expect(attributeSourceBytes(text).get('src/a.ts')).toBe(40);
  });

  it('returns nothing for text with no file sections', () => {
    expect(attributeSourceBytes('No relevant code found for "zzz"').size).toBe(0);
    expect(attributeSourceBytes('').size).toBe(0);
  });
});

describe('codegraph_explore allocation diagnostic', () => {
  let testDir: string;
  let sidecarDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  const QUERY = 'Session method helper callSession';

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-explore-diag-'));
    sidecarDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-explore-diag-out-'));
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);

    // One fat file plus several small callers, so the render loop exercises
    // more than one allocation branch (clusters for the fat file, whole-file
    // for the small ones) and there is a real per-file split to report.
    const fatLines: string[] = ['export class Session {'];
    for (let i = 0; i < 30; i++) {
      fatLines.push(`  method${i}(arg: string): string {`);
      fatLines.push(`    return this.helper${i}(arg) + "${i}";`);
      fatLines.push(`  }`);
      fatLines.push(`  private helper${i}(arg: string): string {`);
      fatLines.push(`    return arg.repeat(${i + 1});`);
      fatLines.push(`  }`);
    }
    fatLines.push('}');
    fs.writeFileSync(path.join(srcDir, 'session.ts'), fatLines.join('\n'));

    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(
        path.join(srcDir, `support${i}.ts`),
        `import { Session } from './session';\n` +
        `export function callSession${i}(s: Session) {\n` +
        `  return s.method${i}('hi');\n` +
        `}\n`,
      );
    }

    clearDebugEnv();
    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    clearDebugEnv();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    clearDebugEnv();
    if (cg) cg.destroy();
    for (const dir of [testDir, sidecarDir]) {
      if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const explore = async (): Promise<string> => {
    const result = await handler.execute('codegraph_explore', { query: QUERY });
    return result.content?.[0]?.text ?? '';
  };

  it('produces byte-identical output whether the diagnostic is on or off', async () => {
    clearDebugEnv();
    const off = await explore();
    expect(off.length).toBeGreaterThan(0);

    // Sanity: the tool itself is deterministic, so a difference below is
    // attributable to the diagnostic and not to explore's own variance.
    expect(await explore()).toBe(off);

    vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as typeof process.stderr.write);
    const sidecar = path.join(sidecarDir, 'identical.jsonl');
    for (const value of ['1', 'json', sidecar]) {
      process.env[DEBUG_ENV] = value;
      const on = await explore();
      clearDebugEnv();
      expect(on).toBe(off);
    }
  });

  it('writes nothing to stderr when the env var is unset', async () => {
    clearDebugEnv();
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    await explore();
    expect(writes.join('')).toBe('');
  });

  it('stays off for every falsy env value', async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    for (const value of ['', '0', 'false', 'off', 'no', 'OFF', ' 0 ']) {
      process.env[DEBUG_ENV] = value;
      await explore();
    }
    expect(writes.join('')).toBe('');
  });

  it('prints a per-file table to stderr when enabled', async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    process.env[DEBUG_ENV] = '1';
    await explore();
    const out = writes.join('');

    expect(out).toContain('codegraph explore diagnostic');
    // Totals: envelope vs budget, and the file-selection funnel with its floor.
    expect(out).toMatch(/envelope [\d,]+ chars delivered · [\d,]+ allocated of [\d,]+ budget/);
    expect(out).toMatch(/hard ceiling [\d,]+/);
    // The funnel runs low-value filter → score floor; the floor is fractional
    // now that scoring is kind-weighted (CG-10).
    expect(out).toMatch(
      /files [\d,]+ grouped .*past low-value filter .*past score floor \(>=[\d.]+\).*in output \(maxFiles \d+\)/,
    );
    // Per-file columns.
    expect(out).toMatch(/#\s+alloc%\s+deliv%\s+bytes\s+reserved\s+score\s+graph\s+hits\s+pen\s+flags\s+render\s+file/);
    // The proportional split (CG-12): what was reserved, and where the cliff fell.
    expect(out).toMatch(/allocation [\d,]+ reserved of [\d,]+ pool · cliff at weight [\d.]+/);
    expect(out).toContain('src/session.ts');
    expect(out).toMatch(/\d+\.\d%/);
    // Kind mix — what each file's score was bought with.
    expect(out).toMatch(/kinds: (?:\w+:\d+ ?)+/);
  });

  it('appends one JSON report per call to a sidecar path', async () => {
    const sidecar = path.join(sidecarDir, 'reports.jsonl');
    process.env[DEBUG_ENV] = sidecar;
    await explore();
    await explore();
    clearDebugEnv();

    const rows = fs.readFileSync(sidecar, 'utf-8').trim().split('\n');
    expect(rows).toHaveLength(2);

    const report = JSON.parse(rows[0]!);
    expect(report.tool).toBe('codegraph_explore');
    expect(report.query).toBe(QUERY);

    // Totals the task asks for: envelope vs maxOutputChars, files considered
    // vs included, and the score floor that was applied.
    expect(report.budget.maxOutputChars).toBeGreaterThan(0);
    expect(report.envelope.chars).toBeGreaterThan(0);
    expect(report.selection.scoreFloor).toBeGreaterThan(0);
    expect(report.selection.filesGrouped).toBeGreaterThanOrEqual(report.selection.filesPastLowValueFilter);
    expect(report.selection.filesPastLowValueFilter).toBeGreaterThanOrEqual(report.selection.filesPastScoreFloor);
    expect(report.selection.filesPastScoreFloor).toBeGreaterThanOrEqual(report.selection.filesRanked);
    expect(report.selection.filesRanked).toBeGreaterThanOrEqual(report.selection.filesInFinalOutput);
    expect(report.selection.filesInFinalOutput).toBeGreaterThan(0);
    expect(report.selection.filesInFinalOutput).toBeLessThanOrEqual(report.budget.maxFiles);

    // Per-file: score, bytes, share, clipped, spine.
    const shown = report.files.filter((f: { finalChars: number }) => f.finalChars > 0);
    expect(shown.length).toBeGreaterThan(0);
    for (const f of shown) {
      expect(typeof f.path).toBe('string');
      expect(typeof f.score).toBe('number');
      expect(typeof f.graphScore).toBe('number');
      expect(typeof f.clipped).toBe('boolean');
      expect(typeof f.spine).toBe('boolean');
      expect(f.finalChars).toBeGreaterThan(0);
      expect(f.share).toBeGreaterThan(0);
      expect(f.share).toBeLessThanOrEqual(1);
      expect(f.render).toBeTruthy();
    }
    expect(shown.some((f: { path: string }) => f.path === 'src/session.ts')).toBe(true);
  });

  it('attributes the envelope consistently — per-file bytes sum to the reported source total', async () => {
    const sidecar = path.join(sidecarDir, 'consistency.jsonl');
    process.env[DEBUG_ENV] = sidecar;
    const text = await explore();
    clearDebugEnv();

    const report = JSON.parse(fs.readFileSync(sidecar, 'utf-8').trim());
    expect(report.envelope.chars).toBe(text.length);

    const summed = report.files.reduce(
      (s: number, f: { finalChars: number }) => s + f.finalChars, 0,
    );
    expect(summed).toBe(report.envelope.sourceChars);
    expect(report.envelope.sourceChars + report.envelope.metaChars).toBe(report.envelope.chars);
    // Shares are fractions of the delivered envelope, so they can't exceed it.
    const shareSum = report.files.reduce((s: number, f: { share: number }) => s + f.share, 0);
    expect(shareSum).toBeLessThanOrEqual(1.0001);
    expect(shareSum).toBeCloseTo(report.envelope.sourceShare, 3);
  });

  it('survives an unwritable sink without failing the explore call', async () => {
    clearDebugEnv();
    const expected = await explore();

    // A directory is never a valid append target.
    process.env[DEBUG_ENV] = sidecarDir;
    const result = await handler.execute('codegraph_explore', { query: QUERY });
    clearDebugEnv();

    expect(result.isError).toBeFalsy();
    expect(result.content?.[0]?.text).toBe(expected);
  });

  it('records a report even when explore finds nothing', async () => {
    const sidecar = path.join(sidecarDir, 'empty.jsonl');
    process.env[DEBUG_ENV] = sidecar;
    const result = await handler.execute('codegraph_explore', {
      query: 'zzzznonexistentsymbolzzzz',
    });
    clearDebugEnv();

    expect(result.content?.[0]?.text).toContain('No relevant code found');
    const report = JSON.parse(fs.readFileSync(sidecar, 'utf-8').trim());
    expect(report.note).toContain('no relevant code found');
    expect(report.files).toEqual([]);
  });
});
