import { describe, expect, it } from 'vitest';
import type { Node } from '../src/types';
import type { ResolutionContext } from '../src/resolution/types';
import {
  clearImportResolverMemos, extractImportMappings, extractReExports,
  haskellNameHasCanonicalOrigin,
} from '../src/resolution/import-resolver';

type OriginOptions = Parameters<typeof haskellNameHasCanonicalOrigin>[3];

const canonicalModules = new Set(['Prelude']);
const canonicalPackages = new Map([['Prelude', new Set(['base'])]]);
const policy: OriginOptions = {
  canonicalModules, canonicalPackages, namespace: 'value', implicitPrelude: false,
};

function fixture(initialSources: Record<string, string>) {
  const sources = new Map<string, string>();
  const imports = new Map<string, ReturnType<typeof extractImportMappings>>();
  const reExports = new Map<string, ReturnType<typeof extractReExports>>();
  const modules = new Map<string, Node>();
  const counts = { imports: 0, reads: 0, reExports: 0 };
  function write(filePath: string, source: string) {
    sources.set(filePath, source);
    imports.set(filePath, extractImportMappings(filePath, source, 'haskell'));
    reExports.set(filePath, extractReExports(source, 'haskell'));
    const name = source.match(/^module\s+([\w.]+)/m)?.[1];
    if (name) {
      modules.set(filePath, {
        id: `${filePath}:module`, name, qualifiedName: name,
        kind: 'namespace', language: 'haskell', filePath, isExported: true,
        startLine: 1, endLine: 1, startColumn: 0, endColumn: 1, updatedAt: 0,
      });
    } else {
      modules.delete(filePath);
    }
  }
  for (const [filePath, source] of Object.entries(initialSources)) write(filePath, source);
  const nodes = () => [...modules.values()];
  const context: ResolutionContext = {
    getNodesInFile: (filePath) => nodes().filter((node) => node.filePath === filePath),
    getNodesByName: (name) => nodes().filter((node) => node.name === name),
    getNodesByQualifiedName: (name) => nodes().filter((node) => node.qualifiedName === name),
    getNodesByKind: (kind) => nodes().filter((node) => node.kind === kind),
    getNodesByLowerName: (name) => nodes().filter((node) => node.name.toLowerCase() === name),
    fileExists: (filePath) => sources.has(filePath),
    readFile: (filePath) => { counts.reads++; return sources.get(filePath) ?? null; },
    getProjectRoot: () => '/haskell-origin-cache-fixture',
    getAllFiles: () => [...sources.keys()],
    getImportMappings: (filePath) => { counts.imports++; return imports.get(filePath) ?? []; },
    getReExports: (filePath) => { counts.reExports++; return reExports.get(filePath) ?? []; },
  };
  return {
    write,
    remove: (filePath: string) => {
      sources.delete(filePath);
      imports.delete(filePath);
      reExports.delete(filePath);
      modules.delete(filePath);
    },
    counts: () => ({ ...counts }),
    clear: () => clearImportResolverMemos(context),
    origin: (filePath = 'Consumer.hs', name = 'map', options: OriginOptions = policy) =>
      // Production callers allocate a new wrapper while reusing immutable
      // module/package policy collections. That must still hit the memo.
      haskellNameHasCanonicalOrigin(filePath, name, context, { ...options }),
  };
}

