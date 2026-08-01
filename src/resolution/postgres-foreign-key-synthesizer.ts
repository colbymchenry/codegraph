import { createHash } from 'node:crypto';
import type { Edge, Node } from '../types';
import type { QueryBuilder } from '../db/queries';
import {
  POSTGRES_FOREIGN_KEY_DECORATOR,
  decodePostgresForeignKeyDescriptor,
  type PostgresForeignKeyDescriptor,
} from '../postgres/foreign-key';
import {
  POSTGRES_DROP_CONSTRAINT_DECORATOR,
  POSTGRES_RENAME_CONSTRAINT_DECORATOR,
  decodePostgresDropConstraintDescriptor,
  decodePostgresRenameConstraintDescriptor,
} from '../postgres/constraint-mutation';
import {
  POSTGRES_TABLE_RELATION_DECORATOR,
  decodePostgresTableRelationDescriptor,
} from '../postgres/table-relation';
import { POSTGRES_DROP_RELATION_DECORATOR } from '../postgres/relation-lifecycle';
import type { MaybeYield } from './cooperative-yield';
import { PostgresRelationLifecycle } from './postgres-relation-lifecycle';
import {
  PostgresTableRenameTimeline,
  comparePostgresMigrationPosition,
  isPostgresMigrationPositionLater,
  isPostgresTable,
  type PostgresMigrationPosition,
  type PostgresResolvedTableEndpoint,
} from './postgres-rename-timeline';

export const POSTGRES_FOREIGN_KEY_SYNTHESIZER = 'postgres-foreign-key';
export const POSTGRES_FOREIGN_KEY_FINGERPRINT_METADATA =
  'postgres_foreign_key_state_fingerprint';

interface ConstraintFact extends PostgresForeignKeyDescriptor {
  filePath: string;
  line: number;
  column: number;
  originalConstraintName?: string;
}

interface ForeignKeyGroup {
  source: Node;
  target: Node;
  constraints: ConstraintFact[];
  line: number;
}

interface DropConstraintEvent extends PostgresMigrationPosition {
  nodeId: string;
  table: string;
  constraintName: string;
}

interface RenameConstraintEvent extends PostgresMigrationPosition {
  nodeId: string;
  table: string;
  sourceConstraint: string;
  targetConstraint: string;
}

function collectDropConstraintEvents(queries: QueryBuilder): DropConstraintEvent[] {
  const events: DropConstraintEvent[] = [];
  for (const fact of queries.iterateNodesByLanguageWithDecorator(
    'postgres',
    POSTGRES_DROP_CONSTRAINT_DECORATOR
  )) {
    const descriptor = decodePostgresDropConstraintDescriptor(fact.decorators);
    if (!descriptor) continue;
    events.push({
      ...descriptor,
      nodeId: fact.id,
      filePath: fact.filePath,
      line: fact.startLine,
      column: fact.startColumn,
    });
  }
  return events.sort((left, right) =>
    comparePostgresMigrationPosition(left, right) ||
      (left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0)
  );
}

function collectRenameConstraintEvents(queries: QueryBuilder): RenameConstraintEvent[] {
  const events: RenameConstraintEvent[] = [];
  for (const fact of queries.iterateNodesByLanguageWithDecorator(
    'postgres',
    POSTGRES_RENAME_CONSTRAINT_DECORATOR
  )) {
    const descriptor = decodePostgresRenameConstraintDescriptor(fact.decorators);
    if (!descriptor) continue;
    events.push({
      ...descriptor,
      nodeId: fact.id,
      filePath: fact.filePath,
      line: fact.startLine,
      column: fact.startColumn,
    });
  }
  return events.sort((left, right) =>
    comparePostgresMigrationPosition(left, right) ||
      (left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0)
  );
}

