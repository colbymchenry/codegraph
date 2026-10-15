import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import CodeGraph from '../src/index';
import { computeFileComplexities } from '../src/graph/hotspots';

const roots: string[] = []; const graphs: CodeGraph[] = [];
afterEach(() => {
  for (const graph of graphs.splice(0)) graph.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-hotspot-')); roots.push(root);
  fs.writeFileSync(path.join(root, 'source.ts'), 'export function target(x: number): number { if (x > 0) return x; return 0; }\nexport function caller(): number { target(1); return target(2); }\n');
  fs.writeFileSync(path.join(root, 'source.test.ts'), 'import { target } from "./source"; export function testTarget() { return target(1); }\n');
  const graph = CodeGraph.initSync(root); graphs.push(graph); await graph.indexAll(); await graph.resolveReferences();
  return { root, graph };
}
describe('hotspot reports', () => {
  it('counts distinct callers and exposes direct related-test evidence', async () => {
    const { graph } = await fixture();
    const report = await graph.getRiskHotspots({ changedFiles: ['source.ts'] });
    const target = report.items.find(row => row.node.name === 'target')!;
    expect(target.complexity).toBe(2); expect(target.callerCount).toBe(2);
    expect(target.changed).toBe(true); expect(target.testFiles).toContain('source.test.ts');
    expect(target.score).toBe(6.75); expect(report.eligibleFiles).toBe(1);
  });
  it('gates across scored rows rather than displayed rows and validates bounds', async () => {
    const { graph } = await fixture();
    const report = await graph.getRiskHotspots({ maxItems: 0, threshold: 1 });
    expect(report.items).toEqual([]); expect(report.aboveThreshold).toBe(1); expect(report.scoredSymbols).toBe(2); expect(report.truncated).toBe(true);
    await expect(graph.getRiskHotspots({ threshold: NaN })).rejects.toThrow('threshold');
  });
  it('skips stale source until sync instead of mixing ranges and current bytes', async () => {
    const { graph, root } = await fixture();
    fs.appendFileSync(path.join(root, 'source.ts'), '// current edits\n');
    const report = await graph.getRiskHotspots();
    expect(report.skippedFiles).toEqual(['source.ts']); expect(report.scoredSymbols).toBe(0);
  });
  it('attributes same-line nested decisions to the inner callable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-hotspot-nested-')); roots.push(root);
    const source = 'function outer() { function inner(x: boolean) { if (x) return 1; return 0; } return inner(true); }';
    const file = path.join(root, 'source.ts'); fs.writeFileSync(file, source);
    const innerStart = source.indexOf('function inner'); const innerEnd = source.indexOf(' return inner');
    const values = await computeFileComplexities(file, 'typescript', [{ id: 'outer', startLine: 1, endLine: 1, startColumn: 0, endColumn: source.length }, { id: 'inner', startLine: 1, endLine: 1, startColumn: innerStart, endColumn: innerEnd }]);
    expect(values.get('outer')).toBe(1); expect(values.get('inner')).toBe(2);
  });
  it('returns JSON and a failing strict exit with an empty display list', async () => {
    const { graph, root } = await fixture(); graph.close();
    const result = spawnSync(process.execPath, [path.resolve('dist/bin/codegraph.js'), 'hotspots', '--path', root, '--strict', '--threshold', '1', '--limit', '0', '--json'], { encoding: 'utf8', env: { ...process.env, CODEGRAPH_WASM_RELAUNCHED: '1' } });
    expect(result.status, result.stderr).toBe(1); const report = JSON.parse(result.stdout);
    expect(report.items).toEqual([]); expect(report.aboveThreshold).toBe(1);
  });
});
