import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { POSTGRES_DROP_RELATION_DECORATOR } from '../src/postgres/relation-lifecycle';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['postgres']);
});

function withMigrationProject(files: Record<string, string>): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pg-lifecycle-'));
  for (const [file, source] of Object.entries(files)) {
    fs.writeFileSync(path.join(projectDir, file), `${source.trim()}\n`);
  }
  return projectDir;
}

describe('PostgreSQL relation lifecycle resolution', () => {
  it('attaches a later-file FK to the table declaration after DROP and re-CREATE', async () => {
    const projectDir = withMigrationProject({
      '001_users.sql': 'CREATE TABLE public.users (id bigint PRIMARY KEY);',
      '002_orders.sql': [
        'CREATE TABLE public.orders (',
        '  id bigint PRIMARY KEY,',
        '  user_id bigint',
        ');',
      ].join('\n'),
      '003_drop_orders.sql': 'DROP TABLE public.orders;',
      '004_recreate_orders.sql': [
        'CREATE TABLE public.orders (',
        '  id bigint PRIMARY KEY,',
        '  user_id bigint',
        ');',
      ].join('\n'),
      '005_orders_fk.sql': [
        'ALTER TABLE public.orders',
        '  ADD CONSTRAINT orders_user_fk',
        '  FOREIGN KEY (user_id) REFERENCES public.users(id);',
      ].join('\n'),
    });
    const graph = CodeGraph.initSync(projectDir);
    try {
      await graph.indexAll();

      const users = graph.getNodesByQualifiedName('public.users')[0]!;
      const orders = graph.getNodesByQualifiedName('public.orders');
      const oldOrders = orders.find((node) => node.filePath === '002_orders.sql')!;
      const recreatedOrders = orders.find((node) => node.filePath === '004_recreate_orders.sql')!;
      expect(users).toBeTruthy();
      expect(oldOrders).toBeTruthy();
      expect(recreatedOrders).toBeTruthy();
      expect(graph.getOutgoingEdges(oldOrders.id)).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          target: users.id,
          metadata: expect.objectContaining({ postgresRelation: 'foreign-key' }),
        }),
      ]));
      expect(graph.getOutgoingEdges(recreatedOrders.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          target: users.id,
          kind: 'references',
          metadata: expect.objectContaining({ postgresRelation: 'foreign-key' }),
        }),
      ]));
    } finally {
      graph.destroy();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('resolves each DROP VIEW to the latest preceding historical definition', async () => {
    const projectDir = withMigrationProject({
      '001_create_view.sql': 'CREATE VIEW app.summary AS SELECT 1 AS value;',
      '002_drop_view.sql': 'DROP VIEW app.summary;',
      '003_recreate_view.sql': 'CREATE VIEW app.summary AS SELECT 2 AS value;',
      '004_drop_view.sql': 'DROP VIEW app.summary;',
    });
    const graph = CodeGraph.initSync(projectDir);
    try {
      await graph.indexAll();

      const views = graph.getNodesByQualifiedName('app.summary');
      const original = views.find((node) => node.filePath === '001_create_view.sql')!;
      const recreated = views.find((node) => node.filePath === '003_recreate_view.sql')!;
      const drops = graph.getNodesByName('DROP VIEW app.summary')
        .filter((node) => node.decorators?.includes(POSTGRES_DROP_RELATION_DECORATOR));
      const firstDrop = drops.find((node) => node.filePath === '002_drop_view.sql')!;
      const secondDrop = drops.find((node) => node.filePath === '004_drop_view.sql')!;
      expect(graph.getOutgoingEdges(firstDrop.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ target: original.id, kind: 'references' }),
      ]));
      expect(graph.getOutgoingEdges(secondDrop.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ target: recreated.id, kind: 'references' }),
      ]));
    } finally {
      graph.destroy();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('does not resolve a DROP to a later declaration in the same file', async () => {
    const projectDir = withMigrationProject({
      '001_create_orders.sql': 'CREATE TABLE public.orders (id bigint);',
      '002_replace_orders.sql': [
        'DROP TABLE public.orders;',
        'CREATE TABLE public.orders (id bigint);',
      ].join('\n'),
    });
    const graph = CodeGraph.initSync(projectDir);
    try {
      await graph.indexAll();

      const orders = graph.getNodesByQualifiedName('public.orders');
      const original = orders.find((node) => node.filePath === '001_create_orders.sql')!;
      const recreated = orders.find((node) => node.filePath === '002_replace_orders.sql')!;
      const drop = graph.getNodesByName('DROP TABLE public.orders')
        .find((node) => node.decorators?.includes(POSTGRES_DROP_RELATION_DECORATOR))!;
      const targets = graph.getOutgoingEdges(drop.id)
        .filter((edge) => edge.kind === 'references')
        .map((edge) => edge.target);

      expect(original).toBeTruthy();
      expect(recreated).toBeTruthy();
      expect(drop).toBeTruthy();
      expect(targets).toContain(original.id);
      expect(targets).not.toContain(recreated.id);
    } finally {
      graph.destroy();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('renames the recreated relation after a DROP boundary', async () => {
    const projectDir = withMigrationProject({
      '001_create_orders.sql': 'CREATE TABLE public.orders (id bigint);',
      '002_drop_orders.sql': 'DROP TABLE public.orders;',
      '003_recreate_orders.sql': 'CREATE TABLE public.orders (id bigint);',
      '004_rename_orders.sql': 'ALTER TABLE public.orders RENAME TO purchases;',
    });
    const graph = CodeGraph.initSync(projectDir);
    try {
      await graph.indexAll();

      const orders = graph.getNodesByQualifiedName('public.orders');
      const original = orders.find((node) => node.filePath === '001_create_orders.sql')!;
      const recreated = orders.find((node) => node.filePath === '003_recreate_orders.sql')!;
      const purchases = graph.getNodesByQualifiedName('public.purchases')[0]!;
      const isRenameToPurchases = (edge: ReturnType<typeof graph.getOutgoingEdges>[number]) =>
        edge.target === purchases.id && edge.metadata?.postgresRelation === 'rename';

      expect(original).toBeTruthy();
      expect(recreated).toBeTruthy();
      expect(purchases).toBeTruthy();
      expect(graph.getOutgoingEdges(recreated.id).some(isRenameToPurchases)).toBe(true);
      expect(graph.getOutgoingEdges(original.id).some(isRenameToPurchases)).toBe(false);
    } finally {
      graph.destroy();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
