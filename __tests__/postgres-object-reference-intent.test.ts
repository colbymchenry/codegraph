/**
 * PostgreSQL object-reference intents.
 *
 * Type and sequence uses share PostgreSQL's identifier/search_path rules with
 * relation uses, but they must never bind to a same-named table (or fall into
 * the generic framework/fuzzy pipeline). The internal intent is retained only
 * until resolution; persisted graph edges remain ordinary `references`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import {
  POSTGRES_SEQUENCE_REFERENCE_KIND,
  POSTGRES_TYPE_REFERENCE_KIND,
} from '../src/postgres/reference-intent';
import { createResolver } from '../src/resolution';
import { matchReference } from '../src/resolution/name-matcher';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';
import type { Language, Node, NodeKind, UnresolvedReference } from '../src/types';

interface NodeOptions {
  id: string;
  name: string;
  qualifiedName: string;
  filePath?: string;
  kind?: NodeKind;
  language?: Language;
  decorators?: string[];
}

function makeNode(options: NodeOptions): Node {
  return {
    id: options.id,
    name: options.name,
    qualifiedName: options.qualifiedName,
    filePath: options.filePath ?? 'migrations/001.sql',
    kind: options.kind ?? 'struct',
    language: options.language ?? 'postgres',
    decorators: options.decorators,
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 1,
    updatedAt: 0,
  };
}

function makeRef(
  referenceName: string,
  referenceKind: UnresolvedRef['referenceKind'],
  filePath = 'migrations/consumer.sql'
): UnresolvedRef {
  return {
    fromNodeId: 'consumer',
    referenceName,
    referenceKind,
    line: 2,
    column: 1,
    filePath,
    language: 'postgres',
  };
}

function contextFor(nodes: Node[], sources: Record<string, string> = {}): ResolutionContext {
  return {
    getNodesInFile: (filePath) => nodes.filter((node) => node.filePath === filePath),
    getNodesByName: (name) => nodes.filter((node) => node.name === name),
    getNodesByQualifiedName: (name) =>
      nodes.filter((node) => node.qualifiedName === name),
    getNodesByKind: (kind) => nodes.filter((node) => node.kind === kind),
    fileExists: (filePath) => nodes.some((node) => node.filePath === filePath),
    readFile: (filePath) => sources[filePath] ?? null,
    getProjectRoot: () => '/project',
    getAllFiles: () => [...new Set(nodes.map((node) => node.filePath))],
    getNodesByLowerName: (name) =>
      nodes.filter((node) => node.name.toLowerCase() === name),
    getImportMappings: () => [],
  };
}

describe('PostgreSQL object-reference intent matching', () => {
  it('keeps ordinary relation, type, and sequence targets disjoint', () => {
    const table = makeNode({
      id: 'table',
      name: 'status',
      qualifiedName: 'public.status',
      kind: 'struct',
      decorators: ['postgres:table'],
    });
    const type = makeNode({
      id: 'type',
      name: 'status',
      qualifiedName: 'public.status',
      kind: 'enum',
      decorators: ['postgres:enum'],
    });
    const sequence = makeNode({
      id: 'sequence',
      name: 'status',
      qualifiedName: 'public.status',
      kind: 'variable',
      decorators: ['postgres:sequence'],
    });
    const context = contextFor([table, type, sequence]);

    expect(matchReference(makeRef('public.status', 'references'), context))
      .toMatchObject({ targetNodeId: table.id });
    expect(matchReference(makeRef('public.status', POSTGRES_TYPE_REFERENCE_KIND), context))
      .toMatchObject({ targetNodeId: type.id });
    expect(matchReference(makeRef('public.status', POSTGRES_SEQUENCE_REFERENCE_KIND), context))
      .toMatchObject({ targetNodeId: sequence.id });
  });

  it.each([
    ['enum', 'enum', 'postgres:enum'],
    ['domain', 'type_alias', 'postgres:domain'],
    ['composite type', 'type_alias', 'postgres:type'],
  ] as const)('accepts a decorated PostgreSQL %s', (_label, kind, decorator) => {
    const target = makeNode({
      id: decorator,
      name: 'status',
      qualifiedName: 'app.status',
      kind,
      decorators: [decorator],
    });
    const decoy = makeNode({
      id: `${decorator}:decoy`,
      name: 'status',
      qualifiedName: 'app.status',
      kind,
      language: 'typescript',
      decorators: [decorator],
    });

    expect(matchReference(
      makeRef('app.status', POSTGRES_TYPE_REFERENCE_KIND),
      contextFor([target, decoy])
    )).toMatchObject({ targetNodeId: target.id });
  });

  it('preserves quoted identifiers, search_path order, and duplicate ambiguity', () => {
    const filePath = 'migrations/consumer.sql';
    const source = 'SET search_path = app, public;\nSELECT 1;';
    const appType = makeNode({
      id: 'app-type',
      name: 'Status.Type',
      qualifiedName: 'app."Status.Type"',
      kind: 'enum',
      decorators: ['postgres:enum'],
    });
    const publicType = makeNode({
      id: 'public-type',
      name: 'Status.Type',
      qualifiedName: 'public."Status.Type"',
      kind: 'enum',
      decorators: ['postgres:enum'],
    });
    const context = contextFor([appType, publicType], { [filePath]: source });

    expect(matchReference(
      makeRef('"Status.Type"', POSTGRES_TYPE_REFERENCE_KIND, filePath),
      context
    )).toMatchObject({ targetNodeId: appType.id });

    const duplicate = makeNode({
      ...appType,
      id: 'app-type-v2',
      filePath: 'migrations/002.sql',
    });
    expect(matchReference(
      makeRef('app."Status.Type"', POSTGRES_TYPE_REFERENCE_KIND, filePath),
      contextFor([appType, duplicate])
    )).toBeNull();
  });

  it('rejects undecorated and wrong-class PostgreSQL nodes', () => {
    const nodes = [
      makeNode({
        id: 'undecorated-type',
        name: 'status',
        qualifiedName: 'public.status',
        kind: 'enum',
      }),
      makeNode({
        id: 'wrong-type',
        name: 'status',
        qualifiedName: 'public.status',
        kind: 'enum',
        decorators: ['postgres:sequence'],
      }),
      makeNode({
        id: 'wrong-sequence',
        name: 'events_id_seq',
        qualifiedName: 'public.events_id_seq',
        kind: 'variable',
        decorators: ['postgres:type'],
      }),
    ];
    const context = contextFor(nodes);

    expect(matchReference(
      makeRef('public.status', POSTGRES_TYPE_REFERENCE_KIND),
      context
    )).toBeNull();
    expect(matchReference(
      makeRef('public.events_id_seq', POSTGRES_SEQUENCE_REFERENCE_KIND),
      context
    )).toBeNull();
  });
});

describe('PostgreSQL object-reference intent persistence', () => {
  const cleanup: Array<{ dir: string; db: DatabaseConnection }> = [];

  afterEach(() => {
    for (const item of cleanup.splice(0)) {
      item.db.close();
      fs.rmSync(item.dir, { recursive: true, force: true });
    }
  });

  it('materializes quoted search_path matches as ordinary references edges', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pg-object-ref-'));
    const db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    cleanup.push({ dir, db });
    const queries = new QueryBuilder(db.getDb());
    const consumerPath = 'consumer.sql';
    fs.writeFileSync(
      path.join(dir, consumerPath),
      'SET search_path = app;\nSELECT 1;\nSELECT 2;\n'
    );
    fs.writeFileSync(path.join(dir, 'types.sql'), '');
    fs.writeFileSync(path.join(dir, 'sequences.sql'), '');

    const consumer = makeNode({
      id: 'consumer',
      name: 'consumer.sql',
      qualifiedName: consumerPath,
      filePath: consumerPath,
      kind: 'file',
    });
    const type = makeNode({
      id: 'type',
      name: 'Status.Type',
      qualifiedName: 'app."Status.Type"',
      filePath: 'types.sql',
      kind: 'enum',
      decorators: ['postgres:enum'],
    });
    const typeDecoy = makeNode({
      id: 'type-decoy-table',
      name: 'Status.Type',
      qualifiedName: 'app."Status.Type"',
      filePath: 'types.sql',
      kind: 'struct',
      decorators: ['postgres:table'],
    });
    const sequence = makeNode({
      id: 'sequence',
      name: 'Seq.Name',
      qualifiedName: 'app."Seq.Name"',
      filePath: 'sequences.sql',
      kind: 'variable',
      decorators: ['postgres:sequence'],
    });
    const sequenceDecoy = makeNode({
      id: 'sequence-decoy-type',
      name: 'Seq.Name',
      qualifiedName: 'app."Seq.Name"',
      filePath: 'sequences.sql',
      kind: 'type_alias',
      decorators: ['postgres:type'],
    });
    for (const node of [consumer, type, typeDecoy, sequence, sequenceDecoy]) {
      queries.insertNode(node);
    }

    const refs: UnresolvedReference[] = [
      {
        fromNodeId: consumer.id,
        referenceName: '"Status.Type"',
        referenceKind: POSTGRES_TYPE_REFERENCE_KIND,
        line: 2,
        column: 1,
        filePath: consumerPath,
        language: 'postgres',
      },
      {
        fromNodeId: consumer.id,
        referenceName: '"Seq.Name"',
        referenceKind: POSTGRES_SEQUENCE_REFERENCE_KIND,
        line: 3,
        column: 1,
        filePath: consumerPath,
        language: 'postgres',
      },
    ];
    queries.insertUnresolvedRefsBatch(refs);

    const resolver = createResolver(dir, queries);
    const result = resolver.resolveAndPersist(queries.getUnresolvedReferences());
    expect(result.resolved).toHaveLength(2);
    expect(result.unresolved).toEqual([]);

    const edges = queries.getOutgoingEdges(consumer.id);
    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: type.id,
        kind: 'references',
        metadata: expect.objectContaining({
          refKind: POSTGRES_TYPE_REFERENCE_KIND,
          refName: '"Status.Type"',
        }),
      }),
      expect.objectContaining({
        target: sequence.id,
        kind: 'references',
        metadata: expect.objectContaining({
          refKind: POSTGRES_SEQUENCE_REFERENCE_KIND,
          refName: '"Seq.Name"',
        }),
      }),
    ]));
    expect(edges.some((edge) =>
      edge.target === typeDecoy.id || edge.target === sequenceDecoy.id
    )).toBe(false);
    expect(queries.getUnresolvedReferencesCount()).toBe(0);
  });
});
