import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource, initGrammars, loadGrammarsForLanguages } from '../src/extraction';
import * as fs from 'fs';
import * as path from 'path';

const PROJECT_ROOT = '/Users/wandl/workspaces/workspace-octoclaw-labs/agentscope-zig';
const MIDDLEWARE_FILE = path.join(PROJECT_ROOT,
  'agentscope-harness/src/main/zig/io/agentscope/harness/agent/middleware/DynamicSubagentsMiddleware.zig');

function walkZigFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'zig-cache' && entry.name !== 'node_modules')
      result.push(...walkZigFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.zig'))
      result.push(full);
  }
  return result;
}

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['zig']);
});

describe('Zig Real-World Extraction: agentscope-zig', () => {
  const zigFiles = walkZigFiles(PROJECT_ROOT);

  it('should parse all .zig files without errors', () => {
    expect(zigFiles.length).toBeGreaterThan(100);
    const errors: string[] = [];
    for (const filePath of zigFiles) {
      try {
        const code = fs.readFileSync(filePath, 'utf8');
        extractFromSource(filePath, code);
      } catch (e: any) {
        errors.push(`${path.relative(PROJECT_ROOT, filePath)}: ${e.message}`);
      }
    }
    expect(errors.length).toBe(0);
  });

  it('should extract nodes from the majority of files', () => {
    let filesWithNodes = 0;
    for (const filePath of zigFiles) {
      const code = fs.readFileSync(filePath, 'utf8');
      const result = extractFromSource(filePath, code);
      if (result.nodes.length > 0) filesWithNodes++;
    }
    expect(filesWithNodes).toBeGreaterThanOrEqual(Math.floor(zigFiles.length * 0.3));
  });

  it('should track function calls across files', () => {
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

  it('should extract methods and fields from a real implementation file', () => {
    const code = fs.readFileSync(MIDDLEWARE_FILE, 'utf8');
    const result = extractFromSource(MIDDLEWARE_FILE, code);
    const methods = result.nodes.filter(n => n.kind === 'method');
    const fields = result.nodes.filter(n => n.kind === 'field');
    const structs = result.nodes.filter(n => n.kind === 'struct');
    const typeRefs = result.unresolvedReferences.filter(r => r.referenceKind === 'references');
    const calls = result.unresolvedReferences.filter(r => r.referenceKind === 'calls');
    const imports = result.unresolvedReferences.filter(r => r.referenceKind === 'imports');

    // DynamicSubagentsMiddleware is a struct with fields and methods
    expect(structs.length).toBeGreaterThanOrEqual(1);
    expect(fields.length).toBeGreaterThanOrEqual(5); // static_entries, main_workspace_path, etc.
    expect(methods.length).toBeGreaterThanOrEqual(3); // init, getTools, onAgent, onReasoning, onModelCall
    expect(imports.length).toBeGreaterThanOrEqual(2); // std, Msg, MsgRole, SubagentEntry
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(typeRefs.length).toBeGreaterThanOrEqual(1); // SubagentEntry type on fields

    // Verify specific methods exist
    const methodNames = methods.map(m => m.name);
    expect(methodNames).toContain('init');
    expect(methodNames).toContain('getTools');
    expect(methodNames).toContain('onAgent');
    expect(methodNames).toContain('onReasoning');

    // Verify specific fields exist
    const fieldNames = fields.map(f => f.name);
    expect(fieldNames).toContain('static_entries');
    expect(fieldNames).toContain('allocator');
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
    console.log(`\n=== agentscope-zig Extraction Stats ===`);
    console.log(`Files: ${stats.files}`);
    console.log(`Nodes: ${stats.nodes}, Edges: ${stats.edges}, Refs: ${stats.refs}`);
    console.log(`Node kinds:`, stats.nodeKinds);
    console.log(`Ref kinds:`, stats.refKinds);
  });
});
