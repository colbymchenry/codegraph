import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import {
  POSTGRES_TABLE_RELATION_DECORATOR,
  decodePostgresTableRelationDescriptor,
} from '../src/postgres/table-relation';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['postgres']);
});

function extract(source: string) {
  return extractFromSource('db/renames.sql', source, 'postgres');
}

describe('PostgreSQL rename regressions', () => {
  it('extracts view and materialized-view renames as relation aliases', () => {
    const result = extract([
      'CREATE VIEW app.old_view AS SELECT 1 AS id;',
      'CREATE MATERIALIZED VIEW app.old_mv AS SELECT 1 AS id;',
      'ALTER VIEW app.old_view RENAME TO active_view;',
      'ALTER MATERIALIZED VIEW app.old_mv RENAME TO active_mv;',
    ].join('\n'));

    expect(result.errors).toEqual([]);
    expect(result.nodes.find((node) => node.qualifiedName === 'app.active_view'))
      .toMatchObject({
        kind: 'struct',
        decorators: expect.arrayContaining(['postgres:view', 'postgres:renamed-relation']),
      });
    expect(result.nodes.find((node) => node.qualifiedName === 'app.active_mv'))
      .toMatchObject({
        kind: 'struct',
        decorators: expect.arrayContaining([
          'postgres:materialized-view',
          'postgres:renamed-relation',
        ]),
      });
    expect(result.nodes.filter((node) =>
      node.decorators?.includes('postgres:renamed-type')
    )).toEqual([]);

    const renames = result.nodes
      .filter((node) => node.decorators?.includes(POSTGRES_TABLE_RELATION_DECORATOR))
      .map((node) => decodePostgresTableRelationDescriptor(node.decorators));
    expect(renames).toEqual(expect.arrayContaining([
      {
        relation: 'rename',
        sourceTable: 'app.old_view',
        targetTable: 'app.active_view',
      },
      {
        relation: 'rename',
        sourceTable: 'app.old_mv',
        targetTable: 'app.active_mv',
      },
    ]));
  });

  it('models ALTER TYPE RENAME VALUE at the new label, separately from ADD VALUE', () => {
    const result = extract([
      "CREATE TYPE app.status AS ENUM ('old');",
      "ALTER TYPE app.status ADD VALUE 'added';",
      "ALTER TYPE app.status RENAME VALUE 'old' TO 'new';",
    ].join('\n'));

    expect(result.errors).toEqual([]);
    const added = result.nodes.find((node) =>
      node.qualifiedName === 'app.status.added' &&
      node.decorators?.includes('postgres:alter-enum-add-value')
    );
    const renamed = result.nodes.find((node) =>
      node.qualifiedName === 'app.status.new' &&
      node.decorators?.includes('postgres:renamed-enum-value')
    );
    expect(added).toBeTruthy();
    expect(renamed).toMatchObject({
      name: 'new',
      kind: 'enum_member',
      decorators: expect.arrayContaining([
        'postgres:enum-value',
        'postgres:renamed-enum-value',
      ]),
    });
    expect(renamed?.decorators).not.toContain('postgres:alter-enum-add-value');
    expect(result.nodes.filter((node) => node.qualifiedName === 'app.status.old'))
      .toHaveLength(1);
  });

  it('resolves renamed relation aliases and synthesizes their rename trails', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-postgres-renames-'));
    fs.writeFileSync(
      path.join(projectDir, '001_relations.sql'),
      [
        'CREATE VIEW app.old_view AS SELECT 1 AS id;',
        'CREATE MATERIALIZED VIEW app.old_mv AS SELECT 1 AS id;',
        "CREATE TYPE app.status AS ENUM ('old');",
      ].join('\n') + '\n'
    );
    fs.writeFileSync(
      path.join(projectDir, '002_renames.sql'),
      [
        'ALTER VIEW app.old_view RENAME TO active_view;',
        'ALTER MATERIALIZED VIEW app.old_mv RENAME TO active_mv;',
        "ALTER TYPE app.status RENAME VALUE 'old' TO 'new';",
      ].join('\n') + '\n'
    );
    fs.writeFileSync(
      path.join(projectDir, '003_consumers.sql'),
      [
        'CREATE VIEW app.view_consumer AS SELECT * FROM app.active_view;',
        'CREATE VIEW app.mv_consumer AS SELECT * FROM app.active_mv;',
      ].join('\n') + '\n'
    );

    const graph = CodeGraph.initSync(projectDir);
    try {
      await graph.indexAll();

      const oldView = graph.getNodesByQualifiedName('app.old_view')[0]!;
      const activeView = graph.getNodesByQualifiedName('app.active_view')[0]!;
      const oldMv = graph.getNodesByQualifiedName('app.old_mv')[0]!;
      const activeMv = graph.getNodesByQualifiedName('app.active_mv')[0]!;
      const viewConsumer = graph.getNodesByQualifiedName('app.view_consumer')[0]!;
      const mvConsumer = graph.getNodesByQualifiedName('app.mv_consumer')[0]!;

      expect(graph.getOutgoingEdges(oldView.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          target: activeView.id,
          metadata: expect.objectContaining({ postgresRelation: 'rename' }),
        }),
      ]));
      expect(graph.getOutgoingEdges(oldMv.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          target: activeMv.id,
          metadata: expect.objectContaining({ postgresRelation: 'rename' }),
        }),
      ]));
      expect(graph.getOutgoingEdges(viewConsumer.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ target: activeView.id, kind: 'references' }),
      ]));
      expect(graph.getOutgoingEdges(mvConsumer.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ target: activeMv.id, kind: 'references' }),
      ]));

      const status = graph.getNodesByQualifiedName('app.status')[0]!;
      const renamedValue = graph.getNodesByQualifiedName('app.status.new')[0]!;
      expect(renamedValue.decorators).toContain('postgres:renamed-enum-value');
      expect(graph.getOutgoingEdges(status.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ target: renamedValue.id, kind: 'contains' }),
      ]));
    } finally {
      graph.destroy();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
