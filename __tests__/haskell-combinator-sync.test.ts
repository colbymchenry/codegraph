import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import type { QueryBuilder } from '../src/db/queries';
import type { ReferenceResolver } from '../src/resolution';
import type { UnresolvedReference } from '../src/types';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['haskell']);
});

describe('Haskell combinator provenance through incremental sync', () => {
  let tmpDir: string | undefined;
  let graph: CodeGraph | undefined;

  afterEach(() => {
    graph?.destroy();
    graph = undefined;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  const write = (filePath: string, content: string) => {
    fs.writeFileSync(path.join(tmpDir!, filePath), content);
  };
  const facade = (origin: string) => `module Facade (map) where\nimport ${origin} (map)\n`;
  const callback = 'module Callback (callback) where\ncallback x = x + 1\n';

  const createGraph = async (localCallback = false, batchSize?: number, origin = 'Prelude') => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-haskell-combinator-sync-'));
    write('Fake.hs', 'module Fake (map) where\nmap _ xs = xs\n');
    write('Callback.hs', callback);
    write('Facade.hs', facade(origin));
    write('Consumer.hs', [
      'module Consumer where',
      'import Prelude hiding (map)',
      'import Facade (map)',
      ...(localCallback ? ['callback x = x + 1'] : ['import qualified Callback as C']),
      localCallback ? 'run xs = map callback xs' : 'run xs = map C.callback xs',
      '',
    ].join('\n'));
    graph = CodeGraph.initSync(tmpDir);
    if (batchSize !== undefined) {
      const { resolver } = internals(graph);
      const resolve = resolver.resolveAndPersistBatched.bind(resolver);
      resolver.resolveAndPersistBatched = (progress, _size, synthesis, parallel) =>
        resolve(progress, batchSize, synthesis, parallel);
    }
    expect((await graph.indexAll()).success).toBe(true);
    return graph;
  };

  const consumer = (current: CodeGraph) => current.getNodesByName('run')
    .find((node) => node.filePath === 'Consumer.hs')!;

  const callbackEdges = (current: CodeGraph) => current.getOutgoingEdges(consumer(current).id)
    .filter((edge) => current.getNode(edge.target)?.name === 'callback');

  const internals = (current: CodeGraph) => current as unknown as {
    queries: QueryBuilder;
    resolver: ReferenceResolver;
  };

  const callbackFingerprint = (current: CodeGraph) => callbackEdges(current)
    .map(({ kind, line, column, provenance, metadata }) => ({ kind, line, column, provenance, metadata }))
    .sort((left, right) => left.kind.localeCompare(right.kind));

  const freshCallbackFingerprint = async () => {
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-haskell-combinator-fresh-'));
    let fresh: CodeGraph | undefined;
    try {
      for (const file of fs.readdirSync(tmpDir!).filter((name) => name.endsWith('.hs'))) {
        fs.copyFileSync(path.join(tmpDir!, file), path.join(freshDir, file));
      }
      fresh = CodeGraph.initSync(freshDir);
      expect((await fresh.indexAll()).success).toBe(true);
      return callbackFingerprint(fresh);
    } finally {
      fresh?.destroy();
      fs.rmSync(freshDir, { recursive: true, force: true });
    }
  };

  const expectCallbackKind = (current: CodeGraph, kind: 'calls' | 'references') => {
    const edges = callbackEdges(current);
    const semanticEdges = edges.filter((edge) =>
      Array.isArray(edge.metadata?.refCandidates)
      && edge.metadata.refCandidates.includes('haskell-combinator:map'));
    expect(semanticEdges.filter((edge) => edge.kind === kind)).toHaveLength(1);
    expect(edges).toContainEqual(expect.objectContaining({
      kind,
      metadata: expect.objectContaining({
        haskellImportDependent: true,
        refCandidates: expect.arrayContaining(['haskell-combinator:map']),
      }),
    }));
    const edge = semanticEdges.find((candidate) => candidate.kind === kind)!;
    if (kind === 'calls') {
      expect(edge.provenance).toBe('heuristic');
      expect(edge.metadata).toEqual(expect.objectContaining({
        synthesizedBy: 'haskell-combinator',
        via: 'map',
        registeredAt: `Consumer.hs:${edge.line}`,
      }));
    } else {
      expect(edges).toHaveLength(1);
      expect(edge.provenance).not.toBe('heuristic');
      expect(edge.metadata?.refKind).toBe('calls');
      expect(edge.metadata?.synthesizedBy).toBeUndefined();
      expect(edge.metadata?.via).toBeUndefined();
      expect(edge.metadata?.registeredAt).toBeUndefined();
    }
  };

  it('demotes and restores an unchanged consumer when its facade changes origin', async () => {
    const current = await createGraph(true);
    const consumerId = consumer(current).id;
    const nodeCount = current.getStats().nodeCount;
    expectCallbackKind(current, 'calls');
    const before = callbackFingerprint(current);

    write('Facade.hs', facade('Fake'));
    await current.sync({ paths: ['Facade.hs'] });
    expectCallbackKind(current, 'references');
    expect(consumer(current).id).toBe(consumerId);
    expect(current.getStats().nodeCount).toBe(nodeCount);

    write('Facade.hs', facade('Prelude'));
    await current.sync({ paths: ['Facade.hs'] });
    expectCallbackKind(current, 'calls');
    expect(consumer(current).id).toBe(consumerId);
    expect(current.getStats().nodeCount).toBe(nodeCount);
    expect(callbackFingerprint(current)).toEqual(before);
    expect(callbackFingerprint(current)).toEqual(await freshCallbackFingerprint());
  });

  it.each(['calls', 'references'] as const)(
    'preserves complete callback edges when replaying %s first in single-reference batches',
    async (firstKind) => {
      const current = await createGraph(false, 1);
      const before = callbackFingerprint(current);
      const nodeCount = current.getStats().nodeCount;
      const { queries, resolver } = internals(current);
      const source = consumer(current);
      const persisted = callbackEdges(current)
        .sort((left, right) => Number(right.kind === firstKind) - Number(left.kind === firstKind));
      expect(persisted.map((edge) => edge.kind)).toEqual([
        firstKind, firstKind === 'calls' ? 'references' : 'calls',
      ]);
      // Rebuild the real persisted references in both admission orders. A
      // batch size of one prevents an in-memory batch dedupe from hiding a
      // collision or missing companion edge in SQLite persistence.
      const refs = persisted.map((edge): UnresolvedReference => ({
        fromNodeId: source.id,
        referenceName: edge.metadata!.refName as string,
        referenceKind: (edge.metadata!.refKind ?? edge.kind) as UnresolvedReference['referenceKind'],
        candidates: edge.metadata!.refCandidates as string[] | undefined,
        line: edge.line!,
        column: edge.column!,
        filePath: source.filePath,
        language: 'haskell',
      }));
      queries.deleteEdgesBySource(source.id);
      queries.insertUnresolvedRefsBatch(refs);
      await resolver.resolveAndPersistBatched(undefined, 1);
      expect(callbackFingerprint(current)).toEqual(before);

      write('Facade.hs', facade('Fake'));
      await current.sync({ paths: ['Facade.hs'] });
      expectCallbackKind(current, 'references');
      write('Facade.hs', facade('Prelude'));
      await current.sync({ paths: ['Facade.hs'] });
      expectCallbackKind(current, 'calls');
      expect(callbackFingerprint(current)).toEqual(before);
      expect(callbackFingerprint(current)).toEqual(await freshCallbackFingerprint());
      expect(current.getStats().nodeCount).toBe(nodeCount);
    },
  );

  it('retains the callback proof when a custom combinator is indexed with batch size one', async () => {
    const current = await createGraph(false, 1, 'Fake');
    expectCallbackKind(current, 'references');
    write('Facade.hs', facade('Prelude'));
    await current.sync({ paths: ['Facade.hs'] });
    expectCallbackKind(current, 'calls');
    expect(callbackFingerprint(current)).toEqual(await freshCallbackFingerprint());
  });

  it('preserves combinator evidence when the callback is replaced, deleted, and restored', async () => {
    const current = await createGraph();
    const nodeCount = current.getStats().nodeCount;
    expectCallbackKind(current, 'calls');

    write('Callback.hs', 'module Callback (callback) where\n-- move its declaration\ncallback x = x + 2\n');
    await current.sync({ paths: ['Callback.hs'] });
    expectCallbackKind(current, 'calls');
    expect(current.getStats().nodeCount).toBe(nodeCount);

    fs.unlinkSync(path.join(tmpDir!, 'Callback.hs'));
    await current.sync({ paths: ['Callback.hs'] });
    expect(callbackEdges(current)).toHaveLength(0);

    write('Callback.hs', callback);
    await current.sync({ paths: ['Callback.hs'] });
    expectCallbackKind(current, 'calls');
    expect(current.getStats().nodeCount).toBe(nodeCount);

    write('Facade.hs', facade('Fake'));
    await current.sync({ paths: ['Facade.hs'] });
    expectCallbackKind(current, 'references');

    fs.unlinkSync(path.join(tmpDir!, 'Callback.hs'));
    await current.sync({ paths: ['Callback.hs'] });
    expect(callbackEdges(current)).toHaveLength(0);
    write('Callback.hs', callback);
    await current.sync({ paths: ['Callback.hs'] });
    expectCallbackKind(current, 'references');

    write('Facade.hs', facade('Prelude'));
    await current.sync({ paths: ['Facade.hs'] });
    expectCallbackKind(current, 'calls');
    expect(current.getStats().nodeCount).toBe(nodeCount);
  });

  it('rechecks canonical provenance when a project-local Prelude appears or disappears', async () => {
    const current = await createGraph();
    const consumerId = consumer(current).id;
    const nodeCount = current.getStats().nodeCount;
    expectCallbackKind(current, 'calls');

    write('Prelude.hs', 'module Prelude (map) where\nmap _ xs = xs\n');
    await current.sync({ paths: ['Prelude.hs'] });
    expectCallbackKind(current, 'references');
    expect(consumer(current).id).toBe(consumerId);

    fs.unlinkSync(path.join(tmpDir!, 'Prelude.hs'));
    await current.sync({ paths: ['Prelude.hs'] });
    expectCallbackKind(current, 'calls');
    expect(consumer(current).id).toBe(consumerId);
    expect(current.getStats().nodeCount).toBe(nodeCount);
  });
});
