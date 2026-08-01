import type { Node as SyntaxNode } from 'web-tree-sitter';
import { beforeAll, describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction';
import {
  getParser,
  getPostgresPlpgsqlParser,
  initGrammars,
  loadGrammarsForLanguages,
} from '../src/extraction/grammars';
import { discoverPostgresRoutineBodyReferences } from '../src/postgres/routine-body';
import { matchReference } from '../src/resolution/name-matcher';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';
import type { Node } from '../src/types';

function firstDescendant(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let index = 0; index < node.namedChildCount; index++) {
    const child = node.namedChild(index);
    if (!child) continue;
    if (child.type === type) return child;
    const nested = firstDescendant(child, type);
    if (nested) return nested;
  }
  return null;
}

function analyze(source: string) {
  const postgres = getParser('postgres')!;
  const tree = postgres.parse(source);
  const statement = firstDescendant(tree.rootNode, 'CreateFunctionStmt');
  expect(statement).not.toBeNull();
  const discovery = discoverPostgresRoutineBodyReferences(statement!, source, {
    postgres,
    plpgsql: getPostgresPlpgsqlParser(),
  });
  tree.delete();
  return discovery;
}

function table(id: string, qualifiedName: string, filePath = `${id}.sql`): Node {
  const name = qualifiedName.slice(qualifiedName.lastIndexOf('.') + 1).replace(/^"|"$/g, '');
  return {
    id,
    kind: 'struct',
    name,
    qualifiedName,
    filePath,
    language: 'postgres',
    decorators: ['postgres:table'],
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 1,
    updatedAt: 0,
  };
}

function contextFor(nodes: Node[], source = 'SET search_path = outer;\nSELECT 1;'): ResolutionContext {
  return {
    getNodesInFile: (filePath) => nodes.filter((node) => node.filePath === filePath),
    getNodesByName: (name) => nodes.filter((node) => node.name === name),
    getNodesByQualifiedName: (qualifiedName) =>
      nodes.filter((node) => node.qualifiedName === qualifiedName),
    getNodesByKind: (kind) => nodes.filter((node) => node.kind === kind),
    fileExists: (filePath) => nodes.some((node) => node.filePath === filePath),
    readFile: (filePath) => filePath === 'routine.sql' ? source : '',
    getProjectRoot: () => '/project',
    getAllFiles: () => [...new Set(nodes.map((node) => node.filePath))],
    getNodesByLowerName: (lowerName) =>
      nodes.filter((node) => node.name.toLowerCase() === lowerName),
    getImportMappings: () => [],
  };
}

function routineRef(candidates: string[]): UnresolvedRef {
  return {
    fromNodeId: 'routine',
    referenceName: 'jobs',
    referenceKind: 'references',
    line: 2,
    column: 1,
    filePath: 'routine.sql',
    language: 'postgres',
    candidates,
  };
}

