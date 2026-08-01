import type { Node as SyntaxNode } from 'web-tree-sitter';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  getParser,
  getPostgresPlpgsqlParser,
  initGrammars,
  loadGrammarsForLanguages,
} from '../src/extraction/grammars';
import {
  discoverPostgresRoutineBodyReferences,
  type PostgresRoutineBodyReference,
} from '../src/postgres/routine-body';

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

function expectedPosition(source: string, startIndex: number) {
  const before = source.slice(0, startIndex);
  const lineStart = before.lastIndexOf('\n') + 1;
  return {
    startIndex,
    line: before.split('\n').length,
    column: startIndex - lineStart,
  };
}

function findFact(
  facts: PostgresRoutineBodyReference[],
  kind: PostgresRoutineBodyReference['kind'],
  qualifiedName: string
) {
  return facts.find((fact) => fact.kind === kind && fact.qualifiedName === qualifiedName);
}

describe('PostgreSQL routine body reference discovery', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['postgres']);
  });

  function analyze(source: string, statementType: 'CreateFunctionStmt' | 'DoStmt') {
    const postgres = getParser('postgres')!;
    const outerTree = postgres.parse(source);
    const statement = firstDescendant(outerTree.rootNode, statementType);
    expect(statement).not.toBeNull();
    const result = discoverPostgresRoutineBodyReferences(statement!, source, {
      postgres,
      plpgsql: getPostgresPlpgsqlParser(),
    });
    outerTree.delete();
    return result;
  }

  it('indexes SQL-language bodies with CTE suppression, de-duplication, and outer offsets', () => {
    const source = [
      '-- leading line keeps nested coordinates honest',
      'CREATE FUNCTION app.find_users() RETURNS SETOF uuid',
      'LANGUAGE sql',
      'AS $body$',
      'WITH selected AS (',
      '  SELECT id FROM "App"."Users"',
      ')',
      "SELECT public.touch_user(id), nextval('public.job_seq'::regclass)",
      'FROM selected',
      'JOIN public.accounts ON true',
      'JOIN "App"."Users" again ON true;',
      '$body$;',
    ].join('\n');

    const result = analyze(source, 'CreateFunctionStmt');
    expect(result.status).toBe('analyzed');
    expect(result.language).toBe('sql');
    expect(result.facts.map((fact) => [fact.kind, fact.qualifiedName])).toEqual([
      ['references', '"App"."Users"'],
      ['calls', 'public.touch_user'],
      ['calls', 'nextval'],
      ['sequence', 'public.job_seq'],
      ['references', 'public.accounts'],
    ]);
    expect(result.facts.some((fact) => fact.qualifiedName === 'selected')).toBe(false);

    const usersIndex = source.indexOf('"App"."Users"');
    expect(findFact(result.facts, 'references', '"App"."Users"')).toMatchObject(
      expectedPosition(source, usersIndex)
    );
  });

  it('uses PL/pgSQL regions, safely recovers INTO, and skips dynamic SQL and record fields', () => {
    const source = [
      'CREATE FUNCTION public.touch_submission() RETURNS trigger',
      'AS $fn$',
      'DECLARE selected_id uuid;',
      'BEGIN',
      '  WITH chosen AS (SELECT id FROM public.users)',
      '  SELECT id INTO selected_id FROM chosen;',
      '  UPDATE public.accounts SET active = true',
      '    WHERE user_id = selected_id RETURNING id INTO selected_id;',
      '  PERFORM public.touch_user(selected_id);',
      "  EXECUTE format('DELETE FROM public.secret_table WHERE id = %L', selected_id);",
      '  NEW.updated_at := now();',
      '  RETURN NEW;',
      'END;',
      '$fn$',
      'LANGUAGE plpgsql;',
    ].join('\n');

    const result = analyze(source, 'CreateFunctionStmt');
    expect(result.status).toBe('analyzed');
    expect(result.language).toBe('plpgsql');
    expect(result.recoveredFragments).toBeGreaterThan(0);
    expect(result.skippedDynamicFragments).toBeGreaterThan(0);
    expect(result.facts.map((fact) => [fact.kind, fact.qualifiedName])).toEqual([
      ['references', 'public.users'],
      ['references', 'public.accounts'],
      ['calls', 'public.touch_user'],
      ['calls', 'now'],
    ]);
    expect(result.facts.some((fact) => fact.qualifiedName === 'chosen')).toBe(false);
    expect(result.facts.some((fact) => fact.qualifiedName.includes('secret_table'))).toBe(false);
    expect(result.facts.some((fact) => fact.qualifiedName.startsWith('new.'))).toBe(false);

    const accountsIndex = source.indexOf('public.accounts');
    expect(findFact(result.facts, 'references', 'public.accounts')).toMatchObject(
      expectedPosition(source, accountsIndex)
    );
    const touchIndex = source.indexOf('public.touch_user');
    expect(findFact(result.facts, 'calls', 'public.touch_user')).toMatchObject(
      expectedPosition(source, touchIndex)
    );
  });

  it('treats DO as PL/pgSQL by default and maps tagged body coordinates', () => {
    const source = [
      'DO $migration$',
      'BEGIN',
      '  INSERT INTO audit.events(id) VALUES (gen_random_uuid());',
      'END;',
      '$migration$;',
    ].join('\n');

    const result = analyze(source, 'DoStmt');
    expect(result.status).toBe('analyzed');
    expect(result.language).toBe('plpgsql');
    expect(result.facts.map((fact) => [fact.kind, fact.qualifiedName])).toEqual([
      ['references', 'audit.events'],
      ['calls', 'gen_random_uuid'],
    ]);
    const eventsIndex = source.indexOf('audit.events');
    expect(findFact(result.facts, 'references', 'audit.events')).toMatchObject(
      expectedPosition(source, eventsIndex)
    );
  });

  it('rejects an invalid SQL body instead of trusting error recovery', () => {
    const source = [
      'CREATE FUNCTION public.broken() RETURNS void',
      'LANGUAGE sql AS $$',
      'SELECT (((;',
      '$$;',
    ].join('\n');

    const result = analyze(source, 'CreateFunctionStmt');
    expect(result.status).toBe('parse-error');
    expect(result.facts).toEqual([]);
  });

  it('accepts only literal sequence arguments through parentheses and casts', () => {
    const source = [
      'CREATE FUNCTION public.sequence_values(tenant text) RETURNS bigint',
      'LANGUAGE sql AS $$',
      "SELECT nextval((('public.literal_seq'))::regclass),",
      "  setval(CAST('public.cast_seq' AS regclass), 1),",
      "  nextval(('public.foo_' || tenant)::regclass),",
      "  nextval(format('public.%s_seq', tenant)::regclass);",
      '$$;',
    ].join('\n');

    const result = analyze(source, 'CreateFunctionStmt');
    expect(result.status).toBe('analyzed');
    expect(result.facts
      .filter((fact) => fact.kind === 'sequence')
      .map((fact) => fact.qualifiedName)
      .sort()
    ).toEqual(['public.cast_seq', 'public.literal_seq']);
  });
});
