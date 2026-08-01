import type { QueryBuilder } from '../db/queries';
import {
  POSTGRES_DROP_RELATION_DECORATOR,
  decodePostgresDropRelationDescriptor,
  type PostgresDroppedRelationKind,
} from '../postgres/relation-lifecycle';
import {
  PostgresTableRenameTimeline,
  comparePostgresMigrationPosition,
  isPostgresMigrationPositionLater,
  type PostgresMigrationPosition,
  type PostgresResolvedTableEndpoint,
} from './postgres-rename-timeline';
import type { Node } from '../types';

export interface PostgresDropRelationEvent extends PostgresMigrationPosition {
  nodeId: string;
  relationName: string;
  relationKind: PostgresDroppedRelationKind;
}

/** Ordered DROP facts for deciding whether an older migration relation is live. */
export class PostgresRelationLifecycle {
  readonly drops: readonly PostgresDropRelationEvent[];

  constructor(
    queries: QueryBuilder,
    private readonly renames: PostgresTableRenameTimeline
  ) {
    const drops: PostgresDropRelationEvent[] = [];
    for (const fact of queries.iterateNodesByLanguageWithDecorator(
      'postgres',
      POSTGRES_DROP_RELATION_DECORATOR
    )) {
      const descriptor = decodePostgresDropRelationDescriptor(fact.decorators);
      if (!descriptor) continue;
      drops.push({
        ...descriptor,
        nodeId: fact.id,
        filePath: fact.filePath,
        line: fact.startLine,
        column: fact.startColumn,
      });
    }
    drops.sort((left, right) =>
      comparePostgresMigrationPosition(left, right) ||
      (left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0)
    );
    this.drops = drops;
  }

  /** True when a later DROP invalidates a relation fact at this position. */
  isDroppedAfter(
    relationName: string,
    position: PostgresMigrationPosition,
    acceptedKinds: readonly PostgresDroppedRelationKind[] = ['table', 'foreign-table']
  ): boolean {
    const canonicalRelation = this.renames.canonicalName(relationName, position);
    return this.drops.some((drop) =>
      acceptedKinds.includes(drop.relationKind) &&
      isPostgresMigrationPositionLater(drop, position) &&
      this.renames.canonicalName(drop.relationName, drop) === canonicalRelation
    );
  }

  /**
   * Resolve a table endpoint at a migration position. When a name has been
   * dropped and recreated, the generic resolver sees duplicate qualified names
   * and leaves the fact unresolved; the DROP boundary makes the newest
   * declaration after it unambiguous.
   */
  canonicalTableEndpoint(
    endpoints: readonly PostgresResolvedTableEndpoint[],
    relationName: string,
    position: PostgresMigrationPosition
  ): Node | null {
    const canonicalRelation = this.renames.canonicalName(relationName, position);
    const resolved = this.renames.canonicalEndpoint(endpoints, relationName, position);
    if (canonicalRelation !== relationName) return resolved;

    let latestDrop: PostgresDropRelationEvent | null = null;
    for (const drop of this.drops) {
      if (drop.relationKind !== 'table' && drop.relationKind !== 'foreign-table') continue;
      if (!isPostgresMigrationPositionLater(position, drop)) continue;
      if (this.renames.canonicalName(drop.relationName, drop) !== canonicalRelation) continue;
      if (!latestDrop || comparePostgresMigrationPosition(drop, latestDrop) > 0) {
        latestDrop = drop;
      }
    }
    if (!latestDrop) return resolved;
    return this.renames.latestExactTableBefore(canonicalRelation, position, latestDrop);
  }

  /**
   * Resolve the source side of a relation rename at that statement's position.
   * A DROP followed by a same-named CREATE starts a new relation lifetime, so
   * an otherwise ambiguous old-name reference belongs to the newest exact
   * declaration after the DROP.
   */
  renameSourceEndpoint(
    endpoints: readonly PostgresResolvedTableEndpoint[],
    relationName: string,
    position: PostgresMigrationPosition
  ): Node | null {
    const resolved = this.renames.immediateRelationEndpoint(endpoints, relationName);
    let latestDrop: PostgresDropRelationEvent | null = null;
    for (const drop of this.drops) {
      if (!isPostgresMigrationPositionLater(position, drop)) continue;
      // Compare the name as it existed at the DROP. Projecting it through this
      // rename would turn the source into the target and hide the boundary.
      if (drop.relationName !== relationName) continue;
      if (!latestDrop || comparePostgresMigrationPosition(drop, latestDrop) > 0) {
        latestDrop = drop;
      }
    }
    if (!latestDrop) return resolved;
    return this.renames.latestExactRelationBefore(relationName, position, latestDrop);
  }
}