function canonicalConstraintName(
  constraintName: string,
  table: string,
  position: PostgresMigrationPosition,
  renames: PostgresTableRenameTimeline,
  constraintRenames: readonly RenameConstraintEvent[],
  through?: PostgresMigrationPosition
): string {
  const finalTable = renames.canonicalName(table, position);
  let current = constraintName;
  for (const event of constraintRenames) {
    if (!isPostgresMigrationPositionLater(event, position)) continue;
    if (through && isPostgresMigrationPositionLater(event, through)) continue;
    if (renames.canonicalName(event.table, event) !== finalTable) continue;
    if (event.sourceConstraint === current) current = event.targetConstraint;
  }
  return current;
}

function isSuppressedByLaterDrop(
  descriptor: PostgresForeignKeyDescriptor,
  position: PostgresMigrationPosition,
  drops: readonly DropConstraintEvent[],
  renames: PostgresTableRenameTimeline,
  constraintRenames: readonly RenameConstraintEvent[]
): boolean {
  if (!descriptor.constraintName) return false;
  const finalSourceTable = renames.canonicalName(descriptor.sourceTable, position);
  return drops.some((drop) =>
    isPostgresMigrationPositionLater(drop, position) &&
    renames.canonicalName(drop.table, drop) === finalSourceTable &&
    drop.constraintName === canonicalConstraintName(
      descriptor.constraintName!,
      descriptor.sourceTable,
      position,
      renames,
      constraintRenames,
      drop
    )
  );
}

/**
 * Convert resolved constraint endpoints into the relationship users expect to
 * traverse: source table -> referenced table. Several constraints between the
 * same pair are aggregated on one edge rather than multiplying graph paths.
 */
function collectForeignKey(
  grouped: Map<string, ForeignKeyGroup>,
  queries: QueryBuilder,
  foreignKey: Node,
  renames: PostgresTableRenameTimeline,
  lifecycle: PostgresRelationLifecycle,
  drops: readonly DropConstraintEvent[],
  constraintRenames: readonly RenameConstraintEvent[]
): void {
  if (!foreignKey.decorators?.includes(POSTGRES_FOREIGN_KEY_DECORATOR)) return;
  const descriptor = decodePostgresForeignKeyDescriptor(foreignKey.decorators);
  if (!descriptor) return;

  const position: PostgresMigrationPosition = {
    filePath: foreignKey.filePath,
    line: foreignKey.startLine,
    column: foreignKey.startColumn,
  };
  if (
    lifecycle.isDroppedAfter(descriptor.sourceTable, position) ||
    lifecycle.isDroppedAfter(descriptor.targetTable, position)
  ) return;
  if (isSuppressedByLaterDrop(
    descriptor,
    position,
    drops,
    renames,
    constraintRenames
  )) return;

  const endpoints = queries
    .getOutgoingEdges(foreignKey.id, ['references'])
    .map((edge) => ({
      node: queries.getNodeById(edge.target),
      refName: typeof edge.metadata?.refName === 'string' ? edge.metadata.refName : undefined,
    }))
    .filter((endpoint): endpoint is PostgresResolvedTableEndpoint =>
      isPostgresTable(endpoint.node)
    );
  const source = lifecycle.canonicalTableEndpoint(endpoints, descriptor.sourceTable, position);
  const target = lifecycle.canonicalTableEndpoint(endpoints, descriptor.targetTable, position);
  if (!source || !target) return;

  const key = `${source.id}\u0000${target.id}`;
  const finalConstraintName = descriptor.constraintName
    ? canonicalConstraintName(
      descriptor.constraintName,
      descriptor.sourceTable,
      position,
      renames,
      constraintRenames
    )
    : undefined;
  const fact: ConstraintFact = {
    ...descriptor,
    ...(finalConstraintName ? { constraintName: finalConstraintName } : {}),
    ...(descriptor.constraintName && finalConstraintName !== descriptor.constraintName
      ? { originalConstraintName: descriptor.constraintName }
      : {}),
    filePath: foreignKey.filePath,
    line: foreignKey.startLine,
    column: foreignKey.startColumn,
  };
  const existing = grouped.get(key);
  if (existing) {
    existing.constraints.push(fact);
    existing.line = Math.min(existing.line, foreignKey.startLine);
  } else {
    grouped.set(key, {
      source,
      target,
      constraints: [fact],
      line: foreignKey.startLine,
    });
  }
}