describe('PostgreSQL routine-local search_path', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['postgres']);
  });

  it('qualifies SQL-body references with a single quoted schema', () => {
    const source = [
      'CREATE FUNCTION app.read_users() RETURNS SETOF record',
      'AS $$ SELECT touch_user(id) FROM users JOIN public.audit ON true $$',
      'LANGUAGE sql',
      'SET "search_path" TO "Tenant.Schema";',
    ].join('\n');

    const result = analyze(source);
    expect(result.status).toBe('analyzed');
    expect(result.facts.map((fact) => [fact.kind, fact.qualifiedName])).toEqual([
      ['calls', '"Tenant.Schema".touch_user'],
      ['references', '"Tenant.Schema".users'],
      ['references', 'public.audit'],
    ]);
    expect(result.facts.every((fact) => fact.searchPathCandidates === undefined)).toBe(true);
  });

  it('keeps PL/pgSQL procedure alternatives ordered instead of linking every schema', () => {
    const source = [
      'CREATE PROCEDURE run_jobs()',
      'LANGUAGE plpgsql',
      'SET search_path = app, public',
      'AS $$',
      'BEGIN',
      "  INSERT INTO jobs(id) VALUES (nextval('job_seq'));",
      '  PERFORM notify_job();',
      'END',
      '$$;',
    ].join('\n');

    const result = analyze(source);
    expect(result.status).toBe('analyzed');
    expect(result.facts.map((fact) => ({
      kind: fact.kind,
      name: fact.qualifiedName,
      candidates: fact.searchPathCandidates,
    }))).toEqual([
      { kind: 'references', name: 'jobs', candidates: ['app.jobs', 'public.jobs'] },
      { kind: 'calls', name: 'nextval', candidates: ['app.nextval', 'public.nextval'] },
      { kind: 'sequence', name: 'job_seq', candidates: ['app.job_seq', 'public.job_seq'] },
      { kind: 'calls', name: 'notify_job', candidates: ['app.notify_job', 'public.notify_job'] },
    ]);
  });

  it('captures FROM CURRENT without changing the surrounding file path', () => {
    const source = [
      'SET search_path = "Creation.Schema";',
      'CREATE FUNCTION read_users() RETURNS SETOF record',
      'SET search_path FROM CURRENT',
      'LANGUAGE sql',
      'AS $$ SELECT * FROM users $$;',
      'SELECT * FROM users;',
    ].join('\n');

    const facts = analyze(source).facts;
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ qualifiedName: '"Creation.Schema".users' });
    expect(facts[0]).not.toHaveProperty('searchPathCandidates');

    const extracted = extractFromSource('db/schema.sql', source, 'postgres');
    const routine = extracted.nodes.find((node) => node.decorators?.includes('postgres:function'))!;
    const routineReference = extracted.unresolvedReferences.find(
      (reference) => reference.fromNodeId === routine.id && reference.referenceName.endsWith('.users')
    );
    const fileReference = extracted.unresolvedReferences.find(
      (reference) => reference.fromNodeId !== routine.id && reference.referenceName === 'users'
    );
    expect(routineReference).toMatchObject({
      referenceName: '"Creation.Schema".users',
    });
    expect(fileReference).toMatchObject({ referenceName: 'users' });
    expect(routineReference).not.toHaveProperty('candidates');
    expect(fileReference).not.toHaveProperty('candidates');
  });

  it('persists multiple and empty routine paths without altering the ambient path', () => {
    const source = [
      'SET search_path = outer;',
      'CREATE PROCEDURE run_jobs()',
      'LANGUAGE plpgsql SET search_path = app, public',
      'AS $$ BEGIN INSERT INTO jobs VALUES (1); END $$;',
      'CREATE FUNCTION isolated() RETURNS SETOF record',
      "LANGUAGE sql SET search_path = ''",
      'AS $$ SELECT * FROM jobs $$;',
      'CREATE FUNCTION defaulted() RETURNS SETOF record',
      'LANGUAGE sql SET search_path TO DEFAULT',
      'AS $$ SELECT * FROM jobs $$;',
      'SELECT * FROM jobs;',
    ].join('\n');
    const extracted = extractFromSource('db/schema.sql', source, 'postgres');
    const routines = extracted.nodes.filter((node) =>
      node.decorators?.includes('postgres:function') || node.decorators?.includes('postgres:procedure')
    );
    const byRoutine = new Map(routines.map((routine) => [
      routine.name,
      extracted.unresolvedReferences.filter((reference) => reference.fromNodeId === routine.id),
    ]));

    expect(byRoutine.get('run_jobs')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        referenceName: 'jobs',
        candidates: ['app.jobs', 'public.jobs'],
      }),
    ]));
    expect(byRoutine.get('isolated')).toEqual(expect.arrayContaining([
      expect.objectContaining({ referenceName: 'jobs', candidates: [] }),
    ]));
    expect(byRoutine.get('defaulted')).toEqual(expect.arrayContaining([
      expect.objectContaining({ referenceName: 'public.jobs' }),
    ]));
    expect(extracted.unresolvedReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fromNodeId: 'file:db/schema.sql',
        referenceName: 'jobs',
      }),
    ]));
    const ambientReference = extracted.unresolvedReferences.find(
      (reference) => reference.fromNodeId === 'file:db/schema.sql' &&
        reference.referenceName === 'jobs'
    );
    expect(ambientReference).not.toHaveProperty('candidates');
  });

  it('resolves ordered candidates with first-existing-schema and ambiguity semantics', () => {
    const app = table('app-jobs', 'app.jobs');
    const publicJobs = table('public-jobs', 'public.jobs');
    const outer = table('outer-jobs', 'outer.jobs');
    const candidates = ['app.jobs', 'public.jobs'];

    expect(matchReference(routineRef(candidates), contextFor([app, publicJobs, outer])))
      .toMatchObject({ targetNodeId: app.id });
    expect(matchReference(routineRef(candidates), contextFor([publicJobs, outer])))
      .toMatchObject({ targetNodeId: publicJobs.id });

    const duplicateApp = table('app-jobs-v2', 'app.jobs', 'app-v2.sql');
    expect(matchReference(
      routineRef(candidates),
      contextFor([app, duplicateApp, publicJobs, outer])
    )).toBeNull();
    expect(matchReference(routineRef([]), contextFor([outer]))).toBeNull();
    expect(matchReference(
      routineRef(['"$user".jobs', 'public.jobs']),
      contextFor([publicJobs])
    )).toBeNull();
  });
});
