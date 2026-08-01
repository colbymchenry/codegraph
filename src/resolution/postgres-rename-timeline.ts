import type { QueryBuilder } from '../db/queries';
import type { Node } from '../types';
import { isPostgresQualifiedName, parsePostgresQualifiedName } from '../postgres/identifiers';
import {
  POSTGRES_TABLE_RELATION_DECORATOR,
  decodePostgresTableRelationDescriptor,
} from '../postgres/table-relation';

export interface PostgresMigrationPosition {
  filePath: string;
  line: number;
  column: number;
}

export interface PostgresResolvedTableEndpoint {
  node: Node;
  refName: string | undefined;
}

export interface PostgresTableRenameEvent extends PostgresMigrationPosition {
  nodeId: string;
  sourceTable: string;
  targetTable: string;
}

/**
 * CodeGraph has no database-migration executor, so file ordering is the only
 * deterministic chronology available to the synthesizers. PostgreSQL facts
 * are ordered by path, then their source position within that file.
 */
export function comparePostgresMigrationPosition(
  left: PostgresMigrationPosition,
  right: PostgresMigrationPosition
): number {
  const pathOrder = left.filePath < right.filePath ? -1 : left.filePath > right.filePath ? 1 : 0;
  return pathOrder ||
    left.line - right.line ||
    left.column - right.column;
}

function postgresMigrationStream(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const separator = normalized.lastIndexOf('/');
  return separator < 0 ? '' : normalized.slice(0, separator);
}

export function isPostgresMigrationPositionLater(
  candidate: PostgresMigrationPosition,
  reference: PostgresMigrationPosition
): boolean {
  // Separate directories are separate deployment streams unless a future
  // project configuration explicitly says otherwise. Inferring chronology
  // across e.g. migrations/, fixtures/, snapshots/, and tests/ would silently
  // rewrite or suppress otherwise valid graph facts.
  if (postgresMigrationStream(candidate.filePath) !== postgresMigrationStream(reference.filePath)) {
    return false;
  }
  return comparePostgresMigrationPosition(candidate, reference) > 0;
}

export function isPostgresTable(node: Node | null): node is Node {
  return node?.language === 'postgres' && node.kind === 'struct' && (
    node.decorators?.includes('postgres:table') === true ||
    node.decorators?.includes('postgres:foreign-table') === true
  );
}

export function isPostgresRelation(node: Node | null): node is Node {
  return node?.language === 'postgres' && node.kind === 'struct' && (
    node.decorators?.includes('postgres:table') === true ||
    node.decorators?.includes('postgres:foreign-table') === true ||
    node.decorators?.includes('postgres:view') === true ||
    node.decorators?.includes('postgres:materialized-view') === true
  );
}

function endpointFromFact(
  endpoints: readonly PostgresResolvedTableEndpoint[],
  name: string
): Node | null {
  // refName preserves the role when both endpoint tables have the same simple
  // name in different schemas. Fall back to node identity for older edges that
  // predate refName metadata.
  let matches = endpoints
    .filter((endpoint) => endpoint.refName === name)
    .map((endpoint) => endpoint.node);
  if (matches.length === 0) {
    const qualified = isPostgresQualifiedName(name);
    const parsed = parsePostgresQualifiedName(name);
    const simple = parsed?.[parsed.length - 1] ?? name;
    matches = endpoints
      .map((endpoint) => endpoint.node)
      .filter((node) => qualified ? node.qualifiedName === name : node.name === simple);
  }
  const unique = new Map(matches.map((node) => [node.id, node]));
  return unique.size === 1 ? unique.values().next().value ?? null : null;
}

function nodePosition(node: Node): PostgresMigrationPosition {
  return {
    filePath: node.filePath,
    line: node.startLine,
    column: node.startColumn,
  };
}

/**
 * Pick the latest declaration before a migration fact, optionally bounded by a
 * lifecycle event such as DROP. Candidates in other migration directories are
 * deliberately ignored because their relative deployment order is unknown.
 */
export function latestPostgresMigrationNodeBefore(
  candidates: readonly Node[],
  position: PostgresMigrationPosition,
  after?: PostgresMigrationPosition
): Node | null {
  const preceding = candidates
    .filter((candidate) => {
      const candidatePosition = nodePosition(candidate);
      return isPostgresMigrationPositionLater(position, candidatePosition) &&
        (!after || isPostgresMigrationPositionLater(candidatePosition, after));
    })
    .sort((left, right) => comparePostgresMigrationPosition(
      nodePosition(right),
      nodePosition(left)
    ));
  const latest = preceding[0];
  if (!latest) return null;
  const latestPosition = nodePosition(latest);
  return preceding.filter((candidate) =>
    comparePostgresMigrationPosition(nodePosition(candidate), latestPosition) === 0
  ).length === 1
    ? latest
    : null;
}

