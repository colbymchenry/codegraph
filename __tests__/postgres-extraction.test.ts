import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['postgres']);
});

function extract(source: string) {
  return extractFromSource('db/schema.sql', source, 'postgres');
}

describe('PostgreSQL extraction', () => {
  it('extracts database objects and columns with generic CodeGraph kinds', () => {
    const result = extract([
      'CREATE SCHEMA app;',
      "CREATE TYPE app.status AS ENUM ('active', 'disabled');",
      'CREATE TYPE app.coordinate AS (x integer, y integer);',
      "CREATE DOMAIN app.email AS text CHECK (VALUE <> '');",
      'CREATE TABLE app.users (id bigint PRIMARY KEY, email app.email);',
      'CREATE FOREIGN TABLE app.remote_events (id bigint) SERVER analytics;',
      'CREATE TABLE app.user_copy (id, email) AS SELECT id, email FROM app.users;',
      'CREATE VIEW app.active_users (id, email) AS SELECT id, email FROM app.users;',
      'CREATE MATERIALIZED VIEW app.user_rollup AS SELECT count(*) FROM app.users;',
      'CREATE FUNCTION app.touch_user(p_id bigint) RETURNS void LANGUAGE sql AS \'SELECT 1\';',
      'CREATE PROCEDURE app.refresh_users() LANGUAGE sql AS \'SELECT 1\';',
      'CREATE TRIGGER users_touch AFTER UPDATE ON app.users EXECUTE FUNCTION app.touch_user();',
      'CREATE POLICY users_read ON app.users USING (true);',
      'CREATE INDEX users_email_idx ON app.users(email);',
      'CREATE SEQUENCE app.event_id_seq;',
      'CREATE EXTENSION IF NOT EXISTS pgcrypto;',
    ].join('\n'));

    expect(result.errors).toEqual([]);

    const byQualifiedName = new Map(result.nodes.map((node) => [node.qualifiedName, node]));
    expect(byQualifiedName.get('app')?.kind).toBe('namespace');
    expect(byQualifiedName.get('app.status')?.kind).toBe('enum');
    expect(byQualifiedName.get('app.status.active')?.kind).toBe('enum_member');
    expect(byQualifiedName.get('app.coordinate')?.kind).toBe('type_alias');
    expect(byQualifiedName.get('app.email')?.decorators).toContain('postgres:domain');

    expect(byQualifiedName.get('app.users')?.kind).toBe('struct');
    expect(byQualifiedName.get('app.users.id')?.kind).toBe('field');
    expect(byQualifiedName.get('app.remote_events')?.decorators).toContain('postgres:foreign-table');
    expect(byQualifiedName.get('app.user_copy')?.decorators).toContain('postgres:table');
    expect(byQualifiedName.get('app.user_copy.email')?.kind).toBe('field');
    expect(byQualifiedName.get('app.active_users')?.decorators).toContain('postgres:view');
    expect(byQualifiedName.get('app.active_users.id')?.kind).toBe('field');
    expect(byQualifiedName.get('app.user_rollup')?.decorators).toContain('postgres:materialized-view');

    expect(byQualifiedName.get('app.touch_user')?.kind).toBe('function');
    expect(byQualifiedName.get('app.refresh_users')?.decorators).toContain('postgres:procedure');
    expect(byQualifiedName.get('app.users.users_touch')?.decorators).toContain('postgres:trigger');
    expect(byQualifiedName.get('app.users.users_read')?.decorators).toContain('postgres:policy');
    expect(byQualifiedName.get('app.users_email_idx')?.decorators).toContain('postgres:index');
    expect(byQualifiedName.get('app.event_id_seq')?.decorators).toContain('postgres:sequence');
    expect(byQualifiedName.get('pgcrypto')?.decorators).toContain('postgres:extension');
  });

  it('emits and de-duplicates relation and routine references while ignoring CTE aliases', () => {
    const result = extract([
      'CREATE VIEW app.dashboard AS',
      'WITH recent AS (',
      '  SELECT * FROM audit.events',
      ')',
      'SELECT *',
      'FROM recent',
      'JOIN app.users u ON true',
      'JOIN app.users u2 ON true',
      'WHERE app.can_view(u.id) AND app.can_view(u2.id);',
    ].join('\n'));

    const view = result.nodes.find((node) => node.qualifiedName === 'app.dashboard');
    expect(view).toBeTruthy();

    const refs = result.unresolvedReferences.filter((ref) => ref.fromNodeId === view!.id);
    expect(refs.map((ref) => `${ref.referenceKind}:${ref.referenceName}`).sort()).toEqual([
      'calls:app.can_view',
      'references:app.users',
      'references:audit.events',
    ]);
    expect(refs.some((ref) => ref.referenceName === 'recent')).toBe(false);
  });

  it('retains calls whose names collide with PostgreSQL built-ins', () => {
    const result = extract([
      'CREATE VIEW app.dashboard AS',
      'SELECT count(*), lower(app.display_name), app.custom_metric()',
      'FROM app.users;',
    ].join('\n'));

    const view = result.nodes.find((node) => node.qualifiedName === 'app.dashboard');
    expect(view).toBeTruthy();

    const calls = result.unresolvedReferences
      .filter((ref) => ref.fromNodeId === view!.id && ref.referenceKind === 'calls')
      .map((ref) => ref.referenceName)
      .sort();
    expect(calls).toEqual(['app.custom_metric', 'count', 'lower']);
  });

  it('does not leak a nested query CTE alias into the outer query scope', () => {
    const result = extract([
      'SELECT * FROM recent',
      'WHERE EXISTS (',
      '  WITH recent AS (SELECT * FROM audit.events)',
      '  SELECT * FROM recent',
      ');',
    ].join('\n'));

    const file = result.nodes.find((node) => node.kind === 'file')!;
    const refs = result.unresolvedReferences
      .filter((ref) => ref.fromNodeId === file.id && ref.referenceKind === 'references')
      .map((ref) => ref.referenceName)
      .sort();
    expect(refs).toEqual(['audit.events', 'recent']);
  });

  it('canonicalizes quoted and unquoted identifiers and captures ALTER TABLE foreign keys', () => {
    const result = extract([
      'CREATE TABLE "App"."Users" ("ID" bigint);',
      'CREATE TABLE PUBLIC.TEAMS (ID bigint);',
      'ALTER TABLE "App"."Users"',
      '  ADD CONSTRAINT users_team_fk FOREIGN KEY ("ID") REFERENCES PUBLIC.TEAMS(ID);',
      'SELECT * FROM "App"."Users";',
    ].join('\n'));

    expect(result.nodes.some((node) => node.qualifiedName === 'App.Users')).toBe(true);
    expect(result.nodes.some((node) => node.qualifiedName === 'App.Users.ID')).toBe(true);
    expect(result.nodes.some((node) => node.qualifiedName === 'public.teams')).toBe(true);

    const file = result.nodes.find((node) => node.kind === 'file')!;
    const fileRefs = result.unresolvedReferences
      .filter((ref) => ref.fromNodeId === file.id && ref.referenceKind === 'references')
      .map((ref) => ref.referenceName)
      .sort();
    expect(fileRefs).toEqual(['App.Users', 'public.teams']);
  });

  it('models ALTER TABLE ADD COLUMN as a relation-linked migration delta', () => {
    const result = extract([
      'CREATE TABLE app.users (id bigint);',
      'ALTER TABLE app.users',
      '  ADD COLUMN email text,',
      '  ADD COLUMN IF NOT EXISTS display_name text;',
    ].join('\n'));

    const fields = result.nodes
      .filter((node) => node.kind === 'field')
      .map((node) => node.qualifiedName)
      .sort();
    expect(fields).toEqual(['app.users.display_name', 'app.users.email', 'app.users.id']);

    const deltas = result.nodes.filter(
      (node) => node.decorators?.includes('postgres:alter-table-add-column')
    );
    expect(deltas.map((node) => node.qualifiedName).sort()).toEqual([
      'app.users.ADD COLUMN display_name',
      'app.users.ADD COLUMN email',
    ]);

    for (const delta of deltas) {
      expect(result.unresolvedReferences.some(
        (ref) => ref.fromNodeId === delta.id &&
          ref.referenceKind === 'references' &&
          ref.referenceName === 'app.users'
      )).toBe(true);
      expect(result.edges.some(
        (edge) => edge.source === delta.id &&
          edge.kind === 'contains' &&
          result.nodes.find((candidate) => candidate.id === edge.target)?.kind === 'field'
      )).toBe(true);
    }
  });

  it('keeps dollar-quoted PL/pgSQL bodies opaque in the PostgreSQL-only phase', () => {
    const result = extract([
      'CREATE FUNCTION app.run_job() RETURNS void',
      'LANGUAGE plpgsql AS $$',
      'BEGIN',
      '  PERFORM app.hidden_call();',
      '  INSERT INTO app.hidden_table VALUES (1);',
      'END',
      '$$;',
    ].join('\n'));

    expect(result.nodes.some((node) => node.qualifiedName === 'app.run_job')).toBe(true);
    expect(result.unresolvedReferences.some((ref) => ref.referenceName === 'app.hidden_call')).toBe(false);
    expect(result.unresolvedReferences.some((ref) => ref.referenceName === 'app.hidden_table')).toBe(false);
  });

  it('indexes and resolves PostgreSQL dependencies through the full CodeGraph pipeline', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-postgres-'));
    fs.writeFileSync(
      path.join(projectDir, '001_accounts.sql'),
      'CREATE TABLE app.accounts (id bigint PRIMARY KEY, active boolean);\n'
    );
    fs.writeFileSync(
      path.join(projectDir, '002_active_accounts.sql'),
      'CREATE VIEW app.active_accounts AS SELECT * FROM app.accounts WHERE active;\n'
    );

    const graph = CodeGraph.initSync(projectDir);
    try {
      await graph.indexAll();

      const table = graph.getNodesByName('accounts').find(
        (node) => node.qualifiedName === 'app.accounts'
      );
      const view = graph.getNodesByName('active_accounts').find(
        (node) => node.qualifiedName === 'app.active_accounts'
      );
      expect(table).toMatchObject({ kind: 'struct', language: 'postgres' });
      expect(view).toMatchObject({ kind: 'struct', language: 'postgres' });

      const incoming = graph.getIncomingEdges(table!.id);
      expect(incoming.some(
        (edge) => edge.source === view!.id && edge.kind === 'references'
      )).toBe(true);
    } finally {
      graph.destroy();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('resolves an unqualified user routine that shadows a PostgreSQL built-in name', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-postgres-shadow-'));
    fs.writeFileSync(
      path.join(projectDir, '001_count.sql'),
      "CREATE FUNCTION count(value integer) RETURNS integer LANGUAGE sql AS 'SELECT value';\n"
    );
    fs.writeFileSync(
      path.join(projectDir, '002_summary.sql'),
      'CREATE VIEW app.summary AS SELECT count(1);\n'
    );

    const graph = CodeGraph.initSync(projectDir);
    try {
      await graph.indexAll();

      const routine = graph.getNodesByName('count').find(
        (node) => node.language === 'postgres' && node.decorators?.includes('postgres:function')
      );
      const view = graph.getNodesByName('summary').find(
        (node) => node.qualifiedName === 'app.summary'
      );
      expect(routine).toBeTruthy();
      expect(view).toBeTruthy();

      const incoming = graph.getIncomingEdges(routine!.id);
      expect(incoming.some(
        (edge) => edge.source === view!.id && edge.kind === 'calls'
      )).toBe(true);
    } finally {
      graph.destroy();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
