import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import {
  POSTGRES_DROP_CONSTRAINT_DECORATOR,
  POSTGRES_RENAME_CONSTRAINT_DECORATOR,
  encodePostgresDropConstraintDescriptor,
  encodePostgresRenameConstraintDescriptor,
} from '../src/postgres/constraint-mutation';
import {
  POSTGRES_FOREIGN_KEY_DECORATOR,
  encodePostgresForeignKeyDescriptor,
} from '../src/postgres/foreign-key';
import {
  POSTGRES_DROP_RELATION_DECORATOR,
  encodePostgresDropRelationDescriptor,
} from '../src/postgres/relation-lifecycle';
import {
  POSTGRES_TABLE_RELATION_DECORATOR,
  encodePostgresTableRelationDescriptor,
  type PostgresTableRelationKind,
} from '../src/postgres/table-relation';
import {
  POSTGRES_FOREIGN_KEY_SYNTHESIZER,
  refreshPostgresForeignKeyEdgesSync,
} from '../src/resolution/postgres-foreign-key-synthesizer';
import {
  POSTGRES_STRUCTURE_SYNTHESIZER,
  refreshPostgresStructureEdgesSync,
} from '../src/resolution/postgres-structure-synthesizer';
import type { Edge, Node, NodeKind } from '../src/types';

function makeNode(
  id: string,
  qualifiedName: string,
  filePath: string,
  line: number,
  kind: NodeKind,
  decorators: string[],
  column = 0
): Node {
  return {
    id,
    kind,
    name: qualifiedName.split('.').at(-1) ?? qualifiedName,
    qualifiedName,
    filePath,
    language: 'postgres',
    startLine: line,
    endLine: line,
    startColumn: column,
    endColumn: column,
    decorators,
    updatedAt: Date.now(),
  };
}

function table(id: string, name: string, filePath: string, line = 1): Node {
  return makeNode(id, name, filePath, line, 'struct', ['postgres:table']);
}

