import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { matchByExactName } from '../src/resolution/name-matcher';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';
import type { Node } from '../src/types';

function node(id: string, filePath = 'lib/other.js', extra: Partial<Node> = {}): Node {
  return { id, filePath, kind: 'function', name: 'target', qualifiedName: 'target', language: 'javascript',
    startLine: 1, endLine: 1, startColumn: 0, endColumn: 0, updatedAt: 0, ...extra };
}
function context(nodes: Node[], source = 'target();'): ResolutionContext {
  return {
    getNodesByName: name => nodes.filter(n => n.name === name),
    getNodesByLowerName: name => nodes.filter(n => n.name.toLowerCase() === name),
    getNodesByQualifiedName: name => nodes.filter(n => n.qualifiedName === name),
    getNodesByKind: kind => nodes.filter(n => n.kind === kind),
    getNodesInFile: file => nodes.filter(n => n.filePath === file),
    getImportMappings: () => [], getAllFiles: () => [], getProjectRoot: () => '/project',
    fileExists: () => true,
    readFile: file => file === 'lib/caller.js' ? source : 'function target() {}',
    getFileLines: file => (file === 'lib/caller.js' ? source : 'function target() {}').split('\n'),
  };
}
const ref: UnresolvedRef = { fromNodeId: 'caller', referenceName: 'target', referenceKind: 'calls',
  filePath: 'lib/caller.js', language: 'javascript', line: 1, column: 0 };

describe('exact-name binding checks', () => {
  it('keeps zero and one candidate outcomes', () => {
    expect(matchByExactName(ref, context([]))).toBeNull();
    expect(matchByExactName(ref, context([node('one')]))).toEqual({
      original: ref, targetNodeId: 'one', confidence: 0.9, resolvedBy: 'exact-match',
    });
  });
  it('keeps the first candidate when scores tie', () => {
    const a = node('a', 'lib/a.js'), b = node('b', 'lib/b.js');
    for (const nodes of [[a, b], [b, a]]) {
      expect(matchByExactName(ref, context(nodes))).toEqual({
        original: ref, targetNodeId: nodes[0]!.id, confidence: 0.4, resolvedBy: 'exact-match',
      });
    }
  });
  it('keeps the same-file winner in a cross-file collision', () => {
    expect(matchByExactName(ref, context([node('other'), node('own', ref.filePath)]))?.targetNodeId).toBe('own');
  });
  it('rejects every cross-file candidate when a parameter binds the name', () => {
    expect(matchByExactName({ ...ref, line: 2, column: 2 }, context([node('a'), node('b', 'lib/b.js')],
      'function caller(target) {\n  target();\n}'))).toBeNull();
  });
  it.each(['javascript', 'typescript'] as const)('rejects import and member nodes for bare %s calls', language => {
    const nodes = [node('import', 'lib/i.js', { kind: 'import', language }),
      node('member', 'lib/m.js', { kind: 'method', qualifiedName: 'Service::target', language }),
      node('function', 'lib/f.js', { language })];
    expect(matchByExactName({ ...ref, language }, context(nodes))?.targetNodeId).toBe('function');
  });
  it('does not retain the binding result between references', () => {
    const nodes = [node('a'), node('b', 'lib/b.js')];
    expect(matchByExactName(ref, context(nodes))?.targetNodeId).toBe('a');
    expect(matchByExactName({ ...ref, line: 2, column: 2 },
      context(nodes, 'function caller(target) {\n  target();\n}'))).toBeNull();
  });
});

describe('exact-name bindings through indexing and sync', () => {
  let root: string | undefined;
  let graph: CodeGraph | undefined;
  afterEach(() => {
    graph?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });
  it('preserves nested scopes and import aliases through re-exports and symbol changes', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-exact-binding-'));
    const write = (file: string, source: string) => fs.writeFileSync(path.join(root!, file), source);
    write('definition.ts', 'export function original() { return 1; }');
    write('barrel.ts', "export { original as exposed } from './definition';");
    write('caller.ts', "import { exposed as alias } from './barrel';\nexport function caller() { return alias(); }");
    write('nested.ts', 'export function outer() {\n function hidden() { return 1; }\n return hidden();\n}\nexport function outside() { return hidden(); }');
    graph = await CodeGraph.init(root);
    await graph.indexAll();
    const targets = (name: string) => {
      const caller = graph!.getNodesByName(name).find(n => n.kind === 'function')!;
      return graph!.getOutgoingEdges(caller.id).filter(e => e.kind === 'calls').map(e => graph!.getNode(e.target)?.name);
    };
    expect(targets('caller')).toContain('original');
    expect(targets('outer')).toContain('hidden');
    expect(targets('outside')).not.toContain('hidden');
    write('collision.ts', 'export function alias() { return 2; }');
    await graph.sync();
    expect(targets('caller')).toContain('original');
    expect(targets('caller')).not.toContain('alias');
    fs.unlinkSync(path.join(root, 'collision.ts'));
    await graph.sync();
    expect(targets('caller')).toContain('original');
  });
});
