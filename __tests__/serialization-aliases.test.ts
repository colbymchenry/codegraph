import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import CodeGraph, { loadGrammarsForLanguages } from '../src/index';
import { extractFieldContracts } from '../src/graph/field-contracts';
import type { Language, Node } from '../src/types';

const graphs: CodeGraph[] = [];
const roots: string[] = [];
beforeAll(async () => { await loadGrammarsForLanguages(['rust', 'go']); });
afterEach(() => {
  for (const graph of graphs.splice(0)) graph.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
function contracts(language: Language, source: string) {
  const owner: Node = { id: 'owner', kind: 'struct', name: 'Settings', qualifiedName: 'Settings', filePath: 'source', language, startLine: 1, endLine: 100, startColumn: 0, endColumn: 0, updatedAt: 0 };
  return extractFieldContracts('source', source, language, [owner])!.contracts;
}
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-alias-')); roots.push(root);
  const file = path.join(root, 'model.go');
  fs.writeFileSync(file, 'package model\ntype Settings struct {\n UserID string ' + '\x60json:"user_id"\x60' + '\n}\n');
  const graph = CodeGraph.initSync(root); graphs.push(graph); await graph.indexAll();
  return { root, file, graph };
}
describe('serialization declarations', () => {
  it('keeps directional serde names and deserialize aliases', () => {
    const items = contracts('rust', '#[serde(rename_all = "camelCase")]\nstruct Settings {\n #[serde(rename(serialize = "out", deserialize = "in"), alias = "legacy")]\n user_id: String,\n}');
    expect(items.map(item => [item.externalName, item.direction])).toEqual([['out', 'serialize'], ['in', 'deserialize'], ['legacy', 'deserialize']]);
  });
  it('honors skip directions and rejects unknown rename rules', () => {
    expect(contracts('rust', 'struct Settings { #[serde(rename = "hidden", skip)] hidden: String }')).toEqual([]);
    expect(contracts('rust', '#[serde(rename_all = "unknown")] struct Settings { user_id: String }')).toEqual([]);
    const items = contracts('rust', 'struct Settings { #[serde(rename = "id", skip_serializing)] user_id: String }');
    expect(items.map(item => item.direction)).toEqual(['deserialize']);
  });
  it('does not treat comments or plain fields as alias declarations', () => {
    expect(contracts('rust', 'struct Settings { /* #[serde(rename = "fake")] */ user_id: String }')).toEqual([]);
  });
  it('recognizes exported Go fields and ignores private and excluded fields', () => {
    const source = 'package model\ntype Settings struct {\n UserID string ' + '\x60json:"user_id,omitempty"\x60' + '\n hidden string ' + '\x60json:"hidden"\x60' + '\n Ignored string ' + '\x60json:"-"\x60' + '\n}';
    expect(contracts('go', source).map(item => item.externalName)).toEqual(['user_id', 'user_id']);
  });
  it('reads current source and reports item limits without losing match counts', async () => {
    const { graph, file } = await fixture();
    const report = await graph.getSerializationAliases({ externalName: 'user_id', maxItems: 0 });
    expect(report.total).toBe(2); expect(report.items).toEqual([]); expect(report.truncated).toBe(true);
    fs.writeFileSync(file, 'package model\ntype Renamed struct {\n Code string ' + '\x60json:"current"\x60' + '\n}\n');
    const current = await graph.getSerializationAliases({ externalName: 'current' });
    expect(current.items[0]!.owner).toContain('Renamed'); expect(current.items[0]!.line).toBe(3);
    expect((await graph.getSerializationAliases({ externalName: 'user_id' })).total).toBe(0);
    await expect(graph.getSerializationAliases({ maxFiles: -1 })).rejects.toThrow('maxFiles');
  });
  it('reports oversized files as skipped and supports exact file filters', async () => {
    const { graph, file } = await fixture();
    expect((await graph.getSerializationAliases({ filePath: 'missing.go' })).eligibleFiles).toBe(0);
    fs.writeFileSync(file, 'x'.repeat(256 * 1024 + 1));
    const report = await graph.getSerializationAliases();
    expect(report.scannedFiles).toBe(0); expect(report.skippedFiles).toEqual(['model.go']);
  });
  it('exposes aliases through JSON CLI output', async () => {
    const { graph, root } = await fixture(); graph.close();
    const result = spawnSync(process.execPath, [path.resolve('dist/bin/codegraph.js'), 'contracts', 'user_id', '--path', root, '--json'], { encoding: 'utf8', env: { ...process.env, CODEGRAPH_WASM_RELAUNCHED: '1' } });
    expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout).total).toBe(2);
  });
});
