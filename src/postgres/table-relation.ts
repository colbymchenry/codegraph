/** Shared encoding for PostgreSQL structural table-relation facts. */

export const POSTGRES_TABLE_RELATION_DECORATOR = 'postgres:table-relation';
export const POSTGRES_TABLE_RELATION_DATA_PREFIX = 'postgres:table-relation-data:';

export type PostgresTableRelationKind =
  | 'rename'
  | 'partition-of'
  | 'inherits'
  | 'like'
  | 'attach-partition'
  | 'detach-partition'
  | 'inherit'
  | 'no-inherit'
  | 'constraint-trigger';

export interface PostgresTableRelationDescriptor {
  relation: PostgresTableRelationKind;
  sourceTable: string;
  targetTable: string;
  mode?: 'concurrently' | 'finalize';
  triggerName?: string;
}

export function encodePostgresTableRelationDescriptor(
  descriptor: PostgresTableRelationDescriptor
): string {
  return `${POSTGRES_TABLE_RELATION_DATA_PREFIX}${JSON.stringify(descriptor)}`;
}

export function decodePostgresTableRelationDescriptor(
  decorators: readonly string[] | undefined
): PostgresTableRelationDescriptor | null {
  const encoded = decorators?.find((decorator) =>
    decorator.startsWith(POSTGRES_TABLE_RELATION_DATA_PREFIX)
  );
  if (!encoded) return null;
  try {
    const value = JSON.parse(encoded.slice(POSTGRES_TABLE_RELATION_DATA_PREFIX.length)) as
      Partial<PostgresTableRelationDescriptor>;
    if (
      typeof value.relation !== 'string' ||
      typeof value.sourceTable !== 'string' ||
      typeof value.targetTable !== 'string'
    ) return null;
    return value as PostgresTableRelationDescriptor;
  } catch {
    return null;
  }
}