/**
 * Ordered table rename facts plus safe exact-name lookup for their aliases.
 * A lookup is usable only when exactly one PostgreSQL table owns the complete
 * qualified name; the synthesizers never guess between migration versions.
 */
export class PostgresTableRenameTimeline {
  readonly events: readonly PostgresTableRenameEvent[];
  private readonly exactTableCache = new Map<string, Node | null>();
  private readonly exactRelationCache = new Map<string, Node | null>();

  constructor(private readonly queries: QueryBuilder) {
    const events: PostgresTableRenameEvent[] = [];
    for (const fact of queries.iterateNodesByLanguageWithDecorator(
      'postgres',
      POSTGRES_TABLE_RELATION_DECORATOR
    )) {
      const descriptor = decodePostgresTableRelationDescriptor(fact.decorators);
      if (descriptor?.relation !== 'rename') continue;
      events.push({
        nodeId: fact.id,
        sourceTable: descriptor.sourceTable,
        targetTable: descriptor.targetTable,
        filePath: fact.filePath,
        line: fact.startLine,
        column: fact.startColumn,
      });
    }
    events.sort((left, right) =>
      comparePostgresMigrationPosition(left, right) ||
      (left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0)
    );
    this.events = events;
  }

  /** Follow only rename statements later than the fact being projected. */
  canonicalName(name: string, factPosition: PostgresMigrationPosition): string {
    let current = name;
    for (const event of this.events) {
      if (!isPostgresMigrationPositionLater(event, factPosition)) continue;
      if (event.sourceTable === current) current = event.targetTable;
    }
    return current;
  }

  /** Resolve a rename's immediate old/new endpoints; do not collapse its edge. */
  immediateEndpoint(
    endpoints: readonly PostgresResolvedTableEndpoint[],
    name: string
  ): Node | null {
    return endpointFromFact(endpoints, name) ?? this.uniqueExactTable(name);
  }

  /** Resolve a table/view rename without allowing relation-like nodes into FK matching. */
  immediateRelationEndpoint(
    endpoints: readonly PostgresResolvedTableEndpoint[],
    name: string
  ): Node | null {
    return endpointFromFact(endpoints, name) ?? this.uniqueExactRelation(name);
  }

  /**
   * Resolve a normal fact endpoint, then project it through subsequent rename
   * statements. The exact global lookup is needed because a rename fact often
   * resolves only its old reference; the new alias node is nevertheless in the
   * graph. Ambiguous/missing aliases suppress the projection rather than
   * retaining a stale edge to a name the migration has replaced.
   */
  canonicalEndpoint(
    endpoints: readonly PostgresResolvedTableEndpoint[],
    name: string,
    factPosition: PostgresMigrationPosition
  ): Node | null {
    const original = endpointFromFact(endpoints, name);
    const canonicalName = this.canonicalName(name, factPosition);
    if (canonicalName === name) return original;
    return endpointFromFact(endpoints, canonicalName) ??
      this.uniqueExactTable(canonicalName);
  }

  /** Resolve the newest exact table declaration inside a lifecycle window. */
  latestExactTableBefore(
    qualifiedName: string,
    position: PostgresMigrationPosition,
    after?: PostgresMigrationPosition
  ): Node | null {
    return latestPostgresMigrationNodeBefore(
      this.queries
        .getNodesByQualifiedNameExact(qualifiedName)
        .filter((node) => isPostgresTable(node)),
      position,
      after
    );
  }

  /** Resolve the newest exact table/view declaration inside a lifecycle window. */
  latestExactRelationBefore(
    qualifiedName: string,
    position: PostgresMigrationPosition,
    after?: PostgresMigrationPosition
  ): Node | null {
    return latestPostgresMigrationNodeBefore(
      this.queries
        .getNodesByQualifiedNameExact(qualifiedName)
        .filter((node) => isPostgresRelation(node)),
      position,
      after
    );
  }

  private uniqueExactTable(qualifiedName: string): Node | null {
    if (this.exactTableCache.has(qualifiedName)) {
      return this.exactTableCache.get(qualifiedName) ?? null;
    }
    const candidates = this.queries
      .getNodesByQualifiedNameExact(qualifiedName)
      .filter((node) => isPostgresTable(node));
    const table = candidates.length === 1 ? candidates[0]! : null;
    this.exactTableCache.set(qualifiedName, table);
    return table;
  }

  private uniqueExactRelation(qualifiedName: string): Node | null {
    if (this.exactRelationCache.has(qualifiedName)) {
      return this.exactRelationCache.get(qualifiedName) ?? null;
    }
    const candidates = this.queries
      .getNodesByQualifiedNameExact(qualifiedName)
      .filter((node) => isPostgresRelation(node));
    const relation = candidates.length === 1 ? candidates[0]! : null;
    this.exactRelationCache.set(qualifiedName, relation);
    return relation;
  }
}
