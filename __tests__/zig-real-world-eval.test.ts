import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource, initGrammars, loadGrammarsForLanguages } from '../src/extraction';
import * as fs from 'fs';
import * as path from 'path';
import { getParser } from '../src/extraction/grammars';

/**
 * Real-world Zig extraction evaluation, driven by environment variables so it
 * runs against any local Zig checkout and never encodes a machine-specific path:
 *
 *   ZIG_E2E_ROOT      (required) absolute path to a real Zig project; the whole
 *                     suite skips when unset or nonexistent.
 *   ZIG_E2E_FILE      (optional) path — relative to ZIG_E2E_ROOT — of one .zig
 *                     file to deep-assert (struct with fields + methods + type
 *                     refs + calls); skipped when unset or missing.
 *
 * Example:
 *   ZIG_E2E_ROOT=/path/to/some-zig-project npx vitest run __tests__/zig-real-world-eval.test.ts
 */
const PROJECT_ROOT = process.env.ZIG_E2E_ROOT ?? '';
const DEEP_FILE_REL = process.env.ZIG_E2E_FILE ?? '';
const rootAvailable = PROJECT_ROOT !== '' && fs.existsSync(PROJECT_ROOT);
const DEEP_FILE = DEEP_FILE_REL ? path.join(PROJECT_ROOT, DEEP_FILE_REL) : '';
const deepFileAvailable = rootAvailable && DEEP_FILE !== '' && fs.existsSync(DEEP_FILE);

function walkZigFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.') && !['zig-cache', 'zig-out', 'node_modules'].includes(entry.name))
      result.push(...walkZigFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.zig'))
      result.push(full);
  }
  return result;
}

beforeAll(async () => {
  if (!rootAvailable) return;
  await initGrammars();
  await loadGrammarsForLanguages(['zig']);
});

describe.skipIf(!rootAvailable)(`Zig Real-World Extraction: ${path.basename(PROJECT_ROOT) || 'ZIG_E2E_ROOT'}`, () => {
  const zigFiles = rootAvailable ? walkZigFiles(PROJECT_ROOT) : [];

  it('should extract all .zig files without reported errors', () => {
    expect(zigFiles.length).toBeGreaterThan(0);
    const errors: string[] = [];
    for (const filePath of zigFiles) {
      try {
        const code = fs.readFileSync(filePath, 'utf8');
        const result = extractFromSource(filePath, code);
        for (const error of result.errors) errors.push(`${path.relative(PROJECT_ROOT, filePath)}: ${error.message}`);
      } catch (e: any) {
        errors.push(`${path.relative(PROJECT_ROOT, filePath)}: ${e.message}`);
      }
    }
    expect(errors).toEqual([]);
  });

  it('should parse all .zig files without ERROR or MISSING recovery', () => {
    const parser = getParser('zig');
    expect(parser).not.toBeNull();
    const failures: string[] = [];
    for (const file of zigFiles) {
      const tree = parser!.parse(fs.readFileSync(file, 'utf8'));
      try {
        if (!tree || tree.rootNode.hasError) failures.push(path.relative(PROJECT_ROOT, file));
      } finally {
        tree?.delete();
      }
    }
    expect(failures, 'Grammar recovery is distinct from extraction exceptions').toEqual([]);
  });

  it('should extract nodes from the majority of files', () => {
    let filesWithNodes = 0;
    for (const filePath of zigFiles) {
      const code = fs.readFileSync(filePath, 'utf8');
      const result = extractFromSource(filePath, code);
      if (result.nodes.some(n => n.kind !== 'file')) filesWithNodes++;
    }
    expect(filesWithNodes).toBeGreaterThan(zigFiles.length / 2);
  });

  it('should extract call references (resolution is tested separately)', () => {
    let totalCalls = 0;
    for (const filePath of zigFiles) {
      const code = fs.readFileSync(filePath, 'utf8');
      const result = extractFromSource(filePath, code);
      totalCalls += result.unresolvedReferences.filter(r => r.referenceKind === 'calls').length;
    }
    expect(totalCalls).toBeGreaterThan(50);
  });

  it('should track @import references', () => {
    let totalImports = 0;
    for (const filePath of zigFiles) {
      const code = fs.readFileSync(filePath, 'utf8');
      const result = extractFromSource(filePath, code);
      totalImports += result.unresolvedReferences.filter(r => r.referenceKind === 'imports').length;
    }
    expect(totalImports).toBeGreaterThan(50);
  });

  it('should emit type references for struct fields', () => {
    let totalTypeRefs = 0;
    for (const filePath of zigFiles) {
      const code = fs.readFileSync(filePath, 'utf8');
      const result = extractFromSource(filePath, code);
      totalTypeRefs += result.unresolvedReferences.filter(r => r.referenceKind === 'references').length;
    }
    expect(totalTypeRefs).toBeGreaterThan(10);
  });

  it.skipIf(!deepFileAvailable)('should extract methods and fields from a real implementation file', () => {
    const code = fs.readFileSync(DEEP_FILE, 'utf8');
    const result = extractFromSource(DEEP_FILE, code);
    const methods = result.nodes.filter(n => n.kind === 'method');
    const fields = result.nodes.filter(n => n.kind === 'field');
    const structs = result.nodes.filter(n => n.kind === 'struct');
    const typeRefs = result.unresolvedReferences.filter(r => r.referenceKind === 'references');
    const calls = result.unresolvedReferences.filter(r => r.referenceKind === 'calls');
    const imports = result.unresolvedReferences.filter(r => r.referenceKind === 'imports');

    expect(structs.length).toBeGreaterThanOrEqual(1);
    expect(fields.length).toBeGreaterThanOrEqual(5);
    expect(methods.length).toBeGreaterThanOrEqual(3);
    expect(imports.length).toBeGreaterThanOrEqual(2);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(typeRefs.length).toBeGreaterThanOrEqual(1);
  });

  it('extraction stats summary', () => {
    const stats = { files: 0, nodes: 0, edges: 0, refs: 0, nodeKinds: {} as Record<string, number>, refKinds: {} as Record<string, number> };
    for (const filePath of zigFiles) {
      const code = fs.readFileSync(filePath, 'utf8');
      const result = extractFromSource(filePath, code);
      stats.files++;
      stats.nodes += result.nodes.length;
      stats.edges += result.edges.length;
      stats.refs += result.unresolvedReferences.length;
      for (const n of result.nodes) stats.nodeKinds[n.kind] = (stats.nodeKinds[n.kind] || 0) + 1;
      for (const r of result.unresolvedReferences) stats.refKinds[r.referenceKind] = (stats.refKinds[r.referenceKind] || 0) + 1;
    }
    console.log(`\n=== ${path.basename(PROJECT_ROOT)} Zig Extraction Stats ===`);
    console.log(`Files: ${stats.files}`);
    console.log(`Nodes: ${stats.nodes}, Edges: ${stats.edges}, Refs: ${stats.refs}`);
    console.log(`Node kinds:`, stats.nodeKinds);
    console.log(`Ref kinds:`, stats.refKinds);
  });
});
