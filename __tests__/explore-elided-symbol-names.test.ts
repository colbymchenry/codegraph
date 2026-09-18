/**
 * Regression for #1711 — when codegraph_explore trims a file, elided symbols
 * must be named (gap markers + header bias), not left as a bare `... (gap) ...`
 * while the footer asks for "exact names" the model was never given.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import {
  ToolHandler,
  formatGapMarker,
  symbolsBetweenRanges,
  biasHeaderSymbols,
  joinPartsWithNamedGaps,
} from '../src/mcp/tools';

describe('#1711 helpers — name what a trim dropped', () => {
  it('formatGapMarker stays bare when the hole has no symbols', () => {
    expect(formatGapMarker('a.ts', [])).toBe('\n\n... (gap) ...\n\n');
  });

  it('formatGapMarker lists name (file:line) for elided symbols', () => {
    const marker = formatGapMarker('src/obs.ts', [
      { name: 'syncStateNow', kind: 'method', startLine: 1913 },
      { name: 'performHeavyDraftSync', kind: 'method', startLine: 1867 },
    ]);
    expect(marker).toContain('syncStateNow (src/obs.ts:1913)');
    expect(marker).toContain('performHeavyDraftSync (src/obs.ts:1867)');
    expect(marker).toMatch(/\.\.\. \(gap: .+\) \.\.\./);
  });

  it('symbolsBetweenRanges only returns defs that start in the hole', () => {
    const nodes = [
      { name: 'keep', kind: 'method', startLine: 10, endLine: 20 },
      { name: 'elided', kind: 'method', startLine: 30, endLine: 40 },
      { name: 'also', kind: 'method', startLine: 45, endLine: 50 },
      { name: 'later', kind: 'method', startLine: 60, endLine: 70 },
      { name: 'imp', kind: 'import', startLine: 35, endLine: 35 },
    ];
    const hit = symbolsBetweenRanges(nodes, 20, 60);
    expect(hit.map((h) => h.name)).toEqual(['elided', 'also']);
  });

  it('biasHeaderSymbols prefers elided labels over frequency alone', () => {
    const { shown } = biasHeaderSymbols(
      [
        'imports0(method)', 'imports0(method)', 'imports0(method)',
        'imports1(method)', 'imports1(method)',
        'noise(method)',
      ],
      [{ name: 'syncStateNow', kind: 'method', startLine: 100 }],
      3,
    );
    expect(shown[0]).toBe('syncStateNow(method)');
    expect(shown).toContain('imports0(method)');
  });

  it('joinPartsWithNamedGaps annotates the hole between parts', () => {
    const text = joinPartsWithNamedGaps(
      'f.ts',
      [
        { range: { start: 1, end: 5 }, text: 'ONE' },
        { range: { start: 40, end: 45 }, text: 'TWO' },
      ],
      [{ name: 'mid', kind: 'function', startLine: 20, endLine: 25 }],
    );
    expect(text).toContain('ONE');
    expect(text).toContain('TWO');
    expect(text).toContain('mid (f.ts:20)');
  });
});

describe('#1711 explore — trimmed file names its elisions', () => {
  let dir: string;
  let cg: CodeGraph;
  let response: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-1711-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"cg1711","version":"1.0.0"}\n');
    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir);
    // One large observer + noise files so the budget trims rather than shipping whole.
    const lines: string[] = ['export class EspnDraftObserver {'];
    for (let i = 0; i < 40; i++) {
      lines.push(`  imports${i}() { return ${i}; }`, '');
    }
    const big = (name: string, next: string | null, n: number) => {
      lines.push(`  ${name}() {`);
      lines.push(`    const marker = "${name}_MARKER";`);
      for (let j = 0; j < n; j++) lines.push(`    const x${j} = ${j} + marker.length;`);
      lines.push(next ? `    return this.${next}();` : '    return marker;');
      lines.push('  }', '');
    };
    big('persistDraftState', null, 60);
    big('performHeavyDraftSync', 'persistDraftState', 60);
    big('syncStateNow', 'performHeavyDraftSync', 60);
    big('scrapeFullDraftState', 'syncStateNow', 60);
    for (let i = 0; i < 30; i++) {
      lines.push(`  calls${i}() { return ${i}; }`, '');
    }
    lines.push('}', '');
    fs.writeFileSync(path.join(srcDir, 'espn-draft-observer.ts'), lines.join('\n'));
    for (let i = 1; i <= 20; i++) {
      fs.writeFileSync(path.join(srcDir, `noise${i}.ts`), `export const n${i} = ${i};\n`);
    }

    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const result = await new ToolHandler(cg).execute('codegraph_explore', {
      query:
        'In this repos ESPN draft observer (espn-draft-observer.ts), name in order the chain of methods from scrapeFullDraftState to the method that calls storage.saveDraftState. One line.',
    });
    response = result.content?.[0]?.text ?? '';
  }, 120_000);

  afterAll(() => {
    cg?.destroy();
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('still renders the observer file (ranker chooses the right file)', () => {
    expect(response).toContain('espn-draft-observer.ts');
  });

  it('names elided symbols inside gap markers as name (file:line)', () => {
    // Match only in-fence gap markers that list at least one path:line ref.
    const namedGaps = response.match(/\.\.\. \(gap: [^\n]*?\([^\n]+?:\d+\)[^\n]*?\) \.\.\./g) ?? [];
    expect(namedGaps.length, `response head:\n${response.slice(0, 2000)}`).toBeGreaterThan(0);
    for (const g of namedGaps) {
      expect(g).toMatch(/\w+ \([^\s)]+:\d+\)/);
    }
  });

  it('footer points at named gaps / header instead of asking for unknown names', () => {
    if (!response.includes('trimmed for size')) return;
    expect(response).toMatch(/preferred in the file header|named inside gap markers/);
  });

  it('biases the file header away from filler-only when symbols were elided', () => {
    const header = response.split('\n').find((l) => l.includes('**`src/espn-draft-observer.ts`**'));
    expect(header).toBeDefined();
    // Either the header names a chain method, or a named gap does — never
    // neither while the footer asks for exact names.
    const namesAnswer = /syncStateNow|performHeavyDraftSync|persistDraftState|scrapeFullDraftState/;
    const namedSomewhere =
      namesAnswer.test(header!) ||
      namesAnswer.test(response);
    expect(namedSomewhere).toBe(true);
  });
});