function materializeForeignKeyEdges(grouped: Map<string, ForeignKeyGroup>): Edge[] {
  return [...grouped.values()].map(({ source, target, constraints, line }) => ({
    source: source.id,
    target: target.id,
    kind: 'references',
    line,
    provenance: 'tree-sitter',
    metadata: {
      synthesizedBy: POSTGRES_FOREIGN_KEY_SYNTHESIZER,
      postgresRelation: 'foreign-key',
      constraints: constraints.sort((a, b) =>
        comparePostgresMigrationPosition(a, b)
      ),
    },
  }));
}

function postgresForeignKeyStateFingerprint(
  queries: QueryBuilder
): { fingerprint: string; factCount: number } {
  const hash = createHash('sha256');
  let factCount = 0;
  let previousNodeId: string | null = null;
  for (const row of queries.iterateDecoratorReferenceState(
    'postgres',
    POSTGRES_FOREIGN_KEY_DECORATOR
  )) {
    if (row.nodeId !== previousNodeId) {
      factCount++;
      previousNodeId = row.nodeId;
    }
    hash.update(JSON.stringify([
      row.nodeId,
      row.decorators,
      row.targetId,
      row.edgeMetadata,
      row.targetQualifiedName,
      row.targetKind,
      row.targetLanguage,
      row.targetDecorators,
    ]));
    hash.update('\n');
  }
  // Rename facts and their exact alias candidates affect the projected FK
  // endpoints even though neither is itself an FK fact.
  for (const row of queries.iterateDecoratorReferenceState(
    'postgres',
    POSTGRES_TABLE_RELATION_DECORATOR
  )) {
    let descriptor = null;
    try {
      descriptor = decodePostgresTableRelationDescriptor(JSON.parse(row.decorators));
    } catch {
      // Malformed decorators are ignored by materialization too.
    }
    if (descriptor?.relation !== 'rename') continue;
    hash.update(JSON.stringify(['rename', row]));
    hash.update('\n');
  }
  for (const row of queries.iterateDecoratorReferenceState(
    'postgres',
    POSTGRES_DROP_CONSTRAINT_DECORATOR
  )) {
    hash.update(JSON.stringify(['drop-constraint', row]));
    hash.update('\n');
  }
  for (const row of queries.iterateDecoratorReferenceState(
    'postgres',
    POSTGRES_RENAME_CONSTRAINT_DECORATOR
  )) {
    hash.update(JSON.stringify(['rename-constraint', row]));
    hash.update('\n');
  }
  for (const row of queries.iterateDecoratorReferenceState(
    'postgres',
    POSTGRES_DROP_RELATION_DECORATOR
  )) {
    hash.update(JSON.stringify(['drop-relation', row]));
    hash.update('\n');
  }
  for (const node of queries.iterateNodesByLanguage('postgres')) {
    if (!isPostgresTable(node)) continue;
    hash.update(JSON.stringify([
      'table', node.id, node.qualifiedName, node.filePath, node.startLine,
      node.startColumn, node.decorators,
    ]));
    hash.update('\n');
  }
  return { fingerprint: `v3:${hash.digest('hex')}`, factCount };
}

function postgresForeignKeyOutputFingerprint(
  queries: QueryBuilder
): { fingerprint: string; edgeCount: number } {
  const hash = createHash('sha256');
  let edgeCount = 0;
  for (const edge of queries.iterateEdgesBySynthesizer(POSTGRES_FOREIGN_KEY_SYNTHESIZER)) {
    edgeCount++;
    hash.update(JSON.stringify([
      edge.source,
      edge.target,
      edge.kind,
      edge.metadata,
      edge.line,
      edge.col,
      edge.provenance,
    ]));
    hash.update('\n');
  }
  return { fingerprint: `v1:${hash.digest('hex')}`, edgeCount };
}

function persistedFingerprint(input: string, output: string): string {
  return `input=${input};output=${output}`;
}