describe('PostgreSQL ordered migration synthesis', () => {
  let dir: string;
  let db: DatabaseConnection;
  let queries: QueryBuilder;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-postgres-migrations-'));
    db = DatabaseConnection.initialize(path.join(dir, 'codegraph.db'));
    queries = new QueryBuilder(db.getDb());
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function insertReference(fact: Node, target: Node, refName: string): void {
    queries.insertEdge({
      source: fact.id,
      target: target.id,
      kind: 'references',
      line: fact.startLine,
      column: fact.startColumn,
      provenance: 'tree-sitter',
      metadata: { refName },
    });
  }

  function insertRelationFact(
    id: string,
    relation: PostgresTableRelationKind,
    source: string,
    target: string,
    filePath: string,
    line: number,
    endpoints: Array<[Node, string]>,
    column = 0
  ): Node {
    const fact = makeNode(id, id, filePath, line, 'constant', [
      POSTGRES_TABLE_RELATION_DECORATOR,
      encodePostgresTableRelationDescriptor({
        relation,
        sourceTable: source,
        targetTable: target,
      }),
    ], column);
    queries.insertNode(fact);
    for (const [endpoint, refName] of endpoints) insertReference(fact, endpoint, refName);
    return fact;
  }

  function insertForeignKeyFact(
    id: string,
    source: Node,
    target: Node,
    sourceName: string,
    targetName: string,
    constraintName: string,
    filePath: string,
    line: number
  ): Node {
    const fact = makeNode(id, id, filePath, line, 'constant', [
      POSTGRES_FOREIGN_KEY_DECORATOR,
      encodePostgresForeignKeyDescriptor({
        sourceTable: sourceName,
        targetTable: targetName,
        constraintName,
        sourceColumns: ['target_id'],
        targetColumns: ['id'],
      }),
    ]);
    queries.insertNode(fact);
    insertReference(fact, source, sourceName);
    insertReference(fact, target, targetName);
    return fact;
  }

  function insertConstraintRename(
    id: string,
    tableName: string,
    sourceConstraint: string,
    targetConstraint: string,
    filePath: string,
    line: number
  ): Node {
    const fact = makeNode(id, id, filePath, line, 'constant', [
      POSTGRES_RENAME_CONSTRAINT_DECORATOR,
      encodePostgresRenameConstraintDescriptor({
        table: tableName,
        sourceConstraint,
        targetConstraint,
      }),
    ]);
    queries.insertNode(fact);
    return fact;
  }

  function synthesizedEdges(source: Node, synthesizer: string): Edge[] {
    return queries.getOutgoingEdges(source.id).filter(
      (edge) => edge.metadata?.synthesizedBy === synthesizer
    );
  }

  it('retains immediate rename edges and projects only older structural facts to the final alias', () => {
    const oldTable = table('table:old', 'public.submission_tags', '000_schema.sql');
    const middleTable = table('table:middle', 'public.tags', '002_rename.sql');
    const finalTable = table('table:final', 'public.labels', '003_rename.sql');
    const before = table('table:before', 'public.before_relation', '001_relations.sql');
    const after = table('table:after', 'public.after_relation', '004_relations.sql');
    for (const node of [oldTable, middleTable, finalTable, before, after]) {
      queries.insertNode(node);
    }

    insertRelationFact(
      'fact:before', 'like', before.qualifiedName, oldTable.qualifiedName,
      '001_relations.sql', 10,
      [[before, before.qualifiedName], [oldTable, oldTable.qualifiedName]]
    );
    // Deliberately resolve only the old endpoint. The target aliases must come
    // from the unique exact qualified-name index, not a fuzzy name lookup.
    insertRelationFact(
      'fact:rename-middle', 'rename', oldTable.qualifiedName, middleTable.qualifiedName,
      '002_rename.sql', 1, [[oldTable, oldTable.qualifiedName]]
    );
    insertRelationFact(
      'fact:rename-final', 'rename', middleTable.qualifiedName, finalTable.qualifiedName,
      '003_rename.sql', 1, [[middleTable, middleTable.qualifiedName]]
    );
    insertRelationFact(
      'fact:after', 'inherits', after.qualifiedName, oldTable.qualifiedName,
      '004_relations.sql', 1,
      [[after, after.qualifiedName], [oldTable, oldTable.qualifiedName]]
    );

    refreshPostgresStructureEdgesSync(queries);

    expect(synthesizedEdges(oldTable, POSTGRES_STRUCTURE_SYNTHESIZER)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: middleTable.id,
          metadata: expect.objectContaining({ postgresRelation: 'rename' }),
        }),
      ])
    );
    expect(synthesizedEdges(middleTable, POSTGRES_STRUCTURE_SYNTHESIZER)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: finalTable.id,
          metadata: expect.objectContaining({ postgresRelation: 'rename' }),
        }),
      ])
    );
    expect(synthesizedEdges(before, POSTGRES_STRUCTURE_SYNTHESIZER)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: finalTable.id,
          metadata: expect.objectContaining({ postgresRelation: 'like' }),
        }),
      ])
    );
    // Earlier rename events are not applied retroactively to later facts.
    expect(synthesizedEdges(after, POSTGRES_STRUCTURE_SYNTHESIZER)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: oldTable.id,
          metadata: expect.objectContaining({ postgresRelation: 'inherits' }),
        }),
      ])
    );
  });

  it('does not guess a rename target when the exact qualified name is ambiguous', () => {
    const oldTable = table('table:old', 'public.old_name', '001_schema.sql');
    const aliasOne = table('table:new-1', 'public.new_name', '002_rename.sql');
    const aliasTwo = table('table:new-2', 'public.new_name', '009_duplicate.sql');
    for (const node of [oldTable, aliasOne, aliasTwo]) queries.insertNode(node);
    insertRelationFact(
      'fact:rename', 'rename', oldTable.qualifiedName, aliasOne.qualifiedName,
      '002_rename.sql', 1, [[oldTable, oldTable.qualifiedName]]
    );

    refreshPostgresStructureEdgesSync(queries);
    expect(synthesizedEdges(oldTable, POSTGRES_STRUCTURE_SYNTHESIZER)).toEqual([]);
  });

  it('does not infer migration chronology across independent SQL directories', () => {
    const oldTable = table('table:old', 'public.old_name', 'schema/001_tables.sql');
    const alias = table('table:new', 'public.new_name', 'migrations/002_rename.sql');
    const dependent = table('table:dependent', 'public.dependent', 'schema/001_tables.sql');
    for (const node of [oldTable, alias, dependent]) queries.insertNode(node);
    insertRelationFact(
      'fact:before', 'like', dependent.qualifiedName, oldTable.qualifiedName,
      'schema/001_tables.sql', 2,
      [[dependent, dependent.qualifiedName], [oldTable, oldTable.qualifiedName]]
    );
    insertRelationFact(
      'fact:rename', 'rename', oldTable.qualifiedName, alias.qualifiedName,
      'migrations/002_rename.sql', 1,
      [[oldTable, oldTable.qualifiedName], [alias, alias.qualifiedName]]
    );

    refreshPostgresStructureEdgesSync(queries);
    expect(synthesizedEdges(dependent, POSTGRES_STRUCTURE_SYNTHESIZER)).toEqual([
      expect.objectContaining({
        target: oldTable.id,
        metadata: expect.objectContaining({ postgresRelation: 'like' }),
      }),
    ]);
  });

  it('reprojects FKs after renames and suppresses only facts preceding a named drop', () => {
    const oldOrders = table('table:orders', 'public.orders', '000_schema.sql');
    const newOrders = table('table:purchases', 'public.purchases', '002_renames.sql');
    const oldTags = table('table:tags-old', 'public.submission_tags', '000_schema.sql');
    const newTags = table('table:tags-new', 'public.tags', '002_renames.sql');
    for (const node of [oldOrders, newOrders, oldTags, newTags]) queries.insertNode(node);

    insertForeignKeyFact(
      'fk:keep', oldOrders, oldTags,
      oldOrders.qualifiedName, oldTags.qualifiedName,
      'orders_keep_fk', '001_constraints.sql', 1
    );
    insertForeignKeyFact(
      'fk:drop-old', oldOrders, oldTags,
      oldOrders.qualifiedName, oldTags.qualifiedName,
      'orders_drop_fk', '001_constraints.sql', 2
    );

    refreshPostgresForeignKeyEdgesSync(queries);
    expect(synthesizedEdges(oldOrders, POSTGRES_FOREIGN_KEY_SYNTHESIZER)).toHaveLength(1);

    insertRelationFact(
      'rename:orders', 'rename', oldOrders.qualifiedName, newOrders.qualifiedName,
      '002_renames.sql', 1, [[oldOrders, oldOrders.qualifiedName]]
    );
    insertRelationFact(
      'rename:tags', 'rename', oldTags.qualifiedName, newTags.qualifiedName,
      '002_renames.sql', 2, [[oldTags, oldTags.qualifiedName]]
    );
    insertConstraintRename(
      'rename:keep-fk', newOrders.qualifiedName,
      'orders_keep_fk', 'purchases_keep_fk', '002a_constraint_renames.sql', 1
    );
    insertConstraintRename(
      'rename:drop-fk', newOrders.qualifiedName,
      'orders_drop_fk', 'purchases_drop_fk', '002a_constraint_renames.sql', 2
    );

    refreshPostgresForeignKeyEdgesSync(queries);
    expect(synthesizedEdges(oldOrders, POSTGRES_FOREIGN_KEY_SYNTHESIZER)).toEqual([]);
    let projected = synthesizedEdges(newOrders, POSTGRES_FOREIGN_KEY_SYNTHESIZER);
    expect(projected).toEqual([
      expect.objectContaining({ target: newTags.id }),
    ]);
    expect((projected[0]!.metadata?.constraints as Array<{ constraintName: string }>))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          constraintName: 'purchases_keep_fk',
          originalConstraintName: 'orders_keep_fk',
        }),
        expect.objectContaining({
          constraintName: 'purchases_drop_fk',
          originalConstraintName: 'orders_drop_fk',
        }),
      ]));

    const drop = makeNode('drop:orders-fk', 'drop:orders-fk', '003_drop.sql', 1, 'constant', [
      POSTGRES_DROP_CONSTRAINT_DECORATOR,
      encodePostgresDropConstraintDescriptor({
        table: newOrders.qualifiedName,
        constraintName: 'purchases_drop_fk',
      }),
    ]);
    queries.insertNode(drop);
    refreshPostgresForeignKeyEdgesSync(queries);
    projected = synthesizedEdges(newOrders, POSTGRES_FOREIGN_KEY_SYNTHESIZER);
    expect((projected[0]!.metadata?.constraints as Array<{ constraintName: string }>))
      .toEqual([expect.objectContaining({ constraintName: 'purchases_keep_fk' })]);

    // Re-adding the same named constraint after the drop is a new live fact.
    insertForeignKeyFact(
      'fk:drop-readded', newOrders, newTags,
      newOrders.qualifiedName, newTags.qualifiedName,
      'purchases_drop_fk', '004_readd.sql', 1
    );
    refreshPostgresForeignKeyEdgesSync(queries);
    projected = synthesizedEdges(newOrders, POSTGRES_FOREIGN_KEY_SYNTHESIZER);
    expect((projected[0]!.metadata?.constraints as Array<{ constraintName: string }>))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ constraintName: 'purchases_keep_fk' }),
        expect.objectContaining({ constraintName: 'purchases_drop_fk', filePath: '004_readd.sql' }),
      ]));
    expect((projected[0]!.metadata?.constraints as Array<{ filePath: string }>).some(
      (constraint) => constraint.filePath === '001_constraints.sql' &&
        (constraint as { constraintName?: string }).constraintName === 'purchases_drop_fk'
    )).toBe(false);
  });

  it('suppresses an old table FK after DROP but keeps a constraint added after recreation', () => {
    const users = table('table:users', 'public.users', '000_schema.sql');
    const oldOrders = table('table:orders:v1', 'public.orders', '000_schema.sql');
    queries.insertNode(users);
    queries.insertNode(oldOrders);
    insertForeignKeyFact(
      'fk:orders:v1', oldOrders, users,
      oldOrders.qualifiedName, users.qualifiedName,
      'orders_user_fk', '001_constraints.sql', 1
    );

    const drop = makeNode('drop:orders', 'drop:orders', '002_drop.sql', 1, 'constant', [
      POSTGRES_DROP_RELATION_DECORATOR,
      encodePostgresDropRelationDescriptor({
        relationName: oldOrders.qualifiedName,
        relationKind: 'table',
      }),
    ]);
    queries.insertNode(drop);
    refreshPostgresForeignKeyEdgesSync(queries);
    expect(synthesizedEdges(oldOrders, POSTGRES_FOREIGN_KEY_SYNTHESIZER)).toEqual([]);

    const newOrders = table('table:orders:v2', 'public.orders', '003_recreate.sql');
    queries.insertNode(newOrders);
    insertForeignKeyFact(
      'fk:orders:v2', newOrders, users,
      newOrders.qualifiedName, users.qualifiedName,
      'orders_owner_fk', '004_constraints.sql', 1
    );
    refreshPostgresForeignKeyEdgesSync(queries);
    expect(synthesizedEdges(oldOrders, POSTGRES_FOREIGN_KEY_SYNTHESIZER)).toEqual([]);
    expect(synthesizedEdges(newOrders, POSTGRES_FOREIGN_KEY_SYNTHESIZER)).toEqual([
      expect.objectContaining({ target: users.id }),
    ]);
  });

  it('adds exact enum-member containment without duplicating native edges', () => {
    const enumNode = makeNode(
      'enum:status', 'public.status', '001_schema.sql', 1, 'enum', ['postgres:enum']
    );
    const nativeMember = makeNode(
      'enum:status:open', 'public.status.open', '001_schema.sql', 1,
      'enum_member', ['postgres:enum-value']
    );
    const alteredMember = makeNode(
      'enum:status:closed', 'public.status.closed', '002_alter.sql', 1,
      'enum_member', ['postgres:enum-value']
    );
    for (const node of [enumNode, nativeMember, alteredMember]) queries.insertNode(node);
    queries.insertEdge({
      source: enumNode.id,
      target: nativeMember.id,
      kind: 'contains',
      line: 1,
      column: 0,
      provenance: 'tree-sitter',
    });

    refreshPostgresStructureEdgesSync(queries);
    let contained = queries.getOutgoingEdges(enumNode.id, ['contains']);
    expect(contained.filter((edge) => edge.target === nativeMember.id)).toHaveLength(1);
    expect(contained.filter((edge) => edge.target === alteredMember.id)).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          synthesizedBy: POSTGRES_STRUCTURE_SYNTHESIZER,
          postgresRelation: 'enum-containment',
        }),
      }),
    ]);

    const recreatedEnum = makeNode(
      'enum:status:v2', 'public.status', '003_recreate.sql', 1,
      'enum', ['postgres:enum']
    );
    const laterMember = makeNode(
      'enum:status:archived', 'public.status.archived', '004_alter.sql', 1,
      'enum_member', ['postgres:enum-value']
    );
    queries.insertNode(recreatedEnum);
    queries.insertNode(laterMember);
    refreshPostgresStructureEdgesSync(queries);
    contained = queries.getOutgoingEdges(enumNode.id, ['contains']);
    expect(contained.some((edge) => edge.target === alteredMember.id)).toBe(true);
    expect(contained.some((edge) => edge.target === laterMember.id)).toBe(false);
    expect(queries.getOutgoingEdges(recreatedEnum.id, ['contains']).some(
      (edge) => edge.target === laterMember.id
    )).toBe(true);
  });
});
