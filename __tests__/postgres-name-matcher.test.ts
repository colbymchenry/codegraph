/**
 * PostgreSQL reference-resolution precision.
 *
 * Migration repositories commonly repeat an object across historical files
 * and reuse simple names in different schemas. These tests pin that PostgreSQL
 * references never inherit the generic matcher's suffix, fuzzy, or
 * path-proximity guesses.
 */
import { describe, expect, it } from 'vitest';
import { matchReference } from '../src/resolution/name-matcher';
import type { Language, Node, NodeKind } from '../src/types';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';

interface NodeOptions {
  id: string;
  name: string;
  qualifiedName?: string;
  filePath: string;
  kind?: NodeKind;
  language?: Language;
  decorators?: string[];
}

function makeNode(options: NodeOptions): Node {
  return {
    id: options.id,
    name: options.name,
    qualifiedName: options.qualifiedName ?? options.name,
    filePath: options.filePath,
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
  filePath = 'migrations/003_consumer.sql',
  referenceKind: UnresolvedRef['referenceKind'] = 'references'
): UnresolvedRef {
  return {
    fromNodeId: `from:${filePath}`,
    referenceName,
    referenceKind,
    line: 10,
    column: 2,
    filePath,
    language: 'postgres',
  };
}

function contextFor(nodes: Node[]): ResolutionContext {
  return {
    getNodesInFile: (filePath) => nodes.filter((node) => node.filePath === filePath),
    getNodesByName: (name) => nodes.filter((node) => node.name === name),
    getNodesByQualifiedName: (qualifiedName) =>
      nodes.filter((node) => node.qualifiedName === qualifiedName),
    getNodesByKind: (kind) => nodes.filter((node) => node.kind === kind),
    fileExists: (filePath) => nodes.some((node) => node.filePath === filePath),
    readFile: () => null,
    getProjectRoot: () => '/project',
    getAllFiles: () => [...new Set(nodes.map((node) => node.filePath))],
    getNodesByLowerName: (lowerName) =>
      nodes.filter((node) => node.name.toLowerCase() === lowerName),
    getImportMappings: () => [],
  };
}

describe('PostgreSQL qualified-name resolution', () => {
  it.each(['public.users', 'public::users'])(
    'matches only the exact canonical qualified name (%s)',
    (qualifiedName) => {
      const publicUsers = makeNode({
        id: 'public-users',
        name: 'users',
        qualifiedName,
        filePath: 'migrations/001_public.sql',
      });
      const authUsers = makeNode({
        id: 'auth-users',
        name: 'users',
        qualifiedName: qualifiedName.replace('public', 'auth'),
        filePath: 'migrations/001_auth.sql',
      });

      expect(matchReference(makeRef(qualifiedName), contextFor([publicUsers, authUsers])))
        .toMatchObject({ targetNodeId: publicUsers.id, resolvedBy: 'qualified-name' });
    }
  );

  it('does not use a qualified-name suffix match', () => {
    const nested = makeNode({
      id: 'nested-users',
      name: 'users',
      qualifiedName: 'tenant::public::users',
      filePath: 'migrations/001.sql',
    });

    expect(matchReference(makeRef('public::users'), contextFor([nested]))).toBeNull();
  });

  it('prefers one exact same-file revision over duplicate historical definitions', () => {
    const historical = makeNode({
      id: 'users-v1',
      name: 'users',
      qualifiedName: 'public::users',
      filePath: 'migrations/001_create_users.sql',
    });
    const local = makeNode({
      id: 'users-v2',
      name: 'users',
      qualifiedName: 'public::users',
      filePath: 'migrations/003_consumer.sql',
    });

    expect(matchReference(makeRef('public::users'), contextFor([historical, local])))
      .toMatchObject({ targetNodeId: local.id });
  });

  it('leaves duplicate exact definitions unresolved when none is in the reference file', () => {
    const nodes = [
      makeNode({
        id: 'users-v1',
        name: 'users',
        qualifiedName: 'public::users',
        filePath: 'migrations/001_create_users.sql',
      }),
      makeNode({
        id: 'users-v2',
        name: 'users',
        qualifiedName: 'public::users',
        filePath: 'migrations/002_replace_users.sql',
      }),
    ];

    expect(matchReference(makeRef('public::users'), contextFor(nodes))).toBeNull();
  });

  it('leaves multiple same-file overloads/revisions unresolved', () => {
    const nodes = [
      makeNode({
        id: 'calculate-int',
        name: 'calculate',
        qualifiedName: 'public::calculate',
        filePath: 'migrations/003_consumer.sql',
        kind: 'function',
        decorators: ['postgres:function'],
      }),
      makeNode({
        id: 'calculate-text',
        name: 'calculate',
        qualifiedName: 'public::calculate',
        filePath: 'migrations/003_consumer.sql',
        kind: 'function',
        decorators: ['postgres:function'],
      }),
    ];

    expect(matchReference(makeRef('public::calculate', undefined, 'calls'), contextFor(nodes)))
      .toBeNull();
  });
});

describe('PostgreSQL unqualified-name resolution', () => {
  it('prefers one same-file object over same-named objects in other schemas/files', () => {
    const local = makeNode({
      id: 'local-users',
      name: 'users',
      qualifiedName: 'public::users',
      filePath: 'migrations/003_consumer.sql',
    });
    const other = makeNode({
      id: 'auth-users',
      name: 'users',
      qualifiedName: 'auth::users',
      filePath: 'migrations/001_auth.sql',
    });

    expect(matchReference(makeRef('users'), contextFor([other, local])))
      .toMatchObject({ targetNodeId: local.id, resolvedBy: 'exact-match' });
  });

  it('resolves one globally unique object', () => {
    const users = makeNode({
      id: 'users',
      name: 'users',
      qualifiedName: 'public::users',
      filePath: 'migrations/001.sql',
    });

    expect(matchReference(makeRef('users'), contextFor([users])))
      .toMatchObject({ targetNodeId: users.id });
  });

  it('does not pick a path-proximate object when an unqualified name is ambiguous', () => {
    const nodes = [
      makeNode({
        id: 'near-users',
        name: 'users',
        qualifiedName: 'public::users',
        filePath: 'migrations/002_near.sql',
      }),
      makeNode({
        id: 'far-users',
        name: 'users',
        qualifiedName: 'auth::users',
        filePath: 'schemas/auth/001.sql',
      }),
    ];

    expect(matchReference(makeRef('users'), contextFor(nodes))).toBeNull();
  });

  it('does not fuzzy-match case variants', () => {
    const users = makeNode({
      id: 'users',
      name: 'users',
      filePath: 'migrations/001.sql',
    });

    expect(matchReference(makeRef('Users'), contextFor([users]))).toBeNull();
  });
});

describe('PostgreSQL target-kind precision', () => {
  it('resolves calls only to decorated routines, never a same-named trigger', () => {
    const relation = makeNode({
      id: 'relation-refresh',
      name: 'refresh_cache',
      filePath: 'migrations/001.sql',
      kind: 'struct',
    });
    const routine = makeNode({
      id: 'routine-refresh',
      name: 'refresh_cache',
      filePath: 'migrations/002.sql',
      kind: 'function',
      decorators: ['postgres:function'],
    });
    const trigger = makeNode({
      id: 'trigger-refresh',
      name: 'refresh_cache',
      qualifiedName: 'app.cache.refresh_cache',
      filePath: 'migrations/003_consumer.sql',
      kind: 'function',
      decorators: ['postgres:trigger'],
    });

    expect(
      matchReference(
        makeRef('refresh_cache', undefined, 'calls'),
        contextFor([relation, trigger, routine])
      )
    )
      .toMatchObject({ targetNodeId: routine.id });
  });

  it('resolves relation references only to struct nodes', () => {
    const file = makeNode({
      id: 'file-users',
      name: 'users',
      filePath: 'users.sql',
      kind: 'file',
    });
    const imported = makeNode({
      id: 'import-users',
      name: 'users',
      filePath: 'imports.sql',
      kind: 'import',
    });
    const column = makeNode({
      id: 'column-users',
      name: 'users',
      filePath: 'columns.sql',
      kind: 'field',
    });
    const policy = makeNode({
      id: 'policy-users',
      name: 'users',
      filePath: 'policies.sql',
      kind: 'constant',
    });
    const enumMember = makeNode({
      id: 'enum-member-users',
      name: 'users',
      qualifiedName: 'app.object_kind.users',
      filePath: 'types.sql',
      kind: 'enum_member',
    });

    expect(
      matchReference(makeRef('users'), contextFor([file, imported, column, policy, enumMember]))
    ).toBeNull();
  });

  it('ignores same-named symbols from other languages', () => {
    const typescript = makeNode({
      id: 'ts-users',
      name: 'users',
      filePath: 'src/users.ts',
      kind: 'constant',
      language: 'typescript',
    });
    const postgres = makeNode({
      id: 'pg-users',
      name: 'users',
      filePath: 'migrations/001.sql',
    });

    expect(matchReference(makeRef('users'), contextFor([typescript, postgres])))
      .toMatchObject({ targetNodeId: postgres.id });
  });
});
