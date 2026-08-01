import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import {
  POSTGRES_FOREIGN_KEY_DECORATOR,
  decodePostgresForeignKeyDescriptor,
} from '../src/postgres/foreign-key';
import {
  POSTGRES_TABLE_RELATION_DECORATOR,
  decodePostgresTableRelationDescriptor,
} from '../src/postgres/table-relation';

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

    const trigger = byQualifiedName.get('app.users.users_touch')!;
    expect(result.unresolvedReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fromNodeId: trigger.id,
        referenceKind: 'references',
        referenceName: 'app.users',
      }),
      expect.objectContaining({
        fromNodeId: trigger.id,
        referenceKind: 'calls',
        referenceName: 'app.touch_user',
      }),
    ]));
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

    expect(result.nodes.some((node) => node.qualifiedName === '"App"."Users"')).toBe(true);
    expect(result.nodes.some((node) => node.qualifiedName === '"App"."Users"."ID"')).toBe(true);
    expect(result.nodes.some((node) => node.qualifiedName === 'public.teams')).toBe(true);

    const file = result.nodes.find((node) => node.kind === 'file')!;
    const fileRefs = result.unresolvedReferences
      .filter((ref) => ref.fromNodeId === file.id && ref.referenceKind === 'references')
      .map((ref) => ref.referenceName)
      .sort();
    expect(fileRefs).toEqual(['"App"."Users"']);

    const foreignKey = result.nodes.find((node) =>
      node.decorators?.includes(POSTGRES_FOREIGN_KEY_DECORATOR)
    );
    expect(foreignKey).toBeTruthy();
    expect(foreignKey!.qualifiedName).toBe('"App"."Users".users_team_fk');
    expect(decodePostgresForeignKeyDescriptor(foreignKey!.decorators)).toEqual({
      sourceTable: '"App"."Users"',
      targetTable: 'public.teams',
      constraintName: 'users_team_fk',
      sourceColumns: ['ID'],
      targetColumns: ['id'],
    });
    expect(result.unresolvedReferences
      .filter((ref) => ref.fromNodeId === foreignKey!.id)
      .map((ref) => ref.referenceName)
      .sort()
    ).toEqual(['"App"."Users"', 'public.teams']);
  });

  it('preserves quoted identifier segment boundaries and escaped quotes', () => {
    const result = extract(
      'CREATE TABLE "public.app".users (id bigint); ' +
      'CREATE TABLE public."app.users" (id bigint); ' +
      'CREATE TABLE "a""b"."c.d" ("e.f" bigint);'
    );
    const tables = result.nodes
      .filter((node) => node.kind === 'struct')
      .map((node) => node.qualifiedName);
    expect(tables).toEqual(expect.arrayContaining([
      '"public.app".users',
      'public."app.users"',
      '"a""b"."c.d"',
    ]));
    expect(new Set(result.nodes.map((node) => node.id)).size).toBe(result.nodes.length);
    expect(result.nodes.some((node) => node.qualifiedName === '"public.app".users.id')).toBe(true);
    expect(result.nodes.some((node) => node.qualifiedName === 'public."app.users".id')).toBe(true);
    expect(result.nodes.some((node) => node.qualifiedName === '"a""b"."c.d"."e.f"')).toBe(true);
  });

  it('indexes authorization-only schemas, dynamic nested DDL, and temporary tables safely', () => {
    const result = extract([
      'CREATE SCHEMA AUTHORIZATION joe CREATE TABLE users (id bigint);',
      'CREATE SCHEMA AUTHORIZATION CURRENT_USER CREATE TABLE runtime_table (id bigint);',
      'CREATE TABLE public.sessions (id bigint);',
      'CREATE TEMP TABLE sessions (id bigint);',
      'ALTER TABLE sessions ADD COLUMN token text;',
      'CREATE TEMP TABLE session_copy AS SELECT * FROM sessions;',
      'CREATE TEMP VIEW active_sessions AS SELECT * FROM sessions;',
      'CREATE TEMPORARY SEQUENCE session_ids;',
      'CREATE VIEW pg_temp.explicit_temp_view AS SELECT 1;',
      'CREATE SEQUENCE pg_temp.explicit_temp_sequence;',
      'DROP TABLE sessions;',
      'ALTER TABLE sessions ADD COLUMN persistent_token text;',
      'CREATE UNLOGGED TABLE events (id bigint);',
    ].join('\n'));
    const byQualifiedName = new Map(result.nodes.map((node) => [node.qualifiedName, node]));
    expect(byQualifiedName.get('joe')?.decorators).toContain('postgres:schema');
    expect(byQualifiedName.get('joe.users')?.decorators).toContain('postgres:table');
    expect(byQualifiedName.get('joe.users.id')?.decorators).toContain('postgres:column');
    expect(byQualifiedName.get('runtime_table')?.decorators).toContain('postgres:table');
    expect(byQualifiedName.has('public.runtime_table')).toBe(false);
    expect(byQualifiedName.get('public.sessions')?.decorators).not.toContain('postgres:temporary');
    expect(byQualifiedName.get('pg_temp.sessions')?.decorators).toEqual(expect.arrayContaining([
      'postgres:table',
      'postgres:temporary',
    ]));
    expect(byQualifiedName.get('pg_temp.sessions.id')?.decorators).toContain('postgres:column');
    expect(byQualifiedName.get('pg_temp.sessions."ADD COLUMN token"')).toBeTruthy();
    expect(byQualifiedName.get('pg_temp.session_copy')?.decorators).toContain('postgres:temporary');
    expect(byQualifiedName.get('pg_temp.active_sessions')?.decorators).toEqual(
      expect.arrayContaining(['postgres:view', 'postgres:temporary'])
    );
    expect(byQualifiedName.get('pg_temp.session_ids')?.decorators).toEqual(
      expect.arrayContaining(['postgres:sequence', 'postgres:temporary'])
    );
    expect(byQualifiedName.get('pg_temp.explicit_temp_view')?.decorators).toEqual(
      expect.arrayContaining(['postgres:view', 'postgres:temporary'])
    );
    expect(byQualifiedName.get('pg_temp.explicit_temp_sequence')?.decorators).toEqual(
      expect.arrayContaining(['postgres:sequence', 'postgres:temporary'])
    );
    expect(byQualifiedName.get('public.sessions."ADD COLUMN persistent_token"')).toBeTruthy();
    expect(byQualifiedName.get('public.events')?.decorators).not.toContain('postgres:temporary');
  });

  it('links both tables and the routine named by a constraint trigger', () => {
    const result = extract([
      'CREATE TABLE app.orders (id bigint);',
      'CREATE TABLE app.users (id bigint);',
      'CREATE FUNCTION app.check_order() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;',
      'CREATE CONSTRAINT TRIGGER orders_check AFTER INSERT ON app.orders FROM app.users',
      '  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_order();',
    ].join('\n'));
    const trigger = result.nodes.find((node) => node.name === 'orders_check')!;
    expect(result.unresolvedReferences
      .filter((ref) => ref.fromNodeId === trigger.id)
      .map((ref) => `${ref.referenceKind}:${ref.referenceName}`)
      .sort()
    ).toEqual([
      'calls:app.check_order',
      'references:app.orders',
      'references:app.users',
    ]);
  });

  it('extracts partition, inheritance, LIKE, and ALTER relation facts', () => {
    const result = extract([
      'CREATE TABLE app.parent (id bigint);',
      'CREATE TABLE app.template (id bigint);',
      'CREATE TABLE app.child (LIKE app.template INCLUDING ALL) INHERITS (app.parent, audit.parent);',
      'CREATE TABLE app.partition_child PARTITION OF app.parent DEFAULT;',
      'ALTER TABLE app.parent ATTACH PARTITION app.attached DEFAULT;',
      'ALTER TABLE app.parent DETACH PARTITION app.detached CONCURRENTLY;',
      'ALTER TABLE app.child INHERIT audit.base;',
      'ALTER TABLE app.child NO INHERIT app.parent;',
    ].join('\n'));
    const facts = result.nodes.filter((node) =>
      node.decorators?.includes(POSTGRES_TABLE_RELATION_DECORATOR)
    );
    const descriptors = facts
      .map((node) => decodePostgresTableRelationDescriptor(node.decorators))
      .filter((descriptor) => descriptor !== null);
    expect(descriptors).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: 'like', sourceTable: 'app.child', targetTable: 'app.template' }),
      expect.objectContaining({ relation: 'inherits', sourceTable: 'app.child', targetTable: 'app.parent' }),
      expect.objectContaining({ relation: 'inherits', sourceTable: 'app.child', targetTable: 'audit.parent' }),
      expect.objectContaining({ relation: 'partition-of', sourceTable: 'app.partition_child', targetTable: 'app.parent' }),
      expect.objectContaining({ relation: 'attach-partition', sourceTable: 'app.attached', targetTable: 'app.parent' }),
      expect.objectContaining({ relation: 'detach-partition', sourceTable: 'app.detached', targetTable: 'app.parent', mode: 'concurrently' }),
      expect.objectContaining({ relation: 'inherit', sourceTable: 'app.child', targetTable: 'audit.base' }),
      expect.objectContaining({ relation: 'no-inherit', sourceTable: 'app.child', targetTable: 'app.parent' }),
    ]));
    expect(facts).toHaveLength(8);
    for (const fact of facts) {
      expect(result.unresolvedReferences.filter((ref) => ref.fromNodeId === fact.id)).toHaveLength(2);
    }
  });

  it('indexes inline, table-level, and ALTER TABLE foreign-key facts', () => {
    const result = extract([
      'CREATE TABLE app.parents (tenant_id bigint, id bigint, PRIMARY KEY (tenant_id, id));',
      'CREATE TABLE app.children (',
      '  tenant_id bigint,',
      '  parent_id bigint CONSTRAINT children_parent_inline REFERENCES app.parents(id) ON DELETE SET NULL,',
      '  backup_parent_id bigint REFERENCES app.parents(id),',
      '  CONSTRAINT children_parent_fk FOREIGN KEY (tenant_id, parent_id)',
      '    REFERENCES app.parents(tenant_id, id) MATCH FULL ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED',
      ');',
      'ALTER TABLE ONLY app.children',
      '  ADD CONSTRAINT children_backup_fk FOREIGN KEY (tenant_id, backup_parent_id)',
      '  REFERENCES app.parents(tenant_id, id) ON DELETE CASCADE NOT VALID;',
    ].join('\n'));

    expect(result.errors).toEqual([]);
    const facts = result.nodes
      .filter((node) => node.decorators?.includes(POSTGRES_FOREIGN_KEY_DECORATOR))
      .map((node) => ({
        node,
        data: decodePostgresForeignKeyDescriptor(node.decorators),
      }));
    expect(facts).toHaveLength(4);

    const composite = facts.find(({ node }) => node.name === 'children_parent_fk')!;
    expect(composite.data).toEqual({
      sourceTable: 'app.children',
      targetTable: 'app.parents',
      constraintName: 'children_parent_fk',
      sourceColumns: ['tenant_id', 'parent_id'],
      targetColumns: ['tenant_id', 'id'],
      match: 'full',
      onUpdate: 'cascade',
      deferrable: true,
      initially: 'deferred',
    });

    const alter = facts.find(({ node }) => node.name === 'children_backup_fk')!;
    expect(alter.data).toEqual({
      sourceTable: 'app.children',
      targetTable: 'app.parents',
      constraintName: 'children_backup_fk',
      sourceColumns: ['tenant_id', 'backup_parent_id'],
      targetColumns: ['tenant_id', 'id'],
      onDelete: 'cascade',
      notValid: true,
    });
    for (const { node } of facts) {
      expect(result.unresolvedReferences
        .filter((ref) => ref.fromNodeId === node.id)
        .map((ref) => ref.referenceName)
        .sort()
      ).toEqual(['app.children', 'app.parents']);
    }
  });

  it('keeps same-line anonymous and same-named foreign keys as distinct facts', () => {
    const result = extract([
      'CREATE TABLE app.child (a bigint REFERENCES app.parent_a(id), b bigint REFERENCES app.parent_b(id));',
      'ALTER TABLE app.one ADD CONSTRAINT user_fk FOREIGN KEY (user_id) REFERENCES app.users(id); ALTER TABLE app.two ADD CONSTRAINT user_fk FOREIGN KEY (owner_id) REFERENCES app.users(id);',
    ].join('\n'));

    expect(result.errors).toEqual([]);
    const facts = result.nodes
      .filter((node) => node.decorators?.includes(POSTGRES_FOREIGN_KEY_DECORATOR))
      .map((node) => ({
        id: node.id,
        name: node.name,
        data: decodePostgresForeignKeyDescriptor(node.decorators),
      }));
    expect(facts).toHaveLength(4);
    expect(new Set(facts.map((fact) => fact.id)).size).toBe(4);
    expect(facts.map((fact) => fact.data?.targetTable)).toEqual(expect.arrayContaining([
      'app.parent_a',
      'app.parent_b',
      'app.users',
      'app.users',
    ]));
    expect(facts.filter((fact) => fact.name === 'user_fk').map((fact) => fact.data?.sourceTable))
      .toEqual(expect.arrayContaining(['app.one', 'app.two']));
  });

  it('qualifies unqualified declarations from an explicit single-schema search_path', () => {
    const result = extract([
      'CREATE FUNCTION default_path_fn() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;',
      'SET search_path = history;',
      'CREATE TABLE users (id bigint PRIMARY KEY);',
      'SET search_path = public;',
      'CREATE TABLE users (id bigint PRIMARY KEY);',
      'SET search_path = app;',
      'CREATE FUNCTION touch_user() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;',
    ].join('\n'));

    expect(result.errors).toEqual([]);
    expect(result.nodes.map((node) => node.qualifiedName)).toEqual(expect.arrayContaining([
      'history.users',
      'public.users',
      'app.touch_user',
      'public.default_path_fn',
    ]));
  });

  it('keeps same-line search_path declarations and their columns distinct', () => {
    const result = extract(
      'SET search_path=a; CREATE TABLE users(id int); ' +
      'SET search_path=b; CREATE TABLE users(id int);'
    );
    const tables = result.nodes.filter((node) => node.decorators?.includes('postgres:table'));
    const columns = result.nodes.filter((node) => node.decorators?.includes('postgres:column'));

    expect(tables.map((node) => node.qualifiedName)).toEqual(['a.users', 'b.users']);
    expect(new Set(tables.map((node) => node.id)).size).toBe(2);
    expect(columns.map((node) => node.qualifiedName)).toEqual(['a.users.id', 'b.users.id']);
    expect(new Set(columns.map((node) => node.id)).size).toBe(2);
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
      'app.users."ADD COLUMN display_name"',
      'app.users."ADD COLUMN email"',
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

  it('links cross-migration foreign keys and triggers and removes stale FK edges on sync', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-postgres-relations-'));
    const relationsPath = path.join(projectDir, '004_relations.sql');
    fs.writeFileSync(
      path.join(projectDir, '001_users.sql'),
      'CREATE TABLE app.users (id bigint PRIMARY KEY);\n'
    );
    fs.writeFileSync(
      path.join(projectDir, '002_orders.sql'),
      'CREATE TABLE app.orders (id bigint PRIMARY KEY, user_id bigint);\n'
    );
    fs.writeFileSync(
      path.join(projectDir, '003_touch.sql'),
      "CREATE FUNCTION app.touch_user() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END';\n"
    );
    const triggerSql =
      'CREATE TRIGGER users_touch AFTER UPDATE ON app.users EXECUTE FUNCTION app.touch_user();\n';
    const foreignKeySql = [
      'ALTER TABLE app.orders ADD CONSTRAINT orders_user_fk',
      '  FOREIGN KEY (user_id) REFERENCES app.users(id) ON DELETE CASCADE;',
    ].join('\n') + '\n';
    fs.writeFileSync(relationsPath, foreignKeySql + triggerSql);

    const graph = CodeGraph.initSync(projectDir);
    try {
      await graph.indexAll();
      const users = graph.getNodesByName('users').find((node) => node.qualifiedName === 'app.users')!;
      const orders = graph.getNodesByName('orders').find((node) => node.qualifiedName === 'app.orders')!;
      const routine = graph.getNodesByName('touch_user').find(
        (node) => node.decorators?.includes('postgres:function')
      )!;
      const trigger = graph.getNodesByName('users_touch').find(
        (node) => node.decorators?.includes('postgres:trigger')
      )!;

      const fkEdge = graph.getOutgoingEdges(orders.id).find((edge) =>
        edge.target === users.id && edge.metadata?.postgresRelation === 'foreign-key'
      );
      expect(fkEdge).toBeTruthy();
      expect(fkEdge!.provenance).toBe('tree-sitter');
      expect(fkEdge!.metadata?.constraints).toEqual([
        expect.objectContaining({
          constraintName: 'orders_user_fk',
          sourceColumns: ['user_id'],
          targetColumns: ['id'],
          onDelete: 'cascade',
          filePath: '004_relations.sql',
        }),
      ]);

      expect(graph.getIncomingEdges(users.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: orders.id, kind: 'references' }),
        expect.objectContaining({ source: trigger.id, kind: 'references' }),
      ]));
      expect(graph.getOutgoingEdges(trigger.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ target: users.id, kind: 'references' }),
        expect.objectContaining({ target: routine.id, kind: 'calls' }),
      ]));

      graph.clear();
      await graph.indexAll();
      expect(graph.getOutgoingEdges(orders.id).some((edge) =>
        edge.target === users.id && edge.metadata?.postgresRelation === 'foreign-key'
      )).toBe(true);

      // Simulate a process dying after the store phase of a pure removal but
      // before FK synthesis. The source/target tables survive, so the direct
      // edge is intentionally stale while the persisted fact fingerprint is
      // old; the next no-change sync must detect and recover it.
      fs.unlinkSync(relationsPath);
      await (graph as any).orchestrator.sync();
      expect(graph.getOutgoingEdges(orders.id).some((edge) =>
        edge.target === users.id && edge.metadata?.postgresRelation === 'foreign-key'
      )).toBe(true);

      await graph.sync();
      expect(graph.getOutgoingEdges(orders.id).some((edge) =>
        edge.target === users.id && edge.metadata?.postgresRelation === 'foreign-key'
      )).toBe(false);
    } finally {
      graph.destroy();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('removes an FK projection when a target table becomes a view', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-postgres-fk-target-'));
    const usersPath = path.join(projectDir, '001_users.sql');
    fs.writeFileSync(usersPath, 'CREATE TABLE app.users (id bigint PRIMARY KEY);\n');
    fs.writeFileSync(
      path.join(projectDir, '002_orders.sql'),
      'CREATE TABLE app.orders (id bigint, user_id bigint REFERENCES app.users(id));\n'
    );

    const graph = CodeGraph.initSync(projectDir);
    try {
      await graph.indexAll();
      const users = graph.getNodesByQualifiedName('app.users')[0]!;
      const orders = graph.getNodesByQualifiedName('app.orders')[0]!;
      expect(graph.getOutgoingEdges(orders.id).some((edge) =>
        edge.target === users.id && edge.metadata?.postgresRelation === 'foreign-key'
      )).toBe(true);

      fs.writeFileSync(usersPath, 'CREATE VIEW app.users AS SELECT 1::bigint AS id;\n');
      await graph.sync();
      const view = graph.getNodesByQualifiedName('app.users')[0]!;
      expect(view.decorators).toContain('postgres:view');
      expect(graph.getOutgoingEdges(orders.id).some((edge) =>
        edge.target === view.id && edge.metadata?.postgresRelation === 'foreign-key'
      )).toBe(false);
    } finally {
      graph.destroy();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('does not replace FK edges for an unrelated TypeScript-only sync', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-postgres-fk-noop-'));
    fs.writeFileSync(
      path.join(projectDir, 'schema.sql'),
      [
        'CREATE TABLE app.users (id bigint PRIMARY KEY);',
        'CREATE TABLE app.orders (user_id bigint REFERENCES app.users(id));',
      ].join('\n')
    );
    const tsPath = path.join(projectDir, 'app.ts');
    fs.writeFileSync(tsPath, 'export const value = 1;\n');

    const graph = CodeGraph.initSync(projectDir);
    try {
      await graph.indexAll();
      const queries = (graph as any).queries;
      const plan = (graph as any).db.getDb().prepare(`
        EXPLAIN QUERY PLAN
        SELECT source FROM edges
        WHERE json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.synthesizedBy') = ?
          AND json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.synthesizedBy') IS NOT NULL
      `).all('postgres-foreign-key') as Array<{ detail: string }>;
      expect(plan.map((row) => row.detail).join(' ')).toContain('idx_edges_synthesized_by');
      const originalReplace = queries.replaceEdgesBySynthesizer.bind(queries);
      let replacements = 0;
      queries.replaceEdgesBySynthesizer = (...args: unknown[]) => {
        replacements++;
        return originalReplace(...args);
      };

      fs.writeFileSync(tsPath, 'export const value = 2;\n');
      await graph.sync();
      expect(replacements).toBe(0);
    } finally {
      graph.destroy();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('synthesizes cross-schema FK roles through the synchronous resolution API', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-postgres-sync-resolve-'));
    fs.writeFileSync(
      path.join(projectDir, '001_public.sql'),
      'CREATE TABLE public.users (id bigint PRIMARY KEY);\n'
    );
    fs.writeFileSync(
      path.join(projectDir, '002_audit.sql'),
      'CREATE TABLE audit.users (id bigint PRIMARY KEY, parent_id bigint);\n'
    );
    fs.writeFileSync(
      path.join(projectDir, '003_fk.sql'),
      [
        'SET search_path = public;',
        'ALTER TABLE audit.users ADD CONSTRAINT audit_users_parent_fk',
        '  FOREIGN KEY (parent_id) REFERENCES users(id);',
        '',
      ].join('\n')
    );

    const graph = CodeGraph.initSync(projectDir);
    try {
      await graph.indexFiles(['001_public.sql', '002_audit.sql', '003_fk.sql']);
      graph.resolveReferences();

      const publicUsers = graph.getNodesByQualifiedName('public.users')[0]!;
      const auditUsers = graph.getNodesByQualifiedName('audit.users')[0]!;
      expect(publicUsers).toBeTruthy();
      expect(auditUsers).toBeTruthy();
      expect(graph.getOutgoingEdges(auditUsers.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          target: publicUsers.id,
          kind: 'references',
          metadata: expect.objectContaining({ postgresRelation: 'foreign-key' }),
        }),
      ]));
    } finally {
      graph.destroy();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('links search_path-qualified declarations and references end to end', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-postgres-search-path-'));
    fs.writeFileSync(
      path.join(projectDir, 'schema.sql'),
      [
        'SET search_path = app;',
        'CREATE TABLE users (id bigint PRIMARY KEY);',
        'CREATE TABLE orders (id bigint, user_id bigint REFERENCES users(id));',
        'CREATE FUNCTION touch_user() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;',
        'CREATE TRIGGER users_touch AFTER UPDATE ON users EXECUTE FUNCTION touch_user();',
      ].join('\n')
    );

    const graph = CodeGraph.initSync(projectDir);
    try {
      await graph.indexAll();
      const users = graph.getNodesByQualifiedName('app.users')[0]!;
      const orders = graph.getNodesByQualifiedName('app.orders')[0]!;
      const routine = graph.getNodesByQualifiedName('app.touch_user')[0]!;
      expect(users).toBeTruthy();
      expect(orders).toBeTruthy();
      expect(routine).toBeTruthy();
      expect(graph.getOutgoingEdges(orders.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          target: users.id,
          metadata: expect.objectContaining({ postgresRelation: 'foreign-key' }),
        }),
      ]));
      const trigger = graph.getNodesByName('users_touch')[0]!;
      expect(trigger.qualifiedName).toBe('app.users.users_touch');
      expect(graph.getOutgoingEdges(trigger.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ target: users.id, kind: 'references' }),
        expect.objectContaining({ target: routine.id, kind: 'calls' }),
      ]));
    } finally {
      graph.destroy();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('keeps references distinct when a temporary relation changes the binding', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-postgres-temp-order-'));
    fs.writeFileSync(path.join(projectDir, 'schema.sql'), [
      'CREATE TABLE public.sessions (id bigint);',
      'SELECT * FROM sessions;',
      'CREATE TEMP TABLE sessions (id bigint);',
      'SELECT * FROM sessions;',
      'DROP TABLE sessions;',
      'SELECT * FROM sessions;',
    ].join('\n'));

    const graph = CodeGraph.initSync(projectDir);
    try {
      await graph.indexAll();
      const persistent = graph.getNodesByQualifiedName('public.sessions')[0]!;
      const temporary = graph.getNodesByQualifiedName('pg_temp.sessions')[0]!;
      const file = graph.getNodesByName('schema.sql').find((node) => node.kind === 'file')!;
      expect(persistent).toBeTruthy();
      expect(temporary.decorators).toContain('postgres:temporary');

      const targets = graph.getOutgoingEdges(file.id)
        .filter((edge) => edge.kind === 'references')
        .map((edge) => edge.target);
      expect(targets).toEqual(expect.arrayContaining([persistent.id, temporary.id]));
    } finally {
      graph.destroy();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('projects structural table relations and cross-file schema containment end to end', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-postgres-structure-'));
    fs.writeFileSync(path.join(projectDir, '001_base.sql'), [
      'CREATE SCHEMA app;',
      'CREATE SCHEMA nested CREATE TABLE things (id bigint);',
      'CREATE TABLE app.parent (id bigint);',
      'CREATE TABLE app.template (id bigint);',
      'CREATE FUNCTION app.check_parent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;',
    ].join('\n'));
    const childPath = path.join(projectDir, '002_children.sql');
    fs.writeFileSync(childPath, [
      'CREATE TABLE app.child (LIKE app.template INCLUDING ALL) INHERITS (app.parent);',
      'CREATE TABLE app.partition_child PARTITION OF app.parent DEFAULT;',
      'CREATE TABLE app.attached (id bigint);',
      'CREATE TABLE app.detached (id bigint);',
    ].join('\n'));
    fs.writeFileSync(path.join(projectDir, '003_operations.sql'), [
      'ALTER TABLE app.parent ATTACH PARTITION app.attached DEFAULT;',
      'ALTER TABLE app.parent DETACH PARTITION app.detached;',
      'CREATE CONSTRAINT TRIGGER child_parent_check AFTER UPDATE ON app.child FROM app.parent',
      '  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_parent();',
    ].join('\n'));

    const graph = CodeGraph.initSync(projectDir);
    try {
      await graph.indexAll();
      const schema = graph.getNodesByQualifiedName('app')[0]!;
      const nestedSchema = graph.getNodesByQualifiedName('nested')[0]!;
      const nestedTable = graph.getNodesByQualifiedName('nested.things')[0]!;
      const parent = graph.getNodesByQualifiedName('app.parent')[0]!;
      const template = graph.getNodesByQualifiedName('app.template')[0]!;
      const child = graph.getNodesByQualifiedName('app.child')[0]!;
      const partition = graph.getNodesByQualifiedName('app.partition_child')[0]!;
      const attached = graph.getNodesByQualifiedName('app.attached')[0]!;
      const detached = graph.getNodesByQualifiedName('app.detached')[0]!;

      const expectRelation = (sourceId: string, targetId: string, relation: string) => {
        expect(graph.getOutgoingEdges(sourceId)).toEqual(expect.arrayContaining([
          expect.objectContaining({
            target: targetId,
            kind: 'references',
            metadata: expect.objectContaining({ postgresRelation: relation }),
          }),
        ]));
      };
      expectRelation(child.id, parent.id, 'inherits');
      expectRelation(child.id, template.id, 'like');
      expectRelation(child.id, parent.id, 'constraint-trigger');
      expectRelation(partition.id, parent.id, 'partition-of');
      expectRelation(attached.id, parent.id, 'attach-partition');
      expectRelation(detached.id, parent.id, 'detach-partition');

      const contained = graph.getOutgoingEdges(schema.id, ['contains']).map((edge) => edge.target);
      expect(contained).toEqual(expect.arrayContaining([parent.id, template.id, child.id]));
      expect(graph.getOutgoingEdges(nestedSchema.id, ['contains']).filter(
        (edge) => edge.target === nestedTable.id
      )).toHaveLength(1);

      fs.writeFileSync(childPath, [
        'CREATE TABLE app.child (LIKE app.template INCLUDING ALL);',
        'CREATE TABLE app.partition_child PARTITION OF app.parent DEFAULT;',
        'CREATE TABLE app.attached (id bigint);',
        'CREATE TABLE app.detached (id bigint);',
      ].join('\n'));
      await graph.sync();
      const refreshedChild = graph.getNodesByQualifiedName('app.child')[0]!;
      expect(graph.getOutgoingEdges(refreshedChild.id).some(
        (edge) => edge.metadata?.postgresRelation === 'inherits'
      )).toBe(false);
      expect(graph.getOutgoingEdges(refreshedChild.id).some(
        (edge) => edge.metadata?.postgresRelation === 'like'
      )).toBe(true);
    } finally {
      graph.destroy();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