function persistCurrentFingerprint(
  queries: QueryBuilder,
  input: { fingerprint: string; factCount: number }
): void {
  const output = postgresForeignKeyOutputFingerprint(queries);
  if (input.factCount === 0 && output.edgeCount === 0) {
    queries.deleteMetadata(POSTGRES_FOREIGN_KEY_FINGERPRINT_METADATA);
  } else {
    queries.setMetadata(
      POSTGRES_FOREIGN_KEY_FINGERPRINT_METADATA,
      persistedFingerprint(input.fingerprint, output.fingerprint)
    );
  }
}

export function postgresForeignKeyEdgesSync(queries: QueryBuilder): Edge[] {
  const grouped = new Map<string, ForeignKeyGroup>();
  const renames = new PostgresTableRenameTimeline(queries);
  const lifecycle = new PostgresRelationLifecycle(queries, renames);
  const drops = collectDropConstraintEvents(queries);
  const constraintRenames = collectRenameConstraintEvents(queries);
  for (const foreignKey of queries.iterateNodesByLanguageWithDecorator(
    'postgres',
    POSTGRES_FOREIGN_KEY_DECORATOR
  )) {
    collectForeignKey(
      grouped, queries, foreignKey, renames, lifecycle, drops, constraintRenames
    );
  }
  return materializeForeignKeyEdges(grouped);
}

export async function postgresForeignKeyEdges(
  queries: QueryBuilder,
  onYield: MaybeYield
): Promise<Edge[]> {
  const grouped = new Map<string, ForeignKeyGroup>();
  const renames = new PostgresTableRenameTimeline(queries);
  const lifecycle = new PostgresRelationLifecycle(queries, renames);
  const drops = collectDropConstraintEvents(queries);
  const constraintRenames = collectRenameConstraintEvents(queries);
  let scanned = 0;
  for (const foreignKey of queries.iterateNodesByLanguageWithDecorator(
    'postgres',
    POSTGRES_FOREIGN_KEY_DECORATOR
  )) {
    if ((++scanned & 127) === 0) await onYield();
    collectForeignKey(
      grouped, queries, foreignKey, renames, lifecycle, drops, constraintRenames
    );
  }

  return materializeForeignKeyEdges(grouped);
}

/** Atomically refresh the owned edge set after facts are resolved. */
export async function refreshPostgresForeignKeyEdges(
  queries: QueryBuilder,
  onYield: MaybeYield
): Promise<number> {
  const state = postgresForeignKeyStateFingerprint(queries);
  const output = postgresForeignKeyOutputFingerprint(queries);
  const previous = queries.getMetadata(POSTGRES_FOREIGN_KEY_FINGERPRINT_METADATA);
  if (state.factCount === 0 && output.edgeCount === 0 && previous === null) return 0;
  if (previous === persistedFingerprint(state.fingerprint, output.fingerprint)) return 0;

  // Compute first so a parser/query failure leaves the last complete edge set.
  const edges = await postgresForeignKeyEdges(queries, onYield);
  queries.replaceEdgesBySynthesizer(POSTGRES_FOREIGN_KEY_SYNTHESIZER, edges);
  persistCurrentFingerprint(queries, state);
  await onYield();
  return edges.length;
}

/** Synchronous counterpart for the public synchronous resolution API. */
export function refreshPostgresForeignKeyEdgesSync(queries: QueryBuilder): number {
  const state = postgresForeignKeyStateFingerprint(queries);
  const output = postgresForeignKeyOutputFingerprint(queries);
  const previous = queries.getMetadata(POSTGRES_FOREIGN_KEY_FINGERPRINT_METADATA);
  if (state.factCount === 0 && output.edgeCount === 0 && previous === null) return 0;
  if (previous === persistedFingerprint(state.fingerprint, output.fingerprint)) return 0;

  const edges = postgresForeignKeyEdgesSync(queries);
  queries.replaceEdgesBySynthesizer(POSTGRES_FOREIGN_KEY_SYNTHESIZER, edges);
  persistCurrentFingerprint(queries, state);
  return edges.length;
}
