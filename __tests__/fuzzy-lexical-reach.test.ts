/**
 * A function nested inside another function is only callable from inside its
 * container. matchByExactName already filters candidates that way; matchFuzzy
 * must too, or a call to a builtin method (`res.text()`) whose only same-named
 * project symbol is some file's closure resolves onto that closure.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { matchFuzzy } from '../src/resolution/name-matcher';
import type { Node } from '../src/types';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';

describe('fuzzy matching respects lexical reachability of nested functions', () => {
  let tempDir: string;
  let cg: CodeGraph | null = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-fuzzy-reach-'));
  });

  afterEach(() => {
    cg?.destroy();
    cg = null;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Windows can still hold the SQLite handle for a moment; the OS temp dir is swept anyway.
    }
  });

  it('does not resolve a builtin method call onto another file\'s closure of the same name', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'seed.ts'),
      [
        'export function readSeedState(raw: string): string {',
        '  function text(): string {',
        '    return raw.trim();',
        '  }',
        '  return text();',
        '}',
        '',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tempDir, 'fetch.ts'),
      [
        'export async function readOkText(settled: { value: Response }): Promise<string> {',
        '  // A chained receiver reaches the resolver as the bare method name.',
        '  return settled.value.text();',
        '}',
        '',
      ].join('\n')
    );
    cg = await CodeGraph.init(tempDir, { index: true });
    cg.resolveReferences();

    const closure = cg
      .getNodesByKind('function')
      .find((n) => n.name === 'text' && n.filePath === 'seed.ts');
    const caller = cg.getNodesByKind('function').find((n) => n.name === 'readOkText');
    expect(closure).toBeDefined();
    expect(caller).toBeDefined();

    const fromCaller = cg.getOutgoingEdges(caller!.id).filter((e) => e.kind === 'calls');
    expect(fromCaller.map((e) => e.target)).not.toContain(closure!.id);

    // The in-container call still resolves.
    const container = cg.getNodesByKind('function').find((n) => n.name === 'readSeedState');
    const inside = cg.getOutgoingEdges(container!.id).filter((e) => e.kind === 'calls');
    expect(inside.map((e) => e.target)).toContain(closure!.id);
  });
});

/**
 * The reachability check must sit on the one candidate matchFuzzy would
 * commit to, never on the candidate set. Filtering a crowd of same-named
 * definitions down to the reachable ones leaves a single survivor, and the
 * strategy then hands it every call of that name: vite has a dozen `resolve`
 * definitions, most nested, and one reachable `resolve` method inherited 59
 * `import { resolve } from 'node:path'` calls that way (#1709). Driven
 * directly, so the shape is pinned regardless of what the earlier strategies
 * make of a given fixture.
 */
describe('fuzzy reachability rejects a unique guess but never manufactures one', () => {
  const node = (partial: Partial<Node> & Pick<Node, 'id' | 'kind' | 'name' | 'filePath'>): Node => ({
    qualifiedName: partial.name,
    language: 'typescript',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 0,
    ...partial,
  });
  // build.ts:  function build() { const resolve = …; function resolve() {} }
  const container = node({ id: 'f:build', kind: 'function', name: 'build', filePath: 'build.ts', startLine: 1, endLine: 40 });
  const closure = node({ id: 'f:build.resolve', kind: 'function', name: 'resolve', qualifiedName: 'build::resolve', filePath: 'build.ts', startLine: 10, endLine: 12 });
  // pluginContainer.ts:  class PluginContainer { resolve() {} }
  const method = node({ id: 'm:resolve', kind: 'method', name: 'resolve', qualifiedName: 'PluginContainer::resolve', filePath: 'pluginContainer.ts', startLine: 5, endLine: 9 });
  const contextWith = (nodes: Node[]): ResolutionContext =>
    ({
      getNodesInFile: () => [],
      getNodesByName: (name: string) => nodes.filter((n) => n.name === name),
      getNodesByLowerName: (name: string) => nodes.filter((n) => n.name.toLowerCase() === name),
      getNodesByQualifiedName: (qn: string) => [container].filter((n) => n.qualifiedName === qn),
      getNodesByKind: () => [],
      fileExists: () => false,
      readFile: () => null,
      getFileLines: () => [],
      getProjectRoot: () => '',
      getAllFiles: () => [],
      getImportMappings: () => [],
    }) as unknown as ResolutionContext;
  const callFrom = (filePath: string, line: number): UnresolvedRef => ({
    fromNodeId: 'f:caller',
    referenceName: 'resolve',
    referenceKind: 'calls',
    line,
    column: 2,
    filePath,
    language: 'typescript',
  });

  it('declines the sole candidate when it is a closure the call cannot reach', () => {
    expect(matchFuzzy(callFrom('vite.config.js', 3), contextWith([closure]))).toBeNull();
  });

  it('still resolves the sole candidate from inside its container', () => {
    expect(matchFuzzy(callFrom('build.ts', 20), contextWith([closure]))?.targetNodeId).toBe('f:build.resolve');
  });

  it('does not let the unreachable closure drop out and leave the method as a "unique" match', () => {
    // Two same-named callables: ambiguous, exactly as before the check existed.
    expect(matchFuzzy(callFrom('vite.config.js', 3), contextWith([closure, method]))).toBeNull();
  });

  it('resolves a lone reachable method as before', () => {
    expect(matchFuzzy(callFrom('vite.config.js', 3), contextWith([method]))?.targetNodeId).toBe('m:resolve');
  });
});
