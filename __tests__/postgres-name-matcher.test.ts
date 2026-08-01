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
  signature?: string;
  startLine?: number;
  endLine?: number;
  startColumn?: number;
  endColumn?: number;
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
    signature: options.signature,
    startLine: options.startLine ?? 1,
    endLine: options.endLine ?? options.startLine ?? 1,
    startColumn: options.startColumn ?? 0,
    endColumn: options.endColumn ?? 1,
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

function contextFor(nodes: Node[], sources: Record<string, string> = {}): ResolutionContext {
  return {
    getNodesInFile: (filePath) => nodes.filter((node) => node.filePath === filePath),
    getNodesByName: (name) => nodes.filter((node) => node.name === name),
    getNodesByQualifiedName: (qualifiedName) =>
      nodes.filter((node) => node.qualifiedName === qualifiedName),
    getNodesByKind: (kind) => nodes.filter((node) => node.kind === kind),
    fileExists: (filePath) => nodes.some((node) => node.filePath === filePath),
    readFile: (filePath) => sources[filePath] ?? null,
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

  it('distinguishes dots inside quoted identifier segments', () => {
    const quotedSchema = makeNode({
      id: 'quoted-schema',
      name: 'users',
      qualifiedName: '"public.app".users',
      filePath: 'migrations/001.sql',
    });
    const quotedTable = makeNode({
      id: 'quoted-table',
      name: 'app.users',
      qualifiedName: 'public."app.users"',
      filePath: 'migrations/002.sql',
    });
    const context = contextFor([quotedSchema, quotedTable]);
    expect(matchReference(makeRef('"public.app".users'), context))
      .toMatchObject({ targetNodeId: quotedSchema.id });
    expect(matchReference(makeRef('public."app.users"'), context))
      .toMatchObject({ targetNodeId: quotedTable.id });
  });

  it('searches an unqualified quoted-dot name without treating its dot as a separator', () => {
    const filePath = 'migrations/003.sql';
    const table = makeNode({
      id: 'versioned-users',
      name: 'users.v2',
      qualifiedName: 'app."users.v2"',
      filePath: 'migrations/001.sql',
    });
    const source = 'SET search_path=app; SELECT * FROM "users.v2";';
    expect(matchReference(
      { ...makeRef('"users.v2"', filePath), line: 1, column: source.indexOf('"users.v2"') },
      contextFor([table], { [filePath]: source })
    )).toMatchObject({ targetNodeId: table.id });
  });

  it('prefers same-file pg_temp relations and never leaks them across migration files', () => {
    const localFile = 'migrations/003.sql';
    const persistent = makeNode({
      id: 'public-sessions',
      name: 'sessions',
      qualifiedName: 'public.sessions',
      filePath: 'migrations/001.sql',
    });
    const temporary = makeNode({
      id: 'temp-sessions',
      name: 'sessions',
      qualifiedName: 'pg_temp.sessions',
      filePath: localFile,
      decorators: ['postgres:table', 'postgres:temporary'],
    });
    const context = contextFor([persistent, temporary]);
    expect(matchReference(makeRef('sessions', localFile), context))
      .toMatchObject({ targetNodeId: temporary.id });
    expect(matchReference(makeRef('public.sessions', localFile), context))
      .toMatchObject({ targetNodeId: persistent.id });
    expect(matchReference(makeRef('sessions', 'migrations/004.sql'), context))
      .toMatchObject({ targetNodeId: persistent.id });
    expect(matchReference(makeRef('pg_temp.sessions', 'migrations/004.sql'), context)).toBeNull();
  });

  it('honors same-file temporary relation declaration and drop order', () => {
    const filePath = 'migrations/003.sql';
    const source = [
      'SELECT * FROM sessions;',
      'CREATE TEMP TABLE sessions (id bigint);',
      'SELECT * FROM sessions;',
      'DROP TABLE sessions;',
      'SELECT * FROM sessions;',
    ].join('\n');
    const persistent = makeNode({
      id: 'public-sessions',
      name: 'sessions',
      qualifiedName: 'public.sessions',
      filePath: 'migrations/001.sql',
    });
    const temporary = makeNode({
      id: 'temp-sessions',
      name: 'sessions',
      qualifiedName: 'pg_temp.sessions',
      filePath,
      decorators: ['postgres:table', 'postgres:temporary'],
      startLine: 2,
      endLine: 2,
      endColumn: source.split('\n')[1]!.length - 1,
    });
    const context = contextFor([persistent, temporary], { [filePath]: source });
    const atLine = (line: number) => matchReference(
      { ...makeRef('sessions', filePath), line, column: source.split('\n')[line - 1]!.indexOf('sessions') },
      context
    );

    expect(atLine(1)).toMatchObject({ targetNodeId: persistent.id });
    expect(atLine(3)).toMatchObject({ targetNodeId: temporary.id });
    expect(atLine(5)).toMatchObject({ targetNodeId: persistent.id });
  });

  it('applies ON COMMIT DROP and rolls transactional DROP back', () => {
    const filePath = 'migrations/003.sql';
    const source = [
      'BEGIN;',
      'CREATE TEMP TABLE sessions (id bigint) ON COMMIT DROP;',
      'SELECT * FROM sessions;',
      'COMMIT;',
      'SELECT * FROM sessions;',
      'CREATE TEMP TABLE scratch (id bigint);',
      'BEGIN;',
      'DROP TABLE scratch;',
      'SELECT * FROM scratch;',
      'ROLLBACK;',
      'SELECT * FROM scratch;',
      'BEGIN;',
      'SAVEPOINT keep_scratch;',
      'DROP TABLE scratch;',
      'ROLLBACK TO SAVEPOINT keep_scratch;',
      'SELECT * FROM scratch;',
      'SAVEPOINT before_later;',
      'CREATE TEMP TABLE later (id bigint);',
      'ROLLBACK TO before_later;',
      'SELECT * FROM later;',
      'COMMIT;',
    ].join('\n');
    const persistentSessions = makeNode({
      id: 'public-sessions',
      name: 'sessions',
      qualifiedName: 'public.sessions',
      filePath: 'migrations/001.sql',
    });
    const persistentScratch = makeNode({
      id: 'public-scratch',
      name: 'scratch',
      qualifiedName: 'public.scratch',
      filePath: 'migrations/001.sql',
    });
    const persistentLater = makeNode({
      id: 'public-later',
      name: 'later',
      qualifiedName: 'public.later',
      filePath: 'migrations/001.sql',
    });
    const temporarySessions = makeNode({
      id: 'temp-sessions',
      name: 'sessions',
      qualifiedName: 'pg_temp.sessions',
      filePath,
      decorators: ['postgres:table', 'postgres:temporary'],
      startLine: 2,
      endLine: 2,
      endColumn: source.split('\n')[1]!.length - 1,
      signature: 'CREATE TEMP TABLE sessions (id bigint) ON COMMIT DROP',
    });
    const temporaryScratch = makeNode({
      id: 'temp-scratch',
      name: 'scratch',
      qualifiedName: 'pg_temp.scratch',
      filePath,
      decorators: ['postgres:table', 'postgres:temporary'],
      startLine: 6,
      endLine: 6,
      endColumn: source.split('\n')[5]!.length - 1,
    });
    const temporaryLater = makeNode({
      id: 'temp-later',
      name: 'later',
      qualifiedName: 'pg_temp.later',
      filePath,
      decorators: ['postgres:table', 'postgres:temporary'],
      startLine: 18,
      endLine: 18,
      endColumn: source.split('\n')[17]!.length - 1,
    });
    const context = contextFor(
      [
        persistentSessions,
        persistentScratch,
        persistentLater,
        temporarySessions,
        temporaryScratch,
        temporaryLater,
      ],
      { [filePath]: source }
    );
    const resolveAt = (name: string, line: number) => matchReference({
      ...makeRef(name, filePath),
      line,
      column: source.split('\n')[line - 1]!.indexOf(name),
    }, context);

    expect(resolveAt('sessions', 3)).toMatchObject({ targetNodeId: temporarySessions.id });
    expect(resolveAt('sessions', 5)).toMatchObject({ targetNodeId: persistentSessions.id });
    expect(resolveAt('scratch', 9)).toMatchObject({ targetNodeId: persistentScratch.id });
    expect(resolveAt('scratch', 11)).toMatchObject({ targetNodeId: temporaryScratch.id });
    expect(resolveAt('scratch', 16)).toMatchObject({ targetNodeId: temporaryScratch.id });
    expect(resolveAt('later', 20)).toMatchObject({ targetNodeId: persistentLater.id });
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

  it('uses PostgreSQL default public before same-named objects in other schemas', () => {
    const nodes = [
      makeNode({
        id: 'public-users',
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

    expect(matchReference(makeRef('users'), contextFor(nodes)))
      .toMatchObject({ targetNodeId: 'public-users' });
  });

  it('preserves ambiguity in the first matching schema over a legacy fallback', () => {
    const nodes = [
      makeNode({
        id: 'public-users-v1',
        name: 'users',
        qualifiedName: 'public.users',
        filePath: 'migrations/001_public.sql',
      }),
      makeNode({
        id: 'public-users-v2',
        name: 'users',
        qualifiedName: 'public.users',
        filePath: 'migrations/002_public.sql',
      }),
      makeNode({
        id: 'legacy-users',
        name: 'users',
        qualifiedName: 'users',
        filePath: 'migrations/000_legacy.sql',
      }),
    ];

    expect(matchReference(makeRef('users'), contextFor(nodes))).toBeNull();
  });

  it('does not pick a path-proximate object when no search-path schema matches', () => {
    const nodes = [
      makeNode({
        id: 'auth-users',
        name: 'users',
        qualifiedName: 'auth::users',
        filePath: 'migrations/002_near.sql',
      }),
      makeNode({
        id: 'history-users',
        name: 'users',
        qualifiedName: 'history::users',
        filePath: 'schemas/history/001.sql',
      }),
    ];

    expect(matchReference(makeRef('users'), contextFor(nodes))).toBeNull();
  });

  it('does not resolve a unique relation outside the default search path', () => {
    const authUsers = makeNode({
      id: 'auth-users',
      name: 'users',
      qualifiedName: 'auth.users',
      filePath: 'migrations/001_auth.sql',
    });

    expect(matchReference(makeRef('users'), contextFor([authUsers]))).toBeNull();
  });

  it('honors the active SET search_path before the reference line', () => {
    const filePath = 'migrations/003_consumer.sql';
    const nodes = [
      makeNode({
        id: 'public-users',
        name: 'users',
        qualifiedName: 'public.users',
        filePath: 'migrations/001_public.sql',
      }),
      makeNode({
        id: 'history-users',
        name: 'users',
        qualifiedName: 'history.users',
        filePath: 'migrations/001_history.sql',
      }),
    ];
    const source = 'SET search_path TO history, public;\n\nSELECT * FROM users;\n';

    expect(matchReference(makeRef('users', filePath), contextFor(nodes, { [filePath]: source })))
      .toMatchObject({ targetNodeId: 'history-users' });
  });

  it('does not invent a public fallback after an explicitly empty search_path', () => {
    const filePath = 'migrations/003_consumer.sql';
    const publicUsers = makeNode({
      id: 'public-users',
      name: 'users',
      qualifiedName: 'public.users',
      filePath: 'migrations/001_public.sql',
    });
    const source = "SELECT pg_catalog.set_config('search_path', '', false);\nSELECT * FROM users;\n";

    expect(matchReference(
      makeRef('users', filePath),
      contextFor([publicUsers], { [filePath]: source })
    )).toBeNull();
  });

  it('decodes quoted SET values and preserves same-line statement order', () => {
    const filePath = 'migrations/003_consumer.sql';
    const historyUsers = makeNode({
      id: 'history-users',
      name: 'users',
      qualifiedName: 'history.users',
      filePath: 'migrations/001_history.sql',
    });
    const source = "SET search_path = 'history'; SELECT * FROM users;\r\n";
    const ref = {
      ...makeRef('users', filePath),
      line: 1,
      column: source.indexOf('users'),
    };

    expect(matchReference(ref, contextFor([historyUsers], { [filePath]: source })))
      .toMatchObject({ targetNodeId: 'history-users' });
  });

  it('preserves case and commas in SET string-literal schema names', () => {
    const filePath = 'migrations/003_consumer.sql';
    const nodes = [
      makeNode({
        id: 'camel-users',
        name: 'users',
        qualifiedName: '"CamelSchema".users',
        filePath: 'migrations/001_camel.sql',
      }),
      makeNode({
        id: 'comma-users',
        name: 'users',
        qualifiedName: '"a,b, public".users',
        filePath: 'migrations/001_comma.sql',
      }),
    ];

    for (const [source, targetNodeId] of [
      ["SET search_path = 'CamelSchema'; SELECT * FROM users;", 'camel-users'],
      ["SET search_path = 'a,b, public'; SELECT * FROM users;", 'comma-users'],
    ] as const) {
      expect(matchReference(
        { ...makeRef('users', filePath), line: 1, column: source.indexOf('users') },
        contextFor(nodes, { [filePath]: source })
      )).toMatchObject({ targetNodeId });
    }
  });

  it('treats SET SCHEMA literals as a one-element search path', () => {
    const filePath = 'migrations/003_consumer.sql';
    const nodes = [
      makeNode({
        id: 'history-users',
        name: 'users',
        qualifiedName: 'history.users',
        filePath: 'migrations/001_history.sql',
      }),
      makeNode({
        id: 'camel-users',
        name: 'users',
        qualifiedName: '"CamelSchema".users',
        filePath: 'migrations/001_camel.sql',
      }),
      makeNode({
        id: 'comma-users',
        name: 'users',
        qualifiedName: '"a,b".users',
        filePath: 'migrations/001_comma.sql',
      }),
    ];

    for (const [source, targetNodeId] of [
      ["set schema 'history'; SELECT * FROM users;", 'history-users'],
      ["SET SESSION SCHEMA 'CamelSchema'; SELECT * FROM users;", 'camel-users'],
      ["SeT ScHeMa 'a,b'; SELECT * FROM users;", 'comma-users'],
    ] as const) {
      expect(matchReference(
        { ...makeRef('users', filePath), line: 1, column: source.indexOf('users') },
        contextFor(nodes, { [filePath]: source })
      )).toMatchObject({ targetNodeId });
    }
  });

  it('applies SET LOCAL SCHEMA only inside its transaction', () => {
    const filePath = 'migrations/003_consumer.sql';
    const nodes = [
      makeNode({
        id: 'public-users',
        name: 'users',
        qualifiedName: 'public.users',
        filePath: 'migrations/001_public.sql',
      }),
      makeNode({
        id: 'history-users',
        name: 'users',
        qualifiedName: 'history.users',
        filePath: 'migrations/001_history.sql',
      }),
    ];
    const source = [
      "SET LOCAL SCHEMA 'history'; SELECT * FROM users;",
      "BEGIN; SET LOCAL SCHEMA 'history'; SELECT * FROM users; COMMIT;",
      'SELECT * FROM users;',
    ].join('\n');
    const first = source.indexOf('users');
    const second = source.indexOf('users', first + 1);
    const context = contextFor(nodes, { [filePath]: source });

    expect(matchReference(
      { ...makeRef('users', filePath), line: 1, column: first },
      context
    )).toMatchObject({ targetNodeId: 'public-users' });
    expect(matchReference(
      { ...makeRef('users', filePath), line: 2, column: second - source.indexOf('\n') - 1 },
      context
    )).toMatchObject({ targetNodeId: 'history-users' });
    expect(matchReference(
      { ...makeRef('users', filePath), line: 3, column: 14 },
      context
    )).toMatchObject({ targetNodeId: 'public-users' });
  });

  it('rolls back a session-level SET SCHEMA issued in a transaction', () => {
    const filePath = 'migrations/003_consumer.sql';
    const nodes = [
      makeNode({
        id: 'public-users',
        name: 'users',
        qualifiedName: 'public.users',
        filePath: 'migrations/001_public.sql',
      }),
      makeNode({
        id: 'history-users',
        name: 'users',
        qualifiedName: 'history.users',
        filePath: 'migrations/001_history.sql',
      }),
    ];
    const source = "BEGIN; SET SESSION SCHEMA 'history'; SELECT * FROM users; " +
      'ROLLBACK; SELECT * FROM users;';
    const context = contextFor(nodes, { [filePath]: source });

    expect(matchReference(
      { ...makeRef('users', filePath), line: 1, column: source.indexOf('users') },
      context
    )).toMatchObject({ targetNodeId: 'history-users' });
    expect(matchReference(
      { ...makeRef('users', filePath), line: 1, column: source.lastIndexOf('users') },
      context
    )).toMatchObject({ targetNodeId: 'public-users' });
  });

  it('supports dollar-quoted SET values without mistaking $ inside identifiers', () => {
    const filePath = 'migrations/003_consumer.sql';
    const nodes = [
      makeNode({
        id: 'camel-users',
        name: 'users',
        qualifiedName: '"CamelSchema".users',
        filePath: 'migrations/001_camel.sql',
      }),
      makeNode({
        id: 'history-users',
        name: 'users',
        qualifiedName: 'history.users',
        filePath: 'migrations/001_history.sql',
      }),
    ];
    const dollar = 'SET search_path = $$CamelSchema$$; SELECT * FROM users;';
    const identifier = [
      'CREATE TABLE foo$tag$bar(id int);',
      'SET search_path = history;',
      'SELECT * FROM users;',
    ].join('\n');

    expect(matchReference(
      { ...makeRef('users', filePath), line: 1, column: dollar.indexOf('users') },
      contextFor(nodes, { [filePath]: dollar })
    )).toMatchObject({ targetNodeId: 'camel-users' });
    expect(matchReference(
      { ...makeRef('users', filePath), line: 3, column: 14 },
      contextFor(nodes, { [filePath]: identifier })
    )).toMatchObject({ targetNodeId: 'history-users' });
  });

  it('resumes SQL parsing after a pg_dump COPY FROM STDIN payload', () => {
    const filePath = 'migrations/dump.sql';
    const historyUsers = makeNode({
      id: 'history-users',
      name: 'users',
      qualifiedName: 'history.users',
      filePath: 'migrations/001_history.sql',
    });
    const source = [
      'COPY public.seed FROM stdin;',
      '1;not SQL',
      '\\.',
      'SET search_path = history;',
      'SELECT * FROM users;',
    ].join('\n');

    expect(matchReference(
      { ...makeRef('users', filePath), line: 5, column: 14 },
      contextFor([historyUsers], { [filePath]: source })
    )).toMatchObject({ targetNodeId: 'history-users' });
  });

  it('tracks explicit transaction-local paths and rollback restoration', () => {
    const filePath = 'migrations/003_consumer.sql';
    const nodes = [
      makeNode({
        id: 'public-users',
        name: 'users',
        qualifiedName: 'public.users',
        filePath: 'migrations/001_public.sql',
      }),
      makeNode({
        id: 'history-users',
        name: 'users',
        qualifiedName: 'history.users',
        filePath: 'migrations/001_history.sql',
      }),
    ];
    for (const terminator of ['COMMIT', 'ROLLBACK'] as const) {
      const source = terminator === 'COMMIT'
        ? 'BEGIN; SET LOCAL search_path=history; SELECT * FROM users; COMMIT; SELECT * FROM users;'
        : 'BEGIN; SET search_path=history; SELECT * FROM users; ROLLBACK; SELECT * FROM users;';
      const first = source.indexOf('users');
      const second = source.lastIndexOf('users');
      const context = contextFor(nodes, { [filePath]: source });
      expect(matchReference(
        { ...makeRef('users', filePath), line: 1, column: first },
        context
      )).toMatchObject({ targetNodeId: 'history-users' });
      expect(matchReference(
        { ...makeRef('users', filePath), line: 1, column: second },
        context
      )).toMatchObject({ targetNodeId: 'public-users' });
    }
  });

  it('restores search_path state when rolling back to a savepoint', () => {
    const filePath = 'migrations/003_consumer.sql';
    const nodes = [
      makeNode({
        id: 'public-users',
        name: 'users',
        qualifiedName: 'public.users',
        filePath: 'migrations/001_public.sql',
      }),
      makeNode({
        id: 'history-users',
        name: 'users',
        qualifiedName: 'history.users',
        filePath: 'migrations/001_history.sql',
      }),
    ];
    for (const set of ['SET search_path=history', 'SET LOCAL search_path=history']) {
      const source = `BEGIN; ${set}; SAVEPOINT s; SET LOCAL search_path=public; ` +
        'ROLLBACK WORK TO SAVEPOINT s; SELECT * FROM users;';
      expect(matchReference(
        { ...makeRef('users', filePath), line: 1, column: source.lastIndexOf('users') },
        contextFor(nodes, { [filePath]: source })
      )).toMatchObject({ targetNodeId: 'history-users' });
    }
  });

  it('keeps SET LOCAL active in transactions started by AND CHAIN', () => {
    const filePath = 'migrations/003_consumer.sql';
    const nodes = [
      makeNode({
        id: 'public-users',
        name: 'users',
        qualifiedName: 'public.users',
        filePath: 'migrations/001_public.sql',
      }),
      makeNode({
        id: 'history-users',
        name: 'users',
        qualifiedName: 'history.users',
        filePath: 'migrations/001_history.sql',
      }),
    ];
    for (const terminator of ['COMMIT AND CHAIN', 'ROLLBACK AND CHAIN']) {
      const source = 'BEGIN; SET search_path=history; ' + terminator +
        '; SET LOCAL search_path=public; SELECT * FROM users;';
      expect(matchReference(
        { ...makeRef('users', filePath), line: 1, column: source.lastIndexOf('users') },
        contextFor(nodes, { [filePath]: source })
      )).toMatchObject({ targetNodeId: 'public-users' });
    }
  });

  it('treats a quoted empty SET value as an explicitly empty path', () => {
    const filePath = 'migrations/003_consumer.sql';
    const publicUsers = makeNode({
      id: 'public-users',
      name: 'users',
      qualifiedName: 'public.users',
      filePath: 'migrations/001_public.sql',
    });
    const source = "SET search_path = '';\r\nSELECT * FROM users;\r\n";

    expect(matchReference(
      { ...makeRef('users', filePath), line: 2, column: 14 },
      contextFor([publicUsers], { [filePath]: source })
    )).toBeNull();
  });

  it('ignores transaction-local search_path changes', () => {
    const filePath = 'migrations/003_consumer.sql';
    const nodes = [
      makeNode({
        id: 'public-users',
        name: 'users',
        qualifiedName: 'public.users',
        filePath: 'migrations/001_public.sql',
      }),
      makeNode({
        id: 'history-users',
        name: 'users',
        qualifiedName: 'history.users',
        filePath: 'migrations/001_history.sql',
      }),
    ];

    for (const source of [
      'SET LOCAL search_path = history;\nSELECT * FROM users;\n',
      "SELECT set_config('search_path', 'history', true);\nSELECT * FROM users;\n",
    ]) {
      expect(matchReference(
        { ...makeRef('users', filePath), line: 2, column: 14 },
        contextFor(nodes, { [filePath]: source })
      )).toMatchObject({ targetNodeId: 'public-users' });
    }
  });

  it('ignores comments, function bodies, and CREATE FUNCTION SET clauses', () => {
    const filePath = 'migrations/003_consumer.sql';
    const publicUsers = makeNode({
      id: 'public-users',
      name: 'users',
      qualifiedName: 'public.users',
      filePath: 'migrations/001_public.sql',
    });
    const source = [
      '-- SET search_path = history;',
      '/* SET search_path = history; */',
      "SELECT 'path\\';",
      'CREATE FUNCTION private.f() RETURNS void',
      'LANGUAGE plpgsql SET search_path = \'\'',
      'AS $body$',
      'BEGIN',
      '  SET search_path = history;',
      'END',
      '$body$;',
      'SELECT * FROM users;',
    ].join('\n');

    expect(matchReference(
      { ...makeRef('users', filePath), line: 11, column: 14 },
      contextFor([publicUsers], { [filePath]: source })
    )).toMatchObject({ targetNodeId: 'public-users' });
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