describe('Haskell canonical origin proof cache', () => {
  it('reuses completed true and false proofs with fresh options wrappers', () => {
    const graph = fixture({
      'Consumer.hs': 'module Consumer where\nimport Facade (map)',
      'Facade.hs': 'module Facade (map) where\nimport Prelude (map)',
      'CustomConsumer.hs': 'module CustomConsumer where\nimport Custom (map)',
    });
    expect(graph.origin()).toBe(true);
    expect(graph.counts().reExports).toBeGreaterThan(0);
    const canonicalCounts = graph.counts();
    expect(graph.origin()).toBe(true);
    expect(graph.counts()).toEqual(canonicalCounts);

    expect(graph.origin('CustomConsumer.hs')).toBe(false);
    const customCounts = graph.counts();
    expect(graph.origin('CustomConsumer.hs')).toBe(false);
    expect(graph.counts()).toEqual(customCounts);
  });

  it('separates files, full qualifiers, and member names', () => {
    const graph = fixture({
      'Consumer.hs': 'module Consumer where\nimport qualified Prelude as P (map)\nimport qualified Custom as C (map)',
      'Other.hs': 'module Other where\nimport qualified Custom as P (map)',
    });
    expect(graph.origin('Consumer.hs', 'P::map')).toBe(true);
    const qualifiedCounts = graph.counts();
    expect(graph.origin('Consumer.hs', 'P.map')).toBe(true);
    expect(graph.counts()).toEqual(qualifiedCounts);
    expect(graph.origin('Consumer.hs', 'C::map')).toBe(false);
    expect(graph.origin('Consumer.hs', 'P::foldr')).toBe(false);
    expect(graph.origin('Consumer.hs', 'map')).toBe(false);
    expect(graph.origin('Other.hs', 'P::map')).toBe(false);
    expect(graph.origin('Consumer.hs', 'P::map')).toBe(true);
  });

  it('separates namespaces and implicit Prelude policy', () => {
    const graph = fixture({
      'Consumer.hs': '{-# LANGUAGE ExplicitNamespaces #-}\nmodule Consumer where\nimport Prelude (type IO)',
      'Implicit.hs': 'module Implicit where\nrun = map id',
      'ExplicitOnly.hs': '{-# LANGUAGE NoImplicitPrelude #-}\nmodule ExplicitOnly where\nrun = map id',
    });
    expect(graph.origin('Consumer.hs', 'IO', { ...policy, namespace: 'type' })).toBe(true);
    expect(graph.origin('Consumer.hs', 'IO', { ...policy, namespace: 'value' })).toBe(false);
    expect(graph.origin('Implicit.hs', 'map', { ...policy, implicitPrelude: true })).toBe(true);
    expect(graph.origin('Implicit.hs', 'map', { ...policy, implicitPrelude: false })).toBe(false);
    expect(graph.origin('ExplicitOnly.hs', 'map', { ...policy, implicitPrelude: true })).toBe(false);
  });

  it('separates both immutable policy collections', () => {
    const graph = fixture({
      'Consumer.hs': '{-# LANGUAGE PackageImports #-}\nmodule Consumer where\nimport "base" Prelude (map)',
    });
    const otherModules = new Set<string>();
    const otherPackages = new Map([['Prelude', new Set(['custom-package'])]]);
    expect(graph.origin()).toBe(true);
    expect(graph.origin('Consumer.hs', 'map', { ...policy, canonicalModules: otherModules })).toBe(false);
    expect(graph.origin('Consumer.hs', 'map', { ...policy, canonicalPackages: otherPackages })).toBe(false);
    expect(graph.origin()).toBe(true);
  });

  it('keeps identical lookups in independent contexts isolated', () => {
    const canonical = fixture({ 'Consumer.hs': 'module Consumer where\nimport Prelude (map)' });
    const shadowed = fixture({
      'Consumer.hs': 'module Consumer where\nimport Prelude (map)',
      'Prelude.hs': 'module Prelude where\nmap _ xs = xs',
    });
    expect(canonical.origin()).toBe(true);
    expect(shadowed.origin()).toBe(false);
    expect(canonical.origin()).toBe(true);
  });

  it('invalidates true and false proofs when a facade or local module changes', () => {
    const graph = fixture({
      'Consumer.hs': 'module Consumer where\nimport Facade (map)',
      'Facade.hs': 'module Facade (map) where\nimport Prelude (map)',
    });
    expect(graph.origin()).toBe(true);
    graph.write('Facade.hs', 'module Facade (map) where\nimport Custom (map)');
    graph.clear();
    expect(graph.origin()).toBe(false);
    graph.write('Facade.hs', 'module Facade (map) where\nimport Prelude (map)');
    graph.clear();
    expect(graph.origin()).toBe(true);

    graph.write('Prelude.hs', 'module Prelude where\nmap _ xs = xs');
    graph.clear();
    expect(graph.origin()).toBe(false);
    graph.remove('Prelude.hs');
    graph.clear();
    expect(graph.origin()).toBe(true);
  });

  it('caches an exhausted proof as false and discards it on invalidation', () => {
    const sources: Record<string, string> = {
      'Consumer.hs': 'module Consumer where\nimport Chain0 (map)',
    };
    for (let level = 0; level < 70; level++) {
      const next = level === 69 ? 'Prelude' : `Chain${level + 1}`;
      sources[`Chain${level}.hs`] = `module Chain${level} (module ${next}) where\nimport ${next}`;
    }
    const graph = fixture(sources);
    expect(graph.origin()).toBe(false);
    expect(graph.counts().reExports).toBeGreaterThan(0);
    expect(graph.counts().reExports).toBeLessThanOrEqual(64);
    const exhaustedCounts = graph.counts();
    expect(graph.origin()).toBe(false);
    expect(graph.counts()).toEqual(exhaustedCounts);

    graph.write('Chain0.hs', 'module Chain0 (map) where\nimport Prelude (map)');
    graph.clear();
    expect(graph.origin()).toBe(true);
  });
});
