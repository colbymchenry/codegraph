import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import { quotedPhrases, renderQuotedText } from '../src/graph/quoted-text';

const roots: string[] = []; const graphs: CodeGraph[] = [];
afterEach(() => {
  for (const graph of graphs.splice(0)) graph.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
async function fixture(files: Record<string, string> = { 'src/a.ts': 'export function showMessage() { return "Access denied"; }\n', 'other/b.py': 'def display():\n    return "Access denied"\n' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-quoted-')); roots.push(root);
  for (const [file, source] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), source); }
  const graph = CodeGraph.initSync(root); graphs.push(graph); await graph.indexAll(); return { graph, root };
}
describe('quoted text evidence', () => {
  it('recognizes quote forms and preserves contractions and punctuation queries', () => {
    expect(quotedPhrases('find "Access denied" and \u201cSubmit form\u201d').phrases).toEqual(['Access denied', 'Submit form']);
    expect(quotedPhrases("don't match contractions").phrases).toEqual([]);
    expect(quotedPhrases('"???"').phrases).toEqual([]);
    expect(quotedPhrases('"x" "' + 'a'.repeat(161) + '"').phrases).toEqual([]);
    const many = quotedPhrases(Array.from({ length: 10 }, (_, i) => '"message ' + i + '"').join(' '));
    expect(many.phrases).toHaveLength(8); expect(many.truncated).toBe(true);
  });
  it('returns exact current positions and directory/language filtering', async () => {
    const { graph } = await fixture();
    const report = await graph.queryQuotedText('"Access denied"', { directory: 'src', languages: ['typescript'] });
    expect(report.total).toBe(1); expect(report.items[0]!.filePath).toBe('src/a.ts');
    expect(report.items[0]!.line).toBe(1); expect(report.items[0]!.source.indexOf('Access denied')).toBe(report.items[0]!.column);
    expect((await graph.queryQuotedText('"Access denied"', { directory: 'src', languages: ['python'] })).total).toBe(0);
  });
  it('reads changed source rather than indexed text', async () => {
    const { graph, root } = await fixture();
    fs.writeFileSync(path.join(root, 'src/a.ts'), '// Current message\n');
    const report = await graph.queryQuotedText('"Current message"');
    expect(report.total).toBe(1); expect(report.items[0]!.line).toBe(1);
  });
  it('reports scan, match and matching-file truncation independently', async () => {
    const { graph } = await fixture();
    const scanned = await graph.queryQuotedText('"Access denied"', { maxFiles: 1 });
    expect(scanned.scannedFiles).toBe(1); expect(scanned.eligibleFiles).toBe(2); expect(scanned.truncated).toBe(true);
    const capped = await graph.queryQuotedText('"Access denied"', { maxItems: 0 });
    expect(capped.total).toBe(2); expect(capped.items).toEqual([]); expect(capped.truncated).toBe(true);
    const oneFile = await graph.queryQuotedText('"Access denied"', { maxMatchingFiles: 1 });
    expect(oneFile.total).toBe(2); expect(oneFile.items).toHaveLength(1);
    await expect(graph.queryQuotedText('"Access denied"', { maxFiles: NaN })).rejects.toThrow('maxFiles');
  });
  it('counts skipped oversized and deleted files without claiming a complete miss', async () => {
    const { graph, root } = await fixture();
    fs.writeFileSync(path.join(root, 'src/a.ts'), 'x'.repeat(256 * 1024 + 1)); fs.unlinkSync(path.join(root, 'other/b.py'));
    const report = await graph.queryQuotedText('"Access denied"');
    expect(report.total).toBe(0); expect(report.scannedFiles).toBe(0); expect(report.skippedFiles).toHaveLength(2);
    expect(renderQuotedText(report, 1000)).toContain('No exact text match in the scanned subset');
  });
  it('caps long line evidence and rendering output', async () => {
    const { graph } = await fixture({ 'source.ts': '// ' + 'x'.repeat(800) + ' Access denied ' + 'x'.repeat(800) });
    const report = await graph.queryQuotedText('"Access denied"');
    expect(report.items[0]!.source.length).toBeLessThanOrEqual(400); expect(report.items[0]!.sourceStartColumn).toBeGreaterThan(0);
    expect(renderQuotedText(report, 600).length).toBeLessThanOrEqual(600);
  });
  it('routes literal queries through the existing MCP tool', async () => {
    const { graph } = await fixture(); const handler = new ToolHandler(graph);
    const result = await handler.execute('codegraph_explore', { query: 'where is "Access denied" emitted?', maxFiles: 1 });
    expect(result.isError).toBeFalsy(); const text = result.content[0]!.text!;
    expect(text).toContain('Quoted Text Evidence'); expect(text).toContain('not call or runtime proof'); expect(text).toContain('truncated: true');
  });
  it('preserves named symbol, file and flow query handling', async () => {
    const { graph } = await fixture(); const handler = new ToolHandler(graph);
    for (const query of ['"showMessage"', 'src/a.ts "Access denied"', 'showMessage "Access denied"', 'flow "Access denied"']) {
      const result = await handler.execute('codegraph_explore', { query });
      expect(result.isError).toBeFalsy(); expect(result.content[0]!.text).not.toContain('Quoted Text Evidence');
    }
  });
});
